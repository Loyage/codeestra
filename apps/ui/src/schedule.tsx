import { useCallback, useEffect, useState } from 'react';
import { describeError, RuntimeClient } from './api.js';
import {
  capacityLimitSourceLabel,
  capacityWaitReasonLabel,
  decisionLabel,
  dependencyBlockReasonLabel,
  dispositionLabel,
  formatSince,
  holderObservationLabel,
  impactIncompleteReasonLabel,
  impactReasonClassLabel,
  reconcileOutcomeLabel,
  reservationReleaseKindLabel,
  reservationStateClass,
  reservationStateLabel,
  runtimeStateLabel,
  verdictLabel,
  verdictStateClass,
  waitKindLabel,
  waitReasonLabel,
  waitStateClass,
} from './scheduling-labels.js';
import type {
  ConflictHitView,
  ProjectCapacityView,
  ScheduleAssessmentView,
  ScheduleCandidateView,
  ScheduleExplanationView,
  ScheduleOverviewView,
  ScheduleTickReportView,
  ScheduleUnknownReleaseView,
  ScheduleWaitView,
  SlotReservationDetailView,
  SlotReservationListView,
  SlotReservationReconcileReportView,
  SlotReservationReleaseView,
  SlotReservationView,
  TaskView,
} from './types.js';

/**
 * The scheduling engine (FOUNDATION-055 / ADR-0030) and capacity/slot reservations
 * (FOUNDATION-054 / ADR-0032), as read-only projections of the same command face the CLI uses.
 *
 * Every action here is one existing CLI command. The panel adds no scheduling semantics of its own:
 * a wait is rendered from the Runtime's own `wait` object (kind, code, detail, blocking, since), a
 * verdict from its own `assessment` object, and `UNKNOWN` is never softened into `SAFE`.
 */

/** A lightweight ticking clock, so a recorded waiting duration stays roughly current. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => { clearInterval(timer); };
  }, [intervalMs]);
  return now;
}

/** Maps a Task id to `#displayNumber` when the caller knows the list; ids stay visible otherwise. */
export function taskTag(taskId: string, tasks: readonly TaskView[]): string {
  const known = tasks.find((task) => task.id === taskId);
  return known === undefined ? taskId.slice(0, 8) : `#${known.displayNumber}`;
}

function shortId(value: string | null): string {
  return value === null ? '—' : value.slice(0, 8);
}

function dispositionStateClass(disposition: string): string {
  if (disposition === 'STARTED') return 'state state-ready';
  if (disposition === 'WOULD_START') return 'state state-running';
  if (disposition === 'WAITING') return 'state state-waiting';
  if (disposition === 'BLOCKED') return 'state state-blocked';
  if (disposition === 'FAILED') return 'state state-failed';
  return 'state';
}

function decisionStateClass(decision: string): string {
  if (decision === 'START_NOW') return 'state state-ready';
  if (decision === 'WAIT_CONFLICT') return 'state state-unknown';
  if (decision === 'WAIT_CAPACITY') return 'state state-waiting';
  if (decision === 'BLOCKED') return 'state state-blocked';
  if (decision === 'ACTIVE') return 'state state-running';
  return 'state';
}

/** The measured intersections behind a wait or a verdict — never just a colour. */
export function HitList({ hits, tasks }: {
  readonly hits: readonly ConflictHitView[];
  readonly tasks: readonly TaskView[];
}) {
  if (hits.length === 0) return null;
  return (
    <ul className="list hit-list">
      {hits.map((hit, index) => (
        <li key={`${hit.reason}-${hit.taskId ?? 'candidate'}-${String(index)}`} className="muted">
          <span className="mono">{hit.reason}</span> {waitReasonLabel(hit.reason)}
          <span className="muted"> · {impactReasonClassLabel(hit.class)}</span>
          {hit.taskId === null ? null : <> · 对方 {taskTag(hit.taskId, tasks)}</>}
          {hit.relation === null ? null
            : <> · 关系 <span className="mono">{hit.relation}</span></>}
          {hit.paths.length === 0 ? null : (
            <div className="mono hint">
              命中路径（{hit.pathCount}）: {hit.paths.join('、')}
              {hit.pathCount > hit.paths.length ? ' …（已截断）' : ''}
            </div>
          )}
          {hit.directories.length === 0 ? null
            : <div className="mono hint">重要目录：{hit.directories.join('、')}</div>}
          {hit.modules.length === 0 ? null
            : <div className="mono hint">模块：{hit.modules.join('、')}</div>}
          {hit.globalResources.length === 0 ? null
            : <div className="mono hint">全局资源：{hit.globalResources.join('、')}</div>}
          {(hit.features ?? []).length === 0 ? null
            : <div className="mono hint">声明的功能：{(hit.features ?? []).join('、')}</div>}
          <div className="hint">{hit.detail}</div>
        </li>
      ))}
    </ul>
  );
}

/** One wait as the Runtime reported it: its kind is never folded into `BLOCKED`. */
export function WaitBlock({ wait, tasks, now }: {
  readonly wait: ScheduleWaitView;
  readonly tasks: readonly TaskView[];
  readonly now: number;
}) {
  return (
    <div className="wait-block">
      <div className="row-head">
        <span className={waitStateClass(wait.kind)}>{waitKindLabel(wait.kind)}</span>
        <span className="mono">{wait.code}</span>
        <span className="muted">已等待 {formatSince(wait.since, now)}</span>
      </div>
      <p className="muted">{waitReasonLabel(wait.code)}</p>
      <p className="hint">{wait.detail}</p>
      {wait.blocking.length === 0 ? null : (
        <p className="muted">
          {wait.kind === 'CAPACITY' ? '占用槽位' : '占用冲突范围'}：
          {wait.blocking.map((id) => taskTag(id, tasks)).join('、')}
        </p>
      )}
      {wait.reasonCodes.length === 0 ? null : (
        <ul className="list">
          {wait.reasonCodes.map((code) => (
            <li key={code} className="muted"><span className="mono">{code}</span> {waitReasonLabel(code)}</li>
          ))}
        </ul>
      )}
      <HitList hits={wait.hits} tasks={tasks} />
    </div>
  );
}

/** The assessment a decision was made from, including the exact binding an `UNKNOWN` release uses. */
export function AssessmentBlock({ assessment, tasks }: {
  readonly assessment: ScheduleAssessmentView;
  readonly tasks: readonly TaskView[];
}) {
  return (
    <div className="assessment-block">
      <div className="row-head">
        <span className={verdictStateClass(assessment.verdict)}>{verdictLabel(assessment.verdict)}</span>
        <span className="muted hint">分析器 {assessment.analyzerVersion} · 映射 {assessment.policyVersion}</span>
      </div>
      <dl className="kv">
        <dt>被评估的 revision</dt>
        <dd className="mono">{assessment.revisionId}</dd>
        <dt>基线 commit</dt>
        <dd className="mono">{assessment.baseCommit}</dd>
        <dt>候选快照</dt>
        <dd>
          <span className="mono">{assessment.candidateSnapshotId ?? '无'}</span>
          {' · '}{assessment.candidateComplete ? '完整' : '不完整'}
          {assessment.candidateIncompleteReasons.length === 0 ? null : (
            <ul className="list">
              {assessment.candidateIncompleteReasons.map((code) => (
                <li key={code} className="muted">
                  <span className="mono">{code}</span> {impactIncompleteReasonLabel(code)}
                  {'（complete=false：证据不完整，不再决定判定）'}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>对比过的任务</dt>
        <dd>{assessment.comparedTaskIds.length === 0 ? '没有活跃任务可对比'
          : assessment.comparedTaskIds.map((id) => taskTag(id, tasks)).join('、')}</dd>
        <dt>活跃集合</dt>
        <dd>{assessment.activeTaskIds.length === 0 ? '空'
          : assessment.activeTaskIds.map((id) => taskTag(id, tasks)).join('、')}</dd>
      </dl>
      {assessment.reasonCodes.length === 0 ? null : (
        <ul className="list">
          {assessment.reasonCodes.map((code) => (
            <li key={code} className="muted"><span className="mono">{code}</span> {waitReasonLabel(code)}</li>
          ))}
        </ul>
      )}
      {assessment.explanation.length === 0 ? null : (
        <ul className="list">
          {assessment.explanation.map((line, index) => (
            <li key={`${String(index)}-${line.slice(0, 24)}`} className="muted hint">{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The capacity facts and who holds each slot; `limitSource` explains where a limit came from.
 *
 * `scope` is not decoration. ADR-0061 D01 makes the limit a **Runtime-global** one and the card is
 * titled accordingly, but this build's capacity command面 is still project-scoped (schema v34's other
 * half owns the global command). Rather than printing project numbers under a global heading, the
 * table says which scope it is showing and the panel explains why — a card that silently relabelled
 * project numbers as host-wide would be a false statement about what the machine is doing.
 */
export function CapacityTable({ capacity, tasks, now, scope = 'PROJECT' }: {
  readonly capacity: ProjectCapacityView;
  readonly tasks: readonly TaskView[];
  readonly now: number;
  readonly scope?: 'PROJECT' | 'GLOBAL';
}) {
  return (
    <div data-capacity-scope={scope}>
      {capacity.draining ? (
        <div className="banner error" role="status">
          <div>
            <strong>Runtime 正在排水：拒绝新的预留</strong>
            <div className="hint">{capacity.drainReason ?? '未记录原因'}</div>
          </div>
        </div>
      ) : null}
      <div className="table-scroll"><table>
        <thead>
          <tr><th>范围</th><th>上限</th><th>来源</th><th>已用</th><th>可用</th><th>现在获取会得到</th></tr>
        </thead>
        <tbody>
          <tr data-capacity-row={scope === 'GLOBAL' ? 'runtime-global' : 'project'}>
            <td>{scope === 'GLOBAL' ? 'Runtime 全局' : '项目内（本次构建的容量命令面）'}</td>
            <td>{capacity.globalLimit}</td>
            <td>{capacityLimitSourceLabel(capacity.globalLimitSource)}</td>
            <td>{capacity.globalUsed}</td>
            <td>{capacity.globalAvailable}</td>
            <td>{capacity.globalWaitReason === null ? <span className="state state-ready">可以获取</span>
              : <span className="state state-waiting">
                  {capacityWaitReasonLabel(capacity.globalWaitReason)}</span>}</td>
          </tr>
          {capacity.adapters.map((adapter) => (
            <tr key={adapter.adapterId}>
              <td>adapter <span className="mono">{adapter.adapterId}</span></td>
              <td>{adapter.limit}</td>
              <td>{capacityLimitSourceLabel(adapter.limitSource)}
                {adapter.limitSource === 'DEFAULT' ? <div className="muted hint">跟随全局上限</div> : null}</td>
              <td>{adapter.used}</td>
              <td>{adapter.available}</td>
              <td>{adapter.waitReason === null ? <span className="state state-ready">可以获取</span>
                : <span className="state state-waiting">
                    {capacityWaitReasonLabel(adapter.waitReason)}</span>}</td>
            </tr>
          ))}
          {capacity.adapters.length === 0 ? (
            <tr><td colSpan={6} className="muted">没有已注册的 adapter。</td></tr>
          ) : null}
        </tbody>
      </table></div>
      <p className="muted hint">
        配置版本 v{capacity.configVersion}
        {capacity.updatedAt === null ? ' · 从未显式设置'
          : ` · 最后修改 ${new Date(capacity.updatedAt).toLocaleString('zh-CN')}（${capacity.updatedBy ?? '—'}）`}
        {capacity.globalUsed > capacity.globalLimit
          ? ' · 已用大于上限：降低上限不会释放已持有的槽位，事实如实显示' : ''}
      </p>
      <h4>当前占用者</h4>
      {capacity.occupants.length === 0 ? <p className="muted">没有任何任务占用槽位。</p> : (
        <ul className="list">
          {capacity.occupants.map((occupant) => (
            <li key={occupant.taskId} className="muted">
              {taskTag(occupant.taskId, tasks)} · adapter <span className="mono">{occupant.adapterId}</span>
              {' · 自 '}{formatSince(occupant.since, now)}
              {occupant.reservationId === null ? null
                : <> · 预留 <span className="mono">{shortId(occupant.reservationId)}</span></>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A compact one-line capacity summary, so a panel can avoid repeating the whole table. */
export function capacityLine(capacity: ProjectCapacityView): string {
  const parts = [`全局 ${capacity.globalUsed}/${capacity.globalLimit}`
    + `（${capacityLimitSourceLabel(capacity.globalLimitSource)}）`];
  for (const adapter of capacity.adapters) {
    parts.push(`${adapter.adapterId} ${adapter.used}/${adapter.limit}`
      + `（${capacityLimitSourceLabel(adapter.limitSource)}）`);
  }
  return parts.join(' · ');
}

/* ------------------------------------------------------------------------------------------------
 * `task schedule status|plan|run` — the scheduling engine's ordered walk.
 * ---------------------------------------------------------------------------------------------- */

function CandidateCard({ candidate, tasks, now }: {
  readonly candidate: ScheduleCandidateView;
  readonly tasks: readonly TaskView[];
  readonly now: number;
}) {
  return (
    <li className="card nested">
      <div className="row-head">
        <TaskTag taskId={candidate.taskId} tasks={tasks} />
        <span className="muted">优先级 {candidate.priority}</span>
        <span className="muted">{runtimeStateLabel(candidate.taskState)} · 任务版本 v{candidate.taskVersion}</span>
        <span className={dispositionStateClass(candidate.disposition)}>
          {dispositionLabel(candidate.disposition)}</span>
        {candidate.clearedUnknownBy === null ? null
          : <span className="state state-unknown">由单次放行允许</span>}
      </div>
      <p className="muted hint">{candidate.detail}</p>
      <p className="muted hint">
        revision <span className="mono">{shortId(candidate.revisionId)}</span> · adapter
        {' '}<span className="mono">{candidate.adapterId}</span> · 创建于
        {' '}{new Date(candidate.createdAt).toLocaleString('zh-CN')}
      </p>
      {candidate.wait === null ? null : <WaitBlock wait={candidate.wait} tasks={tasks} now={now} />}
      {candidate.blockedReasons.length === 0 ? null : (
        <div>
          <span className="eyebrow">依赖未满足（BLOCKED 的唯一含义）</span>
          <ul className="list">
            {candidate.blockedReasons.map((reason, index) => (
              <li key={`${reason.code}-${String(index)}`} className="muted">
                <span className="mono">{reason.code}</span> {dependencyBlockReasonLabel(reason.code)}
                {' · 前置 '}{taskTag(reason.prerequisiteTaskId, tasks)}
                {' · revision '}<span className="mono">{shortId(reason.requiredRevisionId)}</span>
                {reason.detail === null ? null : <div className="hint">{reason.detail}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {candidate.assessment === null ? null
        : <AssessmentBlock assessment={candidate.assessment} tasks={tasks} />}
      {candidate.started === null ? null : (
        <p className="muted">
          已启动：执行 <span className="mono">{shortId(candidate.started.executionId)}</span> · 会话
          {' '}<span className="mono">{shortId(candidate.started.sessionId)}</span> · 预留
          {' '}<span className="mono">{shortId(candidate.started.reservationId)}</span> · 基线
          {' '}<span className="mono">{shortId(candidate.started.baseCommit)}</span>
        </p>
      )}
    </li>
  );
}

/** The project-level scheduling view: active set, ordered candidates, and an explicit tick request. */
export function SchedulePanel({ client, projectId, tasks, refreshToken, run }: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  readonly tasks: readonly TaskView[];
  readonly refreshToken: number;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [overview, setOverview] = useState<ScheduleOverviewView | null>(null);
  const [plan, setPlan] = useState<ScheduleOverviewView | null>(null);
  const [tick, setTick] = useState<ScheduleTickReportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyActionable, setOnlyActionable] = useState(false);
  const now = useNow(30_000);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await client.command<ScheduleOverviewView>({
        command: 'task.schedule.status', projectId,
      });
      setOverview(next);
      // A refreshed status invalidates any previously shown dry run: an old plan must never be left
      // on screen as if it described the current active set.
      setPlan(null);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [client, projectId]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const shown = plan ?? overview;
  const candidates = shown?.candidates ?? [];
  const waiting = candidates.filter((candidate) => candidate.disposition === 'WAITING');
  const blocked = candidates.filter((candidate) => candidate.disposition === 'BLOCKED');
  const starting = candidates.filter((candidate) =>
    candidate.disposition === 'WOULD_START' || candidate.disposition === 'STARTED');
  const visible = onlyActionable
    ? candidates.filter((candidate) => candidate.disposition !== 'SKIPPED')
    : candidates;

  return (
    <section className="schedule-panel">
      <h4>调度引擎 <span className="muted hint">只读投影 + 一次显式 tick · ADR-0030/FOUNDATION-055</span></h4>
      <p className="muted hint">
        Runtime 自己会按事件与周期 tick 驱动调度。这里显示它的候选顺序与判定；
        「触发一次调度」只是请求一次与自动 tick 完全相同的循环，不改变判定规则。
        冲突等待与容量等待都不是 BLOCKED；BLOCKED 只表示依赖未满足。
      </p>

      {error === null ? null : <p className="error" role="alert">调度状态读取失败：{error}</p>}

      <div className="actions">
        <button type="button" onClick={() => { void run('正在刷新调度状态', load); }}>刷新状态</button>
        <button type="button" disabled={overview === null} onClick={() => {
          void run('正在生成调度计划（dry run）', async () => {
            try {
              setPlan(await client.command<ScheduleOverviewView>({
                command: 'task.schedule.plan', projectId,
              }));
            } catch (caught) {
              setError(describeError(caught));
            }
          });
        }}>查看计划（dry run）</button>
        {plan === null ? null : (
          <button type="button" onClick={() => { setPlan(null); }}>回到 status 视角</button>
        )}
        <button type="button" className="primary" onClick={() => {
          void run('正在触发一次调度 tick', async () => {
            setTick(await client.command<ScheduleTickReportView>({
              command: 'task.schedule.run', commandId: crypto.randomUUID(), projectId,
            }));
            await load();
          });
        }}>触发一次调度（task schedule run）</button>
      </div>

      {shown === null ? <p className="muted" role="status">正在读取调度状态…</p> : (
        <>
          {plan === null ? null : (
            <div className="banner notice" role="status">
              <div>
                <strong>这是 dry run（task schedule plan）</strong>
                <div className="hint">它不预留、不启动、不改变任何状态；显示的是「若现在跑会怎样」。</div>
              </div>
            </div>
          )}
          <div className="table-scroll"><table>
            <thead><tr><th>adapter</th><th>调度循环</th><th>draining</th><th>最近一次 tick</th><th>容量</th></tr></thead>
            <tbody>
              <tr>
                <td className="mono">{shown.adapterId}</td>
                <td>{shown.running ? 'Runtime 内的 tick 循环正在运行' : '没有常驻 tick 循环（事件与请求仍会触发）'}</td>
                <td>{shown.draining ? <span className="state state-failed">正在排水</span> : '否'}</td>
                <td>{shown.lastTick === null ? '还没有 tick 记录' : (
                  <>
                    <span className="mono">{shown.lastTick.trigger}</span>
                    <div className="muted">{new Date(shown.lastTick.completedAt).toLocaleString('zh-CN')}</div>
                  </>
                )}</td>
                <td className="hint">{capacityLine(shown.capacity)}</td>
              </tr>
            </tbody>
          </table></div>

          <h4>活跃集合 <span className="muted hint">占用槽位或正在运行，不会因心跳过期或 UI 关闭而释放</span></h4>
          {shown.active.length === 0 ? <p className="muted">没有活跃任务。</p> : (
            <div className="table-scroll"><table>
              <thead><tr><th>任务</th><th>任务状态</th><th>执行状态</th><th>adapter</th><th>预留</th><th>已运行</th></tr></thead>
              <tbody>
                {shown.active.map((entry) => (
                  <tr key={entry.taskId}>
                    <td><TaskTag taskId={entry.taskId} tasks={tasks} /></td>
                    <td>{runtimeStateLabel(entry.taskState)}</td>
                    <td>{runtimeStateLabel(entry.executionState)}</td>
                    <td className="mono">{entry.adapterId}</td>
                    <td className="mono">{entry.reservationId === null ? '—' : shortId(entry.reservationId)}</td>
                    <td>{formatSince(entry.since, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}

          <h4>候选顺序 <span className="muted hint">优先级降序，其次创建时间；提优先级不抢占</span></h4>
          <div className="actions">
            <span className="muted">
              {starting.length} 个现在会启动 · {waiting.length} 个等待（冲突
              {' '}{waiting.filter((candidate) => candidate.wait?.kind === 'CONFLICT').length} / 容量
              {' '}{waiting.filter((candidate) => candidate.wait?.kind === 'CAPACITY').length}）·
              {' '}{blocked.length} 个依赖未满足
            </span>
            <label className="inline">
              <input type="checkbox" checked={onlyActionable}
                onChange={(event) => setOnlyActionable(event.target.checked)} />
              只看会启动/等待/阻塞的候选
            </label>
          </div>
          {visible.length === 0 ? <p className="muted">没有候选任务。</p> : (
            <ul className="list candidate-list">
              {visible.map((candidate) => (
                <CandidateCard key={candidate.taskId} candidate={candidate} tasks={tasks} now={now} />
              ))}
            </ul>
          )}

          <h4>实际影响超出预测 <span className="muted hint">scheduler.md §4：记录增长并请求安全暂停</span></h4>
          {shown.impactGrowth.length === 0 ? <p className="muted">没有记录到增长。</p> : (
            <ul className="list">
              {shown.impactGrowth.map((growth) => (
                <li key={`${growth.taskId}-${growth.snapshotId}`} className="muted">
                  {taskTag(growth.taskId, tasks)}：新增 {growth.addedPaths.length} 个路径、移除
                  {' '}{growth.removedPaths.length} 个；与 {growth.conflictingTaskIds.length} 个活跃任务冲突；
                  {' '}reason <span className="mono">{growth.reasonCodes.join('、') || '—'}</span>
                  {' · '}已请求暂停：{growth.pauseRequested ? (growth.pauseOutcome ?? '已请求') : '未请求'}
                  <div className="hint">{growth.detail}</div>
                </li>
              ))}
            </ul>
          )}

          {tick === null ? null : (
            <section className="card nested">
              <h4>最近一次显式 tick · <span className="mono">{shortId(tick.tickId)}</span></h4>
              <p className="muted hint">
                trigger <span className="mono">{tick.trigger}</span> ·
                {' '}{new Date(tick.startedAt).toLocaleTimeString('zh-CN')} → {new Date(tick.completedAt).toLocaleTimeString('zh-CN')}
                {tick.coalesced ? ' · 与已在运行的 tick 合并（没有启动第二次）' : ''}
                {tick.draining ? ' · 期间 Runtime 排水：未做任何预留' : ''}
              </p>
              {tick.projects.length === 0 ? <p className="muted">这次 tick 没有处理任何项目。</p> : (
                <ul className="list">
                  {tick.projects.filter((project) => project.projectId === projectId)
                    .flatMap((project) => project.candidates.map((candidate) => (
                      <li key={candidate.taskId} className="muted">
                        {taskTag(candidate.taskId, tasks)} → {dispositionLabel(candidate.disposition)}
                        {candidate.wait === null ? '' : `（${waitKindLabel(candidate.wait.kind)}：${candidate.wait.code}）`}
                      </li>
                    )))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}

/** A Task id rendered as `#n` when known. */
function TaskTag({ taskId, tasks }: {
  readonly taskId: string;
  readonly tasks: readonly TaskView[];
}) {
  return <span className="task-number" title={taskId}>{taskTag(taskId, tasks)}</span>;
}

/* ------------------------------------------------------------------------------------------------
 * `task schedule explain` — why one Task is not running now, and the explicit UNKNOWN release.
 * ---------------------------------------------------------------------------------------------- */

export function ScheduleExplainPanel({ client, projectId, taskId, tasks, refreshToken, run }: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  readonly taskId: string;
  readonly tasks: readonly TaskView[];
  readonly refreshToken: number;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [view, setView] = useState<ScheduleExplanationView | null>(null);
  const [release, setRelease] = useState<ScheduleUnknownReleaseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(30_000);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await client.command<ScheduleExplanationView>({
        command: 'task.schedule.explain', projectId, taskId,
      });
      setView(next);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [client, projectId, taskId]);

  useEffect(() => {
    setRelease(null);
    void load();
  }, [load, refreshToken]);

  const assessment = view?.assessment ?? null;
  const canRelease = assessment !== null && assessment.verdict === 'UNKNOWN'
    && view?.unknownRelease === null;

  return (
    <section className="schedule-explain-panel">
      <h4>调度判定 <span className="muted hint">task schedule explain · 只读，不启动任何东西</span></h4>
      <p className="muted hint">
        回答「这个任务为什么没在跑」。冲突等待与容量等待分开显示；BLOCKED 只表示依赖未满足。
      </p>
      {error === null ? null : <p className="error" role="alert">调度判定读取失败：{error}</p>}
      {view === null ? <p className="muted" role="status">正在读取调度判定…</p> : (
        <>
          <div className="row-head">
            <span className={decisionStateClass(view.decision)}>{decisionLabel(view.decision)}</span>
            <span className="muted">{runtimeStateLabel(view.taskState)} · 候选：{view.candidate ? '是' : '否'}</span>
            <span className="muted">adapter <span className="mono">{view.adapterId}</span></span>
            <button type="button" onClick={() => { void run('正在刷新调度判定', load); }}>刷新</button>
          </div>
          <p className="muted">{view.detail}</p>

          {view.wait === null ? null : <WaitBlock wait={view.wait} tasks={tasks} now={now} />}

          {view.blockedReasons.length === 0 ? null : (
            <ul className="list">
              {view.blockedReasons.map((reason, index) => (
                <li key={`${reason.code}-${String(index)}`} className="muted">
                  <span className="mono">{reason.code}</span> {dependencyBlockReasonLabel(reason.code)}
                  {' · 前置 '}{taskTag(reason.prerequisiteTaskId, tasks)}
                  {reason.detail === null ? null : <div className="hint">{reason.detail}</div>}
                </li>
              ))}
            </ul>
          )}

          {assessment === null ? (
            <p className="muted">
              没有可用的评估记录（这个任务目前不是调度候选，或没有活跃任务可对比）；
              这不是「没有冲突」，而是「没有可评估的证据」。
            </p>
          ) : <AssessmentBlock assessment={assessment} tasks={tasks} />}

          {view.unknownRelease === null ? null : (
            <div className="banner notice">
              <div>
                <strong>当前存在有效的单次放行</strong>
                <div className="hint">
                  放行 id <span className="mono">{shortId(view.unknownRelease.releaseId)}</span> ·
                  绑定 revision <span className="mono">{shortId(view.unknownRelease.revisionId)}</span> ·
                  analyzer <span className="mono">{view.unknownRelease.analyzerVersion}</span> ·
                  policy <span className="mono">{view.unknownRelease.policyVersion}</span>
                  {' · '}放行人 {view.unknownRelease.releasedBy} ·
                  {' '}{new Date(view.unknownRelease.releasedAt).toLocaleString('zh-CN')} ·
                  {view.unknownRelease.consumed ? ' 已被一次启动消费' : ' 尚未被消费'}
                  <div>
                    <strong>放行不改变判定记录：该次 assessment 仍然是 UNKNOWN。</strong>
                    放行是独立事实，不等于 SAFE，也不构成「已证明不冲突」的证据。
                  </div>
                </div>
              </div>
            </div>
          )}

          {view.explanation.length === 0 ? null : (
            <details>
              <summary className="muted">判定解释（{view.explanation.length} 行，Runtime 原文）</summary>
              <ul className="list">
                {view.explanation.map((line, index) => (
                  <li key={`${String(index)}-${line.slice(0, 24)}`} className="muted hint">{line}</li>
                ))}
              </ul>
            </details>
          )}

          <h4>UNKNOWN 的显式单次放行 <span className="muted hint">ADR-0030 D05</span></h4>
          {assessment === null ? <p className="muted">没有评估，无法放行。</p> : (
            <>
              <p className="hint">
                <strong>风险由放行方承担：</strong>分析器无法事先证明两个 Agent 永不越界。
                放行后 Runtime 不做额外隔离；若两者越界，责任在放行的人。
                放行<strong>不改变</strong>判定记录：该次 assessment 仍是
                {' '}<span className="mono">UNKNOWN</span>（不是 SAFE），只是允许它在 UNKNOWN 下启动。
              </p>
              <dl className="kv">
                <dt>绑定的 revision</dt><dd className="mono">{assessment.revisionId}</dd>
                <dt>绑定的基线</dt><dd className="mono">{assessment.baseCommit}</dd>
                <dt>绑定的评估版本</dt>
                <dd className="mono">{assessment.analyzerVersion} · {assessment.policyVersion}</dd>
                <dt>放行后失效条件</dt>
                <dd>任务修订、基线变化、映射/分析器/策略版本变化、实际 diff 超出预测</dd>
              </dl>
              <div className="actions">
                <button
                  type="button"
                  className="danger"
                  disabled={busy || !canRelease}
                  title={canRelease
                    ? '记录一次绑定上述 revision 与评估版本的单次放行；它不启动任务'
                    : '当前判定不是 UNKNOWN，或已存在有效放行'}
                  onClick={() => {
                    setBusy(true);
                    void run('正在记录单次放行', async () => {
                      try {
                        setRelease(await client.command<ScheduleUnknownReleaseView>({
                          command: 'task.schedule.clearUnknown',
                          commandId: crypto.randomUUID(),
                          projectId,
                          taskId,
                        }));
                        await load();
                      } finally {
                        setBusy(false);
                      }
                    });
                  }}
                >
                  记录单次放行（task schedule clear-unknown）
                </button>
              </div>
              {release === null ? null : (
                <p className="muted">
                  结果：<span className="mono">{release.state}</span>
                  {' · '}recorded {release.recorded ? '是' : '否'}
                  {' · '}判定仍是 <span className="mono">{release.verdict}</span>
                  {' · '}reason {release.reasonCodes.join('、') || '—'}
                  <div className="hint">{release.detail}</div>
                </p>
              )}
              <p className="muted hint">
                放行只写审计记录；是否真的启动仍由调度决定（在「调度」标签触发一次 tick，或等自动 tick）。
              </p>
            </>
          )}

          <p className="muted hint">容量：{capacityLine(view.capacity)}</p>
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------
 * `scheduler capacity get|set|clear` and `scheduler reservations list|get|release|reconcile`.
 * ---------------------------------------------------------------------------------------------- */

export function CapacityPanel({ client, projectId, tasks, refreshToken, run }: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  readonly tasks: readonly TaskView[];
  readonly refreshToken: number;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [capacity, setCapacity] = useState<ProjectCapacityView | null>(null);
  const [reservations, setReservations] = useState<readonly SlotReservationView[] | null>(null);
  const [includeReleased, setIncludeReleased] = useState(false);
  const [detail, setDetail] = useState<SlotReservationDetailView | null>(null);
  const [reconcile, setReconcile] = useState<SlotReservationReconcileReportView | null>(null);
  const [releaseResult, setReleaseResult] = useState<SlotReservationReleaseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limitInput, setLimitInput] = useState('2');
  const [limitScope, setLimitScope] = useState('');
  const [releaseReasons, setReleaseReasons] = useState<Record<string, string>>({});
  const now = useNow(30_000);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [nextCapacity, listed] = await Promise.all([
        client.command<ProjectCapacityView>({ command: 'scheduler.capacity.get', projectId }),
        client.command<SlotReservationListView>({
          command: 'scheduler.reservations.list', projectId, includeReleased,
        }),
      ]);
      setCapacity(nextCapacity);
      setReservations(listed.reservations);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [client, projectId, includeReleased]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  return (
    <section className="capacity-panel">
      <h4>
        Runtime 全局容量
        <span className="muted hint">scheduler capacity / reservations · ADR-0032，目标语义 ADR-0061 D01–D03</span>
      </h4>
      <p className="muted hint" data-capacity-scope-note="PROJECT">
        ADR-0061 D01 的目标是**整个 Runtime 只有一个上限**、并列出跨项目占用者。本次构建里
        `scheduler capacity get` 仍是项目级的，所以下面的数字与占用者都是**当前项目**的；本卡片只投影该
        命令返回的字段，不在 UI 里发明全局字段。当全局容量命令面（schema v34 的另一半）合入后，
        同一张卡片改为读取它并把 `scope` 传成 `GLOBAL`，数字即为跨项目全局值。
      </p>
      <p className="muted hint">
        容量等待不是 BLOCKED；降低上限不会释放已持有的槽位。
        释放必须给出原因，且不会因心跳过期或客户端消失自动发生。
      </p>
      {error === null ? null : <p className="error" role="alert">容量读取失败：{error}</p>}
      {capacity === null ? <p className="muted" role="status">正在读取容量…</p> : (
        <>
          <CapacityTable capacity={capacity} tasks={tasks} now={now} />

          <h4>显式设置上限</h4>
          <p className="muted hint">
            非法值会被拒绝并给出稳定错误码（CAPACITY_LIMIT_INVALID / CAPACITY_LIMIT_OUT_OF_RANGE /
            UNKNOWN_ADAPTER），不会被静默夹取；上限范围 1–16。
          </p>
          <div className="actions">
            <label className="inline">
              范围
              <select value={limitScope} onChange={(event) => setLimitScope(event.target.value)}>
                <option value="">项目全局</option>
                {(capacity?.adapters ?? []).map((adapter) => (
                  <option key={adapter.adapterId} value={adapter.adapterId}>adapter {adapter.adapterId}</option>
                ))}
              </select>
            </label>
            <input
              aria-label="并发上限"
              inputMode="numeric"
              value={limitInput}
              onChange={(event) => setLimitInput(event.target.value)}
            />
            <button type="button" disabled={limitInput.trim().length === 0} onClick={() => {
              void run('正在设置容量上限', async () => {
                // The input is passed through untouched: this client must never clamp a typo into a
                // plausible limit, so the Runtime's stable refusal code reaches the user.
                const limit = Number(limitInput.trim());
                try {
                  await client.command({
                    command: 'scheduler.capacity.set',
                    commandId: crypto.randomUUID(),
                    projectId,
                    limit,
                    ...(limitScope === '' ? {} : { adapterId: limitScope }),
                  });
                  await load();
                } catch (caught) {
                  setError(describeError(caught));
                }
              });
            }}>设置上限（scheduler capacity set）</button>
            <button type="button" disabled={limitScope === ''} title="只有显式设置过的 adapter 覆写才能清除" onClick={() => {
              void run('正在清除 adapter 覆写', async () => {
                try {
                  await client.command({
                    command: 'scheduler.capacity.clear',
                    commandId: crypto.randomUUID(),
                    projectId,
                    adapterId: limitScope,
                  });
                  await load();
                } catch (caught) {
                  setError(describeError(caught));
                }
              });
            }}>清除该 adapter 覆写（capacity clear）</button>
          </div>

          <h4>槽位预留</h4>
          <div className="actions">
            <button type="button" onClick={() => { void run('正在刷新预留', load); }}>刷新</button>
            <label className="inline">
              <input type="checkbox" checked={includeReleased}
                onChange={(event) => setIncludeReleased(event.target.checked)} />
              包含已释放
            </label>
            <button type="button" onClick={() => {
              void run('正在执行 reconcile', async () => {
                try {
                  setReconcile(await client.command<SlotReservationReconcileReportView>({
                    command: 'scheduler.reservations.reconcile',
                    commandId: crypto.randomUUID(),
                    projectId,
                  }));
                  await load();
                } catch (caught) {
                  setError(describeError(caught));
                }
              });
            }}>执行 reconcile（scheduler reservations reconcile）</button>
          </div>
          <p className="muted hint">
            reconcile 只读真实进程表：已死 → 释放；仍存活 → 保持占用；无法核验 → RECOVERY_REQUIRED。
            它不发信号、不杀进程、不删资源、不声称静止。
          </p>
          <p className="muted hint">
            注意：Task 启动后，槽位由预留**移交**给该 Execution（预留记 EXPLICIT 释放，理由写明
            “execution … now holds the Task resource”），占用靠 Execution 的 <span className="mono">resource_held</span>
            继续计入容量。因此“没有活跃预留而任务在跑”是正常事实，不是预留丢失：打开
            “包含已释放”可以看到这次移交。
          </p>

          {reconcile === null ? null : (
            <section className="card nested">
              <h4>reconcile 观测 <span className="mono hint">boot {shortId(reconcile.bootId)}</span></h4>
              {reconcile.outcomes.length === 0 ? <p className="muted">没有需要处理的预留。</p> : (
                <div className="table-scroll"><table>
                  <thead><tr><th>预留</th><th>任务</th><th>观测</th><th>判定</th><th>状态</th><th>说明</th></tr></thead>
                  <tbody>
                    {reconcile.outcomes.map((outcome) => (
                      <tr key={outcome.reservationId}>
                        <td className="mono">{shortId(outcome.reservationId)}</td>
                        <td>{taskTag(outcome.taskId, tasks)}</td>
                        <td>{outcome.observation === null ? '—'
                          : holderObservationLabel(outcome.observation)}</td>
                        <td>{reconcileOutcomeLabel(outcome.outcome)}</td>
                        <td>{runtimeStateLabel(outcome.previousState)} → {runtimeStateLabel(outcome.state)}</td>
                        <td className="hint">{outcome.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
              <p className="muted hint">
                本次没有向任何进程发信号；记录的进程：{reconcile.notSignalled.length === 0 ? '无'
                  : reconcile.notSignalled.map((entry) => `${shortId(entry.reservationId)} pid ${entry.pid}`).join('、')}
              </p>
            </section>
          )}

          {reservations === null ? <p className="muted" role="status">正在读取预留…</p>
            : reservations.length === 0 ? (
              <p className="muted">{includeReleased ? '没有预留记录。'
                : '没有活跃预留（已启动的任务由 Execution 持有槽位；勾选“包含已释放”查看预留移交）。'}</p>
            ) : (
              <div className="table-scroll"><table>
                <thead>
                  <tr><th>任务</th><th>状态</th><th>adapter</th><th>版本</th><th>工作区</th>
                    <th>评估基线</th><th>预留在</th><th>持有者证据</th><th>释放</th><th /></tr>
                </thead>
                <tbody>
                  {reservations.map((reservation) => (
                    <tr key={reservation.reservationId}>
                      <td>{taskTag(reservation.taskId, tasks)}
                        <div className="muted hint">任务 v{reservation.taskVersion} · revision
                          {' '}<span className="mono">{shortId(reservation.revisionId)}</span></div></td>
                      <td><span className={reservationStateClass(reservation.state)}>
                        {reservationStateLabel(reservation.state)}</span>
                        <div className="muted hint">预留 v{reservation.version}</div></td>
                      <td className="mono">{reservation.adapterId}</td>
                      <td className="mono">{shortId(reservation.reservationId)}</td>
                      <td className="mono">{reservation.workspaceId === null ? '未绑定'
                        : shortId(reservation.workspaceId)}</td>
                      <td className="mono">{shortId(reservation.assessedDevCommit)}</td>
                      <td>{new Date(reservation.reservedAt).toLocaleString('zh-CN')}
                        <div className="muted hint">已持有 {formatSince(reservation.reservedAt, now)}</div></td>
                      <td className="hint">
                        boot <span className="mono">{shortId(reservation.holder.bootId)}</span> ·
                        pid {reservation.holder.pid} ·
                        startToken {reservation.holder.startToken === null
                          ? '（OS 未提供，如实记录 null）' : <span className="mono">{reservation.holder.startToken}</span>}
                        <div className="muted">actor {reservation.holder.actor}</div>
                      </td>
                      <td className="hint">
                        {reservation.releasedAt === null ? '—' : (
                          <>
                            {new Date(reservation.releasedAt).toLocaleString('zh-CN')}
                            {reservation.releaseKind === null ? null
                              : <div>{reservationReleaseKindLabel(reservation.releaseKind)}</div>}
                            {reservation.releaseObservation === null ? null
                              : <div className="muted">{holderObservationLabel(reservation.releaseObservation)}</div>}
                            {reservation.releaseReason === null ? null
                              : <div className="muted">原因：{reservation.releaseReason}</div>}
                          </>
                        )}
                      </td>
                      <td>
                        <button type="button" onClick={() => {
                          void run('正在读取预留详情', async () => {
                            try {
                              setDetail(await client.command<SlotReservationDetailView>({
                                command: 'scheduler.reservations.get',
                                projectId,
                                reservationId: reservation.reservationId,
                              }));
                            } catch (caught) {
                              setError(describeError(caught));
                            }
                          });
                        }}>详情</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}

          {detail === null ? null : (
            <section className="card nested">
              <div className="section-heading">
                <h4>预留 <span className="mono">{shortId(detail.reservationId)}</span> · 审计历史</h4>
                <button type="button" onClick={() => { setDetail(null); }}>关闭</button>
              </div>
              <p className="muted hint">
                {reservationStateLabel(detail.state)} · 依赖指纹
                {' '}<span className="mono">{detail.dependencyFingerprint.slice(0, 12)}</span> ·
                影响快照 <span className="mono">{shortId(detail.impactSnapshotId)}</span>
                {detail.detail === null ? null : <div>{detail.detail}</div>}
              </p>
              <ol className="list">
                {detail.events.map((event) => (
                  <li key={event.sequence} className="muted">
                    <span className="mono">#{event.sequence}</span> <span className="mono">{event.kind}</span>
                    {' · '}{new Date(event.occurredAt).toLocaleString('zh-CN')} · {event.actor}
                    <div className="hint">{event.detail}</div>
                    <details><summary className="hint">证据</summary>
                      <pre>{JSON.stringify(event.evidence, null, 2)}</pre></details>
                  </li>
                ))}
              </ol>
              {detail.state === 'RELEASED' ? null : (
                <div className="actions">
                  <input
                    aria-label="释放原因"
                    value={releaseReasons[detail.reservationId] ?? ''}
                    placeholder="释放原因（必填，写入审计）"
                    onChange={(event) => setReleaseReasons({
                      ...releaseReasons, [detail.reservationId]: event.target.value,
                    })}
                  />
                  <button type="button" className="danger"
                    disabled={(releaseReasons[detail.reservationId] ?? '').trim().length === 0}
                    title="显式释放；可证明仍存活的持有者会被拒绝（SLOT_HOLDER_STILL_RUNNING）"
                    onClick={() => {
                      const reason = (releaseReasons[detail.reservationId] ?? '').trim();
                      void run('正在释放预留', async () => {
                        try {
                          setReleaseResult(await client.command<SlotReservationReleaseView>({
                            command: 'scheduler.reservations.release',
                            commandId: crypto.randomUUID(),
                            projectId,
                            reservationId: detail.reservationId,
                            reason,
                          }));
                          setDetail(null);
                          await load();
                        } catch (caught) {
                          setError(describeError(caught));
                        }
                      });
                    }}>释放预留（需原因）</button>
                </div>
              )}
            </section>
          )}

          {releaseResult === null ? null : (
            <p className="muted">
              释放结果：<span className="mono">{releaseResult.outcome}</span>
              （released {releaseResult.released ? '是' : '否'}）
              {releaseResult.schedule === null ? null
                : ` · 释放后已请求一次调度 tick（${releaseResult.schedule.trigger}）`}
            </p>
          )}
        </>
      )}
    </section>
  );
}
