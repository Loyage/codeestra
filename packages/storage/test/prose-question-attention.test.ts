import { beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import {
  buildProseQuestionPrompt,
  classifyAgentCompletion,
  proseQuestionProviderRequestId,
  type AgentCompletionFacts,
  type AgentCompletionNote,
} from '@codeestra/domain';
import { Phase1Database, StorageError } from '../src/index.js';

/**
 * The storage facts of a prose-question wait (FOUNDATION-069 / ADR-0043).
 *
 * What is pinned here is that the wait and the completion are one transaction, that the wait is
 * idempotent per provider event and the resolution idempotent per command, that a refusal writes
 * nothing at all, and that the Task is the only aggregate that enters `WAITING_FOR_USER` — the
 * provider really did exit, so no Session state is invented for it.
 */

const oid = 'a'.repeat(40);

const facts = (overrides: Partial<AgentCompletionFacts> = {}): AgentCompletionFacts => ({
  toolCallCount: 0,
  finalAssistantText: 'Which package manager should I use?',
  finalAssistantTextTruncated: false,
  finalAssistantStopReason: 'stop',
  ...overrides,
});

function note(): AgentCompletionNote {
  const produced = classifyAgentCompletion(facts());
  if (produced === null) throw new Error('the fixture must produce a note');
  return produced;
}

let storage: Phase1Database;
let db: Database;

/** One Task holding one ACTIVE Session inside one RUNNING Execution. */
function seed(options: { readonly taskState?: string } = {}): void {
  db.transaction(() => {
    db.query(`INSERT INTO projects
      (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
      VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','sha1',1)`).run();
    db.query(`INSERT INTO project_trusts
      (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
      VALUES ('trust1','p1','/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run();
    db.query(`INSERT INTO tasks
      (id,project_id,display_number,kind,current_revision_id,state,version,created_at,updated_at)
      VALUES ('t1','p1',1,'DEVELOPMENT','r1',?1,4,2,2)`).run(options.taskState ?? 'RUNNING');
    db.query(`INSERT INTO task_revisions
      (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
      VALUES ('r1','t1',1,NULL,'Ask me something','[]','user','initial',2)`).run();
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

function completionInput(overrides: {
  readonly proseQuestion?: NonNullable<
    Parameters<Phase1Database['recordAgentCompleted']>[0]['proseQuestion']>;
} = {}) {
  return {
    sessionId: 's1',
    executionId: 'e1',
    providerEventId: 'provider-settled-1',
    cursor: 'cursor-1',
    outcome: 'SUCCESS' as const,
    evidence: { ref: 'quiescence', toolsQuiescent: true as const, ownedWritersStopped: true as const },
    facts: facts(),
    note: note(),
    ...(overrides.proseQuestion === undefined ? {} : { proseQuestion: overrides.proseQuestion }),
    sessionEventId: 'evt-session',
    executionEventId: 'evt-execution',
    taskEventId: 'evt-task',
    observedAt: 10,
  };
}

function escalation() {
  return {
    attentionId: 'a1',
    attentionEventId: 'evt-attention',
    taskEventId: 'evt-wait',
    providerRequestId: proseQuestionProviderRequestId('provider-settled-1'),
    prompt: buildProseQuestionPrompt(note()),
  };
}

function resolveInput(overrides: Partial<Parameters<Phase1Database['resolveProseQuestionAttention']>[0]> = {}) {
  return {
    projectId: 'p1',
    attentionId: 'a1',
    commandId: 'cmd-resolve-1',
    payloadHash: 'payload-1',
    resolution: 'DISMISSED_FALSE_POSITIVE' as const,
    text: null,
    note: null,
    actor: 'local-user',
    answerId: 'answer-1',
    resolutionEventId: 'evt-resolved',
    taskEventId: 'evt-resumed',
    resolvedAt: 20,
    ...overrides,
  };
}

function events() {
  return storage.listEventsAfter({ sinceSequence: 0, limit: 200, projectId: 'p1' });
}

function count(table: string): number {
  return db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? -1;
}

/** Runs the completion projection, escalating by default. */
function completeWithWait() {
  return storage.recordAgentCompleted(completionInput({ proseQuestion: escalation() }));
}

beforeEach(() => {
  storage = new Phase1Database();
  db = storage.sqlite;
  seed();
});

describe('prose question waits', () => {
  test('records the wait inside the completion transaction, on the Task only', () => {
    const result = completeWithWait();

    expect(result).toMatchObject({
      duplicate: false, sessionState: 'EXITED', executionState: 'RUNNING', attentionId: 'a1',
    });
    // The provider is gone and the Execution still holds the workspace; only the Task waits.
    expect(db.query<{ state: string }, []>("SELECT state FROM agent_sessions WHERE id='s1'").get()?.state)
      .toBe('EXITED');
    expect(db.query<{ state: string; resource_held: number }, []>(
      "SELECT state,resource_held FROM executions WHERE id='e1'").get())
      .toMatchObject({ state: 'RUNNING', resource_held: 1 });
    expect(db.query<{ state: string }, []>("SELECT state FROM tasks WHERE id='t1'").get()?.state)
      .toBe('WAITING_FOR_USER');
    // Revision semantics are untouched: no revision is created by a wait.
    expect(count('task_revisions')).toBe(1);

    const attention = storage.listAttentionRequests('p1');
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({
      id: 'a1', kind: 'QUESTION', status: 'OPEN', responseType: 'VALUE',
      providerRequestId: 'codeestra-prose-question:provider-settled-1',
      executionId: 'e1', sessionId: 's1', taskId: 't1',
    });
    // The prompt is the note restated, so a reader sees it came from a heuristic, not from intent.
    expect(attention[0]?.prompt).toMatchObject({
      kind: 'codeestra.prose-question', code: 'PROSE_QUESTION_NO_TOOL_USE',
      text: 'Which package manager should I use?',
    });

    const types = events().map((event) => event.eventType);
    expect(types.filter((type) => type === 'AgentSessionCompleted')).toHaveLength(1);
    expect(types.filter((type) => type === 'UserAttentionRequested')).toHaveLength(1);
    expect(types.filter((type) => type === 'TaskStateChanged')).toHaveLength(1);
    const requested = events().find((event) => event.eventType === 'UserAttentionRequested');
    expect(requested?.payload).toMatchObject({ attentionId: 'a1', proseQuestion: true, kind: 'QUESTION' });
    const changed = events().find((event) => event.eventType === 'TaskStateChanged');
    expect(changed?.payload).toMatchObject({
      taskId: 't1', from: 'RUNNING', to: 'WAITING_FOR_USER',
    });
    // The completion keeps its note: the wait explains the SUCCESS, it does not replace the fact.
    const completed = events().find((event) => event.eventType === 'AgentSessionCompleted');
    expect(completed?.payload).toMatchObject({ outcome: 'SUCCESS',
      note: { code: 'PROSE_QUESTION_NO_TOOL_USE' } });
  });

  test('records the same completion without a wait, and never a second Attention, on replay', () => {
    completeWithWait();
    const replayed = storage.recordAgentCompleted(completionInput({ proseQuestion: escalation() }));

    expect(replayed.duplicate).toBe(true);
    expect(count('adapter_events')).toBe(1);
    expect(count('attention_requests')).toBe(1);
    expect(events().filter((event) => event.eventType === 'UserAttentionRequested')).toHaveLength(1);
    expect(db.query<{ version: number }, []>("SELECT version FROM tasks WHERE id='t1'").get()?.version)
      .toBe(5);
  });

  test('skips the wait when the Task is not RUNNING instead of failing the completion', () => {
    storage = new Phase1Database();
    db = storage.sqlite;
    seed({ taskState: 'PAUSING' });

    // The note is still recorded — the completion has to be observable either way — but a Task the
    // user is already stopping must not gain a wait nobody could act on.
    const result = storage.recordAgentCompleted(completionInput({ proseQuestion: escalation() }));
    expect(result).toMatchObject({ duplicate: false, sessionState: 'EXITED' });
    expect(result.attentionId).toBeUndefined();
    expect(storage.listAttentionRequests('p1')).toEqual([]);
    expect(db.query<{ state: string }, []>("SELECT state FROM tasks WHERE id='t1'").get()?.state)
      .toBe('PAUSING');
    expect(events().find((event) => event.eventType === 'AgentSessionCompleted')?.payload)
      .toMatchObject({ note: { code: 'PROSE_QUESTION_NO_TOOL_USE' } });
    expect(events().filter((event) => event.eventType === 'UserAttentionRequested')).toHaveLength(0);
  });

  test('refuses to deliver an answer to a prose question, writing nothing', () => {
    completeWithWait();

    let refusal: unknown = null;
    try {
      storage.planAttentionAnswer({
        projectId: 'p1', attentionId: 'a1', commandId: 'cmd-answer', payloadHash: 'answer-payload',
        intentId: 'intent-1', answerId: 'answer-x', operationId: 'op-1',
        answer: { type: 'VALUE', value: 'bun' },
        intentEventId: 'evt-intent', recordedEventId: 'evt-answer',
        actor: 'local-user', recordedAt: 30,
      });
    } catch (error) { refusal = error; }

    expect(refusal).toBeInstanceOf(StorageError);
    expect((refusal as StorageError).code).toBe('PROSE_QUESTION_RESOLUTION_REQUIRED');
    // Zero writes: no answer, no Operation, no receipt, and the wait is still open.
    expect(count('attention_answers')).toBe(0);
    expect(count('operations')).toBe(0);
    expect(count('command_receipts')).toBe(0);
    expect(storage.getAttentionRequest('p1', 'a1')?.status).toBe('OPEN');
  });

  test('dismissing a false alarm closes the wait and returns the Task, leaving the provider alone', () => {
    completeWithWait();
    const result = storage.resolveProseQuestionAttention(resolveInput());

    expect(result).toEqual({
      attentionId: 'a1', projectId: 'p1', taskId: 't1', executionId: 'e1', sessionId: 's1',
      resolution: 'DISMISSED_FALSE_POSITIVE', answerText: null, note: null, actor: 'local-user',
      taskState: 'RUNNING', executionState: 'RUNNING', sessionState: 'EXITED',
      attentionStatus: 'CLOSED', deliveredToProvider: false, resolvedAt: 20,
    });
    expect(storage.getAttentionRequest('p1', 'a1')?.status).toBe('CLOSED');
    expect(db.query<{ state: string; version: number }, []>(
      "SELECT state,version FROM tasks WHERE id='t1'").get()).toMatchObject({ state: 'RUNNING', version: 6 });
    // The provider process really exited, so nothing claims it is live again.
    expect(db.query<{ state: string }, []>("SELECT state FROM agent_sessions WHERE id='s1'").get()?.state)
      .toBe('EXITED');
    expect(db.query<{ state: string }, []>("SELECT state FROM executions WHERE id='e1'").get()?.state)
      .toBe('RUNNING');

    const resolved = events().find((event) => event.eventType === 'ProseQuestionAttentionResolved');
    expect(resolved?.payload).toMatchObject({
      attentionId: 'a1', resolution: 'DISMISSED_FALSE_POSITIVE', answerText: null,
      deliveredToProvider: false, attentionStatus: 'CLOSED',
    });
    expect(events().find((event) => event.eventType === 'TaskStateChanged'
      && (event.payload as { to?: string }).to === 'RUNNING')?.payload).toMatchObject({
      taskId: 't1', from: 'WAITING_FOR_USER', to: 'RUNNING',
    });
    // The user's input is kept in the attention answer ledger with its actor.
    const answer = db.query<{ actor: string; answer_json: string }, []>(
      "SELECT actor,answer_json FROM attention_answers WHERE request_id='a1'").get();
    expect(answer?.actor).toBe('local-user');
    expect(JSON.parse(answer?.answer_json ?? 'null')).toMatchObject({
      resolution: 'DISMISSED_FALSE_POSITIVE', text: null, note: null,
    });
  });

  test('records an answer as an audit fact without delivering it anywhere', () => {
    completeWithWait();
    const result = storage.resolveProseQuestionAttention(resolveInput({
      commandId: 'cmd-resolve-answer', payloadHash: 'payload-answer', answerId: 'answer-2',
      resolution: 'ANSWERED', text: 'Use bun, and keep it in devDependencies.', note: 'from the user',
    }));

    expect(result).toMatchObject({
      resolution: 'ANSWERED', answerText: 'Use bun, and keep it in devDependencies.',
      note: 'from the user', deliveredToProvider: false, taskState: 'RUNNING',
    });
    // No ANSWER_AGENT intent and no Operation: nothing was sent, so nothing claims a delivery.
    expect(count('intents')).toBe(0);
    expect(count('operations')).toBe(0);
    expect(events().find((event) => event.eventType === 'ProseQuestionAttentionResolved')?.payload)
      .toMatchObject({ resolution: 'ANSWERED',
        answerText: 'Use bun, and keep it in devDependencies.', deliveredToProvider: false });
  });

  test('resolving the same command twice records the wait outcome exactly once', () => {
    completeWithWait();
    const first = storage.resolveProseQuestionAttention(resolveInput());
    const second = storage.resolveProseQuestionAttention(resolveInput());

    expect(second).toEqual(first);
    expect(count('attention_answers')).toBe(1);
    expect(count('command_receipts')).toBe(1);
    expect(events().filter((event) => event.eventType === 'ProseQuestionAttentionResolved'))
      .toHaveLength(1);
    expect(db.query<{ version: number }, []>("SELECT version FROM tasks WHERE id='t1'").get()?.version)
      .toBe(6);
  });

  test('refuses every resolution that does not match the recorded wait, writing nothing', () => {
    completeWithWait();
    // A second, provider-dialog Attention on the same Session: the route is decided by what the
    // Attention is, so a questionnaire wait can never be ended through the prose-question command.
    db.query(`INSERT INTO attention_requests
      (id,session_id,provider_request_id,kind,prompt_json,status,created_at,response_type)
      VALUES ('ax','s1','req-x','QUESTION',?1,'OPEN',11,'VALUE')`)
      .run(JSON.stringify({ kind: 'codeestra.questionnaire', version: 1,
        questionnaire: { questions: [{ question: 'Which package manager?', header: 'Manager',
          multiSelect: false, options: [{ label: 'bun', description: 'Bun' },
            { label: 'npm', description: 'npm' }] }] } }));
    storage.resolveProseQuestionAttention(resolveInput());

    const refusals: readonly (readonly [StorageError['code'], Partial<Parameters<
      Phase1Database['resolveProseQuestionAttention']>[0]>])[] = [
      ['PROSE_QUESTION_ATTENTION_ALREADY_RESOLVED',
        { commandId: 'cmd-again', payloadHash: 'payload-again' }],
      ['PROSE_QUESTION_ATTENTION_NOT_PROSE_QUESTION',
        { attentionId: 'ax', commandId: 'cmd-questionnaire', payloadHash: 'p-questionnaire' }],
      ['PROSE_QUESTION_INVALID_RESOLUTION_PAYLOAD',
        { commandId: 'cmd-empty', payloadHash: 'p-empty', resolution: 'ANSWERED', text: '   ' }],
    ];
    for (const [expected, override] of refusals) {
      let refusal: unknown = null;
      try { storage.resolveProseQuestionAttention(resolveInput(override)); } catch (error) { refusal = error; }
      expect((refusal as StorageError | null)?.code).toBe(expected);
    }
    // Refusals leave the ledger and the receipts alone, and the closed wait stays closed.
    expect(count('attention_answers')).toBe(1);
    expect(count('command_receipts')).toBe(1);
    expect(storage.getAttentionRequest('p1', 'a1')?.status).toBe('CLOSED');
    expect(storage.getAttentionRequest('p1', 'ax')?.status).toBe('OPEN');
  });

  test('refuses to resolve a wait whose Task is not waiting', () => {
    completeWithWait();
    db.query("UPDATE tasks SET state='RUNNING' WHERE id='t1'").run();

    let refusal: unknown = null;
    try { storage.resolveProseQuestionAttention(resolveInput()); } catch (error) { refusal = error; }
    expect((refusal as StorageError | null)?.code).toBe('PROSE_QUESTION_TASK_NOT_WAITING');
    expect(count('attention_answers')).toBe(0);
    expect(storage.getAttentionRequest('p1', 'a1')?.status).toBe('OPEN');
  });

  test('refuses to resolve a wait while the provider Session is still alive', () => {
    completeWithWait();
    db.query("UPDATE agent_sessions SET state='WAITING_FOR_USER' WHERE id='s1'").run();

    let refusal: unknown = null;
    try { storage.resolveProseQuestionAttention(resolveInput()); } catch (error) { refusal = error; }
    expect((refusal as StorageError | null)?.code).toBe('PROSE_QUESTION_SESSION_NOT_EXITED');
    expect(count('attention_answers')).toBe(0);
  });

  test('never claims a terminal Task came back to life', () => {
    completeWithWait();
    db.query("UPDATE tasks SET state='CANCELLED' WHERE id='t1'").run();

    let refusal: unknown = null;
    try { storage.resolveProseQuestionAttention(resolveInput()); } catch (error) { refusal = error; }
    expect((refusal as StorageError | null)?.code).toBe('PROSE_QUESTION_TASK_NOT_WAITING');
    expect(db.query<{ state: string }, []>("SELECT state FROM tasks WHERE id='t1'").get()?.state)
      .toBe('CANCELLED');
  });
});
