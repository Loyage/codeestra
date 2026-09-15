import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  RetryOutcomeCard,
  TaskRetryForm,
  retryAdapterChoices,
  retryAdapterOptionLabel,
  retryAdapterSourceLabel,
  retryCodeNote,
  retryCommand,
  retryDependencySummary,
  retryDocumentedCodes,
  retryLastAdapterId,
  retryOutcomeKind,
  retryOutcomeNotice,
  retryRejectionNotice,
  retryRequeuedDetail,
  retryStartedExecution,
  retryWaitSummary,
  retryWorkspaceLabel,
} from '../src/task-retry.js';
import type { ExecutionView, TaskRetryOutcomeView } from '../src/types.js';

/**
 * Contract test for the `task retry` projection (ADR-0036 / FOUNDATION-061).
 *
 * Scope — what this file does and does not prove:
 * - It proves the projection keeps the *three* outcomes apart: `STARTED` (an Execution really was
 *   created), `WAIT` (the CLI's exit code 3 — requeued, nothing started) and `REFUSED` (requeued, the
 *   start was refused with a stable code). Only the first may read as 「已启动」.
 * - It proves the request is built with exactly the field names the CLI sends, including that
 *   `adapterId` is **omitted** when the user kept "the Adapter this Task last ran on".
 * - It proves the UI does not re-implement the eligibility state machine: the control is not gated
 *   on a state allow-list, and the refusal codes the domain can answer with all have a glossary note
 *   (checked against the domain source, so the list cannot drift silently).
 * - It does **not** prove anything about a live Runtime: no request is made here, so "a retry on a
 *   RUNNING Task is refused" is the Runtime's behaviour, not something this test shows. The Runtime
 *   remains the validating boundary (`TASK_NOT_FAILED`, `CONCURRENT_MODIFICATION`, `UNKNOWN_ADAPTER`
 *   and the workspace refusals are all decided there).
 * - It does **not** prove how the form looks, whether the Adapter list reads well, or that a browser
 *   renders the controls correctly. Those are human visual confirmation (ADR-0008 forbids browser
 *   and desktop automation, and this project does not use it).
 */

// ---------------------------------------------------------------------------------------------
// The refusal vocabulary comes from the domain, not from a copy of it here
// ---------------------------------------------------------------------------------------------

/** Block comments are stripped first: several of them contain a `;`, which would truncate the union. */
const domainSource = readFileSync(
  new URL('../../../packages/domain/src/task-retry.ts', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The sources a glossary entry has to be confirmed by: the retry decision, the contracts, the
 * storage error codes and the two Runtime services that answer a retry request. A code that appears
 * in none of them is a code this UI invented.
 */
const codeSources = [
  'packages/domain/src/task-retry.ts', 'packages/contracts/src/index.ts',
  'packages/storage/src/database.ts', 'apps/runtime/src/task-control-service.ts',
  'apps/runtime/src/schedule-service.ts',
].map((path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));

/** The codes a retry can be refused with, read from the domain union so this test cannot drift. */
function domainRefusalCodes(): readonly string[] {
  const codes: string[] = [];
  for (const union of ['TaskRetryRefusalCode', 'TaskRetryWorkspaceRefusalCode']) {
    const body = new RegExp(`export type ${union} =([\\s\\S]*?);`).exec(domainSource);
    if (body === null) throw new Error(`${union} not found in the domain source`);
    codes.push(...[...(body[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1] as string));
  }
  return codes;
}

describe('the refusal glossary covers what the domain can answer with', () => {
  it('documents every retry/workspace refusal code the domain defines', () => {
    const codes = domainRefusalCodes();
    expect(codes).toContain('TASK_NOT_FAILED');
    expect(codes).toContain('TASK_PAUSED');
    expect(codes).toContain('WORKSPACE_RECLAIMED');
    for (const code of codes) expect(retryCodeNote(code)).not.toBeNull();
  });

  it('always keeps the raw code visible next to the note', () => {
    for (const code of retryDocumentedCodes()) {
      expect(retryRejectionNotice(code, 'the Runtime said so')).toContain(code);
    }
    // An undocumented code is shown verbatim instead of being mapped to something invented.
    expect(retryCodeNote('SOMETHING_NEW')).toBeNull();
    expect(retryRejectionNotice('SOMETHING_NEW', 'boom')).toBe('SOMETHING_NEW: boom');
  });

  it('documents no code the command face never answers with', () => {
    for (const code of retryDocumentedCodes()) {
      expect(codeSources.some((source) => source.includes(code))).toBe(true);
    }
  });

  it('documents the three capacity wait codes as waits, not as failures', () => {
    const contracts = codeSources[1] ?? '';
    const union = /export type CapacityWaitReasonCode =([\s\S]*?);/.exec(contracts);
    if (union === null) throw new Error('CapacityWaitReasonCode not found in the contracts');
    const capacityCodes = [...(union[1] ?? '').matchAll(/'([A-Z_]+)'/g)]
      .map((match) => match[1] as string);
    expect(capacityCodes).toHaveLength(3);
    for (const code of capacityCodes) {
      expect(retryCodeNote(code)).toContain('本次未启动');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function start(overrides: Partial<TaskRetryOutcomeView['start']>): TaskRetryOutcomeView['start'] {
  return {
    projectId: 'project-1', taskId: 'task-1', outcome: 'STARTED', executionId: 'exec-2',
    sessionId: 'session-2', attemptNumber: 2, taskVersion: 8, workspaceId: 'workspace-1',
    workspacePath: '/tmp/worktrees/task-1', baseCommit: 'b'.repeat(40), adapterId: 'pi',
    adapterVersion: '1.2.3', sessionState: 'RUNNING', permissionMode: 'FULL', agentConfig: null,
    reservationId: 'reservation-1', wait: null, assessment: null, clearedUnknownBy: null,
    code: null, detail: 'the scheduler started the candidate', ...overrides,
  };
}

function retry(overrides: Partial<TaskRetryOutcomeView>): TaskRetryOutcomeView {
  return {
    projectId: 'project-1', taskId: 'task-1', state: 'READY', version: 8, retryId: 'retry-1',
    failedExecutionId: 'exec-1', failedAttemptNumber: 1, adapterId: 'pi', previousAdapterId: 'pi',
    adapterChanged: false, adapterSource: 'RECORDED',
    workspace: { mode: 'REUSE_VERIFIED', workspaceId: 'workspace-1', evidence: 'git:owned',
      detail: 'the Task keeps its own worktree' },
    dependencyReasons: [], start: start({}), ...overrides,
  };
}

const waitingForCapacity = retry({
  state: 'READY',
  start: start({
    outcome: 'WAIT', executionId: null, sessionId: null, attemptNumber: null, taskVersion: null,
    workspaceId: null, workspacePath: null, baseCommit: null, sessionState: null,
    permissionMode: null, reservationId: null, adapterVersion: null, code: 'CAPACITY_GLOBAL_LIMIT_REACHED',
    detail: 'the project is at its concurrency limit',
    wait: { kind: 'CAPACITY', code: 'CAPACITY_GLOBAL_LIMIT_REACHED',
      detail: 'the project is at its concurrency limit', reasonCodes: ['CAPACITY_GLOBAL_LIMIT_REACHED'],
      hits: [], blocking: ['task-9'], since: 1_000 },
  }),
});

const refusedByDependencies = retry({
  state: 'BLOCKED', version: 9,
  dependencyReasons: [{ code: 'UPSTREAM_NOT_INTEGRATED', prerequisiteTaskId: 'task-9',
    requiredRevisionId: 'revision-9', detail: 'the upstream result is not on dev yet' }],
  start: start({
    outcome: 'REFUSED', executionId: null, sessionId: null, attemptNumber: null,
    taskVersion: null, workspaceId: null, workspacePath: null, baseCommit: null,
    sessionState: null, permissionMode: null, reservationId: null, adapterVersion: null,
    code: 'DEPENDENCIES_UNMET', detail: 'the upstream dependency is not satisfied',
  }),
});

function execution(overrides: Partial<ExecutionView>): ExecutionView {
  return {
    executionId: 'exec-1', taskId: 'task-1', attemptNumber: 1, state: 'FAILED', adapterId: 'pi',
    adapterVersion: '1.2.3', resourceHeld: false, baseCommit: 'a'.repeat(40), revisionId: 'revision-1',
    resultCommit: null, error: { code: 'PROVIDER_FAILED', message: 'boom' }, agentConfig: null,
    session: null, ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// Three outcomes, and only one of them started something
// ---------------------------------------------------------------------------------------------

describe('a started Execution is told apart from a wait and from a refused start', () => {
  it('reports a real start as started', () => {
    expect(retryOutcomeKind(retry({}))).toBe('STARTED');
    expect(retryStartedExecution(retry({}))).toBe(true);
    expect(retryOutcomeNotice(retry({}))).toContain('新执行已启动');
    expect(retryOutcomeNotice(retry({}))).toContain('退出码 0');
  });

  it('never lets a capacity wait read as a start', () => {
    expect(retryOutcomeKind(waitingForCapacity)).toBe('WAITING');
    expect(retryStartedExecution(waitingForCapacity)).toBe(false);
    const notice = retryOutcomeNotice(waitingForCapacity);
    expect(notice).toContain('退出码 3');
    expect(notice).toContain('在等待');
    expect(notice).not.toContain('新执行已启动');
    expect(notice).not.toContain('已启动');
    // The requeue is still a fact that happened, with its audit id.
    expect(retryRequeuedDetail(waitingForCapacity)).toContain('已重新入队');
    expect(retryWaitSummary(waitingForCapacity)).toContain('容量等待');
    expect(retryWaitSummary(waitingForCapacity)).toContain('CAPACITY_GLOBAL_LIMIT_REACHED');
    expect(retryWaitSummary(waitingForCapacity)).toContain('task-9');
  });

  it('reports an unsatisfied dependency as a refused start, not as a wait', () => {
    expect(retryOutcomeKind(refusedByDependencies)).toBe('START_REFUSED');
    expect(retryStartedExecution(refusedByDependencies)).toBe(false);
    expect(retryOutcomeNotice(refusedByDependencies)).toContain('DEPENDENCIES_UNMET');
    expect(retryOutcomeNotice(refusedByDependencies)).not.toContain('已启动');
    expect(retryDependencySummary(refusedByDependencies)).toContain('UPSTREAM_NOT_INTEGRATED');
    expect(retryWaitSummary(refusedByDependencies)).toBeNull();
    expect(retryDependencySummary(retry({}))).toBeNull();
  });

  it('names where the Adapter came from, including the fallback', () => {
    expect(retryAdapterSourceLabel('REQUESTED')).toContain('你这次指定');
    expect(retryAdapterSourceLabel('RECORDED')).toContain('上一次运行');
    expect(retryAdapterSourceLabel('FALLBACK')).toContain('回退');
    expect(retryWorkspaceLabel('REBUILD_OWNED')).toContain('尚未创建');
    expect(retryWorkspaceLabel('REUSE_VERIFIED')).toContain('复用');
  });
});

// ---------------------------------------------------------------------------------------------
// The command, built exactly as the CLI builds it
// ---------------------------------------------------------------------------------------------

describe('task retry is built like the CLI command', () => {
  it('carries the CAS version and omits adapterId when the last Adapter is reused', () => {
    const command = retryCommand({ projectId: 'project-1', taskId: 'task-1',
      expectedVersion: 7, adapterId: null, commandId: 'cmd-1' });
    expect(command).toEqual({
      command: 'task.retry', commandId: 'cmd-1', projectId: 'project-1', taskId: 'task-1',
      expectedVersion: 7,
    });
    expect('adapterId' in command).toBe(false);
    expect(retryCommand({ projectId: 'project-1', taskId: 'task-1', expectedVersion: 7,
      adapterId: '   ', commandId: 'cmd-2' })['adapterId']).toBeUndefined();
  });

  it('sends the chosen adapter when the user picked one', () => {
    expect(retryCommand({ projectId: 'project-1', taskId: 'task-1', expectedVersion: 7,
      adapterId: ' claude ', commandId: 'cmd-3' })).toEqual({
      command: 'task.retry', commandId: 'cmd-3', projectId: 'project-1', taskId: 'task-1',
      expectedVersion: 7, adapterId: 'claude',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The Adapter facts come from recorded Execution rows and the Runtime's registry
// ---------------------------------------------------------------------------------------------

describe('the Adapter shown as "the one it last ran on" is the newest recorded attempt', () => {
  it('reads the newest attempt and ignores the older ones', () => {
    const executions = [execution({ executionId: 'exec-2', attemptNumber: 2, adapterId: 'claude' }),
      execution({ executionId: 'exec-1', attemptNumber: 1, adapterId: 'pi' })];
    expect(retryLastAdapterId(executions)).toBe('claude');
    expect(retryLastAdapterId([])).toBeNull();
  });

  it('keeps a last-Adapter that has left the registry visible instead of hiding it', () => {
    expect(retryAdapterChoices({ registered: ['claude', 'codex', 'pi'], lastAdapterId: 'pi' }))
      .toEqual([
        { adapterId: 'claude', registered: true }, { adapterId: 'codex', registered: true },
        { adapterId: 'pi', registered: true },
      ]);
    // The unregistered one keeps its fact: the option is shown, and the label says so.
    expect(retryAdapterChoices({ registered: ['claude', 'codex', 'pi'], lastAdapterId: 'gone' }))
      .toEqual([
        { adapterId: 'claude', registered: true }, { adapterId: 'codex', registered: true },
        { adapterId: 'pi', registered: true }, { adapterId: 'gone', registered: false },
      ]);
    expect(retryAdapterChoices({ registered: [], lastAdapterId: null })).toEqual([]);
    expect(retryAdapterOptionLabel({ adapterId: 'pi', lastAdapterId: 'pi', registered: true }))
      .toBe('pi · 上一次运行');
    expect(retryAdapterOptionLabel({ adapterId: 'gone', lastAdapterId: 'pi', registered: false }))
      .toBe('gone · 不在当前注册表');
  });
});

// ---------------------------------------------------------------------------------------------
// Rendered projection (no browser, no Runtime)
// ---------------------------------------------------------------------------------------------

function markup(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element);
}

describe('rendered retry projection', () => {
  it('states the CAS version, the default Adapter meaning and the refusal vocabulary', () => {
    const html = markup(createElement(TaskRetryForm, {
      taskVersion: 7, lastAdapterId: 'pi', adapters: [
        { adapterId: 'claude', registered: true }, { adapterId: 'codex', registered: true },
        { adapterId: 'pi', registered: true },
      ],
      adapterListError: null, selectedAdapter: '', busy: false,
      onSelectAdapter: () => {}, onRetry: () => {},
    }));
    expect(html).toContain('重试失败任务');
    expect(html).toContain('v7');
    expect(html).toContain('expected-version');
    expect(html).toContain('沿用该任务上一次运行的 Adapter（pi）');
    expect(html).toContain('runtime.ping');
    // Every refusal code is shown as-is, and the button is not gated on a local state allow-list.
    for (const code of ['TASK_NOT_FAILED', 'TASK_CANCELLED', 'TASK_STILL_RUNNING', 'TASK_PAUSED',
      'RECONCILE_REQUIRED', 'TASK_ARCHIVED']) expect(html).toContain(code);
    expect(html).toContain('重试（task retry）');
    expect(html).not.toContain('disabled=""');
    for (const adapterId of ['claude', 'codex', 'pi']) expect(html).toContain(`>${adapterId}`);
  });

  it('says the Adapter list could not be read instead of inventing one', () => {
    const html = markup(createElement(TaskRetryForm, {
      taskVersion: 3, lastAdapterId: null, adapters: [], adapterListError: 'UNAUTHORIZED: nope',
      selectedAdapter: '', busy: false, onSelectAdapter: () => {}, onRetry: () => {},
    }));
    expect(html).toContain('读取失败');
    expect(html).toContain('UNAUTHORIZED: nope');
    expect(html).toContain('无记录：回退到默认 Adapter');
    // With no registry read there is exactly one choice left: reuse the last Adapter.
    expect(html.match(/<option/g)?.length).toBe(1);
  });

  it('renders a wait as a wait: exit code 3, the reason, and no started Execution', () => {
    const html = markup(createElement(RetryOutcomeCard, { result: waitingForCapacity }));
    expect(html).toContain('已入队 · 在等待（退出码 3）');
    expect(html).toContain('容量等待');
    expect(html).toContain('CAPACITY_GLOBAL_LIMIT_REACHED');
    expect(html).toContain('state-waiting');
    expect(html).not.toContain('新执行已启动');
    // No Execution was started, so no execution/session line is rendered at all.
    expect(html).not.toContain('session');
    expect(html).not.toContain('execution ');
  });

  it('renders a started retry with the Execution, the Session and the workspace', () => {
    const html = markup(createElement(RetryOutcomeCard, { result: retry({}) }));
    expect(html).toContain('已启动');
    expect(html).toContain('exec-2');
    expect(html).toContain('session-2');
    expect(html).toContain('/tmp/worktrees/task-1');
    expect(html).toContain('state-ready');
    expect(html).toContain('沿用该任务上一次运行的 Adapter');
  });

  it('renders a refused start with the stable code and the unmet dependency', () => {
    const html = markup(createElement(RetryOutcomeCard, { result: refusedByDependencies }));
    expect(html).toContain('已入队 · 启动被拒绝');
    expect(html).toContain('DEPENDENCIES_UNMET');
    expect(html).toContain('UPSTREAM_NOT_INTEGRATED');
    expect(html).toContain('state-failed');
    expect(html).not.toContain('新执行已启动');
    // The requeue did happen, and the card says so without claiming a start.
    expect(html).toContain('已重新入队');
  });
});
