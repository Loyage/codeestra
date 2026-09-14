import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Phase1Database,
  StorageError,
  TaskDependencyError,
  agentAnswerMigration,
  agentConfigurationMigration,
  agentDisconnectMigration,
  agentObservationMigration,
  agentStartMigration,
  integrationPipelineMigration,
  operationProgressMigration,
  phase1Migration,
  phase1SchemaVersion,
  reclamationMigration,
  taskControlMigration,
  taskVerificationMigration,
  workspaceRetryMigration,
} from '../src/index.js';

const oid = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const merged = 'c'.repeat(40);

function seed(storage: Phase1Database): void {
  const db = storage.sqlite;
  db.query(`INSERT INTO projects
    (id,name,repo_root,git_common_dir,main_ref,dev_ref,object_format,created_at)
    VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','refs/heads/dev','sha1',1)`).run();
  db.query(`INSERT INTO project_trusts
    (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
    VALUES ('trust1','p1','/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run();
  db.transaction(() => {
    for (const [taskId, revisionId, displayNumber, state] of [
      ['t1', 'r1', 1, 'READY'],
      ['t2', 'r2', 2, 'READY'],
      ['t3', 'r3', 3, 'READY'],
    ] as const) {
      db.query(`INSERT INTO tasks
        (id,project_id,display_number,kind,current_revision_id,state,created_at,updated_at)
        VALUES (?1,'p1',?2,'DEVELOPMENT',?3,?4,2,2)`).run(taskId, displayNumber, revisionId, state);
      db.query(`INSERT INTO task_revisions
        (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
        VALUES (?1,?2,1,NULL,'Do work','[]','user','initial',2)`).run(revisionId, taskId);
    }
  })();
}

function seedIntegratedTask(
  storage: Phase1Database,
  input: {
    readonly taskId: string;
    readonly revisionId: string;
    readonly executionId: string;
    readonly resultCommit: string;
  },
): void {
  const db = storage.sqlite;
  const workspaceId = `w-${input.executionId}`;
  db.query(`INSERT INTO workspaces
    (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
    VALUES (?1,?2,?3,?4,?5,?6,'RETAINED',3)`).run(
    workspaceId, input.taskId, `refs/heads/task/${input.taskId}`,
    `/work/${input.executionId}`, `owner-${input.executionId}`, oid);
  db.query(`INSERT INTO executions
    (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,adapter_id,
     adapter_version,state,resource_held,base_commit,result_commit,started_at,ended_at)
    VALUES (?1,?2,1,?3,?3,?4,'pi','1','SUCCEEDED',0,?5,?6,4,5)`).run(
    input.executionId, input.taskId, input.revisionId, workspaceId, oid, input.resultCommit);
}

function seedIntegrationBatch(
  storage: Phase1Database,
  input: {
    readonly taskId: string;
    readonly revisionId: string;
    readonly executionId: string;
    readonly batchId: string;
    readonly integratedCommit: string;
    /** A batch that never reached INTEGRATED, so the item row must not count as a fact. */
    readonly batchState?: 'INTEGRATED' | 'FAILED';
  },
): void {
  const db = storage.sqlite;
  db.query(`INSERT INTO integration_batches
    (id,project_id,dev_ref,dev_commit,state,worktree_ownership_token,created_at)
    VALUES (?1,'p1','refs/heads/dev',?2,?3,?4,20)`).run(
    input.batchId, oid, input.batchState ?? 'INTEGRATED', `owner-${input.batchId}`);
  db.query(`INSERT INTO integration_batch_items
    (batch_id,project_id,task_id,revision_id,execution_id,candidate_commit,dev_commit,state,
     integrated_commit,created_at)
    VALUES (?1,'p1',?2,?3,?4,?5,?6,'INTEGRATED',?5,20)`).run(
    input.batchId, input.taskId, input.revisionId, input.executionId,
    input.integratedCommit, oid);
}

/** Asserts the stable error code, not the human-readable message. */
async function expectCode(action: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof action === 'function' ? action() : action);
  } catch (error) {
    expect((error as { readonly code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected the call to fail with ${code}`);
}

function addDependency(
  storage: Phase1Database,
  input: {
    readonly taskId: string;
    readonly prerequisiteTaskId: string;
    readonly commandId: string;
    readonly expectedVersion?: number;
    readonly requiredRevisionId?: string;
  },
) {
  return storage.addTaskDependency({
    projectId: 'p1',
    taskId: input.taskId,
    prerequisiteTaskId: input.prerequisiteTaskId,
    ...(input.requiredRevisionId === undefined ? {} : { requiredRevisionId: input.requiredRevisionId }),
    expectedVersion: input.expectedVersion ?? 0,
    commandId: input.commandId,
    payloadHash: `hash-${input.commandId}`,
    eventId: `event-${input.commandId}`,
    actor: 'local-user',
    createdAt: 10,
  });
}

describe('task dependency persistence', () => {
  test('upgrades a version 12 database and keeps every existing row', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-deps-'));
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
      legacy.exec(taskControlMigration);
      legacy.exec(integrationPipelineMigration);
      legacy.exec(operationProgressMigration);
      legacy.exec(reclamationMigration);
      legacy.exec('PRAGMA user_version=12');
      legacy.query(`INSERT INTO projects
        (id,name,repo_root,git_common_dir,main_ref,dev_ref,object_format,created_at)
        VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','refs/heads/dev','sha1',1)`).run();
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
        VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1',?1,'RETAINED',3)`).run(oid);
      legacy.query(`INSERT INTO executions
        (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,adapter_id,
         adapter_version,state,resource_held,base_commit,result_commit,started_at,ended_at)
        VALUES ('e1','t1',1,'r1','r1','w1','pi','1','SUCCEEDED',0,?1,?2,4,5)`).run(oid, candidate);
      legacy.query(`INSERT INTO integration_batches
        (id,project_id,dev_ref,dev_commit,state,worktree_ownership_token,created_at)
        VALUES ('batch1','p1','refs/heads/dev',?1,'INTEGRATED','owner-1',5)`).run(oid);
      legacy.query(`INSERT INTO integration_batch_items
        (batch_id,project_id,task_id,revision_id,execution_id,candidate_commit,dev_commit,state,
         integrated_commit,created_at)
        VALUES ('batch1','p1','t1','r1','e1',?1,?2,'INTEGRATED',?1,5)`).run(candidate, oid);
      legacy.close();

      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
        .toBe(phase1SchemaVersion);
      // The assertion is deliberately not a literal: the concurrent lanes above this one reserve
      // later versions (16, 17, 18), and the constant stays the maximum of them after they land.
      // A hard-coded number here would fail for every later additive migration instead of testing
      // the upgrade.
      expect(phase1SchemaVersion).toBeGreaterThanOrEqual(15);
      expect(upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='task_dependencies'",
      ).get()?.name).toBe('task_dependencies');
      // The pre-existing integration fact and Task row survived the additive step.
      expect(upgraded.sqlite.query<{ count: number }, []>(
        'SELECT COUNT(*) AS count FROM tasks',
      ).get()?.count).toBe(1);
      expect(upgraded.sqlite.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM integration_batch_items WHERE state='INTEGRATED'",
      ).get()?.count).toBe(1);
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('upgrades a database already stamped at the lanes reserved above 12', () => {
    // Versions 13 and 14 are reserved by the concurrent B1/B2 lanes and do not exist in this
    // worktree, so a database stamped 14 is exactly the state this migration will find after those
    // lanes land: their steps already ran, this one has not.
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-deps-v14-'));
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
      legacy.exec(taskControlMigration);
      legacy.exec(integrationPipelineMigration);
      legacy.exec(operationProgressMigration);
      legacy.exec(reclamationMigration);
      legacy.exec('PRAGMA user_version=14');
      legacy.close();

      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
        .toBe(phase1SchemaVersion);
      expect(upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='task_dependencies'",
      ).get()?.name).toBe('task_dependencies');
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('refuses a self-dependency and a dependency on an unknown Task', () => {
    const storage = new Phase1Database();
    seed(storage);
    expect(() => addDependency(storage, { taskId: 't1', prerequisiteTaskId: 't1', commandId: 'c-self' }))
      .toThrow(TaskDependencyError);
    expect(storage.sqlite.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM task_dependencies',
    ).get()?.count).toBe(0);
    // The schema refuses it as well, so a direct INSERT cannot bypass the command path.
    expect(() => storage.sqlite.query(`INSERT INTO task_dependencies
      (dependent_task_id,prerequisite_task_id,project_id,required_revision_id,created_by,created_at)
      VALUES ('t1','t1','p1','r1','user',1)`).run()).toThrow();
    expect(() => addDependency(storage, { taskId: 't1', prerequisiteTaskId: 't9', commandId: 'c-unknown' }))
      .toThrow(StorageError);
    storage.close();
  });

  test('stores the edge, pins the upstream revision and replays idempotently', () => {
    const storage = new Phase1Database();
    seed(storage);
    const added = addDependency(storage, { taskId: 't1', prerequisiteTaskId: 't2', commandId: 'c1' });
    expect(added).toEqual({ projectId: 'p1', taskId: 't1', prerequisiteTaskId: 't2',
      requiredRevisionId: 'r2', taskState: 'READY', version: 1, added: true });
    expect(storage.getTask('p1', 't1')?.version).toBe(1);
    expect(storage.sqlite.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type='TaskDependencyAdded'",
    ).get()?.count).toBe(1);

    // Same command ID: the recorded result is returned and nothing is written twice.
    const replayed = addDependency(storage, { taskId: 't1', prerequisiteTaskId: 't2', commandId: 'c1' });
    expect(replayed.added).toBe(true);
    expect(storage.getTask('p1', 't1')?.version).toBe(1);
    expect(storage.sqlite.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM task_dependencies',
    ).get()?.count).toBe(1);

    // A different command ID for the identical edge is reported as an existing edge, not a second row.
    const duplicate = addDependency(storage, { taskId: 't1', prerequisiteTaskId: 't2',
      commandId: 'c2', expectedVersion: 1 });
    expect(duplicate.added).toBe(false);
    expect(duplicate.version).toBe(1);
    expect(storage.getTask('p1', 't1')?.version).toBe(1);

    const facts = storage.listTaskDependencyFacts('p1', { taskId: 't1' });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ prerequisiteTaskId: 't2', requiredRevisionId: 'r2',
      requiredRevisionNumber: 1, dependentDisplayNumber: 1, prerequisiteDisplayNumber: 2,
      integratedCommit: null, integrationBatchId: null });

    // Re-pinning an existing edge is refused instead of silently retargeting it.
    expect(() => addDependency(storage, { taskId: 't1', prerequisiteTaskId: 't2',
      commandId: 'c3', expectedVersion: 1, requiredRevisionId: 'r9' })).toThrow(StorageError);
    storage.close();
  });

  test('reports the recorded integration fact for the pinned revision', () => {
    const storage = new Phase1Database();
    seed(storage);
    addDependency(storage, { taskId: 't1', prerequisiteTaskId: 't2', commandId: 'c1' });
    seedIntegratedTask(storage, { taskId: 't2', revisionId: 'r2', executionId: 'e2',
      resultCommit: candidate });
    // A batch that never reached INTEGRATED is not a fact, even with an item row.
    seedIntegrationBatch(storage, { taskId: 't2', revisionId: 'r2', executionId: 'e2',
      batchId: 'batch2', integratedCommit: candidate, batchState: 'FAILED' });
    expect(storage.listTaskDependencyFacts('p1', { taskId: 't1' })[0]?.integratedCommit).toBeNull();
    seedIntegrationBatch(storage, { taskId: 't2', revisionId: 'r2', executionId: 'e2',
      batchId: 'batch1', integratedCommit: merged });
    const fact = storage.listTaskDependencyFacts('p1', { taskId: 't1' })[0];
    expect(fact?.integratedCommit).toBe(merged);
    expect(fact?.integrationBatchId).toBe('batch1');
    storage.close();
  });

  test('refuses an edge that would close a cycle and writes nothing', () => {
    const storage = new Phase1Database();
    seed(storage);
    addDependency(storage, { taskId: 't1', prerequisiteTaskId: 't2', commandId: 'c1' });
    addDependency(storage, { taskId: 't2', prerequisiteTaskId: 't3', commandId: 'c2', expectedVersion: 0 });
    // t3 -> t1 would close t1 -> t2 -> t3 -> t1.
    expect(() => addDependency(storage, { taskId: 't3', prerequisiteTaskId: 't1', commandId: 'c3' }))
      .toThrow(TaskDependencyError);
    expect(storage.sqlite.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM task_dependencies',
    ).get()?.count).toBe(2);
    expect(storage.getTask('p1', 't3')?.version).toBe(0);
    // The direct reverse edge is refused with the same code.
    expect(() => addDependency(storage, { taskId: 't2', prerequisiteTaskId: 't1',
      commandId: 'c4', expectedVersion: 1 })).toThrow(TaskDependencyError);
    storage.close();
  });

  test('refuses to edit the graph while the Task is writing or already produced a result', async () => {
    const storage = new Phase1Database();
    seed(storage);
    for (const state of ['RUNNING', 'PAUSED', 'SUCCEEDED', 'EXECUTED', 'CANCELLED'] as const) {
      storage.sqlite.query('UPDATE tasks SET state=?1 WHERE id=?2').run(state, 't1');
      // A captured result means a dependency added now could not have shaped it, so the edit is
      // refused instead of silently pretending the evidence was produced under the new graph.
      await expectCode(() => addDependency(storage, { taskId: 't1', prerequisiteTaskId: 't2',
        commandId: `c-${state}` }), 'INVALID_STATE');
    }
    storage.sqlite.query("UPDATE tasks SET state='READY' WHERE id='t1'").run();
    addDependency(storage, { taskId: 't1', prerequisiteTaskId: 't2', commandId: 'c-ready' });
    // A captured result closes the graph for this Task: both adding and removing are refused.
    storage.sqlite.query("UPDATE tasks SET state='EXECUTED' WHERE id='t1'").run();
    await expectCode(() => addDependency(storage, { taskId: 't1', prerequisiteTaskId: 't3',
      commandId: 'c-executed', expectedVersion: 1 }), 'INVALID_STATE');
    await expectCode(() => storage.removeTaskDependency({
      projectId: 'p1', taskId: 't1', prerequisiteTaskId: 't2', expectedVersion: 1,
      commandId: 'c-executed-remove', payloadHash: 'h2', eventId: 'e2', actor: 'local-user',
      removedAt: 11,
    }), 'INVALID_STATE');
    expect(storage.listTaskDependencyFacts('p1', { taskId: 't1' })).toHaveLength(1);
    expect(storage.getTask('p1', 't1')?.version).toBe(1);
    // FAILED stays editable: a retry may be re-planned with a different graph.
    storage.sqlite.query("UPDATE tasks SET state='FAILED' WHERE id='t1'").run();
    expect(storage.removeTaskDependency({
      projectId: 'p1', taskId: 't1', prerequisiteTaskId: 't2', expectedVersion: 1,
      commandId: 'c-failed-remove', payloadHash: 'h3', eventId: 'e3', actor: 'local-user',
      removedAt: 12,
    }).version).toBe(2);
    storage.close();
  });

  test('removes an edge and refuses a removal that finds nothing', () => {
    const storage = new Phase1Database();
    seed(storage);
    addDependency(storage, { taskId: 't1', prerequisiteTaskId: 't2', commandId: 'c1' });
    const removed = storage.removeTaskDependency({
      projectId: 'p1', taskId: 't1', prerequisiteTaskId: 't2', expectedVersion: 1,
      commandId: 'c2', payloadHash: 'h2', eventId: 'e2', actor: 'local-user', removedAt: 11,
    });
    expect(removed).toEqual({ projectId: 'p1', taskId: 't1', prerequisiteTaskId: 't2',
      taskState: 'READY', version: 2, removed: true });
    expect(storage.listTaskDependencyFacts('p1', { taskId: 't1' })).toEqual([]);
    expect(() => storage.removeTaskDependency({
      projectId: 'p1', taskId: 't1', prerequisiteTaskId: 't2', expectedVersion: 2,
      commandId: 'c3', payloadHash: 'h3', eventId: 'e3', actor: 'local-user', removedAt: 12,
    })).toThrow(StorageError);
    expect(storage.getTask('p1', 't1')?.version).toBe(2);
    storage.close();
  });

  test('moves between READY and BLOCKED only, with a reason for BLOCKED', () => {
    const storage = new Phase1Database();
    seed(storage);
    addDependency(storage, { taskId: 't1', prerequisiteTaskId: 't2', commandId: 'c1' });
    const reason = { code: 'UPSTREAM_NOT_INTEGRATED' as const, prerequisiteTaskId: 't2',
      requiredRevisionId: 'r2', detail: null };
    const blocked = storage.applyTaskDependencyState({
      projectId: 'p1', taskId: 't1', expectedVersion: 1, target: 'BLOCKED',
      reasons: [reason], commandId: 'b1', payloadHash: 'hb1', eventId: 'eb1',
      actor: 'local-user', at: 12,
    });
    expect(blocked).toEqual({ taskId: 't1', state: 'BLOCKED', version: 2, changed: true,
      reasons: [reason] });
    // Same verdict again: no version bump, no second event.
    const repeat = storage.applyTaskDependencyState({
      projectId: 'p1', taskId: 't1', expectedVersion: 2, target: 'BLOCKED',
      reasons: [reason], commandId: 'b2', payloadHash: 'hb2', eventId: 'eb2',
      actor: 'local-user', at: 13,
    });
    expect(repeat.changed).toBe(false);
    expect(repeat.version).toBe(2);
    expect(storage.sqlite.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type='TaskStateChanged'",
    ).get()?.count).toBe(1);

    const readied = storage.applyTaskDependencyState({
      projectId: 'p1', taskId: 't1', expectedVersion: 2, target: 'READY',
      reasons: [], commandId: 'b3', payloadHash: 'hb3', eventId: 'eb3',
      actor: 'local-user', at: 14,
    });
    expect(readied).toEqual({ taskId: 't1', state: 'READY', version: 3, changed: true, reasons: [] });

    // BLOCKED without a reason, and READY with one, are both refused.
    expect(() => storage.applyTaskDependencyState({
      projectId: 'p1', taskId: 't1', expectedVersion: 3, target: 'BLOCKED',
      reasons: [], commandId: 'b4', payloadHash: 'hb4', eventId: 'eb4',
      actor: 'local-user', at: 15,
    })).toThrow(StorageError);
    expect(() => storage.applyTaskDependencyState({
      projectId: 'p1', taskId: 't1', expectedVersion: 3, target: 'READY',
      reasons: [reason], commandId: 'b5', payloadHash: 'hb5', eventId: 'eb5',
      actor: 'local-user', at: 16,
    })).toThrow(StorageError);
    // The verdict never touches a Task that is not in the dependency states.
    storage.sqlite.query("UPDATE tasks SET state='RUNNING' WHERE id='t1'").run();
    expect(() => storage.applyTaskDependencyState({
      projectId: 'p1', taskId: 't1', expectedVersion: 3, target: 'BLOCKED',
      reasons: [reason], commandId: 'b6', payloadHash: 'hb6', eventId: 'eb6',
      actor: 'local-user', at: 17,
    })).toThrow(StorageError);
    storage.close();
  });

  test('keeps edges immutable so a dependency never silently changes meaning', () => {
    const storage = new Phase1Database();
    seed(storage);
    addDependency(storage, { taskId: 't1', prerequisiteTaskId: 't2', commandId: 'c1' });
    expect(() => storage.sqlite.query(
      "UPDATE task_dependencies SET required_revision_id='r3' WHERE dependent_task_id='t1'",
    ).run()).toThrow();
    storage.close();
  });
});
