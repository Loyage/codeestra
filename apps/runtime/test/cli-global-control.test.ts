import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFixtureTaskForExplicitStart,
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

/**
 * `scheduler control *` on the real command face (FOUNDATION-097 / ADR-0061 D09).
 *
 * Every assertion here goes through the CLI talking to a real Runtime over the Runtime's own socket,
 * so what it reports is the *public* contract: exit 0 for a complete/stable state, exit 1 for a
 * refusal with a stable code, and exit 3 for a Task that merely *waits* for the barrier. No desktop,
 * browser or window automation is involved — the runtime-side behaviour (real `SIGSTOP`/`SIGCONT` on a
 * real provider process, per-target facts) is covered by `runtime-global-pause.test.ts`.
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

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Global Control Test',
      GIT_AUTHOR_EMAIL: 'control@example.invalid', GIT_COMMITTER_NAME: 'Global Control Test',
      GIT_COMMITTER_EMAIL: 'control@example.invalid' } });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

interface ControlView {
  readonly state: string;
  readonly pauseEpoch: number;
  readonly code: string | null;
  readonly platformSupported: boolean;
  readonly targets: readonly { readonly state: string; readonly sessionId: string }[];
  readonly capacity: null;
}

async function trustedProject(): Promise<{ environment: Record<string, string>; home: string;
  projectId: string }> {
  const repository = temporaryDirectory('codeestra-glc2-repo-');
  const home = temporaryDirectory('codeestra-glc2-home-');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  await git(repository, ['branch', 'dev']);
  const environment = { CODEESTRA_HOME: home };
  expect((await cli(['project', 'trust', repository], environment)).exitCode)
    .toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  const projectId = projects[0]?.id;
  if (projectId === undefined) throw new Error('the fixture project was not opened');
  return { environment, home, projectId };
}

async function status(environment: Record<string, string>): Promise<ControlView> {
  const result = await cli(['scheduler', 'control', 'status', '--json'], environment);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as ControlView;
}

describe('scheduler control on the CLI command face', () => {
  test('status, pause, resume and reconcile are zero-confirmation and idempotent', async () => {
    const { environment } = await trustedProject();

    const start = await status(environment);
    expect(start).toMatchObject({ state: 'RUNNING', pauseEpoch: 0, code: null });
    expect(start.platformSupported).toBe(true);
    // The capacity numbers are not invented here: they belong to `scheduler capacity get`.
    expect(start.capacity).toBeNull();

    const paused = await cli(['scheduler', 'control', 'pause', '--json'], environment);
    expect(paused.exitCode).toBe(0);
    const pausedView = JSON.parse(paused.stdout) as ControlView;
    expect(pausedView.state).toBe('PAUSED');
    expect(pausedView.pauseEpoch).toBe(1);
    expect(pausedView.targets).toEqual([]);

    // A second pause with a *new* command id is an idempotent no-op, not a second epoch.
    const again = await cli(['scheduler', 'control', 'pause', '--json'], environment);
    expect(again.exitCode).toBe(0);
    expect((JSON.parse(again.stdout) as ControlView).pauseEpoch).toBe(1);

    expect(await status(environment)).toMatchObject({ state: 'PAUSED', pauseEpoch: 1 });

    // reconcile is read-only: it records observations and sends no signal.
    const reconciled = await cli(['scheduler', 'control', 'reconcile', '--json'], environment);
    expect(reconciled.exitCode).toBe(0);
    expect((JSON.parse(reconciled.stdout) as ControlView).state).toBe('PAUSED');

    const resumed = await cli(['scheduler', 'control', 'resume', '--json'], environment);
    expect(resumed.exitCode).toBe(0);
    expect((JSON.parse(resumed.stdout) as ControlView).state).toBe('RUNNING');

    // Resuming an already RUNNING Runtime is the same no-op, and does not open an epoch.
    const resumedAgain = await cli(['scheduler', 'control', 'resume', '--json'], environment);
    expect(resumedAgain.exitCode).toBe(0);
    expect((JSON.parse(resumedAgain.stdout) as ControlView).pauseEpoch).toBe(1);
  }, 30_000);

  test('a Task that waits for the barrier exits 3 with SCHEDULER_GLOBALLY_PAUSED, not 1 and not BLOCKED', async () => {
    const { environment, home, projectId } = await trustedProject();
    const task = await createFixtureTaskForExplicitStart({
      home, environment, projectId,
      specification: 'A Task that is startable while the Runtime is paused',
      startable: true,
    });
    expect((await cli(['scheduler', 'control', 'pause', '--json'], environment)).exitCode).toBe(0);

    const run = await cli(['task', 'run', projectId, task.taskId, String(task.expectedVersion)],
      environment);
    expect(run.exitCode).toBe(3);
    expect(run.stderr).toContain('SCHEDULER_GLOBALLY_PAUSED');
    // It is a *wait*: the Task keeps its own state instead of being reported as blocked.
    const statusAfter = await cli(['task', 'status', projectId, task.taskId], environment);
    expect(statusAfter.exitCode).toBe(0);
    const taskView = JSON.parse(statusAfter.stdout) as {
      readonly task: { readonly state: string; readonly version: number;
        readonly currentRevision: { readonly id: string } };
    };
    expect(taskView.task.state).toBe('READY');

    // The same reservation the scheduler uses is refused for the same reason and with the same exit
    // code, so a script driving the primitive directly sees one consistent fact.
    const acquire = await cli([
      'scheduler', 'reservations', 'acquire', projectId, task.taskId,
      String(taskView.task.version), '--revision', taskView.task.currentRevision.id,
    ], environment);
    expect(acquire.exitCode).toBe(3);
    expect(acquire.stdout).toContain('SCHEDULER_GLOBALLY_PAUSED');

    // After an explicit resume the same request is admitted again (the Task is still READY).
    expect((await cli(['scheduler', 'control', 'resume', '--json'], environment)).exitCode).toBe(0);
    expect(await status(environment)).toMatchObject({ state: 'RUNNING' });
  }, 60_000);

  test('the pause state survives a Runtime restart and is never cleared by `stop`', async () => {
    const { environment } = await trustedProject();
    expect((await cli(['scheduler', 'control', 'pause', '--json'], environment)).exitCode).toBe(0);
    // `stop` asks the Runtime to exit; the global control state is not part of what it clears.
    expect((await cli(['stop'], environment)).exitCode).toBe(0);
    const afterRestart = await status(environment);
    expect(afterRestart).toMatchObject({ state: 'PAUSED', pauseEpoch: 1 });
    expect((await cli(['scheduler', 'control', 'resume', '--json'], environment)).exitCode).toBe(0);
    expect(await status(environment)).toMatchObject({ state: 'RUNNING' });
  }, 30_000);
});
