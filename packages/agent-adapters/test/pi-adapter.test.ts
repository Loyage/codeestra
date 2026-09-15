import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentProcessIdentitySchema, type AgentKnowledgeContext, type AgentStartRequest } from '@codeestra/contracts';
import { PiRpcAdapter } from '../src/pi-adapter.js';
import { PiRpcProcessError } from '../src/pi-process.js';

const gateExtensionPath = fileURLToPath(new URL('../src/pi-gate-extension.ts', import.meta.url));
const questionExtensionPath = fileURLToPath(new URL('../src/pi-question-extension.ts', import.meta.url));

const stubSource = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = Bun.env.CODEESTRA_STUB_MODE ?? 'SUCCEED';
const reportPath = Bun.env.CODEESTRA_STUB_REPORT;
if (Bun.argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const received = { argv: Bun.argv.slice(2), cwd: process.cwd(), commands: [], uiResponses: [] };
const save = () => { if (reportPath) writeFileSync(reportPath, JSON.stringify(received, null, 2)); };
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
        sessionId: 'stub-session-1', sessionFile: join(process.cwd(), 'session.jsonl'), messageCount: 0 } });
    } else if (record.type === 'prompt') {
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      if (mode === 'CRASH_AFTER_PROMPT') { setTimeout(() => process.exit(3), 10); }
      else if (mode === 'PROVIDER_ERROR') {
        emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error',
          errorMessage: 'Codex error: The usage limit has been reached' } });
        emit({ type: 'agent_settled' });
      } else if (mode === 'NORMAL_TURN') {
        emit({ type: 'message_end', message: { role: 'assistant',
          content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } });
        emit({ type: 'agent_settled' });
      } else {
        emit({ type: 'extension_ui_request', id: 'stub-request-1', method: 'confirm',
          title: 'CODEESTRA_PERMISSION:call-1:write:abc', message: 'Allow once?' });
      }
    } else if (record.type === 'extension_ui_response') {
      received.uiResponses.push(record);
      save();
      emit({ type: 'agent_settled' });
    }
  }
}
`;

const directories: string[] = [];
const adapters: PiRpcAdapter[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-pi-adapter-'));
  directories.push(directory);
  return directory;
}

/** One materialized knowledge artifact, exactly as the Runtime records it for an Execution. */
function knowledgeContext(text: string): AgentKnowledgeContext {
  const directory = temporaryDirectory();
  const filePath = join(directory, 'knowledge-context.md');
  Bun.write(filePath, text);
  const bytes = new TextEncoder().encode(text);
  return { filePath, digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) {
    for (const session of ['session-under-test']) await adapter.releaseSession(session);
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function withTimeout<T>(value: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    value,
    Bun.sleep(10_000).then(() => { throw new Error(`Timed out waiting for ${label}`); }),
  ]);
}

function fixture(mode: 'SUCCEED' | 'CRASH_AFTER_PROMPT' | 'PROVIDER_ERROR' | 'NORMAL_TURN' = 'SUCCEED') {
  const root = temporaryDirectory();
  const stubPath = join(root, 'stub-pi.ts');
  const reportPath = join(root, 'report.json');
  const sessionDir = join(root, 'pi-sessions');
  const workspace = join(root, 'workspace');
  Bun.spawnSync(['mkdir', '-p', sessionDir, workspace]);
  Bun.write(stubPath, stubSource);
  const adapter = new PiRpcAdapter({
    piExecutable: process.execPath,
    launcherArgs: [stubPath],
    gateExtensionPath,
    questionExtensionPath,
    sessionDir,
    environment: { CODEESTRA_STUB_REPORT: reportPath, CODEESTRA_STUB_MODE: mode },
    requestTimeoutMs: 5_000,
    stopGraceMs: 2_000,
  });
  adapters.push(adapter);
  const request: AgentStartRequest = {
    operationId: '10000000-0000-4000-8000-000000000001',
    sessionId: 'session-under-test',
    executionId: '20000000-0000-4000-8000-000000000002',
    workspace: { id: '30000000-0000-4000-8000-000000000003', cwd: workspace, ownershipToken: 'owner' },
    revision: {
      id: '40000000-0000-4000-8000-000000000004',
      specification: 'Implement the owned worktree change',
      constraints: [{ id: 'no-main', text: 'Never update main' }],
    },
    knowledgeSnapshotRefs: [],
    permissionMode: 'STRICT',
    environment: {},
  };
  const report = (): {
    argv: string[]; cwd: string; commands: { type: string; message?: string }[];
    uiResponses: Record<string, unknown>[];
  } => JSON.parse(readFileSync(reportPath, 'utf8')) as never;
  return { adapter, request, reportPath, sessionDir, workspace, report };
}

describe('Pi RPC process adapter', () => {
  test('hands the recorded Project Knowledge to Pi as --append-system-prompt and changes nothing else', async () => {
    const { adapter, request, report } = fixture('NORMAL_TURN');
    const text = '# Project knowledge\n\nlayer: instructions | digest: 1111\n\nPrefer bun.\n';
    const context = knowledgeContext(text);
    await withTimeout(adapter.start({ ...request, knowledgeContext: context }), 'start with knowledge');
    // Pi's flag resolves an existing path to *file contents* (measured in Pi 0.85.1), so the
    // Adapter passes the verified absolute path and Pi reads the same bytes the Execution recorded.
    const promptFlag = report().argv.indexOf('--append-system-prompt');
    expect(promptFlag).toBeGreaterThan(-1);
    expect(report().argv[promptFlag + 1]).toBe(context.filePath);
    expect(report().argv.at(-1)).toBe(context.filePath);
    // ...and the file still holds exactly the recorded bytes.
    expect(readFileSync(context.filePath, 'utf8')).toBe(text);
    // The revision prompt is unchanged: the knowledge travels as a system-prompt addition, not as
    // rewritten task text.
    expect(report().commands.find((command) => command.type === 'prompt')?.message)
      .toContain('Codeestra revision');
  });

  test('leaves the controlled argv byte-identical when the Execution has no knowledge', async () => {
    const { adapter, request, report } = fixture('NORMAL_TURN');
    await withTimeout(adapter.start(request), 'start without knowledge');
    expect(report().argv).not.toContain('--append-system-prompt');
  });

  test('refuses to start when the knowledge file does not match its recorded digest', async () => {
    const { adapter, request, reportPath, workspace } = fixture('NORMAL_TURN');
    const context = knowledgeContext('recorded knowledge\n');
    Bun.write(context.filePath, 'tampered knowledge\n');
    await expect(adapter.start({ ...request, knowledgeContext: context }))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_CONTEXT_UNAVAILABLE', startMayHaveOccurred: false });
    // No provider process was started: nothing wrote a report and the workspace is untouched.
    expect(existsSync(reportPath)).toBe(false);
    expect(existsSync(join(workspace, 'session.jsonl'))).toBe(false);
  });

  test('refuses to start when the knowledge file is gone', async () => {
    const { adapter, request } = fixture('NORMAL_TURN');
    const context = knowledgeContext('recorded knowledge\n');
    rmSync(context.filePath);
    await expect(adapter.start({ ...request, knowledgeContext: context }))
      .rejects.toMatchObject({ code: 'KNOWLEDGE_CONTEXT_UNAVAILABLE' });
  });
  test('launches controlled RPC arguments, captures process identity, and prompts with the revision', async () => {
    const { adapter, request, sessionDir, workspace, report } = fixture();
    const ref = await adapter.start(request);
    expect(ref).toMatchObject({
      id: request.sessionId,
      executionId: request.executionId,
      adapterId: 'pi',
      providerSessionId: 'stub-session-1',
      sessionStorageRef: join(realpathSync(workspace), 'session.jsonl'),
    });
    const identity = agentProcessIdentitySchema.parse(ref.processIdentity);
    expect(identity.pid).toBeGreaterThan(0);
    expect(identity.startToken.length).toBeGreaterThan(0);
    const observed = report();
    expect(observed.cwd).toBe(realpathSync(workspace));
    expect(observed.argv.slice(0, 6)).toEqual([
      '--mode', 'rpc', '--no-approve', '--no-extensions', '--extension', gateExtensionPath,
    ]);
    expect(observed.argv).toContain('--no-context-files');
    expect(observed.argv).toContain('--no-skills');
    expect(observed.argv).toContain('--session-dir');
    expect(observed.argv).toContain(sessionDir);
    expect(observed.argv).toContain('--tools');
    expect(observed.commands.map((command) => command.type)).toEqual(['get_state', 'prompt']);
    expect(observed.commands[1]?.message).toContain(request.revision.id);
    expect(observed.commands[1]?.message).toContain('Never update main');
    await adapter.releaseSession(request.sessionId);
  });

  test('applies the resolved Agent configuration to the launched provider argv', async () => {
    const { adapter, request, report } = fixture('NORMAL_TURN');
    const ref = await adapter.start({
      ...request,
      agentConfig: { provider: 'deepseek', model: 'deepseek-flash', thinkingLevel: 'high' },
    });
    expect(report().argv).toEqual(expect.arrayContaining([
      '--provider', 'deepseek', '--model', 'deepseek-flash', '--thinking', 'high',
    ]));
    const events = [];
    for await (const event of adapter.observe(ref)) events.push(event);
    expect(events[0]).toMatchObject({ type: 'completed', outcome: 'SUCCESS' });
  });

  test('launches without model flags when no configuration was resolved', async () => {
    // "No configuration" must not become "some default Codeestra picked": an unset field has to
    // keep the provider's own default, and the argv is where that is observable.
    const { adapter, request, report } = fixture('NORMAL_TURN');
    const ref = await adapter.start(request);
    const argv = report().argv;
    expect(argv).not.toContain('--provider');
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--thinking');
    const events = [];
    for await (const event of adapter.observe(ref)) events.push(event);
    expect(events).toHaveLength(1);
  });

  test('resolves a permission dialog into a typed Attention and an answerable completion', async () => {
    const { adapter, request, report } = fixture();
    const ref = await adapter.start(request);
    const iterator = adapter.observe(ref)[Symbol.asyncIterator]();
    const attention = await withTimeout(iterator.next(), 'Pi attention event');
    expect(attention.value).toMatchObject({
      sessionId: request.sessionId,
      executionId: request.executionId,
      type: 'attention',
      providerRequestId: 'stub-request-1',
      kind: 'PERMISSION',
      responseType: 'CONFIRM',
      eventId: 'pi-ui:stub-request-1',
    });
    const receipt = await adapter.answer(ref, {
      operationId: '50000000-0000-4000-8000-000000000005',
      answerId: '60000000-0000-4000-8000-000000000006',
      attentionId: '70000000-0000-4000-8000-000000000007',
      providerRequestId: 'stub-request-1',
      responseType: 'CONFIRM',
      answer: { type: 'CONFIRM', confirmed: false },
    });
    expect(receipt).toEqual({ providerRequestId: 'stub-request-1', accepted: true });
    const completion = await withTimeout(iterator.next(), 'Pi completion event');
    expect(completion.value).toMatchObject({
      type: 'completed', outcome: 'SUCCESS',
      evidence: { toolsQuiescent: true, ownedWritersStopped: true },
    });
    expect((completion.value as { evidence: { ref: string } }).evidence.ref)
      .toContain('pi-rpc:agent_settled:session=stub-session-1');
    expect(report().uiResponses[0]).toMatchObject({ id: 'stub-request-1', confirmed: false });
    expect(await withTimeout(iterator.next(), 'Pi stream end')).toMatchObject({ done: true });
    expect(adapter.unconfirmedStops()).toEqual([]);
    expect(await adapter.answer(ref, {
      operationId: 'operation', answerId: 'answer', attentionId: 'attention',
      providerRequestId: 'stub-request-1', responseType: 'CONFIRM', answer: { type: 'CANCEL' },
    }).catch((error: unknown) => error)).toMatchObject({ code: 'LIVE_SESSION_UNAVAILABLE' });
  });

  test('refuses to observe or answer a Session or cursor this process does not hold', async () => {
    const { adapter, request } = fixture();
    const ref = await adapter.start(request);
    const foreign = await adapter.observe({ ...ref, id: 'unknown-session' })[Symbol.asyncIterator]().next()
      .catch((error: unknown) => error);
    expect(foreign).toBeInstanceOf(PiRpcProcessError);
    expect(foreign).toMatchObject({ code: 'LIVE_SESSION_UNAVAILABLE', startMayHaveOccurred: true });
    const stale = await adapter.observe(ref, 'other-epoch:1')[Symbol.asyncIterator]().next()
      .catch((error: unknown) => error);
    expect(stale).toMatchObject({ code: 'CURSOR_EPOCH_MISMATCH' });
    const mismatched = await adapter.observe({ ...ref, providerSessionId: 'another-provider' })
      [Symbol.asyncIterator]().next().catch((error: unknown) => error);
    expect(mismatched).toMatchObject({ code: 'SESSION_IDENTITY_MISMATCH' });
    await expect(adapter.answer({ ...ref, id: 'unknown-session' }, {
      operationId: 'operation', answerId: 'answer', attentionId: 'attention',
      providerRequestId: 'request', responseType: 'CONFIRM', answer: { type: 'CANCEL' },
    })).rejects.toMatchObject({ code: 'LIVE_SESSION_UNAVAILABLE', deliveryMayHaveOccurred: true });
  });

  test('reports a provider error turn as a FAILURE completion instead of success', async () => {
    // A settled run whose assistant message ended with a provider error (for example an exhausted
    // usage limit) did not finish the work, so the Runtime must not see a SUCCESS completion.
    const { adapter, request } = fixture('PROVIDER_ERROR');
    const ref = await adapter.start(request);
    const events = [];
    for await (const event of adapter.observe(ref)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'completed', outcome: 'FAILURE' });
    expect(events[0]).toMatchObject({ failure: { code: 'PROVIDER_TURN_FAILED',
      message: 'error: Codex error: The usage limit has been reached' } });
    expect((events[0] as { evidence: { ref: string } }).evidence.ref)
      .toContain('turn=error: Codex error: The usage limit has been reached');
    expect(adapter.unconfirmedStops()).toEqual([]);
  });

  test('reports a normally finished turn as SUCCESS', async () => {
    const { adapter, request } = fixture('NORMAL_TURN');
    const ref = await adapter.start(request);
    const events = [];
    for await (const event of adapter.observe(ref)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'completed', outcome: 'SUCCESS',
      evidence: { toolsQuiescent: true, ownedWritersStopped: true },
    });
    expect(events[0]).not.toHaveProperty('failure');
    expect((events[0] as { evidence: { ref: string } }).evidence.ref)
      .toContain('pi-rpc:agent_settled:session=stub-session-1');
  });

  test('reports a lost provider process as disconnected instead of claiming completion', async () => {
    const { adapter, request } = fixture('CRASH_AFTER_PROMPT');
    const ref = await adapter.start(request);
    const events = [];
    for await (const event of adapter.observe(ref)) events.push(event);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'disconnected', sessionId: request.sessionId });
    expect(events[0]?.type).not.toBe('completed');
    const afterCrash = await adapter.observe(ref)[Symbol.asyncIterator]().next()
      .catch((error: unknown) => error);
    expect(afterCrash).toMatchObject({ code: 'LIVE_SESSION_UNAVAILABLE' });
  });

  test('reports the installed provider version and honest capability limits', async () => {
    const { adapter } = fixture();
    const probe = await adapter.probe();
    expect(probe.version).toBe('0.84.4');
    expect(probe.capabilities).toMatchObject({
      persistentSession: 'SUPPORTED',
      structuredAttention: 'SUPPORTED',
      nativePermissionRouting: 'SUPPORTED',
      pauseWithQuiescence: 'UNSUPPORTED',
      revisionAcknowledgement: 'UNSUPPORTED',
      sessionGuidance: 'SUPPORTED',
      cooperativeStop: 'REQUIRES_VALIDATION',
      reconnectToLiveSession: 'UNSUPPORTED',
      resumeAfterExit: 'SUPPORTED',
      attach: 'STRUCTURED',
      // FOUNDATION-063 (ADR-0035): the two dimensions the design type always had. Pi's handoff chain
      // is the measured one of ADR-0026, so it is declared rather than left out.
      nativeTerminalHandoff: 'SUPPORTED',
      safePointNotification: 'SUPPORTED',
    });
    expect(await adapter.probe()).toEqual(probe);
  });

  test('rejects relative gate and session paths before launching anything', () => {
    expect(() => new PiRpcAdapter({ gateExtensionPath: 'gate.ts', questionExtensionPath,
      sessionDir: '/tmp/sessions' })).toThrow('must be absolute');
    expect(() => new PiRpcAdapter({ gateExtensionPath: '/tmp/gate.ts', questionExtensionPath: 'q.ts',
      sessionDir: '/tmp/sessions' })).toThrow('must be absolute');
    expect(() => new PiRpcAdapter({ gateExtensionPath: '/tmp/gate.ts', questionExtensionPath,
      sessionDir: 'sessions' })).toThrow('must be absolute');
    expect(existsSync(gateExtensionPath)).toBe(true);
    expect(existsSync(questionExtensionPath)).toBe(true);
  });
});
