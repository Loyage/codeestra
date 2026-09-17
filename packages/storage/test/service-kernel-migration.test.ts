import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Phase1Database,
  ServiceKernelStore,
  attentionServiceId,
  phase1SchemaVersion,
  rootServiceId,
  schedulerServiceId,
} from '../src/index.js';

const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const revisionId = '30000000-0000-4000-8000-000000000001';
const workspaceId = '40000000-0000-4000-8000-000000000001';
const executionId = '50000000-0000-4000-8000-000000000001';
const oid = 'a'.repeat(40);
const opened: Phase1Database[] = [];
afterEach(() => { for (const storage of opened.splice(0)) storage.close(); });

function seedLegacyCore(db: Database): void {
  db.query(`INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
    VALUES (?1,'Project','/repo','/repo/.git','refs/heads/main','sha1',1)`).run(projectId);
  db.query(`INSERT INTO project_trusts(id,project_id,repo_root,git_common_dir,object_format,
    policy_version,actor,status,accepted_at)
    VALUES ('trust',?1,'/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run(projectId);
  db.transaction(() => {
    db.query(`INSERT INTO tasks(id,project_id,display_number,display_title,naming_title,
      current_revision_id,state,created_at,updated_at)
      VALUES (?1,?2,1,'Work','work',?3,'RUNNING',2,2)`).run(taskId, projectId, revisionId);
    db.query(`INSERT INTO task_revisions(id,task_id,number,previous_revision_id,specification,
      actor,reason,created_at) VALUES (?1,?2,1,NULL,'Do work','user','initial',2)`)
      .run(revisionId, taskId);
  })();
  db.query(`INSERT INTO workspaces(id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
    VALUES (?1,?2,'refs/heads/task/work','/work','owner',?3,'IN_USE',3)`)
    .run(workspaceId, taskId, oid);
  db.query(`INSERT INTO executions(id,task_id,attempt_number,initial_revision_id,applied_revision_id,
    workspace_id,adapter_id,adapter_version,state,resource_held,base_commit,started_at)
    VALUES (?1,?2,1,?3,?3,?4,'pi','1','RUNNING',1,?5,4)`)
    .run(executionId, taskId, revisionId, workspaceId, oid);
}

/**
 * Turns a freshly created database back into a v36-shaped file: both the v37 Service kernel tables
 * and the v38 managed-integration tables are dropped, so the upgrade under test really has to create
 * them (ADR-0074 added the v38 half; leaving those tables behind would make the v38 step a no-op and
 * hide exactly the migration this test exists to exercise).
 */
function dropV37(db: Database): void {
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(`DROP TABLE task_integration; DROP TABLE integration_runs; DROP TABLE merge_queue_items;
    DROP TABLE project_integration;
    DROP TABLE signal_receipts; DROP TABLE signal_attempts; DROP TABLE signals;
    DROP TABLE process_execution_links; DROP TABLE processes; DROP TABLE service_metadata;
    DROP TABLE services; PRAGMA user_version=36;`);
  db.exec('PRAGMA foreign_keys=ON');
}

describe('schema v37 Service kernel', () => {
  // ADR-0074 keeps the v37 half of this file intact: a v36 file still reaches the current schema in
  // one upgrade, and the S8 tables are created by the same pass.
  test('upgrades a real v36 file additively and projects existing core identities', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-v37-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      const prepared = new Phase1Database(filename);
      seedLegacyCore(prepared.sqlite);
      dropV37(prepared.sqlite);
      prepared.close();

      const upgraded = new Phase1Database(filename);
      opened.push(upgraded);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
        .toBe(phase1SchemaVersion);
      expect(upgraded.sqlite.query<{ id: string }, []>('SELECT id FROM services ORDER BY id').all()
        .map((row) => row.id)).toEqual([
          rootServiceId, schedulerServiceId, attentionServiceId, projectId, taskId,
        ].sort());
      expect(upgraded.sqlite.query<{ process_id: string; execution_id: string }, []>(
        'SELECT process_id,execution_id FROM process_execution_links').get())
        .toEqual({ process_id: executionId, execution_id: executionId });
      expect(upgraded.sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rolls back and leaves user_version at 36 when a projection row cannot be copied', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-v37-fail-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      const prepared = new Phase1Database(filename);
      seedLegacyCore(prepared.sqlite);
      prepared.sqlite.exec('PRAGMA foreign_keys=OFF');
      prepared.sqlite.query("UPDATE executions SET applied_revision_id='missing' WHERE id=?1")
        .run(executionId);
      dropV37(prepared.sqlite);
      prepared.close();
      expect(() => new Phase1Database(filename)).toThrow(/projection mismatch/);
      const inspected = new Database(filename, { readonly: true });
      try {
        expect(inspected.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
          .toBe(36);
        expect(inspected.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM sqlite_master
          WHERE type='table' AND name='services'`).get()?.count).toBe(0);
        expect(inspected.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM executions').get()?.count)
          .toBe(1);
      } finally { inspected.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('enforces root singleton and Project/Task parent kinds in SQLite', () => {
    const storage = new Phase1Database(); opened.push(storage);
    expect(() => storage.sqlite.query(`INSERT INTO services
      (id,kind,parent_service_id,lifecycle,created_at,updated_at)
      VALUES ('other-root','ROOT',NULL,'ACTIVE',0,0)`).run()).toThrow();
    expect(() => storage.sqlite.query(`INSERT INTO services
      (id,kind,parent_service_id,lifecycle,created_at,updated_at)
      VALUES ('bad-task','TASK',?1,'ACTIVE',0,0)`).run(rootServiceId)).toThrow();
  });

  test('keeps legacy core authoritative while metadata has its own CAS version', () => {
    const storage = new Phase1Database(); opened.push(storage);
    seedLegacyCore(storage.sqlite);
    const store = new ServiceKernelStore(storage);
    store.reconcileProjections(10);
    const service = store.getService(taskId);
    expect(service.id).toBe(taskId);
    expect(service.coreState.lifecycleState).toBe('RUNNING');
    expect(service.coreVersion).toBe(0);
    expect(service.stateVersion).toBe(0);

    const signalId = '60000000-0000-4000-8000-000000000001';
    store.enqueueSignal({ id: signalId, kind: 'SIG_A', subtype: 'SERVICE_METADATA_SET',
      sourceServiceId: null, sourceProcessId: null, targetServiceId: taskId, contractVersion: 1,
      payload: { namespace: 'agent', key: 'label', value: 'review', expectedVersion: 0 },
      idempotencyKey: 'metadata-1', correlationId: 'correlation', causationId: null,
      priority: 0, createdAt: 11, eventId: crypto.randomUUID() });
    expect(store.claimNextSignal({ bootId: 'boot', now: 12, leaseMs: 30_000,
      eventId: crypto.randomUUID() })?.id).toBe(signalId);
    store.acknowledgeMetadataSignal({ signalId, namespace: 'agent', key: 'label', value: 'review',
      expectedVersion: 0, actor: 'test', now: 13,
      eventIds: [crypto.randomUUID(), crypto.randomUUID()] });
    const after = store.getService(taskId);
    expect(after.coreState.lifecycleState).toBe('RUNNING');
    expect(after.coreVersion).toBe(0);
    expect(after.stateVersion).toBe(1);
    expect(after.metadata).toEqual({ 'agent/label': 'review' });
  });

  test('converges a duplicate target/idempotency key on one receipt', () => {
    const storage = new Phase1Database(); opened.push(storage);
    seedLegacyCore(storage.sqlite);
    const store = new ServiceKernelStore(storage); store.reconcileProjections(10);
    const input = { id: '60000000-0000-4000-8000-000000000002', kind: 'SIG_P' as const,
      subtype: 'INTENT_SUBMITTED', sourceServiceId: null, sourceProcessId: null,
      targetServiceId: projectId, contractVersion: 1,
      payload: { text: 'Do it', adapterId: 'pi' }, idempotencyKey: 'same',
      correlationId: 'correlation', causationId: null, priority: 0, createdAt: 11,
      eventId: crypto.randomUUID() };
    expect(store.enqueueSignal(input).created).toBe(true);
    expect(store.enqueueSignal({ ...input, id: crypto.randomUUID(), eventId: crypto.randomUUID() }).created)
      .toBe(false);
    expect(() => store.enqueueSignal({ ...input, id: crypto.randomUUID(),
      payload: { text: 'Different', adapterId: 'pi' }, eventId: crypto.randomUUID() }))
      .toThrow(/different payload/);
  });
});
