import { beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { Phase1Database, type TaskLatestExecutionSummary } from '../src/index.js';

/**
 * `TaskSummary.latestExecution`: the newest Execution attempt and the ending its Agent Session
 * recorded, projected onto `task list` / `task status` rows.
 *
 * What is pinned here is only that the projection restates recorded facts:
 *
 * - an attempt that never existed is `null`, not an invented attempt;
 * - a Session that is still `ACTIVE` reports no completion outcome;
 * - a SUCCESS completion leaves the Execution `RUNNING` and still holding its resource, so a list
 *   row can tell "the Agent already exited, the result is not captured yet" without a second read;
 * - a disconnect reason stored in the same `exit_json` column is not a completion outcome;
 * - the *newest* attempt wins even when an older attempt is the one that recorded a completion.
 *
 * It does not test any wording: the Runtime records facts and the clients phrase them.
 */

const oid = 'a'.repeat(40);
let storage: Phase1Database;
let db: Database;

/** One Task holding one ACTIVE Session inside one RUNNING Execution. */
function seed(): void {
  db.transaction(() => {
    db.query(`INSERT INTO projects
      (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
      VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','sha1',1)`).run();
    db.query(`INSERT INTO project_trusts
      (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
      VALUES ('trust1','p1','/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run();
    db.query(`INSERT INTO tasks
      (id,project_id,display_number,kind,current_revision_id,state,version,created_at,updated_at)
      VALUES ('t1','p1',1,'DEVELOPMENT','r1','RUNNING',4,2,2)`).run();
    db.query(`INSERT INTO task_revisions
      (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
      VALUES ('r1','t1',1,NULL,'Do work','[]','user','initial',2)`).run();
    db.query(`INSERT INTO workspaces
      (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
      VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1',?1,'IN_USE',3)`).run(oid);
    db.query(`INSERT INTO executions
      (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,adapter_id,
       adapter_version,state,resource_held,base_commit,version,started_at)
      VALUES ('e1','t1',1,'r1','r1','w1','pi','0.84.4','RUNNING',1,?1,0,4)`).run(oid);
    db.query(`INSERT INTO agent_sessions
      (id,execution_id,provider_session_id,capabilities_json,state,version,last_observed_at)
      VALUES ('s1','e1','provider-1','{}','ACTIVE',0,4)`).run();
  })();
}

/** A second attempt of the same Task, with its own Session. Only one is ever inserted here. */
function seedSecondAttempt(sessionState: string, exitJson: string | null): void {
  db.transaction(() => {
    db.query(`INSERT INTO executions
      (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,adapter_id,
       adapter_version,state,resource_held,base_commit,version,started_at)
      VALUES ('e2','t1',2,'r1','r1','w1','pi','0.84.4','RUNNING',1,?1,0,5)`).run(oid);
    db.query(`INSERT INTO agent_sessions
      (id,execution_id,provider_session_id,capabilities_json,state,version,last_observed_at,exit_json)
      VALUES ('s2','e2','provider-2','{}',?1,0,5,?2)`).run(sessionState, exitJson);
  })();
}

function completionInput(outcome: 'SUCCESS' | 'FAILURE' = 'SUCCESS') {
  return {
    sessionId: 's1',
    executionId: 'e1',
    providerEventId: 'provider-settled-1',
    cursor: 'cursor-1',
    outcome,
    evidence: { ref: 'quiescence', toolsQuiescent: true as const, ownedWritersStopped: true as const },
    ...(outcome === 'FAILURE' ? { failure: { code: 'AGENT_REPORTED_FAILURE', message: 'boom' } } : {}),
    sessionEventId: 'evt-session',
    executionEventId: 'evt-execution',
    taskEventId: 'evt-task',
    observedAt: 10,
  };
}

function latestFromList(): TaskLatestExecutionSummary | null | undefined {
  return storage.listTasks('p1').find((task) => task.id === 't1')?.latestExecution;
}

beforeEach(() => {
  storage = new Phase1Database();
  db = storage.sqlite;
  seed();
});

describe('latestExecution', () => {
  test('is null for a Task that never started an attempt', () => {
    db.query("UPDATE tasks SET state='DRAFT' WHERE id='t1'").run();
    db.query("DELETE FROM agent_sessions WHERE id='s1'").run();
    db.query("DELETE FROM executions WHERE id='e1'").run();
    expect(latestFromList()).toBeNull();
    expect(storage.getTask('p1', 't1')?.latestExecution).toBeNull();
  });

  test('reports the running attempt while the Session is still ACTIVE', () => {
    expect(latestFromList()).toEqual({
      executionId: 'e1',
      attemptNumber: 1,
      state: 'RUNNING',
      resourceHeld: true,
      sessionState: 'ACTIVE',
      completionOutcome: null,
    });
  });

  test('a SUCCESS completion reports the outcome while the attempt still holds its resource', () => {
    storage.recordAgentCompleted(completionInput('SUCCESS'));
    expect(latestFromList()).toEqual({
      executionId: 'e1',
      attemptNumber: 1,
      state: 'RUNNING',
      resourceHeld: true,
      sessionState: 'EXITED',
      completionOutcome: 'SUCCESS',
    });
    // Session exit is not a Task transition: the result is still uncaptured.
    expect(storage.getTask('p1', 't1')?.state).toBe('RUNNING');
  });

  test('a FAILURE completion reports the outcome and the Execution it ended', () => {
    storage.recordAgentCompleted(completionInput('FAILURE'));
    expect(latestFromList()).toEqual({
      executionId: 'e1',
      attemptNumber: 1,
      state: 'FAILED',
      resourceHeld: false,
      sessionState: 'EXITED',
      completionOutcome: 'FAILURE',
    });
  });

  test('a disconnect reason in exit_json is not a completion outcome', () => {
    storage.recordAgentDisconnected({
      sessionId: 's1', executionId: 'e1', providerEventId: 'provider-disconnect-1',
      cursor: 'cursor-2', reason: 'transport closed', sessionEventId: 'evt-session',
      executionEventId: 'evt-execution', taskEventId: 'evt-task', observedAt: 11,
    });
    expect(latestFromList()).toEqual({
      executionId: 'e1',
      attemptNumber: 1,
      state: 'RECOVERY_REQUIRED',
      resourceHeld: true,
      sessionState: 'DISCONNECTED',
      completionOutcome: null,
    });
  });

  test('the newest attempt wins over an older attempt that recorded a completion', () => {
    storage.recordAgentCompleted(completionInput('SUCCESS'));
    // The captured attempt is terminal and released, which is what allows a later attempt to hold
    // the Task's single reserved slot (`one_held_execution`).
    db.query(`UPDATE executions SET state='SUCCEEDED',resource_held=0,result_commit=?1
      WHERE id='e1'`).run(oid);
    seedSecondAttempt('ACTIVE', null);
    expect(latestFromList()).toEqual({
      executionId: 'e2',
      attemptNumber: 2,
      state: 'RUNNING',
      resourceHeld: true,
      sessionState: 'ACTIVE',
      completionOutcome: null,
    });
  });

  test('listTasks and getTask project the same facts', () => {
    storage.recordAgentCompleted(completionInput('SUCCESS'));
    expect(storage.getTask('p1', 't1')?.latestExecution).toEqual(latestFromList());
  });

  test('archived Tasks keep the projection', () => {
    // Archive state is set directly: `task archive` refusing a RUNNING Task is its own rule and is
    // covered elsewhere. What matters here is that the join does not depend on archive state.
    db.query("UPDATE tasks SET archived_at=20 WHERE id='t1'").run();
    expect(storage.listTasks('p1')).toHaveLength(0);
    expect(storage.listTasks('p1', { includeArchived: true }).find((task) => task.id === 't1')
      ?.latestExecution).toEqual({
      executionId: 'e1',
      attemptNumber: 1,
      state: 'RUNNING',
      resourceHeld: true,
      sessionState: 'ACTIVE',
      completionOutcome: null,
    });
  });
});
