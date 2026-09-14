import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * Human-maintained impact mapping for conservative conflict analysis (ADR-0031,
 * `docs/architecture/conflict-analyzer.md`).
 *
 * It is read from the project `main` ref only, exactly like the verification policy: a Task branch
 * can therefore never widen or narrow the mapping that judges its own concurrency. The file is a
 * *declaration*, not an inference: nothing here is guessed from code, filenames, or an Agent's
 * prose. A missing or unparsable mapping never yields `SAFE` — it makes every ImpactSnapshot
 * incomplete, and an incomplete impact is `UNKNOWN`.
 */
export const impactPolicyPath = '.codeestra/impact.json';
/** Version of the mapping *semantics*, independent of the confirmed content digest. */
export const impactPolicyVersion = 'impact-policy-v1';
/** Bounds, so one policy cannot make analysis unbounded. */
export const maxImpactPolicyEntries = 512;
export const maxImpactPathPatternsPerEntry = 64;
export const maxImpactPathLength = 400;

/**
 * Stable failure codes for reading a mapping. They are distinct on purpose: "there is no mapping",
 * "the mapping is not valid JSON/schema" and "the mapping was never confirmed" are different facts
 * and only the first one is legitimate.
 */
export type ImpactPolicyErrorCode =
  | 'INVALID_IMPACT_POLICY'
  | 'IMPACT_POLICY_NOT_CONFIRMED'
  | 'IMPACT_POLICY_UNREADABLE';

export class ImpactPolicyError extends Error {
  constructor(readonly code: ImpactPolicyErrorCode, message: string) {
    super(message);
    this.name = 'ImpactPolicyError';
  }
}

/**
 * Normalizes and validates one repository-relative path.
 *
 * Paths are compared as *names* against a Git change set, never dereferenced on the filesystem, so
 * "escaping the repository" is refused for meaning rather than for access: a declaration that
 * leaves the repository describes a path no change set can ever contain. Absolute paths, `~`,
 * `.`/`..` segments, Windows separators, NUL bytes and `.git` internals are all refused, so a
 * declaration can only ever name something inside the repository. Symlinks cannot be followed
 * because nothing here is opened: both the mapping (`git cat-file`) and the change set
 * (`git diff --name-status`) are read straight from Git objects.
 */
export function normalizeImpactPath(raw: unknown, kind: 'directory' | 'file' | 'subtree' | 'pattern'): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ImpactPolicyError('INVALID_IMPACT_POLICY', 'Impact paths must be non-empty strings');
  }
  if (raw.length > maxImpactPathLength) {
    throw new ImpactPolicyError('INVALID_IMPACT_POLICY',
      `Impact path exceeds ${maxImpactPathLength} characters: ${raw.slice(0, 40)}…`);
  }
  if (raw !== raw.trim()) {
    throw new ImpactPolicyError('INVALID_IMPACT_POLICY',
      `Impact path must not have leading or trailing whitespace: "${raw}"`);
  }
  if (raw.includes('\u0000')) {
    throw new ImpactPolicyError('INVALID_IMPACT_POLICY', 'Impact path must not contain NUL bytes');
  }
  if (raw.includes('\\')) {
    throw new ImpactPolicyError('INVALID_IMPACT_POLICY',
      `Impact paths use "/" as the separator only: "${raw}"`);
  }
  if (isAbsolute(raw) || raw.startsWith('~') || raw.startsWith('/')) {
    throw new ImpactPolicyError('INVALID_IMPACT_POLICY',
      `Impact path must be relative to the repository root: "${raw}"`);
  }
  const head = kind === 'pattern' && raw.endsWith('/**') ? raw.slice(0, -3) : raw;
  if (head.length === 0) {
    throw new ImpactPolicyError('INVALID_IMPACT_POLICY', 'Impact path must not be the repository root');
  }
  const segments = head.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new ImpactPolicyError('INVALID_IMPACT_POLICY',
        `Impact path must not contain empty segments: "${raw}"`);
    }
    if (segment === '.' || segment === '..') {
      throw new ImpactPolicyError('INVALID_IMPACT_POLICY',
        `Impact path must not contain "." or ".." segments: "${raw}"`);
    }
    if (segment === '.git') {
      throw new ImpactPolicyError('INVALID_IMPACT_POLICY',
        `Impact path must not name Git internals: "${raw}"`);
    }
  }
  const wildcards = [...raw].filter((character) => '*?[]'.includes(character));
  if (kind === 'pattern') {
    // The only accepted wildcard form is a trailing `/**` directory subtree. Anything else would
    // need hand-rolled glob semantics, which is exactly where "no overlap" would stop being provable.
    if (raw.endsWith('/**')) {
      if (wildcards.length !== 2) {
        throw new ImpactPolicyError('INVALID_IMPACT_POLICY',
          `Only a trailing "/**" subtree pattern is supported: "${raw}"`);
      }
    } else if (wildcards.length > 0) {
      throw new ImpactPolicyError('INVALID_IMPACT_POLICY',
        `Only a trailing "/**" subtree pattern is supported: "${raw}"`);
    }
  } else if (kind === 'subtree') {
    if (!raw.endsWith('/**') || wildcards.length !== 2) {
      throw new ImpactPolicyError('INVALID_IMPACT_POLICY',
        `Subtree paths must be written as "dir/**": "${raw}"`);
    }
  } else if (wildcards.length > 0) {
    throw new ImpactPolicyError('INVALID_IMPACT_POLICY',
      `Wildcards are not allowed in a ${kind} path: "${raw}"`);
  }
  if (kind === 'file' && raw.endsWith('/')) {
    throw new ImpactPolicyError('INVALID_IMPACT_POLICY',
      `A file path must not end with "/": "${raw}"`);
  }
  return raw;
}

function impactPathSchema(kind: 'directory' | 'file' | 'subtree' | 'pattern') {
  return z.string().superRefine((value, context) => {
    try {
      normalizeImpactPath(value, kind);
    } catch (error) {
      context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) });
    }
  });
}

/**
 * One declared module: an ID plus the paths that belong to it. Whole-file overlap between two
 * revisions that touch *different* files of the same module is a conflict, which is why modules are
 * declared instead of inferred.
 */
export const impactModuleSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    'Module IDs use letters, digits, dot, dash, or underscore'),
  paths: z.array(impactPathSchema('pattern')).min(1).max(maxImpactPathPatternsPerEntry),
});
export type ImpactModule = z.infer<typeof impactModuleSchema>;

/**
 * How the files that *depend on* a shared resource are known.
 *
 * `UNKNOWN` is the honest default and the safe one: if a resource is written and its consumers were
 * never declared, no assessment may return `SAFE`, because "nobody reads the lockfile" is a claim
 * nobody made. `DECLARED` with an empty list is a deliberate statement that the resource has no
 * consumers Codeestra needs to track.
 */
export const impactConsumersSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('UNKNOWN') }),
  z.strictObject({
    state: z.literal('DECLARED'),
    paths: z.array(impactPathSchema('pattern')).max(maxImpactPathPatternsPerEntry),
  }),
]);
export type ImpactConsumers = z.infer<typeof impactConsumersSchema>;

/**
 * Kinds of shared resource that create read/write hazards across Task boundaries: touching a public
 * API, a lockfile, a schema migration, or shared build/test configuration affects Tasks that never
 * touch the same file.
 */
export const impactGlobalResourceKindSchema = z.enum([
  'PUBLIC_API', 'DEPENDENCY_LOCKFILE', 'SCHEMA_MIGRATION', 'BUILD_CONFIG', 'TEST_CONFIG',
  'GENERATED_OUTPUT', 'PROJECT_POLICY',
]);
export type ImpactGlobalResourceKind = z.infer<typeof impactGlobalResourceKindSchema>;

export const impactGlobalResourceSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    'Resource IDs use letters, digits, dot, dash, or underscore'),
  kind: impactGlobalResourceKindSchema,
  /** The resource's own files. A `dir/**` entry means the whole subtree is the resource. */
  paths: z.array(impactPathSchema('pattern')).min(1).max(maxImpactPathPatternsPerEntry),
  consumers: impactConsumersSchema,
});
export type ImpactGlobalResource = z.infer<typeof impactGlobalResourceSchema>;

/**
 * The mapping itself. Every list may be empty: an empty mapping is *valid* but useless — it makes
 * every snapshot incomplete, which is `UNKNOWN`, not an error and never `SAFE`.
 */
export const impactPolicySchema = z.strictObject({
  version: z.literal(1),
  /** Directories whose overlap is a conflict, compared by path component (`src/map` ≠ `src/mapping`). */
  importantDirectories: z.array(impactPathSchema('directory')).max(maxImpactPolicyEntries),
  modules: z.array(impactModuleSchema).max(maxImpactPolicyEntries),
  globalResources: z.array(impactGlobalResourceSchema).max(maxImpactPolicyEntries),
}).superRefine((policy, context) => {
  const directoryKeys = new Set<string>();
  for (const [index, directory] of policy.importantDirectories.entries()) {
    if (directoryKeys.has(directory)) {
      context.addIssue({ code: 'custom', path: ['importantDirectories', index],
        message: `Duplicate important directory "${directory}"` });
    }
    directoryKeys.add(directory);
  }
  const moduleIds = new Set<string>();
  for (const [index, module] of policy.modules.entries()) {
    if (moduleIds.has(module.id)) {
      context.addIssue({ code: 'custom', path: ['modules', index, 'id'],
        message: `Duplicate module ID "${module.id}"` });
    }
    moduleIds.add(module.id);
    const seen = new Set<string>();
    for (const [pathIndex, path] of module.paths.entries()) {
      if (seen.has(path)) {
        context.addIssue({ code: 'custom', path: ['modules', index, 'paths', pathIndex],
          message: `Duplicate path pattern "${path}"` });
      }
      seen.add(path);
    }
  }
  const resourceIds = new Set<string>();
  for (const [index, resource] of policy.globalResources.entries()) {
    if (resourceIds.has(resource.id)) {
      context.addIssue({ code: 'custom', path: ['globalResources', index, 'id'],
        message: `Duplicate global resource ID "${resource.id}"` });
    }
    resourceIds.add(resource.id);
    const seen = new Set<string>();
    for (const [pathIndex, path] of resource.paths.entries()) {
      if (seen.has(path)) {
        context.addIssue({ code: 'custom', path: ['globalResources', index, 'paths', pathIndex],
          message: `Duplicate path pattern "${path}"` });
      }
      seen.add(path);
    }
    if (resource.consumers.state === 'DECLARED') {
      const consumerSeen = new Set<string>();
      for (const [pathIndex, path] of resource.consumers.paths.entries()) {
        if (consumerSeen.has(path)) {
          context.addIssue({ code: 'custom',
            path: ['globalResources', index, 'consumers', 'paths', pathIndex],
            message: `Duplicate path pattern "${path}"` });
        }
        consumerSeen.add(path);
      }
    }
  }
});
export type ImpactPolicy = z.infer<typeof impactPolicySchema>;

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? 'policy' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/** Parses mapping text as delivered by Git. Unknown keys and bad values fail closed. */
export function parseImpactPolicy(text: string): ImpactPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ImpactPolicyError('INVALID_IMPACT_POLICY', `${impactPolicyPath} is not valid JSON`);
  }
  const parsed = impactPolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ImpactPolicyError('INVALID_IMPACT_POLICY',
      `${impactPolicyPath} is not a valid impact mapping: ${describe(parsed.error)}`);
  }
  return parsed.data;
}

/** True when the mapping declares no scope at all. Valid, useless, and never enough for `SAFE`. */
export function impactPolicyIsEmpty(policy: ImpactPolicy): boolean {
  return policy.importantDirectories.length === 0 && policy.modules.length === 0
    && policy.globalResources.length === 0;
}

/**
 * Content digest over the normalized mapping. The confirmation and every ImpactSnapshot bind this
 * digest, so editing any declared path requires a new explicit confirmation and invalidates every
 * snapshot taken under the old one.
 */
export function impactPolicyDigest(policy: ImpactPolicy): string {
  const canonical = {
    version: policy.version,
    importantDirectories: [...policy.importantDirectories],
    modules: policy.modules.map((module) => ({ id: module.id, paths: [...module.paths] }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    globalResources: policy.globalResources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      paths: [...resource.paths],
      consumers: resource.consumers.state === 'UNKNOWN'
        ? { state: 'UNKNOWN' }
        : { state: 'DECLARED', paths: [...resource.consumers.paths] },
    })).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Short human-readable label for a confirmed mapping; this is the invalidation key component. */
export function impactPolicyLabel(digest: string): string {
  return `${impactPolicyVersion}#${digest.slice(0, 12)}`;
}

const objectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What the user explicitly confirmed about a project's impact mapping (`project trust`, the same
 * event that confirms the verification policy).
 *
 * `ABSENT` means the project declares no mapping; `INVALID` keeps the digest of the raw bytes so a
 * broken mapping is a recorded fact instead of being silently reported as "no mapping".
 */
export const impactPolicyConfirmationSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ABSENT'), mainCommit: objectIdSchema }),
  z.strictObject({
    state: z.literal('PRESENT'),
    mainCommit: objectIdSchema,
    digest: digestSchema,
  }),
  z.strictObject({
    state: z.literal('INVALID'),
    mainCommit: objectIdSchema,
    contentDigest: digestSchema,
    code: z.string().min(1).max(120),
  }),
]);
export type ImpactPolicyConfirmation = z.infer<typeof impactPolicyConfirmationSchema>;

/** Read-only inspection result shown to the user before trust and stored with it. */
export interface ImpactPolicyInspection {
  readonly state: 'ABSENT' | 'PRESENT' | 'INVALID';
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly digest?: string;
  readonly contentDigest?: string;
  readonly label?: string;
  readonly policy?: ImpactPolicy;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/** Digest of the raw bytes, used only to identify a mapping that could not be parsed. */
export function impactPolicyContentDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
