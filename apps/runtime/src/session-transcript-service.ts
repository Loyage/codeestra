import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import {
  maxTranscriptPartChars,
  transcriptPartPreviewChars,
  type SessionTranscriptEntry,
  type SessionTranscriptPart,
  type SessionTranscriptPartView,
  type SessionTranscriptUsage,
  type SessionTranscriptView,
} from '@codeestra/contracts';
import type { SessionTranscriptTarget } from '@codeestra/storage';

/**
 * A transcript read is a *view* over the provider's own durable session file. It is deliberately
 * not an event, not a domain fact, and not delivery evidence: nothing is written to SQLite, no
 * Task/Execution state is derived from it, and the provider file path never leaves the Runtime.
 *
 * Codes are stable so a client can react instead of parsing messages:
 * - `SESSION_FILE_NOT_OWNED`     the recorded path is not a regular file inside the session dir
 * - `SESSION_FILE_UNREADABLE`    the file exists but could not be read in this process
 * - `TRANSCRIPT_CURSOR_UNKNOWN`  the resume cursor is not in the file (never silently clamped)
 * - `TRANSCRIPT_ENTRY_UNKNOWN`   the requested entry is not in the file
 * - `TRANSCRIPT_PART_UNKNOWN`    the entry has no content block at that index
 */
export class SessionTranscriptError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SessionTranscriptError';
  }
}

type OpenResult =
  | { readonly kind: 'READABLE'; readonly path: string }
  | { readonly kind: 'UNAVAILABLE'; readonly note: string };

/**
 * Confirms that `ref` is a regular file inside the Runtime's own Pi session directory.
 *
 * Ownership is decided on the fully resolved path, never on the recorded string: that keeps a
 * symlinked ancestor of the configured directory (macOS `/tmp` → `/private/tmp`) working while a
 * symlink placed inside the directory still cannot be used to escape it. Returns `null` when the
 * file does not exist yet, which the caller reports as "no durable session file", not as an error.
 */
export function ownedSessionFilePath(sessionDir: string, ref: string): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(sessionDir);
  } catch {
    throw new SessionTranscriptError('SESSION_FILE_NOT_OWNED',
      `The Runtime Pi session directory ${sessionDir} does not exist, so no session file is owned`);
  }
  let real: string;
  try {
    real = realpathSync(resolve(ref));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SessionTranscriptError('SESSION_FILE_UNREADABLE',
      `The Agent session file could not be resolved: ${errorText(error)}`);
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new SessionTranscriptError('SESSION_FILE_NOT_OWNED',
      'The recorded Agent session file is outside the Runtime Pi session directory');
  }
  let stats;
  try {
    stats = statSync(real);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SessionTranscriptError('SESSION_FILE_UNREADABLE',
      `The Agent session file could not be inspected: ${errorText(error)}`);
  }
  if (!stats.isFile()) {
    throw new SessionTranscriptError('SESSION_FILE_NOT_OWNED',
      'The recorded Agent session path is not a regular file');
  }
  return real;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openSessionFile(target: SessionTranscriptTarget, sessionDir: string): OpenResult {
  if (target.sessionStorageRef === null || target.sessionStorageRef.trim().length === 0) {
    return { kind: 'UNAVAILABLE', note: 'Agent Session 没有记录会话文件路径'
      + '（Pi 只在产生第一条持久消息后才会写文件），因此没有可显示的执行过程。' };
  }
  const path = ownedSessionFilePath(sessionDir, target.sessionStorageRef);
  if (path === null || !existsSync(path)) {
    return { kind: 'UNAVAILABLE', note: 'Pi 的会话文件不存在或已被删除，无法显示执行过程。' };
  }
  return { kind: 'READABLE', path };
}

/** Yields the provider file line by line, so a caller can stop early without reading the rest. */
async function* sessionLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } catch (error) {
    throw new SessionTranscriptError('SESSION_FILE_UNREADABLE',
      `The Agent session file could not be read: ${errorText(error)}`);
  } finally {
    lines.close();
    stream.destroy();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Finds one entry by its provider ID, reading no further once it is found. */
async function findSessionEntry(
  path: string,
  entryId: string,
): Promise<SessionTranscriptEntry | null> {
  for await (const line of sessionLines(path)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed['id'] !== entryId) continue;
    return normalizeSessionEntry(parsed, maxTranscriptPartChars);
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundedText(text: string, maxChars: number): {
  readonly text: string; readonly truncated: boolean; readonly fullChars: number;
} {
  if (text.length <= maxChars) return { text, truncated: false, fullChars: text.length };
  return { text: text.slice(0, maxChars), truncated: true, fullChars: text.length };
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

interface RawPart {
  readonly type: SessionTranscriptPart['type'];
  readonly text: string;
  readonly name: string | null;
  readonly toolCallId: string | null;
}

/**
 * Renders one provider content block to text. The preview and the whole-part fetch both go through
 * this function, so a client that expands a truncated block sees exactly the same bytes it saw a
 * prefix of.
 */
function rawPart(block: unknown): RawPart {
  if (typeof block === 'string') {
    return { type: 'TEXT', text: block, name: null, toolCallId: null };
  }
  if (!isRecord(block)) {
    return { type: 'OTHER', text: safeJson(block), name: null, toolCallId: null };
  }
  const blockType = typeof block['type'] === 'string' ? block['type'] : 'unknown';
  if (blockType === 'text') {
    return { type: 'TEXT', text: typeof block['text'] === 'string' ? block['text'] : '',
      name: null, toolCallId: null };
  }
  if (blockType === 'thinking') {
    // `thinkingSignature` is a provider artifact used to replay reasoning; it is not shown.
    return { type: 'THINKING', text: typeof block['thinking'] === 'string' ? block['thinking'] : '',
      name: null, toolCallId: null };
  }
  if (blockType === 'toolCall') {
    return {
      type: 'TOOL_CALL',
      text: safeJson(block['arguments'] ?? null),
      name: typeof block['name'] === 'string' ? block['name'] : null,
      toolCallId: typeof block['id'] === 'string' ? block['id'] : null,
    };
  }
  if (blockType === 'image') {
    const mimeType = typeof block['mimeType'] === 'string' ? block['mimeType'] : 'unknown';
    return { type: 'IMAGE', text: `[image ${mimeType}]`, name: null, toolCallId: null };
  }
  return { type: 'OTHER', text: safeJson(block), name: null, toolCallId: null };
}

function rawParts(content: unknown): readonly RawPart[] {
  if (Array.isArray(content)) return content.map((block) => rawPart(block));
  if (content === undefined || content === null) return [];
  return [rawPart(content)];
}

function boundedParts(raw: readonly RawPart[], previewChars: number): readonly SessionTranscriptPart[] {
  return raw.map((part, partIndex) => {
    const bounded = boundedText(part.text, previewChars);
    return {
      partIndex,
      type: part.type,
      text: bounded.text,
      truncated: bounded.truncated,
      fullChars: bounded.fullChars,
      name: part.name,
      toolCallId: part.toolCallId,
    };
  });
}

function usageOf(message: Record<string, unknown>): SessionTranscriptUsage | null {
  const usage = message['usage'];
  if (!isRecord(usage)) return null;
  const cost = isRecord(usage['cost']) ? finiteNumber(usage['cost']['total']) : null;
  return {
    input: finiteNumber(usage['input']),
    output: finiteNumber(usage['output']),
    cacheRead: finiteNumber(usage['cacheRead']),
    cacheWrite: finiteNumber(usage['cacheWrite']),
    reasoning: finiteNumber(usage['reasoning']),
    total: finiteNumber(usage['total']) ?? finiteNumber(usage['totalTokens']),
    cost,
  };
}

function kindForRole(role: string | null): SessionTranscriptEntry['kind'] | null {
  if (role === 'user') return 'USER';
  if (role === 'assistant') return 'ASSISTANT';
  if (role === 'toolResult') return 'TOOL_RESULT';
  return null;
}

/**
 * Normalizes one session-file record. Returns `null` for the file header and for records this view
 * does not render as entries (they are counted separately rather than silently dropped).
 */
export function normalizeSessionEntry(
  record: Record<string, unknown>,
  previewChars: number = transcriptPartPreviewChars,
): SessionTranscriptEntry | null {
  const entryId = typeof record['id'] === 'string' ? record['id'] : null;
  const type = typeof record['type'] === 'string' ? record['type'] : null;
  if (type === 'session') return null;
  if (entryId === null || type === null) return null;
  const base = {
    entryId,
    parentId: typeof record['parentId'] === 'string' ? record['parentId'] : null,
    timestamp: typeof record['timestamp'] === 'string' ? record['timestamp'] : null,
  };
  if (type === 'model_change') {
    const provider = typeof record['provider'] === 'string' ? record['provider'] : null;
    const model = typeof record['modelId'] === 'string' ? record['modelId'] : null;
    return { ...base, kind: 'MODEL_CHANGE', role: null, provider, model, stopReason: null,
      toolName: null, toolCallId: null, isError: null, usage: null, note: null,
      parts: boundedParts([{ type: 'TEXT', text: `${provider ?? 'unknown'}/${model ?? 'unknown'}`,
        name: null, toolCallId: null }], previewChars) };
  }
  if (type === 'thinking_level_change') {
    const level = typeof record['thinkingLevel'] === 'string' ? record['thinkingLevel'] : 'unknown';
    return { ...base, kind: 'THINKING_LEVEL_CHANGE', role: null, provider: null, model: null,
      stopReason: null, toolName: null, toolCallId: null, isError: null, usage: null, note: null,
      parts: boundedParts([{ type: 'TEXT', text: level, name: null, toolCallId: null }], previewChars) };
  }
  if (type !== 'message') {
    return { ...base, kind: 'OTHER', role: null, provider: null, model: null, stopReason: null,
      toolName: null, toolCallId: null, isError: null, usage: null,
      note: `未识别的会话条目类型：${type}`,
      parts: boundedParts([{ type: 'OTHER', text: safeJson(record), name: null, toolCallId: null }],
        previewChars) };
  }
  const message = record['message'];
  if (!isRecord(message)) {
    return { ...base, kind: 'OTHER', role: null, provider: null, model: null, stopReason: null,
      toolName: null, toolCallId: null, isError: null, usage: null,
      note: '会话条目缺少可识别的 message 对象',
      parts: boundedParts([{ type: 'OTHER', text: safeJson(record), name: null, toolCallId: null }],
        previewChars) };
  }
  const role = typeof message['role'] === 'string' ? message['role'] : null;
  const kind = kindForRole(role);
  const content = rawParts(message['content']);
  if (kind === null) {
    return { ...base, kind: 'OTHER', role, provider: null, model: null, stopReason: null,
      toolName: null, toolCallId: null, isError: null, usage: null,
      note: `未识别的消息角色：${role ?? '（缺失）'}`, parts: boundedParts(content, previewChars) };
  }
  const isError = typeof message['isError'] === 'boolean' ? message['isError'] : null;
  return {
    ...base,
    kind,
    role,
    provider: typeof message['provider'] === 'string' ? message['provider'] : null,
    model: typeof message['model'] === 'string' ? message['model'] : null,
    stopReason: typeof message['stopReason'] === 'string' ? message['stopReason'] : null,
    toolName: typeof message['toolName'] === 'string' ? message['toolName'] : null,
    toolCallId: typeof message['toolCallId'] === 'string' ? message['toolCallId'] : null,
    isError,
    usage: kind === 'ASSISTANT' ? usageOf(message) : null,
    parts: boundedParts(content, previewChars),
    note: null,
  };
}

function baseView(
  target: SessionTranscriptTarget,
  overrides: Partial<SessionTranscriptView>,
): SessionTranscriptView {
  return {
    sessionId: target.sessionId,
    executionId: target.executionId,
    projectId: target.projectId,
    taskId: target.taskId,
    taskDisplayNumber: target.taskDisplayNumber,
    attemptNumber: target.attemptNumber,
    executionState: target.executionState,
    sessionState: target.sessionState,
    providerSessionId: target.providerSessionId,
    fileAvailable: true,
    note: null,
    entries: [],
    cursor: null,
    hasMore: false,
    unparsedLines: 0,
    partPreviewChars: transcriptPartPreviewChars,
    ...overrides,
  };
}

/**
 * Reads one window of a Session transcript. `afterEntryId` is an exclusive cursor over the file's
 * own entry order; an unknown cursor is reported instead of being clamped to the tail, so a client
 * never silently shows a different region than it asked for.
 */
export async function readSessionTranscript(input: {
  readonly target: SessionTranscriptTarget;
  readonly sessionDir: string;
  readonly afterEntryId?: string;
  readonly limit: number;
  readonly previewChars?: number;
}): Promise<SessionTranscriptView> {
  const previewChars = input.previewChars ?? transcriptPartPreviewChars;
  const opened = openSessionFile(input.target, input.sessionDir);
  if (opened.kind === 'UNAVAILABLE') {
    return baseView(input.target, {
      fileAvailable: false,
      note: opened.note,
      cursor: input.afterEntryId ?? null,
      partPreviewChars: previewChars,
    });
  }
  const entries: SessionTranscriptEntry[] = [];
  let unparsedLines = 0;
  let foundCursor = input.afterEntryId === undefined;
  let hasMore = false;
  for await (const line of sessionLines(opened.path)) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unparsedLines += 1;
      continue;
    }
    if (!isRecord(parsed)) {
      unparsedLines += 1;
      continue;
    }
    const entry = normalizeSessionEntry(parsed, previewChars);
    if (entry === null) {
      // The file header is not an entry; any other id-less record is a real data problem.
      if (parsed['type'] !== 'session') unparsedLines += 1;
      continue;
    }
    if (!foundCursor) {
      if (entry.entryId === input.afterEntryId) foundCursor = true;
      continue;
    }
    if (entries.length >= input.limit) {
      hasMore = true;
      break;
    }
    entries.push(entry);
  }
  if (!foundCursor) {
    throw new SessionTranscriptError('TRANSCRIPT_CURSOR_UNKNOWN',
      'The transcript cursor is not in this session file; re-read it from the beginning');
  }
  return baseView(input.target, {
    entries,
    cursor: entries.at(-1)?.entryId ?? input.afterEntryId ?? null,
    hasMore,
    unparsedLines,
    partPreviewChars: previewChars,
  });
}

/**
 * Returns one whole content block. The list read bounds every part so a response stays small; this
 * is how a client expands a part that was reported as truncated. `maxTranscriptPartChars` still
 * caps the response, and `truncated` then says the block itself was cut.
 */
export async function readSessionTranscriptPart(input: {
  readonly target: SessionTranscriptTarget;
  readonly sessionDir: string;
  readonly entryId: string;
  readonly partIndex: number;
}): Promise<SessionTranscriptPartView> {
  const opened = openSessionFile(input.target, input.sessionDir);
  if (opened.kind === 'UNAVAILABLE') {
    throw new SessionTranscriptError('SESSION_FILE_UNREADABLE', opened.note);
  }
  const found = await findSessionEntry(opened.path, input.entryId);
  if (found === null) {
    throw new SessionTranscriptError('TRANSCRIPT_ENTRY_UNKNOWN',
      'That entry is not in this session file');
  }
  const part = found.parts.find((candidate: SessionTranscriptPart) =>
    candidate.partIndex === input.partIndex);
  if (part === undefined) {
    throw new SessionTranscriptError('TRANSCRIPT_PART_UNKNOWN',
      'That entry has no content block at that index');
  }
  // `normalizeSessionEntry` already applied the part cap, and `fullChars`/`truncated` describe the
  // block's real length rather than the returned slice, so a client can say "this was cut".
  return {
    sessionId: input.target.sessionId,
    entryId: input.entryId,
    partIndex: part.partIndex,
    type: part.type,
    name: part.name,
    toolCallId: part.toolCallId,
    text: part.text,
    fullChars: part.fullChars,
    truncated: part.truncated,
  };
}
