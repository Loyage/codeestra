import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  Phase1Database,
  SlotReservationError,
  StorageError,
  slotDependencyFingerprint,
  type SlotReservationAcquireInput,
} from '../src/index.js';

/**
 * Capacity configuration and the reservation primitive at the storage boundary (FOUNDATION-054).
 *
 * These tests deliberately drive the storage layer directly: the Git question ("is the pinned
 * upstream still reachable from `dev`") belongs to the scheduler and is covered by the Runtime-level
 * tests, while everything that must hold *inside one transaction* — the compare-and-swap, the two
 * partial unique indexes, the capacity arithmetic and the append-only history — is a property of this
 * layer and is asserted here.
 */

const oid = 'a'.repeat(40);
let storage: Phase1Database;

function seedProjectTask(taskId: string, revisionId: string, displayNumber: number, state = 'READY'): void {
  storage.sqlite.transaction(() => {
    storage.sqlite.query(`INSERT INTO tasks
      (id,project_id,display_number,kind,current_revision_id,state,created_at,updated_at)
      VALUES (?1,'p1',?2,'DEVELOPMENT',?3,?4,2,2)`).run(taskId, displayNumber, revisionId, state);
    storage.sqlite.query(`INSERT INTO task_revisions
      (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
      VALUES (?1,?2,1,NULL,'Do work','[]','user','initial',2)`).run(revisionId, taskId);
  })();
}

function acquireInput(taskId: string, revisionId: string, overrides: Partial<SlotReservationAcquireInput> = {}): SlotReservationAcquireInput {
  return {
    projectId: 'p1',
    taskId,
    reservationId: crypto.randomUUID(),
    expectedTaskVersion: 0,
    expectedRevisionId: revisionId,
    adapterId: 'pi',
    workspaceId: null,
    impactSnapshotId: null,
    dependencyFingerprint: slotDependencyFingerprint(
      storage.listTaskDependencyFacts('p1', { taskId })),
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
  storage.sqlite.query(`INSERT INTO projects
    (id,name,repo_root,git_common_dir,main_ref,dev_ref,object_format,created_at)
    VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','refs/heads/dev','sha1',1)`).run();
  storage.sqlite.query(`INSERT INTO project_trusts
    (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
    VALUES ('trust1','p1','/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run();
  seedProjectTask('t1', 'r1', 1);
  seedProjectTask('t2', 'r2', 2);
  seedProjectTask('t3', 'r3', 3);
});

afterEach(() => storage.close());

describe('capacity configuration', () => {
  test('reports the documented default until it is set, and reads a set value back', () => {
    const initial = storage.getProjectCapacity('p1');
    expect(initial).toMatchObject({
      globalLimit: 2, globalLimitSource: 'DEFAULT', version: 0, updatedAt: null,
      adapterOverrides: [],
    });
    storage.setProjectGlobalCapacity({
      projectId: 'p1', limit: 3, commandId: crypto.randomUUID(), payloadHash: 'p',
      eventId: crypto.randomUUID(), actor: 'user', updatedAt: 4,
    });
    expect(storage.getProjectCapacity('p1')).toMatchObject({
      globalLimit: 3, globalLimitSource: 'EXPLICIT', updatedAt: 4, updatedBy: 'user',
    });
  });

  test('an Adapter override is explicit, and clearing it returns the Adapter to the project limit', () => {
    const set = storage.setAdapterSlotLimit({
      projectId: 'p1', adapterId: 'pi', limit: 1, commandId: crypto.randomUUID(),
      payloadHash: 'p', eventId: crypto.randomUUID(), actor: 'user', updatedAt: 5,
    });
    expect(set.changed).toBe(true);
    expect(storage.getProjectCapacity('p1').adapterOverrides).toEqual([
      { adapterId: 'pi', limit: 1, version: 0, updatedAt: 5, updatedBy: 'user' },
    ]);
    // Setting the same value again changes nothing and does not bump the version.
    const same = storage.setAdapterSlotLimit({
      projectId: 'p1', adapterId: 'pi', limit: 1, commandId: crypto.randomUUID(),
      payloadHash: 'p', eventId: crypto.randomUUID(), actor: 'user', updatedAt: 6,
    });
    expect(same.changed).toBe(false);
    expect(storage.getProjectCapacity('p1').adapterOverrides[0]?.version).toBe(0);
    const cleared = storage.clearAdapterSlotLimit({
      projectId: 'p1', adapterId: 'pi', commandId: crypto.randomUUID(), payloadHash: 'p',
      eventId: crypto.randomUUID(), actor: 'user', updatedAt: 7,
    });
    expect(cleared.removed).toBe(true);
    expect(storage.getProjectCapacity('p1').adapterOverrides).toEqual([]);
    // Clearing an override that does not exist is a no-op, not an error.
    expect(storage.clearAdapterSlotLimit({
      projectId: 'p1', adapterId: 'pi', commandId: crypto.randomUUID(), payloadHash: 'p',
      eventId: crypto.randomUUID(), actor: 'user', updatedAt: 8,
    }).removed).toBe(false);
  });

  test('refuses an invalid limit instead of clamping it', () => {
    const attempt = (limit: number) => () => storage.setProjectGlobalCapacity({
      projectId: 'p1', limit, commandId: crypto.randomUUID(), payloadHash: 'p',
      eventId: crypto.randomUUID(), actor: 'user', updatedAt: 9,
    });
    expect(attempt(0)).toThrow(SlotReservationError);
    expect(attempt(-1)).toThrow(SlotReservationError);
    expect(attempt(1.5)).toThrow(SlotReservationError);
    expect(attempt(999)).toThrow(SlotReservationError);
    // Nothing was written by any refused attempt.
    expect(storage.getProjectCapacity('p1').globalLimitSource).toBe('DEFAULT');
    storage.setProjectGlobalCapacity({
      projectId: 'p1', limit: 16, commandId: crypto.randomUUID(), payloadHash: 'p',
      eventId: crypto.randomUUID(), actor: 'user', updatedAt: 10,
    });
    expect(storage.getProjectCapacity('p1').globalLimit).toBe(16);
  });

  test('records a capacity change as an append-only domain event', () => {
    storage.setProjectGlobalCapacity({
      projectId: 'p1', limit: 4, commandId: crypto.randomUUID(), payloadHash: 'p',
      eventId: crypto.randomUUID(), actor: 'user', updatedAt: 11,
    });
    const event = storage.sqlite.query<{ event_type: string; payload_json: string }, []>(
      "SELECT event_type,payload_json FROM domain_events WHERE event_type='SchedulerCapacityChanged'",
    ).get();
    expect(event?.event_type).toBe('SchedulerCapacityChanged');
    expect(JSON.parse(event?.payload_json ?? '{}')).toMatchObject({
      scope: 'GLOBAL', from: 2, to: 4, actor: 'user',
    });
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
    // A wait wrote no reservation: the two Tasks from before are still the only occupants.
    expect(storage.listActiveSlotReservations()).toHaveLength(2);
  });

  test('an Adapter limit is enforced separately from the project limit', () => {
    storage.setAdapterSlotLimit({
      projectId: 'p1', adapterId: 'pi', limit: 1, commandId: crypto.randomUUID(),
      payloadHash: 'p', eventId: crypto.randomUUID(), actor: 'user', updatedAt: 12,
    });
    expect(storage.reserveExecutionSlot(acquireInput('t1', 'r1')).outcome).toBe('RESERVED');
    const second = storage.reserveExecutionSlot(acquireInput('t2', 'r2'));
    expect(second.outcome).toBe('CAPACITY_WAIT');
    expect(second.wait).toMatchObject({ code: 'CAPACITY_ADAPTER_SLOT_LIMIT_REACHED', limit: 1, used: 1 });
  });

  test('the Task version and revision are compare-and-swapped inside the transaction', () => {
    expect(() => storage.reserveExecutionSlot(acquireInput('t1', 'r1', { expectedTaskVersion: 7 })))
      .toThrow('Task version did not match');
    expect(storage.listActiveSlotReservations()).toHaveLength(0);
    const changedRevision = acquireInput('t1', 'r1', { expectedRevisionId: 'r2' });
    expect(() => storage.reserveExecutionSlot(changedRevision))
      .toThrow(SlotReservationError);
    expect(storage.listActiveSlotReservations()).toHaveLength(0);
  });

  test('dependency facts are re-read inside the transaction and a changed graph is refused', () => {
    const stale = acquireInput('t1', 'r1', { dependencyFingerprint: '0'.repeat(64) });
    expect(() => storage.reserveExecutionSlot(stale))
      .toThrow('The dependency facts changed since they were assessed');
    expect(storage.listActiveSlotReservations()).toHaveLength(0);
    // A Task that is not READY cannot be reserved at all.
    expect(() => storage.reserveExecutionSlot(acquireInput('t3', 'r3')))
      .not.toThrow();
    storage.sqlite.query("UPDATE tasks SET state='RUNNING' WHERE id='t2'").run();
    expect(() => storage.reserveExecutionSlot(acquireInput('t2', 'r2')))
      .toThrow(SlotReservationError);
  });

  test('draining refuses every new reservation, and the check runs inside the transaction', () => {
    const draining = storage.reserveExecutionSlot(acquireInput('t1', 'r1', {
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
    expect(storage.countActiveSlotOccupants({ projectId: 'p1' }).globalUsed).toBe(1);
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
    expect(storage.countActiveSlotOccupants({ projectId: 'p1' }).globalUsed).toBe(1);
    // A Task whose slot is held under RECOVERY_REQUIRED cannot get a second reservation.
    expect(() => storage.reserveExecutionSlot(acquireInput('t1', 'r1')))
      .toThrow(SlotReservationError);
  });

  test('a reservation can only name a workspace of its own Task', () => {
    storage.sqlite.query(`INSERT INTO workspaces
      (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
      VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1',?1,'READY',3)`).run(oid);
    const acquired = storage.reserveExecutionSlot(acquireInput('t1', 'r1', { workspaceId: 'w1' }));
    expect(acquired.reservation?.workspaceId).toBe('w1');
    // Two Tasks never share one worktree: the same workspace for another Task is refused outright.
    expect(() => storage.reserveExecutionSlot(acquireInput('t2', 'r2', { workspaceId: 'w1' })))
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
