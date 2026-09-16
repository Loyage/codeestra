import { describe, expect, test } from 'vitest';
import {
  planTargetedTestPlanReplacement,
  selectTargetedTestPlan,
  type TargetedTestPlanRef,
} from '../src/verification-evidence.js';

/**
 * Targeted-test-plan decisions (ADR-0038, ADR-0039). These are the pure rules the Runtime relies on:
 * which recorded plan a verification may use, and whether a scope change may be appended. Everything
 * here is decided from already-observed facts, so the tests need no Git, no database and no clock.
 *
 * ADR-0064 deleted the dev full-suite half of this module together with the `dev → main` promotion it
 * gated.
 */

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const digestC = 'c'.repeat(64);

function plan(overrides: Partial<TargetedTestPlanRef> = {}): TargetedTestPlanRef {
  return {
    planId: 'plan-1',
    taskId: 'task-1',
    revisionId: 'revision-1',
    testedCommit: 'commit-1',
    planVersion: 'targeted-test-plan-v1',
    planDigest: digestA,
    ...overrides,
  };
}

describe('selectTargetedTestPlan', () => {
  test('a plan recorded for the exact revision and commit applies', () => {
    const decision = selectTargetedTestPlan({
      plans: [plan()],
      subject: { taskId: 'task-1', revisionId: 'revision-1', testedCommit: 'commit-1' },
    });
    expect(decision.applies).toBe(true);
    if (decision.applies) expect(decision.plan.planDigest).toBe(digestA);
  });

  test('no recorded plan is reported as such, never as an implicit empty plan', () => {
    const decision = selectTargetedTestPlan({
      plans: [],
      subject: { taskId: 'task-1', revisionId: 'revision-1', testedCommit: 'commit-1' },
    });
    expect(decision).toMatchObject({ applies: false, code: 'TARGETED_TEST_PLAN_NOT_RECORDED' });
  });

  test('a plan of another revision is a mismatch, not a licence to use an older plan', () => {
    const decision = selectTargetedTestPlan({
      plans: [plan({ revisionId: 'revision-2' }), plan({ planId: 'plan-old' })],
      subject: { taskId: 'task-1', revisionId: 'revision-1', testedCommit: 'commit-1' },
    });
    expect(decision).toMatchObject({ applies: false, code: 'TARGETED_TEST_PLAN_REVISION_MISMATCH' });
  });

  test('a plan recorded for another commit of the same revision is a mismatch', () => {
    const decision = selectTargetedTestPlan({
      plans: [plan({ testedCommit: 'commit-2' })],
      subject: { taskId: 'task-1', revisionId: 'revision-1', testedCommit: 'commit-1' },
    });
    expect(decision).toMatchObject({ applies: false, code: 'TARGETED_TEST_PLAN_COMMIT_MISMATCH' });
  });

  test('another Task\'s plans are never considered', () => {
    const decision = selectTargetedTestPlan({
      plans: [plan({ taskId: 'task-2' })],
      subject: { taskId: 'task-1', revisionId: 'revision-1', testedCommit: 'commit-1' },
    });
    expect(decision).toMatchObject({ applies: false, code: 'TARGETED_TEST_PLAN_NOT_RECORDED' });
  });
});

describe('planTargetedTestPlanReplacement', () => {
  test('recording the identical digest for the same subject replays instead of appending', () => {
    expect(planTargetedTestPlanReplacement({
      current: plan({ planDigest: digestA }), nextDigest: digestA,
    })).toEqual({ ok: true, created: false });
  });

  test('a different digest appends a new audited record', () => {
    expect(planTargetedTestPlanReplacement({
      current: plan({ planDigest: digestA }), nextDigest: digestB,
    })).toEqual({ ok: true, created: true });
  });

  test('a stated expectation is checked even when the new plan is identical', () => {
    expect(planTargetedTestPlanReplacement({
      current: plan({ planDigest: digestA }), nextDigest: digestA, expectedDigest: digestC,
    })).toMatchObject({ ok: false, code: 'TARGETED_TEST_PLAN_DIGEST_MISMATCH' });
  });

  test('a stated expectation that does not match the current digest is refused', () => {
    expect(planTargetedTestPlanReplacement({
      current: plan({ planDigest: digestA }), nextDigest: digestB, expectedDigest: digestC,
    })).toMatchObject({ ok: false, code: 'TARGETED_TEST_PLAN_DIGEST_MISMATCH' });
  });

  test('expecting a digest when none is recorded is refused as well', () => {
    expect(planTargetedTestPlanReplacement({
      current: null, nextDigest: digestB, expectedDigest: digestA,
    })).toMatchObject({ ok: false, code: 'TARGETED_TEST_PLAN_DIGEST_MISMATCH' });
  });
});
