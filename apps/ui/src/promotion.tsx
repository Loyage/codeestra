import { useCallback, useEffect, useState } from 'react';
import { describeError, RuntimeClient } from './api.js';
import type { StablePromotionView } from './types.js';

/**
 * Stable promotion records (`promotion list` / `promotion get`, ADR-0022), read-only.
 *
 * A promotion record is written by the promoting CLI client, so this panel reports exactly what was
 * recorded: whether `main` moved at all (`promotedCommit`), what the approval said under STRICT, and
 * what the restart steps observed. **A moved ref is not a live Runtime**; this panel never claims the
 * promotion finished unless the record itself shows the restart outcome.
 */

const promotionStateLabels: Record<string, string> = {
  CREATED: '已创建',
  AWAITING_APPROVAL: '等待批准',
  PROMOTING: '正在提升',
  RESTARTING: '正在重启 Runtime',
  SUCCEEDED: '已成功',
  STALE: '已失效',
  FAILED: '失败',
  RECOVERY_REQUIRED: '需要恢复',
};

function stateLabel(state: string): string {
  return promotionStateLabels[state] ?? state;
}

/** A state is only green once the record itself says the whole promotion, restart included, ended. */
function stateClass(state: string): string {
  if (state === 'SUCCEEDED') return 'state-ready';
  if (state === 'FAILED' || state === 'RECOVERY_REQUIRED' || state === 'STALE') return 'state-failed';
  if (state === 'PROMOTING' || state === 'RESTARTING') return 'state-running';
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

/** One promotion's facts: `dev` → `main`, the approval, the members and the restart evidence. */
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
      <dl className="kv">
        <dt>dev → main</dt>
        <dd className="mono">{promotion.devRef} {short(promotion.candidateCommit)} → {promotion.mainRef}
          {' '}{short(promotion.promotedCommit)}
          <div className="muted">预期 main {short(promotion.expectedMainCommit)}
            {promotion.promotedCommit === null ? ' · main 未被改动' : ' · 已读回的 main'}</div></dd>
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
        <dd className="mono">{promotion.mainWorktreePath ?? '—'}</dd>
        <dt>结果</dt>
        <dd>{promotion.outcomeCode ?? '—'}
          {promotion.detail === null ? null : <div className="muted">{promotion.detail}</div>}</dd>
        <dt>时间</dt>
        <dd>{timeLabel(promotion.createdAt)} → {timeLabel(promotion.completedAt)}</dd>
      </dl>
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
        提升完成需要记录里的重启结果；本页面不执行、也不代表任何提升已完成。
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
      <h4>稳定提升记录 · dev → main <span className="muted hint">只读 · ADR-0022</span></h4>
      <p className="muted hint">
        提升是另一条流程：合入 dev 不等于提升到 main，main 已移动也不等于 Runtime 已完成重启。
        这里只显示记录里的事实。
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
                      <div className="muted mono">{short(promotion.promotionId)}</div></td>
                    <td className="mono">{short(promotion.candidateCommit)}</td>
                    <td className="mono">{short(promotion.expectedMainCommit)}</td>
                    <td className="mono">{promotion.promotedCommit === null
                      ? <span className="muted">未改动</span> : short(promotion.promotedCommit)}</td>
                    <td>{promotion.permissionMode}</td>
                    <td>{promotion.restart === null
                      ? <span className="muted">未记录</span>
                      : (promotion.restart.runtimeStatus ?? '已记录')}</td>
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
