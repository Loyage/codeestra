import { inspectResultCommit, readHeadCommit, reconcileWorkspace } from '@codeestra/git';
import { Phase1Database } from '@codeestra/storage';
import {
  reconcileRunOperations,
  type RunOperationRecoveryResult,
} from './operation-service.js';
import { resultCommitMessage } from './result-commit-service.js';

export interface AgentStartRecoveryResult {
  readonly operationId: string;
  readonly sessionId: string;
  readonly outcome: 'SAFE_TO_RESUME' | 'RECOVERY_REQUIRED';
}

export interface AgentAnswerRecoveryResult {
  readonly operationId: string;
  readonly attentionId: string;
  readonly outcome: 'SAFE_TO_DELIVER' | 'RECOVERY_REQUIRED';
}

export interface RecoveryResult {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly outcome: 'SAFE_TO_RESUME' | 'RECOVERED_SUCCEEDED' | 'RECOVERED_FAILED' | 'RECOVERY_REQUIRED';
  readonly evidenceRef?: string;
}

/** A lost start transport cannot be replayed or claimed active without Adapter identity evidence. */
export function reconcileInterruptedAgentStarts(input: {
  readonly storage: Phase1Database;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): readonly AgentStartRecoveryResult[] {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  return input.storage.listIncompleteAgentStarts().map((plan) => {
    if (plan.operationState === 'PLANNED') {
      return { operationId: plan.operationId, sessionId: plan.sessionId, outcome: 'SAFE_TO_RESUME' as const };
    }
    if (plan.operationState === 'IN_PROGRESS') {
      input.storage.markAgentStartUncertain({
        operationId: plan.operationId,
        sessionId: plan.sessionId,
        recoveryEventId: randomUUID(),
        taskEventId: randomUUID(),
        error: { code: 'RUNTIME_RESTARTED', message: 'Runtime restarted during Agent start' },
        failedAt: now(),
      });
    }
    return { operationId: plan.operationId, sessionId: plan.sessionId, outcome: 'RECOVERY_REQUIRED' as const };
  });
}

/** A PLANNED answer is safe to deliver; an interrupted delivery is never blindly replayed. */
export function reconcileInterruptedAgentAnswers(input: {
  readonly storage: Phase1Database;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): readonly AgentAnswerRecoveryResult[] {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  return input.storage.listIncompleteAgentAnswers().map((plan) => {
    if (plan.operationState === 'PLANNED') {
      return { operationId: plan.operationId, attentionId: plan.id, outcome: 'SAFE_TO_DELIVER' as const };
    }
    if (plan.operationState === 'IN_PROGRESS') {
      input.storage.markAgentAnswerUncertain({
        operationId: plan.operationId,
        recoveryEventId: randomUUID(),
        taskEventId: randomUUID(),
        error: { code: 'RUNTIME_RESTARTED', message: 'Runtime restarted during Agent answer delivery' },
        failedAt: now(),
      });
    }
    return { operationId: plan.operationId, attentionId: plan.id, outcome: 'RECOVERY_REQUIRED' as const };
  });
}

export interface VerificationRecoveryResult {
  readonly verificationId: string;
  readonly outcome: 'RECOVERED_FAILED';
  readonly copyPath: string;
}

/**
 * A Runtime restart cannot prove whether verification commands finished, so an unfinished
 * run is recorded as ERROR and its copy is kept: an orphaned process group may still own it,
 * and deleting the scene of the crash would hide that fact.
 */
export function reconcileInterruptedVerifications(input: {
  readonly storage: Phase1Database;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): readonly VerificationRecoveryResult[] {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  return input.storage.listIncompleteVerificationRuns().map((run) => {
    input.storage.completeVerificationRun({
      verificationId: run.verificationId,
      state: 'ERROR',
      outcomeCode: 'RUNTIME_RESTARTED',
      evidence: {
        testedCommit: run.testedCommit,
        testedTree: run.testedTree,
        policyVersion: run.policyVersion,
        policyDigest: run.policyDigest,
        mainCommit: run.mainCommit,
        previousState: run.state,
        copyPath: run.copyPath,
      },
      eventId: randomUUID(),
      completedAt: now(),
    });
    return {
      verificationId: run.verificationId,
      outcome: 'RECOVERED_FAILED' as const,
      copyPath: run.copyPath,
    };
  });
}

export interface IntegrationRecoveryResult {
  readonly batchId: string;
  readonly outcome: 'RECOVERED_INTEGRATED' | 'RECOVERY_REQUIRED';
  readonly worktreePath: string | null;
  readonly mergedCommit: string | null;
}

/**
 * A Runtime restart cannot prove whether an integration finished its merge, its verification, or
 * its ref update.
 *
 * - A batch interrupted before the ref write is recorded as `RECOVERY_REQUIRED` with that fact
 *   stated explicitly; nothing is replayed.
 * - A batch interrupted *during* the ref write is resolved by reading the `dev` ref: when it
 *   already points at the recorded merge commit, the integration is completed from that fact
 *   (the ref is never updated twice); otherwise nothing was integrated and the batch needs a
 *   human.
 *
 * Interrupted integration verifications are recorded as `ERROR(RUNTIME_RESTARTED)` with the copy
 * path kept, like Task verification.
 */
export async function reconcileInterruptedIntegrations(input: {
  readonly storage: Phase1Database;
  readonly readRefCommit: (batch: { readonly devRef: string; readonly repositoryRoot: string }) => Promise<string | null>;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<readonly IntegrationRecoveryResult[]> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  for (const run of input.storage.listIncompleteIntegrationVerifications()) {
    input.storage.completeIntegrationVerification({
      verificationId: run.verificationId,
      state: 'ERROR',
      outcomeCode: 'RUNTIME_RESTARTED',
      evidence: {
        testedCommit: run.testedCommit,
        testedTree: run.testedTree,
        devCommit: run.devCommit,
        policyVersion: run.policyVersion,
        policyDigest: run.policyDigest,
        mainCommit: run.mainCommit,
        previousState: run.state,
        copyPath: run.copyPath,
      },
      eventId: randomUUID(),
      completedAt: now(),
    });
  }
  const results: IntegrationRecoveryResult[] = [];
  for (const batch of input.storage.listIncompleteIntegrationBatches()) {
    const observed = await input.readRefCommit({
      devRef: batch.devRef, repositoryRoot: batch.repositoryRoot,
    }).catch(() => null);
    if (batch.state === 'INTEGRATING_DEV' && batch.mergedCommit !== null
      && observed === batch.mergedCommit) {
      // The ref write did happen; the integration is completed from the observed ref instead of
      // being repeated or reported as failed.
      input.storage.completeIntegrationBatch({
        batchId: batch.batchId,
        integratedCommit: batch.mergedCommit,
        worktreeDetail: `reconciled after a restart: ${batch.devRef} already pointed at the`
          + ' recorded merge commit'
          + (batch.worktreePath === null ? '' : `; integration worktree at ${batch.worktreePath}`),
        completedEventId: randomUUID(),
        taskEventId: randomUUID(),
        completedAt: now(),
      });
      results.push({ batchId: batch.batchId, outcome: 'RECOVERED_INTEGRATED',
        worktreePath: batch.worktreePath, mergedCommit: batch.mergedCommit });
      continue;
    }
    const reason = batch.state === 'INTEGRATING_DEV'
      ? `Runtime restarted during the dev ref update: ${batch.devRef} is at`
        + ` ${observed ?? 'an unreadable value'} while the recorded merge is`
        + ` ${batch.mergedCommit ?? 'missing'}; nothing was integrated by this batch`
      : `Runtime restarted while the integration was ${batch.state};`
        + ' the dev ref was not advanced'
        + (batch.worktreePath === null ? '' : `; integration worktree retained at ${batch.worktreePath}`);
    input.storage.markIntegrationRecoveryRequired({
      batchId: batch.batchId,
      outcomeCode: batch.state === 'INTEGRATING_DEV' ? 'DEV_REF_OBSERVED' : 'RECONCILE_REQUIRED',
      reason,
      eventId: randomUUID(),
      at: now(),
    });
    results.push({ batchId: batch.batchId, outcome: 'RECOVERY_REQUIRED',
      worktreePath: batch.worktreePath, mergedCommit: batch.mergedCommit });
  }
  return results;
}

/**
 * Reconciles long-command Operations a restart interrupted (ADR-0019). The decision is made from
 * recorded facts, never from "the Runtime is up again":
 *
 * - a run whose Execution is still active becomes `RECONCILE_REQUIRED` — the provider process may
 *   or may not exist, so nothing is claimed and ownership is untouched;
 * - a run with a terminal Execution is closed from that state;
 * - a run that never recorded an Execution is closed as failed without replaying any Git side
 *   effect (the workspace reconcile owns those).
 *
 * Verification runs are covered by `reconcileInterruptedVerifications`, which already completes
 * their Operation as `ERROR(RUNTIME_RESTARTED)` while keeping the copy.
 */
export function reconcileInterruptedRunOperations(input: {
  readonly storage: Phase1Database;
  readonly now?: () => number;
}): readonly RunOperationRecoveryResult[] {
  const now = input.now ?? Date.now;
  return reconcileRunOperations({ storage: input.storage, recordedAt: now() });
}

export interface ResultCommitRecoveryResult {
  readonly operationId: string;
  readonly authorizationId: string;
  readonly executionId: string;
  readonly outcome: 'SAFE_TO_RESUME' | 'RECOVERED_SUCCEEDED' | 'FAILED_NO_COMMIT' | 'RECOVERY_REQUIRED';
  readonly resultCommit?: string;
}

/** Reconcile persisted workspace operations without replaying `git worktree add`. */
export async function reconcileWorkspacePreparations(input: {
  readonly storage: Phase1Database;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<readonly RecoveryResult[]> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const results: RecoveryResult[] = [];
  for (const plan of input.storage.listIncompleteWorkspacePreparations()) {
    if (plan.operationState === 'PLANNED') {
      results.push({
        operationId: plan.operationId,
        workspaceId: plan.workspaceId,
        outcome: 'SAFE_TO_RESUME',
      });
      continue;
    }
    const observation = await reconcileWorkspace({
      repositoryRoot: plan.repoRoot,
      path: plan.path,
      branchRef: plan.branchRef,
    });
    if (observation.state === 'OWNED' && observation.headCommit === plan.baseCommit) {
      input.storage.completeWorkspacePreparation({
        operationId: plan.operationId,
        workspaceId: plan.workspaceId,
        eventId: randomUUID(),
        preparedPath: plan.path,
        preparedBranch: plan.branchRef,
        completedAt: now(),
      });
      results.push({
        operationId: plan.operationId,
        workspaceId: plan.workspaceId,
        outcome: 'RECOVERED_SUCCEEDED',
        evidenceRef: observation.evidenceRef,
      });
      continue;
    }
    if (observation.state === 'MISSING') {
      input.storage.recordMissingWorkspacePreparation({
        operationId: plan.operationId,
        workspaceId: plan.workspaceId,
        evidenceRef: observation.evidenceRef,
        reconciledAt: now(),
      });
      results.push({
        operationId: plan.operationId,
        workspaceId: plan.workspaceId,
        outcome: 'RECOVERED_FAILED',
        evidenceRef: observation.evidenceRef,
      });
      continue;
    }
    const evidenceRef = observation.state === 'OWNED'
      ? `workspace-head-changed:${observation.headCommit ?? 'unknown'}:${observation.evidenceRef}`
      : observation.evidenceRef;
    input.storage.markWorkspacePreparationUncertain({
      operationId: plan.operationId,
      workspaceId: plan.workspaceId,
      evidenceRef,
      reconciledAt: now(),
    });
    results.push({
      operationId: plan.operationId,
      workspaceId: plan.workspaceId,
      outcome: 'RECOVERY_REQUIRED',
      evidenceRef,
    });
  }
  return results;
}

/**
 * Reconciles a result commit that the Runtime was creating when it stopped. A commit that
 * exists on top of the authorized head with the deterministic message is adopted without
 * running hooks again; an unchanged head only fails a DB-recorded Operation; anything else
 * keeps the worktree untouched and asks for a manual decision.
 */
export async function reconcileInterruptedResultCommits(input: {
  readonly storage: Phase1Database;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<readonly ResultCommitRecoveryResult[]> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const results: ResultCommitRecoveryResult[] = [];
  for (const plan of input.storage.listIncompleteResultCommitCaptures()) {
    const base = {
      operationId: plan.operationId,
      authorizationId: plan.authorizationId,
      executionId: plan.executionId,
    };
    if (plan.operationState === 'PLANNED') {
      results.push({ ...base, outcome: 'SAFE_TO_RESUME' });
      continue;
    }
    const authorization = plan.authorization;
    const message = resultCommitMessage({
      taskDisplayNumber: authorization.taskDisplayNumber,
      revisionId: authorization.appliedRevisionId,
      executionId: authorization.executionId,
    });
    try {
      const inspected = await inspectResultCommit({
        workspacePath: authorization.workspacePath,
        expectedHead: authorization.expectedHead,
        expectedMessage: message,
      });
      if (inspected !== null) {
        input.storage.completeResultCommitCapture({
          operationId: plan.operationId,
          resultCommit: inspected.commit,
          resultTree: inspected.tree,
          identityName: inspected.authorName,
          identityEmail: inspected.authorEmail,
          hookOutcome: 'PASSED',
          hookDetail: 'reconciled an existing result commit after a Runtime restart',
          source: 'RECONCILED',
          eventId: randomUUID(),
          executionEventId: randomUUID(),
          taskEventId: randomUUID(),
          completedAt: now(),
        });
        results.push({ ...base, outcome: 'RECOVERED_SUCCEEDED', resultCommit: inspected.commit });
        continue;
      }
      const head = await readHeadCommit(authorization.workspacePath);
      if (head === authorization.expectedHead) {
        input.storage.failResultCommitCapture({
          operationId: plan.operationId,
          error: { code: 'RUNTIME_RESTARTED', message: 'Runtime restarted before the result commit was created' },
          reconcileRequired: false,
          failedAt: now(),
        });
        results.push({ ...base, outcome: 'FAILED_NO_COMMIT' });
        continue;
      }
      input.storage.failResultCommitCapture({
        operationId: plan.operationId,
        error: { code: 'UNEXPECTED_HEAD', message: `HEAD moved to ${head} without a matching result commit` },
        reconcileRequired: true,
        failedAt: now(),
      });
      input.storage.invalidateResultCommitAuthorization({
        authorizationId: authorization.id,
        reason: 'HEAD moved without a matching result commit',
        eventId: randomUUID(),
        invalidatedAt: now(),
      });
      results.push({ ...base, outcome: 'RECOVERY_REQUIRED' });
    } catch (error) {
      input.storage.failResultCommitCapture({
        operationId: plan.operationId,
        error: { code: 'RECONCILE_FAILED', message: error instanceof Error ? error.message : String(error) },
        reconcileRequired: true,
        failedAt: now(),
      });
      results.push({ ...base, outcome: 'RECOVERY_REQUIRED' });
    }
  }
  return results;
}

export interface PromotionRecoveryResult {
  readonly promotionId: string;
  readonly outcome: 'FAILED_MAIN_NOT_UPDATED' | 'RESTART_UNPROVEN';
  readonly observedMainCommit: string | null;
  readonly candidateCommit: string;
}

/**
 * Reconciles a stable promotion a restart found in flight. The decision comes from the `main` ref
 * alone, because that is the only side effect this capability performs:
 *
 * - `PROMOTING` with `main` still at the recorded expected commit: the promotion never happened.
 *   It is failed with `MAIN_NOT_UPDATED`, and nothing about `dev`/`main` changed.
 * - `PROMOTING` with `main` already at the fixed candidate: the fast-forward did happen and only
 *   the record is missing it. It becomes `RECOVERY_REQUIRED/RESTART_UNPROVEN` — the ref is **not**
 *   written a second time, and the restart sequence (install/build/stop/status) still has to be run
 *   and recorded before the promotion can be called successful.
 * - `RESTARTING`: the same, since the restart result was never recorded.
 * - `PROMOTING` with any other `main`: the ref moved outside this promotion. It becomes
 *   `RECOVERY_REQUIRED/MAIN_REF_OBSERVED`, which a human resolves with `promotion.abandon`; the
 *   record states the value it observed instead of guessing.
 *
 * `RECOVERY_REQUIRED` keeps the project's promotion slot occupied, so a new promotion cannot race
 * an unresolved one; the same record is resumed by re-running `promotion promote`, which re-issues
 * the recorded restart plan without touching a ref.
 */
export async function reconcileInterruptedPromotions(input: {
  readonly storage: Phase1Database;
  readonly readRefCommit: (target: {
    readonly ref: string;
    readonly repositoryRoot: string;
  }) => Promise<string | null>;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<readonly PromotionRecoveryResult[]> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const results: PromotionRecoveryResult[] = [];
  for (const plan of input.storage.listIncompleteStablePromotions()) {
    const observed = await input.readRefCommit({
      ref: plan.mainRef, repositoryRoot: plan.repositoryRoot,
    }).catch(() => null);
    if (observed === plan.candidateCommit) {
      input.storage.markStablePromotionRecoveryRequired({
        promotionId: plan.promotionId,
        outcomeCode: 'RESTART_UNPROVEN',
        promotedCommit: observed,
        reason: `Runtime restarted while the promotion was ${plan.state}: ${plan.mainRef} is already`
          + ` the promoted commit ${plan.candidateCommit}, so no ref will be written again, but the`
          + ' restart sequence was never recorded. Re-run promotion promote to run the recorded'
          + ' post-steps, or promotion abandon if you restarted the stable service yourself',
        eventId: randomUUID(),
        at: now(),
      });
      results.push({ promotionId: plan.promotionId, outcome: 'RESTART_UNPROVEN',
        observedMainCommit: observed, candidateCommit: plan.candidateCommit });
      continue;
    }
    if (plan.state === 'PROMOTING' && observed === plan.expectedMainCommit) {
      input.storage.failStablePromotion({
        promotionId: plan.promotionId,
        outcomeCode: 'MAIN_NOT_UPDATED',
        detail: `Runtime restarted while the promotion was PROMOTING and ${plan.mainRef} is still at`
          + ` the expected commit ${plan.expectedMainCommit}; main was not updated by this promotion`,
        eventId: randomUUID(),
        failedAt: now(),
      });
      results.push({ promotionId: plan.promotionId, outcome: 'FAILED_MAIN_NOT_UPDATED',
        observedMainCommit: observed, candidateCommit: plan.candidateCommit });
      continue;
    }
    input.storage.markStablePromotionRecoveryRequired({
      promotionId: plan.promotionId,
      outcomeCode: 'MAIN_REF_OBSERVED',
      promotedCommit: null,
      reason: `Runtime restarted while the promotion was ${plan.state}: ${plan.mainRef} is at`
        + ` ${observed ?? 'an unreadable value'} instead of the promoted commit`
        + ` ${plan.candidateCommit}; nothing was promoted by Codeestra. Resolve it explicitly`
        + ' (promotion promote if the ref is yours to keep, otherwise promotion abandon)',
      eventId: randomUUID(),
      at: now(),
    });
    results.push({ promotionId: plan.promotionId, outcome: 'RESTART_UNPROVEN',
      observedMainCommit: observed, candidateCommit: plan.candidateCommit });
  }
  return results;
}
