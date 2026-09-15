import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';
import { provisionDevClone } from './support/agent-fixture.js';

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
}

/** Trusted temporary project with no Agent execution: enough to drive the Task control commands. */
async function trustedProject(): Promise<{ environment: Record<string, string>; projectId: string }> {
  const repository = temporaryDirectory('codeestra-control-repo-');
  const home = temporaryDirectory('codeestra-control-home-');
  const assets = temporaryDirectory('codeestra-control-assets-');
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
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
  const devRepo = await provisionDevClone({ repository: repository });
  const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets };
  const opened = await cli(['open', repository, '--dev-repo', devRepo, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  return { environment, projectId: projects[0]?.id as string };
}

async function submittedTask(environment: Record<string, string>, projectId: string): Promise<TaskPayload> {
  const created = JSON.parse((await cli(['task', 'create', projectId, 'Do a thing'],
    environment)).stdout) as TaskPayload;
  const submitted = await cli(['task', 'submit', projectId, created.id, '0'], environment);
  expect(submitted.exitCode).toBe(0);
  return { ...created, state: 'READY', version: 1 };
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

      const list = JSON.parse((await cli(['task', 'list', projectId], environment)).stdout) as
        readonly TaskPayload[];
      expect(list).toHaveLength(0);
      const all = JSON.parse((await cli(['task', 'list', projectId, '--all'], environment)).stdout) as
        readonly TaskPayload[];
      expect(all.map((entry) => entry.id)).toEqual([task.id]);
      expect(all[0]?.archivedAt).not.toBeNull();

      // The archived Task is still readable by ID, and unarchive restores it.
      const status = JSON.parse((await cli(['task', 'status', projectId, task.id],
        environment)).stdout) as { readonly task: TaskPayload };
      expect(status.task.state).toBe('READY');
      const unarchived = await cli(['task', 'unarchive', projectId, task.id, '2'], environment);
      expect(unarchived.exitCode).toBe(0);
      expect(JSON.parse(unarchived.stdout)).toMatchObject({ archived: false });
      const restored = JSON.parse((await cli(['task', 'list', projectId], environment)).stdout) as
        readonly TaskPayload[];
      expect(restored.map((entry) => entry.id)).toEqual([task.id]);
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
      expect(list).toHaveLength(1);
    } finally {
      await cli(['stop'], environment);
    }
  }, 60_000);
});
