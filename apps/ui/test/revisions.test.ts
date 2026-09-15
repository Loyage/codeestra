import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  creationNotice,
  deliveryAdvisory,
  deliveryChannelLabel,
  deliveryFacts,
  deliveryResolvable,
  deliveryStateLabel,
  resolveOutcomeNotice,
  revisionCreateCommand,
  revisionDeliveryResolveCommand,
  revisionSpecSummary,
  RevisionCreateForm,
  RevisionDeliveryCard,
  RevisionDeliveryPanel,
  RevisionTable,
} from '../src/revisions.js';
import { RuntimeClient } from '../src/api.js';
import type {
  RevisionDeliveryAttemptView,
  RevisionDeliveryView,
  TaskRevisionSummaryView,
} from '../src/types.js';

/**
 * Contract test for the revision/delivery projection (ADR-0028).
 *
 * Scope — what this file does and does not prove:
 * - It proves the projection keeps the three facts apart: a delivery is only ever shown as
 *   **confirmed** when the Runtime's own `satisfied` flag says so, an acknowledgement is never read
 *   out of the absence of an error, and a `CHANNEL_UNSUPPORTED` delivery names the stop-and-restart
 *   route instead of looking delivered. It also proves the two state-changing commands are built
 *   with exactly the field names the CLI sends (`task revision create`,
 *   `task revision delivery resolve`).
 * - It does **not** prove anything about a live Runtime: no request is made here. The Runtime
 *   remains the validating boundary and is what refuses a revision that changes nothing, a stale
 *   `expectedVersion`, or a resolve on a delivery that already has an attempt in flight.
 * - It does **not** prove how the panel looks, how the chips read at a glance, or that a browser
 *   renders the controls correctly. Those are human visual confirmation (ADR-0008 forbids browser
 *   automation, and this project does not use it).
 */

// ---------------------------------------------------------------------------------------------
// The state vocabulary is the domain's, and only two states may ever read as confirmed
// ---------------------------------------------------------------------------------------------

const domainSource = readFileSync(
  new URL('../../../packages/domain/src/revision-delivery.ts', import.meta.url), 'utf8');

/** The FSM's states, read from the domain source so this test cannot drift from the wire values. */
function domainStates(): readonly string[] {
  const array = /revisionDeliveryStates = \[([\s\S]*?)\] as const/.exec(domainSource);
  if (array === null) throw new Error('revisionDeliveryStates not found in the domain source');
  return [...(array[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1] as string);
}

/** The states the domain itself calls satisfied — the only ones that may read as confirmed. */
function domainSatisfiedStates(): readonly string[] {
  const fn = /export function revisionDeliverySatisfied[\s\S]*?\n}/.exec(domainSource);
  if (fn === null) throw new Error('revisionDeliverySatisfied not found in the domain source');
  return [...(fn[0]).matchAll(/state === '([A-Z_]+)'/g)].map((match) => match[1] as string);
}

describe('the delivery vocabulary matches the domain FSM', () => {
  it('labels every domain state and never leaves a raw code as the label', () => {
    const states = domainStates();
    expect(states).toHaveLength(8);
    for (const state of states) {
      const label = deliveryStateLabel(state);
      expect(label).not.toBe(state);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('shows 已确认 for exactly the states the domain calls satisfied', () => {
    const confirmed = domainStates().filter((state) => deliveryStateLabel(state).includes('已确认'));
    expect(confirmed).toEqual([...domainSatisfiedStates()]);
    // A dispatched-but-unconfirmed fact must never be worded as a confirmation.
    for (const state of ['PENDING', 'IN_FLIGHT', 'UNACKNOWLEDGED', 'CHANNEL_UNSUPPORTED',
      'TIMED_OUT', 'FAILED']) {
      expect(deliveryStateLabel(state)).not.toContain('已确认');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function attempt(overrides: Partial<RevisionDeliveryAttemptView>): RevisionDeliveryAttemptView {
  return {
    id: 'attempt-1', attemptNumber: 1, channel: 'PROVIDER_CONVERSATION', executionId: 'exec-1',
    sessionId: 'session-1', incarnationId: null, state: 'IN_FLIGHT', evidenceRef: null,
    errorCode: null, detail: 'attempted', deadlineAt: null, startedAt: 1_000, endedAt: null,
    ...overrides,
  };
}

function delivery(overrides: Partial<RevisionDeliveryView>): RevisionDeliveryView {
  return {
    id: 'delivery-1', projectId: 'project-1', taskId: 'task-1', revisionId: 'revision-2',
    revisionNumber: 2, executionId: 'exec-1', sessionId: 'session-1', incarnationId: null,
    state: 'PENDING', attemptCount: 0, channel: null, deadlineAt: null, evidenceRef: null,
    detail: null, supersededByExecutionId: null, createdAt: 1_000, updatedAt: 1_000,
    acknowledgedAt: null, satisfied: false, stale: false, attempts: [], attemptInFlight: false,
    ...overrides,
  };
}

const channelUnsupported = delivery({
  state: 'CHANNEL_UNSUPPORTED', attemptCount: 1, channel: 'PROVIDER_CONVERSATION',
  detail: 'capability:UNSUPPORTED', attempts: [attempt({
    state: 'CHANNEL_UNSUPPORTED', endedAt: 1_100, detail: 'the Adapter reports no acknowledgement',
  })],
});

const acknowledged = delivery({
  state: 'ACKNOWLEDGED', attemptCount: 1, channel: 'PROVIDER_CONVERSATION',
  evidenceRef: 'ack:revision-2', satisfied: true, acknowledgedAt: 1_200,
  attempts: [attempt({ state: 'ACKNOWLEDGED', evidenceRef: 'ack:revision-2', endedAt: 1_200 })],
});

// ---------------------------------------------------------------------------------------------
// The three facts
// ---------------------------------------------------------------------------------------------

describe('recorded / dispatched / confirmed stay three separate facts', () => {
  it('records a requirement without claiming anything was dispatched or confirmed', () => {
    const facts = deliveryFacts(delivery({}));
    expect(facts.recorded).toBe(true);
    expect(facts.dispatched).toBe(false);
    expect(facts.confirmed).toBe(false);
    expect(facts.inFlight).toBe(false);
  });

  it('treats an in-flight attempt as dispatched but never as confirmed', () => {
    const facts = deliveryFacts(delivery({
      state: 'IN_FLIGHT', attemptCount: 1,
      attempts: [attempt({ state: 'IN_FLIGHT' })], attemptInFlight: true,
    }));
    expect(facts.dispatched).toBe(true);
    expect(facts.confirmed).toBe(false);
    expect(facts.inFlight).toBe(true);
  });

  it('never confirms a delivery whose attempts failed, timed out or were unacknowledged', () => {
    for (const state of ['UNACKNOWLEDGED', 'TIMED_OUT', 'FAILED'] as const) {
      const facts = deliveryFacts(delivery({
        state, attemptCount: 1, attempts: [attempt({ state, endedAt: 2_000 })],
      }));
      expect(facts.dispatched).toBe(true);
      expect(facts.confirmed).toBe(false);
      expect(deliveryResolvable(delivery({
        state, attemptCount: 1, attempts: [attempt({ state, endedAt: 2_000 })],
      }))).toBe(true);
    }
  });

  it('confirms only the acknowledgement and the verified successor', () => {
    expect(deliveryFacts(acknowledged).confirmed).toBe(true);
    expect(deliveryResolvable(acknowledged)).toBe(false);
    expect(deliveryAdvisory(acknowledged)).toBeNull();
    const restarted = delivery({
      state: 'SUPERSEDED_BY_RESTART', satisfied: true, supersededByExecutionId: 'exec-2',
      evidenceRef: 'execution:exec-2',
      attempts: [attempt({ state: 'SUPERSEDED_BY_RESTART', channel: 'STOP_AND_RESTART',
        endedAt: 3_000 })],
    });
    expect(deliveryFacts(restarted).confirmed).toBe(true);
    expect(deliveryFacts(restarted).confirmed).toBe(restarted.satisfied);
  });

  it('reads the list-form in-flight flag as liveness, not as a conclusion', () => {
    const facts = deliveryFacts(delivery({ state: 'IN_FLIGHT', attemptCount: 1,
      attemptInFlight: true }));
    expect(facts.inFlight).toBe(true);
    expect(facts.confirmed).toBe(false);
  });
});

describe('an Adapter without an acknowledgement channel is told apart from a confirmed one', () => {
  it('says the adapter cannot deliver hot and names the stop-and-restart route', () => {
    const facts = deliveryFacts(channelUnsupported);
    expect(facts.channelUnsupported).toBe(true);
    expect(facts.confirmed).toBe(false);
    const advisory = deliveryAdvisory(channelUnsupported);
    expect(advisory).toContain('不支持热投递');
    expect(advisory).toContain('停止当前执行并新建一次执行');
  });

  it('keeps a stale delivery visible and not resolvable by a restart', () => {
    const stale = delivery({ state: 'UNACKNOWLEDGED', attemptCount: 1, stale: true,
      attempts: [attempt({ state: 'UNACKNOWLEDGED', endedAt: 2_000 })] });
    expect(deliveryResolvable(stale)).toBe(false);
    expect(deliveryAdvisory(stale)).toContain('SUCCESSOR_REVISION_MISMATCH');
  });

  it('warns that an in-flight attempt must be concluded by the Runtime first', () => {
    const inFlight = delivery({ state: 'IN_FLIGHT', attemptCount: 1, attemptInFlight: true,
      attempts: [attempt({ state: 'IN_FLIGHT' })] });
    expect(deliveryResolvable(inFlight)).toBe(false);
    expect(deliveryAdvisory(inFlight)).toContain('IN_FLIGHT');
  });

  it('labels both channels with what they mean', () => {
    expect(deliveryChannelLabel('PROVIDER_CONVERSATION')).toBe('会话通报');
    expect(deliveryChannelLabel('STOP_AND_RESTART')).toBe('停止并新建执行');
    expect(deliveryChannelLabel(null)).toBe('—');
  });
});

// ---------------------------------------------------------------------------------------------
// The two write commands, built exactly as the CLI builds them
// ---------------------------------------------------------------------------------------------

describe('task revision create is built like the CLI command', () => {
  it('sends the specification, one id per constraint and the reason', () => {
    const command = revisionCreateCommand({
      projectId: 'project-1', taskId: 'task-1', expectedVersion: 7, commandId: 'cmd-1',
      specification: '  new specification  ', constraints: ['first', '  second  ', '   '],
      reason: '  用户修订请求  ', constraintIdFactory: (() => {
        let next = 0;
        return () => `constraint-${(next += 1)}`;
      })(),
    });
    expect(command).toEqual({
      command: 'task.revision.create', commandId: 'cmd-1', projectId: 'project-1',
      taskId: 'task-1', expectedVersion: 7, specification: 'new specification',
      constraints: [{ id: 'constraint-1', text: 'first' }, { id: 'constraint-2', text: 'second' }],
      reason: '用户修订请求',
    });
  });

  it('omits the specification when only constraints are added', () => {
    const command = revisionCreateCommand({
      projectId: 'project-1', taskId: 'task-1', expectedVersion: 1, commandId: 'cmd-2',
      specification: '   ', constraints: ['one more constraint'], reason: '',
      constraintIdFactory: () => 'constraint-id',
    });
    expect('specification' in command).toBe(false);
    expect(command['constraints']).toEqual([{ id: 'constraint-id', text: 'one more constraint' }]);
    // The CLI's own default for a missing reason; the Runtime records it verbatim.
    expect(command['reason']).toBe('user revision request');
  });

  it('refuses a revision that would change nothing before it reaches the Runtime', () => {
    expect(() => revisionCreateCommand({
      projectId: 'project-1', taskId: 'task-1', expectedVersion: 1, commandId: 'cmd-3',
      specification: '   ', constraints: ['  '], reason: 'x',
    })).toThrow(/必须修改规格或至少追加一条约束/u);
  });
});

describe('task revision delivery resolve is built like the CLI command', () => {
  it('carries the delivery, the action, the expected Task version and the adapter', () => {
    expect(revisionDeliveryResolveCommand({
      projectId: 'project-1', taskId: 'task-1', deliveryId: 'delivery-1',
      action: 'STOP_AND_RESTART', expectedVersion: 4, adapterId: 'pi', commandId: 'cmd-4',
    })).toEqual({
      command: 'task.revision.delivery.resolve', commandId: 'cmd-4', projectId: 'project-1',
      taskId: 'task-1', deliveryId: 'delivery-1', action: 'STOP_AND_RESTART',
      expectedVersion: 4, adapterId: 'pi',
    });
    expect(revisionDeliveryResolveCommand({
      projectId: 'project-1', taskId: 'task-1', deliveryId: 'delivery-1', action: 'RETRY',
      expectedVersion: 4, adapterId: 'claude', commandId: 'cmd-5',
    })['action']).toBe('RETRY');
  });

  it('says "still unconfirmed" instead of reporting a resolution as a success', () => {
    const notice = resolveOutcomeNotice({
      outcome: 'UNSATISFIED',
      delivery: channelUnsupported,
      taskState: 'RUNNING',
      taskVersion: 5,
      successorExecutionId: null,
      predecessorExecutionId: 'exec-1',
      detail: 'the Adapter reports no acknowledgement capability',
    });
    expect(notice).toContain('仍未确认');
    expect(notice).toContain('the Adapter reports no acknowledgement capability');
    expect(notice).not.toContain('已确认 ');
  });

  it('reports a creation without a delivery requirement as exactly that', () => {
    expect(creationNotice({
      taskId: 'task-1', taskVersion: 3, revisionId: 'revision-9', revisionNumber: 9,
      previousRevisionId: 'revision-8', deliveryId: null, executionId: null, sessionId: null,
    })).toContain('没有产生投递要求');
    expect(creationNotice({
      taskId: 'task-1', taskVersion: 3, revisionId: 'revision-9', revisionNumber: 9,
      previousRevisionId: 'revision-8', deliveryId: 'delivery-9', executionId: 'exec-1',
      sessionId: 'session-1',
    })).toContain('不代表已经投递或确认');
  });
});

// ---------------------------------------------------------------------------------------------
// Rendered projection (no browser, no Runtime)
// ---------------------------------------------------------------------------------------------

const revision: TaskRevisionSummaryView = {
  id: 'revision-2', number: 2, previousRevisionId: 'revision-1',
  specification: 'Add the revision delivery ledger\nwith a second line', reason: 'user request',
  constraints: [{ id: 'constraint-1', text: 'never claim a delivery' },
    { id: 'constraint-2', text: 'keep the ledger append-only' }],
  actor: 'local-user', createdAt: 1_000, current: true,
};

function markup(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element);
}

describe('rendered revision/delivery projection', () => {
  it('renders the revision history with the current marker and both constraints', () => {
    const html = markup(createElement(RevisionTable, { revisions: [revision] }));
    expect(html).toContain('r2');
    expect(html).toContain('当前');
    expect(html).toContain('never claim a delivery');
    expect(html).toContain('keep the ledger append-only');
    // The full specification stays readable even though the table shows a summary.
    expect(html).toContain('Add the revision delivery ledger');
  });

  it('shows an unsupported channel as three facts plus the stop-and-restart control only', () => {
    const html = markup(createElement(RevisionDeliveryCard, {
      delivery: channelUnsupported, adapterId: 'pi', busy: false, onResolve: () => {},
    }));
    expect(html).toContain('已记录');
    expect(html).toContain('已投递（有通道尝试）');
    expect(html).toContain('未确认');
    expect(html).not.toContain('已确认<');
    expect(html).toContain('该 adapter 不支持热投递');
    expect(html).toContain('停止并新建执行（解决）');
    // Retrying a channel the Adapter reports as unavailable would only record the same fact again.
    expect(html).not.toContain('重试热投递');
  });

  it('offers both dispositions when the channel could still acknowledge', () => {
    const unacknowledged = delivery({ state: 'UNACKNOWLEDGED', attemptCount: 1,
      attempts: [attempt({ state: 'UNACKNOWLEDGED', endedAt: 2_000 })] });
    const html = markup(createElement(RevisionDeliveryCard, {
      delivery: unacknowledged, adapterId: 'pi', busy: false, onResolve: () => {},
    }));
    expect(html).toContain('停止并新建执行（解决）');
    expect(html).toContain('重试热投递');
    expect(html).toContain('未确认');
  });

  it('never offers a disposition for an already confirmed delivery', () => {
    const html = markup(createElement(RevisionDeliveryCard, {
      delivery: acknowledged, adapterId: 'pi', busy: false, onResolve: () => {},
    }));
    expect(html).toContain('已确认');
    expect(html).toContain('ack:revision-2');
    expect(html).not.toContain('停止并新建执行（解决）');
    expect(html).not.toContain('重试热投递');
  });

  it('states what creating a revision does before the button is usable', () => {
    const html = markup(createElement(RevisionCreateForm, {
      busy: false, taskVersion: 3, onCreate: () => {},
    }));
    expect(html).toContain('会追加一条不可变的规格版本');
    expect(html).toContain('会额外记录一条投递要求');
    expect(html).toContain('记录投递要求不等于投递，更不等于确认');
    expect(html).toContain('新建修订（追加版本）');
    // A revision that changes nothing cannot be submitted.
    expect(html).toContain('disabled=""');
  });

  it('keeps a long specification summary short and single-line', () => {
    const summary = revisionSpecSummary('a'.repeat(400));
    expect(summary.length).toBe(91);
    expect(summary.endsWith('…')).toBe(true);
    expect(revisionSpecSummary('one\ntwo')).toBe('one two');
  });

  it('mounts the panel against a Runtime that is not there (the read runs in an effect)', () => {
    // Server rendering runs no effects, so this proves the panel's frame and its three-fact
    // explanation render; the actual `task.revision.list` read is exercised by the Runtime's own
    // command tests plus the human check below the panel in a real browser.
    const html = markup(createElement(RevisionDeliveryPanel, {
      client: new RuntimeClient('http://127.0.0.1:0', 'panel-test-token'),
      projectId: 'project-1', taskId: 'task-1', taskVersion: 3, adapterId: 'pi', refreshToken: 0,
      run: () => Promise.resolve(),
    }));
    expect(html).toContain('记录 ≠ 投递 ≠ 确认');
    expect(html).toContain('只有结构化 ACK');
    expect(html).toContain('正在读取修订与投递');
  });
});
