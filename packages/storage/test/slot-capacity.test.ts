import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { defaultConcurrencyLimit } from '@codeestra/contracts';
import {
  Phase1Database,
  SlotReservationError,
  StorageError,
  slotDependencyFingerprint,
  type SlotReservationAcquireInput,
} from '../src/index.js';

/**
 * Runtime capacity and the reservation primitive at the storage boundary (FOUNDATION-096 / ADR-0061).
 *
 * These tests deliberately drive the storage layer directly: the Git question ("is the pinned
 * upstream still reachable from `dev`") belongs to the scheduler and is covered by the Runtime-level
 * tests, while everything that must hold *inside one transaction* — the compare-and-swap, the two
 * partial unique indexes, the Runtime-wide capacity arithmetic and the append-only history — is a
 * property of this layer and is asserted here.
 *
 * Two Projects are seeded on purpose: the whole point of ADR-0061 D01 is that occupancy and the limit
 * are counted across every Project, so a single-Project fixture could not tell the new behaviour from
 * the old one.
 */

const oid = 'a'.repeat(40);
let storage: Phase1Database;

function seedProject(projectId: string): void {
  storage.sqlite.query(`INSERT INTO projects
    (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
    VALUES (?1,?1,?2,?2 || '/.git','refs/heads/main','sha1',1)`)
    .run(projectId, `/${projectId}`);
  storage.sqlite.query(`INSERT INTO project_trusts
    (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
    VALUES (?1,?2,?3,?3 || '/.git','sha1',1,'user','ACTIVE',1)`)
    .run(`trust-${projectId}`, projectId, `/${projectId}`);
}

function seedTask(input: {
  readonly projectId: string;
  readonly taskId: string;
  readonly revisionId: string;
  readonly displayNumber: number;
  readonly state?: string;
}): void {
  storage.sqlite.transaction(() => {
    storage.sqlite.query(`INSERT INTO tasks
      (id,project_id,display_number,display_title,naming_title,current_revision_id,state,
        created_at,updated_at)
      VALUES (?1,?2,?3,?1,?1,?4,?5,2,2)`)
      .run(input.taskId, input.projectId, input.displayNumber, input.revisionId,
        input.state ?? 'READY');
    storage.sqlite.query(`INSERT INTO task_revisions
      (id,task_id,number,previous_revision_id,specification,actor,reason,created_at)
      VALUES (?1,?2,1,NULL,'Do work','user','initial',2)`)
      .run(input.revisionId, input.taskId);
  })();
}

function acquireInput(taskId: string, revisionId: string, projectId = 'p1',
  overrides: Partial<SlotReservationAcquireInput> = {}): SlotReservationAcquireInput {
  return {
    projectId,
    taskId,
    reservationId: crypto.randomUUID(),
    expectedTaskVersion: 0,
    expectedRevisionId: revisionId,
    adapterId: 'pi',
    workspaceId: null,
    impactSnapshotId: null,
    dependencyFingerprint: slotDependencyFingerprint(
      storage.listTaskDependencyFacts(projectId, { taskId })),
    assessedDevCommit: oid,
    holder: { bootId: 'boot-1', pid: 4242, startToken: 'linux:boot:42', actor: 'user' },
    draining: () => ({ draining: false, reason: null }),
    commandId: crypto.randomUUID(),
    payloadHash: 'payload',
    eventId: crypto.randomUUID(),
    createdAt: 10,
    ...overrides,
  };
}

beforeEach(() => {
  storage = new Phase1Database();
  seedProject('p1');
  seedProject('p2');
  seedTask({ projectId: 'p1', taskId: 't1', revisionId: 'r1', displayNumber: 1 });
  seedTask({ projectId: 'p1', taskId: 't2', revisionId: 'r2', displayNumber: 2 });
  seedTask({ projectId: 'p1', taskId: 't3', revisionId: 'r3', displayNumber: 3 });
  seedTask({ projectId: 'p2', taskId: 'u1', revisionId: 's1', displayNumber: 1 });
  seedTask({ projectId: 'p2', taskId: 'u2', revisionId: 's2', displayNumber: 2 });
});

afterEach(() => storage.close());

describe('Runtime-wide capacity configuration', () => {
  test('reports the documented default until it is set, and reads a set value back', () => {
    expect(storage.getRuntimeCapacity()).toEqual({
      limit: defaultConcurrencyLimit, limitSource: 'DEFAULT', version: 0,
      updatedAt: null, updatedBy: null,
    });
    const change = storage.setRuntimeCapacityLimit({
      limit: 3, commandId: 'cmd-set-3', payloadHash: 'p', eventId: crypto.randomUUID(),
      actor: 'user', updatedAt: 4,
    });
    expect(change.changed).toBe(true);
    expect(storage.getRuntimeCapacity()).toEqual({
      limit: 3, limitSource: 'EXPLICIT', version: 0, updatedAt: 4, updatedBy: 'user',
    });
  });

  test('setting the value that is already effective is an idempotent no-op', () => {
    const first = storage.setRuntimeCapacityLimit({
      limit: 3, commandId: 'cmd-a', payloadHash: 'p', eventId: crypto.randomUUID(),
      actor: 'user', updatedAt: 4,
    });
    expect(first.changed).toBe(true);
    const again = storage.setRuntimeCapacityLimit({
      limit: 3, commandId: 'cmd-b', payloadHash: 'p', eventId: crypto.randomUUID(),
      actor: 'user', updatedAt: 5,
    });
    expect(again.changed).toBe(false);
    // No version bump and no second event: nothing about the configuration changed.
    expect(storage.getRuntimeCapacity()).toMatchObject({ limit: 3, version: 0, updatedAt: 4 });
    expect(storage.sqlite.query<{ rows: number }, []>(
      "SELECT COUNT(*) AS rows FROM domain_events WHERE event_type='SchedulerGlobalCapacityChanged'",
    ).get()?.rows).toBe(1);
  });

  test('a repeated command id replays its result and a reused key with another payload is refused', () => {
    const input = {
      limit: 4, commandId: 'cmd-replay', payloadHash: 'payload-a', eventId: crypto.randomUUID(),
      actor: 'user', updatedAt: 6,
    } as const;
    const first = storage.setRuntimeCapacityLimit(input);
    const replay = storage.setRuntimeCapacityLimit({ ...input, eventId: crypto.randomUUID() });
    expect(replay).toEqual(first);
    expect(storage.sqlite.query<{ rows: number }, []>(
      "SELECT COUNT(*) AS rows FROM domain_events WHERE event_type='SchedulerGlobalCapacityChanged'",
    ).get()?.rows).toBe(1);
    expect(() => storage.setRuntimeCapacityLimit({
      ...input, limit: 5, payloadHash: 'payload-b',
    })).toThrow('Command ID was already used with a different payload');
    // The refused conflict changed nothing.
    expect(storage.getRuntimeCapacity().limit).toBe(4);
  });

  test('reset removes the explicit value so the documented default applies again', () => {
    storage.setRuntimeCapacityLimit({
      limit: 6, commandId: 'cmd-set', payloadHash: 'p', eventId: crypto.randomUUID(),
      actor: 'user', updatedAt: 7,
    });
    const reset = storage.resetRuntimeCapacityLimit({
      commandId: 'cmd-reset', payloadHash: 'p', eventId: crypto.randomUUID(),
      actor: 'user', updatedAt: 8,
    });
    expect(reset.changed).toBe(true);
    expect(storage.getRuntimeCapacity()).toEqual({
      limit: defaultConcurrencyLimit, limitSource: 'DEFAULT', version: 0,
      updatedAt: null, updatedBy: null,
    });
    // Resetting an already-default configuration is an honest no-op.
    const again = storage.resetRuntimeCapacityLimit({
      commandId: 'cmd-reset-2', payloadHash: 'p', eventId: crypto.randomUUID(),
      actor: 'user', updatedAt: 9,
    });
    expect(again.changed).toBe(false);
  });

  test('refuses an invalid limit instead of clamping it', () => {
    const attempt = (limit: number) => () => storage.setRuntimeCapacityLimit({
      limit, commandId: crypto.randomUUID(), payloadHash: 'p', eventId: crypto.randomUUID(),
      actor: 'user', updatedAt: 9,
    });
    expect(attempt(0)).toThrow(SlotReservationError);
    expect(attempt(-1)).toThrow(SlotReservationError);
    expect(attempt(1.5)).toThrow(SlotReservationError);
    expect(attempt(999)).toThrow(SlotReservationError);
    // Nothing was written by any refused attempt.
    expect(storage.getRuntimeCapacity().limitSource).toBe('DEFAULT');
    storage.setRuntimeCapacityLimit({
      limit: 16, commandId: crypto.randomUUID(), payloadHash: 'p', eventId: crypto.randomUUID(),
      actor: 'user', updatedAt: 10,
    });
    expect(storage.getRuntimeCapacity().limit).toBe(16);
  });

  test('records the change as a global event that belongs to no Project', () => {
    storage.setRuntimeCapacityLimit({
      limit: 4, commandId: crypto.randomUUID(), payloadHash: 'p', eventId: 'evt-1',
      actor: 'user', updatedAt: 11,
    });
    const event = storage.sqlite.query<{
      project_id: string | null; aggregate_type: string; payload_json: string;
    }, []>("SELECT project_id,aggregate_type,payload_json FROM domain_events WHERE event_id='evt-1'")
      .get();
    expect(event?.project_id).toBeNull();
    expect(event?.aggregate_type).toBe('RuntimeSchedulerControl');
    expect(JSON.parse(event?.payload_json ?? '{}')).toMatchObject({
      from: defaultConcurrencyLimit, to: 4, source: 'EXPLICIT', actor: 'user',
    });
  });
});

describe('Runtime-wide slot occupancy', () => {
  test('counts occupancy across every Project, per Task', () => {
    expect(storage.reserveExecutionSlot(acquireInput('t1', 'r1')).outcome).toBe('RESERVED');
    expect(storage.reserveExecutionSlot(acquireInput('u1', 's1', 'p2')).outcome).toBe('RESERVED');
    const occupancy = storage.countActiveSlotOccupants();
    expect(occupancy.globalUsed).toBe(2);
    expect(occupancy.globalBlocking).toEqual(['t1', 'u1']);
    expect(occupancy.occupants.map((occupant) => occupant.projectId)).toEqual(['p1', 'p2']);
    expect(occupancy.occupants.every((occupant) => occupant.source === 'RESERVATION')).toBe(true);
  });

  test('the whole Runtime admits `limit` Tasks, so a third Task waits whichever Project it is in', () => {
    expect(storage.reserveExecutionSlot(acquireInput('t1', 'r1')).outcome).toBe('RESERVED');
    expect(storage.reserveExecutionSlot(acquireInput('u1', 's1', 'p2')).outcome).toBe('RESERVED');
    for (const [projectId, taskId, revisionId] of [
      ['p1', 't2', 'r2'], ['p2', 'u2', 's2'],
    ] as const) {
      const third = storage.reserveExecutionSlot(acquireInput(taskId, revisionId, projectId));
      expect(third.outcome).toBe('CAPACITY_WAIT');
      expect(third.wait).toMatchObject({
        code: 'CAPACITY_GLOBAL_LIMIT_REACHED', limit: 2, used: 2, blocking: ['t1', 'u1'],
      });
    }
    // A wait wrote no reservation: the two Tasks from before are still the only occupants.
    expect(storage.listActiveSlotReservations()).toHaveLength(2);
  });

  test('there is no second per-Adapter ceiling: the same Adapter is not bounded below the limit', () => {
    // Both occupants use the same Adapter and the default limit still admits both, which is exactly
    // what the removed Adapter dimension used to prevent.
    expect(storage.reserveExecutionSlot(acquireInput('t1', 'r1')).outcome).toBe('RESERVED');
    expect(storage.reserveExecutionSlot(acquireInput('t2', 'r2')).outcome).toBe('RESERVED');
    expect(storage.countActiveSlotOccupants().globalUsed).toBe(2);
  });

  test('a lower limit never releases an occupant, so used may exceed limit', () => {
    expect(storage.reserveExecutionSlot(acquireInput('t1', 'r1')).outcome).toBe('RESERVED');
    expect(storage.reserveExecutionSlot(acquireInput('t2', 'r2')).outcome).toBe('RESERVED');
    storage.setRuntimeCapacityLimit({
      limit: 1, commandId: crypto.randomUUID(), payloadHash: 'p', eventId: crypto.randomUUID(),
      actor: 'user', updatedAt: 12,
    });
    expect(storage.countActiveSlotOccupants().globalUsed).toBe(2);
    const third = storage.reserveExecutionSlot(acquireInput('t3', 'r3'));
    expect(third.outcome).toBe('CAPACITY_WAIT');
    expect(third.wait).toMatchObject({ limit: 1, used: 2 });
    expect(storage.listActiveSlotReservations()).toHaveLength(2);
  });
});

describe('slot reservations', () => {
  test('grants one slot per Task and refuses a second reservation for the same Task', () => {
    expect(storage.reserveExecutionSlot(acquireInput('t1', 'r1')).outcome).toBe('RESERVED');
    expect(() => storage.reserveExecutionSlot(acquireInput('t1', 'r1')))
      .toThrow(SlotReservationError);
    expect(storage.listActiveSlotReservations()).toHaveLength(1);
  });

  test('a repeated command ID is one reservation with one effect', () => {
    const input = acquireInput('t1', 'r1');
    const first = storage.reserveExecutionSlot(input);
    const replay = storage.reserveExecutionSlot(input);
    expect(first.reservation?.reservationId).toBe(replay.reservation?.reservationId);
    expect(storage.listActiveSlotReservations()).toHaveLength(1);
  });

  test('capacity of two admits two Tasks and makes the third wait with its own reason code', () => {
    expect(storage.reserveExecutionSlot(acquireInput('t1', 'r1')).outcome).toBe('RESERVED');
    expect(storage.reserveExecutionSlot(acquireInput('t2', 'r2')).outcome).toBe('RESERVED');
    const third = storage.reserveExecutionSlot(acquireInput('t3', 'r3'));
    expect(third.outcome).toBe('CAPACITY_WAIT');
    expect(third.wait).toMatchObject({
      code: 'CAPACITY_GLOBAL_LIMIT_REACHED', limit: 2, used: 2, blocking: ['t1', 't2'],
    });
    expect(storage.listActiveSlotReservations()).toHaveLength(2);
  });

  test('the Task version and revision are compare-and-swapped inside the transaction', () => {
    expect(() => storage.reserveExecutionSlot(acquireInput('t1', 'r1', 'p1',
      { expectedTaskVersion: 7 })))
      .toThrow('Task version did not match');
    expect(storage.listActiveSlotReservations()).toHaveLength(0);
    const changedRevision = acquireInput('t1', 'r1', 'p1', { expectedRevisionId: 'r2' });
    expect(() => storage.reserveExecutionSlot(changedRevision))
      .toThrow(SlotReservationError);
    expect(storage.listActiveSlotReservations()).toHaveLength(0);
  });

  test('dependency facts are re-read inside the transaction and a changed graph is refused', () => {
    const stale = acquireInput('t1', 'r1', 'p1', { dependencyFingerprint: '0'.repeat(64) });
    expect(() => storage.reserveExecutionSlot(stale))
      .toThrow('The dependency facts changed since they were assessed');
    expect(storage.listActiveSlotReservations()).toHaveLength(0);
    // A Task that is not READY cannot be reserved at all.
    expect(() => storage.reserveExecutionSlot(acquireInput('t3', 'r3'))).not.toThrow();
    storage.sqlite.query("UPDATE tasks SET state='RUNNING' WHERE id='t2'").run();
    expect(() => storage.reserveExecutionSlot(acquireInput('t2', 'r2')))
      .toThrow(SlotReservationError);
  });

  test('draining refuses every new reservation, and the check runs inside the transaction', () => {
    const draining = storage.reserveExecutionSlot(acquireInput('t1', 'r1', 'p1', {
      draining: () => ({ draining: true, reason: 'RUNTIME_SHUTDOWN' }),
    }));
    expect(draining.outcome).toBe('DRAINING');
    expect(draining.wait).toMatchObject({ code: 'SCHEDULER_DRAINING' });
    expect(storage.listActiveSlotReservations()).toHaveLength(0);
  });

  test('an Execution that still holds its workspace occupies a slot too', () => {
    storage.sqlite.query(`INSERT INTO workspaces
      (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
      VALUES ('w1','t2','refs/heads/task/t2','/work/t2','owner-2',?1,'IN_USE',3)`).run(oid);
    storage.sqlite.query(`INSERT INTO executions
      (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,adapter_id,
       adapter_version,state,resource_held,base_commit,started_at)
      VALUES ('e1','t2',1,'r2','r2','w1','pi','1','RUNNING',1,?1,4)`).run(oid);
    expect(storage.countActiveSlotOccupants().globalUsed).toBe(1);
    expect(storage.countActiveSlotOccupants().occupants[0]).toMatchObject({
      taskId: 't2', projectId: 'p1', source: 'EXECUTION', reservationId: null,
    });
    expect(storage.reserveExecutionSlot(acquireInput('t1', 'r1')).outcome).toBe('RESERVED');
    const third = storage.reserveExecutionSlot(acquireInput('t3', 'r3'));
    expect(third.outcome).toBe('CAPACITY_WAIT');
    expect(third.wait?.blocking).toEqual(['t1', 't2']);
  });

  test('release is explicit, audited and makes the slot available again', () => {
    const acquired = storage.reserveExecutionSlot(acquireInput('t1', 'r1'));
    const reservation = acquired.reservation as NonNullable<typeof acquired.reservation>;
    const released = storage.releaseExecutionSlot({
      projectId: 'p1', reservationId: reservation.reservationId,
      expectedReservationVersion: reservation.version, reason: 'work finished', actor: 'user',
      releaseKind: 'EXPLICIT', observation: null, evidence: {}, eventId: crypto.randomUUID(),
      commandId: crypto.randomUUID(), payloadHash: 'p', at: 20,
    });
    expect(released.outcome).toBe('RELEASED');
    expect(released.reservation.state).toBe('RELEASED');
    expect(released.reservation.releaseReason).toBe('work finished');
    // The history keeps both the reservation and the release, in order.
    const detail = storage.getSlotReservation('p1', reservation.reservationId);
    expect(detail.events.map((event) => event.kind)).toEqual(['RESERVED', 'RELEASED']);
    expect(storage.listActiveSlotReservations()).toHaveLength(0);
    // Releasing again is an honest no-op rather than a second state change.
    const again = storage.releaseExecutionSlot({
      projectId: 'p1', reservationId: reservation.reservationId,
      expectedReservationVersion: released.reservation.version, reason: 'again', actor: 'user',
      releaseKind: 'EXPLICIT', observation: null, evidence: {}, eventId: crypto.randomUUID(),
      commandId: crypto.randomUUID(), payloadHash: 'p', at: 21,
    });
    expect(again).toMatchObject({ released: false, outcome: 'ALREADY_RELEASED' });
    // The freed slot can be reserved again.
    expect(storage.reserveExecutionSlot(acquireInput('t1', 'r1')).outcome).toBe('RESERVED');
  });

  test('a reconcile that keeps a slot occupied still appends its observation', () => {
    const acquired = storage.reserveExecutionSlot(acquireInput('t1', 'r1'));
    const reservation = acquired.reservation as NonNullable<typeof acquired.reservation>;
    const kept = storage.recordSlotReservationReconcile({
      projectId: 'p1', reservationId: reservation.reservationId,
      expectedReservationVersion: reservation.version, decision: 'KEEP_HELD',
      observation: 'HOLDER_STILL_RUNNING', releaseKind: null, detail: 'holder is still running',
      evidence: {}, ledgerEventId: crypto.randomUUID(), eventId: crypto.randomUUID(),
      commandId: 'reconcile-1', payloadHash: 'p', actor: 'runtime-startup', at: 30,
    });
    expect(kept).toMatchObject({ outcome: 'HELD', state: 'RESERVED' });
    // The same command ID is idempotent: no second observation, no second state change.
    const replay = storage.recordSlotReservationReconcile({
      projectId: 'p1', reservationId: reservation.reservationId,
      expectedReservationVersion: kept.reservation.version, decision: 'KEEP_HELD',
      observation: 'HOLDER_STILL_RUNNING', releaseKind: null, detail: 'holder is still running',
      evidence: {}, ledgerEventId: crypto.randomUUID(), eventId: crypto.randomUUID(),
      commandId: 'reconcile-1', payloadHash: 'p', actor: 'runtime-startup', at: 31,
    });
    // The replay is answered from the recorded command result, so the effect is what matters: the
    // history did not grow and the slot is still held exactly once.
    expect(replay.state).toBe('RESERVED');
    expect(storage.getSlotReservation('p1', reservation.reservationId).events
      .map((event) => event.kind)).toEqual(['RESERVED', 'RECONCILE_OBSERVED']);
    expect(storage.listActiveSlotReservations()).toHaveLength(1);
  });

  test('an unverifiable holder is kept as RECOVERY_REQUIRED and still occupies its slot', () => {
    const acquired = storage.reserveExecutionSlot(acquireInput('t1', 'r1'));
    const reservation = acquired.reservation as NonNullable<typeof acquired.reservation>;
    const marked = storage.recordSlotReservationReconcile({
      projectId: 'p1', reservationId: reservation.reservationId,
      expectedReservationVersion: reservation.version, decision: 'MARK_RECOVERY_REQUIRED',
      observation: 'HOLDER_OWNERSHIP_UNVERIFIABLE', releaseKind: null, detail: 'unverifiable',
      evidence: {}, ledgerEventId: crypto.randomUUID(), eventId: crypto.randomUUID(),
      commandId: 'reconcile-2', payloadHash: 'p', actor: 'runtime-startup', at: 40,
    });
    expect(marked).toMatchObject({ outcome: 'MARKED_RECOVERY_REQUIRED', state: 'RECOVERY_REQUIRED' });
    expect(storage.countActiveSlotOccupants().globalUsed).toBe(1);
    // A Task whose slot is held under RECOVERY_REQUIRED cannot get a second reservation.
    expect(() => storage.reserveExecutionSlot(acquireInput('t1', 'r1')))
      .toThrow(SlotReservationError);
  });

  test('a reservation can only name a workspace of its own Task', () => {
    storage.sqlite.query(`INSERT INTO workspaces
      (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
      VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1',?1,'READY',3)`).run(oid);
    const acquired = storage.reserveExecutionSlot(acquireInput('t1', 'r1', 'p1',
      { workspaceId: 'w1' }));
    expect(acquired.reservation?.workspaceId).toBe('w1');
    // Two Tasks never share one worktree: the same workspace for another Task is refused outright.
    expect(() => storage.reserveExecutionSlot(acquireInput('t2', 'r2', 'p1', { workspaceId: 'w1' })))
      .toThrow(StorageError);
    expect(storage.listActiveSlotReservations()).toHaveLength(1);
  });

  test('binding a workspace is refused for a reservation that already has one, and for a released one', () => {
    storage.sqlite.query(`INSERT INTO workspaces
      (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
      VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1',?1,'READY',3)`).run(oid);
    const acquired = storage.reserveExecutionSlot(acquireInput('t1', 'r1'));
    const reservation = acquired.reservation as NonNullable<typeof acquired.reservation>;
    const bound = storage.bindReservationWorkspace({
      projectId: 'p1', reservationId: reservation.reservationId, workspaceId: 'w1',
      expectedReservationVersion: reservation.version, commandId: crypto.randomUUID(),
      payloadHash: 'p', eventId: crypto.randomUUID(), actor: 'user', at: 50,
    });
    expect(bound.workspaceId).toBe('w1');
    expect(() => storage.bindReservationWorkspace({
      projectId: 'p1', reservationId: reservation.reservationId, workspaceId: 'w1',
      expectedReservationVersion: bound.version, commandId: crypto.randomUUID(),
      payloadHash: 'p', eventId: crypto.randomUUID(), actor: 'user', at: 51,
    })).not.toThrow();
    storage.sqlite.query("UPDATE execution_slot_reservations SET state='RELEASED',released_at=60,"
      + "release_reason='done',release_kind='EXPLICIT' WHERE id=?1").run(reservation.reservationId);
    let releasedBinding: unknown = null;
    try {
      storage.bindReservationWorkspace({
        projectId: 'p1', reservationId: reservation.reservationId, workspaceId: 'w1',
        expectedReservationVersion: bound.version, commandId: crypto.randomUUID(),
        payloadHash: 'p', eventId: crypto.randomUUID(), actor: 'user', at: 61,
      });
    } catch (error) { releasedBinding = error; }
    expect(releasedBinding).toBeInstanceOf(SlotReservationError);
    expect((releasedBinding as SlotReservationError).code).toBe('SLOT_NOT_ACTIVE');
  });
});
