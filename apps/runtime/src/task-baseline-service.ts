import { GitInspectionError, inspectBaseRef, inspectRepository, readHeadCommitOrNull } from '@codeestra/git';

/**
 * The Task baseline (ADR-0062).
 *
 * There is exactly one rule: **a Task worktree is based on the branch the project folder has checked
 * out right now**. The ref and its commit are fixed together with the workspace record, so switching
 * branches in that folder later never moves an existing Task's baseline.
 *
 * A detached HEAD has no branch to name, so it is refused with its own code instead of being
 * resolved to a commit nobody asked for. `--base-ref` overrides the ref for one Task only, and must
 * still be a local branch of the project folder.
 */
export type TaskBaselineCode = 'TASK_BASE_REF_UNRESOLVED' | 'TASK_BASE_REF_MISSING'
  | 'TASK_BASE_REF_NOT_A_BRANCH' | 'TASK_BASE_REF_ALREADY_FIXED';

export class TaskBaselineError extends Error {
  constructor(readonly code: TaskBaselineCode, message: string) {
    super(message);
    this.name = 'TaskBaselineError';
  }
}

/** The repository, the ref and the commit a Task worktree is based on. */
export interface TaskBaselineRepository {
  /** The repository that owns the Task worktree and its branch. */
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  /** The trusted project folder: identity and the ref the policies are read from. */
  readonly mainRepositoryRoot: string;
  readonly mainRef: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly objectFormat: 'sha1' | 'sha256';
}

/**
 * Resolves the Task baseline of one trusted project. Read-only: the project folder is inspected, and
 * no other clone is consulted (there is none — ADR-0062 removed the dev clone).
 */
export async function resolveTaskBaselineRepository(project: {
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  readonly objectFormat: 'sha1' | 'sha256';
}, options: { readonly baseRef?: string | null } = {}): Promise<TaskBaselineRepository> {
  const override = options.baseRef ?? null;
  if (override !== null) {
    return {
      repositoryRoot: project.repoRoot,
      gitCommonDir: project.gitCommonDir,
      mainRepositoryRoot: project.repoRoot,
      mainRef: project.mainRef,
      baseRef: override,
      baseCommit: await readBaselineRef(project.repoRoot, override),
      objectFormat: project.objectFormat,
    };
  }
  // `inspectRepository` refuses a checkout with no symbolic HEAD, which is also how it refuses a
  // path that is not a repository. A resolvable `HEAD` tells the two apart: the first is a baseline
  // fact the user can fix by checking out a branch, the second is a broken trust.
  let inspected;
  try {
    inspected = await inspectRepository(project.repoRoot);
  } catch (error) {
    if (await readHeadCommitOrNull(project.repoRoot).catch(() => null) !== null) {
      throw new TaskBaselineError('TASK_BASE_REF_UNRESOLVED',
        `${project.repoRoot} has a detached HEAD, so there is no checked out branch to use as the`
        + ' Task baseline; check out a branch there (or pass an explicit base ref) and try again');
    }
    throw error;
  }
  return {
    repositoryRoot: inspected.repoRoot,
    gitCommonDir: inspected.gitCommonDir,
    mainRepositoryRoot: project.repoRoot,
    mainRef: project.mainRef,
    baseRef: inspected.mainRef,
    baseCommit: inspected.headCommit,
    objectFormat: inspected.objectFormat,
  };
}

/** Reads one local branch as the baseline commit, or refuses with the fact that is missing. */
async function readBaselineRef(repositoryRoot: string, baseRef: string): Promise<string> {
  if (!baseRef.startsWith('refs/heads/')) {
    throw new TaskBaselineError('TASK_BASE_REF_NOT_A_BRANCH',
      `An explicit Task baseline must be a local branch (refs/heads/...), not ${baseRef}; a tag or a`
      + ' remote-tracking ref is not a baseline a Task worktree can be based on');
  }
  try {
    const inspected = await inspectBaseRef(repositoryRoot, baseRef);
    return inspected.commit;
  } catch (error) {
    if (error instanceof GitInspectionError && error.code === 'MISSING_BASE_REF') {
      throw new TaskBaselineError('TASK_BASE_REF_MISSING',
        `${repositoryRoot} has no local branch ${baseRef}, so no Task baseline can be read from it`);
    }
    throw error;
  }
}

/**
 * The repository that owns this project's Task worktrees, Task branches and result commits: the
 * project folder itself (ADR-0062). It is a function rather than a direct field read so every caller
 * asks the same question, and so a future change has one place to land.
 */
export function taskWorkspaceRepositoryRoot(project: { readonly repoRoot: string }): string {
  return project.repoRoot;
}
