import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { RuntimeDrainState } from '../src/capacity-service.js';
import { requireProjectDevRepository, requireRecordedDevRepoPath } from '../src/dev-repo-service.js';
import { integrateTaskResult } from '../src/integration-service.js';
import { runDevFullSuite } from '../src/promotion-evidence-service.js';
import { planReclamation } from '../src/reclaim-service.js';
import { captureResultCommit, prepareResultCommit } from '../src/result-commit-service.js';
import { ScheduleService } from '../src/schedule-service.js';
import { inspectTaskDependencies } from '../src/scheduler.js';
import { SlotReservationService } from '../src/slot-reservation-service.js';
import { purgeTask } from '../src/task-purge-service.js';
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

  test('uses an explicit base ref for a new workspace and refuses a fixed Task (ADR-0060)',
    async () => {
      const value = await createAgentFixture();
      withoutDevRepo(value);
      const devCommit = await git(value.repo, ['rev-parse', 'refs/heads/dev']);
      // The folder is on `main`; the override picks another local branch, and the recorded baseline is
      // the ref that was asked for — not the checked out one.
      const workspace = await prepareTaskWorkspace({
        storage: value.storage, runtimeHome: value.home, commandId: crypto.randomUUID(),
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        baseRef: 'refs/heads/dev',
      });
      expect(workspace.devRef).toBe('refs/heads/dev');
      expect(workspace.baseCommit).toBe(devCommit);
      expect(await git(workspace.path, ['rev-parse', 'HEAD'])).toBe(devCommit);

      // A Task that already has a workspace keeps its recorded baseline: the flag is refused rather
      // than ignored, because "which commit did this Task start from" must not depend on replay.
      await expect(prepareTaskWorkspace({
        storage: value.storage, runtimeHome: value.home, commandId: crypto.randomUUID(),
        projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
        baseRef: 'refs/heads/main',
      })).rejects.toMatchObject({ code: 'TASK_BASE_REF_ALREADY_FIXED' });

      // A ref that is not a local branch, and a branch that does not exist, are two different facts.
      const other = value.storage.createTask({
        projectId: value.projectId, commandId: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(), intentId: crypto.randomUUID(),
        taskId: crypto.randomUUID(), revisionId: crypto.randomUUID(),
        intentEventId: crypto.randomUUID(), taskEventId: crypto.randomUUID(),
        displayTitle: 'second', namingTitle: 'second', features: [],
        specification: 'second',
        actor: 'local-user', createdAt: Date.now(),
      });
      await expect(prepareTaskWorkspace({
        storage: value.storage, runtimeHome: value.home, commandId: crypto.randomUUID(),
        projectId: value.projectId, taskId: other.id, expectedTaskVersion: 0,
        baseRef: 'refs/tags/v1',
      })).rejects.toMatchObject({ code: 'TASK_BASE_REF_NOT_A_BRANCH' });
      await expect(prepareTaskWorkspace({
        storage: value.storage, runtimeHome: value.home, commandId: crypto.randomUUID(),
        projectId: value.projectId, taskId: other.id, expectedTaskVersion: 0,
        baseRef: 'refs/heads/nope',
      })).rejects.toMatchObject({ code: 'TASK_BASE_REF_MISSING' });
      // Neither refusal left anything behind.
      expect(value.storage.getLatestTaskWorkspace(other.id)).toBeNull();
      expect(value.storage.listIncompleteWorkspacePreparations()).toEqual([]);
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

  test('refuses dev-only operations, but reclaims a managed workspace (ADR-0060)', async () => {
    const value = await createAgentFixture();
    withoutDevRepo(value);
    // Promotion evidence needs the long-lived `dev` branch itself, so a project that never declared
    // one is refused with the code that names the missing branch — not with a new approval.
    await expect(runDevFullSuite({
      storage: value.storage, runner: new VerificationRunner(),
      copiesRoot: join(value.home, 'verifications'), projectId: value.projectId,
      expectedDevCommit: value.mainCommit, commandId: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: 'DEV_REPO_REQUIRED' });
    expect(value.storage.listDevFullSuiteEvidence(value.projectId)).toEqual([]);

    // The dependency verdict is **not** dev-only (ADR-0060): it is read against the Task baseline this
    // project actually has — the folder's checked out branch — so a managed Task is never refused for
    // a branch it was never asked to have.
    const view = await inspectTaskDependencies({
      storage: value.storage, projectId: value.projectId, taskId: value.taskId,
    });
    expect(view.devRef).toBe('refs/heads/main');
    expect(view.devCommit).toBe(value.mainCommit);
    expect(view.blocked).toBe(false);
    expect(view.blockedReasons).toEqual([]);

    // Reclamation is *not* dev-only: the worktree and the branch live in the project folder, so the
    // plan is built against that repository and measures "already merged" against the ref the
    // workspace was based on (`refs/heads/main` here, because the folder is on `main`).
    const workspace = await prepareTaskWorkspace({
      storage: value.storage, runtimeHome: value.home, commandId: crypto.randomUUID(),
      projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
    });
    const plan = await planReclamation({
      storage: value.storage, runtimeHome: value.home, projectId: value.projectId,
    });
    const target = plan.targets.find((candidate) => candidate.path === workspace.path);
    expect(target).toBeDefined();
    // The evidence is read from the **project folder**: the worktree registration was found there,
    // and "already merged" is measured against the ref this workspace was based on
    // (`refs/heads/main` here, because the folder is on `main`).
    expect(target?.evidence['registered']).toBe(true);
    expect(target?.evidence['registeredBranch']).toBe(workspace.branchRef);
    expect(target?.evidence['mergeTargetRef']).toBe('refs/heads/main');
    // This Task has not finished, so nothing is deleted yet — and that refusal is about the Task, not
    // about a missing dev clone.
    expect(target?.reasonCode).toBe('TASK_NOT_TERMINAL');
    value.storage.close();
  });
});

interface ManagedRuntime {
  readonly value: AgentFixture;
  readonly coordinator: AgentRuntimeCoordinator;
  readonly schedule: ScheduleService;
  readonly adapter: DeterministicFakeAdapter;
}

/**
 * A managed project (no dev clone) driven through the *real* scheduling gate and the real Runtime:
 * dependency verdict, conflict assessment, slot reservation, baseline re-check, workspace preparation
 * and Execution all run. The fake Adapter is the only step a test may not take for a real provider.
 */
async function managedRuntime(
  mode: 'SUCCEED' | 'FAIL_BEFORE_START' = 'SUCCEED',
): Promise<ManagedRuntime> {
  const value = await createAgentFixture();
  withoutDevRepo(value);
  const adapter = new DeterministicFakeAdapter(mode, mode === 'SUCCEED'
    ? [{ type: 'completed', eventId: 'fake-completed-1', cursor: 'cursor-1',
        outcome: 'SUCCESS', evidenceRef: 'fake-quiescence' }]
    : []);
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const bootId = 'boot-managed-1';
  const coordinator = new AgentRuntimeCoordinator({
    storage: value.storage, registry, runtimeHome: value.home, bootId,
  });
  const drain = new RuntimeDrainState();
  const slots = new SlotReservationService({
    storage: value.storage, bootId, pid: process.pid, startToken: 'linux:test:1',
    draining: () => drain.state(), now: () => Date.now(),
  });
  const schedule = new ScheduleService({
    storage: value.storage,
    adapters: { ids: () => [adapter.id] },
    slots,
    start: async (request) => {
      const run = await coordinator.runScheduledExecution({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedTaskVersion: request.expectedTaskVersion,
        revisionId: request.revisionId,
        adapterId: request.adapterId,
        reservationId: request.reservationId,
        commandId: request.commandId,
        actor: request.actor,
        ...(request.baseRef === undefined || request.baseRef === null
          ? {} : { baseRef: request.baseRef }),
      });
      return {
        executionId: run.executionId, sessionId: run.sessionId, attemptNumber: run.attemptNumber,
        taskVersion: run.taskVersion, workspaceId: run.workspaceId, workspacePath: run.workspacePath,
        baseCommit: run.baseCommit, adapterId: run.adapterId, adapterVersion: run.adapterVersion,
        sessionState: run.sessionState, permissionMode: run.permissionMode,
        agentConfig: run.agentConfig,
      };
    },
    draining: () => drain.state(),
    defaultAdapterId: adapter.id,
    now: () => Date.now(),
  });
  return { value, coordinator, schedule, adapter };
}

/** `task.run` for the fixture's Task, through the engine the command face uses. */
async function runManaged(
  managed: ManagedRuntime,
  overrides: { readonly baseRef?: string } = {},
): ReturnType<ScheduleService['runNow']> {
  const { value } = managed;
  const version = value.storage.getTask(value.projectId, value.taskId)?.version;
  return managed.schedule.runNow({
    projectId: value.projectId,
    taskId: value.taskId,
    expectedTaskVersion: version as number,
    adapterId: managed.adapter.id,
    commandId: crypto.randomUUID(),
    allowUnknown: false,
    actor: 'local-user',
    ...(overrides.baseRef === undefined ? {} : { baseRef: overrides.baseRef }),
  });
}

/** The recorded `base_ref` of one Task's workspace, as every later reader sees it. */
function recordedBaseRef(value: AgentFixture, taskId: string): string | null {
  const candidates = value.storage.getReclamationCandidates(value.projectId, { taskId });
  return candidates.workspaces[0]?.baseRef ?? null;
}

describe('a managed project runs its Tasks from its own folder (ADR-0060)', () => {
  test('starts a Task through the scheduling gate instead of refusing DEV_REPO_REQUIRED', async () => {
    const managed = await managedRuntime();
    const { value } = managed;
    const outcome = await runManaged(managed);
    expect(outcome.outcome).toBe('STARTED');
    expect(outcome.wait).toBeNull();
    // The baseline is the branch the project folder has checked out, and it is what the Task worktree
    // was really created from.
    expect(outcome.baseCommit).toBe(value.mainCommit);
    expect(recordedBaseRef(value, value.taskId)).toBe('refs/heads/main');
    const workspace = value.storage.getLatestTaskWorkspace(value.taskId);
    expect(workspace?.baseCommit).toBe(value.mainCommit);
    expect(workspace?.path.startsWith(join(value.home, 'worktrees'))).toBe(true);
    // The worktree belongs to the project folder: the Task branch is registered there and nowhere else.
    expect(await git(value.repo, ['rev-parse', `refs/heads/task/${value.taskId}`]))
      .toBe(value.mainCommit);
    await expect(git(value.devRepo, ['rev-parse', `refs/heads/task/${value.taskId}`]))
      .rejects.toThrow();
    await managed.coordinator.settle();
    value.storage.close();
  });

  test('carries an explicit --base-ref all the way to the worktree Git is based on', async () => {
    const managed = await managedRuntime();
    const { value } = managed;
    // A second branch with its own commit, so "the ref that was asked for" is distinguishable from
    // "the branch the folder happens to have checked out".
    await git(value.repo, ['checkout', '-q', '-b', 'feature']);
    await Bun.write(join(value.repo, 'feature.txt'), 'feature\n');
    await git(value.repo, ['add', 'feature.txt']);
    await git(value.repo, ['commit', '-q', '-m', 'feature work']);
    const featureCommit = await git(value.repo, ['rev-parse', 'refs/heads/feature']);
    await git(value.repo, ['checkout', '-q', 'main']);
    const outcome = await runManaged(managed, { baseRef: 'refs/heads/feature' });
    expect(outcome.outcome).toBe('STARTED');
    expect(outcome.baseCommit).toBe(featureCommit);
    expect(recordedBaseRef(value, value.taskId)).toBe('refs/heads/feature');
    const workspace = value.storage.getLatestTaskWorkspace(value.taskId);
    expect(await git(workspace?.path as string, ['rev-parse', 'HEAD'])).toBe(featureCommit);
    await managed.coordinator.settle();
    value.storage.close();
  });

  test('refuses a detached-HEAD folder before any slot or workspace is written', async () => {
    const managed = await managedRuntime();
    const { value } = managed;
    await git(value.repo, ['checkout', '-q', '--detach', 'HEAD']);
    await expect(runManaged(managed)).rejects.toMatchObject({ code: 'TASK_BASE_REF_UNRESOLVED' });
    // Nothing was reserved, prepared or started, and the trust survives: a detached HEAD is a fact
    // about the requested baseline, not an identity change.
    expect(value.storage.listSlotReservations(value.projectId, { includeReleased: true })).toEqual([]);
    expect(value.storage.getLatestTaskWorkspace(value.taskId)).toBeNull();
    expect(value.storage.getTrustedProject(value.projectId).repoRoot).toBe(value.repo);
    value.storage.close();
  });

  test('captures, verifies and purges a Task whose branch lives in the project folder', async () => {
    const managed = await managedRuntime();
    const { value, coordinator } = managed;
    const run = await coordinator.runTask({
      projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
      commandId: crypto.randomUUID(), adapterId: managed.adapter.id,
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
    // The result commit is an object of the project folder's repository — exactly where the worktree
    // and its branch live for a managed project (ADR-0060).
    expect(await git(value.repo, ['cat-file', '-e', captured.resultCommit])).toBe('');
    const verified = await runTaskVerification({
      storage: value.storage, runner: new VerificationRunner(),
      copiesRoot: join(value.home, 'verifications'),
      projectId: value.projectId, taskId: value.taskId,
      commandId: crypto.randomUUID(), permissionMode: 'FULL',
    });
    expect(verified.state).toBe('PASSED');
    expect(verified.testedCommit).toBe(captured.resultCommit);

    const purged = await purgeTask({
      storage: value.storage, runtimeHome: value.home, coordinator,
      projectId: value.projectId, taskId: value.taskId,
      expectedVersion: value.storage.getTask(value.projectId, value.taskId)?.version as number,
      commandId: crypto.randomUUID(), actor: 'local-user', reason: 'managed lifecycle test',
    });
    expect(purged.state).toBe('CANCELLED');
    expect(purged.plan).toMatchObject({ worktrees: 1, branches: 1 });
    expect(purged.branchFacts[0]?.deleted).toBe(true);
    // Both halves really happened: the worktree and the branch are gone from the project folder.
    expect(existsSync(run.workspacePath)).toBe(false);
    await expect(git(value.repo, ['rev-parse', `refs/heads/task/${value.taskId}`]))
      .rejects.toThrow();
    value.storage.close();
  }, 60_000);
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
