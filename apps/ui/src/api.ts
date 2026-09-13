import type { StreamFrame } from './types.js';

export interface CommandFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * Client for the Runtime's loopback HTTP surface.
 *
 * The token lives in memory/sessionStorage only; it is never placed in a request URL, so it cannot
 * leak through server-side logging. The Runtime rejects any request without it.
 */
export class RuntimeClient {
  readonly #base: string;
  readonly #token: string;

  constructor(base: string, token: string) {
    this.#base = base;
    this.#token = token;
  }

  /** Sends one command and returns its result, or throws with the Runtime's stable error code. */
  async command<T>(command: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.#base}/api/command`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        schemaVersion: 1,
        ...command,
      }),
    });
    if (response.status === 401) throw new UiError('UNAUTHORIZED', 'Runtime 拒绝了此令牌');
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new UiError('INVALID_RESPONSE', `Runtime 返回了状态码 ${response.status}，但响应不是 JSON`);
    }
    const envelope = body as { ok?: boolean; result?: unknown; error?: CommandFailure };
    if (envelope.ok === true) return envelope.result as T;
    const failure = envelope.error ?? { code: 'UNKNOWN', message: 'Runtime 未返回错误详情' };
    throw new UiError(failure.code, failure.message);
  }

  /**
   * Streams events until `signal` aborts. `since` is an exclusive cursor: pass the cursor printed
   * by a previous session to resume without gaps or duplicates.
   */
  async streamEvents(
    since: number | undefined,
    signal: AbortSignal,
    onFrame: (frame: StreamFrame) => void,
  ): Promise<void> {
    const query = since === undefined ? '' : `?sinceSequence=${since}`;
    const response = await fetch(`${this.#base}/api/events${query}`, {
      headers: { authorization: `Bearer ${this.#token}` },
      signal,
    });
    if (!response.ok || response.body === null) {
      throw new UiError('EVENT_STREAM_FAILED', `Runtime 拒绝了事件流请求（${response.status}）`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!signal.aborted) {
        const read = await reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
          const chunk = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = chunk.split('\n').find((line) => line.startsWith('data: '));
          if (data === undefined) continue;
          try {
            onFrame(JSON.parse(data.slice(6)) as StreamFrame);
          } catch {
            // A frame this client cannot parse is skipped rather than killing the stream; the
            // Runtime remains the validating boundary.
          }
        }
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
  }
}

export class UiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UiError';
    this.code = code;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof UiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
