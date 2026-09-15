import { createHash } from 'node:crypto';
import {
  supportsProcessRelease,
  type AgentAnswerAdapter,
  type AgentConfiguration,
} from '@codeestra/contracts';
import {
  defaultProseQuestionAttentionMode,
  type ProseQuestionAttentionMode,
} from '@codeestra/domain';
import {
  Phase1Database,
  type AgentAnswerPlan,
  type ObservableAgentSession,
} from '@codeestra/storage';
import { assertPiPluginSelectionUsable } from '@codeestra/agent-adapters';
import type { AdapterRegistry } from './adapter-registry.js';
import { deliverAgentAnswer } from './agent-answer-service.js';
import { observeAgentEvents } from './agent-observation-service.js';
import { startReservedExecution } from './agent-start-service.js';
import {
  agentLaunchConfiguration,
  type AgentPluginResolution,
} from './agent-config-service.js';
import { executionKnowledgeRefs, prepareExecutionKnowledge } from './knowledge-service.js';
import { withDeadline } from './lifecycle.js';
import {
  beginTaskRunOperation,
  operationSteps,
  recordRunStep,
  settleRunOperation,
} from './operation-service.js';
import { prepareReservedWorkspace, prepareTaskWorkspace } from './workspace-service.js';

/**
 * Derived command IDs make one `task.run` command ID cover its whole chain. Replaying the
 * same command therefore reaches each already-recorded receipt instead of repeating a Git,
 * Execution, or Adapter side effect. Format is version-4 shaped so the IPC schema accepts it.
 */
export function deriveCommandId(runCommandId: string, purpose: string): string {
  const digest = createHash('sha256')
    .update(`codeestra:task.run:${purpose}:${runCommandId}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class AgentRuntimeServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentRuntimeServiceError';
  }
}

export interface RunTaskResult {
  readonly executionId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly attemptNumber: number;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sessionState: string;
  readonly permissionMode: 'FULL' | 'STRICT';
  /** Effective Agent configuration this Execution was reserved with; `null` means defaults. */
  readonly agentConfig: AgentConfiguration | null;
}

export type AnswerDeliveryOutcome = 'DELIVERED' | 'NOT_DELIVERED';

export interface AnswerDeliveryResult {
  readonly plan: AgentAnswerPlan;
  readonly delivery: AnswerDeliveryOutcome;
  readonly error?: Readonly<{ code: string; message: string }>;
}

export interface AgentRuntimeCoordinatorOptions {
  readonly storage: Phase1Database;
  readonly registry: AdapterRegistry;
  readonly runtimeHome: string;
  readonly environment?: Readonly<Record<string, string>>;
  /**
   * Resolves the configuration for one Execution. The Runtime supplies this so the coordinator
   * never reads persisted configuration itself: what it reserves is exactly what it launches.
   */
  readonly resolveAgentConfig?: (input: {
    readonly projectId: string;
    readonly adapterId: string;
  }) => AgentConfiguration | null;
  /**
   * The plugin/resources this Execution's Agent may load, resolved from the same persisted scopes
   * and recorded with the Execution (ADR-0044 D04).
   */
  readonly resolveAgentPlugins?: (input: {
    readonly projectId: string;
    readonly adapterId: string;
  }) => AgentPluginResolution | null;
  readonly permissionMode?: () => 'FULL' | 'STRICT';
  /**
   * The prose-question escalation setting (FOUNDATION-069). It is read per Session start so a
   * `settings prose-question-attention` change applies to the next run without restarting the
   * Runtime — this is a setting, not a gate, and it never retroactively changes a recorded wait.
   */
  readonly proseQuestionAttentionMode?: () => ProseQuestionAttentionMode;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly shutdownGraceMs?: number;
  /**
   * Identity of this Runtime generation. A reservation may only be turned into a run by the boot that
   * created it (`SLOT_HELD_BY_ANOTHER_RUNTIME` otherwise), so the coordinator needs the same boot id
   * the slot service records.
   */
  readonly bootId?: string;
  readonly logger?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

/**
 * Owns the Runtime side of one Execution attempt: workspace, Execution reservation, Agent
 * start, the observation stream, and automatic delivery of recorded answers. It never
 * reattaches a lost provider process and never fabricates a Session state it cannot observe.
 */
export class AgentRuntimeCoordinator {
  readonly #storage: Phase1Database;
  readonly #registry: AdapterRegistry;
  readonly #runtimeHome: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #resolveAgentConfig: (input: {
    readonly projectId: string;
    readonly adapterId: string;
  }) => AgentConfiguration | null;
  readonly #resolveAgentPlugins: (input: {
    readonly projectId: string;
    readonly adapterId: string;
  }) => AgentPluginResolution | null;
  readonly #permissionMode: () => 'FULL' | 'STRICT';
  readonly #proseQuestionAttentionMode: () => ProseQuestionAttentionMode;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #shutdownGraceMs: number;
  readonly #bootId: string;
  readonly #logger: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  readonly #pumps = new Map<string, Promise<void>>();

  constructor(options: AgentRuntimeCoordinatorOptions) {
    this.#storage = options.storage;
    this.#registry = options.registry;
    this.#runtimeHome = options.runtimeHome;
    this.#environment = options.environment ?? {};
    this.#resolveAgentConfig = options.resolveAgentConfig ?? (() => null);
    this.#resolveAgentPlugins = options.resolveAgentPlugins ?? (() => null);
    this.#permissionMode = options.permissionMode ?? (() => 'FULL');
    this.#proseQuestionAttentionMode = options.proseQuestionAttentionMode
      ?? (() => defaultProseQuestionAttentionMode);
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
    this.#bootId = options.bootId ?? 'runtime';
    this.#logger = options.logger ?? (() => {});
  }

  activeSessionIds(): readonly string[] {
    return [...this.#pumps.keys()];
  }

  /**
   * Reserve the workspace and Execution, start one Agent Session, and begin observing it.
   * The observation loop runs in the background; `settle()` awaits it and is intended for
   * tests, shutdown, and other points where the Runtime must know the stream has ended.
   */
  async runTask(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedTaskVersion: number;
    readonly commandId: string;
    readonly adapterId: string;
    /** Present when this attempt continues a paused Execution through provider conversation resume. */
    readonly resume?: {
      readonly resumeFromExecutionId: string;
      readonly predecessorSessionId: string;
      readonly predecessorSessionStorageRef: string;
      readonly predecessorProviderSessionId: string | null;
    };
  }): Promise<RunTaskResult> {
    const adapter = this.#registry.resolve(input.adapterId);
    // The run Operation is created before any Git or provider side effect, so a cancel or a
    // restart can find the run while it is still happening — and so a run that fails during the
    // version probe is still a recorded attempt rather than a silent rejection. Its command ID is
    // the idempotency key.
    const operationId = deriveCommandId(input.commandId, 'run-operation');
    beginTaskRunOperation({
      storage: this.#storage,
      projectId: input.projectId,
      taskId: input.taskId,
      operationId,
      commandId: input.commandId,
      adapterId: adapter.id,
      expectedTaskVersion: input.expectedTaskVersion,
      createdAt: this.#now(),
    });
    try {
      const probe = await adapter.probe();
      const workspace = await prepareTaskWorkspace({
        storage: this.#storage,
        runtimeHome: this.#runtimeHome,
        commandId: deriveCommandId(input.commandId, 'workspace'),
        projectId: input.projectId,
        taskId: input.taskId,
        expectedTaskVersion: input.expectedTaskVersion,
        now: this.#now,
        randomUUID: this.#randomUUID,
      });
      recordRunStep({
        storage: this.#storage,
        operationId,
        stepKey: operationSteps.workspacePrepared,
        step: 'WORKSPACE',
        state: 'SUCCEEDED',
        detail: {
          workspaceId: workspace.workspaceId,
          workspacePath: workspace.path,
          baseCommit: workspace.baseCommit,
        },
        recordedAt: this.#now(),
      });
      return await this.#startPreparedExecution({
        projectId: input.projectId,
        taskId: input.taskId,
        expectedTaskVersion: input.expectedTaskVersion,
        commandId: input.commandId,
        adapter,
        operationId,
        adapterVersion: probe.version,
        workspace: {
          workspaceId: workspace.workspaceId,
          path: workspace.path,
          baseCommit: workspace.baseCommit,
        },
        ...(input.resume === undefined ? {} : { resume: input.resume }),
      });
    } catch (error) {
      // A run that never reached a Session is closed from the error it actually produced. The
      // workspace and Agent start Operations keep their own, more specific recovery records.
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'RUN_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      recordRunStep({
        storage: this.#storage,
        operationId,
        stepKey: 'RUN_FAILED',
        step: 'RUN',
        state: 'FAILED',
        detail: { code, message },
        recordedAt: this.#now(),
      });
      this.#storage.completeOperation({
        operationId,
        state: code === 'RECOVERY_REQUIRED' || code === 'RECONCILE_REQUIRED'
          ? 'RECONCILE_REQUIRED' : 'FAILED',
        result: { code, message },
        completedAt: this.#now(),
      });
      throw error;
    }
  }


  /**
   * The start itself, shared by the two ways a run is established: `task.run` prepares the worktree
   * directly, while the scheduling engine prepares it *for a slot reservation* it already holds
   * (scheduler.md §2: reserve, then prepare the workspace outside the transaction, then start
   * exactly one primary Agent). Both paths then record the same Execution and run steps, because a
   * Task must not be able to tell from its audit which of the two started it.
   */
  async #startPreparedExecution(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedTaskVersion: number;
    readonly commandId: string;
    readonly adapter: AgentAnswerAdapter;
    readonly operationId: string;
    readonly adapterVersion: string;
    readonly workspace: {
      readonly workspaceId: string;
      readonly path: string;
      readonly baseCommit: string;
    };
    readonly resume?: {
      readonly resumeFromExecutionId: string;
      readonly predecessorSessionId: string;
      readonly predecessorSessionStorageRef: string;
      readonly predecessorProviderSessionId: string | null;
    };
  }): Promise<RunTaskResult> {
    const adapter = input.adapter;
      // Resolved before the reservation, so the effective configuration is part of the Execution's
      // recorded input and the Adapter cannot be started with something else.
      const resolvedConfiguration = this.#resolveAgentConfig({
        projectId: input.projectId,
        adapterId: adapter.id,
      });
      const resolvedPlugins = this.#resolveAgentPlugins({
        projectId: input.projectId,
        adapterId: adapter.id,
      });
      // Fail-closed, before the Execution exists: a selected path that cannot be loaded refuses this
      // Session with the stable code `AGENT_PLUGIN_UNAVAILABLE` instead of starting an Agent with a
      // selection the Execution would then have recorded untruthfully (ADR-0044 D02).
      assertPiPluginSelectionUsable(resolvedPlugins?.selection ?? null);
      // The recorded input is exactly what the Adapter is launched with; the Adapter reads the
      // selection back from this record rather than resolving configuration a second time.
      const agentConfig = agentLaunchConfiguration({
        configuration: resolvedConfiguration,
        plugins: resolvedPlugins,
      });
      // Project Knowledge (FOUNDATION-067 / ADR-0041) is resolved, validated and materialized
      // *before* the Execution row exists. A knowledge layer that cannot be loaded refuses the start
      // (ADR-0041 D04) by throwing here, where there is nothing to roll back: no Execution, no
      // workspace transition, no provider process. Nothing is written into the worktree (D05), so
      // this step cannot change what the Task's own change set, result commit, or impact
      // assessment looks like.
      const task = this.#storage.getTask(input.projectId, input.taskId);
      if (task === null) {
        throw new AgentRuntimeServiceError('TASK_NOT_FOUND',
          `No Task ${input.taskId} in project ${input.projectId}`);
      }
      const knowledge = await prepareExecutionKnowledge({
        storage: this.#storage,
        home: this.#runtimeHome,
        projectId: input.projectId,
        taskId: input.taskId,
        taskKind: task.kind,
        commandId: deriveCommandId(input.commandId, 'knowledge'),
        now: this.#now,
      });
      const execution = this.#storage.reserveExecution({
        projectId: input.projectId,
        taskId: input.taskId,
        expectedTaskVersion: input.expectedTaskVersion,
        workspaceId: input.workspace.workspaceId,
        executionId: deriveCommandId(input.commandId, 'execution'),
        commandId: deriveCommandId(input.commandId, 'reserve-execution'),
        payloadHash: deriveCommandId(input.commandId, 'reserve-payload'),
        reservationEventId: this.#randomUUID(),
        taskEventId: this.#randomUUID(),
        adapterId: adapter.id,
        adapterVersion: input.adapterVersion,
        agentConfig,
        // The binding is inserted in the same transaction as the Execution row, so "this Execution
        // exists" and "this Execution is bound to the knowledge it used" are never observable apart.
        knowledgeBinding: knowledge.binding,
        ...(input.resume === undefined
          ? {} : { resumeFromExecutionId: input.resume.resumeFromExecutionId }),
        actor: 'runtime-scheduler',
        createdAt: this.#now(),
      });
      recordRunStep({
        storage: this.#storage,
        operationId: input.operationId,
        stepKey: operationSteps.executionReserved,
        step: 'EXECUTION',
        state: 'SUCCEEDED',
        detail: {
          executionId: execution.executionId,
          attemptNumber: execution.attemptNumber,
          taskVersion: execution.taskVersion,
        },
        recordedAt: this.#now(),
      });
      const permissionMode = this.#permissionMode();
      const started = await startReservedExecution({
        storage: this.#storage,
        adapter,
        projectId: input.projectId,
        executionId: execution.executionId,
        expectedExecutionVersion: 0,
        prepareCommandId: deriveCommandId(input.commandId, 'prepare-execution'),
        startCommandId: deriveCommandId(input.commandId, 'start-agent'),
        environment: this.#environment,
        permissionMode,
        // The exact knowledge this Execution uses, as references an observation can be replayed
        // against. An Adapter is free to ignore them; the binding above is the authority.
        knowledgeSnapshotRefs: knowledge.refs,
        ...(input.resume === undefined ? {} : {
          resume: {
            predecessorSessionId: input.resume.predecessorSessionId,
            sessionStorageRef: input.resume.predecessorSessionStorageRef,
            providerSessionId: input.resume.predecessorProviderSessionId,
          },
        }),
        now: this.#now,
        randomUUID: this.#randomUUID,
      });
      recordRunStep({
        storage: this.#storage,
        operationId: input.operationId,
        stepKey: operationSteps.agentSessionStarted,
        step: 'AGENT_SESSION',
        state: 'SUCCEEDED',
        detail: {
          sessionId: started.sessionId,
          adapterId: started.adapterId,
          adapterVersion: started.adapterVersion,
          sessionState: started.sessionState,
        },
        recordedAt: this.#now(),
      });
      this.#ensurePump(started.sessionId);
      return {
        executionId: execution.executionId,
        sessionId: started.sessionId,
        taskId: execution.taskId,
        taskVersion: execution.taskVersion,
        attemptNumber: execution.attemptNumber,
        workspaceId: execution.workspaceId,
        workspacePath: execution.workspacePath,
        baseCommit: execution.baseCommit,
        adapterId: started.adapterId,
        adapterVersion: started.adapterVersion,
        sessionState: started.sessionState,
        permissionMode,
        agentConfig: started.agentConfig ?? null,
      };
  }

  /**
   * Starts one Task inside a slot reservation the scheduling engine already holds
   * (FOUNDATION-055). The reservation is the authority for the workspace: this refuses to prepare a
   * worktree for a reservation another Runtime generation created, and the prepared workspace is
   * bound to the reservation before any Execution exists. Everything after that is the ordinary run
   * path, so an Execution started by the scheduler is indistinguishable from one started by
   * `task.run` — same Operation, same steps, same recovery records.
   */
  async runScheduledExecution(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedTaskVersion: number;
    readonly revisionId: string;
    readonly adapterId: string;
    readonly reservationId: string;
    readonly commandId: string;
    readonly actor: string;
  }): Promise<RunTaskResult> {
    const adapter = this.#registry.resolve(input.adapterId);
    const operationId = deriveCommandId(input.commandId, 'scheduled-run-operation');
    beginTaskRunOperation({
      storage: this.#storage,
      projectId: input.projectId,
      taskId: input.taskId,
      operationId,
      commandId: input.commandId,
      adapterId: adapter.id,
      expectedTaskVersion: input.expectedTaskVersion,
      createdAt: this.#now(),
    });
    try {
      const reservation = this.#storage.getSlotReservation(input.projectId, input.reservationId);
      if (reservation.state !== 'RESERVED') {
        throw new AgentRuntimeServiceError('SLOT_NOT_ACTIVE',
          `Reservation ${input.reservationId} is ${reservation.state}; no Execution is started for it`);
      }
      if (reservation.holder.bootId !== this.#bootId) {
        throw new AgentRuntimeServiceError('SLOT_HELD_BY_ANOTHER_RUNTIME',
          `Reservation ${input.reservationId} was created by Runtime boot`
          + ` ${reservation.holder.bootId}; this generation does not start its Execution`);
      }
      if (reservation.taskId !== input.taskId || reservation.revisionId !== input.revisionId) {
        throw new AgentRuntimeServiceError('REVISION_CHANGED',
          `Reservation ${input.reservationId} is for ${reservation.taskId}@${reservation.revisionId},`
          + ` not for ${input.taskId}@${input.revisionId}`);
      }
      const probe = await adapter.probe();
      const workspace = await prepareReservedWorkspace({
        storage: this.#storage,
        runtimeHome: this.#runtimeHome,
        bootId: this.#bootId,
        commandId: deriveCommandId(input.commandId, 'slot-workspace'),
        projectId: input.projectId,
        reservationId: input.reservationId,
        expectedTaskVersion: input.expectedTaskVersion,
        actor: input.actor,
        now: this.#now,
        randomUUID: this.#randomUUID,
      });
      recordRunStep({
        storage: this.#storage,
        operationId,
        stepKey: operationSteps.workspacePrepared,
        step: 'WORKSPACE',
        state: 'SUCCEEDED',
        detail: {
          workspaceId: workspace.workspaceId,
          workspacePath: workspace.path,
          baseCommit: workspace.baseCommit,
          reservationId: input.reservationId,
        },
        recordedAt: this.#now(),
      });
      return await this.#startPreparedExecution({
        projectId: input.projectId,
        taskId: input.taskId,
        expectedTaskVersion: input.expectedTaskVersion,
        commandId: input.commandId,
        adapter,
        operationId,
        adapterVersion: probe.version,
        workspace: {
          workspaceId: workspace.workspaceId,
          path: workspace.path,
          baseCommit: workspace.baseCommit,
        },
      });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'RUN_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      recordRunStep({
        storage: this.#storage,
        operationId,
        stepKey: 'RUN_FAILED',
        step: 'RUN',
        state: 'FAILED',
        detail: { code, message },
        recordedAt: this.#now(),
      });
      this.#storage.completeOperation({
        operationId,
        state: code === 'RECOVERY_REQUIRED' || code === 'RECONCILE_REQUIRED'
          ? 'RECONCILE_REQUIRED' : 'FAILED',
        result: { code, message },
        completedAt: this.#now(),
      });
      throw error;
    }
  }

  /**
   * Deliver one recorded answer to the Adapter that currently observes its Session. An
   * answer recorded while no live provider process is held stays recorded instead of
   * being replayed or reported as delivered.
   */
  async deliverAnswer(operationId: string): Promise<AnswerDeliveryResult> {
    const plan = this.#storage.getAgentAnswerPlan(operationId);
    if (plan.operationState === 'SUCCEEDED') return { plan, delivery: 'DELIVERED' };
    if (!this.#pumps.has(plan.sessionId)) {
      return {
        plan,
        delivery: 'NOT_DELIVERED',
        error: {
          code: 'NO_LIVE_SESSION',
          message: 'No live Agent Session is held for this answer; it stays recorded',
        },
      };
    }
    let adapter: AgentAnswerAdapter;
    try {
      adapter = this.#registry.resolve(plan.adapterId);
    } catch (error) {
      return {
        plan,
        delivery: 'NOT_DELIVERED',
        error: { code: 'UNKNOWN_ADAPTER', message: error instanceof Error ? error.message : String(error) },
      };
    }
    try {
      const delivered = await deliverAgentAnswer({
        storage: this.#storage,
        adapter,
        operationId,
        now: this.#now,
        randomUUID: this.#randomUUID,
      });
      return { plan: delivered, delivery: 'DELIVERED' };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'AGENT_ANSWER_FAILED';
      return {
        plan: this.#storage.getAgentAnswerPlan(operationId),
        delivery: 'NOT_DELIVERED',
        error: { code, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  /**
   * Cooperatively release the provider process that owns one Execution. Returns whether the
   * Runtime could confirm the process exited; an unconfirmable stop must become
   * RECOVERY_REQUIRED rather than a claimed pause/cancel. The Session row is left for the caller to
   * project, so the confirmation and the state transition stay one decision.
   */
  async releaseExecutionProcess(executionId: string): Promise<{
    readonly sessionId: string | null;
    readonly released: boolean;
    readonly detail: string;
  }> {
    const session = this.#storage.findAgentSessionByExecution(executionId);
    if (session === null) {
      return { sessionId: null, released: true, detail: 'no Agent Session was recorded' };
    }
    if (session.state === 'EXITED') {
      return { sessionId: session.sessionId, released: true, detail: 'Session had already exited' };
    }
    let adapter: AgentAnswerAdapter;
    try {
      adapter = this.#registry.resolve(session.adapterId);
    } catch (error) {
      return { sessionId: session.sessionId, released: false,
        detail: error instanceof Error ? error.message : String(error) };
    }
    if (!supportsProcessRelease(adapter)) {
      return { sessionId: session.sessionId, released: false,
        detail: `Adapter ${session.adapterId} cannot confirm a provider stop` };
    }
    try {
      const released = await adapter.releaseSession(session.sessionId);
      if (released === null) {
        return { sessionId: session.sessionId, released: true,
          detail: 'no live provider process was held' };
      }
      return {
        sessionId: session.sessionId,
        released: released.exited,
        detail: released.exited
          ? `provider process ${released.pid} exited`
          : `provider process ${released.pid} did not confirm exit`,
      };
    } catch (error) {
      return { sessionId: session.sessionId, released: false,
        detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Awaits observation streams started so far. Streams that never end are not forced to end. */
  async settle(): Promise<void> {
    while (this.#pumps.size > 0) {
      await Promise.allSettled([...this.#pumps.values()]);
    }
  }

  /**
   * Cooperatively release every provider process this Runtime still holds. A stop the
   * Adapter cannot confirm is logged, never assumed. A released Session is projected as
   * recovery-required because this Runtime can no longer observe the provider, and the
   * projection is attributed to the Runtime rather than fabricated as a provider event.
   */
  async close(): Promise<void> {
    for (const sessionId of [...this.#pumps.keys()]) {
      let session: ObservableAgentSession;
      try {
        session = this.#storage.getObservableAgentSession(sessionId);
      } catch (error) {
        this.#logger('Agent Session could not be read for release', {
          sessionId,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      try {
        const adapter = this.#registry.resolve(session.adapterId);
        if (supportsProcessRelease(adapter)) {
          const released = await adapter.releaseSession(sessionId);
          if (released !== null && !released.exited) {
            this.#logger('provider process could not be confirmed stopped', {
              sessionId,
              pid: released.pid,
            });
          }
        }
      } catch (error) {
        this.#logger('provider process release was not possible', {
          sessionId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        this.#storage.recordRuntimeDisconnect({
          sessionId,
          reason: 'Runtime shutdown released the provider process',
          sessionEventId: this.#randomUUID(),
          executionEventId: this.#randomUUID(),
          taskEventId: this.#randomUUID(),
          recoveryEventId: this.#randomUUID(),
          recoveredAt: this.#now(),
        });
      } catch (error) {
        this.#logger('Runtime shutdown disconnect could not be projected', {
          sessionId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // A provider that cannot be released may never end its stream; shutdown stays bounded
    // and reports the remaining Sessions rather than blocking the Runtime forever.
    const settled = await withDeadline(this.settle(), this.#shutdownGraceMs);
    if (!settled.settled) {
      this.#logger('Agent observation streams did not end before the shutdown deadline', {
        sessions: this.activeSessionIds(),
      });
    }
  }

  /**
   * Holds back the Agent's `completed` event while a handoff request is open.
   *
   * ADR-0010 D03: the settled fact that follows a handoff fence is the takeover's *safe point*, not
   * the completion of the Execution, because the conversation continues under a successor
   * incarnation. Pi's own definition of `agent_settled` (no retry, no queued continuation) is
   * exactly the "no new tools, nothing left running in this process" fact the handoff needs, so the
   * Runtime records the safe point from the side channel and does not project a completion here.
   */
  #handoffSafeAdapter(
    adapter: AgentAnswerAdapter,
    sessionId: string,
    onSuppressed: () => void,
  ): AgentAnswerAdapter {
    const storage = this.#storage;
    return {
      id: adapter.id,
      probe: () => adapter.probe(),
      start: (request) => adapter.start(request),
      answer: (session, request) => adapter.answer(session, request),
      observe: async function* observe(session, cursor) {
        for await (const event of adapter.observe(session, cursor)) {
          if (event.type === 'completed' && storage.getOpenSessionHandoffRequest(sessionId) !== null) {
            onSuppressed();
            continue;
          }
          yield event;
        }
      },
    };
  }

  /**
   * Starts the RPC successor that takes a conversation back from a released native terminal
   * (ADR-0010 D04 step 6, ADR-0026). It reuses the *recorded* start plan of the Session — the same
   * workspace, ownership token, revision and Agent configuration — and reopens the same provider
   * session file, so "the same Execution continues" is a statement about identical inputs.
   *
   * The observation loop is started here, because this coordinator is what owns provider processes
   * and their event projection; the caller only records the resulting incarnation.
   */
  async startAutomationSuccessor(input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly reason: string;
  }): Promise<{
    readonly adapterId: string;
    readonly projectId: string;
    readonly sessionId: string;
    readonly executionId: string;
    readonly providerSessionId: string | null;
    readonly sessionStorageRef: string | null;
    readonly providerPid: number | null;
    readonly processIdentity: unknown;
  }> {
    const plan = this.#storage.getAgentStartPlanForSession(input.sessionId);
    if (plan === null) {
      throw new AgentRuntimeServiceError('SESSION_PLAN_UNAVAILABLE',
        'The Session start plan could not be reconstructed; refusing to start a successor with'
        + ' different inputs');
    }
    const identity = this.#storage.getAgentSessionIdentity(input.sessionId);
    if (identity === null) {
      throw new AgentRuntimeServiceError('SESSION_NOT_FOUND', 'Agent Session was not found');
    }
    // A successor reopens the *recorded* start plan, which pins the revision this conversation was
    // started on. If the Task has since been revised and that revision was never confirmed on this
    // Execution, restarting the automation would resume work on a specification that is no longer the
    // Task's — exactly the "resume on an unacknowledged revision" the FSM forbids. The honest
    // disposition is `task.revision.delivery.resolve --action stop-and-restart`, which records a
    // successor Execution with the new revision instead of continuing this conversation.
    const task = this.#storage.getTask(plan.projectId, plan.taskId);
    if (task !== null && task.currentRevision.id !== plan.revisionId) {
      const unsatisfied = this.#storage.findUnsatisfiedRevisionDelivery({
        taskId: plan.taskId, executionId: plan.executionId,
      });
      throw new AgentRuntimeServiceError('REVISION_NOT_ACKNOWLEDGED',
        `The Task is now on revision ${task.currentRevision.id} but this Session was started on`
        + ` ${plan.revisionId}`
        + (unsatisfied === null
          ? ''
          : `, and its revision delivery ${unsatisfied.id} is ${unsatisfied.state}`)
        + '; returning this conversation to automation would re-enter a specification that is no'
        + ' longer the Task\'s. Use `task revision delivery resolve` to stop and restart it, which'
        + ' continues the same provider conversation on the current revision');
    }
    if (identity.sessionStorageRef === null) {
      throw new AgentRuntimeServiceError('SESSION_FILE_UNRECORDED',
        'The Session has no recorded provider session file to reopen');
    }
    const adapter = this.#registry.resolve(plan.adapterId);
    const permissionMode = this.#permissionMode();
    const started = await adapter.start({
      operationId: deriveCommandId(input.commandId, 'successor'),
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
        constraints: plan.constraints.map((constraint) => ({
          id: constraint.id, text: constraint.text,
        })),
      },
      knowledgeSnapshotRefs: executionKnowledgeRefs(
        this.#storage.getExecutionKnowledgeSnapshot(plan.executionId)),
      permissionMode,
      resume: {
        predecessorSessionId: plan.sessionId,
        sessionStorageRef: identity.sessionStorageRef,
        providerSessionId: identity.providerSessionId,
      },
      ...(plan.agentConfig === null ? {} : { agentConfig: plan.agentConfig }),
      environment: this.#environment,
    });
    if (started.sessionStorageRef !== undefined && started.sessionStorageRef !== null
      && started.sessionStorageRef !== identity.sessionStorageRef) {
      // A successor that reopened a different conversation must not stay alive: it would be a second
      // conversation claiming this Execution's identity.
      if (supportsProcessRelease(adapter)) {
        await adapter.releaseSession(plan.sessionId).catch(() => null);
      }
      throw new AgentRuntimeServiceError('SESSION_FILE_CHANGED',
        `The automation successor reopened ${started.sessionStorageRef} instead of`
        + ` ${identity.sessionStorageRef}`);
    }
    this.#ensurePump(plan.sessionId);
    const processIdentity = started.processIdentity;
    const providerPid = typeof processIdentity === 'object' && processIdentity !== null
      && typeof (processIdentity as { pid?: unknown }).pid === 'number'
      ? (processIdentity as { pid: number }).pid : null;
    return {
      adapterId: plan.adapterId,
      projectId: plan.projectId,
      sessionId: plan.sessionId,
      executionId: plan.executionId,
      providerSessionId: started.providerSessionId ?? null,
      sessionStorageRef: started.sessionStorageRef ?? null,
      providerPid,
      processIdentity: processIdentity ?? null,
    };
  }

  /**
   * Reads the escalation setting for one Session. A broken setting must not turn a perfectly good
   * completion into an unobservable stream, so the failure is logged and the product default is
   * used. The default is the *more* informative behaviour (it records the wait); the downgrade has
   * to be asked for explicitly, never inferred from an unreadable file.
   */
  #readProseQuestionAttentionMode(sessionId: string): ProseQuestionAttentionMode {
    try {
      return this.#proseQuestionAttentionMode();
    } catch (error) {
      this.#logger('the prose-question attention setting could not be read; using the default', {
        sessionId,
        default: defaultProseQuestionAttentionMode,
        reason: error instanceof Error ? error.message : String(error),
      });
      return defaultProseQuestionAttentionMode;
    }
  }

  #ensurePump(sessionId: string): void {
    if (this.#pumps.has(sessionId)) return;
    let session: ObservableAgentSession;
    try {
      session = this.#storage.getObservableAgentSession(sessionId);
    } catch (error) {
      this.#logger('Agent Session could not be observed', {
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const pump = this.#pumpSession(session).finally(() => {
      this.#pumps.delete(sessionId);
    });
    this.#pumps.set(sessionId, pump);
  }

  async #pumpSession(session: ObservableAgentSession): Promise<void> {
    let adapter: AgentAnswerAdapter;
    try {
      adapter = this.#registry.resolve(session.adapterId);
    } catch (error) {
      this.#logger('Agent Session has no registered Adapter', {
        sessionId: session.sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let observed = false;
    let suppressedCompletion = false;
    try {
      await observeAgentEvents({
        storage: this.#storage,
        adapter: this.#handoffSafeAdapter(adapter, session.sessionId,
          () => { suppressedCompletion = true; }),
        sessionId: session.sessionId,
        now: this.#now,
        randomUUID: this.#randomUUID,
        proseQuestionAttentionMode: this.#readProseQuestionAttentionMode(session.sessionId),
        onProjected: async () => {
          await this.#deliverPlannedAnswers(session.sessionId);
        },
      });
      observed = true;
    } catch (error) {
      this.#logger('Agent observation ended with an error', {
        sessionId: session.sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (suppressedCompletion) {
      // The Agent settled while a handoff was open: that settled fact is the takeover's safe point,
      // and the conversation continues under the successor incarnation (ADR-0010 D03). The run is
      // therefore *not* over and its Operation is deliberately left open instead of being closed
      // from a Session state that the successor will change again.
      this.#logger('a settled fact was treated as a handoff safe point, not as a completion', {
        sessionId: session.sessionId,
      });
      return;
    }
    // The stream ending is a fact, but it is not a verdict: the run Operation is closed from the
    // recorded Session and Execution states, so an unknown end becomes RECONCILE_REQUIRED.
    try {
      settleRunOperation({
        storage: this.#storage,
        projectId: session.projectId,
        taskId: session.taskId,
        executionId: session.executionId,
        observed,
        recordedAt: this.#now(),
      });
    } catch (error) {
      this.#logger('run Operation could not be settled from facts', {
        sessionId: session.sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Safety net for answers recorded while the stream was between events. */
  async #deliverPlannedAnswers(sessionId: string): Promise<void> {
    for (const plan of this.#storage.listIncompleteAgentAnswers()) {
      if (plan.sessionId !== sessionId || plan.operationState !== 'PLANNED') continue;
      const result = await this.deliverAnswer(plan.operationId);
      if (result.delivery === 'NOT_DELIVERED') {
        this.#logger('recorded Agent answer could not be delivered', {
          operationId: plan.operationId,
          code: result.error?.code ?? 'UNKNOWN',
        });
      }
    }
  }
}
