import { createHash } from 'node:crypto';
import {
  createDependencyGraph,
  dependencyImpact,
  transitiveDependents,
  type DependencyEdge,
  type DependencyGraph,
} from '@codeestra/domain';
import { isAncestor } from '@codeestra/git';
import {
  Phase1Database,
  StorageError,
  type TaskDependencyBlockReason,
  type TaskDependencyFact,
  type TaskLifecycleState,
} from '@codeestra/storage';
import { resolveTaskBaselineRepository } from './task-baseline-service.js';

/**
 * The conservative dependency scheduler (Phase 2, first step — ADR-0024).
 *
 * It answers exactly two questions and nothing else:
 *
 *  1. **Is this Task allowed to be READY?** An edge is satisfied only when the pinned upstream
 *     revision has an IntegrationBatch that actually reached `INTEGRATED`, *and* that merged commit
 *     is still reachable from the project's current Task baseline (the dev clone's `dev`, or the
 *     project folder's checked out branch for a managed project — ADR-0060). Only Task verification,
 *     or a baseline rewrite that drops the upstream commit, therefore leaves the dependent `BLOCKED`.
 *  2. **Did this graph edit keep the DAG acyclic?** The reasoning itself lives in the pure domain
 *     graph and runs inside the storage write transaction, so two edges that are each legal cannot
 *     be committed together into a cycle.
 *
 * It deliberately does **not** start anything, reserve resources, or pick a Task to run: parallel
 * worktree scheduling, conflict analysis and capacity are later steps of Phase 2. `BLOCKED` here
 * means one thing only — an unmet dependency (§2.10) — while conflict, capacity and revision
 * waiting must never be reported as `BLOCKED`.
 */
export class SchedulerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SchedulerError';
  }
}

/** One edge as a client reads it, with the verdict and the exact reason for it. */
export interface TaskDependencyEdgeView {
  readonly dependentTaskId: string;
  readonly dependentDisplayNumber: number;
  readonly dependentState: TaskLifecycleState;
  readonly prerequisiteTaskId: string;
  readonly prerequisiteDisplayNumber: number;
  readonly prerequisiteState: TaskLifecycleState;
  readonly requiredRevisionId: string;
  readonly requiredRevisionNumber: number;
  readonly createdAt: number;
  /** Captured result commit of the pinned revision, or null when that revision captured none. */
  readonly resultCommit: string | null;
  readonly satisfied: boolean;
  /** Null exactly when `satisfied` is true. */
  readonly reason: TaskDependencyBlockReason | null;
}

export interface TaskDependencyView {
  readonly projectId: string;
  /** Null for the project-wide listing. */
  readonly taskId: string | null;
  readonly taskState: TaskLifecycleState | null;
  readonly taskVersion: number | null;
  /** The baseline ref this verdict was read against: the project folder's checked out branch. */
  readonly baseRef: string;
  /** That baseline ref's commit, or null when the project has no baseline that can be named (all
   * edges stay blocked). */
  readonly baseCommit: string | null;
  readonly edges: readonly TaskDependencyEdgeView[];
  readonly blocked: boolean;
  readonly blockedReasons: readonly TaskDependencyBlockReason[];
  /** Transitive upstream closure; empty when no single Task was asked for. */
  readonly prerequisites: readonly string[];
  /** Transitive downstream closure; empty when no single Task was asked for. */
  readonly dependents: readonly string[];
}

export interface DependencyReconcileResult {
  readonly taskId: string;
  readonly state: TaskLifecycleState;
  readonly version: number;
  readonly previousState: TaskLifecycleState;
  readonly previousVersion: number;
  /** True only when this call moved the Task between READY and BLOCKED. */
  readonly changed: boolean;
  readonly blockedReasons: readonly TaskDependencyBlockReason[];
}

export interface DependentsReconcileResult {
  readonly taskId: string;
  readonly readied: readonly string[];
  readonly blocked: readonly string[];
  readonly unchanged: readonly string[];
  /** Per-Task failures; the parent command is not failed by a dependent that could not be updated. */
  readonly errors: readonly { readonly taskId: string; readonly code: string;
    readonly message: string }[];
}

/** Command IDs derived from the parent command, so a replayed command is never applied twice. */
function derivedId(...parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function graphOf(facts: readonly TaskDependencyFact[]): DependencyGraph {
  const edges = facts.map((fact): DependencyEdge => ({
    dependentTaskId: fact.dependentTaskId,
    prerequisiteTaskId: fact.prerequisiteTaskId,
    requiredRevisionId: fact.requiredRevisionId,
  }));
  try {
    return createDependencyGraph(edges);
  } catch (error) {
    throw new SchedulerError('DEPENDENCY_GRAPH_INVALID',
      error instanceof Error ? error.message : String(error));
  }
}

/** The baseline a dependency verdict is read against, with the fact that it could not be read. */
interface DependencyBaseline {
  readonly repositoryRoot: string;
  readonly ref: string;
  /** Null when no baseline could be established; every edge then stays blocked. */
  readonly commit: string | null;
  /** Why there is no baseline; null when there is one. */
  readonly detail: string | null;
}

/**
 * The baseline a dependency verdict is read against (ADR-0062): the project folder and the branch it
 * has checked out right now. Resolved once per projection so the loop does not repeat the same read.
 *
 * A baseline that cannot be established — a folder on a detached HEAD, a repository that cannot be
 * read — is reported with `commit: null`, which keeps every edge blocked with its own reason code
 * (ADR-0024: 无法判定一律按未满足处理): a baseline nobody can read must never be read as "satisfied",
 * and a read-only listing must not turn into an exception either. The strict, code-bearing refusal
 * belongs to the start path, which resolves the same baseline with
 * `resolveTaskBaselineRepository` and refuses (`TASK_BASE_REF_*`) before anything is reserved.
 */
async function resolveDependencyBaseline(
  project: Parameters<typeof resolveTaskBaselineRepository>[0],
): Promise<DependencyBaseline> {
  try {
    const baseline = await resolveTaskBaselineRepository(project);
    return { repositoryRoot: baseline.repositoryRoot, ref: baseline.baseRef,
      commit: baseline.baseCommit, detail: null };
  } catch (error) {
    return {
      repositoryRoot: project.repoRoot,
      // The ref this read was aimed at: the project folder's `HEAD` — the only thing there is to
      // read there, and exactly the thing that could not name a branch.
      ref: 'HEAD',
      commit: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function factView(
  fact: TaskDependencyFact,
  satisfied: boolean,
  reason: TaskDependencyBlockReason | null,
): TaskDependencyEdgeView {
  return Object.freeze({
    dependentTaskId: fact.dependentTaskId,
    dependentDisplayNumber: fact.dependentDisplayNumber,
    dependentState: fact.dependentState,
    prerequisiteTaskId: fact.prerequisiteTaskId,
    prerequisiteDisplayNumber: fact.prerequisiteDisplayNumber,
    prerequisiteState: fact.prerequisiteState,
    requiredRevisionId: fact.requiredRevisionId,
    requiredRevisionNumber: fact.requiredRevisionNumber,
    createdAt: fact.createdAt,
    resultCommit: fact.resultCommit,
    satisfied,
    reason,
  });
}

async function evaluateEdge(input: {
  readonly fact: TaskDependencyFact;
  readonly repositoryRoot: string;
  readonly baselineCommit: string | null;
  /** Why the baseline could not be read; only used when `baselineCommit` is null. */
  readonly baselineDetail: string | null;
}): Promise<TaskDependencyEdgeView> {
  const { fact, repositoryRoot, baselineCommit } = input;
  const blocked = (code: TaskDependencyBlockReason['code'], detail: string): TaskDependencyEdgeView =>
    factView(fact, false, Object.freeze({
      code,
      prerequisiteTaskId: fact.prerequisiteTaskId,
      requiredRevisionId: fact.requiredRevisionId,
      detail,
    }));
  if (fact.resultCommit === null) {
    return blocked('UPSTREAM_RESULT_MISSING',
      `#${fact.prerequisiteDisplayNumber} revision ${fact.requiredRevisionNumber} has no captured`
      + ' result commit');
  }
  if (baselineCommit === null) {
    return blocked('BASE_REF_MISSING',
      `the project has no readable Task baseline ref (${input.baselineDetail
        ?? 'the baseline was not resolved'})`);
  }
  if (fact.resultCommit === baselineCommit) return factView(fact, true, null);
  try {
    const reachable = await isAncestor({
      repositoryRoot,
      ancestor: fact.resultCommit,
      descendant: baselineCommit,
    });
    if (reachable) return factView(fact, true, null);
  } catch (error) {
    return blocked('BASE_REF_UNREADABLE',
      error instanceof Error ? error.message : String(error));
  }
  return blocked('NOT_REACHABLE_FROM_BASE',
    `${fact.resultCommit} is no longer reachable from the Task baseline ${baselineCommit}`);
}

/** The `task.depends.list` projection. Read-only: it never writes a Task state. */
export async function inspectTaskDependencies(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskId?: string;
}): Promise<TaskDependencyView> {
  const project = input.storage.getTrustedProject(input.projectId);
  const task = input.taskId === undefined
    ? null
    : input.storage.getTask(input.projectId, input.taskId);
  if (input.taskId !== undefined && task === null) {
    throw new SchedulerError('NOT_FOUND', 'Task was not found in this project');
  }
  const allFacts = input.storage.listTaskDependencyFacts(input.projectId);
  const taskFacts = input.taskId === undefined
    ? allFacts
    : allFacts.filter((fact) => fact.dependentTaskId === input.taskId);
  // ADR-0060: the baseline is resolved once, so every edge below is judged against one read and a
  // managed project is judged exactly like a project with a dev clone — from the ref it recorded,
  // not from a refusal nobody can act on.
  const baseline = await resolveDependencyBaseline(project);
  const edges: TaskDependencyEdgeView[] = [];
  for (const fact of taskFacts) {
    edges.push(await evaluateEdge({
      fact,
      repositoryRoot: baseline.repositoryRoot,
      baselineCommit: baseline.commit,
      baselineDetail: baseline.detail,
    }));
  }
  const blockedReasons = edges
    .map((edge) => edge.reason)
    .filter((reason): reason is TaskDependencyBlockReason => reason !== null);
  const closure = input.taskId === undefined
    ? { prerequisites: [], dependents: [] }
    : dependencyImpact(graphOf(allFacts), input.taskId);
  return Object.freeze({
    projectId: input.projectId,
    taskId: input.taskId ?? null,
    taskState: task?.state ?? null,
    taskVersion: task?.version ?? null,
    baseRef: baseline.ref,
    baseCommit: baseline.commit,
    edges: Object.freeze(edges),
    blocked: blockedReasons.length > 0,
    blockedReasons: Object.freeze(blockedReasons),
    prerequisites: closure.prerequisites,
    dependents: closure.dependents,
  });
}

/**
 * Recomputes one Task's dependency verdict and, when it disagrees with the stored state, moves the
 * Task between `READY` and `BLOCKED`. Only these two states are touched: a Task that is running,
 * paused, cancelled or finished keeps its state, and the caller decides what that means.
 *
 * `expectedVersion` is the caller's compare-and-swap: a stale caller is refused before anything is
 * written, so a scheduler tick never starts work on a revision the caller did not see.
 */
export async function reconcileTaskDependencyState(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly actor: string;
  readonly expectedVersion?: number;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<DependencyReconcileResult> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const view = await inspectTaskDependencies({
    storage: input.storage,
    projectId: input.projectId,
    taskId: input.taskId,
  });
  const state = view.taskState as TaskLifecycleState;
  const version = view.taskVersion as number;
  if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
    throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
  }
  if (state !== 'READY' && state !== 'BLOCKED') {
    return {
      taskId: input.taskId,
      state,
      version,
      previousState: state,
      previousVersion: version,
      changed: false,
      blockedReasons: view.blockedReasons,
    };
  }
  const target = view.blocked ? 'BLOCKED' as const : 'READY' as const;
  if (target === state) {
    return {
      taskId: input.taskId,
      state,
      version,
      previousState: state,
      previousVersion: version,
      changed: false,
      blockedReasons: view.blockedReasons,
    };
  }
  const change = input.storage.applyTaskDependencyState({
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: version,
    target,
    reasons: target === 'BLOCKED' ? view.blockedReasons : [],
    commandId: derivedId('dependency-reconcile', input.commandId, input.taskId),
    payloadHash: derivedId('dependency-reconcile-payload', input.commandId, input.taskId),
    eventId: randomUUID(),
    actor: input.actor,
    at: now(),
  });
  return {
    taskId: input.taskId,
    state: change.state,
    version: change.version,
    previousState: state,
    previousVersion: version,
    changed: change.changed,
    blockedReasons: view.blockedReasons,
  };
}

/**
 * Recomputes every Task that transitively waits for `taskId`. This is what turns "the upstream
 * reached `dev`" into downstream progress without a background loop; a per-Task failure is reported
 * instead of failing the command that triggered it, so a successful integration is never reported
 * as failed because an unrelated Task could not be updated.
 */
export async function reconcileDependentTasks(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskId: string;
  readonly commandId: string;
  readonly actor: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<DependentsReconcileResult> {
  const facts = input.storage.listTaskDependencyFacts(input.projectId);
  let dependents: readonly string[];
  try {
    dependents = transitiveDependents(graphOf(facts), input.taskId);
  } catch (error) {
    // A corrupt stored graph must not turn an already-completed integration into a failure; it is
    // reported as an unreconciled dependent set so a human sees it instead of silence.
    return Object.freeze({
      taskId: input.taskId,
      readied: Object.freeze([]),
      blocked: Object.freeze([]),
      unchanged: Object.freeze([]),
      errors: Object.freeze([{ taskId: input.taskId, code: 'DEPENDENCY_GRAPH_INVALID',
        message: error instanceof Error ? error.message : String(error) }]),
    });
  }
  const readied: string[] = [];
  const blocked: string[] = [];
  const unchanged: string[] = [];
  const errors: { taskId: string; code: string; message: string }[] = [];
  for (const dependent of dependents) {
    try {
      const result = await reconcileTaskDependencyState({
        storage: input.storage,
        projectId: input.projectId,
        taskId: dependent,
        commandId: derivedId('dependency-dependents', input.commandId, dependent),
        actor: input.actor,
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.randomUUID === undefined ? {} : { randomUUID: input.randomUUID }),
      });
      if (!result.changed) unchanged.push(dependent);
      else if (result.state === 'READY') readied.push(dependent);
      else blocked.push(dependent);
    } catch (error) {
      errors.push({
        taskId: dependent,
        code: typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code) : 'DEPENDENCY_RECONCILE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return Object.freeze({
    taskId: input.taskId,
    readied: Object.freeze(readied),
    blocked: Object.freeze(blocked),
    unchanged: Object.freeze(unchanged),
    errors: Object.freeze(errors),
  });
}

/** Read-only guard for paths that must not start writing (for example resuming a paused Task). */
export async function assertDependenciesSatisfied(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskId: string;
}): Promise<void> {
  const view = await inspectTaskDependencies(input);
  if (!view.blocked) return;
  throw new SchedulerError('DEPENDENCIES_UNMET', describeBlocked(view));
}

/**
 * The `task.run` guard. It reconciles the Task first, refuses to reserve anything for a `BLOCKED`
 * Task, and hands the caller the version to use afterwards — a Task that just became READY for the
 * first time is runnable in the same command instead of asking the user to retry.
 */
export async function assertTaskRunnable(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedTaskVersion: number;
  readonly commandId: string;
  readonly actor: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<{ readonly expectedTaskVersion: number; readonly state: TaskLifecycleState }> {
  const reconciled = await reconcileTaskDependencyState({
    storage: input.storage,
    projectId: input.projectId,
    taskId: input.taskId,
    commandId: derivedId('dependency-run-guard', input.commandId, input.taskId),
    actor: input.actor,
    expectedVersion: input.expectedTaskVersion,
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.randomUUID === undefined ? {} : { randomUUID: input.randomUUID }),
  });
  if (reconciled.state === 'BLOCKED') {
    throw new SchedulerError('DEPENDENCIES_UNMET', describeBlockedReasons(reconciled.blockedReasons));
  }
  return { expectedTaskVersion: reconciled.version, state: reconciled.state };
}

function describeBlockedReasons(reasons: readonly TaskDependencyBlockReason[]): string {
  return reasons.map((reason) => `#${reason.prerequisiteTaskId.slice(0, 8)}`
    + ` (revision ${reason.requiredRevisionId.slice(0, 8)}) ${reason.code}`
    + `${reason.detail === null ? '' : `: ${reason.detail}`}`).join('; ');
}

function describeBlocked(view: TaskDependencyView): string {
  return `Task ${view.taskId ?? ''} is blocked by ${view.blockedReasons.length} unmet dependency`
    + `(ies): ${describeBlockedReasons(view.blockedReasons)}`;
}
