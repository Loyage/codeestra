import { z } from 'zod';

/**
 * The five interface-effect settings (FOUNDATION-073 / ADR-0045).
 *
 * The user's request was "global settings, adjustable in the interface for interface effects". So
 * this is the whole *presentation* surface of one Runtime home — not a behavioural setting, not a
 * permission, not a gate. Every value here is a preference about how the Web UI renders; none of
 * them changes what a Task may do.
 *
 * Two rules shape the shape below:
 *
 * 1. **The value set is closed.** Each key has a fixed, small list of values with no free text, so
 *    `--json` output, the CLI's own validation and the UI's `<select>` all read the same finite
 *    list from one place (here). A value outside the list is refused, never clamped.
 * 2. **One name everywhere.** A key is spelled identically in the CLI, in the JSON file the Runtime
 *    owns, in the RPC request and in the DOM attribute it drives (`fontSize` →
 *    `data-font-size`). Aliases would make "which setting is this?" a question again.
 *
 * Stored in the Runtime home, never in browser storage: the CLI must be able to read and write the
 * same value the UI shows, and a preference that only exists in one browser's `localStorage` is not
 * reachable from the command face at all (ADR-0008, ADR-0045).
 */
export const uiSettingKeys = ['theme', 'density', 'fontSize', 'motion', 'timeDisplay'] as const;
export type UiSettingKey = (typeof uiSettingKeys)[number];

/**
 * The accepted values, in the order a human should see them.
 *
 * - `theme`: `system` follows the operating system's colour scheme live (ADR-0015's semantics,
 *   unchanged); `light`/`dark` pin it.
 * - `density`: spacing rhythm for the content surfaces. `comfortable` is today's spacing, so the
 *   default changes nothing.
 * - `fontSize`: the root type scale, so `rem`-based text (including `pre`/`code`) scales together.
 * - `motion`: `reduced` suppresses the UI's own animations even when the system allows them. It can
 *   only ever *remove* motion: `full` still respects `prefers-reduced-motion`.
 * - `timeDisplay`: how Task update times are rendered. `absolute` prints the local date and time;
 *   both modes keep the absolute timestamp in the element's `title`.
 */
export const uiSettingValues = {
  theme: ['system', 'light', 'dark'],
  density: ['comfortable', 'compact'],
  fontSize: ['medium', 'small', 'large'],
  motion: ['full', 'reduced'],
  timeDisplay: ['relative', 'absolute'],
} as const satisfies Record<UiSettingKey, readonly [string, ...string[]]>;

/** Every accepted value, in one flat list, for values that are validated before their key is known. */
export const allUiSettingValues = [
  ...uiSettingValues.theme, ...uiSettingValues.density, ...uiSettingValues.fontSize,
  ...uiSettingValues.motion, ...uiSettingValues.timeDisplay,
] as const;

export const uiSettingValueSchema = z.enum(allUiSettingValues);
export type UiSettingValue = z.infer<typeof uiSettingValueSchema>;

export const uiSettingKeySchema = z.enum(uiSettingKeys);

/**
 * The product default for each key, used whenever the Runtime home records no explicit value.
 *
 * These are also the values in force when no settings file exists at all, so a fresh Runtime home
 * renders exactly like the UI did before this feature.
 */
export const uiSettingDefaults = {
  theme: 'system',
  density: 'comfortable',
  fontSize: 'medium',
  motion: 'full',
  timeDisplay: 'relative',
} as const satisfies Record<UiSettingKey, UiSettingValue>;

export function isUiSettingKey(value: unknown): value is UiSettingKey {
  return typeof value === 'string' && (uiSettingKeys as readonly string[]).includes(value);
}

/** Whether `value` is one of the values `key` accepts. Key first: the same word is not valid twice. */
export function isValidUiSettingValue(key: UiSettingKey, value: unknown): value is UiSettingValue {
  return typeof value === 'string' && (uiSettingValues[key] as readonly string[]).includes(value);
}

/** `theme|density|fontSize|motion|timeDisplay`, for usage text that must not drift from the code. */
export function uiSettingKeysAsText(): string {
  return uiSettingKeys.join('|');
}

/** `system|light|dark`, for usage text and refusal messages. */
export function uiSettingValuesAsText(key: UiSettingKey): string {
  return uiSettingValues[key].join('|');
}

/**
 * Where a key's effective value came from. `PRODUCT_DEFAULT` means the Runtime home records
 * nothing for it; `RUNTIME` means an explicit value is stored. The distinction is reported rather
 * than flattened, because "the UI shows dark" and "you once chose dark" are different facts and
 * `reset` only means the second one.
 */
export const uiSettingSources = ['PRODUCT_DEFAULT', 'RUNTIME'] as const;
export const uiSettingSourceSchema = z.enum(uiSettingSources);
export type UiSettingSource = (typeof uiSettingSources)[number];

/** One key as the command face reports it: effective value, default, and whether it was chosen. */
export const uiSettingEntrySchema = z.strictObject({
  key: uiSettingKeySchema,
  value: uiSettingValueSchema,
  default: uiSettingValueSchema,
  /** The values this key accepts, in display order; the UI builds its choices from this. */
  values: z.array(uiSettingValueSchema).min(1),
  explicit: z.boolean(),
  source: uiSettingSourceSchema,
});
export type UiSettingEntry = z.infer<typeof uiSettingEntrySchema>;

/**
 * The whole settings face. `file` is the absolute Runtime-owned path, reported so "this is not a
 * browser preference" is checkable rather than asserted in prose, and so a person can edit it by
 * hand (an invalid edit is refused loudly on the next read instead of being silently repaired).
 */
export const uiSettingsViewSchema = z.strictObject({
  store: z.literal('RUNTIME_FILE'),
  file: z.string().min(1),
  appliesTo: z.string().min(1),
  settings: z.array(uiSettingEntrySchema),
});
export type UiSettingsView = z.infer<typeof uiSettingsViewSchema>;
