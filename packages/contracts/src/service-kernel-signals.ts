import { z } from 'zod';

/**
 * The S5 typed Process writes (ADR-0070 §4, roadmap S5).
 *
 * A Process completes by publishing one `SIG_A` fact, not by a caller writing `processes.status`
 * directly: the payload names the Process, the outcome and the exact `processes.version` the sender
 * observed, so the completion converges through the same receipt/idempotency path every other
 * kernel Signal uses. `PROCESS_COMPLETED` is accepted by the Services a Process can hang under —
 * ROOT, PROJECT and TASK — because a Process's parent Service is one of those three kinds; the
 * Scheduler and Attention Services supervise no Process and reject it.
 */

export const processCompletedSubtype = 'PROCESS_COMPLETED';

export const processCompletionOutcomes = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;

export const processCompletedPayloadSchema = z.strictObject({
  processId: z.string().min(1),
  outcome: z.enum(processCompletionOutcomes),
  /** The `processes.version` the sender observed; a stale value is refused, never coerced. */
  expectedVersion: z.number().int().nonnegative(),
  summary: z.string().min(1).max(4096),
});
export type ProcessCompletedPayload = z.infer<typeof processCompletedPayloadSchema>;

/**
 * The read-only progress projection of one Process.
 *
 * Every field is a fact the kernel recorded or `null`. `null` means UNAVAILABLE — the v37 schema
 * stores no per-Agent token accounting and no tool-call counter, so those fields stay `null` and are
 * never estimated from a session, a message count or a clock. `budgetKnown` is `false` until a
 * Process records a budget rather than a default the kernel invented.
 */
export const processProgressViewSchema = z.strictObject({
  budgetKnown: z.boolean(),
  lastProgressAt: z.number().int().nonnegative().nullable(),
  tokenUsage: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  toolCallCount: z.number().int().nonnegative().nullable(),
});
export type ProcessProgressView = z.infer<typeof processProgressViewSchema>;
