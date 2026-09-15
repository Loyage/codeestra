import { createHash } from 'node:crypto';
import type { AgentStartAdapter } from '@codeestra/contracts';
import {
  Phase1Database,
  type AgentStartPlan,
} from '@codeestra/storage';

export class AgentStartServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentStartServiceError';
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function startOccurrence(error: unknown): 'NO' | 'YES' | 'UNKNOWN' {
  if (typeof error === 'object' && error !== null && 'startMayHaveOccurred' in error
    && typeof error.startMayHaveOccurred === 'boolean') {
    return error.startMayHaveOccurred ? 'YES' : 'NO';
  }
  return 'UNKNOWN';
}

export async function startReservedExecution(input: {
  readonly storage: Phase1Database;
  readonly adapter: AgentStartAdapter;
  readonly projectId: string;
  readonly executionId: string;
  readonly expectedExecutionVersion: number;
  readonly prepareCommandId: string;
  readonly startCommandId: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly permissionMode?: 'FULL' | 'STRICT';
  /**
   * References to the knowledge the Execution was bound to (FOUNDATION-067 / ADR-0041). The Runtime
   * passes exactly what it recorded in `execution_knowledge_snapshots`; absent means the Execution
   * resolved no knowledge at all, which the Adapter sees as an empty list rather than as `undefined`.
   */
  readonly knowledgeSnapshotRefs?: readonly string[];
  /** Present when this Execution continues a paused one through provider conversation resume. */
  readonly resume?: {
    readonly predecessorSessionId: string;
    readonly sessionStorageRef: string;
    readonly providerSessionId: string | null;
  };
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<AgentStartPlan> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const preparing = input.storage.markExecutionPreparing({
    projectId: input.projectId,
    executionId: input.executionId,
    expectedExecutionVersion: input.expectedExecutionVersion,
    commandId: input.prepareCommandId,
    payloadHash: hash({ executionId: input.executionId, expectedVersion: input.expectedExecutionVersion }),
    eventId: randomUUID(),
    changedAt: now(),
  });
  const probe = await input.adapter.probe();
  const permissionMode = input.permissionMode ?? 'FULL';
  const startPayloadHash = hash({
    executionId: input.executionId,
    expectedVersion: preparing.version,
    adapterId: input.adapter.id,
    adapterVersion: probe.version,
    permissionMode,
  });
  const recorded = input.storage.findAgentStart(input.projectId, input.startCommandId, startPayloadHash);
  if (recorded?.operationState === 'SUCCEEDED' || recorded?.operationState === 'FAILED') return recorded;
  if (recorded !== null && recorded.operationState !== 'PLANNED') {
    throw new AgentStartServiceError(
      'RECONCILE_REQUIRED',
      `Agent start is ${recorded.operationState}; refusing to invoke the Adapter again`,
    );
  }
  const plan = input.storage.planAgentStart({
    operationId: randomUUID(),
    idempotencyKey: input.startCommandId,
    payloadHash: startPayloadHash,
    projectId: input.projectId,
    executionId: input.executionId,
    expectedExecutionVersion: preparing.version,
    sessionId: randomUUID(),
    adapterId: input.adapter.id,
    adapterVersion: probe.version,
    capabilities: probe.capabilities,
    eventId: randomUUID(),
    plannedAt: now(),
  });
  if (plan.operationState === 'SUCCEEDED' || plan.operationState === 'FAILED') return plan;
  if (plan.operationState !== 'PLANNED') {
    throw new AgentStartServiceError('RECONCILE_REQUIRED', 'Agent start cannot be replayed safely');
  }

  input.storage.startAgentOperation(plan.operationId, now());
  try {
    const session = await input.adapter.start({
      operationId: plan.operationId,
      sessionId: plan.sessionId,
      executionId: plan.executionId,
      workspace: {
        id: plan.workspaceId,
        cwd: plan.workspacePath,
        ownershipToken: plan.ownershipToken,
      },
      revision: {
        id: plan.revisionId,
        specification: plan.specification,
        constraints: plan.constraints,
      },
      knowledgeSnapshotRefs: input.knowledgeSnapshotRefs ?? [],
      permissionMode,
      ...(input.resume === undefined ? {} : { resume: input.resume }),
      // The configuration resolved at reservation time, so the Adapter launches exactly what the
      // Execution records as its input rather than re-reading mutable configuration here.
      ...(plan.agentConfig === null ? {} : { agentConfig: plan.agentConfig }),
      environment: input.environment ?? {},
    });
    if (session.id !== plan.sessionId || session.executionId !== plan.executionId
      || session.adapterId !== plan.adapterId || session.providerSessionId === undefined) {
      throw new AgentStartServiceError('INVALID_ADAPTER_RESPONSE', 'Adapter returned a mismatched Session identity');
    }
    return input.storage.completeAgentStart({
      operationId: plan.operationId,
      sessionId: plan.sessionId,
      providerSessionId: session.providerSessionId,
      adapterId: session.adapterId,
      ...(session.processIdentity === undefined ? {} : { processIdentity: session.processIdentity }),
      ...(session.sessionStorageRef === undefined ? {} : { sessionStorageRef: session.sessionStorageRef }),
      sessionEventId: randomUUID(),
      executionEventId: randomUUID(),
      completedAt: now(),
    });
  } catch (error) {
    const code = error instanceof AgentStartServiceError ? error.code : 'AGENT_START_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    if (startOccurrence(error) !== 'NO') {
      input.storage.markAgentStartUncertain({
        operationId: plan.operationId,
        sessionId: plan.sessionId,
        recoveryEventId: randomUUID(),
        taskEventId: randomUUID(),
        error: { code, message },
        failedAt: now(),
      });
    } else {
      input.storage.failAgentStartBeforeSideEffect({
        operationId: plan.operationId,
        sessionId: plan.sessionId,
        executionEventId: randomUUID(),
        taskEventId: randomUUID(),
        error: { code, message },
        failedAt: now(),
      });
    }
    throw new AgentStartServiceError(code, message);
  }
}
