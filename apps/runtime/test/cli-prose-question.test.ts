import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTemporaryDirectories, registerTemporaryDirectory } from './support/agent-fixture.js';
import { reclaimTestResources, runCli } from './support/runtime-reclamation.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => {
  // Integration fix: this file predates FOUNDATION-057's shared reclamation helper. It happened to
  // stop its Runtime on the success path, but a failing assertion would have leaked a daemon whose
  // home was then deleted underneath it.
  await reclaimTestResources();
  cleanupTemporaryDirectories();
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  // FOUNDATION-057: the shared runner refuses a non-temporary CODEESTRA_HOME and registers the home
  // so teardown can stop any Runtime this invocation started.
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Note Test',
      GIT_AUTHOR_EMAIL: 'note@example.invalid', GIT_COMMITTER_NAME: 'Note Test',
      GIT_COMMITTER_EMAIL: 'note@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

interface CompletionFactsPayload {
  readonly toolCallCount: number;
  readonly finalAssistantText: string | null;
  readonly finalAssistantTextTruncated: boolean;
  readonly finalAssistantStopReason: string | null;
}

interface CompletionPayload {
  readonly outcome: string;
  readonly evidenceRef: string | null;
  readonly facts: CompletionFactsPayload | null;
  readonly note: { readonly code: string; readonly heuristic: string;
    readonly message: string; readonly facts: CompletionFactsPayload } | null;
}

interface TaskStatusPayload {
  readonly task: { readonly id: string; readonly state: string };
  readonly executions: readonly { readonly executionId: string;
    readonly state: string;
    readonly session: { readonly sessionId: string; readonly state: string;
      readonly completion: CompletionPayload | null } | null }[];
  readonly operations: readonly { readonly kind: string; readonly state: string;
    readonly result: Readonly<Record<string, unknown>> | null }[];
}

interface EventEnvelopePayload {
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * A protocol stub, not a real provider. It replays Pi's own RPC records so the Runtime's whole
 * command face (Adapter → observation → storage → CLI) can be driven from the outside. It is never
 * evidence about a real Agent.
 *
 * `PROSE_QUESTION` is the shape this lane exists for: no tool call anywhere in the run, and the
 * Agent ends by asking its question in ordinary prose.
 */
const stubSource = `
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const mode = Bun.env.CODEESTRA_STUB_MODE ?? 'PROSE_QUESTION';
const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const sessionDirIndex = argv.indexOf('--session-dir');
const sessionDir = sessionDirIndex >= 0 ? argv[sessionDirIndex + 1] : process.cwd();
mkdirSync(sessionDir, { recursive: true });
const sessionFile = join(sessionDir, 'note-session.jsonl');
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
        sessionId: 'note-session', sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      if (mode === 'PROSE_QUESTION') {
        emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop',
          content: [{ type: 'text', text: 'Which package manager should I use?' }] } });
      } else {
        emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'write', args: {} });
        emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: {} }] } });
        emit({ type: 'turn_end', message: { role: 'assistant', stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: {} }] },
          toolResults: [{ toolCallId: 'call-1' }] });
        emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop',
          content: [{ type: 'text', text: 'Wrote the file. Want me to update the README?' }] } });
      }
      emit({ type: 'agent_settled' });
      setTimeout(() => process.exit(0), 50);
    }
  }
}
`;

async function fixture(mode: 'PROSE_QUESTION' | 'TOOL_THEN_QUESTION'): Promise<{
  readonly environment: Record<string, string>;
  readonly projectId: string;
}> {
  const repository = temporaryDirectory('codeestra-note-repo-');
  const home = temporaryDirectory('codeestra-note-home-');
  const tools = temporaryDirectory('codeestra-note-tools-');
  const assets = temporaryDirectory('codeestra-note-assets-');
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
  // ADR-0056: every dev fact comes from a second clone of the same origin that sits on
  // `dev`; the project is trusted with it explicitly.

  const stubPath = join(tools, 'stub-pi.ts');
  const shimPath = join(tools, 'pi');
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);

  const environment = {
    CODEESTRA_HOME: home,
    CODEESTRA_UI_DIST: assets,
    CODEESTRA_PI_EXECUTABLE: shimPath,
    CODEESTRA_STUB_MODE: mode,
  };
  const opened = await cli(['open', repository, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  // FOUNDATION-069 made the product default `auto`, which records the note *and* the wait it stands
  // for. The contract this file pins is FOUNDATION-056's: annotate the completion and change no
  // state. That is now the explicit `record-only` downgrade, so the fixture asks for it; the default
  // path is covered end to end by `cli-prose-question-attention.test.ts`.
  const downgraded = await cli(['settings', 'prose-question-attention', 'record-only'], environment);
  expect(downgraded.exitCode).toBe(0);
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

/** Creates and submits one Task through the CLI, then waits for its automatically started Session. */
async function executedTask(
  value: { readonly environment: Record<string, string>; readonly projectId: string },
): Promise<string> {
  const { environment, projectId } = value;
  const created = JSON.parse((await cli(['task', 'create', projectId, 'Ask the user something',
    '--title', 'Ask the user something', '--name', 'ask-the-user'],
    environment)).stdout) as { readonly id: string };
  const taskId = created.id;
  // ADR-0059 makes an undeclared Task SAFE, so submit itself starts the Session.
  expect((await cli(['task', 'submit', projectId, taskId, '0'], environment)).exitCode).toBe(0);
  await waitFor(async () => {
    const status = JSON.parse((await cli(['task', 'status', projectId, taskId, '--json'],
      environment)).stdout) as TaskStatusPayload;
    return status.executions[0]?.session?.state === 'EXITED';
  }, 'the Agent Session to exit');
  return taskId;
}

describe('codeestra prose question notes', () => {
  test('records and shows a note when a run used no tool and ended with a question', async () => {
    const value = await fixture('PROSE_QUESTION');
    const { environment, projectId } = value;
    const taskId = await executedTask(value);
    try {
      const listed = await cli(['task', 'status', projectId, taskId, '--json'], environment);
      expect(listed.exitCode).toBe(0);
      const status = JSON.parse(listed.stdout) as TaskStatusPayload;
      const completion = status.executions[0]?.session?.completion;
      // The outcome is still the provider's own: this lane annotates, it does not re-classify.
      expect(completion?.outcome).toBe('SUCCESS');
      expect(completion?.note).toMatchObject({
        code: 'PROSE_QUESTION_NO_TOOL_USE',
        heuristic: 'NO_TOOL_CALLS_IN_RUN_AND_TRAILING_QUESTION_MARK',
      });
      expect(completion?.note?.message).toContain('heuristic');
      // The provider facts the rule saw travel with it, so the note can be re-checked.
      expect(completion?.note?.facts).toEqual({
        toolCallCount: 0,
        finalAssistantText: 'Which package manager should I use?',
        finalAssistantTextTruncated: false,
        finalAssistantStopReason: 'stop',
      });
      expect(completion?.facts).toEqual(completion?.note?.facts);
      // A human reading the command sees it too, on stderr, without breaking the JSON on stdout.
      expect(listed.stderr).toContain('[note]');
      expect(listed.stderr).toContain('PROSE_QUESTION_NO_TOOL_USE');

      // The note is not a wait state and not an Attention while escalation is downgraded: the Task
      // state machine is untouched (FOUNDATION-056, now the explicit `record-only` mode).
      expect(status.task.state).toBe('RUNNING');
      const attention = await cli(['attention', 'list', projectId], environment);
      expect(attention.exitCode).toBe(0);
      expect(JSON.parse(attention.stdout)).toEqual([]);

      // The append-only completion event carries the same code, so the fact is auditable from the
      // event log a client already subscribes to.
      const log = await cli(['events', 'list', '--project', projectId, '--since', '0',
        '--limit', '500'], environment);
      expect(log.exitCode).toBe(0);
      const completed = (JSON.parse(log.stdout) as {
        readonly events: readonly EventEnvelopePayload[] }).events
        .filter((event) => event.eventType === 'AgentSessionCompleted');
      expect(completed).toHaveLength(1);
      expect(completed[0]?.payload).toMatchObject({
        outcome: 'SUCCESS', note: { code: 'PROSE_QUESTION_NO_TOOL_USE' } });

      // The run Operation keeps its own wording; the note is what stops that SUCCESS from being
      // unexplained. This asserts the honest limit of this lane rather than a new terminal state.
      const run = status.operations.find((operation) => operation.kind === 'RUN_TASK');
      expect(run?.result).toMatchObject({ code: 'AGENT_SETTLED' });

      // Unknown flags stay usage errors for scripts instead of being silently ignored.
      expect((await cli(['task', 'status', projectId, taskId, '--bogus'], environment)).exitCode)
        .toBe(2);
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);

  test('leaves a run that used a tool unannotated even when it ends with a question', async () => {
    const value = await fixture('TOOL_THEN_QUESTION');
    const { environment, projectId } = value;
    const taskId = await executedTask(value);
    try {
      const listed = await cli(['task', 'status', projectId, taskId, '--json'], environment);
      expect(listed.exitCode).toBe(0);
      const status = JSON.parse(listed.stdout) as TaskStatusPayload;
      const completion = status.executions[0]?.session?.completion;
      expect(completion?.outcome).toBe('SUCCESS');
      expect(completion?.note).toBeNull();
      // The facts are still recorded: a reader can see that the rule did not fire because a tool
      // was used, instead of having to guess.
      expect(completion?.facts?.toolCallCount).toBe(1);
      expect(listed.stderr).not.toContain('[note]');
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);
});
