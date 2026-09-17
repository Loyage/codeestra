import { z, type ZodType } from 'zod';
import { intentionSignalPayloadSchema, serviceMetadataSetPayloadSchema } from '@codeestra/contracts';
import type { ServiceKind, SignalKind } from '@codeestra/domain';
import {
  KernelStorageError,
  ServiceKernelStore,
  type ServiceView,
  type SignalView,
} from '@codeestra/storage';

export const serviceMetadataSignalSubtype = 'SERVICE_METADATA_SET';
export const intentionSignalSubtype = 'INTENT_SUBMITTED';
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
    const entries: ServiceContract[] = [
      { kind: 'ROOT', version: 1, acceptedSignals: [metadata, intention],
        childKinds: ['SCHEDULER', 'ATTENTION', 'PROJECT'], acceptsPrompt: true },
      { kind: 'SCHEDULER', version: 1, acceptedSignals: [metadata],
        childKinds: [], acceptsPrompt: false },
      { kind: 'ATTENTION', version: 1, acceptedSignals: [metadata],
        childKinds: [], acceptsPrompt: false },
      { kind: 'PROJECT', version: 1, acceptedSignals: [metadata, intention],
        childKinds: ['TASK'], acceptsPrompt: true },
      { kind: 'TASK', version: 1, acceptedSignals: [metadata, intention],
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
}

/** Event-woken plus periodically reconciled dispatcher; no Service owns a busy-loop. */
export class SignalDispatcher {
  readonly #store: ServiceKernelStore;
  readonly #contracts: ServiceContractRegistry;
  readonly #bootId: string;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  #dispatching = false;

  constructor(options: SignalDispatcherOptions) {
    this.#store = options.store;
    this.#contracts = options.contracts;
    this.#bootId = options.bootId;
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
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
      const retryable = storageError === null || storageError.retryable;
      const attempt = signal.automaticAttempts;
      const deadLetter = !retryable || attempt >= maxAutomaticSignalAttempts;
      const delay = signalRetryDelaysMs[Math.min(Math.max(attempt - 1, 0),
        signalRetryDelaysMs.length - 1)] as number;
      this.#store.failClaimedSignal({ signalId: signal.id,
        code: storageError?.code ?? 'SIGNAL_HANDLER_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryAt: deadLetter ? null : this.#now() + delay, deadLetter,
        now: this.#now(), eventId: this.#randomUUID() });
    }
  }
}
