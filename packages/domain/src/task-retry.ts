/**
 * Explicit retry of a failed Task (ADR-0036).
 *
 * A Task that reached `FAILED` used to have no way back: `FAILED → READY` did not exist, so "start
 * the same Task again, possibly on another Agent" could only be assembled by hand. `task retry` is
 * that path — and only that path. It is *not* automatic: nothing here counts attempts, backs off, or
 * loops, because a retry is a user decision.
 *
 * Everything in this module is a pure decision over facts the caller already observed:
 *
 *  - which source states may be retried, and the stable code for each refusal;
 *  - which Adapter the new Execution binds (an explicit choice, else the Task's own record);
 *  - whether the Task's own worktree is reused, re-created from the Task branch a reclamation
 *    kept, started from nothing, or refused (FOUNDATION-068 / ADR-0042).
 *
 * The IO (Git inspection, database transaction) stays with the caller, which is why the refusal
 * codes here are values rather than exceptions: a caller must be able to *report* a refusal with
 * the observation that produced it.
 */

/** The Task lifecycle states this decision understands, mirroring the stored union. */
export const taskRetryStates = [
  'DRAFT', 'BLOCKED', 'READY', 'RUNNING', 'PAUSING', 'PAUSED', 'WAITING_FOR_USER',
  'RECOVERY_REQUIRED', 'EXECUTED', 'FAILED', 'CANCELLING', 'CANCELLED', 'SUCCEEDED',
] as const;
export type TaskRetryState = (typeof taskRetryStates)[number];

/** The states a retry may start from. Only a failure is retryable. */
export const retryableTaskStates = ['FAILED'] as const;

export type TaskRetryRefusalCode =
  /** The Task never failed, so "retry" has nothing to repeat. */
  | 'TASK_NOT_FAILED'
  /** `CANCELLED` is terminal and is never reopened (invariant 24). */
  | 'TASK_CANCELLED'
  /** A live Execution owns the Task; a retry would be a second writer. */
  | 'TASK_STILL_RUNNING'
  /** A paused Task continues the *same* conversation: use `task resume`, not a fresh Execution. */
  | 'TASK_PAUSED'
  /** Ownership is uncertain; an audited reconcile decides, not a retry. */
  | 'RECONCILE_REQUIRED'
  /** An archived Task is hidden on purpose; retrying it would bypass that decision. */
  | 'TASK_ARCHIVED';

export interface TaskRetryEligibility {
  readonly allowed: boolean;
  readonly code: TaskRetryRefusalCode | null;
  readonly message: string;
}

/**
 * Whether one Task may be retried right now. `archived` is a separate fact from the lifecycle state,
 * exactly as it is stored, so "this Task failed but you archived it" stays answerable.
 */
export function planTaskRetry(input: {
  readonly state: TaskRetryState;
  readonly archived: boolean;
}): TaskRetryEligibility {
  if (input.archived) {
    return { allowed: false, code: 'TASK_ARCHIVED',
      message: 'The Task is archived; unarchive it before retrying so a hidden Task is not started' };
  }
  switch (input.state) {
    case 'FAILED':
      return { allowed: true, code: null,
        message: 'the Task failed; an explicit retry requeues it and a new Execution follows' };
    case 'CANCELLED':
      return { allowed: false, code: 'TASK_CANCELLED',
        message: 'CANCELLED is terminal and is never reopened by a retry; create a new Task instead' };
    case 'RECOVERY_REQUIRED':
      return { allowed: false, code: 'RECONCILE_REQUIRED',
        message: 'The Task is waiting for an audited reconcile; a retry would not prove the previous'
          + ' writer stopped' };
    case 'PAUSED':
      return { allowed: false, code: 'TASK_PAUSED',
        message: 'A paused Task continues the same provider conversation: use `task resume`, which is'
          + ' a different operation from a retry' };
    case 'RUNNING':
    case 'PAUSING':
    case 'WAITING_FOR_USER':
    case 'CANCELLING':
      return { allowed: false, code: 'TASK_STILL_RUNNING',
        message: `The Task is ${input.state} and still holds a writer; only a failed Task can be`
          + ' retried' };
    default:
      return { allowed: false, code: 'TASK_NOT_FAILED',
        message: `The Task is ${input.state} and has not failed, so there is nothing to retry` };
  }
}

export type TaskRetryAdapterSource = 'REQUESTED' | 'RECORDED' | 'FALLBACK';

export interface TaskRetryAdapterChoice {
  readonly adapterId: string;
  readonly source: TaskRetryAdapterSource;
}

/**
 * Which Adapter the new Execution binds.
 *
 * An explicit `--adapter` wins; otherwise the Adapter the Task itself last ran on is reused, so
 * "retry this on the Agent that failed" does not silently become a different Agent. The fallback is
 * only reached when the Task has no recorded Execution at all.
 */
export function selectRetryAdapter(input: {
  readonly requested?: string | undefined;
  readonly recorded: string | null;
  readonly fallback: string;
}): TaskRetryAdapterChoice {
  const requested = input.requested?.trim();
  if (requested !== undefined && requested.length > 0) {
    return { adapterId: requested, source: 'REQUESTED' };
  }
  if (input.recorded !== null && input.recorded.trim().length > 0) {
    return { adapterId: input.recorded, source: 'RECORDED' };
  }
  return { adapterId: input.fallback, source: 'FALLBACK' };
}

/** Workspace states a retry inspects, mirroring the stored union. */
export type RetryWorkspaceState = 'RESERVED' | 'PREPARING' | 'READY' | 'IN_USE'
  | 'RECOVERY_REQUIRED' | 'RETAINED' | 'RELEASED';

/** What the filesystem and Git actually say about the recorded worktree. */
export type RetryWorkspaceObservation = 'OWNED' | 'MISSING' | 'FOREIGN' | 'UNCERTAIN';

/**
 * How the surviving Task branch relates to the baseline its workspace row recorded.
 *
 * `EQUAL` and `DESCENDANT` are the two facts that prove the branch is this Task's own growth from
 * that baseline — a descendant is what a failed attempt that already committed looks like, and that
 * committed work is exactly what a rebuild must not silently replace with a fresh start.
 */
export type RetryBranchRelation = 'EQUAL' | 'DESCENDANT' | 'UNRELATED' | 'UNKNOWN';

/**
 * The facts a rebuild decision needs when the recorded worktree directory is not there.
 *
 * Every one of them is observed, never assumed: `pathPresent` and `registered` describe the recorded
 * path, and the rest describe the surviving branch. A missing fact is a refusal, not a default.
 */
export interface RetryRebuildEvidence {
  /** A directory (or any filesystem entry) is present at the recorded path. */
  readonly pathPresent: boolean;
  /** Git registers a worktree at the recorded path. */
  readonly registered: boolean;
  readonly branchExists: boolean;
  readonly relationToBase: RetryBranchRelation;
  /** Some other worktree of this repository already has this branch checked out. */
  readonly checkedOutElsewhere: boolean;
}

export type RetryWorkspaceMode = 'REUSE_VERIFIED' | 'PREPARE_FRESH' | 'REBUILD_OWNED';

export type TaskRetryWorkspaceRefusalCode =
  | 'WORKSPACE_OWNERSHIP_UNVERIFIABLE'
  | 'WORKSPACE_RECLAIMED';

export interface TaskRetryWorkspaceDecision {
  readonly allowed: boolean;
  readonly mode: RetryWorkspaceMode | null;
  readonly code: TaskRetryWorkspaceRefusalCode | null;
  readonly message: string;
}

/**
 * Reuse the Task's own worktree, re-create it from the Task branch a reclamation kept, start from
 * nothing, or refuse.
 *
 * The retried Task keeps the worktree it already owns, so its uncommitted work is not thrown away by
 * a retry — but only when the ownership is *verified* from the filesystem and Git, never because a
 * row says so. Three facts are refused rather than papered over:
 *
 *  - a worktree that exists but is not the one this Task owns (a foreign directory, a different
 *    branch, a moved HEAD) must not be handed to an Agent;
 *  - a reclaimed worktree whose branch is gone, unrelated to the recorded baseline, or checked out
 *    somewhere else cannot be rebuilt into this Task's path, so it is reported instead of guessed;
 *  - a directory that is present at the recorded path without a Git registration is never deleted to
 *    make room, because deleting it is an explicit reclamation decision, not a retry side effect.
 *
 * `REBUILD_OWNED` is a *verified plan*, not a completed rebuild: the worktree is created later, by
 * the one preparation path every attempt goes through, which re-establishes the same invariants
 * before it touches Git. Nothing here claims the directory exists.
 */
export function decideRetryWorkspace(input: {
  readonly workspaceState: RetryWorkspaceState | null;
  readonly observation: RetryWorkspaceObservation;
  /** Caller-supplied evidence string (a Git observation), included in refusal messages. */
  readonly evidence?: string | undefined;
  /** Facts about the surviving Task branch; absent when the caller did not observe them. */
  readonly rebuild?: RetryRebuildEvidence | undefined;
}): TaskRetryWorkspaceDecision {
  const evidence = input.evidence === undefined ? '' : ` (${input.evidence})`;
  if (input.workspaceState === null) {
    return { allowed: true, mode: 'PREPARE_FRESH', code: null,
      message: 'the Task has no recorded worktree; the existing preparation path creates one' };
  }
  if (input.observation === 'OWNED') {
    if (input.workspaceState === 'RETAINED' || input.workspaceState === 'READY') {
      return { allowed: true, mode: 'REUSE_VERIFIED', code: null,
        message: `the Task keeps its own worktree${evidence}` };
    }
    return { allowed: false, mode: null, code: 'WORKSPACE_OWNERSHIP_UNVERIFIABLE',
      message: `the worktree is owned but the Task is ${input.workspaceState}; that combination is`
        + ' not a clean retry source' };
  }
  if (input.observation === 'MISSING') {
    return { allowed: true, mode: 'PREPARE_FRESH', code: null,
      message: 'the recorded worktree and its branch are both gone, so the retry starts from nothing'
        + evidence };
  }
  if (input.workspaceState === 'RELEASED') {
    const rebuild = input.rebuild;
    if (input.observation === 'FOREIGN' && rebuild !== undefined && !rebuild.pathPresent
      && !rebuild.registered && rebuild.branchExists && !rebuild.checkedOutElsewhere
      && (rebuild.relationToBase === 'EQUAL' || rebuild.relationToBase === 'DESCENDANT')) {
      return { allowed: true, mode: 'REBUILD_OWNED', code: null,
        message: 'the reclamation kept this Task\'s own branch at the recorded baseline or below it, so'
          + ' the existing preparation path re-creates the worktree at the recorded path from that'
          + ` branch after re-verifying ownership; the directory does not exist yet${evidence}` };
    }
    return { allowed: false, mode: null, code: 'WORKSPACE_RECLAIMED',
      message: 'the Task worktree was reclaimed and cannot be rebuilt: the surviving branch is'
        + ' absent, unrelated to the recorded baseline, already checked out in another worktree, or'
        + ` the recorded path is occupied by something Git does not register${evidence}` };
  }
  return { allowed: false, mode: null, code: 'WORKSPACE_OWNERSHIP_UNVERIFIABLE',
    message: 'the Task worktree could not be verified as this Task\'s own, so it is never handed to a'
      + ` new Execution${evidence}` };
}
