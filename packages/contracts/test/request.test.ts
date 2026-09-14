import { describe, expect, test } from 'bun:test';
import { agentObservedEventSchema, maxEventReadLimit, runtimeRequestSchema,
  runtimeStreamFrameSchema, thinkingLevels } from '../src/index.js';

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
  test('accepts only the two explicit permission modes', () => {
    const command = { requestId: base.requestId, schemaVersion: 1, command: 'permission.set' };
    expect(runtimeRequestSchema.safeParse({ ...command, mode: 'FULL' }).success).toBe(true);
    expect(runtimeRequestSchema.safeParse({ ...command, mode: 'STRICT' }).success).toBe(true);
    expect(runtimeRequestSchema.safeParse({ ...command, mode: 'UNKNOWN' }).success).toBe(false);
  });

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

  test('keeps strict result commit confirmation while exposing full-mode single-step capture', () => {
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
    const capture = {
      requestId: base.requestId,
      schemaVersion: base.schemaVersion,
      command: 'task.result.capture' as const,
      commandId: base.commandId,
      projectId: base.projectId,
      taskId,
    };
    expect(runtimeRequestSchema.safeParse(capture).success).toBe(true);
    expect(runtimeRequestSchema.safeParse({ ...capture,
      executionId: '55555555-5555-4555-8555-555555555555' }).success).toBe(true);
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

  test('requires a Task version for integration and accepts a plain integration read', () => {
    const integration = {
      requestId: base.requestId,
      schemaVersion: base.schemaVersion,
      command: 'task.integrate' as const,
      commandId: base.commandId,
      projectId: base.projectId,
      taskId: '66666666-6666-4666-8666-666666666666',
      expectedVersion: 3,
    };
    expect(runtimeRequestSchema.safeParse(integration).success).toBe(true);
    // Integration changes the Task state, so it must carry the optimistic-concurrency version.
    const { expectedVersion: _dropped, ...withoutVersion } = integration;
    expect(runtimeRequestSchema.safeParse(withoutVersion).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({ ...integration, expectedVersion: -1 }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({
      requestId: base.requestId,
      schemaVersion: base.schemaVersion,
      command: 'task.integration.list',
      projectId: base.projectId,
      taskId: '66666666-6666-4666-8666-666666666666',
    }).success).toBe(true);
  });

  test('requires a Task version for a dependency edit and allows an unpinned add', () => {
    const taskId = '66666666-6666-4666-8666-666666666666';
    const prerequisiteTaskId = '77777777-7777-4777-8777-777777777777';
    const add = {
      requestId: base.requestId,
      schemaVersion: base.schemaVersion,
      command: 'task.depends.add' as const,
      commandId: base.commandId,
      projectId: base.projectId,
      taskId,
      prerequisiteTaskId,
      expectedVersion: 1,
    };
    // The pin is optional: absent means "the upstream's current revision".
    expect(runtimeRequestSchema.safeParse(add).success).toBe(true);
    expect(runtimeRequestSchema.safeParse({ ...add, requiredRevisionId: crypto.randomUUID() }).success)
      .toBe(true);
    // Editing the graph moves the Task version, so the CAS field is mandatory.
    const { expectedVersion: _dropped, ...withoutVersion } = add;
    expect(runtimeRequestSchema.safeParse(withoutVersion).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({ ...add, expectedVersion: -1 }).success).toBe(false);
    // `remove` has nothing left to pin, so the field is not part of its contract at all.
    expect(runtimeRequestSchema.safeParse({
      requestId: base.requestId,
      schemaVersion: base.schemaVersion,
      command: 'task.depends.remove',
      commandId: base.commandId,
      projectId: base.projectId,
      taskId,
      prerequisiteTaskId,
      expectedVersion: 2,
    }).success).toBe(true);
    // `list` is read-only and works for one Task or the whole project.
    expect(runtimeRequestSchema.safeParse({
      requestId: base.requestId, schemaVersion: base.schemaVersion,
      command: 'task.depends.list', projectId: base.projectId,
    }).success).toBe(true);
    expect(runtimeRequestSchema.safeParse({
      requestId: base.requestId, schemaVersion: base.schemaVersion,
      command: 'task.depends.list', projectId: base.projectId, taskId,
    }).success).toBe(true);
    expect(runtimeRequestSchema.safeParse({
      requestId: base.requestId, schemaVersion: base.schemaVersion,
      command: 'task.depends.list', projectId: base.projectId, expectedVersion: 0,
    }).success).toBe(false);
  });

  test('requires an explicit verification policy confirmation when trusting a project', () => {
    const trust = {
      requestId: base.requestId,
      schemaVersion: base.schemaVersion,
      command: 'project.trust' as const,
      path: '/repo',
      // The identity a client echoes back is what `project.inspect` returned, so it also pins the
      // development baseline every Task worktree would be created from (ADR-0018).
      expectedIdentity: {
        repoRoot: '/repo', gitCommonDir: '/repo/.git', mainRef: 'refs/heads/main',
        objectFormat: 'sha1', headCommit: 'a'.repeat(40),
        devRef: 'refs/heads/dev', devCommit: 'a'.repeat(40), devRefPresent: true,
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
    // A baseline that was never part of what the user reviewed cannot be confirmed silently.
    const identityWithoutBaseline = {
      repoRoot: '/repo', gitCommonDir: '/repo/.git', mainRef: 'refs/heads/main',
      objectFormat: 'sha1', headCommit: 'a'.repeat(40),
    };
    expect(runtimeRequestSchema.safeParse({
      ...trust,
      expectedIdentity: identityWithoutBaseline,
      expectedVerificationPolicy: { state: 'ABSENT', mainCommit: 'a'.repeat(40) },
    }).success).toBe(false);
    // A missing dev branch is representable (the Runtime then refuses trust with DEV_REF_MISSING).
    expect(runtimeRequestSchema.safeParse({
      ...trust,
      expectedIdentity: { ...trust.expectedIdentity, devCommit: null, devRefPresent: false },
      expectedVerificationPolicy: { state: 'ABSENT', mainCommit: 'a'.repeat(40) },
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

describe('Agent configuration request boundary', () => {
  const command = { requestId: base.requestId, schemaVersion: 1 as const };

  test('defaults the Adapter and keeps an absent field distinct from an explicit clear', () => {
    expect(runtimeRequestSchema.parse({ ...command, command: 'agent.config.get' }))
      .toEqual({ ...command, command: 'agent.config.get', adapterId: 'pi' });
    const set = runtimeRequestSchema.parse({ ...command, command: 'agent.config.set', model: null });
    expect(set).toMatchObject({ adapterId: 'pi', scope: 'GLOBAL', model: null });
    // Absent means "leave unchanged", so the parser must not turn it into null.
    expect(set).not.toHaveProperty('provider');
    expect(runtimeRequestSchema.parse({ ...command, command: 'agent.config.set' }))
      .not.toHaveProperty('model');
  });

  test('accepts every supported thinking level and rejects anything else', () => {
    for (const thinkingLevel of thinkingLevels) {
      expect(runtimeRequestSchema.safeParse({
        ...command, command: 'agent.config.set', thinkingLevel,
      }).success).toBe(true);
    }
    expect(runtimeRequestSchema.safeParse({
      ...command, command: 'agent.config.set', thinkingLevel: 'extreme',
    }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({
      ...command, command: 'agent.config.set', thinkingLevel: null,
    }).success).toBe(true);
  });

  test('rejects blank values, unknown fields, and non-UUID project scopes', () => {
    expect(runtimeRequestSchema.safeParse({
      ...command, command: 'agent.config.set', model: '',
    }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({
      ...command, command: 'agent.config.set', unknown: 'x',
    }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({
      ...command, command: 'agent.config.clear', scope: 'PROJECT', projectId: 'not-a-uuid',
    }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({
      ...command, command: 'agent.config.get', projectId: base.projectId,
    }).success).toBe(true);
  });
});

describe('Runtime event subscription boundary', () => {
  const list = {
    requestId: '11111111-1111-4111-8111-111111111111',
    schemaVersion: 1 as const,
    command: 'events.list' as const,
  };

  test('defaults the event read cursor and limit without inventing a project filter', () => {
    expect(runtimeRequestSchema.parse(list)).toEqual({ ...list, sinceSequence: 0, limit: 100 });
    expect(runtimeRequestSchema.parse({ ...list, sinceSequence: 7, limit: 5 })).toMatchObject({
      sinceSequence: 7, limit: 5,
    });
  });

  test('rejects cursors, limits, and project filters outside the contract', () => {
    expect(runtimeRequestSchema.safeParse({ ...list, sinceSequence: -1 }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({ ...list, sinceSequence: 1.5 }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({ ...list, limit: 0 }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({ ...list, limit: maxEventReadLimit + 1 }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({ ...list, projectId: 'not-a-uuid' }).success).toBe(false);
    expect(runtimeRequestSchema.safeParse({
      ...list, command: 'events.subscribe', unknownField: true,
    }).success).toBe(false);
  });

  test('distinguishes a from-now subscription from an explicit cursor', () => {
    const subscribe = {
      requestId: list.requestId,
      schemaVersion: 1 as const,
      command: 'events.subscribe' as const,
    };
    // An absent cursor means "from the current tail", so it must stay absent rather than default to 0.
    expect(runtimeRequestSchema.parse(subscribe)).toEqual(subscribe);
    expect(runtimeRequestSchema.parse({ ...subscribe, sinceSequence: 0 }))
      .toMatchObject({ sinceSequence: 0 });
    expect(runtimeRequestSchema.safeParse({ ...subscribe, sinceSequence: -1 }).success).toBe(false);
  });
});

describe('Runtime stream frames', () => {
  const envelope = {
    eventId: 'event-1', sequence: 4, eventType: 'TaskCreated', schemaVersion: 1,
    projectId: 'project-1', aggregateType: 'Task', aggregateId: 'task-1', aggregateVersion: 0,
    correlationId: 'correlation-1', causationId: null, occurredAt: 5, payload: { taskId: 'task-1' },
  };

  test('accepts the frames a subscriber can receive', () => {
    expect(runtimeStreamFrameSchema.safeParse({
      schemaVersion: 1, type: 'subscribed', requestId: '11111111-1111-4111-8111-111111111111',
      cursor: 0, projectId: null,
    }).success).toBe(true);
    expect(runtimeStreamFrameSchema.safeParse({
      schemaVersion: 1, type: 'event', cursor: 4, event: envelope,
    }).success).toBe(true);
    expect(runtimeStreamFrameSchema.safeParse({
      schemaVersion: 1, type: 'heartbeat', cursor: 4,
    }).success).toBe(true);
    expect(runtimeStreamFrameSchema.safeParse({
      schemaVersion: 1, type: 'error', code: 'INVALID_CURSOR', message: 'ahead of the log',
    }).success).toBe(true);
  });

  test('refuses a frame whose cursor or envelope cannot be trusted', () => {
    expect(runtimeStreamFrameSchema.safeParse({
      schemaVersion: 1, type: 'event', cursor: 0, event: envelope,
    }).success).toBe(false);
    expect(runtimeStreamFrameSchema.safeParse({
      schemaVersion: 1, type: 'event', cursor: 4, event: { ...envelope, sequence: 0 },
    }).success).toBe(false);
    expect(runtimeStreamFrameSchema.safeParse({
      schemaVersion: 1, type: 'event', cursor: 4,
    }).success).toBe(false);
    // A frame type the Runtime never sends must not be accepted from a peer either.
    expect(runtimeStreamFrameSchema.safeParse({ schemaVersion: 1, type: 'snapshot', cursor: 4 }).success)
      .toBe(false);
    expect(runtimeStreamFrameSchema.safeParse({
      schemaVersion: 1, type: 'heartbeat', cursor: 4, extra: true,
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

  test('accepts a bounded provider failure reason on a FAILURE completion only', () => {
    const event = {
      sessionId: 'session', executionId: 'execution', eventId: 'provider-event', cursor: 'cursor',
      type: 'completed', outcome: 'FAILURE',
      failure: { code: 'PROVIDER_TURN_FAILED',
        message: 'error: Codex error: The usage limit has been reached' },
      evidence: { ref: 'evidence', toolsQuiescent: true, ownedWritersStopped: true },
    };
    const parsed = agentObservedEventSchema.safeParse(event);
    expect(parsed.success).toBe(true);
    expect(agentObservedEventSchema.safeParse({
      ...event, failure: { code: 'PROVIDER_TURN_FAILED' },
    }).success).toBe(false);
    expect(agentObservedEventSchema.safeParse({
      ...event, failure: { ...event.failure, detail: 'extra' },
    }).success).toBe(false);
  });
});
