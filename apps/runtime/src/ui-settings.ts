import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  isUiSettingKey,
  isValidUiSettingValue,
  uiSettingDefaults,
  uiSettingKeys,
  uiSettingsViewSchema,
  uiSettingValues,
  type UiSettingKey,
  type UiSettingValue,
  type UiSettingsView,
} from '@codeestra/contracts';

/**
 * The interface-effect settings file (FOUNDATION-073 / ADR-0045).
 *
 * It lives in the Runtime home next to the permission mode and the prose-question switch, and it
 * stays out of the database for the same reason those two do: it is a handful of words that the
 * Runtime must be able to read before any migration decision, it is usefully editable by hand, and
 * a schema migration would buy nothing. It is *not* browser storage: the value must survive a
 * different browser, a cleared cache and a Runtime restart, and `codeestra settings ui …` must read
 * back exactly what the UI shows.
 *
 * Three rules, all of them load-bearing:
 *
 * 1. **Closed and versioned.** A strict schema with a version literal: an unknown key, a value
 *    outside the enumeration, or a different version is a hard error naming the file. Nothing is
 *    silently repaired, dropped or defaulted — a settings file that says something we do not
 *    understand must never be quietly rewritten into one we do.
 * 2. **Atomic replacement.** The new content is written to a temp file in the same directory and
 *    renamed over the target, so a crash or a full disk leaves either the old file or the new one,
 *    never half of either. The file is 0600 and its directory 0700 (ADR-0004).
 * 3. **Disk is the truth.** Every read goes to the file rather than to a cached copy, so an edit
 *    made outside the Runtime, or a second Runtime home, cannot be served stale values. The file is
 *    a few hundred bytes, so this costs nothing measurable.
 */
const persistedUiSettingsSchema = z.strictObject({
  version: z.literal(1),
  settings: z.strictObject({
    theme: z.enum(uiSettingValues.theme).optional(),
    density: z.enum(uiSettingValues.density).optional(),
    fontSize: z.enum(uiSettingValues.fontSize).optional(),
    motion: z.enum(uiSettingValues.motion).optional(),
    timeDisplay: z.enum(uiSettingValues.timeDisplay).optional(),
  }),
});

type StoredUiSettings = z.infer<typeof persistedUiSettingsSchema>['settings'];

/** The stable codes this feature refuses with; all are surfaced verbatim by the command face. */
export type UiSettingsErrorCode =
  | 'INVALID_UI_SETTING'
  | 'UNKNOWN_UI_SETTING'
  | 'UI_SETTINGS_WRITE_FAILED';

/**
 * A refusal that carries its own code, so the socket and HTTP transports can report it without
 * parsing prose (the same convention every other Runtime refusal uses).
 */
export class UiSettingsError extends Error {
  constructor(readonly code: UiSettingsErrorCode, message: string) {
    super(message);
    this.name = 'UiSettingsError';
  }
}

export function uiSettingsPath(runtimeHome: string): string {
  return join(runtimeHome, 'ui-settings.json');
}

/** How to recover from an unreadable file: never guessed at, always named in the refusal. */
function recoveryHint(): string {
  return 'Fix or delete the file by hand, or drop every explicit choice with'
    + ' `codeestra settings ui reset` (which rewrites it from scratch)';
}

/**
 * Reads the stored choices. A missing file is not an error — it is an empty set of choices, which
 * is exactly the state of a fresh Runtime home. Anything else that cannot be trusted is an error.
 */
function readStoredSettings(runtimeHome: string): StoredUiSettings {
  const file = uiSettingsPath(runtimeHome);
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    throw new UiSettingsError('INVALID_UI_SETTING',
      `${file} is not readable JSON (${error instanceof Error ? error.message : String(error)}).`
      + ` ${recoveryHint()}`);
  }
  const parsed = persistedUiSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    // One line per problem: a hand-edited file is a person's file, and a person needs to be told
    // which key is wrong rather than handed a serialized issue tree.
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new UiSettingsError('INVALID_UI_SETTING',
      `${file} is not a version 1 settings file — ${problems}. ${recoveryHint()}`);
  }
  return parsed.data.settings;
}

/**
 * Atomic, user-only replacement: temp file in the same directory, then rename over the target.
 *
 * A write that fails for any reason (permission, a full disk, the target being a directory) reports
 * a stable code, removes its own temp file, and leaves whatever was there before untouched — the
 * temp-and-rename pair is what makes "either the old file or the new one" true rather than hopeful.
 */
function writeStoredSettings(runtimeHome: string, settings: StoredUiSettings): void {
  const target = uiSettingsPath(runtimeHome);
  const temporary = join(dirname(target), `.ui-settings-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
    // Pretty-printed on purpose: this file is meant to be readable and editable by a person.
    writeFileSync(temporary, `${JSON.stringify({ version: 1, settings }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* Nothing more this layer can do. */ }
    throw new UiSettingsError('UI_SETTINGS_WRITE_FAILED',
      `${target} could not be written (${error instanceof Error ? error.message : String(error)});`
      + ' the previous file is unchanged');
  }
}

/**
 * The settings face. Every key is always present, in a fixed order, with the effective value, the
 * product default, the accepted values and where the effective value came from.
 */
function toView(runtimeHome: string, settings: StoredUiSettings): UiSettingsView {
  return uiSettingsViewSchema.parse({
    store: 'RUNTIME_FILE',
    file: uiSettingsPath(runtimeHome),
    appliesTo: 'Every Web UI session served by this Runtime home; a browser that clears its cache'
      + ' or a different browser still reads these values from the Runtime',
    settings: uiSettingKeys.map((key) => {
      const stored: UiSettingValue | undefined = settings[key];
      const value = stored ?? uiSettingDefaults[key];
      return {
        key,
        value,
        default: uiSettingDefaults[key],
        values: [...uiSettingValues[key]],
        explicit: stored !== undefined,
        source: stored === undefined ? 'PRODUCT_DEFAULT' : 'RUNTIME',
      };
    }),
  });
}

/** Reads every key. Throws `INVALID_UI_SETTING` rather than reporting defaults for a broken file. */
export function inspectUiSettings(runtimeHome: string): UiSettingsView {
  return toView(runtimeHome, readStoredSettings(runtimeHome));
}

/**
 * Writes one key and reports the resulting whole settings face.
 *
 * A broken existing file is deliberately *not* merged into: merging would mean discarding the parts
 * of it we did not understand, which is the silent rewrite rule 1 forbids. `reset` is the explicit
 * way out.
 */
export function setUiSetting(
  runtimeHome: string,
  key: UiSettingKey | string,
  value: UiSettingValue | string,
): UiSettingsView {
  if (!isUiSettingKey(key)) {
    throw new UiSettingsError('UNKNOWN_UI_SETTING',
      `${String(key)} is not a UI setting; the keys are: ${uiSettingKeys.join(', ')}`);
  }
  if (!isValidUiSettingValue(key, value)) {
    throw new UiSettingsError('INVALID_UI_SETTING',
      `${String(value)} is not a valid value for ${key}; the values are:`
      + ` ${(uiSettingValues[key] as readonly string[]).join(', ')}`);
  }
  const next: StoredUiSettings = { ...readStoredSettings(runtimeHome) };
  // `isValidUiSettingValue` has already proven that this value belongs to this key; TypeScript
  // cannot follow that correlation through a union index signature, so the write is per key.
  switch (key) {
    case 'theme': next.theme = value as StoredUiSettings['theme']; break;
    case 'density': next.density = value as StoredUiSettings['density']; break;
    case 'fontSize': next.fontSize = value as StoredUiSettings['fontSize']; break;
    case 'motion': next.motion = value as StoredUiSettings['motion']; break;
    case 'timeDisplay': next.timeDisplay = value as StoredUiSettings['timeDisplay']; break;
  }
  writeStoredSettings(runtimeHome, next);
  return inspectUiSettings(runtimeHome);
}

/**
 * Drops one explicit choice, or every one of them when no key is named.
 *
 * Resetting a single key needs the rest of the file, so a broken file is refused there; resetting
 * everything is the recovery path and therefore never reads the file at all — it rewrites it from
 * scratch, which is what `recoveryHint` points a user at.
 */
export function resetUiSettings(runtimeHome: string, key?: UiSettingKey | string): UiSettingsView {
  if (key === undefined) {
    writeStoredSettings(runtimeHome, {});
    return inspectUiSettings(runtimeHome);
  }
  if (!isUiSettingKey(key)) {
    throw new UiSettingsError('UNKNOWN_UI_SETTING',
      `${String(key)} is not a UI setting; the keys are: ${uiSettingKeys.join(', ')}`);
  }
  const current = readStoredSettings(runtimeHome);
  const next: StoredUiSettings = { ...current };
  delete next[key];
  writeStoredSettings(runtimeHome, next);
  return inspectUiSettings(runtimeHome);
}
