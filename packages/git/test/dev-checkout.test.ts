import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fastForwardCheckedOutWorktree,
  inspectDevCheckout,
  listCheckedOutRefs,
  readLocalRefCommit,
} from '../src/index.js';

/**
 * The one exception ADR-0056 adds to ADR-0018 lives here: the dev clone's own `dev` checkout may hold
 * the ref because the integration fast-forwards it in the same operation. These cases pin the facts
 * the integration decides on (is HEAD on `dev`, is the worktree clean including untracked files, is
 * the checkout at the baseline) and the fast-forward's own verdict.
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
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function clone(dir: string): Promise<string> {
  directories.push(dir);
  return await realpathSync(dir);
}

/** One repository on `dev` with one commit, plus the identity a commit needs. */
async function repository(): Promise<string> {
  const repo = await clone(mkdtempSync(join(tmpdir(), 'codeestra-dev-checkout-')));
  await run(repo, ['init', '-q', '-b', 'main']);
  await run(repo, ['config', 'user.name', 'Test']);
  await run(repo, ['config', 'user.email', 'test@example.invalid']);
  await Bun.write(join(repo, 'README.md'), 'temporary repository\n');
  await run(repo, ['add', 'README.md']);
  await run(repo, ['commit', '-q', '-m', 'initial']);
  await run(repo, ['branch', 'dev']);
  return repo;
}

describe('dev checkout inspection (ADR-0056)', () => {
  test('reports a clean checkout that is on dev, including its branch and head', async () => {
    const repo = await repository();
    await run(repo, ['checkout', '-q', 'dev']);
    const checkout = await inspectDevCheckout({ path: repo });
    expect(checkout).toMatchObject({ path: repo, branchRef: 'refs/heads/dev', clean: true });
    expect(checkout.headCommit).toBe(await run(repo, ['rev-parse', 'HEAD']));
    expect(checkout.statusDetail).toBe('');
    // The worktree list is what the integration asks first: the dev clone's own checkout is the one
    // holder of `refs/heads/dev` that is allowed.
    const holders = (await listCheckedOutRefs(repo)).filter((entry) => entry.ref === 'refs/heads/dev');
    expect(holders).toEqual([{ ref: 'refs/heads/dev', path: repo }]);
  });

  test('reports an untracked file as dirty, because a fast-forward would overwrite it', async () => {
    const repo = await repository();
    await run(repo, ['checkout', '-q', 'dev']);
    await Bun.write(join(repo, 'uncommitted.txt'), 'work in progress\n');
    const checkout = await inspectDevCheckout({ path: repo });
    expect(checkout.clean).toBe(false);
    expect(checkout.statusDetail).toContain('uncommitted.txt');
  });

  test('reports a detached HEAD instead of guessing which branch it came from', async () => {
    const repo = await repository();
    await run(repo, ['checkout', '-q', '--detach', 'dev']);
    const checkout = await inspectDevCheckout({ path: repo });
    expect(checkout.branchRef).toBeNull();
    expect(checkout.clean).toBe(true);
    // A detached checkout is not reported as a holder of the ref, which is exactly why the
    // integration checks HEAD itself instead of relying on that list.
    expect((await listCheckedOutRefs(repo)).filter((entry) => entry.ref === 'refs/heads/dev'))
      .toEqual([]);
  });
});

describe('fast-forwarding the dev clone checkout (ADR-0056)', () => {
  /**
   * The candidate commit is built on a side branch, so the dev checkout is still at the baseline when
   * the integration advances it: that is the state the two-clone layout produces, and it is also the
   * state in which a hand-written `update-ref` would silently leave the checkout behind.
   */
  async function candidateCommit(repo: string, file: string, content: string): Promise<string> {
    await run(repo, ['checkout', '-q', '-b', 'candidate']);
    await Bun.write(join(repo, file), content);
    await run(repo, ['add', file]);
    await run(repo, ['commit', '-q', '-m', 'the integrated commit']);
    const commit = await run(repo, ['rev-parse', 'HEAD']);
    await run(repo, ['checkout', '-q', 'dev']);
    return commit;
  }

  test('moves the ref, the index and the working tree, and needs a clean status to call it done',
    async () => {
      const repo = await repository();
      await run(repo, ['checkout', '-q', 'dev']);
      const baseline = await run(repo, ['rev-parse', 'HEAD']);
      const integrated = await candidateCommit(repo, 'integrated.txt', 'integrated\n');
      expect(await run(repo, ['rev-parse', 'refs/heads/dev'])).toBe(baseline);

      const forwarded = await fastForwardCheckedOutWorktree({
        path: repo, branchRef: 'refs/heads/dev', newCommit: integrated,
      });
      expect(forwarded).toMatchObject({ advanced: true, refCommit: integrated, headCommit: integrated,
        clean: true });
      expect(await run(repo, ['rev-parse', 'HEAD'])).toBe(integrated);
      expect(await readLocalRefCommit({ repositoryRoot: repo, ref: 'refs/heads/dev' })).toBe(integrated);
      // The three-way equality alone is not evidence (HEAD is a symbolic reference to the branch): the
      // file the commit introduces has to be in the working tree, and the status has to be clean.
      expect(await run(repo, ['status', '--porcelain'])).toBe('');
      expect(await Bun.file(join(repo, 'integrated.txt')).text()).toBe('integrated\n');
    });

  test('refuses to move a checkout whose local edit the fast-forward would overwrite', async () => {
    const repo = await repository();
    await run(repo, ['checkout', '-q', 'dev']);
    const baseline = await run(repo, ['rev-parse', 'HEAD']);
    const integrated = await candidateCommit(repo, 'README.md', 'integrated version\n');
    // The same file is edited in the commit and in the checkout: Git refuses, and nothing here repairs
    // that by force. The observed facts name both values instead.
    await Bun.write(join(repo, 'README.md'), 'locally edited\n');

    const forwarded = await fastForwardCheckedOutWorktree({
      path: repo, branchRef: 'refs/heads/dev', newCommit: integrated,
    });
    expect(forwarded.advanced).toBe(false);
    expect(forwarded.refCommit).toBe(baseline);
    expect(forwarded.headCommit).toBe(baseline);
    expect(forwarded.detail).toContain(baseline);
    expect(await run(repo, ['rev-parse', 'HEAD'])).toBe(baseline);
    expect(await readLocalRefCommit({ repositoryRoot: repo, ref: 'refs/heads/dev' })).toBe(baseline);
    expect(await Bun.file(join(repo, 'README.md')).text()).toBe('locally edited\n');
  });
});
