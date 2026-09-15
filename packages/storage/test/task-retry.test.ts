import { beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { Phase1Database, StorageError, phase1SchemaVersion } from '../src/index.js';

/**
 * Explicit retry of a FAILED Task (ADR-0036, schema v23).
 *
 * The transition, the workspace hand-back and the audit record are one command transaction; the
 * source state is re-read inside it, so a Task that moved between the caller's check and the write
 * can never be retried. These are the storage-level facts; the command face and the scheduling gate
 * are covered by `apps/runtime/test/cli-task-retry.test.ts`.
 */

const oid = 'a'.repeat(40);
const newerOid = 'b'.repeat(40);
let storage: Phase1Database;
let db: Database;

/** One Task with one revision, one worktree and `attempts` Executions, all inside one transaction. */
function seedTask(target: Database, options: {
  readonly state: string;
  readonly workspaceState: string;
  readonly executionState: string;
  readonly attempts?: number;
  readonly archived: boolean;
  readonly executionAdapter?: string;
}): void {
  const attempts = options.attempts ?? 1;
  target.transaction(() => {
    target.query(`INSERT INTO tasks
      (id,project_id,display_number,kind,current_revision_id,state,version,created_at,updated_at,
       archived_at)
      VALUES ('t1','p1',1,'DEVELOPMENT','r1',?1,4,2,2,?2)`).run(options.state,
      options.archived ? 5 : null);
    target.query(`INSERT INTO task_revisions
      (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
      VALUES ('r1','t1',1,NULL,'Do work','[]','user','initial',2)`).run();
    target.query(`INSERT INTO workspaces
      (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
      VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1',?1,?2,3)`)
      .run(oid, options.workspaceState);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const failed = attempt === attempts && options.executionState === 'FAILED'
        ? options.executionState : 'FAILED';
      target.query(`INSERT INTO executions
        (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,
         adapter_id,adapter_version,state,resource_held,base_commit,started_at,ended_at,error_json)
        VALUES (?1,'t1',?2,'r1','r1','w1',?3,'0.84.4',?4,0,?5,4,5,?6)`).run(
        `e${attempt}`, attempt, options.executionAdapter ?? 'pi',
        attempt === attempts ? options.executionState : failed, oid,
        attempt === attempts ? JSON.stringify({ code: 'AGENT_REPORTED_FAILURE' }) : null,
      );
    }
  })();
}

/** A second, independent database with the same project and Task shape. */
function independentDatabase(options: Parameters<typeof seedTask>[1]): {
  readonly storage: Phase1Database; readonly db: Database;
} {
  const created = new Phase1Database();
  created.sqlite.query(`INSERT INTO projects
    (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
    VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','sha1',1)`).run();
  created.sqlite.query(`INSERT INTO project_trusts
    (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
    VALUES ('trust1','p1','/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run();
  seedTask(created.sqlite, options);
  return { storage: created, db: created.sqlite };
}

function retryInput(overrides: Partial<Parameters<Phase1Database['retryTask']>[0]> = {}) {
  return {
    projectId: 'p1',
    taskId: 't1',
    expectedVersion: 4,
    commandId: 'cmd-retry-1',
    payloadHash: 'payload-1',
    actor: 'local-user',
    adapterId: 'pi',
    failedExecutionId: 'e1',
    target: 'READY' as const,
    dependencyReasons: [],
    workspace: { mode: 'REUSE_VERIFIED' as const, workspaceId: 'w1', evidence: 'workspace-owned:/work/t1' },
    taskEventId: 'evt-task',
    retryEventId: 'evt-retry',
    requestedAt: 10,
    ...overrides,
  };
}

beforeEach(() => {
  const created = independentDatabase({
    state: 'FAILED', workspaceState: 'RETAINED', executionState: 'FAILED', archived: false,
  });
  storage = created.storage;
  db = created.db;
});

describe('task retry', () => {
  test('requeues a FAILED Task, hands its worktree back and writes one audit record', () => {
    const result = storage.retryTask(retryInput());

    expect(result).toMatchObject({
      taskId: 't1', state: 'READY', version: 5, failedExecutionId: 'e1', failedAttemptNumber: 1,
      adapterId: 'pi', previousAdapterId: 'pi', adapterChanged: false,
      workspaceMode: 'REUSE_VERIFIED', workspaceId: 'w1',
    });
    expect(storage.getTask('p1', 't1')?.state).toBe('READY');
    // The worktree is READY again, so the next Execution reuses it instead of preparing a second one.
    expect(db.query<{ state: string }, []>("SELECT state FROM workspaces WHERE id='w1'").get()?.state)
      .toBe('READY');
    // The retry intent is recorded on the Task, waiting to be consumed by the Execution it produces.
    expect(db.query<{ pending_retry_from_execution_id: string | null }, []>(
      'SELECT pending_retry_from_execution_id FROM tasks WHERE id=\'t1\'',
    ).get()?.pending_retry_from_execution_id).toBe('e1');
    // The old Execution is untouched: a retry is a new attempt, never a rewrite of the failure.
    expect(db.query<{ state: string; resource_held: number; error_json: string | null }, []>(
      "SELECT state,resource_held,error_json FROM executions WHERE id='e1'",
    ).get()).toMatchObject({ state: 'FAILED', resource_held: 0 });

    const events = db.query<{ event_type: string; payload_json: string }, []>(
      "SELECT event_type,payload_json FROM domain_events WHERE aggregate_id='t1' ORDER BY sequence",
    ).all();
    expect(events.map((event) => event.event_type))
      .toEqual(['TaskStateChanged', 'TaskRetryRequested']);
    expect(JSON.parse(events[1]?.payload_json as string)).toMatchObject({
      taskId: 't1', from: 'FAILED', to: 'READY', failedExecutionId: 'e1', failedAttemptNumber: 1,
      adapterId: 'pi', previousAdapterId: 'pi', adapterChanged: false,
      workspaceMode: 'REUSE_VERIFIED', workspaceId: 'w1', actor: 'local-user',
    });
  });

  test('the Execution reserved afterwards names the failure it follows, exactly once', () => {
    const retried = storage.retryTask(retryInput());
    const reservation = storage.reserveExecution({
      projectId: 'p1', taskId: 't1', expectedTaskVersion: retried.version, workspaceId: 'w1',
      executionId: 'e2', commandId: 'cmd-e2', payloadHash: 'hash-e2', reservationEventId: 'evt-e2',
      taskEventId: 'evt-task-e2', adapterId: 'pi', adapterVersion: '0.84.4',
      actor: 'runtime-scheduler', createdAt: 11,
    });
    expect(reservation.attemptNumber).toBe(2);
    expect(storage.listTaskExecutions('p1', 't1').find((row) => row.executionId === 'e2'))
      .toMatchObject({ state: 'CREATED', retryFromExecutionId: 'e1', resumeFromExecutionId: null });
    // Single-shot: the intent was consumed, so a later attempt cannot inherit the same relation.
    expect(db.query<{ pending_retry_from_execution_id: string | null }, []>(
      'SELECT pending_retry_from_execution_id FROM tasks WHERE id=\'t1\'',
    ).get()?.pending_retry_from_execution_id).toBeNull();
    const reserved = db.query<{ payload_json: string }, []>(
      "SELECT payload_json FROM domain_events WHERE event_type='ExecutionReserved' AND aggregate_id='e2'",
    ).get();
    expect(JSON.parse(reserved?.payload_json as string)).toMatchObject({
      executionId: 'e2', retryFromExecutionId: 'e1',
    });
  });

  test('replaying the same command is idempotent: one state change, one audit record', () => {
    const first = storage.retryTask(retryInput());
    const replay = storage.retryTask(retryInput({
      // A replay of the same command reaches the recorded receipt, so the freshly generated event
      // IDs of the second call must not reach the database.
      taskEventId: 'evt-task-2', retryEventId: 'evt-retry-2',
    }));
    expect(replay).toEqual(first);
    expect(storage.getTask('p1', 't1')?.version).toBe(5);
    expect(db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM domain_events WHERE event_type='TaskRetryRequested'",
    ).get()?.count).toBe(1);
  });

  test('rejects every source state that is not FAILED, and writes nothing', () => {
    for (const state of ['READY', 'RUNNING', 'PAUSED', 'CANCELLED', 'EXECUTED', 'SUCCEEDED',
      'RECOVERY_REQUIRED'] as const) {
      const fresh = independentDatabase({
        state, workspaceState: 'RETAINED', executionState: 'FAILED', archived: false,
      });
      expect(() => fresh.storage.retryTask(retryInput())).toThrow(StorageError);
      expect(fresh.storage.getTask('p1', 't1')?.state).toBe(state);
      expect(fresh.storage.getTask('p1', 't1')?.version).toBe(4);
      expect(fresh.db.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM domain_events WHERE event_type='TaskRetryRequested'",
      ).get()?.count).toBe(0);
      expect(fresh.db.query<{ state: string }, []>("SELECT state FROM workspaces WHERE id='w1'").get()?.state)
        .toBe('RETAINED');
      expect(fresh.db.query<{ pending_retry_from_execution_id: string | null }, []>(
        'SELECT pending_retry_from_execution_id FROM tasks WHERE id=\'t1\'',
      ).get()?.pending_retry_from_execution_id).toBeNull();
      fresh.storage.close();
    }
  });

  test('refuses an archived Task', () => {
    const fresh = independentDatabase({
      state: 'FAILED', workspaceState: 'RETAINED', executionState: 'FAILED', archived: true,
    });
    expect(() => fresh.storage.retryTask(retryInput())).toThrow(/archived/);
    expect(fresh.storage.getTask('p1', 't1')?.version).toBe(4);
    fresh.storage.close();
  });

  test('refuses a failure that is not the newest attempt, and records a changed Adapter', () => {
    const fresh = independentDatabase({
      state: 'FAILED', workspaceState: 'RETAINED', executionState: 'FAILED', archived: false,
      attempts: 2,
    });
    expect(() => fresh.storage.retryTask(retryInput({ failedExecutionId: 'e1' })))
      .toThrow(/not the failure that ended this Task/);
    expect(fresh.storage.getTask('p1', 't1')?.state).toBe('FAILED');
    const accepted = fresh.storage.retryTask(retryInput({ failedExecutionId: 'e2' }));
    expect(accepted.failedAttemptNumber).toBe(2);
    expect(fresh.db.query<{ pending_retry_from_execution_id: string | null }, []>(
      'SELECT pending_retry_from_execution_id FROM tasks WHERE id=\'t1\'',
    ).get()?.pending_retry_from_execution_id).toBe('e2');
    fresh.storage.close();
  });

  test('records a retry on another Agent as a change, not silently as the same Adapter', () => {
    const fresh = independentDatabase({
      state: 'FAILED', workspaceState: 'RETAINED', executionState: 'FAILED', archived: false,
      executionAdapter: 'pi',
    });
    const changed = fresh.storage.retryTask(retryInput({
      adapterId: 'codex', taskEventId: 'evt-task-2', retryEventId: 'evt-retry-2',
    }));
    expect(changed).toMatchObject({
      adapterId: 'codex', previousAdapterId: 'pi', adapterChanged: true,
    });
    const event = fresh.db.query<{ payload_json: string }, []>(
      "SELECT payload_json FROM domain_events WHERE event_type='TaskRetryRequested'",
    ).get();
    expect(JSON.parse(event?.payload_json as string)).toMatchObject({
      adapterId: 'codex', previousAdapterId: 'pi', adapterChanged: true,
    });
    fresh.storage.close();
  });

  test('refuses a BLOCKED requeue without a reason, and a READY requeue that still names one', () => {
    expect(() => storage.retryTask(retryInput({ target: 'BLOCKED' })))
      .toThrow(/without naming the unmet dependency/);
    expect(storage.getTask('p1', 't1')?.state).toBe('FAILED');
    expect(() => storage.retryTask(retryInput({
      target: 'READY',
      dependencyReasons: [{ prerequisiteTaskId: 't2', requiredRevisionId: 'r2',
        code: 'UPSTREAM_NOT_INTEGRATED', detail: null }],
    }))).toThrow(/while an unmet dependency is still named/);
    expect(storage.getTask('p1', 't1')?.version).toBe(4);

    // A retry whose dependency verdict is unmet is recorded as BLOCKED — the only meaning `BLOCKED`
    // has — and the worktree is still handed back so the next start can reuse it.
    const blocked = storage.retryTask(retryInput({
      target: 'BLOCKED',
      dependencyReasons: [{ prerequisiteTaskId: 't2', requiredRevisionId: 'r2',
        code: 'UPSTREAM_NOT_INTEGRATED', detail: null }],
      taskEventId: 'evt-task-blocked', retryEventId: 'evt-retry-blocked',
    }));
    expect(blocked.state).toBe('BLOCKED');
    expect(db.query<{ state: string }, []>("SELECT state FROM workspaces WHERE id='w1'").get()?.state)
      .toBe('READY');
    expect(db.query<{ event_type: string; payload_json: string }, []>(
      "SELECT event_type,payload_json FROM domain_events WHERE event_type='TaskStateChanged'",
    ).get()?.payload_json).toMatch(/dependencies are unmet/);
  });

  test('does not hand back a worktree when the decision was to prepare a fresh one', () => {
    const fresh = storage.retryTask(retryInput({
      workspace: { mode: 'PREPARE_FRESH', workspaceId: null, evidence: 'workspace-missing:/work/t1' },
    }));
    expect(fresh.workspaceMode).toBe('PREPARE_FRESH');
    expect(db.query<{ state: string }, []>("SELECT state FROM workspaces WHERE id='w1'").get()?.state)
      .toBe('RETAINED');
  });

  test('refuses a verified reuse that names no workspace, and one that is no longer reusable', () => {
    const other = independentDatabase({
      state: 'FAILED', workspaceState: 'RETAINED', executionState: 'FAILED', archived: false,
    });
    expect(() => other.storage.retryTask(retryInput({
      workspace: { mode: 'REUSE_VERIFIED', workspaceId: null, evidence: null },
    }))).toThrow(/must name the workspace it verified/);
    expect(other.storage.getTask('p1', 't1')?.state).toBe('FAILED');
    other.storage.close();

    const reclaimed = independentDatabase({
      state: 'FAILED', workspaceState: 'RELEASED', executionState: 'FAILED', archived: false,
    });
    expect(() => reclaimed.storage.retryTask(retryInput()))
      .toThrow(/changed before it could be reused/);
    expect(reclaimed.storage.getTask('p1', 't1')?.state).toBe('FAILED');
    reclaimed.storage.close();
  });

  test('keeps the schema at version 23 with two added columns and no table of its own', () => {
    expect(phase1SchemaVersion).toBe(23);
    expect(db.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('executions')",
    ).all().map((row) => row.name)).toContain('retry_from_execution_id');
    expect(db.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('tasks')",
    ).all().map((row) => row.name)).toContain('pending_retry_from_execution_id');
    expect(db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%retry%'",
    ).all()).toEqual([]);
    expect(newerOid.length).toBe(40);
  });
});
