import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { HandoffChannelCommand } from '@codeestra/agent-adapters';
import type { AgentSessionRef, AgentStartRequest } from '@codeestra/contracts';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import { Phase1Database } from '@codeestra/storage';
import { AdapterRegistry } from '../../runtime/src/adapter-registry.js';
import { AgentRuntimeCoordinator } from '../../runtime/src/agent-runtime-service.js';
import { reconcileSessionHandoffs } from '../../runtime/src/recovery-service.js';
import { SessionHandoffService, SessionHandoffServiceError } from '../../runtime/src/session-handoff-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  registerTemporaryDirectory,
  waitFor,
} from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

/** The provider pid/token the fake Adapter claims, so the ownership check has real inputs. */
const providerPid = 4242;
const providerStartToken = 'fake:provider:token';
/** A tool child the fake provider claimed while it was alive (the orphan-risk case). */
const toolChildPid = 4243;
const toolChildStartToken = 'fake:tool:token';

class ProcessIdentityFakeAdapter extends DeterministicFakeAdapter {
  override async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    const session = await super.start(request);
    return {
      ...session,
      processIdentity: {
        pid: providerPid,
        executable: 'fake-provider',
        startToken: providerStartToken,
        argvHash: 'fake-argv-hash',
        capturedAt: 1,
      },
    };
  }
}

/** A minimal provider-side client of the Runtime side channel, exactly like the gate extension. */
class TestProviderChannel {
  #buffer = '';
  readonly #commands: HandoffChannelCommand[] = [];
  readonly #waiters: (() => void)[] = [];

  private constructor(readonly socket: Socket) {}

  static async open(path: string, hello: Record<string, unknown> = {}): Promise<TestProviderChannel> {
    const socket = new Socket();
    const channel = new TestProviderChannel(socket);
    const connected = new Promise<void>((resolve, reject) => {
      socket.on('connect', () => { resolve(); });
      socket.on('error', reject);
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { channel.#consume(chunk); });
    socket.connect(path);
    await connected;
    channel.send({
      kind: 'hello',
      protocol: 1,
      mode: 'rpc',
      hasUI: false,
      permissionMode: 'STRICT',
      pid: providerPid,
      providerSessionId: 'fake:session',
      providerSessionFile: null,
      ...hello,
    });
    return channel;
  }

  send(frame: Readonly<Record<string, unknown>>): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  get commands(): readonly HandoffChannelCommand[] {
    return this.#commands;
  }

  async waitFor<T extends HandoffChannelCommand>(
    predicate: (command: HandoffChannelCommand) => boolean,
    timeoutMs = 5_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.#commands.find(predicate);
      if (found !== undefined) return found as T;
      await new Promise<void>((resolve) => { this.#waiters.push(resolve); });
    }
    throw new Error(`Timed out waiting for a side channel command; saw ${JSON.stringify(this.#commands)}`);
  }

  close(): void {
    try { this.socket.end(); } catch { /* already gone */ }
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    for (let index = this.#buffer.indexOf('\n'); index !== -1; index = this.#buffer.indexOf('\n')) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      this.#commands.push(JSON.parse(line) as HandoffChannelCommand);
      for (const waiter of this.#waiters.splice(0)) waiter();
    }
  }
}

interface Harness {
  readonly storage: Phase1Database;
  readonly service: SessionHandoffService;
  readonly sessionId: string;
  readonly projectId: string;
  readonly socketPath: string;
  readonly rows: {
    current: { pid: number; ppid: number; pgid: number; command: string }[];
    /** When set, the process table cannot be read at all (the "cannot verify" case). */
    fail: boolean;
  };
}

/** One running Task with a fake provider, plus the handoff service wired to a real socket. */
async function startHarness(): Promise<Harness> {
  const fixture = await createAgentFixture();
  const adapter = new ProcessIdentityFakeAdapter();
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const coordinator = new AgentRuntimeCoordinator({
    storage: fixture.storage,
    registry,
    runtimeHome: fixture.home,
  });
  const run = await coordinator.runTask({
    projectId: fixture.projectId,
    taskId: fixture.taskId,
    expectedTaskVersion: 1,
    commandId: crypto.randomUUID(),
    adapterId: 'fake',
  });
  const socketPath = join(fixture.home, 'session-handoff.sock');
  const rows: Harness['rows'] = {
    current: [
      { pid: providerPid, ppid: 1, pgid: providerPid, command: 'fake-provider --mode rpc' },
      { pid: toolChildPid, ppid: providerPid, pgid: toolChildPid, command: 'bash -c sleep 30' },
    ],
    fail: false,
  };
  const tokens = new Map<number, string>([
    [providerPid, providerStartToken],
    [toolChildPid, toolChildStartToken],
  ]);
  const service = new SessionHandoffService({
    storage: fixture.storage,
    runtimeHome: fixture.home,
    resolveAdapter: (adapterId) => registry.resolve(adapterId),
    permissionMode: () => 'STRICT',
    socketPath,
    // The window a frame may wait for the start transaction is exercised by the permission tests;
    // the refusal tests keep it short so a genuinely unknown provider is rejected quickly.
    channelResolutionTimeoutMs: 500,
    readProcessTable: async () => {
      if (rows.fail) throw new Error('ps is unavailable');
      return rows.current;
    },
    readStartToken: async (pid) => tokens.get(pid) ?? null,
  });
  service.listen();
  registerTemporaryDirectory(mkdtempSync(join(tmpdir(), 'codeestra-handoff-')));
  await service.recordAutomationIncarnation({ sessionId: run.sessionId });
  return {
    storage: fixture.storage,
    service,
    sessionId: run.sessionId,
    projectId: fixture.projectId,
    socketPath,
    rows,
  };
}

const statusOf = (harness: Harness) =>
  harness.service.status({ projectId: harness.projectId, sessionId: harness.sessionId });

/** The provider identity the fake Adapter recorded, which is what the channel must report. */
const openChannel = (harness: Harness, hello: Record<string, unknown> = {}) =>
  TestProviderChannel.open(harness.socketPath, {
    providerSessionId: `fake:${harness.sessionId}`,
    ...hello,
  });

describe('session handoff service', () => {
  test('records one automation incarnation, takes the lease, and refuses a second writer', async () => {
    const harness = await startHarness();
    try {
      const first = await harness.service.recordAutomationIncarnation({ sessionId: harness.sessionId });
      expect(first?.incarnationNumber).toBe(1);
      const status = statusOf(harness);
      expect(status.incarnations).toHaveLength(1);
      expect(status.incarnation?.mode).toBe('AUTOMATED_RPC');
      expect(status.incarnation?.state).toBe('ACTIVE');
      expect(status.incarnation?.providerPid).toBe(providerPid);
      expect(status.incarnation?.recordedDescendants).toBe(1);
      expect(status.writerLease?.holderKind).toBe('AUTOMATED_RPC');
      expect(status.capabilities).toMatchObject({
        singleWriterLease: 'IMPLEMENTED',
        strictPermissionOverSideChannel: 'IMPLEMENTED',
        nativeTerminalAttach: 'IMPLEMENTED',
        ptyTransport: 'IMPLEMENTED',
        successorProcessStart: 'IMPLEMENTED',
        releaseBackToAutomation: 'IMPLEMENTED',
        // Two different claims, reported separately: this Runtime can attach to a native terminal it
        // started, and still cannot attach to a running `pi --mode rpc` process.
        attachToLiveRpcProcess: 'UNSUPPORTED',
        crossHandoffPermissionModeMatrix: 'PARTIAL',
        parallelToolBatchSafePoint: 'UNVERIFIED',
        ptyResize: 'UNSUPPORTED',
        windows: 'UNSUPPORTED',
      });

      // A second holder never waits: it is told the Session already has a writer.
      let refused: unknown = null;
      try {
        harness.service.acquireWriterLease({
          projectId: harness.projectId,
          sessionId: harness.sessionId,
          holderKind: 'AUTOMATED_RPC',
          holderRef: 'another-client',
          commandId: crypto.randomUUID(),
        });
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(SessionHandoffServiceError);
      expect((refused as SessionHandoffServiceError).code).toBe('ATTACHMENT_BUSY');
      // The refusal names the holder, and the original lease is untouched.
      expect((refused as SessionHandoffServiceError).message).toContain('AUTOMATED_RPC');
      expect(statusOf(harness).writerLease?.holderRef).toBe(status.writerLease?.holderRef);

      const holderRef = status.writerLease?.holderRef as string;
      // The same holder re-acquiring is idempotent rather than a conflict.
      const again = harness.service.acquireWriterLease({
        projectId: harness.projectId,
        sessionId: harness.sessionId,
        holderKind: 'AUTOMATED_RPC',
        holderRef,
        commandId: crypto.randomUUID(),
      });
      expect(again.writerLease?.holderRef).toBe(holderRef);

      // Another holder cannot release what it does not own.
      expect(harness.service.releaseWriterLease({
        projectId: harness.projectId, sessionId: harness.sessionId, holderRef: 'another-client',
      })).toMatchObject({ released: false, code: 'HOLDER_MISMATCH' });
      expect(harness.service.releaseWriterLease({
        projectId: harness.projectId, sessionId: harness.sessionId, holderRef,
      })).toMatchObject({ released: true, code: 'RELEASED' });
      expect(statusOf(harness).writerLease).toBeNull();
    } finally {
      harness.service.close();
    }
  });

  test('replaying the same command ID does not create a second incarnation or lease', async () => {
    const harness = await startHarness();
    try {
      const commandId = `automation:${harness.sessionId}`;
      const record = (): Promise<unknown> =>
        harness.service.recordAutomationIncarnation({ sessionId: harness.sessionId });
      expect(await record()).not.toBeNull();
      expect(await record()).not.toBeNull();
      expect(harness.storage.listSessionIncarnations(harness.sessionId)).toHaveLength(1);
      expect(harness.storage.listSessionWriterLeases(harness.sessionId)).toHaveLength(1);

      // The same command ID through the storage primitive replays instead of inserting.
      const before = harness.storage.listSessionIncarnations(harness.sessionId)[0]!;
      const replayed = harness.storage.recordSessionIncarnation({
        id: crypto.randomUUID(),
        sessionId: harness.sessionId,
        mode: 'AUTOMATED_RPC',
        commandId,
        providerPid: null,
        processIdentity: null,
        processTree: null,
        providerSessionId: before.providerSessionId,
        sessionStorageRef: before.sessionStorageRef,
        createdAt: 999,
      });
      expect(replayed.replayed).toBe(true);
      expect(replayed.incarnation.id).toBe(before.id);
      expect(harness.storage.listSessionIncarnations(harness.sessionId)).toHaveLength(1);
    } finally {
      harness.service.close();
    }
  });

  test('carries one STRICT permission to an Attention and delivers a deny without hanging', async () => {
    const harness = await startHarness();
    const channel = await openChannel(harness);
    try {
      await channel.waitFor((command) => command.kind === 'welcome');
      const incarnation = statusOf(harness).incarnation!;
      channel.send({
        kind: 'permission_request',
        requestId: 'request-1',
        toolCallId: 'call-1',
        toolName: 'bash',
        inputJson: '{"command":"rm -rf build"}',
        inputFingerprint: 'sha256:deadbeef',
        mode: 'rpc',
      });
      await waitFor(() => harness.storage.listAttentionRequests(harness.projectId).length === 1);
      const attention = harness.storage.listAttentionRequests(harness.projectId)[0]!;
      expect(attention.kind).toBe('PERMISSION');
      expect(attention.responseType).toBe('CONFIRM');
      expect(attention.prompt).toMatchObject({
        kind: 'codeestra.permission',
        version: 1,
        toolName: 'bash',
        toolCallId: 'call-1',
        input: { command: 'rm -rf build' },
        inputFingerprint: 'sha256:deadbeef',
        incarnationId: incarnation.incarnationId,
        piMode: 'rpc',
      });
      expect(statusOf(harness).permission?.decision).toBe('OPEN');

      const answered = await harness.service.answerPermission({
        projectId: harness.projectId,
        attentionId: attention.id,
        commandId: crypto.randomUUID(),
        answer: { type: 'CONFIRM', confirmed: false },
        actor: 'local-user',
      });
      expect(answered.delivery).toBe('DELIVERED');
      expect(answered.decision).toBe('DENY');
      const decision = await channel.waitFor<Extract<HandoffChannelCommand, { kind: 'permission_decision' }>>(
        (command) => command.kind === 'permission_decision');
      expect(decision).toMatchObject({ decision: 'DENY', requestId: 'request-1' });
      // A denial is delivered, not retried, and it is never recorded as a successful run.
      expect(harness.storage.getAgentAnswerPlan(answered.operationId).operationState).toBe('SUCCEEDED');
      const execution = harness.storage.listTaskExecutions(harness.projectId, harness.storage
        .getAgentSessionIdentity(harness.sessionId)!.taskId)
        .find((candidate) => candidate.executionId === harness.storage
          .getAgentSessionIdentity(harness.sessionId)!.executionId);
      expect(execution?.state).toBe('RUNNING');
      expect(execution?.resultCommit).toBeNull();
    } finally {
      channel.close();
      harness.service.close();
    }
  });

  test('refuses a permission request it cannot record without killing the channel', async () => {
    const harness = await startHarness();
    const channel = await openChannel(harness);
    try {
      await channel.waitFor((command) => command.kind === 'welcome');
      channel.send({
        kind: 'permission_request', requestId: 'request-1', toolCallId: 'call-1', toolName: 'bash',
        inputJson: '{"command":"true"}', inputFingerprint: 'sha256:one', mode: 'rpc',
      });
      await waitFor(() => harness.storage.listAttentionRequests(harness.projectId).length === 1);
      // A second request arrives while the first Attention is still open, so the Session is
      // WAITING_FOR_USER and this call cannot become an Attention either.
      channel.send({
        kind: 'permission_request', requestId: 'request-2', toolCallId: 'call-2', toolName: 'bash',
        inputJson: '{"command":"true"}', inputFingerprint: 'sha256:two', mode: 'rpc',
      });
      const denied = await channel.waitFor<Extract<HandoffChannelCommand,
        { kind: 'permission_decision' }>>((command) => command.kind === 'permission_decision'
          && command.requestId === 'request-2');
      expect(denied.decision).toBe('DENY');
      expect(String(denied.reason)).toContain('could not record this permission request');
      // The channel survives: one unrecordable call is not "no approval channel" for the whole run.
      harness.service.requestHandoff({
        projectId: harness.projectId, sessionId: harness.sessionId,
        kind: 'TAKEOVER', commandId: crypto.randomUUID(),
      });
      const fence = await channel.waitFor<Extract<HandoffChannelCommand, { kind: 'fence' }>>(
        (command) => command.kind === 'fence');
      expect(fence.active).toBe(true);
    } finally {
      channel.close();
      harness.service.close();
    }
  });

  test('refuses a decision recorded for an incarnation that is no longer the writer', async () => {
    const harness = await startHarness();
    const channel = await openChannel(harness);
    try {
      await channel.waitFor((command) => command.kind === 'welcome');
      channel.send({
        kind: 'permission_request',
        requestId: 'request-late',
        toolCallId: 'call-late',
        toolName: 'write',
        inputJson: '{"path":"a.txt"}',
        inputFingerprint: 'sha256:late',
        mode: 'rpc',
      });
      await waitFor(() => harness.storage.listAttentionRequests(harness.projectId).length === 1);
      const attention = harness.storage.listAttentionRequests(harness.projectId)[0]!;
      const incarnation = statusOf(harness).incarnation!;
      const holderRef = statusOf(harness).writerLease!.holderRef;

      // The incarnation is superseded (a restart or a handoff): it stops being the current writer.
      harness.service.releaseWriterLease({
        projectId: harness.projectId, sessionId: harness.sessionId, holderRef,
      });
      harness.storage.markSessionIncarnationRecoveryRequired({
        incarnationId: incarnation.incarnationId,
        at: 5,
        detail: { code: 'RUNTIME_RESTARTED' },
      });

      const answered = await harness.service.answerPermission({
        projectId: harness.projectId,
        attentionId: attention.id,
        commandId: crypto.randomUUID(),
        answer: { type: 'CONFIRM', confirmed: true },
        actor: 'local-user',
      });
      expect(answered.delivery).toBe('NOT_DELIVERED');
      expect(answered.error?.code).toBe('STALE_INCARNATION');
      expect(answered.decision).toBe('STALE');
      // The recorded answer is failed, not left retryable, and nothing reached the provider.
      expect(answered.operationState).toBe('FAILED');
      expect(harness.storage.listAttentionRequests(harness.projectId)[0]?.status).toBe('STALE');
      await delay(50);
      expect(channel.commands.some((command) => command.kind === 'permission_decision')).toBe(false);
      // The stale answer cannot be recorded again either: the Attention is no longer open.
      expect(() => harness.storage.planAttentionAnswer({
        projectId: harness.projectId,
        attentionId: attention.id,
        commandId: crypto.randomUUID(),
        payloadHash: 'x',
        intentId: crypto.randomUUID(),
        answerId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        answer: { type: 'CONFIRM', confirmed: true },
        intentEventId: crypto.randomUUID(),
        recordedEventId: crypto.randomUUID(),
        actor: 'local-user',
        recordedAt: 6,
      })).toThrow();
    } finally {
      channel.close();
      harness.service.close();
    }
  });

  test('makes the incarnation check part of the claim, so two answers cannot both win', async () => {
    const harness = await startHarness();
    const channel = await openChannel(harness);
    try {
      await channel.waitFor((command) => command.kind === 'welcome');
      channel.send({
        kind: 'permission_request',
        requestId: 'request-race',
        toolCallId: 'call-race',
        toolName: 'bash',
        inputJson: '{"command":"true"}',
        inputFingerprint: 'sha256:race',
        mode: 'rpc',
      });
      await waitFor(() => harness.storage.listAttentionRequests(harness.projectId).length === 1);
      const attention = harness.storage.listAttentionRequests(harness.projectId)[0]!;
      const first = harness.storage.claimSessionPermissionDecision({
        attentionId: attention.id, claimedAt: 1,
      });
      const second = harness.storage.claimSessionPermissionDecision({
        attentionId: attention.id, claimedAt: 2,
      });
      expect(first.claimed).toBe(true);
      expect(second.claimed).toBe(false);
      expect(second.code).toBe('ALREADY_DECIDING');
    } finally {
      channel.close();
      harness.service.close();
    }
  });

  test('only hands over at a safe point, and only when the predecessor is proven quiescent', async () => {
    const harness = await startHarness();
    const channel = await openChannel(harness);
    try {
      await channel.waitFor((command) => command.kind === 'welcome');
      const requested = harness.service.requestHandoff({
        projectId: harness.projectId,
        sessionId: harness.sessionId,
        kind: 'TAKEOVER',
        commandId: crypto.randomUUID(),
      });
      expect(requested.handoff?.state).toBe('REQUESTED');
      expect(requested.safePoint.reached).toBe(false);
      const fence = await channel.waitFor<Extract<HandoffChannelCommand, { kind: 'fence' }>>(
        (command) => command.kind === 'fence');
      expect(fence.active).toBe(true);

      // Before the fence is acknowledged there is no safe point, and admission says so.
      expect((await harness.service.admitSuccessor({ projectId: harness.projectId, sessionId: harness.sessionId, commandId: crypto.randomUUID() })).code).toBe('SAFE_POINT_NOT_REACHED');

      channel.send({ kind: 'fence_ack', active: true });
      channel.send({ kind: 'tool_start', toolCallId: 'call-running', toolName: 'bash' });
      await waitFor(() => statusOf(harness).handoff?.state === 'FENCED');
      const duringTool = statusOf(harness);
      expect(duringTool.safePoint.activeTools).toBe(1);
      expect(duringTool.safePoint.reached).toBe(false);
      expect(duringTool.safePoint.missing.join(' ')).toContain('still running');
      // The Runtime never aborts the running tool; it only records facts about it.
      expect(channel.commands.some((command) =>
        JSON.stringify(command).includes('abort'))).toBe(false);

      channel.send({ kind: 'tool_end', toolCallId: 'call-running', toolName: 'bash', isError: false });
      channel.send({ kind: 'agent_settled' });
      await waitFor(() => statusOf(harness).handoff?.state === 'AT_SAFE_POINT');
      const atSafePoint = statusOf(harness);
      expect(atSafePoint.safePoint).toMatchObject({
        reached: true, fenceAcknowledged: true, activeTools: 0, settledAfterFence: true,
        openAttention: false,
      });

      // The recorded predecessor is still running: no successor may start.
      const alive = await harness.service.admitSuccessor({ projectId: harness.projectId, sessionId: harness.sessionId, commandId: crypto.randomUUID() });
      expect(alive).toMatchObject({ admitted: false, code: 'PREDECESSOR_NOT_STOPPED',
        predecessorObservation: 'ALIVE', successorStarted: false });

      // The provider is gone but the recorded tool child is still alive (the orphan case).
      harness.rows.current = harness.rows.current.filter((row) => row.pid !== providerPid);
      const orphan = await harness.service.admitSuccessor({ projectId: harness.projectId, sessionId: harness.sessionId, commandId: crypto.randomUUID() });
      expect(orphan).toMatchObject({ admitted: false, code: 'PREDECESSOR_DESCENDANTS_ALIVE',
        predecessorObservation: 'DESCENDANTS_ALIVE' });
      expect(orphan.detail).toContain(String(toolChildPid));

      // Nothing left in the recorded tree, but this service has no terminal transport: an admitted
      // handoff that cannot be carried out is refused, never reported as a started successor.
      harness.rows.current = [];
      const admitted = await harness.service.admitSuccessor({ projectId: harness.projectId, sessionId: harness.sessionId, commandId: crypto.randomUUID() });
      expect(admitted).toMatchObject({ admitted: false, code: 'TERMINAL_TRANSPORT_UNAVAILABLE',
        predecessorObservation: 'STOPPED', successorMode: 'HUMAN_TUI',
        successorStarted: false, terminalTransport: 'NONE', successorIncarnation: null });
      const after = statusOf(harness);
      // The predecessor is untouched: no incarnation was ended, no successor recorded, no lease moved.
      expect(after.handoff?.state).toBe('AT_SAFE_POINT');
      expect(after.incarnations).toHaveLength(1);
      expect(after.incarnation?.state).toBe('FENCED');
      expect(after.writerLease?.incarnationId).toBe(after.incarnation?.incarnationId);
      expect(after.lastPermission).toBeNull();
    } finally {
      channel.close();
      harness.service.close();
    }
  });

  test('refuses admission when process ownership cannot be verified at all', async () => {
    const harness = await startHarness();
    const channel = await openChannel(harness);
    try {
      await channel.waitFor((command) => command.kind === 'welcome');
      harness.service.requestHandoff({
        projectId: harness.projectId, sessionId: harness.sessionId,
        kind: 'TAKEOVER', commandId: crypto.randomUUID(),
      });
      await channel.waitFor((command) => command.kind === 'fence');
      channel.send({ kind: 'fence_ack', active: true });
      channel.send({ kind: 'agent_settled' });
      await waitFor(() => statusOf(harness).handoff?.state === 'AT_SAFE_POINT');
      // The provider tree was captured while the provider was alive; now the table itself is gone.
      harness.rows.fail = true;
      const admission = await harness.service.admitSuccessor({ projectId: harness.projectId, sessionId: harness.sessionId, commandId: crypto.randomUUID() });
      expect(admission).toMatchObject({ admitted: false, code: 'PREDECESSOR_UNVERIFIED',
        predecessorObservation: 'UNVERIFIABLE' });
      expect(admission.detail).toContain('process table');
    } finally {
      channel.close();
      harness.service.close();
    }
  });

  test('releases an abandoned fence so the Agent can use tools again', async () => {
    const harness = await startHarness();
    const channel = await openChannel(harness);
    try {
      await channel.waitFor((command) => command.kind === 'welcome');
      harness.service.requestHandoff({
        projectId: harness.projectId, sessionId: harness.sessionId,
        kind: 'TAKEOVER', commandId: crypto.randomUUID(),
      });
      await channel.waitFor((command) => command.kind === 'fence');
      channel.send({ kind: 'fence_ack', active: true });
      await waitFor(() => statusOf(harness).handoff?.state === 'FENCED');
      const cancelled = harness.service.cancelHandoff({
        projectId: harness.projectId, sessionId: harness.sessionId,
      });
      expect(cancelled.handoff?.state).toBe('CANCELLED');
      expect(cancelled.incarnation?.state).toBe('ACTIVE');
      const release = await channel.waitFor<Extract<HandoffChannelCommand, { kind: 'fence' }>>(
        (command) => command.kind === 'fence' && command.active === false);
      expect(release.active).toBe(false);
    } finally {
      channel.close();
      harness.service.close();
    }
  });

  test('reconciles a restart from recorded facts instead of restoring anything optimistically', async () => {
    const harness = await startHarness();
    const channel = await openChannel(harness);
    try {
      await channel.waitFor((command) => command.kind === 'welcome');
      channel.send({
        kind: 'permission_request',
        requestId: 'request-restart',
        toolCallId: 'call-restart',
        toolName: 'bash',
        inputJson: '{"command":"true"}',
        inputFingerprint: 'sha256:restart',
        mode: 'rpc',
      });
      await waitFor(() => harness.storage.listAttentionRequests(harness.projectId).length === 1);
      const attention = harness.storage.listAttentionRequests(harness.projectId)[0]!;
      harness.service.requestHandoff({
        projectId: harness.projectId, sessionId: harness.sessionId,
        kind: 'TAKEOVER', commandId: crypto.randomUUID(),
      });
      const before = statusOf(harness);
      expect(before.incarnation?.state).toBe('ACTIVE');
      expect(before.writerLease).not.toBeNull();

      const results = reconcileSessionHandoffs({ storage: harness.storage });
      expect(results).toHaveLength(1);
      const after = statusOf(harness);
      // Nothing is current any more: a decision cannot reach the process that asked.
      expect(after.incarnation).toBeNull();
      const latest = after.incarnations[after.incarnations.length - 1]!;
      expect(latest.state).toBe('RECOVERY_REQUIRED');
      expect(latest.exit).toMatchObject({ code: 'RUNTIME_RESTARTED' });
      expect(after.writerLease).toBeNull();
      expect(harness.storage.listSessionWriterLeases(harness.sessionId)[0]?.releaseReason)
        .toBe('RUNTIME_RESTARTED');
      expect(after.handoff?.state).toBe('RECOVERY_REQUIRED');
      expect(after.handoffHistory[0]?.state).toBe('RECOVERY_REQUIRED');
      expect(after.handoffHistory[0]?.fenceActive).toBe(false);
      // The open permission request can never be answered by the provider that asked.
      expect(harness.storage.getSessionPermissionRequest(attention.id)?.decision).toBe('STALE');
      expect(harness.storage.listAttentionRequests(harness.projectId)[0]?.status).toBe('STALE');
      // Reconcile is idempotent and does not resurrect anything.
      expect(reconcileSessionHandoffs({ storage: harness.storage })).toHaveLength(0);
    } finally {
      channel.close();
      harness.service.close();
    }
  });

  test('refuses to adopt a provider process whose incarnation it does not know', async () => {
    const harness = await startHarness();
    const channel = await openChannel(harness, { providerSessionId: 'fake:unknown-session' });
    try {
      await channel.waitFor((command) => command.kind === 'welcome');
      channel.send({ kind: 'agent_settled' });
      const rejected = await channel.waitFor<Extract<HandoffChannelCommand, { kind: 'rejected' }>>(
        (command) => command.kind === 'rejected');
      expect(rejected.code).toBe('SESSION_UNKNOWN');
      // Nothing was created for an unknown provider process.
      expect(harness.storage.listSessionIncarnations(harness.sessionId)).toHaveLength(1);
    } finally {
      channel.close();
      harness.service.close();
    }
  });
});
