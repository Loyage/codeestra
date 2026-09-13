import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
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

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Transcript Test',
      GIT_AUTHOR_EMAIL: 'transcript@example.invalid', GIT_COMMITTER_NAME: 'Transcript Test',
      GIT_COMMITTER_EMAIL: 'transcript@example.invalid' } });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

const toolArguments = { path: 'greeting.txt', content: 'hi from task\n' };

/**
 * A protocol stub, not a real provider. It answers the RPC frames the Adapter sends and writes a
 * session file in the same shape Pi 0.84.4 writes, which is what the transcript view reads. It
 * proves the Runtime's read path; it is never evidence of a real Agent integration.
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
const sessionFile = join(sessionDir, 'stub-session-1.jsonl');
const records = [
  { type: 'session', version: 3, id: 'stub-session-1', timestamp: '2026-09-13T07:30:33.851Z',
    cwd: process.cwd() },
  { type: 'model_change', id: 'stub-model', parentId: null,
    timestamp: '2026-09-13T07:30:34.000Z', provider: 'stub-provider', modelId: 'stub-model-id' },
  { type: 'message', id: 'stub-user', parentId: 'stub-model',
    timestamp: '2026-09-13T07:30:34.105Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Codeestra revision stub-revision' }] } },
  { type: 'message', id: 'stub-assistant', parentId: 'stub-user',
    timestamp: '2026-09-13T07:30:35.594Z',
    message: { role: 'assistant', stopReason: 'toolUse', provider: 'stub-provider',
      model: 'stub-model-id',
      content: [
        { type: 'thinking', thinking: 'The task asks for a file.', thinkingSignature: 'sig' },
        { type: 'toolCall', id: 'stub-call-1', name: 'write',
          arguments: ${JSON.stringify(toolArguments)} },
      ],
      usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.001 } } } },
  { type: 'message', id: 'stub-tool-result', parentId: 'stub-assistant',
    timestamp: '2026-09-13T07:30:36.000Z',
    message: { role: 'toolResult', toolCallId: 'stub-call-1', toolName: 'write', isError: false,
      content: [{ type: 'text', text: 'Successfully wrote 13 bytes to greeting.txt' }] } },
  { type: 'message', id: 'stub-final', parentId: 'stub-tool-result',
    timestamp: '2026-09-13T07:30:37.000Z',
    message: { role: 'assistant', stopReason: 'stop',
      content: [{ type: 'text', text: 'Wrote greeting.txt and stopped.' }] } },
  { type: 'compaction', id: 'stub-compaction', parentId: 'stub-final',
    timestamp: '2026-09-13T07:30:38.000Z', summary: 'compacted' },
];
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
        sessionId: 'stub-session-1', sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      writeFileSync(sessionFile, records.map((entry) => JSON.stringify(entry)).join('\\n') + '\\n');
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Wrote greeting.txt and stopped.' }], stopReason: 'stop' } });
      emit({ type: 'agent_settled' });
    }
  }
}
`;

interface TranscriptPayload {
  readonly sessionId: string;
  readonly taskDisplayNumber: number;
  readonly fileAvailable: boolean;
  readonly note: string | null;
  readonly cursor: string | null;
  readonly hasMore: boolean;
  readonly unparsedLines: number;
  readonly entries: readonly {
    readonly entryId: string;
    readonly kind: string;
    readonly stopReason: string | null;
    readonly toolName: string | null;
    readonly isError: boolean | null;
    readonly usage: { readonly total: number | null; readonly cost: number | null } | null;
    readonly note: string | null;
    readonly parts: readonly {
      readonly partIndex: number; readonly type: string; readonly text: string;
      readonly truncated: boolean; readonly fullChars: number; readonly name: string | null;
    }[];
  }[];
}

interface PartPayload {
  readonly entryId: string;
  readonly partIndex: number;
  readonly text: string;
  readonly fullChars: number;
  readonly truncated: boolean;
}

/** Trusted temporary project, a stub provider, and one Task that ran a Session end to end. */
async function runOneTask(): Promise<{
  home: string; environment: Record<string, string>;
  projectId: string; taskId: string; sessionId: string;
}> {
  const repository = temporaryDirectory('codeestra-transcript-repo-');
  const home = temporaryDirectory('codeestra-transcript-home-');
  const tools = temporaryDirectory('codeestra-transcript-tools-');
  const assets = temporaryDirectory('codeestra-transcript-assets-');
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);

  // A shim executable keeps the production Adapter path untouched: the Runtime still launches
  // `pi <controlled argv>`, only the program behind that name is replaceable in a test.
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
    readonly { id: string }[];
  const projectId = projects[0]?.id as string;

  const created = JSON.parse((await cli(['task', 'create', projectId,
    'Create greeting.txt and stop'], environment)).stdout) as { readonly id: string };
  const taskId = created.id;
  const submitted = await cli(['task', 'submit', projectId, taskId, '0'], environment);
  expect(submitted.exitCode).toBe(0);
  const ran = await cli(['task', 'run', projectId, taskId, '1'], environment);
  expect(ran.exitCode).toBe(0);
  const sessionId = (JSON.parse(ran.stdout) as { readonly sessionId: string }).sessionId;

  const deadline = Date.now() + 30_000;
  let sessionState = '';
  while (Date.now() < deadline) {
    const status = JSON.parse((await cli(['task', 'status', projectId, taskId],
      environment)).stdout) as {
      readonly executions: readonly { readonly state: string;
        readonly session: { readonly state: string } | null }[];
    };
    sessionState = status.executions[0]?.session?.state ?? '';
    if (sessionState === 'EXITED') break;
    await Bun.sleep(50);
  }
  expect(sessionState).toBe('EXITED');
  return { home, environment, projectId, taskId, sessionId };
}

describe('codeestra transcript', () => {
  test('shows the Agent process step by step from the CLI and the Runtime command face', async () => {
    const { environment, projectId, taskId, sessionId } = await runOneTask();
    try {
      const view = JSON.parse((await cli(['task', 'transcript', projectId, taskId, '--json'],
        environment)).stdout) as TranscriptPayload;
      expect(view).toMatchObject({
        sessionId, taskDisplayNumber: 1, fileAvailable: true, note: null,
        unparsedLines: 0, hasMore: false, cursor: 'stub-compaction',
      });
      expect(view.entries.map((entry) => [entry.entryId, entry.kind])).toEqual([
        ['stub-model', 'MODEL_CHANGE'], ['stub-user', 'USER'], ['stub-assistant', 'ASSISTANT'],
        ['stub-tool-result', 'TOOL_RESULT'], ['stub-final', 'ASSISTANT'],
        ['stub-compaction', 'OTHER'],
      ]);
      const assistant = view.entries.find((entry) => entry.entryId === 'stub-assistant');
      expect(assistant).toMatchObject({ stopReason: 'toolUse', usage: { total: 30, cost: 0.001 } });
      // Thinking and the tool call are both visible; the reasoning signature is not.
      expect(assistant?.parts.map((part) => part.type)).toEqual(['THINKING', 'TOOL_CALL']);
      expect(assistant?.parts[1]).toMatchObject({ name: 'write', toolCallId: 'stub-call-1',
        truncated: false });
      expect(JSON.parse(assistant?.parts[1]?.text as string)).toEqual(toolArguments);
      const toolResult = view.entries.find((entry) => entry.entryId === 'stub-tool-result');
      expect(toolResult).toMatchObject({ toolName: 'write', isError: false });
      expect(toolResult?.parts[0]?.text).toContain('Successfully wrote');

      // The human rendering names the tool and prints its output, not just JSON.
      const readable = await cli(['task', 'transcript', projectId, taskId], environment);
      expect(readable.exitCode).toBe(0);
      expect(readable.stdout).toContain('TOOL_CALL write');
      expect(readable.stdout).toContain('Successfully wrote 13 bytes to greeting.txt');
      expect(readable.stdout).toContain('total=30');

      // Resuming with the returned cursor yields no duplicate and no skipped entry.
      const resumed = JSON.parse((await cli(['session', 'transcript', sessionId,
        '--after', 'stub-tool-result', '--json'], environment)).stdout) as TranscriptPayload;
      expect(resumed.entries.map((entry) => entry.entryId))
        .toEqual(['stub-final', 'stub-compaction']);
      expect(resumed.cursor).toBe('stub-compaction');

      // A whole content block is fetchable after a bounded list read.
      const part = JSON.parse((await cli(['session', 'transcript', 'part', sessionId,
        'stub-assistant', '1'], environment)).stdout) as PartPayload;
      expect(part).toMatchObject({ entryId: 'stub-assistant', partIndex: 1, truncated: false });
      expect(JSON.parse(part.text)).toEqual(toolArguments);
      expect(part.fullChars).toBe(part.text.length);

      const unknownSession = await cli(['session', 'transcript',
        '99999999-9999-4999-8999-999999999999', '--json'], environment);
      expect(unknownSession.exitCode).toBe(1);
      expect(unknownSession.stderr).toContain('NOT_FOUND');
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);

  test('refuses a recorded session file outside the Runtime session directory', async () => {
    const { home, environment, projectId, taskId, sessionId } = await runOneTask();
    // The Runtime is stopped first so the tampered row is what a fresh Runtime reads.
    await cli(['stop'], environment);
    const outside = temporaryDirectory('codeestra-transcript-outside-');
    const outsideFile = join(outside, 'stolen.jsonl');
    await Bun.write(outsideFile, '{"type":"session","id":"x"}\n');
    const database = new Database(join(home, 'runtime.sqlite'));
    try {
      database.run('UPDATE agent_sessions SET session_storage_ref=?1 WHERE id=?2',
        [outsideFile, sessionId]);
    } finally {
      database.close();
    }
    const refused = await cli(['task', 'transcript', projectId, taskId, '--json'], environment);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('SESSION_FILE_NOT_OWNED');
    expect(refused.stdout).toBe('');
    // The refused read never leaked the recorded path back to the client.
    expect(refused.stderr).not.toContain(outsideFile);
    await cli(['stop'], environment);
  }, 120_000);
});
