import { createHash } from 'node:crypto';
import {
  impactPolicyContentDigest,
  type CapacityWaitReasonCode,
  type ImpactPolicyInspection,
  type ProjectCapacityView,
  type ScheduleAssessmentView,
  type ScheduleCandidateView,
  type ScheduleConflictHitView,
  type ScheduleDisposition,
  type ScheduleExplanationView,
  type ScheduleImpactGrowthView,
  type ScheduleOccupierView,
  type ScheduleOverviewView,
  type ScheduleProjectReport,
  type ScheduleStartOutcomeView,
  type ScheduleTickReport,
  type ScheduleUnknownReleaseView,
  type ScheduleWaitView,
} from '@codeestra/contracts';
import {
  assessCandidate,
  createImpactSnapshot,
  explainAssessment,
  impactAnalyzerVersion,
  type ConflictAssessment,
  type ImpactAssessmentContext,
  type ImpactHit,
  type ImpactPathCaseMode,
  type ImpactReasonCode,
  type ImpactSubject,
  impactReasonClass,
} from '@codeestra/domain';
import {
  Phase1Database,
  SlotReservationError,
  StorageError,
  type ConfirmedImpactPolicy,
  type ImpactActiveTaskRef,
  type ImpactSnapshotRecord,
  type StoredEventEnvelope,
  type TaskDependencyBlockReason,
  type TaskLifecycleState,
  type TaskSummary,
  type TrustedProject,
} from '@codeestra/storage';
import { capacityWaitReason, inspectProjectCapacity } from './capacity-service.js';
import {
  detectImpactPathCaseMode,
  impactPolicyVersionKey,
  inspectImpactPolicy,
  inspectTaskImpact,
  occupierCodeOf,
  observeWorkspacePath,
  toDomainSnapshot,
  type ImpactPathCaseDetection,
} from './impact-analysis-service.js';
import { inspectTaskDependencies, reconcileTaskDependencyState } from './scheduler.js';
import { resolveTaskBaselineRepository, TaskBaselineError,
  type TaskBaselineRepository } from './dev-repo-service.js';
import type { SlotReservationService } from './slot-reservation-service.js';

/**
 * The scheduling engine (Phase 2, FOUNDATION-055 / ADR-0030 D04).
 *
 * It is the only place that decides *which* Task runs *now*. The pieces it composes already existed
 * and are used, not re-implemented:
 *
 *  - `scheduler.ts` (ADR-0024) owns the dependency verdict: an unmet dependency — including an
 *    upstream commit that is no longer reachable from `dev` — is `BLOCKED` and stays `BLOCKED`.
 *  - `impact-analysis-service.ts` (ADR-0031) owns the conflict verdict. The engine never invents a
 *    `SAFE`: it calls the analyzer and reads its verdict, reason codes and intersecting scopes.
 *  - `slot-reservation-service.ts` (ADR-0032) owns capacity: the engine acquires a reservation,
 *    which re-checks the Task version, the assessed revision, the dependency facts, both capacity
 *    dimensions and the draining fact inside one immediate transaction.
 *
 * What this module adds is the *order* of `docs/architecture/scheduler.md` §1–§2 and the bookkeeping
 * that makes it observable: a stable candidate order, a mutually exclusive tick, the distinction
 * between a conflict wait, a capacity wait and `BLOCKED`, the explicit single-shot `UNKNOWN` release
 * (ADR-0030 D05), and the phase-2 §4 reaction to an observed diff that grew beyond its prediction.
 *
 * Three properties are deliberate and are the reason for several "unusual" choices below:
 *
 *  1. **A wait is a value, never an error, and never `BLOCKED`.** `BLOCKED` means unmet dependencies
 *     only (§2.10); conflict and capacity waits are reported with their own stable codes so a script
 *     can branch on them.
 *  2. **The engine does not duplicate the analyzer's completeness rule.** A candidate without a
 *     workspace yet has no *observed* change set; the engine records that as an empty observation
 *     through the same `createImpactSnapshot` the analyzer uses, so the verdict is the analyzer's,
 *     not this module's.
 *  3. **Every decision is a fact in the append-only ledger** (`TaskScheduleDecided`,
 *     `TaskWaitingForConflict`, `TaskWaitingForCapacity`, `TaskUnknownCleared`,
 *     `TaskImpactPredictionRevoked`), keyed on the command that produced it, so a replay appends
 *     nothing and the audit chain is readable with `events list` and `task schedule explain`.
 */
export class ScheduleServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ScheduleServiceError';
  }
}

/**
 * The fingerprint of "this Task has not changed anything yet". A candidate's prediction is derived
 * from the change set its worktree actually shows; before the worktree exists that change set is
 * empty, and this constant is what makes the empty observation a stable identity instead of a new
 * snapshot per tick. It never claims to be a Git tree fingerprint.
 */
const preStartChangeFingerprint = createHash('sha256')
  .update('codeestra:pre-start-impact:no-observed-change').digest('hex');

/** One start the engine asks the Runtime to perform. The engine owns the reservation, not the run. */
export interface ScheduledStartRequest {
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedTaskVersion: number;
  readonly revisionId: string;
  readonly adapterId: string;
  readonly reservationId: string;
  readonly commandId: string;
  readonly actor: string;
  readonly impactSnapshotId: string | null;
  /**
   * Explicit baseline ref for a **new** workspace (ADR-0060). Only an explicit `task.run` carries it:
   * the automatic tick never chooses a baseline, so an automatically started Task always gets the
   * project's default (the dev clone's `dev`, or the project folder's checked out branch).
   */
  readonly baseRef?: string | null;
}

export interface ScheduledStartResult {
  readonly executionId: string;
  readonly sessionId: string;
  readonly attemptNumber: number;
  readonly taskVersion: number;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sessionState: string;
  readonly permissionMode: 'FULL' | 'STRICT';
  readonly agentConfig: Readonly<Record<string, unknown>> | null;
}

/** The §4 safe-pause request, answered by the existing cooperative stop. */
export interface SchedulePauseOutcome {
  readonly state: string;
  readonly stop: string;
  readonly detail: string;
}

export interface ScheduleServiceOptions {
  readonly storage: Phase1Database;
  readonly adapters: { readonly ids: () => readonly string[] };
  readonly slots: SlotReservationService;
  /** Prepares the workspace of the reservation and starts exactly one primary Agent. */
  readonly start: (input: ScheduledStartRequest) => Promise<ScheduledStartResult>;
  /**
   * Requests a safe pause through the existing `task.pause` path (§4). Optional: a Runtime without
   * it records the request but cannot act on it, and the report says so.
   */
  readonly pause?: (input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly reason: string;
    readonly actor: string;
  }) => Promise<SchedulePauseOutcome>;
  readonly draining: () => { readonly draining: boolean; readonly reason: string | null };
  /** The Adapter the engine uses when a caller does not name one: `pi` when it is registered. */
  readonly defaultAdapterId?: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly logger?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

/** The evaluation of one candidate, before and after the reservation. */
interface CandidateEvaluation {
  readonly taskId: string;
  readonly displayNumber: number;
  readonly state: TaskLifecycleState;
  readonly version: number;
  readonly revisionId: string;
  readonly priority: number;
  readonly createdAt: number;
  readonly adapterId: string;
  disposition: ScheduleDisposition;
  detail: string;
  wait: ScheduleWaitView | null;
  blockedReasons: readonly TaskDependencyBlockReason[];
  assessment: AssessmentFacts | null;
  started: ScheduleCandidateView['started'];
  /** The full start result, so `task.run` can report the Execution it started. */
  startedDetail: ScheduledStartResult | null;
  clearedUnknownBy: string | null;
}

interface AssessmentFacts {
  readonly view: ScheduleAssessmentView;
  readonly verdict: ConflictAssessment['verdict'];
  readonly reasonCodes: readonly ImpactReasonCode[];
  readonly hits: readonly ImpactHit[];
  readonly explanation: readonly string[];
  /** The subject of the candidate as the analyzer saw it, for the §4 comparison. */
  readonly candidateSubject: ImpactSubject;
  readonly activeSubjects: readonly ImpactSubject[];
  readonly context: ImpactAssessmentContext;
  readonly activeTaskIds: readonly string[];
}

interface UnknownRelease {
  readonly releaseId: string;
  readonly revisionId: string;
  readonly baseCommit: string;
  readonly analyzerVersion: string;
  readonly policyVersion: string;
  readonly reasonCodes: readonly string[];
  readonly releasedBy: string;
  readonly releasedAt: number;
  readonly consumed: boolean;
}

/** A UUID derived from stable parts, so a replayed decision keeps one command identity. */
function actorOf(value: string): string {
  return value.trim().length === 0 ? 'runtime-scheduler' : value;
}

/**
 * One entry per active/reserved Task: who is occupying a resource and whether that occupation could
 * be observed at all (ADR-0055 D04).
 *
 * The verdict already *is* the analyzer's; this projection adds the fact the verdict cannot carry —
 * "the occupier's workspace is not on disk any more, so nothing about it can ever be proven" — which
 * is what a user needs to stop waiting and start reconciling. It changes no decision: `UNKNOWN`
 * stays `UNKNOWN`.
 */
function occupierViews(
  refs: readonly ImpactActiveTaskRef[],
  observable: (taskId: string) => boolean,
): readonly ScheduleOccupierView[] {
  return Object.freeze(refs.map((ref) => {
    const path = ref.workspacePath ?? null;
    const code = occupierCodeOf(observeWorkspacePath(path), observable(ref.taskId));
    return Object.freeze({
      taskId: ref.taskId,
      taskState: ref.taskState,
      executionState: ref.executionState,
      code,
      workspacePath: path,
      detail: code === 'WORKSPACE_MISSING'
        ? `the ledger records the workspace at ${path ?? 'unknown'} but nothing is there on disk, so`
          + ' this occupier cannot be observed at all'
        : code === 'WORKSPACE_UNREADABLE'
          ? 'the workspace exists but its change set could not be read'
          : code === 'NO_WORKSPACE'
            ? 'this occupier holds a resource without a (live) workspace row'
            : "the occupier's change set was observed",
    });
  }));
}
export function derivedScheduleId(...parts: readonly string[]): string {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}`
    + `-${hex.slice(20, 32)}`;
}

/** A UUID derived from stable parts, so a replayed decision keeps one command identity. */

export class ScheduleService {
  readonly #storage: Phase1Database;
  readonly #adapters: { readonly ids: () => readonly string[] };
  readonly #slots: SlotReservationService;
  readonly #start: (input: ScheduledStartRequest) => Promise<ScheduledStartResult>;
  readonly #pause: ScheduleServiceOptions['pause'];
  readonly #draining: () => { readonly draining: boolean; readonly reason: string | null };
  readonly #defaultAdapterId: string | undefined;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #logger: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;
  #lock: Promise<void> = Promise.resolve();
  #lastTick: { tickId: string; trigger: string; completedAt: number } | null = null;

  constructor(options: ScheduleServiceOptions) {
    this.#storage = options.storage;
    this.#adapters = options.adapters;
    this.#slots = options.slots;
    this.#start = options.start;
    this.#pause = options.pause;
    this.#draining = options.draining;
    this.#defaultAdapterId = options.defaultAdapterId;
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#logger = options.logger ?? (() => {});
  }

  /**
   * Starts the periodic recovery tick (ADR-0030 D04). It only re-runs the same judgements: it
   * introduces no new state, and a tick that is already running makes this one a no-op instead of
   * two ticks racing for the same Task.
   */
  startPeriodicTicks(intervalMs: number): void {
    if (this.#timer !== null) return;
    const interval = Math.max(intervalMs, 50);
    this.#timer = setInterval(() => {
      void this.tick('PERIODIC', { coalesce: true }).catch((error) => {
        this.#logger('scheduling tick failed', {
          trigger: 'PERIODIC',
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    }, interval);
    // The Runtime's lifetime is not the timer's: an idle Runtime must still be stoppable.
    this.#timer.unref?.();
  }

  stopPeriodicTicks(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  lastTick(): { readonly tickId: string; readonly trigger: string;
    readonly completedAt: number } | null {
    return this.#lastTick;
  }

  /** The Adapter a start would use: the caller's choice, `pi` when registered, else the first one. */
  resolveAdapterId(requested?: string): string {
    const known = this.#adapters.ids();
    if (requested !== undefined && requested.trim().length > 0) return requested;
    if (this.#defaultAdapterId !== undefined && known.includes(this.#defaultAdapterId)) {
      return this.#defaultAdapterId;
    }
    if (known.includes('pi')) return 'pi';
    return known[0] ?? 'pi';
  }

  /**
   * One scheduling pass. Serialized inside this Runtime (`#busy`), so a periodic tick never
   * overlaps an event-driven one; the database still owns the cross-process guarantee, which is why
   * every write below is an acquisition that re-checks inside one immediate transaction.
   */
  async tick(trigger: string, options?: {
    readonly projectId?: string;
    readonly adapterId?: string;
    /** True for the periodic tick: skip instead of queueing behind a running tick. */
    readonly coalesce?: boolean;
  }): Promise<ScheduleTickReport> {
    const coalesce = options?.coalesce === true;
    const startedAt = this.#now();
    const tickId = this.#randomUUID();
    const run = async (): Promise<ScheduleTickReport> => {
      const drainState = this.#draining();
      const projects: ScheduleProjectReport[] = [];
      if (!drainState.draining) {
        const targets = options?.projectId === undefined
          ? this.#storage.listTrustedProjects().map((project) => project.id)
          : [options.projectId];
        for (const projectId of targets) {
          projects.push(await this.#tickProject({
            projectId,
            trigger,
            adapterId: this.resolveAdapterId(options?.adapterId),
            tickId,
          }));
        }
      }
      const completedAt = this.#now();
      const report: ScheduleTickReport = {
        tickId,
        trigger,
        startedAt,
        completedAt,
        draining: drainState.draining,
        coalesced: false,
        projects,
      };
      this.#lastTick = { tickId, trigger, completedAt };
      return report;
    };
    if (coalesce && this.#busy) {
      const completedAt = this.#now();
      return { tickId, trigger, startedAt, completedAt, draining: this.#draining().draining,
        coalesced: true, projects: [] };
    }
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    this.#busy = true;
    try {
      return await run();
    } finally {
      this.#busy = false;
      release();
    }
  }

  /**
   * `task.schedule.status`: the engine's facts. **Read-only**: nothing is reserved, prepared or
   * started, and the §4 pass observes without pausing. The candidate walk below is therefore always
   * the dry run — a query command must never start work — and `dryRun` in the answer only marks the
   * `plan` form of the same walk.
   */
  async status(projectId: string, adapterId?: string): Promise<ScheduleOverviewView> {
    return await this.#overview(projectId, adapterId, false);
  }

  /** `task.schedule.plan`: the same ordered walk, explicitly labelled as the dry run. */
  async plan(projectId: string, adapterId?: string): Promise<ScheduleOverviewView> {
    return await this.#overview(projectId, adapterId, true);
  }

  /**
   * `task.schedule.explain <task>`: why this Task is not running now. It re-runs the same judgements
   * for that one Task (read-only apart from the ImpactSnapshot the analyzer records from observed
   * facts) and reports the decision, the wait with its reason codes and intersecting scopes, the
   * dependency verdict, the capacity numbers and any `UNKNOWN` release in effect.
   */
  async explain(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly adapterId?: string;
  }): Promise<ScheduleExplanationView> {
    const project = this.#storage.getTrustedProject(input.projectId);
    const adapterId = this.resolveAdapterId(input.adapterId);
    const task = this.#storage.getTask(project.id, input.taskId);
    if (task === null) {
      throw new ScheduleServiceError('NOT_FOUND', 'Task was not found in this project');
    }
    const capacity = this.#capacityView(project.id);
    const activeRefs = this.#activeTaskRefs(project.id, task.id);
    const activeTaskIds = activeRefs.map((ref) => ref.taskId);
    if (task.archivedAt !== null) {
      return {
        ...this.#explanationBase(project, task, adapterId, capacity, activeTaskIds),
        candidate: false,
        decision: 'NOT_A_CANDIDATE',
        detail: 'the Task is archived, so it is not a scheduling candidate',
        wait: null,
        blockedReasons: Object.freeze([]),
        assessment: null,
        unknownRelease: null,
        explanation: Object.freeze([]),
      };
    }
    if (task.state !== 'READY') {
      const active = activeTaskIds.includes(task.id);
      if (task.state === 'PAUSED') {
        // A paused Task holds its resource and is *not* a scheduling candidate, but "why is it not
        // running" has a concrete answer: resuming it is a start path, so it passes the same conflict
        // gate (scheduler.md §4). Reporting that verdict here is what makes the pause explainable.
        const paused = await this.#assess(project, task, activeRefs);
        const gate = this.#conflictDecision({
          project,
          task,
          assessment: paused,
          activeTaskCount: activeRefs.length,
          allowUnknown: false,
          exclusiveUnknown: true,
          commandId: derivedScheduleId('schedule-explain', input.projectId, input.taskId,
            String(task.version)),
          actor: 'local-user',
        });
        const releasing = this.#validUnknownRelease(project.id, task.id, paused);
        return {
          ...this.#explanationBase(project, task, adapterId, capacity, activeTaskIds),
          candidate: false,
          decision: gate.kind === 'SAFE' ? 'ACTIVE' : 'WAIT_CONFLICT',
          detail: gate.kind === 'SAFE'
            ? `the Task is PAUSED and resuming it would be allowed: ${gate.detail}`
            : `the Task is PAUSED and stays paused: ${gate.detail}`,
          wait: gate.kind === 'SAFE' ? null : {
            kind: 'CONFLICT',
            code: gate.code,
            detail: gate.detail,
            reasonCodes: paused.view.reasonCodes,
            hits: paused.hits.map(toHitView),
            blocking: paused.activeTaskIds,
            since: null,
          },
          blockedReasons: Object.freeze([]),
          assessment: paused.view,
          unknownRelease: releasing === null ? null : {
            releaseId: releasing.releaseId,
            revisionId: releasing.revisionId,
            baseCommit: releasing.baseCommit,
            analyzerVersion: releasing.analyzerVersion,
            policyVersion: releasing.policyVersion,
            reasonCodes: releasing.reasonCodes,
            releasedBy: releasing.releasedBy,
            releasedAt: releasing.releasedAt,
            consumed: releasing.consumed,
          },
          explanation: paused.explanation,
        };
      }
      // A Task that holds a resource is not a candidate; the answer to "why is it not running" is
      // its own state, not a wait.
      return {
        ...this.#explanationBase(project, task, adapterId, capacity, activeTaskIds),
        candidate: false,
        decision: active ? 'ACTIVE' : 'NOT_A_CANDIDATE',
        detail: active
          ? `the Task is ${task.state} and holds its Execution resource, so it takes part in the`
            + ' active set instead of being scheduled'
          : `the Task is ${task.state}; only READY Tasks are scheduling candidates`,
        wait: null,
        blockedReasons: Object.freeze([]),
        assessment: null,
        unknownRelease: null,
        explanation: Object.freeze([]),
      };
    }
    const evaluation = await this.#evaluateCandidate({
      project,
      task,
      adapterId,
      dryRun: true,
      allowUnknown: false,
      // `explain` reports what an explicit request would decide, which is the request the user is
      // about to make when they ask why the Task is not running.
      exclusiveUnknown: true,
      commandId: derivedScheduleId('schedule-explain', input.projectId, input.taskId,
        String(task.version)),
      actor: 'local-user',
      simulatedExtraSlots: 0,
    });
    const release = this.#validUnknownRelease(project.id, task.id, evaluation.assessment);
    const decision = evaluation.disposition === 'BLOCKED' ? 'BLOCKED' as const
      : evaluation.disposition === 'STARTED' || evaluation.disposition === 'WOULD_START'
        ? 'START_NOW' as const
        : evaluation.wait?.kind === 'CAPACITY' ? 'WAIT_CAPACITY' as const
          : 'WAIT_CONFLICT' as const;
    return {
      ...this.#explanationBase(project, task, adapterId, capacity, activeTaskIds),
      candidate: true,
      decision,
      detail: evaluation.detail,
      wait: evaluation.wait,
      blockedReasons: evaluation.blockedReasons,
      assessment: evaluation.assessment?.view ?? null,
      unknownRelease: release === null ? null : {
        releaseId: release.releaseId,
        revisionId: release.revisionId,
        baseCommit: release.baseCommit,
        analyzerVersion: release.analyzerVersion,
        policyVersion: release.policyVersion,
        reasonCodes: release.reasonCodes,
        releasedBy: release.releasedBy,
        releasedAt: release.releasedAt,
        consumed: release.consumed,
      },
      explanation: evaluation.assessment?.explanation ?? Object.freeze([]),
    };
  }

  /**
   * `task.run`: request a start through the same gate the automatic tick uses. A start that is
   * refused by the gate is *not* an error: it is a wait (exit code 3) carrying the reason code, or a
   * refusal (exit code 1) when the Task is `BLOCKED` or not startable at all.
   */
  async runNow(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedTaskVersion: number;
    readonly adapterId: string;
    readonly commandId: string;
    readonly allowUnknown: boolean;
    readonly actor: string;
    /** Explicit baseline ref for a new workspace (ADR-0060); see `ScheduledStartRequest.baseRef`. */
    readonly baseRef?: string | null;
  }): Promise<ScheduleStartOutcomeView> {
    const project = this.#storage.getTrustedProject(input.projectId);
    const task = this.#storage.getTask(project.id, input.taskId);
    if (task === null) {
      throw new StorageError('NOT_FOUND', 'Task was not found in this project');
    }
    if (task.archivedAt !== null) {
      throw new ScheduleServiceError('TASK_ARCHIVED', 'An archived Task cannot be started');
    }
    if (task.version !== input.expectedTaskVersion) {
      throw new StorageError('CONCURRENT_MODIFICATION',
        `Task version is ${task.version}, not the expected ${input.expectedTaskVersion}`);
    }
    if (task.state !== 'READY' && task.state !== 'BLOCKED') {
      // A `BLOCKED` Task goes through the gate: its answer is the dependency verdict
      // (`DEPENDENCIES_UNMET`), which is what "why can this not run" has always meant here.
      throw new ScheduleServiceError('TASK_NOT_STARTABLE',
        `Only a READY Task can be started by the scheduler; this Task is ${task.state}`);
    }
    const evaluation = await this.#evaluateCandidate({
      project,
      task,
      adapterId: input.adapterId,
      dryRun: false,
      allowUnknown: input.allowUnknown,
      exclusiveUnknown: true,
      commandId: input.commandId,
      actor: input.actor,
      baseRef: input.baseRef ?? null,
      simulatedExtraSlots: 0,
    });
    const started = evaluation.startedDetail;
    return {
      projectId: project.id,
      taskId: task.id,
      outcome: evaluation.disposition === 'STARTED' ? 'STARTED'
        : evaluation.disposition === 'WAITING' ? 'WAIT' : 'REFUSED',
      // The started run is reported in the same shape `task.run` has always used, so an existing
      // client keeps reading `sessionId`/`executionId` exactly as before.
      executionId: started?.executionId ?? null,
      sessionId: started?.sessionId ?? null,
      attemptNumber: started?.attemptNumber ?? null,
      taskVersion: started?.taskVersion ?? null,
      workspaceId: started?.workspaceId ?? null,
      workspacePath: started?.workspacePath ?? null,
      baseCommit: started?.baseCommit ?? null,
      adapterId: started?.adapterId ?? input.adapterId,
      adapterVersion: started?.adapterVersion ?? null,
      sessionState: started?.sessionState ?? null,
      permissionMode: started?.permissionMode ?? null,
      agentConfig: started?.agentConfig ?? null,
      reservationId: evaluation.started?.reservationId ?? null,
      wait: evaluation.wait,
      assessment: evaluation.assessment?.view ?? null,
      clearedUnknownBy: evaluation.clearedUnknownBy,
      code: evaluation.disposition === 'WAITING'
        ? evaluation.wait?.code ?? null
        : evaluation.disposition === 'BLOCKED'
          ? 'DEPENDENCIES_UNMET'
          : evaluation.disposition === 'FAILED' ? 'START_FAILED' : null,
      detail: evaluation.detail,
    };
  }

  /**
   * `task.schedule.clear-unknown`: records the explicit single-shot release without starting
   * anything (ADR-0030 D05). It refuses to release a `CONFLICTING` verdict — the flag widens the
   * gate for *unproven* overlap only — and it never rewrites the assessment.
   */
  async clearUnknown(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly commandId: string;
    readonly actor: string;
  }): Promise<ScheduleUnknownReleaseView> {
    const project = this.#storage.getTrustedProject(input.projectId);
    const task = this.#storage.getTask(project.id, input.taskId);
    if (task === null) {
      throw new ScheduleServiceError('NOT_FOUND', 'Task was not found in this project');
    }
    const activeRefs = this.#activeTaskRefs(project.id, task.id);
    const assessment = await this.#assess(project, task, activeRefs);
    const binding = {
      revisionId: task.currentRevision.id,
      baseCommit: assessment.view.baseCommit,
      analyzerVersion: assessment.view.analyzerVersion,
      policyVersion: assessment.view.policyVersion,
    };
    if (assessment.verdict === 'SAFE_TO_PARALLELIZE') {
      return { recorded: false, releaseId: null, state: 'SAFE', verdict: assessment.verdict,
        reasonCodes: assessment.view.reasonCodes, ...binding,
        detail: 'the assessment is SAFE_TO_PARALLELIZE; there is no UNKNOWN to clear' };
    }
    if (assessment.verdict === 'CONFLICTING') {
      return { recorded: false, releaseId: null, state: 'CONFLICTING', verdict: assessment.verdict,
        reasonCodes: assessment.view.reasonCodes, ...binding,
        detail: 'the assessment is CONFLICTING: a proven overlap is never released by'
          + ' --allow-unknown, which only widens the gate for an unproven (UNKNOWN) one' };
    }
    const existing = this.#validUnknownRelease(project.id, task.id, assessment);
    if (existing !== null && !existing.consumed) {
      return { recorded: false, releaseId: existing.releaseId, state: 'ALREADY_VALID',
        verdict: assessment.verdict, reasonCodes: assessment.view.reasonCodes, ...binding,
        detail: 'a release bound to this revision and these assessment versions is already in'
          + ' effect' };
    }
    const event = this.#recordUnknownRelease({
      project,
      task,
      assessment,
      commandId: input.commandId,
      actor: input.actor,
    });
    return { recorded: true, releaseId: event.eventId, state: 'RECORDED',
      verdict: assessment.verdict, reasonCodes: assessment.view.reasonCodes, ...binding,
      detail: 'the release is recorded in the audit ledger and authorizes exactly one start; it'
        + ' does not change the recorded assessment, which stays UNKNOWN' };
  }

  /**
   * The conflict half of the gate for a Task that is not a normal candidate — today the `task
   * resume` path (scheduler.md §4, invariant 11). A resumed Task already holds its slot, so only
   * the conflict verdict is checked: UNKNOWN or CONFLICTING keeps it paused.
   */
  async assertResumeAllowed(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly adapterId: string;
    readonly commandId: string;
    readonly allowUnknown: boolean;
    readonly actor: string;
  }): Promise<{ readonly outcome: 'ALLOWED' | 'WAIT' | 'REFUSED';
    readonly wait: ScheduleWaitView | null;
    readonly assessment: ScheduleAssessmentView | null;
    readonly detail: string;
    readonly clearedUnknownBy: string | null }> {
    const project = this.#storage.getTrustedProject(input.projectId);
    const task = this.#storage.getTask(project.id, input.taskId);
    if (task === null) {
      throw new ScheduleServiceError('NOT_FOUND', 'Task was not found in this project');
    }
    const activeRefs = this.#activeTaskRefs(project.id, task.id);
    const assessment = await this.#assess(project, task, activeRefs);
    const decision = this.#conflictDecision({
      project,
      task,
      assessment,
      activeTaskCount: activeRefs.length,
      allowUnknown: input.allowUnknown,
      // Resuming is an explicit request, so a lone UNKNOWN Task may resume and run exclusively.
      exclusiveUnknown: true,
      commandId: input.commandId,
      actor: input.actor,
    });
    if (decision.kind === 'SAFE') {
      return { outcome: 'ALLOWED', wait: null, assessment: assessment.view,
        detail: decision.detail, clearedUnknownBy: decision.releaseId };
    }
    const wait: ScheduleWaitView = {
      kind: 'CONFLICT',
      code: decision.code,
      detail: decision.detail,
      reasonCodes: assessment.view.reasonCodes,
      hits: assessment.hits.map(toHitView),
      blocking: assessment.activeTaskIds,
      since: null,
    };
    await this.#recordWaitEvent({ project, task, wait, commandId: input.commandId,
      actor: input.actor, disposition: 'RESUME' });
    return {
      outcome: assessment.verdict === 'CONFLICTING' ? 'REFUSED' : 'WAIT',
      wait,
      assessment: assessment.view,
      detail: decision.detail,
      clearedUnknownBy: null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // The tick itself
  // -------------------------------------------------------------------------------------------

  async #tickProject(input: {
    readonly projectId: string;
    readonly trigger: string;
    readonly adapterId: string;
    readonly tickId: string;
  }): Promise<ScheduleProjectReport> {
    const project = this.#storage.getTrustedProject(input.projectId);
    const adapterId = input.adapterId;
    const activeRefs = this.#activeTaskRefs(project.id);
    // §4 first: an active Task whose observed diff has moved past the snapshot its prediction was
    // made from invalidates that prediction *before* any new decision is taken from it.
    const growth = await this.#detectImpactGrowth({
      project,
      activeRefs,
      trigger: input.trigger,
      tickId: input.tickId,
      act: true,
    });
    const candidates: ScheduleCandidateView[] = [];
    let simulatedExtraSlots = 0;
    for (const task of this.#candidateOrder(project.id)) {
      const evaluation = await this.#evaluateCandidate({
        project,
        task,
        adapterId,
        dryRun: false,
        allowUnknown: false,
        exclusiveUnknown: false,
        commandId: derivedScheduleId('schedule-tick', input.tickId, task.id),
        actor: 'scheduler',
        simulatedExtraSlots,
      });
      if (evaluation.disposition === 'STARTED') simulatedExtraSlots += 1;
      candidates.push(toCandidateView(evaluation));
      if (evaluation.disposition === 'WAITING' && evaluation.wait !== null) {
        await this.#recordWaitEvent({
          project,
          task,
          wait: evaluation.wait,
          commandId: derivedScheduleId('schedule-wait', input.tickId, task.id),
          actor: 'scheduler',
          disposition: evaluation.wait.kind,
        });
      }
    }
    return {
      projectId: project.id,
      candidates: Object.freeze(candidates),
      impactGrowth: Object.freeze(growth),
      activeTaskIds: Object.freeze(activeRefs.map((ref) => ref.taskId)),
      capacity: this.#capacityView(project.id),
    };
  }

  /**
   * The stable candidate order of `scheduler.md` §1: priority descending, then `createdAt`
   * ascending, then ID ascending. It is deterministic on purpose — the same facts must always
   * produce the same order, so "why did that one start" has one answer. Raising a priority only
   * changes this order; it never interrupts a Task that already holds its resource.
   */
  #candidateOrder(projectId: string): readonly TaskSummary[] {
    return this.#storage.listTasks(projectId)
      .filter((task) => task.state === 'READY' && task.archivedAt === null)
      .sort((left, right) => {
        if (left.priority !== right.priority) return right.priority - left.priority;
        if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });
  }

  /**
   * The documented order of `scheduler.md` §2 for one candidate. Every branch either returns a
   * start it really performed or a wait/refusal value; nothing here throws for an expected outcome.
   */
  async #evaluateCandidate(input: {
    readonly project: TrustedProject;
    readonly task: TaskSummary;
    readonly adapterId: string;
    readonly dryRun: boolean;
    readonly allowUnknown: boolean;
    /**
     * True only on an explicit request (`task.run`, `task resume`, `task.schedule run`): a lone
     * `UNKNOWN` candidate may then run *exclusively*, which is what `scheduler.md` §2 allows. An
     * automatic pass leaves it `false`: the automatic path starts only a candidate it can prove
     * disjoint, and an unproven one waits for the user's own request. `UNKNOWN` therefore never
     * becomes a silent concurrency decision the user did not take.
     */
    readonly exclusiveUnknown: boolean;
    readonly commandId: string;
    readonly actor: string;
    /** Explicit baseline ref for a new workspace (ADR-0060); absent on the automatic path. */
    readonly baseRef?: string | null;
    readonly simulatedExtraSlots: number;
  }): Promise<CandidateEvaluation> {
    const { project, task } = input;
    const base: CandidateEvaluation = {
      taskId: task.id,
      displayNumber: task.displayNumber,
      state: task.state,
      version: task.version,
      revisionId: task.currentRevision.id,
      priority: task.priority,
      createdAt: task.createdAt,
      adapterId: input.adapterId,
      disposition: 'SKIPPED',
      detail: '',
      wait: null,
      blockedReasons: Object.freeze([]),
      assessment: null,
      started: null,
      startedDetail: null,
      clearedUnknownBy: null,
    };
    if (!this.#adapters.ids().includes(input.adapterId)) {
      // An Adapter the Runtime does not have is not `BLOCKED`: it is a fact about resources, so the
      // Task is skipped and a later tick with a registered Adapter picks it up.
      return { ...base, disposition: 'SKIPPED',
        detail: `Adapter ${input.adapterId} is not registered; known:`
          + ` ${this.#adapters.ids().join(', ') || 'none'}` };
    }

    // 1. Dependencies (ADR-0024). An unmet dependency — including an upstream commit that is no
    //    longer reachable from `dev` — is `BLOCKED` and is the only thing `BLOCKED` ever means.
    const dependencies = await inspectTaskDependencies({
      storage: this.#storage, projectId: project.id, taskId: task.id,
    });
    if (dependencies.blocked) {
      await reconcileTaskDependencyState({
        storage: this.#storage,
        projectId: project.id,
        taskId: task.id,
        commandId: derivedScheduleId('schedule-dependency', input.commandId, task.id),
        actor: input.actor,
        expectedVersion: task.version,
        now: this.#now,
      }).catch((error) => {
        this.#logger('a blocked candidate could not be moved to BLOCKED', {
          taskId: task.id, reason: error instanceof Error ? error.message : String(error),
        });
      });
      return {
        ...base,
        state: 'BLOCKED',
        disposition: 'BLOCKED',
        blockedReasons: dependencies.blockedReasons,
        detail: dependencies.blockedReasons
          .map((reason) => `${reason.code}${reason.detail === null ? '' : `: ${reason.detail}`}`)
          .join('; '),
      };
    }

    // 2. Conflict assessment against the active/reserved set (ADR-0031).
    const activeRefs = this.#activeTaskRefs(project.id, task.id);
    const assessment = await this.#assess(project, task, activeRefs, input.baseRef ?? null);
    const decision = this.#conflictDecision({
      project,
      task,
      assessment,
      activeTaskCount: activeRefs.length,
      allowUnknown: input.allowUnknown,
      exclusiveUnknown: input.exclusiveUnknown,
      commandId: input.commandId,
      actor: input.actor,
    });
    const withAssessment: CandidateEvaluation = { ...base, assessment };
    if (decision.kind === 'WAIT') {
      return {
        ...withAssessment,
        disposition: 'WAITING',
        detail: decision.detail,
        wait: {
          kind: 'CONFLICT',
          code: decision.code,
          detail: decision.detail,
          reasonCodes: assessment.view.reasonCodes,
          hits: assessment.hits.map(toHitView),
          blocking: assessment.activeTaskIds,
          since: null,
        },
      };
    }

    // 3. Capacity (ADR-0032). A wait here is a capacity wait with its own stable code, never
    //    `BLOCKED`, and it distinguishes the global limit from the Adapter's own limit.
    if (input.dryRun) {
      const capacityWait = this.#capacityWait(project.id, input.adapterId, input.simulatedExtraSlots);
      if (capacityWait !== null) {
        return { ...withAssessment, disposition: 'WAITING', detail: capacityWait.detail,
          wait: capacityWait };
      }
      return {
        ...withAssessment,
        disposition: 'WOULD_START',
        detail: `would start now on ${input.adapterId} (dry run: nothing was reserved, prepared or`
          + ' started)',
        clearedUnknownBy: decision.releaseId,
      };
    }

    const acquisition = await this.#acquire({
      projectId: project.id,
      task,
      adapterId: input.adapterId,
      assessment,
      commandId: input.commandId,
      actor: input.actor,
      baseRef: input.baseRef ?? null,
    });
    if (acquisition.kind === 'WAIT') {
      return { ...withAssessment, disposition: 'WAITING', detail: acquisition.wait.detail,
        wait: acquisition.wait };
    }
    if (acquisition.kind === 'SKIPPED') {
      return { ...withAssessment, disposition: 'SKIPPED', detail: acquisition.detail };
    }
    const reservation = acquisition.reservation;

    // 4. Before starting: re-check the baseline this reservation was assessed against. A baseline
    //    that moved — or one that can no longer be resolved at all — invalidates the assessment, so
    //    nothing is started; the slot is released with the reason and the Task waits with `STALE_BASE`.
    //    ADR-0060: the baseline is the one this Task would start from: the dev clone's `dev` when one
    //    is recorded, otherwise the project folder's checked out branch (or the explicit `--base-ref`).
    let baseline: Awaited<ReturnType<typeof resolveTaskBaselineRepository>>;
    try {
      baseline = await resolveTaskBaselineRepository(project, { baseRef: input.baseRef ?? null });
    } catch (error) {
      // A baseline that cannot be resolved is a refusal with its own stable code, and the reservation
      // is released first: a Task that never started must not keep holding a slot.
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'BASELINE_UNRESOLVED';
      const message = error instanceof Error ? error.message : String(error);
      await this.#releaseReservation({
        projectId: project.id,
        reservationId: reservation.reservationId,
        reason: `the Task baseline could not be resolved (${code}: ${message}); the reservation was`
          + ' not started',
        commandId: derivedScheduleId('schedule-baseline-release', input.commandId, task.id),
        actor: input.actor,
      });
      return { ...withAssessment, disposition: 'FAILED', detail: `${code}: ${message}` };
    }
    const currentDev = baseline.baseCommit;
    if (currentDev !== reservation.assessedDevCommit) {
      await this.#releaseReservation({
        projectId: project.id,
        reservationId: reservation.reservationId,
        reason: `the ${baseline.baseRef} baseline moved from`
          + ` ${reservation.assessedDevCommit ?? 'an unreadable ref'} to`
          + ` ${currentDev ?? 'an unreadable ref'} after the assessment; the reservation was not`
          + ' started',
        commandId: derivedScheduleId('schedule-stale-release', input.commandId, task.id),
        actor: input.actor,
      });
      const wait: ScheduleWaitView = {
        kind: 'CONFLICT',
        code: 'STALE_BASE',
        detail: `the ${baseline.baseRef} baseline moved from`
          + ` ${(reservation.assessedDevCommit ?? 'unknown').slice(0, 12)} to`
          + ` ${(currentDev ?? 'unknown').slice(0, 12)} after the assessment, so the assessment no`
          + ' longer applies and nothing was started',
        reasonCodes: [...assessment.view.reasonCodes, 'STALE_BASE'],
        hits: assessment.hits.map(toHitView),
        blocking: assessment.activeTaskIds,
        since: null,
      };
      return { ...withAssessment, disposition: 'WAITING', detail: wait.detail, wait };
    }
    const current = this.#storage.getTask(project.id, task.id);
    if (current === null || current.currentRevision.id !== task.currentRevision.id) {
      await this.#releaseReservation({
        projectId: project.id,
        reservationId: reservation.reservationId,
        reason: 'the Task revision changed after the assessment; the reservation was not started',
        commandId: derivedScheduleId('schedule-revision-release', input.commandId, task.id),
        actor: input.actor,
      });
      return { ...withAssessment, disposition: 'SKIPPED',
        detail: 'the Task revision changed between the assessment and the start; nothing was started' };
    }

    try {
      const started = await this.#start({
        projectId: project.id,
        taskId: task.id,
        expectedTaskVersion: task.version,
        revisionId: task.currentRevision.id,
        adapterId: input.adapterId,
        reservationId: reservation.reservationId,
        commandId: input.commandId,
        actor: input.actor,
        baseRef: input.baseRef ?? null,
        impactSnapshotId: assessment.view.candidateSnapshotId,
      });
      // The Execution now holds the resource, so the reservation has done its job and is handed
      // over: keeping both would double-count nothing (capacity counts per Task) but would leave a
      // second slot record to reconcile after a crash for no benefit.
      await this.#releaseReservation({
        projectId: project.id,
        reservationId: reservation.reservationId,
        reason: `execution ${started.executionId} was reserved and now holds the Task resource;`
          + ' the slot reservation is handed over',
        commandId: derivedScheduleId('schedule-handover-release', input.commandId, task.id),
        actor: input.actor,
      });
      this.#recordDecisionEvent({
        project,
        task,
        adapterId: input.adapterId,
        assessment,
        started,
        reservationId: reservation.reservationId,
        clearedUnknownBy: decision.releaseId,
        commandId: derivedScheduleId('schedule-decided', input.commandId, task.id),
        actor: input.actor,
      });
      return {
        ...withAssessment,
        disposition: 'STARTED',
        detail: `started execution ${started.executionId} on ${input.adapterId}`
          + ` (attempt ${started.attemptNumber})`,
        started: {
          executionId: started.executionId,
          sessionId: started.sessionId,
          workspaceId: started.workspaceId,
          baseCommit: started.baseCommit,
          reservationId: reservation.reservationId,
        },
        startedDetail: started,
        // The release that permitted this start, so the caller and the CLI can name the exact audit
        // record instead of only seeing that *a* release existed.
        clearedUnknownBy: decision.releaseId,
      };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'START_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      this.#logger('a scheduled start failed', {
        taskId: task.id, code, reason: message,
      });
      await this.#releaseReservation({
        projectId: project.id,
        reservationId: reservation.reservationId,
        reason: `the start failed (${code}); the reservation was released so the slot is not held by`
          + ' a Task that never started',
        commandId: derivedScheduleId('schedule-failed-release', input.commandId, task.id),
        actor: input.actor,
      });
      return { ...withAssessment, disposition: 'FAILED', detail: `${code}: ${message}` };
    }
  }

  /**
   * The conflict verdict of one candidate. The analyzer answers; this decides what the engine does
   * with the answer, and the two rules that are *not* the analyzer's are ADR-0030's:
   *
   *  - **UNKNOWN waits** when the active set is not empty, because "cannot be proven disjoint" is
   *    not "disjoint". With an empty active set a lone Task may run exclusively (§2).
   *  - **A single explicit release may widen exactly that case** and nothing else: the release is
   *    bound to the assessed revision and the assessment versions, is written to the audit ledger,
   *    and does not change the recorded `UNKNOWN`. `CONFLICTING` is never released.
   */
  #conflictDecision(input: {
    readonly project: TrustedProject;
    readonly task: TaskSummary;
    readonly assessment: AssessmentFacts;
    readonly activeTaskCount: number;
    readonly allowUnknown: boolean;
    readonly exclusiveUnknown: boolean;
    readonly commandId: string;
    readonly actor: string;
  }): { readonly kind: 'SAFE' | 'WAIT'; readonly code: string; readonly detail: string;
    readonly releaseId: string | null } {
    const { assessment } = input;
    if (assessment.verdict === 'SAFE_TO_PARALLELIZE') {
      return { kind: 'SAFE', code: 'NO_CONFLICT',
        detail: assessment.activeTaskIds.length === 0
          ? 'no Task held a resource, so there was nothing to be disjoint from'
          : `SAFE_TO_PARALLELIZE against ${assessment.activeTaskIds.length} active/reserved Task(s)`,
        releaseId: null };
    }
    if (assessment.verdict === 'CONFLICTING') {
      const code = firstCodeOfClass(assessment, 'CONFLICT') ?? 'SAME_FILE';
      return { kind: 'WAIT', code,
        detail: `CONFLICTING (${code}): the revision provably overlaps an active Task on`
          + ` ${describeScope(assessment.hits)}; a proven overlap is never released`,
        releaseId: null };
    }
    const code = firstCodeOfClass(assessment, 'INCOMPLETE')
      ?? firstCodeOfClass(assessment, 'STALE_OR_INVALID')
      ?? assessment.reasonCodes[0] ?? 'INCOMPLETE_IMPACT';
    if (input.activeTaskCount === 0 && input.exclusiveUnknown) {
      return { kind: 'SAFE', code,
        detail: `UNKNOWN (${code}) but no Task holds a resource, so this explicit request may run`
          + ' the Task exclusively (§2); nothing may run concurrently with it',
        releaseId: null };
    }
    const existing = this.#validUnknownRelease(input.project.id, input.task.id, assessment);
    if (existing !== null && !existing.consumed) {
      return { kind: 'SAFE', code,
        detail: `UNKNOWN (${code}) released by ${existing.releasedBy} at ${existing.releasedAt}`
          + ` for revision ${existing.revisionId.slice(0, 8)}; the recorded assessment stays UNKNOWN`,
        releaseId: existing.releaseId };
    }
    if (input.allowUnknown) {
      const event = this.#recordUnknownRelease({
        project: input.project,
        task: input.task,
        assessment,
        commandId: input.commandId,
        actor: input.actor,
      });
      return { kind: 'SAFE', code,
        detail: `UNKNOWN (${code}) released by ${input.actor} (single-shot, bound to revision`
          + ` ${input.task.currentRevision.id.slice(0, 8)}, baseline`
          + ` ${assessment.view.baseCommit.slice(0, 8)}, ${assessment.view.analyzerVersion},`
          + ` ${assessment.view.policyVersion}); the recorded assessment stays UNKNOWN`,
        releaseId: event.eventId };
    }
    if (input.activeTaskCount === 0) {
      return { kind: 'WAIT', code,
        detail: `UNKNOWN (${code}): the automatic pass starts only a candidate whose impact it can`
          + ' prove disjoint, and nothing here holds a resource yet — so this Task is waiting for'
          + ' your own request: `task run <project> <task> <version>` would run it exclusively, and'
          + ' `--allow-unknown` does the same with an explicit (audited) release of the UNKNOWN',
        releaseId: null };
    }
    return { kind: 'WAIT', code,
      detail: `UNKNOWN (${code}): the revision's impact cannot be proven disjoint from`
        + ` ${input.activeTaskCount} active/reserved Task(s) on ${describeScope(assessment.hits)};`
        + ' pass --allow-unknown to start it anyway (single-shot, audited)',
      releaseId: null };
  }

  // -------------------------------------------------------------------------------------------
  // Assessment
  // -------------------------------------------------------------------------------------------

  /**
   * Assesses one candidate through the analyzer service.
   *
   * Under ADR-0059 the verdict is made of **declarations**: the candidate's own features against the
   * project's unfinished Tasks that declared one (`listFeatureConflictPeers`). The observed change set
   * is still derived — it is what the reservation path rechecks and what the explanation shows — but
   * it no longer decides anything, and a candidate with no worktree is therefore judged exactly like
   * any other instead of being reported as `UNKNOWN`.
   *
   * `activeRefs` (the Task's resource-holding occupancy) is kept for the occupancy projections, which
   * answer a different question: "who is holding the machine", not "whose declaration overlaps mine".
   */
  async #assess(
    project: TrustedProject,
    task: TaskSummary,
    activeRefs: readonly ImpactActiveTaskRef[],
    baseRef: string | null = null,
  ): Promise<AssessmentFacts> {
    const candidateRef = this.#storage.getImpactCandidateTask(project.id, task.id);
    let candidateSnapshot: ImpactSnapshotRecord | null = null;
    let unavailableDetail: string | null = null;
    if (candidateRef !== null && candidateRef.workspacePath !== null
      && candidateRef.workspaceBaseCommit !== null) {
      // The Task has a worktree, so its impact is *observed*, not predicted. `inspectTaskImpact`
      // records a new snapshot when the observed change set no longer matches the recorded one and
      // reuses that snapshot otherwise — the analyzer's own reuse rule, called, not reimplemented.
      try {
        const report = await inspectTaskImpact({
          storage: this.#storage,
          projectId: project.id,
          taskId: task.id,
          now: this.#now(),
        });
        candidateSnapshot = report.snapshot;
        unavailableDetail = report.unavailableDetail;
      } catch (error) {
        unavailableDetail = error instanceof Error ? error.message : String(error);
        this.#logger('the observed impact of a candidate could not be derived', {
          projectId: project.id, taskId: task.id, reason: unavailableDetail,
        });
      }
    } else {
      // No workspace yet: the observed change set is empty, which is the one case where a prediction
      // is legitimate. It still goes through the analyzer's own snapshot constructor, so completeness
      // (and therefore UNKNOWN) is decided in one place.
      candidateSnapshot = await this.#preStartSnapshot(project, task, baseRef);
      if (candidateSnapshot === null) {
        unavailableDetail = 'the project has no readable development baseline, so no prediction'
          + ' could be derived';
      }
    }
    const peers = this.#featureSubjects(project, task.id);
    const candidateSubject: ImpactSubject = {
      taskId: task.id,
      currentRevisionId: task.currentRevision.id,
      features: task.currentRevision.features,
      taskState: task.state,
      archived: task.archivedAt !== null,
      snapshot: candidateSnapshot === null ? null : toDomainSnapshot(candidateSnapshot),
      observedFiles: candidateSnapshot?.files ?? [],
      ...(unavailableDetail === null ? {} : { unavailableDetail }),
    };
    const context: ImpactAssessmentContext = {
      baseCommit: candidateSnapshot?.baseCommit ?? candidateRef?.workspaceBaseCommit ?? '',
      policyVersion: candidateSnapshot?.policyVersion ?? 'unavailable',
      analyzerVersion: impactAnalyzerVersion,
    };
    const assessment = assessCandidate({
      candidate: candidateSubject, active: peers.subjects, context,
    });
    // The pair-wise audit row of the analyzer's own contract: one append-only row per compared pair,
    // keyed by the two snapshots. It is deliberately partial and must not be read as "an absent row
    // means no conflict": the **`TaskWaitingForConflict`/`TaskStarted` event** is the record of every
    // decision, and this table adds a durable copy only for pairs whose two revisions both have an
    // observable snapshot.
    for (const peer of peers.subjects) {
      const peerSnapshot = peers.snapshots.get(peer.taskId) ?? null;
      if (candidateSnapshot === null || peerSnapshot === null) continue;
      const pair = assessCandidate({ candidate: candidateSubject, active: [peer], context });
      try {
        this.#storage.recordImpactAssessment({
          id: this.#randomUUID(),
          projectId: project.id,
          candidateTaskId: task.id,
          candidateRevisionId: task.currentRevision.id,
          candidateSnapshotId: candidateSnapshot.id,
          otherTaskId: peer.taskId,
          otherRevisionId: peer.currentRevisionId,
          otherSnapshotId: peerSnapshot.id,
          verdict: pair.verdict,
          reasonCodes: pair.reasonCodes,
          hits: pair.hits,
          evidence: pair.evidence,
          createdAt: this.#now(),
        });
      } catch (error) {
        this.#logger('a pair-wise impact assessment could not be recorded', {
          taskId: task.id, otherTaskId: peer.taskId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const explanation = explainAssessment(assessment);
    return {
      view: {
        verdict: assessment.verdict,
        reasonCodes: assessment.reasonCodes,
        revisionId: task.currentRevision.id,
        baseCommit: context.baseCommit,
        analyzerVersion: context.analyzerVersion,
        policyVersion: context.policyVersion,
        candidateSnapshotId: candidateSnapshot?.id ?? null,
        candidateComplete: candidateSnapshot?.complete ?? false,
        candidateIncompleteReasons: candidateSnapshot?.incompleteReasons ?? Object.freeze([]),
        comparedTaskIds: assessment.comparedTaskIds,
        activeTaskIds: activeRefs.map((ref) => ref.taskId),
        explanation,
        occupiers: occupierViews(activeRefs,
          (taskId) => this.#newestSnapshot(project.id, taskId) !== null),
      },
      verdict: assessment.verdict,
      reasonCodes: assessment.reasonCodes,
      hits: assessment.hits,
      explanation,
      candidateSubject,
      activeSubjects: peers.subjects,
      context,
      activeTaskIds: activeRefs.map((ref) => ref.taskId),
    };
  }

  /**
   * The Task's conflict peers as analyzer subjects: the project's unfinished, non-archived Tasks that
   * declared at least one feature (ADR-0059). The newest *recorded* snapshot is attached when one
   * exists, purely as evidence — it is not derived here, because the verdict does not need it and
   * deriving one per peer on every tick was the most expensive part of a scheduling pass.
   */
  #featureSubjects(project: TrustedProject, candidateTaskId: string): {
    readonly subjects: readonly ImpactSubject[];
    readonly snapshots: Map<string, ImpactSnapshotRecord | null>;
  } {
    const snapshots = new Map<string, ImpactSnapshotRecord | null>();
    const subjects: ImpactSubject[] = [];
    for (const peer of this.#storage.listFeatureConflictPeers(project.id, candidateTaskId)) {
      const snapshot = this.#newestSnapshot(project.id, peer.taskId);
      snapshots.set(peer.taskId, snapshot);
      subjects.push({
        taskId: peer.taskId,
        currentRevisionId: peer.revisionId,
        features: peer.features,
        taskState: peer.taskState,
        archived: peer.archived,
        snapshot: snapshot === null ? null : toDomainSnapshot(snapshot),
        observedFiles: snapshot?.files ?? [],
      });
    }
    return { subjects: Object.freeze(subjects), snapshots };
  }

  /**
   * The active set of `scheduler.md` §1: the Tasks that hold an Execution resource (readying,
   * RUNNING, WAITING_FOR_USER, PAUSING, PAUSED, stopping/cancelling, RECOVERY_REQUIRED and
   * reserved-but-unstarted), **plus** the `PAUSED` Tasks that kept their worktree.
   *
   * The second half is not decoration. The pause implementation releases the Execution row
   * (`SUPERSEDED`, `resource_held = 0`) and retains the worktree, so a paused Task is *not* in the
   * analyzer's resource-holder projection — while §1 says it stays in the active set: it still owns a
   * worktree with changes, and resuming it is a start. Leaving it out would let two Tasks with
   * overlapping scopes be resumed concurrently. Its influence on the **conflict** verdict is what this
   * method restores; capacity is deliberately left to `scheduler.reservations`, whose occupancy is
   * E2's semantics and is not changed here.
   */
  #activeTaskRefs(projectId: string, excludeTaskId?: string): readonly ImpactActiveTaskRef[] {
    const refs: ImpactActiveTaskRef[] = [...this.#storage.listImpactActiveTasks(projectId, excludeTaskId)];
    const seen = new Set(refs.map((ref) => ref.taskId));
    for (const task of this.#storage.listTasks(projectId)) {
      if (task.id === excludeTaskId || seen.has(task.id) || task.state !== 'PAUSED') continue;
      const candidate = this.#storage.getImpactCandidateTask(projectId, task.id);
      if (candidate === null || candidate.workspacePath === null
        || candidate.workspaceBaseCommit === null) continue;
      refs.push({
        taskId: task.id,
        taskState: task.state,
        revisionId: candidate.revisionId,
        executionId: '',
        executionState: 'PAUSED',
        workspaceId: candidate.workspaceId,
        workspacePath: candidate.workspacePath,
        workspaceBaseCommit: candidate.workspaceBaseCommit,
        workspaceState: candidate.workspaceState,
      });
    }
    return Object.freeze(refs);
  }

  /**
   * The prediction of a Task that has not started yet: an empty observed change set rendered through
   * the analyzer's own snapshot constructor and policy rules. It is recorded (append-only, like every
   * other snapshot) so the prediction a start was based on stays readable, and it becomes reusable
   * by the analyzer once the worktree exists and still shows no changes.
   */
  async #preStartSnapshot(
    project: TrustedProject,
    task: TaskSummary,
    baseRef: string | null,
  ): Promise<ImpactSnapshotRecord | null> {
    let inspection: ImpactPolicyInspection;
    try {
      inspection = await inspectImpactPolicy({
        repositoryRoot: project.repoRoot, mainRef: project.mainRef,
      });
    } catch (error) {
      this.#logger('the impact mapping of a candidate could not be read', {
        projectId: project.id, taskId: task.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    // ADR-0060: the baseline a prediction is made against is the one this Task would start from — the
    // dev clone's `dev` when one is recorded, otherwise the project folder's checked out branch (or the
    // explicit `--base-ref`). A baseline that cannot be **named** leaves no prediction at all; it is
    // never replaced by some other ref. A recorded dev clone that cannot be verified still refuses,
    // because a broken claim is not a missing one.
    let baseline: TaskBaselineRepository;
    try {
      baseline = await resolveTaskBaselineRepository(project, { baseRef });
    } catch (error) {
      if (error instanceof TaskBaselineError) {
        this.#logger('a pre-start prediction had no nameable baseline', {
          projectId: project.id, taskId: task.id,
          reason: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
      throw error;
    }
    const baseCommit = baseline.baseCommit;
    const confirmation: ConfirmedImpactPolicy | null =
      this.#storage.getConfirmedImpactPolicy(project.id);
    const incompleteReasons = policyIncompleteReasons(inspection, confirmation);
    const caseDetection: ImpactPathCaseDetection =
      await detectImpactPathCaseMode(project.repoRoot);
    const snapshot = createImpactSnapshot({
      taskId: task.id,
      revisionId: task.currentRevision.id,
      baseCommit,
      policyVersion: impactPolicyVersionKey(inspection),
      policyDigest: inspection.state === 'PRESENT'
        ? inspection.digest as string
        : inspection.state === 'INVALID'
          ? inspection.contentDigest as string
          : impactPolicyContentDigest('ABSENT'),
      caseMode: caseDetection.mode as ImpactPathCaseMode,
      paths: [],
      changeFingerprint: preStartChangeFingerprint,
      mapping: inspection.state === 'PRESENT' && inspection.policy !== undefined
        ? inspection.policy : null,
      incompleteReasons,
      evidence: [
        `no workspace exists yet for ${task.id}, so the observed change set is empty`,
        `prediction made against ${baseline.baseRef} ${baseCommit.slice(0, 12)}`,
        `path case mode measured on ${caseDetection.detail}`,
        'an empty observation is only safe when the mapping is complete; the residual risk of a'
        + ' prediction is handled by the growth detection of docs/architecture/scheduler.md §4',
      ],
    });
    return this.#storage.recordImpactSnapshot({
      id: this.#randomUUID(),
      projectId: project.id,
      taskId: snapshot.taskId,
      revisionId: snapshot.revisionId,
      baseCommit: snapshot.baseCommit,
      analyzerVersion: snapshot.analyzerVersion,
      policyVersion: snapshot.policyVersion,
      policyDigest: snapshot.policyDigest,
      caseMode: snapshot.caseMode,
      changeFingerprint: snapshot.changeFingerprint,
      complete: snapshot.complete,
      incompleteReasons: snapshot.incompleteReasons,
      files: snapshot.files,
      importantDirectories: snapshot.importantDirectories,
      modules: snapshot.modules,
      globalResources: snapshot.globalResources,
      unclassifiedFiles: snapshot.unclassifiedFiles,
      evidence: snapshot.evidence,
      createdAt: this.#now(),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Capacity
  // -------------------------------------------------------------------------------------------

  #capacityView(projectId: string): ProjectCapacityView {
    return inspectProjectCapacity({
      storage: this.#storage,
      projectId,
      knownAdapterIds: this.#adapters.ids(),
      draining: this.#draining(),
    });
  }

  #capacityWait(projectId: string, adapterId: string, simulatedExtraSlots: number): ScheduleWaitView | null {
    const capacity = this.#capacityView(projectId);
    const adapter = capacity.adapters.find((entry) => entry.adapterId === adapterId);
    const code: CapacityWaitReasonCode | null = capacityWaitReason({
      draining: capacity.draining,
      globalLimit: capacity.globalLimit,
      globalUsed: capacity.globalUsed + simulatedExtraSlots,
      adapterLimit: adapter?.limit ?? capacity.globalLimit,
      adapterUsed: (adapter?.used ?? 0) + simulatedExtraSlots,
    });
    if (code === null) return null;
    const occupants = capacity.occupants.map((occupant) => occupant.taskId);
    if (code === 'SCHEDULER_DRAINING') {
      return { kind: 'CAPACITY', code, detail: capacity.drainReason
        ?? 'the Runtime is draining and accepts no new reservations', reasonCodes: [code],
        hits: Object.freeze([]), blocking: Object.freeze([]), since: null };
    }
    if (code === 'CAPACITY_GLOBAL_LIMIT_REACHED') {
      return { kind: 'CAPACITY', code,
        detail: `${capacity.globalUsed + simulatedExtraSlots} of ${capacity.globalLimit} project`
          + ' slots are in use', reasonCodes: [code], hits: Object.freeze([]),
        blocking: Object.freeze(occupants), since: null };
    }
    return { kind: 'CAPACITY', code,
      detail: `${(adapter?.used ?? 0) + simulatedExtraSlots} of ${adapter?.limit ?? 0} ${adapterId}`
        + ' slots are in use', reasonCodes: [code], hits: Object.freeze([]),
      blocking: Object.freeze(capacity.occupants
        .filter((occupant) => occupant.adapterId === adapterId)
        .map((occupant) => occupant.taskId)),
      since: null };
  }

  async #acquire(input: {
    readonly projectId: string;
    readonly task: TaskSummary;
    readonly adapterId: string;
    readonly assessment: AssessmentFacts;
    readonly commandId: string;
    readonly actor: string;
    /** Explicit baseline ref for a new workspace (ADR-0060); the reservation records its commit. */
    readonly baseRef?: string | null;
  }): Promise<
    | { readonly kind: 'RESERVED'; readonly reservation: {
      readonly reservationId: string; readonly assessedDevCommit: string | null } }
    | { readonly kind: 'WAIT'; readonly wait: ScheduleWaitView }
    | { readonly kind: 'SKIPPED'; readonly detail: string }
  > {
    try {
      const acquisition = await this.#slots.acquire({
        projectId: input.projectId,
        taskId: input.task.id,
        expectedTaskVersion: input.task.version,
        revisionId: input.task.currentRevision.id,
        adapterId: input.adapterId,
        actor: actorOf(input.actor),
        commandId: input.commandId,
        impactSnapshotId: input.assessment.view.candidateSnapshotId,
        baseRef: input.baseRef ?? null,
      });
      if (acquisition.outcome === 'RESERVED' && acquisition.reservation !== null) {
        return { kind: 'RESERVED', reservation: {
          reservationId: acquisition.reservation.reservationId,
          assessedDevCommit: acquisition.reservation.assessedDevCommit,
        } };
      }
      const wait = acquisition.wait;
      if (wait === null) {
        return { kind: 'SKIPPED', detail: `the acquisition answered ${acquisition.outcome}`
          + ' without a wait reason' };
      }
      return {
        kind: 'WAIT',
        wait: {
          kind: 'CAPACITY',
          code: wait.code,
          detail: wait.detail,
          reasonCodes: Object.freeze([wait.code]),
          hits: Object.freeze([]),
          blocking: Object.freeze([...wait.blocking]),
          since: null,
        },
      };
    } catch (error) {
      if (error instanceof SlotReservationError) {
        // "A slot is already held" and a lost compare-and-swap are not failures of this Task: the
        // other tick (or the other CLI process) won, and the facts are simply not ours to write.
        return { kind: 'SKIPPED', detail: `${error.code}: ${error.message}` };
      }
      if (error instanceof StorageError && (error.code === 'CONCURRENT_MODIFICATION'
        || error.code === 'INVALID_STATE')) {
        return { kind: 'SKIPPED', detail: `${error.code}: ${error.message}` };
      }
      if (typeof error === 'object' && error !== null && 'code' in error
        && String(error.code) === 'DEPENDENCIES_UNMET') {
        return { kind: 'SKIPPED', detail: `DEPENDENCIES_UNMET: ${error instanceof Error
          ? error.message : String(error)}` };
      }
      throw error;
    }
  }

  async #releaseReservation(input: {
    readonly projectId: string;
    readonly reservationId: string;
    readonly reason: string;
    readonly commandId: string;
    readonly actor: string;
  }): Promise<void> {
    try {
      await this.#slots.release({
        projectId: input.projectId,
        reservationId: input.reservationId,
        reason: input.reason,
        actor: actorOf(input.actor),
        commandId: input.commandId,
      });
    } catch (error) {
      // The slot stays held and the recorded holder is the reconciliation's business; a failed
      // release must never turn a started Execution into a reported failure.
      this.#logger('a slot reservation could not be released', {
        reservationId: input.reservationId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // §4: an observed diff that grew beyond its prediction
  // -------------------------------------------------------------------------------------------

  /**
   * Compares every active Task's recorded prediction with the change set its worktree shows now.
   * Growth is not a conflict by itself — an Agent doing work always changes files — so it is only
   * acted on when the grown scope *provably* overlaps another active Task, which is exactly the case
   * where the `SAFE` that allowed the concurrency no longer holds (`scheduler.md` §4):
   *
   *  - the old prediction is revoked in effect: the analyzer records a new snapshot for the grown
   *    facts and every later verdict is taken from it (the old row stays as audit);
   *  - no new Task that overlaps the grown scope is started: that is automatic, because the
   *    candidate loop reads the new snapshot;
   *  - the grown Task is asked to enter a safe pause through the existing cooperative pause path,
   *    and if that stop cannot be confirmed the existing machinery marks it `RECOVERY_REQUIRED`,
   *    keeps the failure scene and never integrates the result;
   *  - nothing is ever preempted to resolve a conflict: a pause is a request recorded against the
   *    Task whose own prediction was wrong, never a silent kill of an unrelated Task.
   */
  async #detectImpactGrowth(input: {
    readonly project: TrustedProject;
    readonly activeRefs: readonly ImpactActiveTaskRef[];
    readonly trigger: string;
    readonly tickId: string;
    /** A read-only view (`task.schedule status`) refreshes observations but never pauses a Task. */
    readonly act: boolean;
  }): Promise<readonly ScheduleImpactGrowthView[]> {
    if (input.activeRefs.length === 0) return Object.freeze([]);
    const growths: ScheduleImpactGrowthView[] = [];
    const snapshots = new Map<string, ImpactSnapshotRecord | null>();
    // First pass: refresh every active Task's observation. The comparison below is a *pair* question,
    // so it must not depend on which Task happens to be looked at first.
    for (const ref of input.activeRefs) {
      try {
        // This is how a grown diff is observed at all: the analyzer re-derives the snapshot from the
        // worktree it owns and records a new one when the observed change set no longer matches.
        await inspectTaskImpact({
          storage: this.#storage,
          projectId: input.project.id,
          taskId: ref.taskId,
          now: this.#now(),
        });
      } catch (error) {
        this.#logger('the observed impact of an active Task could not be refreshed', {
          taskId: ref.taskId, reason: error instanceof Error ? error.message : String(error),
        });
      }
      snapshots.set(ref.taskId, this.#newestSnapshot(input.project.id, ref.taskId));
    }
    // Second pass: compare each active Task's *prediction* — the snapshot the scheduling decision that
    // started it was taken from — with what its worktree shows now. Comparing against the decision
    // rather than against the previous tick is what makes the revocation independent of who else
    // refreshed the observation in between, and it is the only comparison that answers the question
    // §4 asks: has the diff moved past the scope the concurrency was allowed on?
    for (const ref of input.activeRefs) {
      const current = snapshots.get(ref.taskId) ?? null;
      if (current === null) continue;
      const decision = this.#lastScheduleDecision(input.project.id, ref.taskId);
      const predictedId = typeof decision?.payload['candidateSnapshotId'] === 'string'
        ? decision.payload['candidateSnapshotId'] as string : null;
      if (predictedId === null) continue;
      const predicted = this.#storage.listImpactSnapshots({
        projectId: input.project.id, taskId: ref.taskId, limit: 50,
      }).find((snapshot) => snapshot.id === predictedId) ?? null;
      if (predicted === null || predicted.id === current.id) continue;
      // A new revision, a moved baseline, a changed mapping or another analyzer version produce a new
      // snapshot too, and each of those is its own kind of staleness rather than a grown diff.
      if (predicted.revisionId !== current.revisionId || predicted.baseCommit !== current.baseCommit
        || predicted.policyVersion !== current.policyVersion
        || predicted.analyzerVersion !== current.analyzerVersion) continue;
      if (samePathSet(predicted.files, current.files)) continue;
      // The revocation is recorded once per observed snapshot: a pause that could not be confirmed
      // leaves the Task active, and a periodic pass must not ask for it again for the same facts.
      const alreadyRevoked = this.#storage.listTaskScheduleEvents({
        projectId: input.project.id, taskId: ref.taskId, limit: 50,
      }).some((event) => event.eventType === 'TaskImpactPredictionRevoked'
        && event.payload !== null
        && (event.payload as Record<string, unknown>)['snapshotId'] === current.id);
      if (alreadyRevoked) continue;
      const before = predicted;
      const after = current;
      const added = after.files.filter((path) => !before.files.includes(path));
      const removed = before.files.filter((path) => !after.files.includes(path));
      // The verdict here is decided by declarations (ADR-0059), so a *grown diff* cannot turn a
      // SAFE pair into a conflict on its own: what this pass can still find is a peer whose
      // declaration now overlaps this Task's, which is a real reason to stop one of them.
      const peers = input.activeRefs.filter((peer) => peer.taskId !== ref.taskId);
      const task = this.#storage.getTask(input.project.id, ref.taskId);
      const candidateSubject: ImpactSubject = {
        taskId: ref.taskId,
        currentRevisionId: ref.revisionId,
        features: task?.currentRevision.features ?? Object.freeze([]),
        taskState: task?.state ?? ref.taskState,
        archived: task?.archivedAt !== null && task?.archivedAt !== undefined,
        snapshot: toDomainSnapshot(after),
        observedFiles: after.files,
      };
      const activeSubjects: ImpactSubject[] = peers.map((peer) => {
        const snapshot = snapshots.get(peer.taskId) ?? null;
        const peerTask = this.#storage.getTask(input.project.id, peer.taskId);
        return {
          taskId: peer.taskId,
          currentRevisionId: peer.revisionId,
          features: peerTask?.currentRevision.features ?? Object.freeze([]),
          taskState: peerTask?.state ?? peer.taskState,
          archived: peerTask !== null && peerTask.archivedAt !== null,
          snapshot: snapshot === null ? null : toDomainSnapshot(snapshot),
          observedFiles: snapshot?.files ?? [],
          ...(snapshot === null
            ? { unavailableDetail: `${peer.taskId} has no recorded ImpactSnapshot` } : {}),
        };
      });
      const assessment = assessCandidate({
        candidate: candidateSubject,
        active: activeSubjects,
        context: {
          baseCommit: after.baseCommit,
          policyVersion: after.policyVersion,
          analyzerVersion: after.analyzerVersion,
        },
      });
      // One Task can be implicated by several findings (the same important directory *and* the same
      // module, say); the list is of Tasks, so it is deduplicated and ordered.
      const conflictingTaskIds = [...new Set(assessment.hits
        .filter((hit) => hit.class === 'CONFLICT' && hit.taskId !== null)
        .map((hit) => hit.taskId as string))].sort();
      const willPause = input.act && conflictingTaskIds.length > 0;
      if (conflictingTaskIds.length === 0) {
        // The prediction moved, but the grown scope still does not overlap anything that holds a
        // resource. Nothing to revoke and nothing to pause; the new snapshot is the audit, and the
        // candidate loop already reads it.
        growths.push({
          taskId: ref.taskId,
          previousSnapshotId: before.id,
          snapshotId: after.id,
          addedPaths: Object.freeze(added),
          removedPaths: Object.freeze(removed),
          conflictingTaskIds: Object.freeze([]),
          reasonCodes: assessment.reasonCodes,
          pauseRequested: false,
          pauseOutcome: null,
          detail: `the observed diff grew (${added.length} new, ${removed.length} dropped path(s))`
            + ` but does not provably overlap ${peers.length} active Task(s), so no SAFE was revoked`
            + ' and no pause was requested',
        });
        continue;
      }
      const growth: ScheduleImpactGrowthView = {
        taskId: ref.taskId,
        previousSnapshotId: before.id,
        snapshotId: after.id,
        addedPaths: Object.freeze(added),
        removedPaths: Object.freeze(removed),
        conflictingTaskIds: Object.freeze(conflictingTaskIds),
        reasonCodes: assessment.reasonCodes,
        pauseRequested: willPause,
        pauseOutcome: null,
        detail: `the observed diff grew (${added.length} new, ${removed.length} dropped path(s))`
          + ` past the scope its prediction described and now provably overlaps`
          + ` ${conflictingTaskIds.join(', ')} (${assessment.reasonCodes.join(', ')})`,
      };
      if (!input.act) {
        growths.push({ ...growth,
          detail: `${growth.detail}; this read-only view revoked nothing and requested no pause` });
        continue;
      }
      this.#storage.recordTaskScheduleEvent({
        eventId: this.#randomUUID(),
        projectId: input.project.id,
        eventType: 'TaskImpactPredictionRevoked',
        taskId: ref.taskId,
        aggregateVersion: 1,
        commandId: derivedScheduleId('schedule-growth', input.tickId, ref.taskId),
        actor: 'scheduler',
        payload: {
          previousSnapshotId: before.id,
          snapshotId: after.id,
          previousChangeFingerprint: before.changeFingerprint,
          changeFingerprint: after.changeFingerprint,
          addedPaths: added,
          removedPaths: removed,
          conflictingTaskIds,
          reasonCodes: assessment.reasonCodes,
          pauseRequested: true,
          trigger: input.trigger,
        },
        occurredAt: this.#now(),
      });
      const paused = await this.#requestSafePause({
        project: input.project,
        taskId: ref.taskId,
        reason: growth.detail,
      });
      growths.push({ ...growth, pauseOutcome: paused });
    }
    return Object.freeze(growths);
  }

  /** The last scheduling decision of one Task: the prediction its start was allowed on. */
  #lastScheduleDecision(projectId: string, taskId: string): {
    readonly payload: Record<string, unknown>;
    readonly sequence: number;
  } | null {
    const event = this.#storage.listTaskScheduleEvents({ projectId, taskId, limit: 50 })
      .find((candidate) => candidate.eventType === 'TaskScheduleDecided');
    if (event === undefined || event.payload === null) return null;
    return { payload: event.payload as Record<string, unknown>, sequence: event.sequence };
  }

  /** The newest recorded snapshot of one Task, or null when it has none. */
  #newestSnapshot(projectId: string, taskId: string): ImpactSnapshotRecord | null {
    return this.#storage.listImpactSnapshots({ projectId, taskId, limit: 1 })[0] ?? null;
  }

  async #requestSafePause(input: {
    readonly project: TrustedProject;
    readonly taskId: string;
    readonly reason: string;
  }): Promise<string> {
    if (this.#pause === undefined) {
      return 'NOT_REQUESTED: this Runtime has no pause path wired';
    }
    try {
      const outcome = await this.#pause({
        projectId: input.project.id,
        taskId: input.taskId,
        reason: input.reason,
        actor: 'scheduler',
      });
      return `${outcome.state}/${outcome.stop}: ${outcome.detail}`;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'PAUSE_REQUEST_FAILED';
      const detail = error instanceof Error ? error.message : String(error);
      this.#logger('a safe pause could not be requested for a grown prediction', {
        taskId: input.taskId, code, reason: detail,
      });
      return `${code}: ${detail}`;
    }
  }

  // -------------------------------------------------------------------------------------------
  // The audit ledger
  // -------------------------------------------------------------------------------------------

  #recordDecisionEvent(input: {
    readonly project: TrustedProject;
    readonly task: TaskSummary;
    readonly adapterId: string;
    readonly assessment: AssessmentFacts;
    readonly started: ScheduledStartResult;
    readonly reservationId: string;
    readonly clearedUnknownBy: string | null;
    readonly commandId: string;
    readonly actor: string;
  }): string {
    const event = this.#storage.recordTaskScheduleEvent({
      eventId: this.#randomUUID(),
      projectId: input.project.id,
      eventType: 'TaskScheduleDecided',
      taskId: input.task.id,
      aggregateVersion: input.started.taskVersion,
      commandId: input.commandId,
      actor: actorOf(input.actor),
      payload: {
        taskId: input.task.id,
        revisionId: input.task.currentRevision.id,
        adapterId: input.adapterId,
        reservationId: input.reservationId,
        executionId: input.started.executionId,
        sessionId: input.started.sessionId,
        verdict: input.assessment.verdict,
        reasonCodes: input.assessment.view.reasonCodes,
        baseCommit: input.assessment.view.baseCommit,
        analyzerVersion: input.assessment.view.analyzerVersion,
        policyVersion: input.assessment.view.policyVersion,
        candidateSnapshotId: input.assessment.view.candidateSnapshotId,
        activeTaskIds: input.assessment.view.activeTaskIds,
        clearedUnknownBy: input.clearedUnknownBy,
      },
      occurredAt: this.#now(),
    });
    return event.eventId;
  }

  /**
   * Records a wait transition. It is written only when the wait *changed*, so the ledger shows when
   * a Task began waiting for what — which is what `since` and the waiting duration are read from —
   * instead of one row per tick.
   */
  async #recordWaitEvent(input: {
    readonly project: TrustedProject;
    readonly task: TaskSummary;
    readonly wait: ScheduleWaitView;
    readonly commandId: string;
    readonly actor: string;
    readonly disposition: string;
  }): Promise<void> {
    const latest = this.#storage.listTaskScheduleEvents({
      projectId: input.project.id, taskId: input.task.id, limit: 1,
    })[0];
    if (latest !== undefined) {
      const previous = latest.payload as {
        readonly code?: unknown; readonly reasonCodes?: unknown; readonly blocking?: unknown;
      } | null;
      const sameCode = previous !== null && typeof previous === 'object'
        && previous.code === input.wait.code;
      const sameReasons = JSON.stringify(previous?.reasonCodes ?? null)
        === JSON.stringify(input.wait.reasonCodes);
      const sameBlocking = JSON.stringify(previous?.blocking ?? null)
        === JSON.stringify(input.wait.blocking);
      if ((latest.eventType === 'TaskWaitingForConflict'
        || latest.eventType === 'TaskWaitingForCapacity')
        && sameCode && sameReasons && sameBlocking) {
        return;
      }
    }
    this.#storage.recordTaskScheduleEvent({
      eventId: this.#randomUUID(),
      projectId: input.project.id,
      eventType: input.wait.kind === 'CAPACITY' ? 'TaskWaitingForCapacity' : 'TaskWaitingForConflict',
      taskId: input.task.id,
      aggregateVersion: input.task.version,
      commandId: input.commandId,
      actor: actorOf(input.actor),
      payload: {
        taskId: input.task.id,
        revisionId: input.task.currentRevision.id,
        kind: input.wait.kind,
        code: input.wait.code,
        detail: input.wait.detail,
        reasonCodes: input.wait.reasonCodes,
        hits: input.wait.hits,
        blocking: input.wait.blocking,
        disposition: input.disposition,
      },
      occurredAt: this.#now(),
    });
  }

  #recordUnknownRelease(input: {
    readonly project: TrustedProject;
    readonly task: TaskSummary;
    readonly assessment: AssessmentFacts;
    readonly commandId: string;
    readonly actor: string;
  }): StoredEventEnvelope {
    return this.#storage.recordTaskScheduleEvent({
      eventId: this.#randomUUID(),
      projectId: input.project.id,
      eventType: 'TaskUnknownCleared',
      taskId: input.task.id,
      aggregateVersion: input.task.version,
      commandId: input.commandId,
      actor: actorOf(input.actor),
      payload: {
        taskId: input.task.id,
        revisionId: input.task.currentRevision.id,
        baseCommit: input.assessment.view.baseCommit,
        analyzerVersion: input.assessment.view.analyzerVersion,
        policyVersion: input.assessment.view.policyVersion,
        candidateSnapshotId: input.assessment.view.candidateSnapshotId,
        verdict: input.assessment.verdict,
        reasonCodes: input.assessment.view.reasonCodes,
        hits: input.assessment.hits.map(toHitView),
        releasedBy: actorOf(input.actor),
        releasedAt: this.#now(),
        scope: 'SINGLE_START',
        detail: 'explicit single-shot release of an UNKNOWN assessment; it does not change the'
          + ' recorded verdict, and it stops applying when the revision, the baseline or the'
          + ' analyzer/policy version changes',
      },
      occurredAt: this.#now(),
    });
  }

  /** The `UNKNOWN` release in effect for this Task and these assessment versions, if any. */
  #validUnknownRelease(
    projectId: string,
    taskId: string,
    assessment: AssessmentFacts | null,
  ): UnknownRelease | null {
    if (assessment === null) return null;
    if (assessment.verdict !== 'UNKNOWN') return null;
    const events = this.#storage.listTaskScheduleEvents({ projectId, taskId, limit: 200 });
    const releases = events.filter((event) => event.eventType === 'TaskUnknownCleared');
    for (const event of releases) {
      const payload = event.payload as Record<string, unknown> | null;
      if (payload === null) continue;
      // The binding is the point: a release whose revision, baseline, analyzer or policy version no
      // longer matches the assessment in hand has expired and must be re-taken.
      if (payload['revisionId'] !== assessment.view.revisionId) continue;
      if (payload['baseCommit'] !== assessment.view.baseCommit) continue;
      if (payload['analyzerVersion'] !== assessment.view.analyzerVersion) continue;
      if (payload['policyVersion'] !== assessment.view.policyVersion) continue;
      const consumed = events.some((later) => later.sequence > event.sequence
        && later.eventType === 'TaskScheduleDecided'
        && (later.payload as Record<string, unknown> | null)?.['clearedUnknownBy'] === event.eventId);
      return {
        releaseId: event.eventId,
        revisionId: String(payload['revisionId']),
        baseCommit: String(payload['baseCommit']),
        analyzerVersion: String(payload['analyzerVersion']),
        policyVersion: String(payload['policyVersion']),
        reasonCodes: Array.isArray(payload['reasonCodes'])
          ? payload['reasonCodes'].map((code) => String(code)) : Object.freeze([]),
        releasedBy: String(payload['releasedBy'] ?? event.correlationId),
        releasedAt: Number(payload['releasedAt'] ?? event.occurredAt),
        consumed,
      };
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  /**
   * The shared answer of `status` and `plan`. Both are read-only: the candidate walk below never
   * reserves, prepares or starts, and the §4 pass observes growth without requesting a pause. The
   * `dryRun` argument only marks which of the two forms the answer is, so a client can tell an
   * explicit dry run from the current facts.
   */
  async #overview(
    projectId: string,
    adapterId: string | undefined,
    dryRun: boolean,
  ): Promise<ScheduleOverviewView> {
    const project = this.#storage.getTrustedProject(projectId);
    const adapter = this.resolveAdapterId(adapterId);
    const activeRefs = this.#activeTaskRefs(project.id);
    const executions = new Map<string, string>();
    for (const ref of activeRefs) executions.set(ref.taskId, ref.executionState);
    const candidates: ScheduleCandidateView[] = [];
    let simulatedExtraSlots = 0;
    for (const task of this.#candidateOrder(project.id)) {
      const evaluation = await this.#evaluateCandidate({
        project,
        task,
        adapterId: adapter,
        // Always the dry run: a query command reports what a pass *would* do.
        dryRun: true,
        allowUnknown: false,
        exclusiveUnknown: true,
        commandId: derivedScheduleId('schedule-overview', dryRun ? 'plan' : 'status', task.id,
          String(task.version)),
        actor: 'local-user',
        simulatedExtraSlots,
      });
      // A dry run starts nothing, so its report must not imply that a slot was taken; it simulates
      // the same walk so the ordered plan matches what a tick would do.
      if (evaluation.disposition === 'WOULD_START') simulatedExtraSlots += 1;
      candidates.push(toCandidateView(evaluation));
    }
    const growth = await this.#detectImpactGrowth({
      project, activeRefs, trigger: 'OVERVIEW', tickId: derivedScheduleId('schedule-overview', project.id),
      act: false,
    });
    return {
      projectId: project.id,
      dryRun,
      adapterId: adapter,
      draining: this.#draining().draining,
      running: this.#timer !== null,
      lastTick: this.#lastTick,
      candidates: Object.freeze(candidates),
      active: Object.freeze(activeRefs.map((ref) => ({
        taskId: ref.taskId,
        taskDisplayNumber: this.#storage.getTask(project.id, ref.taskId)?.displayNumber ?? 0,
        taskState: ref.taskState,
        executionState: executions.get(ref.taskId) ?? ref.executionState,
        adapterId: adapter,
        reservationId: this.#storage.listSlotReservations(project.id, { taskId: ref.taskId })
          .find((reservation) => reservation.state !== 'RELEASED')?.reservationId ?? null,
        since: 0,
      }))),
      capacity: this.#capacityView(project.id),
      impactGrowth: growth,
    };
  }

  #explanationBase(
    project: TrustedProject,
    task: TaskSummary,
    adapterId: string,
    capacity: ProjectCapacityView,
    activeTaskIds: readonly string[],
  ): Omit<ScheduleExplanationView, 'candidate' | 'decision' | 'detail' | 'wait' | 'assessment'
    | 'explanation' | 'blockedReasons' | 'unknownRelease'> {
    return {
      projectId: project.id,
      taskId: task.id,
      taskState: task.state,
      adapterId,
      capacity,
      activeTaskIds: Object.freeze([...activeTaskIds]),
    };
  }
}

/** The `UNKNOWN` incompleteness the policy itself contributes; the analyzer's own rule, restated. */
function policyIncompleteReasons(
  inspection: ImpactPolicyInspection,
  confirmation: ConfirmedImpactPolicy | null,
): readonly ('POLICY_ABSENT' | 'POLICY_INVALID' | 'POLICY_NOT_CONFIRMED')[] {
  if (inspection.state === 'ABSENT') return Object.freeze(['POLICY_ABSENT'] as const);
  if (inspection.state === 'INVALID') return Object.freeze(['POLICY_INVALID'] as const);
  if (confirmation === null || confirmation.state !== 'PRESENT'
    || confirmation.digest !== inspection.digest) {
    return Object.freeze(['POLICY_NOT_CONFIRMED'] as const);
  }
  return Object.freeze([]);
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const keys = new Set(left);
  return right.every((path) => keys.has(path));
}

function toHitView(hit: ImpactHit): ScheduleConflictHitView {
  return {
    reason: hit.reason,
    class: hit.class,
    taskId: hit.taskId,
    revisionId: hit.revisionId,
    paths: hit.paths,
    pathCount: hit.pathCount,
    directories: hit.directories,
    modules: hit.modules,
    globalResources: hit.globalResources,
    features: hit.features,
    relation: hit.relation,
    detail: hit.detail,
  };
}

function firstCodeOfClass(
  assessment: AssessmentFacts,
  kind: 'CONFLICT' | 'INCOMPLETE' | 'STALE_OR_INVALID',
): string | null {
  const fromHits = assessment.hits.find((hit) => hit.class === kind);
  if (fromHits !== undefined) return fromHits.reason;
  const code = assessment.reasonCodes.find((candidate) => impactReasonClass(candidate) === kind);
  return code ?? null;
}

/** The intersecting scopes of a wait, in the analyzer's own words (never just a colour). */
function describeScope(hits: readonly ImpactHit[]): string {
  const parts: string[] = [];
  for (const hit of hits) {
    if (hit.paths.length > 0) parts.push(`paths ${hit.paths.slice(0, 3).join(', ')}`);
    if (hit.directories.length > 0) parts.push(`directories ${hit.directories.join(', ')}`);
    if (hit.modules.length > 0) parts.push(`modules ${hit.modules.join(', ')}`);
    if (hit.globalResources.length > 0) {
      parts.push(`shared resources ${hit.globalResources.join(', ')}`);
    }
    if (hit.taskId !== null && parts.length > 0) parts.push(`with ${hit.taskId}`);
  }
  return parts.length === 0 ? 'no reported scope' : parts.slice(0, 6).join('; ');
}

function toCandidateView(evaluation: CandidateEvaluation): ScheduleCandidateView {
  return Object.freeze({
    taskId: evaluation.taskId,
    taskDisplayNumber: evaluation.displayNumber,
    taskState: evaluation.state,
    taskVersion: evaluation.version,
    revisionId: evaluation.revisionId,
    priority: evaluation.priority,
    createdAt: evaluation.createdAt,
    adapterId: evaluation.adapterId,
    disposition: evaluation.disposition,
    detail: evaluation.detail,
    wait: evaluation.wait,
    blockedReasons: evaluation.blockedReasons.map((reason) => ({
      code: reason.code,
      prerequisiteTaskId: reason.prerequisiteTaskId,
      requiredRevisionId: reason.requiredRevisionId,
      detail: reason.detail,
    })),
    assessment: evaluation.assessment?.view ?? null,
    started: evaluation.started,
    clearedUnknownBy: evaluation.clearedUnknownBy,
  });
}
