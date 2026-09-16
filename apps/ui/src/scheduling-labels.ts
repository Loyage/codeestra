/**
 * Pure wording helpers for the scheduling / impact / capacity projections.
 *
 * These are projections of facts the Runtime already reports: every function is a pure mapping from
 * a stable code or state to a sentence. They live outside the components so they can be unit-tested
 * without a DOM, and so the wording rules are stated in exactly one place.
 *
 * Two rules are load-bearing and are tested:
 *
 * 1. `SAFE_TO_PARALLELIZE` means exactly "no unfinished peer declares the same feature" and
 *    `CONFLICTING` means the opposite (ADR-0059); a historical `UNKNOWN` is never rendered as a soft
 *    `SAFE` or as "no conflict".
 * 2. A capacity wait and a conflict wait are never folded into `BLOCKED` (PROJECT_SPEC §2.10);
 *    `BLOCKED` only ever means an unmet dependency.
 *
 * Text that came from the Runtime or a provider is rendered verbatim and treated as untrusted: these
 * helpers never parse it, never strip ANSI, and never inject markup.
 */

import type { AgentCompletionNoteView, ScheduleWaitKindView } from './types.js';

/** What `labelValue` falls back to: a code this client does not know keeps its recorded name. */
function label(map: Readonly<Record<string, string>>, code: string): string {
  return map[code] ?? code;
}

/* -- Verdicts ------------------------------------------------------------------------------------- */

/** The verdicts of the current rule (ADR-0059); `UNKNOWN` is rendered as the historical value. */
export function verdictLabel(verdict: string): string {
  return label({
    SAFE_TO_PARALLELIZE: '默认并行（SAFE_TO_PARALLELIZE）：没有与任何未完成的任务声明同一个功能',
    UNKNOWN: '无法判定（UNKNOWN）：旧判定的历史记录，当时表示「无法证明不相交」；'
      + '当前规则不再产生它，也不等于 SAFE',
    CONFLICTING: '冲突（CONFLICTING）：与某个未完成的任务声明了同一个功能',
  }, verdict);
}

/** CSS class for a verdict badge; `UNKNOWN` gets the attention tone, never the success tone. */
export function verdictStateClass(verdict: string): string {
  if (verdict === 'SAFE_TO_PARALLELIZE') return 'state state-safe';
  if (verdict === 'CONFLICTING') return 'state state-conflicting';
  if (verdict === 'UNKNOWN') return 'state state-unknown';
  return 'state';
}

/* -- Waits ---------------------------------------------------------------------------------------- */

/** A wait is its own disposition; only `BLOCKED` means an unmet dependency. */
export function waitKindLabel(kind: ScheduleWaitKindView | string): string {
  return label({ CONFLICT: '冲突等待', CAPACITY: '容量等待' }, kind);
}

/**
 * The stable reason code behind a wait, in words. Analyzer codes and capacity codes share one map
 * because they are disjoint sets, but the sentences keep the two kinds distinguishable.
 */
export function waitReasonLabel(code: string): string {
  return label({
    // capacity (scheduler.md §1.1, ADR-0032)
    CAPACITY_GLOBAL_LIMIT_REACHED: '全局并发上限已满',
    CAPACITY_ADAPTER_SLOT_LIMIT_REACHED: '该 adapter 的槽位上限已满',
    SCHEDULER_DRAINING: 'Runtime 正在排水，拒绝新的预留',
    // the current rule (ADR-0059; conflict-analyzer.md §6.4)
    SAME_UNFINISHED_FEATURE: '两侧声明了同一功能，而对方还没开发完',
    // The codes below are retained because historical assessments and events contain them; the
    // current rule does not produce them.
    SAME_FILE: '两侧变更集包含同一路径',
    IMPORTANT_DIRECTORY_OVERLAP: '声明的重要目录有祖先/相等关系，或一侧文件落入另一侧的重要目录',
    SAME_MODULE: '两侧命中同一声明模块',
    GLOBAL_RESOURCE: '两侧写同一个全局资源',
    GLOBAL_RESOURCE_DEPENDENCY: '一侧写全局资源，另一侧改动了声明依赖该资源的路径',
    INCOMPLETE_IMPACT: '至少一侧的快照不完整，无法证明不相交',
    MISSING_IMPACT_SNAPSHOT: '活跃侧没有可用的影响快照',
    STALE_BASE: '基线已移动，评估不再适用',
    STALE_REVISION: '任务已修订，评估不再适用',
    STALE_POLICY: '影响映射已变化，评估不再适用',
    STALE_ANALYZER: '分析器已换代，评估不再适用',
    ACTUAL_DIFF_EXCEEDS_SNAPSHOT: '实际 diff 超出了快照记录的预测范围',
    SNAPSHOT_SCOPE_MISMATCH: '快照作用域与当前事实不匹配',
    INVALID_SCOPE: '作用域无效，无法评估',
    NO_CONFLICT: '没有与任何未完成任务共享声明的功能',
  }, code);
}

export function waitStateClass(kind: ScheduleWaitKindView | string): string {
  return kind === 'CAPACITY' ? 'state state-waiting' : 'state state-unknown';
}

/* -- Scheduling decisions ------------------------------------------------------------------------- */

/** One candidate's disposition in the ordered walk. `WOULD_START` is a dry run, not a start. */
export function dispositionLabel(disposition: string): string {
  return label({
    STARTED: '已启动',
    WOULD_START: '现在会启动（dry run，未预留、未启动）',
    WAITING: '等待中',
    BLOCKED: '阻塞（仅表示依赖未满足）',
    SKIPPED: '已跳过',
    FAILED: '失败',
  }, disposition);
}

/** `task schedule explain`'s one-Task decision. */
export function decisionLabel(decision: string): string {
  return label({
    START_NOW: '现在会启动',
    WAIT_CONFLICT: '冲突等待',
    WAIT_CAPACITY: '容量等待',
    WAIT_CONTROL: 'Runtime 全局暂停等待（不是 BLOCKED）',
    BLOCKED: '阻塞（仅表示依赖未满足）',
    ACTIVE: '已在活跃集合中',
    NOT_A_CANDIDATE: '不是调度候选（状态或 revision 不满足候选条件）',
  }, decision);
}

/** Dependency block reason codes (`task depends list`), the only meaning of `BLOCKED`. */
export function dependencyBlockReasonLabel(code: string): string {
  return label({
    UPSTREAM_NOT_INTEGRATED: '上游还没有到达 INTEGRATED 的合入批次',
    DEV_BASELINE_MISSING: '项目没有可读的 Task 基线 ref（所有边保持未满足）',
    DEV_REF_UNREADABLE: '基线 ref 读取失败（不当作“无冲突”或“已满足”）',
    NOT_REACHABLE_FROM_DEV: '上游已合入的 commit 已不在当前基线上',
  }, code);
}

/* -- Capacity ------------------------------------------------------------------------------------- */

export function capacityLimitSourceLabel(source: string): string {
  return label({ DEFAULT: '默认（未显式设置）', EXPLICIT: '显式设置' }, source);
}

export function capacityWaitReasonLabel(code: string): string {
  return label({
    CAPACITY_GLOBAL_LIMIT_REACHED: '全局上限已满',
    CAPACITY_ADAPTER_SLOT_LIMIT_REACHED: '该 adapter 槽位已满',
    SCHEDULER_DRAINING: 'Runtime 正在排水',
  }, code);
}

/* -- Reservations --------------------------------------------------------------------------------- */

export function reservationStateLabel(state: string): string {
  return label({
    RESERVED: '已预留（占用中）',
    RELEASED: '已释放',
    RECOVERY_REQUIRED: '需要恢复（仍占用，未自动放行）',
  }, state);
}

export function reservationStateClass(state: string): string {
  if (state === 'RELEASED') return 'state state-ready';
  if (state === 'RECOVERY_REQUIRED') return 'state state-failed';
  return 'state state-running';
}

export function reservationReleaseKindLabel(kind: string): string {
  return label({
    EXPLICIT: '显式释放',
    RECONCILED_HOLDER_EXITED: 'reconcile：持有者进程已退出',
    RECONCILED_PROCESS_ID_REUSED: 'reconcile：进程号被复用',
  }, kind);
}

/**
 * How the recorded holder looked against the real process table. The three cases that leave the
 * slot occupied must stay distinguishable from the two that prove it gone.
 */
export function holderObservationLabel(observation: string): string {
  return label({
    HOLDER_STOPPED: '持有者进程已不存在（可释放）',
    HOLDER_PROCESS_ID_REUSED: '进程号被复用，原持有者已不在（可释放）',
    HOLDER_STILL_RUNNING: '持有者仍存活：保持占用，不自动释放',
    HOLDER_OWNERSHIP_UNVERIFIABLE: '无法核验归属：保持占用并转为 RECOVERY_REQUIRED',
    PROCESS_IDENTITY_MISSING: '没有记录进程身份：无法核验，保持占用',
  }, observation);
}

export function reconcileOutcomeLabel(outcome: string): string {
  return label({
    RELEASED: '已释放（持有者被证明已退出）',
    MARKED_RECOVERY_REQUIRED: '转为 RECOVERY_REQUIRED（仍占用，需人工处理）',
    HELD: '保持占用（持有者仍存活或无法核验）',
    ALREADY_RELEASED: '早已释放',
    ALREADY_RECONCILED: '本次启动的代已收敛过',
    SKIPPED_HELD_BY_RUNTIME: '跳过（本代 Runtime 自己创建的预留）',
    FAILED: 'reconcile 失败',
  }, outcome);
}

/* -- Impact --------------------------------------------------------------------------------------- */

/** `ImpactReasonClass`: `SAFE` here is only the absence of a finding for one pair. */
export function impactReasonClassLabel(reasonClass: string): string {
  return label({
    CONFLICT: '已证明冲突',
    INCOMPLETE: '证据不完整（无法证明）',
    STALE_OR_INVALID: '评估已失效',
    SAFE: '该配对未发现重叠',
  }, reasonClass);
}

/** Why a snapshot is `complete: false`; any entry makes `SAFE` impossible. */
export function impactIncompleteReasonLabel(code: string): string {
  return label({
    POLICY_ABSENT: '项目没有影响映射（.codeestra/impact.json）',
    POLICY_INVALID: '影响映射无效',
    POLICY_NOT_CONFIRMED: '影响映射已变化，尚未重新确认',
    EMPTY_MAPPING: '映射有效但没有声明任何目录、模块或共享资源',
    UNCERTAIN_GLOBAL_EFFECT: '写入了消费者未声明的全局资源，影响范围不确定',
    UNBOUNDED_SCOPE: '变更集过大，无法完整描述',
  }, code);
}

/** How an impact subject's snapshot was obtained; `UNAVAILABLE` is the reason a peer is UNKNOWN. */
export function impactDispositionLabel(disposition: string): string {
  return label({
    RECORDED: '本次新记录快照',
    REUSED: '复用仍然有效的快照',
    UNAVAILABLE: '无法观测变更集，因此没有快照',
  }, disposition);
}

/** `project impact validate` codes; only the two `OK*` codes mean the mapping is in effect. */
export function impactValidationCodeLabel(code: string): string {
  return label({
    OK: '映射存在且已确认，正在生效',
    OK_UNTRUSTED: '映射存在且有效，但仓库尚未被信任',
    POLICY_ABSENT: 'main 引用上没有映射；无法用 --feature 声明功能（判定只看声明，不看映射）',
    POLICY_INVALID: '映射存在但不是有效 JSON/结构；无法用 --feature 声明功能',
    POLICY_NOT_CONFIRMED: '映射与已确认的摘要不一致；重新信任项目即可（FULL 下 0 步）',
  }, code);
}

export function impactPolicyStateLabel(state: string): string {
  return label({ ABSENT: '不存在', PRESENT: '存在', INVALID: '无效' }, state);
}

export function impactConfirmationStateLabel(state: string): string {
  return label({
    ABSENT: '从未声明',
    PRESENT: '已确认（摘要匹配）',
    INVALID: '曾声明但无效',
    NOT_RECORDED: '没有确认记录',
  }, state);
}

/* -- Generic state wording ------------------------------------------------------------------------ */

/** Shared wording for the lifecycle states the scheduling panels print. Unknown keeps its name. */
export function runtimeStateLabel(state: string): string {
  return label({
    DRAFT: '草稿', READY: '就绪', RUNNING: '运行中', WAITING_FOR_USER: '等待用户',
    BLOCKED: '已阻塞', COMPLETED: '已完成', EXECUTED: '已执行', FAILED: '失败',
    CANCELLED: '已终止', RECOVERY_REQUIRED: '需要恢复', PAUSING: '正在暂停', PAUSED: '已暂停',
    CANCELLING: '正在终止', SUCCEEDED: '已成功', PREPARED: '已准备', SUPERSEDED: '已取代',
    QUEUED: '排队中', PASSED: '已通过', ERROR: '错误', STALE: '已过期', ACTIVE: '有效',
    CONSUMED: '已使用', INVALIDATED: '已失效', RELEASED: '已释放', RESERVED: '已预留',
    REVOKED: '已撤回', EXITED: '已退出', STARTING: '正在启动', PREPARING: '准备中',
  }, state);
}

/* -- Durations ------------------------------------------------------------------------------------ */

/** A waiting duration from a recorded `since` timestamp. Never an estimate of the future. */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/** `null` means the Runtime has no recorded start for this wait, which is reported as unknown. */
export function formatSince(since: number | null, now: number): string {
  if (since === null) return '无起始记录';
  if (since <= 0) return '未记录开始时间';
  return formatDuration(now - since);
}

/* -- Completion notes (FOUNDATION-056) ------------------------------------------------------------ */

/**
 * The heading a completion note must carry. The note describes the *shape of the ending*; it is
 * not "the Agent is waiting for your answer" and it is not a failure. The wording is fixed here so
 * no component can upgrade it into an intent claim.
 */
export const completionNoteHeading =
  '结束形态的注记（PROSE_QUESTION_NO_TOOL_USE）——不是「Agent 在等你回答」，也不是失败';

/** One sentence a reader can check against the recorded facts, without claiming intent. */
export function completionNoteSummary(note: AgentCompletionNoteView): string {
  const facts = note.facts;
  const toolText = `整次运行报告的工具调用数：${facts.toolCallCount}`;
  const stop = facts.finalAssistantStopReason === null
    ? 'provider 未报告停止原因'
    : `provider 报告的停止原因：${facts.finalAssistantStopReason}`;
  return `${note.code} · ${toolText} · ${stop}；最后一段助手文本以问号结尾`
    + `${facts.finalAssistantTextTruncated ? '（只显示了尾部）' : ''}。`
    + '这是对结束形态的启发式观察，不改变任何任务或执行状态。';
}

/* -- Event summaries ------------------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function shortId(value: unknown): string {
  const id = stringOf(value);
  return id === null ? '—' : id.slice(0, 8);
}

function codesOf(value: unknown): string {
  if (!Array.isArray(value)) return '—';
  const codes = value.filter((entry): entry is string => typeof entry === 'string');
  return codes.length === 0 ? '—' : codes.join('、');
}

function blockingOf(value: unknown): string {
  if (!Array.isArray(value)) return '—';
  const ids = value.filter((entry): entry is string => typeof entry === 'string');
  return ids.length === 0 ? '—' : ids.map((id) => id.slice(0, 8)).join('、');
}

function capacityFactsOf(value: unknown): string {
  if (!isRecord(value)) return '';
  const globalLimit = value['globalLimit'];
  const globalUsed = value['globalUsed'];
  const adapterId = stringOf(value['adapterId']);
  const adapterLimit = value['adapterLimit'];
  const adapterUsed = value['adapterUsed'];
  const parts: string[] = [];
  if (typeof globalLimit === 'number') parts.push(`全局 ${String(globalUsed ?? '?')}/${globalLimit}`);
  if (adapterId !== null && typeof adapterLimit === 'number') {
    parts.push(`${adapterId} ${String(adapterUsed ?? '?')}/${adapterLimit}`);
  }
  return parts.length === 0 ? '' : `（${parts.join('，')}）`;
}

/**
 * A human sentence for the scheduling events, or `null` for any other event type or a payload this
 * client cannot read. The caller keeps the raw payload visible next to it, so a summary is never a
 * replacement for the recorded fact.
 */
export function schedulingEventSummary(eventType: string, payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  switch (eventType) {
    case 'TaskScheduleDecided':
      return `调度决定：任务 ${shortId(payload['taskId'])} 以 ${verdictLabel(
        stringOf(payload['verdict']) ?? 'UNKNOWN')} 启动（执行 ${shortId(payload['executionId'])}，`
        + `预留 ${shortId(payload['reservationId'])}）；reason ${codesOf(payload['reasonCodes'])}`
        + `${payload['clearedUnknownBy'] == null ? ''
          : `；由单次放行 ${shortId(payload['clearedUnknownBy'])} 允许`}`;
    case 'TaskWaitingForConflict':
      return `冲突等待：任务 ${shortId(payload['taskId'])} 等待，code ${
        stringOf(payload['code']) ?? '—'}（${waitReasonLabel(stringOf(payload['code']) ?? '')}）；`
        + `reason ${codesOf(payload['reasonCodes'])}；占用方 ${blockingOf(payload['blocking'])}`;
    case 'TaskWaitingForCapacity':
      return `容量等待：任务 ${shortId(payload['taskId'])} 等待，code ${
        stringOf(payload['code']) ?? '—'}（${waitReasonLabel(stringOf(payload['code']) ?? '')}）；`
        + `占用方 ${blockingOf(payload['blocking'])}`;
    case 'TaskUnknownCleared':
      return `单次放行：任务 ${shortId(payload['taskId'])} revision ${shortId(payload['revisionId'])}`
        + ` 被显式放行（${stringOf(payload['scope']) ?? 'SINGLE_START'}），判定仍是 `
        + `${verdictLabel(stringOf(payload['verdict']) ?? 'UNKNOWN')}；绑定 analyzer`
        + ` ${stringOf(payload['analyzerVersion']) ?? '—'} / policy ${
          stringOf(payload['policyVersion']) ?? '—'}；放行人 ${stringOf(payload['releasedBy']) ?? '—'}`;
    case 'ExecutionSlotReserved':
      return `预留槽位：任务 ${shortId(payload['taskId'])} revision ${shortId(payload['revisionId'])}`
        + ` adapter ${stringOf(payload['adapterId']) ?? '—'} 预留 ${shortId(payload['reservationId'])}`
        + capacityFactsOf(payload['capacity']);
    case 'ExecutionSlotWorkspaceBound':
      return `绑定工作区：任务 ${shortId(payload['taskId'])} 的预留 ${
        shortId(payload['reservationId'])} 绑定工作区 ${shortId(payload['workspaceId'])}`;
    case 'ExecutionSlotReleased':
      return `释放槽位：任务 ${shortId(payload['taskId'])} 预留 ${shortId(payload['reservationId'])}`
        + ` ${reservationReleaseKindLabel(stringOf(payload['releaseKind']) ?? '')}`
        + `（${holderObservationLabel(stringOf(payload['observation']) ?? '')}）`
        + `${stringOf(payload['reason']) === null ? '' : `；原因：${String(payload['reason'])}`}`;
    case 'SchedulerCapacityChanged': {
      const scope = stringOf(payload['scope']) === 'ADAPTER'
        ? `adapter ${stringOf(payload['adapterId']) ?? '—'}` : '全局';
      return `容量变更：${scope} 上限 ${String(payload['from'] ?? '—')} → ${String(payload['to'] ?? '—')}`
        + `（操作者 ${stringOf(payload['actor']) ?? '—'}）`;
    }
    default:
      return null;
  }
}

/** The event types `schedulingEventSummary` understands, so a caller can check cheaply. */
export const schedulingEventTypes: readonly string[] = Object.freeze([
  'TaskScheduleDecided',
  'TaskWaitingForConflict',
  'TaskWaitingForCapacity',
  'TaskUnknownCleared',
  'ExecutionSlotReserved',
  'ExecutionSlotWorkspaceBound',
  'ExecutionSlotReleased',
  'SchedulerCapacityChanged',
]);

export function isSchedulingEventType(eventType: string): boolean {
  return schedulingEventTypes.includes(eventType);
}
