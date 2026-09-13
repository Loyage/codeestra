import {
  agentControlReceiptSchema,
  type AgentAnswerAdapter,
} from '@codeestra/contracts';
import {
  type AgentAnswerPlan,
  Phase1Database,
} from '@codeestra/storage';

export class AgentAnswerServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentAnswerServiceError';
  }
}

function deliveryMayHaveOccurred(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'deliveryMayHaveOccurred' in error
    && error.deliveryMayHaveOccurred === false
    ? false
    : true;
}

/** Deliver one persisted answer Operation. Only a proven pre-delivery failure is retryable. */
export async function deliverAgentAnswer(input: {
  readonly storage: Phase1Database;
  readonly adapter: AgentAnswerAdapter;
  readonly operationId: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<AgentAnswerPlan> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const existing = input.storage.getAgentAnswerPlan(input.operationId);
  if (existing.adapterId !== input.adapter.id) {
    throw new AgentAnswerServiceError('ADAPTER_MISMATCH',
      `Answer belongs to ${existing.adapterId}, not ${input.adapter.id}`);
  }
  if (existing.operationState === 'SUCCEEDED') return existing;
  if (existing.operationState !== 'PLANNED') {
    throw new AgentAnswerServiceError('ANSWER_NOT_DELIVERABLE',
      `Answer Operation is ${existing.operationState}`);
  }
  const plan = input.storage.startAgentAnswerOperation(input.operationId, now());
  try {
    const receipt = agentControlReceiptSchema.parse(await input.adapter.answer({
      id: plan.sessionId,
      executionId: plan.executionId,
      adapterId: plan.adapterId,
      providerSessionId: plan.providerSessionId,
    }, {
      operationId: plan.operationId,
      answerId: plan.answerId,
      attentionId: plan.id,
      providerRequestId: plan.providerRequestId,
      responseType: plan.responseType,
      answer: plan.answer,
    }));
    if (receipt.providerRequestId !== plan.providerRequestId) {
      throw new AgentAnswerServiceError('INVALID_ADAPTER_RECEIPT',
        'Adapter answer receipt did not match the provider request');
    }
    return input.storage.completeAgentAnswer({
      operationId: plan.operationId,
      deliveredEventId: randomUUID(),
      sessionEventId: randomUUID(),
      executionEventId: randomUUID(),
      taskEventId: randomUUID(),
      deliveredAt: now(),
    });
  } catch (error) {
    const detail = {
      code: error instanceof AgentAnswerServiceError ? error.code : 'AGENT_ANSWER_FAILED',
      message: error instanceof Error ? error.message : String(error),
    };
    if (!deliveryMayHaveOccurred(error)) {
      input.storage.retryAgentAnswerAfterProvenFailure({
        operationId: plan.operationId,
        error: detail,
        failedAt: now(),
      });
    } else {
      input.storage.markAgentAnswerUncertain({
        operationId: plan.operationId,
        recoveryEventId: randomUUID(),
        taskEventId: randomUUID(),
        error: detail,
        failedAt: now(),
      });
    }
    throw new AgentAnswerServiceError(detail.code, detail.message);
  }
}
