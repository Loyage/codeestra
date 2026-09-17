import { describe, expect, test } from 'bun:test';
import {
  processViewSchema,
  runtimeRequestSchema,
  serviceViewSchema,
  signalViewSchema,
} from '../src/index.js';

const id = '10000000-0000-4000-8000-000000000001';

describe('Service kernel contracts', () => {
  test('strictly parses the new request commands and defaults', () => {
    expect(runtimeRequestSchema.parse({ schemaVersion: 1, requestId: id,
      command: 'service.list' })).toMatchObject({ command: 'service.list', includeRetired: false });
    expect(runtimeRequestSchema.parse({ schemaVersion: 1, requestId: id,
      command: 'signal.send', commandId: id, kind: 'SIG_P', subtype: 'INTENT_SUBMITTED',
      targetServiceId: id, payload: { text: 'x' }, idempotencyKey: 'key' }))
      .toMatchObject({ contractVersion: 1, priority: 0 });
    expect(() => runtimeRequestSchema.parse({ schemaVersion: 1, requestId: id,
      command: 'process.pause', processId: id, expectedControlVersion: 0, surprise: true }))
      .toThrow();
  });

  test('keeps JSON payloads bounded at the transport boundary', () => {
    expect(() => runtimeRequestSchema.parse({ schemaVersion: 1, requestId: id,
      command: 'signal.send', commandId: id, kind: 'SIG_A', subtype: 'X', targetServiceId: id,
      payload: { value: 'x'.repeat(70 * 1024) }, idempotencyKey: 'key' })).toThrow();
  });

  test('rejects malformed Service, Process, and Signal views', () => {
    expect(() => serviceViewSchema.parse({ id, kind: 'TASK', parentServiceId: id,
      projectId: null, taskId: null, lifecycle: 'ACTIVE', contractVersion: 1,
      stateVersion: 0, coreVersion: 0, coreState: {}, metadata: {}, inboxCursor: 0,
      createdAt: 0, updatedAt: 0 })).toThrow();
    expect(() => processViewSchema.parse({ id, kind: 'DEVELOPMENT', parentServiceId: id,
      projectId: id, taskId: id, executionId: null, state: 'RUNNING', version: 0,
      controlVersion: 0, objective: 'x', adapterId: 'pi', createdAt: 0, updatedAt: 0 })).toThrow();
    expect(() => signalViewSchema.parse({ id, kind: 'SIG_A', subtype: 'X',
      sourceServiceId: null, sourceProcessId: null, targetServiceId: id, contractVersion: 1,
      payload: {}, idempotencyKey: 'x', correlationId: 'x', causationId: null,
      priority: 0, state: 'ACKED', attemptCount: 0, automaticAttempts: 0,
      nextAttemptAt: null, claimBootId: null, claimDeadlineAt: null, acknowledgedAt: null,
      deadLetteredAt: null, lastErrorCode: null, lastErrorMessage: null, createdAt: 0,
      updatedAt: 0, attempts: [], receipt: null })).toThrow();
  });
});
