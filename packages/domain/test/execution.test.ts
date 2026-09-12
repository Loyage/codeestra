import { describe, expect, it } from 'vitest';
import {
  createExecution, transitionExecution, executionStates, isTerminalExecution,
  type Execution, type ExecutionEvent, type ExecutionState,
} from '../src/index.js';

const evidence = { ref: 'proof-1', toolsQuiescent: true, ownedWritersStopped: true };
const commit = 'a'.repeat(40);
const resume = { type: 'RESUME_CONFIRMED', conflictSafe: true, allAttentionClosed: true } as const;
const created = (): Execution => createExecution({ id: 'exec-1', taskId: 'task-1', revisionId: 'revision-1' });
const step = (state: Execution, event: ExecutionEvent): Execution => transitionExecution(state, state.version, event);
const running = (): Execution => [
  { type: 'PREPARE' }, { type: 'START' }, { type: 'STARTED' },
].reduce((execution, event) => step(execution, event as ExecutionEvent), created());
const paused = (): Execution => step(step(running(), {
  type: 'REVISION_REQUESTED', revisionId: 'revision-2',
}), { type: 'PAUSE_CONFIRMED', evidence });

const exampleEvents: readonly ExecutionEvent[] = [
  { type: 'PREPARE' }, { type: 'START' }, { type: 'STARTED' },
  { type: 'ATTENTION_REQUESTED' }, { type: 'ANSWER_ACCEPTED', allAttentionClosed: true },
  { type: 'REVISION_REQUESTED', revisionId: 'revision-2' },
  { type: 'PAUSE_CONFIRMED', evidence },
  { type: 'REVISION_ACKNOWLEDGED', revisionId: 'revision-1', evidenceRef: 'ack' },
  resume, { type: 'STOP_REQUESTED', reason: 'USER_CANCEL' },
  { type: 'STOP_CONFIRMED', evidence }, { type: 'COMPLETED', commit, evidence },
  { type: 'FAILED', evidence }, { type: 'CONTROL_UNCERTAIN' },
];

// Transition topology is specified independently of implementation switch branches.
const allowed: Record<ExecutionEvent['type'], readonly ExecutionState[]> = {
  PREPARE: ['CREATED'],
  START: ['PREPARING'],
  STARTED: ['STARTING'],
  ATTENTION_REQUESTED: ['RUNNING'],
  ANSWER_ACCEPTED: ['WAITING_FOR_USER'],
  REVISION_REQUESTED: ['RUNNING', 'WAITING_FOR_USER', 'PAUSING', 'PAUSED'],
  PAUSE_CONFIRMED: ['PAUSING'],
  REVISION_ACKNOWLEDGED: ['PAUSED'],
  RESUME_CONFIRMED: ['PAUSED'],
  STOP_REQUESTED: ['CREATED', 'PREPARING', 'STARTING', 'RUNNING', 'WAITING_FOR_USER', 'PAUSING', 'PAUSED'],
  STOP_CONFIRMED: ['STOPPING'],
  COMPLETED: ['RUNNING'],
  FAILED: ['CREATED', 'PREPARING', 'STARTING', 'RUNNING', 'WAITING_FOR_USER', 'PAUSING', 'PAUSED'],
  CONTROL_UNCERTAIN: ['CREATED', 'PREPARING', 'STARTING', 'RUNNING', 'WAITING_FOR_USER', 'PAUSING', 'PAUSED', 'STOPPING'],
};

describe('Execution transition topology', () => {
  for (const state of executionStates) {
    for (const event of exampleEvents) {
      it(`${state} + ${event.type}`, () => {
        const execution: Execution = {
          ...created(), state, stopReason: state === 'STOPPING' ? 'USER_CANCEL' : null,
          resourceHeld: !isTerminalExecution(state),
        };
        if (allowed[event.type].includes(state)) {
          const next = step(execution, event);
          expect(next.version).toBe(1);
          expect(next.resourceHeld).toBe(!isTerminalExecution(next.state));
          expect(Object.isFrozen(next)).toBe(true);
        } else {
          expect(() => step(execution, event)).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }));
        }
        expect(execution.version).toBe(0);
      });
    }
  }
});

describe('Execution safety guards', () => {
  it('does not treat execution success as verification or main integration', () => {
    const execution = step(running(), { type: 'COMPLETED', commit, evidence });
    expect(execution.state).toBe('SUCCEEDED');
    expect(execution.resultCommit).toBe(commit);
    expect(execution).not.toHaveProperty('verificationState');
    expect(execution).not.toHaveProperty('integrationState');
  });

  it('requires pause, latest revision acknowledgement, then safe resume', () => {
    const active = running();
    const pausing = step(active, { type: 'REVISION_REQUESTED', revisionId: 'revision-2' });
    expect(pausing.state).toBe('PAUSING');
    expect(pausing.appliedRevisionId).toBe('revision-1');
    expect(pausing.resourceHeld).toBe(true);
    expect(() => step(pausing, { type: 'COMPLETED', commit, evidence })).toThrow();
    const stopped = step(pausing, { type: 'PAUSE_CONFIRMED', evidence });
    expect(() => step(stopped, resume)).toThrow(expect.objectContaining({ code: 'GUARD_REJECTED' }));
    const acknowledged = step(stopped, {
      type: 'REVISION_ACKNOWLEDGED', revisionId: 'revision-2', evidenceRef: 'ack-2',
    });
    expect(() => step(acknowledged, { ...resume, conflictSafe: false })).toThrow();
    expect(() => step(acknowledged, { ...resume, allAttentionClosed: false })).toThrow();
    const done = step(step(acknowledged, resume), { type: 'COMPLETED', commit, evidence });
    expect(done.initialRevisionId).toBe('revision-1');
    expect(done.appliedRevisionId).toBe('revision-2');
  });

  it('rejects old ACK after another revision arrives while paused', () => {
    const pausing = step(paused(), { type: 'REVISION_REQUESTED', revisionId: 'revision-3' });
    const stopped = step(pausing, { type: 'PAUSE_CONFIRMED', evidence });
    expect(() => step(stopped, {
      type: 'REVISION_ACKNOWLEDGED', revisionId: 'revision-2', evidenceRef: 'late-ack',
    })).toThrow(expect.objectContaining({ code: 'GUARD_REJECTED' }));
  });

  it('requires confirmation of every owned writer, not just silent output', () => {
    const pausing = step(running(), { type: 'REVISION_REQUESTED', revisionId: 'revision-2' });
    expect(() => step(pausing, {
      type: 'PAUSE_CONFIRMED', evidence: { ...evidence, ownedWritersStopped: false },
    })).toThrow();
    expect(pausing.state).toBe('PAUSING');
    expect(pausing.resourceHeld).toBe(true);
  });

  it('cancellation timeout retains ownership and requires recovery', () => {
    const stopping = step(running(), { type: 'STOP_REQUESTED', reason: 'USER_CANCEL' });
    expect(stopping.state).toBe('STOPPING');
    expect(() => step(stopping, {
      type: 'STOP_CONFIRMED', evidence: { ...evidence, toolsQuiescent: false },
    })).toThrow();
    const uncertain = step(stopping, { type: 'CONTROL_UNCERTAIN' });
    expect(uncertain.state).toBe('RECOVERY_REQUIRED');
    expect(uncertain.resourceHeld).toBe(true);
    expect(() => step(uncertain, { type: 'STARTED' })).toThrow();
  });

  it.each([
    ['USER_CANCEL', 'CANCELLED'], ['REVISION_RESTART', 'SUPERSEDED'],
  ] as const)('records %s without losing the reason', (reason, expectedState) => {
    const result = step(step(running(), { type: 'STOP_REQUESTED', reason }), { type: 'STOP_CONFIRMED', evidence });
    expect(result.state).toBe(expectedState);
    expect(result.stopReason).toBe(reason);
    expect(result.resourceHeld).toBe(false);
  });

  it('does not silently map Runtime shutdown to user cancellation', () => {
    const stopping = step(running(), { type: 'STOP_REQUESTED', reason: 'SHUTDOWN' });
    expect(() => step(stopping, { type: 'STOP_CONFIRMED', evidence })).toThrow();
  });

  it('does not resume while another attention request remains open', () => {
    const waiting = step(running(), { type: 'ATTENTION_REQUESTED' });
    expect(() => step(waiting, { type: 'ANSWER_ACCEPTED', allAttentionClosed: false })).toThrow();
    expect(step(waiting, { type: 'ANSWER_ACCEPTED', allAttentionClosed: true }).state).toBe('RUNNING');
  });

  it('rejects a duplicate command carrying a stale aggregate version', () => {
    const old = created();
    const preparing = step(old, { type: 'PREPARE' });
    expect(() => transitionExecution(preparing, old.version, { type: 'PREPARE' }))
      .toThrow(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  });

  it.each(['main', 'abc123', '', 'g'.repeat(40)])('rejects non-OID result %s', (value) => {
    expect(() => step(running(), { type: 'COMPLETED', commit: value, evidence })).toThrow();
  });

  it('accepts SHA-256 repositories without assuming SHA-1', () => {
    expect(step(running(), { type: 'COMPLETED', commit: 'b'.repeat(64), evidence }).resultCommit).toHaveLength(64);
  });
});
