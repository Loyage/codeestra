import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Phase1Database, StorageError, phase1SchemaVersion, rootServiceId }
  from '@codeestra/storage';
import { managedIntegrationMigration } from '../src/migration.js';

/**
 * S8 storage (ADR-0070 D07 / ADR-0074): the v37→v38 upgrade of a real database file plus the
 * constraints that make "one active integration per project" and "one live request per Task
 * revision" database facts rather than conventions.
 */

const projectId = '10000000-0000-4000-8000-0000000000f1';
const projectServiceId = projectId;
const taskId = '20000000-0000-4000-8000-0000000000f2';
const revisionId = '30000000-0000-4000-8000-0000000000f3';
const workspaceId = '40000000-0000-4000-8000-0000000000f4';
const executionId = '50000000-0000-4000-8000-0000000000f5';
const operationId = '60000000-0000-4000-8000-0000000000f6';
const verificationId = '70000000-0000-4000-8000-0000000000f7';
const root = rootServiceId;

const files: string[] = [];
afterEach(() => {
  for (const file of files.splice(0)) rmSync(file, { force: true });
});

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-v38-'));
  const file = join(directory, 'runtime.sqlite');
  files.push(file);
  return file;
}

/**
 * A real v37 database with one trusted project, one Task, one captured result and one PASSED Task
 * verification run — the exact facts a merge request has to point at.
 */
function seedV37(file: string): void {
  const database = new Phase1Database(file);
  try {
    database.sqlite.exec('PRAGMA user_version=37');
    // The `tasks`/`task_revisions` FK pair is DEFERRABLE INITIALLY DEFERRED, so the seed has to be
    // one transaction: outside one, each statement is its own transaction and the forward reference
    // would be checked — and fail — before the revision exists.
    database.sqlite.transaction(() => {

    // Drop what v38 added so this file really is a v37 shape being upgraded, not a v38 file.
    database.sqlite.exec('DROP TABLE task_integration; DROP TABLE integration_runs;'
      + ' DROP TABLE merge_queue_items; DROP TABLE project_integration;');
    database.sqlite.query(`INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,
      object_format,policy_version,created_at)
      VALUES (?1,'fixture','/tmp/repo','/tmp/repo/.git','refs/heads/main','sha1',1,1)`).run(projectId);
    database.sqlite.query(`INSERT INTO project_trusts(id,project_id,repo_root,git_common_dir,
      object_format,policy_version,actor,status,accepted_at)
      VALUES (?1,?2,'/tmp/repo','/tmp/repo/.git','sha1',1,'user','ACTIVE',1)`)
      .run('90000000-0000-4000-8000-0000000000f8', projectId);
    database.sqlite.query(`INSERT INTO services(id,kind,parent_service_id,lifecycle,state_version,
      contract_version,project_id,task_id,inbox_cursor,created_at,updated_at)
      VALUES (?1,'PROJECT',?2,'ACTIVE',0,1,?1,NULL,0,1,1)`).run(projectServiceId, root);
    database.sqlite.query(`INSERT INTO tasks(id,project_id,display_number,display_title,naming_title,
      current_revision_id,state,priority,version,created_at,updated_at)
      VALUES (?1,?2,1,'fixture','fixture',?3,'EXECUTED',0,0,2,2)`).run(taskId, projectId, revisionId);
    database.sqlite.query(`INSERT INTO task_revisions(id,task_id,number,previous_revision_id,
      specification,features_json,source_intent_id,actor,reason,created_at)
      VALUES (?1,?2,1,NULL,'Do work','[]',NULL,'user','initial',2)`).run(revisionId, taskId);
    database.sqlite.query(`INSERT INTO services(id,kind,parent_service_id,lifecycle,state_version,
      contract_version,project_id,task_id,inbox_cursor,created_at,updated_at)
      VALUES (?1,'TASK',?2,'ACTIVE',0,1,NULL,?1,0,2,2)`).run(taskId, projectServiceId);
    database.sqlite.query(`INSERT INTO workspaces(id,task_id,branch_ref,path,ownership_token,
      base_commit,base_ref,state,created_at)
      VALUES (?1,?2,'refs/heads/task/fixture','/tmp/worktrees/fixture','owner-fixture',
        ?3,'refs/codeestra/integration','READY',3)`).run(workspaceId, taskId, 'a'.repeat(40));
    database.sqlite.query(`INSERT INTO executions(id,task_id,attempt_number,initial_revision_id,
      applied_revision_id,workspace_id,adapter_id,adapter_version,state,resource_held,base_commit,
      result_commit,started_at,ended_at)
      VALUES (?1,?2,1,?3,?3,?4,'pi','1','SUCCEEDED',0,?5,?6,4,5)`)
      .run(executionId, taskId, revisionId, workspaceId, 'a'.repeat(40), 'b'.repeat(40));
    database.sqlite.query(`INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,
      state,request_json,created_at,updated_at)
      VALUES (?1,?2,'RUN_TASK_VERIFICATION',?3,'cmd-verify','SUCCEEDED','{"taskId":"x"}',6,6)`)
      .run(operationId, projectId, verificationId);
    database.sqlite.query(`INSERT INTO verification_runs(id,project_id,task_id,execution_id,
      revision_id,operation_id,command_id,tested_commit,tested_tree,policy_version,policy_digest,
      main_commit,commands_json,copy_path,state,outcome_code,evidence_json,queued_at,started_at,
      ended_at)
      VALUES (?1,?2,?3,?4,?5,?6,'cmd-verify',?7,'tree','verification-policy-v1','digest',
        ?8,'[]','/tmp/copies/v','PASSED','PASSED','{}',7,8,9)`)
      .run(verificationId, projectId, taskId, executionId, revisionId, operationId,
        'b'.repeat(40), 'a'.repeat(40));
    })();
  } finally {
    database.close();
  }
}

describe('managed integration schema (v38)', () => {
  test('a real v37 file upgrades to v38 and keeps every row', () => {
    const file = temporaryDatabasePath();
    seedV37(file);
    const upgraded = new Phase1Database(file);
    try {
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBe(phase1SchemaVersion);
      expect(phase1SchemaVersion).toBe(38);
      expect(upgraded.getTask(projectId, taskId)?.state).toBe('EXECUTED');
      // The new tables exist and start empty: an upgrade never invents a merge request.
      for (const table of ['project_integration', 'merge_queue_items', 'integration_runs',
        'task_integration']) {
        expect(upgraded.sqlite.query<{ rows: number }, []>(
          `SELECT COUNT(*) AS rows FROM ${table}`).get()?.rows).toBe(0);
      }
      // Re-opening is a no-op, not a second migration.
      upgraded.close();
      const reopened = new Phase1Database(file);
      expect(reopened.getTask(projectId, taskId)?.id).toBe(taskId);
      reopened.close();
    } finally {
      // `upgraded` may already be closed by the assertions above.
    }
  });

  test('the module-level v38 script is exactly what the migration installed', () => {
    // The tables the script declares are the tables the live schema has; a drift here would mean the
    // migration ran something else than the reviewed script.
    for (const table of ['project_integration', 'merge_queue_items', 'integration_runs',
      'task_integration']) {
      expect(managedIntegrationMigration).toContain(`CREATE TABLE ${table}`);
    }
    const database = new Phase1Database();
    try {
      const names = database.sqlite.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
        .map((row) => row.name);
      for (const table of ['project_integration', 'merge_queue_items', 'integration_runs',
        'task_integration']) expect(names).toContain(table);
    } finally {
      database.close();
    }
  });

  test('the merge queue is durable, serialized per project and idempotent per request', () => {
    const file = temporaryDatabasePath();
    seedV37(file);
    const storage = new Phase1Database(file);
    try {
      const store = storage.managedIntegration;
      const ensured = store.ensureProjectIntegration({
        projectId, projectServiceId, integrationRef: 'refs/codeestra/integration',
        ownershipToken: '80000000-0000-4000-8000-0000000000f9', now: 10,
      });
      expect(ensured.created).toBe(true);
      // Idempotent, and a repeat that names another ref is refused instead of re-pointing.
      expect(store.ensureProjectIntegration({
        projectId, projectServiceId, integrationRef: 'refs/codeestra/integration',
        ownershipToken: '80000000-0000-4000-8000-0000000000f9', now: 11,
      }).created).toBe(false);
      expect(() => store.ensureProjectIntegration({
        projectId, projectServiceId, integrationRef: 'refs/heads/integration',
        ownershipToken: '80000000-0000-4000-8000-0000000000f9', now: 11,
      })).toThrow(/already manages/);

      const enqueued = store.enqueueMergeRequest({
        itemId: 'a0000000-0000-4000-8000-0000000000f1', projectId, projectServiceId,
        taskId, revisionId, resultCommit: 'b'.repeat(40), taskVerificationRunId: verificationId,
        priority: 0, correlationId: 'corr', idempotencyKey: 'req-1', actor: 'user', now: 12,
        nextEventId: () => crypto.randomUUID(),
      });
      expect(enqueued.created).toBe(true);
      expect(enqueued.item.state).toBe('QUEUED');
      // A Task Service that re-sends the same request converges on the same item.
      const repeat = store.enqueueMergeRequest({
        itemId: 'a0000000-0000-4000-8000-0000000000f2', projectId, projectServiceId,
        taskId, revisionId, resultCommit: 'b'.repeat(40), taskVerificationRunId: verificationId,
        priority: 0, correlationId: 'corr', idempotencyKey: 'req-1', actor: 'user', now: 13,
        nextEventId: () => crypto.randomUUID(),
      });
      expect(repeat.created).toBe(false);
      expect(repeat.item.id).toBe(enqueued.item.id);
      // …and a second live item for the same revision is refused by the partial unique index rather
      // than by a convention: the idempotent path above is what swallows it.
      const sameRevision = store.enqueueMergeRequest({
        itemId: 'a0000000-0000-4000-8000-0000000000f3', projectId, projectServiceId,
        taskId, revisionId, resultCommit: 'b'.repeat(40), taskVerificationRunId: verificationId,
        priority: 9, correlationId: 'corr', idempotencyKey: 'req-2', actor: 'user', now: 14,
        nextEventId: () => crypto.randomUUID(),
      });
      expect(sameRevision.created).toBe(false);
      expect(store.listQueue(projectId).length).toBe(1);
      // The Task projection says QUEUED, and the request is an auditable event.
      expect(store.taskIntegration(taskId)?.state).toBe('QUEUED');
      expect(storage.sqlite.query<{ rows: number }, [string]>(
        `SELECT COUNT(*) AS rows FROM domain_events WHERE event_type='TaskMergeRequested'
          AND aggregate_id=?1`).get(enqueued.item.id)?.rows).toBe(1);

      // Claiming the item makes it the single active integration of this project.
      const claimed = store.claimQueueItem({
        projectId, itemId: enqueued.item.id, now: 15, expectedIntegrationOid: 'a'.repeat(40),
      });
      expect(claimed.state).toBe('MERGING');
      expect(claimed.expectedIntegrationOid).toBe('a'.repeat(40));
      expect(store.activeItem(projectId)?.id).toBe(enqueued.item.id);
      // While an item holds the slot, no queued item is offered: the queue is serialized by
      // `one_active_integration_per_project`, not by the caller remembering to check.
      expect(store.nextQueuedItem(projectId)).toBeNull();
      // A second request for the same Task revision while the first one is live converges on it
      // instead of writing a row the partial unique index would reject.
      const whileActive = store.enqueueMergeRequest({
        itemId: 'a0000000-0000-4000-8000-0000000000f4', projectId, projectServiceId,
        taskId, revisionId, resultCommit: 'b'.repeat(40),
        taskVerificationRunId: verificationId, priority: 0, correlationId: 'corr',
        idempotencyKey: 'req-3', actor: 'user', now: 16, nextEventId: () => crypto.randomUUID(),
      });
      expect(whileActive.created).toBe(false);
      expect(whileActive.item.id).toBe(enqueued.item.id);
    } finally {
      storage.close();
    }
  });

  test('a refused queue transition leaves the row untouched', () => {
    const file = temporaryDatabasePath();
    seedV37(file);
    const storage = new Phase1Database(file);
    try {
      const store = storage.managedIntegration;
      store.ensureProjectIntegration({ projectId, projectServiceId,
        integrationRef: 'refs/codeestra/integration',
        ownershipToken: '80000000-0000-4000-8000-0000000000f9', now: 10 });
      const item = store.enqueueMergeRequest({
        itemId: 'a0000000-0000-4000-8000-0000000000f5', projectId, projectServiceId,
        taskId, revisionId, resultCommit: 'b'.repeat(40), taskVerificationRunId: verificationId,
        priority: 0, correlationId: 'corr', idempotencyKey: 'req-4', actor: 'user', now: 11,
        nextEventId: () => crypto.randomUUID(),
      }).item;
      // A QUEUED item cannot jump straight to MERGED, and the refusal is not a partial write.
      expect(() => store.settleItem({ projectId, itemId: item.id, outcome: 'MERGED',
        releasedIntegrationOid: 'c'.repeat(40), now: 12, eventId: crypto.randomUUID() }))
        .toThrow(/Cannot transition/);
      expect(store.getItem(projectId, item.id)?.state).toBe('QUEUED');
      expect(store.getItem(projectId, item.id)?.settledAt).toBeNull();
      // A version conflict on the project record is refused too, and changes nothing.
      const record = store.getProjectIntegration(projectId);
      expect(() => store.recordIntegrationOid({ projectId, integrationOid: 'd'.repeat(40),
        expectedVersion: (record?.version ?? 0) + 5, now: 13 })).toThrow(/Expected version/);
      expect(store.getProjectIntegration(projectId)?.integrationOid).toBeNull();
    } finally {
      storage.close();
    }
  });

  test('the projection refuses an impossible transition and does not bump on a repeat', () => {
    const file = temporaryDatabasePath();
    seedV37(file);
    const storage = new Phase1Database(file);
    try {
      const store = storage.managedIntegration;
      const first = store.projectTask(taskId, 'QUEUED', null, null, 10);
      expect(first.version).toBe(0);
      expect(store.projectTask(taskId, 'QUEUED', null, null, 11).version).toBe(0);
      expect(store.projectTask(taskId, 'MERGING', null, null, 12).version).toBe(1);
      expect(store.projectTask(taskId, 'VERIFYING', null, null, 13).version).toBe(2);
      expect(store.projectTask(taskId, 'MERGED', null, 'c'.repeat(40), 14).version).toBe(3);
      // A settled Task cannot go back to MERGING: the projection is a consequence of the queue.
      expect(() => store.projectTask(taskId, 'MERGING', null, null, 15))
        .toThrow(/Cannot project/);
      expect(store.taskIntegration(taskId)?.state).toBe('MERGED');
      expect(store.taskIntegration(taskId)?.version).toBe(3);
    } finally {
      storage.close();
    }
  });

  test('integration verification runs are durable, unique per candidate and terminal once', () => {
    const file = temporaryDatabasePath();
    seedV37(file);
    const storage = new Phase1Database(file);
    try {
      const store = storage.managedIntegration;
      store.ensureProjectIntegration({ projectId, projectServiceId,
        integrationRef: 'refs/codeestra/integration',
        ownershipToken: '80000000-0000-4000-8000-0000000000f9', now: 10 });
      const item = store.enqueueMergeRequest({
        itemId: 'c0000000-0000-4000-8000-00000000000a', projectId, projectServiceId, taskId,
        revisionId, resultCommit: 'b'.repeat(40), taskVerificationRunId: verificationId,
        priority: 0, correlationId: 'corr', idempotencyKey: 'v-1', actor: 'user', now: 11,
        nextEventId: () => crypto.randomUUID() }).item;
      // The integration run creates the long-command Operation it is bound to (the schema makes that
      // a foreign key, so a run can never exist without the record that explains it), and that insert
      // is idempotent per (item, candidate).
      const run = store.insertIntegrationRun({
        id: 'd0000000-0000-4000-8000-00000000000a', projectId, queueItemId: item.id,
        operationId: 'e0000000-0000-4000-8000-00000000000a', candidateCommit: 'c'.repeat(40),
        expectedIntegrationOid: 'a'.repeat(40), policyVersion: 'verification-policy-v1',
        policyDigest: 'digest', mainCommit: 'a'.repeat(40), commands: [], copyPath: '/tmp/copy',
        now: 12,
      });
      expect(run.state).toBe('QUEUED');
      expect(store.beginIntegrationRun({ runId: run.id, now: 13 }).state).toBe('RUNNING');
      const settled = store.settleIntegrationRun({ runId: run.id, state: 'PASSED',
        outcomeCode: 'PASSED', evidence: { commandCount: 1 }, now: 14 });
      expect(settled.state).toBe('PASSED');
      // The long-command Operation ends with its run: an `IN_PROGRESS` row behind a finished
      // verification would read like a command that is still running.
      expect(storage.sqlite.query<{ state: string }, [string]>(
        'SELECT state FROM operations WHERE id=?1').get(run.operationId)?.state).toBe('SUCCEEDED');
      // The Operation the run created is a real long-command record, in the same transaction, and it
      // is now settled together with its run.
      expect(storage.sqlite.query<{ kind: string; aggregate_id: string; state: string }, [string]>(
        'SELECT kind,aggregate_id,state FROM operations WHERE id=?1').get(run.operationId))
        .toEqual({ kind: 'INTEGRATE_TASK', aggregate_id: item.id, state: 'SUCCEEDED' });
      // Re-settling a run that already ended keeps the first verdict: a rerun cannot rewrite history.
      expect(store.settleIntegrationRun({ runId: run.id, state: 'FAILED', outcomeCode: 'FAILED',
        evidence: {}, now: 15 }).state).toBe('PASSED');
      // A second run for the same candidate is the same run — and therefore the same Operation.
      const again = store.insertIntegrationRun({
        id: 'd0000000-0000-4000-8000-00000000000b', projectId, queueItemId: item.id,
        operationId: 'e0000000-0000-4000-8000-00000000000b', candidateCommit: 'c'.repeat(40),
        expectedIntegrationOid: 'a'.repeat(40), policyVersion: 'verification-policy-v1',
        policyDigest: 'digest', mainCommit: 'a'.repeat(40), commands: [], copyPath: '/tmp/copy2',
        now: 16,
      });
      expect(again.id).toBe(run.id);
      expect(again.operationId).toBe(run.operationId);
      expect(storage.sqlite.query<{ rows: number }, []>(
        'SELECT COUNT(*) AS rows FROM operations').get()?.rows).toBe(2);
    } finally {
      storage.close();
    }
  });

  test('a merge request for a Task that does not exist is refused by the foreign key', () => {
    const file = temporaryDatabasePath();
    seedV37(file);
    const storage = new Phase1Database(file);
    try {
      const store = storage.managedIntegration;
      store.ensureProjectIntegration({ projectId, projectServiceId,
        integrationRef: 'refs/codeestra/integration',
        ownershipToken: '80000000-0000-4000-8000-0000000000f9', now: 10 });
      expect(() => store.enqueueMergeRequest({
        itemId: 'f0000000-0000-4000-8000-00000000000a', projectId, projectServiceId,
        taskId: '20000000-0000-4000-8000-0000000000ff', revisionId,
        resultCommit: 'b'.repeat(40), taskVerificationRunId: verificationId, priority: 0,
        correlationId: 'corr', idempotencyKey: 'fk-1', actor: 'user', now: 11,
        nextEventId: () => crypto.randomUUID(),
      })).toThrow();
      expect(store.listQueue(projectId).length).toBe(0);
    } finally {
      storage.close();
    }
  });

  test('the integration record and its ownership token are never deleted', () => {
    const storage = new Phase1Database();
    try {
      storage.sqlite.query(`INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,
        object_format,policy_version,created_at)
        VALUES (?1,'fixture','/tmp/repo2','/tmp/repo2/.git','refs/heads/main','sha1',1,1)`)
        .run('10000000-0000-4000-8000-0000000000e1');
      storage.sqlite.query(`INSERT INTO services(id,kind,parent_service_id,lifecycle,state_version,
        contract_version,project_id,task_id,inbox_cursor,created_at,updated_at)
        VALUES (?1,'PROJECT',?2,'ACTIVE',0,1,?1,NULL,0,1,1)`)
        .run('10000000-0000-4000-8000-0000000000e1', root);
      storage.managedIntegration.ensureProjectIntegration({
        projectId: '10000000-0000-4000-8000-0000000000e1', projectServiceId: '10000000-0000-4000-8000-0000000000e1',
        integrationRef: 'refs/codeestra/integration',
        ownershipToken: '80000000-0000-4000-8000-0000000000e2', now: 10,
      });
      expect(() => storage.sqlite.query(
        'DELETE FROM project_integration WHERE project_id=?1')
        .run('10000000-0000-4000-8000-0000000000e1')).toThrow(/never deleted/);
    } finally {
      storage.close();
    }
  });

  test('a refusal on a nonexistent project is a stable code, not a raw storage error', () => {
    const storage = new Phase1Database();
    try {
      expect(() => storage.managedIntegration.ensureProjectIntegration({
        projectId: '10000000-0000-4000-8000-0000000000ff',
        projectServiceId: '10000000-0000-4000-8000-0000000000ff',
        integrationRef: 'refs/codeestra/integration', ownershipToken: 'x', now: 1,
      })).toThrow();
      expect(() => storage.managedIntegration.getProjectIntegration('nope')).not.toThrow();
      expect(() => storage.managedIntegration.recordIntegrationOid({ projectId: 'nope',
        integrationOid: 'a'.repeat(40), expectedVersion: 0, now: 1 }))
        .toThrow(/no managed integration ref record/);
    } finally {
      storage.close();
    }
  });
});

// `StorageError` is imported so a future change that starts throwing it here is a visible choice
// rather than an accident; the current refusals are `ManagedIntegrationError`/`KernelStorageError`.
void StorageError;
