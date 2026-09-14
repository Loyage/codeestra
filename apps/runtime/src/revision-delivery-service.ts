import { createHash } from 'node:crypto';
import type { AgentSessionRef } from '@codeestra/contracts';
import {
  Phase1Database,
  type StoredConstraint,
  type TaskRevisionCreation,
  type TaskRevisionDeliveryAttemptRecord,
  type TaskRevisionDeliveryChannel,
  type TaskRevisionDeliveryRecord,
  type TaskRevisionSummary,
  type TaskSummary,
} from '@codeestra/storage';
import type { AdapterRegistry } from './adapter-registry.js';
import { AgentRuntimeCoordinator, deriveCommandId } from './agent-runtime-service.js';
import { withDeadline } from './lifecycle.js';
import { pauseOrCancelTask, resumePausedTask } from './task-control-service.js';

export class RevisionDeliveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RevisionDeliveryError';
  }
}

/**
 * The Runtime-side port an Adapter must expose to carry a revision into a *running* conversation.
 *
 * It is deliberately all-or-nothing: an Adapter that reports
 * `capabilities.revisionAcknowledgement === 'SUPPORTED'` must also implement this method, and an
 * Adapter that does not implement it is recorded as `CHANNEL_UNSUPPORTED` even if its capability
 * string claims otherwise. The Pi Adapter reports `UNSUPPORTED` (measured in FOUNDATION-040: Pi has
 * no reliable revision acknowledgement), so no Pi session is ever claimed to have been updated.
 */
export interface RevisionDeliveryPort {
  applyRevision(request: {
    readonly session: AgentSessionRef;
    readonly executionId: string;
    readonly revision: {
      readonly id: string;
      readonly specification: string;
      readonly constraints: readonly StoredConstraint[];
    };
  }): Promise<{
    readonly acknowledged: boolean;
    /** Structured proof of the acknowledgement; required when `acknowledged` is true. */
    readonly evidenceRef?: string;
    readonly detail?: string;
  }>;
}

export function supportsRevisionDelivery(adapter: object): adapter is RevisionDeliveryPort {
  return 'applyRevision' in adapter && typeof adapter.applyRevision === 'function';
}

export interface RevisionDeliveryAttemptOutcome {
  readonly deliveryId: string;
  readonly revisionId: string;
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly incarnationId: string | null;
  readonly channel: TaskRevisionDeliveryChannel | null;
  readonly state: TaskRevisionDeliveryRecord['state'];
  readonly satisfied: boolean;
  readonly attempt: TaskRevisionDeliveryAttemptRecord | null;
  /** The Adapter's reported capability when one was probed; null when none was needed. */
  readonly capability: string | null;
  readonly detail: string;
}

export interface RevisionDeliveryListItem extends TaskRevisionDeliveryRecord {
  /** True while an attempt is recorded as in flight and the Runtime can still conclude it. */
  readonly attemptInFlight: boolean;
}

export interface RevisionDeliveryServiceOptions {
  readonly storage: Phase1Database;
  readonly registry: AdapterRegistry;
  readonly coordinator: AgentRuntimeCoordinator;
  /** How long a conversation-channel acknowledgement may take before it is a recorded timeout. */
  readonly deliveryDeadlineMs?: number;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly logger?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

export interface CreateRevisionResult {
  readonly revision: TaskRevisionCreation;
  readonly delivery: RevisionDeliveryAttemptOutcome | null;
  readonly task: TaskSummary;
}

export interface ResolveDeliveryResult {
  readonly outcome: 'SUPERSEDED_BY_RESTART' | 'ALREADY_SATISFIED' | 'RESOLVED' | 'UNSATISFIED'
    | 'RECOVERY_REQUIRED';
  readonly delivery: TaskRevisionDeliveryRecord;
  readonly taskState: string;
  readonly taskVersion: number;
  readonly successorExecutionId: string | null;
  readonly predecessorExecutionId: string | null;
  readonly detail: string;
}

export interface RevisionDeliveryStartupReconcileResult {
  readonly deliveryId: string;
  readonly attemptId: string;
  readonly outcome: 'TIMED_OUT' | 'RECOVERY_REQUIRED';
  readonly detail: string;
}

function payloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Owns the Runtime side of Task revision delivery (PROJECT_SPEC §2.11, ADR-0028).
 *
 * The service never decides that a revision was applied because a message was sent. Every attempt it
 * makes is written to an append-only ledger with the channel, the Execution/Session/incarnation it
 * was aimed at, and the fact it produced; an Adapter that cannot acknowledge is recorded as
 * `CHANNEL_UNSUPPORTED` and the honest disposition is the ADR-0001-era stop-and-restart, whose proof
 * is the successor Execution row (checked against the delivery's revision inside one transaction).
 */
export class RevisionDeliveryService {
  readonly #storage: Phase1Database;
  readonly #registry: AdapterRegistry;
  readonly #coordinator: AgentRuntimeCoordinator;
  readonly #deliveryDeadlineMs: number;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #logger: (message: string, detail?: Readonly<Record<string, unknown>>) => void;

  constructor(options: RevisionDeliveryServiceOptions) {
    this.#storage = options.storage;
    this.#registry = options.registry;
    this.#coordinator = options.coordinator;
    this.#deliveryDeadlineMs = options.deliveryDeadlineMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#logger = options.logger ?? (() => {});
  }

  /**
   * Appends a revision and, when an Execution is holding the Task, records and immediately attempts
   * the delivery requirement. The revision itself never pauses or restarts anything: what must happen
   * to a running Agent is the delivery's business, and an unconfirmed revision simply blocks the
   * result commit (`executions.applied_revision_id` still points at the old revision).
   */
  async createRevision(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly commandId: string;
    readonly specification?: string;
    readonly constraints: readonly StoredConstraint[];
    readonly reason: string;
    readonly actor: string;
  }): Promise<CreateRevisionResult> {
    const task = this.#storage.getTask(input.projectId, input.taskId);
    if (task === null) throw new RevisionDeliveryError('NOT_FOUND', 'Task was not found');
    if (task.version !== input.expectedVersion) {
      throw new RevisionDeliveryError('CONCURRENT_MODIFICATION',
        `Task is at version ${task.version}, not ${input.expectedVersion}`);
    }
    if (input.specification === undefined && input.constraints.length === 0) {
      throw new RevisionDeliveryError('INVALID_REVISION',
        'A revision must change the specification or add at least one constraint');
    }
    const constraints = input.specification === undefined
      ? mergeConstraints(task.currentRevision.constraints, input.constraints)
      : [...input.constraints];
    const specification = input.specification ?? task.currentRevision.specification;
    const revisionId = this.#randomUUID();
    const deliveryId = this.#randomUUID();
    const revision = this.#storage.createTaskRevision({
      projectId: input.projectId,
      taskId: input.taskId,
      expectedVersion: input.expectedVersion,
      commandId: input.commandId,
      payloadHash: payloadHash({
        command: 'task.revision.create',
        projectId: input.projectId,
        taskId: input.taskId,
        expectedVersion: input.expectedVersion,
        specification,
        constraints,
        reason: input.reason,
      }),
      intentId: this.#randomUUID(),
      revisionId,
      deliveryId,
      intentEventId: this.#randomUUID(),
      revisionEventId: this.#randomUUID(),
      deliveryEventId: this.#randomUUID(),
      specification,
      constraints,
      kind: input.specification === undefined ? 'ADD_CONSTRAINT' : 'AMEND_TASK',
      reason: input.reason,
      actor: input.actor,
      createdAt: this.#now(),
    });
    const current = this.#storage.getTask(input.projectId, input.taskId);
    if (current === null) throw new RevisionDeliveryError('NOT_FOUND', 'Task disappeared after the revision');
    if (revision.deliveryId === null) return { revision, delivery: null, task: current };
    const delivery = await this.#attemptConversationDelivery({
      projectId: input.projectId,
      taskId: input.taskId,
      deliveryId: revision.deliveryId,
      commandId: input.commandId,
    });
    return { revision, delivery, task: current };
  }

  listRevisions(projectId: string, taskId: string): readonly TaskRevisionSummary[] {
    return this.#storage.listTaskRevisions(projectId, taskId);
  }

  listDeliveries(projectId: string, taskId: string): readonly RevisionDeliveryListItem[] {
    return this.#storage.listTaskRevisionDeliveries(projectId, taskId).map((delivery) => ({
      ...delivery,
      attemptInFlight: delivery.attempts.some((attempt) => attempt.state === 'IN_FLIGHT'),
    }));
  }

  getDelivery(projectId: string, deliveryId: string): RevisionDeliveryListItem {
    const delivery = this.#storage.getTaskRevisionDelivery(projectId, deliveryId);
    return { ...delivery,
      attemptInFlight: delivery.attempts.some((attempt) => attempt.state === 'IN_FLIGHT') };
  }

  /**
   * Explicit disposition of an unconfirmed revision.
   *
   * `STOP_AND_RESTART` cooperatively stops the predecessor Execution and starts a successor in the
   * same workspace; the successor is reserved with the Task's *current* revision, and the delivery is
   * only satisfied after that successor row has actually been read back with this revision. When the
   * Task has moved on to a later revision in the meantime, nothing is marked satisfied: the command
   * fails with `SUCCESSOR_REVISION_MISMATCH` and the delivery stays recorded as unsatisfied.
   *
   * `RETRY` only re-attempts the conversation channel, which for an Adapter without an acknowledgement
   * channel records `CHANNEL_UNSUPPORTED` again — it never fabricates a delivery.
   */
  async resolveDelivery(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly deliveryId: string;
    readonly action: 'STOP_AND_RESTART' | 'RETRY';
    readonly expectedVersion: number;
    readonly commandId: string;
    readonly adapterId: string;
    readonly actor: string;
  }): Promise<ResolveDeliveryResult> {
    const existing = this.#storage.getTaskRevisionDelivery(input.projectId, input.deliveryId);
    if (existing.taskId !== input.taskId) {
      throw new RevisionDeliveryError('NOT_FOUND', 'This delivery does not belong to that Task');
    }
    if (existing.satisfied) {
      const task = this.#storage.getTask(input.projectId, input.taskId);
      return {
        outcome: 'ALREADY_SATISFIED',
        delivery: existing,
        taskState: task?.state ?? 'UNKNOWN',
        taskVersion: task?.version ?? input.expectedVersion,
        successorExecutionId: existing.supersededByExecutionId,
        predecessorExecutionId: existing.executionId,
        detail: `the delivery is already ${existing.state}`,
      };
    }
    this.#closeExpiredAttempts(existing);
    if (input.action === 'RETRY') {
      const attempt = await this.#attemptConversationDelivery({
        projectId: input.projectId,
        taskId: input.taskId,
        deliveryId: input.deliveryId,
        commandId: input.commandId,
      });
      const task = this.#storage.getTask(input.projectId, input.taskId);
      const delivery = this.#storage.getTaskRevisionDelivery(input.projectId, input.deliveryId);
      return {
        outcome: delivery.satisfied ? 'RESOLVED' : 'UNSATISFIED',
        delivery,
        taskState: task?.state ?? 'UNKNOWN',
        taskVersion: task?.version ?? input.expectedVersion,
        successorExecutionId: delivery.supersededByExecutionId,
        predecessorExecutionId: delivery.executionId,
        detail: attempt.detail,
      };
    }
    return this.#stopAndRestart({ ...input, delivery: existing });
  }

  /**
   * Closes attempts a restart interrupted. This Runtime holds no provider process after a restart, so
   * an attempt recorded as in flight cannot be replayed or claimed: a passed deadline is recorded as
   * `TIMED_OUT`, and an attempt without one as `FAILED/RUNTIME_RESTARTED`. Both leave the delivery
   * unsatisfied and visibly needing a disposition.
   */
  reconcileAtStartup(): readonly RevisionDeliveryStartupReconcileResult[] {
    const results: RevisionDeliveryStartupReconcileResult[] = [];
    const now = this.#now();
    for (const attempt of this.#storage.listInFlightRevisionDeliveryAttempts()) {
      const timedOut = attempt.deadlineAt !== null && attempt.deadlineAt <= now;
      const detail = timedOut
        ? `the delivery deadline (${attempt.deadlineAt}) passed without an acknowledgement`
        : 'RUNTIME_RESTARTED: the Runtime restarted while the delivery attempt was in flight, so no'
          + ' acknowledgement was ever observed';
      try {
        this.#storage.completeRevisionDeliveryAttempt({
          projectId: attempt.projectId,
          commandId: this.#randomUUID(),
          payloadHash: payloadHash({ command: 'revision-delivery-startup', attemptId: attempt.attemptId }),
          deliveryId: attempt.deliveryId,
          attemptId: attempt.attemptId,
          state: timedOut ? 'TIMED_OUT' : 'FAILED',
          evidenceRef: null,
          errorCode: timedOut ? null : 'RUNTIME_RESTARTED',
          detail,
          eventId: this.#randomUUID(),
          completedAt: now,
        });
        results.push({ deliveryId: attempt.deliveryId, attemptId: attempt.attemptId,
          outcome: timedOut ? 'TIMED_OUT' : 'RECOVERY_REQUIRED', detail });
      } catch (error) {
        this.#logger('an in-flight revision delivery attempt could not be concluded', {
          deliveryId: attempt.deliveryId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  /**
   * One conversation-channel attempt. The Adapter is asked for its capability *at this moment*, and a
   * capability that is not `SUPPORTED`, or a missing port method, is recorded as the fact it is.
   */
  async #attemptConversationDelivery(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly deliveryId: string;
    readonly commandId: string;
  }): Promise<RevisionDeliveryAttemptOutcome> {
    const delivery = this.#storage.getTaskRevisionDelivery(input.projectId, input.deliveryId);
    if (delivery.satisfied) return this.#outcome(delivery, null, null, `already ${delivery.state}`);
    if (delivery.executionId === null) {
      throw new RevisionDeliveryError('NO_SUBJECT_EXECUTION',
        'This delivery has no Execution to carry the revision to');
    }
    const execution = this.#storage.listTaskExecutions(input.projectId, input.taskId)
      .find((candidate) => candidate.executionId === delivery.executionId);
    if (execution === undefined) {
      throw new RevisionDeliveryError('NOT_FOUND', 'The Execution of this delivery was not found');
    }
    const adapterId = execution.adapterId;
    const revision = this.#revisionFor(delivery);
    const attemptId = this.#randomUUID();
    const begun = this.#storage.beginRevisionDeliveryAttempt({
      projectId: input.projectId,
      commandId: deriveCommandId(input.commandId, `revision-delivery-attempt:${delivery.attemptCount + 1}`),
      payloadHash: payloadHash({ command: 'task.revision.delivery.attempt', deliveryId: delivery.id,
        channel: 'PROVIDER_CONVERSATION', attempt: delivery.attemptCount + 1 }),
      deliveryId: delivery.id,
      attemptId,
      channel: 'PROVIDER_CONVERSATION',
      detail: `attempting to deliver revision ${delivery.revisionId} into Execution`
        + ` ${delivery.executionId} through the provider conversation`,
      deadlineAt: this.#now() + this.#deliveryDeadlineMs,
      eventId: this.#randomUUID(),
      startedAt: this.#now(),
    });
    let capabilities: string | null = null;
    try {
      const adapter = this.#registry.resolve(adapterId);
      const probe = await adapter.probe();
      capabilities = probe.capabilities.revisionAcknowledgement;
      if (capabilities !== 'SUPPORTED') {
        return this.#complete(input, begun.id, 'CHANNEL_UNSUPPORTED',
          `capability:${capabilities}`,
          null,
          `Adapter ${adapterId} reports revisionAcknowledgement=${capabilities}; it has no channel that`
          + ' can confirm the new revision, so the Runtime does not claim the conversation was updated',
          capabilities);
      }
      if (!supportsRevisionDelivery(adapter)) {
        return this.#complete(input, begun.id, 'CHANNEL_UNSUPPORTED',
          `capability:${capabilities}:applyRevision-missing`,
          null,
          `Adapter ${adapterId} reports revisionAcknowledgement=SUPPORTED but exposes no`
          + ' applyRevision port, so no acknowledgement can be observed',
          capabilities);
      }
      if (delivery.sessionId === null) {
        return this.#complete(input, begun.id, 'FAILED', null, 'NO_SESSION',
          'The delivery has no Agent Session to deliver into', capabilities);
      }
      const sessionState = execution.session?.state ?? null;
      if (sessionState !== 'ACTIVE' && sessionState !== 'WAITING_FOR_USER') {
        // A revision can only be carried into a *live* conversation. Recording this as a channel fact
        // (instead of calling into a dead session) is what keeps the stop-and-restart path the honest
        // one for a Session that already ended its turn.
        return this.#complete(input, begun.id, 'CHANNEL_UNSUPPORTED',
          `session:${sessionState ?? 'MISSING'}`,
          null,
          `the Agent Session is ${sessionState ?? 'not recorded'}, so there is no live conversation to`
          + ' carry the revision into; a successor Execution is needed instead',
          capabilities);
      }
      const session: AgentSessionRef = {
        id: delivery.sessionId,
        executionId: delivery.executionId,
        adapterId,
        ...(execution.session?.providerSessionId === null || execution.session?.providerSessionId === undefined
          ? {} : { providerSessionId: execution.session.providerSessionId }),
      };
      const outcome = await withDeadline(adapter.applyRevision({
        session,
        executionId: delivery.executionId,
        revision,
      }), this.#deliveryDeadlineMs);
      if (!outcome.settled) {
        return this.#complete(input, begun.id, 'TIMED_OUT', null, null,
          `no acknowledgement arrived within ${this.#deliveryDeadlineMs}ms`, capabilities);
      }
      if (!outcome.value.acknowledged) {
        return this.#complete(input, begun.id, 'UNACKNOWLEDGED', null, null,
          outcome.value.detail ?? 'the Adapter reported that the revision was not applied',
          capabilities);
      }
      const evidenceRef = outcome.value.evidenceRef;
      if (typeof evidenceRef !== 'string' || evidenceRef.trim().length === 0) {
        return this.#complete(input, begun.id, 'UNACKNOWLEDGED', null, 'MISSING_ACK_EVIDENCE',
          'the Adapter claimed an acknowledgement without structured evidence, which is not accepted'
          + ' as a delivery', capabilities);
      }
      return this.#complete(input, begun.id, 'ACKNOWLEDGED', evidenceRef, null,
        outcome.value.detail ?? `acknowledged by ${adapterId}`, capabilities);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'REVISION_DELIVERY_FAILED';
      return this.#complete(input, begun.id, 'FAILED', null, code,
        error instanceof Error ? error.message : String(error), capabilities);
    }
  }

  /**
   * The ADR-0001-era fallback, made factual: stop the Execution that cannot be confirmed on the new
   * revision, start a successor in the same workspace, and satisfy the delivery only from the
   * successor's recorded revision.
   */
  async #stopAndRestart(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly deliveryId: string;
    readonly expectedVersion: number;
    readonly commandId: string;
    readonly adapterId: string;
    readonly actor: string;
    readonly delivery: TaskRevisionDeliveryRecord;
  }): Promise<ResolveDeliveryResult> {
    const task = this.#storage.getTask(input.projectId, input.taskId);
    if (task === null) throw new RevisionDeliveryError('NOT_FOUND', 'Task was not found');
    if (task.version !== input.expectedVersion) {
      throw new RevisionDeliveryError('CONCURRENT_MODIFICATION',
        `Task is at version ${task.version}, not ${input.expectedVersion}`);
    }
    if (task.currentRevision.id !== input.delivery.revisionId) {
      // The successor would be reserved with a later revision, so this delivery can never be
      // satisfied by a restart. Nothing is recorded as satisfied and the caller sees why.
      throw new RevisionDeliveryError('SUCCESSOR_REVISION_MISMATCH',
        `The Task has moved on to revision ${task.currentRevision.id}; a successor Execution would`
        + ` apply that revision, not the unconfirmed ${input.delivery.revisionId}`);
    }
    const attemptId = this.#randomUUID();
    this.#storage.beginRevisionDeliveryAttempt({
      projectId: input.projectId,
      commandId: deriveCommandId(input.commandId, 'revision-delivery-restart-attempt'),
      payloadHash: payloadHash({ command: 'task.revision.delivery.resolve', deliveryId: input.deliveryId,
        action: 'STOP_AND_RESTART' }),
      deliveryId: input.deliveryId,
      attemptId,
      channel: 'STOP_AND_RESTART',
      detail: 'stopping the Execution that cannot be confirmed on the new revision and starting a'
        + ' successor recorded with it',
      deadlineAt: null,
      eventId: this.#randomUUID(),
      startedAt: this.#now(),
    });
    const held = this.#storage.listTaskExecutions(input.projectId, input.taskId)
      .find((execution) => execution.resourceHeld) ?? null;
    if (held !== null) {
      const stopped = await pauseOrCancelTask({
        storage: this.#storage,
        coordinator: this.#coordinator,
        kind: 'PAUSE',
        projectId: input.projectId,
        taskId: input.taskId,
        expectedVersion: task.version,
        commandId: deriveCommandId(input.commandId, 'revision-delivery-pause'),
        actor: input.actor,
      });
      if (stopped.stop === 'UNCERTAIN') {
        this.#failAttempt(input, attemptId, 'STOP_UNCONFIRMED', stopped.detail);
        const current = this.#storage.getTask(input.projectId, input.taskId);
        return {
          outcome: 'RECOVERY_REQUIRED',
          delivery: this.#storage.getTaskRevisionDelivery(input.projectId, input.deliveryId),
          taskState: current?.state ?? 'UNKNOWN',
          taskVersion: current?.version ?? task.version,
          successorExecutionId: null,
          predecessorExecutionId: held.executionId,
          detail: `the predecessor provider process could not be confirmed stopped: ${stopped.detail}`,
        };
      }
    }
    const paused = this.#storage.getTask(input.projectId, input.taskId);
    if (paused === null) throw new RevisionDeliveryError('NOT_FOUND', 'Task disappeared during the stop');
    if (paused.state === 'RECOVERY_REQUIRED') {
      this.#failAttempt(input, attemptId, 'RECONCILE_REQUIRED',
        'the Task entered RECOVERY_REQUIRED during the stop');
      return {
        outcome: 'RECOVERY_REQUIRED',
        delivery: this.#storage.getTaskRevisionDelivery(input.projectId, input.deliveryId),
        taskState: paused.state,
        taskVersion: paused.version,
        successorExecutionId: null,
        predecessorExecutionId: held?.executionId ?? null,
        detail: 'the Task is waiting for recovery; a successor was not started',
      };
    }
    if (paused.state !== 'PAUSED') {
      this.#failAttempt(input, attemptId, 'UNEXPECTED_TASK_STATE',
        `the Task is ${paused.state} instead of PAUSED`);
      throw new RevisionDeliveryError('UNEXPECTED_TASK_STATE',
        `The Task is ${paused.state} instead of PAUSED; no successor was started`);
    }
    const resumed = await resumePausedTask({
      storage: this.#storage,
      coordinator: this.#coordinator,
      projectId: input.projectId,
      taskId: input.taskId,
      expectedVersion: paused.version,
      commandId: deriveCommandId(input.commandId, 'revision-delivery-resume'),
      adapterId: input.adapterId,
    });
    const successor = resumed.executionId === null ? null
      : this.#storage.listTaskExecutions(input.projectId, input.taskId)
        .find((execution) => execution.executionId === resumed.executionId) ?? null;
    if (successor === null) {
      this.#failAttempt(input, attemptId, 'SUCCESSOR_NOT_RECORDED',
        'no successor Execution was recorded by the resume');
      throw new RevisionDeliveryError('SUCCESSOR_NOT_RECORDED',
        'The Task was resumed but no successor Execution was recorded');
    }
    if (successor.revisionId !== input.delivery.revisionId) {
      this.#failAttempt(input, attemptId, 'SUCCESSOR_REVISION_MISMATCH',
        `the successor Execution ${successor.executionId} was recorded with revision`
        + ` ${successor.revisionId}, not ${input.delivery.revisionId}`);
      throw new RevisionDeliveryError('SUCCESSOR_REVISION_MISMATCH',
        `The successor Execution was recorded with revision ${successor.revisionId}, not`
        + ` ${input.delivery.revisionId}; the delivery stays unsatisfied`);
    }
    const resolved = this.#storage.resolveRevisionDeliveryByRestart({
      projectId: input.projectId,
      commandId: deriveCommandId(input.commandId, 'revision-delivery-resolved'),
      payloadHash: payloadHash({ command: 'task.revision.delivery.resolve', deliveryId: input.deliveryId,
        successorExecutionId: successor.executionId, revisionId: input.delivery.revisionId }),
      deliveryId: input.deliveryId,
      successorExecutionId: successor.executionId,
      attemptId,
      detail: `predecessor ${held?.executionId ?? 'none'} stopped and successor`
        + ` ${successor.executionId} was recorded with revision ${input.delivery.revisionId}`,
      eventId: this.#randomUUID(),
      resolvedAt: this.#now(),
    });
    const current = this.#storage.getTask(input.projectId, input.taskId);
    return {
      outcome: 'SUPERSEDED_BY_RESTART',
      delivery: resolved,
      taskState: current?.state ?? 'UNKNOWN',
      taskVersion: current?.version ?? paused.version,
      successorExecutionId: successor.executionId,
      predecessorExecutionId: held?.executionId ?? null,
      detail: `revision ${input.delivery.revisionId} is now recorded on successor Execution`
        + ` ${successor.executionId}`,
    };
  }

  #failAttempt(
    input: { readonly projectId: string; readonly deliveryId: string },
    attemptId: string,
    code: string,
    detail: string,
  ): void {
    try {
      this.#storage.completeRevisionDeliveryAttempt({
        projectId: input.projectId,
        commandId: this.#randomUUID(),
        payloadHash: payloadHash({ command: 'revision-delivery-restart-failed', attemptId }),
        deliveryId: input.deliveryId,
        attemptId,
        state: 'FAILED',
        evidenceRef: null,
        errorCode: code,
        detail,
        eventId: this.#randomUUID(),
        completedAt: this.#now(),
      });
    } catch (error) {
      this.#logger('a failed revision delivery attempt could not be closed', {
        deliveryId: input.deliveryId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #complete(
    input: { readonly projectId: string; readonly deliveryId: string },
    attemptId: string,
    state: 'ACKNOWLEDGED' | 'UNACKNOWLEDGED' | 'CHANNEL_UNSUPPORTED' | 'TIMED_OUT' | 'FAILED',
    evidenceRef: string | null,
    errorCode: string | null,
    detail: string,
    capability: string | null,
  ): RevisionDeliveryAttemptOutcome {
    const completed = this.#storage.completeRevisionDeliveryAttempt({
      projectId: input.projectId,
      commandId: deriveCommandId(`delivery:${input.deliveryId}`, `complete:${attemptId}:${state}`),
      payloadHash: payloadHash({ command: 'task.revision.delivery.attempt.complete',
        deliveryId: input.deliveryId, attemptId, state, evidenceRef }),
      deliveryId: input.deliveryId,
      attemptId,
      state,
      evidenceRef,
      errorCode,
      detail,
      eventId: this.#randomUUID(),
      completedAt: this.#now(),
    });
    return this.#outcome(completed, completed.attempts.at(-1) ?? null, capability, detail);
  }

  #outcome(
    delivery: TaskRevisionDeliveryRecord,
    attempt: TaskRevisionDeliveryAttemptRecord | null,
    capability: string | null,
    detail: string,
  ): RevisionDeliveryAttemptOutcome {
    return {
      deliveryId: delivery.id,
      revisionId: delivery.revisionId,
      executionId: delivery.executionId,
      sessionId: delivery.sessionId,
      incarnationId: delivery.incarnationId,
      channel: delivery.channel,
      state: delivery.state,
      satisfied: delivery.satisfied,
      attempt,
      capability,
      detail,
    };
  }

  /** An attempt that is still in flight past its recorded deadline is closed from that fact. */
  #closeExpiredAttempts(delivery: TaskRevisionDeliveryRecord): void {
    const now = this.#now();
    for (const attempt of delivery.attempts) {
      if (attempt.state !== 'IN_FLIGHT') continue;
      if (attempt.deadlineAt === null || attempt.deadlineAt > now) continue;
      try {
        this.#storage.completeRevisionDeliveryAttempt({
          projectId: delivery.projectId,
          commandId: this.#randomUUID(),
          payloadHash: payloadHash({ command: 'revision-delivery-timeout', attemptId: attempt.id }),
          deliveryId: delivery.id,
          attemptId: attempt.id,
          state: 'TIMED_OUT',
          evidenceRef: null,
          errorCode: null,
          detail: `the delivery deadline (${attempt.deadlineAt}) passed without an acknowledgement`,
          eventId: this.#randomUUID(),
          completedAt: now,
        });
      } catch (error) {
        this.#logger('an expired revision delivery attempt could not be closed', {
          deliveryId: delivery.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  #revisionFor(delivery: TaskRevisionDeliveryRecord): {
    readonly id: string;
    readonly specification: string;
    readonly constraints: readonly StoredConstraint[];
  } {
    const revision = this.#storage.listTaskRevisions(delivery.projectId, delivery.taskId)
      .find((candidate) => candidate.id === delivery.revisionId);
    if (revision === undefined) {
      throw new RevisionDeliveryError('NOT_FOUND', 'The revision of this delivery was not found');
    }
    return { id: revision.id, specification: revision.specification,
      constraints: revision.constraints };
  }
}

function mergeConstraints(
  existing: readonly StoredConstraint[],
  added: readonly StoredConstraint[],
): readonly StoredConstraint[] {
  const seen = new Set(existing.map((constraint) => constraint.id));
  const merged = [...existing];
  for (const constraint of added) {
    if (seen.has(constraint.id)) {
      throw new RevisionDeliveryError('INVALID_REVISION',
        `Constraint ID ${constraint.id} already exists on this Task`);
    }
    seen.add(constraint.id);
    merged.push(constraint);
  }
  return merged;
}
