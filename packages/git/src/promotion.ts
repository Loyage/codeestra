import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { GitInspectionError } from './errors.js';
import { listCheckedOutRefs, readLocalRefCommit } from './integration.js';

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

/**
 * The dev clone: the second checkout of the same origin a promotion pushes its fixed candidate
 * from (ADR-0047 D05). The Runtime's own repository (the main checkout) no longer holds the dev
 * candidate object, so the push happens where the object lives.
 *
 * Every fact the promotion depends on is read here rather than assumed: the worktree root, the
 * Git common directory (so "another clone" can be told apart from "a worktree of this clone"),
 * the branch HEAD really is on, the local `dev` commit, the origin URL, and whether the checkout
 * has modified tracked files.
 */
export interface DevCloneInspection {
  /** Canonical worktree root, as `git rev-parse --show-toplevel` resolves it. */
  readonly path: string;
  readonly gitCommonDir: string;
  readonly headCommit: string;
  /** The branch HEAD is symbolically on, as an absolute ref. */
  readonly branchRef: string | null;
  /** Commit of the dev branch in this clone, or null when it has no such branch. */
  readonly devRefCommit: string | null;
  readonly objectFormat: 'sha1' | 'sha256';
  /** Tracked files that differ from HEAD, sorted; the promotion refuses to push a dirty clone. */
  readonly trackedModifications: readonly string[];
  readonly clean: boolean;
}

export async function inspectDevClone(input: {
  readonly path: string;
  readonly devRef: string;
}): Promise<DevCloneInspection> {
  if (!input.devRef.startsWith('refs/heads/')) {
    throw new GitInspectionError('INVALID_REPOSITORY', 'The dev ref must be a local branch');
  }
  let requestedPath: string;
  try {
    requestedPath = await realpath(input.path);
  } catch {
    throw new GitInspectionError('INVALID_REPOSITORY', 'The dev clone path does not exist');
  }
  const rootOutput = await gitOrThrow(requestedPath, ['rev-parse', '--show-toplevel']);
  const path = await realpath(rootOutput);
  const commonOutput = await gitOrThrow(path, ['rev-parse', '--git-common-dir']);
  const gitCommonDir = await realpath(
    isAbsolute(commonOutput) ? commonOutput : resolve(path, commonOutput));
  const objectFormat = await gitOrThrow(path, ['rev-parse', '--show-object-format']);
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw new GitInspectionError('COMMAND_FAILED', `Unsupported Git object format: ${objectFormat}`);
  }
  const branch = await runGit(path, ['symbolic-ref', '-q', 'HEAD']);
  const branchRef = branch.exitCode === 0 && branch.stdout.trim().length > 0
    ? branch.stdout.trim()
    : null;
  const headCommit = await gitOrThrow(path, ['rev-parse', '--verify', 'HEAD']);
  const status = await runGit(path, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  if (status.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED',
      status.stderr.trim() || `git status exited with ${status.exitCode}`);
  }
  const trackedModifications = parseStatusRecords(status.stdout);
  return {
    path,
    gitCommonDir,
    headCommit,
    branchRef,
    devRefCommit: await readLocalRefCommit({ repositoryRoot: path, ref: input.devRef }),
    objectFormat,
    trackedModifications,
    clean: trackedModifications.length === 0,
  };
}

export interface RemoteRefRead {
  /** False when the remote itself could not be reached or refused the query. */
  readonly reachable: boolean;
  /** Commit the remote reports for that ref; null when the ref does not exist there. */
  readonly commit: string | null;
  readonly detail: string | null;
}

/** The remote a promotion talks to. ADR-0047 fixes it: there is no configurable push target. */
export const promotionRemote = 'origin';

/**
 * Reads one ref from the remote with `git ls-remote`: it writes nothing locally, so a readback can
 * never be confused with the push that preceded it. A missing ref and an unreachable remote are
 * reported separately — "the branch is not there yet" is not "the network is down".
 */
export async function readRemoteRef(input: {
  readonly repositoryRoot: string;
  readonly remote?: string;
  readonly ref: string;
}): Promise<RemoteRefRead> {
  const result = await runGit(input.repositoryRoot,
    ['ls-remote', '--refs', input.remote ?? promotionRemote, input.ref]);
  if (result.exitCode !== 0) {
    return { reachable: false, commit: null,
      detail: (result.stderr.trim() || result.stdout.trim()
        || `git ls-remote exited with ${result.exitCode}`).slice(0, 2_000) };
  }
  const line = result.stdout.split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.endsWith(`\t${input.ref}`) || entry.endsWith(` ${input.ref}`));
  if (line === undefined) return { reachable: true, commit: null, detail: null };
  return { reachable: true, commit: line.split(/\s+/)[0] ?? null, detail: null };
}

/** The origin URL a clone fetches from, or null when it has no such remote. */
export async function readRemoteUrl(input: {
  readonly repositoryRoot: string;
  readonly remote?: string;
}): Promise<string | null> {
  const result = await runGit(input.repositoryRoot,
    ['remote', 'get-url', input.remote ?? promotionRemote]);
  if (result.exitCode !== 0) return null;
  const url = result.stdout.trim();
  return url.length === 0 ? null : url;
}

/** True when this repository holds that commit object. */
export async function commitExists(input: {
  readonly repositoryRoot: string;
  readonly commit: string;
}): Promise<boolean> {
  const result = await runGit(input.repositoryRoot,
    ['cat-file', '-e', `${input.commit}^{commit}`]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1 || result.exitCode === 128) return false;
  throw new GitInspectionError('COMMAND_FAILED',
    result.stderr.trim() || `git cat-file exited with ${result.exitCode}`);
}

export interface RemotePushResult {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Pushes exactly one already-fixed commit to exactly one ref on the remote (ADR-0047 D02).
 *
 * The source side is an object ID, not a branch name, so nothing else can travel with the push;
 * `--force` is never passed, so the remote's own fast-forward rule decides whether the update is
 * allowed and a non-fast-forward is a refusal rather than a rewrite. The command's exit code is
 * not treated as proof of the update: the caller reads the ref back with `readRemoteRef`.
 */
export async function pushCommitToRemote(input: {
  readonly repositoryRoot: string;
  readonly remote?: string;
  readonly commit: string;
  readonly ref: string;
}): Promise<RemotePushResult> {
  if (!input.ref.startsWith('refs/heads/')) {
    throw new GitInspectionError('INVALID_REPOSITORY', 'A promotion pushes a local branch ref');
  }
  const result = await runGit(input.repositoryRoot,
    ['push', '--porcelain', input.remote ?? promotionRemote,
      `${input.commit}:${input.ref}`]);
  if (result.exitCode !== 0) {
    return { ok: false,
      detail: (result.stderr.trim() || result.stdout.trim()
        || `git push exited with ${result.exitCode}`).slice(0, 4_000) };
  }
  return { ok: true,
    detail: `pushed ${input.commit} to ${input.remote ?? promotionRemote} ${input.ref}` };
}
