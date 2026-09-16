/**
 * Pure wording and classification for "what did the newest Agent attempt do, and how did it end".
 *
 * Everything here maps *recorded facts* to sentences; nothing estimates, polls, or derives a
 * verdict the Runtime did not record. Three rules are load-bearing and tested:
 *
 * 1. An absent completion outcome is never rendered as success and never as failure. A Session that
 *    is gone without a recorded outcome ends as "no ending recorded" — which is exactly what the
 *    Runtime recorded, because a disconnect reason or a start failure stored in the same column is
 *    not a completion.
 * 2. "The Agent is still running" is only claimed from a Session/Execution state that says so. A
 *    settled attempt is never described as live, and no function here reports progress.
 * 3. `agentRunCapturable` is the *same* predicate the Runtime applies for `task.result.capture`, so
 *    a list row and the detail view cannot disagree about whether the result can be captured.
 *
 * Task text and provider text are rendered verbatim by the components; these helpers never parse
 * them and never inject markup.
 */

import type { AgentCompletionFactsView } from './types.js';

/** The newest Execution attempt plus the ending its Agent Session recorded. */
export interface AgentRunFactView {
  readonly state: string;
  /** True while this attempt still owns its reservation and workspace. */
  readonly resourceHeld: boolean;
  readonly sessionState: string | null;
  readonly completionOutcome: 'SUCCESS' | 'FAILURE' | null;
}

/**
 * How the newest attempt reads. `ENDED_UNRECORDED` is deliberately one case and not split into
 * "disconnected" and "crashed": the Runtime recorded that the Session is gone without recording an
 * outcome, and turning that into a diagnosis would be inventing one.
 */
export type AgentRunPhase = 'NOT_STARTED' | 'STARTING' | 'RUNNING' | 'WAITING_FOR_USER' | 'PAUSED'
  | 'ENDED_OK' | 'ENDED_FAILED' | 'ENDED_UNRECORDED';

const pausedStates = ['PAUSING', 'PAUSED', 'STOPPING'];
const goneSessionStates = ['EXITED', 'DISCONNECTED', 'RECOVERY_REQUIRED'];
const terminalExecutionStates = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'SUPERSEDED'];
const startingStates = ['CREATED', 'PREPARING', 'STARTING'];

export function agentRunPhase(run: AgentRunFactView | null): AgentRunPhase {
  if (run === null) return 'NOT_STARTED';
  // A stop the user asked for is resumable, so it wins over "the Session is gone".
  if (pausedStates.includes(run.state)
    || (run.sessionState !== null && pausedStates.includes(run.sessionState))) return 'PAUSED';
  if (run.completionOutcome === 'FAILURE') return 'ENDED_FAILED';
  if (run.completionOutcome === 'SUCCESS') return 'ENDED_OK';
  if (run.sessionState !== null && goneSessionStates.includes(run.sessionState)) {
    return 'ENDED_UNRECORDED';
  }
  if (run.sessionState === 'WAITING_FOR_USER') return 'WAITING_FOR_USER';
  if (terminalExecutionStates.includes(run.state)) return 'ENDED_UNRECORDED';
  if (startingStates.includes(run.state)
    || (run.sessionState !== null && startingStates.includes(run.sessionState))) return 'STARTING';
  return 'RUNNING';
}

/**
 * The predicate behind the `提交成果` button, and the only definition of "the Agent exited and the
 * result is still uncaptured" in this client.
 */
export function agentRunCapturable(run: AgentRunFactView | null): boolean {
  return run !== null && run.state === 'RUNNING' && run.resourceHeld
    && run.sessionState === 'EXITED';
}

/** Badge text. A phase this client does not know keeps the recorded words out of the badge. */
export function agentRunLabel(phase: AgentRunPhase): string {
  switch (phase) {
    case 'NOT_STARTED': return '未启动';
    case 'STARTING': return '启动中';
    case 'RUNNING': return '运行中';
    case 'WAITING_FOR_USER': return '等待用户';
    case 'PAUSED': return '已暂停';
    case 'ENDED_OK': return '已结束 · provider 记为成功';
    case 'ENDED_FAILED': return '已结束 · provider 记为失败';
    case 'ENDED_UNRECORDED': return '已结束 · 没有记录到结局';
  }
}

/** The card's headline. It states the ending, never an intent. */
export function agentRunHeadline(phase: AgentRunPhase): string {
  switch (phase) {
    case 'NOT_STARTED': return '还没有启动过 Agent';
    case 'STARTING': return 'Agent 正在启动';
    case 'RUNNING': return 'Agent 正在运行';
    case 'WAITING_FOR_USER': return 'Agent 正在等待你的回答';
    case 'PAUSED': return 'Agent 已暂停';
    case 'ENDED_OK': return 'Agent 运行已结束 · provider 记为成功';
    case 'ENDED_FAILED': return 'Agent 运行已结束 · provider 记为失败';
    case 'ENDED_UNRECORDED': return 'Agent 已结束 · 没有记录到结局';
  }
}

/** CSS tone for the badge: a missing outcome gets the unknown tone, never the success tone. */
export function agentRunTone(phase: AgentRunPhase): 'ok' | 'danger' | 'unknown' | 'active'
  | 'neutral' {
  switch (phase) {
    case 'ENDED_OK': return 'ok';
    case 'ENDED_FAILED': return 'danger';
    case 'ENDED_UNRECORDED': return 'unknown';
    case 'STARTING':
    case 'RUNNING':
    case 'WAITING_FOR_USER': return 'active';
    case 'NOT_STARTED':
    case 'PAUSED': return 'neutral';
  }
}

/** One line per recorded provider fact. An absent fact says so instead of guessing a value. */
export function agentRunFactLines(facts: AgentCompletionFactsView | null): readonly string[] {
  if (facts === null) return ['这次结束没有记录 provider 事实（旧记录，或 Adapter 未报告）。'];
  return [
    `停止原因 ${facts.finalAssistantStopReason ?? '（provider 未报告）'}`,
    `工具调用 ${facts.toolCallCount} 次`,
    `最后文本 ${facts.finalAssistantTextTruncated ? '只保留了尾部' : '完整'}`,
  ];
}

/**
 * The tail of the last assistant text the provider reported — what the Agent said as it stopped.
 * `null` when nothing was reported or the recorded text is blank, so a caller renders an honest
 * "nothing recorded" instead of an empty box.
 */
export function agentFinalOutput(facts: AgentCompletionFactsView | null): string | null {
  const text = facts?.finalAssistantText ?? null;
  return text === null || text.trim().length === 0 ? null : text;
}

export interface TaskNextStepInput {
  readonly taskState: string;
  readonly archived: boolean;
  readonly openAttentionCount: number;
  readonly integrationInFlight: boolean;
  readonly verifying: boolean;
  readonly canCapture: boolean;
  readonly integrated: boolean;
  readonly verificationPassed: boolean;
  readonly agentRun: AgentRunFactView | null;
  /** The newest attempt's recorded failure code, when one was recorded (`task status` only). */
  readonly failureCode: string | null;
}

/**
 * The one sentence the detail view shows as 「下一步」. The branches that depend on how the newest
 * Agent attempt ended name that ending; the rest are the state rules they always were.
 */
export function taskNextStep(input: TaskNextStepInput): string {
  const phase = agentRunPhase(input.agentRun);
  if (input.archived) return '任务已归档，记录与现场保留；可在「更多操作」中取消归档。';
  if (input.openAttentionCount > 0) return '有待处理请求，请在下方回答。其他任务不受影响。';
  if (input.taskState === 'DRAFT') {
    return '提交后进入自动调度，满足依赖、冲突与容量条件才会启动。创建草稿不会自动运行。';
  }
  if (input.taskState === 'READY') {
    return '任务等待调度；可手动尝试启动，Runtime 会核对依赖、冲突与容量，不保证立即运行。';
  }
  if (input.taskState === 'BLOCKED') {
    return '正在等待上游依赖满足。展开下方任务依赖，查看尚未满足的条件。';
  }
  if (input.integrationInFlight) return '集成尚未完成，请查看下方独立集成验证与合入记录。';
  if (input.verifying) return '任务验证进行中。下方显示实际步骤，可请求取消；完成前不能合入 dev。';
  if (input.canCapture) {
    return phase === 'ENDED_UNRECORDED'
      ? 'Agent 会话已退出，但没有记录到结局。提交成果前先在下方核对它实际做了什么。'
      : 'Agent 运行已结束（provider 记为成功）。若有代码变更，可提交成果，然后独立验证。';
  }
  if (input.taskState === 'EXECUTED') {
    if (!input.integrated) {
      return input.verificationPassed
        ? '验证已通过，可以合入 dev。合入会产生独立集成验证，并只在通过后移动 dev 引用。'
        : '成果已提交。先在固定 commit 上运行任务验证；验证通过后才能合入 dev。';
    }
    return '已合入 dev。dev → main 的稳定提升是另一条流程，不在这一步内。';
  }
  if (input.taskState === 'SUCCEEDED') return '成果已合入 dev；这不等于已提升到稳定的 main。';
  if (input.taskState === 'RUNNING') {
    if (phase === 'ENDED_UNRECORDED' || phase === 'ENDED_OK' || phase === 'ENDED_FAILED') {
      // The Session is gone but the attempt is not capturable, so "提交成果" is not on the table.
      return 'Agent 会话已退出，但这次尝试没有被记为可捕获成果；请在下方执行记录中核对。';
    }
    if (phase === 'PAUSED') {
      return '任务正在暂停或已暂停；「继续」会在同一工作树新建一次执行并复用该会话。';
    }
    if (phase === 'WAITING_FOR_USER') {
      return 'Agent 正在等待你回答一个请求；在下方回答后它会继续。';
    }
    if (phase === 'STARTING') return 'Agent 正在启动，尚未进入运行；可查看下方长命令步骤。';
    return 'Agent 正在运行；可查看下方执行过程，或暂停（保留现场、稍后继续）、终止。';
  }
  if (input.taskState === 'WAITING_FOR_USER') {
    return '任务在等待用户输入，但当前没有 OPEN 的待处理请求。刷新「待处理」或查看下方执行记录。';
  }
  if (input.taskState === 'PAUSING') {
    return '正在协作停止 provider 进程：确认静止后才会进入「已暂停」，在此之前工作树不会释放。';
  }
  if (input.taskState === 'PAUSED') {
    return '任务已暂停，provider 进程已确认退出；「继续」会在同一工作树新建一次执行并复用该会话。';
  }
  if (input.taskState === 'CANCELLING') {
    return '正在协作停止 provider 进程：确认静止后才会记为「已终止」，在此之前占用不释放。';
  }
  if (input.taskState === 'CANCELLED') return '任务已终止，不会自动重开；需要重做请新建任务。';
  if (input.taskState === 'RECOVERY_REQUIRED') {
    return input.agentRun?.sessionState === 'DISCONNECTED'
      ? '会话与 Runtime 的连接已断开，状态需要人工核对；不会自动重试。'
      : '执行状态需要人工检查，请展开执行与验证记录查看原因；不会自动重试。';
  }
  if (input.taskState === 'FAILED') {
    return input.failureCode === null
      ? '本次执行失败，请查看执行记录中的错误原因。'
      : `本次执行失败（${input.failureCode}），请查看执行记录中的错误原因。`;
  }
  return `当前状态：${input.taskState}。详情以 Runtime 记录为准。`;
}

/**
 * The list row's hint when the newest attempt's ending is more specific than the Task state — or
 * `null` when the plain state hint in the workbench should be kept. The words never contradict the
 * badge: a row still shows the *Task* state, and this only says what the attempt did.
 */
export function agentRunRowHint(taskState: string, run: AgentRunFactView | null): string | null {
  const phase = agentRunPhase(run);
  if (taskState === 'RECOVERY_REQUIRED' && run?.sessionState === 'DISCONNECTED') {
    return '会话连接已断开 · 不自动重试';
  }
  if (taskState !== 'RUNNING') return null;
  if (phase === 'ENDED_OK') {
    return agentRunCapturable(run) ? 'Agent 已退出 · 等待提交成果' : 'Agent 已结束（provider 记为成功）';
  }
  if (phase === 'ENDED_UNRECORDED') return 'Agent 已退出 · 没有记录到结局';
  if (phase === 'WAITING_FOR_USER') return 'Agent 正在等你回答 · 回答后继续';
  if (phase === 'STARTING') return 'Agent 正在启动';
  if (phase === 'RUNNING') return 'Agent 正在运行 · 可查看会话与步骤';
  return null;
}
