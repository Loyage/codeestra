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

export async function inspectConfiguredMain(path: string, mainRef: string): Promise<RepositoryIdentity> {
  if (!mainRef.startsWith('refs/heads/')) {
    throw new GitInspectionError('INVALID_REPOSITORY', 'Configured main ref must be a local branch');
  }
  const repository = await inspectRepository(path);
  const headCommit = await git(repository.repoRoot, ['rev-parse', '--verify', mainRef]);
  return { ...repository, mainRef, headCommit };
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
  readonly mainRef: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly ownershipToken: string;
  readonly baseCommit: string;
  readonly expectedMainCommit: string;
}): Promise<PreparedWorkspace> {
  const stableId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const [name, value] of [['operationId', input.operationId], ['projectId', input.projectId],
    ['taskId', input.taskId], ['workspaceId', input.workspaceId],
    ['ownershipToken', input.ownershipToken]] as const) {
    if (!stableId.test(value)) throw new GitInspectionError('FOREIGN_RESOURCE', `${name} must be a UUID`);
  }
  const repository = await inspectRepository(input.repositoryRoot);
  if (!input.mainRef.startsWith('refs/heads/')) {
    throw new GitInspectionError('STALE_BASE', 'Configured main ref must be a local branch');
  }
  const expectedOidLength = repository.objectFormat === 'sha1' ? 40 : 64;
  const oidPattern = new RegExp(`^[0-9a-f]{${expectedOidLength}}$`);
  if (!oidPattern.test(input.baseCommit) || !oidPattern.test(input.expectedMainCommit)) {
    throw new GitInspectionError('STALE_BASE', `Expected ${repository.objectFormat} object IDs`);
  }
  const mainCommit = await git(repository.repoRoot, ['rev-parse', '--verify', input.mainRef]);
  if (mainCommit !== input.expectedMainCommit || input.baseCommit !== input.expectedMainCommit) {
    throw new GitInspectionError('STALE_BASE', 'Main or requested base changed before workspace preparation');
  }

  const branchRef = `refs/heads/task/${input.taskId}`;
  if (await refExists(repository.repoRoot, branchRef)) {
    throw new GitInspectionError('REF_CONFLICT', `Task branch already exists: ${branchRef}`);
  }
  if (!isAbsolute(input.worktreesRoot)) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', 'Runtime worktrees root must be absolute');
  }
  const worktreesRoot = resolve(input.worktreesRoot);
  const projectDirectory = join(worktreesRoot, input.projectId);
  const path = join(projectDirectory, input.taskId);
  await assertDirectoryNotSymlink(worktreesRoot);
  await assertDirectoryNotSymlink(projectDirectory);
  try {
    await lstat(path);
    throw new GitInspectionError('FOREIGN_RESOURCE', `Workspace path already exists: ${path}`);
  } catch (error) {
    if (error instanceof GitInspectionError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(worktreesRoot);
  const canonicalParent = await realpath(projectDirectory);
  if (canonicalRoot !== worktreesRoot || canonicalParent !== projectDirectory
    || !canonicalParent.startsWith(`${canonicalRoot}/`)) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', 'Workspace parent escaped the Runtime worktrees root');
  }

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
