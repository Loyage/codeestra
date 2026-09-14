import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
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
import { integrateTaskResult } from '../src/integration-service.js';
import {
  abandonStablePromotion,
  approveStablePromotion,
  prepareStablePromotion,
  promoteStableBranch,
  recordPromotionRestart,
} from '../src/promotion-service.js';
import { reconcileInterruptedPromotions } from '../src/recovery-service.js';
import { captureResultCommit, prepareResultCommit } from '../src/result-commit-service.js';
import { VerificationRunner, runTaskVerification } from '../src/verification-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  git,
  type AgentFixture,
} from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

interface PromotionFixture {
  readonly value: AgentFixture;
  readonly candidateCommit: string;
  readonly batchId: string;
  readonly verificationId: string;
  readonly mainCommit: string;
  readonly mainWorktree: string;
}

/**
 * A Task whose captured result commit is already integrated into `dev` with a PASSED independent
 * integration verification: the only state a promotion can be prepared from. The active lane
 * integration pipeline produces the records for real (fake adapter, real Git), so the promotion is
 * judged against genuine evidence rather than hand-written rows.
 */
async function promotionFixture(): Promise<PromotionFixture> {
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
  await captureResultCommit({
    storage: value.storage, projectId: value.projectId, taskId: value.taskId,
    authorizationId: prepared.authorizationId, commandId: crypto.randomUUID(),
  });
  const verification = await runTaskVerification({
    storage: value.storage, runner: new VerificationRunner(),
    copiesRoot: join(value.home, 'verifications'),
    projectId: value.projectId, taskId: value.taskId, commandId: crypto.randomUUID(),
  });
  expect(verification.state).toBe('PASSED');
  const integrated = await integrateTaskResult({
    storage: value.storage,
    runner: new VerificationRunner(),
    copiesRoot: join(value.home, 'verifications'),
    worktreesRoot: join(value.home, 'integrations'),
    projectId: value.projectId,
    taskId: value.taskId,
    expectedVersion: value.storage.getTask(value.projectId, value.taskId)?.version as number,
    commandId: crypto.randomUUID(),
    permissionMode: 'FULL',
  });
  expect(integrated.state).toBe('INTEGRATED');
  const batch = value.storage.listIntegrationBatches(value.projectId, value.taskId)[0];
  if (batch === undefined || batch.verificationId === null) {
    throw new Error('the integration fixture did not record a verified batch');
  }
  return {
    value,
    candidateCommit: integrated.integratedCommit as string,
    batchId: batch.batchId,
    verificationId: batch.verificationId,
    mainCommit: value.mainCommit,
    mainWorktree: value.repo,
  };
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
    bootId: 'boot-of-the-promoting-runtime',
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

/** Reads one local ref of the fixture repository. */
async function readRef(fixture: PromotionFixture, ref: string): Promise<string> {
  return await git(fixture.value.repo, ['rev-parse', '--verify', ref]);
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

describe('stable promotion preparation', () => {
  test('fixes the verified dev commit, the expected main commit and the integration evidence', async () => {
    const fixture = await promotionFixture();
    try {
      const commandId = crypto.randomUUID();
      const report = await prepare(fixture, { commandId });
      expect(report).toMatchObject({
        state: 'CREATED',
        permissionMode: 'FULL',
        devRef: 'refs/heads/dev',
        mainRef: 'refs/heads/main',
        candidateCommit: fixture.candidateCommit,
        expectedMainCommit: fixture.mainCommit,
        integrationBatchId: fixture.batchId,
        verificationId: fixture.verificationId,
        promotedCommit: null,
        created: true,
        replayed: false,
      });
      // The member revision of the batch is fixed on the promotion, so the promoted revision set
      // stays traceable even if the batch is extended later.
      expect(report.members).toEqual([expect.objectContaining({
        batchId: fixture.batchId,
        taskId: fixture.value.taskId,
        revisionId: fixture.value.revisionId,
        candidateCommit: fixture.candidateCommit,
      })]);
      // Nothing was written to Git by a preparation.
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
      expect(await readRef(fixture, 'refs/heads/dev')).toBe(fixture.candidateCommit);
      // Replaying the same command returns the same record instead of preparing a second one.
      const replay = await prepare(fixture, { commandId });
      expect(replay).toMatchObject({ created: false, replayed: true,
        promotionId: report.promotionId });
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses a dev commit that is not the batch integration result', async () => {
    const fixture = await promotionFixture();
    try {
      await expect(prepare(fixture, { expectedDevCommit: fixture.mainCommit }))
        .rejects.toMatchObject({ code: 'PROMOTION_EVIDENCE_MISMATCH' });
      expect(fixture.value.storage.listStablePromotions(fixture.value.projectId)).toHaveLength(0);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses an abbreviated commit id instead of resolving it later', async () => {
    const fixture = await promotionFixture();
    try {
      await expect(prepare(fixture, { expectedMainCommit: fixture.mainCommit.slice(0, 8) }))
        .rejects.toMatchObject({ code: 'INVALID_COMMIT_ID' });
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses when main is not at the expected commit or is already the dev commit', async () => {
    const fixture = await promotionFixture();
    try {
      await expect(prepare(fixture, { expectedMainCommit: 'f'.repeat(40) }))
        .rejects.toMatchObject({ code: 'MAIN_REF_MOVED' });
      // An already-promoted main is reported as such instead of producing an empty promotion.
      await git(fixture.mainWorktree, ['merge', '--ff-only', fixture.candidateCommit]);
      await expect(prepare(fixture, { expectedMainCommit: fixture.candidateCommit }))
        .rejects.toMatchObject({ code: 'PROMOTION_NOTHING_TO_PROMOTE' });
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses a batch that is not INTEGRATED or whose verification did not pass', async () => {
    const fixture = await promotionFixture();
    try {
      fixture.value.storage.sqlite.query(
        "UPDATE integration_batches SET state='VERIFYING',integrated_commit=NULL WHERE id=?1",
      ).run(fixture.batchId);
      await expect(prepare(fixture)).rejects.toMatchObject({ code: 'BATCH_NOT_INTEGRATED' });

      fixture.value.storage.sqlite.query(
        "UPDATE integration_batches SET state='INTEGRATED',integrated_commit=?1 WHERE id=?2",
      ).run(fixture.candidateCommit, fixture.batchId);
      fixture.value.storage.sqlite.query(
        "UPDATE integration_verification_runs SET state='FAILED' WHERE id=?1",
      ).run(fixture.verificationId);
      await expect(prepare(fixture)).rejects.toMatchObject({ code: 'VERIFICATION_NOT_PASSED' });
      expect(fixture.value.storage.listStablePromotions(fixture.value.projectId)).toHaveLength(0);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses when the main worktree is being edited or main is not checked out at all', async () => {
    const fixture = await promotionFixture();
    try {
      await Bun.write(join(fixture.mainWorktree, 'README.md'), 'edited while promoting\n');
      await expect(prepare(fixture)).rejects.toMatchObject({ code: 'MAIN_WORKTREE_DIRTY' });
      await git(fixture.mainWorktree, ['checkout', '--', 'README.md']);

      // No worktree has `main` checked out any more; a promotion must refuse rather than advance
      // the branch through its ref and leave that worktree's files behind.
      await git(fixture.mainWorktree, ['checkout', '--quiet', 'dev']);
      await expect(prepare(fixture)).rejects.toMatchObject({ code: 'MAIN_WORKTREE_MISSING' });
      await git(fixture.mainWorktree, ['checkout', '--quiet', 'main']);
    } finally {
      fixture.value.storage.close();
    }
  });
});

describe('stable promotion in FULL mode', () => {
  test('fast-forwards the main worktree and records the restart plan before stopping', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      const promoted = await promote(fixture, prepared.promotionId);
      expect(promoted).toMatchObject({
        state: 'RESTARTING',
        promotedCommit: fixture.candidateCommit,
        mainWorktreePath: fixture.mainWorktree,
        promotingBootId: 'boot-of-the-promoting-runtime',
      });
      // ADR-0009 D03: the fixed post-step sequence, in the main worktree, recorded before it runs.
      expect(promoted.restartSteps.map((step) => step.id))
        .toEqual(['install', 'build-ui', 'stop', 'status']);
      expect(promoted.restartSteps.map((step) => step.argv)).toEqual([
        ['bun', 'install', '--frozen-lockfile'],
        ['bun', 'run', 'build:ui'],
        ['bun', 'run', 'codeestra', 'stop'],
        ['bun', 'run', 'codeestra', 'status'],
      ]);
      expect(promoted.restartSteps.every((step) => step.cwd === fixture.mainWorktree)).toBe(true);
      // The ref, the index and the working files moved together, and dev did not.
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.candidateCommit);
      expect(await git(fixture.mainWorktree, ['rev-parse', 'HEAD'])).toBe(fixture.candidateCommit);
      expect(await git(fixture.mainWorktree, ['status', '--porcelain'])).toBe('');
      expect(await git(fixture.mainWorktree, ['show', 'HEAD:agent-output.txt'])).toBe('work');
    } finally {
      fixture.value.storage.close();
    }
  });

  test('reports SUCCEEDED only for a different boot that answers READY with every step at 0', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      const promoted = await promote(fixture, prepared.promotionId);
      const recorded = await restartRecord(fixture, prepared.promotionId,
        { steps: stepsWith(promoted) });
      expect(recorded).toMatchObject({ state: 'SUCCEEDED', outcomeCode: 'RESTARTED' });
      expect(recorded.restart).toMatchObject({ runtimeStatus: 'READY', uiRunning: false });
      expect(recorded.restart?.steps).toHaveLength(4);
      expect(recorded.detail).toContain('READY');
      // A replay reports the finished record instead of running anything again.
      const replay = await restartRecord(fixture, prepared.promotionId, { steps: [] });
      expect(replay).toMatchObject({ state: 'SUCCEEDED', replayed: true });
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.candidateCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('does not accept a restart the client claims without the Runtime having restarted', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      const promoted = await promote(fixture, prepared.promotionId);
      // The same boot that moved main: the Runtime was never stopped, so this cannot be a restart.
      const recorded = await restartRecord(fixture, prepared.promotionId, {
        bootId: 'boot-of-the-promoting-runtime',
        observedBootId: 'boot-of-the-promoting-runtime',
        steps: stepsWith(promoted),
      });
      expect(recorded).toMatchObject({ state: 'FAILED', outcomeCode: 'RUNTIME_NOT_RESTARTED' });
      // main really did move, and the record says so instead of pretending nothing happened.
      expect(recorded.promotedCommit).toBe(fixture.candidateCommit);
      expect(recorded.detail).toContain('was not restarted');
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses a boot identity that is not the Runtime answering the request', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      const promoted = await promote(fixture, prepared.promotionId);
      await expect(restartRecord(fixture, prepared.promotionId, {
        observedBootId: 'some-other-boot', steps: stepsWith(promoted),
      })).rejects.toMatchObject({ code: 'RUNTIME_NOT_OBSERVED' });
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses a step list that differs from the recorded plan or that did not all exit 0', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      const promoted = await promote(fixture, prepared.promotionId);
      await expect(restartRecord(fixture, prepared.promotionId, {
        steps: stepsWith(promoted).slice(0, 2),
      })).rejects.toMatchObject({ code: 'RESTART_PLAN_MISMATCH' });
      const substituted = stepsWith(promoted).map((step, index) => index === 1
        ? { ...step, argv: ['true'] } : step);
      await expect(restartRecord(fixture, prepared.promotionId, { steps: substituted }))
        .rejects.toMatchObject({ code: 'RESTART_PLAN_MISMATCH' });

      const recorded = await restartRecord(fixture, prepared.promotionId, {
        steps: stepsWith(promoted, { 'build-ui': 1 }),
      });
      expect(recorded).toMatchObject({ state: 'FAILED', outcomeCode: 'RESTART_STEP_FAILED' });
      expect(recorded.detail).toContain('build-ui');
      // The failed restart does not roll `main` back: the ref moved and stays moved.
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.candidateCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('fails the restart when the Runtime answers something other than READY', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      const promoted = await promote(fixture, prepared.promotionId);
      const recorded = await restartRecord(fixture, prepared.promotionId, {
        runtimeStatus: 'STARTING', steps: stepsWith(promoted),
      });
      expect(recorded).toMatchObject({ state: 'FAILED', outcomeCode: 'RUNTIME_NOT_READY' });
    } finally {
      fixture.value.storage.close();
    }
  });

  test('does not promote twice and keeps one promotion record per attempt', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      // A second attempt for the same project is refused while one is open.
      await expect(prepare(fixture)).rejects.toMatchObject({ code: 'INVALID_STATE' });
      const first = await promote(fixture, prepared.promotionId);
      expect(first.state).toBe('RESTARTING');
      // A second promote is the resume path: main is already the candidate, so no ref is written
      // again and no second record appears.
      const second = await promote(fixture, prepared.promotionId);
      expect(second).toMatchObject({ state: 'RESTARTING', promotedCommit: fixture.candidateCommit });
      expect(second.restartSteps).toEqual(first.restartSteps);
      expect(fixture.value.storage.listStablePromotions(fixture.value.projectId)).toHaveLength(1);
    } finally {
      fixture.value.storage.close();
    }
  });
});

describe('stable promotion in STRICT mode', () => {
  test('promotes only after an approval of the exact triple, and FULL refuses to approve', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture, { permissionMode: 'STRICT' });
      expect(prepared.permissionMode).toBe('STRICT');
      await expect(promote(fixture, prepared.promotionId, { permissionMode: 'STRICT' }))
        .rejects.toMatchObject({ code: 'PROMOTION_NOT_APPROVED' });
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);

      const approved = approveStablePromotion({
        storage: fixture.value.storage,
        projectId: fixture.value.projectId,
        promotionId: prepared.promotionId,
        permissionMode: 'STRICT',
      });
      expect(approved).toMatchObject({ state: 'AWAITING_APPROVAL' });
      expect(approved.approval).toMatchObject({
        devCommit: fixture.candidateCommit,
        mainCommit: fixture.mainCommit,
        verificationId: fixture.verificationId,
      });
      const promoted = await promote(fixture, prepared.promotionId, { permissionMode: 'STRICT' });
      expect(promoted).toMatchObject({ state: 'RESTARTING', permissionMode: 'STRICT' });
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.candidateCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('refuses an approval in FULL mode instead of recording a pointless confirmation', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      expect(() => approveStablePromotion({
        storage: fixture.value.storage,
        projectId: fixture.value.projectId,
        promotionId: prepared.promotionId,
        permissionMode: 'FULL',
      })).toThrow(expect.objectContaining({ code: 'APPROVAL_NOT_REQUIRED' }));
    } finally {
      fixture.value.storage.close();
    }
  });

  test('makes the approval stale when dev or main moves before the promotion', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture, { permissionMode: 'STRICT' });
      approveStablePromotion({
        storage: fixture.value.storage,
        projectId: fixture.value.projectId,
        promotionId: prepared.promotionId,
        permissionMode: 'STRICT',
      });
      // `dev` moves after the approval: the approved triple no longer describes reality.
      await git(fixture.value.repo, ['update-ref', 'refs/heads/dev', fixture.mainCommit]);
      await expect(promote(fixture, prepared.promotionId, { permissionMode: 'STRICT' }))
        .rejects.toMatchObject({ code: 'PROMOTION_STALE' });
      const [record] = fixture.value.storage.listStablePromotions(fixture.value.projectId);
      expect(record).toMatchObject({ state: 'STALE', outcomeCode: 'DEV_REF_MOVED' });
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
    } finally {
      fixture.value.storage.close();
    }
  });

  test('makes the approval stale when main moves after the approval', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture, { permissionMode: 'STRICT' });
      approveStablePromotion({
        storage: fixture.value.storage,
        projectId: fixture.value.projectId,
        promotionId: prepared.promotionId,
        permissionMode: 'STRICT',
      });
      // A real commit on main, as a user would make one.
      await Bun.write(join(fixture.mainWorktree, 'user-note.txt'), 'mine\n');
      await git(fixture.mainWorktree, ['add', 'user-note.txt']);
      await git(fixture.mainWorktree, ['commit', '-q', '-m', 'user work on main']);
      const movedMain = await readRef(fixture, 'refs/heads/main');
      expect(movedMain).not.toBe(fixture.mainCommit);

      await expect(promote(fixture, prepared.promotionId, { permissionMode: 'STRICT' }))
        .rejects.toMatchObject({ code: 'PROMOTION_STALE' });
      const [record] = fixture.value.storage.listStablePromotions(fixture.value.projectId);
      expect(record).toMatchObject({ state: 'STALE', outcomeCode: 'MAIN_REF_MOVED' });
      // The user's own commit is untouched and nothing was promoted.
      expect(await readRef(fixture, 'refs/heads/main')).toBe(movedMain);
    } finally {
      fixture.value.storage.close();
    }
  });
});

describe('stable promotion failure and crash recovery', () => {
  test('fails with MAIN_NOT_UPDATED when a restart interrupts a promotion that never moved main', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      // Fault injection: the exact state a crash between the record and the fast-forward leaves.
      fixture.value.storage.sqlite.query(
        "UPDATE stable_promotions SET state='PROMOTING',promoting_boot_id='boot-a',"
        + "main_worktree_path=?1 WHERE id=?2",
      ).run(fixture.mainWorktree, prepared.promotionId);
      fixture.value.storage.sqlite.query(
        "UPDATE operations SET state='IN_PROGRESS' WHERE aggregate_id=?1",
      ).run(prepared.promotionId);

      const results = await reconcileInterruptedPromotions({
        storage: fixture.value.storage,
        readRefCommit: async ({ ref, repositoryRoot }) =>
          await git(repositoryRoot, ['rev-parse', '--verify', '--quiet', ref]) || null,
      });
      expect(results).toEqual([expect.objectContaining({
        promotionId: prepared.promotionId, outcome: 'FAILED_MAIN_NOT_UPDATED' })]);
      const [record] = fixture.value.storage.listStablePromotions(fixture.value.projectId);
      expect(record).toMatchObject({ state: 'FAILED', outcomeCode: 'MAIN_NOT_UPDATED' });
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.mainCommit);
      // The failed attempt released the project's promotion slot, so a new one can be prepared.
      await expect(prepare(fixture)).resolves.toMatchObject({ state: 'CREATED' });
    } finally {
      fixture.value.storage.close();
    }
  });

  test('reconciles a promotion whose fast-forward happened but whose restart was never recorded', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      const promoted = await promote(fixture, prepared.promotionId);
      expect(promoted.state).toBe('RESTARTING');
      // Fault injection: the restart result was never written (the Runtime stopped mid-sequence).
      fixture.value.storage.sqlite.query(
        "UPDATE stable_promotions SET state='PROMOTING',promoted_commit=NULL,"
        + "restart_result_json=NULL WHERE id=?1",
      ).run(prepared.promotionId);
      fixture.value.storage.sqlite.query(
        "UPDATE operations SET state='IN_PROGRESS' WHERE aggregate_id=?1",
      ).run(prepared.promotionId);

      const results = await reconcileInterruptedPromotions({
        storage: fixture.value.storage,
        readRefCommit: async ({ ref, repositoryRoot }) =>
          await git(repositoryRoot, ['rev-parse', '--verify', '--quiet', ref]) || null,
      });
      expect(results).toEqual([expect.objectContaining({
        promotionId: prepared.promotionId, outcome: 'RESTART_UNPROVEN' })]);
      const [record] = fixture.value.storage.listStablePromotions(fixture.value.projectId);
      expect(record).toMatchObject({ state: 'RECOVERY_REQUIRED',
        outcomeCode: 'RESTART_UNPROVEN', promotedCommit: fixture.candidateCommit });
      expect(record?.detail).toContain('no ref will be written again');

      // Resuming only re-issues the restart plan: the ref is not written a second time, and the
      // recorded step list is reused.
      const resumed = await promote(fixture, prepared.promotionId);
      expect(resumed).toMatchObject({ state: 'RECOVERY_REQUIRED', restartSteps: promoted.restartSteps });
      expect(resumed.mainWorktreePath).toBe(fixture.mainWorktree);
      expect(await readRef(fixture, 'refs/heads/main')).toBe(fixture.candidateCommit);
      const finished = await restartRecord(fixture, prepared.promotionId, {
        steps: stepsWith(promoted),
      });
      expect(finished.state).toBe('SUCCEEDED');
    } finally {
      fixture.value.storage.close();
    }
  });

  test('reports a main ref it cannot resume instead of guessing', async () => {
    const fixture = await promotionFixture();
    try {
      const prepared = await prepare(fixture);
      fixture.value.storage.sqlite.query(
        "UPDATE stable_promotions SET state='PROMOTING',promoting_boot_id='boot-a',"
        + "main_worktree_path=?1 WHERE id=?2",
      ).run(fixture.mainWorktree, prepared.promotionId);
      await Bun.write(join(fixture.mainWorktree, 'user-note.txt'), 'mine\n');
      await git(fixture.mainWorktree, ['add', 'user-note.txt']);
      await git(fixture.mainWorktree, ['commit', '-q', '-m', 'someone else moved main']);

      const results = await reconcileInterruptedPromotions({
        storage: fixture.value.storage,
        readRefCommit: async ({ ref, repositoryRoot }) =>
          await git(repositoryRoot, ['rev-parse', '--verify', '--quiet', ref]) || null,
      });
      expect(results).toEqual([expect.objectContaining({ outcome: 'RESTART_UNPROVEN' })]);
      const [record] = fixture.value.storage.listStablePromotions(fixture.value.projectId);
      expect(record).toMatchObject({ state: 'RECOVERY_REQUIRED', outcomeCode: 'MAIN_REF_OBSERVED' });
      expect(record?.promotedCommit).toBeNull();
      // `promote` refuses to resume a promotion whose ref was moved by someone else, instead of
      // re-writing main or claiming the restart of a promotion that no longer describes reality.
      await expect(promote(fixture, prepared.promotionId))
        .rejects.toMatchObject({ code: 'PROMOTION_IN_PROGRESS' });
      const abandoned = abandonStablePromotion({
        storage: fixture.value.storage,
        projectId: fixture.value.projectId,
        promotionId: prepared.promotionId,
        reason: 'main was moved by hand; nothing was promoted by Codeestra',
      });
      expect(abandoned).toMatchObject({ state: 'FAILED', outcomeCode: 'ABANDONED' });
      expect(abandoned.promotedCommit).toBeNull();
      // Abandoning releases the project's promotion slot: once main is back on the commit the
      // promotion was prepared against, a new promotion can be prepared for the same evidence.
      await git(fixture.mainWorktree, ['reset', '--hard', fixture.mainCommit]);
      await expect(prepare(fixture)).resolves.toMatchObject({ state: 'CREATED' });
    } finally {
      fixture.value.storage.close();
    }
  });
});
