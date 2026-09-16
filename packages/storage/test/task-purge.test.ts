import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Phase1Database,
  StorageError,
  type ImpactSnapshotInput,
  type TaskPurgeInput,
} from '../src/index.js';

/**
 * `task.purge` at the storage boundary (ADR-0058): the two refusals that a CLI fixture cannot reach
 * (history that lives outside the Task), the replay receipt, the append-only guard, and the paired
 * impact rows whose delete predicate is an `OR` across two snapshot columns.
 */

const oid = 'a'.repeat(40);
const digest = 'f'.repeat(64);

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function openDatabase(): { readonly database: Phase1Database; readonly filename: string } {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-purge-storage-'));
  directories.push(directory);
  const filename = join(directory, 'runtime.sqlite');
  const database = new Phase1Database(filename);
  database.sqlite.query(`INSERT INTO projects
    (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
    VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','sha1',1)`).run();
  database.sqlite.query(`INSERT INTO project_trusts
    (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
    VALUES ('trust1','p1','/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run();
  database.sqlite.transaction(() => {
    for (const [task, revision, number] of [['t1', 'r1', 1], ['t2', 'r2', 2]] as const) {
      database.sqlite.query(`INSERT INTO tasks
        (id,project_id,display_number,kind,current_revision_id,state,created_at,updated_at)
        VALUES (?1,'p1',?2,'DEVELOPMENT',?3,'CANCELLED',2,2)`).run(task, number, revision);
      database.sqlite.query(`INSERT INTO task_revisions
        (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
        VALUES (?1,?2,1,NULL,'Do work','[]','user','initial',2)`).run(revision, task);
    }
  })();
  return { database, filename };
}

function snapshotInput(overrides: Partial<ImpactSnapshotInput>): ImpactSnapshotInput {
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

function purgeInput(overrides: Partial<TaskPurgeInput> = {}): TaskPurgeInput {
  return {
    projectId: 'p1',
    taskId: 't1',
    expectedVersion: 0,
    commandId: crypto.randomUUID(),
    payloadHash: 'a'.repeat(64),
    eventId: crypto.randomUUID(),
    actor: 'user',
    reason: 'cleanup',
    purgedAt: 100,
    reclamation: [],
    branches: [],
    ...overrides,
  };
}

/** Makes the Task a member of an integration batch, which is what `dev` actually keeps. */
function seedIntegrationMembership(database: Database): void {
  database.transaction(() => {
    database.query(`INSERT INTO integration_batches
      (id,project_id,dev_ref,dev_commit,state,worktree_ownership_token,created_at)
      VALUES ('b1','p1','refs/heads/dev',?1,'CREATED','token',3)`).run(oid);
    database.query(`INSERT INTO integration_batch_items
      (batch_id,project_id,task_id,revision_id,execution_id,candidate_commit,dev_commit,state,created_at)
      VALUES ('b1','p1','t1','r1','e1',?1,?1,'PREPARED',3)`).run(oid);
  })();
}

describe('task purge storage boundary', () => {
  test('refuses a Task whose commit already reached an integration batch, deleting nothing', () => {
    const { database } = openDatabase();
    try {
      database.sqlite.query(`INSERT INTO workspaces
        (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
        VALUES ('w1','t1','refs/heads/task/t1','/tmp/w1','token',?1,'RETAINED',3)`).run(oid);
      database.sqlite.query(`INSERT INTO executions
        (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,adapter_id,
          adapter_version,state,resource_held,base_commit,result_commit,version)
        VALUES ('e1','t1',1,'r1','r1','w1','pi','1.0.0','SUCCEEDED',0,?1,?1,0)`).run(oid);
      seedIntegrationMembership(database.sqlite);

      const blockers = database.inspectTaskPurgeBlockers({ projectId: 'p1', taskId: 't1' });
      expect(blockers.map((blocker) => blocker.code)).toEqual(['TASK_INTEGRATED_INTO_DEV']);
      expect(() => database.purgeTask(purgeInput())).toThrow(StorageError);
      // A refusal writes nothing at all: the Task, its revision and the batch item are all intact.
      expect(database.getTask('p1', 't1')).not.toBeNull();
      expect(database.sqlite.query<{ count: number }, []>(
        'SELECT COUNT(*) AS count FROM integration_batch_items').get()?.count).toBe(1);
      expect(database.sqlite.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM domain_events WHERE event_type='TaskPurged'").get()?.count)
        .toBe(0);
    } finally {
      database.close();
    }
  });

  test('deletes the paired impact rows of both roles and keeps project-scoped audit', () => {
    const { database } = openDatabase();
    try {
      const candidate = database.recordImpactSnapshot(snapshotInput({}));
      const other = database.recordImpactSnapshot(snapshotInput({
        id: crypto.randomUUID(), taskId: 't2', revisionId: 'r2', changeFingerprint: 'fingerprint-2',
      }));
      database.recordImpactAssessment({
        id: crypto.randomUUID(),
        projectId: 'p1',
        candidateTaskId: 't1',
        candidateRevisionId: 'r1',
        candidateSnapshotId: candidate.id,
        otherTaskId: 't2',
        otherRevisionId: 'r2',
        otherSnapshotId: other.id,
        verdict: 'SAFE_TO_PARALLELIZE',
        reasonCodes: ['NO_CONFLICT'],
        hits: [],
        evidence: ['evidence'],
        createdAt: 11,
      });
      // A project-scoped event about the Task is the record of what happened, and it survives: the
      // purge deletes rows the Runtime owns, not the history of the Task having existed.
      database.sqlite.query(`INSERT INTO domain_events
        (event_id,project_id,event_type,schema_version,aggregate_type,aggregate_id,
          aggregate_version,correlation_id,occurred_at,payload_json)
        VALUES ('prior','p1','TaskStateChanged',1,'Task','t1',0,'user',5,'{}')`).run();

      const result = database.purgeTask(purgeInput());
      expect(result.rowsDeleted['impact_assessments']).toBe(1);
      expect(result.rowsDeleted['impact_snapshots']).toBe(1);
      expect(result.rowsDeleted['task_revisions']).toBe(1);
      expect(result.rowsDeleted['tasks']).toBe(1);
      // The *other* Task's snapshot is untouched: only the purge's own side of the pair goes.
      expect(database.sqlite.query<{ id: string }, []>(
        'SELECT id FROM impact_snapshots').all().map((row) => row.id)).toEqual([other.id]);
      const events = database.sqlite.query<{ event_type: string }, []>(
        'SELECT event_type FROM domain_events ORDER BY event_type').all().map((row) => row.event_type);
      expect(events).toEqual(['TaskPurged', 'TaskStateChanged']);
      expect(database.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      database.close();
    }
  });

  test('answers a replayed command from its receipt instead of a second deletion', () => {
    const { database } = openDatabase();
    try {
      const input = purgeInput();
      const first = database.purgeTask(input);
      expect(database.getTask('p1', 't1')).toBeNull();

      // The Task no longer exists, so `purgeTask` itself would answer NOT_FOUND; the receipt is what
      // makes a retried command idempotent rather than a confusing failure.
      const replayed = database.findTaskPurgeByCommand({
        projectId: 'p1', commandId: input.commandId, taskId: 't1', payloadHash: input.payloadHash,
      });
      expect(replayed).toEqual(first);
      expect(() => database.purgeTask(input)).not.toThrow();
      expect(database.purgeTask(input).purgedAt).toBe(first.purgedAt);

      // The same command ID with different facts is a conflict, never a second, wider deletion.
      expect(() => database.findTaskPurgeByCommand({
        projectId: 'p1', commandId: input.commandId, taskId: 't1', payloadHash: 'b'.repeat(64),
      })).toThrow(StorageError);
    } finally {
      database.close();
    }
  });

  test('refuses to purge when an append-only guard is missing, leaving the Task intact', () => {
    const { database } = openDatabase();
    try {
      database.sqlite.exec('DROP TRIGGER task_revisions_no_delete');
      expect(() => database.purgeTask(purgeInput())).toThrow(StorageError);
      expect(database.getTask('p1', 't1')).not.toBeNull();
      // The four remaining guards were dropped inside the failed transaction and rolled back with it.
      const triggers = database.sqlite.query<{ name: string }, []>(`
        SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%no_delete'
        AND tbl_name IN ('task_revisions','impact_snapshots','impact_assessments',
          'targeted_test_plans','execution_knowledge_snapshots')
      `).all().map((row) => row.name).sort();
      expect(triggers).toEqual([
        'execution_knowledge_snapshots_no_delete', 'impact_assessments_no_delete',
        'impact_snapshots_no_delete', 'targeted_test_plans_no_delete',
      ]);
    } finally {
      database.close();
    }
  });
});
