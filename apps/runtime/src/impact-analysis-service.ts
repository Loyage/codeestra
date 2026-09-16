import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  devBranchRef,
  impactPolicyContentDigest,
  impactPolicyDigest,
  impactPolicyLabel,
  impactPolicyPath,
  impactPolicyVersion,
  parseImpactPolicy,
  ImpactPolicyError,
  type ImpactPolicyInspection,
} from '@codeestra/contracts';
import {
  assessCandidate,
  taskIsUnfinishedForConflict,
  createImpactSnapshot,
  explainAssessment,
  impactAnalyzerVersion,
  isSnapshotCurrent,
  normalizeObservedImpactPath,
  type ConflictAssessment,
  type ImpactAssessmentContext,
  type ImpactIncompleteReason,
  type ImpactMapping,
  type ImpactPathCaseMode,
  type ImpactSnapshot,
  type ImpactSubject,
} from '@codeestra/domain';
import { changeSetPaths, inspectChangeSet, inspectRepository, readRefFile,
  readLocalRefCommit } from '@codeestra/git';
import type {
  ConfirmedImpactPolicy, ImpactPolicyConfirmationInput, ImpactSnapshotRecord, Phase1Database,
  TrustedProject,
} from '@codeestra/storage';

/**
 * The Runtime half of deterministic conflict analysis (ADR-0031). It does the impure work — reading
 * the mapping from the project `main` ref, measuring the repository's path case behavior, and
 * inspecting the owned worktree change set — and hands the facts to the pure analyzer in
 * `@codeestra/domain`. Every decision that could make a Task look parallelizable lives in the pure
 * module, so this file can never invent a `SAFE` verdict by accident.
 */

export type ImpactAnalysisErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'TASK_NOT_FOUND'
  | 'IMPACT_POLICY_UNREADABLE'
  | 'IMPACT_SNAPSHOT_UNAVAILABLE'
  | 'IMPACT_WORKSPACE_ABSENT'
  // ADR-0059: declaring a feature is validated when it is written, so these four are refusals of a
  // `task create` / `task revision create` request rather than of an assessment.
  | 'INVALID_FEATURE'
  | 'UNKNOWN_FEATURE'
  | 'IMPACT_POLICY_ABSENT'
  | 'INVALID_IMPACT_POLICY';

export class ImpactAnalysisError extends Error {
  constructor(readonly code: ImpactAnalysisErrorCode, message: string) {
    super(message);
    this.name = 'ImpactAnalysisError';
  }
}

const incompleteReasonNames: readonly ImpactIncompleteReason[] = [
  'POLICY_ABSENT', 'POLICY_INVALID', 'POLICY_NOT_CONFIRMED', 'EMPTY_MAPPING',
  'UNCERTAIN_GLOBAL_EFFECT', 'UNBOUNDED_SCOPE',
];

/**
 * Reads and parses `.codeestra/impact.json` from the given ref. A mapping that cannot be parsed is
 * *reported* as `INVALID` instead of throwing: the fact that a project declares a broken mapping is
 * exactly what the operator needs to see, and it must never be reported as "no mapping".
 */
export async function inspectImpactPolicy(input: {
  readonly repositoryRoot: string;
  readonly mainRef: string;
}): Promise<ImpactPolicyInspection> {
  let read: { readonly commit: string; readonly text: string | null };
  try {
    read = await readRefFile({
      repositoryRoot: input.repositoryRoot,
      ref: input.mainRef,
      path: impactPolicyPath,
    });
  } catch (error) {
    throw new ImpactAnalysisError('IMPACT_POLICY_UNREADABLE',
      `${input.mainRef}:${impactPolicyPath} could not be read:`
        + ` ${error instanceof Error ? error.message : String(error)}`);
  }
  if (read.text === null) {
    return { state: 'ABSENT', mainRef: input.mainRef, mainCommit: read.commit };
  }
  try {
    const policy = parseImpactPolicy(read.text);
    const digest = impactPolicyDigest(policy);
    return {
      state: 'PRESENT',
      mainRef: input.mainRef,
      mainCommit: read.commit,
      digest,
      label: impactPolicyLabel(digest),
      policy,
    };
  } catch (error) {
    if (!(error instanceof ImpactPolicyError)) throw error;
    return {
      state: 'INVALID',
      mainRef: input.mainRef,
      mainCommit: read.commit,
      contentDigest: impactPolicyContentDigest(read.text),
      errorCode: error.code,
      errorMessage: error.message,
    };
  }
}

export interface ImpactPathCaseDetection {
  readonly mode: ImpactPathCaseMode;
  readonly source: 'FILESYSTEM' | 'GIT_CONFIG' | 'CONSERVATIVE_DEFAULT';
  readonly detail: string;
}

function flipCase(value: string): string {
  let flipped = '';
  for (const character of value) {
    if (character >= 'a' && character <= 'z') flipped += character.toUpperCase();
    else if (character >= 'A' && character <= 'Z') flipped += character.toLowerCase();
    else flipped += character;
  }
  return flipped;
}

/**
 * Measures whether the repository's own filesystem is case-insensitive by asking the filesystem:
 * a case-flipped path that resolves to the same directory means two paths differing only by case
 * name one file, so the analyzer must compare them as one. `core.ignorecase` is only a fallback
 * (when no path component has a usable letter), and an unverifiable repository is treated as
 * case-insensitive because that finds *more* overlaps, never fewer.
 */
export async function detectImpactPathCaseMode(repositoryRoot: string): Promise<ImpactPathCaseDetection> {
  let current = repositoryRoot;
  while (current !== dirname(current)) {
    const name = basename(current);
    const flipped = flipCase(name);
    if (flipped !== name) {
      const candidate = join(dirname(current), flipped);
      try {
        const resolved = await realpath(candidate);
        if (resolved === current) {
          return { mode: 'INSENSITIVE', source: 'FILESYSTEM',
            detail: `"${flipped}" resolves to "${name}" in the same parent` };
        }
        return { mode: 'SENSITIVE', source: 'FILESYSTEM',
          detail: `"${flipped}" resolves to "${resolved}", a different path` };
      } catch {
        return { mode: 'SENSITIVE', source: 'FILESYSTEM',
          detail: `"${flipped}" does not exist next to "${name}"` };
      }
    }
    current = dirname(current);
  }
  const process = Bun.spawn(['git', '-C', repositoryRoot, 'config', '--get', 'core.ignorecase'], {
    stdout: 'pipe', stderr: 'ignore', env: { PATH: Bun.env.PATH ?? '' },
  });
  const [exitCode, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  const configured = exitCode === 0 ? stdout.trim() : '';
  if (configured === 'true' || configured === 'false') {
    return {
      mode: configured === 'true' ? 'INSENSITIVE' : 'SENSITIVE',
      source: 'GIT_CONFIG',
      detail: `core.ignorecase=${configured}; no path component could be probed`,
    };
  }
  return {
    mode: 'INSENSITIVE',
    source: 'CONSERVATIVE_DEFAULT',
    detail: 'neither the filesystem nor core.ignorecase could be probed; assuming case-insensitive'
      + ' comparison, which can only find more overlaps',
  };
}

/**
 * The mapping version an ImpactSnapshot binds. The confirmation state is part of the key: a
 * snapshot taken while the mapping was unconfirmed is `UNKNOWN`, and confirming the mapping must
 * produce a new snapshot instead of replaying the old incomplete one.
 */
export function impactPolicyVersionKey(inspection: ImpactPolicyInspection): string {
  if (inspection.state === 'PRESENT' && inspection.digest !== undefined) {
    return inspection.label as string;
  }
  if (inspection.state === 'INVALID') {
    return `${impactPolicyVersion}#invalid-${(inspection.contentDigest ?? '').slice(0, 12)}`;
  }
  return `${impactPolicyVersion}#absent`;
}

function mappingOf(inspection: ImpactPolicyInspection): ImpactMapping | null {
  return inspection.state === 'PRESENT' && inspection.policy !== undefined
    ? inspection.policy
    : null;
}

function policyIncompleteReasons(input: {
  readonly inspection: ImpactPolicyInspection;
  readonly confirmation: ConfirmedImpactPolicy | null;
}): readonly ImpactIncompleteReason[] {
  const { inspection, confirmation } = input;
  if (inspection.state === 'ABSENT') return ['POLICY_ABSENT'];
  if (inspection.state === 'INVALID') return ['POLICY_INVALID'];
  if (confirmation === null || confirmation.state !== 'PRESENT'
    || confirmation.digest !== inspection.digest) {
    return ['POLICY_NOT_CONFIRMED'];
  }
  return [];
}

/** Rehydrates a stored snapshot into the pure analyzer's shape, validating what it reads back. */
export function toDomainSnapshot(record: ImpactSnapshotRecord): ImpactSnapshot {
  const incompleteReasons = record.incompleteReasons.map((reason) => {
    if (!incompleteReasonNames.includes(reason as ImpactIncompleteReason)) {
      throw new ImpactAnalysisError('IMPACT_SNAPSHOT_UNAVAILABLE',
        `Stored snapshot ${record.id} has an unknown incomplete reason "${reason}"`);
    }
    return reason as ImpactIncompleteReason;
  });
  if (record.complete !== (incompleteReasons.length === 0)) {
    throw new ImpactAnalysisError('IMPACT_SNAPSHOT_UNAVAILABLE',
      `Stored snapshot ${record.id} disagrees with itself about completeness`);
  }
  return Object.freeze({
    taskId: record.taskId,
    revisionId: record.revisionId,
    baseCommit: record.baseCommit,
    analyzerVersion: record.analyzerVersion,
    policyVersion: record.policyVersion,
    policyDigest: record.policyDigest,
    caseMode: record.caseMode,
    changeFingerprint: record.changeFingerprint,
    complete: record.complete,
    incompleteReasons: Object.freeze(incompleteReasons),
    files: Object.freeze([...record.files].map(normalizeObservedImpactPath)),
    importantDirectories: Object.freeze([...record.importantDirectories]),
    modules: Object.freeze([...record.modules]),
    globalResources: Object.freeze(record.globalResources.map((resource) => Object.freeze({
      id: resource.id, kind: resource.kind, written: resource.written, read: resource.read,
    }))),
    unclassifiedFiles: Object.freeze([...record.unclassifiedFiles].map(normalizeObservedImpactPath)),
    evidence: Object.freeze([...record.evidence]),
  });
}

/** One Task whose impact must be derived: the candidate, or an active/reserved Task it meets. */
interface ImpactSubjectRef {
  readonly taskId: string;
  readonly taskState: string;
  readonly revisionId: string;
  /** The revision's declared features; absent means the caller did not read them (ADR-0059). */
  readonly features?: readonly string[];
  readonly archived?: boolean;
  readonly workspacePath: string | null;
  readonly workspaceBaseCommit: string | null;
  readonly executionState?: string;
}

export interface ImpactSubjectResolution {
  readonly ref: ImpactSubjectRef;
  /** The snapshot in effect for this Task, reused from storage when it is still current. */
  readonly snapshot: ImpactSnapshotRecord | null;
  readonly observedFiles: readonly string[];
  readonly changeFingerprint: string | null;
  /** `RECORDED` = first observation, `REUSED` = an existing snapshot still described the facts. */
  readonly disposition: 'RECORDED' | 'REUSED' | 'UNAVAILABLE';
  readonly detail: string | null;
  /** Whether the Task's recorded workspace could be looked at at all (ADR-0055 D04). */
  readonly workspaceStatus: WorkspaceObservationStatus;
}

/**
 * What can be said about a Task's recorded workspace *before* any change set is read (ADR-0055 D04).
 *
 * The three states are deliberately distinct, because they are different facts with different
 * remedies: `ABSENT` is a Task that has no (live) workspace row at all — a candidate that has not
 * started yet, for instance; `MISSING` is a path the ledger still names but the disk no longer has,
 * which is what an external tool moving the worktree (or an unobserved reclamation) leaves behind;
 * `PRESENT` is a path that exists, so the only remaining question is whether Git can read it.
 */
export type WorkspaceObservationStatus = 'ABSENT' | 'MISSING' | 'PRESENT';

export function observeWorkspacePath(
  workspacePath: string | null,
  pathExists: (path: string) => boolean = existsSync,
): WorkspaceObservationStatus {
  if (workspacePath === null) return 'ABSENT';
  return pathExists(workspacePath) ? 'PRESENT' : 'MISSING';
}

/**
 * The scheduling-side code for one occupier, from the two facts that decide it: whether its recorded
 * workspace is on disk, and whether a change set could actually be derived from it.
 */
export function occupierCodeOf(
  status: WorkspaceObservationStatus,
  observable: boolean,
): 'OBSERVABLE' | 'WORKSPACE_MISSING' | 'WORKSPACE_UNREADABLE' | 'NO_WORKSPACE' {
  if (status === 'ABSENT') return 'NO_WORKSPACE';
  if (status === 'MISSING') return 'WORKSPACE_MISSING';
  return observable ? 'OBSERVABLE' : 'WORKSPACE_UNREADABLE';
}

async function resolveImpactSubject(input: {
  readonly storage: Phase1Database;
  readonly project: TrustedProject;
  readonly projectId: string;
  readonly ref: ImpactSubjectRef;
  readonly inspection: ImpactPolicyInspection;
  readonly confirmation: ConfirmedImpactPolicy | null;
  readonly caseMode: ImpactPathCaseMode;
  readonly caseDetail: string;
  readonly now: number;
}): Promise<ImpactSubjectResolution> {
  const unavailable = (detail: string): Omit<ImpactSubjectResolution, 'workspaceStatus'> => ({
    ref: input.ref,
    snapshot: null,
    observedFiles: Object.freeze([]),
    changeFingerprint: null,
    disposition: 'UNAVAILABLE',
    detail,
  });
  if (input.ref.workspacePath === null || input.ref.workspaceBaseCommit === null) {
    return { ...unavailable(`${input.ref.taskId} has no live workspace, so its change set cannot be`
      + ' observed; no overlap with it can be excluded'), workspaceStatus: 'ABSENT' };
  }
  if (observeWorkspacePath(input.ref.workspacePath) === 'MISSING') {
    // The ledger still names a workspace path the disk no longer has. Saying only "the change set
    // could not be inspected" would hide the actionable fact (nothing is left to observe) and the
    // remedy (reconcile the Task, then reclaim or rebuild its worktree), so the path is named here.
    return { ...unavailable(`${input.ref.taskId} records the workspace at`
      + ` ${input.ref.workspacePath} but nothing is there on disk, so its change set cannot be`
      + ' observed; no overlap with it can be excluded'), workspaceStatus: 'MISSING' };
  }
  let paths: readonly string[];
  let changeFingerprint: string;
  try {
    const changeSet = await inspectChangeSet({
      workspacePath: input.ref.workspacePath,
      baseCommit: input.ref.workspaceBaseCommit,
    });
    paths = changeSetPaths(changeSet);
    changeFingerprint = changeSet.treeFingerprint;
  } catch (error) {
    return { ...unavailable(`${input.ref.taskId} change set could not be inspected:`
      + ` ${error instanceof Error ? error.message : String(error)}`), workspaceStatus: 'PRESENT' };
  }
  const policyVersion = impactPolicyVersionKey(input.inspection);
  const context: ImpactAssessmentContext = {
    baseCommit: input.ref.workspaceBaseCommit,
    policyVersion,
    analyzerVersion: impactAnalyzerVersion,
  };
  // Reuse is only allowed for a snapshot that still describes the same facts exactly: same
  // revision, base, mapping, analyzer, and the identical set of observed paths. Anything else — a
  // grown diff, a removed change, an amendment, a moved baseline, or an edited mapping — records a
  // new snapshot, and the previous one stays readable as audit.
  const stored = input.storage.listImpactSnapshots({
    projectId: input.projectId, taskId: input.ref.taskId, limit: 50,
  });
  for (const candidate of stored) {
    if (candidate.analyzerVersion !== impactAnalyzerVersion) continue;
    try {
      const current = isSnapshotCurrent({
        snapshot: toDomainSnapshot(candidate),
        observedFiles: paths,
        context,
        currentRevisionId: input.ref.revisionId,
      });
      if (!current.current) continue;
    } catch {
      continue;
    }
    return {
      ref: input.ref,
      snapshot: candidate,
      observedFiles: Object.freeze(paths),
      changeFingerprint: candidate.changeFingerprint,
      disposition: 'REUSED',
      detail: null,
      workspaceStatus: 'PRESENT',
    };
  }

  const snapshot = createImpactSnapshot({
    taskId: input.ref.taskId,
    revisionId: input.ref.revisionId,
    baseCommit: input.ref.workspaceBaseCommit,
    policyVersion,
    policyDigest: input.inspection.state === 'PRESENT'
      ? input.inspection.digest as string
      : input.inspection.state === 'INVALID'
        ? input.inspection.contentDigest as string
        : impactPolicyContentDigest('ABSENT'),
    caseMode: input.caseMode,
    paths,
    changeFingerprint,
    mapping: mappingOf(input.inspection),
    incompleteReasons: policyIncompleteReasons({
      inspection: input.inspection, confirmation: input.confirmation,
    }),
    evidence: [
      `worktree ${input.ref.workspacePath}`,
      `path case mode measured on ${input.caseDetail}`,
      ...(input.inspection.state === 'PRESENT'
        ? [`mapping declared ${input.inspection.policy?.importantDirectories.length ?? 0} important`
          + ` director(ies), ${input.inspection.policy?.modules.length ?? 0} module(s),`
          + ` ${input.inspection.policy?.globalResources.length ?? 0} shared resource(s)`]
        : []),
    ],
  });
  const recorded = input.storage.recordImpactSnapshot({
    id: randomUUID(),
    projectId: input.projectId,
    taskId: snapshot.taskId,
    revisionId: snapshot.revisionId,
    baseCommit: snapshot.baseCommit,
    analyzerVersion: snapshot.analyzerVersion,
    policyVersion: snapshot.policyVersion,
    policyDigest: snapshot.policyDigest,
    caseMode: snapshot.caseMode,
    changeFingerprint: snapshot.changeFingerprint,
    complete: snapshot.complete,
    incompleteReasons: snapshot.incompleteReasons,
    files: snapshot.files,
    importantDirectories: snapshot.importantDirectories,
    modules: snapshot.modules,
    globalResources: snapshot.globalResources,
    unclassifiedFiles: snapshot.unclassifiedFiles,
    evidence: snapshot.evidence,
    createdAt: input.now,
  });
  return {
    ref: input.ref,
    snapshot: recorded,
    observedFiles: Object.freeze(paths),
    changeFingerprint,
    disposition: 'RECORDED',
    detail: null,
    workspaceStatus: 'PRESENT',
  };
}

/**
 * The confirmation a `project trust` records for an inspection. `INVALID` keeps the digest of the
 * raw bytes so a broken mapping stays distinguishable from "this project declares no mapping".
 */
export function impactPolicyConfirmation(
  inspection: ImpactPolicyInspection,
): ImpactPolicyConfirmationInput {
  return {
    state: inspection.state,
    digest: inspection.digest ?? null,
    contentDigest: inspection.contentDigest ?? null,
    code: inspection.errorCode ?? null,
    mainRef: inspection.mainRef,
    mainCommit: inspection.mainCommit,
  };
}

export interface ImpactPolicyReport {
  readonly state: 'ABSENT' | 'PRESENT' | 'INVALID';
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly digest: string | null;
  readonly contentDigest: string | null;
  readonly label: string | null;
  readonly confirmed: boolean;
  readonly confirmationState: 'ABSENT' | 'PRESENT' | 'INVALID' | 'NOT_RECORDED';
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly importantDirectories: number;
  readonly modules: number;
  readonly globalResources: number;
}

export function impactPolicyReport(input: {
  readonly inspection: ImpactPolicyInspection;
  readonly confirmation: ConfirmedImpactPolicy | null;
}): ImpactPolicyReport {
  const { inspection, confirmation } = input;
  return {
    state: inspection.state,
    mainRef: inspection.mainRef,
    mainCommit: inspection.mainCommit,
    digest: inspection.digest ?? null,
    contentDigest: inspection.contentDigest ?? null,
    label: inspection.label ?? null,
    confirmed: policyIncompleteReasons(input).length === 0,
    confirmationState: confirmation?.state ?? 'NOT_RECORDED',
    errorCode: inspection.errorCode ?? null,
    errorMessage: inspection.errorMessage ?? null,
    importantDirectories: inspection.policy?.importantDirectories.length ?? 0,
    modules: inspection.policy?.modules.length ?? 0,
    globalResources: inspection.policy?.globalResources.length ?? 0,
  };
}

export interface ImpactAnalysisContext {
  readonly projectId: string;
  readonly inspection: ImpactPolicyInspection;
  readonly confirmation: ConfirmedImpactPolicy | null;
  readonly caseDetection: ImpactPathCaseDetection;
}

export interface ImpactPolicyValidation {
  /** Stable code a script can branch on; `OK*` are the only codes that exit 0. */
  readonly code: 'OK' | 'OK_UNTRUSTED' | 'POLICY_ABSENT' | 'POLICY_INVALID' | 'POLICY_NOT_CONFIRMED';
  readonly valid: boolean;
  readonly repoRoot: string;
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly trusted: { readonly projectId: string; readonly name: string } | null;
  readonly policy: ImpactPolicyReport;
  readonly warnings: readonly string[];
  readonly analyzerVersion: string;
}

/**
 * Validates `.codeestra/impact.json` at a repository's `main` ref without changing anything, and
 * reports whether the mapping a snapshot would use is actually in effect: a mapping that is present
 * but never confirmed is `POLICY_NOT_CONFIRMED`, which is the state that makes every snapshot
 * incomplete. This is the pre-flight check for "why is my analysis always UNKNOWN?".
 *
 * It deliberately does not check whether every declared path exists in the repository: a path that a
 * Task is about to create is a legitimate declaration, and the snapshot reports what the mapping
 * actually matched (`importantDirectories`, `modules`, `unclassifiedFiles`) for every revision.
 */
export async function validateImpactPolicy(input: {
  readonly storage: Phase1Database;
  readonly path: string;
}): Promise<ImpactPolicyValidation> {
  const identity = await inspectRepository(input.path);
  const inspection = await inspectImpactPolicy({
    repositoryRoot: identity.repoRoot, mainRef: identity.mainRef,
  });
  const trustedProject = input.storage.listTrustedProjects()
    .find((project) => project.repoRoot === identity.repoRoot) ?? null;
  const confirmation = trustedProject === null
    ? null
    : input.storage.getConfirmedImpactPolicy(trustedProject.id);
  const report = impactPolicyReport({ inspection, confirmation });
  const warnings: string[] = [];
  const policy = inspection.state === 'PRESENT' ? inspection.policy : undefined;
  if (policy !== undefined) {
    if (policy.importantDirectories.length === 0 && policy.modules.length === 0
      && policy.globalResources.length === 0) {
      warnings.push(`${impactPolicyPath} declares no important directory, module, or shared resource,`
        + ' so every ImpactSnapshot stays incomplete and every verdict is UNKNOWN');
    }
    for (const resource of policy.globalResources) {
      if (resource.consumers.state === 'UNKNOWN') {
        warnings.push(`shared resource "${resource.id}" declares unknown consumers: changing it makes`
          + ' the writing revision incomplete (UNKNOWN) until its consumers are declared');
      }
    }
  }
  let code: ImpactPolicyValidation['code'];
  if (inspection.state === 'ABSENT') code = 'POLICY_ABSENT';
  else if (inspection.state === 'INVALID') code = 'POLICY_INVALID';
  else if (trustedProject === null) code = 'OK_UNTRUSTED';
  else if (report.confirmed) code = 'OK';
  else code = 'POLICY_NOT_CONFIRMED';
  if (code === 'POLICY_NOT_CONFIRMED') {
    warnings.push('the mapping at the main ref does not match the confirmation recorded by'
      + ' `project trust`; re-run project trust to confirm it (0 steps in FULL mode)');
  }
  return {
    code,
    valid: inspection.state === 'PRESENT',
    repoRoot: identity.repoRoot,
    mainRef: identity.mainRef,
    mainCommit: inspection.mainCommit,
    trusted: trustedProject === null
      ? null
      : { projectId: trustedProject.id, name: trustedProject.name },
    policy: report,
    warnings: Object.freeze(warnings),
    analyzerVersion: impactAnalyzerVersion,
  };
}

async function loadContext(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
}): Promise<{ readonly project: TrustedProject; readonly context: ImpactAnalysisContext }> {
  const project = input.storage.listTrustedProjects().find((candidate) => candidate.id === input.projectId);
  if (project === undefined) {
    throw new ImpactAnalysisError('PROJECT_NOT_FOUND', `Project ${input.projectId} is not trusted`);
  }
  const inspection = await inspectImpactPolicy({
    repositoryRoot: project.repoRoot, mainRef: project.mainRef,
  });
  return {
    project,
    context: {
      projectId: input.projectId,
      inspection,
      confirmation: input.storage.getConfirmedImpactPolicy(input.projectId),
      caseDetection: await detectImpactPathCaseMode(project.repoRoot),
    },
  };
}

/**
 * Reads the development baseline the impact facts are expressed against (ADR-0056 / ADR-0060): the
 * project's dev clone and its long-lived `dev` when one is recorded, otherwise the project folder's
 * own HEAD — the same repository a managed project's Task worktrees come from. A folder on a detached
 * HEAD (or an unreadable one) reports null instead of inventing a branch: the Task's own recorded
 * workspace base is reported separately, and a missing project baseline stays visible as missing.
 */
async function readProjectDevCommit(project: TrustedProject): Promise<string | null> {
  if (project.devRepoPath === null) {
    return await inspectRepository(project.repoRoot).then((repository) => repository.headCommit)
      .catch(() => null);
  }
  return await readLocalRefCommit({ repositoryRoot: project.devRepoPath, ref: devBranchRef });
}

export interface ImpactSnapshotReport {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskState: string;
  readonly revisionId: string;
  readonly policy: ImpactPolicyReport;
  readonly caseMode: ImpactPathCaseMode;
  readonly caseModeSource: string;
  readonly caseModeDetail: string;
  readonly disposition: ImpactSubjectResolution['disposition'];
  readonly dispositionDetail: string | null;
  readonly baseline: {
    readonly workspaceBaseCommit: string | null;
    readonly projectDevCommit: string | null;
    readonly matchesProjectDev: boolean;
  };
  readonly snapshot: ImpactSnapshotRecord | null;
  readonly unavailableDetail: string | null;
  /** Whether the Recorded workspace was on disk when this report was produced (ADR-0055 D04). */
  readonly workspaceStatus: WorkspaceObservationStatus;
}

/** Trimmed, de-duplicated, order-preserving: a feature list is a set of ids, not a sequence. */
function normalizeFeatures(features: readonly string[] | undefined): readonly string[] {
  if (features === undefined) return Object.freeze([]);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of features) {
    const feature = raw.trim();
    if (feature.length === 0) {
      throw new ImpactAnalysisError('INVALID_FEATURE',
        'A feature id must not be blank');
    }
    if (seen.has(feature)) continue;
    seen.add(feature);
    normalized.push(feature);
  }
  return Object.freeze(normalized);
}

/**
 * Validates a Task's declared features against the project's **declared mapping** (ADR-0059 D03).
 *
 * The feature ids are module ids from `.codeestra/impact.json` as read from the project's main ref,
 * so a Task can only declare a feature the repository actually knows about — and the same file that
 * already describes the project's boundaries stays the single place where they are named.
 *
 * Two deliberate choices, both stated in the ADR:
 *
 *  - **Validation happens when the Task is created or amended, not when a conflict is judged.** Once
 *    the id is stored, the verdict is a pure comparison of ids and needs no mapping at all. That is
 *    what removes the old "missing/unconfirmed mapping ⇒ `UNKNOWN`" failure mode entirely.
 *  - **The mapping does not have to be *trust-confirmed* to be used here.** `project trust` records a
 *    confirmation of the mapping (ADR-0031 D07) and the UI's trust flow does not send one, so
 *    requiring it would make `--feature` unusable for projects trusted from the interface. What is
 *    required is that the mapping can be *read* and declares the id; whether it is confirmed remains
 *    a fact `project impact validate` reports.
 */
export async function resolveDeclaredFeatures(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly features: readonly string[] | undefined;
}): Promise<readonly string[]> {
  const features = normalizeFeatures(input.features);
  if (features.length === 0) return features;
  const project = input.storage.listTrustedProjects()
    .find((candidate) => candidate.id === input.projectId);
  if (project === undefined) {
    throw new ImpactAnalysisError('PROJECT_NOT_FOUND', `Project ${input.projectId} is not trusted`);
  }
  const inspection = await inspectImpactPolicy({
    repositoryRoot: project.repoRoot, mainRef: project.mainRef,
  });
  if (inspection.state === 'ABSENT') {
    throw new ImpactAnalysisError('IMPACT_POLICY_ABSENT',
      `Project ${project.repoRoot} declares no ${impactPolicyPath} on ${project.mainRef}, so no`
      + ' feature id can be declared: list them under `modules` in that file first');
  }
  if (inspection.state === 'INVALID') {
    throw new ImpactAnalysisError('INVALID_IMPACT_POLICY',
      `${project.mainRef}:${impactPolicyPath} is not a valid mapping (${inspection.errorCode}):`
      + ` ${inspection.errorMessage}`);
  }
  const policy = inspection.policy;
  if (policy === undefined) {
    throw new ImpactAnalysisError('INVALID_IMPACT_POLICY',
      `${project.mainRef}:${impactPolicyPath} could not be parsed`);
  }
  const declared = new Set(policy.modules.map((module) => module.id));
  const unknown = features.filter((feature) => !declared.has(feature));
  if (unknown.length > 0) {
    throw new ImpactAnalysisError('UNKNOWN_FEATURE',
      `Feature(s) ${unknown.join(', ')} are not declared as a module id in`
      + ` ${project.mainRef}:${impactPolicyPath}; declared: `
      + `${[...declared].sort().join(', ') || 'none'}`);
  }
  return features;
}

/**
 * Derives (or reuses) the ImpactSnapshot of one Task's current revision against its own baseline.
 * The Task does not have to be READY: a snapshot is an observation of the owned worktree, so it
 * stays derivable after a run finished and explains why a stored prediction is no longer used.
 */
export async function inspectTaskImpact(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskId: string;
  readonly now: number;
}): Promise<ImpactSnapshotReport> {
  const { project, context } = await loadContext(input);
  const task = input.storage.getImpactCandidateTask(input.projectId, input.taskId);
  if (task === null) {
    throw new ImpactAnalysisError('TASK_NOT_FOUND',
      `Task ${input.taskId} was not found in project ${input.projectId}`);
  }
  const resolution = await resolveImpactSubject({
    storage: input.storage,
    project,
    projectId: input.projectId,
    ref: {
      taskId: task.taskId,
      taskState: task.taskState,
      revisionId: task.revisionId,
      workspacePath: task.workspacePath,
      workspaceBaseCommit: task.workspaceBaseCommit,
    },
    inspection: context.inspection,
    confirmation: context.confirmation,
    caseMode: context.caseDetection.mode,
    caseDetail: context.caseDetection.detail,
    now: input.now,
  });
  const projectDevCommit = await readProjectDevCommit(project);
  return {
    projectId: input.projectId,
    taskId: task.taskId,
    taskState: task.taskState,
    revisionId: task.revisionId,
    policy: impactPolicyReport({ inspection: context.inspection, confirmation: context.confirmation }),
    caseMode: context.caseDetection.mode,
    caseModeSource: context.caseDetection.source,
    caseModeDetail: context.caseDetection.detail,
    disposition: resolution.disposition,
    dispositionDetail: resolution.detail,
    baseline: {
      workspaceBaseCommit: task.workspaceBaseCommit,
      projectDevCommit,
      matchesProjectDev: task.workspaceBaseCommit !== null && task.workspaceBaseCommit === projectDevCommit,
    },
    snapshot: resolution.snapshot,
    unavailableDetail: resolution.snapshot === null ? resolution.detail : null,
    workspaceStatus: resolution.workspaceStatus,
  };
}

export interface ImpactAssessmentReport {
  readonly projectId: string;
  readonly taskId: string;
  readonly revisionId: string;
  readonly candidate: ImpactSnapshotReport;
  readonly active: readonly {
    readonly taskId: string;
    readonly taskState: string;
    readonly executionState: string;
    readonly revisionId: string;
    /** The peer's declared features: the judged fact of the comparison (ADR-0059). */
    readonly features: readonly string[];
    /** Whether the peer is "not finished yet", which is what makes a shared feature a conflict. */
    readonly unfinished: boolean;
    readonly disposition: ImpactSubjectResolution['disposition'];
    readonly complete: boolean;
    readonly incompleteReasons: readonly string[];
    readonly changeFingerprint: string | null;
    readonly detail: string | null;
    /** `OBSERVABLE` / `WORKSPACE_MISSING` / `WORKSPACE_UNREADABLE` / `NO_WORKSPACE` (ADR-0055 D04). */
    readonly code: string;
  }[];
  readonly assessment: ConflictAssessment;
  readonly explanation: readonly string[];
  /** One stored pair-wise audit row per compared Task. */
  readonly recordedAssessments: readonly {
    readonly otherTaskId: string;
    readonly verdict: string;
    readonly reasonCodes: readonly string[];
  }[];
}

/**
 * Assesses one Task against every active/reserved Task of its project. Each compared pair is
 * persisted as its own append-only row keyed by the two snapshots; the aggregate verdict the user
 * sees is the domain analyzer's own, computed over the same subjects.
 */
export async function assessTaskImpact(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskId: string;
  readonly now: number;
}): Promise<ImpactAssessmentReport> {
  const { project, context } = await loadContext(input);
  const task = input.storage.getImpactCandidateTask(input.projectId, input.taskId);
  if (task === null) {
    throw new ImpactAnalysisError('TASK_NOT_FOUND',
      `Task ${input.taskId} was not found in project ${input.projectId}`);
  }
  const candidateRef: ImpactSubjectRef = {
    taskId: task.taskId,
    taskState: task.taskState,
    revisionId: task.revisionId,
    features: task.features,
    archived: task.archived,
    workspacePath: task.workspacePath,
    workspaceBaseCommit: task.workspaceBaseCommit,
  };
  const candidate = await resolveImpactSubject({
    storage: input.storage, project, projectId: input.projectId, ref: candidateRef,
    inspection: context.inspection, confirmation: context.confirmation,
    caseMode: context.caseDetection.mode, caseDetail: context.caseDetection.detail, now: input.now,
  });
  // The conflict input is the *declaration* set, not the resource-holding set (ADR-0059 D05): a
  // `READY` Task that has not started yet is exactly the case the rule is about. Snapshot evidence is
  // read from what is already recorded instead of being derived per peer, because the verdict no
  // longer depends on it.
  const featurePeers = input.storage.listFeatureConflictPeers(input.projectId, input.taskId);
  const active: ImpactSubjectResolution[] = featurePeers.map((peer) => {
    const snapshot = input.storage.listImpactSnapshots({ projectId: input.projectId,
      taskId: peer.taskId, limit: 1 })[0] ?? null;
    return {
      ref: {
        taskId: peer.taskId,
        taskState: peer.taskState,
        revisionId: peer.revisionId,
        features: peer.features,
        archived: peer.archived,
        workspacePath: null,
        workspaceBaseCommit: null,
      },
      snapshot,
      observedFiles: snapshot?.files ?? [],
      changeFingerprint: snapshot?.changeFingerprint ?? null,
      disposition: snapshot === null ? 'UNAVAILABLE' : 'REUSED',
      detail: snapshot === null
        ? 'no ImpactSnapshot is recorded for this Task; the verdict does not depend on one'
        : null,
      workspaceStatus: 'ABSENT',
    };
  });

  const contextFacts: ImpactAssessmentContext = {
    baseCommit: candidate.snapshot?.baseCommit ?? candidateRef.workspaceBaseCommit ?? '',
    policyVersion: candidate.snapshot?.policyVersion ?? impactPolicyVersionKey(context.inspection),
    analyzerVersion: impactAnalyzerVersion,
  };
  const candidateSubject = toSubject(candidate);
  const activeSubjects = active.map(toSubject);
  const assessment = assessCandidate({
    candidate: candidateSubject,
    active: activeSubjects,
    context: contextFacts,
  });

  const recordedAssessments: { otherTaskId: string; verdict: string; reasonCodes: readonly string[] }[] = [];
  if (candidate.snapshot !== null) {
    for (const peer of active) {
      if (peer.snapshot === null) continue;
      const pair = assessCandidate({
        candidate: candidateSubject,
        active: [toSubject(peer)],
        context: contextFacts,
      });
      const stored = input.storage.recordImpactAssessment({
        id: randomUUID(),
        projectId: input.projectId,
        candidateTaskId: candidateRef.taskId,
        candidateRevisionId: candidateRef.revisionId,
        candidateSnapshotId: candidate.snapshot.id,
        otherTaskId: peer.ref.taskId,
        otherRevisionId: peer.ref.revisionId,
        otherSnapshotId: peer.snapshot.id,
        verdict: pair.verdict,
        reasonCodes: pair.reasonCodes,
        hits: pair.hits,
        evidence: pair.evidence,
        createdAt: input.now,
      });
      recordedAssessments.push({
        otherTaskId: peer.ref.taskId,
        verdict: stored.verdict,
        reasonCodes: stored.reasonCodes,
      });
    }
  }

  const projectDevCommit = await readProjectDevCommit(project);
  return {
    projectId: input.projectId,
    taskId: task.taskId,
    revisionId: task.revisionId,
    candidate: {
      projectId: input.projectId,
      taskId: task.taskId,
      taskState: task.taskState,
      revisionId: task.revisionId,
      policy: impactPolicyReport({ inspection: context.inspection, confirmation: context.confirmation }),
      caseMode: context.caseDetection.mode,
      caseModeSource: context.caseDetection.source,
      caseModeDetail: context.caseDetection.detail,
      disposition: candidate.disposition,
      dispositionDetail: candidate.detail,
      baseline: {
        workspaceBaseCommit: task.workspaceBaseCommit,
        projectDevCommit,
        matchesProjectDev: task.workspaceBaseCommit !== null
          && task.workspaceBaseCommit === projectDevCommit,
      },
      snapshot: candidate.snapshot,
      unavailableDetail: candidate.snapshot === null ? candidate.detail : null,
      workspaceStatus: candidate.workspaceStatus,
    },
    active: active.map((resolution) => ({
      taskId: resolution.ref.taskId,
      taskState: resolution.ref.taskState,
      executionState: resolution.ref.executionState ?? 'UNKNOWN',
      revisionId: resolution.ref.revisionId,
      /** The declaration the comparison was made of (ADR-0059); the reason a pair conflicts. */
      features: resolution.ref.features ?? Object.freeze([]),
      unfinished: taskIsUnfinishedForConflict({
        state: resolution.ref.taskState, archived: resolution.ref.archived ?? false,
      }),
      disposition: resolution.disposition,
      complete: resolution.snapshot?.complete ?? false,
      incompleteReasons: resolution.snapshot?.incompleteReasons ?? Object.freeze([]),
      changeFingerprint: resolution.snapshot?.changeFingerprint ?? null,
      detail: resolution.detail,
      code: occupierCodeOf(resolution.workspaceStatus, resolution.snapshot !== null),
    })),
    assessment,
    explanation: explainAssessment(assessment),
    recordedAssessments: Object.freeze(recordedAssessments),
  };
}

function toSubject(resolution: ImpactSubjectResolution): ImpactSubject {
  return {
    taskId: resolution.ref.taskId,
    currentRevisionId: resolution.ref.revisionId,
    features: resolution.ref.features ?? Object.freeze([]),
    taskState: resolution.ref.taskState,
    archived: resolution.ref.archived ?? false,
    snapshot: resolution.snapshot === null ? null : toDomainSnapshot(resolution.snapshot),
    observedFiles: resolution.observedFiles,
    ...(resolution.detail === null ? {} : { unavailableDetail: resolution.detail }),
  };
}
