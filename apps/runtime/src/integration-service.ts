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

export interface IntegrationReport {
  readonly batchId: string;
  readonly projectId: string;
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
  /** True for a replay: the recorded batch was returned instead of a second integration. */
  readonly alreadyCompleted: boolean;
  /** True when this call created the batch. */
  readonly created: boolean;
}

interface IntegrationSubject {
  readonly executionId: string;
  readonly revisionId: string;
  readonly candidateCommit: string;
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

/**
 * A batch that is not finished. A restart-interrupted batch counts here even though it is
 * terminal: its Git state is unknown, so it needs a human before another attempt starts.
 */
function blocksNewIntegration(state: IntegrationBatchState): boolean {
  return state === 'CREATED' || state === 'PREPARING' || state === 'VERIFYING'
    || state === 'INTEGRATING_DEV' || state === 'RECOVERY_REQUIRED';
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

function failBatch(input: {
  readonly storage: Phase1Database;
  readonly batchId: string;
  readonly state: 'FAILED' | 'CONFLICTED';
  readonly outcomeCode: string;
  readonly detail: string;
  readonly mergeStrategy?: MergeStrategy;
  readonly randomUUID: () => string;
  readonly now: () => number;
}): IntegrationBatchSummary {
  try {
    return input.storage.failIntegrationBatch({
      batchId: input.batchId,
      state: input.state,
      outcomeCode: input.outcomeCode,
      detail: input.detail,
      ...(input.mergeStrategy === undefined ? {} : { mergeStrategy: input.mergeStrategy }),
      eventId: input.randomUUID(),
      failedAt: input.now(),
    });
  } catch (error) {
    if (error instanceof StorageError) {
      throw new IntegrationServiceError(error.code, error.message);
    }
    throw error;
  }
}

/**
 * Integrates one Task's captured result commit into the project's long-lived `dev` branch.
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
  const candidates = input.storage.getIntegrationCandidates(input.projectId, input.taskId);
  if (candidates.taskState !== 'EXECUTED') {
    // An already integrated Task is reported as such instead of being treated as a new request.
    const integrated = candidates.batches.find((batch) =>
      batch.items.some((item) => item.state === 'INTEGRATED'));
    if (integrated !== undefined) return replayReport(integrated);
    throw new IntegrationServiceError('TASK_NOT_EXECUTED',
      `Task is ${candidates.taskState}; integration needs an EXECUTED Task with a captured result commit`);
  }
  const inFlight = candidates.batches.find((batch) => blocksNewIntegration(batch.state));
  if (inFlight !== undefined) {
    throw new IntegrationServiceError('INTEGRATION_IN_PROGRESS',
      `Integration batch ${inFlight.batchId} is ${inFlight.state};`
      + ' it was left in flight by an earlier attempt and needs reconciliation');
  }
  const subject = selectExecution(candidates, input.executionId);
  const taskVerification = requirePassedTaskVerification(candidates, subject);

  // Identity is re-validated before any ref is read or written; a changed repository invalidates
  // the trust the baseline ref name came from.
  const repository = await inspectRepository(candidates.repositoryRoot);
  if (repository.repoRoot !== candidates.repositoryRoot
    || repository.gitCommonDir !== candidates.gitCommonDir
    || repository.objectFormat !== candidates.objectFormat) {
    input.storage.invalidateProjectTrust(input.projectId, now());
    throw new IntegrationServiceError('REPOSITORY_CHANGED',
      'Project trust invalidated after the repository identity changed');
  }
  const devCommit = await readLocalRefCommit({
    repositoryRoot: repository.repoRoot, ref: candidates.devRef,
  });
  if (devCommit === null) {
    throw new IntegrationServiceError('DEV_REF_MISSING',
      `The project has no ${candidates.devRef}; integration needs the long-lived dev branch`);
  }
  await assertDevRefNotCheckedOut({
    repositoryRoot: repository.repoRoot, devRef: candidates.devRef,
  });
  const policy = await inspectVerificationPolicy({
    repositoryRoot: repository.repoRoot,
    mainRef: candidates.mainRef,
  });
  if (policy.state === 'ABSENT') {
    throw new IntegrationServiceError('VERIFICATION_POLICY_ABSENT',
      `No verification policy at ${candidates.mainRef}:${verificationPolicyPath}; an integration`
      + ' needs an independent verification, so add one and re-run project trust');
  }
  const digest = policy.digest as string;
  if ((input.permissionMode ?? 'STRICT') === 'STRICT') {
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

  const batchId = randomUUID();
  const begun = input.storage.beginIntegrationBatch({
    projectId: input.projectId,
    taskId: input.taskId,
    executionId: subject.executionId,
    batchId,
    operationId: randomUUID(),
    worktreeOwnershipToken: randomUUID(),
    expectedVersion: input.expectedVersion,
    devRef: candidates.devRef,
    devCommit,
    commandId: input.commandId,
    payloadHash: sha256(JSON.stringify({
      projectId: input.projectId, taskId: input.taskId, executionId: subject.executionId,
      revisionId: subject.revisionId, candidateCommit: subject.candidateCommit,
      devRef: candidates.devRef, devCommit,
    })),
    createdEventId: randomUUID(),
    actor: 'runtime-integration',
    createdAt: now(),
  });
  if (!begun.created) {
    if (blocksNewIntegration(begun.plan.state)) {
      throw new IntegrationServiceError('INTEGRATION_IN_PROGRESS',
        `Integration batch ${begun.plan.batchId} is ${begun.plan.state};`
        + ' it was left in flight by an earlier attempt and needs reconciliation');
    }
    return replayReport(begun.plan);
  }

  // The merge itself. The batch records MERGING with the retained worktree path before Git runs.
  const strategy: MergeStrategy = await isAncestor({
    repositoryRoot: repository.repoRoot,
    ancestor: devCommit,
    descendant: subject.candidateCommit,
  }) ? 'FAST_FORWARD' : 'MERGE_COMMIT';
  let worktree;
  try {
    worktree = await createIntegrationWorktree({
      repositoryRoot: repository.repoRoot,
      worktreesRoot: input.worktreesRoot,
      projectId: input.projectId,
      batchId,
      commit: devCommit,
    });
  } catch (error) {
    const failed = failBatch({
      storage: input.storage, batchId, state: 'FAILED', outcomeCode: 'WORKTREE_FAILED',
      detail: boundedDetail(error instanceof Error ? error.message : String(error)),
      mergeStrategy: strategy, randomUUID, now,
    });
    return report(failed, { commands: [], tree: null, verificationState: null,
      alreadyCompleted: false, created: true });
  }
  input.storage.startIntegrationMerge({ batchId, worktreePath: worktree.path, startedAt: now() });
  let merged;
  try {
    merged = await mergeResultCommit({
      path: worktree.path,
      candidateCommit: subject.candidateCommit,
      baselineCommit: devCommit,
      strategy,
      message: `Codeestra integration for task #${candidates.taskDisplayNumber}`
        + ` (batch ${batchId}, revision ${subject.revisionId})`,
    });
  } catch (error) {
    // An unusable repository identity, a refusing hook, or any other unexpected Git failure is
    // recorded as a failed batch instead of leaving the ref and the record in flight.
    const failed = failBatch({
      storage: input.storage, batchId, state: 'FAILED', outcomeCode: 'MERGE_FAILED',
      detail: boundedDetail(error instanceof Error ? error.message : String(error)),
      mergeStrategy: strategy, randomUUID, now,
    });
    return report(failed, { commands: [], tree: null, verificationState: null,
      alreadyCompleted: false, created: true });
  }
  if (merged.commit === null) {
    const failed = failBatch({
      storage: input.storage, batchId,
      state: merged.outcome === 'CONFLICT' ? 'CONFLICTED' : 'FAILED',
      outcomeCode: merged.outcome === 'CONFLICT' ? 'MERGE_CONFLICT' : 'MERGE_FAILED',
      detail: boundedDetail(merged.detail), mergeStrategy: strategy, randomUUID, now,
    });
    return report(failed, { commands: [], tree: null, verificationState: null,
      alreadyCompleted: false, created: true });
  }
  input.storage.recordIntegrationMerge({
    batchId,
    mergeStrategy: merged.outcome === 'FAST_FORWARD' ? 'FAST_FORWARD' : 'MERGE_COMMIT',
    mergedCommit: merged.commit,
    mergedAt: now(),
  });

  // Independent integration verification of the merged commit, before the dev ref moves.
  let testedTree;
  try {
    testedTree = await readCommitTree({
      repositoryRoot: repository.repoRoot,
      commit: merged.commit,
    });
  } catch (error) {
    const failed = failBatch({
      storage: input.storage, batchId, state: 'FAILED', outcomeCode: 'INSPECTION_FAILED',
      detail: boundedDetail(error instanceof Error ? error.message : String(error)),
      mergeStrategy: merged.outcome === 'FAST_FORWARD' ? 'FAST_FORWARD' : 'MERGE_COMMIT',
      randomUUID, now,
    });
    return report(failed, { commands: [], tree: null, verificationState: null,
      alreadyCompleted: false, created: true });
  }
  const commands = policy.policy?.commands ?? [];
  const verificationId = randomUUID();
  const queued = input.storage.beginIntegrationVerification({
    batchId,
    verificationId,
    operationId: randomUUID(),
    commandId: randomUUID(),
    testedCommit: merged.commit,
    testedTree,
    policyVersion: verificationPolicyVersion,
    policyDigest: digest,
    mainCommit: policy.mainCommit,
    commands,
    copyPath: join(resolve(input.copiesRoot), input.projectId, verificationId),
    queuedAt: now(),
  });
  if (!queued.created) {
    throw new IntegrationServiceError('INTEGRATION_IN_PROGRESS',
      `Integration verification ${queued.plan.verificationId} already exists for this batch`);
  }
  input.storage.startIntegrationVerification({ verificationId, startedAt: now() });
  const execution = await executeVerificationPolicy({
    repositoryRoot: repository.repoRoot,
    copiesRoot: input.copiesRoot,
    projectId: input.projectId,
    runId: verificationId,
    testedCommit: merged.commit,
    commands,
    runner: input.runner,
  });
  const verification = input.storage.completeIntegrationVerification({
    verificationId,
    state: execution.terminalState,
    outcomeCode: execution.outcomeCode,
    eventId: randomUUID(),
    evidence: {
      testedCommit: merged.commit,
      testedTree,
      devRef: candidates.devRef,
      devCommit,
      policyVersion: verificationPolicyVersion,
      policyDigest: digest,
      mainCommit: policy.mainCommit,
      taskVerificationId: taskVerification.verificationId,
      taskVerificationTestedCommit: taskVerification.testedCommit,
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
      storage: input.storage, batchId, state: 'FAILED',
      outcomeCode: execution.copyCreated ? 'INTEGRATION_VERIFICATION_FAILED' : 'WORKTREE_FAILED',
      detail: boundedDetail(execution.failureDetail
        ?? `integration verification ended ${verification.state} (${verification.outcomeCode})`),
      mergeStrategy: strategy, randomUUID, now,
    });
    return report(failed, { commands: execution.outcomes, tree: execution.tree,
      verificationState: verification.state, alreadyCompleted: false, created: true });
  }

  // The ref moves last, and only if it still points at the baseline the merge started from. The
  // batch records INTEGRATING_DEV first, so an interrupted write is resolvable by comparing the
  // recorded merge with the ref instead of guessing.
  await assertDevRefNotCheckedOut({
    repositoryRoot: repository.repoRoot, devRef: candidates.devRef,
  });
  input.storage.startIntegrationDevUpdate({ batchId, updatedAt: now() });
  const advanced = await advanceLocalRef({
    repositoryRoot: repository.repoRoot,
    ref: candidates.devRef,
    expectedCommit: devCommit,
    newCommit: merged.commit,
  });
  if (!advanced.advanced) {
    const failed = failBatch({
      storage: input.storage, batchId, state: 'FAILED', outcomeCode: 'DEV_REF_MOVED',
      detail: boundedDetail(
        `${candidates.devRef} was not advanced from the recorded baseline: ${advanced.detail}`),
      mergeStrategy: strategy, randomUUID, now,
    });
    return report(failed, { commands: execution.outcomes, tree: execution.tree,
      verificationState: verification.state, alreadyCompleted: false, created: true });
  }

  const removal = await removeIntegrationWorktree({
    repositoryRoot: repository.repoRoot,
    path: worktree.path,
  }).catch((error: unknown) => ({
    removed: false,
    detail: error instanceof Error ? error.message : String(error),
  }));
  const completed = input.storage.completeIntegrationBatch({
    batchId,
    integratedCommit: merged.commit,
    worktreeDetail: removal.removed
      ? `integration worktree removed after a ${merged.outcome} integration`
      : `integration worktree retained at ${worktree.path}: ${removal.detail}`,
    completedEventId: randomUUID(),
    taskEventId: randomUUID(),
    completedAt: now(),
  });
  return report(completed, {
    commands: execution.outcomes, tree: execution.tree,
    verificationState: verification.state, alreadyCompleted: false, created: true,
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
