/**
 * Read-only Agent plugin/resource detection (FOUNDATION-071 / ADR-0044 D05).
 *
 * The Agent settings page must be able to show *what the provider actually has*, not a list the
 * user has to type by hand. This service scans exactly the provider's own user configuration
 * directory — `~/.pi/agent/{extensions,skills,prompts,themes}`, or `PI_CODING_AGENT_DIR` when the
 * provider's config directory has been overridden — plus the provider's own `settings.json`
 * resource lists, and reports each candidate with:
 *
 * - `kind`, `name`, `path`, `source`
 * - `providerEnabled`: whether the provider itself would load it (`null` = could not be verified)
 * - `selectable` + a stable `reason` when Codeestra cannot enable it
 * - `selected`: whether it is in the currently effective selection
 *
 * Hard boundaries, all of them product decisions the user made:
 *
 * - **Never scans a repository directory.** Not `.pi/`, not `.claude/`, not `.codex/`, and not a
 *   symlink target that lives inside a Git working tree (that candidate is reported as
 *   `SYMLINK_OUTSIDE_PROVIDER_DIRECTORY` rather than inspected). The scan reads at most two levels:
 *   a resource directory and, for a directory-shaped candidate, whether it holds the one file that
 *   makes it loadable.
 * - **Read-only, zero side effects.** Nothing is written; the provider's own state is never
 *   modified. Provider enablement that cannot be verified is reported as unverified, never guessed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  agentPluginKinds,
  agentPluginSelectionSchema,
  type AgentPluginCandidate,
  type AgentPluginDetection,
  type AgentPluginKind,
  type AgentPluginSelection,
  type AgentPluginSelectionSource,
  type AgentPluginUnavailableReason,
} from '@codeestra/contracts';
import {
  inspectPiPluginPath,
  resolveDetectionEntry,
} from '@codeestra/agent-adapters';

/** The provider user configuration directory: `PI_CODING_AGENT_DIR` wins, else `~/.pi/agent`. */
export function piProviderConfigDirectory(
  environment: Readonly<Record<string, string | undefined>> = {},
): string {
  const override = environment['PI_CODING_AGENT_DIR'];
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return join(homedir(), '.pi', 'agent');
}

/** Which provider subdirectory holds each kind, and how a candidate is named. */
const providerSubdirectoryByKind: Readonly<Record<AgentPluginKind, string>> = Object.freeze({
  extensions: 'extensions',
  skills: 'skills',
  promptTemplates: 'prompts',
  themes: 'themes',
});

/** The provider `settings.json` keys that list extra resource paths, per kind. */
const settingsKeyByKind: Readonly<Record<AgentPluginKind, string>> = Object.freeze({
  extensions: 'extensions',
  skills: 'skills',
  promptTemplates: 'prompts',
  themes: 'themes',
});

/** A candidate name is the resource's own basename, with the kind's own extension removed. */
function candidateName(kind: AgentPluginKind, path: string): string {
  const name = basename(path);
  if (kind === 'extensions') return name.replace(/\.(ts|js|mjs|cjs)$/, '');
  if (kind === 'themes') return name.replace(/\.json$/, '');
  if (kind === 'skills') return name.replace(/\.md$/, '');
  return name.replace(/\.md$/, '');
}

interface ProviderSettings {
  readonly readable: boolean;
  /** Extra configured paths per kind, only when the settings file could be read. */
  readonly configuredPaths: Readonly<Record<AgentPluginKind, readonly string[]>>;
}

/**
 * Reads the provider's own `settings.json` for its resource lists. A missing or unparsable file is
 * reported as unreadable instead of being treated as "no resources", because the two facts lead to
 * different UI claims (`providerEnabled: null` vs `false`).
 */
export function readProviderSettings(configDirectory: string): ProviderSettings {
  const empty = Object.fromEntries(agentPluginKinds.map((kind) => [kind, []])) as unknown as
    Record<AgentPluginKind, readonly string[]>;
  let text: string;
  try {
    text = readFileSync(join(configDirectory, 'settings.json'), 'utf8');
  } catch {
    return { readable: false, configuredPaths: empty };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { readable: false, configuredPaths: empty };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { readable: false, configuredPaths: empty };
  }
  const configuredPaths: Record<AgentPluginKind, readonly string[]> = { ...empty };
  for (const kind of agentPluginKinds) {
    const raw = (parsed as Record<string, unknown>)[settingsKeyByKind[kind]];
    if (!Array.isArray(raw)) continue;
    configuredPaths[kind] = raw
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      // A settings entry may be a `npm:` package or `~`-relative path; only absolute paths can be
      // inspected here, and the rest are reported by the CLI as configured-but-unverifiable.
      .map((entry) => (entry.startsWith('~/') ? join(homedir(), entry.slice(2)) : entry))
      .filter((entry) => entry.startsWith('/'));
  }
  return { readable: true, configuredPaths };
}

function listEntries(directory: string): readonly string[] {
  try {
    return readdirSync(directory).filter((name) => !name.startsWith('.')).sort();
  } catch {
    return [];
  }
}

/**
 * One directory entry inside a provider resource directory becomes a candidate, unless it is
 * excluded (a symlink that only a repository walk could verify, or a name the provider itself
 * ignores).
 */
function candidatesFromDirectory(input: {
  readonly kind: AgentPluginKind;
  readonly directory: string;
  readonly selectionPaths: ReadonlySet<string>;
  readonly providerStateReadable: boolean;
}): readonly AgentPluginCandidate[] {
  const { kind, directory } = input;
  const candidates: AgentPluginCandidate[] = [];
  for (const entry of listEntries(directory)) {
    const path = join(directory, entry);
    const resolution = resolveDetectionEntry(path);
    let reason: AgentPluginUnavailableReason | null = null;
    if (resolution.broken) {
      reason = 'NOT_FOUND';
    } else if (resolution.insideGitTree) {
      // The provider would follow this link, but verifying what it points at would mean walking a
      // Git working tree — which this read-only detection must not do. Report it, do not guess.
      reason = 'SYMLINK_OUTSIDE_PROVIDER_DIRECTORY';
    } else {
      const verdict = inspectPiPluginPath(kind, path);
      reason = verdict.ok ? null : verdict.reason;
    }
    if (!input.providerStateReadable && reason === null) reason = 'PROVIDER_STATE_UNREADABLE';
    candidates.push({
      kind,
      name: candidateName(kind, path),
      path,
      source: 'PROVIDER_USER_DIRECTORY',
      // These four directories are exactly what the provider discovers on its own; the provider
      // state determines whether that could be read at all.
      providerEnabled: input.providerStateReadable ? true : null,
      selectable: reason === null,
      reason,
      selected: input.selectionPaths.has(path),
    });
  }
  return candidates;
}

function candidatesFromSettings(input: {
  readonly kind: AgentPluginKind;
  readonly configuredPaths: readonly string[];
  readonly knownPaths: ReadonlySet<string>;
  readonly selectionPaths: ReadonlySet<string>;
  readonly providerStateReadable: boolean;
}): readonly AgentPluginCandidate[] {
  const candidates: AgentPluginCandidate[] = [];
  for (const path of input.configuredPaths) {
    // A path the provider also discovers in its own resource directory is one candidate, reported
    // once with the directory as its source.
    if (input.knownPaths.has(path)) continue;
    const resolution = resolveDetectionEntry(path);
    let reason: AgentPluginUnavailableReason | null = null;
    if (resolution.broken) reason = 'NOT_FOUND';
    else if (resolution.insideGitTree) reason = 'SYMLINK_OUTSIDE_PROVIDER_DIRECTORY';
    else {
      const verdict = inspectPiPluginPath(input.kind, path);
      reason = verdict.ok ? null : verdict.reason;
    }
    candidates.push({
      kind: input.kind,
      name: candidateName(input.kind, path),
      path,
      source: 'PROVIDER_SETTINGS',
      // The provider's own settings name it, so the provider intends to load it; the file-level
      // verdict below says whether Codeestra can too.
      providerEnabled: true,
      selectable: reason === null,
      reason,
      selected: input.selectionPaths.has(path),
    });
  }
  return candidates;
}

export interface AgentPluginDetectionInput {
  /** The effective selection, or `null` when nothing is selected. */
  readonly selection: AgentPluginSelection | null;
  readonly adapterId: string;
  /** `UNSUPPORTED` for an Adapter without plugin selection (Codex, Claude Code). */
  readonly pluginSelectionSupport: 'SUPPORTED' | 'UNSUPPORTED';
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Which precedence layer the effective selection came from, when there is one. */
  readonly selectionSource?: AgentPluginSelectionSource | null;
  /** Overridable for tests; defaults to the provider's own user configuration directory. */
  readonly configDirectory?: string;
}

/**
 * Detects every selectable candidate and projects the current selection over it. Pure read: this
 * function opens no file for writing and starts no provider process, so calling it is always safe.
 */
export function detectAgentPlugins(input: AgentPluginDetectionInput): AgentPluginDetection {
  const configDirectory = input.configDirectory ?? piProviderConfigDirectory(input.environment ?? {});
  const selection = input.selection === null ? null : agentPluginSelectionSchema.parse(input.selection);
  const selectionPaths = new Set(selection === null
    ? []
    : agentPluginKinds.flatMap((kind) => selection[kind]));
  if (input.pluginSelectionSupport === 'UNSUPPORTED') {
    // An Adapter that cannot apply a selection reports that fact with no candidates at all, rather
    // than showing a page whose selections would be silently ignored (ADR-0044 D03).
    return {
      adapterId: input.adapterId,
      pluginSelectionSupport: 'UNSUPPORTED',
      providerConfigDirectory: configDirectory,
      providerStateReadable: false,
      candidates: [],
      selection: null,
      selectionSource: null,
      supportedKinds: [],
    };
  }
  const settings = readProviderSettings(configDirectory);
  const candidates: AgentPluginCandidate[] = [];
  const knownPaths = new Set<string>();
  for (const kind of agentPluginKinds) {
    const directory = join(configDirectory, providerSubdirectoryByKind[kind]);
    const fromDirectory = candidatesFromDirectory({
      kind,
      directory,
      selectionPaths,
      providerStateReadable: settings.readable,
    });
    for (const candidate of fromDirectory) knownPaths.add(candidate.path);
    const fromSettings = candidatesFromSettings({
      kind,
      configuredPaths: settings.configuredPaths[kind],
      knownPaths,
      selectionPaths,
      providerStateReadable: settings.readable,
    });
    candidates.push(...fromDirectory, ...fromSettings);
  }
  return {
    adapterId: input.adapterId,
    pluginSelectionSupport: 'SUPPORTED',
    providerConfigDirectory: configDirectory,
    providerStateReadable: settings.readable,
    candidates,
    selection,
    selectionSource: selection === null ? null : input.selectionSource ?? null,
    supportedKinds: [...agentPluginKinds],
  };
}
