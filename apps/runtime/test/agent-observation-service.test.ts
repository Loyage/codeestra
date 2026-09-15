import { afterEach, describe, expect, test } from 'bun:test';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import type { AgentCompletionFacts } from '@codeestra/contracts';
import {
  PROSE_QUESTION_NO_TOOL_USE,
  noToolCallsWithTrailingQuestionMarkHeuristic,
} from '@codeestra/domain';
import { observeAgentEvents } from '../src/agent-observation-service.js';
import { deliverAgentAnswer } from '../src/agent-answer-service.js';
import { startReservedExecution } from '../src/agent-start-service.js';
import { prepareTaskWorkspace } from '../src/workspace-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  type AgentFixture,
} from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

const facts = (overrides: Partial<AgentCompletionFacts> = {}): AgentCompletionFacts => ({
  toolCallCount: 0,
  finalAssistantText: 'Which package manager should I use?',
  finalAssistantTextTruncated: false,
  finalAssistantStopReason: 'stop',
  ...overrides,
});

/**
 * One started Session for the fixture Task, drained by the caller. It exercises the real storage
 * projection and the real Adapter contract; only the Agent itself is a deterministic fake.
 */
async function startSession(value: AgentFixture, adapter: DeterministicFakeAdapter): Promise<{
  readonly executionId: string;
  readonly sessionId: string;
}> {
  const workspace = await prepareTaskWorkspace({
    storage: value.storage, runtimeHome: value.home, commandId: crypto.randomUUID(),
    projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
  });
  const execution = value.storage.reserveExecution({
    projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
    workspaceId: workspace.workspaceId, executionId: crypto.randomUUID(),
    commandId: crypto.randomUUID(), payloadHash: 'reserve', reservationEventId: crypto.randomUUID(),
    taskEventId: crypto.randomUUID(), adapterId: adapter.id, adapterVersion: 'fake-1',
    actor: 'test', createdAt: Date.now(),
  });
  const started = await startReservedExecution({
    storage: value.storage, adapter, projectId: value.projectId,
    executionId: execution.executionId, expectedExecutionVersion: 0,
    prepareCommandId: crypto.randomUUID(), startCommandId: crypto.randomUUID(),
  });
  return { executionId: execution.executionId, sessionId: started.sessionId };
}

function completionOf(value: AgentFixture, executionId: string) {
  const execution = value.storage
    .listTaskExecutions(value.projectId, value.taskId)
    .find((candidate) => candidate.executionId === executionId);
  if (execution === undefined) throw new Error('Execution was not found');
  return execution.session?.completion ?? null;
}

function completionEvents(value: AgentFixture) {
  return value.storage.listEventsAfter({ sinceSequence: 0, limit: 500,
    projectId: value.projectId })
    .filter((event) => event.eventType === 'AgentSessionCompleted');
}

function fakeWith(factsValue: AgentCompletionFacts | undefined): DeterministicFakeAdapter {
  return new DeterministicFakeAdapter('SUCCEED', [{
    type: 'completed', eventId: 'fake-settled-1', cursor: 'cursor-1', outcome: 'SUCCESS',
    evidenceRef: 'fake-quiescence',
    ...(factsValue === undefined ? {} : { facts: factsValue }),
  }]);
}

describe('Agent completion notes', () => {
  test('records the note and, by default, the wait it stands for', async () => {
    const value = await createAgentFixture();
    const adapter = fakeWith(facts());
    try {
      const session = await startSession(value, adapter);
      // No mode is passed: the product default (`auto`) is what a Runtime without an explicit
      // setting uses, so this is the behaviour a user meets (FOUNDATION-069).
      const results = await observeAgentEvents({ storage: value.storage, adapter,
        sessionId: session.sessionId });

      // The completion itself is still a SUCCESS: this lane annotates, it does not re-classify.
      expect(results.map((result) => [result.duplicate, result.sessionState,
        result.executionState])).toEqual([[false, 'EXITED', 'RUNNING']]);
      const completion = completionOf(value, session.executionId);
      expect(completion).toMatchObject({
        outcome: 'SUCCESS',
        evidenceRef: 'fake-quiescence',
        failure: null,
        note: {
          code: PROSE_QUESTION_NO_TOOL_USE,
          heuristic: noToolCallsWithTrailingQuestionMarkHeuristic,
        },
      });
      // The note carries the provider facts it was applied to, so it can be re-checked.
      expect(completion?.facts).toEqual(facts());
      expect(completion?.note?.facts).toEqual(facts());
      expect(completion?.note?.message).toContain('heuristic');
      // The note also becomes exactly one wait: the Task waits, and the Attention is the note
      // restated. The provider process is gone, so the Session stays EXITED and the Execution is
      // untouched — this is a wait for a human, not a pretend live conversation.
      const attentions = value.storage.listAttentionRequests(value.projectId);
      expect(attentions).toHaveLength(1);
      expect(attentions[0]).toMatchObject({ kind: 'QUESTION', status: 'OPEN',
        providerRequestId: 'codeestra-prose-question:fake-settled-1', taskId: value.taskId });
      expect(attentions[0]?.prompt).toMatchObject({ kind: 'codeestra.prose-question',
        code: PROSE_QUESTION_NO_TOOL_USE, text: 'Which package manager should I use?' });
      expect(results[0]?.attentionId).toBe(attentions[0]?.id);
      expect(value.storage.listTaskExecutions(value.projectId, value.taskId)[0]?.session?.state)
        .toBe('EXITED');
      expect(value.storage.listTaskExecutions(value.projectId, value.taskId)[0]?.state)
        .toBe('RUNNING');
      expect(value.storage.listTasks(value.projectId)[0]?.state).toBe('WAITING_FOR_USER');
      // And the append-only log says the same thing: the completion, the Attention, the wait.
      const events = value.storage.listEventsAfter({ sinceSequence: 0, limit: 500,
        projectId: value.projectId });
      const completed = events.filter((event) => event.eventType === 'AgentSessionCompleted');
      expect(completed).toHaveLength(1);
      expect(completed[0]?.payload).toMatchObject({
        outcome: 'SUCCESS',
        note: { code: PROSE_QUESTION_NO_TOOL_USE },
      });
      expect(events.filter((event) => event.eventType === 'UserAttentionRequested')).toHaveLength(1);
      expect(events.filter((event) => event.eventType === 'TaskStateChanged'
        && (event.payload as { to?: string }).to === 'WAITING_FOR_USER')).toHaveLength(1);
    } finally {
      value.storage.close();
    }
  });

  test('records the note alone when escalation is explicitly downgraded to record-only', async () => {
    const value = await createAgentFixture();
    const adapter = fakeWith(facts());
    try {
      const session = await startSession(value, adapter);
      // FOUNDATION-056's behaviour, now reachable as an explicit setting: annotate, change nothing.
      await observeAgentEvents({ storage: value.storage, adapter, sessionId: session.sessionId,
        proseQuestionAttentionMode: 'record-only' });

      expect(completionOf(value, session.executionId)?.note?.code).toBe(PROSE_QUESTION_NO_TOOL_USE);
      expect(value.storage.listAttentionRequests(value.projectId)).toEqual([]);
      expect(value.storage.listTasks(value.projectId)[0]?.state).toBe('RUNNING');
      expect(value.storage.listEventsAfter({ sinceSequence: 0, limit: 500,
        projectId: value.projectId }).filter((event) => event.eventType === 'UserAttentionRequested'))
        .toHaveLength(0);
    } finally {
      value.storage.close();
    }
  });

  test('records nothing at all when escalation is switched off', async () => {
    const value = await createAgentFixture();
    const adapter = fakeWith(facts());
    try {
      const session = await startSession(value, adapter);
      await observeAgentEvents({ storage: value.storage, adapter, sessionId: session.sessionId,
        proseQuestionAttentionMode: 'off' });

      // `off` is the strictly smaller recording: no note, no wait, but the facts stay observable.
      const completion = completionOf(value, session.executionId);
      expect(completion?.outcome).toBe('SUCCESS');
      expect(completion?.facts).toEqual(facts());
      expect(completion?.note).toBeNull();
      expect(value.storage.listAttentionRequests(value.projectId)).toEqual([]);
      expect(value.storage.listTasks(value.projectId)[0]?.state).toBe('RUNNING');
    } finally {
      value.storage.close();
    }
  });

  test('leaves an ordinary completion unexplained only when nothing needed saying', async () => {
    const value = await createAgentFixture();
    // A run that used tools and ended with a summary: the note must not fire, but the provider
    // facts are still recorded so a reader can see why.
    const adapter = fakeWith(facts({
      toolCallCount: 2, finalAssistantText: 'Wrote the file. Want me to also update the README?' }));
    try {
      const session = await startSession(value, adapter);
      await observeAgentEvents({ storage: value.storage, adapter,
        sessionId: session.sessionId });
      const completion = completionOf(value, session.executionId);
      expect(completion?.outcome).toBe('SUCCESS');
      expect(completion?.note).toBeNull();
      expect(completion?.facts?.toolCallCount).toBe(2);
      expect(completionEvents(value)[0]?.payload).not.toHaveProperty('note');
    } finally {
      value.storage.close();
    }
  });

  test('records no note when the Adapter reports no facts at all', async () => {
    const value = await createAgentFixture();
    const adapter = fakeWith(undefined);
    try {
      const session = await startSession(value, adapter);
      await observeAgentEvents({ storage: value.storage, adapter, sessionId: session.sessionId });
      const completion = completionOf(value, session.executionId);
      // An Adapter that cannot report facts is a missing observation, not evidence of "no tool use".
      expect(completion?.outcome).toBe('SUCCESS');
      expect(completion?.facts).toBeNull();
      expect(completion?.note).toBeNull();
    } finally {
      value.storage.close();
    }
  });

  test('never annotates the structured question channel a second time', async () => {
    const value = await createAgentFixture();
    // The real structured path: one QUESTION Attention, answered before the run continues. The
    // question itself is a tool call, so the heuristic must not annotate the same ending again.
    const adapter = new DeterministicFakeAdapter('SUCCEED', [
      { type: 'attention', eventId: 'fake-question-1', cursor: 'cursor-1',
        providerRequestId: 'fake-request-1', kind: 'QUESTION', responseType: 'VALUE',
        prompt: { method: 'select', title: 'Which package manager should I use?' } },
      { type: 'completed', eventId: 'fake-settled-1', cursor: 'cursor-2', outcome: 'SUCCESS',
        evidenceRef: 'fake-quiescence',
        facts: facts({ toolCallCount: 1, finalAssistantText: 'Ready to continue?' }) },
    ]);
    try {
      const session = await startSession(value, adapter);
      const delivered: string[] = [];
      await observeAgentEvents({
        storage: value.storage, adapter, sessionId: session.sessionId,
        // The answer is delivered inside the observation loop, exactly like the Runtime pump does.
        onProjected: async (result) => {
          if (result.attentionId === undefined) return;
          const planned = value.storage.planAttentionAnswer({
            projectId: value.projectId, attentionId: result.attentionId,
            commandId: crypto.randomUUID(), payloadHash: 'question:bun',
            intentId: crypto.randomUUID(), answerId: crypto.randomUUID(),
            operationId: crypto.randomUUID(), answer: { type: 'VALUE', value: 'bun' },
            intentEventId: crypto.randomUUID(), recordedEventId: crypto.randomUUID(),
            actor: 'local-user', recordedAt: Date.now(),
          });
          const deliveredPlan = await deliverAgentAnswer({ storage: value.storage, adapter,
            operationId: planned.operationId });
          delivered.push(deliveredPlan.status);
        },
      });
      // The question stayed on its own channel: one Attention, answered, no note anywhere.
      const attentions = value.storage.listAttentionRequests(value.projectId);
      expect(attentions).toHaveLength(1);
      expect(delivered).toEqual(['DELIVERED']);
      const completion = completionOf(value, session.executionId);
      expect(completion?.outcome).toBe('SUCCESS');
      expect(completion?.facts?.toolCallCount).toBe(1);
      expect(completion?.note).toBeNull();
    } finally {
      value.storage.close();
    }
  });

  test('adds no note to a failure, which already explains itself', async () => {
    const value = await createAgentFixture();
    const adapter = new DeterministicFakeAdapter('SUCCEED', [{
      type: 'completed', eventId: 'fake-settled-1', cursor: 'cursor-1', outcome: 'FAILURE',
      evidenceRef: 'fake-quiescence', facts: facts(),
      failure: { code: 'PROVIDER_TURN_FAILED', message: 'error: usage limit reached' },
    }]);
    try {
      const session = await startSession(value, adapter);
      await observeAgentEvents({ storage: value.storage, adapter, sessionId: session.sessionId });
      const completion = completionOf(value, session.executionId);
      expect(completion?.outcome).toBe('FAILURE');
      expect(completion?.failure?.code).toBe('PROVIDER_TURN_FAILED');
      expect(completion?.note).toBeNull();
      expect(value.storage.listTaskExecutions(value.projectId, value.taskId)[0]?.state)
        .toBe('FAILED');
    } finally {
      value.storage.close();
    }
  });

  test('reports no completion for an exit payload that is not a completion', async () => {
    const value = await createAgentFixture();
    // A lost provider transport writes its own reason into the same column; reading it as a
    // completion (or as an annotation) would invent a fact the Runtime never recorded.
    const adapter = new DeterministicFakeAdapter('SUCCEED', [{
      type: 'disconnected', eventId: 'fake-lost-1', cursor: 'cursor-1',
      reason: 'the provider process disappeared',
    }]);
    try {
      const session = await startSession(value, adapter);
      await observeAgentEvents({ storage: value.storage, adapter, sessionId: session.sessionId });
      const execution = value.storage.listTaskExecutions(value.projectId, value.taskId)[0];
      expect(execution?.session?.state).toBe('DISCONNECTED');
      expect(execution?.session?.completion).toBeNull();
    } finally {
      value.storage.close();
    }
  });

  test('records the note once when the same completion event is replayed', async () => {
    const value = await createAgentFixture();
    const adapter = fakeWith(facts());
    try {
      const session = await startSession(value, adapter);
      await observeAgentEvents({ storage: value.storage, adapter, sessionId: session.sessionId });
      const note = completionOf(value, session.executionId)?.note;
      const input = {
        sessionId: session.sessionId,
        executionId: session.executionId,
        providerEventId: 'fake-settled-1',
        cursor: 'cursor-1',
        outcome: 'SUCCESS' as const,
        evidence: { ref: 'fake-quiescence', toolsQuiescent: true as const,
          ownedWritersStopped: true as const },
        facts: facts(),
        ...(note === null || note === undefined ? {} : { note }),
        sessionEventId: crypto.randomUUID(),
        executionEventId: crypto.randomUUID(),
        taskEventId: crypto.randomUUID(),
        observedAt: Date.now(),
      };
      // A cursor/event that was already projected is answered as a duplicate instead of being
      // recorded twice, so the note — and the wait it stands for — can never be duplicated by a
      // replay either.
      const replayed = value.storage.recordAgentCompleted(input);
      expect(replayed.duplicate).toBe(true);
      expect(value.storage.sqlite.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM adapter_events WHERE event_type='completed'").get()?.count)
        .toBe(1);
      expect(completionEvents(value)).toHaveLength(1);
      expect(completionOf(value, session.executionId)?.note?.code).toBe(PROSE_QUESTION_NO_TOOL_USE);
      expect(value.storage.listAttentionRequests(value.projectId)).toHaveLength(1);
    } finally {
      value.storage.close();
    }
  });
});
