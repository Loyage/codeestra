import type { Database } from 'bun:sqlite';
import type { ProcessKind, ProcessState, ServiceKind, ServiceLifecycle, SignalKind, SignalState }
  from '@codeestra/domain';
import { rootServiceId, schedulerServiceId, attentionServiceId } from './migration.js';
import type { Phase1Database } from './database.js';

export class KernelStorageError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = 'KernelStorageError';
  }
}

export interface ServiceView {
  readonly id: string;
  readonly kind: ServiceKind;
  readonly parentServiceId: string | null;
  readonly lifecycle: ServiceLifecycle;
  readonly stateVersion: number;
  readonly coreVersion: number;
  readonly contractVersion: number;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly inboxCursor: number;
  readonly coreState: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProcessView {
  readonly id: string;
  readonly kind: ProcessKind;
  readonly parentServiceId: string;
  readonly state: ProcessState;
  readonly version: number;
  readonly controlVersion: number | null;
  readonly objective: string;
  readonly adapterId: string | null;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SignalView {
  readonly id: string;
  readonly kind: SignalKind;
  readonly subtype: string;
  readonly sourceServiceId: string | null;
  readonly sourceProcessId: string | null;
  readonly targetServiceId: string;
  readonly contractVersion: number;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly priority: number;
  readonly state: SignalState;
  readonly attemptCount: number;
  readonly automaticAttempts: number;
  readonly nextAttemptAt: number | null;
  readonly claimBootId: string | null;
  readonly claimDeadlineAt: number | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly acknowledgedAt: number | null;
  readonly deadLetteredAt: number | null;
  readonly receipt: { readonly effect: unknown; readonly acknowledgedAt: number } | null;
  readonly attempts: readonly SignalAttemptView[];
}

export interface SignalAttemptView {
  readonly attemptNumber: number;
  readonly bootId: string;
  readonly state: 'CLAIMED' | 'ACKED' | 'RETRYABLE' | 'DEAD_LETTER' | 'RECOVERY_REQUIRED';
  readonly claimedAt: number;
  readonly settledAt: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

interface ServiceRow {
  id: string; kind: ServiceKind; parent_service_id: string | null; lifecycle: ServiceLifecycle;
  state_version: number; contract_version: number; project_id: string | null; task_id: string | null;
  inbox_cursor: number; created_at: number; updated_at: number;
}
interface ProcessRow {
  id: string; kind: ProcessKind; parent_service_id: string; status_source: 'PROCESS' | 'EXECUTION';
  status: ProcessState | null; version: number; objective: string; adapter_id: string | null;
  created_at: number; updated_at: number; execution_id: string | null; execution_state: string | null;
  execution_version: number | null; execution_adapter_id: string | null; task_id: string | null;
  task_version: number | null; project_id: string | null; effective_updated_at: number;
}
interface SignalRow {
  id: string; kind: SignalKind; subtype: string; source_service_id: string | null;
  source_process_id: string | null; target_service_id: string; contract_version: number;
  payload_json: string; idempotency_key: string; correlation_id: string; causation_id: string | null;
  priority: number; state: SignalState; attempt_count: number; automatic_attempts: number;
  next_attempt_at: number | null; claim_boot_id: string | null; claim_deadline_at: number | null;
  last_error_code: string | null; last_error_message: string | null; created_at: number;
  updated_at: number; acknowledged_at: number | null; dead_lettered_at: number | null;
}

const projectedExecutionStates: Readonly<Record<string, ProcessState>> = Object.freeze({
  CREATED: 'CREATED', PREPARING: 'STARTING', STARTING: 'STARTING', RUNNING: 'RUNNING',
  WAITING_FOR_USER: 'WAITING_FOR_USER', PAUSING: 'PAUSING', PAUSED: 'PAUSED',
  STOPPING: 'PAUSING', RECOVERY_REQUIRED: 'RECOVERY_REQUIRED', SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED', CANCELLED: 'CANCELLED', SUPERSEDED: 'CANCELLED',
});

/** Storage boundary for S2/S3. Existing Task/Execution writes are projected, never duplicated. */
export class ServiceKernelStore {
  readonly sqlite: Database;

  constructor(storage: Phase1Database) {
    this.sqlite = storage.sqlite;
  }

  reconcileProjections(now: number): void {
    this.sqlite.transaction(() => {
      this.sqlite.query(`INSERT OR IGNORE INTO services
        (id,kind,parent_service_id,lifecycle,state_version,contract_version,project_id,task_id,
          inbox_cursor,created_at,updated_at)
        SELECT id,'PROJECT',?1,'ACTIVE',0,1,id,NULL,0,created_at,created_at FROM projects`)
        .run(rootServiceId);
      this.sqlite.query(`INSERT OR IGNORE INTO services
        (id,kind,parent_service_id,lifecycle,state_version,contract_version,project_id,task_id,
          inbox_cursor,created_at,updated_at)
        SELECT id,'TASK',project_id,'ACTIVE',0,1,NULL,id,0,created_at,updated_at FROM tasks`).run();
      this.sqlite.query(`INSERT OR IGNORE INTO processes
        (id,kind,parent_service_id,status_source,status,version,objective,adapter_id,
          agent_config_json,budget_json,context_ref,created_at,updated_at)
        SELECT execution.id,'DEVELOPMENT',execution.task_id,'EXECUTION',NULL,0,
          revision.specification,execution.adapter_id,execution.agent_config_json,NULL,NULL,
          COALESCE(execution.started_at,task.created_at),
          COALESCE(execution.ended_at,execution.started_at,task.updated_at)
        FROM executions execution JOIN tasks task ON task.id=execution.task_id
        JOIN task_revisions revision ON revision.id=execution.applied_revision_id`).run();
      this.sqlite.query(`INSERT OR IGNORE INTO process_execution_links(process_id,execution_id,created_at)
        SELECT id,id,COALESCE(started_at,?1) FROM executions`).run(now);
      // A Task purge deliberately destroys the old core row. Its Service remains an addressable
      // tombstone so existing Signals and audit links are not deleted with it.
      this.sqlite.query(`UPDATE services SET lifecycle='RETIRED',updated_at=?1
        WHERE kind IN ('PROJECT','TASK') AND project_id IS NULL AND task_id IS NULL
          AND lifecycle<>'RETIRED'`).run(now);
    })();
  }

  listServices(input: { readonly kind?: ServiceKind; readonly parentServiceId?: string;
    readonly includeRetired?: boolean } = {}): readonly ServiceView[] {
    this.reconcileProjections(Date.now());
    const rows = this.sqlite.query<ServiceRow, []>('SELECT * FROM services ORDER BY created_at,id').all();
    return rows.filter((row) => (input.kind === undefined || row.kind === input.kind)
      && (input.parentServiceId === undefined || row.parent_service_id === input.parentServiceId)
      && (input.includeRetired === true || row.lifecycle !== 'RETIRED'))
      .map((row) => this.mapService(row));
  }

  getService(serviceId: string): ServiceView {
    this.reconcileProjections(Date.now());
    const row = this.sqlite.query<ServiceRow, [string]>('SELECT * FROM services WHERE id=?1')
      .get(serviceId);
    if (row === null) throw new KernelStorageError('SERVICE_NOT_FOUND', 'Service was not found');
    return this.mapService(row);
  }

  serviceTree(rootId = rootServiceId): readonly ServiceView[] {
    const all = this.listServices({ includeRetired: true });
    if (!all.some((service) => service.id === rootId)) {
      throw new KernelStorageError('SERVICE_NOT_FOUND', 'Tree root Service was not found');
    }
    const descendants = new Set<string>([rootId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const service of all) {
        if (service.parentServiceId !== null && descendants.has(service.parentServiceId)
          && !descendants.has(service.id)) {
          descendants.add(service.id); changed = true;
        }
      }
    }
    return all.filter((service) => descendants.has(service.id));
  }

  listProcesses(input: { readonly parentServiceId?: string; readonly state?: ProcessState } = {}): readonly ProcessView[] {
    this.reconcileProjections(Date.now());
    return this.processRows().map(mapProcess).filter((process) =>
      (input.parentServiceId === undefined || process.parentServiceId === input.parentServiceId)
      && (input.state === undefined || process.state === input.state));
  }

  getProcess(processId: string): ProcessView {
    this.reconcileProjections(Date.now());
    const row = this.processRows('WHERE process.id=?1', processId)[0];
    if (row === undefined) throw new KernelStorageError('PROCESS_NOT_FOUND', 'Process was not found');
    return mapProcess(row);
  }

  enqueueSignal(input: {
    readonly id: string; readonly kind: SignalKind; readonly subtype: string;
    readonly sourceServiceId: string | null; readonly sourceProcessId: string | null;
    readonly targetServiceId: string; readonly contractVersion: number; readonly payload: unknown;
    readonly idempotencyKey: string; readonly correlationId: string; readonly causationId: string | null;
    readonly priority: number; readonly createdAt: number; readonly eventId: string;
  }): { readonly signal: SignalView; readonly created: boolean } {
    return this.sqlite.transaction(() => {
      const target = this.sqlite.query<{ project_id: string | null; task_id: string | null }, [string]>(
        'SELECT project_id,task_id FROM services WHERE id=?1').get(input.targetServiceId);
      if (target === null) throw new KernelStorageError('SERVICE_NOT_FOUND', 'Target Service was not found');
      const payloadJson = json(input.payload);
      const existing = this.sqlite.query<SignalRow, [string, string]>(
        'SELECT * FROM signals WHERE target_service_id=?1 AND idempotency_key=?2')
        .get(input.targetServiceId, input.idempotencyKey);
      if (existing !== null) {
        if (existing.kind !== input.kind || existing.subtype !== input.subtype
          || existing.contract_version !== input.contractVersion || existing.payload_json !== payloadJson) {
          throw new KernelStorageError('SIGNAL_IDEMPOTENCY_CONFLICT',
            'Signal idempotency key was already used with a different payload');
        }
        return { signal: this.getSignal(existing.id), created: false };
      }
      this.sqlite.query(`INSERT INTO signals
        (id,kind,subtype,source_service_id,source_process_id,target_service_id,contract_version,
          payload_json,idempotency_key,correlation_id,causation_id,priority,state,created_at,updated_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'PENDING',?13,?13)`)
        .run(input.id, input.kind, input.subtype, input.sourceServiceId, input.sourceProcessId,
          input.targetServiceId, input.contractVersion, payloadJson, input.idempotencyKey,
          input.correlationId, input.causationId, input.priority, input.createdAt);
      this.insertEvent({ eventId: input.eventId, projectId: this.projectIdForService(input.targetServiceId),
        eventType: 'SignalEnqueued', aggregateType: 'Signal', aggregateId: input.id,
        aggregateVersion: 0, correlationId: input.correlationId, causationId: input.causationId,
        occurredAt: input.createdAt, payload: { signalId: input.id, kind: input.kind,
          subtype: input.subtype, targetServiceId: input.targetServiceId } });
      return { signal: this.getSignal(input.id), created: true };
    })();
  }

  claimNextSignal(input: { readonly bootId: string; readonly now: number;
    readonly leaseMs: number; readonly eventId: string }): SignalView | null {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.query<SignalRow, [number]>(`SELECT * FROM signals
        WHERE state IN ('PENDING','RETRYABLE') AND (next_attempt_at IS NULL OR next_attempt_at<=?1)
        ORDER BY priority DESC,created_at,id LIMIT 1`).get(input.now);
      if (row === null) return null;
      const attempt = row.attempt_count + 1;
      const changed = this.sqlite.query(`UPDATE signals SET state='CLAIMED',attempt_count=?2,
        automatic_attempts=automatic_attempts+1,claim_boot_id=?3,claim_deadline_at=?4,
        next_attempt_at=NULL,updated_at=?1 WHERE id=?5 AND state IN ('PENDING','RETRYABLE')`)
        .run(input.now, attempt, input.bootId, input.now + input.leaseMs, row.id);
      if (changed.changes !== 1) return null;
      this.sqlite.query(`INSERT INTO signal_attempts
        (signal_id,attempt_number,boot_id,state,claimed_at) VALUES (?1,?2,?3,'CLAIMED',?4)`)
        .run(row.id, attempt, input.bootId, input.now);
      this.insertEvent({ eventId: input.eventId, projectId: this.projectIdForService(row.target_service_id),
        eventType: 'SignalClaimed', aggregateType: 'Signal', aggregateId: row.id,
        aggregateVersion: attempt, correlationId: row.correlation_id, causationId: row.id,
        occurredAt: input.now, payload: { signalId: row.id, attempt, bootId: input.bootId } });
      return this.getSignal(row.id);
    })();
  }

  acknowledgeMetadataSignal(input: { readonly signalId: string; readonly namespace: string;
    readonly key: string; readonly value: unknown; readonly expectedVersion: number;
    readonly actor: string; readonly now: number; readonly eventIds: readonly [string, string] }): SignalView {
    return this.sqlite.transaction(() => {
      const { signal, receipt } = this.claimedSignalOrReceipt(input.signalId);
      if (receipt !== null) return this.finishAlreadyReceipted(signal, input.now);
      const service = this.serviceRow(signal.target_service_id);
      if (service.state_version !== input.expectedVersion) {
        throw new KernelStorageError('SERVICE_VERSION_CONFLICT', 'Service state version did not match');
      }
      const valueJson = json(input.value);
      this.sqlite.query(`INSERT INTO service_metadata
        (service_id,namespace,key,value_json,version,updated_at,updated_by)
        VALUES (?1,?2,?3,?4,?5,?6,?7)
        ON CONFLICT(service_id,namespace,key) DO UPDATE SET value_json=excluded.value_json,
          version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
        .run(service.id, input.namespace, input.key, valueJson, service.state_version + 1,
          input.now, input.actor);
      this.sqlite.query('UPDATE services SET state_version=state_version+1,updated_at=?2 WHERE id=?1')
        .run(service.id, input.now);
      const effect = { type: 'SERVICE_METADATA_SET', serviceId: service.id,
        namespace: input.namespace, key: input.key, stateVersion: service.state_version + 1 };
      this.recordReceiptAndAck(signal, effect, input.now);
      this.insertEvent({ eventId: input.eventIds[0], projectId: this.projectIdForService(service.id),
        eventType: 'ServiceMetadataChanged', aggregateType: 'Service', aggregateId: service.id,
        aggregateVersion: service.state_version + 1, correlationId: signal.correlation_id,
        causationId: signal.id, occurredAt: input.now, payload: effect });
      this.insertSignalAckEvent(signal, input.eventIds[1], input.now, effect);
      return this.getSignal(signal.id);
    })();
  }

  acknowledgeIntentionSignal(input: { readonly signalId: string; readonly processId: string;
    readonly text: string; readonly adapterId: string; readonly now: number;
    readonly eventIds: readonly [string, string] }): SignalView {
    return this.sqlite.transaction(() => {
      const { signal, receipt } = this.claimedSignalOrReceipt(input.signalId);
      if (receipt !== null) return this.finishAlreadyReceipted(signal, input.now);
      this.sqlite.query(`INSERT INTO processes
        (id,kind,parent_service_id,status_source,status,version,objective,adapter_id,
          agent_config_json,budget_json,context_ref,created_at,updated_at)
        VALUES (?1,'INTENTION',?2,'PROCESS','CREATED',0,?3,?4,NULL,NULL,NULL,?5,?5)`)
        .run(input.processId, signal.target_service_id, input.text, input.adapterId, input.now);
      const effect = { type: 'INTENTION_PROCESS_CREATED', processId: input.processId,
        targetServiceId: signal.target_service_id, state: 'CREATED' };
      this.recordReceiptAndAck(signal, effect, input.now);
      this.insertEvent({ eventId: input.eventIds[0], projectId: this.projectIdForService(signal.target_service_id),
        eventType: 'ProcessCreated', aggregateType: 'Process', aggregateId: input.processId,
        aggregateVersion: 0, correlationId: signal.correlation_id, causationId: signal.id,
        occurredAt: input.now, payload: effect });
      this.insertSignalAckEvent(signal, input.eventIds[1], input.now, effect);
      return this.getSignal(signal.id);
    })();
  }

  failClaimedSignal(input: { readonly signalId: string; readonly code: string;
    readonly message: string; readonly retryAt: number | null; readonly deadLetter: boolean;
    readonly recoveryRequired?: boolean; readonly now: number; readonly eventId: string }): SignalView {
    return this.sqlite.transaction(() => {
      const row = this.signalRow(input.signalId);
      if (row.state !== 'CLAIMED') {
        if (row.state === 'ACKED' || row.state === 'DEAD_LETTER') return this.getSignal(row.id);
        throw new KernelStorageError('SIGNAL_NOT_CLAIMED', 'Signal is not claimed');
      }
      const state: SignalState = input.recoveryRequired === true ? 'RECOVERY_REQUIRED'
        : input.deadLetter ? 'DEAD_LETTER' : 'RETRYABLE';
      this.sqlite.query(`UPDATE signals SET state=?2,next_attempt_at=?3,claim_boot_id=NULL,
        claim_deadline_at=NULL,last_error_code=?4,last_error_message=?5,updated_at=?6,
        dead_lettered_at=?7 WHERE id=?1`)
        .run(row.id, state, input.retryAt, input.code, input.message, input.now,
          state === 'DEAD_LETTER' ? input.now : null);
      this.sqlite.query(`UPDATE signal_attempts SET state=?3,settled_at=?4,error_code=?5,
        error_message=?6 WHERE signal_id=?1 AND attempt_number=?2 AND state='CLAIMED'`)
        .run(row.id, row.attempt_count, state, input.now, input.code, input.message);
      this.insertEvent({ eventId: input.eventId, projectId: this.projectIdForService(row.target_service_id),
        eventType: state === 'DEAD_LETTER' ? 'SignalDeadLettered'
          : state === 'RECOVERY_REQUIRED' ? 'SignalRecoveryRequired' : 'SignalRetryScheduled',
        aggregateType: 'Signal', aggregateId: row.id, aggregateVersion: row.attempt_count,
        correlationId: row.correlation_id, causationId: row.id, occurredAt: input.now,
        payload: { signalId: row.id, state, code: input.code, retryAt: input.retryAt } });
      return this.getSignal(row.id);
    })();
  }

  reconcileExpiredClaims(input: { readonly now: number; readonly eventId: () => string }): number {
    const expired = this.sqlite.query<SignalRow, [number]>(
      "SELECT * FROM signals WHERE state='CLAIMED' AND claim_deadline_at<=?1 ORDER BY created_at,id")
      .all(input.now);
    for (const signal of expired) {
      this.failClaimedSignal({ signalId: signal.id, code: 'CLAIM_LEASE_EXPIRED',
        message: 'The Runtime stopped before the claimed handler acknowledged; the internal handler is retryable',
        retryAt: input.now, deadLetter: false, now: input.now, eventId: input.eventId() });
    }
    return expired.length;
  }

  retrySignal(input: { readonly signalId: string; readonly now: number; readonly eventId: string }): SignalView {
    return this.sqlite.transaction(() => {
      const row = this.signalRow(input.signalId);
      if (!['RETRYABLE', 'DEAD_LETTER', 'RECOVERY_REQUIRED'].includes(row.state)) {
        throw new KernelStorageError('SIGNAL_NOT_RETRYABLE', `A ${row.state} Signal cannot be retried`);
      }
      this.sqlite.query(`UPDATE signals SET state='PENDING',automatic_attempts=0,next_attempt_at=NULL,
        claim_boot_id=NULL,claim_deadline_at=NULL,last_error_code=NULL,last_error_message=NULL,
        dead_lettered_at=NULL,updated_at=?2 WHERE id=?1`).run(row.id, input.now);
      this.insertEvent({ eventId: input.eventId, projectId: this.projectIdForService(row.target_service_id),
        eventType: 'SignalRetryRequested', aggregateType: 'Signal', aggregateId: row.id,
        aggregateVersion: row.attempt_count, correlationId: row.correlation_id,
        causationId: row.id, occurredAt: input.now, payload: { signalId: row.id } });
      return this.getSignal(row.id);
    })();
  }

  listSignals(input: { readonly targetServiceId?: string; readonly state?: SignalState;
    readonly kind?: SignalKind; readonly limit?: number } = {}): readonly SignalView[] {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new KernelStorageError('INVALID_SIGNAL_LIMIT', 'Signal limit must be between 1 and 500');
    }
    const rows = this.sqlite.query<SignalRow,
      [string | null, SignalState | null, SignalKind | null, number]>(`SELECT * FROM signals
        WHERE (?1 IS NULL OR target_service_id=?1) AND (?2 IS NULL OR state=?2)
          AND (?3 IS NULL OR kind=?3)
        ORDER BY created_at DESC,id DESC LIMIT ?4`)
      .all(input.targetServiceId ?? null, input.state ?? null, input.kind ?? null, limit);
    return rows.map((row) => this.mapSignal(row));
  }

  getSignal(signalId: string): SignalView {
    return this.mapSignal(this.signalRow(signalId));
  }

  private mapService(row: ServiceRow): ServiceView {
    const metadataRows = this.sqlite.query<{ namespace: string; key: string; value_json: string }, [string]>(
      'SELECT namespace,key,value_json FROM service_metadata WHERE service_id=?1 ORDER BY namespace,key')
      .all(row.id);
    const metadata: Record<string, unknown> = {};
    for (const entry of metadataRows) metadata[`${entry.namespace}/${entry.key}`] = JSON.parse(entry.value_json);
    const core = this.coreState(row);
    return { id: row.id, kind: row.kind, parentServiceId: row.parent_service_id,
      lifecycle: row.lifecycle, stateVersion: row.state_version, coreVersion: core.version,
      contractVersion: row.contract_version, projectId: row.project_id, taskId: row.task_id,
      inboxCursor: row.inbox_cursor, coreState: core.state, metadata,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private coreState(row: ServiceRow): { readonly version: number;
    readonly state: Readonly<Record<string, unknown>> } {
    if (row.kind === 'ROOT') return { version: 0, state: { service: 'Codeestra', role: 'ROOT' } };
    if (row.kind === 'SCHEDULER') {
      const capacity = this.sqlite.query<{ global_limit: number; version: number }, []>(
        'SELECT global_limit,version FROM runtime_capacity_settings WHERE singleton_id=1').get();
      return { version: capacity?.version ?? 0,
        state: { role: 'SCHEDULER', globalLimit: capacity?.global_limit ?? 2 } };
    }
    if (row.kind === 'ATTENTION') {
      const open = this.sqlite.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM attention_requests WHERE status='OPEN'").get()?.count ?? 0;
      return { version: 0, state: { role: 'ATTENTION', openRequests: open } };
    }
    if (row.kind === 'PROJECT' && row.project_id !== null) {
      const project = this.sqlite.query<{ id: string; name: string; main_ref: string;
        policy_version: number; created_at: number }, [string]>(
        'SELECT id,name,main_ref,policy_version,created_at FROM projects WHERE id=?1')
        .get(row.project_id);
      if (project !== null) return { version: project.policy_version,
        state: { projectId: project.id, name: project.name, mainRef: project.main_ref,
          policyVersion: project.policy_version, createdAt: project.created_at } };
    }
    if (row.kind === 'TASK' && row.task_id !== null) {
      const task = this.sqlite.query<{ id: string; project_id: string; display_number: number;
        display_title: string; naming_title: string | null; current_revision_id: string; state: string;
        priority: number; version: number; archived_at: number | null }, [string]>(
        `SELECT id,project_id,display_number,display_title,naming_title,current_revision_id,state,
          priority,version,archived_at FROM tasks WHERE id=?1`).get(row.task_id);
      if (task !== null) return { version: task.version, state: { taskId: task.id,
        projectId: task.project_id, displayNumber: task.display_number, displayTitle: task.display_title,
        namingTitle: task.naming_title, currentRevisionId: task.current_revision_id,
        lifecycleState: task.state, priority: task.priority, archived: task.archived_at !== null } };
    }
    return { version: 0, state: { retired: true } };
  }

  private processRows(where = '', id?: string): ProcessRow[] {
    const sql = `SELECT process.*,link.execution_id,execution.state AS execution_state,
      execution.version AS execution_version,execution.adapter_id AS execution_adapter_id,
      execution.task_id,task.version AS task_version,task.project_id,
      COALESCE(execution.ended_at,execution.started_at,process.updated_at) AS effective_updated_at
      FROM processes process
      LEFT JOIN process_execution_links link ON link.process_id=process.id
      LEFT JOIN executions execution ON execution.id=link.execution_id
      LEFT JOIN tasks task ON task.id=COALESCE(execution.task_id,
        (SELECT task_id FROM services WHERE id=process.parent_service_id)) ${where}
      ORDER BY process.created_at,process.id`;
    return id === undefined
      ? this.sqlite.query<ProcessRow, []>(sql).all()
      : this.sqlite.query<ProcessRow, [string]>(sql).all(id);
  }

  private serviceRow(serviceId: string): ServiceRow {
    const row = this.sqlite.query<ServiceRow, [string]>('SELECT * FROM services WHERE id=?1').get(serviceId);
    if (row === null) throw new KernelStorageError('SERVICE_NOT_FOUND', 'Service was not found');
    return row;
  }

  private signalRow(signalId: string): SignalRow {
    const row = this.sqlite.query<SignalRow, [string]>('SELECT * FROM signals WHERE id=?1').get(signalId);
    if (row === null) throw new KernelStorageError('SIGNAL_NOT_FOUND', 'Signal was not found');
    return row;
  }

  private mapSignal(row: SignalRow): SignalView {
    const receipt = this.sqlite.query<{ effect_json: string; acknowledged_at: number }, [string]>(
      'SELECT effect_json,acknowledged_at FROM signal_receipts WHERE signal_id=?1').get(row.id);
    const attempts = this.sqlite.query<{ attempt_number: number; boot_id: string;
      state: SignalAttemptView['state']; claimed_at: number; settled_at: number | null;
      error_code: string | null; error_message: string | null }, [string]>(
      'SELECT * FROM signal_attempts WHERE signal_id=?1 ORDER BY attempt_number').all(row.id)
      .map((attempt) => ({ attemptNumber: attempt.attempt_number, bootId: attempt.boot_id,
        state: attempt.state, claimedAt: attempt.claimed_at, settledAt: attempt.settled_at,
        errorCode: attempt.error_code, errorMessage: attempt.error_message }));
    return { id: row.id, kind: row.kind, subtype: row.subtype,
      sourceServiceId: row.source_service_id, sourceProcessId: row.source_process_id,
      targetServiceId: row.target_service_id, contractVersion: row.contract_version,
      payload: JSON.parse(row.payload_json), idempotencyKey: row.idempotency_key,
      correlationId: row.correlation_id, causationId: row.causation_id, priority: row.priority,
      state: row.state, attemptCount: row.attempt_count, automaticAttempts: row.automatic_attempts,
      nextAttemptAt: row.next_attempt_at, claimBootId: row.claim_boot_id,
      claimDeadlineAt: row.claim_deadline_at, lastErrorCode: row.last_error_code,
      lastErrorMessage: row.last_error_message, createdAt: row.created_at, updatedAt: row.updated_at,
      acknowledgedAt: row.acknowledged_at, deadLetteredAt: row.dead_lettered_at,
      receipt: receipt === null ? null : { effect: JSON.parse(receipt.effect_json),
        acknowledgedAt: receipt.acknowledged_at }, attempts };
  }

  private claimedSignalOrReceipt(signalId: string): { readonly signal: SignalRow;
    readonly receipt: { readonly effect_json: string } | null } {
    const signal = this.signalRow(signalId);
    const receipt = this.sqlite.query<{ effect_json: string }, [string]>(
      'SELECT effect_json FROM signal_receipts WHERE signal_id=?1').get(signal.id);
    if (receipt === null && signal.state !== 'CLAIMED') {
      throw new KernelStorageError('SIGNAL_NOT_CLAIMED', 'Signal is not claimed');
    }
    return { signal, receipt };
  }

  private finishAlreadyReceipted(signal: SignalRow, now: number): SignalView {
    if (signal.state !== 'ACKED') {
      this.sqlite.query(`UPDATE signals SET state='ACKED',claim_boot_id=NULL,claim_deadline_at=NULL,
        next_attempt_at=NULL,acknowledged_at=?2,updated_at=?2 WHERE id=?1`).run(signal.id, now);
    }
    return this.getSignal(signal.id);
  }

  private recordReceiptAndAck(signal: SignalRow, effect: unknown, now: number): void {
    this.sqlite.query(`INSERT INTO signal_receipts
      (target_service_id,idempotency_key,signal_id,effect_json,acknowledged_at)
      VALUES (?1,?2,?3,?4,?5)`).run(signal.target_service_id, signal.idempotency_key,
      signal.id, json(effect), now);
    this.sqlite.query(`UPDATE signals SET state='ACKED',claim_boot_id=NULL,claim_deadline_at=NULL,
      next_attempt_at=NULL,acknowledged_at=?2,updated_at=?2 WHERE id=?1`).run(signal.id, now);
    this.sqlite.query(`UPDATE signal_attempts SET state='ACKED',settled_at=?3
      WHERE signal_id=?1 AND attempt_number=?2 AND state='CLAIMED'`)
      .run(signal.id, signal.attempt_count, now);
    this.sqlite.query(`UPDATE services SET inbox_cursor=inbox_cursor+1,updated_at=?2 WHERE id=?1`)
      .run(signal.target_service_id, now);
  }

  private insertSignalAckEvent(signal: SignalRow, eventId: string, now: number, effect: unknown): void {
    this.insertEvent({ eventId, projectId: this.projectIdForService(signal.target_service_id),
      eventType: 'SignalAcknowledged', aggregateType: 'Signal', aggregateId: signal.id,
      aggregateVersion: signal.attempt_count, correlationId: signal.correlation_id,
      causationId: signal.id, occurredAt: now, payload: { signalId: signal.id, effect } });
  }

  private projectIdForService(serviceId: string): string | null {
    return this.sqlite.query<{ project_id: string | null }, [string]>(`SELECT COALESCE(service.project_id,
      task.project_id) AS project_id FROM services service
      LEFT JOIN tasks task ON task.id=service.task_id WHERE service.id=?1`).get(serviceId)?.project_id ?? null;
  }

  private insertEvent(input: { readonly eventId: string; readonly projectId: string | null;
    readonly eventType: string; readonly aggregateType: string; readonly aggregateId: string;
    readonly aggregateVersion: number; readonly correlationId: string;
    readonly causationId: string | null; readonly occurredAt: number; readonly payload: unknown }): void {
    this.sqlite.query(`INSERT INTO domain_events(event_id,project_id,event_type,schema_version,
      aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
      VALUES (?1,?2,?3,1,?4,?5,?6,?7,?8,?9,?10)`)
      .run(input.eventId, input.projectId, input.eventType, input.aggregateType, input.aggregateId,
        input.aggregateVersion, input.correlationId, input.causationId, input.occurredAt,
        json(input.payload));
  }
}

function mapProcess(row: ProcessRow): ProcessView {
  const state = row.status_source === 'EXECUTION'
    ? projectedExecutionStates[row.execution_state ?? ''] ?? 'RECOVERY_REQUIRED'
    : row.status ?? 'RECOVERY_REQUIRED';
  return { id: row.id, kind: row.kind, parentServiceId: row.parent_service_id, state,
    version: row.status_source === 'EXECUTION' ? row.execution_version ?? 0 : row.version,
    controlVersion: row.task_version, objective: row.objective,
    adapterId: row.status_source === 'EXECUTION' ? row.execution_adapter_id : row.adapter_id,
    projectId: row.project_id, taskId: row.task_id, executionId: row.execution_id,
    createdAt: row.created_at, updatedAt: row.effective_updated_at };
}

function json(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new KernelStorageError('INVALID_JSON_VALUE', 'Value is not JSON serializable');
  return result;
}

export const systemServiceIds = Object.freeze({ root: rootServiceId,
  scheduler: schedulerServiceId, attention: attentionServiceId });
