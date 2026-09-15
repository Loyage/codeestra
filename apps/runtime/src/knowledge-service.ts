import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  KnowledgeError,
  buildKnowledgeSnapshot,
  humanKnowledgeLayerDirectories,
  isMachineGeneratedPath,
  knowledgeContextFileName,
  knowledgeLayerKinds,
  knowledgeLayerOrder,
  knowledgeLayerPolicyVersion,
  knowledgeSnapshotRefs,
  machineGeneratedRuntimeDirectory,
  maxKnowledgeEntriesPerLayer,
  maxKnowledgeProvenanceFieldLength,
  parseKnowledgeEntry,
  parseKnowledgeFrontMatter,
  renderKnowledgeContext,
  selectKnowledgeEntriesForTaskKind,
  type KnowledgeEntry,
  type KnowledgeLayer,
  type KnowledgeLayerKind,
  type KnowledgeMaterialization,
  type KnowledgeSnapshot,
  type KnowledgeTaskKind,
} from '@codeestra/domain';
import type {
  ExecutionKnowledgeSnapshotRecord, Phase1Database, StoredKnowledgeEntry,
} from '@codeestra/storage';

/**
 * The Runtime half of Project Knowledge (FOUNDATION-067 / ADR-0041, `PROJECT_SPEC.md` §4).
 *
 * It does the impure work — reading the human layer out of the project `main` ref, reading the
 * machine-generated layer out of the Runtime data directory, materializing the resolved context
 * into the Execution's own worktree, and recording the binding — and hands the facts to the pure
 * module in `@codeestra/domain`. Every decision that could let a machine overwrite human knowledge
 * or let an Execution claim knowledge it did not use lives in code that fails closed.
 *
 * Three deliberate asymmetries:
 *
 * 1. **The human layer is read from the `main` ref only**, exactly like `.codeestra/policies/
 *    verification.json` and `.codeestra/impact.json`. A Task branch that edits knowledge in its own
 *    worktree cannot change the knowledge its own Execution records, because the ref that is read is
 *    never the branch being judged.
 * 2. **The machine-generated layer is Runtime data** (`<CODEESTRA_HOME>/knowledge/<project-id>/
 *    generated/`), not something inside the project tree. It therefore cannot be committed by
 *    accident and cannot be edited by a Task branch at all.
 * 3. **Invalid knowledge refuses the Execution** (ADR-0041 D04). A human layer that does not parse,
 *    exceeds a bound, or is not UTF-8 text is a refusal with a stable code, not a silent downgrade
 *    to "no knowledge". A missing or empty `generated/` is normal, not an error.
 */

export type KnowledgeServiceErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'TASK_NOT_FOUND'
  | 'KNOWLEDGE_UNREADABLE'
  | 'KNOWLEDGE_LAYER_INVALID'
  | 'KNOWLEDGE_SNAPSHOT_NOT_FOUND'
  | 'KNOWLEDGE_CONTEXT_WRITE_REFUSED';

export class KnowledgeServiceError extends Error {
  constructor(
    readonly code: KnowledgeServiceErrorCode,
    message: string,
    /** Machine-readable facts a code alone cannot carry (today: the per-entry diagnostics). */
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'KnowledgeServiceError';
  }
}

export interface KnowledgeDiagnostic {
  readonly layer: KnowledgeLayer | null;
  readonly path: string | null;
  readonly code: string;
  readonly message: string;
}

export interface KnowledgeLayerReport {
  readonly layer: KnowledgeLayer;
  readonly kind: KnowledgeLayerKind;
  /** Where the layer is read from: a `main`-ref directory, or a Runtime data directory. */
  readonly source: string;
  readonly entryCount: number;
  readonly bytes: number;
}

export interface KnowledgeInspection {
  readonly projectId: string;
  readonly projectName: string;
  readonly repoRoot: string;
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly state: 'VALID' | 'INVALID';
  readonly policyVersion: string;
  readonly errors: readonly KnowledgeDiagnostic[];
  readonly layers: readonly KnowledgeLayerReport[];
  readonly entries: readonly KnowledgeEntry[];
  readonly snapshot: KnowledgeSnapshot | null;
}

/** Where the machine-generated layer of one project lives (read side). */
export function generatedKnowledgeRoot(home: string, projectId: string): string {
  return join(home, machineGeneratedRuntimeDirectory, projectId, 'generated');
}

/**
 * Where one Execution's materialized context lives (write side).
 *
 * Both the read location of the machine-generated layer and the write location of a materialized
 * context are Runtime data, and **nothing is ever written into a Task worktree** (ADR-0041 D05).
 * That is a structural guarantee rather than an ignore rule: an untracked file inside a worktree
 * would enter the Task's Git change set, make every concurrent Task look like it changed the same
 * path (the conflict analyzer reports `SAME_FILE`), and be staged into the result commit by
 * `git add --all`. Keeping machine-generated knowledge out of the repository is what makes
 * "machine-generated knowledge never reaches a commit" true without depending on `.gitignore`.
 */
export function executionKnowledgeRoot(home: string, projectId: string, taskId: string): string {
  return join(home, machineGeneratedRuntimeDirectory, projectId, taskId);
}

// ---------------------------------------------------------------------------------------------
// Git reads. They are local to this service on purpose: the knowledge layer needs to enumerate a
// directory *and* read exact bytes so an encoding failure can be reported instead of silently
// lossy-decoded, which is not what the single-file `readRefFile` helper does.
// ---------------------------------------------------------------------------------------------

interface GitResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

async function runGitBytes(repositoryRoot: string, args: readonly string[]): Promise<GitResult> {
  const child = Bun.spawn(['git', '-C', repositoryRoot, ...args], {
    stdout: 'pipe', stderr: 'pipe', env: { PATH: Bun.env.PATH ?? '' },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout: new Uint8Array(stdout), stderr };
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(bytes: Uint8Array, layer: KnowledgeLayer, path: string): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new KnowledgeError('KNOWLEDGE_INVALID_ENCODING',
      'Knowledge entries must be UTF-8 text', layer, path);
  }
}

async function resolveMainCommit(input: {
  readonly repositoryRoot: string;
  readonly mainRef: string;
}): Promise<string> {
  const resolved = await runGitBytes(input.repositoryRoot,
    ['rev-parse', '--verify', `${input.mainRef}^{commit}`]);
  if (resolved.exitCode !== 0) {
    throw new KnowledgeServiceError('KNOWLEDGE_UNREADABLE',
      `${input.mainRef} does not resolve to a commit in ${input.repositoryRoot}`
        + ` (${resolved.stderr.trim() || `git exited ${resolved.exitCode}`})`);
  }
  return new TextDecoder().decode(resolved.stdout).trim();
}

/** Repository-relative paths of the blobs in `directory` at `commit`. Submodules are not blobs. */
async function listRefTreeBlobs(input: {
  readonly repositoryRoot: string;
  readonly commit: string;
  readonly directory: string;
}): Promise<readonly string[]> {
  const listed = await runGitBytes(input.repositoryRoot,
    ['ls-tree', '-r', '-z', input.commit, '--', input.directory]);
  if (listed.exitCode !== 0) {
    throw new KnowledgeServiceError('KNOWLEDGE_UNREADABLE',
      `Could not list ${input.directory} at ${input.commit}`
        + ` (${listed.stderr.trim() || `git exited ${listed.exitCode}`})`);
  }
  const records = new TextDecoder().decode(listed.stdout).split('\u0000');
  const paths: string[] = [];
  for (const record of records) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const header = record.slice(0, tab).split(' ');
    const type = header[1];
    const path = record.slice(tab + 1);
    if (type !== 'blob') continue;
    paths.push(path);
  }
  return paths;
}

async function readRefBlob(input: {
  readonly repositoryRoot: string;
  readonly commit: string;
  readonly path: string;
  readonly layer: KnowledgeLayer;
}): Promise<string> {
  const blob = await runGitBytes(input.repositoryRoot,
    ['cat-file', 'blob', `${input.commit}:${input.path}`]);
  if (blob.exitCode !== 0) {
    throw new KnowledgeServiceError('KNOWLEDGE_UNREADABLE',
      `Could not read ${input.path} at ${input.commit}`
        + ` (${blob.stderr.trim() || `git exited ${blob.exitCode}`})`);
  }
  return decodeUtf8(blob.stdout, input.layer, input.path);
}

// ---------------------------------------------------------------------------------------------
// Layer loading
// ---------------------------------------------------------------------------------------------

interface LoadedEntry {
  readonly entry: KnowledgeEntry;
  /** The Markdown body without the front matter: what the Agent would actually read. */
  readonly body: string;
}

interface LayerLoadResult {
  readonly layer: KnowledgeLayer;
  readonly source: string;
  readonly entries: readonly LoadedEntry[];
  readonly diagnostics: readonly KnowledgeDiagnostic[];
}

function toDiagnostic(error: unknown, layer: KnowledgeLayer | null,
  path: string | null): KnowledgeDiagnostic | null {
  if (error instanceof KnowledgeError) {
    return {
      layer: error.layer ?? layer,
      path: error.path ?? path,
      code: error.code,
      message: error.message,
    };
  }
  return null;
}

/**
 * Loads one human-maintained layer from the project `main` ref. Only `.md` files are entries; every
 * other extension is ignored without an error. A refused file becomes a diagnostic and the layer
 * carries no snapshot at all.
 */
async function loadHumanLayer(input: {
  readonly repositoryRoot: string;
  readonly mainCommit: string;
  readonly layer: 'instructions' | 'skills';
}): Promise<LayerLoadResult> {
  const directory = humanKnowledgeLayerDirectories[input.layer];
  const diagnostics: KnowledgeDiagnostic[] = [];
  const entries: LoadedEntry[] = [];
  const paths = await listRefTreeBlobs({
    repositoryRoot: input.repositoryRoot,
    commit: input.mainCommit,
    directory,
  });
  const markdown = paths.filter((path) => path.endsWith('.md'));
  let counted: readonly string[] = markdown;
  if (markdown.length > maxKnowledgeEntriesPerLayer) {
    diagnostics.push({
      layer: input.layer,
      path: null,
      code: 'KNOWLEDGE_TOO_MANY_ENTRIES',
      message: `${directory} has ${markdown.length} Markdown entries, over the maximum of`
        + ` ${maxKnowledgeEntriesPerLayer}`,
    });
    counted = [];
  }
  for (const path of counted) {
    try {
      const text = await readRefBlob({
        repositoryRoot: input.repositoryRoot,
        commit: input.mainCommit,
        path,
        layer: input.layer,
      });
      const entry = parseKnowledgeEntry({ layer: input.layer, path, text });
      entries.push({ entry, body: parseKnowledgeFrontMatter(text, input.layer, path).body });
    } catch (error) {
      const diagnostic = toDiagnostic(error, input.layer, path);
      if (diagnostic === null) throw error;
      diagnostics.push(diagnostic);
    }
  }
  return { layer: input.layer, source: `${humanKnowledgeLayerDirectories[input.layer]}`, entries,
    diagnostics };
}

/** Recursively lists regular files under `root`, never following symlinks. Missing root is empty. */
async function listFilesUnder(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  const rootStat = await lstat(root).catch(() => null);
  if (rootStat === null) return found;
  if (!rootStat.isDirectory()) return found;
  const walk = async (relative: string): Promise<void> => {
    const directory = relative.length === 0 ? root : join(root, relative);
    const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      const childRelative = relative.length === 0 ? child.name : `${relative}/${child.name}`;
      if (child.isSymbolicLink()) continue;
      if (child.isDirectory()) await walk(childRelative);
      else if (child.isFile()) found.push(childRelative);
    }
  };
  await walk('');
  return found;
}

const generatedMetaSuffix = '.meta.json';

interface GeneratedMeta {
  readonly origin: { readonly source: string; readonly kind?: string; readonly revision?: string;
    readonly commit?: string };
}

function isProvenanceField(value: unknown): boolean {
  return value === undefined
    || (typeof value === 'string' && value.length > 0 && value.length <= maxKnowledgeProvenanceFieldLength);
}

/**
 * Parses one `<entry>.meta.json`. Provenance is not decoration: `PROJECT_SPEC.md` §4 says the
 * machine-generated layer carries its source and version, so an entry without it is refused rather
 * than accepted as anonymous text.
 */
function parseGeneratedMeta(text: string, path: string): GeneratedMeta {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new KnowledgeError('KNOWLEDGE_GENERATED_PROVENANCE_INVALID',
      `${path} is not valid JSON`, 'generated', path);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new KnowledgeError('KNOWLEDGE_GENERATED_PROVENANCE_INVALID',
      `${path} must be a JSON object`, 'generated', path);
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
    throw new KnowledgeError('KNOWLEDGE_GENERATED_PROVENANCE_INVALID',
      `${path} must declare "version": 1`, 'generated', path);
  }
  if (typeof record.source !== 'string' || record.source.length === 0
    || record.source.length > maxKnowledgeProvenanceFieldLength) {
    throw new KnowledgeError('KNOWLEDGE_GENERATED_PROVENANCE_INVALID',
      `${path} must declare a non-empty "source"`, 'generated', path);
  }
  if (!isProvenanceField(record.kind) || !isProvenanceField(record.revision)
    || !isProvenanceField(record.commit)) {
    throw new KnowledgeError('KNOWLEDGE_GENERATED_PROVENANCE_INVALID',
      `${path} has a provenance field that is not a non-empty string of at most`
        + ` ${maxKnowledgeProvenanceFieldLength} characters`, 'generated', path);
  }
  if (record.generatedAt !== undefined
    && (!Number.isSafeInteger(record.generatedAt) || (record.generatedAt as number) < 0)) {
    throw new KnowledgeError('KNOWLEDGE_GENERATED_PROVENANCE_INVALID',
      `${path} has a "generatedAt" that is not a non-negative integer`, 'generated', path);
  }
  return {
    origin: {
      source: record.source,
      ...(record.kind === undefined ? {} : { kind: record.kind as string }),
      ...(record.revision === undefined ? {} : { revision: record.revision as string }),
      ...(record.commit === undefined ? {} : { commit: record.commit as string }),
    },
  };
}

/**
 * Loads the machine-generated layer out of the Runtime data directory. A missing or empty directory
 * is a valid empty layer (nothing has been generated yet), which is exactly the honest state.
 */
async function loadGeneratedLayer(root: string): Promise<LayerLoadResult> {
  const diagnostics: KnowledgeDiagnostic[] = [];
  const entries: LoadedEntry[] = [];
  const files = await listFilesUnder(root);
  const markdown = files.filter((path) => path.endsWith('.md'));
  if (markdown.length > maxKnowledgeEntriesPerLayer) {
    diagnostics.push({
      layer: 'generated', path: null, code: 'KNOWLEDGE_TOO_MANY_ENTRIES',
      message: `The machine-generated layer has ${markdown.length} entries, over the maximum of`
        + ` ${maxKnowledgeEntriesPerLayer}`,
    });
    return { layer: 'generated', source: root, entries, diagnostics };
  }
  for (const path of markdown) {
    try {
      const text = await readFile(join(root, path), 'utf8');
      const metaPath = `${path.slice(0, -'.md'.length)}${generatedMetaSuffix}`;
      const metaText = await readFile(join(root, metaPath), 'utf8').catch(() => null);
      if (metaText === null) {
        throw new KnowledgeError('KNOWLEDGE_GENERATED_PROVENANCE_MISSING',
          `${path} has no ${metaPath} beside it, so nothing records where its content came from`,
          'generated', path);
      }
      const meta = parseGeneratedMeta(metaText, metaPath);
      const entry = parseKnowledgeEntry({
        layer: 'generated', path, text, origin: meta.origin,
      });
      entries.push({ entry, body: parseKnowledgeFrontMatter(text, 'generated', path).body });
    } catch (error) {
      const diagnostic = toDiagnostic(error, 'generated', path);
      if (diagnostic === null) throw error;
      diagnostics.push(diagnostic);
    }
  }
  return { layer: 'generated', source: root, entries, diagnostics };
}

// ---------------------------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------------------------

/**
 * Reads and validates every layer. It never throws for a *knowledge* problem: a broken layer is
 * reported as `INVALID` with per-entry diagnostics so `project knowledge validate` can show all of
 * them at once, and the callers that must fail closed (Execution start) turn that state into a
 * refusal themselves.
 */
export async function inspectProjectKnowledge(input: {
  readonly storage: Phase1Database;
  readonly home: string;
  readonly projectId: string;
}): Promise<KnowledgeInspection> {
  let project;
  try {
    project = input.storage.getTrustedProject(input.projectId);
  } catch {
    throw new KnowledgeServiceError('PROJECT_NOT_FOUND',
      `No trusted project ${input.projectId}`);
  }
  const mainCommit = await resolveMainCommit({
    repositoryRoot: project.repoRoot,
    mainRef: project.mainRef,
  });
  const layers: LayerLoadResult[] = [];
  for (const layer of ['instructions', 'skills'] as const) {
    layers.push(await loadHumanLayer({
      repositoryRoot: project.repoRoot,
      mainCommit,
      layer,
    }));
  }
  layers.push(await loadGeneratedLayer(generatedKnowledgeRoot(input.home, input.projectId)));

  const diagnostics = layers.flatMap((layer) => layer.diagnostics);
  const allEntries = layers.flatMap((layer) => layer.entries);
  let snapshot: KnowledgeSnapshot | null = null;
  if (diagnostics.length === 0) {
    try {
      snapshot = buildKnowledgeSnapshot({
        mainRef: project.mainRef,
        mainCommit,
        entries: allEntries.map((loaded) => loaded.entry),
      });
    } catch (error) {
      const diagnostic = toDiagnostic(error, null, null);
      if (diagnostic === null) throw error;
      diagnostics.push(diagnostic);
    }
  }
  return {
    projectId: project.id,
    projectName: project.name,
    repoRoot: project.repoRoot,
    mainRef: project.mainRef,
    mainCommit,
    state: diagnostics.length === 0 ? 'VALID' : 'INVALID',
    policyVersion: knowledgeLayerPolicyVersion,
    errors: diagnostics,
    layers: layers.map((layer) => ({
      layer: layer.layer,
      kind: knowledgeLayerKinds[layer.layer],
      source: layer.source,
      entryCount: layer.entries.length,
      bytes: layer.entries.reduce((total, loaded) => total + loaded.entry.bytes, 0),
    })),
    entries: allEntries.map((loaded) => loaded.entry),
    snapshot,
  };
}

// ---------------------------------------------------------------------------------------------
// Fail-closed machine writes
// ---------------------------------------------------------------------------------------------

/**
 * The one gate every machine write goes through. A machine may write only inside the
 * machine-generated area, and it may never name a human-maintained knowledge location — in
 * particular not `<repository>/.codeestra/{instructions,skills,policies}`.
 *
 * The refusal for a human path is a stable code (`KNOWLEDGE_HUMAN_FILE_PROTECTED`) issued *before*
 * any byte is written, and it is deliberately independent of which `root` the caller intended: a
 * caller that points the writer at a repository still cannot name a human knowledge file. It is
 * exported so that property is a testable fact of the command face rather than a rule buried inside
 * one call site.
 */
export function assertMachineGeneratedWriteTarget(input: {
  readonly root: string;
  readonly relativePath: string;
}): string {
  const { relativePath } = input;
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new KnowledgeError('KNOWLEDGE_PATH_INVALID',
      'A machine-generated write needs a non-empty relative path');
  }
  if (relativePath.includes('\u0000') || relativePath.includes('\\')
    || relativePath.startsWith('/') || relativePath.startsWith('~')
    || relativePath !== relativePath.trim()) {
    throw new KnowledgeError('KNOWLEDGE_PATH_INVALID',
      `A machine-generated write path must be a clean relative path: "${relativePath}"`);
  }
  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..' || segment === '.git') {
      throw new KnowledgeError('KNOWLEDGE_PATH_INVALID',
        `A machine-generated write path must not contain empty, "." or ".." segments:`
          + ` "${relativePath}"`);
    }
  }
  // A path under the project `.codeestra/` directory is only allowed inside the machine-generated
  // subtree: `.codeestra/instructions`, `.codeestra/skills` and `.codeestra/policies` are
  // human-maintained, and the refusal is by name so it does not depend on the caller passing the
  // right root. Together with `writeRuntimeKnowledgeFile` deriving its root from the Runtime home,
  // this is what makes "a machine cannot silently overwrite human knowledge" a property of the code
  // rather than a convention.
  if (segments[0] === '.codeestra' && !isMachineGeneratedPath(relativePath)) {
    throw new KnowledgeError('KNOWLEDGE_HUMAN_FILE_PROTECTED',
      `Human-maintained knowledge is never a machine write target: refusing "${relativePath}"`);
  }
  const root = resolve(input.root);
  const absolute = resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new KnowledgeError('KNOWLEDGE_PATH_INVALID',
      `A machine-generated write must stay inside its generated area: "${relativePath}"`);
  }
  return absolute;
}

/**
 * Writes one machine-generated file inside the Runtime's own knowledge directory for a project.
 *
 * There is no parameter for a worktree, a repository root, or an absolute path: the target is always
 * derived from the Runtime home here, so a caller cannot accidentally turn materialized knowledge
 * into a repository file. Symlinks and non-regular existing targets are refused so a write can never
 * follow a link out of the generated area.
 */
export async function writeRuntimeKnowledgeFile(input: {
  readonly home: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly fileName: string;
  readonly content: string;
}): Promise<{ readonly absolutePath: string; readonly relativePath: string; readonly bytes: number }> {
  const relativePath = `${input.taskId}/${input.fileName}`;
  const absolute = assertMachineGeneratedWriteTarget({
    root: join(input.home, machineGeneratedRuntimeDirectory, input.projectId),
    relativePath,
  });
  const existing = await lstat(absolute).catch(() => null);
  if (existing !== null && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new KnowledgeServiceError('KNOWLEDGE_CONTEXT_WRITE_REFUSED',
      `${relativePath} exists and is not a regular file; refusing to overwrite it`);
  }
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, input.content, 'utf8');
  return { absolutePath: absolute, relativePath, bytes: Buffer.byteLength(input.content, 'utf8') };
}

// ---------------------------------------------------------------------------------------------
// Snapshot identity and per-Execution binding
// ---------------------------------------------------------------------------------------------

/**
 * Deterministic snapshot id: the same declared knowledge at the same commit always yields the same
 * id, so recording it twice is a reuse rather than a second row. It is derived from the project id
 * as well, so two projects with identical knowledge never share a primary key.
 */
export function knowledgeSnapshotId(projectId: string, mainCommit: string, digest: string): string {
  return createHash('sha256').update(`${projectId}\u0000${mainCommit}\u0000${digest}`, 'utf8')
    .digest('hex');
}

function toStoredEntry(entry: KnowledgeEntry): StoredKnowledgeEntry {
  return {
    layer: entry.layer,
    path: entry.path,
    id: entry.id,
    scope: entry.scope,
    digest: entry.digest,
    bytes: entry.bytes,
    origin: entry.origin,
  };
}

export interface PreparedExecutionKnowledge {
  readonly snapshot: KnowledgeSnapshot;
  readonly snapshotId: string;
  readonly materialized: KnowledgeMaterialization;
  readonly refs: readonly string[];
  readonly binding: {
    readonly snapshotId: string;
    readonly snapshotDigest: string;
    readonly contextPath: string;
    readonly contextDigest: string;
    readonly contextBytes: number;
    readonly entryCount: number;
    readonly refs: readonly string[];
    readonly commandId: string;
  };
}

/**
 * Reads the Markdown body of every entry of a validated snapshot from the same sources the
 * inspection read. Materialization and the `resolve` preview must share this: a preview that
 * rendered empty bodies would report a digest no Execution would ever bind.
 */
async function readEntryBodies(input: {
  readonly inspection: KnowledgeInspection;
  readonly snapshot: KnowledgeSnapshot;
  readonly home: string;
  readonly projectId: string;
}): Promise<ReadonlyMap<string, string>> {
  const bodies = new Map<string, string>();
  for (const entry of input.snapshot.entries) {
    if (entry.layer === 'generated') {
      const root = generatedKnowledgeRoot(input.home, input.projectId);
      const text = await readFile(join(root, entry.path), 'utf8');
      bodies.set(entry.path, parseKnowledgeFrontMatter(text, 'generated', entry.path).body);
    } else {
      const text = await readRefBlob({
        repositoryRoot: input.inspection.repoRoot,
        commit: input.inspection.mainCommit,
        path: entry.path,
        layer: entry.layer,
      });
      bodies.set(entry.path, parseKnowledgeFrontMatter(text, entry.layer, entry.path).body);
    }
  }
  return bodies;
}

/**
 * Everything an Execution needs before it is allowed to exist: the resolved snapshot recorded
 * append-only, the context materialized into the Execution's own worktree, and the reference list
 * the Adapter receives.
 *
 * This is the fail-closed gate of ADR-0041 D04. It throws — so `reserveExecution` is never reached
 * and no Execution row exists — when a human layer cannot be loaded, and it throws when the
 * materialized context would write outside the Runtime's own knowledge directory.
 *
 * It writes **nothing** into the Task worktree (ADR-0041 D05): the context goes to
 * `<CODEESTRA_HOME>/knowledge/<project-id>/<task-id>/knowledge-context.md`. A worktree file would
 * enter the Task's Git change set, make concurrent Tasks look like they changed the same path, and
 * be staged into the result commit. The recorded `contextPath` is therefore Runtime-relative.
 */
export async function prepareExecutionKnowledge(input: {
  readonly storage: Phase1Database;
  readonly home: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskKind: KnowledgeTaskKind;
  readonly commandId: string;
  readonly now: () => number;
}): Promise<PreparedExecutionKnowledge> {
  const inspection = await inspectProjectKnowledge({
    storage: input.storage, home: input.home, projectId: input.projectId,
  });
  if (inspection.snapshot === null) {
    throw new KnowledgeServiceError('KNOWLEDGE_LAYER_INVALID',
      `Project knowledge at ${inspection.mainRef}@${inspection.mainCommit.slice(0, 12)} could not be`
        + ` loaded, so no Execution may start: ${inspection.errors.length} entr`
        + `${inspection.errors.length === 1 ? 'y' : 'ies'} refused`,
      { diagnostics: inspection.errors, mainRef: inspection.mainRef,
        mainCommit: inspection.mainCommit });
  }
  const snapshot = inspection.snapshot;
  const bodies = await readEntryBodies({
    inspection, snapshot, home: input.home, projectId: input.projectId,
  });
  const materialized = renderKnowledgeContext({
    snapshot,
    taskKind: input.taskKind,
    readBody: (entry) => bodies.get(entry.path) ?? '',
  });
  await writeRuntimeKnowledgeFile({
    home: input.home,
    projectId: input.projectId,
    taskId: input.taskId,
    fileName: materialized.fileName,
    content: materialized.text,
  });
  const contextPath = `${input.taskId}/${materialized.fileName}`;
  const snapshotId = knowledgeSnapshotId(
    input.projectId, snapshot.mainCommit, snapshot.snapshotDigest);
  input.storage.recordKnowledgeSnapshot({
    id: snapshotId,
    projectId: input.projectId,
    mainRef: snapshot.mainRef,
    mainCommit: snapshot.mainCommit,
    policyVersion: snapshot.policyVersion,
    snapshotDigest: snapshot.snapshotDigest,
    humanDigest: snapshot.humanDigest,
    generatedDigest: snapshot.generatedDigest,
    entryCount: snapshot.entryCount,
    humanEntryCount: snapshot.humanEntryCount,
    generatedEntryCount: snapshot.generatedEntryCount,
    totalBytes: snapshot.totalBytes,
    entries: snapshot.entries.map(toStoredEntry),
    createdBy: 'runtime',
    createdAt: input.now(),
  });
  const refs = knowledgeSnapshotRefs(snapshot.snapshotDigest, materialized.entries);
  return {
    snapshot,
    snapshotId,
    materialized,
    refs,
    binding: {
      snapshotId,
      snapshotDigest: snapshot.snapshotDigest,
      contextPath,
      contextDigest: materialized.digest,
      contextBytes: materialized.bytes,
      entryCount: materialized.entries.length,
      refs,
      commandId: input.commandId,
    },
  };
}

/** The references one already-bound Execution must keep using, including for a successor Session. */
export function executionKnowledgeRefs(
  binding: ExecutionKnowledgeSnapshotRecord | null,
): readonly string[] {
  return binding?.refs ?? [];
}

// ---------------------------------------------------------------------------------------------
// Command-face reports
// ---------------------------------------------------------------------------------------------

export interface KnowledgeEntryView {
  readonly layer: KnowledgeLayer;
  readonly kind: KnowledgeLayerKind;
  readonly path: string;
  readonly id: string | null;
  readonly scope: string;
  readonly digest: string;
  readonly bytes: number;
  readonly origin: Readonly<Record<string, string>>;
  readonly appliesToTask: boolean;
}

function entryView(entry: KnowledgeEntry, taskKind: KnowledgeTaskKind | null): KnowledgeEntryView {
  return {
    layer: entry.layer,
    kind: knowledgeLayerKinds[entry.layer],
    path: entry.path,
    id: entry.id,
    scope: entry.scope,
    digest: entry.digest,
    bytes: entry.bytes,
    origin: entry.origin as Readonly<Record<string, string>>,
    appliesToTask: taskKind === null ? true : entry.scope === 'ALL' || entry.scope === taskKind,
  };
}

/**
 * `project knowledge list`: the knowledge a project declares *now*, plus the snapshots already
 * recorded. Read-only: it derives and digests, it never records a snapshot and never starts a Task.
 *
 * It reports the same validity surface as `validate`, because a client that renders both should not
 * have to know that one of them omits the refusal facts.
 */
export interface KnowledgeListReport extends KnowledgeValidateReport {
  readonly entries: readonly KnowledgeEntryView[];
  readonly snapshots: readonly {
    readonly id: string;
    readonly snapshotDigest: string;
    readonly mainCommit: string;
    readonly entryCount: number;
    readonly createdAt: number;
    readonly createdBy: string;
  }[];
}

export async function listProjectKnowledge(input: {
  readonly storage: Phase1Database;
  readonly home: string;
  readonly projectId: string;
  readonly limit?: number;
}): Promise<KnowledgeListReport> {
  const inspection = await inspectProjectKnowledge(input);
  const stored = input.storage.listKnowledgeSnapshots({
    projectId: input.projectId,
    limit: input.limit ?? 20,
  });
  return {
    ...reportFromInspection(inspection),
    entries: inspection.entries.map((entry) => entryView(entry, null)),
    snapshots: stored.map((snapshot) => ({
      id: snapshot.id,
      snapshotDigest: snapshot.snapshotDigest,
      mainCommit: snapshot.mainCommit,
      entryCount: snapshot.entryCount,
      createdAt: snapshot.createdAt,
      createdBy: snapshot.createdBy,
    })),
  };
}

export interface KnowledgeValidateReport {
  readonly projectId: string;
  readonly projectName: string;
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly policyVersion: string;
  readonly valid: boolean;
  readonly state: 'VALID' | 'INVALID';
  readonly code: 'OK' | 'KNOWLEDGE_LAYER_INVALID';
  readonly errors: readonly KnowledgeDiagnostic[];
  readonly layers: readonly KnowledgeLayerReport[];
  readonly snapshotDigest: string | null;
  readonly humanDigest: string | null;
  readonly generatedDigest: string | null;
  readonly entryCount: number;
  readonly humanEntryCount: number;
  readonly generatedEntryCount: number;
  readonly totalBytes: number;
}

export async function validateProjectKnowledge(input: {
  readonly storage: Phase1Database;
  readonly home: string;
  readonly projectId: string;
}): Promise<KnowledgeValidateReport> {
  return reportFromInspection(await inspectProjectKnowledge(input));
}

/** The validity surface `validate` and `list` share, derived from one inspection. */
function reportFromInspection(inspection: KnowledgeInspection): KnowledgeValidateReport {
  return {
    projectId: inspection.projectId,
    projectName: inspection.projectName,
    mainRef: inspection.mainRef,
    mainCommit: inspection.mainCommit,
    policyVersion: inspection.snapshot?.policyVersion ?? inspection.policyVersion,
    valid: inspection.state === 'VALID',
    state: inspection.state,
    code: inspection.state === 'VALID' ? 'OK' : 'KNOWLEDGE_LAYER_INVALID',
    errors: inspection.errors,
    layers: inspection.layers,
    snapshotDigest: inspection.snapshot?.snapshotDigest ?? null,
    humanDigest: inspection.snapshot?.humanDigest ?? null,
    generatedDigest: inspection.snapshot?.generatedDigest ?? null,
    entryCount: inspection.snapshot?.entryCount ?? 0,
    humanEntryCount: inspection.snapshot?.humanEntryCount ?? 0,
    generatedEntryCount: inspection.snapshot?.generatedEntryCount ?? 0,
    totalBytes: inspection.snapshot?.totalBytes ?? 0,
  };
}

export interface KnowledgeSnapshotView {
  readonly snapshot: {
    readonly id: string;
    readonly projectId: string;
    readonly mainRef: string;
    readonly mainCommit: string;
    readonly policyVersion: string;
    readonly snapshotDigest: string;
    readonly humanDigest: string;
    readonly generatedDigest: string;
    readonly entryCount: number;
    readonly humanEntryCount: number;
    readonly generatedEntryCount: number;
    readonly totalBytes: number;
    readonly createdBy: string;
    readonly createdAt: number;
  };
  readonly entries: readonly {
    readonly layer: KnowledgeLayer;
    readonly path: string;
    readonly id: string | null;
    readonly scope: string;
    readonly digest: string;
    readonly bytes: number;
    readonly origin: Readonly<Record<string, string>>;
  }[];
  /** The Executions that actually used this snapshot, with the context they materialized. */
  readonly executions: readonly {
    readonly executionId: string;
    readonly taskId: string;
    readonly taskState: string;
    readonly executionState: string;
    readonly contextPath: string;
    readonly contextDigest: string;
    readonly contextBytes: number;
    readonly entryCount: number;
    readonly refs: readonly string[];
    readonly createdAt: number;
  }[];
}

/**
 * `project knowledge show <project-id> [<snapshot-id>]`: one recorded snapshot and the Executions
 * bound to it. Without an id it shows the most recently recorded snapshot, so the default answer to
 * "which knowledge version is in play here" needs no lookup by hand.
 */
export function showProjectKnowledge(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly snapshotId?: string;
}): KnowledgeSnapshotView {
  let project;
  try {
    project = input.storage.getTrustedProject(input.projectId);
  } catch {
    throw new KnowledgeServiceError('PROJECT_NOT_FOUND', `No trusted project ${input.projectId}`);
  }
  const snapshot = input.snapshotId === undefined
    ? input.storage.listKnowledgeSnapshots({ projectId: project.id, limit: 1 })[0] ?? null
    : input.storage.getKnowledgeSnapshot(input.snapshotId);
  if (snapshot === null || snapshot.projectId !== project.id) {
    throw new KnowledgeServiceError('KNOWLEDGE_SNAPSHOT_NOT_FOUND',
      input.snapshotId === undefined
        ? `Project ${project.name} has no recorded knowledge snapshot yet`
        : `No knowledge snapshot ${input.snapshotId} in project ${project.name}`);
  }
  return {
    snapshot: {
      id: snapshot.id,
      projectId: snapshot.projectId,
      mainRef: snapshot.mainRef,
      mainCommit: snapshot.mainCommit,
      policyVersion: snapshot.policyVersion,
      snapshotDigest: snapshot.snapshotDigest,
      humanDigest: snapshot.humanDigest,
      generatedDigest: snapshot.generatedDigest,
      entryCount: snapshot.entryCount,
      humanEntryCount: snapshot.humanEntryCount,
      generatedEntryCount: snapshot.generatedEntryCount,
      totalBytes: snapshot.totalBytes,
      createdBy: snapshot.createdBy,
      createdAt: snapshot.createdAt,
    },
    entries: snapshot.entries.map((entry) => ({
      layer: entry.layer,
      path: entry.path,
      id: entry.id,
      scope: entry.scope,
      digest: entry.digest,
      bytes: entry.bytes,
      origin: entry.origin as Readonly<Record<string, string>>,
    })),
    executions: input.storage
      .listExecutionKnowledgeSnapshots({ projectId: project.id, limit: 500 })
      .filter((binding) => binding.snapshotId === snapshot.id)
      .map((binding) => {
        const task = input.storage.getTask(project.id, binding.taskId);
        const execution = input.storage.listTaskExecutions(project.id, binding.taskId)
          .find((candidate) => candidate.executionId === binding.executionId);
        return {
          executionId: binding.executionId,
          taskId: binding.taskId,
          taskState: task?.state ?? 'UNKNOWN',
          executionState: execution?.state ?? 'UNKNOWN',
          contextPath: binding.contextPath,
          contextDigest: binding.contextDigest,
          contextBytes: binding.contextBytes,
          entryCount: binding.entryCount,
          refs: binding.refs,
          createdAt: binding.createdAt,
        };
      }),
  };
}

export interface KnowledgeResolveReport {
  readonly projectId: string;
  readonly projectName: string;
  readonly taskId: string;
  readonly taskKind: KnowledgeTaskKind;
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly policyVersion: string;
  readonly state: 'VALID' | 'INVALID';
  readonly errors: readonly KnowledgeDiagnostic[];
  /** Null when the layer is invalid: there is no honest "what it would use" answer then. */
  readonly snapshotDigest: string | null;
  readonly contextPath: string;
  readonly contextDigest: string | null;
  readonly contextBytes: number | null;
  readonly entryCount: number;
  readonly entries: readonly KnowledgeEntryView[];
}

/**
 * `project knowledge resolve <project-id> <task-id>`: what the *next* Execution of this Task would
 * use, without creating anything. The digest it reports is the digest an Execution started right
 * now would bind, which is the point — a user can see the knowledge version before running.
 */
export async function resolveProjectKnowledge(input: {
  readonly storage: Phase1Database;
  readonly home: string;
  readonly projectId: string;
  readonly taskId: string;
}): Promise<KnowledgeResolveReport> {
  const task = input.storage.getTask(input.projectId, input.taskId);
  if (task === null) {
    throw new KnowledgeServiceError('TASK_NOT_FOUND',
      `No Task ${input.taskId} in project ${input.projectId}`);
  }
  const inspection = await inspectProjectKnowledge(input);
  const taskKind: KnowledgeTaskKind = task.kind;
  const selected = inspection.snapshot === null
    ? []
    : selectKnowledgeEntriesForTaskKind(inspection.snapshot.entries, taskKind);
  let contextDigest: string | null = null;
  let contextBytes: number | null = null;
  if (inspection.snapshot !== null) {
    const bodies = await readEntryBodies({
      inspection, snapshot: inspection.snapshot, home: input.home, projectId: input.projectId,
    });
    const materialized = renderKnowledgeContext({
      snapshot: inspection.snapshot,
      taskKind,
      readBody: (entry) => bodies.get(entry.path) ?? '',
    });
    contextDigest = materialized.digest;
    contextBytes = materialized.bytes;
  }
  return {
    projectId: inspection.projectId,
    projectName: inspection.projectName,
    taskId: task.id,
    taskKind,
    mainRef: inspection.mainRef,
    mainCommit: inspection.mainCommit,
    policyVersion: inspection.snapshot?.policyVersion ?? inspection.policyVersion,
    state: inspection.state,
    errors: inspection.errors,
    snapshotDigest: inspection.snapshot?.snapshotDigest ?? null,
    contextPath: `${task.id}/${knowledgeContextFileName}`,
    contextDigest,
    contextBytes,
    entryCount: selected.length,
    entries: selected.map((entry) => entryView(entry, taskKind)),
  };
}

/** Every layer name this policy knows, in load order. Exported for the CLI's own documentation. */
export const knowledgeLayersInOrder: readonly KnowledgeLayer[] = knowledgeLayerOrder;
