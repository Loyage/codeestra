import {
  defaultConcurrencyLimit,
  defaultPermissionMode,
  maxConcurrencyLimit,
  minConcurrencyLimit,
  permissionModes,
  proseQuestionAttentionModes,
  settingsListViewSchema,
  type PermissionMode,
  type ProseQuestionAttentionSettings,
  type SettingsListView,
} from '@codeestra/contracts';
import type { Phase1Database } from '@codeestra/storage';
import { permissionModePath } from './permission-mode.js';
import { proseQuestionAttentionPath } from './prose-question-attention-settings.js';

/**
 * The settings face of one Runtime home (ADR-0064).
 *
 * Every Runtime-level setting is reported here in one read, so "which settings exist and what are
 * they set to" is answered by the Runtime instead of by a list a client maintains by hand. Two
 * rules make the answer trustworthy:
 *
 * 1. **Each entry is filled from the same read its own command uses.** The permission mode, the
 *    prose-question switch come from the values this Runtime booted with and writes on change (the
 *    in-memory facts `permission.get` and `settings prose-question-attention` report); the
 *    concurrency limit comes from the same
 *    `runtime_capacity_settings` read `scheduler capacity get` uses. The aggregate therefore cannot
 *    disagree with the dedicated command — a second reader of the same fact is exactly how two
 *    answers start to differ.
 * 2. **The payload is parsed against the contract.** The key set, the "exactly one of values/range"
 *    rule and the `explicit` ↔ `source` agreement are checked here, so forgetting a setting (or
 *    reporting one twice) fails loudly at the boundary rather than quietly producing a short list.
 *
 * Nothing here is a gate: reading the list needs no confirmation, and every setting it reports is
 * zero-confirmation to change in FULL and in STRICT alike.
 */
export function inspectSettings(input: {
  readonly runtimeHome: string;
  /** The mode this Runtime is enforcing, and whether this home stores one explicitly. */
  readonly permissionMode: PermissionMode;
  readonly permissionModeExplicit: boolean;
  /** The prose-question switch this Runtime is enforcing, and whether this home stores one. */
  readonly proseQuestionAttention: ProseQuestionAttentionSettings;
  readonly proseQuestionAttentionExplicit: boolean;
  readonly storage: Phase1Database;
}): SettingsListView {
  const capacity = input.storage.getRuntimeCapacity();
  const permissionFile = permissionModePath(input.runtimeHome);
  const attentionFile = proseQuestionAttentionPath(input.runtimeHome);
  // The stored and effective values have to be two readings of one moment, so both come from the
  // value the Runtime is actually using plus the boot-time question "did this home store one?".
  const permissionExplicit = input.permissionModeExplicit;
  const attentionExplicit = input.proseQuestionAttentionExplicit;
  const capacityExplicit = capacity.limitSource === 'EXPLICIT';
  return settingsListViewSchema.parse({
    home: input.runtimeHome,
    appliesTo: 'This Runtime home. Every value is read from the Runtime, never from a browser, and'
      + ' every one of them can be changed without a confirmation.',
    settings: [
      {
        key: 'permission.mode',
        value: input.permissionMode,
        default: defaultPermissionMode,
        values: [...permissionModes],
        range: null,
        explicit: permissionExplicit,
        source: permissionExplicit ? 'RUNTIME' : 'PRODUCT_DEFAULT',
        store: 'RUNTIME_FILE',
        file: permissionFile,
        appliesTo: 'New operations and new Agent sessions; a Session already running keeps the mode'
          + ' it started with',
      },
      {
        key: 'attention.proseQuestion',
        value: input.proseQuestionAttention.mode,
        default: input.proseQuestionAttention.default,
        values: [...proseQuestionAttentionModes],
        range: null,
        explicit: attentionExplicit,
        source: attentionExplicit ? 'RUNTIME' : 'PRODUCT_DEFAULT',
        store: 'RUNTIME_FILE',
        file: attentionFile,
        appliesTo: input.proseQuestionAttention.appliesTo,
      },
      {
        key: 'capacity.globalLimit',
        value: capacity.limit,
        default: defaultConcurrencyLimit,
        values: null,
        range: { min: minConcurrencyLimit, max: maxConcurrencyLimit },
        explicit: capacityExplicit,
        source: capacityExplicit ? 'RUNTIME' : 'PRODUCT_DEFAULT',
        store: 'RUNTIME_DATABASE',
        file: null,
        appliesTo: 'Every Project and every Adapter; the limit is re-read inside each acquisition,'
          + ' and lowering it never releases a slot already held',
      },
    ],
  });
}
