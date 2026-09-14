import { createHash } from 'node:crypto';
import {
  CodexAdapterError,
  CodexJsonlDecoder,
  CodexProtocolError,
  encodeCodexRecord,
} from './codex-protocol.js';

export type CodexFrame =
  | {
      readonly kind: 'notification';
      readonly cursor: string;
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'server-request';
      readonly cursor: string;
      /** Stable string form of the JSON-RPC id; this is what an Attention carries. */
      readonly id: string;
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'disconnected'; readonly cursor: string; readonly reason: string };

type CodexChild = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

function createOutcome<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class AsyncQueue<T> {
  readonly #items: T[] = [];
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

export interface CodexPendingServerRequest {
  readonly id: string;
  readonly rawId: unknown;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * Owns one `codex app-server --stdio` child's JSONL JSON-RPC channel.
 *
 * It never reattaches to a lost process and never treats stream silence as proof that Codex
 * stopped writing. Server-to-client requests are surfaced as frames (not auto-answered), because an
 * unanswered approval must stay unanswered: Codex measured as fail-closed until the client replies.
 */
export class CodexAppServerClient {
  readonly #frames = new AsyncQueue<CodexFrame>();
  readonly #pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  readonly #serverRequests = new Map<string, CodexPendingServerRequest>();
  readonly #decoder: CodexJsonlDecoder;
  readonly #stderrChunks: Uint8Array[] = [];
  #sequence = 0;
  #requestSequence = 0;
  #stderrBytes = 0;
  #exit: number | null = null;
  #stopped = false;
  #broken = false;

  constructor(
    readonly child: CodexChild,
    readonly epoch: string,
    options: { readonly maxRecordBytes?: number; readonly requestTimeoutMs?: number } = {},
  ) {
    this.#decoder = new CodexJsonlDecoder(options.maxRecordBytes);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    void this.#pumpStdout();
    void this.#pumpStderr();
    void child.exited.then((code) => {
      this.#exit = code;
      this.#failPending(new CodexAdapterError('PROCESS_EXITED',
        `Codex app-server exited with code ${code}`));
      if (!this.#stopped) {
        this.#frames.push({ kind: 'disconnected', cursor: this.#cursor(),
          reason: `Codex app-server exited with code ${code}` });
      }
      this.#frames.close();
    }, () => {
      this.#failPending(new CodexAdapterError('PROCESS_EXITED',
        'Codex app-server exit status is unavailable'));
      if (!this.#stopped) {
        this.#frames.push({ kind: 'disconnected', cursor: this.#cursor(),
          reason: 'Codex app-server exit status is unavailable' });
      }
      this.#frames.close();
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

  frames(): AsyncIterable<CodexFrame> {
    return this.#frames;
  }

  cursorPrefix(): string {
    return `${this.epoch}:`;
  }

  serverRequest(providerRequestId: string): CodexPendingServerRequest | null {
    return this.#serverRequests.get(providerRequestId) ?? null;
  }

  async initialize(clientName: { readonly name: string; readonly version: string }): Promise<void> {
    await this.request('initialize', { clientInfo: clientName });
  }

  async request(method: string, params: Readonly<Record<string, unknown>>,
    timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.#exit !== null || this.#broken) {
      throw new CodexAdapterError('PROCESS_EXITED', 'Codex app-server is no longer running');
    }
    const id = `codeestra-${++this.#requestSequence}`;
    const outcome = createOutcome<unknown>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      outcome.reject(new CodexAdapterError('REQUEST_TIMEOUT',
        `Codex ${method} did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
    this.#pending.set(id, { resolve: outcome.resolve, reject: outcome.reject, timer });
    try {
      await this.write({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      clearTimeout(timer);
      this.#pending.delete(id);
      throw error;
    }
    return outcome.promise;
  }

  /** Answers one server-to-client request. A request can only be answered once. */
  async respond(providerRequestId: string, result: unknown): Promise<void> {
    const request = this.#serverRequests.get(providerRequestId);
    if (request === undefined) {
      throw new CodexAdapterError('UNKNOWN_PROVIDER_REQUEST',
        `No open Codex request ${providerRequestId} is held by this Adapter`, false, false);
    }
    // The write happens first so a transport failure leaves the request answerable: the Runtime
    // may then report an uncertain delivery instead of a definite rejection it cannot retry.
    await this.write({ jsonrpc: '2.0', id: request.rawId, result });
    this.#serverRequests.delete(providerRequestId);
  }

  /** Refuses a server-to-client request this Adapter does not implement. */
  async respondUnsupported(providerRequestId: string, message: string): Promise<void> {
    const request = this.#serverRequests.get(providerRequestId);
    if (request === undefined) return;
    await this.write({ jsonrpc: '2.0', id: request.rawId,
      error: { code: -32601, message } });
    this.#serverRequests.delete(providerRequestId);
  }

  async write(frame: Readonly<Record<string, unknown>>): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = encodeCodexRecord(frame);
    } catch (error) {
      if (error instanceof CodexProtocolError) {
        throw new CodexAdapterError('TRANSPORT_WRITE_FAILED', error.message);
      }
      throw error;
    }
    try {
      this.child.stdin.write(bytes);
      await this.child.stdin.flush();
    } catch {
      throw new CodexAdapterError('TRANSPORT_WRITE_FAILED',
        'Could not write to the Codex app-server stdin');
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
      this.#failPending(new CodexAdapterError('TRANSPORT_STREAM_INVALID',
        'Codex stdout was not a valid LF-delimited JSON stream'));
      if (!this.#stopped) {
        this.#frames.push({ kind: 'disconnected', cursor: this.#cursor(),
          reason: 'Codex stdout was not a valid LF-delimited JSON stream' });
      }
      this.#frames.close();
    }
  }

  async #pumpStderr(): Promise<void> {
    try {
      for await (const chunk of this.child.stderr) {
        this.#stderrBytes += chunk.byteLength;
        this.#stderrChunks.push(chunk);
        // Provider diagnostics are bounded, hashed, and never merged into decisions.
        if (this.#stderrChunks.length > 64) {
          this.#stderrChunks.splice(0, this.#stderrChunks.length - 64);
        }
      }
    } catch { /* Provider diagnostics are hashed, never merged into decisions. */ }
  }

  #dispatch(record: Readonly<Record<string, unknown>>): void {
    const method = record['method'];
    const id = record['id'];
    if (typeof method === 'string' && id !== undefined) {
      const key = String(id);
      const params = (typeof record['params'] === 'object' && record['params'] !== null
        ? record['params'] : {}) as Readonly<Record<string, unknown>>;
      this.#serverRequests.set(key, { id: key, rawId: id, method, params });
      this.#frames.push({ kind: 'server-request', cursor: this.#cursor(), id: key, method, params });
      return;
    }
    if (typeof method === 'string') {
      const params = (typeof record['params'] === 'object' && record['params'] !== null
        ? record['params'] : {}) as Readonly<Record<string, unknown>>;
      this.#frames.push({ kind: 'notification', cursor: this.#cursor(), method, params });
      return;
    }
    if (id !== undefined) {
      const pending = this.#pending.get(String(id));
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.#pending.delete(String(id));
        if (record['error'] !== undefined) {
          pending.reject(new CodexAdapterError('COMMAND_REJECTED',
            `Codex rejected a request: ${boundedError(record['error'])}`));
        } else {
          pending.resolve(record['result']);
        }
        return;
      }
    }
  }

  #failPending(error: CodexAdapterError): void {
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

function boundedError(error: unknown): string {
  try {
    return JSON.stringify(error).slice(0, 300);
  } catch {
    return String(error).slice(0, 300);
  }
}
