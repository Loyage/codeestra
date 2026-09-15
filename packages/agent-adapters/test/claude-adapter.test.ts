import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentProcessIdentitySchema, type AgentStartRequest } from '@codeestra/contracts';
import { ClaudeAdapter } from '../src/claude-adapter.js';
import { ClaudeAdapterError, claudeProjectKey } from '../src/claude-protocol.js';

/**
 * A protocol stub for `claude --print --input-format stream-json`.
 *
 * It speaks the measured surface of `claude 2.1.268`: the `control_request`/`control_response`
 * envelope, the `initialize` handshake, `can_use_tool` permission prompts, `control_cancel_request`,
 * the `system/init` frame and the terminal `result` frame (including the measured auth-failure shape
 * where `subtype: "success"` carries `is_error: true`).
 *
 * It is a stub, not a real provider: it proves framing, orchestration and failure mapping only. The
 * real-provider evidence (and its limits) live in `docs/spikes/claude-2.1.268.md`.
 */
const stubSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('2.1.268 (Claude Code)\\n');
  process.exit(0);
}
const flag = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] ?? null : null; };
const mode = process.env.CODEESTRA_CLAUDE_STUB_MODE ?? 'SETTLE';
const reportPath = process.env.CODEESTRA_CLAUDE_STUB_REPORT;
const sessionId = flag('--session-id') ?? flag('--resume') ?? 'stub-session';
const requestedMode = flag('--permission-mode') ?? 'manual';
const echoMode = process.env.CODEESTRA_CLAUDE_STUB_PERMISSION_ECHO
  ?? (requestedMode === 'bypassPermissions' ? 'bypassPermissions' : 'default');
const reportedSessionId = process.env.CODEESTRA_CLAUDE_STUB_SESSION_ID ?? sessionId;
const received = { argv, cwd: process.cwd(), controlRequests: [], userMessages: [], controlResponses: [] };
const save = () => {
  if (!reportPath) return;
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(received, null, 2));
};
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
save();

const emitInit = (id) => emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: id,
  tools: ['Bash', 'Read', 'Write'], mcp_servers: [], model: 'claude-opus-5[1m]',
  permissionMode: echoMode, apiKeySource: 'none', claude_code_version: '2.1.268' });
const emitAssistant = (over = {}) => emit({ type: 'assistant', message: { role: 'assistant',
  model: 'claude-opus-5[1m]', stop_reason: 'tool_use', content: [
    { type: 'text', text: 'Working on it.' },
    { type: 'tool_use', id: 'toolu-1', name: 'Bash', input: { command: '/bin/sh -lc "echo hi"' } } ] },
  ...over });
const emitResult = (over = {}) => emit({ type: 'result', subtype: 'success', is_error: false,
  session_id: sessionId, num_turns: 1, terminal_reason: 'completed', total_cost_usd: 0.01,
  result: 'done', ...over });

let approvalAnswered = false;
const beginTurn = () => {
  if (mode === 'NO_INIT') { emitAssistant(); emitResult(); return; }
  if (mode === 'MISMATCH_INIT') { emitInit('other-conversation'); emitResult(); return; }
  emitInit(reportedSessionId);
  if (mode === 'LATE_MISMATCH_INIT') { emitInit('other-conversation'); emitResult(); return; }
  if (mode === 'CRASH') { emitAssistant(); setTimeout(() => process.exit(3), 50); return; }
  if (mode === 'AUTH_ERROR') {
    emit({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>',
      stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } });
    emitResult({ subtype: 'success', is_error: true, terminal_reason: 'api_error',
      result: 'Not logged in · Please run /login', total_cost_usd: 0 });
    return;
  }
  if (mode === 'FAILED_RESULT') {
    emitResult({ subtype: 'error_during_execution', is_error: true,
      terminal_reason: 'error_during_execution', result: 'the provider gave up' });
    return;
  }
  if (mode === 'UNPARSEABLE_FRAME') { emit({ type: 'result', nothing: 'useful' }); return; }
  if (mode === 'UNSUPPORTED_REQUEST') {
    emit({ type: 'control_request', request_id: 'cli-dialog-1', request: {
      subtype: 'request_user_dialog', dialog_kind: 'permission', payload: { question: 'pick one' },
      tool_use_id: 'toolu-dialog' } });
    return;
  }
  if (mode === 'APPROVAL' || mode === 'CANCEL_REQUEST' || mode === 'CANCEL_REQUEST_HOLD') {
    emitAssistant();
    emit({ type: 'control_request', request_id: 'cli-approval-1', request: {
      subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'toolu-1',
      input: { command: '/bin/sh -lc "echo hi"', description: 'say hi' },
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }] }],
      blocked_path: '/private/tmp/blocked', decision_reason: 'command needs approval',
      agent_id: 'main' } });
    if (mode === 'CANCEL_REQUEST') {
      emit({ type: 'control_cancel_request', request_id: 'cli-approval-1' });
      emitResult({ result: 'turn finished after the prompt was withdrawn' });
    }
    if (mode === 'CANCEL_REQUEST_HOLD') {
      // The CLI withdraws a prompt it no longer needs while the turn keeps running: the turn must
      // not be settled here, so the late-answer behaviour can be observed.
      setTimeout(() => emit({ type: 'control_cancel_request', request_id: 'cli-approval-1' }), 150);
    }
    return;
  }
  emitAssistant();
  emitResult();
};

const handle = (frame) => {
  if (frame.type === 'control_request') {
    received.controlRequests.push({ subtype: frame.request?.subtype ?? null, requestId: frame.request_id });
    save();
    if (frame.request?.subtype === 'initialize') {
      emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
        response: { commands: [], agents: [], output_style: 'default',
          current_permission_mode: echoMode, models: [] } } });
      return;
    }
    if (frame.request?.subtype === 'interrupt') {
      emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
        response: {} } });
      return;
    }
    return;
  }
  if (frame.type === 'user') {
    const content = frame.message?.content;
    received.userMessages.push(typeof content === 'string' ? content : JSON.stringify(content));
    save();
    beginTurn();
    return;
  }
  if (frame.type === 'control_response') {
    received.controlResponses.push({ subtype: frame.response?.subtype ?? null,
      requestId: frame.response?.request_id ?? null,
      result: frame.response?.response ?? null, error: frame.response?.error ?? null });
    save();
    if (mode === 'UNSUPPORTED_REQUEST') { emitResult({ result: 'continued without the dialog' }); return; }
    if (frame.response?.subtype === 'error') return;
    if (mode === 'APPROVAL' && !approvalAnswered) {
      approvalAnswered = true;
      emitResult();
    }
  }
};

let buffer = '';
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
  readonly controlRequests: readonly { readonly subtype: string | null; readonly requestId: string }[];
  readonly userMessages: readonly string[];
  readonly controlResponses: readonly { readonly subtype: string | null; readonly requestId: string | null;
    readonly result: unknown; readonly error: string | null }[];
}

const directories: string[] = [];
const adapters: ClaudeAdapter[] = [];

function temporaryDirectory(prefix: string): string {
  // macOS resolves /var to /private/var, and the child process reports the resolved path.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

/** A temporary directory kept in its unresolved spelling (`/var/...` instead of `/private/var/...`). */
function registerNonCanonicalDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-claude-adapter-unresolved-'));
  directories.push(realpathSync(directory));
  return directory;
}

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.releaseSession('session-under-test');
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface Fixture {
  readonly adapter: ClaudeAdapter;
  readonly root: string;
  readonly configDir: string;
  readonly reportPath: string;
  readonly providerSessionId: string;
  readonly transcriptPath: string;
  readonly startRequest: AgentStartRequest;
  received(): StubReceived;
  writeTranscript(sessionId?: string): string;
}

function fixture(mode: string, options: {
  readonly environment?: Readonly<Record<string, string>>;
  readonly resume?: AgentStartRequest['resume'];
  readonly agentConfig?: AgentStartRequest['agentConfig'];
  readonly permissionMode?: 'FULL' | 'STRICT';
  readonly startTimeoutMs?: number;
  readonly configDir?: string;
  /** Keeps the workspace path exactly as `mkdtemp` returned it, symlinked ancestors included. */
  readonly canonicalCwd?: boolean;
} = {}): Fixture {
  const root = options.canonicalCwd === false
    ? registerNonCanonicalDirectory()
    : temporaryDirectory('codeestra-claude-adapter-');
  const tools = join(root, 'tools');
  const configDir = options.configDir ?? join(root, 'claude-home');
  mkdirSync(tools, { recursive: true });
  const stubPath = join(tools, 'claude-stub.ts');
  Bun.write(stubPath, stubSource);
  chmodSync(stubPath, 0o755);
  const reportPath = join(tools, 'report.json');
  const providerSessionId = 'stub-session-fixed';
  const adapter = new ClaudeAdapter({
    claudeExecutable: process.execPath,
    launcherArgs: [stubPath],
    configDir,
    // A fixed conversation id keeps the transcript path and the assertions deterministic.
    randomUUID: () => providerSessionId,
    ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
    environment: {
      ...(Bun.env.PATH === undefined ? {} : { PATH: Bun.env.PATH }),
      CODEESTRA_CLAUDE_STUB_REPORT: reportPath,
      CODEESTRA_CLAUDE_STUB_MODE: mode,
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
    permissionMode: options.permissionMode ?? 'STRICT',
    environment: {},
    ...(options.agentConfig === undefined ? {} : { agentConfig: options.agentConfig }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
  };
  const transcriptPath = join(configDir, 'projects', claudeProjectKey(realpathSync(root)),
    `${providerSessionId}.jsonl`);
  return {
    adapter,
    root,
    configDir,
    reportPath,
    providerSessionId,
    transcriptPath,
    startRequest,
    received: () => JSON.parse(readFileSync(reportPath, 'utf8')) as StubReceived,
    writeTranscript: (sessionId = providerSessionId) => {
      const path = join(configDir, 'projects', claudeProjectKey(realpathSync(root)), `${sessionId}.jsonl`);
      mkdirSync(join(path, '..'), { recursive: true });
      Bun.write(path, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'earlier' } })}\n`);
      return path;
    },
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
  throw new Error('the Claude stub never reached the expected state');
}

interface SessionShape {
  readonly id: string;
  readonly executionId: string;
  readonly adapterId: string;
  readonly providerSessionId?: string;
}

/** Drains an observation stream; the stream itself is expected to end. */
async function collect(adapter: ClaudeAdapter, session: SessionShape,
  timeoutMs = 20_000): Promise<readonly { readonly type?: string }[]> {
  const events: { readonly type?: string }[] = [];
  const pump = (async () => {
    for await (const event of adapter.observe(session as never)) events.push(event as never);
  })();
  await Promise.race([pump, Bun.sleep(timeoutMs)]);
  return events;
}

/** Reads one event, or surfaces the error the adapter threw before producing any. */
async function firstEvent(adapter: ClaudeAdapter, session: SessionShape,
  cursor?: string): Promise<unknown> {
  for await (const event of adapter.observe(session as never, cursor)) return event;
  throw new Error('the observation stream ended without an event');
}

describe('Claude adapter capabilities', () => {
  test('reports the measured version and the full capability matrix', async () => {
    const { adapter } = fixture('SETTLE');
    const probe = await adapter.probe();
    expect(probe.version).toBe('2.1.268');
    // Every field is asserted, including the ones this Adapter must not claim. `REQUIRES_VALIDATION`
    // is used wherever the mechanism exists but a real-model observation is missing (this machine
    // has no Claude Code credentials), never `SUPPORTED` with the same caveat hidden in prose.
    expect(probe.capabilities).toEqual({
      persistentSession: 'SUPPORTED',
      structuredAttention: 'REQUIRES_VALIDATION',
      nativePermissionRouting: 'REQUIRES_VALIDATION',
      pauseWithQuiescence: 'UNSUPPORTED',
      revisionAcknowledgement: 'UNSUPPORTED',
      cooperativeStop: 'REQUIRES_VALIDATION',
      attach: 'UNSUPPORTED',
      nativeTerminalHandoff: 'UNSUPPORTED',
      safePointNotification: 'UNSUPPORTED',
      reconnectToLiveSession: 'UNSUPPORTED',
      resumeAfterExit: 'REQUIRES_VALIDATION',
      controlledConfiguration: 'SUPPORTED',
    });
    expect(adapter.capabilities()).toEqual(probe.capabilities);
  });

  test('an unresolvable provider is reported instead of pretending success', async () => {
    const adapter = new ClaudeAdapter({ claudeExecutable: 'definitely-missing-claude' });
    adapters.push(adapter);
    await expect(adapter.probe()).rejects.toMatchObject({ code: 'PROVIDER_VERSION_UNAVAILABLE' });
  });
});

describe('Claude adapter start', () => {
  test('launches the controlled stream-json channel and pins the conversation id', async () => {
    const fixtureUnderTest = fixture('SETTLE');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    expect(session).toMatchObject({
      id: 'session-under-test', executionId: 'execution-1', adapterId: 'claude',
      providerSessionId: fixtureUnderTest.providerSessionId,
      sessionStorageRef: fixtureUnderTest.transcriptPath,
    });
    expect(agentProcessIdentitySchema.safeParse(session.processIdentity).success).toBe(true);
    const report = await waitForReport(fixtureUnderTest, (r) => r.userMessages.length > 0);
    // STRICT is the provider's own `manual` mode; FULL is `bypassPermissions` (see the next test).
    expect(report.argv).toEqual([
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--safe-mode', '--strict-mcp-config', '--permission-prompts', 'host',
      '--permission-mode', 'manual', '--session-id', fixtureUnderTest.providerSessionId,
    ]);
    expect(report.cwd).toBe(fixtureUnderTest.root);
    expect(report.controlRequests.map((request) => request.subtype)).toEqual(['initialize']);
    expect(report.userMessages[0]).toContain('Codeestra revision revision-1');
    expect(report.userMessages[0]).toContain('- c1: Be safe');
  });

  test('records the conversation path the provider will actually write, resolved path included',
    async () => {
      // The provider keys its project directory on the resolved working directory, so a workspace
      // reached through a symlinked ancestor must still produce the path the provider uses.
      const fixtureUnderTest = fixture('SETTLE', { canonicalCwd: false });
      const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
      expect(fixtureUnderTest.startRequest.workspace.cwd).not.toBe(realpathSync(fixtureUnderTest.root));
      expect(session.sessionStorageRef).toBe(fixtureUnderTest.transcriptPath);
      const report = await waitForReport(fixtureUnderTest, (r) => r.userMessages.length > 0);
      expect(claudeProjectKey(report.cwd)).toBe(claudeProjectKey(realpathSync(fixtureUnderTest.root)));
    });

  test('FULL runs with bypassPermissions and dangerous-skip, and passes model and effort', async () => {
    const fixtureUnderTest = fixture('SETTLE', {
      permissionMode: 'FULL',
      agentConfig: { model: 'claude-opus-5[1m]', thinkingLevel: 'high' },
    });
    await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const report = await waitForReport(fixtureUnderTest, (r) => r.userMessages.length > 0);
    expect(report.argv).toEqual([
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--safe-mode', '--strict-mcp-config', '--permission-prompts', 'host',
      '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions',
      '--model', 'claude-opus-5[1m]', '--effort', 'high',
      '--session-id', fixtureUnderTest.providerSessionId,
    ]);
  });

  test('refuses a thinking level the provider cannot express, before launching anything', async () => {
    const fixtureUnderTest = fixture('SETTLE', { agentConfig: { thinkingLevel: 'minimal' } });
    await expect(fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest)).rejects
      .toMatchObject({ code: 'UNSUPPORTED_AGENT_CONFIGURATION' });
    expect(existsSync(fixtureUnderTest.reportPath)).toBe(false);
  });

  test('refuses a configured provider instead of recording one that was never used', async () => {
    const fixtureUnderTest = fixture('SETTLE', { agentConfig: { provider: 'bedrock' } });
    await expect(fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest)).rejects
      .toMatchObject({ code: 'UNSUPPORTED_AGENT_CONFIGURATION' });
    expect(existsSync(fixtureUnderTest.reportPath)).toBe(false);
  });

  test('refuses a session whose permission mode the provider did not open', async () => {
    const fixtureUnderTest = fixture('SETTLE', {
      permissionMode: 'FULL',
      environment: { CODEESTRA_CLAUDE_STUB_PERMISSION_ECHO: 'default' },
    });
    await expect(fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest)).rejects
      .toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    expect(fixtureUnderTest.adapter.unconfirmedStops()).toEqual([]);
  });

  test('refuses a conversation the provider opened under another session id', async () => {
    const fixtureUnderTest = fixture('MISMATCH_INIT');
    await expect(fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest)).rejects
      .toMatchObject({ code: 'SESSION_IDENTITY_MISMATCH' });
  });

  test('reports a provider that never opens a conversation, after a confirmed stop', async () => {
    const fixtureUnderTest = fixture('NO_INIT', { startTimeoutMs: 500 });
    const error = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest)
      .then(() => null, (reason: unknown) => reason as ClaudeAdapterError);
    expect(error?.code).toBe('INVALID_PROVIDER_RESPONSE');
    expect(error?.message).toContain('was confirmed stopped');
    expect(fixtureUnderTest.adapter.unconfirmedStops()).toEqual([]);
  });
});

describe('Claude adapter resume', () => {
  test('reopens the recorded conversation instead of starting a new one', async () => {
    const fixtureUnderTest = fixture('SETTLE');
    const transcript = fixtureUnderTest.writeTranscript();
    const session = await fixtureUnderTest.adapter.start({
      ...fixtureUnderTest.startRequest,
      resume: { predecessorSessionId: 'session-before', sessionStorageRef: transcript,
        providerSessionId: fixtureUnderTest.providerSessionId },
    });
    // The resumed path is the verified recorded one, not a freshly derived path: the worktree of a
    // retried Task can live somewhere else, and that must not invalidate the conversation.
    expect(session.sessionStorageRef).toBe(realpathSync(transcript));
    const report = await waitForReport(fixtureUnderTest, (r) => r.userMessages.length > 0);
    expect(report.argv).toContain('--resume');
    expect(report.argv).toContain(fixtureUnderTest.providerSessionId);
    expect(report.argv).not.toContain('--session-id');
    expect(report.userMessages[0]).toContain('has now resumed');
  });

  test('refuses a recorded path outside this config home', async () => {
    const fixtureUnderTest = fixture('SETTLE');
    const elsewhere = join(fixtureUnderTest.root, 'elsewhere', `${fixtureUnderTest.providerSessionId}.jsonl`);
    mkdirSync(join(elsewhere, '..'), { recursive: true });
    Bun.write(elsewhere, '{}\n');
    await expect(fixtureUnderTest.adapter.start({
      ...fixtureUnderTest.startRequest,
      resume: { predecessorSessionId: 'session-before', sessionStorageRef: elsewhere,
        providerSessionId: fixtureUnderTest.providerSessionId },
    })).rejects.toMatchObject({ code: 'RESUME_SESSION_NOT_OWNED' });
  });

  test('refuses a recorded path that does not exist or is not named after the conversation', async () => {
    const fixtureUnderTest = fixture('SETTLE');
    await expect(fixtureUnderTest.adapter.start({
      ...fixtureUnderTest.startRequest,
      resume: { predecessorSessionId: 'session-before',
        sessionStorageRef: fixtureUnderTest.transcriptPath,
        providerSessionId: fixtureUnderTest.providerSessionId },
    })).rejects.toMatchObject({ code: 'RESUME_SESSION_NOT_OWNED' });
    const other = fixtureUnderTest.writeTranscript('another-conversation');
    await expect(fixtureUnderTest.adapter.start({
      ...fixtureUnderTest.startRequest,
      resume: { predecessorSessionId: 'session-before', sessionStorageRef: other,
        providerSessionId: fixtureUnderTest.providerSessionId },
    })).rejects.toMatchObject({ code: 'RESUME_SESSION_NOT_OWNED' });
  });

  test('refuses a recorded path that is a symlink or nested deeper than one project directory',
    async () => {
      const fixtureUnderTest = fixture('SETTLE');
      const real = fixtureUnderTest.writeTranscript();
      const link = fixtureUnderTest.transcriptPath.replace(/\.jsonl$/, '-link.jsonl');
      // A symlink whose *name* matches the conversation is still not evidence that this Runtime's
      // provider wrote it, so it is refused before anything is resumed.
      const { symlinkSync } = await import('node:fs');
      symlinkSync(real, link);
      await expect(fixtureUnderTest.adapter.start({
        ...fixtureUnderTest.startRequest,
        resume: { predecessorSessionId: 'session-before', sessionStorageRef: link,
          providerSessionId: fixtureUnderTest.providerSessionId },
      })).rejects.toMatchObject({ code: 'RESUME_SESSION_NOT_OWNED' });

      const nested = join(fixtureUnderTest.configDir, 'projects', 'nested',
        claudeProjectKey(fixtureUnderTest.root), `${fixtureUnderTest.providerSessionId}.jsonl`);
      mkdirSync(join(nested, '..'), { recursive: true });
      Bun.write(nested, '{}\n');
      await expect(fixtureUnderTest.adapter.start({
        ...fixtureUnderTest.startRequest,
        resume: { predecessorSessionId: 'session-before', sessionStorageRef: nested,
          providerSessionId: fixtureUnderTest.providerSessionId },
      })).rejects.toMatchObject({ code: 'RESUME_SESSION_NOT_OWNED' });
    });

  test('refuses a resume with no recorded conversation id', async () => {
    const fixtureUnderTest = fixture('SETTLE');
    const transcript = fixtureUnderTest.writeTranscript();
    await expect(fixtureUnderTest.adapter.start({
      ...fixtureUnderTest.startRequest,
      resume: { predecessorSessionId: 'session-before', sessionStorageRef: transcript,
        providerSessionId: null },
    })).rejects.toMatchObject({ code: 'RESUME_SESSION_NOT_OWNED' });
  });

  test('refuses when the provider reopens a different conversation', async () => {
    const fixtureUnderTest = fixture('SETTLE', { environment: { CODEESTRA_CLAUDE_STUB_SESSION_ID: 'other' } });
    const transcript = fixtureUnderTest.writeTranscript();
    await expect(fixtureUnderTest.adapter.start({
      ...fixtureUnderTest.startRequest,
      resume: { predecessorSessionId: 'session-before', sessionStorageRef: transcript,
        providerSessionId: fixtureUnderTest.providerSessionId },
    })).rejects.toMatchObject({ code: 'SESSION_IDENTITY_MISMATCH' });
  });
});

describe('Claude adapter observation', () => {
  test('reports a settled turn as SUCCESS with provider facts and a confirmed stop', async () => {
    const fixtureUnderTest = fixture('SETTLE');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session);
    expect(events.at(-1)).toMatchObject({
      type: 'completed', outcome: 'SUCCESS',
      facts: { toolCallCount: 1, finalAssistantText: 'Working on it.',
        finalAssistantTextTruncated: false, finalAssistantStopReason: 'tool_use' },
      evidence: { toolsQuiescent: true, ownedWritersStopped: true },
    });
    expect(await fixtureUnderTest.adapter.releaseSession('session-under-test')).toBeNull();
  });

  test('never records the measured auth failure as SUCCESS', async () => {
    // Measured on the real CLI: an authentication failure arrives as `subtype: "success"` together
    // with `is_error: true` and `terminal_reason: "api_error"`. A verdict that read `subtype` alone
    // would report this run as a success.
    const fixtureUnderTest = fixture('AUTH_ERROR');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session);
    expect(events.at(-1)).toMatchObject({
      type: 'completed', outcome: 'FAILURE',
      failure: { code: 'PROVIDER_TURN_FAILED' },
    });
    expect(JSON.stringify(events.at(-1))).toContain('api_error');
    expect(JSON.stringify(events.at(-1))).toContain('Not logged in');
  });

  test('reports a failed provider result as FAILURE and an unreadable one as PROVIDER_RESPONSE_INVALID',
    async () => {
      const failed = fixture('FAILED_RESULT');
      const failedSession = await failed.adapter.start(failed.startRequest);
      const failedEvents = await collect(failed.adapter, failedSession);
      expect(failedEvents.at(-1)).toMatchObject({ type: 'completed', outcome: 'FAILURE',
        failure: { code: 'PROVIDER_TURN_FAILED' } });

      const unreadable = fixture('UNPARSEABLE_FRAME');
      const session = await unreadable.adapter.start(unreadable.startRequest);
      const events = await collect(unreadable.adapter, session);
      expect(events.at(-1)).toMatchObject({ type: 'completed', outcome: 'FAILURE',
        failure: { code: 'PROVIDER_RESPONSE_INVALID' } });
    });

  test('maps a permission request to the existing PERMISSION Attention and writes the answer back',
    async () => {
      const fixtureUnderTest = fixture('APPROVAL');
      const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
      const events: { readonly type?: string; readonly kind?: string; readonly responseType?: string;
        readonly providerRequestId?: string; readonly prompt?: Record<string, unknown> }[] = [];
      for await (const event of fixtureUnderTest.adapter.observe(session)) {
        events.push(event as never);
        if (event.type !== 'attention') continue;
        expect(event.kind).toBe('PERMISSION');
        expect(event.responseType).toBe('CONFIRM');
        expect(event.prompt).toMatchObject({
          kind: 'claude.permission', version: 1, toolName: 'Bash', toolUseId: 'toolu-1',
          blockedPath: '/private/tmp/blocked', decisionReason: 'command needs approval',
          suggestionCount: 1,
        });
        expect(String(JSON.stringify(event.prompt))).toContain('/bin/sh -lc');
        const receipt = await fixtureUnderTest.adapter.answer(session, {
          operationId: 'answer-1', answerId: 'answer-1', attentionId: 'attention-1',
          providerRequestId: event.providerRequestId as string, responseType: 'CONFIRM',
          answer: { type: 'CONFIRM', confirmed: true },
        });
        expect(receipt).toEqual({ providerRequestId: event.providerRequestId, accepted: true });
      }
      expect(events.at(-1)).toMatchObject({ type: 'completed', outcome: 'SUCCESS' });
      const report = await waitForReport(fixtureUnderTest, (r) => r.controlResponses.length > 0);
      expect(report.controlResponses[0]).toEqual({ subtype: 'success', requestId: 'cli-approval-1',
        result: { behavior: 'allow', toolUseID: 'toolu-1' }, error: null });
    });

  test('a denial answers the provider with deny, and a cancellation denies and interrupts', async () => {
    const denied = fixture('APPROVAL');
    const deniedSession = await denied.adapter.start(denied.startRequest);
    for await (const event of denied.adapter.observe(deniedSession)) {
      if (event.type !== 'attention') continue;
      await denied.adapter.answer(deniedSession, {
        operationId: 'answer-1', answerId: 'answer-1', attentionId: 'attention-1',
        providerRequestId: event.providerRequestId, responseType: 'CONFIRM',
        answer: { type: 'CONFIRM', confirmed: false },
      });
    }
    const deniedReport = await waitForReport(denied, (r) => r.controlResponses.length > 0);
    expect(deniedReport.controlResponses[0]?.result).toEqual({
      behavior: 'deny', message: 'Denied by the Codeestra user', toolUseID: 'toolu-1' });

    const cancelled = fixture('APPROVAL');
    const cancelledSession = await cancelled.adapter.start(cancelled.startRequest);
    for await (const event of cancelled.adapter.observe(cancelledSession)) {
      if (event.type !== 'attention') continue;
      await cancelled.adapter.answer(cancelledSession, {
        operationId: 'answer-1', answerId: 'answer-1', attentionId: 'attention-1',
        providerRequestId: event.providerRequestId, responseType: 'CONFIRM',
        answer: { type: 'CANCEL' },
      });
    }
    const cancelledReport = await waitForReport(cancelled, (r) => r.controlResponses.length > 0);
    expect(cancelledReport.controlResponses[0]?.result).toEqual({
      behavior: 'deny', message: 'Cancelled by the Codeestra user', interrupt: true,
      toolUseID: 'toolu-1' });
  });

  test('refuses a non-confirmation answer to a permission request without consuming it', async () => {
    const fixtureUnderTest = fixture('APPROVAL');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    for await (const event of fixtureUnderTest.adapter.observe(session)) {
      if (event.type !== 'attention') continue;
      await expect(fixtureUnderTest.adapter.answer(session, {
        operationId: 'answer-1', answerId: 'answer-1', attentionId: 'attention-1',
        providerRequestId: event.providerRequestId, responseType: 'VALUE',
        answer: { type: 'VALUE', value: 'yes' },
      })).rejects.toMatchObject({ code: 'UNSUPPORTED_ANSWER' });
      // The request is still open, so the user can still decide it.
      await fixtureUnderTest.adapter.answer(session, {
        operationId: 'answer-2', answerId: 'answer-2', attentionId: 'attention-1',
        providerRequestId: event.providerRequestId, responseType: 'CONFIRM',
        answer: { type: 'CONFIRM', confirmed: true },
      });
    }
  });

  test('refuses a second answer for the same request', async () => {
    const fixtureUnderTest = fixture('APPROVAL');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    for await (const event of fixtureUnderTest.adapter.observe(session)) {
      if (event.type !== 'attention') continue;
      const request = { operationId: 'answer-1', answerId: 'answer-1', attentionId: 'attention-1',
        providerRequestId: event.providerRequestId, responseType: 'CONFIRM' as const,
        answer: { type: 'CONFIRM' as const, confirmed: true } };
      await fixtureUnderTest.adapter.answer(session, request);
      await expect(fixtureUnderTest.adapter.answer(session, request)).rejects
        .toBeInstanceOf(ClaudeAdapterError);
    }
  });

  test('a withdrawn permission request can no longer be answered', async () => {
    // The prompt is delivered once (the Runtime already recorded that Attention) and then the CLI
    // withdraws it while the turn keeps running. An answer written afterwards must be refused as a
    // delivery failure, never reported as accepted.
    const fixtureUnderTest = fixture('CANCEL_REQUEST_HOLD');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const attention = await firstEvent(fixtureUnderTest.adapter, session) as
      { readonly type?: string; readonly providerRequestId?: string };
    expect(attention.type).toBe('attention');
    await Bun.sleep(500);
    await expect(fixtureUnderTest.adapter.answer(session, {
      operationId: 'answer-1', answerId: 'answer-1', attentionId: 'attention-1',
      providerRequestId: attention.providerRequestId as string, responseType: 'CONFIRM',
      answer: { type: 'CONFIRM', confirmed: true },
    })).rejects.toMatchObject({ code: 'UNKNOWN_PROVIDER_REQUEST' });
    await fixtureUnderTest.adapter.releaseSession('session-under-test');
  }, 20_000);

  test('refuses a control request this Adapter does not implement instead of hanging the turn',
    async () => {
      const fixtureUnderTest = fixture('UNSUPPORTED_REQUEST');
      const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
      const events = await collect(fixtureUnderTest.adapter, session);
      expect(events.at(-1)).toMatchObject({ type: 'completed', outcome: 'SUCCESS' });
      const report = await waitForReport(fixtureUnderTest, (r) => r.controlResponses.length > 0);
      expect(report.controlResponses[0]).toMatchObject({ subtype: 'error',
        requestId: 'cli-dialog-1' });
      expect(String(report.controlResponses[0]?.error)).toContain('request_user_dialog');
      // No Attention is invented for a dialog this host never declared it could render.
      expect(events.some((event) => event.type === 'attention')).toBe(false);
    }, 20_000);

  test('reports an unexpected provider exit as disconnected, never as a completion', async () => {
    const fixtureUnderTest = fixture('CRASH');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'disconnected' });
    await expect(firstEvent(fixtureUnderTest.adapter, session)).rejects
      .toMatchObject({ code: 'LIVE_SESSION_UNAVAILABLE' });
  });

  test('a second conversation claiming the same Session is reported as disconnected', async () => {
    const fixtureUnderTest = fixture('LATE_MISMATCH_INIT');
    const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const events = await collect(fixtureUnderTest.adapter, session);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'disconnected',
      reason: expect.stringContaining('other-conversation') });
  });

  test('rejects a cursor from another provider epoch and refuses observation of a lost Session',
    async () => {
      const fixtureUnderTest = fixture('SETTLE');
      const session = await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
      await expect(firstEvent(fixtureUnderTest.adapter, session, 'other-epoch:1')).rejects
        .toMatchObject({ code: 'CURSOR_EPOCH_MISMATCH' });
      await expect(firstEvent(fixtureUnderTest.adapter,
        { ...session, providerSessionId: 'another-conversation' })).rejects
        .toMatchObject({ code: 'SESSION_IDENTITY_MISMATCH' });
      await expect(firstEvent(fixtureUnderTest.adapter, { ...session, id: 'unknown-session' })).rejects
        .toMatchObject({ code: 'LIVE_SESSION_UNAVAILABLE' });
      await expect(fixtureUnderTest.adapter.answer(
        { ...session, id: 'unknown-session' },
        { operationId: 'answer-1', answerId: 'answer-1', attentionId: 'attention-1',
          providerRequestId: 'cli-approval-1', responseType: 'CONFIRM',
          answer: { type: 'CONFIRM', confirmed: true } },
      )).rejects.toMatchObject({ code: 'LIVE_SESSION_UNAVAILABLE' });
    });

  test('releaseSession stops the child and reports its exit', async () => {
    const fixtureUnderTest = fixture('SETTLE');
    await fixtureUnderTest.adapter.start(fixtureUnderTest.startRequest);
    const released = await fixtureUnderTest.adapter.releaseSession('session-under-test');
    expect(released?.exited).toBe(true);
    expect(await fixtureUnderTest.adapter.releaseSession('session-under-test')).toBeNull();
  });
});
