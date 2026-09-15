import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { agentProcessIdentitySchema, type AgentKnowledgeContext, type AgentStartRequest } from '@codeestra/contracts';
import { CodexAdapter } from '../src/codex-adapter.js';
import { CodexAdapterError } from '../src/codex-protocol.js';

/**
 * A protocol stub for `codex app-server --stdio`. It speaks the measured JSONL JSON-RPC surface
 * (initialize, thread/start, thread/resume, turn/start, approval requests, structured questions,
 * turn/completed) and records what the Adapter wrote back.
 *
 * It is a stub, not a real provider: it proves framing, orchestration and failure mapping only.
 */
const stubSource = `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\\n');
  process.exit(0);
}
const reportPath = process.env.CODEESTRA_CODEX_STUB_REPORT;
const mode = process.env.CODEESTRA_CODEX_STUB_MODE ?? 'SETTLE';
const rollout = process.env.CODEESTRA_CODEX_STUB_ROLLOUT ?? join(process.cwd(), 'rollout-stub.jsonl');
const sessionId = 'stub-thread-1';
const turnId = 'stub-turn-1';
const received = { argv, cwd: process.cwd(), requests: [], serverResponses: [], prompt: null };
const save = () => {
  if (!reportPath) return;
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(received, null, 2));
};
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
const thread = (id, path) => ({ id, path });
save();

let buffer = '';
const handle = (frame) => {
  if (typeof frame.method === 'string' && frame.id !== undefined) {
    received.requests.push({ method: frame.method, params: frame.params });
    save();
    if (frame.method === 'initialize') {
      emit({ jsonrpc: '2.0', id: frame.id, result: { userAgent: 'stub', codexHome: process.env.CODEX_HOME ?? '',
        platformFamily: 'unix', platformOs: 'linux' } });
    } else if (frame.method === 'thread/start') {
      emit({ jsonrpc: '2.0', id: frame.id, result: { thread: thread(sessionId, rollout) } });
    } else if (frame.method === 'thread/resume') {
      emit({ jsonrpc: '2.0', id: frame.id, result: { thread: thread(
        process.env.CODEESTRA_CODEX_STUB_RESUME_ID ?? frame.params.threadId,
        process.env.CODEESTRA_CODEX_STUB_RESUME_PATH ?? rollout) } });
    } else if (frame.method === 'turn/start') {
      received.prompt = frame.params.input[0].text;
      save();
      emit({ jsonrpc: '2.0', id: frame.id, result: { turn: { id: turnId } } });
      beginTurn();
    }
    return;
  }
  if (frame.method === undefined && frame.id !== undefined) {
    received.serverResponses.push({ id: frame.id, result: frame.result ?? null, error: frame.error ?? null });
    save();
    if (mode === 'INTERRUPTED') return;
    if (received.serverResponses.length >= 1) finishTurn();
  }
};

const beginTurn = () => {
  if (mode === 'CRASH') { setTimeout(() => process.exit(3), 10); return; }
  if (mode === 'INTERRUPTED') {
    // A tool item did arrive before the interrupt: the Adapter must still not report a completion
    // (tool quiescence is not proven), and therefore must not report facts either.
    emit({ method: 'item/completed', params: { threadId: sessionId, turnId, completedAtMs: 1,
      item: { id: 'call-int', type: 'commandExecution', command: 'sleep 22', status: 'inProgress' } } });
    emit({ method: 'turn/completed', params: { threadId: sessionId,
      turn: { id: turnId, status: 'interrupted', error: null, items: [] } } });
    return;
  }
  if (mode === 'FAILED_TURN') {
    emit({ method: 'error', params: { threadId: sessionId, turnId,
      error: { message: 'stub turn failed' }, willRetry: false } });
    emit({ method: 'turn/completed', params: { threadId: sessionId,
      turn: { id: turnId, status: 'failed', error: { message: 'stub provider failure' }, items: [] } } });
    return;
  }
  if (mode === 'RETRYABLE_ERROR_THEN_COMPLETED') {
    emit({ method: 'error', params: { threadId: sessionId, turnId,
      error: { message: 'reconnecting' }, willRetry: true } });
    emit({ method: 'item/completed', params: { threadId: sessionId, turnId, completedAtMs: 1,
      item: { id: 'item-err', type: 'error', message: 'an item level complaint' } } });
    emit({ method: 'turn/completed', params: { threadId: sessionId,
      turn: { id: turnId, status: 'completed', error: null, items: [] } } });
    return;
  }
  if (mode === 'APPROVAL') {
    emit({ method: 'item/started', params: { threadId: sessionId, turnId, startedAtMs: 1,
      item: { id: 'call-1', type: 'commandExecution', command: '/bin/sh -lc echo hi', status: 'inProgress' } } });
    emit({ jsonrpc: '2.0', id: 0, method: 'item/commandExecution/requestApproval', params: {
      kind: 'command', threadId: sessionId, turnId, itemId: 'call-1', startedAtMs: 1, environmentId: 'local',
      command: '/bin/sh -lc echo hi', cwd: '/tmp', availableDecisions: ['accept', 'cancel'] } });
    return;
  }
  if (mode === 'QUESTIONNAIRE') {
    emit({ jsonrpc: '2.0', id: 0, method: 'item/tool/requestUserInput', params: {
      threadId: sessionId, turnId, itemId: 'call-q', isBlocking: false, autoResolutionMs: null,
      questions: [
        { id: 'q1', header: 'Packages', question: 'Which package manager?', isOther: true, isSecret: false,
          options: [ { label: 'bun', description: 'the lockfile says bun' },
            { label: 'npm', description: 'the repository default' } ] },
        { id: 'q2', header: 'Checks', question: 'Which checks?', isOther: false, isSecret: false,
          options: [ { label: 'typecheck', description: 'tsc --noEmit' },
            { label: 'tests', description: 'vitest run' } ] } ] } });
    return;
  }
  if (mode === 'PLAIN_QUESTION') {
    emit({ jsonrpc: '2.0', id: 0, method: 'item/tool/requestUserInput', params: {
      threadId: sessionId, turnId, itemId: 'call-q', isBlocking: false, autoResolutionMs: null,
      questions: [ { id: 'q1', header: 'Decision', question: 'Name it', isOther: true, isSecret: false,
        options: [ { label: 'only-one', description: null } ] } ] } });
    return;
  }
  if (mode === 'UNPARSEABLE_TURN') {
    emit({ method: 'turn/completed', params: { threadId: sessionId,
      turn: { id: turnId, status: 'not-a-status', error: null, items: [] } } });
    return;
  }
  if (mode === 'FACTS_TOOL_USE') {
    // One tool item seen twice (started + completed) with the same provider id, plus Codex's own
    // non-tool bookkeeping items: the run used a tool exactly once and ended with prose.
    emit({ method: 'item/started', params: { threadId: sessionId, turnId, startedAtMs: 1,
      item: { id: 'call-1', type: 'commandExecution', command: '/bin/sh -lc echo hi', status: 'inProgress' } } });
    emit({ method: 'item/started', params: { threadId: sessionId, turnId, startedAtMs: 1,
      item: { id: 'reason-1', type: 'reasoning', summary: ['thinking'], content: [] } } });
    emit({ method: 'item/completed', params: { threadId: sessionId, turnId, completedAtMs: 2,
      item: { id: 'reason-1', type: 'reasoning', summary: ['thinking'], content: [] } } });
    emit({ method: 'item/completed', params: { threadId: sessionId, turnId, completedAtMs: 3,
      item: { id: 'msg-1', type: 'agentMessage', text: 'Wrote the file. Anything else?' } } });
    emit({ method: 'item/completed', params: { threadId: sessionId, turnId, completedAtMs: 4,
      item: { id: 'call-1', type: 'commandExecution', command: '/bin/sh -lc echo hi',
        status: 'completed', exitCode: 0, aggregatedOutput: 'hi\\n' } } });
    finishTurn();
    return;
  }
  if (mode === 'FACTS_PROSE_QUESTION') {
    // No tool item at all, and the last thing the Agent said ends with a question mark: the exact
    // shape FOUNDATION-056's rule is about.
    emit({ method: 'item/started', params: { threadId: sessionId, turnId, startedAtMs: 1,
      item: { id: 'msg-1', type: 'agentMessage', text: '' } } });
    emit({ method: 'item/completed', params: { threadId: sessionId, turnId, completedAtMs: 2,
      item: { id: 'msg-1', type: 'agentMessage', text: 'Which package manager should I use?' } } });
    finishTurn();
    return;
  }
  if (mode === 'FACTS_UNKNOWN_ITEM') {
    // An item type this Adapter does not recognize must never become "a tool call".
    emit({ method: 'item/completed', params: { threadId: sessionId, turnId, completedAtMs: 1,
      item: { id: 'future-1', type: 'someFutureCodexItem', detail: 'x' } } });
    emit({ method: 'item/completed', params: { threadId: sessionId, turnId, completedAtMs: 2,
      item: { id: 'msg-1', type: 'agentMessage', text: 'Nothing to do here.' } } });
    finishTurn();
    return;
  }
  if (mode === 'FACTS_TOOL_THEN_FAILED') {
    emit({ method: 'item/completed', params: { threadId: sessionId, turnId, completedAtMs: 1,
      item: { id: 'call-9', type: 'commandExecution', command: 'exit 1',
        status: 'completed', exitCode: 1, aggregatedOutput: '' } } });
    emit({ method: 'item/completed', params: { threadId: sessionId, turnId, completedAtMs: 2,
      item: { id: 'msg-9', type: 'agentMessage', text: 'The command failed.' } } });
    emit({ method: 'error', params: { threadId: sessionId, turnId,
      error: { message: 'stub turn failed' }, willRetry: false } });
    emit({ method: 'turn/completed', params: { threadId: sessionId,
      turn: { id: turnId, status: 'failed', error: { message: 'stub provider failure' }, items: [] } } });
    return;
  }
  if (mode === 'UNSUPPORTED_REQUEST') {
    emit({ jsonrpc: '2.0', id: 7, method: 'mcpServer/elicitation/request', params: {
      threadId: sessionId, turnId, serverName: 'stub' } });
    return;
  }
  finishTurn();
};

const finishTurn = () => {
  emit({ method: 'turn/completed', params: { threadId: sessionId,
    turn: { id: turnId, status: 'completed', error: null, items: [] } } });
};

for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    handle(JSON.parse(line));
  }
}
`;

interface StubReceived {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly requests: readonly { readonly method: string;
    readonly params: Readonly<Record<string, unknown>> }[];
  readonly serverResponses: readonly { readonly id: unknown; readonly result: unknown;
    readonly error: unknown }[];
  readonly prompt: string | null;
}

const directories: string[] = [];
const adapters: CodexAdapter[] = [];

function temporaryDirectory(prefix: string): string {
  // macOS resolves /var to /private/var, and the child process reports the resolved path.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

/** One materialized knowledge artifact, exactly as the Runtime records it for an Execution. */
function knowledgeContext(text: string): AgentKnowledgeContext {
  const directory = temporaryDirectory('codeestra-codex-knowledge-');
  const filePath = join(directory, 'knowledge-context.md');
  Bun.write(filePath, text);
  const bytes = new TextEncoder().encode(text);
  return { filePath, digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.releaseSession('session-under-test');
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface Fixture {
  readonly adapter: CodexAdapter;
  readonly root: string;
  readonly home: string;
  readonly reportPath: string;
  readonly rolloutPath: string;
  readonly startRequest: AgentStartRequest;
  received(): StubReceived;
}

function fixture(mode: string, options: {
  readonly enableRequestUserInput?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly resume?: AgentStartRequest['resume'];
  readonly rolloutInHome?: boolean;
  readonly codexHome?: string;
} = {}): Fixture {
  const root = temporaryDirectory('codeestra-codex-adapter-');
  const tools = join(root, 'tools');
  const home = options.codexHome ?? join(root, 'codex-home');
  mkdirSync(join(home, 'sessions', '2026', '09', '14'), { recursive: true });
  mkdirSync(tools, { recursive: true });
  const stubPath = join(tools, 'codex-stub.ts');
  Bun.write(stubPath, stubSource);
  chmodSync(stubPath, 0o755);
  const reportPath = join(tools, 'report.json');
  const rolloutPath = options.rolloutInHome === false
    ? join(root, 'elsewhere', 'rollout-1.jsonl')
    : join(home, 'sessions', '2026', '09', '14', 'rollout-1.jsonl');
  mkdirSync(join(rolloutPath, '..'), { recursive: true });
  Bun.write(rolloutPath, '{}\n');
  const adapter = new CodexAdapter({
    codexExecutable: process.execPath,
    launcherArgs: [stubPath],
    ...(options.enableRequestUserInput === undefined
      ? {} : { enableRequestUserInput: options.enableRequestUserInput }),
    codexHome: home,
    environment: {
      ...(Bun.env.PATH === undefined ? {} : { PATH: Bun.env.PATH }),
      CODEESTRA_CODEX_STUB_REPORT: reportPath,
      CODEESTRA_CODEX_STUB_MODE: mode,
      CODEESTRA_CODEX_STUB_ROLLOUT: rolloutPath,
      ...(options.environment ?? {}),
    },
  });
  adapters.push(adapter);
  const startRequest: AgentStartRequest = {
    operationId: 'operation-1',
    sessionId: 'session-under-test',
    executionId: 'execution-1',
    workspace: { id: 'workspace-1', cwd: root, ownershipToken: 'token-1' },
    revision: { id: 'revision-1', specification: 'Do the thing', constraints: [{ id: 'c1', text: 'Be safe' }] },
    knowledgeSnapshotRefs: [],
    permissionMode: 'STRICT',
    environment: {},
    ...(options.resume === undefined ? {} : { resume: options.resume }),
  };
  return {
    adapter,
    root,
    home,
    reportPath,
    rolloutPath,
    startRequest,
    received: () => JSON.parse(readFileSync(reportPath, 'utf8')) as StubReceived,
  };
}

async function waitForReport(fixtureUnderTest: Fixture,
  predicate: (report: StubReceived) => boolean, timeoutMs = 20_000): Promise<StubReceived> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const report = fixtureUnderTest.received();
      if (predicate(report)) return report;
    } catch { /* the stub has not written its first report yet */ }
    await Bun.sleep(20);
  }
  throw new Error('the Codex stub never reached the expected state');
}

interface SessionShape {
  readonly id: string;
  readonly executionId: string;
  readonly adapterId: string;
  readonly providerSessionId?: string;
}

/** Drains an observation stream; the stream itself is expected to end. */
async function collect(adapter: CodexAdapter, session: SessionShape,
  timeoutMs = 20_000): Promise<readonly unknown[]> {
  const events: unknown[] = [];
  const pump = (async () => {
    for await (const event of adapter.observe(session as never)) events.push(event);
  })();
  await Promise.race([pump, Bun.sleep(timeoutMs)]);
  return events;
}

/** Reads one event, or surfaces the error the adapter threw before producing any. */
async function firstEvent(adapter: CodexAdapter, session: SessionShape,
  cursor?: string): Promise<unknown> {
  for await (const event of adapter.observe(session as never, cursor)) return event;
  throw new Error('the observation stream ended without an event');
}

describe('Codex adapter capabilities', () => {
  test('reports the measured version and matrix, and never claims an unimplemented ability', async () => {
    const { adapter } = fixture('SETTLE');
    const probe = await adapter.probe();
    expect(probe.version).toBe('0.151.0');
    expect(probe.capabilities).toEqual({
      persistentSession: 'SUPPORTED',
      structuredAttention: 'UNSUPPORTED',
      nativePermissionRouting: 'SUPPORTED',
      pauseWithQuiescence: 'UNSUPPORTED',
      revisionAcknowledgement: 'UNSUPPORTED',
      cooperativeStop: 'REQUIRES_VALIDATION',
      attach: 'UNSUPPORTED',
      nativeTerminalHandoff: 'UNSUPPORTED',
      safePointNotification: 'UNSUPPORTED',
      reconnectToLiveSession: 'UNSUPPORTED',
      resumeAfterExit: 'SUPPORTED',
      controlledConfiguration: 'UNSUPPORTED',
      pluginSelection: 'UNSUPPORTED',
    });
  });

  test('reports structured attention only when the under-development question tool is enabled', async () => {
    const { adapter } = fixture('SETTLE', { enableRequestUserInput: true });
    expect(adapter.capabilities().structuredAttention).toBe('SUPPORTED');
    expect((await adapter.probe()).capabilities.structuredAttention).toBe('SUPPORTED');
  });

  test('an unresolvable provider is reported instead of pretending success', async () => {
    const adapter = new CodexAdapter({ codexExecutable: 'definitely-missing-codex' });
    adapters.push(adapter);
    await expect(adapter.probe()).rejects.toMatchObject({ code: 'PROVIDER_VERSION_UNAVAILABLE' });
  });
});

describe('Codex adapter start', () => {
  test('launches a controlled app-server and sends the revision with the STRICT policy', async () => {
    const fixtureUnderTest = fixture('SETTLE');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    expect(session).toMatchObject({
      id: 'session-under-test', executionId: 'execution-1', adapterId: 'codex',
      providerSessionId: 'stub-thread-1', sessionStorageRef: fixtureUnderTest.rolloutPath,
    });
    expect(agentProcessIdentitySchema.safeParse(session.processIdentity).success).toBe(true);
    const report = await waitForReport(fixtureUnderTest, (r) => r.prompt !== null);
    expect(report.argv).toEqual(['app-server', '--stdio']);
    expect(report.cwd).toBe(fixtureUnderTest.root);
    const threadStart = report.requests.find((request) => request.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      approvalPolicy: 'untrusted', sandbox: 'workspace-write',
    });
    expect(report.prompt).toContain('Codeestra revision revision-1');
    expect(report.prompt).toContain('- c1: Be safe');
  });

  test('uses the FULL policy and passes model, provider and reasoning effort', async () => {
    const fixtureUnderTest = fixture('SETTLE');
    await fixtureUnderTest.adapter.start({
      ...fixtureUnderTest.startRequest,
      permissionMode: 'FULL',
      agentConfig: { model: 'gpt-5.5', provider: 'openai', thinkingLevel: 'high' },
    });
    const report = await waitForReport(fixtureUnderTest, (r) => r.prompt !== null);
    expect(report.argv).toEqual(['app-server', '--stdio', '-c', 'model_reasoning_effort=high']);
    expect(report.requests.find((request) => request.method === 'thread/start')?.params)
      .toMatchObject({
        approvalPolicy: 'never', sandbox: 'danger-full-access',
        model: 'gpt-5.5', modelProvider: 'openai',
      });
  });

  test('resumes the recorded thread instead of starting a new one', async () => {
    const fixtureUnderTest = fixture('SETTLE', {
      resume: { predecessorSessionId: 'session-before', sessionStorageRef: '', providerSessionId: 'stub-thread-1' },
    });
    // The recorded path must be the one on disk inside this Codex home.
    const resumeRequest: AgentStartRequest = {
      ...fixtureUnderTest.startRequest,
      resume: {
        predecessorSessionId: 'session-before',
        sessionStorageRef: fixtureUnderTest.rolloutPath,
        providerSessionId: 'stub-thread-1',
      },
    };
    await fixtureUnderTest.adapter.start(resumeRequest);
    const report = await waitForReport(fixtureUnderTest, (r) => r.prompt !== null);
    expect(report.requests.some((request) => request.method === 'thread/start')).toBe(false);
    expect(report.requests.find((request) => request.method === 'thread/resume')?.params)
      .toMatchObject({ threadId: 'stub-thread-1', approvalPolicy: 'untrusted' });
    expect(report.prompt).toContain('has now resumed');
  });

  test('refuses a resume path outside the Codex session directory', async () => {
    const fixtureUnderTest = fixture('SETTLE', { rolloutInHome: false });
    await expect(fixtureUnderTest.adapter.start({
      ...fixtureUnderTest.startRequest,
      resume: { predecessorSessionId: 'session-before',
        sessionStorageRef: join(fixtureUnderTest.home, '..', 'elsewhere', 'rollout-1.jsonl'),
        providerSessionId: 'stub-thread-1' },
    })).rejects.toMatchObject({ code: 'RESUME_SESSION_NOT_OWNED' });
  });

  test('refuses when the provider resumes a different thread than the recorded one', async () => {
    const fixtureUnderTest = fixture('SETTLE', { environment: { CODEESTRA_CODEX_STUB_RESUME_ID: 'other-thread' } });
    await expect(fixtureUnderTest.adapter.start({
      ...fixtureUnderTest.startRequest,
      resume: { predecessorSessionId: 'session-before',
        sessionStorageRef: fixtureUnderTest.rolloutPath, providerSessionId: 'stub-thread-1' },
    })).rejects.toMatchObject({ code: 'SESSION_IDENTITY_MISMATCH' });
  });
});

describe('Codex adapter Project Knowledge handoff', () => {
  const knowledgeText = [
    '<!-- Generated by Codeestra Runtime. Machine-generated knowledge area: .codeestra/. -->',
    'Snapshot digest: abc123',
    '# Project knowledge',
    '',
    '## .codeestra/instructions/house-rules.md',
    '',
    'layer: instructions | digest: 1111',
    '',
    'Prefer `bun` over `npm`.',
    '',
  ].join('\n');

  test('hands the recorded knowledge to Codex as developerInstructions, without touching argv', async () => {
    const fixtureUnderTest = fixture('SETTLE');
    const context = knowledgeContext(knowledgeText);
    await fixtureUnderTest.adapter.start({ ...fixtureUnderTest.startRequest, knowledgeContext: context });
    const report = await waitForReport(fixtureUnderTest, (r) => r.prompt !== null);
    // Codex has no launched-instruction flag, so the controlled argv is unchanged...
    expect(report.argv).toEqual(['app-server', '--stdio']);
    // ...and the knowledge travels in the app-server's own `developerInstructions` field, byte for
    // byte the text the Runtime recorded for this Execution.
    const threadStart = report.requests.find((request) => request.method === 'thread/start');
    expect(threadStart?.params['developerInstructions']).toBe(knowledgeText);
    expect(readFileSync(context.filePath, 'utf8')).toBe(knowledgeText);
  });

  test('re-sends the same knowledge when a successor Execution resumes the thread', async () => {
    const fixtureUnderTest = fixture('SETTLE');
    const context = knowledgeContext(knowledgeText);
    await fixtureUnderTest.adapter.start({
      ...fixtureUnderTest.startRequest,
      knowledgeContext: context,
      resume: { predecessorSessionId: 'session-before',
        sessionStorageRef: fixtureUnderTest.rolloutPath, providerSessionId: 'stub-thread-1' },
    });
    const report = await waitForReport(fixtureUnderTest, (r) => r.prompt !== null);
    const resume = report.requests.find((request) => request.method === 'thread/resume');
    expect(resume?.params['developerInstructions']).toBe(knowledgeText);
    expect(report.requests.some((request) => request.method === 'thread/start')).toBe(false);
  });

  test('sends no developerInstructions when the Execution resolved no knowledge', async () => {
    const fixtureUnderTest = fixture('SETTLE');
    await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const report = await waitForReport(fixtureUnderTest, (r) => r.prompt !== null);
    expect(report.argv).toEqual(['app-server', '--stdio']);
    const threadStart = report.requests.find((request) => request.method === 'thread/start');
    expect(threadStart?.params).not.toHaveProperty('developerInstructions');
  });

  test('refuses to start when the knowledge file does not match its recorded digest', async () => {
    const fixtureUnderTest = fixture('SETTLE');
    const context = knowledgeContext(knowledgeText);
    Bun.write(context.filePath, `${knowledgeText}tampered\n`);
    await expect(fixtureUnderTest.adapter.start({
      ...fixtureUnderTest.startRequest, knowledgeContext: context,
    })).rejects.toMatchObject({ code: 'KNOWLEDGE_CONTEXT_UNAVAILABLE' });
    // The refusal happens before any provider process exists.
    expect(existsSync(fixtureUnderTest.reportPath)).toBe(false);
  });
});

describe('Codex adapter observation', () => {
  test('maps an approval request to a PERMISSION Attention and writes the answer back', async () => {
    const fixtureUnderTest = fixture('APPROVAL');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events: { type?: string; kind?: string; responseType?: string;
      providerRequestId?: string; prompt?: Record<string, unknown> }[] = [];
    for await (const event of fixtureUnderTest.adapter.observe(session)) {
      events.push(event as never);
      if (event.type === 'attention') {
        expect(event.kind).toBe('PERMISSION');
        expect(event.responseType).toBe('CONFIRM');
        expect(event.prompt).toMatchObject({ kind: 'codex.permission', approvalKind: 'command',
          command: '/bin/sh -lc echo hi' });
        const receipt = await fixtureUnderTest.adapter.answer(session, {
          operationId: 'answer-1', answerId: 'answer-1', attentionId: 'attention-1',
          providerRequestId: event.providerRequestId, responseType: 'CONFIRM',
          answer: { type: 'CONFIRM', confirmed: false },
        });
        expect(receipt).toEqual({ providerRequestId: event.providerRequestId, accepted: true });
      }
    }
    expect(events.at(-1)).toMatchObject({ type: 'completed', outcome: 'SUCCESS',
      evidence: { toolsQuiescent: true, ownedWritersStopped: true } });
    const report = await waitForReport(fixtureUnderTest, (r) => r.serverResponses.length > 0);
    expect(report.serverResponses[0]).toEqual({ id: 0, result: { decision: 'decline' }, error: null });
  });

  test('accepts an approval when the user confirms', async () => {
    const fixtureUnderTest = fixture('APPROVAL');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    for await (const event of fixtureUnderTest.adapter.observe(session)) {
      if (event.type !== 'attention') continue;
      await fixtureUnderTest.adapter.answer(session, {
        operationId: 'answer-1', answerId: 'answer-1', attentionId: 'attention-1',
        providerRequestId: event.providerRequestId, responseType: 'CONFIRM',
        answer: { type: 'CONFIRM', confirmed: true },
      });
    }
    const report = await waitForReport(fixtureUnderTest, (r) => r.serverResponses.length > 0);
    expect(report.serverResponses[0]).toEqual({ id: 0, result: { decision: 'accept' }, error: null });
  });

  test('maps a Codex question set to a Codeestra questionnaire and encodes the answer', async () => {
    const fixtureUnderTest = fixture('QUESTIONNAIRE', { enableRequestUserInput: true });
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    for await (const event of fixtureUnderTest.adapter.observe(session)) {
      if (event.type !== 'attention') continue;
      const prompt = event.prompt as { kind: string; questionnaire: { questions: readonly {
        header: string; options: readonly { label: string }[] }[] } };
      expect(prompt.kind).toBe('codeestra.questionnaire');
      expect(prompt.questionnaire.questions.map((question) => question.header))
        .toEqual(['Packages', 'Checks']);
      await fixtureUnderTest.adapter.answer(session, {
        operationId: 'answer-1', answerId: 'answer-1', attentionId: 'attention-1',
        providerRequestId: event.providerRequestId, responseType: 'VALUE',
        answer: { type: 'QUESTIONNAIRE', answer: { version: 1, answers: [
          { type: 'CHOICES', questionIndex: 0, choiceIndexes: [0] },
          { type: 'TEXT', questionIndex: 1, text: 'both' } ] } },
      });
    }
    const report = await waitForReport(fixtureUnderTest, (r) => r.serverResponses.length > 0);
    expect(report.serverResponses[0]).toEqual({ id: 0, error: null,
      result: { answers: { q1: { answers: ['bun'] }, q2: { answers: ['both'] } } } });
  });

  test('degrades a question set that does not fit the questionnaire contract', async () => {
    const fixtureUnderTest = fixture('PLAIN_QUESTION', { enableRequestUserInput: true });
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    for await (const event of fixtureUnderTest.adapter.observe(session)) {
      if (event.type !== 'attention') continue;
      expect(event.prompt).toMatchObject({ kind: 'codex.question', itemId: 'call-q' });
      await fixtureUnderTest.adapter.answer(session, {
        operationId: 'answer-1', answerId: 'answer-1', attentionId: 'attention-1',
        providerRequestId: event.providerRequestId, responseType: 'VALUE',
        answer: { type: 'VALUE', value: 'the user typed this' },
      });
    }
    const report = await waitForReport(fixtureUnderTest, (r) => r.serverResponses.length > 0);
    expect(report.serverResponses[0]).toEqual({ id: 0, error: null,
      result: { answers: { q1: { answers: ['the user typed this'] } } } });
  });

  test('refuses a provider request it cannot answer instead of leaving the Agent waiting', async () => {
    const fixtureUnderTest = fixture('UNSUPPORTED_REQUEST');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session);
    expect(events.at(-1)).toMatchObject({ type: 'completed', outcome: 'SUCCESS' });
    const report = await waitForReport(fixtureUnderTest, (r) => r.serverResponses.length > 0);
    expect(report.serverResponses[0]).toMatchObject({
      id: 7, result: null, error: { code: -32601 },
    });
  });

  test('reports a failed turn as FAILURE with the provider reason', async () => {
    const fixtureUnderTest = fixture('FAILED_TURN');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session);
    expect(events.at(-1)).toMatchObject({ type: 'completed', outcome: 'FAILURE',
      failure: { code: 'PROVIDER_TURN_FAILED', message: 'stub provider failure' } });
  });

  test('a retryable provider error is not a failed turn', async () => {
    const fixtureUnderTest = fixture('RETRYABLE_ERROR_THEN_COMPLETED');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session);
    expect(events.at(-1)).toMatchObject({ type: 'completed', outcome: 'SUCCESS' });
  });

  test('reports an uninterpretable turn payload as FAILURE after a confirmed stop', async () => {
    const fixtureUnderTest = fixture('UNPARSEABLE_TURN');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session);
    expect(events.at(-1)).toMatchObject({ type: 'completed', outcome: 'FAILURE',
      failure: { code: 'PROVIDER_RESPONSE_INVALID' } });
    expect(await fixtureUnderTest.adapter.releaseSession('session-under-test')).toBeNull();
  });

  test('reports an unexpected provider exit as disconnected, never as completion', async () => {
    const fixtureUnderTest = fixture('CRASH');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'disconnected' });
    await expect(firstEvent(fixtureUnderTest.adapter, session)).rejects
      .toMatchObject({ code: 'LIVE_SESSION_UNAVAILABLE' });
  });

  test('an interrupted turn is reported as disconnected because tool quiescence is not proven', async () => {
    const fixtureUnderTest = fixture('INTERRUPTED');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'disconnected',
      reason: expect.stringContaining('tool quiescence is not proven') });
  });

  test('rejects a cursor from another provider epoch and an answer with no live process', async () => {
    const fixtureUnderTest = fixture('SETTLE');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    await expect(firstEvent(fixtureUnderTest.adapter, session, 'other-epoch:1')).rejects
      .toMatchObject({ code: 'CURSOR_EPOCH_MISMATCH' });
    await expect(fixtureUnderTest.adapter.answer(
      { ...session, id: 'unknown-session' },
      { operationId: 'answer-1', answerId: 'answer-1', attentionId: 'attention-1',
        providerRequestId: '0', responseType: 'CONFIRM', answer: { type: 'CONFIRM', confirmed: true } },
    )).rejects.toMatchObject({ code: 'LIVE_SESSION_UNAVAILABLE' });
  });

  test('answers for a request that is already resolved are refused', async () => {
    const fixtureUnderTest = fixture('APPROVAL');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    for await (const event of fixtureUnderTest.adapter.observe(session)) {
      if (event.type !== 'attention') continue;
      const request = { operationId: 'answer-1', answerId: 'answer-1', attentionId: 'attention-1',
        providerRequestId: event.providerRequestId, responseType: 'CONFIRM' as const,
        answer: { type: 'CONFIRM' as const, confirmed: true } };
      await fixtureUnderTest.adapter.answer(session, request);
      await expect(fixtureUnderTest.adapter.answer(session, request)).rejects
        .toBeInstanceOf(CodexAdapterError);
    }
  });

  test('releaseSession stops the child and reports its exit', async () => {
    const fixtureUnderTest = fixture('INTERRUPTED');
    await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const released = await fixtureUnderTest.adapter.releaseSession('session-under-test');
    expect(released?.exited).toBe(true);
    expect(await fixtureUnderTest.adapter.releaseSession('session-under-test')).toBeNull();
  });
});

/**
 * Codex completion facts (FOUNDATION-079 / ADR-0043, ADR-0051).
 *
 * The stub replays Codex's own `item/started` / `item/completed` / `turn/completed` notifications, so
 * what is asserted here is the Adapter's fact collection: a fact Codex did not report must stay
 * absent, and a run without a completion must carry no facts at all.
 */
describe('Codex adapter completion facts', () => {
  interface CompletedEvent {
    readonly type: string;
    readonly outcome?: string;
    readonly failure?: { readonly code: string; readonly message: string };
    readonly facts?: Readonly<Record<string, unknown>>;
  }

  test('reports a tool-using run once, with the provider text and no invented stop reason', async () => {
    const fixtureUnderTest = fixture('FACTS_TOOL_USE');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session) as readonly CompletedEvent[];
    const completed = events.at(-1);
    expect(completed).toMatchObject({ type: 'completed', outcome: 'SUCCESS' });
    // The same tool item was reported by `item/started` and `item/completed`; it counts once. The
    // `reasoning` item Codex also reported is not a tool call.
    expect(completed?.facts).toEqual({
      toolCallCount: 1,
      finalAssistantText: 'Wrote the file. Anything else?',
      finalAssistantTextTruncated: false,
      finalAssistantStopReason: null,
    });
    // Facts are observations, never Attentions: the Adapter itself raises nothing from them.
    expect(events.some((event) => event.type === 'attention')).toBe(false);
  });

  test('reports a tool-free run that ended with a question, which is what the note rule needs', async () => {
    const fixtureUnderTest = fixture('FACTS_PROSE_QUESTION');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session) as readonly CompletedEvent[];
    const facts = events.at(-1)?.facts;
    expect(facts).toEqual({
      toolCallCount: 0,
      finalAssistantText: 'Which package manager should I use?',
      finalAssistantTextTruncated: false,
      finalAssistantStopReason: null,
    });
    expect(String(facts?.['finalAssistantText']).trim().endsWith('?')).toBe(true);
  });

  test('never turns an unrecognized item type into a tool call', async () => {
    const fixtureUnderTest = fixture('FACTS_UNKNOWN_ITEM');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session) as readonly CompletedEvent[];
    expect(events.at(-1)?.facts).toMatchObject({ toolCallCount: 0 });
  });

  test('carries the facts of a failed turn without inventing an outcome', async () => {
    const fixtureUnderTest = fixture('FACTS_TOOL_THEN_FAILED');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session) as readonly CompletedEvent[];
    const completed = events.at(-1);
    expect(completed).toMatchObject({ type: 'completed', outcome: 'FAILURE',
      failure: { code: 'PROVIDER_TURN_FAILED' } });
    expect(completed?.facts).toMatchObject({ toolCallCount: 1,
      finalAssistantText: 'The command failed.' });
  });

  test('an interrupted turn reports no facts, because there is no completion to describe', async () => {
    const fixtureUnderTest = fixture('INTERRUPTED');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session) as readonly CompletedEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'disconnected' });
    expect(events[0]).not.toHaveProperty('facts');
  });

  test('a provider crash reports no facts either', async () => {
    const fixtureUnderTest = fixture('CRASH');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session) as readonly CompletedEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'disconnected' });
    expect(events[0]).not.toHaveProperty('facts');
  });
});
