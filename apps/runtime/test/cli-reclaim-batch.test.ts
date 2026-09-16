import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import {
  Phase1Database,
  agentAnswerMigration,
  agentConfigurationMigration,
  agentDisconnectMigration,
  agentObservationMigration,
  agentStartMigration,
  capacitySlotReservationMigration,
  impactAnalysisMigration,
  integrationPipelineMigration,
  operationProgressMigration,
  phase1Migration,
  phase1SchemaVersion,
  reclamationMigration,
  revisionDeliveryMigration,
  sessionHandoffMigration,
  sessionTerminalMigration,
  stablePromotionMigration,
  taskControlMigration,
  taskDependenciesMigration,
  taskVerificationMigration,
  unregisteredReclamationMigration,
  verificationProgressMigration,
  workspaceRetryMigration,
} from '@codeestra/storage';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { captureResultCommit, prepareResultCommit } from '../src/result-commit-service.js';
import {
  createFixtureTaskForExplicitStart,
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
  submitFixtureTaskWithoutScheduling,
} from './support/runtime-reclamation.js';

/**
 * Cross-project reclamation and unregistered-directory disposition (FOUNDATION-062, ADR-0037).
 *
 * Every assertion goes through the real CLI against a real Runtime in a temporary `CODEESTRA_HOME`
 * with real temporary Git repositories. The Agent is a deterministic fake, so what is proven here is
 * the Runtime's own ownership/orchestration behaviour — not a real provider integration.
 */

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => { await reclaimTestResources(); });

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  // FOUNDATION-057: the shared runner refuses a non-temporary CODEESTRA_HOME and registers the home
  // so teardown stops any Runtime this test started, including when an assertion fails first.
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Reclaim Batch Test',
      GIT_AUTHOR_EMAIL: 'reclaim-batch@example.invalid', GIT_COMMITTER_NAME: 'Reclaim Batch Test',
      GIT_COMMITTER_EMAIL: 'reclaim-batch@example.invalid' } });
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

/** One temporary Git repository with the committed policy a trusted project needs. */
async function createRepository(prefix: string): Promise<{ readonly repository: string }> {
  const repository = temporaryDirectory(prefix);
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  return { repository };
}

interface Fixture {
  readonly environment: Record<string, string>;
  readonly home: string;
  readonly repositories: readonly string[];
  readonly projectIds: readonly string[];
}

/**
 * One Runtime home with N trusted projects: the shape the cross-project batch has to handle. Two
 * repositories are two real projects, never one project listed twice. With `symlinkHome`, the home
 * itself is a symlink (the `/tmp` vs `/private/tmp` situation on macOS).
 */
async function fixtureWithProjects(
  count: number,
  options: { readonly symlinkHome?: boolean } = {},
): Promise<Fixture> {
  const homeRoot = temporaryDirectory('codeestra-reclaim-batch-home-');
  let home = realpathSync(homeRoot);
  if (options.symlinkHome === true) {
    const real = join(homeRoot, 'real-home');
    const link = join(homeRoot, 'linked-home');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    home = link;
  }
  const environment = { CODEESTRA_HOME: home,
    CODEESTRA_SCHEDULE_TICK_MS: '600000' };
  const repositories: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const { repository } = await createRepository(`codeestra-reclaim-batch-repo-${index}-`);
    repositories.push(repository);
    const opened = await cli(['project', 'trust', repository], environment);
    expect(opened.exitCode).toBe(0);
  }
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string; readonly repoRoot: string }[];
  const projectIds = repositories.map((repository) => {
    const project = projects.find((candidate) => realpathSync(candidate.repoRoot)
      === realpathSync(repository));
    expect(project).toBeDefined();
    return project?.id as string;
  });
  return { environment, home, repositories, projectIds };
}

interface SeededTask {
  readonly taskId: string;
  readonly workspacePath: string;
  /** The recorded Task branch (ADR-0065 D03): `task/<displayNumber>-<namingTitle>`. */
  readonly branchRef: string;
  readonly resultCommit: string;
}

/**
 * Creates one Task and drives the deterministic fake Agent to a captured result commit, so the
 * fixture owns a real worktree, a finished Task and a result commit. The Runtime is stopped first so
 * the file database is not written by two processes at once.
 */
async function seededExecutedTask(
  fixture: Fixture,
  projectId: string,
  specification: string,
): Promise<SeededTask> {
  const created = JSON.parse((await cli(['task', 'create', projectId, specification,
    '--title', 'fixture task', '--name', 'fixture-task'],
    fixture.environment)).stdout) as { readonly id: string };
  await cli(['stop'], fixture.environment);
  submitFixtureTaskWithoutScheduling({ home: fixture.home, projectId, taskId: created.id });
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
      projectId, taskId: created.id, expectedTaskVersion: 1,
      commandId: crypto.randomUUID(), adapterId: adapter.id,
    });
    await coordinator.settle();
    await Bun.write(join(run.workspacePath, 'agent-output.txt'), 'work\n');
    const prepared = await prepareResultCommit({
      storage, projectId, taskId: created.id,
      commandId: crypto.randomUUID(), actor: 'local-user',
    });
    const captured = await captureResultCommit({
      storage, projectId, taskId: created.id,
      authorizationId: prepared.authorizationId, commandId: crypto.randomUUID(),
    });
    // The recorded workspace row is the fact of the branch and path this Task owns.
    const candidates = storage.getReclamationCandidates(projectId, { taskId: created.id });
    const workspace = candidates.workspaces[0];
    if (workspace === undefined) throw new Error('The fixture Task has no recorded workspace');
    return { taskId: created.id, workspacePath: workspace.path, branchRef: workspace.branchRef,
      resultCommit: captured.resultCommit };
  });
}

/**
 * Creates a Task whose worktree is held by an active slot reservation. With `cancel`, the Task is
 * then cancelled through the real command face: a cancellation does not release a slot reservation
 * (ADR-0032 releases are explicit), so the workspace stays claimed by a terminal Task — exactly the
 * case the reclamation path has to refuse.
 */
async function reservedTaskWorkspace(
  fixture: Fixture,
  projectId: string,
  options: { readonly cancel?: boolean } = {},
): Promise<{ readonly taskId: string; readonly workspacePath: string;
  readonly reservationId: string; readonly reservationState: string }> {
  await cli(['stop'], fixture.environment);
  const ready = await createFixtureTaskForExplicitStart({
    home: fixture.home, environment: fixture.environment, projectId,
    specification: 'Reserved work',
  });
  const status = JSON.parse((await cli(['task', 'status', projectId, ready.taskId],
    fixture.environment)).stdout) as {
    readonly task: { readonly version: number; readonly currentRevision: { readonly id: string } };
  };
  const acquired = await cli(['scheduler', 'reservations', 'acquire', projectId, ready.taskId,
    String(status.task.version), '--revision', status.task.currentRevision.id, '--json'],
  fixture.environment);
  expect(acquired.exitCode).toBe(0);
  const reservationId = (JSON.parse(acquired.stdout) as {
    readonly reservation: { readonly reservationId: string } }).reservation.reservationId;
  const prepared = await cli(['scheduler', 'reservations', 'prepare-workspace', projectId,
    reservationId, String(status.task.version), '--json'], fixture.environment);
  expect(prepared.exitCode).toBe(0);
  const workspace = (JSON.parse(prepared.stdout) as { readonly workspace: { readonly path: string } })
    .workspace;
  expect(existsSync(workspace.path)).toBe(true);
  if (options.cancel === true) {
    const current = JSON.parse((await cli(['task', 'status', projectId, ready.taskId],
      fixture.environment)).stdout) as { readonly task: { readonly state: string;
        readonly version: number } };
    const cancelled = await cli(['task', 'cancel', projectId, ready.taskId,
      String(current.task.version)], fixture.environment);
    expect(cancelled.exitCode).toBe(0);
    const after = JSON.parse((await cli(['task', 'status', projectId, ready.taskId],
      fixture.environment)).stdout) as { readonly task: { readonly state: string } };
    expect(after.task.state).toBe('CANCELLED');
  }
  // The reservation is still doing its job: it is what keeps the workspace unavailable.
  const listed = JSON.parse((await cli(['scheduler', 'reservations', 'list', projectId, '--json'],
    fixture.environment)).stdout) as { readonly reservations: readonly {
      readonly reservationId: string; readonly state: string }[] };
  const reservation = listed.reservations.find((entry) => entry.reservationId === reservationId);
  expect(reservation?.state).not.toBe('RELEASED');
  return { taskId: ready.taskId, workspacePath: workspace.path, reservationId,
    reservationState: reservation?.state as string };
}

interface PlanGroupView {
  readonly projectId: string;
  readonly counts: { readonly total: number; readonly reclaim: number; readonly retain: number;
    readonly refuse: number; readonly alreadyAbsent: number; readonly recoveryRequired: number };
  readonly targets: readonly { readonly action: string; readonly reasonCode: string;
    readonly path: string }[];
  readonly unregistered: {
    readonly targets: readonly { readonly action: string; readonly reasonCode: string;
      readonly path: string; readonly evidence: Record<string, unknown> }[];
    readonly counts: { readonly reclaim: number; readonly retain: number;
      readonly recoveryRequired: number };
    readonly scan: { readonly processCheck: string; readonly claimedByLedger: readonly string[] };
  } | null;
}

interface BatchPlanView {
  readonly scope: string;
  readonly projectIds: readonly string[];
  readonly projects: readonly PlanGroupView[];
  readonly counts: PlanGroupView['counts'];
  readonly unregistered: { readonly scan: { readonly processCheck: string };
    readonly unattributed: readonly { readonly action: string; readonly reasonCode: string;
      readonly path: string }[] } | null;
}

interface BatchReportView extends BatchPlanView {
  readonly outcome: string;
  readonly outcomeCounts: { readonly reclaimed: number; readonly retained: number;
    readonly refused: number; readonly failed: number; readonly recoveryRequired: number };
  readonly failures: readonly { readonly projectId: string; readonly code: string }[];
  readonly operations: readonly { readonly projectId: string; readonly operationId: string;
    readonly outcome: string }[];
}

describe('codeestra reclaim: cross-project batch', () => {
  test('reclaims every trusted project in one command, grouped per project', async () => {
    const fixture = await fixtureWithProjects(2);
    const [first, second] = fixture.projectIds as [string, string];
    try {
      const reclaimable = await seededExecutedTask(fixture, first, 'Produce one artifact');
      await git(fixture.repositories[0] as string, ['merge', '--ff-only', '-q',
        reclaimable.resultCommit]);
      // The second project keeps a workspace a live reservation still holds: a refusal, not a skip.
      const reserved = await reservedTaskWorkspace(fixture, second, { cancel: true });

      const planned = await cli(['reclaim', 'plan', '--all-projects', '--json'], fixture.environment);
      expect(planned.exitCode).toBe(0);
      const plan = JSON.parse(planned.stdout) as BatchPlanView;
      expect(plan.scope).toBe('ALL_PROJECTS');
      expect(plan.projectIds).toEqual([first, second]);
      expect(plan.counts).toMatchObject({ total: 2, reclaim: 1, refuse: 1, recoveryRequired: 0 });
      const firstGroup = plan.projects.find((group) => group.projectId === first);
      const secondGroup = plan.projects.find((group) => group.projectId === second);
      expect(firstGroup?.targets[0]).toMatchObject({ action: 'RECLAIM' });
      expect(secondGroup?.targets[0]).toMatchObject({ action: 'REFUSE' });
      // Nothing was deleted by a plan, and both directories are still on disk.
      expect(existsSync(reclaimable.workspacePath)).toBe(true);
      expect(existsSync(reserved.workspacePath)).toBe(true);

      const applied = await cli(['reclaim', 'apply', '--all-projects', '--json'], fixture.environment);
      expect(applied.exitCode).toBe(0);
      const report = JSON.parse(applied.stdout) as BatchReportView;
      expect(report.outcome).toBe('SUCCEEDED');
      expect(report.failures).toEqual([]);
      expect(report.outcomeCounts).toMatchObject({ reclaimed: 1, refused: 1, failed: 0 });
      expect(report.projects).toHaveLength(2);
      expect(report.operations).toHaveLength(2);
      // The finished project is reclaimed; the busy project is untouched and still owned.
      expect(existsSync(reclaimable.workspacePath)).toBe(false);
      expect(existsSync(reserved.workspacePath)).toBe(true);
      // ADR-0066: the Task branch lives in the project folder that owns the worktree.
      expect(await git(fixture.repositories[0] as string, ['rev-parse', '--verify',
        reclaimable.branchRef])).toBe(reclaimable.resultCommit);

      // The ledger is per project and read back across projects, with the deciding evidence.
      const records = JSON.parse((await cli(['reclaim', 'records', '--all-projects', '--json'],
        fixture.environment)).stdout) as readonly {
          projectId: string; outcome: string; reasonCode: string; source: string;
          evidence: Record<string, unknown> }[];
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.outcome).sort()).toEqual(['RECLAIMED', 'REFUSED']);
      expect(records.find((record) => record.outcome === 'RECLAIMED')?.projectId).toBe(first);
      expect(records.find((record) => record.outcome === 'REFUSED')).toMatchObject({
        projectId: second, reasonCode: 'ACTIVE_RESERVATION', source: 'REGISTERED',
      });
      const firstOnly = JSON.parse((await cli(['reclaim', 'records', '--project', first, '--json'],
        fixture.environment)).stdout) as readonly { outcome: string }[];
      expect(firstOnly).toHaveLength(1);
      expect(firstOnly[0]?.outcome).toBe('RECLAIMED');
      const onlyUnregistered = JSON.parse((await cli(['reclaim', 'records', '--all-projects',
        '--source', 'UNREGISTERED_DIRECTORY', '--json'], fixture.environment)).stdout) as
        readonly unknown[];
      expect(onlyUnregistered).toHaveLength(0);
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 180_000);

  test('a batch that has nothing to reclaim exits 3 and says so', async () => {
    const fixture = await fixtureWithProjects(1);
    try {
      const planned = await cli(['reclaim', 'plan', '--all-projects', '--json'], fixture.environment);
      expect(planned.exitCode).toBe(3);
      const applied = await cli(['reclaim', 'apply', '--all-projects', '--json'], fixture.environment);
      expect(applied.exitCode).toBe(3);
      expect(JSON.parse(applied.stdout)).toMatchObject({ scope: 'ALL_PROJECTS',
        outcome: 'SUCCEEDED', outcomeCounts: { reclaimed: 0, failed: 0 } });
      // Neither an omitted scope nor a report of "nothing" invents a ledger row.
      const records = JSON.parse((await cli(['reclaim', 'records', '--all-projects', '--json'],
        fixture.environment)).stdout) as readonly unknown[];
      expect(records).toHaveLength(0);
      // Naming both scopes, or a Task without its project, is refused instead of guessed at. The
      // CLI rejects the ambiguous scope locally (exit 2, usage) without inventing a meaning.
      const conflicting = await cli(['reclaim', 'plan', '--project', fixture.projectIds[0] as string,
        '--all-projects'], fixture.environment);
      expect(conflicting.exitCode).toBe(2);
      expect(conflicting.stdout).toBe('');
      const taskWithoutProject = await cli(['reclaim', 'plan', '--task', crypto.randomUUID()],
        fixture.environment);
      expect(taskWithoutProject.exitCode).toBe(2);
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 180_000);
});

describe('codeestra reclaim: unregistered directories', () => {
  test('lists an unregistered directory with its evidence, retains it by default, and removes it only when selected', async () => {
    const fixture = await fixtureWithProjects(1);
    const [projectId] = fixture.projectIds as [string];
    // ADR-0056: a Runtime-owned worktree (and its Task branch) is registered in, and lives in, the
    // project's dev clone; the main checkout is not the repository a reclamation verifies against.
    const repository = fixture.repositories[0] as string;
    try {
      const head = await git(repository, ['rev-parse', 'HEAD']);
      // A real worktree on a real branch that no ledger row claims: Git registers it, Codeestra
      // does not. Removing it must keep the branch.
      const strayTaskId = crypto.randomUUID();
      const strayPath = join(fixture.home, 'worktrees', projectId, strayTaskId);
      await git(repository, ['worktree', 'add', '-q', '-b', `task/${strayTaskId}`, strayPath, head]);

      const planned = await cli(['reclaim', 'plan', '--project', projectId, '--unregistered',
        '--json'], fixture.environment);
      // A retained unregistered directory is not a reclaimable target, so this exits 3.
      expect(planned.exitCode).toBe(3);
      const plan = JSON.parse(planned.stdout) as PlanGroupView;
      expect(plan.unregistered?.scan.processCheck).toBe('AVAILABLE');
      const candidate = plan.unregistered?.targets.find((entry) => entry.path === strayPath);
      expect(candidate).toMatchObject({
        action: 'RETAIN', reasonCode: 'UNREGISTERED_REQUIRES_EXPLICIT_SELECTION',
      });
      // The judging evidence is in the output, not in prose: layout, home, marker and ledger.
      expect(candidate?.evidence).toMatchObject({
        runtimeHome: realpathSync(fixture.home),
        layout: '<home>/worktrees/<project-id>/<resource-id>',
        projectTrusted: true,
        gitMarker: 'FILE',
        ledgerClaim: null,
        registered: true,
        clean: true,
        processCheck: 'AVAILABLE',
        explicitlySelected: false,
      });

      const noop = await cli(['reclaim', 'apply', '--project', projectId, '--unregistered', '--json'],
        fixture.environment);
      expect(noop.exitCode).toBe(3);
      expect(existsSync(strayPath)).toBe(true);
      const retained = JSON.parse((await cli(['reclaim', 'records', '--project', projectId,
        '--source', 'UNREGISTERED_DIRECTORY', '--json'], fixture.environment)).stdout) as readonly {
          outcome: string; reasonCode: string; kind: string; source: string;
          resourceId: string }[];
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatchObject({
        outcome: 'RETAINED', reasonCode: 'UNREGISTERED_REQUIRES_EXPLICIT_SELECTION',
        kind: 'UNREGISTERED_DIRECTORY', source: 'UNREGISTERED_DIRECTORY', resourceId: strayPath,
      });

      // The explicit selection is what authorises the deletion - no confirmation step is added.
      const applied = await cli(['reclaim', 'apply', '--project', projectId, '--unregistered',
        '--remove-unregistered', strayPath, '--json'], fixture.environment);
      expect(applied.exitCode).toBe(0);
      const report = JSON.parse(applied.stdout) as BatchReportView & {
        readonly records: readonly { readonly source: string; readonly path: string;
          readonly outcome: string }[] };
      expect(report.outcomeCounts).toMatchObject({ reclaimed: 1, failed: 0 });
      expect(existsSync(strayPath)).toBe(false);
      expect(report.records.some((record) => record.path === strayPath
        && record.source === 'UNREGISTERED_DIRECTORY' && record.outcome === 'RECLAIMED')).toBe(true);
      // Committed work survives: the branch is never deleted, only the checkout.
      expect(await git(repository, ['rev-parse', '--verify', `refs/heads/task/${strayTaskId}`]))
        .toBe(head);

      // Idempotent: the directory is gone, so a second run neither reclaims it again nor adds a
      // second reclamation record for the same path.
      const repeated = await cli(['reclaim', 'apply', '--project', projectId, '--unregistered',
        '--remove-unregistered', strayPath, '--json'], fixture.environment);
      expect(repeated.exitCode).toBe(3);
      const after = JSON.parse((await cli(['reclaim', 'records', '--project', projectId,
        '--source', 'UNREGISTERED_DIRECTORY', '--json'], fixture.environment)).stdout) as readonly {
          path: string; outcome: string }[];
      expect(after.filter((record) => record.path === strayPath
        && record.outcome === 'RECLAIMED')).toHaveLength(1);
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 180_000);

  test('leaves a directory whose ownership cannot be verified, records the reason, and never deletes it', async () => {
    const fixture = await fixtureWithProjects(1);
    const [projectId] = fixture.projectIds as [string];
    const repository = fixture.repositories[0] as string;
    try {
      const head = await git(repository, ['rev-parse', 'HEAD']);
      // (a) A valid worktree whose project segment is not a project of this Runtime.
      const unknownProject = crypto.randomUUID();
      const unknownPath = join(fixture.home, 'worktrees', unknownProject, crypto.randomUUID());
      await git(repository, ['worktree', 'add', '-q', '--detach', unknownPath, head]);
      // (b) A directory under a trusted project that carries no Git marker at all.
      const unmarkedPath = join(fixture.home, 'worktrees', projectId, crypto.randomUUID());
      mkdirSync(unmarkedPath, { recursive: true });
      await Bun.write(join(unmarkedPath, 'notes.txt'), 'not a worktree\n');

      const before = { unknown: existsSync(unknownPath), unmarked: existsSync(unmarkedPath) };

      // Both are selected explicitly, so nothing about the selection is what stops the deletion.
      const applied = await cli(['reclaim', 'apply', '--all-projects', '--unregistered',
        '--remove-unregistered', unknownPath, '--remove-unregistered', unmarkedPath, '--json'],
      fixture.environment);
      // Nothing could be reclaimed, which is not a failure but must not look like success either.
      expect(applied.exitCode).toBe(3);
      const report = JSON.parse(applied.stdout) as BatchReportView;
      expect(report.outcome).toBe('SUCCEEDED');
      expect(report.outcomeCounts).toMatchObject({ reclaimed: 0, recoveryRequired: 1, failed: 0 });
      // The unattributable directory is reported as RECOVERY_REQUIRED, not silently dropped.
      expect(report.unregistered?.unattributed).toHaveLength(1);
      expect(report.unregistered?.unattributed[0]).toMatchObject({
        path: unknownPath, action: 'RECOVERY_REQUIRED', reasonCode: 'PROJECT_NOT_TRUSTED',
      });
      // The attributable one is in its project's group, also RECOVERY_REQUIRED.
      const group = report.projects.find((entry) => entry.projectId === projectId);
      expect(group?.unregistered?.targets.find((entry) => entry.path === unmarkedPath))
        .toMatchObject({ action: 'RECOVERY_REQUIRED', reasonCode: 'NOT_A_CODEESTRA_WORKTREE' });

      // ls before/after: both directories are still exactly where they were.
      expect(existsSync(unknownPath)).toBe(before.unknown);
      expect(existsSync(unmarkedPath)).toBe(before.unmarked);
      expect(existsSync(join(unmarkedPath, 'notes.txt'))).toBe(true);

      const records = JSON.parse((await cli(['reclaim', 'records', '--project', projectId,
        '--source', 'UNREGISTERED_DIRECTORY', '--json'], fixture.environment)).stdout) as readonly {
          path: string; outcome: string; reasonCode: string; detail: string }[];
      // Only the attributable refusal can be filed in a project's ledger; the ledger is
      // project-scoped and inventing a project for the other directory is exactly the false
      // attribution this path must not make (documented in ADR-0037).
      expect(records.map((record) => record.path)).toEqual([unmarkedPath]);
      expect(records[0]).toMatchObject({ outcome: 'RECOVERY_REQUIRED',
        reasonCode: 'NOT_A_CODEESTRA_WORKTREE' });
      expect(records[0]?.detail.length).toBeGreaterThan(0);
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 180_000);

  test('removes an unregistered clone that Git does not register, and refuses a scan root outside the home', async () => {
    const fixture = await fixtureWithProjects(1);
    const [projectId] = fixture.projectIds as [string];
    const repository = fixture.repositories[0] as string;
    try {
      // A full checkout dropped into the layout root: readable by Git, registered by nothing.
      const clonePath = join(fixture.home, 'verifications', projectId, crypto.randomUUID());
      mkdirSync(join(fixture.home, 'verifications', projectId), { recursive: true });
      await git(process.cwd(), ['clone', '-q', '--no-hardlinks', repository, clonePath]);
      expect(existsSync(join(clonePath, '.git'))).toBe(true);

      const scanned = await cli(['reclaim', 'plan', '--project', projectId, '--unregistered',
        '--scan-root', join(fixture.home, 'verifications'), '--json'], fixture.environment);
      expect(scanned.exitCode).toBe(3);
      const plan = JSON.parse(scanned.stdout) as PlanGroupView;
      const candidate = plan.unregistered?.targets.find((entry) => entry.path === clonePath);
      expect(candidate).toMatchObject({ action: 'RETAIN' });
      expect(candidate?.evidence).toMatchObject({ gitMarker: 'DIRECTORY', registered: false });

      const applied = await cli(['reclaim', 'apply', '--project', projectId, '--unregistered',
        '--remove-unregistered', clonePath, '--json'], fixture.environment);
      expect(applied.exitCode).toBe(0);
      expect(JSON.parse(applied.stdout)).toMatchObject({
        outcomeCounts: { reclaimed: 1, failed: 0 },
      });
      expect(existsSync(clonePath)).toBe(false);

      // A scan root outside the Runtime home is refused: the scan is bounded by construction.
      const escaped = await cli(['reclaim', 'plan', '--all-projects', '--unregistered',
        '--scan-root', tmpdir(), '--json'], fixture.environment);
      expect(escaped.exitCode).toBe(1);
      expect(escaped.stderr).toContain('SCAN_ROOT_OUTSIDE_HOME');
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 180_000);

  test('does not mistake a ledger-claimed worktree for an unregistered directory when the home is reached through a symlink', async () => {
    // Regression from the end-to-end run: `CODEESTRA_HOME` may be a path with a symlinked ancestor
    // (`/tmp` is `/private/tmp` on macOS), while recorded resource paths are canonical. A scan that
    // compared its own spelling against the ledger would call every registered worktree unregistered
    // and could then delete one through the unregistered path.
    const fixture = await fixtureWithProjects(1, { symlinkHome: true });
    const [projectId] = fixture.projectIds as [string];
    try {
      const task = await seededExecutedTask(fixture, projectId, 'Produce one artifact');
      await git(fixture.repositories[0] as string, ['merge', '--ff-only', '-q', task.resultCommit]);
      const planned = await cli(['reclaim', 'plan', '--all-projects', '--unregistered', '--json'],
        fixture.environment);
      const plan = JSON.parse(planned.stdout) as BatchPlanView;
      const group = plan.projects.find((entry) => entry.projectId === projectId);
      expect(group?.unregistered?.targets ?? []).toHaveLength(0);
      expect(group?.unregistered?.scan.claimedByLedger)
        .toContain(realpathSync(task.workspacePath));
      expect(group?.targets[0]).toMatchObject({ action: 'RECLAIM' });

      // A selection spelled the way a person would (through the symlinked home) still matches the
      // canonical record, so it stays the *registered* target instead of becoming an unregistered
      // one that could be removed by an unverified path.
      const spelledThroughLink = join(fixture.home, 'worktrees', projectId,
        basename(task.workspacePath));
      expect(realpathSync(spelledThroughLink)).toBe(realpathSync(task.workspacePath));
      const selected = await cli(['reclaim', 'apply', '--project', projectId, '--unregistered',
        '--remove-unregistered', spelledThroughLink, '--json'], fixture.environment);
      expect(selected.exitCode).toBe(0);
      expect(JSON.parse(selected.stdout)).toMatchObject({
        outcomeCounts: { reclaimed: 1, recoveryRequired: 0, failed: 0 },
      });
      expect(existsSync(task.workspacePath)).toBe(false);
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 180_000);

  test('refuses an unregistered directory a running process is working in', async () => {
    const fixture = await fixtureWithProjects(1);
    const [projectId] = fixture.projectIds as [string];
    const repository = fixture.repositories[0] as string;
    let worker: ReturnType<typeof Bun.spawn> | null = null;
    try {
      const head = await git(repository, ['rev-parse', 'HEAD']);
      const busy = join(fixture.home, 'worktrees', projectId, crypto.randomUUID());
      await git(repository, ['worktree', 'add', '-q', '--detach', busy, head]);
      // A process that really works inside the directory (this test's own child; it is killed in
      // the `finally`, and it is never something the Runtime signalled).
      worker = Bun.spawn({ cmd: ['sleep', '60'], cwd: busy, stdout: 'ignore', stderr: 'ignore' });
      const canonical = realpathSync(busy);
      let report: PlanGroupView | undefined;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        // The process table read is a snapshot; poll briefly until this child is visible in it.
        const planned = await cli(['reclaim', 'plan', '--all-projects', '--unregistered', '--json'],
          fixture.environment);
        report = (JSON.parse(planned.stdout) as BatchPlanView).projects
          .find((entry) => entry.projectId === projectId);
        if (report?.unregistered?.targets.some((entry) => entry.path === canonical
          && entry.reasonCode === 'PROCESS_IN_USE') === true) break;
        await Bun.sleep(300);
      }
      const busyTarget = report?.unregistered?.targets.find((entry) => entry.path === canonical);
      expect(busyTarget).toMatchObject({ action: 'RECOVERY_REQUIRED', reasonCode: 'PROCESS_IN_USE' });
      expect(busyTarget?.evidence['processesInUse']).toContain(canonical);

      // Naming it explicitly does not help: the refusal is repeated right before the removal.
      const applied = await cli(['reclaim', 'apply', '--all-projects', '--unregistered',
        '--remove-unregistered', busy, '--json'], fixture.environment);
      expect(applied.exitCode).toBe(3);
      expect(existsSync(busy)).toBe(true);
      const records = JSON.parse((await cli(['reclaim', 'records', '--project', projectId,
        '--source', 'UNREGISTERED_DIRECTORY', '--json'], fixture.environment)).stdout) as readonly {
          path: string; outcome: string; reasonCode: string }[];
      expect(records.find((record) => record.path === canonical)).toMatchObject({
        outcome: 'RECOVERY_REQUIRED', reasonCode: 'PROCESS_IN_USE',
      });
    } finally {
      worker?.kill();
      await cli(['stop'], fixture.environment);
    }
  }, 180_000);

  test('never reclaims a workspace an active reservation still holds', async () => {
    const fixture = await fixtureWithProjects(1);
    const [projectId] = fixture.projectIds as [string];
    try {
      const reserved = await reservedTaskWorkspace(fixture, projectId, { cancel: true });
      const planned = await cli(['reclaim', 'plan', '--project', projectId,
        '--include-failure-scenes', '--json'], fixture.environment);
      const plan = JSON.parse(planned.stdout) as PlanGroupView;
      expect(plan.counts).toMatchObject({ refuse: 1, reclaim: 0 });
      expect(plan.targets[0]).toMatchObject({ action: 'REFUSE', reasonCode: 'ACTIVE_RESERVATION' });
      // Even an explicit failure-scene run and a real removal attempt leave it alone.
      const applied = await cli(['reclaim', 'apply', '--project', projectId,
        '--include-failure-scenes', '--json'], fixture.environment);
      expect(applied.exitCode).toBe(3);
      expect(existsSync(reserved.workspacePath)).toBe(true);
      const records = JSON.parse((await cli(['reclaim', 'records', '--project', projectId, '--json'],
        fixture.environment)).stdout) as readonly { outcome: string; reasonCode: string }[];
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ outcome: 'REFUSED', reasonCode: 'ACTIVE_RESERVATION' });
      // The refusal names the reservation that still claims the workspace.
      expect(JSON.stringify(records[0])).toContain(reserved.reservationId);
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 180_000);

  test('reads the ledger back by source and by time', async () => {
    const fixture = await fixtureWithProjects(1);
    const [projectId] = fixture.projectIds as [string];
    try {
      const task = await seededExecutedTask(fixture, projectId, 'Produce one artifact');
      await git(fixture.repositories[0] as string, ['merge', '--ff-only', '-q', task.resultCommit]);
      const applied = await cli(['reclaim', 'apply', '--project', projectId, '--json'],
        fixture.environment);
      expect(applied.exitCode).toBe(0);
      const now = Date.now();
      const registered = JSON.parse((await cli(['reclaim', 'records', '--project', projectId,
        '--source', 'REGISTERED', '--since', String(now - 600_000), '--until', String(now + 60_000),
        '--json'], fixture.environment)).stdout) as readonly unknown[];
      expect(registered).toHaveLength(1);
      // A window before this run holds nothing: the filter is applied to the recorded time.
      const tooEarly = JSON.parse((await cli(['reclaim', 'records', '--project', projectId,
        '--since', String(now - 600_000), '--until', String(now - 300_000), '--json'],
      fixture.environment)).stdout) as readonly unknown[];
      expect(tooEarly).toHaveLength(0);
      const unregistered = JSON.parse((await cli(['reclaim', 'records', '--project', projectId,
        '--source', 'UNREGISTERED_DIRECTORY', '--json'], fixture.environment)).stdout) as
        readonly unknown[];
      expect(unregistered).toHaveLength(0);
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 180_000);
});

describe('unregistered reclamation schema', () => {
  test('upgrades a version 21 database additively and keeps the existing ledger rows', () => {
    const home = realpathSync(temporaryDirectory('codeestra-reclaim-v24-'));
    const path = join(home, 'legacy.sqlite');
    const legacy = new Database(path, { create: true, strict: true });
    for (const migration of [phase1Migration, agentStartMigration, agentObservationMigration,
      agentAnswerMigration, agentDisconnectMigration, taskVerificationMigration,
      workspaceRetryMigration, agentConfigurationMigration, taskControlMigration,
      integrationPipelineMigration, operationProgressMigration, reclamationMigration,
      stablePromotionMigration, sessionHandoffMigration, taskDependenciesMigration,
      verificationProgressMigration, sessionTerminalMigration, revisionDeliveryMigration,
      impactAnalysisMigration, capacitySlotReservationMigration]) {
      legacy.exec(migration);
    }
    legacy.exec('PRAGMA user_version=21');
    // An existing ledger row must survive the rebuild with its identity and evidence intact.
    legacy.query(`INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,
      object_format,policy_version,created_at)
      VALUES ('p','kept','/tmp/r','/tmp/g','refs/heads/main','sha1',1,1)`).run();
    legacy.query(`INSERT INTO task_revisions(id,task_id,number,specification,constraints_json,
      actor,reason,created_at) VALUES ('rev','t',1,'spec','[]','test','test',1)`).run();
    legacy.query(`INSERT INTO tasks(id,project_id,display_number,kind,current_revision_id,state,
      created_at,updated_at) VALUES ('t','p',1,'DEVELOPMENT','rev','EXECUTED',1,1)`).run();
    legacy.query(`INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,
      request_json,created_at,updated_at)
      VALUES ('op','p','RECLAIM_RESOURCES','p','cmd','SUCCEEDED','{}',1,1)`).run();
    legacy.query(`INSERT INTO reclamation_records(id,project_id,task_id,operation_id,command_id,kind,
      resource_id,path,resource_state,outcome,reason_code,evidence_json,created_at)
      VALUES ('r1','p','t','op','cmd','TASK_WORKTREE','w','/tmp/w','READY','RECLAIMED','X','{}',1)`).run();
    legacy.close();

    const upgraded = new Phase1Database(path);
    try {
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBe(phase1SchemaVersion);
      // The claim is that the upgrade reaches the *current* schema, not that this
      // lane is last: Wave I carries FOUNDATION-065 (v25) and FOUNDATION-067 (v26),
      // so the constant is 26 while the table this file checks may be older.
      expect(phase1SchemaVersion).toBeGreaterThanOrEqual(24);
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toHaveLength(0);
      const kept = upgraded.sqlite.query<{ id: string; source: string; task_id: string }, []>(
        'SELECT id,source,task_id FROM reclamation_records',
      ).all();
      expect(kept).toEqual([{ id: 'r1', source: 'REGISTERED', task_id: 't' }]);
      const indexes = upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='reclamation_records'",
      ).all().map((row) => row.name);
      expect(indexes).toContain('reclamation_records_by_source');
      expect(indexes).toContain('one_reclamation_record_per_resource');
      // The new values are constrained rather than trusted: an unknown source or outcome is refused.
      const insert = upgraded.sqlite.query(`
        INSERT INTO reclamation_records(id,project_id,task_id,operation_id,command_id,source,kind,
          resource_id,path,resource_state,outcome,reason_code,evidence_json,created_at)
        VALUES (?1,'p',NULL,'op','cmd2',?2,'UNREGISTERED_DIRECTORY','/tmp/x','/tmp/x','UNREGISTERED',
          ?3,'X','{}',1)
      `);
      expect(() => insert.run('bad-source', 'SOMETHING_ELSE', 'RETAINED')).toThrow();
      expect(() => insert.run('bad-outcome', 'UNREGISTERED_DIRECTORY', 'SOMETHING_ELSE')).toThrow();
      // A null Task is exactly what an unregistered directory records when it has no Task.
      insert.run('ok', 'UNREGISTERED_DIRECTORY', 'RECOVERY_REQUIRED');
      expect(upgraded.sqlite.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM reclamation_records WHERE task_id IS NULL",
      ).get()?.count).toBe(1);
    } finally {
      upgraded.close();
    }
  });

  test('keeps the unregistered migration out of the base schema', () => {
    // Version 24 is this lane's step; 22 and 23 belong to parallel lanes, and 16 stays unused.
    expect(unregisteredReclamationMigration).toContain('reclamation_records_v24');
    expect(unregisteredReclamationMigration).toContain('source TEXT');
    expect(phase1Migration).not.toContain('unregistered');
    // "resource" contains "source", so the older migration is checked for the column itself.
    expect(reclamationMigration).not.toContain('source TEXT');
  });

  test('does not touch a database that is already at the current version', () => {
    const home = realpathSync(temporaryDirectory('codeestra-reclaim-v24-noop-'));
    const path = join(home, 'current.sqlite');
    const first = new Phase1Database(path);
    first.close();
    // Re-opening a database already stamped with the current version must not re-run the rebuild.
    const second = new Phase1Database(path);
    try {
      expect(second.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBe(phase1SchemaVersion);
      expect(second.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toHaveLength(0);
    } finally {
      second.close();
    }
  });
});
