import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionTranscriptTarget } from '@codeestra/storage';
import { maxTranscriptPartChars } from '@codeestra/contracts';
import {
  ownedSessionFilePath,
  readSessionTranscript,
  readSessionTranscriptPart,
} from '../src/session-transcript-service.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

const longText = 'x'.repeat(5_000);

/** A realistic Pi 0.84.4 session file: header, model/thinking records, and a full tool round. */
const sessionRecords: readonly unknown[] = [
  { type: 'session', version: 3, id: 'session-1', timestamp: '2026-09-13T07:30:33.851Z', cwd: '/repo' },
  { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-09-13T07:30:34.000Z',
    provider: 'deepseek', modelId: 'deepseek-flash' },
  { type: 'thinking_level_change', id: 'm2', parentId: 'm1', timestamp: '2026-09-13T07:30:34.001Z',
    thinkingLevel: 'high' },
  { type: 'message', id: 'e1', parentId: 'm2', timestamp: '2026-09-13T07:30:34.105Z',
    message: { role: 'user', content: [{ type: 'text', text: 'Create greeting.txt' }] } },
  { type: 'message', id: 'e2', parentId: 'e1', timestamp: '2026-09-13T07:30:35.594Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Let me do this.', thinkingSignature: 'secret-signature' },
        { type: 'toolCall', id: 'call_1', name: 'write',
          arguments: { path: 'greeting.txt', content: 'hi\n' } },
      ],
      provider: 'deepseek',
      model: 'deepseek-flash',
      usage: { input: 1762, output: 89, cacheRead: 512, cacheWrite: 0, reasoning: 30,
        totalTokens: 2363, cost: { total: 0.000638472 } },
      stopReason: 'toolUse',
    } },
  { type: 'message', id: 'e3', parentId: 'e2', timestamp: '2026-09-13T07:31:36.741Z',
    message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'write',
      content: [{ type: 'text', text: 'Successfully wrote 17 bytes to greeting.txt' }],
      isError: false } },
  { type: 'message', id: 'e4', parentId: 'e3', timestamp: '2026-09-13T07:31:38.429Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' } },
  { type: 'message', id: 'e5', parentId: 'e4', timestamp: '2026-09-13T07:31:39.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: longText }],
      stopReason: 'stop' } },
  { type: 'compaction', id: 'c1', parentId: 'e5', timestamp: '2026-09-13T07:31:40.000Z',
    summary: 'compacted' },
];

function transcriptFixture(): { sessionDir: string; file: string; target: SessionTranscriptTarget } {
  const root = temporaryDirectory('codeestra-transcript-');
  const sessionDir = join(root, 'pi-sessions');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const file = join(sessionDir, '2026-09-13T07-30-33-851Z_session-1.jsonl');
  Bun.write(file, `${sessionRecords.map((record) => JSON.stringify(record)).join('\n')}\nnot json\n`);
  const target: SessionTranscriptTarget = {
    projectId: '10000000-0000-4000-8000-000000000001',
    taskId: '20000000-0000-4000-8000-000000000002',
    taskDisplayNumber: 7,
    executionId: '30000000-0000-4000-8000-000000000003',
    attemptNumber: 2,
    executionState: 'SUCCEEDED',
    sessionId: '40000000-0000-4000-8000-000000000004',
    sessionState: 'EXITED',
    providerSessionId: 'session-1',
    sessionStorageRef: file,
  };
  return { sessionDir, file, target };
}

describe('session transcript read', () => {
  test('normalizes user, assistant, tool, and provider-configuration records', async () => {
    const { sessionDir, target } = transcriptFixture();
    const view = await readSessionTranscript({ target, sessionDir, limit: 100 });
    expect(view).toMatchObject({
      sessionId: target.sessionId,
      taskDisplayNumber: 7,
      attemptNumber: 2,
      fileAvailable: true,
      // The file header is not an entry; the unparseable line is reported, not hidden.
      unparsedLines: 1,
      hasMore: false,
      cursor: 'c1',
    });
    expect(view.entries.map((entry) => [entry.entryId, entry.kind])).toEqual([
      ['m1', 'MODEL_CHANGE'], ['m2', 'THINKING_LEVEL_CHANGE'], ['e1', 'USER'], ['e2', 'ASSISTANT'],
      ['e3', 'TOOL_RESULT'], ['e4', 'ASSISTANT'], ['e5', 'ASSISTANT'], ['c1', 'OTHER'],
    ]);
    const [modelChange, thinkingChange, user, assistant, toolResult, final] = view.entries;
    expect(modelChange).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash' });
    expect(modelChange?.parts[0]).toMatchObject({ type: 'TEXT', text: 'deepseek/deepseek-flash' });
    expect(thinkingChange?.parts[0]).toMatchObject({ type: 'TEXT', text: 'high' });
    expect(user).toMatchObject({ role: 'user', parts: [{ type: 'TEXT', text: 'Create greeting.txt' }] });
    expect(assistant).toMatchObject({ role: 'assistant', stopReason: 'toolUse',
      provider: 'deepseek', model: 'deepseek-flash' });
    // The provider's reasoning signature is dropped; the reasoning text and the call survive.
    expect(assistant?.parts).toHaveLength(2);
    expect(assistant?.parts[0]).toMatchObject({ type: 'THINKING', text: 'Let me do this.' });
    expect(assistant?.parts[1]).toMatchObject({ type: 'TOOL_CALL', name: 'write',
      toolCallId: 'call_1' });
    expect(JSON.parse(assistant?.parts[1]?.text as string)).toEqual({
      path: 'greeting.txt', content: 'hi\n',
    });
    expect(assistant?.usage).toEqual({ input: 1762, output: 89, cacheRead: 512, cacheWrite: 0,
      reasoning: 30, total: 2363, cost: 0.000638472 });
    expect(toolResult).toMatchObject({ kind: 'TOOL_RESULT', toolName: 'write',
      toolCallId: 'call_1', isError: false });
    expect(toolResult?.parts[0]).toMatchObject({ type: 'TEXT',
      text: 'Successfully wrote 17 bytes to greeting.txt' });
    // A text-only assistant message has no usage block, so no numbers are invented.
    expect(final).toMatchObject({ stopReason: 'stop', usage: null });
    // Unknown record types are surfaced instead of silently dropped.
    expect(view.entries.at(-1)?.note).toContain('compaction');
  });

  test('pages with an exclusive entry cursor and reports more data honestly', async () => {
    const { sessionDir, target } = transcriptFixture();
    const first = await readSessionTranscript({ target, sessionDir, limit: 2 });
    expect(first.entries.map((entry) => entry.entryId)).toEqual(['m1', 'm2']);
    expect(first.hasMore).toBe(true);
    const second = await readSessionTranscript({ target, sessionDir, limit: 2,
      afterEntryId: first.cursor as string });
    // The cursor entry itself is not repeated: resume neither skips nor duplicates.
    expect(second.entries.map((entry) => entry.entryId)).toEqual(['e1', 'e2']);
    const third = await readSessionTranscript({ target, sessionDir, limit: 100,
      afterEntryId: second.cursor as string });
    expect(third.entries.map((entry) => entry.entryId)).toEqual(['e3', 'e4', 'e5', 'c1']);
    // No entry follows the last one, so a client can stop polling.
    expect(third.hasMore).toBe(false);
  });

  test('truncates long parts in the list and returns the identical text on demand', async () => {
    const { sessionDir, target } = transcriptFixture();
    const view = await readSessionTranscript({ target, sessionDir, limit: 100, previewChars: 10 });
    const longPart = view.entries.find((entry) => entry.entryId === 'e5')?.parts[0];
    expect(longPart).toMatchObject({ partIndex: 0, type: 'TEXT', text: 'x'.repeat(10),
      truncated: true, fullChars: longText.length });
    const whole = await readSessionTranscriptPart({ target, sessionDir, entryId: 'e5', partIndex: 0 });
    expect(whole.text).toBe(longText);
    expect(whole).toMatchObject({ entryId: 'e5', partIndex: 0, type: 'TEXT', name: null,
      fullChars: longText.length, truncated: false });
    // A short part fetches to exactly what the list already showed.
    const short = await readSessionTranscriptPart({ target, sessionDir, entryId: 'e4', partIndex: 0 });
    expect(short.text).toBe('Done.');
  });

  test('reports a block cut by the part cap with its real length', async () => {
    const { sessionDir, file, target } = transcriptFixture();
    const huge = 'y'.repeat(maxTranscriptPartChars + 500);
    const records = [{ type: 'message', id: 'huge-1', parentId: null,
      timestamp: '2026-09-13T07:00:00.000Z',
      message: { role: 'toolResult', toolName: 'bash', isError: false,
        content: [{ type: 'text', text: huge }] } }];
    Bun.write(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const part = await readSessionTranscriptPart({
      target, sessionDir, entryId: 'huge-1', partIndex: 0,
    });
    // The client must be able to tell that even the whole-part fetch was cut.
    expect(part).toMatchObject({ truncated: true, fullChars: huge.length });
    expect(part.text.length).toBe(maxTranscriptPartChars);
  });

  test('refuses an unknown cursor instead of clamping to the tail', async () => {
    const { sessionDir, target } = transcriptFixture();
    await expect(readSessionTranscript({ target, sessionDir, limit: 10, afterEntryId: 'nope' }))
      .rejects.toMatchObject({ code: 'TRANSCRIPT_CURSOR_UNKNOWN' });
  });

  test('reports unknown entries and part indexes explicitly', async () => {
    const { sessionDir, target } = transcriptFixture();
    await expect(readSessionTranscriptPart({ target, sessionDir, entryId: 'missing', partIndex: 0 }))
      .rejects.toMatchObject({ code: 'TRANSCRIPT_ENTRY_UNKNOWN' });
    await expect(readSessionTranscriptPart({ target, sessionDir, entryId: 'e4', partIndex: 3 }))
      .rejects.toMatchObject({ code: 'TRANSCRIPT_PART_UNKNOWN' });
  });

  test('reports a missing or unrecorded session file without pretending to have content', async () => {
    const { sessionDir, target } = transcriptFixture();
    const missing = await readSessionTranscript({
      target: { ...target, sessionStorageRef: join(sessionDir, 'not-there.jsonl') },
      sessionDir, limit: 10,
    });
    expect(missing).toMatchObject({ fileAvailable: false, entries: [] });
    expect(missing.note).toContain('会话文件不存在');

    const unrecorded = await readSessionTranscript({
      target: { ...target, sessionStorageRef: null }, sessionDir, limit: 10,
    });
    expect(unrecorded).toMatchObject({ fileAvailable: false, entries: [] });
    expect(unrecorded.note).toContain('没有记录会话文件路径');

    await expect(readSessionTranscriptPart({
      target: { ...target, sessionStorageRef: null }, sessionDir, entryId: 'e4', partIndex: 0,
    })).rejects.toMatchObject({ code: 'SESSION_FILE_UNREADABLE' });
  });

  test('refuses to read a file outside the Runtime session directory', async () => {
    const { sessionDir, target } = transcriptFixture();
    const outsideRoot = temporaryDirectory('codeestra-outside-');
    const outside = join(outsideRoot, 'session.jsonl');
    Bun.write(outside, '{}\n');
    await expect(readSessionTranscript({
      target: { ...target, sessionStorageRef: outside }, sessionDir, limit: 10,
    })).rejects.toMatchObject({ code: 'SESSION_FILE_NOT_OWNED' });

    // A symlink inside the owned directory must not be usable to escape it.
    const link = join(sessionDir, 'escape.jsonl');
    symlinkSync(outside, link);
    await expect(readSessionTranscript({
      target: { ...target, sessionStorageRef: link }, sessionDir, limit: 10,
    })).rejects.toMatchObject({ code: 'SESSION_FILE_NOT_OWNED' });

    // A directory that is not a regular file is refused too.
    await expect(readSessionTranscript({
      target: { ...target, sessionStorageRef: sessionDir }, sessionDir, limit: 10,
    })).rejects.toMatchObject({ code: 'SESSION_FILE_NOT_OWNED' });
  });

  test('accepts an owned file when the configured directory is behind a symlink', () => {
    const root = temporaryDirectory('codeestra-symlink-root-');
    const realDir = join(root, 'real');
    mkdirSync(realDir, { recursive: true });
    const linkedDir = join(root, 'linked');
    symlinkSync(realDir, linkedDir);
    const file = join(realDir, 'session.jsonl');
    Bun.write(file, '{}\n');
    // The configured directory and the recorded path may name the same directory through
    // different aliases; ownership is decided on the resolved path, not on the string.
    expect(ownedSessionFilePath(linkedDir, file)).toBe(realpathSync(file));
    expect(ownedSessionFilePath(linkedDir, join(linkedDir, 'session.jsonl')))
      .toBe(realpathSync(file));
    expect(ownedSessionFilePath(realDir, join(linkedDir, 'session.jsonl'))).toBe(realpathSync(file));
    // A file that does not exist yet is reported as absent, not as an ownership violation.
    expect(ownedSessionFilePath(linkedDir, join(linkedDir, 'later.jsonl'))).toBeNull();
  });
});
