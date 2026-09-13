import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runtimeRequestSchema, type RuntimeRequest, type RuntimeResponse } from '@codeestra/contracts';
import { inspectRepository } from '@codeestra/git';
import { Phase1Database, StorageError, type AgentAnswerPlan } from '@codeestra/storage';
import { createPiAdapterRegistry } from './adapter-registry.js';
import { AgentRuntimeCoordinator } from './agent-runtime-service.js';
import { runtimeHome, runtimeSocketPath } from './paths.js';
import { captureResultCommit, prepareResultCommit } from './result-commit-service.js';
import {
  reconcileInterruptedAgentAnswers,
  reconcileInterruptedAgentStarts,
  reconcileInterruptedResultCommits,
  reconcileWorkspacePreparations,
} from './recovery-service.js';

interface SocketState { buffer: string }

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
await reconcileWorkspacePreparations({ storage });
reconcileInterruptedAgentStarts({ storage });
reconcileInterruptedAgentAnswers({ storage });
await reconcileInterruptedResultCommits({ storage });
let listener: ReturnType<typeof Bun.listen<SocketState>>;

function success(requestId: string, result: unknown): RuntimeResponse {
  return { requestId, schemaVersion: 1, ok: true, result };
}

function failure(requestId: string, code: string, message: string): RuntimeResponse {
  return { requestId, schemaVersion: 1, ok: false, error: { code, message } };
}

async function dispatch(request: RuntimeRequest): Promise<RuntimeResponse> {
  switch (request.command) {
    case 'runtime.ping':
      return success(request.requestId, {
        pid: process.pid,
        status: 'READY',
        adapters: registry.ids(),
        activeSessions: coordinator.activeSessionIds(),
      });
    case 'runtime.stop':
      setTimeout(() => { void shutdown(); }, 10);
      return success(request.requestId, { stopping: true });
    case 'project.inspect':
      return success(request.requestId, await inspectRepository(request.path));
    case 'project.list':
      return success(request.requestId, storage.listTrustedProjects());
    case 'task.list':
      return success(request.requestId, storage.listTasks(request.projectId));
    case 'task.status': {
      const task = storage.listTasks(request.projectId).find((candidate) => candidate.id === request.taskId);
      if (task === undefined) throw new StorageError('NOT_FOUND', 'Task was not found');
      return success(request.requestId, {
        task,
        executions: storage.listTaskExecutions(request.projectId, request.taskId),
      });
    }
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
        trustedAt: now,
        actor: 'local-user',
      });
      return success(request.requestId, { trusted: true, repository: actual });
    }
  }
}

async function handleLine(socket: Bun.Socket<SocketState>, line: string): Promise<void> {
  let requestId = 'unknown';
  try {
    const raw: unknown = JSON.parse(line);
    if (typeof raw === 'object' && raw !== null && 'requestId' in raw && typeof raw.requestId === 'string') {
      requestId = raw.requestId;
    }
    const request = runtimeRequestSchema.parse(raw);
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
  try {
    await coordinator.close();
  } catch (error) {
    console.error('[runtime] shutdown could not release every Agent Session',
      error instanceof Error ? error.message : String(error));
  }
  storage.close();
  rmSync(socketPath, { force: true });
}

listener = Bun.listen<SocketState>({
  unix: socketPath,
  socket: {
    open(socket) { socket.data = { buffer: '' }; },
    data(socket, bytes) {
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
    error() {},
  },
});
chmodSync(socketPath, 0o600);
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
