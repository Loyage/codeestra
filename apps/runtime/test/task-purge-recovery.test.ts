import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  captureProviderProcessTree,
  DeterministicFakeAdapter,
  type ProviderOwnershipObservation,
  type ProviderProcessTree,
  type ProviderTerminationOutcome,
} from '@codeestra/agent-adapters';
import type { AgentSessionRef, AgentStartRequest } from '@codeestra/contracts';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import { reconcileStaleAgentSessions } from '../src/recovery-service.js';
import { purgeTask } from '../src/task-purge-service.js';
import { createAgentFixture, cleanupTemporaryDirectories, type AgentFixture }
  from './support/agent-fixture.js';

/**
 * `task purge` on a `RECOVERY_REQUIRED` Task (ADR-0058 D02, amended): the deletion reconciles the run
 * by observation first, so an errored Task is deletable without asking the user to run `task recover`
 * as a separate step. The safety invariant is unchanged — only a provider that is provably gone lets
 * the deletion continue, and every refusal changes nothing.
 *
 * The observation seam is injected (like `task-recovery-service.test.ts` does) because the real
 * process table cannot be made to contain a recorded provider deterministically, while the
 * reconcile-and-delete wiring is what is under test.
 */

afterEach(() => { cleanupTemporaryDirectories(); });

const providerPid = 8_200_001;
const providerStartToken = 'purge-recovery:provider-token';

/** A fake that records a provider identity, so the reconcile has facts to observe. */
class ProcessIdentityFakeAdapter extends DeterministicFakeAdapter {
  override async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    const session = await super.start(request);
    return {
      ...session,
      processIdentity: {
        pid: providerPid,
        executable: 'fake-provider',
        startToken: providerStartToken,
        argvHash: 'purge-recovery-argv',
        capturedAt: 1,
      },
    };
  }
}

interface PurgeHarness {
  readonly fixture: AgentFixture;
  readonly coordinator: AgentRuntimeCoordinator;
  readonly sessionId: string;
  readonly executionId: string;
  readonly workspacePath: string;
  readonly branchRef: string;
}

/**
 * One Task whose run reached `RECOVERY_REQUIRED` the way the real incident did, with the slot the
 * startup reconcile would have released already released, so the purge's resource half can judge the
 * retained workspace instead of stopping on an unrelated reservation.
 */
async function recoveryHarness(): Promise<PurgeHarness> {
  const fixture = await createAgentFixture();
  const registry = new AdapterRegistry();
  registry.register(new ProcessIdentityFakeAdapter());
  const coordinator = new AgentRuntimeCoordinator({
    storage: fixture.storage, registry, runtimeHome: fixture.home,
  });
  const run = await coordinator.runTask({
    projectId: fixture.projectId,
    taskId: fixture.taskId,
    expectedTaskVersion: 1,
    commandId: crypto.randomUUID(),
    adapterId: 'fake',
  });
  const tree = await captureProviderProcessTree({
    pid: providerPid, startToken: providerStartToken, readTable: async () => [],
    readStartToken: async () => null,
  });
  fixture.storage.recordSessionIncarnation({
    id: crypto.randomUUID(),
    sessionId: run.sessionId,
    mode: 'AUTOMATED_RPC',
    commandId: `automation:${run.sessionId}`,
    providerPid: tree.pid,
    processIdentity: { pid: providerPid, executable: 'fake-provider', startToken: providerStartToken,
      argvHash: 'purge-recovery-argv', capturedAt: 1 },
    processTree: tree,
    providerSessionId: `fake:${run.sessionId}`,
    sessionStorageRef: `${fixture.home}/sessions/fake.jsonl`,
    createdAt: 10,
  });
  const converged = await reconcileStaleAgentSessions({ storage: fixture.storage });
  expect(converged[0]?.projectedExecutionState).toBe('RECOVERY_REQUIRED');
  const workspace = fixture.storage.getLatestTaskWorkspace(fixture.taskId);
  if (workspace === null) throw new Error('Workspace row disappeared');
  const branchRef = workspace.branchRef;
  const workspacePath = workspace.path;
  // The startup path releases a residual slot whose holder is proven gone before purge judges the
  // workspace; mirror only that fact here.
  for (const reservation of fixture.storage.listSlotReservations(fixture.projectId,
    { taskId: fixture.taskId })) {
    fixture.storage.releaseExecutionSlot({
      projectId: fixture.projectId,
      reservationId: reservation.reservationId,
      expectedReservationVersion: reservation.version,
      reason: 'test: holder reconciled',
      actor: 'test',
      releaseKind: 'RECONCILED_HOLDER_EXITED',
      observation: 'HOLDER_STOPPED',
      evidence: { source: 'TEST' },
      eventId: crypto.randomUUID(),
      commandId: crypto.randomUUID(),
      payloadHash: `release:${reservation.reservationId}`,
      at: 11,
    });
  }
  return { fixture, coordinator, sessionId: run.sessionId, executionId: run.executionId,
    workspacePath, branchRef };
}

function taskVersion(harness: PurgeHarness): number {
  const task = harness.fixture.storage.getTask(harness.fixture.projectId, harness.fixture.taskId);
  if (task === null) throw new Error('Task disappeared');
  return task.version;
}

function purgeCommand(
  harness: PurgeHarness,
  overrides: Partial<Parameters<typeof purgeTask>[0]> = {},
): ReturnType<typeof purgeTask> {
  return purgeTask({
    storage: harness.fixture.storage,
    runtimeHome: harness.fixture.home,
    coordinator: harness.coordinator,
    projectId: harness.fixture.projectId,
    taskId: harness.fixture.taskId,
    expectedVersion: taskVersion(harness),
    commandId: crypto.randomUUID(),
    actor: 'local-user',
    ...overrides,
  });
}

async function closeHarness(harness: PurgeHarness): Promise<void> {
  await harness.coordinator.close();
  harness.fixture.storage.close();
}

const stopped = async (): Promise<ProviderOwnershipObservation> =>
  ({ state: 'STOPPED', detail: 'no process with the recorded provider identity is running' });
const alive = async (): Promise<ProviderOwnershipObservation> =>
  ({ state: 'ALIVE', pid: providerPid, detail: 'recorded provider is still running' });

describe('task purge on a RECOVERY_REQUIRED Task', () => {
  test('reconciles by observation and deletes the Task, its worktree and its branch', async () => {
    const harness = await recoveryHarness();
    try {
      expect(existsSync(harness.workspacePath)).toBe(true);
      const before = harness.fixture.storage.getTask(harness.fixture.projectId, harness.fixture.taskId);
      expect(before?.state).toBe('RECOVERY_REQUIRED');

      const outcome = await purgeCommand(harness, { inspectOwnership: stopped });
      // The deletion reports the reconcile it had to perform, and the Task is really gone.
      expect(outcome.stop).toMatchObject({ state: 'FAILED', stop: 'RECOVERED' });
      expect(outcome.state).toBe('FAILED');
      expect(outcome.replayed).toBe(false);
      expect(outcome.plan).toMatchObject({ worktrees: 1, branches: 1 });
      expect(harness.fixture.storage
        .getTask(harness.fixture.projectId, harness.fixture.taskId)).toBeNull();
      expect(existsSync(harness.workspacePath)).toBe(false);

      // The history is honest: the reconcile is recorded before the purge, and the purge closes it.
      const events = harness.fixture.storage.sqlite.query<{ event_type: string }, [string]>(`
        SELECT event_type FROM domain_events WHERE aggregate_id=?1
          AND event_type IN ('TaskRecoveryReconciled','TaskPurged') ORDER BY sequence
      `).all(harness.fixture.taskId).map((row) => row.event_type);
      expect(events).toEqual(['TaskRecoveryReconciled', 'TaskPurged']);
    } finally {
      await closeHarness(harness);
    }
  }, 60_000);

  test('refuses and changes nothing while the provider is still alive', async () => {
    const harness = await recoveryHarness();
    try {
      const eventsBefore = harness.fixture.storage.sqlite.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM domain_events WHERE event_type='TaskPurged' AND aggregate_id=?1")
        .get(harness.fixture.taskId)?.count ?? 0;
      await expect(purgeCommand(harness, { inspectOwnership: alive }))
        .rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });
      // A refusal is not a partial purge: the Task, its worktree and its execution are untouched.
      expect(harness.fixture.storage
        .getTask(harness.fixture.projectId, harness.fixture.taskId)?.state).toBe('RECOVERY_REQUIRED');
      expect(existsSync(harness.workspacePath)).toBe(true);
      const execution = harness.fixture.storage.listTaskExecutions(
        harness.fixture.projectId, harness.fixture.taskId)[0];
      expect(execution).toMatchObject({ state: 'RECOVERY_REQUIRED', resourceHeld: true });
      const eventsAfter = harness.fixture.storage.sqlite.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM domain_events WHERE event_type='TaskPurged' AND aggregate_id=?1")
        .get(harness.fixture.taskId)?.count ?? 0;
      expect(eventsAfter).toBe(eventsBefore);
    } finally {
      await closeHarness(harness);
    }
  }, 60_000);

  test('a missing provider identity is a refusal, not a deletion', async () => {
    const harness = await recoveryHarness();
    try {
      harness.fixture.storage.sqlite.query(
        'UPDATE session_incarnations SET process_identity_json=NULL,process_tree_json=NULL WHERE session_id=?1')
        .run(harness.sessionId);
      harness.fixture.storage.sqlite.query(
        'UPDATE agent_sessions SET process_identity_json=NULL WHERE id=?1').run(harness.sessionId);
      await expect(purgeCommand(harness)).rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });
      expect(harness.fixture.storage
        .getTask(harness.fixture.projectId, harness.fixture.taskId)?.state).toBe('RECOVERY_REQUIRED');
      expect(existsSync(harness.workspacePath)).toBe(true);
    } finally {
      await closeHarness(harness);
    }
  }, 60_000);
});

/** The termination face `--force` uses: the real one signals pid+start-token matches only (ADR-0058 D09). */
function terminationRecorder(): {
  readonly calls: ProviderProcessTree[];
  readonly terminate: (tree: ProviderProcessTree) => Promise<ProviderTerminationOutcome>;
} {
  const calls: ProviderProcessTree[] = [];
  return {
    calls,
    terminate: async (tree) => {
      calls.push(tree);
      return { attempted: true, signalsSent: 2, terminated: true, signalled: [tree.pid], survivors: [],
        unattributable: [], detail: 'sent 2 signal(s); no recorded process remains' };
    },
  };
}

describe('task purge --force on a RECOVERY_REQUIRED Task', () => {
  test('terminates the recorded provider tree, then deletes, recording what it stepped over', async () => {
    const harness = await recoveryHarness();
    try {
      const recorder = terminationRecorder();
      const outcome = await purgeCommand(harness, {
        force: true,
        inspectOwnership: alive,
        terminate: recorder.terminate,
      });
      // The refusal an ordinary purge would have ended with is recorded, not hidden — the state it was
      // deleted from is still RECOVERY_REQUIRED, and the stop says the deletion was forced.
      expect(outcome.state).toBe('RECOVERY_REQUIRED');
      expect(outcome.stop).toMatchObject({ state: 'RECOVERY_REQUIRED', stop: 'FORCED' });
      expect(outcome.forced?.bypassed.map((entry) => entry.code)).toEqual(['RECONCILE_REQUIRED']);
      expect(outcome.forced?.termination).toMatchObject({ attempted: true, signalsSent: 2,
        terminated: true });
      // It signalled exactly the tree the reconcile read, and it did not invent one.
      expect(recorder.calls.map((tree) => tree.pid)).toEqual([providerPid]);
      // The live-claim gates no longer protect a Task this command retired: the worktree and the
      // branch really go, which is what makes the Task genuinely deletable.
      expect(outcome.plan).toMatchObject({ worktrees: 1, branches: 1 });
      expect(outcome.branchFacts[0]?.deleted).toBe(true);
      expect(existsSync(harness.workspacePath)).toBe(false);
      expect(harness.fixture.storage
        .getTask(harness.fixture.projectId, harness.fixture.taskId)).toBeNull();
      // The audit carries the same facts as the view, in the same transaction as the deletion.
      const event = harness.fixture.storage.sqlite.query<{ payload_json: string }, []>(
        "SELECT payload_json FROM domain_events WHERE event_type='TaskPurged'").get();
      expect(JSON.parse(event?.payload_json ?? '{}')).toMatchObject({
        forced: { bypassed: [{ code: 'RECONCILE_REQUIRED' }], termination: { terminated: true } },
      });
    } finally {
      await closeHarness(harness);
    }
  }, 60_000);

  test('signals nothing when the record kept no identity, and still deletes', async () => {
    const harness = await recoveryHarness();
    try {
      harness.fixture.storage.sqlite.query(
        'UPDATE session_incarnations SET process_identity_json=NULL,process_tree_json=NULL WHERE session_id=?1')
        .run(harness.sessionId);
      harness.fixture.storage.sqlite.query(
        'UPDATE agent_sessions SET process_identity_json=NULL WHERE id=?1').run(harness.sessionId);
      const recorder = terminationRecorder();
      const outcome = await purgeCommand(harness, { force: true, terminate: recorder.terminate });
      // No identity means nothing can be attributed, so nothing may be signalled — and the outcome
      // says that instead of claiming a termination that never happened.
      expect(recorder.calls).toEqual([]);
      expect(outcome.forced?.termination).toBeNull();
      expect(outcome.stop?.stop).toBe('FORCED');
      expect(harness.fixture.storage
        .getTask(harness.fixture.projectId, harness.fixture.taskId)).toBeNull();
    } finally {
      await closeHarness(harness);
    }
  }, 60_000);

});
