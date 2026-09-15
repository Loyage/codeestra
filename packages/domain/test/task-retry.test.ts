import { describe, expect, it } from 'vitest';
import {
  decideRetryWorkspace,
  planTaskRetry,
  retryableTaskStates,
  selectRetryAdapter,
  taskRetryStates,
  type TaskRetryState,
} from '../src/index.js';

describe('task retry eligibility', () => {
  it('allows only FAILED, and never reopens CANCELLED', () => {
    const allowed = taskRetryStates.filter((state) => planTaskRetry({ state, archived: false }).allowed);
    // The only retryable source is the failure state: `retryableTaskStates` and the state table must
    // agree, or one of them is lying about what the command accepts.
    expect(allowed).toEqual([...retryableTaskStates]);
    expect(allowed).toEqual(['FAILED']);
  });

  it('answers each refusal with its own stable code', () => {
    const code = (state: TaskRetryState, archived = false): string | null =>
      planTaskRetry({ state, archived }).code;
    expect(code('CANCELLED')).toBe('TASK_CANCELLED');
    expect(code('RECOVERY_REQUIRED')).toBe('RECONCILE_REQUIRED');
    expect(code('PAUSED')).toBe('TASK_PAUSED');
    expect(code('RUNNING')).toBe('TASK_STILL_RUNNING');
    expect(code('PAUSING')).toBe('TASK_STILL_RUNNING');
    expect(code('WAITING_FOR_USER')).toBe('TASK_STILL_RUNNING');
    expect(code('CANCELLING')).toBe('TASK_STILL_RUNNING');
    expect(code('READY')).toBe('TASK_NOT_FAILED');
    expect(code('DRAFT')).toBe('TASK_NOT_FAILED');
    expect(code('BLOCKED')).toBe('TASK_NOT_FAILED');
    expect(code('EXECUTED')).toBe('TASK_NOT_FAILED');
    expect(code('SUCCEEDED')).toBe('TASK_NOT_FAILED');
    // Archived is a separate fact: a failed-but-archived Task is refused for its own reason, so a
    // hidden Task is never started behind the user's back.
    expect(code('FAILED', true)).toBe('TASK_ARCHIVED');
    expect(planTaskRetry({ state: 'FAILED', archived: true }).allowed).toBe(false);
  });

  it('does not turn a refusal into a state change: no target state is claimed', () => {
    // A refusal is a value, never an exception with a half-applied plan, so the caller can report it
    // without having written anything.
    const refusal = planTaskRetry({ state: 'CANCELLED', archived: false });
    expect(refusal).toMatchObject({ allowed: false, code: 'TASK_CANCELLED' });
    expect(refusal.message.length).toBeGreaterThan(0);
  });
});

describe('task retry Adapter selection', () => {
  it('prefers the explicit choice, then the Task record, then the fallback', () => {
    expect(selectRetryAdapter({ requested: 'codex', recorded: 'pi', fallback: 'pi' }))
      .toEqual({ adapterId: 'codex', source: 'REQUESTED' });
    expect(selectRetryAdapter({ recorded: 'codex', fallback: 'pi' }))
      .toEqual({ adapterId: 'codex', source: 'RECORDED' });
    expect(selectRetryAdapter({ requested: '   ', recorded: 'codex', fallback: 'pi' }))
      .toEqual({ adapterId: 'codex', source: 'RECORDED' });
    expect(selectRetryAdapter({ recorded: null, fallback: 'pi' }))
      .toEqual({ adapterId: 'pi', source: 'FALLBACK' });
    expect(selectRetryAdapter({ recorded: '  ', fallback: 'pi' }))
      .toEqual({ adapterId: 'pi', source: 'FALLBACK' });
  });
});

describe('task retry workspace decision', () => {
  it('reuses a verified retained worktree and prepares fresh only when nothing is there', () => {
    expect(decideRetryWorkspace({ workspaceState: 'RETAINED', observation: 'OWNED' }))
      .toMatchObject({ allowed: true, mode: 'REUSE_VERIFIED' });
    expect(decideRetryWorkspace({ workspaceState: 'READY', observation: 'OWNED' }))
      .toMatchObject({ allowed: true, mode: 'REUSE_VERIFIED' });
    expect(decideRetryWorkspace({ workspaceState: 'RETAINED', observation: 'MISSING' }))
      .toMatchObject({ allowed: true, mode: 'PREPARE_FRESH' });
    expect(decideRetryWorkspace({ workspaceState: 'RELEASED', observation: 'MISSING' }))
      .toMatchObject({ allowed: true, mode: 'PREPARE_FRESH' });
    expect(decideRetryWorkspace({ workspaceState: null, observation: 'MISSING' }))
      .toMatchObject({ allowed: true, mode: 'PREPARE_FRESH' });
  });

  it('rebuilds a reclaimed worktree whose surviving branch is this Task\'s own growth', () => {
    // The case ADR-0036 could only report: the directory is gone, its Git registration was pruned,
    // and `refs/heads/task/<task>` is still there at the recorded baseline. The branch is the
    // ownership proof, so the retry records a verified plan instead of a refusal.
    for (const relationToBase of ['EQUAL', 'DESCENDANT'] as const) {
      const decision = decideRetryWorkspace({
        workspaceState: 'RELEASED', observation: 'FOREIGN',
        evidence: 'workspace-rebuild:FOREIGN:/w/t1',
        rebuild: { pathPresent: false, registered: false, branchExists: true, relationToBase,
          checkedOutElsewhere: false },
      });
      expect(decision).toMatchObject({ allowed: true, mode: 'REBUILD_OWNED', code: null });
      expect(decision.message).toContain('does not exist yet');
    }
  });

  it('refuses a reclaimed worktree that cannot be rebuilt, with one stable code', () => {
    const base = { workspaceState: 'RELEASED' as const, observation: 'FOREIGN' as const };
    const refusals = [
      // The facts were never observed: the pre-ADR-0042 answer, unchanged.
      decideRetryWorkspace({ ...base, evidence: 'workspace-unregistered:/w/t1' }),
      // The branch is gone, so there is nothing left to re-create the worktree from.
      decideRetryWorkspace({ ...base, rebuild: { pathPresent: false, registered: false,
        branchExists: false, relationToBase: 'UNKNOWN', checkedOutElsewhere: false } }),
      // The branch exists but is not this Task's growth of the recorded baseline.
      decideRetryWorkspace({ ...base, rebuild: { pathPresent: false, registered: false,
        branchExists: true, relationToBase: 'UNRELATED', checkedOutElsewhere: false } }),
      decideRetryWorkspace({ ...base, rebuild: { pathPresent: false, registered: false,
        branchExists: true, relationToBase: 'UNKNOWN', checkedOutElsewhere: false } }),
      // Another worktree already has the branch; a second checkout is never created.
      decideRetryWorkspace({ ...base, rebuild: { pathPresent: false, registered: false,
        branchExists: true, relationToBase: 'DESCENDANT', checkedOutElsewhere: true } }),
      // Something occupies the recorded path without a Git registration: never deleted to make room.
      decideRetryWorkspace({ ...base, rebuild: { pathPresent: true, registered: false,
        branchExists: true, relationToBase: 'EQUAL', checkedOutElsewhere: false } }),
      // A registered worktree at that path is an adoption question, not a rebuild one.
      decideRetryWorkspace({ ...base, rebuild: { pathPresent: true, registered: true,
        branchExists: true, relationToBase: 'EQUAL', checkedOutElsewhere: false } }),
    ];
    for (const decision of refusals) {
      expect(decision).toMatchObject({ allowed: false, mode: null, code: 'WORKSPACE_RECLAIMED' });
      // No mode is offered for a refusal: the caller must not record a plan it will not carry out.
      expect(decision.mode).toBeNull();
    }
    // The directory question being unanswerable is never read as a rebuildable source.
    expect(decideRetryWorkspace({ workspaceState: 'RELEASED', observation: 'UNCERTAIN',
      rebuild: { pathPresent: false, registered: false, branchExists: true,
        relationToBase: 'EQUAL', checkedOutElsewhere: false } }))
      .toMatchObject({ allowed: false, code: 'WORKSPACE_RECLAIMED' });
  });

  it('refuses a worktree that is not verifiably this Task\'s own', () => {
    expect(decideRetryWorkspace({ workspaceState: 'RETAINED', observation: 'FOREIGN' }))
      .toMatchObject({ allowed: false, code: 'WORKSPACE_OWNERSHIP_UNVERIFIABLE' });
    expect(decideRetryWorkspace({ workspaceState: 'RETAINED', observation: 'UNCERTAIN' }))
      .toMatchObject({ allowed: false, code: 'WORKSPACE_OWNERSHIP_UNVERIFIABLE' });
    expect(decideRetryWorkspace({ workspaceState: 'IN_USE', observation: 'OWNED' }))
      .toMatchObject({ allowed: false, code: 'WORKSPACE_OWNERSHIP_UNVERIFIABLE' });
    expect(decideRetryWorkspace({ workspaceState: 'RECOVERY_REQUIRED', observation: 'OWNED' }))
      .toMatchObject({ allowed: false, code: 'WORKSPACE_OWNERSHIP_UNVERIFIABLE' });
  });
});
