import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTemporaryDirectories, registerTemporaryDirectory } from './support/agent-fixture.js';
import { reclaimTestResources, runCli } from './support/runtime-reclamation.js';

/**
 * `task retry` through the real CLI and the real Runtime (ADR-0036).
 *
 * The provider is a **protocol stub**: it proves the Runtime's own orchestration — the requeue, the
 * worktree hand-back, the re-creation of a reclaimed worktree from its surviving branch, the audit
 * record, the capacity gate, and every refusal — and it is
 * *not* evidence about a real Pi or Codex failure. That limitation is recorded in the report and in
 * `docs/tasks/README.md`.
 *
 * The stub fails a Task exactly once (`fail-once` in the specification) by ending its assistant turn
 * with `stopReason: 'error'`, which is how Pi itself reports a failed model turn; the Runtime then
 * projects `FAILED` for both the Execution and the Task, and retains the worktree.
 */

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => {
  await reclaimTestResources();
  cleanupTemporaryDirectories();
});

function temporaryDirectory(prefix: string): string {
  // macOS resolves /var to /private/var; the Runtime records canonical paths.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  // FOUNDATION-057: the shared runner refuses a non-temporary CODEESTRA_HOME and registers the home,
  // so a Runtime this invocation starts is stopped even when an assertion fails first.
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Retry Test',
      GIT_AUTHOR_EMAIL: 'retry@example.invalid', GIT_COMMITTER_NAME: 'Retry Test',
      GIT_COMMITTER_EMAIL: 'retry@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error('Timed out waiting for the expected state');
}

/**
 * A protocol stub, not a real provider. It writes the file its Task's specification names, records
 * every start in a log both inside the worktree and in `CODEESTRA_STUB_LOG`, and keeps reading stdin
 * so a Session that is not settled keeps its Execution holding its resource.
 *
 * `fail-once` fails the Task on its *first* attempt only: the second start of the same Task settles
 * normally, which is what lets one test prove that the retried Execution really ran.
 */
const stubSource = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
const taskId = basename(process.cwd());
const sessionFile = join(process.env.CODEESTRA_STUB_SESSION_DIR ?? process.cwd(),
  'retry-session-' + taskId + '.jsonl');
mkdirSync(dirname(sessionFile), { recursive: true });

let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line);
    if (record.type === 'get_state') {
      emit({ id: record.id, type: 'response', command: 'get_state', success: true, data: {
        sessionId: 'retry-session-' + taskId, sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      const message = String(record.message ?? '');
      const requested = /write:(\\S+)/.exec(message);
      const path = requested === null ? 'src/agent/' + taskId + '.ts' : requested[1];
      mkdirSync(join(process.cwd(), dirname(path)), { recursive: true });
      writeFileSync(join(process.cwd(), path), 'export const task = ' + JSON.stringify(taskId) + ';\\n');
      // A line per start inside the worktree itself: two lines prove both attempts ran in the *same*
      // worktree, which is what "the retry reuses the Task's own worktree" means. The file is named
      // per Task so two different Tasks never share a path — otherwise the analyzer would see a
      // proven SAME_FILE overlap between them and no capacity scenario could ever be reached.
      appendFileSync(join(process.cwd(), 'runs-' + taskId + '.log'), 'start ' + taskId + '\\n');
      const log = process.env.CODEESTRA_STUB_LOG;
      if (log !== undefined) appendFileSync(log, 'started ' + taskId + ' ' + path + '\\n');
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'retry-session-' + taskId, timestamp: '2026-09-15T09:00:00.000Z',
        cwd: process.cwd() }) + '\\n');
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      const previousStarts = log === undefined || !existsSync(log)
        ? 0 : readFileSync(log, 'utf8').split('\\n').filter((entry) => entry.includes(' ' + taskId + ' ')).length;
      if (message.includes('fail-once') && previousStarts <= 1) {
        // Pi reports a failed turn through the assistant message's stop reason, so this is the same
        // shape a real model failure produces.
        emit({ type: 'message_end', message: { role: 'assistant',
          content: [{ type: 'text', text: 'the stub was told to fail' }],
          stopReason: 'error', errorMessage: 'stub failure' } });
      } else {
        emit({ type: 'message_end', message: { role: 'assistant',
          content: [{ type: 'text', text: 'Wrote ' + path + '.' }], stopReason: 'stop' } });
      }
      // 'hold' keeps the turn open so the Session stays ACTIVE and keeps occupying its slot.
      if (!message.includes('hold')) emit({ type: 'agent_settled' });
    }
  }
}
`;

/** Minimal `codex app-server --stdio` stub: enough to start a turn and settle. */
const codexStubSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\\n');
  process.exit(0);
}
const reportPath = process.env.CODEESTRA_CODEX_CLI_STUB_REPORT;
const rollout = process.env.CODEESTRA_CODEX_CLI_STUB_ROLLOUT;
const sessionId = 'retry-codex-thread';
const received = { argv, prompts: [], turns: 0 };
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
const save = () => {
  if (reportPath === undefined) return;
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(received, null, 2));
};
save();

let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    const frame = JSON.parse(line);
    if (typeof frame.method !== 'string' || frame.id === undefined) continue;
    if (frame.method === 'initialize') {
      emit({ jsonrpc: '2.0', id: frame.id, result: { userAgent: 'stub', codexHome: '',
        platformFamily: 'unix', platformOs: 'linux' } });
    } else if (frame.method === 'thread/start') {
      mkdirSync(dirname(rollout), { recursive: true });
      writeFileSync(rollout, '{}\\n');
      save();
      emit({ jsonrpc: '2.0', id: frame.id, result: { thread: { id: sessionId, path: rollout } } });
    } else if (frame.method === 'turn/start') {
      received.prompts.push(frame.params.input[0].text);
      received.turns += 1;
      save();
      emit({ jsonrpc: '2.0', id: frame.id, result: { turn: { id: 'retry-turn-' + received.turns } } });
      emit({ method: 'turn/completed', params: { threadId: sessionId,
        turn: { id: 'retry-turn-' + received.turns, status: 'completed', error: null, items: [] } } });
    }
  }
}
`;

const impactMapping = {
  version: 1,
  importantDirectories: ['core'],
  modules: [{ id: 'core-module', paths: ['core/**'] }],
  globalResources: [],
};

interface Fixture {
  readonly environment: Record<string, string>;
  readonly repository: string;
  readonly home: string;
  readonly projectId: string;
  readonly stubLog: string;
  readonly codexReportPath: string;
}

async function fixture(options: { readonly tickMs?: string } = {}): Promise<Fixture> {
  const repository = temporaryDirectory('codeestra-retry-repo-');
  const home = temporaryDirectory('codeestra-retry-home-');
  const tools = temporaryDirectory('codeestra-retry-tools-');
  const assets = temporaryDirectory('codeestra-retry-assets-');
  const stubLog = join(tools, 'starts.log');
  const codexReportPath = join(tools, 'codex-report.json');
  writeFileSync(stubLog, '');
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, '.codeestra', 'impact.json'), `${JSON.stringify(impactMapping, null, 2)}\n`);
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  await git(repository, ['branch', 'dev']);
  // ADR-0056: every dev fact comes from a second clone of the same origin that sits on
  // `dev`; the project is trusted with it explicitly.

  const stubPath = join(tools, 'stub-pi.ts');
  const shimPath = join(tools, 'pi');
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);
  const codexStubPath = join(tools, 'stub-codex.ts');
  const codexShim = join(tools, 'codex');
  await Bun.write(codexStubPath, codexStubSource);
  await Bun.write(codexShim, `#!/bin/sh\nexec "${process.execPath}" "${codexStubPath}" "$@"\n`);
  chmodSync(codexShim, 0o755);

  const environment = {
    CODEESTRA_HOME: home,
    CODEESTRA_UI_DIST: assets,
    CODEESTRA_PI_EXECUTABLE: shimPath,
    CODEESTRA_CODEX_EXECUTABLE: codexShim,
    CODEESTRA_CODEX_CLI_STUB_REPORT: codexReportPath,
    CODEESTRA_CODEX_CLI_STUB_ROLLOUT: join(tools, 'rollout.jsonl'),
    CODEESTRA_STUB_LOG: stubLog,
    CODEESTRA_STUB_SESSION_DIR: home,
    // The recovery period is a convergence safety net; the tests that want a pass ask for one.
    CODEESTRA_SCHEDULE_TICK_MS: options.tickMs ?? '60000',
  };
  const opened = await cli(['open', repository, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  return { environment, repository, home: realpathSync(home),
    projectId: projects[0]?.id as string, stubLog, codexReportPath };
}

async function createTask(
  environment: Record<string, string>,
  projectId: string,
  specification: string,
): Promise<string> {
  const created = JSON.parse((await cli(['task', 'create', projectId, specification],
    environment)).stdout) as { readonly id: string };
  return created.id;
}

interface TaskStatus {
  readonly task: { readonly id: string; readonly state: string; readonly version: number;
    readonly archivedAt: number | null };
  readonly executions: readonly {
    readonly executionId: string; readonly attemptNumber: number; readonly state: string;
    readonly adapterId: string; readonly retryFromExecutionId: string | null;
    readonly session: { readonly state: string } | null;
  }[];
}

async function status(
  environment: Record<string, string>,
  projectId: string,
  taskId: string,
): Promise<TaskStatus> {
  return JSON.parse((await cli(['task', 'status', projectId, taskId], environment)).stdout) as TaskStatus;
}

async function submit(
  environment: Record<string, string>,
  projectId: string,
  taskId: string,
  version: number,
): Promise<void> {
  const submitted = await cli(['task', 'submit', projectId, taskId, String(version)], environment);
  expect(submitted.exitCode).toBe(0);
}

/** Creates, submits and returns the created Task's ID. */
async function startTask(
  environment: Record<string, string>,
  projectId: string,
  specification: string,
): Promise<string> {
  const taskId = await createTask(environment, projectId, specification);
  await submit(environment, projectId, taskId, 0);
  return taskId;
}

async function waitForState(
  environment: Record<string, string>,
  projectId: string,
  taskId: string,
  expected: string,
): Promise<TaskStatus> {
  let observed: TaskStatus | null = null;
  await waitFor(() => {
    const read = Bun.spawnSync({ cmd: [process.execPath, 'run', cliEntry, 'task', 'status', projectId,
      taskId], env: { ...process.env, ...environment } as Record<string, string>, stdout: 'pipe',
      stderr: 'ignore' });
    if (read.exitCode !== 0) return false;
    try {
      observed = JSON.parse(read.stdout.toString()) as TaskStatus;
    } catch { return false; }
    return observed.task.state === expected;
  });
  return observed as unknown as TaskStatus;
}

interface RetryView {
  readonly taskId: string;
  readonly state: string;
  readonly version: number;
  readonly retryId: string;
  readonly failedExecutionId: string;
  readonly failedAttemptNumber: number;
  readonly adapterId: string;
  readonly previousAdapterId: string | null;
  readonly adapterChanged: boolean;
  readonly adapterSource: string;
  readonly workspace: { readonly mode: string; readonly workspaceId: string | null;
    readonly evidence: string | null; readonly detail: string };
  readonly start: { readonly outcome: string; readonly executionId: string | null;
    readonly attemptNumber: number | null; readonly taskVersion: number | null;
    readonly wait: { readonly kind: string; readonly code: string } | null;
    readonly code: string | null; readonly detail: string };
}

async function retry(
  environment: Record<string, string>,
  projectId: string,
  taskId: string,
  version: number,
  flags: readonly string[] = [],
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return await cli(['task', 'retry', projectId, taskId, String(version), '--json', ...flags],
    environment);
}

describe('codeestra task retry', () => {
  test('retries a failed Task: a new Execution follows in the same worktree, audited', async () => {
    const value = await fixture();
    const taskId = await startTask(value.environment, value.projectId, 'Retry me (fail-once)');
    const failed = await waitForState(value.environment, value.projectId, taskId, 'FAILED');
    expect(failed.executions).toHaveLength(1);
    const firstExecution = failed.executions[0];
    expect(firstExecution?.state).toBe('FAILED');
    const worktree = join(value.home, 'worktrees', value.projectId, taskId);
    await waitFor(() => existsSync(join(worktree, `runs-${taskId}.log`)));
    // The first attempt left work in its worktree, and that work is what a retry must not throw away.
    expect(readFileSync(join(worktree, `runs-${taskId}.log`), 'utf8')).toBe(`start ${taskId}\n`);

    const retried = await retry(value.environment, value.projectId, taskId, failed.task.version);
    expect(retried.exitCode).toBe(0);
    const view = JSON.parse(retried.stdout) as RetryView;
    expect(view).toMatchObject({
      state: 'READY',
      failedExecutionId: firstExecution?.executionId,
      failedAttemptNumber: 1,
      adapterId: 'pi',
      previousAdapterId: 'pi',
      adapterChanged: false,
      adapterSource: 'RECORDED',
      workspace: { mode: 'REUSE_VERIFIED', workspaceId: expect.any(String) },
      start: { outcome: 'STARTED', attemptNumber: 2 },
    });
    expect(view.start.executionId).not.toBeNull();
    expect(view.workspace.detail).toContain('keeps its own worktree');

    // The new Execution is a fresh conversation that names the failure it follows — not a resume.
    const after = await status(value.environment, value.projectId, taskId);
    expect(after.executions).toHaveLength(2);
    expect(after.executions[0]).toMatchObject({
      attemptNumber: 2, adapterId: 'pi', retryFromExecutionId: firstExecution?.executionId,
    });
    expect(after.task.state).toBe('RUNNING');
    // Both attempts ran in the *same* worktree: two start lines, one file.
    await waitFor(() => readFileSync(join(worktree, `runs-${taskId}.log`), 'utf8').split('\n')
      .filter((line) => line.length > 0).length === 2);
    expect(readFileSync(join(worktree, `runs-${taskId}.log`), 'utf8')).toBe(
      `start ${taskId}\nstart ${taskId}\n`);

    // The audit answers who retried which failure, on which Agent, with which workspace decision.
    const events = JSON.parse((await cli(['events', 'list', '--project', value.projectId,
      '--limit', '200'], value.environment)).stdout) as {
      readonly events: readonly { readonly eventType: string; readonly payload: Record<string, unknown> }[];
    };
    const audit = events.events.filter((event) => event.eventType === 'TaskRetryRequested');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.payload).toMatchObject({
      taskId, from: 'FAILED', to: 'READY', failedAttemptNumber: 1,
      adapterId: 'pi', previousAdapterId: 'pi', adapterChanged: false,
      workspaceMode: 'REUSE_VERIFIED', actor: 'local-user',
    });
    const reserved = events.events.filter((event) => event.eventType === 'ExecutionReserved');
    expect(reserved.some((event) => event.payload['retryFromExecutionId'] === firstExecution?.executionId))
      .toBe(true);
    await cli(['stop'], value.environment);
  }, 120_000);

  test('refuses every Task that has not failed', async () => {
    const value = await fixture();
    // A DRAFT Task has not run at all: there is nothing to retry, and it says so without changing
    // anything. (A submitted Task would be started by the scheduling pass right away.)
    const draft = await createTask(value.environment, value.projectId, 'Never ran');
    const draftRetry = await retry(value.environment, value.projectId, draft, 0);
    expect(draftRetry.exitCode).toBe(1);
    expect(draftRetry.stderr).toContain('TASK_NOT_FAILED');
    const draftAfter = await status(value.environment, value.projectId, draft);
    expect(draftAfter.task.state).toBe('DRAFT');
    expect(draftAfter.task.version).toBe(0);
    expect(draftAfter.executions).toHaveLength(0);

    // A running Task holds a writer, so a retry would be a second one.
    const running = await startTask(value.environment, value.projectId, 'Hold this (hold)');
    const runningStatus = await status(value.environment, value.projectId, running);
    // A stale version is refused before the state verdict, exactly like submit/pause/resume, so the
    // caller is told to re-read the Task instead of acting on a state it may have already left.
    const stale = await retry(value.environment, value.projectId, running,
      runningStatus.task.version - 1);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain('CONCURRENT_MODIFICATION');
    const runningRetry = await retry(value.environment, value.projectId, running,
      runningStatus.task.version);
    expect(runningRetry.exitCode).toBe(1);
    expect(runningRetry.stderr).toContain('TASK_STILL_RUNNING');
    // Nothing was started for it: the refusal wrote no Execution.
    expect((await status(value.environment, value.projectId, running)).executions).toHaveLength(1);

    // CANCELLED is terminal and is never reopened.
    const cancelled = await startTask(value.environment, value.projectId, 'Cancel me (hold)');
    const cancelledStatus = await status(value.environment, value.projectId, cancelled);
    const cancel = await cli(['task', 'cancel', value.projectId, cancelled,
      String(cancelledStatus.task.version)], value.environment);
    expect(cancel.exitCode).toBe(0);
    const cancelledAfterCancel = await status(value.environment, value.projectId, cancelled);
    expect(cancelledAfterCancel.task.state).toBe('CANCELLED');
    const cancelledRetry = await retry(value.environment, value.projectId, cancelled,
      cancelledAfterCancel.task.version);
    expect(cancelledRetry.exitCode).toBe(1);
    expect(cancelledRetry.stderr).toContain('TASK_CANCELLED');
    const cancelledAfter = await status(value.environment, value.projectId, cancelled);
    expect(cancelledAfter.task.state).toBe('CANCELLED');
    // The refusal is a value, not a state change: the terminal Task did not move.
    expect(cancelledAfter.task.version).toBe(cancelledAfterCancel.task.version);
    expect(cancelledAfter.executions).toHaveLength(1);
    // An archived Task is refused for its own reason rather than started behind the user's back.
    const archived = await startTask(value.environment, value.projectId, 'Archive me (fail-once)');
    const archivedFailed = await waitForState(value.environment, value.projectId, archived, 'FAILED');
    const archive = await cli(['task', 'archive', value.projectId, archived,
      String(archivedFailed.task.version)], value.environment);
    expect(archive.exitCode).toBe(0);
    const archivedRetry = await retry(value.environment, value.projectId, archived,
      archivedFailed.task.version + 1);
    expect(archivedRetry.exitCode).toBe(1);
    expect(archivedRetry.stderr).toContain('TASK_ARCHIVED');
    await cli(['stop'], value.environment);
  }, 120_000);

  test('--adapter changes the Agent of the new Execution, and the change is audited', async () => {
    const value = await fixture();
    const taskId = await startTask(value.environment, value.projectId, 'Switch Agent (fail-once)');
    const failed = await waitForState(value.environment, value.projectId, taskId, 'FAILED');

    const retried = await retry(value.environment, value.projectId, taskId, failed.task.version,
      ['--adapter', 'codex']);
    expect(retried.exitCode).toBe(0);
    const view = JSON.parse(retried.stdout) as RetryView;
    expect(view).toMatchObject({
      adapterId: 'codex', previousAdapterId: 'pi', adapterChanged: true, adapterSource: 'REQUESTED',
      start: { outcome: 'STARTED' },
    });
    // The bar is not the recorded column but the real launch: the Codex stub was the one started.
    await waitFor(() => existsSync(value.codexReportPath));
    const report = JSON.parse(readFileSync(value.codexReportPath, 'utf8')) as
      { readonly turns: number; readonly prompts: readonly string[] };
    expect(report.turns).toBeGreaterThanOrEqual(1);
    expect(report.prompts.join('\n')).toContain('Switch Agent');
    const after = await status(value.environment, value.projectId, taskId);
    expect(after.executions[0]).toMatchObject({
      adapterId: 'codex', retryFromExecutionId: failed.executions[0]?.executionId,
    });
    const events = JSON.parse((await cli(['events', 'list', '--project', value.projectId,
      '--limit', '200'], value.environment)).stdout) as {
      readonly events: readonly { readonly eventType: string; readonly payload: Record<string, unknown> }[];
    };
    expect(events.events.find((event) => event.eventType === 'TaskRetryRequested')?.payload)
      .toMatchObject({ adapterId: 'codex', previousAdapterId: 'pi', adapterChanged: true });
    await cli(['stop'], value.environment);
  }, 120_000);

  test('a retry queues behind capacity instead of jumping the queue', async () => {
    const value = await fixture();
    const capacity = await cli(['scheduler', 'capacity', 'set', '--limit', '1'],
      value.environment);
    expect(capacity.exitCode).toBe(0);

    const failedTask = await startTask(value.environment, value.projectId, 'Queue me (fail-once)');
    const failed = await waitForState(value.environment, value.projectId, failedTask, 'FAILED');
    // The failure released the slot, so the holder below is the Task the retry must queue behind.
    const holder = await startTask(value.environment, value.projectId, 'Hold the slot (hold)');
    await waitForState(value.environment, value.projectId, holder, 'RUNNING');

    const queued = await retry(value.environment, value.projectId, failedTask, failed.task.version);
    expect(queued.exitCode).toBe(3);
    const view = JSON.parse(queued.stdout) as RetryView;
    expect(view).toMatchObject({
      state: 'READY',
      start: { outcome: 'WAIT', executionId: null,
        wait: { kind: 'CAPACITY', code: 'CAPACITY_GLOBAL_LIMIT_REACHED' } },
    });
    // Requenced, not started: the retry is recorded and the Task waits its turn.
    const waiting = await status(value.environment, value.projectId, failedTask);
    expect(waiting.task.state).toBe('READY');
    expect(waiting.executions).toHaveLength(1);

    // Freeing the slot lets the requeued Task run — with its second Execution.
    const holderStatus = await status(value.environment, value.projectId, holder);
    const cancelled = await cli(['task', 'cancel', value.projectId, holder,
      String(holderStatus.task.version)], value.environment);
    expect(cancelled.exitCode).toBe(0);
    const resumed = await status(value.environment, value.projectId, failedTask);
    expect(resumed.executions.length).toBeGreaterThanOrEqual(2);
    expect(resumed.executions[0]?.attemptNumber).toBe(2);
    expect(resumed.task.state).toBe('RUNNING');
    await cli(['stop'], value.environment);
  }, 180_000);

  test('rebuilds a reclaimed worktree from its surviving branch and starts the new Execution', async () => {
    const value = await fixture();
    const taskId = await startTask(value.environment, value.projectId, 'Reclaim me (fail-once)');
    const failed = await waitForState(value.environment, value.projectId, taskId, 'FAILED');
    const worktree = join(value.home, 'worktrees', value.projectId, taskId);
    await waitFor(() => existsSync(join(worktree, `runs-${taskId}.log`)));
    // A failed attempt that already committed: the rebuild attaches the branch, so that commit is
    // what the new Execution starts on — it is not silently replaced by a fresh dev baseline.
    await git(worktree, ['add', '-A']);
    await git(worktree, ['commit', '-q', '-m', 'work the failed attempt already committed']);
    const branchCommit = await git(value.repository, ['rev-parse', `refs/heads/task/${taskId}`]);

    const applied = await cli(['reclaim', 'apply', '--project', value.projectId, '--task', taskId,
      '--kind', 'TASK_WORKTREE', '--include-failure-scenes', '--json'], value.environment);
    expect(applied.exitCode).toBe(0);
    expect(existsSync(worktree)).toBe(false);
    // The reclamation deliberately keeps the Task branch; that branch is what the rebuild needs.
    expect(await git(value.repository, ['branch', '--list', `task/${taskId}`]))
      .toContain(`task/${taskId}`);

    const retried = await retry(value.environment, value.projectId, taskId, failed.task.version);
    expect(retried.exitCode).toBe(0);
    const view = JSON.parse(retried.stdout) as RetryView;
    expect(view).toMatchObject({
      state: 'READY',
      failedExecutionId: failed.executions[0]?.executionId,
      workspace: { mode: 'REBUILD_OWNED', workspaceId: expect.any(String) },
      start: { outcome: 'STARTED', attemptNumber: 2 },
    });
    // The recorded mode is a *verified plan*; the preparation path is what carried it out.
    expect(view.workspace.detail).toContain('does not exist yet');
    expect(existsSync(worktree)).toBe(true);
    expect(await git(worktree, ['symbolic-ref', '-q', 'HEAD'])).toBe(`refs/heads/task/${taskId}`);
    expect(await git(worktree, ['rev-parse', 'HEAD'])).toBe(branchCommit);
    // Exactly one worktree for this Task — never a second one — and its branch was not moved.
    const registrations = (await git(value.repository, ['worktree', 'list', '--porcelain']))
      .split('\n').filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length));
    expect(registrations.filter((path) => path === worktree)).toHaveLength(1);
    expect(await git(value.repository, ['rev-parse', `refs/heads/task/${taskId}`]))
      .toBe(branchCommit);
    // The new Execution really ran in the re-created worktree: the committed line is still there
    // and the second attempt appended its own start.
    await waitFor(() => readFileSync(join(worktree, `runs-${taskId}.log`), 'utf8')
      .split('\n').filter((line) => line.length > 0).length === 2);
    expect(readFileSync(join(worktree, `runs-${taskId}.log`), 'utf8')).toBe(
      `start ${taskId}\nstart ${taskId}\n`);

    const events = JSON.parse((await cli(['events', 'list', '--project', value.projectId,
      '--limit', '400'], value.environment)).stdout) as {
      readonly events: readonly { readonly eventType: string; readonly payload: Record<string, unknown> }[];
    };
    expect(events.events.find((event) => event.eventType === 'TaskRetryRequested')?.payload)
      .toMatchObject({ taskId, workspaceMode: 'REBUILD_OWNED' });
    // The rebuild is its own auditable fact: the re-created worktree is recorded as the existing
    // WorkspacePrepared event of that same workspace, with the rebuild outcome in its payload.
    const rebuilt = events.events.filter((event) => event.eventType === 'WorkspacePrepared')
      .filter((event) => event.payload['reattachedBranch'] === true);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]?.payload).toMatchObject({
      taskId, path: worktree, branchRef: `refs/heads/task/${taskId}`,
      previousState: 'RELEASED',
      rebuild: { outcome: 'REBUILT', reasonCode: 'REBUILT_FROM_TASK_BRANCH', headCommit: branchCommit },
    });
    // A repeated retry is refused by the version check before it can create anything at all.
    const repeated = await retry(value.environment, value.projectId, taskId, failed.task.version);
    expect(repeated.exitCode).toBe(1);
    expect(repeated.stderr).toContain('CONCURRENT_MODIFICATION');
    expect((await git(value.repository, ['worktree', 'list', '--porcelain']))
      .split('\n').filter((line) => line === `worktree ${worktree}`)).toHaveLength(1);
    await cli(['stop'], value.environment);
  }, 180_000);

  test('starts a fresh worktree when a reclaimed worktree and its branch are both gone', async () => {
    const value = await fixture();
    const taskId = await startTask(value.environment, value.projectId, 'Branch gone (fail-once)');
    const failed = await waitForState(value.environment, value.projectId, taskId, 'FAILED');
    const worktree = join(value.home, 'worktrees', value.projectId, taskId);
    await waitFor(() => existsSync(join(worktree, `runs-${taskId}.log`)));

    const applied = await cli(['reclaim', 'apply', '--project', value.projectId, '--task', taskId,
      '--kind', 'TASK_WORKTREE', '--include-failure-scenes', '--json'], value.environment);
    expect(applied.exitCode).toBe(0);
    expect(existsSync(worktree)).toBe(false);
    // Both halves are gone: the directory was reclaimed and the Task branch is deleted out of band,
    // so `decideRetryWorkspace` observes MISSING and answers PREPARE_FRESH — while the ledger still
    // holds the `RELEASED` row for the very same path.
    await git(value.repository, ['update-ref', '-d', `refs/heads/task/${taskId}`]);
    expect(await git(value.repository, ['branch', '--list', `task/${taskId}`])).toBe('');
    const devCommit = await git(value.repository, ['rev-parse', 'refs/heads/dev']);

    const retried = await retry(value.environment, value.projectId, taskId, failed.task.version);
    expect(retried.exitCode).toBe(0);
    const view = JSON.parse(retried.stdout) as RetryView;
    expect(view).toMatchObject({
      state: 'READY',
      workspace: { mode: 'PREPARE_FRESH' },
      start: { outcome: 'STARTED', attemptNumber: 2 },
    });
    // The fresh preparation really prepared something: the recorded path holds a worktree on a newly
    // created Task branch at the fixed dev baseline, and the reclaimed attempt's work is gone.
    expect(existsSync(worktree)).toBe(true);
    expect(await git(worktree, ['symbolic-ref', '-q', 'HEAD'])).toBe(`refs/heads/task/${taskId}`);
    expect(await git(worktree, ['rev-parse', 'HEAD'])).toBe(devCommit);
    await waitFor(() => existsSync(join(worktree, `runs-${taskId}.log`)));
    expect(readFileSync(join(worktree, `runs-${taskId}.log`), 'utf8')).toBe(`start ${taskId}\n`);

    // The `RELEASED` row is history, not a blocker: the ledger now holds a *second* row for the same
    // path (the partial unique index only covers live rows), which `reclaim plan` reports as its own
    // target with its own workspace ID. This is the command-face proof that the path was reusable.
    const planned = await cli(['reclaim', 'plan', '--project', value.projectId, '--task', taskId,
      '--kind', 'TASK_WORKTREE', '--include-failure-scenes', '--json'], value.environment);
    const plan = JSON.parse(planned.stdout) as {
      readonly targets: readonly { readonly kind: string; readonly resourceId: string;
        readonly resourceState: string; readonly path: string }[];
    };
    const rows = plan.targets.filter((target) => target.kind === 'TASK_WORKTREE'
      && target.path === worktree);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.resourceId)).size).toBe(2);
    // One is the reclaimed history row, the other is the workspace the fresh preparation created.
    expect(rows.filter((row) => row.resourceState === 'RELEASED')).toHaveLength(1);
    expect(rows.filter((row) => row.resourceState !== 'RELEASED')).toHaveLength(1);
    await cli(['stop'], value.environment);
  }, 180_000);

  test('refuses to rebuild a reclaimed worktree whose branch cannot prove ownership, writing nothing', async () => {
    const value = await fixture();
    // (1) The branch exists but is unrelated to the baseline the workspace row recorded: an orphan
    // commit with no relation to dev, built with plumbing so the fixture's own checkout is untouched.
    const diverged = await startTask(value.environment, value.projectId, 'Diverged (fail-once)');
    const divergedFailed = await waitForState(value.environment, value.projectId, diverged, 'FAILED');
    const divergedWorktree = join(value.home, 'worktrees', value.projectId, diverged);
    await waitFor(() => existsSync(divergedWorktree));
    await cli(['reclaim', 'apply', '--project', value.projectId, '--task', diverged,
      '--kind', 'TASK_WORKTREE', '--include-failure-scenes', '--json'], value.environment);
    // ADR-0056: both the tree and the orphan branch live in the dev clone, which owns the Task refs.
    const tree = await git(value.repository, ['rev-parse', 'HEAD^{tree}']);
    const unrelated = await git(value.repository, ['commit-tree', tree, '-m', 'unrelated root']);
    await git(value.repository, ['update-ref', `refs/heads/task/${diverged}`, unrelated]);

    const refused = await retry(value.environment, value.projectId, diverged,
      divergedFailed.task.version);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('WORKSPACE_RECLAIMED');
    const afterDiverged = await status(value.environment, value.projectId, diverged);
    expect(afterDiverged.task.state).toBe('FAILED');
    expect(afterDiverged.task.version).toBe(divergedFailed.task.version);
    expect(afterDiverged.executions).toHaveLength(1);
    expect(existsSync(divergedWorktree)).toBe(false);
    expect(await git(value.repository, ['rev-parse', `refs/heads/task/${diverged}`]))
      .toBe(unrelated);

    // (2) The recorded path is occupied by a directory Git does not register: never deleted to make
    // room, because that is an explicit reclamation decision.
    const occupied = await startTask(value.environment, value.projectId, 'Occupied (fail-once)');
    const occupiedFailed = await waitForState(value.environment, value.projectId, occupied, 'FAILED');
    const occupiedWorktree = join(value.home, 'worktrees', value.projectId, occupied);
    await waitFor(() => existsSync(occupiedWorktree));
    await cli(['reclaim', 'apply', '--project', value.projectId, '--task', occupied,
      '--kind', 'TASK_WORKTREE', '--include-failure-scenes', '--json'], value.environment);
    mkdirSync(occupiedWorktree, { recursive: true });
    writeFileSync(join(occupiedWorktree, 'leftover.txt'), 'keep me\n');

    const refusedOccupied = await retry(value.environment, value.projectId, occupied,
      occupiedFailed.task.version);
    expect(refusedOccupied.exitCode).toBe(1);
    expect(refusedOccupied.stderr).toContain('WORKSPACE_RECLAIMED');
    const afterOccupied = await status(value.environment, value.projectId, occupied);
    expect(afterOccupied.task.state).toBe('FAILED');
    expect(afterOccupied.task.version).toBe(occupiedFailed.task.version);
    expect(afterOccupied.executions).toHaveLength(1);
    // Zero writes to the scene: the leftover directory and its file are exactly as they were.
    expect(readFileSync(join(occupiedWorktree, 'leftover.txt'), 'utf8')).toBe('keep me\n');

    // Neither refusal recorded a retry: no audit claim about a Task that never moved.
    const events = JSON.parse((await cli(['events', 'list', '--project', value.projectId,
      '--limit', '400'], value.environment)).stdout) as {
      readonly events: readonly { readonly eventType: string; readonly payload: Record<string, unknown> }[];
    };
    expect(events.events.filter((event) => event.eventType === 'TaskRetryRequested')).toHaveLength(0);
    expect(events.events.filter((event) => event.eventType === 'WorkspacePrepared'
      && event.payload['reattachedBranch'] === true)).toHaveLength(0);
    await cli(['stop'], value.environment);
  }, 180_000);

  test('requeues as BLOCKED when the dependency verdict became unmet', async () => {
    const value = await fixture();
    const upstream = await startTask(value.environment, value.projectId, 'Upstream (hold)');
    const dependent = await startTask(value.environment, value.projectId, 'Dependent (fail-once)');
    const failed = await waitForState(value.environment, value.projectId, dependent, 'FAILED');

    // A dependency edit is allowed while the Task is FAILED, so the retry has to re-derive the
    // verdict: the upstream has not reached `dev`, so the requeue target is BLOCKED.
    const added = await cli(['task', 'depends', 'add', value.projectId, dependent,
      String(failed.task.version), upstream], value.environment);
    expect(added.exitCode).toBe(0);
    const afterAdd = await status(value.environment, value.projectId, dependent);
    // Editing the edge appends a command receipt but does not move the Task out of FAILED.
    expect(afterAdd.task.state).toBe('FAILED');

    const refused = await retry(value.environment, value.projectId, dependent,
      afterAdd.task.version);
    // The requeue itself succeeded; no Execution started, so the exit code says so.
    expect(refused.exitCode).toBe(1);
    const view = JSON.parse(refused.stdout) as RetryView;
    expect(view.state).toBe('BLOCKED');
    expect(view.start).toMatchObject({ outcome: 'REFUSED', code: 'DEPENDENCIES_UNMET' });
    const after = await status(value.environment, value.projectId, dependent);
    expect(after.task.state).toBe('BLOCKED');
    expect(after.executions).toHaveLength(1);
    const events = JSON.parse((await cli(['events', 'list', '--project', value.projectId,
      '--limit', '200'], value.environment)).stdout) as {
      readonly events: readonly { readonly eventType: string; readonly payload: Record<string, unknown> }[];
    };
    expect(events.events.find((event) => event.eventType === 'TaskRetryRequested')?.payload)
      .toMatchObject({ to: 'BLOCKED', workspaceMode: 'REUSE_VERIFIED' });
    await cli(['stop'], value.environment);
  }, 120_000);
});
