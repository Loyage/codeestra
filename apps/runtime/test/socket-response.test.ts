import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runtimeResponseSchema, type ProjectIdentity,
  type RuntimeRequest } from '@codeestra/contracts';
import { git, provisionDevClone } from './support/agent-fixture.js';
import {
  reclaimTestResources,
  registerRuntimeProcess,
  registerTemporaryDirectory,
} from './support/runtime-reclamation.js';

/**
 * A response larger than the socket buffer must still arrive in full and close the connection.
 *
 * `socket.end(payload)` accepts only the bytes that fit in the buffer (8192 here) and then never
 * flushes the rest nor closes, so a client waits forever for a response that cannot arrive. This
 * caught a real `task verify` report: the Runtime had already finished and stored the evidence, but
 * the CLI and the Web UI both hung on a report that was silently cut in half.
 */
const runtimeEntry = resolve(import.meta.dir, '../src/main.ts');
/** The buffer boundary that truncated the payload; the test must exceed it to be meaningful. */
const socketBufferBytes = 8_192;

// FOUNDATION-057: teardown stops every Runtime this file started and removes its fixtures, on the
// success path and on the failure path. It signals by the identity the Runtime recorded in this
// file's own temporary home, never by name, and it waits for the exit instead of killing blindly.
afterEach(async () => { await reclaimTestResources(); });

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
  const repo = mkdtempSync(join(tmpdir(), 'codeestra-socket-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'codeestra-socket-home-'));
  registerTemporaryDirectory(repo);
  registerTemporaryDirectory(home);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await Bun.write(join(repo, 'README.md'), 'temporary repository\n');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'initial']);
  // ADR-0009: trust requires the long-lived dev branch; it is the workspace baseline, and since
  // ADR-0056 that branch is read from a second clone of the same origin.
  await git(repo, ['branch', 'dev']);
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

async function waitForRuntime(harness: RuntimeHarness, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await request(harness, { command: 'runtime.ping' });
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error('Runtime did not become ready');
}

interface Reply {
  readonly response: unknown;
  readonly bytes: number;
  readonly closed: boolean;
}

/**
 * Sends one command and waits for the whole response. A response that never completes fails the
 * test after `timeoutMs` instead of hanging it, and reports how much arrived.
 */
async function send(harness: RuntimeHarness, request_: ClientRequest, timeoutMs = 10_000): Promise<Reply> {
  return new Promise<Reply>((resolveReply, rejectReply) => {
    let buffer = '';
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectReply(new Error(`Timed out after ${timeoutMs}ms with ${bytes} of the response received`));
    }, timeoutMs);
    void Bun.connect({
      unix: harness.socketPath,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify({ ...request_, requestId: crypto.randomUUID(),
            schemaVersion: 1 })}\n`);
        },
        data(socket, chunk) {
          bytes += chunk.byteLength;
          buffer += new TextDecoder().decode(chunk);
          const newline = buffer.indexOf('\n');
          if (newline === -1) return;
          settled = true;
          clearTimeout(timer);
          socket.end();
          try {
            resolveReply({
              response: runtimeResponseSchema.parse(JSON.parse(buffer.slice(0, newline))),
              bytes,
              closed: true,
            });
          } catch (error) {
            rejectReply(error instanceof Error ? error : new Error(String(error)));
          }
        },
        error(_socket, error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rejectReply(error);
        },
        close() {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rejectReply(new Error(`Connection closed with ${bytes} bytes and no complete response`));
        },
      },
    }).catch(rejectReply);
  });
}

async function request(harness: RuntimeHarness, command: ClientRequest): Promise<unknown> {
  const reply = await send(harness, command);
  const response = reply.response as { ok: boolean; result?: unknown;
    error?: { code: string; message: string } };
  if (!response.ok) throw new Error(`${response.error?.code}: ${response.error?.message}`);
  return response.result;
}

async function trustedProject(harness: RuntimeHarness): Promise<string> {
  // The identity a trust echoes back pins the dev clone too (ADR-0056), so it is inspected with the
  // same explicit path the trust will state.
  const identity = (await request(harness, { command: 'project.inspect', path: harness.repo,
    devRepoPath: harness.devRepo,
  })) as ProjectIdentity;
  await request(harness, {
    command: 'project.trust',
    path: harness.repo,
    expectedIdentity: identity,
    devRepoPath: harness.devRepo,
    expectedVerificationPolicy: { state: 'ABSENT', mainCommit: identity.headCommit },
  });
  const projects = (await request(harness, { command: 'project.list' })) as readonly
    { id: string; repoRoot: string }[];
  const project = projects.find((candidate) => candidate.repoRoot === identity.repoRoot);
  if (project === undefined) throw new Error('The trusted project was not recorded');
  return project.id;
}

describe('Runtime socket responses', () => {
  test('delivers a response larger than the socket buffer in full', async () => {
    const harness = await startRuntime();
    const projectId = await trustedProject(harness);
    // Each Task view carries its specification, so a few long ones push the reply past the
    // 8192-byte buffer that used to truncate it.
    const specification = 'x'.repeat(2_000);
    for (let index = 0; index < 8; index += 1) {
      await request(harness, {
        command: 'task.create', commandId: crypto.randomUUID(), projectId,
        displayTitle: 'buffer task', namingTitle: `buffer-${index}`,
        specification, features: [],
      });
    }

    const reply = await send(harness, { command: 'task.list', projectId, includeArchived: false });
    const response = reply.response as { ok: boolean; result: readonly { id: string }[] };
    expect(response.ok).toBe(true);
    expect(response.result).toHaveLength(8);
    expect(reply.bytes).toBeGreaterThan(socketBufferBytes);
  }, 30_000);

  test('closes the connection after a large error response', async () => {
    const harness = await startRuntime();
    // Parsing an unknown project is cheap, and the failure path writes through the same socket
    // helper: a truncated error reply would leave the client without any diagnosis.
    const reply = await send(harness, { command: 'task.list', projectId: 'not-a-project', includeArchived: false });
    const response = reply.response as { ok: boolean; error?: { code: string } };
    expect(response.ok).toBe(false);
    expect(reply.closed).toBe(true);
  }, 30_000);
});
