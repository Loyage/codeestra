import { DomainError } from './errors.js';
import type { ProcessKind, ProcessState, ServiceKind } from './service-kernel.js';

/**
 * Pure domain half of the intention route (ADR-0070 §8, S6 lane contract §3).
 *
 * Nothing here reads a database, spawns a process or talks to an Agent: the module decides *whether a
 * structured outcome may be applied at all*, and the Runtime layer is left with the question of how to
 * record that it was. That split is what makes "the target was not visible" a fact that can be
 * asserted without a Runtime, and it keeps the refusal codes identical no matter which transport
 * carried the `INTENTION_RESOLVED` `SIG_A`.
 *
 * The module is deliberately smaller than the wire contract in `@codeestra/contracts`: the Zod schema
 * is the transport's validation, this is the routing precondition set. When the two disagree the
 * mistake is a bug, not a lenient default.
 */

/** The outcome vocabulary of this round. `CREATE_TASK` is S7's boundary, not a missing member here. */
export const intentionOutcomeKinds = ['ROUTE', 'TYPED_COMMAND', 'REQUEST_CLARIFICATION'] as const;
export type IntentionOutcomeKind = (typeof intentionOutcomeKinds)[number];

/** The only typed command this round's whitelist contains (ADR-0057 Session Guidance). */
export const intentionGuidanceCommand = 'SESSION_GUIDANCE_RECORD';

export interface IntentionRouteOutcome {
  readonly kind: 'ROUTE';
  readonly targetServiceId: string;
  readonly instruction: string;
}

export interface IntentionTypedCommandOutcome {
  readonly kind: 'TYPED_COMMAND';
  readonly command: typeof intentionGuidanceCommand;
  readonly targetTaskServiceId: string;
  readonly message: string;
}

export interface IntentionClarificationOutcome {
  readonly kind: 'REQUEST_CLARIFICATION';
  readonly question: string;
  readonly options: readonly string[] | null;
}

export type IntentionOutcome =
  | IntentionRouteOutcome
  | IntentionTypedCommandOutcome
  | IntentionClarificationOutcome;

/** The Process facts the routing rules are decided from; a structural subset of the stored view. */
export interface IntentionProcessFacts {
  readonly processId: string;
  readonly kind: ProcessKind;
  /**
   * `EXECUTION` means the Process's state is a projection of its Execution. Such a Process has no
   * intention of its own to resolve and is refused instead of being written to by a second writer.
   */
  readonly statusSource: 'PROCESS' | 'EXECUTION';
  /**
   * `null` for an Execution-backed Process, whose state lives on its Execution. A `PROCESS`-owned
   * Process always has one, so the refusal above is decided before this is ever read as a state.
   */
  readonly state: ProcessState | null;
  readonly version: number;
  readonly parentServiceId: string;
}

export interface IntentionServiceFacts {
  readonly serviceId: string;
  readonly kind: ServiceKind;
  readonly parentServiceId: string | null;
}

/** One clarification that a Process is still waiting on, as recorded in the kernel's audit ledger. */
export interface IntentionClarificationRef {
  readonly clarificationId: string;
  readonly processId: string;
  readonly targetServiceId: string;
  readonly question: string;
  readonly options: readonly string[] | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly requestedAt: number;
}

/** One step of the Process state changes an outcome applies. `expectedVersion` is the CAS precondition. */
export interface IntentionTransitionStep {
  readonly expectedVersion: number;
  readonly next: ProcessState;
  readonly reason: string;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError('INVALID_INTENTION_OUTCOME', `${name} must be a non-empty string`);
  }
  return value;
}

function assertPlainObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_INTENTION_OUTCOME', `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseClarificationOptions(value: unknown): readonly string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    throw new DomainError('INVALID_INTENTION_OUTCOME',
      'Clarification options must be a list of two to four choices when they are given');
  }
  return Object.freeze(value.map((option) => requireText(option, 'Clarification option')));
}

/**
 * Reads one structured outcome from untrusted input.
 *
 * The `CREATE_TASK` branch is the S7 boundary stated as a refusal rather than as a missing case: a
 * caller that asks for a Task to be created gets `INTENTION_CREATE_TASK_UNSUPPORTED` and a message
 * naming the wave that owns it, instead of "invalid payload" (and never a silent no-op).
 */
export function parseIntentionOutcome(value: unknown): IntentionOutcome {
  const outcome = assertPlainObject(value, 'Intention outcome');
  const kind = outcome['kind'];
  if (kind === 'CREATE_TASK') {
    throw new DomainError('INTENTION_CREATE_TASK_UNSUPPORTED',
      'Creating a Task from an intention is the S7 Project/Task Service write path (ADR-0070 D06/D10);'
      + ' this round routes, records Session Guidance or asks the user, and refuses CREATE_TASK by name'
      + ' instead of dropping the request');
  }
  if (kind === 'ROUTE') {
    return Object.freeze({ kind: 'ROUTE',
      targetServiceId: requireText(outcome['targetServiceId'], 'ROUTE targetServiceId'),
      instruction: requireText(outcome['instruction'], 'ROUTE instruction') });
  }
  if (kind === 'TYPED_COMMAND') {
    if (outcome['command'] !== intentionGuidanceCommand) {
      throw new DomainError('INVALID_INTENTION_OUTCOME',
        `TYPED_COMMAND accepts only ${intentionGuidanceCommand}; the kernel never runs a caller-supplied`
        + ' command string');
    }
    return Object.freeze({ kind: 'TYPED_COMMAND', command: intentionGuidanceCommand,
      targetTaskServiceId: requireText(outcome['targetTaskServiceId'], 'TYPED_COMMAND targetTaskServiceId'),
      message: requireText(outcome['message'], 'TYPED_COMMAND message') });
  }
  if (kind === 'REQUEST_CLARIFICATION') {
    return Object.freeze({ kind: 'REQUEST_CLARIFICATION',
      question: requireText(outcome['question'], 'REQUEST_CLARIFICATION question'),
      options: parseClarificationOptions(outcome['options']) });
  }
  throw new DomainError('INVALID_INTENTION_OUTCOME',
    `Intention outcome kind must be one of ${intentionOutcomeKinds.join(', ')}`);
}

export interface IntentionResolvedPayloadFacts {
  readonly processId: string;
  readonly expectedVersion: number;
  readonly outcome: IntentionOutcome;
}

/** The payload envelope as the routing rules read it: the Process to move, the CAS version, the outcome. */
export function parseIntentionResolvedPayload(value: unknown): IntentionResolvedPayloadFacts {
  const payload = assertPlainObject(value, 'Intention payload');
  const expectedVersion = payload['expectedVersion'];
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion)
    || expectedVersion < 0) {
    throw new DomainError('INVALID_INTENTION_OUTCOME',
      'Intention payload expectedVersion must be a non-negative integer');
  }
  return Object.freeze({ processId: requireText(payload['processId'], 'Intention payload processId'),
    expectedVersion, outcome: parseIntentionOutcome(payload['outcome']) });
}

const resolvableIntentionStates: readonly ProcessState[] = ['CREATED', 'RUNNING', 'WAITING_FOR_USER'];

/**
 * Only a native `INTENTION` Process can be resolved: an Execution-backed Projection has a different
 * writer, and a terminal Process is finished rather than pending. A Process waiting for the user is
 * still resolvable — that is exactly how a clarification is answered.
 */
export function assertResolvableIntentionProcess(
  facts: IntentionProcessFacts,
): asserts facts is IntentionProcessFacts & { readonly state: ProcessState } {
  if (facts.kind !== 'INTENTION') {
    throw new DomainError('INTENTION_PROCESS_NOT_RESOLVABLE',
      `Process ${facts.processId} is ${facts.kind}, not INTENTION`);
  }
  if (facts.statusSource !== 'PROCESS') {
    throw new DomainError('INTENTION_PROCESS_NOT_RESOLVABLE',
      `Process ${facts.processId} projects its state from an Execution and is not written directly`);
  }
  if (facts.state === null || !resolvableIntentionStates.includes(facts.state)) {
    throw new DomainError('INTENTION_PROCESS_NOT_RESOLVABLE',
      `Process ${facts.processId} is ${facts.state ?? 'UNKNOWN'} and has no intention left to resolve`);
  }
}

/**
 * A `ROUTE` target must be a Service the Process's parent can see: root routes to its direct Projects,
 * a Project routes to its own Tasks, and a Task Service has no visible children at all. Routing to a
 * Service outside that subtree is refused rather than recorded as a fact nobody can act on.
 */
export function assertIntentionTargetVisible(input: {
  readonly parent: IntentionServiceFacts;
  readonly target: IntentionServiceFacts;
}): void {
  const { parent, target } = input;
  const visible = (parent.kind === 'ROOT' && target.kind === 'PROJECT'
      && target.parentServiceId === parent.serviceId)
    || (parent.kind === 'PROJECT' && target.kind === 'TASK'
      && target.parentServiceId === parent.serviceId);
  if (!visible) {
    throw new DomainError('INTENTION_TARGET_NOT_VISIBLE',
      `${parent.kind} Service ${parent.serviceId} cannot route to ${target.kind} Service`
      + ` ${target.serviceId}`);
  }
}

/**
 * Answering a clarification means naming the question being answered.
 *
 * The payload schema is a `strictObject` and cannot grow a field for this, so the Signal envelope's
 * `causationId` carries the reference: it is the one place the kernel already keeps "what directly
 * caused this" for a Signal, and it is readable from the existing `signal get`. A reply that does not
 * name the open clarification is refused, so an answer can never be applied to the wrong question.
 */
export function assertIntentionClarificationReply(input: {
  readonly open: IntentionClarificationRef | null;
  readonly causationId: string | null;
}): IntentionClarificationRef {
  const { open, causationId } = input;
  if (open === null) {
    throw new DomainError('INTENTION_CLARIFICATION_NOT_FOUND',
      'This Process is waiting for the user but no open clarification is recorded for it');
  }
  if (causationId === null || causationId !== open.clarificationId) {
    throw new DomainError('INTENTION_CLARIFICATION_MISMATCH',
      `This reply does not name clarification ${open.clarificationId}; set the Signal causationId to it`);
  }
  return open;
}

/**
 * The Process state changes one outcome applies, as versions to be passed to `transitionProcess`.
 *
 * The lane contract wrote the entry states as `CREATED|RUNNING → RUNNING`, but the Process FSM this lane
 * must use read-only has no `CREATED → RUNNING` edge: a `CREATED` Process reaches `RUNNING` through
 * `STARTING`. The plan therefore walks that legal path instead of asking the FSM for an edge it does not
 * have, and a Process already `RUNNING` applies the outcome directly. A Process answering a clarification
 * leaves `WAITING_FOR_USER` through `RUNNING`, which the FSM does allow.
 */
export function intentionOutcomeTransitionPlan(input: {
  readonly state: ProcessState;
  readonly expectedVersion: number;
  readonly kind: IntentionOutcomeKind;
  readonly replying: boolean;
}): readonly IntentionTransitionStep[] {
  const steps: IntentionTransitionStep[] = [];
  let version = input.expectedVersion;
  if (input.state === 'CREATED') {
    steps.push({ expectedVersion: version, next: 'STARTING',
      reason: 'the intention Process starts before it is resolved' });
    version += 1;
  }
  const needsRunning = input.state === 'CREATED'
    || (input.replying && input.state === 'WAITING_FOR_USER');
  if (needsRunning) {
    steps.push({ expectedVersion: version, next: 'RUNNING',
      reason: input.replying
        ? 'the clarification was answered; the Process resumes before the outcome is applied'
        : 'the intention is being resolved' });
    version += 1;
  }
  const settled: ProcessState = input.kind === 'REQUEST_CLARIFICATION'
    ? 'WAITING_FOR_USER' : 'SUCCEEDED';
  steps.push({ expectedVersion: version, next: settled,
    reason: input.kind === 'REQUEST_CLARIFICATION'
      ? 'the target was not clear, so the Process waits for the user instead of guessing'
      : `intention resolved as ${input.kind}` });
  return Object.freeze(steps.map((step) => Object.freeze(step)));
}
