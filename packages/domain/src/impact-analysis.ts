import { DomainError } from './errors.js';

/**
 * Deterministic, reproducible conflict analysis (`docs/architecture/conflict-analyzer.md` §2–§4,
 * ADR-0031).
 *
 * This module is pure: it takes an already-observed change set, an already-parsed mapping, and
 * already-decided completeness facts, and returns a verdict with stable reason codes and the exact
 * intersecting scope. It never reads Git, the filesystem, a database, or a model, so the same inputs
 * always produce byte-identical output.
 *
 * The one rule that everything here serves (PROJECT_SPEC §2.6): `UNKNOWN` means "cannot be proven",
 * not "no conflict found". Nothing in this module may return `SAFE_TO_PARALLELIZE` from a missing
 * mapping, an unreadable change set, an incomplete snapshot, or a stale fact.
 */

/** Version of the *analysis semantics*. A change here invalidates every stored snapshot. */
export const impactAnalyzerVersion = 'impact-analyzer-v1';
/** Upper bound for one change set; a larger one is recorded as incomplete, never as safe. */
export const maxImpactFiles = 4_000;
/** How many intersecting paths one finding reports before it is summarized by count. */
export const maxImpactHitPaths = 32;

export type ImpactVerdict = 'SAFE_TO_PARALLELIZE' | 'UNKNOWN' | 'CONFLICTING';

/**
 * Path case behavior of the repository filesystem. It is measured, not assumed
 * (`detectImpactPathCaseMode` in the Runtime service): on a case-insensitive filesystem two paths
 * that differ only by case name the same file, so they must be compared as one.
 */
export type ImpactPathCaseMode = 'SENSITIVE' | 'INSENSITIVE';

/**
 * Why a snapshot is not a complete description of the revision's impact. Any entry here makes the
 * snapshot `complete = false`, and an incomplete snapshot can never take part in `SAFE`.
 */
export type ImpactIncompleteReason =
  /** The project declares no impact mapping at all. */
  | 'POLICY_ABSENT'
  /** The declared mapping is not valid JSON or not a valid mapping. */
  | 'POLICY_INVALID'
  /** The declared mapping changed since the user confirmed it. */
  | 'POLICY_NOT_CONFIRMED'
  /** The mapping is valid but declares no directory, module, or shared resource. */
  | 'EMPTY_MAPPING'
  /** A shared resource the revision writes has no declared consumers, so its effect is unbounded. */
  | 'UNCERTAIN_GLOBAL_EFFECT'
  /** The change set was too large to describe completely. */
  | 'UNBOUNDED_SCOPE';

/** Stable reason codes. They are the machine-readable half of an explanation. */
export type ImpactReasonCode =
  | 'SAME_FILE'
  | 'IMPORTANT_DIRECTORY_OVERLAP'
  | 'SAME_MODULE'
  | 'GLOBAL_RESOURCE'
  | 'GLOBAL_RESOURCE_DEPENDENCY'
  | 'INCOMPLETE_IMPACT'
  | 'MISSING_IMPACT_SNAPSHOT'
  | 'STALE_BASE'
  | 'STALE_REVISION'
  | 'STALE_POLICY'
  | 'STALE_ANALYZER'
  | 'ACTUAL_DIFF_EXCEEDS_SNAPSHOT'
  | 'SNAPSHOT_SCOPE_MISMATCH'
  | 'INVALID_SCOPE'
  | 'NO_CONFLICT';

/**
 * Grouping of a reason code. `STALE_OR_INVALID` is the stable name of the spec's
 * `stale_or_invalid` verdict branch; the codes inside it stay distinct because "the base moved" and
 * "the analyzer changed" have different remedies.
 */
export type ImpactReasonClass = 'CONFLICT' | 'INCOMPLETE' | 'STALE_OR_INVALID' | 'SAFE';

export function impactReasonClass(code: ImpactReasonCode): ImpactReasonClass {
  switch (code) {
    case 'SAME_FILE':
    case 'IMPORTANT_DIRECTORY_OVERLAP':
    case 'SAME_MODULE':
    case 'GLOBAL_RESOURCE':
    case 'GLOBAL_RESOURCE_DEPENDENCY':
      return 'CONFLICT';
    case 'INCOMPLETE_IMPACT':
    case 'MISSING_IMPACT_SNAPSHOT':
      return 'INCOMPLETE';
    case 'STALE_BASE':
    case 'STALE_REVISION':
    case 'STALE_POLICY':
    case 'STALE_ANALYZER':
    case 'ACTUAL_DIFF_EXCEEDS_SNAPSHOT':
    case 'SNAPSHOT_SCOPE_MISMATCH':
    case 'INVALID_SCOPE':
      return 'STALE_OR_INVALID';
    case 'NO_CONFLICT':
      return 'SAFE';
  }
}

/** One shared resource this revision touches, and how. */
export interface ImpactGlobalResourceRef {
  readonly id: string;
  readonly kind: string;
  /** The revision changes the resource's own files. */
  readonly written: boolean;
  /** The revision changes a file declared to depend on the resource. */
  readonly read: boolean;
}

/**
 * The declared half of the analysis, structurally identical to the parsed `impact.json`
 * (`@codeestra/contracts`). Declared here as a structural interface so the domain stays free of
 * framework and package dependencies.
 */
export interface ImpactMapping {
  readonly importantDirectories: readonly string[];
  readonly modules: readonly {
    readonly id: string;
    readonly paths: readonly string[];
  }[];
  readonly globalResources: readonly {
    readonly id: string;
    readonly kind: string;
    readonly paths: readonly string[];
    readonly consumers:
      | { readonly state: 'UNKNOWN' }
      | { readonly state: 'DECLARED'; readonly paths: readonly string[] };
  }[];
}

export interface ImpactSnapshot {
  readonly taskId: string;
  readonly revisionId: string;
  readonly baseCommit: string;
  readonly analyzerVersion: string;
  /** Version *and* content: `impact-policy-v1#<digest prefix>`. Any edit invalidates snapshots. */
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly caseMode: ImpactPathCaseMode;
  /** Fingerprint of the observed change set, so two snapshots of one revision stay distinguishable. */
  readonly changeFingerprint: string;
  readonly complete: boolean;
  readonly incompleteReasons: readonly ImpactIncompleteReason[];
  /** Every path the revision changes, renames counted as old *and* new, sorted and unique. */
  readonly files: readonly string[];
  /** Declared important directories this revision's change set falls into. */
  readonly importantDirectories: readonly string[];
  /** Declared module IDs this revision's change set falls into. */
  readonly modules: readonly string[];
  readonly globalResources: readonly ImpactGlobalResourceRef[];
  /** Changed paths the mapping does not classify; reported, never treated as "no impact". */
  readonly unclassifiedFiles: readonly string[];
  readonly evidence: readonly string[];
}

export interface CreateImpactSnapshotInput {
  readonly taskId: string;
  readonly revisionId: string;
  readonly baseCommit: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly caseMode: ImpactPathCaseMode;
  /** Raw paths as Git reported them; rename entry points included by the caller. */
  readonly paths: readonly string[];
  readonly changeFingerprint: string;
  /** `null` when no usable mapping exists; then an incomplete reason must be supplied. */
  readonly mapping: ImpactMapping | null;
  /** Facts the caller already established, e.g. `POLICY_ABSENT` or `POLICY_NOT_CONFIRMED`. */
  readonly incompleteReasons?: readonly ImpactIncompleteReason[];
  readonly evidence?: readonly string[];
  readonly analyzerVersion?: string;
}

const incompleteReasonOrder: readonly ImpactIncompleteReason[] = [
  'POLICY_ABSENT', 'POLICY_INVALID', 'POLICY_NOT_CONFIRMED', 'EMPTY_MAPPING',
  'UNCERTAIN_GLOBAL_EFFECT', 'UNBOUNDED_SCOPE',
];

const reasonCodeOrder: readonly ImpactReasonCode[] = [
  'SAME_FILE', 'IMPORTANT_DIRECTORY_OVERLAP', 'SAME_MODULE', 'GLOBAL_RESOURCE',
  'GLOBAL_RESOURCE_DEPENDENCY', 'INCOMPLETE_IMPACT', 'MISSING_IMPACT_SNAPSHOT',
  'STALE_BASE', 'STALE_REVISION', 'STALE_POLICY', 'STALE_ANALYZER',
  'ACTUAL_DIFF_EXCEEDS_SNAPSHOT', 'SNAPSHOT_SCOPE_MISMATCH', 'INVALID_SCOPE', 'NO_CONFLICT',
];

function ordered<T extends string>(order: readonly T[], values: Iterable<T>): readonly T[] {
  const present = new Set(values);
  return Object.freeze(order.filter((value) => present.has(value)));
}

/** A path as it enters the analysis: repository-relative, `/`-separated, no `.`/`..` segments. */
export function normalizeObservedImpactPath(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new DomainError('INVALID_IMPACT_SCOPE', 'Observed change set contains an empty path');
  }
  if (raw.includes('\u0000') || raw.includes('\\') || raw.startsWith('/') || raw.startsWith('~')
    || raw.includes('\n')) {
    throw new DomainError('INVALID_IMPACT_SCOPE',
      `Observed change set path is not a repository-relative path: ${raw.slice(0, 200)}`);
  }
  for (const segment of raw.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new DomainError('INVALID_IMPACT_SCOPE',
        `Observed change set path is not normalized: ${raw.slice(0, 200)}`);
    }
    if (segment === '.git') {
      throw new DomainError('INVALID_IMPACT_SCOPE',
        `Observed change set path names Git internals: ${raw.slice(0, 200)}`);
    }
  }
  return raw;
}

function comparisonKey(path: string, caseMode: ImpactPathCaseMode): string {
  return caseMode === 'INSENSITIVE' ? path.toLowerCase() : path;
}

/** `child` equals `parent` or lives below it. Directory comparison is by whole path component. */
export function impactPathIsInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/** True when one declared directory is the other, or an ancestor of it. */
export function impactDirectoriesOverlap(left: string, right: string): boolean {
  return impactPathIsInside(left, right) || impactPathIsInside(right, left);
}

/** A pattern is either an exact file path or a `dir/**` subtree; nothing else was accepted. */
export function impactPatternMatches(path: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    return impactPathIsInside(path, pattern.slice(0, -3));
  }
  return path === pattern;
}

export interface DerivedImpactScope {
  readonly files: readonly string[];
  readonly importantDirectories: readonly string[];
  readonly modules: readonly string[];
  readonly globalResources: readonly ImpactGlobalResourceRef[];
  readonly unclassifiedFiles: readonly string[];
  readonly incompleteReasons: readonly ImpactIncompleteReason[];
}

/**
 * Maps observed change set paths onto the declared mapping.
 *
 * Missing coverage is recorded (`unclassifiedFiles`) but not treated as incompleteness: the mapping
 * is a human statement about *what matters*, and requiring it to cover every path would make
 * `complete` unreachable. Direct file overlap is checked independently of the mapping for every
 * path, so an undeclared path is still compared, just not widened into directory/module scope.
 */
export function deriveImpactScope(input: {
  readonly paths: readonly string[];
  readonly mapping: ImpactMapping;
  readonly caseMode: ImpactPathCaseMode;
}): DerivedImpactScope {
  const caseMode = input.caseMode;
  const keys = new Set<string>();
  const files: string[] = [];
  let unbounded = false;
  for (const raw of input.paths) {
    const path = normalizeObservedImpactPath(raw);
    const key = comparisonKey(path, caseMode);
    if (keys.has(key)) continue;
    keys.add(key);
    if (files.length >= maxImpactFiles) {
      unbounded = true;
      continue;
    }
    files.push(path);
  }
  files.sort();

  const matchedKeys = [...keys];

  const importantDirectories = input.mapping.importantDirectories
    .filter((directory) => matchedKeys.some((key) => impactPathIsInside(key, comparisonKey(directory, caseMode))))
    .sort();

  const modules = input.mapping.modules
    .filter((module) => module.paths.some((pattern) => matchedKeys.some((key) =>
      impactPatternMatches(key, comparisonKey(pattern, caseMode)))))
    .map((module) => module.id)
    .sort();

  const globalResources: ImpactGlobalResourceRef[] = [];
  const incompleteReasons: ImpactIncompleteReason[] = [];
  for (const resource of input.mapping.globalResources) {
    const written = resource.paths.some((pattern) => matchedKeys.some((key) =>
      impactPatternMatches(key, comparisonKey(pattern, caseMode))));
    const read = resource.consumers.state === 'DECLARED'
      && resource.consumers.paths.some((pattern) => matchedKeys.some((key) =>
        impactPatternMatches(key, comparisonKey(pattern, caseMode))));
    if (!written && !read) continue;
    globalResources.push({ id: resource.id, kind: resource.kind, written, read });
    if (written && resource.consumers.state === 'UNKNOWN') {
      // "Nobody reads the lockfile" is a claim nobody made, so a write to it leaves the effect of
      // this revision unbounded. The project-wide scope becomes UNKNOWN, never SAFE.
      incompleteReasons.push('UNCERTAIN_GLOBAL_EFFECT');
    }
  }
  globalResources.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const classifiedKeys = new Set<string>();
  for (const directory of input.mapping.importantDirectories) {
    const directoryKey = comparisonKey(directory, caseMode);
    for (const key of matchedKeys) {
      if (impactPathIsInside(key, directoryKey)) classifiedKeys.add(key);
    }
  }
  for (const module of input.mapping.modules) {
    for (const pattern of module.paths) {
      const patternKey = comparisonKey(pattern, caseMode);
      for (const key of matchedKeys) {
        if (impactPatternMatches(key, patternKey)) classifiedKeys.add(key);
      }
    }
  }
  for (const resource of input.mapping.globalResources) {
    const patterns = [...resource.paths,
      ...(resource.consumers.state === 'DECLARED' ? resource.consumers.paths : [])];
    for (const pattern of patterns) {
      const patternKey = comparisonKey(pattern, caseMode);
      for (const key of matchedKeys) {
        if (impactPatternMatches(key, patternKey)) classifiedKeys.add(key);
      }
    }
  }
  const unclassifiedFiles = files.filter((path) => !classifiedKeys.has(comparisonKey(path, caseMode)));

  if (unbounded) incompleteReasons.push('UNBOUNDED_SCOPE');
  return {
    files: Object.freeze(files),
    importantDirectories: Object.freeze(importantDirectories),
    modules: Object.freeze(modules),
    globalResources: Object.freeze(globalResources),
    unclassifiedFiles: Object.freeze(unclassifiedFiles),
    incompleteReasons: ordered(incompleteReasonOrder, incompleteReasons),
  };
}

function requireText(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError('INVALID_VALUE', `${name} must not be empty`);
  }
}

function requireObjectId(value: string, name: string): void {
  if (!/^[0-9a-f]{40,64}$/.test(value)) {
    throw new DomainError('INVALID_VALUE', `${name} must be a Git object ID`);
  }
}

/**
 * Builds one snapshot. The completeness decision lives here, not at the call site, so no caller can
 * forget it: a missing mapping, an empty mapping, an unbounded change set, or an uncertain global
 * effect each make the snapshot incomplete, and an incomplete snapshot cannot be evidence for SAFE.
 */
export function createImpactSnapshot(input: CreateImpactSnapshotInput): ImpactSnapshot {
  requireText(input.taskId, 'taskId');
  requireText(input.revisionId, 'revisionId');
  requireText(input.policyVersion, 'policyVersion');
  requireText(input.changeFingerprint, 'changeFingerprint');
  requireObjectId(input.baseCommit, 'baseCommit');
  if (!/^[0-9a-f]{64}$/.test(input.policyDigest)) {
    throw new DomainError('INVALID_VALUE', 'policyDigest must be a sha256 hex digest');
  }
  if (input.caseMode !== 'SENSITIVE' && input.caseMode !== 'INSENSITIVE') {
    throw new DomainError('INVALID_VALUE', 'caseMode must be SENSITIVE or INSENSITIVE');
  }
  const inherited = input.incompleteReasons ?? [];
  let scope: DerivedImpactScope;
  if (input.mapping === null) {
    if (inherited.length === 0) {
      throw new DomainError('INVALID_IMPACT_MAPPING',
        'A snapshot without a mapping must say which fact made it incomplete');
    }
    scope = {
      files: Object.freeze([...new Set(input.paths.map(normalizeObservedImpactPath))].sort()
        .slice(0, maxImpactFiles)),
      importantDirectories: Object.freeze([]),
      modules: Object.freeze([]),
      globalResources: Object.freeze([]),
      unclassifiedFiles: Object.freeze([]),
      incompleteReasons: Object.freeze([]),
    };
  } else {
    scope = deriveImpactScope({ paths: input.paths, mapping: input.mapping, caseMode: input.caseMode });
    if (input.mapping.importantDirectories.length === 0 && input.mapping.modules.length === 0
      && input.mapping.globalResources.length === 0) {
      // A valid but empty mapping declares nothing about the project, so nothing can be proven.
      scope = { ...scope, incompleteReasons: ordered(incompleteReasonOrder,
        [...scope.incompleteReasons, 'EMPTY_MAPPING']) };
    }
  }
  const incompleteReasons = ordered(incompleteReasonOrder, [...scope.incompleteReasons, ...inherited]);
  const analyzerVersion = input.analyzerVersion ?? impactAnalyzerVersion;
  const evidence = [
    `${scope.files.length} changed path(s) against ${input.baseCommit.slice(0, 12)}`,
    `mapping ${input.policyVersion} (${input.policyDigest.slice(0, 12)})`,
    `path case mode ${input.caseMode}`,
    `${scope.importantDirectories.length} important director(ies), ${scope.modules.length} module(s),`
      + ` ${scope.globalResources.length} shared resource(s) in scope`,
    `${scope.unclassifiedFiles.length} path(s) not classified by the mapping`,
    ...(incompleteReasons.length === 0
      ? ['impact is complete: every declared scope was matched and the change set was bounded']
      : [`impact is incomplete: ${incompleteReasons.join(', ')}`]),
    ...(input.evidence ?? []),
  ];
  return Object.freeze({
    taskId: input.taskId,
    revisionId: input.revisionId,
    baseCommit: input.baseCommit,
    analyzerVersion,
    policyVersion: input.policyVersion,
    policyDigest: input.policyDigest,
    caseMode: input.caseMode,
    changeFingerprint: input.changeFingerprint,
    complete: incompleteReasons.length === 0,
    incompleteReasons,
    files: scope.files,
    importantDirectories: scope.importantDirectories,
    modules: scope.modules,
    globalResources: scope.globalResources,
    unclassifiedFiles: scope.unclassifiedFiles,
    evidence: Object.freeze(evidence),
  });
}

export interface ImpactAssessmentContext {
  /** The project baseline the assessment is made against (ADR-0009: the project's `dev` commit). */
  readonly baseCommit: string;
  readonly policyVersion: string;
  readonly analyzerVersion: string;
}

export interface ImpactSubject {
  readonly taskId: string;
  /** The Task's *current* revision, so a snapshot taken before an amendment is detectable. */
  readonly currentRevisionId: string;
  readonly snapshot: ImpactSnapshot | null;
  /** The change set observed now; when it exceeds the snapshot, the snapshot is superseded. */
  readonly observedFiles?: readonly string[];
  /** Why no snapshot exists, for `MISSING_IMPACT_SNAPSHOT`. */
  readonly unavailableDetail?: string;
}

export interface ImpactHit {
  readonly reason: ImpactReasonCode;
  readonly class: ImpactReasonClass;
  /** The other Task's ID, or `null` for a finding about the candidate itself. */
  readonly taskId: string | null;
  readonly revisionId: string | null;
  /** Intersecting paths, sorted, truncated to `maxImpactHitPaths`. */
  readonly paths: readonly string[];
  /** Total intersecting paths before truncation. */
  readonly pathCount: number;
  readonly directories: readonly string[];
  readonly modules: readonly string[];
  readonly globalResources: readonly string[];
  /** How the scope intersected: `SAME_FILE`, `SAME_DIRECTORY`, `ANCESTOR_DIRECTORY`, … */
  readonly relation: string | null;
  readonly detail: string;
}

export interface ConflictAssessment {
  readonly verdict: ImpactVerdict;
  readonly reasonCodes: readonly ImpactReasonCode[];
  readonly candidateTaskId: string;
  readonly candidateRevisionId: string;
  /** Fingerprint of the change set the verdict was computed from; the audit key of the snapshot. */
  readonly candidateChangeFingerprint: string;
  readonly candidateComplete: boolean;
  readonly candidateIncompleteReasons: readonly ImpactIncompleteReason[];
  /** Active/reserved Tasks actually compared, in the order they were reported. */
  readonly comparedTaskIds: readonly string[];
  readonly hits: readonly ImpactHit[];
  /** Pairs with no finding at all: the only pairs the evidence claims are safe. */
  readonly safePairs: readonly {
    readonly taskId: string;
    readonly revisionId: string;
    readonly changeFingerprint: string;
  }[];
  readonly evidence: readonly string[];
}

/**
 * The six components of a recorded `ImpactSnapshot` that decide whether it still describes the
 * observed facts (ADR-0031 §6.3). They are exactly the reuse key `(task, revision, base, analyzer,
 * mapping, change set)`, which is why they can be read back out of storage without rehydrating the
 * whole snapshot: the reservation path applies the *same* judgment to the stored row.
 */
export interface ImpactSnapshotGeneration {
  readonly taskId: string;
  readonly revisionId: string;
  readonly baseCommit: string;
  readonly analyzerVersion: string;
  readonly policyVersion: string;
  readonly changeFingerprint: string;
  /** The case behavior recorded with the snapshot; it is what makes the path comparison honest. */
  readonly caseMode: ImpactPathCaseMode;
  readonly files: readonly string[];
}

/** One component of the generation a recheck found out of date. */
export type ImpactSnapshotStaleComponent = 'revisionId' | 'baseCommit' | 'analyzerVersion'
  | 'policyVersion' | 'changeSet' | 'recordedScope';

/** The generation as a snapshot recorded it, echoed so a refusal can name exactly what moved. */
export interface ImpactSnapshotGenerationSummary {
  readonly taskId: string;
  readonly revisionId: string;
  readonly baseCommit: string;
  readonly analyzerVersion: string;
  readonly policyVersion: string;
  readonly changeFingerprint: string | null;
  readonly pathCount: number;
}

/**
 * The recheck of one recorded generation against the observed facts: the E1 judgment, plus the
 * components that made it fail. Only `current`, `reasonCodes` and `differing` are decisions; the two
 * summaries are evidence for the human reading a refusal, never inputs to it.
 */
export interface ImpactSnapshotRecheck {
  readonly current: boolean;
  readonly reasonCodes: readonly ImpactReasonCode[];
  readonly differing: readonly ImpactSnapshotStaleComponent[];
  readonly assessed: ImpactSnapshotGenerationSummary;
  readonly observed: ImpactSnapshotGenerationSummary;
}

export function impactSnapshotGeneration(snapshot: ImpactSnapshot): ImpactSnapshotGeneration {
  return {
    taskId: snapshot.taskId,
    revisionId: snapshot.revisionId,
    baseCommit: snapshot.baseCommit,
    analyzerVersion: snapshot.analyzerVersion,
    policyVersion: snapshot.policyVersion,
    changeFingerprint: snapshot.changeFingerprint,
    caseMode: snapshot.caseMode,
    files: snapshot.files,
  };
}

/** Stable field order, so the same mismatch always reports the same list. */
const staleComponentOrder: readonly ImpactSnapshotStaleComponent[] = ['revisionId', 'baseCommit',
  'analyzerVersion', 'policyVersion', 'changeSet', 'recordedScope'];

const staleComponentByReason: Readonly<Record<string, ImpactSnapshotStaleComponent>> = {
  STALE_REVISION: 'revisionId',
  STALE_BASE: 'baseCommit',
  STALE_ANALYZER: 'analyzerVersion',
  STALE_POLICY: 'policyVersion',
  ACTUAL_DIFF_EXCEEDS_SNAPSHOT: 'changeSet',
  SNAPSHOT_SCOPE_MISMATCH: 'changeSet',
  INVALID_SCOPE: 'recordedScope',
};

/**
 * Rechecks one recorded generation against the facts observed now.
 *
 * Unlike {@link isSnapshotCurrent} this reports *which* components moved and echoes both sides, which
 * is what a refused reservation needs to be explainable ("the snapshot is stale" is not enough; the
 * caller has to see that the baseline moved and not the revision, say). The decision itself is
 * identical — {@link isSnapshotCurrent} is this function with `current` and `reasonCodes` kept.
 */
export function recheckImpactSnapshotGeneration(input: {
  readonly generation: ImpactSnapshotGeneration;
  readonly observedFiles: readonly string[];
  readonly context: ImpactAssessmentContext;
  readonly currentRevisionId: string;
  /** The change-set fingerprint observed now, when it could be observed; evidence only. */
  readonly observedChangeFingerprint?: string | null;
}): ImpactSnapshotRecheck {
  const codes = ordered(reasonCodeOrder,
    subjectValidity(input.generation, input.observedFiles, input.context, input.currentRevisionId));
  const present = new Set<ImpactSnapshotStaleComponent>();
  for (const code of codes) {
    const component = staleComponentByReason[code];
    if (component !== undefined) present.add(component);
  }
  return Object.freeze({
    current: codes.length === 0,
    reasonCodes: codes,
    differing: Object.freeze(staleComponentOrder.filter((component) => present.has(component))),
    assessed: Object.freeze({
      taskId: input.generation.taskId,
      revisionId: input.generation.revisionId,
      baseCommit: input.generation.baseCommit,
      analyzerVersion: input.generation.analyzerVersion,
      policyVersion: input.generation.policyVersion,
      changeFingerprint: input.generation.changeFingerprint,
      pathCount: input.generation.files.length,
    }),
    observed: Object.freeze({
      taskId: input.generation.taskId,
      revisionId: input.currentRevisionId,
      baseCommit: input.context.baseCommit,
      analyzerVersion: input.context.analyzerVersion,
      policyVersion: input.context.policyVersion,
      changeFingerprint: input.observedChangeFingerprint ?? null,
      pathCount: input.observedFiles.length,
    }),
  });
}

/**
 * True when the recorded snapshot still describes the observed worktree exactly: same revision, base,
 * mapping and analyzer, and the same set of changed paths. A snapshot whose scope moved in *either*
 * direction is superseded: being wider keeps reporting conflicts on paths the worktree no longer
 * changes, and being narrower hides paths it now does change.
 */
export function isSnapshotCurrent(input: {
  readonly snapshot: ImpactSnapshot;
  readonly observedFiles: readonly string[];
  readonly context: ImpactAssessmentContext;
  readonly currentRevisionId: string;
}): { readonly current: boolean; readonly reasonCodes: readonly ImpactReasonCode[] } {
  const codes = subjectValidity(impactSnapshotGeneration(input.snapshot), input.observedFiles,
    input.context, input.currentRevisionId);
  return {
    current: codes.length === 0,
    reasonCodes: ordered(reasonCodeOrder, codes),
  };
}

function subjectValidity(
  generation: ImpactSnapshotGeneration,
  observedFiles: readonly string[] | undefined,
  context: ImpactAssessmentContext,
  currentRevisionId: string,
): ImpactReasonCode[] {
  const codes: ImpactReasonCode[] = [];
  if (generation.revisionId !== currentRevisionId) codes.push('STALE_REVISION');
  if (generation.baseCommit !== context.baseCommit) codes.push('STALE_BASE');
  if (generation.policyVersion !== context.policyVersion) codes.push('STALE_POLICY');
  if (generation.analyzerVersion !== context.analyzerVersion) codes.push('STALE_ANALYZER');
  if (observedFiles !== undefined) {
    const recorded = new Set(generation.files.map((path) => comparisonKey(path, generation.caseMode)));
    const observed = new Set(observedFiles.map((path) => comparisonKey(path, generation.caseMode)));
    // The snapshot is reusable only while it describes the worktree *exactly*. A recorded superset
    // would be conservative but wrong in the other direction: it would keep reporting a conflict on
    // a path the worktree no longer changes, so removing a change re-records instead of lingering.
    const grew = [...observed].some((path) => !recorded.has(path));
    const shrank = [...recorded].some((path) => !observed.has(path));
    if (grew) codes.push('ACTUAL_DIFF_EXCEEDS_SNAPSHOT');
    else if (shrank) codes.push('SNAPSHOT_SCOPE_MISMATCH');
  }
  if (generation.files.some((path) => {
    try {
      normalizeObservedImpactPath(path);
      return false;
    } catch {
      return true;
    }
  })) {
    codes.push('INVALID_SCOPE');
  }
  return codes;
}

function boundedPaths(paths: readonly string[]): { readonly paths: readonly string[];
  readonly pathCount: number } {
  return {
    paths: Object.freeze(paths.slice(0, maxImpactHitPaths)),
    pathCount: paths.length,
  };
}

function intersectByKey(
  left: readonly string[],
  right: readonly string[],
  caseMode: ImpactPathCaseMode,
): { readonly leftPaths: readonly string[]; readonly rightPaths: readonly string[] } {
  const rightByKey = new Map<string, string[]>();
  for (const path of right) {
    const key = comparisonKey(path, caseMode);
    const bucket = rightByKey.get(key);
    if (bucket === undefined) rightByKey.set(key, [path]);
    else bucket.push(path);
  }
  const leftPaths: string[] = [];
  const rightPaths: string[] = [];
  for (const path of left) {
    const matches = rightByKey.get(comparisonKey(path, caseMode));
    if (matches === undefined) continue;
    leftPaths.push(path);
    rightPaths.push(...matches);
  }
  return { leftPaths, rightPaths };
}

function compareHits(left: ImpactHit, right: ImpactHit): number {
  const leftRank = impactReasonClass(left.reason) === 'CONFLICT' ? 0
    : impactReasonClass(left.reason) === 'INCOMPLETE' ? 1 : 2;
  const rightRank = impactReasonClass(right.reason) === 'CONFLICT' ? 0
    : impactReasonClass(right.reason) === 'INCOMPLETE' ? 1 : 2;
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftIndex = reasonCodeOrder.indexOf(left.reason);
  const rightIndex = reasonCodeOrder.indexOf(right.reason);
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  if ((left.taskId ?? '') !== (right.taskId ?? '')) return (left.taskId ?? '') < (right.taskId ?? '') ? -1 : 1;
  if ((left.relation ?? '') !== (right.relation ?? '')) {
    return (left.relation ?? '') < (right.relation ?? '') ? -1 : 1;
  }
  return (left.paths[0] ?? '') < (right.paths[0] ?? '') ? -1 : 1;
}

function subjectHits(
  subject: ImpactSubject,
  context: ImpactAssessmentContext,
): readonly ImpactHit[] {
  // A subject without a snapshot has no generation to validate. Returning no hits here is not "no
  // problem": the caller reports `MISSING_IMPACT_SNAPSHOT` for it (a null candidate and a null peer
  // each get exactly one such hit), which is what makes the verdict `UNKNOWN` instead of `SAFE`. It
  // used to dereference the null generation instead, so explaining a Task whose workspace had been
  // removed crashed instead of explaining it (FOUNDATION-086).
  if (subject.snapshot === null) return Object.freeze([]);
  const codes = subjectValidity(subject.snapshot, subject.observedFiles, context,
    subject.currentRevisionId);
  return ordered(reasonCodeOrder, codes).map((code) => Object.freeze({
    reason: code,
    class: impactReasonClass(code),
    taskId: subject.taskId,
    revisionId: subject.snapshot?.revisionId ?? null,
    paths: Object.freeze([]),
    pathCount: 0,
    directories: Object.freeze([]),
    modules: Object.freeze([]),
    globalResources: Object.freeze([]),
    relation: null,
    detail: staleDetail(code, subject),
  }));
}

function staleDetail(code: ImpactReasonCode, subject: ImpactSubject): string {
  const snapshot = subject.snapshot;
  switch (code) {
    case 'STALE_REVISION':
      return `snapshot was taken for revision ${snapshot?.revisionId ?? 'unknown'}, the Task is now`
        + ` on ${subject.currentRevisionId}`;
    case 'STALE_BASE':
      return `snapshot was taken against base ${snapshot?.baseCommit.slice(0, 12) ?? 'unknown'}`;
    case 'STALE_POLICY':
      return `snapshot used mapping ${snapshot?.policyVersion ?? 'unknown'}`;
    case 'STALE_ANALYZER':
      return `snapshot was produced by analyzer ${snapshot?.analyzerVersion ?? 'unknown'}`;
    case 'ACTUAL_DIFF_EXCEEDS_SNAPSHOT':
      return 'the worktree now changes paths the snapshot did not record, so its scope is no longer'
        + ' an over-approximation';
    case 'SNAPSHOT_SCOPE_MISMATCH':
      return 'the recorded change set no longer matches the worktree (paths were removed or renamed'
        + ' away), so the prediction is superseded';
    case 'INVALID_SCOPE':
      return 'the recorded change set contains a path that is not a repository-relative path';
    default:
      return code;
  }
}

/**
 * The pure judgement of `docs/architecture/conflict-analyzer.md` §3.
 *
 * Order of decisions per pair, and of the verdict overall:
 * 1. a candidate that is stale or invalid makes the whole assessment `UNKNOWN` (nothing about it can
 *    be trusted);
 * 2. an active/reserved Task whose snapshot is stale, incomplete, or missing is `UNKNOWN` for that
 *    pair — never silently "no overlap";
 * 3. real overlaps are `CONFLICTING`, and they outrank incompleteness, so a found conflict is never
 *    hidden behind an unknown;
 * 4. everything else is `SAFE_TO_PARALLELIZE`, with the compared pairs as evidence.
 */
export function assessCandidate(input: {
  readonly candidate: ImpactSubject;
  readonly active: readonly ImpactSubject[];
  readonly context: ImpactAssessmentContext;
}): ConflictAssessment {
  const { candidate, context } = input;
  const candidateHits = subjectHits(candidate, context);
  const hits: ImpactHit[] = [...candidateHits];
  const comparedTaskIds: string[] = [];
  const safePairs: { taskId: string; revisionId: string; changeFingerprint: string }[] = [];

  const peers = [...input.active]
    .filter((subject) => subject.taskId !== candidate.taskId)
    .sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0));

  for (const peer of peers) {
    comparedTaskIds.push(peer.taskId);
    if (peer.snapshot === null) {
      hits.push(Object.freeze({
        reason: 'MISSING_IMPACT_SNAPSHOT' as const,
        class: 'INCOMPLETE' as const,
        taskId: peer.taskId,
        revisionId: peer.currentRevisionId,
        paths: Object.freeze([]),
        pathCount: 0,
        directories: Object.freeze([]),
        modules: Object.freeze([]),
        globalResources: Object.freeze([]),
        relation: null,
        detail: peer.unavailableDetail
          ?? 'no ImpactSnapshot could be derived for this active Task, so no overlap can be excluded',
      }));
      continue;
    }
    if (candidate.snapshot === null) continue;
    const peerFindings = subjectHits(peer, context);
    if (peerFindings.length > 0) {
      hits.push(...peerFindings);
      continue;
    }
    const pairFindings = pairHits(candidate.snapshot, peer.snapshot);
    if (pairFindings.length > 0) {
      hits.push(...pairFindings);
      continue;
    }
    if (!candidate.snapshot.complete || !peer.snapshot.complete) {
      // A safe pair is only ever claimed when *both* sides are complete: the candidate's own
      // incompleteness is reported once below, the peer's is attributed to the peer here.
      if (!peer.snapshot.complete) {
        hits.push(Object.freeze({
          reason: 'INCOMPLETE_IMPACT' as const,
          class: 'INCOMPLETE' as const,
          taskId: peer.taskId,
          revisionId: peer.snapshot.revisionId,
          paths: Object.freeze([]),
          pathCount: 0,
          directories: Object.freeze([]),
          modules: Object.freeze([]),
          globalResources: Object.freeze([]),
          relation: null,
          detail: `impact of ${peer.taskId} is incomplete: ${peer.snapshot.incompleteReasons.join(', ')}`,
        }));
      }
      continue;
    }
    safePairs.push({
      taskId: peer.taskId,
      revisionId: peer.snapshot.revisionId,
      changeFingerprint: peer.snapshot.changeFingerprint,
    });
  }

  if (candidate.snapshot === null) {
    hits.push(Object.freeze({
      reason: 'MISSING_IMPACT_SNAPSHOT' as const,
      class: 'INCOMPLETE' as const,
      taskId: candidate.taskId,
      revisionId: candidate.currentRevisionId,
      paths: Object.freeze([]),
      pathCount: 0,
      directories: Object.freeze([]),
      modules: Object.freeze([]),
      globalResources: Object.freeze([]),
      relation: null,
      detail: candidate.unavailableDetail
        ?? 'no ImpactSnapshot could be derived for the candidate, so no overlap can be excluded',
    }));
  } else if (!candidate.snapshot.complete) {
    hits.push(Object.freeze({
      reason: 'INCOMPLETE_IMPACT' as const,
      class: 'INCOMPLETE' as const,
      taskId: candidate.taskId,
      revisionId: candidate.snapshot.revisionId,
      paths: Object.freeze([]),
      pathCount: 0,
      directories: Object.freeze([]),
      modules: Object.freeze([]),
      globalResources: Object.freeze([]),
      relation: null,
      detail: `impact is incomplete: ${candidate.snapshot.incompleteReasons.join(', ')}`,
    }));
  }

  const sorted = hits.sort(compareHits);
  const hasConflict = sorted.some((hit) => hit.class === 'CONFLICT');
  const candidateInvalid = candidateHits.length > 0;
  const verdict: ImpactVerdict = candidateInvalid || (!hasConflict && sorted.length > 0)
    ? 'UNKNOWN'
    : hasConflict ? 'CONFLICTING' : 'SAFE_TO_PARALLELIZE';
  const evidence = Object.freeze([
    `candidate ${candidate.taskId} revision ${candidate.currentRevisionId}`,
    `compared ${comparedTaskIds.length} active/reserved Task(s):`
      + ` ${comparedTaskIds.length === 0 ? 'none' : comparedTaskIds.join(', ')}`,
    `baseline ${context.baseCommit.slice(0, 12)}, mapping ${context.policyVersion},`
      + ` analyzer ${context.analyzerVersion}`,
    ...(candidate.snapshot === null ? [] : candidate.snapshot.evidence.slice(0, 6)),
    ...(verdict === 'SAFE_TO_PARALLELIZE'
      ? [`no file, important directory, module, or shared resource intersected with`
        + ` ${safePairs.length} compared Task(s)`]
      : []),
    ...(verdict === 'UNKNOWN' && sorted.length === 0
      ? ['no comparison was possible; this is not a statement that no conflict exists']
      : []),
  ]);
  return Object.freeze({
    verdict,
    reasonCodes: ordered(reasonCodeOrder, [
      ...sorted.map((hit) => hit.reason),
      ...(verdict === 'SAFE_TO_PARALLELIZE' ? ['NO_CONFLICT' as const] : []),
    ]),
    candidateTaskId: candidate.taskId,
    candidateRevisionId: candidate.currentRevisionId,
    candidateChangeFingerprint: candidate.snapshot?.changeFingerprint ?? '',
    candidateComplete: candidate.snapshot?.complete ?? false,
    candidateIncompleteReasons: candidate.snapshot?.incompleteReasons ?? Object.freeze([]),
    comparedTaskIds: Object.freeze(comparedTaskIds),
    hits: Object.freeze(sorted),
    safePairs: Object.freeze(safePairs),
    evidence,
  });
}

function pairHits(candidate: ImpactSnapshot, peer: ImpactSnapshot): readonly ImpactHit[] {
  const hits: ImpactHit[] = [];
  const otherTaskId = peer.taskId;
  const otherRevisionId = peer.revisionId;

  const fileOverlap = intersectByKey(candidate.files, peer.files, candidate.caseMode);
  if (fileOverlap.leftPaths.length > 0) {
    const bounded = boundedPaths(fileOverlap.leftPaths);
    hits.push(Object.freeze({
      reason: 'SAME_FILE' as const,
      class: 'CONFLICT' as const,
      taskId: otherTaskId,
      revisionId: otherRevisionId,
      paths: bounded.paths,
      pathCount: bounded.pathCount,
      directories: Object.freeze([]),
      modules: Object.freeze([]),
      globalResources: Object.freeze([]),
      relation: 'SAME_FILE',
      detail: `${bounded.pathCount} file(s) changed by both${caseOnlyDetail(fileOverlap, candidate.caseMode)}`,
    }));
  }

  const directoryPairs: { left: string; right: string }[] = [];
  for (const left of candidate.importantDirectories) {
    for (const right of peer.importantDirectories) {
      if (impactDirectoriesOverlap(comparisonKey(left, candidate.caseMode),
        comparisonKey(right, candidate.caseMode))) {
        directoryPairs.push({ left, right });
      }
    }
  }
  if (directoryPairs.length > 0) {
    hits.push(Object.freeze({
      reason: 'IMPORTANT_DIRECTORY_OVERLAP' as const,
      class: 'CONFLICT' as const,
      taskId: otherTaskId,
      revisionId: otherRevisionId,
      // The intersecting range of a directory conflict is the directories themselves; reporting
      // them as "paths" too would describe the same finding twice.
      paths: Object.freeze([]),
      pathCount: 0,
      directories: Object.freeze([...new Set(directoryPairs.flatMap((pair) => [pair.left, pair.right]))]
        .sort()),
      modules: Object.freeze([]),
      globalResources: Object.freeze([]),
      relation: directoryPairs.some((pair) => pair.left === pair.right)
        ? 'SAME_DIRECTORY' : 'ANCESTOR_DIRECTORY',
      detail: directoryPairs.some((pair) => pair.left === pair.right)
        ? `both revisions change files inside important director(ies)`
          + ` ${[...new Set(directoryPairs.map((pair) => pair.left))].sort().join(', ')}`
          + ` (other revision: ${[...new Set(directoryPairs.map((pair) => pair.right))].sort().join(', ')})`
        : `important director(ies) of one revision contain the other's:`
          + ` ${directoryPairs.map((pair) => `${pair.left} ⊃ ${pair.right}`).sort().join(', ')}`,
    }));
  }

  const moduleIds = candidate.modules.filter((id) => peer.modules.includes(id));
  if (moduleIds.length > 0) {
    hits.push(Object.freeze({
      reason: 'SAME_MODULE' as const,
      class: 'CONFLICT' as const,
      taskId: otherTaskId,
      revisionId: otherRevisionId,
      paths: Object.freeze([]),
      pathCount: 0,
      directories: Object.freeze([]),
      modules: Object.freeze([...moduleIds].sort()),
      globalResources: Object.freeze([]),
      relation: 'SAME_MODULE',
      detail: `both revisions change files of module(s) ${[...moduleIds].sort().join(', ')}`,
    }));
  }

  const peerById = new Map(peer.globalResources.map((resource) => [resource.id, resource]));
  const writesBoth: string[] = [];
  const writeRead: string[] = [];
  for (const resource of candidate.globalResources) {
    const other = peerById.get(resource.id);
    if (other === undefined) continue;
    if (resource.written && other.written) writesBoth.push(resource.id);
    else if ((resource.written && other.read) || (other.written && resource.read)) {
      writeRead.push(resource.id);
    }
  }
  if (writesBoth.length > 0) {
    hits.push(Object.freeze({
      reason: 'GLOBAL_RESOURCE' as const,
      class: 'CONFLICT' as const,
      taskId: otherTaskId,
      revisionId: otherRevisionId,
      paths: Object.freeze([]),
      pathCount: 0,
      directories: Object.freeze([]),
      modules: Object.freeze([]),
      globalResources: Object.freeze(writesBoth.sort()),
      relation: 'WRITE_WRITE',
      detail: `both revisions change shared resource(s) ${writesBoth.sort().join(', ')}`,
    }));
  }
  if (writeRead.length > 0) {
    hits.push(Object.freeze({
      reason: 'GLOBAL_RESOURCE_DEPENDENCY' as const,
      class: 'CONFLICT' as const,
      taskId: otherTaskId,
      revisionId: otherRevisionId,
      paths: Object.freeze([]),
      pathCount: 0,
      directories: Object.freeze([]),
      modules: Object.freeze([]),
      globalResources: Object.freeze(writeRead.sort()),
      relation: 'READ_WRITE',
      detail: `one revision changes shared resource(s) ${writeRead.sort().join(', ')} while the other`
        + ' changes a file declared to depend on them',
    }));
  }
  return hits;
}

function caseOnlyDetail(
  overlap: { readonly leftPaths: readonly string[]; readonly rightPaths: readonly string[] },
  caseMode: ImpactPathCaseMode,
): string {
  if (caseMode !== 'INSENSITIVE') return '';
  const differing = overlap.leftPaths.filter((path, index) => path !== overlap.rightPaths[index]);
  return differing.length === 0
    ? ''
    : `; ${differing.length} of them differ only by case on this case-insensitive file system`;
}

/** Human-readable, stable explanation lines for `project impact explain` and the UI. */
export function explainAssessment(assessment: ConflictAssessment): readonly string[] {
  const lines: string[] = [];
  lines.push(`verdict ${assessment.verdict} (${assessment.reasonCodes.join(', ')})`);
  if (assessment.verdict === 'SAFE_TO_PARALLELIZE') {
    lines.push(`reason no file, important directory, module, or shared resource was changed by both`
      + ` the candidate and a Task it was compared with`);
  }
  for (const hit of assessment.hits) {
    const scope: string[] = [];
    if (hit.paths.length > 0) {
      scope.push(`paths ${hit.paths.join(', ')}${hit.pathCount > hit.paths.length
        ? ` (+${hit.pathCount - hit.paths.length} more)` : ''}`);
    }
    if (hit.directories.length > 0) scope.push(`directories ${hit.directories.join(', ')}`);
    if (hit.modules.length > 0) scope.push(`modules ${hit.modules.join(', ')}`);
    if (hit.globalResources.length > 0) {
      scope.push(`shared resources ${hit.globalResources.join(', ')}`);
    }
    const where = hit.taskId === null || hit.taskId === assessment.candidateTaskId
      ? 'on the candidate'
      : `against ${hit.taskId}`;
    lines.push(`[${hit.class}] ${hit.reason} ${where}${hit.relation === null ? '' : ` (${hit.relation})`}:`
      + ` ${hit.detail}${scope.length === 0 ? '' : ` — ${scope.join('; ')}`}`);
  }
  if (assessment.verdict === 'UNKNOWN' && assessment.hits.length === 0) {
    lines.push('[UNKNOWN] nothing could be compared; UNKNOWN means "cannot be proven", not "no conflict"');
  }
  for (const pair of assessment.safePairs) {
    lines.push(`[SAFE] no overlapping scope with ${pair.taskId} (revision ${pair.revisionId})`);
  }
  for (const line of assessment.evidence) lines.push(`evidence: ${line}`);
  return Object.freeze(lines);
}
