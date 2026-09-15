/**
 * Layered verification decisions (ADR-0038, ADR-0039).
 *
 * This module is pure: it takes already-recorded facts (the append-only targeted test plan records
 * and the dev full-suite evidence records) plus the bindings the caller read from Git, and returns a
 * decision with a stable code. It never reads Git, the filesystem, a database or a model, so the
 * same inputs always produce the same verdict.
 *
 * Two rules it exists to serve:
 *
 * 1. A branch's verification runs the *recorded* targeted plan bound to its own
 *    `(task, revision, commit)`. A plan that was recorded for another revision or commit is a
 *    mismatch, not a licence to run something else; and a commit whose plan was never recorded
 *    falls back to the project policy rather than to an unrecorded file.
 * 2. `dev → main` promotion needs full-suite evidence for the exact candidate SHA, bound to the
 *    test configuration and the lockfile. Any binding change (or a newer non-passing run) makes the
 *    evidence unusable — the promotion must refuse rather than re-point at whatever moved.
 */

/** Version of these decisions. A change here invalidates every stored judgement. */
export const verificationLayeringDecisionVersion = 'verification-layering-v1';

/** One append-only targeted test plan record, as storage stores it. */
export interface TargetedTestPlanRef {
  readonly planId: string;
  readonly taskId: string;
  readonly revisionId: string;
  readonly testedCommit: string;
  readonly planVersion: string;
  readonly planDigest: string;
}

/** What a Task verification is about to judge: one Task, one revision, one captured commit. */
export interface VerificationSubject {
  readonly taskId: string;
  readonly revisionId: string;
  readonly testedCommit: string;
}

export type TargetedTestPlanSelectionCode =
  | 'TARGETED_TEST_PLAN_NOT_RECORDED'
  | 'TARGETED_TEST_PLAN_REVISION_MISMATCH'
  | 'TARGETED_TEST_PLAN_COMMIT_MISMATCH';

export type TargetedTestPlanSelection =
  | { readonly applies: true; readonly plan: TargetedTestPlanRef }
  | { readonly applies: false;
      readonly code: TargetedTestPlanSelectionCode; readonly reason: string };

/**
 * Picks the plan a verification of `subject` may use out of the records of that Task.
 *
 * `plans` are the Task's records newest first. The newest record for the Task decides: if it names
 * a different revision or commit, the caller gets a mismatch code (the Task's scope moved) instead
 * of an older plan that happens to match. Only an exact `(task, revision, commit)` match applies.
 */
export function selectTargetedTestPlan(input: {
  readonly plans: readonly TargetedTestPlanRef[];
  readonly subject: VerificationSubject;
}): TargetedTestPlanSelection {
  const forTask = input.plans.filter((plan) => plan.taskId === input.subject.taskId);
  const newest = forTask[0];
  if (newest === undefined) {
    return { applies: false, code: 'TARGETED_TEST_PLAN_NOT_RECORDED',
      reason: `no targeted test plan was recorded for Task ${input.subject.taskId}; the project`
        + ' verification policy is the only recorded source' };
  }
  if (newest.revisionId !== input.subject.revisionId) {
    return { applies: false, code: 'TARGETED_TEST_PLAN_REVISION_MISMATCH',
      reason: `the newest targeted test plan of Task ${input.subject.taskId} is recorded for`
        + ` revision ${newest.revisionId}, not the revision being verified`
        + ` ${input.subject.revisionId}` };
  }
  if (newest.testedCommit !== input.subject.testedCommit) {
    return { applies: false, code: 'TARGETED_TEST_PLAN_COMMIT_MISMATCH',
      reason: `the targeted test plan of Task ${input.subject.taskId} was recorded for commit`
        + ` ${newest.testedCommit}, not the captured commit being verified`
        + ` ${input.subject.testedCommit}` };
  }
  return { applies: true, plan: newest };
}

export type TargetedTestPlanReplacement =
  | { readonly ok: true; readonly created: boolean }
  | { readonly ok: false; readonly code: 'TARGETED_TEST_PLAN_DIGEST_MISMATCH';
      readonly reason: string };

/**
 * Decides whether a new plan record may be appended for the same subject.
 *
 * Re-recording the identical digest replays (nothing is written twice). A different digest appends
 * a new audited record; when the caller stated the digest it expected to replace, a different
 * current digest is refused so a scope change cannot land on top of one the caller never saw.
 */
export function planTargetedTestPlanReplacement(input: {
  readonly current: TargetedTestPlanRef | null;
  readonly nextDigest: string;
  readonly expectedDigest?: string;
}): TargetedTestPlanReplacement {
  // A stated expectation is checked first: a caller asserting "the recorded plan is <digest>" is
  // told that its view is stale, even when the plan it is about to record happens to be identical.
  // Where there is no expectation, the identical digest is a replay.
  if (input.expectedDigest !== undefined
    && (input.current === null || input.current.planDigest !== input.expectedDigest)) {
    return { ok: false, code: 'TARGETED_TEST_PLAN_DIGEST_MISMATCH',
      reason: `the current targeted test plan digest is`
        + ` ${input.current === null ? 'none' : input.current.planDigest}, not the expected`
        + ` ${input.expectedDigest}; re-read the recorded plan before changing the scope` };
  }
  if (input.current !== null && input.current.planDigest === input.nextDigest) {
    return { ok: true, created: false };
  }
  return { ok: true, created: true };
}

/** The bindings one dev full-suite evidence record must match to be usable for a promotion. */
export interface DevFullSuiteBindings {
  /** The exact `dev` candidate SHA the promotion fixes. */
  readonly devCommit: string;
  /** Semantics version of the fixed project verification policy used as the full suite. */
  readonly policyVersion: string;
  /** Content digest of that policy at the project's `main` ref. */
  readonly policyDigest: string;
  /**
   * Whether the project has a lockfile at the candidate commit. Absence is a bound fact, not a
   * missing binding: a project with none records `false` and the digest of no bytes, so adding one
   * later is a different binding instead of a silently weaker one.
   */
  readonly lockfilePresent: boolean;
  /** Content digest of the lockfile at the `dev` candidate commit (of no bytes when absent). */
  readonly lockfileDigest: string;
}

export interface DevFullSuiteEvidenceRef extends DevFullSuiteBindings {
  readonly evidenceId: string;
  readonly state: 'QUEUED' | 'RUNNING' | 'PASSED' | 'FAILED' | 'ERROR' | 'CANCELLED';
  readonly outcomeCode: string | null;
}

export type DevFullSuiteDecisionCode =
  | 'DEV_FULL_SUITE_EVIDENCE_MISSING'
  | 'DEV_FULL_SUITE_EVIDENCE_NOT_PASSED'
  | 'DEV_FULL_SUITE_EVIDENCE_STALE';

export type DevFullSuiteDecision =
  | { readonly usable: true; readonly evidenceId: string }
  | { readonly usable: false; readonly code: DevFullSuiteDecisionCode; readonly reason: string };

/**
 * Decides whether recorded full-suite evidence may carry a promotion of `expected`.
 *
 * `evidence` is newest first. Only the newest record for the exact candidate commit is considered:
 * if it did not pass, an older passing run must not be resurrected, because a later failure is
 * exactly the fact that invalidates it. The three bindings are then compared field by field, and
 * the first difference is reported so the reason names the binding that moved.
 */
export function judgeDevFullSuiteEvidence(input: {
  readonly evidence: readonly DevFullSuiteEvidenceRef[];
  readonly expected: DevFullSuiteBindings;
}): DevFullSuiteDecision {
  const forCommit = input.evidence.filter((row) => row.devCommit === input.expected.devCommit);
  const newest = forCommit[0];
  if (newest === undefined) {
    return { usable: false, code: 'DEV_FULL_SUITE_EVIDENCE_MISSING',
      reason: `no dev full-suite evidence was recorded for the candidate commit`
        + ` ${input.expected.devCommit}` };
  }
  if (newest.state !== 'PASSED') {
    return { usable: false, code: 'DEV_FULL_SUITE_EVIDENCE_NOT_PASSED',
      reason: `the newest dev full-suite run for ${input.expected.devCommit} is ${newest.state}`
        + `${newest.outcomeCode === null ? '' : ` (${newest.outcomeCode})`}; a promotion needs a`
        + ' PASSED full-suite run of that exact commit' };
  }
  const changed = staleBinding(newest, input.expected);
  if (changed !== null) {
    return { usable: false, code: 'DEV_FULL_SUITE_EVIDENCE_STALE',
      reason: `the dev full-suite evidence ${newest.evidenceId} no longer matches ${changed.name}:`
        + ` recorded ${changed.recorded}, now ${changed.current}; re-run the full suite on the`
        + ' exact candidate' };
  }
  return { usable: true, evidenceId: newest.evidenceId };
}

function staleBinding(
  recorded: DevFullSuiteBindings,
  current: DevFullSuiteBindings,
): { readonly name: string; readonly recorded: string; readonly current: string } | null {
  const fields = [
    ['policyVersion', recorded.policyVersion, current.policyVersion],
    ['policyDigest', recorded.policyDigest, current.policyDigest],
    ['lockfileDigest', recorded.lockfileDigest, current.lockfileDigest],
  ] as const;
  for (const [name, was, is] of fields) {
    if (was !== is) return { name, recorded: was, current: is };
  }
  if (recorded.lockfilePresent !== current.lockfilePresent) {
    return { name: 'lockfilePresent', recorded: String(recorded.lockfilePresent),
      current: String(current.lockfilePresent) };
  }
  return null;
}
