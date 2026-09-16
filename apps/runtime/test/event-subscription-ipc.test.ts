import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runtimeStreamFrameSchema, type RuntimeRequest, type RuntimeStreamFrame,
  type ProjectIdentity } from '@codeestra/contracts';
import { git, provisionDevClone } from './support/agent-fixture.js';
import {
  reclaimTestResources,
  registerRuntimeProcess,
  registerTemporaryDirectory,
} from './support/runtime-reclamation.js';

/**
 * End-to-end proof over the real Unix socket: the Runtime must serve one-shot commands and
 * long-lived event subscriptions from the same listener, and a subscriber must observe events
 * committed *after* it connected rather than only a replay.
 */
const runtimeEntry = resolve(import.meta.dir, '../src/main.ts');

// FOUNDATION-057: teardown stops every Runtime this file started and removes its fixtures, on the
// success path and on the failure path, by the identity recorded in this file's own temporary home.
afterEach(async () => { await reclaimTestResources(); });

/** Distributive Omit keeps each command's own fields instead of collapsing the union. */
type ClientRequest = RuntimeRequest extends infer Request
  ? Request extends RuntimeRequest ? Omit<Request, 'requestId' | 'schemaVersion'> : never
  : never;

interface RuntimeHarness {
  readonly home: string;
  readonly repo: string;
  /** The dev clone ADR-0056 requires: every dev fact, including a Task baseline, comes from it. */
  readonly devRepo: string;
  readonly socketPath: string;
}

async function startRuntime(): Promise<RuntimeHarness> {
  const repo = mkdtempSync(join(tmpdir(), 'codeestra-ipc-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'codeestra-ipc-home-'));
  registerTemporaryDirectory(repo);
  registerTemporaryDirectory(home);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await Bun.write(join(repo, 'README.md'), 'temporary repository\n');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'initial']);
  // ADR-0009: trust requires the long-lived dev branch; it is the workspace baseline.
  await git(repo, ['branch', 'dev']);
  // ADR-0056: the long-lived dev branch is read from a second clone of the same origin.
  const devRepo = await provisionDevClone({ repository: repo });
  const child = Bun.spawn([process.execPath, 'run', runtimeEntry], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    env: { ...Bun.env, CODEESTRA_HOME: home },
  });
  registerRuntimeProcess(child.pid, home);
  const harness = { home, repo, devRepo, socketPath: join(home, 'runtime.sock') } as const;
  await waitForRuntime(harness);
  return harness;
}

function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

async function waitForRuntime(harness: RuntimeHarness, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await call(harness, { command: 'runtime.ping' });
      return;
    } catch {
      await sleep(20);
    }
  }
  throw new Error('The Runtime did not become ready');
}

/** One-shot client: one command, one response, connection closed by the Runtime. */
function call(harness: RuntimeHarness, command: ClientRequest): Promise<Record<string, unknown>> {
  return new Promise((settle, reject) => {
    let buffer = '';
    void Bun.connect({
      unix: harness.socketPath,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify({ ...command, requestId: crypto.randomUUID(), schemaVersion: 1 })}\n`);
        },
        data(socket, bytes) {
          buffer += new TextDecoder().decode(bytes);
          const newline = buffer.indexOf('\n');
          if (newline === -1) return;
          socket.end();
          const response = JSON.parse(buffer.slice(0, newline)) as
            { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } };
          if (response.ok) settle(response.result ?? {});
          else reject(new Error(`${response.error?.code}: ${response.error?.message}`));
        },
        error(_socket, error) { reject(error); },
        close() { if (!buffer.includes('\n')) reject(new Error('Runtime closed without a response')); },
      },
    }).catch(reject);
  });
}

class Subscriber {
  readonly frames: RuntimeStreamFrame[] = [];
  closed = false;
  #socket: Bun.Socket<{ buffer: string }> | null = null;

  static async connect(
    harness: RuntimeHarness,
    command: Omit<Extract<RuntimeRequest, { command: 'events.subscribe' }>, 'requestId' | 'schemaVersion'>,
  ): Promise<Subscriber> {
    const subscriber = new Subscriber();
    await new Promise<void>((ready, reject) => {
      void Bun.connect<{ buffer: string }>({
        unix: harness.socketPath,
        socket: {
          open(socket) {
            subscriber.#socket = socket;
            socket.data = { buffer: '' };
            socket.write(`${JSON.stringify({ ...command, requestId: crypto.randomUUID(), schemaVersion: 1 })}\n`);
            ready();
          },
          data(socket, bytes) {
            socket.data.buffer += new TextDecoder().decode(bytes);
            for (let newline = socket.data.buffer.indexOf('\n'); newline !== -1;
              newline = socket.data.buffer.indexOf('\n')) {
              const line = socket.data.buffer.slice(0, newline);
              socket.data.buffer = socket.data.buffer.slice(newline + 1);
              subscriber.frames.push(runtimeStreamFrameSchema.parse(JSON.parse(line)));
            }
          },
          error(_socket, error) { reject(error); },
          close() { subscriber.closed = true; },
        },
      }).catch(reject);
    });
    return subscriber;
  }

  events(): readonly { cursor: number; eventType: string; taskId: string | null }[] {
    return this.frames.flatMap((frame) => frame.type === 'event' ? [{
      cursor: frame.cursor,
      eventType: frame.event.eventType,
      taskId: typeof frame.event.payload === 'object' && frame.event.payload !== null
        && 'taskId' in frame.event.payload ? String(frame.event.payload.taskId) : null,
    }] : []);
  }

  cursors(): readonly number[] {
    return this.frames.flatMap((frame) => frame.type === 'event' ? [frame.cursor] : []);
  }

  close(): void {
    this.#socket?.end();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('Timed out waiting for the expected subscription state');
}

async function trustedProject(harness: RuntimeHarness): Promise<string> {
  const identity = (await call(harness, {
    command: 'project.inspect', path: harness.repo,
  })) as unknown as ProjectIdentity;
  await call(harness, {
    command: 'project.trust',
    path: harness.repo,
    expectedIdentity: identity,
    expectedVerificationPolicy: { state: 'ABSENT', mainCommit: identity.headCommit },
  });
  const projects = (await call(harness, { command: 'project.list' })) as unknown as
    { id: string; repoRoot: string }[];
  const project = projects.find((candidate) => candidate.repoRoot === identity.repoRoot);
  if (project === undefined) throw new Error('The trusted project was not recorded');
  return project.id;
}

describe('Runtime event subscription over the IPC socket', () => {
  test('replays the log and then streams events committed while connected', async () => {
    const harness = await startRuntime();
    const projectId = await trustedProject(harness);
    const first = (await call(harness, {
      command: 'task.create', commandId: crypto.randomUUID(), projectId,
      specification: 'First task', constraints: [], features: [], kind: 'DEVELOPMENT',
    })) as unknown as { id: string };

    const subscriber = await Subscriber.connect(harness, { command: 'events.subscribe', sinceSequence: 0 });
    await waitFor(() => subscriber.events().some((event) => event.eventType === 'TaskCreated'));
    const handshake = subscriber.frames[0];
    expect(handshake?.type).toBe('subscribed');
    // Project trust is recorded in its own tables, so the log starts with the Task's own intents.
    expect(subscriber.events().map((event) => event.eventType))
      .toEqual(['IntentRecorded', 'TaskCreated']);
    expect(subscriber.events().map((event) => event.cursor)).toEqual([1, 2]);
    expect(subscriber.events().at(-1)?.taskId).toBe(first.id);

    // Another client must still be served while a subscription is open.
    const ping = await call(harness, { command: 'runtime.ping' });
    expect(ping).toMatchObject({ eventSubscribers: 1 });

    // A new event must arrive without reconnecting: this is live delivery, not a one-shot replay.
    const second = (await call(harness, {
      command: 'task.create', commandId: crypto.randomUUID(), projectId,
      specification: 'Second task', constraints: [], features: [], kind: 'DEVELOPMENT',
    })) as unknown as { id: string };
    await waitFor(() => subscriber.events().some((event) => event.taskId === second.id));
    expect(subscriber.events().slice(2).map((event) => event.eventType))
      .toEqual(['IntentRecorded', 'TaskCreated']);
    expect(subscriber.cursors()).toEqual([1, 2, 3, 4]);

    // Resuming from the last cursor repeats nothing.
    const resumed = await Subscriber.connect(harness, {
      command: 'events.subscribe', sinceSequence: 4,
    });
    await waitFor(() => resumed.frames.length > 0);
    expect(resumed.events()).toEqual([]);

    resumed.close();
    await call(harness, { command: 'runtime.stop' });
    await waitFor(() => subscriber.closed);
    expect(subscriber.frames.at(-1)?.type).not.toBe('error');
    subscriber.close();
  }, 30_000);

  test('a Project-filtered subscription also receives the Runtime global capacity fact', async () => {
    const harness = await startRuntime();
    const projectId = await trustedProject(harness);
    // Filtered to one Project: global facts belong to no Project, so they would be dropped by a
    // naive `project_id = ?` filter — and they are exactly the facts that affect every Project.
    const subscriber = await Subscriber.connect(harness, {
      command: 'events.subscribe', sinceSequence: 0, projectId,
    });
    await waitFor(() => subscriber.frames.some((frame) => frame.type === 'subscribed'));
    expect(subscriber.frames[0]).toMatchObject({ type: 'subscribed', projectId });

    await call(harness, {
      command: 'scheduler.capacity.set', commandId: crypto.randomUUID(), limit: 3,
    });
    await waitFor(() => subscriber.events()
      .some((event) => event.eventType === 'SchedulerGlobalCapacityChanged'));
    const delivered = subscriber.frames.flatMap((frame) => frame.type === 'event' ? [frame] : []);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.event.projectId).toBeNull();
    expect(delivered[0]?.event.payload).toMatchObject({ to: 3, source: 'EXPLICIT' });
    const cursor = delivered[0]?.cursor as number;

    // Resuming from the delivered cursor repeats nothing: the cursor advanced over the same single
    // sequence even though the event carried no Project.
    const resumed = await Subscriber.connect(harness, {
      command: 'events.subscribe', sinceSequence: cursor, projectId,
    });
    await waitFor(() => resumed.frames.length > 0);
    expect(resumed.events()).toEqual([]);

    resumed.close();
    await call(harness, { command: 'runtime.stop' });
    await waitFor(() => subscriber.closed);
    subscriber.close();
  }, 30_000);

  test('rejects an unknown cursor and closes only that connection', async () => {
    const harness = await startRuntime();
    await trustedProject(harness);
    const subscriber = await Subscriber.connect(harness, {
      command: 'events.subscribe', sinceSequence: 9_999,
    });
    await waitFor(() => subscriber.closed);
    expect(subscriber.frames).toHaveLength(1);
    expect(subscriber.frames[0]).toMatchObject({ type: 'error', code: 'INVALID_CURSOR' });
    // The Runtime itself is unaffected, and no subscription stayed registered.
    expect(await call(harness, { command: 'runtime.ping' })).toMatchObject({ eventSubscribers: 0 });
    await call(harness, { command: 'runtime.stop' });
  }, 30_000);
});
