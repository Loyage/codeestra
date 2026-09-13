import type { PendingEventDelivery, Phase1Database } from '@codeestra/storage';

export interface EventDeliveryBatchResult {
  readonly delivered: number;
  readonly failed: number;
}

/** Durable at-least-once delivery. Consumers must deduplicate by eventId. */
export async function deliverPendingEvents(input: {
  readonly storage: Phase1Database;
  readonly consumerId: string;
  readonly deliver: (event: PendingEventDelivery) => Promise<void>;
  readonly now?: () => number;
  readonly retryDelayMs?: number;
  readonly limit?: number;
}): Promise<EventDeliveryBatchResult> {
  const now = input.now ?? Date.now;
  const retryDelayMs = input.retryDelayMs ?? 1_000;
  const limit = input.limit ?? 100;
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error('retryDelayMs must be a non-negative integer');
  }
  input.storage.enqueueEventDeliveries(input.consumerId);
  let delivered = 0;
  let failed = 0;
  for (const event of input.storage.listDueEventDeliveries(input.consumerId, now(), limit)) {
    try {
      await input.deliver(event);
      input.storage.markEventDelivered(event.eventId, input.consumerId);
      delivered += 1;
    } catch (error) {
      input.storage.markEventDeliveryFailed({
        eventId: event.eventId,
        consumerId: input.consumerId,
        error: error instanceof Error ? error.message : String(error),
        nextAttemptAt: now() + retryDelayMs,
      });
      failed += 1;
    }
  }
  return { delivered, failed };
}
