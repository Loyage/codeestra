import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTemporaryDirectories, registerTemporaryDirectory } from './support/agent-fixture.js';

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
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Progress Test',
      GIT_AUTHOR_EMAIL: 'progress@example.invalid', GIT_COMMITTER_NAME: 'Progress Test',
      GIT_COMMITTER_EMAIL: 'progress@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

interface OperationProgressPayload {
  readonly sequence: number;
  readonly stepKey: string;
  readonly step: string;
  readonly state: string;
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly recordedAt: number;
}

interface OperationPayload {
  readonly operationId: string;
  readonly kind: string;
  readonly taskId: string | null;
  readonly state: string;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly cancelRequestedAt: number | null;
  readonly steps: readonly OperationProgressPayload[];
}

interface EventEnvelopePayload {
  readonly sequence: number;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface TaskStatusPayload {
  readonly task: { readonly id: string; readonly state: string; readonly version: number };
  readonly executions: readonly { readonly state: string;
    readonly session: { readonly state: string } | null }[];
  readonly verifications: readonly { readonly state: string; readonly outcomeCode: string | null }[];
  readonly operations: readonly OperationPayload[];
}

/**
 * A protocol stub, not a real provider: it writes one file in the Task worktree and settles. It
 * proves the Runtime's long-command command face, never that a real Agent integration works.
 */
const stubSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const sessionDirIndex = argv.indexOf('--session-dir');
const sessionDir = sessionDirIndex >= 0 ? argv[sessionDirIndex + 1] : process.cwd();
mkdirSync(sessionDir, { recursive: true });
const sessionFile = join(sessionDir, 'progress-session.jsonl');
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
        sessionId: 'progress-session', sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      writeFileSync(join(process.cwd(), 'agent-output.txt'), 'work\\n');
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'progress-session', timestamp: '2026-09-13T09:00:00.000Z',
        cwd: process.cwd() }) + '\\n');
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Wrote the file.' }], stopReason: 'stop' } });
      emit({ type: 'agent_settled' });
      setTimeout(() => process.exit(0), 50);
    }
  }
}
`;

async function fixture(verificationCommands: readonly unknown[]): Promise<{
  readonly environment: Record<string, string>;
  readonly repository: string;
  readonly projectId: string;
}> {
  const repository = temporaryDirectory('codeestra-progress-repo-');
  const home = temporaryDirectory('codeestra-progress-home-');
  const tools = temporaryDirectory('codeestra-progress-tools-');
  const assets = temporaryDirectory('codeestra-progress-assets-');
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'),
    JSON.stringify({ version: 1, commands: verificationCommands }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  // ADR-0009: the long-lived dev branch is the workspace baseline and the integration target.
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
  };
  const opened = await cli(['open', repository, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  return { environment, repository, projectId: projects[0]?.id as string };
}

async function status(
  environment: Record<string, string>,
  projectId: string,
  taskId: string,
): Promise<TaskStatusPayload> {
  const listed = await cli(['task', 'status', projectId, taskId], environment);
  expect(listed.exitCode).toBe(0);
  return JSON.parse(listed.stdout) as TaskStatusPayload;
}

async function operations(
  environment: Record<string, string>,
  projectId: string,
  taskId: string,
): Promise<readonly OperationPayload[]> {
  const listed = await cli(['task', 'operation', 'list', projectId, taskId, '--json'], environment);
  expect(listed.exitCode).toBe(0);
  return JSON.parse(listed.stdout) as readonly OperationPayload[];
}

async function waitFor(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for: ${message}`);
}

/** Creates, submits, runs, and captures one Task through the CLI only. */
async function executedTask(fixtureValue: {
  readonly environment: Record<string, string>;
  readonly projectId: string;
}): Promise<string> {
  const { environment, projectId } = fixtureValue;
  const created = JSON.parse((await cli(['task', 'create', projectId, 'Write a file'],
    environment)).stdout) as { readonly id: string };
  const taskId = created.id;
  expect((await cli(['task', 'submit', projectId, taskId, '0'], environment)).exitCode).toBe(0);
  const ran = await cli(['task', 'run', projectId, taskId, '1'], environment);
  expect(ran.exitCode).toBe(0);
  await waitFor(async () => (await status(environment, projectId, taskId))
    .executions[0]?.session?.state === 'EXITED', 'the Agent Session to exit');
  const captured = await cli(['task', 'result', 'capture', projectId, taskId], environment);
  expect(captured.exitCode).toBe(0);
  return taskId;
}

/** The append-only event log as the CLI reads it: the same cursor read `events list` performs. */
async function events(environment: Record<string, string>, projectId: string)
  : Promise<readonly EventEnvelopePayload[]> {
  const read = await cli(['events', 'list', '--project', projectId, '--since', '0', '--limit', '500'],
    environment);
  expect(read.exitCode).toBe(0);
  const parsed = JSON.parse(read.stdout) as { readonly events: readonly EventEnvelopePayload[] };
  return parsed.events;
}

describe('codeestra task operation progress', () => {
  test('records task.run progress as durable steps and reports them through the CLI', async () => {
    const fixtureValue = await fixture([
      { id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 },
    ]);
    const { environment, projectId, repository } = fixtureValue;
    const taskId = await executedTask(fixtureValue);
    try {
      // The run Operation is settled by the observation loop, so wait for that fact instead of
      // assuming it happened before the CLI returned from result capture.
      await waitFor(async () => (await operations(environment, projectId, taskId))
        .some((operation) => operation.kind === 'RUN_TASK'
          && operation.state === 'SUCCEEDED'), 'the run Operation to settle');
      const listed = await operations(environment, projectId, taskId);
      const run = listed.find((operation) => operation.kind === 'RUN_TASK');
      if (run === undefined) throw new Error('task.run did not record an Operation');
      expect(run.taskId).toBe(taskId);
      expect(run.state).toBe('SUCCEEDED');
      const stepKeys = run.steps.map((step) => step.stepKey);
      expect(stepKeys).toContain('RUN_REQUESTED');
      expect(stepKeys).toContain('WORKSPACE_PREPARED');
      expect(stepKeys).toContain('EXECUTION_RESERVED');
      expect(stepKeys).toContain('AGENT_SESSION_STARTED');
      expect(stepKeys).toContain('AGENT_SETTLED');
      // Steps are ordered and each one was written exactly once.
      expect(run.steps.map((step) => step.sequence))
        .toEqual(run.steps.map((_step, index) => index));
      expect(new Set(stepKeys).size).toBe(stepKeys.length);
      // Progress is observable from the Task projection too, not only from this command.
      expect((await status(environment, projectId, taskId)).operations
        .some((operation) => operation.operationId === run.operationId)).toBe(true);

      const detailed = await cli(['task', 'operation', 'get', projectId, run.operationId, '--json'],
        environment);
      expect(detailed.exitCode).toBe(0);
      expect((JSON.parse(detailed.stdout) as OperationPayload).operationId).toBe(run.operationId);

      // The human view prints every step instead of a percentage it cannot know.
      const human = await cli(['task', 'operation', 'list', projectId, taskId], environment);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain('RUN_TASK');
      expect(human.stdout).toContain('AGENT_SETTLED');

      // Cancelling a finished Operation reports that it is already terminal, and does not kill a
      // Task that already produced a result.
      const cancelled = await cli(['task', 'operation', 'cancel', projectId, taskId, run.operationId,
        '--json'], environment);
      expect(cancelled.exitCode).toBe(0);
      expect(JSON.parse(cancelled.stdout)).toMatchObject({ stop: 'ALREADY_TERMINAL', state: 'SUCCEEDED' });
      expect((await status(environment, projectId, taskId)).task.state).toBe('EXECUTED');
      expect(await git(repository, ['status', '--porcelain'])).toBe('');
      // Progress is a fact on the append-only event log, so it is readable by any client that reads
      // events — no separate progress query, and no polling response to invent.
      const log = await events(environment, projectId);
      const progressed = log.filter((event) => event.eventType === 'OperationProgressed'
        && event.aggregateId === run.operationId);
      expect(progressed.map((event) => event.payload['stepKey'])).toEqual(stepKeys);
      // `stepSequence` is monotonic per Operation, so a consumer can order or drop stale progress.
      expect(progressed.map((event) => event.payload['progressSequence']))
        .toEqual(progressed.map((_event, index) => index));
      const settled = log.filter((event) => event.eventType === 'OperationSettled'
        && event.aggregateId === run.operationId);
      expect(settled).toHaveLength(1);
      // The settle fact says the run ended, never that anything passed: the result capture and the
      // verification are separate facts this event must not impersonate.
      expect(settled[0]?.payload).toMatchObject({
        kind: 'RUN_TASK', operationState: 'SUCCEEDED', verdict: false });
      for (const event of [...progressed, ...settled]) {
        expect(event.payload['verdict']).toBe(false);
        expect(event.payload['state']).toBeUndefined();
      }

      // Unknown flags are usage errors for scripts, never silently ignored.
      const bogus = await cli(['task', 'operation', 'list', projectId, taskId, '--bogus'], environment);
      expect(bogus.exitCode).toBe(2);
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);

  test('runs task.verify in the background and cancels a slow policy command', async () => {
    const fixtureValue = await fixture([
      { id: 'slow', argv: ['sleep', '30'], cwd: '.', timeoutSeconds: 120 },
      { id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 },
    ]);
    const { environment, projectId, repository } = fixtureValue;
    const taskId = await executedTask(fixtureValue);
    const devBefore = await git(repository, ['rev-parse', 'refs/heads/dev']);
    try {
      const started = await cli(['task', 'verify', projectId, taskId, '--background'], environment);
      // Exit 0 means "accepted": the Operation is recorded and running, not that it passed.
      expect(started.exitCode).toBe(0);
      expect(started.stderr).toContain('验证已在后台开始');
      const handle = JSON.parse(started.stdout) as { readonly background: boolean;
        readonly operationId: string; readonly verificationId: string; readonly state: string };
      expect(handle.background).toBe(true);
      expect(handle.state).toBe('RUNNING');

      await waitFor(async () => (await operations(environment, projectId, taskId))
        .some((operation) => operation.operationId === handle.operationId
          && operation.steps.some((step) => step.stepKey === 'COMMAND:slow:STARTED')),
      'the slow verification command to start');
      const running = (await operations(environment, projectId, taskId))
        .find((operation) => operation.operationId === handle.operationId);
      expect(running?.state).toBe('IN_PROGRESS');
      expect(running?.steps.some((step) => step.stepKey === 'VERIFICATION_QUEUED')).toBe(true);
      expect(running?.steps.some((step) => step.stepKey === 'VERIFICATION_COPY_CREATED')).toBe(true);

      const cancelled = await cli(['task', 'operation', 'cancel', projectId, taskId,
        handle.operationId, '--json'], environment);
      expect(cancelled.exitCode).toBe(0);
      expect(JSON.parse(cancelled.stdout)).toMatchObject({
        stop: 'CANCELLED', kind: 'RUN_TASK_VERIFICATION', state: 'FAILED' });

      const after = await status(environment, projectId, taskId);
      // ADR-0027: the cancelled run is its own state, so a reader never has to read ERROR and guess.
      const verification = after.verifications
        .find((row) => row.state === 'CANCELLED');
      expect(verification?.outcomeCode).toBe('CANCELLED_BY_USER');
      // A cancelled verification never moves `dev`, and the Task is not terminated by it.
      expect(await git(repository, ['rev-parse', 'refs/heads/dev'])).toBe(devBefore);
      expect(after.task.state).toBe('EXECUTED');
      expect((await operations(environment, projectId, taskId))
        .find((operation) => operation.operationId === handle.operationId)?.state).toBe('FAILED');

      // The same state through the read-only verification projection, and the same progress through
      // the event log: a cancelled run is cancelled everywhere, never folded back into a failure.
      const listed = await cli(['task', 'verification', 'list', projectId, taskId], environment);
      expect(listed.exitCode).toBe(0);
      const listedRuns = JSON.parse(listed.stdout) as readonly { readonly state: string }[];
      expect(listedRuns.map((row) => row.state)).toEqual(['CANCELLED']);
      const log = await events(environment, projectId);
      const verificationProgress = log.filter((event) =>
        event.eventType === 'OperationProgressed' && event.aggregateId === handle.operationId);
      expect(verificationProgress.map((event) => event.payload['stepKey'])).toEqual([
        'VERIFICATION_QUEUED', 'VERIFICATION_COPY_CREATED', 'COMMAND:slow:STARTED',
        'CANCEL_REQUESTED']);
      const settled = log.filter((event) => event.eventType === 'OperationSettled'
        && event.aggregateId === handle.operationId);
      // The cancel path publishes the settle fact with the recorded terminal state of the run.
      expect(settled).toHaveLength(1);
      expect(settled[0]?.payload).toMatchObject({
        kind: 'RUN_TASK_VERIFICATION', operationState: 'FAILED', verdict: false });
      expect(JSON.stringify(settled[0]?.payload)).not.toContain('PASSED');
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);
});
