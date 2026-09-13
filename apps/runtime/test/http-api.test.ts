import { afterEach, describe, expect, test } from 'bun:test';

// The ambient shell proxy would route loopback requests through it and break every fetch below.
// Browsers bypass loopback for this host by default; test clients must be told explicitly.
process.env.no_proxy = '127.0.0.1,localhost';
process.env.NO_PROXY = '127.0.0.1,localhost';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeRequest, RuntimeResponse, RuntimeStreamFrame } from '@codeestra/contracts';
import { EventSubscriptionHub } from '../src/event-subscription-service.js';
import { RuntimeHttpApi, UiAssetsMissingError } from '../src/http-api.js';
import { cleanupTemporaryDirectories, createAgentFixture, registerTemporaryDirectory,
  type AgentFixture } from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

interface Harness {
  readonly api: RuntimeHttpApi;
  readonly hub: EventSubscriptionHub;
  readonly url: string;
  readonly token: string;
  readonly fixture: AgentFixture;
  readonly dispatched: RuntimeRequest[];
  close(): void;
}

interface HarnessOptions {
  readonly withAssets?: boolean;
  /** When false the caller starts the service itself (for example to assert a start failure). */
  readonly start?: boolean;
  readonly keepAliveMs?: number;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const fixture = await createAgentFixture();
  const assetsRoot = mkdtempSync(join(tmpdir(), 'codeestra-ui-assets-'));
  registerTemporaryDirectory(assetsRoot);
  if (options.withAssets !== false) {
    await Bun.write(join(assetsRoot, 'index.html'), '<!doctype html><title>Codeestra</title><div id="root"></div>');
    await Bun.write(join(assetsRoot, 'app.js'), 'console.log("ui");');
  }
  const hub = new EventSubscriptionHub({ storage: fixture.storage });
  const dispatched: RuntimeRequest[] = [];
  const api = new RuntimeHttpApi({
    assetsRoot,
    subscriptions: hub,
    ...(options.keepAliveMs === undefined ? {} : { keepAliveMs: options.keepAliveMs }),
    dispatch: async (request: RuntimeRequest): Promise<RuntimeResponse> => {
      dispatched.push(request);
      return { requestId: request.requestId, schemaVersion: 1, ok: true, result: { echoed: request.command } };
    },
  });
  const endpoint = options.start === false ? { url: '', token: '' } : api.start();
  return {
    api,
    hub,
    url: endpoint.url,
    token: endpoint.token,
    fixture,
    dispatched,
    close: () => { api.stop(); hub.close(); fixture.storage.close(); },
  };
}

function baseUrl(url: string): string {
  return url.slice(0, url.indexOf('/#'));
}

async function command(
  value: Harness,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(`${baseUrl(value.url)}/api/command`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${value.token}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function request(command: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { requestId: crypto.randomUUID(), schemaVersion: 1, command, ...extra };
}

/** Reads SSE frames until `count` are collected or the deadline passes. */
async function readFrames(response: Response, count: number, timeoutMs = 3_000)
  : Promise<readonly RuntimeStreamFrame[]> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('The event stream had no body');
  const decoder = new TextDecoder();
  const frames: RuntimeStreamFrame[] = [];
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  while (frames.length < count && Date.now() < deadline) {
    const read = await reader.read();
    if (read.done === true) break;
    buffer += decoder.decode(read.value, { stream: true });
    for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = chunk.split('\n').find((line) => line.startsWith('data: '));
      if (data !== undefined) frames.push(JSON.parse(data.slice(6)) as RuntimeStreamFrame);
    }
  }
  void reader.cancel().catch(() => {});
  return frames;
}

describe('Runtime local HTTP surface', () => {
  test('serves assets without a token and rejects unauthorized or malformed commands', async () => {
    const value = await harness();
    const page = await fetch(`${baseUrl(value.url)}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Codeestra');
    expect((await fetch(`${baseUrl(value.url)}/app.js`)).status).toBe(200);
    // Unknown non-API paths fall back to the single-page shell.
    expect(await (await fetch(`${baseUrl(value.url)}/tasks/1`)).text()).toContain('Codeestra');

    const unauthorized = await fetch(`${baseUrl(value.url)}/api/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request('runtime.ping')),
    });
    expect(unauthorized.status).toBe(401);
    const wrongToken = await command(value, request('runtime.ping'),
      { authorization: 'Bearer not-the-token' });
    expect(wrongToken.status).toBe(401);
    expect(value.dispatched).toHaveLength(0);

    const foreignOrigin = await command(value, request('runtime.ping'),
      { origin: 'http://evil.example' });
    // A same-origin POST is accepted, so the 403 above is about the origin and not the token.
    expect((await command(value, request('runtime.ping'),
      { origin: baseUrl(value.url) })).status).toBe(200);
    expect(foreignOrigin.status).toBe(403);

    const badMediaType = await fetch(`${baseUrl(value.url)}/api/command`, {
      method: 'POST',
      headers: { authorization: `Bearer ${value.token}`, 'content-type': 'text/plain' },
      body: JSON.stringify(request('runtime.ping')),
    });
    expect(badMediaType.status).toBe(415);

    const unknownCommand = await command(value, { requestId: crypto.randomUUID(), schemaVersion: 1,
      command: 'task.nope' });
    expect(unknownCommand.status).toBe(400);

    // Streaming and UI-start are deliberately not reachable over HTTP.
    expect((await command(value, request('events.subscribe'))).status).toBe(400);
    expect((await command(value, request('runtime.ui'))).status).toBe(400);

    const accepted = await command(value, request('runtime.ping'));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true, result: { echoed: 'runtime.ping' } });
    // Only the two accepted pings reached the dispatcher; every rejected request above did not.
    expect(value.dispatched.map((entry) => entry.command)).toEqual(['runtime.ping', 'runtime.ping']);
    value.close();
  });

  test('refuses to start without built assets and releases the port on stop', async () => {
    const missing = await harness({ withAssets: false, start: false });
    expect(() => missing.api.start()).toThrow(UiAssetsMissingError);
    expect(missing.api.running).toBe(false);
    missing.close();

    const value = await harness();
    const origin = baseUrl(value.url);
    expect(await (await fetch(`${origin}/`)).text()).toContain('Codeestra');
    value.close();
    await expect(fetch(`${origin}/`)).rejects.toThrow();
  });

  test('streams the same exclusive-cursor event frames as the socket transport', async () => {
    const value = await harness();
    const origin = baseUrl(value.url);
    const first = await fetch(`${origin}/api/events?sinceSequence=0`, {
      headers: { authorization: `Bearer ${value.token}` },
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/event-stream');

    // The hub polls, so give it a moment to deliver the replayed events.
    await Bun.sleep(300);
    const frames = await readFrames(first, 1, 500);
    expect(frames.length).toBeGreaterThanOrEqual(1);

    const unauthorized = await fetch(`${origin}/api/events`, { headers: { authorization: 'nope' } });
    expect(unauthorized.status).toBe(401);
    const badCursor = await fetch(`${origin}/api/events?sinceSequence=-1`, {
      headers: { authorization: `Bearer ${value.token}` },
    });
    expect(badCursor.status).toBe(400);
    value.close();
  });

  test('reports a cursor ahead of the log as a terminal error frame', async () => {
    const value = await harness();
    const origin = baseUrl(value.url);
    const response = await fetch(`${origin}/api/events?sinceSequence=9999`, {
      headers: { authorization: `Bearer ${value.token}` },
    });
    await Bun.sleep(100);
    const frames = await readFrames(response, 1, 1_000);
    expect(frames[0]).toMatchObject({ type: 'error', code: 'INVALID_CURSOR' });
    value.close();
  });

  test('keeps a slow command connection alive instead of losing the response', async () => {
    // A `task.run` waits on a human answering a permission prompt, so the response can be silent for
    // minutes. Without a keepalive the server's idle timeout closes the connection first.
    const fixture = await createAgentFixture();
    const assetsRoot = mkdtempSync(join(tmpdir(), 'codeestra-ui-assets-'));
    registerTemporaryDirectory(assetsRoot);
    await Bun.write(join(assetsRoot, 'index.html'), '<!doctype html><title>Codeestra</title>');
    const hub = new EventSubscriptionHub({ storage: fixture.storage });
    const api = new RuntimeHttpApi({
      assetsRoot,
      subscriptions: hub,
      keepAliveMs: 50,
      dispatch: async (request: RuntimeRequest): Promise<RuntimeResponse> => {
        await Bun.sleep(400);
        return { requestId: request.requestId, schemaVersion: 1, ok: true, result: { slow: true } };
      },
    });
    const endpoint = api.start();
    const origin = endpoint.url.slice(0, endpoint.url.indexOf('/#'));
    const response = await fetch(`${origin}/api/command`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request('task.verify', {
        commandId: crypto.randomUUID(), projectId: crypto.randomUUID(), taskId: crypto.randomUUID(),
      })),
    });
    expect(response.status).toBe(200);
    // Whitespace keepalives are insignificant to the JSON body that arrives at the end.
    expect(await response.json()).toMatchObject({ ok: true, result: { slow: true } });
    api.stop();
    hub.close();
    fixture.storage.close();
  });

  test('start is idempotent and loopback-only', async () => {
    const value = await harness();
    const second = value.api.start();
    expect(second).toEqual({ url: value.url, token: value.token });
    expect(value.url).toContain('http://127.0.0.1:');
    // The token never appears in the part of the URL that reaches the server.
    expect(baseUrl(value.url)).not.toContain(value.token);
    value.close();
  });
});
