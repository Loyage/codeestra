import { useCallback, useEffect, useState } from 'react';
import { describeError, RuntimeClient } from './api.js';
import type { TaskDependencyEdgeView, TaskDependencyView, TaskView } from './types.js';

/**
 * The dependency graph as `task depends list` projects it (ADR-0024).
 *
 * Read-only: it never writes a Task state, and it is not a scheduler view. `BLOCKED` here means one
 * thing only — an unmet dependency — while conflict, capacity and revision waiting are different
 * facts and are never folded into it. The verdict (is each edge satisfied, and why not) comes from
 * the Runtime; this panel does not re-derive it from the Task baseline itself.
 */

const reasonLabels: Record<string, string> = {
  UPSTREAM_NOT_INTEGRATED: '上游还没有到达 INTEGRATED 的合入批次',
  DEV_BASELINE_MISSING: '项目没有可读的 Task 基线 ref（所有边保持未满足）',
  DEV_REF_UNREADABLE: '基线 ref 读取失败（不当作“无冲突”或“已满足”）',
  NOT_REACHABLE_FROM_DEV: '上游已合入的 commit 已不在当前基线上',
};

function reasonLabel(code: string): string {
  return reasonLabels[code] ?? code;
}

/**
 * The Task lifecycle words this panel can show. Anything unknown keeps its recorded name instead of
 * being mapped to a friendlier one that would make two different states look alike.
 */
const taskStateLabels: Record<string, string> = {
  DRAFT: '草稿',
  READY: '就绪',
  RUNNING: '运行中',
  WAITING_FOR_USER: '等待用户',
  BLOCKED: '已阻塞',
  PAUSING: '正在暂停',
  PAUSED: '已暂停',
  EXECUTED: '已执行',
  CANCELLING: '正在终止',
  CANCELLED: '已终止',
  SUCCEEDED: '已成功',
  FAILED: '失败',
  RECOVERY_REQUIRED: '需要恢复',
};

function taskStateLabel(state: string): string {
  return taskStateLabels[state] ?? state;
}

/** One edge line: which pinned upstream revision, what was merged, and the Runtime's verdict. */
function edgeRow(edge: TaskDependencyEdgeView, showDependent: boolean) {
  return (
    <tr key={`${edge.dependentTaskId}:${edge.prerequisiteTaskId}:${edge.requiredRevisionId}`}>
      {showDependent ? (
        <td>#{edge.dependentDisplayNumber}</td>
      ) : null}
      <td>
        #{edge.prerequisiteDisplayNumber}
        <div className="muted">规格 r{edge.requiredRevisionNumber} · {taskStateLabel(edge.prerequisiteState)}</div>
      </td>
      <td className="mono">{edge.integratedCommit === null ? '未合入'
        : edge.integratedCommit.slice(0, 10)}</td>
      <td>
        {edge.satisfied
          ? <span className="state state-ready">已满足</span>
          : <span className="state state-blocked">未满足</span>}
      </td>
      <td>
        {edge.reason === null ? '—' : (
          <>
            <span className="mono">{reasonLabel(edge.reason.code)}</span>
            {edge.reason.detail === null ? null : <div className="muted">{edge.reason.detail}</div>}
          </>
        )}
      </td>
      <td className="mono">{edge.integrationBatchId === null ? '—'
        : edge.integrationBatchId.slice(0, 8)}</td>
    </tr>
  );
}

/** Maps a Task id to `#displayNumber` when the caller knows the list; ids stay visible otherwise. */
function taskTag(taskId: string, tasks: readonly TaskView[]): string {
  const known = tasks.find((task) => task.id === taskId);
  return known === undefined ? taskId.slice(0, 8) : `#${known.displayNumber}`;
}

/**
 * One dependency projection. With a `taskId` it shows that Task's prerequisites and its transitive
 * upstream/downstream closure; without one it shows the project-wide graph grouped by dependent.
 */
export function DependencyPanel({ client, projectId, taskId, tasks, refreshToken, run }: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  /** Null asks for the project-wide listing, exactly like `task depends list` without a Task. */
  readonly taskId: string | null;
  readonly tasks: readonly TaskView[];
  readonly refreshToken: number;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [view, setView] = useState<TaskDependencyView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await client.command<TaskDependencyView>({
        command: 'task.depends.list',
        projectId,
        ...(taskId === null ? {} : { taskId }),
      });
      setView(next);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [client, projectId, taskId]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const grouped = new Map<string, TaskDependencyEdgeView[]>();
  for (const edge of view?.edges ?? []) {
    const bucket = grouped.get(edge.dependentTaskId);
    if (bucket === undefined) grouped.set(edge.dependentTaskId, [edge]);
    else bucket.push(edge);
  }

  return (
    <section className="dependency-panel">
      <h4>依赖与 BLOCKED 原因 <span className="muted hint">只读投影 · 不写任务状态</span></h4>
      <p className="muted hint">
        一条边只有在钉住的上游 revision 有真正到达 <span className="mono">INTEGRATED</span>
        {' '}的合入、且该 commit 仍可从当前 dev 到达时才算满足。BLOCKED 只表示依赖未满足；
        冲突等待、容量等待与 revision 等待不会被算成 BLOCKED。
      </p>
      {error === null ? null : <p className="error" role="alert">依赖投影读取失败：{error}</p>}
      {view === null ? <p className="muted" role="status">正在读取依赖…</p> : (
        <>
          <div className="actions">
            <span className="muted mono">
              {view.devRef} {view.devCommit === null ? '（不可读）' : view.devCommit.slice(0, 10)}
            </span>
            {view.taskState === null ? null : (
              <span className={`state state-${view.taskState.toLowerCase()}`}>
                {taskStateLabel(view.taskState)}</span>
            )}
            <button type="button" onClick={() => { void run('正在刷新依赖', load); }}>刷新</button>
          </div>

          {view.blocked ? (
            <div className="banner error" role="status">
              <div>
                <strong>依赖未满足（BLOCKED 原因）</strong>
                <ul>
                  {view.blockedReasons.map((reason, index) => (
                    <li key={`${reason.code}-${reason.prerequisiteTaskId}-${index}`}>
                      {reasonLabel(reason.code)} · 前置 {taskTag(reason.prerequisiteTaskId, tasks)} ·
                      revision <span className="mono">{reason.requiredRevisionId.slice(0, 8)}</span>
                      {reason.detail === null ? null : `：${reason.detail}`}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          {view.edges.length === 0 ? (
            <p className="muted">没有依赖边。</p>
          ) : taskId === null ? (
            <div className="table-scroll"><table>
              <thead>
                <tr><th>依赖任务</th><th>前置任务</th><th>已合入 commit</th><th>判定</th><th>原因</th>
                  <th>集成批次</th></tr>
              </thead>
              <tbody>
                {[...grouped.values()].flatMap((edges) =>
                  edges.map((edge) => edgeRow(edge, true)))}
              </tbody>
            </table></div>
          ) : (
            <div className="table-scroll"><table>
              <thead>
                <tr><th>前置任务</th><th>已合入 commit</th><th>判定</th><th>原因</th><th>集成批次</th></tr>
              </thead>
              <tbody>
                {view.edges.map((edge) => edgeRow(edge, false))}
              </tbody>
            </table></div>
          )}

          {taskId === null ? null : (
            <p className="muted">
              本任务的上游闭包：{view.prerequisites.length === 0 ? '无'
                : view.prerequisites.map((id) => taskTag(id, tasks)).join('、')}
              {' · 下游闭包：'}{view.dependents.length === 0 ? '无'
                : view.dependents.map((id) => taskTag(id, tasks)).join('、')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
