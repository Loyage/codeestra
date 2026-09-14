import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTemporaryDirectories, registerTemporaryDirectory } from './support/agent-fixture.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(() => { cleanupTemporaryDirectories(); });

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  const child = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd: repositoryRoot,
    env: { ...Bun.env, ...environment, no_proxy: '127.0.0.1,localhost' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Handoff Test',
      GIT_AUTHOR_EMAIL: 'handoff@example.invalid', GIT_COMMITTER_NAME: 'Handoff Test',
      GIT_COMMITTER_EMAIL: 'handoff@example.invalid' } });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

/**
 * A protocol stub, not a real provider. It speaks the same Runtime side channel the controlled gate
 * extension speaks (hello, STRICT permission request, fence acknowledgement, settled fact) so the
 * Runtime's handoff contract can be driven end to end through the CLI. It never executes a tool and
 * it is not evidence of a real Agent integration; the real-provider parts of this lane are listed as
 * unverified in `docs/tasks/README.md`.
 */
const stubSource = `
import { Socket } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const sessionDirIndex = argv.indexOf('--session-dir');
const sessionDir = sessionDirIndex >= 0 ? argv[sessionDirIndex + 1] : process.cwd();
mkdirSync(sessionDir, { recursive: true });
const sessionFile = join(sessionDir, 'handoff-session.jsonl');
const report = process.env.CODEESTRA_HANDOFF_REPORT;
const mode = process.env.CODEESTRA_HANDOFF_MODE ?? 'permission';
const socketPath = join(process.env.CODEESTRA_HOME ?? '/tmp', 'session-handoff.sock');
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
const reportNow = (value) => { if (report) writeFileSync(report, JSON.stringify(value)); };

let socket = null;
let controlBuffer = '';
let providerSessionId = null;
let channelConnected = false;
let permissionWanted = false;
const send = (frame) => { try { socket?.write(JSON.stringify(frame) + '\\n'); } catch {} };

/**
 * The provider never writes a business frame before hello: a frame that arrives first is refused as
 * refused as HANDSHAKE_REQUIRED, which is what keeps a foreign client from impersonating a writer.
 */
function askForPermission() {
  if (!channelConnected || !permissionWanted || mode !== 'permission') return;
  permissionWanted = false;
  send({ kind: 'permission_request', requestId: 'handoff-request-1', toolCallId: 'call-1',
    toolName: 'bash', inputJson: JSON.stringify({ command: 'rm -rf build' }),
    inputFingerprint: 'sha256:handoff-fingerprint', mode: 'rpc' });
}

function openChannel() {
  socket = new Socket();
  socket.setEncoding('utf8');
  socket.on('connect', () => {
    channelConnected = true;
    send({ kind: 'hello', protocol: 1, mode: 'rpc', hasUI: false, permissionMode: 'STRICT',
      pid: process.pid, providerSessionId, providerSessionFile: sessionFile });
    askForPermission();
  });
  socket.on('data', (chunk) => {
    controlBuffer += chunk;
    for (let index = controlBuffer.indexOf('\\n'); index !== -1;
      index = controlBuffer.indexOf('\\n')) {
      const line = controlBuffer.slice(0, index);
      controlBuffer = controlBuffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      const command = JSON.parse(line);
      if (command.kind === 'fence') {
        send({ kind: 'fence_ack', active: command.active === true });
        // A fenced run settles at the safe point without starting another tool.
        if (command.active === true) send({ kind: 'agent_settled' });
      } else if (command.kind === 'permission_decision') {
        reportNow({ decision: command.decision, requestId: command.requestId, kind: 'permission' });
        emit({ type: 'message_end', message: { role: 'assistant',
          content: [{ type: 'text', text: 'permission decision received' }], stopReason: 'stop' } });
        emit({ type: 'agent_settled' });
      }
    }
  });
  socket.on('error', () => { socket = null; channelConnected = false; });
  socket.on('close', () => { socket = null; channelConnected = false; });
  socket.connect(socketPath);
}

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
    if (record.type === 'get_state') {
      providerSessionId = 'handoff-session';
      emit({ id: record.id, type: 'response', command: 'get_state', success: true, data: {
        sessionId: providerSessionId, sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      if (!socket) openChannel();
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: providerSessionId, timestamp: '2026-09-13T09:00:00.000Z', cwd: process.cwd() }) + '\\n');
      permissionWanted = mode === 'permission';
      askForPermission();
      reportNow({ kind: 'started' });
    }
  }
}
`;

interface HandoffStatus {
  readonly sessionId: string;
  readonly executionId: string;
  readonly sessionState: string;
  readonly permissionMode: string;
  readonly incarnation: { readonly incarnationNumber: number; readonly mode: string;
    readonly state: string; readonly providerPid: number | null;
    readonly recordedDescendants: number } | null;
  readonly incarnations: readonly { readonly mode: string; readonly state: string }[];
  readonly terminal: { readonly state: string; readonly held: boolean;
    readonly providerPid: number | null } | null;
  readonly writerLease: { readonly holderKind: string; readonly holderRef: string } | null;
  readonly handoff: { readonly kind: string; readonly state: string;
    readonly fenceActive: boolean } | null;
  readonly handoffHistory: readonly { readonly state: string }[];
  readonly safePoint: { readonly reached: boolean; readonly fenceAcknowledged: boolean;
    readonly activeTools: number; readonly settledAfterFence: boolean;
    readonly openAttention: boolean; readonly missing: readonly string[] };
  readonly sideChannel: { readonly connected: boolean; readonly pid: number | null } | null;
  readonly permission: { readonly toolName: string; readonly toolCallId: string;
    readonly inputFingerprint: string; readonly decision: string } | null;
  readonly lastPermission: { readonly toolName: string; readonly decision: string;
    readonly decidedAt: number | null } | null;
  readonly capabilities: Readonly<Record<string, string>>;
}

interface AttentionPayload {
  readonly id: string;
  readonly kind: string;
  readonly responseType: string;
  readonly status: string;
  readonly sessionId: string;
  readonly prompt: { readonly kind?: string; readonly toolName?: string;
    readonly toolCallId?: string; readonly input?: unknown; readonly inputFingerprint?: string;
    readonly incarnationNumber?: number; readonly piMode?: string };
}

async function startHandoffTask(mode: 'permission' | 'fence'): Promise<{
  readonly environment: Record<string, string>;
  readonly projectId: string;
  readonly reportPath: string;
  readonly run: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
}> {
  const repository = temporaryDirectory('codeestra-handoff-repo-');
  const home = temporaryDirectory('codeestra-handoff-home-');
  const tools = temporaryDirectory('codeestra-handoff-tools-');
  const assets = temporaryDirectory('codeestra-handoff-assets-');
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  await git(repository, ['branch', 'dev']);

  const stubPath = join(tools, 'stub-pi.ts');
  const shimPath = join(tools, 'pi');
  const reportPath = join(tools, 'report.json');
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);

  const environment = {
    CODEESTRA_HOME: home,
    CODEESTRA_UI_DIST: assets,
    CODEESTRA_PI_EXECUTABLE: shimPath,
    CODEESTRA_HANDOFF_REPORT: reportPath,
    CODEESTRA_HANDOFF_MODE: mode,
  };
  const opened = await cli(['open', repository, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  const projectId = projects[0]?.id as string;
  const created = JSON.parse((await cli(['task', 'create', projectId,
    'Hand off one Agent session'], environment)).stdout) as { readonly id: string };
  const taskId = created.id;
  expect((await cli(['task', 'submit', projectId, taskId, '0'], environment)).exitCode).toBe(0);

  const run = Bun.spawn({
    cmd: [process.execPath, cliEntry, 'task', 'run', projectId, taskId, '1'],
    cwd: repositoryRoot,
    env: { ...Bun.env, ...environment, no_proxy: '127.0.0.1,localhost' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  return { environment, projectId, reportPath, run };
}

/**
 * The Session this project is running, read from the same command face a client has. `task run`
 * returns as soon as the Agent Session exists, so this waits for the recorded Session instead of
 * assuming it is already there.
 */
async function currentSessionId(
  environment: Record<string, string>,
  projectId: string,
  run?: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  let last = '';
  while (Date.now() < deadline) {
    const listed = JSON.parse((await cli(['task', 'list', projectId], environment)).stdout) as
      readonly { readonly id: string }[];
    const taskId = listed[0]?.id;
    if (taskId !== undefined) {
      const result = await cli(['task', 'status', projectId, taskId], environment);
      last = result.stdout;
      const status = JSON.parse(result.stdout) as { readonly executions: readonly {
        readonly session: { readonly sessionId: string } | null }[] };
      const sessionId = status.executions[0]?.session?.sessionId;
      if (sessionId !== undefined) return sessionId;
    }
    if (run !== undefined && run.exitCode !== null && run.exitCode !== 0) {
      const stderr = await new Response(run.stderr).text();
      throw new Error(`task run exited with ${run.exitCode}: ${stderr}`);
    }
    await Bun.sleep(100);
  }
  throw new Error(`The Task never started an Agent Session; last status was ${last}`);
}

async function readStatus(
  environment: Record<string, string>,
  projectId: string,
  sessionId: string,
): Promise<HandoffStatus> {
  const result = await cli(['session', 'handoff', 'status', projectId, sessionId, '--json'], environment);
  if (result.exitCode !== 0) throw new Error(`status failed (${result.exitCode}): ${result.stderr}`);
  return JSON.parse(result.stdout) as HandoffStatus;
}

async function waitForStatus(
  environment: Record<string, string>,
  projectId: string,
  sessionId: string,
  predicate: (status: HandoffStatus) => boolean,
  timeoutMs = 30_000,
): Promise<HandoffStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: HandoffStatus | null = null;
  while (Date.now() < deadline) {
    try {
      last = await readStatus(environment, projectId, sessionId);
      if (predicate(last)) return last;
    } catch { /* the Runtime may not have recorded the incarnation yet. */ }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for handoff state; last was ${JSON.stringify(last)}`);
}

describe('codeestra session handoff', () => {
  test('routes a STRICT permission to the existing attention face and reports the denial', async () => {
    const { environment, projectId, reportPath, run } = await startHandoffTask('permission');
    try {
      const sessionId = await currentSessionId(environment, projectId, run);
      const status = await waitForStatus(environment, projectId, sessionId,
        (candidate) => candidate.incarnation !== null && candidate.sideChannel !== null);
      expect(status.incarnation).toMatchObject({ incarnationNumber: 1, mode: 'AUTOMATED_RPC',
        state: 'ACTIVE' });
      expect(status.incarnation?.providerPid).toBe(status.sideChannel?.pid);
      expect(status.writerLease?.holderKind).toBe('AUTOMATED_RPC');
      expect(status.permissionMode).toBe('FULL');
      // The honest capability statement travels with the projection.
      expect(status.capabilities).toMatchObject({
        runtimeContract: 'IMPLEMENTED',
        singleWriterLease: 'IMPLEMENTED',
        strictPermissionOverSideChannel: 'IMPLEMENTED',
        // FOUNDATION-046 implemented the transport half; the honest projection says so.
        nativeTerminalAttach: 'IMPLEMENTED',
        ptyTransport: 'IMPLEMENTED',
        successorProcessStart: 'IMPLEMENTED',
        releaseBackToAutomation: 'IMPLEMENTED',
        attachToLiveRpcProcess: 'UNSUPPORTED',
      });

      // The permission is a normal Attention of the existing command face, with the structured
      // request (tool name, exact input, fingerprint) the gate extension sent.
      const deadline = Date.now() + 30_000;
      let attention: AttentionPayload | undefined;
      while (Date.now() < deadline && attention === undefined) {
        const listed = await cli(['attention', 'list', projectId], environment);
        const attentions = JSON.parse(listed.stdout) as readonly AttentionPayload[];
        attention = attentions.find((candidate) => candidate.status === 'OPEN');
        if (attention === undefined) await Bun.sleep(100);
      }
      expect(attention?.kind).toBe('PERMISSION');
      expect(attention?.responseType).toBe('CONFIRM');
      expect(attention?.prompt).toMatchObject({
        kind: 'codeestra.permission',
        version: 1,
        toolName: 'bash',
        toolCallId: 'call-1',
        input: { command: 'rm -rf build' },
        inputFingerprint: 'sha256:handoff-fingerprint',
        piMode: 'rpc',
      });
      expect(attention?.sessionId).toBe(sessionId);
      expect((await readStatus(environment, projectId, sessionId)).permission?.decision).toBe('OPEN');

      // A second writer is refused by the Runtime, not queued, and the CLI reports the code.
      const busy = await cli(['session', 'handoff', 'writer', 'acquire', projectId, sessionId,
        '--holder', 'probe', '--kind', 'TERMINAL_ATTACHMENT'], environment);
      expect(busy.exitCode).toBe(1);
      expect(busy.stderr).toContain('ATTACHMENT_BUSY');
      expect((await readStatus(environment, projectId, sessionId)).writerLease?.holderRef)
        .toBe(status.writerLease?.holderRef);

      // The denial is delivered over the side channel to the provider that asked, and the CLI
      // exits 0 for "the answer was recorded and delivered", with the decision visible.
      const answered = await cli(['attention', 'answer', projectId, attention?.id as string,
        'confirm', 'no'], environment);
      expect(answered.exitCode).toBe(0);
      expect(JSON.parse(answered.stdout)).toMatchObject({ status: 'DELIVERED', decision: 'DENY' });
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { readonly decision: string };
      expect(report.decision).toBe('DENY');
      const afterDeny = await waitForStatus(environment, projectId, sessionId,
        (candidate) => candidate.permission === null);
      expect(afterDeny.permission).toBeNull();
      expect(afterDeny.lastPermission).toMatchObject({ toolName: 'bash', decision: 'DENY' });
      // The denial is not an approval the Runtime recorded elsewhere: the Execution has no result.
      expect(afterDeny.sessionState).toBe('EXITED');
    } finally {
      run.kill('SIGTERM');
      await cli(['stop'], environment);
    }
  }, 60_000);

  test('requires a safe point, then hands the conversation to a native terminal', async () => {
    const { environment, projectId, run } = await startHandoffTask('fence');
    try {
      const sessionId = await currentSessionId(environment, projectId, run);
      await waitForStatus(environment, projectId, sessionId,
        (candidate) => candidate.incarnation !== null && candidate.sideChannel !== null);

      const requested = await cli(['session', 'handoff', 'request', projectId, sessionId, 'takeover'],
        environment);
      expect(requested.exitCode).toBe(0);
      expect(JSON.parse(requested.stdout)).toMatchObject({ handoff: { kind: 'TAKEOVER' } });

      // The fence is a handoff correctness control: the provider acknowledges it, and only then do
      // the structured facts (no active tool, settled after the fence) make a safe point.
      const safe = await waitForStatus(environment, projectId, sessionId,
        (candidate) => candidate.safePoint.reached);
      expect(safe.handoff?.state).toBe('AT_SAFE_POINT');
      expect(safe.safePoint).toMatchObject({ reached: true, fenceAcknowledged: true,
        activeTools: 0, settledAfterFence: true, openAttention: false });
      expect(safe.safePoint.missing).toHaveLength(0);

      // Admission stops the automation process the Runtime itself still holds and then really starts
      // the native terminal successor (FOUNDATION-046). A predecessor the Runtime does *not* hold is
      // never signalled, and an unverifiable one is refused (see the service tests).
      const admitted = await cli(['session', 'handoff', 'admit', projectId, sessionId], environment);
      expect(admitted.exitCode).toBe(0);
      expect(JSON.parse(admitted.stdout)).toMatchObject({ admitted: true, code: 'ADMITTED',
        predecessorObservation: 'STOPPED', successorStarted: true,
        successorMode: 'HUMAN_TUI', terminalTransport: 'PTY' });
      const afterAdmit = await waitForStatus(environment, projectId, sessionId,
        (candidate) => candidate.incarnations.length === 2);
      expect(afterAdmit.incarnations.map((incarnation) => incarnation.mode))
        .toEqual(['AUTOMATED_RPC', 'HUMAN_TUI']);
      expect(afterAdmit.terminal?.state).toBe('RUNNING');
      expect(afterAdmit.writerLease?.holderKind).toBe('TERMINAL_ATTACHMENT');

      // The handoff is admitted now, so there is nothing left to cancel: a refusal, not a success.
      const cancelled = await cli(['session', 'handoff', 'cancel', projectId, sessionId], environment);
      expect(cancelled.exitCode).toBe(1);
      expect(`${cancelled.stdout}${cancelled.stderr}`).toContain('HANDOFF_NOT_REQUESTED');
      // The native terminal is the writer, and its incarnation is the current one.
      expect(afterAdmit.incarnation?.mode).toBe('HUMAN_TUI');
      expect(afterAdmit.incarnation?.state).toBe('ACTIVE');
      expect(afterAdmit.terminal?.held).toBe(true);
    } finally {
      run.kill('SIGTERM');
      await cli(['stop'], environment);
    }
  }, 60_000);
});
