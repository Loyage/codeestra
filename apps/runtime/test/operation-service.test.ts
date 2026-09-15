import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import type {
  AdapterCapabilities,
  AgentAnswerAdapter,
  AgentObservedEvent,
  AgentProcessRelease,
  AgentSessionRef,
  AgentStartRequest,
} from '@codeestra/contracts';
import {
  Phase1Database,
  agentAnswerMigration,
  agentConfigurationMigration,
  agentDisconnectMigration,
  agentObservationMigration,
  agentStartMigration,
  integrationPipelineMigration,
  phase1Migration,
  phase1SchemaVersion,
  taskControlMigration,
  taskVerificationMigration,
  workspaceRetryMigration,
} from '@codeestra/storage';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import {
  LongOperationService,
  operationSteps,
  reconcileRunOperations,
} from '../src/operation-service.js';
import { captureResultCommit, prepareResultCommit } from '../src/result-commit-service.js';
import { VerificationRunner, queueTaskVerification } from '../src/verification-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  git,
  waitFor,
  type AgentFixture,
  type AgentFixtureOptions,
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
  pluginSelection: 'UNSUPPORTED',
});

interface Deferred { readonly promise: Promise<void>; readonly resolve: () => void }

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

/**
 * An Adapter that settles only when the Runtime releases it. It exists so the run Operation stays
 * open while the test simulates a restart; it never touches a provider or a user repository.
 */
class HeldSessionAdapter implements AgentAnswerAdapter, AgentProcessRelease {
  readonly id = 'held-agent';
  readonly #released = deferred();

  async probe(): Promise<{ readonly version: string; readonly capabilities: AdapterCapabilities }> {
    return { version: 'held-1', capabilities };
  }

  async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    return {
      id: request.sessionId,
      executionId: request.executionId,
      adapterId: this.id,
      providerSessionId: `held:${request.sessionId}`,
    };
  }

  async *observe(session: AgentSessionRef, cursor?: string): AsyncIterable<AgentObservedEvent> {
    if (cursor !== undefined) return;
    yield {
      sessionId: session.id,
      executionId: session.executionId,
      eventId: 'held-attention-1',
      cursor: '1',
      type: 'attention',
      providerRequestId: 'held-request-1',
      kind: 'PERMISSION',
      responseType: 'CONFIRM',
      prompt: { method: 'confirm', title: 'Allow write?' },
    };
    await this.#released.promise;
  }

  async answer(): Promise<{ readonly providerRequestId: string; readonly accepted: true }> {
    return { providerRequestId: 'held-request-1', accepted: true };
  }

  async releaseSession(): Promise<{ readonly exited: boolean; readonly pid: number }> {
    this.#released.resolve();
    return { exited: true, pid: 4242 };
  }
}

interface ExecutedFixture {
  readonly value: AgentFixture;
  readonly workspacePath: string;
  readonly resultCommit: string;
  readonly copiesRoot: string;
  readonly coordinator: AgentRuntimeCoordinator;
}

/** Runs a fake Agent to a captured result commit, leaving an EXECUTED Task. */
async function executedTask(options: AgentFixtureOptions = {}): Promise<ExecutedFixture> {
  const value = await createAgentFixture(options);
  const adapter = new DeterministicFakeAdapter('SUCCEED', [{
    type: 'completed', eventId: 'fake-completed-1', cursor: 'cursor-1',
    outcome: 'SUCCESS', evidenceRef: 'fake-quiescence',
  }]);
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const coordinator = new AgentRuntimeCoordinator({
    storage: value.storage, registry, runtimeHome: value.home,
  });
  const run = await coordinator.runTask({
    projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
    commandId: crypto.randomUUID(), adapterId: adapter.id,
  });
  await coordinator.settle();
  await Bun.write(join(run.workspacePath, 'agent-output.txt'), 'work\n');
  const prepared = await prepareResultCommit({
    storage: value.storage, projectId: value.projectId, taskId: value.taskId,
    commandId: crypto.randomUUID(), actor: 'local-user',
  });
  const captured = await captureResultCommit({
    storage: value.storage, projectId: value.projectId, taskId: value.taskId,
    authorizationId: prepared.authorizationId, commandId: crypto.randomUUID(),
  });
  return {
    value,
    workspacePath: run.workspacePath,
    resultCommit: captured.resultCommit,
    copiesRoot: join(value.home, 'verifications'),
    coordinator,
  };
}

function createService(
  fixture: ExecutedFixture,
  runner: VerificationRunner,
): LongOperationService {
  return new LongOperationService({
    storage: fixture.value.storage,
    runner,
    coordinator: fixture.coordinator,
    copiesRoot: fixture.copiesRoot,
    permissionMode: () => 'FULL',
  });
}

function countRows(storage: Phase1Database, sql: string): number {
  return storage.sqlite.query<{ count: number }, []>(sql).get()?.count ?? -1;
}

describe('operation progress schema (ADR-0019)', () => {
  test('upgrades a version 10 database and adds the operation progress table', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-v10-'));
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
      legacy.exec('PRAGMA user_version=10');
      legacy.query(`INSERT INTO projects
        (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
        VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','sha1',1)`).run();
      legacy.query(`INSERT INTO operations
        (id,project_id,kind,aggregate_id,idempotency_key,state,request_json,created_at,updated_at)
        VALUES ('op1','p1','RUN_TASK','t1','cmd-1','IN_PROGRESS','{}',2,2)`).run();
      legacy.close();

      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBe(phase1SchemaVersion);
      // This lane reserves version 11 (ADR-0019); a concurrent lane reserves 12 (ADR-0021). The
      // assertion is deliberately not a literal so the merged result (version 12) still holds.
      expect(phase1SchemaVersion).toBeGreaterThanOrEqual(11);
      const tables = upgraded.sqlite.query<{ name: string }, []>(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='operation_progress'
      `).all().map((row) => row.name);
      expect(tables).toEqual(['operation_progress']);
      // The pre-existing Operation keeps its state and can now carry ordered steps.
      expect(upgraded.getOperation('p1', 'op1').state).toBe('IN_PROGRESS');
      upgraded.recordOperationProgress({
        operationId: 'op1', stepKey: 'RUN_REQUESTED', step: 'RUN', state: 'STARTED', recordedAt: 3,
      });
      expect(upgraded.getOperation('p1', 'op1').steps).toHaveLength(1);
      // A step key is unique per Operation: the same boundary cannot be recorded twice.
      expect(upgraded.recordOperationProgress({
        operationId: 'op1', stepKey: 'RUN_REQUESTED', step: 'RUN', state: 'STARTED', recordedAt: 4,
      }).recorded).toBe(false);
      expect(upgraded.getOperation('p1', 'op1').steps).toHaveLength(1);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('Agent run Operation', () => {
  test('records the run steps and settles from the Session and Execution facts', async () => {
    const value = await createAgentFixture();
    const adapter = new DeterministicFakeAdapter('SUCCEED', [{
      type: 'completed', eventId: 'fake-completed-1', cursor: 'cursor-1',
      outcome: 'SUCCESS', evidenceRef: 'fake-quiescence',
    }]);
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const coordinator = new AgentRuntimeCoordinator({
      storage: value.storage, registry, runtimeHome: value.home,
    });
    try {
      const run = await coordinator.runTask({
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        commandId: crypto.randomUUID(), adapterId: adapter.id,
      });
      await coordinator.settle();
      await waitFor(() => value.storage
        .listTaskOperations(value.projectId, value.taskId)
        .every((operation) => operation.state !== 'IN_PROGRESS'), 5_000);
      const operations = value.storage.listTaskOperations(value.projectId, value.taskId);
      expect(operations).toHaveLength(1);
      const operation = operations[0];
      if (operation === undefined) throw new Error('run Operation was not recorded');
      expect(operation.kind).toBe('RUN_TASK');
      expect(operation.taskId).toBe(value.taskId);
      expect(operation.state).toBe('SUCCEEDED');
      expect(operation.steps.map((step) => step.stepKey)).toEqual([
        operationSteps.runRequested,
        operationSteps.workspacePrepared,
        operationSteps.executionReserved,
        operationSteps.agentSessionStarted,
        operationSteps.agentSettled,
      ]);
      expect(operation.steps.find((step) => step.stepKey === operationSteps.executionReserved)?.detail)
        .toMatchObject({ executionId: run.executionId, attemptNumber: 1 });
      // Settling a run is not claiming a captured result: the Execution is still RUNNING.
      expect(value.storage.listTaskExecutions(value.projectId, value.taskId)[0]?.state).toBe('RUNNING');
      const executionStep = operation.steps
        .find((step) => step.stepKey === operationSteps.executionReserved);
      expect(executionStep?.detail?.['executionId']).toBe(run.executionId);
    } finally {
      await coordinator.close();
      value.storage.close();
    }
  });

  test('replaying one run command ID keeps a single Operation and no duplicated steps', async () => {
    const value = await createAgentFixture();
    const adapter = new DeterministicFakeAdapter('SUCCEED', [{
      type: 'completed', eventId: 'fake-completed-1', cursor: 'cursor-1',
      outcome: 'SUCCESS', evidenceRef: 'fake-quiescence',
    }]);
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const coordinator = new AgentRuntimeCoordinator({
      storage: value.storage, registry, runtimeHome: value.home,
    });
    try {
      const commandId = crypto.randomUUID();
      const input = {
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        commandId, adapterId: adapter.id,
      };
      await coordinator.runTask(input);
      await coordinator.settle();
      await coordinator.runTask(input);
      const operations = value.storage.listTaskOperations(value.projectId, value.taskId);
      expect(operations).toHaveLength(1);
      expect(countRows(value.storage, "SELECT count(*) AS count FROM operations WHERE kind='RUN_TASK'"))
        .toBe(1);
      const stepKeys = operations[0]?.steps.map((step) => step.stepKey) ?? [];
      expect(new Set(stepKeys).size).toBe(stepKeys.length);
    } finally {
      await coordinator.close();
      value.storage.close();
    }
  });
});

describe('restart reconcile for run Operations', () => {
  test('records a run attempt that fails during the provider version probe', async () => {
    const value = await createAgentFixture();
    const unavailable: AgentAnswerAdapter = {
      id: 'unavailable-agent',
      probe: async () => {
        throw Object.assign(new Error('the provider is not available'), {
          code: 'PROVIDER_VERSION_UNAVAILABLE',
        });
      },
      start: async () => { throw new Error('the Adapter must not be started'); },
      observe: () => ({
        [Symbol.asyncIterator]: async function* () { /* never reached */ },
      }),
      answer: async () => ({ providerRequestId: 'none', accepted: true as const }),
    };
    const registry = new AdapterRegistry();
    registry.register(unavailable);
    const coordinator = new AgentRuntimeCoordinator({
      storage: value.storage, registry, runtimeHome: value.home,
    });
    try {
      await expect(coordinator.runTask({
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        commandId: crypto.randomUUID(), adapterId: unavailable.id,
      })).rejects.toMatchObject({ code: 'PROVIDER_VERSION_UNAVAILABLE' });
      const operations = value.storage.listTaskOperations(value.projectId, value.taskId);
      expect(operations).toHaveLength(1);
      expect(operations[0]?.state).toBe('FAILED');
      expect(operations[0]?.result).toMatchObject({ code: 'PROVIDER_VERSION_UNAVAILABLE' });
      expect(operations[0]?.steps.map((step) => step.stepKey))
        .toEqual([operationSteps.runRequested, 'RUN_FAILED']);
      // Recording the attempt is not a side effect: no workspace was created, no Execution exists.
      expect(countRows(value.storage, 'SELECT count(*) AS count FROM workspaces')).toBe(0);
      expect(countRows(value.storage, 'SELECT count(*) AS count FROM executions')).toBe(0);
    } finally {
      value.storage.close();
    }
  });

  test('needs a human while the Execution may still own a provider process', async () => {
    const value = await createAgentFixture();
    const adapter = new HeldSessionAdapter();
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const coordinator = new AgentRuntimeCoordinator({
      storage: value.storage, registry, runtimeHome: value.home,
    });
    try {
      await coordinator.runTask({
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        commandId: crypto.randomUUID(), adapterId: adapter.id,
      });
      const before = value.storage.listTaskOperations(value.projectId, value.taskId)[0];
      if (before === undefined) throw new Error('run Operation was not recorded');
      expect(before.state).toBe('IN_PROGRESS');
      const results = reconcileRunOperations({
        storage: value.storage, recordedAt: Date.now() + 1,
      });
      expect(results).toEqual([{ operationId: before.operationId, outcome: 'RECOVERY_REQUIRED' }]);
      const after = value.storage.listTaskOperations(value.projectId, value.taskId)[0];
      expect(after?.state).toBe('RECONCILE_REQUIRED');
      expect(after?.result).toMatchObject({ code: 'RUNTIME_RESTARTED' });
      // Nothing is released: the Execution still holds its workspace.
      expect(value.storage.listTaskExecutions(value.projectId, value.taskId)[0]?.resourceHeld).toBe(true);
    } finally {
      await coordinator.close();
      value.storage.close();
    }
  });

  test('closes a run that never recorded an Execution without replaying Git', async () => {
    const value = await createAgentFixture();
    try {
      const begun = value.storage.beginRunOperation({
        operationId: crypto.randomUUID(),
        projectId: value.projectId,
        kind: 'RUN_TASK',
        aggregateId: value.taskId,
        idempotencyKey: crypto.randomUUID(),
        request: { taskId: value.taskId },
        createdAt: Date.now(),
      });
      const results = reconcileRunOperations({ storage: value.storage, recordedAt: Date.now() + 1 });
      expect(results).toEqual([{ operationId: begun.operation.operationId, outcome: 'RECOVERED_FAILED' }]);
      const operation = value.storage.getOperation(value.projectId, begun.operation.operationId);
      expect(operation.state).toBe('FAILED');
      expect(operation.result).toMatchObject({ code: 'RUNTIME_RESTARTED' });
    } finally {
      value.storage.close();
    }
  });
});

describe('verification Operation', () => {
  test('runs in the background and records one step per policy command', async () => {
    const fixture = await executedTask({ verificationCommands: [
      { id: 'first', argv: ['echo', 'first'], cwd: '.', timeoutSeconds: 60 },
      { id: 'second', argv: ['echo', 'second'], cwd: '.', timeoutSeconds: 60 },
    ] });
    const service = createService(fixture, new VerificationRunner());
    try {
      const started = await service.startVerification({
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        commandId: crypto.randomUUID(),
        background: true,
      });
      expect(started.background).toBe(true);
      if (!started.background) throw new Error('background verification did not return a handle');
      const { operationId, verificationId } = started.handle;
      expect(started.handle.state).toBe('RUNNING');
      await waitFor(() => fixture.value.storage.getOperation(fixture.value.projectId, operationId)
        .state !== 'IN_PROGRESS', 20_000);
      const operation = fixture.value.storage.getOperation(fixture.value.projectId, operationId);
      expect(operation.state).toBe('SUCCEEDED');
      expect(operation.kind).toBe('RUN_TASK_VERIFICATION');
      expect(operation.steps.map((step) => step.stepKey)).toEqual([
        operationSteps.verificationQueued,
        operationSteps.verificationCopy,
        operationSteps.commandStarted('first'),
        operationSteps.commandFinished('first'),
        operationSteps.commandStarted('second'),
        operationSteps.commandFinished('second'),
      ]);
      expect(operation.steps.find((step) => step.stepKey === operationSteps.commandFinished('first'))
        ?.detail).toMatchObject({ commandId: 'first', exitCode: 0 });
      expect(fixture.value.storage
        .getVerificationRun(fixture.value.projectId, verificationId).state).toBe('PASSED');
    } finally {
      await service.close();
      fixture.value.storage.close();
    }
  });

  test('cancels a running verification only after the process group is confirmed stopped', async () => {
    const fixture = await executedTask({ verificationCommands: [
      { id: 'slow', argv: ['sleep', '30'], cwd: '.', timeoutSeconds: 60 },
    ] });
    const runner = new VerificationRunner();
    const service = createService(fixture, runner);
    try {
      const started = await service.startVerification({
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        commandId: crypto.randomUUID(),
        background: true,
      });
      if (!started.background) throw new Error('background verification did not return a handle');
      const { operationId, verificationId } = started.handle;
      await waitFor(() => fixture.value.storage.getOperation(fixture.value.projectId, operationId)
        .steps.some((step) => step.stepKey === operationSteps.commandStarted('slow')), 10_000);
      const outcome = await service.cancel({
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        operationId,
        commandId: crypto.randomUUID(),
        actor: 'local-user',
      });
      expect(outcome.stop).toBe('CANCELLED');
      expect(outcome.state).toBe('FAILED');
      const run = fixture.value.storage.getVerificationRun(fixture.value.projectId, verificationId);
      // ADR-0027: a user stop is a terminal state of its own, not a borrowed ERROR verdict.
      expect(run.state).toBe('CANCELLED');
      expect(run.outcomeCode).toBe('CANCELLED_BY_USER');
      expect(run.evidence).toMatchObject({ cancelledBy: 'local-user', stoppedProcessGroup: true });
      // The Runtime keeps the scene of a cancelled run instead of deleting a copy it may still write.
      expect(existsSync(run.copyPath)).toBe(true);
      expect(runner.unconfirmedStops).toEqual([]);
      expect(runner.activeVerificationIds).toEqual([]);
    } finally {
      await service.close();
      await runner.close();
      fixture.value.storage.close();
    }
  });

  test('keeps ownership and needs a human when the stop cannot be confirmed', async () => {
    const fixture = await executedTask({ verificationCommands: [
      { id: 'slow', argv: ['sleep', '30'], cwd: '.', timeoutSeconds: 60 },
    ] });
    // A runner that cannot confirm the stop: the Runtime must not record a terminal state for a
    // process it cannot prove is gone.
    const unconfirming = {
      stopOwned: async () => ({ held: true, stopped: false }),
    } as unknown as VerificationRunner;
    const service = createService(fixture, unconfirming);
    try {
      const queued = await queueTaskVerification({
        storage: fixture.value.storage,
        copiesRoot: fixture.copiesRoot,
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        commandId: crypto.randomUUID(),
        permissionMode: 'FULL',
      });
      const outcome = await service.cancel({
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        operationId: queued.operationId,
        commandId: crypto.randomUUID(),
        actor: 'local-user',
      });
      expect(outcome.stop).toBe('UNCERTAIN');
      expect(outcome.state).toBe('RECONCILE_REQUIRED');
      const operation = fixture.value.storage.getOperation(fixture.value.projectId, queued.operationId);
      expect(operation.state).toBe('RECONCILE_REQUIRED');
      expect(operation.result).toMatchObject({ code: 'CANCEL_UNCONFIRMED' });
      expect(operation.steps.some((step) => step.stepKey === operationSteps.cancelUnconfirmed)).toBe(true);
      // No verdict was invented: the run stays RUNNING for a human (or a restart) to reconcile.
      expect(fixture.value.storage
        .getVerificationRun(fixture.value.projectId, queued.verificationId).state).toBe('RUNNING');
    } finally {
      await service.close();
      fixture.value.storage.close();
    }
  });
});

describe('cancelling an Agent run Operation', () => {
  test('stops the provider cooperatively and pauses the Task instead of destroying it', async () => {
    const value = await createAgentFixture();
    const adapter = new HeldSessionAdapter();
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const coordinator = new AgentRuntimeCoordinator({
      storage: value.storage, registry, runtimeHome: value.home,
    });
    const service = new LongOperationService({
      storage: value.storage,
      runner: new VerificationRunner(),
      coordinator,
      copiesRoot: join(value.home, 'verifications'),
      permissionMode: () => 'FULL',
    });
    try {
      await coordinator.runTask({
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        commandId: crypto.randomUUID(), adapterId: adapter.id,
      });
      const operation = value.storage.listTaskOperations(value.projectId, value.taskId)[0];
      if (operation === undefined) throw new Error('run Operation was not recorded');
      const outcome = await service.cancel({
        projectId: value.projectId,
        taskId: value.taskId,
        operationId: operation.operationId,
        commandId: crypto.randomUUID(),
        actor: 'local-user',
      });
      expect(outcome.stop).toBe('PAUSED');
      expect(outcome.taskState).toBe('PAUSED');
      const settled = value.storage.getOperation(value.projectId, operation.operationId);
      expect(settled.state).toBe('FAILED');
      expect(settled.result).toMatchObject({ code: 'STOPPED_BY_USER', taskState: 'PAUSED' });
      // Cancelling the Operation did not terminate the Task: `task cancel` remains the terminal one.
      expect(value.storage.getTask(value.projectId, value.taskId)?.state).toBe('PAUSED');
      // The observation loop ending must not overwrite the recorded cancellation.
      await coordinator.settle();
      expect(value.storage.getOperation(value.projectId, operation.operationId).state).toBe('FAILED');
      const again = await service.cancel({
        projectId: value.projectId,
        taskId: value.taskId,
        operationId: operation.operationId,
        commandId: crypto.randomUUID(),
        actor: 'local-user',
      });
      expect(again.stop).toBe('ALREADY_TERMINAL');
    } finally {
      await service.close();
      await coordinator.close();
      value.storage.close();
    }
  });
});

describe('verification Operation idempotency', () => {
  test('replaying one verify command ID returns the recorded run instead of running it twice', async () => {
    const fixture = await executedTask({ verificationCommands: [
      { id: 'once', argv: ['echo', 'once'], cwd: '.', timeoutSeconds: 60 },
    ] });
    const runner = new VerificationRunner();
    const service = createService(fixture, runner);
    try {
      const commandId = crypto.randomUUID();
      const first = await service.startVerification({
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        commandId,
        background: true,
      });
      if (!first.background) throw new Error('background verification did not return a handle');
      await waitFor(() => fixture.value.storage
        .getOperation(fixture.value.projectId, first.handle.operationId).state !== 'IN_PROGRESS', 20_000);
      const second = await service.startVerification({
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        commandId,
        background: true,
      });
      if (!second.background) throw new Error('background verification did not return a handle');
      expect(second.handle.verificationId).toBe(first.handle.verificationId);
      expect(second.handle.operationId).toBe(first.handle.operationId);
      expect(countRows(fixture.value.storage, 'SELECT count(*) AS count FROM verification_runs')).toBe(1);
      expect(countRows(fixture.value.storage,
        "SELECT count(*) AS count FROM operations WHERE kind='RUN_TASK_VERIFICATION'")).toBe(1);
      await service.close();
    } finally {
      fixture.value.storage.close();
    }
  });
});

describe('repository state used by these tests', () => {
  test('the fixture repository is untouched by the verification copy', async () => {
    const fixture = await executedTask();
    try {
      expect(await git(fixture.value.repo, ['status', '--porcelain'])).toBe('');
    } finally {
      fixture.value.storage.close();
    }
  });
});
