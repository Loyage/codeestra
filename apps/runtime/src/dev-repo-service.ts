import { commitExists, inspectDevClone, inspectRepository, readRemoteUrl } from '@codeestra/git';

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
  | 'DEV_REPO_DEV_REF_MISSING' | 'DEV_REPO_CANDIDATE_MISSING';

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
