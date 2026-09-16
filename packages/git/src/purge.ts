import { listCheckedOutRefs, readLocalRefCommit } from './refs.js';

/**
 * The one Git operation that destroys work instead of creating it: deleting a Task's own branch
 * (ADR-0058).
 *
 * `reclaim.ts` states, deliberately, that nothing there deletes a branch — reclamation keeps the
 * branch so a worktree can be rebuilt (ADR-0021/0042). A permanent purge is the opposite case: the
 * Task, its revisions and its worktree are all gone, so a branch left behind is an orphan naming a
 * Task that no longer exists. This file is therefore the whole surface, and it is bounded the same
 * way reclamation is:
 *
 *  - only a **local** branch (`refs/heads/…`) is ever considered;
 *  - a branch Git currently has checked out in any worktree is refused, because deleting it would
 *    leave that worktree on a ref that no longer exists;
 *  - the deletion is a compare-and-swap (`git update-ref -d <ref> <expected-tip>`), so a branch that
 *    moved since the caller read it is refused rather than deleted;
 *  - the tip commit is read **before** the deletion and reported, because it is the only fact about
 *    the branch that survives it.
 *
 * `--force`-style deletion is inherent: a Task's branch is normally unmerged by definition. What is
 * *not* inherent is deleting it silently — the caller gets the tip, and the audit event records it.
 */

export interface OwnedBranchRemoval {
  readonly outcome: 'REMOVED' | 'ALREADY_ABSENT' | 'REFUSED' | 'FAILED';
  readonly reasonCode: string;
  readonly detail: string;
  readonly branchRef: string;
  /** The commit the branch pointed at when it was deleted; null when there was no branch. */
  readonly tipCommit: string | null;
  readonly evidence: Readonly<Record<string, unknown>>;
}

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

export async function deleteOwnedTaskBranch(input: {
  readonly repositoryRoot: string;
  /** The branch the Task's own workspace record attests. Must be a local branch ref. */
  readonly branchRef: string;
}): Promise<OwnedBranchRemoval> {
  const evidence: Record<string, unknown> = {
    repositoryRoot: input.repositoryRoot,
    branchRef: input.branchRef,
  };
  const refuse = (reasonCode: string, detail: string, tipCommit: string | null = null):
  OwnedBranchRemoval => ({ outcome: 'REFUSED', reasonCode, detail, branchRef: input.branchRef,
    tipCommit, evidence });

  if (!input.branchRef.startsWith('refs/heads/')) {
    return refuse('NOT_A_LOCAL_BRANCH',
      'The recorded branch is not a local branch; nothing was deleted');
  }

  const tip = await readLocalRefCommit({
    repositoryRoot: input.repositoryRoot, ref: input.branchRef,
  });
  evidence['tipCommit'] = tip;
  if (tip === null) {
    return { outcome: 'ALREADY_ABSENT', reasonCode: 'NOT_PRESENT',
      detail: 'The branch does not exist; there was nothing to delete',
      branchRef: input.branchRef, tipCommit: null, evidence };
  }

  const worktrees = await listCheckedOutRefs(input.repositoryRoot);
  const checkedOut = worktrees.find((worktree) => worktree.ref === input.branchRef);
  if (checkedOut !== undefined) {
    evidence['checkedOutAt'] = checkedOut.path;
    return refuse('BRANCH_CHECKED_OUT',
      `Branch ${input.branchRef} is checked out at ${checkedOut.path}; deleting it would leave`
      + ' that worktree on a ref that no longer exists', tip);
  }

  // Compare-and-swap: the expected tip makes "the branch moved since it was read" a refusal instead
  // of a deletion of commits the caller never saw.
  const removal = await runGit(input.repositoryRoot,
    ['update-ref', '-d', input.branchRef, tip]);
  if (removal.exitCode !== 0) {
    return { outcome: 'FAILED', reasonCode: 'DELETE_FAILED',
      detail: removal.stderr.trim() || `git update-ref exited with ${removal.exitCode}`,
      branchRef: input.branchRef, tipCommit: tip,
      evidence: { ...evidence, stderr: removal.stderr.trim() } };
  }
  const after = await readLocalRefCommit({ repositoryRoot: input.repositoryRoot, ref: input.branchRef });
  if (after !== null) {
    return { outcome: 'FAILED', reasonCode: 'DELETE_UNCONFIRMED',
      detail: 'The branch still exists after the deletion', branchRef: input.branchRef,
      tipCommit: tip, evidence };
  }
  return { outcome: 'REMOVED', reasonCode: 'REMOVED',
    detail: `Branch ${input.branchRef} was deleted at ${tip}`, branchRef: input.branchRef,
    tipCommit: tip, evidence };
}
