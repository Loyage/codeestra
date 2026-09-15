/**
 * PTY transport for a native provider terminal (FOUNDATION-046 / ADR-0026).
 *
 * FOUNDATION-040 measured that Pi's native TUI can be resumed from a durable session file
 * (`pi --session <file>`) inside a real PTY, and that a stdout pipe cannot stand in for a terminal.
 * This module is the Runtime's half of that transport:
 *
 * - `buildPiTerminalArguments` composes the same controlled launch as the RPC adapter, without
 *   `--mode rpc`, so the provider starts its native terminal UI on the same conversation file.
 * - `PiPtyTerminal` owns one PTY host helper (see `pi-pty-host.ts`): the helper is the session leader
 *   that holds the terminal, the provider runs on that terminal, and the Runtime owns the helper's
 *   control pipe. The terminal byte stream is projected as an ordered, cursor-based stream, so
 *   attach, detach and reattach are client bookkeeping over that stream — never a reason to stop the
 *   provider.
 *
 * An explicit `release` is byte-level (the terminal's own Ctrl+D byte) plus the helper's report that
 * the provider process exited. The exit *code* is recorded for audit and is deliberately not used to
 * decide whether a release succeeded: FOUNDATION-040 measured that Ctrl+D and SIGTERM both exit 0.
 */
import { isAbsolute, join } from 'node:path';
import type { AgentConfiguration, AgentPluginSelection } from '@codeestra/contracts';
import { readProcessStartToken } from './pi-identity.js';
import {
  captureProviderProcessTree,
  inspectProviderProcessOwnership,
  readProcessTable,
  type ProviderOwnershipObservation,
  type ProviderProcessTree,
} from './pi-process.js';
import { buildPiModelArguments } from './pi-rpc.js';
import { buildPiPluginArguments } from './pi-plugins.js';

export class PiPtyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PiPtyError';
  }
}

/** The byte a terminal sends for Ctrl+D on an empty editor; the provider's own release key. */
export const terminalReleaseByte = '\u0004';

/**
 * The same controlled launch the RPC adapter uses, minus `--mode rpc`.
 *
 * The permission mode, tool allowlist, gate/question extensions, session directory and the session
 * file the conversation is reopened from are all identical to the automation launch: switching
 * transport must not silently change what the Agent may do (ADR-0010 D06).
 */
export function buildPiTerminalArguments(input: {
  readonly gateExtensionPath: string;
  readonly questionExtensionPath: string;
  readonly sessionDir: string;
  readonly platform?: 'unix' | 'windows';
  readonly permissionMode?: 'FULL' | 'STRICT';
  readonly resumeSessionFile: string;
  readonly agentConfig?: AgentConfiguration;
  /**
   * The same plugin selection the RPC launch applies (ADR-0044 D06): the native terminal transport
   * must not change what the Agent may load, so both transports compose these arguments from the one
   * shared builder in `pi-plugins.ts`.
   */
  readonly pluginSelection?: AgentPluginSelection | null;
}): readonly string[] {
  if (!isAbsolute(input.gateExtensionPath) || !isAbsolute(input.questionExtensionPath)
    || !isAbsolute(input.sessionDir) || !isAbsolute(input.resumeSessionFile)) {
    throw new PiPtyError('INVALID_ARGUMENTS',
      'The gate/question extension paths, the session directory and the session file must be absolute');
  }
  if (input.platform === 'windows') {
    throw new PiPtyError('PLATFORM_UNSUPPORTED',
      'The native terminal transport is implemented for POSIX PTYs; Windows is not supported');
  }
  const mode = input.permissionMode ?? 'FULL';
  const argv = [
    mode === 'FULL' ? '--approve' : '--no-approve',
    '--no-extensions',
    '--extension', input.gateExtensionPath,
    '--extension', input.questionExtensionPath,
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
  ];
  // User-selected resources are appended after Codeestra's own extension pair, exactly as the RPC
  // launch appends them; with no selection nothing is added.
  argv.push(...buildPiPluginArguments(input.pluginSelection));
  if (mode === 'STRICT') {
    argv.push('--tools', 'read,bash,edit,write,grep,find,ls,ask_user_question');
  }
  argv.push('--session-dir', input.sessionDir);
  argv.push('--session', input.resumeSessionFile);
  argv.push(...buildPiModelArguments(input.agentConfig));
  return argv;
}

export interface PiPtyOutputStream {
  /** Monotonic byte cursor: the number of terminal bytes projected so far. */
  readonly cursor: number;
  readonly data: string;
  /** True when the requested cursor was older than the retained buffer. */
  readonly truncated: boolean;
}

export interface PiPtySnapshot {
  readonly cursor: number;
  /** Retained bytes right now, after any truncation. */
  readonly retainedBytes: number;
  /** Bytes projected in total since the provider started. */
  readonly projectedBytes: number;
  /** True when older terminal output was dropped to keep the buffer bounded. */
  readonly truncated: boolean;
}

export interface PiPtyExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly at: number;
}

/**
 * The outcome of one TerminalTransport resize. It is a fact about the terminal, not a request that
 * was accepted: `applied: 'NOT_APPLIED'` always names why (`INVALID_SIZE`, `PROVIDER_EXITED`,
 * `STTY_FAILED`), so a caller never has to guess whether the provider reflowed.
 */
export interface PiPtyWindowSize {
  readonly cols: number;
  readonly rows: number;
  readonly applied: 'APPLIED' | 'NOT_APPLIED';
  readonly detail: string;
}

/** The TerminalTransport protocol both halves speak; see `pi-pty-host.ts`. */
export const terminalTransportProtocol = 1;

/** The resize range the Runtime accepts; the PTY host enforces the same bound. */
export const maxWindowDimension = 1000;

export interface PiPtyReady {
  readonly providerPid: number;
  readonly slavePath: string;
  readonly transport: number;
  readonly windowSize: 'APPLIED' | 'NOT_APPLIED';
}

type PtyHostFrame = Readonly<Record<string, unknown>>;

export interface PiPtyLaunchInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
  /** Overridable for tests; defaults to the helper shipped next to this module. */
  readonly hostPath?: string;
  readonly spawn?: (argv: readonly string[], options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  }) => Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  /** How long to wait for the helper's `ready` frame. */
  readonly readyTimeoutMs?: number;
  /** How many terminal bytes to retain for reattach. Older bytes are dropped and reported. */
  readonly bufferBytes?: number;
  /** How often the helper's reported provider exit is polled (tests shorten it). */
  readonly exitPollMs?: number;
  /** How long a resize waits for the helper's answer before it is reported as unconfirmed. */
  readonly resizeTimeoutMs?: number;
  readonly now?: () => number;
  readonly readTable?: typeof readProcessTable;
}

type PtyHostProcess = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

/**
 * One PTY-hosted provider terminal.
 *
 * The Runtime holds the host helper (its control pipe) and its process identity; the helper holds the
 * PTY; the provider runs with that PTY as its controlling terminal. Detaching a *client* never
 * touches either process. Only `stop` — or the Runtime closing the control pipe, which the helper
 * treats as "no writer is left to control this terminal" — ends the provider.
 */
export class PiPtyTerminal {
  readonly #child: PtyHostProcess;
  readonly #now: () => number;
  readonly #bufferBytes: number;
  readonly #resizeTimeoutMs: number;
  readonly #readTable: typeof readProcessTable;
  readonly #chunks: { readonly cursor: number; readonly bytes: Uint8Array }[] = [];
  readonly #exitWaiters: ((exit: PiPtyExit) => void)[] = [];
  readonly #resizeWaiters: ((result: PiPtyWindowSize) => void)[] = [];
  #buffered = 0;
  #cursor = 0;
  #projected = 0;
  #exit: PiPtyExit | null = null;
  #controlClosed = false;
  #ready: PiPtyReady | null = null;
  #size: { readonly cols: number; readonly rows: number } | null = null;

  private constructor(input: {
    readonly child: PtyHostProcess;
    readonly bufferBytes: number;
    readonly resizeTimeoutMs?: number;
    readonly now: () => number;
    readonly readTable: typeof readProcessTable;
  }) {
    this.#child = input.child;
    this.#bufferBytes = input.bufferBytes;
    this.#resizeTimeoutMs = input.resizeTimeoutMs ?? 10_000;
    this.#now = input.now;
    this.#readTable = input.readTable;
    void this.#pumpFrames();
  }

  /** Resolves when the helper reported a live provider; rejects if it failed to start one. */
  readonly ready = createOutcome<PiPtyReady>();

  get helperPid(): number {
    return this.#child.pid;
  }

  get providerPid(): number {
    return this.#ready?.providerPid ?? 0;
  }

  get slavePath(): string {
    return this.#ready?.slavePath ?? '';
  }

  get windowSize(): 'APPLIED' | 'NOT_APPLIED' {
    return this.#ready?.windowSize ?? 'NOT_APPLIED';
  }

  /** The transport protocol the helper reported in `ready`; it must be the one that was requested. */
  get transportProtocol(): number {
    return this.#ready?.transport ?? 0;
  }

  /** The last geometry this Runtime applied through the transport, if any. */
  get size(): { readonly cols: number; readonly rows: number } | null {
    return this.#size;
  }

  get exit(): PiPtyExit | null {
    return this.#exit;
  }

  get controlClosed(): boolean {
    return this.#controlClosed;
  }

  static async launch(input: PiPtyLaunchInput): Promise<PiPtyTerminal> {
    const hostPath = input.hostPath ?? join(import.meta.dir, 'pi-pty-host.ts');
    const plan = JSON.stringify({
      argv: input.argv,
      cwd: input.cwd,
      env: input.env,
      cols: input.cols ?? 120,
      rows: input.rows ?? 40,
      transport: terminalTransportProtocol,
    });
    const spawn = input.spawn ?? ((argv, options) => Bun.spawn([...argv], {
      cwd: options.cwd,
      env: { ...options.env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }));
    let child: PtyHostProcess;
    try {
      child = spawn([process.execPath, hostPath, plan], {
        cwd: input.cwd, env: { ...input.env },
      });
    } catch (error) {
      throw new PiPtyError('PTY_HOST_SPAWN_FAILED',
        `The PTY host could not be started: ${error instanceof Error ? error.message : String(error)}`);
    }
    const terminal = new PiPtyTerminal({
      child,
      bufferBytes: input.bufferBytes ?? 256 * 1024,
      ...(input.resizeTimeoutMs === undefined ? {} : { resizeTimeoutMs: input.resizeTimeoutMs }),
      now: input.now ?? Date.now,
      readTable: input.readTable ?? readProcessTable,
    });
    const timeoutMs = input.readyTimeoutMs ?? 15_000;
    const ready = await Promise.race([
      terminal.ready.promise,
      Bun.sleep(timeoutMs).then(() => null),
    ]);
    if (ready === null) {
      await terminal.stop({ graceMs: 1_000 });
      throw new PiPtyError('PTY_READY_TIMEOUT',
        `The PTY host did not report a provider process within ${timeoutMs} ms`);
    }
    return terminal;
  }

  /** Bounded-buffer facts for a reattach: the cursor a client should resume from. */
  snapshot(): PiPtySnapshot {
    return {
      cursor: this.#cursor,
      retainedBytes: this.#buffered,
      projectedBytes: this.#projected,
      truncated: this.#projected > this.#buffered,
    };
  }

  /** Everything retained from `since` onwards. A stale cursor is reported, never silently skipped. */
  outputSince(since: number): PiPtyOutputStream {
    const start = Number.isFinite(since) && since > 0 ? since : 0;
    const firstRetained = this.#chunks[0] === undefined
      ? this.#cursor
      : (this.#chunks[0] as { cursor: number }).cursor - (this.#chunks[0] as { bytes: Uint8Array }).bytes.byteLength;
    const truncated = start < firstRetained && start < this.#cursor;
    const from = truncated ? firstRetained : start;
    const parts: Buffer[] = [];
    for (const chunk of this.#chunks) {
      const chunkStart = chunk.cursor - chunk.bytes.byteLength;
      if (chunk.cursor <= from) continue;
      parts.push(Buffer.from(chunk.bytes.subarray(Math.max(0, from - chunkStart))));
    }
    return { cursor: this.#cursor, data: Buffer.concat(parts).toString('utf8'), truncated };
  }

  /**
   * Writes terminal input. An explicit release is `terminalReleaseByte`; this method never claims to
   * have released or interrupted anything.
   */
  write(data: string): void {
    if (this.#exit !== null) {
      throw new PiPtyError('TERMINAL_EXITED', 'The provider terminal has already exited');
    }
    if (!this.#send({ t: 'input', data: Buffer.from(data, 'utf8').toString('base64') })) {
      throw new PiPtyError('TERMINAL_CONTROL_CLOSED',
        'The terminal control pipe is closed; input was not written');
    }
  }

  /**
   * Changes the terminal's window size through the versioned TerminalTransport protocol.
   *
   * This is a transport fact, not an AdapterEvent: the size is the terminal's own geometry, and the
   * provider learns it from the terminal device (`TIOCGWINSZ`) exactly as it learns the size it was
   * launched with. The answer is the helper's own observation — `NOT_APPLIED` with a reason is a
   * real answer and is returned, never converted into a thrown "success".
   *
   * Refusals that are not "the terminal says no": an exited terminal and a closed control pipe are
   * thrown, and an unconfirmed resize (the helper did not answer within the deadline) is thrown too,
   * because calling that `NOT_APPLIED` would blame the terminal for the Runtime's own uncertainty.
   */
  async resize(input: { readonly cols: number; readonly rows: number }): Promise<PiPtyWindowSize> {
    if (!Number.isSafeInteger(input.cols) || !Number.isSafeInteger(input.rows)
      || input.cols < 1 || input.rows < 1
      || input.cols > maxWindowDimension || input.rows > maxWindowDimension) {
      throw new PiPtyError('INVALID_WINDOW_SIZE',
        `A window size needs 1..${maxWindowDimension} integer columns and rows, got`
        + ` ${input.cols}x${input.rows}`);
    }
    if (this.#exit !== null) {
      throw new PiPtyError('TERMINAL_EXITED', 'The provider terminal has already exited');
    }
    const answer = new Promise<PiPtyWindowSize>((resolve) => { this.#resizeWaiters.push(resolve); });
    const waiter = this.#resizeWaiters.at(-1) as (result: PiPtyWindowSize) => void;
    if (!this.#send({ t: 'resize', cols: input.cols, rows: input.rows })) {
      this.#resizeWaiters.pop();
      throw new PiPtyError('TERMINAL_CONTROL_CLOSED',
        'The terminal control pipe is closed; the resize was not sent');
    }
    const result = await Promise.race([answer, Bun.sleep(this.#resizeTimeoutMs).then(() => null)]);
    if (result === null) {
      // A late answer must not be handed to the next resize: the waiter is dropped before throwing.
      const index = this.#resizeWaiters.indexOf(waiter);
      if (index !== -1) this.#resizeWaiters.splice(index, 1);
      throw new PiPtyError('PTY_RESIZE_TIMEOUT',
        `The PTY host did not answer the resize within ${this.#resizeTimeoutMs} ms; whether the`
        + ' terminal changed size is unknown');
    }
    return result;
  }

  /** Asks the helper to signal the provider. Only used for an owned, requested stop. */
  signal(signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT'): void {
    this.#send({ t: 'signal', signal });
  }

  /** The helper's provider-exit fact. The exit code is audit data, never a success criterion. */
  waitForExit(timeoutMs: number): Promise<PiPtyExit | null> {
    if (this.#exit !== null) return Promise.resolve(this.#exit);
    return Promise.race([
      new Promise<PiPtyExit>((resolve) => { this.#exitWaiters.push(resolve); }),
      Bun.sleep(timeoutMs).then(() => null),
    ]);
  }

  /**
   * Captures the terminal's process tree while it is alive. The walk starts at the *helper* (the
   * session leader and the provider's parent) so the recorded tree contains the helper, the provider
   * and any tool child the provider started.
   */
  async captureTree(): Promise<ProviderProcessTree | null> {
    const startToken = await readProcessStartToken(this.#child.pid);
    if (startToken === null) return null;
    const tree = await captureProviderProcessTree({
      pid: this.#child.pid, startToken, now: this.#now, readTable: this.#readTable,
    });
    return { ...tree, note: `captured from the PTY host (session leader); ${tree.note}` };
  }

  /**
   * Captures the tree again and merges it into `previous`.
   *
   * A single capture at launch can only see what was already running then, and a tool the provider
   * starts later is exactly the process FOUNDATION-040 measured surviving a provider kill. The union
   * of every capture taken while the terminal was alive is therefore the evidence a later ownership
   * check compares against: descendants are merged by PID, and nothing is ever removed.
   */
  async refreshTree(previous: ProviderProcessTree | null): Promise<ProviderProcessTree | null> {
    if (this.#exit !== null) return previous;
    let fresh: ProviderProcessTree | null = null;
    try {
      fresh = await this.captureTree();
    } catch {
      // A failed capture is not evidence of quiescence; the caller keeps whatever it already had.
      return previous;
    }
    if (fresh === null) return previous;
    if (previous === null) return fresh;
    const byPid = new Map(previous.descendants.map((child) => [child.pid, child]));
    for (const child of fresh.descendants) {
      const known = byPid.get(child.pid);
      byPid.set(child.pid, known === undefined
        ? child
        : { ...known, startToken: known.startToken ?? child.startToken });
    }
    return { ...fresh, startToken: previous.startToken, descendants: [...byPid.values()],
      note: `${previous.note} | refreshed: ${fresh.note}` };
  }

  /**
   * Whether anything of this terminal is still running, decided from a captured tree. Without a
   * captured tree the answer is `UNVERIFIABLE`, which callers must treat as "do not start a
   * successor" rather than as "probably stopped".
   */
  async inspectOwnership(tree: ProviderProcessTree | null): Promise<ProviderOwnershipObservation> {
    if (tree === null) {
      return { state: 'UNVERIFIABLE',
        detail: 'no terminal process tree was captured while this terminal was alive' };
    }
    return inspectProviderProcessOwnership({ tree, readTable: this.#readTable });
  }

  /**
   * Ends this terminal: asks the helper to stop the provider, then — if that does not finish in
   * time — signals the helper itself. Never reports success without an observed exit.
   */
  async stop(input: { readonly graceMs: number }): Promise<{ readonly exited: boolean;
    readonly helperPid: number; readonly providerPid: number; readonly exit: PiPtyExit | null }> {
    const outcome = (exited: boolean): { readonly exited: boolean; readonly helperPid: number;
      readonly providerPid: number; readonly exit: PiPtyExit | null } => ({
      exited, helperPid: this.helperPid, providerPid: this.providerPid, exit: this.#exit,
    });
    if (this.#exit !== null) { this.closeControl(); return outcome(true); }
    this.#send({ t: 'shutdown' });
    const graceful = await this.waitForExit(input.graceMs);
    this.closeControl();
    if (graceful !== null) return outcome(true);
    try { this.#child.kill('SIGTERM'); } catch { /* already gone */ }
    if (await this.waitForExit(input.graceMs) !== null) return outcome(true);
    try { this.#child.kill('SIGKILL'); } catch { /* already gone */ }
    return outcome(this.#exit !== null);
  }

  /**
   * Closes only the control pipe. The helper treats that as "no writer is left" and terminates the
   * provider, so a Runtime that dies cannot leave a terminal writing the workspace.
   */
  closeControl(): void {
    if (this.#controlClosed) return;
    this.#controlClosed = true;
    try { this.#child.stdin.end(); } catch { /* the pipe may be gone already. */ }
  }

  async #pumpFrames(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    const dispatch = (frame: PtyHostFrame): void => {
      if (frame['t'] === 'ready') {
        const transport = typeof frame['transport'] === 'number' ? frame['transport'] : 0;
        if (transport !== terminalTransportProtocol) {
          this.ready.reject(new PiPtyError('PTY_TRANSPORT_PROTOCOL_MISMATCH',
            `The PTY host answered TerminalTransport protocol ${transport}; this Runtime speaks`
            + ` ${terminalTransportProtocol}`));
          return;
        }
        this.#ready = {
          providerPid: typeof frame['providerPid'] === 'number' ? frame['providerPid'] : 0,
          slavePath: typeof frame['slave'] === 'string' ? frame['slave'] : '',
          transport,
          windowSize: frame['windowSize'] === 'APPLIED' ? 'APPLIED' : 'NOT_APPLIED',
        };
        this.ready.resolve(this.#ready);
        return;
      }
      if (frame['t'] === 'resized') {
        const result: PiPtyWindowSize = {
          cols: typeof frame['cols'] === 'number' ? frame['cols'] : 0,
          rows: typeof frame['rows'] === 'number' ? frame['rows'] : 0,
          applied: frame['applied'] === 'APPLIED' ? 'APPLIED' : 'NOT_APPLIED',
          detail: typeof frame['detail'] === 'string' ? frame['detail'] : 'UNKNOWN',
        };
        // The terminal really has this geometry only when the helper applied it; a refused size never
        // overwrites the size the provider is actually rendering at.
        if (result.applied === 'APPLIED') this.#size = { cols: result.cols, rows: result.rows };
        const waiter = this.#resizeWaiters.shift();
        if (waiter === undefined) return;
        waiter(result);
        return;
      }
      if (frame['t'] === 'output' && typeof frame['data'] === 'string') {
        const bytes = Buffer.from(frame['data'], 'base64');
        this.#cursor += bytes.byteLength;
        this.#projected += bytes.byteLength;
        this.#append(bytes, this.#cursor);
        return;
      }
      if (frame['t'] === 'exit') {
        this.#settleExit({
          code: typeof frame['code'] === 'number' ? frame['code'] : null,
          signal: typeof frame['signal'] === 'string' ? frame['signal'] : null,
          at: this.#now(),
        });
        return;
      }
      if (frame['t'] === 'error') {
        this.ready.reject(new PiPtyError(
          typeof frame['code'] === 'string' ? frame['code'] : 'PTY_HOST_ERROR',
          typeof frame['message'] === 'string' ? frame['message'] : 'the PTY host reported an error'));
        return;
      }
    };
    try {
      for await (const chunk of this.#child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.trim().length === 0) continue;
          try {
            dispatch(JSON.parse(line) as PtyHostFrame);
          } catch { /* a malformed frame is dropped; the exit fact still arrives separately */ }
        }
      }
    } catch {
      // The helper's stdout ended abnormally. The exit fact is reported separately (or stays
      // unknown), so nothing is inferred from this.
    }
    // The helper is gone: if it never reported an exit, the exit stays unknown rather than guessed.
    this.ready.reject(new PiPtyError('PTY_HOST_STREAM_ENDED',
      'The PTY host stream ended without reporting a provider process'));
    if (this.#exit === null) {
      this.#settleExit({ code: null, signal: null, at: this.#now() });
    }
  }

  #settleExit(exit: PiPtyExit): void {
    if (this.#exit !== null) return;
    this.#exit = exit;
    for (const waiter of this.#exitWaiters.splice(0)) waiter(exit);
  }

  #append(bytes: Uint8Array, cursor: number): void {
    this.#chunks.push({ cursor, bytes });
    this.#buffered += bytes.byteLength;
    while (this.#buffered > this.#bufferBytes && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      if (dropped !== undefined) this.#buffered -= dropped.bytes.byteLength;
    }
  }

  #send(command: Record<string, unknown>): boolean {
    try {
      this.#child.stdin.write(`${JSON.stringify(command)}\n`);
      void this.#child.stdin.flush();
      return true;
    } catch {
      return false;
    }
  }
}

function createOutcome<T>(): { promise: Promise<T>; resolve: (value: T) => void;
  reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  // An unconsumed rejection (a helper that fails before anyone awaits `ready`) must not crash the
  // Runtime; the awaiting `launch` still observes it.
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
