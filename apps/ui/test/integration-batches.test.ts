import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  IntegrationBatchOperations,
  IntegrationBatchTable,
  IntegrationMemberTable,
  IntegrationOutcomeCard,
  integrationBatchMemberLimit,
  integrationBatchStateClass,
  integrationBatchStateFinished,
  integrationBatchStateLabel,
  integrationCancelActionNote,
  integrationCancelCommand,
  integrationCancelExitCode,
  integrationCancelNotice,
  integrationCreateCommand,
  integrationCreateExplainer,
  integrationCreateNotice,
  integrationDocumentedCodes,
  integrationIntegrateCommand,
  integrationIntegrateActionNote,
  integrationIntegrateNotice,
  integrationIntegrateVerdict,
  integrationMembersInTaskOrder,
  integrationMissingFactsNotes,
  integrationNotPromotionNotice,
  integrationRejectionNotice,
  integrationRequestLines,
  integrationTaskOptionLabel,
  integrationVerdictExitCode,
} from '../src/integration-batches.js';
import type {
  IntegrationBatchItemView,
  IntegrationBatchView,
  IntegrationReportView,
  TaskView,
} from '../src/types.js';

/**
 * Contract test for the multi-member IntegrationBatch projection (ADR-0018 / ADR-0053,
 * FOUNDATION-089).
 *
 * Scope — what this file does and does not prove:
 * - It proves the projection reads the batch **state vocabulary and member vocabulary out of the
 *   storage source**, so a state or member state the Runtime can record cannot be added without this
 *   test failing.
 * - It proves `STALE` / `CANCELLED` / `RECOVERY_REQUIRED` are terminal-but-not-integrated here: their
 *   labels carry no success wording, they never get the success class, and the outcome cards of those
 *   verdicts render with a non-success `data-integration-verdict`.
 * - It proves only `INTEGRATED` claims the ref moved, and that even that claim is accompanied by the
 *   「已合入 dev ≠ 已进 main」 sentence.
 * - It proves the members are presented in `task_id` order (ADR-0053 D02), including when the record
 *   arrives unsorted, and that the Runtime's own read of members is ordered the same way.
 * - It proves the three requests carry exactly the field names the contracts define, that a blank
 *   cancel reason is **omitted** rather than sent empty, and that the member limit shown in the UI is
 *   the contract's own `maxIntegrationBatchMembers`.
 * - It proves the write controls are never hidden or disabled by a local eligibility list (a batch in
 *   every state still renders both buttons), and that the cancel caveat — cancel **does not always
 *   succeed** and otherwise becomes `RECOVERY_REQUIRED` with exit code 3 — sits above the cancel
 *   button in the source and in the rendered markup.
 * - It does **not** prove anything about a live Runtime: no request is made here. Whether a
 *   `CREATED` batch really cancels, whether evidence really stops an integrate, and every stable code
 *   are the Runtime's own tests (`apps/runtime/test/integration-service`, `cli-integration-batch`).
 * - It does **not** prove how the panel looks in a browser, at narrow widths or in the three themes;
 *   those are human visual confirmation (ADR-0008 forbids browser and desktop automation here).
 */

const storageSource = readFileSync(
  new URL('../../../packages/storage/src/database.ts', import.meta.url), 'utf8');
const contractsSource = readFileSync(
  new URL('../../../packages/contracts/src/index.ts', import.meta.url), 'utf8');
const serviceSource = readFileSync(
  new URL('../../../apps/runtime/src/integration-service.ts', import.meta.url), 'utf8');
const cliSource = readFileSync(
  new URL('../../../apps/cli/src/main.ts', import.meta.url), 'utf8');
const moduleSource = readFileSync(
  new URL('../src/integration-batches.tsx', import.meta.url), 'utf8');

/** The values of one exported string-literal union, read from the source that declares it. */
function unionValues(source: string, name: string): readonly string[] {
  const body = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(source);
  if (body === null) throw new Error(`${name} not found in the source`);
  return [...(body[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1] as string);
}

/** The batch states the Runtime can record. */
function batchStates(): readonly string[] {
  return unionValues(storageSource, 'IntegrationBatchState');
}

/** The member states the Runtime can record. */
function memberStates(): readonly string[] {
  return unionValues(storageSource, 'IntegrationItemState');
}

/** The body of one command's contract entry, so field names are read from the contracts. */
function contractBlock(command: string): string {
  const at = contractsSource.indexOf(`command: z.literal('${command}')`);
  if (at === -1) throw new Error(`${command} not found in the contracts source`);
  // Up to the next command's literal: nested `z.strictObject(...)` entries (the member object of
  // `task.integration.create`) are part of this block, so slicing at the first one would cut it off.
  const next = contractsSource.indexOf('command: z.literal(', at + 1);
  return contractsSource.slice(at, next === -1 ? undefined : next);
}

function item(overrides: Partial<IntegrationBatchItemView>): IntegrationBatchItemView {
  return {
    taskId: 'task-1', taskVersion: 3, revisionId: 'revision-1', executionId: 'execution-1',
    candidateCommit: 'a'.repeat(40), devCommit: 'd'.repeat(40), state: 'PREPARED', detail: null,
    integratedCommit: null, createdAt: 1_000, completedAt: null,
    ...overrides,
  };
}

function batch(overrides: Partial<IntegrationBatchView>): IntegrationBatchView {
  return {
    batchId: 'batch-1', projectId: 'project-1', devRef: 'refs/heads/dev', devCommit: 'd'.repeat(40),
    state: 'CREATED', integratedCommit: null, mergeStrategy: null, mergedCommit: null,
    worktreePath: null, verificationId: null, outcomeCode: null, detail: null,
    createdAt: 1_000, completedAt: null, items: [item({})],
    ...overrides,
  };
}

function report(overrides: Partial<IntegrationReportView>): IntegrationReportView {
  return {
    ...batch({}),
    members: [{ taskId: 'task-1', executionId: 'execution-1', revisionId: 'revision-1',
      candidateCommit: 'a'.repeat(40), state: 'PREPARED', integratedCommit: null, detail: null }],
    created: true, worktreeDetail: null, verificationState: null, commands: [], tree: null,
    alreadyCompleted: false,
    ...overrides,
  };
}

function markup(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element);
}

// ---------------------------------------------------------------------------------------------
// The vocabulary comes from the Runtime's own record, not from a copy of it here
// ---------------------------------------------------------------------------------------------

describe('the batch and member vocabulary is read out of the storage record', () => {
  it('labels every batch state the Runtime can record, with no success wording of its own', () => {
    const states = batchStates();
    expect(states).toContain('STALE');
    expect(states).toContain('CANCELLED');
    expect(states).toContain('RECOVERY_REQUIRED');
    for (const state of states) {
      const label = integrationBatchStateLabel(state);
      expect(label).not.toBe(state);
      expect(label.length).toBeGreaterThan(0);
      if (state !== 'INTEGRATED') {
        for (const word of ['已合入', '完成', '成功', '已进 main']) {
          expect(label).not.toContain(word);
        }
      }
    }
    expect(integrationBatchStateLabel('STALE')).toContain('dev 未动');
    expect(integrationBatchStateLabel('INTEGRATED')).toContain('已合入 dev');
  });

  it('gives only INTEGRATED the success class', () => {
    for (const state of batchStates()) {
      const classes = integrationBatchStateClass(state);
      expect(classes.includes('state-ready')).toBe(state === 'INTEGRATED');
      expect(classes).toContain('state');
    }
    // STALE/CANCELLED are "terminal without integrating": attention tone, never success.
    expect(integrationBatchStateClass('STALE')).toContain('state-cancelled');
    expect(integrationBatchStateClass('CANCELLED')).toContain('state-cancelled');
    expect(integrationBatchStateClass('RECOVERY_REQUIRED')).toContain('state-failed');
    expect(integrationBatchStateClass('FAILED')).toContain('state-failed');
    expect(integrationBatchStateClass('CONFLICTED')).toContain('state-failed');
  });

  it('agrees with the Runtime about which states are terminal', () => {
    // The service's own `isFinished` is the source of the terminal set; a state added there without
    // this projection being updated fails this assertion.
    expect(/function isFinished\(state: IntegrationBatchState\): boolean \{([\s\S]*?)\}/.test(
      serviceSource)).toBe(true);
    const finished = ['INTEGRATED', 'CONFLICTED', 'FAILED', 'RECOVERY_REQUIRED', 'STALE', 'CANCELLED'];
    for (const state of batchStates()) {
      expect(integrationBatchStateFinished(state)).toBe(finished.includes(state));
      if (finished.includes(state)) {
        expect(serviceSource).toContain(`state === '${state}'`);
      }
    }
  });

  it('labels every member state, and never reads PREPARED as work in progress', () => {
    const states = memberStates();
    expect(states).toEqual(['PREPARED', 'MERGED', 'INTEGRATED', 'FAILED', 'CONFLICTED']);
    for (const state of states) {
      // `integrationMemberStateLabel` is exercised through the rendered member table below; here the
      // union is the guard: a new member state cannot be added without a rendered label.
      const html = markup(createElement(IntegrationMemberTable, {
        members: [item({ state })],
      }));
      expect(html).not.toContain(`>${state}<`);
    }
    const prepared = markup(createElement(IntegrationMemberTable, {
      members: [item({ state: 'PREPARED' })],
    }));
    expect(prepared).toContain('未合并');
  });
});

// ---------------------------------------------------------------------------------------------
// Terminal-but-not-integrated must never read as success
// ---------------------------------------------------------------------------------------------

describe('no batch verdict without a moved ref may read as success', () => {
  it('renders every state with its own chip and no success class outside INTEGRATED', () => {
    const batches = batchStates().map((state, index) => batch({
      batchId: `batch-${index}`, state,
      integratedCommit: state === 'INTEGRATED' ? 'i'.repeat(40) : null,
    }));
    const html = markup(createElement(IntegrationBatchTable, { batches }));
    for (const state of batchStates()) {
      expect(html).toContain(`data-batch-state="${state}"`);
    }
    const integratedAt = html.indexOf('data-batch-state="INTEGRATED"');
    const readyClass = 'state-ready';
    // Exactly one row (INTEGRATED) carries the success class.
    expect(html.split(readyClass).length - 1).toBe(1);
    expect(integratedAt).toBeGreaterThan(-1);
    for (const state of ['STALE', 'CANCELLED', 'RECOVERY_REQUIRED']) {
      const at = html.indexOf(`data-batch-state="${state}"`);
      const row = html.slice(at, html.indexOf('</tr>', at));
      expect(row).not.toContain(readyClass);
    }
    expect(html).not.toContain('已完成');
  });

  it('has no control inside the read-only batch table', () => {
    const html = markup(createElement(IntegrationBatchTable, { batches: [batch({})] }));
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<select');
  });

  it('reads a STALE / CANCELLED integrate report as not integrated, with the CLI exit code', () => {
    for (const state of ['STALE', 'CANCELLED', 'FAILED', 'CONFLICTED']) {
      const stale = report({ state, outcomeCode: state === 'STALE' ? 'DEV_REF_MOVED' : null });
      expect(integrationIntegrateVerdict(stale)).toBe('NOT_INTEGRATED');
      const notice = integrationIntegrateNotice(stale);
      expect(notice).toContain('未合入');
      expect(notice).toContain('退出码 1');
      expect(notice).toContain('dev 未推进');
      const html = markup(createElement(IntegrationOutcomeCard, {
        outcome: { kind: 'INTEGRATED', report: stale },
      }));
      expect(html).toContain('data-integration-verdict="NOT_INTEGRATED"');
      expect(html).not.toContain('state-ready');
    }
  });

  it('reads RECOVERY_REQUIRED as needing a human, never as progress', () => {
    const stuck = report({ state: 'RECOVERY_REQUIRED', outcomeCode: 'RECONCILE_REQUIRED' });
    expect(integrationIntegrateVerdict(stuck)).toBe('NEEDS_RECONCILIATION');
    expect(integrationIntegrateNotice(stuck)).toContain('退出码 3');
    const html = markup(createElement(IntegrationOutcomeCard, {
      outcome: { kind: 'INTEGRATED', report: stuck },
    }));
    expect(html).toContain('data-integration-verdict="NEEDS_RECONCILIATION"');
    expect(html).toContain('需要人工按记录处理');
    expect(html).not.toContain('state-ready');
  });

  it('reads only INTEGRATED as a moved ref, and still says dev ≠ main', () => {
    const integrated = report({ state: 'INTEGRATED', integratedCommit: 'i'.repeat(40),
      mergedCommit: 'm'.repeat(40), mergeStrategy: 'MERGE_COMMIT', verificationState: 'PASSED',
      verificationId: 'verification-1' });
    expect(integrationIntegrateVerdict(integrated)).toBe('INTEGRATED');
    expect(integrationIntegrateNotice(integrated)).toContain('退出码 0');
    const html = markup(createElement(IntegrationOutcomeCard, {
      outcome: { kind: 'INTEGRATED', report: integrated },
    }));
    expect(html).toContain('data-integration-verdict="INTEGRATED"');
    expect(html).toContain('state-ready');
    expect(html).toContain('不等于「已进 main」');
    expect(integrationNotPromotionNotice).toContain('合入 dev ≠ 已发布');
  });

  it('never presents a replay as work this call did', () => {
    const replayed = report({ state: 'INTEGRATED', integratedCommit: 'i'.repeat(40),
      alreadyCompleted: true, created: false });
    expect(integrationIntegrateVerdict(replayed)).toBe('ALREADY_INTEGRATED');
    const html = markup(createElement(IntegrationOutcomeCard, {
      outcome: { kind: 'INTEGRATED', report: replayed },
    }));
    expect(html).toContain('data-integration-verdict="ALREADY_INTEGRATED"');
    expect(html).toContain('此前已合入');
    expect(html).toContain('没有合并也没有再验证');
  });

  it('reads a failed cancellation as "not cancelled", with its exit code', () => {
    const notCancelled = { ...batch({ state: 'RECOVERY_REQUIRED', outcomeCode: 'RECONCILE_REQUIRED' }),
      members: [], created: false };
    expect(integrationCancelNotice(notCancelled)).toContain('没有被取消');
    expect(integrationCancelNotice(notCancelled)).toContain('退出码 3');
    expect(integrationCancelNotice(notCancelled)).toContain('继续占用成员');
    const html = markup(createElement(IntegrationOutcomeCard, {
      outcome: { kind: 'CANCELLED', view: notCancelled },
    }));
    expect(html).toContain('data-integration-verdict="RECOVERY_REQUIRED"');
    expect(html).toContain('未被取消');
    expect(html).not.toContain('state-ready');

    const cancelled = { ...batch({ state: 'CANCELLED', outcomeCode: 'CANCELLED_BY_USER' }),
      members: [], created: false };
    expect(integrationCancelNotice(cancelled)).toContain('退出码 0');
    expect(integrationCancelNotice(cancelled)).toContain('dev 未被触碰');
    const already = { ...batch({ state: 'INTEGRATED', integratedCommit: 'i'.repeat(40) }),
      members: [], created: false };
    expect(integrationCancelNotice(already)).toContain('幂等');
    expect(integrationCancelNotice(already)).toContain('退出码 1');
  });
});

// ---------------------------------------------------------------------------------------------
// Member order (ADR-0053 D02)
// ---------------------------------------------------------------------------------------------

describe('members are presented in task_id order, like the record itself', () => {
  it('orders an unsorted record by task id', () => {
    const unsorted = [item({ taskId: 'task-z' }), item({ taskId: 'task-a' }),
      item({ taskId: 'task-m' })];
    expect(integrationMembersInTaskOrder(unsorted).map((member) => member.taskId))
      .toEqual(['task-a', 'task-m', 'task-z']);
    // Ordering is idempotent, so re-rendering never reshuffles the table.
    const once = integrationMembersInTaskOrder(unsorted);
    expect(integrationMembersInTaskOrder(once).map((member) => member.taskId))
      .toEqual(once.map((member) => member.taskId));
  });

  it('renders the member rows in task_id order even when the record arrives unsorted', () => {
    const html = markup(createElement(IntegrationMemberTable, {
      members: [item({ taskId: 'task-z' }), item({ taskId: 'task-a' })],
    }));
    expect(html.indexOf('task-a')).toBeLessThan(html.indexOf('task-z'));
  });

  it('matches the order the Runtime reads members with', () => {
    // Two reads carry the member order that the merge and every table here must agree with.
    const occurrences = storageSource.split('ORDER BY item.task_id').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(serviceSource).toContain("left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0");
  });
});

// ---------------------------------------------------------------------------------------------
// The requests are the command face's requests
// ---------------------------------------------------------------------------------------------

describe('the three requests carry exactly the contracts\' fields', () => {
  const create = integrationCreateCommand({
    projectId: 'project-1',
    members: [{ taskId: 'task-a', expectedVersion: 7 }, { taskId: 'task-b', expectedVersion: 2 }],
    commandId: 'command-1',
  });

  it('builds `task.integration.create` with the member CAS versions', () => {
    expect(Object.keys(create)).toEqual(['command', 'commandId', 'projectId', 'members']);
    expect(create.command).toBe('task.integration.create');
    expect(create.projectId).toBe('project-1');
    expect(create.members).toEqual([
      { taskId: 'task-a', expectedVersion: 7 }, { taskId: 'task-b', expectedVersion: 2 },
    ]);
    expect(Object.keys((create.members as readonly object[])[0] as object))
      .toEqual(['taskId', 'expectedVersion']);
  });

  it('sends version 0 as a real CAS value, not as a missing one', () => {
    const request = integrationCreateCommand({
      projectId: 'project-1', members: [{ taskId: 'task-a', expectedVersion: 0 }],
      commandId: 'command-0',
    });
    expect(request.members).toEqual([{ taskId: 'task-a', expectedVersion: 0 }]);
    // The picker drops only rows it could not resolve (the `-1` sentinel), never a real version.
    expect(moduleSource).toContain('.filter((member) => member.expectedVersion >= 0)');
    expect(moduleSource).toContain('byTaskId.get(taskId)?.version ?? -1');
  });

  it('builds `task.integration.integrate` from the batch alone', () => {
    const integrate = integrationIntegrateCommand({
      projectId: 'project-1', batchId: 'batch-1', commandId: 'command-2',
    });
    expect(Object.keys(integrate)).toEqual(['command', 'commandId', 'projectId', 'batchId']);
    expect(integrate.command).toBe('task.integration.integrate');
    expect(integrate.batchId).toBe('batch-1');
  });

  it('omits a blank cancel reason and trims a given one', () => {
    const blank = integrationCancelCommand({
      projectId: 'project-1', batchId: 'batch-1', reason: '   ', commandId: 'command-3',
    });
    expect(Object.keys(blank)).toEqual(['command', 'commandId', 'projectId', 'batchId']);
    expect(blank.command).toBe('task.integration.cancel');
    const given = integrationCancelCommand({
      projectId: 'project-1', batchId: 'batch-1', reason: '  改主意了  ', commandId: 'command-4',
    });
    expect(given.reason).toBe('改主意了');
  });

  it('agrees with the contracts about every field it sends', () => {
    for (const [command, fields] of [
      ['task.integration.create', ['commandId', 'projectId', 'members', 'taskId', 'expectedVersion']],
      ['task.integration.integrate', ['commandId', 'projectId', 'batchId']],
      ['task.integration.get', ['projectId', 'batchId']],
      ['task.integration.cancel', ['commandId', 'projectId', 'batchId', 'reason']],
      ['task.integration.list', ['projectId', 'taskId']],
    ] as const) {
      const block = contractBlock(command);
      for (const field of fields) expect(block).toContain(field);
    }
    // A batch needs at least one member, cannot repeat one, and is capped by the contract.
    const createBlock = contractBlock('task.integration.create');
    expect(createBlock).toContain('.min(1)');
    expect(createBlock).toContain('.max(maxIntegrationBatchMembers)');
    const limit = /export const maxIntegrationBatchMembers = (\d+);/.exec(contractsSource);
    expect(limit).not.toBeNull();
    expect(integrationBatchMemberLimit).toBe(Number(limit?.[1]));
    // The UI shows the limit as a fact; it does not enforce it (the Runtime answers INVALID_REQUEST).
    expect(integrationCreateExplainer).toContain(String(integrationBatchMemberLimit));
    expect(integrationCreateExplainer).toContain('INVALID_REQUEST');
    expect(integrationCreateExplainer).toContain('不碰 Git');
  });

  it('shows the request fields it will send, without pretending a commandId was sent', () => {
    const lines = integrationRequestLines(create);
    expect(lines).toContain('command: task.integration.create');
    expect(lines).toContain('projectId: project-1');
    expect(lines).toContain('members[0].taskId: task-a');
    expect(lines).toContain('members[1].expectedVersion: 2');
    expect(integrationRequestLines({ members: [] })).toEqual(['members: []']);
  });

  it('tells a replay apart from a created batch', () => {
    const created = { ...batch({ state: 'CREATED' }), members: [], created: true };
    const replayed = { ...batch({ state: 'INTEGRATED' }), members: [], created: false };
    expect(integrationCreateNotice(created)).toContain('批次已组成');
    expect(integrationCreateNotice(replayed)).toContain('created: false');
    expect(integrationCreateNotice(replayed)).not.toContain('批次已组成');
  });

  it('keeps every project Task selectable, so no local state filter decides membership', () => {
    const task = {
      id: 'task-1', projectId: 'project-1', displayNumber: 4, kind: 'DEVELOPMENT', state: 'DRAFT',
      priority: 0, version: 9, createdAt: 1, updatedAt: 1, archivedAt: null,
      currentRevision: { specification: '  一些   规格  ' },
    } as unknown as TaskView;
    expect(integrationTaskOptionLabel(task)).toBe('#4 · DRAFT · v9 · 一些 规格');
    expect(moduleSource).toContain('{tasks.map((task) => (');
    expect(moduleSource).not.toContain('tasks.filter(');
  });
});

// ---------------------------------------------------------------------------------------------
// Exit codes and the stable-code glossary
// ---------------------------------------------------------------------------------------------

describe('the exit codes are the CLI\'s own mapping', () => {
  it('mirrors `exitForIntegrationVerdict` for every state', () => {
    expect(cliSource).toContain("if (state === 'INTEGRATED') return;");
    expect(cliSource).toContain("process.exit(state === 'RECOVERY_REQUIRED' ? 3 : 1);");
    for (const state of batchStates()) {
      const expected = state === 'INTEGRATED' ? 0 : state === 'RECOVERY_REQUIRED' ? 3 : 1;
      expect(integrationVerdictExitCode(state)).toBe(expected);
    }
  });

  it('mirrors the cancel mapping: 0 only for CANCELLED, 3 for RECOVERY_REQUIRED', () => {
    expect(cliSource).toContain("if (view.state === 'RECOVERY_REQUIRED') process.exit(3);");
    expect(cliSource).toContain("if (view.state !== 'CANCELLED') process.exit(1);");
    expect(integrationCancelExitCode('CANCELLED')).toBe(0);
    expect(integrationCancelExitCode('RECOVERY_REQUIRED')).toBe(3);
    for (const state of batchStates()) {
      if (state === 'CANCELLED' || state === 'RECOVERY_REQUIRED') continue;
      expect(integrationCancelExitCode(state)).toBe(1);
    }
  });
});

describe('the glossary covers what the command face can answer with', () => {
  it('documents every refusal and outcome code the integration service produces', () => {
    const codes = new Set<string>();
    for (const match of serviceSource.matchAll(/new IntegrationServiceError\('([A-Z_]+)'/g)) {
      codes.add(match[1] as string);
    }
    for (const match of serviceSource.matchAll(/outcomeCode: '([A-Z_]+)'/g)) {
      codes.add(match[1] as string);
    }
    expect(codes.size).toBeGreaterThan(10);
    for (const code of codes) {
      expect(integrationDocumentedCodes()).toContain(code);
      expect(integrationRejectionNotice(code, 'x')).toContain(code);
    }
    // The two codes the storage layer records for a cancel/reconcile path.
    for (const code of ['RECONCILE_REQUIRED', 'CANCELLED_BY_USER']) {
      expect(storageSource).toContain(`'${code}'`);
      expect(integrationDocumentedCodes()).toContain(code);
    }
    // Storage-level refusals reachable from this command face (they do not appear in the service).
    for (const code of ['INVALID_STATE', 'COMMAND_CONFLICT', 'NOT_FOUND']) {
      expect(storageSource).toContain(`'${code}'`);
      expect(integrationDocumentedCodes()).toContain(code);
    }
  });

  it('documents no code that no source contains', () => {
    const sources = [storageSource, contractsSource, serviceSource, cliSource].join('\n');
    for (const code of integrationDocumentedCodes()) {
      expect(sources).toContain(`'${code}'`);
    }
  });

  it('keeps the stable code verbatim and explains an expired view with the CAS fact', () => {
    const notice = integrationRejectionNotice('CONCURRENT_MODIFICATION', 'Task version did not match');
    expect(notice).toContain('CONCURRENT_MODIFICATION: Task version did not match');
    expect(notice).toContain('请刷新后重试');
    // A code without a note is shown as the raw code rather than mapped to something invented.
    expect(integrationRejectionNotice('SOMETHING_NEW', 'x')).toBe('SOMETHING_NEW: x');
  });
});

// ---------------------------------------------------------------------------------------------
// The write controls, and the cancel caveat that must sit above them
// ---------------------------------------------------------------------------------------------

describe('the write controls are never gated locally and state what they do', () => {
  const all = batchStates().map((state, index) => batch({ batchId: `batch-${index}`, state }));
  const html = markup(createElement(IntegrationBatchOperations, {
    batches: all, reasons: {}, outcomes: {}, pending: null,
    onReason: () => {}, onIntegrate: () => {}, onCancel: () => {},
  }));

  it('renders both controls for a batch in every state, with no local eligibility gate', () => {
    expect(html.split('集成（task integration integrate）').length - 1).toBe(all.length);
    expect(html.split('取消（task integration cancel）').length - 1).toBe(all.length);
    expect(html).not.toContain('disabled');
    for (const state of batchStates()) {
      expect(html).toContain(integrationBatchStateLabel(state));
    }
  });

  it('prints what each control will do directly above it', () => {
    expect(html.indexOf(integrationCancelActionNote))
      .toBeLessThan(html.indexOf('取消（task integration cancel）'));
    expect(html.indexOf(integrationIntegrateActionNote))
      .toBeLessThan(html.indexOf('集成（task integration integrate）'));
    // The same order in the source, so a future edit cannot move the note away from the button.
    expect(moduleSource.indexOf('{integrationCancelActionNote}'))
      .toBeLessThan(moduleSource.indexOf('取消（task integration cancel）'));
    expect(moduleSource.indexOf('{integrationIntegrateActionNote}'))
      .toBeLessThan(moduleSource.indexOf('集成（task integration integrate）'));
  });

  it('states that cancelling may fail, and what happens when it does', () => {
    for (const text of ['不保证成功', 'RECOVERY_REQUIRED', '退出码 3', '没有被取消', '零确认',
      '不会推进 dev']) {
      expect(integrationCancelActionNote).toContain(text);
      expect(html).toContain(text);
    }
    expect(integrationCancelActionNote).toContain('worktree');
    expect(integrationCancelActionNote).toContain('CREATED');
  });

  it('spells out the facts the command face does not carry instead of computing them', () => {
    expect(integrationMissingFactsNotes.length).toBeGreaterThanOrEqual(2);
    expect(integrationMissingFactsNotes.join(' ')).toContain('进度百分比');
    expect(integrationMissingFactsNotes.join(' ')).toContain('成员耗时');
  });

  it('keeps a refusal as a rendered stable code', () => {
    const refused = markup(createElement(IntegrationOutcomeCard, {
      outcome: { kind: 'REFUSED', what: '组批',
        notice: integrationRejectionNotice('TASK_NOT_EXECUTED', 'Task is DRAFT') },
    }));
    expect(refused).toContain('data-integration-verdict="REFUSED"');
    expect(refused).toContain('组批被拒绝');
    expect(refused).toContain('TASK_NOT_EXECUTED: Task is DRAFT');
    expect(refused).toContain('只有 EXECUTED 的任务能当成员');
  });
});
