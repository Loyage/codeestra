import { DomainError, requireText, requireVersion, type DomainErrorCode } from './errors.js';

/**
 * The delivery of one Task revision into one running Execution (PROJECT_SPEC §2.11).
 *
 * A revision that was created while an Execution was running is a *requirement*, not a message:
 * somebody has to establish that the Execution which must know the new specification really knows
 * it. This FSM therefore never treats "the message was sent" as an acknowledgement. Only two facts
 * satisfy a delivery:
 *
 * - `ACKNOWLEDGED`: a channel that can acknowledge did so, and the acknowledgement named exactly
 *   this revision (`evidenceRef` is the structured proof the adapter returned).
 * - `SUPERSEDED_BY_RESTART`: the ADR-0001-era fallback actually happened — the Execution holding
 *   the old revision stopped and a *new* Execution was recorded whose applied revision is this
 *   revision. That successor row is the proof, not a Runtime claim.
 *
 * Everything else (`PENDING`, `IN_FLIGHT`, `UNACKNOWLEDGED`, `CHANNEL_UNSUPPORTED`, `TIMED_OUT`,
 * `FAILED`) stays recorded and unsatisfied, because a delivery that could not be confirmed must
 * remain visible instead of being quietly dropped.
 */
export const revisionDeliveryStates = [
  'PENDING',
  'IN_FLIGHT',
  'ACKNOWLEDGED',
  'UNACKNOWLEDGED',
  'CHANNEL_UNSUPPORTED',
  'TIMED_OUT',
  'FAILED',
  'SUPERSEDED_BY_RESTART',
] as const;
export type RevisionDeliveryState = (typeof revisionDeliveryStates)[number];

/** How a revision was (or was not) carried into the Execution. */
export const revisionDeliveryChannels = ['PROVIDER_CONVERSATION', 'STOP_AND_RESTART'] as const;
export type RevisionDeliveryChannel = (typeof revisionDeliveryChannels)[number];

export interface RevisionDelivery {
  readonly id: string;
  readonly taskId: string;
  readonly revisionId: string;
  readonly state: RevisionDeliveryState;
  readonly attemptCount: number;
  /** Structured proof for a satisfied delivery; null while nothing was acknowledged. */
  readonly evidenceRef: string | null;
  readonly version: number;
}

export type RevisionDeliveryEvent =
  | { readonly type: 'ATTEMPT_STARTED'; readonly channel: RevisionDeliveryChannel }
  | {
    readonly type: 'ACKNOWLEDGED';
    readonly revisionId: string;
    /** The Task's current revision at the moment the acknowledgement is recorded. */
    readonly requiredRevisionId: string;
    readonly evidenceRef: string;
  }
  | { readonly type: 'NOT_ACKNOWLEDGED'; readonly detail: string }
  | { readonly type: 'CHANNEL_UNSUPPORTED'; readonly capability: string }
  | { readonly type: 'TIMED_OUT'; readonly detail: string }
  | { readonly type: 'FAILED'; readonly code: string }
  | {
    readonly type: 'SUPERSEDED_BY_RESTART';
    readonly successorExecutionId: string;
    /** The revision the successor Execution was actually recorded with. */
    readonly successorRevisionId: string;
  };

export function createRevisionDelivery(input: {
  readonly id: string;
  readonly taskId: string;
  readonly revisionId: string;
}): RevisionDelivery {
  requireText(input.id, 'revisionDeliveryId');
  requireText(input.taskId, 'taskId');
  requireText(input.revisionId, 'revisionId');
  return Object.freeze({
    id: input.id,
    taskId: input.taskId,
    revisionId: input.revisionId,
    state: 'PENDING',
    attemptCount: 0,
    evidenceRef: null,
    version: 0,
  });
}

/**
 * True only when the Execution that must know this revision provably knows it. A caller that wants
 * to decide "may this Execution keep going / resume" must ask this and nothing else.
 */
export function revisionDeliverySatisfied(state: RevisionDeliveryState): boolean {
  return state === 'ACKNOWLEDGED' || state === 'SUPERSEDED_BY_RESTART';
}

/** True while a delivery still needs an explicit disposition from the user or the Runtime. */
export function revisionDeliveryNeedsDisposition(state: RevisionDeliveryState): boolean {
  return !revisionDeliverySatisfied(state);
}

function guard(condition: boolean, message: string, code: DomainErrorCode = 'INVALID_TRANSITION'): void {
  if (!condition) throw new DomainError(code, message);
}

/**
 * Pure transition only. It does not send anything to a provider, does not start a process, and does
 * not verify a successor Execution row; those are facts the application records through the events.
 */
export function transitionRevisionDelivery(
  delivery: RevisionDelivery,
  expectedVersion: number,
  event: RevisionDeliveryEvent,
): RevisionDelivery {
  requireVersion(delivery.version, expectedVersion);
  if (revisionDeliverySatisfied(delivery.state)) {
    // A second acknowledgement is not a new fact. Refusing it (instead of ignoring it) is what makes
    // a duplicate or replayed ACK visible to the caller that sent it.
    throw new DomainError('REVISION_ALREADY_ACKNOWLEDGED',
      `Revision delivery is already ${delivery.state}; it cannot be acknowledged twice`);
  }
  let patch: Partial<RevisionDelivery>;
  switch (event.type) {
    case 'ATTEMPT_STARTED':
      guard(delivery.state !== 'IN_FLIGHT', 'A revision delivery attempt is already in flight');
      patch = { state: 'IN_FLIGHT', attemptCount: delivery.attemptCount + 1 };
      break;
    case 'ACKNOWLEDGED':
      guard(delivery.state === 'IN_FLIGHT', 'ACKNOWLEDGED requires an in-flight attempt');
      requireText(event.evidenceRef, 'revision acknowledgement evidence');
      guard(event.revisionId === delivery.revisionId,
        `Acknowledgement names revision ${event.revisionId} but this delivery is for`
        + ` ${delivery.revisionId}`, 'STALE_REVISION_ACKNOWLEDGEMENT');
      guard(event.requiredRevisionId === delivery.revisionId,
        `The Task has moved on to revision ${event.requiredRevisionId}; the acknowledgement of`
        + ` ${delivery.revisionId} is stale`, 'STALE_REVISION_ACKNOWLEDGEMENT');
      patch = { state: 'ACKNOWLEDGED', evidenceRef: event.evidenceRef };
      break;
    case 'NOT_ACKNOWLEDGED':
      guard(delivery.state === 'IN_FLIGHT', 'NOT_ACKNOWLEDGED requires an in-flight attempt');
      requireText(event.detail, 'detail');
      patch = { state: 'UNACKNOWLEDGED' };
      break;
    case 'CHANNEL_UNSUPPORTED':
      guard(delivery.state === 'IN_FLIGHT', 'CHANNEL_UNSUPPORTED requires an in-flight attempt');
      requireText(event.capability, 'capability');
      patch = { state: 'CHANNEL_UNSUPPORTED' };
      break;
    case 'TIMED_OUT':
      guard(delivery.state === 'IN_FLIGHT', 'TIMED_OUT requires an in-flight attempt');
      requireText(event.detail, 'detail');
      patch = { state: 'TIMED_OUT' };
      break;
    case 'FAILED':
      guard(delivery.state === 'IN_FLIGHT', 'FAILED requires an in-flight attempt');
      requireText(event.code, 'code');
      patch = { state: 'FAILED' };
      break;
    case 'SUPERSEDED_BY_RESTART':
      // A successor Execution recorded with this revision is stronger evidence than an attempt that
      // is still open, so a restart resolution may close an in-flight attempt as well.
      requireText(event.successorExecutionId, 'successorExecutionId');
      guard(event.successorRevisionId === delivery.revisionId,
        `The successor Execution was recorded with revision ${event.successorRevisionId}, not`
        + ` ${delivery.revisionId}`, 'SUCCESSOR_REVISION_MISMATCH');
      patch = { state: 'SUPERSEDED_BY_RESTART', evidenceRef: `execution:${event.successorExecutionId}` };
      break;
    default: {
      const exhaustive: never = event;
      throw new DomainError('INVALID_TRANSITION', `Unknown event: ${String(exhaustive)}`);
    }
  }
  return Object.freeze({ ...delivery, ...patch, version: delivery.version + 1 });
}
