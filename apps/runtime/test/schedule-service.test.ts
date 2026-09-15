import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  impactPolicyDigest, impactPolicyPath, parseImpactPolicy,
} from '@codeestra/contracts';
import { RuntimeDrainState } from '../src/capacity-service.js';
import { prepareReservedWorkspace } from '../src/workspace-service.js';
import {
  ScheduleService,
  type ScheduledStartRequest,
  type ScheduledStartResult,
} from '../src/schedule-service.js';
import { SlotReservationService } from '../src/slot-reservation-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  git,
  syncDevClone,
  type AgentFixture,
} from './support/agent-fixture.js';

/**
 * The scheduling loop at the Runtime boundary (FOUNDATION-055 / ADR-0030).
 *
 * Everything here runs against a real temporary Git repository, a real in-memory database and the
 * real slot-reservation primitive, so the dependency verdict, the conflict verdict, the capacity
 * arithmetic and the audit ledger are the ones the product uses. The Agent start is *injected*: the
 * test substitutes the one step that would launch a provider process, and it prepares a real
 * worktree and reserves a real Execution exactly as `AgentRuntimeCoordinator` does. Nothing here is
 * evidence about a real Agent; the end-to-end CLI test covers the command face.
 */

afterEach(() => { cleanupTemporaryDirectories(); });

let counter = 0;
const nextId = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

const mapping = {
  version: 1,
  importantDirectories: ['core'],
  modules: [{ id: 'core-module', paths: ['core/**'] }],
  globalResources: [],
};

interface Harness {
  readonly fixture: AgentFixture;
  readonly service: ScheduleService;
  readonly starts: ScheduledStartRequest[];
  readonly pauses: { taskId: string; reason: string }[];
  /** Task IDs in the order the scheduler started them. */
  startedTaskIds(): readonly string[];
  tick(trigger?: string): Promise<Awaited<ReturnType<ScheduleService['tick']>>>;
  runNow(input: { taskId: string; version: number; allowUnknown?: boolean }): Promise<
    Awaited<ReturnType<ScheduleService['runNow']>>>;
  /** The Task worktree the Runtime prepared for it. */
  worktreeOf(taskId: string): string;
  /** The Task the shared fixture already created and submitted (the lowest createdAt, so first). */
  readonly primary: { readonly taskId: string; readonly version: number };
}

async function harness(options: { withMapping: boolean }): Promise<Harness> {
  const fixture = await createAgentFixture();
  if (options.withMapping) {
    const text = `${JSON.stringify(mapping, null, 2)}\n`;
    await Bun.write(join(fixture.repo, impactPolicyPath), text);
    await git(fixture.repo, ['add', impactPolicyPath]);
    await git(fixture.repo, ['commit', '-m', 'declare the impact mapping']);
    // The mapping is read from the project's `main` ref and Task worktrees branch from `dev`, so
    // both refs carry it: the fixture is not testing a moved baseline here.
    await git(fixture.repo, ['branch', '-f', 'dev', 'HEAD']);
    // ADR-0056 reads the baseline from the dev clone, so the forced dev branch has to reach it too.
    await syncDevClone({ devRepo: fixture.devRepo, repository: fixture.repo });
    fixture.storage.trustProject({
      id: fixture.projectId,
      trustId: nextId(),
      name: 'Temporary',
      repoRoot: fixture.repo,
      gitCommonDir: fixture.storage.getTrustedProject(fixture.projectId).gitCommonDir,
      mainRef: 'refs/heads/main',
      devRef: 'refs/heads/dev',
      objectFormat: fixture.storage.getTrustedProject(fixture.projectId).objectFormat,
      policyVersion: 1,
      verificationPolicyConfirmationId: nextId(),
      verificationPolicy: {
        state: fixture.verificationPolicy.state,
        digest: fixture.verificationPolicy.digest,
        mainRef: 'refs/heads/main',
        mainCommit: await git(fixture.repo, ['rev-parse', 'HEAD']),
      },
      impactPolicyConfirmationId: nextId(),
      impactPolicy: {
        state: 'PRESENT',
        digest: impactPolicyDigest(parseImpactPolicy(text)),
        contentDigest: null,
        code: null,
        mainRef: 'refs/heads/main',
        mainCommit: await git(fixture.repo, ['rev-parse', 'HEAD']),
      },
      trustedAt: 1,
      actor: 'local-user',
    });
  }
  const drain = new RuntimeDrainState();
  const bootId = 'boot-schedule-test';
  const slots = new SlotReservationService({
    storage: fixture.storage,
    bootId,
    pid: process.pid,
    startToken: 'linux:test:1',
    draining: () => drain.state(),
    now: () => Date.now(),
    randomUUID: nextId,
  });
  const starts: ScheduledStartRequest[] = [];
  const pauses: { taskId: string; reason: string }[] = [];
  const service = new ScheduleService({
    storage: fixture.storage,
    adapters: { ids: () => ['pi'] },
    slots,
    // The injected start: a real worktree bound to the reservation and a real Execution row, and
    // nothing else. It is the one step a test may not take for a real Agent.
    start: async (request): Promise<ScheduledStartResult> => {
      const workspace = await prepareReservedWorkspace({
        storage: fixture.storage,
        runtimeHome: fixture.home,
        bootId,
        commandId: nextId(),
        projectId: request.projectId,
        reservationId: request.reservationId,
        expectedTaskVersion: request.expectedTaskVersion,
        actor: 'test-scheduler',
      });
      const execution = fixture.storage.reserveExecution({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedTaskVersion: request.expectedTaskVersion,
        workspaceId: workspace.workspaceId,
        executionId: nextId(),
        commandId: nextId(),
        payloadHash: nextId(),
        reservationEventId: nextId(),
        taskEventId: nextId(),
        adapterId: request.adapterId,
        adapterVersion: 'test-1',
        actor: 'test-scheduler',
        createdAt: Date.now(),
      });
      starts.push(request);
      return {
        executionId: execution.executionId,
        sessionId: nextId(),
        attemptNumber: execution.attemptNumber,
        taskVersion: execution.taskVersion,
        workspaceId: execution.workspaceId,
        workspacePath: execution.workspacePath,
        baseCommit: execution.baseCommit,
        adapterId: request.adapterId,
        adapterVersion: 'test-1',
        sessionState: 'ACTIVE',
        permissionMode: 'FULL',
        agentConfig: null,
      };
    },
    pause: async ({ taskId, reason }) => {
      pauses.push({ taskId, reason });
      return { state: 'PAUSED', stop: 'RELEASED', detail: 'test pause' };
    },
    draining: () => drain.state(),
    defaultAdapterId: 'pi',
    now: () => Date.now(),
    randomUUID: nextId,
  });
  return {
    fixture,
    service,
    starts,
    pauses,
    startedTaskIds: () => starts.map((start) => start.taskId),
    tick: (trigger = 'TEST') => service.tick(trigger),
    runNow: ({ taskId, version, allowUnknown }) => service.runNow({
      projectId: fixture.projectId,
      taskId,
      expectedTaskVersion: version,
      adapterId: 'pi',
      commandId: nextId(),
      allowUnknown: allowUnknown === true,
      actor: 'test-user',
    }),
    worktreeOf: (taskId) => join(fixture.home, 'worktrees', fixture.projectId, taskId),
    primary: { taskId: fixture.taskId, version: 1 },
  };
}

/** A second READY Task in the same project. `specification` is the Task's text, as the user writes it. */
function addTask(fixture: AgentFixture, specification: string): { taskId: string; version: number } {
  const taskId = nextId();
  fixture.storage.createTask({
    projectId: fixture.projectId,
    commandId: nextId(),
    payloadHash: `create-${taskId}`,
    intentId: nextId(),
    taskId,
    revisionId: nextId(),
    intentEventId: nextId(),
    taskEventId: nextId(),
    specification,
    constraints: [],
    kind: 'DEVELOPMENT',
    actor: 'local-user',
    createdAt: Date.now(),
  });
  fixture.storage.submitTask({
    projectId: fixture.projectId,
    taskId,
    expectedVersion: 0,
    commandId: nextId(),
    payloadHash: `submit-${taskId}`,
    eventId: nextId(),
    actor: 'local-user',
    submittedAt: Date.now(),
  });
  return { taskId, version: 1 };
}

/** One Task's row, so a test can read the state the scheduler left it in. */
function taskOf(fixture: AgentFixture, taskId: string) {
  const task = fixture.storage.getTask(fixture.projectId, taskId);
  if (task === null) throw new Error(`Task ${taskId} disappeared`);
  return task;
}

function executionsOf(fixture: AgentFixture, taskId: string) {
  return fixture.storage.listTaskExecutions(fixture.projectId, taskId);
}

/** Writes a file into a Task worktree exactly where an Agent would have written it. */
async function writeInto(harnessed: Harness, taskId: string, path: string, contents: string) {
  await Bun.write(join(harnessed.worktreeOf(taskId), path), contents);
}

describe('scheduling loop', () => {
  test('orders candidates by priority, then creation time, then ID, without touching a running Task', async () => {
    const harnessed = await harness({ withMapping: true });
    const first = harnessed.primary;
    const second = addTask(harnessed.fixture, 'Second area');
    const third = addTask(harnessed.fixture, 'Third area');
    // An explicit request starts the first Task exclusively; it then holds its resource.
    const started = await harnessed.runNow({ taskId: first.taskId, version: first.version });
    expect(started.outcome).toBe('STARTED');

    // The plan is the ordered candidate walk; the running Task is not a candidate any more.
    const plan = await harnessed.service.plan(harnessed.fixture.projectId);
    expect(plan.candidates.map((candidate) => candidate.taskId))
      .toEqual([second.taskId, third.taskId]);
    // One slot is taken by the running Task, so the dry run shows exactly one more would start and
    // the other one would wait on capacity — the ordered walk, with nothing reserved.
    expect(plan.candidates.map((candidate) => candidate.disposition)).toEqual(['WOULD_START', 'WAITING']);
    expect(plan.candidates[1]?.wait?.code).toBe('CAPACITY_GLOBAL_LIMIT_REACHED');

    // Raising a priority only changes the next order. It does not interrupt the Task that already
    // holds its resource, and it does not create a second Execution for it.
    harnessed.fixture.storage.updateTaskPriority({
      taskId: third.taskId, expectedVersion: taskOf(harnessed.fixture, third.taskId).version,
      priority: 5, updatedAt: Date.now(),
    });
    const reordered = await harnessed.service.plan(harnessed.fixture.projectId);
    expect(reordered.candidates.map((candidate) => candidate.taskId))
      .toEqual([third.taskId, second.taskId]);
    expect(taskOf(harnessed.fixture, first.taskId).state).toBe('RUNNING');
    expect(executionsOf(harnessed.fixture, first.taskId)).toHaveLength(1);

    // The automatic pass now starts the highest-priority candidate first and the other one second.
    const tick = await harnessed.tick();
    expect(tick.projects[0]?.candidates.filter((c) => c.disposition === 'STARTED')
      .map((c) => c.taskId)).toEqual([third.taskId]);
    expect(tick.projects[0]?.candidates.find((c) => c.taskId === second.taskId)?.wait?.code)
      .toBe('CAPACITY_GLOBAL_LIMIT_REACHED');
    expect(taskOf(harnessed.fixture, first.taskId).state).toBe('RUNNING');
    expect(executionsOf(harnessed.fixture, first.taskId)).toHaveLength(1);
  });

  test('starts two provably disjoint Tasks, then reports the third as a capacity wait', async () => {
    const harnessed = await harness({ withMapping: true });
    const first = harnessed.primary;
    const second = addTask(harnessed.fixture, 'Second area');
    const third = addTask(harnessed.fixture, 'Third area');
    const tick = await harnessed.tick();
    const candidates = tick.projects[0]?.candidates ?? [];
    // A Task with no observed change set and a complete, confirmed mapping is proven disjoint, so the
    // automatic pass may start it and both of these run under the default capacity of two.
    expect(candidates.filter((candidate) => candidate.disposition === 'STARTED')
      .map((candidate) => candidate.taskId)).toEqual([first.taskId, second.taskId]);
    expect(candidates[0]?.assessment?.verdict).toBe('SAFE_TO_PARALLELIZE');
    expect(candidates[1]?.assessment?.verdict).toBe('SAFE_TO_PARALLELIZE');
    expect(taskOf(harnessed.fixture, first.taskId).state).toBe('RUNNING');
    expect(taskOf(harnessed.fixture, second.taskId).state).toBe('RUNNING');
    const waiting = candidates[2];
    expect(waiting?.disposition).toBe('WAITING');
    expect(waiting?.wait?.kind).toBe('CAPACITY');
    expect(waiting?.wait?.code).toBe('CAPACITY_GLOBAL_LIMIT_REACHED');
    // A capacity wait is never `BLOCKED`, and the third Task is untouched: READY, no Execution.
    expect(taskOf(harnessed.fixture, third.taskId).state).toBe('READY');
    expect(executionsOf(harnessed.fixture, third.taskId)).toHaveLength(0);
  });

  test('waits on UNKNOWN, then starts it exclusively, and only a release starts it beside a peer', async () => {
    const harnessed = await harness({ withMapping: false });
    const first = harnessed.primary;
    const second = addTask(harnessed.fixture, 'Unknown second');
    // The automatic pass starts only what it can prove: with no mapping nothing is provably disjoint.
    const automatic = await harnessed.tick();
    expect(automatic.projects[0]?.candidates.map((candidate) => candidate.disposition))
      .toEqual(['WAITING', 'WAITING']);
    expect(automatic.projects[0]?.candidates[0]?.wait?.kind).toBe('CONFLICT');
    expect(automatic.projects[0]?.candidates[0]?.wait?.code).toBe('INCOMPLETE_IMPACT');
    expect(taskOf(harnessed.fixture, first.taskId).state).toBe('READY');

    // An explicit request may run a lone UNKNOWN Task exclusively (scheduler.md §2).
    const exclusive = await harnessed.runNow({ taskId: first.taskId, version: first.version });
    expect(exclusive.outcome).toBe('STARTED');
    expect(exclusive.assessment?.verdict).toBe('UNKNOWN');

    // With a peer holding a resource the same request *waits*, with the analyzer's own reason code.
    const waited = await harnessed.runNow({ taskId: second.taskId, version: second.version });
    expect(waited.outcome).toBe('WAIT');
    expect(waited.wait?.kind).toBe('CONFLICT');
    expect(waited.wait?.code).toBe('INCOMPLETE_IMPACT');
    expect(waited.wait?.blocking).toContain(first.taskId);
    expect(taskOf(harnessed.fixture, second.taskId).state).toBe('READY');

    // The explicit single-shot release starts it *concurrently* with the first Task.
    const released = await harnessed.runNow({
      taskId: second.taskId, version: second.version, allowUnknown: true,
    });
    expect(released.outcome).toBe('STARTED');
    expect(released.assessment?.verdict).toBe('UNKNOWN');
    expect(released.clearedUnknownBy).toBeTruthy();
    expect(taskOf(harnessed.fixture, second.taskId).state).toBe('RUNNING');
    expect(taskOf(harnessed.fixture, first.taskId).state).toBe('RUNNING');

    // The release is audited with its binding, and the assessment itself is still UNKNOWN: the
    // release widened one start decision, it did not rewrite a verdict.
    const events = harnessed.fixture.storage.listTaskScheduleEvents({
      projectId: harnessed.fixture.projectId, taskId: second.taskId, limit: 50,
    });
    const release = events.find((event) => event.eventType === 'TaskUnknownCleared');
    expect(release).toBeDefined();
    const payload = release?.payload as Record<string, unknown>;
    expect(payload['verdict']).toBe('UNKNOWN');
    expect(payload['reasonCodes']).toEqual(['INCOMPLETE_IMPACT']);
    expect(payload['revisionId']).toBe(taskOf(harnessed.fixture, second.taskId).currentRevision.id);
    expect(typeof payload['baseCommit']).toBe('string');
    expect(payload['analyzerVersion']).toBe('impact-analyzer-v1');
    expect(payload['releasedBy']).toBe('test-user');
    const decision = events.find((event) => event.eventType === 'TaskScheduleDecided');
    expect((decision?.payload as Record<string, unknown>)['clearedUnknownBy']).toBe(release?.eventId);
    const assessments = harnessed.fixture.storage.listImpactAssessments({
      projectId: harnessed.fixture.projectId, taskId: second.taskId, limit: 10,
    });
    expect(assessments.every((assessment) => assessment.verdict === 'UNKNOWN')).toBe(true);
  });

  test('consumes a single-shot release and expires it when the assessment changes', async () => {
    const harnessed = await harness({ withMapping: false });
    const task = harnessed.primary;
    const peer = addTask(harnessed.fixture, 'Peer');
    expect((await harnessed.runNow({ taskId: peer.taskId, version: peer.version })).outcome)
      .toBe('STARTED');
    const released = await harnessed.service.clearUnknown({
      projectId: harnessed.fixture.projectId,
      taskId: task.taskId,
      commandId: nextId(),
      actor: 'test-user',
    });
    expect(released.state).toBe('RECORDED');
    const started = await harnessed.runNow({ taskId: task.taskId, version: task.version });
    expect(started.outcome).toBe('STARTED');
    expect(started.clearedUnknownBy).toBe(released.releaseId);
    // The decision names the release it consumed, so the audit chain is closed.
    const decision = harnessed.fixture.storage.listTaskScheduleEvents({
      projectId: harnessed.fixture.projectId, taskId: task.taskId, limit: 20,
    }).find((event) => event.eventType === 'TaskScheduleDecided');
    expect((decision?.payload as Record<string, unknown>)['clearedUnknownBy'])
      .toBe(released.releaseId);

    // A release whose *assessment* changed has expired: it binds the baseline, so a `dev` that moved
    // makes it inapplicable instead of silently authorizing a start on a new baseline.
    const later = addTask(harnessed.fixture, 'Unknown after the baseline moved');
    const second = await harnessed.service.clearUnknown({
      projectId: harnessed.fixture.projectId,
      taskId: later.taskId,
      commandId: nextId(),
      actor: 'test-user',
    });
    expect(second.state).toBe('RECORDED');
    await git(harnessed.fixture.repo, ['commit', '--allow-empty', '-m', 'the baseline moves']);
    await git(harnessed.fixture.repo, ['branch', '-f', 'dev', 'HEAD']);
    // ADR-0056: the baseline the release binds is the dev clone's, so moving the main checkout's
    // `dev` is not enough for an expiry test.
    await syncDevClone({ devRepo: harnessed.fixture.devRepo, repository: harnessed.fixture.repo });
    const afterMove = await harnessed.runNow({ taskId: later.taskId, version: later.version });
    expect(afterMove.outcome).toBe('WAIT');
    expect(afterMove.wait?.reasonCodes).toEqual(
      expect.arrayContaining([expect.stringMatching(/STALE_BASE|SNAPSHOT_SCOPE_MISMATCH|INCOMPLETE/)]),
    );
  });

  test('revokes a prediction whose observed diff grew and asks the grown Task to pause', async () => {
    const harnessed = await harness({ withMapping: true });
    const first = harnessed.primary;
    const second = addTask(harnessed.fixture, 'Second important area');
    const tick = await harnessed.tick();
    expect(tick.projects[0]?.candidates.filter((candidate) => candidate.disposition === 'STARTED'))
      .toHaveLength(2);
    // Both Agents now write into the declared important directory, which is past the empty scope
    // their concurrency was allowed on: the pair that was `SAFE` on empty observations is not.
    await writeInto(harnessed, first.taskId, 'core/first.ts', 'export const first = 1;\n');
    await writeInto(harnessed, second.taskId, 'core/second.ts', 'export const second = 1;\n');
    const grown = await harnessed.tick('GROWTH');
    const growths = grown.projects[0]?.impactGrowth ?? [];
    // Both Tasks grew past their prediction and both now provably overlap the other, so each of them
    // is asked to pause: the pair that was allowed to run on empty observations no longer is.
    expect(growths).toHaveLength(2);
    const growth = growths.find((entry) => entry.taskId === first.taskId);
    expect(growth?.addedPaths).toContain('core/first.ts');
    expect(growth?.pauseRequested).toBe(true);
    expect(growth?.conflictingTaskIds).toContain(second.taskId);
    expect(growth?.reasonCodes).toContain('IMPORTANT_DIRECTORY_OVERLAP');
    expect(growth?.reasonCodes).toContain('SAME_MODULE');
    expect(harnessed.pauses.map((pause) => pause.taskId).sort())
      .toEqual([first.taskId, second.taskId].sort());
    // The revocation itself is a fact in the ledger, with both snapshots so the audit shows what
    // changed and which active Task it now provably overlaps.
    const revoked = harnessed.fixture.storage.listTaskScheduleEvents({
      projectId: harnessed.fixture.projectId, taskId: first.taskId, limit: 20,
    }).find((event) => event.eventType === 'TaskImpactPredictionRevoked');
    expect(revoked).toBeDefined();
    const payload = revoked?.payload as Record<string, unknown>;
    expect(payload['conflictingTaskIds']).toEqual([second.taskId]);
    expect(payload['pauseRequested']).toBe(true);
    expect(typeof payload['previousSnapshotId']).toBe('string');
    expect(typeof payload['snapshotId']).toBe('string');
  });

  test('refuses to start a candidate whose observed scope overlaps an active Task', async () => {
    const harnessed = await harness({ withMapping: true });
    const first = harnessed.primary;
    const second = addTask(harnessed.fixture, 'Wants core/shared.ts too');
    expect((await harnessed.tick()).projects[0]?.candidates
      .filter((candidate) => candidate.disposition === 'STARTED')).toHaveLength(2);
    // Both now run. Give the *second* Task an overlapping observed change set by writing into its
    // worktree the way an Agent would, and stop it so it becomes a candidate again.
    await writeInto(harnessed, second.taskId, 'core/shared.ts', 'export const shared = 1;\n');
    await writeInto(harnessed, first.taskId, 'core/shared.ts', 'export const shared = 2;\n');
    const stopped = harnessed.fixture.storage.requestTaskStop({
      projectId: harnessed.fixture.projectId,
      taskId: second.taskId,
      expectedVersion: taskOf(harnessed.fixture, second.taskId).version,
      kind: 'PAUSE',
      commandId: nextId(),
      payloadHash: nextId(),
      taskEventId: nextId(),
      executionEventId: nextId(),
      actor: 'test-user',
      requestedAt: Date.now(),
    });
    harnessed.fixture.storage.confirmTaskStopped({
      projectId: harnessed.fixture.projectId,
      taskId: second.taskId,
      kind: 'PAUSE',
      executionId: stopped.executionId,
      sessionId: null,
      evidenceRef: 'test stop',
      taskEventId: nextId(),
      executionEventId: nextId(),
      sessionEventId: nextId(),
      stoppedAt: Date.now(),
    });
    // The PAUSED Task keeps its resource, so the active set still holds it; the resume gate asks the
    // same conflict question a start would (scheduler.md §4).
    const gate = await harnessed.service.assertResumeAllowed({
      projectId: harnessed.fixture.projectId,
      taskId: second.taskId,
      adapterId: 'pi',
      commandId: nextId(),
      allowUnknown: false,
      actor: 'test-user',
    });
    expect(gate.outcome).toBe('REFUSED');
    expect(gate.wait?.code).toBe('SAME_FILE');
    expect(gate.assessment?.verdict).toBe('CONFLICTING');
    // SAME_FILE is a *proven* overlap, so the explicit single-shot release does not lift it.
    const withRelease = await harnessed.service.assertResumeAllowed({
      projectId: harnessed.fixture.projectId,
      taskId: second.taskId,
      adapterId: 'pi',
      commandId: nextId(),
      allowUnknown: true,
      actor: 'test-user',
    });
    expect(withRelease.outcome).toBe('REFUSED');
  });

  test('a paused Task still takes part in the active set, even though it holds no slot', async () => {
    const harnessed = await harness({ withMapping: true });
    const first = harnessed.primary;
    const second = addTask(harnessed.fixture, 'Overlaps the paused one');
    expect((await harnessed.tick()).projects[0]?.candidates
      .filter((candidate) => candidate.disposition === 'STARTED')).toHaveLength(2);
    await writeInto(harnessed, first.taskId, 'core/first.ts', 'export const first = 1;\n');
    await writeInto(harnessed, second.taskId, 'core/second.ts', 'export const second = 1;\n');
    for (const taskId of [first.taskId, second.taskId]) {
      const stopped = harnessed.fixture.storage.requestTaskStop({
        projectId: harnessed.fixture.projectId,
        taskId,
        expectedVersion: taskOf(harnessed.fixture, taskId).version,
        kind: 'PAUSE',
        commandId: nextId(),
        payloadHash: nextId(),
        taskEventId: nextId(),
        executionEventId: nextId(),
        actor: 'test-user',
        requestedAt: Date.now(),
      });
      harnessed.fixture.storage.confirmTaskStopped({
        projectId: harnessed.fixture.projectId,
        taskId,
        kind: 'PAUSE',
        executionId: stopped.executionId,
        sessionId: null,
        evidenceRef: 'test stop',
        taskEventId: nextId(),
        executionEventId: nextId(),
        sessionEventId: nextId(),
        stoppedAt: Date.now(),
      });
    }
    // The pause releases the Execution row (E2's occupancy counts holders), so a paused Task occupies
    // no slot — but scheduler.md §1 keeps it in the active set, because it still owns a worktree with
    // changes and resuming it is a start. Leaving it out would let both be resumed at once.
    expect(harnessed.fixture.storage.countActiveSlotOccupants({
      projectId: harnessed.fixture.projectId,
    }).globalUsed).toBe(0);
    const gate = await harnessed.service.assertResumeAllowed({
      projectId: harnessed.fixture.projectId,
      taskId: first.taskId,
      adapterId: 'pi',
      commandId: nextId(),
      allowUnknown: false,
      actor: 'test-user',
    });
    expect(gate.outcome).toBe('REFUSED');
    expect(gate.assessment?.verdict).toBe('CONFLICTING');
    expect(gate.assessment?.activeTaskIds).toEqual([second.taskId]);
    // ...and the same question asked about a Task that is *not* active stays answerable: a READY Task
    // in this project is a candidate, and its own verdict is taken against the paused one too.
    const third = addTask(harnessed.fixture, 'A fresh candidate');
    const plan = await harnessed.service.plan(harnessed.fixture.projectId);
    expect(plan.candidates.map((candidate) => candidate.taskId)).toEqual([third.taskId]);
    expect([...(plan.candidates[0]?.assessment?.activeTaskIds ?? [])].sort())
      .toEqual([first.taskId, second.taskId].sort());
  });

  test('reports an unmet dependency as BLOCKED and never starts it', async () => {
    const harnessed = await harness({ withMapping: true });
    const upstream = addTask(harnessed.fixture, 'Upstream');
    const downstream = addTask(harnessed.fixture, 'Downstream');
    // The fixture's own Task is a third candidate in this project; only the two below are asserted.
    harnessed.fixture.storage.addTaskDependency({
      projectId: harnessed.fixture.projectId,
      taskId: downstream.taskId,
      prerequisiteTaskId: upstream.taskId,
      requiredRevisionId: taskOf(harnessed.fixture, upstream.taskId).currentRevision.id,
      expectedVersion: taskOf(harnessed.fixture, downstream.taskId).version,
      commandId: nextId(),
      payloadHash: nextId(),
      eventId: nextId(),
      actor: 'test-user',
      createdAt: Date.now(),
    });
    const tick = await harnessed.tick();
    const candidates = tick.projects[0]?.candidates ?? [];
    const blocked = candidates.find((candidate) => candidate.taskId === downstream.taskId);
    expect(blocked?.disposition).toBe('BLOCKED');
    expect(blocked?.blockedReasons[0]?.code).toBe('UPSTREAM_NOT_INTEGRATED');
    expect(blocked?.wait).toBeNull();
    expect(taskOf(harnessed.fixture, downstream.taskId).state).toBe('BLOCKED');
    expect(executionsOf(harnessed.fixture, downstream.taskId)).toHaveLength(0);
  });

  test('two passes and two concurrent requests never create a second Execution', async () => {
    const harnessed = await harness({ withMapping: true });
    const task = harnessed.primary;
    await harnessed.tick('FIRST');
    await harnessed.tick('SECOND');
    expect(executionsOf(harnessed.fixture, task.taskId)).toHaveLength(1);
    expect(harnessed.starts.filter((start) => start.taskId === task.taskId)).toHaveLength(1);

    const other = addTask(harnessed.fixture, 'Race');
    const [left, right] = await Promise.all([
      harnessed.runNow({ taskId: other.taskId, version: other.version }),
      harnessed.runNow({ taskId: other.taskId, version: other.version }),
    ]);
    expect([left.outcome, right.outcome].filter((outcome) => outcome === 'STARTED')).toHaveLength(1);
    expect(executionsOf(harnessed.fixture, other.taskId)).toHaveLength(1);
  });

  test('a reservation whose holder is gone is converged before anything is started again', async () => {
    const harnessed = await harness({ withMapping: true });
    const task = harnessed.primary;
    // A reservation left behind by a Runtime that never started the Execution: this generation only
    // learns that the holder is gone from the startup reconcile's observation.
    const bootId = 'boot-that-crashed';
    harnessed.fixture.storage.sqlite.query(`
      INSERT INTO execution_slot_reservations(id,project_id,task_id,revision_id,task_version,
        adapter_id,dependency_fingerprint,assessed_dev_commit,state,version,command_id,
        holder_boot_id,holder_pid,holder_start_token,holder_actor,reserved_at,updated_at)
      VALUES (?1,?2,?3,?4,?5,'pi','fingerprint',NULL,'RESERVED',0,?6,?7,999999,NULL,'runtime',?8,?8)
    `).run(nextId(), harnessed.fixture.projectId, task.taskId,
      taskOf(harnessed.fixture, task.taskId).currentRevision.id, task.version, nextId(), bootId,
      Date.now());
    // The residual reservation occupies a slot and blocks a second reservation for this Task.
    const capacityBefore = harnessed.fixture.storage.countActiveSlotOccupants({
      projectId: harnessed.fixture.projectId,
    });
    expect(capacityBefore.globalUsed).toBe(1);
    const refused = await harnessed.runNow({ taskId: task.taskId, version: task.version });
    expect(refused.outcome).toBe('REFUSED');
    expect(refused.detail).toContain('SLOT_ALREADY_RESERVED');
    expect(executionsOf(harnessed.fixture, task.taskId)).toHaveLength(0);
  });
});
