import { createHash } from 'node:crypto';
import {
  ClaudeAdapterError,
  ClaudeJsonlDecoder,
  ClaudeProtocolError,
  claudeControlError,
  claudeControlResponse,
  claudeFrameTypes,
  encodeClaudeRecord,
} from './claude-protocol.js';

export type ClaudeFrame =
  | {
      readonly kind: 'message';
      readonly cursor: string;
      readonly payload: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'control-request';
      readonly cursor: string;
      /** Stable string form of the request id; this is what an Attention carries. */
      readonly id: string;
      readonly subtype: string;
      readonly params: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: 'control-cancel'; readonly cursor: string; readonly requestId: string }
  | { readonly kind: 'disconnected'; readonly cursor: string; readonly reason: string };

type ClaudeChild = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

function createOutcome<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Waits for `promise` at most `ms`, and **clears the timer** either way. A `Bun.sleep` left inside a
 * `Promise.race` keeps the event loop alive (the defect ADR-0025 fixed for the Runtime shutdown), so
 * every deadline in this module goes through here.
 */
async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ readonly expired: false; readonly value: T } | { readonly expired: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ expired: false as const, value })),
      new Promise<{ readonly expired: true }>((resolve) => {
        timer = setTimeout(() => resolve({ expired: true as const }), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class FrameQueue {
  readonly #items: ClaudeFrame[] = [];
  readonly #waiters: ((result: IteratorResult<ClaudeFrame>) => void)[] = [];
  #done = false;

  push(frame: ClaudeFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(frame);
    else waiter({ value: frame, done: false });
  }

  /** Puts frames back in front of the queue, preserving their order. */
  unshift(frames: readonly ClaudeFrame[]): void {
    if (frames.length === 0) return;
    this.#items.unshift(...frames);
    while (this.#waiters.length > 0 && this.#items.length > 0) {
      const waiter = this.#waiters.shift() as (result: IteratorResult<ClaudeFrame>) => void;
      waiter({ value: this.#items.shift() as ClaudeFrame, done: false });
    }
  }

  close(): void {
    if (this.#done) return;
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  remove(waiter: (result: IteratorResult<ClaudeFrame>) => void): void {
    const index = this.#waiters.indexOf(waiter);
    if (index >= 0) this.#waiters.splice(index, 1);
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeFrame> {
    let waiting: ((result: IteratorResult<ClaudeFrame>) => void) | null = null;
    return {
      next: (): Promise<IteratorResult<ClaudeFrame>> => {
        const frame = this.#items.shift();
        if (frame !== undefined) return Promise.resolve({ value: frame, done: false });
        if (this.#done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => {
          waiting = resolve;
          this.#waiters.push(resolve);
        });
      },
      // Dropping a read must also drop its registration: an abandoned waiter would otherwise
      // swallow the next frame, which would silently lose a permission request.
      return: (): Promise<IteratorResult<ClaudeFrame>> => {
        if (waiting !== null) {
          this.remove(waiting);
          waiting = null;
        }
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

export interface ClaudePendingControlRequest {
  readonly id: string;
  readonly subtype: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * Owns one `claude --print --input-format stream-json` child's JSONL control channel.
 *
 * It never reattaches to a lost process and never treats stream silence as proof that the provider
 * stopped. Control requests from the CLI (permission prompts and dialog requests) are surfaced as
 * frames (not auto-answered): an unanswered permission request must stay unanswered, because the
 * provider holds the tool until its host replies.
 */
export class ClaudeStreamClient {
  readonly #frames = new FrameQueue();
  readonly #pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  readonly #controlRequests = new Map<string, ClaudePendingControlRequest>();
  readonly #decoder: ClaudeJsonlDecoder;
  readonly #stderrChunks: Uint8Array[] = [];
  #sequence = 0;
  #requestSequence = 0;
  #stderrBytes = 0;
  #exit: number | null = null;
  #stopped = false;
  #broken = false;
  #writes: Promise<void> = Promise.resolve();

  constructor(
    readonly child: ClaudeChild,
    readonly epoch: string,
    options: { readonly maxRecordBytes?: number; readonly requestTimeoutMs?: number } = {},
  ) {
    this.#decoder = new ClaudeJsonlDecoder(options.maxRecordBytes);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    void this.#pumpStdout();
    void this.#pumpStderr();
    void child.exited.then((code) => {
      this.#exit = code;
      this.#failPending(new ClaudeAdapterError('PROCESS_EXITED',
        `Claude exited with code ${code}`));
      if (!this.#stopped) {
        this.#frames.push({ kind: 'disconnected', cursor: this.#cursor(),
          reason: `Claude exited with code ${code}` });
      }
      this.#frames.close();
    }, () => {
      this.#failPending(new ClaudeAdapterError('PROCESS_EXITED',
        'Claude exit status is unavailable'));
      if (!this.#stopped) {
        this.#frames.push({ kind: 'disconnected', cursor: this.#cursor(),
          reason: 'Claude exit status is unavailable' });
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

  frames(): AsyncIterable<ClaudeFrame> {
    return this.#frames;
  }

  cursorPrefix(): string {
    return `${this.epoch}:`;
  }

  controlRequest(providerRequestId: string): ClaudePendingControlRequest | null {
    return this.#controlRequests.get(providerRequestId) ?? null;
  }

  pendingControlRequests(): readonly string[] {
    return [...this.#controlRequests.keys()];
  }

  /**
   * Sends one control request and waits for its `control_response`. Responses are routed here by the
   * stdout pump, so a caller iterating frames never has to see them.
   */
  async request(subtype: string, params: Readonly<Record<string, unknown>> = {},
    timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.#exit !== null || this.#broken) {
      throw new ClaudeAdapterError('PROCESS_EXITED', 'Claude is no longer running');
    }
    const id = `codeestra-${++this.#requestSequence}`;
    const outcome = createOutcome<unknown>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      outcome.reject(new ClaudeAdapterError('REQUEST_TIMEOUT',
        `Claude did not answer the ${subtype} request within ${timeoutMs} ms`));
    }, timeoutMs);
    this.#pending.set(id, { resolve: outcome.resolve, reject: outcome.reject, timer });
    try {
      await this.write({ type: claudeFrameTypes.controlRequest, request_id: id,
        request: { subtype, ...params } });
    } catch (error) {
      clearTimeout(timer);
      this.#pending.delete(id);
      throw error;
    }
    return outcome.promise;
  }

  /** Answers one control request. A request can only be answered once. */
  async respond(providerRequestId: string, result: Readonly<Record<string, unknown>>): Promise<void> {
    const request = this.#controlRequests.get(providerRequestId);
    if (request === undefined) {
      throw new ClaudeAdapterError('UNKNOWN_PROVIDER_REQUEST',
        `No open Claude request ${providerRequestId} is held by this Adapter`, false, false);
    }
    // The write happens first so a transport failure leaves the request answerable: the Runtime may
    // then report an uncertain delivery instead of a definite rejection it cannot retry.
    await this.write(claudeControlResponse({ requestId: request.id, result }));
    this.#controlRequests.delete(providerRequestId);
  }

  /** Refuses a control request this Adapter does not implement. */
  async respondUnsupported(providerRequestId: string, message: string): Promise<void> {
    const request = this.#controlRequests.get(providerRequestId);
    if (request === undefined) return;
    await this.write(claudeControlError({ requestId: request.id, message }));
    this.#controlRequests.delete(providerRequestId);
  }

  /** Sends one frame. Writes are serialized: two concurrent senders must not interleave. */
  async write(frame: Readonly<Record<string, unknown>>): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = encodeClaudeRecord(frame);
    } catch (error) {
      if (error instanceof ClaudeProtocolError) {
        throw new ClaudeAdapterError('TRANSPORT_WRITE_FAILED', error.message);
      }
      throw error;
    }
    const queued = this.#writes.then(async () => {
      if (this.#exit !== null) {
        throw new ClaudeAdapterError('PROCESS_EXITED', 'Claude is no longer running', false, true);
      }
      try {
        this.child.stdin.write(bytes);
        await this.child.stdin.flush();
      } catch {
        throw new ClaudeAdapterError('TRANSPORT_WRITE_FAILED',
          'Could not write to the Claude stdin', false, true);
      }
    });
    // A failed write must not poison the chain for later sends.
    this.#writes = queued.then(() => undefined, () => undefined);
    return await queued;
  }

  /**
   * Reads frames until `predicate` matches, then puts every skipped frame back in order so the
   * Session's own observer still sees it. Used once, before observation starts.
   *
   * Returns `null` on timeout or stream end. A timed-out read deregisters itself first, so the next
   * frame is never swallowed by an abandoned reader.
   */
  async takeUntil(
    predicate: (frame: ClaudeFrame) => boolean,
    timeoutMs: number,
  ): Promise<ClaudeFrame | null> {
    const skipped: ClaudeFrame[] = [];
    const iterator = this.#frames[Symbol.asyncIterator]();
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        const next = await withDeadline(iterator.next(), remaining);
        if (next.expired) return null;
        if (next.value.done) return null;
        const frame = next.value.value;
        if (frame === undefined) return null;
        if (predicate(frame)) return frame;
        skipped.push(frame);
      }
    } finally {
      if (iterator.return !== undefined) await iterator.return();
      this.#frames.unshift(skipped);
    }
  }

  /** Stops our own child. Never claims success unless the OS reported the exit. */
  async stop(input: { readonly graceMs: number }): Promise<{ readonly exited: boolean; readonly pid: number }> {
    this.#stopped = true;
    if (this.#exit !== null) return { exited: true, pid: this.pid };
    // Closing stdin ends a `--print` session gracefully: the CLI exits after finishing the turn it
    // is on. Only a CLI that ignores EOF is signalled.
    try {
      this.child.stdin.end();
    } catch { /* The process may have exited already. */ }
    if (await this.#awaitExit(input.graceMs)) return { exited: true, pid: this.pid };
    try {
      this.child.kill('SIGTERM');
    } catch { /* Fall through to the exit check below. */ }
    if (await this.#awaitExit(input.graceMs)) return { exited: true, pid: this.pid };
    try {
      this.child.kill('SIGKILL');
    } catch { /* Fall through to the exit check below. */ }
    return { exited: await this.#awaitExit(input.graceMs), pid: this.pid };
  }

  async #awaitExit(graceMs: number): Promise<boolean> {
    const outcome = await withDeadline(this.child.exited.then((code) => {
      this.#exit = code;
      return true;
    }, () => true), graceMs);
    if (outcome.expired) return false;
    return outcome.value;
  }

  async #pumpStdout(): Promise<void> {
    try {
      for await (const chunk of this.child.stdout) {
        for (const record of this.#decoder.push(chunk)) this.#dispatch(record);
      }
      for (const record of this.#decoder.finish()) this.#dispatch(record);
    } catch {
      this.#broken = true;
      this.#failPending(new ClaudeAdapterError('TRANSPORT_STREAM_INVALID',
        'Claude stdout was not a valid LF-delimited JSON stream'));
      if (!this.#stopped) {
        this.#frames.push({ kind: 'disconnected', cursor: this.#cursor(),
          reason: 'Claude stdout was not a valid LF-delimited JSON stream' });
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
    const type = record['type'];
    if (type === claudeFrameTypes.controlResponse) {
      const envelope = record['response'];
      if (typeof envelope !== 'object' || envelope === null) return;
      const response = envelope as Readonly<Record<string, unknown>>;
      const requestId = typeof response['request_id'] === 'string' ? response['request_id'] : null;
      if (requestId === null) return;
      const pending = this.#pending.get(requestId);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      if (response['subtype'] === 'error') {
        pending.reject(new ClaudeAdapterError('COMMAND_REJECTED',
          `Claude rejected a control request: ${bounded(response['error'], 200)}`));
        return;
      }
      pending.resolve(response['response']);
      return;
    }
    if (type === claudeFrameTypes.controlRequest) {
      const rawId = record['request_id'];
      const request = record['request'];
      if (rawId === undefined || typeof request !== 'object' || request === null) return;
      const params = request as Readonly<Record<string, unknown>>;
      const subtype = params['subtype'];
      if (typeof subtype !== 'string') return;
      const id = String(rawId);
      this.#controlRequests.set(id, { id, subtype, params });
      this.#frames.push({ kind: 'control-request', cursor: this.#cursor(), id, subtype, params });
      return;
    }
    if (type === claudeFrameTypes.controlCancelRequest) {
      // The CLI withdrew a request it can no longer use (for example a prompt left behind by an
      // interrupted turn). Any answer sent afterwards is refused by the provider, so the pending
      // entry is dropped here and a late answer becomes an honest delivery failure.
      const rawId = record['request_id'];
      if (rawId === undefined) return;
      const requestId = String(rawId);
      this.#controlRequests.delete(requestId);
      this.#frames.push({ kind: 'control-cancel', cursor: this.#cursor(), requestId });
      return;
    }
    this.#frames.push({ kind: 'message', cursor: this.#cursor(), payload: record });
  }

  #failPending(error: ClaudeAdapterError): void {
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

function bounded(value: unknown, limit: number): string {
  try {
    return JSON.stringify(value).slice(0, limit);
  } catch {
    return String(value).slice(0, limit);
  }
}
