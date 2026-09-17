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
    displayTitle: 'fixture task',
    namingTitle: null,
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
/**
 * A recorded result commit for one upstream revision (ADR-0064).
 *
 * The edge is judged by the upstream revision's *own* captured result commit; whether the project's
 * checked out branch contains it is the Git question `reconcileTaskDependencyState` answers. No
 * integration batch or `dev` ref is involved any more.
 */
function recordResultCommitFact(
  storage: Phase1Database,
  input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly revisionId: string;
    readonly executionId: string;
    readonly resultCommit: string;
  },
): void {
  const db = storage.sqlite;
  const workspaceId = `workspace-${input.executionId}`;
  db.query(`INSERT INTO workspaces
    (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
    VALUES (?1,?2,?3,?4,?5,?6,'RETAINED',3)`).run(
    workspaceId, input.taskId, `refs/heads/task/${input.taskId}`,
    `/work/${input.executionId}`, `owner-${input.executionId}`, input.resultCommit);
  db.query(`INSERT INTO executions
    (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,adapter_id,
     adapter_version,state,resource_held,base_commit,result_commit,started_at,ended_at)
    VALUES (?1,?2,1,?3,?3,?4,'pi','1','SUCCEEDED',0,?5,?6,4,5)`).run(
    input.executionId, input.taskId, input.revisionId, workspaceId,
    input.resultCommit, input.resultCommit);
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
  test('keeps a downstream Task BLOCKED until the upstream result reachable from the baseline', async () => {
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
    expect(blocked.blockedReasons.map((reason) => reason.code)).toEqual(['UPSTREAM_RESULT_MISSING']);
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

    // The upstream result reaches the shared baseline: the managed integration ref is advanced onto
    // the commit, which is what the Project Service does after a verified merge (ADR-0074) and what
    // this test does directly because it is exercising the dependency projection, not the queue.
    const baseBefore = await git(fixture.repo, ['rev-parse', 'HEAD']);
    const integrated = await commitTree(fixture.repo, baseBefore, 'upstream result');
    await git(fixture.repo, ['update-ref', 'refs/codeestra/integration', integrated]);
    recordResultCommitFact(storage, { projectId, taskId: upstreamTaskId,
      revisionId: upstreamRevisionId, executionId: 'execution-upstream',
      resultCommit: integrated });

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

  test('blocks the downstream again when the baseline no longer contains the upstream commit', async () => {
    const fixture = await createAgentFixture();
    const { storage, projectId, taskId: upstreamTaskId, revisionId: upstreamRevisionId } = fixture;
    createSubmittedTask(storage, projectId, 'downstream', 'downstream-revision', 'Consume the upstream');
    await addDependency(storage, fixture, 'downstream', upstreamTaskId, 'dep-add-1');
    const baseStart = await git(fixture.repo, ['rev-parse', 'HEAD']);
    const integrated = await commitTree(fixture.repo, baseStart, 'upstream result');
    const advanced = await commitTree(fixture.repo, integrated, 'later work');
    await git(fixture.repo, ['update-ref', 'refs/codeestra/integration', advanced]);
    recordResultCommitFact(storage, { projectId, taskId: upstreamTaskId,
      revisionId: upstreamRevisionId, executionId: 'execution-upstream',
      resultCommit: integrated });
    // ADR-0070 D07 / S8: the baseline the edge is judged against is the managed integration ref.
    // A strict ancestor counts: `isAncestor` is what makes an advanced baseline satisfy the edge.
    expect((await reconcileTaskDependencyState({
      storage, projectId, taskId: 'downstream', commandId: 'reconcile-1', actor: 'local-user',
    })).state).toBe('READY');

    // The integration ref is rewritten from the same starting point, so the upstream commit is no
    // longer reachable from it. The scratch fixture repository is moved onto the rewritten commit.
    const divergent = await commitTree(fixture.repo, baseStart, 'rewritten branch');
    await git(fixture.repo, ['update-ref', 'refs/codeestra/integration', divergent]);
    const reblocked = await reconcileTaskDependencyState({
      storage, projectId, taskId: 'downstream', commandId: 'reconcile-2', actor: 'local-user',
    });
    expect(reblocked.state).toBe('BLOCKED');
    expect(reblocked.blockedReasons.map((reason) => reason.code)).toEqual(['NOT_REACHABLE_FROM_BASE']);
    storage.close();
  });

  test('unblocks a blocked chain as its upstream results become reachable', async () => {
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

    // The upstream result becomes reachable from the managed integration ref (ADR-0074).
    const baseStart = await git(fixture.repo, ['rev-parse', 'HEAD']);
    const integrated = await commitTree(fixture.repo, baseStart, 'upstream result');
    await git(fixture.repo, ['update-ref', 'refs/codeestra/integration', integrated]);
    recordResultCommitFact(storage, { projectId, taskId: upstreamTaskId,
      revisionId: upstreamRevisionId, executionId: 'execution-upstream',
      resultCommit: integrated });

    // ADR-0064: the scheduling pass re-evaluates blocked Tasks; this is the same primitive it calls.
    await reconcileTaskDependencyState({
      storage, projectId, taskId: 'middle', commandId: 'reconcile-middle-2', actor: 'scheduler',
    });
    expect(storage.getTask(projectId, 'middle')?.state).toBe('READY');
    // `leaf` waits for `middle`, which has produced no result commit yet, so it stays BLOCKED.
    await reconcileTaskDependencyState({
      storage, projectId, taskId: 'leaf', commandId: 'reconcile-leaf-2', actor: 'scheduler',
    });
    expect(storage.getTask(projectId, 'leaf')?.state).toBe('BLOCKED');

    // Once `middle`'s own result commit is reachable too, the chain unblocks end to end.
    const middleStart = await git(fixture.repo, ['rev-parse', 'HEAD']);
    const middleResult = await commitTree(fixture.repo, middleStart, 'middle result');
    await git(fixture.repo, ['update-ref', 'refs/codeestra/integration', middleResult]);
    recordResultCommitFact(storage, { projectId, taskId: 'middle', revisionId: 'middle-revision',
      executionId: 'execution-middle', resultCommit: middleResult });
    await reconcileTaskDependencyState({
      storage, projectId, taskId: 'leaf', commandId: 'reconcile-leaf-3', actor: 'scheduler',
    });
    expect(storage.getTask(projectId, 'leaf')?.state).toBe('READY');
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
    // ADR-0070 D07 / S8: the one baseline is the Project Service's managed integration ref.
    expect(view.baseRef).toBe('refs/codeestra/integration');
    expect(view.baseCommit).not.toBeNull();
    expect(view.edges).toHaveLength(1);
    expect(view.edges[0]).toMatchObject({ prerequisiteTaskId: 'middle', satisfied: false,
      reason: { code: 'UPSTREAM_RESULT_MISSING' } });
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

  test('reports a missing Task baseline as blocked instead of satisfied', async () => {
    const fixture = await createAgentFixture();
    const { storage, projectId, taskId: upstreamTaskId, revisionId: upstreamRevisionId } = fixture;
    createSubmittedTask(storage, projectId, 'downstream', 'downstream-revision', 'Consume the upstream');
    await addDependency(storage, fixture, 'downstream', upstreamTaskId, 'dep-add-1');
    recordResultCommitFact(storage, { projectId, taskId: upstreamTaskId,
      revisionId: upstreamRevisionId, executionId: 'execution-upstream',
      resultCommit: 'd'.repeat(40) });
    // A baseline that cannot be established at all: the managed ref is gone and the folder has no
    // branch left to materialize it from, which is the state ADR-0024 requires be read as "not
    // satisfied" rather than as "satisfied".
    await git(fixture.repo, ['update-ref', '-d', 'refs/codeestra/integration']);
    await git(fixture.repo, ['checkout', '--detach', '-q']);
    const view = await inspectTaskDependencies({ storage, projectId, taskId: 'downstream' });
    expect(view.baseCommit).toBeNull();
    expect(view.edges[0]?.satisfied).toBe(false);
    expect(view.edges[0]?.reason?.code).toBe('BASE_REF_MISSING');
    storage.close();
  });
});
