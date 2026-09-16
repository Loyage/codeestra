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
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Control Test',
      GIT_AUTHOR_EMAIL: 'control@example.invalid', GIT_COMMITTER_NAME: 'Control Test',
      GIT_COMMITTER_EMAIL: 'control@example.invalid' } });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

interface TaskPayload {
  readonly id: string;
  readonly state: string;
  readonly version: number;
  readonly archivedAt: number | null;
  /**
   * The newest Execution attempt of this Task, from the `task list`/`task status` projection. It is
   * what lets a list row tell "the Agent is still running" from "its Session already recorded an
   * ending" without a second read per row; `null` means the Task never started an attempt.
   */
  readonly latestExecution: {
    readonly executionId: string;
    readonly attemptNumber: number;
    readonly state: string;
    readonly resourceHeld: boolean;
    readonly sessionState: string | null;
    readonly completionOutcome: 'SUCCESS' | 'FAILURE' | null;
  } | null;
}

/** Trusted temporary project with no Agent execution: enough to drive the Task control commands. */
async function trustedProject(): Promise<{ environment: Record<string, string>; projectId: string }> {
  const repository = temporaryDirectory('codeestra-control-repo-');
  const home = temporaryDirectory('codeestra-control-home-');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  // ADR-0009: the long-lived dev branch is the baseline every workspace is created from.
  await git(repository, ['branch', 'dev']);
  // ADR-0056: every dev fact comes from a second clone of the same origin that sits on
  // `dev`; the project is trusted with it explicitly.
  const environment = { CODEESTRA_HOME: home };
  const opened = await cli(['project', 'trust', repository], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  return { environment, projectId: projects[0]?.id as string };
}

/**
 * One READY Task that nothing has started. ADR-0059 starts an undeclared Task the moment it is
 * submitted, so the fixture is held by a real feature conflict instead: these tests are about
 * `task cancel`/`task archive` on a Task that has not run yet.
 */
async function submittedTask(environment: Record<string, string>, projectId: string): Promise<TaskPayload> {
  await cli(['stop'], environment);
  const ready = await createFixtureTaskForExplicitStart({
    home: environment.CODEESTRA_HOME as string, environment, projectId,
    specification: 'Do a thing',
  });
  const status = await cli(['task', 'status', projectId, ready.taskId], environment);
  expect(status.exitCode).toBe(0);
  const payload = JSON.parse(status.stdout) as { readonly task: TaskPayload };
  expect(payload.task.state).toBe('READY');
  return payload.task;
}

describe('codeestra task control', () => {
  test('cancels a READY Task from the CLI with a terminal state', async () => {
    const { environment, projectId } = await trustedProject();
    try {
      const task = await submittedTask(environment, projectId);
      const cancelled = await cli(['task', 'cancel', projectId, task.id, '1'], environment);
      expect(cancelled.exitCode).toBe(0);
      expect(JSON.parse(cancelled.stdout)).toMatchObject({ state: 'CANCELLED', stop: 'TERMINAL' });

      // Cancelling again is a no-op with the current version, so a script does not have to guess
      // whether its first request landed.
      const again = await cli(['task', 'cancel', projectId, task.id, '2'], environment);
      expect(again.exitCode).toBe(0);
      expect(JSON.parse(again.stdout)).toMatchObject({ state: 'CANCELLED', stop: 'TERMINAL' });
      const status = JSON.parse((await cli(['task', 'status', projectId, task.id],
        environment)).stdout) as { readonly task: TaskPayload };
      expect(status.task.state).toBe('CANCELLED');
    } finally {
      await cli(['stop'], environment);
    }
  }, 60_000);

  test('archives and unarchives a Task without destroying it', async () => {
    const { environment, projectId } = await trustedProject();
    try {
      const task = await submittedTask(environment, projectId);
      const archived = await cli(['task', 'archive', projectId, task.id, '1'], environment);
      expect(archived.exitCode).toBe(0);
      expect(JSON.parse(archived.stdout)).toMatchObject({ state: 'READY', archived: true });

      // The fixture also holds an unfinished peer Task (that peer is what keeps this one from being
      // started), so the assertions are about this Task's own row rather than about the list length.
      const list = JSON.parse((await cli(['task', 'list', projectId], environment)).stdout) as
        readonly TaskPayload[];
      expect(list.filter((entry) => entry.id === task.id)).toHaveLength(0);
      const all = JSON.parse((await cli(['task', 'list', projectId, '--all'], environment)).stdout) as
        readonly TaskPayload[];
      const archivedRow = all.find((entry) => entry.id === task.id);
      expect(archivedRow?.archivedAt).not.toBeNull();
      // A Task that never started an attempt reports no attempt — not an unknown one. The field is
      // read by CLI status, so it has to survive the whole command face, not just storage.
      expect(archivedRow?.latestExecution).toBeNull();

      // The archived Task is still readable by ID, and unarchive restores it.
      const status = JSON.parse((await cli(['task', 'status', projectId, task.id],
        environment)).stdout) as { readonly task: TaskPayload };
      expect(status.task.state).toBe('READY');
      const unarchived = await cli(['task', 'unarchive', projectId, task.id, '2'], environment);
      expect(unarchived.exitCode).toBe(0);
      expect(JSON.parse(unarchived.stdout)).toMatchObject({ archived: false });
      const restored = JSON.parse((await cli(['task', 'list', projectId], environment)).stdout) as
        readonly TaskPayload[];
      expect(restored.filter((entry) => entry.id === task.id)).toHaveLength(1);
    } finally {
      await cli(['stop'], environment);
    }
  }, 60_000);

  test('refuses a control command whose expected version is stale', async () => {
    const { environment, projectId } = await trustedProject();
    try {
      const task = await submittedTask(environment, projectId);
      const stale = await cli(['task', 'archive', projectId, task.id, '0'], environment);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr).toContain('CONCURRENT_MODIFICATION');
      const list = JSON.parse((await cli(['task', 'list', projectId], environment)).stdout) as
        readonly TaskPayload[];
      expect(list.find((entry) => entry.id === task.id)?.state).toBe('READY');
    } finally {
      await cli(['stop'], environment);
    }
  }, 60_000);
});
