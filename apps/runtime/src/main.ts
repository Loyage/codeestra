import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { devBranchRef, runtimeRequestSchema, validateQuestionnaireAnswer, questionnairePromptSchema,
  type RuntimeRequest, type RuntimeResponse,
  type RuntimeStreamFrame } from '@codeestra/contracts';
import { inspectRepository, readLocalRefCommit } from '@codeestra/git';
import { Phase1Database, StorageError, type AgentAnswerPlan } from '@codeestra/storage';
import { createPiAdapterRegistry, piSessionDirectory } from './adapter-registry.js';
import {
  agentConfigurationPayload,
  resolveAgentConfiguration,
} from './agent-config-service.js';
import { AgentRuntimeCoordinator, deriveCommandId } from './agent-runtime-service.js';
import { EventSubscriptionHub, type EventSubscriptionHandle } from './event-subscription-service.js';
import { integrateTaskResult } from './integration-service.js';
import { RuntimeHttpApi } from './http-api.js';
import { LongOperationService } from './operation-service.js';
import { runtimeHome, runtimeSocketPath } from './paths.js';
import { readPermissionMode, writePermissionMode, type PermissionMode } from './permission-mode.js';
import {
  applyReclamation,
  listReclamationRecords,
  planReclamation,
  reconcileInterruptedReclamations,
} from './reclaim-service.js';
import { captureResultCommit, prepareResultCommit } from './result-commit-service.js';
import { pauseOrCancelTask, resumePausedTask } from './task-control-service.js';
import {
  readSessionTranscript,
  readSessionTranscriptPart,
} from './session-transcript-service.js';
import {
  reconcileInterruptedAgentAnswers,
  reconcileInterruptedAgentStarts,
  reconcileInterruptedIntegrations,
  reconcileInterruptedResultCommits,
  reconcileInterruptedRunOperations,
  reconcileInterruptedVerifications,
  reconcileWorkspacePreparations,
} from './recovery-service.js';
import {
  VerificationRunner,
  inspectVerificationPolicy,
} from './verification-service.js';

interface SocketState {
  buffer: string;
  subscription: EventSubscriptionHandle | null;
  /**
   * Bytes the socket has not accepted yet. `end(payload)` only takes what fits in the socket
   * buffer — 8192 bytes on this platform — and then never flushes the rest nor closes, so a
   * client would wait forever for a response that cannot arrive. Larger payloads are queued and
   * flushed as the socket drains.
   */
  pending: Uint8Array | null;
  /** Callers waiting for `pending` to reach the socket. */
  drainWaiters: (() => void)[];
}

const home = runtimeHome();
const socketPath = runtimeSocketPath(home);
/**
 * The only directory a transcript read may read from. It is the same directory the Pi Adapter
 * writes provider session files into, so a recorded path is checked against one owner, not two.
 */
const piSessionDir = piSessionDirectory({ runtimeHome: home, environment: Bun.env });
mkdirSync(home, { recursive: true, mode: 0o700 });
chmodSync(home, 0o700);

async function endpointIsLive(): Promise<boolean> {
  try {
    const socket = await Bun.connect<SocketState>({
      unix: socketPath,
      socket: {
        open(peer) { peer.end(); },
        data() {},
        error() {},
      },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

if (await endpointIsLive()) process.exit(0);
rmSync(socketPath, { force: true });

let permissionMode: PermissionMode = await readPermissionMode(home);
const storage = new Phase1Database(join(home, 'runtime.sqlite'));
const registry = createPiAdapterRegistry({ runtimeHome: home, environment: Bun.env });
const coordinator = new AgentRuntimeCoordinator({
  storage,
  registry,
  runtimeHome: home,
  // Configuration is resolved per Execution from the live environment and persisted scopes, so a
  // change applies to the next Agent Session without restarting the Runtime.
  resolveAgentConfig: ({ projectId, adapterId }) => {
    const { effective } = resolveAgentConfiguration({
      storage, adapterId, projectId, environment: Bun.env,
    });
    return Object.keys(effective).length === 0 ? null : effective;
  },
  permissionMode: () => permissionMode,
  logger: (message, detail) => console.error(`[runtime] ${message}`, detail ?? ''),
});
const subscriptions = new EventSubscriptionHub({ storage });
/** Built UI assets. The HTTP service is only started when a client asks for it. */
const uiAssetsRoot = Bun.env.CODEESTRA_UI_DIST === undefined
  ? resolve(import.meta.dir, '../../../apps/ui/dist')
  : resolve(Bun.env.CODEESTRA_UI_DIST);
const httpApi = new RuntimeHttpApi({
  assetsRoot: uiAssetsRoot,
  subscriptions,
  dispatch: (request) => dispatch(request),
});
await reconcileWorkspacePreparations({ storage });
reconcileInterruptedAgentStarts({ storage });
reconcileInterruptedAgentAnswers({ storage });
await reconcileInterruptedResultCommits({ storage });
reconcileInterruptedVerifications({ storage });
await reconcileInterruptedIntegrations({
  storage,
  // Proving an interrupted ref write needs the ref itself: a batch whose recorded merge is already
  // at `dev` is completed from that fact instead of being retried or reported as failed.
  readRefCommit: async ({ devRef, repositoryRoot }) => readLocalRefCommit({
    repositoryRoot, ref: devRef,
  }),
});
// A reclamation the Runtime was killed in the middle of is reconciled from the actual filesystem
// state; it never deletes anything, and it leaves what is still there for the next explicit run.
await reconcileInterruptedReclamations({ storage, runtimeHome: home });
const verificationRunner = new VerificationRunner();
/** Verification copies live inside the Runtime data directory, never in the user's repo. */
const verificationCopiesRoot = join(home, 'verifications');
/** Detached worktrees an integration merge happens in; never a user's checkout. */
const integrationWorktreesRoot = join(home, 'integrations');
// Long commands (task.run / task.verify) are durable Operations: their progress is recorded as
// facts, a cancel stops the owned process group and confirms it, and a restart reconciles them.
const longOperations = new LongOperationService({
  storage,
  runner: verificationRunner,
  coordinator,
  copiesRoot: verificationCopiesRoot,
  permissionMode: () => permissionMode,
  logger: (message, detail) => console.error(`[runtime] ${message}`, detail ?? ''),
});
reconcileInterruptedRunOperations({ storage });
let listener: ReturnType<typeof Bun.listen<SocketState>>;

function success(requestId: string, result: unknown): RuntimeResponse {
  return { requestId, schemaVersion: 1, ok: true, result };
}

/** Scope and project ID must agree before anything is written; the contract cannot express it. */
function validateAgentConfigurationScope(
  scope: 'GLOBAL' | 'PROJECT',
  projectId: string | null,
): { readonly code: string; readonly message: string } | null {
  if (scope === 'GLOBAL' && projectId !== null) {
    return { code: 'INVALID_AGENT_CONFIGURATION',
      message: 'A global Agent configuration cannot name a project' };
  }
  if (scope === 'PROJECT' && projectId === null) {
    return { code: 'INVALID_AGENT_CONFIGURATION',
      message: 'A project-scoped Agent configuration requires projectId' };
  }
  return null;
}

function failure(requestId: string, code: string, message: string): RuntimeResponse {
  return { requestId, schemaVersion: 1, ok: false, error: { code, message } };
}

/** A rejected command carries a stable code so a script can branch on it. */
class RuntimeCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RuntimeCommandError';
  }
}

/**
 * A structured answer is only meaningful for the exact questionnaire that produced the Attention.
 * A `VALUE` answer is left alone: it is the raw-dialog escape hatch used when an Attention is a
 * plain provider question rather than a Codeestra questionnaire. Storage re-checks the pairing.
 */
function assertQuestionnaireAnswerFits(
  request: Extract<RuntimeRequest, { command: 'attention.answer' }>,
): void {
  if (request.answer.type !== 'QUESTIONNAIRE') return;
  const attention = storage.getAttentionRequest(request.projectId, request.attentionId);
  if (attention === null) {
    throw new RuntimeCommandError('NOT_FOUND', 'Open Attention request was not found');
  }
  const prompt = questionnairePromptSchema.safeParse(attention.prompt);
  if (!prompt.success) {
    throw new RuntimeCommandError('NOT_A_QUESTIONNAIRE',
      'This Attention does not carry a Codeestra questionnaire; answer it with a VALUE or CANCEL');
  }
  const problem = validateQuestionnaireAnswer(prompt.data.questionnaire, request.answer.answer);
  if (problem !== null) {
    throw new RuntimeCommandError(`INVALID_QUESTIONNAIRE_ANSWER:${problem.code}`, problem.message);
  }
}

async function dispatch(request: RuntimeRequest): Promise<RuntimeResponse> {
  switch (request.command) {
    case 'runtime.ui': {
      const endpoint = httpApi.start();
      return success(request.requestId, { url: endpoint.url, running: true });
    }
    case 'runtime.ping':
      return success(request.requestId, {
        pid: process.pid,
        status: 'READY',
        permissionMode,
        adapters: registry.ids(),
        activeSessions: coordinator.activeSessionIds(),
        eventSubscribers: subscriptions.subscriberCount(),
        uiRunning: httpApi.running,
      });
    case 'runtime.stop':
      setTimeout(() => { void shutdown(); }, 10);
      return success(request.requestId, { stopping: true });
    case 'permission.get':
      return success(request.requestId, { mode: permissionMode, default: 'FULL' });
    case 'permission.set':
      permissionMode = request.mode;
      writePermissionMode(home, permissionMode);
      return success(request.requestId, {
        mode: permissionMode,
        appliesTo: 'new operations and new Agent sessions',
      });
    case 'agent.config.get':
      return success(request.requestId, agentConfigurationPayload(resolveAgentConfiguration({
        storage,
        adapterId: request.adapterId,
        projectId: request.projectId ?? null,
        environment: Bun.env,
      })));
    case 'agent.config.set': {
      const projectId = request.projectId ?? null;
      const invalid = validateAgentConfigurationScope(request.scope, projectId);
      if (invalid !== null) return failure(request.requestId, invalid.code, invalid.message);
      storage.setAgentConfiguration({
        id: crypto.randomUUID(),
        scope: request.scope,
        projectId,
        adapterId: request.adapterId,
        ...(request.provider === undefined ? {} : { provider: request.provider }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
        updatedAt: Date.now(),
        // Unlike project trust in FULL mode, changing configuration is always the user's own
        // explicit command, so the actor is the local user in either permission mode.
        updatedBy: 'local-user',
      });
      return success(request.requestId, agentConfigurationPayload(resolveAgentConfiguration({
        storage, adapterId: request.adapterId, projectId, environment: Bun.env,
      })));
    }
    case 'agent.config.clear': {
      const projectId = request.projectId ?? null;
      const invalid = validateAgentConfigurationScope(request.scope, projectId);
      if (invalid !== null) return failure(request.requestId, invalid.code, invalid.message);
      const cleared = storage.clearAgentConfiguration({
        scope: request.scope,
        projectId,
        adapterId: request.adapterId,
      });
      return success(request.requestId, {
        ...agentConfigurationPayload(resolveAgentConfiguration({
          storage, adapterId: request.adapterId, projectId, environment: Bun.env,
        })),
        cleared,
      });
    }
    case 'project.inspect': {
      const identity = await inspectRepository(request.path);
      // The baseline ref is reported together with the repository identity so a client can see
      // which commit new Task worktrees would start from (ADR-0009) before trusting the project.
      const baseline = await readLocalRefCommit({
        repositoryRoot: identity.repoRoot, ref: devBranchRef,
      });
      return success(request.requestId, {
        ...identity,
        devRef: devBranchRef,
        devCommit: baseline,
        devRefPresent: baseline !== null,
      });
    }
    case 'project.verificationPolicy': {
      const identity = await inspectRepository(request.path);
      return success(request.requestId, await inspectVerificationPolicy({
        repositoryRoot: identity.repoRoot,
        mainRef: identity.mainRef,
      }));
    }
    case 'project.list':
      // `confirmedPolicy` is the active ADR-0006 confirmation, so a client can tell whether the
      // policy at the main ref still matches what a human confirmed without re-confirming blindly.
      return success(request.requestId, storage.listTrustedProjects().map((project) => ({
        ...project,
        confirmedPolicy: storage.getConfirmedVerificationPolicy(project.id),
      })));
    case 'events.list': {
      const events = storage.listEventsAfter({
        sinceSequence: request.sinceSequence,
        limit: request.limit,
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      });
      return success(request.requestId, {
        events,
        // Exclusive cursor for the next read: the last event returned, or the cursor we asked from.
        cursor: events.at(-1)?.sequence ?? request.sinceSequence,
        hasMore: events.length === request.limit,
      });
    }
    case 'events.subscribe':
      // Streaming subscriptions are opened by the connection handler, not by the one-shot
      // dispatcher; reaching here would mean the request was routed incorrectly.
      throw new Error('events.subscribe must be handled as a streaming connection');
    case 'task.list':
      return success(request.requestId, storage.listTasks(request.projectId, {
        includeArchived: request.includeArchived,
      }));
    case 'task.status': {
      const task = storage.getTask(request.projectId, request.taskId);
      if (task === null) throw new StorageError('NOT_FOUND', 'Task was not found');
      return success(request.requestId, {
        task,
        executions: storage.listTaskExecutions(request.projectId, request.taskId),
        verifications: storage.listVerificationRuns(request.projectId, request.taskId),
        integrations: storage.listIntegrationBatches(request.projectId, request.taskId),
        // Long-command progress travels with the Task detail so the UI gets it in the same read
        // the CLI gets from task.operation.list; both are the same projection.
        operations: storage.listTaskOperations(request.projectId, request.taskId),
      });
    }
    case 'task.pause':
      return success(request.requestId, await pauseOrCancelTask({
        storage,
        coordinator,
        kind: 'PAUSE',
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        actor: 'local-user',
      }));
    case 'task.cancel':
      return success(request.requestId, await pauseOrCancelTask({
        storage,
        coordinator,
        kind: 'CANCEL',
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        actor: 'local-user',
      }));
    case 'task.resume':
      return success(request.requestId, await resumePausedTask({
        storage,
        coordinator,
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        adapterId: request.adapterId,
      }));
    case 'task.archive': {
      const payloadHash = createHash('sha256').update(JSON.stringify({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
      })).digest('hex');
      return success(request.requestId, storage.archiveTask({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        payloadHash,
        eventId: crypto.randomUUID(),
        actor: 'local-user',
        archivedAt: Date.now(),
      }));
    }
    case 'task.unarchive': {
      const payloadHash = createHash('sha256').update(JSON.stringify({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
      })).digest('hex');
      return success(request.requestId, storage.unarchiveTask({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        payloadHash,
        eventId: crypto.randomUUID(),
        actor: 'local-user',
        unarchivedAt: Date.now(),
      }));
    }
    case 'task.verify': {
      // The Operation (and the verification run) exists before any command is spawned, so the
      // background form can return a handle and a cancel or a restart can still find the run.
      const started = await longOperations.startVerification({
        projectId: request.projectId,
        taskId: request.taskId,
        ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
        commandId: request.commandId,
        background: request.background,
      });
      return success(request.requestId, started.background ? started.handle : started.report);
    }
    case 'task.verification.list':
      return success(request.requestId,
        storage.listVerificationRuns(request.projectId, request.taskId));
    case 'task.operation.list':
      return success(request.requestId,
        longOperations.listForTask(request.projectId, request.taskId));
    case 'task.operation.get':
      return success(request.requestId,
        longOperations.get(request.projectId, request.operationId));
    case 'task.operation.cancel':
      return success(request.requestId, await longOperations.cancel({
        projectId: request.projectId,
        taskId: request.taskId,
        operationId: request.operationId,
        commandId: request.commandId,
        actor: 'local-user',
      }));
    // Transcript reads are a view over the provider's own session file. They never write, never
    // change Task/Execution state, and are readable after the Session has long since exited.
    case 'session.transcript':
      return success(request.requestId, await readSessionTranscript({
        target: storage.getSessionTranscriptTarget(request.sessionId),
        sessionDir: piSessionDir,
        limit: request.limit,
        ...(request.afterEntryId === undefined ? {} : { afterEntryId: request.afterEntryId }),
      }));
    case 'session.transcript.part':
      return success(request.requestId, await readSessionTranscriptPart({
        target: storage.getSessionTranscriptTarget(request.sessionId),
        sessionDir: piSessionDir,
        entryId: request.entryId,
        partIndex: request.partIndex,
      }));
    case 'task.run':
      return success(request.requestId, await coordinator.runTask({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedTaskVersion: request.expectedTaskVersion,
        commandId: request.commandId,
        adapterId: request.adapterId,
      }));
    case 'task.result.prepare':
      return success(request.requestId, await prepareResultCommit({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
        commandId: request.commandId,
        actor: 'local-user',
        permissionMode,
      }));
    case 'task.result.capture': {
      if (permissionMode !== 'FULL') {
        return failure(request.requestId, 'FULL_PERMISSION_REQUIRED',
          'Single-step result capture is available only in FULL permission mode');
      }
      let prepareIndex = 0;
      const prepared = await prepareResultCommit({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
        commandId: deriveCommandId(request.commandId, 'full-result-prepare'),
        actor: 'runtime-full-permission',
        permissionMode,
        randomUUID: () => deriveCommandId(request.commandId, `full-result-prepare-${prepareIndex++}`),
      });
      let captureIndex = 0;
      return success(request.requestId, await captureResultCommit({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        authorizationId: prepared.authorizationId,
        commandId: deriveCommandId(request.commandId, 'full-result-commit'),
        permissionMode,
        randomUUID: () => deriveCommandId(request.commandId, `full-result-commit-${captureIndex++}`),
      }));
    }
    case 'task.result.commit':
      return success(request.requestId, await captureResultCommit({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        authorizationId: request.authorizationId,
        commandId: request.commandId,
        permissionMode,
      }));
    case 'task.integrate':
      return success(request.requestId, await integrateTaskResult({
        storage,
        runner: verificationRunner,
        copiesRoot: verificationCopiesRoot,
        worktreesRoot: integrationWorktreesRoot,
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        permissionMode,
      }));
    case 'task.integration.list':
      return success(request.requestId,
        storage.listIntegrationBatches(request.projectId, request.taskId));
    case 'reclaim.plan':
      return success(request.requestId, await planReclamation({
        storage,
        runtimeHome: home,
        projectId: request.projectId,
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
        includeFailureScenes: request.includeFailureScenes,
      }));
    case 'reclaim.apply':
      return success(request.requestId, await applyReclamation({
        storage,
        runtimeHome: home,
        projectId: request.projectId,
        commandId: request.commandId,
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
        includeFailureScenes: request.includeFailureScenes,
      }));
    case 'reclaim.records':
      return success(request.requestId, listReclamationRecords({
        storage,
        projectId: request.projectId,
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        limit: request.limit,
      }));
    case 'attention.list':
      return success(request.requestId, storage.listAttentionRequests(request.projectId));
    case 'attention.answer': {
      assertQuestionnaireAnswerFits(request);
      const payloadHash = createHash('sha256').update(JSON.stringify({
        projectId: request.projectId,
        attentionId: request.attentionId,
        answer: request.answer,
      })).digest('hex');
      const planned: AgentAnswerPlan = storage.planAttentionAnswer({
        projectId: request.projectId,
        attentionId: request.attentionId,
        commandId: request.commandId,
        payloadHash,
        intentId: crypto.randomUUID(),
        answerId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        answer: request.answer,
        intentEventId: crypto.randomUUID(),
        recordedEventId: crypto.randomUUID(),
        actor: 'local-user',
        recordedAt: Date.now(),
      });
      const delivery = await coordinator.deliverAnswer(planned.operationId);
      return success(request.requestId, {
        attentionId: planned.id,
        answerId: planned.answerId,
        operationId: planned.operationId,
        operationState: delivery.plan.operationState,
        status: delivery.plan.status,
        delivery: delivery.delivery,
        ...(delivery.error === undefined ? {} : { error: delivery.error }),
      });
    }
    case 'task.submit': {
      const payloadHash = createHash('sha256').update(JSON.stringify({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
      })).digest('hex');
      return success(request.requestId, storage.submitTask({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        payloadHash,
        eventId: crypto.randomUUID(),
        actor: 'local-user',
        submittedAt: Date.now(),
      }));
    }
    case 'task.create': {
      const payloadHash = createHash('sha256').update(JSON.stringify({
        projectId: request.projectId,
        specification: request.specification,
        constraints: request.constraints,
        kind: request.kind,
      })).digest('hex');
      return success(request.requestId, storage.createTask({
        projectId: request.projectId,
        commandId: request.commandId,
        payloadHash,
        intentId: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
        revisionId: crypto.randomUUID(),
        intentEventId: crypto.randomUUID(),
        taskEventId: crypto.randomUUID(),
        specification: request.specification,
        constraints: request.constraints,
        kind: request.kind,
        actor: 'local-user',
        createdAt: Date.now(),
      }));
    }
    case 'project.trust': {
      const identity = await inspectRepository(request.path);
      const baselineCommit = await readLocalRefCommit({
        repositoryRoot: identity.repoRoot, ref: devBranchRef,
      });
      // The client echoes exactly what `project.inspect` reported, so this comparison also pins the
      // development baseline the user saw instead of only the repository identity.
      const actual = {
        ...identity,
        devRef: devBranchRef,
        devCommit: baselineCommit,
        devRefPresent: baselineCommit !== null,
      };
      if (JSON.stringify(actual) !== JSON.stringify(request.expectedIdentity)) {
        return failure(request.requestId, 'REPOSITORY_CHANGED', 'Repository identity changed after confirmation');
      }
      // `dev` is the development baseline every Task worktree and every integration target uses.
      // Refusing trust without it is explicit: silently falling back to another branch would make
      // "integrated into dev" mean something different per project.
      if (baselineCommit === null) {
        return failure(request.requestId, 'DEV_REF_MISSING',
          `This repository has no ${devBranchRef}; create the long-lived dev branch before trusting it`);
      }
      const policy = await inspectVerificationPolicy({
        repositoryRoot: actual.repoRoot,
        mainRef: actual.mainRef,
      });
      const expected = request.expectedVerificationPolicy;
      const policyMatches = policy.state === expected.state
        && policy.mainCommit === expected.mainCommit
        && (expected.state !== 'PRESENT' || policy.digest === expected.digest);
      if (!policyMatches) {
        return failure(request.requestId, 'VERIFICATION_POLICY_CHANGED',
          'The verification policy at the main ref changed after confirmation; inspect it again');
      }
      const now = Date.now();
      storage.trustProject({
        id: crypto.randomUUID(),
        trustId: crypto.randomUUID(),
        name: basename(actual.repoRoot),
        repoRoot: actual.repoRoot,
        gitCommonDir: actual.gitCommonDir,
        mainRef: actual.mainRef,
        devRef: devBranchRef,
        objectFormat: actual.objectFormat,
        policyVersion: 1,
        verificationPolicyConfirmationId: crypto.randomUUID(),
        verificationPolicy: policy.state === 'PRESENT'
          ? { state: 'PRESENT', digest: policy.digest as string, mainRef: actual.mainRef,
              mainCommit: policy.mainCommit }
          : { state: 'ABSENT', digest: null, mainRef: actual.mainRef,
              mainCommit: policy.mainCommit },
        trustedAt: now,
        actor: permissionMode === 'FULL' ? 'runtime-full-permission' : 'local-user',
      });
      return success(request.requestId, {
        trusted: true,
        permissionMode,
        repository: identity,
        devRef: devBranchRef,
        devCommit: baselineCommit,
        verificationPolicy: policy,
      });
    }
  }
}

/**
 * Opens a streaming subscription instead of a one-shot response. The connection stays open until
 * the client disconnects, the cursor is rejected, or the Runtime stops.
 */
function openSubscription(
  socket: Bun.Socket<SocketState>,
  request: Extract<RuntimeRequest, { command: 'events.subscribe' }>,
): void {
  let ended = false;
  const send = (frame: RuntimeStreamFrame): boolean => {
    if (ended) return false;
    const line = `${JSON.stringify(frame)}\n`;
    try {
      // A terminal frame is flushed as part of the close: a bare write followed by end() can
      // lose the frame, and the client would then never learn why the subscription stopped.
      if (frame.type === 'error') {
        ended = true;
        void sendAndClose(socket, line);
        return false;
      }
      return queueWrite(socket, line);
    } catch {
      return false;
    }
  };
  const handle = subscriptions.subscribe({
    requestId: request.requestId,
    ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
    ...(request.sinceSequence === undefined ? {} : { sinceSequence: request.sinceSequence }),
    send,
    // Flush whatever is still queued before closing, so a slow reader never loses a frame.
    onStop: () => { if (!ended) { ended = true; void sendAndClose(socket, ''); } },
  });
  // A rejected cursor was already reported as a terminal frame; the socket is closing.
  if (!handle.active) return;
  socket.data.subscription = handle;
}

async function handleLine(socket: Bun.Socket<SocketState>, line: string): Promise<void> {
  let requestId = 'unknown';
  try {
    const raw: unknown = JSON.parse(line);
    if (typeof raw === 'object' && raw !== null && 'requestId' in raw && typeof raw.requestId === 'string') {
      requestId = raw.requestId;
    }
    const request = runtimeRequestSchema.parse(raw);
    if (request.command === 'events.subscribe') {
      openSubscription(socket, request);
      return;
    }
    await sendAndClose(socket, `${JSON.stringify(await dispatch(request))}\n`);
  } catch (error) {
    // Domain, storage, Git, registry, and Adapter errors all carry a stable code; a
    // transport or system error without one is reported as an invalid request.
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'string' && error.code.length > 0
      ? error.code
      : 'INVALID_REQUEST';
    const message = error instanceof Error ? error.message : 'Unknown Runtime error';
    await sendAndClose(socket, `${JSON.stringify(failure(requestId, code, message))}\n`);
  }
}

/** Writes queued bytes until the socket stops accepting them. */
function flushPending(socket: Bun.Socket<SocketState>): void {
  const state = socket.data;
  while (state.pending !== null && state.pending.byteLength > 0) {
    let written = 0;
    try {
      written = socket.write(state.pending);
    } catch {
      state.pending = null;
      break;
    }
    if (written <= 0) return;
    state.pending = written >= state.pending.byteLength
      ? null : state.pending.subarray(written);
  }
  for (const waiter of state.drainWaiters.splice(0)) waiter();
}

/** Queues one whole frame and reports whether the socket already accepted all of it. */
function queueWrite(socket: Bun.Socket<SocketState>, text: string): boolean {
  const state = socket.data;
  const bytes = Buffer.from(text, 'utf8');
  if (state.pending === null) {
    let written = 0;
    try {
      written = socket.write(bytes);
    } catch {
      return false;
    }
    if (written >= bytes.byteLength) return true;
    state.pending = bytes.subarray(Math.max(written, 0));
    return false;
  }
  state.pending = Buffer.concat([state.pending, bytes]);
  return false;
}

/** Writes every queued byte and only then closes, so no response is lost on the way out. */
async function sendAndClose(socket: Bun.Socket<SocketState>, text: string): Promise<void> {
  if (text.length > 0) queueWrite(socket, text);
  let guard = 0;
  while (socket.data.pending !== null && guard < 10_000) {
    guard += 1;
    await new Promise<void>((resolveDrain) => { socket.data.drainWaiters.push(resolveDrain); });
    flushPending(socket);
  }
  socket.end();
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  listener.stop(true);
  subscriptions.close();
  httpApi.stop();
  // Signal first: an in-flight long command stops at its next step boundary without writing a
  // verdict, so a restart cannot turn a killed command into a judged failure.
  longOperations.beginShutdown();
  try {
    await coordinator.close();
  } catch (error) {
    console.error('[runtime] shutdown could not release every Agent Session',
      error instanceof Error ? error.message : String(error));
  }
  try {
    await verificationRunner.close();
  } catch (error) {
    console.error('[runtime] shutdown could not stop every verification command',
      error instanceof Error ? error.message : String(error));
  }
  if (verificationRunner.unconfirmedStops.length > 0) {
    console.error('[runtime] verification commands did not confirm their stop',
      verificationRunner.unconfirmedStops.join(','));
  }
  // The jobs were already told to stop before their command groups were killed, so none of them
  // writes a verdict on the way down: the next start records RUNTIME_RESTARTED from the facts.
  await longOperations.close();
  storage.close();
  rmSync(socketPath, { force: true });
}

listener = Bun.listen<SocketState>({
  unix: socketPath,
  socket: {
    open(socket) {
      socket.data = { buffer: '', subscription: null, pending: null, drainWaiters: [] };
    },
    drain(socket) { flushPending(socket); },
    data(socket, bytes) {
      if (socket.data.subscription !== null) {
        // One command per connection: a subscriber must not smuggle a second request in.
        socket.end();
        return;
      }
      socket.data.buffer += new TextDecoder().decode(bytes);
      const newline = socket.data.buffer.indexOf('\n');
      if (newline === -1) {
        if (socket.data.buffer.length > 1_000_000) socket.end();
        return;
      }
      const line = socket.data.buffer.slice(0, newline);
      socket.data.buffer = socket.data.buffer.slice(newline + 1);
      void handleLine(socket, line);
    },
    close(socket) { socket.data.subscription?.close(); },
    error() {},
  },
});
chmodSync(socketPath, 0o600);
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
