import { afterEach, describe, expect, test } from 'bun:test';
import type { Phase1Database } from '@codeestra/storage';
import {
  createAgentFixture,
  cleanupTemporaryDirectories,
  git,
  type AgentFixture,
} from './support/agent-fixture.js';
import {
  SchedulerError,
  assertDependenciesSatisfied,
  assertTaskRunnable,
  inspectTaskDependencies,
  reconcileDependentTasks,
  reconcileTaskDependencyState,
} from '../src/scheduler.js';

afterEach(() => { cleanupTemporaryDirectories(); });

/** Asserts the stable error code, not the human-readable message. */
async function expectCode(action: Promise<unknown> | (() => unknown), code: string): Promise<void> {
  try {
    await (typeof action === 'function' ? action() : action);
  } catch (error) {
    expect((error as { readonly code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected the call to fail with ${code}`);
}

/** Creates a DRAFT Task and submits it, returning both the Task and its first revision ID. */
function createSubmittedTask(
  storage: Phase1Database,
  projectId: string,
  taskId: string,
  revisionId: string,
  specification: string,
): void {
  storage.createTask({
    projectId,
    commandId: `create-${taskId}`,
    payloadHash: `create-${taskId}`,
    intentId: `intent-${taskId}`,
    taskId,
    revisionId,
    intentEventId: `intent-event-${taskId}`,
    taskEventId: `task-event-${taskId}`,
    specification,
    constraints: [],
    kind: 'DEVELOPMENT',
    actor: 'local-user',
    createdAt: 10,
  });
  storage.submitTask({
    projectId,
    taskId,
    expectedVersion: 0,
    commandId: `submit-${taskId}`,
    payloadHash: `submit-${taskId}`,
    eventId: `submit-event-${taskId}`,
    actor: 'local-user',
    submittedAt: 11,
  });
}

/**
 * Records the integration fact for one upstream revision: the Execution/Workspace rows the item
 * references, the IntegrationBatch, and its item. This is the same shape `task.integrate` writes.
 */
function recordIntegrationFact(
  storage: Phase1Database,
  input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly revisionId: string;
    readonly executionId: string;
    readonly batchId: string;
    readonly integratedCommit: string;
    readonly devCommit: string;
  },
): void {
  const db = storage.sqlite;
  db.query(`INSERT INTO workspaces
    (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
    VALUES (?1,?2,?3,?4,?5,?6,'RETAINED',3)`).run(
    `workspace-${input.executionId}`, input.taskId, `refs/heads/task/${input.taskId}`,
    `/work/${input.executionId}`, `owner-${input.executionId}`, input.integratedCommit);
  db.query(`INSERT INTO executions
    (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,adapter_id,
     adapter_version,state,resource_held,base_commit,result_commit,started_at,ended_at)
    VALUES (?1,?2,1,?3,?3,?4,'pi','1','SUCCEEDED',0,?5,?6,4,5)`).run(
    input.executionId, input.taskId, input.revisionId, `workspace-${input.executionId}`,
    input.integratedCommit, input.integratedCommit);
  db.query(`INSERT INTO integration_batches
    (id,project_id,dev_ref,dev_commit,state,worktree_ownership_token,integrated_commit,created_at)
    VALUES (?1,?2,'refs/heads/dev',?3,'INTEGRATED',?4,?5,20)`).run(
    input.batchId, input.projectId, input.devCommit, `owner-${input.batchId}`, input.integratedCommit);
  db.query(`INSERT INTO integration_batch_items
    (batch_id,project_id,task_id,revision_id,execution_id,candidate_commit,dev_commit,state,
     integrated_commit,created_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,'INTEGRATED',?6,20)`).run(
    input.batchId, input.projectId, input.taskId, input.revisionId, input.executionId,
    input.integratedCommit, input.devCommit);
}

/** A real commit object on top of `parent`, so `dev` can be moved with real reachability. */
async function commitTree(repo: string, parent: string, message: string): Promise<string> {
  const tree = await git(repo, ['rev-parse', `${parent}^{tree}`]);
  return await git(repo, ['commit-tree', tree, '-p', parent, '-m', message]);
}

async function addDependency(
  storage: Phase1Database,
  fixture: AgentFixture,
  dependentTaskId: string,
  prerequisiteTaskId: string,
  commandId: string,
): Promise<void> {
  storage.addTaskDependency({
    projectId: fixture.projectId,
    taskId: dependentTaskId,
    prerequisiteTaskId,
    expectedVersion: storage.getTask(fixture.projectId, dependentTaskId)?.version ?? 0,
    commandId,
    payloadHash: commandId,
    eventId: `event-${commandId}`,
    actor: 'local-user',
    createdAt: 30,
  });
}

describe('dependency scheduler', () => {
  test('keeps a downstream Task BLOCKED until the upstream revision is in dev', async () => {
    const fixture = await createAgentFixture();
    const { storage, projectId, taskId: upstreamTaskId, revisionId: upstreamRevisionId } = fixture;
    createSubmittedTask(storage, projectId, 'downstream', 'downstream-revision', 'Consume the upstream');
    await addDependency(storage, fixture, 'downstream', upstreamTaskId, 'dep-add-1');

    // The Task was READY after submit; the dependency verdict moves it to BLOCKED and names why.
    const blocked = await reconcileTaskDependencyState({
      storage, projectId, taskId: 'downstream', commandId: 'reconcile-1', actor: 'local-user',
    });
    expect(blocked.changed).toBe(true);
    expect(blocked.state).toBe('BLOCKED');
    expect(blocked.blockedReasons.map((reason) => reason.code)).toEqual(['UPSTREAM_NOT_INTEGRATED']);
    expect(storage.getTask(projectId, 'downstream')?.state).toBe('BLOCKED');

    // A blocked Task cannot be started, and nothing is reserved for it.
    await expect(assertTaskRunnable({
      storage, projectId, taskId: 'downstream', expectedTaskVersion: blocked.version,
      commandId: 'run-1', actor: 'local-user',
    })).rejects.toThrow(SchedulerError);
    await expect(assertDependenciesSatisfied({ storage, projectId, taskId: 'downstream' }))
      .rejects.toThrow(SchedulerError);
    await expectCode(assertDependenciesSatisfied({ storage, projectId, taskId: 'downstream' }),
      'DEPENDENCIES_UNMET');
    expect(storage.sqlite.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM workspaces WHERE task_id='downstream'",
    ).get()?.count).toBe(0);
    expect(storage.sqlite.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM executions WHERE task_id='downstream'",
    ).get()?.count).toBe(0);

    // The upstream result reaches dev: an INTEGRATED batch whose merged commit is on dev.
    const devBefore = await git(fixture.repo, ['rev-parse', 'refs/heads/dev']);
    const integrated = await commitTree(fixture.repo, devBefore, 'upstream result');
    await git(fixture.repo, ['update-ref', 'refs/heads/dev', integrated]);
    recordIntegrationFact(storage, { projectId, taskId: upstreamTaskId,
      revisionId: upstreamRevisionId, executionId: 'execution-upstream', batchId: 'batch-1',
      integratedCommit: integrated, devCommit: devBefore });

    const readied = await reconcileTaskDependencyState({
      storage, projectId, taskId: 'downstream', commandId: 'reconcile-2', actor: 'local-user',
    });
    expect(readied.changed).toBe(true);
    expect(readied.state).toBe('READY');
    expect(readied.blockedReasons).toEqual([]);
    // The refreshed version is what a caller runs with, in the same command.
    const runnable = await assertTaskRunnable({
      storage, projectId, taskId: 'downstream', expectedTaskVersion: readied.version,
      commandId: 'run-2', actor: 'local-user',
    });
    expect(runnable.expectedTaskVersion).toBe(readied.version);

    // A stale caller is refused instead of running against a version it did not see.
    await expectCode(assertTaskRunnable({
      storage, projectId, taskId: 'downstream', expectedTaskVersion: blocked.version,
      commandId: 'run-stale', actor: 'local-user',
    }), 'CONCURRENT_MODIFICATION');
    storage.close();
  });

  test('blocks the downstream again when dev no longer contains the upstream commit', async () => {
    const fixture = await createAgentFixture();
    const { storage, projectId, taskId: upstreamTaskId, revisionId: upstreamRevisionId } = fixture;
    createSubmittedTask(storage, projectId, 'downstream', 'downstream-revision', 'Consume the upstream');
    await addDependency(storage, fixture, 'downstream', upstreamTaskId, 'dep-add-1');
    const devStart = await git(fixture.repo, ['rev-parse', 'refs/heads/dev']);
    const integrated = await commitTree(fixture.repo, devStart, 'upstream result');
    const advanced = await commitTree(fixture.repo, integrated, 'later dev work');
    await git(fixture.repo, ['update-ref', 'refs/heads/dev', advanced]);
    recordIntegrationFact(storage, { projectId, taskId: upstreamTaskId, revisionId: upstreamRevisionId,
      executionId: 'execution-upstream', batchId: 'batch-1', integratedCommit: integrated,
      devCommit: devStart });
    // A strict ancestor counts: `isAncestor` is what makes an advanced dev satisfy the edge.
    expect((await reconcileTaskDependencyState({
      storage, projectId, taskId: 'downstream', commandId: 'reconcile-1', actor: 'local-user',
    })).state).toBe('READY');

    // dev is rewritten from the same starting point, so the upstream commit is no longer reachable.
    const divergent = await commitTree(fixture.repo, devStart, 'rewritten dev');
    await git(fixture.repo, ['update-ref', 'refs/heads/dev', divergent]);
    const reblocked = await reconcileTaskDependencyState({
      storage, projectId, taskId: 'downstream', commandId: 'reconcile-2', actor: 'local-user',
    });
    expect(reblocked.state).toBe('BLOCKED');
    expect(reblocked.blockedReasons.map((reason) => reason.code)).toEqual(['NOT_REACHABLE_FROM_DEV']);
    storage.close();
  });

  test('unblocks the transitive dependents of an integrated Task', async () => {
    const fixture = await createAgentFixture();
    const { storage, projectId, taskId: upstreamTaskId, revisionId: upstreamRevisionId } = fixture;
    createSubmittedTask(storage, projectId, 'middle', 'middle-revision', 'Middle');
    createSubmittedTask(storage, projectId, 'leaf', 'leaf-revision', 'Leaf');
    await addDependency(storage, fixture, 'middle', upstreamTaskId, 'dep-add-1');
    await addDependency(storage, fixture, 'leaf', 'middle', 'dep-add-2');
    for (const taskId of ['middle', 'leaf'] as const) {
      await reconcileTaskDependencyState({
        storage, projectId, taskId, commandId: `reconcile-${taskId}`, actor: 'local-user',
      });
    }
    expect(storage.getTask(projectId, 'middle')?.state).toBe('BLOCKED');
    expect(storage.getTask(projectId, 'leaf')?.state).toBe('BLOCKED');

    const devStart = await git(fixture.repo, ['rev-parse', 'refs/heads/dev']);
    const integrated = await commitTree(fixture.repo, devStart, 'upstream result');
    await git(fixture.repo, ['update-ref', 'refs/heads/dev', integrated]);
    recordIntegrationFact(storage, { projectId, taskId: upstreamTaskId, revisionId: upstreamRevisionId,
      executionId: 'execution-upstream', batchId: 'batch-1', integratedCommit: integrated,
      devCommit: devStart });

    // `middle` is now satisfied; `leaf` still waits for `middle`, which has not been integrated.
    const result = await reconcileDependentTasks({
      storage, projectId, taskId: upstreamTaskId, commandId: 'integrate-1', actor: 'local-user',
    });
    expect(result.readied).toEqual(['middle']);
    // `leaf` was already BLOCKED and stays blocked: only the Tasks this call actually moved are
    // reported as transitions, so an unchanged Task is never reported as a new event.
    expect(result.blocked).toEqual([]);
    expect(result.unchanged).toEqual(['leaf']);
    expect(result.errors).toEqual([]);
    expect(storage.getTask(projectId, 'middle')?.state).toBe('READY');
    expect(storage.getTask(projectId, 'leaf')?.state).toBe('BLOCKED');
    storage.close();
  });

  test('reports the graph projection with closures and does not touch a running Task', async () => {
    const fixture = await createAgentFixture();
    const { storage, projectId, taskId: upstreamTaskId } = fixture;
    createSubmittedTask(storage, projectId, 'middle', 'middle-revision', 'Middle');
    createSubmittedTask(storage, projectId, 'leaf', 'leaf-revision', 'Leaf');
    await addDependency(storage, fixture, 'middle', upstreamTaskId, 'dep-add-1');
    await addDependency(storage, fixture, 'leaf', 'middle', 'dep-add-2');

    const view = await inspectTaskDependencies({ storage, projectId, taskId: 'leaf' });
    expect(view.devRef).toBe('refs/heads/dev');
    expect(view.devCommit).not.toBeNull();
    expect(view.edges).toHaveLength(1);
    expect(view.edges[0]).toMatchObject({ prerequisiteTaskId: 'middle', satisfied: false,
      reason: { code: 'UPSTREAM_NOT_INTEGRATED' } });
    expect([...view.prerequisites].sort()).toEqual([fixture.taskId, 'middle'].sort());
    expect(view.dependents).toEqual([]);
    expect(view.blocked).toBe(true);

    const projectWide = await inspectTaskDependencies({ storage, projectId });
    expect(projectWide.taskId).toBeNull();
    expect(projectWide.edges).toHaveLength(2);
    expect(projectWide.edges.map((edge) => edge.dependentTaskId)).toEqual(['middle', 'leaf']);

    // A RUNNING Task is not moved by a dependency verdict: only READY/BLOCKED may change here.
    storage.sqlite.query("UPDATE tasks SET state='RUNNING' WHERE id='leaf'").run();
    const running = await reconcileTaskDependencyState({
      storage, projectId, taskId: 'leaf', commandId: 'reconcile-running', actor: 'local-user',
    });
    expect(running.changed).toBe(false);
    expect(running.state).toBe('RUNNING');
    expect(storage.getTask(projectId, 'leaf')?.state).toBe('RUNNING');
    storage.close();
  });

  test('refuses a dependency cycle and leaves the graph unchanged', async () => {
    const fixture = await createAgentFixture();
    const { storage, projectId, taskId: upstreamTaskId } = fixture;
    createSubmittedTask(storage, projectId, 'middle', 'middle-revision', 'Middle');
    await addDependency(storage, fixture, 'middle', upstreamTaskId, 'dep-add-1');
    await expectCode(() => storage.addTaskDependency({
      projectId,
      taskId: upstreamTaskId,
      prerequisiteTaskId: 'middle',
      expectedVersion: storage.getTask(projectId, upstreamTaskId)?.version ?? 0,
      commandId: 'dep-cycle-2',
      payloadHash: 'dep-cycle-2',
      eventId: 'event-dep-cycle-2',
      actor: 'local-user',
      createdAt: 32,
    }), 'DEPENDENCY_CYCLE');
    expect(storage.listTaskDependencyFacts(projectId)).toHaveLength(1);
    expect(storage.getTask(projectId, upstreamTaskId)?.version).toBe(1);
    const view = await inspectTaskDependencies({ storage, projectId, taskId: upstreamTaskId });
    expect(view.edges).toEqual([]);
    expect(view.dependents).toEqual(['middle']);
    storage.close();
  });

  test('reports a missing dev baseline as blocked instead of satisfied', async () => {
    const fixture = await createAgentFixture();
    const { storage, projectId, taskId: upstreamTaskId, revisionId: upstreamRevisionId } = fixture;
    createSubmittedTask(storage, projectId, 'downstream', 'downstream-revision', 'Consume the upstream');
    await addDependency(storage, fixture, 'downstream', upstreamTaskId, 'dep-add-1');
    recordIntegrationFact(storage, { projectId, taskId: upstreamTaskId, revisionId: upstreamRevisionId,
      executionId: 'execution-upstream', batchId: 'batch-1', integratedCommit: 'd'.repeat(40),
      devCommit: 'd'.repeat(40) });
    // Deleting the branch removes the only baseline that could make the fact true.
    await git(fixture.repo, ['update-ref', '-d', 'refs/heads/dev']);
    const view = await inspectTaskDependencies({ storage, projectId, taskId: 'downstream' });
    expect(view.devCommit).toBeNull();
    expect(view.edges[0]?.satisfied).toBe(false);
    expect(view.edges[0]?.reason?.code).toBe('DEV_BASELINE_MISSING');
    storage.close();
  });
});
