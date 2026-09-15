import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeOwnedWorktree } from '../src/reclaim.js';
import {
  inspectOwnedWorktreeRebuild,
  inspectTaskBranch,
  rebuildOwnedWorktree,
} from '../src/rebuild.js';

/**
 * Re-creating a Task worktree from the branch a reclamation kept (FOUNDATION-068 / ADR-0042).
 *
 * Every case runs against a real temporary repository: the point of this module is what Git and the
 * filesystem actually say, so a fake would prove nothing. The refusals matter as much as the success
 * — an occupied path, an unrelated branch, a branch checked out elsewhere, and a missing branch must
 * all end with *no* second worktree, *no* deletion and *no* moved branch.
 */

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

const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000002';

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly worktreesRoot: string;
  readonly base: string;
  readonly path: string;
  readonly branchRef: string;
}

/** Temporary repository, one Task worktree, and the reclamation that removes the directory. */
async function reclaimedRepository(): Promise<Fixture> {
  const repo = mkdtempSync(join(tmpdir(), 'codeestra-rebuild-git-'));
  const home = mkdtempSync(join(tmpdir(), 'codeestra-rebuild-home-'));
  directories.push(repo, home);
  await run(repo, ['init', '-q', '-b', 'main']);
  await run(repo, ['config', 'user.name', 'Test']);
  await run(repo, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  await run(repo, ['add', '-A']);
  await run(repo, ['commit', '-q', '-m', 'initial']);
  const base = await run(repo, ['rev-parse', 'HEAD']);
  // The OS temp directory may sit behind a symlink; the owned root is recorded canonically.
  const canonicalHome = realpathSync(home);
  const worktreesRoot = join(canonicalHome, 'worktrees');
  const path = join(worktreesRoot, projectId, taskId);
  const branchRef = `refs/heads/task/${taskId}`;
  mkdirSync(dirname(path), { recursive: true });
  await run(repo, ['worktree', 'add', '-b', `task/${taskId}`, path, base]);
  return { repo, home: canonicalHome, worktreesRoot, base, path, branchRef };
}

/** The same fixture, with the recorded worktree reclaimed the way `reclaim apply` removes it. */
async function reclaimed(): Promise<Fixture> {
  const fixture = await reclaimedRepository();
  const removal = await removeOwnedWorktree({
    repositoryRoot: fixture.repo,
    ownedRoot: fixture.worktreesRoot,
    path: fixture.path,
    expectedBranchRef: fixture.branchRef,
  });
  expect(removal.outcome).toBe('REMOVED');
  expect(existsSync(fixture.path)).toBe(false);
  return fixture;
}

function rebuild(fixture: Fixture, path = fixture.path) {
  return rebuildOwnedWorktree({
    repositoryRoot: fixture.repo,
    ownedRoot: fixture.worktreesRoot,
    projectId,
    taskId,
    path,
    branchRef: fixture.branchRef,
    baseCommit: fixture.base,
  });
}

async function registrations(repo: string): Promise<readonly string[]> {
  const output = await run(repo, ['worktree', 'list', '--porcelain']);
  return output.split('\n').filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length)).sort();
}

describe('rebuilding a reclaimed Task worktree', () => {
  test('re-creates the worktree from the surviving branch, including its committed work', async () => {
    const fixture = await reclaimedRepository();
    // A failed attempt that already committed must not lose that commit to a rebuild.
    writeFileSync(join(fixture.path, 'b.txt'), 'b\n');
    await run(fixture.path, ['add', '-A']);
    await run(fixture.path, ['commit', '-q', '-m', 'failed attempt work']);
    const branchCommit = await run(fixture.repo, ['rev-parse', fixture.branchRef]);
    expect(branchCommit).not.toBe(fixture.base);
    await removeOwnedWorktree({
      repositoryRoot: fixture.repo, ownedRoot: fixture.worktreesRoot, path: fixture.path,
      expectedBranchRef: fixture.branchRef,
    });

    const result = await rebuild(fixture);
    expect(result).toMatchObject({ outcome: 'REBUILT', reasonCode: 'REBUILT_FROM_TASK_BRANCH',
      created: true, path: fixture.path, headCommit: branchCommit });
    // The worktree really is there, on the recorded branch, at the branch's own commit.
    expect(existsSync(join(fixture.path, 'b.txt'))).toBe(true);
    expect(readFileSync(join(fixture.path, 'b.txt'), 'utf8')).toBe('b\n');
    expect(await run(fixture.path, ['symbolic-ref', '-q', 'HEAD'])).toBe(fixture.branchRef);
    expect(await run(fixture.path, ['rev-parse', 'HEAD'])).toBe(branchCommit);
    // Exactly one registration for the task path, and the branch was not moved or re-created.
    expect((await registrations(fixture.repo)).filter((path) => path === fixture.path)).toHaveLength(1);
    expect(await run(fixture.repo, ['rev-parse', fixture.branchRef])).toBe(branchCommit);
  });

  test('is idempotent: a second call adopts the same worktree and runs no Git command', async () => {
    const fixture = await reclaimed();
    const first = await rebuild(fixture);
    expect(first.outcome).toBe('REBUILT');
    const head = await run(fixture.path, ['rev-parse', 'HEAD']);

    const second = await rebuild(fixture);
    expect(second).toMatchObject({ outcome: 'ADOPTED', reasonCode: 'ALREADY_REGISTERED',
      created: false, path: fixture.path, headCommit: head });
    // No second worktree, and the branch is where it was.
    expect((await registrations(fixture.repo)).filter((path) => path === fixture.path)).toHaveLength(1);
    expect(await run(fixture.repo, ['rev-parse', fixture.branchRef])).toBe(head);

    // The same holds for a worktree a *crashed* preparation left behind: the registration and the
    // branch are the durable facts, so the directory alone is enough to adopt it.
    const observed = await inspectOwnedWorktreeRebuild({
      repositoryRoot: fixture.repo, ownedRoot: fixture.worktreesRoot, path: fixture.path,
      branchRef: fixture.branchRef, baseCommit: fixture.base,
    });
    expect(observed).toMatchObject({ observation: 'OWNED', registered: true,
      registeredBranch: fixture.branchRef, headCommit: head, checkedOutElsewhere: false });
  });

  test('refuses a stale registration whose directory is gone instead of adopting nothing', async () => {
    const fixture = await reclaimedRepository();
    rmSync(fixture.path, { recursive: true, force: true });
    const observed = await inspectOwnedWorktreeRebuild({
      repositoryRoot: fixture.repo, ownedRoot: fixture.worktreesRoot, path: fixture.path,
      branchRef: fixture.branchRef, baseCommit: fixture.base,
    });
    expect(observed).toMatchObject({ observation: 'UNCERTAIN', registered: true,
      pathPresent: false });
    const result = await rebuild(fixture);
    expect(result).toMatchObject({ outcome: 'REFUSED', reasonCode: 'REGISTERED_WITHOUT_DIRECTORY',
      created: false });
    expect(existsSync(fixture.path)).toBe(false);
  });

  test('refuses a branch that is not the recorded baseline\'s own growth', async () => {
    const fixture = await reclaimed();
    // An orphan commit sharing the baseline tree: reachable, but with no relation to the baseline.
    const tree = await run(fixture.repo, ['rev-parse', `${fixture.base}^{tree}`]);
    const unrelated = await run(fixture.repo, ['commit-tree', tree, '-m', 'unrelated root']);
    await run(fixture.repo, ['update-ref', fixture.branchRef, unrelated]);

    const branch = await inspectTaskBranch({
      repositoryRoot: fixture.repo, branchRef: fixture.branchRef, baseCommit: fixture.base,
    });
    expect(branch).toMatchObject({ branchExists: true, branchCommit: unrelated,
      relationToBase: 'UNRELATED', checkedOutPaths: [] });

    const result = await rebuild(fixture);
    expect(result).toMatchObject({ outcome: 'REFUSED', reasonCode: 'BRANCH_DIVERGED',
      created: false });
    expect(existsSync(fixture.path)).toBe(false);
    expect(await run(fixture.repo, ['rev-parse', fixture.branchRef])).toBe(unrelated);
  });

  test('refuses when the surviving branch no longer exists', async () => {
    const fixture = await reclaimed();
    await run(fixture.repo, ['update-ref', '-d', fixture.branchRef]);
    const result = await rebuild(fixture);
    expect(result).toMatchObject({ outcome: 'REFUSED', reasonCode: 'BRANCH_ABSENT', created: false });
    expect(existsSync(fixture.path)).toBe(false);
  });

  test('refuses when the branch is checked out in another worktree, and leaves that one alone', async () => {
    const fixture = await reclaimed();
    const elsewhere = join(fixture.home, 'elsewhere');
    await run(fixture.repo, ['worktree', 'add', elsewhere, `task/${taskId}`]);

    const result = await rebuild(fixture);
    expect(result).toMatchObject({ outcome: 'REFUSED',
      reasonCode: 'BRANCH_CHECKED_OUT_ELSEWHERE', created: false });
    expect(existsSync(fixture.path)).toBe(false);
    expect(existsSync(elsewhere)).toBe(true);
    expect(await run(elsewhere, ['rev-parse', 'HEAD'])).toBe(fixture.base);
    expect((await registrations(fixture.repo)).filter((path) => path === fixture.path)).toHaveLength(0);
  });

  test('refuses an unregistered directory at the recorded path and never deletes it', async () => {
    const fixture = await reclaimed();
    mkdirSync(fixture.path, { recursive: true });
    writeFileSync(join(fixture.path, 'leftover.txt'), 'keep me\n');

    const result = await rebuild(fixture);
    expect(result).toMatchObject({ outcome: 'REFUSED', reasonCode: 'UNREGISTERED_DIRECTORY',
      created: false });
    expect(readFileSync(join(fixture.path, 'leftover.txt'), 'utf8')).toBe('keep me\n');
    expect((await registrations(fixture.repo)).filter((path) => path === fixture.path)).toHaveLength(0);
  });

  test('refuses a registration at the recorded path that is on another branch', async () => {
    const fixture = await reclaimed();
    mkdirSync(dirname(fixture.path), { recursive: true });
    await run(fixture.repo, ['worktree', 'add', '--detach', fixture.path, fixture.base]);

    const result = await rebuild(fixture);
    expect(result).toMatchObject({ outcome: 'REFUSED', reasonCode: 'BRANCH_MISMATCH',
      created: false });
    expect(existsSync(fixture.path)).toBe(true);
    expect(await run(fixture.repo, ['rev-parse', fixture.branchRef])).toBe(fixture.base);
  });

  test('refuses a path that is not this Task\'s own layout path', async () => {
    const fixture = await reclaimed();
    const foreign = join(fixture.worktreesRoot, projectId, '30000000-0000-4000-8000-000000000003');
    const result = await rebuild(fixture, foreign);
    expect(result).toMatchObject({ outcome: 'REFUSED', reasonCode: 'PATH_NOT_OWNED_LAYOUT',
      created: false });
    expect(existsSync(foreign)).toBe(false);
  });

  test('refuses a symlinked path instead of following it out of the owned root', async () => {
    const fixture = await reclaimed();
    const target = join(fixture.home, 'target');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, fixture.path);

    const result = await rebuild(fixture);
    expect(result).toMatchObject({ outcome: 'REFUSED', reasonCode: 'SYMLINK_ESCAPE', created: false });
    expect(existsSync(target)).toBe(true);
  });

  test('reports an unwritable layout as a failure instead of a silent success', async () => {
    const fixture = await reclaimed();
    // A file where the project directory belongs: the layout cannot be created, so the rebuild says
    // so and leaves no registration behind (and the file itself is never touched).
    mkdirSync(dirname(dirname(fixture.path)), { recursive: true });
    rmSync(dirname(fixture.path), { recursive: true, force: true });
    writeFileSync(dirname(fixture.path), 'not a directory\n');

    const result = await rebuild(fixture);
    expect(result).toMatchObject({ outcome: 'FAILED', reasonCode: 'REBUILD_FAILED', created: false });
    expect(readFileSync(dirname(fixture.path), 'utf8')).toBe('not a directory\n');
    expect((await registrations(fixture.repo))
      .filter((path) => path === fixture.path)).toHaveLength(0);
    expect(await run(fixture.repo, ['rev-parse', fixture.branchRef])).toBe(fixture.base);
  });
});
