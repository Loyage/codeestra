import { afterEach, describe, expect, test } from 'bun:test';
import {
  captureProviderProcessTree,
  DeterministicFakeAdapter,
  readProcessStartToken,
  type ProviderProcessTree,
} from '@codeestra/agent-adapters';
import type { AgentSessionRef, AgentStartRequest } from '@codeestra/contracts';
import { AdapterRegistry } from '../../runtime/src/adapter-registry.js';
import { AgentRuntimeCoordinator } from '../../runtime/src/agent-runtime-service.js';
import {
  reconcileSessionHandoffs,
  reconcileStaleAgentSessions,
} from '../../runtime/src/recovery-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  type AgentFixture,
} from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

const providerPid = 8_000_001;
const providerStartToken = 'startup-reconcile:provider-token';
const toolChildPid = 8_000_002;
const toolChildStartToken = 'startup-reconcile:tool-token';

/** Same shape as the handoff tests: a fake Adapter that claims a provider process identity. */
class ProcessIdentityFakeAdapter extends DeterministicFakeAdapter {
  override async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    const session = await super.start(request);
    return {
      ...session,
      processIdentity: {
        pid: providerPid,
        executable: 'fake-provider',
        startToken: providerStartToken,
        argvHash: 'startup-reconcile-argv',
        capturedAt: 1,
      },
    };
  }
}

interface StaleHarness {
  readonly storage: AgentFixture['storage'];
  readonly fixture: AgentFixture;
  readonly sessionId: string;
  readonly executionId: string;
  readonly incarnationId: string;
  readonly coordinator: AgentRuntimeCoordinator;
}

/**
 * One running Task with a recorded Session incarnation and writer lease, built exactly like the
 * handoff tests do. The recorded process tree comes either from an injected process table (so
 * ownership is decided from data) or from a tree the caller captured itself.
 */
async function staleHarness(options: {
  readonly rows?: readonly { pid: number; ppid: number; pgid: number; command: string }[];
  readonly tokens?: ReadonlyMap<number, string>;
  readonly tree?: ProviderProcessTree | null;
} = {}): Promise<StaleHarness> {
  const fixture = await createAgentFixture();
  const adapter = new ProcessIdentityFakeAdapter();
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const coordinator = new AgentRuntimeCoordinator({
    storage: fixture.storage,
    registry,
    runtimeHome: fixture.home,
  });
  const run = await coordinator.runTask({
    projectId: fixture.projectId,
    taskId: fixture.taskId,
    expectedTaskVersion: 1,
    commandId: crypto.randomUUID(),
    adapterId: 'fake',
  });
  const tree = 'tree' in options ? options.tree ?? null : await captureProviderProcessTree({
    pid: providerPid,
    startToken: providerStartToken,
    readTable: async () => options.rows ?? [],
    readStartToken: async (pid) => options.tokens?.get(pid) ?? null,
  });
  const write = fixture.storage.recordSessionIncarnation({
    id: crypto.randomUUID(),
    sessionId: run.sessionId,
    mode: 'AUTOMATED_RPC',
    commandId: `automation:${run.sessionId}`,
    providerPid: tree === null ? null : tree.pid,
    processIdentity: { pid: providerPid, executable: 'fake-provider', startToken: providerStartToken,
      argvHash: 'startup-reconcile-argv', capturedAt: 1 },
    processTree: tree,
    providerSessionId: `fake:${run.sessionId}`,
    sessionStorageRef: `${fixture.home}/sessions/fake.jsonl`,
    createdAt: 10,
  });
  return {
    storage: fixture.storage,
    fixture,
    sessionId: run.sessionId,
    executionId: run.executionId,
    incarnationId: write.incarnation.id,
    coordinator,
  };
}

function sessionRow(harness: StaleHarness): {
  readonly state: string;
  readonly current_incarnation_id: string | null;
} {
  const row = harness.storage.sqlite.query<{
    state: string; current_incarnation_id: string | null;
  }, [string]>('SELECT state,current_incarnation_id FROM agent_sessions WHERE id=?1')
    .get(harness.sessionId);
  if (row === null) throw new Error('Session row disappeared');
  return row;
}

function executionRow(harness: StaleHarness): {
  readonly state: string;
  readonly resource_held: number;
} {
  const row = harness.storage.sqlite.query<{
    state: string; resource_held: number;
  }, [string]>('SELECT state,resource_held FROM executions WHERE id=?1').get(harness.executionId);
  if (row === null) throw new Error('Execution row disappeared');
  return row;
}

async function closeHarness(harness: StaleHarness): Promise<void> {
  await harness.coordinator.close();
  harness.storage.close();
}

describe('startup convergence of stale Agent Session projections', () => {
  test('converges a Session whose provider is provably gone without claiming quiescence', async () => {
    const harness = await staleHarness({
      rows: [
        { pid: providerPid, ppid: 1, pgid: providerPid, command: 'fake-provider --mode rpc' },
        { pid: toolChildPid, ppid: providerPid, pgid: toolChildPid, command: 'bash -c sleep 30' },
      ],
      tokens: new Map([[providerPid, providerStartToken], [toolChildPid, toolChildStartToken]]),
    });
    try {
      expect(sessionRow(harness).state).toBe('ACTIVE');
      expect(executionRow(harness)).toMatchObject({ state: 'RUNNING', resource_held: 1 });

      // The default ownership check runs against this machine's real process table, where neither
      // the recorded provider pid nor its recorded descendant exists.
      const results = await reconcileStaleAgentSessions({ storage: harness.storage });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        outcome: 'CONVERGED',
        observation: 'PROVIDER_STOPPED',
        previousSessionState: 'ACTIVE',
        previousExecutionState: 'RUNNING',
        projectedSessionState: 'DISCONNECTED',
        projectedExecutionState: 'RECOVERY_REQUIRED',
      });

      expect(sessionRow(harness).state).toBe('DISCONNECTED');
      expect(sessionRow(harness).current_incarnation_id).toBeNull();
      expect(executionRow(harness)).toMatchObject({ state: 'RECOVERY_REQUIRED', resource_held: 1 });
      expect(harness.storage.getTask(harness.fixture.projectId, harness.fixture.taskId)?.state)
        .toBe('RECOVERY_REQUIRED');

      // The workspace is retained as a failure scene: nothing is deleted and the resource is still
      // held, so only the explicit ADR-0021 reclaim can ever remove it.
      const workspace = harness.storage.sqlite.query<{ state: string }, [string]>(
        'SELECT state FROM workspaces WHERE task_id=?1').get(harness.fixture.taskId);
      expect(workspace?.state).toBe('RECOVERY_REQUIRED');

      const ledger = harness.storage.listAgentSessionStartupReconciliations(harness.sessionId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        observation: 'PROVIDER_STOPPED',
        previousSessionState: 'ACTIVE',
        previousExecutionState: 'RUNNING',
        projectedSessionState: 'DISCONNECTED',
        projectedExecutionState: 'RECOVERY_REQUIRED',
        incarnationId: harness.incarnationId,
      });
      // The audit row states which facts were observed and that quiescence was *not* proven, so a
      // later reader cannot mistake "the provider is gone" for "the workspace is safe to reuse".
      expect(ledger[0]?.evidence).toMatchObject({
        quiescenceProven: false, signalsSent: 0, observation: 'PROVIDER_STOPPED',
      });
      expect(ledger[0]?.detail).toContain('quiescence is still not proven');

      const types = harness.storage.listEventsAfter({ sinceSequence: 0, limit: 200 })
        .map((event) => event.eventType);
      expect(types).toContain('RecoveryRequired');
      expect(types).toContain('AgentSessionStateChanged');
      expect(types).toContain('ExecutionStateChanged');
      expect(types).toContain('TaskStateChanged');
    } finally {
      await closeHarness(harness);
    }
  }, 30_000);

  test('reports a provider that is still running, without signalling or killing it', async () => {
    // A real process: this case is decided against the real process table.
    const sleeping = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
    const startToken = await readStartToken(sleeping.pid);
    const tree = await captureProviderProcessTree({ pid: sleeping.pid, startToken });
    const harness = await staleHarness({ tree });
    try {
      const results = await reconcileStaleAgentSessions({ storage: harness.storage });
      expect(results[0]).toMatchObject({
        outcome: 'CONVERGED',
        observation: 'PROVIDER_STILL_RUNNING',
      });
      expect(results[0]?.detail).toContain('was not signalled');
      // The projection is converged, but the process is untouched: this Runtime has no handle to it,
      // and killing a provider on a guess is not something a reconcile may do.
      expect(isAlive(sleeping.pid)).toBe(true);
      expect(sessionRow(harness).state).toBe('DISCONNECTED');
      expect(executionRow(harness).state).toBe('RECOVERY_REQUIRED');
    } finally {
      sleeping.kill();
      await sleeping.exited;
      await closeHarness(harness);
    }
  }, 30_000);

  test('reports unverifiable ownership instead of assuming the provider is gone', async () => {
    // A recorded descendant whose start token was never captured, occupying a pid that is alive
    // (this test process): the ownership check cannot attribute or clear it, so it must refuse.
    const tree: ProviderProcessTree = {
      pid: 9_900_001,
      startToken: 'never-captured-provider',
      pgid: null,
      descendants: [{ pid: process.pid, startToken: null, command: 'bun test' }],
      capturedAt: 5,
      note: 'synthetic tree for the unverifiable case',
    };
    const harness = await staleHarness({ tree });
    try {
      const results = await reconcileStaleAgentSessions({ storage: harness.storage });
      expect(results[0]).toMatchObject({
        outcome: 'CONVERGED',
        observation: 'PROVIDER_OWNERSHIP_UNVERIFIABLE',
      });
      expect(executionRow(harness).state).toBe('RECOVERY_REQUIRED');
      const ledger = harness.storage.listAgentSessionStartupReconciliations(harness.sessionId);
      expect(ledger[0]?.observation).toBe('PROVIDER_OWNERSHIP_UNVERIFIABLE');
      expect(ledger[0]?.evidence).toMatchObject({ quiescenceProven: false, signalsSent: 0 });
    } finally {
      await closeHarness(harness);
    }
  }, 30_000);

  test('records a missing process identity as its own fact, and reconciles lease residue', async () => {
    const harness = await staleHarness({ tree: null });
    try {
      // No process identity and no tree were recorded, so the projection cannot be trusted in
      // either direction; the active incarnation and its writer lease are residue a restart must
      // not keep claiming.
      harness.storage.sqlite.query(
        'UPDATE session_incarnations SET process_identity_json=NULL,process_tree_json=NULL WHERE session_id=?1',
      ).run(harness.sessionId);
      expect(harness.storage.listLiveSessionIncarnations()).toHaveLength(1);
      expect(harness.storage.getSessionWriterLease(harness.sessionId)).not.toBeNull();

      const results = await reconcileStaleAgentSessions({ storage: harness.storage });
      expect(results[0]).toMatchObject({
        outcome: 'CONVERGED',
        observation: 'PROCESS_IDENTITY_MISSING',
      });

      reconcileSessionHandoffs({ storage: harness.storage });
      expect(harness.storage.listLiveSessionIncarnations()).toHaveLength(0);
      expect(harness.storage.getCurrentSessionIncarnation(harness.sessionId)).toBeNull();
      const leases = harness.storage.listSessionWriterLeases(harness.sessionId);
      expect(leases.length).toBeGreaterThan(0);
      expect(leases.every((lease) => lease.releasedAt !== null)).toBe(true);
      expect(leases.at(-1)?.releaseReason).toBe('RUNTIME_RESTARTED');
      expect(sessionRow(harness).state).toBe('DISCONNECTED');
    } finally {
      await closeHarness(harness);
    }
  }, 30_000);

  test('is idempotent: a repeated startup converges nothing and appends no second audit row', async () => {
    const harness = await staleHarness({ tree: null });
    try {
      const first = await reconcileStaleAgentSessions({ storage: harness.storage });
      expect(first).toHaveLength(1);
      const second = await reconcileStaleAgentSessions({ storage: harness.storage });
      expect(second).toHaveLength(0);
      expect(harness.storage.listAgentSessionStartupReconciliations(harness.sessionId)).toHaveLength(1);
      expect(sessionRow(harness).state).toBe('DISCONNECTED');
      expect(executionRow(harness).state).toBe('RECOVERY_REQUIRED');
    } finally {
      await closeHarness(harness);
    }
  }, 30_000);

  test('never touches a Session this Runtime generation still holds', async () => {
    const harness = await staleHarness({ tree: null });
    try {
      const results = await reconcileStaleAgentSessions({
        storage: harness.storage,
        isHeldByThisRuntime: (sessionId) => sessionId === harness.sessionId,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.outcome).toBe('SKIPPED_HELD_BY_RUNTIME');
      expect(sessionRow(harness).state).toBe('ACTIVE');
      expect(executionRow(harness)).toMatchObject({ state: 'RUNNING', resource_held: 1 });
      expect(harness.storage.listAgentSessionStartupReconciliations(harness.sessionId)).toHaveLength(0);
    } finally {
      await closeHarness(harness);
    }
  }, 30_000);

  test('does not fabricate a running state for a Session that already exited', async () => {
    const harness = await staleHarness({ tree: null });
    try {
      // A terminal Session/Execution pair is not stale, so it is not even considered.
      harness.storage.sqlite.query("UPDATE agent_sessions SET state='EXITED' WHERE id=?1")
        .run(harness.sessionId);
      harness.storage.sqlite.query("UPDATE executions SET state='FAILED',resource_held=0 WHERE id=?1")
        .run(harness.executionId);
      expect(harness.storage.listStaleAgentSessions()).toHaveLength(0);
      const results = await reconcileStaleAgentSessions({ storage: harness.storage });
      expect(results).toHaveLength(0);
      expect(sessionRow(harness).state).toBe('EXITED');
      expect(executionRow(harness).state).toBe('FAILED');
    } finally {
      await closeHarness(harness);
    }
  }, 30_000);
});

async function readStartToken(pid: number): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const token = await readProcessStartToken(pid);
    if (token !== null) return token;
    await Bun.sleep(20);
  }
  throw new Error(`Could not read a start token for pid ${pid}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
