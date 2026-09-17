import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { ProcessCompletionOutcome } from '@codeestra/domain';
import { Phase1Database, ServiceKernelStore, systemServiceIds, type ProcessView }
  from '@codeestra/storage';
import {
  ServiceContractRegistry,
  SignalDispatcher,
  intentionSignalSubtype,
  processCompletedSubtype,
} from '../src/service-kernel.js';

/**
 * S5 storage boundary: the typed Process write path (`transitionProcess`, `completeProcess`) and the
 * read-only progress projection. Every assertion here reads the durable facts back — receipt rows,
 * `domain_events` and `processes.version` — so a claimed state change that did not persist fails the
 * test instead of passing on a returned view.
 */

const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const revisionId = '30000000-0000-4000-8000-000000000001';
const workspaceId = '40000000-0000-4000-8000-000000000001';
const executionId = '50000000-0000-4000-8000-000000000001';
const secondExecutionId = '50000000-0000-4000-8000-000000000002';
const oid = 'a'.repeat(40);

const stores: Phase1Database[] = [];
afterEach(() => { for (const storage of stores.splice(0)) storage.close(); });

function setup(now: () => number): { readonly storage: Phase1Database;
  readonly kernel: ServiceKernelStore; readonly dispatcher: SignalDispatcher } {
  const storage = new Phase1Database(); stores.push(storage);
  const kernel = new ServiceKernelStore(storage);
  return { storage, kernel, dispatcher: new SignalDispatcher({ store: kernel,
    contracts: new ServiceContractRegistry(), bootId: 'boot', now }) };
}

/** The stable kernel code of one refused write, so a test asserts the code a caller will see. */
function kernelCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { readonly code?: string }).code ?? 'NO_CODE';
  }
  return 'NO_ERROR';
}

function processStateVersion(kernel: ServiceKernelStore, processId: string): string {
  const row = kernel.sqlite.query<{ status: string; version: number }, [string]>(
    'SELECT status,version FROM processes WHERE id=?1').get(processId);
  return `${row?.status ?? 'MISSING'}@${row?.version ?? -1}`;
}

function processEvents(kernel: ServiceKernelStore, processId: string): readonly {
  readonly event_type: string; readonly payload_json: string }[] {
  return kernel.sqlite.query<{ event_type: string; payload_json: string }, [string]>(
    `SELECT event_type,payload_json FROM domain_events
      WHERE aggregate_type='Process' AND aggregate_id=?1 ORDER BY sequence`).all(processId);
}

function createIntentionProcess(kernel: ServiceKernelStore, dispatcher: SignalDispatcher,
  text = 'draft a plan'): string {
  const signalId = crypto.randomUUID();
  dispatcher.send({ signalId, kind: 'SIG_P', subtype: intentionSignalSubtype,
    sourceServiceId: null, sourceProcessId: null, targetServiceId: systemServiceIds.root,
    contractVersion: 1, payload: { text, adapterId: 'pi' },
    idempotencyKey: `intent-${signalId}`, correlationId: 'corr', causationId: null, priority: 0 });
  dispatcher.dispatchAvailable();
  const receipt = kernel.getSignal(signalId).receipt;
  expect(receipt).not.toBeNull();
  return (receipt?.effect as { readonly processId: string }).processId;
}

/** Enqueues and claims one PROCESS_COMPLETED SIG_A without going through the contract registry. */
function claimCompletion(kernel: ServiceKernelStore, input: {
  readonly targetServiceId: string; readonly processId: string;
  readonly outcome: ProcessCompletionOutcome; readonly expectedVersion: number;
  readonly sourceProcessId?: string | null; readonly summary?: string }): string {
  const signalId = crypto.randomUUID();
  kernel.enqueueSignal({ id: signalId, kind: 'SIG_A', subtype: processCompletedSubtype,
    sourceServiceId: null, sourceProcessId: input.sourceProcessId ?? null,
    targetServiceId: input.targetServiceId, contractVersion: 1,
    payload: { processId: input.processId, outcome: input.outcome,
      expectedVersion: input.expectedVersion, summary: input.summary ?? 'the work is over' },
    idempotencyKey: `complete-${signalId}`, correlationId: 'corr', causationId: null,
    priority: 0, createdAt: 100, eventId: crypto.randomUUID() });
  const claimed = kernel.claimNextSignal({ bootId: 'boot', now: 100, leaseMs: 30_000,
    eventId: crypto.randomUUID() });
  expect(claimed?.id).toBe(signalId);
  return signalId;
}

function complete(kernel: ServiceKernelStore, input: {
  readonly signalId: string; readonly processId: string; readonly outcome: ProcessCompletionOutcome;
  readonly expectedVersion: number; readonly now: number }): {
  readonly process: ProcessView; readonly applied: boolean } {
  return kernel.completeProcess({ signalId: input.signalId, processId: input.processId,
    outcome: input.outcome, expectedVersion: input.expectedVersion, summary: 'the work is over',
    now: input.now, eventIds: [crypto.randomUUID(), crypto.randomUUID()] });
}

function seedLegacyCore(db: Database): void {
  db.query(`INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
    VALUES (?1,'Project','/repo','/repo/.git','refs/heads/main','sha1',1)`).run(projectId);
  db.transaction(() => {
    db.query(`INSERT INTO tasks(id,project_id,display_number,display_title,naming_title,
      current_revision_id,state,created_at,updated_at)
      VALUES (?1,?2,1,'Work','work',?3,'RUNNING',2,2)`).run(taskId, projectId, revisionId);
    db.query(`INSERT INTO task_revisions(id,task_id,number,previous_revision_id,specification,
      actor,reason,created_at) VALUES (?1,?2,1,NULL,'Do work','user','initial',2)`)
      .run(revisionId, taskId);
    db.query(`INSERT INTO workspaces(id,task_id,branch_ref,path,ownership_token,base_commit,state,
      created_at) VALUES (?1,?2,'refs/heads/task/work','/work','owner',?3,'IN_USE',3)`)
      .run(workspaceId, taskId, oid);
    db.query(`INSERT INTO executions(id,task_id,attempt_number,initial_revision_id,
      applied_revision_id,workspace_id,adapter_id,adapter_version,state,resource_held,base_commit,
      started_at) VALUES (?1,?2,1,?3,?3,?4,'pi','1','RUNNING',1,?5,4)`)
      .run(executionId, taskId, revisionId, workspaceId, oid);
  })();
}

describe('Process typed write path', () => {
  test('moves a Process-owned state with a version CAS and records the audit fact', () => {
    const { kernel, dispatcher } = setup(() => 200);
    const processId = createIntentionProcess(kernel, dispatcher);
    expect(kernel.getProcess(processId)).toMatchObject({ state: 'CREATED', version: 0,
      progress: { budgetKnown: false, lastProgressAt: 200, tokenUsage: null, costUsd: null,
        toolCallCount: null } });

    const moved = kernel.transitionProcess({ processId, expectedVersion: 0, next: 'STARTING',
      actor: 'scheduler', reason: 'admitted', now: 300, eventId: crypto.randomUUID() });
    expect(moved).toMatchObject({ state: 'STARTING', version: 1 });
    expect(moved.progress.lastProgressAt).toBe(300);
    expect(processStateVersion(kernel, processId)).toBe('STARTING@1');
    expect(processEvents(kernel, processId).map((event) => event.event_type))
      .toEqual(['ProcessCreated', 'ProcessStateChanged']);
    expect(JSON.parse(processEvents(kernel, processId)[1]?.payload_json ?? '{}')).toEqual({
      processId, from: 'CREATED', to: 'STARTING', actor: 'scheduler', reason: 'admitted' });
  });

  test('refuses a stale expectedVersion and applies nothing', () => {
    const { kernel, dispatcher } = setup(() => 200);
    const processId = createIntentionProcess(kernel, dispatcher);
    kernel.transitionProcess({ processId, expectedVersion: 0, next: 'STARTING',
      actor: 'scheduler', reason: 'admitted', now: 300, eventId: crypto.randomUUID() });
    const before = processEvents(kernel, processId).length;
    expect(kernelCode(() => kernel.transitionProcess({ processId, expectedVersion: 0,
      next: 'RUNNING', actor: 'scheduler', reason: 'stale', now: 400,
      eventId: crypto.randomUUID() }))).toBe('PROCESS_VERSION_CONFLICT');
    expect(processStateVersion(kernel, processId)).toBe('STARTING@1');
    expect(processEvents(kernel, processId)).toHaveLength(before);
  });

  test('refuses an illegal transition and a terminal revival without partial application', () => {
    const { kernel, dispatcher } = setup(() => 200);
    const processId = createIntentionProcess(kernel, dispatcher);
    expect(kernelCode(() => kernel.transitionProcess({ processId, expectedVersion: 0,
      next: 'SUCCEEDED', actor: 'scheduler', reason: 'skip ahead', now: 300,
      eventId: crypto.randomUUID() }))).toBe('INVALID_PROCESS_TRANSITION');
    expect(processStateVersion(kernel, processId)).toBe('CREATED@0');
    expect(processEvents(kernel, processId)).toHaveLength(1);

    kernel.transitionProcess({ processId, expectedVersion: 0, next: 'CANCELLED',
      actor: 'user', reason: 'stop', now: 400, eventId: crypto.randomUUID() });
    expect(kernelCode(() => kernel.transitionProcess({ processId, expectedVersion: 1,
      next: 'STARTING', actor: 'user', reason: 'revive', now: 500,
      eventId: crypto.randomUUID() }))).toBe('PROCESS_TERMINAL');
    expect(processStateVersion(kernel, processId)).toBe('CANCELLED@1');
    expect(processEvents(kernel, processId)).toHaveLength(2);
  });

  test('keeps an EXECUTION-backed Process read-only for typed writes and completion', () => {
    const { storage, kernel, dispatcher } = setup(() => 200);
    seedLegacyCore(storage.sqlite);
    const projected = kernel.getProcess(executionId);
    expect(projected).toMatchObject({ kind: 'DEVELOPMENT', state: 'RUNNING', version: 0,
      executionId });

    expect(kernelCode(() => kernel.transitionProcess({ processId: executionId, expectedVersion: 0,
      next: 'PAUSED', actor: 'user', reason: 'pause', now: 300,
      eventId: crypto.randomUUID() }))).toBe('PROCESS_STATUS_SOURCE_READONLY');
    const direct = claimCompletion(kernel, { targetServiceId: taskId, processId: executionId,
      outcome: 'SUCCEEDED', expectedVersion: 0 });
    expect(kernelCode(() => complete(kernel, { signalId: direct, processId: executionId,
      outcome: 'SUCCEEDED', expectedVersion: 0, now: 400 })))
      .toBe('PROCESS_STATUS_SOURCE_READONLY');

    // Through the dispatcher the same refusal is permanent: it dead-letters with the stable code on
    // the first attempt instead of retrying a payload that can never become valid.
    const dispatched = crypto.randomUUID();
    dispatcher.send({ signalId: dispatched, kind: 'SIG_A', subtype: processCompletedSubtype,
      sourceServiceId: null, sourceProcessId: null, targetServiceId: taskId, contractVersion: 1,
      payload: { processId: executionId, outcome: 'SUCCEEDED', expectedVersion: 0,
        summary: 'the work is over' }, idempotencyKey: `complete-${dispatched}`,
      correlationId: 'corr', causationId: null, priority: 0 });
    expect(dispatcher.dispatchAvailable()).toBe(1);
    expect(kernel.getSignal(dispatched)).toMatchObject({ state: 'DEAD_LETTER', automaticAttempts: 1,
      lastErrorCode: 'PROCESS_STATUS_SOURCE_READONLY' });

    expect(processEvents(kernel, executionId)).toEqual([]);
    expect(kernel.getProcess(executionId)).toMatchObject({ state: 'RUNNING' });
    expect(kernel.sqlite.query<{ state: string }, []>('SELECT state FROM executions').get()?.state)
      .toBe('RUNNING');
  });
});

describe('Process completion fact', () => {
  test('completes a Process-owned Process once and converges a redelivery on the same receipt', () => {
    const { kernel, dispatcher } = setup(() => 200);
    const processId = createIntentionProcess(kernel, dispatcher);
    kernel.transitionProcess({ processId, expectedVersion: 0, next: 'STARTING',
      actor: 'scheduler', reason: 'admitted', now: 300, eventId: crypto.randomUUID() });
    kernel.transitionProcess({ processId, expectedVersion: 1, next: 'RUNNING',
      actor: 'scheduler', reason: 'started', now: 310, eventId: crypto.randomUUID() });

    const signalId = claimCompletion(kernel, { targetServiceId: systemServiceIds.root, processId,
      outcome: 'SUCCEEDED', expectedVersion: 2 });
    const applied = complete(kernel, { signalId, processId, outcome: 'SUCCEEDED',
      expectedVersion: 2, now: 400 });
    expect(applied).toMatchObject({ applied: true,
      process: { state: 'SUCCEEDED', version: 3 } });
    expect(applied.process.progress.lastProgressAt).toBe(400);
    expect(kernel.getSignal(signalId)).toMatchObject({ state: 'ACKED', attemptCount: 1,
      receipt: { effect: { type: 'PROCESS_COMPLETED', processId, outcome: 'SUCCEEDED',
        state: 'SUCCEEDED', version: 3 } } });
    expect(JSON.parse(processEvents(kernel, processId).at(-1)?.payload_json ?? '{}'))
      .toMatchObject({ from: 'RUNNING', to: 'SUCCEEDED', actor: 'signal-dispatcher' });

    const replayed = complete(kernel, { signalId, processId, outcome: 'SUCCEEDED',
      expectedVersion: 2, now: 500 });
    expect(replayed).toMatchObject({ applied: false,
      process: { state: 'SUCCEEDED', version: 3 } });
    expect(kernel.sqlite.query<{ count: number }, [string]>(
      'SELECT COUNT(*) AS count FROM signal_receipts WHERE signal_id=?1').get(signalId)?.count).toBe(1);
    expect(processEvents(kernel, processId).filter((event) =>
      event.event_type === 'ProcessStateChanged')).toHaveLength(3);
  });

  test('refuses a stale expectedVersion, a mismatched target and an unmatched Process', () => {
    const { kernel, dispatcher } = setup(() => 200);
    const processId = createIntentionProcess(kernel, dispatcher);

    const stale = claimCompletion(kernel, { targetServiceId: systemServiceIds.root, processId,
      outcome: 'CANCELLED', expectedVersion: 7 });
    expect(kernelCode(() => complete(kernel, { signalId: stale, processId, outcome: 'CANCELLED',
      expectedVersion: 7, now: 400 }))).toBe('PROCESS_VERSION_CONFLICT');
    expect(processStateVersion(kernel, processId)).toBe('CREATED@0');

    // A Service that accepts the subtype but does not parent this Process cannot complete it.
    const wrongParent = claimCompletion(kernel, { targetServiceId: systemServiceIds.scheduler,
      processId, outcome: 'CANCELLED', expectedVersion: 0 });
    expect(kernelCode(() => complete(kernel, { signalId: wrongParent, processId,
      outcome: 'CANCELLED', expectedVersion: 0, now: 410 }))).toBe('PROCESS_PARENT_MISMATCH');

    // The Signal names one Process and the write names another: neither is applied.
    const otherProcessId = createIntentionProcess(kernel, dispatcher, 'another plan');
    const mismatched = claimCompletion(kernel, { targetServiceId: systemServiceIds.root,
      processId, outcome: 'CANCELLED', expectedVersion: 0 });
    expect(kernelCode(() => complete(kernel, { signalId: mismatched,
      processId: otherProcessId, outcome: 'CANCELLED', expectedVersion: 0, now: 420 })))
      .toBe('PROCESS_COMPLETION_MISMATCH');
    expect(processStateVersion(kernel, processId)).toBe('CREATED@0');
    expect(processStateVersion(kernel, otherProcessId)).toBe('CREATED@0');
  });

  test('never revives a completed Process from a later completion Signal', () => {
    const { kernel, dispatcher } = setup(() => 200);
    const processId = createIntentionProcess(kernel, dispatcher);
    kernel.transitionProcess({ processId, expectedVersion: 0, next: 'CANCELLED',
      actor: 'user', reason: 'stop', now: 300, eventId: crypto.randomUUID() });

    const signalId = claimCompletion(kernel, { targetServiceId: systemServiceIds.root, processId,
      outcome: 'SUCCEEDED', expectedVersion: 1 });
    expect(kernelCode(() => complete(kernel, { signalId, processId, outcome: 'SUCCEEDED',
      expectedVersion: 1, now: 400 }))).toBe('PROCESS_TERMINAL');
    expect(processStateVersion(kernel, processId)).toBe('CANCELLED@1');
    expect(processEvents(kernel, processId)).toHaveLength(2);
  });
});

describe('Task execution slot', () => {
  test('projects one non-terminal Process per Task and refuses a second live slot holder', () => {
    const { storage, kernel } = setup(() => 200);
    seedLegacyCore(storage.sqlite);
    expect(kernel.listProcesses({ parentServiceId: taskId }))
      .toMatchObject([{ id: executionId, state: 'RUNNING', version: 0, executionId }]);

    // The running Execution ends, so its slot is free again for the next attempt.
    storage.sqlite.query("UPDATE executions SET state='CANCELLED',resource_held=0,ended_at=6 WHERE id=?1")
      .run(executionId);
    storage.sqlite.query(`INSERT INTO executions(id,task_id,attempt_number,initial_revision_id,
      applied_revision_id,workspace_id,adapter_id,adapter_version,state,resource_held,base_commit,
      started_at) VALUES (?1,?2,2,?3,?3,?4,'pi','1','RUNNING',1,?5,7)`)
      .run(secondExecutionId, taskId, revisionId, workspaceId, oid);
    const progressed = kernel.listProcesses({ parentServiceId: taskId });
    expect(progressed.map((process) => process.state)).toEqual(['CANCELLED', 'RUNNING']);
    expect(progressed.filter((process) => !['SUCCEEDED', 'FAILED', 'CANCELLED']
      .includes(process.state))).toHaveLength(1);

    // With the index removed the database can hold two live Executions; the projection guard then
    // refuses to report a state that two Processes would both claim to own.
    storage.sqlite.exec('DROP INDEX one_held_execution');
    storage.sqlite.query(`INSERT INTO executions(id,task_id,attempt_number,initial_revision_id,
      applied_revision_id,workspace_id,adapter_id,adapter_version,state,resource_held,base_commit,
      started_at) VALUES (?1,?2,3,?3,?3,?4,'pi','1','RUNNING',1,?5,8)`)
      .run('50000000-0000-4000-8000-000000000003', taskId, revisionId, workspaceId, oid);
    expect(kernelCode(() => kernel.listProcesses({ parentServiceId: taskId })))
      .toBe('PROCESS_PREDECESSOR_ACTIVE');
  });
});
