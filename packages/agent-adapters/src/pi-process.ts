import { createHash } from 'node:crypto';
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
  | 'INVALID_PROVIDER_RESPONSE';

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
