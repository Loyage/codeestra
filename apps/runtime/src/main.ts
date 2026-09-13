import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runtimeRequestSchema, type RuntimeRequest, type RuntimeResponse } from '@codeestra/contracts';
import { GitInspectionError, inspectRepository } from '@codeestra/git';
import { Phase1Database, StorageError } from '@codeestra/storage';
import { runtimeHome, runtimeSocketPath } from './paths.js';
import {
  reconcileInterruptedAgentAnswers,
  reconcileInterruptedAgentStarts,
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
await reconcileWorkspacePreparations({ storage });
reconcileInterruptedAgentStarts({ storage });
reconcileInterruptedAgentAnswers({ storage });
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
      return success(request.requestId, { pid: process.pid, status: 'READY' });
    case 'runtime.stop':
      setTimeout(() => shutdown(), 10);
      return success(request.requestId, { stopping: true });
    case 'project.inspect':
      return success(request.requestId, await inspectRepository(request.path));
    case 'project.list':
      return success(request.requestId, storage.listTrustedProjects());
    case 'task.list':
      return success(request.requestId, storage.listTasks(request.projectId));
    case 'attention.list':
      return success(request.requestId, storage.listAttentionRequests(request.projectId));
    case 'attention.answer': {
      const payloadHash = createHash('sha256').update(JSON.stringify({
        projectId: request.projectId,
        attentionId: request.attentionId,
        answer: request.answer,
      })).digest('hex');
      return success(request.requestId, storage.planAttentionAnswer({
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
      }));
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
    const code = error instanceof GitInspectionError || error instanceof StorageError
      ? error.code
      : 'INVALID_REQUEST';
    const message = error instanceof Error ? error.message : 'Unknown Runtime error';
    socket.end(`${JSON.stringify(failure(requestId, code, message))}\n`);
  }
}

function shutdown(): void {
  listener.stop(true);
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
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
