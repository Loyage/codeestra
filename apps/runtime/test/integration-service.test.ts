import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import { AdapterRegistry } from '../src/adapter-registry.js';
import {
  cancelIntegrationBatch,
  createIntegrationBatch,
  integrateIntegrationBatch,
  integrateTaskResult,
} from '../src/integration-service.js';
import { reconcileInterruptedIntegrations } from '../src/recovery-service.js';
import { captureResultCommit, prepareResultCommit } from '../src/result-commit-service.js';
import { VerificationRunner, runTaskVerification } from '../src/verification-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  git,
  type AgentFixture,
  type AgentFixtureOptions,
} from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

interface VerifiedFixture {
  readonly value: AgentFixture;
  readonly workspacePath: string;
  readonly resultCommit: string;
  readonly copiesRoot: string;
  readonly worktreesRoot: string;
}

/**
 * A Task with a captured result commit and a PASSED Task verification: the only state from which
 * integration is allowed. The fixture repository has `main` and `dev` at the same commit, so the
 * first integration is a fast-forward unless the test moves `dev` first.
 */
async function verifiedTask(options: AgentFixtureOptions = {}): Promise<VerifiedFixture> {
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
  const verification = await runTaskVerification({
    storage: value.storage, runner: new VerificationRunner(),
    copiesRoot: join(value.home, 'verifications'),
    projectId: value.projectId, taskId: value.taskId, commandId: crypto.randomUUID(),
  });
  expect(verification.state).toBe('PASSED');
  return {
    value,
    workspacePath: run.workspacePath,
    resultCommit: captured.resultCommit,
    copiesRoot: join(value.home, 'verifications'),
    worktreesRoot: join(value.home, 'integrations'),
  };
}

/** Reads the `dev` ref of a fixture repository; the same check the Runtime performs on restart. */
async function readDev(batch: {
  readonly devRef: string;
  readonly repositoryRoot: string;
}): Promise<string | null> {
  const output = await git(batch.repositoryRoot, ['rev-parse', '--verify', '--quiet', batch.devRef]);
  return output.length === 0 ? null : output;
}

/** The current Task version, which every state-changing command must match. */
function taskVersion(fixture: VerifiedFixture): number {
  const task = fixture.value.storage.getTask(fixture.value.projectId, fixture.value.taskId);
  if (task === null) throw new Error('fixture Task disappeared');
  return task.version;
}

function integrate(fixture: VerifiedFixture, overrides: Readonly<Record<string, unknown>> = {}) {
  return integrateTaskResult({
    storage: fixture.value.storage,
    runner: new VerificationRunner(),
    copiesRoot: fixture.copiesRoot,
    worktreesRoot: fixture.worktreesRoot,
    projectId: fixture.value.projectId,
    taskId: fixture.value.taskId,
    expectedVersion: taskVersion(fixture),
    commandId: crypto.randomUUID(),
    // The Runtime passes its current permission mode; FULL is the default product mode, so these
    // tests exercise the zero-confirmation path unless a test asks for STRICT.
    permissionMode: 'FULL',
    ...overrides,
  });
}

/** Rewrites the committed verification policy on `main`, which is what integration re-reads. */
async function rewritePolicy(fixture: VerifiedFixture, commands: readonly unknown[]) {
  const path = join(fixture.value.repo, '.codeestra', 'policies', 'verification.json');
  await Bun.write(path, `${JSON.stringify({ version: 1, commands }, null, 2)}\n`);
  await git(fixture.value.repo, ['add', '.codeestra/policies/verification.json']);
  await git(fixture.value.repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-q', '-m', 'policy change']);
}

/** Commits to `dev` through a temporary worktree, so the next integration cannot fast-forward. */
async function advanceDev(fixture: VerifiedFixture, content: string, file = 'dev-only.txt') {
  // ADR-0056: `dev` is checked out in the project's dev clone (and only there), so the user's own
  // commit to the long-lived branch happens in that clone.
  const devRepo = fixture.value.devRepo;
  await Bun.write(join(devRepo, file), content);
  await git(devRepo, ['add', file]);
  await git(devRepo, ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.invalid',
    'commit', '-q', '-m', 'dev moves on']);
  return await git(devRepo, ['rev-parse', 'HEAD']);
}

describe('task result integration into dev', () => {
  test('fast-forwards dev to the verified result commit and only then reaches SUCCEEDED', async () => {
    const fixture = await verifiedTask();
    try {
      const report = await integrate(fixture);
      expect(report).toMatchObject({
        state: 'INTEGRATED',
        mergeStrategy: 'FAST_FORWARD',
        integratedCommit: fixture.resultCommit,
        devRef: 'refs/heads/dev',
        outcomeCode: null,
        alreadyCompleted: false,
        created: true,
      });
      expect(report.verificationState).toBe('PASSED');
      // The ref moved, `main` did not, and the Task reached its integration-driven terminal state.
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(fixture.resultCommit);
      expect(await git(fixture.value.repo, ['rev-parse', 'refs/heads/main'])).toBe(fixture.value.mainCommit);
      expect(await git(fixture.value.repo, ['status', '--porcelain'])).toBe('');
      expect(fixture.value.storage.listTasks(fixture.value.projectId)[0]?.state).toBe('SUCCEEDED');

      // The independent integration verification is its own record, bound to the merged commit and
      // the fixed dev baseline, and separate from the Task verification.
      const batches = fixture.value.storage.listIntegrationBatches(
        fixture.value.projectId, fixture.value.taskId);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toMatchObject({ state: 'INTEGRATED', devCommit: fixture.value.mainCommit });
      const verification = fixture.value.storage.listIncompleteIntegrationVerifications();
      expect(verification).toHaveLength(0);

      // The integration worktree is removed after a successful integration, so nothing of the
      // Runtime's own checkout is left behind.
      expect(report.worktreePath).not.toBeNull();
      expect(existsSync(report.worktreePath as string)).toBe(false);
      expect(await git(fixture.value.devRepo, ['worktree', 'list', '--porcelain']))
        .not.toContain(report.worktreePath as string);

      // The Task worktree still holds the Agent's uncommitted edits: integration commits a
      // captured result commit, it does not clean up the worktree.
      expect(await Bun.file(join(fixture.workspacePath, 'agent-output.txt')).text()).toBe('work\n');
    } finally {
      fixture.value.storage.close();
    }
  });

  test('creates a merge commit when dev moved after the Task baseline', async () => {
    const fixture = await verifiedTask();
    try {
      const devBefore = await advanceDev(fixture, 'dev change\n');
      const report = await integrate(fixture);
      expect(report).toMatchObject({ state: 'INTEGRATED', mergeStrategy: 'MERGE_COMMIT' });
      const integrated = await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev']);
      expect(integrated).toBe(report.integratedCommit as string);
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev^1'])).toBe(devBefore);
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev^2'])).toBe(fixture.resultCommit);
      expect(fixture.value.storage.listTasks(fixture.value.projectId)[0]?.state).toBe('SUCCEEDED');
    } finally {
      fixture.value.storage.close();
    }
  });

  test('records a refusing commit-msg hook as a failure, not as a merge conflict', async () => {
    const fixture = await verifiedTask();
    try {
      // `dev` moved, so the integration needs a merge commit; the hook refuses to create it while
      // leaving the merge in progress. That is a Git failure, not a content conflict.
      const devBefore = await advanceDev(fixture, 'dev change\n');
      // Hooks are read from the repository the commit is written in: the dev clone (ADR-0056).
      const hooks = join(fixture.value.devRepo, '.git', 'hooks');
      await Bun.write(join(hooks, 'commit-msg'), '#!/bin/sh\necho "policy: refusing the message" >&2\nexit 1\n');
      await chmod(join(hooks, 'commit-msg'), 0o755);
      const report = await integrate(fixture);
      expect(report).toMatchObject({ state: 'FAILED', outcomeCode: 'MERGE_FAILED',
        integratedCommit: null, mergeStrategy: 'MERGE_COMMIT' });
      expect(report.detail).toContain('still in progress');
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(devBefore);
      expect(fixture.value.storage.listTasks(fixture.value.projectId)[0]?.state).toBe('EXECUTED');
      // The scene is kept: the batch is terminal, so a later attempt is not blocked by it.
      expect(fixture.value.storage.listIntegrationBatches(fixture.value.projectId,
        fixture.value.taskId)[0]?.state).toBe('FAILED');
      expect(await git(report.worktreePath as string, ['rev-parse', '--verify', 'MERGE_HEAD']))
        .toBe(fixture.resultCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('fast-forwards without requiring a commit identity it does not need', async () => {
    const fixture = await verifiedTask();
    try {
      await git(fixture.value.repo, ['config', '--unset', 'user.name']);
      await git(fixture.value.repo, ['config', '--unset', 'user.email']);
      const report = await integrate(fixture);
      expect(report).toMatchObject({ state: 'INTEGRATED', mergeStrategy: 'FAST_FORWARD' });
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(fixture.resultCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses to integrate without a PASSED Task verification of the same commit', async () => {
    const fixture = await verifiedTask();
    try {
      // A second revision's verification does not count for the current candidate: the recorded
      // run is edited only to simulate the evidence no longer matching, never to fake a pass.
      fixture.value.storage.sqlite.query(
        "UPDATE verification_runs SET tested_commit=?1 WHERE task_id=?2",
      ).run('0'.repeat(40), fixture.value.taskId);
      await expect(integrate(fixture)).rejects.toMatchObject({
        code: 'TASK_VERIFICATION_NOT_PASSED',
      });
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(fixture.value.mainCommit);
      expect(fixture.value.storage.listTasks(fixture.value.projectId)[0]?.state).toBe('EXECUTED');
      expect(fixture.value.storage.listIntegrationBatches(
        fixture.value.projectId, fixture.value.taskId)).toHaveLength(0);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses to advance dev unless the dev clone checkout is on dev, clean and at the baseline',
    async () => {
      // ADR-0056 amends ADR-0018: the one checkout allowed to hold `dev` is the dev clone's own,
      // and only while it can be fast-forwarded with the ref. Every other state is refused before
      // anything is merged, so `dev` and the Tasks keep their values.
      const dirty = await verifiedTask();
      try {
        await Bun.write(join(dirty.value.devRepo, 'uncommitted.txt'), 'work in progress\n');
        await expect(integrate(dirty)).rejects.toMatchObject({ code: 'DEV_CHECKOUT_DIRTY' });
        expect(await git(dirty.value.devRepo, ['rev-parse', 'refs/heads/dev']))
          .toBe(dirty.value.mainCommit);
        expect(dirty.value.storage.listTasks(dirty.value.projectId)[0]?.state).toBe('EXECUTED');
        expect(dirty.value.storage.listIntegrationBatches(
          dirty.value.projectId, dirty.value.taskId)).toHaveLength(0);
      } finally {
        dirty.value.storage.close();
      }

      const elsewhere = await verifiedTask();
      try {
        await git(elsewhere.value.devRepo, ['checkout', '-q', 'main']);
        // The dev clone is verified as sitting on `dev` before any dev fact is read, so a clone whose
        // checkout moved elsewhere is refused by that verification (ADR-0052); `DEV_CHECKOUT_NOT_ON_DEV`
        // remains the same check repeated immediately before the ref moves, inside the race window.
        await expect(integrate(elsewhere)).rejects
          .toMatchObject({ code: 'DEV_REPO_BRANCH_MISMATCH' });
        expect(await git(elsewhere.value.devRepo, ['rev-parse', 'refs/heads/dev']))
          .toBe(elsewhere.value.mainCommit);
        expect(elsewhere.value.storage.listTasks(elsewhere.value.projectId)[0]?.state)
          .toBe('EXECUTED');
      } finally {
        elsewhere.value.storage.close();
      }
    });

  test('keeps dev unchanged and retains the worktree when the merge conflicts', async () => {
    const fixture = await verifiedTask();
    try {
      // The Agent created agent-output.txt; dev changes the same path, so the merge conflicts.
      const devBefore = await advanceDev(fixture, 'dev version\n', 'agent-output.txt');
      const report = await integrate(fixture);
      expect(report).toMatchObject({ state: 'CONFLICTED', outcomeCode: 'MERGE_CONFLICT',
        integratedCommit: null, alreadyCompleted: false });
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(devBefore);
      expect(await git(fixture.value.repo, ['status', '--porcelain'])).toBe('');
      expect(fixture.value.storage.listTasks(fixture.value.projectId)[0]?.state).toBe('EXECUTED');
      // The failure scene is kept: the integration worktree is still registered with the conflict.
      expect(await git(fixture.value.devRepo, ['worktree', 'list', '--porcelain']))
        .toContain(report.worktreePath as string);
      expect(await git(report.worktreePath as string, ['rev-parse', '--verify', 'MERGE_HEAD']))
        .toBe(fixture.resultCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('keeps dev unchanged when the independent integration verification fails', async () => {
    const fixture = await verifiedTask();
    try {
      // `dev-only.txt` only exists after the dev-side commit, so the policy passes for the Task
      // verification but fails on the merged commit the integration verification tests.
      await advanceDev(fixture, 'dev change\n');
      const devBefore = await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev']);
      await rewritePolicy(fixture, [{ id: 'smoke', argv: ['sh', '-c', 'test ! -f dev-only.txt'],
        cwd: '.', timeoutSeconds: 60 }]);
      const report = await integrate(fixture);
      expect(report).toMatchObject({ state: 'FAILED', outcomeCode: 'INTEGRATION_VERIFICATION_FAILED',
        integratedCommit: null });
      expect(report.verificationState).toBe('FAILED');
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(devBefore);
      expect(fixture.value.storage.listTasks(fixture.value.projectId)[0]?.state).toBe('EXECUTED');
      // The failed merged commit stays inspectable in the retained integration worktree.
      expect(existsSync(report.worktreePath as string)).toBe(true);
      const retained = report.worktreePath as string;
      expect(await git(retained, ['rev-parse', 'HEAD^1'])).toBe(devBefore);
      expect(await git(retained, ['rev-parse', 'HEAD^2'])).toBe(fixture.resultCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses to overwrite a dev ref that moved while the integration was running', async () => {
    // The policy command moves `dev` behind the Runtime's back, which is exactly the race the
    // compare-and-swap exists for. The integration must not claim success afterwards.
    const fixture = await verifiedTask();
    // ADR-0056: `dev` is the dev clone's ref, so that is the ref the command moves behind the
    // Runtime's back.
    const repo = fixture.value.devRepo;
    const marker = fixture.resultCommit;
    await rewritePolicy(fixture, [{ id: 'move-dev',
      argv: ['sh', '-c', `git -C ${repo} update-ref refs/heads/dev ${marker}`],
      cwd: '.', timeoutSeconds: 60 }]);
    try {
      const report = await integrate(fixture);
      // The batch's fixed baseline stopped being the current `dev` while the integration ran, so the
      // recorded verdict is STALE (ADR-0053), not FAILED: `dev` is untouched by this batch and the
      // batch has to be composed again from the current baseline.
      expect(report).toMatchObject({ state: 'STALE', outcomeCode: 'DEV_REF_MOVED',
        integratedCommit: null });
      expect(await git(repo, ['rev-parse', 'refs/heads/dev'])).toBe(marker);
      expect(fixture.value.storage.listTasks(fixture.value.projectId)[0]?.state).toBe('EXECUTED');
    } finally {
      fixture.value.storage.close();
    }
  });

  test('replays one command ID instead of integrating the same result twice', async () => {
    const fixture = await verifiedTask();
    try {
      const commandId = crypto.randomUUID();
      const first = await integrate(fixture, { commandId });
      expect(first.created).toBe(true);
      const replay = await integrate(fixture, { commandId });
      expect(replay).toMatchObject({ state: 'INTEGRATED', alreadyCompleted: true, created: false });
      expect(replay.integratedCommit).toBe(first.integratedCommit);
      expect(fixture.value.storage.listIntegrationBatches(
        fixture.value.projectId, fixture.value.taskId)).toHaveLength(1);
      // A second call with a *new* command ID is refused by the Task state instead of creating a
      // second batch: an integrated Task is no longer EXECUTED.
      const after = await integrate(fixture);
      expect(after).toMatchObject({ state: 'INTEGRATED', alreadyCompleted: true });
      expect(fixture.value.storage.listIntegrationBatches(
        fixture.value.projectId, fixture.value.taskId)).toHaveLength(1);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('integrates in STRICT mode while the confirmed verification policy still matches', async () => {
    const fixture = await verifiedTask();
    try {
      const report = await integrate(fixture, { permissionMode: 'STRICT' });
      expect(report).toMatchObject({ state: 'INTEGRATED', mergeStrategy: 'FAST_FORWARD' });
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(fixture.resultCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('requires the confirmed verification policy in STRICT mode', async () => {
    const fixture = await verifiedTask();
    try {
      fixture.value.storage.sqlite.query(
        "UPDATE project_verification_policy_confirmations SET status='SUPERSEDED',superseded_at=1",
      ).run();
      await expect(integrate(fixture, { permissionMode: 'STRICT' })).rejects.toMatchObject({
        code: 'VERIFICATION_POLICY_NOT_CONFIRMED',
      });
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(fixture.value.mainCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('a restart before the dev ref write needs a human and blocks a new attempt', async () => {
    const fixture = await verifiedTask();
    try {
      const batchId = crypto.randomUUID();
      fixture.value.storage.beginIntegrationBatch({
        projectId: fixture.value.projectId,
        members: [{
          taskId: fixture.value.taskId,
          executionId: fixture.value.storage.listTaskExecutions(fixture.value.projectId,
            fixture.value.taskId)[0]?.executionId as string,
          expectedVersion: taskVersion(fixture),
        }],
        batchId,
        operationId: crypto.randomUUID(),
        worktreeOwnershipToken: crypto.randomUUID(),
        devRef: 'refs/heads/dev',
        devCommit: fixture.value.mainCommit,
        commandId: crypto.randomUUID(),
        payloadHash: 'in-flight',
        createdEventId: crypto.randomUUID(),
        actor: 'test',
        createdAt: 5,
      });
      const results = await reconcileInterruptedIntegrations({
        storage: fixture.value.storage, readRefCommit: readDev,
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ batchId, outcome: 'RECOVERY_REQUIRED' });
      const batch = fixture.value.storage.listIntegrationBatches(
        fixture.value.projectId, fixture.value.taskId)[0];
      expect(batch?.state).toBe('RECOVERY_REQUIRED');
      expect(batch?.detail).toContain('the dev ref was not advanced');
      // The ref is untouched and the Task is not reported as integrated.
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(fixture.value.mainCommit);
      expect(fixture.value.storage.listTasks(fixture.value.projectId)[0]?.state).toBe('EXECUTED');
      await expect(integrate(fixture)).rejects.toMatchObject({ code: 'INTEGRATION_IN_PROGRESS' });
    } finally {
      fixture.value.storage.close();
    }
  });

  test('a restart during the dev ref write completes from the ref instead of repeating it', async () => {
    const fixture = await verifiedTask();
    try {
      const integrated = await integrate(fixture);
      expect(integrated.state).toBe('INTEGRATED');
      // Fault injection: put the database back into the exact state a crash between `update-ref`
      // and the completion write leaves behind — ref already advanced, records still in flight.
      const batch = fixture.value.storage.listIntegrationBatches(
        fixture.value.projectId, fixture.value.taskId)[0];
      const batchId = batch?.batchId as string;
      expect(batch?.mergedCommit).toBe(fixture.resultCommit);
      fixture.value.storage.sqlite.query(`
        UPDATE integration_batches SET state='INTEGRATING_DEV',integrated_commit=NULL,
          completed_at=NULL,detail=NULL WHERE id=?1
      `).run(batchId);
      fixture.value.storage.sqlite.query(`
        UPDATE integration_batch_items SET state='MERGED',integrated_commit=NULL,completed_at=NULL
        WHERE batch_id=?1
      `).run(batchId);
      const recordedVersion = fixture.value.storage.sqlite.query<
        { task_version: number }, [string]>(`
        SELECT task.version AS task_version FROM integration_batch_items item
        JOIN tasks task ON task.id=item.task_id WHERE item.batch_id=?1
      `).get(batchId)?.task_version as number;
      // A crash also leaves the batch Operation unfinished, which is what reconciliation expects.
      fixture.value.storage.sqlite.query(`
        UPDATE operations SET state='IN_PROGRESS',result_json=NULL
        WHERE kind='INTEGRATE_TASK_RESULT' AND aggregate_id=?1
      `).run(batchId);
      fixture.value.storage.sqlite.query(
        "UPDATE tasks SET state='EXECUTED',version=?1 WHERE id=?2",
      ).run(recordedVersion, fixture.value.taskId);

      const results = await reconcileInterruptedIntegrations({
        storage: fixture.value.storage, readRefCommit: readDev,
      });
      expect(results).toEqual([expect.objectContaining({
        batchId, outcome: 'RECOVERED_INTEGRATED', mergedCommit: fixture.resultCommit })]);
      const recovered = fixture.value.storage.listIntegrationBatches(
        fixture.value.projectId, fixture.value.taskId)[0];
      expect(recovered).toMatchObject({ state: 'INTEGRATED', integratedCommit: fixture.resultCommit });
      expect(recovered?.detail).toContain('reconciled after a restart');
      expect(fixture.value.storage.listTasks(fixture.value.projectId)[0]?.state).toBe('SUCCEEDED');
      // The ref was read, not written a second time: it is still exactly the merged commit.
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(fixture.resultCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('a restart during the dev ref write states the ref it observed when nothing was applied', async () => {
    const fixture = await verifiedTask();
    try {
      expect((await integrate(fixture)).state).toBe('INTEGRATED');
      const batchId = fixture.value.storage.listIntegrationBatches(
        fixture.value.projectId, fixture.value.taskId)[0]?.batchId as string;
      fixture.value.storage.sqlite.query(`
        UPDATE integration_batches SET state='INTEGRATING_DEV',integrated_commit=NULL,
          completed_at=NULL,detail=NULL WHERE id=?1
      `).run(batchId);
      fixture.value.storage.sqlite.query(`
        UPDATE integration_batch_items SET state='MERGED',integrated_commit=NULL,completed_at=NULL
        WHERE batch_id=?1
      `).run(batchId);
      const recordedVersion = fixture.value.storage.sqlite.query<
        { task_version: number }, [string]>(`
        SELECT task.version AS task_version FROM integration_batch_items item
        JOIN tasks task ON task.id=item.task_id WHERE item.batch_id=?1
      `).get(batchId)?.task_version as number;
      // A crash also leaves the batch Operation unfinished, which is what reconciliation expects.
      fixture.value.storage.sqlite.query(`
        UPDATE operations SET state='IN_PROGRESS',result_json=NULL
        WHERE kind='INTEGRATE_TASK_RESULT' AND aggregate_id=?1
      `).run(batchId);
      fixture.value.storage.sqlite.query(
        "UPDATE tasks SET state='EXECUTED',version=?1 WHERE id=?2",
      ).run(recordedVersion, fixture.value.taskId);
      // The ref is moved away from the recorded merge, as if the write never happened.
      await git(fixture.value.devRepo, ['update-ref', 'refs/heads/dev', fixture.value.mainCommit]);

      const results = await reconcileInterruptedIntegrations({
        storage: fixture.value.storage, readRefCommit: readDev,
      });
      expect(results).toEqual([expect.objectContaining({ batchId, outcome: 'RECOVERY_REQUIRED' })]);
      const recovered = fixture.value.storage.listIntegrationBatches(
        fixture.value.projectId, fixture.value.taskId)[0];
      expect(recovered?.state).toBe('RECOVERY_REQUIRED');
      expect(recovered?.outcomeCode).toBe('DEV_REF_OBSERVED');
      expect(recovered?.detail).toContain(fixture.value.mainCommit);
      expect(fixture.value.storage.listTasks(fixture.value.projectId)[0]?.state).toBe('EXECUTED');
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(fixture.value.mainCommit);
    } finally {
      fixture.value.storage.close();
    }
  });
});

/**
 * A second Task in the same fixture, driven to a captured result commit and a PASSED verification:
 * the state a batch member has to be in. `file`/`content` let a test choose whether two members
 * touch the same path (a conflict) or different ones (a clean multi-member merge).
 */
async function addVerifiedTask(value: AgentFixture, input: {
  readonly file: string;
  readonly content: string;
}): Promise<{ readonly taskId: string; readonly resultCommit: string }> {
  const taskId = crypto.randomUUID();
  value.storage.createTask({
    projectId: value.projectId,
    commandId: crypto.randomUUID(),
    payloadHash: 'create-member',
    intentId: crypto.randomUUID(),
    taskId,
    revisionId: crypto.randomUUID(),
    intentEventId: crypto.randomUUID(),
    taskEventId: crypto.randomUUID(),
    specification: 'A second member of the integration batch',
    displayTitle: 'fixture task',
    namingTitle: null,
    actor: 'local-user',
    createdAt: 100,
  });
  value.storage.submitTask({
    projectId: value.projectId,
    taskId,
    expectedVersion: 0,
    commandId: crypto.randomUUID(),
    payloadHash: 'submit-member',
    eventId: crypto.randomUUID(),
    actor: 'local-user',
    submittedAt: 101,
  });
  const adapter = new DeterministicFakeAdapter('SUCCEED', [{
    type: 'completed', eventId: `fake-completed-${taskId}`, cursor: 'cursor-member',
    outcome: 'SUCCESS', evidenceRef: 'fake-quiescence',
  }]);
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const coordinator = new AgentRuntimeCoordinator({
    storage: value.storage, registry, runtimeHome: value.home,
  });
  const run = await coordinator.runTask({
    projectId: value.projectId, taskId, expectedTaskVersion: 1,
    commandId: crypto.randomUUID(), adapterId: adapter.id,
  });
  await coordinator.settle();
  await Bun.write(join(run.workspacePath, input.file), input.content);
  const prepared = await prepareResultCommit({
    storage: value.storage, projectId: value.projectId, taskId,
    commandId: crypto.randomUUID(), actor: 'local-user',
  });
  const captured = await captureResultCommit({
    storage: value.storage, projectId: value.projectId, taskId,
    authorizationId: prepared.authorizationId, commandId: crypto.randomUUID(),
  });
  const verification = await runTaskVerification({
    storage: value.storage, runner: new VerificationRunner(),
    copiesRoot: join(value.home, 'verifications'),
    projectId: value.projectId, taskId, commandId: crypto.randomUUID(),
  });
  expect(verification.state).toBe('PASSED');
  return { taskId, resultCommit: captured.resultCommit };
}

function taskVersionOf(fixture: VerifiedFixture, taskId: string): number {
  const task = fixture.value.storage.getTask(fixture.value.projectId, taskId);
  if (task === null) throw new Error('fixture Task disappeared');
  return task.version;
}

function createBatch(
  fixture: VerifiedFixture,
  members: readonly { readonly taskId: string; readonly expectedVersion: number }[],
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return createIntegrationBatch({
    storage: fixture.value.storage,
    projectId: fixture.value.projectId,
    members,
    commandId: crypto.randomUUID(),
    permissionMode: 'FULL',
    ...overrides,
  });
}

function integrateBatch(
  fixture: VerifiedFixture,
  batchId: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return integrateIntegrationBatch({
    storage: fixture.value.storage,
    runner: new VerificationRunner(),
    copiesRoot: fixture.copiesRoot,
    worktreesRoot: fixture.worktreesRoot,
    projectId: fixture.value.projectId,
    batchId,
    commandId: crypto.randomUUID(),
    permissionMode: 'FULL',
    ...overrides,
  });
}

describe('multi-member IntegrationBatch (ADR-0053)', () => {
  test('integrates two members with one verification and advances dev only when it passes', async () => {
    const fixture = await verifiedTask();
    try {
      const second = await addVerifiedTask(fixture.value, {
        file: 'second-member.txt', content: 'second member\n',
      });
      const first = { taskId: fixture.value.taskId,
        expectedVersion: taskVersionOf(fixture, fixture.value.taskId) };
      const created = await createBatch(fixture, [first,
        { taskId: second.taskId, expectedVersion: taskVersionOf(fixture, second.taskId) }]);
      expect(created).toMatchObject({ state: 'CREATED', created: true, devCommit: fixture.value.mainCommit });
      expect(created.members).toHaveLength(2);
      // A composed batch writes no Git side effect: `dev` is still the baseline it fixed.
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(fixture.value.mainCommit);

      const report = await integrateBatch(fixture, created.batchId);
      expect(report).toMatchObject({ state: 'INTEGRATED', mergeStrategy: 'MERGE_COMMIT',
        verificationState: 'PASSED' });
      expect(report.members).toHaveLength(2);
      expect(report.members.every((member) => member.state === 'INTEGRATED')).toBe(true);
      const integratedCommit = report.integratedCommit as string;
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(integratedCommit);
      // Both members' work is in the integrated tree, and both Tasks only reached SUCCEEDED here.
      // The integrated commit is an object of the dev clone (ADR-0056).
      expect(await git(fixture.value.devRepo, ['ls-tree', '--name-only', integratedCommit]))
        .toContain('agent-output.txt');
      expect(await git(fixture.value.devRepo, ['ls-tree', '--name-only', integratedCommit]))
        .toContain('second-member.txt');
      expect(fixture.value.storage.listTasks(fixture.value.projectId)
        .every((task) => task.state === 'SUCCEEDED')).toBe(true);

      // One independent integration verification covers the whole batch, and its evidence names
      // every member it was judged on.
      const evidence = fixture.value.storage.sqlite.query<{ members_json: string | null;
        batch_id: string }, [string]>(
        "SELECT json_extract(evidence_json,'$.members') AS members_json,batch_id"
        + ' FROM integration_verification_runs WHERE batch_id=?1').get(created.batchId);
      expect(evidence).not.toBeNull();
      expect(JSON.parse(evidence?.members_json as string)).toHaveLength(2);

      // Replaying the same command ID reports the recorded batch and does not advance dev twice.
      const replay = await integrateBatch(fixture, created.batchId, { commandId: report.batchId });
      expect(replay).toMatchObject({ state: 'INTEGRATED', alreadyCompleted: true });
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(integratedCommit);
      expect(fixture.value.storage.listIntegrationBatches(fixture.value.projectId)).toHaveLength(1);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('marks the batch STALE when a member revision moved after it was composed', async () => {
    const fixture = await verifiedTask();
    try {
      const second = await addVerifiedTask(fixture.value, {
        file: 'second-member.txt', content: 'second member\n',
      });
      const created = await createBatch(fixture, [
        { taskId: fixture.value.taskId,
          expectedVersion: taskVersionOf(fixture, fixture.value.taskId) },
        { taskId: second.taskId, expectedVersion: taskVersionOf(fixture, second.taskId) },
      ]);
      // A real revision is appended to one member through the domain command, so the batch's fixed
      // revision is no longer the Task's current one.
      fixture.value.storage.createTaskRevision({
        projectId: fixture.value.projectId,
        taskId: second.taskId,
        expectedVersion: taskVersionOf(fixture, second.taskId),
        commandId: crypto.randomUUID(),
        payloadHash: 'revise-member',
        intentId: crypto.randomUUID(),
        revisionId: crypto.randomUUID(),
        deliveryId: crypto.randomUUID(),
        intentEventId: crypto.randomUUID(),
        revisionEventId: crypto.randomUUID(),
        deliveryEventId: crypto.randomUUID(),
        specification: 'The member moved after the batch was composed',
        reason: 'test',
        actor: 'local-user',
        createdAt: 200,
      });

      const report = await integrateBatch(fixture, created.batchId);
      expect(report).toMatchObject({ state: 'STALE', outcomeCode: 'MEMBER_EVIDENCE_MOVED',
        integratedCommit: null });
      expect(report.detail).toContain(second.taskId);
      // Nothing was merged and `dev` kept its value; the members stay readable as they were.
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(fixture.value.mainCommit);
      expect(report.members.map((member) => member.state)).toEqual(['PREPARED', 'PREPARED']);
      expect(fixture.value.storage.listTasks(fixture.value.projectId)
        .some((task) => task.state === 'SUCCEEDED')).toBe(false);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('marks the batch STALE when dev moved before the integration started', async () => {
    const fixture = await verifiedTask();
    try {
      const second = await addVerifiedTask(fixture.value, {
        file: 'second-member.txt', content: 'second member\n',
      });
      const created = await createBatch(fixture, [
        { taskId: fixture.value.taskId,
          expectedVersion: taskVersionOf(fixture, fixture.value.taskId) },
        { taskId: second.taskId, expectedVersion: taskVersionOf(fixture, second.taskId) },
      ]);
      const devBefore = await advanceDev(fixture, 'dev moved on\n');

      const report = await integrateBatch(fixture, created.batchId);
      expect(report).toMatchObject({ state: 'STALE', outcomeCode: 'DEV_REF_MOVED',
        integratedCommit: null });
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(devBefore);
      // The stale batch does not block composing a new one: it is terminal, not in flight.
      const fresh = await createBatch(fixture, [
        { taskId: fixture.value.taskId,
          expectedVersion: taskVersionOf(fixture, fixture.value.taskId) },
        { taskId: second.taskId, expectedVersion: taskVersionOf(fixture, second.taskId) },
      ]);
      expect(fresh.state).toBe('CREATED');
      expect(fresh.devCommit).toBe(devBefore);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('keeps a partial merge readable when a later member conflicts', async () => {
    const fixture = await verifiedTask();
    try {
      // The second member changes the same path the first one created, so merging it onto the first
      // member's tree conflicts. `dev` must not move and the members must stay distinguishable.
      const second = await addVerifiedTask(fixture.value, {
        file: 'agent-output.txt', content: 'a different version\n',
      });
      const created = await createBatch(fixture, [
        { taskId: second.taskId, expectedVersion: taskVersionOf(fixture, second.taskId) },
        { taskId: fixture.value.taskId,
          expectedVersion: taskVersionOf(fixture, fixture.value.taskId) },
      ]);
      const report = await integrateBatch(fixture, created.batchId);
      expect(report).toMatchObject({ state: 'CONFLICTED', outcomeCode: 'MERGE_CONFLICT',
        integratedCommit: null });
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(fixture.value.mainCommit);
      // The members are merged in `task_id` order: the one that merged first is MERGED, the member
      // that conflicted is CONFLICTED, and no member is reported as integrated.
      const byState = new Map(report.members.map((member) => [member.taskId, member.state]));
      expect([...byState.values()].filter((state) => state === 'MERGED')).toHaveLength(1);
      expect([...byState.values()].filter((state) => state === 'CONFLICTED')).toHaveLength(1);
      expect(byState.get(second.taskId)).toBeDefined();
      expect(fixture.value.storage.listTasks(fixture.value.projectId)
        .every((task) => task.state === 'EXECUTED')).toBe(true);
      // The failure scene is kept: the integration worktree still carries the conflict.
      expect(existsSync(report.worktreePath as string)).toBe(true);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('cancels a composed batch, and refuses cancellation once a side effect exists', async () => {
    const fixture = await verifiedTask();
    try {
      const second = await addVerifiedTask(fixture.value, {
        file: 'second-member.txt', content: 'second member\n',
      });
      const members = [
        { taskId: fixture.value.taskId,
          expectedVersion: taskVersionOf(fixture, fixture.value.taskId) },
        { taskId: second.taskId, expectedVersion: taskVersionOf(fixture, second.taskId) },
      ];
      const created = await createBatch(fixture, members);
      const cancelled = await cancelIntegrationBatch({
        storage: fixture.value.storage, projectId: fixture.value.projectId,
        batchId: created.batchId, commandId: crypto.randomUUID(), reason: 'not needed any more',
      });
      expect(cancelled).toMatchObject({ state: 'CANCELLED', outcomeCode: 'CANCELLED_BY_USER',
        integratedCommit: null });
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(fixture.value.mainCommit);
      // A cancelled batch holds nothing, so the same members can be composed again.
      const again = await createBatch(fixture, members);
      expect(again.state).toBe('CREATED');

      // Once the batch recorded a worktree, the Runtime cannot confirm that no member side effect is
      // unsettled: the cancellation becomes a reconciliation requirement and keeps the slot.
      fixture.value.storage.startIntegrationMerge({
        batchId: again.batchId,
        worktreePath: join(fixture.worktreesRoot, 'unsettled'),
        startedAt: Date.now(),
      });
      const refused = await cancelIntegrationBatch({
        storage: fixture.value.storage, projectId: fixture.value.projectId,
        batchId: again.batchId, commandId: crypto.randomUUID(),
      });
      expect(refused).toMatchObject({ state: 'RECOVERY_REQUIRED', outcomeCode: 'RECONCILE_REQUIRED' });
      // The unresolved batch keeps its slot: it neither integrates nor lets its members be composed
      // into a new batch, and re-reading it reports the recorded verdict instead of starting work.
      const later = await integrateBatch(fixture, again.batchId);
      expect(later).toMatchObject({ state: 'RECOVERY_REQUIRED', alreadyCompleted: true });
      await expect(createBatch(fixture, members)).rejects
        .toMatchObject({ code: 'INTEGRATION_IN_PROGRESS' });
    } finally {
      fixture.value.storage.close();
    }
  });

  test('reconciles a restart during the ref write for every member without writing the ref twice', async () => {
    const fixture = await verifiedTask();
    try {
      const second = await addVerifiedTask(fixture.value, {
        file: 'second-member.txt', content: 'second member\n',
      });
      const created = await createBatch(fixture, [
        { taskId: fixture.value.taskId,
          expectedVersion: taskVersionOf(fixture, fixture.value.taskId) },
        { taskId: second.taskId, expectedVersion: taskVersionOf(fixture, second.taskId) },
      ]);
      const report = await integrateBatch(fixture, created.batchId);
      expect(report.state).toBe('INTEGRATED');
      const integratedCommit = report.integratedCommit as string;
      // Fault injection: the exact state a crash between `update-ref` and the completion write
      // leaves behind — ref already advanced, records still in flight.
      fixture.value.storage.sqlite.query(`
        UPDATE integration_batches SET state='INTEGRATING_DEV',integrated_commit=NULL,
          completed_at=NULL,detail=NULL WHERE id=?1
      `).run(created.batchId);
      fixture.value.storage.sqlite.query(`
        UPDATE integration_batch_items SET state='MERGED',integrated_commit=NULL,completed_at=NULL
        WHERE batch_id=?1
      `).run(created.batchId);
      fixture.value.storage.sqlite.query(`
        UPDATE operations SET state='IN_PROGRESS',result_json=NULL
        WHERE kind='INTEGRATE_TASK_RESULT' AND aggregate_id=?1
      `).run(created.batchId);
      fixture.value.storage.sqlite.query(
        "UPDATE tasks SET state='EXECUTED' WHERE project_id=?1",
      ).run(fixture.value.projectId);

      const results = await reconcileInterruptedIntegrations({
        storage: fixture.value.storage, readRefCommit: readDev,
      });
      expect(results).toEqual([expect.objectContaining({
        batchId: created.batchId, outcome: 'RECOVERED_INTEGRATED', mergedCommit: integratedCommit })]);
      const recovered = fixture.value.storage.listIntegrationBatches(
        fixture.value.projectId)[0];
      expect(recovered?.state).toBe('INTEGRATED');
      expect(recovered?.items.every((item) => item.state === 'INTEGRATED')).toBe(true);
      expect(fixture.value.storage.listTasks(fixture.value.projectId)
        .every((task) => task.state === 'SUCCEEDED')).toBe(true);
      // The ref was read, not written a second time.
      expect(await git(fixture.value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(integratedCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('a member already held by an unfinished batch cannot be composed or integrated again', async () => {
    const fixture = await verifiedTask();
    try {
      const created = await createBatch(fixture, [{ taskId: fixture.value.taskId,
        expectedVersion: taskVersionOf(fixture, fixture.value.taskId) }]);
      expect(created.state).toBe('CREATED');
      await expect(createBatch(fixture, [{ taskId: fixture.value.taskId,
        expectedVersion: taskVersionOf(fixture, fixture.value.taskId) }]))
        .rejects.toMatchObject({ code: 'INTEGRATION_IN_PROGRESS' });
      await expect(integrate(fixture)).rejects.toMatchObject({ code: 'INTEGRATION_IN_PROGRESS' });
    } finally {
      fixture.value.storage.close();
    }
  });
});
