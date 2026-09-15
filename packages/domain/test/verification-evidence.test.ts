import { describe, expect, test } from 'vitest';
import {
  judgeDevFullSuiteEvidence,
  planTargetedTestPlanReplacement,
  selectTargetedTestPlan,
  type DevFullSuiteEvidenceRef,
  type TargetedTestPlanRef,
} from '../src/verification-evidence.js';

/**
 * Layered verification decisions (ADR-0038, ADR-0039). These are the pure rules the Runtime relies
 * on: which recorded plan a verification may use, whether a scope change may be appended, and
 * whether recorded dev full-suite evidence still carries a promotion. Everything here is decided
 * from already-observed facts, so the tests need no Git, no database and no clock.
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

function evidence(overrides: Partial<DevFullSuiteEvidenceRef> = {}): DevFullSuiteEvidenceRef {
  return {
    evidenceId: 'evidence-1',
    devCommit: 'dev-commit-1',
    policyVersion: 'verification-policy-v1',
    policyDigest: digestA,
    lockfilePresent: true,
    lockfileDigest: digestB,
    state: 'PASSED',
    outcomeCode: 'PASSED',
    ...overrides,
  };
}

const expected = {
  devCommit: 'dev-commit-1',
  policyVersion: 'verification-policy-v1',
  policyDigest: digestA,
  lockfilePresent: true,
  lockfileDigest: digestB,
};

describe('judgeDevFullSuiteEvidence', () => {
  test('a passing run with all three bindings intact is usable', () => {
    expect(judgeDevFullSuiteEvidence({ evidence: [evidence()], expected }))
      .toEqual({ usable: true, evidenceId: 'evidence-1' });
  });

  test('no evidence for the candidate commit is MISSING', () => {
    expect(judgeDevFullSuiteEvidence({ evidence: [], expected }))
      .toMatchObject({ usable: false, code: 'DEV_FULL_SUITE_EVIDENCE_MISSING' });
    expect(judgeDevFullSuiteEvidence({
      evidence: [evidence({ devCommit: 'another-commit' })], expected,
    })).toMatchObject({ usable: false, code: 'DEV_FULL_SUITE_EVIDENCE_MISSING' });
  });

  test('a newer failing run is not rescued by an older passing one', () => {
    const decision = judgeDevFullSuiteEvidence({
      evidence: [evidence({ evidenceId: 'evidence-2', state: 'FAILED', outcomeCode: 'COMMAND_FAILED' }),
        evidence()],
      expected,
    });
    expect(decision).toMatchObject({ usable: false, code: 'DEV_FULL_SUITE_EVIDENCE_NOT_PASSED' });
  });

  test('an unfinished run is not a pass', () => {
    expect(judgeDevFullSuiteEvidence({
      evidence: [evidence({ state: 'RUNNING', outcomeCode: null })], expected,
    })).toMatchObject({ usable: false, code: 'DEV_FULL_SUITE_EVIDENCE_NOT_PASSED' });
  });

  test('a changed policy digest invalidates the evidence and names the binding', () => {
    const decision = judgeDevFullSuiteEvidence({
      evidence: [evidence({ policyDigest: digestC })], expected,
    });
    expect(decision).toMatchObject({ usable: false, code: 'DEV_FULL_SUITE_EVIDENCE_STALE' });
    if (!decision.usable) expect(decision.reason).toContain('policyDigest');
  });

  test('a changed lockfile digest invalidates the evidence', () => {
    const decision = judgeDevFullSuiteEvidence({
      evidence: [evidence({ lockfileDigest: digestC })], expected,
    });
    expect(decision).toMatchObject({ usable: false, code: 'DEV_FULL_SUITE_EVIDENCE_STALE' });
    if (!decision.usable) expect(decision.reason).toContain('lockfileDigest');
  });

  test('a lockfile that appeared after the run invalidates the evidence', () => {
    // A project without a lockfile binds that absence explicitly, so adding one is a change of the
    // binding rather than a silently weaker comparison.
    const decision = judgeDevFullSuiteEvidence({
      evidence: [evidence({ lockfilePresent: false, lockfileDigest: digestB })], expected,
    });
    expect(decision).toMatchObject({ usable: false, code: 'DEV_FULL_SUITE_EVIDENCE_STALE' });
    if (!decision.usable) expect(decision.reason).toContain('lockfilePresent');
  });

  test('a changed policy semantics version invalidates the evidence', () => {
    const decision = judgeDevFullSuiteEvidence({
      evidence: [evidence({ policyVersion: 'verification-policy-v0' })], expected,
    });
    expect(decision).toMatchObject({ usable: false, code: 'DEV_FULL_SUITE_EVIDENCE_STALE' });
    if (!decision.usable) expect(decision.reason).toContain('policyVersion');
  });
});
