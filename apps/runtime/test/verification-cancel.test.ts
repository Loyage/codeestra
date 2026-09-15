import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import {
  Phase1Database,
  agentAnswerMigration,
  agentConfigurationMigration,
  agentDisconnectMigration,
  agentObservationMigration,
  agentStartMigration,
  integrationPipelineMigration,
  operationProgressMigration,
  phase1Migration,
  phase1SchemaVersion,
  reclamationMigration,
  sessionHandoffMigration,
  stablePromotionMigration,
  taskControlMigration,
  taskDependenciesMigration,
  taskVerificationMigration,
  verificationProgressMigration,
  workspaceRetryMigration,
} from '@codeestra/storage';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import { LongOperationService, operationSteps } from '../src/operation-service.js';
import { planReclamation } from '../src/reclaim-service.js';
import { reconcileInterruptedVerifications } from '../src/recovery-service.js';
import { captureResultCommit, prepareResultCommit } from '../src/result-commit-service.js';
import { VerificationRunner } from '../src/verification-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  registerTemporaryDirectory,
  waitFor,
  type AgentFixture,
  type AgentFixtureOptions,
} from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

interface ExecutedFixture {
  readonly value: AgentFixture;
  readonly workspacePath: string;
  readonly resultCommit: string;
  readonly copiesRoot: string;
  readonly coordinator: AgentRuntimeCoordinator;
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
    coordinator,
  };
}

function createService(
  fixture: ExecutedFixture,
  runner: VerificationRunner,
): LongOperationService {
  return new LongOperationService({
    storage: fixture.value.storage,
    runner,
    coordinator: fixture.coordinator,
    copiesRoot: fixture.copiesRoot,
    permissionMode: () => 'FULL',
  });
}

/** Every migration this lane's baseline knows about, in ascending order. */
function applyThroughVersion15(legacy: Database): void {
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
  legacy.exec(stablePromotionMigration);
  legacy.exec(sessionHandoffMigration);
  legacy.exec(taskDependenciesMigration);
}

describe('CANCELLED as a first-class verification state (ADR-0027)', () => {
  test('upgrades a database already stamped 16 and keeps every verification row', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-v16-'));
    registerTemporaryDirectory(directory);
    const filename = join(directory, 'runtime.sqlite');
    const legacy = new Database(filename, { create: true, strict: true });
    legacy.exec('PRAGMA foreign_keys=ON;');
    applyThroughVersion15(legacy);
    // Version 16 is unused: the native-terminal migration of the C2 lane landed after this one as
    // version 18, so a database stamped 16 has neither step yet. That is what a database created
    // before either of them looks like.
    legacy.exec('PRAGMA user_version=16');
    legacy.query(`INSERT INTO projects
      (id,name,repo_root,git_common_dir,main_ref,dev_ref,object_format,created_at)
      VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','refs/heads/dev','sha1',1)`).run();
    legacy.query(`INSERT INTO project_trusts
      (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
      VALUES ('trust1','p1','/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run();
    legacy.transaction(() => {
      legacy.query(`INSERT INTO tasks
        (id,project_id,display_number,kind,current_revision_id,state,created_at,updated_at)
        VALUES ('t1','p1',1,'DEVELOPMENT','r1','EXECUTED',2,2)`).run();
      legacy.query(`INSERT INTO task_revisions
        (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
        VALUES ('r1','t1',1,NULL,'Do work','[]','user','initial',2)`).run();
    })();
    legacy.query(`INSERT INTO workspaces
      (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
      VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1','aaa','RETAINED',3)`).run();
    legacy.query(`INSERT INTO executions
      (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,adapter_id,
       adapter_version,state,resource_held,base_commit,result_commit,started_at,ended_at)
      VALUES ('e1','t1',1,'r1','r1','w1','pi','1','SUCCEEDED',0,'aaa','bbb',4,5)`).run();
    legacy.query(`INSERT INTO operations
      (id,project_id,kind,aggregate_id,idempotency_key,state,request_json,created_at,updated_at)
      VALUES ('op1','p1','RUN_TASK_VERIFICATION','v1','cmd-1','IN_PROGRESS','{"taskId":"t1"}',6,6)`).run();
    legacy.query(`INSERT INTO verification_runs
      (id,project_id,task_id,execution_id,revision_id,operation_id,command_id,tested_commit,tested_tree,
       policy_version,policy_digest,main_commit,commands_json,copy_path,state,outcome_code,evidence_json,
       queued_at,started_at,ended_at)
      VALUES ('v1','p1','t1','e1','r1','op1','cmd-1','bbb','tree-1','1','digest-1','aaa','[]',
        '/home/verifications/p1/v1','RUNNING',NULL,NULL,6,7,NULL)`).run();
    legacy.close();

    const upgraded = new Phase1Database(filename);
    try {
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBe(phase1SchemaVersion);
      // Integration fix (Wave H / H3): later lanes append steps after this one (v23 is the
      // Task-retry step), so the claim is "the upgrade reached the current version".
      expect(phase1SchemaVersion).toBeGreaterThanOrEqual(21);
      // The rebuilt table kept the existing row, identity, evidence columns and timestamps.
      const run = upgraded.getVerificationRun('p1', 'v1');
      expect(run.state).toBe('RUNNING');
      expect(run.testedCommit).toBe('bbb');
      expect(run.testedTree).toBe('tree-1');
      expect(run.policyDigest).toBe('digest-1');
      expect(run.copyPath).toBe('/home/verifications/p1/v1');
      expect(run.queuedAt).toBe(6);
      expect(run.startedAt).toBe(7);
      expect(run.endedAt).toBeNull();
      expect(run.outcomeCode).toBeNull();
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
      // The two indexes the rebuilt table owned are back.
      expect(upgraded.sqlite.query<{ name: string }, []>(`
        SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='verification_runs'
          AND name IN ('verification_subject','verification_by_task') ORDER BY name
      `).all().map((row) => row.name)).toEqual(['verification_by_task', 'verification_subject']);
      // The v18 step (the C2 lane's native terminal tables) ran in the same upgrade.
      expect(upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='session_terminals'",
      ).get()?.name).toBe('session_terminals');

      // CANCELLED is a legal terminal state, and like every terminal state it needs both facts.
      expect(() => upgraded.sqlite.query(
        "UPDATE verification_runs SET state='CANCELLED' WHERE id='v1'").run())
        .toThrow();
      upgraded.sqlite.query(`UPDATE verification_runs
        SET state='CANCELLED',outcome_code='CANCELLED_BY_USER',ended_at=8 WHERE id='v1'`).run();
      expect(upgraded.getVerificationRun('p1', 'v1').state).toBe('CANCELLED');
      // A non-terminal state may not carry terminal facts either.
      expect(() => upgraded.sqlite.query(`INSERT INTO verification_runs
        (id,project_id,task_id,execution_id,revision_id,operation_id,command_id,tested_commit,tested_tree,
         policy_version,policy_digest,main_commit,commands_json,copy_path,state,outcome_code,queued_at,
         ended_at)
        VALUES ('v2','p1','t1','e1','r1','op1','cmd-2','bbb','tree-1','1','digest-1','aaa','[]',
          '/home/verifications/p1/v2','QUEUED','PASSED',9,9)`).run()).toThrow();
    } finally {
      upgraded.close();
    }
  });

  test('does not re-run the rebuild for a database already at the current version', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-current-'));
    registerTemporaryDirectory(directory);
    const filename = join(directory, 'runtime.sqlite');
    const first = new Phase1Database(filename);
    first.close();
    const second = new Phase1Database(filename);
    try {
      // The constant is the newest additive version; a database stamped with it must not run any
      // `version <` step again, the rebuild of `verification_runs` included.
      expect(second.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBe(phase1SchemaVersion);
    } finally {
      second.close();
    }
  });

  test('applies only the later migration to a database stamped 17', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-storage-v17-'));
    registerTemporaryDirectory(directory);
    const filename = join(directory, 'runtime.sqlite');
    // A database written by this lane before the C2 lane's version 18 step existed: the
    // verification rebuild has run, the native-terminal migration has not.
    const legacy = new Database(filename, { create: true, strict: true });
    legacy.exec('PRAGMA foreign_keys=ON;');
    applyThroughVersion15(legacy);
    legacy.exec(verificationProgressMigration);
    legacy.exec('PRAGMA user_version=17');
    legacy.close();

    const upgraded = new Phase1Database(filename);
    try {
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBe(phase1SchemaVersion);
      // Integration fix (Wave H / H3): later lanes append steps after this one (v23 is the
      // Task-retry step), so the claim is "the upgrade reached the current version".
      expect(phase1SchemaVersion).toBeGreaterThanOrEqual(21);
      expect(upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='session_terminals'",
      ).get()?.name).toBe('session_terminals');
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
    } finally {
      upgraded.close();
    }
  });
});

describe('cancelling a verification run', () => {
  test('records CANCELLED only after the stop is confirmed and keeps the copy as a scene', async () => {
    const fixture = await executedTask({ verificationCommands: [
      { id: 'slow', argv: ['sleep', '30'], cwd: '.', timeoutSeconds: 60 },
    ] });
    const runner = new VerificationRunner();
    const service = createService(fixture, runner);
    try {
      const started = await service.startVerification({
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        commandId: crypto.randomUUID(),
        background: true,
      });
      if (!started.background) throw new Error('background verification did not return a handle');
      const { operationId, verificationId } = started.handle;
      await waitFor(() => fixture.value.storage.getOperation(fixture.value.projectId, operationId)
        .steps.some((step) => step.stepKey === operationSteps.commandStarted('slow')), 10_000);

      const outcome = await service.cancel({
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        operationId,
        commandId: crypto.randomUUID(),
        actor: 'local-user',
      });
      expect(outcome.stop).toBe('CANCELLED');

      const run = fixture.value.storage.getVerificationRun(fixture.value.projectId, verificationId);
      // A user stop is its own terminal state, so a reader never has to read ERROR and infer why.
      expect(run.state).toBe('CANCELLED');
      expect(run.state).not.toBe('FAILED');
      expect(run.state).not.toBe('ERROR');
      expect(run.outcomeCode).toBe('CANCELLED_BY_USER');
      expect(run.endedAt).not.toBeNull();
      expect(run.evidence).toMatchObject({
        cancelledBy: 'local-user', stoppedProcessGroup: true, previousState: 'RUNNING',
      });
      // The Operation keeps the ADR-0019 vocabulary, with the cancel flag that says why it ended.
      const operation = fixture.value.storage.getOperation(fixture.value.projectId, operationId);
      expect(operation.state).toBe('FAILED');
      expect(operation.result).toMatchObject({ cancelled: true, outcomeCode: 'CANCELLED_BY_USER' });
      // The cancelled copy stays: it is the scene of a stop, exactly like a failed run's.
      expect(existsSync(run.copyPath)).toBe(true);

      // Existing readers express it. `task verification list` and `task.status` both project
      // `listVerificationRuns`, so this is the same value both of them print.
      const listed = fixture.value.storage
        .listVerificationRuns(fixture.value.projectId, fixture.value.taskId);
      expect(listed.map((row) => row.state)).toEqual(['CANCELLED']);
      const status = fixture.value.storage.getTask(fixture.value.projectId, fixture.value.taskId);
      expect(status?.state).toBe('EXECUTED');

      // Reclaim stays the only path that removes a copy, and the cancelled one is a failure scene:
      // retained by default, removable only when the caller says so explicitly.
      const retained = await planReclamation({
        storage: fixture.value.storage,
        runtimeHome: fixture.value.home,
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        kinds: ['VERIFICATION_COPY'],
      });
      const target = retained.targets.find((row) => row.resourceId === verificationId);
      expect(target).toMatchObject({ action: 'RETAIN', reasonCode: 'FAILURE_SCENE' });
      const included = await planReclamation({
        storage: fixture.value.storage,
        runtimeHome: fixture.value.home,
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        kinds: ['VERIFICATION_COPY'],
        includeFailureScenes: true,
      });
      expect(included.targets.find((row) => row.resourceId === verificationId))
        .toMatchObject({ action: 'RECLAIM', reasonCode: 'FAILURE_SCENE_INCLUDED' });

      // A settled run is not something a restart reconciles again: the verdict is already recorded.
      expect(reconcileInterruptedVerifications({ storage: fixture.value.storage })).toEqual([]);
      expect(fixture.value.storage.getVerificationRun(fixture.value.projectId, verificationId).state)
        .toBe('CANCELLED');
    } finally {
      await service.close();
      await runner.close();
      fixture.value.storage.close();
    }
  });

  test('never records CANCELLED for a stop it cannot confirm', async () => {
    const fixture = await executedTask({ verificationCommands: [
      { id: 'slow', argv: ['sleep', '30'], cwd: '.', timeoutSeconds: 60 },
    ] });
    const unconfirming = {
      stopOwned: async () => ({ held: true, stopped: false }),
    } as unknown as VerificationRunner;
    const service = createService(fixture, unconfirming);
    try {
      const queued = await service.startVerification({
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        commandId: crypto.randomUUID(),
        background: true,
      });
      if (!queued.background) throw new Error('background verification did not return a handle');
      const outcome = await service.cancel({
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        operationId: queued.handle.operationId,
        commandId: crypto.randomUUID(),
        actor: 'local-user',
      });
      expect(outcome.stop).toBe('UNCERTAIN');
      const run = fixture.value.storage
        .getVerificationRun(fixture.value.projectId, queued.handle.verificationId);
      // The honest state: not cancelled, not failed, still RUNNING and still owning its copy.
      expect(run.state).toBe('RUNNING');
      expect(run.outcomeCode).toBeNull();
      expect(run.endedAt).toBeNull();
      const operation = fixture.value.storage
        .getOperation(fixture.value.projectId, queued.handle.operationId);
      expect(operation.state).toBe('RECONCILE_REQUIRED');
      expect(operation.result).toMatchObject({ code: 'CANCEL_UNCONFIRMED' });
      // Reclaim refuses a run that still owns its copy, whatever the caller asked for.
      const plan = await planReclamation({
        storage: fixture.value.storage,
        runtimeHome: fixture.value.home,
        projectId: fixture.value.projectId,
        taskId: fixture.value.taskId,
        kinds: ['VERIFICATION_COPY'],
        includeFailureScenes: true,
      });
      expect(plan.targets.find((row) => row.resourceId === queued.handle.verificationId))
        .toMatchObject({ action: 'REFUSE', reasonCode: 'ACTIVE_VERIFICATION' });
    } finally {
      await service.close();
      fixture.value.storage.close();
    }
  });
});
