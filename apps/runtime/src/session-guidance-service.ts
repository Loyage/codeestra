import { createHash } from 'node:crypto';
import type {
  AgentGuidanceContext,
  AgentSessionRef,
  ExecutionGuidanceContextView,
  SessionGuidanceDeliveryView,
  SessionGuidanceListView,
  SessionGuidanceRecordView,
  SessionGuidanceView,
} from '@codeestra/contracts';
import {
  Phase1Database,
  type ExecutionGuidanceContextRecord,
  type SessionGuidanceDeliveryAttemptRecord,
  type SessionGuidanceRecord,
} from '@codeestra/storage';
import type { AdapterRegistry } from './adapter-registry.js';
import { deriveCommandId } from './agent-runtime-service.js';
import { guidanceContextForExecution } from './guidance-context.js';
import { withDeadline } from './lifecycle.js';

export class SessionGuidanceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SessionGuidanceError';
  }
}

/**
 * The Runtime-side port an Adapter must expose to hand a guidance message into a **running**
 * conversation (ADR-0057).
 *
 * It is deliberately all-or-nothing, exactly like `RevisionDeliveryPort`: an Adapter that reports
 * `capabilities.sessionGuidance === 'SUPPORTED'` must also implement this method, and an Adapter that
 * does not is recorded as `CHANNEL_UNSUPPORTED` even if its capability string claims otherwise. The
 * Pi Adapter reports `SUPPORTED` and implements it through RPC `steer`.
 *
 * `accepted: true` means **the provider's own channel took the message** — for Pi, its RPC answered
 * successfully and (when it arrives) the provider reported the message in its steering queue. It does
 * not mean the model read it, and the port has no way to express that claim: the Runtime would have
 * nowhere honest to write it (ADR-0051).
 */
export interface GuidanceDeliveryPort {
  guide(request: {
    readonly session: AgentSessionRef;
    readonly executionId: string;
    readonly guidanceId: string;
    readonly message: string;
  }): Promise<{
    readonly accepted: boolean;
    /** Structured proof of the channel fact; required when `accepted` is true. */
    readonly evidenceRef?: string;
    readonly detail?: string;
  }>;
}

export function supportsGuidanceDelivery(adapter: object): adapter is GuidanceDeliveryPort {
  return 'guide' in adapter && typeof adapter.guide === 'function';
}

export interface SessionGuidanceServiceOptions {
  readonly storage: Phase1Database;
  readonly registry: AdapterRegistry;
  /**
   * This Runtime's own data directory. It is what turns the guidance records of a Task into an
   * absolute artifact path; a Runtime that was not given one refuses to launch an Execution for a
   * Task that has guidance instead of starting it with less input than the record says (ADR-0057).
   */
  readonly runtimeHome: string | undefined;
  /**
   * Whether a delivery to a running provider is allowed right now (ADR-0061 D08). When the Runtime's
   * global barrier is up, a guidance message is still recorded durably, but it is not handed to the
   * provider, because that could drive the next model request. Absent means "always allowed".
   */
  readonly deliveryAllowed?: () => boolean;
  /** How long the provider channel may take to accept the message before it is a recorded timeout. */
  readonly deliveryDeadlineMs?: number;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly logger?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

export interface SessionGuidanceStartupReconcileResult {
  readonly guidanceId: string;
  readonly attemptId: string;
  readonly outcome: 'FAILED';
  readonly detail: string;
}

function payloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function bodyDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}


/**
 * Owns the Runtime side of Session Guidance (PROJECT_SPEC §2.11, ADR-0010 D02, ADR-0057).
 *
 * The service never decides anything from having written bytes to a pipe. Every guidance message is
 * recorded durably first, then one attempt is made through the provider's own channel and the fact it
 * produced is written to an append-only ledger. The three facts it keeps apart are:
 *
 * - **recorded** — the row exists and will be handed to the next Execution at launch;
 * - **delivered** — the provider's channel accepted the message (it is enqueued);
 * - **read by the model** — not observable here, and no state or column claims it.
 *
 * A guidance message never creates a TaskRevision, never moves the Task's current revision and never
 * invalidates a verification run: `task amend` remains the only specification path, and it still
 * invalidates old evidence.
 */
export class SessionGuidanceService {
  readonly #storage: Phase1Database;
  readonly #registry: AdapterRegistry;
  readonly #runtimeHome: string | undefined;
  readonly #deliveryAllowed: (() => boolean) | null;
  readonly #deliveryDeadlineMs: number;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #logger: (message: string, detail?: Readonly<Record<string, unknown>>) => void;

  constructor(options: SessionGuidanceServiceOptions) {
    this.#storage = options.storage;
    this.#registry = options.registry;
    this.#runtimeHome = options.runtimeHome;
    this.#deliveryAllowed = options.deliveryAllowed ?? null;
    this.#deliveryDeadlineMs = options.deliveryDeadlineMs ?? 15_000;
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#logger = options.logger ?? (() => {});
  }

  /**
   * Records one guidance message and, when an Execution is holding the Task, immediately attempts the
   * one delivery this record gets. A Task with nothing running records the guidance and stops there:
   * the record is handed to the next Execution at launch, which is how guidance outlives the process
   * it was originally given to.
   */
  async record(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly commandId: string;
    readonly message: string;
    readonly actor: string;
  }): Promise<SessionGuidanceRecordView> {
    const created = this.#storage.recordSessionGuidance({
      projectId: input.projectId,
      taskId: input.taskId,
      commandId: input.commandId,
      payloadHash: payloadHash({ command: 'session.guidance.record', projectId: input.projectId,
        taskId: input.taskId, message: input.message }),
      guidanceId: this.#randomUUID(),
      attemptId: this.#randomUUID(),
      eventId: this.#randomUUID(),
      body: input.message,
      bodyHash: bodyDigest(input.message),
      bodyBytes: Buffer.byteLength(input.message, 'utf8'),
      actor: input.actor,
      recordedAt: this.#now(),
    });
    const task = this.#storage.getTask(input.projectId, input.taskId);
    // A replayed command reaches its own receipt, and the receipt is the *snapshot* the first call
    // returned — which for a delivery that has since concluded still says `IN_FLIGHT`. The ledger is
    // read back so a replay reports the fact that was actually recorded instead of opening a second
    // attempt on top of the first.
    const current = this.#storage.getSessionGuidance(input.projectId, created.guidance.id);
    const concluded = current.attempts.at(-1) ?? null;
    if (created.attemptId === null || (concluded !== null && concluded.state !== 'IN_FLIGHT')) {
      return {
        guidance: toGuidanceView(current),
        taskState: task?.state ?? 'UNKNOWN',
        taskVersion: created.taskVersion,
        outcome: concluded === null ? 'RECORDED' : (concluded.state === 'IN_FLIGHT'
          ? 'FAILED' : concluded.state),
        code: concluded === null || concluded.state === 'DELIVERED'
          ? null : concluded.errorCode ?? concluded.state,
        detail: concluded?.detail ?? 'No Execution was holding this Task, so the guidance is'
          + ' recorded and will be handed to the next Execution that starts',
        modelAcknowledgement: 'UNSUPPORTED',
      };
    }
    if (this.#deliveryAllowed !== null && !this.#deliveryAllowed()) {
      // ADR-0061 D08: the body is already durable and the attempt row is open; what is deferred is
      // handing it to the provider. Saying `RECORDED` is the honest answer — nothing was delivered,
      // and nothing was lost. `deliverDeferred()` concludes the open attempt after the barrier is
      // down, through the same ledger.
      return {
        guidance: toGuidanceView(current),
        taskState: task?.state ?? 'UNKNOWN',
        taskVersion: created.taskVersion,
        outcome: 'RECORDED',
        code: 'SCHEDULER_GLOBALLY_PAUSED',
        detail: 'The Runtime is globally paused, so the guidance is recorded but not handed to the'
          + ' provider yet; the open delivery attempt is concluded after `scheduler control resume`',
        modelAcknowledgement: 'UNSUPPORTED',
      };
    }
    const delivered = await this.#attemptDelivery({
      projectId: input.projectId,
      taskId: input.taskId,
      guidanceId: created.guidance.id,
      attemptId: created.attemptId,
      commandId: input.commandId,
      message: input.message,
    });
    const attempt = delivered.attempts.at(-1) ?? null;
    const outcome = attempt?.state ?? 'FAILED';
    return {
      guidance: toGuidanceView(delivered),
      taskState: task?.state ?? 'UNKNOWN',
      taskVersion: created.taskVersion,
      outcome: outcome === 'IN_FLIGHT' ? 'FAILED' : outcome,
      code: outcome === 'DELIVERED' ? null : attempt?.errorCode ?? outcome,
      detail: attempt?.detail ?? 'the delivery attempt produced no fact',
      modelAcknowledgement: 'UNSUPPORTED',
    };
  }

  /** Every guidance record of one Task, oldest first, with the attempt ledger. */
  list(projectId: string, taskId: string): SessionGuidanceListView {
    const task = this.#storage.getTask(projectId, taskId);
    if (task === null) throw new SessionGuidanceError('NOT_FOUND', 'Task was not found');
    return {
      taskId,
      taskState: task.state,
      guidance: this.#storage.listSessionGuidance(projectId, taskId).map(toGuidanceView),
      launchedWith: this.#storage.listExecutionGuidanceContexts(projectId, taskId)
        .map(toContextView),
    };
  }

  get(projectId: string, guidanceId: string): SessionGuidanceView {
    return toGuidanceView(this.#storage.getSessionGuidance(projectId, guidanceId));
  }

  /** The guidance artifact the next Execution of this Task would be launched with, if any. */
  async contextForExecution(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly executionId: string;
  }): Promise<{ readonly guidanceContext?: AgentGuidanceContext }> {
    return await guidanceContextForExecution({
      storage: this.#storage,
      runtimeHome: this.#runtimeHome,
      projectId: input.projectId,
      taskId: input.taskId,
      executionId: input.executionId,
      now: this.#now,
      randomUUID: this.#randomUUID,
    });
  }

  /**
   * Closes attempts a restart interrupted. This Runtime holds no provider process after a restart, so
   * an attempt recorded as in flight cannot be replayed or claimed: it is closed as
   * `FAILED/RUNTIME_RESTARTED`, the guidance record stays visibly unconcluded, and the record is still
   * handed to the next Execution at launch.
   */
  reconcileAtStartup(): readonly SessionGuidanceStartupReconcileResult[] {
    const results: SessionGuidanceStartupReconcileResult[] = [];
    const detail = 'RUNTIME_RESTARTED: the Runtime restarted while the guidance delivery attempt was in'
      + ' flight, so no channel fact was ever observed';
    for (const attempt of this.#storage.listInFlightSessionGuidanceDeliveries()) {
      try {
        this.#storage.completeSessionGuidanceDelivery({
          projectId: attempt.projectId,
          commandId: deriveCommandId(attempt.attemptId, 'guidance-startup-reconcile'),
          payloadHash: payloadHash({ command: 'session-guidance-startup', attemptId: attempt.attemptId }),
          guidanceId: attempt.guidanceId,
          attemptId: attempt.attemptId,
          state: 'FAILED',
          capability: null,
          evidenceRef: null,
          errorCode: 'RUNTIME_RESTARTED',
          detail,
          eventId: this.#randomUUID(),
          completedAt: this.#now(),
        });
        results.push({ guidanceId: attempt.guidanceId, attemptId: attempt.attemptId,
          outcome: 'FAILED', detail });
      } catch (error) {
        this.#logger('an in-flight session guidance delivery could not be concluded', {
          guidanceId: attempt.guidanceId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  /**
   * One attempt through the provider's own channel. The Adapter's capability is read *at this
   * moment*, and a capability that is not `SUPPORTED`, a missing port method, or a conversation that
   * is no longer live are all recorded as the facts they are — never as a delivery.
   */
  /**
   * The post-resume pass of ADR-0061 D06 step 5 for guidance: concludes every delivery attempt that
   * is still open because the global barrier deferred it.
   *
   * It reuses the ledger rather than inventing a queue: an open (`IN_FLIGHT`) attempt whose Session
   * this Runtime still holds is exactly the set of messages that were recorded but not handed over.
   * Each one goes through `#attemptDelivery`, which is capability-gated and idempotent — a delivered
   * attempt is refused by the ledger, so a resume that races a projection cannot deliver twice.
   */
  async deliverDeferred(): Promise<readonly {
    readonly guidanceId: string;
    readonly outcome: string;
    readonly code: string | null;
  }[]> {
    if (this.#deliveryAllowed !== null && !this.#deliveryAllowed()) return [];
    const results = [];
    for (const project of this.#storage.listTrustedProjects()) {
      for (const task of this.#storage.listTasks(project.id)) {
        for (const record of this.#storage.listSessionGuidance(project.id, task.id)) {
          const open = record.attempts.find((attempt) => attempt.state === 'IN_FLIGHT') ?? null;
          if (open === null) continue;
          const delivered = await this.#attemptDelivery({
            projectId: project.id,
            taskId: task.id,
            guidanceId: record.id,
            attemptId: open.id,
            commandId: deriveCommandId(open.id, 'guidance-deferred-delivery'),
            message: record.body,
          }).catch((error: unknown) => {
            this.#logger('a deferred session guidance delivery could not be attempted', {
              guidanceId: record.id,
              reason: error instanceof Error ? error.message : String(error),
            });
            return null;
          });
          if (delivered === null) continue;
          const attempt = delivered.attempts.at(-1) ?? null;
          results.push({
            guidanceId: record.id,
            outcome: attempt?.state ?? 'FAILED',
            code: attempt?.errorCode ?? null,
          });
        }
      }
    }
    return results;
  }

  async #attemptDelivery(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly guidanceId: string;
    readonly attemptId: string;
    readonly commandId: string;
    readonly message: string;
  }): Promise<SessionGuidanceRecord> {
    const record = this.#storage.getSessionGuidance(input.projectId, input.guidanceId);
    const attempt = record.attempts.find((candidate) => candidate.id === input.attemptId) ?? null;
    if (attempt === null) {
      throw new SessionGuidanceError('NOT_FOUND', 'The guidance delivery attempt was not found');
    }
    const execution = record.executionId === null ? null
      : this.#storage.listTaskExecutions(input.projectId, input.taskId)
        .find((candidate) => candidate.executionId === record.executionId) ?? null;
    if (execution === null) {
      return this.#conclude(input, 'FAILED', null, null, 'NO_SUBJECT_EXECUTION',
        'The guidance has no Execution to hand it to');
    }
    const adapterId = execution.adapterId;
    let capability: string | null = null;
    try {
      const adapter = this.#registry.resolve(adapterId);
      const probe = await adapter.probe();
      capability = probe.capabilities.sessionGuidance ?? 'MISSING';
      if (capability !== 'SUPPORTED') {
        return this.#conclude(input, 'CHANNEL_UNSUPPORTED', capability, `capability:${capability}`, null,
          `Adapter ${adapterId} reports sessionGuidance=${capability}; it has no channel that hands a`
          + ' message to a running conversation, so the guidance is recorded but nothing was'
          + ' delivered');
      }
      if (!supportsGuidanceDelivery(adapter)) {
        return this.#conclude(input, 'CHANNEL_UNSUPPORTED', capability,
          `capability:${capability}:guide-missing`, null,
          `Adapter ${adapterId} reports sessionGuidance=SUPPORTED but exposes no guide port, so no`
          + ' channel fact can be observed');
      }
      if (record.sessionId === null) {
        return this.#conclude(input, 'FAILED', capability, null, 'NO_SESSION',
          'The guidance has no Agent Session to hand it to');
      }
      const sessionState = execution.session?.state ?? null;
      if (sessionState !== 'ACTIVE' && sessionState !== 'WAITING_FOR_USER') {
        // Guidance can only enter a *live* conversation. Recording this as a channel fact, instead of
        // writing into a process that is gone, is what keeps `RECORDED` the honest state for a Task
        // whose Agent has already finished its turn.
        return this.#conclude(input, 'CHANNEL_UNSUPPORTED', capability,
          `session:${sessionState ?? 'MISSING'}`, null,
          `The Agent Session is ${sessionState ?? 'not recorded'}, so there is no live conversation to`
          + ' hand the guidance to; it stays recorded and reaches the next Execution at launch');
      }
      const session: AgentSessionRef = {
        id: record.sessionId,
        executionId: record.executionId as string,
        adapterId,
        ...(execution.session?.providerSessionId === null
          || execution.session?.providerSessionId === undefined
          ? {} : { providerSessionId: execution.session.providerSessionId }),
      };
      const outcome = await withDeadline(adapter.guide({
        session,
        executionId: record.executionId as string,
        guidanceId: input.guidanceId,
        message: input.message,
      }), this.#deliveryDeadlineMs);
      if (!outcome.settled) {
        return this.#conclude(input, 'TIMED_OUT', capability, null, null,
          `the provider channel did not accept the guidance within ${this.#deliveryDeadlineMs}ms`);
      }
      if (!outcome.value.accepted) {
        return this.#conclude(input, 'FAILED', capability, null, null,
          outcome.value.detail ?? 'the Adapter reported that the guidance was not accepted');
      }
      const evidenceRef = outcome.value.evidenceRef;
      if (typeof evidenceRef !== 'string' || evidenceRef.trim().length === 0) {
        return this.#conclude(input, 'FAILED', capability, null, 'MISSING_CHANNEL_EVIDENCE',
          'the Adapter claimed the provider accepted the guidance without naming the channel fact it'
          + ' observed, which is not accepted as a delivery');
      }
      return this.#conclude(input, 'DELIVERED', capability, evidenceRef, null,
        outcome.value.detail ?? `accepted by ${adapterId}`);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'GUIDANCE_DELIVERY_FAILED';
      return this.#conclude(input, 'FAILED', capability, null, code,
        error instanceof Error ? error.message : String(error));
    }
  }

  #conclude(
    input: { readonly projectId: string; readonly guidanceId: string; readonly attemptId: string;
      readonly commandId: string; },
    state: 'DELIVERED' | 'CHANNEL_UNSUPPORTED' | 'TIMED_OUT' | 'FAILED',
    capability: string | null,
    evidenceRef: string | null,
    errorCode: string | null,
    detail: string,
  ): SessionGuidanceRecord {
    return this.#storage.completeSessionGuidanceDelivery({
      projectId: input.projectId,
      commandId: deriveCommandId(input.commandId, `guidance-delivery:${input.attemptId}:${state}`),
      payloadHash: payloadHash({ command: 'session.guidance.delivery.complete',
        guidanceId: input.guidanceId, attemptId: input.attemptId, state, evidenceRef }),
      guidanceId: input.guidanceId,
      attemptId: input.attemptId,
      state,
      capability,
      evidenceRef,
      errorCode,
      detail,
      eventId: this.#randomUUID(),
      completedAt: this.#now(),
    });
  }
}

function toAttemptView(attempt: SessionGuidanceDeliveryAttemptRecord): SessionGuidanceDeliveryView {
  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    channel: attempt.channel,
    state: attempt.state,
    executionId: attempt.executionId,
    sessionId: attempt.sessionId,
    incarnationId: attempt.incarnationId,
    capability: attempt.capability,
    evidenceRef: attempt.evidenceRef,
    errorCode: attempt.errorCode,
    detail: attempt.detail,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
  };
}

export function toGuidanceView(record: SessionGuidanceRecord): SessionGuidanceView {
  return {
    id: record.id,
    taskId: record.taskId,
    source: record.source,
    body: record.body,
    bodyHash: record.bodyHash,
    bodyBytes: record.bodyBytes,
    actor: record.actor,
    state: record.state,
    executionId: record.executionId,
    sessionId: record.sessionId,
    incarnationId: record.incarnationId,
    evidenceRef: record.evidenceRef,
    deliveryDetail: record.deliveryDetail,
    createdAt: record.createdAt,
    deliveredAt: record.deliveredAt,
    attempts: record.attempts.map(toAttemptView),
  };
}

export function toContextView(
  record: ExecutionGuidanceContextRecord,
): ExecutionGuidanceContextView {
  return {
    executionId: record.executionId,
    guidanceIds: record.guidanceIds,
    guidanceCount: record.guidanceCount,
    contextDigest: record.contextDigest,
    contextBytes: record.contextBytes,
    recordedAt: record.recordedAt,
  };
}
