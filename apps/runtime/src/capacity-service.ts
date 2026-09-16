import { maxConcurrencyLimit, type CapacityWaitReason,
  type CapacityWaitReasonCode, type ProjectCapacityView,
  type RuntimeCapacityView, type SlotCapacityCheck } from '@codeestra/contracts';
import { Phase1Database, SlotReservationError } from '@codeestra/storage';

/**
 * Capacity as a product fact (ADR-0061 D01/D02, schema v34).
 *
 * There is exactly **one** concurrency limit, and it belongs to the Runtime — one `CODEESTRA_HOME`
 * is one resource domain. Everything below is written from that fact:
 *
 *  - the limit is a configuration, never a measurement: nothing is derived from CPU, memory or load;
 *  - the occupancy is counted across **every** Project, per Task, from the union of active slot
 *    reservations and Executions that still hold a resource. A candidate's Project and Adapter no
 *    longer produce a second ceiling, so "the machine is not overloaded" is a statement the Runtime
 *    can actually defend;
 *  - the wait reason is still a closed, stable code a script can branch on, and it is still reported
 *    both by `scheduler capacity get` and by a refused acquisition.
 *
 * A Task with no slot is **waiting on capacity**, which is a different state from `BLOCKED` (unmet
 * dependencies, `PROJECT_SPEC.md` §2.10). `CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` keeps its place in the
 * contract because historical events and historical command results contain it and must stay
 * readable, but no code path in this Runtime produces a new one.
 */

/**
 * The Runtime's draining fact. The only draining this Runtime can honestly report is its own
 * shutdown: once shutdown starts, no new reservation may be granted (scheduler.md §2 stops
 * scheduling while draining). It is deliberately in-memory — a persisted "draining" flag would
 * survive a crash and silently block every future reservation, which is exactly the kind of
 * optimistic record this lane must not leave behind.
 */
export class RuntimeDrainState {
  #draining = false;
  #reason: string | null = null;

  begin(reason: string): void {
    if (this.#draining) return;
    this.#draining = true;
    this.#reason = reason;
  }

  state(): { readonly draining: boolean; readonly reason: string | null } {
    return { draining: this.#draining, reason: this.#reason };
  }
}

export function assertCapacityLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new SlotReservationError('CAPACITY_LIMIT_INVALID',
      `A concurrency limit must be an integer of at least 1; got ${String(limit)}`);
  }
  if (limit > maxConcurrencyLimit) {
    throw new SlotReservationError('CAPACITY_LIMIT_OUT_OF_RANGE',
      `A concurrency limit must not exceed ${maxConcurrencyLimit}; got ${limit}`);
  }
}

/**
 * The code a new acquisition would report against these facts, or null when a slot is free. The
 * order is the order the acquisition itself checks in, so the reported reason is the one a
 * scheduler would actually get.
 *
 * The Adapter branch is gone rather than kept as a degenerate comparison against the same number:
 * ADR-0061 removed the second dimension, and a check that can never fail is not a check.
 */
export function capacityWaitReason(input: {
  readonly draining: boolean;
  readonly limit: number;
  readonly used: number;
}): CapacityWaitReasonCode | null {
  if (input.draining) return 'SCHEDULER_DRAINING';
  if (input.used >= input.limit) return 'CAPACITY_GLOBAL_LIMIT_REACHED';
  return null;
}

/** The wait reason of one acquisition attempt, with the numbers that produced it. */
export function waitReasonFromCapacity(
  capacity: SlotCapacityCheck,
  draining: boolean,
): CapacityWaitReason | null {
  const code = capacityWaitReason({
    draining,
    limit: capacity.globalLimit,
    used: capacity.globalUsed,
  });
  if (code === null) return null;
  if (code === 'SCHEDULER_DRAINING') {
    return {
      code,
      adapterId: null,
      limit: null,
      used: null,
      blocking: [],
      detail: 'the Runtime is draining and accepts no new reservations',
    };
  }
  return {
    code,
    adapterId: null,
    limit: capacity.globalLimit,
    used: capacity.globalUsed,
    blocking: capacity.globalBlocking,
    detail: `${capacity.globalUsed} of ${capacity.globalLimit} Runtime-wide slots are in use`,
  };
}

/**
 * The Runtime-wide capacity facts `scheduler capacity get` reports (ADR-0061 D02).
 *
 * `pauseState` is read through an injected provider instead of being decided here: the persistent
 * global pause (`runtime_pause_control`) is the *other* half of ADR-0061 and owns its own table, so
 * this half reports what it can see — no barrier — and the merged implementation replaces the
 * provider with a read of the pause control row. A capacity fact and a pause fact stay separate:
 * `PAUSED` never changes `used`, and `used > limit` never implies a pause.
 */
export function inspectRuntimeCapacity(input: {
  readonly storage: Phase1Database;
  readonly draining: { readonly draining: boolean; readonly reason: string | null };
  readonly pauseState: () => RuntimeCapacityView['pauseState'];
}): RuntimeCapacityView {
  const capacity = input.storage.getRuntimeCapacity();
  const occupancy = input.storage.countActiveSlotOccupants();
  return {
    limit: capacity.limit,
    limitSource: capacity.limitSource,
    used: occupancy.globalUsed,
    available: Math.max(capacity.limit - occupancy.globalUsed, 0),
    waitReason: capacityWaitReason({
      draining: input.draining.draining,
      limit: capacity.limit,
      used: occupancy.globalUsed,
    }),
    occupiers: occupancy.occupants.map((occupant) => ({
      projectId: occupant.projectId,
      taskId: occupant.taskId,
      adapterId: occupant.adapterIds[0] ?? '',
      adapterIds: occupant.adapterIds,
      reservationId: occupant.reservationId,
      since: occupant.since,
      source: occupant.source,
      state: occupant.state === 'RELEASED' ? null : occupant.state,
    })),
    pauseState: input.pauseState(),
    configVersion: capacity.version,
    updatedAt: capacity.updatedAt,
    updatedBy: capacity.updatedBy,
    draining: input.draining.draining,
    drainReason: input.draining.reason,
  };
}

/**
 * The per-Project **report** of the same Runtime-wide fact, used by `task.schedule.*` so a caller
 * asking about one Project still sees the numbers that actually decide its Tasks.
 *
 * It deliberately keeps the field names a client already reads (`globalLimit`, `globalUsed`,
 * `globalWaitReason`) because those numbers *are* the global ones — but the Adapter list is gone:
 * there is no per-Adapter ceiling left to report, and an empty list would suggest there is one.
 */
export function inspectProjectCapacity(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly draining: { readonly draining: boolean; readonly reason: string | null };
}): ProjectCapacityView {
  const capacity = input.storage.getRuntimeCapacity();
  const occupancy = input.storage.countActiveSlotOccupants();
  return {
    projectId: input.projectId,
    globalLimit: capacity.limit,
    globalLimitSource: capacity.limitSource,
    globalUsed: occupancy.globalUsed,
    globalAvailable: Math.max(capacity.limit - occupancy.globalUsed, 0),
    globalWaitReason: capacityWaitReason({
      draining: input.draining.draining,
      limit: capacity.limit,
      used: occupancy.globalUsed,
    }),
    configVersion: capacity.version,
    updatedAt: capacity.updatedAt,
    updatedBy: capacity.updatedBy,
    draining: input.draining.draining,
    drainReason: input.draining.reason,
    occupants: occupancy.occupants.map((occupant) => ({
      projectId: occupant.projectId,
      taskId: occupant.taskId,
      reservationId: occupant.reservationId,
      adapterId: occupant.adapterIds[0] ?? '',
      adapterIds: occupant.adapterIds,
      since: occupant.since,
      source: occupant.source,
    })),
  };
}

export interface CapacityMutationResult {
  readonly changed: boolean;
  readonly view: RuntimeCapacityView;
}

/** Sets the one Runtime-wide limit (ADR-0061 D02 `set`). */
export function setRuntimeCapacity(input: {
  readonly storage: Phase1Database;
  readonly limit: number;
  readonly actor: string;
  readonly commandId: string;
  readonly draining: { readonly draining: boolean; readonly reason: string | null };
  readonly pauseState: () => RuntimeCapacityView['pauseState'];
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): CapacityMutationResult {
  assertCapacityLimit(input.limit);
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const change = input.storage.setRuntimeCapacityLimit({
    limit: input.limit,
    commandId: input.commandId,
    payloadHash: runtimeCapacityPayloadHash({ limit: input.limit }),
    eventId: randomUUID(),
    actor: input.actor,
    updatedAt: now(),
  });
  return {
    changed: change.changed,
    view: inspectRuntimeCapacity({
      storage: input.storage, draining: input.draining, pauseState: input.pauseState,
    }),
  };
}

/** Removes the explicit limit so the documented default 2 applies again (ADR-0061 D02 `reset`). */
export function resetRuntimeCapacity(input: {
  readonly storage: Phase1Database;
  readonly actor: string;
  readonly commandId: string;
  readonly draining: { readonly draining: boolean; readonly reason: string | null };
  readonly pauseState: () => RuntimeCapacityView['pauseState'];
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): CapacityMutationResult {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const change = input.storage.resetRuntimeCapacityLimit({
    commandId: input.commandId,
    payloadHash: runtimeCapacityPayloadHash({ limit: null }),
    eventId: randomUUID(),
    actor: input.actor,
    updatedAt: now(),
  });
  return {
    changed: change.changed,
    view: inspectRuntimeCapacity({
      storage: input.storage, draining: input.draining, pauseState: input.pauseState,
    }),
  };
}

/**
 * The payload identity of one global capacity command. It is what makes "the same command id with a
 * different payload" a refusal: replaying the exact same request returns the recorded result, while
 * reusing the id for a different limit (or for a `set` where a `reset` was recorded) is
 * `COMMAND_CONFLICT`.
 */
function runtimeCapacityPayloadHash(payload: { readonly limit: number | null }): string {
  return `runtime-capacity-limit:${payload.limit ?? 'DEFAULT'}`;
}
