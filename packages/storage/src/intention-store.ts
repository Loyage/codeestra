import type { Database } from 'bun:sqlite';
import { DomainError, transitionProcess as transitionProcessState } from '@codeestra/domain';
import type { ProcessKind, ProcessState, ServiceKind } from '@codeestra/domain';
import {
  KernelStorageError,
  type ServiceKernelStore,
} from './service-kernel-store.js';

/**
 * Storage boundary for intention routing (ADR-0070 §8, S6 lane contract §3).
 *
 * The lane contract gives the Process write path itself to lane E (`ServiceKernelStore.transitionProcess`)
 * and forbids this lane from adding methods there. This class is therefore the *adapter* the intention
 * handler talks to: it reads the facts the routing rules need, records the append-only audit facts the
 * kernel owns, and settles the claimed Signal with its receipt.
 *
 * `transitionProcess` **calls** the S5 method whenever it is present. The local CAS below exists only so
 * this lane can be verified before that method lands, and it mirrors the S5 implementation exactly —
 * same codes, same `ProcessStateChanged` event, same single-statement CAS — so that the day S5 merges,
 * the delegated branch is the one that runs and the two cannot drift.
 */

/** A Process as the routing rules read it. `state` is null only for an Execution-backed projection. */
export interface IntentionProcessRecord {
  readonly processId: string;
  readonly kind: ProcessKind;
  readonly statusSource: 'PROCESS' | 'EXECUTION';
  readonly state: ProcessState | null;
  /** The `processes.version` CAS precondition. Only meaningful for a `PROCESS`-owned Process. */
  readonly version: number;
  readonly parentServiceId: string;
}

export interface IntentionServiceRecord {
  readonly serviceId: string;
  readonly kind: ServiceKind;
  readonly parentServiceId: string | null;
}

/** The Task a `TYPED_COMMAND` would write to, plus whether a live Execution is holding it. */
export interface IntentionTaskScope {
  readonly projectId: string;
  readonly taskId: string;
  readonly holdingExecutionId: string | null;
}

export interface IntentionClarificationRecord {
  readonly clarificationId: string;
  readonly processId: string;
  readonly targetServiceId: string;
  readonly question: string;
  readonly options: readonly string[] | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly requestedAt: number;
}

/** One append-only audit fact the kernel records for an intention. */
export interface IntentionAuditFact {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateType: 'Process' | 'Service';
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface IntentionTransitionRequest {
  readonly expectedVersion: number;
  readonly next: ProcessState;
  readonly reason: string;
  readonly eventId: string;
}

/**
 * Everything one resolution applies, so the receipt, the Process state and the audit facts land in one
 * transaction: a crash can leave the Signal claimed (and retryable), never half-applied.
 */
export interface IntentionApplication {
  readonly signalId: string;
  readonly targetServiceId: string;
  readonly idempotencyKey: string;
  readonly processId: string;
  readonly actor: string;
  readonly transitions: readonly IntentionTransitionRequest[];
  readonly auditFacts: readonly IntentionAuditFact[];
  /** What `signal get` reads back as this Signal's receipt effect. */
  readonly effect: unknown;
  readonly now: number;
  readonly receiptEventId: string;
}

export interface IntentionApplicationResult {
  readonly applied: boolean;
  readonly process: IntentionProcessRecord;
  readonly effect: unknown;
}

/** The S5 method this lane calls when it exists; typed structurally so it is optional here. */
interface ProcessTransitionCapable {
  transitionProcess(input: {
    readonly processId: string;
    readonly expectedVersion: number;
    readonly next: ProcessState;
    readonly actor: string;
    readonly reason: string;
    readonly now: number;
    readonly eventId: string;
  }): unknown;
}

interface ProcessFactRow {
  id: string; kind: ProcessKind; status_source: 'PROCESS' | 'EXECUTION';
  status: ProcessState | null; version: number; parent_service_id: string;
}

interface ServiceFactRow { id: string; kind: ServiceKind; parent_service_id: string | null }

function domain<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof DomainError) throw new KernelStorageError(error.code, error.message);
    throw error;
  }
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new KernelStorageError('INVALID_JSON_VALUE', 'Value is not JSON serializable');
  }
  return encoded;
}

export class IntentionStore {
  readonly #sqlite: Database;
  readonly #kernel: ServiceKernelStore;

  constructor(kernel: ServiceKernelStore) {
    this.#kernel = kernel;
    this.#sqlite = kernel.sqlite;
  }

  readProcess(processId: string): IntentionProcessRecord | null {
    const row = this.#processRow(processId);
    return row === null ? null : mapProcessFact(row);
  }

  readService(serviceId: string): IntentionServiceRecord | null {
    // Project/Task Services are projections of the existing Project/Task rows (S2), so the projection
    // is repaired before it is read — exactly as every other kernel read does.
    this.#kernel.reconcileProjections(Date.now());
    const row = this.#sqlite
      .query<ServiceFactRow, [string]>('SELECT id,kind,parent_service_id FROM services WHERE id=?1')
      .get(serviceId);
    return row === null ? null
      : { serviceId: row.id, kind: row.kind, parentServiceId: row.parent_service_id };
  }

  /**
   * The project/task a `TYPED_COMMAND` targets. `null` means the Service is not a Task Service with a
   * live Task projection — the caller refuses rather than guessing which Task was meant.
   */
  taskScope(taskServiceId: string): IntentionTaskScope | null {
    this.#kernel.reconcileProjections(Date.now());
    const row = this.#sqlite.query<{ task_id: string; project_id: string }, [string]>(`
      SELECT task.id AS task_id,task.project_id FROM services service
        JOIN tasks task ON task.id=service.task_id
      WHERE service.id=?1 AND service.kind='TASK'
    `).get(taskServiceId);
    if (row === null) return null;
    const holding = this.#sqlite.query<{ id: string }, [string]>(
      'SELECT id FROM executions WHERE task_id=?1 AND resource_held=1').get(row.task_id);
    return { projectId: row.project_id, taskId: row.task_id,
      holdingExecutionId: holding?.id ?? null };
  }

  /** The receipt of one `(target Service, idempotency key)` pair, which is what makes a redelivery a no-op. */
  readReceipt(targetServiceId: string, idempotencyKey: string): { readonly effect: unknown } | null {
    const row = this.#sqlite.query<{ effect_json: string }, [string, string]>(
      'SELECT effect_json FROM signal_receipts WHERE target_service_id=?1 AND idempotency_key=?2')
      .get(targetServiceId, idempotencyKey);
    return row === null ? null : { effect: JSON.parse(row.effect_json) as unknown };
  }

  /**
   * The clarification a waiting Process is still sitting on, read back from the append-only audit
   * facts. The Process being `WAITING_FOR_USER` is what makes it open: answering it moves the Process
   * out of that state, so no separate "closed" flag can disagree with the state machine.
   */
  lastClarification(processId: string): IntentionClarificationRecord | null {
    const row = this.#sqlite.query<{ payload_json: string; occurred_at: number }, [string]>(`
      SELECT payload_json,occurred_at FROM domain_events
      WHERE aggregate_type='Process' AND aggregate_id=?1 AND event_type='IntentionClarificationRequested'
      ORDER BY sequence DESC LIMIT 1
    `).get(processId);
    if (row === null) return null;
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const clarificationId = payload['requestId'];
    const question = payload['question'];
    const targetServiceId = payload['targetServiceId'];
    if (typeof clarificationId !== 'string' || typeof question !== 'string'
      || typeof targetServiceId !== 'string') {
      throw new KernelStorageError('INTENTION_CLARIFICATION_CORRUPT',
        `Clarification audit fact of Process ${processId} is not readable`);
    }
    const options = payload['options'];
    return {
      clarificationId,
      processId,
      targetServiceId,
      question,
      options: Array.isArray(options) && options.every((option) => typeof option === 'string')
        ? Object.freeze([...options] as string[]) : null,
      correlationId: typeof payload['correlationId'] === 'string' ? payload['correlationId'] : '',
      causationId: typeof payload['causationId'] === 'string' ? payload['causationId'] : null,
      requestedAt: row.occurred_at,
    };
  }

  /**
   * Applies one resolution atomically: the Process transitions, the audit facts, the receipt and the
   * ACK either all land or none do. A redelivery of an already-receipted key returns the recorded
   * effect and writes nothing, which is how "applied once" is kept without claiming exactly-once.
   */
  applyOutcome(input: IntentionApplication): IntentionApplicationResult {
    return this.#sqlite.transaction(() => {
      const existing = this.readReceipt(input.targetServiceId, input.idempotencyKey);
      if (existing !== null) {
        const process = this.readProcess(input.processId);
        if (process === null) {
          throw new KernelStorageError('PROCESS_NOT_FOUND', 'Process was not found');
        }
        return { applied: false, process, effect: existing.effect };
      }
      for (const step of input.transitions) {
        this.transitionProcess({ processId: input.processId, expectedVersion: step.expectedVersion,
          next: step.next, actor: input.actor, reason: step.reason, now: input.now,
          eventId: step.eventId });
      }
      for (const fact of input.auditFacts) {
        this.#insertEvent({ eventId: fact.eventId, projectId: this.#projectIdForService(input.targetServiceId),
          eventType: fact.eventType, aggregateType: fact.aggregateType, aggregateId: fact.aggregateId,
          aggregateVersion: fact.aggregateVersion, correlationId: fact.correlationId,
          causationId: fact.causationId, occurredAt: input.now, payload: fact.payload });
      }
      const process = this.readProcess(input.processId);
      if (process === null) {
        throw new KernelStorageError('PROCESS_NOT_FOUND', 'Process was not found');
      }
      this.#settleSignal(input, process);
      return { applied: true, process, effect: input.effect };
    })();
  }

  /**
   * The one write path for a Process's own state. Delegates to the S5 store method when this Runtime has
   * it; otherwise applies the same CAS locally so this lane can be verified before S5 merges.
   */
  transitionProcess(input: {
    readonly processId: string;
    readonly expectedVersion: number;
    readonly next: ProcessState;
    readonly actor: string;
    readonly reason: string;
    readonly now: number;
    readonly eventId: string;
  }): IntentionProcessRecord {
    const delegate = (this.#kernel as Partial<ProcessTransitionCapable>).transitionProcess;
    if (typeof delegate === 'function') {
      domain(() => delegate.call(this.#kernel, input));
      const delegated = this.readProcess(input.processId);
      if (delegated === null) {
        throw new KernelStorageError('PROCESS_NOT_FOUND', 'Process was not found');
      }
      return delegated;
    }
    this.#applyTransitionLocally(input);
    const applied = this.readProcess(input.processId);
    if (applied === null) {
      throw new KernelStorageError('PROCESS_NOT_FOUND', 'Process was not found');
    }
    return applied;
  }

  #applyTransitionLocally(input: {
    readonly processId: string;
    readonly expectedVersion: number;
    readonly next: ProcessState;
    readonly actor: string;
    readonly reason: string;
    readonly now: number;
    readonly eventId: string;
  }): void {
    const row = this.#processRow(input.processId);
    if (row === null) throw new KernelStorageError('PROCESS_NOT_FOUND', 'Process was not found');
    if (row.status_source !== 'PROCESS') {
      throw new KernelStorageError('PROCESS_STATUS_SOURCE_READONLY',
        `Process ${row.id} state is projected from its Execution and is not written directly`);
    }
    if (row.version !== input.expectedVersion) {
      throw new KernelStorageError('PROCESS_VERSION_CONFLICT',
        `Process ${row.id} is at version ${row.version}, not ${input.expectedVersion}`);
    }
    if (row.status === null) {
      throw new KernelStorageError('PROCESS_STATE_UNAVAILABLE',
        `Process ${row.id} has no Process-owned state`);
    }
    if (input.actor.trim().length === 0) {
      throw new KernelStorageError('INVALID_VALUE', 'Process actor must not be empty');
    }
    if (input.reason.trim().length === 0) {
      throw new KernelStorageError('INVALID_VALUE', 'Process transition reason must not be empty');
    }
    const from = row.status;
    const next = domain(() => transitionProcessState(from, input.next));
    const changed = this.#sqlite.query(`UPDATE processes SET status=?3,version=version+1,updated_at=?4
      WHERE id=?1 AND version=?2 AND status_source='PROCESS'`)
      .run(row.id, row.version, next, input.now);
    if (changed.changes !== 1) {
      throw new KernelStorageError('PROCESS_VERSION_CONFLICT',
        `Process ${row.id} changed while the transition was being applied`);
    }
    this.#insertEvent({ eventId: input.eventId,
      projectId: this.#projectIdForService(row.parent_service_id), eventType: 'ProcessStateChanged',
      aggregateType: 'Process', aggregateId: row.id, aggregateVersion: row.version + 1,
      correlationId: row.id, causationId: null, occurredAt: input.now,
      payload: { processId: row.id, from, to: next, actor: input.actor, reason: input.reason } });
  }

  #settleSignal(input: IntentionApplication, process: IntentionProcessRecord): void {
    const signal = this.#sqlite.query<{ attempt_count: number; correlation_id: string }, [string]>(
      'SELECT attempt_count,correlation_id FROM signals WHERE id=?1').get(input.signalId);
    if (signal === null) {
      throw new KernelStorageError('SIGNAL_NOT_FOUND', 'Signal was not found');
    }
    this.#sqlite.query(`INSERT INTO signal_receipts
      (target_service_id,idempotency_key,signal_id,effect_json,acknowledged_at)
      VALUES (?1,?2,?3,?4,?5)`).run(input.targetServiceId, input.idempotencyKey, input.signalId,
      json(input.effect), input.now);
    this.#sqlite.query(`UPDATE signals SET state='ACKED',claim_boot_id=NULL,claim_deadline_at=NULL,
      next_attempt_at=NULL,acknowledged_at=?2,updated_at=?2 WHERE id=?1`)
      .run(input.signalId, input.now);
    this.#sqlite.query(`UPDATE signal_attempts SET state='ACKED',settled_at=?3
      WHERE signal_id=?1 AND attempt_number=?2 AND state='CLAIMED'`)
      .run(input.signalId, signal.attempt_count, input.now);
    this.#sqlite.query('UPDATE services SET inbox_cursor=inbox_cursor+1,updated_at=?2 WHERE id=?1')
      .run(input.targetServiceId, input.now);
    this.#insertEvent({ eventId: input.receiptEventId,
      projectId: this.#projectIdForService(input.targetServiceId), eventType: 'SignalAcknowledged',
      aggregateType: 'Signal', aggregateId: input.signalId,
      aggregateVersion: signal.attempt_count, correlationId: signal.correlation_id,
      causationId: input.signalId, occurredAt: input.now,
      payload: { signalId: input.signalId, effect: input.effect,
        processId: process.processId, processState: process.state } });
  }

  #processRow(processId: string): ProcessFactRow | null {
    return this.#sqlite.query<ProcessFactRow, [string]>(`SELECT id,kind,status_source,status,version,
      parent_service_id FROM processes WHERE id=?1`).get(processId);
  }

  #projectIdForService(serviceId: string): string | null {
    return this.#sqlite.query<{ project_id: string | null }, [string]>(`SELECT COALESCE(service.project_id,
      task.project_id) AS project_id FROM services service
      LEFT JOIN tasks task ON task.id=service.task_id WHERE service.id=?1`).get(serviceId)
      ?.project_id ?? null;
  }

  #insertEvent(input: {
    readonly eventId: string; readonly projectId: string | null; readonly eventType: string;
    readonly aggregateType: string; readonly aggregateId: string; readonly aggregateVersion: number;
    readonly correlationId: string; readonly causationId: string | null;
    readonly occurredAt: number; readonly payload: unknown;
  }): void {
    this.#sqlite.query(`INSERT INTO domain_events(event_id,project_id,event_type,schema_version,
      aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
      VALUES (?1,?2,?3,1,?4,?5,?6,?7,?8,?9,?10)`)
      .run(input.eventId, input.projectId, input.eventType, input.aggregateType, input.aggregateId,
        input.aggregateVersion, input.correlationId, input.causationId, input.occurredAt,
        json(input.payload));
  }
}

function mapProcessFact(row: ProcessFactRow): IntentionProcessRecord {
  return { processId: row.id, kind: row.kind, statusSource: row.status_source, state: row.status,
    version: row.version, parentServiceId: row.parent_service_id };
}
