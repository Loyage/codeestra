import { afterEach, describe, expect, test } from 'bun:test';

import { join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import type { RuntimeStreamFrame } from '@codeestra/contracts';
import { Phase1Database } from '@codeestra/storage';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import { EventSubscriptionHub } from '../src/event-subscription-service.js';
import { LongOperationService, operationSteps } from '../src/operation-service.js';
import { captureResultCommit, prepareResultCommit } from '../src/result-commit-service.js';
import { VerificationRunner } from '../src/verification-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  waitFor,
  type AgentFixture,
  type AgentFixtureOptions,
} from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

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
  outputProgressIntervalMs?: number,
): LongOperationService {
  return new LongOperationService({
    storage: fixture.value.storage,
    runner,
    coordinator: fixture.coordinator,
    copiesRoot: fixture.copiesRoot,
    permissionMode: () => 'FULL',
    ...(outputProgressIntervalMs === undefined ? {} : { outputProgressIntervalMs }),
  });
}

/** Every event of one type for one project, in cursor order — the same read `events.list` performs. */
function eventsOfType(
  storage: Phase1Database,
  projectId: string,
  eventType: string,
): readonly { readonly sequence: number; readonly aggregateId: string;
  readonly payload: Record<string, unknown> }[] {
  return storage.listEventsAfter({ sinceSequence: 0, limit: 500, projectId })
    .filter((event) => event.eventType === eventType)
    .map((event) => ({
      sequence: event.sequence,
      aggregateId: event.aggregateId,
      payload: event.payload as Record<string, unknown>,
    }));
}

function collectFrames(hub: EventSubscriptionHub, sinceSequence: number): {
  readonly frames: readonly RuntimeStreamFrame[];
  readonly handle: ReturnType<EventSubscriptionHub['subscribe']>;
} {
  const frames: RuntimeStreamFrame[] = [];
  const handle = hub.subscribe({
    requestId: crypto.randomUUID(),
    sinceSequence,
    send: (frame) => { frames.push(frame); return true; },
  });
  return { frames, handle };
}

describe('progress events are durable, ordered and idempotent (ADR-0027)', () => {
  test('a monotonic per-Operation sequence, one fact per dedup key, nothing after the settle', async () => {
    const value = await createAgentFixture();
    try {
      const begun = value.storage.beginRunOperation({
        operationId: crypto.randomUUID(),
        projectId: value.projectId,
        kind: 'RUN_TASK',
        aggregateId: value.taskId,
        idempotencyKey: crypto.randomUUID(),
        request: { taskId: value.taskId },
        createdAt: 10,
      });
      const operationId = begun.operation.operationId;
      const publish = (dedupKey: string, at: number) => value.storage.recordOperationProgressEvent({
        operationId,
        eventId: crypto.randomUUID(),
        phase: 'STEP',
        dedupKey,
        detail: { at },
        recordedAt: at,
        step: { stepKey: dedupKey, step: 'TEST', state: 'INFO' },
      });

      const first = publish('STEP:A', 11);
      const second = publish('STEP:B', 12);
      const third = publish('STEP:C', 13);
      expect([first.progressSequence, second.progressSequence, third.progressSequence])
        .toEqual([0, 1, 2]);
      // The global event cursor is assigned by the one append-only log, so it is strictly increasing.
      expect((second.eventSequence as number) > (first.eventSequence as number)).toBe(true);
      expect((third.eventSequence as number) > (second.eventSequence as number)).toBe(true);

      // Re-publishing the same boundary is a no-op that reports the already-assigned sequence.
      const replay = publish('STEP:B', 14);
      expect(replay.eventRecorded).toBe(false);
      expect(replay.progressSequence).toBe(1);
      expect(value.storage.listOperationProgressEvents(operationId)).toHaveLength(3);

      // A cursor read is exclusive and ordered, so a projection can resume without repeats.
      const afterZero = value.storage.listOperationProgressEvents(operationId,
        { afterProgressSequence: 0 });
      expect(afterZero.map((row) => row.progressSequence)).toEqual([1, 2]);
      expect(afterZero.map((row) => row.dedupKey)).toEqual(['STEP:B', 'STEP:C']);

      const settled = value.storage.completeOperation({
        operationId, state: 'SUCCEEDED', result: { code: 'TEST' }, completedAt: 15,
      });
      expect(settled.state).toBe('SUCCEEDED');
      // A second terminal write changes nothing: the Operation is already settled, and the settle
      // fact is published once.
      expect(value.storage.completeOperation({
        operationId, state: 'FAILED', result: { code: 'LATE' }, completedAt: 16,
      }).state).toBe('SUCCEEDED');
      expect(eventsOfType(value.storage, value.projectId, 'OperationSettled')).toHaveLength(1);

      // Progress after the verdict is refused as an event while the step stays a recorded fact, so a
      // killed command's late callback can never make a finished Operation look like it is moving.
      const beforeLate = value.storage.listOperationProgressEvents(operationId).length;
      const late = value.storage.recordOperationProgressEvent({
        operationId,
        eventId: crypto.randomUUID(),
        phase: 'STEP',
        dedupKey: 'STEP:LATE',
        detail: { late: true },
        recordedAt: 17,
        step: { stepKey: 'LATE', step: 'TEST', state: 'INFO' },
      });
      expect(late.refused).toBe('TERMINAL');
      expect(late.eventRecorded).toBe(false);
      expect(late.stepRecorded).toBe(true);
      expect(value.storage.listOperationProgressEvents(operationId)).toHaveLength(beforeLate);
      expect(value.storage.getOperation(value.projectId, operationId).steps
        .some((step) => step.stepKey === 'LATE')).toBe(true);

      // The event log is the delivery channel: both types are readable through the same cursor read
      // that `events list` uses, in order, and none of them claims a verdict.
      const progressed = eventsOfType(value.storage, value.projectId, 'OperationProgressed');
      const settledEvents = eventsOfType(value.storage, value.projectId, 'OperationSettled');
      expect(progressed.map((event) => event.payload['dedupKey']))
        .toEqual(['STEP:A', 'STEP:B', 'STEP:C']);
      expect(progressed.map((event) => event.payload['progressSequence'])).toEqual([0, 1, 2]);
      expect(settledEvents).toHaveLength(1);
      expect(settledEvents[0]?.payload).toMatchObject({
        operationState: 'SUCCEEDED', phase: 'SETTLED', verdict: false, kind: 'RUN_TASK',
        taskId: value.taskId,
      });
      for (const event of [...progressed, ...settledEvents]) {
        expect(event.payload['verdict']).toBe(false);
        // A progress event carries no judgement field a client could misread as one.
        expect('state' in event.payload).toBe(false);
      }
    } finally {
      value.storage.close();
    }
  });

  test('an Operation that never published progress does not join the progress stream', async () => {
    const value = await createAgentFixture();
    try {
      // `beginRunOperation` is the storage-level primitive: it records the Operation but publishes
      // no progress, so settling it must not invent a progress stream (this is how the sub-operations
      // of a run — workspace, Agent start, result commit — stay out of it).
      const begun = value.storage.beginRunOperation({
        operationId: crypto.randomUUID(),
        projectId: value.projectId,
        kind: 'PREPARE_WORKSPACE',
        aggregateId: value.taskId,
        idempotencyKey: crypto.randomUUID(),
        request: { taskId: value.taskId },
        createdAt: 20,
      });
      value.storage.completeOperation({
        operationId: begun.operation.operationId,
        state: 'SUCCEEDED',
        result: { code: 'PREPARED' },
        completedAt: 21,
      });
      expect(value.storage.listOperationProgressEvents(begun.operation.operationId)).toEqual([]);
      expect(eventsOfType(value.storage, value.projectId, 'OperationSettled')).toEqual([]);
      expect(eventsOfType(value.storage, value.projectId, 'OperationProgressed')).toEqual([]);
    } finally {
      value.storage.close();
    }
  });

  test('reaches a command-face event subscription through versioned frames', async () => {
    const value = await createAgentFixture();
    const hub = new EventSubscriptionHub({ storage: value.storage, intervalMs: 10 });
    try {
      const begun = value.storage.beginRunOperation({
        operationId: crypto.randomUUID(),
        projectId: value.projectId,
        kind: 'RUN_TASK',
        aggregateId: value.taskId,
        idempotencyKey: crypto.randomUUID(),
        request: { taskId: value.taskId },
        createdAt: 10,
      });
      const snapshotCursor = value.storage.latestEventSequence();
      const { frames, handle } = collectFrames(hub, snapshotCursor);
      expect(handle.active).toBe(true);
      value.storage.recordOperationProgressEvent({
        operationId: begun.operation.operationId,
        eventId: crypto.randomUUID(),
        phase: 'STEP',
        dedupKey: 'STEP:RUN_REQUESTED',
        detail: { note: 'live' },
        recordedAt: 11,
        step: { stepKey: operationSteps.runRequested, step: 'RUN', state: 'STARTED' },
      });
      hub.flush();
      const events = frames.filter((frame) => frame.type === 'event');
      expect(events).toHaveLength(1);
      const frame = events[0];
      if (frame === undefined || frame.type !== 'event') throw new Error('no event frame');
      expect(frame.cursor).toBeGreaterThan(snapshotCursor);
      expect(frame.event.eventType).toBe('OperationProgressed');
      expect(frame.event.payload).toMatchObject({
        operationId: begun.operation.operationId,
        taskId: value.taskId,
        phase: 'STEP',
        stepKey: operationSteps.runRequested,
        verdict: false,
      });
      handle.close();
    } finally {
      hub.close();
      value.storage.close();
    }
  });
});

describe('verification publishes live progress', () => {
  test('publishes output liveness with sizes only, then settles without claiming a verdict', async () => {
    const fixture = await executedTask({ verificationCommands: [
      { id: 'chatty',
        // The pause forces the pipe to be read in separate chunks, so the chunk-level granularity
        // is observable instead of depending on how one write happens to be buffered.
        argv: ['bash', '-c', 'echo CODEESTRA_RAW_OUTPUT_MARKER; seq 1 20000; sleep 0.3; seq 1 20000'],
        cwd: '.', timeoutSeconds: 60 },
    ] });
    const runner = new VerificationRunner();
    // Interval 0 keeps every output chunk, so this test observes the raw granularity the Runtime
    // reports. Production coalesces to at most one event per 100 ms per command.
    const service = createService(fixture, runner, 0);
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
        .state !== 'IN_PROGRESS', 30_000);

      const published = fixture.value.storage.listOperationProgressEvents(operationId);
      const output = published.filter((row) => row.phase === 'OUTPUT');
      expect(output.length).toBeGreaterThanOrEqual(2);
      const sequences = published.map((row) => row.progressSequence);
      expect([...sequences].sort((left, right) => left - right)).toEqual(sequences);
      expect(output[0]?.detail).toMatchObject({ commandId: 'chatty', stream: 'STDOUT', chunkIndex: 0 });
      expect(Number(output[0]?.detail['stdoutBytes'])).toBeGreaterThan(0);
      const last = output.at(-1);
      expect(Number(last?.detail['stdoutBytes'])).toBeGreaterThan(Number(output[0]?.detail['stdoutBytes']));
      // Raw command output never becomes a fact: only sizes and elapsed time do. (The command line
      // itself does appear in the STARTED step's `argv`, which is the frozen policy command the user
      // already approved — not command output.)
      const serialized = JSON.stringify(output.map((row) => row.detail));
      expect(serialized).not.toContain('CODEESTRA_RAW_OUTPUT_MARKER');
      expect(serialized).not.toContain('19999');

      // Filtered to this Operation: the fixture also ran an Agent, whose own progress is a
      // different Operation with its own sequence.
      const progressed = eventsOfType(fixture.value.storage, fixture.value.projectId,
        'OperationProgressed').filter((event) => event.aggregateId === operationId);
      const settledEvents = eventsOfType(fixture.value.storage, fixture.value.projectId,
        'OperationSettled').filter((event) => event.aggregateId === operationId);
      // The verdict appears exactly once, in the verification's own event — never in progress.
      const completed = eventsOfType(fixture.value.storage, fixture.value.projectId,
        'VerificationCompleted').filter((event) => event.aggregateId === verificationId);
      expect(completed).toHaveLength(1);
      expect(completed[0]?.payload).toMatchObject({ state: 'PASSED' });
      for (const event of [...progressed, ...settledEvents]) {
        expect(event.payload['verdict']).toBe(false);
        expect(event.payload['state']).toBeUndefined();
      }
      expect(settledEvents[0]?.payload).toMatchObject({
        kind: 'RUN_TASK_VERIFICATION', operationState: 'SUCCEEDED', verdict: false,
      });
      // The step events are the durable boundaries in the same order they were reached.
      expect(progressed.filter((event) => event.payload['phase'] === 'STEP')
        .map((event) => event.payload['stepKey']))
        .toEqual([operationSteps.verificationQueued, operationSteps.verificationCopy,
          operationSteps.commandStarted('chatty'), operationSteps.commandFinished('chatty')]);
    } finally {
      await service.close();
      await runner.close();
      fixture.value.storage.close();
    }
  });

  test('coalesces output events when a command is chatty', async () => {
    const fixture = await executedTask({ verificationCommands: [
      { id: 'chatty',
        argv: ['bash', '-c', 'seq 1 20000; sleep 0.3; seq 1 20000'],
        cwd: '.', timeoutSeconds: 60 },
    ] });
    const runner = new VerificationRunner();
    const service = createService(fixture, runner, 60_000);
    try {
      const started = await service.startVerification({
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        commandId: crypto.randomUUID(),
        background: true,
      });
      if (!started.background) throw new Error('background verification did not return a handle');
      await waitFor(() => fixture.value.storage
        .getOperation(fixture.value.projectId, started.handle.operationId)
        .state !== 'IN_PROGRESS', 30_000);
      const output = fixture.value.storage
        .listOperationProgressEvents(started.handle.operationId)
        .filter((row) => row.phase === 'OUTPUT');
      // The first chunk is always published so a command that produced anything is visible; the
      // floor then bounds the rate. The terminal step still carries the true final byte counts.
      expect(output).toHaveLength(1);
      expect(output[0]?.detail).toMatchObject({ chunkIndex: 0 });
      const finish = fixture.value.storage
        .getOperation(fixture.value.projectId, started.handle.operationId)
        .steps.find((step) => step.stepKey === operationSteps.commandFinished('chatty'));
      expect(Number(finish?.detail?.['stdoutBytes']))
        .toBeGreaterThan(Number(output[0]?.detail['stdoutBytes']));
    } finally {
      await service.close();
      await runner.close();
      fixture.value.storage.close();
    }
  });

  test('an accepted background verification is never reported as passed by progress', async () => {
    const fixture = await executedTask({ verificationCommands: [
      { id: 'slow', argv: ['bash', '-c', 'sleep 0.4; echo done'], cwd: '.', timeoutSeconds: 60 },
    ] });
    const runner = new VerificationRunner();
    const service = createService(fixture, runner, 0);
    try {
      const started = await service.startVerification({
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        commandId: crypto.randomUUID(),
        background: true,
      });
      if (!started.background) throw new Error('background verification did not return a handle');
      // The handle is an acceptance, not a verdict: it says nothing about passing.
      expect(started.handle.state).toBe('RUNNING');
      expect(started.handle.message).toContain('background');
      const duringRun = eventsOfType(fixture.value.storage, fixture.value.projectId,
        'OperationProgressed');
      expect(eventsOfType(fixture.value.storage, fixture.value.projectId, 'VerificationCompleted'))
        .toHaveLength(0);
      for (const event of duringRun) {
        expect(event.payload['verdict']).toBe(false);
        expect(JSON.stringify(event.payload)).not.toContain('PASSED');
      }
      await waitFor(() => fixture.value.storage
        .getOperation(fixture.value.projectId, started.handle.operationId)
        .state !== 'IN_PROGRESS', 30_000);
      // Only once the run itself recorded a verdict does PASSED appear, in its own event.
      expect(eventsOfType(fixture.value.storage, fixture.value.projectId, 'VerificationCompleted')[0]
        ?.payload).toMatchObject({ state: 'PASSED' });
    } finally {
      await service.close();
      await runner.close();
      fixture.value.storage.close();
    }
  });
});

describe('task.run progress events', () => {
  test('publishes each run boundary and its settle without claiming the result was captured', async () => {
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
      await coordinator.runTask({
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        commandId, adapterId: adapter.id,
      });
      await coordinator.settle();
      await waitFor(() => value.storage.listTaskOperations(value.projectId, value.taskId)
        .every((operation) => operation.state !== 'IN_PROGRESS'), 10_000);
      const operation = value.storage.listTaskOperations(value.projectId, value.taskId)[0];
      if (operation === undefined) throw new Error('run Operation was not recorded');
      const progressed = eventsOfType(value.storage, value.projectId, 'OperationProgressed')
        .filter((event) => event.payload['kind'] === 'RUN_TASK');
      expect(progressed.map((event) => event.payload['stepKey'])).toEqual([
        operationSteps.runRequested,
        operationSteps.workspacePrepared,
        operationSteps.executionReserved,
        operationSteps.agentSessionStarted,
        operationSteps.agentSettled,
      ]);
      const settled = eventsOfType(value.storage, value.projectId, 'OperationSettled')
        .filter((event) => event.payload['kind'] === 'RUN_TASK');
      expect(settled).toHaveLength(1);
      // The run settled; that is not a captured result and not a verification.
      expect(settled[0]?.payload).toMatchObject({
        operationState: 'SUCCEEDED', verdict: false, taskId: value.taskId,
      });
      expect(JSON.stringify(settled[0]?.payload)).not.toContain('PASSED');
      // A replayed command re-records a step but re-publishes nothing: progress is idempotent.
      const stepsBefore = value.storage.listOperationProgressEvents(operation.operationId).length;
      await coordinator.runTask({
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        commandId, adapterId: adapter.id,
      });
      expect(eventsOfType(value.storage, value.projectId, 'OperationProgressed')
        .filter((event) => event.payload['kind'] === 'RUN_TASK').length)
        .toBe(progressed.length);
      expect(value.storage.listOperationProgressEvents(operation.operationId).length)
        .toBe(stepsBefore);
    } finally {
      await coordinator.close();
      value.storage.close();
    }
  });
});
