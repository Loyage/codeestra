import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTemporaryDirectories, registerTemporaryDirectory } from './support/agent-fixture.js';
import { reclaimTestResources, runCli } from './support/runtime-reclamation.js';

/**
 * A prose-question wait, driven through the real command face only (FOUNDATION-069 / ADR-0043).
 *
 * The Agent here is a protocol stub, never a real provider: it replays Pi's own RPC records so the
 * whole chain (Adapter → observation → storage → CLI) can be asserted from the outside. That makes
 * the orchestration, the recorded facts and the exit codes real; it says nothing about how a real
 * model behaves, which is recorded as unverified in the Task note.
 *
 * No desktop, browser or keyboard automation is involved: every assertion reads a CLI response or
 * its exit code.
 */

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => {
  await reclaimTestResources();
  cleanupTemporaryDirectories();
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Wait Test',
      GIT_AUTHOR_EMAIL: 'wait@example.invalid', GIT_COMMITTER_NAME: 'Wait Test',
      GIT_COMMITTER_EMAIL: 'wait@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

interface TaskStatusPayload {
  readonly task: { readonly id: string; readonly state: string };
  readonly executions: readonly { readonly executionId: string; readonly state: string;
    readonly session: { readonly sessionId: string; readonly state: string;
      readonly completion: { readonly outcome: string;
        readonly facts?: unknown;
        readonly note: { readonly code: string } | null } | null } | null }[];
}

interface AttentionListing {
  readonly id: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly status: string;
  readonly providerRequestId: string;
  readonly prompt: { readonly kind?: string; readonly code?: string;
    readonly text?: string | null } | null;
}

interface EventEnvelope {
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * A protocol stub, not a real provider: no tool call anywhere in the run, and the Agent ends by
 * asking its question in ordinary prose — the exact shape the heuristic is stated over.
 */
const stubSource = `
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const sessionDirIndex = argv.indexOf('--session-dir');
const sessionDir = sessionDirIndex >= 0 ? argv[sessionDirIndex + 1] : process.cwd();
mkdirSync(sessionDir, { recursive: true });
const sessionFile = join(sessionDir, 'wait-session.jsonl');
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
        sessionId: 'wait-session', sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop',
        content: [{ type: 'text', text: 'Which package manager should I use?' }] } });
      emit({ type: 'agent_settled' });
      setTimeout(() => process.exit(0), 50);
    }
  }
}
`;

async function fixture(): Promise<{
  readonly environment: Record<string, string>;
  readonly projectId: string;
}> {
  const repository = temporaryDirectory('codeestra-wait-repo-');
  const home = temporaryDirectory('codeestra-wait-home-');
  const tools = temporaryDirectory('codeestra-wait-tools-');
  const assets = temporaryDirectory('codeestra-wait-assets-');
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'),
    JSON.stringify({ version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.',
      timeoutSeconds: 60 }] }));
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
  };
  const opened = await cli(['open', repository, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  return { environment, projectId: projects[0]?.id as string };
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

/** Creates, submits and runs one Task through the CLI, then waits for its Session to exit. */
async function executedTask(
  value: { readonly environment: Record<string, string>; readonly projectId: string },
): Promise<string> {
  const { environment, projectId } = value;
  const created = JSON.parse((await cli(['task', 'create', projectId, 'Ask the user something'],
    environment)).stdout) as { readonly id: string };
  const taskId = created.id;
  expect((await cli(['task', 'submit', projectId, taskId, '0'], environment)).exitCode).toBe(0);
  const ran = await cli(['task', 'run', projectId, taskId, '1'], environment);
  expect(ran.exitCode).toBe(0);
  await waitFor(async () => {
    const status = JSON.parse((await cli(['task', 'status', projectId, taskId, '--json'],
      environment)).stdout) as TaskStatusPayload;
    return status.executions[0]?.session?.state === 'EXITED';
  }, 'the Agent Session to exit');
  return taskId;
}

async function taskStatus(
  value: { readonly environment: Record<string, string>; readonly projectId: string },
  taskId: string,
) {
  const listed = await cli(['task', 'status', value.projectId, taskId, '--json'], value.environment);
  expect(listed.exitCode).toBe(0);
  return { status: JSON.parse(listed.stdout) as TaskStatusPayload, stderr: listed.stderr };
}

async function attentions(
  value: { readonly environment: Record<string, string>; readonly projectId: string },
): Promise<readonly AttentionListing[]> {
  const listed = await cli(['attention', 'list', value.projectId], value.environment);
  expect(listed.exitCode).toBe(0);
  return JSON.parse(listed.stdout) as readonly AttentionListing[];
}

async function events(
  value: { readonly environment: Record<string, string>; readonly projectId: string },
): Promise<readonly EventEnvelope[]> {
  const listed = await cli(['events', 'list', '--project', value.projectId, '--since', '0',
    '--limit', '500'], value.environment);
  expect(listed.exitCode).toBe(0);
  return (JSON.parse(listed.stdout) as { readonly events: readonly EventEnvelope[] }).events;
}

describe('codeestra prose question waits', () => {
  test('escalates by default, refuses a provider delivery, and ends on an explicit answer', async () => {
    const value = await fixture();
    const { environment, projectId } = value;
    const taskId = await executedTask(value);
    try {
      // The default (no settings command was run) turns the note into a real wait the user can see.
      const waited = await taskStatus(value, taskId);
      expect(waited.status.task.state).toBe('WAITING_FOR_USER');
      expect(waited.status.executions[0]?.session?.completion?.note?.code)
        .toBe('PROSE_QUESTION_NO_TOOL_USE');
      // The provider process exited before the wait was recorded: nothing claims it is still live.
      expect(waited.status.executions[0]?.session?.state).toBe('EXITED');
      expect(waited.status.executions[0]?.state).toBe('RUNNING');
      // A human reading the command sees the reason and the command that ends it.
      expect(waited.stderr).toContain('[note]');
      expect(waited.stderr).toContain('[waiting]');
      expect(waited.stderr).toContain('Which package manager should I use?');

      const listed = await attentions(value);
      expect(listed).toHaveLength(1);
      const attention = listed[0] as AttentionListing;
      expect(attention).toMatchObject({ kind: 'QUESTION', status: 'OPEN', taskId });
      // The provider request id is derived, not borrowed: a prose question has no provider request,
      // and the derived value is recognizable as the Runtime's own.
      expect(attention.providerRequestId.startsWith('codeestra-prose-question:')).toBe(true);
      expect(attention.prompt).toMatchObject({ kind: 'codeestra.prose-question',
        code: 'PROSE_QUESTION_NO_TOOL_USE', text: 'Which package manager should I use?' });

      // There is no provider dialog to answer, so the ordinary answer channel must refuse instead
      // of writing a response for a request that never existed.
      const refused = await cli(['attention', 'answer', projectId, attention.id, 'value', 'bun'],
        environment);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('PROSE_QUESTION_RESOLUTION_REQUIRED');
      expect((await attentions(value))[0]?.status).toBe('OPEN');

      // Resolving is one command, zero confirmations, and it returns the Task without pretending
      // that a conversation resumed.
      const resolved = await cli(['attention', 'resolve', projectId, attention.id,
        '--answer', 'Use bun, and keep it in devDependencies.', '--json'], environment);
      expect(resolved.exitCode).toBe(0);
      const outcome = JSON.parse(resolved.stdout) as Readonly<Record<string, unknown>>;
      expect(outcome).toMatchObject({ attentionId: attention.id, resolution: 'ANSWERED',
        answerText: 'Use bun, and keep it in devDependencies.', taskState: 'RUNNING',
        sessionState: 'EXITED', attentionStatus: 'CLOSED', deliveredToProvider: false });

      const after = await taskStatus(value, taskId);
      expect(after.status.task.state).toBe('RUNNING');
      expect(after.stderr).not.toContain('[waiting]');
      expect((await attentions(value))[0]?.status).toBe('CLOSED');
      // The answer is an audit fact, bound to the wait and never delivered to an Agent.
      const resolvedEvents = (await events(value))
        .filter((event) => event.eventType === 'ProseQuestionAttentionResolved');
      expect(resolvedEvents).toHaveLength(1);
      expect(resolvedEvents[0]?.payload).toMatchObject({ attentionId: attention.id,
        resolution: 'ANSWERED', answerText: 'Use bun, and keep it in devDependencies.',
        deliveredToProvider: false });
      // The revision history is untouched: an answer is not an amendment.
      const revisions = await cli(['task', 'revision', 'list', projectId, taskId], environment);
      expect(revisions.exitCode).toBe(0);
      expect((JSON.parse(revisions.stdout) as { readonly revisions: readonly unknown[] }).revisions)
        .toHaveLength(1);

      // A second, independent resolution is refused by the recorded status, with its own code.
      const again = await cli(['attention', 'resolve', projectId, attention.id, '--dismiss'],
        environment);
      expect(again.exitCode).toBe(1);
      expect(again.stderr).toContain('PROSE_QUESTION_ATTENTION_ALREADY_RESOLVED');

      // Ambiguous or unusable shapes stay usage errors for scripts.
      const both = await cli(['attention', 'resolve', projectId, attention.id, '--dismiss',
        '--answer', 'x'], environment);
      expect(both.exitCode).toBe(2);
      const neither = await cli(['attention', 'resolve', projectId, attention.id], environment);
      expect(neither.exitCode).toBe(2);
      expect((await cli(['attention', 'resolve', projectId, attention.id, '--bogus'], environment))
        .exitCode).toBe(2);
    } finally {
      await cli(['stop'], environment);
    }
  }, 180_000);

  test('dismisses a false alarm and returns the Task to where it was', async () => {
    const value = await fixture();
    const { environment, projectId } = value;
    const taskId = await executedTask(value);
    try {
      const attention = (await attentions(value))[0] as AttentionListing;
      expect(attention.status).toBe('OPEN');

      const dismissed = await cli(['attention', 'resolve', projectId, attention.id, '--dismiss',
        '--note', 'the Agent simply finished its turn', '--json'], environment);
      expect(dismissed.exitCode).toBe(0);
      expect(JSON.parse(dismissed.stdout) as Readonly<Record<string, unknown>>).toMatchObject({
        resolution: 'DISMISSED_FALSE_POSITIVE', answerText: null,
        note: 'the Agent simply finished its turn', taskState: 'RUNNING',
        sessionState: 'EXITED', deliveredToProvider: false });

      const after = await taskStatus(value, taskId);
      expect(after.status.task.state).toBe('RUNNING');
      // The dismissal is an append-only fact, and the completion keeps its note: nothing was
      // rewritten, only acted on.
      const log = await events(value);
      expect(log.filter((event) => event.eventType === 'ProseQuestionAttentionResolved')[0]?.payload)
        .toMatchObject({ resolution: 'DISMISSED_FALSE_POSITIVE',
          note: 'the Agent simply finished its turn', deliveredToProvider: false });
      expect(after.status.executions[0]?.session?.completion?.note?.code)
        .toBe('PROSE_QUESTION_NO_TOOL_USE');
      // A dismissal must not smuggle an answer in.
      const smuggled = await cli(['attention', 'resolve', projectId, attention.id, '--dismiss',
        '--answer', 'x'], environment);
      expect(smuggled.exitCode).toBe(2);
    } finally {
      await cli(['stop'], environment);
    }
  }, 180_000);

  test('the settings command downgrades escalation with no confirmation', async () => {
    const value = await fixture();
    const { environment } = value;
    try {
      const read = await cli(['settings', 'prose-question-attention', '--json'], environment);
      expect(read.exitCode).toBe(0);
      expect(JSON.parse(read.stdout) as Readonly<Record<string, unknown>>).toMatchObject({
        mode: 'auto', default: 'auto',
      });

      const downgraded = await cli(['settings', 'prose-question-attention', 'record-only', '--json'],
        environment);
      expect(downgraded.exitCode).toBe(0);
      expect(JSON.parse(downgraded.stdout) as Readonly<Record<string, unknown>>)
        .toMatchObject({ mode: 'record-only' });

      const taskId = await executedTask(value);
      // FOUNDATION-056's behaviour, now reachable on purpose: the note is recorded, no wait is.
      const status = await taskStatus(value, taskId);
      expect(status.status.task.state).toBe('RUNNING');
      expect(status.status.executions[0]?.session?.completion?.note?.code)
        .toBe('PROSE_QUESTION_NO_TOOL_USE');
      expect(await attentions(value)).toEqual([]);
      expect(status.stderr).not.toContain('[waiting]');

      // An unusable value is a usage error, not a silent fallback to a different mode.
      expect((await cli(['settings', 'prose-question-attention', 'maybe'], environment)).exitCode)
        .toBe(2);
      expect((await cli(['settings', 'prose-question-attention', '--json'], environment)).stdout)
        .toContain('"mode": "record-only"');
    } finally {
      await cli(['stop'], environment);
    }
  }, 180_000);

  test('off records strictly less: no note, no wait', async () => {
    const value = await fixture();
    const { environment } = value;
    try {
      expect((await cli(['settings', 'prose-question-attention', 'off', '--json'], environment))
        .exitCode).toBe(0);
      const taskId = await executedTask(value);
      const status = await taskStatus(value, taskId);
      expect(status.status.task.state).toBe('RUNNING');
      expect(status.status.executions[0]?.session?.completion?.facts).toBeDefined();
      expect(status.status.executions[0]?.session?.completion?.note).toBeNull();
      expect(await attentions(value)).toEqual([]);
      expect(status.stderr).not.toContain('[note]');
    } finally {
      await cli(['stop'], environment);
    }
  }, 180_000);
});
