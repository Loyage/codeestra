import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GitInspectionError,
  inspectBaseRef,
  inspectOwnedWorktreeRebuild,
  prepareWorkspace,
  rebuildOwnedWorktree,
} from '@codeestra/git';
import { decideRetryWorkspace } from '@codeestra/domain';
import {
  Phase1Database,
  SlotReservationError,
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

/**
 * The worktrees root is resolved once, before it is recorded. The Runtime data directory may sit
 * behind a symlinked ancestor (on macOS `/tmp` resolves to `/private/tmp`, and state directories are
 * often symlinked), so the reserved path and the path Git reports must be the same canonical string;
 * otherwise the recorded reservation and the prepared worktree disagree and reconcile sees a
 * mismatch. Resolving here also makes the same home spelled two ways yield one workspace path.
 */
async function canonicalWorktreesRoot(runtimeHome: string): Promise<string> {
  const requested = join(runtimeHome, 'worktrees');
  await mkdir(requested, { recursive: true, mode: 0o700 });
  return await realpath(requested);
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

  // A resumed Execution continues in the workspace it already owns. Reusing it avoids a second
  // worktree and keeps the paused Task's uncommitted work in place; the path/ownership token are
  // already recorded, so no Git side effect runs here.
  const reusable = input.storage.findReusableWorkspace(input.taskId);
  if (reusable !== null) {
    const project = input.storage.getTrustedProject(input.projectId);
    return {
      operationId: `reused:${reusable.workspaceId}`,
      operationState: 'SUCCEEDED' as const,
      projectId: input.projectId,
      taskId: input.taskId,
      workspaceId: reusable.workspaceId,
      workspaceState: 'READY' as const,
      repoRoot: project.repoRoot,
      gitCommonDir: project.gitCommonDir,
      mainRef: project.mainRef,
      devRef: project.devRef,
      objectFormat: project.objectFormat,
      baseCommit: reusable.baseCommit,
      ownershipToken: reusable.ownershipToken,
      branchRef: reusable.branchRef,
      path: reusable.path,
    };
  }

  const project = input.storage.getTrustedProject(input.projectId);
  // A worktree a reclamation removed is re-created from the Task branch that reclamation kept
  // (FOUNDATION-068 / ADR-0042), before the fresh-preparation path can refuse it with a
  // `REF_CONFLICT` it already knows about.
  const rebuilt = await rebuildReclaimedTaskWorkspace({
    storage: input.storage,
    runtimeHome: input.runtimeHome,
    projectId: input.projectId,
    taskId: input.taskId,
    now,
    randomUUID,
  });
  if (rebuilt !== null) return rebuilt;
  let repository;
  let baseCommit;
  try {
    // Every new Task worktree is based on the project's fixed `dev` ref, never on `main` and
    // never on whichever branch happens to be checked out where the project was trusted.
    const inspected = await inspectBaseRef(project.repoRoot, project.devRef);
    repository = inspected.repository;
    baseCommit = inspected.commit;
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
  const worktreesRoot = await canonicalWorktreesRoot(input.runtimeHome);
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
    baseCommit,
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
      baseRef: plan.devRef,
      taskId: plan.taskId,
      workspaceId: plan.workspaceId,
      ownershipToken: plan.ownershipToken,
      baseCommit: plan.baseCommit,
      expectedBaseCommit: plan.baseCommit,
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

/**
 * Re-creates, or adopts, the worktree of a Task whose workspace row a reclamation released
 * (FOUNDATION-068 / ADR-0042).
 *
 * The reclaimed row is the ownership proof and the surviving Task branch is the source: the branch
 * name, the recorded path, the Git registration and the recorded baseline are all re-derived here
 * before anything is created, and `rebuildOwnedWorktree` re-establishes the same invariants at action
 * time. Nothing is deleted (`--force` never runs, an occupied path is a refusal) and nothing is
 * invented on a crash: a worktree created before the ledger write is *adopted* by the next attempt,
 * because the registration and the branch are the durable facts.
 *
 * `null` means "this Task's recorded worktree is not a rebuildable source, so the existing
 * preparation path decides", which keeps every pre-existing behaviour (a first attempt with no
 * workspace row, a `MISSING` worktree and branch, a `READY` reuse) exactly as it was.
 */
async function rebuildReclaimedTaskWorkspace(input: {
  readonly storage: Phase1Database;
  readonly runtimeHome: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly now: () => number;
  readonly randomUUID: () => string;
}): Promise<WorkspacePreparationPlan | null> {
  const recorded = input.storage.getLatestTaskWorkspace(input.taskId);
  if (recorded === null || recorded.state !== 'RELEASED') return null;
  const project = input.storage.getTrustedProject(input.projectId);
  const worktreesRoot = await canonicalWorktreesRoot(input.runtimeHome);
  const observed = await inspectOwnedWorktreeRebuild({
    repositoryRoot: project.repoRoot,
    ownedRoot: worktreesRoot,
    path: recorded.path,
    branchRef: recorded.branchRef,
    baseCommit: recorded.baseCommit,
  });
  // The same domain decision the retry made, over the same facts: a rebuild is never authorised by a
  // recorded *intent*, only by what the filesystem and Git say right now.
  const decision = decideRetryWorkspace({
    workspaceState: recorded.state,
    observation: observed.observation,
    evidence: observed.evidenceRef,
    rebuild: observed,
  });
  if (decision.mode === 'PREPARE_FRESH') return null;
  if (!decision.allowed || decision.mode !== 'REBUILD_OWNED') {
    throw new WorkspaceServiceError(decision.code ?? 'WORKSPACE_OWNERSHIP_UNVERIFIABLE',
      `Workspace ${recorded.workspaceId} (${recorded.state}): ${decision.message}`);
  }
  // A workspace another writer still claims is never re-created under it.
  const reservation = input.storage.findActiveWorkspaceReservation({
    projectId: input.projectId,
    workspaceId: recorded.workspaceId,
  });
  if (reservation !== null) {
    throw new WorkspaceServiceError('ACTIVE_RESERVATION',
      `Slot reservation ${reservation.reservationId} (${reservation.state}) still claims workspace`
      + ` ${recorded.workspaceId}; it is not rebuilt under a live claim`);
  }
  const held = input.storage.listTaskExecutions(input.projectId, input.taskId)
    .find((execution) => execution.resourceHeld);
  if (held !== undefined) {
    throw new WorkspaceServiceError('ACTIVE_EXECUTION',
      `Execution ${held.executionId} still holds this Task's resources; its worktree is not rebuilt`
      + ' under a live writer');
  }
  const rebuilt = await rebuildOwnedWorktree({
    repositoryRoot: project.repoRoot,
    ownedRoot: worktreesRoot,
    projectId: input.projectId,
    taskId: input.taskId,
    path: recorded.path,
    branchRef: recorded.branchRef,
    baseCommit: recorded.baseCommit,
  });
  if (rebuilt.outcome === 'REFUSED' || rebuilt.outcome === 'FAILED') {
    throw new WorkspaceServiceError(rebuilt.reasonCode, rebuilt.detail);
  }
  input.storage.markReclaimedWorkspaceRebuilt({
    projectId: input.projectId,
    taskId: input.taskId,
    workspaceId: recorded.workspaceId,
    expectedPath: recorded.path,
    expectedBranchRef: recorded.branchRef,
    rebuild: {
      outcome: rebuilt.outcome,
      reasonCode: rebuilt.reasonCode,
      detail: rebuilt.detail,
      headCommit: rebuilt.headCommit,
    },
    eventId: input.randomUUID(),
    rebuiltAt: input.now(),
  });
  return {
    operationId: `rebuilt:${recorded.workspaceId}`,
    operationState: 'SUCCEEDED',
    projectId: input.projectId,
    taskId: input.taskId,
    workspaceId: recorded.workspaceId,
    workspaceState: 'READY',
    repoRoot: project.repoRoot,
    gitCommonDir: project.gitCommonDir,
    mainRef: project.mainRef,
    devRef: project.devRef,
    objectFormat: project.objectFormat,
    baseCommit: recorded.baseCommit,
    ownershipToken: recorded.ownershipToken,
    branchRef: recorded.branchRef,
    path: rebuilt.path,
  };
}

/** One prepared workspace, bound to the reservation that owns it. */
export interface ReservedWorkspacePreparation {
  readonly reservationId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly branchRef: string;
  readonly baseCommit: string;
  readonly ownershipToken: string;
  /** False when the reservation already held this workspace and nothing was prepared again. */
  readonly created: boolean;
}

/** A UUID derived from stable parts, so one caller command keeps one derived command identity. */
function derivedId(...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Prepares (or reuses) the workspace of a Task **for an existing reservation**, and binds it.
 *
 * The reservation is the authority: this refuses to prepare a workspace for a reservation this
 * Runtime generation did not create, because a successor generation cannot verify the writer that
 * prepared the worktree, and it refuses to act on a reservation that is no longer active. Multiple
 * reservations across Tasks are the normal case — each Task owns its own worktree — while one
 * worktree can never be bound to two active reservations (a partial unique index, not a convention).
 */
export async function prepareReservedWorkspace(input: {
  readonly storage: Phase1Database;
  readonly runtimeHome: string;
  readonly bootId: string;
  readonly commandId: string;
  readonly projectId: string;
  readonly reservationId: string;
  readonly expectedTaskVersion: number;
  readonly actor: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<ReservedWorkspacePreparation> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const reservation = input.storage.getSlotReservation(input.projectId, input.reservationId);
  if (reservation.state !== 'RESERVED') {
    throw new SlotReservationError('SLOT_NOT_ACTIVE',
      `Reservation ${reservation.reservationId} is ${reservation.state}; no workspace can be prepared for it`);
  }
  if (reservation.holder.bootId !== input.bootId) {
    throw new SlotReservationError('SLOT_HELD_BY_ANOTHER_RUNTIME',
      `Reservation ${reservation.reservationId} was created by Runtime boot ${reservation.holder.bootId}`
      + '; this generation did not create it and does not prepare its workspace');
  }
  if (reservation.workspaceId !== null) {
    const existing = input.storage.findReusableWorkspace(reservation.taskId);
    if (existing?.workspaceId === reservation.workspaceId) {
      return {
        reservationId: reservation.reservationId,
        taskId: reservation.taskId,
        workspaceId: existing.workspaceId,
        path: existing.path,
        branchRef: existing.branchRef,
        baseCommit: existing.baseCommit,
        ownershipToken: existing.ownershipToken,
        created: false,
      };
    }
    throw new SlotReservationError('SLOT_ALREADY_BOUND',
      `Reservation ${reservation.reservationId} already holds workspace ${reservation.workspaceId},`
      + ' which is not in a READY state this command can report');
  }
  const plan = await prepareTaskWorkspace({
    storage: input.storage,
    runtimeHome: input.runtimeHome,
    commandId: derivedId('slot-workspace', input.commandId, input.reservationId),
    projectId: input.projectId,
    taskId: reservation.taskId,
    expectedTaskVersion: input.expectedTaskVersion,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.randomUUID === undefined ? {} : { randomUUID: input.randomUUID }),
  });
  if (plan.workspaceState !== 'READY') {
    throw new WorkspaceServiceError('RECONCILE_REQUIRED',
      `Workspace ${plan.workspaceId} is ${plan.workspaceState} instead of READY`);
  }
  input.storage.bindReservationWorkspace({
    projectId: input.projectId,
    reservationId: input.reservationId,
    workspaceId: plan.workspaceId,
    expectedReservationVersion: reservation.version,
    commandId: derivedId('slot-workspace-bind', input.commandId, input.reservationId),
    payloadHash: derivedId('slot-workspace-bind-payload', input.commandId, plan.workspaceId),
    eventId: randomUUID(),
    actor: input.actor,
    at: now(),
  });
  return {
    reservationId: reservation.reservationId,
    taskId: reservation.taskId,
    workspaceId: plan.workspaceId,
    path: plan.path,
    branchRef: plan.branchRef,
    baseCommit: plan.baseCommit,
    ownershipToken: plan.ownershipToken,
    created: true,
  };
}
