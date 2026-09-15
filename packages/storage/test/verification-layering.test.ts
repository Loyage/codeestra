import { beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { Phase1Database, StorageError, phase1SchemaVersion } from '../src/index.js';

/**
 * Layered verification records (ADR-0038 implemented by ADR-0039, schema v25).
 *
 * Two facts are being protected here, both at the storage boundary rather than in a service:
 *
 * 1. **A targeted test plan is append-only.** A scope change appends a record; the triggers refuse
 *    UPDATE and DELETE outright, so the plan a verification's evidence points at can never be
 *    rewritten after the fact.
 * 2. **An unfinished dev full-suite run is never readable as a pass.** Terminal states must carry
 *    `ended_at`/`outcome_code`, and a run a previous Runtime left RUNNING is closed as an ERROR with
 *    the reason, not silently treated as complete.
 *
 * The schema assertions use the migration constant (and `>= 25`), never `=== 25`: a later lane may
 * legitimately raise the version, and a hard-coded number turned into a false red twice before.
 */

const planDigest = 'a'.repeat(64);
const policyDigest = 'b'.repeat(64);
const lockfileDigest = 'c'.repeat(64);
const commit = 'd'.repeat(40);

let storage: Phase1Database;
let db: Database;

function seedProjectAndTask(target: Database): void {
  // One transaction: `tasks.current_revision_id` is a deferred FK, so the revision row may only
  // exist by the time the transaction commits.
  target.transaction(() => {
    target.query(`INSERT INTO projects
      (id,name,repo_root,git_common_dir,main_ref,dev_ref,object_format,created_at)
      VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','refs/heads/dev','sha1',1)`).run();
    target.query(`INSERT INTO project_trusts
      (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
      VALUES ('trust1','p1','/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run();
    target.query(`INSERT INTO tasks
      (id,project_id,display_number,kind,current_revision_id,state,version,created_at,updated_at)
      VALUES ('t1','p1',1,'DEVELOPMENT','r1','EXECUTED',2,2,2)`).run();
    target.query(`INSERT INTO task_revisions
      (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
      VALUES ('r1','t1',1,NULL,'Do work','[]','user','initial',2)`).run();
  })();
}

function planInput(overrides: Partial<Parameters<Phase1Database['recordTargetedTestPlan']>[0]> = {}) {
  return {
    planId: 'plan-1',
    projectId: 'p1',
    taskId: 't1',
    revisionId: 'r1',
    testedCommit: commit,
    planVersion: 'targeted-test-plan-v1',
    planDigest,
    sourcePath: '.codeestra/tests.json',
    scope: 'domain and storage rules for the plan binding',
    commands: [{ id: 'domain', argv: ['bun', 'test', 'packages/domain/test'], cwd: '.',
      timeoutSeconds: 120 }],
    recordedBy: 'local-user',
    recordedAt: 10,
    ...overrides,
  };
}

function fullSuiteInput(overrides: Partial<Parameters<Phase1Database['beginDevFullSuiteRun']>[0]> = {}) {
  return {
    evidenceId: 'evidence-1',
    projectId: 'p1',
    devRef: 'refs/heads/dev',
    devCommit: commit,
    policyVersion: 'verification-policy-v1',
    policyDigest,
    lockfilePath: 'bun.lock',
    lockfilePresent: true,
    lockfileDigest,
    commands: [{ id: 'check', argv: ['bun', 'run', 'check'], cwd: '.', timeoutSeconds: 1_800 }],
    copyPath: '/home/verifications/p1/evidence-1',
    commandId: 'cmd-full-suite-1',
    payloadHash: 'payload-1',
    observedBy: 'runtime-full-suite',
    startedAt: 20,
    ...overrides,
  };
}

beforeEach(() => {
  storage = new Phase1Database();
  db = storage.sqlite;
  seedProjectAndTask(db);
});

describe('layered verification schema', () => {
  test('reserves a version at or above 25 and adds both new tables and the new columns', () => {
    expect(phase1SchemaVersion).toBeGreaterThanOrEqual(25);
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    expect(tables).toContain('targeted_test_plans');
    expect(tables).toContain('dev_full_suite_evidence');
    const verificationColumns = db.query<{ name: string }, []>(
      'PRAGMA table_info(verification_runs)').all().map((row) => row.name);
    expect(verificationColumns).toEqual(expect.arrayContaining(['policy_source', 'plan_id',
      'plan_version', 'plan_digest']));
    const promotionColumns = db.query<{ name: string }, []>(
      'PRAGMA table_info(stable_promotions)').all().map((row) => row.name);
    expect(promotionColumns).toEqual(expect.arrayContaining(['full_suite_evidence_id',
      'full_suite_dev_commit', 'full_suite_policy_version', 'full_suite_policy_digest',
      'full_suite_lockfile_digest', 'approved_full_suite_evidence_id']));
    // v16 stays permanently unused: a database stamped 17–24 must still get this step.
    expect(tables).not.toContain('verification_runs_v16');
  });
});

describe('targeted test plans are append-only', () => {
  test('records a plan bound to its exact subject and replays the identical digest', () => {
    const first = storage.recordTargetedTestPlan(planInput());
    expect(first.created).toBe(true);
    expect(first.plan).toMatchObject({ taskId: 't1', revisionId: 'r1', testedCommit: commit,
      planDigest, recordedBy: 'local-user' });
    const again = storage.recordTargetedTestPlan(planInput({ planId: 'plan-2' }));
    expect(again.created).toBe(false);
    expect(again.plan.planId).toBe('plan-1');
    expect(storage.listTargetedTestPlans('p1', 't1')).toHaveLength(1);
  });

  test('a scope change appends a new record and keeps the previous one as audit', () => {
    storage.recordTargetedTestPlan(planInput());
    const widened = storage.recordTargetedTestPlan(planInput({
      planId: 'plan-2', planDigest: 'e'.repeat(64), recordedAt: 11,
      commands: [
        { id: 'domain', argv: ['bun', 'test', 'packages/domain/test'], cwd: '.', timeoutSeconds: 120 },
        { id: 'storage', argv: ['bun', 'test', 'packages/storage/test'], cwd: '.',
          timeoutSeconds: 120 },
      ],
    }));
    expect(widened.created).toBe(true);
    const history = storage.listTargetedTestPlans('p1', 't1');
    expect(history.map((plan) => plan.planId)).toEqual(['plan-2', 'plan-1']);
    expect(storage.getLatestTargetedTestPlan({ projectId: 'p1', taskId: 't1', revisionId: 'r1',
      testedCommit: commit })?.planId).toBe('plan-2');
  });

  test('the database itself refuses to rewrite or delete a recorded plan', () => {
    storage.recordTargetedTestPlan(planInput());
    expect(() => db.query(
      "UPDATE targeted_test_plans SET plan_digest = 'f' WHERE id = 'plan-1'").run())
      .toThrow();
    expect(() => db.query("DELETE FROM targeted_test_plans WHERE id = 'plan-1'").run()).toThrow();
    expect(storage.getLatestTargetedTestPlan({ projectId: 'p1', taskId: 't1', revisionId: 'r1',
      testedCommit: commit })?.planDigest).toBe(planDigest);
  });

  test('a plan cannot be recorded for a revision the Task no longer points at', () => {
    // The Task points at r1; recording for another revision is refused before any row is written,
    // so a plan can never describe a scope the Task does not currently carry.
    try {
      storage.recordTargetedTestPlan(planInput({ revisionId: 'r2' }));
      throw new Error('expected the record to be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).code).toBe('CONCURRENT_MODIFICATION');
    }
    expect(storage.listTargetedTestPlans('p1', 't1')).toHaveLength(0);
  });

  test('the subject lookup is exact: another commit of the same revision has no plan', () => {
    storage.recordTargetedTestPlan(planInput());
    expect(storage.getLatestTargetedTestPlan({ projectId: 'p1', taskId: 't1', revisionId: 'r1',
      testedCommit: 'a'.repeat(40) })).toBeNull();
  });
});

describe('dev full-suite evidence', () => {
  test('records a run, completes it with evidence, and replays the same command ID', () => {
    const begun = storage.beginDevFullSuiteRun(fullSuiteInput());
    expect(begun.created).toBe(true);
    expect(begun.evidence.state).toBe('RUNNING');
    expect(begun.evidence.lockfilePresent).toBe(true);
    expect(begun.evidence.endedAt).toBeNull();
    const completed = storage.completeDevFullSuiteRun({
      evidenceId: 'evidence-1', state: 'PASSED', outcomeCode: 'PASSED',
      evidence: { testedCommit: commit, commands: [] }, endedAt: 30,
    });
    expect(completed).toMatchObject({ state: 'PASSED', outcomeCode: 'PASSED', endedAt: 30 });
    // Replaying the command ID returns the recorded run instead of starting a second one.
    const replay = storage.beginDevFullSuiteRun(fullSuiteInput({ evidenceId: 'evidence-2' }));
    expect(replay.created).toBe(false);
    expect(replay.evidence.evidenceId).toBe('evidence-1');
    expect(storage.listDevFullSuiteEvidence('p1')).toHaveLength(1);
  });

  test('a re-run after invalidation appends a new row instead of rewriting the old one', () => {
    storage.beginDevFullSuiteRun(fullSuiteInput());
    storage.completeDevFullSuiteRun({ evidenceId: 'evidence-1', state: 'PASSED',
      outcomeCode: 'PASSED', evidence: {}, endedAt: 30 });
    storage.beginDevFullSuiteRun(fullSuiteInput({ evidenceId: 'evidence-2',
      commandId: 'cmd-full-suite-2', payloadHash: 'payload-1', startedAt: 40 }));
    storage.completeDevFullSuiteRun({ evidenceId: 'evidence-2', state: 'FAILED',
      outcomeCode: 'COMMAND_FAILED', evidence: {}, endedAt: 50 });
    const rows = storage.listDevFullSuiteEvidenceForCommit('p1', commit);
    expect(rows.map((row) => [row.evidenceId, row.state]))
      .toEqual([['evidence-2', 'FAILED'], ['evidence-1', 'PASSED']]);
  });

  test('the same command ID with a different payload is refused', () => {
    storage.beginDevFullSuiteRun(fullSuiteInput());
    expect(() => storage.beginDevFullSuiteRun(fullSuiteInput({
      evidenceId: 'evidence-2', payloadHash: 'payload-2',
    }))).toThrow(StorageError);
  });

  test('a run left RUNNING by a previous Runtime is closed as an ERROR, not a pass', () => {
    storage.beginDevFullSuiteRun(fullSuiteInput());
    const reconciled = storage.reconcileDevFullSuiteEvidence(60);
    expect(reconciled).toEqual(['evidence-1']);
    expect(storage.getDevFullSuiteEvidence('p1', 'evidence-1')).toMatchObject({
      state: 'ERROR', outcomeCode: 'RUNTIME_RESTARTED', endedAt: 60,
    });
    // Idempotent: the fact was already recorded.
    expect(storage.reconcileDevFullSuiteEvidence(70)).toEqual([]);
  });

  test('a terminal run must carry both its end time and its outcome code', () => {
    storage.beginDevFullSuiteRun(fullSuiteInput());
    expect(() => db.query(`
      UPDATE dev_full_suite_evidence SET state='PASSED' WHERE id='evidence-1'
    `).run()).toThrow();
  });

  test('evidence of one project is not readable through another project', () => {
    storage.beginDevFullSuiteRun(fullSuiteInput());
    expect(() => storage.getDevFullSuiteEvidence('other-project', 'evidence-1'))
      .toThrow(StorageError);
  });
});
