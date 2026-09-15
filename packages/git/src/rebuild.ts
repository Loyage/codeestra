import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { GitInspectionError } from './errors.js';
import { isAncestor, listCheckedOutRefs, readLocalRefCommit } from './integration.js';
import { inspectOwnedPath, inspectOwnedWorktreeRegistration } from './reclaim.js';

/**
 * Re-creating a Runtime-owned Task worktree from the Task branch a reclamation deliberately kept
 * (FOUNDATION-068 / ADR-0042).
 *
 * `reclaim` removes the checkout directory and its Git registration but never the Task branch
 * (ADR-0021). `prepareWorkspace` refuses to create a worktree on an existing branch, so that
 * surviving branch was unreachable and a reclaimed Task could not run again. This module closes that
 * gap with the narrowest possible surface:
 *
 *  - it only ever attaches a branch Git itself still has in *this* repository, at exactly the layout
 *    path the Runtime ledger recorded, under an owned root, with no symlink in the way;
 *  - it never deletes, never renames, never `--force`s anything, and never touches a directory it
 *    cannot prove is free — an occupied path is a refusal, not a cleanup;
 *  - it is idempotent by observation: a second call on an already-registered worktree *adopts* it
 *    without running Git at all, which is also how a crash between `git worktree add` and the ledger
 *    write is reconciled, because the branch, the registration and the row are the durable facts.
 *
 * Facts stay here and policy stays with the caller: `inspectOwnedWorktreeRebuild` reports what the
 * filesystem and Git say, `decideRetryWorkspace` (domain) decides whether that is a rebuildable
 * source, and `rebuildOwnedWorktree` re-establishes every invariant at action time instead of
 * trusting the earlier reading.
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

async function lstatKind(path: string): Promise<'MISSING' | 'SYMLINK' | 'OTHER'> {
  try {
    return (await lstat(path)).isSymbolicLink() ? 'SYMLINK' : 'OTHER';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'MISSING';
    throw error;
  }
}

/**
 * How a branch commit relates to the recorded baseline commit. `UNKNOWN` is reported rather than
 * guessed whenever the relationship cannot be read (an object that is no longer in the repository, a
 * Git command that failed), because an unreadable relationship is not a proof of ownership.
 */
export type TaskBranchRelation = 'EQUAL' | 'DESCENDANT' | 'UNRELATED' | 'UNKNOWN';

export interface TaskBranchEvidence {
  readonly branchRef: string;
  readonly baseCommit: string;
  readonly branchExists: boolean;
  readonly branchCommit: string | null;
  readonly relationToBase: TaskBranchRelation;
  /** Every worktree of this repository that has this exact branch checked out. */
  readonly checkedOutPaths: readonly string[];
  /** One string naming every fact above, for audit payloads and refusal messages. */
  readonly evidenceRef: string;
}

/**
 * Reads what the Task branch still says. This is the fact `reclaim` leaves behind on purpose: the
 * branch, and nothing else, is what can make a rebuild possible at all.
 */
export async function inspectTaskBranch(input: {
  readonly repositoryRoot: string;
  readonly branchRef: string;
  readonly baseCommit: string;
}): Promise<TaskBranchEvidence> {
  if (!input.branchRef.startsWith('refs/heads/')) {
    throw new GitInspectionError('FOREIGN_RESOURCE',
      `A Task branch ref must be a local branch, not ${input.branchRef}`);
  }
  const branchCommit = await readLocalRefCommit({
    repositoryRoot: input.repositoryRoot, ref: input.branchRef,
  });
  let relationToBase: TaskBranchRelation = 'UNKNOWN';
  if (branchCommit === input.baseCommit) {
    relationToBase = 'EQUAL';
  } else if (branchCommit !== null) {
    try {
      relationToBase = await isAncestor({
        repositoryRoot: input.repositoryRoot,
        ancestor: input.baseCommit,
        descendant: branchCommit,
      }) ? 'DESCENDANT' : 'UNRELATED';
    } catch {
      // The baseline or the branch commit is not readable from this repository: report the unknown
      // instead of inventing "unrelated", which would read as a deliberate divergence.
      relationToBase = 'UNKNOWN';
    }
  }
  const checkedOutPaths = (await listCheckedOutRefs(input.repositoryRoot))
    .filter((entry) => entry.ref === input.branchRef)
    .map((entry) => entry.path)
    .sort();
  return {
    branchRef: input.branchRef,
    baseCommit: input.baseCommit,
    branchExists: branchCommit !== null,
    branchCommit,
    relationToBase,
    checkedOutPaths,
    evidenceRef: `${input.branchRef}:${branchCommit ?? 'absent'}`
      + `:relation=${relationToBase}:checkedOut=`
      + `${checkedOutPaths.length === 0 ? 'none' : checkedOutPaths.join('|')}`,
  };
}

/**
 * Everything a rebuild decision needs: where the recorded path is, whether Git registers a worktree
 * there, and what the surviving branch says. The fields the domain decision reads are named exactly
 * as `RetryRebuildEvidence` names them, so a caller passes this observation through without a
 * translation layer that could drift from the decision it feeds.
 */
export interface OwnedWorktreeRebuildObservation {
  readonly path: string;
  readonly branchRef: string;
  readonly baseCommit: string;
  readonly ownedRoot: string;
  /** `OWNED` / `MISSING` / `FOREIGN` / `UNCERTAIN`, classified exactly as `reconcileWorkspace`. */
  readonly observation: 'OWNED' | 'MISSING' | 'FOREIGN' | 'UNCERTAIN';
  readonly evidenceRef: string;
  readonly symlink: boolean;
  readonly insideOwnedRoot: boolean;
  readonly canonicalPath: string | null;
  readonly pathPresent: boolean;
  readonly registered: boolean;
  readonly registeredPath: string | null;
  readonly registeredBranch: string | null;
  readonly registeredHead: string | null;
  /** The worktree's own HEAD when it is registered at the recorded path. */
  readonly headCommit: string | null;
  readonly branchExists: boolean;
  readonly branchCommit: string | null;
  readonly relationToBase: TaskBranchRelation;
  readonly checkedOutPaths: readonly string[];
  readonly checkedOutElsewhere: boolean;
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

/**
 * Observes the recorded path and the surviving branch in one read, so the retry decision and the
 * rebuild itself can never judge two different pictures of the same workspace. The four-way
 * classification is the one `reconcileWorkspace` makes, from the same facts.
 */
export async function inspectOwnedWorktreeRebuild(input: {
  readonly repositoryRoot: string;
  readonly ownedRoot: string;
  readonly path: string;
  readonly branchRef: string;
  readonly baseCommit: string;
}): Promise<OwnedWorktreeRebuildObservation> {
  const owned = await inspectOwnedPath({ ownedRoot: input.ownedRoot, path: input.path });
  const registration = await inspectOwnedWorktreeRegistration({
    repositoryRoot: input.repositoryRoot, path: input.path,
  });
  const branch = await inspectTaskBranch({
    repositoryRoot: input.repositoryRoot,
    branchRef: input.branchRef,
    baseCommit: input.baseCommit,
  });
  const registeredAtRecordedPath = registration.registered && registration.registeredPath !== null
    && samePath(registration.registeredPath, input.path);
  let observation: OwnedWorktreeRebuildObservation['observation'];
  if (!registration.registered) {
    observation = owned.exists || branch.branchExists ? 'FOREIGN' : 'MISSING';
  } else if (!registration.pathExists) {
    observation = 'UNCERTAIN';
  } else if (!registeredAtRecordedPath || owned.canonicalPath !== resolve(input.path)
    || registration.branchRef !== input.branchRef || registration.headCommit === null) {
    observation = 'FOREIGN';
  } else {
    observation = 'OWNED';
  }
  const checkedOutElsewhere = branch.checkedOutPaths
    .some((path) => !samePath(path, input.path));
  const expectedPath = owned.canonicalPath ?? resolve(input.path);
  return {
    path: input.path,
    branchRef: input.branchRef,
    baseCommit: input.baseCommit,
    ownedRoot: owned.ownedRoot,
    observation,
    evidenceRef: `workspace-rebuild:${observation}:${expectedPath}:`
      + `${registration.registered
        ? `registered=${registration.branchRef ?? 'detached'}@${registration.headCommit ?? 'unknown'}`
        : 'unregistered'}:${branch.evidenceRef}`,
    symlink: owned.symlink,
    insideOwnedRoot: owned.insideOwnedRoot,
    canonicalPath: owned.canonicalPath,
    pathPresent: owned.exists,
    registered: registration.registered,
    registeredPath: registration.registeredPath,
    registeredBranch: registration.branchRef,
    registeredHead: registration.headCommit,
    headCommit: registeredAtRecordedPath ? registration.headCommit : null,
    branchExists: branch.branchExists,
    branchCommit: branch.branchCommit,
    relationToBase: branch.relationToBase,
    checkedOutPaths: branch.checkedOutPaths,
    checkedOutElsewhere,
  };
}

export type OwnedWorktreeRebuildOutcome = 'REBUILT' | 'ADOPTED' | 'REFUSED' | 'FAILED';

export interface OwnedWorktreeRebuild {
  readonly outcome: OwnedWorktreeRebuildOutcome;
  readonly reasonCode: string;
  readonly detail: string;
  readonly path: string;
  readonly branchRef: string;
  readonly headCommit: string | null;
  /** True only when this call ran `git worktree add`; an adoption runs no Git command. */
  readonly created: boolean;
  readonly evidence: Readonly<Record<string, unknown>>;
}

const stableId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Verdict {
  readonly ok: boolean;
  readonly reasonCode: string;
  readonly detail: string;
}

const held: Verdict = { ok: true, reasonCode: '', detail: '' };

function relationHolds(observation: OwnedWorktreeRebuildObservation): boolean {
  return observation.relationToBase === 'EQUAL' || observation.relationToBase === 'DESCENDANT';
}

/**
 * Whether an existing registration at the recorded path is this Task's own worktree, ready to be
 * adopted. One rule, used both before acting and after a failed `worktree add`, so both readings
 * come from the same facts instead of two drifting checks.
 */
function adoptionVerdict(observation: OwnedWorktreeRebuildObservation): Verdict {
  if (!observation.registered) return held;
  if (observation.registeredPath === null
    || !samePath(observation.registeredPath, observation.path)) {
    return { ok: false, reasonCode: 'REGISTRATION_PATH_MISMATCH',
      detail: `Git registers a worktree at ${observation.registeredPath ?? 'an unknown path'},`
        + ` not at the recorded path ${observation.path}` };
  }
  if (observation.registeredBranch !== observation.branchRef) {
    return { ok: false, reasonCode: 'BRANCH_MISMATCH',
      detail: `The worktree at ${observation.path} is on`
        + ` ${observation.registeredBranch ?? 'a detached HEAD'}, not ${observation.branchRef}` };
  }
  if (observation.registeredHead === null) {
    return { ok: false, reasonCode: 'HEAD_UNREADABLE',
      detail: `The worktree at ${observation.path} has no readable HEAD` };
  }
  if (observation.branchCommit === null
    || observation.registeredHead !== observation.branchCommit) {
    return { ok: false, reasonCode: 'HEAD_MISMATCH',
      detail: `The worktree at ${observation.path} is on ${observation.registeredHead}, while`
        + ` ${observation.branchRef} is at ${observation.branchCommit ?? 'nothing'}` };
  }
  return sourceVerdict(observation);
}

/**
 * Whether the surviving branch is a legitimate source at all: it must still be this Task's own
 * growth of the baseline it recorded, never an unrelated branch that merely shares the name.
 */
function sourceVerdict(observation: OwnedWorktreeRebuildObservation): Verdict {
  if (!relationHolds(observation)) {
    return { ok: false, reasonCode: 'BRANCH_DIVERGED',
      detail: `The branch ${observation.branchRef} is ${observation.relationToBase.toLowerCase()}`
        + ` to the recorded baseline ${observation.baseCommit}` };
  }
  return held;
}

/**
 * Re-creates one Runtime-owned Task worktree from its surviving branch, or adopts the one a previous
 * (possibly crashed) attempt already created.
 *
 * Every invariant is re-established here, at action time: the path is this Task's own layout path
 * under an owned root, neither it nor its project directory is a symlink, an occupied path Git does
 * not register is refused rather than deleted, the branch must still descend from the recorded
 * baseline, and it must not be checked out anywhere else. `git worktree add` runs without `--force`;
 * Git's own refusal to attach an already-attached branch is kept as evidence, never bypassed.
 */
export async function rebuildOwnedWorktree(input: {
  readonly repositoryRoot: string;
  readonly ownedRoot: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly path: string;
  readonly branchRef: string;
  readonly baseCommit: string;
}): Promise<OwnedWorktreeRebuild> {
  for (const [name, value] of [['projectId', input.projectId], ['taskId', input.taskId]] as const) {
    if (!stableId.test(value)) {
      throw new GitInspectionError('FOREIGN_RESOURCE', `${name} must be a UUID`);
    }
  }
  if (!isAbsolute(input.ownedRoot) || !isAbsolute(input.path)) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', 'Owned root and worktree path must be absolute');
  }
  const refused = (reasonCode: string, detail: string,
    evidence: Readonly<Record<string, unknown>>): OwnedWorktreeRebuild => ({
    outcome: 'REFUSED', reasonCode, detail, path: input.path, branchRef: input.branchRef,
    headCommit: null, created: false, evidence,
  });
  const observed = await inspectOwnedWorktreeRebuild(input);
  const evidence: Record<string, unknown> = { ...observed };
  const projectDirectory = join(observed.ownedRoot, input.projectId);
  const expectedLayout = join(projectDirectory, input.taskId);
  evidence['expectedLayout'] = expectedLayout;
  if (observed.symlink) {
    return refused('SYMLINK_ESCAPE',
      'The recorded worktree path is a symlink; it is never followed', evidence);
  }
  if (observed.pathPresent && !observed.insideOwnedRoot) {
    return refused('PATH_OUTSIDE_OWNED_ROOT',
      'The recorded worktree path resolves outside the Runtime-owned worktrees root', evidence);
  }
  if (!samePath(input.path, expectedLayout)) {
    return refused('PATH_NOT_OWNED_LAYOUT',
      `The recorded path ${input.path} is not this Task's own layout path ${expectedLayout}`,
      evidence);
  }
  const projectEntry = await lstatKind(projectDirectory);
  evidence['projectDirectoryEntry'] = projectEntry;
  if (projectEntry === 'SYMLINK') {
    return refused('SYMLINK_ESCAPE',
      'The project directory of the recorded worktree path is a symlink; it is never followed',
      evidence);
  }
  if (observed.registered && !observed.pathPresent) {
    // A stale registration whose directory is gone only needs `git worktree prune`, which is a
    // reclamation decision (`REGISTRATION_ONLY`): adopting it would hand a path that does not exist
    // to the next Agent, and pruning it here would silently destroy another lane's evidence.
    return refused('REGISTERED_WITHOUT_DIRECTORY',
      'Git still registers a worktree at the recorded path but the directory is gone; reclaim that'
      + ' stale registration before rebuilding', evidence);
  }
  if (observed.registered) {
    const verdict = adoptionVerdict(observed);
    if (!verdict.ok) return refused(verdict.reasonCode, verdict.detail, evidence);
    return { outcome: 'ADOPTED', reasonCode: 'ALREADY_REGISTERED',
      detail: 'The Task worktree was already registered at its recorded path on its recorded branch'
        + '; nothing was created and no branch was touched',
      path: observed.canonicalPath ?? input.path, branchRef: input.branchRef,
      headCommit: observed.registeredHead, created: false, evidence };
  }
  if (observed.pathPresent) {
    // A directory Git does not register is not evidence of a Runtime worktree. Deleting it is an
    // explicit reclamation decision (`reclaim --remove-unregistered`), never a rebuild side effect.
    return refused('UNREGISTERED_DIRECTORY',
      'A directory exists at the recorded path but Git does not register it as this worktree;'
      + ' remove it with an explicit reclamation selection and retry', evidence);
  }
  if (!observed.branchExists) {
    return refused('BRANCH_ABSENT',
      `The Task branch ${input.branchRef} no longer exists, so there is nothing to re-create the`
      + ' worktree from', evidence);
  }
  if (observed.checkedOutElsewhere) {
    return refused('BRANCH_CHECKED_OUT_ELSEWHERE',
      `The Task branch ${input.branchRef} is already checked out in`
      + ` ${observed.checkedOutPaths.join(', ')}; no second checkout is created`, evidence);
  }
  const verdict = sourceVerdict(observed);
  if (!verdict.ok) return refused(verdict.reasonCode, verdict.detail, evidence);

  try {
    await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
  } catch (error) {
    return { outcome: 'FAILED', reasonCode: 'REBUILD_FAILED',
      detail: `The project directory of the recorded path could not be created:`
        + ` ${error instanceof Error ? error.message : String(error)}`,
      path: input.path, branchRef: input.branchRef, headCommit: null, created: false, evidence };
  }
  // Git associates a new worktree with a branch only when it is given a *branch name*; a fully
  // qualified ref would be checked out detached, which is not the workspace this Task owns. The
  // post-check below still proves the attachment instead of trusting the name.
  const shortBranch = input.branchRef.slice('refs/heads/'.length);
  const created = await runGit(input.repositoryRoot,
    ['worktree', 'add', input.path, shortBranch]);
  if (created.exitCode !== 0) {
    // A concurrent preparation of the same workspace (one Runtime, one ledger row, one derived path)
    // may have won the race. Adoption is allowed only when the freshly observed facts agree exactly;
    // everything else is a failure that keeps Git's own message as the evidence.
    const failure = created.stderr.trim() || created.stdout.trim()
      || `git worktree add exited with ${created.exitCode}`;
    const after = await inspectOwnedWorktreeRebuild(input);
    const afterVerdict = adoptionVerdict(after);
    if (after.registered && afterVerdict.ok) {
      return { outcome: 'ADOPTED', reasonCode: 'REGISTERED_BY_CONCURRENT_PREPARATION',
        detail: 'The worktree was registered by a concurrent preparation with the same path, branch'
          + ' and baseline; this call created nothing',
        path: after.canonicalPath ?? input.path, branchRef: input.branchRef,
        headCommit: after.registeredHead, created: false,
        evidence: { ...evidence, concurrentObservation: after, worktreeAddFailure: failure } };
    }
    if (after.checkedOutElsewhere) {
      return refused('BRANCH_CHECKED_OUT_ELSEWHERE',
        `The Task branch ${input.branchRef} is checked out in ${after.checkedOutPaths.join(', ')};`
        + ' Git refused to attach it a second time', evidence);
    }
    return { outcome: 'FAILED', reasonCode: 'REBUILD_FAILED', detail: failure,
      path: input.path, branchRef: input.branchRef, headCommit: null, created: false,
      evidence: { ...evidence, worktreeAddFailure: failure } };
  }
  // The worktree now exists. If the post-checks fail it is deliberately left in place: removing it is
  // the reclamation path's job, and the next attempt adopts it once the facts agree again.
  const head = await runGit(input.path, ['rev-parse', '--verify', 'HEAD']);
  const branch = await runGit(input.path, ['symbolic-ref', '-q', 'HEAD']);
  const canonicalPath = await realpath(input.path);
  evidence['createdPath'] = canonicalPath;
  evidence['createdHead'] = head.stdout.trim();
  evidence['createdBranch'] = branch.stdout.trim();
  if (head.exitCode !== 0 || branch.exitCode !== 0 || canonicalPath !== input.path
    || branch.stdout.trim() !== input.branchRef || head.stdout.trim() !== observed.branchCommit) {
    return { outcome: 'FAILED', reasonCode: 'REBUILD_UNCONFIRMED',
      detail: 'The re-created worktree does not match the recorded path, branch and branch commit',
      path: input.path, branchRef: input.branchRef, headCommit: null, created: true, evidence };
  }
  return { outcome: 'REBUILT', reasonCode: 'REBUILT_FROM_TASK_BRANCH',
    detail: `The Task worktree was re-created at its recorded path from ${input.branchRef}`
      + ` (${head.stdout.trim()}); no branch was created, moved or deleted`,
    path: canonicalPath, branchRef: input.branchRef, headCommit: head.stdout.trim(),
    created: true, evidence };
}
