import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import codeestraGate, {
  handoffFenceReason,
  sessionHandoffSocketPath,
  type HandoffChannelFrame,
} from '../src/pi-gate-extension.js';
import {
  captureProviderProcessTree,
  inspectProviderProcessOwnership,
} from '../src/pi-process.js';
import { readProcessStartToken } from '../src/pi-identity.js';

type GateResult = { block: true; reason: string; terminate: true } | undefined;
type GateHandler = (
  event: { toolName: string; toolCallId: string; input: unknown },
  context: { mode: string; hasUI: boolean;
    sessionManager?: { getSessionId(): string; getSessionFile(): string | null } },
) => Promise<GateResult>;

interface GateContextLike {
  readonly mode: string;
  readonly hasUI: boolean;
  readonly sessionManager?: { getSessionId(): string; getSessionFile(): string | null };
}

interface Captured {
  readonly toolCall: GateHandler;
  /** Fires one lifecycle/reporting event the gate registered. */
  readonly fire: (event: string, payload: Record<string, unknown>) => void;
}

/**
 * Captures the handlers the gate registers. The gate is the *provider* half of the Runtime side
 * channel, so these tests drive it against a real UNIX socket server instead of a mocked function.
 */
function captureGate(context: GateContextLike): Captured {
  let toolCall: GateHandler | undefined;
  const handlers = new Map<string, (payload: Record<string, unknown>) => void>();
  codeestraGate({
    on: (event: string, handler: unknown) => {
      if (event === 'tool_call') toolCall = handler as GateHandler;
      else {
        handlers.set(event, (payload) => {
          (handler as (event: unknown, ctx: unknown) => void)(payload, context);
        });
      }
    },
  } as unknown as Parameters<typeof codeestraGate>[0]);
  return {
    toolCall: toolCall as GateHandler,
    fire: (event, payload) => { handlers.get(event)?.(payload); },
  };
}

interface TestServer {
  readonly frames: HandoffChannelFrame[];
  readonly send: (record: Record<string, unknown>) => void;
  readonly closeConnections: () => void;
  readonly stop: () => void;
  readonly waitFor: <T extends HandoffChannelFrame>(
    predicate: (frame: HandoffChannelFrame) => boolean, timeoutMs?: number) => Promise<T>;
}

/** A real side channel endpoint: the Runtime half, in miniature. */
function startServer(socketPath: string): TestServer {
  const frames: HandoffChannelFrame[] = [];
  const waiters: (() => void)[] = [];
  const sockets = new Set<{ write: (value: string) => void; end: () => void }>();
  const listener = Bun.listen<{ buffer: string }>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = { buffer: '' };
        sockets.add({
          write: (value: string) => { socket.write(value); },
          end: () => { socket.end(); },
        });
      },
      data(socket, bytes) {
        socket.data.buffer += new TextDecoder().decode(bytes);
        for (let index = socket.data.buffer.indexOf('\n'); index !== -1;
          index = socket.data.buffer.indexOf('\n')) {
          const line = socket.data.buffer.slice(0, index);
          socket.data.buffer = socket.data.buffer.slice(index + 1);
          if (line.trim().length === 0) continue;
          frames.push(JSON.parse(line) as HandoffChannelFrame);
          for (const waiter of waiters.splice(0)) waiter();
        }
      },
      close() {},
      error() {},
    },
  });
  return {
    frames,
    send: (record) => {
      for (const socket of sockets) socket.write(`${JSON.stringify(record)}\n`);
    },
    closeConnections: () => { for (const socket of sockets) socket.end(); },
    stop: () => { listener.stop(true); for (const socket of sockets) socket.end(); },
    waitFor: async (predicate, timeoutMs = 5_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = frames.find(predicate);
        if (found !== undefined) return found as never;
        // The waiter is raced against a short sleep: a resolve is the fast path, and the sleep
        // keeps `timeoutMs` meaningful when no frame ever arrives.
        await Promise.race([
          new Promise<void>((resolve) => { waiters.push(resolve); }),
          Bun.sleep(20),
        ]);
      }
      throw new Error(`Timed out waiting for a side channel frame; saw ${JSON.stringify(frames)}`);
    },
  };
}

let directory = '';
let server: TestServer | null = null;
let socketPath = '';
let previousSocket: string | undefined;
let previousMode: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'codeestra-gate-'));
  socketPath = join(directory, 'session-handoff.sock');
  server = startServer(socketPath);
  previousSocket = process.env.CODEESTRA_HANDOFF_SOCKET;
  previousMode = process.env.CODEESTRA_PERMISSION_MODE;
  process.env.CODEESTRA_HANDOFF_SOCKET = socketPath;
});

afterEach(() => {
  server?.stop();
  server = null;
  rmSync(directory, { recursive: true, force: true });
  if (previousSocket === undefined) delete process.env.CODEESTRA_HANDOFF_SOCKET;
  else process.env.CODEESTRA_HANDOFF_SOCKET = previousSocket;
  if (previousMode === undefined) delete process.env.CODEESTRA_PERMISSION_MODE;
  else process.env.CODEESTRA_PERMISSION_MODE = previousMode;
});

/** The side channel endpoint of the current test; `beforeEach` always starts one. */
function sideChannel(): TestServer {
  if (server === null) throw new Error('No side channel server was started for this test');
  return server;
}

const sessionContext: GateContextLike = {
  mode: 'rpc',
  hasUI: false,
  sessionManager: {
    getSessionId: () => 'provider-session-1',
    getSessionFile: () => '/tmp/provider-session-1.jsonl',
  },
};

describe('Codeestra gate over the Runtime side channel', () => {
  test('finds the Runtime socket through CODEESTRA_HOME when no explicit path is set', () => {
    const environment = { CODEESTRA_HOME: '/tmp/ce-home' };
    expect(sessionHandoffSocketPath(environment)).toBe('/tmp/ce-home/session-handoff.sock');
    expect(sessionHandoffSocketPath({ ...environment, CODEESTRA_HANDOFF_SOCKET: '/tmp/explicit.sock' }))
      .toBe('/tmp/explicit.sock');
  });

  test('says hello once, then reports tool lifecycle and settled facts', async () => {
    const gate = captureGate(sessionContext);
    gate.fire('session_start', {});
    const hello = await sideChannel().waitFor<Extract<HandoffChannelFrame, { kind: 'hello' }>>(
      (frame) => frame.kind === 'hello');
    expect(hello).toMatchObject({
      protocol: 1,
      mode: 'rpc',
      pid: process.pid,
      providerSessionId: 'provider-session-1',
      providerSessionFile: '/tmp/provider-session-1.jsonl',
    });
    // The reporting events are facts about tools the Runtime needs for its safe point.
    gate.fire('tool_execution_start', { toolCallId: 'call-1', toolName: 'bash' });
    gate.fire('tool_execution_end', { toolCallId: 'call-1', toolName: 'bash', isError: true });
    gate.fire('agent_settled', {});
    await sideChannel().waitFor((frame) => frame.kind === 'tool_start');
    await sideChannel().waitFor((frame) => frame.kind === 'tool_end');
    await sideChannel().waitFor((frame) => frame.kind === 'agent_settled');
    expect(sideChannel().frames.filter((frame) => frame.kind === 'hello')).toHaveLength(1);
    expect(sideChannel().frames.find((frame) => frame.kind === 'tool_end')).toMatchObject({ isError: true });
  });

  test('full mode allows every tool without a confirmation or any permission frame', async () => {
    delete process.env.CODEESTRA_PERMISSION_MODE;
    const gate = captureGate(sessionContext);
    gate.fire('session_start', {});
    await sideChannel().waitFor((frame) => frame.kind === 'hello');
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(await gate.toolCall({ toolName: 'bash', toolCallId: 'call-1', input: circular },
      sessionContext)).toBeUndefined();
    expect(await gate.toolCall({ toolName: 'custom-danger', toolCallId: 'call-2', input: {} },
      sessionContext)).toBeUndefined();
    expect(sideChannel().frames.some((frame) => frame.kind === 'permission_request')).toBe(false);
  });

  test('strict mode asks the Runtime for a structured decision and honours it', async () => {
    process.env.CODEESTRA_PERMISSION_MODE = 'STRICT';
    const gate = captureGate(sessionContext);
    gate.fire('session_start', {});

    // A read-only tool never reaches the channel.
    expect(await gate.toolCall({ toolName: 'read', toolCallId: 'read-1', input: { path: 'a' } },
      sessionContext)).toBeUndefined();

    const pending = gate.toolCall({ toolName: 'bash', toolCallId: 'call-1',
      input: { command: 'rm -rf build' } }, sessionContext);
    const request = await sideChannel().waitFor<Extract<HandoffChannelFrame, { kind: 'permission_request' }>>(
      (frame) => frame.kind === 'permission_request');
    expect(request.toolName).toBe('bash');
    expect(request.toolCallId).toBe('call-1');
    expect(JSON.parse(request.inputJson)).toEqual({ command: 'rm -rf build' });
    expect(request.inputFingerprint.startsWith('sha256:')).toBe(true);
    expect(request.mode).toBe('rpc');

    sideChannel().send({ kind: 'welcome', fenceActive: false });
    sideChannel().send({ kind: 'permission_decision', requestId: request.requestId,
      decision: 'ALLOW', reason: null });
    expect(await pending).toBeUndefined();
    expect(sideChannel().frames.filter((frame) => frame.kind === 'permission_request')).toHaveLength(1);
  });

  test('a denied or cancelled request becomes a terminating block, never a hang', async () => {
    process.env.CODEESTRA_PERMISSION_MODE = 'STRICT';
    const gate = captureGate(sessionContext);
    gate.fire('session_start', {});
    const denied = gate.toolCall({ toolName: 'write', toolCallId: 'write-1',
      input: { path: 'a.txt' } }, sessionContext);
    const first = await sideChannel().waitFor<Extract<HandoffChannelFrame, { kind: 'permission_request' }>>(
      (frame) => frame.kind === 'permission_request');
    sideChannel().send({ kind: 'permission_decision', requestId: first.requestId, decision: 'DENY',
      reason: null });
    expect(await denied).toMatchObject({ block: true, terminate: true,
      reason: 'Codeestra permission denied by user' });

    const cancelled = gate.toolCall({ toolName: 'bash', toolCallId: 'bash-1',
      input: { command: 'true' } }, sessionContext);
    const second = await sideChannel().waitFor<Extract<HandoffChannelFrame, { kind: 'permission_request' }>>(
      (frame) => frame.kind === 'permission_request' && frame.toolCallId === 'bash-1');
    sideChannel().send({ kind: 'permission_decision', requestId: second.requestId, decision: 'CANCEL',
      reason: 'user cancelled' });
    expect(await cancelled).toMatchObject({ block: true, terminate: true });
  });

  test('surfaces the Runtime own refusal reason instead of blaming the user', async () => {
    process.env.CODEESTRA_PERMISSION_MODE = 'STRICT';
    const gate = captureGate(sessionContext);
    gate.fire('session_start', {});
    const pending = gate.toolCall({ toolName: 'bash', toolCallId: 'call-refused',
      input: { command: 'true' } }, sessionContext);
    const request = await sideChannel().waitFor<Extract<HandoffChannelFrame, { kind: 'permission_request' }>>(
      (frame) => frame.kind === 'permission_request');
    // A refusal the Runtime made for its own reason (not a user decision) must say so, because the
    // transcript is read by a human and by the model.
    sideChannel().send({ kind: 'permission_decision', requestId: request.requestId,
      decision: 'DENY', reason: 'Codeestra could not record this permission request: not active' });
    const blocked = await pending;
    expect(blocked).toMatchObject({ block: true, terminate: true });
    expect(blocked?.reason).toContain('could not record this permission request');
    expect(blocked?.reason).not.toContain('denied by user');
  });

  test('a decision the Runtime never sends fails closed instead of allowing the tool', async () => {
    process.env.CODEESTRA_PERMISSION_MODE = 'STRICT';
    const gate = captureGate(sessionContext);
    gate.fire('session_start', {});
    const blocked = gate.toolCall({ toolName: 'edit', toolCallId: 'edit-1', input: { path: 'a' } },
      sessionContext);
    await sideChannel().waitFor((frame) => frame.kind === 'permission_request');
    // The Runtime dies while the provider waits: the gate must not guess an approval.
    sideChannel().closeConnections();
    expect(await blocked).toMatchObject({ block: true, terminate: true });
    expect((await blocked)?.reason).toContain('without its Runtime permission channel');
  });

  test('reconnects after the Runtime went away instead of staying fail-closed forever', async () => {
    process.env.CODEESTRA_PERMISSION_MODE = 'STRICT';
    // Each fail-closed window is bounded; a short one keeps this test quick without changing what
    // is asserted (a later tool call re-dials and is answered again).
    process.env.CODEESTRA_HANDOFF_CONNECT_MS = '500';
    const gate = captureGate(sessionContext);
    gate.fire('session_start', {});
    await sideChannel().waitFor((frame) => frame.kind === 'hello');
    const helloBefore = sideChannel().frames.filter((frame) => frame.kind === 'hello').length;

    // The Runtime stops (or restarts) while the Agent keeps running. A tool call in the window
    // where the loss is not noticed yet is refused; a later one dials again.
    sideChannel().closeConnections();
    const deadline = Date.now() + 20_000;
    let request: Extract<HandoffChannelFrame, { kind: 'permission_request' }> | null = null;
    let blocked: GateResult | null = null;
    let pending: Promise<GateResult> | null = null;
    let attempt = 0;
    while (request === null && Date.now() < deadline) {
      const toolCallId = `call-reconnect-${attempt}`;
      attempt += 1;
      pending = gate.toolCall({ toolName: 'bash', toolCallId, input: { command: 'true' } },
        sessionContext);
      request = await Promise.race([
        sideChannel().waitFor<Extract<HandoffChannelFrame, { kind: 'permission_request' }>>(
          (frame) => frame.kind === 'permission_request' && frame.toolCallId === toolCallId, 2_000)
          .catch(() => null),
        pending.then((result) => { blocked = result ?? null; return null; }),
      ]);
      if (request === null) await Bun.sleep(50);
    }
    expect(request).not.toBeNull();
    // The re-dial is a real new connection, not a reused dead socket.
    expect(sideChannel().frames.filter((frame) => frame.kind === 'hello').length)
      .toBeGreaterThan(helloBefore);
    sideChannel().send({ kind: 'permission_decision',
      requestId: (request as Extract<HandoffChannelFrame, { kind: 'permission_request' }>).requestId,
      decision: 'ALLOW', reason: null });
    expect(await (pending as Promise<GateResult>)).toBeUndefined();
    expect(blocked).toBeNull();
    delete process.env.CODEESTRA_HANDOFF_CONNECT_MS;
  }, 30_000);

  test('the handoff fence blocks new tools and is acknowledged as a structured fact', async () => {
    process.env.CODEESTRA_PERMISSION_MODE = 'STRICT';
    const gate = captureGate(sessionContext);
    gate.fire('session_start', {});
    await sideChannel().waitFor((frame) => frame.kind === 'hello');
    sideChannel().send({ kind: 'welcome', fenceActive: false });
    sideChannel().send({ kind: 'fence', active: true });
    await sideChannel().waitFor((frame) => frame.kind === 'fence_ack' && frame.active === true);

    // Even a tool that would need approval is stopped by the fence, and no request is sent: the
    // fence is a handoff correctness control, not an approval.
    const before = sideChannel().frames.length ?? 0;
    expect(await gate.toolCall({ toolName: 'bash', toolCallId: 'after-fence',
      input: { command: 'echo after-fence' } }, sessionContext))
      .toMatchObject({ block: true, terminate: true, reason: handoffFenceReason });
    expect(sideChannel().frames.slice(before).some((frame) => frame.kind === 'permission_request')).toBe(false);

    // Releasing the fence lets the same tool be asked about again.
    sideChannel().send({ kind: 'fence', active: false });
    await sideChannel().waitFor((frame) => frame.kind === 'fence_ack' && frame.active === false);
    const pending = gate.toolCall({ toolName: 'bash', toolCallId: 'after-release',
      input: { command: 'echo ok' } }, sessionContext);
    const request = await sideChannel().waitFor<Extract<HandoffChannelFrame, { kind: 'permission_request' }>>(
      (frame) => frame.kind === 'permission_request' && frame.toolCallId === 'after-release');
    sideChannel().send({ kind: 'permission_decision', requestId: request.requestId, decision: 'ALLOW',
      reason: null });
    expect(await pending).toBeUndefined();
  });

  test('an unknown tool is rejected without asking the Runtime', async () => {
    process.env.CODEESTRA_PERMISSION_MODE = 'STRICT';
    const gate = captureGate(sessionContext);
    expect(await gate.toolCall({ toolName: 'custom-danger', toolCallId: 'call-1', input: {} },
      sessionContext)).toMatchObject({ block: true, terminate: true,
      reason: 'Codeestra rejected unknown tool: custom-danger' });
  });
});

describe('provider process ownership evidence', () => {
  test('finds a recorded tool child that outlived a killed provider, then clears it when it is gone', async () => {
    // The provider shape FOUNDATION-040 measured: a tool child that keeps running after the
    // provider is killed. The Runtime must be able to say so before it starts a successor.
    const provider = Bun.spawn(['bash', '-c', 'sleep 30 & sleep 60'], { stdout: 'pipe', stderr: 'pipe' });
    const descendants: number[] = [];
    try {
      const startToken = await readProcessStartToken(provider.pid);
      expect(typeof startToken).toBe('string');
      let tree = await captureProviderProcessTree({ pid: provider.pid, startToken: startToken as string });
      const deadline = Date.now() + 5_000;
      while (tree.descendants.length === 0 && Date.now() < deadline) {
        await Bun.sleep(50);
        tree = await captureProviderProcessTree({ pid: provider.pid, startToken: startToken as string });
      }
      expect(tree.descendants.length).toBeGreaterThan(0);
      for (const descendant of tree.descendants) descendants.push(descendant.pid);

      provider.kill('SIGKILL');
      await provider.exited;
      const alive = await inspectProviderProcessOwnership({ tree });
      expect(alive.state).toBe('DESCENDANTS_ALIVE');
      if (alive.state === 'DESCENDANTS_ALIVE') {
        expect(alive.descendants.length).toBeGreaterThan(0);
        expect(alive.detail).toContain('still running');
      }

      // Only after the recorded descendants are gone may the tree be reported as quiescent.
      for (const pid of descendants) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* it already exited. */ }
      }
      const cleared = await inspectProviderProcessOwnership({ tree });
      expect(cleared).toMatchObject({ state: 'STOPPED' });
    } finally {
      try { provider.kill('SIGKILL'); } catch { /* already gone. */ }
      for (const pid of descendants) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited. */ }
      }
    }
  }, 20_000);

  test('reports an unreadable process table as unverifiable instead of assuming quiescence', async () => {
    const observation = await inspectProviderProcessOwnership({
      tree: { pid: 999_999, startToken: 'token', pgid: null, descendants: [], capturedAt: 0,
        note: 'test' },
      readTable: async () => { throw new Error('ps is unavailable'); },
    });
    expect(observation).toMatchObject({ state: 'UNVERIFIABLE' });
    expect(observation.detail).toContain('process table');
  });

  test('does not attribute a reused PID to the recorded provider', async () => {
    // The recorded provider PID is now occupied by an unrelated process with a different start
    // token, and the recorded descendant is gone: the tree is quiescent, not "alive".
    const observation = await inspectProviderProcessOwnership({
      tree: { pid: process.pid, startToken: 'a-token-from-another-lifetime', pgid: null,
        descendants: [{ pid: 999_999, startToken: 'gone', command: 'bash' }], capturedAt: 0,
        note: 'test' },
    });
    expect(observation).toMatchObject({ state: 'STOPPED' });
  });
});
