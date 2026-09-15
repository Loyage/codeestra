import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  defaultProseQuestionAttentionMode,
  isProseQuestionAttentionMode,
  type ProseQuestionAttentionMode,
} from '@codeestra/domain';

/**
 * The one global switch for prose-question escalation (FOUNDATION-069 / ADR-0043).
 *
 * It is a *setting*, not a gate: it says how eagerly the Runtime acts on the FOUNDATION-056 note,
 * and changing it costs one command and no confirmation (ADR-0008/0011). It is stored next to the
 * permission mode, for the same reason — the Runtime must be able to read the same value after a
 * restart without a database migration, and the file is small enough to be human-editable.
 */
const persistedProseQuestionAttentionSchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(['auto', 'record-only', 'off']),
});

export function proseQuestionAttentionPath(runtimeHome: string): string {
  return join(runtimeHome, 'prose-question-attention.json');
}

/**
 * Reads the setting. An unreadable or invalid file is reported as an error rather than silently
 * ignored: the caller decides what to do about it, and it must be able to say so out loud.
 */
export async function readProseQuestionAttentionMode(
  runtimeHome: string,
): Promise<ProseQuestionAttentionMode> {
  const file = Bun.file(proseQuestionAttentionPath(runtimeHome));
  if (!await file.exists()) return defaultProseQuestionAttentionMode;
  const parsed = persistedProseQuestionAttentionSchema.safeParse(await file.json());
  if (!parsed.success) {
    throw new Error(`INVALID_PROSE_QUESTION_ATTENTION_SETTING: ${parsed.error.message}`);
  }
  return parsed.data.mode;
}

/** Atomic replacement keeps a crash from leaving a partially written setting. */
export function writeProseQuestionAttentionMode(
  runtimeHome: string,
  mode: ProseQuestionAttentionMode,
): void {
  if (!isProseQuestionAttentionMode(mode)) {
    throw new Error(`INVALID_PROSE_QUESTION_ATTENTION_SETTING: ${String(mode)}`);
  }
  mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  const target = proseQuestionAttentionPath(runtimeHome);
  const temporary = join(dirname(target),
    `.prose-question-attention-${process.pid}-${crypto.randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ version: 1, mode })}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}
