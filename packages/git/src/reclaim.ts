import { lstat, realpath } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { GitInspectionError } from './errors.js';

/**
 * Reclaiming Runtime-owned resources is deliberately the narrowest possible Git/FS surface:
 * a path is deleted only when it is canonical, lives strictly inside one Runtime-owned root,
 * is registered in Git as the worktree the database recorded, and still points at the branch
 * or detached commit the record attests. Anything else is reported as a refusal, never deleted.
 *
 * Nothing here runs `git clean`, `git reset --hard`, or deletes a branch.
 */

function gitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value === undefined) continue;
    // Ambient GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE must never redirect these commands.
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export interface OwnedPathInspection {
  /** The canonical owned root the path was checked against. */
  readonly ownedRoot: string;
  readonly path: string;
  readonly exists: boolean;
  /** True when the resource path itself is a symlink; such a path is never removed. */
  readonly symlink: boolean;
  readonly canonicalPath: string | null;
  readonly insideOwnedRoot: boolean;
}

/**
 * Canonicalizes the owned root and the resource path and decides whether the path really lives
 * inside the root. A symlinked resource path is reported instead of followed, because following
 * it is exactly how a removal would escape the Runtime data directory.
 */
export async function inspectOwnedPath(input: {
  readonly ownedRoot: string;
  readonly path: string;
}): Promise<OwnedPathInspection> {
  if (!isAbsolute(input.ownedRoot) || !isAbsolute(input.path)) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', 'Owned root and resource path must be absolute');
  }
  const requestedRoot = resolve(input.ownedRoot);
  const requestedPath = resolve(input.path);
  const rootExists = await pathExists(requestedRoot);
  // A symlinked ancestor (on macOS `/tmp` resolves to `/private/tmp`) is normal; only the root
  // and the resource path themselves must not be symlinks.
  const ownedRoot = rootExists ? await realpath(requestedRoot) : requestedRoot;
  const exists = await pathExists(requestedPath);
  if (!exists) {
    return {
      ownedRoot,
      path: requestedPath,
      exists: false,
      symlink: false,
      canonicalPath: null,
      insideOwnedRoot: requestedPath.startsWith(`${ownedRoot}/`),
    };
  }
  const stats = await lstat(requestedPath);
  if (stats.isSymbolicLink()) {
    return {
      ownedRoot,
      path: requestedPath,
      exists: true,
      symlink: true,
      canonicalPath: await realpath(requestedPath),
      insideOwnedRoot: false,
    };
  }
  const canonicalPath = await realpath(requestedPath);
  return {
    ownedRoot,
    path: requestedPath,
    exists: true,
    symlink: false,
    canonicalPath,
    insideOwnedRoot: canonicalPath !== ownedRoot && canonicalPath.startsWith(`${ownedRoot}/`),
  };
}

export interface OwnedWorktreeRegistration {
  readonly registered: boolean;
  /** The path Git reports for the matching registration, or null when there is none. */
  readonly registeredPath: string | null;
  /** The checked-out branch ref, or null for a detached worktree. */
  readonly branchRef: string | null;
  readonly detached: boolean;
  readonly headCommit: string | null;
  readonly pathExists: boolean;
}

interface WorktreeRecord {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
}

function parseWorktreeList(stdout: string): readonly WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  for (const record of stdout.split('\0\0')) {
    if (record.length === 0) continue;
    const fields = record.split('\0');
    const path = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined) continue;
    records.push({
      path,
      head: fields.find((field) => field.startsWith('HEAD '))?.slice('HEAD '.length) ?? null,
      branch: fields.find((field) => field.startsWith('branch '))?.slice('branch '.length) ?? null,
    });
  }
  return records;
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

/**
 * Finds the Git worktree registration for one Runtime-owned path. The registration is the
 * evidence that a directory is a checkout this repository owns; a matching directory without a
 * registration is a foreign directory and is never deleted by the reclamation path.
 */
export async function inspectOwnedWorktreeRegistration(input: {
  readonly repositoryRoot: string;
  readonly path: string;
}): Promise<OwnedWorktreeRegistration> {
  const list = await gitOrThrow(input.repositoryRoot, ['worktree', 'list', '--porcelain', '-z']);
  const match = parseWorktreeList(list).find((record) => samePath(record.path, input.path));
  return {
    registered: match !== undefined,
    registeredPath: match?.path ?? null,
    branchRef: match?.branch ?? null,
    detached: match !== undefined && match.branch === null,
    headCommit: match?.head ?? null,
    pathExists: await pathExists(input.path),
  };
}

export interface OwnedWorktreeState {
  readonly available: boolean;
  readonly headCommit: string | null;
  /** Tracked files changed relative to HEAD; a dirty worktree is a scene, not garbage. */
  readonly trackedModifications: readonly string[];
  /** Files Git does not ignore and does not track. */
  readonly untrackedFiles: readonly string[];
  readonly clean: boolean;
}

/** Porcelain v1 emits renames as two NUL-separated fields. */
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

function splitNull(value: string): string[] {
  return value.split('\0').filter((field) => field.length > 0);
}

/** Reads whether a worktree still holds uncommitted work; a missing path is not "clean". */
export async function inspectWorktreeState(input: {
  readonly path: string;
}): Promise<OwnedWorktreeState> {
  if (!(await pathExists(input.path))) {
    return { available: false, headCommit: null, trackedModifications: [], untrackedFiles: [],
      clean: false };
  }
  const head = await runGit(input.path, ['rev-parse', '--verify', 'HEAD']);
  if (head.exitCode !== 0) {
    // A directory that Git cannot read (no repository, corrupt checkout) is reported as
    // unavailable and unclean: callers must never treat it as an empty, reclaimable worktree.
    return { available: false, headCommit: null, trackedModifications: [], untrackedFiles: [],
      clean: false };
  }
  // Porcelain output starts with a status column that may be a space, so it must not be trimmed.
  const status = await runGit(input.path, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
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
  const untrackedFiles = splitNull(untracked.stdout).sort();
  return {
    available: true,
    headCommit: head.stdout.trim(),
    trackedModifications,
    untrackedFiles,
    clean: trackedModifications.length === 0 && untrackedFiles.length === 0,
  };
}

export type OwnedWorktreeRemovalOutcome = 'REMOVED' | 'ALREADY_ABSENT' | 'REFUSED' | 'FAILED';

export interface OwnedWorktreeRemoval {
  readonly outcome: OwnedWorktreeRemovalOutcome;
  readonly reasonCode: string;
  readonly detail: string;
  readonly path: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

function refusal(
  path: string,
  reasonCode: string,
  detail: string,
  evidence: Readonly<Record<string, unknown>>,
): OwnedWorktreeRemoval {
  return { outcome: 'REFUSED', reasonCode, detail, path, evidence };
}

/**
 * Removes one Runtime-owned worktree after every ownership fact still agrees at removal time.
 * The invariants are re-established here instead of trusting the caller, because a database row
 * can be stale and a path can be swapped for a symlink between planning and acting.
 *
 * The branch is never deleted; only the checkout directory and its Git registration go away.
 */
export async function removeOwnedWorktree(input: {
  readonly repositoryRoot: string;
  readonly ownedRoot: string;
  readonly path: string;
  /** Required for an owned Task worktree: the registration must still be on this branch. */
  readonly expectedBranchRef?: string;
  /** Required for a detached copy: the registration must be detached at exactly this commit. */
  readonly expectedDetachedCommit?: string;
}): Promise<OwnedWorktreeRemoval> {
  const owned = await inspectOwnedPath({ ownedRoot: input.ownedRoot, path: input.path });
  if (owned.symlink) {
    return refusal(owned.path, 'SYMLINK_ESCAPE',
      'The resource path is a symlink; refusing to follow it out of the Runtime data directory',
      { path: owned.path, canonicalPath: owned.canonicalPath });
  }
  if (owned.exists && !owned.insideOwnedRoot) {
    return refusal(owned.path, 'PATH_OUTSIDE_OWNED_ROOT',
      'The resource path resolves outside the Runtime-owned root',
      { path: owned.path, ownedRoot: owned.ownedRoot, canonicalPath: owned.canonicalPath });
  }
  const expectedPath = owned.canonicalPath ?? owned.path;
  const registration = await inspectOwnedWorktreeRegistration({
    repositoryRoot: input.repositoryRoot,
    path: input.path,
  });
  const evidence: Record<string, unknown> = {
    ownedRoot: owned.ownedRoot,
    path: owned.path,
    canonicalPath: expectedPath,
    registered: registration.registered,
    registeredPath: registration.registeredPath,
    branchRef: registration.branchRef,
    detached: registration.detached,
    headCommit: registration.headCommit,
    pathExists: registration.pathExists,
  };
  if (!registration.registered) {
    if (!registration.pathExists) {
      return { outcome: 'ALREADY_ABSENT', reasonCode: 'NOT_REGISTERED_AND_MISSING',
        detail: 'The worktree is neither registered nor present on disk', path: expectedPath,
        evidence };
    }
    return refusal(expectedPath, 'UNREGISTERED_DIRECTORY',
      'A directory exists but Git does not register it as a worktree of this repository',
      evidence);
  }
  if (registration.registeredPath === null || !samePath(registration.registeredPath, expectedPath)) {
    return refusal(expectedPath, 'REGISTRATION_PATH_MISMATCH',
      'The Git worktree registration does not match the recorded path', evidence);
  }
  if (input.expectedBranchRef !== undefined && registration.branchRef !== input.expectedBranchRef) {
    return refusal(expectedPath, 'BRANCH_MISMATCH',
      `The worktree is on ${registration.branchRef ?? 'a detached HEAD'},`
      + ` not ${input.expectedBranchRef}`, evidence);
  }
  if (input.expectedDetachedCommit !== undefined) {
    if (!registration.detached || registration.headCommit !== input.expectedDetachedCommit) {
      return refusal(expectedPath, 'HEAD_MISMATCH',
        'The detached worktree does not point at the commit its record attests', evidence);
    }
  }
  // A registration whose directory is already gone only needs its stale record pruned.
  if (!registration.pathExists) {
    await runGit(input.repositoryRoot, ['worktree', 'prune']);
    const afterPrune = await inspectOwnedWorktreeRegistration({
      repositoryRoot: input.repositoryRoot,
      path: input.path,
    });
    if (afterPrune.registered || afterPrune.pathExists) {
      return { outcome: 'FAILED', reasonCode: 'PRUNE_FAILED',
        detail: 'The stale worktree registration could not be pruned', path: expectedPath, evidence };
    }
    return { outcome: 'REMOVED', reasonCode: 'REGISTRATION_PRUNED',
      detail: 'The worktree directory was already gone; its registration was pruned',
      path: expectedPath, evidence };
  }

  const removal = await runGit(input.repositoryRoot, ['worktree', 'remove', '--force', expectedPath]);
  if (removal.exitCode !== 0 && await pathExists(expectedPath)) {
    // `git worktree remove` refuses for reasons that do not affect ownership (for example a nested
    // submodule). The path is already proven to be this worktree, so removing the directory and
    // pruning the registration is the bounded fallback; the branch is untouched either way.
    try {
      rmSync(expectedPath, { recursive: true, force: true });
    } catch (error) {
      return { outcome: 'FAILED', reasonCode: 'REMOVAL_FAILED',
        detail: `${removal.stderr.trim() || 'git worktree remove failed'}:`
          + ` ${error instanceof Error ? error.message : String(error)}`,
        path: expectedPath, evidence };
    }
  }
  await runGit(input.repositoryRoot, ['worktree', 'prune']);
  const after = await inspectOwnedWorktreeRegistration({
    repositoryRoot: input.repositoryRoot,
    path: input.path,
  });
  if (after.registered || after.pathExists) {
    return { outcome: 'FAILED', reasonCode: 'REMOVAL_UNCONFIRMED',
      detail: 'The worktree was still registered or present after removal',
      path: expectedPath, evidence };
  }
  return { outcome: 'REMOVED', reasonCode: 'REMOVED',
    detail: 'The worktree directory was removed and its registration pruned',
    path: expectedPath, evidence };
}
