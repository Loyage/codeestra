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

  it('refuses a reclaimed worktree whose branch survived, and never claims a rebuild', () => {
    // This is the case the existing preparation path cannot handle: the directory is gone, the Git
    // registration was pruned, and `refs/heads/task/<task>` is still there, so `git worktree add`
    // would be refused by its own REF_CONFLICT guard.
    const decision = decideRetryWorkspace({
      workspaceState: 'RELEASED', observation: 'FOREIGN', evidence: 'workspace-unregistered:/w/t1',
    });
    expect(decision).toMatchObject({ allowed: false, mode: null, code: 'WORKSPACE_RECLAIMED' });
    expect(decision.message).toContain('REF_CONFLICT');
    // No mode is offered for a refusal: the caller must not record a plan it will not carry out.
    expect(decision.mode).toBeNull();
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
