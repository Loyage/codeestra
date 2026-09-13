import {
  verificationPolicyLabel,
} from '@codeestra/contracts';
import {
  Phase1Database,
  type OperationProgressState,
  type OperationSummary,
} from '@codeestra/storage';
import type { AgentRuntimeCoordinator } from './agent-runtime-service.js';
import { pauseOrCancelTask } from './task-control-service.js';
import {
  VerificationRunner,
  executeQueuedVerification,
  queueTaskVerification,
  type QueuedTaskVerification,
  type VerificationExecutionCallbacks,
  type VerificationReport,
} from './verification-service.js';

export class OperationServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'OperationServiceError';
  }
}

/** The Operation kind that covers one Agent run: reserve, start, observe, settle. */
export const runTaskOperationKind = 'RUN_TASK';
/** The Operation kind `task.verify` records (created together with the verification run). */
export const verifyTaskOperationKind = 'RUN_TASK_VERIFICATION';

/**
 * Stable step vocabulary. A step is written only where the Runtime actually reached that boundary,
 * so a reader can trust the list instead of treating it as an estimate. Codes are stable so a
 * script can branch on them.
 */
export const operationSteps = {
  runRequested: 'RUN_REQUESTED',
  workspacePrepared: 'WORKSPACE_PREPARED',
  executionReserved: 'EXECUTION_RESERVED',
  agentSessionStarted: 'AGENT_SESSION_STARTED',
  agentSettled: 'AGENT_SETTLED',
  verificationQueued: 'VERIFICATION_QUEUED',
  verificationCopy: 'VERIFICATION_COPY_CREATED',
  commandStarted: (commandId: string) => `COMMAND:${commandId}:STARTED`,
  commandFinished: (commandId: string) => `COMMAND:${commandId}:FINISHED`,
  cancelRequested: 'CANCEL_REQUESTED',
  cancelUnconfirmed: 'CANCEL_UNCONFIRMED',
} as const;

/** Execution states that still own a provider process or a workspace. */
const ACTIVE_EXECUTION_STATES: ReadonlySet<string> = new Set([
  'CREATED', 'PREPARING', 'STARTING', 'RUNNING', 'WAITING_FOR_USER', 'PAUSING', 'PAUSED',
  'STOPPING', 'RECOVERY_REQUIRED',
]);

export interface RunOperationStepInput {
  readonly storage: Phase1Database;
  readonly operationId: string;
  readonly stepKey: string;
  readonly step: string;
  readonly state: OperationProgressState;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly recordedAt: number;
}

/** Appends one run step. Idempotent by `stepKey`, so a replayed command re-records nothing. */
export function recordRunStep(input: RunOperationStepInput): void {
  input.storage.recordOperationProgress({
    operationId: input.operationId,
    stepKey: input.stepKey,
    step: input.step,
    state: input.state,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    recordedAt: input.recordedAt,
  });
}

/**
 * Creates the durable Operation that covers one `task.run`. The command ID is the idempotency key,
 * so replaying the same command returns the Operation the first attempt created instead of a second
 * one — the same rule the workspace and Agent start Operations already follow.
 */
export function beginTaskRunOperation(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskId: string;
  readonly operationId: string;
  readonly commandId: string;
  readonly adapterId: string;
  readonly expectedTaskVersion: number;
  readonly createdAt: number;
}): Readonly<{ operation: OperationSummary; created: boolean }> {
  const begun = input.storage.beginRunOperation({
    operationId: input.operationId,
    projectId: input.projectId,
    kind: runTaskOperationKind,
    aggregateId: input.taskId,
    idempotencyKey: input.commandId,
    request: {
      taskId: input.taskId,
      adapterId: input.adapterId,
      expectedTaskVersion: input.expectedTaskVersion,
    },
    createdAt: input.createdAt,
  });
  if (begun.created) {
    recordRunStep({
      storage: input.storage,
      operationId: begun.operation.operationId,
      stepKey: operationSteps.runRequested,
      step: 'RUN',
      state: 'STARTED',
      detail: { adapterId: input.adapterId, expectedTaskVersion: input.expectedTaskVersion },
      recordedAt: input.createdAt,
    });
  }
  return begun;
}

/**
 * Closes one run Operation from the facts the Runtime can actually read: the Session's recorded
 * state and the Execution's recorded state. Nothing is inferred from "the stream ended" alone — a
 * stream that ended without a terminal projection is recorded as needing a human, not as success.
 */
export function settleRunOperation(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly observed: boolean;
  readonly recordedAt: number;
}): OperationSummary | null {
  const operation = input.storage.findActiveRunOperation(input.projectId, input.taskId);
  if (operation === null) return null;
  const session = input.storage.findAgentSessionByExecution(input.executionId);
  const execution = input.storage
    .listTaskExecutions(input.projectId, input.taskId)
    .find((candidate) => candidate.executionId === input.executionId);
  recordRunStep({
    storage: input.storage,
    operationId: operation.operationId,
    stepKey: operationSteps.agentSettled,
    step: 'AGENT_SETTLED',
    state: 'INFO',
    detail: {
      observationEnded: input.observed,
      sessionState: session?.state ?? null,
      executionState: execution?.state ?? null,
    },
    recordedAt: input.recordedAt,
  });
  const complete = (
    state: 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED',
    code: string,
    message: string,
  ): OperationSummary => input.storage.completeOperation({
    operationId: operation.operationId,
    state,
    result: {
      code,
      message,
      sessionState: session?.state ?? null,
      executionState: execution?.state ?? null,
    },
    completedAt: input.recordedAt,
  });
  if (!input.observed || session === null || execution === undefined) {
    return complete('RECONCILE_REQUIRED', 'OBSERVATION_ENDED_UNKNOWN',
      'The observation stream ended without a recorded Session state; a human must check the facts');
  }
  if (session.state === 'DISCONNECTED' || session.state === 'RECOVERY_REQUIRED') {
    return complete('RECONCILE_REQUIRED', `SESSION_${session.state}`,
      `The provider connection was lost (Session ${session.state}); ownership is retained`);
  }
  if (session.state !== 'EXITED') {
    return complete('RECONCILE_REQUIRED', `SESSION_STILL_${session.state}`,
      `The observation stream ended while the Session was still ${session.state}`);
  }
  if (execution.state === 'FAILED') {
    return complete('FAILED', 'AGENT_FAILED',
      `The Agent Session exited after a recorded failure (${execution.error?.code ?? 'unknown'})`);
  }
  if (execution.state === 'CANCELLED' || execution.state === 'SUPERSEDED') {
    return complete('FAILED', 'STOPPED_BY_USER',
      `The Agent Session was stopped through the Task control path (Execution ${execution.state})`);
  }
  // The Agent settled and exited. That is not a captured result and not a verified Task: the run is
  // over, and the Execution/Task records keep saying what still has to happen next.
  return complete('SUCCEEDED', 'AGENT_SETTLED',
    'The Agent Session exited after settling; the result still has to be captured and verified');
}

export interface RunOperationRecoveryResult {
  readonly operationId: string;
  readonly outcome: 'RECOVERED_SUCCEEDED' | 'RECOVERED_FAILED' | 'RECOVERY_REQUIRED';
}

/**
 * Reconciles run Operations a previous Runtime left unfinished. A run whose Execution is still
 * active cannot be resolved from a database row alone — the provider process may or may not exist —
 * so it becomes `RECONCILE_REQUIRED` with ownership untouched. A terminal Execution, or a run that
 * never recorded one, is closed from that fact.
 */
export function reconcileRunOperations(input: {
  readonly storage: Phase1Database;
  readonly recordedAt: number;
}): readonly RunOperationRecoveryResult[] {
  const results: RunOperationRecoveryResult[] = [];
  for (const operation of input.storage.listIncompleteRunOperations()) {
    const taskId = operation.taskId;
    if (taskId === null) {
      input.storage.completeOperation({
        operationId: operation.operationId,
        state: 'RECONCILE_REQUIRED',
        result: { code: 'RUNTIME_RESTARTED', message: 'The Operation has no Task to reconcile against' },
        completedAt: input.recordedAt,
      });
      results.push({ operationId: operation.operationId, outcome: 'RECOVERY_REQUIRED' });
      continue;
    }
    const reserved = operation.steps.find((step) => step.stepKey === operationSteps.executionReserved);
    const executionId = typeof reserved?.detail?.['executionId'] === 'string'
      ? reserved.detail['executionId'] as string
      : null;
    if (executionId === null) {
      input.storage.completeOperation({
        operationId: operation.operationId,
        state: 'FAILED',
        result: {
          code: 'RUNTIME_RESTARTED',
          message: 'The Runtime restarted before this run recorded an Execution;'
            + ' any Git side effect is owned by the workspace reconcile, not replayed from here',
        },
        completedAt: input.recordedAt,
      });
      results.push({ operationId: operation.operationId, outcome: 'RECOVERED_FAILED' });
      continue;
    }
    const execution = input.storage
      .listTaskExecutions(operation.projectId, taskId)
      .find((candidate) => candidate.executionId === executionId);
    if (execution === undefined
      || execution.resourceHeld
      || ACTIVE_EXECUTION_STATES.has(execution.state)) {
      input.storage.completeOperation({
        operationId: operation.operationId,
        state: 'RECONCILE_REQUIRED',
        result: {
          code: 'RUNTIME_RESTARTED',
          message: `The Runtime restarted while Execution ${executionId} was`
            + ` ${execution?.state ?? 'unreadable'}; provider process liveness is unknown and`
            + ' ownership is retained',
        },
        completedAt: input.recordedAt,
      });
      results.push({ operationId: operation.operationId, outcome: 'RECOVERY_REQUIRED' });
      continue;
    }
    const succeeded = execution.state === 'SUCCEEDED';
    input.storage.completeOperation({
      operationId: operation.operationId,
      state: succeeded ? 'SUCCEEDED' : 'FAILED',
      result: {
        code: succeeded ? 'RECOVERED_SUCCEEDED' : 'RECOVERED_FAILED',
        message: `The Runtime restarted after Execution ${executionId} reached ${execution.state}`,
        executionState: execution.state,
      },
      completedAt: input.recordedAt,
    });
    results.push({
      operationId: operation.operationId,
      outcome: succeeded ? 'RECOVERED_SUCCEEDED' : 'RECOVERED_FAILED',
    });
  }
  return results;
}

/** The handle a background `task.verify` returns instead of a finished report. */
export interface VerificationOperationHandle {
  readonly background: true;
  readonly verificationId: string;
  readonly operationId: string;
  readonly taskId: string;
  readonly state: string;
  readonly testedCommit: string;
  readonly commandCount: number;
  readonly message: string;
}

export type VerificationStart =
  | { readonly background: true; readonly handle: VerificationOperationHandle }
  | { readonly background: false; readonly report: VerificationReport };

export interface OperationCancelOutcome {
  readonly operationId: string;
  readonly kind: string;
  readonly state: OperationSummary['state'];
  readonly stop: 'CANCELLED' | 'PAUSED' | 'ALREADY_TERMINAL' | 'UNCERTAIN';
  readonly detail: string;
  readonly taskState: string | null;
}

interface VerificationJob {
  readonly operationId: string;
  readonly verificationId: string;
  cancelled: boolean;
  promise: Promise<void>;
  /** The finished report, so the synchronous caller gets the same detail as before. */
  report: VerificationReport | null;
}

export interface LongOperationServiceOptions {
  readonly storage: Phase1Database;
  readonly runner: VerificationRunner;
  readonly coordinator: AgentRuntimeCoordinator;
  readonly copiesRoot: string;
  readonly permissionMode: () => 'FULL' | 'STRICT';
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly shutdownGraceMs?: number;
  readonly logger?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

/**
 * Owns long commands that outlive one request: it records what a run or a verification is doing,
 * hands back a handle when the caller asks for the background form, and cancels them with a
 * confirmed process stop. A stop it cannot confirm becomes `RECONCILE_REQUIRED` with the process
 * ownership kept, never a claimed success.
 */
export class LongOperationService {
  readonly #storage: Phase1Database;
  readonly #runner: VerificationRunner;
  readonly #coordinator: AgentRuntimeCoordinator;
  readonly #copiesRoot: string;
  readonly #permissionMode: () => 'FULL' | 'STRICT';
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #shutdownGraceMs: number;
  readonly #logger: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  readonly #jobs = new Map<string, VerificationJob>();
  #closing = false;

  constructor(options: LongOperationServiceOptions) {
    this.#storage = options.storage;
    this.#runner = options.runner;
    this.#coordinator = options.coordinator;
    this.#copiesRoot = options.copiesRoot;
    this.#permissionMode = options.permissionMode;
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
    this.#logger = options.logger ?? (() => {});
  }

  activeVerificationIds(): readonly string[] {
    return [...this.#jobs.keys()];
  }

  /**
   * Queues one verification run and either awaits it (the default, synchronous form) or returns a
   * handle immediately while it keeps running. Either way the Operation exists before any command is
   * spawned, so a cancel or a Runtime restart can find it.
   */
  async startVerification(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly executionId?: string;
    readonly commandId: string;
    readonly background: boolean;
  }): Promise<VerificationStart> {
    const queued = await queueTaskVerification({
      storage: this.#storage,
      copiesRoot: this.#copiesRoot,
      projectId: input.projectId,
      taskId: input.taskId,
      ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
      commandId: input.commandId,
      permissionMode: this.#permissionMode(),
      now: this.#now,
      randomUUID: this.#randomUUID,
    });
    if (queued.replay !== null) {
      // The command ID already recorded a run: report it instead of starting a second one.
      const plan = this.#storage.getVerificationRun(input.projectId, queued.verificationId);
      return input.background
        ? { background: true, handle: this.#handle(queued, plan.state,
            'This command ID already recorded a verification run') }
        : { background: false, report: queued.replay };
    }
    recordRunStep({
      storage: this.#storage,
      operationId: queued.operationId,
      stepKey: operationSteps.verificationQueued,
      step: 'VERIFICATION_QUEUED',
      state: 'STARTED',
      detail: {
        verificationId: queued.verificationId,
        testedCommit: queued.testedCommit,
        commandCount: queued.commands.length,
        policyDigest: queued.policyDigest,
      },
      recordedAt: this.#now(),
    });
    const job = this.#launchVerification(queued);
    if (input.background) {
      const plan = this.#storage.getVerificationRun(input.projectId, queued.verificationId);
      return { background: true, handle: this.#handle(queued, plan.state,
        'The verification runs in the background; follow it with task operation list') };
    }
    await job.promise;
    return { background: false, report: job.report ?? this.#report(queued) };
  }

  #handle(
    queued: QueuedTaskVerification,
    state: string,
    message: string,
  ): VerificationOperationHandle {
    return {
      background: true,
      verificationId: queued.verificationId,
      operationId: queued.operationId,
      taskId: queued.taskId,
      state,
      testedCommit: queued.testedCommit,
      commandCount: queued.commands.length,
      message,
    };
  }

  /**
   * The synchronous caller awaits a report, and the report must exist even when the run was
   * cancelled. `executeQueuedVerification` already waited for the terminal record in that case, so
   * the plan read here is the Runtime's own record, not a guess.
   */
  #report(queued: QueuedTaskVerification): VerificationReport {
    const plan = this.#storage.getVerificationRun(queued.projectId, queued.verificationId);
    return {
      verificationId: plan.verificationId,
      projectId: plan.projectId,
      taskId: plan.taskId,
      executionId: plan.executionId,
      revisionId: plan.revisionId,
      testedCommit: plan.testedCommit,
      testedTree: plan.testedTree,
      policyVersion: plan.policyVersion,
      policyDigest: plan.policyDigest,
      policyLabel: verificationPolicyLabel(plan.policyDigest),
      mainCommit: plan.mainCommit,
      state: plan.state,
      outcomeCode: plan.outcomeCode,
      commands: [],
      tree: null,
      copyPath: plan.copyPath,
      copyRemoved: null,
      copyDetail: null,
      staleEvidenceInvalidated: queued.staleEvidenceInvalidated,
      alreadyCompleted: queued.replay !== null,
      evidence: plan.evidence,
    };
  }

  #launchVerification(queued: QueuedTaskVerification): VerificationJob {
    const callbacks: VerificationExecutionCallbacks = {
      // A closing Runtime is treated as a cancel: the job stops at the next step boundary without
      // writing a verdict, and startup reconcile records RUNTIME_RESTARTED from the facts.
      isCancelled: () =>
        this.#closing || this.#jobs.get(queued.verificationId)?.cancelled === true,
      onCopyCreated: (path) => {
        recordRunStep({
          storage: this.#storage,
          operationId: queued.operationId,
          stepKey: operationSteps.verificationCopy,
          step: 'COPY',
          state: 'INFO',
          detail: { copyPath: path },
          recordedAt: this.#now(),
        });
      },
      onCommandStart: (command) => {
        recordRunStep({
          storage: this.#storage,
          operationId: queued.operationId,
          stepKey: operationSteps.commandStarted(command.id),
          step: 'COMMAND',
          state: 'STARTED',
          detail: {
            commandId: command.id,
            argv: command.argv,
            cwd: command.cwd,
            timeoutSeconds: command.timeoutSeconds,
          },
          recordedAt: this.#now(),
        });
      },
      onCommandEnd: (outcome) => {
        recordRunStep({
          storage: this.#storage,
          operationId: queued.operationId,
          stepKey: operationSteps.commandFinished(outcome.id),
          step: 'COMMAND',
          state: outcome.timedOut ? 'FAILED' : outcome.exitCode === 0 ? 'SUCCEEDED' : 'FAILED',
          detail: {
            commandId: outcome.id,
            exitCode: outcome.exitCode,
            timedOut: outcome.timedOut,
            durationMs: outcome.durationMs,
            stdoutBytes: outcome.stdoutBytes,
            stderrBytes: outcome.stderrBytes,
          },
          recordedAt: this.#now(),
        });
      },
    };
    const job: VerificationJob = {
      operationId: queued.operationId,
      verificationId: queued.verificationId,
      cancelled: false,
      promise: Promise.resolve(),
      report: null,
    };
    this.#jobs.set(queued.verificationId, job);
    job.promise = (async () => {
      try {
        job.report = await executeQueuedVerification({
          storage: this.#storage,
          runner: this.#runner,
          copiesRoot: this.#copiesRoot,
          queued,
          callbacks,
          now: this.#now,
          randomUUID: this.#randomUUID,
        });
      } catch (error) {
        // The verification service records judged failures itself; an unexpected error here means no
        // verdict was written, so the Operation must not look finished.
        this.#logger('verification Operation ended with an unexpected error', {
          verificationId: queued.verificationId,
          reason: error instanceof Error ? error.message : String(error),
        });
        this.#completeIfOpen(queued.operationId, 'RECONCILE_REQUIRED', {
          code: 'VERIFICATION_JOB_FAILED',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.#jobs.delete(queued.verificationId);
      }
    })();
    return job;
  }

  #completeIfOpen(
    operationId: string,
    state: 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED',
    result: Readonly<Record<string, unknown>>,
  ): OperationSummary | null {
    try {
      return this.#storage.completeOperation({
        operationId, state, result, completedAt: this.#now(),
      });
    } catch (error) {
      this.#logger('Operation state could not be recorded', {
        operationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Every long-command Operation belonging to one Task, newest first. */
  listForTask(projectId: string, taskId: string): readonly OperationSummary[] {
    return this.#storage.listTaskOperations(projectId, taskId);
  }

  get(projectId: string, operationId: string): OperationSummary {
    return this.#storage.getOperation(projectId, operationId);
  }

  /**
   * Cancels one long-command Operation.
   *
   * A verification is abandoned: its command group is stopped and only after that stop is confirmed
   * is the run recorded as `ERROR/CANCELLED_BY_USER`. An Agent run is stopped through the Task's own
   * cooperative pause path — the same path `task pause` uses — because cancelling an Operation must
   * not destroy the Task; `task cancel` remains the terminal command. A stop that cannot be
   * confirmed makes the Operation `RECONCILE_REQUIRED` and keeps every resource.
   */
  async cancel(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly operationId: string;
    readonly commandId: string;
    readonly actor: string;
  }): Promise<OperationCancelOutcome> {
    const requested = this.#storage.getOperation(input.projectId, input.operationId);
    if (requested.taskId !== input.taskId) {
      throw new OperationServiceError('NOT_FOUND', 'Operation does not belong to this Task');
    }
    // The marker is written before anything is stopped, so a running job can observe it at its next
    // step boundary and cannot write a verdict over the cancel.
    recordRunStep({
      storage: this.#storage,
      operationId: requested.operationId,
      stepKey: operationSteps.cancelRequested,
      step: 'CANCEL',
      state: 'INFO',
      detail: { actor: input.actor, commandId: input.commandId },
      recordedAt: this.#now(),
    });
    const operation = this.#storage.getOperation(input.projectId, input.operationId);
    if (operation.state !== 'PLANNED' && operation.state !== 'IN_PROGRESS') {
      return {
        operationId: operation.operationId,
        kind: operation.kind,
        state: operation.state,
        stop: 'ALREADY_TERMINAL',
        detail: `Operation is already ${operation.state}`,
        taskState: this.#storage.getTask(input.projectId, input.taskId)?.state ?? null,
      };
    }
    if (operation.kind === verifyTaskOperationKind) {
      return await this.#cancelVerification(operation, input.actor);
    }
    if (operation.kind === runTaskOperationKind) {
      return await this.#cancelRun(operation, input.commandId, input.actor);
    }
    throw new OperationServiceError('NOT_CANCELLABLE',
      `Operation kind ${operation.kind} has no cancel path`);
  }

  async #cancelVerification(
    operation: OperationSummary,
    actor: string,
  ): Promise<OperationCancelOutcome> {
    const verificationId = operation.aggregateId;
    const plan = this.#storage.getVerificationRun(operation.projectId, verificationId);
    const taskState = this.#storage.getTask(operation.projectId, plan.taskId)?.state ?? null;
    if (plan.state !== 'QUEUED' && plan.state !== 'RUNNING') {
      return {
        operationId: operation.operationId,
        kind: operation.kind,
        state: operation.state,
        stop: 'ALREADY_TERMINAL',
        detail: `The verification run is already ${plan.state}`,
        taskState,
      };
    }
    const job = this.#jobs.get(verificationId);
    if (job !== undefined) job.cancelled = true;
    const stop = await this.#runner.stopOwned(verificationId);
    if (!stop.stopped) {
      recordRunStep({
        storage: this.#storage,
        operationId: operation.operationId,
        stepKey: operationSteps.cancelUnconfirmed,
        step: 'CANCEL',
        state: 'FAILED',
        detail: { held: stop.held, actor },
        recordedAt: this.#now(),
      });
      const settled = this.#completeIfOpen(operation.operationId, 'RECONCILE_REQUIRED', {
        code: 'CANCEL_UNCONFIRMED',
        message: 'The command group did not confirm it stopped; the run stays RUNNING and its'
          + ' copy is retained for a human to check',
      });
      return {
        operationId: operation.operationId,
        kind: operation.kind,
        state: settled?.state ?? 'RECONCILE_REQUIRED',
        stop: 'UNCERTAIN',
        detail: 'The command group did not confirm its stop; the run was not recorded as stopped',
        taskState,
      };
    }
    const completed = this.#storage.completeVerificationRun({
      verificationId,
      state: 'ERROR',
      outcomeCode: 'CANCELLED_BY_USER',
      evidence: {
        testedCommit: plan.testedCommit,
        testedTree: plan.testedTree,
        policyVersion: plan.policyVersion,
        policyDigest: plan.policyDigest,
        mainCommit: plan.mainCommit,
        cancelledBy: actor,
        cancelledAt: this.#now(),
        stoppedProcessGroup: stop.held,
        previousState: plan.state,
      },
      eventId: this.#randomUUID(),
      completedAt: this.#now(),
    });
    const settled = this.#storage.getOperation(operation.projectId, operation.operationId);
    if (completed.state !== 'ERROR' || completed.outcomeCode !== 'CANCELLED_BY_USER') {
      // The run finished on its own before the stop; its own verdict stands.
      return {
        operationId: operation.operationId,
        kind: operation.kind,
        state: settled.state,
        stop: 'ALREADY_TERMINAL',
        detail: `The verification run had already recorded ${completed.state}`,
        taskState: this.#storage.getTask(operation.projectId, plan.taskId)?.state ?? null,
      };
    }
    return {
      operationId: operation.operationId,
      kind: operation.kind,
      state: settled.state,
      stop: 'CANCELLED',
      detail: stop.held
        ? 'The running command group was confirmed stopped and the run was cancelled'
        : 'No command was running; the queued run was cancelled',
      taskState: this.#storage.getTask(operation.projectId, plan.taskId)?.state ?? null,
    };
  }

  async #cancelRun(
    operation: OperationSummary,
    commandId: string,
    actor: string,
  ): Promise<OperationCancelOutcome> {
    const taskId = operation.taskId as string;
    const task = this.#storage.getTask(operation.projectId, taskId);
    if (task === null) throw new OperationServiceError('NOT_FOUND', 'Task was not found');
    if (task.state === 'RECOVERY_REQUIRED') {
      throw new OperationServiceError('RECONCILE_REQUIRED',
        'This Task is waiting for recovery; a repeated stop is not proven safe');
    }
    // Cancelling an Operation must not destroy the Task, so this uses the cooperative pause path
    // (resumable, and it confirms the provider process actually exited). `task cancel` remains the
    // terminal command and is untouched by this.
    const stopped = await pauseOrCancelTask({
      storage: this.#storage,
      coordinator: this.#coordinator,
      kind: 'PAUSE',
      projectId: operation.projectId,
      taskId,
      expectedVersion: task.version,
      commandId,
      actor,
      now: this.#now,
      randomUUID: this.#randomUUID,
    });
    if (stopped.stop === 'UNCERTAIN') {
      recordRunStep({
        storage: this.#storage,
        operationId: operation.operationId,
        stepKey: operationSteps.cancelUnconfirmed,
        step: 'CANCEL',
        state: 'FAILED',
        detail: { actor, detail: stopped.detail },
        recordedAt: this.#now(),
      });
      const settled = this.#completeIfOpen(operation.operationId, 'RECONCILE_REQUIRED', {
        code: 'CANCEL_UNCONFIRMED',
        message: stopped.detail,
      });
      return {
        operationId: operation.operationId,
        kind: operation.kind,
        state: settled?.state ?? 'RECONCILE_REQUIRED',
        stop: 'UNCERTAIN',
        detail: stopped.detail,
        taskState: stopped.state,
      };
    }
    const settled = this.#storage.completeOperation({
      operationId: operation.operationId,
      state: 'FAILED',
      result: {
        code: 'STOPPED_BY_USER',
        message: stopped.stop === 'TERMINAL'
          ? 'The Operation was cancelled; the Task had no running provider process'
          : 'The Operation was cancelled; the Task was paused cooperatively and can resume',
        cancelledBy: actor,
        taskState: stopped.state,
      },
      completedAt: this.#now(),
    });
    return {
      operationId: operation.operationId,
      kind: operation.kind,
      state: settled.state,
      // Only a real cooperative stop of a live provider process is reported as a pause; a Task that
      // had nothing running is not relabelled as paused.
      stop: stopped.stop === 'TERMINAL' ? 'CANCELLED' : 'PAUSED',
      detail: stopped.detail,
      taskState: stopped.state,
    };
  }

  /**
   * Tells every in-flight job to stop at its next step boundary before the owned command groups are
   * killed, so a shutdown never records a verdict for a command it killed.
   */
  beginShutdown(): void {
    this.#closing = true;
  }

  /**
   * Bounded shutdown. Jobs stop starting new commands and do not write a verdict, so a restart is
   * reconciled from the facts (the verification service records `RUNTIME_RESTARTED` at startup).
   * Provider command groups are stopped by the caller's `VerificationRunner.close()`.
   */
  async close(): Promise<void> {
    this.#closing = true;
    const jobs = [...this.#jobs.values()].map((job) => job.promise);
    if (jobs.length === 0) return;
    const settled = await Promise.race([
      Promise.allSettled(jobs).then(() => true),
      Bun.sleep(this.#shutdownGraceMs).then(() => false),
    ]);
    if (!settled) {
      this.#logger('long-command Operations did not finish before the shutdown deadline', {
        verifications: this.activeVerificationIds(),
      });
    }
  }
}
