import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { requireProjectDevRepository, requireRecordedDevRepoPath } from '../src/dev-repo-service.js';
import { integrateTaskResult } from '../src/integration-service.js';
import { runDevFullSuite } from '../src/promotion-evidence-service.js';
import { planReclamation } from '../src/reclaim-service.js';
import { captureResultCommit, prepareResultCommit } from '../src/result-commit-service.js';
import { inspectTaskDependencies } from '../src/scheduler.js';
import { runTaskVerification, VerificationRunner } from '../src/verification-service.js';
import { prepareTaskWorkspace } from '../src/workspace-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  git,
  type AgentFixture,
} from './support/agent-fixture.js';

/**
 * FOUNDATION-087 / ADR-0056: the de facto single source of every dev fact is the project's **dev
 * clone** (`projects.dev_repo_path`), and a project without one is refused with `DEV_REPO_REQUIRED`
 * instead of falling back to some other clone's local `dev` ref.
 *
 * These cases pin the refusal (and that it happens before any write), the retirement evidence that
 * `project inspect` reports, and the one thing the change is for: a candidate that only exists in the
 * dev clone can be integrated, verified and promoted.
 */

afterEach(() => { cleanupTemporaryDirectories(); });

/** A fixture whose project records *no* dev clone: the state a project trusted before ADR-0056 is in. */
function withoutDevRepo(value: AgentFixture): void {
  value.storage.trustProject({
    id: value.projectId,
    trustId: crypto.randomUUID(),
    name: 'Temporary',
    repoRoot: value.repo,
    gitCommonDir: value.storage.getTrustedProject(value.projectId).gitCommonDir,
    mainRef: 'refs/heads/main',
    devRef: 'refs/heads/dev',
    devRepoPath: null,
    recordDevRepoPath: true,
    objectFormat: 'sha1',
    policyVersion: 1,
    verificationPolicyConfirmationId: crypto.randomUUID(),
    verificationPolicy: { state: value.verificationPolicy.state,
      digest: value.verificationPolicy.digest, mainRef: 'refs/heads/main',
      mainCommit: value.mainCommit },
    trustedAt: Date.now(),
    actor: 'local-user',
  });
  expect(value.storage.getTrustedProject(value.projectId).devRepoPath).toBeNull();
}

interface QuiescentFixture {
  readonly value: AgentFixture;
  readonly workspacePath: string;
  readonly resultCommit: string;
}

/** A Task with a captured result commit, driven through the deterministic fake provider. */
async function capturedTask(): Promise<QuiescentFixture> {
  const value = await createAgentFixture();
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
  return { value, workspacePath: run.workspacePath, resultCommit: captured.resultCommit };
}

describe('Task baselines and dev facts are two different things (ADR-0056 / ADR-0060)', () => {
  test('resolves the dev repository only from the recorded dev clone', async () => {
    const value = await createAgentFixture();
    try {
      withoutDevRepo(value);
      // The code is what a script branches on; the message names the one command that fixes it.
      expect(() => requireRecordedDevRepoPath(value.storage.getTrustedProject(value.projectId)))
        .toThrow(/DEV_REPO_REQUIRED|never falls back/);
      expect(() => requireRecordedDevRepoPath(value.storage.getTrustedProject(value.projectId)))
        .toThrow(/never falls back to the stable checkout's own `dev` ref/);
      await expect(requireProjectDevRepository(
        value.storage.getTrustedProject(value.projectId)))
        .rejects.toMatchObject({ code: 'DEV_REPO_REQUIRED' });
      // The refusal names the one command that fixes it.
      await expect(requireProjectDevRepository(value.storage.getTrustedProject(value.projectId)))
        .rejects.toThrow(/project trust .* --dev-repo <dev-clone>/);
      value.storage.close();
    } finally {
      value.storage.close();
    }
  });

  test('prepares a managed workspace from the project folder and records that base ref (ADR-0060)',
    async () => {
      const value = await createAgentFixture();
      withoutDevRepo(value);
      // The project folder is on `main` here; that branch — not `dev`, not `mainRef` read elsewhere —
      // is what a managed Task is based on, and both the ref and the commit are recorded with the
      // workspace so a later checkout cannot move them.
      const workspace = await prepareTaskWorkspace({
        storage: value.storage, runtimeHome: value.home, commandId: crypto.randomUUID(),
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
      });
      expect(workspace.repoRoot).toBe(value.repo);
      expect(workspace.devRef).toBe('refs/heads/main');
      expect(workspace.baseCommit).toBe(value.mainCommit);
      expect(await git(workspace.path, ['rev-parse', 'HEAD'])).toBe(workspace.baseCommit);
      expect(value.storage.getLatestTaskWorkspace(value.taskId)?.baseCommit)
        .toBe(workspace.baseCommit);
      // Switching the folder's branch afterwards does not move the already prepared workspace.
      await git(value.repo, ['checkout', '-q', 'dev']);
      expect(await git(workspace.path, ['rev-parse', 'HEAD'])).toBe(workspace.baseCommit);
      value.storage.close();
    });

  test('refuses a managed workspace when the project folder has a detached HEAD (ADR-0060)',
    async () => {
      const value = await createAgentFixture();
      withoutDevRepo(value);
      // A detached HEAD names no branch, so there is no baseline ref to record: the refusal is a
      // fact about the requested baseline, and it still happens before any write.
      await git(value.repo, ['checkout', '-q', '--detach', 'HEAD']);
      await expect(prepareTaskWorkspace({
        storage: value.storage, runtimeHome: value.home, commandId: crypto.randomUUID(),
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
      })).rejects.toMatchObject({ code: 'TASK_BASE_REF_UNRESOLVED' });
      expect(value.storage.listIncompleteWorkspacePreparations()).toEqual([]);
      expect(value.storage.getLatestTaskWorkspace(value.taskId)).toBeNull();
      // The project stays trusted: a detached HEAD is not an identity change.
      expect(value.storage.getTrustedProject(value.projectId).repoRoot).toBe(value.repo);
      value.storage.close();
    });

  test('refuses the dependency projection, a reclamation plan and a full-suite run', async () => {
    const value = await createAgentFixture();
    withoutDevRepo(value);
    await expect(inspectTaskDependencies({
      storage: value.storage, projectId: value.projectId, taskId: value.taskId,
    })).rejects.toMatchObject({ code: 'DEV_REPO_REQUIRED' });
    await expect(planReclamation({
      storage: value.storage, runtimeHome: value.home, projectId: value.projectId,
    })).rejects.toMatchObject({ code: 'DEV_REPO_REQUIRED' });
    await expect(runDevFullSuite({
      storage: value.storage, runner: new VerificationRunner(),
      copiesRoot: join(value.home, 'verifications'), projectId: value.projectId,
      expectedDevCommit: value.mainCommit, commandId: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: 'DEV_REPO_REQUIRED' });
    // Nothing was written by any of them.
    expect(value.storage.listDevFullSuiteEvidence(value.projectId)).toEqual([]);
    value.storage.close();
  });
});

describe('dev facts come from the dev clone (ADR-0056)', () => {
  test('a Task is verified from the dev clone, where its candidate commit exists', async () => {
    const { value, resultCommit } = await capturedTask();
    // The candidate commit is an object of the dev clone only: the stable checkout never saw it,
    // which is exactly the state the old root could not verify.
    await expect(git(value.repo, ['cat-file', '-e', resultCommit])).rejects.toThrow();
    const verification = await runTaskVerification({
      storage: value.storage, runner: new VerificationRunner(),
      copiesRoot: join(value.home, 'verifications'),
      projectId: value.projectId, taskId: value.taskId,
      commandId: crypto.randomUUID(), permissionMode: 'FULL',
    });
    expect(verification.state).toBe('PASSED');
    expect(verification.testedCommit).toBe(resultCommit);
    value.storage.close();
  });

  test('integration advances the dev clone ref *and* its checkout, and the suite binds both clones',
    async () => {
      const { value, resultCommit } = await capturedTask();
      const verified = await runTaskVerification({
        storage: value.storage, runner: new VerificationRunner(),
        copiesRoot: join(value.home, 'verifications'),
        projectId: value.projectId, taskId: value.taskId,
        commandId: crypto.randomUUID(), permissionMode: 'FULL',
      });
      expect(verified.state).toBe('PASSED');
      const integrated = await integrateTaskResult({
        storage: value.storage, runner: new VerificationRunner(),
        copiesRoot: join(value.home, 'verifications'),
        worktreesRoot: join(value.home, 'integrations'),
        projectId: value.projectId, taskId: value.taskId,
        expectedVersion: value.storage.getTask(value.projectId, value.taskId)?.version as number,
        commandId: crypto.randomUUID(), permissionMode: 'FULL',
      });
      expect(integrated.state).toBe('INTEGRATED');
      expect(integrated.integratedCommit).toBe(resultCommit);
      // The dev clone's ref, HEAD and working tree all moved together (ADR-0056 rule 1: the three-way
      // equality is not evidence on its own, so the status and the file on disk are asserted too).
      expect(await git(value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(resultCommit);
      expect(await git(value.devRepo, ['rev-parse', 'HEAD'])).toBe(resultCommit);
      expect(await git(value.devRepo, ['status', '--porcelain'])).toBe('');
      expect(await Bun.file(join(value.devRepo, 'agent-output.txt')).text()).toBe('work\n');
      // The stable checkout is untouched: it never held the candidate.
      expect(await git(value.repo, ['rev-parse', 'refs/heads/main'])).toBe(value.mainCommit);

      // The full suite reads its candidate objects and lockfile from the dev clone and its fixed
      // policy from the main ref (ADR-0039 + ADR-0056), and binds both.
      const suite = await runDevFullSuite({
        storage: value.storage, runner: new VerificationRunner(),
        copiesRoot: join(value.home, 'verifications'), projectId: value.projectId,
        expectedDevCommit: resultCommit, commandId: crypto.randomUUID(),
      });
      expect(suite.state).toBe('PASSED');
      expect(suite.lockfilePath).toBe('bun.lock');
      expect(suite.lockfilePresent).toBe(true);
      value.storage.close();
    });

  test('refuses a dirty dev clone checkout before merging anything, leaving no batch behind',
    async () => {
      const { value, workspacePath } = await capturedTask();
      expect(workspacePath.length).toBeGreaterThan(0);
      await runTaskVerification({
        storage: value.storage, runner: new VerificationRunner(),
        copiesRoot: join(value.home, 'verifications'),
        projectId: value.projectId, taskId: value.taskId,
        commandId: crypto.randomUUID(), permissionMode: 'FULL',
      });
      // An untracked file is exactly what a fast-forward would have to overwrite, so the integration
      // refuses before it composes a batch: no ref moves and no record blocks the next attempt.
      await Bun.write(join(value.devRepo, 'work-in-progress.txt'), 'not committed yet\n');
      await expect(integrateTaskResult({
        storage: value.storage, runner: new VerificationRunner(),
        copiesRoot: join(value.home, 'verifications'),
        worktreesRoot: join(value.home, 'integrations'),
        projectId: value.projectId, taskId: value.taskId,
        expectedVersion: value.storage.getTask(value.projectId, value.taskId)?.version as number,
        commandId: crypto.randomUUID(), permissionMode: 'FULL',
      })).rejects.toMatchObject({ code: 'DEV_CHECKOUT_DIRTY' });
      expect(await git(value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(value.mainCommit);
      expect(value.storage.listIntegrationBatches(value.projectId, value.taskId)).toEqual([]);
      expect(value.storage.listTasks(value.projectId)[0]?.state).toBe('EXECUTED');
      expect(existsSync(join(value.devRepo, 'work-in-progress.txt'))).toBe(true);
      value.storage.close();
    });
});
