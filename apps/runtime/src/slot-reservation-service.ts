import { createHash } from 'node:crypto';
import {
  type CapacityWaitReason,
  type SlotReservationAcquisitionView,
  type SlotReservationDetailView,
  type SlotReservationReleaseView,
  type SlotReservationReconcileOutcomeView,
  type SlotReservationReconcileReport,
} from '@codeestra/contracts';
import { changeSetPaths, inspectChangeSet } from '@codeestra/git';
import { impactAnalyzerVersion } from '@codeestra/domain';
import {
  Phase1Database,
  SlotReservationError,
  StorageError,
  slotDependencyFingerprint,
  type ExecutionSlotReservationRecord,
  type SlotReservationAcquireInput,
  type SlotSnapshotRecheckInput,
  type TrustedProject,
} from '@codeestra/storage';
import { impactPolicyVersionKey, inspectImpactPolicy } from './impact-analysis-service.js';
import { isProcessRunning, readProcessStartToken } from './lifecycle.js';
import { assertDependenciesSatisfied } from './scheduler.js';
import { resolveTaskBaselineRepository, TaskBaselineError } from './task-baseline-service.js';

/**
 * Slot reservations: the primitive a scheduler reserves with before it prepares a workspace or
 * starts an agent (scheduler.md §3, FOUNDATION-054 / ADR-0032).
 *
 * What this service adds over the stored row:
 *
 * - **It decides nothing about dependencies.** The Git question ("is the pinned upstream still
 *   reachable from `dev`") stays in the scheduler, which is why acquiring runs that guard first and
 *   then hands the *fingerprint of the dependency facts it assessed* to the storage layer, where it
 *   is re-read inside the write transaction. A graph or integration change in between is a refused
 *   acquisition, not a reservation on a stale assessment.
 * - **It verifies the real writer.** A reservation is a row in SQLite; an external process is not
 *   stopped by SQLite. So every reservation records its holder (Runtime boot + pid + OS start token),
 *   the analysis of "is that process still there" is a separate observation with a stable verdict,
 *   and nothing — not this service, not the startup reconcile — ever releases a slot from a guess.
 * - **It never releases on a timeout.** No heartbeat, no waiting duration and no disappearing client
 *   frees a slot. Release is explicit and audited, or it is the reconcile's decision after a holder
 *   was *proven* gone, and both are appended to the reservation's history.
 * - **It does not reserve on a stale assessment.** A reservation names the ImpactSnapshot it was
 *   assessed against, and the generation is rechecked: the mapping version, analyzer version and
 *   observed change set are read again here from Git, and the reused-row verdict (`isSnapshotCurrent`,
 *   ADR-0031 §6.3) plus the persisted facts are re-applied inside the reservation's immediate
 *   transaction. "SAFE a moment ago" is therefore not silently read as "SAFE now": a revision, a
 *   baseline, a mapping, an analyzer or a change set that moved is a refusal with no reservation row.
 *   The recheck decides *freshness*, never the verdict — a re-analysis is the engine's job, not this
 *   service's (scheduler.md §2, §7.6).
 */
export type SlotHolderObservationState = 'HOLDER_STOPPED' | 'HOLDER_PROCESS_ID_REUSED'
  | 'HOLDER_STILL_RUNNING' | 'HOLDER_OWNERSHIP_UNVERIFIABLE' | 'PROCESS_IDENTITY_MISSING';

export interface SlotHolderObservation {
  readonly state: SlotHolderObservationState;
  /** The recorded holder pid, echoed so an audit row never has to guess which process it describes. */
  readonly pid: number | null;
  readonly recordedStartToken: string | null;
  readonly observedStartToken: string | null;
  readonly detail: string;
}

export type SlotHolderInspector =
  (reservation: ExecutionSlotReservationRecord) => Promise<SlotHolderObservation>;

/**
 * Decides whether a recorded holder is still the process it claims to be. A PID is reusable, so a
 * live PID alone proves nothing: the recorded OS start token must match, and every branch that
 * cannot compare the two returns `UNVERIFIABLE` rather than assuming the holder is gone.
 */
export async function inspectSlotHolder(
  reservation: ExecutionSlotReservationRecord,
  readStartToken: (pid: number) => Promise<string | null> = readProcessStartToken,
  isRunning: (pid: number) => Promise<boolean> = isProcessRunning,
): Promise<SlotHolderObservation> {
  const pid = reservation.holder.pid;
  const recordedStartToken = reservation.holder.startToken;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: 'PROCESS_IDENTITY_MISSING', pid: null, recordedStartToken,
      observedStartToken: null,
      detail: 'the reservation recorded no usable holder process identity' };
  }
  let running: boolean;
  try {
    running = await isRunning(pid);
  } catch (error) {
    return { state: 'HOLDER_OWNERSHIP_UNVERIFIABLE', pid, recordedStartToken, observedStartToken: null,
      detail: `the process state of ${pid} could not be read: ${
        error instanceof Error ? error.message : String(error)}` };
  }
  if (!running) {
    return { state: 'HOLDER_STOPPED', pid, recordedStartToken, observedStartToken: null,
      detail: `no process with the recorded holder identity is running (pid ${pid}), so the recorded`
        + ' writer is gone' };
  }
  let observedStartToken: string | null;
  try {
    observedStartToken = await readStartToken(pid);
  } catch (error) {
    return { state: 'HOLDER_OWNERSHIP_UNVERIFIABLE', pid, recordedStartToken, observedStartToken: null,
      detail: `the start token of pid ${pid} could not be read: ${
        error instanceof Error ? error.message : String(error)}` };
  }
  if (recordedStartToken === null || observedStartToken === null) {
    return { state: 'HOLDER_OWNERSHIP_UNVERIFIABLE', pid, recordedStartToken, observedStartToken,
      detail: `pid ${pid} is alive but its identity cannot be compared with the recorded holder`
        + ' (a start token is missing), so ownership is unproven' };
  }
  if (observedStartToken === recordedStartToken) {
    return { state: 'HOLDER_STILL_RUNNING', pid, recordedStartToken, observedStartToken,
      detail: `the recorded holder process ${pid} is still running with the recorded start token; it`
        + ' was not signalled and its slot is not released' };
  }
  return { state: 'HOLDER_PROCESS_ID_REUSED', pid, recordedStartToken, observedStartToken,
    detail: `pid ${pid} is now a different process (start token ${observedStartToken} instead of`
      + ` ${recordedStartToken}), so the recorded holder is gone` };
}

/** A UUID derived from stable parts, so a replayed decision reuses one command identity. */
function derivedId(...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface SlotReservationServiceOptions {
  readonly storage: Phase1Database;
  /** Identity of the Runtime generation that owns reservations created by this process. */
  readonly bootId: string;
  readonly pid: number;
  /** Read once at construction and passed to every acquisition, so the row records real evidence. */
  readonly startToken: string | null;
  readonly draining: () => { readonly draining: boolean; readonly reason: string | null };
  /**
   * The Runtime's persistent global barrier (ADR-0061 D05/D08): a `reservations acquire` issued while
   * the host is paused must be refused **before** the slot transaction, not counted as a capacity
   * wait. Absent means "no global control plane". This is a pre-check and nothing else — it changes
   * no counting rule, which stays where it belongs.
   */
  readonly barrier?: () => { readonly blocked: boolean; readonly state: string };
  readonly inspectHolder?: SlotHolderInspector;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly logger?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

export class SlotReservationService {
  readonly #storage: Phase1Database;
  readonly #bootId: string;
  readonly #pid: number;
  readonly #startToken: string | null;
  readonly #draining: () => { readonly draining: boolean; readonly reason: string | null };
  readonly #barrier: (() => { readonly blocked: boolean; readonly state: string }) | null;
  readonly #inspectHolder: SlotHolderInspector;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #logger: (message: string, detail?: Readonly<Record<string, unknown>>) => void;

  constructor(options: SlotReservationServiceOptions) {
    this.#storage = options.storage;
    this.#bootId = options.bootId;
    this.#pid = options.pid;
    this.#startToken = options.startToken;
    this.#draining = options.draining;
    this.#barrier = options.barrier ?? null;
    this.#inspectHolder = options.inspectHolder ?? ((reservation) => inspectSlotHolder(reservation));
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#logger = options.logger ?? (() => {});
  }

  get bootId(): string {
    return this.#bootId;
  }

  /**
   * Acquires one slot for a Task, or reports the capacity wait that prevented it.
   *
   * The order is the one scheduler.md §2 prescribes: dependencies first (a Task that is waiting for an
   * upstream is `BLOCKED`, not capacity-waiting), then the compare-and-swap on the revision the caller
   * assessed, then the cached snapshot generation, then the reservation itself — which re-checks
   * everything inside one immediate transaction. A wait is returned as a *value*, never as an error: it
   * is a fact about capacity, and the reason codes are the ones a scheduler surfaces as waiting. A
   * refusal is an error, and a refusal writes nothing at all — not even a command receipt, so the same
   * command can be retried once the facts are current.
   *
   * When the caller names an ImpactSnapshot, this is also where the generation is rechecked: the
   * mapping version, analyzer version and observed change set are read again here, and the persisted
   * row, the Task revision and the worktree baseline are re-read inside the write transaction. A
   * generation that moved is `SNAPSHOT_STALE` with the components that moved, and one that cannot be
   * confirmed at all is `SNAPSHOT_UNAVAILABLE`; neither is ever treated as "still current".
   */
  async acquire(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedTaskVersion: number;
    readonly revisionId: string;
    readonly adapterId: string;
    readonly actor: string;
    readonly commandId: string;
    /**
     * The ImpactSnapshot this acquisition was assessed against. Absent or `null` means the caller
     * asserts no impact assessment at all (the shape of an explicitly released `UNKNOWN`, ADR-0030
     * D05); it never means "the snapshot is valid".
     */
    readonly impactSnapshotId?: string | null;
    /**
     * Explicit baseline ref this reservation is made against, for a **new** workspace (ADR-0060).
     * Absent or `null` means the project's default baseline: the dev clone's `dev` when one is
     * recorded, otherwise the project folder's currently checked out branch.
     */
    readonly baseRef?: string | null;
  }): Promise<SlotReservationAcquisitionView> {
    // Dependencies first, and through the scheduler's own guard: the verdict and the "just became
    // READY inside this command" reconciliation stay in one place instead of being reimplemented.
    await assertDependenciesSatisfied({
      storage: this.#storage, projectId: input.projectId, taskId: input.taskId,
    });
    const task = this.#storage.getTask(input.projectId, input.taskId);
    if (task === null) throw new StorageError('NOT_FOUND', 'Task was not found in this project');
    if (task.currentRevision.id !== input.revisionId) {
      throw new SlotReservationError('REVISION_CHANGED',
        `Task revision is ${task.currentRevision.id}, not the assessed ${input.revisionId}`);
    }
    if (task.state !== 'READY') {
      throw new SlotReservationError('TASK_NOT_RESERVABLE',
        `A slot can only be reserved for a READY Task; this Task is ${task.state}`);
    }
    const facts = this.#storage.listTaskDependencyFacts(input.projectId, { taskId: input.taskId });
    const dependencyFingerprint = slotDependencyFingerprint(facts);
    const project = this.#storage.getTrustedProject(input.projectId);
    // ADR-0060: the baseline is the one this Task would start from — the dev clone's `dev` when one is
    // recorded, otherwise the project folder's checked out branch (or the caller's explicit
    // `--base-ref`) — and it is resolved **before** this command writes a reservation, so a project
    // whose baseline cannot be named is refused without leaving a slot behind.
    const baseline = await resolveTaskBaselineRepository(project, { baseRef: input.baseRef ?? null });
    // Recorded as the baseline this assessment was made against. The dependency verdict itself was
    // decided by the guard above from the same ref; a ref that moves between the two reads is
    // therefore recorded honestly as "assessed against this commit", and the engine re-checks the
    // external baseline before it starts an agent (scheduler.md §2).
    const assessedDevCommit = baseline.baseCommit;
    // Anything the caller assessed against a cached snapshot generation is rechecked against the
    // generation observed *now*: the mapping version, the analyzer version and the Task's change set
    // (or, before a worktree exists, its empty observation against the development baseline) are read
    // here, and the persisted facts are re-read again inside the write transaction below.
    const snapshotRecheck = input.impactSnapshotId === undefined || input.impactSnapshotId === null
      ? null
      : await this.#observeSnapshotGeneration({
        project,
        projectId: input.projectId,
        taskId: input.taskId,
        snapshotId: input.impactSnapshotId,
        baseRef: input.baseRef ?? null,
      });
    const reservationId = this.#randomUUID();
    const acquisition: SlotReservationAcquireInput = {
      projectId: input.projectId,
      taskId: input.taskId,
      reservationId,
      expectedTaskVersion: input.expectedTaskVersion,
      expectedRevisionId: input.revisionId,
      adapterId: input.adapterId,
      workspaceId: null,
      impactSnapshotId: input.impactSnapshotId ?? null,
      snapshotRecheck,
      dependencyFingerprint,
      assessedDevCommit,
      holder: {
        bootId: this.#bootId,
        pid: this.#pid,
        startToken: this.#startToken,
        actor: input.actor,
      },
      // The Runtime's global barrier is fed through the same "no new reservation" input as draining,
      // because that input is *re-read inside the write transaction* — so a `pause` that commits
      // while this acquisition is in flight cannot slip a reservation past the barrier (ADR-0061 D05
      // step 1). It is not a capacity verdict: the wait below is rewritten to the barrier's own code.
      draining: () => {
        const barrier = this.#barrier?.();
        if (barrier?.blocked === true) {
          return { draining: true,
            reason: `the Runtime is globally ${barrier.state}, so no new slot is reserved and no`
              + ' Execution may start' };
        }
        return this.#draining();
      },
      commandId: input.commandId,
      payloadHash: derivedId('slot-acquire-payload', input.commandId, input.taskId, input.revisionId),
      eventId: this.#randomUUID(),
      createdAt: this.#now(),
    };
    const result = this.#storage.reserveExecutionSlot(acquisition);
    if (result.outcome === 'RESERVED') {
      return {
        outcome: 'RESERVED',
        capacity: result.capacity,
        wait: null,
        reservation: result.reservation,
        holderEvidence: [],
      };
    }
    // A wait is reported with the evidence of the slots that caused it: the recorded holders are
    // checked against the real process table, and a holder that is provably gone is *reported* here
    // — never released. Freeing it is the explicit release or the audited startup reconcile.
    const wait = result.wait as CapacityWaitReason;
    const holderEvidence = await this.#observeBlockingHolders(wait.blocking);
    if (result.outcome === 'DRAINING' && this.#barrier?.().blocked === true) {
      // The refusal above was the barrier, not a shutdown: report it with the barrier's own stable
      // code so a script can tell "the whole Runtime is paused" from "this Runtime is going down".
      return {
        outcome: 'CAPACITY_WAIT',
        capacity: result.capacity,
        wait: { ...wait, code: 'SCHEDULER_GLOBALLY_PAUSED',
          detail: `the Runtime is globally ${this.#barrier().state}, so no new slot is reserved and`
            + ' no Execution may start; the Task waits (it is not BLOCKED) until'
            + ' `scheduler control resume`' },
        reservation: null,
        holderEvidence,
      };
    }
    return {
      outcome: result.outcome === 'DRAINING' ? 'DRAINING' : 'CAPACITY_WAIT',
      capacity: result.capacity,
      wait,
      reservation: null,
      holderEvidence,
    };
  }

  /**
   * The generation of the ImpactSnapshot the caller named, as the facts are *now*.
   *
   * This is the impure half of the recheck (`scheduler.md` §2 "recheck cached snapshot generations"):
   * the mapping version comes from the project `main` ref, the change set from the Task's own owned
   * worktree (or the empty pre-start observation against the Task baseline ref), and the analyzer
   * version from this running binary. The judgment itself stays in the analyzer's pure
   * `recheckImpactSnapshotGeneration`, applied again inside the reservation transaction — so the
   * service never invents a rule the analyzer does not have.
   *
   * Every branch that cannot observe these facts refuses instead of assuming the snapshot is current:
   * "the mapping could not be read" and "the worktree could not be inspected" are not evidence that a
   * prediction still holds, and an unreadable snapshot is never treated as a valid one.
   */
  async #observeSnapshotGeneration(input: {
    readonly project: TrustedProject;
    readonly projectId: string;
    readonly taskId: string;
    readonly snapshotId: string;
    /** The explicit baseline the reservation was made against, if any (ADR-0060). */
    readonly baseRef: string | null;
  }): Promise<SlotSnapshotRecheckInput> {
    const refuse = (detail: string,
      extra: Readonly<Record<string, unknown>> = {}): SlotReservationError =>
      new SlotReservationError('SNAPSHOT_UNAVAILABLE',
        `ImpactSnapshot ${input.snapshotId} cannot be confirmed as current: ${detail}; nothing was`
        + ' reserved', { code: 'SNAPSHOT_UNAVAILABLE', snapshotId: input.snapshotId,
        taskId: input.taskId, ...extra });
    let policyVersion: string;
    try {
      policyVersion = impactPolicyVersionKey(await inspectImpactPolicy({
        repositoryRoot: input.project.repoRoot, mainRef: input.project.mainRef,
      }));
    } catch (error) {
      throw refuse(`the mapping at ${input.project.mainRef} could not be read (${
        error instanceof Error ? error.message : String(error)})`);
    }
    const workspace = this.#storage.getImpactCandidateTask(input.projectId, input.taskId);
    if (workspace !== null && workspace.workspacePath !== null
      && workspace.workspaceBaseCommit !== null) {
      let changeSet: Awaited<ReturnType<typeof inspectChangeSet>>;
      try {
        changeSet = await inspectChangeSet({
          workspacePath: workspace.workspacePath, baseCommit: workspace.workspaceBaseCommit,
        });
      } catch (error) {
        throw refuse(`the change set of worktree ${workspace.workspacePath} could not be inspected`
          + ` (${error instanceof Error ? error.message : String(error)})`,
        { workspacePath: workspace.workspacePath });
      }
      return {
        snapshotId: input.snapshotId,
        files: changeSetPaths(changeSet),
        policyVersion,
        analyzerVersion: impactAnalyzerVersion,
        baselineSource: 'WORKSPACE',
        baseCommit: workspace.workspaceBaseCommit,
        changeFingerprint: changeSet.treeFingerprint,
      };
    }
    // No worktree yet: the observation a pre-start prediction was made from is "this Task has not
    // changed anything, against the baseline it would start from".
    // ADR-0060: resolved with the same baseline the prediction used, so a managed project is read from
    // its own folder and a baseline that cannot be named is refused rather than read as "no baseline".
    let baselineCommit: string;
    try {
      baselineCommit = (await resolveTaskBaselineRepository(input.project, {
        baseRef: input.baseRef,
      })).baseCommit;
    } catch (error) {
      if (error instanceof TaskBaselineError) {
        throw refuse(`the baseline could not be resolved as this Task's empty observation needs`
          + ` it (${error instanceof Error ? error.message : String(error)})`);
      }
      throw error;
    }
    return {
      snapshotId: input.snapshotId,
      files: Object.freeze([]),
      policyVersion,
      analyzerVersion: impactAnalyzerVersion,
      baselineSource: 'BASELINE_REF',
      baseCommit: baselineCommit,
      changeFingerprint: null,
    };
  }

  /**
   * Releases one reservation explicitly. The reason is required and recorded: a slot that becomes
   * free must be explainable later.
   *
   * A reservation held by *this* generation is released on its owner's word. Any other holder is
   * first inspected: a holder that is provably still running is refused (two writers must not be
   * assumed away), while a holder that is gone or unverifiable is released with the observation
   * appended — an explicit human decision may free a slot the reconcile had to keep occupied, and
   * the difference between the two is exactly the audit trail.
   */
  async release(input: {
    readonly projectId: string;
    readonly reservationId: string;
    readonly reason: string;
    readonly actor: string;
    readonly commandId: string;
  }): Promise<SlotReservationReleaseView> {
    const reservation = this.#storage.getSlotReservation(input.projectId, input.reservationId);
    let observation: SlotHolderObservation | null = null;
    if (reservation.state !== 'RELEASED' && reservation.holder.bootId !== this.#bootId) {
      observation = await this.#inspectHolder(reservation);
      if (observation.state === 'HOLDER_STILL_RUNNING') {
        throw new SlotReservationError('SLOT_HOLDER_STILL_RUNNING',
          `Reservation ${reservation.reservationId} is held by live process ${observation.pid}`
          + ` (boot ${reservation.holder.bootId}); it was not signalled and its slot stays occupied`);
      }
    }
    return this.#storage.releaseExecutionSlot({
      projectId: input.projectId,
      reservationId: input.reservationId,
      expectedReservationVersion: reservation.version,
      reason: input.reason,
      actor: input.actor,
      releaseKind: 'EXPLICIT',
      observation: observation?.state ?? null,
      evidence: {
        releasedByBootId: this.#bootId,
        recordedHolder: reservation.holder,
        holderObservation: observation,
      },
      eventId: this.#randomUUID(),
      commandId: input.commandId,
      payloadHash: derivedId('slot-release-payload', input.commandId, input.reservationId),
      at: this.#now(),
    });
  }

  list(input: {
    readonly projectId: string;
    readonly taskId?: string;
    readonly includeReleased?: boolean;
    readonly limit?: number;
  }): readonly ExecutionSlotReservationRecord[] {
    return this.#storage.listSlotReservations(input.projectId, {
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      includeReleased: input.includeReleased === true,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  }

  get(projectId: string, reservationId: string): SlotReservationDetailView {
    return this.#storage.getSlotReservation(projectId, reservationId);
  }

  /**
   * The startup/explicit reconcile (scheduler.md §3/§4).
   *
   * For every active reservation it asks one question — is the recorded holder process still the
   * process that created this reservation? — and then converges from that observation alone:
   *
   * - proven gone (no process, or the PID now belongs to a different start token): the reservation is
   *   recorded as released, with the observation and the reason appended. Nothing is deleted; the row
   *   and its history stay for audit.
   * - still running: kept, and the slot stays occupied. This generation did not create it and has no
   *   handle to it, and signalling a process on a suspicion is not an option.
   * - unverifiable (no start token to compare, or the process table cannot be read): kept occupied
   *   as `RECOVERY_REQUIRED`. This is the deliberate "do not let it through" case: an unverifiable
   *   writer might still be working in the workspace, so the slot is *not* freed for someone else.
   *
   * No process is ever signalled and no resource is ever deleted here. The command identity is
   * derived from this boot and the reservation, so running the reconcile twice inside one generation
   * appends no second observation and applies no second state change.
   */
  async reconcile(input: {
    readonly projectId?: string;
    readonly commandId: string;
    readonly actor: string;
  }): Promise<SlotReservationReconcileReport> {
    const reservations = this.#storage.listActiveSlotReservations()
      .filter((reservation) => input.projectId === undefined
        || reservation.projectId === input.projectId);
    const outcomes: SlotReservationReconcileOutcomeView[] = [];
    const notSignalled: { reservationId: string; pid: number }[] = [];
    for (const reservation of reservations) {
      const base = {
        reservationId: reservation.reservationId,
        taskId: reservation.taskId,
        previousState: reservation.state,
      };
      if (reservation.holder.bootId === this.#bootId) {
        outcomes.push({ ...base, outcome: 'SKIPPED_HELD_BY_RUNTIME', observation: null,
          state: reservation.state,
          detail: 'this Runtime generation created this reservation, so it is not converged by'
            + ' a reconcile' });
        continue;
      }
      const observation = await this.#inspectHolder(reservation);
      const decision = observation.state === 'HOLDER_STOPPED'
          || observation.state === 'HOLDER_PROCESS_ID_REUSED' ? 'RELEASE' as const
        : observation.state === 'HOLDER_STILL_RUNNING' ? 'KEEP_HELD' as const
          : 'MARK_RECOVERY_REQUIRED' as const;
      try {
        const outcome = this.#storage.recordSlotReservationReconcile({
          projectId: reservation.projectId,
          reservationId: reservation.reservationId,
          expectedReservationVersion: reservation.version,
          decision,
          observation: observation.state,
          releaseKind: decision === 'RELEASE'
            ? observation.state === 'HOLDER_PROCESS_ID_REUSED'
              ? 'RECONCILED_PROCESS_ID_REUSED' : 'RECONCILED_HOLDER_EXITED'
            : null,
          detail: observation.detail,
          evidence: {
            bootId: this.#bootId,
            recordedHolder: reservation.holder,
            holderObservation: observation,
            quiescenceProven: false,
            signalsSent: 0,
            resourcesDeleted: 0,
          },
          ledgerEventId: this.#randomUUID(),
          eventId: this.#randomUUID(),
          commandId: derivedId('slot-reconcile', this.#bootId, input.commandId,
            reservation.reservationId),
          payloadHash: derivedId('slot-reconcile-payload', input.commandId,
            reservation.reservationId),
          actor: input.actor,
          at: this.#now(),
        });
        if (observation.state !== 'HOLDER_STOPPED'
          && observation.state !== 'HOLDER_PROCESS_ID_REUSED') {
          notSignalled.push({ reservationId: reservation.reservationId, pid: observation.pid ?? 0 });
        }
        outcomes.push({ ...base, outcome: outcome.outcome, observation: observation.state,
          state: outcome.state, detail: observation.detail });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.#logger('a slot reservation could not be reconciled', {
          reservationId: reservation.reservationId, reason: detail,
        });
        outcomes.push({ ...base, outcome: 'FAILED', observation: observation.state,
          state: reservation.state, detail });
      }
    }
    return { bootId: this.#bootId, outcomes, notSignalled };
  }

  /** Live observations of the recorded holders of the slots that caused a wait. Read-only. */
  async #observeBlockingHolders(blocking: readonly string[]): Promise<
    readonly { readonly reservationId: string; readonly taskId: string;
      readonly observation: SlotHolderObservationState; readonly detail: string }[]
  > {
    // The blocking Tasks may now belong to *any* Project (ADR-0061 D01 counts the whole Runtime), so
    // the lookup is by Task across the active set instead of by Project: a Project-scoped read would
    // silently drop the occupant that actually caused the wait.
    const active = this.#storage.listActiveSlotReservations()
      .filter((reservation) => blocking.includes(reservation.taskId));
    const evidence: { reservationId: string; taskId: string;
      observation: SlotHolderObservationState; detail: string }[] = [];
    const byTask = new Map<string, ExecutionSlotReservationRecord>();
    for (const reservation of active) {
      if (!byTask.has(reservation.taskId)) byTask.set(reservation.taskId, reservation);
    }
    for (const taskId of blocking) {
      const reservation = byTask.get(taskId);
      if (reservation === undefined) continue;
      const observation = await this.#inspectHolder(reservation);
      evidence.push({
        reservationId: reservation.reservationId,
        taskId: reservation.taskId,
        observation: observation.state,
        detail: observation.detail,
      });
    }
    return evidence;
  }
}
