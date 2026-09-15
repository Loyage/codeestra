import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import {
  createRevisionDelivery,
  revisionDeliverySatisfied,
  transitionRevisionDelivery,
  type RevisionDelivery,
} from '@codeestra/domain';
import type { AdapterCapabilities, AgentSessionRef, AgentStartRequest } from '@codeestra/contracts';
import {
  agentAnswerMigration,
  agentConfigurationMigration,
  agentDisconnectMigration,
  agentObservationMigration,
  agentStartMigration,
  impactAnalysisMigration,
  integrationPipelineMigration,
  operationProgressMigration,
  Phase1Database,
  phase1Migration,
  phase1SchemaVersion,
  reclamationMigration,
  sessionHandoffMigration,
  sessionTerminalMigration,
  stablePromotionMigration,
  taskControlMigration,
  taskDependenciesMigration,
  taskVerificationMigration,
  verificationProgressMigration,
  workspaceRetryMigration,
} from '@codeestra/storage';
import { AdapterRegistry } from '../../runtime/src/adapter-registry.js';
import { AgentRuntimeCoordinator } from '../../runtime/src/agent-runtime-service.js';
import {
  RevisionDeliveryService,
  supportsRevisionDelivery,
  type RevisionDeliveryPort,
} from '../../runtime/src/revision-delivery-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  registerTemporaryDirectory,
  type AgentFixture,
} from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

const unsupportedCapabilities: AdapterCapabilities = Object.freeze({
  persistentSession: 'SUPPORTED',
  structuredAttention: 'SUPPORTED',
  nativePermissionRouting: 'SUPPORTED',
  pauseWithQuiescence: 'UNSUPPORTED',
  revisionAcknowledgement: 'UNSUPPORTED',
  cooperativeStop: 'SUPPORTED',
  attach: 'STRUCTURED',
  // This stub starts no provider at all, so it claims neither a native terminal handoff nor a safe
  // point notification: a stub that declared them would make the Runtime's refusal paths untestable.
  nativeTerminalHandoff: 'UNSUPPORTED',
  safePointNotification: 'UNSUPPORTED',
  reconnectToLiveSession: 'UNSUPPORTED',
  resumeAfterExit: 'UNSUPPORTED',
  // Integration fix: this stub asserts runtime orchestration only. `controlledConfiguration` was
  // added by FOUNDATION-049 (ADR-0029) after this lane was based, so the field is declared here too.
  // It says nothing about a real provider's isolation (this stub starts no provider).
  controlledConfiguration: 'SUPPORTED',
});

/**
 * A Session that can be stopped and resumed: it records a provider session file reference (so a
 * successor can reopen the *same* conversation) and can confirm its own release. It is still a
 * scripted Adapter: it proves the Runtime's orchestration, never a real provider integration.
 */
class StoppableSessionAdapter extends DeterministicFakeAdapter implements RevisionDeliveryPort {
  readonly #released = new Set<string>();
  applyRevisionCount = 0;
  ackMode: 'ACK' | 'REFUSE' | 'NEVER' | 'NO_EVIDENCE' = 'ACK';

  constructor(private readonly capabilities: AdapterCapabilities = unsupportedCapabilities) {
    super();
  }

  override async probe(): Promise<{ readonly version: string; readonly capabilities: AdapterCapabilities }> {
    return { version: 'stub-1', capabilities: this.capabilities };
  }

  override async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    const session = await super.start(request);
    const providerSessionId = request.resume?.providerSessionId ?? `stub:${request.sessionId}`;
    return {
      ...session,
      providerSessionId,
      sessionStorageRef: join(request.workspace.cwd, `.session-${providerSessionId}.jsonl`),
      processIdentity: {
        pid: 7_000_001,
        executable: 'stub-provider',
        startToken: 'stub-provider-token',
        argvHash: 'stub-argv',
        capturedAt: 1,
      },
    };
  }

  async releaseSession(sessionId: string): Promise<{ readonly exited: boolean; readonly pid: number } | null> {
    this.#released.add(sessionId);
    return { exited: true, pid: 7_000_001 };
  }

  get releasedSessions(): readonly string[] {
    return [...this.#released];
  }

  async applyRevision(): Promise<{ readonly acknowledged: boolean; readonly evidenceRef?: string;
    readonly detail?: string }> {
    this.applyRevisionCount += 1;
    if (this.ackMode === 'NEVER') return new Promise(() => {});
    if (this.ackMode === 'REFUSE') return { acknowledged: false, detail: 'stub refused the revision' };
    if (this.ackMode === 'NO_EVIDENCE') return { acknowledged: true };
    return { acknowledged: true, evidenceRef: `stub-ack:${this.applyRevisionCount}` };
  }
}

interface Harness {
  readonly fixture: AgentFixture;
  readonly coordinator: AgentRuntimeCoordinator;
  readonly service: RevisionDeliveryService;
  readonly adapter: StoppableSessionAdapter;
  readonly executionId: string;
  readonly sessionId: string;
}

async function harness(options: {
  readonly capabilities?: AdapterCapabilities;
  readonly deadlineMs?: number;
  readonly beforeDelivery?: (harness: Harness) => void;
} = {}): Promise<Harness> {
  const fixture = await createAgentFixture();
  const adapter = new StoppableSessionAdapter(options.capabilities ?? unsupportedCapabilities);
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
  fixture.storage.recordSessionIncarnation({
    id: crypto.randomUUID(),
    sessionId: run.sessionId,
    mode: 'AUTOMATED_RPC',
    commandId: `automation:${run.sessionId}`,
    providerPid: 7_000_001,
    processIdentity: { pid: 7_000_001, executable: 'stub-provider',
      startToken: 'stub-provider-token', argvHash: 'stub-argv', capturedAt: 1 },
    processTree: null,
    providerSessionId: `stub:${run.sessionId}`,
    sessionStorageRef: `${fixture.home}/sessions/stub.jsonl`,
    createdAt: 5,
  });
  const service = new RevisionDeliveryService({
    storage: fixture.storage,
    registry,
    coordinator,
    ...(options.deadlineMs === undefined ? {} : { deliveryDeadlineMs: options.deadlineMs }),
  });
  const value: Harness = {
    fixture,
    coordinator,
    service,
    adapter,
    executionId: run.executionId,
    sessionId: run.sessionId,
  };
  options.beforeDelivery?.(value);
  return value;
}

const createRevision = (value: Harness, specification: string) => value.service.createRevision({
  projectId: value.fixture.projectId,
  taskId: value.fixture.taskId,
  expectedVersion: value.fixture.storage
    .getTask(value.fixture.projectId, value.fixture.taskId)?.version ?? 0,
  commandId: crypto.randomUUID(),
  specification,
  constraints: [],
  reason: 'test revision',
  actor: 'local-user',
});

/** The domain rejects with a stable code; the message is for humans, so the code is asserted. */
function expectDomainCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}, but no error was thrown`);
  } catch (error) {
    expect((error as { readonly code?: string }).code).toBe(code);
  }
}

describe('revision delivery schema (v19)', () => {
  test('upgrades an existing database additively, including one that skipped version 16', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-v19-'));
    registerTemporaryDirectory(directory);
    const steps = [
      phase1Migration, agentStartMigration, agentObservationMigration, agentAnswerMigration,
      agentDisconnectMigration, taskVerificationMigration, workspaceRetryMigration,
      agentConfigurationMigration, taskControlMigration, integrationPipelineMigration,
      operationProgressMigration, reclamationMigration, stablePromotionMigration,
      sessionHandoffMigration, taskDependenciesMigration, verificationProgressMigration,
      sessionTerminalMigration, impactAnalysisMigration,
    ];
    // `count` migrations were already applied and the database is stamped with `stamp`. The second
    // case is a database that skipped version 16 entirely: version 16 stays permanently unused, so
    // the upgrade must still run the 17/18/19 steps instead of looking for a `version < 16` branch.
    for (const [count, stamp] of [[17, 18], [15, 16]] as const) {
      const path = join(directory, `${count}.sqlite`);
      const raw = new Database(path, { create: true });
      for (const sql of steps.slice(0, count)) raw.exec(sql);
      raw.exec(`PRAGMA user_version=${stamp}`);
      raw.query("INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,object_format,policy_version,created_at) VALUES ('p-1','kept','/tmp/r','/tmp/g','refs/heads/main','sha1',1,1)").run();
      raw.query(`INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,occurred_at,payload_json) VALUES ('e-1','p-1','Kept',1,'Task','t-1',0,'c-1',1,'{}')`).run();
      raw.close();

      const storage = new Phase1Database(path);
      expect(phase1SchemaVersion).toBe(24);
      // The pinned version is the schema the migration runner targets, not this lane's own step: a
      // later additive migration must not make this assertion wrong.
      expect(storage.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
        .toBe(phase1SchemaVersion);
      expect(storage.sqlite.query<{ id: string }, []>('SELECT id FROM projects').all())
        .toEqual([{ id: 'p-1' }]);
      expect(storage.sqlite.query<{ event_id: string }, []>('SELECT event_id FROM domain_events').all())
        .toEqual([{ event_id: 'e-1' }]);
      const tables = storage.sqlite.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
      expect(tables).toContain('task_revision_deliveries');
      expect(tables).toContain('task_revision_delivery_attempts');
      expect(tables).toContain('agent_session_startup_reconciliations');
      expect(storage.sqlite.query('PRAGMA foreign_key_check').all()).toHaveLength(0);
      // The delivery state CHECK keeps an acknowledgement and its timestamp together, so a row can
      // never look acknowledged without having been acknowledged.
      expect(() => storage.sqlite.query(`
        INSERT INTO task_revision_deliveries(id,project_id,task_id,revision_id,state,attempt_count,
          created_at,updated_at)
        VALUES ('d-1','p-1','t-1','r-1','ACKNOWLEDGED',0,1,1)
      `).run()).toThrow();
      storage.close();
    }
    rmSync(directory, { recursive: true, force: true });
  });
});

describe('revision delivery FSM', () => {
  test('is satisfied only by a real acknowledgement or a verified successor Execution', () => {
    expect(revisionDeliverySatisfied('ACKNOWLEDGED')).toBe(true);
    expect(revisionDeliverySatisfied('SUPERSEDED_BY_RESTART')).toBe(true);
    for (const state of ['PENDING', 'IN_FLIGHT', 'UNACKNOWLEDGED', 'CHANNEL_UNSUPPORTED',
      'TIMED_OUT', 'FAILED'] as const) {
      // "The message was sent" is never a delivery: an in-flight or unconfirmed attempt stays
      // unsatisfied so the caller has to dispose of it explicitly.
      expect(revisionDeliverySatisfied(state)).toBe(false);
    }
  });

  test('refuses a stale acknowledgement and a second acknowledgement', () => {
    const base = (): RevisionDelivery => createRevisionDelivery({
      id: 'delivery-1', taskId: 'task-1', revisionId: 'revision-2',
    });
    const inFlight = transitionRevisionDelivery(base(), 0, {
      type: 'ATTEMPT_STARTED', channel: 'PROVIDER_CONVERSATION',
    });
    expect(inFlight.state).toBe('IN_FLIGHT');
    // The acknowledgement names a different revision than the delivery: stale by construction.
    expectDomainCode(() => transitionRevisionDelivery(inFlight, 1, {
      type: 'ACKNOWLEDGED', revisionId: 'revision-3', requiredRevisionId: 'revision-3',
      evidenceRef: 'ack',
    }), 'STALE_REVISION_ACKNOWLEDGEMENT');
    // The acknowledgement is for this revision, but the Task already moved on to another one.
    expectDomainCode(() => transitionRevisionDelivery(inFlight, 1, {
      type: 'ACKNOWLEDGED', revisionId: 'revision-2', requiredRevisionId: 'revision-3',
      evidenceRef: 'ack',
    }), 'STALE_REVISION_ACKNOWLEDGEMENT');
    // An acknowledgement without evidence is not an acknowledgement.
    expectDomainCode(() => transitionRevisionDelivery(inFlight, 1, {
      type: 'ACKNOWLEDGED', revisionId: 'revision-2', requiredRevisionId: 'revision-2',
      evidenceRef: '',
    }), 'INVALID_VALUE');
    const acknowledged = transitionRevisionDelivery(inFlight, 1, {
      type: 'ACKNOWLEDGED', revisionId: 'revision-2', requiredRevisionId: 'revision-2',
      evidenceRef: 'ack-1',
    });
    expect(acknowledged).toMatchObject({ state: 'ACKNOWLEDGED', evidenceRef: 'ack-1' });
    expectDomainCode(() => transitionRevisionDelivery(acknowledged, 2, {
      type: 'ACKNOWLEDGED', revisionId: 'revision-2', requiredRevisionId: 'revision-2',
      evidenceRef: 'ack-2',
    }), 'REVISION_ALREADY_ACKNOWLEDGED');
    expectDomainCode(() => transitionRevisionDelivery(acknowledged, 2, {
      type: 'ATTEMPT_STARTED', channel: 'PROVIDER_CONVERSATION',
    }), 'REVISION_ALREADY_ACKNOWLEDGED');
  });

  test('refuses a restart that claims a revision the successor was not recorded with', () => {
    const delivery = createRevisionDelivery({ id: 'delivery-1', taskId: 'task-1',
      revisionId: 'revision-2' });
    expectDomainCode(() => transitionRevisionDelivery(delivery, 0, {
      type: 'SUPERSEDED_BY_RESTART', successorExecutionId: 'exec-2', successorRevisionId: 'revision-9',
    }), 'SUCCESSOR_REVISION_MISMATCH');
    const resolved = transitionRevisionDelivery(delivery, 0, {
      type: 'SUPERSEDED_BY_RESTART', successorExecutionId: 'exec-2', successorRevisionId: 'revision-2',
    });
    expect(resolved.state).toBe('SUPERSEDED_BY_RESTART');
    expect(revisionDeliverySatisfied(resolved.state)).toBe(true);
  });
});

describe('revision delivery at the Runtime boundary', () => {
  test('records an unsupported channel instead of claiming the conversation was updated', async () => {
    const value = await harness();
    try {
      const created = await createRevision(value, 'Add a cache layer');
      expect(created.revision.revisionNumber).toBe(2);
      expect(created.delivery).not.toBeNull();
      expect(created.delivery).toMatchObject({
        state: 'CHANNEL_UNSUPPORTED',
        satisfied: false,
        channel: 'PROVIDER_CONVERSATION',
        capability: 'UNSUPPORTED',
        executionId: value.executionId,
        sessionId: value.sessionId,
      });
      // The delivery is not satisfied by sending anything, and the attempt ledger says where the
      // revision was aimed and how the attempt ended.
      const delivery = value.service.getDelivery(value.fixture.projectId, created.delivery!.deliveryId);
      expect(delivery.satisfied).toBe(false);
      expect(delivery.stale).toBe(false);
      expect(delivery.attempts).toHaveLength(1);
      expect(delivery.attempts[0]).toMatchObject({
        attemptNumber: 1,
        channel: 'PROVIDER_CONVERSATION',
        state: 'CHANNEL_UNSUPPORTED',
        executionId: value.executionId,
        sessionId: value.sessionId,
        evidenceRef: 'capability:UNSUPPORTED',
      });
      expect(delivery.attempts[0]?.endedAt).not.toBeNull();
      expect(delivery.attempts[0]?.startedAt).toBeGreaterThanOrEqual(0);

      // The revision is recorded on the Task, but the running Execution still carries the old one.
      const task = value.fixture.storage.getTask(value.fixture.projectId, value.fixture.taskId);
      expect(task?.currentRevision.id).toBe(created.revision.revisionId);
      const execution = value.fixture.storage
        .listTaskExecutions(value.fixture.projectId, value.fixture.taskId)
        .find((candidate) => candidate.executionId === value.executionId);
      expect(execution?.revisionId).toBe(value.fixture.revisionId);
      expect(execution?.revisionId).not.toBe(task?.currentRevision.id);

      // A result commit for the old revision is refused: the unconfirmed revision cannot be
      // delivered as evidence of the new specification.
      expect(() => value.fixture.storage.getResultCommitSubject(
        value.fixture.projectId, value.fixture.taskId, value.executionId))
        .not.toThrow();
      const subject = value.fixture.storage.getResultCommitSubject(
        value.fixture.projectId, value.fixture.taskId, value.executionId);
      expect(subject.currentRevisionId).not.toBe(subject.appliedRevisionId);

      const events = value.fixture.storage.listEventsAfter({ sinceSequence: 0, limit: 200 });
      const types = events.map((event) => event.eventType);
      expect(types).toContain('TaskRevisionCreated');
      expect(types).toContain('TaskRevisionDeliveryRecorded');
      expect(types).toContain('TaskRevisionDeliveryAttempted');
      expect(types).toContain('TaskRevisionDeliveryResolved');
    } finally {
      await value.coordinator.close();
      value.fixture.storage.close();
    }
  }, 30_000);

  test('records an acknowledgement only when the channel really acknowledged', async () => {
    const capable: AdapterCapabilities = { ...unsupportedCapabilities,
      revisionAcknowledgement: 'SUPPORTED' };
    const value = await harness({ capabilities: capable });
    try {
      const created = await createRevision(value, 'Rename the service');
      expect(created.delivery).toMatchObject({ state: 'ACKNOWLEDGED', satisfied: true,
        capability: 'SUPPORTED' });
      const delivery = value.service.getDelivery(value.fixture.projectId, created.delivery!.deliveryId);
      expect(delivery.state).toBe('ACKNOWLEDGED');
      expect(delivery.evidenceRef).toBe('stub-ack:1');
      expect(delivery.acknowledgedAt).not.toBeNull();
      expect(delivery.attempts[0]).toMatchObject({ state: 'ACKNOWLEDGED', evidenceRef: 'stub-ack:1' });
      // The Adapter is asked exactly once for this revision; nothing re-sends it.
      expect(value.adapter.applyRevisionCount).toBe(1);
    } finally {
      await value.coordinator.close();
      value.fixture.storage.close();
    }
  }, 30_000);

  test('rejects a stale acknowledgement when the Task has already moved on', async () => {
    const capable: AdapterCapabilities = { ...unsupportedCapabilities,
      revisionAcknowledgement: 'SUPPORTED' };
    const value = await harness({ capabilities: capable });
    try {
      // The first revision needs a new attempt to acknowledge; the second moves the Task on.
      const adapter = value.adapter;
      adapter.ackMode = 'REFUSE';
      const first = await createRevision(value, 'First change');
      expect(first.delivery).toMatchObject({ state: 'UNACKNOWLEDGED', satisfied: false });
      adapter.ackMode = 'ACK';
      const second = await createRevision(value, 'Second change');
      expect(second.delivery).toMatchObject({ state: 'ACKNOWLEDGED', satisfied: true });

      // A late acknowledgement of the first revision cannot be recorded: the Task is on the second.
      const attemptId = crypto.randomUUID();
      value.fixture.storage.beginRevisionDeliveryAttempt({
        projectId: value.fixture.projectId,
        commandId: crypto.randomUUID(),
        payloadHash: 'late-attempt',
        deliveryId: first.delivery!.deliveryId,
        attemptId,
        channel: 'PROVIDER_CONVERSATION',
        detail: 'late acknowledgement attempt',
        deadlineAt: Date.now() + 5_000,
        eventId: crypto.randomUUID(),
        startedAt: Date.now(),
      });
      expectDomainCode(() => value.fixture.storage.completeRevisionDeliveryAttempt({
        projectId: value.fixture.projectId,
        commandId: crypto.randomUUID(),
        payloadHash: 'late-ack',
        deliveryId: first.delivery!.deliveryId,
        attemptId,
        state: 'ACKNOWLEDGED',
        evidenceRef: 'late-ack-evidence',
        errorCode: null,
        detail: 'late acknowledgement',
        eventId: crypto.randomUUID(),
        completedAt: Date.now(),
      }), 'STALE_REVISION_ACKNOWLEDGEMENT');
      const unchanged = value.service.getDelivery(value.fixture.projectId, first.delivery!.deliveryId);
      expect(unchanged.satisfied).toBe(false);
      expect(unchanged.state).toBe('IN_FLIGHT');
    } finally {
      await value.coordinator.close();
      value.fixture.storage.close();
    }
  }, 30_000);

  test('records a timeout when no acknowledgement arrives in time', async () => {
    const capable: AdapterCapabilities = { ...unsupportedCapabilities,
      revisionAcknowledgement: 'SUPPORTED' };
    const value = await harness({ capabilities: capable, deadlineMs: 40 });
    try {
      value.adapter.ackMode = 'NEVER';
      const created = await createRevision(value, 'Slow revision');
      expect(created.delivery).toMatchObject({ state: 'TIMED_OUT', satisfied: false,
        capability: 'SUPPORTED' });
      const delivery = value.service.getDelivery(value.fixture.projectId, created.delivery!.deliveryId);
      expect(delivery.attempts[0]).toMatchObject({ state: 'TIMED_OUT' });
      expect(delivery.attempts[0]?.detail).toContain('no acknowledgement arrived');
      expect(delivery.evidenceRef).toBeNull();
    } finally {
      await value.coordinator.close();
      value.fixture.storage.close();
    }
  }, 30_000);

  test('refuses to treat an acknowledgement without evidence as a delivery', async () => {
    const capable: AdapterCapabilities = { ...unsupportedCapabilities,
      revisionAcknowledgement: 'SUPPORTED' };
    const value = await harness({ capabilities: capable });
    try {
      value.adapter.ackMode = 'NO_EVIDENCE';
      const created = await createRevision(value, 'Evidence-free revision');
      expect(created.delivery).toMatchObject({ state: 'UNACKNOWLEDGED', satisfied: false });
      const delivery = value.service.getDelivery(value.fixture.projectId, created.delivery!.deliveryId);
      expect(delivery.attempts[0]?.errorCode).toBe('MISSING_ACK_EVIDENCE');
    } finally {
      await value.coordinator.close();
      value.fixture.storage.close();
    }
  }, 30_000);

  test('a retry on an Adapter without an acknowledgement channel stays unsatisfied', async () => {
    const value = await harness();
    try {
      const created = await createRevision(value, 'Retry target');
      const task = value.fixture.storage.getTask(value.fixture.projectId, value.fixture.taskId);
      const resolved = await value.service.resolveDelivery({
        projectId: value.fixture.projectId,
        taskId: value.fixture.taskId,
        deliveryId: created.delivery!.deliveryId,
        action: 'RETRY',
        expectedVersion: task?.version ?? 0,
        commandId: crypto.randomUUID(),
        adapterId: 'fake',
        actor: 'local-user',
      });
      expect(resolved.outcome).toBe('UNSATISFIED');
      expect(resolved.delivery.satisfied).toBe(false);
      expect(resolved.delivery.attemptCount).toBe(2);
      expect(resolved.delivery.attempts.map((attempt) => attempt.state))
        .toEqual(['CHANNEL_UNSUPPORTED', 'CHANNEL_UNSUPPORTED']);
    } finally {
      await value.coordinator.close();
      value.fixture.storage.close();
    }
  }, 30_000);

  test('stop-and-restart satisfies the delivery from the successor Execution row', async () => {
    const value = await harness();
    try {
      const created = await createRevision(value, 'Restart onto this revision');
      const task = value.fixture.storage.getTask(value.fixture.projectId, value.fixture.taskId);
      const resolved = await value.service.resolveDelivery({
        projectId: value.fixture.projectId,
        taskId: value.fixture.taskId,
        deliveryId: created.delivery!.deliveryId,
        action: 'STOP_AND_RESTART',
        expectedVersion: task?.version ?? 0,
        commandId: crypto.randomUUID(),
        adapterId: 'fake',
        actor: 'local-user',
      });
      expect(resolved.outcome).toBe('SUPERSEDED_BY_RESTART');
      expect(resolved.delivery.satisfied).toBe(true);
      expect(resolved.delivery.state).toBe('SUPERSEDED_BY_RESTART');
      expect(resolved.successorExecutionId).not.toBeNull();
      expect(resolved.predecessorExecutionId).toBe(value.executionId);

      const executions = value.fixture.storage
        .listTaskExecutions(value.fixture.projectId, value.fixture.taskId);
      const predecessor = executions.find((entry) => entry.executionId === value.executionId);
      const successor = executions.find((entry) => entry.executionId === resolved.successorExecutionId);
      expect(predecessor).toMatchObject({ state: 'SUPERSEDED', stopReason: 'USER_PAUSE' });
      expect(successor?.revisionId).toBe(created.revision.revisionId);
      expect(successor?.resourceHeld).toBe(true);
      // The proof recorded in the delivery is the successor's own revision, not a Runtime claim.
      expect(resolved.delivery.evidenceRef).toBe(`execution:${successor?.executionId}`);
      expect(resolved.delivery.attempts.at(-1)).toMatchObject({
        channel: 'STOP_AND_RESTART', state: 'SUPERSEDED_BY_RESTART',
      });
      expect(value.adapter.releasedSessions.length).toBeGreaterThan(0);

      // Replaying the disposition is a no-op rather than a second restart.
      const replay = await value.service.resolveDelivery({
        projectId: value.fixture.projectId,
        taskId: value.fixture.taskId,
        deliveryId: created.delivery!.deliveryId,
        action: 'STOP_AND_RESTART',
        expectedVersion: task?.version ?? 0,
        commandId: crypto.randomUUID(),
        adapterId: 'fake',
        actor: 'local-user',
      });
      expect(replay.outcome).toBe('ALREADY_SATISFIED');
      expect(value.fixture.storage.listTaskExecutions(value.fixture.projectId, value.fixture.taskId))
        .toHaveLength(2);
    } finally {
      await value.coordinator.close();
      value.fixture.storage.close();
    }
  }, 30_000);

  test('refuses a restart whose successor would carry a later revision than the delivery', async () => {
    const value = await harness();
    try {
      const first = await createRevision(value, 'First revision');
      const second = await createRevision(value, 'Second revision');
      const task = value.fixture.storage.getTask(value.fixture.projectId, value.fixture.taskId);
      await expect(value.service.resolveDelivery({
        projectId: value.fixture.projectId,
        taskId: value.fixture.taskId,
        deliveryId: first.delivery!.deliveryId,
        action: 'STOP_AND_RESTART',
        expectedVersion: task?.version ?? 0,
        commandId: crypto.randomUUID(),
        adapterId: 'fake',
        actor: 'local-user',
      })).rejects.toMatchObject({ code: 'SUCCESSOR_REVISION_MISMATCH' });
      // Nothing was paused, nothing was started, and both deliveries keep their honest state.
      expect(value.fixture.storage.getTask(value.fixture.projectId, value.fixture.taskId)?.state)
        .toBe('RUNNING');
      expect(value.fixture.storage.listTaskExecutions(value.fixture.projectId, value.fixture.taskId))
        .toHaveLength(1);
      expect(value.service.getDelivery(value.fixture.projectId, first.delivery!.deliveryId).satisfied)
        .toBe(false);
      expect(value.service.getDelivery(value.fixture.projectId, second.delivery!.deliveryId).satisfied)
        .toBe(false);
    } finally {
      await value.coordinator.close();
      value.fixture.storage.close();
    }
  }, 30_000);

  test('records no requirement when nothing is running, and merges constraint-only revisions', async () => {
    // No Execution at all: a revision is a specification change, and there is nothing to deliver it to.
    const fixture = await createAgentFixture();
    const adapter = new StoppableSessionAdapter();
    const registry = new AdapterRegistry();
    registry.register(adapter);
    const coordinator = new AgentRuntimeCoordinator({ storage: fixture.storage, registry,
      runtimeHome: fixture.home });
    const service = new RevisionDeliveryService({ storage: fixture.storage, registry, coordinator });
    try {
      const first = await service.createRevision({
        projectId: fixture.projectId,
        taskId: fixture.taskId,
        expectedVersion: 1,
        commandId: crypto.randomUUID(),
        constraints: [{ id: 'constraint-1', text: 'must be fast' }],
        reason: 'add a constraint',
        actor: 'local-user',
      });
      expect(first.delivery).toBeNull();
      expect(first.revision.executionId).toBeNull();
      expect(service.listDeliveries(fixture.projectId, fixture.taskId)).toHaveLength(0);
      const revisions = service.listRevisions(fixture.projectId, fixture.taskId);
      expect(revisions.map((revision) => revision.number)).toEqual([1, 2]);
      // The specification is carried over unchanged and the constraint is appended.
      expect(revisions[1]?.specification).toBe(revisions[0]?.specification);
      expect(revisions[1]?.constraints).toEqual([{ id: 'constraint-1', text: 'must be fast' }]);
      // A second constraint-only revision keeps the earlier constraint instead of replacing it.
      const second = await service.createRevision({
        projectId: fixture.projectId,
        taskId: fixture.taskId,
        expectedVersion: first.revision.taskVersion,
        commandId: crypto.randomUUID(),
        constraints: [{ id: 'constraint-2', text: 'and observable' }],
        reason: 'add another constraint',
        actor: 'local-user',
      });
      expect(second.revision.revisionNumber).toBe(3);
      expect(service.listRevisions(fixture.projectId, fixture.taskId)[2]?.constraints)
        .toEqual([{ id: 'constraint-1', text: 'must be fast' },
          { id: 'constraint-2', text: 'and observable' }]);
      // A revision with nothing to change is refused rather than recorded as an empty amendment.
      await expect(service.createRevision({
        projectId: fixture.projectId,
        taskId: fixture.taskId,
        expectedVersion: second.revision.taskVersion,
        commandId: crypto.randomUUID(),
        constraints: [],
        reason: 'nothing',
        actor: 'local-user',
      })).rejects.toMatchObject({ code: 'INVALID_REVISION' });
      // A duplicate constraint ID is refused too.
      await expect(service.createRevision({
        projectId: fixture.projectId,
        taskId: fixture.taskId,
        expectedVersion: second.revision.taskVersion,
        commandId: crypto.randomUUID(),
        constraints: [{ id: 'constraint-1', text: 'again' }],
        reason: 'duplicate',
        actor: 'local-user',
      })).rejects.toMatchObject({ code: 'INVALID_REVISION' });
    } finally {
      await coordinator.close();
      fixture.storage.close();
    }
  }, 30_000);

  test('concludes an attempt a restart interrupted, and one whose deadline passed', async () => {
    const value = await harness();
    try {
      const created = await createRevision(value, 'Interrupted revision');
      const deliveryId = created.delivery!.deliveryId;
      // A second attempt that never concluded (as if the Runtime had been killed mid-attempt).
      const interrupted = crypto.randomUUID();
      value.fixture.storage.beginRevisionDeliveryAttempt({
        projectId: value.fixture.projectId,
        commandId: crypto.randomUUID(),
        payloadHash: 'interrupted-attempt',
        deliveryId,
        attemptId: interrupted,
        channel: 'PROVIDER_CONVERSATION',
        detail: 'attempt interrupted by a Runtime restart',
        deadlineAt: Date.now() + 60_000,
        eventId: crypto.randomUUID(),
        startedAt: Date.now(),
      });
      const results = value.service.reconcileAtStartup();
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ attemptId: interrupted, outcome: 'RECOVERY_REQUIRED' });
      expect(results[0]?.detail).toContain('RUNTIME_RESTARTED');
      const delivery = value.service.getDelivery(value.fixture.projectId, deliveryId);
      expect(delivery.satisfied).toBe(false);
      expect(delivery.state).toBe('FAILED');
      expect(delivery.attempts.at(-1)).toMatchObject({
        state: 'FAILED', errorCode: 'RUNTIME_RESTARTED', endedAt: expect.any(Number),
      });
      expect(value.fixture.storage.listInFlightRevisionDeliveryAttempts()).toHaveLength(0);
      // A restart is not a retry loop: a second startup has nothing left to conclude.
      expect(value.service.reconcileAtStartup()).toHaveLength(0);
    } finally {
      await value.coordinator.close();
      value.fixture.storage.close();
    }
  }, 30_000);

  test('records an expired in-flight attempt as a timeout at startup', async () => {
    const value = await harness();
    try {
      const created = await createRevision(value, 'Expired revision');
      const attemptId = crypto.randomUUID();
      value.fixture.storage.beginRevisionDeliveryAttempt({
        projectId: value.fixture.projectId,
        commandId: crypto.randomUUID(),
        payloadHash: 'expired-attempt',
        deliveryId: created.delivery!.deliveryId,
        attemptId,
        channel: 'PROVIDER_CONVERSATION',
        detail: 'attempt whose deadline already passed',
        // The deadline is already behind us while the attempt itself was opened just now, which is
        // exactly the state a reconciliation finds after the deadline elapsed unnoticed.
        deadlineAt: Date.now() - 1_000,
        eventId: crypto.randomUUID(),
        startedAt: Date.now(),
      });
      const results = value.service.reconcileAtStartup();
      expect(results[0]).toMatchObject({ attemptId, outcome: 'TIMED_OUT' });
      const delivery = value.service.getDelivery(value.fixture.projectId,
        created.delivery!.deliveryId);
      expect(delivery.state).toBe('TIMED_OUT');
      expect(delivery.satisfied).toBe(false);
    } finally {
      await value.coordinator.close();
      value.fixture.storage.close();
    }
  }, 30_000);

  test('requires the capability and the port to agree before any attempt is called', async () => {
    // The port exists but the Adapter reports UNSUPPORTED: the honest record is the capability.
    const value = await harness();
    try {
      expect(supportsRevisionDelivery(value.adapter)).toBe(true);
      const created = await createRevision(value, 'Capability mismatch');
      expect(created.delivery?.capability).toBe('UNSUPPORTED');
      expect(value.adapter.applyRevisionCount).toBe(0);
    } finally {
      await value.coordinator.close();
      value.fixture.storage.close();
    }
  }, 30_000);
});

describe('revision delivery through the CLI and the Runtime', () => {
  test('creates a revision, reports the unconfirmed delivery, and restarts onto it', async () => {
    const fixture = await cliFixture();
    const { environment, projectId } = fixture;
    try {
      const created = JSON.parse((await cli(['task', 'create', projectId, 'Write a file'],
        environment)).stdout) as { readonly id: string };
      const taskId = created.id;
      expect((await cli(['task', 'submit', projectId, taskId, '0'], environment)).exitCode).toBe(0);
      const ran = await cli(['task', 'run', projectId, taskId, '1'], environment);
      expect(ran.exitCode).toBe(0);
      // The stub settles its turn (like a real provider finishing one turn) and stays alive; the
      // Session projection is what the Runtime observed, and the Execution still holds the Task.
      await waitFor(async () => (await taskStatus(environment, projectId, taskId))
        .executions[0]?.session?.state === 'EXITED', 'the stub Session to settle its turn');

      // A new revision while the Session is live: the Adapter reports no acknowledgement channel, so
      // the delivery is recorded and left unconfirmed instead of being claimed as delivered.
      const revision = await cli(['task', 'revision', 'create', projectId, taskId, '2',
        '--specification', 'Write a different file', '--reason', 'narrow the scope'], environment);
      expect(revision.exitCode).toBe(0);
      const revisionResult = JSON.parse(revision.stdout) as {
        readonly revision: { readonly revisionId: string; readonly revisionNumber: number;
          readonly taskVersion: number };
        readonly delivery: { readonly deliveryId: string; readonly state: string;
          readonly satisfied: boolean; readonly capability: string } | null;
      };
      expect(revisionResult.revision.revisionNumber).toBe(2);
      expect(revisionResult.delivery).toMatchObject({
        state: 'CHANNEL_UNSUPPORTED', satisfied: false, capability: 'UNSUPPORTED',
      });
      const deliveryId = revisionResult.delivery!.deliveryId;

      // The delivery is readable, with its channel, subject and outcome.
      const listed = JSON.parse((await cli(['task', 'revision', 'delivery', 'list', projectId, taskId],
        environment)).stdout) as readonly {
        readonly id: string; readonly state: string; readonly satisfied: boolean;
        readonly revisionNumber: number;
        readonly attempts: readonly { readonly channel: string; readonly state: string;
          readonly evidenceRef: string | null }[];
      }[];
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: deliveryId, state: 'CHANNEL_UNSUPPORTED',
        satisfied: false, revisionNumber: 2 });
      expect(listed[0]?.attempts[0]).toMatchObject({ channel: 'PROVIDER_CONVERSATION',
        state: 'CHANNEL_UNSUPPORTED', evidenceRef: 'capability:UNSUPPORTED' });

      const revisions = JSON.parse((await cli(['task', 'revision', 'list', projectId, taskId],
        environment)).stdout) as { readonly revisions: readonly { readonly number: number;
          readonly current: boolean }[]; readonly deliveries: readonly unknown[] };
      expect(revisions.revisions.map((entry) => entry.number)).toEqual([1, 2]);
      expect(revisions.revisions[1]?.current).toBe(true);

      // The old revision's result commit is no longer acceptable evidence for the Task.
      const staleCapture = await cli(['task', 'result', 'capture', projectId, taskId], environment);
      expect(staleCapture.exitCode).toBe(1);
      expect(staleCapture.stderr).toContain('STALE_REVISION');

      // A retry cannot confirm anything on this Adapter, and the exit code says so.
      const taskVersion = String(revisionResult.revision.taskVersion);
      const retry = await cli(['task', 'revision', 'delivery', 'resolve', projectId, taskId,
        deliveryId, taskVersion, '--action', 'retry'], environment);
      expect(retry.exitCode).toBe(1);
      expect(JSON.parse(retry.stdout)).toMatchObject({ outcome: 'UNSATISFIED' });

      // The explicit disposition stops the predecessor and starts a successor on the new revision.
      const resolved = await cli(['task', 'revision', 'delivery', 'resolve', projectId, taskId,
        deliveryId, taskVersion, '--action', 'stop-and-restart'], environment);
      expect(resolved.exitCode).toBe(0);
      const resolvedPayload = JSON.parse(resolved.stdout) as {
        readonly outcome: string;
        readonly successorExecutionId: string | null;
        readonly delivery: { readonly satisfied: boolean; readonly state: string };
      };
      expect(resolvedPayload.outcome).toBe('SUPERSEDED_BY_RESTART');
      expect(resolvedPayload.successorExecutionId).not.toBeNull();
      expect(resolvedPayload.delivery).toMatchObject({ satisfied: true,
        state: 'SUPERSEDED_BY_RESTART' });

      const after = await taskStatus(environment, projectId, taskId);
      expect(after.executions).toHaveLength(2);
      const successor = after.executions
        .find((entry) => entry.executionId === resolvedPayload.successorExecutionId);
      expect(successor?.revisionId).toBe(revisionResult.revision.revisionId);
      expect(successor?.state).toBe('RUNNING');

      const readBack = JSON.parse((await cli(['task', 'revision', 'delivery', 'get', projectId,
        deliveryId], environment)).stdout) as {
        readonly satisfied: boolean; readonly stale: boolean;
      };
      expect(readBack).toMatchObject({ satisfied: true, stale: false });
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);
});

interface TaskStatusExecutions {
  readonly executions: readonly {
    readonly executionId: string;
    readonly state: string;
    readonly revisionId: string;
    readonly session: { readonly state: string } | null;
  }[];
}

async function taskStatus(
  environment: Record<string, string>,
  projectId: string,
  taskId: string,
): Promise<TaskStatusExecutions> {
  const status = await cli(['task', 'status', projectId, taskId], environment);
  expect(status.exitCode).toBe(0);
  return JSON.parse(status.stdout) as TaskStatusExecutions;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  const child = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd: repositoryRoot,
    env: { ...Bun.env, ...environment, no_proxy: '127.0.0.1,localhost' },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Revision Test',
      GIT_AUTHOR_EMAIL: 'revision@example.invalid', GIT_COMMITTER_NAME: 'Revision Test',
      GIT_COMMITTER_EMAIL: 'revision@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

/**
 * A protocol stub, not a real provider. It writes one file, settles its turn, and then stays alive
 * (keeping the Session ACTIVE) so the revision-delivery paths can be driven headlessly. It proves the
 * Runtime's command face and orchestration, never that a real Agent integration acknowledges a
 * revision.
 */
const stubSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const sessionDirIndex = argv.indexOf('--session-dir');
const sessionDir = sessionDirIndex >= 0 ? argv[sessionDirIndex + 1] : process.cwd();
const sessionIndex = argv.indexOf('--session');
const provided = sessionIndex >= 0 ? argv[sessionIndex + 1] : null;
mkdirSync(sessionDir, { recursive: true });
const sessionFile = provided !== null && provided.endsWith('.jsonl')
  ? provided : join(sessionDir, 'revision-session.jsonl');
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
let turns = 0;

let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line);
    if (record.type === 'get_state') {
      emit({ id: record.id, type: 'response', command: 'get_state', success: true, data: {
        sessionId: 'revision-session', sessionFile, messageCount: turns } });
    } else if (record.type === 'prompt') {
      turns += 1;
      writeFileSync(join(process.cwd(), 'agent-output.txt'), 'work\\n');
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'revision-session', timestamp: '2026-09-13T09:00:00.000Z',
        cwd: process.cwd() }) + '\\n');
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Wrote the file.' }], stopReason: 'stop' } });
      emit({ type: 'agent_settled' });
    }
  }
}
`;

async function cliFixture(): Promise<{ readonly environment: Record<string, string>;
  readonly repository: string; readonly projectId: string }> {
  const repository = mkdtempSync(join(tmpdir(), 'codeestra-revision-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'codeestra-revision-home-'));
  const tools = mkdtempSync(join(tmpdir(), 'codeestra-revision-tools-'));
  const assets = mkdtempSync(join(tmpdir(), 'codeestra-revision-assets-'));
  registerTemporaryDirectory(repository);
  registerTemporaryDirectory(home);
  registerTemporaryDirectory(tools);
  registerTemporaryDirectory(assets);
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'),
    JSON.stringify({ version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.',
      timeoutSeconds: 60 }] }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  await git(repository, ['branch', 'dev']);

  const stubPath = join(tools, 'stub-pi.ts');
  const shimPath = join(tools, 'pi');
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);

  const environment = {
    CODEESTRA_HOME: home,
    CODEESTRA_UI_DIST: assets,
    CODEESTRA_PI_EXECUTABLE: shimPath,
  };
  const opened = await cli(['open', repository, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  return { environment, repository, projectId: projects[0]?.id as string };
}

async function waitFor(predicate: () => Promise<boolean>, message: string,
  timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for: ${message}`);
}
