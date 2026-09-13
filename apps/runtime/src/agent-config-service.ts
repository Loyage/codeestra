import {
  agentConfigurationEnvironmentVariables,
  agentConfigurationSchema,
  thinkingLevelSchema,
  thinkingLevels,
  type AgentConfiguration,
  type ThinkingLevel,
} from '@codeestra/contracts';
import type { AgentConfigurationRecord, Phase1Database } from '@codeestra/storage';

export class AgentConfigurationError extends Error {
  constructor(readonly code: 'INVALID_AGENT_CONFIGURATION', message: string) {
    super(message);
    this.name = 'AgentConfigurationError';
  }
}

/** Which precedence layer supplied one effective field. */
export type AgentConfigurationSource = 'ENVIRONMENT' | 'PROJECT' | 'GLOBAL' | 'DEFAULT';

export interface AgentConfigurationResolution {
  readonly adapterId: string;
  readonly projectId: string | null;
  readonly global: AgentConfigurationRecord | null;
  readonly project: AgentConfigurationRecord | null;
  /** Environment overrides in force for this Runtime process, or `null` when none are set. */
  readonly environment: AgentConfiguration | null;
  /** Effective configuration; an absent field means the Adapter's own default is used. */
  readonly effective: AgentConfiguration;
  readonly sources: Readonly<Record<'provider' | 'model' | 'thinkingLevel', AgentConfigurationSource>>;
}

type EnvironmentVariableNames = Readonly<Record<'provider' | 'model' | 'thinkingLevel', string>>;

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
  const provider = nonBlank(environment[names.provider]);
  const model = nonBlank(environment[names.model]);
  const rawThinking = nonBlank(environment[names.thinkingLevel]);
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
} {
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
  };
}
