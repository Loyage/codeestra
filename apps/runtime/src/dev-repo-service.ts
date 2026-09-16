import { commitExists, GitInspectionError, inspectBaseRef, inspectDevClone, inspectRepository, readRemoteUrl } from '@codeestra/git';

/**
 * The dev clone (ADR-0047 D05 / ADR-0048 D01): a second, independent checkout of the same origin
 * that a stable promotion pushes its fixed candidate from.
 *
 * Two clones of one project are only interchangeable if they are really the same project, so every
 * fact a promotion depends on is verified here instead of being taken from the recorded path:
 *
 * - the path is a Git work tree at all;
 * - it is **another** clone — a different worktree root *and* a different Git common directory, so
 *   the main checkout or one of its worktrees can never be recorded as "the dev clone";
 * - its `origin` is the same remote the main checkout uses, so "push the candidate to the remote"
 *   means the project's remote and not an unrelated one;
 * - its HEAD is on the project's `dev` branch, and that branch exists locally.
 *
 * A verification that cannot be established is reported with a stable code and refuses; it is never
 * downgraded to "no dev clone recorded" and never guessed from a path or a branch name.
 */
export type DevRepoCode = 'DEV_REPO_NOT_A_REPOSITORY' | 'DEV_REPO_NOT_SEPARATE'
  | 'DEV_REPO_ORIGIN_UNKNOWN' | 'DEV_REPO_ORIGIN_MISMATCH' | 'DEV_REPO_BRANCH_MISMATCH'
  | 'DEV_REPO_DEV_REF_MISSING' | 'DEV_REPO_CANDIDATE_MISSING'
  /**
   * No dev clone is recorded (or one was asked for) for an operation that needs the long-lived
   * `dev` branch. FOUNDATION-087 / ADR-0056 made the clone the single source of dev facts, so an
   * empty path is a refusal and never a fall back to some other clone's local `dev` ref.
   */
  | 'DEV_REPO_REQUIRED';

export class DevRepoError extends Error {
  constructor(readonly code: DevRepoCode, message: string) {
    super(message);
    this.name = 'DevRepoError';
  }
}

/** What `project inspect` reports about a dev clone so a client can see whether promotion is usable. */
export interface DevRepoInspection {
  readonly path: string;
  readonly devRef: string;
  readonly verified: boolean;
  /** Stable code when `verified` is false; null otherwise. */
  readonly code: DevRepoCode | null;
  readonly detail: string | null;
  readonly repoRoot: string | null;
  readonly gitCommonDir: string | null;
  readonly headCommit: string | null;
  readonly branchRef: string | null;
  readonly devRefCommit: string | null;
  readonly originUrl: string | null;
  /** True only when the dev clone's origin is the same URL as the main checkout's origin. */
  readonly originMatchesProject: boolean | null;
  readonly clean: boolean | null;
}

function unverified(input: {
  readonly path: string;
  readonly devRef: string;
  readonly code: DevRepoCode;
  readonly detail: string;
  readonly partial?: Partial<DevRepoInspection>;
}): DevRepoInspection {
  return {
    path: input.path,
    devRef: input.devRef,
    verified: false,
    code: input.code,
    detail: input.detail,
    repoRoot: null,
    gitCommonDir: null,
    headCommit: null,
    branchRef: null,
    devRefCommit: null,
    originUrl: null,
    originMatchesProject: null,
    clean: null,
    ...input.partial,
  };
}

/**
 * Verifies one dev clone against the trusted main checkout. It never throws for a failed
 * verification: the caller decides whether a report or a refusal is the right answer, and both need
 * the same facts.
 */
export async function inspectDevRepo(input: {
  readonly repositoryRoot: string;
  readonly devRef: string;
  readonly devRepoPath: string;
}): Promise<DevRepoInspection> {
  let clone;
  try {
    clone = await inspectDevClone({ path: input.devRepoPath, devRef: input.devRef });
  } catch (error) {
    return unverified({
      path: input.devRepoPath,
      devRef: input.devRef,
      code: 'DEV_REPO_NOT_A_REPOSITORY',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const main = await inspectRepository(input.repositoryRoot).catch(() => null);
  const originUrl = await readRemoteUrl({ repositoryRoot: clone.path });
  const partial = {
    repoRoot: clone.path,
    gitCommonDir: clone.gitCommonDir,
    headCommit: clone.headCommit,
    branchRef: clone.branchRef,
    devRefCommit: clone.devRefCommit,
    originUrl,
    clean: clone.clean,
  } as const;
  if (main === null) {
    return unverified({ path: clone.path, devRef: input.devRef,
      code: 'DEV_REPO_NOT_SEPARATE',
      detail: `The trusted main checkout ${input.repositoryRoot} could not be inspected; the dev`
        + ' clone cannot be compared against it',
      partial });
  }
  // "Another clone" is a fact about the object database, not about the path: the main checkout
  // itself and any of its worktrees share a Git common directory with it.
  if (clone.path === main.repoRoot || clone.gitCommonDir === main.gitCommonDir) {
    return unverified({ path: clone.path, devRef: input.devRef,
      code: 'DEV_REPO_NOT_SEPARATE',
      detail: `${clone.path} is ${clone.path === main.repoRoot
        ? 'the main checkout itself'
        : `a worktree of the main checkout ${main.repoRoot}`}; a promotion needs a separate clone`
        + ' of the same origin, because it pushes the candidate the main checkout does not hold',
      partial });
  }
  const mainOrigin = await readRemoteUrl({ repositoryRoot: main.repoRoot });
  if (mainOrigin === null) {
    return unverified({ path: clone.path, devRef: input.devRef,
      code: 'DEV_REPO_ORIGIN_UNKNOWN',
      detail: `The main checkout ${main.repoRoot} has no origin remote, so the dev clone's origin`
        + ' cannot be compared with it',
      partial });
  }
  if (originUrl === null) {
    return unverified({ path: clone.path, devRef: input.devRef,
      code: 'DEV_REPO_ORIGIN_UNKNOWN',
      detail: `${clone.path} has no origin remote; a promotion pushes the fixed candidate to origin`,
      partial });
  }
  if (originUrl !== mainOrigin) {
    return unverified({ path: clone.path, devRef: input.devRef,
      code: 'DEV_REPO_ORIGIN_MISMATCH',
      detail: `${clone.path} fetches from ${originUrl}, but ${main.repoRoot} uses ${mainOrigin};`
        + ' pushing to a different remote would promote into an unrelated repository',
      partial: { ...partial, originMatchesProject: false } });
  }
  if (clone.branchRef !== input.devRef) {
    return unverified({ path: clone.path, devRef: input.devRef,
      code: 'DEV_REPO_BRANCH_MISMATCH',
      detail: `${clone.path} has ${clone.branchRef ?? 'a detached HEAD'} checked out, not`
        + ` ${input.devRef} (ADR-0048: the dev clone is the long-lived dev checkout)`,
      partial });
  }
  if (clone.devRefCommit === null) {
    return unverified({ path: clone.path, devRef: input.devRef,
      code: 'DEV_REPO_DEV_REF_MISSING',
      detail: `${clone.path} has no local ${input.devRef} branch`,
      partial });
  }
  return { path: clone.path, devRef: input.devRef, verified: true, code: null, detail: null,
    repoRoot: clone.path, gitCommonDir: clone.gitCommonDir, headCommit: clone.headCommit,
    branchRef: clone.branchRef, devRefCommit: clone.devRefCommit, originUrl,
    originMatchesProject: true, clean: clone.clean };
}

/**
 * The code a Task baseline resolution refuses with (ADR-0060). Both are facts about the requested
 * baseline, not about trust: a project stays trusted when its folder is on a detached HEAD.
 */
export type TaskBaselineCode = 'TASK_BASE_REF_UNRESOLVED' | 'TASK_BASE_REF_MISSING'
  | 'TASK_BASE_REF_NOT_A_BRANCH' | 'TASK_BASE_REF_ALREADY_FIXED';

export class TaskBaselineError extends Error {
  constructor(readonly code: TaskBaselineCode, message: string) {
    super(message);
    this.name = 'TaskBaselineError';
  }
}

/**
 * The repository and the ref a Task worktree is based on (ADR-0060).
 *
 * There are exactly two ways a project can name a baseline, and which one applies is decided by a
 * recorded path, never by a path or branch name:
 *
 * - a project with a recorded **dev clone** (ADR-0048/0056) takes the clone's long-lived `dev` as the
 *   baseline. This is what Codeestra itself uses, and what any project that wants `dev → main`
 *   promotion records;
 * - a project **without** one takes its own folder (`projects.repo_root`) and the branch that folder
 *   has **checked out right now** as the baseline. The ref and its commit are fixed with the
 *   workspace, so switching branches in that folder later never moves an existing Task's baseline.
 *
 * A detached HEAD has no branch to name, so it is refused instead of being resolved to a commit
 * nobody asked for. `baseRef` overrides the ref for one Task only (still a local branch of the
 * baseline repository).
 */
export interface TaskBaselineRepository {
  readonly mode: 'DEV_CLONE' | 'PROJECT_FOLDER';
  /** The repository that owns the Task worktree and its branch. */
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  /** The trusted main checkout: identity and the ref the policies are read from. */
  readonly mainRepositoryRoot: string;
  readonly mainRef: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly devRepoPath: string | null;
  /** Present only in `DEV_CLONE` mode: the verification behind the recorded path. */
  readonly inspection: DevRepoInspection | null;
}

/**
 * Resolves the Task baseline of one trusted project (ADR-0060). Cheap when a dev clone is recorded
 * (the clone is re-verified), and read-only when it is not: the project folder is only inspected.
 */
export async function resolveTaskBaselineRepository(project: {
  readonly id: string;
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  readonly devRef: string;
  readonly devRepoPath: string | null;
  readonly objectFormat: 'sha1' | 'sha256';
}, options: { readonly baseRef?: string | null } = {}): Promise<TaskBaselineRepository> {
  const override = options.baseRef ?? null;
  if (project.devRepoPath !== null) {
    const dev = await requireProjectDevRepository(project);
    const baseRef = override ?? dev.devRef;
    const baseCommit = baseRef === dev.devRef
      ? dev.devCommit
      : await readBaselineRef(dev.devRepoPath, baseRef);
    return {
      mode: 'DEV_CLONE',
      repositoryRoot: dev.devRepoPath,
      gitCommonDir: dev.devGitCommonDir,
      mainRepositoryRoot: dev.mainRepositoryRoot,
      mainRef: dev.mainRef,
      baseRef,
      baseCommit,
      objectFormat: dev.objectFormat,
      devRepoPath: dev.devRepoPath,
      inspection: dev.inspection,
    };
  }
  // No dev clone is recorded: the project folder is its own baseline repository. A detached HEAD
  // cannot name a ref, so it is refused with its own code (and only when no override was given).
  if (override === null) {
    let inspected;
    try {
      inspected = await inspectRepository(project.repoRoot);
    } catch (error) {
      if (await commitExists({ repositoryRoot: project.repoRoot, commit: 'HEAD' }).catch(() => false)) {
        throw new TaskBaselineError('TASK_BASE_REF_UNRESOLVED',
          `${project.repoRoot} has a detached HEAD, so there is no checked out branch to use as the`
          + ' Task baseline; check out a branch there (or pass an explicit base ref) and try again');
      }
      throw error;
    }
    return {
      mode: 'PROJECT_FOLDER',
      repositoryRoot: inspected.repoRoot,
      gitCommonDir: inspected.gitCommonDir,
      mainRepositoryRoot: project.repoRoot,
      mainRef: project.mainRef,
      baseRef: inspected.mainRef,
      baseCommit: inspected.headCommit,
      objectFormat: inspected.objectFormat,
      devRepoPath: null,
      inspection: null,
    };
  }
  return {
    mode: 'PROJECT_FOLDER',
    repositoryRoot: project.repoRoot,
    gitCommonDir: project.gitCommonDir,
    mainRepositoryRoot: project.repoRoot,
    mainRef: project.mainRef,
    baseRef: override,
    baseCommit: await readBaselineRef(project.repoRoot, override),
    objectFormat: project.objectFormat,
    devRepoPath: null,
    inspection: null,
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
 * The two Git repositories of one trusted project, as ADR-0056 separates them:
 *
 * - the **main checkout** (`projects.repo_root`) owns the identity and the `main` ref, which is
 *   where the human-maintained verification and impact policies live;
 * - the **dev clone** (`projects.dev_repo_path`) owns the long-lived `dev` branch: the Task
 *   baseline, every Task worktree, the integration merge and its compare-and-swap, and the fixed
 *   candidate a stable promotion pushes.
 *
 * Both are needed by callers that read a policy and a dev fact in the same operation, so they are
 * returned together instead of each caller inventing its own pair of roots.
 */
export interface ProjectDevRepository {
  readonly projectId: string;
  readonly mainRepositoryRoot: string;
  readonly mainGitCommonDir: string;
  readonly mainRef: string;
  readonly devRepoPath: string;
  readonly devRef: string;
  /** Commit of the dev clone's local `dev` ref; the dev facts a caller may act on. */
  readonly devCommit: string;
  readonly devGitCommonDir: string;
  readonly objectFormat: 'sha1' | 'sha256';
  /** The verification behind the root, for callers that report what they checked. */
  readonly inspection: DevRepoInspection;
}

/**
 * The recorded dev clone path, or the stable refusal that names the one command which fixes it.
 * Cheap and side-effect free: a caller that only needs to know *whether* a dev repository exists
 * (and which path it is) uses this instead of the full verification below.
 */
export function requireRecordedDevRepoPath(project: {
  readonly repoRoot: string;
  readonly devRepoPath: string | null;
}): string {
  if (project.devRepoPath === null) {
    throw new DevRepoError('DEV_REPO_REQUIRED',
      `No dev clone is recorded for ${project.repoRoot}, so the long-lived dev branch cannot be`
      + ' read: ADR-0056 resolves every dev fact from `projects.dev_repo_path` and never falls back'
      + ' to the stable checkout\'s own `dev` ref'
      + ` — run \`project trust ${project.repoRoot} --dev-repo <dev-clone>\``);
  }
  return project.devRepoPath;
}

/**
 * Resolves and verifies the dev clone of one trusted project, and reads the `dev` commit from it.
 * A project without a recorded clone is refused before anything is read or written, so no caller
 * ever acts on a guessed baseline.
 */
export async function requireProjectDevRepository(project: {
  readonly id: string;
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  readonly devRef: string;
  readonly devRepoPath: string | null;
  readonly objectFormat: 'sha1' | 'sha256';
}): Promise<ProjectDevRepository> {
  const devRepoPath = requireRecordedDevRepoPath(project);
  const inspection = await requireDevRepo({
    repositoryRoot: project.repoRoot,
    devRef: project.devRef,
    devRepoPath,
  });
  return {
    projectId: project.id,
    mainRepositoryRoot: project.repoRoot,
    mainGitCommonDir: project.gitCommonDir,
    mainRef: project.mainRef,
    devRepoPath: inspection.repoRoot as string,
    devRef: project.devRef,
    devCommit: inspection.devRefCommit as string,
    devGitCommonDir: inspection.gitCommonDir as string,
    objectFormat: project.objectFormat,
    inspection,
  };
}

/** The verified dev clone, or a refusal that names the fact that could not be established. */
export async function requireDevRepo(input: {
  readonly repositoryRoot: string;
  readonly devRef: string;
  readonly devRepoPath: string;
}): Promise<DevRepoInspection> {
  const inspection = await inspectDevRepo(input);
  if (!inspection.verified) {
    throw new DevRepoError(inspection.code as DevRepoCode,
      `${inspection.detail ?? 'The dev clone could not be verified'}`
      + ' — run `project trust <main-checkout> --dev-repo <dev-clone>` after fixing it');
  }
  return inspection;
}

/**
 * The fixed candidate must be an object of the dev clone for the push to be able to send it. This
 * is a local precondition, checked before any network operation: a promotion that cannot reach the
 * candidate must say so instead of reporting a push failure the remote never saw.
 */
export async function requireCandidateInDevRepo(input: {
  readonly devRepoPath: string;
  readonly candidateCommit: string;
}): Promise<void> {
  if (!await commitExists({ repositoryRoot: input.devRepoPath, commit: input.candidateCommit })) {
    throw new DevRepoError('DEV_REPO_CANDIDATE_MISSING',
      `The dev clone ${input.devRepoPath} does not hold the fixed candidate`
      + ` ${input.candidateCommit}; fetch the integrated dev branch there before promoting`);
  }
}
