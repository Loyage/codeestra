import type { RuntimeGlobalControlView, RuntimePauseTargetView } from './types.js';

/**
 * The Runtime global load control panel (FOUNDATION-097 / ADR-0061 D09).
 *
 * It is a **projection of the command face**, never a second source of truth: every field it renders
 * comes from `scheduler control status|pause|resume|reconcile`, and it holds no local allow-list that
 * could hide or disable a control the Runtime would accept. When the Runtime refuses something, the
 * stable code and one local sentence are shown; the button stays where it is.
 *
 * The whole point of the design is visible in what this component refuses to do: it never reduces the
 * control state to an optimistic boolean. While the state is `PAUSING`, `RESUMING` or
 * `RECOVERY_REQUIRED`, the panel lists **every target** with its own state, identity verdict and
 * process state, because "the button was pressed" is not "every process is stopped".
 *
 * The panel is intentionally a pure function of its props: the App owns the client and the polling,
 * so a static render of the panel is exactly the state the Runtime reported.
 */

export interface GlobalControlPanelProps {
  readonly view: RuntimeGlobalControlView | null;
  readonly loading: boolean;
  readonly busy: boolean;
  /** The last refusal, as the Runtime reported it (a stable code plus its message). */
  readonly error: { readonly code: string; readonly message: string } | null;
  /** The command result that is being acted on, so a stale view is never shown as current. */
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onReconcile: () => void;
}

const stateLabels: Readonly<Record<string, string>> = {
  RUNNING: '运行中',
  PAUSING: '正在暂停',
  PAUSED: '已暂停（全部目标已核验停止）',
  RESUMING: '正在继续',
  RECOVERY_REQUIRED: '需要人工处置（屏障保持）',
};

/** The one local sentence that explains a stable code; the code itself is always shown too. */
const codeExplanations: Readonly<Record<string, string>> = {
  SCHEDULER_GLOBALLY_PAUSED: 'Runtime 全局暂停中，新的执行不会启动；已运行的工具不会被 Codeestra 停掉。',
  GLOBAL_PAUSE_UNSUPPORTED: '平台或该 Adapter 无法核验并冻结 Provider 主进程，因此没有假装已暂停。',
  GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE: '有目标的进程身份读不出来，未向它发送任何信号。',
  GLOBAL_PAUSE_TARGET_NOT_STOPPED: '发出了 SIGSTOP，但复读进程状态没有证实它停止，因此不算已冻结。',
  GLOBAL_RESUME_TARGET_CHANGED: '有目标的 pid 已属于别的进程（或被复用），未向它发送 SIGCONT。',
  GLOBAL_PAUSE_RECOVERY_REQUIRED: '部分目标无法收口，屏障保持；请按逐目标事实处置后再继续。',
  GLOBAL_CONTROL_IN_PROGRESS: '上一次状态变更尚未收口，请先查看当前状态。',
};

const targetStateLabels: Readonly<Record<string, string>> = {
  PENDING: '待处理（尚未观测）',
  STOPPED: '已冻结（复读确认 stopped）',
  RESUMED: '已继续（复读确认 running）',
  EXITED: '已退出（不复活）',
  RECOVERY_REQUIRED: '需要处置',
};

function identityLabel(target: RuntimePauseTargetView): string {
  if (target.state === 'EXITED' || target.observation.code === 'EXITED') return '已退出';
  if (target.observation.identityMatched) return 'pid + start token 匹配';
  return target.observation.startToken === null ? '身份不可读' : 'pid 已属于别的进程';
}

function targetKey(target: RuntimePauseTargetView): string {
  return `${target.pauseEpoch}:${target.incarnationId}`;
}

export function GlobalControlPanel(props: GlobalControlPanelProps) {
  const { view } = props;
  const state = view?.state ?? 'UNKNOWN';
  return (
    <section
      className="global-control"
      aria-label="Runtime 全局负载控制"
      aria-busy={props.busy}
      data-global-control="true"
      data-global-control-state={state}
      data-global-control-epoch={view?.pauseEpoch ?? ''}
      data-global-control-code={view?.code ?? ''}
      data-global-control-platform={view?.platformSupported === false ? 'UNSUPPORTED' : 'POSIX'}
    >
      <div className="global-control-head">
        <span className="global-control-title">全局负载控制</span>
        <span
          className={`state ${state === 'RUNNING'
            ? 'state-ready'
            : state === 'RECOVERY_REQUIRED' ? 'state-error' : 'state-waiting'}`}
          data-global-control-state-label={state}
        >
          {stateLabels[state] ?? state}
        </span>
        <button type="button" data-action="pause-all" onClick={props.onPause}>暂停全部</button>
        <button type="button" data-action="resume-all" onClick={props.onResume}>继续全部</button>
        <button type="button" data-action="reconcile" onClick={props.onReconcile}>重新核对（只读）</button>
      </div>

      {props.loading && view === null
        ? <p className="muted" role="status">正在读取全局控制状态…</p>
        : null}

      {props.error === null ? null : (
        <p className="error" role="alert" data-global-control-error={props.error.code}>
          <span className="mono">{props.error.code}</span>
          {' · '}
          {codeExplanations[props.error.code] ?? 'Runtime 拒绝了该命令，状态未改变。'}
          <span className="muted">（{props.error.message}）</span>
        </p>
      )}

      {view === null ? null : (
        /*
          The detail block is open whenever the state is not RUNNING, because that is exactly when a
          single boolean would be a lie: PAUSING / RESUMING / RECOVERY_REQUIRED mean "some targets are
          frozen and some are not", and the per-target table is the only honest rendering of that.
          While RUNNING it stays collapsed so the shell keeps its slim strip.
        */
        <details
          className="global-control-details"
          open={state !== 'RUNNING'}
          data-global-control-details={state}
        >
          <summary>逐目标事实（{view.targets.length}）</summary>
          <p className="muted hint" data-global-control-summary="true">
            状态 {view.state} · 暂停 epoch {view.pauseEpoch} · 版本 v{view.version}
            {view.requestedAt === null ? '' : ` · 请求于 ${new Date(view.requestedAt).toLocaleString('zh-CN')}`}
            {view.requestedBy === null ? '' : `（${view.requestedBy}）`}
            {view.settledAt === null ? '' : ` · 结算于 ${new Date(view.settledAt).toLocaleString('zh-CN')}`}
            {` · 目标 ${view.targets.length}`}
          </p>
          {view.platformSupported ? null : (
            <p className="banner error" role="status" data-global-control-platform-note="true">
              本平台没有 POSIX 停止/继续语义，全局暂停会以 GLOBAL_PAUSE_UNSUPPORTED 明确失败，
              不会降级成“只暂停调度”后仍显示已暂停。
            </p>
          )}
          {/*
            The per-target table is not decoration for the failure case: it is the only honest way to
            show PAUSING / RESUMING / RECOVERY_REQUIRED, where some targets are frozen and others are
            not. It is rendered whenever the Runtime reports any target, at every state.
          */}
          {view.targets.length === 0 ? (
            <p className="muted" data-global-control-targets="none">
              本次 epoch 没有任何 Provider 目标（没有正在运行的受控 Provider 进程）。
            </p>
          ) : (
            <div className="table-scroll">
              <table data-global-control-targets="true">
                <thead>
                  <tr>
                    <th>Project / Task</th>
                    <th>Session</th>
                    <th>Provider 进程</th>
                    <th>身份核验</th>
                    <th>进程状态</th>
                    <th>目标状态</th>
                    <th>观测</th>
                  </tr>
                </thead>
                <tbody>
                  {view.targets.map((target) => (
                    <tr
                      key={targetKey(target)}
                      data-pause-target={targetKey(target)}
                      data-target-state={target.state}
                      data-target-process-state={target.observation.processState}
                      data-target-identity={target.observation.identityMatched
                        ? 'MATCHED'
                        : target.observation.startToken === null ? 'UNREADABLE' : 'CHANGED'}
                      data-target-adapter-support={target.observation.adapterSupport}
                      data-target-session={target.sessionId}
                      data-target-execution={target.executionId}
                      data-target-incarnation={target.incarnationId}
                      data-target-project={target.projectId}
                      data-target-task={target.taskId}
                      data-target-pid={target.providerPid}
                    >
                      <td>
                        <span className="mono">{target.projectId.slice(0, 8)}</span>
                        {' / '}
                        <span className="mono">{target.taskId.slice(0, 8)}</span>
                      </td>
                      <td className="mono">{target.sessionId.slice(0, 8)}</td>
                      <td className="mono">{target.providerPid}</td>
                      <td>{identityLabel(target)}</td>
                      <td>{target.observation.processState}</td>
                      <td>
                        <span className={`state ${target.state === 'STOPPED' || target.state === 'RESUMED'
                          ? 'state-ready'
                          : target.state === 'RECOVERY_REQUIRED' ? 'state-error' : 'state-waiting'}`}>
                          {targetStateLabels[target.state] ?? target.state}
                        </span>
                      </td>
                      <td className="hint">{target.observation.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted hint" data-global-control-capacity-note="true">
            {view.capacityNote}
          </p>
        </details>
      )}
      <p className="muted hint">
        暂停是显式命令，FULL 与 STRICT 都不需要二次确认。已经发出的模型请求不会被取消；工具子进程
        不会收到 Codeestra 的停止信号（但可能因管道背压而阻塞）。
      </p>
    </section>
  );
}
