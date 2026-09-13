import {
  agentObservedEventSchema,
  type AgentObserveAdapter,
} from '@codeestra/contracts';
import {
  type AdapterEventResult,
  Phase1Database,
} from '@codeestra/storage';

export class AgentObservationServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentObservationServiceError';
  }
}

/** Consume one Adapter observation stream and transactionally project accepted provider events. */
export async function observeAgentEvents(input: {
  readonly storage: Phase1Database;
  readonly adapter: AgentObserveAdapter;
  readonly sessionId: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<readonly AdapterEventResult[]> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const session = input.storage.getObservableAgentSession(input.sessionId);
  if (session.adapterId !== input.adapter.id) {
    throw new AgentObservationServiceError(
      'ADAPTER_MISMATCH',
      `Session belongs to ${session.adapterId}, not ${input.adapter.id}`,
    );
  }
  const sessionRef = {
    id: session.sessionId,
    executionId: session.executionId,
    adapterId: session.adapterId,
    providerSessionId: session.providerSessionId,
  };
  const results: AdapterEventResult[] = [];
  // A provider transport loss ends the stream: a terminal projection is never followed by more events.
  for await (const untrustedEvent of input.adapter.observe(sessionRef, session.cursor)) {
    const parsed = agentObservedEventSchema.safeParse(untrustedEvent);
    if (!parsed.success) {
      throw new AgentObservationServiceError('INVALID_ADAPTER_EVENT', parsed.error.message);
    }
    const event = parsed.data;
    if (event.sessionId !== session.sessionId || event.executionId !== session.executionId) {
      throw new AgentObservationServiceError(
        'INVALID_ADAPTER_EVENT',
        'Adapter event identity did not match the persisted Session',
      );
    }
    if (event.type === 'attention') {
      results.push(input.storage.recordAgentAttention({
        sessionId: event.sessionId,
        executionId: event.executionId,
        providerEventId: event.eventId,
        cursor: event.cursor,
        providerRequestId: event.providerRequestId,
        kind: event.kind,
        responseType: event.responseType,
        prompt: event.prompt,
        attentionId: randomUUID(),
        attentionEventId: randomUUID(),
        executionEventId: randomUUID(),
        taskEventId: randomUUID(),
        observedAt: now(),
      }));
    } else if (event.type === 'disconnected') {
      results.push(input.storage.recordAgentDisconnected({
        sessionId: event.sessionId,
        executionId: event.executionId,
        providerEventId: event.eventId,
        cursor: event.cursor,
        reason: event.reason,
        sessionEventId: randomUUID(),
        executionEventId: randomUUID(),
        taskEventId: randomUUID(),
        observedAt: now(),
      }));
    } else {
      results.push(input.storage.recordAgentCompleted({
        sessionId: event.sessionId,
        executionId: event.executionId,
        providerEventId: event.eventId,
        cursor: event.cursor,
        outcome: event.outcome,
        evidence: event.evidence,
        sessionEventId: randomUUID(),
        executionEventId: randomUUID(),
        taskEventId: randomUUID(),
        observedAt: now(),
      }));
    }
  }
  return results;
}
