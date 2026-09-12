import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRepository, prepareWorkspace } from '@codeestra/git';
import { Phase1Database } from '@codeestra/storage';
import { reconcileWorkspacePreparations } from '../src/recovery-service.js';
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

function uuidSequence(): () => string {
  let value = 10;
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
