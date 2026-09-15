/**
 * Pi plugin/resource selection (FOUNDATION-071 / ADR-0044).
 *
 * What the user selects in the Agent settings page becomes provider launch arguments. Pi's
 * controlled launch already disables *discovery* of every one of these kinds and loads only the
 * explicit paths Codeestra passes:
 *
 * ```
 * --no-extensions --extension <gate> --extension <question>
 * --no-skills --no-prompt-templates --no-themes --no-context-files
 * ```
 *
 * `pi --help` states for extensions that "explicit -e paths still work" under `--no-extensions`,
 * and skills/prompt templates/themes follow the same rule (`--no-skills` disables "discovery and
 * loading" of discovered resources; an explicit `--skill <path>` is still loaded). Measured here:
 * a real `pi` loaded an explicitly passed extension under `--no-extensions`, and a `pi --mode rpc`
 * `get_commands` round-trip showed discovery-off plus explicit paths — see `docs/spikes` note in
 * ADR-0044 D06 for the exact evidence and for what was *not* measured.
 *
 * Two properties this module owns:
 *
 * 1. **Zero selection is byte-identical to the launch before this capability.** With no selection
 *    the argument list is exactly the previous one; nothing is added, nothing is reordered.
 * 2. **Unverifiable paths are fail-closed.** A path that cannot be read or is not a shape this kind
 *    can load refuses the Session *before* a provider process starts (stable code
 *    `AGENT_PLUGIN_UNAVAILABLE`). Silently dropping a user's selection would run the Agent with
 *    something other than what the Execution recorded.
 */
import {
  closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { agentPluginKinds, type AgentPluginKind, type AgentPluginSelection,
  type AgentPluginUnavailableReason } from '@codeestra/contracts';

export class PiPluginError extends Error {
  constructor(
    readonly code: 'AGENT_PLUGIN_UNAVAILABLE' | 'INVALID_AGENT_PLUGIN_SELECTION',
    message: string,
    readonly detail: {
      readonly kind?: AgentPluginKind;
      readonly path?: string;
      readonly reason?: AgentPluginUnavailableReason;
    } = {},
  ) {
    super(message);
    this.name = 'PiPluginError';
  }
}

/**
 * The provider flag each kind is passed with. Pi can repeat every one of them, and Codeestra passes
 * them in this fixed kind order (then in the user's own order within a kind), so the same selection
 * always produces the same argv.
 */
const piPluginFlagByKind: Readonly<Record<AgentPluginKind, string>> = Object.freeze({
  extensions: '--extension',
  skills: '--skill',
  promptTemplates: '--prompt-template',
  themes: '--theme',
});

/** Anything that is not a file or directory (fifo, socket, device) cannot be a loadable resource. */
function isRegularFileOrDirectory(path: string): 'file' | 'directory' | null {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return null;
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  return null;
}

/**
 * Whether the file can actually be read. `stat` succeeds on a file with mode 000 for its owner, but
 * the provider could not load it, so an unreadable file is reported as unusable instead of being
 * offered as a selectable resource. One byte is read and nothing is written.
 */
function isReadableFile(path: string): boolean {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, 'r');
    const buffer = Buffer.alloc(1);
    readSync(descriptor, buffer, 0, 1, 0);
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // A descriptor that cannot be closed changes nothing about the verdict above.
      }
    }
  }
}

function hasEntryOfKind(directory: string, kind: AgentPluginKind): boolean {
  const expected = kind === 'extensions' ? null : kind === 'themes' ? '.json' : '.md';
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return false;
  }
  if (expected === null) return entries.some((name) => /\.(ts|js|mjs|cjs)$/.test(name));
  if (expected === '.md' && kind === 'skills') {
    return existsSync(join(directory, 'SKILL.md'))
      || entries.some((name) => name.endsWith('.md'));
  }
  return entries.some((name) => name.endsWith(expected));
}

/**
 * Whether one absolute path is a shape this kind can load, and why not when it is not.
 * Read-only: it stats the path (following symlinks, the way the provider does) and, for a
 * directory, lists that one directory — it never walks a tree and never writes anything.
 */
export function inspectPiPluginPath(
  kind: AgentPluginKind,
  path: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: AgentPluginUnavailableReason } {
  let shape: 'file' | 'directory' | null;
  try {
    shape = isRegularFileOrDirectory(path);
  } catch {
    return { ok: false, reason: 'NOT_READABLE' };
  }
  if (shape === null) {
    // A dangling symlink and a missing path are both "does not exist" from the provider's side.
    return { ok: false, reason: existsSync(path) ? 'TYPE_UNDETERMINED' : 'NOT_FOUND' };
  }
  if (shape === 'file' && !isReadableFile(path)) return { ok: false, reason: 'NOT_READABLE' };
  try {
    if (kind === 'extensions') {
      if (shape !== 'file') return { ok: false, reason: 'TYPE_UNDETERMINED' };
      return /\.(ts|js|mjs|cjs)$/.test(path)
        ? { ok: true }
        : { ok: false, reason: 'UNSUPPORTED_FILE_TYPE' };
    }
    if (kind === 'themes') {
      if (shape === 'file') {
        return path.endsWith('.json') ? { ok: true } : { ok: false, reason: 'UNSUPPORTED_FILE_TYPE' };
      }
      return hasEntryOfKind(path, 'themes') ? { ok: true } : { ok: false, reason: 'TYPE_UNDETERMINED' };
    }
    // skills and prompt templates are Markdown files or directories holding them.
    if (shape === 'file') {
      return path.endsWith('.md') ? { ok: true } : { ok: false, reason: 'UNSUPPORTED_FILE_TYPE' };
    }
    return hasEntryOfKind(path, kind) ? { ok: true } : { ok: false, reason: 'TYPE_UNDETERMINED' };
  } catch {
    return { ok: false, reason: 'NOT_READABLE' };
  }
}

/**
 * Verifies every selected path before a provider process exists. Throws with the stable code
 * `AGENT_PLUGIN_UNAVAILABLE`, naming the kind, path and reason, so the failure is actionable and
 * the Execution is refused instead of running with a silently reduced selection.
 */
export function assertPiPluginSelectionUsable(selection: AgentPluginSelection | null | undefined): void {
  if (selection === null || selection === undefined) return;
  for (const kind of agentPluginKinds) {
    for (const path of selection[kind]) {
      const verdict = inspectPiPluginPath(kind, path);
      if (!verdict.ok) {
        throw new PiPluginError('AGENT_PLUGIN_UNAVAILABLE',
          `The selected ${kind} path ${JSON.stringify(path)} cannot be loaded (${verdict.reason}); no provider process was started`,
          { kind, path, reason: verdict.reason });
      }
    }
  }
}

/**
 * The provider arguments for one selection, in a stable order: kinds in
 * extensions → skills → prompt templates → themes order, and the user's own order inside a kind.
 * With no selection this returns an empty list, which is what keeps the zero-selection launch
 * byte-identical to the launch before this capability.
 *
 * The caller appends these *after* Codeestra's own `--extension <gate>` / `--extension <question>`
 * pair, so the gate is still the first extension Pi loads and the approval channel is installed
 * before any user extension runs (ADR-0044 D02).
 */
export function buildPiPluginArguments(selection?: AgentPluginSelection | null): readonly string[] {
  if (selection === null || selection === undefined) return [];
  const arguments_: string[] = [];
  for (const kind of agentPluginKinds) {
    for (const path of selection[kind]) arguments_.push(piPluginFlagByKind[kind], path);
  }
  return arguments_;
}

/** True when at least one third-party extension is selected; recorded as an approval-risk fact. */
export function piSelectionLoadsExtensions(selection?: AgentPluginSelection | null): boolean {
  return selection !== null && selection !== undefined && selection.extensions.length > 0;
}

/**
 * The ancestor directories of a path, nearest first. Used by the read-only detection to decide
 * whether a symlink target lives inside a Git working tree — a directory this scan must not walk
 * (ADR-0044 D05: detection never scans a repository directory).
 */
export function ancestorDirectories(path: string): readonly string[] {
  const ancestors: string[] = [];
  let current = resolve(path);
  for (let depth = 0; depth < 64; depth += 1) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

/** Whether a path is inside a Git working tree, decided by an ancestor containing `.git`. */
export function insideGitWorkingTree(path: string): boolean {
  return ancestorDirectories(path).some((directory) => {
    try {
      return lstatSync(join(directory, '.git'), { throwIfNoEntry: false }) !== undefined;
    } catch {
      // A non-directory ancestor (the path itself, or a file on the way up) simply is not a working
      // tree directory; the walk continues with its parents.
      return false;
    }
  });
}

/**
 * Resolves one provider-directory entry the way a candidate is reported: the entry itself plus, for
 * a symlink, the resolved target. Detection reports a symlink whose target cannot be verified
 * without walking a Git working tree as unselectable with `SYMLINK_OUTSIDE_PROVIDER_DIRECTORY`
 * instead of guessing what it contains.
 */
export function resolveDetectionEntry(path: string): {
  readonly entryPath: string;
  readonly resolvedPath: string;
  readonly isSymlink: boolean;
  readonly escapesProviderDirectory: boolean;
  readonly insideGitTree: boolean;
  readonly broken: boolean;
  readonly providerDirectory: string;
} {
  let isSymlink = false;
  try {
    isSymlink = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
  } catch {
    isSymlink = false;
  }
  let resolvedPath = path;
  let broken = false;
  if (isSymlink) {
    try {
      resolvedPath = realpathSync(path);
    } catch {
      broken = true;
    }
  }
  const providerDirectory = dirname(path);
  const escapesProviderDirectory = !resolvedPath.startsWith(`${providerDirectory}${sep}`)
    && resolvedPath !== providerDirectory;
  return {
    entryPath: path,
    resolvedPath,
    isSymlink,
    escapesProviderDirectory,
    insideGitTree: !broken && insideGitWorkingTree(resolvedPath),
    broken,
    providerDirectory,
  };
}
