import { isAbsolute, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { GitInspectionError } from './errors.js';

/**
 * The Project-managed integration ref and worktree (ADR-0070 D07, roadmap S8, ADR-0074).
 *
 * Three properties are enforced here rather than trusted to a caller:
 *
 *  1. **Nothing advances a ref without a compare-and-swap.** `compareAndSwapRef` is
 *     `git update-ref <ref> <new> <expected>`, which Git performs atomically: a ref that moved since
 *     the merge was based on it fails the swap instead of being overwritten.
 *  2. **The integration worktree is recognized, not assumed.** Before a merge, the worktree is
 *     checked to be registered at its exact canonical path, detached, and stopped at the expected
 *     integration commit. An unrecognized directory is refused instead of being written into.
 *  3. **A conflict is kept, not cleaned away.** `mergeCandidate` never runs `merge --abort` on a
 *     conflict; the conflicted tree stays as the scene, and only an explicit retry resets the owned
 *     worktree back to the commit the merge started from.
 *
 * No function here writes to any branch the user has checked out.
 */

/**
 * The one Git-layer spelling of the managed integration ref. `@codeestra/domain` owns the semantic
 * name (`managedIntegrationRef`) and a targeted test asserts the two are the same string, so the
 * Git port never has to import the domain package and the two can never silently drift apart.
 */
export const managedIntegrationRefName = 'refs/codeestra/integration';

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

async function runGit(cwd: string, args: readonly string[]): Promise<{
  readonly exitCode: number; readonly stdout: string; readonly stderr: string;
}> {
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

/** Reads any ref's commit, or null when the ref does not exist. Missing is not an error. */
export async function readRefCommit(input: {
  readonly repositoryRoot: string;
  readonly ref: string;
}): Promise<string | null> {
  const result = await runGit(input.repositoryRoot, ['rev-parse', '--verify', '--quiet', input.ref]);
  if (result.exitCode === 0) return result.stdout.trim();
  if (result.exitCode === 1 || result.exitCode === 128) return null;
  throw new GitInspectionError('COMMAND_FAILED',
    result.stderr.trim() || `git rev-parse exited with ${result.exitCode}`);
}

/**
 * Creates a ref pointing at `commit` only when it does not exist yet. The empty expected value is
 * Git's own "must not exist" precondition, so two Runtimes racing on the same fresh project cannot
 * both create it with different commits.
 */
export async function createRefIfAbsent(input: {
  readonly repositoryRoot: string;
  readonly ref: string;
  readonly commit: string;
}): Promise<{ readonly created: boolean; readonly commit: string }> {
  const result = await runGit(input.repositoryRoot,
    ['update-ref', input.ref, input.commit, '']);
  if (result.exitCode === 0) return { created: true, commit: input.commit };
  const existing = await readRefCommit({ repositoryRoot: input.repositoryRoot, ref: input.ref });
  if (existing !== null) return { created: false, commit: existing };
  throw new GitInspectionError('COMMAND_FAILED',
    result.stderr.trim() || `git update-ref ${input.ref} exited with ${result.exitCode}`);
}

/**
 * The managed integration ref, materialized if it does not exist yet.
 *
 * A project trusted on schema v38 already has the ref: trust creates it from the commit the folder
 * had checked out. This is the "first need" path for a project trusted earlier (ADR-0074): the
 * baseline resolver asks for the integration ref, and if there is none it is created from the branch
 * the folder has checked out *right now* — the rule the Task path used before S8. An existing ref is
 * never moved, and a folder with no branch to name (a detached HEAD, an unborn repository) is refused
 * with a named error rather than resolved to a commit nobody asked for.
 */
export async function ensureManagedIntegrationRef(input: {
  readonly repositoryRoot: string;
}): Promise<{ readonly commit: string; readonly created: boolean }> {
  const existing = await readRefCommit({ repositoryRoot: input.repositoryRoot,
    ref: managedIntegrationRefName });
  if (existing !== null) return { commit: existing, created: false };
  const head = await runGit(input.repositoryRoot, ['symbolic-ref', '-q', 'HEAD']);
  if (head.exitCode !== 0) {
    throw new GitInspectionError('INVALID_REPOSITORY',
      `${input.repositoryRoot} has no checked out branch, so the managed integration ref has no`
      + ' commit to be created from; check out a branch (or run `project integration init` after'
      + ' doing so) and try again');
  }
  const commit = await runGit(input.repositoryRoot, ['rev-parse', '--verify', 'HEAD']);
  if (commit.exitCode !== 0) {
    throw new GitInspectionError('INVALID_REPOSITORY',
      commit.stderr.trim() || `${input.repositoryRoot} has no resolvable HEAD`);
  }
  const created = await createRefIfAbsent({ repositoryRoot: input.repositoryRoot,
    ref: managedIntegrationRefName, commit: commit.stdout.trim() });
  return { commit: created.commit, created: created.created };
}

export interface RefSwap {
  readonly advanced: boolean;
  readonly currentOid: string | null;
  readonly detail: string | null;
}

/** `git update-ref <ref> <new> <expected>`: the CAS that advances a managed ref. */
export async function compareAndSwapRef(input: {
  readonly repositoryRoot: string;
  readonly ref: string;
  readonly expectedOid: string;
  readonly newOid: string;
}): Promise<RefSwap> {
  const result = await runGit(input.repositoryRoot,
    ['update-ref', input.ref, input.newOid, input.expectedOid]);
  if (result.exitCode === 0) return { advanced: true, currentOid: input.newOid, detail: null };
  const current = await readRefCommit({ repositoryRoot: input.repositoryRoot, ref: input.ref });
  if (current !== input.expectedOid) {
    // The ref moved (or was deleted). That is a fact to report, not a retryable command failure.
    return { advanced: false, currentOid: current,
      detail: `the ref is at ${current ?? 'nothing'}, not ${input.expectedOid}` };
  }
  throw new GitInspectionError('COMMAND_FAILED',
    result.stderr.trim() || `git update-ref ${input.ref} exited with ${result.exitCode}`);
}

/** Deletes a ref only when it still points where the caller last saw it. */
export async function deleteRefIfUnchanged(input: {
  readonly repositoryRoot: string;
  readonly ref: string;
  readonly expectedOid: string;
}): Promise<{ readonly removed: boolean; readonly currentOid: string | null }> {
  const result = await runGit(input.repositoryRoot,
    ['update-ref', '-d', input.ref, input.expectedOid]);
  if (result.exitCode === 0) return { removed: true, currentOid: null };
  const current = await readRefCommit({ repositoryRoot: input.repositoryRoot, ref: input.ref });
  return { removed: false, currentOid: current };
}

export interface WorktreeFact {
  readonly path: string;
  readonly head: string | null;
  readonly branchRef: string | null;
  readonly detached: boolean;
}

/** Every worktree Git has registered for this repository, with its HEAD and branch fact. */
export async function listWorktrees(repositoryRoot: string): Promise<readonly WorktreeFact[]> {
  const result = await runGit(repositoryRoot, ['worktree', 'list', '--porcelain', '-z']);
  if (result.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED',
      result.stderr.trim() || `git worktree list exited with ${result.exitCode}`);
  }
  const facts: WorktreeFact[] = [];
  for (const record of result.stdout.split('\0\0')) {
    if (record.length === 0) continue;
    const fields = record.split('\0');
    const path = fields.find((field) => field.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined) continue;
    facts.push({
      path,
      head: fields.find((field) => field.startsWith('HEAD '))?.slice('HEAD '.length) ?? null,
      branchRef: fields.find((field) => field.startsWith('branch '))?.slice('branch '.length) ?? null,
      detached: fields.includes('detached'),
    });
  }
  return facts;
}

export interface IntegrationWorktreeState {
  readonly state: 'OWNED' | 'MISSING' | 'FOREIGN' | 'UNCERTAIN';
  readonly headCommit: string | null;
  readonly evidence: string;
}

/**
 * What the Runtime can prove about the integration worktree right now. It is a read: nothing is
 * created, moved or deleted, so a crash cannot be hidden by a repair during observation.
 */
export async function inspectIntegrationWorktree(input: {
  readonly repositoryRoot: string;
  readonly worktreePath: string;
}): Promise<IntegrationWorktreeState> {
  try {
    const registered = await listWorktrees(input.repositoryRoot);
    const canonicalPath = await realpath(input.worktreePath)
      .catch(() => input.worktreePath);
    const record = registered.find((fact) => fact.path === input.worktreePath
      || fact.path === canonicalPath);
    if (record === undefined) {
      const exists = await pathExists(input.worktreePath);
      return exists
        ? { state: 'FOREIGN', headCommit: null,
            evidence: `worktree-unregistered:${input.worktreePath}` }
        : { state: 'MISSING', headCommit: null, evidence: `worktree-missing:${input.worktreePath}` };
    }
    if (!record.detached) {
      return { state: 'FOREIGN', headCommit: record.head,
        evidence: `worktree-has-branch:${record.branchRef ?? 'unknown'}` };
    }
    if (record.head === null) {
      return { state: 'UNCERTAIN', headCommit: null,
        evidence: `worktree-head-unreadable:${input.worktreePath}` };
    }
    const head = await runGit(input.worktreePath, ['rev-parse', '--verify', 'HEAD']);
    if (head.exitCode !== 0) {
      return { state: 'UNCERTAIN', headCommit: null,
        evidence: `worktree-head-unreadable:${input.worktreePath}` };
    }
    return { state: 'OWNED', headCommit: head.stdout.trim(),
      evidence: `worktree-owned:${input.worktreePath}:${head.stdout.trim()}` };
  } catch (error) {
    return { state: 'UNCERTAIN', headCommit: null,
      evidence: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Creates the detached integration worktree at `commit` when it is missing, and verifies an existing
 * one is really ours. It never adopts a directory that is registered to another branch, and never
 * resets a worktree that has uncommitted work — a dirty scene is reported, not overwritten.
 */
export async function ensureIntegrationWorktree(input: {
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly commit: string;
}): Promise<{ readonly state: 'CREATED' | 'OWNED'; readonly headCommit: string }> {
  if (!isAbsolute(input.worktreePath)) {
    throw new GitInspectionError('UNSAFE_CHECKOUT', 'The integration worktree path must be absolute');
  }
  const requested = resolve(input.worktreePath);
  const root = await runGit(input.repositoryRoot, ['rev-parse', '--show-toplevel']);
  if (root.exitCode !== 0) {
    throw new GitInspectionError('INVALID_REPOSITORY',
      root.stderr.trim() || 'The project repository could not be read');
  }
  const repoRoot = await realpath(root.stdout.trim());
  const before = await inspectIntegrationWorktree({
    repositoryRoot: repoRoot, worktreePath: requested,
  });
  if (before.state === 'OWNED') {
    const dirty = await runGit(requested, ['status', '--porcelain']);
    if (dirty.exitCode !== 0) {
      throw new GitInspectionError('COMMAND_FAILED', dirty.stderr.trim() || 'git status failed');
    }
    if (dirty.stdout.trim().length > 0 && before.headCommit !== input.commit) {
      throw new GitInspectionError('FOREIGN_RESOURCE',
        'The integration worktree has uncommitted work and is not at the expected commit;'
        + ' resolve it before integrating again');
    }
    return { state: 'OWNED', headCommit: before.headCommit as string };
  }
  if (before.state === 'FOREIGN' || before.state === 'UNCERTAIN') {
    throw new GitInspectionError('FOREIGN_RESOURCE',
      `The integration worktree path ${requested} is not an owned detached worktree: ${before.evidence}`);
  }
  const added = await runGit(repoRoot,
    ['worktree', 'add', '--detach', requested, input.commit]);
  if (added.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED',
      added.stderr.trim() || added.stdout.trim()
      || `git worktree add --detach exited with ${added.exitCode}`, true);
  }
  const after = await inspectIntegrationWorktree({ repositoryRoot: repoRoot, worktreePath: requested });
  if (after.state !== 'OWNED' || after.headCommit !== input.commit) {
    throw new GitInspectionError('FOREIGN_RESOURCE',
      `The created integration worktree is not at ${input.commit}: ${after.evidence}`, true);
  }
  return { state: 'CREATED', headCommit: after.headCommit as string };
}

export interface MergeOutcome {
  readonly outcome: 'MERGED' | 'CONFLICT';
  readonly candidateCommit: string | null;
  readonly integrationOid: string;
  readonly conflictedPaths: readonly string[];
  readonly detail: string | null;
}

/**
 * Merges one Task result into the integration worktree.
 *
 * `--no-ff` keeps every Task's contribution a distinct merge commit, so "which Task produced this
 * state" can still be answered from the integration history. The merge commit records the repository
 * identity the project already uses; when it is missing, Git fails and that failure is propagated
 * rather than papered over with a fabricated author.
 *
 * A conflict leaves the merge in progress: the conflicted paths are reported, and the worktree keeps
 * the conflict until an explicit retry resets it. Nothing is aborted here.
 */
export async function mergeCandidateIntoIntegration(input: {
  readonly worktreePath: string;
  readonly resultCommit: string;
  readonly expectedIntegrationOid: string;
  readonly message: string;
}): Promise<MergeOutcome> {
  const head = await runGit(input.worktreePath, ['rev-parse', '--verify', 'HEAD']);
  if (head.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED', head.stderr.trim() || 'HEAD could not be read');
  }
  const startCommit = head.stdout.trim();
  if (startCommit !== input.expectedIntegrationOid) {
    throw new GitInspectionError('STALE_BASE',
      `The integration worktree is at ${startCommit}, not at the expected ${input.expectedIntegrationOid}`);
  }
  const inProgress = await runGit(input.worktreePath, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']);
  if (inProgress.exitCode === 0) {
    throw new GitInspectionError('FOREIGN_RESOURCE',
      'The integration worktree already has a merge in progress; resolve or retry it first');
  }
  const merged = await runGit(input.worktreePath,
    ['merge', '--no-ff', '--no-edit', '-m', input.message, input.resultCommit]);
  if (merged.exitCode !== 0) {
    const conflicted = await runGit(input.worktreePath,
      ['diff', '--name-only', '--diff-filter=U']);
    const paths = conflicted.exitCode === 0
      ? conflicted.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      : [];
    if (paths.length === 0) {
      throw new GitInspectionError('COMMAND_FAILED',
        merged.stderr.trim() || merged.stdout.trim()
        || `git merge exited with ${merged.exitCode}`);
    }
    return {
      outcome: 'CONFLICT',
      candidateCommit: null,
      integrationOid: input.expectedIntegrationOid,
      conflictedPaths: paths,
      detail: merged.stderr.trim() || merged.stdout.trim() || null,
    };
  }
  const candidate = await runGit(input.worktreePath, ['rev-parse', '--verify', 'HEAD']);
  if (candidate.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED', candidate.stderr.trim() || 'HEAD could not be read');
  }
  const candidateCommit = candidate.stdout.trim();
  const parents = await runGit(input.worktreePath,
    ['rev-list', '--parents', '-n', '1', candidateCommit]);
  const firstParent = parents.stdout.trim().split(' ')[1] ?? null;
  if (parents.exitCode !== 0 || firstParent !== input.expectedIntegrationOid) {
    throw new GitInspectionError('COMMAND_FAILED',
      `The merge commit ${candidateCommit} does not have ${input.expectedIntegrationOid} as its`
      + ' first parent; the integration worktree was not where it was thought to be');
  }
  return {
    outcome: 'MERGED',
    candidateCommit,
    integrationOid: candidateCommit,
    conflictedPaths: [],
    detail: null,
  };
}

/** True when the worktree has a merge in progress, and which paths are still conflicted. */
export async function inspectMergeState(worktreePath: string): Promise<{
  readonly merging: boolean;
  readonly conflictedPaths: readonly string[];
}> {
  const inProgress = await runGit(worktreePath, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']);
  if (inProgress.exitCode !== 0) return { merging: false, conflictedPaths: [] };
  const conflicted = await runGit(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
  return {
    merging: true,
    conflictedPaths: conflicted.exitCode === 0
      ? conflicted.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      : [],
  };
}

/**
 * The explicit retry path: abort an in-progress merge and put the owned worktree back on the commit
 * the merge started from. It refuses when the worktree is not on the recorded candidate/integration
 * commit, so it can never be used to throw away work the Runtime did not create.
 */
export async function resetIntegrationWorktree(input: {
  readonly worktreePath: string;
  readonly expectedHead: string;
  readonly commit: string;
}): Promise<{ readonly headCommit: string }> {
  const head = await runGit(input.worktreePath, ['rev-parse', '--verify', 'HEAD']);
  if (head.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED', head.stderr.trim() || 'HEAD could not be read');
  }
  if (head.stdout.trim() !== input.expectedHead) {
    throw new GitInspectionError('FOREIGN_RESOURCE',
      `The integration worktree is at ${head.stdout.trim()}, not at the recorded ${input.expectedHead}`);
  }
  const state = await inspectMergeState(input.worktreePath);
  if (state.merging) {
    const aborted = await runGit(input.worktreePath, ['merge', '--abort']);
    if (aborted.exitCode !== 0) {
      throw new GitInspectionError('COMMAND_FAILED',
        aborted.stderr.trim() || 'git merge --abort failed');
    }
  }
  const reset = await runGit(input.worktreePath, ['reset', '--hard', input.commit]);
  if (reset.exitCode !== 0) {
    throw new GitInspectionError('COMMAND_FAILED', reset.stderr.trim() || 'git reset --hard failed');
  }
  const after = await runGit(input.worktreePath, ['rev-parse', '--verify', 'HEAD']);
  return { headCommit: after.stdout.trim() };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await realpath(path);
    return true;
  } catch {
    return false;
  }
}

/** The Runtime data directory path an integration worktree of one project uses. */
export function integrationWorktreePath(input: {
  readonly integrationRoot: string;
  readonly projectId: string;
}): string {
  return join(input.integrationRoot, input.projectId);
}
