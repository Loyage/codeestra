import { z, type ZodType } from 'zod';
import {
  intentionResolvedSignalPayloadSchema,
  intentionResolvedSubtype,
  intentionSignalPayloadSchema,
  processCompletedPayloadSchema,
  processCompletedSubtype,
  serviceMetadataSetPayloadSchema,
  taskMergeRequestedPayloadSchema,
  taskMergeRequestedSubtype,
  taskMergeSettledPayloadSchema,
  taskMergeSettledSubtype,
} from '@codeestra/contracts';
import type { ServiceKind, SignalKind } from '@codeestra/domain';
import {
  KernelStorageError,
  ServiceKernelStore,
  type ServiceView,
  type SignalView,
} from '@codeestra/storage';
import { IntentionService, createIntentionService } from './intention-service.js';

export const serviceMetadataSignalSubtype = 'SERVICE_METADATA_SET';
export const intentionSignalSubtype = 'INTENT_SUBMITTED';
// The kernel's own SIG_A subtypes are defined once, in the contracts package, and re-exported here so
// a caller of the kernel does not spell a literal a second time.
export { intentionResolvedSubtype, processCompletedSubtype, taskMergeRequestedSubtype,
  taskMergeSettledSubtype };
export const signalClaimLeaseMs = 30_000;
export const signalRetryDelaysMs = Object.freeze([1_000, 5_000, 30_000, 120_000, 300_000]);
// One initial delivery plus five automatic retries. The sixth failed delivery dead-letters.
export const maxAutomaticSignalAttempts = signalRetryDelaysMs.length + 1;

interface AcceptedSignalContract {
  readonly kind: SignalKind;
  readonly subtype: string;
  readonly payload: ZodType;
}
export interface ServiceContract {
  readonly kind: ServiceKind;
  readonly version: number;
  readonly acceptedSignals: readonly AcceptedSignalContract[];
  readonly childKinds: readonly ServiceKind[];
  readonly acceptsPrompt: boolean;
}

/** Static per-kind contract registry. Database content never invents commands or Signal subtypes. */
export class ServiceContractRegistry {
  readonly contracts: ReadonlyMap<ServiceKind, ServiceContract>;

  constructor() {
    const metadata: AcceptedSignalContract = {
      kind: 'SIG_A', subtype: serviceMetadataSignalSubtype, payload: serviceMetadataSetPayloadSchema,
    };
    const intention: AcceptedSignalContract = {
      kind: 'SIG_P', subtype: intentionSignalSubtype, payload: intentionSignalPayloadSchema,
    };
    // A Process reports its own facts through its parent Service: completion (S5) and the structured
    // interpretation of an intention (S6). A Process's parent is always a ROOT, PROJECT or TASK
    // Service; Scheduler and Attention supervise no Process and must not accept either subtype.
    const completed: AcceptedSignalContract = {
      kind: 'SIG_A', subtype: processCompletedSubtype, payload: processCompletedPayloadSchema,
    };
    const resolvedIntention: AcceptedSignalContract = {
      kind: 'SIG_A', subtype: intentionResolvedSubtype,
      payload: intentionResolvedSignalPayloadSchema,
    };
    // S8: a Task result asks its Project for integration, and the Project answers the Task Service.
    // The request is accepted by PROJECT Services only (a Task Service asks its own parent), and the
    // settle notification is accepted by TASK Services only (it is about one Task's projection).
    const mergeRequested: AcceptedSignalContract = {
      kind: 'SIG_A', subtype: taskMergeRequestedSubtype, payload: taskMergeRequestedPayloadSchema,
    };
    const mergeSettled: AcceptedSignalContract = {
      kind: 'SIG_A', subtype: taskMergeSettledSubtype, payload: taskMergeSettledPayloadSchema,
    };
    const entries: ServiceContract[] = [
      { kind: 'ROOT', version: 1, acceptedSignals: [metadata, intention, completed, resolvedIntention],
        childKinds: ['SCHEDULER', 'ATTENTION', 'PROJECT'], acceptsPrompt: true },
      { kind: 'SCHEDULER', version: 1, acceptedSignals: [metadata],
        childKinds: [], acceptsPrompt: false },
      { kind: 'ATTENTION', version: 1, acceptedSignals: [metadata],
        childKinds: [], acceptsPrompt: false },
      { kind: 'PROJECT', version: 1,
        acceptedSignals: [metadata, intention, completed, resolvedIntention, mergeRequested],
        childKinds: ['TASK'], acceptsPrompt: true },
      { kind: 'TASK', version: 1,
        acceptedSignals: [metadata, intention, completed, resolvedIntention, mergeSettled],
        childKinds: [], acceptsPrompt: true },
    ];
    this.contracts = new Map(entries.map((entry) => [entry.kind, Object.freeze(entry)]));
  }

  contract(service: ServiceView): ServiceContract {
    const contract = this.contracts.get(service.kind);
    if (contract === undefined) throw new KernelStorageError('SERVICE_CONTRACT_NOT_FOUND',
      `No contract is registered for ${service.kind}`);
    return contract;
  }

  validate(input: { readonly service: ServiceView; readonly kind: SignalKind;
    readonly subtype: string; readonly contractVersion: number; readonly payload: unknown }): unknown {
    const contract = this.contract(input.service);
    if (input.contractVersion !== contract.version || input.contractVersion !== input.service.contractVersion) {
      throw new KernelStorageError('SERVICE_CONTRACT_VERSION_UNSUPPORTED',
        `Service contract version ${input.contractVersion} is not ${contract.version}`);
    }
    const accepted = contract.acceptedSignals.find((candidate) => candidate.kind === input.kind
      && candidate.subtype === input.subtype);
    if (accepted === undefined) {
      throw new KernelStorageError('SIGNAL_NOT_ACCEPTED',
        `${input.service.kind} does not accept ${input.kind}/${input.subtype}`);
    }
    const parsed = accepted.payload.safeParse(input.payload);
    if (!parsed.success) {
      throw new KernelStorageError('INVALID_SIGNAL_PAYLOAD', z.prettifyError(parsed.error));
    }
    return parsed.data;
  }
}

export interface SignalDispatcherOptions {
  readonly store: ServiceKernelStore;
  readonly contracts: ServiceContractRegistry;
  readonly bootId: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  /**
   * The intention resolver. Absent means the dispatcher builds the production one from its store on
   * first use, so the Runtime bootstrap does not have to hand it over (S6 lane contract §1 keeps
   * `main.ts` out of this lane's reach); a test can supply its own.
   */
  readonly intention?: IntentionService;
  /**
   * S8 (ADR-0070 D07): the Project-managed integration handler. It is injected rather than built here
   * because it owns Git worktrees, verification copies and the operation ledger — none of which the
   * dispatcher may reach. When it is absent, a `TASK_MERGE_REQUESTED` Signal is refused with
   * `SIGNAL_HANDLER_NOT_FOUND` instead of being silently accepted.
   */
  readonly integration?: MergeRequestHandler;
}

/** The one method the dispatcher needs from the managed integration service (S8). */
export interface MergeRequestHandler {
  handleMergeRequested(input: {
    readonly targetServiceId: string; readonly idempotencyKey: string;
    readonly correlationId: string; readonly payload: unknown;
  }): { readonly item: { readonly id: string; readonly state: string }; readonly created: boolean };
  /**
   * The Task integration projection a settle notification must agree with, or `null` when the Task
   * has none. The dispatcher does not read the managed-integration tables itself: the same handler
   * that wrote the projection is the one that can say whether a notification describes it.
   */
  settledProjection(taskId: string): { readonly state: string; readonly version: number } | null;
}

/** Event-woken plus periodically reconciled dispatcher; no Service owns a busy-loop. */
export class SignalDispatcher {
  readonly #store: ServiceKernelStore;
  readonly #contracts: ServiceContractRegistry;
  readonly #bootId: string;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  #dispatching = false;
  #intention: IntentionService | null;
  readonly #integration: MergeRequestHandler | null;

  constructor(options: SignalDispatcherOptions) {
    this.#store = options.store;
    this.#contracts = options.contracts;
    this.#bootId = options.bootId;
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#intention = options.intention ?? null;
    this.#integration = options.integration ?? null;
  }

  #intentionService(): IntentionService {
    this.#intention ??= createIntentionService(this.#store);
    return this.#intention;
  }

  /**
   * Settles a kernel Signal whose handler produced its effect before acknowledging it (the merge
   * request is already a durable queue item when this runs), so the two writes are one transaction.
   */
  #acknowledgeKernelSignal(signalId: string, subtype: string): void {
    const signal = this.#store.getSignal(signalId);
    this.#store.acknowledgeKernelSignal({ signalId,
      effect: { type: subtype, idempotencyKey: signal.idempotencyKey },
      now: this.#now(), eventId: this.#randomUUID() });
  }

  send(input: {
    readonly signalId: string; readonly kind: SignalKind; readonly subtype: string;
    readonly sourceServiceId: string | null; readonly sourceProcessId: string | null;
    readonly targetServiceId: string; readonly contractVersion: number; readonly payload: unknown;
    readonly idempotencyKey: string; readonly correlationId: string; readonly causationId: string | null;
    readonly priority: number;
  }): { readonly signal: SignalView; readonly created: boolean } {
    const service = this.#store.getService(input.targetServiceId);
    const payload = this.#contracts.validate({ service, kind: input.kind, subtype: input.subtype,
      contractVersion: input.contractVersion, payload: input.payload });
    const createdAt = this.#now();
    return this.#store.enqueueSignal({ id: input.signalId, kind: input.kind, subtype: input.subtype,
      sourceServiceId: input.sourceServiceId, sourceProcessId: input.sourceProcessId,
      targetServiceId: input.targetServiceId, contractVersion: input.contractVersion, payload,
      idempotencyKey: input.idempotencyKey, correlationId: input.correlationId,
      causationId: input.causationId, priority: input.priority, createdAt,
      eventId: this.#randomUUID() });
  }

  /** Claims and settles every currently due Signal, bounded so one wake cannot starve commands. */
  dispatchAvailable(limit = 100): number {
    if (this.#dispatching) return 0;
    this.#dispatching = true;
    try {
      const now = this.#now();
      this.#store.reconcileExpiredClaims({ now, eventId: this.#randomUUID });
      let settled = 0;
      for (; settled < limit; settled += 1) {
        const claimed = this.#store.claimNextSignal({ bootId: this.#bootId, now: this.#now(),
          leaseMs: signalClaimLeaseMs, eventId: this.#randomUUID() });
        if (claimed === null) break;
        this.#handleClaimed(claimed);
      }
      return settled;
    } finally {
      this.#dispatching = false;
    }
  }

  #handleClaimed(signal: SignalView): void {
    try {
      const service = this.#store.getService(signal.targetServiceId);
      const payload = this.#contracts.validate({ service, kind: signal.kind, subtype: signal.subtype,
        contractVersion: signal.contractVersion, payload: signal.payload });
      const now = this.#now();
      if (signal.kind === 'SIG_A' && signal.subtype === serviceMetadataSignalSubtype) {
        const metadata = serviceMetadataSetPayloadSchema.parse(payload);
        this.#store.acknowledgeMetadataSignal({ signalId: signal.id,
          namespace: metadata.namespace, key: metadata.key, value: metadata.value,
          expectedVersion: metadata.expectedVersion, actor: 'signal-dispatcher', now,
          eventIds: [this.#randomUUID(), this.#randomUUID()] });
        return;
      }
      if (signal.kind === 'SIG_A' && signal.subtype === intentionResolvedSubtype) {
        // The handler owns the whole outcome vocabulary, including the `CREATE_TASK` boundary it
        // refuses by name; the registry only checked that the envelope is well formed.
        this.#intentionService().resolve({ signalId: signal.id,
          targetServiceId: signal.targetServiceId, idempotencyKey: signal.idempotencyKey,
          correlationId: signal.correlationId, causationId: signal.causationId,
          payload: signal.payload });
        return;
      }
      if (signal.kind === 'SIG_A' && signal.subtype === processCompletedSubtype) {
        const completed = processCompletedPayloadSchema.parse(payload);
        this.#store.completeProcess({ signalId: signal.id, processId: completed.processId,
          outcome: completed.outcome, expectedVersion: completed.expectedVersion,
          summary: completed.summary, now, eventIds: [this.#randomUUID(), this.#randomUUID()] });
        return;
      }
      if (signal.kind === 'SIG_A' && signal.subtype === taskMergeRequestedSubtype) {
        const integration = this.#integration;
        if (integration === null) {
          throw new KernelStorageError('SIGNAL_HANDLER_NOT_FOUND',
            'This Runtime has no managed integration handler, so a merge request cannot be queued');
        }
        // The handler owns the whole precondition set (current revision, captured result commit and a
        // PASSED Task verification run for that exact commit); the registry only checked the envelope.
        integration.handleMergeRequested({ targetServiceId: signal.targetServiceId,
          idempotencyKey: signal.idempotencyKey, correlationId: signal.correlationId,
          payload: signal.payload });
        this.#acknowledgeKernelSignal(signal.id, signal.subtype);
        return;
      }
      if (signal.kind === 'SIG_A' && signal.subtype === taskMergeSettledSubtype) {
        const settled = taskMergeSettledPayloadSchema.parse(payload);
        const integration = this.#integration;
        if (integration === null) {
          throw new KernelStorageError('SIGNAL_HANDLER_NOT_FOUND',
            'This Runtime has no managed integration handler, so a settle notification cannot be'
            + ' confirmed');
        }
        const projection = integration.settledProjection(settled.taskId);
        if (projection === null || projection.version !== settled.projectionVersion
          || projection.state !== settled.state) {
          throw new KernelStorageError('SIGNAL_EFFECT_CONFLICT',
            `Task ${settled.taskId} does not hold the integration projection this notification`
            + ' describes, so the Task Service cannot confirm it');
        }
        this.#store.acknowledgeKernelSignal({ signalId: signal.id,
          effect: { type: 'TASK_MERGE_SETTLED', taskId: settled.taskId,
            queueItemId: settled.queueItemId, state: settled.state,
            integrationOid: settled.integrationOid, projectionVersion: settled.projectionVersion },
          now, eventId: this.#randomUUID() });
        return;
      }
      if (signal.kind === 'SIG_P' && signal.subtype === intentionSignalSubtype) {
        const intention = intentionSignalPayloadSchema.parse(payload);
        this.#store.acknowledgeIntentionSignal({ signalId: signal.id,
          processId: this.#randomUUID(), text: intention.text, adapterId: intention.adapterId,
          now, eventIds: [this.#randomUUID(), this.#randomUUID()] });
        return;
      }
      throw new KernelStorageError('SIGNAL_HANDLER_NOT_FOUND',
        `No handler is registered for ${signal.kind}/${signal.subtype}`);
    } catch (error) {
      const storageError = error instanceof KernelStorageError ? error : null;
      // A handler that declares its refusal permanent (`retryable: false`, the default for the S8
      // managed-integration handler) is dead-lettered on the first attempt: retrying "this Task does
      // not exist" five times over ten minutes would only delay the stable code reaching the caller.
      // Anything else keeps the historic behaviour and is retried with the bounded backoff.
      const declared = (error as { readonly retryable?: boolean }).retryable;
      const retryable = storageError !== null ? storageError.retryable : declared !== false;
      const attempt = signal.automaticAttempts;
      const deadLetter = !retryable || attempt >= maxAutomaticSignalAttempts;
      const delay = signalRetryDelaysMs[Math.min(Math.max(attempt - 1, 0),
        signalRetryDelaysMs.length - 1)] as number;
      // The stable code is preserved from any handler that carries one (wherever it is defined), so a
      // refusal reads as `TASK_NOT_FOUND` rather than the generic bucket a reader cannot act on.
      const declaredCode = (error as { readonly code?: string }).code;
      this.#store.failClaimedSignal({ signalId: signal.id,
        code: storageError?.code ?? declaredCode ?? 'SIGNAL_HANDLER_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryAt: deadLetter ? null : this.#now() + delay, deadLetter,
        now: this.#now(), eventId: this.#randomUUID() });
    }
  }
}
