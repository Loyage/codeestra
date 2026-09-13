import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeRequest, RuntimeResponse, RuntimeStreamFrame } from '@codeestra/contracts';
import { runtimeRequestSchema } from '@codeestra/contracts';
import type { EventSubscriptionHub } from './event-subscription-service.js';

export interface UiEndpoint {
  /** Address to open in a browser. The token is in the fragment, so it never reaches the server. */
  readonly url: string;
  /** Bearer token for `/api/*`. Held in Runtime memory only. */
  readonly token: string;
}

export interface RuntimeHttpApiOptions {
  /** Directory containing the built UI assets (index.html plus hashed bundles). */
  readonly assetsRoot: string;
  readonly subscriptions: EventSubscriptionHub;
  readonly dispatch: (request: RuntimeRequest) => Promise<RuntimeResponse>;
  readonly hostname?: string;
  readonly port?: number;
  /**
   * While a command is still running, the server writes a whitespace keepalive this often, so the
   * connection is not considered idle and closed before the response can be delivered. A long
   * `task.run` waits on a human answering a permission prompt, which takes far longer than the
   * server's idle timeout.
   */
  readonly keepAliveMs?: number;
}

const contentTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  return (dot === -1 ? undefined : contentTypes[path.slice(dot)]) ?? 'application/octet-stream';
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Local-only HTTP surface for the UI.
 *
 * Security boundary: loopback binding, a per-start in-memory bearer token, same-origin checks, and
 * no CORS headers. The endpoint is read/write against the *same* command dispatcher the CLI uses,
 * so the UI cannot reach behaviour the CLI cannot. Every request is validated with the shared Zod
 * request schema before dispatch, exactly like the socket transport.
 */
export class RuntimeHttpApi {
  readonly #assetsRoot: string;
  readonly #subscriptions: EventSubscriptionHub;
  readonly #dispatch: (request: RuntimeRequest) => Promise<RuntimeResponse>;
  readonly #hostname: string;
  readonly #configuredPort: number;
  readonly #keepAliveMs: number;
  #server: ReturnType<typeof Bun.serve> | null = null;
  #endpoint: UiEndpoint | null = null;

  constructor(options: RuntimeHttpApiOptions) {
    this.#assetsRoot = options.assetsRoot;
    this.#subscriptions = options.subscriptions;
    this.#dispatch = options.dispatch;
    this.#hostname = options.hostname ?? '127.0.0.1';
    this.#configuredPort = options.port ?? 0;
    this.#keepAliveMs = options.keepAliveMs ?? 10_000;
  }

  get endpoint(): UiEndpoint | null {
    return this.#endpoint;
  }

  get running(): boolean {
    return this.#server !== null;
  }

  /** Starts the service once; repeated calls return the same address and token. */
  start(): UiEndpoint {
    if (this.#endpoint !== null) return this.#endpoint;
    if (!existsSync(join(this.#assetsRoot, 'index.html'))) {
      throw new UiAssetsMissingError(this.#assetsRoot);
    }
    const token = randomBytes(32).toString('hex');
    const server = Bun.serve({
      hostname: this.#hostname,
      port: this.#configuredPort,
      // Bun closes idle connections after 10s by default, which kills a subscriber connection
      // during a quiet stretch between heartbeats. The hub heartbeats every 15s.
      idleTimeout: 120,
      fetch: (request) => this.#handle(request, token),
    });
    this.#server = server;
    this.#endpoint = {
      url: `http://${this.#hostname}:${server.port}/#token=${token}`,
      token,
    };
    return this.#endpoint;
  }

  stop(): void {
    this.#server?.stop(true);
    this.#server = null;
    this.#endpoint = null;
  }

  async #handle(request: Request, token: string): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/command') return this.#handleCommand(request, token);
    if (url.pathname === '/api/events') return this.#handleEvents(request, token);
    if (url.pathname.startsWith('/api/')) return json({ error: 'NOT_FOUND' }, 404);
    return this.#serveAsset(url.pathname);
  }

  async #handleCommand(request: Request, token: string): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
    if (!this.#authorized(request, token)) return json({ error: 'UNAUTHORIZED' }, 401);
    if (!this.#sameOrigin(request)) return json({ error: 'FOREIGN_ORIGIN' }, 403);
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'INVALID_JSON' }, 400);
    }
    try {
      // Same schema as the socket transport: the HTTP surface adds no new command semantics.
      const parsed = runtimeRequestSchema.safeParse(body);
      if (!parsed.success) return json({ error: 'INVALID_REQUEST' }, 400);
      if (parsed.data.command === 'events.subscribe' || parsed.data.command === 'runtime.ui') {
        return json({ error: 'NOT_AVAILABLE_OVER_HTTP' }, 400);
      }
      return this.#dispatchStreaming(parsed.data);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        && typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';
      const message = error instanceof Error ? error.message : 'Unknown Runtime error';
      return json({ error: code, message }, 500);
    }
  }

  /**
   * Dispatches one command, keeping the connection alive with whitespace for as long as the command
   * runs. Whitespace is insignificant to JSON parsers, so a fast command still returns exactly the
   * compact JSON body: the keepalive timer only starts after the first interval has passed.
   */
  #dispatchStreaming(request: RuntimeRequest): Response {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const write = (text: string): void => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // The peer is gone; the command itself keeps running under Runtime control.
          }
        };
        timer = setInterval(() => { write('\n'); }, this.#keepAliveMs);
        timer.unref?.();
        void this.#dispatch(request).then(
          (response) => { write(JSON.stringify(response)); },
          (error: unknown) => {
            const code = typeof error === 'object' && error !== null && 'code' in error
              && typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR';
            write(JSON.stringify({
              requestId: request.requestId, schemaVersion: 1, ok: false,
              error: { code, message: error instanceof Error ? error.message : String(error) },
            }));
          },
        ).finally(() => {
          if (timer !== null) clearInterval(timer);
          try { controller.close(); } catch { /* already closed */ }
        });
      },
      cancel: () => { if (timer !== null) clearInterval(timer); },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  #handleEvents(request: Request, token: string): Response {
    if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
    if (!this.#authorized(request, token)) return json({ error: 'UNAUTHORIZED' }, 401);
    const url = new URL(request.url);
    const rawSince = url.searchParams.get('sinceSequence');
    let sinceSequence: number | undefined;
    if (rawSince !== null) {
      const parsed = Number(rawSince);
      if (!Number.isSafeInteger(parsed) || parsed < 0) return json({ error: 'INVALID_CURSOR' }, 400);
      sinceSequence = parsed;
    }
    const projectId = url.searchParams.get('projectId') ?? undefined;
    const encoder = new TextEncoder();
    let subscription: { close(): void } | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const write = (text: string): boolean => {
          try {
            controller.enqueue(encoder.encode(text));
            return true;
          } catch {
            return false;
          }
        };
        const writeFrame = (frame: RuntimeStreamFrame): boolean =>
          write(`data: ${JSON.stringify(frame)}\n\n`);
        // An immediate comment flushes headers so the client knows the stream is live.
        write(': connected\n\n');
        try {
          subscription = this.#subscriptions.subscribe({
            requestId: crypto.randomUUID(),
            ...(projectId === undefined ? {} : { projectId }),
            ...(sinceSequence === undefined ? {} : { sinceSequence }),
            send: writeFrame,
            onStop: () => { try { controller.close(); } catch { /* already closed */ } },
          });
        } catch (error) {
          writeFrame({
            schemaVersion: 1, type: 'error', code: 'SUBSCRIPTION_FAILED',
            message: error instanceof Error ? error.message : String(error),
          });
          controller.close();
        }
      },
      cancel: () => { subscription?.close(); },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  async #serveAsset(pathname: string): Promise<Response> {
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    // Reject traversal and absolute paths before touching the filesystem.
    if (relative.includes('..') || relative.startsWith('/') || relative.includes('\0')) {
      return json({ error: 'NOT_FOUND' }, 404);
    }
    const file = Bun.file(join(this.#assetsRoot, relative));
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          'content-type': contentTypeFor(relative),
          // The UI holds its token in sessionStorage, so caching assets is safe and keeps reloads fast.
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    // Single-page app: unknown non-API paths fall back to the shell.
    const index = Bun.file(join(this.#assetsRoot, 'index.html'));
    if (await index.exists()) {
      return new Response(index, {
        headers: { 'content-type': contentTypes['.html'] as string, 'cache-control': 'no-store' },
      });
    }
    return json({ error: 'NOT_FOUND' }, 404);
  }

  #authorized(request: Request, token: string): boolean {
    const header = request.headers.get('authorization') ?? '';
    const prefix = 'Bearer ';
    if (!header.startsWith(prefix)) return false;
    return constantTimeEquals(header.slice(prefix.length), token);
  }

  #sameOrigin(request: Request): boolean {
    const origin = request.headers.get('origin');
    // A missing Origin means a non-browser client (for example curl); the token still applies.
    if (origin === null) return true;
    try {
      const url = new URL(origin);
      return url.hostname === this.#hostname && Number(url.port) === this.#server?.port;
    } catch {
      return false;
    }
  }
}

export class UiAssetsMissingError extends Error {
  readonly code = 'UI_ASSETS_MISSING';
  constructor(readonly assetsRoot: string) {
    super(`The UI assets were not found at ${assetsRoot}. Build them with: bun run --cwd apps/ui build`);
    this.name = 'UiAssetsMissingError';
  }
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
