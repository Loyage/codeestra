import { describe, expect, it } from 'vitest';
import {
  capacityLimitSourceLabel,
  capacityWaitReasonLabel,
  completionNoteHeading,
  completionNoteSummary,
  decisionLabel,
  dependencyBlockReasonLabel,
  dispositionLabel,
  formatDuration,
  formatSince,
  holderObservationLabel,
  impactIncompleteReasonLabel,
  impactValidationCodeLabel,
  isSchedulingEventType,
  reconcileOutcomeLabel,
  reservationStateLabel,
  schedulingEventSummary,
  verdictLabel,
  verdictStateClass,
  waitKindLabel,
  waitReasonLabel,
  waitStateClass,
} from '../src/scheduling-labels.js';
import type { AgentCompletionNoteView } from '../src/types.js';

describe('verdicts', () => {
  it('renders the current rule: SAFE means no shared declared feature (ADR-0059)', () => {
    const text = verdictLabel('SAFE_TO_PARALLELIZE');
    expect(text).toContain('没有');
    expect(text).toContain('声明同一个功能');
    expect(verdictLabel('CONFLICTING')).toContain('声明了同一个功能');
    // A code this client does not know keeps its recorded name instead of being guessed at.
    expect(verdictLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });

  it('never renders a historical UNKNOWN as SAFE', () => {
    const text = verdictLabel('UNKNOWN');
    expect(text).toContain('UNKNOWN');
    expect(text).toContain('不再产生');
    expect(text).toContain('不等于 SAFE');
  });

  it('gives UNKNOWN the attention tone rather than the success tone', () => {
    expect(verdictStateClass('SAFE_TO_PARALLELIZE')).toContain('state-safe');
    expect(verdictStateClass('UNKNOWN')).toContain('state-unknown');
    expect(verdictStateClass('UNKNOWN')).not.toContain('state-safe');
    expect(verdictStateClass('CONFLICTING')).toContain('state-conflicting');
  });

  it('keeps `SAFE_TO_PARALLELIZE` distinct from the class name `SAFE`', () => {
    expect(verdictLabel('SAFE_TO_PARALLELIZE')).toContain('SAFE_TO_PARALLELIZE');
  });
});

describe('waits', () => {
  it('distinguishes a conflict wait from a capacity wait and never calls either BLOCKED', () => {
    expect(waitKindLabel('CONFLICT')).toBe('冲突等待');
    expect(waitKindLabel('CAPACITY')).toBe('容量等待');
    expect(waitStateClass('CONFLICT')).not.toContain('blocked');
    expect(waitStateClass('CAPACITY')).not.toContain('blocked');
  });

  it('names the two capacity dimensions separately (global vs adapter)', () => {
    expect(capacityWaitReasonLabel('CAPACITY_GLOBAL_LIMIT_REACHED')).toContain('全局');
    expect(capacityWaitReasonLabel('CAPACITY_ADAPTER_SLOT_LIMIT_REACHED')).toContain('adapter');
    expect(capacityWaitReasonLabel('SCHEDULER_DRAINING')).toContain('排水');
    expect(capacityWaitReasonLabel('CAPACITY_UNKNOWN_CODE')).toBe('CAPACITY_UNKNOWN_CODE');
  });

  it('explains the conflict reason code instead of a generic refusal', () => {
    expect(waitReasonLabel('SAME_UNFINISHED_FEATURE')).toContain('同一功能');
    // Historical codes stay renderable (ADR-0059 keeps them for old assessments and events).
    expect(waitReasonLabel('SAME_FILE')).toContain('同一路径');
    expect(waitReasonLabel('MISSING_IMPACT_SNAPSHOT')).toContain('没有可用');
  });

  it('reserves `BLOCKED` wording for unmet dependencies only', () => {
    expect(dispositionLabel('BLOCKED')).toContain('依赖未满足');
    expect(decisionLabel('BLOCKED')).toContain('依赖未满足');
    expect(decisionLabel('WAIT_CAPACITY')).not.toContain('BLOCKED');
    expect(decisionLabel('WAIT_CONFLICT')).not.toContain('BLOCKED');
    expect(dependencyBlockReasonLabel('UPSTREAM_NOT_INTEGRATED')).toContain('上游');
  });

  it('does not present a dry run as a start', () => {
    expect(dispositionLabel('WOULD_START')).toContain('dry run');
    expect(dispositionLabel('WOULD_START')).toContain('未启动');
    expect(dispositionLabel('STARTED')).toBe('已启动');
  });
});

describe('capacity and reservations', () => {
  it('reports where a limit came from', () => {
    expect(capacityLimitSourceLabel('DEFAULT')).toContain('默认');
    expect(capacityLimitSourceLabel('EXPLICIT')).toContain('显式');
  });

  it('keeps the three occupied reconciliation observations apart from the two that free a slot', () => {
    expect(holderObservationLabel('HOLDER_STILL_RUNNING')).toContain('保持占用');
    expect(holderObservationLabel('HOLDER_OWNERSHIP_UNVERIFIABLE')).toContain('RECOVERY_REQUIRED');
    expect(holderObservationLabel('PROCESS_IDENTITY_MISSING')).toContain('无法核验');
    expect(holderObservationLabel('HOLDER_STOPPED')).toContain('可释放');
    expect(holderObservationLabel('HOLDER_PROCESS_ID_REUSED')).toContain('可释放');
  });

  it('reports RECOVERY_REQUIRED as still occupied and never as released', () => {
    const text = reservationStateLabel('RECOVERY_REQUIRED');
    expect(text).toContain('仍占用');
    expect(text).not.toContain('已释放');
    expect(reservationStateLabel('RESERVED')).toContain('占用中');
    expect(reconcileOutcomeLabel('HELD')).toContain('保持占用');
    expect(reconcileOutcomeLabel('MARKED_RECOVERY_REQUIRED')).toContain('RECOVERY_REQUIRED');
    expect(reconcileOutcomeLabel('RELEASED')).toContain('已释放');
  });
});

describe('impact wording', () => {
  it('states that an incomplete snapshot can never be SAFE', () => {
    expect(impactIncompleteReasonLabel('INCOMPLETE_IMPACT')).toBe('INCOMPLETE_IMPACT');
    expect(impactIncompleteReasonLabel('EMPTY_MAPPING')).toContain('没有声明');
    expect(impactIncompleteReasonLabel('POLICY_NOT_CONFIRMED')).toContain('尚未重新确认');
  });

  it('says a missing or invalid mapping only blocks feature declarations (ADR-0059)', () => {
    expect(impactValidationCodeLabel('POLICY_ABSENT')).toContain('--feature');
    expect(impactValidationCodeLabel('POLICY_INVALID')).toContain('--feature');
    expect(impactValidationCodeLabel('OK')).toContain('生效');
  });
});

describe('durations', () => {
  it('formats a recorded waiting duration without predicting the future', () => {
    expect(formatDuration(0)).toBe('0 秒');
    expect(formatDuration(45_000)).toBe('45 秒');
    expect(formatDuration(133_000)).toBe('2 分 13 秒');
    expect(formatDuration(7_320_000)).toBe('2 小时 2 分');
  });

  it('reports a missing start as unknown instead of inventing one', () => {
    expect(formatSince(null, 1_000)).toBe('无起始记录');
    expect(formatSince(0, 1_000)).toBe('未记录开始时间');
    expect(formatSince(1_000, 46_000)).toBe('45 秒');
  });
});

describe('completion notes', () => {
  const note: AgentCompletionNoteView = {
    code: 'PROSE_QUESTION_NO_TOOL_USE',
    heuristic: 'NO_TOOL_CALLS_IN_RUN_AND_TRAILING_QUESTION_MARK',
    message: 'The provider reported no tool call in this run.',
    facts: {
      toolCallCount: 0,
      finalAssistantText: 'Which package manager should I use?',
      finalAssistantTextTruncated: false,
      finalAssistantStopReason: 'stop',
    },
  };

  it('presents the note as the shape of the ending, not as "the Agent is waiting for an answer"', () => {
    expect(completionNoteHeading).toContain('结束形态');
    expect(completionNoteHeading).toContain('不是「Agent 在等你回答」');
    expect(completionNoteHeading).toContain('也不是失败');
  });

  it('keeps the recorded facts visible next to the code', () => {
    const summary = completionNoteSummary(note);
    expect(summary).toContain('PROSE_QUESTION_NO_TOOL_USE');
    expect(summary).toContain('工具调用数：0');
    expect(summary).toContain('stop');
    expect(summary).toContain('问号');
    expect(summary).toContain('不改变任何任务或执行状态');
  });

  it('marks a truncated tail as truncated instead of showing it as the whole text', () => {
    expect(completionNoteSummary({ ...note, facts: { ...note.facts, finalAssistantTextTruncated: true } }))
      .toContain('只显示了尾部');
  });
});

describe('scheduling event summaries', () => {
  it('understands exactly the scheduling event names it renders', () => {
    for (const eventType of ['TaskScheduleDecided', 'TaskWaitingForCapacity',
      'TaskUnknownCleared', 'ExecutionSlotReserved', 'ExecutionSlotReleased',
      'SchedulerCapacityChanged', 'TaskWaitingForConflict']) {
      expect(isSchedulingEventType(eventType)).toBe(true);
    }
    expect(isSchedulingEventType('ExecutionStarted')).toBe(false);
  });

  it('summarizes a decision with its verdict and reason codes', () => {
    const summary = schedulingEventSummary('TaskScheduleDecided', {
      taskId: '11111111-1111-1111-1111-111111111111',
      executionId: '22222222-2222-2222-2222-222222222222',
      reservationId: '33333333-3333-3333-3333-333333333333',
      verdict: 'UNKNOWN',
      reasonCodes: ['INCOMPLETE_IMPACT'],
    });
    expect(summary).toContain('调度决定');
    expect(summary).toContain('无法证明');
    expect(summary).toContain('INCOMPLETE_IMPACT');
    expect(summary).toContain('11111111');
  });

  it('summarizes a capacity wait with the reason code and the blocking tasks', () => {
    const summary = schedulingEventSummary('TaskWaitingForCapacity', {
      taskId: 'aaaaaaa1-1111-1111-1111-111111111111',
      code: 'CAPACITY_GLOBAL_LIMIT_REACHED',
      reasonCodes: ['CAPACITY_GLOBAL_LIMIT_REACHED'],
      blocking: ['bbbbbbb2-2222-2222-2222-222222222222'],
    });
    expect(summary).toContain('容量等待');
    expect(summary).toContain('全局并发上限已满');
    expect(summary).toContain('bbbbbbb2');
  });

  it('says a release does not change the recorded verdict', () => {
    const summary = schedulingEventSummary('TaskUnknownCleared', {
      taskId: 'ccccccc3-3333-3333-3333-333333333333',
      revisionId: 'ddddddd4-4444-4444-4444-444444444444',
      verdict: 'UNKNOWN',
      analyzerVersion: 'impact-analyzer-v1',
      policyVersion: 'impact-policy-v1#abc',
      scope: 'SINGLE_START',
      releasedBy: 'local-user',
    });
    expect(summary).toContain('单次放行');
    expect(summary).toContain('判定仍是');
    expect(summary).toContain('无法证明');
  });

  it('summarizes a reservation with its holder-independent facts', () => {
    const summary = schedulingEventSummary('ExecutionSlotReserved', {
      taskId: 'eeeeeee5-5555-5555-5555-555555555555',
      revisionId: 'fffffff6-6666-6666-6666-666666666666',
      reservationId: '99999999-9999-9999-9999-999999999999',
      adapterId: 'pi',
      capacity: { globalLimit: 2, globalUsed: 1, adapterId: 'pi', adapterLimit: 2, adapterUsed: 1 },
    });
    expect(summary).toContain('预留槽位');
    expect(summary).toContain('pi');
    expect(summary).toContain('全局 1/2');
  });

  it('summarizes the workspace binding of a reservation', () => {
    expect(isSchedulingEventType('ExecutionSlotWorkspaceBound')).toBe(true);
    const summary = schedulingEventSummary('ExecutionSlotWorkspaceBound', {
      taskId: 'aaaaaa11-1111-1111-1111-111111111111',
      reservationId: 'bbbbbb22-2222-2222-2222-222222222222',
      workspaceId: 'cccccc33-3333-3333-3333-333333333333',
    });
    expect(summary).toContain('绑定工作区');
    expect(summary).toContain('cccccc33');
  });

  it('returns null for an event it does not understand instead of guessing', () => {
    expect(schedulingEventSummary('ExecutionStarted', {})).toBeNull();
    expect(schedulingEventSummary('TaskScheduleDecided', null)).toBeNull();
  });
});
