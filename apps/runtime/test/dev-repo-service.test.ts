/**
 * Dev clone verification (FOUNDATION-077 / ADR-0047 D05).
 *
 * A promotion pushes its fixed candidate from `projects.dev_repo_path`, so that path is only ever
 * recorded after it was established as *another clone of the same origin on the dev branch*. Each
 * refusal here is a stable code, and every repository used is a temporary one: no real remote and no
 * user checkout is involved.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupTemporaryDirectories,
  git,
  registerTemporaryDirectory,
} from './support/agent-fixture.js';
import { inspectDevRepo, requireDevRepo, requireCandidateInDevRepo } from '../src/dev-repo-service.js';

afterEach(() => { cleanupTemporaryDirectories(); });

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  registerTemporaryDirectory(directory);
  return directory;
}

interface DevRepoFixture {
  /** The trusted main checkout: a normal repository with an `origin` remote. */
  readonly main: string;
  readonly remote: string;
  readonly devClone: string;
  readonly mainCommit: string;
}

/**
 * A main checkout and a second clone of the same local bare remote, which is what ADR-0048 D01
 * describes. The dev clone has the `dev` branch checked out, so the fixture starts out verifiable.
 */
async function devRepoFixture(): Promise<DevRepoFixture> {
  const main = temporaryDirectory('codeestra-dev-repo-main-');
  const remote = temporaryDirectory('codeestra-dev-repo-remote-');
  const devClone = temporaryDirectory('codeestra-dev-repo-clone-');
  await git(remote, ['init', '--bare', '-b', 'main']);
  await git(main, ['init', '-b', 'main']);
  await git(main, ['config', 'user.name', 'Test']);
  await git(main, ['config', 'user.email', 'test@example.invalid']);
  await Bun.write(join(main, 'README.md'), 'fixture\n');
  await git(main, ['add', '.']);
  await git(main, ['commit', '-q', '-m', 'fixture']);
  await git(main, ['branch', 'dev']);
  await git(main, ['remote', 'add', 'origin', remote]);
  await git(main, ['push', '-q', 'origin', 'main', 'dev']);
  const mainCommit = await git(main, ['rev-parse', 'refs/heads/main']);
  await git(devClone, ['clone', '-q', remote, '.']);
  await git(devClone, ['checkout', '-q', 'dev']);
  return { main, remote, devClone, mainCommit };
}

describe('dev clone verification', () => {
  test('verifies another clone of the same origin that sits on the dev branch', async () => {
    const fixture = await devRepoFixture();
    const inspection = await inspectDevRepo({
      repositoryRoot: fixture.main, devRef: 'refs/heads/dev', devRepoPath: fixture.devClone,
    });
    expect(inspection).toMatchObject({
      verified: true, code: null, detail: null,
      path: fixture.devClone, branchRef: 'refs/heads/dev', originUrl: fixture.remote,
      originMatchesProject: true, clean: true,
    });
    expect(inspection.devRefCommit).toBe(fixture.mainCommit);
    // The verified form is what a promotion uses; it returns the same facts.
    expect((await requireDevRepo({
      repositoryRoot: fixture.main, devRef: 'refs/heads/dev', devRepoPath: fixture.devClone,
    })).path).toBe(fixture.devClone);
  });

  test('refuses the main checkout and a worktree of it with DEV_REPO_NOT_SEPARATE', async () => {
    const fixture = await devRepoFixture();
    const sameCheckout = await inspectDevRepo({
      repositoryRoot: fixture.main, devRef: 'refs/heads/dev', devRepoPath: fixture.main,
    });
    expect(sameCheckout).toMatchObject({ verified: false, code: 'DEV_REPO_NOT_SEPARATE' });
    expect(sameCheckout.detail).toContain('main checkout itself');

    // A worktree of the main checkout shares its Git common directory: still not another clone.
    const worktree = join(fixture.main, '..', `dev-repo-worktree-${crypto.randomUUID()}`);
    registerTemporaryDirectory(worktree);
    await git(fixture.main, ['worktree', 'add', '-q', worktree, 'dev']);
    const asWorktree = await inspectDevRepo({
      repositoryRoot: fixture.main, devRef: 'refs/heads/dev', devRepoPath: worktree,
    });
    expect(asWorktree).toMatchObject({ verified: false, code: 'DEV_REPO_NOT_SEPARATE' });
    expect(asWorktree.detail).toContain('worktree of the main checkout');
  });

  test('refuses a directory that is not a Git work tree', async () => {
    const fixture = await devRepoFixture();
    const notARepository = temporaryDirectory('codeestra-dev-repo-plain-');
    await Bun.write(join(notARepository, 'notes.txt'), 'not a repository\n');
    const inspection = await inspectDevRepo({
      repositoryRoot: fixture.main, devRef: 'refs/heads/dev', devRepoPath: notARepository,
    });
    expect(inspection).toMatchObject({ verified: false, code: 'DEV_REPO_NOT_A_REPOSITORY' });
    const missing = await inspectDevRepo({
      repositoryRoot: fixture.main, devRef: 'refs/heads/dev',
      devRepoPath: join(notARepository, 'does-not-exist'),
    });
    expect(missing).toMatchObject({ verified: false, code: 'DEV_REPO_NOT_A_REPOSITORY' });
    await expect(requireDevRepo({
      repositoryRoot: fixture.main, devRef: 'refs/heads/dev', devRepoPath: notARepository,
    })).rejects.toMatchObject({ code: 'DEV_REPO_NOT_A_REPOSITORY' });
  });

  test('refuses a clone whose origin is a different repository', async () => {
    const fixture = await devRepoFixture();
    const otherRemote = temporaryDirectory('codeestra-dev-repo-other-');
    await git(otherRemote, ['init', '--bare', '-b', 'main']);
    await git(fixture.devClone, ['remote', 'set-url', 'origin', otherRemote]);
    const inspection = await inspectDevRepo({
      repositoryRoot: fixture.main, devRef: 'refs/heads/dev', devRepoPath: fixture.devClone,
    });
    expect(inspection).toMatchObject({ verified: false, code: 'DEV_REPO_ORIGIN_MISMATCH',
      originUrl: otherRemote, originMatchesProject: false });
  });

  test('refuses a clone that is not sitting on the dev branch or has no dev branch', async () => {
    const fixture = await devRepoFixture();
    await git(fixture.devClone, ['checkout', '-q', 'main']);
    const onMain = await inspectDevRepo({
      repositoryRoot: fixture.main, devRef: 'refs/heads/dev', devRepoPath: fixture.devClone,
    });
    expect(onMain).toMatchObject({ verified: false, code: 'DEV_REPO_BRANCH_MISMATCH',
      branchRef: 'refs/heads/main' });

    await git(fixture.devClone, ['checkout', '-q', 'dev']);
    // A branch can only be deleted with HEAD detached from it; the clone then has no local `dev`.
    await git(fixture.devClone, ['checkout', '-q', '--detach', 'main']);
    await git(fixture.devClone, ['branch', '-D', 'dev']);
    const noDev = await inspectDevRepo({
      repositoryRoot: fixture.main, devRef: 'refs/heads/dev', devRepoPath: fixture.devClone,
    });
    expect(noDev).toMatchObject({ verified: false, code: 'DEV_REPO_BRANCH_MISMATCH' });
  });

  test('refuses a candidate the dev clone does not hold', async () => {
    const fixture = await devRepoFixture();
    const unknown = 'f'.repeat(40);
    await expect(requireCandidateInDevRepo({
      devRepoPath: fixture.devClone, candidateCommit: unknown,
    })).rejects.toMatchObject({ code: 'DEV_REPO_CANDIDATE_MISSING' });
    await expect(requireCandidateInDevRepo({
      devRepoPath: fixture.devClone, candidateCommit: fixture.mainCommit,
    })).resolves.toBeUndefined();
  });
});
