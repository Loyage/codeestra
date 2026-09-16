import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
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
  // FOUNDATION-057: the shared runner refuses a non-temporary CODEESTRA_HOME and registers the
  // home, so teardown stops the Runtime even when an assertion fails before the test's own stop.
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Open Test', GIT_AUTHOR_EMAIL: 'open@example.invalid',
      GIT_COMMITTER_NAME: 'Open Test', GIT_COMMITTER_EMAIL: 'open@example.invalid' } });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

/**
 * The repository that owns the policy is the one under test, so this exercises the same commands a
 * person runs: the fixture carries a policy at its main ref and the trusted project must appear in
 * `project list` with the preselection the UI reads out of the URL fragment.
 */
async function fixture(): Promise<{ repository: string; devRepo: string; home: string;
  assets: string }> {
  const repository = temporaryDirectory('codeestra-open-repo-');
  const home = temporaryDirectory('codeestra-open-home-');
  const assets = temporaryDirectory('codeestra-open-assets-');
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1,
    commands: [{ id: 'check', argv: ['bun', 'run', 'check'], cwd: '.', timeoutSeconds: 60 }],
  }, null, 2));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  // ADR-0009: the long-lived dev branch is the baseline every workspace is created from.
  await git(repository, ['branch', 'dev']);
  // ADR-0056: every dev fact comes from a second clone of the same origin that sits on
  // `dev`; the project is trusted with it explicitly.
  const devRepo = await provisionDevClone({ repository: repository });
  return { repository, devRepo, home, assets };
}

describe('codeestra open', () => {
  test('trusts the repository and points the UI at that project', async () => {
    const { repository, devRepo, home, assets } = await fixture();
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets };

    const opened = await cli(['open', repository, '--dev-repo', devRepo, '--no-open'], environment);
    expect(opened.stderr).toContain('FULL permission mode: registering this project without confirmation');
    expect(opened.stderr).toContain('Verification policy');
    expect(opened.stderr).toContain('check: bun run check');
    expect(opened.exitCode).toBe(0);

    const listed = await cli(['project', 'list'], environment);
    const projects = JSON.parse(listed.stdout) as readonly { id: string; repoRoot: string }[];
    // macOS temp directories sit behind a symlink, and the Runtime records the canonical path.
    expect(projects.map((project) => project.repoRoot)).toEqual([await realpath(repository)]);

    // The UI reads both values out of the fragment; the token must never move into the query
    // string, which the server would receive.
    const url = new URL(opened.stdout.trim());
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(fragment.get('token')).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(fragment.get('project')).toBe(projects[0]?.id as string);
    expect(url.search).toBe('');
    expect(url.hostname).toBe('127.0.0.1');

    const stopped = await cli(['stop'], environment);
    expect(stopped.exitCode).toBe(0);
  }, 60_000);

  test('trusts a project without a dev clone and records no dev facts for it (ADR-0060)', async () => {
    // ADR-0060 made the dev clone optional: a project without one is managed — its Task baselines
    // come from its own folder's checked out branch — so the trust succeeds and records no path.
    const { repository, home, assets } = await fixture();
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets };
    const trusted = await cli(['project', 'trust', repository], environment);
    expect(trusted.exitCode).toBe(0);
    const inspected = await cli(['project', 'inspect', repository], environment);
    expect(inspected.exitCode).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({ devRepoPath: null, devCommit: null });
    // The report says which of the two baselines applies instead of warning about a broken project.
    expect(inspected.stderr).toContain('未记录（managed');

    // `--dev-repo none` states the same fact explicitly and is not an error either; a trust that
    // omits the flag re-reads what was recorded instead of silently clearing it.
    const cleared = await cli(['project', 'trust', repository, '--dev-repo', 'none'], environment);
    expect(cleared.exitCode).toBe(0);
    const listed = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
      readonly { readonly devRepoPath: string | null }[];
    expect(listed.length).toBe(1);
    expect(listed[0]?.devRepoPath).toBeNull();
    await cli(['stop'], environment);
  }, 60_000);

  test('inspects the dev baseline from the dev clone and reports the local ref retirement evidence',
    async () => {
      const { repository, devRepo, home, assets } = await fixture();
      const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets };
      const inspected = await cli(['project', 'inspect', repository, '--dev-repo', devRepo],
        environment);
      expect(inspected.exitCode).toBe(0);
      // The baseline is the dev clone's `dev`, and the inspected checkout's own `dev` ref is reported
      // as transitional evidence — never as the baseline (ADR-0048 D04 / ADR-0056).
      expect(inspected.stderr).toContain('dev baseline (from the dev clone): refs/heads/dev · ');
      expect(inspected.stderr).toContain('transitional local refs/heads/dev in this checkout: present at');
      expect(inspected.stderr).toContain('no trusted project lacks a dev clone');
      const report = JSON.parse(inspected.stdout) as { readonly devCommit: string | null };
      expect(report.devCommit).toMatch(/^[0-9a-f]{40}$/);

      // Once a project is trusted, its own `dev` ref is no longer anything the Runtime reads, and the
      // report says so: this is the read-only proof a human uses before deleting it by hand.
      await cli(['open', repository, '--dev-repo', devRepo, '--no-open'], environment);
      const again = await cli(['project', 'inspect', repository, '--dev-repo', devRepo], environment);
      expect(again.stderr).toContain('no trusted project lacks a dev clone');
      await cli(['stop'], environment);
    }, 60_000);

  test('opening another worktree of an already trusted repository is idempotent', async () => {
    const { repository, devRepo, home, assets } = await fixture();
    const alternate = `${repository}-dev-worktree`;
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets };
    try {
      expect((await cli(['open', repository, '--dev-repo', devRepo, '--yes', '--no-open'], environment)).exitCode).toBe(0);
      await git(repository, ['worktree', 'add', '-q', '-b', 'alternate', alternate, 'main']);
      const opened = await cli(['open', alternate, '--no-open'], environment);
      expect(opened.exitCode).toBe(0);
      expect(opened.stderr).toContain('Already trusted');
      expect(opened.stdout).toContain('project=');
      const listed = await cli(['project', 'list'], environment);
      const projects = JSON.parse(listed.stdout) as readonly { readonly repoRoot: string }[];
      expect(projects).toHaveLength(1);
      expect(projects[0]?.repoRoot).toBe(await realpath(repository));
    } finally {
      await git(repository, ['worktree', 'remove', '-f', alternate]).catch(() => {});
      await cli(['stop'], environment);
    }
  }, 60_000);

  test('does not ask for a second confirmation while the confirmed policy still matches', async () => {
    const { repository, devRepo, home, assets } = await fixture();
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets };
    expect((await cli(['open', repository, '--dev-repo', devRepo, '--yes', '--no-open'], environment)).exitCode).toBe(0);

    // stdin is /dev/null: anything that still asked for TRUST would fail instead of reopening.
    const again = await cli(['open', repository, '--dev-repo', devRepo, '--no-open'], environment);
    expect(again.exitCode).toBe(0);
    expect(again.stderr).toContain('Already trusted');
    expect(again.stdout).toContain('project=');
    await cli(['stop'], environment);
  }, 60_000);

  test('does not ask again when the main ref moves without touching the policy', async () => {
    const { repository, devRepo, home, assets } = await fixture();
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets };
    expect((await cli(['open', repository, '--dev-repo', devRepo, '--yes', '--no-open'], environment)).exitCode).toBe(0);

    // Ordinary development: commit code to the main ref, which is not a policy change.
    await Bun.write(join(repository, 'README.md'), 'fixture\nsecond line\n');
    await git(repository, ['add', '.']);
    await git(repository, ['commit', '-q', '-m', 'develop']);

    const again = await cli(['open', repository, '--dev-repo', devRepo, '--no-open'], environment);
    expect(again.exitCode).toBe(0);
    expect(again.stderr).toContain('Already trusted');
    await cli(['stop'], environment);
  }, 60_000);

  test('asks again once the policy at the main ref changes', async () => {
    const { repository, devRepo, home, assets } = await fixture();
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets };
    expect((await cli(['permission', 'set', 'strict'], environment)).exitCode).toBe(0);
    expect((await cli(['open', repository, '--dev-repo', devRepo, '--yes', '--no-open'], environment)).exitCode).toBe(0);

    await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
      version: 1,
      commands: [{ id: 'check', argv: ['bun', 'run', 'typecheck'], cwd: '.', timeoutSeconds: 60 }],
    }, null, 2));
    await git(repository, ['add', '.']);
    await git(repository, ['commit', '-q', '-m', 'change the policy']);

    const stale = await cli(['open', repository, '--dev-repo', devRepo, '--no-open'], environment);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain('no longer matches this repository');
    expect(stale.stderr).toContain('Project trust was not confirmed');
    await cli(['stop'], environment);
  }, 60_000);

  test('refuses to trust without the confirmation gate', async () => {
    const { repository, devRepo, home, assets } = await fixture();
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets };
    expect((await cli(['permission', 'set', 'strict'], environment)).exitCode).toBe(0);
    // Strict mode preserves the opt-in confirmation path; stdin is /dev/null so it must fail.
    const refused = await runCli(['open', repository, '--dev-repo', devRepo, '--no-open'], environment,
      { entry: cliEntry });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('Project trust was not confirmed');
    const listed = await cli(['project', 'list'], environment);
    expect(JSON.parse(listed.stdout)).toEqual([]);
    await cli(['stop'], environment);
  }, 60_000);
});
