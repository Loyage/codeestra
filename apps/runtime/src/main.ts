import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { runtimeRequestSchema, type RuntimeRequest, type RuntimeResponse,
  type RuntimeStreamFrame } from '@codeestra/contracts';
import { inspectRepository } from '@codeestra/git';
import { Phase1Database, StorageError, type AgentAnswerPlan } from '@codeestra/storage';
import { createPiAdapterRegistry } from './adapter-registry.js';
import { AgentRuntimeCoordinator } from './agent-runtime-service.js';
import { EventSubscriptionHub, type EventSubscriptionHandle } from './event-subscription-service.js';
import { RuntimeHttpApi } from './http-api.js';
import { runtimeHome, runtimeSocketPath } from './paths.js';
import { captureResultCommit, prepareResultCommit } from './result-commit-service.js';
import {
  reconcileInterruptedAgentAnswers,
  reconcileInterruptedAgentStarts,
  reconcileInterruptedResultCommits,
  reconcileInterruptedVerifications,
  reconcileWorkspacePreparations,
} from './recovery-service.js';
import {
  VerificationRunner,
  inspectVerificationPolicy,
  runTaskVerification,
} from './verification-service.js';

interface SocketState {
  buffer: string;
  subscription: EventSubscriptionHandle | null;
}

const home = runtimeHome();
const socketPath = runtimeSocketPath(home);
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

const storage = new Phase1Database(join(home, 'runtime.sqlite'));
const registry = createPiAdapterRegistry({ runtimeHome: home, environment: Bun.env });
const coordinator = new AgentRuntimeCoordinator({
  storage,
  registry,
  runtimeHome: home,
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
const verificationRunner = new VerificationRunner();
/** Verification copies live inside the Runtime data directory, never in the user's repo. */
const verificationCopiesRoot = join(home, 'verifications');
let listener: ReturnType<typeof Bun.listen<SocketState>>;

function success(requestId: string, result: unknown): RuntimeResponse {
  return { requestId, schemaVersion: 1, ok: true, result };
}

function failure(requestId: string, code: string, message: string): RuntimeResponse {
  return { requestId, schemaVersion: 1, ok: false, error: { code, message } };
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
        adapters: registry.ids(),
        activeSessions: coordinator.activeSessionIds(),
        eventSubscribers: subscriptions.subscriberCount(),
        uiRunning: httpApi.running,
      });
    case 'runtime.stop':
      setTimeout(() => { void shutdown(); }, 10);
      return success(request.requestId, { stopping: true });
    case 'project.inspect':
      return success(request.requestId, await inspectRepository(request.path));
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
      return success(request.requestId, storage.listTasks(request.projectId));
    case 'task.status': {
      const task = storage.listTasks(request.projectId).find((candidate) => candidate.id === request.taskId);
      if (task === undefined) throw new StorageError('NOT_FOUND', 'Task was not found');
      return success(request.requestId, {
        task,
        executions: storage.listTaskExecutions(request.projectId, request.taskId),
        verifications: storage.listVerificationRuns(request.projectId, request.taskId),
      });
    }
    case 'task.verify':
      return success(request.requestId, await runTaskVerification({
        storage,
        runner: verificationRunner,
        copiesRoot: verificationCopiesRoot,
        projectId: request.projectId,
        taskId: request.taskId,
        ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
        commandId: request.commandId,
      }));
    case 'task.verification.list':
      return success(request.requestId,
        storage.listVerificationRuns(request.projectId, request.taskId));
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
      }));
    case 'task.result.commit':
      return success(request.requestId, await captureResultCommit({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        authorizationId: request.authorizationId,
        commandId: request.commandId,
      }));
    case 'attention.list':
      return success(request.requestId, storage.listAttentionRequests(request.projectId));
    case 'attention.answer': {
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
      const actual = await inspectRepository(request.path);
      if (JSON.stringify(actual) !== JSON.stringify(request.expectedIdentity)) {
        return failure(request.requestId, 'REPOSITORY_CHANGED', 'Repository identity changed after confirmation');
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
        objectFormat: actual.objectFormat,
        policyVersion: 1,
        verificationPolicyConfirmationId: crypto.randomUUID(),
        verificationPolicy: policy.state === 'PRESENT'
          ? { state: 'PRESENT', digest: policy.digest as string, mainRef: actual.mainRef,
              mainCommit: policy.mainCommit }
          : { state: 'ABSENT', digest: null, mainRef: actual.mainRef,
              mainCommit: policy.mainCommit },
        trustedAt: now,
        actor: 'local-user',
      });
      return success(request.requestId, { trusted: true, repository: actual, verificationPolicy: policy });
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
        socket.end(line);
        return false;
      }
      return socket.write(line) > 0;
    } catch {
      return false;
    }
  };
  const handle = subscriptions.subscribe({
    requestId: request.requestId,
    ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
    ...(request.sinceSequence === undefined ? {} : { sinceSequence: request.sinceSequence }),
    send,
    onStop: () => { if (!ended) { ended = true; socket.end(); } },
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
    socket.end(`${JSON.stringify(await dispatch(request))}\n`);
  } catch (error) {
    // Domain, storage, Git, registry, and Adapter errors all carry a stable code; a
    // transport or system error without one is reported as an invalid request.
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'string' && error.code.length > 0
      ? error.code
      : 'INVALID_REQUEST';
    const message = error instanceof Error ? error.message : 'Unknown Runtime error';
    socket.end(`${JSON.stringify(failure(requestId, code, message))}\n`);
  }
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  listener.stop(true);
  subscriptions.close();
  httpApi.stop();
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
  storage.close();
  rmSync(socketPath, { force: true });
}

listener = Bun.listen<SocketState>({
  unix: socketPath,
  socket: {
    open(socket) { socket.data = { buffer: '', subscription: null }; },
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
