import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import { inspectRepository, prepareWorkspace } from '@codeestra/git';
import { Phase1Database } from '@codeestra/storage';
import { deliverAgentAnswer } from '../src/agent-answer-service.js';
import { observeAgentEvents } from '../src/agent-observation-service.js';
import { startReservedExecution } from '../src/agent-start-service.js';
import { deliverPendingEvents } from '../src/event-delivery-service.js';
import {
  reconcileInterruptedAgentAnswers,
  reconcileInterruptedAgentStarts,
  reconcileWorkspacePreparations,
} from '../src/recovery-service.js';
import { prepareTaskWorkspace } from '../src/workspace-service.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function run(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

async function fixture(): Promise<{
  storage: Phase1Database;
  repo: string;
  home: string;
  projectId: string;
  taskId: string;
}> {
  const repo = mkdtempSync(join(tmpdir(), 'codeestra-runtime-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'codeestra-runtime-home-'));
  directories.push(repo, home);
  await run(repo, ['init', '-b', 'main']);
  await Bun.write(join(repo, 'README.md'), 'temporary repository\n');
  await run(repo, ['add', 'README.md']);
  await run(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  const identity = await inspectRepository(repo);
  const storage = new Phase1Database();
  const projectId = '10000000-0000-4000-8000-000000000001';
  const taskId = '20000000-0000-4000-8000-000000000002';
  storage.trustProject({
    id: projectId,
    trustId: '30000000-0000-4000-8000-000000000003',
    name: 'Temporary',
    repoRoot: identity.repoRoot,
    gitCommonDir: identity.gitCommonDir,
    mainRef: identity.mainRef,
    objectFormat: identity.objectFormat,
    policyVersion: 1,
    trustedAt: 1,
    actor: 'local-user',
  });
  storage.createTask({
    projectId,
    commandId: '40000000-0000-4000-8000-000000000004',
    payloadHash: 'create',
    intentId: '50000000-0000-4000-8000-000000000005',
    taskId,
    revisionId: '60000000-0000-4000-8000-000000000006',
    intentEventId: '70000000-0000-4000-8000-000000000007',
    taskEventId: '80000000-0000-4000-8000-000000000008',
    specification: 'Prepare an owned worktree',
    constraints: [],
    kind: 'DEVELOPMENT',
    actor: 'local-user',
    createdAt: 2,
  });
  storage.submitTask({
    projectId,
    taskId,
    expectedVersion: 0,
    commandId: '90000000-0000-4000-8000-000000000009',
    payloadHash: 'submit',
    eventId: 'a0000000-0000-4000-8000-00000000000a',
    actor: 'local-user',
    submittedAt: 3,
  });
  return { storage, repo: identity.repoRoot, home: realpathSync(home), projectId, taskId };
}

function uuidSequence(start = 10): () => string {
  let value = start;
  return () => `${(++value).toString(16).padStart(8, '0')}-0000-4000-8000-00000000000b`;
}

async function reserveCrashedPreparation(value: Awaited<ReturnType<typeof fixture>>) {
  const identity = await inspectRepository(value.repo);
  const operationId = '0a000000-0000-4000-8000-00000000000a';
  const workspaceId = '0b000000-0000-4000-8000-00000000000b';
  const ownershipToken = '0c000000-0000-4000-8000-00000000000c';
  const worktreesRoot = join(value.home, 'worktrees');
  const plan = value.storage.reserveWorkspacePreparation({
    operationId,
    idempotencyKey: '0d000000-0000-4000-8000-00000000000d',
    payloadHash: 'crashed-prepare',
    projectId: value.projectId,
    taskId: value.taskId,
    expectedTaskVersion: 1,
    workspaceId,
    ownershipToken,
    branchRef: `refs/heads/task/${value.taskId}`,
    path: join(worktreesRoot, value.projectId, value.taskId),
    baseCommit: identity.headCommit,
    createdAt: 10,
  });
  value.storage.startWorkspacePreparation(operationId, workspaceId, 11);
  return { plan, worktreesRoot };
}

async function reserveExecutionForAgent(value: Awaited<ReturnType<typeof fixture>>) {
  const workspace = await prepareTaskWorkspace({
    storage: value.storage,
    runtimeHome: value.home,
    commandId: 'b0000000-0000-4000-8000-00000000000b',
    projectId: value.projectId,
    taskId: value.taskId,
    expectedTaskVersion: 1,
    now: () => 10,
    randomUUID: uuidSequence(),
  });
  return value.storage.reserveExecution({
    projectId: value.projectId,
    taskId: value.taskId,
    expectedTaskVersion: 1,
    workspaceId: workspace.workspaceId,
    executionId: 'c0000000-0000-4000-8000-00000000000c',
    commandId: 'd0000000-0000-4000-8000-00000000000d',
    payloadHash: 'execution-reservation',
    reservationEventId: 'e0000000-0000-4000-8000-00000000000e',
    taskEventId: 'f0000000-0000-4000-8000-00000000000f',
    adapterId: 'fake',
    adapterVersion: 'fake-1',
    actor: 'runtime-scheduler',
    createdAt: 11,
  });
}

async function startWithAttention(
  value: Awaited<ReturnType<typeof fixture>>,
  answerMode: 'SUCCEED' | 'FAIL_BEFORE_DELIVERY' | 'FAIL_AFTER_DELIVERY' = 'SUCCEED',
) {
  const execution = await reserveExecutionForAgent(value);
  const adapter = new DeterministicFakeAdapter('SUCCEED', [{
    type: 'attention', eventId: 'provider-attention-answer', cursor: 'cursor-answer',
    providerRequestId: 'provider-request-answer', kind: 'PERMISSION', responseType: 'CONFIRM',
    prompt: { method: 'confirm', title: 'Allow write?' },
  }], answerMode);
  const started = await startReservedExecution({
    storage: value.storage, adapter, projectId: value.projectId,
    executionId: execution.executionId, expectedExecutionVersion: 0,
    prepareCommandId: '11000000-0000-4000-8000-000000000011',
    startCommandId: '12000000-0000-4000-8000-000000000012',
    now: () => 20, randomUUID: uuidSequence(100),
  });
  await observeAgentEvents({
    storage: value.storage, adapter, sessionId: started.sessionId,
    now: () => 30, randomUUID: uuidSequence(300),
  });
  const attention = value.storage.listAttentionRequests(value.projectId)[0];
  if (attention === undefined) throw new Error('Attention fixture was not created');
  return { adapter, attention, execution, started };
}

function planConfirmAnswer(value: Awaited<ReturnType<typeof fixture>>, attentionId: string, confirmed: boolean) {
  return value.storage.planAttentionAnswer({
    projectId: value.projectId,
    attentionId,
    commandId: '61000000-0000-4000-8000-000000000061',
    payloadHash: `confirm:${confirmed}`,
    intentId: '62000000-0000-4000-8000-000000000062',
    answerId: '63000000-0000-4000-8000-000000000063',
    operationId: '64000000-0000-4000-8000-000000000064',
    answer: { type: 'CONFIRM', confirmed },
    intentEventId: '65000000-0000-4000-8000-000000000065',
    recordedEventId: '66000000-0000-4000-8000-000000000066',
    actor: 'local-user',
    recordedAt: 40,
  });
}

describe('workspace preparation service', () => {
  test('persists operation phases around one Git side effect and does not replay duplicates', async () => {
    const value = await fixture();
    try {
      const command = {
        storage: value.storage,
        runtimeHome: value.home,
        commandId: 'b0000000-0000-4000-8000-00000000000b',
        projectId: value.projectId,
        taskId: value.taskId,
        expectedTaskVersion: 1,
        now: () => 10,
        randomUUID: uuidSequence(),
      };
      const first = await prepareTaskWorkspace(command);
      expect(first).toMatchObject({ operationState: 'SUCCEEDED', workspaceState: 'READY' });
      expect(await run(first.path, ['symbolic-ref', 'HEAD'])).toBe(`refs/heads/task/${value.taskId}`);
      expect(await run(value.repo, ['status', '--porcelain'])).toBe('');
      rmSync(value.repo, { recursive: true, force: true });

      const duplicate = await prepareTaskWorkspace({ ...command, randomUUID: uuidSequence() });
      expect(duplicate.operationId).toBe(first.operationId);
      expect(duplicate.workspaceId).toBe(first.workspaceId);
      expect(value.storage.sqlite.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM operations WHERE kind='PREPARE_WORKSPACE'",
      ).get()?.count).toBe(1);
    } finally {
      value.storage.close();
    }
  });

  test('atomically reserves one Execution after the workspace is ready', async () => {
    const value = await fixture();
    try {
      const workspace = await prepareTaskWorkspace({
        storage: value.storage,
        runtimeHome: value.home,
        commandId: 'b0000000-0000-4000-8000-00000000000b',
        projectId: value.projectId,
        taskId: value.taskId,
        expectedTaskVersion: 1,
        now: () => 10,
        randomUUID: uuidSequence(),
      });
      const input = {
        projectId: value.projectId,
        taskId: value.taskId,
        expectedTaskVersion: 1,
        workspaceId: workspace.workspaceId,
        executionId: 'c0000000-0000-4000-8000-00000000000c',
        commandId: 'd0000000-0000-4000-8000-00000000000d',
        payloadHash: 'execution-reservation',
        reservationEventId: 'e0000000-0000-4000-8000-00000000000e',
        taskEventId: 'f0000000-0000-4000-8000-00000000000f',
        adapterId: 'fake',
        adapterVersion: '1',
        actor: 'runtime-scheduler',
        createdAt: 11,
      };
      const execution = value.storage.reserveExecution(input);
      expect(execution).toMatchObject({
        taskVersion: 2,
        attemptNumber: 1,
        revisionId: '60000000-0000-4000-8000-000000000006',
        state: 'CREATED',
      });
      expect(value.storage.reserveExecution({
        ...input,
        executionId: '01000000-0000-4000-8000-000000000010',
        reservationEventId: '02000000-0000-4000-8000-000000000020',
        taskEventId: '03000000-0000-4000-8000-000000000030',
      })).toEqual(execution);
      expect(value.storage.listTasks(value.projectId)[0]).toMatchObject({ state: 'RUNNING', version: 2 });
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM workspaces').get()?.state)
        .toBe('IN_USE');
      expect(value.storage.sqlite.query<{ count: number }, []>(
        'SELECT count(*) AS count FROM executions',
      ).get()?.count).toBe(1);
    } finally {
      value.storage.close();
    }
  });

  test('records a pre-side-effect ref conflict as failed without claiming recovery uncertainty', async () => {
    const value = await fixture();
    await run(value.repo, ['branch', `task/${value.taskId}`, 'HEAD']);
    try {
      await expect(prepareTaskWorkspace({
        storage: value.storage,
        runtimeHome: value.home,
        commandId: 'b0000000-0000-4000-8000-00000000000b',
        projectId: value.projectId,
        taskId: value.taskId,
        expectedTaskVersion: 1,
        now: () => 10,
        randomUUID: uuidSequence(),
      })).rejects.toMatchObject({ code: 'REF_CONFLICT' });
      expect(value.storage.sqlite.query<{ state: string }, []>(
        "SELECT state FROM operations WHERE kind='PREPARE_WORKSPACE'",
      ).get()?.state).toBe('FAILED');
      expect(value.storage.sqlite.query<{ state: string }, []>(
        'SELECT state FROM workspaces',
      ).get()?.state).toBe('RELEASED');
    } finally {
      value.storage.close();
    }
  });

  test('startup reconciliation records a completed Git side effect without replaying it', async () => {
    const value = await fixture();
    try {
      const crashed = await reserveCrashedPreparation(value);
      await prepareWorkspace({
        operationId: crashed.plan.operationId,
        repositoryRoot: crashed.plan.repoRoot,
        worktreesRoot: crashed.worktreesRoot,
        projectId: crashed.plan.projectId,
        mainRef: crashed.plan.mainRef,
        taskId: crashed.plan.taskId,
        workspaceId: crashed.plan.workspaceId,
        ownershipToken: crashed.plan.ownershipToken,
        baseCommit: crashed.plan.baseCommit,
        expectedMainCommit: crashed.plan.baseCommit,
      });
      const results = await reconcileWorkspacePreparations({
        storage: value.storage,
        now: () => 12,
        randomUUID: () => '0e000000-0000-4000-8000-00000000000e',
      });
      expect(results).toEqual([expect.objectContaining({ outcome: 'RECOVERED_SUCCEEDED' })]);
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM operations').get()?.state)
        .toBe('SUCCEEDED');
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM workspaces').get()?.state)
        .toBe('READY');
    } finally {
      value.storage.close();
    }
  });

  test('startup reconciliation preserves a changed workspace for manual recovery', async () => {
    const value = await fixture();
    try {
      const crashed = await reserveCrashedPreparation(value);
      const prepared = await prepareWorkspace({
        operationId: crashed.plan.operationId,
        repositoryRoot: crashed.plan.repoRoot,
        worktreesRoot: crashed.worktreesRoot,
        projectId: crashed.plan.projectId,
        mainRef: crashed.plan.mainRef,
        taskId: crashed.plan.taskId,
        workspaceId: crashed.plan.workspaceId,
        ownershipToken: crashed.plan.ownershipToken,
        baseCommit: crashed.plan.baseCommit,
        expectedMainCommit: crashed.plan.baseCommit,
      });
      await Bun.write(join(prepared.path, 'changed.txt'), 'external change\n');
      await run(prepared.path, ['add', 'changed.txt']);
      await run(prepared.path, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
        'commit', '-m', 'changed while runtime was down']);
      const results = await reconcileWorkspacePreparations({ storage: value.storage, now: () => 12 });
      expect(results).toEqual([expect.objectContaining({ outcome: 'RECOVERY_REQUIRED' })]);
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM operations').get()?.state)
        .toBe('RECONCILE_REQUIRED');
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM workspaces').get()?.state)
        .toBe('RECOVERY_REQUIRED');
    } finally {
      value.storage.close();
    }
  });

  test('startup reconciliation safely fails an operation when no Git resource exists', async () => {
    const value = await fixture();
    try {
      await reserveCrashedPreparation(value);
      const results = await reconcileWorkspacePreparations({ storage: value.storage, now: () => 12 });
      expect(results).toEqual([expect.objectContaining({ outcome: 'RECOVERED_FAILED' })]);
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM operations').get()?.state)
        .toBe('FAILED');
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM workspaces').get()?.state)
        .toBe('RELEASED');
    } finally {
      value.storage.close();
    }
  });

  test('invalidates trust when the repository can no longer be inspected', async () => {
    const value = await fixture();
    rmSync(value.repo, { recursive: true, force: true });
    try {
      await expect(prepareTaskWorkspace({
        storage: value.storage,
        runtimeHome: value.home,
        commandId: 'b0000000-0000-4000-8000-00000000000b',
        projectId: value.projectId,
        taskId: value.taskId,
        expectedTaskVersion: 1,
      })).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
      expect(value.storage.listTrustedProjects()).toEqual([]);
    } finally {
      value.storage.close();
    }
  });
});

describe('Agent start coordinator with deterministic fake', () => {
  test('moves PREPARING through STARTING to a persisted active Session exactly once', async () => {
    const value = await fixture();
    try {
      const execution = await reserveExecutionForAgent(value);
      const adapter = new DeterministicFakeAdapter();
      const input = {
        storage: value.storage,
        adapter,
        projectId: value.projectId,
        executionId: execution.executionId,
        expectedExecutionVersion: 0,
        prepareCommandId: '11000000-0000-4000-8000-000000000011',
        startCommandId: '12000000-0000-4000-8000-000000000012',
        now: () => 20,
        randomUUID: uuidSequence(100),
      };
      const started = await startReservedExecution(input);
      expect(started).toMatchObject({
        operationState: 'SUCCEEDED',
        sessionState: 'ACTIVE',
        executionVersion: 3,
        adapterId: 'fake',
        adapterVersion: 'fake-1',
      });
      expect(adapter.startCount(started.operationId)).toBe(1);
      const duplicate = await startReservedExecution({ ...input, randomUUID: uuidSequence() });
      expect(duplicate.operationId).toBe(started.operationId);
      expect(adapter.startCount(started.operationId)).toBe(1);
      expect(value.storage.sqlite.query<{ state: string }, []>(
        'SELECT state FROM executions',
      ).get()?.state).toBe('RUNNING');
    } finally {
      value.storage.close();
    }
  });

  test('records a proven pre-start failure and releases Execution ownership', async () => {
    const value = await fixture();
    try {
      const execution = await reserveExecutionForAgent(value);
      await expect(startReservedExecution({
        storage: value.storage,
        adapter: new DeterministicFakeAdapter('FAIL_BEFORE_START'),
        projectId: value.projectId,
        executionId: execution.executionId,
        expectedExecutionVersion: 0,
        prepareCommandId: '11000000-0000-4000-8000-000000000011',
        startCommandId: '12000000-0000-4000-8000-000000000012',
        now: () => 20,
        randomUUID: uuidSequence(100),
      })).rejects.toMatchObject({ code: 'AGENT_START_FAILED' });
      expect(value.storage.sqlite.query<{ state: string; resource_held: number }, []>(
        'SELECT state,resource_held FROM executions',
      ).get()).toEqual({ state: 'FAILED', resource_held: 0 });
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM workspaces').get()?.state)
        .toBe('RETAINED');
      expect(value.storage.listTasks(value.projectId)[0]?.state).toBe('FAILED');
    } finally {
      value.storage.close();
    }
  });

  test('marks an interrupted in-progress start as recovery required on Runtime restart', async () => {
    const value = await fixture();
    try {
      const execution = await reserveExecutionForAgent(value);
      const preparing = value.storage.markExecutionPreparing({
        projectId: value.projectId,
        executionId: execution.executionId,
        expectedExecutionVersion: 0,
        commandId: '11000000-0000-4000-8000-000000000011',
        payloadHash: 'prepare-execution',
        eventId: '13000000-0000-4000-8000-000000000013',
        changedAt: 20,
      });
      const adapter = new DeterministicFakeAdapter();
      const probe = await adapter.probe();
      const plan = value.storage.planAgentStart({
        operationId: '14000000-0000-4000-8000-000000000014',
        idempotencyKey: '12000000-0000-4000-8000-000000000012',
        payloadHash: 'start-agent',
        projectId: value.projectId,
        executionId: execution.executionId,
        expectedExecutionVersion: preparing.version,
        sessionId: '15000000-0000-4000-8000-000000000015',
        adapterId: adapter.id,
        adapterVersion: probe.version,
        capabilities: probe.capabilities,
        eventId: '16000000-0000-4000-8000-000000000016',
        plannedAt: 21,
      });
      value.storage.startAgentOperation(plan.operationId, 22);
      expect(reconcileInterruptedAgentStarts({
        storage: value.storage,
        now: () => 23,
        randomUUID: uuidSequence(200),
      })).toEqual([expect.objectContaining({ outcome: 'RECOVERY_REQUIRED' })]);
      expect(value.storage.sqlite.query<{ state: string; resource_held: number }, []>(
        'SELECT state,resource_held FROM executions',
      ).get()).toEqual({ state: 'RECOVERY_REQUIRED', resource_held: 1 });
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM agent_sessions').get()?.state)
        .toBe('RECOVERY_REQUIRED');
    } finally {
      value.storage.close();
    }
  });

  test('keeps ownership when start may have occurred', async () => {
    const value = await fixture();
    try {
      const execution = await reserveExecutionForAgent(value);
      await expect(startReservedExecution({
        storage: value.storage,
        adapter: new DeterministicFakeAdapter('FAIL_AFTER_START'),
        projectId: value.projectId,
        executionId: execution.executionId,
        expectedExecutionVersion: 0,
        prepareCommandId: '11000000-0000-4000-8000-000000000011',
        startCommandId: '12000000-0000-4000-8000-000000000012',
        now: () => 20,
        randomUUID: uuidSequence(100),
      })).rejects.toMatchObject({ code: 'AGENT_START_FAILED' });
      expect(value.storage.sqlite.query<{ state: string; resource_held: number }, []>(
        'SELECT state,resource_held FROM executions',
      ).get()).toEqual({ state: 'RECOVERY_REQUIRED', resource_held: 1 });
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM agent_sessions').get()?.state)
        .toBe('RECOVERY_REQUIRED');
      expect(value.storage.sqlite.query<{ state: string }, []>(
        "SELECT state FROM operations WHERE kind='START_AGENT'",
      ).get()?.state).toBe('RECONCILE_REQUIRED');
    } finally {
      value.storage.close();
    }
  });
});

describe('Agent answer coordination', () => {
  test('records denial as a valid answer and delivers it exactly once', async () => {
    const value = await fixture();
    try {
      const { adapter, attention } = await startWithAttention(value);
      const planned = planConfirmAnswer(value, attention.id, false);
      expect(planned).toMatchObject({ operationState: 'PLANNED', status: 'ANSWER_RECORDED',
        answer: { type: 'CONFIRM', confirmed: false } });
      expect(planConfirmAnswer(value, attention.id, false).operationId).toBe(planned.operationId);
      const delivered = await deliverAgentAnswer({
        storage: value.storage, adapter, operationId: planned.operationId,
        now: () => 50, randomUUID: uuidSequence(700),
      });
      expect(delivered).toMatchObject({ operationState: 'SUCCEEDED', status: 'DELIVERED' });
      expect(adapter.answerAttemptCount(planned.operationId)).toBe(1);
      expect((await deliverAgentAnswer({
        storage: value.storage, adapter, operationId: planned.operationId,
      })).operationState).toBe('SUCCEEDED');
      expect(adapter.answerAttemptCount(planned.operationId)).toBe(1);
      expect(value.storage.sqlite.query<{ kind: string; status: string }, []>(
        "SELECT kind,status FROM intents WHERE kind='ANSWER_AGENT'",
      ).get()).toEqual({ kind: 'ANSWER_AGENT', status: 'APPLIED' });
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM agent_sessions').get()?.state)
        .toBe('ACTIVE');
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM executions').get()?.state)
        .toBe('RUNNING');
      expect(value.storage.listTasks(value.projectId)[0]?.state).toBe('RUNNING');
      const eventPayload = value.storage.sqlite.query<{ payload_json: string }, []>(
        "SELECT payload_json FROM domain_events WHERE event_type='UserAnswerRecorded'",
      ).get()?.payload_json ?? '';
      expect(eventPayload).not.toContain('confirmed');
    } finally {
      value.storage.close();
    }
  });

  test('rejects an answer shape that does not match the provider dialog', async () => {
    const value = await fixture();
    try {
      const { attention } = await startWithAttention(value);
      expect(() => value.storage.planAttentionAnswer({
        projectId: value.projectId, attentionId: attention.id,
        commandId: '71000000-0000-4000-8000-000000000071', payloadHash: 'bad-value',
        intentId: '72000000-0000-4000-8000-000000000072',
        answerId: '73000000-0000-4000-8000-000000000073',
        operationId: '74000000-0000-4000-8000-000000000074',
        answer: { type: 'VALUE', value: 'yes' },
        intentEventId: '75000000-0000-4000-8000-000000000075',
        recordedEventId: '76000000-0000-4000-8000-000000000076',
        actor: 'local-user', recordedAt: 40,
      })).toThrow('VALUE answer does not match CONFIRM Attention');
      expect(value.storage.sqlite.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM intents WHERE kind='ANSWER_AGENT'",
      ).get()?.count).toBe(0);
    } finally {
      value.storage.close();
    }
  });

  test('retries only a proven pre-delivery failure', async () => {
    const value = await fixture();
    try {
      const { adapter, attention } = await startWithAttention(value, 'FAIL_BEFORE_DELIVERY');
      const planned = planConfirmAnswer(value, attention.id, true);
      await expect(deliverAgentAnswer({
        storage: value.storage, adapter, operationId: planned.operationId,
        now: () => 50, randomUUID: uuidSequence(700),
      })).rejects.toMatchObject({ code: 'AGENT_ANSWER_FAILED' });
      expect(value.storage.getAgentAnswerPlan(planned.operationId).operationState).toBe('PLANNED');
      expect(value.storage.listTasks(value.projectId)[0]?.state).toBe('WAITING_FOR_USER');
      const resumed = await deliverAgentAnswer({
        storage: value.storage, adapter: new DeterministicFakeAdapter(), operationId: planned.operationId,
        now: () => 60, randomUUID: uuidSequence(800),
      });
      expect(resumed.operationState).toBe('SUCCEEDED');
      expect(adapter.answerAttemptCount(planned.operationId)).toBe(1);
    } finally {
      value.storage.close();
    }
  });

  test('keeps ownership when answer delivery may have occurred', async () => {
    const value = await fixture();
    try {
      const { adapter, attention } = await startWithAttention(value, 'FAIL_AFTER_DELIVERY');
      const planned = planConfirmAnswer(value, attention.id, true);
      await expect(deliverAgentAnswer({
        storage: value.storage, adapter, operationId: planned.operationId,
        now: () => 50, randomUUID: uuidSequence(850),
      })).rejects.toMatchObject({ code: 'AGENT_ANSWER_FAILED' });
      expect(value.storage.getAgentAnswerPlan(planned.operationId).operationState)
        .toBe('RECONCILE_REQUIRED');
      expect(adapter.answerAttemptCount(planned.operationId)).toBe(1);
      expect(value.storage.sqlite.query<{ state: string; resource_held: number }, []>(
        'SELECT state,resource_held FROM executions',
      ).get()).toEqual({ state: 'RECOVERY_REQUIRED', resource_held: 1 });
    } finally {
      value.storage.close();
    }
  });

  test('marks an interrupted delivery as recovery-required without replaying it', async () => {
    const value = await fixture();
    try {
      const { attention } = await startWithAttention(value);
      const planned = planConfirmAnswer(value, attention.id, true);
      value.storage.startAgentAnswerOperation(planned.operationId, 50);
      expect(reconcileInterruptedAgentAnswers({
        storage: value.storage, now: () => 60, randomUUID: uuidSequence(900),
      })).toEqual([{ operationId: planned.operationId, attentionId: attention.id,
        outcome: 'RECOVERY_REQUIRED' }]);
      expect(value.storage.getAgentAnswerPlan(planned.operationId).operationState)
        .toBe('RECONCILE_REQUIRED');
      expect(value.storage.sqlite.query<{ state: string; resource_held: number }, []>(
        'SELECT state,resource_held FROM executions',
      ).get()).toEqual({ state: 'RECOVERY_REQUIRED', resource_held: 1 });
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM workspaces').get()?.state)
        .toBe('RECOVERY_REQUIRED');
    } finally {
      value.storage.close();
    }
  });
});

describe('Agent observation and durable event delivery', () => {
  test('deduplicates Attention events, persists the cursor, and retries outbox delivery', async () => {
    const value = await fixture();
    try {
      const execution = await reserveExecutionForAgent(value);
      const attention = {
        type: 'attention' as const,
        eventId: 'provider-attention-1',
        cursor: 'cursor-1',
        providerRequestId: 'provider-request-1',
        kind: 'PERMISSION' as const,
        responseType: 'CONFIRM' as const,
        prompt: { method: 'confirm', tool: 'write', path: 'src/index.ts' },
      };
      const adapter = new DeterministicFakeAdapter('SUCCEED', [attention, attention]);
      const started = await startReservedExecution({
        storage: value.storage,
        adapter,
        projectId: value.projectId,
        executionId: execution.executionId,
        expectedExecutionVersion: 0,
        prepareCommandId: '11000000-0000-4000-8000-000000000011',
        startCommandId: '12000000-0000-4000-8000-000000000012',
        now: () => 20,
        randomUUID: uuidSequence(100),
      });
      const observed = await observeAgentEvents({
        storage: value.storage,
        adapter,
        sessionId: started.sessionId,
        now: () => 30,
        randomUUID: uuidSequence(300),
      });
      expect(observed.map((result) => result.duplicate)).toEqual([false, true]);
      expect(value.storage.sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM adapter_events')
        .get()?.count).toBe(1);
      expect(() => value.storage.recordAgentAttention({
        sessionId: started.sessionId,
        executionId: execution.executionId,
        providerEventId: attention.eventId,
        cursor: attention.cursor,
        providerRequestId: attention.providerRequestId,
        kind: attention.kind,
        responseType: attention.responseType,
        prompt: { changed: true },
        attentionId: '51000000-0000-4000-8000-000000000051',
        attentionEventId: '52000000-0000-4000-8000-000000000052',
        executionEventId: '53000000-0000-4000-8000-000000000053',
        taskEventId: '54000000-0000-4000-8000-000000000054',
        observedAt: 31,
      })).toThrow('Provider event ID was reused with different content');
      expect(value.storage.sqlite.query<{ state: string; observation_cursor: string }, []>(
        'SELECT state,observation_cursor FROM agent_sessions',
      ).get()).toEqual({ state: 'WAITING_FOR_USER', observation_cursor: 'cursor-1' });
      expect(value.storage.listTasks(value.projectId)[0]?.state).toBe('WAITING_FOR_USER');

      let attentionAttempts = 0;
      const deliver = async (event: { eventType: string }): Promise<void> => {
        if (event.eventType === 'UserAttentionRequested') {
          attentionAttempts += 1;
          if (attentionAttempts === 1) throw new Error('temporary client failure');
        }
      };
      const first = await deliverPendingEvents({
        storage: value.storage, consumerId: 'test-ui', deliver, now: () => 40, retryDelayMs: 10,
      });
      expect(first.failed).toBe(1);
      expect((await deliverPendingEvents({
        storage: value.storage, consumerId: 'test-ui', deliver, now: () => 49, retryDelayMs: 10,
      })).delivered).toBe(0);
      expect((await deliverPendingEvents({
        storage: value.storage, consumerId: 'test-ui', deliver, now: () => 50, retryDelayMs: 10,
      })).delivered).toBe(1);
      expect(attentionAttempts).toBe(2);

      const afterRestart = await observeAgentEvents({
        storage: value.storage,
        adapter: new DeterministicFakeAdapter('SUCCEED', [attention]),
        sessionId: started.sessionId,
        now: () => 60,
        randomUUID: uuidSequence(400),
      });
      expect(afterRestart).toEqual([]);
    } finally {
      value.storage.close();
    }
  });

  test('persists provider session identity and treats a lost transport as recovery required', async () => {
    const value = await fixture();
    try {
      const execution = await reserveExecutionForAgent(value);
      const adapter = new DeterministicFakeAdapter('SUCCEED', [{ type: 'disconnected',
        eventId: 'provider-disconnect-1', cursor: 'cursor-1', reason: 'transport lost' }]);
      const started = await startReservedExecution({
        storage: value.storage, adapter, projectId: value.projectId,
        executionId: execution.executionId, expectedExecutionVersion: 0,
        prepareCommandId: '11000000-0000-4000-8000-000000000011',
        startCommandId: '12000000-0000-4000-8000-000000000012',
        now: () => 20, randomUUID: uuidSequence(100),
      });
      const session = value.storage.sqlite.query<
        { provider_session_id: string; process_identity_json: string | null; session_storage_ref: string | null }, []
      >('SELECT provider_session_id,process_identity_json,session_storage_ref FROM agent_sessions').get();
      expect(session).toEqual({ provider_session_id: `fake:${started.sessionId}`,
        process_identity_json: null, session_storage_ref: null });

      const observed = await observeAgentEvents({
        storage: value.storage, adapter, sessionId: started.sessionId,
        now: () => 30, randomUUID: uuidSequence(300),
      });
      expect(observed).toEqual([expect.objectContaining({ duplicate: false,
        sessionState: 'DISCONNECTED', executionState: 'RECOVERY_REQUIRED' })]);
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM agent_sessions').get()?.state)
        .toBe('DISCONNECTED');
      expect(value.storage.sqlite.query<{ state: string; resource_held: number }, []>(
        'SELECT state,resource_held FROM executions',
      ).get()).toEqual({ state: 'RECOVERY_REQUIRED', resource_held: 1 });
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM workspaces').get()?.state)
        .toBe('RECOVERY_REQUIRED');
      expect(value.storage.listTasks(value.projectId)[0]?.state).toBe('RECOVERY_REQUIRED');
      expect(value.storage.sqlite.query<{ types: number }, []>(`
        SELECT count(DISTINCT event_type) AS types FROM domain_events
        WHERE event_type IN ('AgentSessionStateChanged','ExecutionStateChanged','TaskStateChanged')
      `).get()?.types).toBe(3);

      await expect(observeAgentEvents({
        storage: value.storage, adapter, sessionId: started.sessionId,
        now: () => 40, randomUUID: uuidSequence(400),
      })).rejects.toThrow('cannot be observed from DISCONNECTED');
    } finally {
      value.storage.close();
    }
  });

  test('records successful completion without claiming Execution success before result capture', async () => {
    const value = await fixture();
    try {
      const execution = await reserveExecutionForAgent(value);
      const completed = {
        type: 'completed' as const,
        eventId: 'provider-completed-1',
        cursor: 'cursor-1',
        outcome: 'SUCCESS' as const,
        evidenceRef: 'fake-quiescence-1',
      };
      const adapter = new DeterministicFakeAdapter('SUCCEED', [completed, completed]);
      const started = await startReservedExecution({
        storage: value.storage, adapter, projectId: value.projectId,
        executionId: execution.executionId, expectedExecutionVersion: 0,
        prepareCommandId: '11000000-0000-4000-8000-000000000011',
        startCommandId: '12000000-0000-4000-8000-000000000012',
        now: () => 20, randomUUID: uuidSequence(100),
      });
      const observed = await observeAgentEvents({
        storage: value.storage, adapter, sessionId: started.sessionId,
        now: () => 30, randomUUID: uuidSequence(300),
      });
      expect(observed.map((result) => result.duplicate)).toEqual([false, true]);
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM agent_sessions').get()?.state)
        .toBe('EXITED');
      expect(value.storage.sqlite.query<{ state: string; resource_held: number }, []>(
        'SELECT state,resource_held FROM executions',
      ).get()).toEqual({ state: 'RUNNING', resource_held: 1 });
      expect(value.storage.listTasks(value.projectId)[0]?.state).toBe('RUNNING');
    } finally {
      value.storage.close();
    }
  });

  test('fails Execution only when completion supplies quiescence evidence', async () => {
    const value = await fixture();
    try {
      const execution = await reserveExecutionForAgent(value);
      const adapter = new DeterministicFakeAdapter('SUCCEED', [{
        type: 'completed', eventId: 'provider-completed-1', cursor: 'cursor-1',
        outcome: 'FAILURE', evidenceRef: 'fake-quiescence-1',
      }]);
      const started = await startReservedExecution({
        storage: value.storage, adapter, projectId: value.projectId,
        executionId: execution.executionId, expectedExecutionVersion: 0,
        prepareCommandId: '11000000-0000-4000-8000-000000000011',
        startCommandId: '12000000-0000-4000-8000-000000000012',
        now: () => 20, randomUUID: uuidSequence(100),
      });
      await observeAgentEvents({
        storage: value.storage, adapter, sessionId: started.sessionId,
        now: () => 30, randomUUID: uuidSequence(300),
      });
      expect(value.storage.sqlite.query<{ state: string; resource_held: number }, []>(
        'SELECT state,resource_held FROM executions',
      ).get()).toEqual({ state: 'FAILED', resource_held: 0 });
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM workspaces').get()?.state)
        .toBe('RETAINED');
      expect(value.storage.listTasks(value.projectId)[0]?.state).toBe('FAILED');
    } finally {
      value.storage.close();
    }
  });
});
