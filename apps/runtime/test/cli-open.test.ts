import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTemporaryDirectories, registerTemporaryDirectory } from './support/agent-fixture.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(() => { cleanupTemporaryDirectories(); });

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function run(command: readonly string[], args: readonly string[], environment: Record<string, string>) {
  const child = Bun.spawn({
    cmd: [command[0] as string, ...command.slice(1), ...args],
    cwd: repositoryRoot,
    env: { ...Bun.env, ...environment, no_proxy: '127.0.0.1,localhost' },
    // stdin is /dev/null so an unanswered trust prompt fails immediately instead of hanging.
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function cli(args: readonly string[], environment: Record<string, string>) {
  return run([process.execPath, cliEntry], args, environment);
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
async function fixture(): Promise<{ repository: string; home: string; assets: string }> {
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
  return { repository, home, assets };
}

describe('codeestra open', () => {
  test('trusts the repository and points the UI at that project', async () => {
    const { repository, home, assets } = await fixture();
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets };

    const opened = await cli(['open', repository, '--yes', '--no-open'], environment);
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

  test('refuses to trust without the confirmation gate', async () => {
    const { repository, home, assets } = await fixture();
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets };
    // stdin is /dev/null, so the prompt cannot be answered: trust must not happen by default.
    const refused = await run([process.execPath, cliEntry], ['open', repository, '--no-open'],
      environment);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('Project trust was not confirmed');
    const listed = await cli(['project', 'list'], environment);
    expect(JSON.parse(listed.stdout)).toEqual([]);
    await cli(['stop'], environment);
  }, 60_000);
});
