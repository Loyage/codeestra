import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiPtyTerminal, terminalReleaseByte, terminalTransportProtocol } from '../src/pi-pty.js';
import { readPiSessionFileFacts } from '../src/pi-session-file.js';
import codeestraGate, { handoffFenceReason, type HandoffChannelFrame }
  from '../src/pi-gate-extension.js';

/**
 * The PTY transport is tested with a *fake provider* (a small shell or Bun program), because these
 * assertions are about the transport itself: whether the provider really gets a terminal, whether
 * its byte stream is projected with a cursor, and whether its exit is an observed fact. The real Pi
 * TUI's rendering on this transport is a user-visible check that this lane cannot make for itself
 * (documented in `docs/tasks/README.md`).
 */
const directories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fakeProvider(script: string): string {
  const directory = temporaryDirectory('codeestra-pty-tools-');
  const path = join(directory, 'provider.ts');
  writeFileSync(path, script);
  const shim = join(directory, 'provider');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path}" "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

function environment(): Record<string, string> {
  return { PATH: process.env.PATH ?? '/bin:/usr/bin', HOME: process.env.HOME ?? '/tmp' };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(20);
  }
  return predicate();
}

/** The stable code of a refusal, so the assertion is about the code and not about prose. */
async function refusalCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'NO_ERROR';
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code) : `NO_CODE: ${String(error)}`;
  }
}

type ToolCallHandler = (
  event: { toolName: string; toolCallId: string; input: unknown },
  context: unknown,
) => Promise<{ block: true; reason: string; terminate: true } | undefined>;

describe('PTY transport (ADR-0026)', () => {
  test('runs the provider on a real terminal and projects its byte stream with a cursor', async () => {
    const provider = fakeProvider(`
      process.stdout.write('isatty=' + (process.stdout.isTTY === true ? 'yes' : 'no') + '\\n');
      process.stdout.write('tty=' + Bun.spawnSync(['tty'], { stdio: ['inherit', 'pipe', 'pipe'] })
        .stdout.toString().trim() + '\\n');
      process.stdout.write('size=' + Bun.spawnSync(['stty', 'size'], { stdio: ['inherit', 'pipe', 'pipe'] })
        .stdout.toString().trim() + '\\n');
      const decoder = new TextDecoder();
      for await (const chunk of Bun.stdin.stream()) {
        const text = decoder.decode(chunk);
        process.stdout.write('echo:' + text.replace(/\\r?\\n$/, '') + '\\n');
        if (text.includes('\\u0004') || text.includes('bye')) break;
      }
      process.exit(9);
    `);
    const terminal = await PiPtyTerminal.launch({
      argv: [provider], cwd: temporaryDirectory('codeestra-pty-cwd-'), env: environment(),
      cols: 100, rows: 30,
    });
    try {
      expect(terminal.providerPid).toBeGreaterThan(0);
      expect(terminal.helperPid).toBeGreaterThan(0);
      expect(terminal.slavePath.startsWith('/dev/')).toBe(true);
      // The window size is applied through the terminal's own interface; if it cannot be applied the
      // transport reports that instead of pretending a size.
      expect(terminal.windowSize).toBe('APPLIED');
      const startup = await waitFor(() => terminal.outputSince(0).data.includes('size='));
      expect(startup).toBe(true);
      const first = terminal.outputSince(0);
      // The provider really is on a terminal (not a pipe), and the size the host applied is the size
      // the provider reads from its own side.
      expect(first.data).toContain('isatty=yes');
      expect(first.data).toContain('size=30 100');
      expect(first.truncated).toBe(false);
      expect(first.cursor).toBeGreaterThan(0);

      // Writing is terminal input: the provider reads it from its own stdin.
      terminal.write('hello-pty\n');
      expect(await waitFor(() => terminal.outputSince(0).data.includes('echo:hello-pty'))).toBe(true);

      // The cursor is monotonic, and an incremental read returns only what arrived after it.
      const cursor = terminal.outputSince(0).cursor;
      expect(terminal.outputSince(cursor).data).toBe('');
      terminal.write('second\n');
      expect(await waitFor(() => terminal.outputSince(cursor).data.includes('echo:second'))).toBe(true);
      const incremental = terminal.outputSince(cursor);
      expect(incremental.data).not.toContain('isatty=yes');

      // The explicit release byte ends the provider; the exit is an observed fact (code included).
      terminal.write(terminalReleaseByte);
      const exit = await terminal.waitForExit(10_000);
      expect(exit).not.toBeNull();
      expect(exit?.code).toBe(9);
      expect(terminal.snapshot().truncated).toBe(false);
    } finally {
      await terminal.stop({ graceMs: 2_000 });
    }
  }, 40_000);

  test('changes the terminal window size through the transport and reports the transport protocol', async () => {
    // The provider reads its own geometry from its own terminal, so the assertion is about the real
    // PTY and not about the helper's exit code. `stty size` inside the provider is what an
    // interactive TUI's reflow reads too.
    const provider = fakeProvider(`
      const size = () => Bun.spawnSync(['stty', 'size'], { stdio: ['inherit', 'pipe', 'pipe'] })
        .stdout.toString().trim();
      process.stdout.write('size=' + size() + '\\n');
      const decoder = new TextDecoder();
      for await (const chunk of Bun.stdin.stream()) {
        const text = decoder.decode(chunk);
        if (text.includes('SIZE?')) process.stdout.write('size=' + size() + '\\n');
        if (text.includes('\\u0004')) break;
      }
      process.exit(0);
    `);
    const terminal = await PiPtyTerminal.launch({
      argv: [provider], cwd: temporaryDirectory('codeestra-pty-cwd-'), env: environment(),
      cols: 100, rows: 30,
    });
    try {
      // The transport version is negotiated, not assumed: the helper echoed the requested protocol.
      expect(terminal.transportProtocol).toBe(terminalTransportProtocol);
      expect(await waitFor(() => terminal.outputSince(0).data.includes('size=30 100'))).toBe(true);
      // Nothing has been resized yet, so the transport cannot state a current geometry.
      expect(terminal.size).toBeNull();

      const resized = await terminal.resize({ cols: 99, rows: 33 });
      expect(resized).toEqual({ cols: 99, rows: 33, applied: 'APPLIED', detail: 'stty' });
      expect(terminal.size).toEqual({ cols: 99, rows: 33 });
      // The provider reads the new geometry from its own descriptor: the terminal really changed.
      const cursor = terminal.outputSince(0).cursor;
      terminal.write('SIZE?\n');
      expect(await waitFor(() => terminal.outputSince(cursor).data.includes('size=33 99'))).toBe(true);

      // A second resize is applied too, so this is not a one-shot launch-time setting.
      expect((await terminal.resize({ cols: 40, rows: 12 })).applied).toBe('APPLIED');
      const second = terminal.outputSince(0).cursor;
      terminal.write('SIZE?\n');
      expect(await waitFor(() => terminal.outputSince(second).data.includes('size=12 40'))).toBe(true);

      // An out-of-range size is refused before anything is sent: no partial terminal state.
      expect(await refusalCode(terminal.resize({ cols: 0, rows: 40 }))).toBe('INVALID_WINDOW_SIZE');
      expect(await refusalCode(terminal.resize({ cols: 1001, rows: 40 }))).toBe('INVALID_WINDOW_SIZE');
      expect(await refusalCode(terminal.resize({ cols: 10.5, rows: 40 }))).toBe('INVALID_WINDOW_SIZE');
      expect(terminal.size).toEqual({ cols: 40, rows: 12 });

      // After the provider exits, a resize is refused as an exited terminal instead of a guess.
      terminal.write(terminalReleaseByte);
      expect(await terminal.waitForExit(10_000)).not.toBeNull();
      expect(await refusalCode(terminal.resize({ cols: 50, rows: 20 }))).toBe('TERMINAL_EXITED');
    } finally {
      await terminal.stop({ graceMs: 2_000 });
    }
  }, 40_000);

  test('keeps running while no client is attached, and reports a stale cursor instead of a hole', async () => {
    const provider = fakeProvider(`
      let counter = 0;
      const timer = setInterval(() => {
        counter += 1;
        process.stdout.write('tick-' + counter + '\\n');
      }, 50);
      const decoder = new TextDecoder();
      for await (const chunk of Bun.stdin.stream()) {
        if (decoder.decode(chunk).includes('\\u0004')) break;
      }
      clearInterval(timer);
      process.exit(0);
    `);
    const terminal = await PiPtyTerminal.launch({
      argv: [provider], cwd: temporaryDirectory('codeestra-pty-cwd-'), env: environment(),
      bufferBytes: 64,
    });
    try {
      expect(await waitFor(() => terminal.snapshot().projectedBytes > 200)).toBe(true);
      // Nothing was read for a while and the bounded buffer dropped the beginning: a client asking
      // for that cursor is told the read was truncated, never handed a silent gap.
      const stale = terminal.outputSince(0);
      expect(stale.truncated).toBe(true);
      expect(stale.data.length).toBeGreaterThan(0);
      expect(terminal.snapshot().truncated).toBe(true);
      // A "detached" period is just not reading: the provider keeps producing output.
      const before = terminal.snapshot().projectedBytes;
      await Bun.sleep(200);
      expect(terminal.snapshot().projectedBytes).toBeGreaterThan(before);
      terminal.write(terminalReleaseByte);
      expect(await terminal.waitForExit(10_000)).not.toBeNull();
    } finally {
      await terminal.stop({ graceMs: 2_000 });
    }
  }, 40_000);

  test('terminates the provider when the Runtime that owns the terminal goes away', async () => {
    const provider = fakeProvider(`
      const decoder = new TextDecoder();
      for await (const chunk of Bun.stdin.stream()) {
        if (decoder.decode(chunk).includes('\\u0004')) break;
      }
      process.exit(0);
    `);
    const terminal = await PiPtyTerminal.launch({
      argv: [provider], cwd: temporaryDirectory('codeestra-pty-cwd-'), env: environment(),
    });
    const providerPid = terminal.providerPid;
    // This is what a Runtime crash looks like from the helper's side: the control pipe closes. The
    // helper must not leave an unowned provider running in the user's workspace.
    terminal.closeControl();
    expect(await waitFor(() => !isAlive(providerPid), 10_000)).toBe(true);
    const exit = await terminal.waitForExit(5_000);
    expect(exit).not.toBeNull();
    await terminal.stop({ graceMs: 2_000 });
  }, 40_000);

  test('reports a provider exit it observed, and records the exit code as data only', async () => {
    const provider = fakeProvider(`
      const decoder = new TextDecoder();
      for await (const chunk of Bun.stdin.stream()) {
        if (decoder.decode(chunk).includes('\\u0004')) break;
      }
      process.stdout.write('releasing\\n');
      process.exit(0);
    `);
    const terminal = await PiPtyTerminal.launch({
      argv: [provider], cwd: temporaryDirectory('codeestra-pty-cwd-'), env: environment(),
    });
    try {
      // Ownership evidence is captured while the provider is alive; after it exits its children are
      // reparented and their lineage to this Session is no longer visible.
      const tree = await terminal.captureTree();
      expect(tree).not.toBeNull();
      terminal.write(terminalReleaseByte);
      const exit = await terminal.waitForExit(10_000);
      expect(exit?.code).toBe(0);
      // The ownership observation is the fact a handoff must use; a zero exit code alone proves
      // nothing (FOUNDATION-040 measured Ctrl+D and SIGTERM both exiting 0).
      if (tree !== null) {
        const ownership = await neverResolvesUntil(terminal, tree);
        expect(ownership).toBe('STOPPED');
      }
    } finally {
      await terminal.stop({ graceMs: 2_000 });
    }
  }, 40_000);

  test('reports a live tool child as a descendant, not as a stopped provider', async () => {
    const marker = temporaryDirectory('codeestra-pty-orphan-');
    const provider = fakeProvider(`
      const { spawn } = await import('node:child_process');
      // A tool the provider started, launched so that it survives the terminal's own teardown (a
      // tool that ignores SIGHUP, or one in its own session — FOUNDATION-040 measured exactly this:
      // the child is reparented and keeps writing the workspace).
      spawn('nohup', ['bash', '-c',
        'sleep 3; echo done > ${join(marker, 'sentinel.txt')} # C2ORPHANMARK'], {
        stdio: 'ignore',
      });
      const decoder = new TextDecoder();
      for await (const chunk of Bun.stdin.stream()) {
        if (decoder.decode(chunk).includes('\\u0004')) break;
      }
      process.exit(0);
    `);
    const terminal = await PiPtyTerminal.launch({
      argv: [provider], cwd: temporaryDirectory('codeestra-pty-cwd-'), env: environment(),
    });
    try {
      // Capture the tree while the provider is alive; the tool child appears a moment after launch,
      // which is exactly why the tree is refreshed rather than captured once.
      let tree = await terminal.captureTree();
      for (let attempt = 0; attempt < 60; attempt += 1) {
        tree = await terminal.captureTree();
        // The helper is a descendant of itself? No: the walk starts at the helper, so a complete
        // capture contains the provider *and* the tool child it started.
        if ((tree?.descendants.length ?? 0) >= 2) break;
        await Bun.sleep(50);
      }
      expect((tree?.descendants.length ?? 0)).toBeGreaterThanOrEqual(2);
      terminal.signal('SIGKILL');
      expect(await terminal.waitForExit(10_000)).not.toBeNull();
      const ownership = await terminal.inspectOwnership(tree);
      // The provider is gone but its tool child is not: a successor must not be started here, and
      // the observation says exactly which pids are still alive.
      expect(ownership.state).toBe('DESCENDANTS_ALIVE');
      // The orphan really keeps writing the workspace (the reason the check must exist at all).
      const sentinel = join(marker, 'sentinel.txt');
      expect(await waitFor(() => existsSync(sentinel), 10_000)).toBe(true);
    } finally {
      await terminal.stop({ graceMs: 2_000 });
    }
  }, 40_000);

  test('reads provider session-file facts, including a bounded prefix read', async () => {
    const directory = temporaryDirectory('codeestra-pty-session-');
    const file = join(directory, 'session.jsonl');
    const entries = [
      { type: 'session', id: 'entry-1' },
      { type: 'message', id: 'entry-2' },
      { type: 'message', id: 'entry-3' },
    ];
    writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    const facts = await readPiSessionFileFacts({ file, collectEntryIds: true });
    expect(facts).toMatchObject({ exists: true, entryCount: 3, lastEntryId: 'entry-3',
      truncated: false, unparsableLines: 0 });
    expect(facts.entryIds).toEqual(['entry-1', 'entry-2', 'entry-3']);
    const prefix = await readPiSessionFileFacts({ file, maxBytes: 40 });
    expect(prefix.truncated).toBe(true);
    expect(prefix.entryCount).toBeLessThan(3);
    const missing = await readPiSessionFileFacts({ file: join(directory, 'nope.jsonl') });
    expect(missing.exists).toBe(false);
  }, 20_000);

  test('drives the production gate in native-terminal mode over a real side channel', async () => {
    // The gate extension is the provider half of the Runtime side channel. FOUNDATION-043 measured
    // it in RPC mode only; a handoff puts it in a native terminal, so the same contract is driven
    // here with `mode: 'tui'` against a real UNIX socket.
    const directory = temporaryDirectory('codeestra-pty-gate-');
    const socketPath = join(directory, 'session-handoff.sock');
    const frames: HandoffChannelFrame[] = [];
    let command: ((record: Record<string, unknown>) => void) | null = null;
    // TS narrows a closure-assigned `let` to null, so the send path reads it through a helper.
    const send = (record: Record<string, unknown>): void => {
      const sendFrame = command as ((frame: Record<string, unknown>) => void) | null;
      if (sendFrame !== null) sendFrame(record);
    };
    const listener = Bun.listen<{ buffer: string }>({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.data = { buffer: '' };
          command = (record) => { socket.write(`${JSON.stringify(record)}\n`); };
        },
        data(socket, bytes) {
          socket.data.buffer += new TextDecoder().decode(bytes);
          for (let index = socket.data.buffer.indexOf('\n'); index !== -1;
            index = socket.data.buffer.indexOf('\n')) {
            const line = socket.data.buffer.slice(0, index);
            socket.data.buffer = socket.data.buffer.slice(index + 1);
            if (line.trim().length === 0) continue;
            frames.push(JSON.parse(line) as HandoffChannelFrame);
          }
        },
      },
    });
    process.env['CODEESTRA_HANDOFF_SOCKET'] = socketPath;
    process.env['CODEESTRA_PERMISSION_MODE'] = 'STRICT';
    const handlers = new Map<string, (event: unknown, context: unknown) => void>();
    let toolCall: ToolCallHandler | undefined;
    codeestraGate({
      on: (event: string, handler: unknown) => {
        if (event === 'tool_call') toolCall = handler as ToolCallHandler;
        else handlers.set(event, handler as (event: unknown, context: unknown) => void);
      },
    } as never);
    const context = { mode: 'tui', hasUI: true,
      sessionManager: { getSessionId: () => 'tui-session', getSessionFile: () => '/tmp/tui.jsonl' } };
    try {
      handlers.get('session_start')?.({}, context);
      expect(await waitFor(() => frames.some((frame) => frame.kind === 'hello'))).toBe(true);
      const hello = frames.find((frame) => frame.kind === 'hello');
      expect(hello).toMatchObject({ kind: 'hello', mode: 'tui', permissionMode: 'STRICT',
        pid: process.pid, providerSessionId: 'tui-session',
        providerSessionFile: '/tmp/tui.jsonl' });
      send({ kind: 'welcome', fenceActive: false });
      await Bun.sleep(50);

      // In native-terminal mode a STRICT tool call is decided on the Runtime side channel, exactly
      // as in RPC mode: one channel, one decision, no second prompt in the terminal.
      const pending = (toolCall as ToolCallHandler)({ toolName: 'bash', toolCallId: 'tui-call-1',
        input: { command: 'echo tui' } }, context);
      expect(await waitFor(() => frames.some((frame) => frame.kind === 'permission_request'))).toBe(true);
      const request = frames.find((frame) => frame.kind === 'permission_request');
      send({ kind: 'permission_decision', requestId: (request as { requestId: string }).requestId,
        decision: 'ALLOW', reason: null });
      expect(await pending).toBeUndefined();

      // The fence is a handoff correctness control, not a permission gate: it blocks new tools and
      // never asks the user for approval.
      send({ kind: 'fence', active: true });
      expect(await waitFor(() => frames.some((frame) => frame.kind === 'fence_ack'))).toBe(true);
      const blocked = await (toolCall as ToolCallHandler)(
        { toolName: 'read', toolCallId: 'tui-call-2', input: {} }, context);
      expect(blocked).toMatchObject({ block: true, terminate: true, reason: handoffFenceReason });
      expect(frames.filter((frame) => frame.kind === 'permission_request')).toHaveLength(1);
    } finally {
      listener.stop(true);
      delete process.env['CODEESTRA_HANDOFF_SOCKET'];
      delete process.env['CODEESTRA_PERMISSION_MODE'];
    }
  }, 40_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits for the recorded tree to settle into a stable observation. */
async function neverResolvesUntil(
  terminal: PiPtyTerminal,
  tree: Parameters<PiPtyTerminal['inspectOwnership']>[0],
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const observation = await terminal.inspectOwnership(tree);
    if (observation.state !== 'ALIVE') return observation.state;
    await Bun.sleep(20);
  }
  return 'ALIVE';
}
