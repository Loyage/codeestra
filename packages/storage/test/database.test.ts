import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentAnswerMigration,
  agentConfigurationMigration,
  agentDisconnectMigration,
  agentObservationMigration,
  agentStartMigration,
  Phase1Database,
  StorageError,
  phase1Migration,
  phase1SchemaVersion,
  taskVerificationMigration,
  workspaceRetryMigration,
} from '../src/index.js';

const oid = 'a'.repeat(40);
let storage: Phase1Database;
let db: Database;

function seedProject(): void {
  db.query(`INSERT INTO projects
    (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
    VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','sha1',1)`).run();
  db.query(`INSERT INTO project_trusts
    (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
    VALUES ('trust1','p1','/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run();
}

function seedTask(): void {
  db.transaction(() => {
    db.query(`INSERT INTO tasks
      (id,project_id,display_number,kind,current_revision_id,state,created_at,updated_at)
      VALUES ('t1','p1',1,'DEVELOPMENT','r1','READY',2,2)`).run();
    db.query(`INSERT INTO task_revisions
      (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
      VALUES ('r1','t1',1,NULL,'Do work','[]','user','initial',2)`).run();
  })();
}

function seedWorkspace(): void {
  db.query(`INSERT INTO workspaces
    (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
    VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1',?1,'IN_USE',3)`).run(oid);
}

function insertExecution(id: string, attempt: number, state = 'RUNNING', held = 1): void {
  db.query(`INSERT INTO executions
    (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,
     adapter_id,adapter_version,state,resource_held,base_commit,started_at)
    VALUES (?1,'t1',?2,'r1','r1','w1','fake','1',?3,?4,?5,4)`)
    .run(id, attempt, state, held, oid);
}

beforeEach(() => {
  storage = new Phase1Database();
  db = storage.sqlite;
  seedProject();
});

afterEach(() => storage.close());

describe('Phase 1 migration', () => {
  test('sets schema version and enables foreign keys', () => {
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
      .toBe(phase1SchemaVersion);
    expect(db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
  });

  test('reopens a migrated file and refuses a newer schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      const first = new Phase1Database(filename);
      first.sqlite.query(`INSERT INTO projects
        (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
        VALUES ('persisted','Project','/persistent','/persistent/.git','refs/heads/main','sha1',1)`).run();
      first.close();

      const reopened = new Phase1Database(filename);
      expect(reopened.sqlite.query('SELECT id FROM projects WHERE id=?1').get('persisted')).not.toBeNull();
      reopened.sqlite.exec(`PRAGMA user_version=${phase1SchemaVersion + 1}`);
      reopened.close();

      expect(() => new Phase1Database(filename)).toThrow(StorageError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('upgrades a version 1 database with the additive Agent Session migration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-v1-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      const legacy = new Database(filename, { create: true, strict: true });
      legacy.exec(phase1Migration);
      legacy.exec('PRAGMA user_version=1');
      legacy.close();
      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
        .toBe(phase1SchemaVersion);
      expect(upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_sessions'",
      ).get()?.name).toBe('agent_sessions');
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('upgrades a version 2 database with Adapter event and Attention tables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-v2-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      const legacy = new Database(filename, { create: true, strict: true });
      legacy.exec(phase1Migration);
      legacy.exec(agentStartMigration);
      legacy.exec('PRAGMA user_version=2');
      legacy.close();
      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
        .toBe(phase1SchemaVersion);
      const tables = upgraded.sqlite.query<{ name: string }, []>(`
        SELECT name FROM sqlite_master WHERE type='table'
          AND name IN ('adapter_events','attention_requests') ORDER BY name
      `).all().map((row) => row.name);
      expect(tables).toEqual(['adapter_events', 'attention_requests']);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('upgrades a version 3 database with typed Attention answers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-v3-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      const legacy = new Database(filename, { create: true, strict: true });
      legacy.exec(phase1Migration);
      legacy.exec(agentStartMigration);
      legacy.exec(agentObservationMigration);
      legacy.exec('PRAGMA user_version=3');
      legacy.close();
      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
        .toBe(phase1SchemaVersion);
      expect(upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='attention_answers'",
      ).get()?.name).toBe('attention_answers');
      const columns = upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('attention_requests')",
      ).all().map((row) => row.name);
      expect(columns).toContain('response_type');
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('upgrades a version 4 database with the Adapter disconnect event type', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-v4-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      const legacy = new Database(filename, { create: true, strict: true });
      legacy.exec(phase1Migration);
      legacy.exec(agentStartMigration);
      legacy.exec(agentObservationMigration);
      legacy.exec(agentAnswerMigration);
      legacy.exec('PRAGMA user_version=4');
      legacy.close();
      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
        .toBe(phase1SchemaVersion);
      const definition = upgraded.sqlite.query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='adapter_events'",
      ).get()?.sql ?? '';
      expect(definition).toContain("'disconnected'");
      expect(definition).toContain('PRIMARY KEY(session_id,provider_event_id)');
      expect(definition).toContain('UNIQUE(session_id,cursor)');
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('commits a task and its first revision atomically through deferred foreign keys', () => {
    seedTask();
    expect(db.query<{ current_revision_id: string }, []>('SELECT current_revision_id FROM tasks').get())
      .toEqual({ current_revision_id: 'r1' });
  });

  test('rejects a task without its referenced revision at transaction commit', () => {
    expect(() => db.transaction(() => {
      db.query(`INSERT INTO tasks
        (id,project_id,display_number,kind,current_revision_id,state,created_at,updated_at)
        VALUES ('bad','p1',2,'DEVELOPMENT','missing','DRAFT',2,2)`).run();
    })()).toThrow();
    expect(db.query('SELECT id FROM tasks WHERE id=?1').get('bad')).toBeNull();
  });

  test('makes revision rows append-only', () => {
    seedTask();
    expect(() => db.query("UPDATE task_revisions SET specification='changed' WHERE id='r1'").run())
      .toThrow('task revisions are append-only');
    expect(() => db.query("DELETE FROM task_revisions WHERE id='r1'").run())
      .toThrow('task revisions are append-only');
  });

  test('enforces one held execution and terminal resource consistency', () => {
    seedTask();
    seedWorkspace();
    insertExecution('e1', 1);
    expect(() => insertExecution('e2', 2)).toThrow();
    expect(() => insertExecution('bad-terminal', 3, 'FAILED', 1)).toThrow();
  });

  test('enforces one active result authorization and status timestamps', () => {
    seedTask();
    seedWorkspace();
    insertExecution('e1', 1);
    const insert = (id: string, status: string, consumed: number | null, invalidated: number | null): void => {
      db.query(`INSERT INTO result_commit_authorizations
        (id,task_id,execution_id,revision_id,workspace_id,expected_head,change_fingerprint,
         actor,status,created_at,consumed_at,invalidated_at)
        VALUES (?1,'t1','e1','r1','w1',?2,'fp','user',?3,5,?4,?5)`)
        .run(id, oid, status, consumed, invalidated);
    };
    insert('a1', 'ACTIVE', null, null);
    expect(() => insert('a2', 'ACTIVE', null, null)).toThrow();
    expect(() => insert('a3', 'CONSUMED', null, null)).toThrow();
  });

  test('requires task verification evidence to match one execution and revision', () => {
    seedTask();
    seedWorkspace();
    insertExecution('e1', 1);
    db.query(`INSERT INTO operations
      (id,project_id,kind,aggregate_id,idempotency_key,state,request_json,created_at,updated_at)
      VALUES ('op1','p1','RUN_TASK_VERIFICATION','v1','cmd1','PLANNED','{}',5,5)`).run();
    const insert = (id: string, executionId: string): void => {
      db.query(`INSERT INTO verification_runs
        (id,project_id,task_id,execution_id,revision_id,operation_id,command_id,tested_commit,
         tested_tree,policy_version,policy_digest,main_commit,commands_json,copy_path,state,queued_at)
        VALUES (?1,'p1','t1',?2,'r1','op1',?1,?3,'tree','verification-policy-v1',?4,?3,'[]','/copies',
          'QUEUED',5)`).run(id, executionId, oid, 'd'.repeat(64));
    };
    insert('v1', 'e1');
    expect(() => insert('v2', 'missing')).toThrow();
  });

  test('upgrades a version 5 database with Task verification tables and evidence columns', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-v5-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      const legacy = new Database(filename, { create: true, strict: true });
      legacy.exec(phase1Migration);
      legacy.exec(agentStartMigration);
      legacy.exec(agentObservationMigration);
      legacy.exec(agentAnswerMigration);
      legacy.exec(agentDisconnectMigration);
      legacy.exec('PRAGMA user_version=5');
      legacy.close();
      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
        .toBe(phase1SchemaVersion);
      const tables = upgraded.sqlite.query<{ name: string }, []>(`
        SELECT name FROM sqlite_master WHERE type='table'
          AND name IN ('verification_runs','project_verification_policy_confirmations') ORDER BY name
      `).all().map((row) => row.name);
      expect(tables).toEqual(['project_verification_policy_confirmations', 'verification_runs']);
      const columns = upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('verification_runs')",
      ).all().map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining([
        'policy_digest', 'main_commit', 'evidence_json', 'tested_tree', 'operation_id', 'outcome_code',
      ]));
      expect(columns).not.toContain('tree_fingerprint');
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('workspace retry after a released preparation', () => {
  test('upgrades a version 6 database so a released workspace path can be reused', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-v6-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      const legacy = new Database(filename, { create: true, strict: true });
      legacy.exec('PRAGMA foreign_keys=ON;');
      legacy.exec(phase1Migration);
      legacy.exec(agentStartMigration);
      legacy.exec(agentObservationMigration);
      legacy.exec(agentAnswerMigration);
      legacy.exec(agentDisconnectMigration);
      legacy.exec(taskVerificationMigration);
      legacy.exec('PRAGMA user_version=6');
      // One Task whose preparation failed and was released, keeping the path in history.
      legacy.query(`INSERT INTO projects
        (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
        VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','sha1',1)`).run();
      legacy.query(`INSERT INTO project_trusts
        (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
        VALUES ('trust1','p1','/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run();
      legacy.transaction(() => {
        legacy.query(`INSERT INTO tasks
          (id,project_id,display_number,kind,current_revision_id,state,created_at,updated_at)
          VALUES ('t1','p1',1,'DEVELOPMENT','r1','READY',2,2)`).run();
        legacy.query(`INSERT INTO task_revisions
          (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
          VALUES ('r1','t1',1,NULL,'Do work','[]','user','initial',2)`).run();
      })();
      legacy.query(`INSERT INTO workspaces
        (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
        VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1',?1,'RELEASED',3)`).run(oid);
      // The version 6 constraint rejected any second row for the same path.
      expect(() => legacy.query(`INSERT INTO workspaces
        (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
        VALUES ('w2','t1','refs/heads/task/t1','/work/t1','owner-2',?1,'RESERVED',4)`).run(oid))
        .toThrow();
      legacy.close();

      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
        .toBe(phase1SchemaVersion);
      // A new live workspace may reuse the released path...
      upgraded.sqlite.query(`INSERT INTO workspaces
        (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
        VALUES ('w2','t1','refs/heads/task/t1','/work/t1','owner-2',?1,'RESERVED',4)`).run(oid);
      // ...but only one live workspace may hold it at a time.
      expect(() => upgraded.sqlite.query(`INSERT INTO workspaces
        (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
        VALUES ('w3','t1','refs/heads/task/t1','/work/t1','owner-3',?1,'READY',5)`).run(oid))
        .toThrow();
      expect(upgraded.sqlite.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM pragma_index_list('workspaces') WHERE name='one_live_workspace_path'",
      ).get()?.count).toBe(1);
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('keeps the workspace history of a released path', () => {
    expect(workspaceRetryMigration).toContain("WHERE state <> 'RELEASED'");
  });
});

describe('project trust and verification policy confirmation', () => {
  let trust: Phase1Database;
  let trustDb: Database;

  beforeEach(() => {
    trust = new Phase1Database();
    trustDb = trust.sqlite;
  });
  afterEach(() => trust.close());

  const trustInput = (overrides: Readonly<Record<string, unknown>> = {}) => ({
    id: 'p-new',
    trustId: 'trust-new',
    name: 'Project',
    repoRoot: '/repo',
    gitCommonDir: '/repo/.git',
    mainRef: 'refs/heads/main',
    objectFormat: 'sha1' as const,
    policyVersion: 1,
    verificationPolicyConfirmationId: 'confirm-new',
    verificationPolicy: { state: 'PRESENT' as const, digest: 'a'.repeat(64),
      mainRef: 'refs/heads/main', mainCommit: oid },
    trustedAt: 20,
    actor: 'local-user',
    ...overrides,
  });

  test('records the confirmation with the trust that established it', () => {
    trust.trustProject(trustInput());
    expect(trust.getConfirmedVerificationPolicy('p-new')).toMatchObject({
      state: 'PRESENT', digest: 'a'.repeat(64), mainCommit: oid, actor: 'local-user',
    });
    expect(trust.listTrustedProjects().map((project) => project.id)).toEqual(['p-new']);
  });

  test('supersedes the previous trust and confirmation instead of rewriting history', () => {
    trust.trustProject(trustInput());
    trust.trustProject(trustInput({
      id: 'p-ignored', trustId: 'trust-second', verificationPolicyConfirmationId: 'confirm-second',
      verificationPolicy: { state: 'ABSENT' as const, digest: null,
        mainRef: 'refs/heads/main', mainCommit: oid },
      trustedAt: 30,
    }));
    // The existing project keeps its identity: a second trust never forks it.
    expect(trust.listTrustedProjects().map((project) => project.id)).toEqual(['p-new']);
    expect(trust.getConfirmedVerificationPolicy('p-new')).toMatchObject({ state: 'ABSENT', digest: null });
    const rows = trustDb.query<{ id: string; status: string }, []>(
      'SELECT id,status FROM project_trusts ORDER BY accepted_at',
    ).all();
    expect(rows).toEqual([{ id: 'trust-new', status: 'INVALIDATED' },
      { id: 'trust-second', status: 'ACTIVE' }]);
    const confirmations = trustDb.query<{ id: string; status: string }, []>(
      'SELECT id,status FROM project_verification_policy_confirmations ORDER BY confirmed_at',
    ).all();
    expect(confirmations).toEqual([
      { id: 'confirm-new', status: 'SUPERSEDED' },
      { id: 'confirm-second', status: 'ACTIVE' },
    ]);
  });

  test('refuses a trust whose repository identity differs from the recorded project', () => {
    trust.trustProject(trustInput());
    expect(() => trust.trustProject(trustInput({ id: 'p-other', gitCommonDir: '/repo/.other' })))
      .toThrow(StorageError);
  });

  test('invalidating trust also supersedes the confirmed policy', () => {
    trust.trustProject(trustInput());
    trust.invalidateProjectTrust('p-new', 40);
    expect(trust.getConfirmedVerificationPolicy('p-new')).toBeNull();
    expect(trustDb.query<{ status: string }, [string]>(
      'SELECT status FROM project_verification_policy_confirmations WHERE id=?1',
    ).get('confirm-new')).toEqual({ status: 'SUPERSEDED' });
  });
});

describe('task verification runs', () => {
  const copyPath = '/copies/p1/v1';
  const commands = [{ id: 'smoke', argv: ['echo', 'ok'], cwd: '.', timeoutSeconds: 60 }];

  function seedExecutedTask(): void {
    seedTask();
    seedWorkspace();
    db.query(`INSERT INTO executions
      (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,adapter_id,
       adapter_version,state,resource_held,base_commit,result_commit,started_at)
      VALUES ('e1','t1',1,'r1','r1','w1','fake','1','SUCCEEDED',0,?1,?2,4)`).run(oid, 'c'.repeat(40));
    db.query("UPDATE tasks SET state='EXECUTED',version=version+1 WHERE id='t1'").run();
    db.query("UPDATE workspaces SET state='RETAINED' WHERE id='w1'").run();
  }

  function begin(overrides: Readonly<Record<string, unknown>> = {}) {
    return storage.beginVerificationRun({
      projectId: 'p1',
      taskId: 't1',
      executionId: 'e1',
      revisionId: 'r1',
      testedCommit: 'c'.repeat(40),
      testedTree: 'd'.repeat(40),
      policyVersion: 'verification-policy-v1',
      policyDigest: 'e'.repeat(64),
      mainCommit: oid,
      commands,
      copyPath,
      verificationId: 'v1',
      operationId: 'op1',
      commandId: 'cmd1',
      payloadHash: 'hash1',
      queuedAt: 10,
      ...overrides,
    });
  }

  test('queues one run with its Operation and receipt, and replays without re-queuing', () => {
    seedExecutedTask();
    const first = begin();
    expect(first.created).toBe(true);
    expect(first.plan).toMatchObject({
      verificationId: 'v1', state: 'QUEUED', operationState: 'PLANNED', testedCommit: 'c'.repeat(40),
      policyDigest: 'e'.repeat(64), commands,
    });
    const replay = begin();
    expect(replay.created).toBe(false);
    expect(replay.plan.verificationId).toBe('v1');
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM verification_runs').get()?.count).toBe(1);
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM operations').get()?.count).toBe(1);
    // The replay payload must differ from a fresh command ID used for another run.
    expect(() => begin({ commandId: 'cmd1', payloadHash: 'different' })).toThrow('different payload');
  });

  test('refuses to queue a run for a Task that is not EXECUTED or whose evidence moved', () => {
    seedExecutedTask();
    db.query("UPDATE tasks SET state='RUNNING' WHERE id='t1'").run();
    expect(() => begin()).toThrow('verification needs an EXECUTED Task');
    db.query("UPDATE tasks SET state='EXECUTED' WHERE id='t1'").run();
    expect(() => begin({ testedCommit: 'f'.repeat(40) })).toThrow('Execution evidence changed');
    expect(() => begin({ revisionId: 'r-other' })).toThrow('Task revision changed');
  });

  test('moves QUEUED to RUNNING with the Operation IN_PROGRESS, then records evidence', () => {
    seedExecutedTask();
    begin();
    expect(storage.startVerificationRun({ verificationId: 'v1', startedAt: 11 })).toMatchObject({
      state: 'RUNNING', operationState: 'IN_PROGRESS', startedAt: 11,
    });
    const completed = storage.completeVerificationRun({
      verificationId: 'v1', state: 'PASSED', outcomeCode: 'PASSED',
      evidence: { commands: [{ id: 'smoke', exitCode: 0 }] }, eventId: 'evt-verification', completedAt: 12,
    });
    expect(completed).toMatchObject({
      state: 'PASSED', outcomeCode: 'PASSED', operationState: 'SUCCEEDED', endedAt: 12,
      evidence: { commands: [{ id: 'smoke', exitCode: 0 }] },
    });
    // Completion is idempotent: a replayed completion keeps the first terminal state.
    expect(storage.completeVerificationRun({
      verificationId: 'v1', state: 'FAILED', outcomeCode: 'COMMAND_FAILED', evidence: {},
      eventId: 'evt-second', completedAt: 13,
    }).state).toBe('PASSED');
    expect(db.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM domain_events WHERE event_type='VerificationCompleted'
    `).get()?.count).toBe(1);
    expect(storage.listVerificationRuns('p1', 't1').map((run) => run.verificationId)).toEqual(['v1']);
    expect(storage.listIncompleteVerificationRuns()).toEqual([]);
  });

  test('marks successful evidence stale when the tested commit or policy changes', () => {
    seedExecutedTask();
    begin();
    storage.startVerificationRun({ verificationId: 'v1', startedAt: 11 });
    storage.completeVerificationRun({
      verificationId: 'v1', state: 'PASSED', outcomeCode: 'PASSED', evidence: {}, eventId: 'evt-1',
      completedAt: 12,
    });
    expect(storage.markVerificationsStale({
      projectId: 'p1', taskId: 't1', testedCommit: 'c'.repeat(40), policyDigest: 'e'.repeat(64),
      reason: 'unchanged', eventId: 'evt-stale-none', invalidatedAt: 13,
    })).toBe(0);
    expect(storage.markVerificationsStale({
      projectId: 'p1', taskId: 't1', testedCommit: 'f'.repeat(40), policyDigest: 'e'.repeat(64),
      reason: 'newer result commit', eventId: 'evt-stale', invalidatedAt: 14,
    })).toBe(1);
    const stale = storage.getVerificationRun('p1', 'v1');
    expect(stale.state).toBe('STALE');
    // The original outcome is preserved; staleness is additive evidence.
    expect(stale.outcomeCode).toBe('PASSED');
    expect(stale.evidence).toMatchObject({ staleReason: 'newer result commit' });
    expect(db.query<{ count: number }, []>(`
      SELECT count(*) AS count FROM domain_events WHERE event_type='VerificationInvalidated'
    `).get()?.count).toBe(1);
    expect(storage.markVerificationsStale({
      projectId: 'p1', taskId: 't1', testedCommit: 'f'.repeat(40), policyDigest: 'e'.repeat(64),
      reason: 'again', eventId: 'evt-stale-again', invalidatedAt: 15,
    })).toBe(0);
  });

  test('lists only QUEUED and RUNNING runs as incomplete', () => {
    seedExecutedTask();
    begin();
    expect(storage.listIncompleteVerificationRuns().map((run) => run.state)).toEqual(['QUEUED']);
    storage.startVerificationRun({ verificationId: 'v1', startedAt: 11 });
    expect(storage.listIncompleteVerificationRuns().map((run) => run.state)).toEqual(['RUNNING']);
    expect(() => storage.getVerificationRun('p-other', 'v1')).toThrow(StorageError);
  });
});

describe('event log read cursor', () => {
  function createTask(suffix: string, projectId = 'p1'): void {
    storage.createTask({
      projectId, commandId: `command-${suffix}`, payloadHash: `hash-${suffix}`,
      intentId: `intent-${suffix}`, taskId: `task-${suffix}`, revisionId: `revision-${suffix}`,
      intentEventId: `intent-event-${suffix}`, taskEventId: `task-event-${suffix}`,
      specification: `Task ${suffix}`, constraints: [], kind: 'DEVELOPMENT',
      actor: 'local-user', createdAt: 10,
    });
  }

  test('reports an empty log as cursor zero', () => {
    expect(storage.latestEventSequence()).toBe(0);
    expect(storage.listEventsAfter({ sinceSequence: 0, limit: 10 })).toEqual([]);
  });

  test('reads events in sequence order with parsed payloads', () => {
    createTask('one');
    expect(storage.latestEventSequence()).toBe(2);
    const events = storage.listEventsAfter({ sinceSequence: 0, limit: 10 });
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events.map((event) => event.eventType)).toEqual(['IntentRecorded', 'TaskCreated']);
    expect(events[1]?.payload).toMatchObject({ taskId: 'task-one', revisionId: 'revision-one' });
    expect(events[0]?.schemaVersion).toBe(1);
  });

  test('treats the cursor as exclusive so a reader resumes without a gap', () => {
    createTask('one');
    const first = storage.listEventsAfter({ sinceSequence: 0, limit: 1 });
    expect(first.map((event) => event.sequence)).toEqual([1]);
    const resumed = storage.listEventsAfter({ sinceSequence: first[0]?.sequence ?? 0, limit: 10 });
    expect(resumed.map((event) => event.sequence)).toEqual([2]);
    // A cursor ahead of the log is queried, not clamped: the caller decides it must re-snapshot.
    expect(storage.listEventsAfter({ sinceSequence: 99, limit: 10 })).toEqual([]);
  });

  test('filters by project without letting a filtered reader stall', () => {
    db.query(`INSERT INTO projects
      (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
      VALUES ('p2','Other','/other','/other/.git','refs/heads/main','sha1',1)`).run();
    db.query(`INSERT INTO project_trusts
      (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
      VALUES ('trust2','p2','/other','/other/.git','sha1',1,'user','ACTIVE',1)`).run();
    createTask('one');
    createTask('two', 'p2');
    createTask('three');
    const events = storage.listEventsAfter({ sinceSequence: 0, limit: 10, projectId: 'p1' });
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 5, 6]);
    expect(events.every((event) => event.projectId === 'p1')).toBe(true);
  });

  test('bounds the read window and rejects invalid cursors or limits', () => {
    createTask('one');
    expect(storage.listEventsAfter({ sinceSequence: 0, limit: 1 })).toHaveLength(1);
    expect(() => storage.listEventsAfter({ sinceSequence: -1, limit: 10 })).toThrow(StorageError);
    expect(() => storage.listEventsAfter({ sinceSequence: 0, limit: 0 })).toThrow(StorageError);
    expect(() => storage.listEventsAfter({ sinceSequence: 0, limit: 501 })).toThrow(StorageError);
  });
});

describe('transaction and idempotency primitives', () => {
  test('creates a draft task, intent, first revision, and event atomically', () => {
    const input = {
      projectId: 'p1', commandId: 'command-create', payloadHash: 'hash-create',
      intentId: 'intent-create', taskId: 'task-create', revisionId: 'revision-create',
      intentEventId: 'intent-event-create', taskEventId: 'task-event-create',
      specification: 'Preserve the exact user request',
      constraints: [{ id: 'constraint-1', text: 'Do not change main' }],
      kind: 'DEVELOPMENT' as const, actor: 'local-user', createdAt: 10,
    };
    const created = storage.createTask(input);
    expect(created).toMatchObject({
      id: 'task-create', displayNumber: 1, state: 'DRAFT', version: 0,
      currentRevision: { id: 'revision-create', number: 1, specification: input.specification },
    });
    expect(storage.createTask({
      ...input,
      intentId: 'unused-intent', taskId: 'unused-task', revisionId: 'unused-revision',
      intentEventId: 'unused-intent-event', taskEventId: 'unused-task-event',
    })).toEqual(created);
    expect(storage.listTasks('p1')).toEqual([created]);
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM intents').get()?.count).toBe(1);
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM domain_events').get()?.count).toBe(2);
  });

  test('submits a draft task with CAS and idempotent event recording', () => {
    storage.createTask({
      projectId: 'p1', commandId: 'create-submit', payloadHash: 'create-hash',
      intentId: 'submit-intent', taskId: 'submit-task', revisionId: 'submit-revision',
      intentEventId: 'submit-intent-event', taskEventId: 'submit-task-event',
      specification: 'Submit this task', constraints: [], kind: 'DEVELOPMENT',
      actor: 'local-user', createdAt: 10,
    });
    const input = {
      projectId: 'p1', taskId: 'submit-task', expectedVersion: 0,
      commandId: 'submit-command', payloadHash: 'submit-hash', eventId: 'submit-event',
      actor: 'local-user', submittedAt: 11,
    };
    expect(storage.submitTask(input)).toEqual({ taskId: 'submit-task', state: 'READY', version: 1 });
    expect(storage.submitTask({ ...input, eventId: 'unused-event' }))
      .toEqual({ taskId: 'submit-task', state: 'READY', version: 1 });
    expect(storage.listTasks('p1')[0]).toMatchObject({ id: 'submit-task', state: 'READY', version: 1 });
    expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM domain_events').get()?.count).toBe(3);
    expect(() => storage.submitTask({
      ...input,
      commandId: 'stale-submit',
      payloadHash: 'stale-hash',
      eventId: 'stale-event',
    })).toThrow('version did not match');
    expect(() => storage.submitTask({
      ...input,
      expectedVersion: 1,
      commandId: 'repeat-submit',
      payloadHash: 'repeat-hash',
      eventId: 'repeat-event',
    })).toThrow('cannot be submitted from READY');
  });

  test('allocates display numbers per project', () => {
    const create = (suffix: string) => storage.createTask({
      projectId: 'p1', commandId: `command-${suffix}`, payloadHash: `hash-${suffix}`,
      intentId: `intent-${suffix}`, taskId: `task-${suffix}`, revisionId: `revision-${suffix}`,
      intentEventId: `intent-event-${suffix}`, taskEventId: `task-event-${suffix}`,
      specification: `Task ${suffix}`, constraints: [],
      kind: 'DEVELOPMENT', actor: 'local-user', createdAt: 10,
    });
    expect(create('one').displayNumber).toBe(1);
    expect(create('two').displayNumber).toBe(2);
  });

  test('refuses task access for a missing or inactive trust', () => {
    expect(() => storage.listTasks('missing')).toThrow('Trusted project was not found');
    db.query("UPDATE project_trusts SET status='INVALIDATED',invalidated_at=2 WHERE id='trust1'").run();
    expect(() => storage.listTasks('p1')).toThrow('Trusted project was not found');
  });

  test('uses version CAS for aggregate updates', () => {
    seedTask();
    expect(storage.updateTaskPriority({ taskId: 't1', expectedVersion: 0, priority: 9, updatedAt: 3 })).toBe(1);
    expect(() => storage.updateTaskPriority({ taskId: 't1', expectedVersion: 0, priority: 8, updatedAt: 4 }))
      .toThrow(StorageError);
  });

  test('returns the recorded result without applying a duplicate command', () => {
    let applications = 0;
    const command = () => storage.executeCommand({
      projectId: 'p1', commandId: 'c1', payloadHash: 'hash-a', createdAt: 3,
      apply: () => ({ value: ++applications }),
    });
    expect(command()).toEqual({ value: 1 });
    expect(command()).toEqual({ value: 1 });
    expect(applications).toBe(1);
  });

  test('rejects command ID reuse with a different payload', () => {
    storage.executeCommand({
      projectId: 'p1', commandId: 'c1', payloadHash: 'hash-a', createdAt: 3,
      apply: () => ({ ok: true }),
    });
    expect(() => storage.executeCommand({
      projectId: 'p1', commandId: 'c1', payloadHash: 'hash-b', createdAt: 4,
      apply: () => ({ ok: false }),
    })).toThrow('different payload');
  });

  test('rolls back events and receipts when command application fails', () => {
    expect(() => storage.executeCommand({
      projectId: 'p1', commandId: 'c1', payloadHash: 'hash-a', createdAt: 3,
      apply: (transaction) => {
        transaction.query(`INSERT INTO domain_events
          (event_id,project_id,event_type,schema_version,aggregate_type,aggregate_id,
           aggregate_version,correlation_id,occurred_at,payload_json)
          VALUES ('evt1','p1','TaskCreated',1,'Task','t1',0,'corr',3,'{}')`).run();
        throw new Error('fail after event');
      },
    })).toThrow('fail after event');
    expect(db.query('SELECT event_id FROM domain_events').get()).toBeNull();
    expect(db.query('SELECT command_id FROM command_receipts').get()).toBeNull();
  });
});

describe('Agent configuration scopes and Execution provenance', () => {
  function seedReadyWorkspace(): void {
    db.query(`INSERT INTO workspaces
      (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
      VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1',?1,'READY',3)`).run(oid);
  }

  test('upgrades a version 7 database with the Agent configuration table and column', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-v7-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      const legacy = new Database(filename, { create: true, strict: true });
      legacy.exec('PRAGMA foreign_keys=ON;');
      legacy.exec(phase1Migration);
      legacy.exec(agentStartMigration);
      legacy.exec(agentObservationMigration);
      legacy.exec(agentAnswerMigration);
      legacy.exec(agentDisconnectMigration);
      legacy.exec(taskVerificationMigration);
      legacy.exec(workspaceRetryMigration);
      legacy.exec('PRAGMA user_version=7');
      legacy.close();

      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
        .toBe(phase1SchemaVersion);
      expect(upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_configurations'",
      ).get()?.name).toBe('agent_configurations');
      expect(upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('executions')",
      ).all().map((row) => row.name)).toContain('agent_config_json');
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('keeps global and project overrides independent and merges partial updates', () => {
    expect(storage.getAgentConfiguration('GLOBAL', null, 'pi')).toBeNull();
    expect(storage.setAgentConfiguration({
      id: 'cfg-global', scope: 'GLOBAL', projectId: null, adapterId: 'pi',
      provider: 'deepseek', updatedAt: 5, updatedBy: 'local-user',
    })).toMatchObject({ scope: 'GLOBAL', projectId: null, provider: 'deepseek',
      model: null, thinkingLevel: null, updatedBy: 'local-user' });
    expect(storage.setAgentConfiguration({
      id: 'cfg-project', scope: 'PROJECT', projectId: 'p1', adapterId: 'pi',
      model: 'deepseek-flash', thinkingLevel: 'high', updatedAt: 6, updatedBy: 'local-user',
    })).toMatchObject({ scope: 'PROJECT', projectId: 'p1', provider: null,
      model: 'deepseek-flash', thinkingLevel: 'high' });
    // A partial update leaves the fields it does not name alone...
    expect(storage.setAgentConfiguration({
      id: 'cfg-project-2', scope: 'PROJECT', projectId: 'p1', adapterId: 'pi',
      provider: 'deepseek', updatedAt: 7, updatedBy: 'local-user',
    })).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash', thinkingLevel: 'high' });
    // ...and never touches the other scope.
    expect(storage.getAgentConfiguration('GLOBAL', null, 'pi'))
      .toMatchObject({ provider: 'deepseek', model: null });
  });

  test('clearing every field removes the override instead of shadowing lower scopes', () => {
    storage.setAgentConfiguration({ id: 'g', scope: 'GLOBAL', projectId: null, adapterId: 'pi',
      model: 'global-model', updatedAt: 1, updatedBy: 'local-user' });
    storage.setAgentConfiguration({ id: 'p', scope: 'PROJECT', projectId: 'p1', adapterId: 'pi',
      model: 'project-model', updatedAt: 2, updatedBy: 'local-user' });
    expect(storage.setAgentConfiguration({ id: 'p2', scope: 'PROJECT', projectId: 'p1', adapterId: 'pi',
      model: null, updatedAt: 3, updatedBy: 'local-user' })).toBeNull();
    expect(storage.getAgentConfiguration('PROJECT', 'p1', 'pi')).toBeNull();
    expect(storage.getAgentConfiguration('GLOBAL', null, 'pi')).not.toBeNull();
    expect(storage.clearAgentConfiguration({ scope: 'GLOBAL', projectId: null, adapterId: 'pi' }))
      .toBe(true);
    expect(storage.clearAgentConfiguration({ scope: 'GLOBAL', projectId: null, adapterId: 'pi' }))
      .toBe(false);
  });

  test('rejects scope mismatches, unknown projects, and invalid thinking levels', () => {
    expect(() => storage.setAgentConfiguration({ id: 'a', scope: 'PROJECT', projectId: null,
      adapterId: 'pi', updatedAt: 1, updatedBy: 'local-user' })).toThrow('requires a project');
    expect(() => storage.setAgentConfiguration({ id: 'b', scope: 'GLOBAL', projectId: 'p1',
      adapterId: 'pi', updatedAt: 1, updatedBy: 'local-user' })).toThrow('cannot name a project');
    expect(() => storage.setAgentConfiguration({ id: 'c', scope: 'PROJECT', projectId: 'missing',
      adapterId: 'pi', updatedAt: 1, updatedBy: 'local-user' }))
      .toThrow('Trusted project was not found');
    expect(() => storage.setAgentConfiguration({ id: 'd', scope: 'GLOBAL', projectId: null,
      adapterId: 'pi', thinkingLevel: 'extreme', updatedAt: 1, updatedBy: 'local-user' }))
      .toThrow('Invalid Agent configuration');
  });

  test('records the effective configuration on the Execution that used it', () => {
    seedTask();
    seedReadyWorkspace();
    expect(storage.reserveExecution({
      projectId: 'p1', taskId: 't1', expectedTaskVersion: 0, workspaceId: 'w1',
      executionId: 'e1', commandId: 'cmd1', payloadHash: 'hash', reservationEventId: 'evt1',
      taskEventId: 'evt2', adapterId: 'pi', adapterVersion: '0.84.4',
      agentConfig: { provider: 'deepseek', model: 'deepseek-flash', thinkingLevel: 'high' },
      actor: 'runtime-scheduler', createdAt: 4,
    }).executionId).toBe('e1');
    expect(storage.listTaskExecutions('p1', 't1')[0]?.agentConfig).toEqual({
      provider: 'deepseek', model: 'deepseek-flash', thinkingLevel: 'high',
    });
  });

  test('records no configuration when none was resolved', () => {
    seedTask();
    seedReadyWorkspace();
    storage.reserveExecution({
      projectId: 'p1', taskId: 't1', expectedTaskVersion: 0, workspaceId: 'w1',
      executionId: 'e1', commandId: 'cmd1', payloadHash: 'hash', reservationEventId: 'evt1',
      taskEventId: 'evt2', adapterId: 'pi', adapterVersion: '0.84.4',
      actor: 'runtime-scheduler', createdAt: 4,
    });
    expect(storage.listTaskExecutions('p1', 't1')[0]?.agentConfig).toBeNull();
    expect(db.query<{ agent_config_json: string | null }, []>(
      "SELECT agent_config_json FROM executions WHERE id='e1'",
    ).get()?.agent_config_json).toBeNull();
  });
});

describe('Task pause, cancel, and archive', () => {
  function seedReadyWorkspace(): void {
    db.query(`INSERT INTO workspaces
      (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
      VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1',?1,'READY',3)`).run(oid);
  }

  function reserveRunningExecution(executionId = 'e1'): void {
    storage.reserveExecution({
      projectId: 'p1', taskId: 't1', expectedTaskVersion: 0, workspaceId: 'w1',
      executionId, commandId: `cmd-${executionId}`, payloadHash: `hash-${executionId}`,
      reservationEventId: `evt-${executionId}`, taskEventId: `evt-task-${executionId}`,
      adapterId: 'pi', adapterVersion: '0.84.4', actor: 'runtime-scheduler', createdAt: 4,
    });
  }

  test('upgrades a version 8 database, preserving executions and admitting USER_PAUSE', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-v8-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      const legacy = new Database(filename, { create: true, strict: true });
      legacy.exec('PRAGMA foreign_keys=ON;');
      legacy.exec(phase1Migration);
      legacy.exec(agentStartMigration);
      legacy.exec(agentObservationMigration);
      legacy.exec(agentAnswerMigration);
      legacy.exec(agentDisconnectMigration);
      legacy.exec(taskVerificationMigration);
      legacy.exec(workspaceRetryMigration);
      legacy.exec(agentConfigurationMigration);
      legacy.exec('PRAGMA user_version=8');
      legacy.query(`INSERT INTO projects
        (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
        VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','sha1',1)`).run();
      legacy.query(`INSERT INTO project_trusts
        (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
        VALUES ('trust1','p1','/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run();
      legacy.transaction(() => {
        legacy.query(`INSERT INTO tasks
          (id,project_id,display_number,kind,current_revision_id,state,created_at,updated_at)
          VALUES ('t1','p1',1,'DEVELOPMENT','r1','RUNNING',2,2)`).run();
        legacy.query(`INSERT INTO task_revisions
          (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
          VALUES ('r1','t1',1,NULL,'Do work','[]','user','initial',2)`).run();
      })();
      legacy.query(`INSERT INTO workspaces
        (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
        VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1',?1,'IN_USE',3)`).run(oid);
      legacy.query(`INSERT INTO executions
        (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,
         adapter_id,adapter_version,state,resource_held,base_commit,started_at)
        VALUES ('e1','t1',1,'r1','r1','w1','pi','0.84.4','RUNNING',1,?1,4)`).run(oid);
      legacy.query(`INSERT INTO agent_sessions
        (id,execution_id,provider_session_id,session_storage_ref,state,capabilities_json,version)
        VALUES ('s1','e1','prov-1','/sessions/prov-1.jsonl','ACTIVE','{}',0)`).run();
      legacy.close();

      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
        .toBe(phase1SchemaVersion);
      expect(upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('tasks')",
      ).all().map((row) => row.name)).toContain('archived_at');
      expect(upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('executions')",
      ).all().map((row) => row.name)).toContain('resume_from_execution_id');
      const preserved = upgraded.sqlite.query<{
        state: string; resource_held: number; base_commit: string; resume_from_execution_id: string | null;
      }, []>("SELECT state,resource_held,base_commit,resume_from_execution_id FROM executions WHERE id='e1'")
        .get();
      expect(preserved).toEqual({ state: 'RUNNING', resource_held: 1, base_commit: oid,
        resume_from_execution_id: null });
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
      // A Session that referenced the rebuilt Execution still resolves to it.
      expect(upgraded.sqlite.query<{ session_ref: string | null; execution_ref: string | null }, []>(`
        SELECT session.session_storage_ref AS session_ref, execution.id AS execution_ref
        FROM agent_sessions session JOIN executions execution ON execution.id=session.execution_id
        WHERE session.id='s1'
      `).get()).toEqual({ session_ref: '/sessions/prov-1.jsonl', execution_ref: 'e1' });
      // The rebuilt CHECK admits the new stop reason but still refuses unknown values.
      upgraded.sqlite.query("UPDATE executions SET stop_reason='USER_PAUSE' WHERE id='e1'").run();
      expect(() => upgraded.sqlite.query("UPDATE executions SET stop_reason='NOPE' WHERE id='e1'").run())
        .toThrow();
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('archives without destroying rows and hides the Task from the default list', () => {
    seedTask();
    const archived = storage.archiveTask({
      projectId: 'p1', taskId: 't1', expectedVersion: 0, commandId: 'c1', payloadHash: 'h1',
      eventId: 'e1', actor: 'local-user', archivedAt: 10,
    });
    expect(archived).toEqual({ taskId: 't1', state: 'READY', version: 1, archived: true });
    expect(storage.listTasks('p1')).toHaveLength(0);
    expect(storage.listTasks('p1', { includeArchived: true })).toHaveLength(1);
    expect(storage.getTask('p1', 't1')?.archivedAt).toBe(10);
    // Replaying the same command returns the recorded result without a second version bump.
    expect(storage.archiveTask({
      projectId: 'p1', taskId: 't1', expectedVersion: 0, commandId: 'c1', payloadHash: 'h1',
      eventId: 'e1', actor: 'local-user', archivedAt: 11,
    }).version).toBe(1);
    // The Task, its revision, and its events are all still present.
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM task_revisions WHERE task_id='t1'",
    ).get()?.count).toBe(1);
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type='TaskArchived'",
    ).get()?.count).toBe(1);

    const unarchived = storage.unarchiveTask({
      projectId: 'p1', taskId: 't1', expectedVersion: 1, commandId: 'c2', payloadHash: 'h2',
      eventId: 'e2', actor: 'local-user', unarchivedAt: 12,
    });
    expect(unarchived).toEqual({ taskId: 't1', state: 'READY', version: 2, archived: false });
    expect(storage.listTasks('p1')).toHaveLength(1);
    expect(storage.getTask('p1', 't1')?.archivedAt).toBeNull();
  });

  test('refuses to archive a Task that still holds an Execution', () => {
    seedTask();
    seedReadyWorkspace();
    reserveRunningExecution();
    expect(() => storage.archiveTask({
      projectId: 'p1', taskId: 't1', expectedVersion: 1, commandId: 'c1', payloadHash: 'h1',
      eventId: 'e1', actor: 'local-user', archivedAt: 10,
    })).toThrow(StorageError);
    expect(storage.getTask('p1', 't1')?.state).toBe('RUNNING');
  });

  test('cancels a READY Task without an Execution and keeps it terminal', () => {
    seedTask();
    const cancelled = storage.requestTaskStop({
      projectId: 'p1', taskId: 't1', expectedVersion: 0, kind: 'CANCEL', commandId: 'c1',
      payloadHash: 'h1', taskEventId: 'evt1', executionEventId: 'evt2', actor: 'local-user',
      requestedAt: 10,
    });
    expect(cancelled).toMatchObject({ state: 'CANCELLED', terminal: true, executionId: null });
    expect(storage.getTask('p1', 't1')?.state).toBe('CANCELLED');
    // CANCELLED does not reopen: submitting again is refused.
    expect(() => storage.submitTask({
      projectId: 'p1', taskId: 't1', expectedVersion: cancelled.version, commandId: 'c2',
      payloadHash: 'h2', eventId: 'evt3', actor: 'local-user', submittedAt: 11,
    })).toThrow(StorageError);
  });

  test('cancels a running Task only after quiescence is confirmed', () => {
    seedTask();
    seedReadyWorkspace();
    reserveRunningExecution();
    const requested = storage.requestTaskStop({
      projectId: 'p1', taskId: 't1', expectedVersion: 1, kind: 'CANCEL', commandId: 'c1',
      payloadHash: 'h1', taskEventId: 'evt1', executionEventId: 'evt2', actor: 'local-user',
      requestedAt: 10,
    });
    expect(requested).toMatchObject({ state: 'CANCELLING', terminal: false, executionId: 'e1' });
    expect(db.query<{ state: string; stop_reason: string; resource_held: number }, []>(
      "SELECT state,stop_reason,resource_held FROM executions WHERE id='e1'",
    ).get()).toEqual({ state: 'STOPPING', stop_reason: 'USER_CANCEL', resource_held: 1 });

    const confirmed = storage.confirmTaskStopped({
      projectId: 'p1', taskId: 't1', kind: 'CANCEL', executionId: 'e1', sessionId: null,
      evidenceRef: 'pid 42 exited', taskEventId: 'evt3', executionEventId: 'evt4',
      sessionEventId: 'evt5', stoppedAt: 11,
    });
    expect(confirmed.state).toBe('CANCELLED');
    expect(db.query<{ state: string; resource_held: number }, []>(
      "SELECT state,resource_held FROM executions WHERE id='e1'",
    ).get()).toEqual({ state: 'CANCELLED', resource_held: 0 });
    expect(db.query<{ state: string }, []>("SELECT state FROM workspaces WHERE id='w1'").get()?.state)
      .toBe('RETAINED');
  });

  test('pauses a running Task and resumes it in a new Execution over the same workspace', () => {
    seedTask();
    seedReadyWorkspace();
    reserveRunningExecution();
    storage.sqlite.query(`INSERT INTO agent_sessions
      (id,execution_id,provider_session_id,session_storage_ref,state,capabilities_json,version)
      VALUES ('s1','e1','prov-1','/sessions/prov-1.jsonl','ACTIVE','{}',0)`).run();

    const requested = storage.requestTaskStop({
      projectId: 'p1', taskId: 't1', expectedVersion: 1, kind: 'PAUSE', commandId: 'c1',
      payloadHash: 'h1', taskEventId: 'evt1', executionEventId: 'evt2', actor: 'local-user',
      requestedAt: 10,
    });
    expect(requested).toMatchObject({ state: 'PAUSING', executionId: 'e1', sessionId: 's1' });
    const confirmed = storage.confirmTaskStopped({
      projectId: 'p1', taskId: 't1', kind: 'PAUSE', executionId: 'e1', sessionId: 's1',
      evidenceRef: 'pid 42 exited', taskEventId: 'evt3', executionEventId: 'evt4',
      sessionEventId: 'evt5', stoppedAt: 11,
    });
    expect(confirmed.state).toBe('PAUSED');
    expect(db.query<{ state: string; stop_reason: string; resource_held: number }, []>(
      "SELECT state,stop_reason,resource_held FROM executions WHERE id='e1'",
    ).get()).toEqual({ state: 'SUPERSEDED', stop_reason: 'USER_PAUSE', resource_held: 0 });
    expect(db.query<{ state: string }, []>("SELECT state FROM agent_sessions WHERE id='s1'").get()?.state)
      .toBe('EXITED');

    const resumed = storage.resumeTask({
      projectId: 'p1', taskId: 't1', expectedVersion: confirmed.version, commandId: 'c2',
      payloadHash: 'h2', taskEventId: 'evt6', resumedAt: 12,
    });
    expect(resumed).toMatchObject({
      state: 'READY', resumeFromExecutionId: 'e1', predecessorSessionId: 's1',
      predecessorSessionStorageRef: '/sessions/prov-1.jsonl', workspaceId: 'w1',
    });
    expect(storage.findReusableWorkspace('t1')?.workspaceId).toBe('w1');
    storage.reserveExecution({
      projectId: 'p1', taskId: 't1', expectedTaskVersion: resumed.version, workspaceId: 'w1',
      executionId: 'e2', commandId: 'c3', payloadHash: 'h3', reservationEventId: 'evt7',
      taskEventId: 'evt8', adapterId: 'pi', adapterVersion: '0.84.4',
      resumeFromExecutionId: 'e1', actor: 'runtime-scheduler', createdAt: 13,
    });
    expect(storage.listTaskExecutions('p1', 't1').find((row) => row.executionId === 'e2'))
      .toMatchObject({ state: 'CREATED', resumeFromExecutionId: 'e1' });
  });

  test('keeps every resource when a stop cannot be confirmed', () => {
    seedTask();
    seedReadyWorkspace();
    reserveRunningExecution();
    storage.sqlite.query(`INSERT INTO agent_sessions
      (id,execution_id,provider_session_id,session_storage_ref,state,capabilities_json,version)
      VALUES ('s1','e1','prov-1','/sessions/prov-1.jsonl','ACTIVE','{}',0)`).run();
    storage.requestTaskStop({
      projectId: 'p1', taskId: 't1', expectedVersion: 1, kind: 'CANCEL', commandId: 'c1',
      payloadHash: 'h1', taskEventId: 'evt1', executionEventId: 'evt2', actor: 'local-user',
      requestedAt: 10,
    });
    storage.markTaskStopUncertain({
      projectId: 'p1', taskId: 't1', executionId: 'e1', sessionId: 's1',
      evidenceRef: 'pid 42 did not confirm exit', taskEventId: 'evt3', executionEventId: 'evt4',
      sessionEventId: 'evt5', recoveredAt: 11,
    });
    expect(storage.getTask('p1', 't1')?.state).toBe('RECOVERY_REQUIRED');
    expect(db.query<{ state: string; resource_held: number }, []>(
      "SELECT state,resource_held FROM executions WHERE id='e1'",
    ).get()).toEqual({ state: 'RECOVERY_REQUIRED', resource_held: 1 });
    expect(db.query<{ state: string }, []>("SELECT state FROM agent_sessions WHERE id='s1'").get()?.state)
      .toBe('RECOVERY_REQUIRED');
  });
});
