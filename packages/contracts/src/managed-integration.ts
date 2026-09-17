import { z } from 'zod';

/**
 * Project-managed integration Signals (ADR-0070 D07, roadmap S8, ADR-0074).
 *
 * `TASK_MERGE_REQUESTED` is the one Signal a Task Service sends when a Task's result is verified and
 * wants to enter its Project's integration ref. Like every kernel Signal it carries an idempotency
 * key and converges on `(targetServiceId, idempotencyKey)`, so a Task Service that sends its request
 * twice queues one merge, not two.
 *
 * `TASK_MERGE_SETTLED` is the Project Service's answer to the Task Service that asked. The
 * projection it describes is written by the Project Service in the same transaction as the queue
 * item's terminal state, so this Signal is a notification with a real effect — the Task Service
 * verifies the projection it receives and records the receipt — rather than the only path by which
 * the fact could exist.
 */

export const taskMergeRequestedSubtype = 'TASK_MERGE_REQUESTED';
export const taskMergeSettledSubtype = 'TASK_MERGE_SETTLED';
export const managedIntegrationContractVersion = 1;

export const taskMergeRequestedPayloadSchema = z.strictObject({
  taskId: z.string().min(1),
  revisionId: z.string().min(1),
  /** The Task result commit that must enter the integration ref. */
  resultCommit: z.string().min(1),
  /** The Task verification run that passed for this exact revision and commit. */
  taskVerificationRunId: z.string().min(1),
  /** Queue order inside the project: higher priority first, then request time, then id. */
  priority: z.number().int().min(-1_000).max(1_000).default(0),
});
export type TaskMergeRequestedPayload = z.infer<typeof taskMergeRequestedPayloadSchema>;

export const taskMergeSettledStates = ['MERGED', 'CONFLICTED', 'FAILED', 'CANCELLED'] as const;

export const taskMergeSettledPayloadSchema = z.strictObject({
  taskId: z.string().min(1),
  queueItemId: z.string().min(1),
  state: z.enum(taskMergeSettledStates),
  /** The commit the integration ref was advanced to; only a `MERGED` item has one. */
  integrationOid: z.string().min(1).nullable(),
  /** The Task integration projection version this notification expects the Task Service to see. */
  projectionVersion: z.number().int().nonnegative(),
});
export type TaskMergeSettledPayload = z.infer<typeof taskMergeSettledPayloadSchema>;
