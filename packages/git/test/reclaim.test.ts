import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  inspectOwnedPath,
  inspectOwnedWorktreeRegistration,
  inspectWorktreeState,
  removeOwnedWorktree,
} from '../src/reclaim.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function run(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(' ')}: ${stderr.trim()}`);
  return stdout.trim();
}

async function gitSucceeds(cwd: string, args: readonly string[]): Promise<boolean> {
  const process = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'ignore', stderr: 'ignore' });
  return (await process.exited) === 0;
}

const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000002';
const verificationId = '30000000-0000-4000-8000-000000000003';

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly worktreesRoot: string;
  readonly verificationsRoot: string;
  readonly base: string;
  readonly worktreePath: string;
  readonly branchRef: string;
}

/** Temporary repository plus one registered Task worktree inside a Runtime-owned root. */
async function repository(): Promise<Fixture> {
  const repo = mkdtempSync(join(tmpdir(), 'codeestra-reclaim-git-'));
  const home = mkdtempSync(join(tmpdir(), 'codeestra-reclaim-home-'));
  directories.push(repo, home);
  await run(repo, ['init', '-b', 'main']);
  await run(repo, ['config', 'user.name', 'Test']);
  await run(repo, ['config', 'user.email', 'test@example.invalid']);
  await Bun.write(join(repo, 'a.txt'), 'a\n');
  await run(repo, ['add', '-A']);
  await run(repo, ['commit', '-m', 'initial']);
  const base = await run(repo, ['rev-parse', 'HEAD']);
  // The OS temp directory may sit behind a symlink; the owned root is recorded canonically.
  const canonicalHome = realpathSync(home);
  const worktreesRoot = join(canonicalHome, 'worktrees');
  const verificationsRoot = join(canonicalHome, 'verifications');
  const worktreePath = join(worktreesRoot, projectId, taskId);
  const branchRef = `refs/heads/task/${taskId}`;
  mkdirSync(dirname(worktreePath), { recursive: true });
  await run(repo, ['worktree', 'add', '-b', `task/${taskId}`, worktreePath, base]);
  return { repo, home: canonicalHome, worktreesRoot, verificationsRoot, base, worktreePath, branchRef };
}

async function detachedCopy(fixture: Fixture): Promise<{ path: string; copyPath: string }> {
  const copyPath = join(fixture.verificationsRoot, projectId, verificationId);
  mkdirSync(dirname(copyPath), { recursive: true });
  await run(fixture.repo, ['worktree', 'add', '--detach', copyPath, fixture.base]);
  return { path: copyPath, copyPath };
}

describe('owned path inspection', () => {
  test('accepts a path inside the owned root and resolves it canonically', async () => {
    const fixture = await repository();
    const owned = await inspectOwnedPath({
      ownedRoot: fixture.worktreesRoot, path: fixture.worktreePath,
    });
    expect(owned).toMatchObject({ exists: true, symlink: false, insideOwnedRoot: true });
    expect(owned.canonicalPath).toBe(fixture.worktreePath);
  });

  test('reports a resource path that is a symlink instead of following it', async () => {
    const fixture = await repository();
    const escape = join(fixture.worktreesRoot, projectId, 'escape');
    symlinkSync(fixture.repo, escape);
    const owned = await inspectOwnedPath({ ownedRoot: fixture.worktreesRoot, path: escape });
    expect(owned).toMatchObject({ exists: true, symlink: true, insideOwnedRoot: false });
    expect(owned.canonicalPath).toBe(realpathSync(fixture.repo));
  });

  test('matches a registered worktree by path and reports its branch', async () => {
    const fixture = await repository();
    const registration = await inspectOwnedWorktreeRegistration({
      repositoryRoot: fixture.repo, path: fixture.worktreePath,
    });
    expect(registration).toMatchObject({
      registered: true, branchRef: fixture.branchRef, detached: false, pathExists: true,
    });
    expect(registration.headCommit).toBe(fixture.base);
  });

  test('reports an unregistered directory as such', async () => {
    const fixture = await repository();
    const foreign = join(fixture.worktreesRoot, projectId, verificationId);
    mkdirSync(foreign, { recursive: true });
    const registration = await inspectOwnedWorktreeRegistration({
      repositoryRoot: fixture.repo, path: foreign,
    });
    expect(registration.registered).toBe(false);
    expect(registration.pathExists).toBe(true);
  });

  test('rejects a relative owned root or path', async () => {
    await expect(inspectOwnedPath({ ownedRoot: 'relative', path: '/tmp/x' }))
      .rejects.toMatchObject({ code: 'UNSAFE_CHECKOUT' });
  });
});

describe('removing an owned worktree', () => {
  test('removes the checkout, prunes its registration and keeps the branch', async () => {
    const fixture = await repository();
    const removal = await removeOwnedWorktree({
      repositoryRoot: fixture.repo,
      ownedRoot: fixture.worktreesRoot,
      path: fixture.worktreePath,
      expectedBranchRef: fixture.branchRef,
    });
    expect(removal).toMatchObject({ outcome: 'REMOVED', reasonCode: 'REMOVED' });
    expect(existsSync(fixture.worktreePath)).toBe(false);
    expect(await gitSucceeds(fixture.repo, ['worktree', 'list', '--porcelain'])).toBe(true);
    const list = await run(fixture.repo, ['worktree', 'list', '--porcelain']);
    expect(list).not.toContain(fixture.worktreePath);
    // A commit exists on the branch, so deleting it would destroy work; it must still be there.
    expect(await run(fixture.repo, ['rev-parse', '--verify', fixture.branchRef])).toBe(fixture.base);
  });

  test('is idempotent: a second removal reports the resource already absent', async () => {
    const fixture = await repository();
    const first = await removeOwnedWorktree({
      repositoryRoot: fixture.repo, ownedRoot: fixture.worktreesRoot, path: fixture.worktreePath,
      expectedBranchRef: fixture.branchRef,
    });
    expect(first.outcome).toBe('REMOVED');
    const second = await removeOwnedWorktree({
      repositoryRoot: fixture.repo, ownedRoot: fixture.worktreesRoot, path: fixture.worktreePath,
      expectedBranchRef: fixture.branchRef,
    });
    expect(second).toMatchObject({ outcome: 'ALREADY_ABSENT' });
  });

  test('prunes a stale registration when the directory was already deleted', async () => {
    const fixture = await repository();
    // A crash can leave the registration behind after the directory is gone.
    rmSync(fixture.worktreePath, { recursive: true, force: true });
    const removal = await removeOwnedWorktree({
      repositoryRoot: fixture.repo, ownedRoot: fixture.worktreesRoot, path: fixture.worktreePath,
      expectedBranchRef: fixture.branchRef,
    });
    expect(removal).toMatchObject({ outcome: 'REMOVED', reasonCode: 'REGISTRATION_PRUNED' });
    const list = await run(fixture.repo, ['worktree', 'list', '--porcelain']);
    expect(list).not.toContain(fixture.worktreePath);
  });

  test('refuses a path outside the Runtime-owned root', async () => {
    const fixture = await repository();
    const foreign = mkdtempSync(join(tmpdir(), 'codeestra-reclaim-foreign-'));
    directories.push(foreign);
    await Bun.write(join(foreign, 'user.txt'), 'do not delete\n');
    const removal = await removeOwnedWorktree({
      repositoryRoot: fixture.repo, ownedRoot: fixture.worktreesRoot, path: foreign,
    });
    expect(removal).toMatchObject({ outcome: 'REFUSED', reasonCode: 'PATH_OUTSIDE_OWNED_ROOT' });
    expect(await Bun.file(join(foreign, 'user.txt')).exists()).toBe(true);
  });

  test('refuses a symlink instead of removing what it points at', async () => {
    const fixture = await repository();
    const escape = join(fixture.worktreesRoot, projectId, 'escape');
    symlinkSync(fixture.repo, escape);
    const removal = await removeOwnedWorktree({
      repositoryRoot: fixture.repo, ownedRoot: fixture.worktreesRoot, path: escape,
    });
    expect(removal).toMatchObject({ outcome: 'REFUSED', reasonCode: 'SYMLINK_ESCAPE' });
    expect(await Bun.file(join(fixture.repo, 'a.txt')).exists()).toBe(true);
  });

  test('refuses an unregistered directory inside the Runtime root', async () => {
    const fixture = await repository();
    const stranger = join(fixture.worktreesRoot, projectId, verificationId);
    mkdirSync(stranger, { recursive: true });
    await Bun.write(join(stranger, 'keep.txt'), 'not a worktree\n');
    const removal = await removeOwnedWorktree({
      repositoryRoot: fixture.repo, ownedRoot: fixture.worktreesRoot, path: stranger,
    });
    expect(removal).toMatchObject({ outcome: 'REFUSED', reasonCode: 'UNREGISTERED_DIRECTORY' });
    expect(await Bun.file(join(stranger, 'keep.txt')).exists()).toBe(true);
  });

  test('refuses a worktree that is on another branch than the record attests', async () => {
    const fixture = await repository();
    const removal = await removeOwnedWorktree({
      repositoryRoot: fixture.repo,
      ownedRoot: fixture.worktreesRoot,
      path: fixture.worktreePath,
      expectedBranchRef: 'refs/heads/task/00000000-0000-4000-8000-000000000000',
    });
    expect(removal).toMatchObject({ outcome: 'REFUSED', reasonCode: 'BRANCH_MISMATCH' });
    expect(existsSync(fixture.worktreePath)).toBe(true);
  });

  test('removes a detached copy only at the commit its record attests', async () => {
    const fixture = await repository();
    const copy = await detachedCopy(fixture);
    const mismatch = await removeOwnedWorktree({
      repositoryRoot: fixture.repo,
      ownedRoot: fixture.verificationsRoot,
      path: copy.path,
      expectedDetachedCommit: '0'.repeat(40),
    });
    expect(mismatch).toMatchObject({ outcome: 'REFUSED', reasonCode: 'HEAD_MISMATCH' });
    expect(existsSync(copy.path)).toBe(true);
    const removal = await removeOwnedWorktree({
      repositoryRoot: fixture.repo,
      ownedRoot: fixture.verificationsRoot,
      path: copy.path,
      expectedDetachedCommit: fixture.base,
    });
    expect(removal.outcome).toBe('REMOVED');
    expect(existsSync(copy.path)).toBe(false);
  });
});

describe('worktree state reading', () => {
  test('reports uncommitted work so a failure scene is not mistaken for garbage', async () => {
    const fixture = await repository();
    await Bun.write(join(fixture.worktreePath, 'a.txt'), 'changed\n');
    await Bun.write(join(fixture.worktreePath, 'untracked.txt'), 'new\n');
    const state = await inspectWorktreeState({ path: fixture.worktreePath });
    expect(state).toMatchObject({ available: true, clean: false });
    expect(state.trackedModifications).toEqual(['a.txt']);
    expect(state.untrackedFiles).toEqual(['untracked.txt']);
  });

  test('treats a missing path as not clean rather than as an empty worktree', async () => {
    const fixture = await repository();
    rmSync(fixture.worktreePath, { recursive: true, force: true });
    const state = await inspectWorktreeState({ path: fixture.worktreePath });
    expect(state).toMatchObject({ available: false, clean: false, headCommit: null });
  });
});
