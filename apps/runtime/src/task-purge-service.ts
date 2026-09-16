import { createHash } from 'node:crypto';
import { deleteOwnedTaskBranch } from '@codeestra/git';
import {
  type Phase1Database,
  StorageError,
  type TaskPurgeBranchFact,
  type TaskPurgeReclaimedResource,
  type TaskPurgeResult,
  type TaskPurgeSubject,
} from '@codeestra/storage';
import type { AgentRuntimeCoordinator } from './agent-runtime-service.js';
import { deriveCommandId } from './agent-runtime-service.js';
import { requireRecordedDevRepoPath } from './dev-repo-service.js';
import { applyReclamation, planReclamation, type ReclaimPlan } from './reclaim-service.js';
import { pauseOrCancelTask } from './task-control-service.js';

/**
 * Permanent deletion of one Task (ADR-0058).
 *
 * The command is deliberately a **sequence of reversible steps with one database transaction at the
 * end**, because the irreversibility lives in two different places:
 *
 *  1. the Task may be non-terminal, in which case it is cancelled first — through the ordinary
 *     cooperative stop, so a provider process is only reported stopped when the Adapter confirmed it
 *     exited. An unconfirmed stop ends the command with `RECONCILE_REQUIRED` and **nothing deleted**;
 *  2. the owned worktrees, verification copies and branches are removed through the existing
 *     ownership checks (ADR-0021) before any row is deleted. A resource whose ownership cannot be
 *     proven is a refusal, not a `rm -rf`.
 *
 * Only when both halves succeeded does storage delete the Task and every row it owned, in one
 * transaction, with the `TaskPurged` audit event written inside it.
 *
 * Three refusals are first-class and each names its own reason instead of a generic failure:
 *
 *  - `RECONCILE_REQUIRED` — the Task is `RECOVERY_REQUIRED`, or the stop could not be confirmed. The
 *    Runtime will not delete the record of a provider process it cannot prove is gone; `task recover`
 *    (ADR-0055) reconciles that by observation first.
 *  - `TASK_INTEGRATED_INTO_DEV` / `TASK_IN_STABLE_PROMOTION` — a commit this Task produced lives in
 *    `dev`/`main` and outlives it; deleting the Task would erase where that commit came from.
 *    `task archive` keeps every row and is the answer for those Tasks.
 *  - `PURGE_RESOURCE_NOT_OWNED` — the recorded worktree, verification copy or branch could not be
 *    proven to be this Task's. Nothing is deleted, not even the database rows.
 */

export class TaskPurgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TaskPurgeError';
  }
}

/** The stop a purge had to perform, reported so the user sees what happened before the deletion. */
export interface TaskPurgeStopFact {
  readonly state: string;
  readonly stop: 'TERMINAL' | 'RELEASED' | 'UNCERTAIN';
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly detail: string;
}

export interface TaskPurgeOutcome extends TaskPurgeResult {
  /** True when this command ID had already been performed; nothing ran a second time. */
  readonly replayed: boolean;
  /** Null when the Task was already terminal and no provider process had to be stopped. */
  readonly stop: TaskPurgeStopFact | null;
  readonly plan: {
    readonly worktrees: number;
    readonly verificationCopies: number;
    readonly branches: number;
  };
}

export interface TaskPurgeInput {
  readonly storage: Phase1Database;
  /** The Runtime data directory; its `worktrees`/`verifications` roots are the owned roots. */
  readonly runtimeHome: string;
  readonly coordinator: AgentRuntimeCoordinator;
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly commandId: string;
  readonly actor: string;
  readonly reason?: string | undefined;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

const terminalStates: ReadonlySet<string> = new Set(['SUCCEEDED', 'CANCELLED']);

function payloadHashOf(input: {
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly reason: string | null;
}): string {
  return createHash('sha256').update(JSON.stringify({
    command: 'task.purge',
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: input.expectedVersion,
    reason: input.reason,
  })).digest('hex');
}

export async function purgeTask(input: TaskPurgeInput): Promise<TaskPurgeOutcome> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const reason = input.reason ?? null;
  const hash = payloadHashOf({
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: input.expectedVersion,
    reason,
  });

  // A replay is answered from its own receipt before anything is inspected: the Task it names is
  // gone, so the ordinary pre-flight would answer `NOT_FOUND` for a command that in fact succeeded.
  const recorded = input.storage.findTaskPurgeByCommand({
    projectId: input.projectId,
    commandId: input.commandId,
    taskId: input.taskId,
    payloadHash: hash,
  });
  if (recorded !== null) {
    return { ...recorded, replayed: true, stop: null,
      plan: countsOf(recorded.reclamation, recorded.branchFacts) };
  }

  const subject = requireSubject(input, 'lookup');
  const stop = await stopIfNeeded(input, subject, randomUUID);
  // The version the deletion is decided against is the one the Task has *after* the stop: the
  // caller's `expectedVersion` described the state they saw, and the stop legitimately moved it.
  const current = requireSubject(input, 'after stop');
  if (current.state === 'RECOVERY_REQUIRED') {
    throw new TaskPurgeError('RECONCILE_REQUIRED',
      'The Task is RECOVERY_REQUIRED: the Runtime cannot prove its provider process is gone, so it'
      + ' will not delete the record that names it. Reconcile it with `task recover` first.');
  }

  const plan = await planPurgeResources(input);
  const report = await applyReclamation({
    storage: input.storage,
    runtimeHome: input.runtimeHome,
    projectId: input.projectId,
    taskId: input.taskId,
    kinds: ['TASK_WORKTREE', 'VERIFICATION_COPY'],
    includeFailureScenes: true,
    commandId: deriveCommandId(input.commandId, 'purge-reclaim'),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.randomUUID === undefined ? {} : { randomUUID: input.randomUUID }),
  });
  const blocked = report.outcomeCounts.refused + report.outcomeCounts.failed
    + report.outcomeCounts.recoveryRequired;
  if (blocked > 0) {
    throw new TaskPurgeError('PURGE_RESOURCE_NOT_OWNED',
      `Reclaiming the Task's resources refused or failed for ${blocked} of`
      + ` ${report.targets.length} recorded resource(s); nothing was`
      + ' deleted from the database, and `reclaim.records` names each refusal');
  }

  const branches = await removeOwnedBranches(input, plan);

  const result = input.storage.purgeTask({
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: current.version,
    commandId: input.commandId,
    payloadHash: hash,
    eventId: randomUUID(),
    actor: input.actor,
    reason,
    purgedAt: now(),
    reclamation: report.records.map((record): TaskPurgeReclaimedResource => ({
      kind: record.kind,
      resourceId: record.resourceId,
      path: record.path,
      outcome: record.outcome,
      reasonCode: record.reasonCode,
      branchRef: record.externalRef,
    })),
    branches,
  });
  return {
    ...result,
    replayed: false,
    stop,
    plan: { worktrees: plan.worktrees, verificationCopies: plan.verificationCopies,
      branches: branches.length },
  };
}

function countsOf(
  reclamation: readonly TaskPurgeReclaimedResource[],
  branches: readonly TaskPurgeBranchFact[],
): TaskPurgeOutcome['plan'] {
  return {
    worktrees: reclamation.filter((resource) => resource.kind === 'TASK_WORKTREE').length,
    verificationCopies:
      reclamation.filter((resource) => resource.kind === 'VERIFICATION_COPY').length,
    branches: branches.length,
  };
}

function requireSubject(input: TaskPurgeInput, phase: string): TaskPurgeSubject {
  const subject = input.storage.inspectTaskPurge({
    projectId: input.projectId, taskId: input.taskId,
  });
  if (subject === null) {
    if (phase !== 'lookup') {
      throw new TaskPurgeError('NOT_FOUND',
        'The Task disappeared while it was being purged; nothing was deleted');
    }
    throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
  }
  if (phase === 'lookup' && subject.version !== input.expectedVersion) {
    throw new StorageError('CONCURRENT_MODIFICATION',
      `Task version is ${subject.version}, not the expected ${input.expectedVersion}`);
  }
  const blockers = input.storage.inspectTaskPurgeBlockers({
    projectId: input.projectId, taskId: input.taskId,
  });
  if (blockers.length > 0) {
    const first = blockers[0] as (typeof blockers)[number];
    throw new TaskPurgeError(first.code,
      `Task cannot be purged: ${first.detail}. Its commit is already in a ref;`
      + ' `task archive` hides it without destroying that record.');
  }
  return subject;
}

/**
 * Cancels a non-terminal Task through the ordinary cooperative stop. `RECOVERY_REQUIRED` is refused
 * before the attempt rather than after it: that state *is* "a provider process may still be alive",
 * and a stop that cannot be confirmed must not be turned into a deletion.
 */
async function stopIfNeeded(
  input: TaskPurgeInput,
  subject: TaskPurgeSubject,
  randomUUID: () => string,
): Promise<TaskPurgeStopFact | null> {
  if (terminalStates.has(subject.state)) return null;
  if (subject.state === 'RECOVERY_REQUIRED') {
    throw new TaskPurgeError('RECONCILE_REQUIRED',
      'The Task is RECOVERY_REQUIRED: run `task recover` (ADR-0055) to reconcile it by observation'
      + ' before purging it');
  }
  const stopped = await pauseOrCancelTask({
    storage: input.storage,
    coordinator: input.coordinator,
    kind: 'CANCEL',
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: subject.version,
    commandId: deriveCommandId(input.commandId, 'purge-stop'),
    actor: input.actor,
    ...(input.now === undefined ? {} : { now: input.now }),
    randomUUID,
  });
  if (stopped.stop === 'UNCERTAIN' || stopped.state === 'RECOVERY_REQUIRED') {
    throw new TaskPurgeError('RECONCILE_REQUIRED',
      `The Task was not proven stopped (${stopped.detail}); nothing was deleted. Reconcile it with`
      + ' `task recover` first.');
  }
  return {
    state: stopped.state,
    stop: stopped.stop,
    executionId: stopped.executionId,
    sessionId: stopped.sessionId,
    detail: stopped.detail,
  };
}

/**
 * The read-only pre-flight: every recorded worktree and verification copy must be reclaimable
 * *now*. A single refusal stops the whole purge before anything is removed, so a partial deletion is
 * never the outcome of a resource the Runtime cannot prove it owns.
 */
async function planPurgeResources(input: TaskPurgeInput): Promise<{
  readonly worktrees: number;
  readonly verificationCopies: number;
  readonly targets: ReclaimPlan['targets'];
}> {
  const plan = await planReclamation({
    storage: input.storage,
    runtimeHome: input.runtimeHome,
    projectId: input.projectId,
    taskId: input.taskId,
    kinds: ['TASK_WORKTREE', 'VERIFICATION_COPY'],
    includeFailureScenes: true,
  });
  const refusals = plan.targets.filter((target) =>
    target.action !== 'RECLAIM' && target.action !== 'ALREADY_ABSENT');
  if (refusals.length > 0) {
    const first = refusals[0] as (typeof refusals)[number];
    throw new TaskPurgeError('PURGE_RESOURCE_NOT_OWNED',
      `${refusals.length} recorded resource(s) of this Task cannot be reclaimed:`
      + ` ${first.reasonCode} — ${first.detail} (${first.path}). Nothing was deleted.`);
  }
  return {
    worktrees: plan.targets.filter((target) => target.kind === 'TASK_WORKTREE').length,
    verificationCopies:
      plan.targets.filter((target) => target.kind === 'VERIFICATION_COPY').length,
    targets: plan.targets,
  };
}

/**
 * Deletes the branches the Task's own workspace records attest. Each deletion is a compare-and-swap
 * that reports the tip it destroyed, so "this branch existed, at this commit" survives the purge in
 * the audit event even though the branch does not.
 */
async function removeOwnedBranches(
  input: TaskPurgeInput,
  plan: { readonly targets: ReclaimPlan['targets'] },
): Promise<readonly TaskPurgeBranchFact[]> {
  const project = input.storage.getTrustedProject(input.projectId);
  // The Task worktree is a worktree of the project's dev clone (ADR-0056), so its branch lives in
  // that clone rather than in the stable checkout.
  const repositoryRoot = requireRecordedDevRepoPath(project);
  const branchRefs = [...new Set(plan.targets
    .filter((target) => target.kind === 'TASK_WORKTREE')
    .map((target) => target.externalRef)
    .filter((ref): ref is string => typeof ref === 'string' && ref.length > 0))].sort();
  const facts: TaskPurgeBranchFact[] = [];
  for (const branchRef of branchRefs) {
    const removal = await deleteOwnedTaskBranch({ repositoryRoot, branchRef });
    if (removal.outcome === 'REFUSED' || removal.outcome === 'FAILED') {
      // The worktrees are already gone at this point; `reclaim.records` and the workspace rows still
      // describe that, so the next attempt reconciles rather than guessing.
      throw new TaskPurgeError('PURGE_RESOURCE_NOT_OWNED',
        `Branch ${branchRef} was not deleted (${removal.reasonCode}): ${removal.detail}.`
        + ' Nothing was deleted from the database.');
    }
    facts.push({
      branchRef,
      tipCommit: removal.tipCommit,
      deleted: removal.outcome === 'REMOVED',
      detail: removal.detail,
    });
  }
  return facts;
}
