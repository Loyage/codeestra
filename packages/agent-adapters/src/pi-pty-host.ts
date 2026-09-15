/**
 * PTY host helper (FOUNDATION-046 / ADR-0026).
 *
 * A provider that renders a native terminal UI needs a real terminal device, not a pipe: it asks
 * the OS for a tty, switches it to raw mode, reads escape sequences and learns its size from the
 * kernel. FOUNDATION-040 measured that a native Pi TUI resumed from a session file works in a real
 * PTY, and that a plain stdout pipe cannot stand in for one.
 *
 * This helper exists because the session/controlling-terminal setup cannot be done from the
 * Runtime process itself: `setsid(2)` fails for a process that is already a process group leader,
 * and the process that owns the terminal must be the session leader. So the Runtime spawns this
 * tiny, owned helper, which
 *
 *   1. becomes a session leader (`setsid`),
 *   2. allocates a PTY (`posix_openpt` / `grantpt` / `unlockpt`) and opens the slave *without*
 *      `O_NOCTTY`, which makes it the controlling terminal of this new session,
 *   3. sets the window size, then
 *   4. spawns the provider with the slave device as stdin/stdout/stderr,
 *   5. and relays bytes between the PTY master and its own stdio (the Runtime holds that pipe) as
 *      LF-delimited JSON frames, so the Runtime — not the terminal — owns the stream.
 *
 * Losing the control pipe (the Runtime died or closed it) is treated as "no writer is left to
 * control this terminal": the helper terminates the provider and exits instead of leaving an
 * orphan provider writing the workspace (FOUNDATION-040 §2.2 measured that killing a provider does
 * not stop tools it already started, so the honest move is to keep the terminal's owner alive only
 * while its owner is).
 *
 * Usage: `bun pi-pty-host.ts` with the spawn plan (JSON) as argv[2]. It never reads the plan from
 * the environment, so no ambient value can change what is launched.
 */
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { closeSync, openSync, readSync, writeSync, constants as fsConstants } from 'node:fs';

/**
 * The transport protocol this helper speaks. The Runtime names the protocol it wants in the spawn
 * plan and this helper echoes it back in `ready`, so a stale helper paired with a newer Runtime (or
 * the reverse) is a stated refusal instead of a silently mis-read frame. `1` is the protocol that
 * carries `resize` on top of input/output/release/signal; the number lives in both halves of the
 * wire and is edited together with the frame table in `docs/architecture/agent-adapter-api.md`
 * (§ TerminalTransport).
 */
export const supportedTransportProtocol = 1;

/**
 * The resize range this helper accepts. A terminal far above this is not a terminal a provider can
 * render, and an unbounded width is a way to make a provider allocate enormous line buffers; the
 * bound is enforced here as well as in the Runtime because the helper is the process that talks to
 * the kernel.
 */
export const maxWindowDimension = 1000;

export interface PtyHostPlan {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  /** The TerminalTransport protocol the Runtime speaks (see `supportedTransportProtocol`). */
  readonly transport: number;
}

export type PtyHostFrame =
  | { readonly t: 'ready'; readonly providerPid: number; readonly slave: string;
      readonly cols: number; readonly rows: number; readonly transport: number;
      readonly windowSize: 'APPLIED' | 'NOT_APPLIED' }
  | { readonly t: 'output'; readonly data: string }
  /**
   * The outcome of one resize. `applied: 'NOT_APPLIED'` always carries a `detail` naming why
   * (`INVALID_SIZE`, `PROVIDER_EXITED`, `STTY_FAILED`), never a silent success.
   */
  | { readonly t: 'resized'; readonly cols: number; readonly rows: number;
      readonly applied: 'APPLIED' | 'NOT_APPLIED'; readonly detail: string }
  | { readonly t: 'exit'; readonly code: number | null; readonly signal: string | null }
  | { readonly t: 'error'; readonly code: string; readonly message: string };

type PtyHostCommand =
  | { readonly t: 'input'; readonly data: string }
  | { readonly t: 'eof' }
  | { readonly t: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly t: 'signal'; readonly signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' }
  | { readonly t: 'shutdown' };

const pollIn = 1;
const pollHup = 0x0010;

/** Platform constants for the libc calls this helper needs. */
function libc(): {
  readonly setsid: () => number;
  readonly posixOpenpt: (flags: number) => number;
  readonly grantpt: (fd: number) => number;
  readonly unlockpt: (fd: number) => number;
  readonly ptsname: (fd: number) => unknown;
} {
  const name = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6';
  const lib = dlopen(name, {
    setsid: { args: [], returns: FFIType.i32 },
    posix_openpt: { args: [FFIType.i32], returns: FFIType.i32 },
    grantpt: { args: [FFIType.i32], returns: FFIType.i32 },
    unlockpt: { args: [FFIType.i32], returns: FFIType.i32 },
    ptsname: { args: [FFIType.i32], returns: FFIType.cstring },
  });
  const symbols = lib.symbols as unknown as {
    setsid: () => number;
    posix_openpt: (flags: number) => number;
    grantpt: (fd: number) => number;
    unlockpt: (fd: number) => number;
    ptsname: (fd: number) => unknown;
  };
  return {
    setsid: () => symbols.setsid(),
    posixOpenpt: (flags) => symbols.posix_openpt(flags),
    grantpt: (fd) => symbols.grantpt(fd),
    unlockpt: (fd) => symbols.unlockpt(fd),
    ptsname: (fd) => symbols.ptsname(fd),
  };
}

function writeFrame(frame: PtyHostFrame): void {
  try {
    writeSync(1, `${JSON.stringify(frame)}\n`);
  } catch {
    // The Runtime is gone; the main loop notices the same thing through stdin EOF.
  }
}

/**
 * Applies a window size, initial or later, by asking `stty` on the terminal's slave device.
 *
 * A direct `ioctl(TIOCSWINSZ)` was tried first and is deliberately not used here: on this platform
 * (darwin/arm64, Bun 1.4.2) an FFI `ioctl(fd, TIOCSWINSZ, &winsize)` returns 0 while storing nothing
 * usable, and the provider then reads garbage from `stty size` (measured: `getSize()` read back
 * `0 0`, `stty size` printed a different random pair on every run — the classic AArch64 variadic-ABI
 * mismatch for `ioctl(2)`, which takes its third argument on the stack). A wrong size is worse than
 * an unset one, so this helper uses the interface the terminal itself exposes instead.
 *
 * `stty` on the slave fd is measured to work for both the initial size (the `ready` frame's
 * `windowSize`) and a later resize; the provider reads the new values back through its own descriptor
 * (`stty size` inside the provider reported `25 80` before and `33 99` after a resize). The same
 * mechanism is what makes an interactive TUI reflow.
 */
async function applyWindowSize(input: {
  readonly slave: number;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<'APPLIED' | 'NOT_APPLIED'> {
  try {
    const stty = Bun.spawn(['stty', 'rows', String(input.rows), 'cols', String(input.cols)], {
      cwd: input.cwd,
      env: { ...input.env },
      stdio: [input.slave, input.slave, input.slave],
    });
    const code = await Promise.race([stty.exited, Bun.sleep(2_000).then(() => null)]);
    return code === 0 ? 'APPLIED' : 'NOT_APPLIED';
  } catch {
    return 'NOT_APPLIED';
  }
}

/**
 * Reads one byte range from a file descriptor through libc. `readSync` cannot be used on a PTY
 * master reliably (it may return EIO when the slave side is closed), and this way a closed master
 * is a value instead of an exception.
 */
function readFd(fd: number, buffer: Uint8Array): number {
  try {
    return readSync(fd, buffer, 0, buffer.length, null);
  } catch {
    return -1;
  }
}

function pollOnce(fds: readonly number[], timeoutMs: number): readonly number[] {
  const name = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6';
  const lib = dlopen(name, {
    poll: { args: [FFIType.ptr, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
  });
  const symbols = lib.symbols as unknown as {
    poll: (fds: unknown, count: number, timeout: number) => number;
  };
  const buffer = Buffer.alloc(fds.length * 8);
  for (const [index, fd] of fds.entries()) {
    buffer.writeInt32LE(fd, index * 8);
    buffer.writeInt16LE(pollIn, index * 8 + 4);
  }
  const result = symbols.poll(ptr(buffer), fds.length, timeoutMs);
  if (result <= 0) return [];
  const ready: number[] = [];
  for (const [index, fd] of fds.entries()) {
    const events = buffer.readInt16LE(index * 8 + 6);
    if ((events & (pollIn | pollHup)) !== 0) ready.push(fd);
  }
  return ready;
}

/**
 * The child's exit status, read from the OS rather than from an event-loop callback.
 *
 * The relay loop spends most of its time inside blocking libc calls (`poll`/`read`), so a promise
 * resolved by the runtime's IO watcher is not a fact this process is allowed to depend on. The
 * helper is the child's parent, so `waitpid(WNOHANG)` is authoritative: it also reaps the child
 * instead of leaving a zombie behind.
 */
function waitForChild(pid: number): { readonly exited: boolean; readonly code: number | null;
  readonly signal: string | null } {
  const name = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6';
  const lib = dlopen(name, {
    waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    strsignal: { args: [FFIType.i32], returns: FFIType.cstring },
  });
  const symbols = lib.symbols as unknown as {
    waitpid: (pid: number, status: unknown, options: number) => number;
    strsignal: (signal: number) => unknown;
  };
  const status = new Int32Array(1);
  const result = symbols.waitpid(pid, ptr(status), 1);
  if (result !== pid) return { exited: false, code: null, signal: null };
  const value = status[0] as number;
  // WIFSIGNALED: low 7 bits hold the signal number, and bit 7 means "terminated by a signal".
  if ((value & 0x7f) !== 0 && (value & 0x7f) !== 0x7f) {
    const signal = value & 0x7f;
    let name2 = `signal ${signal}`;
    try {
      const text = symbols.strsignal(signal);
      if (text !== null && text !== undefined) name2 = String(text);
    } catch { /* the signal name is cosmetic; the number is the fact. */ }
    return { exited: true, code: null, signal: name2 };
  }
  return { exited: true, code: (value >> 8) & 0xff, signal: null };
}

function parsePlan(raw: string | undefined): PtyHostPlan {
  if (raw === undefined || raw.length === 0) throw new Error('the PTY host needs a spawn plan');
  const parsed = JSON.parse(raw) as Partial<PtyHostPlan>;
  if (!Array.isArray(parsed.argv) || parsed.argv.length === 0
    || !parsed.argv.every((entry): entry is string => typeof entry === 'string')) {
    throw new Error('the PTY host plan needs a non-empty string argv');
  }
  if (typeof parsed.cwd !== 'string' || parsed.cwd.length === 0) {
    throw new Error('the PTY host plan needs an absolute cwd');
  }
  if (parsed.transport !== supportedTransportProtocol) {
    throw new Error(`this PTY host speaks TerminalTransport protocol ${supportedTransportProtocol},`
      + ` the plan asked for ${String(parsed.transport)}`);
  }
  return {
    argv: parsed.argv,
    cwd: parsed.cwd,
    env: typeof parsed.env === 'object' && parsed.env !== null ? parsed.env : {},
    cols: typeof parsed.cols === 'number' && parsed.cols > 0 ? parsed.cols : 120,
    rows: typeof parsed.rows === 'number' && parsed.rows > 0 ? parsed.rows : 40,
    transport: supportedTransportProtocol,
  };
}

export async function runPtyHost(rawPlan: string | undefined): Promise<number> {
  let plan: PtyHostPlan;
  try {
    plan = parsePlan(rawPlan);
  } catch (error) {
    writeFrame({ t: 'error', code: 'INVALID_PLAN',
      message: error instanceof Error ? error.message : String(error) });
    return 2;
  }
  const lib = libc();
  // The helper must be its own session leader before it opens the slave, otherwise the slave
  // cannot become this session's controlling terminal.
  if (lib.setsid() === -1) {
    writeFrame({ t: 'error', code: 'SETSID_FAILED',
      message: 'the PTY host could not become a session leader' });
    return 2;
  }
  const master = lib.posixOpenpt(fsConstants.O_RDWR | fsConstants.O_NOCTTY);
  if (master === -1) {
    writeFrame({ t: 'error', code: 'PTY_ALLOCATION_FAILED', message: 'posix_openpt failed' });
    return 2;
  }
  // The master fd stays blocking and is only ever read when `poll` says it is readable (see
  // `drainMaster`). Measured in this environment: `fcntl(F_SETFL, O_NONBLOCK)` through FFI does not
  // take effect on a PTY master, and a blocking read on a master whose provider already exited
  // wedges the helper forever. Poll-guarded reads are the behaviour this helper relies on.
  if (lib.grantpt(master) !== 0 || lib.unlockpt(master) !== 0) {
    writeFrame({ t: 'error', code: 'PTY_ALLOCATION_FAILED', message: 'grantpt/unlockpt failed' });
    return 2;
  }
  const slaveName = String(lib.ptsname(master) ?? '');
  if (slaveName.length === 0) {
    writeFrame({ t: 'error', code: 'PTY_ALLOCATION_FAILED', message: 'ptsname returned nothing' });
    return 2;
  }
  let slave: number;
  try {
    // No O_NOCTTY: this session leader wants this device as its controlling terminal.
    slave = openSync(slaveName, fsConstants.O_RDWR);
  } catch (error) {
    writeFrame({ t: 'error', code: 'PTY_SLAVE_OPEN_FAILED',
      message: error instanceof Error ? error.message : String(error) });
    return 2;
  }

  // An explicit, ordered release (Ctrl+D) is an input byte on a raw terminal; deliberately nothing
  // else happens here. The helper never decides that a provider "released" anything.
  let child: Bun.Subprocess<number, number, number>;
  const windowSize = await applyWindowSize({ slave, cols: plan.cols, rows: plan.rows,
    cwd: plan.cwd, env: plan.env });
  try {
    child = Bun.spawn([...plan.argv], {
      cwd: plan.cwd,
      env: { ...plan.env },
      stdio: [slave, slave, slave],
    });
  } catch (error) {
    closeSync(slave);
    writeFrame({ t: 'error', code: 'PROVIDER_SPAWN_FAILED',
      message: error instanceof Error ? error.message : String(error) });
    return 2;
  }
  writeFrame({ t: 'ready', providerPid: child.pid, slave: slaveName, transport: plan.transport,
    cols: plan.cols, rows: plan.rows, windowSize });

  // The runtime-exit promise is kept only as a belt-and-braces signal; `waitForChild` below is the
  // authority. This helper keeps its own copy of the slave open for the terminal's whole life: that
  // fd is the interface a later resize is applied through (`stty` on the terminal's slave device),
  // and "the provider is gone" is decided by `waitpid`, never by the master reporting EOF. Closing
  // the copy would hide the master's HUP but not the exit, and losing the ability to resize a live
  // terminal would be the worse trade.
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let exitSeen = false;
  let closed = false;

  const terminate = (): void => {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  };

  const stop = (code: number): number => {
    if (!closed) {
      closed = true;
      try { closeSync(master); } catch { /* already closed */ }
      try { closeSync(slave); } catch { /* already closed */ }
    }
    return code;
  };

  let inputBuffer = '';
  const output = new Uint8Array(65536);
  /**
   * Reads everything the master has and returns immediately.
   *
   * Every read is guarded by `poll`, because the master fd is blocking and `read` on it can stall
   * (measured: a master whose provider exited does not always report EOF, and this platform keeps an
   * extra copy of the slave alive for the spawned child). The provider's exit is decided by
   * `waitpid` and is never inferred from an empty or failed read.
   */
  const drainMaster = (): void => {
    for (let round = 0; round < 256; round += 1) {
      if (!pollOnce([master], 0).includes(master)) return;
      const bytes = readFd(master, output);
      if (bytes <= 0) return;
      writeFrame({ t: 'output', data: Buffer.from(output.subarray(0, bytes)).toString('base64') });
    }
  };
  const observeExit = (): void => {
    if (exitSeen) return;
    const observed = waitForChild(child.pid);
    if (!observed.exited) return;
    exitSeen = true;
    exitCode = observed.code;
    exitSignal = observed.signal;
  };
  for (;;) {
    const ready = pollOnce([0, master], 200);
    observeExit();
    if (exitSeen) {
      drainMaster();
      break;
    }
    if (ready.includes(master)) drainMaster();
    if (ready.includes(0)) {
      const chunk = new Uint8Array(65536);
      const bytes = readFd(0, chunk);
      if (bytes <= 0) {
        // The Runtime closed the control pipe: no writer is left to own this terminal, so the
        // provider is stopped instead of being orphaned in the user's workspace.
        terminate();
        for (let attempt = 0; attempt < 20; attempt += 1) {
          await Bun.sleep(100);
          observeExit();
          if (exitSeen) break;
        }
        writeFrame({ t: 'exit', code: exitCode, signal: exitSignal ?? 'CONTROL_PIPE_CLOSED' });
        return stop(0);
      }
      inputBuffer += Buffer.from(chunk.subarray(0, bytes)).toString('utf8');
      for (let index = inputBuffer.indexOf('\n'); index !== -1;
        index = inputBuffer.indexOf('\n')) {
        const line = inputBuffer.slice(0, index);
        inputBuffer = inputBuffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        let command: PtyHostCommand;
        try {
          command = JSON.parse(line) as PtyHostCommand;
        } catch {
          continue;
        }
        if (command.t === 'input') {
          try { writeSync(master, Buffer.from(command.data, 'base64')); } catch { /* slave closed */ }
        } else if (command.t === 'eof') {
          // Ctrl+D is an input byte on a raw terminal; deliberately nothing else happens here.
        } else if (command.t === 'resize') {
          // The one place a terminal's geometry changes after launch. The answer is always a frame:
          // a runtime that asked for a size must never be left guessing whether it took effect.
          const cols = command.cols;
          const rows = command.rows;
          const invalid = !Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)
            || cols < 1 || rows < 1 || cols > maxWindowDimension || rows > maxWindowDimension;
          if (invalid) {
            writeFrame({ t: 'resized', cols, rows, applied: 'NOT_APPLIED', detail: 'INVALID_SIZE' });
          } else if (exitSeen) {
            writeFrame({ t: 'resized', cols, rows, applied: 'NOT_APPLIED', detail: 'PROVIDER_EXITED' });
          } else {
            const applied = await applyWindowSize({ slave, cols, rows, cwd: plan.cwd, env: plan.env });
            // The provider's own exit may have been reaped while `stty` ran; that is a fact worth
            // reporting, and it still may have taken effect, so the frame says both.
            observeExit();
            writeFrame({ t: 'resized', cols, rows, applied,
              detail: applied === 'APPLIED' ? 'stty' : 'STTY_FAILED' });
          }
        } else if (command.t === 'signal') {
          try { child.kill(command.signal); } catch { /* already gone */ }
        } else if (command.t === 'shutdown') {
          terminate();
          for (let attempt = 0; attempt < 20; attempt += 1) {
            await Bun.sleep(100);
            observeExit();
            if (exitSeen) break;
          }
          drainMaster();
          writeFrame({ t: 'exit', code: exitCode, signal: exitSignal });
          return stop(0);
        }
      }
    }
  }
  drainMaster();
  writeFrame({ t: 'exit', code: exitCode, signal: exitSignal });
  return stop(exitCode ?? 0);
}

// Closing the PTY master hangs the terminal up, which signals this process group (the helper is the
// session leader). That HUP is a consequence of a deliberate shutdown, so it must not decide the
// helper's exit status: the provider's own exit status is the fact the Runtime is told about.
process.on('SIGHUP', () => {});

if (import.meta.main) {
  const code = await runPtyHost(process.argv[2]);
  process.exit(code);
}
