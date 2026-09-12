import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Phase1Database, StorageError, phase1SchemaVersion } from '../src/index.js';

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

  test('requires task verification to match one execution and revision', () => {
    seedTask();
    seedWorkspace();
    insertExecution('e1', 1);
    db.query(`INSERT INTO verification_runs
      (id,task_id,execution_id,revision_id,tested_commit,tree_fingerprint,policy_version,commands_json,state)
      VALUES ('v1','t1','e1','r1',?1,'tree','1','[]','PASSED')`).run(oid);
    expect(() => db.query(`INSERT INTO verification_runs
      (id,task_id,execution_id,revision_id,tested_commit,tree_fingerprint,policy_version,commands_json,state)
      VALUES ('v2','t1','missing','r1',?1,'tree','1','[]','PASSED')`).run(oid)).toThrow();
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
