import type { Database } from 'bun:sqlite';
import {
  DomainError,
  compareMergeQueueOrder,
  holdsIntegrationSlot,
  isSettledMergeQueueItemState,
  taskIntegrationStateForQueueItem,
  transitionMergeQueueItem,
  type MergeQueueItemState,
  type TaskIntegrationState,
} from '@codeestra/domain';
import { KernelStorageError } from './service-kernel-store.js';
import type { Phase1Database } from './database.js';

/**
 * Storage boundary for Project-managed integration (ADR-0070 D07 / S8, ADR-0074).
 *
 * Two rules shape every method here:
 *
 *  - **The Git ref is the authority for "what is integrated".** `project_integration.integration_oid`
 *    is this Runtime's last recorded advance, not a second truth: a disagreement is reported by the
 *    reconcile path and never silently written over.
 *  - **The queue enforces serialization in the database.** `one_active_integration_per_project`
 *    (partial unique index on `MERGING`/`VERIFYING`) makes "one active integration per project" a
 *    constraint instead of a convention, so two concurrent `run` commands cannot both merge.
 */

export interface ProjectIntegrationView {
  readonly projectId: string;
  readonly projectServiceId: string;
  readonly integrationRef: string;
  readonly worktreePath: string | null;
  readonly ownershipToken: string;
  readonly integrationOid: string | null;
  readonly state: 'ACTIVE' | 'RECOVERY_REQUIRED';
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MergeQueueItemView {
  readonly id: string;
  readonly projectId: string;
  readonly projectServiceId: string;
  readonly taskId: string;
  readonly revisionId: string;
  readonly resultCommit: string;
  readonly taskVerificationRunId: string;
  readonly priority: number;
  readonly state: MergeQueueItemState;
  readonly candidateCommit: string | null;
  readonly expectedIntegrationOid: string | null;
  readonly releasedIntegrationOid: string | null;
  readonly attemptCount: number;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly conflictDetail: unknown;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly requestedAt: number;
  readonly updatedAt: number;
  readonly settledAt: number | null;
}

export interface IntegrationRunView {
  readonly id: string;
  readonly projectId: string;
  readonly queueItemId: string;
  readonly operationId: string;
  readonly candidateCommit: string;
  readonly expectedIntegrationOid: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly mainCommit: string;
  readonly commands: readonly unknown[];
  readonly copyPath: string;
  readonly state: 'QUEUED' | 'RUNNING' | 'PASSED' | 'FAILED' | 'ERROR' | 'CANCELLED';
  readonly outcomeCode: string | null;
  readonly evidence: unknown;
  readonly queuedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

export interface TaskIntegrationView {
  readonly taskId: string;
  readonly projectServiceId: string;
  readonly state: TaskIntegrationState;
  readonly queueItemId: string | null;
  readonly integrationOid: string | null;
  readonly version: number;
  readonly updatedAt: number;
}

interface ProjectIntegrationRow {
  project_id: string; project_service_id: string; integration_ref: string;
  worktree_path: string | null; ownership_token: string; integration_oid: string | null;
  state: 'ACTIVE' | 'RECOVERY_REQUIRED'; version: number; created_at: number; updated_at: number;
}
interface MergeQueueItemRow {
  id: string; project_id: string; project_service_id: string; task_id: string; revision_id: string;
  result_commit: string; task_verification_run_id: string; priority: number;
  state: MergeQueueItemState; candidate_commit: string | null; expected_integration_oid: string | null;
  released_integration_oid: string | null; attempt_count: number; last_error_code: string | null;
  last_error_message: string | null; conflict_detail_json: string | null; correlation_id: string;
  idempotency_key: string; requested_at: number; updated_at: number; settled_at: number | null;
}
interface IntegrationRunRow {
  id: string; project_id: string; queue_item_id: string; operation_id: string;
  candidate_commit: string; expected_integration_oid: string; policy_version: string;
  policy_digest: string; main_commit: string; commands_json: string; copy_path: string;
  state: IntegrationRunView['state']; outcome_code: string | null; evidence_json: string | null;
  queued_at: number; started_at: number | null; ended_at: number | null;
}
interface TaskIntegrationRow {
  task_id: string; project_service_id: string; state: TaskIntegrationState;
  queue_item_id: string | null; integration_oid: string | null; version: number; updated_at: number;
}

/** The Operation kind one integration attempt records (ADR-0019 / ADR-0074). */
export const integrateTaskOperationKind = 'INTEGRATE_TASK';

export class ManagedIntegrationError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = 'ManagedIntegrationError';
  }
}

export class ManagedIntegrationStore {
  readonly sqlite: Database;

  constructor(storage: Phase1Database) {
    this.sqlite = storage.sqlite;
  }

  /**
   * Records the Project Service's owned integration ref. Idempotent by project: a repeat returns the
   * existing row, and a repeat that names a different ref is refused instead of silently re-pointing
   * a ref whose history other rows already describe.
   */
  ensureProjectIntegration(input: {
    readonly projectId: string;
    readonly projectServiceId: string;
    readonly integrationRef: string;
    readonly ownershipToken: string;
    readonly now: number;
  }): { readonly integration: ProjectIntegrationView; readonly created: boolean } {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<ProjectIntegrationRow, [string]>(
        'SELECT * FROM project_integration WHERE project_id=?1').get(input.projectId);
      if (existing !== null) {
        if (existing.integration_ref !== input.integrationRef) {
          throw new ManagedIntegrationError('INTEGRATION_REF_CONFLICT',
            `Project ${input.projectId} already manages ${existing.integration_ref}, not`
            + ` ${input.integrationRef}`);
        }
        if (existing.project_service_id !== input.projectServiceId) {
          throw new ManagedIntegrationError('INTEGRATION_REF_CONFLICT',
            `Project ${input.projectId} is managed by Service ${existing.project_service_id}, not`
            + ` ${input.projectServiceId}`);
        }
        return { integration: mapProjectIntegration(existing), created: false };
      }
      const service = this.sqlite.query<{ kind: string; project_id: string | null }, [string]>(
        'SELECT kind,project_id FROM services WHERE id=?1').get(input.projectServiceId);
      if (service === null) {
        throw new KernelStorageError('SERVICE_NOT_FOUND',
          `Project Service ${input.projectServiceId} was not found`);
      }
      if (service.kind !== 'PROJECT' || service.project_id !== input.projectId) {
        throw new KernelStorageError('INVALID_SERVICE_PARENT',
          `Service ${input.projectServiceId} is ${service.kind}; a managed integration ref belongs to`
          + ' a PROJECT Service');
      }
      this.sqlite.query(`INSERT INTO project_integration(project_service_id,project_id,
        integration_ref,worktree_path,ownership_token,integration_oid,state,version,created_at,updated_at)
        VALUES (?1,?2,?3,NULL,?4,NULL,'ACTIVE',0,?5,?5)`)
        .run(input.projectServiceId, input.projectId, input.integrationRef, input.ownershipToken,
          input.now);
      const row = this.sqlite.query<ProjectIntegrationRow, [string]>(
        'SELECT * FROM project_integration WHERE project_id=?1').get(input.projectId);
      return { integration: mapProjectIntegration(row as ProjectIntegrationRow), created: true };
    })();
  }

  getProjectIntegration(projectId: string): ProjectIntegrationView | null {
    const row = this.sqlite.query<ProjectIntegrationRow, [string]>(
      'SELECT * FROM project_integration WHERE project_id=?1').get(projectId);
    return row === null ? null : mapProjectIntegration(row);
  }

  /** Records the worktree this Runtime created for the integration ref; CAS on the row version. */
  setProjectIntegrationWorktree(input: {
    readonly projectId: string; readonly worktreePath: string; readonly expectedVersion: number;
    readonly now: number;
  }): ProjectIntegrationView {
    return this.sqlite.transaction(() => {
      const current = this.requireProjectIntegration(input.projectId);
      requireVersion(current.version, input.expectedVersion);
      this.sqlite.query(`UPDATE project_integration SET worktree_path=?2,version=version+1,
        updated_at=?3 WHERE project_id=?1`)
        .run(input.projectId, input.worktreePath, Math.max(input.now, current.updatedAt));
      return this.requireProjectIntegration(input.projectId);
    })();
  }

  /**
   * Records the OID this Runtime last observed or advanced the ref to. This is bookkeeping, not the
   * authority: a caller that just read Git passes what it read.
   */
  recordIntegrationOid(input: {
    readonly projectId: string; readonly integrationOid: string; readonly expectedVersion: number;
    readonly now: number; readonly state?: 'ACTIVE' | 'RECOVERY_REQUIRED';
  }): ProjectIntegrationView {
    return this.sqlite.transaction(() => {
      const current = this.requireProjectIntegration(input.projectId);
      requireVersion(current.version, input.expectedVersion);
      this.sqlite.query(`UPDATE project_integration SET integration_oid=?2,state=?3,version=version+1,
        updated_at=?4 WHERE project_id=?1`)
        .run(input.projectId, input.integrationOid, input.state ?? current.state,
          Math.max(input.now, current.updatedAt));
      return this.requireProjectIntegration(input.projectId);
    })();
  }

  markIntegrationRecoveryRequired(input: {
    readonly projectId: string; readonly expectedVersion: number; readonly now: number;
  }): ProjectIntegrationView {
    return this.sqlite.transaction(() => {
      const current = this.requireProjectIntegration(input.projectId);
      requireVersion(current.version, input.expectedVersion);
      this.sqlite.query(`UPDATE project_integration SET state='RECOVERY_REQUIRED',version=version+1,
        updated_at=?2 WHERE project_id=?1`)
        .run(input.projectId, Math.max(input.now, current.updatedAt));
      return this.requireProjectIntegration(input.projectId);
    })();
  }

  /**
   * Enqueues one merge request. Idempotent by `(project, idempotencyKey)` and again by
   * `(task, revision)`: a Task Service that sends its request twice, or a CLI that is re-run after a
   * crash, converges on the item that already exists instead of queueing the same result twice.
   *
   * A live request for an *older* revision of the same Task cannot be merged any more — the Task has
   * moved on — so it is retired as `STALE` in the same transaction instead of merging a revision the
   * Task no longer claims.
   */
  enqueueMergeRequest(input: {
    readonly itemId: string; readonly projectId: string; readonly projectServiceId: string;
    readonly taskId: string; readonly revisionId: string; readonly resultCommit: string;
    readonly taskVerificationRunId: string;
    readonly priority: number; readonly correlationId: string; readonly idempotencyKey: string;
    readonly actor: string; readonly now: number; readonly nextEventId: () => string;
  }): { readonly item: MergeQueueItemView; readonly created: boolean } {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<MergeQueueItemRow, [string, string]>(
        'SELECT * FROM merge_queue_items WHERE project_id=?1 AND idempotency_key=?2')
        .get(input.projectId, input.idempotencyKey);
      if (existing !== null) return { item: mapQueueItem(existing), created: false };
      const live = this.sqlite.query<MergeQueueItemRow, [string, string]>(
        `SELECT * FROM merge_queue_items WHERE task_id=?1 AND revision_id=?2
          AND state IN ('QUEUED','MERGING','VERIFYING')`).get(input.taskId, input.revisionId);
      if (live !== null) return { item: mapQueueItem(live), created: false };
      const superseded = this.sqlite.query<MergeQueueItemRow, [string, string]>(
        `SELECT * FROM merge_queue_items WHERE task_id=?1 AND revision_id<>?2 AND state='QUEUED'
          ORDER BY requested_at,id`).all(input.taskId, input.revisionId);
      const now = input.now;
      for (const stale of superseded) {
        transitionMergeQueueItem(stale.state, 'STALE');
        this.sqlite.query(`UPDATE merge_queue_items SET state='STALE',settled_at=?2,updated_at=?2,
          last_error_code='SUPERSEDED_BY_NEWER_REVISION',
          last_error_message='A newer Task revision asked for integration' WHERE id=?1`)
          .run(stale.id, now);
        this.projectTask(stale.task_id, 'STALE', stale.id, null, now);
        this.insertEvent({ eventId: input.nextEventId(), projectId: input.projectId,
          eventType: 'TaskMergeRequestSuperseded', aggregateType: 'MergeQueueItem',
          aggregateId: stale.id, correlationId: input.correlationId, causationId: null,
          occurredAt: now, payload: { itemId: stale.id, taskId: stale.task_id,
            revisionId: stale.revision_id, supersededByRevisionId: input.revisionId } });
      }
      this.sqlite.query(`INSERT INTO merge_queue_items(id,project_id,project_service_id,task_id,
        revision_id,result_commit,task_verification_run_id,priority,state,candidate_commit,
        expected_integration_oid,released_integration_oid,attempt_count,last_error_code,
        last_error_message,conflict_detail_json,correlation_id,idempotency_key,requested_at,updated_at,
        settled_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'QUEUED',NULL,NULL,NULL,0,NULL,NULL,NULL,?9,?10,?11,?11,NULL)`)
        .run(input.itemId, input.projectId, input.projectServiceId, input.taskId, input.revisionId,
          input.resultCommit, input.taskVerificationRunId, input.priority,
          input.correlationId, input.idempotencyKey, now);
      this.projectTask(input.taskId, 'QUEUED', input.itemId, null, now);
      this.insertEvent({ eventId: input.nextEventId(), projectId: input.projectId,
        eventType: 'TaskMergeRequested', aggregateType: 'MergeQueueItem', aggregateId: input.itemId,
        correlationId: input.correlationId, causationId: null, occurredAt: now,
        payload: { itemId: input.itemId, taskId: input.taskId, revisionId: input.revisionId,
          resultCommit: input.resultCommit, taskVerificationRunId: input.taskVerificationRunId,
          priority: input.priority } });
      return { item: this.requireItem(input.projectId, input.itemId), created: true };
    })();
  }

  /** The next item a project may start, in the frozen order (priority desc, requested asc, id asc). */
  nextQueuedItem(projectId: string): MergeQueueItemView | null {
    const active = this.sqlite.query<MergeQueueItemRow, [string]>(
      `SELECT * FROM merge_queue_items WHERE project_id=?1 AND state IN ('MERGING','VERIFYING')
        ORDER BY requested_at,id LIMIT 1`).get(projectId);
    if (active !== null && holdsIntegrationSlot(active.state)) return null;
    const rows = this.sqlite.query<MergeQueueItemRow, [string]>(
      `SELECT * FROM merge_queue_items WHERE project_id=?1 AND state='QUEUED'`)
      .all(projectId).map(mapQueueItem)
      .sort((left, right) => compareMergeQueueOrder(
        { priority: left.priority, requestedAt: left.requestedAt, id: left.id },
        { priority: right.priority, requestedAt: right.requestedAt, id: right.id }));
    return rows[0] ?? null;
  }

  activeItem(projectId: string): MergeQueueItemView | null {
    const row = this.sqlite.query<MergeQueueItemRow, [string]>(
      `SELECT * FROM merge_queue_items WHERE project_id=?1 AND state IN ('MERGING','VERIFYING')
        ORDER BY requested_at,id LIMIT 1`).get(projectId);
    return row === null ? null : mapQueueItem(row);
  }

  /**
   * Claims the project's integration slot for one item. The partial unique index is what actually
   * serializes two concurrent commands: the loser of the race gets a SQLite constraint error, which
   * is turned into the honest answer ("someone else is integrating") instead of a second merge.
   */
  claimQueueItem(input: {
    readonly projectId: string; readonly itemId: string; readonly now: number;
    /** The integration ref OID read from Git at claim time; the merge is based on exactly this. */
    readonly expectedIntegrationOid: string;
  }): MergeQueueItemView {
    return this.sqlite.transaction(() => {
      const current = this.requireItem(input.projectId, input.itemId);
      transitionMergeQueueItem(current.state, 'MERGING');
      try {
        this.sqlite.query(`UPDATE merge_queue_items SET state='MERGING',attempt_count=attempt_count+1,
          expected_integration_oid=?3,last_error_code=NULL,last_error_message=NULL,updated_at=?2
          WHERE id=?1`)
          .run(input.itemId, Math.max(input.now, current.updatedAt), input.expectedIntegrationOid);
      } catch (error) {
        if (isConstraintViolation(error)) {
          throw new ManagedIntegrationError('INTEGRATION_ALREADY_ACTIVE',
            `Project ${input.projectId} already has an active integration`);
        }
        throw error;
      }
      const item = this.requireItem(input.projectId, input.itemId);
      this.projectTask(item.taskId, 'MERGING', item.id, null, input.now);
      return item;
    })();
  }

  /** Records the merge candidate and the exact integration OID it was based on. */
  recordCandidate(input: {
    readonly projectId: string; readonly itemId: string; readonly candidateCommit: string;
    readonly expectedIntegrationOid: string; readonly now: number;
  }): MergeQueueItemView {
    return this.sqlite.transaction(() => {
      const current = this.requireItem(input.projectId, input.itemId);
      if (current.state !== 'MERGING') {
        throw new ManagedIntegrationError('INVALID_MERGE_QUEUE_STATE',
          `Item ${input.itemId} is ${current.state}; a candidate is recorded while MERGING`);
      }
      this.sqlite.query(`UPDATE merge_queue_items SET candidate_commit=?2,expected_integration_oid=?3,
        updated_at=?4 WHERE id=?1`)
        .run(input.itemId, input.candidateCommit, input.expectedIntegrationOid,
          Math.max(input.now, current.updatedAt));
      return this.requireItem(input.projectId, input.itemId);
    })();
  }

  markItemVerifying(input: {
    readonly projectId: string; readonly itemId: string; readonly now: number;
  }): MergeQueueItemView {
    return this.sqlite.transaction(() => {
      const current = this.requireItem(input.projectId, input.itemId);
      transitionMergeQueueItem(current.state, 'VERIFYING');
      this.sqlite.query(`UPDATE merge_queue_items SET state='VERIFYING',updated_at=?2 WHERE id=?1`)
        .run(input.itemId, Math.max(input.now, current.updatedAt));
      const item = this.requireItem(input.projectId, input.itemId);
      this.projectTask(item.taskId, 'VERIFYING', item.id, null, input.now);
      return item;
    })();
  }

  /** Terminal settle of one item. `MERGED` requires the OID the ref was actually advanced to. */
  settleItem(input: {
    readonly projectId: string; readonly itemId: string;
    readonly outcome: 'MERGED' | 'CONFLICTED' | 'FAILED' | 'CANCELLED';
    readonly releasedIntegrationOid?: string | null; readonly errorCode?: string | null;
    readonly errorMessage?: string | null; readonly conflictDetail?: unknown;
    readonly now: number; readonly eventId: string;
  }): MergeQueueItemView {
    return this.sqlite.transaction(() => {
      const current = this.requireItem(input.projectId, input.itemId);
      transitionMergeQueueItem(current.state, input.outcome);
      const released = input.outcome === 'MERGED'
        ? (input.releasedIntegrationOid ?? current.candidateCommit)
        : null;
      if (input.outcome === 'MERGED' && released === null) {
        throw new ManagedIntegrationError('INVALID_MERGE_QUEUE_STATE',
          `Item ${input.itemId} cannot be MERGED without the commit the ref was advanced to`);
      }
      this.sqlite.query(`UPDATE merge_queue_items SET state=?2,released_integration_oid=?3,
        last_error_code=?4,last_error_message=?5,conflict_detail_json=?6,settled_at=?7,updated_at=?7
        WHERE id=?1`)
        .run(input.itemId, input.outcome, released, input.errorCode ?? null,
          input.errorMessage ?? null,
          input.conflictDetail === undefined ? null : json(input.conflictDetail),
          input.now);
      const item = this.requireItem(input.projectId, input.itemId);
      this.projectTask(item.taskId, taskIntegrationStateForQueueItem(input.outcome), item.id,
        input.outcome === 'MERGED' ? released : null, input.now);
      const eventType = input.outcome === 'MERGED' ? 'TaskMerged'
        : input.outcome === 'CONFLICTED' ? 'TaskIntegrationConflict' : 'TaskIntegrationFailed';
      this.insertEvent({ eventId: input.eventId, projectId: input.projectId, eventType,
        aggregateType: 'MergeQueueItem', aggregateId: item.id, correlationId: item.correlationId,
        causationId: null, occurredAt: input.now,
        payload: { itemId: item.id, taskId: item.taskId, revisionId: item.revisionId,
          state: input.outcome, candidateCommit: item.candidateCommit,
          releasedIntegrationOid: released, code: input.errorCode ?? null,
          message: input.errorMessage ?? null } });
      return item;
    })();
  }

  /** A retry re-queues a settled failed item; the attempt counter is what says how many were made. */
  retryItem(input: {
    readonly projectId: string; readonly itemId: string; readonly now: number;
  }): MergeQueueItemView {
    return this.sqlite.transaction(() => {
      const current = this.requireItem(input.projectId, input.itemId);
      transitionMergeQueueItem(current.state, 'QUEUED');
      this.sqlite.query(`UPDATE merge_queue_items SET state='QUEUED',candidate_commit=NULL,
        expected_integration_oid=NULL,released_integration_oid=NULL,last_error_code=NULL,
        last_error_message=NULL,conflict_detail_json=NULL,settled_at=NULL,updated_at=?2 WHERE id=?1`)
        .run(input.itemId, Math.max(input.now, current.updatedAt));
      const item = this.requireItem(input.projectId, input.itemId);
      this.projectTask(item.taskId, 'QUEUED', item.id, null, input.now);
      return item;
    })();
  }

  /**
   * Marks the long-command Operation of one integration run as needing reconciliation. Used by the
   * startup pass: a Runtime that died mid-verification cannot claim the command finished, and it must
   * not leave an `IN_PROGRESS` row that reads like a running command either.
   */
  markIntegrationRunOperationRecoveryRequired(input: {
    readonly runId: string; readonly detail: string; readonly now: number;
  }): void {
    const run = this.getIntegrationRun(input.runId);
    if (run === null || run.endedAt !== null) return;
    this.sqlite.query(`UPDATE operations SET state='RECONCILE_REQUIRED',result_json=?2,updated_at=?3
      WHERE id=?1 AND state IN ('PLANNED','IN_PROGRESS')`)
      .run(run.operationId, json({ integrationRunId: run.id, detail: input.detail }), input.now);
  }

  /** Retires a `RECOVERY_REQUIRED` item once the observed reality has been written down. */
  reconcileItem(input: {
    readonly projectId: string; readonly itemId: string;
    readonly outcome: 'MERGED' | 'FAILED' | 'CANCELLED' | 'QUEUED';
    readonly releasedIntegrationOid?: string | null; readonly errorCode: string;
    readonly errorMessage: string; readonly now: number; readonly eventId: string;
  }): MergeQueueItemView {
    if (input.outcome === 'QUEUED') {
      return this.retryItem({ projectId: input.projectId, itemId: input.itemId, now: input.now });
    }
    return this.settleItem({
      projectId: input.projectId, itemId: input.itemId, outcome: input.outcome,
      releasedIntegrationOid: input.releasedIntegrationOid ?? null,
      errorCode: input.errorCode, errorMessage: input.errorMessage, now: input.now,
      eventId: input.eventId,
    });
  }

  markRecoveryRequired(input: {
    readonly projectId: string; readonly itemId: string; readonly errorCode: string;
    readonly errorMessage: string; readonly now: number;
  }): MergeQueueItemView {
    return this.sqlite.transaction(() => {
      const current = this.requireItem(input.projectId, input.itemId);
      transitionMergeQueueItem(current.state, 'RECOVERY_REQUIRED');
      this.sqlite.query(`UPDATE merge_queue_items SET state='RECOVERY_REQUIRED',last_error_code=?2,
        last_error_message=?3,updated_at=?4 WHERE id=?1`)
        .run(input.itemId, input.errorCode, input.errorMessage, Math.max(input.now, current.updatedAt));
      const item = this.requireItem(input.projectId, input.itemId);
      this.projectTask(item.taskId, 'RECOVERY_REQUIRED', item.id, null, input.now);
      return item;
    })();
  }

  getItem(projectId: string, itemId: string): MergeQueueItemView | null {
    const row = this.sqlite.query<MergeQueueItemRow, [string, string]>(
      'SELECT * FROM merge_queue_items WHERE project_id=?1 AND id=?2').get(projectId, itemId);
    return row === null ? null : mapQueueItem(row);
  }

  /** The queue of one project, newest activity first; terminal items are included so history is read. */
  listQueue(projectId: string, limit = 100): readonly MergeQueueItemView[] {
    return this.sqlite.query<MergeQueueItemRow, [string, number]>(
      `SELECT * FROM merge_queue_items WHERE project_id=?1
        ORDER BY CASE state WHEN 'MERGING' THEN 0 WHEN 'VERIFYING' THEN 1 WHEN 'QUEUED' THEN 2
          ELSE 3 END, priority DESC, requested_at, id LIMIT ?2`)
      .all(projectId, limit).map(mapQueueItem);
  }

  listItemsForTask(taskId: string, limit = 50): readonly MergeQueueItemView[] {
    return this.sqlite.query<MergeQueueItemRow, [string, number]>(
      'SELECT * FROM merge_queue_items WHERE task_id=?1 ORDER BY requested_at DESC, id LIMIT ?2')
      .all(taskId, limit).map(mapQueueItem);
  }

  taskIntegration(taskId: string): TaskIntegrationView | null {
    const row = this.sqlite.query<TaskIntegrationRow, [string]>(
      'SELECT * FROM task_integration WHERE task_id=?1').get(taskId);
    return row === null ? null : mapTaskIntegration(row);
  }

  /** One Integration Verification run: it is created before any command is spawned. */
  insertIntegrationRun(input: {
    readonly id: string; readonly projectId: string; readonly queueItemId: string;
    readonly operationId: string; readonly candidateCommit: string;
    readonly expectedIntegrationOid: string; readonly policyVersion: string;
    readonly policyDigest: string; readonly mainCommit: string; readonly commands: readonly unknown[];
    readonly copyPath: string; readonly now: number;
  }): IntegrationRunView {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<IntegrationRunRow, [string, string]>(
        'SELECT * FROM integration_runs WHERE queue_item_id=?1 AND candidate_commit=?2')
        .get(input.queueItemId, input.candidateCommit);
      if (existing !== null) return mapIntegrationRun(existing);
      // The integration run and the long-command Operation that explains it are one write: the
      // schema makes the Operation a foreign key, so a run can never exist without its record. The
      // operation id is derived from the (item, candidate) pair, so a retried insert converges.
      const idempotencyKey = `integrate:${input.queueItemId}:${input.candidateCommit}`;
      const existingOperation = this.sqlite.query<{ id: string }, [string, string, string]>(`
        SELECT id FROM operations WHERE project_id=?1 AND kind=?2 AND idempotency_key=?3
      `).get(input.projectId, integrateTaskOperationKind, idempotencyKey);
      const operationId = existingOperation?.id ?? input.operationId;
      if (existingOperation === null) {
        this.sqlite.query(`INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,
          state,request_json,created_at,updated_at)
          VALUES (?1,?2,?3,?4,?5,'IN_PROGRESS',?6,?7,?7)`)
          .run(operationId, input.projectId, integrateTaskOperationKind, input.queueItemId,
            idempotencyKey,
            json({ queueItemId: input.queueItemId, candidateCommit: input.candidateCommit,
              expectedIntegrationOid: input.expectedIntegrationOid }),
            input.now);
      }
      this.sqlite.query(`INSERT INTO integration_runs(id,project_id,queue_item_id,operation_id,
        candidate_commit,expected_integration_oid,policy_version,policy_digest,main_commit,
        commands_json,copy_path,state,outcome_code,evidence_json,queued_at,started_at,ended_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'QUEUED',NULL,NULL,?12,NULL,NULL)`)
        .run(input.id, input.projectId, input.queueItemId, operationId, input.candidateCommit,
          input.expectedIntegrationOid, input.policyVersion, input.policyDigest, input.mainCommit,
          json(input.commands), input.copyPath, input.now);
      return mapIntegrationRun(this.sqlite.query<IntegrationRunRow, [string]>(
        'SELECT * FROM integration_runs WHERE id=?1').get(input.id) as IntegrationRunRow);
    })();
  }

  beginIntegrationRun(input: {
    readonly runId: string; readonly now: number;
  }): IntegrationRunView {
    return this.sqlite.transaction(() => {
      const current = this.requireIntegrationRun(input.runId);
      if (current.state !== 'QUEUED') return current;
      this.sqlite.query(`UPDATE integration_runs SET state='RUNNING',started_at=?2 WHERE id=?1`)
        .run(input.runId, Math.max(input.now, current.queuedAt));
      return this.requireIntegrationRun(input.runId);
    })();
  }

  settleIntegrationRun(input: {
    readonly runId: string; readonly state: 'PASSED' | 'FAILED' | 'ERROR' | 'CANCELLED';
    readonly outcomeCode: string; readonly evidence: unknown; readonly now: number;
  }): IntegrationRunView {
    return this.sqlite.transaction(() => {
      const current = this.requireIntegrationRun(input.runId);
      if (current.endedAt !== null) return current;
      this.sqlite.query(`UPDATE integration_runs SET state=?2,outcome_code=?3,evidence_json=?4,
        ended_at=?5 WHERE id=?1`)
        .run(input.runId, input.state, input.outcomeCode, json(input.evidence), input.now);
      // The long-command Operation ends with its run: leaving an `IN_PROGRESS` Operation behind a
      // finished integration verification would make `operation list` claim something is still
      // running. A cancel is a settled failure of the command, not a success.
      this.sqlite.query(`UPDATE operations SET state=?2,result_json=?3,updated_at=?4
        WHERE id=?1 AND state IN ('PLANNED','IN_PROGRESS')`)
        .run(current.operationId, input.state === 'PASSED' ? 'SUCCEEDED' : 'FAILED',
          json({ integrationRunId: current.id, outcome: input.state,
            outcomeCode: input.outcomeCode }), input.now);
      return this.requireIntegrationRun(input.runId);
    })();
  }

  getIntegrationRun(runId: string): IntegrationRunView | null {
    const row = this.sqlite.query<IntegrationRunRow, [string]>(
      'SELECT * FROM integration_runs WHERE id=?1').get(runId);
    return row === null ? null : mapIntegrationRun(row);
  }

  latestIntegrationRun(queueItemId: string): IntegrationRunView | null {
    const row = this.sqlite.query<IntegrationRunRow, [string]>(
      'SELECT * FROM integration_runs WHERE queue_item_id=?1 ORDER BY queued_at DESC LIMIT 1')
      .get(queueItemId);
    return row === null ? null : mapIntegrationRun(row);
  }

  /**
   * The Task's integration projection. A transition that the domain refuses (a Task cannot go from
   * `MERGED` back to `MERGING`) throws before anything is written, and a repeat of the state the row
   * already has does not bump its version — an idempotent command must not look like a new fact.
   */
  projectTask(
    taskId: string,
    state: TaskIntegrationState,
    queueItemId: string | null,
    integrationOid: string | null,
    now: number,
  ): TaskIntegrationView {
    const current = this.taskIntegration(taskId);
    if (current !== null && current.state === state && current.queueItemId === queueItemId) {
      return current;
    }
    if (current !== null) assertProjectionTransition(current.state, state);
    const version = (current?.version ?? -1) + 1;
    this.sqlite.query(`INSERT INTO task_integration(task_id,project_service_id,state,queue_item_id,
      integration_oid,version,updated_at)
      SELECT ?1,COALESCE(service.project_id,service.parent_service_id),?2,?3,?4,?5,?6
      FROM services service WHERE service.task_id=?1
      ON CONFLICT(task_id) DO UPDATE SET state=excluded.state,queue_item_id=excluded.queue_item_id,
        integration_oid=excluded.integration_oid,version=excluded.version,updated_at=excluded.updated_at`)
      .run(taskId, state, queueItemId, integrationOid, version, now);
    const written = this.taskIntegration(taskId);
    if (written === null) {
      throw new ManagedIntegrationError('TASK_SERVICE_NOT_FOUND',
        `Task ${taskId} has no Service row, so its integration projection cannot be written`);
    }
    return written;
  }

  private requireProjectIntegration(projectId: string): ProjectIntegrationView {
    const view = this.getProjectIntegration(projectId);
    if (view === null) {
      throw new ManagedIntegrationError('INTEGRATION_NOT_INITIALIZED',
        `Project ${projectId} has no managed integration ref record`);
    }
    return view;
  }

  private requireItem(projectId: string, itemId: string): MergeQueueItemView {
    const item = this.getItem(projectId, itemId);
    if (item === null) {
      throw new ManagedIntegrationError('MERGE_QUEUE_ITEM_NOT_FOUND',
        `Merge queue item ${itemId} was not found in project ${projectId}`);
    }
    return item;
  }

  private requireIntegrationRun(runId: string): IntegrationRunView {
    const run = this.getIntegrationRun(runId);
    if (run === null) {
      throw new ManagedIntegrationError('INTEGRATION_RUN_NOT_FOUND',
        `Integration verification run ${runId} was not found`);
    }
    return run;
  }

  private insertEvent(input: {
    readonly eventId: string; readonly projectId: string; readonly eventType: string;
    readonly aggregateType: string; readonly aggregateId: string; readonly correlationId: string;
    readonly causationId: string | null; readonly occurredAt: number; readonly payload: unknown;
  }): void {
    this.sqlite.query(`INSERT INTO domain_events(event_id,project_id,event_type,schema_version,
      aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
      VALUES (?1,?2,?3,1,?4,?5,0,?6,?7,?8,?9)`)
      .run(input.eventId, input.projectId, input.eventType, input.aggregateType, input.aggregateId,
        input.correlationId, input.causationId, input.occurredAt, json(input.payload));
  }
}

/**
 * The projection is derived from queue items, so it may only ever move forward through the queue
 * state machine (plus `NOT_REQUESTED → QUEUED` and the `→ STALE` supersede edge).
 */
function assertProjectionTransition(from: TaskIntegrationState, to: TaskIntegrationState): void {
  if (from === to) return;
  const allowed: Readonly<Record<TaskIntegrationState, readonly TaskIntegrationState[]>> = {
    NOT_REQUESTED: ['QUEUED'],
    // A cancelled request puts the Task back to "nothing was asked for": the queue item keeps the
    // history, the projection does not pretend an integration is pending.
    QUEUED: ['MERGING', 'STALE', 'NOT_REQUESTED'],
    MERGING: ['VERIFYING', 'CONFLICTED', 'FAILED', 'RECOVERY_REQUIRED'],
    VERIFYING: ['MERGED', 'FAILED', 'RECOVERY_REQUIRED'],
    MERGED: [], CONFLICTED: ['QUEUED'], FAILED: ['QUEUED'], STALE: [],
    RECOVERY_REQUIRED: ['MERGED', 'FAILED', 'QUEUED'],
  };
  if (!allowed[from].includes(to)) {
    throw new DomainError('INVALID_TASK_INTEGRATION_TRANSITION',
      `Cannot project a Task's integration state from ${from} to ${to}`);
  }
}

function requireVersion(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new ManagedIntegrationError('INTEGRATION_VERSION_CONFLICT',
      `Expected version ${expected} but the record is at ${actual}`);
  }
}

function isConstraintViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed|constraint failed/i.test(error.message);
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new ManagedIntegrationError('INVALID_JSON_VALUE', 'Value is not JSON serializable');
  }
  return encoded;
}

function mapProjectIntegration(row: ProjectIntegrationRow): ProjectIntegrationView {
  return Object.freeze({
    projectId: row.project_id,
    projectServiceId: row.project_service_id,
    integrationRef: row.integration_ref,
    worktreePath: row.worktree_path,
    ownershipToken: row.ownership_token,
    integrationOid: row.integration_oid,
    state: row.state,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapQueueItem(row: MergeQueueItemRow): MergeQueueItemView {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    projectServiceId: row.project_service_id,
    taskId: row.task_id,
    revisionId: row.revision_id,
    resultCommit: row.result_commit,
    taskVerificationRunId: row.task_verification_run_id,
    priority: row.priority,
    state: row.state,
    candidateCommit: row.candidate_commit,
    expectedIntegrationOid: row.expected_integration_oid,
    releasedIntegrationOid: row.released_integration_oid,
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    conflictDetail: row.conflict_detail_json === null ? null : JSON.parse(row.conflict_detail_json),
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  });
}

function mapIntegrationRun(row: IntegrationRunRow): IntegrationRunView {
  return Object.freeze({
    id: row.id,
    projectId: row.project_id,
    queueItemId: row.queue_item_id,
    operationId: row.operation_id,
    candidateCommit: row.candidate_commit,
    expectedIntegrationOid: row.expected_integration_oid,
    policyVersion: row.policy_version,
    policyDigest: row.policy_digest,
    mainCommit: row.main_commit,
    commands: JSON.parse(row.commands_json) as readonly unknown[],
    copyPath: row.copy_path,
    state: row.state,
    outcomeCode: row.outcome_code,
    evidence: row.evidence_json === null ? null : JSON.parse(row.evidence_json),
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  });
}

function mapTaskIntegration(row: TaskIntegrationRow): TaskIntegrationView {
  return Object.freeze({
    taskId: row.task_id,
    projectServiceId: row.project_service_id,
    state: row.state,
    queueItemId: row.queue_item_id,
    integrationOid: row.integration_oid,
    version: row.version,
    updatedAt: row.updated_at,
  });
}

/** True when this queue item is the one holding the project's integration slot. */
export function isActiveQueueItem(item: MergeQueueItemView): boolean {
  return holdsIntegrationSlot(item.state);
}

/**
 * True when nothing will move this item automatically any more. A `CONFLICTED`/`FAILED` item is
 * settled in that sense while still being retryable by an explicit command.
 */
export function isSettledQueueItem(item: MergeQueueItemView): boolean {
  return isSettledMergeQueueItemState(item.state);
}
