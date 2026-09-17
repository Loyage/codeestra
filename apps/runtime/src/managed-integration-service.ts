import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  taskMergeRequestedPayloadSchema,
  taskMergeSettledPayloadSchema,
  taskMergeSettledSubtype,
  taskMergeRequestedSubtype,
  verificationPolicyPath,
  verificationPolicyVersion,
  type TaskMergeRequestedPayload,
} from '@codeestra/contracts';
import {
  DomainError,
  managedIntegrationCandidateRef,
  managedIntegrationRef,
  taskIntegrationStates,
  type TaskIntegrationState,
} from '@codeestra/domain';
import {
  compareAndSwapRef,
  createRefIfAbsent,
  deleteRefIfUnchanged,
  ensureIntegrationWorktree,
  inspectIntegrationWorktree,
  inspectMergeState,
  inspectRepository,
  integrationWorktreePath,
  mergeCandidateIntoIntegration,
  readRefCommit,
  resetIntegrationWorktree,
  type MergeOutcome,
} from '@codeestra/git';
import {
  StorageError,
  integrateTaskOperationKind,
  type IntegrationRunView,
  type MergeQueueItemView,
  type Phase1Database,
  type ProjectIntegrationView,
} from '@codeestra/storage';
import { inspectVerificationPolicy, executeVerificationPolicy,
  type VerificationRunner } from './verification-service.js';

/**
 * Project-managed integration (ADR-0070 D07, roadmap S8, ADR-0074).
 *
 * The service owns the whole loop the ADR describes, in the order it describes it: validate the
 * request, enqueue it durably, serialize per project, merge in an owned worktree, run independent
 * Integration Verification on the candidate, and only then advance the integration ref with a
 * compare-and-swap. Every failure keeps its scene: a conflict stays in the worktree, a failed
 * verification keeps its candidate ref and copy, and an interrupted run becomes
 * `RECOVERY_REQUIRED` rather than being retried automatically.
 *
 * What this slice deliberately does **not** do, and what the CLI/docs must keep saying:
 *  - no Integration Process/Agent is created; a conflict is reported, never resolved by a model;
 *  - no publication of the integration ref to any user branch (ADR-0070 D07 excludes it);
 *  - no Attention row is created for a conflict, because v38's `attention_requests.session_id` is a
 *    non-null FK to an Agent session (the same boundary ADR-0072 D01 recorded). The conflict is a
 *    durable queue item, Task projection, domain event and `project integration status` field.
 */

export class ManagedIntegrationServiceError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = 'ManagedIntegrationServiceError';
  }
}

export interface ManagedIntegrationStatusView {
  readonly projectId: string;
  readonly projectServiceId: string;
  readonly integrationRef: string;
  readonly worktreePath: string | null;
  readonly ownershipToken: string;
  /** What Git says right now; `null` means the ref does not exist yet. */
  readonly currentOid: string | null;
  /** What this Runtime last recorded; a disagreement with `currentOid` is reported, not repaired. */
  readonly recordedOid: string | null;
  readonly refInSync: boolean;
  readonly worktree: {
    readonly state: 'OWNED' | 'MISSING' | 'FOREIGN' | 'UNCERTAIN';
    readonly headCommit: string | null;
    readonly evidence: string;
  };
  readonly activeItem: MergeQueueItemView | null;
  readonly queuedCount: number;
  readonly state: 'ACTIVE' | 'RECOVERY_REQUIRED';
  readonly needsAttention: boolean;
}

export interface MergeRunReport {
  /** `null` only for a `NOOP` report: nothing ran, so there is no item to report. */
  readonly item: MergeQueueItemView | null;
  readonly outcome: 'MERGED' | 'CONFLICTED' | 'FAILED' | 'NOOP';
  readonly candidateCommit: string | null;
  readonly integrationOid: string | null;
  readonly integrationVerification: {
    readonly runId: string;
    readonly operationId: string;
    readonly state: IntegrationRunView['state'] | null;
    readonly outcomeCode: string | null;
    readonly copyPath: string;
    readonly commandCount: number;
  } | null;
  readonly conflict: { readonly paths: readonly string[]; readonly detail: string | null } | null;
  readonly nextItemId: string | null;
  readonly detail: string | null;
}

export interface ManagedIntegrationServiceOptions {
  readonly storage: Phase1Database;
  /** `<CODEESTRA_HOME>/integration`: the Runtime-owned root of integration worktrees. */
  readonly integrationRoot: string;
  /** The verification copies root; a candidate is verified in its own detached copy. */
  readonly copiesRoot: string;
  readonly runner: VerificationRunner;
  readonly permissionMode: () => 'FULL' | 'STRICT';
  /**
   * Sends the `TASK_MERGE_SETTLED` notification. Optional so a test can drive the merge loop without
   * a dispatcher; when it is absent the settle facts are still written and the report says so.
   */
  readonly notifySettled?: (input: {
    readonly targetServiceId: string; readonly payload: unknown; readonly idempotencyKey: string;
    readonly correlationId: string; readonly causationId: string | null;
  }) => void;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly logger?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

export class ManagedIntegrationService {
  readonly #storage: Phase1Database;
  readonly #integrationRoot: string;
  readonly #copiesRoot: string;
  readonly #runner: VerificationRunner;
  readonly #permissionMode: () => 'FULL' | 'STRICT';
  readonly #notifySettled: ManagedIntegrationServiceOptions['notifySettled'];
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #logger: (message: string, detail?: Readonly<Record<string, unknown>>) => void;

  constructor(options: ManagedIntegrationServiceOptions) {
    this.#storage = options.storage;
    this.#integrationRoot = resolve(options.integrationRoot);
    this.#copiesRoot = resolve(options.copiesRoot);
    this.#runner = options.runner;
    this.#permissionMode = options.permissionMode;
    this.#notifySettled = options.notifySettled;
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#logger = options.logger ?? (() => {});
  }

  /**
   * Records the Project Service's managed ref and makes the ref itself exist. Called by
   * `project trust` and by `project integration init`; both are idempotent, so a second call is a
   * read. A project trusted before this schema existed is initialized here from the branch its
   * folder has checked out *right now* — the same baseline rule the Task path used before S8 — and
   * from then on the integration commit is what new Tasks are based on.
   */
  async initialize(input: { readonly projectId: string }): Promise<ManagedIntegrationStatusView> {
    const project = this.#storage.getTrustedProject(input.projectId);
    const now = this.#now();
    const repository = await inspectRepository(project.repoRoot);
    if (repository.headCommit === null) {
      throw new ManagedIntegrationServiceError('INTEGRATION_BASE_UNRESOLVED',
        `${project.repoRoot} has no resolvable HEAD, so the integration ref has no initial commit`);
    }
    const ref = await readRefCommit({ repositoryRoot: repository.repoRoot, ref: managedIntegrationRef });
    let initialOid = ref;
    if (initialOid === null) {
      const created = await createRefIfAbsent({
        repositoryRoot: repository.repoRoot, ref: managedIntegrationRef,
        commit: repository.headCommit,
      });
      initialOid = created.commit;
    }
    const ownershipToken = deterministicUuid(`codeestra/integration/${input.projectId}`);
    const ensured = this.#storage.managedIntegration.ensureProjectIntegration({
      projectId: input.projectId, projectServiceId: input.projectId,
      integrationRef: managedIntegrationRef, ownershipToken, now,
    });
    if (ensured.integration.integrationOid !== initialOid) {
      this.#storage.managedIntegration.recordIntegrationOid({
        projectId: input.projectId, integrationOid: initialOid,
        expectedVersion: ensured.integration.version, now,
      });
    }
    this.#logger('managed integration ref is initialized', {
      projectId: input.projectId, integrationRef: managedIntegrationRef, integrationOid: initialOid,
      created: ensured.created || ref === null,
    });
    return this.status({ projectId: input.projectId });
  }

  async status(input: { readonly projectId: string }): Promise<ManagedIntegrationStatusView> {
    const project = this.#storage.getTrustedProject(input.projectId);
    const record = this.#storage.managedIntegration.getProjectIntegration(input.projectId);
    const repository = await inspectRepository(project.repoRoot);
    const currentOid = await readRefCommit({
      repositoryRoot: repository.repoRoot, ref: managedIntegrationRef,
    });
    const worktreePath = record?.worktreePath
      ?? integrationWorktreePath({ integrationRoot: this.#integrationRoot, projectId: input.projectId });
    const worktree = await inspectIntegrationWorktree({
      repositoryRoot: repository.repoRoot, worktreePath,
    });
    const queue = this.#storage.managedIntegration.listQueue(input.projectId, 200);
    const activeItem = this.#storage.managedIntegration.activeItem(input.projectId);
    const queuedCount = queue.filter((item) => item.state === 'QUEUED').length;
    const conflicted = queue.find((item) => item.state === 'CONFLICTED'
      || item.state === 'RECOVERY_REQUIRED');
    return Object.freeze({
      projectId: input.projectId,
      projectServiceId: record?.projectServiceId ?? input.projectId,
      integrationRef: managedIntegrationRef,
      worktreePath,
      ownershipToken: record?.ownershipToken
        ?? deterministicUuid(`codeestra/integration/${input.projectId}`),
      currentOid,
      recordedOid: record?.integrationOid ?? null,
      refInSync: record !== null && record.integrationOid === currentOid,
      worktree: { state: worktree.state, headCommit: worktree.headCommit,
        evidence: worktree.evidence },
      activeItem,
      queuedCount,
      state: record?.state ?? 'ACTIVE',
      needsAttention: conflicted !== undefined || worktree.state === 'FOREIGN'
        || worktree.state === 'UNCERTAIN',
    });
  }

  /**
   * The `TASK_MERGE_REQUESTED` handler. It is the durable half of the flow: everything that can be
   * checked from the database is checked here, and nothing is merged. Preconditions are the ones
   * ADR-0070 D07 names — the Task revision really is the current one, the result commit was captured
   * for it, and a Task verification run passed for that exact commit.
   */
  handleMergeRequested(input: {
    readonly targetServiceId: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly payload: unknown;
  }): { readonly item: MergeQueueItemView; readonly created: boolean } {
    const payload: TaskMergeRequestedPayload = taskMergeRequestedPayloadSchema.parse(input.payload);
    const projectId = this.#projectIdOfService(input.targetServiceId);
    const task = this.#storage.getTask(projectId, payload.taskId);
    if (task === null) {
      throw new ManagedIntegrationServiceError('TASK_NOT_FOUND',
        `Task ${payload.taskId} does not belong to project ${projectId}`);
    }
    if (task.currentRevision.id !== payload.revisionId) {
      throw new ManagedIntegrationServiceError('MERGE_REQUEST_REVISION_STALE',
        `Task ${payload.taskId} is on revision ${task.currentRevision.id}, not on the requested`
        + ` ${payload.revisionId}; a merge request must name the current revision`);
    }
    const candidates = this.#storage.getVerificationCandidates(projectId, payload.taskId);
    const execution = candidates.executions.find((candidate) =>
      candidate.appliedRevisionId === payload.revisionId
      && candidate.resultCommit === payload.resultCommit);
    if (execution === undefined) {
      throw new ManagedIntegrationServiceError('MERGE_REQUEST_RESULT_MISSING',
        `No execution of Task ${payload.taskId} revision ${payload.revisionId} captured result`
        + ` commit ${payload.resultCommit}`);
    }
    const run = this.#storage.listVerificationRuns(projectId, payload.taskId).find((candidate) =>
      candidate.verificationId === payload.taskVerificationRunId);
    if (run === undefined) {
      throw new ManagedIntegrationServiceError('MERGE_REQUEST_VERIFICATION_MISSING',
        `Task verification run ${payload.taskVerificationRunId} was not found for this Task`);
    }
    if (run.state !== 'PASSED') {
      throw new ManagedIntegrationServiceError('MERGE_REQUEST_VERIFICATION_NOT_PASSED',
        `Task verification run ${run.verificationId} is ${run.state}, not PASSED`);
    }
    if (run.revisionId !== payload.revisionId || run.testedCommit !== payload.resultCommit) {
      throw new ManagedIntegrationServiceError('MERGE_REQUEST_VERIFICATION_MISMATCH',
        `Task verification run ${run.verificationId} judges revision ${run.revisionId} at`
        + ` ${run.testedCommit}, not revision ${payload.revisionId} at ${payload.resultCommit}`);
    }
    return this.#storage.managedIntegration.enqueueMergeRequest({
      itemId: this.#randomUUID(),
      projectId,
      projectServiceId: input.targetServiceId,
      taskId: payload.taskId,
      revisionId: payload.revisionId,
      resultCommit: payload.resultCommit,
      taskVerificationRunId: payload.taskVerificationRunId,
      priority: payload.priority,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      actor: 'signal-dispatcher',
      now: this.#now(),
      nextEventId: this.#randomUUID,
    });
  }

  /** Validates and enqueues a merge request from the CLI, through the same rules as the Signal. */
  request(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly revisionId?: string;
    readonly resultCommit?: string;
    readonly taskVerificationRunId?: string;
    readonly priority?: number;
    readonly commandId: string;
    readonly idempotencyKey?: string;
  }): { readonly item: MergeQueueItemView; readonly created: boolean;
    readonly status: ManagedIntegrationStatusView } {
    const task = this.#storage.getTask(input.projectId, input.taskId);
    if (task === null) {
      throw new ManagedIntegrationServiceError('TASK_NOT_FOUND',
        `Task ${input.taskId} was not found in project ${input.projectId}`);
    }
    const revisionId = input.revisionId ?? task.currentRevision.id;
    const runs = this.#storage.listVerificationRuns(input.projectId, input.taskId);
    const run = input.taskVerificationRunId === undefined
      ? latestPassedRun(runs, revisionId)
      : runs.find((candidate) => candidate.verificationId === input.taskVerificationRunId) ?? null;
    if (run === null) {
      throw new ManagedIntegrationServiceError('MERGE_REQUEST_VERIFICATION_MISSING',
        `Task ${input.taskId} has no PASSED verification run for revision ${revisionId}; verify the`
        + ' Task result before asking for integration');
    }
    const resultCommit = input.resultCommit ?? run.testedCommit;
    const enqueued = this.handleMergeRequested({
      targetServiceId: this.#projectServiceId(input.projectId),
      idempotencyKey: input.idempotencyKey ?? input.commandId,
      correlationId: input.commandId,
      payload: {
        taskId: input.taskId, revisionId, resultCommit,
        taskVerificationRunId: run.verificationId, priority: input.priority ?? 0,
      },
    });
    return { ...enqueued, status: this.#quickStatus(input.projectId) };
  }

  /**
   * Runs the head of one project's queue: merge, verify, CAS. `itemId` may name the head explicitly
   * (so a script can retry its own item) but never a different item — the queue order is the
   * project's, not the caller's.
   */
  async runNext(input: {
    readonly projectId: string;
    readonly itemId?: string;
    readonly actor: string;
  }): Promise<MergeRunReport> {
    const project = this.#storage.getTrustedProject(input.projectId);
    await this.initialize({ projectId: input.projectId });
    const head = this.#storage.managedIntegration.nextQueuedItem(input.projectId);
    if (head === null) {
      const active = this.#storage.managedIntegration.activeItem(input.projectId);
      if (active !== null) {
        throw new ManagedIntegrationServiceError('INTEGRATION_ALREADY_ACTIVE',
          `Project ${input.projectId} is already integrating item ${active.id} (${active.state})`);
      }
      const queue = this.#storage.managedIntegration.listQueue(input.projectId, 200);
      const recovery = queue.find((item) => item.state === 'RECOVERY_REQUIRED');
      if (recovery !== undefined) {
        throw new ManagedIntegrationServiceError('INTEGRATION_RECOVERY_REQUIRED',
          `Item ${recovery.id} is RECOVERY_REQUIRED; reconcile it before integrating again`);
      }
      // A conflict blocks this project's queue (ADR-0070 D07). Reporting "nothing to do" here would
      // let a script believe the project drained cleanly while a Task's result sits unmerged.
      const conflict = queue.find((item) => item.state === 'CONFLICTED');
      if (conflict !== undefined) {
        throw new ManagedIntegrationServiceError('INTEGRATION_CONFLICT_UNRESOLVED',
          `Item ${conflict.id} conflicted and blocks this project's queue; retry it (project`
          + ' integration retry) or cancel it before integrating again');
      }
      return this.#noopReport('The queue is empty');
    }
    if (input.itemId !== undefined && input.itemId !== head.id) {
      throw new ManagedIntegrationServiceError('INTEGRATION_ITEM_NOT_HEAD',
        `Item ${input.itemId} is not the head of the queue (${head.id} is); integrate in queue order`);
    }
    const repository = await inspectRepository(project.repoRoot);
    const currentOid = await readRefCommit({
      repositoryRoot: repository.repoRoot, ref: managedIntegrationRef,
    });
    if (currentOid === null) {
      throw new ManagedIntegrationServiceError('INTEGRATION_REF_MISSING',
        'The managed integration ref disappeared after it was initialized; nothing was merged');
    }
    const claimed = this.#storage.managedIntegration.claimQueueItem({
      projectId: input.projectId, itemId: head.id, now: this.#now(),
      expectedIntegrationOid: currentOid,
    });
    return this.#executeItem({ project, claimed, actor: input.actor });
  }

  /** Re-queues a `CONFLICTED`/`FAILED` item after putting the owned worktree back where it started. */
  async retry(input: {
    readonly projectId: string;
    readonly itemId: string;
    readonly actor: string;
  }): Promise<{ readonly item: MergeQueueItemView; readonly status: ManagedIntegrationStatusView }> {
    const item = this.#storage.managedIntegration.getItem(input.projectId, input.itemId);
    if (item === null) {
      throw new ManagedIntegrationServiceError('MERGE_QUEUE_ITEM_NOT_FOUND',
        `Merge queue item ${input.itemId} was not found in project ${input.projectId}`);
    }
    if (item.state !== 'CONFLICTED' && item.state !== 'FAILED') {
      throw new ManagedIntegrationServiceError('INVALID_MERGE_QUEUE_STATE',
        `Item ${input.itemId} is ${item.state}; only a CONFLICTED or FAILED item can be retried`);
    }
    const project = this.#storage.getTrustedProject(input.projectId);
    const repository = await inspectRepository(project.repoRoot);
    const currentOid = await readRefCommit({
      repositoryRoot: repository.repoRoot, ref: managedIntegrationRef,
    });
    await this.#resetWorktree({ repositoryRoot: repository.repoRoot, projectId: input.projectId,
      item, currentOid });
    if (item.candidateCommit !== null) {
      await deleteRefIfUnchanged({
        repositoryRoot: repository.repoRoot,
        ref: managedIntegrationCandidateRef(item.id),
        expectedOid: item.candidateCommit,
      });
    }
    const requeued = this.#storage.managedIntegration.retryItem({
      projectId: input.projectId, itemId: input.itemId, now: this.#now(),
    });
    return { item: requeued, status: await this.status({ projectId: input.projectId }) };
  }

  cancel(input: {
    readonly projectId: string; readonly itemId: string; readonly actor: string; readonly reason: string;
  }): { readonly item: MergeQueueItemView } {
    const item = this.#storage.managedIntegration.getItem(input.projectId, input.itemId);
    if (item === null) {
      throw new ManagedIntegrationServiceError('MERGE_QUEUE_ITEM_NOT_FOUND',
        `Merge queue item ${input.itemId} was not found in project ${input.projectId}`);
    }
    if (item.state !== 'QUEUED') {
      throw new ManagedIntegrationServiceError('INVALID_MERGE_QUEUE_STATE',
        `Item ${input.itemId} is ${item.state}; only a QUEUED item can be cancelled here`
        + ' (an active integration is stopped by resolving its state, not by deleting it)');
    }
    const cancelled = this.#storage.managedIntegration.settleItem({
      projectId: input.projectId, itemId: input.itemId, outcome: 'CANCELLED',
      errorCode: 'CANCELLED_BY_USER', errorMessage: input.reason, now: this.#now(),
      eventId: this.#randomUUID(),
    });
    return { item: cancelled };
  }

  /** The read side of the Task integration projection; absent means `NOT_REQUESTED`. */
  taskIntegration(input: { readonly projectId: string; readonly taskId: string }): {
    readonly taskId: string;
    readonly state: TaskIntegrationState;
    readonly queueItemId: string | null;
    readonly integrationOid: string | null;
    readonly version: number;
    readonly updatedAt: number | null;
    readonly items: readonly MergeQueueItemView[];
    readonly integrationRun: IntegrationRunView | null;
  } {
    const task = this.#storage.getTask(input.projectId, input.taskId);
    if (task === null) {
      throw new ManagedIntegrationServiceError('TASK_NOT_FOUND',
        `Task ${input.taskId} was not found in project ${input.projectId}`);
    }
    const projection = this.#storage.managedIntegration.taskIntegration(input.taskId);
    const items = this.#storage.managedIntegration.listItemsForTask(input.taskId);
    const latest = items[0] ?? null;
    const state: TaskIntegrationState = projection?.state ?? 'NOT_REQUESTED';
    if (!(taskIntegrationStates as readonly string[]).includes(state)) {
      throw new ManagedIntegrationServiceError('INVALID_TASK_INTEGRATION_STATE',
        `Task ${input.taskId} has an unknown integration state ${state}`);
    }
    return Object.freeze({
      taskId: input.taskId,
      state,
      queueItemId: projection?.queueItemId ?? null,
      integrationOid: projection?.integrationOid ?? null,
      version: projection?.version ?? 0,
      updatedAt: projection?.updatedAt ?? null,
      items,
      integrationRun: latest === null
        ? null
        : this.#storage.managedIntegration.latestIntegrationRun(latest.id),
    });
  }

  queue(input: { readonly projectId: string; readonly limit?: number }): {
    readonly projectId: string; readonly items: readonly MergeQueueItemView[] } {
    this.#storage.getTrustedProject(input.projectId);
    return Object.freeze({
      projectId: input.projectId,
      items: this.#storage.managedIntegration.listQueue(input.projectId, input.limit ?? 100),
    });
  }

  /** The projection a `TASK_MERGE_SETTLED` notification must agree with (see the kernel handler). */
  settledProjection(taskId: string): { readonly state: string; readonly version: number } | null {
    const projection = this.#storage.managedIntegration.taskIntegration(taskId);
    return projection === null ? null
      : { state: projection.state, version: projection.version };
  }

  /**
   * Startup reconciliation. An item that was `MERGING`/`VERIFYING` when the Runtime died is not
   * automatically re-run: the merge may have happened and the ref may or may not have moved, and
   * guessing would be exactly the "claim a result we did not verify" the ADR forbids. The item and
   * the project record are marked `RECOVERY_REQUIRED` with the facts that were observed, and the
   * scene (worktree, candidate ref, verification copy) stays on disk.
   */
  reconcileOnBoot(): { readonly recovered: readonly string[] } {
    const recovered: string[] = [];
    const rows = this.#storage.sqlite.query<{ id: string; project_id: string; state: string }, []>(`
      SELECT id,project_id,state FROM merge_queue_items
      WHERE state IN ('MERGING','VERIFYING') ORDER BY requested_at,id
    `).all();
    for (const row of rows) {
      // A verification that was mid-flight when the Runtime died leaves a run and an Operation; both
      // are recorded as needing reconciliation rather than as finished or still running.
      const latestRun = this.#storage.managedIntegration.latestIntegrationRun(row.id);
      if (latestRun !== null) {
        this.#storage.managedIntegration.markIntegrationRunOperationRecoveryRequired({
          runId: latestRun.id,
          detail: `the Runtime stopped while merge queue item ${row.id} was ${row.state}`,
          now: this.#now(),
        });
      }
      const projectRecord = this.#storage.managedIntegration.getProjectIntegration(row.project_id);
      if (projectRecord !== null) {
        this.#storage.managedIntegration.markIntegrationRecoveryRequired({
          projectId: row.project_id, expectedVersion: projectRecord.version, now: this.#now(),
        });
      }
      this.#storage.managedIntegration.markRecoveryRequired({
        projectId: row.project_id, itemId: row.id, errorCode: 'RUNTIME_RESTARTED',
        errorMessage: `The Runtime stopped while item ${row.id} was ${row.state}; the merge, its`
          + ' candidate ref and its verification copy are kept exactly as they were found',
        now: this.#now(),
      });
      recovered.push(row.id);
    }
    return Object.freeze({ recovered: Object.freeze(recovered) });
  }

  // ---------------------------------------------------------------------------------------------

  async #executeItem(input: {
    readonly project: { readonly id: string; readonly repoRoot: string; readonly mainRef: string };
    readonly claimed: MergeQueueItemView;
    readonly actor: string;
  }): Promise<MergeRunReport> {
    const item = input.claimed;
    const expectedIntegrationOid = item.expectedIntegrationOid as string;
    const worktreePath = this.#worktreePath(input.project.id);
    const record = this.#storage.managedIntegration.getProjectIntegration(input.project.id);
    let merge: MergeOutcome;
    try {
      await ensureIntegrationWorktree({
        repositoryRoot: input.project.repoRoot, worktreePath, commit: expectedIntegrationOid,
      });
      if (record !== null && record.worktreePath !== worktreePath) {
        this.#storage.managedIntegration.setProjectIntegrationWorktree({
          projectId: input.project.id, worktreePath, expectedVersion: record.version,
          now: this.#now(),
        });
      }
      merge = await mergeCandidateIntoIntegration({
        worktreePath,
        resultCommit: item.resultCommit,
        expectedIntegrationOid,
        message: `Integrate task ${item.taskId} revision ${item.revisionId}`
          + ` (result ${item.resultCommit.slice(0, 12)})`,
      });
    } catch (error) {
      const code = error instanceof DomainError ? error.code
        : (error as { code?: string }).code ?? 'INTEGRATION_MERGE_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.#storage.managedIntegration.settleItem({
        projectId: input.project.id, itemId: item.id, outcome: 'FAILED',
        errorCode: code, errorMessage: message, now: this.#now(), eventId: this.#randomUUID(),
      });
      return this.#report(failed, 'FAILED', null, null, null, message);
    }
    if (merge.outcome === 'CONFLICT') {
      const conflicted = this.#storage.managedIntegration.settleItem({
        projectId: input.project.id, itemId: item.id, outcome: 'CONFLICTED',
        errorCode: 'INTEGRATION_MERGE_CONFLICT',
        errorMessage: `The merge conflicts in ${merge.conflictedPaths.length} path(s); the conflicted`
          + ' integration worktree is kept until the item is retried or cancelled',
        conflictDetail: { paths: merge.conflictedPaths, detail: merge.detail },
        now: this.#now(), eventId: this.#randomUUID(),
      });
      this.#notify(conflicted);
      return this.#report(conflicted, 'CONFLICTED', null, null,
        { paths: merge.conflictedPaths, detail: merge.detail }, null);
    }
    const candidateCommit = merge.candidateCommit as string;
    await createRefIfAbsent({
      repositoryRoot: input.project.repoRoot,
      ref: managedIntegrationCandidateRef(item.id),
      commit: candidateCommit,
    });
    this.#storage.managedIntegration.recordCandidate({
      projectId: input.project.id, itemId: item.id, candidateCommit,
      expectedIntegrationOid, now: this.#now(),
    });
    const verifying = this.#storage.managedIntegration.markItemVerifying({
      projectId: input.project.id, itemId: item.id, now: this.#now(),
    });

    const verification = await this.#runIntegrationVerification({
      projectId: input.project.id,
      item: verifying,
      candidateCommit,
      expectedIntegrationOid,
    });
    if (verification.outcome !== 'PASSED') {
      const failed = this.#storage.managedIntegration.settleItem({
        projectId: input.project.id, itemId: item.id, outcome: 'FAILED',
        errorCode: verification.outcome,
        errorMessage: verification.detail
          ?? 'Integration verification did not pass; the candidate ref and its copy are kept',
        now: this.#now(), eventId: this.#randomUUID(),
      });
      this.#notify(failed);
      return this.#report(failed, 'FAILED', candidateCommit, null, null, verification.detail,
        verification.runId);
    }

    const swap = await compareAndSwapRef({
      repositoryRoot: input.project.repoRoot, ref: managedIntegrationRef,
      expectedOid: expectedIntegrationOid, newOid: candidateCommit,
    });
    if (!swap.advanced) {
      // The ref moved while the candidate was being verified. The candidate is real but must not be
      // forced in; the scene (candidate ref + copy) is kept and the item is reported as failed.
      const moved = this.#storage.managedIntegration.settleItem({
        projectId: input.project.id, itemId: item.id, outcome: 'FAILED',
        errorCode: 'INTEGRATION_REF_MOVED',
        errorMessage: `The integration ref moved to ${swap.currentOid ?? 'nothing'} while the`
          + ` candidate ${candidateCommit} was being verified; the ref was not advanced`,
        now: this.#now(), eventId: this.#randomUUID(),
      });
      this.#notify(moved);
      return this.#report(moved, 'FAILED', candidateCommit, null, null, swap.detail,
        verification.runId);
    }
    const settled = this.#storage.managedIntegration.settleItem({
      projectId: input.project.id, itemId: item.id, outcome: 'MERGED',
      releasedIntegrationOid: candidateCommit, now: this.#now(), eventId: this.#randomUUID(),
    });
    const latestRecord = this.#storage.managedIntegration.getProjectIntegration(input.project.id);
    if (latestRecord !== null && latestRecord.integrationOid !== candidateCommit) {
      this.#storage.managedIntegration.recordIntegrationOid({
        projectId: input.project.id, integrationOid: candidateCommit,
        expectedVersion: latestRecord.version, now: this.#now(),
      });
    }
    // The candidate is now reachable from the managed ref, so the temporary ref has done its job.
    await deleteRefIfUnchanged({
      repositoryRoot: input.project.repoRoot,
      ref: managedIntegrationCandidateRef(item.id), expectedOid: candidateCommit,
    });
    this.#notify(settled);
    const next = this.#storage.managedIntegration.nextQueuedItem(input.project.id);
    return this.#report(settled, 'MERGED', candidateCommit, candidateCommit, null, null,
      verification.runId, next?.id ?? null);
  }

  async #runIntegrationVerification(input: {
    readonly projectId: string;
    readonly item: MergeQueueItemView;
    readonly candidateCommit: string;
    readonly expectedIntegrationOid: string;
  }): Promise<{ readonly outcome: 'PASSED' | 'INTEGRATION_POLICY_ABSENT' | 'FAILED'
    | 'VERIFICATION_REFUSED'; readonly detail: string | null; readonly runId: string | null }> {
    const project = this.#storage.getTrustedProject(input.projectId);
    const inspection = await inspectVerificationPolicy({
      repositoryRoot: project.repoRoot, mainRef: project.mainRef,
    });
    if (inspection.state !== 'PRESENT') {
      return { outcome: 'INTEGRATION_POLICY_ABSENT', runId: null,
        detail: `No verification policy at ${project.mainRef}:${verificationPolicyPath}, so the`
          + ' merged candidate cannot be judged; add one and re-trust the project' };
    }
    if (this.#permissionMode() === 'STRICT') {
      const confirmation = this.#storage.getConfirmedVerificationPolicy(input.projectId);
      if (confirmation === null || confirmation.state !== 'PRESENT'
        || confirmation.digest !== inspection.digest) {
        return { outcome: 'VERIFICATION_REFUSED', runId: null,
          detail: 'STRICT requires the project\'s confirmed verification policy; run project trust'
            + ' to confirm the current digest' };
      }
    }
    const runId = this.#randomUUID();
    const operationId = this.#randomUUID();
    const copyPath = join(this.#copiesRoot, input.projectId, runId);
    const run = this.#storage.managedIntegration.insertIntegrationRun({
      id: runId, projectId: input.projectId, queueItemId: input.item.id,
      operationId, candidateCommit: input.candidateCommit,
      expectedIntegrationOid: input.expectedIntegrationOid,
      policyVersion: verificationPolicyVersion, policyDigest: inspection.digest as string,
      mainCommit: inspection.mainCommit, commands: inspection.policy?.commands ?? [],
      copyPath, now: this.#now(),
    });
    this.#storage.managedIntegration.beginIntegrationRun({ runId, now: this.#now() });
    const execution = await executeVerificationPolicy({
      repositoryRoot: project.repoRoot,
      copiesRoot: this.#copiesRoot,
      projectId: input.projectId,
      runId,
      testedCommit: input.candidateCommit,
      commands: run.commands as readonly { id: string; argv: readonly string[]; cwd: string;
        timeoutSeconds: number }[],
      runner: this.#runner,
    });
    const state = execution.terminalState === 'PASSED' ? 'PASSED' : execution.terminalState;
    this.#storage.managedIntegration.settleIntegrationRun({
      runId, state, outcomeCode: execution.outcomeCode,
      evidence: {
        commandCount: execution.outcomes.length,
        commands: execution.outcomes.map((outcome) => ({
          id: outcome.id, exitCode: outcome.exitCode, timedOut: outcome.timedOut,
          durationMs: outcome.durationMs, stdoutBytes: outcome.stdoutBytes,
          stderrBytes: outcome.stderrBytes, stdoutDigest: outcome.stdoutDigest,
          stderrDigest: outcome.stderrDigest,
        })),
        tree: execution.tree,
        copyRemoved: execution.copyRemoval.removed,
        copyDetail: execution.copyRemoval.detail,
      },
      now: this.#now(),
    });
    if (state !== 'PASSED') {
      return { outcome: 'FAILED', runId,
        detail: `Integration verification ${execution.outcomeCode}`
          + (execution.failureDetail === null ? '' : `: ${execution.failureDetail}`) };
    }
    return { outcome: 'PASSED', runId, detail: null };
  }

  /** Puts the owned integration worktree back on the integration ref before a retry re-queues. */
  async #resetWorktree(input: {
    readonly repositoryRoot: string;
    readonly projectId: string;
    readonly item: MergeQueueItemView;
    readonly currentOid: string | null;
  }): Promise<void> {
    if (input.currentOid === null) return;
    const worktreePath = this.#worktreePath(input.projectId);
    const fact = await inspectIntegrationWorktree({
      repositoryRoot: input.repositoryRoot, worktreePath,
    });
    if (fact.state !== 'OWNED') return;
    // A conflicted merge leaves `HEAD` on the integration commit, so "HEAD already matches" is not
    // enough to conclude the worktree is clean: the in-progress merge has to be aborted too.
    const mergeState = await inspectMergeState(worktreePath);
    if (!mergeState.merging && fact.headCommit === input.currentOid) return;
    await resetIntegrationWorktree({
      worktreePath,
      expectedHead: fact.headCommit as string,
      commit: input.currentOid,
    });
  }

  #notify(item: MergeQueueItemView): void {
    if (this.#notifySettled === undefined) return;
    const projection = this.#storage.managedIntegration.taskIntegration(item.taskId);
    const payload = taskMergeSettledPayloadSchema.parse({
      taskId: item.taskId,
      queueItemId: item.id,
      state: taskMergeSettledStatesFor(item),
      integrationOid: item.state === 'MERGED' ? item.releasedIntegrationOid : null,
      projectionVersion: projection?.version ?? 0,
    });
    try {
      this.#notifySettled({
        targetServiceId: item.taskId,
        payload,
        idempotencyKey: `merge-settled:${item.id}`,
        correlationId: item.correlationId,
        causationId: null,
      });
    } catch (error) {
      // A notification that cannot be enqueued must not undo a merge that already happened; the
      // queue item and the Task projection are the facts, the Signal is how the Task Service hears.
      this.#logger('TASK_MERGE_SETTLED notification could not be enqueued', {
        taskId: item.taskId, itemId: item.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #report(item: MergeQueueItemView, outcome: MergeRunReport['outcome'],
    candidateCommit: string | null, integrationOid: string | null,
    conflict: MergeRunReport['conflict'], detail: string | null,
    runId: string | null = null, nextItemId: string | null = null): MergeRunReport {
    const run = runId === null ? null : this.#storage.managedIntegration.getIntegrationRun(runId);
    return Object.freeze({
      item,
      outcome,
      candidateCommit,
      integrationOid,
      integrationVerification: run === null ? null : {
        runId: run.id, operationId: run.operationId, state: run.state, outcomeCode: run.outcomeCode,
        copyPath: run.copyPath, commandCount: run.commands.length,
      },
      conflict,
      nextItemId,
      detail,
    });
  }

  #noopReport(detail: string): MergeRunReport {
    return Object.freeze({
      item: null,
      outcome: 'NOOP' as const,
      candidateCommit: null,
      integrationOid: null,
      integrationVerification: null,
      conflict: null,
      nextItemId: null,
      detail,
    });
  }

  #worktreePath(projectId: string): string {
    return integrationWorktreePath({ integrationRoot: this.#integrationRoot, projectId });
  }

  #quickStatus(projectId: string): ManagedIntegrationStatusView {
    const record = this.#storage.managedIntegration.getProjectIntegration(projectId);
    const worktreePath = record?.worktreePath
      ?? integrationWorktreePath({ integrationRoot: this.#integrationRoot, projectId });
    const queue = this.#storage.managedIntegration.listQueue(projectId, 200);
    return Object.freeze({
      projectId,
      projectServiceId: record?.projectServiceId ?? projectId,
      integrationRef: managedIntegrationRef,
      worktreePath,
      ownershipToken: record?.ownershipToken ?? deterministicUuid(`codeestra/integration/${projectId}`),
      currentOid: record?.integrationOid ?? null,
      recordedOid: record?.integrationOid ?? null,
      refInSync: true,
      worktree: { state: 'MISSING' as const, headCommit: null,
        evidence: 'not-inspected: this view comes from the request that just enqueued an item' },
      activeItem: this.#storage.managedIntegration.activeItem(projectId),
      queuedCount: queue.filter((item) => item.state === 'QUEUED').length,
      state: record?.state ?? 'ACTIVE',
      needsAttention: false,
    });
  }

  #projectIdOfService(serviceId: string): string {
    const row = this.#storage.sqlite.query<{ project_id: string | null; kind: string }, [string]>(
      'SELECT project_id,kind FROM services WHERE id=?1').get(serviceId);
    if (row === null || row.kind !== 'PROJECT' || row.project_id === null) {
      throw new ManagedIntegrationServiceError('SERVICE_NOT_FOUND',
        `Service ${serviceId} is not a PROJECT Service, so it has no managed integration ref`);
    }
    return row.project_id;
  }

  #projectServiceId(projectId: string): string {
    const row = this.#storage.sqlite.query<{ id: string }, [string]>(
      "SELECT id FROM services WHERE project_id=?1 AND kind='PROJECT'").get(projectId);
    if (row === null) {
      throw new ManagedIntegrationServiceError('SERVICE_NOT_FOUND',
        `Project ${projectId} has no PROJECT Service; re-trust it before integrating`);
    }
    return row.id;
  }
}

/** The newest PASSED run of one revision, or null when the revision was never verified. */
function latestPassedRun(
  runs: readonly { verificationId: string; revisionId: string; state: string;
    testedCommit: string; endedAt: number | null }[],
  revisionId: string,
): { verificationId: string; revisionId: string; testedCommit: string } | null {
  const passed = runs.filter((run) => run.revisionId === revisionId && run.state === 'PASSED')
    .sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0));
  return passed[0] ?? null;
}

/**
 * The Terminal `TASK_MERGE_SETTLED` state. `CANCELLED` is never sent — a cancelled queue item did
 * not settle an integration — so the notification vocabulary is the four states a Task Service can
 * act on.
 */
function taskMergeSettledStatesFor(item: MergeQueueItemView): 'MERGED' | 'CONFLICTED' | 'FAILED' {
  if (item.state === 'MERGED') return 'MERGED';
  if (item.state === 'CONFLICTED') return 'CONFLICTED';
  return 'FAILED';
}

function deterministicUuid(seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Kept importable so the signal subtypes and this service cannot drift apart. */
export { taskMergeRequestedSubtype, taskMergeSettledSubtype, integrateTaskOperationKind };
export type { ProjectIntegrationView, StorageError };
