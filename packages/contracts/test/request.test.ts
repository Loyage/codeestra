import { describe, expect, test } from 'bun:test';
import { agentObservedEventSchema, runtimeRequestSchema } from '../src/index.js';

const base = {
  requestId: '11111111-1111-4111-8111-111111111111',
  schemaVersion: 1 as const,
  command: 'task.create' as const,
  commandId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  specification: 'Keep the original task text',
  kind: 'DEVELOPMENT' as const,
};

describe('Runtime task request boundary', () => {
  test('defaults constraints without rewriting specification text', () => {
    const request = runtimeRequestSchema.parse({ ...base, specification: '  exact spacing  ' });
    expect(request).toMatchObject({ specification: '  exact spacing  ', constraints: [] });
  });

  test('rejects blank specifications and duplicate constraint IDs', () => {
    expect(runtimeRequestSchema.safeParse({ ...base, specification: '   ' }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({
      ...base,
      constraints: [{ id: 'same', text: 'first' }, { id: 'same', text: 'second' }],
    }).success).toBe(false);
  });
});

describe('Adapter event boundary', () => {
  test('requires an explicit response type for Attention events', () => {
    const event = {
      sessionId: 'session', executionId: 'execution', eventId: 'provider-event', cursor: 'cursor',
      type: 'attention', providerRequestId: 'request', kind: 'PERMISSION',
      responseType: 'CONFIRM', prompt: { title: 'Allow?' },
    };
    expect(agentObservedEventSchema.safeParse(event).success).toBe(true);
    const { responseType: _responseType, ...missing } = event;
    expect(agentObservedEventSchema.safeParse(missing).success).toBe(false);
  });

  test('accepts completion only with explicit quiescence evidence', () => {
    const event = {
      sessionId: 'session', executionId: 'execution', eventId: 'provider-event', cursor: 'cursor',
      type: 'completed', outcome: 'FAILURE',
      evidence: { ref: 'evidence', toolsQuiescent: true, ownedWritersStopped: true },
    };
    expect(agentObservedEventSchema.safeParse(event).success).toBe(true);
    expect(agentObservedEventSchema.safeParse({
      ...event,
      evidence: { ...event.evidence, toolsQuiescent: false },
    }).success).toBe(false);
  });
});
