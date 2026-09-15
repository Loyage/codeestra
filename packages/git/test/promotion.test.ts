import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitExists,
  findCheckedOutWorktree,
  inspectDevClone,
  inspectPromotionWorktree,
  pushCommitToRemote,
  readRemoteRef,
  readRemoteUrl,
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
});

/**
 * A local bare remote plus a second clone of it: the shape ADR-0047 D05 pushes from and reads back.
 * Everything lives under the OS temp directory and no real remote is ever contacted.
 */
async function remoteFixture(): Promise<{
  readonly repo: string;
  readonly mainCommit: string;
  readonly candidate: string;
  readonly remote: string;
  readonly devClone: string;
}> {
  const base = await repository();
  const remote = realpathSync(mkdtempSync(join(tmpdir(), 'codeestra-promotion-remote-')));
  directories.push(remote);
  await run(remote, ['init', '--bare', '-b', 'main']);
  await run(base.repo, ['remote', 'add', 'origin', remote]);
  await run(base.repo, ['push', 'origin', 'main']);
  // The candidate exists only in the source repository; it reaches the bare remote through the
  // dev clone, exactly as the promotion is supposed to do it.
  const devClone = realpathSync(mkdtempSync(join(tmpdir(), 'codeestra-promotion-dev-')));
  directories.push(devClone);
  await run(devClone, ['clone', remote, '.']);
  await run(devClone, ['fetch', base.repo, `${base.candidate}:refs/heads/dev`]);
  await run(devClone, ['checkout', 'dev']);
  return { repo: base.repo, mainCommit: base.mainCommit, candidate: base.candidate, remote, devClone };
}

describe('dev clone and remote helpers', () => {
  test('inspects another clone of the same origin that sits on the dev branch', async () => {
    const fixture = await remoteFixture();
    const inspection = await inspectDevClone({ path: fixture.devClone, devRef: 'refs/heads/dev' });
    expect(inspection).toMatchObject({ branchRef: 'refs/heads/dev', devRefCommit: fixture.candidate,
      clean: true, trackedModifications: [] });
    expect(inspection.path).toBe(fixture.devClone);
    // The main checkout is a different clone: a different worktree root and a different git dir.
    const main = await inspectDevClone({ path: fixture.repo, devRef: 'refs/heads/dev' });
    expect(main.gitCommonDir).not.toBe(inspection.gitCommonDir);
    expect(await readRemoteUrl({ repositoryRoot: fixture.devClone })).toBe(fixture.remote);
  });

  test('reports a missing repository and a detached HEAD instead of guessing a branch', async () => {
    const fixture = await remoteFixture();
    await expect(inspectDevClone({
      path: join(fixture.devClone, 'does-not-exist'), devRef: 'refs/heads/dev',
    })).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
    await run(fixture.devClone, ['checkout', '--detach', fixture.candidate]);
    const detached = await inspectDevClone({ path: fixture.devClone, devRef: 'refs/heads/dev' });
    expect(detached.branchRef).toBeNull();
    // The branch still exists; only HEAD is not on it, which is a fact the caller can refuse on.
    expect(detached.devRefCommit).toBe(fixture.candidate);
    expect(await commitExists({ repositoryRoot: fixture.devClone,
      commit: fixture.candidate })).toBe(true);
    expect(await commitExists({ repositoryRoot: fixture.devClone,
      commit: 'f'.repeat(40) })).toBe(false);
  });

  test('reads a remote ref without writing locally and separates absent from unreachable', async () => {
    const fixture = await remoteFixture();
    const present = await readRemoteRef({ repositoryRoot: fixture.devClone,
      remote: 'origin', ref: 'refs/heads/main' });
    expect(present).toEqual({ reachable: true, commit: fixture.mainCommit, detail: null });
    const missing = await readRemoteRef({ repositoryRoot: fixture.devClone,
      remote: 'origin', ref: 'refs/heads/does-not-exist' });
    expect(missing).toEqual({ reachable: true, commit: null, detail: null });
    const unreachable = await readRemoteRef({ repositoryRoot: fixture.devClone,
      remote: join(fixture.devClone, 'not-a-remote'), ref: 'refs/heads/main' });
    expect(unreachable.reachable).toBe(false);
    expect(unreachable.commit).toBeNull();
    expect(unreachable.detail).not.toBeNull();
  });

  test('pushes one fixed commit to one ref and never rewrites what the remote already has', async () => {
    const fixture = await remoteFixture();
    const pushed = await pushCommitToRemote({ repositoryRoot: fixture.devClone, remote: 'origin',
      commit: fixture.candidate, ref: 'refs/heads/dev' });
    expect(pushed.ok).toBe(true);
    const readback = await readRemoteRef({ repositoryRoot: fixture.devClone, remote: 'origin',
      ref: 'refs/heads/dev' });
    expect(readback.commit).toBe(fixture.candidate);

    // A non-fast-forward update is refused by the remote, and the remote keeps its commit.
    const unrelated = await run(fixture.repo, ['commit-tree', `${fixture.mainCommit}^{tree}`,
      '-m', 'unrelated root']);
    const refused = await pushCommitToRemote({ repositoryRoot: fixture.devClone, remote: 'origin',
      commit: unrelated, ref: 'refs/heads/dev' });
    expect(refused.ok).toBe(false);
    expect(await run(fixture.remote, ['rev-parse', 'refs/heads/dev'])).toBe(fixture.candidate);
    // A remote that does not exist is a refusal, not a rewrite, and reports its own detail.
    const unreachable = await pushCommitToRemote({ repositoryRoot: fixture.devClone,
      remote: join(fixture.devClone, 'not-a-remote'), commit: fixture.candidate,
      ref: 'refs/heads/dev' });
    expect(unreachable.ok).toBe(false);
    // Only a local branch ref can be a push target.
    await expect(pushCommitToRemote({ repositoryRoot: fixture.devClone, remote: 'origin',
      commit: fixture.candidate, ref: 'HEAD' })).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
  });
});
