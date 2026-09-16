import { z } from 'zod';

/**
 * The settings face of one Runtime home (ADR-0064).
 *
 * Before this file the product had several settings that each knew only their own command
 * (`permission get|set`, `settings prose-question-attention`, `settings ui …`, and the concurrency
 * limit reachable as `scheduler capacity` / `settings concurrency`).
 * Nothing said *which* settings exist, so "show me my settings" had no answer and a newly added
 * setting was invisible unless a user already knew its name. `settings.list` is that answer: one
 * read that enumerates every Runtime-level setting with its effective value, its product default,
 * where the value came from, and where it is stored.
 *
 * Two rules shape the shapes below:
 *
 * 1. **The key set is closed and declared here.** `settingKeys` is the whole list, and the view
 *    schema refuses a payload that does not carry every key exactly once. A setting that is not
 *    listed is not reported, and a setting that is reported twice is a contract violation — either
 *    way the aggregate cannot silently drift from what the product actually has.
 * 2. **The aggregate never re-invents a value.** Each entry is filled from the same read its own
 *    dedicated command uses, so `settings.list` cannot disagree with `settings ui get theme` or
 *    `scheduler capacity get`. There is one stored value per setting and no second state source.
 *
 * This is not a new permission surface: every setting in this list is zero-confirmation in FULL and
 * in STRICT alike, and reading the list asks for nothing.
 */

/**
 * The permission mode (ADR-0011). It lives here rather than in the Runtime's file module so the
 * command face, the stored file and this list all read one declaration: `FULL` is the product
 * default, `STRICT` is the explicit opt-in that restores per-action approval.
 */
export const permissionModes = ['FULL', 'STRICT'] as const;
export const permissionModeSchema = z.enum(permissionModes);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const defaultPermissionMode: PermissionMode = 'FULL';

/**
 * Every setting this Runtime home has, in the order a person should read them.
 *
 * The spelling is the command path with dots: `permission.mode` is what `settings permission get`
 * reports, `ui.theme` is what `settings ui get theme` reports, and `capacity.globalLimit` is the
 * one limit under both of its spellings. A client that wants to point at one setting prints the
 * key; there is no second name for it.
 *
 * A setting is reported in the vocabulary of its own command: the permission mode as `FULL`/`STRICT`,
 * the prose-question mode as `auto`/`record-only`/`off`, and so on. The list is read by the same
 * people who type the command, and one setting must not have two vocabularies.
 */
export const settingKeys = [
  'permission.mode',
  'attention.proseQuestion',
  'ui.theme',
  'ui.density',
  'ui.fontSize',
  'ui.motion',
  'ui.timeDisplay',
  'capacity.globalLimit',
] as const;
export const settingKeySchema = z.enum(settingKeys);
export type SettingKey = (typeof settingKeys)[number];

/**
 * Where a setting's value came from. `PRODUCT_DEFAULT` means this Runtime home records nothing for
 * it and the documented default is in force; `RUNTIME` means an explicit value is stored. The same
 * distinction the UI-settings face reports, kept here because "it is dark" and "you chose dark" are
 * different facts.
 */
export const settingSources = ['PRODUCT_DEFAULT', 'RUNTIME'] as const;
export const settingSourceSchema = z.enum(settingSources);
export type SettingSource = (typeof settingSources)[number];

/** Which store holds the value, so "this is not a browser preference" stays checkable. */
export const settingStores = ['RUNTIME_FILE', 'RUNTIME_DATABASE'] as const;
export const settingStoreSchema = z.enum(settingStores);
export type SettingStore = (typeof settingStores)[number];

/**
 * A setting's value is one of a closed word set, one integer in a range, or the two words a
 * boolean switch accepts. All three are reported as `string | number`; `values` and `range` say
 * which shape the entry has.
 */
const settingValueSchema = z.union([z.string().min(1), z.number().int()]);

/**
 * One setting as the command face reports it.
 *
 * `values` and `range` are mutually exclusive: a closed set (`full|strict`) has `values` and no
 * `range`, a numeric limit has `range` and no `values`. Exactly one is non-null, and the entry
 * schema enforces that — a client that renders choices must not have to decide what it means when
 * both are present.
 */
export const settingEntrySchema = z.strictObject({
  key: settingKeySchema,
  value: settingValueSchema,
  default: settingValueSchema,
  /** The accepted values, in display order; null for a numeric range. */
  values: z.array(z.string().min(1)).min(1).nullable(),
  /** The accepted range of a numeric setting; null for a closed word set. */
  range: z.strictObject({ min: z.number().int(), max: z.number().int() }).nullable(),
  explicit: z.boolean(),
  source: settingSourceSchema,
  store: settingStoreSchema,
  /** The absolute file the value is stored in, for a `RUNTIME_FILE` setting; null for a table. */
  file: z.string().min(1).nullable(),
  /** What a change applies to; the honest scope of the setting, in one sentence. */
  appliesTo: z.string().min(1),
}).superRefine((entry, context) => {
  if ((entry.values === null) === (entry.range === null)) {
    context.addIssue({
      code: 'custom',
      message: `${entry.key} must carry exactly one of "values" (a closed set) or "range" (a number)`,
    });
  }
  if (entry.explicit !== (entry.source === 'RUNTIME')) {
    context.addIssue({
      code: 'custom',
      message: `${entry.key} reports "explicit" and "source" inconsistently`,
    });
  }
});
export type SettingEntry = z.infer<typeof settingEntrySchema>;

/**
 * The whole settings list. `home` is the Runtime home every value belongs to — one home is one
 * resource domain, so the list is complete by definition rather than by a filter.
 */
export const settingsListViewSchema = z.strictObject({
  home: z.string().min(1),
  appliesTo: z.string().min(1),
  settings: z.array(settingEntrySchema),
}).superRefine((view, context) => {
  const seen = new Set(view.settings.map((entry) => entry.key));
  for (const key of settingKeys) {
    if (!seen.has(key)) {
      context.addIssue({ code: 'custom', message: `the settings list is missing ${key}` });
    }
  }
  if (seen.size !== view.settings.length) {
    context.addIssue({ code: 'custom', message: 'the settings list reports a key twice' });
  }
});
export type SettingsListView = z.infer<typeof settingsListViewSchema>;

/** `FULL|STRICT`, for usage text and refusal messages that must not drift from the code. */
export function permissionModesAsText(): string {
  return permissionModes.join('|');
}
