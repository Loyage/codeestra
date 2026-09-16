import { describe, expect, it } from 'vitest';
import {
  purgeBranchLines,
  purgeCommand,
  purgeConfirmationMatches,
  purgeOutcomeLine,
} from '../src/task-purge.js';
import type { TaskPurgeOutcomeView } from '../src/types.js';

/**
 * The `task purge` projection (ADR-0058). The UI owns no deletion semantics: what it can be wrong
 * about is (a) whether the typed confirmation names this Task and (b) what it claims was destroyed.
 * Both are covered here without a browser, which is the only UI verification ADR-0008 allows.
 */

describe('purge confirmation', () => {
  it('accepts exactly the display number, and nothing that only looks like it', () => {
    expect(purgeConfirmationMatches({ typed: '12', displayNumber: 12 })).toBe(true);
    expect(purgeConfirmationMatches({ typed: '  12  ', displayNumber: 12 })).toBe(true);
    expect(purgeConfirmationMatches({ typed: '012', displayNumber: 12 })).toBe(true);
    // A different Task, a non-number, an empty box and a negative number are all "not confirmed".
    expect(purgeConfirmationMatches({ typed: '13', displayNumber: 12 })).toBe(false);
    expect(purgeConfirmationMatches({ typed: 'yes', displayNumber: 12 })).toBe(false);
    expect(purgeConfirmationMatches({ typed: '', displayNumber: 12 })).toBe(false);
    expect(purgeConfirmationMatches({ typed: '-12', displayNumber: 12 })).toBe(false);
    // `#12` is how the list prints it, but it is not the number the user is asked to type.
    expect(purgeConfirmationMatches({ typed: '#12', displayNumber: 12 })).toBe(false);
  });
});

describe('purge command', () => {
  it('sends confirmed: true and omits an empty reason', () => {
    const base = { projectId: 'p', taskId: 't', expectedVersion: 3, commandId: 'c' };
    expect(purgeCommand({ ...base, reason: null })).toEqual({
      command: 'task.purge', commandId: 'c', projectId: 'p', taskId: 't',
      expectedVersion: 3, confirmed: true,
    });
    expect(purgeCommand({ ...base, reason: '   ' })).not.toHaveProperty('reason');
    expect(purgeCommand({ ...base, reason: ' 不再需要 ' })).toMatchObject({ reason: '不再需要' });
  });
});

const outcome: TaskPurgeOutcomeView = {
  projectId: 'p',
  taskId: 't',
  displayNumber: 12,
  state: 'CANCELLED',
  version: 4,
  archived: false,
  reason: 'cleanup',
  purgedAt: 100,
  eventId: 'e',
  currentRevisionId: 'r',
  replayed: false,
  stop: { state: 'CANCELLED', stop: 'TERMINAL', executionId: null, sessionId: null,
    detail: 'no provider process was running' },
  plan: { worktrees: 1, verificationCopies: 1, branches: 1 },
  branchFacts: [
    { branchRef: 'refs/heads/task/t', tipCommit: 'a'.repeat(40), deleted: true, detail: 'deleted' },
  ],
  reclamation: [],
  dependencyEdgesRemoved: 2,
  rowsDeleted: { tasks: 1, task_revisions: 2 },
  detail: 'gone',
};

describe('purge outcome rendering', () => {
  it('states what was destroyed, including the branch tip that is the only surviving fact', () => {
    const line = purgeOutcomeLine(outcome);
    expect(line).toContain('任务 #12（CANCELLED）已永久删除');
    expect(line).toContain('删除行数 3');
    expect(line).toContain('工作树 1');
    expect(line).toContain('分支 1');
    expect(line).toContain('删除前已终止（CANCELLED）');
    expect(line).toContain('移除依赖边 2');
    expect(purgeBranchLines(outcome)).toEqual([
      `refs/heads/task/t → ${'a'.repeat(40)}（已删除）`,
    ]);
  });
});
