import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { captureResultCommit, prepareResultCommit } from '../src/result-commit-service.js';
import { reconcileInterruptedVerifications } from '../src/recovery-service.js';
import { VerificationRunner, runTaskVerification } from '../src/verification-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  git,
  type AgentFixture,
  type AgentFixtureOptions,
} from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

interface ExecutedFixture {
  readonly value: AgentFixture;
  readonly workspacePath: string;
  readonly resultCommit: string;
  readonly copiesRoot: string;
}

/** Runs a fake Agent to a captured result commit, leaving an EXECUTED Task. */
async function executedTask(options: AgentFixtureOptions = {}): Promise<ExecutedFixture> {
  const value = await createAgentFixture(options);
  const adapter = new DeterministicFakeAdapter('SUCCEED', [{
    type: 'completed', eventId: 'fake-completed-1', cursor: 'cursor-1',
    outcome: 'SUCCESS', evidenceRef: 'fake-quiescence',
  }]);
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const coordinator = new AgentRuntimeCoordinator({
    storage: value.storage, registry, runtimeHome: value.home,
  });
  const run = await coordinator.runTask({
    projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
    commandId: crypto.randomUUID(), adapterId: adapter.id,
  });
  await coordinator.settle();
  await Bun.write(join(run.workspacePath, 'agent-output.txt'), 'work\n');
  const prepared = await prepareResultCommit({
    storage: value.storage, projectId: value.projectId, taskId: value.taskId,
    commandId: crypto.randomUUID(), actor: 'local-user',
  });
  const captured = await captureResultCommit({
    storage: value.storage, projectId: value.projectId, taskId: value.taskId,
    authorizationId: prepared.authorizationId, commandId: crypto.randomUUID(),
  });
  return {
    value,
    workspacePath: run.workspacePath,
    resultCommit: captured.resultCommit,
    copiesRoot: join(value.home, 'verifications'),
  };
}

function verify(fixture: ExecutedFixture, overrides: Readonly<Record<string, unknown>> = {}) {
  return runTaskVerification({
    storage: fixture.value.storage,
    runner: new VerificationRunner(),
    copiesRoot: fixture.copiesRoot,
    projectId: fixture.value.projectId,
    taskId: fixture.value.taskId,
    commandId: crypto.randomUUID(),
    ...overrides,
  });
}

describe('task verification', () => {
  test('runs the confirmed policy against the frozen result commit in an isolated copy', async () => {
    const fixture = await executedTask();
    try {
      const report = await verify(fixture);
      expect(report).toMatchObject({
        state: 'PASSED',
        outcomeCode: 'PASSED',
        testedCommit: fixture.resultCommit,
        policyVersion: 'verification-policy-v1',
        policyDigest: fixture.value.verificationPolicy.digest,
        alreadyCompleted: false,
        copyRemoved: true,
      });
      expect(report.commands).toEqual([expect.objectContaining({ id: 'smoke', exitCode: 0,
        stdoutTail: 'verification-ok\n' })]);
      expect(report.tree).toMatchObject({ clean: true, trackedModifications: [] });
      // Evidence is recorded, and no captured command output is persisted with it.
      const stored = fixture.value.storage.getVerificationRun(fixture.value.projectId,
        report.verificationId);
      expect(stored.state).toBe('PASSED');
      expect(stored.evidence).not.toHaveProperty('commands.0.stdoutTail');
      expect(JSON.stringify(stored.evidence)).not.toContain('stdoutTail');
      expect(JSON.stringify(stored.evidence)).not.toContain('stderrTail');
      expect(stored.evidence).toMatchObject({
        testedCommit: fixture.resultCommit,
        commands: [expect.objectContaining({ id: 'smoke', exitCode: 0 })],
      });
      // The copy is gone, the Task worktree still holds the uncommitted Agent edits, and
      // the user's own checkout was never touched.
      expect(await Bun.file(report.copyPath).exists()).toBe(false);
      expect(await git(fixture.value.repo, ['worktree', 'list', '--porcelain']))
        .not.toContain(report.copyPath);
      expect(await git(fixture.value.repo, ['status', '--porcelain'])).toBe('');
      expect(await git(fixture.value.repo, ['rev-parse', 'HEAD'])).toBe(fixture.value.mainCommit);
      expect(await Bun.file(join(fixture.workspacePath, 'agent-output.txt')).text()).toBe('work\n');
      // Verification never claims the Task itself is integrated or successful.
      expect(fixture.value.storage.listTasks(fixture.value.projectId)[0]?.state).toBe('EXECUTED');
    } finally {
      fixture.value.storage.close();
    }
  });

  test('replays a recorded command without running the policy a second time', async () => {
    const fixture = await executedTask();
    try {
      const commandId = crypto.randomUUID();
      const first = await verify(fixture, { commandId });
      const replay = await verify(fixture, { commandId });
      expect(first.alreadyCompleted).toBe(false);
      expect(replay).toMatchObject({
        alreadyCompleted: true,
        verificationId: first.verificationId,
        state: 'PASSED',
        copyRemoved: null,
      });
      // A replay reports the recorded exit facts without inventing output tails.
      expect(replay.commands[0]).toMatchObject({ id: 'smoke', exitCode: 0, stdoutTail: '' });
      expect(fixture.value.storage.listVerificationRuns(fixture.value.projectId,
        fixture.value.taskId)).toHaveLength(1);
      expect(await git(fixture.value.repo, ['worktree', 'list', '--porcelain']))
        .not.toContain(first.copyPath);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('records a failing command as FAILED and stops before later commands', async () => {
    const fixture = await executedTask({ verificationCommands: [
      { id: 'broken', argv: ['false'], cwd: '.', timeoutSeconds: 60 },
      { id: 'never', argv: ['echo', 'unreachable'], cwd: '.', timeoutSeconds: 60 },
    ] });
    try {
      const report = await verify(fixture);
      expect(report).toMatchObject({ state: 'FAILED', outcomeCode: 'COMMAND_FAILED' });
      expect(report.commands.map((command) => command.id)).toEqual(['broken']);
      expect(report.commands[0]?.exitCode).not.toBe(0);
      expect(report.copyRemoved).toBe(true);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('separates a timeout from a judged failure and still cleans up the copy', async () => {
    const fixture = await executedTask({ verificationCommands: [
      { id: 'hang', argv: ['sleep', '30'], cwd: '.', timeoutSeconds: 1 },
    ] });
    try {
      const report = await verify(fixture);
      expect(report).toMatchObject({ state: 'ERROR', outcomeCode: 'COMMAND_TIMEOUT' });
      expect(report.commands[0]).toMatchObject({ timedOut: true });
      expect(report.copyRemoved).toBe(true);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses to pass when a command changed the tree it was judging', async () => {
    const fixture = await executedTask({ verificationCommands: [
      // `tee` with ignored stdin truncates a tracked file: the judged tree is no longer
      // the tree that produced the exit code.
      { id: 'mutate', argv: ['tee', 'README.md'], cwd: '.', timeoutSeconds: 60 },
    ] });
    try {
      const report = await verify(fixture);
      expect(report).toMatchObject({ state: 'ERROR', outcomeCode: 'TREE_MUTATED' });
      expect(report.commands[0]?.exitCode).toBe(0);
      expect(report.tree?.trackedModifications).toEqual(['README.md']);
      expect(report.tree?.clean).toBe(false);
    } finally {
      fixture.value.storage.close();
    }
  });
});

describe('verification refusals', () => {
  test('refuses when the project has no verification policy at all', async () => {
    const fixture = await executedTask({ withoutVerificationPolicy: true });
    try {
      await expect(verify(fixture)).rejects.toMatchObject({ code: 'VERIFICATION_POLICY_ABSENT' });
      expect(fixture.value.storage.listVerificationRuns(fixture.value.projectId,
        fixture.value.taskId)).toHaveLength(0);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses when the policy at main changed after it was confirmed', async () => {
    const fixture = await executedTask();
    try {
      await Bun.write(join(fixture.value.repo, '.codeestra/policies/verification.json'),
        `${JSON.stringify({ version: 1, commands: [{ id: 'weakened', argv: ['true'] }] })}\n`);
      await git(fixture.value.repo, ['add', '.codeestra/policies/verification.json']);
      await git(fixture.value.repo, ['commit', '-m', 'change verification policy']);
      await expect(verify(fixture)).rejects.toMatchObject({ code: 'VERIFICATION_POLICY_NOT_CONFIRMED' });
      expect(fixture.value.storage.listVerificationRuns(fixture.value.projectId,
        fixture.value.taskId)).toHaveLength(0);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses when the Agent changed the policy on the Task branch', async () => {
    const fixture = await executedTask();
    try {
      // A Task branch may contain its own version of the policy file: the trusted main ref
      // decides, so an Agent cannot judge itself with weaker commands.
      await Bun.write(join(fixture.workspacePath, '.codeestra/policies/verification.json'),
        `${JSON.stringify({ version: 1, commands: [{ id: 'weakened', argv: ['true'] }] })}\n`);
      const report = await verify(fixture);
      expect(report.state).toBe('PASSED');
      expect(report.policyDigest).toBe(fixture.value.verificationPolicy.digest as string);
      expect(report.commands.map((command) => command.id)).toEqual(['smoke']);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses a Task without a captured result commit and an unknown Execution', async () => {
    const fixture = await executedTask();
    try {
      const other = await createAgentFixture();
      try {
        await expect(runTaskVerification({
          storage: other.storage,
          runner: new VerificationRunner(),
          copiesRoot: join(other.home, 'verifications'),
          projectId: other.projectId,
          taskId: other.taskId,
          commandId: crypto.randomUUID(),
        })).rejects.toMatchObject({ code: 'TASK_NOT_EXECUTED' });
      } finally {
        other.storage.close();
      }
      await expect(verify(fixture, { executionId: crypto.randomUUID() }))
        .rejects.toMatchObject({ code: 'EXECUTION_NOT_FOUND' });
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses to verify a project that confirmed no policy', async () => {
    const fixture = await executedTask({ withoutVerificationPolicy: true });
    try {
      // The policy appears after trust: verification still waits for an explicit confirmation.
      await Bun.write(join(fixture.value.repo, '.codeestra/policies/verification.json'),
        `${JSON.stringify({ version: 1, commands: [{ id: 'smoke', argv: ['true'] }] })}\n`);
      await git(fixture.value.repo, ['add', '.codeestra/policies/verification.json']);
      await git(fixture.value.repo, ['commit', '-m', 'add verification policy']);
      await expect(verify(fixture)).rejects.toMatchObject({ code: 'VERIFICATION_POLICY_NOT_CONFIRMED' });
    } finally {
      fixture.value.storage.close();
    }
  });
});

describe('verification recovery', () => {
  test('records an interrupted run as ERROR and keeps its copy for inspection', async () => {
    const fixture = await executedTask();
    try {
      const report = await verify(fixture);
      // Simulate a Runtime that stopped mid-run by rewinding the stored run to RUNNING.
      fixture.value.storage.sqlite.query(`
        UPDATE verification_runs SET state='RUNNING',outcome_code=NULL,ended_at=NULL
        WHERE id=?1
      `).run(report.verificationId);
      fixture.value.storage.sqlite.query(`
        UPDATE operations SET state='IN_PROGRESS' WHERE id=(
          SELECT operation_id FROM verification_runs WHERE id=?1)
      `).run(report.verificationId);
      const results = reconcileInterruptedVerifications({ storage: fixture.value.storage });
      expect(results).toEqual([{
        verificationId: report.verificationId,
        outcome: 'RECOVERED_FAILED',
        copyPath: report.copyPath,
      }]);
      const recovered = fixture.value.storage.getVerificationRun(fixture.value.projectId,
        report.verificationId);
      expect(recovered).toMatchObject({ state: 'ERROR', outcomeCode: 'RUNTIME_RESTARTED' });
      expect(recovered.evidence).toMatchObject({ previousState: 'RUNNING' });
      expect(fixture.value.storage.listIncompleteVerificationRuns()).toEqual([]);
    } finally {
      fixture.value.storage.close();
    }
  });
});
