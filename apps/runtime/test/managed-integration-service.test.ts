import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedIntegrationRef, managedIntegrationCandidateRef } from '@codeestra/domain';
import { readRefCommit, inspectIntegrationWorktree, inspectMergeState, listWorktrees }
  from '@codeestra/git';
import type { Phase1Database } from '@codeestra/storage';
import { ManagedIntegrationService } from '../src/managed-integration-service.js';
import { VerificationRunner } from '../src/verification-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  git,
  type AgentFixture,
} from './support/agent-fixture.js';

/**
 * S8 end-to-end, command-free: the Project-managed integration loop against a real temporary
 * repository (ADR-0070 D07 / ADR-0074). Every assertion reads Git or the database back, so a claimed
 * merge that did not move the ref, or a claimed conflict that left no scene, fails here.
 */

const services: ManagedIntegrationService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) void service;
  await cleanupTemporaryDirectories();
});

interface Harness {
  readonly fixture: AgentFixture;
  readonly service: ManagedIntegrationService;
  readonly settled: { readonly taskId: string; readonly payload: Record<string, unknown> }[];
  now(): number;
}

type FixtureCommands = NonNullable<Parameters<typeof createAgentFixture>[0]>['verificationCommands'];

async function createHarness(input: {
  readonly verificationCommands?: FixtureCommands;
} = {}): Promise<Harness> {
  const fixture = await createAgentFixture(input.verificationCommands === undefined
    ? undefined
    : { verificationCommands: input.verificationCommands });
  const settled: Harness['settled'] = [] as unknown as Harness['settled'];
  let clock = 1_000;
  const service = new ManagedIntegrationService({
    storage: fixture.storage,
    integrationRoot: join(fixture.home, 'integration'),
    copiesRoot: join(fixture.home, 'verifications'),
    runner: new VerificationRunner(),
    permissionMode: () => 'FULL',
    notifySettled: (notification) => {
      (settled as { taskId: string; payload: Record<string, unknown> }[]).push({
        taskId: notification.targetServiceId,
        payload: notification.payload as Record<string, unknown>,
      });
    },
    now: () => (clock += 1),
  });
  services.push(service);
  return { fixture, service, settled, now: () => clock };
}

/** Creates a branch with one committed change on top of `parent` and returns its commit OID. */
async function resultCommit(input: {
  readonly repo: string;
  readonly parent: string;
  readonly branch: string;
  readonly file: string;
  readonly contents: string;
  readonly label: string;
}): Promise<string> {
  const worktree = mkdtempSync(join(tmpdir(), 'codeestra-s8-worktree-'));
  await git(input.repo, ['worktree', 'add', worktree, '-b', input.branch, input.parent]);
  await Bun.write(join(worktree, input.file), input.contents);
  await git(worktree, ['add', input.file]);
  await git(worktree, ['commit', '-m', input.label]);
  const commit = await git(worktree, ['rev-parse', 'HEAD']);
  await git(input.repo, ['worktree', 'remove', '--force', worktree]);
  return commit;
}

/**
 * The execution + workspace + PASSED Task verification facts one merge request has to point at.
 * They are inserted directly because driving a real Agent is not what this test is about, and the
 * integration service's own precondition checks are what is under test.
 */
function seedVerifiedResult(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskId: string;
  readonly revisionId: string;
  readonly resultCommit: string;
  readonly baseCommit: string;
  readonly suffix: string;
  readonly verificationState?: 'PASSED' | 'FAILED' | 'RUNNING';
}): { readonly verificationRunId: string } {
  const sqlite = input.storage.sqlite;
  const workspaceId = `40000000-0000-4000-8000-0000000000${input.suffix}`;
  const executionId = `50000000-0000-4000-8000-0000000000${input.suffix}`;
  const operationId = `60000000-0000-4000-8000-0000000000${input.suffix}`;
  const verificationRunId = `70000000-0000-4000-8000-0000000000${input.suffix}`;
  const state = input.verificationState ?? 'PASSED';
  sqlite.query(`INSERT INTO workspaces(id,task_id,branch_ref,path,ownership_token,base_commit,
    base_ref,state,created_at)
    VALUES (?1,?2,?3,?4,?5,?6,'refs/codeestra/integration','RETAINED',2)`).run(
    workspaceId, input.taskId, `refs/heads/task/${input.suffix}`,
    `/tmp/worktrees/${input.suffix}`, `owner-${input.suffix}`, input.baseCommit);
  sqlite.query(`INSERT INTO executions(id,task_id,attempt_number,initial_revision_id,
    applied_revision_id,workspace_id,adapter_id,adapter_version,state,resource_held,base_commit,
    result_commit,started_at,ended_at)
    VALUES (?1,?2,1,?3,?3,?4,'pi','1','SUCCEEDED',0,?5,?6,3,4)`).run(
    executionId, input.taskId, input.revisionId, workspaceId, input.baseCommit, input.resultCommit);
  sqlite.query(`INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,
    request_json,created_at,updated_at)
    VALUES (?1,?2,'RUN_TASK_VERIFICATION',?3,?4,'SUCCEEDED','{"taskId":"x"}',5,5)`).run(
    operationId, input.projectId, verificationRunId, `verify-${input.suffix}`);
  sqlite.query(`INSERT INTO verification_runs(id,project_id,task_id,execution_id,revision_id,
    operation_id,command_id,tested_commit,tested_tree,policy_version,policy_digest,main_commit,
    commands_json,copy_path,state,outcome_code,evidence_json,queued_at,started_at,ended_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'tree','verification-policy-v1','digest',?9,'[]',
      '/tmp/copies/v','PASSED','PASSED','{}',6,7,8)`).run(
    verificationRunId, input.projectId, input.taskId, executionId, input.revisionId, operationId,
    `verify-${input.suffix}`, input.resultCommit, input.baseCommit);
  if (state !== 'PASSED') {
    sqlite.query('UPDATE verification_runs SET state=?2,outcome_code=?2 WHERE id=?1')
      .run(verificationRunId, state);
  }
  return { verificationRunId };
}

/** Adds one more Task and returns its current revision id. */
function addTask(input: { readonly storage: Phase1Database; readonly projectId: string;
  readonly taskId: string; readonly suffix: string }): string {
  const revisionId = `30000000-0000-4000-8000-0000000000${input.suffix}`;
  input.storage.createTask({
    projectId: input.projectId,
    commandId: `c0000000-0000-4000-8000-0000000000${input.suffix}`,
    payloadHash: 'create',
    intentId: `d0000000-0000-4000-8000-0000000000${input.suffix}`,
    taskId: input.taskId,
    revisionId,
    intentEventId: `e0000000-0000-4000-8000-0000000000${input.suffix}`,
    taskEventId: `f0000000-0000-4000-8000-0000000000${input.suffix}`,
    specification: 'Integrate a result',
    displayTitle: `fixture ${input.suffix}`,
    namingTitle: `fixture-${input.suffix}`,
    actor: 'user',
    createdAt: 100,
  });
  input.storage.submitTask({
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: 0,
    commandId: `a1000000-0000-4000-8000-0000000000${input.suffix}`,
    payloadHash: 'submit',
    eventId: `b1000000-0000-4000-8000-0000000000${input.suffix}`,
    actor: 'user',
    submittedAt: 101,
  });
  return revisionId;
}

describe('managed integration service', () => {
  test('trust materializes the ref, and an empty queue says so instead of merging', async () => {
    const harness = await createHarness();
    const status = await harness.service.initialize({ projectId: harness.fixture.projectId });
    expect(status.integrationRef).toBe(managedIntegrationRef);
    expect(status.currentOid).toBe(harness.fixture.mainCommit);
    expect(status.recordedOid).toBe(harness.fixture.mainCommit);
    expect(status.refInSync).toBe(true);
    expect(status.worktree.state).toBe('MISSING');
    expect(status.queuedCount).toBe(0);
    // Idempotent: a second init neither moves the ref nor rewrites the record.
    expect((await harness.service.initialize({ projectId: harness.fixture.projectId })).currentOid)
      .toBe(harness.fixture.mainCommit);
    const report = await harness.service.runNext({ projectId: harness.fixture.projectId,
      actor: 'test' });
    expect(report.outcome).toBe('NOOP');
  });

  test('a merge request is refused unless the current revision has a PASSED verification', async () => {
    const harness = await createHarness();
    await harness.service.initialize({ projectId: harness.fixture.projectId });
    // No execution/verification facts at all yet.
    expect(() => harness.service.request({ projectId: harness.fixture.projectId,
      taskId: harness.fixture.taskId, commandId: 'cmd-1' }))
      .toThrow(/no PASSED verification run/);
    // A failed verification is not a passing one, even when the commit matches.
    seedVerifiedResult({ storage: harness.fixture.storage, projectId: harness.fixture.projectId,
      taskId: harness.fixture.taskId, revisionId: harness.fixture.revisionId,
      resultCommit: 'b'.repeat(40), baseCommit: harness.fixture.mainCommit, suffix: '1',
      verificationState: 'FAILED' });
    expect(() => harness.service.request({ projectId: harness.fixture.projectId,
      taskId: harness.fixture.taskId, commandId: 'cmd-2' }))
      .toThrow(/no PASSED verification run/);
    expect(harness.fixture.storage.managedIntegration
      .listQueue(harness.fixture.projectId).length).toBe(0);
  });

  test('merge → verify → CAS advances the ref and projects MERGED on the Task', async () => {
    const harness = await createHarness();
    const projectId = harness.fixture.projectId;
    await harness.service.initialize({ projectId });
    const result = await resultCommit({ repo: harness.fixture.repo,
      parent: harness.fixture.mainCommit, branch: 'task/fixture',
      file: 'feature.txt', contents: 'first task result\n', label: 'task 1' });
    const { verificationRunId } = seedVerifiedResult({ storage: harness.fixture.storage, projectId,
      taskId: harness.fixture.taskId, revisionId: harness.fixture.revisionId,
      resultCommit: result, baseCommit: harness.fixture.mainCommit, suffix: '2' });

    const requested = harness.service.request({ projectId, taskId: harness.fixture.taskId,
      commandId: 'cmd-merge-1' });
    expect(requested.created).toBe(true);
    expect(requested.item.state).toBe('QUEUED');
    expect(requested.item.taskVerificationRunId).toBe(verificationRunId);
    // Repeating the command converges on the same item instead of queueing twice.
    expect(harness.service.request({ projectId, taskId: harness.fixture.taskId,
      commandId: 'cmd-merge-1' }).item.id).toBe(requested.item.id);
    expect(harness.fixture.storage.managedIntegration.listQueue(projectId).length).toBe(1);
    expect(harness.service.taskIntegration({ projectId, taskId: harness.fixture.taskId }).state)
      .toBe('QUEUED');

    const report = await harness.service.runNext({ projectId, actor: 'test' });
    expect(report.outcome).toBe('MERGED');
    const candidate = report.candidateCommit as string;
    expect(report.integrationOid).toBe(candidate);
    // The ref really moved, to exactly the candidate, and the candidate's first parent is the
    // integration commit the merge was based on.
    const ref = await readRefCommit({ repositoryRoot: harness.fixture.repo,
      ref: managedIntegrationRef });
    expect(ref).toBe(candidate);
    // A `--no-ff` merge: the candidate's *first* parent is exactly the integration commit the merge
    // was based on, and the Task result is its second parent.
    const parents = (await git(harness.fixture.repo,
      ['rev-list', '--parents', '-n', '1', candidate])).split(' ');
    expect(parents.slice(0, 2)).toEqual([candidate, harness.fixture.mainCommit]);
    expect(parents).toContain(result);
    // The Task result really is contained in the integration ref.
    const containsResult = await git(harness.fixture.repo,
      ['merge-base', '--is-ancestor', result, ref as string]).then(() => true, () => false);
    expect(containsResult).toBe(true);

    const item = harness.fixture.storage.managedIntegration.getItem(projectId, requested.item.id);
    expect(item?.state).toBe('MERGED');
    expect(item?.releasedIntegrationOid).toBe(candidate);
    const projection = harness.service.taskIntegration({ projectId, taskId: harness.fixture.taskId });
    expect(projection.state).toBe('MERGED');
    expect(projection.integrationOid).toBe(candidate);
    expect(projection.items.map((entry) => entry.state)).toEqual(['MERGED']);
    // The integration verification is recorded as its own evidence, bound to the candidate.
    expect(projection.integrationRun?.state).toBe('PASSED');
    expect(projection.integrationRun?.candidateCommit).toBe(candidate);
    expect(report.integrationVerification?.state).toBe('PASSED');
    // The Task Service is told, and the version it is told about is the one it holds.
    expect(harness.settled).toHaveLength(1);
    expect(harness.settled[0]?.taskId).toBe(harness.fixture.taskId);
    expect(harness.settled[0]?.payload['state']).toBe('MERGED');
    expect(harness.settled[0]?.payload['projectionVersion']).toBe(projection.version);
    // The temporary candidate ref is gone: the commit is reachable from the managed ref now.
    expect(await readRefCommit({ repositoryRoot: harness.fixture.repo,
      ref: managedIntegrationCandidateRef(requested.item.id) })).toBeNull();
    // The owned worktree is detached at the candidate and is a registered worktree.
    const worktree = await inspectIntegrationWorktree({ repositoryRoot: harness.fixture.repo,
      worktreePath: join(harness.fixture.home, 'integration', projectId) });
    expect(worktree.state).toBe('OWNED');
    expect(worktree.headCommit).toBe(candidate);
    const registrations = await listWorktrees(harness.fixture.repo);
    expect(registrations.some((entry) => entry.path === join(harness.fixture.home, 'integration',
      projectId) && entry.detached)).toBe(true);
    // Nothing in the user's checkout moved: the project folder is still on its own branch.
    expect(await git(harness.fixture.repo, ['symbolic-ref', '-q', 'HEAD'])).toBe('refs/heads/main');
    expect(await git(harness.fixture.repo, ['status', '--porcelain'])).toBe('');
  });

  test('a conflicting result keeps the scene, blocks the queue and is retryable', async () => {
    const harness = await createHarness();
    const projectId = harness.fixture.projectId;
    await harness.service.initialize({ projectId });
    const first = await resultCommit({ repo: harness.fixture.repo,
      parent: harness.fixture.mainCommit, branch: 'task/first', file: 'shared.txt',
      contents: 'from the first task\n', label: 'first' });
    seedVerifiedResult({ storage: harness.fixture.storage, projectId,
      taskId: harness.fixture.taskId, revisionId: harness.fixture.revisionId,
      resultCommit: first, baseCommit: harness.fixture.mainCommit, suffix: '3' });
    harness.service.request({ projectId, taskId: harness.fixture.taskId, commandId: 'cmd-a' });
    expect((await harness.service.runNext({ projectId, actor: 'test' })).outcome).toBe('MERGED');
    const integrated = await readRefCommit({ repositoryRoot: harness.fixture.repo,
      ref: managedIntegrationRef });

    // A second Task based on the *integration* commit, changing the same file differently.
    const secondTaskId = '20000000-0000-4000-8000-0000000000c2';
    const secondRevision = addTask({ storage: harness.fixture.storage, projectId,
      taskId: secondTaskId, suffix: '2' });
    // It branches from the same commit the first Task did — that is what makes the two changes
    // conflict — while the second Task's recorded baseline is the integration commit.
    const second = await resultCommit({ repo: harness.fixture.repo,
      parent: harness.fixture.mainCommit, branch: 'task/second', file: 'shared.txt',
      contents: 'from the second task\n', label: 'second' });
    seedVerifiedResult({ storage: harness.fixture.storage, projectId, taskId: secondTaskId,
      revisionId: secondRevision, resultCommit: second, baseCommit: integrated as string,
      suffix: '4' });
    harness.service.request({ projectId, taskId: secondTaskId, commandId: 'cmd-b' });
    const conflicted = await harness.service.runNext({ projectId, actor: 'test' });
    expect(conflicted.outcome).toBe('CONFLICTED');
    const conflictedItem = conflicted.item;
    if (conflictedItem === null) throw new Error('a CONFLICTED report must name its item');
    expect(conflictedItem.state).toBe('CONFLICTED');
    expect(conflicted.conflict?.paths).toContain('shared.txt');
    // The ref did not move, and the queue refuses to advance while the scene is unresolved.
    expect(await readRefCommit({ repositoryRoot: harness.fixture.repo, ref: managedIntegrationRef }))
      .toBe(integrated);
    const worktreePath = join(harness.fixture.home, 'integration', projectId);
    expect((await inspectMergeState(worktreePath)).merging).toBe(true);
    // The unresolved conflict blocks the queue: `run` refuses by name instead of reporting that
    // there was nothing to do.
    await expect(harness.service.runNext({ projectId, actor: 'test' }))
      .rejects.toThrow(/conflicted and blocks/);
    // The Task projection says CONFLICTED, and the conflict detail is kept.
    expect(harness.service.taskIntegration({ projectId, taskId: secondTaskId }).state)
      .toBe('CONFLICTED');
    // A retry resolves the scene, re-queues the item and advances the attempt counter.
    const retried = await harness.service.retry({ projectId, itemId: conflictedItem.id,
      actor: 'test' });
    expect(retried.item.state).toBe('QUEUED');
    expect(retried.item.attemptCount).toBe(1);
    expect((await inspectMergeState(worktreePath)).merging).toBe(false);
    expect(await git(worktreePath, ['rev-parse', 'HEAD'])).toBe(integrated as string);
  });

  test('an integration ref that moves while the candidate is verified is not forced', async () => {
    // The verification policy itself moves the ref: the commands run inside a detached copy of the
    // candidate, and `update-ref` there addresses the same repository's refs. This models "someone
    // advanced the integration ref while our candidate was being verified" without any test-only
    // back door into the service.
    const harness = await createHarness({ verificationCommands: [{
      id: 'move-ref', argv: ['bash', '-c',
        'git update-ref refs/codeestra/integration "$(git rev-parse HEAD)"'],
      cwd: '.', timeoutSeconds: 60,
    }] });
    const projectId = harness.fixture.projectId;
    await harness.service.initialize({ projectId });
    const result = await resultCommit({ repo: harness.fixture.repo,
      parent: harness.fixture.mainCommit, branch: 'task/mover', file: 'mover.txt',
      contents: 'content\n', label: 'mover' });
    seedVerifiedResult({ storage: harness.fixture.storage, projectId,
      taskId: harness.fixture.taskId, revisionId: harness.fixture.revisionId,
      resultCommit: result, baseCommit: harness.fixture.mainCommit, suffix: '5' });
    harness.service.request({ projectId, taskId: harness.fixture.taskId, commandId: 'cmd-move' });
    const report = await harness.service.runNext({ projectId, actor: 'test' });
    expect(report.outcome).toBe('FAILED');
    const movedItem = report.item;
    if (movedItem === null) throw new Error('a FAILED report must name its item');
    expect(movedItem.lastErrorCode).toBe('INTEGRATION_REF_MOVED');
    // The ref moved, but not by us: it is at the candidate the command forced, and the item records
    // that this Runtime did not release it.
    expect(movedItem.releasedIntegrationOid).toBeNull();
    expect(report.candidateCommit).toBe(await readRefCommit({ repositoryRoot: harness.fixture.repo,
      ref: managedIntegrationRef }));
    // The candidate ref is kept as the scene of the failure.
    expect(await readRefCommit({ repositoryRoot: harness.fixture.repo,
      ref: managedIntegrationCandidateRef(movedItem.id) })).toBe(report.candidateCommit);
    expect(harness.service.taskIntegration({ projectId, taskId: harness.fixture.taskId }).state)
      .toBe('FAILED');
  });

  test('a failed integration verification does not advance the ref', async () => {
    const harness = await createHarness({ verificationCommands: [{
      id: 'fail', argv: ['bash', '-c', 'exit 3'], cwd: '.', timeoutSeconds: 60,
    }] });
    const projectId = harness.fixture.projectId;
    await harness.service.initialize({ projectId });
    const result = await commitWithFile(harness.fixture, 'fail.txt', 'content\n', 'task/fail');
    seedVerifiedResult({ storage: harness.fixture.storage, projectId,
      taskId: harness.fixture.taskId, revisionId: harness.fixture.revisionId,
      resultCommit: result, baseCommit: harness.fixture.mainCommit, suffix: '6' });
    harness.service.request({ projectId, taskId: harness.fixture.taskId, commandId: 'cmd-fail' });
    const report = await harness.service.runNext({ projectId, actor: 'test' });
    expect(report.outcome).toBe('FAILED');
    expect(report.integrationVerification?.state).toBe('FAILED');
    expect(report.integrationVerification?.outcomeCode).toBe('COMMAND_FAILED');
    const failedItem = report.item;
    if (failedItem === null) throw new Error('a FAILED report must name its item');
    expect(await readRefCommit({ repositoryRoot: harness.fixture.repo, ref: managedIntegrationRef }))
      .toBe(harness.fixture.mainCommit);
    expect(harness.service.taskIntegration({ projectId, taskId: harness.fixture.taskId }).state)
      .toBe('FAILED');
    // The scene is kept: the candidate ref and the verification copy both stay.
    expect(await readRefCommit({ repositoryRoot: harness.fixture.repo,
      ref: managedIntegrationCandidateRef(failedItem.id) })).toBe(report.candidateCommit);
    expect(report.integrationVerification?.copyPath).toContain(projectId);
  });

  test('a project without a verification policy cannot integrate anything', async () => {
    const fixture = await createAgentFixture({ withoutVerificationPolicy: true });
    const service = new ManagedIntegrationService({
      storage: fixture.storage,
      integrationRoot: join(fixture.home, 'integration'),
      copiesRoot: join(fixture.home, 'verifications'),
      runner: new VerificationRunner(),
      permissionMode: () => 'FULL',
      now: Date.now,
    });
    services.push(service);
    const projectId = fixture.projectId;
    await service.initialize({ projectId });
    const result = await commitWithFile(fixture, 'no-policy.txt', 'content\n', 'task/no-policy');
    seedVerifiedResult({ storage: fixture.storage, projectId, taskId: fixture.taskId,
      revisionId: fixture.revisionId, resultCommit: result, baseCommit: fixture.mainCommit,
      suffix: '7' });
    service.request({ projectId, taskId: fixture.taskId, commandId: 'cmd-no-policy' });
    const report = await service.runNext({ projectId, actor: 'test' });
    expect(report.outcome).toBe('FAILED');
    expect(report.item?.lastErrorCode).toBe('INTEGRATION_POLICY_ABSENT');
    expect(await readRefCommit({ repositoryRoot: fixture.repo, ref: managedIntegrationRef }))
      .toBe(fixture.mainCommit);
  });

  test('a restart mid-merge marks the item for an explicit reconcile instead of guessing', async () => {
    const harness = await createHarness();
    const projectId = harness.fixture.projectId;
    await harness.service.initialize({ projectId });
    const result = await commitWithFile(harness.fixture, 'interrupted.txt', 'content\n',
      'task/interrupted');
    seedVerifiedResult({ storage: harness.fixture.storage, projectId,
      taskId: harness.fixture.taskId, revisionId: harness.fixture.revisionId,
      resultCommit: result, baseCommit: harness.fixture.mainCommit, suffix: '8' });
    const requested = harness.service.request({ projectId, taskId: harness.fixture.taskId,
      commandId: 'cmd-interrupted' });
    // The claim is what a crash would have left behind: MERGING with no terminal record.
    harness.fixture.storage.managedIntegration.claimQueueItem({ projectId,
      itemId: requested.item.id, now: harness.now(),
      expectedIntegrationOid: harness.fixture.mainCommit });
    // One verification run is left behind mid-flight, exactly as a crash would: the Operation must
    // not stay `IN_PROGRESS` after the startup pass.
    const run = harness.fixture.storage.managedIntegration.insertIntegrationRun({
      id: 'd0000000-0000-4000-8000-0000000000aa', projectId, queueItemId: requested.item.id,
      operationId: 'e0000000-0000-4000-8000-0000000000aa', candidateCommit: 'c'.repeat(40),
      expectedIntegrationOid: harness.fixture.mainCommit, policyVersion: 'verification-policy-v1',
      policyDigest: 'digest', mainCommit: harness.fixture.mainCommit, commands: [],
      copyPath: '/tmp/copy', now: harness.now(),
    });
    harness.fixture.storage.managedIntegration.beginIntegrationRun({ runId: run.id,
      now: harness.now() });
    const reconcile = harness.service.reconcileOnBoot();
    expect(reconcile.recovered).toEqual([requested.item.id]);
    expect(harness.fixture.storage.sqlite.query<{ state: string }, [string]>(
      'SELECT state FROM operations WHERE id=?1').get(run.operationId)?.state)
      .toBe('RECONCILE_REQUIRED');
    const item = harness.fixture.storage.managedIntegration.getItem(projectId, requested.item.id);
    expect(item?.state).toBe('RECOVERY_REQUIRED');
    expect(item?.lastErrorCode).toBe('RUNTIME_RESTARTED');
    expect(item?.settledAt).toBeNull();
    expect(harness.fixture.storage.managedIntegration.getProjectIntegration(projectId)?.state)
      .toBe('RECOVERY_REQUIRED');
    // Nothing is merged automatically, and the ref never moved.
    expect(await readRefCommit({ repositoryRoot: harness.fixture.repo, ref: managedIntegrationRef }))
      .toBe(harness.fixture.mainCommit);
    await expect(harness.service.runNext({ projectId, actor: 'test' }))
      .rejects.toThrow(/RECOVERY_REQUIRED/);
  });

  test('a queued request can be cancelled, and only while it is queued', async () => {
    const harness = await createHarness();
    const projectId = harness.fixture.projectId;
    await harness.service.initialize({ projectId });
    const result = await commitWithFile(harness.fixture, 'cancel.txt', 'content\n', 'task/cancel');
    seedVerifiedResult({ storage: harness.fixture.storage, projectId,
      taskId: harness.fixture.taskId, revisionId: harness.fixture.revisionId,
      resultCommit: result, baseCommit: harness.fixture.mainCommit, suffix: '9' });
    const requested = harness.service.request({ projectId, taskId: harness.fixture.taskId,
      commandId: 'cmd-cancel' });
    const cancelled = harness.service.cancel({ projectId, itemId: requested.item.id,
      actor: 'test', reason: 'no longer needed' });
    expect(cancelled.item.state).toBe('CANCELLED');
    expect(cancelled.item.lastErrorCode).toBe('CANCELLED_BY_USER');
    // A cancelled request reads as NOT_REQUESTED for the Task, and cannot be cancelled twice.
    expect(harness.service.taskIntegration({ projectId, taskId: harness.fixture.taskId }).state)
      .toBe('NOT_REQUESTED');
    expect(() => harness.service.cancel({ projectId, itemId: requested.item.id,
      actor: 'test', reason: 'again' })).toThrow(/only a QUEUED item/);
    // The queue is empty again, and nothing was merged.
    expect((await harness.service.runNext({ projectId, actor: 'test' })).outcome).toBe('NOOP');
    expect(await readRefCommit({ repositoryRoot: harness.fixture.repo, ref: managedIntegrationRef }))
      .toBe(harness.fixture.mainCommit);
  });
});

async function commitWithFile(fixture: AgentFixture, file: string, contents: string,
  branch: string): Promise<string> {
  return resultCommit({ repo: fixture.repo, parent: fixture.mainCommit, branch, file, contents,
    label: branch });
}
