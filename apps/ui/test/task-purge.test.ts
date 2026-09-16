import { describe, expect, it } from 'vitest';
import {
  purgeBranchLines,
  purgeCommand,
  purgeConfirmationMatches,
  purgeForcedLines,
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

  it('sends force: true only when the user asked to force the deletion', () => {
    const base = { projectId: 'p', taskId: 't', expectedVersion: 3, commandId: 'c', reason: null };
    expect(purgeCommand(base)).not.toHaveProperty('force');
    expect(purgeCommand({ ...base, force: false })).not.toHaveProperty('force');
    expect(purgeCommand({ ...base, force: true })).toMatchObject({
      confirmed: true, force: true,
    });
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
  forced: null,
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

  it('names the observation reconcile when the deleted Task was RECOVERY_REQUIRED', () => {
    const line = purgeOutcomeLine({
      ...outcome,
      state: 'FAILED',
      stop: { state: 'FAILED', stop: 'RECOVERED', executionId: 'e1', sessionId: 's1',
        detail: 'provider is gone; the run is closed as FAILED' },
    });
    expect(line).toContain('删除前已按观察对账（FAILED）');
  });

  it('reports a forced deletion as forced, and lists exactly what it stepped over', () => {
    const forced: TaskPurgeOutcomeView = {
      ...outcome,
      state: 'RECOVERY_REQUIRED',
      stop: { state: 'RECOVERY_REQUIRED', stop: 'FORCED', executionId: 'e1', sessionId: 's1',
        detail: 'provider could not be proven gone; deleted anyway because --force was passed' },
      forced: {
        bypassed: [
          { code: 'RECONCILE_REQUIRED', detail: 'provider process 7001 is still running' },
          { code: 'PURGE_RESOURCE_NOT_OWNED',
            detail: 'TASK_WORKTREE /tmp/w: ACTIVE_EXECUTION (left on disk)' },
        ],
        termination: { attempted: true, signalsSent: 2, terminated: false, survivors: [7001],
          unattributable: [], detail: 'sent 2 signal(s) but 7001 is still running' },
      },
    };
    const line = purgeOutcomeLine(forced);
    expect(line).toContain('强制删除：进程未证明静止（RECOVERY_REQUIRED）');
    expect(line).toContain('--force 跳过 2 项拒绝');
    expect(purgeForcedLines(forced)).toEqual([
      'RECONCILE_REQUIRED — provider process 7001 is still running',
      'PURGE_RESOURCE_NOT_OWNED — TASK_WORKTREE /tmp/w: ACTIVE_EXECUTION (left on disk)',
      'provider 进程可能仍在运行：sent 2 signal(s) but 7001 is still running',
    ]);
    // An ordinary deletion has nothing to report here, and nothing to claim either.
    expect(purgeForcedLines(outcome)).toEqual([]);
    const terminated = purgeForcedLines({ ...forced, forced: { ...forced.forced as NonNullable<
      TaskPurgeOutcomeView['forced']>, termination: { attempted: true, signalsSent: 1,
      terminated: true, survivors: [], unattributable: [], detail: 'no recorded process remains' } } });
    expect(terminated.at(-1)).toContain('已尝试终止 provider 进程');
  });
});
