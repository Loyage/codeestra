import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Config Test',
      GIT_AUTHOR_EMAIL: 'config@example.invalid', GIT_COMMITTER_NAME: 'Config Test',
      GIT_COMMITTER_EMAIL: 'config@example.invalid' } });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

interface AgentConfigPayload {
  readonly adapterId: string;
  readonly projectId: string | null;
  readonly global: { readonly provider: string | null; readonly model: string | null;
    readonly thinkingLevel: string | null } | null;
  readonly project: { readonly provider: string | null; readonly model: string | null;
    readonly thinkingLevel: string | null } | null;
  readonly environment: unknown;
  readonly effective: { readonly provider: string | null; readonly model: string | null;
    readonly thinkingLevel: string | null };
  readonly sources: { readonly provider: string; readonly model: string; readonly thinkingLevel: string };
}

/** A trusted temporary repository, so project-scoped configuration has a real project ID. */
async function trustedProject(): Promise<{ home: string; projectId: string }> {
  const repository = temporaryDirectory('codeestra-config-repo-');
  const home = temporaryDirectory('codeestra-config-home-');
  const assets = temporaryDirectory('codeestra-config-assets-');
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
  const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets,
    CODEESTRA_PI_EXECUTABLE: 'pi-not-installed' };
  expect((await cli(['open', repository, '--no-open'], environment)).exitCode).toBe(0);
  const listed = await cli(['project', 'list'], environment);
  const projects = JSON.parse(listed.stdout) as readonly { id: string }[];
  return { home, projectId: projects[0]?.id as string };
}

describe('codeestra agent config', () => {
  test('resolves global and project scopes and reports each field source', async () => {
    const { home, projectId } = await trustedProject();
    const environment = { CODEESTRA_HOME: home };
    try {
      const initial = JSON.parse((await cli(['agent', 'config', 'get'], environment)).stdout) as
        AgentConfigPayload;
      expect(initial).toMatchObject({
        adapterId: 'pi', projectId: null, global: null, project: null, environment: null,
        effective: { provider: null, model: null, thinkingLevel: null },
        sources: { provider: 'DEFAULT', model: 'DEFAULT', thinkingLevel: 'DEFAULT' },
      });

      // Global defaults: two fields set, so both are recorded and reported as GLOBAL.
      const global = JSON.parse((await cli(['agent', 'config', 'set',
        '--model', 'deepseek-flash', '--thinking', 'high'], environment)).stdout) as AgentConfigPayload;
      expect(global).toMatchObject({
        global: { provider: null, model: 'deepseek-flash', thinkingLevel: 'high' },
        effective: { provider: null, model: 'deepseek-flash', thinkingLevel: 'high' },
        sources: { provider: 'DEFAULT', model: 'GLOBAL', thinkingLevel: 'GLOBAL' },
      });

      // A project override names only the provider; the other fields still come from the global scope.
      const project = JSON.parse((await cli(['agent', 'config', 'set', '--project', projectId,
        '--provider', 'deepseek'], environment)).stdout) as AgentConfigPayload;
      expect(project).toMatchObject({
        projectId,
        project: { provider: 'deepseek', model: null, thinkingLevel: null },
        global: { provider: null, model: 'deepseek-flash', thinkingLevel: 'high' },
        effective: { provider: 'deepseek', model: 'deepseek-flash', thinkingLevel: 'high' },
        sources: { provider: 'PROJECT', model: 'GLOBAL', thinkingLevel: 'GLOBAL' },
      });

      // Clearing the project record restores the global fallback instead of leaking the override.
      const cleared = JSON.parse((await cli(['agent', 'config', 'clear', '--project', projectId],
        environment)).stdout) as AgentConfigPayload & { readonly cleared: boolean };
      expect(cleared.cleared).toBe(true);
      expect(cleared).toMatchObject({
        project: null,
        effective: { provider: null, model: 'deepseek-flash', thinkingLevel: 'high' },
        sources: { provider: 'DEFAULT', model: 'GLOBAL', thinkingLevel: 'GLOBAL' },
      });
    } finally {
      await cli(['stop'], environment);
    }
  }, 90_000);

  test('unsets a single field without disturbing the others', async () => {
    const { home } = await trustedProject();
    const environment = { CODEESTRA_HOME: home };
    try {
      await cli(['agent', 'config', 'set', '--provider', 'deepseek',
        '--model', 'deepseek-flash', '--thinking', 'low'], environment);
      const after = JSON.parse((await cli(['agent', 'config', 'set', '--unset', 'thinking'],
        environment)).stdout) as AgentConfigPayload;
      expect(after).toMatchObject({
        global: { provider: 'deepseek', model: 'deepseek-flash', thinkingLevel: null },
        effective: { provider: 'deepseek', model: 'deepseek-flash', thinkingLevel: null },
        sources: { provider: 'GLOBAL', model: 'GLOBAL', thinkingLevel: 'DEFAULT' },
      });
    } finally {
      await cli(['stop'], environment);
    }
  }, 90_000);

  test('lets the environment override persisted configuration for this Runtime only', async () => {
    const { home } = await trustedProject();
    try {
      const setup = { CODEESTRA_HOME: home };
      await cli(['agent', 'config', 'set', '--model', 'persisted-model'], setup);
      await cli(['stop'], setup);
      // The Runtime inherits the environment of the CLI that starts it, so this models a one-off
      // `CODEESTRA_PI_MODEL=… codeestra …` run without editing persisted configuration.
      const withEnvironment = { CODEESTRA_HOME: home, CODEESTRA_PI_MODEL: 'env-model' };
      const resolved = JSON.parse((await cli(['agent', 'config', 'get'], withEnvironment)).stdout) as
        AgentConfigPayload;
      expect(resolved).toMatchObject({
        environment: { model: 'env-model' },
        effective: { model: 'env-model' },
        sources: { model: 'ENVIRONMENT' },
      });
      await cli(['stop'], withEnvironment);
    } finally {
      await cli(['stop'], { CODEESTRA_HOME: home });
    }
  }, 90_000);

  test('rejects an unusable thinking level and a project scope without a project', async () => {
    const { home } = await trustedProject();
    const environment = { CODEESTRA_HOME: home };
    try {
      const invalidLevel = await cli(['agent', 'config', 'set', '--thinking', 'extreme'], environment);
      expect(invalidLevel.exitCode).toBe(1);
      expect(invalidLevel.stderr).toMatch(/INVALID_REQUEST/);
      // The contract cannot express "PROJECT requires projectId", so the Runtime must refuse it.
      const managed = await cli(['agent', 'config', 'set', '--project',
        '99999999-9999-4999-8999-999999999999', '--model', 'x'], environment);
      expect(managed.exitCode).toBe(1);
      expect(managed.stderr).toContain('Trusted project was not found');
      expect(JSON.parse((await cli(['agent', 'config', 'get'], environment)).stdout))
        .toMatchObject({ global: null });
    } finally {
      await cli(['stop'], environment);
    }
  }, 90_000);
});
