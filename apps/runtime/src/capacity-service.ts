import { maxConcurrencyLimit, type AdapterCapacityView, type CapacityWaitReason,
  type CapacityWaitReasonCode, type ProjectCapacityView,
  type SlotCapacityCheck } from '@codeestra/contracts';
import { Phase1Database, SlotReservationError, type SlotOccupancy } from '@codeestra/storage';

/**
 * Capacity as a product fact (Phase 2, FOUNDATION-054 / ADR-0032).
 *
 * Two dimensions, both explicit and both configurable per project:
 *
 *  - the project-wide number of concurrent Tasks (documented default 2);
 *  - the number of concurrent slots per Agent Adapter, where an Adapter that never had an override
 *    *follows the project-wide limit* — the override is derived, never copied, so changing the
 *    project limit moves every Adapter that has no override of its own.
 *
 * Nothing here is derived from host resources: the decision is a configuration, not a measurement.
 * The service also owns the **wait reason**: a Task that has no slot is *waiting on capacity*, which
 * is a different state from `BLOCKED` (unmet dependencies, PROJECT_SPEC §2.10). The reason codes are
 * closed so a scheduler or a script can branch on them, and they are reported both by
 * `scheduler capacity get` and by a refused acquisition.
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

/** A stable refusal: an unknown Adapter ID must never silently become a configuration row. */
export function assertKnownAdapter(adapterId: string, knownAdapterIds: readonly string[]): void {
  if (knownAdapterIds.includes(adapterId)) return;
  throw new SlotReservationError('UNKNOWN_ADAPTER',
    `Adapter ${adapterId} is not registered; known Adapters: ${knownAdapterIds.join(', ') || 'none'}`);
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
 */
export function capacityWaitReason(input: {
  readonly draining: boolean;
  readonly globalLimit: number;
  readonly globalUsed: number;
  readonly adapterLimit: number;
  readonly adapterUsed: number;
}): CapacityWaitReasonCode | null {
  if (input.draining) return 'SCHEDULER_DRAINING';
  if (input.globalUsed >= input.globalLimit) return 'CAPACITY_GLOBAL_LIMIT_REACHED';
  if (input.adapterUsed >= input.adapterLimit) return 'CAPACITY_ADAPTER_SLOT_LIMIT_REACHED';
  return null;
}

/** The wait reason of one acquisition attempt, with the numbers that produced it. */
export function waitReasonFromCapacity(capacity: SlotCapacityCheck, draining: boolean): CapacityWaitReason | null {
  const code = capacityWaitReason({
    draining,
    globalLimit: capacity.globalLimit,
    globalUsed: capacity.globalUsed,
    adapterLimit: capacity.adapterLimit,
    adapterUsed: capacity.adapterUsed,
  });
  if (code === null) return null;
  if (code === 'SCHEDULER_DRAINING') {
    return {
      code,
      adapterId: capacity.adapterId,
      limit: null,
      used: null,
      blocking: [],
      detail: 'the Runtime is draining and accepts no new reservations',
    };
  }
  if (code === 'CAPACITY_GLOBAL_LIMIT_REACHED') {
    return {
      code,
      adapterId: capacity.adapterId,
      limit: capacity.globalLimit,
      used: capacity.globalUsed,
      blocking: capacity.globalBlocking,
      detail: `${capacity.globalUsed} of ${capacity.globalLimit} project slots are in use`,
    };
  }
  return {
    code,
    adapterId: capacity.adapterId,
    limit: capacity.adapterLimit,
    used: capacity.adapterUsed,
    blocking: capacity.adapterBlocking,
    detail: `${capacity.adapterUsed} of ${capacity.adapterLimit} ${capacity.adapterId} slots are in use`,
  };
}

/**
 * Every Adapter the capacity view reports: the registered ones, every Adapter that has an explicit
 * override, and every Adapter that currently occupies a slot. The union matters — an override for an
 * Adapter that is not registered right now stays visible (and readable back) instead of disappearing.
 */
function reportedAdapterIds(input: {
  readonly knownAdapterIds: readonly string[];
  readonly overrideIds: readonly string[];
  readonly occupancy: SlotOccupancy;
}): readonly string[] {
  const ids = new Set<string>([
    ...input.knownAdapterIds, ...input.overrideIds,
    ...input.occupancy.occupants.flatMap((occupant) => occupant.adapterIds),
  ]);
  return [...ids].sort();
}

/**
 * The capacity facts a scheduler may query. Read-only: it writes nothing, and a wait reason is an
 * observation about this instant, never a reservation of a slot.
 */
export function inspectProjectCapacity(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly knownAdapterIds: readonly string[];
  readonly draining: { readonly draining: boolean; readonly reason: string | null };
}): ProjectCapacityView {
  const capacity = input.storage.getProjectCapacity(input.projectId);
  const occupancy = input.storage.countActiveSlotOccupants({ projectId: input.projectId });
  const overrideIds = capacity.adapterOverrides.map((record) => record.adapterId);
  const adapters: AdapterCapacityView[] = reportedAdapterIds({
    knownAdapterIds: input.knownAdapterIds,
    overrideIds,
    occupancy,
  }).map((adapterId) => {
    const override = capacity.adapterOverrides.find((record) => record.adapterId === adapterId) ?? null;
    const limit = override?.limit ?? capacity.globalLimit;
    const used = occupancy.occupants
      .filter((occupant) => occupant.adapterIds.includes(adapterId)).length;
    const waitReason = capacityWaitReason({
      draining: input.draining.draining,
      globalLimit: capacity.globalLimit,
      globalUsed: occupancy.globalUsed,
      adapterLimit: limit,
      adapterUsed: used,
    });
    return {
      adapterId,
      limit,
      limitSource: override === null ? 'DEFAULT' as const : 'EXPLICIT' as const,
      used,
      available: Math.max(limit - used, 0),
      waitReason,
    };
  });
  return {
    projectId: input.projectId,
    globalLimit: capacity.globalLimit,
    globalLimitSource: capacity.globalLimitSource,
    globalUsed: occupancy.globalUsed,
    globalAvailable: Math.max(capacity.globalLimit - occupancy.globalUsed, 0),
    globalWaitReason: capacityWaitReason({
      draining: input.draining.draining,
      globalLimit: capacity.globalLimit,
      globalUsed: occupancy.globalUsed,
      adapterLimit: capacity.globalLimit,
      adapterUsed: 0,
    }),
    adapters,
    configVersion: capacity.version,
    updatedAt: capacity.updatedAt,
    updatedBy: capacity.updatedBy,
    draining: input.draining.draining,
    drainReason: input.draining.reason,
    occupants: occupancy.occupants.map((occupant) => ({
      taskId: occupant.taskId,
      reservationId: occupant.reservationId,
      adapterId: occupant.adapterIds[0] ?? '',
      since: occupant.since,
    })),
  };
}

export interface CapacityMutationResult {
  readonly changed: boolean;
  readonly view: ProjectCapacityView;
}

/** Sets the project-wide limit, or one Adapter's limit when `adapterId` is given. */
export function setProjectCapacity(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly adapterId: string | undefined;
  readonly limit: number;
  readonly actor: string;
  readonly commandId: string;
  readonly knownAdapterIds: readonly string[];
  readonly draining: { readonly draining: boolean; readonly reason: string | null };
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): CapacityMutationResult {
  assertCapacityLimit(input.limit);
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  if (input.adapterId === undefined) {
    const change = input.storage.setProjectGlobalCapacity({
      projectId: input.projectId,
      limit: input.limit,
      commandId: input.commandId,
      payloadHash: randomUUID(),
      eventId: randomUUID(),
      actor: input.actor,
      updatedAt: now(),
    });
    return {
      changed: change.changed,
      view: inspectProjectCapacity({
        storage: input.storage, projectId: input.projectId,
        knownAdapterIds: input.knownAdapterIds, draining: input.draining,
      }),
    };
  }
  assertKnownAdapter(input.adapterId, input.knownAdapterIds);
  const change = input.storage.setAdapterSlotLimit({
    projectId: input.projectId,
    adapterId: input.adapterId,
    limit: input.limit,
    commandId: input.commandId,
    payloadHash: randomUUID(),
    eventId: randomUUID(),
    actor: input.actor,
    updatedAt: now(),
  });
  return {
    changed: change.changed,
    view: inspectProjectCapacity({
      storage: input.storage, projectId: input.projectId,
      knownAdapterIds: input.knownAdapterIds, draining: input.draining,
    }),
  };
}

/** Removes one Adapter override, so that Adapter follows the project-wide limit again. */
export function clearAdapterCapacity(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly adapterId: string;
  readonly actor: string;
  readonly commandId: string;
  readonly knownAdapterIds: readonly string[];
  readonly draining: { readonly draining: boolean; readonly reason: string | null };
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): CapacityMutationResult {
  assertKnownAdapter(input.adapterId, input.knownAdapterIds);
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const change = input.storage.clearAdapterSlotLimit({
    projectId: input.projectId,
    adapterId: input.adapterId,
    commandId: input.commandId,
    payloadHash: randomUUID(),
    eventId: randomUUID(),
    actor: input.actor,
    updatedAt: now(),
  });
  return {
    changed: change.removed,
    view: inspectProjectCapacity({
      storage: input.storage, projectId: input.projectId,
      knownAdapterIds: input.knownAdapterIds, draining: input.draining,
    }),
  };
}
