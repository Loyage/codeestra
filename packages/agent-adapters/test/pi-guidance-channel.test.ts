import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentGuidanceContext, AgentKnowledgeContext, AgentStartRequest } from '@codeestra/contracts';
import { PiRpcAdapter } from '../src/pi-adapter.js';
import { PiRpcProcessError } from '../src/pi-process.js';
import { buildPiGuidanceArguments, buildPiKnowledgeArguments, buildPiModelArguments, buildPiRpcArguments } from '../src/pi-rpc.js';

/**
 * What this file proves: Pi's **running-conversation** guidance channel (ADR-0057) behaves as
 * declared — `guide()` hands the message to the live RPC process through `steer`, reports the
 * provider's own `queue_update` as corroboration, and refuses when the Adapter no longer holds the
 * process. It also pins the launch side of the same capability: a Task whose guidance artifact is
 * present changes the controlled launch by exactly one verified append, and a Task without guidance
 * leaves it byte-identical.
 *
 * What it does NOT prove: that a real Pi model read the guidance, or that a real Pi accepted `steer`
 * in a busy turn. Every process here is a protocol stub speaking Pi's RPC framing, so this is
 * orchestration evidence only (`docs/decisions/0057-*` records the unverified part).
 */

const gateExtensionPath = fileURLToPath(new URL('../src/pi-gate-extension.ts', import.meta.url));
const questionExtensionPath = fileURLToPath(new URL('../src/pi-question-extension.ts', import.meta.url));

/**
 * A protocol stub: it answers `get_state`, accepts `prompt`, and answers `steer` in the shape
 * ADR-0051 measured — a success response plus an optional separate `queue_update` record.
 */
const stubSource = `
const mode = Bun.env.CODEESTRA_STUB_MODE ?? 'QUEUE_UPDATE';
const reportPath = Bun.env.CODEESTRA_STUB_REPORT;
if (Bun.argv.includes('--version')) { process.stdout.write('0.85.1\\n'); process.exit(0); }
const received = { argv: Bun.argv.slice(2), commands: [] };
const save = () => { if (reportPath) require('node:fs').writeFileSync(reportPath, JSON.stringify(received)); };
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
save();
let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line);
    received.commands.push(record);
    save();
    if (record.type === 'get_state') {
      emit({ id: record.id, type: 'response', command: 'get_state', success: true, data: {
        sessionId: 'guidance-stub-session', sessionFile: process.cwd() + '/session.jsonl',
        messageCount: 0 } });
    } else if (record.type === 'prompt') {
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
    } else if (record.type === 'steer') {
      if (mode === 'NEVER_ANSWER') continue;
      emit({ id: record.id, type: 'response', command: 'steer', success: true });
      if (mode === 'QUEUE_UPDATE') {
        emit({ type: 'queue_update', steering: [record.message], followUp: [] });
      }
    }
  }
}
`;

const directories: string[] = [];
const adapters: PiRpcAdapter[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-pi-guidance-'));
  directories.push(directory);
  return directory;
}

function contextArtifact(name: string, text: string): { context: AgentGuidanceContext;
  path: string } {
  const directory = temporaryDirectory();
  const filePath = join(directory, name);
  writeFileSync(filePath, text);
  const bytes = new TextEncoder().encode(text);
  return {
    context: {
      filePath,
      digest: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      guidanceIds: ['00000000-0000-4000-8000-0000000000aa'],
    },
    path: filePath,
  };
}

function knowledgeContext(text: string): AgentKnowledgeContext {
  const directory = temporaryDirectory();
  const filePath = join(directory, 'knowledge-context.md');
  writeFileSync(filePath, text);
  const bytes = new TextEncoder().encode(text);
  return { filePath, digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.releaseSession('guidance-session');
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface Fixture {
  readonly adapter: PiRpcAdapter;
  readonly request: AgentStartRequest;
  readonly reportPath: string;
}

function fixture(mode: 'QUEUE_UPDATE' | 'NO_QUEUE_UPDATE' | 'NEVER_ANSWER' = 'QUEUE_UPDATE'):
Fixture {
  const root = temporaryDirectory();
  const stubPath = join(root, 'stub-pi.ts');
  const reportPath = join(root, 'report.json');
  const sessionDir = join(root, 'pi-sessions');
  const workspace = join(root, 'workspace');
  Bun.spawnSync(['mkdir', '-p', sessionDir, workspace]);
  writeFileSync(stubPath, stubSource);
  const adapter = new PiRpcAdapter({
    piExecutable: process.execPath,
    launcherArgs: [stubPath],
    gateExtensionPath,
    questionExtensionPath,
    sessionDir,
    environment: { CODEESTRA_STUB_REPORT: reportPath, CODEESTRA_STUB_MODE: mode },
    requestTimeoutMs: 4_000,
    stopGraceMs: 2_000,
    readStartToken: async () => 'stub-start-token',
  });
  adapters.push(adapter);
  return {
    adapter,
    reportPath,
    request: {
      operationId: '10000000-0000-4000-8000-000000000001',
      sessionId: '20000000-0000-4000-8000-000000000002',
      executionId: '30000000-0000-4000-8000-000000000003',
      workspace: { id: 'w1', cwd: workspace, ownershipToken: 'token' },
      revision: { id: 'r1', specification: 'Do the thing', constraints: [] },
      knowledgeSnapshotRefs: [],
      permissionMode: 'FULL',
      environment: {},
    },
  };
}

function launchedArgv(reportPath: string): readonly string[] {
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { readonly argv: readonly string[] };
  return report.argv;
}

function withTimeout<T>(value: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    value,
    Bun.sleep(10_000).then(() => { throw new Error(`Timed out waiting for ${label}`); }),
  ]);
}

describe('Pi session guidance channel', () => {
  test('hands a guidance message to the running conversation through steer and records the queue fact', async () => {
    const value = fixture('QUEUE_UPDATE');
    const session = await value.adapter.start({ ...value.request, sessionId: 'guidance-session' });
    const outcome = await withTimeout(value.adapter.guide({
      session,
      executionId: session.executionId,
      guidanceId: '00000000-0000-4000-8000-0000000000aa',
      message: 'Please use the repository conventions file.',
    }), 'Pi guidance delivery');

    expect(outcome.accepted).toBe(true);
    // The evidence names the provider facts, and "enqueued" is the whole claim: the message reached
    // Pi's steering queue, which is not the same as the model having read it (ADR-0051).
    expect(outcome.evidenceRef).toContain('pi-rpc:steer');
    expect(outcome.evidenceRef).toContain('queue_update=OBSERVED');
    expect(outcome.detail).toContain('steering queue');
    expect(outcome.detail).toContain('not proof that the model read it');
    const commands = JSON.parse(readFileSync(value.reportPath, 'utf8')) as {
      readonly commands: readonly Record<string, unknown>[] };
    const steer = commands.commands.find((command) => command['type'] === 'steer');
    expect(steer?.['message']).toBe('Please use the repository conventions file.');
  }, 20_000);

  test('records the message as accepted even when the provider reports no queue update', async () => {
    const value = fixture('NO_QUEUE_UPDATE');
    const session = await value.adapter.start({ ...value.request, sessionId: 'guidance-session' });
    const outcome = await withTimeout(value.adapter.guide({
      session,
      executionId: session.executionId,
      guidanceId: '00000000-0000-4000-8000-0000000000aa',
      message: 'No queue report here.',
    }), 'Pi guidance delivery without a queue update');

    expect(outcome.accepted).toBe(true);
    expect(outcome.evidenceRef).toContain('queue_update=NOT_OBSERVED');
    expect(outcome.detail).toContain('did not report a queue_update');
  }, 20_000);

  test('refuses to claim a delivery for a Session this Adapter no longer holds', async () => {
    const value = fixture('QUEUE_UPDATE');
    const session = await value.adapter.start({ ...value.request, sessionId: 'guidance-session' });
    await value.adapter.releaseSession('guidance-session');

    await expect(withTimeout(value.adapter.guide({
      session,
      executionId: session.executionId,
      guidanceId: '00000000-0000-4000-8000-0000000000aa',
      message: 'This must not be silently dropped.',
    }), 'Pi guidance refusal')).rejects.toBeInstanceOf(PiRpcProcessError);
  }, 20_000);

  test('launches a Task with guidance by exactly one verified append, and without guidance byte for byte', async () => {
    const value = fixture('QUEUE_UPDATE');
    const bare = await value.adapter.start({ ...value.request, sessionId: 'guidance-session' });
    const withoutGuidance = launchedArgv(value.reportPath);
    await value.adapter.releaseSession('guidance-session');

    const { context, path } = contextArtifact('guidance-context.md', '# Codeestra Session Guidance\n');
    const withGuidance = await value.adapter.start({
      ...value.request,
      sessionId: 'guidance-session',
      guidanceContext: context,
    });
    const argsWithGuidance = launchedArgv(value.reportPath);

    expect(bare.adapterId).toBe('pi');
    expect(withGuidance.adapterId).toBe('pi');
    expect([...argsWithGuidance]).toEqual([...withoutGuidance, '--append-system-prompt', path]);
    // The guidance file is a second artifact next to knowledge, never a replacement for it.
    const knowledge = knowledgeContext('# Project Knowledge\n');
    await value.adapter.releaseSession('guidance-session');
    await value.adapter.start({
      ...value.request,
      sessionId: 'guidance-session',
      knowledgeContext: knowledge,
      guidanceContext: context,
    });
    const argsWithBoth = launchedArgv(value.reportPath);
    expect([...argsWithBoth.slice(-4)]).toEqual([
      '--append-system-prompt', knowledge.filePath,
      '--append-system-prompt', path,
    ]);
    // The pure argument builder is what pins the "zero guidance changes nothing" rule as well.
    expect(buildPiGuidanceArguments(undefined)).toEqual([]);
    expect(buildPiKnowledgeArguments(undefined)).toEqual([]);
    expect([...buildPiRpcArguments({ gateExtensionPath, questionExtensionPath,
      sessionDir: value.request.workspace.cwd }), ...buildPiModelArguments(),
      ...buildPiKnowledgeArguments(undefined), ...buildPiGuidanceArguments(undefined)])
      .toEqual([...buildPiRpcArguments({ gateExtensionPath, questionExtensionPath,
        sessionDir: value.request.workspace.cwd })]);
  }, 30_000);

  test('refuses to start when the recorded guidance artifact does not match its digest', async () => {
    const value = fixture('QUEUE_UPDATE');
    const { context, path } = contextArtifact('guidance-context.md', '# Codeestra Session Guidance\n');
    writeFileSync(path, '# something else entirely\n');

    await expect(value.adapter.start({
      ...value.request,
      sessionId: 'guidance-session',
      guidanceContext: context,
    })).rejects.toMatchObject({ code: 'GUIDANCE_CONTEXT_UNAVAILABLE' });
  }, 20_000);
});
