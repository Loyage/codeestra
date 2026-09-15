import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import {
  captureProviderProcessTree,
  DeterministicFakeAdapter,
  type ProviderOwnershipObservation,
  type ProviderProcessTree,
} from '@codeestra/agent-adapters';
import type { AgentSessionRef, AgentStartRequest } from '@codeestra/contracts';
import { AdapterRegistry } from '../../runtime/src/adapter-registry.js';
import { AgentRuntimeCoordinator } from '../../runtime/src/agent-runtime-service.js';
import { reconcileStaleAgentSessions } from '../../runtime/src/recovery-service.js';
import { recoverTask } from '../../runtime/src/task-recovery-service.js';
import { assessTaskImpact, occupierCodeOf, observeWorkspacePath }
  from '../../runtime/src/impact-analysis-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  type AgentFixture,
} from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

const providerPid = 8_100_001;
const providerStartToken = 'recovery-reconcile:provider-token';

/**
 * A fake Adapter that claims a provider process identity, exactly like the startup-convergence test
 * does: the facts `task.recover` reads are the ones a real Adapter records, so the observation under
 * test is the real one and only the process table is injected.
 */
class ProcessIdentityFakeAdapter extends DeterministicFakeAdapter {
  override async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    const session = await super.start(request);
    return {
      ...session,
      processIdentity: {
        pid: providerPid,
        executable: 'fake-provider',
        startToken: providerStartToken,
        argvHash: 'recovery-reconcile-argv',
        capturedAt: 1,
      },
    };
  }
}

interface RecoveryHarness {
  readonly fixture: AgentFixture;
  readonly coordinator: AgentRuntimeCoordinator;
  readonly sessionId: string;
  readonly executionId: string;
  readonly workspacePath: string;
}

function executionRow(harness: RecoveryHarness): { state: string; resource_held: number } {
  const row = harness.fixture.storage.sqlite.query<{ state: string; resource_held: number }, [string]>(
    'SELECT state,resource_held FROM executions WHERE id=?1').get(harness.executionId);
  if (row === null) throw new Error('Execution row disappeared');
  return row;
}

function sessionRow(harness: RecoveryHarness): { state: string } {
  const row = harness.fixture.storage.sqlite.query<{ state: string }, [string]>(
    'SELECT state FROM agent_sessions WHERE id=?1').get(harness.sessionId);
  if (row === null) throw new Error('Session row disappeared');
  return row;
}

function workspaceRow(harness: RecoveryHarness): { state: string; path: string } {
  const row = harness.fixture.storage.sqlite.query<{ state: string; path: string }, [string]>(
    'SELECT state,path FROM workspaces WHERE task_id=?1').get(harness.fixture.taskId);
  if (row === null) throw new Error('Workspace row disappeared');
  return row;
}

function recoveryEvents(harness: RecoveryHarness): readonly {
  event_type: string; payload_json: string;
}[] {
  return harness.fixture.storage.sqlite.query<{ event_type: string; payload_json: string }, []>(`
    SELECT event_type,payload_json FROM domain_events
    WHERE event_type IN ('TaskRecoveryReconciled','ExecutionStateChanged','TaskStateChanged',
      'AgentSessionStateChanged')
    ORDER BY sequence
  `).all();
}

/**
 * One Task whose run reached `RECOVERY_REQUIRED` the way the real incident did: the provider is
 * recorded, the Session projection is converged from a real process-table observation, and the
 * resource stays held. `tree: null` models the incident's `#8`, whose identity was recorded on the
 * Session while no descendant snapshot was ever kept.
 */
async function recoveryHarness(options: { readonly tree?: ProviderProcessTree | null } = {}):
Promise<RecoveryHarness> {
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
  const tree = 'tree' in options
    ? options.tree ?? null
    : await captureProviderProcessTree({
      pid: providerPid, startToken: providerStartToken, readTable: async () => [],
      readStartToken: async () => null,
    });
  fixture.storage.recordSessionIncarnation({
    id: crypto.randomUUID(),
    sessionId: run.sessionId,
    mode: 'AUTOMATED_RPC',
    commandId: `automation:${run.sessionId}`,
    providerPid: tree === null ? null : tree.pid,
    processIdentity: { pid: providerPid, executable: 'fake-provider', startToken: providerStartToken,
      argvHash: 'recovery-reconcile-argv', capturedAt: 1 },
    processTree: tree,
    providerSessionId: `fake:${run.sessionId}`,
    sessionStorageRef: `${fixture.home}/sessions/fake.jsonl`,
    createdAt: 10,
  });
  // The recorded provider does not exist on this machine, so the Runtime's own convergence projects
  // the pair as RECOVERY_REQUIRED while keeping the resource held.
  const converged = await reconcileStaleAgentSessions({ storage: fixture.storage });
  expect(converged[0]?.projectedExecutionState).toBe('RECOVERY_REQUIRED');
  // The worktree is released by the coordinator when the harness closes, so the row's path is read
  // before that; it is the real prepared path under the Runtime data directory.
  const workspace = workspaceRow({ fixture, coordinator, sessionId: run.sessionId,
    executionId: run.executionId, workspacePath: '' });
  return { fixture, coordinator, sessionId: run.sessionId, executionId: run.executionId,
    workspacePath: workspace.path };
}

async function closeHarness(harness: RecoveryHarness): Promise<void> {
  await harness.coordinator.close();
  harness.fixture.storage.close();
}

const alive = async (): Promise<ProviderOwnershipObservation> =>
  ({ state: 'ALIVE', pid: providerPid, detail: 'recorded provider is still running' });
const descendantsAlive = async (): Promise<ProviderOwnershipObservation> =>
  ({ state: 'DESCENDANTS_ALIVE', detail: 'a recorded tool child is still running',
    descendants: [8_100_002] });
const unverifiable = async (): Promise<ProviderOwnershipObservation> =>
  ({ state: 'UNVERIFIABLE', detail: 'the process table could not be read' });

function recoveryCommand(harness: RecoveryHarness, overrides: Partial<Parameters<typeof recoverTask>[0]> = {}) {
  return recoverTask({
    storage: harness.fixture.storage,
    projectId: harness.fixture.projectId,
    taskId: harness.fixture.taskId,
    expectedVersion: harness.fixture.storage
      .getTask(harness.fixture.projectId, harness.fixture.taskId)?.version ?? 0,
    commandId: crypto.randomUUID(),
    actor: 'local-user',
    payloadHash: 'recover',
    ...overrides,
  });
}

describe('task recover — the RECOVERY_REQUIRED reconcile', () => {
  test('closes a run whose provider is provably gone and records that quiescence was not proven', async () => {
    const harness = await recoveryHarness();
    try {
      const eventsBefore = recoveryEvents(harness).length;
      const versionBefore = harness.fixture.storage
        .getTask(harness.fixture.projectId, harness.fixture.taskId)?.version ?? 0;
      const view = await recoveryCommand(harness);
      expect(view.outcome).toBe('RECONCILED');
      expect(view.code).toBeNull();
      // The two facts this command must never fake.
      expect(view.observation).toMatchObject({
        processState: 'STOPPED', descendantRecord: 'RECORDED', descendantCount: 0,
        workspacePresent: true, quiescenceProven: false, signalsSent: 0, providerPid,
      });
      expect(executionRow(harness)).toMatchObject({ state: 'FAILED', resource_held: 0 });
      expect(sessionRow(harness).state).toBe('EXITED');
      expect(workspaceRow(harness).state).toBe('RETAINED');
      // The worktree is retained, not removed: nothing here deletes or moves a directory.
      expect(existsSync(harness.workspacePath)).toBe(true);
      const task = harness.fixture.storage.getTask(harness.fixture.projectId, harness.fixture.taskId);
      expect(task?.state).toBe('FAILED');
      // Exactly one version step per reconcile, whatever the run went through before it.
      expect(task?.version).toBe(versionBefore + 1);

      const events = recoveryEvents(harness).slice(eventsBefore);
      const reconciled = events.find((event) => event.event_type === 'TaskRecoveryReconciled');
      expect(reconciled).toBeDefined();
      expect(JSON.parse(reconciled?.payload_json ?? '{}')).toMatchObject({
        taskId: harness.fixture.taskId,
        executionId: harness.executionId,
        providerPid,
        processState: 'STOPPED',
        descendantRecord: 'RECORDED',
        workspacePresent: true,
        quiescenceProven: false,
        signalsSent: 0,
        reason: null,
        actor: 'local-user',
      });
      // The three projections follow the observation, in the same transaction.
      expect(events.map((event) => event.event_type)).toEqual([
        'TaskRecoveryReconciled', 'AgentSessionStateChanged', 'ExecutionStateChanged',
        'TaskStateChanged',
      ]);
    } finally {
      await closeHarness(harness);
    }
  }, 30_000);

  test('records MISSING when no descendant snapshot was kept, and still closes the run', async () => {
    const harness = await recoveryHarness({ tree: null });
    try {
      const view = await recoveryCommand(harness);
      expect(view.outcome).toBe('RECONCILED');
      expect(view.observation).toMatchObject({ descendantRecord: 'MISSING', quiescenceProven: false });
      expect(executionRow(harness)).toMatchObject({ state: 'FAILED', resource_held: 0 });
    } finally {
      await closeHarness(harness);
    }
  }, 30_000);

  test('refuses and changes nothing while the provider is alive, a descendant lives, or ownership is unverifiable',
    async () => {
      const cases: readonly {
        readonly inspectOwnership: () => Promise<ProviderOwnershipObservation>;
        readonly code: string;
      }[] = [
        { inspectOwnership: alive, code: 'RECOVERY_PROVIDER_ALIVE' },
        { inspectOwnership: descendantsAlive, code: 'RECOVERY_DESCENDANTS_ALIVE' },
        { inspectOwnership: unverifiable, code: 'RECOVERY_OWNERSHIP_UNVERIFIABLE' },
      ];
      for (const entry of cases) {
        const harness = await recoveryHarness();
        try {
          const before = recoveryEvents(harness).length;
          const view = await recoveryCommand(harness, { inspectOwnership: entry.inspectOwnership });
          expect(view.outcome).toBe('REFUSED');
          expect(view.code).toBe(entry.code);
          // A refusal keeps every resource: no state moved and no event was appended.
          expect(recoveryEvents(harness).length).toBe(before);
          expect(executionRow(harness)).toMatchObject({ state: 'RECOVERY_REQUIRED', resource_held: 1 });
          expect(sessionRow(harness).state).toBe('DISCONNECTED');
          expect(workspaceRow(harness).state).toBe('RECOVERY_REQUIRED');
          expect(harness.fixture.storage
            .getTask(harness.fixture.projectId, harness.fixture.taskId)?.state)
            .toBe('RECOVERY_REQUIRED');
          expect(view.detail.length).toBeGreaterThan(0);
        } finally {
          await closeHarness(harness);
        }
      }
    }, 60_000);

  test('refuses when no provider identity was recorded at all', async () => {
    const harness = await recoveryHarness();
    try {
      harness.fixture.storage.sqlite.query(
        'UPDATE session_incarnations SET process_identity_json=NULL,process_tree_json=NULL WHERE session_id=?1')
        .run(harness.sessionId);
      harness.fixture.storage.sqlite.query(
        'UPDATE agent_sessions SET process_identity_json=NULL WHERE id=?1').run(harness.sessionId);
      const view = await recoveryCommand(harness);
      expect(view).toMatchObject({ outcome: 'REFUSED', code: 'RECOVERY_PROCESS_IDENTITY_MISSING',
        observation: { processState: 'IDENTITY_MISSING', providerPid: null } });
      expect(executionRow(harness)).toMatchObject({ state: 'RECOVERY_REQUIRED', resource_held: 1 });
    } finally {
      await closeHarness(harness);
    }
  }, 30_000);

  test('is a read-only no-op once the Task already left RECOVERY_REQUIRED', async () => {
    const harness = await recoveryHarness();
    try {
      await recoveryCommand(harness);
      const events = recoveryEvents(harness).length;
      const again = await recoveryCommand(harness);
      expect(again.outcome).toBe('ALREADY_RECONCILED');
      expect(again.code).toBeNull();
      expect(recoveryEvents(harness).length).toBe(events);
      expect(harness.fixture.storage
        .getTask(harness.fixture.projectId, harness.fixture.taskId)?.state).toBe('FAILED');
    } finally {
      await closeHarness(harness);
    }
  }, 30_000);

  test('refuses a stale version and a Task that is not in recovery without writing anything', async () => {
    const harness = await recoveryHarness();
    try {
      const events = recoveryEvents(harness).length;
      await expect(recoveryCommand(harness, { expectedVersion: 0 }))
        .rejects.toMatchObject({ code: 'CONCURRENT_MODIFICATION' });
      expect(recoveryEvents(harness).length).toBe(events);

      harness.fixture.storage.sqlite.query("UPDATE tasks SET state='READY' WHERE id=?1")
        .run(harness.fixture.taskId);
      await expect(recoveryCommand(harness)).rejects.toMatchObject({ code: 'TASK_NOT_IN_RECOVERY' });
      expect(recoveryEvents(harness).length).toBe(events);
    } finally {
      await closeHarness(harness);
    }
  }, 30_000);

  test('answers a replayed command from its receipt instead of appending a second set of events', async () => {
    const harness = await recoveryHarness();
    try {
      const commandId = crypto.randomUUID();
      const first = await recoveryCommand(harness, { commandId });
      const events = recoveryEvents(harness).length;
      const replay = await recoveryCommand(harness, { commandId });
      expect(replay).toEqual(first);
      expect(recoveryEvents(harness).length).toBe(events);
    } finally {
      await closeHarness(harness);
    }
  }, 30_000);

  test('makes the occupier visible as WORKSPACE_MISSING when its worktree is not on disk', async () => {
    const harness = await recoveryHarness();
    try {
      // The incident: the directory is gone while the ledger still names it.
      rmSync(harness.workspacePath, { recursive: true, force: true });
      expect(observeWorkspacePath(harness.workspacePath)).toBe('MISSING');
      expect(occupierCodeOf('MISSING', false)).toBe('WORKSPACE_MISSING');
      const other = harness.fixture.storage.createTask({
        projectId: harness.fixture.projectId,
        commandId: crypto.randomUUID(),
        payloadHash: 'second',
        intentId: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
        revisionId: crypto.randomUUID(),
        intentEventId: crypto.randomUUID(),
        taskEventId: crypto.randomUUID(),
        specification: 'Second Task',
        constraints: [],
        kind: 'DEVELOPMENT',
        actor: 'local-user',
        createdAt: 20,
      });
      harness.fixture.storage.submitTask({
        projectId: harness.fixture.projectId,
        taskId: other.id,
        expectedVersion: other.version,
        commandId: crypto.randomUUID(),
        payloadHash: 'submit-second',
        eventId: crypto.randomUUID(),
        actor: 'local-user',
        submittedAt: 21,
      });
      // The unobservable occupier is reported as a fact next to the verdict, and the verdict itself
      // is unchanged by it: the candidate has no mapping, so it is UNKNOWN either way.
      const report = await assessTaskImpact({
        storage: harness.fixture.storage,
        projectId: harness.fixture.projectId,
        taskId: other.id,
        now: 22,
      });
      expect(report.active[0]).toMatchObject({
        taskId: harness.fixture.taskId,
        executionState: 'RECOVERY_REQUIRED',
        code: 'WORKSPACE_MISSING',
      });
      expect(report.assessment.verdict).toBe('UNKNOWN');
    } finally {
      await closeHarness(harness);
    }
  }, 30_000);
});
