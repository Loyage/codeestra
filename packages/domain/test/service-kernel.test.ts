import { describe, expect, it } from 'vitest';
import {
  assertEligibilityVersion,
  assertSinglePrimaryAgent,
  serviceMetadataKey,
  setServiceMetadata,
  signalDedupeKey,
  transitionProcess,
  transitionSignal,
  validateServiceTree,
} from '../src/index.js';

const validTree = [
  { id: 'root', kind: 'ROOT' as const, parentServiceId: null },
  { id: 'scheduler', kind: 'SCHEDULER' as const, parentServiceId: 'root' },
  { id: 'attention', kind: 'ATTENTION' as const, parentServiceId: 'root' },
  { id: 'project', kind: 'PROJECT' as const, parentServiceId: 'root' },
  { id: 'task', kind: 'TASK' as const, parentServiceId: 'project' },
];

describe('Service kernel domain', () => {
  it('accepts the rooted system/project/task topology', () => {
    expect(validateServiceTree(validTree)).toEqual(validTree);
  });

  it.each([
    { tree: [...validTree, { id: 'root-2', kind: 'ROOT' as const, parentServiceId: null }] },
    { tree: validTree.map((node) => node.id === 'task' ? { ...node, parentServiceId: 'root' } : node) },
    { tree: validTree.map((node) => node.id === 'project' ? { ...node, parentServiceId: 'task' } : node) },
    { tree: validTree.map((node) => node.id === 'project' ? { ...node, parentServiceId: 'missing' } : node) },
  ])('rejects an illegal edge without producing a partial tree', ({ tree }) => {
    const before = JSON.stringify(tree);
    expect(() => validateServiceTree(tree)).toThrow();
    expect(JSON.stringify(tree)).toBe(before);
  });

  it('detects a cycle before accepting any topology', () => {
    const cyclic = [
      { id: 'root', kind: 'ROOT' as const, parentServiceId: null },
      { id: 'project', kind: 'PROJECT' as const, parentServiceId: 'task' },
      { id: 'task', kind: 'TASK' as const, parentServiceId: 'project' },
    ];
    expect(() => validateServiceTree(cyclic)).toThrow(/parent|child|cycle/i);
  });

  it('updates only namespaced metadata with service-version CAS', () => {
    const core = Object.freeze({ lifecycle: 'ACTIVE', ref: 'unchanged' });
    const next = setServiceMetadata({
      state: { serviceId: 'service', stateVersion: 4, entries: {} },
      expectedVersion: 4,
      namespace: 'agent',
      key: 'label',
      value: { text: 'review' },
    });
    expect(next).toEqual({ serviceId: 'service', stateVersion: 5,
      entries: { 'agent/label': { text: 'review' } } });
    expect(core).toEqual({ lifecycle: 'ACTIVE', ref: 'unchanged' });
    expect(() => setServiceMetadata({ state: next, expectedVersion: 4,
      namespace: 'agent', key: 'label', value: null })).toThrow(/version/i);
    expect(() => serviceMetadataKey('core', 'state')).toThrow(/reserved/i);
  });

  it('deduplicates signals by target Service and idempotency key', () => {
    expect(signalDedupeKey({ targetServiceId: 'a', idempotencyKey: 'same' }))
      .not.toBe(signalDedupeKey({ targetServiceId: 'b', idempotencyKey: 'same' }));
    expect(signalDedupeKey({ targetServiceId: 'a', idempotencyKey: 'same' }))
      .toBe(signalDedupeKey({ targetServiceId: 'a', idempotencyKey: 'same' }));
  });

  it('enforces Signal claim/ack/retry/dead-letter transitions', () => {
    expect(transitionSignal('PENDING', 'CLAIM')).toBe('CLAIMED');
    expect(transitionSignal('CLAIMED', 'ACK')).toBe('ACKED');
    expect(transitionSignal('CLAIMED', 'NACK_RETRY')).toBe('RETRYABLE');
    expect(transitionSignal('DEAD_LETTER', 'RETRY')).toBe('PENDING');
    expect(() => transitionSignal('ACKED', 'RETRY')).toThrow(/Cannot/);
  });

  it('never revives a terminal Process and enforces one primary Agent', () => {
    expect(transitionProcess('CREATED', 'STARTING')).toBe('STARTING');
    expect(transitionProcess('RUNNING', 'WAITING_FOR_USER')).toBe('WAITING_FOR_USER');
    expect(() => transitionProcess('SUCCEEDED', 'RUNNING')).toThrow(/Terminal/);
    expect(() => assertSinglePrimaryAgent('RUNNING', [])).toThrow(/exactly one/);
    expect(() => assertSinglePrimaryAgent('RUNNING', ['a', 'b'])).toThrow(/exactly one|multiple/);
    expect(assertSinglePrimaryAgent('RUNNING', ['a'])).toBeUndefined();
  });

  it('invalidates an old eligibility admission version', () => {
    const eligibility = { taskServiceId: 'task', revisionId: 'rev', eligible: true,
      reasons: [] as const, evidenceVersion: 7 };
    expect(assertEligibilityVersion(eligibility, 7)).toBeUndefined();
    expect(() => assertEligibilityVersion({ ...eligibility, evidenceVersion: 8 }, 7))
      .toThrow(/version/i);
  });
});
