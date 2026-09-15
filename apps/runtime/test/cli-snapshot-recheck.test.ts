import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

/**
 * The cached-snapshot-generation recheck over the real command face (FOUNDATION-060).
 *
 * Every assertion is made through `bun run codeestra …` against a real Runtime in a temporary
 * `CODEESTRA_HOME`, a real temporary Git repository, and a protocol stub provider. The stub proves
 * the Runtime's own orchestration and the storage/Git behaviour; it is never evidence about a real
 * Agent integration, and nothing here claims the recheck closes the window between a reservation and
 * the first write of an Agent that is already running.
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
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Recheck Test',
      GIT_AUTHOR_EMAIL: 'recheck@example.invalid', GIT_COMMITTER_NAME: 'Recheck Test',
      GIT_COMMITTER_EMAIL: 'recheck@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

/**
 * A protocol stub that reports a usable session file, writes one file per Task worktree, settles and
 * then keeps reading stdin so the Execution keeps holding its resource. Never a real Agent.
 */
const stubSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const sessionDirIndex = argv.indexOf('--session-dir');
const sessionDir = sessionDirIndex >= 0 ? argv[sessionDirIndex + 1] : process.cwd();
mkdirSync(sessionDir, { recursive: true });
const taskId = basename(process.cwd());
const sessionFile = join(sessionDir, 'recheck-session-' + taskId + '.jsonl');
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
        sessionId: 'recheck-session-' + taskId, sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      const directory = join(process.cwd(), 'src', 'agent');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, taskId + '.ts'), 'export const task = ' +
        JSON.stringify(taskId) + ';\\n');
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'recheck-session-' + taskId, timestamp: '2026-09-14T09:00:00.000Z',
        cwd: process.cwd() }) + '\\n');
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Wrote the file.' }], stopReason: 'stop' } });
      emit({ type: 'agent_settled' });
    }
  }
}
`;

/** A mapping with a declared important directory, module and shared resource. */
const impactMapping = {
  version: 1,
  importantDirectories: ['core'],
  modules: [{ id: 'core-module', paths: ['core/**'] }],
  globalResources: [
    { id: 'lockfile', kind: 'DEPENDENCY_LOCKFILE', paths: ['bun.lock'],
      consumers: { state: 'DECLARED', paths: ['package.json'] } },
  ],
};

interface Fixture {
  readonly environment: Record<string, string>;
  readonly repository: string;
  readonly projectId: string;
}

async function fixture(withMapping: boolean): Promise<Fixture> {
  const repository = temporaryDirectory('codeestra-recheck-repo-');
  const home = temporaryDirectory('codeestra-recheck-home-');
  const tools = temporaryDirectory('codeestra-recheck-tools-');
  const assets = temporaryDirectory('codeestra-recheck-assets-');
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  if (withMapping) {
    await Bun.write(join(repository, '.codeestra', 'impact.json'),
      `${JSON.stringify(impactMapping, null, 2)}\n`);
  }
  await Bun.write(join(repository, 'package.json'), '{"name":"fixture","private":true}\n');
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
  return { environment, repository, projectId: projects[0]?.id as string };
}

interface TaskRef {
  readonly id: string;
  readonly version: number;
  readonly revisionId: string;
  readonly state: string;
}

async function createReadyTask(
  fixtureState: Fixture,
  specification: string,
): Promise<{ readonly task: TaskRef; readonly submit: { readonly started: readonly unknown[];
  readonly waiting: readonly { readonly code: string }[] } }> {
  const created = await cli(['task', 'create', fixtureState.projectId, specification],
    fixtureState.environment);
  expect(created.exitCode).toBe(0);
  const taskId = (JSON.parse(created.stdout) as { readonly id: string }).id;
  const submitted = await cli(['task', 'submit', fixtureState.projectId, taskId, '0'],
    fixtureState.environment);
  expect(submitted.exitCode).toBe(0);
  const status = await cli(['task', 'status', fixtureState.projectId, taskId],
    fixtureState.environment);
  expect(status.exitCode).toBe(0);
  const payload = JSON.parse(status.stdout) as {
    readonly task: { readonly id: string; readonly version: number; readonly state: string;
      readonly currentRevision: { readonly id: string } } };
  return {
    task: { id: payload.task.id, version: payload.task.version, state: payload.task.state,
      revisionId: payload.task.currentRevision.id },
    submit: JSON.parse(submitted.stdout).schedule as {
      readonly started: readonly unknown[]; readonly waiting: readonly { readonly code: string }[] },
  };
}

interface Generation {
  readonly snapshotId: string;
  readonly revisionId: string;
  readonly baseCommit: string;
  readonly policyVersion: string;
}

/**
 * The generation an acquisition would name: the assessment the Runtime itself derived for this Task.
 * With no worktree the Runtime predicts against the development baseline, and this is the id and key
 * the scheduling engine would hand to `scheduler reservations acquire`.
 */
async function generationOf(fixtureState: Fixture, taskId: string): Promise<Generation> {
  const status = await cli(['task', 'schedule', 'status', fixtureState.projectId, '--json'],
    fixtureState.environment);
  expect(status.exitCode).toBe(0);
  const report = JSON.parse(status.stdout) as {
    readonly candidates: readonly { readonly taskId: string; readonly revisionId: string;
      readonly assessment: { readonly candidateSnapshotId: string | null;
        readonly baseCommit: string; readonly policyVersion: string } | null }[] };
  const candidate = report.candidates.find((entry) => entry.taskId === taskId);
  expect(candidate?.assessment).toBeTruthy();
  const assessment = candidate?.assessment;
  if (assessment === null || assessment === undefined) {
    throw new Error('The Runtime reported no assessment for the candidate');
  }
  expect(typeof assessment.candidateSnapshotId).toBe('string');
  return {
    snapshotId: assessment.candidateSnapshotId as string,
    revisionId: candidate?.revisionId as string,
    baseCommit: assessment.baseCommit,
    policyVersion: assessment.policyVersion,
  };
}

interface AcquireResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly payload: {
    readonly outcome?: string;
    readonly code?: string;
    readonly message?: string;
    readonly detail?: { readonly reasonCodes?: readonly string[];
      readonly differing?: readonly string[]; readonly snapshotId?: string;
      readonly assessed?: Readonly<Record<string, unknown>>;
      readonly observed?: Readonly<Record<string, unknown>> };
    readonly wait?: { readonly code: string } | null;
    readonly reservation?: { readonly reservationId: string; readonly state: string;
      readonly impactSnapshotId: string | null } | null;
  } | null;
}

async function acquire(
  fixtureState: Fixture,
  task: TaskRef,
  snapshotId?: string,
): Promise<AcquireResult> {
  const result = await cli(['scheduler', 'reservations', 'acquire', fixtureState.projectId, task.id,
    String(task.version), '--revision', task.revisionId, '--json',
    ...(snapshotId === undefined ? [] : ['--snapshot', snapshotId])], fixtureState.environment);
  return { ...result,
    payload: result.stdout.trim().length === 0 ? null : JSON.parse(result.stdout) as
      AcquireResult['payload'] };
}

async function activeReservations(fixtureState: Fixture) {
  const listed = await cli(['scheduler', 'reservations', 'list', fixtureState.projectId, '--json'],
    fixtureState.environment);
  expect(listed.exitCode).toBe(0);
  return JSON.parse(listed.stdout) as { readonly reservations: readonly {
    readonly reservationId: string; readonly state: string;
    readonly impactSnapshotId: string | null }[] };
}

/** Moves `dev` forward without touching the checked-out `main` worktree. */
async function advanceDev(fixtureState: Fixture): Promise<string> {
  const tree = await git(fixtureState.repository, ['rev-parse', 'HEAD^{tree}']);
  const previous = await git(fixtureState.repository, ['rev-parse', 'refs/heads/dev']);
  const moved = await git(fixtureState.repository,
    ['commit-tree', tree, '-p', previous, '-m', 'dev moves']);
  await git(fixtureState.repository, ['update-ref', 'refs/heads/dev', moved]);
  return moved;
}

describe('scheduler reservations acquire --snapshot', () => {
  test('reserves on a current generation and refuses one whose baseline moved, writing nothing',
    async () => {
      const fixtureState = await fixture(false);
      const { task, submit } = await createReadyTask(fixtureState, 'Independent work');
      // Without a mapping nothing can be proven complete, so the engine predicts and waits rather
      // than starting: the Task keeps a READY state and a cached generation to be checked.
      expect(submit.started).toHaveLength(0);
      expect(task.state).toBe('READY');
      const generation = await generationOf(fixtureState, task.id);
      expect(generation.policyVersion).toBe('impact-policy-v1#absent');

      // A generation that is still current is reserved, and the reservation records exactly it.
      const reserved = await acquire(fixtureState, task, generation.snapshotId);
      expect(reserved.exitCode).toBe(0);
      expect(reserved.payload).toMatchObject({ outcome: 'RESERVED',
        reservation: { state: 'RESERVED', impactSnapshotId: generation.snapshotId } });
      const reservationId = reserved.payload?.reservation?.reservationId as string;
      const released = await cli(['scheduler', 'reservations', 'release', fixtureState.projectId,
        reservationId, '--reason', 'the test takes the slot back', '--json'],
      fixtureState.environment);
      expect(released.exitCode).toBe(0);
      expect((await activeReservations(fixtureState)).reservations).toHaveLength(0);

      // `dev` advances: a Task without a worktree was predicted against that baseline, so the cached
      // generation no longer describes the Task and the reservation is refused with facts.
      const moved = await advanceDev(fixtureState);
      const refused = await acquire(fixtureState, task, generation.snapshotId);
      expect(refused.exitCode).toBe(1);
      expect(refused.payload).toMatchObject({
        outcome: 'REFUSED', code: 'SNAPSHOT_STALE',
        detail: { snapshotId: generation.snapshotId, differing: ['baseCommit'],
          reasonCodes: ['STALE_BASE'] },
      });
      expect(refused.payload?.detail?.assessed?.['baseCommit']).toBe(generation.baseCommit);
      expect(refused.payload?.detail?.observed?.['baseCommit']).toBe(moved);
      expect(refused.stderr).toContain('SNAPSHOT_STALE');
      // Nothing was written: no active reservation, and the released audit row is untouched.
      expect((await activeReservations(fixtureState)).reservations).toHaveLength(0);
      const all = await cli(['scheduler', 'reservations', 'list', fixtureState.projectId,
        '--include-released', '--json'], fixtureState.environment);
      expect(JSON.parse(all.stdout).reservations).toHaveLength(1);
    }, 90_000);

  test('refuses a generation whose mapping changed, and accepts the regenerated one',
    async () => {
      const fixtureState = await fixture(false);
      const { task } = await createReadyTask(fixtureState, 'Mapping recheck');
      const generation = await generationOf(fixtureState, task.id);
      expect(generation.policyVersion).toBe('impact-policy-v1#absent');

      // The mapping is read from the project `main` ref, so committing one moves the policy version
      // of every generation derived from now on and leaves the cached one describing no mapping.
      await Bun.write(join(fixtureState.repository, '.codeestra', 'impact.json'),
        `${JSON.stringify(impactMapping, null, 2)}\n`);
      await git(fixtureState.repository, ['add', '.codeestra/impact.json']);
      await git(fixtureState.repository, ['commit', '-q', '-m', 'declare an impact mapping']);
      const refused = await acquire(fixtureState, task, generation.snapshotId);
      expect(refused.exitCode).toBe(1);
      expect(refused.payload).toMatchObject({ outcome: 'REFUSED', code: 'SNAPSHOT_STALE',
        detail: { differing: ['policyVersion'], reasonCodes: ['STALE_POLICY'] } });
      expect(refused.payload?.detail?.assessed?.['policyVersion']).toBe('impact-policy-v1#absent');
      expect(String(refused.payload?.detail?.observed?.['policyVersion']))
        .toMatch(/^impact-policy-v1#[0-9a-f]{12}$/);
      expect((await activeReservations(fixtureState)).reservations).toHaveLength(0);

      // The Runtime's own next assessment records a generation for the mapping now in effect, and
      // that one is reserved: the recheck is freshness, not a gate that never opens again.
      const regenerated = await generationOf(fixtureState, task.id);
      expect(regenerated.snapshotId).not.toBe(generation.snapshotId);
      const reserved = await acquire(fixtureState, task, regenerated.snapshotId);
      expect(reserved.exitCode).toBe(0);
      expect(reserved.payload).toMatchObject({ outcome: 'RESERVED',
        reservation: { impactSnapshotId: regenerated.snapshotId } });
    }, 90_000);

  test('two concurrent acquisitions of one generation produce exactly one reservation', async () => {
    const fixtureState = await fixture(false);
    const { task } = await createReadyTask(fixtureState, 'Concurrent reservation');
    const generation = await generationOf(fixtureState, task.id);
    const [left, right] = await Promise.all([
      acquire(fixtureState, task, generation.snapshotId),
      acquire(fixtureState, task, generation.snapshotId),
    ]);
    // The immediate transaction serializes them, the recheck runs inside it, and the second one sees
    // the committed row: never two reservations, and never a stale generation slipping through.
    expect([left.exitCode, right.exitCode].sort()).toEqual([0, 1]);
    const loser = left.exitCode === 0 ? right : left;
    expect(loser.stderr).toContain('SLOT_ALREADY_RESERVED');
    const active = await activeReservations(fixtureState);
    expect(active.reservations).toHaveLength(1);
    expect(active.reservations[0]?.impactSnapshotId).toBe(generation.snapshotId);
  }, 90_000);

  test('omitting --snapshot keeps the primitive working and records no assessment', async () => {
    const fixtureState = await fixture(false);
    const { task } = await createReadyTask(fixtureState, 'No asserted assessment');
    const reserved = await acquire(fixtureState, task);
    expect(reserved.exitCode).toBe(0);
    expect(reserved.payload).toMatchObject({
      outcome: 'RESERVED', reservation: { impactSnapshotId: null } });
  }, 90_000);

  test('the engine still starts a Task from its own pre-start generation', async () => {
    // A complete, confirmed mapping is what lets the analyzer return SAFE, so this exercises the
    // scheduling engine's own reservation: it passes the pre-start generation it just derived
    // (empty change set, development baseline) through the same recheck the CLI uses. A `SKIPPED`
    // decision carrying `SNAPSHOT_STALE` would show up here instead of a start.
    const fixtureState = await fixture(true);
    const { task, submit } = await createReadyTask(fixtureState, 'Engine start');
    expect(submit.started).toHaveLength(1);
    expect(submit.waiting).toHaveLength(0);
    const status = await cli(['task', 'status', fixtureState.projectId, task.id],
      fixtureState.environment);
    const payload = JSON.parse(status.stdout) as { readonly task: { readonly state: string } };
    expect(payload.task.state).not.toBe('READY');
  }, 90_000);
});
