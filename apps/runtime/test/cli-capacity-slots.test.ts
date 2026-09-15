import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Phase1Database } from '@codeestra/storage';
import { pidExists } from '../src/lifecycle.js';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

/**
 * Capacity, reservations and the startup reconcile over the real command face (FOUNDATION-054).
 *
 * Every assertion is made through `bun run codeestra …` against a real Runtime in a temporary
 * `CODEESTRA_HOME`, with a temporary Git repository. The provider is a protocol stub, which proves
 * the Runtime's own编排 and nothing about a real Agent integration — that limitation is recorded in
 * the FOUNDATION-054 task record instead of being implied by a green test.
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

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Capacity Test',
      GIT_AUTHOR_EMAIL: 'capacity@example.invalid', GIT_COMMITTER_NAME: 'Capacity Test',
      GIT_COMMITTER_EMAIL: 'capacity@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

/** A protocol stub: it reports a session and settles immediately. Never a real Agent. */
const stubSource = `
const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
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
        sessionId: 'stub-session', sessionFile: null, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'stub' }], stopReason: 'stop' } });
      emit({ type: 'agent_settled' });
    }
  }
}
`;

interface Fixture {
  readonly environment: Record<string, string>;
  readonly repository: string;
  readonly home: string;
  readonly projectId: string;
}

async function fixture(): Promise<Fixture> {
  const repository = temporaryDirectory('codeestra-slot-repo-');
  const home = temporaryDirectory('codeestra-slot-home-');
  const tools = temporaryDirectory('codeestra-slot-tools-');
  const assets = temporaryDirectory('codeestra-slot-assets-');
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
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);

  const environment = {
    CODEESTRA_HOME: home,
    CODEESTRA_UI_DIST: assets,
    CODEESTRA_PI_EXECUTABLE: shimPath,
  };
  const opened = await cli(['open', repository, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  return { environment, repository, home, projectId: projects[0]?.id as string };
}

interface TaskRef {
  readonly id: string;
  readonly version: number;
  readonly revisionId: string;
  readonly displayNumber: number;
}

async function createReadyTask(
  environment: Record<string, string>,
  projectId: string,
  specification: string,
): Promise<TaskRef> {
  const created = await cli(['task', 'create', projectId, specification], environment);
  expect(created.exitCode).toBe(0);
  const taskId = (JSON.parse(created.stdout) as { readonly id: string }).id;
  const submitted = await cli(['task', 'submit', projectId, taskId, '0'], environment);
  expect(submitted.exitCode).toBe(0);
  return await taskRef(environment, projectId, taskId);
}

async function taskRef(
  environment: Record<string, string>,
  projectId: string,
  taskId: string,
): Promise<TaskRef> {
  const status = await cli(['task', 'status', projectId, taskId], environment);
  expect(status.exitCode).toBe(0);
  const payload = JSON.parse(status.stdout) as {
    readonly task: { readonly id: string; readonly version: number; readonly displayNumber: number;
      readonly currentRevision: { readonly id: string } };
  };
  return {
    id: payload.task.id,
    version: payload.task.version,
    revisionId: payload.task.currentRevision.id,
    displayNumber: payload.task.displayNumber,
  };
}

async function acquire(
  environment: Record<string, string>,
  projectId: string,
  task: TaskRef,
  adapterId?: string,
) {
  const result = await cli(['scheduler', 'reservations', 'acquire', projectId, task.id,
    String(task.version), '--revision', task.revisionId, '--json',
    ...(adapterId === undefined ? [] : ['--adapter', adapterId])], environment);
  // A refusal exits 1 with the reason on stderr and no JSON on stdout; a wait exits 3 with JSON.
  return { ...result, payload: result.stdout.trim().length === 0 ? null : JSON.parse(result.stdout) as {
    readonly outcome: string;
    readonly wait: { readonly code: string; readonly limit: number | null;
      readonly used: number | null; readonly blocking: readonly string[] } | null;
    readonly reservation: { readonly reservationId: string; readonly state: string;
      readonly holder: { readonly bootId: string; readonly pid: number;
        readonly startToken: string | null };
      readonly workspaceId: string | null; readonly assessedDevCommit: string | null } | null;
    readonly capacity: { readonly globalLimit: number; readonly globalUsed: number };
    readonly holderEvidence: readonly { readonly reservationId: string;
      readonly observation: string }[];
  } | null };
}

/** The parsed payload of an acquisition that succeeded, or a JSON payload at all. */
function payloadOf<T>(result: { readonly exitCode: number; readonly stderr: string;
  readonly payload: T | null }): T {
  expect(result.payload).not.toBeNull();
  return result.payload as T;
}

describe('codeestra scheduler capacity and reservations', () => {
  test('capacity is configurable, read back, and refuses invalid values instead of clamping', async () => {
    const { environment, projectId } = await fixture();
    const initial = await cli(['scheduler', 'capacity', 'get', projectId, '--json'], environment);
    expect(initial.exitCode).toBe(0);
    expect(JSON.parse(initial.stdout)).toMatchObject({
      globalLimit: 2, globalLimitSource: 'DEFAULT', globalUsed: 0, globalAvailable: 2,
      globalWaitReason: null, draining: false,
    });

    const set = await cli(['scheduler', 'capacity', 'set', projectId, '--limit', '3', '--json'],
      environment);
    expect(set.exitCode).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({
      changed: true, capacity: { globalLimit: 3, globalLimitSource: 'EXPLICIT' },
    });
    const readBack = await cli(['scheduler', 'capacity', 'get', projectId, '--json'], environment);
    expect(JSON.parse(readBack.stdout)).toMatchObject({ globalLimit: 3, globalAvailable: 3 });

    // A per-Adapter override is explicit, does not move the project limit, and is cleared back.
    const override = await cli(['scheduler', 'capacity', 'set', projectId, '--limit', '1',
      '--adapter', 'pi'], environment);
    expect(override.exitCode).toBe(0);
    const withOverride = JSON.parse((await cli(['scheduler', 'capacity', 'get', projectId, '--json'],
      environment)).stdout) as { readonly adapters: readonly { readonly adapterId: string;
        readonly limit: number; readonly limitSource: string }[] };
    expect(withOverride.adapters.find((adapter) => adapter.adapterId === 'pi'))
      .toMatchObject({ limit: 1, limitSource: 'EXPLICIT' });
    const cleared = await cli(['scheduler', 'capacity', 'clear', projectId, '--adapter', 'pi'],
      environment);
    expect(cleared.exitCode).toBe(0);
    const clearedView = JSON.parse(cleared.stdout) as { readonly capacity: { readonly adapters:
      readonly { readonly adapterId: string; readonly limit: number; readonly limitSource: string }[] } };
    expect(clearedView.capacity.adapters.find((adapter) => adapter.adapterId === 'pi'))
      .toMatchObject({ limit: 3, limitSource: 'DEFAULT' });

    // Invalid values are refused with their own stable code, and nothing is written.
    for (const [limit, code] of [['0', 'CAPACITY_LIMIT_INVALID'], ['-2', 'CAPACITY_LIMIT_INVALID'],
      ['99', 'CAPACITY_LIMIT_OUT_OF_RANGE']] as const) {
      const refused = await cli(['scheduler', 'capacity', 'set', projectId, '--limit', limit],
        environment);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain(code);
    }
    const unknownAdapter = await cli(['scheduler', 'capacity', 'set', projectId, '--limit', '1',
      '--adapter', 'claude-code'], environment);
    expect(unknownAdapter.exitCode).toBe(1);
    expect(unknownAdapter.stderr).toContain('UNKNOWN_ADAPTER');
    expect(JSON.parse((await cli(['scheduler', 'capacity', 'get', projectId, '--json'], environment))
      .stdout)).toMatchObject({ globalLimit: 3, globalUsed: 0 });
  });

  test('two Tasks reserve at capacity two, the third waits, and a retry is refused', async () => {
    const { environment, projectId } = await fixture();
    const first = await createReadyTask(environment, projectId, 'First independent work');
    const second = await createReadyTask(environment, projectId, 'Second independent work');
    const third = await createReadyTask(environment, projectId, 'Third independent work');

    const firstAcquire = await acquire(environment, projectId, first);
    expect(firstAcquire.exitCode).toBe(0);
    const firstPayload = payloadOf(firstAcquire);
    expect(firstPayload).toMatchObject({
      outcome: 'RESERVED', capacity: { globalLimit: 2, globalUsed: 1 },
    });
    // The reservation records who created it: the Runtime boot, its pid, and the OS start token.
    expect(firstPayload.reservation?.holder.bootId).toBeTruthy();
    expect(firstPayload.reservation?.holder.pid).toBeGreaterThan(0);
    expect(firstPayload.reservation?.holder.startToken).toBeTruthy();
    expect(firstPayload.reservation?.assessedDevCommit).toMatch(/^[0-9a-f]{40}$/);

    const secondAcquire = await acquire(environment, projectId, second);
    expect(secondAcquire.exitCode).toBe(0);
    expect(payloadOf(secondAcquire).capacity.globalUsed).toBe(2);

    // The third Task is *waiting on capacity*, with the slots that caused it and their holders.
    const thirdAcquire = await acquire(environment, projectId, third);
    expect(thirdAcquire.exitCode).toBe(3);
    const thirdPayload = payloadOf(thirdAcquire);
    expect(thirdPayload).toMatchObject({
      outcome: 'CAPACITY_WAIT',
      wait: { code: 'CAPACITY_GLOBAL_LIMIT_REACHED', limit: 2, used: 2 },
      reservation: null,
    });
    expect(thirdPayload.wait?.blocking).toHaveLength(2);
    expect(thirdPayload.holderEvidence).toHaveLength(2);
    expect(thirdPayload.holderEvidence[0]?.observation).toBe('HOLDER_STILL_RUNNING');
    expect(thirdAcquire.stderr).toContain('CAPACITY_GLOBAL_LIMIT_REACHED');

    // A second start request for the same Task is refused: only one reservation can exist.
    const duplicate = await acquire(environment, projectId, first);
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.payload).toBeNull();
    expect(duplicate.stderr).toContain('SLOT_ALREADY_RESERVED');
    const listed = await cli(['scheduler', 'reservations', 'list', projectId, '--json'], environment);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout).reservations).toHaveLength(2);

    // Release one slot explicitly: the freed slot is available again, and the release is audited.
    const reservationId = firstPayload.reservation?.reservationId as string;
    const released = await cli(['scheduler', 'reservations', 'release', projectId, reservationId,
      '--reason', 'agent finished the work', '--json'], environment);
    expect(released.exitCode).toBe(0);
    expect(JSON.parse(released.stdout)).toMatchObject({
      released: true, outcome: 'RELEASED',
      reservation: { state: 'RELEASED', releaseKind: 'EXPLICIT',
        releaseReason: 'agent finished the work' },
    });
    const afterRelease = await cli(['scheduler', 'reservations', 'list', projectId,
      '--include-released', '--json'], environment);
    expect(JSON.parse(afterRelease.stdout).reservations).toHaveLength(2);
    const releasedDetail = await cli(['scheduler', 'reservations', 'get', projectId, reservationId,
      '--json'], environment);
    expect(JSON.parse(releasedDetail.stdout).events.map(
      (event: { readonly kind: string }) => event.kind)).toEqual(['RESERVED', 'RELEASED']);
    expect((await acquire(environment, projectId, first)).exitCode).toBe(0);
    expect(JSON.parse((await cli(['scheduler', 'capacity', 'get', projectId, '--json'], environment))
      .stdout)).toMatchObject({ globalUsed: 2 });
    // Releasing again is an honest no-op, not a second state change.
    const releaseAgain = await cli(['scheduler', 'reservations', 'release', projectId, reservationId,
      '--reason', 'again', '--json'], environment);
    expect(releaseAgain.exitCode).toBe(0);
    expect(JSON.parse(releaseAgain.stdout)).toMatchObject({ released: false,
      outcome: 'ALREADY_RELEASED' });
  });

  test('two concurrent start requests never produce two reservations', async () => {
    const { environment, projectId } = await fixture();
    const first = await createReadyTask(environment, projectId, 'Concurrent A');
    const second = await createReadyTask(environment, projectId, 'Concurrent B');
    // Two different Tasks with two free slots must both get one even though the two CLI processes
    // run at the same time: the immediate transaction serializes them, and neither loses an update.
    const [left, right] = await Promise.all([
      acquire(environment, projectId, first),
      acquire(environment, projectId, second),
    ]);
    expect([left.exitCode, right.exitCode].sort()).toEqual([0, 0]);
    expect(JSON.parse((await cli(['scheduler', 'reservations', 'list', projectId, '--json'],
      environment)).stdout).reservations).toHaveLength(2);
    // Two concurrent requests for the *same* Task: exactly one reservation may exist.
    await cli(['scheduler', 'reservations', 'release', projectId,
      payloadOf(left).reservation?.reservationId as string, '--reason', 'free for the race'],
    environment);
    const race = await Promise.all([
      acquire(environment, projectId, first),
      acquire(environment, projectId, first),
    ]);
    expect(race.filter((attempt) => attempt.exitCode === 0)).toHaveLength(1);
    const refused = race.find((attempt) => attempt.exitCode !== 0);
    expect(refused?.exitCode).toBe(1);
    expect(refused?.stderr).toContain('SLOT_ALREADY_RESERVED');
    const active = await cli(['scheduler', 'reservations', 'list', projectId, '--task', first.id,
      '--json'], environment);
    expect(JSON.parse(active.stdout).reservations).toHaveLength(1);
  });

  test('a workspace is prepared for a reservation and bound to it', async () => {
    const { environment, projectId } = await fixture();
    const task = await createReadyTask(environment, projectId, 'Needs a worktree');
    const reserved = await acquire(environment, projectId, task);
    expect(reserved.exitCode).toBe(0);
    const reservationId = payloadOf(reserved).reservation?.reservationId as string;
    const prepared = await cli(['scheduler', 'reservations', 'prepare-workspace', projectId,
      reservationId, String(task.version), '--json'], environment);
    expect(prepared.exitCode).toBe(0);
    const workspace = JSON.parse(prepared.stdout).workspace as {
      readonly workspaceId: string; readonly path: string; readonly branchRef: string;
      readonly created: boolean };
    expect(workspace.created).toBe(true);
    expect(workspace.branchRef).toBe(`refs/heads/task/${task.id}`);
    expect(existsSync(workspace.path)).toBe(true);
    // The binding is visible on the reservation itself.
    const detail = JSON.parse((await cli(['scheduler', 'reservations', 'list', projectId, '--json'],
      environment)).stdout).reservations as readonly { readonly reservationId: string;
        readonly workspaceId: string | null }[];
    expect(detail.find((entry) => entry.reservationId === reservationId)?.workspaceId)
      .toBe(workspace.workspaceId);
    // Running it again reports the same binding instead of preparing a second worktree.
    const replay = await cli(['scheduler', 'reservations', 'prepare-workspace', projectId,
      reservationId, String(task.version), '--json'], environment);
    expect(JSON.parse(replay.stdout).workspace).toMatchObject({
      workspaceId: workspace.workspaceId, created: false,
    });
  });

  test('a crash leaves a reservation whose holder is provably gone, and starting up releases it', async () => {
    const { environment, projectId, home } = await fixture();
    const task = await createReadyTask(environment, projectId, 'Crash recovery');
    const reserved = await acquire(environment, projectId, task);
    expect(reserved.exitCode).toBe(0);
    const reservedPayload = payloadOf(reserved);
    const reservationId = reservedPayload.reservation?.reservationId as string;
    const runtimePid = reservedPayload.reservation?.holder.pid as number;

    // Kill the Runtime the way a crash does: no shutdown, no release, no reconcile.
    const status = JSON.parse((await cli(['status'], environment)).stdout) as { readonly pid: number };
    process.kill(status.pid, 'SIGKILL');
    for (let attempt = 0; attempt < 100 && pidExists(status.pid); attempt += 1) await Bun.sleep(20);
    expect(pidExists(status.pid)).toBe(false);
    expect(pidExists(runtimePid)).toBe(false);

    // The next command starts a new Runtime generation, whose startup reconcile judges the residual
    // reservation from the recorded holder evidence: the process is gone, so it is released and
    // recorded — never replayed and never silently adopted.
    const listed = await cli(['scheduler', 'reservations', 'get', projectId, reservationId, '--json'],
      environment);
    expect(listed.exitCode).toBe(0);
    const reconciled = JSON.parse(listed.stdout) as {
      readonly state: string; readonly releaseKind: string | null;
      readonly holder: { readonly bootId: string; readonly pid: number };
      readonly events: readonly { readonly kind: string;
        readonly evidence: Record<string, unknown> }[] };
    expect(reconciled).toMatchObject({
      state: 'RELEASED', releaseKind: 'RECONCILED_HOLDER_EXITED',
      holder: { bootId: reservedPayload.reservation?.holder.bootId as string },
    });
    const observation = reconciled.events.find((event) => event.kind === 'RECONCILE_OBSERVED');
    expect(observation?.evidence).toMatchObject({
      decision: 'RELEASE', observation: 'HOLDER_STOPPED', signalsSent: 0, resourcesDeleted: 0,
    });
    // The slot is free again, and an explicit reconcile is idempotent (nothing left to converge).
    const explicit = await cli(['scheduler', 'reservations', 'reconcile', projectId, '--json'],
      environment);
    expect(explicit.exitCode).toBe(0);
    expect(JSON.parse(explicit.stdout).outcomes).toEqual([]);
    expect((await acquire(environment, projectId, task)).exitCode).toBe(0);
    expect(home.length).toBeGreaterThan(0);
  });

  test('a reservation whose holder cannot be verified keeps its slot instead of letting it through', async () => {
    const { environment, projectId, home } = await fixture();
    const task = await createReadyTask(environment, projectId, 'Unverifiable holder');
    const second = await createReadyTask(environment, projectId, 'Second Task');
    // Stop the Runtime first, so the residual row is written the way a crashed generation would have
    // left it: it records a live pid but no start token, so the pid cannot be attributed to it.
    const stopped = await cli(['stop'], environment);
    expect(stopped.exitCode).toBe(0);
    const sleeper = Bun.spawn(['sleep', '120'], { stdout: 'ignore', stderr: 'ignore' });
    try {
      const database = new Phase1Database(join(home, 'runtime.sqlite'));
      database.sqlite.query(`
        INSERT INTO execution_slot_reservations(id,project_id,task_id,revision_id,task_version,
          adapter_id,dependency_fingerprint,assessed_dev_commit,state,version,command_id,
          holder_boot_id,holder_pid,holder_start_token,holder_actor,reserved_at,updated_at)
        VALUES (?1,?2,?3,?4,?5,'pi','recorded-by-a-crashed-generation',NULL,'RESERVED',0,?6,
          'boot-crashed',?7,NULL,'runtime',?8,?8)
      `).run(crypto.randomUUID(), projectId, task.id, task.revisionId, task.version,
        crypto.randomUUID(), sleeper.pid, Date.now());
      database.close();

      // Any command starts a Runtime again; its startup reconcile inspects the recorded holder: the
      // pid is alive but nothing attributes it to the reservation, so the slot is kept occupied.
      const listed = await cli(['scheduler', 'reservations', 'list', projectId, '--json'], environment);
      expect(listed.exitCode).toBe(0);
      const listedReservations = JSON.parse(listed.stdout).reservations as readonly {
        readonly reservationId: string }[];
      expect(listedReservations).toHaveLength(1);
      const held = JSON.parse((await cli(['scheduler', 'reservations', 'get', projectId,
        listedReservations[0]?.reservationId as string, '--json'], environment)).stdout) as {
        readonly state: string; readonly releaseKind: string | null;
        readonly releaseObservation: string | null; readonly events: readonly {
          readonly kind: string; readonly evidence: Record<string, unknown> }[] };
      expect(held).toMatchObject({
        state: 'RECOVERY_REQUIRED', releaseKind: null,
        releaseObservation: 'HOLDER_OWNERSHIP_UNVERIFIABLE',
      });
      expect(held.events.at(-1)?.evidence).toMatchObject({
        decision: 'MARK_RECOVERY_REQUIRED', observation: 'HOLDER_OWNERSHIP_UNVERIFIABLE',
        quiescenceProven: false, signalsSent: 0,
      });
      // The foreign process was never signalled.
      expect(pidExists(sleeper.pid)).toBe(true);
      // And the unverifiable reservation still occupies its slot: the second Task waits for capacity.
      const view = JSON.parse((await cli(['scheduler', 'capacity', 'get', projectId, '--json'],
        environment)).stdout) as { readonly globalUsed: number };
      expect(view.globalUsed).toBe(1);
      const waiting = await acquire(environment, projectId, second);
      expect(waiting.exitCode).toBe(0);
      const third = await createReadyTask(environment, projectId, 'Third Task');
      expect((await acquire(environment, projectId, third)).exitCode).toBe(3);
      // An explicit reconcile does not quietly free it either.
      const explicit = await cli(['scheduler', 'reservations', 'reconcile', projectId, '--json'],
        environment);
      expect(explicit.exitCode).toBe(0);
      const after = JSON.parse((await cli(['scheduler', 'reservations', 'list', projectId,
        '--json'], environment)).stdout).reservations as readonly { readonly state: string }[];
      expect(after.filter((entry) => entry.state === 'RECOVERY_REQUIRED')).toHaveLength(1);
    } finally {
      sleeper.kill();
      await sleeper.exited;
    }
  });
});
