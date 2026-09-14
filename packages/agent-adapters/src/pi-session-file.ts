/**
 * Provider session-file facts (FOUNDATION-046 / ADR-0026).
 *
 * A handoff must be decided on structured facts, not on an exit code: FOUNDATION-040 measured that a
 * native TUI exits with code 0 both when the user releases it with Ctrl+D *and* when it is killed by
 * SIGTERM. The provider's own durable session file is the second half of that evidence — the file the
 * successor opens, the number of entries it holds and the entry ids that must still be there.
 *
 * This reader is deliberately small and bounded: it reads the beginning of one JSONL file up to a
 * byte cap and reports what it actually saw, including the fact that it saw only a prefix. It never
 * writes, never follows a path outside the file it was given, and never treats a partial read as a
 * complete history.
 */
export interface PiSessionFileFacts {
  /** The file the facts were read from, as given. */
  readonly file: string;
  readonly exists: boolean;
  readonly fileBytes: number;
  readonly bytesRead: number;
  /** Parsed JSON objects read from the file, in file order. */
  readonly entryCount: number;
  readonly lastEntryId: string | null;
  readonly entryIds: readonly string[];
  /** True when the file is larger than the read cap, so the facts describe a prefix only. */
  readonly truncated: boolean;
  readonly unparsableLines: number;
}

export const defaultSessionFileReadCapBytes = 16 * 1024 * 1024;

function entryIdOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export async function readPiSessionFileFacts(input: {
  readonly file: string;
  readonly maxBytes?: number;
  /** Collect every entry id (needed to prove a predecessor's last entry survived a handoff). */
  readonly collectEntryIds?: boolean;
}): Promise<PiSessionFileFacts> {
  const cap = input.maxBytes ?? defaultSessionFileReadCapBytes;
  const handle = Bun.file(input.file);
  if (!(await handle.exists())) {
    return { file: input.file, exists: false, fileBytes: 0, bytesRead: 0, entryCount: 0,
      lastEntryId: null, entryIds: [], truncated: false, unparsableLines: 0 };
  }
  const fileBytes = handle.size;
  const bytesRead = Math.min(fileBytes, cap);
  const text = await handle.slice(0, bytesRead).text();
  const lines = text.split('\n');
  // A trailing newline (or a partially read last line) must not be counted as an entry.
  const complete = fileBytes <= cap ? lines.length : lines.length - 1;
  const entryIds: string[] = [];
  let entryCount = 0;
  let lastEntryId: string | null = null;
  let unparsableLines = 0;
  for (let index = 0; index < complete; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      unparsableLines += 1;
      continue;
    }
    entryCount += 1;
    const id = entryIdOf(parsed);
    if (id !== null) {
      lastEntryId = id;
      if (input.collectEntryIds === true) entryIds.push(id);
    }
  }
  return { file: input.file, exists: true, fileBytes, bytesRead, entryCount, lastEntryId,
    entryIds, truncated: fileBytes > cap, unparsableLines };
}
