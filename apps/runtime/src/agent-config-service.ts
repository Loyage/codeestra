import {
  agentConfigurationEnvironmentVariables,
  agentConfigurationSchema,
  agentPluginSelectionTrace,
  thinkingLevelSchema,
  thinkingLevels,
  type AgentConfiguration,
  type AgentPluginSelection,
  type AgentPluginSelectionSource,
  type AgentPluginTrace,
  type ThinkingLevel,
} from '@codeestra/contracts';
import type { AgentConfigurationRecord, Phase1Database, StoredAgentConfiguration } from '@codeestra/storage';

export class AgentConfigurationError extends Error {
  constructor(readonly code: 'INVALID_AGENT_CONFIGURATION', message: string) {
    super(message);
    this.name = 'AgentConfigurationError';
  }
}

/** Which precedence layer supplied one effective field. */
export type AgentConfigurationSource = 'ENVIRONMENT' | 'PROJECT' | 'GLOBAL' | 'DEFAULT';

/** Which precedence layer supplied the effective plugin selection. */
export interface AgentPluginResolution {
  readonly selection: AgentPluginSelection;
  readonly source: AgentPluginSelectionSource;
}

/**
 * Resolves which plugins the Agent may load, with the same precedence as the rest of Agent
 * configuration: project overrides global, and the Adapter's own default is "nothing selected".
 *
 * The selection is one *field*, so a higher-precedence scope replaces it as a whole rather than
 * merging item by item: a project that selects any plugin decides the project's list, which is the
 * only reading of "project overrides global" that stays predictable for a list. Environment
 * variables are deliberately not a layer here — an environment variable cannot express a list
 * without inventing a separator and an escaping rule, and the command face already sets this
 * first-class (ADR-0044 D01).
 */
export function resolveAgentPlugins(input: {
  readonly storage: Phase1Database;
  readonly adapterId: string;
  readonly projectId: string | null;
}): AgentPluginResolution | null {
  const project = input.projectId === null
    ? null
    : input.storage.getAgentConfiguration('PROJECT', input.projectId, input.adapterId);
  if (project?.pluginSelection != null) {
    return { selection: project.pluginSelection, source: 'PROJECT' };
  }
  const global = input.storage.getAgentConfiguration('GLOBAL', null, input.adapterId);
  if (global?.pluginSelection != null) {
    return { selection: global.pluginSelection, source: 'GLOBAL' };
  }
  return null;
}

/**
 * The shape recorded with an Execution: the resolved model fields plus the plugin facts this run
 * actually used. It is `null` only when the Execution records nothing at all, so "the Adapter's own
 * default" and "explicitly configured to nothing" stay distinguishable (ADR-0012 D04).
 */
export function agentLaunchConfiguration(input: {
  readonly configuration: AgentConfiguration | null;
  readonly plugins: AgentPluginResolution | null;
}): StoredAgentConfiguration | null {
  const trace = agentPluginSelectionTrace(
    input.plugins?.selection ?? null, input.plugins?.source ?? null);
  const merged: StoredAgentConfiguration = {
    ...(input.configuration ?? {}),
    ...(trace === null ? {} : { plugins: trace }),
  };
  return Object.keys(merged).length === 0 ? null : merged;
}

/** The recorded plugin trace of one stored launch configuration, when there is one. */
export function storedAgentPluginTrace(
  configuration: StoredAgentConfiguration | null,
): AgentPluginTrace | null {
  return configuration?.plugins ?? null;
}

export interface AgentConfigurationResolution {
  readonly adapterId: string;
  readonly projectId: string | null;
  readonly global: AgentConfigurationRecord | null;
  readonly project: AgentConfigurationRecord | null;
  /** The effective plugin selection and its layer; `null` when nothing is selected anywhere. */
  readonly plugins: AgentPluginResolution | null;
  /** Environment overrides in force for this Runtime process, or `null` when none are set. */
  readonly environment: AgentConfiguration | null;
  /** Effective configuration; an absent field means the Adapter's own default is used. */
  readonly effective: AgentConfiguration;
  readonly sources: Readonly<Record<'provider' | 'model' | 'thinkingLevel', AgentConfigurationSource>>;
}

type EnvironmentVariableNames = Readonly<Partial<Record<'provider' | 'model' | 'thinkingLevel', string>>>;

/**
 * Which Agent configuration fields an Adapter's scope can actually carry. A field this Adapter's
 * scope does not name (for example `provider` for Claude Code, which has no provider launch
 * parameter) is refused instead of being stored and silently ignored.
 */
export function agentConfigurationUnsupportedFields(
  adapterId: string,
): readonly ('provider' | 'model' | 'thinkingLevel')[] {
  const names = (agentConfigurationEnvironmentVariables as Readonly<
    Record<string, EnvironmentVariableNames>
  >)[adapterId];
  // An Adapter this build knows nothing about is left to that Adapter's own boundary: this module
  // only refuses fields for scopes it is the authority on.
  if (names === undefined) return [];
  return (['provider', 'model', 'thinkingLevel'] as const).filter((field) => names[field] === undefined);
}

function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim().length === 0 ? undefined : value.trim();
}

/**
 * Environment overrides are adapter-specific and have the highest precedence, so a one-off run
 * can be pinned without editing persisted configuration. An unusable value is reported as an
 * error instead of being ignored: silently running a different model than requested would make
 * the Execution's recorded configuration untrue.
 */
export function environmentAgentConfiguration(
  adapterId: string,
  environment: Readonly<Record<string, string | undefined>>,
): AgentConfiguration | null {
  const names = (agentConfigurationEnvironmentVariables as Readonly<
    Record<string, EnvironmentVariableNames>
  >)[adapterId];
  if (names === undefined) return null;
  const provider = names.provider === undefined ? undefined : nonBlank(environment[names.provider]);
  const model = names.model === undefined ? undefined : nonBlank(environment[names.model]);
  const rawThinking = names.thinkingLevel === undefined
    ? undefined
    : nonBlank(environment[names.thinkingLevel]);
  let thinkingLevel: ThinkingLevel | undefined;
  if (rawThinking !== undefined) {
    const parsed = thinkingLevelSchema.safeParse(rawThinking);
    if (!parsed.success) {
      throw new AgentConfigurationError('INVALID_AGENT_CONFIGURATION',
        `${names.thinkingLevel} must be one of ${thinkingLevels.join(', ')}; got ${JSON.stringify(rawThinking)}`);
    }
    thinkingLevel = parsed.data;
  }
  const configuration: AgentConfiguration = {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
  return Object.keys(configuration).length === 0 ? null : configuration;
}

/**
 * Resolves the effective configuration field by field, so a project that overrides only the
 * model still inherits the global provider and thinking level. Precedence: environment, project,
 * global, Adapter default.
 */
export function resolveAgentConfiguration(input: {
  readonly storage: Phase1Database;
  readonly adapterId: string;
  readonly projectId: string | null;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): AgentConfigurationResolution {
  const environment = environmentAgentConfiguration(input.adapterId, input.environment ?? {});
  const global = input.storage.getAgentConfiguration('GLOBAL', null, input.adapterId);
  const project = input.projectId === null
    ? null
    : input.storage.getAgentConfiguration('PROJECT', input.projectId, input.adapterId);
  // A field this Adapter cannot carry must be refused wherever it was configured, including the
  // environment and a persisted scope: storing it and never applying it would make the Execution's
  // recorded configuration untrue (ADR-0012).
  for (const field of agentConfigurationUnsupportedFields(input.adapterId)) {
    const fromEnvironment = environment?.[field];
    const fromProject = project?.[field] ?? null;
    const fromGlobal = global?.[field] ?? null;
    if (fromEnvironment === undefined && fromProject === null && fromGlobal === null) continue;
    throw new AgentConfigurationError('INVALID_AGENT_CONFIGURATION',
      `The ${input.adapterId} Adapter does not accept ${field}; clear it before using this Adapter`);
  }
  const fields = ['provider', 'model', 'thinkingLevel'] as const;
  const effective: Record<string, string> = {};
  const sources = { provider: 'DEFAULT', model: 'DEFAULT', thinkingLevel: 'DEFAULT' } as
    Record<'provider' | 'model' | 'thinkingLevel', AgentConfigurationSource>;
  for (const field of fields) {
    const fromEnvironment = environment?.[field];
    const fromProject = project?.[field] ?? null;
    const fromGlobal = global?.[field] ?? null;
    if (fromEnvironment !== undefined) {
      effective[field] = fromEnvironment;
      sources[field] = 'ENVIRONMENT';
    } else if (fromProject !== null) {
      effective[field] = fromProject;
      sources[field] = 'PROJECT';
    } else if (fromGlobal !== null) {
      effective[field] = fromGlobal;
      sources[field] = 'GLOBAL';
    }
  }
  return {
    adapterId: input.adapterId,
    projectId: input.projectId,
    global,
    project,
    environment,
    plugins: resolveAgentPlugins({
      storage: input.storage, adapterId: input.adapterId, projectId: input.projectId,
    }),
    // Parsing the merged values keeps one validation boundary for all three precedence layers.
    effective: agentConfigurationSchema.parse(effective),
    sources,
  };
}

/** JSON shape of a resolution, with every field explicit so a client never guesses at defaults. */
export function agentConfigurationPayload(resolution: AgentConfigurationResolution): {
  readonly adapterId: string;
  readonly projectId: string | null;
  readonly global: AgentConfigurationRecord | null;
  readonly project: AgentConfigurationRecord | null;
  readonly environment: AgentConfiguration | null;
  readonly effective: {
    readonly provider: string | null;
    readonly model: string | null;
    readonly thinkingLevel: ThinkingLevel | null;
  };
  readonly sources: AgentConfigurationResolution['sources'];
  /** The effective plugin selection with the layer that supplied it (ADR-0044). */
  readonly pluginSelection: AgentPluginSelection | null;
  readonly pluginSelectionSource: AgentPluginSelectionSource | null;
  /**
   * A recorded fact, not a warning to be dismissed: a selected third-party extension can influence
   * or bypass Codeestra's approval channel (ADR-0044 D03).
   */
  readonly thirdPartyExtensionApprovalRisk: boolean;
} {
  const trace = agentPluginSelectionTrace(
    resolution.plugins?.selection ?? null, resolution.plugins?.source ?? null);
  return {
    adapterId: resolution.adapterId,
    projectId: resolution.projectId,
    global: resolution.global,
    project: resolution.project,
    environment: resolution.environment,
    effective: {
      provider: resolution.effective.provider ?? null,
      model: resolution.effective.model ?? null,
      thinkingLevel: resolution.effective.thinkingLevel ?? null,
    },
    sources: resolution.sources,
    pluginSelection: resolution.plugins?.selection ?? null,
    pluginSelectionSource: resolution.plugins?.source ?? null,
    thirdPartyExtensionApprovalRisk: trace?.thirdPartyExtensionApprovalRisk ?? false,
  };
}
