import { describe, expect, test } from 'vitest';
import {
  assertIntegrationCas,
  canStartIntegration,
  compareMergeQueueOrder,
  holdsIntegrationSlot,
  isAllowedTaskBaselineRef,
  isFinalMergeQueueItemState,
  isSettledMergeQueueItemState,
  managedIntegrationCandidateRef,
  managedIntegrationCandidateRefPrefix,
  managedIntegrationRef,
  taskIntegrationStateForQueueItem,
  transitionMergeQueueItem,
  type MergeQueueItemState,
} from '../src/managed-integration.js';

/**
 * S8 pure domain (ADR-0070 D07 / ADR-0074). No database, no Git, no Agent: these are the rules the
 * storage, Git and Runtime layers are judged by, and every refusal below is asserted to leave no
 * partial state because there is no state to leave.
 */

describe('managed integration domain', () => {
  test('the managed ref name is fixed and lives outside refs/heads', () => {
    expect(managedIntegrationRef).toBe('refs/codeestra/integration');
    // Outside refs/heads: no `git branch`, no default push refspec, no checkout can reach it.
    expect(managedIntegrationRef.startsWith('refs/heads/')).toBe(false);
  });

  test('only a local branch or the managed ref is a Task baseline', () => {
    expect(isAllowedTaskBaselineRef(managedIntegrationRef)).toBe(true);
    expect(isAllowedTaskBaselineRef('refs/heads/main')).toBe(true);
    expect(isAllowedTaskBaselineRef('HEAD')).toBe(false);
    expect(isAllowedTaskBaselineRef('refs/tags/v1')).toBe(false);
    expect(isAllowedTaskBaselineRef('refs/remotes/origin/main')).toBe(false);
    expect(isAllowedTaskBaselineRef('refs/codeestra/other')).toBe(false);
  });

  test('a candidate ref is derived from the item id and rejects a non-UUID', () => {
    const itemId = '11111111-2222-4333-8444-555555555555';
    expect(managedIntegrationCandidateRef(itemId))
      .toBe(`${managedIntegrationCandidateRefPrefix}${itemId}`);
    expect(() => managedIntegrationCandidateRef('not-a-uuid')).toThrow(/UUID/);
  });

  test('the queue item machine only moves forward and never revives a settled item', () => {
    expect(transitionMergeQueueItem('QUEUED', 'MERGING')).toBe('MERGING');
    expect(transitionMergeQueueItem('MERGING', 'VERIFYING')).toBe('VERIFYING');
    expect(transitionMergeQueueItem('VERIFYING', 'MERGED')).toBe('MERGED');
    expect(transitionMergeQueueItem('MERGING', 'CONFLICTED')).toBe('CONFLICTED');
    expect(transitionMergeQueueItem('CONFLICTED', 'QUEUED')).toBe('QUEUED');
    expect(transitionMergeQueueItem('FAILED', 'QUEUED')).toBe('QUEUED');
    expect(transitionMergeQueueItem('RECOVERY_REQUIRED', 'MERGED')).toBe('MERGED');
    // The two shortcuts that would let a caller skip a fact of the flow do not exist.
    expect(() => transitionMergeQueueItem('QUEUED', 'VERIFYING')).toThrow(/Cannot transition/);
    expect(() => transitionMergeQueueItem('QUEUED', 'MERGED')).toThrow(/Cannot transition/);
    // Final means final: no retry exists out of these three.
    for (const state of ['MERGED', 'CANCELLED', 'STALE'] as const) {
      expect(isFinalMergeQueueItemState(state)).toBe(true);
    }
    // A conflict or a failure is settled (nothing moves it automatically) but explicitly retryable,
    // which is exactly the "keep the scene and let a human retry" rule.
    expect(isFinalMergeQueueItemState('CONFLICTED')).toBe(false);
    expect(isSettledMergeQueueItemState('CONFLICTED')).toBe(true);
    expect(isSettledMergeQueueItemState('FAILED')).toBe(true);
    expect(isSettledMergeQueueItemState('RECOVERY_REQUIRED')).toBe(true);
    expect(isSettledMergeQueueItemState('QUEUED')).toBe(false);
    expect(isSettledMergeQueueItemState('MERGING')).toBe(false);
    expect(() => transitionMergeQueueItem('MERGED', 'QUEUED')).toThrow(/Final/);
    expect(() => transitionMergeQueueItem('CANCELLED', 'QUEUED')).toThrow(/Final/);
    expect(() => transitionMergeQueueItem('STALE', 'QUEUED')).toThrow(/Final/);
  });

  test('exactly MERGING and VERIFYING hold the project integration slot', () => {
    const states: readonly MergeQueueItemState[] = ['QUEUED', 'MERGING', 'VERIFYING', 'MERGED',
      'CONFLICTED', 'FAILED', 'CANCELLED', 'STALE', 'RECOVERY_REQUIRED'];
    expect(states.filter(holdsIntegrationSlot)).toEqual(['MERGING', 'VERIFYING']);
    expect(canStartIntegration(null)).toBe(true);
    expect(canStartIntegration('QUEUED')).toBe(true);
    expect(canStartIntegration('RECOVERY_REQUIRED')).toBe(true);
    expect(canStartIntegration('MERGING')).toBe(false);
    expect(canStartIntegration('VERIFYING')).toBe(false);
  });

  test('the Task projection mirrors the item, and a cancelled request is NOT_REQUESTED again', () => {
    expect(taskIntegrationStateForQueueItem('QUEUED')).toBe('QUEUED');
    expect(taskIntegrationStateForQueueItem('MERGED')).toBe('MERGED');
    expect(taskIntegrationStateForQueueItem('CONFLICTED')).toBe('CONFLICTED');
    expect(taskIntegrationStateForQueueItem('CANCELLED')).toBe('NOT_REQUESTED');
  });

  test('queue order is priority desc, then request time asc, then id asc', () => {
    const keys = [
      { priority: 0, requestedAt: 20, id: 'c' },
      { priority: 1, requestedAt: 30, id: 'b' },
      { priority: 0, requestedAt: 10, id: 'z' },
      { priority: 0, requestedAt: 20, id: 'a' },
    ];
    expect([...keys].sort(compareMergeQueueOrder).map((key) => key.id)).toEqual(['b', 'z', 'a', 'c']);
  });

  test('CAS refuses a moved or deleted ref and accepts only the expected OID', () => {
    const expected = 'a'.repeat(40);
    expect(() => assertIntegrationCas({ expectedIntegrationOid: expected,
      currentIntegrationOid: expected, candidateCommit: 'b'.repeat(40) })).not.toThrow();
    expect(() => assertIntegrationCas({ expectedIntegrationOid: expected,
      currentIntegrationOid: 'c'.repeat(40), candidateCommit: 'b'.repeat(40) }))
      .toThrow(/moved/);
    // A deleted ref is a moved ref: advancing would resurrect something the user removed.
    expect(() => assertIntegrationCas({ expectedIntegrationOid: expected,
      currentIntegrationOid: null, candidateCommit: 'b'.repeat(40) })).toThrow(/does not exist/);
  });
});
