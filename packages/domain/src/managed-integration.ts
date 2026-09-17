import { DomainError, requireText } from './errors.js';

/**
 * Managed integration (ADR-0070 D07, roadmap S8).
 *
 * A Project Service owns exactly one integration ref and one integration worktree. Task results do
 * not land in any branch the user has checked out; they are merged, verified and only then advanced
 * into that ref with a compare-and-swap. Everything in this file is pure: Git, SQLite and Agent
 * behaviour live in their own layers, and the facts below are the vocabulary all of them share.
 */

/**
 * The exact managed integration ref name (S8 decision, 2026-09-17).
 *
 * It deliberately lives outside `refs/heads/`: `git branch` never lists it, no default `git push`
 * refspec can carry it, and no user checkout can have it checked out, so "Codeestra owns this ref"
 * is a property of the namespace rather than of a convention. The name is fixed per repository
 * because a project *is* a repository (`projects.repo_root` is unique).
 */
export const managedIntegrationRef = 'refs/codeestra/integration';

/** Candidate commits are kept under a ref so a crash cannot let Git collect the scene of a failure. */
export const managedIntegrationCandidateRefPrefix = 'refs/codeestra/candidates/';

/** The candidate ref of one merge queue item, derived from the item id (a UUID). */
export function managedIntegrationCandidateRef(queueItemId: string): string {
  requireText(queueItemId, 'merge queue item id');
  if (!/^[0-9a-fA-F-]{36}$/.test(queueItemId)) {
    throw new DomainError('INVALID_MERGE_QUEUE_ITEM', 'A merge queue item id must be a UUID');
  }
  return `${managedIntegrationCandidateRefPrefix}${queueItemId}`;
}

/**
 * Refs a Task baseline may be fixed to: a project local branch (the explicit `--base-ref` override)
 * or the managed integration ref (the default since S8). Anything else — a tag, a remote-tracking
 * ref, `HEAD` — is not a baseline a Task worktree can be created from and is refused by name.
 */
export function isAllowedTaskBaselineRef(ref: string): boolean {
  return ref === managedIntegrationRef || ref.startsWith('refs/heads/');
}

export const mergeQueueItemStates = ['QUEUED', 'MERGING', 'VERIFYING', 'MERGED', 'CONFLICTED',
  'FAILED', 'CANCELLED', 'STALE', 'RECOVERY_REQUIRED'] as const;
export type MergeQueueItemState = (typeof mergeQueueItemStates)[number];

/**
 * Final states: nothing moves a queue item out of them, and no retry exists. A `CONFLICTED` or
 * `FAILED` item is deliberately *not* in this set — it is settled (no automatic continuation) but a
 * retry may re-queue it, which is exactly how the ADR's "保留现场，允许显式重试" is expressed.
 */
const finalQueueStates = new Set<MergeQueueItemState>(['MERGED', 'CANCELLED', 'STALE']);

export function isFinalMergeQueueItemState(state: MergeQueueItemState): boolean {
  return finalQueueStates.has(state);
}

/** No queue pass will move this item again without an explicit command (retry/cancel/reconcile). */
export function isSettledMergeQueueItemState(state: MergeQueueItemState): boolean {
  return finalQueueStates.has(state) || state === 'CONFLICTED' || state === 'FAILED'
    || state === 'RECOVERY_REQUIRED';
}

/** A queue item holds the project's single integration slot while it is being merged or verified. */
export function holdsIntegrationSlot(state: MergeQueueItemState): boolean {
  return state === 'MERGING' || state === 'VERIFYING';
}

/**
 * Queue item transitions. There is deliberately no `QUEUED → VERIFYING` shortcut (the candidate has
 * to exist before it can be verified) and no way out of a terminal state: a retry is a new attempt
 * recorded on the same item only from `CONFLICTED`/`FAILED`, which lands back in `QUEUED`.
 */
export function transitionMergeQueueItem(
  state: MergeQueueItemState,
  next: MergeQueueItemState,
): MergeQueueItemState {
  if (finalQueueStates.has(state)) {
    throw new DomainError('MERGE_QUEUE_ITEM_TERMINAL',
      `Final merge queue item ${state} cannot transition to ${next}`);
  }
  const allowed: Readonly<Record<MergeQueueItemState, readonly MergeQueueItemState[]>> = {
    QUEUED: ['MERGING', 'CANCELLED', 'STALE'],
    MERGING: ['VERIFYING', 'CONFLICTED', 'FAILED', 'RECOVERY_REQUIRED'],
    VERIFYING: ['MERGED', 'FAILED', 'RECOVERY_REQUIRED'],
    MERGED: [], CONFLICTED: ['QUEUED'], FAILED: ['QUEUED'], CANCELLED: [], STALE: [],
    RECOVERY_REQUIRED: ['MERGED', 'FAILED', 'CANCELLED', 'QUEUED'],
  };
  if (!allowed[state].includes(next)) {
    throw new DomainError('INVALID_MERGE_QUEUE_TRANSITION',
      `Cannot transition merge queue item ${state} to ${next}`);
  }
  return next;
}

export const taskIntegrationStates = ['NOT_REQUESTED', 'QUEUED', 'MERGING', 'VERIFYING', 'MERGED',
  'CONFLICTED', 'FAILED', 'STALE', 'RECOVERY_REQUIRED'] as const;
export type TaskIntegrationState = (typeof taskIntegrationStates)[number];

/**
 * The Task's integration projection is derived from its newest queue item, never from a Task
 * lifecycle field: "the Agent finished", "the Task verification passed" and "the result is in the
 * integration ref" are three different facts and the projection must not merge them.
 */
export function taskIntegrationStateForQueueItem(state: MergeQueueItemState): TaskIntegrationState {
  if (state === 'CANCELLED') return 'NOT_REQUESTED';
  return state;
}

/** The queue order inside one project: priority desc, then request time asc, then id asc (D07). */
export interface MergeQueueOrderKey {
  readonly priority: number;
  readonly requestedAt: number;
  readonly id: string;
}

export function compareMergeQueueOrder(left: MergeQueueOrderKey, right: MergeQueueOrderKey): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.requestedAt !== right.requestedAt) return left.requestedAt - right.requestedAt;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** True when `next` may be attempted without waiting for `predecessor` to stop holding the slot. */
export function canStartIntegration(predecessor: MergeQueueItemState | null): boolean {
  return predecessor === null || !holdsIntegrationSlot(predecessor);
}

/**
 * The candidate is only allowed to move the ref when the ref still points at exactly the commit the
 * merge was based on. `current === null` means the ref no longer exists, which is a moved ref, not an
 * empty one: advancing would resurrect a ref the user deleted.
 *
 * This is the rule, stated once. The Runtime does not check-then-act with it — the atomic form of the
 * same precondition is `git update-ref <ref> <new> <expected>`, whose failure is reported as
 * `INTEGRATION_REF_MOVED` — but the rule is what that call enforces and what a caller may assert
 * against a ref it read earlier.
 */
export function assertIntegrationCas(input: {
  readonly expectedIntegrationOid: string;
  readonly currentIntegrationOid: string | null;
  readonly candidateCommit: string;
}): void {
  requireText(input.expectedIntegrationOid, 'expected integration OID');
  requireText(input.candidateCommit, 'candidate commit');
  if (input.currentIntegrationOid === null) {
    throw new DomainError('INTEGRATION_REF_MISSING',
      'The managed integration ref does not exist any more, so no CAS advance is possible');
  }
  if (input.currentIntegrationOid !== input.expectedIntegrationOid) {
    throw new DomainError('INTEGRATION_REF_MOVED',
      `The managed integration ref moved from ${input.expectedIntegrationOid} to`
      + ` ${input.currentIntegrationOid}; the merge was not advanced`);
  }
}
