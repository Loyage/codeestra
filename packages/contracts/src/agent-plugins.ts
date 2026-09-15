/**
 * Agent plugin/resource selection (FOUNDATION-071 / ADR-0044).
 *
 * The user asked to configure "which plugins an Agent may use" from the Agent settings page. This
 * module owns the *selection* shape; the provider-specific argument mapping lives in each Adapter
 * (`packages/agent-adapters`), because only an Adapter knows how its own provider names a resource.
 *
 * Scope, fixed by the user for this step: exactly the four Pi resource kinds below. AGENTS.md /
 * CLAUDE.md context files stay disabled and have no switch, and Codex / Claude Code do not support
 * plugin selection in this step — that is reported as `UNSUPPORTED` instead of being faked behind a
 * common abstraction.
 */
import { z } from 'zod';

export const agentPluginKinds = ['extensions', 'skills', 'promptTemplates', 'themes'] as const;
export const agentPluginKindSchema = z.enum(agentPluginKinds);
export type AgentPluginKind = z.infer<typeof agentPluginKindSchema>;

/** Ancestor-directory separators for both POSIX and Windows, so path checks stay host-neutral. */
function containsParentReference(value: string): boolean {
  return value.split(/[\\/]+/).includes('..');
}

/**
 * One explicitly selected resource path. It must be absolute, non-blank without surrounding
 * whitespace, free of NUL, and free of `..` segments: a selection is handed to the provider as a
 * launch argument, so a relative or traversing path would make the launched Agent depend on the
 * Runtime's working directory. Whether the path *exists* and is usable is decided at start time by
 * the Adapter's verification (fail-closed), not here.
 */
export const agentPluginPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value.trim() === value, 'Plugin paths must not have surrounding whitespace')
  .refine((value) => value.length > 0, 'Plugin paths must not be blank')
  .refine((value) => !value.includes('\u0000'), 'Plugin paths must not contain NUL')
  .refine((value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value),
    'Plugin paths must be absolute')
  .refine((value) => !containsParentReference(value),
    'Plugin paths must not contain ".." segments');

/**
 * One scope's plugin selection: which resources of each kind the Agent may load. Every list is
 * explicit and ordered (the provider's launch arguments keep this order), and an empty list means
 * "this kind loads nothing".
 */
export const agentPluginSelectionSchema = z.strictObject({
  extensions: z.array(agentPluginPathSchema).max(64).default([]),
  skills: z.array(agentPluginPathSchema).max(64).default([]),
  promptTemplates: z.array(agentPluginPathSchema).max(64).default([]),
  themes: z.array(agentPluginPathSchema).max(64).default([]),
});
export type AgentPluginSelection = z.infer<typeof agentPluginSelectionSchema>;

export const emptyAgentPluginSelection: AgentPluginSelection = Object.freeze({
  extensions: Object.freeze([]) as readonly string[],
  skills: Object.freeze([]) as readonly string[],
  promptTemplates: Object.freeze([]) as readonly string[],
  themes: Object.freeze([]) as readonly string[],
}) as AgentPluginSelection;

export function agentPluginSelectionIsEmpty(selection: AgentPluginSelection | null | undefined): boolean {
  if (selection === null || selection === undefined) return true;
  return agentPluginKinds.every((kind) => selection[kind].length === 0);
}

export function agentPluginSelectionPaths(selection: AgentPluginSelection): readonly string[] {
  return agentPluginKinds.flatMap((kind) => selection[kind]);
}

/** Total number of selected resources; used to bound the recorded trace. */
export function agentPluginSelectionSize(selection: AgentPluginSelection): number {
  return agentPluginKinds.reduce((total, kind) => total + selection[kind].length, 0);
}

/** Which precedence layer a selection came from. Environment variables cannot express a list. */
export const agentPluginSelectionSourceSchema = z.enum(['GLOBAL', 'PROJECT']);
export type AgentPluginSelectionSource = z.infer<typeof agentPluginSelectionSourceSchema>;

/**
 * The plugin facts recorded with an Execution. `entries` is what the Adapter actually received, per
 * resource, with the layer that supplied it, so a past run can be explained from its own row.
 */
export const agentPluginTraceSchema = z.strictObject({
  /** The layer the selection came from, or `null` when nothing was selected. */
  source: agentPluginSelectionSourceSchema.nullable(),
  entries: z.array(z.strictObject({
    kind: agentPluginKindSchema,
    path: agentPluginPathSchema,
    source: agentPluginSelectionSourceSchema,
  })).max(256),
  /**
   * A recorded fact, not a warning to be dismissed: Pi's fail-closed gate is guaranteed by
   * `--no-extensions` plus Codeestra's own extensions, so a user-selected third-party extension can
   * influence or bypass that approval (ADR-0044 D03). The Runtime does not add an approval layer
   * and does not block it at run time; it records that the risk was present.
   */
  thirdPartyExtensionApprovalRisk: z.boolean(),
});
export type AgentPluginTrace = z.infer<typeof agentPluginTraceSchema>;

export function agentPluginSelectionTrace(
  selection: AgentPluginSelection | null,
  source: AgentPluginSelectionSource | null,
): AgentPluginTrace | null {
  if (selection === null || source === null || agentPluginSelectionIsEmpty(selection)) return null;
  return {
    source,
    entries: agentPluginKinds.flatMap((kind) =>
      selection[kind].map((path) => ({ kind, path, source }))),
    thirdPartyExtensionApprovalRisk: selection.extensions.length > 0,
  };
}

/**
 * Rebuilds the selection a recorded trace describes. The Execution row is the authority for what a
 * Session may load: the Adapter is handed this reconstruction instead of re-resolving configuration,
 * so a replay after a restart launches exactly what the Execution recorded.
 */
export function agentPluginSelectionFromTrace(trace: AgentPluginTrace): AgentPluginSelection {
  const grouped: Record<AgentPluginKind, readonly string[]> = Object.fromEntries(
    agentPluginKinds.map((kind) => [kind, trace.entries.filter((entry) => entry.kind === kind)
      .map((entry) => entry.path)]),
  ) as unknown as Record<AgentPluginKind, readonly string[]>;
  return agentPluginSelectionSchema.parse(grouped);
}

/**
 * Why one candidate resource cannot be enabled by Codeestra. Every code is stable: a client groups
 * and explains by code instead of matching prose. `null` means the candidate is selectable.
 */
export const agentPluginUnavailableReasons = [
  /** The path does not exist. */
  'NOT_FOUND',
  /** The path exists but could not be read/stat'ed (permissions, IO error). */
  'NOT_READABLE',
  /** The path exists but is not a file/directory this kind can load (e.g. a `.txt` extension). */
  'UNSUPPORTED_FILE_TYPE',
  /** A symbolic link (or its target) leaves the provider user configuration directory. */
  'SYMLINK_OUTSIDE_PROVIDER_DIRECTORY',
  /** The path is neither a regular file nor a directory, so the kind cannot be decided. */
  'TYPE_UNDETERMINED',
  /** The provider's own state (settings.json) could not be read, so enablement is unknown. */
  'PROVIDER_STATE_UNREADABLE',
  /** The provider's own configuration names this resource but disables it. */
  'PROVIDER_DISABLED',
  /** This Adapter does not support plugin selection at all (Codex, Claude Code). */
  'ADAPTER_DOES_NOT_SUPPORT_PLUGIN_SELECTION',
] as const;
export const agentPluginUnavailableReasonSchema = z.enum(agentPluginUnavailableReasons);
export type AgentPluginUnavailableReason = z.infer<typeof agentPluginUnavailableReasonSchema>;

/** Where a detected candidate came from. Only the provider's own configuration is scanned. */
export const agentPluginCandidateSourceSchema = z.enum([
  'PROVIDER_USER_DIRECTORY',
  'PROVIDER_SETTINGS',
]);
export type AgentPluginCandidateSource = z.infer<typeof agentPluginCandidateSourceSchema>;

export const agentPluginCandidateSchema = z.strictObject({
  kind: agentPluginKindSchema,
  name: z.string().min(1),
  path: z.string().min(1),
  source: agentPluginCandidateSourceSchema,
  /**
   * Whether the provider itself would load this resource on its own. `null` means it could not be
   * verified from the provider's read-only state — never "assumed enabled".
   */
  providerEnabled: z.boolean().nullable(),
  /** Whether Codeestra may load this resource when the user selects it. */
  selectable: z.boolean(),
  reason: agentPluginUnavailableReasonSchema.nullable(),
  /** Whether this exact path is in the currently effective selection. */
  selected: z.boolean(),
});
export type AgentPluginCandidate = z.infer<typeof agentPluginCandidateSchema>;

export const agentPluginDetectionSchema = z.strictObject({
  adapterId: z.string().min(1),
  /** The Adapter's own capability, so a client says "not supported" instead of showing empty UI. */
  pluginSelectionSupport: z.enum(['SUPPORTED', 'UNSUPPORTED']),
  /** The directory this scan read; it reports where the candidates came from. */
  providerConfigDirectory: z.string().min(1),
  providerStateReadable: z.boolean(),
  candidates: z.array(agentPluginCandidateSchema).max(512),
  /** The effective selection and the layer it came from, or `null` when nothing is selected. */
  selection: agentPluginSelectionSchema.nullable(),
  selectionSource: agentPluginSelectionSourceSchema.nullable(),
  /** The four kinds this build can select, so a client does not invent its own list. */
  supportedKinds: z.array(agentPluginKindSchema),
});
export type AgentPluginDetection = z.infer<typeof agentPluginDetectionSchema>;

/**
 * Stable error codes this capability adds to the command face. They are part of the public surface:
 * a client tells "your selection is malformed" from "this path cannot be loaded" by code alone.
 */
export const agentPluginErrorCodes = [
  /** The submitted selection failed schema validation; nothing was written. */
  'INVALID_AGENT_PLUGIN_SELECTION',
  /** A selected path could not be verified, so the Session was refused before it started. */
  'AGENT_PLUGIN_UNAVAILABLE',
  /** This Adapter cannot apply plugin selection at all. */
  'AGENT_PLUGIN_KIND_UNSUPPORTED',
] as const;
export type AgentPluginErrorCode = (typeof agentPluginErrorCodes)[number];
