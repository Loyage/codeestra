import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GitInspectionError,
  inspectRepository,
  prepareWorkspace,
  reconcileWorkspace,
} from '../src/index.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function output(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function run(cwd: string, args: readonly string[]): Promise<void> {
  const process = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'ignore', stderr: 'pipe' });
  const error = new Response(process.stderr).text();
  if (await process.exited !== 0) throw new Error(await error);
}

describe('inspectRepository', () => {
  test('returns canonical identity from a temporary repository', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-git-'));
    directories.push(directory);
    await run(directory, ['init', '-b', 'main']);
    await Bun.write(join(directory, 'README.md'), 'temporary repository\n');
    await run(directory, ['add', 'README.md']);
    await run(directory, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);

    const identity = await inspectRepository(directory);
    expect(identity.repoRoot).toBe(realpathSync(directory));
    expect(identity.gitCommonDir).toBe(realpathSync(join(directory, '.git')));
    expect(identity.mainRef).toBe('refs/heads/main');
    expect(identity.headCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  test('prepares an owned task branch and worktree at a fixed base', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-worktree-'));
    directories.push(directory);
    await run(directory, ['init', '-b', 'main']);
    await Bun.write(join(directory, 'README.md'), 'temporary repository\n');
    await run(directory, ['add', 'README.md']);
    await run(directory, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
    const identity = await inspectRepository(directory);
    const worktreesRoot = mkdtempSync(join(tmpdir(), 'codeestra-runtime-worktrees-'));
    directories.push(worktreesRoot);
    const projectId = '88888888-8888-4888-8888-888888888888';
    const taskId = '11111111-1111-4111-8111-111111111111';

    const workspace = await prepareWorkspace({
      operationId: '22222222-2222-4222-8222-222222222222',
      repositoryRoot: directory,
      worktreesRoot: realpathSync(worktreesRoot),
      projectId,
      mainRef: identity.mainRef,
      taskId,
      workspaceId: '33333333-3333-4333-8333-333333333333',
      ownershipToken: '44444444-4444-4444-8444-444444444444',
      baseCommit: identity.headCommit,
      expectedMainCommit: identity.headCommit,
    });

    expect(workspace.path).toBe(realpathSync(join(worktreesRoot, projectId, taskId)));
    expect(await output(workspace.path, ['symbolic-ref', 'HEAD'])).toBe(`refs/heads/task/${taskId}`);
    expect(await output(workspace.path, ['rev-parse', 'HEAD'])).toBe(identity.headCommit);
    expect(await output(directory, ['status', '--porcelain'])).toBe('');
    await expect(reconcileWorkspace({
      repositoryRoot: directory,
      path: workspace.path,
      branchRef: workspace.branchRef,
    })).resolves.toMatchObject({ state: 'OWNED', headCommit: identity.headCommit });
    await expect(reconcileWorkspace({
      repositoryRoot: directory,
      path: join(worktreesRoot, projectId, '99999999-9999-4999-8999-999999999999'),
      branchRef: 'refs/heads/task/99999999-9999-4999-8999-999999999999',
    })).resolves.toMatchObject({ state: 'MISSING' });
    await expect(prepareWorkspace({
      operationId: '55555555-5555-4555-8555-555555555555',
      repositoryRoot: directory,
      worktreesRoot: realpathSync(worktreesRoot),
      projectId,
      mainRef: identity.mainRef,
      taskId,
      workspaceId: '66666666-6666-4666-8666-666666666666',
      ownershipToken: '77777777-7777-4777-8777-777777777777',
      baseCommit: identity.headCommit,
      expectedMainCommit: identity.headCommit,
    })).rejects.toMatchObject({ code: 'REF_CONFLICT' });
  });

  test('resolves a worktrees root that sits behind a symlinked ancestor', async () => {
    // On macOS the temporary directory is reached through a symlink (/tmp -> /private/tmp), and a
    // Runtime data directory is often symlinked too. Containment must be judged on canonical paths
    // instead of requiring the caller to pass a canonical root string.
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-symlinked-repo-'));
    const realRoot = mkdtempSync(join(tmpdir(), 'codeestra-worktrees-real-'));
    const linkedRoot = `${realRoot}-link`;
    symlinkSync(realRoot, linkedRoot);
    directories.push(directory, realRoot, linkedRoot);
    await run(directory, ['init', '-b', 'main']);
    await Bun.write(join(directory, 'README.md'), 'temporary repository\n');
    await run(directory, ['add', 'README.md']);
    await run(directory, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
    const identity = await inspectRepository(directory);
    const projectId = '88888888-8888-4888-8888-888888888888';
    const taskId = '11111111-1111-4111-8111-111111111111';
    const requestedRoot = join(linkedRoot, 'worktrees');
    expect(requestedRoot).not.toBe(realpathSync(realRoot));

    const workspace = await prepareWorkspace({
      operationId: '22222222-2222-4222-8222-222222222222',
      repositoryRoot: directory,
      worktreesRoot: requestedRoot,
      projectId,
      mainRef: identity.mainRef,
      taskId,
      workspaceId: '33333333-3333-4333-8333-333333333333',
      ownershipToken: '44444444-4444-4444-8444-444444444444',
      baseCommit: identity.headCommit,
      expectedMainCommit: identity.headCommit,
    });

    // The recorded path is canonical, which is also what `git worktree list` reports.
    expect(workspace.path).toBe(realpathSync(join(realRoot, 'worktrees', projectId, taskId)));
    expect(await output(workspace.path, ['rev-parse', 'HEAD'])).toBe(identity.headCommit);
    expect(await output(directory, ['status', '--porcelain'])).toBe('');
    await expect(reconcileWorkspace({
      repositoryRoot: directory,
      path: workspace.path,
      branchRef: workspace.branchRef,
    })).resolves.toMatchObject({ state: 'OWNED' });
  });

  test('rejects a stale workspace base before creating a branch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-stale-'));
    directories.push(directory);
    await run(directory, ['init', '-b', 'main']);
    await Bun.write(join(directory, 'README.md'), 'temporary repository\n');
    await run(directory, ['add', 'README.md']);
    await run(directory, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
    const identity = await inspectRepository(directory);
    const stale = '0'.repeat(identity.headCommit.length);
    await expect(prepareWorkspace({
      operationId: '22222222-2222-4222-8222-222222222222',
      repositoryRoot: directory,
      worktreesRoot: realpathSync(directory),
      projectId: '88888888-8888-4888-8888-888888888888',
      mainRef: identity.mainRef,
      taskId: '11111111-1111-4111-8111-111111111111',
      workspaceId: '33333333-3333-4333-8333-333333333333',
      ownershipToken: '44444444-4444-4444-8444-444444444444',
      baseCommit: stale,
      expectedMainCommit: stale,
    })).rejects.toMatchObject({ code: 'STALE_BASE' });
    expect(await output(directory, ['branch', '--list', 'task/*'])).toBe('');
  });

  test('rejects a non-repository', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-not-git-'));
    directories.push(directory);
    await expect(inspectRepository(directory)).rejects.toBeInstanceOf(GitInspectionError);
  });
});
