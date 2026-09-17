import { z } from 'zod';

/**
 * The `INTENTION_RESOLVED` `SIG_A` (ADR-0070 §5.1, S6 lane contract §3).
 *
 * An intention is created as a `SIG_P` (`INTENT_SUBMITTED`) and the Runtime turns it into an
 * `INTENTION` Process that is only `CREATED`: nothing here interprets natural language. This Signal is
 * the *structured* half — the interpretation an Agent (or, today, a person driving the CLI) produced.
 * Its three outcomes are the whole vocabulary this round:
 *
 * - `ROUTE` — send an instruction to a Service the Process's parent can see;
 * - `TYPED_COMMAND` — run one command of a closed whitelist (today: record Session Guidance);
 * - `REQUEST_CLARIFICATION` — the target was not clear, so the Process waits for the user instead of
 *   guessing. This round that wait is a kernel fact, not an Attention row: see below.
 *
 * A Process that is waiting for an answer is resolved by sending this same subtype again with a new
 * idempotency key and the open clarification named in the Signal's `causationId`.
 */
export const intentionResolvedSubtype = 'INTENTION_RESOLVED';

/**
 * The structured outcome. `strictObject` everywhere, so a caller cannot smuggle a field past the
 * vocabulary of this round and have it silently ignored.
 *
 * `TYPED_COMMAND` is deliberately a one-member union: the command name is a literal, so a caller
 * cannot ask the kernel to run an arbitrary string, and adding a second command is a contract change
 * rather than a runtime lookup.
 */
export const intentionOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ROUTE'),
    targetServiceId: z.string().min(1),
    instruction: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('TYPED_COMMAND'),
    command: z.literal('SESSION_GUIDANCE_RECORD'),
    targetTaskServiceId: z.string().min(1),
    message: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('REQUEST_CLARIFICATION'),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(2).max(4).optional(),
  }),
]);
export type IntentionOutcome = z.infer<typeof intentionOutcomeSchema>;
export type IntentionOutcomeKind = IntentionOutcome['kind'];

export const intentionResolvedPayloadSchema = z.strictObject({
  processId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  outcome: intentionOutcomeSchema,
});
export type IntentionResolvedPayload = z.infer<typeof intentionResolvedPayloadSchema>;

/**
 * `CREATE_TASK` is **not** part of this round: creating a Task is S7's write path (ADR-0070 §D06/D10),
 * so `intentionOutcomeSchema` has no member for it and nothing here decides what a Task would become.
 *
 * It is still named, because "the schema has no member for it" must not be the same thing as "the
 * request disappeared". Without the shape below a `CREATE_TASK` intention would be reported as
 * `INVALID_SIGNAL_PAYLOAD` — a caller would read that as "my JSON was broken" instead of "this
 * capability is a later wave". With it, the kernel answers the stable code
 * `INTENTION_CREATE_TASK_UNSUPPORTED` and says so in the message, so the intent is refused by name.
 *
 * The member carries **no semantics**: the domain rejects it with that code before any fact is
 * written, and a `CREATE_TASK` payload never moves a Process, records an audit event or leaves a
 * receipt other than the dead-lettered Signal itself.
 */
export const intentionCreateTaskOutcomeKind = 'CREATE_TASK';
export const intentionCreateTaskRefusalCode = 'INTENTION_CREATE_TASK_UNSUPPORTED';
export const intentionCreateTaskRefusalSchema = z.strictObject({
  processId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  // Loose on purpose: whatever a caller believes a Task-creation outcome looks like, this member must
  // match it so the refusal names the boundary instead of failing on an unexpected extra field first.
  outcome: z.looseObject({ kind: z.literal(intentionCreateTaskOutcomeKind) }),
});
export type IntentionCreateTaskRefusal = z.infer<typeof intentionCreateTaskRefusalSchema>;

/**
 * What the `INTENTION_RESOLVED` contract entry actually accepts: the frozen payload, plus the one
 * shape that exists only to be refused by name. The union is what a Service registers; the parsing
 * half of the kernel never decides semantics, and the handler is the single place that turns the
 * refusal member into `intentionCreateTaskRefusalCode`.
 */
export const intentionResolvedSignalPayloadSchema = z.union([
  intentionResolvedPayloadSchema,
  intentionCreateTaskRefusalSchema,
]);
export type IntentionResolvedSignalPayload = z.infer<typeof intentionResolvedSignalPayloadSchema>;
