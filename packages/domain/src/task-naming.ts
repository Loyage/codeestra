/**
 * The Task naming rule (ADR-0065 D03).
 *
 * A Task has two titles. The display title is prose for humans; the naming title is a slug that
 * becomes both a Git branch component and a worktree directory name. This module owns the one
 * derivation that turns the recorded Task fields into that workspace name, so the Runtime, the Git
 * layer and any test all agree on it.
 *
 * A Task whose `namingTitle` is null predates the field (schema v35 backfills only the display
 * title). It keeps its internal identity as its workspace name, which is exactly the naming those
 * Tasks already have on disk: nothing is renamed by the migration, and no English name is invented
 * for a Task the user created before the field existed.
 */
export interface TaskWorkspaceNaming {
  readonly taskId: string;
  readonly displayNumber: number;
  readonly namingTitle: string | null;
}

export function taskWorkspaceName(task: TaskWorkspaceNaming): string {
  if (task.namingTitle === null) return task.taskId;
  return `${task.displayNumber}-${task.namingTitle}`;
}

/**
 * The workspace name a recorded Task branch carries, or `null` when the ref is not a Task branch.
 *
 * The recorded `workspaces.branch_ref` is the fact of what a workspace was named, and it is the only
 * source that also covers a Task created before the titles existed (whose branch is the Task id).
 * Callers that have to re-establish a layout from a recorded row use this instead of re-deriving the
 * name from the Task, so a legacy workspace keeps the directory it really has.
 */
export function taskWorkspaceNameFromBranchRef(branchRef: string): string | null {
  const prefix = 'refs/heads/task/';
  if (!branchRef.startsWith(prefix) || branchRef.length === prefix.length) return null;
  return branchRef.slice(prefix.length);
}
