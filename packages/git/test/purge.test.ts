import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deleteOwnedTaskBranch } from '../src/purge.js';

/**
 * The branch half of `task purge` (ADR-0058). Two properties matter more than the happy path and
 * both are refusals: a branch that is checked out anywhere is never deleted, and a branch that moved
 * since it was read is refused rather than destroyed.
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

async function refExists(cwd: string, ref: string): Promise<boolean> {
  const process = Bun.spawn(['git', '-C', cwd, 'show-ref', '--verify', '--quiet', ref],
    { stdout: 'ignore', stderr: 'ignore' });
  return (await process.exited) === 0;
}

const taskId = '20000000-0000-4000-8000-000000000002';

interface Fixture {
  readonly repo: string;
  readonly home: string;
  readonly base: string;
  readonly branchRef: string;
  readonly worktreePath: string;
}

async function repository(): Promise<Fixture> {
  const repo = mkdtempSync(join(tmpdir(), 'codeestra-purge-git-'));
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'codeestra-purge-git-home-')));
  directories.push(repo, home);
  await run(repo, ['init', '-q', '-b', 'main']);
  await run(repo, ['config', 'user.name', 'Test']);
  await run(repo, ['config', 'user.email', 'test@example.invalid']);
  await Bun.write(join(repo, 'a.txt'), 'a\n');
  await run(repo, ['add', '-A']);
  await run(repo, ['commit', '-q', '-m', 'initial']);
  const base = await run(repo, ['rev-parse', 'HEAD']);
  const branchRef = `refs/heads/task/${taskId}`;
  await run(repo, ['branch', `task/${taskId}`, base]);
  return { repo, home, base, branchRef, worktreePath: join(home, 'worktrees', taskId) };
}

describe('owned Task branch deletion', () => {
  test('deletes an unattached branch and reports the tip it destroyed', async () => {
    const fixture = await repository();
    await run(fixture.repo, ['checkout', '-q', `task/${taskId}`]);
    await Bun.write(join(fixture.repo, 'b.txt'), 'b\n');
    await run(fixture.repo, ['add', '-A']);
    await run(fixture.repo, ['commit', '-q', '-m', 'task work']);
    const tip = await run(fixture.repo, ['rev-parse', `task/${taskId}`]);
    await run(fixture.repo, ['checkout', '-q', 'main']);

    const removal = await deleteOwnedTaskBranch({ repositoryRoot: fixture.repo,
      branchRef: fixture.branchRef });
    expect(removal).toMatchObject({ outcome: 'REMOVED', reasonCode: 'REMOVED', tipCommit: tip });
    expect(await refExists(fixture.repo, fixture.branchRef)).toBe(false);
    // The commit itself is untouched: a purge records where the branch pointed, it does not rewrite
    // objects, so the fact is recoverable from the audit event.
    expect(await run(fixture.repo, ['cat-file', '-t', tip])).toBe('commit');
  });

  test('refuses a branch another worktree has checked out', async () => {
    const fixture = await repository();
    mkdirSync(dirname(fixture.worktreePath), { recursive: true });
    await run(fixture.repo, ['worktree', 'add', '-q', fixture.worktreePath, `task/${taskId}`]);

    const removal = await deleteOwnedTaskBranch({ repositoryRoot: fixture.repo,
      branchRef: fixture.branchRef });
    expect(removal).toMatchObject({ outcome: 'REFUSED', reasonCode: 'BRANCH_CHECKED_OUT' });
    expect(await refExists(fixture.repo, fixture.branchRef)).toBe(true);
  });

  test('deletes the tip it read and reports a missing branch as already absent', async () => {
    const fixture = await repository();
    // The expected tip is read from the ref itself and used as a compare-and-swap, so a deletion can
    // never destroy a commit the caller did not see; the reported tip is exactly what went.
    const tree = await run(fixture.repo, ['rev-parse', 'HEAD^{tree}']);
    const moved = await run(fixture.repo, ['commit-tree', tree, '-m', 'other']);
    await run(fixture.repo, ['update-ref', fixture.branchRef, moved]);
    const removal = await deleteOwnedTaskBranch({ repositoryRoot: fixture.repo,
      branchRef: fixture.branchRef });
    expect(removal).toMatchObject({ outcome: 'REMOVED', tipCommit: moved });

    const missing = await deleteOwnedTaskBranch({ repositoryRoot: fixture.repo,
      branchRef: fixture.branchRef });
    expect(missing).toMatchObject({ outcome: 'ALREADY_ABSENT', tipCommit: null });

    const notABranch = await deleteOwnedTaskBranch({ repositoryRoot: fixture.repo,
      branchRef: 'refs/tags/v1' });
    expect(notABranch).toMatchObject({ outcome: 'REFUSED', reasonCode: 'NOT_A_LOCAL_BRANCH' });
  });
});
