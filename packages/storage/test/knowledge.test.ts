import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Phase1Database,
  StorageError,
  agentAnswerMigration,
  agentConfigurationMigration,
  agentDisconnectMigration,
  agentObservationMigration,
  agentStartMigration,
  capacitySlotReservationMigration,
  impactAnalysisMigration,
  integrationPipelineMigration,
  knowledgeLayerMigration,
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
  taskRetryMigration,
  taskVerificationMigration,
  unregisteredReclamationMigration,
  verificationProgressMigration,
  workspaceRetryMigration,
  type ExecutionKnowledgeSnapshotInput,
  type KnowledgeSnapshotInput,
} from '../src/index.js';

/**
 * Real SQLite evidence for the Project Knowledge ledger (FOUNDATION-067 / ADR-0041, schema v26).
 *
 * The claims under test are the ones that would be expensive to get wrong silently: a released
 * database upgrades additively, a recorded snapshot and a recorded binding can never be rewritten,
 * a binding is written in the same transaction as its Execution (so "the Execution exists" and "it
 * is bound to its knowledge" cannot be observed apart), and an Execution's binding is never
 * replaced by a second, different one.
 */

const oid = 'a'.repeat(40);
const digest = 'f'.repeat(64);
const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-knowledge-'));
  created.push(directory);
  return join(directory, 'runtime.sqlite');
}

function createRawDatabase(filename: string): Database {
  const database = new Database(filename, { create: true, strict: true });
  database.exec('PRAGMA foreign_keys=ON;');
  return database;
}

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
  database.query(`INSERT INTO workspaces
    (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
    VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1',?1,'READY',3)`).run(oid);
}

function openDatabase(): Phase1Database {
  const database = new Phase1Database(temporaryDatabase());
  seedProject(database.sqlite);
  return database;
}

const migrationsBeforeV26 = [
  phase1Migration, agentStartMigration, agentObservationMigration, agentAnswerMigration,
  agentDisconnectMigration, taskVerificationMigration, workspaceRetryMigration,
  agentConfigurationMigration, taskControlMigration, integrationPipelineMigration,
  operationProgressMigration, reclamationMigration, stablePromotionMigration,
  sessionHandoffMigration, taskDependenciesMigration, verificationProgressMigration,
  sessionTerminalMigration, revisionDeliveryMigration, impactAnalysisMigration,
  capacitySlotReservationMigration, taskRetryMigration, unregisteredReclamationMigration,
];

function knowledgeSnapshotInput(overrides: Partial<KnowledgeSnapshotInput> = {}): KnowledgeSnapshotInput {
  return {
    id: 'ks-1',
    projectId: 'p1',
    mainRef: 'refs/heads/main',
    mainCommit: oid,
    policyVersion: 'knowledge-layers-v1',
    snapshotDigest: digest,
    humanDigest: 'b'.repeat(64),
    generatedDigest: 'c'.repeat(64),
    entryCount: 1,
    humanEntryCount: 1,
    generatedEntryCount: 0,
    totalBytes: 12,
    entries: [{
      layer: 'instructions',
      path: '.codeestra/instructions/a.md',
      id: 'a',
      scope: 'ALL',
      digest: 'd'.repeat(64),
      bytes: 12,
      origin: {},
    }],
    createdBy: 'runtime',
    createdAt: 10,
    ...overrides,
  };
}

function bindingInput(overrides: Partial<ExecutionKnowledgeSnapshotInput> = {}):
ExecutionKnowledgeSnapshotInput {
  return {
    executionId: 'e1',
    projectId: 'p1',
    taskId: 't1',
    snapshotId: 'ks-1',
    snapshotDigest: digest,
    contextPath: '.codeestra/generated/knowledge-context.md',
    contextDigest: 'e'.repeat(64),
    contextBytes: 200,
    entryCount: 1,
    refs: [`knowledge-snapshot:${digest}`, 'knowledge-entry:instructions:.codeestra/instructions/a.md#d'],
    commandId: 'cmd-1',
    createdAt: 11,
    ...overrides,
  };
}

function insertExecution(database: Phase1Database, id: string): void {
  database.sqlite.query(`INSERT INTO executions
    (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,
     adapter_id,adapter_version,state,resource_held,base_commit,started_at)
    VALUES (?1,'t1',1,'r1','r1','w1','fake','1','RUNNING',1,?2,4)`).run(id, oid);
}

function reserveExecutionInput(overrides: {
  readonly knowledgeBinding?: Parameters<Phase1Database['reserveExecution']>[0]['knowledgeBinding'];
} = {}) {
  return {
    projectId: 'p1',
    taskId: 't1',
    expectedTaskVersion: 0,
    workspaceId: 'w1',
    executionId: 'e-reserved',
    commandId: crypto.randomUUID(),
    payloadHash: 'payload-1',
    reservationEventId: crypto.randomUUID(),
    taskEventId: crypto.randomUUID(),
    adapterId: 'fake',
    adapterVersion: '1',
    actor: 'runtime-scheduler',
    createdAt: 5,
    ...(overrides.knowledgeBinding === undefined
      ? {} : { knowledgeBinding: overrides.knowledgeBinding }),
  } satisfies Parameters<Phase1Database['reserveExecution']>[0];
}

describe('schema v26 knowledge migration', () => {
  test('appends additively to a v24 database and keeps every existing row', () => {
    const filename = temporaryDatabase();
    const legacy = createRawDatabase(filename);
    for (const migration of migrationsBeforeV26) legacy.exec(migration);
    legacy.exec('PRAGMA user_version=24');
    seedProject(legacy);
    legacy.query(`INSERT INTO workspaces
      (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
      VALUES ('w2','t1','refs/heads/task/t1','/work/t1b','owner-2',?1,'RELEASED',4)`).run(oid);
    legacy.close();

    const upgraded = new Phase1Database(filename);
    expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
      .get()?.user_version).toBe(phase1SchemaVersion);
    // The claim under test is that the upgrade reaches the *current* version and lands this lane's
    // tables, not that this lane is last: 25 belongs to a parallel lane and may merge after this.
    expect(phase1SchemaVersion).toBeGreaterThanOrEqual(26);
    expect(upgraded.listTrustedProjects()).toHaveLength(1);
    expect(upgraded.sqlite.query<{ id: string }, []>(
      "SELECT id FROM workspaces WHERE id='w2'").get()?.id).toBe('w2');
    const tables = upgraded.sqlite.query<{ name: string }, []>(`
      SELECT name FROM sqlite_master WHERE type='table' AND name IN
        ('knowledge_snapshots','execution_knowledge_snapshots') ORDER BY name
    `).all().map((row) => row.name);
    expect(tables).toEqual(['execution_knowledge_snapshots', 'knowledge_snapshots']);
    upgraded.close();
  });

  test('the migration text is the one the runner uses and creates only those two tables', () => {
    expect(knowledgeLayerMigration).toContain('CREATE TABLE knowledge_snapshots');
    expect(knowledgeLayerMigration).toContain('CREATE TABLE execution_knowledge_snapshots');
    expect(knowledgeLayerMigration).not.toContain('ALTER TABLE executions');
  });
});

describe('knowledge snapshots', () => {
  test('recording the same declared knowledge twice reuses one row', () => {
    const database = openDatabase();
    const first = database.recordKnowledgeSnapshot(knowledgeSnapshotInput());
    const second = database.recordKnowledgeSnapshot(knowledgeSnapshotInput({ id: 'ks-other' }));
    expect(second.id).toBe(first.id);
    expect(database.listKnowledgeSnapshots({ projectId: 'p1' })).toHaveLength(1);
    expect(first.entries[0]?.path).toBe('.codeestra/instructions/a.md');
    database.close();
  });

  test('a changed digest is a different snapshot, and history is newest first', () => {
    const database = openDatabase();
    database.recordKnowledgeSnapshot(knowledgeSnapshotInput());
    database.recordKnowledgeSnapshot(knowledgeSnapshotInput({
      id: 'ks-2', snapshotDigest: '1'.repeat(64), createdAt: 20,
    }));
    const listed = database.listKnowledgeSnapshots({ projectId: 'p1' });
    expect(listed.map((snapshot) => snapshot.snapshotDigest)).toEqual(['1'.repeat(64), digest]);
    expect(database.findKnowledgeSnapshot({
      projectId: 'p1', mainCommit: oid, snapshotDigest: '1'.repeat(64),
    })?.id).toBe('ks-2');
    database.close();
  });

  test('snapshots are append-only: neither update nor delete is possible', () => {
    const database = openDatabase();
    database.recordKnowledgeSnapshot(knowledgeSnapshotInput());
    expect(() => database.sqlite.query(
      "UPDATE knowledge_snapshots SET created_by='someone' WHERE id='ks-1'").run())
      .toThrow();
    expect(() => database.sqlite.query("DELETE FROM knowledge_snapshots WHERE id='ks-1'").run())
      .toThrow();
    expect(database.getKnowledgeSnapshot('ks-1')?.createdBy).toBe('runtime');
    database.close();
  });

  test('the schema refuses an entry count that does not add up and a bad digest', () => {
    const database = openDatabase();
    expect(() => database.recordKnowledgeSnapshot(knowledgeSnapshotInput({ entryCount: 5 })))
      .toThrow();
    expect(() => database.recordKnowledgeSnapshot(knowledgeSnapshotInput({
      snapshotDigest: 'short',
    }))).toThrow();
    database.close();
  });
});

describe('execution knowledge bindings', () => {
  test('an Execution keeps one immutable binding, and an exact replay is a reuse', () => {
    const database = openDatabase();
    database.recordKnowledgeSnapshot(knowledgeSnapshotInput());
    insertExecution(database, 'e1');
    const first = database.recordExecutionKnowledgeSnapshot(bindingInput());
    const replay = database.recordExecutionKnowledgeSnapshot(bindingInput());
    expect(replay).toEqual(first);
    expect(database.listExecutionKnowledgeSnapshots({ projectId: 'p1', taskId: 't1' }))
      .toHaveLength(1);
    database.close();
  });

  test('a second, different snapshot for the same Execution is refused, not applied', () => {
    const database = openDatabase();
    database.recordKnowledgeSnapshot(knowledgeSnapshotInput());
    database.recordKnowledgeSnapshot(knowledgeSnapshotInput({
      id: 'ks-2', snapshotDigest: '1'.repeat(64),
    }));
    insertExecution(database, 'e1');
    database.recordExecutionKnowledgeSnapshot(bindingInput());
    expect(() => database.recordExecutionKnowledgeSnapshot(bindingInput({
      snapshotId: 'ks-2', snapshotDigest: '1'.repeat(64),
    }))).toThrow(StorageError);
    const stored = database.getExecutionKnowledgeSnapshot('e1');
    expect(stored?.snapshotId).toBe('ks-1');
    expect(stored?.contextDigest).toBe('e'.repeat(64));
    database.close();
  });

  test('bindings are append-only', () => {
    const database = openDatabase();
    database.recordKnowledgeSnapshot(knowledgeSnapshotInput());
    insertExecution(database, 'e1');
    database.recordExecutionKnowledgeSnapshot(bindingInput());
    expect(() => database.sqlite.query(
      "UPDATE execution_knowledge_snapshots SET entry_count=9 WHERE execution_id='e1'").run())
      .toThrow();
    expect(() => database.sqlite.query(
      "DELETE FROM execution_knowledge_snapshots WHERE execution_id='e1'").run()).toThrow();
    expect(database.getExecutionKnowledgeSnapshot('e1')?.entryCount).toBe(1);
    database.close();
  });

  test('a binding with no snapshot row cannot exist (referential integrity)', () => {
    const database = openDatabase();
    insertExecution(database, 'e1');
    // The foreign key is the guard; the driver's own error is what surfaces, which is why the
    // reservation path rolls back rather than half-writing a binding.
    expect(() => database.recordExecutionKnowledgeSnapshot(bindingInput())).toThrow();
    expect(database.getExecutionKnowledgeSnapshot('e1')).toBeNull();
    database.close();
  });
});

describe('reservation writes the binding in the same transaction', () => {
  test('a valid binding lands with the Execution row', () => {
    const database = openDatabase();
    database.recordKnowledgeSnapshot(knowledgeSnapshotInput());
    const reserved = database.reserveExecution(reserveExecutionInput({
      knowledgeBinding: {
        snapshotId: 'ks-1',
        snapshotDigest: digest,
        contextPath: '.codeestra/generated/knowledge-context.md',
        contextDigest: 'e'.repeat(64),
        contextBytes: 200,
        entryCount: 1,
        refs: [`knowledge-snapshot:${digest}`],
        commandId: 'knowledge-command',
      },
    }));
    const binding = database.getExecutionKnowledgeSnapshot(reserved.executionId);
    expect(binding?.snapshotId).toBe('ks-1');
    expect(binding?.taskId).toBe('t1');
    expect(binding?.refs).toEqual([`knowledge-snapshot:${digest}`]);
    database.close();
  });

  test('a binding that cannot be written rolls the whole reservation back: no Execution, zero rows', () => {
    const database = openDatabase();
    // `ks-missing` does not exist, so the binding insert violates its foreign key inside the same
    // transaction as the Execution insert. Either both rows exist or neither does — which is the
    // property that makes "an Execution always records the knowledge it used" true rather than
    // merely intended.
    expect(() => database.reserveExecution(reserveExecutionInput({
      knowledgeBinding: {
        snapshotId: 'ks-missing',
        snapshotDigest: digest,
        contextPath: '.codeestra/generated/knowledge-context.md',
        contextDigest: 'e'.repeat(64),
        contextBytes: 200,
        entryCount: 1,
        refs: [],
        commandId: 'knowledge-command',
      },
    }))).toThrow();
    expect(database.sqlite.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM executions').get()?.count).toBe(0);
    expect(database.sqlite.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM execution_knowledge_snapshots').get()?.count).toBe(0);
    expect(database.sqlite.query<{ state: string }, []>(
      "SELECT state FROM tasks WHERE id='t1'").get()?.state).toBe('READY');
    database.close();
  });

  test('a reservation without a binding leaves the columns untouched for older rows', () => {
    const database = openDatabase();
    const reserved = database.reserveExecution(reserveExecutionInput());
    expect(database.getExecutionKnowledgeSnapshot(reserved.executionId)).toBeNull();
    expect(database.listExecutionKnowledgeSnapshots({ projectId: 'p1' })).toHaveLength(0);
    database.close();
  });
});
