import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTemporaryDirectories, registerTemporaryDirectory } from './support/agent-fixture.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => {
  // The Runtime is a daemon: without an explicit stop, each test would leave one running against a
  // temporary home that is about to be deleted. Stop them before the directories go away.
  for (const environment of startedRuntimes.splice(0)) await cli(['stop'], environment);
  cleanupTemporaryDirectories();
});

/** Every environment whose Runtime was started, so `afterEach` can always stop it. */
const startedRuntimes: Record<string, string>[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  const child = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd: repositoryRoot,
    env: { ...Bun.env, ...environment, no_proxy: '127.0.0.1,localhost' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn({
    cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Task Create Test',
      GIT_AUTHOR_EMAIL: 'task-create@example.invalid', GIT_COMMITTER_NAME: 'Task Create Test',
      GIT_COMMITTER_EMAIL: 'task-create@example.invalid' },
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

interface TaskCreateView {
  readonly id: string;
  readonly kind: string;
  readonly currentRevision: {
    readonly specification: string;
    readonly constraints: readonly { readonly id: string; readonly text: string }[];
  };
}

/**
 * A trusted temporary project on an isolated Runtime home. `task create` needs a Project ID, so the
 * project is registered through the same `open` path a user would take; no Agent or provider is
 * involved anywhere in this file.
 */
async function trustedProject(): Promise<{ environment: Record<string, string>; projectId: string }> {
  const repository = temporaryDirectory('codeestra-task-create-repo-');
  const home = temporaryDirectory('codeestra-task-create-home-');
  const assets = temporaryDirectory('codeestra-task-create-assets-');
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

  const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets };
  startedRuntimes.push(environment);
  const opened = await cli(['open', repository, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  return { environment, projectId: projects[0]?.id as string };
}

describe('codeestra task create', () => {
  test('carries repeatable constraints and an explicit kind into the revision', async () => {
    const { environment, projectId } = await trustedProject();
    const created = await cli(['task', 'create', projectId, 'Fix the parser',
      '--constraint', '不要改动 apps/ui 之外的文件',
      '--constraint', '保持现有 CLI 输出格式',
      '--kind', 'DEVELOPMENT'], environment);
    expect(created.exitCode).toBe(0);
    const view = JSON.parse(created.stdout) as TaskCreateView;
    expect(view.kind).toBe('DEVELOPMENT');
    expect(view.currentRevision.specification).toBe('Fix the parser');
    expect(view.currentRevision.constraints.map((constraint) => constraint.text))
      .toEqual(['不要改动 apps/ui 之外的文件', '保持现有 CLI 输出格式']);
    // Constraint IDs are the stable identity inside one revision; the Runtime rejects duplicates.
    const identifiers = view.currentRevision.constraints.map((constraint) => constraint.id);
    expect(new Set(identifiers).size).toBe(2);
    expect(identifiers.every((id) => id.trim().length > 0)).toBe(true);

    // The constraint is part of the stored revision, not just an echo of the command.
    const listed = JSON.parse((await cli(['task', 'list', projectId], environment)).stdout) as
      readonly TaskCreateView[];
    expect(listed[0]?.currentRevision.constraints.length).toBe(2);
  });

  test('keeps the unquoted multi-token specification working with no flags', async () => {
    const { environment, projectId } = await trustedProject();
    const created = await cli(['task', 'create', projectId, 'fix', 'the', 'bug'], environment);
    expect(created.exitCode).toBe(0);
    const view = JSON.parse(created.stdout) as TaskCreateView;
    expect(view.currentRevision.specification).toBe('fix the bug');
    expect(view.currentRevision.constraints).toEqual([]);
  });

  test('refuses SELF with a stated reason instead of creating a development task', async () => {
    const { environment, projectId } = await trustedProject();
    const refused = await cli(['task', 'create', projectId, 'Self modify', '--kind', 'SELF'],
      environment);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('TASK_KIND_UNSUPPORTED');
    // Nothing may be created: silently falling back to DEVELOPMENT would hide the missing capability.
    expect(JSON.parse((await cli(['task', 'list', projectId], environment)).stdout)).toEqual([]);
  });

  test('rejects an unknown flag and a blank constraint without creating anything', async () => {
    const { environment, projectId } = await trustedProject();
    const unknown = await cli(['task', 'create', projectId, 'Spec', '--nope'], environment);
    expect(unknown.exitCode).toBe(2);
    const blank = await cli(['task', 'create', projectId, 'Spec', '--constraint', '   '], environment);
    expect(blank.exitCode).toBe(2);
    const missingValue = await cli(['task', 'create', projectId, 'Spec', '--constraint'], environment);
    expect(missingValue.exitCode).toBe(2);
    expect(JSON.parse((await cli(['task', 'list', projectId], environment)).stdout)).toEqual([]);
  });
});
