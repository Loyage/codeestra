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
import { pauseOrCancelTask } from '../src/task-control-service.js';
import type { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
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

async function harness(options: {
  withMapping: boolean;
  /** The Runtime's persistent global barrier (ADR-0061), as the engine reads it. */
  control?: () => { readonly blocked: boolean; readonly state: string };
  /**
   * Make the injected start fail with this stable code instead of starting. It is how the
   * "the barrier committed while this start was in flight" race is reproduced: the engine judged the
   * candidate while the barrier was still down and the start itself was refused.
   */
  startFailureCode?: string;
}): Promise<Harness> {
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
      if (options.startFailureCode !== undefined) {
        throw Object.assign(new Error(`the start was refused (${options.startFailureCode})`),
          { code: options.startFailureCode });
      }
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
    ...(options.control === undefined ? {} : { control: options.control }),
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
function addTask(
  fixture: AgentFixture,
  specification: string,
  features: readonly string[] = [],
): { taskId: string; version: number } {
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
    displayTitle: 'fixture task',
    namingTitle: null,
    features,
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

/**
 * Appends a revision that declares features on an existing Task (ADR-0059). The conflict rule reads
 * the *current* revision, so this is how a test gives the fixture's own Task a declaration without
 * rebuilding it.
 */
function declareFeature(fixture: AgentFixture, taskId: string, features: readonly string[]): void {
  const task = taskOf(fixture, taskId);
  fixture.storage.createTaskRevision({
    projectId: fixture.projectId,
    taskId,
    expectedVersion: task.version,
    commandId: nextId(),
    payloadHash: `feature-${taskId}-${features.join('-')}`,
    intentId: nextId(),
    revisionId: nextId(),
    deliveryId: nextId(),
    intentEventId: nextId(),
    revisionEventId: nextId(),
    deliveryEventId: nextId(),
    specification: task.currentRevision.specification,
    features,
    reason: 'declare a feature for the conflict test',
    actor: 'local-user',
    createdAt: Date.now(),
  });
}

/**
 * Cancels a Task that holds no provider process (the `TERMINAL` path never asks the Adapter).
 *
 * A *running* Task needs the Adapter to confirm its process exited; this harness never started one
 * (the start step is injected), so the stub answers exactly that — the same shape the real
 * coordinator returns after it has verified the provider is gone.
 */
const idleCoordinator = {
  releaseExecutionProcess: async () => ({ sessionId: null, released: true, detail: 'test stop' }),
} as unknown as AgentRuntimeCoordinator;

async function cancelIdleTask(fixture: AgentFixture, taskId: string): Promise<void> {
  await pauseOrCancelTask({
    storage: fixture.storage,
    coordinator: idleCoordinator,
    kind: 'CANCEL',
    projectId: fixture.projectId,
    taskId,
    expectedVersion: taskOf(fixture, taskId).version,
    commandId: nextId(),
    actor: 'test-user',
    randomUUID: nextId,
  });
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

  test('waits while a peer declares the same feature, and starts once that peer is finished', async () => {
    const harnessed = await harness({ withMapping: true });
    // The fixture's own Task declares nothing, so it is never in a feature conflict; take it out of
    // the picture so the capacity arithmetic below is about the two Tasks under test.
    const idle = harnessed.primary;
    await cancelIdleTask(harnessed.fixture, idle.taskId);
    // The rule is symmetric, so the second Task is created *after* the first one started — which is
    // also how this happens in practice: the user starts improving a feature, then asks for another
    // Task on the same feature before the first one is finished.
    const first = addTask(harnessed.fixture, 'Improve the core module', ['core-module']);
    const started = await harnessed.runNow({ taskId: first.taskId, version: first.version });
    expect(started.outcome).toBe('STARTED');
    expect(started.assessment?.verdict).toBe('SAFE_TO_PARALLELIZE');
    const second = addTask(harnessed.fixture, 'Improve it differently', ['core-module']);

    // The second one declares the same feature while the first is unfinished, so it waits — and the
    // reason code names the *declaration*, not a file.
    const waited = await harnessed.runNow({ taskId: second.taskId, version: second.version });
    expect(waited.outcome).toBe('WAIT');
    expect(waited.wait?.kind).toBe('CONFLICT');
    expect(waited.wait?.code).toBe('SAME_UNFINISHED_FEATURE');
    expect(waited.wait?.blocking).toContain(first.taskId);
    expect(taskOf(harnessed.fixture, second.taskId).state).toBe('READY');

    // A CANCELLED peer is finished, so the same feature no longer conflicts with anything: this is
    // the boundary the user chose ("only while that feature is not developed yet").
    await cancelIdleTask(harnessed.fixture, first.taskId);
    const afterRetirement = await harnessed.runNow({ taskId: second.taskId, version: second.version });
    expect(afterRetirement.outcome).toBe('STARTED');
    expect(afterRetirement.assessment?.verdict).toBe('SAFE_TO_PARALLELIZE');
    expect(taskOf(harnessed.fixture, second.taskId).state).toBe('RUNNING');
  });

  test('an archived peer is out of the feature rule, and a feature conflict is never released', async () => {
    const harnessed = await harness({ withMapping: true });
    await cancelIdleTask(harnessed.fixture, harnessed.primary.taskId);
    const archived = addTask(harnessed.fixture, 'Declared, then set aside', ['core-module']);
    const candidate = addTask(harnessed.fixture, 'Wants the same feature', ['core-module']);

    // A READY peer that declares the feature blocks the candidate...
    const blocked = await harnessed.runNow({ taskId: candidate.taskId, version: candidate.version });
    expect(blocked.outcome).toBe('WAIT');
    expect(blocked.wait?.code).toBe('SAME_UNFINISHED_FEATURE');

    // ...but the single-shot release exists for *unprovable* verdicts, and a proven declaration
    // overlap is not one of them: the request is refused, not widened.
    const released = await harnessed.runNow({
      taskId: candidate.taskId, version: candidate.version, allowUnknown: true,
    });
    // A `CONFLICTING` verdict is a *proven* overlap: the single-shot release exists for verdicts the
    // analyzer could not prove, so it is reported as a wait that carries no release.
    expect(released.outcome).toBe('WAIT');
    expect(released.wait?.code).toBe('SAME_UNFINISHED_FEATURE');
    expect(released.clearedUnknownBy ?? null).toBeNull();
    expect(taskOf(harnessed.fixture, candidate.taskId).state).toBe('READY');

    // Archiving the peer is the user saying "not in flight", so it stops blocking.
    harnessed.fixture.storage.archiveTask({
      projectId: harnessed.fixture.projectId,
      taskId: archived.taskId,
      expectedVersion: taskOf(harnessed.fixture, archived.taskId).version,
      commandId: nextId(),
      payloadHash: nextId(),
      eventId: nextId(),
      actor: 'test-user',
      archivedAt: Date.now(),
    });
    const afterArchive = await harnessed.runNow({
      taskId: candidate.taskId, version: candidate.version,
    });
    expect(afterArchive.outcome).toBe('STARTED');
    expect(afterArchive.assessment?.verdict).toBe('SAFE_TO_PARALLELIZE');
  });

  test('reports a grown diff without pausing anyone, because a change set is not a declaration', async () => {
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
    // Both Tasks grew past the empty scope they were allowed to start on. Under ADR-0059 that is
    // *not* a conflict any more: neither declares a feature, so the grown change set is reported as a
    // fact and nobody is asked to pause for it.
    expect(growths).toHaveLength(2);
    const growth = growths.find((entry) => entry.taskId === first.taskId);
    expect(growth?.addedPaths).toContain('core/first.ts');
    expect(growth?.pauseRequested).toBe(false);
    expect(growth?.conflictingTaskIds).toEqual([]);
    expect(harnessed.pauses).toEqual([]);
    // No revocation is written either: the growth pass records a revocation only when the declaration
    // comparison finds a conflict, and a change set is not a declaration.
    const revoked = harnessed.fixture.storage.listTaskScheduleEvents({
      projectId: harnessed.fixture.projectId, taskId: first.taskId, limit: 20,
    }).find((event) => event.eventType === 'TaskImpactPredictionRevoked');
    expect(revoked).toBeUndefined();
  });

  test('resumes beside a peer whose observed scope overlaps but whose declaration does not', async () => {
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
    // Both Tasks changed the very same file, and that is no longer a conflict: the resume gate answers
    // the declaration question, and neither Task declared a feature.
    expect(gate.outcome).toBe('ALLOWED');
    expect(gate.assessment?.verdict).toBe('SAFE_TO_PARALLELIZE');
    expect(gate.assessment?.reasonCodes).toEqual(['NO_CONFLICT']);
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
    expect(harnessed.fixture.storage.countActiveSlotOccupants().globalUsed).toBe(0);
    // Both paused Tasks declare the same feature, which is the current reason a resume has to wait:
    // the peer is unfinished (`PAUSED`) and its declaration overlaps.
    for (const taskId of [first.taskId, second.taskId]) {
      declareFeature(harnessed.fixture, taskId, ['core-module']);
    }
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
    expect(gate.wait?.code).toBe('SAME_UNFINISHED_FEATURE');
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
    const capacityBefore = harnessed.fixture.storage.countActiveSlotOccupants();
    expect(capacityBefore.globalUsed).toBe(1);
    const refused = await harnessed.runNow({ taskId: task.taskId, version: task.version });
    expect(refused.outcome).toBe('REFUSED');
    expect(refused.detail).toContain('SLOT_ALREADY_RESERVED');
    expect(executionsOf(harnessed.fixture, task.taskId)).toHaveLength(0);
  });
});

/**
 * The Runtime's persistent global barrier inside the scheduling loop (FOUNDATION-097 / ADR-0061 D08).
 *
 * A Task that cannot start because the whole host is paused is neither `BLOCKED` (that means an unmet
 * dependency and nothing else) nor a capacity wait: it gets its own wait kind and the stable code
 * `SCHEDULER_GLOBALLY_PAUSED`, which is what the CLI turns into exit code 3.
 */
describe('the global pause barrier inside the scheduling loop', () => {
  test('a paused Runtime makes every candidate a CONTROL wait and starts nothing', async () => {
    const h = await harness({ withMapping: true, control: () => ({ blocked: true, state: 'PAUSED' }) });
    try {
      const outcome = await h.runNow({ taskId: h.primary.taskId, version: h.primary.version });
      expect(outcome.outcome).toBe('WAIT');
      expect(outcome.wait?.kind).toBe('CONTROL');
      expect(outcome.wait?.code).toBe('SCHEDULER_GLOBALLY_PAUSED');
      // Nothing was reserved, prepared or started, and the Task's own state is untouched: the
      // barrier is not a dependency verdict, so it must not have moved the Task to BLOCKED.
      expect(h.starts).toHaveLength(0);
      expect(executionsOf(h.fixture, h.primary.taskId)).toHaveLength(0);
      expect(taskOf(h.fixture, h.primary.taskId).state).toBe('READY');

      const tick = await h.tick('TEST');
      for (const candidate of tick.projects.flatMap((project) => project.candidates)) {
        expect(candidate.disposition).toBe('WAITING');
        expect(candidate.wait?.kind).toBe('CONTROL');
      }
      expect(h.starts).toHaveLength(0);
      // The barrier is a Runtime-global fact: it is not written as a Task conflict or capacity wait.
      const waits = h.fixture.storage.listTaskScheduleEvents({
        projectId: h.fixture.projectId, limit: 50,
      }).map((event) => event.eventType);
      expect(waits).not.toContain('TaskWaitingForConflict');
      expect(waits).not.toContain('TaskWaitingForCapacity');
    } finally {
      h.fixture.storage.close();
    }
  });

  test('a barrier that commits while a start is in flight is a wait, not a failed Task', async () => {
    // The engine judged this candidate while the barrier was still down; the provider start itself
    // was refused by it. Reporting `FAILED` here would blame the Task for a Runtime-wide state, so
    // the disposition is a wait and the reservation is released.
    const h = await harness({ withMapping: true, startFailureCode: 'SCHEDULER_GLOBALLY_PAUSED' });
    try {
      const outcome = await h.runNow({ taskId: h.primary.taskId, version: h.primary.version });
      expect(outcome.outcome).toBe('WAIT');
      expect(outcome.wait?.kind).toBe('CONTROL');
      expect(outcome.wait?.code).toBe('SCHEDULER_GLOBALLY_PAUSED');
      expect(executionsOf(h.fixture, h.primary.taskId)).toHaveLength(0);
      // The occupant count is Runtime-wide now (ADR-0061 D01), so it is read without a Project.
      expect(h.fixture.storage.countActiveSlotOccupants().globalUsed).toBe(0);
    } finally {
      h.fixture.storage.close();
    }
  });
});
