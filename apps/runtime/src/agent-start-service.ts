import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  agentPluginSelectionFromTrace,
  agentPluginSelectionIsEmpty,
  type AgentKnowledgeContext,
  type AgentStartAdapter,
} from '@codeestra/contracts';
import {
  Phase1Database,
  type AgentStartPlan,
  type StoredAgentConfiguration,
} from '@codeestra/storage';
import { machineGeneratedRuntimeDirectory } from '@codeestra/domain';
import { GuidanceContextError, guidanceContextForExecution } from './guidance-context.js';

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

/**
 * The plugin selection this Session may load, read back from the Execution's own recorded trace.
 * An Execution with no recorded plugins gets no `pluginSelection` argument at all, which is what
 * keeps its provider launch byte-identical to the launch before this capability (ADR-0044 D02).
 */
function pluginSelectionStartArgument(
  configuration: StoredAgentConfiguration | null,
): { readonly pluginSelection?: ReturnType<typeof agentPluginSelectionFromTrace> } {
  const trace = configuration?.plugins;
  if (trace === undefined) return {};
  const selection = agentPluginSelectionFromTrace(trace);
  return agentPluginSelectionIsEmpty(selection) ? {} : { pluginSelection: selection };
}

/**
 * The materialized Project Knowledge artifact the Adapter must hand to its provider (ADR-0041 D05,
 * ADR-0051).
 *
 * The Runtime reads back the binding it recorded for **this Execution** — never the knowledge the
 * project declares now — and turns its Runtime-relative `contextPath` into an absolute path under
 * this Runtime's own data directory. Two rules make the result trustworthy:
 *
 * 1. **Only real knowledge is handed over.** A missing binding, or a binding with zero materialized
 *    entries, returns nothing at all, so an Execution with no knowledge keeps a byte-identical
 *    controlled launch instead of pointing its provider at a header-only file.
 * 2. **A recorded binding without a Runtime home is a refusal, not a downgrade.** A caller that
 *    cannot name the home it materialized into is a caller that cannot start this Execution: the
 *    alternative is starting the Agent anyway, which would silently turn "this Execution ran with
 *    knowledge K" into a false statement.
 *
 * The recorded `contextPath` is relative to `<home>/knowledge/<project-id>` — the same root
 * `writeRuntimeKnowledgeFile` resolves it against — so this resolves it the same way instead of
 * re-deriving the layout from the record.
 */
export function knowledgeContextStartArgument(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly executionId: string;
  readonly runtimeHome: string | undefined;
}): { readonly knowledgeContext?: AgentKnowledgeContext } {
  const binding = input.storage.getExecutionKnowledgeSnapshot(input.executionId);
  if (binding === null || binding.entryCount === 0) return {};
  if (input.runtimeHome === undefined) {
    throw new AgentStartServiceError('KNOWLEDGE_CONTEXT_UNAVAILABLE',
      `Execution ${binding.executionId} is bound to knowledge snapshot ${binding.snapshotId} but no`
      + ' Runtime home was supplied, so the materialized context cannot be located; refusing to start'
      + ' an Agent without the knowledge its Execution recorded');
  }
  const root = join(input.runtimeHome, machineGeneratedRuntimeDirectory, input.projectId);
  const filePath = resolve(root, binding.contextPath);
  const inside = relative(root, filePath);
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) {
    throw new AgentStartServiceError('KNOWLEDGE_CONTEXT_UNAVAILABLE',
      'The recorded knowledge context path is outside this Runtime\'s knowledge directory, so it is'
      + ' not a Runtime-owned artifact');
  }
  return { knowledgeContext: {
    filePath, digest: binding.contextDigest, bytes: binding.contextBytes,
  } };
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
  /**
   * This Runtime's own data directory. It is what turns the recorded, Runtime-relative knowledge
   * context path into the absolute path an Adapter verifies and hands to its provider (ADR-0051).
   * A caller that omits it while an Execution is bound to knowledge is refused, never silently
   * started without that knowledge.
   */
  readonly runtimeHome?: string;
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
    // The Task's recorded Session Guidance is materialized here, after every refusal path and
    // immediately before the launch, so a start that never reaches the Adapter never claims to have
    // carried guidance (ADR-0057). A Task with no guidance produces no field at all, which is what
    // keeps its controlled launch byte-identical.
    const guidance = await guidanceContextForExecution({
      storage: input.storage,
      runtimeHome: input.runtimeHome,
      projectId: plan.projectId,
      taskId: plan.taskId,
      executionId: plan.executionId,
      now,
      randomUUID,
    }).catch((error: unknown) => {
      // The materialized guidance is verified by the Adapter too, but the Runtime owns the refusal
      // here: a Task that has guidance and cannot produce its artifact must not start an Agent with
      // less input than the ledger records (ADR-0057). The stable code is preserved so a caller sees
      // `GUIDANCE_CONTEXT_UNAVAILABLE` rather than a generic start failure.
      if (error instanceof GuidanceContextError) {
        throw new AgentStartServiceError('GUIDANCE_CONTEXT_UNAVAILABLE', error.message);
      }
      throw error;
    });
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
      ...knowledgeContextStartArgument({
        storage: input.storage,
        projectId: input.projectId,
        executionId: plan.executionId,
        runtimeHome: input.runtimeHome,
      }),
      ...guidance,
      permissionMode,
      ...(input.resume === undefined ? {} : { resume: input.resume }),
      // The configuration resolved at reservation time, so the Adapter launches exactly what the
      // Execution records as its input rather than re-reading mutable configuration here.
      ...(plan.agentConfig === null ? {} : { agentConfig: plan.agentConfig }),
      // The plugin selection is read back from the recorded trace, so a replay (including one after
      // a Runtime restart) launches the same resources the Execution row names (ADR-0044 D04).
      ...pluginSelectionStartArgument(plan.agentConfig),
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
