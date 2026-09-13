import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifySensitivePath,
  classifySensitivePaths,
  createResultCommit,
  inspectChangeSet,
  inspectResultCommit,
  resolveCommitIdentity,
  sameChangeSetEntries,
  stageResultChangeSet,
} from '../src/index.js';

const repositories: string[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) rmSync(repository, { recursive: true, force: true });
});

async function run(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(' ')}: ${stderr}`);
  return stdout.trim();
}

async function repository(): Promise<{ repo: string; base: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'codeestra-result-git-'));
  repositories.push(repo);
  await run(repo, ['init', '-b', 'main']);
  // Repository-local identity only: the fixture never touches global Git config.
  await run(repo, ['config', 'user.name', 'Test']);
  await run(repo, ['config', 'user.email', 'test@example.invalid']);
  await Bun.write(join(repo, 'a.txt'), 'a\n');
  await Bun.write(join(repo, 'b.txt'), 'b\n');
  await run(repo, ['add', '-A']);
  await run(repo, ['commit', '-m', 'initial']);
  const base = await run(repo, ['rev-parse', 'HEAD']);
  return { repo, base };
}

describe('sensitive path policy', () => {
  test('denies secrets, runtime data, and escaping paths, and allows ordinary sources', () => {
    expect(classifySensitivePath('src/index.ts')).toBeNull();
    expect(classifySensitivePath('.gitignore')).toBeNull();
    expect(classifySensitivePath('docs/notes.md')).toBeNull();
    expect(classifySensitivePath('.env')).toMatchObject({ reason: 'environment file' });
    expect(classifySensitivePath('config/.env.local')).toMatchObject({ reason: 'environment file' });
    expect(classifySensitivePath('deploy/server.pem')).toMatchObject({ reason: 'secret-bearing file (.pem)' });
    expect(classifySensitivePath('.ssh/id_rsa')).toMatchObject({ reason: 'SSH private key' });
    expect(classifySensitivePath('state/runtime.sqlite-wal'))
      .toMatchObject({ reason: 'Codeestra runtime database' });
    expect(classifySensitivePath('pi-sessions/session.json'))
      .toMatchObject({ reason: 'Codeestra runtime data directory' });
    expect(classifySensitivePath('../outside.txt')).toMatchObject({ reason: 'change path escapes the workspace' });
    expect(classifySensitivePath('/etc/passwd')).toMatchObject({ reason: 'change path is not workspace-relative' });
    expect(classifySensitivePaths(['src/a.ts', '.env'])).toEqual([
      { path: '.env', reason: 'environment file' },
    ]);
  });
});

describe('change set inspection', () => {
  test('reports tracked changes, renames, and untracked files with a content-bound fingerprint', async () => {
    const { repo, base } = await repository();
    await Bun.write(join(repo, 'a.txt'), 'a changed\n');
    await run(repo, ['rm', 'b.txt']);
    await Bun.write(join(repo, 'new.txt'), 'new\n');
    await Bun.write(join(repo, 'sp ace.txt'), 'space\n');

    const first = await inspectChangeSet({ workspacePath: repo, baseCommit: base });
    expect(first.headCommit).toBe(base);
    expect(first.entries).toEqual([
      { status: 'MODIFIED', path: 'a.txt' },
      { status: 'DELETED', path: 'b.txt' },
      { status: 'ADDED', path: 'new.txt' },
      { status: 'ADDED', path: 'sp ace.txt' },
    ]);
    expect(first.treeFingerprint).toMatch(/^[0-9a-f]{64}$/);

    const repeated = await inspectChangeSet({ workspacePath: repo, baseCommit: base });
    expect(repeated.treeFingerprint).toBe(first.treeFingerprint);

    // Same status list, different content: the fingerprint must move.
    await Bun.write(join(repo, 'new.txt'), 'different\n');
    const changedContent = await inspectChangeSet({ workspacePath: repo, baseCommit: base });
    expect(changedContent.treeFingerprint).not.toBe(first.treeFingerprint);

    // A commit that does not change the diff still moves HEAD, so the fingerprint moves.
    await run(repo, ['add', '-A']);
    await run(repo, ['commit', '--allow-empty', '-m', 'empty']);
    const movedHead = await inspectChangeSet({ workspacePath: repo, baseCommit: base });
    expect(movedHead.headCommit).not.toBe(base);
    expect(movedHead.treeFingerprint).not.toBe(changedContent.treeFingerprint);
  });

  test('detects renames as renames', async () => {
    const { repo, base } = await repository();
    await run(repo, ['mv', 'a.txt', 'renamed.txt']);
    const changeSet = await inspectChangeSet({ workspacePath: repo, baseCommit: base });
    expect(changeSet.entries).toEqual([
      { status: 'RENAMED', path: 'renamed.txt', previousPath: 'a.txt' },
    ]);
  });
});

describe('identity resolution', () => {
  test('reads the repository identity and refuses a repository without one', async () => {
    const { repo } = await repository();
    expect(await resolveCommitIdentity(repo)).toEqual({ name: 'Test', email: 'test@example.invalid' });

    const anonymous = mkdtempSync(join(tmpdir(), 'codeestra-anonymous-'));
    repositories.push(anonymous);
    await run(anonymous, ['init', '-b', 'main']);
    // Explicitly empty identity: the same branch a machine without a global identity hits,
    // tested without touching the real global Git config.
    await run(anonymous, ['config', 'user.name', '']);
    await run(anonymous, ['config', 'user.email', '']);
    await expect(resolveCommitIdentity(anonymous)).rejects.toMatchObject({
      code: 'IDENTITY_NOT_CONFIGURED',
    });
  });
});

describe('result commit creation', () => {
  test('runs repository hooks, never uses --no-verify, and keeps the base as parent', async () => {
    const { repo, base } = await repository();
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    await Bun.write(hook, '#!/bin/sh\ntouch hook-ran\n');
    chmodSync(hook, 0o755);
    await Bun.write(join(repo, 'a.txt'), 'a changed\n');
    const changeSet = await inspectChangeSet({ workspacePath: repo, baseCommit: base });
    await stageResultChangeSet(repo);
    const outcome = await createResultCommit({ workspacePath: repo, expectedHead: base, message: 'Codeestra result\n' });
    expect(outcome).toEqual({ commitExists: true });
    expect(await Bun.file(join(repo, 'hook-ran')).exists()).toBe(true);
    const inspected = await inspectResultCommit({
      workspacePath: repo,
      expectedHead: base,
      expectedMessage: 'Codeestra result',
      expectedEntries: changeSet.entries,
    });
    expect(inspected).toMatchObject({ parent: base, message: 'Codeestra result' });
    expect(inspected?.tree).toMatch(/^[0-9a-f]{40}$/);
  });

  test('reports a failed hook as no commit while preserving the staged worktree', async () => {
    const { repo, base } = await repository();
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    await Bun.write(hook, '#!/bin/sh\necho "hook refused" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    await Bun.write(join(repo, 'a.txt'), 'a changed\n');
    await stageResultChangeSet(repo);
    const outcome = await createResultCommit({ workspacePath: repo, expectedHead: base, message: 'Codeestra result\n' });
    expect(outcome.commitExists).toBe(false);
    expect(outcome.detail).toContain('hook refused');
    expect(await run(repo, ['rev-parse', 'HEAD'])).toBe(base);
    expect(await run(repo, ['diff', '--cached', '--name-only'])).toBe('a.txt');
    expect(await inspectResultCommit({
      workspacePath: repo, expectedHead: base, expectedMessage: 'Codeestra result',
    })).toBeNull();
  });

  test('rejects a HEAD that is not the authorized one', async () => {
    const { repo, base } = await repository();
    await Bun.write(join(repo, 'a.txt'), 'a changed\n');
    await stageResultChangeSet(repo);
    await createResultCommit({ workspacePath: repo, expectedHead: base, message: 'Codeestra result\n' });
    expect(await inspectResultCommit({
      workspacePath: repo, expectedHead: base, expectedMessage: 'A different message',
    })).toBeNull();
  });

  test('compares entry lists without depending on input order', () => {
    const left = [
      { status: 'MODIFIED' as const, path: 'b.txt' },
      { status: 'ADDED' as const, path: 'a.txt' },
    ];
    const right = [
      { status: 'ADDED' as const, path: 'a.txt' },
      { status: 'MODIFIED' as const, path: 'b.txt' },
    ];
    expect(sameChangeSetEntries(left, right)).toBe(true);
    expect(sameChangeSetEntries(left, [{ status: 'ADDED', path: 'a.txt' }])).toBe(false);
  });
});
