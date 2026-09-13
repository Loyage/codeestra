import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  inspectOwnedPath,
  inspectOwnedWorktreeRegistration,
  inspectWorktreeState,
  isAncestor,
  readLocalRefCommit,
  removeOwnedWorktree,
} from '@codeestra/git';
import {
  Phase1Database,
  StorageError,
  type ReclamationCandidates,
  type ReclamationRecord,
  type ReclamationRecordInput,
  type ReclamationOutcome,
  type TaskLifecycleState,
} from '@codeestra/storage';

export class ReclaimServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ReclaimServiceError';
  }
}

export type ReclaimKind = 'TASK_WORKTREE' | 'VERIFICATION_COPY' | 'INTEGRATION_WORKTREE';
export const reclaimKinds: readonly ReclaimKind[] = [
  'TASK_WORKTREE', 'VERIFICATION_COPY', 'INTEGRATION_WORKTREE',
];
export type ReclaimAction = 'RECLAIM' | 'RETAIN' | 'REFUSE' | 'ALREADY_ABSENT';

/**
 * One resource a reclamation run considered. `action` is the decision, `reasonCode`/`detail` say
 * why, and `evidence` carries the ownership facts (recorded identity plus what was actually
 * observed) that authorized or refused it.
 */
export interface ReclaimTarget {
  readonly kind: ReclaimKind;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly resourceId: string;
  readonly resourceState: string;
  readonly path: string;
  readonly ownershipToken: string | null;
  readonly externalRef: string | null;
  readonly action: ReclaimAction;
  readonly reasonCode: string;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface ReclaimCounts {
  readonly total: number;
  readonly reclaim: number;
  readonly retain: number;
  readonly refuse: number;
  readonly alreadyAbsent: number;
}

export interface ReclaimPlan {
  readonly projectId: string;
  readonly projectName: string;
  readonly taskId: string | null;
  readonly includeFailureScenes: boolean;
  readonly kinds: readonly ReclaimKind[];
  readonly devCommit: string | null;
  readonly targets: readonly ReclaimTarget[];
  readonly counts: ReclaimCounts;
}

export interface ReclaimOutcomeCounts {
  readonly reclaimed: number;
  readonly alreadyAbsent: number;
  readonly retained: number;
  readonly refused: number;
  readonly failed: number;
}

export interface ReclaimReport extends ReclaimPlan {
  readonly operationId: string;
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly records: readonly ReclamationRecord[];
  readonly outcomeCounts: ReclaimOutcomeCounts;
  /** True when the recorded result of this command ID was returned instead of a second run. */
  readonly alreadyCompleted: boolean;
  readonly created: boolean;
}

export interface ReclaimPlanInput {
  readonly storage: Phase1Database;
  readonly runtimeHome: string;
  readonly projectId: string;
  readonly taskId?: string;
  readonly kinds?: readonly ReclaimKind[];
  readonly includeFailureScenes?: boolean;
}

export interface ReclaimApplyInput extends ReclaimPlanInput {
  readonly commandId: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

export interface ReclamationReconcileResult {
  readonly operationId: string;
  readonly projectId: string;
  readonly outcome: 'COMPLETED' | 'FAILED' | 'NOT_STARTED';
  readonly reclaimed: number;
  readonly remaining: number;
}

/**
 * Task states that own a workspace and may still hold a provider process. Reclaiming one would
 * destroy live state, so it is refused no matter what the caller asked for.
 */
const activeTaskStates: ReadonlySet<TaskLifecycleState> = new Set([
  'RUNNING', 'PAUSING', 'PAUSED', 'WAITING_FOR_USER', 'CANCELLING', 'RECOVERY_REQUIRED',
]);

/** Task states in which a retained worktree is no longer expected to continue working. */
const terminalTaskStates: ReadonlySet<TaskLifecycleState> = new Set([
  'EXECUTED', 'SUCCEEDED', 'FAILED', 'CANCELLED',
]);

const activeIntegrationStates = new Set(['CREATED', 'PREPARING', 'VERIFYING', 'INTEGRATING_DEV']);
const failureIntegrationStates = new Set(['CONFLICTED', 'FAILED', 'RECOVERY_REQUIRED']);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ownedRootFor(runtimeHome: string, kind: ReclaimKind): string {
  const directory = kind === 'TASK_WORKTREE' ? 'worktrees'
    : kind === 'VERIFICATION_COPY' ? 'verifications' : 'integrations';
  return join(runtimeHome, directory);
}

function samePath(left: string, right: string): boolean {
  return left === right;
}

interface BuiltPlan {
  readonly plan: ReclaimPlan;
  readonly candidates: ReclamationCandidates;
}

/**
 * Decides, for every Runtime-owned resource of a project, whether it may be removed. Nothing is
 * written and nothing is deleted: this is the same read-only evaluation `reclaim.apply` starts
 * from, so a preview and a real run can never disagree about *what* is owned.
 *
 * Decision order matters: a live owner is refused before anything else, a resource whose path
 * escapes the Runtime root is refused before its registration is even considered, and a failure
 * scene is retained unless the caller explicitly asked for it.
 */
async function buildPlan(input: ReclaimPlanInput): Promise<BuiltPlan> {
  const kinds = input.kinds === undefined ? reclaimKinds : [...new Set(input.kinds)];
  const includeFailureScenes = input.includeFailureScenes ?? false;
  let candidates: ReclamationCandidates;
  try {
    candidates = input.storage.getReclamationCandidates(input.projectId, {
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    });
  } catch (error) {
    if (error instanceof StorageError) throw new ReclaimServiceError(error.code, error.message);
    throw error;
  }
  const repositoryRoot = candidates.project.repoRoot;
  let devCommit: string | null = null;
  try {
    devCommit = await readLocalRefCommit({ repositoryRoot, ref: candidates.project.devRef });
  } catch {
    // An unreadable baseline only means "mergedness is unknown"; every unknown is treated as
    // "not merged", which retains the resource instead of deleting it.
    devCommit = null;
  }
  const taskById = new Map(candidates.tasks.map((task) => [task.taskId, task]));
  const targets: ReclaimTarget[] = [];
  const wanted = new Set(kinds);

  if (wanted.has('TASK_WORKTREE')) {
    for (const workspace of candidates.workspaces) {
      const task = taskById.get(workspace.taskId);
      if (task === undefined) continue;
      const ownedRoot = ownedRootFor(input.runtimeHome, 'TASK_WORKTREE');
      const owned = await inspectOwnedPath({ ownedRoot, path: workspace.path });
      const registration = await inspectOwnedWorktreeRegistration({
        repositoryRoot, path: workspace.path,
      });
      const state = registration.registered && registration.pathExists
        ? await inspectWorktreeState({ path: workspace.path })
        : null;
      let merged: boolean | null = null;
      if (task.resultCommit !== null && devCommit !== null) {
        try {
          merged = await isAncestor({
            repositoryRoot, ancestor: task.resultCommit, descendant: devCommit,
          });
        } catch {
          merged = null;
        }
      }
      const evidence: Record<string, unknown> = {
        ownedRoot: owned.ownedRoot,
        pathExists: owned.exists,
        symlink: owned.symlink,
        canonicalPath: owned.canonicalPath,
        insideOwnedRoot: owned.insideOwnedRoot,
        registered: registration.registered,
        registeredPath: registration.registeredPath,
        registeredBranch: registration.branchRef,
        registrationHead: registration.headCommit,
        branchRef: workspace.branchRef,
        baseCommit: workspace.baseCommit,
        headCommit: state?.headCommit ?? registration.headCommit,
        taskState: task.state,
        workspaceState: workspace.state,
        resourceHeld: workspace.resourceHeld,
        resultCommit: task.resultCommit,
        devCommit,
        merged,
        clean: state === null ? null : state.clean,
        trackedModifications: state?.trackedModifications ?? [],
        untrackedFiles: state?.untrackedFiles ?? [],
      };
      const base = {
        kind: 'TASK_WORKTREE' as const,
        projectId: input.projectId,
        taskId: workspace.taskId,
        taskDisplayNumber: task.displayNumber,
        resourceId: workspace.workspaceId,
        resourceState: workspace.state,
        path: workspace.path,
        ownershipToken: workspace.ownershipToken,
        externalRef: workspace.branchRef,
        evidence,
      };
      const refusal = (reasonCode: string, detail: string): ReclaimTarget =>
        ({ ...base, action: 'REFUSE', reasonCode, detail });
      if (workspace.resourceHeld) {
        targets.push(refusal('ACTIVE_EXECUTION',
          'An Execution of this Task still holds its resources; cancel or wait for it first'));
      } else if (activeTaskStates.has(task.state)) {
        targets.push(refusal('TASK_NOT_TERMINAL',
          `Task is ${task.state} and still owns its workspace`));
      } else if (!terminalTaskStates.has(task.state)) {
        targets.push(refusal('TASK_NOT_TERMINAL',
          `Task is ${task.state}; only a finished Task's workspace can be reclaimed`));
      } else if (owned.symlink) {
        targets.push(refusal('SYMLINK_ESCAPE',
          'The recorded workspace path is a symlink and is never followed'));
      } else if (owned.exists && !owned.insideOwnedRoot) {
        targets.push(refusal('PATH_OUTSIDE_OWNED_ROOT',
          'The recorded workspace path resolves outside the Runtime worktrees root'));
      } else if (!registration.registered && !registration.pathExists) {
        targets.push({ ...base, action: 'ALREADY_ABSENT', reasonCode: 'ALREADY_ABSENT',
          detail: 'The worktree is neither registered nor present on disk' });
      } else if (registration.registered && !registration.pathExists) {
        targets.push({ ...base, action: 'RECLAIM', reasonCode: 'REGISTRATION_ONLY',
          detail: 'Only a stale worktree registration is left; it is pruned without deleting anything' });
      } else if (!registration.registered) {
        targets.push(refusal('UNREGISTERED_DIRECTORY',
          'A directory exists at the recorded path but Git does not register it as this worktree'));
      } else if (registration.registeredPath === null
        || !samePath(registration.registeredPath, owned.canonicalPath ?? workspace.path)) {
        targets.push(refusal('REGISTRATION_PATH_MISMATCH',
          'The Git worktree registration does not match the recorded workspace path'));
      } else if (registration.branchRef !== workspace.branchRef) {
        targets.push(refusal('BRANCH_MISMATCH',
          `The worktree is on ${registration.branchRef ?? 'a detached HEAD'}, not ${workspace.branchRef}`));
      } else {
        const scene: string[] = [];
        if (task.state === 'FAILED' || task.state === 'CANCELLED') scene.push(`task ${task.state}`);
        if (workspace.state === 'RECOVERY_REQUIRED') scene.push('workspace RECOVERY_REQUIRED');
        if (state !== null && !state.clean) scene.push('uncommitted work in the worktree');
        if (merged !== true) scene.push(merged === null
          ? 'no captured result commit, so nothing proves the work reached dev'
          : 'the result commit is not merged into dev');
        if (scene.length > 0 && !includeFailureScenes) {
          targets.push({ ...base, action: 'RETAIN', reasonCode: 'FAILURE_SCENE',
            detail: `Retained as a failure scene: ${scene.join('; ')}` });
        } else {
          targets.push({ ...base, action: 'RECLAIM',
            reasonCode: scene.length === 0 ? 'COMPLETED_AND_QUIESCENT' : 'FAILURE_SCENE_INCLUDED',
            detail: scene.length === 0
              ? 'The worktree is clean, its result is in dev, and no Execution holds it'
              : `Included failure scene: ${scene.join('; ')}` });
        }
      }
    }
  }

  if (wanted.has('VERIFICATION_COPY')) {
    for (const copy of candidates.verificationCopies) {
      const task = taskById.get(copy.taskId);
      if (task === undefined) continue;
      const ownedRoot = ownedRootFor(input.runtimeHome, 'VERIFICATION_COPY');
      const owned = await inspectOwnedPath({ ownedRoot, path: copy.copyPath });
      const registration = await inspectOwnedWorktreeRegistration({
        repositoryRoot, path: copy.copyPath,
      });
      const evidence: Record<string, unknown> = {
        ownedRoot: owned.ownedRoot,
        pathExists: owned.exists,
        symlink: owned.symlink,
        canonicalPath: owned.canonicalPath,
        insideOwnedRoot: owned.insideOwnedRoot,
        registered: registration.registered,
        registeredPath: registration.registeredPath,
        detached: registration.detached,
        registrationHead: registration.headCommit,
        testedCommit: copy.testedCommit,
        verificationState: copy.state,
        outcomeCode: copy.outcomeCode,
      };
      const base = {
        kind: 'VERIFICATION_COPY' as const,
        projectId: input.projectId,
        taskId: copy.taskId,
        taskDisplayNumber: task.displayNumber,
        resourceId: copy.verificationId,
        resourceState: copy.state,
        path: copy.copyPath,
        ownershipToken: null,
        externalRef: copy.testedCommit,
        evidence,
      };
      const refusal = (reasonCode: string, detail: string): ReclaimTarget =>
        ({ ...base, action: 'REFUSE', reasonCode, detail });
      if (copy.state === 'QUEUED' || copy.state === 'RUNNING') {
        targets.push(refusal('ACTIVE_VERIFICATION',
          `Verification run is ${copy.state} and still owns its copy`));
      } else if (owned.symlink) {
        targets.push(refusal('SYMLINK_ESCAPE',
          'The recorded copy path is a symlink and is never followed'));
      } else if (owned.exists && !owned.insideOwnedRoot) {
        targets.push(refusal('PATH_OUTSIDE_OWNED_ROOT',
          'The recorded copy path resolves outside the Runtime verifications root'));
      } else if (!registration.registered && !registration.pathExists) {
        targets.push({ ...base, action: 'ALREADY_ABSENT', reasonCode: 'ALREADY_ABSENT',
          detail: 'The verification copy is neither registered nor present on disk' });
      } else if (registration.registered && !registration.pathExists) {
        targets.push({ ...base, action: 'RECLAIM', reasonCode: 'REGISTRATION_ONLY',
          detail: 'Only a stale copy registration is left; it is pruned without deleting anything' });
      } else if (!registration.registered) {
        targets.push(refusal('UNREGISTERED_DIRECTORY',
          'A directory exists at the recorded copy path but Git does not register it'));
      } else if (!registration.detached || registration.headCommit !== copy.testedCommit) {
        targets.push(refusal('HEAD_MISMATCH',
          'The copy is not the detached checkout of the commit its verification tested'));
      } else if ((copy.state === 'FAILED' || copy.state === 'ERROR') && !includeFailureScenes) {
        targets.push({ ...base, action: 'RETAIN', reasonCode: 'FAILURE_SCENE',
          detail: `Retained as a failure scene: verification ended ${copy.state}`
            + `${copy.outcomeCode === null ? '' : ` (${copy.outcomeCode})`}` });
      } else {
        targets.push({ ...base, action: 'RECLAIM',
          reasonCode: copy.state === 'FAILED' || copy.state === 'ERROR'
            ? 'FAILURE_SCENE_INCLUDED' : 'COMPLETED_VERIFICATION',
          detail: 'The recorded copy still exists and its ownership matches its verification record' });
      }
    }
  }

  if (wanted.has('INTEGRATION_WORKTREE')) {
    for (const batch of candidates.integrationWorktrees) {
      const task = taskById.get(batch.taskId);
      if (task === undefined) continue;
      const ownedRoot = ownedRootFor(input.runtimeHome, 'INTEGRATION_WORKTREE');
      const owned = await inspectOwnedPath({ ownedRoot, path: batch.worktreePath });
      const registration = await inspectOwnedWorktreeRegistration({
        repositoryRoot, path: batch.worktreePath,
      });
      const recordedCommits = [batch.devCommit, batch.mergedCommit, batch.integratedCommit]
        .filter((commit): commit is string => commit !== null);
      const evidence: Record<string, unknown> = {
        ownedRoot: owned.ownedRoot,
        pathExists: owned.exists,
        symlink: owned.symlink,
        canonicalPath: owned.canonicalPath,
        insideOwnedRoot: owned.insideOwnedRoot,
        registered: registration.registered,
        registeredPath: registration.registeredPath,
        detached: registration.detached,
        registrationHead: registration.headCommit,
        devCommit: batch.devCommit,
        mergedCommit: batch.mergedCommit,
        integratedCommit: batch.integratedCommit,
        batchState: batch.state,
        worktreeOwnershipToken: batch.ownershipToken,
        batchDetail: batch.detail,
      };
      const base = {
        kind: 'INTEGRATION_WORKTREE' as const,
        projectId: input.projectId,
        taskId: batch.taskId,
        taskDisplayNumber: task.displayNumber,
        resourceId: batch.batchId,
        resourceState: batch.state,
        path: batch.worktreePath,
        ownershipToken: batch.ownershipToken,
        externalRef: batch.mergedCommit ?? batch.integratedCommit ?? batch.devCommit,
        evidence,
      };
      const refusal = (reasonCode: string, detail: string): ReclaimTarget =>
        ({ ...base, action: 'REFUSE', reasonCode, detail });
      if (activeIntegrationStates.has(batch.state)) {
        targets.push(refusal('ACTIVE_INTEGRATION',
          `Integration batch is ${batch.state} and still owns its worktree`));
      } else if (owned.symlink) {
        targets.push(refusal('SYMLINK_ESCAPE',
          'The recorded integration worktree path is a symlink and is never followed'));
      } else if (owned.exists && !owned.insideOwnedRoot) {
        targets.push(refusal('PATH_OUTSIDE_OWNED_ROOT',
          'The recorded integration path resolves outside the Runtime integrations root'));
      } else if (!registration.registered && !registration.pathExists) {
        targets.push({ ...base, action: 'ALREADY_ABSENT', reasonCode: 'ALREADY_ABSENT',
          detail: 'The integration worktree is neither registered nor present on disk' });
      } else if (registration.registered && !registration.pathExists) {
        targets.push({ ...base, action: 'RECLAIM', reasonCode: 'REGISTRATION_ONLY',
          detail: 'Only a stale integration worktree registration is left; it is pruned' });
      } else if (!registration.registered) {
        targets.push(refusal('UNREGISTERED_DIRECTORY',
          'A directory exists at the recorded integration path but Git does not register it'));
      } else if (!registration.detached || registration.headCommit === null
        || !recordedCommits.includes(registration.headCommit)) {
        targets.push(refusal('HEAD_MISMATCH',
          'The integration worktree is not the detached checkout of a commit its batch recorded'));
      } else if (failureIntegrationStates.has(batch.state) && !includeFailureScenes) {
        targets.push({ ...base, action: 'RETAIN', reasonCode: 'FAILURE_SCENE',
          detail: `Retained as a failure scene: integration batch is ${batch.state}` });
      } else {
        targets.push({ ...base, action: 'RECLAIM',
          reasonCode: failureIntegrationStates.has(batch.state)
            ? 'FAILURE_SCENE_INCLUDED' : 'COMPLETED_INTEGRATION',
          detail: 'The recorded integration worktree still exists and its ownership matches its batch' });
      }
    }
  }

  targets.sort((left, right) => left.taskDisplayNumber - right.taskDisplayNumber
    || left.kind.localeCompare(right.kind)
    || left.resourceId.localeCompare(right.resourceId));
  const counts: ReclaimCounts = {
    total: targets.length,
    reclaim: targets.filter((target) => target.action === 'RECLAIM').length,
    retain: targets.filter((target) => target.action === 'RETAIN').length,
    refuse: targets.filter((target) => target.action === 'REFUSE').length,
    alreadyAbsent: targets.filter((target) => target.action === 'ALREADY_ABSENT').length,
  };
  return {
    plan: {
      projectId: input.projectId,
      projectName: candidates.project.name,
      taskId: input.taskId ?? null,
      includeFailureScenes,
      kinds,
      devCommit,
      targets,
      counts,
    },
    candidates,
  };
}

/** Read-only preview: performs no deletion and writes nothing. */
export async function planReclamation(input: ReclaimPlanInput): Promise<ReclaimPlan> {
  return (await buildPlan(input)).plan;
}

interface RecordedTarget {
  readonly kind: ReclaimKind;
  readonly projectId: string;
  readonly taskId: string;
  readonly resourceId: string;
  readonly path: string;
  readonly ownershipToken: string | null;
  readonly externalRef: string | null;
  readonly resourceState: string;
  readonly repositoryRoot: string;
  readonly action: ReclaimAction;
}

function recordInput(
  target: ReclaimTarget,
  id: string,
  outcome: ReclamationOutcome,
  reasonCode: string,
  detail: string,
  evidence: Readonly<Record<string, unknown>>,
): ReclamationRecordInput {
  return {
    id,
    taskId: target.taskId,
    kind: target.kind,
    resourceId: target.resourceId,
    path: target.path,
    ownershipToken: target.ownershipToken,
    externalRef: target.externalRef,
    resourceState: target.resourceState,
    outcome,
    reasonCode,
    detail,
    evidence,
  };
}

function removeOutcome(outcome: 'REMOVED' | 'ALREADY_ABSENT' | 'REFUSED' | 'FAILED'): ReclamationOutcome {
  if (outcome === 'REMOVED') return 'RECLAIMED';
  if (outcome === 'ALREADY_ABSENT') return 'ALREADY_ABSENT';
  return outcome;
}

/**
 * Executes one reclamation. The plan is rebuilt here, every removal re-verifies ownership at the
 * moment it acts, and each decision lands in the append-only ledger. A resource that is already
 * gone is reported, not treated as a failure, so running the command twice is harmless.
 */
export async function applyReclamation(input: ReclaimApplyInput): Promise<ReclaimReport> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const kinds = input.kinds === undefined ? reclaimKinds : [...new Set(input.kinds)];
  const includeFailureScenes = input.includeFailureScenes ?? false;
  const payloadHash = sha256(JSON.stringify({
    projectId: input.projectId,
    taskId: input.taskId ?? null,
    kinds: [...kinds].sort(),
    includeFailureScenes,
  }));
  const existing = input.storage.findReclamationOperation(input.projectId, input.commandId);
  if (existing !== null) {
    if (existing.request['payloadHash'] !== payloadHash) {
      throw new ReclaimServiceError('COMMAND_CONFLICT',
        'Command ID was already used with a different reclamation request');
    }
    if (existing.result !== null
      && (existing.operationState === 'SUCCEEDED' || existing.operationState === 'FAILED')) {
      return {
        ...(existing.result as unknown as ReclaimReport),
        alreadyCompleted: true,
        created: false,
      };
    }
    throw new ReclaimServiceError('RECLAMATION_IN_PROGRESS',
      `Reclamation operation ${existing.operationId} is ${existing.operationState};`
      + ' it was interrupted and must be reconciled before it can be replayed');
  }

  const built = await buildPlan({ ...input, kinds, includeFailureScenes });
  const repositoryRoot = built.candidates.project.repoRoot;
  const recordedTargets: RecordedTarget[] = built.plan.targets.map((target) => ({
    kind: target.kind,
    projectId: target.projectId,
    taskId: target.taskId,
    resourceId: target.resourceId,
    path: target.path,
    ownershipToken: target.ownershipToken,
    externalRef: target.externalRef,
    resourceState: target.resourceState,
    repositoryRoot,
    action: target.action,
  }));
  const operation = input.storage.planReclamationOperation({
    operationId: randomUUID(),
    projectId: input.projectId,
    commandId: input.commandId,
    request: {
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      kinds,
      includeFailureScenes,
      payloadHash,
      targets: recordedTargets,
    },
    createdAt: now(),
  });
  input.storage.startReclamationOperation(operation.operationId, now());

  const records: ReclamationRecordInput[] = [];
  for (const target of built.plan.targets) {
    if (target.action === 'ALREADY_ABSENT') {
      records.push(recordInput(target, randomUUID(), 'ALREADY_ABSENT',
        target.reasonCode, target.detail, target.evidence));
      continue;
    }
    if (target.action === 'RETAIN' || target.action === 'REFUSE') {
      records.push(recordInput(target, randomUUID(),
        target.action === 'RETAIN' ? 'RETAINED' : 'REFUSED',
        target.reasonCode, target.detail, target.evidence));
      continue;
    }
    const ownedRoot = ownedRootFor(input.runtimeHome, target.kind);
    const observedHead = typeof target.evidence['registrationHead'] === 'string'
      ? target.evidence['registrationHead'] as string
      : null;
    const removal = await removeOwnedWorktree({
      repositoryRoot,
      ownedRoot,
      path: target.path,
      ...(target.kind === 'TASK_WORKTREE'
        ? { expectedBranchRef: target.externalRef as string }
        : { expectedDetachedCommit: target.kind === 'VERIFICATION_COPY'
            ? target.externalRef as string
            : observedHead as string }),
    });
    const outcome = removeOutcome(removal.outcome);
    const evidence = { ...target.evidence, removal: removal.evidence,
      removalReasonCode: removal.reasonCode };
    if (target.kind === 'TASK_WORKTREE' && (outcome === 'RECLAIMED' || outcome === 'ALREADY_ABSENT')) {
      try {
        input.storage.releaseWorkspaceForReclamation({
          projectId: input.projectId,
          taskId: target.taskId,
          workspaceId: target.resourceId,
          expectedPath: target.path,
          eventId: randomUUID(),
          reason: removal.reasonCode,
          releasedAt: now(),
        });
      } catch (error) {
        // The directory is gone but the workspace row still claims ownership. Saying so is the
        // honest outcome; the next run reconciles the row without deleting anything again.
        records.push(recordInput(target, randomUUID(), 'FAILED', 'WORKSPACE_RELEASE_FAILED',
          error instanceof Error ? error.message : String(error), evidence));
        continue;
      }
    }
    records.push(recordInput(target, randomUUID(), outcome, removal.reasonCode,
      removal.detail, evidence));
  }

  const outcomeCounts: ReclaimOutcomeCounts = {
    reclaimed: records.filter((record) => record.outcome === 'RECLAIMED').length,
    alreadyAbsent: records.filter((record) => record.outcome === 'ALREADY_ABSENT').length,
    retained: records.filter((record) => record.outcome === 'RETAINED').length,
    refused: records.filter((record) => record.outcome === 'REFUSED').length,
    failed: records.filter((record) => record.outcome === 'FAILED').length,
  };
  const outcome = outcomeCounts.failed > 0 ? 'FAILED' as const : 'SUCCEEDED' as const;
  const completedAt = now();
  const report: ReclaimReport = {
    ...built.plan,
    operationId: operation.operationId,
    outcome,
    records: records.map((record) => ({
      ...record,
      projectId: input.projectId,
      operationId: operation.operationId,
      commandId: input.commandId,
      createdAt: completedAt,
    })),
    outcomeCounts,
    alreadyCompleted: false,
    created: true,
  };
  input.storage.finishReclamationOperation({
    operationId: operation.operationId,
    projectId: input.projectId,
    commandId: input.commandId,
    payloadHash,
    state: outcome,
    result: report,
    records,
    eventId: randomUUID(),
    completedAt,
  });
  return report;
}

function recordedTargetsFromRequest(request: Readonly<Record<string, unknown>>): readonly RecordedTarget[] {
  const raw = request['targets'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const kind = record['kind'];
    if (kind !== 'TASK_WORKTREE' && kind !== 'VERIFICATION_COPY'
      && kind !== 'INTEGRATION_WORKTREE') return [];
    return [{
      kind,
      projectId: String(record['projectId'] ?? ''),
      taskId: String(record['taskId'] ?? ''),
      resourceId: String(record['resourceId'] ?? ''),
      path: String(record['path'] ?? ''),
      ownershipToken: typeof record['ownershipToken'] === 'string' ? record['ownershipToken'] : null,
      externalRef: typeof record['externalRef'] === 'string' ? record['externalRef'] : null,
      resourceState: String(record['resourceState'] ?? ''),
      repositoryRoot: String(record['repositoryRoot'] ?? ''),
      action: 'RECLAIM' as ReclaimAction,
    }];
  });
}

/**
 * Reconciles a reclamation the Runtime was killed in the middle of. It never deletes anything:
 * for every recorded target it inspects the actual state, records what it finds, releases a
 * workspace whose directory is already gone, and leaves the rest for the next explicit run.
 */
export async function reconcileInterruptedReclamations(input: {
  readonly storage: Phase1Database;
  readonly runtimeHome: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<readonly ReclamationReconcileResult[]> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const results: ReclamationReconcileResult[] = [];
  for (const operation of input.storage.listIncompleteReclamationOperations()) {
    const targets = recordedTargetsFromRequest(operation.request);
    const payloadHash = typeof operation.request['payloadHash'] === 'string'
      ? operation.request['payloadHash'] as string
      : sha256(JSON.stringify({ operationId: operation.operationId }));
    const completedAt = now();
    if (operation.operationState === 'PLANNED' || targets.length === 0) {
      const report = {
        projectId: operation.projectId,
        operationId: operation.operationId,
        outcome: 'FAILED',
        reconciled: 'NOT_STARTED',
        detail: 'The Runtime restarted before any reclamation side effect started; re-run reclaim apply',
      };
      input.storage.finishReclamationOperation({
        operationId: operation.operationId,
        projectId: operation.projectId,
        commandId: operation.commandId,
        payloadHash,
        state: 'FAILED',
        result: report,
        records: [],
        eventId: randomUUID(),
        completedAt,
      });
      results.push({ operationId: operation.operationId, projectId: operation.projectId,
        outcome: 'NOT_STARTED', reclaimed: 0, remaining: 0 });
      continue;
    }
    const records: ReclamationRecordInput[] = [];
    let remaining = 0;
    let reclaimed = 0;
    for (const target of targets) {
      const registration = await inspectOwnedWorktreeRegistration({
        repositoryRoot: target.repositoryRoot,
        path: target.path,
      });
      const gone = !registration.registered && !registration.pathExists;
      const evidence: Record<string, unknown> = {
        reconciled: true,
        registered: registration.registered,
        registeredPath: registration.registeredPath,
        pathExists: registration.pathExists,
        headCommit: registration.headCommit,
        branchRef: registration.branchRef,
      };
      const asTarget: ReclaimTarget = {
        kind: target.kind,
        projectId: target.projectId,
        taskId: target.taskId,
        taskDisplayNumber: 0,
        resourceId: target.resourceId,
        resourceState: target.resourceState,
        path: target.path,
        ownershipToken: target.ownershipToken,
        externalRef: target.externalRef,
        action: 'RECLAIM',
        reasonCode: 'RECONCILED',
        detail: '',
        evidence,
      };
      if (!gone) {
        remaining += 1;
        records.push(recordInput(asTarget, randomUUID(), 'RETAINED', 'INTERRUPTED_UNFINISHED',
          'The Runtime restarted before this resource was reclaimed; re-run reclaim apply', evidence));
        continue;
      }
      let released = true;
      if (target.kind === 'TASK_WORKTREE') {
        try {
          input.storage.releaseWorkspaceForReclamation({
            projectId: target.projectId,
            taskId: target.taskId,
            workspaceId: target.resourceId,
            expectedPath: target.path,
            eventId: randomUUID(),
            reason: 'RECONCILED_INTERRUPTED',
            releasedAt: completedAt,
          });
        } catch {
          released = false;
        }
      }
      if (!released) {
        remaining += 1;
        records.push(recordInput(asTarget, randomUUID(), 'RETAINED', 'INTERRUPTED_UNFINISHED',
          'The resource is gone but its workspace row could not be released', evidence));
        continue;
      }
      reclaimed += 1;
      records.push(recordInput(asTarget, randomUUID(), 'RECLAIMED', 'RECONCILED_INTERRUPTED',
        'The resource is gone; the interrupted reclamation was reconciled from the actual state',
        evidence));
    }
    const state = remaining === 0 ? 'SUCCEEDED' as const : 'FAILED' as const;
    const report = {
      projectId: operation.projectId,
      operationId: operation.operationId,
      outcome: state,
      reconciled: true,
      reclaimed,
      remaining,
    };
    input.storage.finishReclamationOperation({
      operationId: operation.operationId,
      projectId: operation.projectId,
      commandId: operation.commandId,
      payloadHash,
      state,
      result: report,
      records,
      eventId: randomUUID(),
      completedAt,
    });
    results.push({ operationId: operation.operationId, projectId: operation.projectId,
      outcome: state === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED', reclaimed, remaining });
  }
  return results;
}

/** Wraps the append-only ledger read for the Runtime command face. */
export function listReclamationRecords(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskId?: string;
  readonly limit?: number;
}): readonly ReclamationRecord[] {
  try {
    // The ledger is project data like every other query: an unknown or untrusted project is
    // reported as such instead of looking like an empty history.
    input.storage.getTrustedProject(input.projectId);
    return input.storage.listReclamationRecords(input.projectId, {
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  } catch (error) {
    if (error instanceof StorageError) throw new ReclaimServiceError(error.code, error.message);
    throw error;
  }
}
