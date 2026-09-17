import { createHash } from 'node:crypto';
import {
  intentionCreateTaskRefusalCode,
  intentionCreateTaskOutcomeKind,
} from '@codeestra/contracts';
import {
  DomainError,
  assertIntentionClarificationReply,
  assertIntentionTargetVisible,
  assertResolvableIntentionProcess,
  intentionOutcomeTransitionPlan,
  parseIntentionResolvedPayload,
  type IntentionClarificationRef,
  type IntentionOutcome,
  type IntentionOutcomeKind,
  type ProcessState,
} from '@codeestra/domain';
import {
  IntentionStore,
  KernelStorageError,
  Phase1Database,
  StorageError,
  type IntentionApplication,
  type IntentionApplicationResult,
  type IntentionAuditFact,
  type IntentionProcessRecord,
  type IntentionServiceRecord,
  type IntentionTaskScope,
  type ServiceKernelStore,
} from '@codeestra/storage';

/**
 * Intention routing (ADR-0070 §8, S6 lane contract §3).
 *
 * The Runtime side of the `INTENTION_RESOLVED` `SIG_A`: it turns one structured outcome into Process
 * state, an append-only audit fact and a Signal receipt. It interprets no natural language and starts
 * no Agent — the interpretation is what the Signal already contains.
 *
 * Two facts this round states plainly rather than implying:
 *
 * 1. **The Attention index is not connected.** A `REQUEST_CLARIFICATION` becomes a kernel fact (the
 *    Process waits in `WAITING_FOR_USER` plus an `IntentionClarificationRequested` audit event), *not*
 *    an `attention_requests` row: that table's `session_id` is a non-null foreign key into
 *    `agent_sessions`, and a native `INTENTION` Process has no provider conversation at all. Bridging
 *    the two needs a schema wave, which this round does not take (ADR-0072).
 * 2. **`CREATE_TASK` is refused by name.** It is S7's write path, and the refusal carries its own
 *    stable code so the request is never dropped silently.
 */

/** The kernel facts and writes one resolution needs. `IntentionStore` implements this. */
export interface IntentionKernelPort {
  readProcess(processId: string): IntentionProcessRecord | null;
  readService(serviceId: string): IntentionServiceRecord | null;
  taskScope(taskServiceId: string): IntentionTaskScope | null;
  readReceipt(targetServiceId: string, idempotencyKey: string): { readonly effect: unknown } | null;
  lastClarification(processId: string): IntentionClarificationRef | null;
  applyOutcome(input: IntentionApplication): IntentionApplicationResult;
}

/** What recording one guidance message through the existing ledger reports. */
export interface IntentionGuidanceResult {
  readonly guidanceId: string;
  readonly outcome: 'RECORDED' | 'CHANNEL_UNSUPPORTED' | 'FAILED';
  readonly code: string | null;
  readonly detail: string;
}

export interface IntentionGuidancePort {
  /** Records through the ADR-0057 ledger. Never claims that a model read the message. */
  record(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly commandId: string;
    readonly message: string;
    readonly actor: string;
  }): IntentionGuidanceResult;
}

export interface IntentionSignalFacts {
  readonly signalId: string;
  readonly targetServiceId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload: unknown;
}

export interface IntentionResolutionView {
  readonly processId: string;
  readonly outcomeKind: IntentionOutcomeKind;
  /** `false` when this `(target, idempotency key)` already had a receipt; nothing was written again. */
  readonly applied: boolean;
  readonly effect: Readonly<Record<string, unknown>>;
}

export interface IntentionServiceOptions {
  readonly kernel: IntentionKernelPort;
  readonly guidance: IntentionGuidancePort;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

function domainRefusal<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    // The domain's codes are the stable codes a client reads; a DomainError that escaped as itself
    // would be treated as a retryable handler failure and burn five retries before dead-lettering.
    if (error instanceof DomainError) throw new KernelStorageError(error.code, error.message);
    throw error;
  }
}

/** The narrowing half of the resolvability check, so callers read a real `ProcessState` afterwards. */
function assertResolvable(process: IntentionProcessRecord):
asserts process is IntentionProcessRecord & { readonly state: ProcessState } {
  try {
    assertResolvableIntentionProcess(process);
  } catch (error) {
    if (error instanceof DomainError) throw new KernelStorageError(error.code, error.message);
    throw error;
  }
}

/** `outcome.kind` of an untrusted payload, without deciding whether the outcome is acceptable. */
export function intentionOutcomeKindOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const outcome = (payload as { readonly outcome?: unknown }).outcome;
  if (typeof outcome !== 'object' || outcome === null) return null;
  const kind = (outcome as { readonly kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : null;
}

/**
 * Refuses the one outcome kind this round names but does not implement.
 *
 * It is checked before anything else and writes nothing: the Signal goes straight to `DEAD_LETTER` with
 * `INTENTION_CREATE_TASK_UNSUPPORTED`, so a caller sees the boundary instead of a generic payload error
 * or a Process that quietly stayed `CREATED`.
 */
export function refuseCreateTaskOutcome(payload: unknown): void {
  if (intentionOutcomeKindOf(payload) !== intentionCreateTaskOutcomeKind) return;
  throw new KernelStorageError(intentionCreateTaskRefusalCode,
    'Creating a Task from an intention belongs to the S7 Project/Task Service write path (ADR-0070'
    + ' D06/D10) and is not implemented in this wave. The intention is refused explicitly: nothing was'
    + ' routed, no Task was created and no Process state was changed');
}

export class IntentionService {
  readonly #kernel: IntentionKernelPort;
  readonly #guidance: IntentionGuidancePort;
  readonly #now: () => number;
  readonly #randomUUID: () => string;

  constructor(options: IntentionServiceOptions) {
    this.#kernel = options.kernel;
    this.#guidance = options.guidance;
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  }

  resolve(input: IntentionSignalFacts): IntentionResolutionView {
    refuseCreateTaskOutcome(input.payload);
    const payload = domainRefusal(() => parseIntentionResolvedPayload(input.payload));
    // The receipt is the authority for "this exact request was already applied": a redelivery returns
    // the recorded effect instead of re-deciding anything about a Process that has since moved on.
    const receipt = this.#kernel.readReceipt(input.targetServiceId, input.idempotencyKey);
    if (receipt !== null) {
      return { processId: payload.processId, outcomeKind: payload.outcome.kind, applied: false,
        effect: asEffect(receipt.effect) };
    }
    const process = this.#kernel.readProcess(payload.processId);
    if (process === null) {
      throw new KernelStorageError('PROCESS_NOT_FOUND',
        `Intention Signal names Process ${payload.processId}, which does not exist`);
    }
    // Ownership first: the Signal was accepted by the Service it was addressed to, and only that
    // Service's own Processes may be resolved by it. Without this a Signal sent to one Project could
    // move an intention Process belonging to another (the same guard S5 uses for PROCESS_COMPLETED).
    if (process.parentServiceId !== input.targetServiceId) {
      throw new KernelStorageError('PROCESS_PARENT_MISMATCH',
        `Process ${process.processId} is not a child of Signal target Service ${input.targetServiceId}`);
    }
    assertResolvable(process);
    const parent = this.#kernel.readService(process.parentServiceId);
    if (parent === null) {
      throw new KernelStorageError('SERVICE_NOT_FOUND',
        `Parent Service ${process.parentServiceId} of Process ${process.processId} was not found`);
    }
    const replying = process.state === 'WAITING_FOR_USER';
    if (replying) {
      if (payload.outcome.kind === 'REQUEST_CLARIFICATION') {
        throw new KernelStorageError('INTENTION_CLARIFICATION_OPEN',
          `Process ${process.processId} is already waiting for an answer to its open clarification;`
          + ' answer it with a new INTENTION_RESOLVED that names the clarification in causationId');
      }
      const open = this.#kernel.lastClarification(process.processId);
      domainRefusal(() => assertIntentionClarificationReply({ open, causationId: input.causationId }));
    }
    const steps = domainRefusal(() => intentionOutcomeTransitionPlan({ state: process.state,
      expectedVersion: payload.expectedVersion, kind: payload.outcome.kind, replying }));
    const settledState = steps[steps.length - 1]?.next ?? null;
    const settledVersion = (steps[steps.length - 1]?.expectedVersion ?? payload.expectedVersion) + 1;
    // A `TYPED_COMMAND` writes the guidance ledger here, before the one atomic kernel write below.
    // Guidance and Process state live in different transactions and this does not pretend otherwise:
    // that write is idempotent on the Signal id, so a retry after a failed apply converges on the same
    // guidance row and then applies the Process state, instead of half-applying twice.
    const outcome = this.#applyOutcome({ input, process, parent, outcome: payload.outcome,
      replying, settledState, settledVersion });
    const transitions = steps.map((step) => ({ expectedVersion: step.expectedVersion,
      next: step.next, reason: step.reason, eventId: this.#randomUUID() }));
    const result = this.#kernel.applyOutcome({
      signalId: input.signalId,
      targetServiceId: input.targetServiceId,
      idempotencyKey: input.idempotencyKey,
      processId: process.processId,
      actor: 'intention-service',
      transitions,
      auditFacts: outcome.auditFacts,
      effect: outcome.effect,
      now: this.#now(),
      receiptEventId: this.#randomUUID(),
    });
    return { processId: process.processId, outcomeKind: payload.outcome.kind,
      applied: result.applied, effect: asEffect(result.effect) };
  }

  #applyOutcome(context: {
    readonly input: IntentionSignalFacts;
    readonly process: IntentionProcessRecord;
    readonly parent: IntentionServiceRecord;
    readonly outcome: IntentionOutcome;
    readonly replying: boolean;
    readonly settledState: ProcessState | null;
    readonly settledVersion: number;
  }): { readonly auditFacts: readonly IntentionAuditFact[]; readonly effect: Readonly<Record<string, unknown>> } {
    const { input, process, parent, outcome, replying, settledState, settledVersion } = context;
    const kind = outcome.kind;
    const auditFacts: IntentionAuditFact[] = [];
    const effect: Record<string, unknown> = { type: 'INTENTION_RESOLVED', processId: process.processId,
      outcomeKind: kind, processState: settledState };
    if (replying) {
      const open = this.#kernel.lastClarification(process.processId);
      auditFacts.push(this.#auditFact({ eventType: 'IntentionClarificationAnswered',
        aggregateId: process.processId, aggregateVersion: settledVersion,
        correlationId: input.correlationId, causationId: open?.clarificationId ?? null,
        payload: { processId: process.processId, requestId: open?.clarificationId ?? null,
          outcomeKind: kind, correlationId: input.correlationId, causationId: input.causationId } }));
      effect['clarificationId'] = open?.clarificationId ?? null;
    }
    if (outcome.kind === 'ROUTE') {
      const target = this.#kernel.readService(outcome.targetServiceId);
      if (target === null) {
        throw new KernelStorageError('INTENTION_TARGET_NOT_VISIBLE',
          `ROUTE target Service ${outcome.targetServiceId} does not exist`);
      }
      domainRefusal(() => assertIntentionTargetVisible({ parent, target }));
      auditFacts.push(this.#auditFact({ eventType: 'IntentionRouted',
        aggregateId: process.processId, aggregateVersion: settledVersion,
        correlationId: input.correlationId, causationId: input.signalId,
        payload: { processId: process.processId, targetServiceId: target.serviceId,
          targetServiceKind: target.kind, instruction: outcome.instruction,
          correlationId: input.correlationId, causationId: input.causationId } }));
      effect['targetServiceId'] = target.serviceId;
      effect['instruction'] = outcome.instruction;
      return { auditFacts, effect };
    }
    if (outcome.kind === 'TYPED_COMMAND') {
      const scope = this.#kernel.taskScope(outcome.targetTaskServiceId);
      if (scope === null) {
        throw new KernelStorageError('INTENTION_TARGET_NOT_VISIBLE',
          `TYPED_COMMAND target ${outcome.targetTaskServiceId} is not a Task Service with a live Task`
          + ' projection');
      }
      if (scope.holdingExecutionId !== null) {
        // The kernel dispatcher holds no provider channel: a live conversation is reached through the
        // Runtime's own Session Guidance service, which is not wired here. Refusing is the honest
        // answer — claiming a delivery this path cannot make would be the lie.
        throw new KernelStorageError('INTENTION_GUIDANCE_CHANNEL_UNAVAILABLE',
          `Task ${scope.taskId} is held by Execution ${scope.holdingExecutionId}; this kernel path has`
          + ' no provider conversation channel, so the guidance was not recorded. Record it with'
          + ` \`session guide ${scope.projectId} ${scope.taskId} <message>\`.`);
      }
      const recorded = this.#guidance.record({ projectId: scope.projectId, taskId: scope.taskId,
        commandId: input.signalId, message: outcome.message, actor: 'local-user' });
      auditFacts.push(this.#auditFact({ eventType: 'IntentionGuidanceRecorded',
        aggregateId: process.processId, aggregateVersion: settledVersion,
        correlationId: input.correlationId, causationId: input.signalId,
        payload: { processId: process.processId, taskServiceId: outcome.targetTaskServiceId,
          projectId: scope.projectId, taskId: scope.taskId, guidanceId: recorded.guidanceId,
          guidanceOutcome: recorded.outcome, command: outcome.command,
          modelAcknowledgement: 'UNSUPPORTED' } }));
      effect['command'] = outcome.command;
      effect['targetTaskServiceId'] = outcome.targetTaskServiceId;
      effect['guidanceId'] = recorded.guidanceId;
      effect['guidanceOutcome'] = recorded.outcome;
      effect['guidanceDetail'] = recorded.detail;
      // This round's kernel path records guidance through the same ledger `session guide` writes to; it
      // never claims the provider accepted or the model read anything (ADR-0051/0057).
      effect['modelAcknowledgement'] = 'UNSUPPORTED';
      return { auditFacts, effect };
    }
    const clarificationId = this.#randomUUID();
    auditFacts.push(this.#auditFact({ eventType: 'IntentionClarificationRequested',
      aggregateId: process.processId, aggregateVersion: settledVersion,
      correlationId: input.correlationId, causationId: input.signalId,
      payload: { processId: process.processId, requestId: clarificationId,
        targetServiceId: input.targetServiceId, question: outcome.question,
        options: outcome.options === null ? null : [...outcome.options],
        correlationId: input.correlationId, causationId: input.causationId } }));
    effect['requestId'] = clarificationId;
    effect['question'] = outcome.question;
    if (outcome.options !== null) effect['options'] = [...outcome.options];
    // Says out loud that this wait is a kernel fact rather than a row in the Attention index, so no
    // client waits for an `attention list` entry that cannot exist yet (ADR-0072).
    effect['attentionIndex'] = 'NOT_CONNECTED';
    effect['answerWith'] = 'signal send <target-service-id> --kind SIG_A --subtype INTENTION_RESOLVED'
      + ' --causation <requestId>';
    return { auditFacts, effect };
  }

  #auditFact(input: {
    readonly eventType: string;
    readonly aggregateId: string;
    readonly aggregateVersion: number;
    readonly correlationId: string;
    readonly causationId: string | null;
    readonly payload: Readonly<Record<string, unknown>>;
  }): IntentionAuditFact {
    return { eventId: this.#randomUUID(), eventType: input.eventType,
      aggregateType: 'Process', aggregateId: input.aggregateId,
      aggregateVersion: input.aggregateVersion, correlationId: input.correlationId,
      causationId: input.causationId, payload: input.payload };
  }
}

function asEffect(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : {};
}

function payloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function bodyDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Records Session Guidance through the ledger ADR-0057 already owns.
 *
 * The dispatcher that calls this handler is handed nothing but the kernel store, so this recorder opens
 * the same `runtime.sqlite` the Runtime already opened (one file, one schema, a second connection
 * rather than a second writer path) instead of duplicating `recordSessionGuidance`'s SQL. It is created
 * lazily: a Runtime that never resolves an intention never opens it. See ADR-0072 D02.
 *
 * It deliberately attempts **no provider delivery**. Handing a message to a live conversation needs the
 * Runtime's Adapter registry and its global-barrier state, which this call site does not have; the
 * caller refuses that case with `INTENTION_GUIDANCE_CHANNEL_UNAVAILABLE` before reaching here.
 */
export function createKernelGuidanceRecorder(kernel: ServiceKernelStore): IntentionGuidancePort {
  let storage: Phase1Database | null = null;
  const attach = (): Phase1Database => {
    if (storage !== null) return storage;
    const filename = kernel.sqlite.filename;
    if (typeof filename !== 'string' || filename.length === 0 || filename === ':memory:') {
      throw new KernelStorageError('INTENTION_GUIDANCE_UNAVAILABLE',
        'This Runtime has no on-disk runtime database, so guidance cannot be recorded through its ledger');
    }
    storage = new Phase1Database(filename);
    return storage;
  };
  return {
    record: (input) => {
      try {
        const database = attach();
        const created = database.recordSessionGuidance({
          projectId: input.projectId,
          taskId: input.taskId,
          commandId: input.commandId,
          payloadHash: payloadHash({ command: 'session.guidance.record', projectId: input.projectId,
            taskId: input.taskId, message: input.message }),
          guidanceId: crypto.randomUUID(),
          attemptId: crypto.randomUUID(),
          eventId: crypto.randomUUID(),
          body: input.message,
          bodyHash: bodyDigest(input.message),
          bodyBytes: Buffer.byteLength(input.message, 'utf8'),
          actor: input.actor,
          recordedAt: Date.now(),
        });
        if (created.attemptId === null) {
          return { guidanceId: created.guidance.id, outcome: 'RECORDED', code: null,
            detail: 'No Execution was holding this Task, so the guidance is recorded durably and will'
              + ' be handed to the next Execution that starts (ADR-0057); no provider was told anything' };
        }
        // A live Execution appeared between the caller's check and this write. This path holds no
        // provider channel, so the attempt is concluded with exactly that fact instead of being left
        // open or reported as a delivery.
        database.completeSessionGuidanceDelivery({
          projectId: input.projectId, commandId: crypto.randomUUID(),
          payloadHash: payloadHash({ command: 'intention.guidance.channel', guidanceId: created.guidance.id }),
          guidanceId: created.guidance.id, attemptId: created.attemptId,
          state: 'CHANNEL_UNSUPPORTED', capability: null, evidenceRef: null,
          errorCode: 'INTENTION_GUIDANCE_CHANNEL_UNAVAILABLE',
          detail: 'The intention resolver holds no provider conversation channel; the guidance is'
            + ' recorded and the attempt is concluded as unsupported rather than claimed as delivered',
          eventId: crypto.randomUUID(), completedAt: Date.now(),
        });
        return { guidanceId: created.guidance.id, outcome: 'CHANNEL_UNSUPPORTED',
          code: 'INTENTION_GUIDANCE_CHANNEL_UNAVAILABLE',
          detail: 'The guidance is recorded durably but was not handed to any provider conversation' };
      } catch (error) {
        if (error instanceof KernelStorageError) throw error;
        if (error instanceof StorageError) {
          throw new KernelStorageError('INTENTION_GUIDANCE_UNAVAILABLE',
            `The guidance ledger refused this record: ${error.code}: ${error.message}`);
        }
        throw error;
      }
    },
  };
}

/** The production kernel port for the intention handler and the Runtime handler that uses it. */
export function createIntentionService(kernel: ServiceKernelStore): IntentionService {
  return new IntentionService({ kernel: new IntentionStore(kernel),
    guidance: createKernelGuidanceRecorder(kernel) });
}
