import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import type { AdapterCapabilities, AgentSessionRef, AgentStartRequest } from '@codeestra/contracts';
import type { SessionGuidanceRecord } from '@codeestra/storage';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import { RevisionDeliveryService } from '../src/revision-delivery-service.js';
import {
  SessionGuidanceService,
  supportsGuidanceDelivery,
  type GuidanceDeliveryPort,
} from '../src/session-guidance-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  type AgentFixture,
} from './support/agent-fixture.js';

/**
 * What this file proves: the Runtime side of Session Guidance (ADR-0057) keeps its three facts apart
 * — recorded, delivered (the provider channel accepted the message and it is enqueued), and read by
 * the model (never claimed) — and that guidance is a conversation fact rather than a specification
 * change: it writes no `task_revisions` row, moves neither `tasks.current_revision_id` nor
 * `tasks.version`, and appends no `VerificationInvalidated` event.
 *
 * What it does NOT prove: that a real provider read the guidance, and that a real Pi accepted
 * `steer` in a busy turn. The Adapter here is a scripted stub, so this is orchestration evidence only.
 * The amend side of the contrast (an evidence set that no longer matches becomes `STALE`, the only
 * writer of `VerificationInvalidated` is `markVerificationsStale`) is covered by the existing storage
 * tests; here the amend path is exercised only far enough to show it *does* append a revision and
 * move the Task's revision, which guidance never does.
 */

afterEach(() => { cleanupTemporaryDirectories(); });

const capabilitiesWithGuidance: AdapterCapabilities = Object.freeze({
  persistentSession: 'SUPPORTED',
  structuredAttention: 'SUPPORTED',
  nativePermissionRouting: 'SUPPORTED',
  pauseWithQuiescence: 'UNSUPPORTED',
  revisionAcknowledgement: 'UNSUPPORTED',
  cooperativeStop: 'SUPPORTED',
  attach: 'STRUCTURED',
  nativeTerminalHandoff: 'UNSUPPORTED',
  safePointNotification: 'UNSUPPORTED',
  reconnectToLiveSession: 'UNSUPPORTED',
  resumeAfterExit: 'UNSUPPORTED',
  controlledConfiguration: 'SUPPORTED',
  pluginSelection: 'UNSUPPORTED',
  sessionGuidance: 'SUPPORTED',
  providerProcessSuspension: 'UNSUPPORTED',
});

/**
 * A scripted provider that speaks the guidance port. `mode` decides which channel fact it produces,
 * so the Runtime's refusal paths are testable without a real provider: `ACCEPT` answers with the
 * evidence a real Pi produces, `REFUSE` says it did not take the message, `NO_EVIDENCE` claims
 * acceptance without naming a channel fact, and `NEVER` never answers at all.
 */
class GuidableAdapter extends DeterministicFakeAdapter implements GuidanceDeliveryPort {
  guideCount = 0;
  /** Every start request this stub was handed, so a launch argument can be asserted, not claimed. */
  readonly startRequests: AgentStartRequest[] = [];
  /** How this stub answers the guidance port; the base class's `mode` starts the provider. */
  guidanceMode: 'ACCEPT' | 'REFUSE' | 'NO_EVIDENCE' | 'NEVER' | 'THROW' = 'ACCEPT';

  constructor(private readonly capabilities: AdapterCapabilities = capabilitiesWithGuidance) {
    super();
  }

  override async probe(): Promise<{ readonly version: string; readonly capabilities: AdapterCapabilities }> {
    return { version: 'stub-1', capabilities: this.capabilities };
  }

  override async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    this.startRequests.push(request);
    const session = await super.start(request);
    return {
      ...session,
      providerSessionId: `stub:${request.sessionId}`,
      // A recorded provider session file, so a successor incarnation can reopen this conversation.
      sessionStorageRef: join(request.workspace.cwd, 'session.jsonl'),
    };
  }

  async guide(): Promise<{ readonly accepted: boolean; readonly evidenceRef?: string;
    readonly detail?: string }> {
    this.guideCount += 1;
    if (this.guidanceMode === 'NEVER') return new Promise(() => {});
    if (this.guidanceMode === 'THROW') throw new Error('the provider transport is gone');
    if (this.guidanceMode === 'REFUSE') return { accepted: false, detail: 'stub refused the guidance' };
    if (this.guidanceMode === 'NO_EVIDENCE') return { accepted: true };
    return {
      accepted: true,
      evidenceRef: `stub-steer:${this.guideCount}:queue_update=OBSERVED`,
      detail: 'the stub provider accepted the guidance into its steering queue (enqueued)',
    };
  }
}

/** A scripted provider without the guidance port whose capability string claims one anyway. */
class CapabilityOnlyAdapter extends DeterministicFakeAdapter {
  constructor(private readonly capabilities: AdapterCapabilities = capabilitiesWithGuidance) {
    super();
  }

  override async probe(): Promise<{ readonly version: string; readonly capabilities: AdapterCapabilities }> {
    return { version: 'stub-1', capabilities: this.capabilities };
  }
}

interface Harness {
  readonly fixture: AgentFixture;
  readonly registry: AdapterRegistry;
  readonly coordinator: AgentRuntimeCoordinator;
  readonly service: SessionGuidanceService;
  readonly adapter: GuidableAdapter;
  readonly executionId: string;
  readonly sessionId: string;
}

async function harness(options: {
  readonly capabilities?: AdapterCapabilities;
  readonly adapter?: GuidableAdapter | CapabilityOnlyAdapter;
  readonly deadlineMs?: number;
} = {}): Promise<Harness> {
  const fixture = await createAgentFixture();
  const adapter = options.adapter ?? new GuidableAdapter(options.capabilities);
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
  const service = new SessionGuidanceService({
    storage: fixture.storage,
    registry,
    runtimeHome: fixture.home,
    ...(options.deadlineMs === undefined ? {} : { deliveryDeadlineMs: options.deadlineMs }),
  });
  return { fixture, registry, coordinator, service, adapter: adapter as GuidableAdapter, ...run };
}

const record = (value: Harness, message: string, commandId = crypto.randomUUID()) =>
  value.service.record({ projectId: value.fixture.projectId, taskId: value.fixture.taskId,
    commandId, message, actor: 'local-user' });

function eventTypes(fixture: AgentFixture): readonly string[] {
  return fixture.storage.sqlite.query<{ event_type: string }, [string]>(
    'SELECT event_type FROM domain_events WHERE project_id=?1 ORDER BY sequence',
  ).all(fixture.projectId).map((row) => row.event_type);
}

function attemptOf(record: SessionGuidanceRecord) {
  return record.attempts.at(-1) ?? null;
}

describe('session guidance', () => {
  test('delivers into the running conversation and never touches the specification or its evidence', async () => {
    const value = await harness();
    const before = eventTypes(value.fixture);
    const taskBefore = value.fixture.storage.getTask(value.fixture.projectId, value.fixture.taskId);
    expect(taskBefore).not.toBeNull();

    const result = await record(value, 'Prefer the repository conventions file over ad-hoc style.');

    expect(result.outcome).toBe('DELIVERED');
    expect(result.code).toBeNull();
    // The claim stops at "the provider's channel took it": the answer says so out loud.
    expect(result.modelAcknowledgement).toBe('UNSUPPORTED');
    expect(result.guidance.state).toBe('DELIVERED');
    expect(result.guidance.body).toBe('Prefer the repository conventions file over ad-hoc style.');
    const attempt = attemptOf(value.fixture.storage.getSessionGuidance(
      value.fixture.projectId, result.guidance.id));
    expect(attempt?.state).toBe('DELIVERED');
    expect(attempt?.evidenceRef).toContain('stub-steer:1:queue_update=OBSERVED');
    expect(attempt?.capability).toBe('SUPPORTED');

    // A guidance message is not a revision: no `task_revisions` row, no revision move, no version
    // bump, and nothing that could mark a verification run stale.
    const after = eventTypes(value.fixture);
    expect(after.filter((type) => type === 'TaskRevisionCreated')).toHaveLength(
      before.filter((type) => type === 'TaskRevisionCreated').length);
    expect(after.filter((type) => type === 'VerificationInvalidated')).toHaveLength(0);
    expect(after).toContain('SessionGuidanceRecorded');
    expect(after).toContain('SessionGuidanceDelivered');
    expect(value.fixture.storage.listTaskRevisions(value.fixture.projectId, value.fixture.taskId))
      .toHaveLength(1);
    const taskAfter = value.fixture.storage.getTask(value.fixture.projectId, value.fixture.taskId);
    expect(taskAfter?.currentRevision.id).toBe(taskBefore?.currentRevision.id);
    expect(taskAfter?.version).toBe(taskBefore?.version);
    expect(value.fixture.storage.listVerificationRuns(value.fixture.projectId, value.fixture.taskId))
      .toHaveLength(0);

    // The body is stored durably (ADR-0010 D02) and never written into an event (ADR-0010 D06).
    const payloads = value.fixture.storage.sqlite.query<{ event_type: string; payload_json: string },
      []>("SELECT event_type,payload_json FROM domain_events WHERE event_type LIKE 'SessionGuidance%'")
      .all();
    expect(payloads).toHaveLength(2);
    for (const row of payloads) {
      // ADR-0010 D06: the text never enters the event, the hash and length do.
      expect(row.payload_json).not.toContain('ad-hoc style');
    }
    const recordedEvent = payloads.find((row) => row.event_type === 'SessionGuidanceRecorded');
    expect(recordedEvent?.payload_json).toContain(result.guidance.bodyHash);
  }, 30_000);

  test('keeps the amend path as the only specification change', async () => {
    const value = await harness();
    const revisionDeliveries = new RevisionDeliveryService({
      storage: value.fixture.storage,
      registry: value.registry,
      coordinator: new AgentRuntimeCoordinator({ storage: value.fixture.storage,
        registry: value.registry, runtimeHome: value.fixture.home }),
    });
    const beforeGuidance = value.fixture.storage.getTask(
      value.fixture.projectId, value.fixture.taskId);
    await record(value, 'Just a guiding note.');
    const afterGuidance = value.fixture.storage.getTask(
      value.fixture.projectId, value.fixture.taskId);
    // Guidance is not a specification change: the Task's version and revision are untouched.
    expect(afterGuidance?.version).toBe(beforeGuidance?.version);
    expect(afterGuidance?.currentRevision.id).toBe(beforeGuidance?.currentRevision.id);

    // The positive control: `task amend` (the revision command) appends a revision and moves the
    // Task's current revision, which is the fact that makes the old evidence no longer apply. The
    // STALE projection itself is asserted by the existing storage tests.
    const amended = await revisionDeliveries.createRevision({
      projectId: value.fixture.projectId,
      taskId: value.fixture.taskId,
      expectedVersion: afterGuidance?.version ?? 0,
      commandId: crypto.randomUUID(),
      specification: 'A changed acceptance criterion',
      reason: 'the user changed the requirement',
      actor: 'local-user',
    });
    expect(amended.task.currentRevision.id).not.toBe(afterGuidance?.currentRevision.id);
    expect(amended.task.version).toBeGreaterThan(afterGuidance?.version ?? 0);
    expect(eventTypes(value.fixture)).toContain('TaskRevisionCreated');
    expect(value.fixture.storage.listTaskRevisions(value.fixture.projectId, value.fixture.taskId))
      .toHaveLength(2);
  }, 30_000);

  test('records CHANNEL_UNSUPPORTED for a provider without a guidance channel and fabricates nothing', async () => {
    const adapter = new GuidableAdapter({ ...capabilitiesWithGuidance,
      sessionGuidance: 'UNSUPPORTED', providerProcessSuspension: 'UNSUPPORTED' });
    const value = await harness({ adapter });
    const result = await record(value, 'This provider has no live channel.');

    expect(result.outcome).toBe('CHANNEL_UNSUPPORTED');
    expect(result.code).toBe('CHANNEL_UNSUPPORTED');
    expect(result.guidance.state).toBe('CHANNEL_UNSUPPORTED');
    const attempt = attemptOf(value.fixture.storage.getSessionGuidance(
      value.fixture.projectId, result.guidance.id));
    expect(attempt?.state).toBe('CHANNEL_UNSUPPORTED');
    expect(attempt?.evidenceRef).toBe('capability:UNSUPPORTED');
    expect(attempt?.capability).toBe('UNSUPPORTED');
    // Nothing was ever handed to the provider, and nothing was recorded as delivered.
    expect(adapter.guideCount).toBe(0);
    // The attempt is concluded as a *refusal* in the same audit log: the event carries the state, and
    // `delivered:false` is the fact. Nothing anywhere claims a delivery happened.
    const delivered = value.fixture.storage.sqlite.query<{ payload_json: string }, []>(
      "SELECT payload_json FROM domain_events WHERE event_type='SessionGuidanceDelivered'").all();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload_json).toContain('"state":"CHANNEL_UNSUPPORTED"');
    expect(delivered[0]?.payload_json).toContain('"delivered":false');
    expect(value.fixture.storage.sqlite.query<{ rows: number }, []>(
      "SELECT COUNT(*) AS rows FROM session_guidance_deliveries WHERE state='DELIVERED'").get()?.rows)
      .toBe(0);
  }, 30_000);

  test('treats a capability that claims SUPPORTED without the port as CHANNEL_UNSUPPORTED', async () => {
    const value = await harness({ adapter: new CapabilityOnlyAdapter() });
    const result = await record(value, 'Claimed but not implemented.');
    expect(result.outcome).toBe('CHANNEL_UNSUPPORTED');
    const attempt = attemptOf(value.fixture.storage.getSessionGuidance(
      value.fixture.projectId, result.guidance.id));
    expect(attempt?.evidenceRef).toBe('capability:SUPPORTED:guide-missing');
    expect(supportsGuidanceDelivery(value.adapter)).toBe(false);
  }, 30_000);

  test('records a refusal, a missing channel fact and a timeout as the facts they are', async () => {
    const refusing = await harness();
    refusing.adapter.guidanceMode = 'REFUSE';
    expect((await record(refusing, 'Refused.')).outcome).toBe('FAILED');

    const silent = await harness();
    silent.adapter.guidanceMode = 'NO_EVIDENCE';
    const silentResult = await record(silent, 'No evidence.');
    expect(silentResult.outcome).toBe('FAILED');
    expect(silentResult.code).toBe('MISSING_CHANNEL_EVIDENCE');

    const slow = await harness({ deadlineMs: 30 });
    slow.adapter.guidanceMode = 'NEVER';
    const slowResult = await record(slow, 'Never answered.');
    expect(slowResult.outcome).toBe('TIMED_OUT');
    expect(slowResult.code).toBe('TIMED_OUT');
  }, 30_000);

  test('replaying the same command id records exactly one guidance message', async () => {
    const value = await harness();
    const commandId = crypto.randomUUID();
    const first = await record(value, 'Idempotent guidance.', commandId);
    const second = await record(value, 'Idempotent guidance.', commandId);

    expect(second.guidance.id).toBe(first.guidance.id);
    expect(value.fixture.storage.listSessionGuidance(value.fixture.projectId, value.fixture.taskId))
      .toHaveLength(1);
    expect(eventTypes(value.fixture).filter((type) => type === 'SessionGuidanceRecorded'))
      .toHaveLength(1);
    expect(value.adapter.guideCount).toBe(1);
  }, 30_000);

  test('hands the recorded guidance to a successor that reopens the conversation', async () => {
    const value = await harness();
    const recorded = await record(value, 'Keep the change small while you continue.');
    const first = value.adapter.startRequests[0];
    // The first launch happened before the guidance existed, so it carried none.
    expect(first?.guidanceContext).toBeUndefined();

    const successor = await value.coordinator.startAutomationSuccessor({
      sessionId: value.sessionId, commandId: crypto.randomUUID(), reason: 'test handoff',
    });
    expect(value.adapter.startRequests).toHaveLength(2);
    const second = value.adapter.startRequests[1];
    if (first === undefined || second === undefined) throw new Error('expected two starts');
    // The successor is a *resumed* start of the same conversation and it carries the guidance the
    // user gave, materialized from the ledger: the assertion is on the start argument, not a claim.
    expect(second.resume?.sessionStorageRef).toBe(join(first.workspace.cwd, 'session.jsonl'));
    expect(successor.executionId).toBe(first.executionId);
    expect(second.guidanceContext).toBeDefined();
    expect(second.guidanceContext?.guidanceIds).toEqual([recorded.guidance.id]);
    const launched = value.fixture.storage.listExecutionGuidanceContexts(
      value.fixture.projectId, value.fixture.taskId);
    expect(launched).toHaveLength(1);
    expect(launched[0]?.executionId).toBe(first.executionId);
    expect(launched[0]?.contextDigest).toBe(second.guidanceContext?.digest);
    const text = readFileSync(second.guidanceContext?.filePath as string, 'utf8');
    expect(text).toContain('Keep the change small while you continue.');
    await value.coordinator.close();
  }, 30_000);

  test('records guidance for a Task with nothing running and hands it to the next launch', async () => {
    const fixture = await createAgentFixture();
    const registry = new AdapterRegistry();
    const service = new SessionGuidanceService({
      storage: fixture.storage, registry, runtimeHome: fixture.home,
    });
    const result = await service.record({ projectId: fixture.projectId, taskId: fixture.taskId,
      commandId: crypto.randomUUID(), message: 'Always run the focused test file.', actor: 'local-user' });

    expect(result.outcome).toBe('RECORDED');
    expect(result.guidance.executionId).toBeNull();
    expect(result.guidance.attempts).toHaveLength(0);
    expect(eventTypes(fixture)).toContain('SessionGuidanceRecorded');

    // The artifact the next Execution is launched with is derived from those records, and the fact
    // that this Execution was launched with it is recorded rather than asserted.
    const executionId = crypto.randomUUID();
    // A real workspace row and a real Execution row, so the launch-context binding is written against
    // the same foreign keys a real Execution satisfies.
    fixture.storage.sqlite.query(`INSERT INTO workspaces
      (id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
      VALUES ('w-guidance',?1,'refs/heads/task/g','/work/guidance','owner-guidance',?2,'READY',3)`)
      .run(fixture.taskId, fixture.mainCommit);
    fixture.storage.sqlite.query(`INSERT INTO executions
      (id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,
       adapter_id,adapter_version,state,resource_held,base_commit,started_at)
      VALUES (?1,?2,1,?3,?3,'w-guidance','fake','1','RUNNING',1,?4,4)`).run(executionId,
      fixture.taskId, fixture.revisionId, fixture.mainCommit);
    const launched = await service.contextForExecution({ projectId: fixture.projectId,
      taskId: fixture.taskId, executionId });
    const context = launched.guidanceContext;
    expect(context).toBeDefined();
    expect(context?.guidanceIds).toEqual([result.guidance.id]);
    const text = readFileSync(context?.filePath as string, 'utf8');
    expect(text).toContain('Always run the focused test file.');
    expect(text).toContain('not a specification revision');
    expect(context?.bytes).toBe(statSync(context?.filePath as string).size);
    expect(createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'))
      .toBe(context?.digest as string);
    // The artifact lives in the Runtime data directory, never in a Task worktree.
    expect((context?.filePath as string).startsWith(join(fixture.home, 'guidance'))).toBe(true);
    expect(fixture.storage.listExecutionGuidanceContexts(fixture.projectId, fixture.taskId))
      .toHaveLength(1);
  }, 30_000);

  test('a Task with no guidance produces no artifact at all', async () => {
    const fixture = await createAgentFixture();
    const service = new SessionGuidanceService({
      storage: fixture.storage, registry: new AdapterRegistry(), runtimeHome: fixture.home,
    });
    const launched = await service.contextForExecution({ projectId: fixture.projectId,
      taskId: fixture.taskId, executionId: crypto.randomUUID() });
    expect(launched).toEqual({});
    expect(fixture.storage.listSessionGuidance(fixture.projectId, fixture.taskId)).toHaveLength(0);
  }, 30_000);

  test('closes an attempt a restart interrupted instead of replaying it', async () => {
    const value = await harness();
    // An attempt is recorded as in flight exactly as `session guide` records it before it hands the
    // message to the provider; the restart is then simulated by reconciling from that fact alone.
    const created = value.fixture.storage.recordSessionGuidance({
      projectId: value.fixture.projectId,
      taskId: value.fixture.taskId,
      commandId: crypto.randomUUID(),
      payloadHash: 'startup-reconcile-fixture',
      guidanceId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      eventId: crypto.randomUUID(),
      body: 'Interrupted.',
      bodyHash: createHash('sha256').update('Interrupted.', 'utf8').digest('hex'),
      bodyBytes: Buffer.byteLength('Interrupted.', 'utf8'),
      actor: 'local-user',
      recordedAt: 7,
    });
    expect(created.attemptId).not.toBeNull();

    const reconciled = new SessionGuidanceService({ storage: value.fixture.storage,
      registry: value.registry, runtimeHome: value.fixture.home }).reconcileAtStartup();
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.outcome).toBe('FAILED');
    expect(reconciled[0]?.attemptId).toBe(created.attemptId as string);
    const guidance = value.fixture.storage.getSessionGuidance(
      value.fixture.projectId, created.guidance.id);
    expect(attemptOf(guidance)?.errorCode).toBe('RUNTIME_RESTARTED');
    expect(guidance.state).toBe('FAILED');
    // The record itself stays readable, so the guidance is still handed to the next launch.
    expect(guidance.body).toBe('Interrupted.');
  }, 30_000);
});
