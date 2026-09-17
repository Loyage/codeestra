import { describe, expect, it } from 'vitest';
import {
  assertIntentionClarificationReply,
  assertIntentionTargetVisible,
  assertResolvableIntentionProcess,
  intentionOutcomeTransitionPlan,
  parseIntentionOutcome,
  parseIntentionResolvedPayload,
  transitionProcess,
  type IntentionProcessFacts,
  type ProcessState,
} from '../src/index.js';

const root = { serviceId: 'root', kind: 'ROOT' as const, parentServiceId: null };
const project = { serviceId: 'project-1', kind: 'PROJECT' as const, parentServiceId: 'root' };
const otherProject = { serviceId: 'project-2', kind: 'PROJECT' as const, parentServiceId: 'root' };
const task = { serviceId: 'task-1', kind: 'TASK' as const, parentServiceId: 'project-1' };
const scheduler = { serviceId: 'scheduler', kind: 'SCHEDULER' as const, parentServiceId: 'root' };

function processFacts(overrides: Partial<IntentionProcessFacts> = {}): IntentionProcessFacts {
  return { processId: 'process-1', kind: 'INTENTION', statusSource: 'PROCESS', state: 'CREATED',
    version: 0, parentServiceId: 'root', ...overrides };
}

describe('Intention outcome shape', () => {
  it('accepts the three outcomes of this round and normalizes absent options', () => {
    expect(parseIntentionOutcome({ kind: 'ROUTE', targetServiceId: 'project-1',
      instruction: 'unify error handling' })).toEqual({ kind: 'ROUTE', targetServiceId: 'project-1',
      instruction: 'unify error handling' });
    expect(parseIntentionOutcome({ kind: 'TYPED_COMMAND', command: 'SESSION_GUIDANCE_RECORD',
      targetTaskServiceId: 'task-1', message: 'no new dependencies' })).toEqual({ kind: 'TYPED_COMMAND',
      command: 'SESSION_GUIDANCE_RECORD', targetTaskServiceId: 'task-1',
      message: 'no new dependencies' });
    expect(parseIntentionOutcome({ kind: 'REQUEST_CLARIFICATION', question: 'which project?' }))
      .toEqual({ kind: 'REQUEST_CLARIFICATION', question: 'which project?', options: null });
    expect(parseIntentionOutcome({ kind: 'REQUEST_CLARIFICATION', question: 'which project?',
      options: ['payments', 'search'] })).toMatchObject({ options: ['payments', 'search'] });
  });

  it('refuses CREATE_TASK by name, as the S7 boundary, instead of reporting a malformed payload', () => {
    const attempt = () => parseIntentionOutcome({ kind: 'CREATE_TASK', targetServiceId: 'project-1',
      displayTitle: 'new task' });
    expect(attempt).toThrowError(/S7/);
    expect(attempt).toThrowError(expect.objectContaining({ code: 'INTENTION_CREATE_TASK_UNSUPPORTED' }));
  });

  it.each([
    { outcome: null },
    { outcome: { kind: 'UNKNOWN' } },
    { outcome: { kind: 'ROUTE', targetServiceId: 'project-1' } },
    { outcome: { kind: 'ROUTE', targetServiceId: '   ', instruction: 'x' } },
    { outcome: { kind: 'TYPED_COMMAND', command: 'SHELL', targetTaskServiceId: 'task-1', message: 'x' } },
    { outcome: { kind: 'TYPED_COMMAND', command: 'SESSION_GUIDANCE_RECORD',
      targetTaskServiceId: 'task-1', message: '' } },
    { outcome: { kind: 'REQUEST_CLARIFICATION', question: 'q', options: ['only-one'] } },
    { outcome: { kind: 'REQUEST_CLARIFICATION', question: 'q',
      options: ['a', 'b', 'c', 'd', 'e'] } },
  ])('rejects a malformed outcome (%#)', ({ outcome }) => {
    expect(() => parseIntentionOutcome(outcome))
      .toThrow(expect.objectContaining({ code: 'INVALID_INTENTION_OUTCOME' }));
  });

  it('reads the payload envelope and refuses a bad CAS version or a missing process', () => {
    expect(parseIntentionResolvedPayload({ processId: 'process-1', expectedVersion: 3,
      outcome: { kind: 'REQUEST_CLARIFICATION', question: 'which one?' } }))
      .toMatchObject({ processId: 'process-1', expectedVersion: 3 });
    expect(() => parseIntentionResolvedPayload({ processId: 'process-1', expectedVersion: -1,
      outcome: { kind: 'REQUEST_CLARIFICATION', question: 'q' } }))
      .toThrow(expect.objectContaining({ code: 'INVALID_INTENTION_OUTCOME' }));
    expect(() => parseIntentionResolvedPayload({ processId: '', expectedVersion: 0,
      outcome: { kind: 'REQUEST_CLARIFICATION', question: 'q' } }))
      .toThrow(expect.objectContaining({ code: 'INVALID_INTENTION_OUTCOME' }));
  });
});

describe('Intention Process resolvability', () => {
  it.each([{ state: 'CREATED' as const }, { state: 'RUNNING' as const },
    { state: 'WAITING_FOR_USER' as const }])('accepts a native INTENTION Process in $state', ({ state }) => {
    expect(() => assertResolvableIntentionProcess(processFacts({ state }))).not.toThrow();
  });

  it.each([
    { label: 'a DEVELOPMENT Process', facts: processFacts({ kind: 'DEVELOPMENT' }) },
    { label: 'an Execution-backed Process', facts: processFacts({ statusSource: 'EXECUTION', state: null }) },
    { label: 'a terminal Process', facts: processFacts({ state: 'SUCCEEDED' }) },
    { label: 'a paused Process', facts: processFacts({ state: 'PAUSED' }) },
  ])('refuses $label', ({ facts }) => {
    expect(() => assertResolvableIntentionProcess(facts))
      .toThrow(expect.objectContaining({ code: 'INTENTION_PROCESS_NOT_RESOLVABLE' }));
  });
});

describe('Intention ROUTE visibility', () => {
  it('lets root reach its direct Projects and a Project reach its own Tasks', () => {
    expect(() => assertIntentionTargetVisible({ parent: root, target: project })).not.toThrow();
    expect(() => assertIntentionTargetVisible({ parent: project, target: task })).not.toThrow();
  });

  it.each([
    { label: 'root to a Task below a Project', parent: root, target: task },
    { label: 'root to another system Service', parent: root, target: scheduler },
    { label: 'root to itself', parent: root, target: root },
    { label: 'a Project to a sibling Project', parent: project, target: otherProject },
    { label: "a Project to another Project's Task", parent: project,
      target: { ...task, parentServiceId: 'project-2' } },
    { label: 'a Task anywhere (it has no visible children)', parent: task, target: task },
  ])('refuses $label', ({ parent, target }) => {
    expect(() => assertIntentionTargetVisible({ parent, target }))
      .toThrow(expect.objectContaining({ code: 'INTENTION_TARGET_NOT_VISIBLE' }));
  });
});

describe('Intention clarification replies', () => {
  const open = { clarificationId: 'clarification-1', processId: 'process-1',
    targetServiceId: 'root', question: 'which project?', options: null, correlationId: 'corr-1',
    causationId: 'cause-1', requestedAt: 10 };

  it('accepts only a reply that names the open clarification', () => {
    expect(assertIntentionClarificationReply({ open, causationId: 'clarification-1' })).toBe(open);
    expect(() => assertIntentionClarificationReply({ open, causationId: 'clarification-2' }))
      .toThrow(expect.objectContaining({ code: 'INTENTION_CLARIFICATION_MISMATCH' }));
    expect(() => assertIntentionClarificationReply({ open, causationId: null }))
      .toThrow(expect.objectContaining({ code: 'INTENTION_CLARIFICATION_MISMATCH' }));
  });

  it('refuses a waiting Process with no recorded clarification at all', () => {
    expect(() => assertIntentionClarificationReply({ open: null, causationId: 'clarification-1' }))
      .toThrow(expect.objectContaining({ code: 'INTENTION_CLARIFICATION_NOT_FOUND' }));
  });
});

describe('Intention transition plans', () => {
  it('walks CREATED through STARTING and RUNNING, chaining the CAS versions', () => {
    expect(intentionOutcomeTransitionPlan({ state: 'CREATED', expectedVersion: 4, kind: 'ROUTE',
      replying: false })).toEqual([
      { expectedVersion: 4, next: 'STARTING', reason: expect.any(String) },
      { expectedVersion: 5, next: 'RUNNING', reason: expect.any(String) },
      { expectedVersion: 6, next: 'SUCCEEDED', reason: expect.any(String) },
    ]);
    expect(intentionOutcomeTransitionPlan({ state: 'RUNNING', expectedVersion: 7, kind: 'TYPED_COMMAND',
      replying: false })).toEqual([
      { expectedVersion: 7, next: 'SUCCEEDED', reason: expect.any(String) },
    ]);
    expect(intentionOutcomeTransitionPlan({ state: 'CREATED', expectedVersion: 0,
      kind: 'REQUEST_CLARIFICATION', replying: false })).toEqual([
      { expectedVersion: 0, next: 'STARTING', reason: expect.any(String) },
      { expectedVersion: 1, next: 'RUNNING', reason: expect.any(String) },
      { expectedVersion: 2, next: 'WAITING_FOR_USER', reason: expect.any(String) },
    ]);
    expect(intentionOutcomeTransitionPlan({ state: 'WAITING_FOR_USER', expectedVersion: 2,
      kind: 'ROUTE', replying: true })).toEqual([
      { expectedVersion: 2, next: 'RUNNING', reason: expect.any(String) },
      { expectedVersion: 3, next: 'SUCCEEDED', reason: expect.any(String) },
    ]);
  });

  it.each([
    { state: 'CREATED' as const, kind: 'ROUTE' as const, replying: false },
    { state: 'RUNNING' as const, kind: 'TYPED_COMMAND' as const, replying: false },
    { state: 'CREATED' as const, kind: 'REQUEST_CLARIFICATION' as const, replying: false },
    { state: 'RUNNING' as const, kind: 'REQUEST_CLARIFICATION' as const, replying: false },
    { state: 'WAITING_FOR_USER' as const, kind: 'ROUTE' as const, replying: true },
  ])('produces only steps the existing Process FSM allows ($state + $kind)', ({ state, kind, replying }) => {
    const steps = intentionOutcomeTransitionPlan({ state, expectedVersion: 1, kind, replying });
    let current: ProcessState = state;
    for (const step of steps) {
      expect(step.expectedVersion).toBeGreaterThanOrEqual(1);
      current = transitionProcess(current, step.next);
    }
    expect(['SUCCEEDED', 'WAITING_FOR_USER']).toContain(current);
  });
});
