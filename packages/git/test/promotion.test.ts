import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fastForwardCheckedOutWorktree,
  findCheckedOutWorktree,
  inspectPromotionWorktree,
} from '../src/promotion.js';

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

interface Fixture {
  readonly repo: string;
  readonly mainWorktree: string;
  readonly mainCommit: string;
  /** A commit that descends from main and only exists on `dev`. */
  readonly candidate: string;
}

/**
 * Temporary repository with `main` checked out in its primary worktree and a `dev` branch one
 * commit ahead. The candidate commit is produced in a throwaway worktree so the promoting
 * worktree stays exactly on the expected old main commit.
 */
async function repository(): Promise<Fixture> {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'codeestra-promotion-git-')));
  directories.push(repo);
  await run(repo, ['init', '-b', 'main']);
  await run(repo, ['config', 'user.name', 'Test']);
  await run(repo, ['config', 'user.email', 'test@example.invalid']);
  await Bun.write(join(repo, 'a.txt'), 'a\n');
  await run(repo, ['add', '-A']);
  await run(repo, ['commit', '-m', 'initial']);
  const mainCommit = await run(repo, ['rev-parse', 'HEAD']);
  await run(repo, ['branch', 'dev']);
  const side = join(repo, '..', `promotion-side-${crypto.randomUUID()}`);
  directories.push(side);
  await run(repo, ['worktree', 'add', '-q', side, 'dev']);
  await Bun.write(join(side, 'promoted.txt'), 'promoted\n');
  await run(side, ['add', '-A']);
  await run(side, ['commit', '-m', 'dev work']);
  const candidate = await run(side, ['rev-parse', 'HEAD']);
  // Update the branch without checking it out here, so the candidate only exists on `dev`.
  await run(repo, ['update-ref', 'refs/heads/dev', candidate]);
  await run(repo, ['worktree', 'remove', '-f', side]);
  return { repo, mainWorktree: repo, mainCommit, candidate };
}

describe('promotion worktree helpers', () => {
  test('finds the worktree that has main checked out and none for an unchecked-out branch', async () => {
    const fixture = await repository();
    const main = await findCheckedOutWorktree({
      repositoryRoot: fixture.repo, ref: 'refs/heads/main',
    });
    expect(main).toEqual({ ref: 'refs/heads/main', path: fixture.mainWorktree });
    expect(await findCheckedOutWorktree({
      repositoryRoot: fixture.repo, ref: 'refs/heads/dev',
    })).toBeNull();
    await expect(findCheckedOutWorktree({
      repositoryRoot: fixture.repo, ref: 'HEAD',
    })).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
  });

  test('reports a clean checkout and refuses one parked on another commit or branch', async () => {
    const fixture = await repository();
    const inspection = await inspectPromotionWorktree({
      path: fixture.mainWorktree,
      expectedRef: 'refs/heads/main',
      expectedCommit: fixture.mainCommit,
    });
    expect(inspection).toMatchObject({ branchRef: 'refs/heads/main',
      headCommit: fixture.mainCommit, clean: true, trackedModifications: [] });

    await Bun.write(join(fixture.mainWorktree, 'a.txt'), 'locally edited\n');
    const dirty = await inspectPromotionWorktree({
      path: fixture.mainWorktree,
      expectedRef: 'refs/heads/main',
      expectedCommit: fixture.mainCommit,
    });
    expect(dirty.clean).toBe(false);
    expect(dirty.trackedModifications).toEqual(['a.txt']);
    await run(fixture.mainWorktree, ['checkout', '--', 'a.txt']);

    await expect(inspectPromotionWorktree({
      path: fixture.mainWorktree,
      expectedRef: 'refs/heads/dev',
      expectedCommit: fixture.mainCommit,
    })).rejects.toMatchObject({ code: 'FOREIGN_RESOURCE' });
    await expect(inspectPromotionWorktree({
      path: fixture.mainWorktree,
      expectedRef: 'refs/heads/main',
      expectedCommit: fixture.candidate,
    })).rejects.toMatchObject({ code: 'STALE_BASE' });
  });

  test('fast-forwards ref, index and files together in the checked-out main worktree', async () => {
    const fixture = await repository();
    const before = await run(fixture.mainWorktree, ['status', '--porcelain']);
    expect(before).toBe('');
    const merged = await fastForwardCheckedOutWorktree({
      path: fixture.mainWorktree,
      expectedRef: 'refs/heads/main',
      expectedCommit: fixture.mainCommit,
      candidateCommit: fixture.candidate,
    });
    expect(merged).toMatchObject({ outcome: 'FAST_FORWARD', commit: fixture.candidate });
    // The ref, HEAD, the index and the working files all moved: this is the whole reason a
    // promotion never uses `git update-ref` on a checked-out branch.
    expect(await run(fixture.mainWorktree, ['rev-parse', 'refs/heads/main'])).toBe(fixture.candidate);
    expect(await run(fixture.mainWorktree, ['rev-parse', 'HEAD'])).toBe(fixture.candidate);
    expect(await run(fixture.mainWorktree, ['status', '--porcelain'])).toBe('');
    expect(await Bun.file(join(fixture.mainWorktree, 'promoted.txt')).text()).toBe('promoted\n');
  });

  test('treats an already-promoted worktree as an idempotent fast-forward', async () => {
    const fixture = await repository();
    await run(fixture.mainWorktree, ['merge', '--ff-only', fixture.candidate]);
    const again = await fastForwardCheckedOutWorktree({
      path: fixture.mainWorktree,
      expectedRef: 'refs/heads/main',
      expectedCommit: fixture.candidate,
      candidateCommit: fixture.candidate,
    });
    expect(again).toMatchObject({ outcome: 'FAST_FORWARD', commit: fixture.candidate });
    expect(await run(fixture.mainWorktree, ['rev-parse', 'refs/heads/main'])).toBe(fixture.candidate);
  });

  test('refuses to fast-forward a dirty checkout and leaves the ref where it was', async () => {
    const fixture = await repository();
    await Bun.write(join(fixture.mainWorktree, 'a.txt'), 'locally edited\n');
    const merged = await fastForwardCheckedOutWorktree({
      path: fixture.mainWorktree,
      expectedRef: 'refs/heads/main',
      expectedCommit: fixture.mainCommit,
      candidateCommit: fixture.candidate,
    });
    expect(merged.outcome).toBe('FAILED');
    expect(merged.commit).toBeNull();
    expect(merged.detail).toContain('modified tracked file');
    expect(await run(fixture.mainWorktree, ['rev-parse', 'refs/heads/main'])).toBe(fixture.mainCommit);
    // The local edit is untouched: a promotion never resolves someone's work in progress.
    expect(await Bun.file(join(fixture.mainWorktree, 'a.txt')).text()).toBe('locally edited\n');
  });

  test('refuses a candidate that is not a descendant of the expected main commit', async () => {
    const fixture = await repository();
    const unrelated = await run(fixture.repo, ['commit-tree', `${fixture.mainCommit}^{tree}`,
      '-m', 'unrelated root']);
    const merged = await fastForwardCheckedOutWorktree({
      path: fixture.mainWorktree,
      expectedRef: 'refs/heads/main',
      expectedCommit: fixture.mainCommit,
      candidateCommit: unrelated,
    });
    expect(merged.outcome).toBe('FAILED');
    expect(await run(fixture.mainWorktree, ['rev-parse', 'refs/heads/main'])).toBe(fixture.mainCommit);
    expect(await run(fixture.mainWorktree, ['status', '--porcelain'])).toBe('');
  });
});
