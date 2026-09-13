import { createHash } from 'node:crypto';
import { Phase1Database, StorageError, type TaskLifecycleState } from '@codeestra/storage';
import type { AgentRuntimeCoordinator } from './agent-runtime-service.js';

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
