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
 *  - whether the Task's own worktree is reused, rebuilt from nothing, or refused.
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

export type RetryWorkspaceMode = 'REUSE_VERIFIED' | 'PREPARE_FRESH';

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
 * Reuse the Task's own worktree, start from nothing, or refuse.
 *
 * The retried Task keeps the worktree it already owns, so its uncommitted work is not thrown away by
 * a retry — but only when the ownership is *verified* from the filesystem and Git, never because a
 * row says so. Two facts are refused rather than papered over:
 *
 *  - a worktree that exists but is not the one this Task owns (a foreign directory, a different
 *    branch, a moved HEAD) must not be handed to an Agent;
 *  - a worktree that was reclaimed while its Task branch survived cannot be rebuilt by the existing
 *    preparation path, which refuses to create a worktree on an existing branch. Refusing here
 *    reports that fact instead of recording an intent that is already known to fail.
 */
export function decideRetryWorkspace(input: {
  readonly workspaceState: RetryWorkspaceState | null;
  readonly observation: RetryWorkspaceObservation;
  /** Caller-supplied evidence string (a Git observation), included in refusal messages. */
  readonly evidence?: string | undefined;
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
    return { allowed: false, mode: null, code: 'WORKSPACE_RECLAIMED',
      message: 'the Task worktree was reclaimed; its branch still exists, and the existing'
        + ' preparation path refuses to create a worktree on an existing branch (REF_CONFLICT), so a'
        + ` retry cannot rebuild it${evidence}` };
  }
  return { allowed: false, mode: null, code: 'WORKSPACE_OWNERSHIP_UNVERIFIABLE',
    message: 'the Task worktree could not be verified as this Task\'s own, so it is never handed to a'
      + ` new Execution${evidence}` };
}
