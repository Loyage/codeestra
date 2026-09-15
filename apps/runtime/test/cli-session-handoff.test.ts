import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  sessionHandoffEventTypes,
  sessionHandoffCompletedPayloadSchema,
  sessionHandoffStartedPayloadSchema,
  takeoverFailedPayloadSchema,
  takeoverReleasedPayloadSchema,
  takeoverRequestedPayloadSchema,
  takeoverSafePointReachedPayloadSchema,
} from '@codeestra/contracts';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => { await reclaimTestResources(); });

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  // FOUNDATION-057: the shared runner refuses a non-temporary CODEESTRA_HOME (a test must never
  // reach the real Runtime home) and registers the home so teardown stops any Runtime it started,
  // including when an assertion fails before the test's own stop.
  return await runCli(args, environment, { entry: cliEntry });
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
  const fixture = await handoffFixture(mode);
  const created = JSON.parse((await cli(['task', 'create', fixture.projectId,
    'Hand off one Agent session'], fixture.environment)).stdout) as { readonly id: string };
  const taskId = created.id;
  expect((await cli(['task', 'submit', fixture.projectId, taskId, '0'], fixture.environment)).exitCode)
    .toBe(0);

  const run = Bun.spawn({
    cmd: [process.execPath, cliEntry, 'task', 'run', fixture.projectId, taskId, '1'],
    cwd: repositoryRoot,
    env: { ...Bun.env, ...fixture.environment, no_proxy: '127.0.0.1,localhost' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  return { environment: fixture.environment, projectId: fixture.projectId,
    reportPath: fixture.reportPath, run };
}

/**
 * The trusted project, temporary home and protocol stub every test in this file drives. The provider
 * is a stub that speaks the same side channel the controlled gate extension speaks; it is never a
 * real Agent integration (see the note on `stubSource`).
 */async function handoffFixture(mode: 'permission' | 'fence'): Promise<{
  readonly environment: Record<string, string>;
  readonly projectId: string;
  readonly reportPath: string;
  readonly repository: string;
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
  return { environment, projectId: projects[0]?.id as string, reportPath, repository };
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

interface HandoffEventRow {
  readonly eventId: string; readonly sequence: number; readonly eventType: string;
  readonly aggregateType: string; readonly aggregateId: string; readonly aggregateVersion: number;
  readonly correlationId: string; readonly payload: Record<string, unknown>;
}

/** `events list` prints the Runtime projection verbatim; `--json` states that intent for scripts. */
async function readEvents(environment: Record<string, string>, projectId: string):
Promise<readonly HandoffEventRow[]> {
  const result = await cli(['events', 'list', '--project', projectId, '--limit', '500', '--json'],
    environment);
  if (result.exitCode !== 0) {
    throw new Error(`events list failed (${result.exitCode}): ${result.stderr}`);
  }
  return (JSON.parse(result.stdout) as { readonly events: readonly HandoffEventRow[] }).events;
}

const eventsOfType = (events: readonly HandoffEventRow[], eventType: string): readonly HandoffEventRow[] =>
  events.filter((event) => event.eventType === eventType);

/**
 * The seven handoff/terminal facts this lane adds, each asserted from a real command's output plus the
 * event log (FOUNDATION-059, ADR-0035).
 *
 * The provider here is the protocol stub defined at the top of this file: it speaks the Runtime's
 * handoff side channel (hello, fence acknowledgement, settled fact) and nothing else. It is not a
 * real Agent integration, and this test proves the Runtime's own event contract — not model behaviour.
 */
describe('handoff and terminal events over the command face', () => {
  test('every fact is readable from events list, in one aggregate per takeover', async () => {
    const { environment, projectId, run } = await startHandoffTask('fence');
    try {
      const sessionId = await currentSessionId(environment, projectId, run);
      await waitForStatus(environment, projectId, sessionId,
        (candidate) => candidate.incarnation !== null && candidate.sideChannel !== null);

      // `TerminalWriterLeaseChanged` (ACQUIRED): the automation incarnation took the single writer
      // lease when the Session started, which is what makes a second writer a refusal.
      const started = await readEvents(environment, projectId);
      const automationLease = eventsOfType(started, 'TerminalWriterLeaseChanged');
      expect(automationLease).toHaveLength(1);
      expect(automationLease[0]).toMatchObject({ aggregateType: 'SessionWriterLease',
        aggregateVersion: 1 });
      expect(automationLease[0]?.payload).toMatchObject({ action: 'ACQUIRED', before: null,
        takeoverId: null, sessionId,
        after: { holderKind: 'AUTOMATED_RPC' } });

      // `TakeoverFailed`: an admission with no request is refused *and* that refusal is a fact with
      // the stable code a client branches on — never silence.
      const refused = await cli(['session', 'handoff', 'admit', projectId, sessionId], environment);
      expect(refused.exitCode).toBe(1);
      expect(JSON.parse(refused.stdout)).toMatchObject({ admitted: false,
        code: 'HANDOFF_NOT_REQUESTED' });
      const refusedEvents = await readEvents(environment, projectId);
      const failures = eventsOfType(refusedEvents, 'TakeoverFailed');
      expect(failures).toHaveLength(1);
      expect(failures[0]?.payload).toMatchObject({ reason: 'HANDOFF_NOT_REQUESTED', stage: 'ADMIT',
        takeoverId: null, sessionId });
      expect(takeoverFailedPayloadSchema.parse(failures[0]?.payload)).toMatchObject({
        reason: 'HANDOFF_NOT_REQUESTED' });

      // `TakeoverRequested`: the intent and its fence are one fact.
      const requested = await cli(['session', 'handoff', 'request', projectId, sessionId, 'takeover'],
        environment);
      expect(requested.exitCode).toBe(0);
      const takeoverId = (JSON.parse(requested.stdout) as
        { readonly handoff: { readonly requestId: string } }).handoff.requestId;
      const afterRequest = await readEvents(environment, projectId);
      const intents = eventsOfType(afterRequest, 'TakeoverRequested');
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ aggregateType: 'SessionHandoff', aggregateId: takeoverId,
        aggregateVersion: 1 });
      expect(takeoverRequestedPayloadSchema.parse(intents[0]?.payload)).toMatchObject({
        takeoverId, kind: 'TAKEOVER', targetMode: 'HUMAN_TUI', sessionId,
      });

      // `TakeoverSafePointReached`: written with the safe-point state change, carrying the facts it
      // was decided from (and the still-missing list, which is empty here).
      await waitForStatus(environment, projectId, sessionId, (candidate) => candidate.safePoint.reached);
      const afterSafePoint = await readEvents(environment, projectId);
      const safePoints = eventsOfType(afterSafePoint, 'TakeoverSafePointReached');
      expect(safePoints).toHaveLength(1);
      expect(takeoverSafePointReachedPayloadSchema.parse(safePoints[0]?.payload)).toMatchObject({
        takeoverId, reachedFrom: 'RPC_FENCE', fenceAcknowledged: true, activeTools: 0, missing: [],
      });

      // `SessionHandoffStarted` and `SessionHandoffCompleted`: the predecessor stopped being the
      // writer, then a successor was really started and recorded. Two different facts.
      const admitted = await cli(['session', 'handoff', 'admit', projectId, sessionId], environment);
      expect(admitted.exitCode).toBe(0);
      const afterAdmit = await readEvents(environment, projectId);
      const begun = eventsOfType(afterAdmit, 'SessionHandoffStarted');
      const completed = eventsOfType(afterAdmit, 'SessionHandoffCompleted');
      expect(begun).toHaveLength(1);
      expect(completed).toHaveLength(1);
      expect(sessionHandoffStartedPayloadSchema.parse(begun[0]?.payload)).toMatchObject({
        takeoverId, sourceSessionId: sessionId, targetSessionId: sessionId,
        fromMode: 'AUTOMATED_RPC', toMode: 'HUMAN_TUI', predecessorObservation: 'STOPPED',
      });
      const completion = sessionHandoffCompletedPayloadSchema.parse(completed[0]?.payload);
      expect(completion).toMatchObject({ takeoverId, fromMode: 'AUTOMATED_RPC', toMode: 'HUMAN_TUI',
        successorIncarnationNumber: 2, terminalTransport: 'PTY' });
      expect(completion.terminalId).not.toBeNull();
      expect(completion.providerPid).toBeGreaterThan(0);
      // The admission moved the lease twice: released from the automation, taken by the terminal.
      const leases = eventsOfType(afterAdmit, 'TerminalWriterLeaseChanged');
      expect(leases.map((event) => event.payload['action'])).toEqual(['ACQUIRED', 'RELEASED', 'ACQUIRED']);
      expect(leases[1]?.payload).toMatchObject({ takeoverId, action: 'RELEASED',
        before: { holderKind: 'AUTOMATED_RPC' }, after: null });
      expect(leases[2]?.payload).toMatchObject({ takeoverId, action: 'ACQUIRED', before: null,
        after: { holderKind: 'TERMINAL_ATTACHMENT' } });
      // One aggregate per takeover, strictly increasing: the order of a takeover's facts is readable
      // from the log alone. The refusal that happened before any request existed has no takeover to
      // belong to, so it is version 1 of a `SessionHandoff` aggregate keyed on the Session.
      expect(failures[0]).toMatchObject({ aggregateType: 'SessionHandoff', aggregateId: sessionId,
        aggregateVersion: 1 });
      expect([...intents, ...failures, ...safePoints, ...begun, ...completed]
        .map((event) => event?.aggregateVersion)).toEqual([1, 1, 2, 3, 4]);
      expect([intents[0], ...safePoints, ...begun, ...completed]
        .every((event) => event?.aggregateId === takeoverId)).toBe(true);

      // `TakeoverReleased`: the human terminal is released, and only a release that was *proven*
      // (provider exited, nothing from its process tree alive, session file untouched) says so.
      const released = await cli(['session', 'handoff', 'release', projectId, sessionId, '--no-resume'],
        environment);
      expect(released.exitCode).toBe(0);
      expect(JSON.parse(released.stdout)).toMatchObject({ released: true });
      const afterRelease = await readEvents(environment, projectId);
      const releases = eventsOfType(afterRelease, 'TakeoverReleased');
      expect(releases).toHaveLength(1);
      const release = takeoverReleasedPayloadSchema.parse(releases[0]?.payload);
      expect(release).toMatchObject({ sessionId, predecessorObservation: 'STOPPED',
        sessionFile: { predecessorEntrySurvived: true, truncated: false } });
      expect(release.terminalId).not.toBeNull();
      // The release is also this handoff's safe point, and it says how it was reached.
      const releaseSafePoint = eventsOfType(afterRelease, 'TakeoverSafePointReached')
        .filter((event) => event.payload['takeoverId'] === release.takeoverId)[0];
      expect(takeoverSafePointReachedPayloadSchema.parse(releaseSafePoint?.payload)).toMatchObject({
        reachedFrom: 'TERMINAL_RELEASE', fenceAcknowledged: false, missing: [],
      });

      // All seven names of this lane are in the ledger, and every payload is a fact the contract
      // describes (each was parsed against its schema above; this is the inventory check).
      const names = new Set(afterRelease.map((event) => event.eventType));
      for (const name of sessionHandoffEventTypes) expect([...names]).toContain(name);
    } finally {
      run.kill('SIGTERM');
      await cli(['stop'], environment);
    }
  }, 90_000);

  test('replaying an admission adds no second handoff fact', async () => {
    const { environment, projectId, run } = await startHandoffTask('fence');
    try {
      const sessionId = await currentSessionId(environment, projectId, run);
      await waitForStatus(environment, projectId, sessionId,
        (candidate) => candidate.incarnation !== null && candidate.sideChannel !== null);
      await cli(['session', 'handoff', 'request', projectId, sessionId, 'takeover'], environment);
      await waitForStatus(environment, projectId, sessionId, (candidate) => candidate.safePoint.reached);

      const first = await cli(['session', 'handoff', 'admit', projectId, sessionId], environment);
      expect(first.exitCode).toBe(0);
      // A repeated admission replays the recorded successor instead of starting a second provider.
      const replayed = await cli(['session', 'handoff', 'admit', projectId, sessionId], environment);
      expect(replayed.exitCode).toBe(0);
      expect(JSON.parse(replayed.stdout)).toMatchObject({ admitted: true, replayed: true });

      const events = await readEvents(environment, projectId);
      expect(eventsOfType(events, 'SessionHandoffStarted')).toHaveLength(1);
      expect(eventsOfType(events, 'SessionHandoffCompleted')).toHaveLength(1);
      expect(eventsOfType(events, 'TakeoverRequested')).toHaveLength(1);
      expect(eventsOfType(events, 'TakeoverSafePointReached')).toHaveLength(1);
      // Two lease terms were taken and one released: the successor really is the only writer.
      expect(eventsOfType(events, 'TerminalWriterLeaseChanged')).toHaveLength(3);
      const status = await readStatus(environment, projectId, sessionId);
      expect(status.incarnations).toHaveLength(2);
    } finally {
      run.kill('SIGTERM');
      await cli(['stop'], environment);
    }
  }, 90_000);

  test('keeps a historical event written under a superseded design name readable', async () => {
    const fixture = await handoffFixture('fence');
    const home = fixture.environment['CODEESTRA_HOME'] as string;
    try {
      // The event ledger is append-only, so a row that was written under a design name the catalogue
      // later dropped (`TaskRevisionAppended` was implemented as `TaskRevisionCreated`) must read back
      // unchanged: not renamed, not migrated, not hidden.
      await cli(['stop'], fixture.environment);
      const raw = new Database(join(home, 'runtime.sqlite'));
      raw.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES ('legacy-event-1',?1,'TaskRevisionAppended',1,'Task','legacy-task',1,'legacy-command',
          NULL,1,'{"taskId":"legacy-task","previousRevisionId":"r-1","revisionId":"r-2",
          "affectedExecutionId":null}')
      `).run(fixture.projectId);
      raw.close();

      const events = await readEvents(fixture.environment, fixture.projectId);
      const legacy = eventsOfType(events, 'TaskRevisionAppended');
      expect(legacy).toHaveLength(1);
      expect(legacy[0]).toMatchObject({ eventId: 'legacy-event-1', aggregateType: 'Task',
        aggregateId: 'legacy-task', aggregateVersion: 1, correlationId: 'legacy-command' });
      expect(legacy[0]?.payload).toEqual({ taskId: 'legacy-task', previousRevisionId: 'r-1',
        revisionId: 'r-2', affectedExecutionId: null });
      // The implementation's own name is a *different* row: nothing was rewritten in place.
      expect(eventsOfType(events, 'TaskRevisionCreated')).toHaveLength(0);
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 60_000);
});
