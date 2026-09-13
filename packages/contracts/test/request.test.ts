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

  test('accepts a result commit request only with an explicit confirmation', () => {
    const taskId = '66666666-6666-4666-8666-666666666666';
    const commit = {
      requestId: base.requestId,
      schemaVersion: base.schemaVersion,
      command: 'task.result.commit' as const,
      commandId: base.commandId,
      projectId: base.projectId,
      taskId,
      authorizationId: '44444444-4444-4444-8444-444444444444',
    };
    expect(runtimeRequestSchema.safeParse({ ...commit, confirm: true }).success).toBe(true);
    expect(runtimeRequestSchema.safeParse(commit).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({ ...commit, confirm: false }).success).toBe(false);
  });

  test('accepts a result prepare request with or without an explicit Execution', () => {
    const prepare = {
      requestId: base.requestId,
      schemaVersion: base.schemaVersion,
      command: 'task.result.prepare' as const,
      commandId: base.commandId,
      projectId: base.projectId,
      taskId: '66666666-6666-4666-8666-666666666666',
    };
    expect(runtimeRequestSchema.safeParse(prepare).success).toBe(true);
    expect(runtimeRequestSchema.safeParse({
      ...prepare,
      executionId: '55555555-5555-4555-8555-555555555555',
    }).success).toBe(true);
    expect(runtimeRequestSchema.safeParse({ ...prepare, executionId: 'not-a-uuid' }).success).toBe(false);
  });

  test('accepts a verification request with or without an explicit Execution', () => {
    const verify = {
      requestId: base.requestId,
      schemaVersion: base.schemaVersion,
      command: 'task.verify' as const,
      commandId: base.commandId,
      projectId: base.projectId,
      taskId: '66666666-6666-4666-8666-666666666666',
    };
    expect(runtimeRequestSchema.safeParse(verify).success).toBe(true);
    expect(runtimeRequestSchema.safeParse({
      ...verify,
      executionId: '55555555-5555-4555-8555-555555555555',
    }).success).toBe(true);
    expect(runtimeRequestSchema.safeParse({ ...verify, executionId: 'not-a-uuid' }).success).toBe(false);
  });

  test('requires an explicit verification policy confirmation when trusting a project', () => {
    const trust = {
      requestId: base.requestId,
      schemaVersion: base.schemaVersion,
      command: 'project.trust' as const,
      path: '/repo',
      expectedIdentity: {
        repoRoot: '/repo', gitCommonDir: '/repo/.git', mainRef: 'refs/heads/main',
        objectFormat: 'sha1', headCommit: 'a'.repeat(40),
      },
    };
    expect(runtimeRequestSchema.safeParse(trust).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({
      ...trust,
      expectedVerificationPolicy: { state: 'ABSENT', mainCommit: 'a'.repeat(40) },
    }).success).toBe(true);
    expect(runtimeRequestSchema.safeParse({
      ...trust,
      expectedVerificationPolicy: { state: 'PRESENT', mainCommit: 'a'.repeat(40), digest: 'b'.repeat(64) },
    }).success).toBe(true);
    // A PRESENT confirmation without a digest cannot be represented.
    expect(runtimeRequestSchema.safeParse({
      ...trust,
      expectedVerificationPolicy: { state: 'PRESENT', mainCommit: 'a'.repeat(40) },
    }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({
      ...trust,
      expectedVerificationPolicy: { state: 'PRESENT', mainCommit: 'a'.repeat(40), digest: 'short' },
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
