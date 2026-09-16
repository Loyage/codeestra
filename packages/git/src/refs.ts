import { GitInspectionError } from './errors.js';

/**
 * The two Git questions the Runtime asks about ordinary local refs (ADR-0062).
 *
 * These are the surviving half of the former integration helper module: the product no longer
 * creates merge worktrees, advances a long-lived `dev` ref or inspects a dev checkout, but a Task
 * baseline is still a local branch whose commit is read from the project folder, and a dependency
 * edge is still decided by asking Git whether one commit is reachable from that branch.
 */

interface GitRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitRun> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value === undefined) continue;
    // Ambient GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE must never redirect our commands.
    if (key.startsWith('GIT_')) continue;
    environment[key] = value;
  }
  const process = Bun.spawn(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: environment,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
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

export interface CheckedOutRef {
  readonly ref: string;
  readonly path: string;
}

/**
 * Refs Git currently has checked out in any worktree of this repository. A caller that is about to
 * move or delete one of these refs without going through that worktree has to refuse instead of
 * creating an index/files state that disagrees with the ref.
 */
export async function listCheckedOutRefs(repositoryRoot: string): Promise<readonly CheckedOutRef[]> {
  const result = await runGit(repositoryRoot, ['worktree', 'list', '--porcelain', '-z']);
  if (result.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED',
      result.stderr.trim() || `git worktree list exited with ${result.exitCode}`);
  }
  const checkedOut: CheckedOutRef[] = [];
  for (const record of result.stdout.split('\0\0')) {
    if (record.length === 0) continue;
    const fields = record.split('\0');
    const path = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
    const ref = fields.find((field) => field.startsWith('branch '))?.slice('branch '.length);
    if (path !== undefined && ref !== undefined && ref.length > 0) checkedOut.push({ ref, path });
  }
  return checkedOut;
}

/**
 * The commit `HEAD` points at, or null when it cannot be resolved at all (an unborn repository).
 *
 * It exists to tell "this checkout has a detached HEAD" apart from "this is not a repository":
 * `git symbolic-ref -q HEAD` fails in both cases and `inspectRepository` therefore refuses both, but
 * only the first one is a Task-baseline fact a user can act on (`TASK_BASE_REF_UNRESOLVED`).
 */
export async function readHeadCommitOrNull(repositoryRoot: string): Promise<string | null> {
  const result = await runGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD']);
  if (result.exitCode === 0) return result.stdout.trim();
  if (result.exitCode === 1 || result.exitCode === 128) return null;
  throw new GitInspectionError('COMMAND_FAILED',
    result.stderr.trim() || `git rev-parse exited with ${result.exitCode}`);
}
