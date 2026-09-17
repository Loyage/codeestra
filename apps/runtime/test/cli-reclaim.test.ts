import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import { removeOwnedWorktree } from '@codeestra/git';
import {
  Phase1Database,
  agentAnswerMigration,
  agentConfigurationMigration,
  agentDisconnectMigration,
  agentObservationMigration,
  agentStartMigration,
  integrationPipelineMigration,
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
  planReclamation,
  reconcileInterruptedReclamations,
} from '../src/reclaim-service.js';
import { captureResultCommit, prepareResultCommit } from '../src/result-commit-service.js';
import { prepareTaskWorkspace } from '../src/workspace-service.js';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
  submitFixtureTaskWithoutScheduling,
} from './support/runtime-reclamation.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => { await reclaimTestResources(); });

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  // FOUNDATION-057: the shared runner refuses a non-temporary CODEESTRA_HOME (a test must never
  // reach the real Runtime home) and registers the home so teardown stops any Runtime it started,
  // including when an assertion fails before the test's own stop.
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Reclaim Test',
      GIT_AUTHOR_EMAIL: 'reclaim@example.invalid', GIT_COMMITTER_NAME: 'Reclaim Test',
      GIT_COMMITTER_EMAIL: 'reclaim@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function withStorage<T>(
  home: string,
  action: (storage: Phase1Database) => T | Promise<T>,
): Promise<T> {
  const storage = new Phase1Database(join(home, 'runtime.sqlite'));
  try {
    return await action(storage);
  } finally {
    storage.close();
  }
}

interface ReclaimFixture {
  readonly environment: Record<string, string>;
  readonly repo: string;
  readonly home: string;
  readonly projectId: string;
}

interface SeededTask {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  /** The branch the workspace row recorded (ADR-0065 D03: `task/<displayNumber>-<namingTitle>`). */
  readonly branchRef: string;
  readonly revisionId: string;
  readonly resultCommit: string;
  readonly taskVersion: number;
}

/** Temporary project trusted through the CLI runtime, with a real `dev` branch. */
async function openedProject(): Promise<ReclaimFixture> {
  const repo = temporaryDirectory('codeestra-reclaim-repo-');
  const home = realpathSync(temporaryDirectory('codeestra-reclaim-home-'));
  mkdirSync(join(repo, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repo, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repo, 'README.md'), 'fixture\n');
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'fixture']);
  await git(repo, ['branch', 'dev']);
  // ADR-0056: every dev fact comes from a second clone of the same origin that sits on
  // `dev`; the project is trusted with it explicitly.
  const environment = { CODEESTRA_HOME: home,
    CODEESTRA_SCHEDULE_TICK_MS: '600000' };
  const opened = await cli(['project', 'trust', repo], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  return { environment, repo, home, projectId: projects[0]?.id as string };
}

/**
 * Creates one Task and drives a deterministic fake Agent to a captured result commit, so the
 * fixture has exactly what reclamation must reason about: a real owned worktree, an EXECUTED Task
 * and a result commit. The Runtime is stopped first so the file database is not written twice.
 */
async function seededExecutedTask(
  fixture: ReclaimFixture,
  specification = 'Produce one artifact',
): Promise<SeededTask> {
  const created = JSON.parse((await cli(['task', 'create', fixture.projectId, specification,
    '--title', 'fixture task', '--name', 'fixture-task'],
    fixture.environment)).stdout) as { readonly id: string };
  await cli(['stop'], fixture.environment);
  submitFixtureTaskWithoutScheduling({
    home: fixture.home, projectId: fixture.projectId, taskId: created.id,
  });
  return await withStorage(fixture.home, async (storage) => {
    const adapter = new DeterministicFakeAdapter('SUCCEED', [{
      type: 'completed', eventId: 'fake-completed-1', cursor: 'cursor-1',
      outcome: 'SUCCESS', evidenceRef: 'fake-quiescence',
    }]);
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const coordinator = new AgentRuntimeCoordinator({
      storage, registry, runtimeHome: fixture.home,
    });
    const run = await coordinator.runTask({
      projectId: fixture.projectId, taskId: created.id, expectedTaskVersion: 1,
      commandId: crypto.randomUUID(), adapterId: adapter.id,
    });
    await coordinator.settle();
    await Bun.write(join(run.workspacePath, 'agent-output.txt'), 'work\n');
    const prepared = await prepareResultCommit({
      storage, projectId: fixture.projectId, taskId: created.id,
      commandId: crypto.randomUUID(), actor: 'local-user',
    });
    const captured = await captureResultCommit({
      storage, projectId: fixture.projectId, taskId: created.id,
      authorizationId: prepared.authorizationId, commandId: crypto.randomUUID(),
    });
    const task = storage.getTask(fixture.projectId, created.id);
    const candidates = storage.getReclamationCandidates(fixture.projectId, { taskId: created.id });
    return {
      taskId: created.id,
      workspaceId: candidates.workspaces[0]?.workspaceId as string,
      workspacePath: candidates.workspaces[0]?.path as string,
      branchRef: candidates.workspaces[0]?.branchRef as string,
      revisionId: task?.currentRevision.id as string,
      resultCommit: captured.resultCommit,
      taskVersion: task?.version as number,
    };
  });
}

/**
 * Makes the captured result reachable from the project's Task baseline. Since ADR-0070 D07 / S8 that
 * baseline is the managed integration ref (ADR-0074), so this is the fact the Project Service would
 * have produced by advancing that ref after a verified merge — not a merge into the user's branch.
 */
async function mergeResultIntoBaseline(fixture: ReclaimFixture, resultCommit: string): Promise<void> {
  await git(fixture.repo, ['update-ref', 'refs/codeestra/integration', resultCommit]);
}

interface ReclaimReportShape {
  readonly outcome: string;
  readonly counts: { readonly total: number; readonly reclaim: number; readonly retain: number;
    readonly refuse: number; readonly alreadyAbsent: number };
  readonly outcomeCounts: { readonly reclaimed: number; readonly alreadyAbsent: number;
    readonly retained: number; readonly refused: number; readonly failed: number };
  readonly targets: readonly { readonly kind: string; readonly action: string;
    readonly reasonCode: string }[];
}

describe('codeestra reclaim command face', () => {
  test('plans, reclaims and reports an owned Task worktree without touching the branch', async () => {
    const fixture = await openedProject();
    try {
      const task = await seededExecutedTask(fixture);
      await mergeResultIntoBaseline(fixture, task.resultCommit);
      const branchRef = task.branchRef;

      // The dry run is the same decision surface: it removes nothing and writes nothing.
      const planned = await cli(['reclaim', 'plan', '--project', fixture.projectId],
        fixture.environment);
      expect(planned.exitCode).toBe(0);
      const plan = JSON.parse(planned.stdout) as ReclaimReportShape;
      expect(plan.counts).toMatchObject({ total: 1, reclaim: 1, retain: 0 });
      expect(plan.targets[0]).toMatchObject({ kind: 'TASK_WORKTREE', action: 'RECLAIM' });
      expect(existsSync(task.workspacePath)).toBe(true);
      const recordsAfterPlan = JSON.parse((await cli(['reclaim', 'records', '--project',
        fixture.projectId], fixture.environment)).stdout) as readonly unknown[];
      expect(recordsAfterPlan).toHaveLength(0);

      const applied = await cli(['reclaim', 'apply', '--project', fixture.projectId],
        fixture.environment);
      expect(applied.exitCode).toBe(0);
      const report = JSON.parse(applied.stdout) as ReclaimReportShape;
      expect(report.outcome).toBe('SUCCEEDED');
      expect(report.outcomeCounts).toMatchObject({ reclaimed: 1, failed: 0 });
      expect(existsSync(task.workspacePath)).toBe(false);
      // ADR-0056: the worktree is registered in, and the Task branch lives in, the dev clone.
      expect(await git(fixture.repo, ['worktree', 'list', '--porcelain']))
        .not.toContain(task.workspacePath);
      // Committed work must survive: the branch is kept, and the user's own checkout is clean.
      expect(await git(fixture.repo, ['rev-parse', '--verify', branchRef])).toBe(task.resultCommit);
      expect(await git(fixture.repo, ['status', '--porcelain'])).toBe('');
      const workspaceState = await withStorage(fixture.home, (storage) =>
        storage.getReclamationCandidates(fixture.projectId).workspaces[0]?.state);
      expect(workspaceState).toBe('RELEASED');

      // The ledger is queryable and explains which evidence authorized the deletion.
      const records = JSON.parse((await cli(['reclaim', 'records', '--project', fixture.projectId],
        fixture.environment)).stdout) as readonly {
          outcome: string; reasonCode: string; evidence: Record<string, unknown>;
        }[];
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ outcome: 'RECLAIMED' });
      expect(records[0]?.evidence).toMatchObject({ registered: true, clean: true, merged: true });

      // A repeated apply is idempotent: nothing was left to remove, no new ledger row lies, and
      // "nothing was reclaimed" is reported as exit code 3 rather than as a failure.
      const repeated = await cli(['reclaim', 'apply', '--project', fixture.projectId],
        fixture.environment);
      expect(repeated.exitCode).toBe(3);
      const replay = JSON.parse(repeated.stdout) as ReclaimReportShape;
      expect(replay.outcome).toBe('SUCCEEDED');
      expect(replay.outcomeCounts).toMatchObject({ reclaimed: 0, alreadyAbsent: 1, failed: 0 });
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 120_000);

  test('retains a failure scene unless the caller explicitly includes it', async () => {
    const fixture = await openedProject();
    try {
      const task = await seededExecutedTask(fixture);
      // Without a merge, the work is not in dev: the worktree is a scene, not garbage.
      const retained = JSON.parse((await cli(['reclaim', 'plan', '--project', fixture.projectId],
        fixture.environment)).stdout) as ReclaimReportShape;
      expect(retained.counts).toMatchObject({ total: 1, retain: 1, reclaim: 0 });
      expect(retained.targets[0]).toMatchObject({ action: 'RETAIN', reasonCode: 'FAILURE_SCENE' });
      const noop = await cli(['reclaim', 'apply', '--project', fixture.projectId], fixture.environment);
      // Retaining a failure scene is a normal decision, and nothing was reclaimed: exit code 3.
      expect(noop.exitCode).toBe(3);
      const noopReport = JSON.parse(noop.stdout) as ReclaimReportShape;
      expect(noopReport.outcomeCounts).toMatchObject({ reclaimed: 0, retained: 1 });
      expect(existsSync(task.workspacePath)).toBe(true);

      const included = JSON.parse((await cli(['reclaim', 'plan', '--project', fixture.projectId,
        '--include-failure-scenes'], fixture.environment)).stdout) as ReclaimReportShape;
      expect(included.counts).toMatchObject({ reclaim: 1, retain: 0 });
      const applied = await cli(['reclaim', 'apply', '--project', fixture.projectId,
        '--include-failure-scenes'], fixture.environment);
      expect(applied.exitCode).toBe(0);
      expect(existsSync(task.workspacePath)).toBe(false);
      expect(await git(fixture.repo, ['rev-parse', '--verify', task.branchRef]))
        .toBe(task.resultCommit);
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 120_000);

  test('refuses a recorded path that is not owned by this Runtime', async () => {
    const fixture = await openedProject();
    try {
      const task = await seededExecutedTask(fixture);
      await mergeResultIntoBaseline(fixture, task.resultCommit);
      const foreign = temporaryDirectory('codeestra-reclaim-foreign-');
      await Bun.write(join(foreign, 'user-work.txt'), 'do not delete\n');
      await withStorage(fixture.home, (storage) => {
        storage.sqlite.query('UPDATE workspaces SET path=?1 WHERE id=?2')
          .run(foreign, task.workspaceId);
      });

      const planned = await cli(['reclaim', 'plan', '--project', fixture.projectId],
        fixture.environment);
      expect(planned.stderr).toBe('');
      // Nothing can be reclaimed while the recorded path is refused, which the exit code says
      // without anyone having to parse the JSON.
      expect(planned.exitCode).toBe(3);
      const plan = JSON.parse(planned.stdout) as ReclaimReportShape;
      expect(plan.counts).toMatchObject({ refuse: 1, reclaim: 0 });
      expect(plan.targets[0]).toMatchObject({ action: 'REFUSE', reasonCode: 'PATH_OUTSIDE_OWNED_ROOT' });

      const applied = await cli(['reclaim', 'apply', '--project', fixture.projectId],
        fixture.environment);
      // A refused resource is an intentional outcome, not a failure; nothing was reclaimed.
      expect(applied.exitCode).toBe(3);
      expect(existsSync(join(foreign, 'user-work.txt'))).toBe(true);
      // The real worktree was never addressed either, because the record no longer matches it.
      expect(existsSync(task.workspacePath)).toBe(true);
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 120_000);

  test('refuses to reclaim a workspace whose Execution still holds it', async () => {
    const fixture = await openedProject();
    try {
      const created = JSON.parse((await cli(['task', 'create', fixture.projectId, 'Active work',
        '--title', 'Active work', '--name', 'active-work'],
        fixture.environment)).stdout) as { readonly id: string };
      await cli(['stop'], fixture.environment);
      submitFixtureTaskWithoutScheduling({
        home: fixture.home, projectId: fixture.projectId, taskId: created.id,
      });
      let workspacePath = '';
      await withStorage(fixture.home, async (storage) => {
        const workspace = await prepareTaskWorkspace({
          storage, runtimeHome: fixture.home, commandId: crypto.randomUUID(),
          projectId: fixture.projectId, taskId: created.id, expectedTaskVersion: 1,
        });
        workspacePath = workspace.path;
        storage.reserveExecution({
          projectId: fixture.projectId, taskId: created.id, expectedTaskVersion: 1,
          workspaceId: workspace.workspaceId, executionId: crypto.randomUUID(),
          commandId: crypto.randomUUID(), payloadHash: 'reserve',
          reservationEventId: crypto.randomUUID(), taskEventId: crypto.randomUUID(),
          adapterId: 'fake', adapterVersion: '1', actor: 'local-user', createdAt: Date.now(),
        });
      });

      const plan = JSON.parse((await cli(['reclaim', 'plan', '--project', fixture.projectId,
        '--include-failure-scenes'], fixture.environment)).stdout) as ReclaimReportShape;
      expect(plan.counts).toMatchObject({ refuse: 1, reclaim: 0 });
      expect(plan.targets[0]).toMatchObject({ action: 'REFUSE', reasonCode: 'ACTIVE_EXECUTION' });
      // ADR-0065 D03: the directory is `<displayNumber>-<namingTitle>`, which is what the preparation
      // recorded; the assertion is that the live workspace is still on disk, not its exact name.
      expect(existsSync(workspacePath)).toBe(true);
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 120_000);

  test('reports stable codes and exit codes for an unknown project', async () => {
    const fixture = await openedProject();
    try {
      const unknown = '99999999-0000-4000-8000-000000000009';
      const plan = await cli(['reclaim', 'plan', '--project', unknown], fixture.environment);
      expect(plan.exitCode).toBe(1);
      expect(plan.stderr).toContain('NOT_FOUND');
      const records = await cli(['reclaim', 'records', '--project', unknown], fixture.environment);
      expect(records.exitCode).toBe(1);
      expect(records.stderr).toContain('NOT_FOUND');
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 120_000);
});

describe('reclamation schema', () => {
  test('upgrades a version 10 database additively and constrains the ledger', () => {
    const home = realpathSync(temporaryDirectory('codeestra-reclaim-migration-'));
    const path = join(home, 'legacy.sqlite');
    const legacy = new Database(path, { create: true, strict: true });
    for (const migration of [phase1Migration, agentStartMigration, agentObservationMigration,
      agentAnswerMigration, agentDisconnectMigration, taskVerificationMigration,
      workspaceRetryMigration, agentConfigurationMigration, taskControlMigration,
      integrationPipelineMigration]) {
      legacy.exec(migration);
    }
    legacy.exec('PRAGMA user_version=10');
    legacy.close();

    const upgraded = new Phase1Database(path);
    try {
      // The pinned number is the schema the migration runner targets, not this lane's version: a
      // later additive migration must not make this assertion wrong.
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBe(phase1SchemaVersion);
      expect(upgraded.sqlite.query<Record<string, unknown>, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='reclamation_records'",
      ).all()).toHaveLength(1);
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toHaveLength(0);
      const insert = upgraded.sqlite.query(`
        INSERT INTO reclamation_records(id,project_id,task_id,operation_id,command_id,kind,
          resource_id,path,resource_state,outcome,reason_code,evidence_json,created_at)
        VALUES (?1,?2,?3,?4,?5,'TASK_WORKTREE',?6,?7,'READY',?8,?9,'{}',0)
      `);
      expect(() => insert.run('a', 'b', 'c', 'd', 'e', 'f', '/tmp/x', 'INVALID', 'RECLAIMED'))
        .toThrow();
    } finally {
      upgraded.close();
    }
  });

  test('keeps the reclamation migration out of the base schema', () => {
    // Version 12 is this lane's migration; version 11 belongs to the concurrent A1 lane, so the
    // migration runner must keep both `< version` steps and run them in ascending order.
    expect(reclamationMigration).toContain('reclamation_records');
    expect(phase1Migration).not.toContain('reclamation_records');
  });
});

describe('reclamation reconcile', () => {
  test('reconciles a crashed reclamation from the actual state without deleting anything', async () => {
    const fixture = await openedProject();
    try {
      const task = await seededExecutedTask(fixture);
      await mergeResultIntoBaseline(fixture, task.resultCommit);
      const operationId = crypto.randomUUID();
      const commandId = crypto.randomUUID();
      await withStorage(fixture.home, async (storage) => {
        const plan = await planReclamation({
          storage, runtimeHome: fixture.home, projectId: fixture.projectId,
        });
        expect(plan.counts.reclaim).toBe(1);
        const target = plan.targets[0];
        storage.planReclamationOperation({
          operationId, projectId: fixture.projectId, commandId, createdAt: Date.now(),
          request: {
            payloadHash: 'reconcile-payload',
            targets: [{
              kind: target?.kind, projectId: fixture.projectId, taskId: target?.taskId,
              resourceId: target?.resourceId, path: target?.path,
              ownershipToken: target?.ownershipToken, externalRef: target?.externalRef,
              resourceState: target?.resourceState, repositoryRoot: fixture.repo,
              action: 'RECLAIM',
            }],
          },
        });
        storage.startReclamationOperation(operationId, Date.now());
        // The removal side effect happened; the Runtime then died before recording anything.
        const removal = await removeOwnedWorktree({
          // ADR-0056: the worktree is registered in the dev clone.
          repositoryRoot: fixture.repo,
          ownedRoot: join(fixture.home, 'worktrees'),
          path: target?.path as string,
          expectedBranchRef: target?.externalRef as string,
        });
        expect(removal.outcome).toBe('REMOVED');
      });

      const results = await withStorage(fixture.home, (storage) =>
        reconcileInterruptedReclamations({ storage, runtimeHome: fixture.home }));
      expect(results).toEqual([{ operationId, projectId: fixture.projectId,
        outcome: 'COMPLETED', reclaimed: 1, remaining: 0 }]);
      const records = await withStorage(fixture.home, (storage) =>
        storage.listReclamationRecords(fixture.projectId));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ outcome: 'RECLAIMED', reasonCode: 'RECONCILED_INTERRUPTED' });
      const workspaceState = await withStorage(fixture.home, (storage) =>
        storage.getReclamationCandidates(fixture.projectId).workspaces[0]?.state);
      expect(workspaceState).toBe('RELEASED');
      // The operation is finalized, so a replay is served from the record instead of acting again.
      const operation = await withStorage(fixture.home, (storage) =>
        storage.findReclamationOperation(fixture.projectId, commandId));
      expect(operation).toMatchObject({ operationState: 'SUCCEEDED' });
      expect(operation?.result).toMatchObject({ reconciled: true, reclaimed: 1, remaining: 0 });
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 120_000);
});
