import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import { inspectRepository } from '@codeestra/git';
import {
  agentAnswerMigration,
  agentConfigurationMigration,
  agentDisconnectMigration,
  agentObservationMigration,
  agentStartMigration,
  integrationPipelineMigration,
  operationProgressMigration,
  Phase1Database,
  phase1Migration,
  phase1SchemaVersion,
  reclamationMigration,
  taskControlMigration,
  taskVerificationMigration,
  workspaceRetryMigration,
} from '@codeestra/storage';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import { AdapterRegistry } from '../src/adapter-registry.js';
import {
  createIntegrationBatch,
  integrateIntegrationBatch,
  integrateTaskResult,
} from '../src/integration-service.js';
import {
  abandonStablePromotion,
  approveStablePromotion,
  prepareStablePromotion,
  promoteStableBranch,
  recordPromotionRestart,
} from '../src/promotion-service.js';
import { runDevFullSuite } from '../src/promotion-evidence-service.js';
import { reconcileInterruptedPromotions } from '../src/recovery-service.js';
import { captureResultCommit, prepareResultCommit } from '../src/result-commit-service.js';
import { VerificationRunner, runTaskVerification } from '../src/verification-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  git,
  registerTemporaryDirectory,
  type AgentFixture,
} from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

/**
 * The stable promotion fixture (ADR-0047): the main checkout, a **separate** dev clone of the same
 * bare remote, and a Task whose result is integrated into `dev` with a PASSED independent
 * verification plus a PASSED dev full-suite run of that exact commit.
 *
 * The restart sequence itself is not executed here — this file exercises the Runtime's decision
 * surface with fabricated step outcomes. The steps are run for real, by the CLI, in
 * `cli-promotion.test.ts`.
 */
interface PromotionFixture {
  readonly value: AgentFixture;
  readonly candidateCommit: string;
  readonly batchId: string;
  readonly verificationId: string;
  readonly mainCommit: string;
  readonly mainWorktree: string;
  /** The dev full-suite evidence the promotion is fixed to (ADR-0038 D03). */
  readonly fullSuiteEvidenceId: string;
  /** A local bare repository; every push in these tests goes there and nowhere else. */
  readonly remote: string;
  /** The second clone a promotion pushes from. */
  readonly devClone: string;
}

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  registerTemporaryDirectory(directory);
  return directory;
}

async function promotionFixture(options: {
  readonly withoutFullSuiteEvidence?: boolean;
  readonly withoutDevClone?: boolean;
  /** Integrate a two-member IntegrationBatch instead of a single Task (ADR-0053). */
  readonly multiMember?: boolean;
} = {}): Promise<PromotionFixture> {
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
  /** Drives one Task to an EXECUTED state with a captured result commit and a PASSED verification. */
  const driveTask = async (taskId: string, file: string): Promise<void> => {
    const run = await coordinator.runTask({
      projectId: value.projectId, taskId, expectedTaskVersion: 1,
      commandId: crypto.randomUUID(), adapterId: adapter.id,
    });
    await coordinator.settle();
    await Bun.write(join(run.workspacePath, file), 'work\n');
    const prepared = await prepareResultCommit({
      storage: value.storage, projectId: value.projectId, taskId,
      commandId: crypto.randomUUID(), actor: 'local-user',
    });
    await captureResultCommit({
      storage: value.storage, projectId: value.projectId, taskId,
      authorizationId: prepared.authorizationId, commandId: crypto.randomUUID(),
    });
    const verification = await runTaskVerification({
      storage: value.storage, runner: new VerificationRunner(),
      copiesRoot: join(value.home, 'verifications'),
      projectId: value.projectId, taskId, commandId: crypto.randomUUID(),
    });
    expect(verification.state).toBe('PASSED');
  };
  await driveTask(value.taskId, 'agent-output.txt');
  const taskVersionOf = (taskId: string): number =>
    value.storage.getTask(value.projectId, taskId)?.version as number;
  let integratedCommit: string;
  let batchId: string;
  let verificationId: string | null;
  if (options.multiMember === true) {
    // ADR-0053: a batch with two members is integrated by one independent verification, and the
    // promotion below has to consume exactly that batch-level evidence.
    const secondTaskId = crypto.randomUUID();
    value.storage.createTask({
      projectId: value.projectId,
      commandId: crypto.randomUUID(),
      payloadHash: 'create-second-member',
      intentId: crypto.randomUUID(),
      taskId: secondTaskId,
      revisionId: crypto.randomUUID(),
      intentEventId: crypto.randomUUID(),
      taskEventId: crypto.randomUUID(),
      specification: 'A second member of the integration batch',
      constraints: [],
      kind: 'DEVELOPMENT',
      actor: 'local-user',
      createdAt: 50,
    });
    value.storage.submitTask({
      projectId: value.projectId,
      taskId: secondTaskId,
      expectedVersion: 0,
      commandId: crypto.randomUUID(),
      payloadHash: 'submit-second-member',
      eventId: crypto.randomUUID(),
      actor: 'local-user',
      submittedAt: 51,
    });
    await driveTask(secondTaskId, 'second-member.txt');
    const created = await createIntegrationBatch({
      storage: value.storage,
      projectId: value.projectId,
      members: [
        { taskId: value.taskId, expectedVersion: taskVersionOf(value.taskId) },
        { taskId: secondTaskId, expectedVersion: taskVersionOf(secondTaskId) },
      ],
      commandId: crypto.randomUUID(),
      permissionMode: 'FULL',
    });
    const report = await integrateIntegrationBatch({
      storage: value.storage,
      runner: new VerificationRunner(),
      copiesRoot: join(value.home, 'verifications'),
      worktreesRoot: join(value.home, 'integrations'),
      projectId: value.projectId,
      batchId: created.batchId,
      commandId: crypto.randomUUID(),
      permissionMode: 'FULL',
    });
    expect(report.state).toBe('INTEGRATED');
    integratedCommit = report.integratedCommit as string;
    batchId = created.batchId;
    verificationId = report.verificationId;
  } else {
    const integrated = await integrateTaskResult({
      storage: value.storage,
      runner: new VerificationRunner(),
      copiesRoot: join(value.home, 'verifications'),
      worktreesRoot: join(value.home, 'integrations'),
      projectId: value.projectId,
      taskId: value.taskId,
      expectedVersion: taskVersionOf(value.taskId),
      commandId: crypto.randomUUID(),
      permissionMode: 'FULL',
    });
    expect(integrated.state).toBe('INTEGRATED');
    const recorded = value.storage.listIntegrationBatches(value.projectId, value.taskId)[0];
    integratedCommit = integrated.integratedCommit as string;
    batchId = recorded?.batchId as string;
    verificationId = recorded?.verificationId ?? null;
  }
  if (verificationId === null) {
    throw new Error('the integration fixture did not record a verified batch');
  }
  const candidateCommit = integratedCommit;
  // ADR-0038 D03: the promotion gate needs the full suite to have passed on this exact dev SHA,
  // observed by the Runtime in a detached copy of that commit.
  let fullSuiteEvidenceId = '';
  if (options.withoutFullSuiteEvidence !== true) {
    const fullSuite = await runDevFullSuite({
      storage: value.storage,
      runner: new VerificationRunner(),
      copiesRoot: join(value.home, 'verifications'),
      projectId: value.projectId,
      expectedDevCommit: candidateCommit,
      commandId: crypto.randomUUID(),
    });
    expect(fullSuite.state).toBe('PASSED');
    fullSuiteEvidenceId = fullSuite.evidenceId;
  }

  // ADR-0048 D01: the main checkout and the dev clone are two independent clones of one origin.
  // The bare remote is local, so no test ever writes to a real GitHub repository.
  const remote = temporaryDirectory('codeestra-promotion-remote-');
  await git(remote, ['init', '--bare', '-b', 'main']);
  await git(value.repo, ['remote', 'add', 'origin', remote]);
  await git(value.repo, ['push', '-q', 'origin', 'refs/heads/main:refs/heads/main']);
  const devClone = temporaryDirectory('codeestra-promotion-devclone-');
  await git(devClone, ['clone', '-q', remote, '.']);
  // The candidate only exists in the main checkout; it reaches the dev clone the way the dev clone
  // would get it in reality (fetch the integrated dev branch), and never through the remote — the
  // promotion is the only thing allowed to push it.
  await git(devClone, ['fetch', '-q', value.repo, 'refs/heads/dev:refs/heads/dev']);
  await git(devClone, ['checkout', '-q', 'dev']);
  await recordDevClone(value, devClone);
  return {
    value,
    candidateCommit,
    batchId,
    verificationId,
    mainCommit: value.mainCommit,
    mainWorktree: value.repo,
    fullSuiteEvidenceId,
    remote,
    devClone,
  };
}

/** Re-trusts the project with the verified dev clone recorded (ADR-0047 D05). */
async function recordDevClone(
  value: AgentFixture,
  devClone: string | null,
): Promise<void> {
  const identity = await inspectRepository(value.repo);
  value.storage.trustProject({
    id: value.projectId,
    trustId: crypto.randomUUID(),
    name: 'Temporary',
    repoRoot: identity.repoRoot,
    gitCommonDir: identity.gitCommonDir,
    mainRef: identity.mainRef,
    devRef: 'refs/heads/dev',
    devRepoPath: devClone,
    recordDevRepoPath: true,
    objectFormat: identity.objectFormat,
    policyVersion: 1,
    verificationPolicyConfirmationId: crypto.randomUUID(),
    verificationPolicy: {
      state: value.verificationPolicy.state,
      digest: value.verificationPolicy.digest,
      mainRef: identity.mainRef,
      mainCommit: value.mainCommit,
    },
    trustedAt: Date.now(),
    actor: 'local-user',
  });
}

function prepare(fixture: PromotionFixture, overrides: Readonly<Record<string, unknown>> = {}) {
  return prepareStablePromotion({
    storage: fixture.value.storage,
    projectId: fixture.value.projectId,
    batchId: fixture.batchId,
    expectedDevCommit: fixture.candidateCommit,
    expectedMainCommit: fixture.mainCommit,
    commandId: crypto.randomUUID(),
    // FULL is the product default, so these tests exercise the zero-confirmation path unless a
    // test explicitly asks for STRICT.
    permissionMode: 'FULL',
    ...overrides,
  });
}

function promote(
  fixture: PromotionFixture,
  promotionId: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return promoteStableBranch({
    storage: fixture.value.storage,
    projectId: fixture.value.projectId,
    promotionId,
    bootId: 'boot-awaiting-pull',
    permissionMode: 'FULL',
    ...overrides,
  });
}

/** A successful restart record: a different boot, READY, and every recorded step exiting 0. */
function restartRecord(
  fixture: PromotionFixture,
  promotionId: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return recordPromotionRestart({
    storage: fixture.value.storage,
    projectId: fixture.value.projectId,
    promotionId,
    bootId: 'boot-after-restart',
    observedBootId: 'boot-after-restart',
    runtimeStatus: 'READY',
    uiRunning: false,
    steps: [],
    ...overrides,
  });
}

/** The steps the client would report after running the recorded plan; `exitCode` overrides one. */
function stepsWith(
  plan: { readonly restartSteps: readonly { readonly id: string;
    readonly argv: readonly string[]; readonly cwd: string }[] },
  overrides: Readonly<Record<string, number | null>> = {},
) {
  const haltedAt = Object.keys(overrides).find((id) => overrides[id] !== 0);
  const haltedIndex = plan.restartSteps.findIndex((step) => step.id === haltedAt);
  return plan.restartSteps.map((step, index) => ({
    id: step.id,
    argv: [...step.argv],
    cwd: step.cwd,
    exitCode: haltedIndex >= 0 && index > haltedIndex
      ? null
      : overrides[step.id] ?? 0,
    durationMs: 3,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutDigest: 'a'.repeat(64),
    stderrDigest: 'b'.repeat(64),
    ...(overrides[step.id] === undefined || overrides[step.id] === 0
      ? {} : { failureDetail: `exited with ${String(overrides[step.id])}` }),
  }));
}

/** Reads one local ref of the main checkout. */
async function readRef(fixture: PromotionFixture, ref: string): Promise<string> {
  return await git(fixture.value.repo, ['rev-parse', '--verify', ref]);
}

/** Reads one ref of the bare remote, which is only ever written by the promotion or the fixture. */
async function readRemoteRef(fixture: PromotionFixture, ref: string): Promise<string | null> {
  try {
    return await git(fixture.remote, ['rev-parse', '--verify', '--quiet', ref]);
  } catch {
    return null;
  }
}

/**
 * The user's explicit step in the main checkout (ADR-0047 D03): fetch the pushed dev candidate and
 * fast-forward main onto it. Nothing in the product performs this, which is why the tests do it.
 */
async function pullIntoMain(fixture: PromotionFixture): Promise<void> {
  await git(fixture.value.repo, ['fetch', '-q', 'origin']);
  await git(fixture.value.repo, ['merge', '--ff-only', '-q', 'origin/dev']);
}

/** Moves the remote dev branch to a commit that is not the fixed candidate. */
async function moveRemoteDev(fixture: PromotionFixture, to: string): Promise<void> {
  await git(fixture.devClone, ['push', '-q', '--force', 'origin', `${to}:refs/heads/dev`]);
}

async function writeHook(remote: string, name: string, script: string): Promise<string> {
  const path = join(remote, 'hooks', name);
  await Bun.write(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** An unrelated commit that exists in the dev clone, so the remote can be moved to it. */
async function unrelatedCommit(fixture: PromotionFixture): Promise<string> {
  return await git(fixture.devClone, ['commit-tree', `${fixture.mainCommit}^{tree}`,
    '-m', 'unrelated']);
}

describe('stable promotion storage migration', () => {
  test('upgrades a version 12 database with the promotion tables and rejects illegal states', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-promotion-v12-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      const legacy = new Database(filename, { create: true, strict: true });
      legacy.exec('PRAGMA foreign_keys=ON;');
      legacy.exec(phase1Migration);
      legacy.exec(agentStartMigration);
      legacy.exec(agentObservationMigration);
      legacy.exec(agentAnswerMigration);
      legacy.exec(agentDisconnectMigration);
      legacy.exec(taskVerificationMigration);
      legacy.exec(workspaceRetryMigration);
      legacy.exec(agentConfigurationMigration);
      legacy.exec(taskControlMigration);
      legacy.exec(integrationPipelineMigration);
      legacy.exec(operationProgressMigration);
      legacy.exec(reclamationMigration);
      legacy.exec('PRAGMA user_version=12');
      legacy.close();

      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()
        ?.user_version).toBe(phase1SchemaVersion);
      const tables = upgraded.sqlite.query<{ name: string }, []>(`
        SELECT name FROM sqlite_master WHERE type='table' AND name IN
          ('stable_promotions','stable_promotion_members') ORDER BY name
      `).all().map((row) => row.name);
      expect(tables).toEqual(['stable_promotion_members', 'stable_promotions']);
      // A promotion cannot claim a state outside the documented machine.
      expect(() => upgraded.sqlite.query(`
        INSERT INTO stable_promotions(id,project_id,dev_ref,main_ref,candidate_commit,
          expected_main_commit,integration_batch_id,verification_id,verification_tested_commit,
          permission_mode,state,created_at)
        VALUES ('x','missing','refs/heads/dev','refs/heads/main','a','b','c','d','e','FULL','NONSENSE',1)
      `).run()).toThrow();
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('preparing a promotion', () => {
  test('fixes the triple and the dev clone without writing to Git or the remote', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      expect(prepared).toMatchObject({
        state: 'CREATED', phase: 'READY_TO_PUSH',
        candidateCommit: fixture.candidateCommit, expectedMainCommit: fixture.mainCommit,
        devRepoPath: fixture.devClone, remoteDevCommit: null, pushedAt: null,
        promotedCommit: null, remoteMainCommit: null, mainPushedAt: null,
      });
      expect(prepared.fullSuite).toMatchObject({ evidenceId: fixture.fullSuiteEvidenceId,
        devCommit: fixture.candidateCommit });
      expect(prepared.members).toHaveLength(1);
      // Preparing writes nothing: neither the main checkout nor the remote dev branch moved.
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
      expect(await readRemoteRef(fixture, 'refs/heads/dev')).toBeNull();
      expect(await readRemoteRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses a dev commit that is not the batch integration result', async () => {
    const fixture = await promotionFixture();
    try {
      await expect(prepare(fixture, { expectedDevCommit: fixture.mainCommit }))
        .rejects.toMatchObject({ code: 'PROMOTION_EVIDENCE_MISMATCH' });
      expect(fixture.value.storage.listStablePromotions(fixture.value.projectId)).toEqual([]);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses an abbreviated commit id instead of resolving it later', async () => {
    const fixture = await promotionFixture();
    try {
      await expect(prepare(fixture, { expectedDevCommit: fixture.candidateCommit.slice(0, 8) }))
        .rejects.toMatchObject({ code: 'INVALID_COMMIT_ID' });
      await expect(prepare(fixture, { expectedMainCommit: fixture.mainCommit.slice(0, 8) }))
        .rejects.toMatchObject({ code: 'INVALID_COMMIT_ID' });
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses when main is not at the expected commit or already is the candidate', async () => {
    const fixture = await promotionFixture();
    try {
      await expect(prepare(fixture, { expectedMainCommit: 'f'.repeat(40) }))
        .rejects.toMatchObject({ code: 'MAIN_REF_MOVED' });
      expect(fixture.value.storage.listStablePromotions(fixture.value.projectId)).toEqual([]);
      // main already at the candidate: there is nothing to promote.
      await git(fixture.mainWorktree, ['merge', '--ff-only', '-q', fixture.candidateCommit]);
      await expect(prepare(fixture, { expectedMainCommit: fixture.candidateCommit }))
        .rejects.toMatchObject({ code: 'PROMOTION_NOTHING_TO_PROMOTE' });
      expect(fixture.value.storage.listStablePromotions(fixture.value.projectId)).toEqual([]);
      expect(await readRemoteRef(fixture, 'refs/heads/dev')).toBeNull();
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses without a dev clone and when the recorded one is not a separate clone', async () => {
    const fixture = await promotionFixture();
    try {
      await recordDevClone(fixture.value, null);
      await expect(prepare(fixture)).rejects.toMatchObject({ code: 'DEV_REPO_PATH_MISSING' });

      // The main checkout is not "another clone": pushing from it is exactly the local path
      // ADR-0047 removed, so a recorded path pointing there is refused.
      await recordDevClone(fixture.value, fixture.value.repo);
      await expect(prepare(fixture)).rejects.toMatchObject({ code: 'DEV_REPO_NOT_SEPARATE' });
      expect(fixture.value.storage.listStablePromotions(fixture.value.projectId)).toEqual([]);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses a batch that is not INTEGRATED or whose verification did not pass', async () => {
    const fixture = await promotionFixture();
    try {
      expect(() => fixture.value.storage.getPromotionCandidates(
        fixture.value.projectId, crypto.randomUUID())).toThrow();
      fixture.value.storage.sqlite.query(
        "UPDATE integration_batches SET state='VERIFYING',integrated_commit=NULL WHERE id=?1",
      ).run(fixture.batchId);
      await expect(prepare(fixture)).rejects.toMatchObject({ code: 'BATCH_NOT_INTEGRATED' });
      expect(fixture.value.storage.listStablePromotions(fixture.value.projectId)).toEqual([]);

      const other = await promotionFixture();
      try {
        other.value.storage.sqlite.query(
          "UPDATE integration_verification_runs SET state='FAILED',outcome_code='EXIT_1' "
          + 'WHERE id=?1',
        ).run(other.verificationId);
        await expect(prepare(other)).rejects.toMatchObject({ code: 'VERIFICATION_NOT_PASSED' });
      } finally {
        other.value.storage.close();
      }
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses when the main checkout is being edited', async () => {
    const fixture = await promotionFixture();
    try {
      await Bun.write(join(fixture.mainWorktree, 'README.md'), 'locally edited\n');
      await expect(prepare(fixture)).rejects.toMatchObject({ code: 'MAIN_WORKTREE_DIRTY' });
      expect(await readRemoteRef(fixture, 'refs/heads/dev')).toBeNull();
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses to prepare a promotion with no full-suite run of the candidate', async () => {
    const fixture = await promotionFixture({ withoutFullSuiteEvidence: true });
    try {
      await expect(prepare(fixture)).rejects
        .toMatchObject({ code: 'DEV_FULL_SUITE_EVIDENCE_MISSING' });
      expect(fixture.value.storage.listStablePromotions(fixture.value.projectId)).toEqual([]);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses when the remote dev branch already moved away from the candidate', async () => {
    const fixture = await promotionFixture();
    try {
      // Someone else moved the remote dev branch to a commit this promotion knows nothing about.
      await moveRemoteDev(fixture, await unrelatedCommit(fixture));
      await expect(prepare(fixture)).rejects.toMatchObject({ code: 'REMOTE_DEV_MOVED' });
      // The refusal created no record and moved no ref.
      expect(fixture.value.storage.listStablePromotions(fixture.value.projectId)).toEqual([]);
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses an unreachable remote without making the record stale', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      const removed = await git(fixture.value.repo, ['remote', 'get-url', 'origin']);
      rmSync(removed, { recursive: true, force: true });
      await expect(promote(fixture, prepared.promotionId))
        .rejects.toMatchObject({ code: 'REMOTE_DEV_UNREACHABLE' });
      const record = fixture.value.storage.getStablePromotion(
        fixture.value.projectId, prepared.promotionId);
      // An offline machine is not a stale promotion: the record is still exactly right.
      expect(record).toMatchObject({ state: 'CREATED', phase: 'READY_TO_PUSH',
        outcomeCode: 'REMOTE_DEV_UNREACHABLE', remoteDevCommit: null });
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('a policy edit on main invalidates the evidence before anything is pushed', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      // The full suite's command set is the project policy read at the main ref, so editing it
      // there is exactly the change that must invalidate the evidence.
      await Bun.write(join(fixture.mainWorktree, '.codeestra', 'policies', 'verification.json'),
        `${JSON.stringify({ version: 1, commands: [{ id: 'check', argv: ['echo', 'changed'],
          cwd: '.', timeoutSeconds: 60 }] })}\n`);
      await git(fixture.mainWorktree, ['add', '.codeestra/policies/verification.json']);
      await git(fixture.mainWorktree, ['commit', '-q', '-m', 'different judging commands']);
      await expect(promote(fixture, prepared.promotionId))
        .rejects.toMatchObject({ code: 'DEV_FULL_SUITE_EVIDENCE_STALE' });
      const record = fixture.value.storage.getStablePromotion(
        fixture.value.projectId, prepared.promotionId);
      expect(record).toMatchObject({ state: 'STALE',
        outcomeCode: 'DEV_FULL_SUITE_EVIDENCE_STALE', remoteDevCommit: null });
      expect(await readRemoteRef(fixture, 'refs/heads/dev')).toBeNull();
    } finally {
      fixture.value.storage.close();
    }
  });
});

describe('pushing the fixed candidate and awaiting the pull', () => {
  test('pushes, reads the remote back and stops at "pushed, awaiting pull"', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      const pushed = await promote(fixture, prepared.promotionId);
      expect(pushed).toMatchObject({
        state: 'PROMOTING', phase: 'AWAITING_PULL',
        candidateCommit: fixture.candidateCommit,
        devRepoPath: fixture.devClone,
        remoteDevCommit: fixture.candidateCommit,
        promotedCommit: null, remoteMainCommit: null,
      });
      expect(pushed.pushedAt).not.toBeNull();
      // Exactly one ref moved, and it is the remote dev branch: the main checkout is untouched and
      // no restart plan exists yet, so nothing can be reported as a completed promotion.
      expect(await readRemoteRef(fixture, 'refs/heads/dev')).toBe(fixture.candidateCommit);
      expect(await readRemoteRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
      expect(pushed.restartSteps).toEqual([]);
      expect(pushed.restart).toBeNull();
      // The dev clone's own branch is untouched as well.
      expect(await git(fixture.devClone, ['rev-parse', 'refs/heads/dev']))
        .toBe(fixture.candidateCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('a remote that refuses the push records nothing as pushed and moves no ref', async () => {
    const fixture = await promotionFixture();
    try {
      await writeHook(fixture.remote, 'pre-receive',
        'echo "policy: refusing this update" >&2\nexit 1');
      const prepared = await prepare(fixture);
      await expect(promote(fixture, prepared.promotionId))
        .rejects.toMatchObject({ code: 'DEV_PUSH_REFUSED' });
      const record = fixture.value.storage.getStablePromotion(
        fixture.value.projectId, prepared.promotionId);
      expect(record).toMatchObject({ state: 'CREATED', phase: 'READY_TO_PUSH',
        outcomeCode: 'DEV_PUSH_REFUSED', remoteDevCommit: null, pushedAt: null });
      expect(await readRemoteRef(fixture, 'refs/heads/dev')).toBeNull();
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('a readback that is not the candidate is not recorded as pushed', async () => {
    const fixture = await promotionFixture();
    try {
      // The push is accepted, but the remote dev branch ends up somewhere else before we read it
      // back: "the push command exited 0" must not be enough (ADR-0047 D02).
      await writeHook(fixture.remote, 'post-receive', 'git update-ref refs/heads/dev refs/heads/main');
      const prepared = await prepare(fixture);
      await expect(promote(fixture, prepared.promotionId))
        .rejects.toMatchObject({ code: 'REMOTE_DEV_READBACK_MISMATCH' });
      const record = fixture.value.storage.getStablePromotion(
        fixture.value.projectId, prepared.promotionId);
      expect(record).toMatchObject({ state: 'CREATED', outcomeCode: 'REMOTE_DEV_READBACK_MISMATCH',
        remoteDevCommit: null });
      expect(await readRemoteRef(fixture, 'refs/heads/dev')).toBe(fixture.mainCommit);
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('a remote dev branch moved after the push is STALE and no restart is recorded', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      await promote(fixture, prepared.promotionId);
      await moveRemoteDev(fixture, await unrelatedCommit(fixture));
      await expect(promote(fixture, prepared.promotionId))
        .rejects.toMatchObject({ code: 'REMOTE_DEV_MOVED' });
      const record = fixture.value.storage.getStablePromotion(
        fixture.value.projectId, prepared.promotionId);
      expect(record).toMatchObject({ state: 'STALE', outcomeCode: 'REMOTE_DEV_MOVED',
        promotedCommit: null, remoteMainCommit: null });
      // Nothing was restarted and nothing was published, and the main checkout did not move.
      expect(record.restart).toBeNull();
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
      expect(await readRemoteRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);

      // A second prepare is refused for the same reason, and creates no other record.
      await expect(prepare(fixture)).rejects.toMatchObject({ code: 'REMOTE_DEV_MOVED' });
      expect(fixture.value.storage.listStablePromotions(fixture.value.projectId)).toHaveLength(1);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('a non-fast-forward remote dev branch is refused instead of being pushed over', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      // The remote moves between prepare and promote to a commit that is not an ancestor.
      const unrelated = await unrelatedCommit(fixture);
      await moveRemoteDev(fixture, unrelated);
      await expect(promote(fixture, prepared.promotionId))
        .rejects.toMatchObject({ code: 'REMOTE_DEV_MOVED' });
      // The remote was not rewritten: it still holds the commit the promotion refused.
      expect(await readRemoteRef(fixture, 'refs/heads/dev')).toBe(unrelated);
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
      const record = fixture.value.storage.getStablePromotion(
        fixture.value.projectId, prepared.promotionId);
      expect(record).toMatchObject({ state: 'STALE', remoteDevCommit: null });
    } finally {
      fixture.value.storage.close();
    }
  });
});

describe('pulling, restarting and publishing', () => {
  test('the pull is verified, the restart is recorded, and only then is main published', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      const pushed = await promote(fixture, prepared.promotionId);
      expect(pushed.phase).toBe('AWAITING_PULL');

      await pullIntoMain(fixture);
      const plan = await promote(fixture, prepared.promotionId);
      expect(plan).toMatchObject({
        state: 'RESTARTING', phase: 'RESTART_PENDING',
        promotedCommit: fixture.candidateCommit,
        mainWorktreePath: fixture.mainWorktree,
        promotingBootId: 'boot-awaiting-pull',
      });
      // ADR-0009 D03: the fixed post-step sequence, in the main worktree, recorded before it runs.
      expect(plan.restartSteps.map((step) => step.id))
        .toEqual(['install', 'build-ui', 'stop', 'status']);
      expect(plan.restartSteps.every((step) => step.cwd === fixture.mainWorktree)).toBe(true);
      // The pull was a fast-forward performed by the user in the main checkout.
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.candidateCommit);
      expect(await git(fixture.mainWorktree, ['status', '--porcelain'])).toBe('');
      // Nothing is published while the restart has not been recorded.
      expect(await readRemoteRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);

      const recorded = await restartRecord(fixture, prepared.promotionId,
        { steps: stepsWith(plan) });
      expect(recorded).toMatchObject({ state: 'SUCCEEDED', phase: 'COMPLETE',
        outcomeCode: 'PROMOTED', remoteMainCommit: fixture.candidateCommit });
      expect(recorded.restart).toMatchObject({ runtimeStatus: 'READY', uiRunning: false });
      expect(recorded.detail).toContain('READY');
      // The publish happened after the restart, and the remote is the final fact.
      expect(await readRemoteRef(fixture, 'refs/heads/main')).toBe(fixture.candidateCommit);
      expect(await readRemoteRef(fixture, 'refs/heads/dev')).toBe(fixture.candidateCommit);

      // A replay reports the finished record instead of running anything again.
      const replay = await restartRecord(fixture, prepared.promotionId, { steps: [] });
      expect(replay).toMatchObject({ state: 'SUCCEEDED', replayed: true });
    } finally {
      fixture.value.storage.close();
    }
  });

  test('a runtime that was not restarted cannot be recorded as a restart, and never publishes', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      await promote(fixture, prepared.promotionId);
      await pullIntoMain(fixture);
      const plan = await promote(fixture, prepared.promotionId);
      // The boot answering the restart record is the one that read the pull, so the Runtime was
      // never stopped: the promotion is recorded as failed and the stable commit is not published.
      const notRestarted = await restartRecord(fixture, prepared.promotionId, {
        bootId: 'boot-awaiting-pull', observedBootId: 'boot-awaiting-pull',
        steps: stepsWith(plan),
      });
      expect(notRestarted).toMatchObject({ state: 'FAILED', outcomeCode: 'RUNTIME_NOT_RESTARTED',
        remoteMainCommit: null });
      expect(await readRemoteRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.candidateCommit);
    } finally {
      fixture.value.storage.close();
    }

    const second = await promotionFixture();
    try {
      const prepared = await prepare(second);
      await promote(second, prepared.promotionId);
      await pullIntoMain(second);
      const plan = await promote(second, prepared.promotionId);
      // A step that did not exit 0 is recorded as a failure that keeps main where it is, and the
      // stable commit is not published.
      const failed = await restartRecord(second, prepared.promotionId, {
        steps: stepsWith(plan, { 'build-ui': 1 }),
      });
      expect(failed).toMatchObject({ state: 'FAILED', outcomeCode: 'RESTART_STEP_FAILED',
        remoteMainCommit: null });
      expect(failed.restart?.steps.map((step) => [step.id, step.exitCode])).toEqual([
        ['install', 0], ['build-ui', 1], ['stop', null], ['status', null],
      ]);
      expect(await readRemoteRef(second, 'refs/heads/main')).toBe(second.mainCommit);
      expect(await readRef(second, 'refs/heads/main')).toBe(second.candidateCommit);
    } finally {
      second.value.storage.close();
    }
  }, 120_000);

  test('a refused main publish keeps the promotion open and retries only the publish', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      await promote(fixture, prepared.promotionId);
      await pullIntoMain(fixture);
      const plan = await promote(fixture, prepared.promotionId);
      // The remote refuses the stable branch specifically: the dev push already succeeded.
      const hook = await writeHook(fixture.remote, 'pre-receive',
        'while read old new ref; do\n'
        + '  case "$ref" in refs/heads/main) echo "policy: refusing main" >&2; exit 1;; esac\n'
        + 'done\nexit 0');
      await expect(restartRecord(fixture, prepared.promotionId, { steps: stepsWith(plan) }))
        .rejects.toMatchObject({ code: 'MAIN_PUSH_REFUSED' });
      const open = fixture.value.storage.getStablePromotion(
        fixture.value.projectId, prepared.promotionId);
      expect(open).toMatchObject({ state: 'RESTARTING', phase: 'MAIN_PUSH_PENDING',
        outcomeCode: 'MAIN_PUSH_REFUSED', remoteMainCommit: null,
        promotedCommit: fixture.candidateCommit });
      // The restart evidence is kept: nothing is rolled back and no step is repeated.
      expect(open.restart).not.toBeNull();
      expect(await readRemoteRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);

      rmSync(hook);
      const completed = await promote(fixture, prepared.promotionId);
      expect(completed).toMatchObject({ state: 'SUCCEEDED', phase: 'COMPLETE',
        remoteMainCommit: fixture.candidateCommit, outcomeCode: 'PROMOTED' });
      expect(completed.restart).toEqual(open.restart);
      expect(await readRemoteRef(fixture, 'refs/heads/main')).toBe(fixture.candidateCommit);
    } finally {
      fixture.value.storage.close();
    }
  });
});

describe('STRICT approval', () => {
  test('promotes only after an approval of the exact triple, and FULL refuses to approve', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture, { permissionMode: 'STRICT' });
      await expect(promote(fixture, prepared.promotionId, { permissionMode: 'STRICT' }))
        .rejects.toMatchObject({ code: 'PROMOTION_NOT_APPROVED' });
      expect(fixture.value.storage.getStablePromotion(
        fixture.value.projectId, prepared.promotionId).remoteDevCommit).toBeNull();

      const approved = await approveStablePromotion({
        storage: fixture.value.storage,
        projectId: fixture.value.projectId,
        promotionId: prepared.promotionId,
        permissionMode: 'STRICT',
      });
      expect(approved).toMatchObject({ state: 'AWAITING_APPROVAL' });
      expect(approved.approval).toMatchObject({
        devCommit: fixture.candidateCommit, mainCommit: fixture.mainCommit,
        fullSuiteEvidenceId: fixture.fullSuiteEvidenceId,
      });
      expect((await promote(fixture, prepared.promotionId, { permissionMode: 'STRICT' })).phase)
        .toBe('AWAITING_PULL');

      // FULL never needs an approval, so asking for one is refused rather than recorded.
      const other = await promotionFixture();
      try {
        const full = await prepare(other);
        await expect(approveStablePromotion({
          storage: other.value.storage,
          projectId: other.value.projectId,
          promotionId: full.promotionId,
          permissionMode: 'FULL',
        })).rejects.toMatchObject({ code: 'APPROVAL_NOT_REQUIRED' });
      } finally {
        other.value.storage.close();
      }
    } finally {
      fixture.value.storage.close();
    }
  });

  test('an approval is refused once the remote dev branch moved, and the record becomes STALE', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture, { permissionMode: 'STRICT' });
      await moveRemoteDev(fixture, await unrelatedCommit(fixture));
      await expect(approveStablePromotion({
        storage: fixture.value.storage,
        projectId: fixture.value.projectId,
        promotionId: prepared.promotionId,
        permissionMode: 'STRICT',
      })).rejects.toMatchObject({ code: 'REMOTE_DEV_MOVED' });
      expect(fixture.value.storage.getStablePromotion(
        fixture.value.projectId, prepared.promotionId))
        .toMatchObject({ state: 'STALE', outcomeCode: 'REMOTE_DEV_MOVED', approval: null });
    } finally {
      fixture.value.storage.close();
    }
  });

  test('a dev or main move after the approval makes the promotion unusable', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture, { permissionMode: 'STRICT' });
      await approveStablePromotion({
        storage: fixture.value.storage,
        projectId: fixture.value.projectId,
        promotionId: prepared.promotionId,
        permissionMode: 'STRICT',
      });
      // Fault injection: an approval recorded against different full-suite evidence, as an older
      // Runtime or a hand-edited record would leave behind.
      fixture.value.storage.sqlite.query(
        'UPDATE stable_promotions SET approved_full_suite_evidence_id=?1 WHERE id=?2',
      ).run(crypto.randomUUID(), prepared.promotionId);
      await expect(promote(fixture, prepared.promotionId, { permissionMode: 'STRICT' }))
        .rejects.toMatchObject({ code: 'PROMOTION_NOT_APPROVED' });
      expect(await readRemoteRef(fixture, 'refs/heads/dev')).toBeNull();
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
    } finally {
      fixture.value.storage.close();
    }
  });
});

describe('failure and crash recovery', () => {
  const readRefCommit = async ({ ref, repositoryRoot }: {
    readonly ref: string; readonly repositoryRoot: string;
  }): Promise<string | null> =>
    await git(repositoryRoot, ['rev-parse', '--verify', '--quiet', ref]).catch(() => null);

  test('a restart while waiting for the pull leaves the record resumable, not failed', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      await promote(fixture, prepared.promotionId);
      const results = await reconcileInterruptedPromotions({
        storage: fixture.value.storage, readRefCommit,
      });
      expect(results).toEqual([expect.objectContaining({
        promotionId: prepared.promotionId, outcome: 'AWAITING_PULL' })]);
      // The push is verified and the main checkout never moved: nothing was lost, so the record is
      // neither failed nor stale, and the same command continues from where it stopped.
      const record = fixture.value.storage.getStablePromotion(
        fixture.value.projectId, prepared.promotionId);
      expect(record).toMatchObject({ state: 'PROMOTING', phase: 'AWAITING_PULL' });
      await pullIntoMain(fixture);
      expect((await promote(fixture, prepared.promotionId)).state).toBe('RESTARTING');
    } finally {
      fixture.value.storage.close();
    }
  });

  test('reconciles a promotion whose pull happened but whose restart was never recorded', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      await promote(fixture, prepared.promotionId);
      await pullIntoMain(fixture);
      const plan = await promote(fixture, prepared.promotionId);
      // Fault injection: the restart result was never written (the Runtime stopped mid-sequence).
      fixture.value.storage.sqlite.query(
        "UPDATE stable_promotions SET state='PROMOTING',promoted_commit=NULL,"
        + "restart_result_json=NULL WHERE id=?1",
      ).run(prepared.promotionId);
      fixture.value.storage.sqlite.query(
        "UPDATE operations SET state='IN_PROGRESS' WHERE aggregate_id=?1",
      ).run(prepared.promotionId);

      const results = await reconcileInterruptedPromotions({
        storage: fixture.value.storage, readRefCommit,
      });
      expect(results).toEqual([expect.objectContaining({
        promotionId: prepared.promotionId, outcome: 'RESTART_UNPROVEN' })]);
      const record = fixture.value.storage.getStablePromotion(
        fixture.value.projectId, prepared.promotionId);
      expect(record).toMatchObject({ state: 'RECOVERY_REQUIRED',
        outcomeCode: 'RESTART_UNPROVEN', promotedCommit: fixture.candidateCommit });
      expect(record.detail).toContain('no ref will be written again');

      // Resuming re-issues the recorded plan without touching a ref; the finished restart then
      // publishes main.
      const resumed = await promote(fixture, prepared.promotionId);
      expect(resumed).toMatchObject({ state: 'RECOVERY_REQUIRED' });
      expect(resumed.restartSteps).toEqual(plan.restartSteps);
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.candidateCommit);
      const finished = await restartRecord(fixture, prepared.promotionId, {
        steps: stepsWith(plan),
      });
      expect(finished.state).toBe('SUCCEEDED');
      expect(await readRemoteRef(fixture, 'refs/heads/main')).toBe(fixture.candidateCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('reports a main ref it cannot resume instead of guessing', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      await promote(fixture, prepared.promotionId);
      await Bun.write(join(fixture.mainWorktree, 'user-note.txt'), 'mine\n');
      await git(fixture.mainWorktree, ['add', 'user-note.txt']);
      await git(fixture.mainWorktree, ['commit', '-q', '-m', 'someone else moved main']);

      const results = await reconcileInterruptedPromotions({
        storage: fixture.value.storage, readRefCommit,
      });
      expect(results).toEqual([expect.objectContaining({ outcome: 'RESTART_UNPROVEN' })]);
      const record = fixture.value.storage.getStablePromotion(
        fixture.value.projectId, prepared.promotionId);
      expect(record).toMatchObject({ state: 'RECOVERY_REQUIRED', outcomeCode: 'MAIN_REF_OBSERVED' });
      expect(record.promotedCommit).toBeNull();
      // `promote` refuses to resume a promotion whose checkout was moved by someone else, instead
      // of claiming the restart of a promotion that no longer describes reality.
      await expect(promote(fixture, prepared.promotionId))
        .rejects.toMatchObject({ code: 'PROMOTION_IN_PROGRESS' });
      const abandoned = abandonStablePromotion({
        storage: fixture.value.storage,
        projectId: fixture.value.projectId,
        promotionId: prepared.promotionId,
        reason: 'main was moved by hand; nothing was promoted by Codeestra',
      });
      expect(abandoned).toMatchObject({ state: 'FAILED', outcomeCode: 'ABANDONED',
        promotedCommit: null });
      // Abandoning releases the project's promotion slot: once the checkout is back on the commit
      // the promotion was prepared against, a new promotion can be prepared for the same evidence.
      await git(fixture.mainWorktree, ['reset', '--hard', fixture.mainCommit]);
      await expect(prepare(fixture)).resolves.toMatchObject({ state: 'CREATED' });
    } finally {
      fixture.value.storage.close();
    }
  });
});

describe('stable promotion from a multi-member batch (ADR-0053)', () => {
  test('prepares a promotion from one PASSED multi-member batch and refuses mismatched evidence',
    async () => {
      const fixture = await promotionFixture({ multiMember: true });
      try {
        const prepared = await prepare(fixture);
        expect(prepared).toMatchObject({
          state: 'CREATED',
          phase: 'READY_TO_PUSH',
          candidateCommit: fixture.candidateCommit,
          integrationBatchId: fixture.batchId,
          verificationId: fixture.verificationId,
          created: true,
        });
        // The promotion fixes the batch's whole member set, not just one Task.
        expect(prepared.members).toHaveLength(2);
        expect(new Set(prepared.members.map((member) => member.taskId)).size).toBe(2);
        expect(prepared.members.every((member) =>
          member.batchId === fixture.batchId && member.candidateCommit.length > 0)).toBe(true);

        // Evidence that does not name this batch's integrated commit is refused, not reinterpreted.
        await expect(prepare(fixture, { commandId: crypto.randomUUID(),
          expectedDevCommit: fixture.mainCommit })).rejects
          .toMatchObject({ code: 'PROMOTION_EVIDENCE_MISMATCH' });
        // A different batch that never integrated is refused as a batch, not as a member.
        await expect(prepare(fixture, { commandId: crypto.randomUUID(),
          batchId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      } finally {
        fixture.value.storage.close();
      }
    }, 180_000);
});
