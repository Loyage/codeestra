import { GitInspectionError } from './errors.js';
import { listCheckedOutRefs } from './integration.js';

function gitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value === undefined) continue;
    // Ambient GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE must never redirect our commands.
    if (key.startsWith('GIT_')) continue;
    environment[key] = value;
  }
  return environment;
}

interface GitRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitRun> {
  const process = Bun.spawn(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: gitEnvironment(),
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

function splitNull(value: string): string[] {
  return value.split('\0').filter((field) => field.length > 0);
}

/** Porcelain v1 emits renames as two fields; only the new path is reported. */
function parseStatusRecords(stdout: string): readonly string[] {
  const fields = stdout.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return paths.sort();
}

export interface CheckedOutWorktree {
  readonly ref: string;
  readonly path: string;
}

/**
 * The worktree that has one branch checked out, or null when no worktree does.
 *
 * Advancing a branch with `git update-ref` while a worktree has it checked out moves the ref but
 * leaves that worktree's index and files on the old commit, which shows up as a staged deletion.
 * Promotion therefore never writes `main` through the ref: it looks the worktree up here and
 * fast-forwards it there, so the ref, the index and the files move together.
 */
export async function findCheckedOutWorktree(input: {
  readonly repositoryRoot: string;
  readonly ref: string;
}): Promise<CheckedOutWorktree | null> {
  if (!input.ref.startsWith('refs/heads/')) {
    throw new GitInspectionError('INVALID_REPOSITORY', 'A promotion ref must be a local branch');
  }
  const holders = (await listCheckedOutRefs(input.repositoryRoot))
    .filter((entry) => entry.ref === input.ref);
  if (holders.length === 0) return null;
  if (holders.length > 1) {
    throw new GitInspectionError('FOREIGN_RESOURCE',
      `${input.ref} is checked out in more than one worktree:`
      + ` ${holders.map((holder) => holder.path).join(', ')}`);
  }
  const holder = holders[0] as CheckedOutWorktree;
  return { ref: holder.ref, path: holder.path };
}

export interface PromotionWorktreeInspection {
  readonly path: string;
  /** Branch the worktree really has checked out, as an absolute ref. */
  readonly branchRef: string;
  readonly headCommit: string;
  /** Tracked files that differ from HEAD, sorted; these would be part of no commit. */
  readonly trackedModifications: readonly string[];
  /** Files Git does not track or ignore, sorted. They are reported, not overwritten. */
  readonly untrackedFiles: readonly string[];
  readonly clean: boolean;
}

/**
 * Reads the promotion target worktree and refuses to continue unless it is the worktree of the
 * expected branch, parked exactly on the expected commit, with no modified tracked files.
 *
 * The last part matters because a fast-forward merge into a worktree with local modifications can
 * either fail halfway or silently keep those modifications; a promotion must move a checkout the
 * user is not in the middle of editing.
 */
export async function inspectPromotionWorktree(input: {
  readonly path: string;
  readonly expectedRef: string;
  readonly expectedCommit: string;
}): Promise<PromotionWorktreeInspection> {
  const branchRef = await gitOrThrow(input.path, ['symbolic-ref', '-q', 'HEAD']);
  if (branchRef !== input.expectedRef) {
    throw new GitInspectionError('FOREIGN_RESOURCE',
      `Worktree ${input.path} has ${branchRef || 'a detached HEAD'} checked out, not ${input.expectedRef}`);
  }
  const headCommit = await gitOrThrow(input.path, ['rev-parse', '--verify', 'HEAD']);
  if (headCommit !== input.expectedCommit) {
    throw new GitInspectionError('STALE_BASE',
      `${input.expectedRef} is at ${headCommit} in ${input.path}, not the expected`
      + ` ${input.expectedCommit}`);
  }
  const status = await runGit(input.path,
    ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  if (status.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED',
      status.stderr.trim() || `git status exited with ${status.exitCode}`);
  }
  const untracked = await runGit(input.path, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED',
      untracked.stderr.trim() || `git ls-files exited with ${untracked.exitCode}`);
  }
  const trackedModifications = parseStatusRecords(status.stdout);
  return {
    path: input.path,
    branchRef,
    headCommit,
    trackedModifications,
    untrackedFiles: splitNull(untracked.stdout).sort(),
    clean: trackedModifications.length === 0,
  };
}

export type PromotionMergeOutcome = 'FAST_FORWARD' | 'FAILED';

export interface PromotionMergeResult {
  readonly outcome: PromotionMergeOutcome;
  /** Commit `HEAD` and the branch ended on; null when the merge did not produce one. */
  readonly commit: string | null;
  readonly detail: string;
}

/**
 * Fast-forwards the checked-out promotion target to the fixed candidate commit inside that
 * worktree, so the branch ref, the index and the working files move together (ADR-0009 D03).
 *
 * The candidate is passed as an object ID rather than as a ref name: the caller already fixed and
 * validated that commit, and a `dev` that moved since must never be what lands on `main`. After a
 * success the branch ref is read back and must be the candidate — "git said ok" is not evidence
 * that the ref moved.
 */
export async function fastForwardCheckedOutWorktree(input: {
  readonly path: string;
  readonly expectedRef: string;
  readonly expectedCommit: string;
  readonly candidateCommit: string;
}): Promise<PromotionMergeResult> {
  const before = await inspectPromotionWorktree({
    path: input.path, expectedRef: input.expectedRef, expectedCommit: input.expectedCommit,
  });
  if (!before.clean) {
    return { outcome: 'FAILED', commit: null,
      detail: `${input.path} has ${before.trackedModifications.length} modified tracked file(s):`
        + ` ${before.trackedModifications.slice(0, 10).join(', ')}` };
  }
  const result = await runGit(input.path, ['merge', '--ff-only', input.candidateCommit]);
  if (result.exitCode !== 0) {
    return { outcome: 'FAILED', commit: null,
      detail: (result.stderr.trim() || result.stdout.trim()
        || `git merge --ff-only exited with ${result.exitCode}`).slice(0, 4_000) };
  }
  const branchRef = await runGit(input.path, ['symbolic-ref', '-q', 'HEAD']);
  const head = await runGit(input.path, ['rev-parse', '--verify', 'HEAD']);
  const refCommit = await runGit(input.path, ['rev-parse', '--verify', input.expectedRef]);
  if (head.exitCode !== 0 || refCommit.exitCode !== 0 || branchRef.stdout.trim() !== input.expectedRef
    || head.stdout.trim() !== input.candidateCommit || refCommit.stdout.trim() !== input.candidateCommit) {
    return { outcome: 'FAILED', commit: null,
      detail: `${input.expectedRef} did not end up on ${input.candidateCommit} in ${input.path}`
        + ` (HEAD ${head.stdout.trim() || 'unreadable'}, ref ${refCommit.stdout.trim() || 'unreadable'})` };
  }
  const after = await runGit(input.path, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  const leftover = after.exitCode === 0 ? parseStatusRecords(after.stdout) : [];
  return { outcome: 'FAST_FORWARD', commit: input.candidateCommit,
    detail: `${input.expectedRef} fast-forwarded to ${input.candidateCommit} in ${input.path}`
      + (leftover.length === 0
        ? ''
        : `; the checkout still reports ${leftover.length} modified tracked file(s):`
          + ` ${leftover.slice(0, 10).join(', ')}`) };
}
