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
 * `task recover` through the real command face (ADR-0055).
 *
 * The command was documented in the old `usage()` dump, in five guides and in ADR-0055, and the
 * Runtime implemented it — but no CLI branch ever sent `task.recover`, so `codeestra task recover`
 * printed the usage dump and exited 2. These tests pin the command face from outside: the CLI
 * reaches the Runtime's reconcile, and an unknown argument is still a usage error.
 *
 * The reconcile's own semantics (which observation closes a run, which one refuses) are covered by
 * `task-recovery-service.test.ts`. Reaching `RECOVERY_REQUIRED` through the CLI alone is not
 * possible today: it takes a provider that disappeared while the Runtime was down.
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
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Recover Test',
      GIT_AUTHOR_EMAIL: 'recover@example.invalid', GIT_COMMITTER_NAME: 'Recover Test',
      GIT_COMMITTER_EMAIL: 'recover@example.invalid' } });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

async function trustedProject(): Promise<{ environment: Record<string, string>; projectId: string }> {
  const repository = temporaryDirectory('codeestra-recover-repo-');
  const home = temporaryDirectory('codeestra-recover-home-');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  const environment = { CODEESTRA_HOME: home };
  expect((await cli(['project', 'trust', repository], environment)).exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  return { environment, projectId: projects[0]?.id as string };
}

describe('codeestra task recover', () => {
  test('reaches the Runtime reconcile instead of falling back to a usage error', async () => {
    const { environment, projectId } = await trustedProject();
    try {
      const task = await createFixtureTaskForExplicitStart({
        home: environment.CODEESTRA_HOME as string, environment, projectId,
        specification: 'Something a provider abandoned',
      });
      const status = await cli(['task', 'status', task.taskId], environment);
      const version = (JSON.parse(status.stdout) as { readonly task: { readonly version: number } })
        .task.version;

      const refused = await cli(
        ['task', 'recover', task.taskId, String(version)], environment);
      // The Task exists but never ran, so it has no Execution for the reconcile to look at: the
      // service answers NOT_FOUND for that, and TASK_NOT_IN_RECOVERY when there is one. Either way
      // the proof this test pins is that the CLI reached the Runtime at all: before the fix the same
      // argv exited 2 with the usage dump and never sent a request.
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toMatch(/NOT_FOUND|TASK_NOT_IN_RECOVERY/);
      expect(refused.stderr).not.toContain('USAGE:');

      // The Task really is untouched: a refusal is a value, and nothing was written.
      const after = JSON.parse((await cli(['task', 'status', task.taskId],
        environment)).stdout) as { readonly task: { readonly version: number } };
      expect(after.task.version).toBe(version);
    } finally {
      await cli(['stop'], environment);
    }
  }, 60_000);

  test('keeps its own usage error, and points at its own help', async () => {
    const { environment } = await trustedProject();
    try {
      const result = await cli(['task', 'recover'], environment);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(result.stderr).toContain('task recover');
      expect(result.stderr).toContain('codeestra task recover help');

      const help = await cli(['task', 'recover', 'help'], environment);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain('RECOVERY_REQUIRED');
    } finally {
      await cli(['stop'], environment);
    }
  }, 60_000);
});
