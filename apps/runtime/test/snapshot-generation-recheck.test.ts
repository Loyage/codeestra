import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createImpactSnapshot, impactAnalyzerVersion } from '@codeestra/domain';
import type { ImpactSnapshotRecord } from '@codeestra/storage';
import { SlotReservationError, slotDependencyFingerprint } from '@codeestra/storage';
import { RuntimeDrainState } from '../src/capacity-service.js';
import {
  detectImpactPathCaseMode,
  impactPolicyVersionKey,
  inspectImpactPolicy,
  inspectTaskImpact,
} from '../src/impact-analysis-service.js';
import { SlotReservationService } from '../src/slot-reservation-service.js';
import { prepareReservedWorkspace } from '../src/workspace-service.js';
import { cleanupTemporaryDirectories, createAgentFixture, git } from './support/agent-fixture.js';

/**
 * The cached-snapshot-generation recheck of a slot reservation (`scheduler.md` §2, FOUNDATION-060).
 *
 * The defect these tests pin: `acquire` recorded `impact_snapshot_id` and never checked it, so the
 * window between "the analyzer said SAFE" and "the slot is reserved" could be crossed by a revision,
 * a baseline, a mapping/analyzer version or a grown change set without anything noticing. Every case
 * below is run against a real temporary Git repository and a real in-memory database, and each one
 * asserts both halves of the contract: the refusal code *and* that nothing was written.
 *
 * The fixtures build the stored snapshots through the analyzer's own constructor, so the "current"
 * generation is the one the product would record, not a shape invented by the test.
 */

afterEach(() => { cleanupTemporaryDirectories(); });

let counter = 0;
const nextId = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

interface Harness {
  readonly service: SlotReservationService;
  readonly drain: RuntimeDrainState;
  readonly fixture: Awaited<ReturnType<typeof createAgentFixture>>;
}

async function harness(): Promise<Harness> {
  const fixture = await createAgentFixture();
  const drain = new RuntimeDrainState();
  const service = new SlotReservationService({
    storage: fixture.storage,
    bootId: 'boot-1',
    pid: 4321,
    startToken: 'linux:test-boot:99',
    draining: () => drain.state(),
    now: () => 1_000,
    randomUUID: nextId,
  });
  return { service, drain, fixture };
}

/** The empty pre-start observation, recorded the way the scheduling engine records it. */
async function recordPreStartSnapshot(
  harnessed: Harness,
  overrides: {
    readonly revisionId?: string;
    readonly baseCommit?: string;
    readonly policyVersion?: string;
    readonly analyzerVersion?: string;
  } = {},
): Promise<ImpactSnapshotRecord> {
  const { fixture } = harnessed;
  const project = fixture.storage.getTrustedProject(fixture.projectId);
  const task = fixture.storage.getTask(fixture.projectId, fixture.taskId);
  if (task === null) throw new Error('The fixture Task disappeared');
  const inspection = await inspectImpactPolicy({
    repositoryRoot: project.repoRoot, mainRef: project.mainRef,
  });
  // ADR-0056: the development baseline a pre-start prediction is made against is the **dev clone's**
  // `dev` ref, so the snapshot has to record that commit — recording the stable checkout's own `dev`
  // would describe a fact the recheck never reads.
  const devCommit = await git(fixture.devRepo, ['rev-parse', project.devRef]);
  const caseDetection = await detectImpactPathCaseMode(project.repoRoot);
  const snapshot = createImpactSnapshot({
    taskId: fixture.taskId,
    revisionId: overrides.revisionId ?? task.currentRevision.id,
    baseCommit: overrides.baseCommit ?? devCommit,
    policyVersion: overrides.policyVersion ?? impactPolicyVersionKey(inspection),
    policyDigest: '0'.repeat(64),
    caseMode: caseDetection.mode,
    paths: [],
    changeFingerprint: 'pre-start',
    mapping: null,
    incompleteReasons: ['POLICY_ABSENT'],
    ...(overrides.analyzerVersion === undefined
      ? {} : { analyzerVersion: overrides.analyzerVersion }),
  });
  return fixture.storage.recordImpactSnapshot({
    id: nextId(),
    projectId: fixture.projectId,
    taskId: snapshot.taskId,
    revisionId: snapshot.revisionId,
    baseCommit: snapshot.baseCommit,
    analyzerVersion: snapshot.analyzerVersion,
    policyVersion: snapshot.policyVersion,
    policyDigest: snapshot.policyDigest,
    caseMode: snapshot.caseMode,
    changeFingerprint: snapshot.changeFingerprint,
    complete: snapshot.complete,
    incompleteReasons: snapshot.incompleteReasons,
    files: snapshot.files,
    importantDirectories: snapshot.importantDirectories,
    modules: snapshot.modules,
    globalResources: snapshot.globalResources,
    unclassifiedFiles: snapshot.unclassifiedFiles,
    evidence: snapshot.evidence,
    createdAt: 500,
  });
}

function acquire(harnessed: Harness, input: {
  readonly impactSnapshotId?: string;
  readonly commandId?: string;
} = {}) {
  const task = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
    harnessed.fixture.taskId);
  if (task === null) throw new Error('The fixture Task disappeared');
  return harnessed.service.acquire({
    projectId: harnessed.fixture.projectId,
    taskId: harnessed.fixture.taskId,
    expectedTaskVersion: task.version,
    revisionId: task.currentRevision.id,
    adapterId: 'pi',
    actor: 'user',
    commandId: input.commandId ?? nextId(),
    ...(input.impactSnapshotId === undefined ? {} : { impactSnapshotId: input.impactSnapshotId }),
  });
}

async function expectRefusal(promise: Promise<unknown>): Promise<SlotReservationError> {
  let refused: unknown = null;
  try {
    await promise;
  } catch (error) { refused = error; }
  expect(refused).toBeInstanceOf(SlotReservationError);
  return refused as SlotReservationError;
}

/** Every reservation row of the project, released ones included: the append-only audit. */
function rows(harnessed: Harness) {
  return harnessed.fixture.storage.listSlotReservations(harnessed.fixture.projectId,
    { includeReleased: true });
}

function eventCount(harnessed: Harness): number {
  return harnessed.fixture.storage.listEventsAfter({
    projectId: harnessed.fixture.projectId, sinceSequence: 0, limit: 500,
  }).length;
}

/** Reserves, prepares a worktree, hands the slot back, and returns the recorded workspace snapshot. */
async function withWorkspaceSnapshot(harnessed: Harness): Promise<{
  readonly snapshot: ImpactSnapshotRecord;
  readonly path: string;
  readonly workspaceId: string;
}> {
  const { fixture } = harnessed;
  const first = await acquire(harnessed);
  const task = fixture.storage.getTask(fixture.projectId, fixture.taskId);
  const reservation = first.reservation as NonNullable<typeof first.reservation>;
  const prepared = await prepareReservedWorkspace({
    storage: fixture.storage,
    runtimeHome: fixture.home,
    bootId: 'boot-1',
    commandId: nextId(),
    projectId: fixture.projectId,
    reservationId: reservation.reservationId,
    expectedTaskVersion: task?.version as number,
    actor: 'user',
    now: () => 1_100,
    randomUUID: nextId,
  });
  await harnessed.service.release({
    projectId: fixture.projectId,
    reservationId: reservation.reservationId,
    reason: 'the recheck test takes the slot back',
    actor: 'user',
    commandId: nextId(),
  });
  const report = await inspectTaskImpact({
    storage: fixture.storage, projectId: fixture.projectId, taskId: fixture.taskId, now: 1_200,
  });
  if (report.snapshot === null) throw new Error('The fixture produced no workspace snapshot');
  return { snapshot: report.snapshot, path: prepared.path, workspaceId: prepared.workspaceId };
}

describe('snapshot generation recheck', () => {
  test('a generation that is still current is reserved', async () => {
    const harnessed = await harness();
    const snapshot = await recordPreStartSnapshot(harnessed);
    const acquired = await acquire(harnessed, { impactSnapshotId: snapshot.id });
    expect(acquired.outcome).toBe('RESERVED');
    expect(acquired.reservation?.impactSnapshotId).toBe(snapshot.id);
    expect(rows(harnessed)).toHaveLength(1);
  });

  test('a Task revision the snapshot does not describe is refused as STALE_REVISION', async () => {
    const harnessed = await harness();
    const snapshot = await recordPreStartSnapshot(harnessed);
    // Another writer amends the Task; the Task stays READY, so the revision CAS alone would pass.
    const task = harnessed.fixture.storage.getTask(harnessed.fixture.projectId,
      harnessed.fixture.taskId);
    harnessed.fixture.storage.createTaskRevision({
      projectId: harnessed.fixture.projectId,
      taskId: harnessed.fixture.taskId,
      expectedVersion: task?.version as number,
      commandId: nextId(),
      payloadHash: 'amend',
      intentId: nextId(),
      revisionId: nextId(),
      deliveryId: nextId(),
      intentEventId: nextId(),
      revisionEventId: nextId(),
      deliveryEventId: nextId(),
      specification: 'Amended specification',
      reason: 'the user revised the Task',
      actor: 'user',
      createdAt: 900,
    });
    const refused = await expectRefusal(acquire(harnessed, { impactSnapshotId: snapshot.id }));
    expect(refused.code).toBe('SNAPSHOT_STALE');
    expect(refused.detail?.['reasonCodes']).toEqual(['STALE_REVISION']);
    expect(refused.detail?.['differing']).toEqual(['revisionId']);
    expect(rows(harnessed)).toHaveLength(0);
  });

  test('a baseline that moved after the assessment is refused as STALE_BASE', async () => {
    const harnessed = await harness();
    const snapshot = await recordPreStartSnapshot(harnessed);
    // `dev` advances after the prediction was recorded: a Task with no worktree is predicted against
    // the development baseline, so the whole prediction is about a base that no longer exists.
    // ADR-0056: that baseline is the **dev clone's** `dev` ref, so the move happens in that clone, as a
    // real commit — the kind of step that moves the baseline in practice (a hand-written `update-ref`
    // in the stable checkout would not move it any more, which is exactly what this case used to do).
    const project = harnessed.fixture.storage.getTrustedProject(harnessed.fixture.projectId);
    const previous = await git(harnessed.fixture.devRepo, ['rev-parse', project.devRef]);
    await Bun.write(join(harnessed.fixture.devRepo, 'dev-moves.txt'), 'dev moves\n');
    await git(harnessed.fixture.devRepo, ['add', 'dev-moves.txt']);
    await git(harnessed.fixture.devRepo,
      ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.invalid', 'commit', '-q', '-m', 'dev moves']);
    const moved = await git(harnessed.fixture.devRepo, ['rev-parse', 'HEAD']);
    expect(moved).not.toBe(previous);
    const refused = await expectRefusal(acquire(harnessed, { impactSnapshotId: snapshot.id }));
    expect(refused.code).toBe('SNAPSHOT_STALE');
    expect(refused.detail?.['reasonCodes']).toEqual(['STALE_BASE']);
    expect(refused.detail?.['differing']).toEqual(['baseCommit']);
    expect((refused.detail?.['assessed'] as Record<string, unknown>)['baseCommit'])
      .toBe(snapshot.baseCommit);
    expect((refused.detail?.['observed'] as Record<string, unknown>)['baseCommit']).toBe(moved);
    expect(rows(harnessed)).toHaveLength(0);
  });

  test('an edited mapping is refused as STALE_POLICY', async () => {
    const harnessed = await harness();
    const snapshot = await recordPreStartSnapshot(harnessed);
    // The mapping is read from the project `main` ref, so a committed edit moves the policy version
    // of every new snapshot — and leaves this one describing a mapping that is no longer in effect.
    await Bun.write(join(harnessed.fixture.repo, '.codeestra', 'impact.json'),
      `${JSON.stringify({ version: 1, importantDirectories: ['core'], modules: [],
        globalResources: [] }, null, 2)}\n`);
    await git(harnessed.fixture.repo, ['add', '.codeestra/impact.json']);
    await git(harnessed.fixture.repo, ['commit', '-q', '-m', 'declare an impact mapping']);
    const refused = await expectRefusal(acquire(harnessed, { impactSnapshotId: snapshot.id }));
    expect(refused.code).toBe('SNAPSHOT_STALE');
    expect(refused.detail?.['reasonCodes']).toEqual(['STALE_POLICY']);
    expect(refused.detail?.['differing']).toEqual(['policyVersion']);
    expect(rows(harnessed)).toHaveLength(0);
  });

  test('a snapshot recorded by another analyzer version is refused as STALE_ANALYZER', async () => {
    const harnessed = await harness();
    const snapshot = await recordPreStartSnapshot(harnessed,
      { analyzerVersion: 'impact-analyzer-v0' });
    expect(snapshot.analyzerVersion).not.toBe(impactAnalyzerVersion);
    const refused = await expectRefusal(acquire(harnessed, { impactSnapshotId: snapshot.id }));
    expect(refused.code).toBe('SNAPSHOT_STALE');
    expect(refused.detail?.['reasonCodes']).toEqual(['STALE_ANALYZER']);
    expect(refused.detail?.['differing']).toEqual(['analyzerVersion']);
    expect(rows(harnessed)).toHaveLength(0);
  });

  test('a change set that grew past the snapshot is refused as ACTUAL_DIFF_EXCEEDS_SNAPSHOT', async () => {
    const harnessed = await harness();
    // A worktree is what makes a change set observable: reserve, prepare, then hand the slot back so
    // the same Task can be assessed and reserved again.
    const workspace = await withWorkspaceSnapshot(harnessed);
    expect(workspace.snapshot.files).toEqual([]);
    // The worktree now changes a path the prediction did not contain.
    await Bun.write(join(workspace.path, 'new-file.txt'), 'the diff grew\n');
    const refused = await expectRefusal(
      acquire(harnessed, { impactSnapshotId: workspace.snapshot.id }));
    expect(refused.code).toBe('SNAPSHOT_STALE');
    expect(refused.detail?.['reasonCodes']).toEqual(['ACTUAL_DIFF_EXCEEDS_SNAPSHOT']);
    expect(refused.detail?.['differing']).toEqual(['changeSet']);
    expect((refused.detail?.['assessed'] as Record<string, unknown>)['pathCount']).toBe(0);
    expect((refused.detail?.['observed'] as Record<string, unknown>)['pathCount']).toBe(1);
    // Only the released reservation the fixture itself made is on record.
    expect(rows(harnessed)).toHaveLength(1);
    expect(rows(harnessed)[0]?.state).toBe('RELEASED');
  });

  test('a worktree that is gone by the time of the write is re-read, not trusted from the observation',
    async () => {
      const harnessed = await harness();
      const { fixture } = harnessed;
      const workspace = await withWorkspaceSnapshot(harnessed);
      const task = fixture.storage.getTask(fixture.projectId, fixture.taskId);
      // The observation a caller would have made while the worktree existed: the same baseline, the
      // same mapping, an empty change set. It is handed to the write transaction unchanged.
      const observation = {
        snapshotId: workspace.snapshot.id,
        files: Object.freeze([] as string[]),
        policyVersion: workspace.snapshot.policyVersion,
        analyzerVersion: impactAnalyzerVersion,
        baselineSource: 'WORKSPACE' as const,
        baseCommit: workspace.snapshot.baseCommit,
        changeFingerprint: workspace.snapshot.changeFingerprint,
      };
      // ... and then the worktree is confirmed gone before the reservation is written.
      fixture.storage.releaseWorkspaceForReclamation({
        projectId: fixture.projectId,
        taskId: fixture.taskId,
        workspaceId: workspace.workspaceId,
        expectedPath: workspace.path,
        eventId: nextId(),
        reason: 'the worktree was removed before the reservation was written',
        releasedAt: 1_250,
      });
      const facts = fixture.storage.listTaskDependencyFacts(fixture.projectId,
        { taskId: fixture.taskId });
      const refused = await expectRefusal((async () => fixture.storage.reserveExecutionSlot({
        projectId: fixture.projectId,
        taskId: fixture.taskId,
        reservationId: nextId(),
        expectedTaskVersion: task?.version as number,
        expectedRevisionId: task?.currentRevision.id as string,
        adapterId: 'pi',
        workspaceId: null,
        impactSnapshotId: workspace.snapshot.id,
        snapshotRecheck: observation,
        dependencyFingerprint: slotDependencyFingerprint(facts),
        assessedDevCommit: null,
        holder: { bootId: 'boot-1', pid: 4321, startToken: null, actor: 'user' },
        draining: () => ({ draining: false, reason: null }),
        commandId: nextId(),
        payloadHash: 'recheck',
        eventId: nextId(),
        createdAt: 1_300,
      }))());
      expect(refused.code).toBe('SNAPSHOT_STALE');
      expect(refused.detail?.['reasonCodes']).toEqual(['STALE_BASE']);
      expect(refused.detail?.['differing']).toEqual(['baseCommit']);
      expect((refused.detail?.['observed'] as Record<string, unknown>)['baseCommit']).toBeNull();
      // The released reservation the fixture made is the only row; the refused write added none.
      expect(rows(harnessed)).toHaveLength(1);
    });

  test('an unreadable or foreign snapshot id is SNAPSHOT_UNAVAILABLE, never accepted', async () => {
    const harnessed = await harness();
    const missing = await expectRefusal(acquire(harnessed, { impactSnapshotId: nextId() }));
    expect(missing.code).toBe('SNAPSHOT_UNAVAILABLE');
    expect(missing.detail?.['snapshotId']).toBeTruthy();
    expect(rows(harnessed)).toHaveLength(0);
  });

  test('a worktree that appeared where the prediction assumed none is refused too', async () => {
    const harnessed = await harness();
    const { fixture } = harnessed;
    const workspace = await withWorkspaceSnapshot(harnessed);
    const task = fixture.storage.getTask(fixture.projectId, fixture.taskId);
    // The mirror image of the case above: the caller observed a Task with no worktree (so its
    // prediction is against the development baseline) while the Task now owns one. The transaction
    // refuses because the facts the prediction described are not the facts of this write.
    const facts = fixture.storage.listTaskDependencyFacts(fixture.projectId,
      { taskId: fixture.taskId });
    const refused = await expectRefusal((async () => fixture.storage.reserveExecutionSlot({
      projectId: fixture.projectId,
      taskId: fixture.taskId,
      reservationId: nextId(),
      expectedTaskVersion: task?.version as number,
      expectedRevisionId: task?.currentRevision.id as string,
      adapterId: 'pi',
      workspaceId: null,
      impactSnapshotId: workspace.snapshot.id,
      snapshotRecheck: {
        snapshotId: workspace.snapshot.id,
        files: Object.freeze([] as string[]),
        policyVersion: workspace.snapshot.policyVersion,
        analyzerVersion: impactAnalyzerVersion,
        baselineSource: 'BASELINE_REF',
        baseCommit: workspace.snapshot.baseCommit,
        changeFingerprint: null,
      },
      dependencyFingerprint: slotDependencyFingerprint(facts),
      assessedDevCommit: null,
      holder: { bootId: 'boot-1', pid: 4321, startToken: null, actor: 'user' },
      draining: () => ({ draining: false, reason: null }),
      commandId: nextId(),
      payloadHash: 'recheck-no-worktree',
      eventId: nextId(),
      createdAt: 1_350,
    }))());
    expect(refused.code).toBe('SNAPSHOT_STALE');
    expect(refused.detail?.['differing']).toEqual(['baseCommit']);
    expect((refused.detail?.['observed'] as Record<string, unknown>)['baseCommit'])
      .toBe(workspace.snapshot.baseCommit);
    expect(rows(harnessed)).toHaveLength(1);
  });

  test('a refusal writes nothing, and its command id can be reused once the facts are current', async () => {
    const harnessed = await harness();
    const commandId = nextId();
    const eventsBefore = eventCount(harnessed);
    const unavailable = await expectRefusal(
      acquire(harnessed, { impactSnapshotId: nextId(), commandId }));
    expect(unavailable.code).toBe('SNAPSHOT_UNAVAILABLE');
    // Nothing at all was written: no reservation row, no event, and no command receipt that would
    // answer a retry with the cached refusal.
    expect(rows(harnessed)).toHaveLength(0);
    expect(eventCount(harnessed)).toBe(eventsBefore);
    const snapshot = await recordPreStartSnapshot(harnessed);
    expect(eventCount(harnessed)).toBe(eventsBefore);
    const acquired = await acquire(harnessed, { impactSnapshotId: snapshot.id, commandId });
    expect(acquired.outcome).toBe('RESERVED');
    expect(rows(harnessed)).toHaveLength(1);
  });

  test('a replayed acquisition command is idempotent', async () => {
    const harnessed = await harness();
    const snapshot = await recordPreStartSnapshot(harnessed);
    const commandId = nextId();
    const first = await acquire(harnessed, { impactSnapshotId: snapshot.id, commandId });
    const replay = await acquire(harnessed, { impactSnapshotId: snapshot.id, commandId });
    expect(first.outcome).toBe('RESERVED');
    expect(replay.outcome).toBe('RESERVED');
    expect(replay.reservation?.reservationId).toBe(first.reservation?.reservationId);
    expect(rows(harnessed)).toHaveLength(1);
  });

  test('a Task that asserted no snapshot is not rechecked, and records that honestly', async () => {
    const harnessed = await harness();
    const acquired = await acquire(harnessed);
    expect(acquired.outcome).toBe('RESERVED');
    expect(acquired.reservation?.impactSnapshotId).toBeNull();
  });
});
