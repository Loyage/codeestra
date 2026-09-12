import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  GitInspectionError,
  inspectConfiguredMain,
  prepareWorkspace,
} from '@codeestra/git';
import {
  Phase1Database,
  StorageError,
  type WorkspacePreparationPlan,
} from '@codeestra/storage';

export class WorkspaceServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WorkspaceServiceError';
  }
}

function workspacePayloadHash(input: {
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedTaskVersion: number;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export async function prepareTaskWorkspace(input: {
  readonly storage: Phase1Database;
  readonly runtimeHome: string;
  readonly commandId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedTaskVersion: number;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<WorkspacePreparationPlan> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const payloadHash = workspacePayloadHash({
    projectId: input.projectId,
    taskId: input.taskId,
    expectedTaskVersion: input.expectedTaskVersion,
  });
  const recorded = input.storage.findWorkspacePreparation(
    input.projectId,
    input.commandId,
    payloadHash,
  );
  if (recorded?.operationState === 'SUCCEEDED' || recorded?.operationState === 'FAILED') return recorded;
  if (recorded !== null && recorded.operationState !== 'PLANNED') {
    throw new WorkspaceServiceError(
      'RECONCILE_REQUIRED',
      `Workspace operation is ${recorded.operationState}; refusing to replay its Git side effect`,
    );
  }

  const project = input.storage.getTrustedProject(input.projectId);
  let repository;
  try {
    repository = await inspectConfiguredMain(project.repoRoot, project.mainRef);
  } catch (error) {
    input.storage.invalidateProjectTrust(input.projectId, now());
    if (error instanceof GitInspectionError) {
      throw new WorkspaceServiceError(error.code, `Project trust invalidated: ${error.message}`);
    }
    throw error;
  }
  if (repository.repoRoot !== project.repoRoot
    || repository.gitCommonDir !== project.gitCommonDir
    || repository.objectFormat !== project.objectFormat) {
    input.storage.invalidateProjectTrust(input.projectId, now());
    throw new WorkspaceServiceError('REPOSITORY_CHANGED', 'Project trust invalidated after identity changed');
  }

  const operationId = randomUUID();
  const workspaceId = randomUUID();
  const ownershipToken = randomUUID();
  const branchRef = `refs/heads/task/${input.taskId}`;
  const worktreesRoot = join(input.runtimeHome, 'worktrees');
  const path = join(worktreesRoot, input.projectId, input.taskId);
  const plan = input.storage.reserveWorkspacePreparation({
    operationId,
    idempotencyKey: input.commandId,
    payloadHash,
    projectId: input.projectId,
    taskId: input.taskId,
    expectedTaskVersion: input.expectedTaskVersion,
    workspaceId,
    ownershipToken,
    branchRef,
    path,
    baseCommit: repository.headCommit,
    createdAt: now(),
  });
  if (plan.operationState === 'SUCCEEDED' || plan.operationState === 'FAILED') return plan;
  if (plan.operationState !== 'PLANNED') {
    throw new WorkspaceServiceError(
      'RECONCILE_REQUIRED',
      `Workspace operation is ${plan.operationState}; refusing to replay its Git side effect`,
    );
  }

  input.storage.startWorkspacePreparation(plan.operationId, plan.workspaceId, now());
  try {
    const prepared = await prepareWorkspace({
      operationId: plan.operationId,
      repositoryRoot: plan.repoRoot,
      worktreesRoot,
      projectId: plan.projectId,
      mainRef: plan.mainRef,
      taskId: plan.taskId,
      workspaceId: plan.workspaceId,
      ownershipToken: plan.ownershipToken,
      baseCommit: plan.baseCommit,
      expectedMainCommit: plan.baseCommit,
    });
    input.storage.completeWorkspacePreparation({
      operationId: plan.operationId,
      workspaceId: plan.workspaceId,
      eventId: randomUUID(),
      preparedPath: prepared.path,
      preparedBranch: prepared.branchRef,
      completedAt: now(),
    });
    return {
      ...plan,
      operationState: 'SUCCEEDED',
      workspaceState: 'READY',
      path: prepared.path,
      branchRef: prepared.branchRef,
    };
  } catch (error) {
    const reconcileRequired = error instanceof GitInspectionError ? error.reconcileRequired : true;
    const code = error instanceof GitInspectionError || error instanceof StorageError
      ? error.code
      : 'WORKSPACE_PREPARE_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    input.storage.failWorkspacePreparation({
      operationId: plan.operationId,
      workspaceId: plan.workspaceId,
      reconcileRequired,
      error: { code, message },
      failedAt: now(),
    });
    throw new WorkspaceServiceError(code, message);
  }
}
