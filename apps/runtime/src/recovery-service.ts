import { reconcileWorkspace } from '@codeestra/git';
import { Phase1Database } from '@codeestra/storage';

export interface RecoveryResult {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly outcome: 'SAFE_TO_RESUME' | 'RECOVERED_SUCCEEDED' | 'RECOVERED_FAILED' | 'RECOVERY_REQUIRED';
  readonly evidenceRef?: string;
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
