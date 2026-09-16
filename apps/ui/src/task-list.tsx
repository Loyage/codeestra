import { useEffect, useMemo, useState } from 'react';
import { agentRunRowHint } from './agent-run.js';
import { updateTimeLabel, useTimeDisplay } from './ui-settings.js';
import type { AttentionView, TaskView } from './types.js';

const states: Record<string, { label: string; hint: string; tone: string; moving?: boolean }> = {
  DRAFT: { label: '草稿', hint: '尚未提交 · 提交后进入调度', tone: 'neutral' },
  READY: { label: '就绪 / 待调度', hint: '等待调度或手动启动 · 不代表 Agent 已运行', tone: 'neutral' },
  RUNNING: { label: '执行中', hint: '查看会话、实时步骤或待提交成果', tone: 'active', moving: true },
  WAITING_FOR_USER: { label: '等你处理', hint: '查看问题或权限请求，回答后继续', tone: 'attention' },
  BLOCKED: { label: '等待依赖', hint: '上游成果尚未满足依赖条件', tone: 'attention' },
  PAUSING: { label: '正在暂停', hint: '等待协作停止与静止确认', tone: 'attention', moving: true },
  PAUSED: { label: '已暂停', hint: '现场已保留 · 可继续执行', tone: 'neutral' },
  CANCELLING: { label: '正在终止', hint: '等待协作停止 · 尚未确认结束', tone: 'attention', moving: true },
  CANCELLED: { label: '已终止', hint: '记录保留 · 不会自动重开', tone: 'neutral' },
  EXECUTED: { label: '成果已提交', hint: '查看任务验证与 dev 集成 · 尚非发布', tone: 'result' },
  SUCCEEDED: { label: '已合入 dev', hint: '已完成任务集成 · 不等于 main 已发布', tone: 'success' },
  FAILED: { label: '执行失败', hint: '查看失败原因与执行记录', tone: 'danger' },
  RECOVERY_REQUIRED: { label: '需要恢复', hint: '状态需人工核对 · 不自动重试', tone: 'danger' },
};

export function taskStateLabel(state: string): string {
  return states[state]?.label ?? state;
}

/** Animation describes the recorded Task state, not provider liveness or estimated completion. */
export function TaskStateBadge({ state, live = false }: { state: string; live?: boolean }) {
  const presentation = states[state];
  return <span className={`task-status tone-${presentation?.tone ?? 'neutral'}${live && presentation?.moving ? ' is-moving' : ''}`}
    title={`Runtime 任务状态：${state}；不代表进程心跳或完成比例`}>
    <span className="status-indicator" aria-hidden="true">{presentation?.tone === 'danger' ? '!' : presentation?.tone === 'success' ? '✓' : ''}</span>
    {taskStateLabel(state)}
  </span>;
}

export function TaskList({ tasks, attentions, query, filter, sort, showArchived, live, setQuery, setFilter,
  setSort, setShowArchived, selectTask }: {
  tasks: readonly TaskView[];
  attentions: readonly AttentionView[];
  query: string;
  filter: string;
  sort: string;
  showArchived: boolean;
  live: boolean;
  setQuery: (value: string) => void;
  setFilter: (value: string) => void;
  setSort: (value: string) => void;
  setShowArchived: (value: boolean) => void;
  selectTask: (taskId: string) => void;
}) {
  const [now, setNow] = useState(Date.now);
  // The time-display setting (ADR-0045) selects between the workbench's own relative wording and the
  // local absolute time. Both keep the exact timestamps in the element's `title`.
  const timeDisplay = useTimeDisplay();
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const requests = useMemo(() => {
    const result = new Map<string, number>();
    for (const attention of attentions) {
      if (attention.status === 'OPEN') result.set(attention.taskId, (result.get(attention.taskId) ?? 0) + 1);
    }
    return result;
  }, [attentions]);
  const current = tasks.filter((task) => task.archivedAt === null);
  const needsAttention = (task: TaskView) => (requests.get(task.id) ?? 0) > 0
    || ['WAITING_FOR_USER', 'RECOVERY_REQUIRED', 'FAILED'].includes(task.state);
  const matchesFilter = (task: TaskView) => filter === 'all'
    || (filter === 'attention' ? needsAttention(task) : task.state === filter);
  const available = showArchived ? tasks : current;
  const search = query.trim().toLocaleLowerCase().replace(/^#(?=\d)/, '');
  const visible = available.filter((task) => matchesFilter(task)
    && `${task.displayNumber} ${task.currentRevision.specification}`.toLocaleLowerCase().includes(search));
  if (sort === 'updated') visible.sort((a, b) => b.updatedAt - a.updatedAt || b.displayNumber - a.displayNumber);
  if (sort === 'priority') visible.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const overview = [
    { filter: 'all', label: '全部任务', count: current.length, tone: 'neutral' },
    { filter: 'RUNNING', label: '执行中', count: current.filter((task) => task.state === 'RUNNING').length, tone: 'active' },
    { filter: 'attention', label: '需要你处理', count: current.filter(needsAttention).length, tone: 'attention' },
    { filter: 'EXECUTED', label: '成果已提交', count: current.filter((task) => task.state === 'EXECUTED').length, tone: 'result' },
  ];
  const reset = () => { setQuery(''); setFilter('all'); setShowArchived(false); setSort('default'); };
  return <>
    <div className="task-overview" aria-label="项目任务概况与快捷筛选（不含归档）">
      {overview.map((item) => <button type="button" key={item.filter}
        className={`overview-item tone-${item.tone}`} aria-pressed={filter === item.filter && !showArchived}
        onClick={() => { setFilter(item.filter); setQuery(''); setShowArchived(false); }}>
        <strong>{item.count}</strong><span>{item.label}</span>
      </button>)}
    </div>
    <section className="card task-list">
      <div className="section-heading">
        <h2 id="task-list-heading" tabIndex={-1}>任务 <span className="muted hint">{visible.length} / {available.length}</span></h2>
        <span className={`list-sync ${live ? 'live' : ''}`} role="status">
          <span aria-hidden="true">●</span> {live ? '状态随事件更新' : '实时连接不可用 · 当前为最近记录，请刷新'}
        </span>
      </div>
      <div className="task-filters">
        <input type="search" aria-label="搜索任务" placeholder="搜索任务内容或 #编号" value={query}
          onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="按任务状态筛选" value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">全部状态</option><option value="attention">需要你处理</option>
          {[...new Set([...tasks.map((task) => task.state), ...(filter === 'all' || filter === 'attention' ? [] : [filter])])].map((value) => (
            <option key={value} value={value}>{taskStateLabel(value)}</option>
          ))}
        </select>
        <select aria-label="任务排序" value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="default">默认顺序</option><option value="updated">最近更新优先</option><option value="priority">优先级从高到低</option>
        </select>
        <label className="inline"><input type="checkbox" checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)} />含归档</label>
        {query || filter !== 'all' || showArchived || sort !== 'default'
          ? <button type="button" className="filter-reset" onClick={reset}>重置</button> : null}
      </div>
      <ul className="list task-rows">
        {visible.map((task) => {
          const count = requests.get(task.id) ?? 0;
          return <li key={task.id}>
            <button type="button" id={`task-row-${task.id}`} className={`task-row tone-${states[task.state]?.tone ?? 'neutral'}`}
              onClick={() => selectTask(task.id)}>
              <span className="task-row-main">
                <span className="task-row-heading"><span className="task-number mono">#{task.displayNumber}</span>
                  {task.archivedAt !== null ? <span className="muted hint">已归档</span> : null}
                  {count > 0 ? <span className="request-count">{count} 项待处理</span> : null}
                </span>
                <span className="task-title">{task.currentRevision.specification}</span>
                <span className="task-meta">
                  <span>规格 r{task.currentRevision.number}</span><span title="数值越大优先级越高；只影响后续调度，不抢占">优先级 {task.priority}</span>
                  {task.currentRevision.constraints.length > 0 ? <span>{task.currentRevision.constraints.length} 条约束</span> : null}
                  <time dateTime={new Date(task.updatedAt).toISOString()} title={`更新：${new Date(task.updatedAt).toLocaleString('zh-CN')}；创建：${new Date(task.createdAt).toLocaleString('zh-CN')}`}>
                    {updateTimeLabel(task.updatedAt, now, timeDisplay)}</time>
                </span>
              </span>
              <span className="task-row-status"><TaskStateBadge state={task.state} live={live} />
                <span className="task-state-hint">
                  {agentRunRowHint(task.state, task.latestExecution ?? null)
                    ?? states[task.state]?.hint ?? '以 Runtime 记录为准'}
                </span>
              </span>
              <span className="task-open" aria-hidden="true">查看详情 →</span>
            </button>
          </li>;
        })}
        {visible.length === 0 ? <li className="list-empty muted">
          <strong>{tasks.length === 0 ? '从一个任务开始' : '没有匹配的任务'}</strong>
          <span>{tasks.length === 0 ? '在底部描述你的需求，创建草稿；提交后才进入调度。' : '试试其他关键词、状态，或显示已归档的任务。'}</span>
          {tasks.length > 0 ? <button type="button" onClick={reset}>重置筛选</button> : null}
        </li> : null}
      </ul>
    </section>
  </>;
}
