import { DomainError, requireText, requireVersion } from './errors.js';

export const executionStates = [
  'CREATED', 'PREPARING', 'STARTING', 'RUNNING', 'WAITING_FOR_USER',
  'PAUSING', 'PAUSED', 'STOPPING', 'RECOVERY_REQUIRED',
  'SUCCEEDED', 'FAILED', 'CANCELLED', 'SUPERSEDED',
] as const;
export type ExecutionState = (typeof executionStates)[number];
export type StopReason = 'USER_CANCEL' | 'REVISION_RESTART' | 'SHUTDOWN';

export interface Execution {
  readonly id: string;
  readonly taskId: string;
  readonly initialRevisionId: string;
  readonly appliedRevisionId: string;
  readonly requiredRevisionId: string;
  readonly state: ExecutionState;
  readonly version: number;
  readonly resourceHeld: boolean;
  readonly stopReason: StopReason | null;
  readonly resultCommit: string | null;
}

/** Evidence must be established by the application/adapter, never by terminal text. */
export interface QuiescenceEvidence {
  readonly ref: string;
  readonly toolsQuiescent: boolean;
  readonly ownedWritersStopped: boolean;
}

export type ExecutionEvent =
  | { readonly type: 'PREPARE' }
  | { readonly type: 'START' }
  | { readonly type: 'STARTED' }
  | { readonly type: 'ATTENTION_REQUESTED' }
  | { readonly type: 'ANSWER_ACCEPTED'; readonly allAttentionClosed: boolean }
  | { readonly type: 'REVISION_REQUESTED'; readonly revisionId: string }
  | { readonly type: 'PAUSE_CONFIRMED'; readonly evidence: QuiescenceEvidence }
  | { readonly type: 'REVISION_ACKNOWLEDGED'; readonly revisionId: string; readonly evidenceRef: string }
  | { readonly type: 'RESUME_CONFIRMED'; readonly conflictSafe: boolean; readonly allAttentionClosed: boolean }
  | { readonly type: 'STOP_REQUESTED'; readonly reason: StopReason }
  | { readonly type: 'STOP_CONFIRMED'; readonly evidence: QuiescenceEvidence }
  | { readonly type: 'COMPLETED'; readonly commit: string; readonly evidence: QuiescenceEvidence }
  | { readonly type: 'FAILED'; readonly evidence: QuiescenceEvidence }
  | { readonly type: 'CONTROL_UNCERTAIN' };

const terminalStates: ReadonlySet<ExecutionState> = new Set([
  'SUCCEEDED', 'FAILED', 'CANCELLED', 'SUPERSEDED',
]);

export function isTerminalExecution(state: ExecutionState): boolean {
  return terminalStates.has(state);
}

export function createExecution(input: {
  readonly id: string;
  readonly taskId: string;
  readonly revisionId: string;
}): Execution {
  requireText(input.id, 'executionId');
  requireText(input.taskId, 'taskId');
  requireText(input.revisionId, 'revisionId');
  return Object.freeze({
    id: input.id,
    taskId: input.taskId,
    initialRevisionId: input.revisionId,
    appliedRevisionId: input.revisionId,
    requiredRevisionId: input.revisionId,
    state: 'CREATED',
    version: 0,
    resourceHeld: true,
    stopReason: null,
    resultCommit: null,
  });
}

function guard(condition: boolean, message: string): void {
  if (!condition) throw new DomainError('GUARD_REJECTED', message);
}

function requireQuiescence(evidence: QuiescenceEvidence): void {
  requireText(evidence.ref, 'quiescence evidence');
  guard(evidence.toolsQuiescent === true && evidence.ownedWritersStopped === true,
    'All owned writers must be confirmed quiescent');
}

/** Pure transition only. It does not pause/stop a process, send input, or release a worktree. */
export function transitionExecution(
  execution: Execution,
  expectedVersion: number,
  event: ExecutionEvent,
): Execution {
  requireVersion(execution.version, expectedVersion);
  if (isTerminalExecution(execution.state) || execution.state === 'RECOVERY_REQUIRED') {
    throw new DomainError('INVALID_TRANSITION', 'Terminal or uncertain execution requires a separate recovery path');
  }
  const requireState = (...allowed: readonly ExecutionState[]): void => {
    if (!allowed.includes(execution.state)) {
      throw new DomainError('INVALID_TRANSITION', `${event.type} is invalid from ${execution.state}`);
    }
  };
  let patch: Partial<Execution>;
  switch (event.type) {
    case 'PREPARE':
      requireState('CREATED');
      patch = { state: 'PREPARING' };
      break;
    case 'START':
      requireState('PREPARING');
      patch = { state: 'STARTING' };
      break;
    case 'STARTED':
      requireState('STARTING');
      patch = { state: 'RUNNING' };
      break;
    case 'ATTENTION_REQUESTED':
      requireState('RUNNING');
      patch = { state: 'WAITING_FOR_USER' };
      break;
    case 'ANSWER_ACCEPTED':
      requireState('WAITING_FOR_USER');
      guard(event.allAttentionClosed === true, 'Unanswered attention remains');
      guard(execution.appliedRevisionId === execution.requiredRevisionId, 'Pending revision');
      patch = { state: 'RUNNING' };
      break;
    case 'REVISION_REQUESTED':
      requireState('RUNNING', 'WAITING_FOR_USER', 'PAUSING', 'PAUSED');
      requireText(event.revisionId, 'revisionId');
      guard(event.revisionId !== execution.requiredRevisionId, 'Revision must be new');
      patch = { state: 'PAUSING', requiredRevisionId: event.revisionId };
      break;
    case 'PAUSE_CONFIRMED':
      requireState('PAUSING');
      requireQuiescence(event.evidence);
      patch = { state: 'PAUSED' };
      break;
    case 'REVISION_ACKNOWLEDGED':
      requireState('PAUSED');
      requireText(event.evidenceRef, 'revision acknowledgement evidence');
      guard(event.revisionId === execution.requiredRevisionId, 'Stale revision acknowledgement');
      patch = { appliedRevisionId: event.revisionId };
      break;
    case 'RESUME_CONFIRMED':
      requireState('PAUSED');
      guard(execution.appliedRevisionId === execution.requiredRevisionId, 'Latest revision must be acknowledged');
      guard(event.conflictSafe === true, 'Conflict must be reassessed before resume');
      guard(event.allAttentionClosed === true, 'Unanswered attention remains');
      patch = { state: 'RUNNING' };
      break;
    case 'STOP_REQUESTED':
      requireState('CREATED', 'PREPARING', 'STARTING', 'RUNNING', 'WAITING_FOR_USER', 'PAUSING', 'PAUSED');
      patch = { state: 'STOPPING', stopReason: event.reason };
      break;
    case 'STOP_CONFIRMED':
      requireState('STOPPING');
      requireQuiescence(event.evidence);
      // Shutdown recovery semantics are deliberately not implemented in Phase 0.
      guard(execution.stopReason !== null && execution.stopReason !== 'SHUTDOWN',
        'Shutdown requires application-level recovery policy');
      patch = {
        state: execution.stopReason === 'USER_CANCEL' ? 'CANCELLED' : 'SUPERSEDED',
        resourceHeld: false,
      };
      break;
    case 'COMPLETED':
      requireState('RUNNING');
      requireQuiescence(event.evidence);
      guard(execution.appliedRevisionId === execution.requiredRevisionId, 'Cannot complete stale revision');
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(event.commit)) {
        throw new DomainError('INVALID_VALUE', 'Result must be a full Git object ID');
      }
      patch = { state: 'SUCCEEDED', resourceHeld: false, resultCommit: event.commit };
      break;
    case 'FAILED':
      requireState('CREATED', 'PREPARING', 'STARTING', 'RUNNING', 'WAITING_FOR_USER', 'PAUSING', 'PAUSED');
      requireQuiescence(event.evidence);
      patch = { state: 'FAILED', resourceHeld: false };
      break;
    case 'CONTROL_UNCERTAIN':
      patch = { state: 'RECOVERY_REQUIRED' }; // Never free ownership on timeout.
      break;
    default: {
      const exhaustive: never = event;
      throw new DomainError('INVALID_TRANSITION', `Unknown event: ${String(exhaustive)}`);
    }
  }
  return Object.freeze({ ...execution, ...patch, version: execution.version + 1 });
}
