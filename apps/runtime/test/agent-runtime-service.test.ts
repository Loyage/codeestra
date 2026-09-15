import { afterEach, describe, expect, test } from 'bun:test';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import type {
  AdapterCapabilities,
  AgentAnswerAdapter,
  AgentAnswerRequest,
  AgentControlReceipt,
  AgentObservedEvent,
  AgentProcessRelease,
  AgentSessionRef,
  AgentStartRequest,
} from '@codeestra/contracts';
import { prepareTaskWorkspace } from '../src/workspace-service.js';
import { observeAgentEvents } from '../src/agent-observation-service.js';
import { startReservedExecution } from '../src/agent-start-service.js';
import {
  AgentRuntimeCoordinator,
  deriveCommandId,
} from '../src/agent-runtime-service.js';
import { AdapterRegistry } from '../src/adapter-registry.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  waitFor,
  type AgentFixture,
} from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

const capabilities: AdapterCapabilities = Object.freeze({
  persistentSession: 'SUPPORTED',
  structuredAttention: 'SUPPORTED',
  nativePermissionRouting: 'SUPPORTED',
  pauseWithQuiescence: 'UNSUPPORTED',
  revisionAcknowledgement: 'UNSUPPORTED',
  cooperativeStop: 'SUPPORTED',
  attach: 'STRUCTURED',
  nativeTerminalHandoff: 'UNSUPPORTED',
  safePointNotification: 'UNSUPPORTED',
  reconnectToLiveSession: 'UNSUPPORTED',
  resumeAfterExit: 'UNSUPPORTED',
  controlledConfiguration: 'SUPPORTED',
});

class ScriptedAnswerError extends Error {
  constructor(message: string, readonly deliveryMayHaveOccurred: boolean) {
    super(message);
    this.name = 'ScriptedAnswerError';
  }
}

interface Deferred { readonly promise: Promise<void>; readonly resolve: () => void }

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

/**
 * Interactive scripted Adapter: it raises one permission Attention, waits for an answer,
 * then reports completion. It never executes commands and cannot prove a real provider.
 */
class ScriptedInteractiveAdapter implements AgentAnswerAdapter, AgentProcessRelease {
  readonly id: string;
  startCount = 0;
  readonly answerAttempts: string[] = [];
  readonly releasedSessions: string[] = [];
  failNextAnswerWithProof = false;
  readonly #attentionObserved = deferred();
  readonly #answered = deferred();
  readonly #released = deferred();

  constructor(id = 'test-agent') {
    this.id = id;
  }

  attentionObserved(): Promise<void> {
    return this.#attentionObserved.promise;
  }

  async probe(): Promise<{ readonly version: string; readonly capabilities: AdapterCapabilities }> {
    return { version: 'test-1', capabilities };
  }

  async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    this.startCount += 1;
    return {
      id: request.sessionId,
      executionId: request.executionId,
      adapterId: this.id,
      providerSessionId: `test:${request.sessionId}`,
    };
  }

  async *observe(session: AgentSessionRef, cursor?: string): AsyncIterable<AgentObservedEvent> {
    if (cursor !== undefined) return;
    yield {
      sessionId: session.id,
      executionId: session.executionId,
      eventId: 'test-attention-1',
      cursor: '1',
      type: 'attention',
      providerRequestId: 'test-request-1',
      kind: 'PERMISSION',
      responseType: 'CONFIRM',
      prompt: { method: 'confirm', title: 'Allow write?' },
    };
    this.#attentionObserved.resolve();
    const outcome = await Promise.race([
      this.#answered.promise.then(() => 'ANSWER' as const),
      this.#released.promise.then(() => 'RELEASED' as const),
    ]);
    if (outcome === 'RELEASED') return;
    yield {
      sessionId: session.id,
      executionId: session.executionId,
      eventId: 'test-completed-1',
      cursor: '2',
      type: 'completed',
      outcome: 'SUCCESS',
      evidence: { ref: 'test-quiescence', toolsQuiescent: true, ownedWritersStopped: true },
    };
  }

  async answer(_session: AgentSessionRef, request: AgentAnswerRequest): Promise<AgentControlReceipt> {
    this.answerAttempts.push(request.operationId);
    if (this.failNextAnswerWithProof) {
      this.failNextAnswerWithProof = false;
      throw new ScriptedAnswerError('scripted failure before the answer was handed to the provider', false);
    }
    this.#answered.resolve();
    return { providerRequestId: request.providerRequestId, accepted: true };
  }

  async releaseSession(sessionId: string): Promise<{ readonly exited: boolean; readonly pid: number }> {
    this.releasedSessions.push(sessionId);
    this.#released.resolve();
    return { exited: true, pid: 4242 };
  }
}

function createCoordinator(value: AgentFixture, adapter: AgentAnswerAdapter): AgentRuntimeCoordinator {
  const registry = new AdapterRegistry();
  registry.register(adapter);
  return new AgentRuntimeCoordinator({
    storage: value.storage,
    registry,
    runtimeHome: value.home,
  });
}

function planConfirmAnswer(value: AgentFixture, attentionId: string, confirmed: boolean) {
  return value.storage.planAttentionAnswer({
    projectId: value.projectId,
    attentionId,
    commandId: crypto.randomUUID(),
    payloadHash: `confirm:${confirmed}`,
    intentId: crypto.randomUUID(),
    answerId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    answer: { type: 'CONFIRM', confirmed },
    intentEventId: crypto.randomUUID(),
    recordedEventId: crypto.randomUUID(),
    actor: 'local-user',
    recordedAt: Date.now(),
  });
}

function taskState(value: AgentFixture): string {
  return value.storage.listTasks(value.projectId)[0]?.state ?? 'MISSING';
}

function countRows(value: AgentFixture, sql: string): number {
  return value.storage.sqlite.query<{ count: number }, []>(sql).get()?.count ?? -1;
}

describe('Agent runtime coordinator', () => {
  test('runs one Session end to end and delivers a recorded answer before completion', async () => {
    const value = await createAgentFixture();
    const adapter = new ScriptedInteractiveAdapter();
    const coordinator = createCoordinator(value, adapter);
    try {
      const run = await coordinator.runTask({
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        commandId: crypto.randomUUID(), adapterId: adapter.id,
      });
      expect(run).toMatchObject({ attemptNumber: 1, adapterId: adapter.id, sessionState: 'ACTIVE',
        taskVersion: 2 });
      await adapter.attentionObserved();
      await waitFor(() => value.storage.listAttentionRequests(value.projectId).length === 1);
      expect(taskState(value)).toBe('WAITING_FOR_USER');

      const attention = value.storage.listAttentionRequests(value.projectId)[0];
      if (attention === undefined) throw new Error('Attention was not recorded');
      const planned = planConfirmAnswer(value, attention.id, true);
      const delivery = await coordinator.deliverAnswer(planned.operationId);
      expect(delivery.delivery).toBe('DELIVERED');
      expect(delivery.plan.operationState).toBe('SUCCEEDED');
      expect(adapter.answerAttempts).toEqual([planned.operationId]);

      await coordinator.settle();
      const executions = value.storage.listTaskExecutions(value.projectId, value.taskId);
      expect(executions).toHaveLength(1);
      expect(executions[0]?.session?.state).toBe('EXITED');
      // Completion is not result capture: the Execution is not claimed successful.
      expect(executions[0]?.state).toBe('RUNNING');
      expect(taskState(value)).toBe('RUNNING');
    } finally {
      value.storage.close();
    }
  });

  test('replays one run command ID without repeating Git, Execution, or Adapter side effects', async () => {
    const value = await createAgentFixture();
    const adapter = new ScriptedInteractiveAdapter();
    const coordinator = createCoordinator(value, adapter);
    try {
      const commandId = crypto.randomUUID();
      const input = {
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        commandId, adapterId: adapter.id,
      };
      const first = await coordinator.runTask(input);
      const second = await coordinator.runTask(input);
      // A replay reports the current Session state but must not create a second identity.
      expect(second).toMatchObject({
        executionId: first.executionId,
        sessionId: first.sessionId,
        workspaceId: first.workspaceId,
        attemptNumber: first.attemptNumber,
        taskVersion: first.taskVersion,
      });
      expect(adapter.startCount).toBe(1);
      expect(countRows(value, 'SELECT count(*) AS count FROM executions')).toBe(1);
      expect(countRows(value, "SELECT count(*) AS count FROM operations WHERE kind='PREPARE_WORKSPACE'")).toBe(1);
      expect(countRows(value, "SELECT count(*) AS count FROM operations WHERE kind='START_AGENT'")).toBe(1);
      expect(coordinator.activeSessionIds()).toEqual([first.sessionId]);
      await coordinator.close();
    } finally {
      value.storage.close();
    }
  });

  test('rejects an unregistered Adapter before any side effect', async () => {
    const value = await createAgentFixture();
    const coordinator = createCoordinator(value, new ScriptedInteractiveAdapter());
    try {
      await expect(coordinator.runTask({
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        commandId: crypto.randomUUID(), adapterId: 'missing',
      })).rejects.toMatchObject({ code: 'UNKNOWN_ADAPTER' });
      expect(countRows(value, 'SELECT count(*) AS count FROM workspaces')).toBe(0);
      expect(countRows(value, 'SELECT count(*) AS count FROM executions')).toBe(0);
      expect(countRows(value, 'SELECT count(*) AS count FROM operations')).toBe(0);
      expect(taskState(value)).toBe('READY');
    } finally {
      value.storage.close();
    }
  });

  test('keeps an answer recorded when no live Session is held', async () => {
    const value = await createAgentFixture();
    const adapter = new DeterministicFakeAdapter('SUCCEED', [{
      type: 'attention', eventId: 'fake-attention-1', cursor: 'cursor-1',
      providerRequestId: 'fake-request-1', kind: 'PERMISSION', responseType: 'CONFIRM',
      prompt: { method: 'confirm', title: 'Allow write?' },
    }]);
    const coordinator = createCoordinator(value, adapter);
    try {
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
      // Drain the stream directly: this Session is not owned by any coordinator pump.
      await observeAgentEvents({ storage: value.storage, adapter, sessionId: started.sessionId });
      const attention = value.storage.listAttentionRequests(value.projectId)[0];
      if (attention === undefined) throw new Error('Attention was not recorded');
      const planned = planConfirmAnswer(value, attention.id, true);

      const delivery = await coordinator.deliverAnswer(planned.operationId);
      expect(delivery.delivery).toBe('NOT_DELIVERED');
      expect(delivery.error?.code).toBe('NO_LIVE_SESSION');
      expect(delivery.plan.operationState).toBe('PLANNED');
      expect(delivery.plan.status).toBe('ANSWER_RECORDED');
      expect(adapter.answerAttemptCount(planned.operationId)).toBe(0);
      expect(taskState(value)).toBe('WAITING_FOR_USER');
    } finally {
      value.storage.close();
    }
  });

  test('retries only after a proven pre-delivery failure', async () => {
    const value = await createAgentFixture();
    const adapter = new ScriptedInteractiveAdapter();
    adapter.failNextAnswerWithProof = true;
    const coordinator = createCoordinator(value, adapter);
    try {
      await coordinator.runTask({
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        commandId: crypto.randomUUID(), adapterId: adapter.id,
      });
      await adapter.attentionObserved();
      await waitFor(() => value.storage.listAttentionRequests(value.projectId).length === 1);
      const attention = value.storage.listAttentionRequests(value.projectId)[0];
      if (attention === undefined) throw new Error('Attention was not recorded');
      const planned = planConfirmAnswer(value, attention.id, true);

      const failed = await coordinator.deliverAnswer(planned.operationId);
      expect(failed.delivery).toBe('NOT_DELIVERED');
      expect(failed.error?.code).toBe('AGENT_ANSWER_FAILED');
      expect(failed.plan.operationState).toBe('PLANNED');
      expect(taskState(value)).toBe('WAITING_FOR_USER');
      expect(adapter.answerAttempts).toHaveLength(1);

      const retried = await coordinator.deliverAnswer(planned.operationId);
      expect(retried.delivery).toBe('DELIVERED');
      expect(retried.plan.operationState).toBe('SUCCEEDED');
      expect(adapter.answerAttempts).toHaveLength(2);
      await coordinator.settle();
    } finally {
      value.storage.close();
    }
  });

  test('shutdown releases its own provider process and records recovery instead of claiming success', async () => {
    const value = await createAgentFixture();
    const adapter = new ScriptedInteractiveAdapter();
    const coordinator = createCoordinator(value, adapter);
    try {
      const run = await coordinator.runTask({
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        commandId: crypto.randomUUID(), adapterId: adapter.id,
      });
      await coordinator.close();
      expect(adapter.releasedSessions).toEqual([run.sessionId]);
      const executions = value.storage.listTaskExecutions(value.projectId, value.taskId);
      expect(executions[0]?.session?.state).toBe('DISCONNECTED');
      expect(executions[0]?.state).toBe('RECOVERY_REQUIRED');
      expect(executions[0]?.resourceHeld).toBe(true);
      expect(taskState(value)).toBe('RECOVERY_REQUIRED');
      expect(countRows(value, "SELECT count(*) AS count FROM workspaces WHERE state='RECOVERY_REQUIRED'")).toBe(1);
      expect(countRows(value, "SELECT count(*) AS count FROM domain_events WHERE event_type='RecoveryRequired'")).toBe(1);
    } finally {
      value.storage.close();
    }
  });
});

describe('derived run command IDs', () => {
  test('are stable per purpose and distinct between purposes', () => {
    const root = '11111111-2222-4333-8444-555555555555';
    expect(deriveCommandId(root, 'workspace')).toBe(deriveCommandId(root, 'workspace'));
    expect(deriveCommandId(root, 'workspace')).not.toBe(deriveCommandId(root, 'start-agent'));
    expect(deriveCommandId(root, 'workspace')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
