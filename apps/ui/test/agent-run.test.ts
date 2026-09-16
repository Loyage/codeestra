import { describe, expect, it } from 'vitest';
import {
  agentFinalOutput,
  agentRunCapturable,
  agentRunFactLines,
  agentRunHeadline,
  agentRunLabel,
  agentRunPhase,
  agentRunRowHint,
  agentRunTone,
  taskNextStep,
  type AgentRunFactView,
  type TaskNextStepInput,
} from '../src/agent-run.js';
import type { AgentCompletionFactsView } from '../src/types.js';

function run(overrides: Partial<AgentRunFactView> = {}): AgentRunFactView {
  return { state: 'RUNNING', resourceHeld: true, sessionState: 'ACTIVE',
    completionOutcome: null, ...overrides };
}

function facts(overrides: Partial<AgentCompletionFactsView> = {}): AgentCompletionFactsView {
  return { toolCallCount: 14, finalAssistantText: '已把 X 改成 Y，测试通过。',
    finalAssistantTextTruncated: false, finalAssistantStopReason: 'end_turn', ...overrides };
}

function nextStep(overrides: Partial<TaskNextStepInput> = {}): string {
  return taskNextStep({
    taskState: 'RUNNING',
    archived: false,
    openAttentionCount: 0,
    verifying: false,
    canCapture: false,
    verificationPassed: false,
    agentRun: run(),
    failureCode: null,
    ...overrides,
  });
}

describe('agentRunPhase', () => {
  it('reads a live Session as running and a starting attempt as starting', () => {
    expect(agentRunPhase(run())).toBe('RUNNING');
    expect(agentRunPhase(run({ sessionState: null, state: 'CREATED' }))).toBe('STARTING');
    expect(agentRunPhase(run({ sessionState: 'STARTING' }))).toBe('STARTING');
    expect(agentRunPhase(run({ sessionState: 'WAITING_FOR_USER' }))).toBe('WAITING_FOR_USER');
    expect(agentRunPhase(null)).toBe('NOT_STARTED');
  });

  it('names a recorded outcome instead of the Session state', () => {
    expect(agentRunPhase(run({ sessionState: 'EXITED', completionOutcome: 'SUCCESS' })))
      .toBe('ENDED_OK');
    expect(agentRunPhase(run({ sessionState: 'EXITED', completionOutcome: 'FAILURE', state: 'FAILED',
      resourceHeld: false }))).toBe('ENDED_FAILED');
  });

  it('never turns a missing outcome into success', () => {
    const ended = agentRunPhase(run({ sessionState: 'EXITED' }));
    expect(ended).toBe('ENDED_UNRECORDED');
    expect(ended).not.toBe('ENDED_OK');
    expect(agentRunLabel(ended)).toContain('没有记录到结局');
    expect(agentRunTone(ended)).toBe('unknown');
    expect(agentRunTone(ended)).not.toBe('ok');
  });

  it('treats a disconnected Session as an unrecorded ending, not a failure', () => {
    expect(agentRunPhase(run({ sessionState: 'DISCONNECTED', state: 'RECOVERY_REQUIRED' })))
      .toBe('ENDED_UNRECORDED');
    expect(agentRunPhase(run({ sessionState: 'RECOVERY_REQUIRED', state: 'RECOVERY_REQUIRED' })))
      .toBe('ENDED_UNRECORDED');
  });

  it('keeps a deliberate stop resumable even though the Session is gone', () => {
    expect(agentRunPhase(run({ sessionState: 'PAUSED', state: 'PAUSED' }))).toBe('PAUSED');
    expect(agentRunPhase(run({ sessionState: 'EXITED', state: 'PAUSING' }))).toBe('PAUSED');
  });

  it('gives every phase a headline and a badge', () => {
    const phases = ['NOT_STARTED', 'STARTING', 'RUNNING', 'WAITING_FOR_USER', 'PAUSED',
      'ENDED_OK', 'ENDED_FAILED', 'ENDED_UNRECORDED'] as const;
    for (const phase of phases) {
      expect(agentRunHeadline(phase).length).toBeGreaterThan(0);
      expect(agentRunLabel(phase).length).toBeGreaterThan(0);
    }
  });
});

describe('agentRunCapturable', () => {
  it('is the Runtime predicate: RUNNING attempt, resource held, Session EXITED', () => {
    expect(agentRunCapturable(run({ sessionState: 'EXITED' }))).toBe(true);
    expect(agentRunCapturable(run({ sessionState: 'EXITED', completionOutcome: 'SUCCESS' })))
      .toBe(true);
    // Still running, or already settled, or without a Session: nothing to capture.
    expect(agentRunCapturable(run())).toBe(false);
    expect(agentRunCapturable(run({ sessionState: 'EXITED', resourceHeld: false }))).toBe(false);
    expect(agentRunCapturable(run({ sessionState: 'EXITED', state: 'FAILED' }))).toBe(false);
    expect(agentRunCapturable(run({ sessionState: 'DISCONNECTED', state: 'RECOVERY_REQUIRED' })))
      .toBe(false);
    expect(agentRunCapturable(null)).toBe(false);
  });
});

describe('recorded provider facts', () => {
  it('reports a missing fact as missing instead of guessing a value', () => {
    expect(agentRunFactLines(null)).toEqual(['这次结束没有记录 provider 事实（旧记录，或 Adapter 未报告）。']);
    expect(agentRunFactLines(facts({ finalAssistantStopReason: null })).join(' '))
      .toContain('（provider 未报告）');
    expect(agentRunFactLines(facts()).join(' ')).toContain('工具调用 14 次');
    expect(agentRunFactLines(facts({ finalAssistantTextTruncated: true })).join(' '))
      .toContain('只保留了尾部');
  });

  it('returns the last output only when one was actually recorded', () => {
    expect(agentFinalOutput(facts())).toBe('已把 X 改成 Y，测试通过。');
    expect(agentFinalOutput(facts({ finalAssistantText: null }))).toBeNull();
    expect(agentFinalOutput(facts({ finalAssistantText: '   \n ' }))).toBeNull();
    expect(agentFinalOutput(null)).toBeNull();
  });
});

describe('taskNextStep', () => {
  it('names the recorded ending when the result can still be captured', () => {
    const captured = nextStep({ canCapture: true,
      agentRun: run({ sessionState: 'EXITED', completionOutcome: 'SUCCESS' }) });
    expect(captured).toContain('provider 记为成功');
    const unrecorded = nextStep({ canCapture: true, agentRun: run({ sessionState: 'EXITED' }) });
    expect(unrecorded).toContain('没有记录到结局');
    expect(unrecorded).not.toContain('记为成功');
  });

  it('stops advising a pause once the Session is gone but nothing is capturable', () => {
    const text = nextStep({ agentRun: run({ sessionState: 'EXITED', completionOutcome: 'SUCCESS' }) });
    expect(text).toContain('没有被记为可捕获成果');
    expect(text).not.toContain('暂停');
  });

  it('says the Agent is running while it is, and says so about the wait', () => {
    expect(nextStep()).toContain('Agent 正在运行');
    expect(nextStep({ agentRun: run({ sessionState: 'WAITING_FOR_USER' }) }))
      .toContain('正在等待你回答');
  });

  it('names the recorded failure code', () => {
    const text = nextStep({ taskState: 'FAILED', agentRun: run({ sessionState: 'EXITED',
      completionOutcome: 'FAILURE', state: 'FAILED', resourceHeld: false }),
    failureCode: 'AGENT_REPORTED_FAILURE' });
    expect(text).toContain('AGENT_REPORTED_FAILURE');
    expect(nextStep({ taskState: 'FAILED', agentRun: null })).toContain('本次执行失败');
  });

  it('distinguishes a disconnected Session from any other recovery', () => {
    expect(nextStep({ taskState: 'RECOVERY_REQUIRED',
      agentRun: run({ sessionState: 'DISCONNECTED', state: 'RECOVERY_REQUIRED' }) }))
      .toContain('连接已断开');
    expect(nextStep({ taskState: 'RECOVERY_REQUIRED',
      agentRun: run({ sessionState: 'EXITED', state: 'RECOVERY_REQUIRED' }) }))
      .toContain('需要人工检查');
  });

  it('reports a wait with no open request instead of claiming the Agent runs', () => {
    const text = nextStep({ taskState: 'WAITING_FOR_USER',
      agentRun: run({ sessionState: 'WAITING_FOR_USER' }) });
    expect(text).toContain('没有 OPEN 的待处理请求');
  });

  it('says what a pending stop is waiting for instead of falling back to the raw state', () => {
    expect(nextStep({ taskState: 'PAUSING' })).toContain('确认静止后才会进入「已暂停」');
    expect(nextStep({ taskState: 'CANCELLING' })).toContain('确认静止后才会记为「已终止」');
  });

  it('keeps an open request, an archive, and a dependency block ahead of the run wording', () => {
    expect(nextStep({ openAttentionCount: 1 })).toContain('有待处理请求');
    expect(nextStep({ archived: true })).toContain('已归档');
    expect(nextStep({ taskState: 'BLOCKED' })).toContain('上游依赖');
  });
});

describe('agentRunRowHint', () => {
  it('tells a settled run apart from a running one in the list', () => {
    expect(agentRunRowHint('RUNNING', run({ sessionState: 'EXITED',
      completionOutcome: 'SUCCESS' }))).toBe('Agent 已退出 · 等待提交成果');
    expect(agentRunRowHint('RUNNING', run({ sessionState: 'EXITED' })))
      .toBe('Agent 已退出 · 没有记录到结局');
    expect(agentRunRowHint('RUNNING', run())).toBe('Agent 正在运行 · 可查看会话与步骤');
  });

  it('leaves states whose own hint is more specific alone', () => {
    expect(agentRunRowHint('PAUSED', run({ sessionState: 'PAUSED', state: 'PAUSED' }))).toBeNull();
    expect(agentRunRowHint('EXECUTED', run({ sessionState: 'EXITED',
      completionOutcome: 'SUCCESS' }))).toBeNull();
    expect(agentRunRowHint('DRAFT', null)).toBeNull();
  });

  it('only claims a disconnect where one was recorded', () => {
    expect(agentRunRowHint('RECOVERY_REQUIRED', run({ sessionState: 'DISCONNECTED',
      state: 'RECOVERY_REQUIRED' }))).toContain('连接已断开');
    expect(agentRunRowHint('RECOVERY_REQUIRED', run({ sessionState: 'EXITED',
      state: 'RECOVERY_REQUIRED' }))).toBeNull();
  });
});
