import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { GitInspectionError } from './errors.js';
import { resolveCommitIdentity } from './result-commit.js';

const stableId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function gitEnvironment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value === undefined) continue;
    // Ambient GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE must never redirect our commands.
    if (key.startsWith('GIT_')) continue;
    environment[key] = value;
  }
  return { ...environment, ...extra };
}

interface GitRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGit(cwd: string, args: readonly string[], extraEnv: Readonly<Record<string, string>> = {}): Promise<GitRun> {
  const process = Bun.spawn(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: gitEnvironment(extraEnv),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function gitOrThrow(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED',
      result.stderr.trim() || result.stdout.trim() || `git ${args[0] ?? ''} exited with ${result.exitCode}`);
  }
  return result.stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertDirectoryNotSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new GitInspectionError('UNSAFE_CHECKOUT', `Integration parent must not be a symlink: ${path}`);
    }
  } catch (error) {
    if (error instanceof GitInspectionError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Reads one local branch commit, or null when the ref does not exist. */
export async function readLocalRefCommit(input: {
  readonly repositoryRoot: string;
  readonly ref: string;
}): Promise<string | null> {
  if (!input.ref.startsWith('refs/heads/')) {
    throw new GitInspectionError('INVALID_REPOSITORY', 'A baseline ref must be a local branch');
  }
  const result = await runGit(input.repositoryRoot, ['rev-parse', '--verify', '--quiet', input.ref]);
  if (result.exitCode === 0) return result.stdout.trim();
  // Git reports a missing ref as a silent exit 1 (or 128 without --quiet semantics on old
  // versions). Anything else is a real failure that must not be read as "the ref is absent".
  if (result.exitCode === 1 || result.exitCode === 128) return null;
  throw new GitInspectionError('COMMAND_FAILED',
    result.stderr.trim() || `git rev-parse exited with ${result.exitCode}`);
}

export interface CheckedOutRef {
  readonly ref: string;
  readonly path: string;
}

/**
 * Refs Git currently has checked out in any worktree of this repository. Advancing one of these
 * refs without going through that worktree would leave its index and files behind the ref, so the
 * integration pipeline refuses instead of creating that inconsistency.
 */
export async function listCheckedOutRefs(repositoryRoot: string): Promise<readonly CheckedOutRef[]> {
  const output = await gitOrThrow(repositoryRoot, ['worktree', 'list', '--porcelain', '-z']);
  const checkedOut: CheckedOutRef[] = [];
  for (const record of output.split('\0\0')) {
    if (record.length === 0) continue;
    const fields = record.split('\0');
    const path = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
    const ref = fields.find((field) => field.startsWith('branch '))?.slice('branch '.length);
    if (path !== undefined && ref !== undefined && ref.length > 0) checkedOut.push({ ref, path });
  }
  return checkedOut;
}

export async function isAncestor(input: {
  readonly repositoryRoot: string;
  readonly ancestor: string;
  readonly descendant: string;
}): Promise<boolean> {
  const result = await runGit(input.repositoryRoot,
    ['merge-base', '--is-ancestor', input.ancestor, input.descendant]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new GitInspectionError('COMMAND_FAILED',
    result.stderr.trim() || `git merge-base exited with ${result.exitCode}`);
}

export interface IntegrationWorktree {
  readonly path: string;
  readonly commit: string;
}

/**
 * Creates the detached worktree an integration merge happens in. It lives inside the Runtime data
 * directory, never in the user's repository or in the checked-out `dev` worktree, so advancing the
 * `dev` ref afterwards cannot disturb anyone's working files.
 */
export async function createIntegrationWorktree(input: {
  readonly repositoryRoot: string;
  readonly worktreesRoot: string;
  readonly projectId: string;
  readonly batchId: string;
  readonly commit: string;
}): Promise<IntegrationWorktree> {
  for (const [name, value] of [['projectId', input.projectId], ['batchId', input.batchId]] as const) {
    if (!stableId.test(value)) throw new GitInspectionError('FOREIGN_RESOURCE', `${name} must be a UUID`);
  }
  if (!isAbsolute(input.worktreesRoot)) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', 'Integration worktrees root must be absolute');
  }
  const requestedRoot = resolve(input.worktreesRoot);
  await assertDirectoryNotSymlink(requestedRoot);
  const projectDirectory = join(requestedRoot, input.projectId);
  const requestedPath = join(projectDirectory, input.batchId);
  await assertDirectoryNotSymlink(projectDirectory);
  if (await pathExists(requestedPath)) {
    throw new GitInspectionError('FOREIGN_RESOURCE', `Integration worktree path already exists: ${requestedPath}`);
  }
  await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  const worktreesRoot = await realpath(requestedRoot);
  const canonicalParent = await realpath(projectDirectory);
  if (canonicalParent !== join(worktreesRoot, input.projectId)
    || !canonicalParent.startsWith(`${worktreesRoot}/`)) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', 'Integration parent escaped the Runtime worktrees root');
  }
  const path = join(worktreesRoot, input.projectId, input.batchId);
  const result = await runGit(input.repositoryRoot,
    ['worktree', 'add', '--detach', path, input.commit]);
  if (result.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED',
      result.stderr.trim() || result.stdout.trim() || `git worktree add exited with ${result.exitCode}`,
      true);
  }
  const canonicalPath = await realpath(path);
  const head = await gitOrThrow(canonicalPath, ['rev-parse', '--verify', 'HEAD']);
  if (canonicalPath !== path || head !== input.commit) {
    throw new GitInspectionError('FOREIGN_RESOURCE',
      'Integration worktree does not match its expected path and base commit', true);
  }
  return { path: canonicalPath, commit: head };
}

export type MergeOutcome = 'FAST_FORWARD' | 'MERGE_COMMIT' | 'CONFLICT' | 'FAILED';

export interface MergeResult {
  readonly outcome: MergeOutcome;
  /** Commit the integration worktree is on after the attempt; null when nothing was produced. */
  readonly commit: string | null;
  readonly detail: string;
}

/**
 * Merges the candidate result commit into the fixed baseline inside the integration worktree.
 * A conflict is reported with its working-tree evidence left in place: nothing here aborts,
 * resets, or advances a ref.
 */
export async function mergeResultCommit(input: {
  readonly path: string;
  readonly candidateCommit: string;
  readonly baselineCommit: string;
  readonly strategy: 'FAST_FORWARD' | 'MERGE_COMMIT';
  readonly message: string;
}): Promise<MergeResult> {
  const identityArgs: string[] = [];
  if (input.strategy === 'MERGE_COMMIT') {
    // A merge commit needs an author/committer identity; a fast-forward creates no commit and
    // must not fail just because the repository has no identity configured.
    const identity = await resolveCommitIdentity(input.path);
    identityArgs.push('-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`);
  }
  const args = input.strategy === 'FAST_FORWARD'
    ? ['merge', '--ff-only', input.candidateCommit]
    : ['merge', '--no-ff', '--no-edit', '-m', input.message, input.candidateCommit];
  const result = await runGit(input.path, [...identityArgs, ...args]);
  const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 4_000);
  if (result.exitCode !== 0) {
    // A conflict is proven by unmerged index entries, not by MERGE_HEAD: a refusing commit-msg
    // hook also leaves the merge in progress, and that is a failure, not a conflict.
    const unmerged = await runGit(input.path, ['ls-files', '--unmerged', '--', '.']);
    const conflicted = unmerged.exitCode === 0 && unmerged.stdout.trim().length > 0;
    if (conflicted) {
      return { outcome: 'CONFLICT', commit: null,
        detail: detail || 'the candidate conflicts with the fixed dev baseline' };
    }
    const mergeHead = await runGit(input.path, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
    const stillInProgress = mergeHead.exitCode === 0
      ? ' (the merge is still in progress in the integration worktree)'
      : '';
    return { outcome: 'FAILED', commit: null,
      detail: (detail || `git merge exited with ${result.exitCode}`) + stillInProgress };
  }
  const head = await runGit(input.path, ['rev-parse', '--verify', 'HEAD']);
  if (head.exitCode !== 0) {
    return { outcome: 'FAILED', commit: null, detail: 'the merge reported success without a commit' };
  }
  const commit = head.stdout.trim();
  if (input.strategy === 'FAST_FORWARD' && commit !== input.candidateCommit) {
    return { outcome: 'FAILED', commit: null,
      detail: 'a fast-forward merge did not land on the candidate commit' };
  }
  if (input.strategy === 'MERGE_COMMIT') {
    if (commit === input.candidateCommit) {
      return { outcome: 'FAILED', commit: null,
        detail: 'a merge commit was expected but the candidate was fast-forwarded' };
    }
    const firstParent = await runGit(input.path, ['rev-parse', '--verify', `${commit}^1`]);
    const containsCandidate = await isAncestor({
      repositoryRoot: input.path, ancestor: input.candidateCommit, descendant: commit,
    });
    if (firstParent.exitCode !== 0 || firstParent.stdout.trim() !== input.baselineCommit
      || !containsCandidate) {
      return { outcome: 'FAILED', commit: null,
        detail: 'the produced merge commit does not have the fixed baseline as its first parent' };
    }
  }
  return { outcome: input.strategy, commit, detail };
}

/**
 * Advances one local ref with a compare-and-swap, so a `dev` that moved between reading and
 * writing is refused instead of silently overwritten.
 */
export async function advanceLocalRef(input: {
  readonly repositoryRoot: string;
  readonly ref: string;
  readonly expectedCommit: string;
  readonly newCommit: string;
}): Promise<{ readonly advanced: boolean; readonly detail: string }> {
  const result = await runGit(input.repositoryRoot,
    ['update-ref', input.ref, input.newCommit, input.expectedCommit]);
  if (result.exitCode !== 0) {
    return { advanced: false,
      detail: result.stderr.trim() || `${input.ref} no longer points at the expected commit` };
  }
  const observed = await readLocalRefCommit({
    repositoryRoot: input.repositoryRoot, ref: input.ref,
  });
  if (observed !== input.newCommit) {
    return { advanced: false, detail: `${input.ref} did not move to the integrated commit` };
  }
  return { advanced: true, detail: `${input.ref} advanced to ${input.newCommit}` };
}

/**
 * Removes the integration worktree after a successful integration. Removal is not forced: if the
 * worktree is not clean it is reported and kept instead of destroyed.
 */
export async function removeIntegrationWorktree(input: {
  readonly repositoryRoot: string;
  readonly path: string;
}): Promise<{ readonly removed: boolean; readonly detail: string }> {
  const result = await runGit(input.repositoryRoot, ['worktree', 'remove', input.path]);
  if (result.exitCode !== 0) {
    return { removed: false,
      detail: result.stderr.trim() || `git worktree remove exited with ${result.exitCode}` };
  }
  return { removed: true, detail: 'integration worktree removed' };
}
