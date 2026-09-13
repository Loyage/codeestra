import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import { createResultCommit, stageResultChangeSet } from '@codeestra/git';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { captureResultCommit, prepareResultCommit, resultCommitMessage } from '../src/result-commit-service.js';
import { reconcileInterruptedResultCommits } from '../src/recovery-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  type AgentFixture,
} from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

async function run(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

interface QuiescentFixture {
  readonly value: AgentFixture;
  readonly workspacePath: string;
  readonly baseCommit: string;
}

/** Runs a deterministic fake that settles successfully, leaving a quiescent Execution. */
async function quiescentExecution(outcome: 'SUCCESS' | 'NONE' = 'SUCCESS'): Promise<QuiescentFixture> {
  const value = await createAgentFixture();
  const events = outcome === 'SUCCESS' ? [{
    type: 'completed' as const, eventId: 'fake-completed-1', cursor: 'cursor-1',
    outcome: 'SUCCESS' as const, evidenceRef: 'fake-quiescence',
  }] : [];
  const adapter = new DeterministicFakeAdapter('SUCCEED', events);
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const coordinator = new AgentRuntimeCoordinator({
    storage: value.storage, registry, runtimeHome: value.home,
  });
  const run = await coordinator.runTask({
    projectId: value.projectId, taskId: value.taskId, expectedTaskVersion: 1,
    commandId: crypto.randomUUID(), adapterId: adapter.id,
  });
  await coordinator.settle();
  return { value, workspacePath: run.workspacePath, baseCommit: run.baseCommit };
}

function firstExecution(value: AgentFixture) {
  const execution = value.storage.listTaskExecutions(value.projectId, value.taskId)[0];
  if (execution === undefined) throw new Error('Execution was not created');
  return execution;
}

describe('result commit preparation', () => {
  test('snapshots the change set without staging or committing anything', async () => {
    const { value, workspacePath, baseCommit } = await quiescentExecution();
    try {
      await Bun.write(join(workspacePath, 'agent-output.txt'), 'work\n');
      const prepared = await prepareResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        commandId: crypto.randomUUID(), actor: 'local-user',
      });
      expect(prepared).toMatchObject({
        baseCommit,
        headCommit: baseCommit,
        identity: { name: 'Test', email: 'test@example.invalid' },
        entries: [{ status: 'ADDED', path: 'agent-output.txt' }],
      });
      expect(prepared.treeFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(value.storage.getResultCommitAuthorization(prepared.authorizationId).status).toBe('ACTIVE');
      // Preparation is read-only: HEAD is unchanged and nothing is staged.
      expect(await run(workspacePath, ['rev-parse', 'HEAD'])).toBe(baseCommit);
      expect(await run(workspacePath, ['diff', '--cached', '--name-only'])).toBe('');
      expect(await run(value.repo, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
      expect(await run(value.repo, ['status', '--porcelain'])).toBe('');
    } finally {
      value.storage.close();
    }
  });

  test('refuses sensitive paths and records no authorization', async () => {
    const { value, workspacePath, baseCommit } = await quiescentExecution();
    try {
      await Bun.write(join(workspacePath, '.env'), 'TOKEN=secret\n');
      await Bun.write(join(workspacePath, 'ok.txt'), 'fine\n');
      await expect(prepareResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        commandId: crypto.randomUUID(), actor: 'local-user',
      })).rejects.toMatchObject({ code: 'SENSITIVE_PATH_BLOCKED' });
      expect(value.storage.sqlite.query<{ count: number }, []>(
        'SELECT count(*) AS count FROM result_commit_authorizations',
      ).get()?.count).toBe(0);
      // Nothing was staged or committed while refusing.
      expect(await run(workspacePath, ['rev-parse', 'HEAD'])).toBe(baseCommit);
      expect(await run(workspacePath, ['diff', '--cached', '--name-only'])).toBe('');
    } finally {
      value.storage.close();
    }
  });

  test('full mode permits sensitive paths and captures them without an approval step', async () => {
    const { value, workspacePath } = await quiescentExecution();
    try {
      await Bun.write(join(workspacePath, '.env'), 'TOKEN=full-access\n');
      const prepared = await prepareResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        commandId: crypto.randomUUID(), actor: 'runtime-full-permission', permissionMode: 'FULL',
      });
      expect(prepared.entries).toEqual([{ status: 'ADDED', path: '.env' }]);
      const captured = await captureResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        authorizationId: prepared.authorizationId, commandId: crypto.randomUUID(),
        permissionMode: 'FULL',
      });
      expect(captured.resultCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(captured.source).toBe('AUTOMATIC_FULL');
      expect(value.storage.listTasks(value.projectId)[0]?.state).toBe('EXECUTED');
    } finally {
      value.storage.close();
    }
  });

  test('refuses to prepare again once the result commit released the workspace', async () => {
    const { value, workspacePath } = await quiescentExecution();
    try {
      await Bun.write(join(workspacePath, 'agent-output.txt'), 'work\n');
      const prepared = await prepareResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        commandId: crypto.randomUUID(), actor: 'runtime-full-permission', permissionMode: 'FULL',
      });
      await captureResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        authorizationId: prepared.authorizationId, commandId: crypto.randomUUID(),
        permissionMode: 'FULL',
      });
      // Without an explicit Execution, the released workspace hold is reported as such.
      await expect(prepareResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        commandId: crypto.randomUUID(), actor: 'runtime-full-permission', permissionMode: 'FULL',
      })).rejects.toMatchObject({ code: 'NO_ACTIVE_EXECUTION' });
      // With an explicit already-captured Execution, the refusal names the real state instead of
      // creating an authorization that could never be consumed.
      await expect(prepareResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        executionId: prepared.executionId,
        commandId: crypto.randomUUID(), actor: 'runtime-full-permission', permissionMode: 'FULL',
      })).rejects.toMatchObject({ code: 'INVALID_EXECUTION_STATE' });
      expect(value.storage.sqlite.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM result_commit_authorizations WHERE status='ACTIVE'",
      ).get()?.count).toBe(0);
    } finally {
      value.storage.close();
    }
  });

  test('refuses a Session that never proved quiescence', async () => {
    const { value, workspacePath } = await quiescentExecution('NONE');
    try {
      await Bun.write(join(workspacePath, 'agent-output.txt'), 'work\n');
      await expect(prepareResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        commandId: crypto.randomUUID(), actor: 'local-user',
      })).rejects.toMatchObject({ code: 'AGENT_NOT_QUIESCENT' });
      expect(firstExecution(value).state).toBe('RUNNING');
    } finally {
      value.storage.close();
    }
  });
});

describe('result commit capture', () => {
  test('creates exactly one commit and moves Execution, workspace, and Task forward', async () => {
    const { value, workspacePath, baseCommit } = await quiescentExecution();
    try {
      await Bun.write(join(workspacePath, 'agent-output.txt'), 'work\n');
      const prepared = await prepareResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        commandId: crypto.randomUUID(), actor: 'local-user',
      });
      const captured = await captureResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        authorizationId: prepared.authorizationId, commandId: crypto.randomUUID(),
      });
      expect(captured.alreadyCaptured).toBe(false);
      expect(captured.resultCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(captured.resultTree).toMatch(/^[0-9a-f]{40}$/);
      expect(captured).toMatchObject({
        hookOutcome: 'PASSED',
        source: 'CONFIRMED',
        identity: { name: 'Test', email: 'test@example.invalid' },
      });
      expect(await run(workspacePath, ['rev-parse', 'HEAD'])).toBe(captured.resultCommit);
      expect(await run(workspacePath, ['rev-parse', 'HEAD^'])).toBe(baseCommit);
      expect(await run(workspacePath, ['log', '-1', '--format=%s'])).toBe(resultCommitMessage({
        taskDisplayNumber: 1, revisionId: prepared.revisionId, executionId: prepared.executionId,
      }));
      expect(value.storage.getResultCommitAuthorization(prepared.authorizationId).status).toBe('CONSUMED');
      const execution = firstExecution(value);
      expect(execution).toMatchObject({ state: 'SUCCEEDED', resourceHeld: false });
      expect(value.storage.listTasks(value.projectId)[0]?.state).toBe('EXECUTED');
      expect(value.storage.sqlite.query<{ state: string }, []>('SELECT state FROM workspaces').get()?.state)
        .toBe('RETAINED');
      const event = value.storage.sqlite.query<{ payload_json: string }, []>(
        "SELECT payload_json FROM domain_events WHERE event_type='ResultCommitCreated'",
      ).get();
      expect(event).toBeDefined();
      expect(JSON.parse(event?.payload_json ?? '{}')).toMatchObject({
        resultCommit: captured.resultCommit,
        hookOutcome: 'PASSED',
        source: 'CONFIRMED',
        identity: { name: 'Test', email: 'test@example.invalid' },
      });
      // The user's main worktree is untouched.
      expect(await run(value.repo, ['status', '--porcelain'])).toBe('');
      expect(await run(value.repo, ['rev-parse', 'HEAD'])).toBe(baseCommit);
    } finally {
      value.storage.close();
    }
  });

  test('replays the same capture command without creating a second commit', async () => {
    const { value, workspacePath } = await quiescentExecution();
    try {
      await Bun.write(join(workspacePath, 'agent-output.txt'), 'work\n');
      const prepared = await prepareResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        commandId: crypto.randomUUID(), actor: 'local-user',
      });
      const commandId = crypto.randomUUID();
      const first = await captureResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        authorizationId: prepared.authorizationId, commandId,
      });
      const second = await captureResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        authorizationId: prepared.authorizationId, commandId,
      });
      expect(second.resultCommit).toBe(first.resultCommit);
      expect(second.alreadyCaptured).toBe(true);
      expect(await run(workspacePath, ['rev-list', '--count', 'HEAD'])).toBe('2');
    } finally {
      value.storage.close();
    }
  });

  test('invalidates the authorization when the worktree changes after preparation', async () => {
    const { value, workspacePath } = await quiescentExecution();
    try {
      await Bun.write(join(workspacePath, 'agent-output.txt'), 'work\n');
      const prepared = await prepareResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        commandId: crypto.randomUUID(), actor: 'local-user',
      });
      await Bun.write(join(workspacePath, 'agent-output.txt'), 'changed after preparation\n');
      await expect(captureResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        authorizationId: prepared.authorizationId, commandId: crypto.randomUUID(),
      })).rejects.toMatchObject({ code: 'STALE_AUTHORIZATION' });
      expect(value.storage.getResultCommitAuthorization(prepared.authorizationId).status).toBe('INVALIDATED');
      expect(await run(workspacePath, ['rev-list', '--count', 'HEAD'])).toBe('1');
      expect(value.storage.sqlite.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM operations WHERE kind='CAPTURE_RESULT'",
      ).get()?.count).toBe(0);
    } finally {
      value.storage.close();
    }
  });

  test('preserves the worktree and the authorization when a hook refuses the commit', async () => {
    const { value, workspacePath, baseCommit } = await quiescentExecution();
    try {
      const hooksDirectory = join(value.repo, '.git', 'hooks');
      const hook = join(hooksDirectory, 'pre-commit');
      await Bun.write(hook, '#!/bin/sh\necho "hook refused" >&2\nexit 1\n');
      chmodSync(hook, 0o755);
      await Bun.write(join(workspacePath, 'agent-output.txt'), 'work\n');
      const prepared = await prepareResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        commandId: crypto.randomUUID(), actor: 'local-user',
      });
      await expect(captureResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        authorizationId: prepared.authorizationId, commandId: crypto.randomUUID(),
      })).rejects.toMatchObject({ code: 'COMMIT_FAILED' });
      expect(await run(workspacePath, ['rev-parse', 'HEAD'])).toBe(baseCommit);
      expect(await run(workspacePath, ['diff', '--cached', '--name-only'])).toBe('agent-output.txt');
      expect(value.storage.getResultCommitAuthorization(prepared.authorizationId).status).toBe('ACTIVE');
      const operation = value.storage.sqlite.query<{ state: string }, []>(
        "SELECT state FROM operations WHERE kind='CAPTURE_RESULT'",
      ).get();
      expect(operation?.state).toBe('FAILED');

      // After the user fixes the hook, a new confirm command succeeds with the same authorization.
      await Bun.write(hook, '#!/bin/sh\nexit 0\n');
      chmodSync(hook, 0o755);
      const retried = await captureResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        authorizationId: prepared.authorizationId, commandId: crypto.randomUUID(),
      });
      expect(retried.resultCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(firstExecution(value).state).toBe('SUCCEEDED');
    } finally {
      value.storage.close();
    }
  });
});

describe('result commit reconciliation', () => {
  test('adopts a commit that was created before the Runtime stopped', async () => {
    const { value, workspacePath } = await quiescentExecution();
    try {
      await Bun.write(join(workspacePath, 'agent-output.txt'), 'work\n');
      const prepared = await prepareResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        commandId: crypto.randomUUID(), actor: 'local-user',
      });
      const authorization = value.storage.getResultCommitAuthorization(prepared.authorizationId);
      const operationId = crypto.randomUUID();
      value.storage.startResultCommitCapture({
        operationId,
        commandId: crypto.randomUUID(),
        authorizationId: authorization.id,
        expectedHead: authorization.expectedHead,
        changeFingerprint: authorization.changeFingerprint,
        startedAt: Date.now(),
      });
      // The commit lands, but the Runtime never records it.
      const message = resultCommitMessage({
        taskDisplayNumber: authorization.taskDisplayNumber,
        revisionId: authorization.appliedRevisionId,
        executionId: authorization.executionId,
      });
      await stageResultChangeSet(workspacePath);
      const outcome = await createResultCommit({
        workspacePath, expectedHead: authorization.expectedHead, message,
      });
      expect(outcome.commitExists).toBe(true);

      const results = await reconcileInterruptedResultCommits({ storage: value.storage });
      expect(results).toEqual([expect.objectContaining({ operationId, outcome: 'RECOVERED_SUCCEEDED' })]);
      expect(firstExecution(value).state).toBe('SUCCEEDED');
      expect(value.storage.getResultCommitAuthorization(authorization.id).status).toBe('CONSUMED');
    } finally {
      value.storage.close();
    }
  });

  test('fails the Operation without touching the worktree when no commit was created', async () => {
    const { value, workspacePath, baseCommit } = await quiescentExecution();
    try {
      await Bun.write(join(workspacePath, 'agent-output.txt'), 'work\n');
      const prepared = await prepareResultCommit({
        storage: value.storage, projectId: value.projectId, taskId: value.taskId,
        commandId: crypto.randomUUID(), actor: 'local-user',
      });
      const authorization = value.storage.getResultCommitAuthorization(prepared.authorizationId);
      const operationId = crypto.randomUUID();
      value.storage.startResultCommitCapture({
        operationId,
        commandId: crypto.randomUUID(),
        authorizationId: authorization.id,
        expectedHead: authorization.expectedHead,
        changeFingerprint: authorization.changeFingerprint,
        startedAt: Date.now(),
      });
      const results = await reconcileInterruptedResultCommits({ storage: value.storage });
      expect(results).toEqual([expect.objectContaining({ operationId, outcome: 'FAILED_NO_COMMIT' })]);
      expect(value.storage.sqlite.query<{ state: string }, []>(
        "SELECT state FROM operations WHERE kind='CAPTURE_RESULT'",
      ).get()?.state).toBe('FAILED');
      expect(value.storage.getResultCommitAuthorization(authorization.id).status).toBe('ACTIVE');
      expect(await run(workspacePath, ['rev-parse', 'HEAD'])).toBe(baseCommit);
      expect(firstExecution(value).state).toBe('RUNNING');
    } finally {
      value.storage.close();
    }
  });
});
