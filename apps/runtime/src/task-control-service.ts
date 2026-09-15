import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { inspectOwnedWorktreeRebuild } from '@codeestra/git';
import {
  decideRetryWorkspace,
  planTaskRetry,
  selectRetryAdapter,
  type RetryWorkspaceObservation,
  type TaskRetryState,
} from '@codeestra/domain';
import {
  Phase1Database,
  StorageError,
  type TaskLifecycleState,
  type TaskRetryRequest,
  type TaskRetryWorkspaceMode,
} from '@codeestra/storage';
import type { AgentRuntimeCoordinator } from './agent-runtime-service.js';
import { inspectTaskDependencies } from './scheduler.js';
import { requireRecordedDevRepoPath } from './dev-repo-service.js';

export class TaskControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TaskControlError';
  }
}

function payloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export interface TaskStopOutcome {
  readonly taskId: string;
  readonly state: TaskLifecycleState;
  readonly version: number;
  /** `TERMINAL` when no provider process had to be stopped; otherwise the provider outcome. */
  readonly stop: 'TERMINAL' | 'RELEASED' | 'UNCERTAIN';
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly detail: string;
}

/**
 * Pauses or cancels one Task. Both are cooperative: the Runtime first records the intent
 * (`PAUSING`/`CANCELLING` with an Execution `STOPPING`), then asks the Adapter to release the
 * provider process it owns, and only then records `PAUSED`/`CANCELLED`. A stop the Adapter cannot
 * confirm becomes `RECOVERY_REQUIRED` with every resource retained, never a claimed success.
 */
export async function pauseOrCancelTask(input: {
  readonly storage: Phase1Database;
  readonly coordinator: AgentRuntimeCoordinator;
  readonly kind: 'PAUSE' | 'CANCEL';
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly commandId: string;
  readonly actor: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<TaskStopOutcome> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const requested = input.storage.requestTaskStop({
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: input.expectedVersion,
    kind: input.kind,
    commandId: input.commandId,
    payloadHash: payloadHash({
      command: input.kind === 'PAUSE' ? 'task.pause' : 'task.cancel',
      projectId: input.projectId,
      taskId: input.taskId,
      expectedVersion: input.expectedVersion,
    }),
    taskEventId: randomUUID(),
    executionEventId: randomUUID(),
    actor: input.actor,
    requestedAt: now(),
  });
  if (requested.terminal) {
    return {
      taskId: requested.taskId,
      state: requested.state,
      version: requested.version,
      stop: 'TERMINAL',
      executionId: null,
      sessionId: null,
      detail: 'no provider process was running',
    };
  }

  // A replayed command whose first attempt already reached a terminal stop is a success; a Task
  // stuck in RECOVERY_REQUIRED must go through reconcile, not a second blind stop.
  const current = input.storage.getTask(input.projectId, input.taskId);
  if (current !== null) {
    const terminal = input.kind === 'PAUSE' ? 'PAUSED' : 'CANCELLED';
    if (current.state === terminal) {
      return {
        taskId: input.taskId,
        state: current.state,
        version: current.version,
        stop: 'RELEASED',
        executionId: requested.executionId,
        sessionId: requested.sessionId,
        detail: 'stop had already been confirmed',
      };
    }
    if (current.state === 'RECOVERY_REQUIRED') {
      throw new TaskControlError('RECONCILE_REQUIRED',
        'This Task is waiting for recovery; a repeated stop is not proven safe');
    }
  }

  const release = requested.executionId === null
    ? { sessionId: requested.sessionId, released: true, detail: 'no Execution to stop' }
    : await input.coordinator.releaseExecutionProcess(requested.executionId);
  const sessionId = release.sessionId ?? requested.sessionId;
  const evidenceRef = `runtime-stop:${input.kind.toLowerCase()}:${release.detail}`;
  if (!release.released) {
    input.storage.markTaskStopUncertain({
      projectId: input.projectId,
      taskId: input.taskId,
      executionId: requested.executionId,
      sessionId,
      evidenceRef,
      taskEventId: randomUUID(),
      executionEventId: randomUUID(),
      sessionEventId: randomUUID(),
      recoveredAt: now(),
    });
    return {
      taskId: input.taskId,
      state: 'RECOVERY_REQUIRED',
      version: input.storage.getTask(input.projectId, input.taskId)?.version ?? requested.version,
      stop: 'UNCERTAIN',
      executionId: requested.executionId,
      sessionId,
      detail: release.detail,
    };
  }
  const confirmed = input.storage.confirmTaskStopped({
    projectId: input.projectId,
    taskId: input.taskId,
    kind: input.kind,
    executionId: requested.executionId,
    sessionId,
    evidenceRef,
    taskEventId: randomUUID(),
    executionEventId: randomUUID(),
    sessionEventId: randomUUID(),
    stoppedAt: now(),
  });
  return {
    taskId: confirmed.taskId,
    state: confirmed.state,
    version: confirmed.version,
    stop: 'RELEASED',
    executionId: requested.executionId,
    sessionId,
    detail: release.detail,
  };
}

export interface TaskRetryOutcome {
  /** The audit facts the retry transaction recorded, including the failure it follows. */
  readonly retry: TaskRetryRequest;
  /** Where the Adapter came from: an explicit `--adapter`, the Task's own record, or the fallback. */
  readonly adapterSource: 'REQUESTED' | 'RECORDED' | 'FALLBACK';
  readonly workspace: {
    readonly mode: TaskRetryWorkspaceMode;
    readonly workspaceId: string | null;
    /** The Git observation the decision was made from, or null when there was nothing to observe. */
    readonly evidence: string | null;
    readonly detail: string;
  };
}

/**
 * Explicit retry of a `FAILED` Task (ADR-0036).
 *
 * The Task is requeued and a *new* Execution is expected to follow: the old Execution keeps its
 * failure and evidence untouched, and nothing here counts attempts or schedules an automatic retry.
 * The two facts that decide the retry are both re-derived rather than assumed:
 *
 *  - the dependency verdict, because the Task may have lost an upstream while it was failing — an
 *    unmet dependency requeues it as `BLOCKED`, which is the only thing `BLOCKED` means;
 *  - the Task's own worktree, because a retry reuses it only when the filesystem and Git confirm it
 *    is still this Task's, and refuses (rather than guessing) when it is not.
 *
 * Starting the new Execution is deliberately *not* done here: the caller hands the requeued Task to
 * the same scheduling gate every other start goes through, so a retry queues behind dependencies,
 * conflicts and capacity exactly like a first attempt.
 */
export async function retryFailedTask(input: {
  readonly storage: Phase1Database;
  /** The Runtime data directory; its `worktrees` root is the owned root of Task worktrees. */
  readonly runtimeHome: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly commandId: string;
  /** The `--adapter` choice; absent means "the Adapter this Task last ran on". */
  readonly adapterId?: string | undefined;
  readonly knownAdapterIds: readonly string[];
  readonly defaultAdapterId: string;
  readonly actor: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<TaskRetryOutcome> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const task = input.storage.getTask(input.projectId, input.taskId);
  if (task === null) {
    throw new TaskControlError('NOT_FOUND', 'Task was not found in this project');
  }
  // The version is compared before the state, exactly like `submit`/`pause`/`resume`: a caller whose
  // view of the Task is stale is told to re-read it instead of being handed a verdict computed from
  // a state the Task may already have left.
  if (task.version !== input.expectedVersion) {
    throw new StorageError('CONCURRENT_MODIFICATION',
      `Task version is ${task.version}, not the expected ${input.expectedVersion}`);
  }
  const eligibility = planTaskRetry({
    state: task.state as TaskRetryState,
    archived: task.archivedAt !== null,
  });
  if (!eligibility.allowed) {
    // A refusal writes nothing: no requeue, no workspace change, no audit claim about a state the
    // Task was never in.
    throw new TaskControlError(eligibility.code as string, eligibility.message);
  }
  // The failure this retry follows is the newest attempt — the one that ended the Task. Storage
  // re-checks that inside the transaction, so a race cannot make the audit name a different one.
  const failed = input.storage.listTaskExecutions(input.projectId, input.taskId)[0];
  if (failed === undefined || failed.state !== 'FAILED') {
    throw new TaskControlError('TASK_NOT_FAILED',
      'The Task is FAILED but has no recorded failed Execution to retry from');
  }
  const adapter = selectRetryAdapter({
    requested: input.adapterId,
    recorded: failed.adapterId,
    fallback: input.defaultAdapterId,
  });
  if (!input.knownAdapterIds.includes(adapter.adapterId)) {
    throw new TaskControlError('UNKNOWN_ADAPTER',
      `Adapter ${adapter.adapterId} is not registered; known: ${input.knownAdapterIds.join(', ') || 'none'}`);
  }
  const dependencies = await inspectTaskDependencies({
    storage: input.storage,
    projectId: input.projectId,
    taskId: input.taskId,
  });
  const target: 'READY' | 'BLOCKED' = dependencies.blocked ? 'BLOCKED' : 'READY';
  const workspace = await decideWorkspace({
    storage: input.storage,
    runtimeHome: input.runtimeHome,
    projectId: input.projectId,
    taskId: input.taskId,
  });
  const retryPayloadHash = payloadHash({
    command: 'task.retry',
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: input.expectedVersion,
    adapterId: adapter.adapterId,
  });
  const recorded = input.storage.retryTask({
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: input.expectedVersion,
    commandId: input.commandId,
    payloadHash: retryPayloadHash,
    actor: input.actor,
    adapterId: adapter.adapterId,
    failedExecutionId: failed.executionId,
    target,
    dependencyReasons: dependencies.blocked ? dependencies.blockedReasons : [],
    workspace: {
      mode: workspace.mode,
      workspaceId: workspace.workspaceId,
      evidence: workspace.evidence,
    },
    taskEventId: randomUUID(),
    retryEventId: randomUUID(),
    requestedAt: now(),
  });
  return {
    retry: recorded,
    adapterSource: adapter.source,
    workspace: {
      mode: workspace.mode,
      workspaceId: workspace.workspaceId,
      evidence: workspace.evidence,
      detail: workspace.detail,
    },
  };
}

/**
 * The worktree half of the retry decision. The recorded row is not evidence of ownership, so the
 * real filesystem and the Git worktree registry are consulted; an unverifiable worktree is refused
 * instead of being handed to a new Agent.
 *
 * The observation also carries what the Task's own branch still says, because a reclaimed workspace
 * is only rebuildable when the branch a reclamation kept is still this Task's own growth of the
 * recorded baseline (FOUNDATION-068 / ADR-0042). Those facts are read for every recorded row so the
 * reuse, fresh and rebuild verdicts all come from one reading.
 */
async function decideWorkspace(input: {
  readonly storage: Phase1Database;
  readonly runtimeHome: string;
  readonly projectId: string;
  readonly taskId: string;
}): Promise<{
  readonly mode: TaskRetryWorkspaceMode;
  readonly workspaceId: string | null;
  readonly evidence: string | null;
  readonly detail: string;
}> {
  const recorded = input.storage.getLatestTaskWorkspace(input.taskId);
  if (recorded === null) {
    const decision = decideRetryWorkspace({ workspaceState: null, observation: 'MISSING' });
    return {
      mode: decision.mode as TaskRetryWorkspaceMode,
      workspaceId: null,
      evidence: null,
      detail: decision.message,
    };
  }
  const project = input.storage.getTrustedProject(input.projectId);
  // ADR-0056: the Task worktree is a worktree of the project's dev clone, so its ownership and
  // rebuild facts have to be read from that clone.
  const devRepoPath = requireRecordedDevRepoPath(project);
  const observed = await inspectOwnedWorktreeRebuild({
    repositoryRoot: devRepoPath,
    ownedRoot: join(input.runtimeHome, 'worktrees'),
    path: recorded.path,
    branchRef: recorded.branchRef,
    baseCommit: recorded.baseCommit,
  });
  const decision = decideRetryWorkspace({
    workspaceState: recorded.state,
    observation: observed.observation as RetryWorkspaceObservation,
    evidence: observed.evidenceRef,
    rebuild: observed,
  });
  if (!decision.allowed) {
    throw new TaskControlError(decision.code as string,
      `Workspace ${recorded.workspaceId} (${recorded.state}): ${decision.message}`);
  }
  return {
    mode: decision.mode as TaskRetryWorkspaceMode,
    workspaceId: recorded.workspaceId,
    evidence: observed.evidenceRef,
    detail: decision.message,
  };
}

export interface TaskResumeOutcome {
  readonly taskId: string;
  readonly state: TaskLifecycleState;
  readonly version: number;
  readonly resumeFromExecutionId: string;
  readonly executionId: string | null;
  readonly sessionId: string | null;
  /** True when this call started the continuation Execution itself. */
  readonly started: boolean;
}

/**
 * Resumes a `PAUSED` Task. The Task returns to `READY` in its retained workspace and a new
 * Execution continues the predecessor's provider conversation. If a previous attempt already
 * started that Execution, the current one is reported instead of starting a second writer.
 */
export async function resumePausedTask(input: {
  readonly storage: Phase1Database;
  readonly coordinator: AgentRuntimeCoordinator;
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly commandId: string;
  readonly adapterId: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<TaskResumeOutcome> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const resumed = input.storage.resumeTask({
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: input.expectedVersion,
    commandId: input.commandId,
    payloadHash: payloadHash({
      command: 'task.resume',
      projectId: input.projectId,
      taskId: input.taskId,
      expectedVersion: input.expectedVersion,
    }),
    taskEventId: randomUUID(),
    resumedAt: now(),
  });
  const current = input.storage.getTask(input.projectId, input.taskId);
  if (current !== null && current.state === 'RUNNING') {
    const active = input.storage.listTaskExecutions(input.projectId, input.taskId)
      .find((execution) => execution.resourceHeld);
    if (active !== undefined) {
      return {
        taskId: input.taskId,
        state: current.state,
        version: current.version,
        resumeFromExecutionId: resumed.resumeFromExecutionId,
        executionId: active.executionId,
        sessionId: active.session?.sessionId ?? null,
        started: false,
      };
    }
  }
  if (current !== null && current.state === 'RECOVERY_REQUIRED') {
    throw new TaskControlError('RECONCILE_REQUIRED',
      'This Task is waiting for recovery; resume is not proven safe');
  }
  if (resumed.version !== current?.version) {
    // The Task moved between the resume transaction and the run loop; refuse to start a writer
    // against a version the caller did not see.
    throw new StorageError('CONCURRENT_MODIFICATION',
      'Task changed between resume and starting the continuation Execution');
  }
  const run = await input.coordinator.runTask({
    projectId: input.projectId,
    taskId: input.taskId,
    expectedTaskVersion: resumed.version,
    commandId: input.commandId,
    adapterId: input.adapterId,
    resume: {
      resumeFromExecutionId: resumed.resumeFromExecutionId,
      predecessorSessionId: resumed.predecessorSessionId,
      predecessorSessionStorageRef: resumed.predecessorSessionStorageRef,
      predecessorProviderSessionId: resumed.predecessorProviderSessionId,
    },
  });
  return {
    taskId: input.taskId,
    state: 'RUNNING',
    version: run.taskVersion,
    resumeFromExecutionId: resumed.resumeFromExecutionId,
    executionId: run.executionId,
    sessionId: run.sessionId,
    started: true,
  };
}
