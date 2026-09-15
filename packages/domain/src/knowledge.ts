import { createHash } from 'node:crypto';

/**
 * Project Knowledge layering, applicability and snapshot identity (FOUNDATION-067 / ADR-0041,
 * `PROJECT_SPEC.md` §4).
 *
 * This module is pure: it takes already-read file text and already-decided layer/path facts and
 * returns entries, stable failure codes and content digests. It never reads Git, the filesystem, a
 * database, or a model, so the same inputs always produce byte-identical output.
 *
 * The rule everything here serves (invariant 15): human-authored knowledge and machine-generated
 * knowledge stay separated, and a machine can never silently overwrite a human-maintained file. So
 * there is **no override semantics**: every human entry that parses is in the snapshot, nothing is
 * silently dropped, and a duplicate id or a duplicate path is a refusal (a stable code) rather than
 * a "last one wins".
 */

/** Version of the *layer semantics*. A change here invalidates every stored snapshot. */
export const knowledgeLayerPolicyVersion = 'knowledge-layers-v1';

export type KnowledgeLayer = 'instructions' | 'skills' | 'generated';
export type KnowledgeLayerKind = 'HUMAN' | 'MACHINE';
export type KnowledgeTaskKind = 'DEVELOPMENT' | 'SELF';
export type KnowledgeScope = 'ALL' | KnowledgeTaskKind;

/**
 * The fixed load order of the layers. It is a declared constant, not an accident of directory
 * listing: the human layers come first in the order `PROJECT_SPEC.md` §4 lists them, and the
 * machine-generated layer comes last so a reader always sees human intent before derived text.
 * Nothing is overridden by this order — it only fixes listing and rendering order.
 */
export const knowledgeLayerOrder: readonly KnowledgeLayer[] = ['instructions', 'skills', 'generated'];

/** Which layers a human maintains and which one only the Runtime writes. */
export const knowledgeLayerKinds: Readonly<Record<KnowledgeLayer, KnowledgeLayerKind>> = {
  instructions: 'HUMAN',
  skills: 'HUMAN',
  generated: 'MACHINE',
};

/** Repository-relative directories of the human-maintained layers (`PROJECT_SPEC.md` §4). */
export const humanKnowledgeLayerDirectories: Readonly<Record<'instructions' | 'skills', string>> = {
  instructions: '.codeestra/instructions',
  skills: '.codeestra/skills',
};

/**
 * The **only** repository-relative prefix a machine is allowed to write. A write anywhere else in
 * the project — in particular over `.codeestra/instructions`, `.codeestra/skills` or
 * `.codeestra/policies` — is refused with `KNOWLEDGE_HUMAN_FILE_PROTECTED`.
 */
export const machineGeneratedRepositoryDirectory = '.codeestra/generated';

/**
 * Where the machine-generated layer *lives*: under the Runtime data directory, keyed by project id
 * (`<CODEESTRA_HOME>/knowledge/<project-id>/generated/`). It is not inside the project tree, which
 * is why `.codeestra/generated/` is a `.gitignore` guard rather than the storage location
 * (ADR-0041 D05, revising the layout originally sketched in `PROJECT_SPEC.md` §4).
 */
export const machineGeneratedRuntimeDirectory = 'knowledge';

/** Only Markdown entries are loaded. Every other extension is ignored, and that is not an error. */
export const knowledgeFileExtension = '.md';

/** Bounds, so one knowledge directory cannot make loading unbounded. */
export const maxKnowledgeEntryBytes = 65_536;
export const maxKnowledgeEntriesPerLayer = 256;
export const maxKnowledgeSnapshotBytes = 1_048_576;
export const maxKnowledgeSnapshotEntries = 768;
export const maxKnowledgeIdLength = 64;
export const maxKnowledgeFrontMatterLines = 32;
export const maxKnowledgeProvenanceFieldLength = 200;
/** How many entry references one Execution start carries (the materialized entries, in order). */
export const maxKnowledgeSnapshotRefs = 512;

export type KnowledgeErrorCode =
  /** The front matter is present but not the supported top-level scalar subset. */
  | 'KNOWLEDGE_INVALID_FRONT_MATTER'
  | 'KNOWLEDGE_INVALID_ID'
  | 'KNOWLEDGE_INVALID_SCOPE'
  | 'KNOWLEDGE_INVALID_ENCODING'
  | 'KNOWLEDGE_ENTRY_TOO_LARGE'
  | 'KNOWLEDGE_TOO_MANY_ENTRIES'
  | 'KNOWLEDGE_SNAPSHOT_TOO_LARGE'
  | 'KNOWLEDGE_DUPLICATE_ID'
  | 'KNOWLEDGE_DUPLICATE_PATH'
  | 'KNOWLEDGE_PATH_OUTSIDE_LAYER'
  | 'KNOWLEDGE_PATH_INVALID'
  | 'KNOWLEDGE_NOT_MARKDOWN'
  | 'KNOWLEDGE_UNKNOWN_LAYER'
  | 'KNOWLEDGE_GENERATED_PROVENANCE_MISSING'
  | 'KNOWLEDGE_GENERATED_PROVENANCE_INVALID'
  /** A machine tried to write a path that is not the machine-generated area. */
  | 'KNOWLEDGE_HUMAN_FILE_PROTECTED';

/**
 * Stable knowledge failure codes. They carry the layer and the path when they are about a specific
 * entry, because "which file" is the first thing a user needs and a code alone cannot say it.
 */
export class KnowledgeError extends Error {
  constructor(
    readonly code: KnowledgeErrorCode,
    message: string,
    readonly layer?: KnowledgeLayer,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'KnowledgeError';
  }
}

function isLayer(value: unknown): value is KnowledgeLayer {
  return typeof value === 'string' && (knowledgeLayerOrder as readonly string[]).includes(value);
}

const frontMatterKey = /^([A-Za-z][A-Za-z0-9_-]{0,31}):(.*)$/;
const knowledgeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The only front-matter keys this policy understands. An unknown key is a refusal, not a no-op. */
const supportedFrontMatterKeys: readonly string[] = ['id', 'scope'];

export interface KnowledgeFrontMatter {
  readonly frontMatter: Readonly<Record<string, string>>;
  /** The content after the closing delimiter; the whole text when there is no front matter. */
  readonly body: string;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Parses the narrow front-matter subset this policy supports: an optional leading `---` fence whose
 * body contains only top-level `key: scalar` lines, closed by a `---` line.
 *
 * There is deliberately no YAML dependency and no partial YAML: nesting, sequences, multi-line
 * scalars, anchors, comments and unknown keys are all refusals. A knowledge file whose author meant
 * `scope: SELF` and typed `scpoe: SELF` must fail loudly rather than silently load everywhere.
 */
export function parseKnowledgeFrontMatter(text: string, layer?: KnowledgeLayer,
  path?: string): KnowledgeFrontMatter {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    return { frontMatter: {}, body: text };
  }
  const lines = text.split('\n');
  const frontMatter: Record<string, string> = {};
  let closed = false;
  let index = 1;
  for (; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '---' || line === '...') {
      closed = true;
      break;
    }
    if (index - 1 > maxKnowledgeFrontMatterLines) {
      throw new KnowledgeError('KNOWLEDGE_INVALID_FRONT_MATTER',
        `Front matter exceeds ${maxKnowledgeFrontMatterLines} lines`, layer, path);
    }
    if (line.trim().length === 0) continue;
    if (line.startsWith('#') || line.startsWith(' ') || line.startsWith('\t') || line.startsWith('-')) {
      throw new KnowledgeError('KNOWLEDGE_INVALID_FRONT_MATTER',
        `Front matter supports only top-level "key: value" lines: "${line.trim().slice(0, 60)}"`,
        layer, path);
    }
    const match = frontMatterKey.exec(line);
    if (match === null) {
      throw new KnowledgeError('KNOWLEDGE_INVALID_FRONT_MATTER',
        `Front matter line is not "key: value": "${line.trim().slice(0, 60)}"`, layer, path);
    }
    const key = match[1] ?? '';
    const value = stripQuotes((match[2] ?? '').trim());
    if (value.startsWith('[') || value.startsWith('{') || value.startsWith('|') || value.startsWith('>')) {
      throw new KnowledgeError('KNOWLEDGE_INVALID_FRONT_MATTER',
        `Front matter values must be plain scalars; "${key}" is not`, layer, path);
    }
    if (!supportedFrontMatterKeys.includes(key)) {
      throw new KnowledgeError('KNOWLEDGE_INVALID_FRONT_MATTER',
        `Unsupported front-matter key "${key}"; this policy understands only`
          + ` ${supportedFrontMatterKeys.join(', ')}`, layer, path);
    }
    if (Object.prototype.hasOwnProperty.call(frontMatter, key)) {
      throw new KnowledgeError('KNOWLEDGE_INVALID_FRONT_MATTER',
        `Front-matter key "${key}" is declared twice`, layer, path);
    }
    frontMatter[key] = value;
  }
  if (!closed) {
    throw new KnowledgeError('KNOWLEDGE_INVALID_FRONT_MATTER',
      'Front matter opens with "---" but is never closed by a "---" line', layer, path);
  }
  return { frontMatter, body: lines.slice(index + 1).join('\n') };
}

/**
 * Normalizes and validates one entry path. Human entries are repository-relative; generated entries
 * are relative to the Runtime project knowledge directory. Both are validated the same way: a path
 * that leaves its layer, names Git internals, or uses a separator this policy does not write is
 * refused for meaning, and nothing here dereferences the path on the filesystem.
 */
export function normalizeKnowledgePath(raw: unknown, layer: KnowledgeLayer): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new KnowledgeError('KNOWLEDGE_PATH_INVALID', 'Knowledge paths must be non-empty strings',
      layer);
  }
  if (raw.includes('\u0000')) {
    throw new KnowledgeError('KNOWLEDGE_PATH_INVALID', 'Knowledge paths must not contain NUL bytes',
      layer, raw);
  }
  if (raw.includes('\\')) {
    throw new KnowledgeError('KNOWLEDGE_PATH_INVALID',
      `Knowledge paths use "/" as the separator only: "${raw}"`, layer, raw);
  }
  if (raw !== raw.trim()) {
    throw new KnowledgeError('KNOWLEDGE_PATH_INVALID',
      `Knowledge path must not have leading or trailing whitespace: "${raw}"`, layer, raw);
  }
  if (raw.startsWith('/') || raw.startsWith('~')) {
    throw new KnowledgeError('KNOWLEDGE_PATH_INVALID',
      `Knowledge path must be relative: "${raw}"`, layer, raw);
  }
  const segments = raw.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new KnowledgeError('KNOWLEDGE_PATH_INVALID',
        `Knowledge path must not contain empty segments: "${raw}"`, layer, raw);
    }
    if (segment === '.' || segment === '..') {
      throw new KnowledgeError('KNOWLEDGE_PATH_INVALID',
        `Knowledge path must not contain "." or ".." segments: "${raw}"`, layer, raw);
    }
    if (segment === '.git') {
      throw new KnowledgeError('KNOWLEDGE_PATH_INVALID',
        `Knowledge path must not name Git internals: "${raw}"`, layer, raw);
    }
  }
  if (!raw.endsWith(knowledgeFileExtension)) {
    throw new KnowledgeError('KNOWLEDGE_NOT_MARKDOWN',
      `Only ${knowledgeFileExtension} knowledge entries are loaded; "${raw}" is not one`, layer, raw);
  }
  const directory = layer === 'generated' ? null : humanKnowledgeLayerDirectories[layer];
  if (directory !== null && raw !== directory && !raw.startsWith(`${directory}/`)) {
    throw new KnowledgeError('KNOWLEDGE_PATH_OUTSIDE_LAYER',
      `A ${layer} entry must live under ${directory}/; "${raw}" does not`, layer, raw);
  }
  return raw;
}

/** Repository-relative prefix a machine may write under, used by the fail-closed write path. */
export function isMachineGeneratedPath(raw: string): boolean {
  return raw === machineGeneratedRepositoryDirectory
    || raw.startsWith(`${machineGeneratedRepositoryDirectory}/`);
}

export interface KnowledgeEntryOrigin {
  /** Where the content came from, e.g. `execution:<id>`. */
  readonly source?: string;
  /** What produced it, e.g. `runtime.knowledge-context`. */
  readonly kind?: string;
  /** The Task revision the content was derived from, when it was. */
  readonly revision?: string;
  /** The Git commit the content was derived from, when it was. */
  readonly commit?: string;
}

export interface KnowledgeEntry {
  readonly layer: KnowledgeLayer;
  readonly path: string;
  readonly id: string | null;
  readonly scope: KnowledgeScope;
  /** Digest of the entry body (the Markdown after the front matter). */
  readonly digest: string;
  readonly bytes: number;
  readonly origin: KnowledgeEntryOrigin;
}

export interface KnowledgeEntryInput {
  readonly layer: KnowledgeLayer;
  readonly path: string;
  readonly text: string;
  readonly origin?: KnowledgeEntryOrigin;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Validates a provenance field. Empty strings are the honest way to say "not applicable". */
function normalizeOrigin(origin: KnowledgeEntryOrigin | undefined, layer: KnowledgeLayer,
  path: string): KnowledgeEntryOrigin {
  if (origin === undefined) return {};
  const result: Record<string, string> = {};
  for (const key of ['source', 'kind', 'revision', 'commit'] as const) {
    const value = origin[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0
      || value.length > maxKnowledgeProvenanceFieldLength) {
      throw new KnowledgeError('KNOWLEDGE_GENERATED_PROVENANCE_INVALID',
        `Provenance field "${key}" must be a non-empty string of at most`
          + ` ${maxKnowledgeProvenanceFieldLength} characters`, layer, path);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Parses one knowledge file into an entry. Every refusal here is layered on purpose: the caller
 * learns the stable code, the layer and the entry path, and a knowledge layer with any refused
 * entry never becomes a snapshot (ADR-0041 D04: a broken human layer refuses the Execution instead
 * of being quietly degraded).
 */
export function parseKnowledgeEntry(input: KnowledgeEntryInput): KnowledgeEntry {
  const { layer } = input;
  if (!isLayer(layer)) {
    throw new KnowledgeError('KNOWLEDGE_UNKNOWN_LAYER',
      `Unknown knowledge layer "${String(layer)}"`);
  }
  const path = normalizeKnowledgePath(input.path, layer);
  if (input.text.includes('\u0000')) {
    throw new KnowledgeError('KNOWLEDGE_INVALID_ENCODING',
      'Knowledge entries must be text without NUL bytes', layer, path);
  }
  const bytes = new TextEncoder().encode(input.text).length;
  if (bytes > maxKnowledgeEntryBytes) {
    throw new KnowledgeError('KNOWLEDGE_ENTRY_TOO_LARGE',
      `Knowledge entry is ${bytes} bytes, over the ${maxKnowledgeEntryBytes}-byte limit`,
      layer, path);
  }
  const { frontMatter, body } = parseKnowledgeFrontMatter(input.text, layer, path);
  const rawId = frontMatter.id;
  let id: string | null = null;
  if (rawId !== undefined && rawId.length > 0) {
    if (rawId.length > maxKnowledgeIdLength || !knowledgeId.test(rawId)) {
      throw new KnowledgeError('KNOWLEDGE_INVALID_ID',
        `Knowledge id "${rawId}" must match ${knowledgeId.source}`, layer, path);
    }
    id = rawId;
  }
  const rawScope = frontMatter.scope;
  let scope: KnowledgeScope = 'ALL';
  if (rawScope !== undefined && rawScope.length > 0) {
    const candidate = rawScope.toUpperCase();
    if (candidate !== 'ALL' && candidate !== 'DEVELOPMENT' && candidate !== 'SELF') {
      throw new KnowledgeError('KNOWLEDGE_INVALID_SCOPE',
        `Knowledge scope "${rawScope}" must be ALL, DEVELOPMENT or SELF`, layer, path);
    }
    scope = candidate;
  }
  const origin = normalizeOrigin(input.origin, layer, path);
  if (layer === 'generated' && origin.source === undefined) {
    throw new KnowledgeError('KNOWLEDGE_GENERATED_PROVENANCE_MISSING',
      'A machine-generated entry must record where its content came from', layer, path);
  }
  return { layer, path, id, scope, digest: sha256(body), bytes, origin };
}

function layerIndex(layer: KnowledgeLayer): number {
  const index = knowledgeLayerOrder.indexOf(layer);
  return index < 0 ? knowledgeLayerOrder.length : index;
}

/**
 * The order every listing, render and digest uses: layer order first, then the entry path compared
 * as a byte sequence. It is total, so the same entry set always produces the same snapshot bytes.
 */
export function orderKnowledgeEntries(entries: readonly KnowledgeEntry[]): readonly KnowledgeEntry[] {
  const ordered = [...entries].sort((left, right) => {
    const byLayer = layerIndex(left.layer) - layerIndex(right.layer);
    if (byLayer !== 0) return byLayer;
    if (left.path === right.path) return 0;
    return left.path < right.path ? -1 : 1;
  });
  const seenPaths = new Set<string>();
  const seenIds = new Map<string, string>();
  for (const entry of ordered) {
    if (seenPaths.has(entry.path)) {
      throw new KnowledgeError('KNOWLEDGE_DUPLICATE_PATH',
        `Knowledge path "${entry.path}" appears twice`, entry.layer, entry.path);
    }
    seenPaths.add(entry.path);
    if (entry.id === null) continue;
    const previous = seenIds.get(entry.id);
    if (previous !== undefined) {
      throw new KnowledgeError('KNOWLEDGE_DUPLICATE_ID',
        `Knowledge id "${entry.id}" is declared by both "${previous}" and "${entry.path}";`
          + ' this policy has no override semantics, so the snapshot would be ambiguous',
        entry.layer, entry.path);
    }
    seenIds.set(entry.id, entry.path);
  }
  return ordered;
}

/**
 * Whether an entry applies to a Task kind. `ALL` applies everywhere; `DEVELOPMENT` and `SELF` are
 * the Task kinds the schema already has, so applicability reuses an existing domain fact instead of
 * inventing a second vocabulary for it.
 */
export function knowledgeEntryAppliesToTaskKind(entry: KnowledgeEntry, kind: KnowledgeTaskKind): boolean {
  return entry.scope === 'ALL' || entry.scope === kind;
}

export function selectKnowledgeEntriesForTaskKind(entries: readonly KnowledgeEntry[],
  kind: KnowledgeTaskKind): readonly KnowledgeEntry[] {
  return entries.filter((entry) => knowledgeEntryAppliesToTaskKind(entry, kind));
}

function canonicalEntry(entry: KnowledgeEntry): Record<string, unknown> {
  const origin: Record<string, string> = {};
  // Fixed key order: `generatedAt` is deliberately absent (a timestamp is not knowledge identity,
  // so regenerating identical content does not invalidate a snapshot).
  if (entry.origin.commit !== undefined) origin.commit = entry.origin.commit;
  if (entry.origin.kind !== undefined) origin.kind = entry.origin.kind;
  if (entry.origin.revision !== undefined) origin.revision = entry.origin.revision;
  if (entry.origin.source !== undefined) origin.source = entry.origin.source;
  return {
    layer: entry.layer,
    path: entry.path,
    id: entry.id,
    scope: entry.scope,
    digest: entry.digest,
    origin,
  };
}

/** Digest over an ordered entry set. Includes layer, path and provenance, per ADR-0041 D07. */
export function knowledgeEntriesDigest(entries: readonly KnowledgeEntry[]): string {
  return sha256(JSON.stringify(entries.map(canonicalEntry)));
}

export interface KnowledgeSnapshotInput {
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly entries: readonly KnowledgeEntry[];
}

export interface KnowledgeSnapshot {
  readonly policyVersion: string;
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly entries: readonly KnowledgeEntry[];
  readonly snapshotDigest: string;
  readonly humanDigest: string;
  readonly generatedDigest: string;
  readonly entryCount: number;
  readonly humanEntryCount: number;
  readonly generatedEntryCount: number;
  readonly totalBytes: number;
}

/**
 * Builds the immutable knowledge snapshot for one project `main` commit.
 *
 * An empty snapshot is valid: a project that maintains no knowledge is a fact, not an error. What
 * is *not* valid is a snapshot with a refused entry — that refusal happens while the entries are
 * parsed, so it can never be observed here.
 */
export function buildKnowledgeSnapshot(input: KnowledgeSnapshotInput): KnowledgeSnapshot {
  const entries = orderKnowledgeEntries(input.entries);
  if (entries.length > maxKnowledgeSnapshotEntries) {
    throw new KnowledgeError('KNOWLEDGE_TOO_MANY_ENTRIES',
      `Knowledge snapshot has ${entries.length} entries, over the maximum of`
        + ` ${maxKnowledgeSnapshotEntries}`);
  }
  const perLayer = new Map<KnowledgeLayer, number>();
  let totalBytes = 0;
  for (const entry of entries) {
    const count = (perLayer.get(entry.layer) ?? 0) + 1;
    if (count > maxKnowledgeEntriesPerLayer) {
      throw new KnowledgeError('KNOWLEDGE_TOO_MANY_ENTRIES',
        `Layer has more than ${maxKnowledgeEntriesPerLayer} entries`, entry.layer);
    }
    perLayer.set(entry.layer, count);
    totalBytes += entry.bytes;
  }
  if (totalBytes > maxKnowledgeSnapshotBytes) {
    throw new KnowledgeError('KNOWLEDGE_SNAPSHOT_TOO_LARGE',
      `Knowledge snapshot is ${totalBytes} bytes, over the maximum of`
        + ` ${maxKnowledgeSnapshotBytes}`);
  }
  const human = entries.filter((entry) => entry.layer !== 'generated');
  const generated = entries.filter((entry) => entry.layer === 'generated');
  const snapshotDigest = sha256(JSON.stringify({
    policyVersion: knowledgeLayerPolicyVersion,
    mainRef: input.mainRef,
    mainCommit: input.mainCommit,
    entries: entries.map(canonicalEntry),
  }));
  return {
    policyVersion: knowledgeLayerPolicyVersion,
    mainRef: input.mainRef,
    mainCommit: input.mainCommit,
    entries,
    snapshotDigest,
    humanDigest: knowledgeEntriesDigest(human),
    generatedDigest: knowledgeEntriesDigest(generated),
    entryCount: entries.length,
    humanEntryCount: human.length,
    generatedEntryCount: generated.length,
    totalBytes,
  };
}

export interface KnowledgeMaterialization {
  readonly entries: readonly KnowledgeEntry[];
  readonly text: string;
  readonly digest: string;
  readonly bytes: number;
  /**
   * The name of the one file one Execution materializes. It is a *name*, not a repository path:
   * materialized knowledge is Runtime data, so no caller may treat it as something to write into a
   * Task worktree (ADR-0041 D05).
   */
  readonly fileName: string;
}

/** The one file one Execution materializes into its own worktree. */
export const knowledgeContextFileName = 'knowledge-context.md';

/**
 * Renders the entries that apply to one Task kind into deterministic Markdown, and digests the exact
 * bytes that will be written. The header names the source commit and the snapshot digest, so the
 * file itself is the provenance of what the Agent could read.
 */
export function renderKnowledgeContext(input: {
  readonly snapshot: KnowledgeSnapshot;
  readonly taskKind: KnowledgeTaskKind;
  readonly readBody: (entry: KnowledgeEntry) => string;
}): KnowledgeMaterialization {
  const entries = selectKnowledgeEntriesForTaskKind(input.snapshot.entries, input.taskKind);
  if (entries.length > maxKnowledgeSnapshotRefs - 1) {
    throw new KnowledgeError('KNOWLEDGE_TOO_MANY_ENTRIES',
      `Materialized knowledge has ${entries.length} entries, over the maximum of`
        + ` ${maxKnowledgeSnapshotRefs - 1}`);
  }
  const lines: string[] = [
    '<!--',
    `Generated by Codeestra Runtime. Machine-generated knowledge area: ${machineGeneratedRepositoryDirectory}/.`,
    'Do not edit by hand: the next Execution overwrites this file.',
    `Policy: ${input.snapshot.policyVersion}`,
    `Source: ${input.snapshot.mainRef}@${input.snapshot.mainCommit}`,
    `Snapshot digest: ${input.snapshot.snapshotDigest}`,
    `Task kind: ${input.taskKind}`,
    `Entries: ${entries.length}`,
    '-->',
    '',
    '# Project knowledge',
    '',
  ];
  for (const entry of entries) {
    lines.push(`## ${entry.path}`, '');
    const provenance: string[] = [`layer: ${entry.layer}`, `digest: ${entry.digest}`];
    if (entry.id !== null) provenance.push(`id: ${entry.id}`);
    provenance.push(`scope: ${entry.scope}`);
    if (entry.origin.source !== undefined) provenance.push(`source: ${entry.origin.source}`);
    if (entry.origin.kind !== undefined) provenance.push(`origin: ${entry.origin.kind}`);
    if (entry.origin.revision !== undefined) provenance.push(`revision: ${entry.origin.revision}`);
    if (entry.origin.commit !== undefined) provenance.push(`commit: ${entry.origin.commit}`);
    lines.push(provenance.join(' | '), '');
    const body = input.readBody(entry);
    lines.push(body.endsWith('\n') ? body.slice(0, -1) : body, '');
  }
  const text = lines.join('\n');
  const bytes = new TextEncoder().encode(text).length;
  return {
    entries,
    text,
    digest: sha256(text),
    bytes,
    fileName: knowledgeContextFileName,
  };
}

/**
 * One Execution's binding to the knowledge it actually used. The reference strings are what the
 * Adapter receives: a whole-snapshot reference first, then one reference per materialized entry, so
 * a Session that stored them alone could still name the exact knowledge it ran with.
 */
export function knowledgeSnapshotRefs(snapshotDigest: string,
  entries: readonly KnowledgeEntry[]): readonly string[] {
  return [
    `knowledge-snapshot:${snapshotDigest}`,
    ...entries.map((entry) =>
      `knowledge-entry:${entry.layer}:${entry.path}#${entry.digest.slice(0, 12)}`),
  ];
}
