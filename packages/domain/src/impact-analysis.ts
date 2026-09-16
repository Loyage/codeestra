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
/**
 * The analysis-semantics version that goes into a snapshot's reuse key (ADR-0031 §6.3).
 *
 * `v2` is ADR-0059: the verdict is "two unfinished Tasks declare the same feature", so the analyzer
 * no longer reads file overlap, the declared mapping's completeness, or the baseline at all. The
 * version had to move because the *meaning* of a stored verdict moved: an `impact-analyzer-v1`
 * snapshot's `complete` flag and `files` list answered a different question, and reusing them under
 * the new rule would silently reinterpret history.
 */
export const impactAnalyzerVersion = 'impact-analyzer-v2';
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

/**
 * Stable reason codes. They are the machine-readable half of an explanation.
 *
 * **Which of these a verdict can still be made of (ADR-0059 D04):** under the current rule the
 * analyzer produces exactly `SAME_UNFINISHED_FEATURE` and `NO_CONFLICT`. Everything else is retained
 * in the union — and in `impactReasonClass` — because historical `impact_assessments` rows and the
 * `TaskWaitingForConflict` events of previous Versions contain them, and a client must keep being
 * able to render what was actually recorded. They are **not** produced any more, and this is the
 * only place that says so.
 */
export type ImpactReasonCode =
  /** The only conflict the current rule can find (ADR-0059 D02). */
  | 'SAME_UNFINISHED_FEATURE'
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
    case 'SAME_UNFINISHED_FEATURE':
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
  // The code the current rule produces comes first; the rest are retained so a historical set of
  // reason codes still sorts deterministically (ADR-0059 D04).
  'SAME_UNFINISHED_FEATURE',
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

/**
 * Whether a Task is "not finished yet" for the purpose of the conflict rule (ADR-0059 D01): every
 * state except the two terminal ones, and an archived Task never counts — archiving a Task is the
 * user saying "this is not in flight", and a `DRAFT` that was archived must not block anybody.
 */
export function taskIsUnfinishedForConflict(input: {
  readonly state: string;
  readonly archived: boolean;
}): boolean {
  if (input.archived) return false;
  return input.state !== 'SUCCEEDED' && input.state !== 'CANCELLED';
}

export interface ImpactSubject {
  readonly taskId: string;
  /** The Task's *current* revision, so a snapshot taken before an amendment is detectable. */
  readonly currentRevisionId: string;
  /** The feature ids this revision declares; the only fact the verdict is made of (ADR-0059). */
  readonly features: readonly string[];
  /** The Task's lifecycle state, used with {@link taskIsUnfinishedForConflict}. */
  readonly taskState: string;
  readonly archived: boolean;
  /**
   * The observed change set, kept as evidence of *what was looked at*. It no longer decides
   * anything: a not-yet-started Task has no change set at all, and the conflict rule must still be
   * able to answer (ADR-0059 D02).
   */
  readonly snapshot: ImpactSnapshot | null;
  /** The change set observed now; when it exceeds the snapshot, the snapshot is superseded. */
  readonly observedFiles?: readonly string[];
  /** Why no snapshot exists, for the evidence line. */
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
  /** The feature ids both sides declared, sorted. Non-empty exactly for `SAME_UNFINISHED_FEATURE`. */
  readonly features: readonly string[];
  /** How the scope intersected: `SAME_FEATURE`, `SAME_FILE`, `SAME_DIRECTORY`, … */
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
  /** Unfinished Tasks that declared at least one feature, in the order they were compared. */
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

function compareHits(left: ImpactHit, right: ImpactHit): number {
  // Deterministic order: conflicts first, then by stable reason order, Task id and feature id. The
  // verdict must not depend on the order the peers were read in.
  const leftRank = impactReasonClass(left.reason) === 'CONFLICT' ? 0
    : impactReasonClass(left.reason) === 'INCOMPLETE' ? 1 : 2;
  const rightRank = impactReasonClass(right.reason) === 'CONFLICT' ? 0
    : impactReasonClass(right.reason) === 'INCOMPLETE' ? 1 : 2;
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftIndex = reasonCodeOrder.indexOf(left.reason);
  const rightIndex = reasonCodeOrder.indexOf(right.reason);
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  const leftTask = left.taskId ?? '';
  const rightTask = right.taskId ?? '';
  if (leftTask !== rightTask) return leftTask < rightTask ? -1 : 1;
  return (left.features[0] ?? '') < (right.features[0] ?? '') ? -1 : 1;
}

/** The declared features both sides have in common, sorted. */
function sharedFeatures(left: readonly string[], right: readonly string[]): readonly string[] {
  if (left.length === 0 || right.length === 0) return Object.freeze([]);
  const rightSet = new Set(right);
  return Object.freeze([...new Set(left.filter((feature) => rightSet.has(feature)))].sort());
}

function conflictHit(input: {
  readonly peer: ImpactSubject;
  readonly features: readonly string[];
}): ImpactHit {
  const features = input.features;
  return Object.freeze({
    reason: 'SAME_UNFINISHED_FEATURE' as const,
    class: 'CONFLICT' as const,
    taskId: input.peer.taskId,
    revisionId: input.peer.currentRevisionId,
    paths: Object.freeze([]),
    pathCount: 0,
    directories: Object.freeze([]),
    modules: Object.freeze([]),
    globalResources: Object.freeze([]),
    features,
    relation: 'SAME_FEATURE' as const,
    detail: `both Tasks declare feature(s) ${features.join(', ')} and ${input.peer.taskId} is`
      + ` ${input.peer.taskState}, which is not finished yet`,
  });
}

/**
 * The pure judgement of ADR-0059 D02, which supersedes the conservative rule of ADR-0031.
 *
 * **The rule:** the candidate and each peer are compared by the features they *declare*. A pair
 * conflicts when the two declarations intersect **and** the peer is unfinished
 * ({@link taskIsUnfinishedForConflict}). Everything else is safe to parallelize. Nothing else is
 * consulted: not the change set, not the declared mapping's completeness, not the baseline, not the
 * age of a snapshot.
 *
 * **Why there is no longer an `UNKNOWN` by default:** `UNKNOWN` used to be how the analyzer expressed
 * "I cannot prove there is no file overlap" — a missing mapping, an unconfirmed mapping, a moved
 * baseline, an unobservable worktree. Every one of those made the product unusable in practice
 * (measured on this very repository: `package.json`, `bun.lock` and `apps/runtime/src/main.ts` are
 * declared with `consumers: UNKNOWN`, so almost any Task was `UNKNOWN` and nothing ever ran in
 * parallel). ADR-0059 replaces "cannot prove disjoint" with "shares a declared feature", which is a
 * statement about the user's own declaration, so the default is `SAFE` and a missing mapping simply
 * means nothing was declared.
 *
 * `UNKNOWN` remains a *value* the verdict type, the DB CHECK and every client still accept, because
 * historical assessments recorded it and a client must keep rendering them; the new rule has no path
 * that produces it.
 */
export function assessCandidate(input: {
  readonly candidate: ImpactSubject;
  readonly active: readonly ImpactSubject[];
  readonly context: ImpactAssessmentContext;
}): ConflictAssessment {
  const { candidate, context } = input;
  const hits: ImpactHit[] = [];
  const comparedTaskIds: string[] = [];
  const safePairs: { taskId: string; revisionId: string; changeFingerprint: string }[] = [];

  const peers = [...input.active]
    .filter((subject) => subject.taskId !== candidate.taskId)
    .sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0));

  for (const peer of peers) {
    comparedTaskIds.push(peer.taskId);
    const shared = sharedFeatures(candidate.features, peer.features);
    if (shared.length === 0) {
      safePairs.push({
        taskId: peer.taskId,
        revisionId: peer.currentRevisionId,
        changeFingerprint: peer.snapshot?.changeFingerprint ?? '',
      });
      continue;
    }
    if (!taskIsUnfinishedForConflict({ state: peer.taskState, archived: peer.archived })) {
      // The rule is about a feature that is *not finished yet*: if the only other Task working on it
      // is `SUCCEEDED`/`CANCELLED` (or archived), the feature the candidate wants to improve is no
      // longer in flight, so there is nothing to conflict with.
      safePairs.push({
        taskId: peer.taskId,
        revisionId: peer.currentRevisionId,
        changeFingerprint: peer.snapshot?.changeFingerprint ?? '',
      });
      continue;
    }
    hits.push(conflictHit({ peer, features: shared }));
  }

  const sorted = hits.sort(compareHits);
  const hasConflict = sorted.some((hit) => hit.class === 'CONFLICT');
  const verdict: ImpactVerdict = hasConflict ? 'CONFLICTING' : 'SAFE_TO_PARALLELIZE';
  const declared = candidate.features.length === 0
    ? [`candidate declares no feature, so it cannot be in a feature conflict`
      + ` (${peerCount(peers.length)})`]
    : [`candidate declares feature(s) ${candidate.features.join(', ')}`];
  const evidence = Object.freeze([
    `candidate ${candidate.taskId} revision ${candidate.currentRevisionId}`,
    `compared ${comparedTaskIds.length} unfinished Task(s) that declared a feature:`
      + ` ${comparedTaskIds.length === 0 ? 'none' : comparedTaskIds.join(', ')}`,
    ...declared,
    `baseline ${context.baseCommit.slice(0, 12)}, analyzer ${context.analyzerVersion}`,
    ...(candidate.snapshot === null
      ? [`no change set was observed for the candidate${candidate.unavailableDetail === undefined
        ? '' : ` (${candidate.unavailableDetail})`}; the verdict does not depend on one`]
      : candidate.snapshot.evidence.slice(0, 4)),
    ...(verdict === 'SAFE_TO_PARALLELIZE'
      ? ['no declared feature is shared with an unfinished Task. This is not a guarantee that two'
        + " Agents will never touch the same file: it is the user's own declaration that is compared"]
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

function peerCount(compared: number): string {
  return compared === 0 ? 'no peer was compared' : `${compared} peer(s) declared no shared feature`;
}

/** Human-readable, stable explanation lines for `project impact explain` and the UI. */
export function explainAssessment(assessment: ConflictAssessment): readonly string[] {
  const lines: string[] = [];
  lines.push(`verdict ${assessment.verdict} (${assessment.reasonCodes.join(', ')})`);
  if (assessment.verdict === 'SAFE_TO_PARALLELIZE') {
    lines.push(`reason no declared feature is shared with an unfinished Task`
      + ` (the rule compares declarations, not file overlap)`);
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
    if (hit.features.length > 0) scope.push(`features ${hit.features.join(', ')}`);
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
