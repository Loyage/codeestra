import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerRuntimeHome,
  registerRuntimeProcess,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';
import {
  acquireRuntimeOwnership,
  inspectRuntimeHome,
  pidExists,
  readProcessState,
  releaseRuntimeOwnership,
  runtimeBootRecordPath,
} from '../src/lifecycle.js';

/** `Bun.write` works for fixtures, but these writes must be atomic before the file is read back. */
async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');
const runtimeEntry = join(repositoryRoot, 'apps', 'runtime', 'src', 'main.ts');
const lifecycleEntry = join(repositoryRoot, 'apps', 'runtime', 'src', 'lifecycle.ts');

/**
 * FOUNDATION-057: teardown reclaims through the shared helper. It stops every Runtime this file
 * started — including one the CLI started, which is not a tracked child — by the identity recorded
 * in this file's own temporary home, with SIGTERM and a wait. A home whose process refuses to exit
 * is kept and reported, never SIGKILLed by a name or a pattern.
 */
afterEach(async () => { await reclaimTestResources(); });

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

/** A home that does not exist yet, so "nothing was started" can be asserted about it. */
function unstartedHome(prefix: string): string {
  const home = join(realpathSync(temporaryDirectory(prefix)), 'home');
  registerRuntimeHome(home);
  return home;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  // FOUNDATION-057: the shared runner refuses a non-temporary CODEESTRA_HOME and registers the home
  // so teardown stops any Runtime the CLI started, including on the failure path.
  return await runCli(args, environment, { entry: cliEntry });
}

interface LockView {
  readonly pid: number;
  readonly bootId: string;
  readonly startToken: string | null;
}

interface StopReport {
  readonly status: string;
  readonly pid: number | null;
  readonly bootId: string | null;
  readonly waitedMs: number;
  readonly identityVerified?: boolean;
  readonly identityChanged?: boolean;
  readonly ownership: {
    readonly verdict: string;
    readonly socketPresent: boolean;
    readonly endpointAnswers: boolean;
    readonly lock: { readonly present: boolean; readonly record: LockView | null };
    readonly traces: readonly { readonly pid: number; readonly verdict: string }[];
  };
}

interface StatusReport {
  readonly pid?: number;
  readonly bootId?: string;
  readonly startedAt?: number;
  readonly status: string;
  readonly ownership: {
    readonly verdict: string;
    readonly lock: { readonly record: LockView | null };
    readonly traces: readonly { readonly pid: number; readonly verdict: string }[];
  };
}

/** Starts a Runtime directly, so the spawned PID is the Runtime process itself. */
function spawnRuntimeProcess(environment: Record<string, string>) {
  return Bun.spawn({
    cmd: [process.execPath, runtimeEntry],
    cwd: repositoryRoot,
    env: { ...Bun.env, ...environment, no_proxy: '127.0.0.1,localhost' },
    stdin: 'ignore' as const,
    stdout: 'ignore' as const,
    stderr: 'pipe' as const,
  });
}

function startRuntime(environment: Record<string, string>) {
  const child = spawnRuntimeProcess(environment);
  registerRuntimeProcess(child.pid, environment['CODEESTRA_HOME'] as string);
  return child;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for: ${message}`);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Lifecycle Test',
      GIT_AUTHOR_EMAIL: 'lifecycle@example.invalid', GIT_COMMITTER_NAME: 'Lifecycle Test',
      GIT_COMMITTER_EMAIL: 'lifecycle@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

/** PIDs of processes whose command line names `marker`; another lane's processes never match. */
async function processesMatching(marker: string): Promise<readonly number[]> {
  const table = await Bun.$`ps -eo pid,ppid,command`.text();
  return table.split('\n')
    .filter((row) => row.includes(marker) && !row.includes('ps -eo'))
    .map((row) => Number(row.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

describe('Runtime lifecycle: stop is a fact, not a signal', () => {
  test('stop really exits the Runtime and says so (FOUNDATION-042 regression)', async () => {
    const home = unstartedHome('codeestra-lifecycle-stop-');
    const environment = { CODEESTRA_HOME: home };

    const started = await cli(['status'], environment);
    expect(started.exitCode).toBe(0);
    const ping = JSON.parse(started.stdout) as StatusReport;
    const pid = ping.pid as number;
    expect(ping.status).toBe('READY');
    expect(ping.ownership.verdict).toBe('RUNNING');

    const beganAt = Date.now();
    const stopped = await cli(['stop'], environment);
    const wallMs = Date.now() - beganAt;
    expect(stopped.exitCode).toBe(0);
    const report = JSON.parse(stopped.stdout) as StopReport;
    expect(report.status).toBe('STOPPED');
    expect(report.pid).toBe(pid);
    if (ping.ownership.lock.record?.startToken !== null
      && ping.ownership.lock.record !== null) {
      expect(report.identityVerified).toBe(true);
    }
    // The process the Runtime named is gone by the time `stop` has returned: that is the defect —
    // it used to answer "stopping" and stay alive for the whole shutdown grace.
    await waitFor(() => !pidExists(pid), 'the stopped Runtime process to be gone', 2_000);
    expect(await readProcessState(pid)).not.toBe('RUNNING');
    // The grace timers that used to hold the event loop open are cleared, so this is not a 5s stop.
    expect(wallMs).toBeLessThan(4_000);
    expect(report.ownership.endpointAnswers).toBe(false);
    expect(report.ownership.verdict).toBe('NOT_RUNNING');
    // A clean shutdown releases its own lock and boot record: nothing is left to explain.
    expect(report.ownership.lock.present).toBe(false);
    expect(readdirSync(join(home, 'runtime-boots'))).toEqual([]);
  }, 60_000);

  test('a deadline that never fires cannot hold a process open', async () => {
    const root = realpathSync(temporaryDirectory('codeestra-lifecycle-deadline-'));
    const graceMs = 3_000;
    const rawScript = join(root, 'raw.ts');
    const guardedScript = join(root, 'guarded.ts');
    await Bun.write(rawScript, `
const beganAt = Date.now();
await Promise.race([Promise.resolve('work'), Bun.sleep(${graceMs})]);
console.log('raw', Date.now() - beganAt);
`);
    await Bun.write(guardedScript, `
import { withDeadline } from ${JSON.stringify(lifecycleEntry)};
const beganAt = Date.now();
const outcome = await withDeadline(Promise.resolve('work'), ${graceMs});
if (!outcome.settled || outcome.value !== 'work') throw new Error('expected the work to win');
console.log('guarded', Date.now() - beganAt);
`);

    // Control: a pending `Bun.sleep` in a race keeps the process alive for the whole grace period.
    const rawStartedAt = Date.now();
    const raw = Bun.spawn({ cmd: [process.execPath, rawScript], stdout: 'pipe', stderr: 'pipe' });
    const [rawExit, rawStdout] = await Promise.all([
      raw.exited, new Response(raw.stdout).text(),
    ]);
    const rawElapsed = Date.now() - rawStartedAt;
    expect(rawExit).toBe(0);
    // The invariant is that the script did not wait for the pending timer, not that its own clock
    // read exactly 0ms: a loaded machine can bill a millisecond between two `Date.now()` calls, and
    // asserting the literal 0 turned that scheduling jitter into a false red.
    expect(rawStdout.trim()).toStartWith('raw');
    const rawElapsedInsideScript = Number(/raw (\d+)/.exec(rawStdout)?.[1] ?? Number.NaN);
    expect(rawElapsedInsideScript).toBeLessThan(1_000);
    expect(rawElapsed).toBeGreaterThanOrEqual(graceMs - 300);

    // The fix: `withDeadline` clears its timer, so the same work exits at once instead of at 3s.
    const guardedStartedAt = Date.now();
    const guarded = Bun.spawn({ cmd: [process.execPath, guardedScript], stdout: 'pipe',
      stderr: 'pipe' });
    const [guardedExit, guardedStdout] = await Promise.all([
      guarded.exited, new Response(guarded.stdout).text(),
    ]);
    expect(guardedExit).toBe(0);
    const guardedElapsed = Number(/guarded (\d+)/.exec(guardedStdout)?.[1] ?? Number.NaN);
    expect(guardedStdout.trim()).toStartWith('guarded');
    expect(guardedElapsed).toBeLessThan(1_000);
    expect(Date.now() - guardedStartedAt).toBeLessThan(graceMs - 1_000);
  }, 30_000);

  test('stop is idempotent, and a home that was never started is not started by stop', async () => {
    const home = unstartedHome('codeestra-lifecycle-idempotent-');
    const environment = { CODEESTRA_HOME: home };

    // Nothing has ever run for this home: `stop` reports that and must not create a Runtime.
    const never = await cli(['stop'], environment);
    expect(never.exitCode).toBe(0);
    const neverReport = JSON.parse(never.stdout) as StopReport;
    expect(neverReport.status).toBe('NOT_RUNNING');
    expect(neverReport.pid).toBeNull();
    expect(existsSync(home)).toBe(false);

    expect((await cli(['status'], environment)).exitCode).toBe(0);
    const first = await cli(['stop'], environment);
    expect(first.exitCode).toBe(0);
    expect((JSON.parse(first.stdout) as StopReport).status).toBe('STOPPED');

    const second = await cli(['stop'], environment);
    expect(second.exitCode).toBe(0);
    const secondReport = JSON.parse(second.stdout) as StopReport;
    expect(secondReport.status).toBe('NOT_RUNNING');
    expect(secondReport.ownership.verdict).toBe('NOT_RUNNING');
    expect(secondReport.ownership.traces).toEqual([]);
  }, 60_000);

  test('concurrent starts produce exactly one Runtime, and it is the one stop reaches', async () => {
    const home = unstartedHome('codeestra-lifecycle-concurrent-');
    const environment = { CODEESTRA_HOME: home };
    // One clean run creates and migrates the database, so the race below is about ownership rather
    // than about two processes migrating one SQLite file at the same time.
    expect((await cli(['status'], environment)).exitCode).toBe(0);
    expect((await cli(['stop'], environment)).exitCode).toBe(0);

    const starters = [0, 1, 2, 3].map(() => startRuntime(environment));
    await waitFor(async () => (await inspectRuntimeHome({ home })).endpointAnswers,
      'exactly one Runtime to answer');

    const status = JSON.parse((await cli(['status'], environment)).stdout) as StatusReport;
    const survivorPid = status.pid as number;
    const survivors = starters.filter((child) => child.exitCode === null);
    expect(survivors.length).toBe(1);
    expect(survivors[0]?.pid).toBe(survivorPid);
    expect(status.ownership.verdict).toBe('RUNNING');
    expect(status.ownership.lock.record?.pid).toBe(survivorPid);
    expect(status.ownership.traces).toEqual([]);
    // A rejected starter reports that another Runtime owns this home instead of dying on
    // EADDRINUSE or on a half-applied migration.
    for (const child of starters) {
      if (child.pid === survivorPid) continue;
      await child.exited;
      const stderr = await new Response(child.stderr).text();
      expect(child.exitCode).toBe(3);
      expect(stderr).toContain('another Runtime owns this Runtime home');
      expect(stderr).not.toContain('already exists');
    }

    const stopped = await cli(['stop'], environment);
    expect(stopped.exitCode).toBe(0);
    expect((JSON.parse(stopped.stdout) as StopReport).status).toBe('STOPPED');
    await waitFor(() => starters.every((child) => child.exitCode !== null),
      'every starter to be gone');
  }, 90_000);

  test('an unreachable Runtime process is reported as a fact, never killed on a guess', async () => {
    const home = unstartedHome('codeestra-lifecycle-unreachable-');
    const environment = { CODEESTRA_HOME: home };
    expect((await cli(['status'], environment)).exitCode).toBe(0);
    const ping = JSON.parse((await cli(['status'], environment)).stdout) as StatusReport;
    const pid = ping.pid as number;

    // Exactly the signature FOUNDATION-042 recorded: the socket is gone while the process lives.
    rmSync(join(home, 'runtime.sock'), { force: true });
    const stopped = await cli(['stop'], environment);
    expect(stopped.exitCode).toBe(1);
    const report = JSON.parse(stopped.stdout) as StopReport;
    expect(report.status).toBe('UNREACHABLE_PROCESS');
    expect(report.pid).toBe(pid);
    expect(report.ownership.verdict).toBe('UNREACHABLE_PROCESS');
    expect(report.ownership.traces.map((trace) => trace.pid)).toContain(pid);
    expect(report.ownership.traces[0]?.verdict).toBe('RUNNING');
    // Read-only diagnosis: the process is untouched, so a human decides what to do with it.
    expect(pidExists(pid)).toBe(true);

    const status = await cli(['status'], environment);
    expect(status.exitCode).toBe(1);
    const unavailable = JSON.parse(status.stdout) as StatusReport & { readonly error: string };
    expect(unavailable.status).toBe('UNAVAILABLE');
    expect(unavailable.ownership.verdict).toBe('UNREACHABLE_PROCESS');

    // Cleanup of this test's own temp home: this is the process this test started.
    process.kill(pid, 'SIGTERM');
    await waitFor(async () => !(await inspectRuntimeHome({ home })).lock.holderAlive,
      'the unreachable Runtime to exit');
    const after = await cli(['stop'], environment);
    expect(after.exitCode).toBe(0);
    expect((JSON.parse(after.stdout) as StopReport).status).toBe('NOT_RUNNING');
  }, 90_000);

  test('a killed Runtime leaves a trace, and the next start takes the stale lock over', async () => {
    const home = unstartedHome('codeestra-lifecycle-stale-');
    const environment = { CODEESTRA_HOME: home };
    const crashing = startRuntime(environment);
    await waitFor(async () => (await inspectRuntimeHome({ home })).endpointAnswers,
      'the first Runtime to answer');
    const crashedPid = crashing.pid;
    crashing.kill('SIGKILL');
    await crashing.exited;
    await waitFor(() => !pidExists(crashedPid), 'the killed Runtime to be gone');

    // Nothing is running, but the boot that never shut down cleanly is still evidence.
    const stopped = await cli(['stop'], environment);
    expect(stopped.exitCode).toBe(0);
    const report = JSON.parse(stopped.stdout) as StopReport;
    expect(report.status).toBe('NOT_RUNNING');
    expect(report.ownership.lock.present).toBe(true);
    expect(report.ownership.traces.map((trace) => trace.verdict))
      .toEqual(['EXITED_WITHOUT_CLEAN_SHUTDOWN']);

    // A start takes the stale lock over and reports the trace instead of hiding it.
    const started = await cli(['status'], environment);
    expect(started.exitCode).toBe(0);
    const ping = JSON.parse(started.stdout) as StatusReport;
    expect(ping.ownership.verdict).toBe('RUNNING');
    expect(ping.ownership.lock.record?.pid).toBe(ping.pid as number);
    expect(ping.ownership.traces.map((trace) => trace.pid)).toEqual([crashedPid]);

    const final = await cli(['stop'], environment);
    expect(final.exitCode).toBe(0);
    const finalReport = JSON.parse(final.stdout) as StopReport;
    expect(finalReport.status).toBe('STOPPED');
    expect(finalReport.ownership.lock.present).toBe(false);
    // The unclean boot's record is preserved: history is never rewritten to hide a failure.
    const records = readdirSync(join(home, 'runtime-boots'));
    expect(records).toHaveLength(1);
    const preserved = JSON.parse(readFileSync(join(home, 'runtime-boots', records[0] as string),
      'utf8')) as { readonly pid: number };
    expect(preserved.pid).toBe(crashedPid);
  }, 90_000);
});

describe('Runtime lifecycle: ownership records are the only thing a client trusts', () => {
  const fixedToken = async (): Promise<string> => 'test-start-token';

  test('one home has exactly one owner, and a stale lock is taken over', async () => {
    const home = unstartedHome('codeestra-lifecycle-ownership-');
    const first = await acquireRuntimeOwnership({ home, pid: process.pid, bootId: 'boot-1',
      startedAt: 1, argv: ['runtime'], cwd: home, readStartToken: fixedToken });
    expect(first.acquired).toBe(true);

    // A second claim from a *live* owner is refused: this is what makes two Runtimes impossible.
    const second = await acquireRuntimeOwnership({ home, pid: process.pid, bootId: 'boot-2',
      startedAt: 2, argv: ['runtime'], cwd: home, readStartToken: fixedToken });
    if (second.acquired) throw new Error('a live owner must not be replaced by a second claim');
    expect(second.ownerAlive).toBe(true);
    expect(second.owner?.bootId).toBe('boot-1');

    // Releasing is boot-scoped: another boot's lock is evidence, not ours to delete.
    await writeFile(join(home, 'runtime.lock'), `${JSON.stringify({ bootId: 'boot-other',
      pid: process.pid, startedAt: 3, startToken: 'test-start-token', argv: [], cwd: home })}\n`);
    expect(releaseRuntimeOwnership({ home, bootId: 'boot-2' })).toEqual({
      lockReleased: false, bootRecordRemoved: false });
    expect(existsSync(join(home, 'runtime.lock'))).toBe(true);

    // A lock whose owner is gone is stale: the next starter takes the home over.
    await writeFile(join(home, 'runtime.lock'), `${JSON.stringify({ bootId: 'boot-dead',
      pid: 2_147_483_647, startedAt: 4, startToken: 'gone', argv: [], cwd: home })}\n`);
    const third = await acquireRuntimeOwnership({ home, pid: process.pid, bootId: 'boot-3',
      startedAt: 5, argv: ['runtime'], cwd: home, readStartToken: fixedToken });
    expect(third.acquired).toBe(true);
    expect(releaseRuntimeOwnership({ home, bootId: 'boot-3' }).lockReleased).toBe(true);
    expect(existsSync(join(home, 'runtime.lock'))).toBe(false);
  });

  test('an unreadable lock is preserved as evidence instead of being deleted', async () => {
    const home = unstartedHome('codeestra-lifecycle-corrupt-');
    mkdirSync(home, { recursive: true });
    await writeFile(join(home, 'runtime.lock'), '{ this is not a lock record');
    const acquired = await acquireRuntimeOwnership({ home, pid: process.pid, bootId: 'boot-1',
      startedAt: 1, argv: ['runtime'], cwd: home, readStartToken: fixedToken });
    expect(acquired.acquired).toBe(true);
    expect(readFileSync(join(home, 'runtime.lock.corrupt'), 'utf8')).toBe('{ this is not a lock record');
    const inspection = await inspectRuntimeHome({ home, readStartToken: fixedToken });
    expect(inspection.unreadableRecords).toEqual([join(home, 'runtime.lock.corrupt')]);
  });

  test('inspection reports what is still there, never that a process it cannot see is stopped', async () => {
    const home = unstartedHome('codeestra-lifecycle-inspect-');
    mkdirSync(home, { recursive: true });
    const empty = await inspectRuntimeHome({ home, readStartToken: fixedToken });
    expect(empty.verdict).toBe('NOT_RUNNING');
    expect(empty.traces).toEqual([]);

    // A boot whose process is gone is reported as an unclean shutdown, not silently forgotten.
    await writeFile(runtimeBootRecordPath(home, 'boot-dead'), `${JSON.stringify({ bootId: 'boot-dead',
      pid: 2_147_483_647, startedAt: 1, startToken: 'gone', argv: [], cwd: home })}\n`);
    const crashed = await inspectRuntimeHome({ home, readStartToken: fixedToken });
    expect(crashed.verdict).toBe('STALE_LOCK');
    expect(crashed.traces.map((trace) => trace.verdict)).toEqual(['EXITED_WITHOUT_CLEAN_SHUTDOWN']);

    // The signature of the defect: a live process, a recorded boot, and nothing on the socket.
    await writeFile(join(home, 'runtime.lock'), `${JSON.stringify({ bootId: 'boot-live',
      pid: process.pid, startedAt: 2, startToken: 'test-start-token', argv: ['runtime'],
      cwd: home })}\n`);
    await writeFile(runtimeBootRecordPath(home, 'boot-live'), `${JSON.stringify({ bootId: 'boot-live',
      pid: process.pid, startedAt: 2, startToken: 'test-start-token', argv: ['runtime'],
      cwd: home })}\n`);
    const unreachable = await inspectRuntimeHome({ home, readStartToken: fixedToken });
    expect(unreachable.verdict).toBe('UNREACHABLE_PROCESS');
    expect(unreachable.endpointAnswers).toBe(false);
    expect(unreachable.lock.holderAlive).toBe(true);
    expect(unreachable.lock.holderIdentityMatches).toBe(true);
    expect(unreachable.traces.map((trace) => trace.pid)).toEqual([2_147_483_647, process.pid]);

    // A PID that now belongs to another process is not the boot that recorded it.
    const reused = await inspectRuntimeHome({ home, readStartToken: async () => 'another-token' });
    expect(reused.lock.holderIdentityMatches).toBe(false);
    expect(reused.traces.map((trace) => trace.verdict))
      .toEqual(['EXITED_WITHOUT_CLEAN_SHUTDOWN', 'PROCESS_ID_REUSED']);
  });
});

/**
 * The orphans this lane was opened for also included provider child processes. This drives the real
 * CLI/Runtime/Adapter path with a protocol stub provider, then stops the Runtime and checks that the
 * provider process it owned is gone too.
 */
const stubProviderSource = `
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
const sessionFile = join(sessionDir, 'lifecycle-session.jsonl');
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');

// A provider that stays alive after the turn and never answers another request: the Runtime has to
// release it, not wait for it to end on its own.
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
      emit({ id: record.id, type: 'response', command: 'get_state', success: true, data: {
        sessionId: 'lifecycle-session', sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      writeFileSync(join(process.cwd(), 'agent-output.txt'), 'work\\n');
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'lifecycle-session', timestamp: '2026-09-14T09:00:00.000Z',
        cwd: process.cwd() }) + '\\n');
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Wrote the file.' }], stopReason: 'stop' } });
      // Deliberately no agent_settled: this turn never ends by itself, so the provider process is
      // still held by the Runtime when the stop arrives.
    }
  }
}
`;

describe('Runtime lifecycle: a stopping Runtime owns provider processes', () => {
  test('stop ends the Runtime that holds a live provider, and the provider with it', async () => {
    const repository = temporaryDirectory('codeestra-lifecycle-provider-repo-');
    const home = unstartedHome('codeestra-lifecycle-provider-');
    const tools = realpathSync(temporaryDirectory('codeestra-lifecycle-provider-tools-'));
    const assets = temporaryDirectory('codeestra-lifecycle-provider-assets-');
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

    const stubPath = join(tools, 'stub-pi.ts');
    const shimPath = join(tools, 'pi');
    await Bun.write(stubPath, stubProviderSource);
    await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
    chmodSync(shimPath, 0o755);
    const environment = {
      CODEESTRA_HOME: home,
      CODEESTRA_UI_DIST: assets,
      CODEESTRA_PI_EXECUTABLE: shimPath,
    };

    expect((await cli(['open', repository, '--no-open'], environment)).exitCode).toBe(0);
    const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
      readonly { readonly id: string }[];
    const projectId = projects[0]?.id as string;
    const created = JSON.parse((await cli(['task', 'create', projectId, 'Write a file'],
      environment)).stdout) as { readonly id: string };
    // Submission starts this undeclared Task immediately under ADR-0059.
    expect((await cli(['task', 'submit', projectId, created.id, '0'], environment)).exitCode).toBe(0);

    const runtimePid = (JSON.parse((await cli(['status'], environment)).stdout) as StatusReport)
      .pid as number;
    // This stub never exits by itself, so it is still held when the stop arrives.
    let providerPids: readonly number[] = [];
    await waitFor(async () => {
      providerPids = await processesMatching(stubPath);
      return providerPids.length > 0;
    }, 'the stub provider process to be running');

    const stopped = await cli(['stop', '--wait', '15'], environment);
    expect(stopped.exitCode).toBe(0);
    const report = JSON.parse(stopped.stdout) as StopReport;
    expect(report.status).toBe('STOPPED');
    expect(report.pid).toBe(runtimePid);
    await waitFor(() => !pidExists(runtimePid), 'the stopped Runtime to be gone', 10_000);
    // Nothing this Runtime owned may be left behind by the stop it reported as complete.
    await waitFor(() => providerPids.every((pid) => !pidExists(pid)),
      'the provider process to be gone', 20_000);
  }, 150_000);
});
