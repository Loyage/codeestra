import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFixtureTaskForExplicitStart,
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

/**
 * CLI/command-face acceptance for the Codex adapter (ADR-0029).
 *
 * Both providers are protocol stubs. They prove the Runtime's command face, the permission
 * routing and the failure paths; they are not evidence of a real Codex integration (that evidence
 * lives in `docs/spikes/codex-0.151.0.md`).
 */
const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => { await reclaimTestResources(); });

function temporaryDirectory(prefix: string): string {
  // macOS resolves /var to /private/var; provider processes report resolved paths.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  // FOUNDATION-057: the shared runner refuses a non-temporary CODEESTRA_HOME (a test must never
  // reach the real Runtime home) and registers the home so teardown stops any Runtime it started,
  // including when an assertion fails before the test's own stop.
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Codex Adapter Test',
      GIT_AUTHOR_EMAIL: 'codex-adapter@example.invalid', GIT_COMMITTER_NAME: 'Codex Adapter Test',
      GIT_COMMITTER_EMAIL: 'codex-adapter@example.invalid' } });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

interface CodexStubReport {
  readonly argv: readonly string[];
  readonly approvalPolicy: string | null;
  readonly threadModel: string | null;
  readonly threadProvider: string | null;
  readonly decisions: readonly unknown[];
  readonly prompts: readonly string[];
  readonly resumed: number;
  readonly turns: number;
}

/**
 * A protocol stub for `codex app-server --stdio`. In `APPROVAL` mode it asks for approval of one
 * command only when the launch said commands need approval, records the decision, then settles.
 */
const codexStubSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\\n');
  process.exit(0);
}
const mode = process.env.CODEESTRA_CODEX_CLI_STUB_MODE ?? 'APPROVAL';
const reportPath = process.env.CODEESTRA_CODEX_CLI_STUB_REPORT;
const rollout = process.env.CODEESTRA_CODEX_CLI_STUB_ROLLOUT;
const sessionId = 'cli-stub-thread';
const received = { argv, approvalPolicy: null, threadModel: null, threadProvider: null,
  decisions: [], prompts: [], resumed: 0, turns: 0 };
const save = () => {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(received, null, 2));
};
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
const complete = (turnId) => emit({ method: 'turn/completed', params: { threadId: sessionId,
  turn: { id: turnId, status: 'completed', error: null, items: [] } } });
save();

const handle = (frame) => {
  if (typeof frame.method === 'string' && frame.id !== undefined) {
    if (frame.method === 'initialize') {
      emit({ jsonrpc: '2.0', id: frame.id, result: { userAgent: 'stub', codexHome: '',
        platformFamily: 'unix', platformOs: 'linux' } });
    } else if (frame.method === 'thread/start') {
      received.approvalPolicy = frame.params.approvalPolicy;
      received.threadModel = frame.params.model ?? null;
      received.threadProvider = frame.params.modelProvider ?? null;
      mkdirSync(dirname(rollout), { recursive: true });
      writeFileSync(rollout, '{}\\n');
      save();
      emit({ jsonrpc: '2.0', id: frame.id, result: { thread: { id: sessionId, path: rollout } } });
    } else if (frame.method === 'thread/resume') {
      received.approvalPolicy = frame.params.approvalPolicy;
      received.resumed += 1;
      save();
      emit({ jsonrpc: '2.0', id: frame.id, result: { thread: { id: frame.params.threadId, path: rollout } } });
    } else if (frame.method === 'turn/start') {
      received.prompts.push(frame.params.input[0].text);
      received.turns += 1;
      save();
      const turnId = 'cli-turn-' + received.turns;
      emit({ jsonrpc: '2.0', id: frame.id, result: { turn: { id: turnId } } });
      if (mode === 'APPROVAL' && received.approvalPolicy !== 'never') {
        emit({ jsonrpc: '2.0', id: 0, method: 'item/commandExecution/requestApproval', params: {
          kind: 'command', threadId: sessionId, turnId, itemId: 'call-1', startedAtMs: 1,
          environmentId: 'local', command: '/bin/sh -lc false', cwd: process.cwd(),
          availableDecisions: ['accept', 'cancel'] } });
      } else {
        complete(turnId);
      }
    }
    return;
  }
  if (frame.method === undefined && frame.id !== undefined) {
    received.decisions.push(frame.result ?? null);
    save();
    complete('cli-turn-' + received.turns);
  }
};

let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    handle(JSON.parse(line));
  }
}
`;

/** Minimal Pi protocol stub, used only as the second adapter in the replacement test. */
const piStubSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const sessionDir = argv[argv.indexOf('--session-dir') + 1] ?? process.cwd();
mkdirSync(sessionDir, { recursive: true });
const sessionFile = join(sessionDir, 'pi-cli-session.jsonl');
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');

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
        sessionId: 'pi-cli-session', sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'pi-cli-session',
        timestamp: '2026-09-14T09:00:00.000Z', cwd: process.cwd() }) + '\\n');
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'pi did it' }], stopReason: 'stop' } });
      emit({ type: 'agent_settled' });
    }
  }
}
`;

interface Fixture {
  readonly environment: Record<string, string>;
  readonly repository: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly codexReportPath: string;
  readonly codexRolloutPath: string;
}

async function fixture(options: { readonly strict?: boolean;
  readonly codexExecutable?: 'stub' | 'missing' } = {}): Promise<Fixture> {
  const repository = temporaryDirectory('codeestra-codex-cli-repo-');
  const home = temporaryDirectory('codeestra-codex-cli-home-');
  const codexHome = temporaryDirectory('codeestra-codex-cli-provider-');
  const tools = temporaryDirectory('codeestra-codex-cli-tools-');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  await git(repository, ['branch', 'dev']);
  // ADR-0056: every dev fact comes from a second clone of the same origin that sits on
  // `dev`; the project is trusted with it explicitly.

  const codexStubPath = join(tools, 'codex-stub.ts');
  await Bun.write(codexStubPath, codexStubSource);
  const codexShim = join(tools, 'codex');
  await Bun.write(codexShim, `#!/bin/sh\nexec "${process.execPath}" "${codexStubPath}" "$@"\n`);
  chmodSync(codexShim, 0o755);
  const piStubPath = join(tools, 'pi-stub.ts');
  await Bun.write(piStubPath, piStubSource);
  const piShim = join(tools, 'pi');
  await Bun.write(piShim, `#!/bin/sh\nexec "${process.execPath}" "${piStubPath}" "$@"\n`);
  chmodSync(piShim, 0o755);

  const codexReportPath = join(tools, 'codex-report.json');
  const codexRolloutPath = join(codexHome, 'sessions', '2026', '09', '14', 'rollout-cli.jsonl');
  const environment = {
    CODEESTRA_HOME: home,
    CODEESTRA_PI_EXECUTABLE: piShim,
    CODEESTRA_CODEX_EXECUTABLE: options.codexExecutable === 'missing'
      ? join(tools, 'definitely-missing-codex')
      : codexShim,
    CODEESTRA_CODEX_HOME: codexHome,
    CODEESTRA_CODEX_CLI_STUB_REPORT: codexReportPath,
    CODEESTRA_CODEX_CLI_STUB_ROLLOUT: codexRolloutPath,
    CODEESTRA_CODEX_CLI_STUB_MODE: 'APPROVAL',
    // These tests drive the explicit `task run --adapter …` command, so the recovery pass must not
    // start the READY Task on its own default adapter while they are setting up.
    CODEESTRA_SCHEDULE_TICK_MS: '600000',
  };
  if (options.strict === true) {
    // STRICT is a live Runtime switch; the project trust then needs the explicit confirmation flag.
    expect((await cli(['settings', 'permission', 'set', 'strict'], environment)).exitCode).toBe(0);
  }
  const opened = await cli(['project', 'trust', repository,
    ...(options.strict === true ? ['--yes'] : [])], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  const projectId = projects[0]?.id as string;
  // ADR-0059 starts an undeclared Task as soon as it is submitted, and the automatic pass would use
  // the default adapter. The shared helper keeps the fixture behind a real feature conflict and
  // leaves it READY, so each test's explicit `task run --adapter …` is what actually starts it.
  await cli(['stop'], environment);
  const ready = await createFixtureTaskForExplicitStart({
    home, environment, projectId, specification: 'Write a file', startable: true,
  });
  return { environment, repository, projectId, taskId: ready.taskId,
    taskVersion: ready.expectedVersion, codexReportPath, codexRolloutPath };
}

interface TaskStatus {
  readonly task: { readonly id: string; readonly state: string; readonly version: number };
  readonly taskState: string;
  readonly executions: readonly { readonly adapterId?: string; readonly state: string;
    readonly session: { readonly state: string } | null }[];
}

async function status(environment: Record<string, string>,
  projectId: string, taskId: string): Promise<TaskStatus> {
  const listed = await cli(['task', 'status', projectId, taskId], environment);
  expect(listed.exitCode).toBe(0);
  return JSON.parse(listed.stdout) as TaskStatus;
}

async function waitForSessionExit(environment: Record<string, string>,
  projectId: string, taskId: string, timeoutMs = 30_000): Promise<TaskStatus> {
  const deadline = Date.now() + timeoutMs;
  let current = await status(environment, projectId, taskId);
  while (Date.now() < deadline) {
    if (current.executions.some((execution) => execution.session?.state === 'EXITED')) return current;
    await Bun.sleep(100);
    current = await status(environment, projectId, taskId);
  }
  throw new Error(`The Codex Session never exited; last status was ${JSON.stringify(current.task)}`);
}

async function waitForAttention(environment: Record<string, string>, projectId: string): Promise<{
  readonly id: string; readonly kind: string; readonly responseType: string;
  readonly prompt: Readonly<Record<string, unknown>>;
}> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const listed = await cli(['attention', 'list', projectId], environment);
    if (listed.exitCode === 0) {
      const attentions = JSON.parse(listed.stdout) as readonly {
        readonly id: string; readonly kind: string; readonly responseType: string; readonly status: string;
        readonly prompt: Readonly<Record<string, unknown>> }[];
      const open = attentions.find((attention) => attention.status === 'OPEN');
      if (open !== undefined) return open;
    }
    await Bun.sleep(100);
  }
  throw new Error('The Codex approval Attention never appeared');
}

function codexReport(path: string): CodexStubReport {
  return JSON.parse(readFileSync(path, 'utf8')) as CodexStubReport;
}

describe('codeestra task run --adapter codex', () => {
  test('routes a STRICT command approval to the existing Attention face and back to Codex',
    async () => {
      const { environment, projectId, taskId, taskVersion, codexReportPath } =
        await fixture({ strict: true });
      // FULL would launch Codex with `approvalPolicy: never`; STRICT must ask.
      expect((await cli(['settings', 'permission', 'get'], environment)).stdout)
        .toContain('"mode": "STRICT"');
      const ran = await cli(['task', 'run', projectId, taskId, String(taskVersion), '--adapter', 'codex'],
        environment);
      expect(ran.exitCode).toBe(0);
      expect(JSON.parse(ran.stdout)).toMatchObject({ adapterId: 'codex' });

      const attention = await waitForAttention(environment, projectId);
      expect(attention.kind).toBe('PERMISSION');
      expect(attention.responseType).toBe('CONFIRM');
      expect(attention.prompt).toMatchObject({ kind: 'codex.permission', approvalKind: 'command',
        command: '/bin/sh -lc false' });

      const answered = await cli(['attention', 'answer', projectId, attention.id, 'confirm', 'no'],
        environment);
      expect(answered.exitCode).toBe(0);
      expect(JSON.parse(answered.stdout)).toMatchObject({ status: 'DELIVERED' });

      const exited = await waitForSessionExit(environment, projectId, taskId);
      // A denial is not a failed turn: Codex continues without the tool and the Session ends.
      expect(exited.executions[0]?.session?.state).toBe('EXITED');
      const report = codexReport(codexReportPath);
      expect(report.argv).toEqual(['app-server', '--stdio']);
      expect(report.approvalPolicy).toBe('untrusted');
      expect(report.decisions).toEqual([{ decision: 'decline' }]);
      await cli(['stop'], environment);
    }, 120_000);

  test('runs without any approval in FULL mode and never asks for confirmation', async () => {
    const { environment, projectId, taskId, taskVersion, codexReportPath } = await fixture();
    const ran = await cli(['task', 'run', projectId, taskId, String(taskVersion), '--adapter', 'codex'],
      environment);
    expect(ran.exitCode).toBe(0);
    const exited = await waitForSessionExit(environment, projectId, taskId);
    expect(exited.executions[0]?.session?.state).toBe('EXITED');
    const attentions = JSON.parse((await cli(['attention', 'list', projectId], environment)).stdout) as
      readonly unknown[];
    expect(attentions).toEqual([]);
    expect(codexReport(codexReportPath).approvalPolicy).toBe('never');
    await cli(['stop'], environment);
  }, 120_000);

  test('replaces a failed run attempt with a new run on a different adapter', async () => {
    // The Codex executable is missing, so this attempt fails during the version probe, before any
    // Execution or worktree is reserved. The Task stays runnable and a different Agent can run it.
    const { environment, projectId, taskId, taskVersion } = await fixture({ codexExecutable: 'missing' });
    const failed = await cli(['task', 'run', projectId, taskId, String(taskVersion), '--adapter', 'codex'],
      environment);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('PROVIDER_VERSION_UNAVAILABLE');
    const afterFailure = await status(environment, projectId, taskId);
    expect(afterFailure.task.state).toBe('READY');
    expect(afterFailure.executions).toEqual([]);

    const replaced = await cli(['task', 'run', projectId, taskId,
      String(afterFailure.task.version), '--adapter', 'pi'], environment);
    expect(replaced.exitCode).toBe(0);
    expect(JSON.parse(replaced.stdout)).toMatchObject({ adapterId: 'pi' });
    const exited = await waitForSessionExit(environment, projectId, taskId);
    expect(exited.executions).toHaveLength(1);
    expect(exited.executions[0]?.session?.state).toBe('EXITED');
    await cli(['stop'], environment);
  }, 120_000);

  test('applies the per-adapter Agent configuration to the Codex launch only', async () => {
    const { environment, projectId, taskId, taskVersion, codexReportPath } = await fixture();
    const configured = await cli(['agent', 'config', 'set', '--adapter', 'codex',
      '--provider', 'openai', '--model', 'cli-stub-model', '--thinking', 'high'], environment);
    expect(configured.exitCode).toBe(0);
    // The same command face reports the Codex scope and leaves the Pi scope untouched.
    const codex = JSON.parse((await cli(['agent', 'config', 'get', '--adapter', 'codex'],
      environment)).stdout) as { readonly effective: Readonly<Record<string, string>> };
    expect(codex.effective).toMatchObject({ provider: 'openai', model: 'cli-stub-model',
      thinkingLevel: 'high' });
    const pi = JSON.parse((await cli(['agent', 'config', 'get', '--adapter', 'pi'],
      environment)).stdout) as { readonly effective: Readonly<Record<string, string>> };
    // Unset fields are reported as null on the command face, and the Pi scope has no model.
    expect(pi.effective.model).toBeNull();

    expect((await cli(['task', 'run', projectId, taskId, String(taskVersion), '--adapter', 'codex'],
      environment)).exitCode).toBe(0);
    await waitForSessionExit(environment, projectId, taskId);
    const report = codexReport(codexReportPath);
    expect(report.argv).toEqual(['app-server', '--stdio', '-c', 'model_reasoning_effort=high']);
    expect(report.threadModel).toBe('cli-stub-model');
    expect(report.threadProvider).toBe('openai');
    await cli(['stop'], environment);
  }, 120_000);

  test('resumes a paused Codex Task on Codex and refuses a cross-provider resume', async () => {
    const { environment, projectId, taskId, taskVersion, codexReportPath } = await fixture();
    expect((await cli(['task', 'run', projectId, taskId, String(taskVersion), '--adapter', 'codex'],
      environment)).exitCode).toBe(0);
    await waitForSessionExit(environment, projectId, taskId);

    const version = (await status(environment, projectId, taskId)).task.version;
    const paused = await cli(['task', 'pause', projectId, taskId, String(version)], environment);
    expect(paused.exitCode).toBe(0);
    const pausedVersion = (await status(environment, projectId, taskId)).task.version;
    const resumed = await cli(['task', 'resume', projectId, taskId, String(pausedVersion),
      '--adapter', 'codex'], environment);
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ state: 'RUNNING' });
    await waitForSessionExit(environment, projectId, taskId);
    // The provider reopened the recorded thread instead of starting a fresh conversation.
    expect(codexReport(codexReportPath).resumed).toBe(1);

    const secondPause = (await status(environment, projectId, taskId)).task.version;
    expect((await cli(['task', 'pause', projectId, taskId, String(secondPause)],
      environment)).exitCode).toBe(0);
    const beforeRefusal = (await status(environment, projectId, taskId)).task.version;
    const refused = await cli(['task', 'resume', projectId, taskId, String(beforeRefusal),
      '--adapter', 'pi'], environment);
    // A Codex conversation cannot be handed to the Pi adapter, and the Runtime says so instead of
    // silently starting a conversation the Task never had.
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('AGENT_START_FAILED');
    await cli(['stop'], environment);
  }, 180_000);
});
