import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import { Phase1Database } from '@codeestra/storage';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { captureResultCommit, prepareResultCommit } from '../src/result-commit-service.js';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
  submitFixtureTaskWithoutScheduling,
} from './support/runtime-reclamation.js';

/**
 * `task purge` (ADR-0058) driven only through the CLI and the Runtime command face (ADR-0008): one
 * happy path that proves an owned worktree and branch really disappear together with the Task, and
 * one refusal that proves the confirmation bit is load-bearing.
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
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Purge Test',
      GIT_AUTHOR_EMAIL: 'purge@example.invalid', GIT_COMMITTER_NAME: 'Purge Test',
      GIT_COMMITTER_EMAIL: 'purge@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, 'show-ref', '--verify', '--quiet', ref],
    stdout: 'ignore', stderr: 'ignore', env: { PATH: Bun.env.PATH ?? '' } });
  return (await child.exited) === 0;
}

interface PurgeFixture {
  readonly environment: Record<string, string>;
  readonly repo: string;
  readonly home: string;
  readonly projectId: string;
}

async function openedProject(): Promise<PurgeFixture> {
  const repo = temporaryDirectory('codeestra-purge-repo-');
  const home = realpathSync(temporaryDirectory('codeestra-purge-home-'));
  const assets = temporaryDirectory('codeestra-purge-assets-');
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repo, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repo, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repo, 'README.md'), 'fixture\n');
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'fixture']);
  await git(repo, ['branch', 'dev']);
  const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets,
    CODEESTRA_SCHEDULE_TICK_MS: '600000' };
  const opened = await cli(['open', repo, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  return { environment, repo, home, projectId: projects[0]?.id as string };
}

interface SeededTask {
  readonly taskId: string;
  readonly workspacePath: string;
  readonly branchRef: string;
  readonly taskVersion: number;
}

/**
 * One Task driven by the deterministic fake Agent to a captured result commit, so the fixture owns a
 * real worktree and a real `task/<id>` branch — the two things a purge must destroy.
 */
async function seededExecutedTask(
  fixture: PurgeFixture,
  specification = 'Produce one artifact',
): Promise<SeededTask> {
  const created = JSON.parse((await cli(['task', 'create', fixture.projectId, specification],
    fixture.environment)).stdout) as { readonly id: string };
  await cli(['stop'], fixture.environment);
  submitFixtureTaskWithoutScheduling({
    home: fixture.home, projectId: fixture.projectId, taskId: created.id,
  });
  const storage = new Phase1Database(join(fixture.home, 'runtime.sqlite'));
  try {
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
    await captureResultCommit({
      storage, projectId: fixture.projectId, taskId: created.id,
      authorizationId: prepared.authorizationId, commandId: crypto.randomUUID(),
    });
    const task = storage.getTask(fixture.projectId, created.id);
    return {
      taskId: created.id,
      workspacePath: run.workspacePath,
      branchRef: `refs/heads/task/${created.id}`,
      taskVersion: task?.version as number,
    };
  } finally {
    storage.close();
  }
}

interface PurgeView {
  readonly taskId: string;
  readonly state: string;
  readonly replayed: boolean;
  readonly stop: { readonly state: string; readonly stop: string } | null;
  readonly plan: { readonly worktrees: number; readonly verificationCopies: number;
    readonly branches: number };
  readonly branchFacts: readonly { readonly branchRef: string; readonly tipCommit: string | null;
    readonly deleted: boolean }[];
  readonly rowsDeleted: Readonly<Record<string, number>>;
  readonly dependencyEdgesRemoved: number;
  /** The `--force` facts (ADR-0058 D09); null for an ordinary deletion. */
  readonly forced: {
    readonly bypassed: readonly { readonly code: string; readonly detail: string }[];
    readonly termination: { readonly attempted: boolean; readonly signalsSent: number;
      readonly terminated: boolean; readonly detail: string } | null;
  } | null;
}

describe('codeestra task purge command face', () => {
  test('deletes a Task, its owned worktree and its branch, and records what it destroyed', async () => {
    const fixture = await openedProject();
    try {
      const task = await seededExecutedTask(fixture);
      expect(existsSync(task.workspacePath)).toBe(true);
      expect(await refExists(fixture.repo, task.branchRef)).toBe(true);

      const purged = await cli(['task', 'purge', fixture.projectId, task.taskId,
        String(task.taskVersion), '--yes', '--reason', 'no longer wanted'], fixture.environment);
      expect(purged.exitCode).toBe(0);
      const view = JSON.parse(purged.stdout) as PurgeView;
      // EXECUTED is not terminal, so the purge cancelled it through the ordinary cooperative stop.
      expect(view.stop).toMatchObject({ state: 'CANCELLED', stop: 'TERMINAL' });
      expect(view.state).toBe('CANCELLED');
      expect(view.replayed).toBe(false);
      expect(view.plan).toMatchObject({ worktrees: 1, branches: 1 });
      expect(view.branchFacts[0]?.branchRef).toBe(task.branchRef);
      expect(view.branchFacts[0]?.deleted).toBe(true);
      // The tip the branch pointed at is recorded: the branch itself is gone, the fact is not.
      expect(view.branchFacts[0]?.tipCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(view.rowsDeleted['task_revisions']).toBeGreaterThan(0);
      expect(view.rowsDeleted['executions']).toBeGreaterThan(0);
      expect(view.rowsDeleted['workspaces']).toBe(1);
      expect(view.rowsDeleted['tasks']).toBe(1);

      // Both halves really happened: the directory and the branch are gone, and the Task is gone
      // from every read face rather than merely hidden.
      expect(existsSync(task.workspacePath)).toBe(false);
      expect(await refExists(fixture.repo, task.branchRef)).toBe(false);
      const listed = JSON.parse((await cli(['task', 'list', fixture.projectId, '--all'],
        fixture.environment)).stdout) as readonly { id: string }[];
      expect(listed.map((entry) => entry.id)).not.toContain(task.taskId);
      const status = await cli(['task', 'status', fixture.projectId, task.taskId],
        fixture.environment);
      expect(status.exitCode).toBe(1);
      expect(status.stderr).toContain('NOT_FOUND');

      // The audit event survives the Task it names, so "this Task existed and was deleted by hand"
      // is still readable in the event log after every other row is gone.
      await cli(['stop'], fixture.environment);
      const storage = new Phase1Database(join(fixture.home, 'runtime.sqlite'));
      try {
        const events = storage.sqlite.query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM domain_events WHERE event_type='TaskPurged' AND aggregate_id=?1")
          .get(task.taskId);
        expect(events?.count).toBe(1);
        // The append-only guards are back in place the moment the purge transaction commits:
        // "a purge may delete a revision" must not quietly become "anything may".
        const triggers = storage.sqlite.query<{ name: string }, []>(`
          SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%no_delete'
          AND tbl_name IN ('task_revisions','impact_snapshots','impact_assessments',
            'targeted_test_plans','execution_knowledge_snapshots')
        `).all().map((row) => row.name).sort();
        expect(triggers).toEqual([
          'execution_knowledge_snapshots_no_delete', 'impact_assessments_no_delete',
          'impact_snapshots_no_delete', 'targeted_test_plans_no_delete',
          'task_revisions_no_delete',
        ]);
      } finally {
        storage.close();
      }
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 120_000);

  test('refuses to purge without --yes and changes nothing', async () => {
    const fixture = await openedProject();
    try {
      const task = await seededExecutedTask(fixture);
      const refused = await cli(['task', 'purge', fixture.projectId, task.taskId,
        String(task.taskVersion)], fixture.environment);
      expect(refused.exitCode).toBe(2);
      expect(refused.stderr).toContain('--yes');
      expect(existsSync(task.workspacePath)).toBe(true);
      expect(await refExists(fixture.repo, task.branchRef)).toBe(true);

      const status = JSON.parse((await cli(['task', 'status', fixture.projectId, task.taskId],
        fixture.environment)).stdout) as { readonly task: { readonly state: string } };
      expect(status.task.state).toBe('EXECUTED');
    } finally {
      await cli(['stop'], fixture.environment);
    }
  }, 120_000);

});
