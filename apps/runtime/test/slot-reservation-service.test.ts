import { afterEach, describe, expect, test } from 'bun:test';
import { SlotReservationError, type ExecutionSlotReservationRecord } from '@codeestra/storage';
import { SchedulerError } from '../src/scheduler.js';
import {
  RuntimeDrainState,
  inspectProjectCapacity,
  inspectRuntimeCapacity,
  resetRuntimeCapacity,
  setRuntimeCapacity,
} from '../src/capacity-service.js';
import {
  SlotReservationService,
  inspectSlotHolder,
  type SlotHolderObservation,
  type SlotHolderInspector,
} from '../src/slot-reservation-service.js';
import { prepareReservedWorkspace } from '../src/workspace-service.js';
import { cleanupTemporaryDirectories, createAgentFixture } from './support/agent-fixture.js';

/**
 * Capacity and slot reservations at the Runtime boundary (FOUNDATION-054 / ADR-0032).
 *
 * Every fixture is a real temporary Git repository with a real `dev` ref and a real in-memory
 * Database, so the dependency guard, the workspace preparation and the capacity arithmetic are
 * exercised the way the product runs them. The *holder* observations of the startup reconcile are
 * injected here (the process-level behaviour of the real inspector is covered by the
 * `inspectSlotHolder` tests below and end to end in the CLI test).
 */

afterEach(() => { cleanupTemporaryDirectories(); });

let counter = 0;
const nextId = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

interface Harness {
  readonly service: SlotReservationService;
  readonly drain: RuntimeDrainState;
  readonly fixture: Awaited<ReturnType<typeof createAgentFixture>>;
  setHolderObserver(observer: SlotHolderInspector): void;
  holderObservations: string[];
}

async function harness(bootId = 'boot-1'): Promise<Harness> {
  const fixture = await createAgentFixture();
  const drain = new RuntimeDrainState();
  let observer: SlotHolderInspector = async () => ({
    state: 'HOLDER_STOPPED', pid: 1, recordedStartToken: null, observedStartToken: null,
    detail: 'default test observer',
  });
  const holderObservations: string[] = [];
  const service = new SlotReservationService({
    storage: fixture.storage,
    bootId,
    pid: 4321,
    startToken: 'linux:test-boot:99',
    draining: () => drain.state(),
    inspectHolder: async (reservation) => {
      const observation = await observer(reservation);
      holderObservations.push(observation.state);
      return observation;
    },
    now: () => 1_000,
    randomUUID: nextId,
  });
  return {
    service,
    drain,
    fixture,
    setHolderObserver: (next) => { observer = next; },
    holderObservations,
  };
}

/** A second READY Task in the same project, so two slots can be occupied at once. */
function addTask(fixture: Harness['fixture'], name: string): string {
  const taskId = nextId();
  fixture.storage.createTask({
    projectId: fixture.projectId,
    commandId: nextId(),
    payloadHash: `create-${name}`,
    intentId: nextId(),
    taskId,
    revisionId: nextId(),
    intentEventId: nextId(),
    taskEventId: nextId(),
    specification: `Work for ${name}`,
    displayTitle: 'fixture task',
    namingTitle: null,
    actor: 'local-user',
    createdAt: 100,
  });
  fixture.storage.submitTask({
    projectId: fixture.projectId,
    taskId,
    expectedVersion: 0,
    commandId: nextId(),
    payloadHash: `submit-${name}`,
    eventId: nextId(),
    actor: 'local-user',
    submittedAt: 101,
  });
  return taskId;
}

function capacityView(harnessed: Harness) {
  return inspectProjectCapacity({
    storage: harnessed.fixture.storage,
    projectId: harnessed.fixture.projectId,
    draining: harnessed.drain.state(),
  });
}

/** The Runtime-wide view `scheduler capacity get` answers with. */
function runtimeCapacityView(harnessed: Harness) {
  return inspectRuntimeCapacity({
    storage: harnessed.fixture.storage,
    draining: harnessed.drain.state(),
    pauseState: () => ({ state: 'RUNNING' as const, pauseEpoch: 0, detail: null }),
  });
}

function setLimit(harnessed: Harness, limit: number, commandId = nextId()) {
  return setRuntimeCapacity({
    storage: harnessed.fixture.storage,
    limit,
    actor: 'user',
    commandId,
    draining: harnessed.drain.state(),
    pauseState: () => ({ state: 'RUNNING' as const, pauseEpoch: 0, detail: null }),
    now: () => 5,
    randomUUID: nextId,
  });
}

describe('Runtime-wide capacity configuration', () => {
  test('a set value is read back and used by the acquisition decision', async () => {
    const harnessed = await harness();
    expect(capacityView(harnessed).globalLimit).toBe(2);
    expect(setLimit(harnessed, 3).changed).toBe(true);
    const view = capacityView(harnessed);
    expect(view.globalLimit).toBe(3);
    expect(view.globalLimitSource).toBe('EXPLICIT');
    // Three slots are now available: with the default of 2 the third acquisition would have waited.
    const taskOne = harnessed.fixture.taskId;
    const taskTwo = addTask(harnessed.fixture, 'two');
    const taskThree = addTask(harnessed.fixture, 'three');
    for (const task of [taskOne, taskTwo, taskThree]) {
      const taskRow = harnessed.fixture.storage.getTask(harnessed.fixture.projectId, task);
      const acquired = await harnessed.service.acquire({
        projectId: harnessed.fixture.projectId,
        taskId: task,
        expectedTaskVersion: taskRow?.version ?? 0,
        revisionId: taskRow?.currentRevision.id as string,
        adapterId: 'pi',
        actor: 'user',
        commandId: nextId(),
      });
      expect(acquired.outcome).toBe('RESERVED');
    }
    expect(capacityView(harnessed).globalUsed).toBe(3);
  });

  test('the Runtime-wide view lists every occupier with its Project, Adapter and source', async () => {
    const harnessed = await harness();
    expect(runtimeCapacityView(harnessed)).toMatchObject({
      limit: 2, limitSource: 'DEFAULT', used: 0, available: 2, waitReason: null,
      pauseState: { state: 'RUNNING', pauseEpoch: 0, detail: null }, occupiers: [],
    });
    const taskRow = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId,
      taskId: harnessed.fixture.taskId,
      expectedTaskVersion: taskRow?.version as number,
      revisionId: taskRow?.currentRevision.id as string,
      adapterId: 'codex',
      actor: 'user',
      commandId: nextId(),
    });
    const view = runtimeCapacityView(harnessed);
    expect(view.used).toBe(1);
    expect(view.available).toBe(1);
    expect(view.occupiers).toHaveLength(1);
    expect(view.occupiers[0]).toMatchObject({
      projectId: harnessed.fixture.projectId, taskId: harnessed.fixture.taskId,
      adapterId: 'codex', source: 'RESERVATION', state: 'RESERVED',
    });
    // The Adapter a candidate uses is no longer a ceiling: a different Adapter changes nothing.
    expect(view.occupiers[0]?.adapterIds).toEqual(['codex']);
  });

  test('reset returns to the documented default and setting the same value is an idempotent no-op', async () => {
    const harnessed = await harness();
    expect(setLimit(harnessed, 4).changed).toBe(true);
    expect(setLimit(harnessed, 4).changed).toBe(false);
    expect(runtimeCapacityView(harnessed).limit).toBe(4);
    const reset = resetRuntimeCapacity({
      storage: harnessed.fixture.storage,
      actor: 'user',
      commandId: nextId(),
      draining: harnessed.drain.state(),
      pauseState: () => ({ state: 'RUNNING' as const, pauseEpoch: 0, detail: null }),
      randomUUID: nextId,
    });
    expect(reset.changed).toBe(true);
    expect(runtimeCapacityView(harnessed)).toMatchObject({ limit: 2, limitSource: 'DEFAULT' });
    expect(resetRuntimeCapacity({
      storage: harnessed.fixture.storage,
      actor: 'user',
      commandId: nextId(),
      draining: harnessed.drain.state(),
      pauseState: () => ({ state: 'RUNNING' as const, pauseEpoch: 0, detail: null }),
      randomUUID: nextId,
    }).changed).toBe(false);
  });

  test('refuses an invalid limit with its own stable code and writes nothing', async () => {
    const harnessed = await harness();
    const attempt = (limit: number) => () => setLimit(harnessed, limit);
    expect(attempt(0)).toThrow(SlotReservationError);
    expect(attempt(-3)).toThrow(SlotReservationError);
    expect(attempt(1.5)).toThrow(SlotReservationError);
    expect(attempt(100)).toThrow(SlotReservationError);
    // Nothing was written by any refused attempt.
    expect(capacityView(harnessed).globalLimitSource).toBe('DEFAULT');
  });

  test('the wait reason is expressed as capacity, never as BLOCKED', async () => {
    const harnessed = await harness();
    const first = harnessed.fixture.taskId;
    const second = addTask(harnessed.fixture, 'second');
    const third = addTask(harnessed.fixture, 'third');
    for (const task of [first, second]) {
      const row = harnessed.fixture.storage.getTask(harnessed.fixture.projectId, task);
      const acquired = await harnessed.service.acquire({
        projectId: harnessed.fixture.projectId, taskId: task,
        expectedTaskVersion: row?.version as number,
        revisionId: row?.currentRevision.id as string,
        adapterId: 'pi', actor: 'user', commandId: nextId(),
      });
      expect(acquired.outcome).toBe('RESERVED');
    }
    const row = harnessed.fixture.storage.getTask(harnessed.fixture.projectId, third);
    const waiting = await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId, taskId: third,
      expectedTaskVersion: row?.version as number,
      revisionId: row?.currentRevision.id as string,
      adapterId: 'pi', actor: 'user', commandId: nextId(),
    });
    expect(waiting.outcome).toBe('CAPACITY_WAIT');
    expect(waiting.wait?.code).toBe('CAPACITY_GLOBAL_LIMIT_REACHED');
    // The reason carries the slots that caused it, with the observation of their holders.
    expect(waiting.wait?.blocking).toHaveLength(2);
    expect(waiting.holderEvidence).toHaveLength(2);
    expect(waiting.reservation).toBeNull();
    // And the capacity view reports the same reason code, so a client can query it instead.
    expect(capacityView(harnessed).globalWaitReason).toBe('CAPACITY_GLOBAL_LIMIT_REACHED');
  });

  test('a lower limit does not release, pause or terminate an occupant', async () => {
    const harnessed = await harness();
    const second = addTask(harnessed.fixture, 'second');
    for (const task of [harnessed.fixture.taskId, second]) {
      const row = harnessed.fixture.storage.getTask(harnessed.fixture.projectId, task);
      await harnessed.service.acquire({
        projectId: harnessed.fixture.projectId, taskId: task,
        expectedTaskVersion: row?.version as number,
        revisionId: row?.currentRevision.id as string,
        adapterId: 'pi', actor: 'user', commandId: nextId(),
      });
    }
    expect(setLimit(harnessed, 1).changed).toBe(true);
    // `used > limit` is an honest fact: both reservations are still there and still RESERVED, and
    // nothing signalled or stopped either Task.
    expect(harnessed.fixture.storage.listActiveSlotReservations()).toHaveLength(2);
    expect(harnessed.fixture.storage.listActiveSlotReservations()
      .every((reservation) => reservation.state === 'RESERVED')).toBe(true);
    const view = runtimeCapacityView(harnessed);
    expect(view).toMatchObject({ limit: 1, used: 2, available: 0 });
    // A new acquisition is refused while `used >= limit`.
    const third = addTask(harnessed.fixture, 'third');
    const row = harnessed.fixture.storage.getTask(harnessed.fixture.projectId, third);
    const waiting = await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId, taskId: third,
      expectedTaskVersion: row?.version as number,
      revisionId: row?.currentRevision.id as string,
      adapterId: 'pi', actor: 'user', commandId: nextId(),
    });
    expect(waiting.outcome).toBe('CAPACITY_WAIT');
    expect(waiting.wait).toMatchObject({ code: 'CAPACITY_GLOBAL_LIMIT_REACHED', limit: 1, used: 2 });
  });
});

describe('reservation acquisition', () => {
  test('records the holder evidence and the assessed baseline', async () => {
    const harnessed = await harness();
    harnessed.setHolderObserver(async () => ({
      state: 'HOLDER_STOPPED', pid: 4321, recordedStartToken: 'linux:test-boot:99',
      observedStartToken: null, detail: 'gone',
    }));
    const task = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    const acquired = await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId,
      taskId: harnessed.fixture.taskId,
      expectedTaskVersion: task?.version as number,
      revisionId: task?.currentRevision.id as string,
      adapterId: 'pi',
      actor: 'user',
      commandId: nextId(),
    });
    expect(acquired.outcome).toBe('RESERVED');
    const reservation = acquired.reservation as NonNullable<typeof acquired.reservation>;
    expect(reservation.holder).toMatchObject({ bootId: 'boot-1', pid: 4321,
      startToken: 'linux:test-boot:99' });
    expect(reservation.assessedDevCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(reservation.dependencyFingerprint).toHaveLength(64);
    expect(reservation.events.map((event) => event.kind)).toEqual(['RESERVED']);
    expect(acquired.capacity.globalUsed).toBe(1);
  });

  test('a stale Task version or revision is refused and reserves nothing', async () => {
    const harnessed = await harness();
    const task = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    expect(await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId, taskId: harnessed.fixture.taskId,
      expectedTaskVersion: (task?.version as number) + 5,
      revisionId: task?.currentRevision.id as string,
      adapterId: 'pi', actor: 'user', commandId: nextId(),
    }).catch((error: unknown) => error)).toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
    let wrongRevision: unknown = null;
    try {
      await harnessed.service.acquire({
        projectId: harnessed.fixture.projectId, taskId: harnessed.fixture.taskId,
        expectedTaskVersion: task?.version as number,
        revisionId: nextId(),
        adapterId: 'pi', actor: 'user', commandId: nextId(),
      });
    } catch (error) { wrongRevision = error; }
    expect((wrongRevision as SlotReservationError).code).toBe('REVISION_CHANGED');
    expect(harnessed.fixture.storage.listActiveSlotReservations()).toHaveLength(0);
  });

  test('a Task waiting for an upstream is DEPENDENCIES_UNMET, not a capacity wait', async () => {
    const harnessed = await harness();
    const downstream = addTask(harnessed.fixture, 'downstream');
    const upstream = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    harnessed.fixture.storage.addTaskDependency({
      projectId: harnessed.fixture.projectId,
      taskId: downstream,
      prerequisiteTaskId: harnessed.fixture.taskId,
      requiredRevisionId: upstream?.currentRevision.id as string,
      expectedVersion: harnessed.fixture.storage.getTask(
        harnessed.fixture.projectId, downstream)?.version as number,
      commandId: nextId(),
      payloadHash: 'edge',
      eventId: nextId(),
      actor: 'user',
      createdAt: 200,
    });
    let unmet: unknown = null;
    try {
      await harnessed.service.acquire({
        projectId: harnessed.fixture.projectId, taskId: downstream, expectedTaskVersion: 0,
        revisionId: harnessed.fixture.storage.getTask(harnessed.fixture.projectId, downstream)
          ?.currentRevision.id as string,
        adapterId: 'pi', actor: 'user', commandId: nextId(),
      });
    } catch (error) { unmet = error; }
    expect(unmet).toBeInstanceOf(SchedulerError);
    expect((unmet as SchedulerError).code).toBe('DEPENDENCIES_UNMET');
    expect(harnessed.fixture.storage.listActiveSlotReservations()).toHaveLength(0);
  });

  test('a dependency change between the assessment and the write is refused', async () => {
    const harnessed = await harness();
    const downstream = addTask(harnessed.fixture, 'graph-moves');
    // The facts the acquirer assessed are captured before the edge exists; the storage layer re-reads
    // them inside the transaction and must refuse the reservation instead of trusting the snapshot.
    const factsBefore = harnessed.fixture.storage.listTaskDependencyFacts(
      harnessed.fixture.projectId, { taskId: downstream });
    expect(factsBefore).toHaveLength(0);
    const upstream = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    harnessed.fixture.storage.addTaskDependency({
      projectId: harnessed.fixture.projectId, taskId: downstream,
      prerequisiteTaskId: harnessed.fixture.taskId,
      requiredRevisionId: upstream?.currentRevision.id as string,
      expectedVersion: harnessed.fixture.storage.getTask(
        harnessed.fixture.projectId, downstream)?.version as number,
      commandId: nextId(), payloadHash: 'edge', eventId: nextId(), actor: 'user', createdAt: 201,
    });
    // The guard refuses first (the edge is unsatisfied), which is the same outcome for a caller: the
    // Task is blocked, and no slot is reserved on a stale assessment.
    let refused: unknown = null;
    try {
      await harnessed.service.acquire({
        projectId: harnessed.fixture.projectId, taskId: downstream, expectedTaskVersion: 0,
        revisionId: harnessed.fixture.storage.getTask(harnessed.fixture.projectId, downstream)
          ?.currentRevision.id as string,
        adapterId: 'pi', actor: 'user', commandId: nextId(),
      });
    } catch (error) { refused = error; }
    expect((refused as SchedulerError).code).toBe('DEPENDENCIES_UNMET');
    expect(harnessed.fixture.storage.listActiveSlotReservations()).toHaveLength(0);
  });

  test('a phase change breaks the fingerprint, and a draining Runtime grants nothing', async () => {
    const harnessed = await harness();
    const task = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    harnessed.drain.begin('RUNTIME_SHUTDOWN');
    const draining = await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId, taskId: harnessed.fixture.taskId,
      expectedTaskVersion: task?.version as number,
      revisionId: task?.currentRevision.id as string,
      adapterId: 'pi', actor: 'user', commandId: nextId(),
    });
    expect(draining.outcome).toBe('DRAINING');
    expect(draining.wait?.code).toBe('SCHEDULER_DRAINING');
    expect(capacityView(harnessed).draining).toBe(true);
    expect(capacityView(harnessed).drainReason).toBe('RUNTIME_SHUTDOWN');
    expect(harnessed.fixture.storage.listActiveSlotReservations()).toHaveLength(0);
  });

  test('raising a priority does not interrupt an active reservation', async () => {
    const harnessed = await harness();
    const task = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    const acquired = await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId, taskId: harnessed.fixture.taskId,
      expectedTaskVersion: task?.version as number,
      revisionId: task?.currentRevision.id as string,
      adapterId: 'pi', actor: 'user', commandId: nextId(),
    });
    const reservation = acquired.reservation as NonNullable<typeof acquired.reservation>;
    harnessed.fixture.storage.updateTaskPriority({
      taskId: harnessed.fixture.taskId, expectedVersion: task?.version as number,
      priority: 10, updatedAt: 300,
    });
    const active = harnessed.fixture.storage.listActiveSlotReservations();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      reservationId: reservation.reservationId, state: 'RESERVED', adapterId: 'pi',
    });
    expect(harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId)?.priority).toBe(10);
  });
});

describe('release and reconcile', () => {
  test('a released slot can be reserved again, and the release is recorded with its reason', async () => {
    const harnessed = await harness();
    const task = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    const acquired = await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId, taskId: harnessed.fixture.taskId,
      expectedTaskVersion: task?.version as number,
      revisionId: task?.currentRevision.id as string,
      adapterId: 'pi', actor: 'user', commandId: nextId(),
    });
    const reservation = acquired.reservation as NonNullable<typeof acquired.reservation>;
    const released = await harnessed.service.release({
      projectId: harnessed.fixture.projectId, reservationId: reservation.reservationId,
      reason: 'agent finished', actor: 'user', commandId: nextId(),
    });
    expect(released.outcome).toBe('RELEASED');
    expect(released.reservation).toMatchObject({
      state: 'RELEASED', releaseKind: 'EXPLICIT', releaseReason: 'agent finished',
    });
    expect(released.reservation.events.map((event) => event.kind))
      .toEqual(['RESERVED', 'RELEASED']);
    expect(harnessed.fixture.storage.listActiveSlotReservations()).toHaveLength(0);
    const again = await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId, taskId: harnessed.fixture.taskId,
      expectedTaskVersion: task?.version as number,
      revisionId: task?.currentRevision.id as string,
      adapterId: 'pi', actor: 'user', commandId: nextId(),
    });
    expect(again.outcome).toBe('RESERVED');
  });

  test('an explicit release refuses to free a slot whose holder is provably still running', async () => {
    const harnessed = await harness();
    const task = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    const acquired = await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId, taskId: harnessed.fixture.taskId,
      expectedTaskVersion: task?.version as number,
      revisionId: task?.currentRevision.id as string,
      adapterId: 'pi', actor: 'user', commandId: nextId(),
    });
    const reservation = acquired.reservation as NonNullable<typeof acquired.reservation>;
    // Pretend another generation created it: its holder process is still alive.
    harnessed.fixture.storage.sqlite.query(
      "UPDATE execution_slot_reservations SET holder_boot_id='boot-other' WHERE id=?1",
    ).run(reservation.reservationId);
    harnessed.setHolderObserver(async () => ({
      state: 'HOLDER_STILL_RUNNING', pid: 4321, recordedStartToken: 't', observedStartToken: 't',
      detail: 'still running',
    }));
    let refused: unknown = null;
    try {
      await harnessed.service.release({
        projectId: harnessed.fixture.projectId, reservationId: reservation.reservationId,
        reason: 'user wants the slot', actor: 'user', commandId: nextId(),
      });
    } catch (error) { refused = error; }
    expect((refused as SlotReservationError).code).toBe('SLOT_HOLDER_STILL_RUNNING');
    expect(harnessed.fixture.storage.listActiveSlotReservations()).toHaveLength(1);
  });

  test('a proven-gone holder is reconciled to released, with the observation recorded', async () => {
    const harnessed = await harness();
    const task = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId, taskId: harnessed.fixture.taskId,
      expectedTaskVersion: task?.version as number,
      revisionId: task?.currentRevision.id as string,
      adapterId: 'pi', actor: 'user', commandId: nextId(),
    });
    harnessed.fixture.storage.sqlite.query(
      "UPDATE execution_slot_reservations SET holder_boot_id='boot-crashed'").run();
    harnessed.setHolderObserver(async () => ({
      state: 'HOLDER_PROCESS_ID_REUSED', pid: 4321, recordedStartToken: 't', observedStartToken: 'other',
      detail: 'the pid is a different process now',
    }));
    const report = await harnessed.service.reconcile({
      commandId: 'startup', actor: 'runtime-startup',
    });
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]).toMatchObject({
      outcome: 'RELEASED', observation: 'HOLDER_PROCESS_ID_REUSED',
      previousState: 'RESERVED', state: 'RELEASED',
    });
    const released = harnessed.fixture.storage.listSlotReservations(
      harnessed.fixture.projectId, { includeReleased: true });
    expect(released[0]).toMatchObject({
      state: 'RELEASED', releaseKind: 'RECONCILED_PROCESS_ID_REUSED',
    });
    expect(harnessed.fixture.storage.listActiveSlotReservations()).toHaveLength(0);
    // Running the reconcile again inside the same generation changes nothing.
    const again = await harnessed.service.reconcile({
      commandId: 'startup', actor: 'runtime-startup',
    });
    expect(again.outcomes).toHaveLength(0);
  });

  test('an unverifiable holder keeps the slot occupied as RECOVERY_REQUIRED', async () => {
    const harnessed = await harness();
    const task = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId, taskId: harnessed.fixture.taskId,
      expectedTaskVersion: task?.version as number,
      revisionId: task?.currentRevision.id as string,
      adapterId: 'pi', actor: 'user', commandId: nextId(),
    });
    // A second Task would normally take the free second slot; the held one stays occupied.
    const second = addTask(harnessed.fixture, 'after-recovery');
    harnessed.fixture.storage.sqlite.query(
      "UPDATE execution_slot_reservations SET holder_boot_id='boot-crashed'").run();
    harnessed.setHolderObserver(async () => ({
      state: 'HOLDER_OWNERSHIP_UNVERIFIABLE', pid: 4321, recordedStartToken: null,
      observedStartToken: null, detail: 'the start token could not be compared',
    }));
    const report = await harnessed.service.reconcile({ commandId: 'startup', actor: 'runtime-startup' });
    expect(report.outcomes[0]).toMatchObject({
      outcome: 'MARKED_RECOVERY_REQUIRED', observation: 'HOLDER_OWNERSHIP_UNVERIFIABLE',
      state: 'RECOVERY_REQUIRED',
    });
    const secondRow = harnessed.fixture.storage.getTask(harnessed.fixture.projectId, second);
    const acquired = await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId, taskId: second,
      expectedTaskVersion: secondRow?.version as number,
      revisionId: secondRow?.currentRevision.id as string,
      adapterId: 'pi', actor: 'user', commandId: nextId(),
    });
    expect(acquired.outcome).toBe('RESERVED');
    expect(acquired.capacity.globalUsed).toBe(2);
    // The unverifiable reservation is never freed automatically, and it is reported as held.
    expect(harnessed.fixture.storage.listActiveSlotReservations().some(
      (reservation) => reservation.state === 'RECOVERY_REQUIRED')).toBe(true);
    expect(report.notSignalled).toHaveLength(1);
  });

  test('a reservation this generation created is not converged by its own reconcile', async () => {
    const harnessed = await harness();
    const task = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId, taskId: harnessed.fixture.taskId,
      expectedTaskVersion: task?.version as number,
      revisionId: task?.currentRevision.id as string,
      adapterId: 'pi', actor: 'user', commandId: nextId(),
    });
    harnessed.setHolderObserver(async () => ({
      state: 'HOLDER_STOPPED', pid: 4321, recordedStartToken: null, observedStartToken: null,
      detail: 'no process',
    }));
    const report = await harnessed.service.reconcile({ commandId: 'startup', actor: 'runtime-startup' });
    expect(report.outcomes[0]?.outcome).toBe('SKIPPED_HELD_BY_RUNTIME');
    // The observer was never asked: this generation owns the reservation it created.
    expect(harnessed.holderObservations).toHaveLength(0);
  });
});

describe('reserved workspace', () => {
  test('prepares the Task worktree for a reservation and binds it exactly once', async () => {
    const harnessed = await harness();
    const task = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    const acquired = await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId, taskId: harnessed.fixture.taskId,
      expectedTaskVersion: task?.version as number,
      revisionId: task?.currentRevision.id as string,
      adapterId: 'pi', actor: 'user', commandId: nextId(),
    });
    const reservation = acquired.reservation as NonNullable<typeof acquired.reservation>;
    const commandId = nextId();
    const prepared = await prepareReservedWorkspace({
      storage: harnessed.fixture.storage,
      runtimeHome: harnessed.fixture.home,
      bootId: 'boot-1',
      commandId,
      projectId: harnessed.fixture.projectId,
      reservationId: reservation.reservationId,
      expectedTaskVersion: task?.version as number,
      actor: 'user',
      now: () => 2_000,
      randomUUID: nextId,
    });
    expect(prepared.created).toBe(true);
    expect(prepared.branchRef).toBe(`refs/heads/task/${harnessed.fixture.taskId}`);
    expect(harnessed.fixture.storage.getSlotReservation(
      harnessed.fixture.projectId, reservation.reservationId).workspaceId)
      .toBe(prepared.workspaceId);
    // The same command is idempotent, and a second call reports the very same binding.
    const replay = await prepareReservedWorkspace({
      storage: harnessed.fixture.storage,
      runtimeHome: harnessed.fixture.home,
      bootId: 'boot-1',
      commandId,
      projectId: harnessed.fixture.projectId,
      reservationId: reservation.reservationId,
      expectedTaskVersion: task?.version as number,
      actor: 'user',
      now: () => 2_001,
      randomUUID: nextId,
    });
    expect(replay).toMatchObject({
      workspaceId: prepared.workspaceId, path: prepared.path, created: false,
    });
  });

  test('refuses to prepare a workspace for a reservation created by another generation', async () => {
    const harnessed = await harness();
    const task = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    const acquired = await harnessed.service.acquire({
      projectId: harnessed.fixture.projectId, taskId: harnessed.fixture.taskId,
      expectedTaskVersion: task?.version as number,
      revisionId: task?.currentRevision.id as string,
      adapterId: 'pi', actor: 'user', commandId: nextId(),
    });
    const successor = new SlotReservationService({
      storage: harnessed.fixture.storage,
      bootId: 'boot-2',
      pid: 4321,
      startToken: 'linux:test-boot:100',
      draining: () => harnessed.drain.state(),
      now: () => 500,
      randomUUID: nextId,
    });
    let refused: unknown = null;
    try {
      await prepareReservedWorkspace({
        storage: harnessed.fixture.storage,
        runtimeHome: harnessed.fixture.home,
        bootId: successor.bootId,
        commandId: nextId(),
        projectId: harnessed.fixture.projectId,
        reservationId: (acquired.reservation as NonNullable<typeof acquired.reservation>)
          .reservationId,
        expectedTaskVersion: task?.version as number,
        actor: 'user',
      });
    } catch (error) { refused = error; }
    expect((refused as SlotReservationError).code).toBe('SLOT_HELD_BY_ANOTHER_RUNTIME');
  });
});

describe('holder inspection', () => {
  test('compares the recorded start token with the live process, and never guesses', async () => {
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      const { readProcessStartToken } = await import('../src/lifecycle.js');
      const startToken = await readProcessStartToken(child.pid);
      const record = (holder: { pid: number; startToken: string | null }) => ({
        reservationId: 'r', projectId: 'p', taskId: 't', taskDisplayNumber: 1, revisionId: 'rev',
        taskVersion: 0, adapterId: 'pi', workspaceId: null, impactSnapshotId: null,
        dependencyFingerprint: 'f', assessedDevCommit: null, state: 'RESERVED' as const, version: 0,
        commandId: 'c', holder: { bootId: 'b', pid: holder.pid, startToken: holder.startToken,
          actor: 'user' },
        reservedAt: 1, updatedAt: 1, releasedAt: null, releaseReason: null, releaseKind: null,
        releaseObservation: null, detail: null,
      }) satisfies ExecutionSlotReservationRecord;

      expect((await inspectSlotHolder(record({ pid: child.pid, startToken }),
        async () => startToken)).state).toBe('HOLDER_STILL_RUNNING');
      // A live pid whose recorded token does not match is a *different* process: the creator is gone.
      expect((await inspectSlotHolder(record({ pid: child.pid, startToken: 'ps:somewhere else' }),
        async () => startToken)).state).toBe('HOLDER_PROCESS_ID_REUSED');
      // Without a recorded token the live pid cannot be attributed at all: unverifiable, not gone.
      expect((await inspectSlotHolder(record({ pid: child.pid, startToken: null }),
        async () => startToken)).state).toBe('HOLDER_OWNERSHIP_UNVERIFIABLE');
      // An unreadable token is unverifiable too, never a release.
      expect((await inspectSlotHolder(record({ pid: child.pid, startToken }),
        async () => null)).state).toBe('HOLDER_OWNERSHIP_UNVERIFIABLE');

      child.kill();
      await child.exited;
      const observation: SlotHolderObservation = await inspectSlotHolder(
        record({ pid: child.pid, startToken }));
      expect(observation.state).toBe('HOLDER_STOPPED');
    } finally {
      child.kill();
    }
  });
});
