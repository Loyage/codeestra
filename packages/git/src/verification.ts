import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { GitInspectionError } from './errors.js';

const stableId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function runGit(cwd: string, args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '' },
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
      result.stderr.trim() || `git ${args[0] ?? ''} exited with ${result.exitCode}`);
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

async function assertNotSymlink(path: string, message: string): Promise<void> {
  if ((await pathExists(path)) && (await lstat(path)).isSymbolicLink()) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', message);
  }
}

export interface RefFileContent {
  readonly commit: string;
  /** File content at `commit`, or null when the path does not exist there. */
  readonly text: string | null;
}

/**
 * Reads one file from the exact commit a ref resolves to. The ref is resolved first, so the
 * returned commit is the evidence for what was read; a missing file is not an error.
 */
export async function readRefFile(input: {
  readonly repositoryRoot: string;
  readonly ref: string;
  readonly path: string;
}): Promise<RefFileContent> {
  const commit = await gitOrThrow(input.repositoryRoot, ['rev-parse', '--verify', `${input.ref}^{commit}`]);
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new GitInspectionError('COMMAND_FAILED', `Could not resolve ${input.ref} to a commit`);
  }
  const object = await runGit(input.repositoryRoot, ['cat-file', '-t', `${commit}:${input.path}`]);
  if (object.exitCode !== 0) {
    const commitType = await runGit(input.repositoryRoot, ['cat-file', '-t', commit]);
    if (commitType.exitCode !== 0 || commitType.stdout.trim() !== 'commit') {
      throw new GitInspectionError('INVALID_REPOSITORY',
        `${input.ref} does not resolve to an existing commit`);
    }
    return { commit, text: null };
  }
  if (object.stdout.trim() !== 'blob') {
    throw new GitInspectionError('INVALID_REPOSITORY', `${input.path} is not a file in ${commit}`);
  }
  const content = await runGit(input.repositoryRoot, ['cat-file', 'blob', `${commit}:${input.path}`]);
  if (content.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED', `Could not read ${input.path} at ${commit}`);
  }
  return { commit, text: content.stdout };
}

/** Reads the tree of a commit without creating a checkout; used before a run is queued. */
export async function readCommitTree(input: {
  readonly repositoryRoot: string;
  readonly commit: string;
}): Promise<string> {
  const type = await runGit(input.repositoryRoot, ['cat-file', '-t', `${input.commit}^{commit}`]);
  if (type.exitCode !== 0 || type.stdout.trim() !== 'commit') {
    throw new GitInspectionError('STALE_BASE', `Tested commit ${input.commit} does not exist`);
  }
  const tree = await gitOrThrow(input.repositoryRoot, ['rev-parse', '--verify', `${input.commit}^{tree}`]);
  if (!/^[0-9a-f]{40,64}$/.test(tree)) {
    throw new GitInspectionError('COMMAND_FAILED', 'Could not read the tested commit tree');
  }
  return tree;
}

export interface VerificationCopy {
  readonly path: string;
  readonly commit: string;
  readonly tree: string;
}

/**
 * Creates one detached checkout of the frozen tested commit inside the Runtime data
 * directory. The copy is never the Task worktree, so verification can neither see
 * uncommitted Agent edits nor change the branch being judged.
 */
export async function createVerificationCopy(input: {
  readonly repositoryRoot: string;
  readonly copiesRoot: string;
  readonly projectId: string;
  readonly verificationId: string;
  readonly testedCommit: string;
}): Promise<VerificationCopy> {
  for (const [name, value] of [['projectId', input.projectId],
    ['verificationId', input.verificationId]] as const) {
    if (!stableId.test(value)) throw new GitInspectionError('FOREIGN_RESOURCE', `${name} must be a UUID`);
  }
  if (!/^[0-9a-f]{40,64}$/.test(input.testedCommit)) {
    throw new GitInspectionError('STALE_BASE', 'Tested commit must be a full object ID');
  }
  if (!isAbsolute(input.copiesRoot)) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', 'Verification copies root must be absolute');
  }
  await assertNotSymlink(resolve(input.copiesRoot), 'Verification copies root must not be a symlink');
  // The Runtime does not pre-create its copies root, so the first run creates it here.
  await mkdir(resolve(input.copiesRoot), { recursive: true, mode: 0o700 });
  // Resolve the root once so the copy path is canonical even when an ancestor such as
  // /var is itself a symlink; the copy is still created only inside this resolved root.
  const root = await realpath(resolve(input.copiesRoot));
  const projectDirectory = join(root, input.projectId);
  const path = join(projectDirectory, input.verificationId);
  if (!path.startsWith(`${root}/`)) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', 'Verification copy escaped the Runtime copies root');
  }
  await assertNotSymlink(projectDirectory, 'Verification project directory must not be a symlink');
  if (await pathExists(path)) {
    throw new GitInspectionError('FOREIGN_RESOURCE', `Verification copy path already exists: ${path}`);
  }
  await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(projectDirectory);
  if (canonicalParent !== projectDirectory || !canonicalParent.startsWith(`${root}/`)) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', 'Verification copy parent escaped the copies root');
  }

  const commitExists = await runGit(input.repositoryRoot, ['cat-file', '-e', `${input.testedCommit}^{commit}`]);
  if (commitExists.exitCode !== 0) {
    throw new GitInspectionError('STALE_BASE', `Tested commit ${input.testedCommit} does not exist`);
  }
  const added = await runGit(input.repositoryRoot,
    ['worktree', 'add', '--detach', path, input.testedCommit]);
  if (added.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED',
      added.stderr.trim() || `git worktree add exited with ${added.exitCode}`, true);
  }
  const canonicalPath = await realpath(path);
  if (canonicalPath !== path) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', 'Verification copy path resolved unexpectedly', true);
  }
  const head = await gitOrThrow(canonicalPath, ['rev-parse', '--verify', 'HEAD']);
  const tree = await gitOrThrow(canonicalPath, ['rev-parse', '--verify', 'HEAD^{tree}']);
  if (head !== input.testedCommit) {
    throw new GitInspectionError('FOREIGN_RESOURCE',
      'Verification copy does not point at the tested commit', true);
  }
  return { path: canonicalPath, commit: head, tree };
}

export interface VerificationCopyInspection {
  readonly headCommit: string;
  /** Tracked files the commands changed relative to the tested commit, sorted. */
  readonly trackedModifications: readonly string[];
  /** Files the commands created that Git does not ignore, sorted. */
  readonly untrackedFiles: readonly string[];
  readonly clean: boolean;
}

function splitNull(value: string): string[] {
  return value.split('\0').filter((field) => field.length > 0);
}

/** Reads tracked modifications of a copy. Porcelain v1 emits renames as two fields. */
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

/** Detects whether verification commands changed the tree they were judging. */
export async function inspectVerificationCopy(input: {
  readonly path: string;
  readonly testedCommit: string;
}): Promise<VerificationCopyInspection> {
  const headCommit = await gitOrThrow(input.path, ['rev-parse', '--verify', 'HEAD']);
  // Porcelain output starts with a status column that may be a space, so it must not be
  // trimmed: only NUL separators are dropped.
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
  const untrackedFiles = splitNull(untracked.stdout).sort();
  return {
    headCommit,
    trackedModifications,
    untrackedFiles,
    clean: headCommit === input.testedCommit && trackedModifications.length === 0,
  };
}

/**
 * Removes one verification copy. Only paths inside the Runtime copies root are touched, so
 * an unexpected path can never delete a user checkout.
 */
export async function removeVerificationCopy(input: {
  readonly repositoryRoot: string;
  readonly copiesRoot: string;
  readonly path: string;
}): Promise<{ readonly removed: boolean; readonly detail: string }> {
  const root = await realpath(resolve(input.copiesRoot));
  const path = resolve(input.path);
  if (!path.startsWith(`${root}/`)) {
    return { removed: false, detail: `refused to remove a path outside the copies root: ${path}` };
  }
  const removal = await runGit(input.repositoryRoot, ['worktree', 'remove', '--force', path]);
  if (removal.exitCode !== 0) {
    if (!(await pathExists(path))) {
      await runGit(input.repositoryRoot, ['worktree', 'prune']);
      return { removed: true, detail: 'the copy was already gone' };
    }
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      return { removed: false,
        detail: error instanceof Error ? error.message : String(error) };
    }
  }
  await runGit(input.repositoryRoot, ['worktree', 'prune']);
  return { removed: !(await pathExists(path)), detail: 'removed the verification copy' };
}
