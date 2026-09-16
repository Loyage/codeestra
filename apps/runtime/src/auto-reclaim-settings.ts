import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * The one global switch for automatic task-worktree reclamation after a successful integration
 * (ADR-0062).
 *
 * It lives next to the permission mode and the prose-question switch rather than in the database:
 * the Runtime has to be able to read it before any migration decision, it is one word that is
 * usefully edited by hand, and a schema migration would buy nothing. It is a *setting*, not a gate:
 * turning it off costs one command and no confirmation, and the explicit `reclaim` command keeps
 * working either way.
 *
 * Three rules, the same ones the neighbouring settings files follow:
 *
 * 1. **Closed and versioned.** An unknown key, a non-boolean value or a different version is a hard
 *    error naming the file. Nothing is silently repaired or defaulted.
 * 2. **Atomic replacement.** The new content goes to a temp file in the same directory and is
 *    renamed over the target, so a crash leaves either the old file or the new one.
 * 3. **Read at startup, held for the boot.** Like the prose-question switch, the Runtime reads it
 *    once while booting and updates the in-memory value on `settings auto-reclaim`. The file is the
 *    durable record; an edit made by hand while the Runtime is up is served on the next start.
 */
const persistedAutoReclaimSchema = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
});

/** The product default: a completed, merged, clean worktree is reclaimed without a separate command. */
export const defaultAutoReclaimEnabled = true;

/** The stable code this feature refuses with; surfaced verbatim by the command face. */
export type AutoReclaimSettingsErrorCode = 'INVALID_AUTO_RECLAIM_SETTING';

export class AutoReclaimSettingsError extends Error {
  constructor(readonly code: AutoReclaimSettingsErrorCode, message: string) {
    super(message);
    this.name = 'AutoReclaimSettingsError';
  }
}

export function autoReclaimPath(runtimeHome: string): string {
  return join(runtimeHome, 'auto-reclaim.json');
}

/**
 * Reads the switch. A missing file is not an error — it is the product default. A file that cannot
 * be parsed is reported as an error instead of being masked by the default, so the caller can say
 * out loud that the recorded value could not be honoured.
 */
export async function readAutoReclaimEnabled(runtimeHome: string): Promise<boolean> {
  const file = Bun.file(autoReclaimPath(runtimeHome));
  if (!await file.exists()) return defaultAutoReclaimEnabled;
  try {
    const parsed = persistedAutoReclaimSchema.safeParse(await file.json());
    if (!parsed.success) {
      throw new AutoReclaimSettingsError('INVALID_AUTO_RECLAIM_SETTING',
        `the auto-reclaim setting file ${autoReclaimPath(runtimeHome)} is not readable:`
        + ` ${parsed.error.message}`);
    }
    return parsed.data.enabled;
  } catch (error) {
    if (error instanceof AutoReclaimSettingsError) throw error;
    throw new AutoReclaimSettingsError('INVALID_AUTO_RECLAIM_SETTING',
      `the auto-reclaim setting file ${autoReclaimPath(runtimeHome)} is not valid JSON:`
      + ` ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Atomic replacement keeps a crash from leaving a partially written setting. */
export function writeAutoReclaimEnabled(runtimeHome: string, enabled: boolean): void {
  if (typeof enabled !== 'boolean') {
    throw new AutoReclaimSettingsError('INVALID_AUTO_RECLAIM_SETTING',
      `INVALID_AUTO_RECLAIM_SETTING: ${String(enabled)}`);
  }
  mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  const target = autoReclaimPath(runtimeHome);
  const temporary = join(dirname(target),
    `.auto-reclaim-${process.pid}-${crypto.randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ version: 1, enabled })}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}
