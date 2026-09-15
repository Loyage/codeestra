import { afterEach, describe, expect, test } from 'bun:test';
import type {
  AdapterCapabilities,
  AgentAnswerAdapter,
  AgentObservedEvent,
  AgentProcessRelease,
  AgentSessionRef,
  AgentStartRequest,
} from '@codeestra/contracts';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import { pauseOrCancelTask, resumePausedTask } from '../src/task-control-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
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
  resumeAfterExit: 'SUPPORTED',
  controlledConfiguration: 'SUPPORTED',
  pluginSelection: 'UNSUPPORTED',
});

interface Deferred { readonly promise: Promise<void>; readonly resolve: () => void }

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

/**
 * Long-lived scripted Adapter: it holds one Session open until it is released and records every
 * start request, so pause/resume can be checked without a real provider process.
 */
class ScriptedHoldAdapter implements AgentAnswerAdapter, AgentProcessRelease {
  readonly id = 'hold-agent';
  readonly starts: AgentStartRequest[] = [];
  readonly releasedSessions: string[] = [];
  confirmedExit = true;
  readonly #releases = new Map<string, Deferred>();

  async probe(): Promise<{ readonly version: string; readonly capabilities: AdapterCapabilities }> {
    return { version: 'test-1', capabilities };
  }

  async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    this.starts.push(request);
    this.#releases.set(request.sessionId, deferred());
    return {
      id: request.sessionId,
      executionId: request.executionId,
      adapterId: this.id,
      providerSessionId: `provider:${request.sessionId}`,
      sessionStorageRef: `/sessions/${request.sessionId}.jsonl`,
    };
  }

  async *observe(session: AgentSessionRef): AsyncIterable<AgentObservedEvent> {
    const release = this.#releases.get(session.id);
    if (release !== undefined) await release.promise;
  }

  async answer(): Promise<{ readonly providerRequestId: string; readonly accepted: true }> {
    throw new Error('ScriptedHoldAdapter never raises an Attention');
  }

  async releaseSession(sessionId: string): Promise<{ readonly exited: boolean; readonly pid: number }> {
    this.releasedSessions.push(sessionId);
    this.#releases.get(sessionId)?.resolve();
    return { exited: this.confirmedExit, pid: 4242 };
  }
}

function createCoordinator(value: AgentFixture, adapter: AgentAnswerAdapter): AgentRuntimeCoordinator {
  const registry = new AdapterRegistry();
  registry.register(adapter);
  return new AgentRuntimeCoordinator({ storage: value.storage, registry, runtimeHome: value.home });
}

describe('Task pause, resume, and cancel command face', () => {
  test('pauses a running Task, then resumes it in a new Execution over the same workspace', async () => {
    const value = await createAgentFixture();
    const adapter = new ScriptedHoldAdapter();
    const coordinator = createCoordinator(value, adapter);
    try {
      const run = await coordinator.runTask({
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        commandId: crypto.randomUUID(), adapterId: adapter.id,
      });
      expect(run.taskVersion).toBe(2);

      const paused = await pauseOrCancelTask({
        storage: value.storage, coordinator, kind: 'PAUSE', projectId: value.projectId,
        taskId: value.taskId, expectedVersion: 2, commandId: crypto.randomUUID(), actor: 'local-user',
      });
      expect(paused).toMatchObject({ state: 'PAUSED', stop: 'RELEASED' });
      expect(adapter.releasedSessions).toEqual([run.sessionId]);
      expect(value.storage.getTask(value.projectId, value.taskId)?.state).toBe('PAUSED');
      const pausedExecution = value.storage.listTaskExecutions(value.projectId, value.taskId)[0];
      expect(pausedExecution).toMatchObject({ state: 'SUPERSEDED', stopReason: 'USER_PAUSE',
        resourceHeld: false });
      expect(pausedExecution?.session?.state).toBe('EXITED');

      const taskAfterPause = value.storage.getTask(value.projectId, value.taskId);
      const resumed = await resumePausedTask({
        storage: value.storage, coordinator, projectId: value.projectId, taskId: value.taskId,
        expectedVersion: taskAfterPause?.version ?? 3, commandId: crypto.randomUUID(),
        adapterId: adapter.id,
      });
      expect(resumed).toMatchObject({ state: 'RUNNING', started: true,
        resumeFromExecutionId: pausedExecution?.executionId });
      expect(adapter.starts).toHaveLength(2);
      const continuation = adapter.starts[1];
      expect(continuation?.resume).toMatchObject({
        predecessorSessionId: pausedExecution?.session?.sessionId,
        sessionStorageRef: `/sessions/${run.sessionId}.jsonl`,
      });
      // The continuation reuses the retained workspace instead of preparing a second one.
      expect(continuation?.workspace.id).toBe(run.workspaceId);
      const executions = value.storage.listTaskExecutions(value.projectId, value.taskId);
      expect(executions.find((execution) => execution.executionId === resumed.executionId))
        .toMatchObject({ state: 'RUNNING', resumeFromExecutionId: pausedExecution?.executionId });
    } finally {
      await coordinator.close();
    }
  });

  test('cancels a Task that holds no Execution without touching a provider', async () => {
    const value = await createAgentFixture();
    const adapter = new ScriptedHoldAdapter();
    const coordinator = createCoordinator(value, adapter);
    try {
      const cancelled = await pauseOrCancelTask({
        storage: value.storage, coordinator, kind: 'CANCEL', projectId: value.projectId,
        taskId: value.taskId, expectedVersion: 1, commandId: crypto.randomUUID(), actor: 'local-user',
      });
      expect(cancelled).toMatchObject({ state: 'CANCELLED', stop: 'TERMINAL', executionId: null });
      expect(adapter.releasedSessions).toEqual([]);
    } finally {
      await coordinator.close();
    }
  });

  test('reports RECOVERY_REQUIRED and keeps the workspace when the provider stop is unproven', async () => {
    const value = await createAgentFixture();
    const adapter = new ScriptedHoldAdapter();
    adapter.confirmedExit = false;
    const coordinator = createCoordinator(value, adapter);
    try {
      await coordinator.runTask({
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        commandId: crypto.randomUUID(), adapterId: adapter.id,
      });
      const paused = await pauseOrCancelTask({
        storage: value.storage, coordinator, kind: 'PAUSE', projectId: value.projectId,
        taskId: value.taskId, expectedVersion: 2, commandId: crypto.randomUUID(), actor: 'local-user',
      });
      expect(paused).toMatchObject({ state: 'RECOVERY_REQUIRED', stop: 'UNCERTAIN' });
      expect(value.storage.getTask(value.projectId, value.taskId)?.state).toBe('RECOVERY_REQUIRED');
      const execution = value.storage.listTaskExecutions(value.projectId, value.taskId)[0];
      expect(execution).toMatchObject({ state: 'RECOVERY_REQUIRED', resourceHeld: true });
    } finally {
      await coordinator.close();
    }
  });
});
