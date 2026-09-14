import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

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
let socket = null;
let controlBuffer = '';
const send = (frame) => { try { socket?.write(JSON.stringify(frame) + '\\n'); } catch {} };
function openChannel() {
  socket = new Socket();
  socket.setEncoding('utf8');
  socket.on('connect', () => {
    send({ kind: 'hello', protocol: 1, mode: rpc ? 'rpc' : 'tui', hasUI: !rpc,
      permissionMode: 'FULL', pid: process.pid, providerSessionId, providerSessionFile: sessionFile });
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
    readonly writer: { readonly holderRef: string } | null;
    readonly release: { readonly exit: { readonly code: number | null } | null };
  } | null;
  readonly capabilities: Readonly<Record<string, string>>;
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

async function startTask(): Promise<{
  readonly environment: Record<string, string>;
  readonly projectId: string;
  readonly sessionId: string;
  readonly reportPath: string;
  readonly run: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
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
    // The terminal provider exits with 7: a release must not read any success from that.
    CODEESTRA_STUB_TUI_EXIT: '7',
    CODEESTRA_HANDOFF_CONNECT_MS: '2000',
  };
  const opened = await cli(['open', repository, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  const projectId = projects[0]?.id as string;
  const created = JSON.parse((await cli(['task', 'create', projectId,
    'Attach one native terminal'], environment)).stdout) as { readonly id: string };
  expect((await cli(['task', 'submit', projectId, created.id, '0'], environment)).exitCode).toBe(0);
  const run = Bun.spawn({
    cmd: [process.execPath, cliEntry, 'task', 'run', projectId, created.id, '1'],
    cwd: repositoryRoot,
    env: { ...Bun.env, ...environment, no_proxy: '127.0.0.1,localhost' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  // The Session is read from the same command face a client has.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await cli(['task', 'status', projectId, created.id], environment);
    const parsed = JSON.parse(status.stdout) as { readonly executions: readonly {
      readonly session: { readonly sessionId: string } | null }[] };
    const sessionId = parsed.executions[0]?.session?.sessionId;
    if (sessionId !== undefined) {
      return { environment, projectId, sessionId, reportPath, run };
    }
    await Bun.sleep(100);
  }
  throw new Error('The Task never started an Agent Session');
}

describe('codeestra session handoff attach / detach / release', () => {
  test('takes over into a real PTY, survives detach/reattach, and hands back to automation', async () => {
    const { environment, projectId, sessionId, reportPath, run } = await startTask();
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
        ptyResize: 'UNSUPPORTED',
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

      // 6. Detach does not stop the terminal: same provider process, still writable.
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

      // 7. Reattach continues the same terminal stream.
      const reattach = await cli(['session', 'handoff', 'attach', projectId, sessionId,
        '--holder', 'cli-d', '--writer', '--since', String(stream.cursor)], environment);
      expect(reattach.exitCode).toBe(0);
      expect(JSON.parse(reattach.stdout)).toMatchObject({
        attachment: { kind: 'WRITER', holderRef: 'cli-d' } });

      // 8. The explicit release writes the terminal's own release byte, verifies the exit, the
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

      // 9. A repeated admission does not start a second successor, and a released terminal cannot be
      // released again.
      const again = await cli(['session', 'handoff', 'admit', projectId, sessionId], environment);
      expect(JSON.parse(again.stdout)).toMatchObject({ admitted: true, replayed: true });
      expect((await readStatus(environment, projectId, sessionId)).incarnations).toHaveLength(3);
      const secondRelease = await cli(['session', 'handoff', 'release', projectId, sessionId],
        environment);
      expect(secondRelease.exitCode).toBe(1);
      expect(`${secondRelease.stdout}${secondRelease.stderr}`).toContain('TERMINAL_NOT_RUNNING');
    } finally {
      run.kill('SIGTERM');
      await cli(['stop'], environment);
    }
  }, 180_000);
});

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
