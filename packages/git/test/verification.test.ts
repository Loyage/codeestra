import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createVerificationCopy,
  inspectVerificationCopy,
  readCommitTree,
  readRefFile,
  removeVerificationCopy,
} from '../src/index.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function run(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${args.join(' ')}: ${stderr}`);
  return stdout.trim();
}

const projectId = '10000000-0000-4000-8000-000000000001';
const verificationId = '20000000-0000-4000-8000-000000000002';

async function repository(): Promise<{ repo: string; copies: string; base: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'codeestra-verification-git-'));
  const copies = mkdtempSync(join(tmpdir(), 'codeestra-verification-copies-'));
  directories.push(repo, copies);
  await run(repo, ['init', '-b', 'main']);
  await run(repo, ['config', 'user.name', 'Test']);
  await run(repo, ['config', 'user.email', 'test@example.invalid']);
  await Bun.write(join(repo, 'a.txt'), 'a\n');
  await Bun.write(join(repo, '.codeestra/policies/verification.json'), '{"version":1}\n');
  await run(repo, ['add', '-A']);
  await run(repo, ['commit', '-m', 'initial']);
  const base = await run(repo, ['rev-parse', 'HEAD']);
  // The copies root is canonicalized because the OS temp directory may sit behind a symlink.
  return { repo, copies: realpathSync(copies), base };
}

describe('reading a ref file', () => {
  test('returns the file and the exact resolved commit', async () => {
    const { repo, base } = await repository();
    const read = await readRefFile({
      repositoryRoot: repo, ref: 'refs/heads/main', path: '.codeestra/policies/verification.json',
    });
    expect(read.commit).toBe(base);
    expect(read.text).toBe('{"version":1}\n');
  });

  test('reports a missing file without inventing content or failing the commit check', async () => {
    const { repo } = await repository();
    const read = await readRefFile({
      repositoryRoot: repo, ref: 'refs/heads/main', path: '.codeestra/policies/absent.json',
    });
    expect(read.text).toBeNull();
    expect(read.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test('fails when the ref is not a commit', async () => {
    const { repo } = await repository();
    await expect(readRefFile({ repositoryRoot: repo, ref: 'refs/heads/missing', path: 'a.txt' }))
      .rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  });
});

describe('verification copy', () => {
  test('checks out the frozen commit detached inside the copies root', async () => {
    const { repo, copies, base } = await repository();
    const copy = await createVerificationCopy({
      repositoryRoot: repo, copiesRoot: copies, projectId, verificationId, testedCommit: base,
    });
    expect(copy.path).toBe(join(copies, projectId, verificationId));
    expect(copy.commit).toBe(base);
    expect(copy.tree).toBe(await readCommitTree({ repositoryRoot: repo, commit: base }));
    expect(await run(copy.path, ['rev-parse', 'HEAD'])).toBe(base);
    // A detached copy has no branch, so verification can never move the Task branch.
    await expect(run(copy.path, ['symbolic-ref', '-q', 'HEAD'])).rejects.toThrow();
    expect(await run(repo, ['worktree', 'list', '--porcelain'])).toContain(copy.path);
    // The user's checkout is untouched.
    expect(await run(repo, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect(await run(repo, ['status', '--porcelain'])).toBe('');
  });

  test('refuses a missing commit, a reused path, and non-UUID identifiers', async () => {
    const { repo, copies, base } = await repository();
    await expect(createVerificationCopy({
      repositoryRoot: repo, copiesRoot: copies, projectId, verificationId, testedCommit: 'b'.repeat(40),
    })).rejects.toMatchObject({ code: 'STALE_BASE' });
    await expect(createVerificationCopy({
      repositoryRoot: repo, copiesRoot: copies, projectId,
      verificationId: 'not-a-uuid', testedCommit: base,
    })).rejects.toMatchObject({ code: 'FOREIGN_RESOURCE' });
    const copy = await createVerificationCopy({
      repositoryRoot: repo, copiesRoot: copies, projectId, verificationId, testedCommit: base,
    });
    await expect(createVerificationCopy({
      repositoryRoot: repo, copiesRoot: copies, projectId, verificationId, testedCommit: base,
    })).rejects.toMatchObject({ code: 'FOREIGN_RESOURCE' });
    expect(copy.path).toBe(join(copies, projectId, verificationId));
  });

  test('detects tracked modifications and reports untracked files separately', async () => {
    const { repo, copies, base } = await repository();
    const copy = await createVerificationCopy({
      repositoryRoot: repo, copiesRoot: copies, projectId, verificationId, testedCommit: base,
    });
    const clean = await inspectVerificationCopy({ path: copy.path, testedCommit: base });
    expect(clean).toMatchObject({ headCommit: base, trackedModifications: [], untrackedFiles: [], clean: true });

    await Bun.write(join(copy.path, 'untracked.txt'), 'generated\n');
    const withUntracked = await inspectVerificationCopy({ path: copy.path, testedCommit: base });
    // Generated files that Git does not track leave the judged tree intact.
    expect(withUntracked.trackedModifications).toEqual([]);
    expect(withUntracked.untrackedFiles).toEqual(['untracked.txt']);
    expect(withUntracked.clean).toBe(true);

    await Bun.write(join(copy.path, 'a.txt'), 'changed\n');
    const modified = await inspectVerificationCopy({ path: copy.path, testedCommit: base });
    expect(modified.trackedModifications).toEqual(['a.txt']);
    expect(modified.clean).toBe(false);
  });

  test('reports a moved HEAD as an unclean copy', async () => {
    const { repo, copies, base } = await repository();
    const copy = await createVerificationCopy({
      repositoryRoot: repo, copiesRoot: copies, projectId, verificationId, testedCommit: base,
    });
    await run(copy.path, ['commit', '--allow-empty', '-m', 'verification committed']);
    const observed = await inspectVerificationCopy({ path: copy.path, testedCommit: base });
    expect(observed.headCommit).not.toBe(base);
    expect(observed.clean).toBe(false);
  });

  test('removes the copy and its worktree registration, and refuses foreign paths', async () => {
    const { repo, copies, base } = await repository();
    const copy = await createVerificationCopy({
      repositoryRoot: repo, copiesRoot: copies, projectId, verificationId, testedCommit: base,
    });
    const outside = join(tmpdir(), 'codeestra-not-a-copy');
    directories.push(outside);
    await Bun.write(join(outside, 'keep.txt'), 'keep\n');
    const refused = await removeVerificationCopy({ repositoryRoot: repo, copiesRoot: copies, path: outside });
    expect(refused.removed).toBe(false);
    expect(await Bun.file(join(outside, 'keep.txt')).text()).toBe('keep\n');

    const removed = await removeVerificationCopy({ repositoryRoot: repo, copiesRoot: copies, path: copy.path });
    expect(removed.removed).toBe(true);
    expect(await Bun.file(copy.path).exists()).toBe(false);
    expect(await run(repo, ['worktree', 'list', '--porcelain'])).not.toContain(copy.path);
    // The Task branch and the user's checkout survive removal.
    expect(await run(repo, ['status', '--porcelain'])).toBe('');
  });
});
