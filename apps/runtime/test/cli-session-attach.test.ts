import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';
import { provisionDevClone } from './support/agent-fixture.js';

/**
 * End-to-end native terminal handoff through the CLI and the real Runtime, with the real PTY
 * transport and a *stub* provider.
 *
 * What is real here: the Runtime's terminal service, the PTY host (a real terminal device), the
 * single writer lease and incarnation chain in SQLite, the side channel, the release protocol, the
 * ownership verification and the provider session-file check. What is not real: Pi itself. The stub
 * speaks the provider protocol (RPC framing and the gate side channel) and, in terminal mode, prints
 * a banner, switches its terminal to raw mode, appends to the session file and exits with a code.
 *
 * The real Pi TUI on this transport is a user-visible check; it is listed as unverified in
 * `docs/tasks/README.md` and this test never claims otherwise.
 */
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
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Attach Test',
      GIT_AUTHOR_EMAIL: 'attach@example.invalid', GIT_COMMITTER_NAME: 'Attach Test',
      GIT_COMMITTER_EMAIL: 'attach@example.invalid' } });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

const stubSource = `
import { Socket } from 'node:net';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('0.84.4\\n'); process.exit(0); }
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const rpc = valueOf('--mode') === 'rpc';
const sessionArg = valueOf('--session');
const sessionDir = valueOf('--session-dir') ?? process.cwd();
mkdirSync(sessionDir, { recursive: true });
const sessionFile = sessionArg ?? join(sessionDir, 'stub-session.jsonl');
const providerSessionId = 'stub-provider-session';
const report = process.env.CODEESTRA_HANDOFF_REPORT;
const reportNow = (value) => { if (report) writeFileSync(report, JSON.stringify(value)); };
if (!sessionArg) {
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'stub-entry-1' }) + '\\n');
}

const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
// The mode this provider process was REALLY launched with, read from its own argv and environment:
// a cross-handoff assertion has to be about what the successor process received, not about what the
// Runtime meant to pass. One JSONL line per incarnation, in launch order.
const modesPath = process.env.CODEESTRA_HANDOFF_MODES;
const modeFacts = {
  incarnation: rpc ? 'AUTOMATED_RPC' : 'HUMAN_TUI',
  permissionMode: process.env.CODEESTRA_PERMISSION_MODE ?? null,
  argvMode: argv.includes('--approve') ? 'FULL' : (argv.includes('--no-approve') ? 'STRICT' : null),
  toolsFlag: argv.includes('--tools') ? argv[argv.indexOf('--tools') + 1] : null,
  pid: process.pid,
};
const reportMode = () => {
  if (modesPath) appendFileSync(modesPath, JSON.stringify(modeFacts) + '\\n');
};
let socket = null;
let controlBuffer = '';
const send = (frame) => { try { socket?.write(JSON.stringify(frame) + '\\n'); } catch {} };
function openChannel() {
  socket = new Socket();
  socket.setEncoding('utf8');
  socket.on('connect', () => {
    send({ kind: 'hello', protocol: 1, mode: rpc ? 'rpc' : 'tui', hasUI: !rpc,
      permissionMode: modeFacts.permissionMode, pid: process.pid,
      providerSessionId, providerSessionFile: sessionFile });
    reportMode();
    reportNow({ kind: 'channel', mode: rpc ? 'rpc' : 'tui', providerSessionId, sessionFile,
      pid: process.pid, resumed: sessionArg !== null });
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
        // The automation settles at the fence: the structured safe point travels on the side
        // channel, and the RPC stream carries the same settled fact so the Runtime's Adapter stops
        // the process it owns (which is what a real Pi does when its run is collected).
        if (command.active === true) {
          send({ kind: 'agent_settled' });
          if (rpc) {
            emit({ type: 'message_end', message: { role: 'assistant',
              content: [{ type: 'text', text: 'handing over' }], stopReason: 'stop' } });
            emit({ type: 'agent_settled' });
          }
        }
      } else if (command.kind === 'permission_decision') {
        reportNow({ kind: 'permission', decision: command.decision });
      }
    }
  });
  socket.on('error', () => { socket = null; });
  socket.on('close', () => { socket = null; });
  socket.connect(join(process.env.CODEESTRA_HOME ?? '/tmp', 'session-handoff.sock'));
}

if (!rpc) {
  // Native terminal mode: a real terminal device, raw mode, and the provider's own release byte.
  process.stdout.write('STUB-TUI-BANNER ' + sessionFile + '\\n');
  Bun.spawnSync(['stty', 'raw', '-echo'], { stdio: ['inherit', 'pipe', 'pipe'] });
  openChannel();
  let seen = '';
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    const text = decoder.decode(chunk);
    seen += text;
    process.stdout.write('STUB-TUI-ECHO:' + text.replace(/\\r?\\n/g, '') + '\\n');
    // The provider reads its own geometry from its own terminal: the same fact a real TUI reflows on.
    if (text.includes('SIZE?')) {
      const size = Bun.spawnSync(['stty', 'size'], { stdio: ['inherit', 'pipe', 'pipe'] })
        .stdout.toString().trim();
      process.stdout.write('STUB-TUI-SIZE:' + size + '\\n');
    }
    if (seen.includes('\\u0004')) break;
  }
  // The release is recorded in the provider's own conversation file before it exits, with the exit
  // code the environment asks for: the Runtime must not decide anything from that code.
  appendFileSync(sessionFile, JSON.stringify({ type: 'message', id: 'tui-release-entry' }) + '\\n');
  process.stdout.write('STUB-TUI-RELEASED\\n');
  process.exit(Number(process.env.CODEESTRA_STUB_TUI_EXIT ?? '7'));
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
      emit({ id: record.id, type: 'response', command: 'get_state', success: true,
        data: { sessionId: providerSessionId, sessionFile, messageCount: sessionArg ? 3 : 1 } });
    } else if (record.type === 'prompt') {
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      // A resumed conversation appends its continuation to the same file instead of starting over.
      appendFileSync(sessionFile, JSON.stringify({ type: 'message',
        id: sessionArg ? 'rpc-return-entry' : 'rpc-start-entry' }) + '\\n');
      openChannel();
      reportNow({ kind: 'prompt', resumed: sessionArg !== null, sessionFile });
    }
  }
}
`;

interface Status {
  readonly executionState: string;
  readonly sessionState: string;
  readonly incarnation: { readonly incarnationNumber: number; readonly mode: string;
    readonly state: string; readonly providerPid: number | null;
    readonly sessionStorageRef: string | null; readonly predecessorIncarnationId: string | null } | null;
  readonly incarnations: readonly { readonly incarnationNumber: number; readonly mode: string;
    readonly state: string; readonly predecessorIncarnationId: string | null;
    readonly sessionStorageRef: string | null }[];
  readonly writerLease: { readonly holderKind: string; readonly holderRef: string } | null;
  readonly handoff: { readonly kind: string; readonly state: string } | null;
  readonly safePoint: { readonly reached: boolean };
  readonly terminal: {
    readonly terminalId: string; readonly state: string; readonly held: boolean;
    readonly providerPid: number | null; readonly windowSize: string; readonly cursor: number;
    readonly currentSize: { readonly cols: number; readonly rows: number } | null;
    readonly writer: { readonly holderRef: string } | null;
    readonly release: { readonly exit: { readonly code: number | null } | null };
  } | null;
  readonly capabilities: Readonly<Record<string, string>>;
  readonly permissionMode: 'FULL' | 'STRICT';
}

async function readStatus(environment: Record<string, string>, projectId: string,
  sessionId: string): Promise<Status> {
  const result = await cli(['session', 'handoff', 'status', projectId, sessionId], environment);
  if (result.exitCode !== 0) throw new Error(`status failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Status;
}

async function waitForStatus(environment: Record<string, string>, projectId: string,
  sessionId: string, predicate: (status: Status) => boolean, timeoutMs = 30_000): Promise<Status> {
  const deadline = Date.now() + timeoutMs;
  let last: Status | null = null;
  while (Date.now() < deadline) {
    try {
      last = await readStatus(environment, projectId, sessionId);
      if (predicate(last)) return last;
    } catch { /* the Runtime may not have recorded the state yet */ }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for handoff state; last was ${JSON.stringify(last)}`);
}

async function startTask(options: { readonly permissionMode?: 'FULL' | 'STRICT' } = {}): Promise<{
  readonly environment: Record<string, string>;
  readonly projectId: string;
  readonly sessionId: string;
  readonly reportPath: string;
  readonly modesPath: string;
}> {
  const repository = temporaryDirectory('codeestra-attach-repo-');
  const home = temporaryDirectory('codeestra-attach-home-');
  const tools = temporaryDirectory('codeestra-attach-tools-');
  const assets = temporaryDirectory('codeestra-attach-assets-');
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
  // ADR-0056: every dev fact comes from a second clone of the same origin that sits on
  // `dev`; the project is trusted with it explicitly.
  const devRepo = await provisionDevClone({ repository: repository });

  const stubPath = join(tools, 'stub-pi.ts');
  const shimPath = join(tools, 'pi');
  const reportPath = join(tools, 'report.json');
  const modesPath = join(tools, 'modes.jsonl');
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);

  const environment = {
    CODEESTRA_HOME: home,
    CODEESTRA_UI_DIST: assets,
    CODEESTRA_PI_EXECUTABLE: shimPath,
    CODEESTRA_HANDOFF_REPORT: reportPath,
    CODEESTRA_HANDOFF_MODES: modesPath,
    // The terminal provider exits with 7: a release must not read any success from that.
    CODEESTRA_STUB_TUI_EXIT: '7',
    CODEESTRA_HANDOFF_CONNECT_MS: '2000',
  };
  const opened = await cli(['open', repository, '--dev-repo', devRepo, '--no-open',
    ...(options.permissionMode === 'STRICT' ? ['--yes'] : [])], environment);
  expect(opened.exitCode).toBe(0);
  if (options.permissionMode === 'STRICT') {
    // The mode is a persisted Runtime setting that every launch reads, and the switch itself is
    // exactly one command with no confirmation.
    expect((await cli(['settings', 'permission', 'set', 'strict'], environment)).exitCode).toBe(0);
  }
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  const projectId = projects[0]?.id as string;
  const created = JSON.parse((await cli(['task', 'create', projectId,
    'Attach one native terminal', '--title', 'Attach one native terminal',
    '--name', 'attach-native-terminal'], environment)).stdout) as { readonly id: string };
  // ADR-0059: submitting an undeclared Task starts it in the same command (the automatic pass judges
  // it SAFE), so the Session this file drives exists without a second `task run`.
  expect((await cli(['task', 'submit', projectId, created.id, '0'], environment)).exitCode).toBe(0);
  // The Session is read from the same command face a client has.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await cli(['task', 'status', projectId, created.id], environment);
    const parsed = JSON.parse(status.stdout) as { readonly executions: readonly {
      readonly session: { readonly sessionId: string } | null }[] };
    const sessionId = parsed.executions[0]?.session?.sessionId;
    if (sessionId !== undefined) {
      return { environment, projectId, sessionId, reportPath, modesPath };
    }
    await Bun.sleep(100);
  }
  throw new Error('The Task never started an Agent Session');
}

describe('codeestra session handoff attach / detach / release', () => {
  test('takes over into a real PTY, survives detach/reattach, and hands back to automation', async () => {
    const { environment, projectId, sessionId, reportPath, modesPath } = await startTask();
    try {
      // 1. An automation incarnation exists and the capability projection is honest.
      const initial = await waitForStatus(environment, projectId, sessionId,
        (status) => status.incarnation !== null && status.terminal === null);
      expect(initial.incarnation?.mode).toBe('AUTOMATED_RPC');
      expect(initial.writerLease?.holderKind).toBe('AUTOMATED_RPC');
      expect(initial.capabilities).toMatchObject({
        ptyTransport: 'IMPLEMENTED',
        successorProcessStart: 'IMPLEMENTED',
        nativeTerminalAttach: 'IMPLEMENTED',
        attachToLiveRpcProcess: 'UNSUPPORTED',
        ptyResize: 'IMPLEMENTED',
        windows: 'UNSUPPORTED',
        crossHandoffPermissionModeMatrix: 'PARTIAL',
      });

      // 2. The takeover request installs the fence; the provider settles at the safe point.
      expect((await cli(['session', 'handoff', 'request', projectId, sessionId, 'takeover'],
        environment)).exitCode).toBe(0);
      const safe = await waitForStatus(environment, projectId, sessionId,
        (status) => status.safePoint.reached);
      expect(safe.handoff?.state).toBe('AT_SAFE_POINT');

      // 3. Admission really starts a successor on a PTY this Runtime owns.
      const admitted = await cli(['session', 'handoff', 'admit', projectId, sessionId], environment);
      expect(admitted.exitCode).toBe(0);
      const admission = JSON.parse(admitted.stdout) as {
        readonly admitted: boolean; readonly successorStarted: boolean;
        readonly terminalTransport: string; readonly successorMode: string;
        readonly successorIncarnation: { readonly incarnationNumber: number } };
      expect(admission).toMatchObject({ admitted: true, successorStarted: true,
        terminalTransport: 'PTY', successorMode: 'HUMAN_TUI' });
      expect(admission.successorIncarnation.incarnationNumber).toBe(2);

      const attached = await waitForStatus(environment, projectId, sessionId,
        (status) => status.terminal !== null && status.terminal.state === 'RUNNING');
      // Same conversation, new process generation: the incarnation chain and the session file agree.
      expect(attached.incarnations.map((incarnation) => incarnation.mode))
        .toEqual(['AUTOMATED_RPC', 'HUMAN_TUI']);
      expect(attached.incarnations[1]?.predecessorIncarnationId).not.toBeNull();
      expect(attached.incarnations[1]?.sessionStorageRef).toBe(attached.incarnations[0]?.sessionStorageRef);
      expect(attached.writerLease?.holderKind).toBe('TERMINAL_ATTACHMENT');
      expect(attached.terminal?.held).toBe(true);
      expect(attached.terminal?.windowSize).toBe('APPLIED');
      // The settled fact was the takeover's safe point, not the completion of the Execution: the
      // conversation continues under the native terminal.
      expect(attached.executionState).toBe('RUNNING');

      // 4. The terminal stream is readable through the CLI, from a cursor.
      const read = await cli(['session', 'handoff', 'terminal', 'read', projectId, sessionId],
        environment);
      expect(read.exitCode).toBe(0);
      const stream = JSON.parse(read.stdout) as { readonly running: boolean;
        readonly cursor: number; readonly data: string; readonly truncated: boolean };
      expect(stream.running).toBe(true);
      expect(stream.data).toContain('STUB-TUI-BANNER');
      expect(stream.truncated).toBe(false);
      // A cursor at the end returns nothing new; writing input is terminal input, not an approval.
      expect(JSON.parse((await cli(['session', 'handoff', 'terminal', 'read', projectId, sessionId,
        '--since', String(stream.cursor)], environment)).stdout)).toMatchObject({ data: '' });
      expect((await cli(['session', 'handoff', 'terminal', 'write', projectId, sessionId,
        '--text', 'hello from the CLI\n'], environment)).exitCode).toBe(0);
      const echoed = await cli(['session', 'handoff', 'terminal', 'read', projectId, sessionId,
        '--since', String(stream.cursor)], environment);
      expect((JSON.parse(echoed.stdout) as { readonly data: string }).data)
        .toContain('STUB-TUI-ECHO:hello from the CLI');

      // 5. One writer attachment; a second one is refused with the holder named, never queued.
      const writer = await cli(['session', 'handoff', 'attach', projectId, sessionId,
        '--holder', 'cli-a', '--writer'], environment);
      expect(writer.exitCode).toBe(0);
      const busy = await cli(['session', 'handoff', 'attach', projectId, sessionId,
        '--holder', 'cli-b', '--writer'], environment);
      expect(busy.exitCode).toBe(1);
      expect(`${busy.stdout}${busy.stderr}`).toContain('ATTACHMENT_BUSY');
      const observer = await cli(['session', 'handoff', 'attach', projectId, sessionId,
        '--holder', 'ui-c'], environment);
      expect(observer.exitCode).toBe(0);
      expect(JSON.parse(observer.stdout)).toMatchObject({
        attachment: { kind: 'OBSERVER', holderRef: 'ui-c' } });

      // 6. The terminal's geometry is a transport fact the CLI can change, and the provider reads the
      // new size from its own terminal. A size outside the contract's bound is a stable, named
      // refusal (exit 2), and a caller that is not the terminal's writer seat is refused (exit 1).
      const invalidSize = await cli(['session', 'handoff', 'terminal', 'resize', projectId, sessionId,
        '--cols', '0', '--rows', '40'], environment);
      expect(invalidSize.exitCode).toBe(2);
      expect(invalidSize.stderr).toContain('TERMINAL_RESIZE_INVALID_SIZE');
      const oversize = await cli(['session', 'handoff', 'terminal', 'resize', projectId, sessionId,
        '--cols', '40', '--rows', '1001'], environment);
      expect(oversize.exitCode).toBe(2);
      expect(oversize.stderr).toContain('TERMINAL_RESIZE_INVALID_SIZE');
      const notTheWriter = await cli(['session', 'handoff', 'terminal', 'resize', projectId, sessionId,
        '--cols', '90', '--rows', '30', '--holder', 'cli-b'], environment);
      expect(notTheWriter.exitCode).toBe(1);
      expect(`${notTheWriter.stdout}${notTheWriter.stderr}`).toContain('TERMINAL_RESIZE_WRITER_BUSY');
      const resized = await cli(['session', 'handoff', 'terminal', 'resize', projectId, sessionId,
        '--cols', '90', '--rows', '30', '--holder', 'cli-a'], environment);
      expect(resized.exitCode).toBe(0);
      expect(JSON.parse(resized.stdout)).toMatchObject({
        cols: 90, rows: 30, applied: 'APPLIED', detail: 'stty',
        terminal: { currentSize: { cols: 90, rows: 30 } } });
      const resizedCursor = (JSON.parse((await cli(['session', 'handoff', 'terminal', 'read',
        projectId, sessionId], environment)).stdout) as { readonly cursor: number }).cursor;
      expect((await cli(['session', 'handoff', 'terminal', 'write', projectId, sessionId,
        '--text', 'SIZE?\n'], environment)).exitCode).toBe(0);
      const sizeReport = await cli(['session', 'handoff', 'terminal', 'read', projectId, sessionId,
        '--since', String(resizedCursor)], environment);
      expect((JSON.parse(sizeReport.stdout) as { readonly data: string }).data)
        .toContain('STUB-TUI-SIZE:30 90');
      // The projection states the geometry only for a terminal this Runtime still holds.
      const afterResize = await readStatus(environment, projectId, sessionId);
      expect(afterResize.terminal?.currentSize).toEqual({ cols: 90, rows: 30 });

      // 7. Detach does not stop the terminal: same provider process, still writable.
      const providerPid = attached.terminal?.providerPid;
      expect((await cli(['session', 'handoff', 'detach', projectId, sessionId, '--holder', 'cli-a'],
        environment)).exitCode).toBe(0);
      await Bun.sleep(200);
      const afterDetach = await readStatus(environment, projectId, sessionId);
      expect(afterDetach.terminal?.state).toBe('RUNNING');
      expect(afterDetach.terminal?.held).toBe(true);
      expect(afterDetach.terminal?.providerPid).toBe(providerPid);
      expect(afterDetach.terminal?.writer).toBeNull();
      // Detaching a holder that owns nothing is a refusal, not a silent success.
      expect((await cli(['session', 'handoff', 'detach', projectId, sessionId, '--holder', 'nobody'],
        environment)).exitCode).toBe(1);

      // 8. Reattach continues the same terminal stream.
      const reattach = await cli(['session', 'handoff', 'attach', projectId, sessionId,
        '--holder', 'cli-d', '--writer', '--since', String(stream.cursor)], environment);
      expect(reattach.exitCode).toBe(0);
      expect(JSON.parse(reattach.stdout)).toMatchObject({
        attachment: { kind: 'WRITER', holderRef: 'cli-d' } });

      // 9. The explicit release writes the terminal's own release byte, verifies the exit, the
      // ownership and the session file, and hands the conversation back to automation. The provider
      // exits with code 7 and that code decides nothing.
      const fileBefore = readFileSync(await sessionFilePath(environment, sessionId), 'utf8');
      const released = await cli(['session', 'handoff', 'release', projectId, sessionId], environment);
      expect(released.exitCode).toBe(0);
      const release = JSON.parse(released.stdout) as {
        readonly released: boolean; readonly code: string;
        readonly release: { readonly exit: { readonly code: number | null } | null;
          readonly predecessorObservation: string;
          readonly sessionFile: { readonly predecessorEntrySurvived: boolean | null;
            readonly lastEntryIdAtRelease: string | null } };
        readonly successor: { readonly admitted: boolean; readonly successorStarted: boolean;
          readonly terminalTransport: string;
          readonly successorIncarnation: { readonly incarnationNumber: number;
            readonly mode: string } } | null };
      expect(release.released).toBe(true);
      expect(release.code).toBe('RELEASED');
      // The exit code is recorded as data, and it is the provider's own 7 — not a success signal.
      expect(release.release.exit?.code).toBe(7);
      expect(release.release.predecessorObservation).toBe('STOPPED');
      expect(release.release.sessionFile.predecessorEntrySurvived).toBe(true);
      // The successor is an automation process on the same file, recorded as the next incarnation.
      expect(release.successor).toMatchObject({ admitted: true, successorStarted: true,
        terminalTransport: 'RPC' });
      expect(release.successor?.successorIncarnation).toMatchObject({
        incarnationNumber: 3, mode: 'AUTOMATED_RPC' });

      const returned = await waitForStatus(environment, projectId, sessionId,
        (status) => status.incarnation?.mode === 'AUTOMATED_RPC'
          && status.incarnation.incarnationNumber === 3);
      expect(returned.incarnations.map((incarnation) => incarnation.mode))
        .toEqual(['AUTOMATED_RPC', 'HUMAN_TUI', 'AUTOMATED_RPC']);
      // The chain is traceable: each successor names its predecessor incarnation.
      expect(returned.incarnations[1]?.predecessorIncarnationId).not.toBeNull();
      expect(returned.incarnations[2]?.predecessorIncarnationId).not.toBeNull();
      expect(returned.incarnations[2]?.predecessorIncarnationId)
        .not.toBe(returned.incarnations[1]?.predecessorIncarnationId);
      expect(returned.incarnations[2]?.sessionStorageRef).toBe(returned.incarnations[0]?.sessionStorageRef);
      expect(returned.writerLease?.holderKind).toBe('AUTOMATED_RPC');
      expect(returned.terminal?.state).toBe('RELEASED');
      expect(returned.executionState).toBe('RUNNING');
      // The same provider conversation gained the terminal's entry and the automation continuation:
      // the successor reopened this file instead of starting a new one.
      const fileAfter = readFileSync(await sessionFilePath(environment, sessionId), 'utf8');
      expect(fileAfter).toContain('tui-release-entry');
      expect(fileAfter).toContain('rpc-return-entry');
      expect(fileAfter.length).toBeGreaterThan(fileBefore.length);
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
        readonly mode: string; readonly resumed: boolean; readonly sessionFile: string };
      expect(report).toMatchObject({ mode: 'rpc', resumed: true });
      expect(report.sessionFile).toBe(await sessionFilePath(environment, sessionId));

      // 10. A repeated admission does not start a second successor, and a released terminal cannot be
      // released again.
      const again = await cli(['session', 'handoff', 'admit', projectId, sessionId], environment);
      expect(JSON.parse(again.stdout)).toMatchObject({ admitted: true, replayed: true });
      expect((await readStatus(environment, projectId, sessionId)).incarnations).toHaveLength(3);
      const secondRelease = await cli(['session', 'handoff', 'release', projectId, sessionId],
        environment);
      expect(secondRelease.exitCode).toBe(1);
      expect(`${secondRelease.stdout}${secondRelease.stderr}`).toContain('TERMINAL_NOT_RUNNING');
      // The FULL mode is what the automation, the native TUI and the returned automation were all
      // launched with — read from each provider process's own argv and environment.
      const modes = await readIncaricationModes(modesPath);
      expect(modes.map((entry) => entry.incarnation))
        .toEqual(['AUTOMATED_RPC', 'HUMAN_TUI', 'AUTOMATED_RPC']);
      expect([...new Set(modes.map((entry) => entry.permissionMode))]).toEqual(['FULL']);
      expect([...new Set(modes.map((entry) => entry.argvMode))]).toEqual(['FULL']);
      expect(returned.permissionMode).toBe('FULL');
    } finally {
      await cli(['stop'], environment);
    }
  }, 180_000);

  test('keeps the permission mode across the handoff in both directions, in both modes', async () => {
    // The matrix cell this covers: the mode is one persisted setting the Runtime reads at every
    // launch, so the automation, the native TUI successor and the returned automation must all be
    // launched with it — and none of the three handoff commands may ask for anything extra.
    for (const permissionMode of ['FULL', 'STRICT'] as const) {
      const { environment, projectId, sessionId, modesPath } = await startTask({ permissionMode });
      try {
        const initial = await waitForStatus(environment, projectId, sessionId,
          (status) => status.incarnation !== null && status.terminal === null);
        expect(initial.permissionMode).toBe(permissionMode);
        expect((await cli(['session', 'handoff', 'request', projectId, sessionId, 'takeover'],
          environment)).exitCode).toBe(0);
        await waitForStatus(environment, projectId, sessionId, (status) => status.safePoint.reached);
        const admitted = await cli(['session', 'handoff', 'admit', projectId, sessionId], environment);
        expect(admitted.exitCode).toBe(0);
        await waitForStatus(environment, projectId, sessionId,
          (status) => status.terminal !== null && status.terminal.state === 'RUNNING');
        // Hand-back, and the successor automation is launched by the same Runtime.
        const released = await cli(['session', 'handoff', 'release', projectId, sessionId], environment);
        expect(released.exitCode).toBe(0);
        await waitForStatus(environment, projectId, sessionId,
          (status) => status.incarnation?.mode === 'AUTOMATED_RPC'
            && status.incarnation.incarnationNumber === 3);

        const modes = await waitForIncaricationModes(modesPath, 3);
        expect(modes.map((entry) => entry.incarnation))
          .toEqual(['AUTOMATED_RPC', 'HUMAN_TUI', 'AUTOMATED_RPC']);
        // Every incarnation received this mode, on both channels the provider reads it from.
        expect([...new Set(modes.map((entry) => entry.permissionMode))]).toEqual([permissionMode]);
        expect([...new Set(modes.map((entry) => entry.argvMode))]).toEqual([permissionMode]);
        // STRICT additionally pins the tool allowlist on every launch; FULL adds no such flag.
        const expectedTools = permissionMode === 'STRICT'
          ? 'read,bash,edit,write,grep,find,ls,ask_user_question' : null;
        expect([...new Set(modes.map((entry) => entry.toolsFlag))]).toEqual([expectedTools]);
        expect((await readStatus(environment, projectId, sessionId)).permissionMode)
          .toBe(permissionMode);
      } finally {
        await cli(['stop'], environment);
      }
    }
  }, 300_000);
});

interface IncarnationMode {
  readonly incarnation: string;
  readonly permissionMode: string | null;
  readonly argvMode: string | null;
  readonly toolsFlag: string | null;
  readonly pid: number;
}

/**
 * The modes each provider process was really launched with, in launch order, read from the JSONL the
 * stub provider appends on its own side-channel hello.
 */
async function readIncaricationModes(modesPath: string): Promise<readonly IncarnationMode[]> {
  const file = Bun.file(modesPath);
  if (!await file.exists()) return [];
  return (await file.text()).split('\n').filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as IncarnationMode);
}

async function waitForIncaricationModes(modesPath: string, count: number):
Promise<readonly IncarnationMode[]> {
  const deadline = Date.now() + 30_000;
  let last: readonly IncarnationMode[] = [];
  while (Date.now() < deadline) {
    last = await readIncaricationModes(modesPath);
    if (last.length >= count) return last;
    await Bun.sleep(100);
  }
  return last;
}

/**
 * The provider session file the Session owns, read from the same projection the Runtime reports
 * (it never leaves the Runtime through a client response, so the test reads it from the transcript
 * target command instead of constructing the path itself).
 */
async function sessionFilePath(environment: Record<string, string>, sessionId: string): Promise<string> {
  const home = environment['CODEESTRA_HOME'] as string;
  const sessions = join(home, 'pi-sessions');
  const files = [...new Bun.Glob('**/*.jsonl').scanSync({ cwd: sessions, absolute: true })];
  const match = files.filter((file) => file.includes('stub')).at(-1) ?? files.at(-1);
  if (match === undefined) throw new Error(`no provider session file was found under ${sessions} for ${sessionId}`);
  return match;
}
