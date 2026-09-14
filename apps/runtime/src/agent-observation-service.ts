import {
  agentObservedEventSchema,
  type AgentObserveAdapter,
} from '@codeestra/contracts';
import { classifyAgentCompletion } from '@codeestra/domain';
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
  /** Awaited after each accepted projection, before the next provider event is consumed. */
  readonly onProjected?: (result: AdapterEventResult) => void | Promise<void>;
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
    let result: AdapterEventResult;
    if (event.type === 'attention') {
      result = input.storage.recordAgentAttention({
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
      });
    } else if (event.type === 'disconnected') {
      result = input.storage.recordAgentDisconnected({
        sessionId: event.sessionId,
        executionId: event.executionId,
        providerEventId: event.eventId,
        cursor: event.cursor,
        reason: event.reason,
        sessionEventId: randomUUID(),
        executionEventId: randomUUID(),
        taskEventId: randomUUID(),
        observedAt: now(),
      });
    } else {
      if (event.outcome === 'SUCCESS' && event.failure !== undefined) {
        throw new AgentObservationServiceError('INVALID_ADAPTER_EVENT',
          'A SUCCESS completion must not carry a failure reason');
      }
      // The Runtime — not the Adapter — decides whether this completion needs a note. The rule is a
      // pure, deterministic function over provider facts; it records a stable reason code and
      // changes no Task/Execution state, so an unexplained SUCCESS stops being possible without
      // inventing an approval step, an Attention, or a new terminal state (FOUNDATION-056).
      const note = event.outcome === 'SUCCESS' && event.facts !== undefined
        ? classifyAgentCompletion(event.facts)
        : null;
      result = input.storage.recordAgentCompleted({
        sessionId: event.sessionId,
        executionId: event.executionId,
        providerEventId: event.eventId,
        cursor: event.cursor,
        outcome: event.outcome,
        evidence: event.evidence,
        ...(event.failure === undefined ? {} : { failure: event.failure }),
        ...(event.facts === undefined ? {} : { facts: event.facts }),
        ...(note === null ? {} : { note }),
        sessionEventId: randomUUID(),
        executionEventId: randomUUID(),
        taskEventId: randomUUID(),
        observedAt: now(),
      });
    }
    results.push(result);
    await input.onProjected?.(result);
  }
  return results;
}
