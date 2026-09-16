import { createHash } from 'node:crypto';
import {
  terminateProviderProcessTree,
  type ProviderOwnershipObservation,
  type ProviderProcessTree,
  type ProviderTerminationOutcome,
} from '@codeestra/agent-adapters';
import { deleteOwnedTaskBranch } from '@codeestra/git';
import {
  type Phase1Database,
  StorageError,
  type TaskPurgeBranchFact,
  type TaskPurgeForcedFacts,
  type TaskPurgeReclaimedResource,
  type TaskPurgeResult,
  type TaskPurgeSubject,
} from '@codeestra/storage';
import type { AgentRuntimeCoordinator } from './agent-runtime-service.js';
import { deriveCommandId } from './agent-runtime-service.js';
import { taskWorkspaceRepositoryRoot } from './task-baseline-service.js';
import { applyReclamation, planReclamation, type ReclaimPlan } from './reclaim-service.js';
import { pauseOrCancelTask } from './task-control-service.js';
import { recoverTask, recordedRecoveryTree } from './task-recovery-service.js';

/**
 * Permanent deletion of one Task (ADR-0058).
 *
 * The command is deliberately a **sequence of reversible steps with one database transaction at the
 * end**, because the irreversibility lives in two different places:
 *
 *  1. the Task may be non-terminal, in which case it is stopped first — through the ordinary
 *     cooperative stop, so a provider process is only reported stopped when the Adapter confirmed it
 *     exited. A `RECOVERY_REQUIRED` Task is first reconciled by observation (the `task recover`
 *     ADR-0055 rule): only a provider that is provably gone lets the deletion continue. An
 *     unconfirmed stop or an unprovable provider ends the command with `RECONCILE_REQUIRED` and
 *     **nothing deleted** — unless the caller asked for `--force` (ADR-0058 D09), which first tries to
 *     terminate the provider tree the Task recorded and then deletes anyway, recording what it could
 *     not prove;
 *  2. the owned worktrees, verification copies and branches are removed through the existing
 *     ownership checks (ADR-0021) before any row is deleted. A resource whose ownership cannot be
 *     proven is a refusal, not a `rm -rf`. `--force` steps over the *live-claim* half of those checks
 *     (the Task is being retired, so `ACTIVE_EXECUTION`/`TASK_NOT_TERMINAL` protect nothing) but
 *     never the ownership half: a path the Runtime cannot prove is this Task's stays on disk.
 *
 * Only when both halves succeeded does storage delete the Task and every row it owned, in one
 * transaction, with the `TaskPurged` audit event written inside it.
 *
 * Three refusals are first-class and each names its own reason instead of a generic failure:
 *
 *  - `RECONCILE_REQUIRED` — the stop could not be confirmed, or a `RECOVERY_REQUIRED` Task could not
 *    be reconciled because the provider process may still be alive (or its ownership could not be
 *    observed). The Runtime will not delete the record of a provider process it cannot prove is
 *    gone; `task recover` (ADR-0055) expresses the same refusal, and `task purge` performs that
 *    observation itself instead of asking the user to run a second command. `--force` (ADR-0058 D09)
 *    is the caller's explicit statement that the deletion should happen anyway: the Runtime then
 *    terminates the recorded provider tree (identity-verified pids only) and deletes, recording the
 *    refusal it stepped over and whether the process really died.
 *  - `PURGE_RESOURCE_NOT_OWNED` — the recorded worktree, verification copy or branch could not be
 *    proven to be this Task's. Nothing is deleted, not even the database rows. Under `--force` the
 *    unprovable resources are left where they are and reported in `forced.bypassed`.
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
  /**
   * `FORCED` is `--force` (ADR-0058 D09) deleting a Task whose provider the reconcile could not
   * prove gone: the state is unchanged and the record says so instead of claiming a proved stop.
   */
  readonly stop: 'TERMINAL' | 'RELEASED' | 'RECOVERED' | 'FORCED' | 'UNCERTAIN';
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
  /**
   * `--force` (ADR-0058 D09): step over the refusals that would otherwise stop the deletion. It is a
   * wider statement by the same caller — never a second approval layer — and everything it stepped
   * over is recorded in the outcome and the `TaskPurged` audit event.
   */
  readonly force?: boolean;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  /** Process-table observation for a `RECOVERY_REQUIRED` reconcile; overridable in tests. */
  readonly inspectOwnership?: (tree: ProviderProcessTree) => Promise<ProviderOwnershipObservation>;
  /** Whether the recorded workspace path still exists; overridable in tests. */
  readonly pathExists?: (path: string) => boolean;
  /** Termination of a provider the reconcile could not prove gone (`--force`); overridable in tests. */
  readonly terminate?: (tree: ProviderProcessTree) => Promise<ProviderTerminationOutcome>;
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
  const force = input.force === true;
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

  // The refusals `--force` steps over are read while the Task is stopped (a live provider claim), so
  // the record describes what was known at that moment. ADR-0062 removed the "its commit already
  // reached `dev`/`main`" refusal: no Runtime-managed ref carries a Task's commit any more.
  const bypassed: { readonly code: string; readonly detail: string }[] = [];

  const subject = requireSubject(input, 'lookup');
  const stopped = await stopIfNeeded(input, subject, randomUUID, force);
  bypassed.push(...stopped.bypassed);
  // The version the deletion is decided against is the one the Task has *after* the stop: the
  // caller's `expectedVersion` described the state they saw, and the stop legitimately moved it.
  const current = requireSubject(input, 'after stop');
  if (current.state === 'RECOVERY_REQUIRED' && !force) {
    throw new TaskPurgeError('RECONCILE_REQUIRED',
      'The Task is RECOVERY_REQUIRED: the Runtime cannot prove its provider process is gone, so it'
      + ' will not delete the record that names it. Reconcile it with `task recover` first.');
  }

  const plan = await planPurgeResources(input, force);
  const report = await applyReclamation({
    storage: input.storage,
    runtimeHome: input.runtimeHome,
    projectId: input.projectId,
    taskId: input.taskId,
    kinds: ['TASK_WORKTREE', 'VERIFICATION_COPY'],
    includeFailureScenes: true,
    // ADR-0058 D09: a forced purge has already retired this Task, so a resource that only a live
    // claim was protecting may go too. The ownership checks inside reclamation still apply.
    ...(force ? { ignoreLiveClaims: true } : {}),
    commandId: deriveCommandId(input.commandId, 'purge-reclaim'),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.randomUUID === undefined ? {} : { randomUUID: input.randomUUID }),
  });
  const blocked = report.outcomeCounts.refused + report.outcomeCounts.failed
    + report.outcomeCounts.recoveryRequired;
  if (blocked > 0) {
    if (!force) {
      throw new TaskPurgeError('PURGE_RESOURCE_NOT_OWNED',
        `Reclaiming the Task's resources refused or failed for ${blocked} of`
        + ` ${report.targets.length} recorded resource(s); nothing was`
        + ' deleted from the database, and `reclaim.records` names each refusal');
    }
    // `--force` leaves a resource it cannot prove it owns exactly where it is; the refusal is a fact
    // of this purge, not a failure of it.
    for (const record of report.records) {
      if (record.outcome !== 'REFUSED' && record.outcome !== 'FAILED'
        && record.outcome !== 'RECOVERY_REQUIRED') continue;
      bypassed.push({ code: 'PURGE_RESOURCE_NOT_OWNED',
        detail: `${record.kind} ${record.path}: ${record.reasonCode}`
          + `${record.detail === null ? '' : ` — ${record.detail}`} (left on disk)` });
    }
  }

  const branches = await removeOwnedBranches(input, plan, force, bypassed);

  const forced: TaskPurgeForcedFacts | null = force
    ? { bypassed, termination: stopped.termination }
    : null;
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
    forced,
  });
  return {
    ...result,
    replayed: false,
    stop: stopped.stop,
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
  return subject;
}

/** What the stop step decided, including the `--force` half of it. */
interface PurgeStopStep {
  readonly stop: TaskPurgeStopFact | null;
  readonly termination: ProviderTerminationOutcome | null;
  readonly bypassed: readonly { readonly code: string; readonly detail: string }[];
}

/**
 * Stops a non-terminal Task before it is deleted.
 *
 * A `RECOVERY_REQUIRED` Task is not cancelled: that state *is* "a provider process may still be
 * alive", so the only thing that can make it deletable is the ADR-0055 observation. The reconcile is
 * therefore performed here, with the same `task recover` service, instead of refusing and asking the
 * user to run a second command. A provider that is provably gone closes the run as `FAILED` and the
 * deletion continues; anything else is `RECONCILE_REQUIRED` and **nothing is deleted** — unless the
 * caller passed `--force` (ADR-0058 D09), in which case the Runtime first tries to terminate the
 * provider tree the Task recorded and then deletes anyway, recording both the refusal and whether the
 * process really died.
 */
async function stopIfNeeded(
  input: TaskPurgeInput,
  subject: TaskPurgeSubject,
  randomUUID: () => string,
  force: boolean,
): Promise<PurgeStopStep> {
  if (terminalStates.has(subject.state)) {
    return { stop: null, termination: null, bypassed: [] };
  }
  if (subject.state === 'RECOVERY_REQUIRED') {
    return await reconcileOrForce(input, subject, randomUUID, force);
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
    const detail = `The Task was not proven stopped (${stopped.detail})`;
    if (!force) {
      throw new TaskPurgeError('RECONCILE_REQUIRED',
        `${detail}; nothing was deleted. Retry \`task purge\``
        + ' once the process is gone (it reconciles by observation), or run `task recover` first.');
    }
    const termination = await terminateForcedProvider(input);
    return {
      stop: {
        state: stopped.state,
        stop: 'FORCED',
        executionId: stopped.executionId,
        sessionId: stopped.sessionId,
        detail: `${detail}; deleted anyway because --force was passed`,
      },
      termination,
      bypassed: [{ code: 'RECONCILE_REQUIRED', detail: stopped.detail }],
    };
  }
  return {
    stop: {
      state: stopped.state,
      stop: stopped.stop,
      executionId: stopped.executionId,
      sessionId: stopped.sessionId,
      detail: stopped.detail,
    },
    termination: null,
    bypassed: [],
  };
}

/**
 * The `RECOVERY_REQUIRED` half of the stop step: reconcile first, and only step over the refusal when
 * the caller passed `--force` (ADR-0058 D09).
 */
async function reconcileOrForce(
  input: TaskPurgeInput,
  subject: TaskPurgeSubject,
  randomUUID: () => string,
  force: boolean,
): Promise<PurgeStopStep> {
  try {
    const reconciled = await reconcileBeforePurge(input, subject, randomUUID);
    return { stop: reconciled, termination: null, bypassed: [] };
  } catch (error) {
    if (!force || !(error instanceof TaskPurgeError) || error.code !== 'RECONCILE_REQUIRED') {
      throw error;
    }
    const termination = await terminateForcedProvider(input);
    const recovery = input.storage.getTaskRecoverySubject(input.projectId, input.taskId);
    return {
      stop: {
        state: 'RECOVERY_REQUIRED',
        stop: 'FORCED',
        executionId: recovery?.executionId ?? null,
        sessionId: recovery?.sessionId ?? null,
        detail: `${error.message}; deleted anyway because --force was passed`,
      },
      termination,
      bypassed: [{ code: 'RECONCILE_REQUIRED', detail: error.message }],
    };
  }
}

/**
 * The one thing `--force` does about a provider it could not prove gone: try to terminate exactly the
 * processes the Task recorded (ADR-0058 D09).
 *
 * Nothing is signalled when the record kept no identity: a process that cannot be attributed by pid
 * **and** start token is not this provider, and killing a stranger's process is worse than leaving an
 * orphan. Returns null in that case, and the outcome then carries no termination facts at all.
 */
async function terminateForcedProvider(
  input: TaskPurgeInput,
): Promise<ProviderTerminationOutcome | null> {
  const subject = input.storage.getTaskRecoverySubject(input.projectId, input.taskId);
  if (subject === null) return null;
  const tree = recordedRecoveryTree(subject);
  if (tree === null) return null;
  const terminate = input.terminate
    ?? ((value: ProviderProcessTree) => terminateProviderProcessTree({ tree: value }));
  return await terminate(tree);
}

/**
 * Reconciles a `RECOVERY_REQUIRED` Task from real facts before it is deleted (ADR-0055).
 *
 * This is the `task recover` service, called with a command ID derived from the purge command, so a
 * replayed successful purge reaches its purge receipt instead of reconciling again. Only
 * `RECONCILED`/`ALREADY_RECONCILED` let the deletion continue; every refusal (provider alive,
 * descendant alive, identity missing, ownership unverifiable) is reported as `RECONCILE_REQUIRED`
 * and changes nothing, leaving a later retry free to observe again.
 */
async function reconcileBeforePurge(
  input: TaskPurgeInput,
  subject: TaskPurgeSubject,
  randomUUID: () => string,
): Promise<TaskPurgeStopFact> {
  const reason = input.reason ?? null;
  const payloadHash = createHash('sha256').update(JSON.stringify({
    command: 'task.recover',
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: subject.version,
    purgeCommandId: input.commandId,
    reason,
  })).digest('hex');
  const view = await recoverTask({
    storage: input.storage,
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: subject.version,
    commandId: deriveCommandId(input.commandId, 'purge-recover'),
    payloadHash,
    actor: input.actor,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.now === undefined ? {} : { now: input.now }),
    randomUUID,
    ...(input.inspectOwnership === undefined ? {} : { inspectOwnership: input.inspectOwnership }),
    ...(input.pathExists === undefined ? {} : { pathExists: input.pathExists }),
  });
  if (view.outcome === 'REFUSED') {
    throw new TaskPurgeError('RECONCILE_REQUIRED', view.detail);
  }
  return {
    state: view.taskState,
    stop: 'RECOVERED',
    executionId: view.observation.executionId,
    sessionId: view.observation.sessionId,
    detail: view.detail,
  };
}

/**
 * The read-only pre-flight: every recorded worktree and verification copy must be reclaimable
 * *now*. A single refusal stops the whole purge before anything is removed, so a partial deletion is
 * never the outcome of a resource the Runtime cannot prove it owns. Under `--force` the plan is still
 * read (the caller reports what it would have refused), but it no longer stops the deletion — the
 * ownership checks are re-applied by the reclamation itself, which leaves unprovable paths alone.
 */
async function planPurgeResources(input: TaskPurgeInput, force: boolean): Promise<{
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
    ...(force ? { ignoreLiveClaims: true } : {}),
  });
  const refusals = plan.targets.filter((target) =>
    target.action !== 'RECLAIM' && target.action !== 'ALREADY_ABSENT');
  if (refusals.length > 0 && !force) {
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
 * the audit event even though the branch does not. Under `--force` (ADR-0058 D09) a branch that cannot
 * be deleted (checked out somewhere, renamed, not local) is recorded as not deleted instead of
 * aborting the deletion of the Task.
 */
async function removeOwnedBranches(
  input: TaskPurgeInput,
  plan: { readonly targets: ReclaimPlan['targets'] },
  force: boolean,
  bypassed: { code: string; detail: string }[],
): Promise<readonly TaskPurgeBranchFact[]> {
  const project = input.storage.getTrustedProject(input.projectId);
  // ADR-0060: the Task branch lives in the repository that owns this project's Task worktrees — the
  // dev clone when one is recorded, otherwise the project folder — not necessarily in the stable
  // checkout.
  const repositoryRoot = taskWorkspaceRepositoryRoot(project);
  const branchRefs = [...new Set(plan.targets
    .filter((target) => target.kind === 'TASK_WORKTREE')
    .map((target) => target.externalRef)
    .filter((ref): ref is string => typeof ref === 'string' && ref.length > 0))].sort();
  const facts: TaskPurgeBranchFact[] = [];
  for (const branchRef of branchRefs) {
    const removal = await deleteOwnedTaskBranch({ repositoryRoot, branchRef });
    if (removal.outcome === 'REFUSED' || removal.outcome === 'FAILED') {
      if (!force) {
        // The worktrees are already gone at this point; `reclaim.records` and the workspace rows still
        // describe that, so the next attempt reconciles rather than guessing.
        throw new TaskPurgeError('PURGE_RESOURCE_NOT_OWNED',
          `Branch ${branchRef} was not deleted (${removal.reasonCode}): ${removal.detail}.`
          + ' Nothing was deleted from the database.');
      }
      bypassed.push({ code: 'PURGE_RESOURCE_NOT_OWNED',
        detail: `branch ${branchRef}: ${removal.reasonCode} — ${removal.detail} (left in place)` });
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
