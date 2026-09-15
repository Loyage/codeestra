import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentAnswerMigration,
  agentConfigurationMigration,
  agentDisconnectMigration,
  agentObservationMigration,
  agentStartMigration,
  impactAnalysisMigration,
  integrationPipelineMigration,
  operationProgressMigration,
  phase1Migration,
  phase1SchemaVersion,
  reclamationMigration,
  revisionDeliveryMigration,
  sessionHandoffMigration,
  sessionTerminalMigration,
  stablePromotionMigration,
  taskControlMigration,
  taskDependenciesMigration,
  taskVerificationMigration,
  verificationProgressMigration,
  workspaceRetryMigration,
  Phase1Database,
  type ImpactSnapshotInput,
} from '../src/index.js';

const oid = 'a'.repeat(40);
const digest = 'f'.repeat(64);

function createDatabase(filename: string): Database {
  const database = new Database(filename, { create: true, strict: true });
  database.exec('PRAGMA foreign_keys=ON;');
  return database;
}

/** The shared fixture rows every storage test in this file builds on. */
function seedProject(database: Database): void {
  database.query(`INSERT INTO projects
    (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
    VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','sha1',1)`).run();
  database.query(`INSERT INTO project_trusts
    (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
    VALUES ('trust1','p1','/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run();
  database.transaction(() => {
    database.query(`INSERT INTO tasks
      (id,project_id,display_number,kind,current_revision_id,state,created_at,updated_at)
      VALUES ('t1','p1',1,'DEVELOPMENT','r1','READY',2,2)`).run();
    database.query(`INSERT INTO task_revisions
      (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
      VALUES ('r1','t1',1,NULL,'Do work','[]','user','initial',2)`).run();
  })();
}

function snapshotInput(overrides: Partial<ImpactSnapshotInput> = {}): ImpactSnapshotInput {
  return {
    id: crypto.randomUUID(),
    projectId: 'p1',
    taskId: 't1',
    revisionId: 'r1',
    baseCommit: oid,
    analyzerVersion: 'impact-analyzer-v1',
    policyVersion: `impact-policy-v1#${digest.slice(0, 12)}`,
    policyDigest: digest,
    caseMode: 'INSENSITIVE',
    changeFingerprint: 'fingerprint-1',
    complete: true,
    incompleteReasons: [],
    files: ['src/a.ts'],
    importantDirectories: [],
    modules: [],
    globalResources: [],
    unclassifiedFiles: ['src/a.ts'],
    evidence: ['evidence'],
    createdAt: 10,
    ...overrides,
  };
}

describe('schema v20 impact analysis migration', () => {
  test('upgrades a version 19 database additively and keeps every existing row', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-v19-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      const legacy = createDatabase(filename);
      for (const migration of [phase1Migration, agentStartMigration, agentObservationMigration,
        agentAnswerMigration, agentDisconnectMigration, taskVerificationMigration,
        workspaceRetryMigration, agentConfigurationMigration, taskControlMigration,
        integrationPipelineMigration, operationProgressMigration, reclamationMigration,
        stablePromotionMigration, sessionHandoffMigration, taskDependenciesMigration,
        verificationProgressMigration, sessionTerminalMigration, revisionDeliveryMigration]) {
        legacy.exec(migration);
      }
      legacy.exec('PRAGMA user_version=19');
      seedProject(legacy);
      // A version 19 database already carries the revision-delivery ledger; it must survive.
      legacy.query(`INSERT INTO task_revision_deliveries
        (id,project_id,task_id,revision_id,state,created_at,updated_at)
        VALUES ('d1','p1','t1','r1','PENDING',3,3)`).run();
      legacy.close();

      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBe(phase1SchemaVersion);
      // Integration fix: this lane's own step is v20, but the capacity/slot step (v21) merged after
      // it, so the current schema version is 21. The claim under test is that the upgrade reaches
      // the current version and lands this lane's tables, not that this lane is last.
      expect(phase1SchemaVersion).toBe(24);
      expect(upgraded.sqlite.query<{ id: string }, []>(
        "SELECT id FROM task_revision_deliveries WHERE id='d1'",
      ).get()?.id).toBe('d1');
      const tables = upgraded.sqlite.query<{ name: string }, []>(`
        SELECT name FROM sqlite_master WHERE type='table' AND name IN
          ('project_impact_policy_confirmations','impact_snapshots','impact_assessments') ORDER BY name
      `).all().map((row) => row.name);
      expect(tables).toEqual([
        'impact_assessments', 'impact_snapshots', 'project_impact_policy_confirmations']);
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
      // The new tables are usable on the upgraded database, and upgrading never invents a
      // confirmation row for a project that was trusted before the mapping existed.
      expect(upgraded.getConfirmedImpactPolicy('p1')).toBeNull();
      expect(upgraded.listImpactSnapshots({ projectId: 'p1' })).toEqual([]);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('upgrades a version 16 database without touching the permanently unused version 16 branch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-v16-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      const legacy = createDatabase(filename);
      // Exactly the migrations that existed when the schema was stamped 15, then a manual stamp of
      // 16: the documented rule is that a database may already be stamped past an unused version,
      // so no `if (version < 16)` step may exist.
      for (const migration of [phase1Migration, agentStartMigration, agentObservationMigration,
        agentAnswerMigration, agentDisconnectMigration, taskVerificationMigration,
        workspaceRetryMigration, agentConfigurationMigration, taskControlMigration,
        integrationPipelineMigration, operationProgressMigration, reclamationMigration,
        stablePromotionMigration, sessionHandoffMigration, taskDependenciesMigration]) {
        legacy.exec(migration);
      }
      legacy.exec('PRAGMA user_version=16');
      seedProject(legacy);
      legacy.close();

      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBe(phase1SchemaVersion);
      expect(upgraded.sqlite.query<{ id: string }, []>(
        "SELECT id FROM tasks WHERE id='t1'",
      ).get()?.id).toBe('t1');
      const tables = upgraded.sqlite.query<{ name: string }, []>(`
        SELECT name FROM sqlite_master WHERE type='table' AND name IN
          ('impact_snapshots','impact_assessments','verification_runs','session_terminals',
           'task_revision_deliveries') ORDER BY name
      `).all().map((row) => row.name);
      expect(tables).toEqual(['impact_assessments', 'impact_snapshots', 'session_terminals',
        'task_revision_deliveries', 'verification_runs']);
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('never inserts a version 16 migration step', () => {
    // The version 16 branch must stay unused forever: a database stamped 17-19 would skip it.
    expect(impactAnalysisMigration).not.toContain('user_version');
  });
});

describe('impact snapshot persistence', () => {
  let database: Phase1Database;

  function fresh(): Phase1Database {
    const created = new Phase1Database();
    // Project, trust, Task and revision rows the foreign keys require.
    created.sqlite.query(`INSERT INTO projects
      (id,name,repo_root,git_common_dir,main_ref,dev_ref,object_format,created_at)
      VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','refs/heads/dev','sha1',1)`).run();
    created.sqlite.query(`INSERT INTO project_trusts
      (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
      VALUES ('trust1','p1','/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run();
    created.sqlite.transaction(() => {
      created.sqlite.query(`INSERT INTO tasks
        (id,project_id,display_number,kind,current_revision_id,state,created_at,updated_at)
        VALUES ('t1','p1',1,'DEVELOPMENT','r1','READY',2,2)`).run();
      created.sqlite.query(`INSERT INTO task_revisions
        (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
        VALUES ('r1','t1',1,NULL,'Do work','[]','user','initial',2)`).run();
    })();
    return created;
  }

  afterEach(() => {
    database?.close();
  });

  test('records a snapshot once and returns the same row for the same facts', () => {
    database = fresh();
    const first = database.recordImpactSnapshot(snapshotInput());
    const replay = database.recordImpactSnapshot(snapshotInput({ id: crypto.randomUUID() }));
    expect(replay.id).toBe(first.id);
    expect(database.listImpactSnapshots({ projectId: 'p1' })).toHaveLength(1);
    expect(first.files).toEqual(['src/a.ts']);
    expect(first.complete).toBe(true);
    // The reuse key is the five documented facts plus the observed change fingerprint.
    expect(database.findImpactSnapshot({
      taskId: 't1', revisionId: 'r1', baseCommit: oid, analyzerVersion: 'impact-analyzer-v1',
      policyVersion: first.policyVersion, changeFingerprint: 'fingerprint-1',
    })?.id).toBe(first.id);
    expect(database.findImpactSnapshot({
      taskId: 't1', revisionId: 'r1', baseCommit: oid, analyzerVersion: 'impact-analyzer-v1',
      policyVersion: first.policyVersion, changeFingerprint: 'other',
    })).toBeNull();
  });

  test('writes a new row instead of overwriting when the diff grew', () => {
    database = fresh();
    const first = database.recordImpactSnapshot(snapshotInput());
    const second = database.recordImpactSnapshot(snapshotInput({
      id: crypto.randomUUID(), changeFingerprint: 'fingerprint-2', files: ['src/a.ts', 'src/b.ts'],
      createdAt: 11,
    }));
    expect(second.id).not.toBe(first.id);
    const stored = database.listImpactSnapshots({ projectId: 'p1' });
    expect(stored).toHaveLength(2);
    // The old prediction stays readable: nothing rewrote it, and the newest row is listed first.
    expect(stored.find((row) => row.id === first.id)?.files).toEqual(['src/a.ts']);
    expect(stored[0]?.changeFingerprint).toBe('fingerprint-2');
  });

  test('refuses an update or delete of a stored snapshot', () => {
    database = fresh();
    const stored = database.recordImpactSnapshot(snapshotInput());
    expect(() => database.sqlite.query(
      "UPDATE impact_snapshots SET complete=1 WHERE id=?1",
    ).run(stored.id)).toThrow();
    expect(() => database.sqlite.query('DELETE FROM impact_snapshots WHERE id=?1').run(stored.id))
      .toThrow();
  });

  test('refuses a completeness claim that contradicts its own reasons', () => {
    database = fresh();
    expect(() => database.recordImpactSnapshot(snapshotInput({ complete: false }))).toThrow();
    expect(() => database.recordImpactSnapshot(snapshotInput({
      incompleteReasons: ['POLICY_ABSENT'],
    }))).toThrow();
    const incomplete = database.recordImpactSnapshot(snapshotInput({
      complete: false, incompleteReasons: ['POLICY_ABSENT'],
    }));
    expect(incomplete.complete).toBe(false);
  });

  test('records one assessment per snapshot pair and never rewrites it', () => {
    database = fresh();
    database.sqlite.transaction(() => {
      database.sqlite.query(`INSERT INTO tasks
        (id,project_id,display_number,kind,current_revision_id,state,created_at,updated_at)
        VALUES ('t2','p1',2,'DEVELOPMENT','r2','READY',2,2)`).run();
      database.sqlite.query(`INSERT INTO task_revisions
        (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
        VALUES ('r2','t2',1,NULL,'Other work','[]','user','initial',2)`).run();
    })();
    const candidate = database.recordImpactSnapshot(snapshotInput());
    const other = database.recordImpactSnapshot(snapshotInput({
      id: crypto.randomUUID(), taskId: 't2', revisionId: 'r2', changeFingerprint: 'fingerprint-2',
    }));
    const input = {
      id: crypto.randomUUID(),
      projectId: 'p1',
      candidateTaskId: 't1',
      candidateRevisionId: 'r1',
      candidateSnapshotId: candidate.id,
      otherTaskId: 't2',
      otherRevisionId: 'r2',
      otherSnapshotId: other.id,
      verdict: 'SAFE_TO_PARALLELIZE' as const,
      reasonCodes: ['NO_CONFLICT'],
      hits: [],
      evidence: ['compared 1 active/reserved Task'],
      createdAt: 20,
    };
    const first = database.recordImpactAssessment(input);
    const replay = database.recordImpactAssessment({ ...input, id: crypto.randomUUID() });
    expect(replay.id).toBe(first.id);
    expect(() => database.sqlite.query(
      "UPDATE impact_assessments SET verdict='CONFLICTING' WHERE id=?1",
    ).run(first.id)).toThrow();
    expect(database.listImpactAssessments({ projectId: 'p1', taskId: 't2' })).toHaveLength(1);
  });
});

describe('impact policy confirmation', () => {
  afterEach(() => {
    database?.close();
  });
  let database: Phase1Database;

  function trustInput(version: number, impactDigest: string | null) {
    return {
      id: 'p1',
      trustId: crypto.randomUUID(),
      name: 'Project',
      repoRoot: '/repo',
      gitCommonDir: '/repo/.git',
      mainRef: 'refs/heads/main',
      devRef: 'refs/heads/dev',
      objectFormat: 'sha1' as const,
      policyVersion: 1,
      verificationPolicyConfirmationId: crypto.randomUUID(),
      verificationPolicy: { state: 'ABSENT' as const, digest: null,
        mainRef: 'refs/heads/main', mainCommit: oid },
      trustedAt: version,
      actor: 'user',
      ...(impactDigest === null
        ? {}
        : {
            impactPolicyConfirmationId: crypto.randomUUID(),
            impactPolicy: {
              state: 'PRESENT' as const,
              digest: impactDigest,
              contentDigest: null,
              code: null,
              mainRef: 'refs/heads/main',
              mainCommit: oid,
            },
          }),
    };
  }

  test('keeps one active confirmation and supersedes it on re-trust', () => {
    database = new Phase1Database();
    database.trustProject(trustInput(1, digest));
    const confirmed = database.getConfirmedImpactPolicy('p1');
    expect(confirmed?.state).toBe('PRESENT');
    expect(confirmed?.digest).toBe(digest);

    const otherDigest = 'e'.repeat(64);
    database.trustProject({ ...trustInput(2, otherDigest), id: 'p2' });
    // Re-trusting the *same* repository keeps one project and supersedes the old confirmation.
    expect(database.getConfirmedImpactPolicy('p1')?.digest).toBe(otherDigest);
    const rows = database.sqlite.query<{ status: string }, []>(
      "SELECT status FROM project_impact_policy_confirmations WHERE project_id='p1' ORDER BY confirmed_at",
    ).all();
    expect(rows.map((row) => row.status)).toEqual(['SUPERSEDED', 'ACTIVE']);
  });

  test('records no confirmation when a trust never declared a mapping', () => {
    database = new Phase1Database();
    database.trustProject(trustInput(1, digest));
    database.trustProject(trustInput(2, null));
    // Forgetting to declare the mapping must leave every snapshot incomplete, never silently
    // reuse the previous digest.
    expect(database.getConfirmedImpactPolicy('p1')).toBeNull();
  });

  test('invalidating trust also supersedes the impact confirmation', () => {
    database = new Phase1Database();
    database.trustProject(trustInput(1, digest));
    database.invalidateProjectTrust('p1', 5);
    expect(database.getConfirmedImpactPolicy('p1')).toBeNull();
  });
});

describe('impact subject projections', () => {
  test('selects Tasks that hold a resource and their live workspace', () => {
    const database = new Phase1Database();
    try {
      seedProject(database.sqlite);
      database.sqlite.query(`INSERT INTO workspaces
        (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
        VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1',?1,'IN_USE',3)`).run(oid);
      database.sqlite.query(`INSERT INTO executions
        (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,adapter_id,
         adapter_version,state,resource_held,base_commit,version,started_at)
        VALUES ('e1','t1',1,'r1','r1','w1','pi','0.84.4','RUNNING',1,?1,0,4)`).run(oid);
      const active = database.listImpactActiveTasks('p1');
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({
        taskId: 't1', taskState: 'READY', revisionId: 'r1', executionState: 'RUNNING',
        workspacePath: '/work/t1', workspaceBaseCommit: oid,
      });
      // The candidate itself is excluded so a Task is never compared with its own impact.
      expect(database.listImpactActiveTasks('p1', 't1')).toEqual([]);
      const candidate = database.getImpactCandidateTask('p1', 't1');
      expect(candidate).toMatchObject({ taskId: 't1', workspacePath: '/work/t1', workspaceState: 'IN_USE' });
      expect(database.getImpactCandidateTask('p1', 'missing')).toBeNull();

      // A released Execution no longer holds a resource, so it is not part of the active set.
      database.sqlite.query(
        "UPDATE executions SET state='FAILED',resource_held=0,ended_at=5 WHERE id='e1'",
      ).run();
      expect(database.listImpactActiveTasks('p1')).toEqual([]);
    } finally {
      database.close();
    }
  });
});
