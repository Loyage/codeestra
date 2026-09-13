import type { RuntimeStreamFrame } from '@codeestra/contracts';
import type { Phase1Database } from '@codeestra/storage';

/** Only Runtime-initiated stops are reported; a client that closes its own socket needs no reason. */
export type EventSubscriptionStopReason = 'INVALID_CURSOR' | 'EVENT_READ_FAILED';

export interface EventSubscriptionHandle {
  /** Highest sequence this subscription has delivered or caught up to. */
  readonly cursor: number;
  readonly active: boolean;
  close(): void;
}

export interface EventSubscriptionRequest {
  readonly requestId: string;
  readonly projectId?: string;
  /**
   * Exclusive cursor. Absent means "from the current tail": a client takes a snapshot, then
   * subscribes at that snapshot cursor without a gap between the two reads.
   */
  readonly sinceSequence?: number;
  /** Returns false when the peer is gone; the subscription then stops. */
  readonly send: (frame: RuntimeStreamFrame) => boolean;
  /** Called when the Runtime, not the client, ended the subscription. */
  readonly onStop?: (reason: EventSubscriptionStopReason) => void;}

interface Subscriber {
  readonly requestId: string;
  readonly projectId: string | null;
  readonly send: (frame: RuntimeStreamFrame) => boolean;
  readonly onStop: ((reason: EventSubscriptionStopReason) => void) | undefined;
  cursor: number;
  active: boolean;
}

export interface EventSubscriptionHubOptions {
  readonly storage: Phase1Database;
  /** Poll interval for new events. Phase 1 uses one shared poller per Runtime. */
  readonly intervalMs?: number;
  readonly heartbeatMs?: number;
  readonly batchSize?: number;
}

/**
 * Long-lived event subscription over the existing append-only event log.
 *
 * The hub is read-only: it never writes events, never touches the `event_deliveries` outbox and
 * never replays a command. Delivery to a socket is best-effort — a client that misses frames
 * reconnects with its last cursor, which is why cursors are exclusive and never implicitly reset.
 */
export class EventSubscriptionHub {
  readonly #storage: Phase1Database;
  readonly #intervalMs: number;
  readonly #heartbeatMs: number;
  readonly #batchSize: number;
  readonly #subscribers = new Set<Subscriber>();
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  constructor(options: EventSubscriptionHubOptions) {
    this.#storage = options.storage;
    this.#intervalMs = options.intervalMs ?? 200;
    this.#heartbeatMs = options.heartbeatMs ?? 15_000;
    this.#batchSize = options.batchSize ?? 200;
    for (const [name, value] of [['intervalMs', this.#intervalMs],
      ['heartbeatMs', this.#heartbeatMs], ['batchSize', this.#batchSize]] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
  }

  subscriberCount(): number {
    return this.#subscribers.size;
  }

  subscribe(request: EventSubscriptionRequest): EventSubscriptionHandle {
    if (this.#closed) throw new Error('The event subscription hub is closed');
    const projectId = request.projectId ?? null;
    const latest = this.#storage.latestEventSequence();
    if (request.sinceSequence !== undefined && request.sinceSequence > latest) {
      // An unknown cursor is reported, not silently clamped: the client must take a new snapshot
      // instead of believing it is caught up.
      request.send({
        schemaVersion: 1, type: 'error', code: 'INVALID_CURSOR',
        message: `Event cursor ${request.sinceSequence} is ahead of the Runtime log (${latest})`,
      });
      request.onStop?.('INVALID_CURSOR');
      return { cursor: latest, active: false, close() {} };
    }
    const subscriber: Subscriber = {
      requestId: request.requestId,
      projectId,
      send: request.send,
      onStop: request.onStop,
      cursor: request.sinceSequence ?? latest,
      active: true,
    };
    const accepted = request.send({
      schemaVersion: 1, type: 'subscribed', requestId: request.requestId,
      cursor: subscriber.cursor, projectId,
    });
    if (!accepted) {
      subscriber.active = false;
      return { get cursor() { return subscriber.cursor; }, get active() { return false; },
        close() {} };
    }
    this.#subscribers.add(subscriber);
    this.#startTimers();
    return {
      get cursor() { return subscriber.cursor; },
      get active() { return subscriber.active; },
      close: () => { this.#remove(subscriber); },
    };
  }

  /**
   * One synchronous delivery round. Tests call this instead of waiting for the timer; the
   * Runtime calls it from the shared interval.
   */
  flush(): void {
    for (const subscriber of [...this.#subscribers]) {
      if (!subscriber.active) continue;
      let events;
      try {
        events = this.#storage.listEventsAfter({
          sinceSequence: subscriber.cursor,
          limit: this.#batchSize,
          ...(subscriber.projectId === null ? {} : { projectId: subscriber.projectId }),
        });
      } catch (error) {
        this.#stop(subscriber, 'EVENT_READ_FAILED',
          error instanceof Error ? error.message : String(error));
        continue;
      }
      for (const event of events) {
        // The cursor tracks delivered events, so a client that resumes from it repeats nothing.
        subscriber.cursor = event.sequence;
        if (!subscriber.send({ schemaVersion: 1, type: 'event', cursor: event.sequence, event })) {
          this.#remove(subscriber);
          break;
        }
      }
      if (!subscriber.active) continue;
      if (events.length < this.#batchSize) {
        // A partial batch proves the whole log was read, so a filter with no matches in between
        // may still advance to the tail. Skipping those sequences cannot hide a matching event:
        // the next read starts above the tail and the filter is applied again.
        const latest = this.#storage.latestEventSequence();
        if (latest > subscriber.cursor) subscriber.cursor = latest;
      }
    }
  }

  heartbeat(): void {
    for (const subscriber of [...this.#subscribers]) {
      if (!subscriber.active) continue;
      if (!subscriber.send({ schemaVersion: 1, type: 'heartbeat', cursor: subscriber.cursor })) {
        this.#remove(subscriber);
      }
    }
  }

  /** Ends every subscription without a per-client frame; the Runtime is stopping. */
  close(): void {
    this.#closed = true;
    this.#stopTimers();
    for (const subscriber of [...this.#subscribers]) this.#remove(subscriber);
  }

  #startTimers(): void {
    if (this.#closed) return;
    if (this.#pollTimer === null) {
      this.#pollTimer = setInterval(() => { this.flush(); }, this.#intervalMs);
      this.#pollTimer.unref?.();
    }
    if (this.#heartbeatTimer === null) {
      this.#heartbeatTimer = setInterval(() => { this.heartbeat(); }, this.#heartbeatMs);
      this.#heartbeatTimer.unref?.();
    }
  }

  #stopTimers(): void {
    if (this.#pollTimer !== null) clearInterval(this.#pollTimer);
    if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
    this.#pollTimer = null;
    this.#heartbeatTimer = null;
  }

  #remove(subscriber: Subscriber): void {
    if (!subscriber.active) return;
    subscriber.active = false;
    this.#subscribers.delete(subscriber);
    if (this.#subscribers.size === 0) this.#stopTimers();
  }

  #stop(subscriber: Subscriber, reason: EventSubscriptionStopReason, message: string): void {
    subscriber.send({ schemaVersion: 1, type: 'error', code: reason, message });
    subscriber.onStop?.(reason);
    this.#remove(subscriber);
  }
}
