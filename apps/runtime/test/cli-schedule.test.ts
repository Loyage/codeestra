import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTemporaryDirectories, registerTemporaryDirectory } from './support/agent-fixture.js';

/**
 * The scheduling engine through the real CLI and the real Runtime (FOUNDATION-055 / ADR-0030).
 *
 * Every assertion is driven by `bun run codeestra …` against a Runtime in a temporary
 * `CODEESTRA_HOME` with a temporary Git repository. The provider is a **protocol stub**: it proves the
 * Runtime's own orchestration — the candidate order, the conflict verdict, the capacity wait, the
 * audit ledger, the crash convergence — and it is *not* evidence about a real Agent integration or
 * about two real models behaving. That limitation is recorded in `docs/tasks/README.md`.
 *
 * The recovery period is set far out in most fixtures so a test sees only the passes it asks for;
 * the growth test relies on an explicit `task schedule run` instead of waiting for the period.
 */

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(() => { cleanupTemporaryDirectories(); });

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  const child = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd: repositoryRoot,
    env: { ...Bun.env, ...environment, no_proxy: '127.0.0.1,localhost' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Schedule Test',
      GIT_AUTHOR_EMAIL: 'schedule@example.invalid', GIT_COMMITTER_NAME: 'Schedule Test',
      GIT_COMMITTER_EMAIL: 'schedule@example.invalid' } });
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
 * A protocol stub, not a real provider. It reports a session, writes the file its Task's
 * specification names (`write:<path>`, default `src/agent/<task-id>.ts`), records one line per start
 * in `CODEESTRA_STUB_LOG` so a test can prove a Task was never started twice, and keeps reading
 * stdin so the Execution goes on holding its resource until the test stops it.
 */
const stubSource = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
const taskId = basename(process.cwd());
const sessionFile = join(process.env.CODEESTRA_STUB_SESSION_DIR ?? process.cwd(),
  'schedule-session-' + taskId + '.jsonl');
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
        sessionId: 'schedule-session-' + taskId, sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      const message = String(record.message ?? '');
      const requested = /write:(\\S+)/.exec(message);
      const path = requested === null ? 'src/agent/' + taskId + '.ts' : requested[1];
      mkdirSync(join(process.cwd(), dirname(path)), { recursive: true });
      writeFileSync(join(process.cwd(), path), 'export const task = ' + JSON.stringify(taskId) + ';\\n');
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'schedule-session-' + taskId, timestamp: '2026-09-14T09:00:00.000Z',
        cwd: process.cwd() }) + '\\n');
      const log = process.env.CODEESTRA_STUB_LOG;
      if (log !== undefined) appendFileSync(log, 'started ' + taskId + ' ' + path + '\\n');
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Wrote ' + path + '.' }], stopReason: 'stop' } });
      // A Task whose specification says 'hold' keeps its turn open, so its Session stays ACTIVE: that
      // is the state a crash has to converge from.
      if (!message.includes('hold')) emit({ type: 'agent_settled' });
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
}

async function fixture(options: {
  readonly withMapping: boolean;
  readonly prefix: string;
  readonly tickMs?: string;
}): Promise<Fixture> {
  const repository = temporaryDirectory(`${options.prefix}-repo-`);
  const home = temporaryDirectory(`${options.prefix}-home-`);
  const tools = temporaryDirectory(`${options.prefix}-tools-`);
  const assets = temporaryDirectory(`${options.prefix}-assets-`);
  const stubLog = join(tools, 'starts.log');
  writeFileSync(stubLog, '');
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  if (options.withMapping) {
    await Bun.write(join(repository, '.codeestra', 'impact.json'),
      `${JSON.stringify(impactMapping, null, 2)}\n`);
  }
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  await git(repository, ['branch', 'dev']);

  const stubPath = join(tools, 'stub-pi.ts');
  const shimPath = join(tools, 'pi');
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);

  const environment = {
    CODEESTRA_HOME: home,
    CODEESTRA_UI_DIST: assets,
    CODEESTRA_PI_EXECUTABLE: shimPath,
    CODEESTRA_STUB_LOG: stubLog,
    CODEESTRA_STUB_SESSION_DIR: home,
    // The recovery period is a convergence safety net; the tests that want a pass ask for one.
    CODEESTRA_SCHEDULE_TICK_MS: options.tickMs ?? '60000',
  };
  const opened = await cli(['open', repository, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  return { environment, repository, home, projectId: projects[0]?.id as string, stubLog };
}

interface TaskRef {
  readonly id: string;
  readonly version: number;
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

async function taskRef(
  environment: Record<string, string>,
  projectId: string,
  taskId: string,
): Promise<TaskRef> {
  const status = JSON.parse((await cli(['task', 'status', projectId, taskId],
    environment)).stdout) as {
    readonly task: { readonly version: number };
    readonly executions: readonly { readonly state: string;
      readonly session: { readonly state: string } | null }[];
  };
  return { id: taskId, version: status.task.version };
}

/** Submits a Task and returns the scheduling answer the submit reported. */
async function submit(
  environment: Record<string, string>,
  projectId: string,
  taskId: string,
  version = 0,
): Promise<{
  readonly taskState: string;
  readonly schedule: {
    readonly started: readonly { readonly taskId: string; readonly executionId: string }[];
    readonly waiting: readonly { readonly taskId: string; readonly kind: string;
      readonly code: string }[];
    readonly blocked: readonly string[];
  };
}> {
  const submitted = await cli(['task', 'submit', projectId, taskId, String(version)], environment);
  expect(submitted.exitCode).toBe(0);
  return JSON.parse(submitted.stdout) as never;
}

async function executions(
  environment: Record<string, string>,
  projectId: string,
  taskId: string,
): Promise<readonly { readonly state: string; readonly session: { readonly state: string } | null }[]> {
  const status = JSON.parse((await cli(['task', 'status', projectId, taskId],
    environment)).stdout) as {
    readonly executions: readonly { readonly state: string;
      readonly session: { readonly state: string } | null }[];
  };
  return status.executions;
}

interface ScheduleEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

async function scheduleEvents(
  environment: Record<string, string>,
  projectId: string,
): Promise<readonly ScheduleEvent[]> {
  const listed = JSON.parse((await cli(['events', 'list', '--project', projectId, '--limit', '200'],
    environment)).stdout) as { readonly events: readonly ScheduleEvent[] };
  return listed.events.filter((event) => event.eventType.startsWith('Task'));
}

describe('codeestra task schedule', () => {
  test('starts two provably disjoint Tasks at capacity two and makes the third wait', async () => {
    const value = await fixture({ withMapping: true, prefix: 'codeestra-schedule-safe' });
    const first = await createTask(value.environment, value.projectId, 'First disjoint area');
    const second = await createTask(value.environment, value.projectId, 'Second disjoint area');
    const third = await createTask(value.environment, value.projectId, 'Third disjoint area');

    // Submitting enters scheduling in the same command: nothing else has to be pushed.
    const firstSubmit = await submit(value.environment, value.projectId, first);
    expect(firstSubmit.schedule.started.map((entry) => entry.taskId)).toEqual([first]);
    const secondSubmit = await submit(value.environment, value.projectId, second);
    expect(secondSubmit.schedule.started.map((entry) => entry.taskId)).toEqual([second]);
    const thirdSubmit = await submit(value.environment, value.projectId, third);
    expect(thirdSubmit.schedule.started).toEqual([]);
    expect(thirdSubmit.schedule.waiting).toEqual([
      { taskId: third, kind: 'CAPACITY', code: 'CAPACITY_GLOBAL_LIMIT_REACHED' },
    ]);

    // Both really are RUNNING at the same time, each with its own Execution and worktree.
    for (const taskId of [first, second]) {
      const status = JSON.parse((await cli(['task', 'status', value.projectId, taskId],
        value.environment)).stdout) as { readonly task: { readonly state: string } };
      expect(status.task.state).toBe('RUNNING');
      const list = await executions(value.environment, value.projectId, taskId);
      expect(list).toHaveLength(1);
      expect(list[0]?.state).toBe('RUNNING');
    }
    await waitFor(() => Bun.file(join(realpathSync(value.home), 'worktrees', value.projectId, first,
      'src', 'agent', `${first}.ts`)).size > 0);
    await waitFor(() => Bun.file(join(realpathSync(value.home), 'worktrees', value.projectId, second,
      'src', 'agent', `${second}.ts`)).size > 0);
    const capacity = JSON.parse((await cli(['scheduler', 'capacity', 'get', value.projectId, '--json'],
      value.environment)).stdout) as { readonly globalUsed: number; readonly globalLimit: number };
    expect(capacity).toMatchObject({ globalUsed: 2, globalLimit: 2 });
    const overview = JSON.parse((await cli(['task', 'schedule', 'status', value.projectId, '--json'],
      value.environment)).stdout) as {
      readonly dryRun: boolean;
      readonly active: readonly { readonly taskId: string }[];
      readonly capacity: { readonly globalUsed: number };
    };
    expect(overview.dryRun).toBe(false);
    expect(overview.active.map((entry) => entry.taskId).sort()).toEqual([first, second].sort());
    expect(overview.capacity.globalUsed).toBe(2);

    // The decisions are auditable: the second Task's start was taken against a SAFE verdict over the
    // first, with the exact assessment versions and the snapshot each verdict came from.
    const events = await scheduleEvents(value.environment, value.projectId);
    const decisions = events.filter((event) => event.eventType === 'TaskScheduleDecided');
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.payload).toMatchObject({
      taskId: first, verdict: 'SAFE_TO_PARALLELIZE', reasonCodes: ['NO_CONFLICT'],
      activeTaskIds: [], analyzerVersion: 'impact-analyzer-v1',
    });
    expect(decisions[1]?.payload).toMatchObject({
      taskId: second, verdict: 'SAFE_TO_PARALLELIZE', reasonCodes: ['NO_CONFLICT'],
      activeTaskIds: [first],
    });
    expect(typeof decisions[1]?.payload['candidateSnapshotId']).toBe('string');
    const waiting = events.find((event) => event.eventType === 'TaskWaitingForCapacity');
    expect(waiting?.payload).toMatchObject({
      taskId: third, kind: 'CAPACITY', code: 'CAPACITY_GLOBAL_LIMIT_REACHED',
    });
    expect([...(waiting?.payload['blocking'] as readonly string[])].sort())
      .toEqual([first, second].sort());

    // The third Task's explicit request is a *wait*, not a `BLOCKED` and not a failure.
    const thirdRef = await taskRef(value.environment, value.projectId, third);
    const ran = await cli(['task', 'run', value.projectId, third, String(thirdRef.version), '--json'],
      value.environment);
    expect(ran.exitCode).toBe(3);
    const outcome = JSON.parse(ran.stdout) as {
      readonly outcome: string;
      readonly wait: { readonly kind: string; readonly code: string } | null;
      readonly assessment: { readonly verdict: string } | null;
    };
    expect(outcome.outcome).toBe('WAIT');
    expect(outcome.wait).toMatchObject({ kind: 'CAPACITY', code: 'CAPACITY_GLOBAL_LIMIT_REACHED' });
    expect(outcome.assessment?.verdict).toBe('SAFE_TO_PARALLELIZE');
    expect(ran.stderr).toContain('CAPACITY_GLOBAL_LIMIT_REACHED');
    expect(ran.stderr).not.toContain('BLOCKED');
    expect((await executions(value.environment, value.projectId, third))).toHaveLength(0);
  }, 120_000);

  test('a proven same-file overlap keeps a paused Task paused with the analyzer reason codes', async () => {
    const value = await fixture({ withMapping: true, prefix: 'codeestra-schedule-conflict' });
    // Both write the *same* file. They were started on empty predictions, which is exactly the
    // residual risk the conflict gate cannot see yet; once both have observed the file, resuming
    // either of them beside the other is a proven overlap.
    const first = await createTask(value.environment, value.projectId, 'write:core/shared.ts');
    const second = await createTask(value.environment, value.projectId, 'write:core/shared.ts');
    expect((await submit(value.environment, value.projectId, first)).schedule.started).toHaveLength(1);
    expect((await submit(value.environment, value.projectId, second)).schedule.started).toHaveLength(1);
    for (const taskId of [first, second]) {
      await waitFor(() => Bun.file(join(realpathSync(value.home), 'worktrees', value.projectId,
        taskId, 'core', 'shared.ts')).size > 0);
    }
    const secondRef = await taskRef(value.environment, value.projectId, second);
    const paused = await cli(['task', 'pause', value.projectId, second, String(secondRef.version)],
      value.environment);
    expect(paused.exitCode).toBe(0);
    expect(JSON.parse(paused.stdout)).toMatchObject({ state: 'PAUSED', stop: 'RELEASED' });

    // `explain` answers why it is not running, with the intersecting path and the Task it hits.
    const explained = await cli(['task', 'schedule', 'explain', value.projectId, second, '--json'],
      value.environment);
    expect(explained.exitCode).toBe(3);
    const view = JSON.parse(explained.stdout) as {
      readonly decision: string;
      readonly assessment: { readonly verdict: string } | null;
      readonly wait: { readonly kind: string; readonly code: string;
        readonly blocking: readonly string[];
        readonly hits: readonly { readonly paths: readonly string[];
          readonly taskId: string | null }[] } | null;
    };
    expect(view.decision).toBe('WAIT_CONFLICT');
    expect(view.assessment?.verdict).toBe('CONFLICTING');
    expect(view.wait?.code).toBe('SAME_FILE');
    expect(view.wait?.hits[0]?.paths).toContain('core/shared.ts');
    expect(view.wait?.hits[0]?.taskId).toBe(first);

    // Resuming is a start path, so it is refused and the Task stays paused. A *proven* overlap is a
    // refusal (exit 1) rather than a wait (exit 3), exactly as `task run` reports it.
    const resumed = await cli(['task', 'resume', value.projectId, second, String(secondRef.version)],
      value.environment);
    expect(resumed.exitCode).toBe(1);
    expect(resumed.stderr).toContain('CONFLICTING');
    expect(resumed.stderr).toContain('SAME_FILE');
    expect(JSON.parse((await cli(['task', 'status', value.projectId, second],
      value.environment)).stdout)).toMatchObject({ task: { state: 'PAUSED' } });
    // A proven overlap is never released: `--allow-unknown` widens the gate for an *unproven* one
    // only, and `clear-unknown` says so instead of pretending it worked.
    const releasedResume = await cli(['task', 'resume', value.projectId, second,
      String(secondRef.version), '--allow-unknown'], value.environment);
    expect(releasedResume.exitCode).toBe(1);
    expect(releasedResume.stderr).toContain('CONFLICTING');
    const cleared = await cli(['task', 'schedule', 'clear-unknown', value.projectId, second, '--json'],
      value.environment);
    expect(cleared.exitCode).toBe(1);
    expect(JSON.parse(cleared.stdout)).toMatchObject({
      recorded: false, state: 'CONFLICTING', reasonCodes: expect.arrayContaining(['SAME_FILE']),
    });
    expect(JSON.parse((await cli(['task', 'status', value.projectId, second],
      value.environment)).stdout)).toMatchObject({ task: { state: 'PAUSED' } });
  }, 120_000);

  test('waits on UNKNOWN, starts it exclusively on request, and releases it explicitly beside a peer', async () => {
    const value = await fixture({ withMapping: false, prefix: 'codeestra-schedule-unknown' });
    const first = await createTask(value.environment, value.projectId, 'Unknown first');
    const second = await createTask(value.environment, value.projectId, 'Unknown second');
    // Without a mapping nothing is provably disjoint, so the automatic pass waits: UNKNOWN is not a
    // silent concurrency decision, it is a wait with the analyzer's own reason code.
    const firstSubmit = await submit(value.environment, value.projectId, first);
    expect(firstSubmit.schedule.started).toEqual([]);
    expect(firstSubmit.schedule.waiting).toEqual([
      { taskId: first, kind: 'CONFLICT', code: 'INCOMPLETE_IMPACT' },
    ]);
    expect((await executions(value.environment, value.projectId, first))).toHaveLength(0);
    const firstRef = await taskRef(value.environment, value.projectId, first);
    // An explicit request may run a lone UNKNOWN Task exclusively (scheduler.md §2).
    const exclusive = await cli(['task', 'run', value.projectId, first, String(firstRef.version),
      '--json'], value.environment);
    expect(exclusive.exitCode).toBe(0);
    expect(JSON.parse(exclusive.stdout)).toMatchObject({
      outcome: 'STARTED', assessment: { verdict: 'UNKNOWN', reasonCodes: ['INCOMPLETE_IMPACT'] },
      clearedUnknownBy: null,
    });
    expect(JSON.parse(exclusive.stdout)).toMatchObject({ sessionId: expect.any(String) });

    // The same request for a second Task now waits: a peer holds a resource.
    await submit(value.environment, value.projectId, second);
    const secondRef = await taskRef(value.environment, value.projectId, second);
    const waited = await cli(['task', 'run', value.projectId, second, String(secondRef.version),
      '--json'], value.environment);
    expect(waited.exitCode).toBe(3);
    expect(JSON.parse(waited.stdout)).toMatchObject({
      outcome: 'WAIT', wait: { kind: 'CONFLICT', code: 'INCOMPLETE_IMPACT', blocking: [first] },
    });

    // The explicit single-shot release starts it *beside* the running Task: a released Task is not
    // downgraded to an exclusive one, and no other Task is stopped for it.
    const released = await cli(['task', 'run', value.projectId, second, String(secondRef.version),
      '--allow-unknown', '--json'], value.environment);
    expect(released.exitCode).toBe(0);
    const releasedView = JSON.parse(released.stdout) as {
      readonly outcome: string; readonly clearedUnknownBy: string | null;
    };
    expect(releasedView.outcome).toBe('STARTED');
    expect(releasedView.clearedUnknownBy).toBeTruthy();
    for (const taskId of [first, second]) {
      const status = JSON.parse((await cli(['task', 'status', value.projectId, taskId],
        value.environment)).stdout) as { readonly task: { readonly state: string } };
      expect(status.task.state).toBe('RUNNING');
    }

    // The audit shows who released which revision and which assessment, and the start names the
    // release it consumed.
    const events = await scheduleEvents(value.environment, value.projectId);
    const cleared = events.find((event) => event.eventType === 'TaskUnknownCleared');
    expect(cleared?.payload).toMatchObject({
      taskId: second, verdict: 'UNKNOWN', reasonCodes: ['INCOMPLETE_IMPACT'],
      releasedBy: 'local-user', scope: 'SINGLE_START', analyzerVersion: 'impact-analyzer-v1',
    });
    expect(typeof cleared?.payload['baseCommit']).toBe('string');
    expect(typeof cleared?.payload['policyVersion']).toBe('string');
    const decision = events.find((event) => event.eventType === 'TaskScheduleDecided'
      && event.payload['taskId'] === second);
    expect(decision?.payload['clearedUnknownBy']).toBe(cleared?.eventId);

    // The release did not rewrite the assessment: the analyzer still says UNKNOWN.
    const explained = await cli(['project', 'impact', 'explain', value.projectId, second, '--json'],
      value.environment);
    expect(explained.exitCode).toBe(1);
    expect(JSON.parse(explained.stdout)).toMatchObject({
      assessment: { verdict: 'UNKNOWN', reasonCodes: ['INCOMPLETE_IMPACT'] },
    });
    // ...and it was single-shot: there is nothing left to reuse for another start.
    const again = await cli(['task', 'schedule', 'clear-unknown', value.projectId, second, '--json'],
      value.environment);
    expect(JSON.parse(again.stdout)).toMatchObject({ state: 'RECORDED' });
  }, 120_000);

  test('two ticks and two concurrent start requests never create a second Execution', async () => {
    const value = await fixture({ withMapping: false, prefix: 'codeestra-schedule-unique' });
    const task = await createTask(value.environment, value.projectId, 'Exactly once');
    // Without a mapping the automatic pass starts nothing, so the Task stays READY while the passes
    // run — and every pass must still decide the same thing.
    expect((await submit(value.environment, value.projectId, task)).schedule.started).toEqual([]);
    for (const _pass of [1, 2]) {
      const tick = await cli(['task', 'schedule', 'run', value.projectId, '--json'], value.environment);
      expect(tick.exitCode).toBe(0);
    }
    expect(await executions(value.environment, value.projectId, task)).toHaveLength(0);
    expect(JSON.parse((await cli(['task', 'status', value.projectId, task],
      value.environment)).stdout)).toMatchObject({ task: { state: 'READY' } });

    // A query command must not start anything either: `status` and `plan` report what a pass *would*
    // do, and neither reserves nor starts — even for exactly the candidate a pass would start.
    for (const read of [['task', 'schedule', 'status'], ['task', 'schedule', 'plan']]) {
      const view = await cli([...read, value.projectId, '--json'], value.environment);
      expect(view.exitCode).toBe(0);
      const parsed = JSON.parse(view.stdout) as {
        readonly dryRun: boolean;
        readonly candidates: readonly { readonly taskId: string;
          readonly disposition: string }[];
      };
      expect(parsed.dryRun).toBe(read[2] === 'plan');
      expect(parsed.candidates.map((candidate) => [candidate.taskId, candidate.disposition]))
        .toEqual([[task, 'WOULD_START']]);
      expect(await executions(value.environment, value.projectId, task)).toHaveLength(0);
      expect(JSON.parse((await cli(['task', 'status', value.projectId, task],
        value.environment)).stdout)).toMatchObject({ task: { state: 'READY' } });
    }

    // Two concurrent explicit start requests for the same READY Task: exactly one start, one refusal.
    const ref = await taskRef(value.environment, value.projectId, task);
    const [left, right] = await Promise.all([
      cli(['task', 'run', value.projectId, task, String(ref.version), '--json'], value.environment),
      cli(['task', 'run', value.projectId, task, String(ref.version), '--json'], value.environment),
    ]);
    expect([left.exitCode, right.exitCode].sort()).toEqual([0, 1]);
    expect(JSON.parse((left.exitCode === 0 ? left : right).stdout)).toMatchObject({
      outcome: 'STARTED',
    });
    expect(await executions(value.environment, value.projectId, task)).toHaveLength(1);
    // A further pass over a Task that holds its resource starts nothing for it, and an explicit
    // request for it is refused instead of restarted.
    expect((await cli(['task', 'schedule', 'run', value.projectId, '--json'],
      value.environment)).exitCode).toBe(0);
    const afterStart = await taskRef(value.environment, value.projectId, task);
    const refused = await cli(['task', 'run', value.projectId, task, String(afterStart.version)],
      value.environment);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('TASK_NOT_STARTABLE');
    expect(await executions(value.environment, value.projectId, task)).toHaveLength(1);
    // One Agent process in total: the stub logs one start line per Task and no more.
    const log = await Bun.file(value.stubLog).text();
    expect(log.trim().split('\n').filter((line) => line.includes(task))).toHaveLength(1);
  }, 120_000);

  test('revokes a SAFE prediction whose diff grew and asks the grown Task to pause', async () => {
    const value = await fixture({ withMapping: true, prefix: 'codeestra-schedule-growth' });
    // Capacity four, so nothing in this test can be a capacity wait.
    expect((await cli(['scheduler', 'capacity', 'set', value.projectId, '--limit', '4'],
      value.environment)).exitCode).toBe(0);
    const first = await createTask(value.environment, value.projectId, 'write:core/first.ts');
    const second = await createTask(value.environment, value.projectId, 'write:core/second.ts');
    // Both start on empty predictions, which is the residual risk §4 exists for.
    expect((await submit(value.environment, value.projectId, first)).schedule.started).toHaveLength(1);
    expect((await submit(value.environment, value.projectId, second)).schedule.started).toHaveLength(1);
    await waitFor(() => Bun.file(join(realpathSync(value.home), 'worktrees', value.projectId, first,
      'core', 'first.ts')).size > 0);
    await waitFor(() => Bun.file(join(realpathSync(value.home), 'worktrees', value.projectId, second,
      'core', 'second.ts')).size > 0);

    // The next pass sees both diffs, and neither scope is contained in the prediction any more.
    const tick = await cli(['task', 'schedule', 'run', value.projectId, '--json'], value.environment);
    expect(tick.exitCode).toBe(0);
    const report = JSON.parse(tick.stdout) as {
      readonly projects: readonly { readonly impactGrowth: readonly {
        readonly taskId: string; readonly addedPaths: readonly string[];
        readonly conflictingTaskIds: readonly string[]; readonly pauseRequested: boolean;
        readonly pauseOutcome: string | null }[] }[];
    };
    const growth = report.projects[0]?.impactGrowth ?? [];
    expect(growth.length).toBeGreaterThan(0);
    expect(growth[0]?.pauseRequested).toBe(true);
    expect(growth[0]?.pauseOutcome).toContain('PAUSED');
    const revoked = (await scheduleEvents(value.environment, value.projectId))
      .filter((event) => event.eventType === 'TaskImpactPredictionRevoked');
    expect(revoked.length).toBeGreaterThan(0);
    expect(revoked[0]?.payload['pauseRequested']).toBe(true);
    expect(revoked[0]?.payload['addedPaths']).toBeDefined();
    // The grown Tasks were asked to pause through the existing cooperative stop, and the pause is a
    // recorded state, not a kill.
    const states = await Promise.all([first, second].map(async (taskId) => {
      const status = JSON.parse((await cli(['task', 'status', value.projectId, taskId],
        value.environment)).stdout) as { readonly task: { readonly state: string } };
      return status.task.state;
    }));
    expect(states.every((state) => state === 'PAUSED')).toBe(true);

    // Related Tasks are not started again: both grown Tasks hold a proven overlap with the other, so
    // resuming either of them beside the other is refused. Nothing is preempted and nothing is
    // restarted to resolve the conflict; the failure scene (both worktrees) is retained.
    for (const taskId of [first, second]) {
      const ref = await taskRef(value.environment, value.projectId, taskId);
      const resumed = await cli(['task', 'resume', value.projectId, taskId, String(ref.version)],
        value.environment);
      expect(resumed.exitCode).toBe(1);
      expect(resumed.stderr).toContain('CONFLICTING');
      expect(JSON.parse((await cli(['task', 'status', value.projectId, taskId],
        value.environment)).stdout)).toMatchObject({ task: { state: 'PAUSED' } });
    }
    expect(existsSync(join(realpathSync(value.home), 'worktrees', value.projectId, first, 'core',
      'first.ts'))).toBe(true);
    expect(existsSync(join(realpathSync(value.home), 'worktrees', value.projectId, second, 'core',
      'second.ts'))).toBe(true);
  }, 120_000);

  test('a crash while a Task runs is converged without starting a second Agent', async () => {
    const value = await fixture({ withMapping: true, prefix: 'codeestra-schedule-crash' });
    // `hold` keeps the stub's turn open, so the Session is ACTIVE when the crash happens — the state
    // a new generation cannot observe and must converge from the recorded facts.
    const task = await createTask(value.environment, value.projectId,
      'write:src/agent/crash.ts hold');
    expect((await submit(value.environment, value.projectId, task)).schedule.started).toHaveLength(1);
    // Wait for the fact the crash must interrupt: an ACTIVE provider Session this generation holds.
    let sessionState = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const list = await executions(value.environment, value.projectId, task);
      sessionState = list[0]?.session?.state ?? '';
      if (sessionState === 'ACTIVE') break;
      await Bun.sleep(20);
    }
    expect(sessionState).toBe('ACTIVE');
    const status = JSON.parse((await cli(['status'], value.environment)).stdout) as
      { readonly pid: number };
    process.kill(status.pid, 'SIGKILL');
    await waitFor(() => {
      try { process.kill(status.pid, 0); return false; } catch { return true; }
    });

    // The next command starts a new Runtime generation. Its reconciles judge the facts that are
    // really there: the Execution it cannot observe is never reported as running, and the startup
    // scheduling pass does not start a second Execution for a Task that holds its resource.
    const after = JSON.parse((await cli(['task', 'status', value.projectId, task],
      value.environment)).stdout) as {
      readonly task: { readonly state: string };
      readonly executions: readonly { readonly state: string }[];
    };
    expect(after.task.state).toBe('RECOVERY_REQUIRED');
    expect(after.executions).toHaveLength(1);
    expect(after.executions[0]?.state).toBe('RECOVERY_REQUIRED');
    const schedule = JSON.parse((await cli(['task', 'schedule', 'status', value.projectId, '--json'],
      value.environment)).stdout) as {
      readonly candidates: readonly unknown[];
      readonly active: readonly { readonly taskId: string; readonly executionState: string }[];
      readonly capacity: { readonly globalUsed: number };
    };
    expect(schedule.active).toHaveLength(1);
    expect(schedule.active[0]).toMatchObject({ taskId: task, executionState: 'RECOVERY_REQUIRED' });
    expect(schedule.candidates).toEqual([]);
    expect(schedule.capacity.globalUsed).toBe(1);
    // One Agent process was started in total, across both Runtime generations.
    const log = await Bun.file(value.stubLog).text();
    expect(log.trim().split('\n').filter((line) => line.includes(task))).toHaveLength(1);
    expect(existsSync(join(realpathSync(value.home), 'worktrees', value.projectId, task))).toBe(true);
  }, 120_000);
});
