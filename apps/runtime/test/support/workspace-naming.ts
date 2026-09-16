import { join } from 'node:path';
import { Phase1Database } from '@codeestra/storage';

/**
 * The workspace namespace the Runtime recorded for a Task (ADR-0065 D03).
 *
 * A Task's workspace is named `<displayNumber>-<namingTitle>` when the Task has a naming title, and
 * the internal Task id when it predates the field. The Runtime records the branch and the path on the
 * `workspaces` row, so a CLI-level test can read the fact instead of re-deriving the name — which
 * matters because protocol stubs in these tests key the files they write on the directory they run
 * in, and a second, slightly different derivation in the test would only prove the two derivations
 * agree with each other.
 *
 * These helpers open the Runtime's own database read-only in intent (a plain `SELECT`); the Runtime
 * is a daemon in these tests, and WAL mode lets a second reader see the committed rows.
 */
function workspaceBranchRef(home: string, taskId: string): string {
  const storage = new Phase1Database(join(home, 'runtime.sqlite'));
  try {
    const workspace = storage.getLatestTaskWorkspace(taskId);
    if (workspace === null) {
      throw new Error(`Task ${taskId} has no recorded workspace in ${home}`);
    }
    return workspace.branchRef;
  } finally {
    storage.close();
  }
}

/** `refs/heads/task/<workspace-name>` as recorded, or a stated failure when there is none. */
export function recordedWorkspaceBranch(home: string, taskId: string): string {
  const branchRef = workspaceBranchRef(home, taskId);
  if (!branchRef.startsWith('refs/heads/task/')) {
    throw new Error(`Task ${taskId} has an unexpected workspace branch ${branchRef}`);
  }
  return branchRef;
}

/** The workspace directory name, which is also the branch name under `refs/heads/task/`. */
export function recordedWorkspaceName(home: string, taskId: string): string {
  return recordedWorkspaceBranch(home, taskId).slice('refs/heads/task/'.length);
}

/** The absolute workspace directory the Runtime recorded for the Task. */
export function recordedWorkspacePath(home: string, taskId: string): string {
  const storage = new Phase1Database(join(home, 'runtime.sqlite'));
  try {
    const workspace = storage.getLatestTaskWorkspace(taskId);
    if (workspace === null) {
      throw new Error(`Task ${taskId} has no recorded workspace in ${home}`);
    }
    return workspace.path;
  } finally {
    storage.close();
  }
}
