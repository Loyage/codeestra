import { afterEach, describe, expect, test } from 'bun:test';
import { Phase1Database, ServiceKernelStore, systemServiceIds } from '@codeestra/storage';
import {
  ServiceContractRegistry,
  SignalDispatcher,
  intentionSignalSubtype,
  maxAutomaticSignalAttempts,
  serviceMetadataSignalSubtype,
  signalClaimLeaseMs,
  signalRetryDelaysMs,
} from '../src/service-kernel.js';

const stores: Phase1Database[] = [];
afterEach(() => { for (const storage of stores.splice(0)) storage.close(); });

function setup(now: () => number, store?: ServiceKernelStore): {
  readonly storage: Phase1Database; readonly kernel: ServiceKernelStore;
  readonly dispatcher: SignalDispatcher } {
  const storage = new Phase1Database(); stores.push(storage);
  const kernel = store ?? new ServiceKernelStore(storage);
  return { storage, kernel, dispatcher: new SignalDispatcher({ store: kernel,
    contracts: new ServiceContractRegistry(), bootId: 'boot', now }) };
}

describe('Service registry and durable Signal dispatcher', () => {
  test('dispatches a contract-validated metadata SIG_A and records one receipt', () => {
    let now = 100;
    const { kernel, dispatcher } = setup(() => now);
    const signalId = crypto.randomUUID();
    dispatcher.send({ signalId, kind: 'SIG_A', subtype: serviceMetadataSignalSubtype,
      sourceServiceId: null, sourceProcessId: null, targetServiceId: systemServiceIds.root,
      contractVersion: 1, payload: { namespace: 'agent', key: 'label', value: 'root',
        expectedVersion: 0 }, idempotencyKey: 'metadata', correlationId: 'c', causationId: null,
      priority: 0 });
    expect(dispatcher.dispatchAvailable()).toBe(1);
    const signal = kernel.getSignal(signalId);
    expect(signal.state).toBe('ACKED');
    expect(signal.attempts).toHaveLength(1);
    expect(signal.receipt?.effect).toMatchObject({ type: 'SERVICE_METADATA_SET', stateVersion: 1 });
    expect(kernel.getService(systemServiceIds.root).metadata).toEqual({ 'agent/label': 'root' });
    now += 1;
    expect(dispatcher.dispatchAvailable()).toBe(0);
    expect(kernel.getSignal(signalId).attempts).toHaveLength(1);
  });

  test('rejects an unregistered target contract before enqueue', () => {
    const { kernel, dispatcher } = setup(() => 100);
    expect(() => dispatcher.send({ signalId: crypto.randomUUID(), kind: 'SIG_P',
      subtype: intentionSignalSubtype, sourceServiceId: null, sourceProcessId: null,
      targetServiceId: systemServiceIds.scheduler, contractVersion: 1,
      payload: { text: 'route this', adapterId: 'pi' }, idempotencyKey: 'bad',
      correlationId: 'c', causationId: null, priority: 0 })).toThrow(/does not accept/);
    expect(kernel.listSignals()).toEqual([]);
  });

  test('turns one SIG_P into one CREATED Intention Process and converges a duplicate key', () => {
    const { kernel, dispatcher } = setup(() => 100);
    const first = dispatcher.send({ signalId: crypto.randomUUID(), kind: 'SIG_P',
      subtype: intentionSignalSubtype, sourceServiceId: null, sourceProcessId: null,
      targetServiceId: systemServiceIds.root, contractVersion: 1,
      payload: { text: 'create a project plan', adapterId: 'pi' }, idempotencyKey: 'intent',
      correlationId: 'c', causationId: null, priority: 0 });
    dispatcher.dispatchAvailable();
    const duplicate = dispatcher.send({ signalId: crypto.randomUUID(), kind: 'SIG_P',
      subtype: intentionSignalSubtype, sourceServiceId: null, sourceProcessId: null,
      targetServiceId: systemServiceIds.root, contractVersion: 1,
      payload: { text: 'create a project plan', adapterId: 'pi' }, idempotencyKey: 'intent',
      correlationId: 'another-correlation', causationId: null, priority: 0 });
    expect(duplicate.created).toBe(false);
    expect(duplicate.signal.id).toBe(first.signal.id);
    const processes = kernel.listProcesses({ parentServiceId: systemServiceIds.root });
    expect(processes).toHaveLength(1);
    expect(processes[0]).toMatchObject({ kind: 'INTENTION', state: 'CREATED',
      objective: 'create a project plan' });
  });

  test('keeps an enqueued-but-unclaimed Signal available to a restarted dispatcher', () => {
    let now = 100;
    const { kernel, dispatcher } = setup(() => now);
    const signalId = crypto.randomUUID();
    dispatcher.send({ signalId, kind: 'SIG_A', subtype: serviceMetadataSignalSubtype,
      sourceServiceId: null, sourceProcessId: null, targetServiceId: systemServiceIds.root,
      contractVersion: 1, payload: { namespace: 'agent', key: 'queued', value: true,
        expectedVersion: 0 }, idempotencyKey: 'queued', correlationId: 'c', causationId: null,
      priority: 0 });
    expect(kernel.getSignal(signalId).state).toBe('PENDING');
    const restarted = new SignalDispatcher({ store: kernel, contracts: new ServiceContractRegistry(),
      bootId: 'new-boot', now: () => ++now });
    expect(restarted.dispatchAvailable()).toBe(1);
    expect(kernel.getSignal(signalId).state).toBe('ACKED');
  });

  test('rolls back a Process side effect if receipt/ACK persistence fails', () => {
    const { storage, kernel, dispatcher } = setup(() => 100);
    const signalId = crypto.randomUUID();
    dispatcher.send({ signalId, kind: 'SIG_P', subtype: intentionSignalSubtype,
      sourceServiceId: null, sourceProcessId: null, targetServiceId: systemServiceIds.root,
      contractVersion: 1, payload: { text: 'atomic intention', adapterId: 'pi' },
      idempotencyKey: 'atomic', correlationId: 'c', causationId: null, priority: 0 });
    expect(kernel.claimNextSignal({ bootId: 'boot', now: 100, leaseMs: signalClaimLeaseMs,
      eventId: crypto.randomUUID() })?.state).toBe('CLAIMED');
    storage.sqlite.exec(`CREATE TRIGGER inject_receipt_failure BEFORE INSERT ON signal_receipts
      BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;`);
    expect(() => kernel.acknowledgeIntentionSignal({ signalId, processId: crypto.randomUUID(),
      text: 'atomic intention', adapterId: 'pi', now: 101,
      eventIds: [crypto.randomUUID(), crypto.randomUUID()] })).toThrow(/injected receipt failure/);
    expect(kernel.listProcesses({ parentServiceId: systemServiceIds.root })).toEqual([]);
    expect(kernel.getSignal(signalId)).toMatchObject({ state: 'CLAIMED', receipt: null });
  });

  test('recovers an expired claim and then handles it without losing the Signal', () => {
    let now = 100;
    const { kernel, dispatcher } = setup(() => now);
    const signalId = crypto.randomUUID();
    dispatcher.send({ signalId, kind: 'SIG_A', subtype: serviceMetadataSignalSubtype,
      sourceServiceId: null, sourceProcessId: null, targetServiceId: systemServiceIds.root,
      contractVersion: 1, payload: { namespace: 'agent', key: 'after-crash', value: true,
        expectedVersion: 0 }, idempotencyKey: 'crash', correlationId: 'c', causationId: null,
      priority: 0 });
    expect(kernel.claimNextSignal({ bootId: 'old-boot', now, leaseMs: signalClaimLeaseMs,
      eventId: crypto.randomUUID() })?.state).toBe('CLAIMED');
    now += signalClaimLeaseMs + 1;
    expect(dispatcher.dispatchAvailable()).toBe(1);
    const signal = kernel.getSignal(signalId);
    expect(signal.state).toBe('ACKED');
    expect(signal.attempts.map((attempt) => attempt.state)).toEqual(['RETRYABLE', 'ACKED']);
  });

  test('uses five bounded retry delays and dead-letters the sixth transient failure', () => {
    let now = 100;
    const storage = new Phase1Database(); stores.push(storage);
    class FailingStore extends ServiceKernelStore {
      override acknowledgeMetadataSignal(): never { throw new Error('injected transient failure'); }
    }
    const kernel = new FailingStore(storage);
    const dispatcher = new SignalDispatcher({ store: kernel, contracts: new ServiceContractRegistry(),
      bootId: 'boot', now: () => now });
    const signalId = crypto.randomUUID();
    dispatcher.send({ signalId, kind: 'SIG_A', subtype: serviceMetadataSignalSubtype,
      sourceServiceId: null, sourceProcessId: null, targetServiceId: systemServiceIds.root,
      contractVersion: 1, payload: { namespace: 'agent', key: 'retry', value: true,
        expectedVersion: 0 }, idempotencyKey: 'retry', correlationId: 'c', causationId: null,
      priority: 0 });
    for (let attempt = 0; attempt < maxAutomaticSignalAttempts; attempt += 1) {
      expect(dispatcher.dispatchAvailable()).toBe(1);
      const signal = kernel.getSignal(signalId);
      if (attempt + 1 < maxAutomaticSignalAttempts) {
        expect(signal.state).toBe('RETRYABLE');
        expect(signal.nextAttemptAt).toBe(now + (signalRetryDelaysMs[attempt] as number));
        now = signal.nextAttemptAt as number;
      } else {
        expect(signal.state).toBe('DEAD_LETTER');
        expect(signal.deadLetteredAt).toBe(now);
      }
    }
    expect(kernel.getSignal(signalId).attempts).toHaveLength(maxAutomaticSignalAttempts);
  });
});
