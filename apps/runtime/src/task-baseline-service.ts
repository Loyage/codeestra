import {
  GitInspectionError,
  ensureManagedIntegrationRef,
  inspectBaseRef,
  managedIntegrationRefName,
} from '@codeestra/git';

/**
 * The Task baseline (ADR-0070 D07 / S8, ADR-0074).
 *
 * There is exactly one rule: **a Task worktree is based on its Project's managed integration ref**
 * (`refs/codeestra/integration`), fixed to the commit that ref pointed at when the Task was
 * prepared. The ref and the commit are recorded together, so a later merge into the integration ref
 * never moves an existing Task's baseline, and Task N+1 really does start from what Task N produced.
 *
 * `--base-ref` still overrides the ref for one Task, and must still be a local branch of the project
 * folder: an explicit baseline is a deliberate choice, so it is not silently replaced by the managed
 * one. A ref that is neither a local branch nor the managed integration ref is refused by name.
 *
 * This module used to read "the branch the project folder has checked out right now" (ADR-0066). That
 * is what a project has *before* its integration ref exists; `project trust` materializes the ref
 * from that commit, and `project integration init` does the same for a project trusted earlier.
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
 * Resolves the Task baseline of one trusted project. Read-only: it reads the managed integration ref
 * (or the explicit override) and never writes, moves, or creates a ref. Initialization is
 * `project trust` / `project integration init`, which is where a missing ref is created.
 */
export async function resolveTaskBaselineRepository(project: {
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  readonly objectFormat: 'sha1' | 'sha256';
}, options: { readonly baseRef?: string | null } = {}): Promise<TaskBaselineRepository> {
  const override = options.baseRef ?? null;
  const baseRef = override ?? managedIntegrationRefName;
  const baseCommit = await readBaselineRef(project.repoRoot, baseRef);
  return {
    repositoryRoot: project.repoRoot,
    gitCommonDir: project.gitCommonDir,
    mainRepositoryRoot: project.repoRoot,
    mainRef: project.mainRef,
    baseRef,
    baseCommit,
    objectFormat: project.objectFormat,
  };
}

/** Reads one baseline ref's commit, or refuses with the fact that is missing. */
async function readBaselineRef(repositoryRoot: string, baseRef: string): Promise<string> {
  if (baseRef === managedIntegrationRefName) {
    // Materialized on first need (ADR-0074): a project trusted before this schema existed gets its
    // ref here, from the branch its folder has checked out now. An existing ref is never moved.
    try {
      return (await ensureManagedIntegrationRef({ repositoryRoot })).commit;
    } catch (error) {
      if (error instanceof GitInspectionError) {
        throw new TaskBaselineError('TASK_BASE_REF_UNRESOLVED', error.message);
      }
      throw error;
    }
  }
  if (!baseRef.startsWith('refs/heads/')) {
    throw new TaskBaselineError('TASK_BASE_REF_NOT_A_BRANCH',
      `An explicit Task baseline must be a local branch (refs/heads/...) or the managed integration`
      + ` ref, not ${baseRef}; a tag or a remote-tracking ref is not a baseline a Task worktree can be`
      + ' based on');
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
 * project folder itself. It is a function rather than a direct field read so every caller asks the
 * same question, and so a future change has one place to land.
 */
export function taskWorkspaceRepositoryRoot(project: { readonly repoRoot: string }): string {
  return project.repoRoot;
}
