import { reconcileWorkspace } from '@codeestra/git';
import { Phase1Database } from '@codeestra/storage';

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
