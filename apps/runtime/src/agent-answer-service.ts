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

function errorDetail(error: unknown, fallback: string): { code: string; message: string } {
  return {
    code: error instanceof AgentAnswerServiceError ? error.code
      : typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : fallback,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The seam that writes one permission decision to the provider side channel instead of to a
 * provider dialog. Implemented by the Runtime's Session handoff service.
 */
export interface PermissionDecisionChannel {
  deliverDecision(input: {
    readonly sessionId: string;
    readonly incarnationId: string;
    readonly providerRequestId: string;
    readonly decision: 'ALLOW' | 'DENY' | 'CANCEL';
  }): Promise<void>;
}

export interface DeliverAgentAnswerInput {
  readonly storage: Phase1Database;
  readonly adapter: AgentAnswerAdapter;
  readonly operationId: string;
  /**
   * The Runtime's side channel for STRICT permission decisions.
   *
   * A permission Attention raised over the side channel must be decided on that channel: the
   * provider never emitted a dialog for it, so writing `extension_ui_response` would report a
   * delivery about a request that does not exist.
   */
  readonly permissionChannel?: PermissionDecisionChannel;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

/**
 * Deliver one persisted answer Operation. Only a proven pre-delivery failure is retryable.
 *
 * Two routes exist and they are chosen by what the Attention actually is, not by the caller:
 * a provider dialog (mapped from `extension_ui_request`) is answered by writing the provider's own
 * response frame, while a STRICT permission request that arrived on the Runtime side channel is
 * answered there. The second route additionally claims the decision atomically against the current
 * Session incarnation, so a decision that belongs to a superseded writer is refused instead of
 * reaching a provider process the Runtime no longer owns.
 */
export async function deliverAgentAnswer(input: DeliverAgentAnswerInput): Promise<AgentAnswerPlan> {
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
  const permission = input.storage.getSessionPermissionRequest(existing.id);
  if (permission !== null) {
    return deliverPermissionDecision({ ...input, plan: existing, permission, now, randomUUID });
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
    const detail = errorDetail(error, 'AGENT_ANSWER_FAILED');
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

/**
 * The side-channel route. The order matters and is the whole point of the function:
 *
 * 1. claim the open permission decision with an atomic conditional update that also requires the
 *    asking incarnation to still be the Session's current one — a late or replayed answer for a
 *    superseded incarnation cannot win this race;
 * 2. only then write the decision to the side channel the provider is waiting on;
 * 3. only after the write, mark the decision and the answer Operation complete.
 */
async function deliverPermissionDecision(input: DeliverAgentAnswerInput & {
  readonly plan: AgentAnswerPlan;
  readonly permission: NonNullable<ReturnType<Phase1Database['getSessionPermissionRequest']>>;
  readonly now: () => number;
  readonly randomUUID: () => string;
}): Promise<AgentAnswerPlan> {
  const answer = input.plan.answer;
  const decision = answer.type === 'CONFIRM'
    ? (answer.confirmed ? 'ALLOW' as const : 'DENY' as const)
    : answer.type === 'CANCEL' ? ('CANCEL' as const) : null;
  if (decision === null) {
    throw new AgentAnswerServiceError('INVALID_STATE',
      `${answer.type} cannot answer a STRICT permission Attention`);
  }
  if (input.permissionChannel === undefined) {
    throw new AgentAnswerServiceError('PERMISSION_CHANNEL_UNAVAILABLE',
      'This Runtime has no side channel for permission decisions; the answer stays recorded');
  }
  const claim = input.storage.claimSessionPermissionDecision({
    attentionId: input.plan.id,
    claimedAt: input.now(),
  });
  if (!claim.claimed) {
    const detail = {
      code: claim.code === 'STALE_INCARNATION' ? 'STALE_INCARNATION' : claim.code,
      message: claim.code === 'STALE_INCARNATION'
        ? `Permission request ${input.permission.providerRequestId} was asked by incarnation`
          + ` ${input.permission.incarnationId}, which is no longer the writer of this conversation;`
          + ' the decision was not applied'
        : `Permission decision was not claimed (${claim.code})`,
    };
    if (claim.code === 'STALE_INCARNATION' || claim.code === 'ALREADY_DECIDED') {
      // Not retryable: this answer can never be applied, so it is recorded as failed rather than
      // left PLANNED where a later delivery attempt would look like a pending decision. The
      // permission request stops being OPEN at the same time, so nothing can claim it later.
      input.storage.markSessionPermissionRequestStale({
        attentionId: input.plan.id,
        at: input.now(),
        detail: detail.message,
      });
      input.storage.failAgentAnswerOperation({
        operationId: input.plan.operationId,
        attentionId: input.plan.id,
        error: detail,
        failedAt: input.now(),
      });
    }
    throw new AgentAnswerServiceError(detail.code, detail.message);
  }
  const started = input.storage.startAgentAnswerOperation(input.plan.operationId, input.now());
  try {
    await input.permissionChannel.deliverDecision({
      sessionId: input.permission.sessionId,
      incarnationId: input.permission.incarnationId,
      providerRequestId: input.permission.providerRequestId,
      decision,
    });
  } catch (error) {
    const detail = errorDetail(error, 'PERMISSION_DECISION_NOT_DELIVERED');
    if (!deliveryMayHaveOccurred(error)) {
      // A proven pre-delivery failure releases the claim so the recorded answer can be retried
      // while the provider is still waiting; nothing was written to the provider.
      input.storage.releaseSessionPermissionClaim(input.permission.attentionId);
      input.storage.retryAgentAnswerAfterProvenFailure({
        operationId: started.operationId,
        error: detail,
        failedAt: input.now(),
      });
    } else {
      input.storage.markAgentAnswerUncertain({
        operationId: started.operationId,
        recoveryEventId: input.randomUUID(),
        taskEventId: input.randomUUID(),
        error: detail,
        failedAt: input.now(),
      });
    }
    throw new AgentAnswerServiceError(detail.code, detail.message);
  }
  input.storage.completeSessionPermissionDecision({
    attentionId: input.permission.attentionId,
    decision,
    decidedAt: input.now(),
    decidedBy: 'local-user',
  });
  return input.storage.completeAgentAnswer({
    operationId: started.operationId,
    deliveredEventId: input.randomUUID(),
    sessionEventId: input.randomUUID(),
    executionEventId: input.randomUUID(),
    taskEventId: input.randomUUID(),
    deliveredAt: input.now(),
  });
}
