import { createHash } from 'node:crypto';
import { readProcessStartToken } from './pi-identity.js';
import { encodePiRpcRecord, PiRpcJsonlDecoder, PiRpcProtocolError } from './pi-rpc.js';

export type PiRpcErrorCode =
  | 'PROVIDER_SPAWN_FAILED'
  | 'PROVIDER_VERSION_UNAVAILABLE'
  | 'PROCESS_IDENTITY_UNAVAILABLE'
  | 'PROCESS_EXITED'
  | 'REQUEST_TIMEOUT'
  | 'COMMAND_REJECTED'
  | 'TRANSPORT_WRITE_FAILED'
  | 'TRANSPORT_STREAM_INVALID'
  | 'LIVE_SESSION_UNAVAILABLE'
  | 'SESSION_IDENTITY_MISMATCH'
  | 'CURSOR_EPOCH_MISMATCH'
  | 'INVALID_PROVIDER_RESPONSE'
  /** A user-selected plugin/resource path could not be verified, so no process was started. */
  | 'AGENT_PLUGIN_UNAVAILABLE'
  /** The Execution's materialized knowledge could not be read at its recorded digest (ADR-0051). */
  | 'KNOWLEDGE_CONTEXT_UNAVAILABLE'
  /** The Task's recorded Session Guidance could not be read at its recorded digest (ADR-0057). */
  | 'GUIDANCE_CONTEXT_UNAVAILABLE';

/**
 * `startMayHaveOccurred` and `deliveryMayHaveOccurred` describe what is known about the
 * external side effect. `true` always means "unknown or possible", never "confirmed".
 */
export class PiRpcProcessError extends Error {
  constructor(
    readonly code: PiRpcErrorCode,
    message: string,
    readonly startMayHaveOccurred: boolean,
    readonly deliveryMayHaveOccurred: boolean,
  ) {
    super(message);
    this.name = 'PiRpcProcessError';
  }
}

export type PiRpcEnvelope =
  | { readonly kind: 'record'; readonly cursor: string; readonly record: Readonly<Record<string, unknown>> }
  | { readonly kind: 'disconnected'; readonly cursor: string; readonly reason: string };

type PiRpcProcess = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

function createOutcome<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class AsyncQueue<T> {  readonly #items: T[] = [];
  readonly #waiters: ((result: IteratorResult<T>) => void)[] = [];
  #done = false;

  push(item: T): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(item);
    else waiter({ value: item, done: false });
  }

  close(): void {
    if (this.#done) return;
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

/**
 * Owns one `pi --mode rpc` child's stdio. It never reattaches to a lost process and
 * never treats stream silence as proof that a provider stopped writing.
 */
export class PiRpcClient {
  readonly #envelopes = new AsyncQueue<PiRpcEnvelope>();
  readonly #pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  readonly #decoder: PiRpcJsonlDecoder;
  /**
   * Listeners waiting for the next `queue_update` record. Pi answers a `steer` with a success
   * response and then reports its own steering queue in a separate `queue_update`; a caller that
   * wants that corroborating fact registers here, because `envelopes()` may already have a consumer
   * (the observation pump) that owns the stream.
   */
  readonly #queueUpdateListeners = new Set<
    (record: Readonly<Record<string, unknown>>) => void
  >();
  readonly #stderrChunks: Uint8Array[] = [];
  #sequence = 0;
  #requestSequence = 0;
  #stderrBytes = 0;
  #exit: number | null = null;
  #stopped = false;
  #broken = false;

  constructor(
    readonly child: PiRpcProcess,
    readonly epoch: string,
    options: { readonly maxRecordBytes?: number; readonly requestTimeoutMs?: number } = {},
  ) {
    this.#decoder = new PiRpcJsonlDecoder(options.maxRecordBytes);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    void this.#pumpStdout();
    void this.#pumpStderr();
    void child.exited.then((code) => {
      this.#exit = code;
      this.#failPending(new PiRpcProcessError(
        'PROCESS_EXITED', `Pi RPC process exited with code ${code}`, true, true));
      if (!this.#stopped) {
        this.#envelopes.push({
          kind: 'disconnected',
          cursor: this.#cursor(),
          reason: `Pi RPC process exited with code ${code}`,
        });
      }
      this.#envelopes.close();
    }, () => {
      this.#failPending(new PiRpcProcessError(
        'PROCESS_EXITED', 'Pi RPC process exit status is unavailable', true, true));
      if (!this.#stopped) {
        this.#envelopes.push({ kind: 'disconnected', cursor: this.#cursor(),
          reason: 'Pi RPC process exit status is unavailable' });
      }
      this.#envelopes.close();
    });
  }

  readonly requestTimeoutMs: number;

  get pid(): number {
    return this.child.pid;
  }

  get hasExited(): boolean {
    return this.#exit !== null;
  }

  get stderrDigest(): { readonly bytes: number; readonly sha256: string } {
    const digest = createHash('sha256');
    for (const chunk of this.#stderrChunks) digest.update(chunk);
    return { bytes: this.#stderrBytes, sha256: digest.digest('hex') };
  }

  envelopes(): AsyncIterable<PiRpcEnvelope> {
    return this.#envelopes;
  }

  cursorPrefix(): string {
    return `${this.epoch}:`;
  }

  async request(
    command: Readonly<Record<string, unknown>>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.#exit !== null || this.#broken) {
      throw new PiRpcProcessError('PROCESS_EXITED', 'Pi RPC process is no longer running', true, true);
    }
    const id = `codeestra-${++this.#requestSequence}`;
    const outcome = createOutcome<unknown>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      outcome.reject(new PiRpcProcessError('REQUEST_TIMEOUT',
        `Pi RPC command ${String(command.type)} did not answer within ${timeoutMs} ms`, true, true));
    }, timeoutMs);
    this.#pending.set(id, { resolve: outcome.resolve, reject: outcome.reject, timer });
    try {
      await this.write({ ...command, id });
    } catch (error) {
      clearTimeout(timer);
      this.#pending.delete(id);
      throw error;
    }
    return outcome.promise;
  }

  /**
   * Resolves with the next `queue_update` record that arrives within `timeoutMs`, or `null` when none
   * did. It never consumes the record: the observation stream still sees it. `null` is a fact ("Pi did
   * not report its queue"), never a claim that the guidance was not queued.
   */
  awaitQueueUpdate(timeoutMs: number): Promise<Readonly<Record<string, unknown>> | null> {
    return new Promise((resolve) => {
      const listener = (record: Readonly<Record<string, unknown>>): void => {
        clearTimeout(timer);
        this.#queueUpdateListeners.delete(listener);
        resolve(record);
      };
      const timer = setTimeout(() => {
        this.#queueUpdateListeners.delete(listener);
        resolve(null);
      }, timeoutMs);
      this.#queueUpdateListeners.add(listener);
    });
  }

  async write(record: Readonly<Record<string, unknown>>): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = encodePiRpcRecord(record);
    } catch (error) {
      if (error instanceof PiRpcProtocolError) {
        throw new PiRpcProcessError('TRANSPORT_WRITE_FAILED', error.message, true, true);
      }
      throw error;
    }
    try {
      this.child.stdin.write(bytes);
      await this.child.stdin.flush();
    } catch {
      throw new PiRpcProcessError('TRANSPORT_WRITE_FAILED',
        'Could not write to the Pi RPC process stdin', true, true);
    }
  }

  /** Stops our own child. Never claims success unless the OS reported the exit. */
  async stop(input: { readonly graceMs: number }): Promise<{ readonly exited: boolean; readonly pid: number }> {
    this.#stopped = true;
    if (this.#exit !== null) return { exited: true, pid: this.pid };
    try {
      this.child.kill('SIGTERM');
    } catch { /* The process may have exited already. */ }
    const exited = await Promise.race([
      this.child.exited.then((code) => {
        this.#exit = code;
        return true;
      }, () => true),
      Bun.sleep(input.graceMs).then(() => false),
    ]);
    if (exited) return { exited: true, pid: this.pid };
    try {
      this.child.kill('SIGKILL');
    } catch { /* Fall through to the exit check below. */ }
    const killed = await Promise.race([
      this.child.exited.then((code) => {
        this.#exit = code;
        return true;
      }, () => true),
      Bun.sleep(input.graceMs).then(() => false),
    ]);
    return { exited: killed, pid: this.pid };
  }

  async #pumpStdout(): Promise<void> {
    try {
      for await (const chunk of this.child.stdout) {
        for (const record of this.#decoder.push(chunk)) this.#dispatch(record);
      }
      for (const record of this.#decoder.finish()) this.#dispatch(record);
    } catch {
      this.#broken = true;
      this.#failPending(new PiRpcProcessError('TRANSPORT_STREAM_INVALID',
        'Pi RPC stdout was not a valid LF-delimited JSON stream', true, true));
      if (!this.#stopped) {
        this.#envelopes.push({ kind: 'disconnected', cursor: this.#cursor(),
          reason: 'Pi RPC stdout was not a valid LF-delimited JSON stream' });
      }
      this.#envelopes.close();
    }
  }

  async #pumpStderr(): Promise<void> {
    try {
      for await (const chunk of this.child.stderr) {
        this.#stderrBytes += chunk.byteLength;
        this.#stderrChunks.push(chunk);
        // Provider diagnostics are bounded, hashed, and never merged into decisions.
        if (this.#stderrChunks.length > 64) this.#stderrChunks.splice(0, this.#stderrChunks.length - 64);
      }
    } catch { /* Provider diagnostics are hashed, never merged into decisions. */ }
  }

  #dispatch(record: Readonly<Record<string, unknown>>): void {
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.#pending.get(record.id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(record.id);
        if (record.success === true) {
          pending.resolve(record.data);
        } else {
          const detail = typeof record.error === 'string' ? record.error.slice(0, 300) : 'unknown error';
          pending.reject(new PiRpcProcessError('COMMAND_REJECTED',
            `Pi rejected ${String(record.command)}: ${detail}`, true, true));
        }
        return;
      }
    }
    if (record.type === 'queue_update' && this.#queueUpdateListeners.size > 0) {
      for (const listener of [...this.#queueUpdateListeners]) listener(record);
    }
    this.#envelopes.push({ kind: 'record', cursor: this.#cursor(), record });
  }

  #failPending(error: PiRpcProcessError): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }

  #cursor(): string {
    this.#sequence += 1;
    return `${this.epoch}:${this.#sequence}`;
  }
}

/**
 * One row of the OS process table, read with `ps -eo pid=,ppid=,pgid=,command=`.
 *
 * FOUNDATION-040 measured that killing a provider does *not* stop a tool it already started: the
 * orphan is reparented to PID 1 and keeps writing the workspace. It also measured that `pgrep -f`
 * does not find such a child reliably, so ownership is decided from this table (pid + ppid + pgid)
 * plus a per-PID start token, never from a display name or a command-line match.
 */
export interface ProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly command: string;
}

export async function readProcessTable(): Promise<readonly ProcessTableRow[]> {
  let exitCode: number;
  let stdout: string;
  try {
    const process = Bun.spawn(['ps', '-eo', 'pid=,ppid=,pgid=,command='], {
      stdout: 'pipe', stderr: 'ignore',
    });
    [exitCode, stdout] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  } catch (error) {
    throw new PiRpcProcessError('PROCESS_IDENTITY_UNAVAILABLE',
      `Could not read the process table: ${error instanceof Error ? error.message : String(error)}`,
      false, false);
  }
  if (exitCode !== 0) {
    throw new PiRpcProcessError('PROCESS_IDENTITY_UNAVAILABLE',
      `ps exited with ${exitCode}; process ownership cannot be verified`, false, false);
  }
  const rows: ProcessTableRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4] ?? '',
    });
  }
  return rows;
}

/** One process captured as part of a provider's process tree, with its identity token. */
export interface ProviderProcessRef {
  readonly pid: number;
  /** `readProcessStartToken` value at capture time; null when it could not be read. */
  readonly startToken: string | null;
  readonly command: string;
}

/**
 * The provider process tree as it was observed *while the provider was still alive*.
 *
 * This has to be captured early: once the provider dies its children are reparented, so their
 * lineage to the provider is no longer visible in the process table. What survives is the recorded
 * pid + start token of each descendant, which is what a later check compares against.
 */
export interface ProviderProcessTree {
  readonly pid: number;
  readonly startToken: string;
  readonly pgid: number | null;
  readonly descendants: readonly ProviderProcessRef[];
  readonly capturedAt: number;
  readonly note: string;
}

const maxProcessTreeSize = 500;

/**
 * Snapshots one provider process and its descendants while it is alive. `descendants` is a
 * by-value record of the pids it owned, not a claim that they still exist later.
 */
export async function captureProviderProcessTree(input: {
  readonly pid: number;
  readonly startToken: string;
  readonly now?: () => number;
  readonly readTable?: () => Promise<readonly ProcessTableRow[]>;
  readonly readStartToken?: (pid: number) => Promise<string | null>;
}): Promise<ProviderProcessTree> {
  const now = input.now ?? Date.now;
  const readTable = input.readTable ?? readProcessTable;
  const readStartToken = input.readStartToken ?? readProcessStartToken;
  const rows = await readTable();
  const self = rows.find((row) => row.pid === input.pid);
  const children = new Map<number, ProcessTableRow[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings === undefined) children.set(row.ppid, [row]);
    else siblings.push(row);
  }
  const descendants: ProviderProcessRef[] = [];
  const queue = [input.pid];
  const seen = new Set<number>([input.pid]);
  while (queue.length > 0 && descendants.length < maxProcessTreeSize) {
    const parent = queue.shift() as number;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
      descendants.push({
        pid: child.pid,
        startToken: await readStartToken(child.pid),
        command: child.command.slice(0, 200),
      });
    }
  }
  return {
    pid: input.pid,
    startToken: input.startToken,
    pgid: self?.pgid ?? null,
    descendants,
    capturedAt: now(),
    note: descendants.length >= maxProcessTreeSize
      ? `the descendant walk stopped at ${maxProcessTreeSize} processes`
      : 'the descendant walk completed',
  };
}

/**
 * What a forced termination of a recorded provider tree actually did (ADR-0058 D09).
 *
 * Every field is an observation, never a claim of quiescence: `terminated: true` means "no process
 * with a *recorded and verified* identity is still in the process table", which is the strongest
 * fact a process table can give. `unattributable` names the recorded pids that were still occupied
 * but whose start token was never captured — those are deliberately left alone, because a PID alone
 * is reusable and signalling the wrong process is worse than leaving an orphan.
 */
export interface ProviderTerminationOutcome {
  /** False when nothing could be attempted at all (for example the process table is unreadable). */
  readonly attempted: boolean;
  readonly signalsSent: number;
  /** True when no recorded process with a verified identity is still running. */
  readonly terminated: boolean;
  /** The pids actually signalled, in the order the signals were sent (may repeat across phases). */
  readonly signalled: readonly number[];
  /** Recorded pids still running after both phases, with their identity verified. */
  readonly survivors: readonly number[];
  /** Recorded pids that are occupied but had no captured start token, so they were not signalled. */
  readonly unattributable: readonly number[];
  readonly detail: string;
}

/** The default grace a `SIGTERM` gets before `SIGKILL`, and the `SIGKILL` gets before reporting. */
export const providerTerminationGraceMs = 2_000;

/** How often the process table is re-read while waiting out one grace period. */
const providerTerminationPollMs = 25;

/**
 * One phase of the verified-signal logic: which recorded processes are still ours right now.
 *
 * A pid is only "ours" when the start token read *now* equals the token recorded while the provider
 * was alive. A pid that is occupied by a different token belongs to somebody else and is neither
 * signalled nor counted as a survivor; a pid whose recorded token is null cannot be compared and is
 * therefore reported as unattributable instead of being signalled.
 */
async function verifiedProviderProcesses(input: {
  readonly tree: ProviderProcessTree;
  readonly readTable: () => Promise<readonly ProcessTableRow[]>;
  readonly readStartToken: (pid: number) => Promise<string | null>;
}): Promise<{ readonly alive: readonly number[]; readonly unattributable: readonly number[] }> {
  const rows = await input.readTable();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const alive: number[] = [];
  const unattributable: number[] = [];
  const recorded: readonly { readonly pid: number; readonly startToken: string | null }[] = [
    { pid: input.tree.pid, startToken: input.tree.startToken },
    ...input.tree.descendants.map((descendant) => ({
      pid: descendant.pid, startToken: descendant.startToken,
    })),
  ];
  for (const entry of recorded) {
    if (!byPid.has(entry.pid)) continue;
    if (entry.startToken === null) {
      unattributable.push(entry.pid);
      continue;
    }
    const token = await input.readStartToken(entry.pid);
    if (token === entry.startToken) alive.push(entry.pid);
  }
  return { alive, unattributable };
}

/**
 * Terminates the provider process tree a Task recorded, using only identities it recorded, and
 * reports what happened (ADR-0058 D09 — the `task purge --force` step).
 *
 * Scope and limits, deliberately:
 *
 * - Only the recorded pids are considered — never a process group and never a scan for "looks like a
 *   provider". A pid is signalled only when its start token still matches the recorded one, so a
 *   recycled pid is never hit. Recorded pids with no start token are reported as `unattributable`
 *   and left alone.
 * - `SIGTERM` first, one bounded grace period, then `SIGKILL` for the survivors, then one more bounded
 *   grace period. A process that survives both is reported as a survivor; this function never claims
 *   quiescence it did not observe.
 * - Errors are facts, not exceptions: a signal that fails because the process is already gone is
 *   simply a process that is gone. Nothing here throws, so the caller can record the attempt and go
 *   on with whatever it was doing.
 */
export async function terminateProviderProcessTree(input: {
  readonly tree: ProviderProcessTree;
  readonly graceMs?: number;
  readonly readTable?: () => Promise<readonly ProcessTableRow[]>;
  readonly readStartToken?: (pid: number) => Promise<string | null>;
  readonly signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<ProviderTerminationOutcome> {
  const graceMs = input.graceMs ?? providerTerminationGraceMs;
  const readTable = input.readTable ?? readProcessTable;
  const readStartToken = input.readStartToken ?? readProcessStartToken;
  const signal = input.signal ?? ((pid, kind) => { process.kill(pid, kind); });
  const sleep = input.sleep ?? (async (milliseconds) => { await Bun.sleep(milliseconds); });
  const signalled: number[] = [];
  let first: { readonly alive: readonly number[]; readonly unattributable: readonly number[] };
  try {
    first = await verifiedProviderProcesses({ tree: input.tree, readTable, readStartToken });
  } catch (error) {
    return { attempted: false, signalsSent: 0, terminated: false, signalled: [], survivors: [],
      unattributable: [],
      detail: 'the process table could not be read: '
        + `${error instanceof Error ? error.message : String(error)}` };
  }
  if (first.alive.length === 0) {
    return { attempted: false, signalsSent: 0, terminated: true, signalled: [], survivors: [],
      unattributable: first.unattributable,
      detail: first.unattributable.length === 0
        ? 'no recorded provider process was still running, so no signal was sent'
        : `no recorded provider process was still running; ${first.unattributable.length} recorded`
          + ` pid(s) are occupied without a captured start token and were not signalled: ${first.unattributable.join(', ')}` };
  }
  const sendAll = (kind: 'SIGTERM' | 'SIGKILL', pids: readonly number[]): void => {
    for (const pid of pids) {
      try {
        signal(pid, kind);
        signalled.push(pid);
      } catch {
        // ESRCH and friends: the process is already gone. The next verification pass decides.
      }
    }
  };
  const settle = async (): Promise<readonly number[]> => {
    let waited = 0;
    for (;;) {
      const observed = await verifiedProviderProcesses({ tree: input.tree, readTable, readStartToken });
      if (observed.alive.length === 0) return [];
      if (waited >= graceMs) return observed.alive;
      const step = Math.min(providerTerminationPollMs, graceMs - waited);
      await sleep(step);
      waited += step;
    }
  };
  sendAll('SIGTERM', first.alive);
  const afterTerm = await settle();
  if (afterTerm.length > 0) sendAll('SIGKILL', afterTerm);
  const survivors = afterTerm.length === 0 ? [] : await settle();
  // The unattributable set is read once more so the record describes the state after the signals.
  let unattributable = first.unattributable;
  try {
    unattributable = (await verifiedProviderProcesses({
      tree: input.tree, readTable, readStartToken,
    })).unattributable;
  } catch {
    // Keep the first reading: a table that cannot be read now does not invalidate what was seen.
  }
  return {
    attempted: true,
    signalsSent: signalled.length,
    terminated: survivors.length === 0,
    signalled,
    survivors,
    unattributable,
    detail: survivors.length === 0
      ? `sent ${signalled.length} signal(s) to the recorded provider tree; no recorded process with a`
        + ' verified identity is still running'
      : `sent ${signalled.length} signal(s) to the recorded provider tree but ${survivors.length}`
        + ` recorded process(es) are still running: ${survivors.join(', ')}`,
  };
}

/** What a later check can honestly say about a recorded provider process tree. */
export type ProviderOwnershipObservation =
  /** Nothing in the recorded tree is still running. */
  | { readonly state: 'STOPPED'; readonly detail: string }
  /** The provider process itself is still running with the recorded identity. */
  | { readonly state: 'ALIVE'; readonly detail: string; readonly pid: number }
  /** The provider is gone but a recorded tool child is still alive (the orphan risk). */
  | { readonly state: 'DESCENDANTS_ALIVE'; readonly detail: string; readonly descendants: readonly number[] }
  /** The check could not be completed; callers must refuse rather than assume quiescence. */
  | { readonly state: 'UNVERIFIABLE'; readonly detail: string };

/**
 * Decides whether a recorded provider tree is quiescent. Every branch that cannot compare a PID to
 * the identity captured earlier returns `UNVERIFIABLE`, because a PID alone is reusable and the
 * cost of wrongly assuming quiescence is two writers on one conversation.
 */
export async function inspectProviderProcessOwnership(input: {
  readonly tree: ProviderProcessTree;
  readonly readTable?: () => Promise<readonly ProcessTableRow[]>;
  readonly readStartToken?: (pid: number) => Promise<string | null>;
}): Promise<ProviderOwnershipObservation> {
  const readTable = input.readTable ?? readProcessTable;
  const readStartToken = input.readStartToken ?? readProcessStartToken;
  let rows: readonly ProcessTableRow[];
  try {
    rows = await readTable();
  } catch (error) {
    return { state: 'UNVERIFIABLE',
      detail: `the process table could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const self = byPid.get(input.tree.pid);
  if (self !== undefined) {
    let token: string | null;
    try {
      token = await readStartToken(input.tree.pid);
    } catch (error) {
      return { state: 'UNVERIFIABLE',
        detail: `the start token of ${input.tree.pid} could not be read: `
          + `${error instanceof Error ? error.message : String(error)}` };
    }
    if (token === null) {
      return { state: 'UNVERIFIABLE',
        detail: `no start token could be read for pid ${input.tree.pid}, so it cannot be compared`
          + ' with the recorded provider identity' };
    }
    if (token === input.tree.startToken) {
      return { state: 'ALIVE', pid: input.tree.pid,
        detail: `provider process ${input.tree.pid} is still running with the recorded start token` };
    }
    // The PID is occupied by a different process now; continue with the descendants instead of
    // attributing that process (or its children) to this Session.
  }
  const alive: number[] = [];
  for (const descendant of input.tree.descendants) {
    const row = byPid.get(descendant.pid);
    if (row === undefined) continue;
    if (descendant.startToken === null) {
      return { state: 'UNVERIFIABLE',
        detail: `pid ${descendant.pid} (recorded as "${descendant.command}") is occupied but its`
          + ' start token was never captured, so it cannot be attributed or cleared' };
    }
    let token: string | null;
    try {
      token = await readStartToken(descendant.pid);
    } catch (error) {
      return { state: 'UNVERIFIABLE',
        detail: `the start token of recorded descendant ${descendant.pid} could not be read: `
          + `${error instanceof Error ? error.message : String(error)}` };
    }
    if (token === null) {
      return { state: 'UNVERIFIABLE',
        detail: `no start token could be read for recorded descendant ${descendant.pid}` };
    }
    if (token === descendant.startToken) alive.push(descendant.pid);
  }
  if (alive.length > 0) {
    return { state: 'DESCENDANTS_ALIVE', descendants: alive,
      detail: `the provider process is gone but ${alive.length} recorded tool descendant(s) are`
        + ` still running: ${alive.join(', ')}` };
  }
  return { state: 'STOPPED',
    detail: `no process with the recorded provider identity (pid ${input.tree.pid}) and none of its`
      + ` ${input.tree.descendants.length} recorded descendant(s) are still running` };
}
