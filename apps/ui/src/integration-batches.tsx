import { useCallback, useEffect, useState } from 'react';
import { describeError, RuntimeClient } from './api.js';
import type {
  IntegrationBatchItemView,
  IntegrationBatchMemberView,
  IntegrationBatchRecordView,
  IntegrationBatchView,
  IntegrationReportView,
  TaskView,
} from './types.js';

/**
 * The IntegrationBatch projection (`task integration list|create|integrate|cancel`, ADR-0018 /
 * ADR-0053, FOUNDATION-089).
 *
 * Scope of this module — what it is and is not:
 * - It renders the Runtime's own record, field by field, for batches of **one or more** members. A
 *   batch is composed (`create`, which writes no Git) and then integrated (`integrate`, which merges
 *   every member in `task_id` order, runs **one** independent integration verification over the
 *   whole result and only advances `dev` by compare-and-swap after it PASSes).
 * - It **does not decide eligibility**. The write controls are never hidden or disabled by a local
 *   state allow-list (the `task-retry.tsx` precedent): a refusal is displayed with the stable code
 *   the Runtime actually returned, plus a local glossary sentence that never replaces the code.
 * - It never reads a batch-level terminal verdict as success: only `INTEGRATED` (the ref moved) is
 *   green; `STALE`, `CANCELLED` and `RECOVERY_REQUIRED` are terminal-but-not-integrated and are
 *   rendered as such. `RECOVERY_REQUIRED` is the CLI's exit code 3 — it needs a human and the batch
 *   keeps occupying its members.
 * - It keeps 「已合入 dev」 and 「已进 main」 apart: `INTEGRATED` is a statement about `dev` only.
 *   Stable promotion is another flow (see `promotion.tsx`), and nothing here may read as one.
 * - It **invents no field and no business rule**. Where a projection would need a fact the command
 *   face does not carry (a batch-level progress percentage, a per-member start time), the UI says
 *   so instead of computing a lookalike value; see the notes on the panel.
 */

/**
 * The batch states the Runtime can record (`IntegrationBatchState` in the storage source, schema
 * v30). Every name here is a value that source literally contains; the test reads that union so this
 * projection cannot drift from it. Two names are reused from the Execution vocabulary with a
 * different meaning: a batch's `PREPARING` is the member merges (not a process start) and
 * `VERIFYING` is the one integration verification over the whole batch.
 */
const integrationBatchStateLabels: Record<string, string> = {
  CREATED: '已组成 · 未合并',
  PREPARING: '正在合并成员',
  VERIFYING: '正在跑整批的集成验证',
  INTEGRATING_DEV: '正在推进 dev 引用（ref 写入已开始记录）',
  INTEGRATED: '已合入 dev',
  CONFLICTED: '合并冲突 · 未合入',
  FAILED: '失败 · 未合入',
  RECOVERY_REQUIRED: '需要人工对账 · 未收口（成员仍被占用）',
  STALE: '已失效 · 未合并、dev 未动',
  CANCELLED: '已取消 · 未合入',
};

/** One batch state in words; an unknown value is shown verbatim rather than guessed at. */
export function integrationBatchStateLabel(state: string): string {
  return integrationBatchStateLabels[state] ?? state;
}

/**
 * The ONLY state whose ref move happened is `INTEGRATED`; it is the only one allowed the success
 * colour. `STALE` / `CANCELLED` are terminal without integrating (attention tone, never success),
 * `RECOVERY_REQUIRED` / `FAILED` / `CONFLICTED` are the failure tone, and the in-flight states are
 * "work recorded, nothing advanced yet".
 */
export function integrationBatchStateClass(state: string): string {
  if (state === 'INTEGRATED') return 'state state-ready';
  if (state === 'FAILED' || state === 'CONFLICTED' || state === 'RECOVERY_REQUIRED') {
    return 'state state-failed';
  }
  if (state === 'STALE' || state === 'CANCELLED') return 'state state-cancelled';
  if (state === 'PREPARING' || state === 'VERIFYING' || state === 'INTEGRATING_DEV') {
    return 'state state-running';
  }
  return 'state';
}

/** True for exactly the state in which `dev` was advanced by this batch. */
export function integrationBatchStateIntegrated(state: string): boolean {
  return state === 'INTEGRATED';
}

/**
 * The terminal verdicts: none of them starts new work. Read from the Runtime service's own
 * `isFinished` (`INTEGRATED`, `CONFLICTED`, `FAILED`, `RECOVERY_REQUIRED`, `STALE`, `CANCELLED`).
 */
export function integrationBatchStateFinished(state: string): boolean {
  return state === 'INTEGRATED' || state === 'CONFLICTED' || state === 'FAILED'
    || state === 'RECOVERY_REQUIRED' || state === 'STALE' || state === 'CANCELLED';
}

/**
 * The states a previous attempt can leave behind. They do not mean `dev` was not moved (a crash
 * after the ref write is resolved from the ref itself), so nothing here is called "in progress".
 */
export function integrationBatchStateInFlight(state: string): boolean {
  return state === 'CREATED' || state === 'PREPARING' || state === 'VERIFYING'
    || state === 'INTEGRATING_DEV';
}

/**
 * The CLI's exit code for an integrate verdict (ADR-0053): `0` only for `INTEGRATED` (the ref moved),
 * `3` for `RECOVERY_REQUIRED` (nothing else may proceed until a human resolves it), `1` for every
 * other recorded terminal verdict.
 */
export function integrationVerdictExitCode(state: string): number {
  if (state === 'INTEGRATED') return 0;
  if (state === 'RECOVERY_REQUIRED') return 3;
  return 1;
}

/** `task integration cancel`: `0` only for `CANCELLED`, `3` for `RECOVERY_REQUIRED`, else `1`. */
export function integrationCancelExitCode(state: string): number {
  if (state === 'CANCELLED') return 0;
  if (state === 'RECOVERY_REQUIRED') return 3;
  return 1;
}

/** Member item states (`IntegrationItemState`, schema v30), in the Runtime's own words. */
const integrationMemberStateLabels: Record<string, string> = {
  PREPARED: '证据已固定 · 未合并',
  MERGED: '已在批次内合并 · dev 未推进',
  INTEGRATED: '已随批次合入 dev',
  FAILED: '该成员导致批次失败',
  CONFLICTED: '该成员合并冲突',
};

/** One member state in words; an unknown value is shown verbatim. */
export function integrationMemberStateLabel(state: string): string {
  return integrationMemberStateLabels[state] ?? state;
}

/**
 * `PREPARED` is not "in progress": a batch that went `STALE`, was cancelled or failed before reaching
 * a member leaves that member exactly there (ADR-0053 D05), so the fact is spelled out next to it.
 */
export function integrationMemberStateClass(state: string): string {
  if (state === 'INTEGRATED') return 'state state-ready';
  if (state === 'FAILED' || state === 'CONFLICTED') return 'state state-failed';
  if (state === 'MERGED') return 'state state-running';
  return 'state';
}

/**
 * Members are presented in `task_id` order. That is not a display preference: ADR-0053 D02 fixes the
 * member order — the request's order is **not** part of a batch, and the Runtime stores, reads and
 * merges members in this order. Sorting here keeps the member table from contradicting the merge
 * order it describes; the test pins the storage query that the Runtime reads them with.
 */
export function integrationMembersInTaskOrder<T extends { readonly taskId: string }>(
  members: readonly T[],
): readonly T[] {
  return [...members].sort((left, right) =>
    left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0);
}

/** The member facts a table renders; both `items` and `members` projections satisfy it. */
export interface IntegrationMemberFacts {
  readonly taskId: string;
  readonly revisionId: string;
  readonly candidateCommit: string;
  readonly state: string;
  readonly integratedCommit: string | null;
  readonly detail: string | null;
}

/** One member as `items` (list/status) or `members` (get/create/cancel/integrate) report it. */
export type IntegrationMemberView = IntegrationBatchItemView | IntegrationBatchMemberView;

/**
 * The contract's own upper bound for one batch (ADR-0053, `maxIntegrationBatchMembers`). It is
 * displayed as a fact and **not** used as a gate: a request that names more members is refused by
 * the Runtime (`INVALID_REQUEST`), which is where the rule lives. The test asserts this number
 * against the contracts source so it cannot silently disagree with it.
 */
export const integrationBatchMemberLimit = 32;

/** What `task.integration.create` sends. Field names come from the contracts, not from here. */
export function integrationCreateCommand(input: {
  readonly projectId: string;
  readonly members: readonly { readonly taskId: string; readonly expectedVersion: number }[];
  readonly commandId: string;
}): Record<string, unknown> {
  return {
    command: 'task.integration.create',
    commandId: input.commandId,
    projectId: input.projectId,
    members: input.members.map((member) => ({
      taskId: member.taskId,
      expectedVersion: member.expectedVersion,
    })),
  };
}

/** What `task.integration.integrate` sends: the batch, never a member or a version. */
export function integrationIntegrateCommand(input: {
  readonly projectId: string;
  readonly batchId: string;
  readonly commandId: string;
}): Record<string, unknown> {
  return {
    command: 'task.integration.integrate',
    commandId: input.commandId,
    projectId: input.projectId,
    batchId: input.batchId,
  };
}

/**
 * What `task.integration.cancel` sends. `reason` is optional in the contract and is trimmed to
 * 1–1000 characters there, so a blank input **omits the field** instead of sending an empty string
 * (which the contract would reject).
 */
export function integrationCancelCommand(input: {
  readonly projectId: string;
  readonly batchId: string;
  readonly reason: string;
  readonly commandId: string;
}): Record<string, unknown> {
  const reason = input.reason.trim();
  return {
    command: 'task.integration.cancel',
    commandId: input.commandId,
    projectId: input.projectId,
    batchId: input.batchId,
    ...(reason.length === 0 ? {} : { reason }),
  };
}

/** Flattens a request into `key: value` lines so the exact request is visible before it is sent. */
export function integrationRequestLines(
  request: Readonly<Record<string, unknown>>,
): readonly string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(request)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      value.forEach((entry, index) => {
        for (const [innerKey, innerValue] of Object.entries(entry as Record<string, unknown>)) {
          lines.push(`${key}[${index}].${innerKey}: ${String(innerValue)}`);
        }
      });
      continue;
    }
    lines.push(`${key}: ${String(value)}`);
  }
  return lines;
}

/**
 * Plain-language notes for the stable codes this command face can answer with. This is a
 * **glossary**, not a gate: the code is always displayed next to the note, and a code without a note
 * is shown as the raw code rather than being mapped to something invented. Every key is a string the
 * Runtime/Storage sources literally contain (asserted by the test).
 */
const integrationCodeGlossary: Record<string, string> = {
  // `planMember` / `selectExecution` (apps/runtime/src/integration-service.ts).
  TASK_NOT_EXECUTED: '只有 EXECUTED 的任务能当成员（需要一次已提交的成果 commit）',
  NO_CAPTURED_RESULT: '该任务没有当前 revision 的成果 commit；先提交成果（task result capture）',
  STALE_REVISION: '指定的执行不属于当前 revision：集成只接受当前 revision 的成果',
  TASK_VERIFICATION_NOT_PASSED: '该 revision 与结果 commit 上没有 PASSED 的任务验证；先在固定 commit 上验证',
  EXECUTION_NOT_FOUND: '指定的执行不属于这个任务',
  INTEGRATION_BATCH_INVALID: '这条批次记录没有成员行（Runtime 记录损坏）',
  // Composition / integration refusals.
  CONCURRENT_MODIFICATION: '任务或批次版本已前进：界面显示的值过期了，请刷新后重试（界面把读到的版本原样作为 CAS 发出）',
  INTEGRATION_IN_PROGRESS: '已有未结算的批次占着这些成员（或该批次不是 CREATED）：先 integrate 或 cancel 那个批次',
  INVALID_REQUEST: '请求本身不合法（一个成员都没给，或同一个任务被写了两次）',
  // Baseline and repository refusals.
  DEV_REF_CHECKED_OUT: 'dev 正被某个工作树检出：先在那边切走，否则 ref 会移动而那个工作树还停在旧提交',
  // ADR-0056: the dev clone's own `dev` checkout is the single exception. Integration advances it
  // with Git's own fast-forward; when that fails (a concurrent edit, or a checkout that is no longer
  // on the recorded baseline), nothing was merged and `dev` did not move.
  DEV_CHECKOUT_FF_FAILED: 'dev clone 检出上的快进失败（并发改动，或检出已不在记录的基线上）：未合并、dev 未动',
  DEV_REF_MISSING: '项目基线 ref 不存在（例如重新 trust 时换了分支名）',
  REPOSITORY_CHANGED: '仓库身份变了（main ref 的可信记录不再成立）：需要重新 trust',
  VERIFICATION_POLICY_ABSENT: 'main ref 上没有验证策略：整批的集成验证没有命令可跑',
  VERIFICATION_POLICY_NOT_CONFIRMED: 'STRICT 下需要已确认且 digest 未变的验证策略：先 project trust 确认',
  // Storage-level refusals reachable from this command face.
  NOT_FOUND: '找不到这个项目或批次（id 不对，或项目未信任）',
  INVALID_STATE: '按记录的状态不允许这一步（Runtime 需要人工对账）',
  COMMAND_CONFLICT: '同一个 commandId 已经用过但请求内容不同（界面每次点击都会生成新的 commandId）',
  // Recorded batch outcome codes (`integration_batches.outcome_code`).
  MEMBER_EVIDENCE_MOVED: '成员证据已移动（revision / 结果提交 / 验证不再与批次固定的一致）：未合并、dev 未动，需按当前事实重新组批',
  DEV_REF_MOVED: 'dev 基线已移动，CAS 未成立：未合并、dev 未动，需重新组批',
  DEV_REF_CHANGED: '集成分支名已变（项目被重新 trust）：未合并、dev 未动',
  WORKTREE_FAILED: '集成工作树无法创建：未合并、dev 未动',
  MERGE_FAILED: 'Git 合并没有成功（不是内容冲突）：未合并、dev 未动',
  MERGE_CONFLICT: '成员合并冲突：未合并、dev 未动，现场保留',
  INTEGRATION_VERIFICATION_FAILED: '整批的独立集成验证未通过：dev 未动',
  INSPECTION_FAILED: '读取合并结果的树失败：dev 未动',
  RECONCILE_REQUIRED: '记录里已有 worktree/merge/verification，无法证明无副作用：没有取消、成员仍被占用，需要人工对账',
  CANCELLED_BY_USER: '用户取消；当时记录能证明没有副作用，dev 未被触碰',
};

/** The glossary note for one code, or null when this code has no documented note. */
export function integrationCodeNote(code: string): string | null {
  return integrationCodeGlossary[code] ?? null;
}

/** Every code the glossary documents; the tests use it to catch drift against the sources. */
export function integrationDocumentedCodes(): readonly string[] {
  return Object.keys(integrationCodeGlossary);
}

/** A refusal surfaced as `CODE: message`, with the glossary note when there is one. */
export function integrationRejectionNotice(code: string, message: string): string {
  const note = integrationCodeNote(code);
  return note === null ? `${code}: ${message}` : `${code}: ${message}（${note}）`;
}

/** What one integrate call means; only the first two say the ref really moved. */
export type IntegrationVerdictKind =
  | 'INTEGRATED'
  | 'ALREADY_INTEGRATED'
  | 'NOT_INTEGRATED'
  | 'NEEDS_RECONCILIATION';

/**
 * The verdict of one `task.integration.integrate` call. `alreadyCompleted` means the recorded
 * verdict of a finished batch was returned instead of a second merge/verification: it reports a ref
 * move that happened **earlier**, so it is never presented as work this call did.
 */
export function integrationIntegrateVerdict(report: IntegrationReportView): IntegrationVerdictKind {
  if (report.state === 'INTEGRATED') {
    return report.alreadyCompleted ? 'ALREADY_INTEGRATED' : 'INTEGRATED';
  }
  if (report.state === 'RECOVERY_REQUIRED') return 'NEEDS_RECONCILIATION';
  return 'NOT_INTEGRATED';
}

/** One sentence for the integrate verdict, always with the CLI exit code and what `dev` did. */
export function integrationIntegrateNotice(report: IntegrationReportView): string {
  const kind = integrationIntegrateVerdict(report);
  if (kind === 'INTEGRATED') {
    return `已合入 dev（命令面退出码 0）：合并提交 ${short(report.mergedCommit)}，dev 推进到`
      + ` ${short(report.integratedCommit)}；整批的独立集成验证是`
      + ` ${report.verificationState ?? '（未记录）'}。这不等于已进 main。`;
  }
  if (kind === 'ALREADY_INTEGRATED') {
    return `这次没有合并也没有再验证：批次此前已合入 dev，返回既有记录（命令面退出码 0，`
      + `alreadyCompleted: true）。dev 的推进发生在更早那次调用。`;
  }
  if (kind === 'NEEDS_RECONCILIATION') {
    return '未收口（命令面退出码 3）：批次是 RECOVERY_REQUIRED，需要人工按记录处理，'
      + '成员仍被占用；dev 未移动。';
  }
  return `未合入（命令面退出码 1）：批次终态 ${integrationBatchStateLabel(report.state)}`
    + `${report.outcomeCode === null ? '' : ` · 结果码 ${report.outcomeCode}`}，dev 未推进`
    + '（integratedCommit 仍为 null）。';
}

/** What one cancel call means. Only `CANCELLED` is a cancellation; exit 3 is not one. */
export function integrationCancelNotice(view: IntegrationBatchRecordView): string {
  if (view.state === 'CANCELLED') {
    return '已取消（命令面退出码 0）：记录当时能证明批次没有 worktree、没有合并、没有验证，'
      + 'dev 未被触碰，成员释放。';
  }
  if (view.state === 'RECOVERY_REQUIRED') {
    return '没有被取消（命令面退出码 3）：记录证明不了成员尚无副作用，批次改为'
      + ' RECOVERY_REQUIRED / RECONCILE_REQUIRED 并继续占用成员，需要人工按记录处理。';
  }
  return `批次已是终态（${integrationBatchStateLabel(view.state)}）：取消是幂等的，返回既有记录`
    + `（命令面退出码 ${integrationCancelExitCode(view.state)}），没有移动任何 ref。`;
}

/** What one create call means: `created: false` is the idempotent replay of an earlier request. */
export function integrationCreateNotice(view: IntegrationBatchRecordView): string {
  return view.created
    ? `批次已组成：${view.members.length} 个成员，dev 基线 ${short(view.devCommit)}。`
      + '它只写记录、没有碰 Git；用「集成」才会合并与验证。'
    : `这条命令此前已经执行过：返回已存在的批次 ${short(view.batchId)}`
      + `（created: false，state ${view.state}），没有组成第二个批次。`;
}

/**
 * What `INTEGRATED` does and does not mean. Kept in one exported constant so the wording is the same
 * everywhere this panel says it, and so the test can pin it.
 */
export const integrationNotPromotionNotice =
  '批级 INTEGRATED 只说明这批成员的成果已合入 dev，且 dev ref 已被 CAS 推进。'
  + '它不等于「已进 main」：稳定提升是另一条流程，需要在 main 检出里拉取并重启稳定 Runtime'
  + '（见下方「稳定提升记录 · dev → main」）。合入 dev ≠ 已发布。';

/**
 * The facts this command face does **not** carry, stated instead of computed. A batch reports its
 * state, not a percentage; and a member records the batch's composition time, not its own start.
 */
export const integrationMissingFactsNotes: readonly string[] = [
  '批级没有「进度百分比 / 剩余时间」这类字段：状态就是记录里唯一的进度事实'
  + '（CREATED → PREPARING → VERIFYING → INTEGRATING_DEV → 终态）。',
  '成员行只记录批次组成的时间，不记录该成员自己的开始时间，因此界面不显示「成员耗时」——'
  + '那会是界面自己算出来的值。成员的 completedAt 在成员落定（合入或成为失败成员）时才有值。',
];

/** A short id for display; the full value stays available in the detail tables. */
function short(value: string | null): string {
  return value === null ? '—' : value.slice(0, 10);
}

function timeLabel(at: number | null): string {
  return at === null ? '—' : new Date(at).toLocaleString('zh-CN');
}

/** The member list of one batch, always in `task_id` order, always read-only. */
export function IntegrationMemberTable({ members }: {
  readonly members: readonly IntegrationMemberView[];
}) {
  const ordered = integrationMembersInTaskOrder(members);
  return (
    <div className="table-scroll"><table className="integration-members">
      <thead>
        <tr><th>成员任务</th><th>revision</th><th>结果提交</th><th>成员状态</th>
          <th>合入其中的 commit</th><th>说明</th></tr>
      </thead>
      <tbody>
        {ordered.map((member) => (
          <tr key={member.taskId}>
            <td className="mono">{short(member.taskId)}</td>
            <td className="mono">{short(member.revisionId)}</td>
            <td className="mono">{short(member.candidateCommit)}</td>
            <td><span className={integrationMemberStateClass(member.state)}>
              {integrationMemberStateLabel(member.state)}</span></td>
            <td className="mono">{member.integratedCommit === null ? '—'
              : short(member.integratedCommit)}</td>
            <td className="muted">{member.detail ?? '—'}</td>
          </tr>
        ))}
        {ordered.length === 0 ? (
          <tr><td colSpan={6} className="muted">这条批次记录里没有成员。</td></tr>
        ) : null}
      </tbody>
    </table></div>
  );
}

/**
 * Every batch of the project, read-only: the batch's own verdict, its `dev` baseline and the commit
 * `dev` was advanced to, the merge it produced, the one verification that covered it, and every
 * member. No control lives in this table; the write controls are a separate section.
 */
export function IntegrationBatchTable({ batches, emptyNote }: {
  readonly batches: readonly IntegrationBatchView[];
  /** What an empty list means **here**: the project's list and one Task's list differ. */
  readonly emptyNote?: string;
}) {
  return (
    <div className="table-scroll"><table className="integration-batches">
      <thead>
        <tr><th>批次</th><th>状态</th><th>dev 基线</th><th>合入后 dev</th><th>合并</th>
          <th>集成验证</th><th>结果码</th><th>时间</th></tr>
      </thead>
      <tbody>
        {batches.map((batch) => (
          <BatchRows key={batch.batchId} batch={batch} />
        ))}
        {batches.length === 0 ? (
          <tr><td colSpan={8} className="muted">
            {emptyNote ?? '这个项目还没有集成批次；成果不会自动进入 dev。'}
          </td></tr>
        ) : null}
      </tbody>
    </table></div>
  );
}

/** One batch row plus its member table, so a multi-member batch never shows only its first member. */
function BatchRows({ batch }: { readonly batch: IntegrationBatchView }) {
  return (
    <>
      <tr data-batch-state={batch.state}>
        <td className="mono">{short(batch.batchId)}
          <div className="muted">{[...batch.items].length} 个成员 · {batch.devRef}</div></td>
        <td><span className={integrationBatchStateClass(batch.state)}>
          {integrationBatchStateLabel(batch.state)}</span></td>
        <td className="mono">{short(batch.devCommit)}</td>
        <td className="mono">{batch.integratedCommit === null
          ? <span className="muted">未改动</span> : short(batch.integratedCommit)}</td>
        <td>{batch.mergeStrategy === null ? '—' : (batch.mergeStrategy === 'FAST_FORWARD'
          ? 'fast-forward' : 'merge commit')}
          {batch.mergedCommit === null ? null
            : <div className="muted mono">{short(batch.mergedCommit)}</div>}</td>
        <td className="mono">{batch.verificationId === null ? '—' : short(batch.verificationId)}</td>
        <td>{batch.outcomeCode ?? '—'}
          {batch.detail === null ? null : <div className="muted">{batch.detail}</div>}</td>
        <td>{timeLabel(batch.createdAt)} → {timeLabel(batch.completedAt)}</td>
      </tr>
      <tr className="integration-members-row">
        <td colSpan={8}>
          <IntegrationMemberTable members={batch.items} />
        </td>
      </tr>
    </>
  );
}

/** The label of one selectable member Task: the facts the request will fix, not a filter. */
export function integrationTaskOptionLabel(task: TaskView): string {
  const specification = task.currentRevision.specification.replace(/\s+/g, ' ').trim();
  const body = specification.length > 60 ? `${specification.slice(0, 60)}…` : specification;
  return `#${task.displayNumber} · ${task.state} · v${task.version} · ${body}`;
}

/**
 * One written outcome of this panel. `REFUSED` keeps the Runtime's stable code; the two verdicts
 * keep the batch's own state so nothing can be read as success by accident.
 */
export type IntegrationOutcome =
  | { readonly kind: 'CREATED'; readonly view: IntegrationBatchRecordView }
  | { readonly kind: 'INTEGRATED'; readonly report: IntegrationReportView }
  | { readonly kind: 'CANCELLED'; readonly view: IntegrationBatchRecordView }
  | { readonly kind: 'REFUSED'; readonly what: string; readonly notice: string };

/** The distinct notice texts of the create form, above its button. */
export const integrationCreateExplainer =
  '组成一个批次（task integration create）：把每个成员当前的 revision、成果 commit 与整批的 '
  + 'dev 基线一起固定下来。它不碰 Git——没有合并、没有验证、dev 不动；成员按 task_id 排序存储与合并，'
  + `所以请求里成员的先后不是批次的一部分。契约上限是 ${integrationBatchMemberLimit} 个成员；`
  + '把同一个任务写两次、或一个成员都不给，会被 Runtime 拒绝为 INVALID_REQUEST。';

/** What the integrate button does, printed directly above it. */
export const integrationIntegrateActionNote =
  '这个按钮会做（task integration integrate）：按 task_id 顺序合并全部成员，'
  + '然后对最终提交跑一次覆盖整批的独立集成验证，只有 PASSED 才用 CAS 把 dev 从记录里的基线推进到合并提交。'
  + '失败、冲突、成员证据移动或 dev 基线移动都不会推进 dev；已经是终态的批次不会重跑，只返回既有记录。';

/**
 * What the cancel button does, printed directly above it — including the case in which cancelling
 * **does not succeed**. A user must not believe that cancel always works.
 */
export const integrationCancelActionNote =
  '这个按钮会做（task integration cancel）：尝试结束这个批次。只有在记录能证明它还没有任何副作用'
  + '（仍是 CREATED，且没有 worktree、没有合并、没有验证）时才会真的变成 CANCELLED；'
  + '否则命令面把它改为 RECOVERY_REQUIRED / RECONCILE_REQUIRED（退出码 3）——没有被取消、'
  + '成员继续被占用，需要人工按记录处理。所以取消不保证成功，也从来不会推进 dev。'
  + 'FULL 与 STRICT 下都是零确认。';

/** A per-state note about what the two buttons will meet, always read off the displayed state. */
export function integrationActionsStateNote(state: string): string {
  if (state === 'CREATED') {
    return '按记录里这条批次的状态（CREATED）：integrate 会真的合并并验证；cancel 现在能真正取消。';
  }
  if (integrationBatchStateInFlight(state)) {
    return `按记录里这条批次的状态（${state}）：这是更早一次尝试留下的进行中记录，integrate 不会重跑，`
      + 'cancel 此时很可能只得到 RECOVERY_REQUIRED。dev 是否已移动以 ref 与记录为准，不由这里判断。';
  }
  if (state === 'INTEGRATED') {
    return '按记录里这条批次的状态（INTEGRATED）：两个按钮都不会再做任何合并或验证，'
      + 'integrate 返回既有记录，cancel 幂等返回；要再集成请按当前事实重新组批。';
  }
  return `按记录里这条批次的状态（${integrationBatchStateLabel(state)}）：这是终态，`
    + '两个按钮都只返回既有记录，不会重新合并或推进 dev；要再集成请按当前事实重新组批。';
}

/** The result card of one written command. Nothing here claims a ref moved unless it did. */
export function IntegrationOutcomeCard({ outcome }: { readonly outcome: IntegrationOutcome }) {
  if (outcome.kind === 'REFUSED') {
    return (
      <p className="error" role="alert" data-integration-verdict="REFUSED">
        {outcome.what}被拒绝：{outcome.notice}
      </p>
    );
  }
  if (outcome.kind === 'CREATED') {
    return (
      <div className="card nested integration-outcome" role="status"
        data-integration-verdict={outcome.view.created ? 'CREATED' : 'CREATED_REPLAY'}>
        <div className="section-heading">
          <h5>{outcome.view.created ? '批次已组成（未碰 Git）' : '返回既有批次（created: false）'}</h5>
          <span className="state">{integrationBatchStateLabel(outcome.view.state)}</span>
        </div>
        <p className="muted">{integrationCreateNotice(outcome.view)}</p>
        <dl className="kv">
          <dt>批次</dt><dd className="mono">{outcome.view.batchId}</dd>
          <dt>dev 基线（记录里固定的）</dt>
          <dd className="mono">{outcome.view.devRef} {short(outcome.view.devCommit)}</dd>
        </dl>
        <IntegrationMemberTable members={outcome.view.members} />
      </div>
    );
  }
  if (outcome.kind === 'CANCELLED') {
    const verdict = outcome.view.state === 'CANCELLED' ? 'CANCELLED'
      : outcome.view.state === 'RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED' : 'ALREADY_TERMINAL';
    return (
      <div className="card nested integration-outcome" role="status"
        data-integration-verdict={verdict}>
        <div className="section-heading">
          <h5>{verdict === 'CANCELLED' ? '已取消'
            : verdict === 'RECOVERY_REQUIRED' ? '未被取消 · 需要人工对账'
              : '批次已是终态'}</h5>
          <span className={integrationBatchStateClass(outcome.view.state)}>
            {integrationBatchStateLabel(outcome.view.state)}</span>
        </div>
        <p className="muted">{integrationCancelNotice(outcome.view)}</p>
        <p className="muted mono">dev {outcome.view.devRef} {short(outcome.view.devCommit)}
          {' → '}{outcome.view.integratedCommit === null ? '未改动'
            : short(outcome.view.integratedCommit)}</p>
      </div>
    );
  }
  const report = outcome.report;
  const kind = integrationIntegrateVerdict(report);
  return (
    <div className="card nested integration-outcome" role="status"
      data-integration-verdict={kind}>
      <div className="section-heading">
        <h5>{kind === 'INTEGRATED' ? '已合入 dev'
          : kind === 'ALREADY_INTEGRATED' ? '此前已合入（本次未重跑）'
            : kind === 'NEEDS_RECONCILIATION' ? '未收口 · 需要人工对账' : '未合入'}</h5>
        <span className={integrationBatchStateClass(report.state)}>
          {integrationBatchStateLabel(report.state)}</span>
      </div>
      <p className="muted">{integrationIntegrateNotice(report)}</p>
      <dl className="kv">
        <dt>dev 基线</dt>
        <dd className="mono">{report.devRef} {short(report.devCommit)}</dd>
        <dt>合并提交</dt>
        <dd className="mono">{short(report.mergedCommit)}
          <div className="muted">{report.mergeStrategy === null ? '未记录合并方式'
            : report.mergeStrategy === 'FAST_FORWARD' ? 'fast-forward' : 'merge commit'}</div></dd>
        <dt>合入后 dev</dt>
        <dd className="mono">{report.integratedCommit === null ? '未改动'
          : short(report.integratedCommit)}</dd>
        <dt>整批的集成验证</dt>
        <dd className="mono">{short(report.verificationId)} · {report.verificationState ?? '（未记录）'}
          <div className="muted">这是一次覆盖整批的独立验证；任务验证 ≠ 集成验证。</div></dd>
        <dt>工作树</dt>
        <dd className="mono">{report.worktreePath ?? '—'}
          <div className="muted">{report.worktreeDetail ?? '—'}</div></dd>
        <dt>结果</dt>
        <dd>{report.outcomeCode ?? '—'}
          {report.detail === null ? null : <div className="muted">{report.detail}</div>}</dd>
      </dl>
      <IntegrationMemberTable members={report.members} />
      {report.commands.length === 0 ? (
        <p className="muted">这次调用没有返回验证命令的结果（重放既有记录时不重跑命令）。</p>
      ) : (
        <div className="table-scroll"><table>
          <thead><tr><th>验证命令</th><th>退出码</th><th>耗时</th><th>输出</th></tr></thead>
          <tbody>
            {report.commands.map((command) => (
              <tr key={command.id}>
                <td className="mono">{command.argv.join(' ')}<div className="muted">{command.cwd}</div></td>
                <td>{command.exitCode === null ? '—' : command.exitCode}
                  {command.timedOut ? <div className="muted">超时</div> : null}</td>
                <td>{(command.durationMs / 1000).toFixed(1)}s</td>
                <td className="mono">out {command.stdoutBytes} B · err {command.stderrBytes} B
                  {command.failureDetail === undefined ? null
                    : <div className="muted">{command.failureDetail}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {report.tree === null ? null : (
        <p className="muted mono">验证树 {short(report.tree.headCommit)}
          {' · '}{report.tree.clean ? '干净' : '有未提交改动'}
          {' · '}已跟踪改动 {report.tree.trackedModifications.length} · 未跟踪文件
          {' '}{report.tree.untrackedFiles.length}</p>
      )}
      <p className="muted hint">{integrationNotPromotionNotice}</p>
    </div>
  );
}

/**
 * The write controls of every batch, one card per batch. Presentational: it holds no state and sends
 * nothing itself, so a test can render it without a Runtime. Neither button is hidden or disabled by
 * a local state allow-list — only the one in-flight request disables them.
 */
export function IntegrationBatchOperations({
  batches, reasons, outcomes, pending, onReason, onIntegrate, onCancel,
}: {
  readonly batches: readonly IntegrationBatchView[];
  readonly reasons: Readonly<Record<string, string>>;
  readonly outcomes: Readonly<Record<string, IntegrationOutcome>>;
  /** The batch id (or `create`) of the one request in flight, or null. */
  readonly pending: string | null;
  readonly onReason: (batchId: string, value: string) => void;
  readonly onIntegrate: (batchId: string) => void;
  readonly onCancel: (batchId: string) => void;
}) {
  if (batches.length === 0) {
    return <p className="muted">还没有批次可操作；先用上面的「组批」组成一个。</p>;
  }
  return (
    <ul className="list integration-operations">
      {batches.map((batch) => {
        const outcome = outcomes[batch.batchId];
        return (
          <li key={batch.batchId} className="integration-operation">
            <div className="integration-operation-head">
              <span className="mono">{short(batch.batchId)}</span>
              <span className={integrationBatchStateClass(batch.state)}>
                {integrationBatchStateLabel(batch.state)}</span>
              <span className="muted">{[...batch.items].length} 个成员：</span>
              <span className="mono muted">
                {integrationMembersInTaskOrder(batch.items)
                  .map((member) => short(member.taskId)).join(', ')}
              </span>
            </div>
            <p className="muted hint">{integrationActionsStateNote(batch.state)}</p>
            <p className="muted integration-action-note">{integrationIntegrateActionNote}</p>
            <div className="actions">
              <button type="button" disabled={pending !== null}
                title="按记录合并全部成员 → 跑一次覆盖整批的独立集成验证 → 只有 PASSED 才 CAS 推进 dev"
                onClick={() => { onIntegrate(batch.batchId); }}>
                集成（task integration integrate）
              </button>
            </div>
            <p className="muted integration-action-note">{integrationCancelActionNote}</p>
            <label className="integration-cancel-reason">
              取消原因（可选，1–1000 字符；留空则不发送 <span className="mono">reason</span>）
              <input value={reasons[batch.batchId] ?? ''}
                aria-label={`批次 ${short(batch.batchId)} 的取消原因`}
                onChange={(event) => { onReason(batch.batchId, event.target.value); }} />
            </label>
            <div className="actions">
              <button type="button" className="danger" disabled={pending !== null}
                title="只有记录证明无副作用时才真正取消；否则改为 RECOVERY_REQUIRED（退出码 3）并保留成员"
                onClick={() => { onCancel(batch.batchId); }}>
                取消（task integration cancel）
              </button>
            </div>
            {outcome === undefined ? null : <IntegrationOutcomeCard outcome={outcome} />}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The project's batches: the read-only table first, then the write controls in their own section,
 * so a read-only projection is never mistaken for a control (and the reverse).
 */
export function IntegrationBatchPanel({ client, projectId, tasks, refreshToken, run }: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  /** The project's Tasks, for the member picker. Every state is listed; the Runtime is the judge. */
  readonly tasks: readonly TaskView[];
  /** Bumped by stream events (`Integration*`), so a batch change appears without a manual reload. */
  readonly refreshToken: number;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [batches, setBatches] = useState<readonly IntegrationBatchView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Member rows of the create form; an empty string is a row the user has not chosen a Task for. */
  const [memberRows, setMemberRows] = useState<readonly string[]>(['']);
  const [reasons, setReasons] = useState<Readonly<Record<string, string>>>({});
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, IntegrationOutcome>>>({});
  /** The one request in flight, so a double click cannot send a command twice. */
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setBatches(await client.command<readonly IntegrationBatchView[]>({
        command: 'task.integration.list', projectId,
      }));
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [client, projectId]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const byTaskId = new Map(tasks.map((task) => [task.id, task]));
  // Only rows the loaded Task list can still resolve become members: a Task that vanished from the
  // list has no version this client may claim, and inventing one would be a fabricated CAS value.
  const members = memberRows
    .filter((taskId) => taskId.length > 0)
    .map((taskId) => ({ taskId, expectedVersion: byTaskId.get(taskId)?.version ?? -1 }))
    .filter((member) => member.expectedVersion >= 0);
  // The preview states the fields of the request; the real commandId is generated per click, so the
  // preview names that fact instead of printing a value that was never sent.
  const previewLines = integrationRequestLines(integrationCreateCommand({
    projectId, members, commandId: '（点击时新生成）',
  }));

  const write = (
    key: string,
    busyLabel: string,
    what: string,
    send: () => Promise<IntegrationOutcome>,
  ): void => {
    if (pending !== null) return;
    setPending(key);
    void run(busyLabel, async () => {
      setOutcomes((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
      try {
        const outcome = await send();
        setOutcomes((previous) => ({ ...previous, [key]: outcome }));
      } catch (caught) {
        // A refusal writes nothing and is not an exception to hide: the stable code is the answer.
        const code = caught instanceof Error && 'code' in caught ? String(caught.code) : 'UNKNOWN';
        const message = caught instanceof Error ? caught.message : String(caught);
        setOutcomes((previous) => ({ ...previous,
          [key]: { kind: 'REFUSED', what,
            notice: integrationRejectionNotice(code, message) } }));
      }
      await load();
    }).finally(() => { setPending(null); });
  };

  const create = (): void => {
    write('create', '正在组成集成批次', '组批', async () => ({
      kind: 'CREATED',
      view: await client.command<IntegrationBatchRecordView>(
        integrationCreateCommand({ projectId, members, commandId: crypto.randomUUID() })),
    }));
  };

  const integrate = (batchId: string): void => {
    write(batchId, '正在集成批次（合并 + 一次整批的独立集成验证，可能需要一段时间）', '集成',
      async () => ({
        kind: 'INTEGRATED',
        report: await client.command<IntegrationReportView>(integrationIntegrateCommand({
          projectId, batchId, commandId: crypto.randomUUID(),
        })),
      }));
  };

  const cancel = (batchId: string): void => {
    write(batchId, '正在尝试取消集成批次', '取消', async () => ({
      kind: 'CANCELLED',
      view: await client.command<IntegrationBatchRecordView>(integrationCancelCommand({
        projectId, batchId, reason: reasons[batchId] ?? '', commandId: crypto.randomUUID(),
      })),
    }));
  };

  return (
    <section className="integration-panel">
      <h4>集成批次 · dev
        <span className="muted hint">同一 CLI 命令面 · ADR-0018 / ADR-0053</span></h4>
      <p className="muted hint">
        这是项目级的批次记录：一个批次可以有一个或多个成员任务，按 task_id 顺序合并，然后跑
        <strong>一次</strong>覆盖整批的独立集成验证，只有 PASSED 才推进 dev。
        {' '}{integrationNotPromotionNotice}
      </p>
      <p className="muted hint">{integrationMissingFactsNotes.join(' ')}</p>
      {error === null ? null : <p className="error" role="alert">批次记录读取失败：{error}</p>}
      <div className="actions">
        <span className="muted">只读</span>
        <button type="button" disabled={pending !== null}
          onClick={() => { void run('正在刷新集成批次', load); }}>刷新批次记录</button>
      </div>
      {batches === null ? <p className="muted" role="status">正在读取集成批次…</p> : (
        <IntegrationBatchTable batches={batches} />
      )}

      <h4>组批（task integration create）
        <span className="muted hint">会写一条批次记录 · 不碰 Git</span></h4>
      <p className="muted">{integrationCreateExplainer}</p>
      <p className="muted hint">
        每个成员行上显示的 <span className="mono">v&lt;version&gt;</span> 就是这次要发送的
        {' '}<span className="mono">expected-version</span>（CAS）；它过期时 Runtime 会拒绝为
        {' '}<span className="mono">CONCURRENT_MODIFICATION</span>，请刷新后重试。下拉框列出项目里每一个任务，
        不按状态过滤，也不隐藏按钮：能不能当成员由 Runtime 判断。
      </p>
      <ul className="list integration-member-picker">
        {memberRows.map((taskId, index) => {
          const selected = taskId.length === 0 ? null : byTaskId.get(taskId) ?? null;
          return (
            <li key={`member-${index}`}>
              <select aria-label={`成员 ${index + 1} 的任务`} value={taskId}
                onChange={(event) => {
                  const value = event.target.value;
                  setMemberRows((previous) => previous.map((row, at) =>
                    at === index ? value : row));
                }}>
                <option value="">— 选择任务 —</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>{integrationTaskOptionLabel(task)}</option>
                ))}
              </select>
              <span className="muted mono">{taskId.length === 0 ? '未选择（不会出现在请求里）'
                : selected === null ? '该任务不在当前列表里（不会出现在请求里）'
                  : `expected-version v${selected.version}`}</span>
              <button type="button" disabled={memberRows.length === 1}
                onClick={() => {
                  setMemberRows((previous) => previous.filter((_, at) => at !== index));
                }}>移除</button>
            </li>
          );
        })}
      </ul>
      <div className="actions">
        <button type="button" disabled={pending !== null}
          onClick={() => { setMemberRows((previous) => [...previous, '']); }}>＋ 增加一个成员</button>
      </div>
      <p className="muted">这条按钮会发出的请求字段：</p>
      <pre className="next-step-commands">{previewLines.join('\n')}</pre>
      <div className="actions">
        <button type="button" className="primary" disabled={pending !== null}
          title="组成一个批次：把成员与 dev 基线固定成一条记录，不合并、不验证、不碰 Git"
          onClick={create}>组批（task integration create）</button>
      </div>
      {outcomes.create === undefined ? null
        : <IntegrationOutcomeCard outcome={outcomes.create} />}

      <h4>批次的集成与取消
        <span className="muted hint">这两个按钮会真的改状态</span></h4>
      <p className="muted">下面是每个批次的写控件。按钮不按本地允许清单隐藏或禁用：
        能不能集成、能不能取消由 Runtime 按记录判断；被拒绝时这里显示它返回的稳定码。</p>
      <IntegrationBatchOperations batches={batches ?? []} reasons={reasons} outcomes={outcomes}
        pending={pending}
        onReason={(batchId, value) => {
          setReasons((previous) => ({ ...previous, [batchId]: value }));
        }}
        onIntegrate={integrate}
        onCancel={cancel} />
      <p className="muted hint">
        这个面板不提供「删除批次」或「重试合并」：失败/失效的批次保留现场，按当前事实重新组批，
        由集成与取消两个命令面处理。它也不推送、不拉取、不重启任何东西。
      </p>
    </section>
  );
}
