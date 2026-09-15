import { useCallback, useEffect, useState } from 'react';
import { describeError, RuntimeClient } from './api.js';
import type { PromotionPhaseView, StablePromotionView } from './types.js';

/**
 * Stable promotion records (`promotion list` / `promotion get`, ADR-0022 / ADR-0047 / ADR-0052),
 * read-only.
 *
 * A promotion record is written by the promoting CLI client, so this panel reports exactly what was
 * recorded: which of the two facts the record currently states (`phase`), what was **read back**
 * from the remote, whether `main` moved at all (`promotedCommit`), what the approval said under
 * STRICT, and what the restart steps observed. Two claims are deliberately never made here:
 *
 * - **pushed ≠ promoted**: with `phase: AWAITING_PULL` the candidate is on the remote `dev` and the
 *   main checkout has not pulled it, so nothing on this screen may read as 「已提升」/「已完成」;
 * - **a moved ref is not a live Runtime**: the restart result is what makes a promotion complete.
 *
 * The panel executes no Git, no pull, no restart and no push — the pull in the main checkout is the
 * user's own step (ADR-0047 D02).
 */

const promotionStateLabels: Record<string, string> = {
  CREATED: '已创建',
  AWAITING_APPROVAL: '等待批准',
  PROMOTING: '已推送远端 dev（未拉取）',
  RESTARTING: '重启记录阶段',
  SUCCEEDED: '已完成（含重启）',
  STALE: '已失效',
  FAILED: '失败',
  RECOVERY_REQUIRED: '需要恢复',
};

/**
 * The derived phase is the Runtime's own answer (`promotionPhase`), never a client-side deduction:
 * `READY_TO_PUSH` / `AWAITING_PULL` / `RESTART_PENDING` / `MAIN_PUSH_PENDING` are **not** a finished
 * promotion, and only `COMPLETE` is.
 */
const promotionPhaseLabels: Record<PromotionPhaseView, string> = {
  READY_TO_PUSH: '尚未推送',
  AWAITING_PULL: '已推送、等待拉取',
  RESTART_PENDING: '待重启核对',
  MAIN_PUSH_PENDING: '重启已记录、远端 main 未发布',
  COMPLETE: '已完成',
  REFUSED: '记录已失效或未推进',
};

/** One phase label; an unexpected value is shown verbatim rather than guessed at. */
export function promotionPhaseLabel(phase: PromotionPhaseView): string {
  return promotionPhaseLabels[phase] ?? phase;
}

/** Only `COMPLETE` may look like success; the phases that mean "still to do" look like a wait. */
export function promotionPhaseClass(phase: PromotionPhaseView): string {
  if (phase === 'COMPLETE') return 'state state-ready';
  if (phase === 'REFUSED') return 'state state-failed';
  if (phase === 'AWAITING_PULL' || phase === 'RESTART_PENDING'
    || phase === 'MAIN_PUSH_PENDING') return 'state state-waiting';
  return 'state';
}

/** True for exactly the one phase that ends the promotion (restart recorded, remote main published). */
export function promotionPhaseFinished(phase: PromotionPhaseView): boolean {
  return phase === 'COMPLETE';
}

/** The two commands the AWAITING_PULL step requires **in the main checkout** (ADR-0047 D02). */
export const mainCheckoutPullCommands = ['git fetch origin', 'git merge --ff-only origin/dev'];

/** The fixed restart sequence the record holds; shown so the next call's steps are not a surprise. */
export const promotionRestartCommands = ['bun install --frozen-lockfile', 'bun run build:ui',
  'bun run codeestra stop', 'bun run codeestra status'];

/**
 * What the record says the **next** step is, per phase — including the one step this UI cannot do
 * for the user: the `git fetch` + `git merge --ff-only origin/dev` in the main checkout.
 */
export function promotionNextStep(promotion: StablePromotionView): {
  readonly headline: string;
  readonly detail: string;
  readonly commands: readonly string[];
} {
  switch (promotion.phase) {
    case 'AWAITING_PULL':
      return {
        headline: '已推送 ≠ 已提升：候选已在远端 dev，main 检出还没有拉取',
        detail: '下一步是「你在检出 main 的那个 clone 里」执行下面两条命令；本界面不执行 Git、不拉取、'
          + '不代表提升完成。拉取后再次运行 promotion promote，Runtime 才核对到 main 检出已在候选上、'
          + '记录并执行重启序列，最后把候选推回远端 main。命令面在这一阶段退出码 3——那是「等待」，'
          + '不是失败，也没有任何重启记账。',
        commands: mainCheckoutPullCommands,
      };
    case 'READY_TO_PUSH':
      return {
        headline: '尚未推送：这一记录还没有把固定候选推到远端 dev',
        detail: 'prepare 不写任何 Git 也不写远端。promote 只推固定候选这一个 ref 到远端 dev，并读回核对；'
          + '它不移动 main。',
        commands: [],
      };
    case 'RESTART_PENDING':
      return {
        headline: '拉取已被观察到：等待重启序列的结果被记录',
        detail: '再次运行 promotion promote 会在 main 检出依次执行下面四步；只有每一步退 0、重启后的 '
          + 'Runtime 回答 READY、且应答的 boot 与发出计划的 boot 不同，重启才会被记录。',
        commands: promotionRestartCommands,
      };
    case 'MAIN_PUSH_PENDING':
      return {
        headline: '重启已记录，但远端 main 还没有发布',
        detail: '再次运行 promotion promote 只重试把候选推回远端 main 并读回核对，不会重复停 Runtime。',
        commands: [],
      };
    case 'COMPLETE':
      return {
        headline: '已完成：重启已记录，候选已推回远端 main',
        detail: '只有这一阶段算提升完成。Runtime 的双实例身份、稳定 clone 的 ref 等仍以各自命令面的输出为准。',
        commands: [],
      };
    default:
      return {
        headline: '记录已失效或未推进',
        detail: '记录是 STALE 或 FAILED（或被放弃），没有推进任何 ref。看过 outcome 与 detail 之后再决定是否 '
          + 'prepare 一次新的提升。',
        commands: [],
      };
  }
}

/** How the `main 结果` cell reads, per phase: an unpulled record has not observed the checkout. */
export function promotionMainResultLabel(promotion: StablePromotionView): string {
  if (promotion.promotedCommit !== null) return short(promotion.promotedCommit);
  if (promotion.phase === 'AWAITING_PULL') return '尚未拉到 main 检出';
  if (promotion.phase === 'READY_TO_PUSH') return '未改动';
  return '未记录';
}

/** The restart column: `AWAITING_PULL` records no restart step at all, on purpose (ADR-0052). */
export function promotionRestartLabel(promotion: StablePromotionView): string {
  if (promotion.restart !== null) return promotion.restart.runtimeStatus ?? '已记录';
  return promotion.phase === 'AWAITING_PULL' ? '此阶段不记录' : '未记录';
}

function stateLabel(state: string): string {
  return promotionStateLabels[state] ?? state;
}

/** A state is only green once the record itself says the whole promotion, restart included, ended. */
function stateClass(state: string): string {
  if (state === 'SUCCEEDED') return 'state-ready';
  if (state === 'FAILED' || state === 'RECOVERY_REQUIRED' || state === 'STALE') return 'state-failed';
  // `PROMOTING` is "pushed to the remote dev, main has not pulled it yet": a wait the user has to
  // end, not progress of its own. `RESTARTING` really is work in flight.
  if (state === 'PROMOTING') return 'state-waiting';
  if (state === 'RESTARTING') return 'state-running';
  return 'state';
}

function timeLabel(at: number | null): string {
  return at === null ? '—' : new Date(at).toLocaleString('zh-CN');
}

function short(value: string | null): string {
  return value === null ? '—' : value.slice(0, 10);
}

/** The restart outcome as the record holds it, including the steps that failed. */
function RestartSummary({ promotion }: { readonly promotion: StablePromotionView }) {
  if (promotion.restart === null) {
    if (promotion.phase === 'AWAITING_PULL') {
      return (
        <p className="muted">
          这一阶段不执行、也不记录任何重启步骤（ADR-0052）：推送成功只说明候选已在远端
          {' '}<span className="mono">dev</span> 上。
        </p>
      );
    }
    if (promotion.phase === 'READY_TO_PUSH') {
      return <p className="muted">还没有推送过，因此没有重启结果可记录。</p>;
    }
    return (
      <p className="muted">
        没有记录重启结果。若 <span className="mono">main</span> 已移动但没有重启证据，
        这不算提升完成：稳定 Runtime 可能仍在跑旧代码。
      </p>
    );
  }
  const restart = promotion.restart;
  return (
    <>
      <p className="muted mono">
        boot {short(restart.observedBootId)} · runtime {restart.runtimeStatus ?? '—'}
        {' · ui '}{restart.uiRunning === null ? '—' : (restart.uiRunning ? '运行中' : '未运行')}
      </p>
      <div className="table-scroll"><table>
        <thead><tr><th>步骤</th><th>命令</th><th>退出码</th><th>耗时</th><th>输出</th></tr></thead>
        <tbody>
          {restart.steps.map((step) => (
            <tr key={step.id}>
              <td>{step.id}</td>
              <td className="mono">{step.argv.join(' ')}<div className="muted">{step.cwd}</div></td>
              <td>{step.exitCode === null ? '—' : step.exitCode}</td>
              <td>{(step.durationMs / 1000).toFixed(1)}s</td>
              <td className="mono">out {step.stdoutBytes} B · err {step.stderrBytes} B
                {step.failureDetail === undefined ? null
                  : <div className="muted">{step.failureDetail}</div>}</td>
            </tr>
          ))}
          {restart.steps.length === 0 ? (
            <tr><td colSpan={5} className="muted">已记录重启结果，但没有步骤。</td></tr>
          ) : null}
        </tbody>
      </table></div>
    </>
  );
}

/**
 * The record's own next step, per phase, including the manual pull in the main checkout. This is a
 * read-only statement of what the command face does next; the panel runs none of it.
 */
export function PromotionNextStepCard({ promotion }: {
  readonly promotion: StablePromotionView;
}) {
  const step = promotionNextStep(promotion);
  return (
    <div className="promotion-next-step">
      <h5>下一步 <span className="muted hint">phase {promotion.phase}</span></h5>
      <p>{step.headline}</p>
      <p className="muted">{step.detail}</p>
      {step.commands.length === 0 ? null : (
        <pre className="next-step-commands">
          {promotion.phase === 'AWAITING_PULL'
            ? `cd ${promotion.mainWorktreePath ?? '<检出 main 的那个 clone>'}\n` : ''}
          {step.commands.join('\n')}
        </pre>
      )}
      {promotion.phase !== 'AWAITING_PULL' ? null : (
        <p className="muted hint">
          本界面不执行 Git、不拉取、也不重启；这两条命令只能在 main 检出里由你执行。
        </p>
      )}
    </div>
  );
}

/** One promotion's facts: `dev` → `main`, the phase, the readback, the approval and the restart. */
function PromotionDetail({ promotion, loading, error, onClose }: {
  readonly promotion: StablePromotionView | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
}) {
  if (loading) return <p className="muted" role="status">正在读取提升记录…</p>;
  if (error !== null) return <p className="error" role="alert">提升记录读取失败：{error}</p>;
  if (promotion === null) return null;
  return (
    <div className="promotion-detail card nested">
      <div className="section-heading">
        <h5>{stateLabel(promotion.state)} · <span className="mono">{short(promotion.promotionId)}</span></h5>
        <button type="button" onClick={onClose}>关闭</button>
      </div>
      <div className="promotion-phase">
        <span className={promotionPhaseClass(promotion.phase)}>
          {promotionPhaseLabel(promotion.phase)}
        </span>
        {promotionPhaseFinished(promotion.phase) ? null : (
          <span className="muted hint">
            这一阶段不算「已提升」也不计入任何重启记账：{promotionPhaseLabel(promotion.phase)}。
          </span>
        )}
      </div>
      <dl className="kv">
        <dt>阶段（派生）</dt>
        <dd className="mono">{promotion.phase}
          <div className="muted">由 state 与重启结果推导，不是一个可以单独写回的列；只有 COMPLETE 是完成。</div></dd>
        <dt>dev → main</dt>
        <dd className="mono">{promotion.devRef} {short(promotion.candidateCommit)} → {promotion.mainRef}
          {' '}{short(promotion.promotedCommit)}
          <div className="muted">预期 main {short(promotion.expectedMainCommit)}
            {promotion.promotedCommit === null ? ' · main 未被改动' : ' · 已读回的 main'}</div></dd>
        <dt>远端读回</dt>
        <dd className="mono">origin/dev {promotion.remoteDevCommit ?? '—'}
          <div className="mono">origin/main {promotion.remoteMainCommit ?? '—'}</div>
          <div className="muted">推送于 {timeLabel(promotion.pushedAt)} · 推回远端 main 于
            {' '}{timeLabel(promotion.mainPushedAt)} · dev clone {promotion.devRepoPath ?? '—'}</div>
          <div className="muted">这些是 <span className="mono">git ls-remote</span> 读回来的观察值，不是输入：
            push 退 0 不等于候选真的在远端。</div></dd>
        <dt>权限模式</dt>
        <dd>{promotion.permissionMode}{promotion.permissionMode === 'FULL'
          ? '（不批准）' : '（保留批准语义）'}
          {promotion.approval === null ? <span className="muted"> · 无批准记录</span> : (
            <span className="muted"> · 批准 dev {short(promotion.approval.devCommit)} / main
              {' '}{short(promotion.approval.mainCommit)} · {timeLabel(promotion.approval.approvedAt)}</span>
          )}</dd>
        <dt>集成批次 / 验证</dt>
        <dd className="mono">{short(promotion.integrationBatchId)} · {short(promotion.verificationId)}
          <div className="muted">验证 commit {short(promotion.verificationTestedCommit)}</div></dd>
        <dt>main 工作树</dt>
        <dd className="mono">{promotion.mainWorktreePath ?? '—（拉取被观察到之后才会记录）'}</dd>
        <dt>结果</dt>
        <dd>{promotion.outcomeCode ?? '—'}
          {promotion.detail === null ? null : <div className="muted">{promotion.detail}</div>}</dd>
        <dt>时间</dt>
        <dd>{timeLabel(promotion.createdAt)} → {timeLabel(promotion.completedAt)}</dd>
      </dl>
      <PromotionNextStepCard promotion={promotion} />
      <h5>包含的任务 revision</h5>
      {promotion.members.length === 0 ? <p className="muted">没有记录成员。</p> : (
        <ul className="list">
          {promotion.members.map((member) => (
            <li key={`${member.batchId}-${member.taskId}`} className="muted">
              <span className="mono">{short(member.taskId)}</span> · revision
              {' '}<span className="mono">{short(member.revisionId)}</span> · 候选 commit
              {' '}<span className="mono">{short(member.candidateCommit)}</span> · 批次
              {' '}<span className="mono">{short(member.batchId)}</span>
            </li>
          ))}
        </ul>
      )}
      <h5>Runtime 重启</h5>
      <RestartSummary promotion={promotion} />
      <p className="muted hint">
        提升完成需要记录里的重启结果；本页面只读，不推送、不拉取、不重启，也不代表任何提升已完成。
      </p>
    </div>
  );
}

/**
 * The promotion records of one project, optionally filtered to the promotions that contain a Task.
 * `promotion get` is used for the detail view, so both commands on this face are represented.
 */
export function PromotionPanel({ client, projectId, taskId, refreshToken, run }: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  /** Null lists every record; a Task id keeps only the records whose members include it. */
  readonly taskId: string | null;
  readonly refreshToken: number;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [promotions, setPromotions] = useState<readonly StablePromotionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<StablePromotionView | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await client.command<readonly StablePromotionView[]>({
        command: 'promotion.list', projectId, limit: 20,
      });
      setPromotions(next);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [client, projectId]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const visible = (promotions ?? []).filter((promotion) => taskId === null
    || promotion.members.some((member) => member.taskId === taskId));
  const truncatedList = (promotions ?? []).length === 20;

  const openDetail = (promotionId: string): void => {
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    void run('正在读取提升记录', async () => {
      try {
        setDetail(await client.command<StablePromotionView>({
          command: 'promotion.get', projectId, promotionId,
        }));
      } catch (caught) {
        setDetailError(describeError(caught));
      } finally {
        setDetailLoading(false);
      }
    });
  };

  return (
    <section className="promotion-panel">
      <h4>稳定提升记录 · dev → main <span className="muted hint">只读 · ADR-0022 / ADR-0052</span></h4>
      <p className="muted hint">
        提升是另一条流程：合入 dev 不等于提升到 main，「已推送远端 dev」也不等于已提升——
        推送之后还需要你在 main 检出执行 <span className="mono">git fetch origin</span> +
        {' '}<span className="mono">git merge --ff-only origin/dev</span>，再次运行
        {' '}<span className="mono">promotion promote</span> 才会核对、记录并执行重启，最后推回远端 main。
        main 已移动也不等于 Runtime 已完成重启。这里只显示记录里的事实。
      </p>
      {error === null ? null : <p className="error" role="alert">提升记录读取失败：{error}</p>}
      {promotions === null ? <p className="muted" role="status">正在读取提升记录…</p> : (
        <>
          <div className="actions">
            <span className="muted">{visible.length}
              {taskId === null ? ' 条记录' : ' 条包含本任务的记录'}</span>
            <button type="button" onClick={() => { void run('正在刷新提升记录', load); }}>刷新</button>
            {truncatedList ? <span className="muted">最多显示最近 20 条，可能还有更早的记录。</span> : null}
          </div>
          {visible.length === 0 ? (
            <p className="muted">{taskId === null
              ? '这个项目还没有提升记录。'
              : '还没有包含本任务的提升记录。'}</p>
          ) : (
            <div className="table-scroll"><table>
              <thead>
                <tr><th>状态</th><th>候选 commit</th><th>dev 基线</th><th>main 结果</th><th>模式</th>
                  <th>重启</th><th>结果</th><th>时间</th><th /></tr>
              </thead>
              <tbody>
                {visible.map((promotion) => (
                  <tr key={promotion.promotionId}>
                    <td><span className={stateClass(promotion.state)}>{stateLabel(promotion.state)}</span>
                      <div><span className={promotionPhaseClass(promotion.phase)}>
                        {promotionPhaseLabel(promotion.phase)}
                      </span></div>
                      <div className="muted mono">{short(promotion.promotionId)}</div></td>
                    <td className="mono">{short(promotion.candidateCommit)}
                      <div className="muted mono">origin/dev {short(promotion.remoteDevCommit)}</div></td>
                    <td className="mono">{short(promotion.expectedMainCommit)}</td>
                    <td className="mono">{promotion.promotedCommit === null
                      ? <span className="muted">{promotionMainResultLabel(promotion)}</span>
                      : short(promotion.promotedCommit)}
                      <div className="muted mono">origin/main {short(promotion.remoteMainCommit)}</div></td>
                    <td>{promotion.permissionMode}</td>
                    <td>{promotionRestartLabel(promotion)}</td>
                    <td>{promotion.outcomeCode ?? '—'}</td>
                    <td>{timeLabel(promotion.createdAt)}</td>
                    <td><button type="button" onClick={() => { openDetail(promotion.promotionId); }}>
                      详情
                    </button></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
          <PromotionDetail promotion={detail} loading={detailLoading} error={detailError}
            onClose={() => { setDetail(null); setDetailError(null); }} />
        </>
      )}
    </section>
  );
}
