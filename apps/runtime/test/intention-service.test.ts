import { describe, expect, test } from 'bun:test';
import { intentionCreateTaskRefusalCode } from '@codeestra/contracts';
import {
  KernelStorageError,
  type IntentionApplication,
  type IntentionApplicationResult,
  type IntentionProcessRecord,
  type IntentionServiceRecord,
  type IntentionTaskScope,
} from '@codeestra/storage';
import { transitionProcess, type IntentionClarificationRef, type ProcessState }
  from '@codeestra/domain';
import {
  IntentionService,
  type IntentionGuidancePort,
  type IntentionGuidanceResult,
  type IntentionKernelPort,
  type IntentionSignalFacts,
} from '../src/intention-service.js';

/**
 * What this file proves, without a Runtime and without a database: the routing rules of an
 * `INTENTION_RESOLVED` Signal — which outcome is refused with which stable code, which Process states
 * one resolution moves through, what audit facts it records, and that a redelivery of the same
 * `(target Service, idempotency key)` applies nothing a second time.
 *
 * What it does not prove: that a real Runtime reaches these calls (that is `cli-intention.test.ts`) and
 * that a real provider read anything (nothing in this wave can, ADR-0051/0057).
 *
 * The kernel port is faked deliberately: the lane contract lets S5 own the Process write path, so this
 * lane proves its own routing against an in-memory implementation of the frozen `transitionProcess`
 * signature first. The fake applies the domain FSM and the same version CAS, and emulates the store's
 * transaction so "a refused outcome wrote nothing" is a real assertion rather than a comment.
 */

interface FakeProcess extends IntentionProcessRecord {
  readonly state: ProcessState | null;
}

interface FakeEvent {
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

class FakeKernel implements IntentionKernelPort {
  readonly processes = new Map<string, FakeProcess>();
  readonly services = new Map<string, IntentionServiceRecord>();
  readonly tasks = new Map<string, IntentionTaskScope>();
  readonly receipts = new Map<string, unknown>();
  readonly events: FakeEvent[] = [];
  readonly clarifications = new Map<string, readonly FakeEvent[]>();
  /** Set to fail one transition step, to prove nothing is half-applied. */
  failStepIndex: number | null = null;

  readProcess(processId: string): IntentionProcessRecord | null {
    return this.processes.get(processId) ?? null;
  }

  readService(serviceId: string): IntentionServiceRecord | null {
    return this.services.get(serviceId) ?? null;
  }

  taskScope(taskServiceId: string): IntentionTaskScope | null {
    return this.tasks.get(taskServiceId) ?? null;
  }

  readReceipt(targetServiceId: string, idempotencyKey: string): { readonly effect: unknown } | null {
    const key = receiptKey(targetServiceId, idempotencyKey);
    return this.receipts.has(key) ? { effect: this.receipts.get(key) } : null;
  }

  lastClarification(processId: string): IntentionClarificationRef | null {
    const recorded = this.clarifications.get(processId) ?? [];
    const last = recorded[recorded.length - 1];
    if (last === undefined) return null;
    const options = last.payload['options'];
    return { clarificationId: last.payload['requestId'] as string, processId,
      targetServiceId: last.payload['targetServiceId'] as string,
      question: last.payload['question'] as string,
      options: Array.isArray(options) ? options as readonly string[] : null,
      correlationId: last.payload['correlationId'] as string,
      causationId: last.payload['causationId'] as string | null, requestedAt: 1 };
  }

  applyOutcome(input: IntentionApplication): IntentionApplicationResult {
    const key = receiptKey(input.targetServiceId, input.idempotencyKey);
    const existing = this.receipts.get(key);
    if (existing !== undefined) {
      const current = this.processes.get(input.processId);
      if (current === undefined) throw new Error('fake: unknown Process');
      return { applied: false, process: current, effect: existing };
    }
    const snapshot = { processes: new Map(this.processes), receipts: new Map(this.receipts),
      events: [...this.events], clarifications: new Map(this.clarifications) };
    try {
      input.transitions.forEach((step, index) => {
        if (this.failStepIndex === index) {
          throw new KernelStorageError('PROCESS_VERSION_CONFLICT', 'fake: transition refused');
        }
        const current = this.processes.get(input.processId);
        if (current === undefined) throw new KernelStorageError('PROCESS_NOT_FOUND', 'fake');
        if (current.version !== step.expectedVersion) {
          throw new KernelStorageError('PROCESS_VERSION_CONFLICT', 'fake');
        }
        const state = current.state ?? 'CREATED';
        this.processes.set(input.processId,
          { ...current, state: transitionProcess(state, step.next), version: current.version + 1 });
      });
      for (const fact of input.auditFacts) {
        this.events.push({ eventType: fact.eventType, aggregateId: fact.aggregateId,
          aggregateVersion: fact.aggregateVersion, correlationId: fact.correlationId,
          causationId: fact.causationId, payload: fact.payload });
        if (fact.eventType === 'IntentionClarificationRequested') {
          this.clarifications.set(fact.aggregateId,
            [...(this.clarifications.get(fact.aggregateId) ?? []), this.events[this.events.length - 1] as FakeEvent]);
        }
      }
      this.events.push({ eventType: 'SignalAcknowledged', aggregateId: input.signalId,
        aggregateVersion: 1, correlationId: input.signalId, causationId: input.signalId,
        payload: { signalId: input.signalId } });
      this.receipts.set(key, input.effect);
      const applied = this.processes.get(input.processId);
      if (applied === undefined) throw new KernelStorageError('PROCESS_NOT_FOUND', 'fake');
      return { applied: true, process: applied, effect: input.effect };
    } catch (error) {
      this.processes.clear();
      for (const [id, value] of snapshot.processes) this.processes.set(id, value);
      this.receipts.clear();
      for (const [id, value] of snapshot.receipts) this.receipts.set(id, value);
      this.events.length = 0;
      this.events.push(...snapshot.events);
      this.clarifications.clear();
      for (const [id, value] of snapshot.clarifications) this.clarifications.set(id, value);
      throw error;
    }
  }
}

class FakeGuidance implements IntentionGuidancePort {
  readonly calls: { readonly projectId: string; readonly taskId: string;
    readonly commandId: string; readonly message: string }[] = [];
  #next = 0;
  record(input: { readonly projectId: string; readonly taskId: string;
    readonly commandId: string; readonly message: string }): IntentionGuidanceResult {
    this.calls.push(input);
    this.#next += 1;
    return { guidanceId: `guidance-${this.#next}`, outcome: 'RECORDED', code: null,
      detail: 'fake: recorded through the guidance ledger' };
  }
}

function receiptKey(targetServiceId: string, idempotencyKey: string): string {
  return `${targetServiceId}\u0000${idempotencyKey}`;
}

interface Fixture {
  readonly kernel: FakeKernel;
  readonly guidance: FakeGuidance;
  readonly service: IntentionService;
}

function fixture(): Fixture {
  const kernel = new FakeKernel();
  kernel.services.set('root', { serviceId: 'root', kind: 'ROOT', parentServiceId: null });
  kernel.services.set('attention', { serviceId: 'attention', kind: 'ATTENTION', parentServiceId: 'root' });
  kernel.services.set('project-1', { serviceId: 'project-1', kind: 'PROJECT', parentServiceId: 'root' });
  kernel.services.set('project-2', { serviceId: 'project-2', kind: 'PROJECT', parentServiceId: 'root' });
  kernel.services.set('task-1', { serviceId: 'task-1', kind: 'TASK', parentServiceId: 'project-1' });
  kernel.services.set('task-2', { serviceId: 'task-2', kind: 'TASK', parentServiceId: 'project-2' });
  kernel.tasks.set('task-1', { projectId: 'project-1', taskId: 'task-1', holdingExecutionId: null });
  kernel.tasks.set('task-2', { projectId: 'project-2', taskId: 'task-2', holdingExecutionId: null });
  kernel.processes.set('intention-root', { processId: 'intention-root', kind: 'INTENTION',
    statusSource: 'PROCESS', state: 'CREATED', version: 0, parentServiceId: 'root' });
  kernel.processes.set('intention-project', { processId: 'intention-project', kind: 'INTENTION',
    statusSource: 'PROCESS', state: 'CREATED', version: 0, parentServiceId: 'project-1' });
  kernel.processes.set('development', { processId: 'development', kind: 'DEVELOPMENT',
    statusSource: 'EXECUTION', state: null, version: 3, parentServiceId: 'task-1' });
  const guidance = new FakeGuidance();
  const service = new IntentionService({ kernel, guidance, now: () => 1_000,
    randomUUID: (() => { let next = 0; return () => { next += 1; return `uuid-${next}`; }; })() });
  return { kernel, guidance, service };
}

function signal(overrides: Partial<IntentionSignalFacts> = {}): IntentionSignalFacts {
  return { signalId: 'signal-1', targetServiceId: 'root', idempotencyKey: 'intent-key-1',
    correlationId: 'correlation-1', causationId: null,
    payload: { processId: 'intention-root', expectedVersion: 0,
      outcome: { kind: 'ROUTE', targetServiceId: 'project-1', instruction: 'unify error handling' } },
    ...overrides };
}

function outcomes(kernel: FakeKernel): readonly string[] {
  return kernel.events.map((event) => event.eventType);
}

describe('IntentionService routing', () => {
  test('resolves a ROUTE to a visible Service and records the routing as an audit fact', () => {
    const { kernel, service } = fixture();
    const result = service.resolve(signal());
    expect(result.applied).toBe(true);
    expect(result.outcomeKind).toBe('ROUTE');
    expect(kernel.processes.get('intention-root')).toMatchObject({ state: 'SUCCEEDED', version: 3 });
    const routed = kernel.events.find((event) => event.eventType === 'IntentionRouted');
    expect(routed).toMatchObject({ aggregateId: 'intention-root', aggregateVersion: 3,
      correlationId: 'correlation-1', causationId: 'signal-1' });
    expect(routed?.payload).toMatchObject({ processId: 'intention-root', targetServiceId: 'project-1',
      instruction: 'unify error handling' });
    // The receipt is what a later `signal get` reads back; the effect is the whole public answer.
    expect(kernel.readReceipt('root', 'intent-key-1')?.effect).toMatchObject({
      type: 'INTENTION_RESOLVED', outcomeKind: 'ROUTE', processId: 'intention-root',
      targetServiceId: 'project-1', processState: 'SUCCEEDED' });
  });

  test('refuses a ROUTE outside the parent Service subtree and writes nothing', () => {
    const { kernel, service } = fixture();
    const before = JSON.stringify([...kernel.processes]);
    expect(() => service.resolve(signal({ targetServiceId: 'project-1',
      payload: { processId: 'intention-project', expectedVersion: 0,
        outcome: { kind: 'ROUTE', targetServiceId: 'task-2', instruction: 'x' } } })))
      .toThrow(expect.objectContaining({ code: 'INTENTION_TARGET_NOT_VISIBLE' }));
    // A Project cannot reach another Project's Task, and the refusal is a pre-check: no state moved,
    // no audit fact exists and no receipt was written.
    expect(JSON.stringify([...kernel.processes])).toBe(before);
    expect(kernel.events).toHaveLength(0);
    expect(kernel.readReceipt('root', 'intent-key-1')).toBeNull();
  });

  test('refuses a ROUTE to a Service that does not exist with the same visibility code', () => {
    const { service } = fixture();
    expect(() => service.resolve(signal({ payload: { processId: 'intention-root',
      expectedVersion: 0, outcome: { kind: 'ROUTE', targetServiceId: 'missing',
        instruction: 'x' } } })))
      .toThrow(expect.objectContaining({ code: 'INTENTION_TARGET_NOT_VISIBLE' }));
  });

  test('records Session Guidance through the existing ledger for a TYPED_COMMAND', () => {
    const { kernel, guidance, service } = fixture();
    const result = service.resolve(signal({ payload: { processId: 'intention-root',
      expectedVersion: 0, outcome: { kind: 'TYPED_COMMAND', command: 'SESSION_GUIDANCE_RECORD',
        targetTaskServiceId: 'task-1', message: 'reuse the existing helper' } } }));
    expect(result.applied).toBe(true);
    expect(guidance.calls).toHaveLength(1);
    expect(guidance.calls[0]).toMatchObject({ projectId: 'project-1', taskId: 'task-1',
      commandId: 'signal-1', message: 'reuse the existing helper' });
    expect(kernel.processes.get('intention-root')).toMatchObject({ state: 'SUCCEEDED' });
    expect(kernel.events.find((event) => event.eventType === 'IntentionGuidanceRecorded')?.payload)
      .toMatchObject({ processId: 'intention-root', taskServiceId: 'task-1', guidanceId: 'guidance-1',
        guidanceOutcome: 'RECORDED', modelAcknowledgement: 'UNSUPPORTED' });
    // "recorded" is the whole claim; nothing reports a provider delivery or a model reading.
    expect(result.effect).toMatchObject({ guidanceOutcome: 'RECORDED',
      modelAcknowledgement: 'UNSUPPORTED', processState: 'SUCCEEDED' });
  });

  test('refuses a TYPED_COMMAND whose target is not a resolvable Task Service', () => {
    const { kernel, guidance, service } = fixture();
    expect(() => service.resolve(signal({ payload: { processId: 'intention-root',
      expectedVersion: 0, outcome: { kind: 'TYPED_COMMAND', command: 'SESSION_GUIDANCE_RECORD',
        targetTaskServiceId: 'project-1', message: 'x' } } })))
      .toThrow(expect.objectContaining({ code: 'INTENTION_TARGET_NOT_VISIBLE' }));
    expect(guidance.calls).toHaveLength(0);
    expect(kernel.events).toHaveLength(0);
  });

  test('refuses to claim a delivery when a live Execution holds the target Task', () => {
    const { kernel, guidance, service } = fixture();
    kernel.tasks.set('task-1', { projectId: 'project-1', taskId: 'task-1',
      holdingExecutionId: 'execution-1' });
    expect(() => service.resolve(signal({ payload: { processId: 'intention-root',
      expectedVersion: 0, outcome: { kind: 'TYPED_COMMAND', command: 'SESSION_GUIDANCE_RECORD',
        targetTaskServiceId: 'task-1', message: 'x' } } })))
      .toThrow(expect.objectContaining({ code: 'INTENTION_GUIDANCE_CHANNEL_UNAVAILABLE' }));
    expect(guidance.calls).toHaveLength(0);
    expect(kernel.readReceipt('root', 'intent-key-1')).toBeNull();
  });

  test('asks the user instead of guessing, as a kernel fact rather than an Attention row', () => {
    const { kernel, service } = fixture();
    const result = service.resolve(signal({ payload: { processId: 'intention-root',
      expectedVersion: 0, outcome: { kind: 'REQUEST_CLARIFICATION', question: 'which project?',
        options: ['payments', 'search'] } } }));
    expect(result.applied).toBe(true);
    expect(kernel.processes.get('intention-root')).toMatchObject({ state: 'WAITING_FOR_USER',
      version: 3 });
    const asked = kernel.events.find((event) => event.eventType === 'IntentionClarificationRequested');
    expect(asked?.payload).toMatchObject({ processId: 'intention-root', targetServiceId: 'root',
      question: 'which project?', options: ['payments', 'search'], correlationId: 'correlation-1',
      causationId: null });
    expect(typeof asked?.payload['requestId']).toBe('string');
    // The receipt says out loud that the Attention index is not connected for a kernel-level intention.
    expect(result.effect).toMatchObject({ requestId: asked?.payload['requestId'],
      attentionIndex: 'NOT_CONNECTED', processState: 'WAITING_FOR_USER' });
  });

  test('answers a clarification only when the reply names it, then settles the Process', () => {
    const { kernel, service } = fixture();
    const asked = service.resolve(signal({ payload: { processId: 'intention-root',
      expectedVersion: 0, outcome: { kind: 'REQUEST_CLARIFICATION', question: 'which project?' } } }));
    const requestId = asked.effect['requestId'] as string;

    expect(() => service.resolve(signal({ signalId: 'signal-2', idempotencyKey: 'intent-key-2',
      causationId: 'some-other-question', payload: { processId: 'intention-root',
        expectedVersion: 3, outcome: { kind: 'ROUTE', targetServiceId: 'project-1',
          instruction: 'x' } } })))
      .toThrow(expect.objectContaining({ code: 'INTENTION_CLARIFICATION_MISMATCH' }));
    // The refused reply moved nothing: the Process is still waiting, on the same request.
    expect(kernel.processes.get('intention-root')).toMatchObject({ state: 'WAITING_FOR_USER',
      version: 3 });

    const answered = service.resolve(signal({ signalId: 'signal-3', idempotencyKey: 'intent-key-3',
      causationId: requestId, payload: { processId: 'intention-root', expectedVersion: 3,
        outcome: { kind: 'ROUTE', targetServiceId: 'project-1', instruction: 'the payments one' } } }));
    expect(answered.applied).toBe(true);
    expect(kernel.processes.get('intention-root')).toMatchObject({ state: 'SUCCEEDED', version: 5 });
    const answer = kernel.events.find((event) => event.eventType === 'IntentionClarificationAnswered');
    expect(answer?.payload).toMatchObject({ processId: 'intention-root', requestId,
      outcomeKind: 'ROUTE' });
    expect(kernel.events.some((event) => event.eventType === 'IntentionRouted')).toBe(true);
  });

  test('refuses a second clarification while the first is still open', () => {
    const { service } = fixture();
    service.resolve(signal({ payload: { processId: 'intention-root', expectedVersion: 0,
      outcome: { kind: 'REQUEST_CLARIFICATION', question: 'which project?' } } }));
    expect(() => service.resolve(signal({ signalId: 'signal-2', idempotencyKey: 'intent-key-2',
      payload: { processId: 'intention-root', expectedVersion: 3,
        outcome: { kind: 'REQUEST_CLARIFICATION', question: 'and which one again?' } } })))
      .toThrow(expect.objectContaining({ code: 'INTENTION_CLARIFICATION_OPEN' }));
  });

  test('refuses to resolve a Process that belongs to a different Service', () => {
    const { kernel, service } = fixture();
    // The Signal was accepted by root, but the Process it names belongs to project-1: without the
    // ownership guard one Service could move another's intention.
    expect(() => service.resolve(signal({ targetServiceId: 'project-1' })))
      .toThrow(expect.objectContaining({ code: 'PROCESS_PARENT_MISMATCH' }));
    expect(kernel.processes.get('intention-root')).toMatchObject({ state: 'CREATED', version: 0 });
    expect(kernel.events).toHaveLength(0);
  });

  test('refuses CREATE_TASK by name and leaves no fact behind', () => {
    const { kernel, service } = fixture();
    expect(() => service.resolve(signal({ payload: { processId: 'intention-root',
      expectedVersion: 0, outcome: { kind: 'CREATE_TASK', displayTitle: 'a new task',
        detail: 'something' } } })))
      .toThrow(expect.objectContaining({ code: intentionCreateTaskRefusalCode }));
    expect(intentionCreateTaskRefusalCode).toBe('INTENTION_CREATE_TASK_UNSUPPORTED');
    expect(kernel.processes.get('intention-root')).toMatchObject({ state: 'CREATED', version: 0 });
    expect(kernel.events).toHaveLength(0);
    expect(kernel.readReceipt('root', 'intent-key-1')).toBeNull();
  });

  test('applies one (target Service, idempotency key) exactly once', () => {
    const { kernel, service } = fixture();
    const first = service.resolve(signal());
    const eventsAfterFirst = kernel.events.length;
    const second = service.resolve(signal());
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.effect).toEqual(first.effect);
    expect(kernel.events).toHaveLength(eventsAfterFirst);
    expect(kernel.processes.get('intention-root')).toMatchObject({ state: 'SUCCEEDED', version: 3 });
    expect(outcomes(kernel).filter((type) => type === 'IntentionRouted')).toHaveLength(1);
  });

  test('does not re-decide a redelivery of a Process that has since moved on', () => {
    const { service } = fixture();
    service.resolve(signal());
    // A second delivery of the *same* request must answer with its own receipt even though the Process
    // is no longer resolvable, so "already applied" never turns into a confusing refusal.
    expect(service.resolve(signal()).applied).toBe(false);
  });

  test.each([
    { processId: 'development', targetServiceId: 'task-1' },
    { processId: 'missing', targetServiceId: 'root' },
  ])('refuses a Process the routing rules cannot resolve (%#)', ({ processId, targetServiceId }) => {
    const { kernel, service } = fixture();
    const attempt = () => service.resolve(signal({ targetServiceId,
      payload: { processId, expectedVersion: 0,
        outcome: { kind: 'ROUTE', targetServiceId: 'project-1', instruction: 'x' } } }));
    expect(attempt).toThrow(expect.objectContaining({
      code: processId === 'missing' ? 'PROCESS_NOT_FOUND' : 'INTENTION_PROCESS_NOT_RESOLVABLE' }));
    expect(kernel.events).toHaveLength(0);
  });

  test('refuses a malformed outcome before touching the kernel', () => {
    const { kernel, service } = fixture();
    expect(() => service.resolve(signal({ payload: { processId: 'intention-root',
      expectedVersion: 0, outcome: { kind: 'ROUTE', targetServiceId: 'project-1' } } })))
      .toThrow(expect.objectContaining({ code: 'INVALID_INTENTION_OUTCOME' }));
    expect(kernel.events).toHaveLength(0);
  });

  test('applies nothing when a transition inside one resolution fails', () => {
    const { kernel, service } = fixture();
    kernel.failStepIndex = 1;
    expect(() => service.resolve(signal())).toThrow(expect.objectContaining({
      code: 'PROCESS_VERSION_CONFLICT' }));
    expect(kernel.processes.get('intention-root')).toMatchObject({ state: 'CREATED', version: 0 });
    expect(kernel.events).toHaveLength(0);
    expect(kernel.readReceipt('root', 'intent-key-1')).toBeNull();
  });
});
