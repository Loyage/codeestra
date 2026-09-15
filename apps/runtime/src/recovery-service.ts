import { inspectResultCommit, readHeadCommit, reconcileWorkspace } from '@codeestra/git';
import {
  inspectProviderProcessOwnership,
  type ProviderOwnershipObservation,
  type ProviderProcessTree,
} from '@codeestra/agent-adapters';
import {
  Phase1Database,
  type StaleSessionObservation,
} from '@codeestra/storage';
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
      // being repeated or reported as failed. Completion is all-or-nothing (one transaction) and is
      // guarded per member by the exact revision the batch fixed, so a member that moved on while
      // the ref was written cannot be reported as integrated: that batch is left for a human with
      // both facts stated instead of failing the whole startup reconcile.
      try {
        input.storage.completeIntegrationBatch({
          batchId: batch.batchId,
          integratedCommit: batch.mergedCommit,
          worktreeDetail: `reconciled after a restart: ${batch.devRef} already pointed at the`
            + ' recorded merge commit'
            + (batch.worktreePath === null ? '' : `; integration worktree at ${batch.worktreePath}`),
          completedEventId: randomUUID(),
          // A reconciled completion writes one Task event per member, exactly like a live integration.
          taskEventIds: batch.items.map(() => randomUUID()),
          completedAt: now(),
        });
        results.push({ batchId: batch.batchId, outcome: 'RECOVERED_INTEGRATED',
          worktreePath: batch.worktreePath, mergedCommit: batch.mergedCommit });
        continue;
      } catch (error) {
        input.storage.markIntegrationRecoveryRequired({
          batchId: batch.batchId,
          outcomeCode: 'RECONCILE_REQUIRED',
          reason: `${batch.devRef} already points at the recorded merge ${batch.mergedCommit}, but`
            + ' the integration could not be completed from that fact because a member no longer'
            + ` matches the revision this batch fixed: ${error instanceof Error
              ? error.message : String(error)}. Nothing was written twice; resolve the batch`
            + ' explicitly.',
          eventId: randomUUID(),
          at: now(),
        });
        results.push({ batchId: batch.batchId, outcome: 'RECOVERY_REQUIRED',
          worktreePath: batch.worktreePath, mergedCommit: batch.mergedCommit });
        continue;
      }
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
  readonly outcome: 'RESTART_UNPROVEN' | 'AWAITING_PULL';
  readonly observedMainCommit: string | null;
  readonly candidateCommit: string;
}

/**
 * Reconciles a stable promotion a restart found in flight (ADR-0047 D01/D03).
 *
 * The decision comes from the main checkout's own ref alone, because nothing this capability does
 * moves it: the pull is the user's explicit step. A restart between the push and the pull is normal
 * rather than a failure, so the states are treated differently:
 *
 * - `PROMOTING` with `main` still at the recorded expected commit: the push is recorded and
 *   verified and nothing else happened. The record stays open and resumable — it is reported as
 *   `AWAITING_PULL`, not failed, because the promotion has neither completed nor lost anything.
 * - `PROMOTING` with `main` already at the fixed candidate: the pull happened and only the restart
 *   was never recorded. It becomes `RECOVERY_REQUIRED/RESTART_UNPROVEN` — `main` is **not** written
 *   again, and the restart sequence (install/build/stop/status) still has to be run and recorded
 *   before the promotion can be called successful.
 * - `RESTARTING`: the same, since the restart result was never recorded.
 * - anything else: the ref moved outside this promotion. It becomes
 *   `RECOVERY_REQUIRED/MAIN_REF_OBSERVED`, which a human resolves with `promotion.abandon` after
 *   reading what was observed; the record states the value it saw instead of guessing.
 *
 * `RECOVERY_REQUIRED` keeps the project's promotion slot occupied, so a new promotion cannot race
 * an unresolved one; the same record is resumed by re-running `promotion promote`, which re-issues
 * the recorded restart plan without touching a local ref.
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
      // Nothing was lost and nothing has to be rewritten: the dev push is recorded and verified,
      // the main checkout is still on its old commit, and the pull is the user's own step. Failing
      // the record here would turn an ordinary Runtime restart into a failed promotion.
      results.push({ promotionId: plan.promotionId, outcome: 'AWAITING_PULL',
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
export interface SessionHandoffRecoveryResult {
  readonly sessionId: string;
  readonly incarnationId: string;
  readonly outcome: 'RECONCILED_FROM_FACTS';
  readonly detail: string;
}

/**
 * Reconciles the Runtime's own Session handoff state after a restart (ADR-0023).
 *
 * A restarted Runtime holds no provider process and no PTY control connection, so nothing it
 * recorded can still be claimed as the writer. The decision is made from that fact alone:
 *
 * - every live incarnation becomes `RECOVERY_REQUIRED` and stops being the Session's current
 *   incarnation, so no late permission decision can reach a process this Runtime no longer owns;
 * - every un-released writer lease is released with the reason `RUNTIME_RESTARTED`;
 * - every open handoff request becomes `RECOVERY_REQUIRED` with its fence marked inactive;
 * - every open STRICT permission request and its Attention become `STALE`, because the provider
 *   that asked is gone and the request can never be answered.
 *
 * It deliberately does not touch `agent_sessions`/`executions`/`tasks`: projecting a provider state
 * the Runtime cannot observe is a different (still open) reconciliation question, and guessing it
 * here would hide the missing evidence.
 */
export function reconcileSessionHandoffs(input: {
  readonly storage: Phase1Database;
  readonly now?: () => number;
}): readonly SessionHandoffRecoveryResult[] {
  const now = input.now ?? Date.now;
  const results: SessionHandoffRecoveryResult[] = [];
  for (const incarnation of input.storage.listLiveSessionIncarnations()) {
    input.storage.markSessionIncarnationRecoveryRequired({
      incarnationId: incarnation.id,
      at: now(),
      detail: {
        code: 'RUNTIME_RESTARTED',
        message: 'the Runtime restarted; it cannot prove it still holds this provider process',
      },
    });
    results.push({
      sessionId: incarnation.sessionId,
      incarnationId: incarnation.id,
      outcome: 'RECONCILED_FROM_FACTS',
      detail: `incarnation ${incarnation.incarnationNumber} is no longer current`,
    });
  }
  for (const lease of input.storage.listActiveSessionWriterLeases()) {
    input.storage.releaseSessionWriterLeaseForSession({
      sessionId: lease.sessionId,
      reason: 'RUNTIME_RESTARTED',
      releasedAt: now(),
    });
  }
  for (const request of input.storage.listOpenSessionHandoffRequests()) {
    input.storage.markSessionHandoffRecoveryRequired({
      requestId: request.id,
      at: now(),
      detail: 'RUNTIME_RESTARTED: the Runtime restarted while this handoff was in flight',
    });
  }
  for (const permission of input.storage.listOpenSessionPermissionRequests()) {
    input.storage.markSessionPermissionRequestStale({
      attentionId: permission.attentionId,
      at: now(),
      detail: 'RUNTIME_RESTARTED: the provider that asked is gone',
    });
  }
  return results;
}

/**
 * Terminals this Runtime no longer holds, reconciled from that fact (ADR-0026).
 *
 * After a restart the Runtime holds no PTY host and no provider process, so every terminal row that
 * still says RUNNING is converged to RECOVERY_REQUIRED. The recorded helper/provider PIDs are
 * reported rather than killed: the Runtime cannot prove they are still the processes it recorded
 * (a PID is reusable), and destroying a possibly-live provider would be an unrecoverable action
 * taken on a guess. The PTY host's own rule — a closed control pipe means "no writer is left to
 * control this terminal" — is what terminates the provider in practice; this function never claims
 * that it did.
 */
export function reconcileSessionTerminals(input: {
  readonly storage: Phase1Database;
  readonly now?: () => number;
}): {
  readonly reconciled: readonly string[];
  /** Terminals whose recorded processes were never signalled by this Runtime generation. */
  readonly maybeStillRunning: readonly { readonly terminalId: string;
    readonly helperPid: number | null; readonly providerPid: number | null }[];
} {
  const now = input.now ?? Date.now;
  const reconciled: string[] = [];
  const maybeStillRunning: { terminalId: string; helperPid: number | null;
    providerPid: number | null }[] = [];
  for (const terminal of input.storage.listLiveSessionTerminals()) {
    input.storage.markSessionTerminalEnded({
      terminalId: terminal.id,
      state: 'RECOVERY_REQUIRED',
      exitCode: null,
      exitSignal: null,
      at: now(),
      detail: 'RUNTIME_RESTARTED: this Runtime no longer holds this terminal; the recorded PTY host'
        + ' and provider processes were not signalled by this generation',
    });
    input.storage.releaseSessionTerminalAttachments({
      terminalId: terminal.id,
      cursor: 0,
      reason: 'RUNTIME_RESTARTED',
      at: now(),
    });
    reconciled.push(terminal.id);
    maybeStillRunning.push({ terminalId: terminal.id, helperPid: terminal.helperPid,
      providerPid: terminal.providerPid });
  }
  return { reconciled, maybeStillRunning };
}

export interface StaleAgentSessionReconcileResult {
  readonly sessionId: string;
  readonly executionId: string;
  readonly taskId: string;
  readonly outcome: 'CONVERGED' | 'SKIPPED_HELD_BY_RUNTIME' | 'ALREADY_CONVERGED' | 'FAILED';
  readonly observation: StaleSessionObservation | null;
  readonly previousSessionState: string;
  readonly previousExecutionState: string;
  readonly projectedSessionState: string | null;
  readonly projectedExecutionState: string | null;
  readonly detail: string;
}

/**
 * Converges `agent_sessions`/`executions` projections that still claim a running provider after a
 * Runtime restart (ADR-0028). This closes the one startup gap the other reconciles deliberately left
 * open: `reconcileSessionHandoffs` cleans the Runtime's own handoff state and explicitly refuses to
 * project a provider state it cannot observe, while this function does exactly that projection — from
 * the *process ownership evidence* that was captured while the provider was alive.
 *
 * What it will and will not do:
 *
 * - It never sets a running state. Every converged projection is `DISCONNECTED`/`RECOVERY_REQUIRED`,
 *   because this Runtime generation holds no provider process, no PTY, and no way to reattach (Pi has
 *   no reconnect primitive).
 * - It never claims quiescence, and therefore never resumes or completes an Execution. Even a
 *   provably `STOPPED` provider is only evidence about the recorded process tree, which is a snapshot:
 *   a process spawned after the capture, or one reparented out of it, is not covered. The observed
 *   fact is recorded verbatim and the Execution stays `RECOVERY_REQUIRED`.
 * - It never signals or kills a process. A provider that is still running, or a recorded descendant
 *   that is still alive, is *reported* (FOUNDATION-040 measured that killing a provider does not stop
 *   its tool children, and a PID without the recorded start token is not proof of identity).
 * - It never deletes anything. Worktrees, verification copies, and integration worktrees keep their
 *   ownership and are only ever removed by the explicit ADR-0021 that reclaims them.
 * - `isHeldByThisRuntime` is the honest boundary: a Session this generation is actively observing is
 *   never touched, so the same function is safe to call again after startup.
 */
export async function reconcileStaleAgentSessions(input: {
  readonly storage: Phase1Database;
  /** Sessions this Runtime generation currently holds a live provider process for. */
  readonly isHeldByThisRuntime?: (sessionId: string) => boolean;
  /** Injection point for tests; the default is the real `ps`-based ownership check. */
  readonly inspectOwnership?: (tree: ProviderProcessTree) => Promise<ProviderOwnershipObservation>;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly logger?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}): Promise<readonly StaleAgentSessionReconcileResult[]> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const inspectOwnership = input.inspectOwnership
    ?? ((tree: ProviderProcessTree) => inspectProviderProcessOwnership({ tree }));
  const logger = input.logger ?? (() => {});
  const results: StaleAgentSessionReconcileResult[] = [];
  for (const stale of input.storage.listStaleAgentSessions()) {
    const base = {
      sessionId: stale.sessionId,
      executionId: stale.executionId,
      taskId: stale.taskId,
      previousSessionState: stale.sessionState,
      previousExecutionState: stale.executionState,
    };
    if (input.isHeldByThisRuntime?.(stale.sessionId) === true) {
      results.push({ ...base, outcome: 'SKIPPED_HELD_BY_RUNTIME', observation: null,
        projectedSessionState: null, projectedExecutionState: null,
        detail: 'this Runtime generation still holds this Session, so nothing is converged' });
      continue;
    }
    const tree = providerTreeOf(stale.incarnation);
    let observation: StaleSessionObservation;
    let detail: string;
    let providerPid: number | null = stale.incarnation?.providerPid ?? null;
    let ownership: Readonly<Record<string, unknown>> = {};
    if (tree === null) {
      observation = 'PROCESS_IDENTITY_MISSING';
      detail = stale.incarnation === null
        ? 'no Session incarnation and no recorded process identity exist for this Session, so no'
          + ' ownership check is possible; the recorded projection cannot be trusted either way'
        : 'the Session incarnation recorded no provider process identity, so ownership cannot be'
          + ' checked and quiescence is not proven';
    } else {
      providerPid = tree.pid;
      try {
        const observed = await inspectOwnership(tree);
        ownership = observed as unknown as Readonly<Record<string, unknown>>;
        if (observed.state === 'STOPPED') {
          observation = 'PROVIDER_STOPPED';
          detail = `no process with the recorded provider identity (pid ${tree.pid}) and none of its`
            + ` ${tree.descendants.length} recorded descendant(s) are running, but the process tree is`
            + ' a snapshot taken while the provider was alive, so workspace quiescence is still not'
            + ' proven and the Execution is not resumed';
        } else if (observed.state === 'ALIVE') {
          observation = 'PROVIDER_STILL_RUNNING';
          detail = `provider process ${observed.pid} is still running with the recorded start token;`
            + ' this Runtime does not own a handle to it and cannot reattach, and it was not signalled';
        } else if (observed.state === 'DESCENDANTS_ALIVE') {
          observation = 'PROVIDER_DESCENDANTS_ALIVE';
          detail = `the provider is gone but recorded tool descendant(s) ${observed.descendants.join(', ')}`
            + ' are still running; they may still be writing the workspace and were not signalled';
        } else {
          observation = 'PROVIDER_OWNERSHIP_UNVERIFIABLE';
          detail = `provider ownership could not be verified: ${observed.detail}`;
        }
      } catch (error) {
        observation = 'PROVIDER_OWNERSHIP_UNVERIFIABLE';
        detail = `the ownership check failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const evidence = {
      source: 'STARTUP_RECONCILE',
      observation,
      record: {
        sessionState: stale.sessionState,
        executionState: stale.executionState,
        taskState: stale.taskState,
        workspaceId: stale.workspaceId,
        adapterId: stale.adapterId,
        incarnation: stale.incarnation === null ? null : {
          id: stale.incarnation.id,
          incarnationNumber: stale.incarnation.incarnationNumber,
          state: stale.incarnation.state,
          providerPid: stale.incarnation.providerPid,
          processTreeCapturedAt: (tree?.capturedAt ?? null),
          processTreeNote: tree?.note ?? null,
        },
        writerLease: stale.writerLease,
      },
      ownership,
      quiescenceProven: false,
      signalsSent: 0,
    };
    try {
      const converged = input.storage.convergeStaleAgentSession({
        sessionId: stale.sessionId,
        observation,
        providerPid,
        detail,
        evidence,
        reconciliationId: randomUUID(),
        commandId: randomUUID(),
        sessionEventId: randomUUID(),
        executionEventId: randomUUID(),
        taskEventId: randomUUID(),
        recoveryEventId: randomUUID(),
        recordedAt: now(),
      });
      results.push({
        ...base,
        outcome: converged.converted ? 'CONVERGED' : 'ALREADY_CONVERGED',
        observation,
        projectedSessionState: converged.projectedSessionState,
        projectedExecutionState: converged.projectedExecutionState,
        detail,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger('a stale Agent Session projection could not be converged', {
        sessionId: stale.sessionId,
        reason,
      });
      results.push({ ...base, outcome: 'FAILED', observation,
        projectedSessionState: null, projectedExecutionState: null,
        detail: `startup convergence failed: ${reason}` });
    }
  }
  return results;
}

/**
 * The recorded process tree of one incarnation, or null when none was captured. A piece of identity
 * that cannot be compared (for example a missing start token) is passed through unchanged so the
 * ownership check reports `UNVERIFIABLE` instead of assuming the process is gone.
 */
function providerTreeOf(incarnation: {
  readonly providerPid: number | null;
  readonly processIdentity: unknown;
  readonly processTree: unknown;
} | null): ProviderProcessTree | null {
  if (incarnation === null) return null;
  const tree = incarnation.processTree;
  if (tree !== null && typeof tree === 'object') {
    const candidate = tree as Partial<ProviderProcessTree>;
    if (typeof candidate.pid === 'number' && typeof candidate.startToken === 'string'
      && Array.isArray(candidate.descendants)) {
      return candidate as ProviderProcessTree;
    }
  }
  const identity = incarnation.processIdentity;
  if (identity !== null && typeof identity === 'object') {
    const candidate = identity as { pid?: unknown; startToken?: unknown };
    if (typeof candidate.pid === 'number' && typeof candidate.startToken === 'string') {
      // No descendant walk was recorded while the provider was alive; the check can still say
      // whether the provider itself is gone, and reports anything it cannot attribute.
      return {
        pid: candidate.pid,
        startToken: candidate.startToken,
        pgid: null,
        descendants: [],
        capturedAt: 0,
        note: 'reconstructed from the recorded process identity: no descendant walk was captured',
      };
    }
  }
  return null;
}
