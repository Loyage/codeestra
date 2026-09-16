import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { RepositoryIdentity } from '@codeestra/contracts';
import { GitInspectionError } from './errors.js';

export { GitInspectionError } from './errors.js';
export type { GitErrorCode } from './errors.js';
export {
  changeSetPaths,
  createResultCommit,
  inspectChangeSet,
  inspectResultCommit,
  readHeadCommit,
  resolveCommitIdentity,
  sameChangeSetEntries,
  stageResultChangeSet,
} from './result-commit.js';
export type {
  ChangeSet,
  ChangeSetEntry,
  ChangeSetStatus,
  CommitIdentity,
  InspectedResultCommit,
  ResultCommitOutcome,
} from './result-commit.js';
export {
  classifySensitivePath,
  classifySensitivePaths,
  sensitivePathPolicyVersion,
} from './sensitive-paths.js';
export type { SensitivePathHit } from './sensitive-paths.js';
export {
  isAncestor,
  listCheckedOutRefs,
  readHeadCommitOrNull,
  readLocalRefCommit,
} from './refs.js';
export type { CheckedOutRef } from './refs.js';
export {
  createVerificationCopy,
  inspectVerificationCopy,
  readCommitTree,
  readRefFile,
  removeVerificationCopy,
} from './verification.js';
export type {
  RefFileContent,
  VerificationCopy,
  VerificationCopyInspection,
} from './verification.js';
export {
  inspectOwnedPath,
  inspectOwnedWorktreeRegistration,
  inspectWorktreeState,
  removeOwnedWorktree,
} from './reclaim.js';
export type {
  OwnedPathInspection,
  OwnedWorktreeRegistration,
  OwnedWorktreeRemoval,
  OwnedWorktreeRemovalOutcome,
  OwnedWorktreeState,
} from './reclaim.js';
export { deleteOwnedTaskBranch } from './purge.js';
export type { OwnedBranchRemoval } from './purge.js';
export {
  inspectOwnedWorktreeRebuild,
  inspectTaskBranch,
  rebuildOwnedWorktree,
} from './rebuild.js';
export type {
  OwnedWorktreeRebuild,
  OwnedWorktreeRebuildObservation,
  OwnedWorktreeRebuildOutcome,
  TaskBranchEvidence,
  TaskBranchRelation,
} from './rebuild.js';

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '' },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new GitInspectionError(
      args.includes('HEAD') ? 'UNBORN_MAIN' : 'INVALID_REPOSITORY',
      stderr.trim() || `git exited with ${exitCode}`,
    );
  }
  return stdout.trim();
}

/**
 * Remote-tracking refs whose history contains `commit` (ADR-0060).
 *
 * This is the fact behind "is that commit already published?": an empty answer means the commit (and
 * whatever only it reaches) exists **only in this clone**, so deleting the local ref it hangs off
 * would lose it. One `for-each-ref` call; no ref is ever updated.
 */
export async function listRemoteRefsContainingCommit(input: {
  readonly repositoryRoot: string;
  readonly commit: string;
}): Promise<readonly string[]> {
  const output = await git(input.repositoryRoot, ['for-each-ref', '--contains', input.commit,
    '--format=%(refname)', 'refs/remotes/']);
  return output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  const process = Bun.spawn(['git', '-C', cwd, 'show-ref', '--verify', '--quiet', ref], {
    stdout: 'ignore', stderr: 'pipe', env: { PATH: Bun.env.PATH ?? '' },
  });
  const stderr = new Response(process.stderr).text();
  const exitCode = await process.exited;
  if (exitCode === 0) return true;
  if (exitCode === 1) return false;
  throw new GitInspectionError('COMMAND_FAILED', (await stderr).trim() || `git exited with ${exitCode}`);
}

async function assertDirectoryNotSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new GitInspectionError('UNSAFE_CHECKOUT', `Workspace parent must not be a symlink: ${path}`);
    }
  } catch (error) {
    if (error instanceof GitInspectionError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function inspectRepository(path: string): Promise<RepositoryIdentity> {
  let requestedPath: string;
  try {
    requestedPath = await realpath(path);
  } catch {
    throw new GitInspectionError('INVALID_REPOSITORY', 'Project path does not exist');
  }
  const rootOutput = await git(requestedPath, ['rev-parse', '--show-toplevel']);
  const repoRoot = await realpath(rootOutput);
  const commonOutput = await git(repoRoot, ['rev-parse', '--git-common-dir']);
  const gitCommonDir = await realpath(isAbsolute(commonOutput) ? commonOutput : resolve(repoRoot, commonOutput));
  const objectFormat = await git(repoRoot, ['rev-parse', '--show-object-format']);
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw new GitInspectionError('COMMAND_FAILED', `Unsupported Git object format: ${objectFormat}`);
  }
  const mainRef = await git(repoRoot, ['symbolic-ref', '-q', 'HEAD']);
  const headCommit = await git(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  return { repoRoot, gitCommonDir, mainRef, objectFormat, headCommit };
}

/**
 * Reads the repository identity plus the commit of one local branch. The branch is reported
 * separately so a baseline ref is never confused with the ref whose policy governs a project:
 * `dev` is the development baseline, while the verification policy lives on `main` (ADR-0009).
 */
export async function inspectBaseRef(path: string, baseRef: string): Promise<{
  readonly repository: RepositoryIdentity;
  readonly commit: string;
}> {
  if (!baseRef.startsWith('refs/heads/')) {
    throw new GitInspectionError('INVALID_REPOSITORY', 'Configured base ref must be a local branch');
  }
  const repository = await inspectRepository(path);
  if (!await refExists(repository.repoRoot, baseRef)) {
    throw new GitInspectionError('MISSING_BASE_REF', `Configured base ref ${baseRef} does not exist`);
  }
  const commit = await git(repository.repoRoot, ['rev-parse', '--verify', baseRef]);
  return { repository, commit };
}
export interface WorkspaceReconciliation {
  readonly state: 'OWNED' | 'MISSING' | 'FOREIGN' | 'UNCERTAIN';
  readonly headCommit?: string;
  readonly evidenceRef: string;
}

export interface PreparedWorkspace {
  readonly id: string;
  readonly taskId: string;
  readonly branchRef: string;
  readonly path: string;
  readonly ownershipToken: string;
  readonly baseCommit: string;
}

export async function reconcileWorkspace(input: {
  readonly repositoryRoot: string;
  readonly path: string;
  readonly branchRef: string;
}): Promise<WorkspaceReconciliation> {
  try {
    const repository = await inspectRepository(input.repositoryRoot);
    const process = Bun.spawn([
      'git', '-C', repository.repoRoot, 'worktree', 'list', '--porcelain', '-z',
    ], { stdout: 'pipe', stderr: 'pipe', env: { PATH: Bun.env.PATH ?? '' } });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) {
      return { state: 'UNCERTAIN', evidenceRef: stderr.trim() || `git worktree list exited with ${exitCode}` };
    }
    const records = stdout.split('\0\0').filter((record) => record.length > 0).map((record) => {
      const fields = record.split('\0');
      const pathField = fields.find((field) => field.startsWith('worktree '));
      const headField = fields.find((field) => field.startsWith('HEAD '));
      const branchField = fields.find((field) => field.startsWith('branch '));
      return {
        path: pathField?.slice('worktree '.length),
        head: headField?.slice('HEAD '.length),
        branch: branchField?.slice('branch '.length),
      };
    });
    const registered = records.find((record) => record.path === input.path);
    let pathExists = true;
    try { await lstat(input.path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') pathExists = false;
      else throw error;
    }
    if (registered === undefined) {
      if (pathExists || await refExists(repository.repoRoot, input.branchRef)) {
        return { state: 'FOREIGN', evidenceRef: `workspace-unregistered:${input.path}` };
      }
      return { state: 'MISSING', evidenceRef: `workspace-missing:${input.path}` };
    }
    if (!pathExists) {
      return { state: 'UNCERTAIN', evidenceRef: `registered-workspace-missing:${input.path}` };
    }
    const canonicalPath = await realpath(input.path);
    if (canonicalPath !== input.path || registered.branch !== input.branchRef || registered.head === undefined) {
      return { state: 'FOREIGN', evidenceRef: `workspace-identity-mismatch:${input.path}` };
    }
    const actualBranch = await git(canonicalPath, ['symbolic-ref', '-q', 'HEAD']);
    const actualHead = await git(canonicalPath, ['rev-parse', '--verify', 'HEAD']);
    if (actualBranch !== input.branchRef || actualHead !== registered.head) {
      return { state: 'FOREIGN', evidenceRef: `workspace-state-mismatch:${input.path}` };
    }
    return { state: 'OWNED', headCommit: actualHead, evidenceRef: `workspace-owned:${input.path}:${actualHead}` };
  } catch (error) {
    return {
      state: 'UNCERTAIN',
      evidenceRef: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Prepare only after Runtime has persisted a PLANNED operation and revalidated project trust. */
export async function prepareWorkspace(input: {
  readonly operationId: string;
  readonly repositoryRoot: string;
  readonly worktreesRoot: string;
  readonly projectId: string;
  /** The fixed baseline ref the worktree is created from (ADR-0009: the project's `dev` ref). */
  readonly baseRef: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly ownershipToken: string;
  readonly baseCommit: string;
  readonly expectedBaseCommit: string;
}): Promise<PreparedWorkspace> {
  const stableId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const [name, value] of [['operationId', input.operationId], ['projectId', input.projectId],
    ['taskId', input.taskId], ['workspaceId', input.workspaceId],
    ['ownershipToken', input.ownershipToken]] as const) {
    if (!stableId.test(value)) throw new GitInspectionError('FOREIGN_RESOURCE', `${name} must be a UUID`);
  }
  const repository = await inspectRepository(input.repositoryRoot);
  if (!input.baseRef.startsWith('refs/heads/')) {
    throw new GitInspectionError('STALE_BASE', 'Configured base ref must be a local branch');
  }
  const expectedOidLength = repository.objectFormat === 'sha1' ? 40 : 64;
  const oidPattern = new RegExp(`^[0-9a-f]{${expectedOidLength}}$`);
  if (!oidPattern.test(input.baseCommit) || !oidPattern.test(input.expectedBaseCommit)) {
    throw new GitInspectionError('STALE_BASE', `Expected ${repository.objectFormat} object IDs`);
  }
  const baseCommit = await git(repository.repoRoot, ['rev-parse', '--verify', input.baseRef]);
  if (baseCommit !== input.expectedBaseCommit || input.baseCommit !== input.expectedBaseCommit) {
    throw new GitInspectionError('STALE_BASE', 'Base ref or requested base changed before workspace preparation');
  }

  const branchRef = `refs/heads/task/${input.taskId}`;
  if (await refExists(repository.repoRoot, branchRef)) {
    throw new GitInspectionError('REF_CONFLICT', `Task branch already exists: ${branchRef}`);
  }
  if (!isAbsolute(input.worktreesRoot)) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', 'Runtime worktrees root must be absolute');
  }
  const requestedRoot = resolve(input.worktreesRoot);
  await assertDirectoryNotSymlink(requestedRoot);
  const projectDirectory = join(requestedRoot, input.projectId);
  const requestedPath = join(projectDirectory, input.taskId);
  await assertDirectoryNotSymlink(projectDirectory);
  try {
    await lstat(requestedPath);
    throw new GitInspectionError('FOREIGN_RESOURCE', `Workspace path already exists: ${requestedPath}`);
  } catch (error) {
    if (error instanceof GitInspectionError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  // An ancestor of the Runtime data directory may itself be a symlink (on macOS `/tmp` resolves to
  // `/private/tmp`, and state directories are often symlinked). Resolve the root once and run every
  // containment check, the worktree creation, and the recorded path against the canonical root; the
  // recorded path then also matches what `git worktree list --porcelain` reports during reconcile.
  const worktreesRoot = await realpath(requestedRoot);
  const canonicalParent = await realpath(projectDirectory);
  if (canonicalParent !== join(worktreesRoot, input.projectId)
    || !canonicalParent.startsWith(`${worktreesRoot}/`)) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', 'Workspace parent escaped the Runtime worktrees root');
  }
  const path = join(worktreesRoot, input.projectId, input.taskId);

  const shortBranch = branchRef.slice('refs/heads/'.length);
  const process = Bun.spawn([
    'git', '-C', repository.repoRoot, 'worktree', 'add', '-b', shortBranch, path, input.baseCommit,
  ], { stdout: 'pipe', stderr: 'pipe', env: { PATH: Bun.env.PATH ?? '' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new GitInspectionError(
      'COMMAND_FAILED',
      stderr.trim() || stdout.trim() || `git worktree add exited with ${exitCode}`,
      true,
    );
  }
  const canonicalPath = await realpath(path);
  if (canonicalPath !== path) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', 'Prepared workspace path resolved unexpectedly', true);
  }
  const head = await git(canonicalPath, ['rev-parse', '--verify', 'HEAD']);
  const actualBranch = await git(canonicalPath, ['symbolic-ref', '-q', 'HEAD']);
  if (head !== input.baseCommit || actualBranch !== branchRef) {
    throw new GitInspectionError(
      'FOREIGN_RESOURCE',
      'Prepared workspace does not match its expected branch and base',
      true,
    );
  }
  return {
    id: input.workspaceId,
    taskId: input.taskId,
    branchRef,
    path: canonicalPath,
    ownershipToken: input.ownershipToken,
    baseCommit: input.baseCommit,
  };
}
