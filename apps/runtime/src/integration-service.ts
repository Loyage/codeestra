import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { verificationPolicyPath, verificationPolicyVersion } from '@codeestra/contracts';
import {
  advanceLocalRef,
  createIntegrationWorktree,
  inspectRepository,
  isAncestor,
  listCheckedOutRefs,
  mergeResultCommit,
  readCommitTree,
  readLocalRefCommit,
  removeIntegrationWorktree,
} from '@codeestra/git';
import {
  Phase1Database,
  StorageError,
  type IntegrationBatchCandidates,
  type IntegrationBatchItemSummary,
  type IntegrationBatchPlan,
  type IntegrationBatchState,
  type IntegrationBatchSummary,
  type IntegrationCandidates,
  type MergeStrategy,
  type VerificationRunSummary,
} from '@codeestra/storage';
import {
  executeVerificationPolicy,
  inspectVerificationPolicy,
  type VerificationCommandOutcome,
  type VerificationRunner,
  type VerificationTreeEvidence,
} from './verification-service.js';

export class IntegrationServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'IntegrationServiceError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Bounded failure diagnostics kept in the batch record; never captured command output. */
function boundedDetail(detail: string): string {
  return detail.length <= 4_000 ? detail : detail.slice(0, 4_000);
}

/** One member of a batch as the report exposes it, with its own outcome (ADR-0053). */
export interface IntegrationMemberReport {
  readonly taskId: string;
  readonly executionId: string;
  readonly revisionId: string;
  readonly candidateCommit: string;
  readonly state: IntegrationBatchItemSummary['state'];
  readonly integratedCommit: string | null;
  readonly detail: string | null;
}

export interface IntegrationReport {
  readonly batchId: string;
  readonly projectId: string;
  /** The batch's first member, kept for the single-member command surface. */
  readonly taskId: string;
  readonly executionId: string;
  readonly revisionId: string;
  readonly candidateCommit: string;
  readonly devRef: string;
  readonly devCommit: string;
  readonly state: IntegrationBatchState;
  readonly integratedCommit: string | null;
  readonly mergeStrategy: MergeStrategy | null;
  /** The merge Git produced before the ref moved; null when no merge was recorded. */
  readonly mergedCommit: string | null;
  readonly worktreePath: string | null;
  readonly worktreeDetail: string | null;
  readonly verificationId: string | null;
  readonly verificationState: string | null;
  readonly outcomeCode: string | null;
  readonly detail: string | null;
  readonly commands: readonly VerificationCommandOutcome[];
  readonly tree: VerificationTreeEvidence | null;
  /** Every member's fixed (revision, commit) binding and its own outcome. */
  readonly members: readonly IntegrationMemberReport[];
  /** True for a replay: the recorded batch was returned instead of a second integration. */
  readonly alreadyCompleted: boolean;
  /** True when this call created the batch. */
  readonly created: boolean;
}

/** The recorded batch a composition, read or cancellation returns. */
export interface IntegrationBatchView {
  readonly batchId: string;
  readonly projectId: string;
  readonly devRef: string;
  readonly devCommit: string;
  readonly state: IntegrationBatchState;
  readonly integratedCommit: string | null;
  readonly mergeStrategy: MergeStrategy | null;
  readonly mergedCommit: string | null;
  readonly worktreePath: string | null;
  readonly verificationId: string | null;
  readonly outcomeCode: string | null;
  readonly detail: string | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly members: readonly IntegrationMemberReport[];
  /** True when this call created the batch. */
  readonly created: boolean;
}

interface IntegrationSubject {
  readonly executionId: string;
  readonly revisionId: string;
  readonly candidateCommit: string;
}

/** One member as the integration is about to fix it, together with the Task verification behind it. */
interface PlannedMember extends IntegrationSubject {
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  /** The Task version the batch is composed against; it is what a concurrent change breaks. */
  readonly taskVersion: number;
  readonly taskVerification: VerificationRunSummary;
}

/** The PASSED Task verification an integration verification binds one member to. */
interface MemberVerificationRef {
  readonly verificationId: string;
  readonly testedCommit: string;
}

/**
 * Chooses the Execution whose captured result commit is the evidence to integrate. An explicit
 * Execution must still be the current revision's captured result; otherwise the newest captured
 * result commit of the current revision is used.
 */
function selectExecution(
  candidates: IntegrationCandidates,
  executionId: string | undefined,
): IntegrationSubject {
  const captured = (row: { readonly state: string; readonly resultCommit: string | null }) =>
    row.state === 'SUCCEEDED' && row.resultCommit !== null;
  if (executionId !== undefined) {
    const execution = candidates.executions.find((row) => row.executionId === executionId);
    if (execution === undefined) {
      throw new IntegrationServiceError('EXECUTION_NOT_FOUND', 'Execution was not found for this Task');
    }
    if (execution.appliedRevisionId !== candidates.currentRevisionId) {
      throw new IntegrationServiceError('STALE_REVISION',
        'Task revision changed after this Execution started; integration needs the current revision');
    }
    if (!captured(execution)) {
      throw new IntegrationServiceError('NO_CAPTURED_RESULT',
        `Execution is ${execution.state} without a captured result commit; capture it before integrating`);
    }
    return {
      executionId: execution.executionId,
      revisionId: execution.appliedRevisionId,
      candidateCommit: execution.resultCommit as string,
    };
  }
  const current = candidates.executions.find((row) =>
    row.appliedRevisionId === candidates.currentRevisionId && captured(row));
  if (current === undefined) {
    const stale = candidates.executions.some((row) => captured(row));
    throw new IntegrationServiceError('NO_CAPTURED_RESULT', stale
      ? 'A result commit exists for an older revision; integration needs the current revision'
      : 'No Execution captured a result commit for this Task; run and capture a result first');
  }
  return {
    executionId: current.executionId,
    revisionId: current.appliedRevisionId,
    candidateCommit: current.resultCommit as string,
  };
}

/**
 * The Task verification that has to exist before integration: same revision, same exact result
 * commit, and PASSED. A verification of a different commit is not evidence for this candidate.
 */
function requirePassedTaskVerification(
  candidates: IntegrationCandidates,
  subject: IntegrationSubject,
): VerificationRunSummary {
  const passed = candidates.verificationRuns.find((run) =>
    run.state === 'PASSED'
    && run.revisionId === subject.revisionId
    && run.testedCommit === subject.candidateCommit);
  if (passed !== undefined) return passed;
  const relevant = candidates.verificationRuns.filter((run) =>
    run.revisionId === subject.revisionId && run.testedCommit === subject.candidateCommit);
  const latest = relevant[0];
  throw new IntegrationServiceError('TASK_VERIFICATION_NOT_PASSED', latest === undefined
    ? 'This revision has no Task verification for its result commit; run task verification first'
    : `Task verification for this result commit is ${latest.state}`
      + `${latest.outcomeCode === null ? '' : ` (${latest.outcomeCode})`}`
      + '; integration needs a PASSED Task verification');
}

/** Fixes one Task's member evidence, or refuses with the reason the Task cannot be a member. */
function planMember(input: {
  readonly candidates: IntegrationCandidates;
  readonly executionId?: string;
}): PlannedMember {
  if (input.candidates.taskState !== 'EXECUTED') {
    throw new IntegrationServiceError('TASK_NOT_EXECUTED',
      `Task is ${input.candidates.taskState}; integration needs an EXECUTED Task with a captured`
      + ' result commit');
  }
  const subject = selectExecution(input.candidates, input.executionId);
  return {
    taskId: input.candidates.taskId,
    taskDisplayNumber: input.candidates.taskDisplayNumber,
    taskVersion: input.candidates.taskVersion,
    executionId: subject.executionId,
    revisionId: subject.revisionId,
    candidateCommit: subject.candidateCommit,
    taskVerification: requirePassedTaskVerification(input.candidates, subject),
  };
}

function memberReports(
  items: readonly IntegrationBatchItemSummary[],
): readonly IntegrationMemberReport[] {
  return items.map((item) => ({
    taskId: item.taskId,
    executionId: item.executionId,
    revisionId: item.revisionId,
    candidateCommit: item.candidateCommit,
    state: item.state,
    integratedCommit: item.integratedCommit,
    detail: item.detail,
  }));
}

function batchView(
  batch: IntegrationBatchSummary,
  created: boolean,
): IntegrationBatchView {
  return {
    batchId: batch.batchId,
    projectId: batch.projectId,
    devRef: batch.devRef,
    devCommit: batch.devCommit,
    state: batch.state,
    integratedCommit: batch.integratedCommit,
    mergeStrategy: batch.mergeStrategy,
    mergedCommit: batch.mergedCommit,
    worktreePath: batch.worktreePath,
    verificationId: batch.verificationId,
    outcomeCode: batch.outcomeCode,
    detail: batch.detail,
    createdAt: batch.createdAt,
    completedAt: batch.completedAt,
    members: memberReports(batch.items),
    created,
  };
}

function report(
  batch: IntegrationBatchSummary,
  input: {
    readonly commands: readonly VerificationCommandOutcome[];
    readonly tree: VerificationTreeEvidence | null;
    readonly verificationState: string | null;
    readonly alreadyCompleted: boolean;
    readonly created: boolean;
  },
): IntegrationReport {
  const item = batch.items[0];
  if (item === undefined) {
    throw new IntegrationServiceError('INTEGRATION_BATCH_INVALID',
      `Integration batch ${batch.batchId} has no member`);
  }
  return {
    batchId: batch.batchId,
    projectId: batch.projectId,
    taskId: item.taskId,
    executionId: item.executionId,
    revisionId: item.revisionId,
    candidateCommit: item.candidateCommit,
    devRef: batch.devRef,
    devCommit: batch.devCommit,
    state: batch.state,
    integratedCommit: batch.integratedCommit,
    mergeStrategy: batch.mergeStrategy,
    mergedCommit: batch.mergedCommit,
    worktreePath: batch.worktreePath,
    worktreeDetail: batch.detail,
    verificationId: batch.verificationId,
    verificationState: input.verificationState,
    outcomeCode: batch.outcomeCode,
    detail: batch.detail,
    commands: input.commands,
    tree: input.tree,
    members: memberReports(batch.items),
    alreadyCompleted: input.alreadyCompleted,
    created: input.created,
  };
}

/** A replay reports recorded facts without inventing command output. */
function replayReport(batch: IntegrationBatchSummary): IntegrationReport {
  return report(batch, {
    commands: [], tree: null, verificationState: null, alreadyCompleted: true, created: false,
  });
}

/** Terminal verdicts a batch can already carry; none of them starts new work. */
function isFinished(state: IntegrationBatchState): boolean {
  return state === 'INTEGRATED' || state === 'CONFLICTED' || state === 'FAILED'
    || state === 'RECOVERY_REQUIRED' || state === 'STALE' || state === 'CANCELLED';
}

/**
 * Refuses to advance the `dev` ref while any worktree has it checked out: `git update-ref` would
 * move the ref while that worktree's index and files stayed on the old commit.
 */
async function assertDevRefNotCheckedOut(input: {
  readonly repositoryRoot: string;
  readonly devRef: string;
}): Promise<void> {
  const holder = (await listCheckedOutRefs(input.repositoryRoot))
    .find((entry) => entry.ref === input.devRef);
  if (holder !== undefined) {
    throw new IntegrationServiceError('DEV_REF_CHECKED_OUT',
      `${input.devRef} is checked out in ${holder.path}; merge it there yourself, or integrate from`
      + ' a layout where dev is not checked out, so the branch and its working tree never disagree');
  }
}

function mapStorageError(error: unknown): never {
  if (error instanceof StorageError) {
    throw new IntegrationServiceError(error.code, error.message);
  }
  throw error;
}

function failBatch(input: {
  readonly storage: Phase1Database;
  readonly batchId: string;
  readonly state: 'FAILED' | 'CONFLICTED';
  readonly outcomeCode: string;
  readonly detail: string;
  readonly failedTaskId?: string;
  readonly mergeStrategy?: MergeStrategy;
  readonly mergedCommit?: string;
  readonly randomUUID: () => string;
  readonly now: () => number;
}): IntegrationBatchSummary {
  try {
    return input.storage.failIntegrationBatch({
      batchId: input.batchId,
      state: input.state,
      outcomeCode: input.outcomeCode,
      detail: input.detail,
      ...(input.failedTaskId === undefined ? {} : { failedTaskId: input.failedTaskId }),
      ...(input.mergeStrategy === undefined ? {} : { mergeStrategy: input.mergeStrategy }),
      ...(input.mergedCommit === undefined ? {} : { mergedCommit: input.mergedCommit }),
      eventId: input.randomUUID(),
      failedAt: input.now(),
    });
  } catch (error) {
    mapStorageError(error);
  }
}

function markBatchStale(input: {
  readonly storage: Phase1Database;
  readonly batchId: string;
  readonly outcomeCode: string;
  readonly reason: string;
  readonly randomUUID: () => string;
  readonly now: () => number;
}): IntegrationBatchSummary {
  try {
    return input.storage.markIntegrationBatchStale({
      batchId: input.batchId,
      outcomeCode: input.outcomeCode,
      reason: boundedDetail(input.reason),
      eventId: input.randomUUID(),
      at: input.now(),
    });
  } catch (error) {
    mapStorageError(error);
  }
}

/** The repository, policy and `dev` facts every integration has to re-read before touching a ref. */
interface IntegrationPreflight {
  readonly repositoryRoot: string;
  readonly devCommit: string;
  readonly policyDigest: string;
  readonly policy: Awaited<ReturnType<typeof inspectVerificationPolicy>>;
}

async function inspectIntegrationTarget(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly mainRef: string;
  readonly devRef: string;
  readonly permissionMode: 'FULL' | 'STRICT';
  readonly now: () => number;
}): Promise<IntegrationPreflight> {
  // Identity is re-validated before any ref is read or written; a changed repository invalidates
  // the trust the baseline ref name came from.
  const repository = await inspectRepository(input.repositoryRoot);
  if (repository.repoRoot !== input.repositoryRoot
    || repository.gitCommonDir !== input.gitCommonDir
    || repository.objectFormat !== input.objectFormat) {
    input.storage.invalidateProjectTrust(input.projectId, input.now());
    throw new IntegrationServiceError('REPOSITORY_CHANGED',
      'Project trust invalidated after the repository identity changed');
  }
  const devCommit = await readLocalRefCommit({
    repositoryRoot: repository.repoRoot, ref: input.devRef,
  });
  if (devCommit === null) {
    throw new IntegrationServiceError('DEV_REF_MISSING',
      `The project has no ${input.devRef}; integration needs the long-lived dev branch`);
  }
  await assertDevRefNotCheckedOut({
    repositoryRoot: repository.repoRoot, devRef: input.devRef,
  });
  const policy = await inspectVerificationPolicy({
    repositoryRoot: repository.repoRoot,
    mainRef: input.mainRef,
  });
  if (policy.state === 'ABSENT') {
    throw new IntegrationServiceError('VERIFICATION_POLICY_ABSENT',
      `No verification policy at ${input.mainRef}:${verificationPolicyPath}; an integration`
      + ' needs an independent verification, so add one and re-run project trust');
  }
  const digest = policy.digest as string;
  if (input.permissionMode === 'STRICT') {
    const confirmation = input.storage.getConfirmedVerificationPolicy(input.projectId);
    if (confirmation === null || confirmation.state !== 'PRESENT') {
      throw new IntegrationServiceError('VERIFICATION_POLICY_NOT_CONFIRMED',
        'This project has no confirmed verification policy; run project trust to confirm it');
    }
    if (confirmation.digest !== digest) {
      throw new IntegrationServiceError('VERIFICATION_POLICY_NOT_CONFIRMED',
        `The verification policy changed (confirmed ${confirmation.digest?.slice(0, 12) ?? 'none'},`
        + ` now ${digest.slice(0, 12)}); run project trust to confirm the new policy`);
    }
  }
  return { repositoryRoot: repository.repoRoot, devCommit, policyDigest: digest, policy };
}

/**
 * Composes one IntegrationBatch from the given members and fixes the `dev` baseline it was prepared
 * against. Nothing is written to Git here: the batch is a record about facts that already exist.
 *
 * The request is idempotent by command ID: replaying it returns the batch it already reserved
 * instead of reserving a second one.
 */
async function composeBatch(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly members: readonly PlannedMember[];
  readonly commandId: string;
  readonly devRef: string;
  readonly devCommit: string;
  readonly randomUUID: () => string;
  readonly now: () => number;
}): Promise<Readonly<{ plan: IntegrationBatchPlan; created: boolean }>> {
  const batchId = input.randomUUID();
  try {
    return input.storage.beginIntegrationBatch({
      projectId: input.projectId,
      batchId,
      operationId: input.randomUUID(),
      worktreeOwnershipToken: input.randomUUID(),
      devRef: input.devRef,
      devCommit: input.devCommit,
      members: input.members.map((member) => ({
        taskId: member.taskId,
        executionId: member.executionId,
        expectedVersion: member.taskVersion,
      })),
      commandId: input.commandId,
      payloadHash: sha256(JSON.stringify({
        projectId: input.projectId,
        devRef: input.devRef,
        devCommit: input.devCommit,
        members: input.members.map((member) => ({
          taskId: member.taskId,
          executionId: member.executionId,
          revisionId: member.revisionId,
          candidateCommit: member.candidateCommit,
        })),
      })),
      createdEventId: input.randomUUID(),
      actor: 'runtime-integration',
      createdAt: input.now(),
    });
  } catch (error) {
    mapStorageError(error);
  }
}

/**
 * Merges every member into the batch's fixed `dev` baseline, runs one independent integration
 * verification over the whole result, and only then advances `dev` by compare-and-swap.
 *
 * Member merges happen in one detached integration worktree, in `task_id` order. A member that
 * cannot be merged ends the batch with its own item state recorded and every later member left
 * `PREPARED`; nothing here ever advances the ref after a partial merge.
 */
async function integrateComposedBatch(input: {
  readonly storage: Phase1Database;
  readonly runner: VerificationRunner;
  readonly copiesRoot: string;
  readonly worktreesRoot: string;
  readonly projectId: string;
  readonly batch: IntegrationBatchPlan;
  readonly target: IntegrationPreflight;
  readonly memberVerifications: ReadonlyMap<string, MemberVerificationRef>;
  readonly displayNumbers: ReadonlyMap<string, number>;
  readonly now: () => number;
  readonly randomUUID: () => string;
}): Promise<IntegrationReport> {
  const { storage, batch, randomUUID, now } = input;
  const items = [...batch.items].sort((left, right) =>
    left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0);
  let worktree;
  try {
    worktree = await createIntegrationWorktree({
      repositoryRoot: input.target.repositoryRoot,
      worktreesRoot: input.worktreesRoot,
      projectId: input.projectId,
      batchId: batch.batchId,
      commit: batch.devCommit,
    });
  } catch (error) {
    const failed = failBatch({
      storage, batchId: batch.batchId, state: 'FAILED', outcomeCode: 'WORKTREE_FAILED',
      detail: boundedDetail(error instanceof Error ? error.message : String(error)),
      randomUUID, now,
    });
    return report(failed, { commands: [], tree: null, verificationState: null,
      alreadyCompleted: false, created: true });
  }
  storage.startIntegrationMerge({
    batchId: batch.batchId, worktreePath: worktree.path, startedAt: now(),
  });

  let mergedCommit = batch.devCommit;
  let strategy: MergeStrategy = 'FAST_FORWARD';
  for (const item of items) {
    const step: MergeStrategy = await isAncestor({
      repositoryRoot: input.target.repositoryRoot,
      ancestor: mergedCommit,
      descendant: item.candidateCommit,
    }) ? 'FAST_FORWARD' : 'MERGE_COMMIT';
    const label = input.displayNumbers.get(item.taskId);
    let merged;
    try {
      merged = await mergeResultCommit({
        path: worktree.path,
        candidateCommit: item.candidateCommit,
        baselineCommit: mergedCommit,
        strategy: step,
        message: `Codeestra integration for ${label === undefined ? `task ${item.taskId}`
          : `task #${label}`} (batch ${batch.batchId}, revision ${item.revisionId})`,
      });
    } catch (error) {
      // An unusable repository identity, a refusing hook, or any other unexpected Git failure is
      // recorded as a failed batch instead of leaving the ref and the record in flight.
      const failed = failBatch({
        storage, batchId: batch.batchId, state: 'FAILED', outcomeCode: 'MERGE_FAILED',
        detail: boundedDetail(error instanceof Error ? error.message : String(error)),
        failedTaskId: item.taskId, mergeStrategy: step, randomUUID, now,
      });
      return report(failed, { commands: [], tree: null, verificationState: null,
        alreadyCompleted: false, created: true });
    }
    if (merged.commit === null) {
      const failed = failBatch({
        storage, batchId: batch.batchId,
        state: merged.outcome === 'CONFLICT' ? 'CONFLICTED' : 'FAILED',
        outcomeCode: merged.outcome === 'CONFLICT' ? 'MERGE_CONFLICT' : 'MERGE_FAILED',
        detail: boundedDetail(merged.detail), failedTaskId: item.taskId,
        mergeStrategy: step, randomUUID, now,
      });
      return report(failed, { commands: [], tree: null, verificationState: null,
        alreadyCompleted: false, created: true });
    }
    mergedCommit = merged.commit;
    strategy = merged.outcome === 'FAST_FORWARD' ? 'FAST_FORWARD' : 'MERGE_COMMIT';
    try {
      storage.recordIntegrationMerge({
        batchId: batch.batchId, taskId: item.taskId, mergeStrategy: strategy,
        mergedCommit, eventId: randomUUID(), mergedAt: now(),
      });
    } catch (error) {
      mapStorageError(error);
    }
  }

  // Independent integration verification of the merged commit, before the dev ref moves.
  let testedTree;
  try {
    testedTree = await readCommitTree({
      repositoryRoot: input.target.repositoryRoot,
      commit: mergedCommit,
    });
  } catch (error) {
    const failed = failBatch({
      storage, batchId: batch.batchId, state: 'FAILED', outcomeCode: 'INSPECTION_FAILED',
      detail: boundedDetail(error instanceof Error ? error.message : String(error)),
      mergeStrategy: strategy, mergedCommit, randomUUID, now,
    });
    return report(failed, { commands: [], tree: null, verificationState: null,
      alreadyCompleted: false, created: true });
  }
  const commands = input.target.policy.policy?.commands ?? [];
  const verificationId = randomUUID();
  const queued = storage.beginIntegrationVerification({
    batchId: batch.batchId,
    verificationId,
    operationId: randomUUID(),
    commandId: randomUUID(),
    testedCommit: mergedCommit,
    testedTree,
    policyVersion: verificationPolicyVersion,
    policyDigest: input.target.policyDigest,
    mainCommit: input.target.policy.mainCommit,
    commands,
    copyPath: join(resolve(input.copiesRoot), input.projectId, verificationId),
    queuedAt: now(),
  });
  if (!queued.created) {
    throw new IntegrationServiceError('INTEGRATION_IN_PROGRESS',
      `Integration verification ${queued.plan.verificationId} already exists for this batch`);
  }
  storage.startIntegrationVerification({ verificationId, startedAt: now() });
  const execution = await executeVerificationPolicy({
    repositoryRoot: input.target.repositoryRoot,
    copiesRoot: input.copiesRoot,
    projectId: input.projectId,
    runId: verificationId,
    testedCommit: mergedCommit,
    commands,
    runner: input.runner,
  });
  const verification = storage.completeIntegrationVerification({
    verificationId,
    state: execution.terminalState,
    outcomeCode: execution.outcomeCode,
    eventId: randomUUID(),
    evidence: {
      testedCommit: mergedCommit,
      testedTree,
      devRef: batch.devRef,
      devCommit: batch.devCommit,
      policyVersion: verificationPolicyVersion,
      policyDigest: input.target.policyDigest,
      mainCommit: input.target.policy.mainCommit,
      // The verification covers the whole batch, so every member's fixed binding and the Task
      // verification behind it are part of its evidence (ADR-0053).
      members: items.map((item) => ({
        taskId: item.taskId,
        revisionId: item.revisionId,
        executionId: item.executionId,
        candidateCommit: item.candidateCommit,
        taskVerificationId: input.memberVerifications.get(item.taskId)?.verificationId ?? null,
        taskVerificationTestedCommit:
          input.memberVerifications.get(item.taskId)?.testedCommit ?? null,
      })),
      commands: execution.outcomes.map(commandEvidence),
      tree: execution.tree === null ? null : {
        headCommit: execution.tree.headCommit,
        clean: execution.tree.clean,
        trackedModifications: execution.tree.trackedModifications,
        trackedModifiedDigest: sha256(execution.tree.trackedModifications.join('\0')),
        untrackedFiles: execution.tree.untrackedFiles,
        untrackedDigest: sha256(execution.tree.untrackedFiles.join('\0')),
      },
      copy: { path: execution.copyPath, created: execution.copyCreated,
        removed: execution.copyRemoval.removed, detail: execution.copyRemoval.detail },
      ...(execution.failureDetail === null ? {} : { failureDetail: execution.failureDetail }),
    },
    completedAt: now(),
  });
  if (verification.state !== 'PASSED') {
    const failed = failBatch({
      storage, batchId: batch.batchId, state: 'FAILED',
      outcomeCode: execution.copyCreated ? 'INTEGRATION_VERIFICATION_FAILED' : 'WORKTREE_FAILED',
      detail: boundedDetail(execution.failureDetail
        ?? `integration verification ended ${verification.state} (${verification.outcomeCode})`),
      mergeStrategy: strategy, mergedCommit, randomUUID, now,
    });
    return report(failed, { commands: execution.outcomes, tree: execution.tree,
      verificationState: verification.state, alreadyCompleted: false, created: true });
  }

  // The ref moves last, and only if it still points at the baseline the merge started from. The
  // batch records INTEGRATING_DEV first, so an interrupted write is resolvable by comparing the
  // recorded merge with the ref instead of guessing.
  await assertDevRefNotCheckedOut({
    repositoryRoot: input.target.repositoryRoot, devRef: batch.devRef,
  });
  storage.startIntegrationDevUpdate({ batchId: batch.batchId, updatedAt: now() });
  const advanced = await advanceLocalRef({
    repositoryRoot: input.target.repositoryRoot,
    ref: batch.devRef,
    expectedCommit: batch.devCommit,
    newCommit: mergedCommit,
  });
  if (!advanced.advanced) {
    // The batch's fixed baseline stopped being the current `dev`: the batch is stale, not failed.
    // `dev` keeps whatever it holds, and the merge/verification evidence stays readable.
    const stale = markBatchStale({
      storage, batchId: batch.batchId, outcomeCode: 'DEV_REF_MOVED',
      reason: `${batch.devRef} was not advanced from the recorded baseline ${batch.devCommit}:`
        + ` ${advanced.detail}`,
      randomUUID, now,
    });
    return report(stale, { commands: execution.outcomes, tree: execution.tree,
      verificationState: verification.state, alreadyCompleted: false, created: true });
  }

  const removal = await removeIntegrationWorktree({
    repositoryRoot: input.target.repositoryRoot,
    path: worktree.path,
  }).catch((error: unknown) => ({
    removed: false,
    detail: error instanceof Error ? error.message : String(error),
  }));
  let completed;
  try {
    completed = storage.completeIntegrationBatch({
      batchId: batch.batchId,
      integratedCommit: mergedCommit,
      worktreeDetail: removal.removed
        ? `integration worktree removed after a ${strategy} integration`
        : `integration worktree retained at ${worktree.path}: ${removal.detail}`,
      completedEventId: randomUUID(),
      taskEventIds: items.map(() => randomUUID()),
      completedAt: now(),
    });
  } catch (error) {
    mapStorageError(error);
  }
  return report(completed, {
    commands: execution.outcomes, tree: execution.tree,
    verificationState: verification.state, alreadyCompleted: false, created: true,
  });
}

/**
 * Refuses to compose a batch whose members are already reserved by an unsettled batch of the same
 * project. Two batches over the same member would both believe they own its fixed evidence.
 */
function assertNoMembersInFlight(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskIds: readonly string[];
}): void {
  const reserved = input.storage.listBlockingIntegrationBatches().find((batch) =>
    batch.projectId === input.projectId
    && batch.items.some((item) => input.taskIds.includes(item.taskId)));
  if (reserved !== undefined) {
    throw new IntegrationServiceError('INTEGRATION_IN_PROGRESS',
      `Integration batch ${reserved.batchId} is ${reserved.state} and already holds one of these`
      + ' Tasks; integrate or cancel it first');
  }
}

function memberVerificationsOf(
  members: readonly PlannedMember[],
): ReadonlyMap<string, MemberVerificationRef> {
  return new Map(members.map((member) => [member.taskId, {
    verificationId: member.taskVerification.verificationId,
    testedCommit: member.taskVerification.testedCommit,
  }]));
}

function displayNumbersOf(members: readonly PlannedMember[]): ReadonlyMap<string, number> {
  return new Map(members.map((member) => [member.taskId, member.taskDisplayNumber]));
}

/**
 * Composes a multi-member IntegrationBatch: every member's current revision and captured result
 * commit are fixed, together with the `dev` baseline the batch will be integrated into. The batch
 * starts in `CREATED`; `integrateIntegrationBatch` is what actually merges and verifies it.
 *
 * Nothing is written to Git, and a member set that cannot be integrated is refused before any record
 * is created — a `CREATED` batch means "composed and ready", not "attempted".
 */
export async function createIntegrationBatch(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly members: readonly { readonly taskId: string; readonly expectedVersion: number }[];
  readonly commandId: string;
  readonly permissionMode?: 'FULL' | 'STRICT';
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<IntegrationBatchView> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  if (input.members.length === 0) {
    throw new IntegrationServiceError('INVALID_REQUEST',
      'A batch needs at least one member; name each member Task once');
  }
  if (new Set(input.members.map((member) => member.taskId)).size !== input.members.length) {
    throw new IntegrationServiceError('INVALID_REQUEST',
      'A batch cannot name the same Task twice');
  }
  // The order the request lists members in is not part of the batch: members are fixed, stored and
  // merged in `task_id` order so the same member set always integrates the same way.
  const ordered = [...input.members].sort((left, right) =>
    left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0);
  const candidates = ordered.map((member) => ({
    member,
    candidates: input.storage.getIntegrationCandidates(input.projectId, member.taskId),
  }));
  const planned: PlannedMember[] = candidates.map(({ member, candidates: taskCandidates }) => {
    if (taskCandidates.taskVersion !== member.expectedVersion) {
      throw new IntegrationServiceError('CONCURRENT_MODIFICATION',
        `Task ${member.taskId} version did not match`);
    }
    return planMember({ candidates: taskCandidates });
  });
  assertNoMembersInFlight({
    storage: input.storage, projectId: input.projectId,
    taskIds: planned.map((member) => member.taskId),
  });
  const target = await inspectIntegrationTarget({
    storage: input.storage,
    projectId: input.projectId,
    repositoryRoot: candidates[0]?.candidates.repositoryRoot as string,
    gitCommonDir: candidates[0]?.candidates.gitCommonDir as string,
    objectFormat: candidates[0]?.candidates.objectFormat as 'sha1' | 'sha256',
    mainRef: candidates[0]?.candidates.mainRef as string,
    devRef: candidates[0]?.candidates.devRef as string,
    permissionMode: input.permissionMode ?? 'STRICT',
    now,
  });
  const begun = await composeBatch({
    storage: input.storage,
    projectId: input.projectId,
    members: planned,
    commandId: input.commandId,
    devRef: candidates[0]?.candidates.devRef as string,
    devCommit: target.devCommit,
    randomUUID,
    now,
  });
  return batchView(begun.plan, begun.created);
}

/**
 * Integrates a composed batch: one merge per member, one independent verification over the whole
 * batch, and only then a compare-and-swap advance of `dev` from the recorded baseline.
 *
 * The batch's fixed evidence is re-checked against the current facts first. A member whose revision
 * or result commit moved, or a `dev` that is no longer the recorded baseline, makes the batch
 * `STALE`: nothing is merged, `dev` keeps its value, and the batch has to be composed again.
 */
export async function integrateIntegrationBatch(input: {
  readonly storage: Phase1Database;
  readonly runner: VerificationRunner;
  readonly copiesRoot: string;
  readonly worktreesRoot: string;
  readonly projectId: string;
  readonly batchId: string;
  readonly commandId: string;
  readonly permissionMode?: 'FULL' | 'STRICT';
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<IntegrationReport> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  let candidates: IntegrationBatchCandidates;
  try {
    candidates = input.storage.getIntegrationBatchCandidates(input.projectId, input.batchId);
  } catch (error) {
    mapStorageError(error);
  }
  const batch = candidates.batch;
  if (isFinished(batch.state)) {
    // One read surface: a finished batch reports its recorded verdict, including RECOVERY_REQUIRED,
    // and never re-runs a merge or a verification.
    return replayReport(batch);
  }
  if (batch.state !== 'CREATED') {
    throw new IntegrationServiceError('INTEGRATION_IN_PROGRESS',
      `Integration batch ${batch.batchId} is ${batch.state};`
      + ' it was left in flight by an earlier attempt and needs reconciliation');
  }
  const moved = candidates.members.find((member) =>
    member.taskState !== 'EXECUTED'
    || member.currentRevisionId !== member.revisionId
    || member.executionState !== 'SUCCEEDED'
    || member.resultCommit !== member.candidateCommit
    || member.taskVerificationId === null);
  if (moved !== undefined) {
    const stale = markBatchStale({
      storage: input.storage, batchId: batch.batchId, outcomeCode: 'MEMBER_EVIDENCE_MOVED',
      reason: `Task ${moved.taskId} no longer matches the member record this batch fixed:`
        + ` Task is ${moved.taskState} at revision ${moved.currentRevisionId}`
        + ` (recorded ${moved.revisionId}), its Execution is ${moved.executionState} at`
        + ` ${moved.resultCommit ?? 'no commit'} (recorded ${moved.candidateCommit}),`
        + ' PASSED Task verification for that revision and commit:'
        + ` ${moved.taskVerificationId === null ? 'missing' : 'present'}`,
      randomUUID, now,
    });
    return report(stale, { commands: [], tree: null, verificationState: null,
      alreadyCompleted: false, created: false });
  }
  if (candidates.devRef !== batch.devRef) {
    // Re-trusting a project can rename the baseline ref. The batch fixed the old name, so its
    // baseline is not the branch it would advance any more.
    const stale = markBatchStale({
      storage: input.storage, batchId: batch.batchId, outcomeCode: 'DEV_REF_CHANGED',
      reason: `The batch was composed against ${batch.devRef}, but this project now integrates into`
        + ` ${candidates.devRef}; nothing was merged and no ref was advanced`,
      randomUUID, now,
    });
    return report(stale, { commands: [], tree: null, verificationState: null,
      alreadyCompleted: false, created: false });
  }
  const target = await inspectIntegrationTarget({
    storage: input.storage,
    projectId: input.projectId,
    repositoryRoot: candidates.repositoryRoot,
    gitCommonDir: candidates.gitCommonDir,
    objectFormat: candidates.objectFormat,
    mainRef: candidates.mainRef,
    devRef: candidates.devRef,
    permissionMode: input.permissionMode ?? 'STRICT',
    now,
  });
  if (target.devCommit !== batch.devCommit) {
    const stale = markBatchStale({
      storage: input.storage, batchId: batch.batchId, outcomeCode: 'DEV_REF_MOVED',
      reason: `The batch was composed against ${batch.devRef} at ${batch.devCommit}, but it now`
        + ` points at ${target.devCommit}; nothing was merged and dev was not advanced`,
      randomUUID, now,
    });
    return report(stale, { commands: [], tree: null, verificationState: null,
      alreadyCompleted: false, created: false });
  }
  let plan: IntegrationBatchPlan;
  try {
    plan = input.storage.getIntegrationBatchPlan(input.projectId, input.batchId);
  } catch (error) {
    mapStorageError(error);
  }
  return await integrateComposedBatch({
    storage: input.storage,
    runner: input.runner,
    copiesRoot: input.copiesRoot,
    worktreesRoot: input.worktreesRoot,
    projectId: input.projectId,
    batch: plan,
    target,
    memberVerifications: new Map(candidates.members.map((member) => [member.taskId,
      { verificationId: member.taskVerificationId as string,
        testedCommit: member.taskVerificationTestedCommit as string }])),
    displayNumbers: new Map(candidates.members.map((member) => [member.taskId,
      member.taskDisplayNumber])),
    now,
    randomUUID,
  });
}

/** Reads one recorded batch. */
export function readIntegrationBatch(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly batchId: string;
}): IntegrationBatchView {
  try {
    return batchView(input.storage.getIntegrationBatch(input.projectId, input.batchId), false);
  } catch (error) {
    mapStorageError(error);
  }
}

/**
 * Ends a composed batch. A batch that recorded no worktree, merge or verification is `CANCELLED`;
 * one that did keeps its slot as `RECOVERY_REQUIRED/RECONCILE_REQUIRED`, because the Runtime cannot
 * prove from its own records that no member side effect is still unsettled.
 *
 * Cancelling adds no confirmation in either permission mode: it writes a terminal verdict for a
 * batch that never touched Git, and `dev` is untouched by definition.
 */
export async function cancelIntegrationBatch(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly batchId: string;
  readonly reason?: string;
  readonly commandId: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<IntegrationBatchView> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  try {
    const recorded = input.storage.cancelIntegrationBatch({
      batchId: input.batchId,
      reason: input.reason ?? `cancelled by the user (command ${input.commandId})`,
      eventId: randomUUID(),
      at: now(),
    });
    if (recorded.projectId !== input.projectId) {
      throw new IntegrationServiceError('NOT_FOUND',
        'Integration batch was not found for this project');
    }
    return batchView(recorded, false);
  } catch (error) {
    mapStorageError(error);
  }
}

/**
 * Integrates one Task's captured result commit into the project's long-lived `dev` branch by
 * composing a one-member batch and integrating it in the same command (ADR-0018). Multi-member
 * batches are composed explicitly with `task integration create` and integrated with
 * `task integration integrate` (ADR-0053); this path stays as it was for a single Task.
 *
 * Every step is recorded around its Git side effect:
 *   1. the `dev` ref is read, and it must not be checked out in any worktree;
 *   2. the merge happens in a detached integration worktree inside the Runtime data directory;
 *   3. the merged commit is verified by an independent integration verification run;
 *   4. only after PASS does a compare-and-swap advance `dev` from the recorded baseline.
 *
 * A conflict, a failed verification, a moved `dev` ref, or a crash all leave `dev` untouched and
 * keep the integration worktree for inspection.
 */
export async function integrateTaskResult(input: {
  readonly storage: Phase1Database;
  readonly runner: VerificationRunner;
  readonly copiesRoot: string;
  readonly worktreesRoot: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly commandId: string;
  readonly executionId?: string;
  readonly permissionMode?: 'FULL' | 'STRICT';
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<IntegrationReport> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  let candidates: IntegrationCandidates;
  try {
    candidates = input.storage.getIntegrationCandidates(input.projectId, input.taskId);
  } catch (error) {
    mapStorageError(error);
  }
  if (candidates.taskState !== 'EXECUTED') {
    // An already integrated Task is reported as such instead of being treated as a new request.
    const integrated = candidates.batches.find((batch) =>
      batch.items.some((item) => item.state === 'INTEGRATED'));
    if (integrated !== undefined) return replayReport(integrated);
    throw new IntegrationServiceError('TASK_NOT_EXECUTED',
      `Task is ${candidates.taskState}; integration needs an EXECUTED Task with a captured result commit`);
  }
  if (candidates.taskVersion !== input.expectedVersion) {
    throw new IntegrationServiceError('CONCURRENT_MODIFICATION', 'Task version did not match');
  }
  const member = planMember({
    candidates,
    ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
  });
  assertNoMembersInFlight({
    storage: input.storage, projectId: input.projectId, taskIds: [input.taskId],
  });
  const target = await inspectIntegrationTarget({
    storage: input.storage,
    projectId: input.projectId,
    repositoryRoot: candidates.repositoryRoot,
    gitCommonDir: candidates.gitCommonDir,
    objectFormat: candidates.objectFormat,
    mainRef: candidates.mainRef,
    devRef: candidates.devRef,
    permissionMode: input.permissionMode ?? 'STRICT',
    now,
  });
  const begun = await composeBatch({
    storage: input.storage,
    projectId: input.projectId,
    members: [member],
    commandId: input.commandId,
    devRef: candidates.devRef,
    devCommit: target.devCommit,
    randomUUID,
    now,
  });
  if (!begun.created) {
    if (begun.plan.state !== 'CREATED') return replayReport(begun.plan);
  }
  return await integrateComposedBatch({
    storage: input.storage,
    runner: input.runner,
    copiesRoot: input.copiesRoot,
    worktreesRoot: input.worktreesRoot,
    projectId: input.projectId,
    batch: begun.plan,
    target,
    memberVerifications: memberVerificationsOf([member]),
    displayNumbers: displayNumbersOf([member]),
    now,
    randomUUID,
  });
}

function commandEvidence(outcome: VerificationCommandOutcome): Readonly<Record<string, unknown>> {
  return {
    id: outcome.id,
    argv: outcome.argv,
    cwd: outcome.cwd,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
    stdoutBytes: outcome.stdoutBytes,
    stderrBytes: outcome.stderrBytes,
    stdoutDigest: outcome.stdoutDigest,
    stderrDigest: outcome.stderrDigest,
    ...(outcome.failureDetail === undefined ? {} : { failureDetail: outcome.failureDetail }),
  };
}
