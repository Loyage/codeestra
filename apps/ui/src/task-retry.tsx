import { useCallback, useEffect, useState } from 'react';
import { describeError, RuntimeClient } from './api.js';
import type {
  ExecutionView,
  RuntimePingView,
  TaskRetryOutcomeView,
  TaskView,
} from './types.js';

/**
 * The `task retry` projection (ADR-0036 / FOUNDATION-061).
 *
 * Scope of this module — what it is and is not:
 * - It sends exactly the request the CLI sends (`task.retry` with `expectedVersion`, and `adapterId`
 *   **only** when the user picked one), and it renders the Runtime's own answer.
 * - It **does not decide eligibility**. The command face only retries a `FAILED` Task and answers
 *   every other state with a stable code (`TASK_NOT_FAILED`, `TASK_CANCELLED`, `TASK_STILL_RUNNING`,
 *   `TASK_PAUSED`, `RECONCILE_REQUIRED`, `TASK_ARCHIVED`, …). Reproducing that state machine here
 *   would be a second source of truth that could disagree with the Runtime, so the control is not
 *   gated on it: a refusal is displayed with the code the Runtime actually returned.
 * - It keeps the two facts apart that `task retry` deliberately reports separately: the **requeue**
 *   (recorded, with an audit id) and the **one start request** that followed it. "Recorded but
 *   waiting" (the CLI's exit code 3) and "recorded but the start was refused" are never shown as
 *   "started".
 * - It reads the registered Adapter ids from `runtime.ping` instead of assuming one; the Adapter the
 *   Task last ran on comes from the Task's own Execution records.
 */

/** `task retry`: `adapterId` is omitted on purpose when the user kept "the last one it ran on". */
export function retryCommand(input: {
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  /** Null/empty means "do not send `adapterId`" — the Runtime reuses the last Adapter. */
  readonly adapterId: string | null;
  readonly commandId: string;
}): Record<string, unknown> {
  const adapterId = input.adapterId === null ? '' : input.adapterId.trim();
  return {
    command: 'task.retry',
    commandId: input.commandId,
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: input.expectedVersion,
    ...(adapterId.length === 0 ? {} : { adapterId }),
  };
}

/** The three distinguishable outcomes of one retry; only the first one started something. */
export type RetryOutcomeKind = 'STARTED' | 'WAITING' | 'START_REFUSED';

/** `WAIT` is the CLI's exit code 3; `REFUSED` carries a stable `code`. Neither is a start. */
export function retryOutcomeKind(result: TaskRetryOutcomeView): RetryOutcomeKind {
  if (result.start.outcome === 'STARTED') return 'STARTED';
  return result.start.outcome === 'WAIT' ? 'WAITING' : 'START_REFUSED';
}

/** True only for the outcome that created an Execution — the one thing "已启动" may describe. */
export function retryStartedExecution(result: TaskRetryOutcomeView): boolean {
  return retryOutcomeKind(result) === 'STARTED'
    && result.start.executionId !== null && result.start.sessionId !== null;
}

/** The requeue always happened before the start request, so it is stated even when nothing started. */
export function retryRequeuedDetail(result: TaskRetryOutcomeView): string {
  return `任务已重新入队：state ${result.state} · 版本 v${result.version}`
    + ` · 重试记录 ${result.retryId.slice(0, 8)}（跟随执行尝试 #${result.failedAttemptNumber}）`;
}

/**
 * One sentence per outcome, plus the stable code when there is one. The wording never lets a wait or
 * a refusal read as a started Execution.
 */
export function retryOutcomeNotice(result: TaskRetryOutcomeView): string {
  const kind = retryOutcomeKind(result);
  if (kind === 'STARTED') {
    return `新执行已启动（命令面退出码 0）：尝试 #${result.start.attemptNumber ?? '?'}`
      + ` · execution ${result.start.executionId ?? '—'} · session ${result.start.sessionId ?? '—'}`;
  }
  if (kind === 'WAITING') {
    return '重试已记录、任务已重新入队，但这次启动「在等待」（命令面退出码 3）——'
      + '现在没有任何执行被启动，下一次调度 tick 或再次运行会重新请求。';
  }
  return '重试已记录、任务已重新入队，但这次「启动请求被拒绝」'
    + `（原因码 ${result.start.code ?? '（未给出）'}）——现在没有任何执行被启动。`;
}

/** Where the Adapter for the new Execution came from, in the Runtime's own vocabulary. */
export function retryAdapterSourceLabel(source: TaskRetryOutcomeView['adapterSource']): string {
  if (source === 'REQUESTED') return '你这次指定';
  if (source === 'RECORDED') return '沿用该任务上一次运行的 Adapter';
  return '回退到默认 Adapter（上一次的 Adapter 不在注册表里）';
}

/** `REUSE_VERIFIED` / `PREPARE_FRESH` are the worktree; `REBUILD_OWNED` is a verified plan. */
export function retryWorkspaceLabel(mode: TaskRetryOutcomeView['workspace']['mode']): string {
  if (mode === 'REUSE_VERIFIED') return '复用已验证的工作树';
  if (mode === 'PREPARE_FRESH') return '新建工作树（无可用现场）';
  return '从保留的分支重建（已验证的计划，尚未创建）';
}

/** The wait reason a `WAIT` outcome carries: conflict vs capacity, with the blocking Tasks. */
export function retryWaitSummary(result: TaskRetryOutcomeView): string | null {
  const wait = result.start.wait;
  if (wait === null) return null;
  const kind = wait.kind === 'CAPACITY' ? '容量等待' : '冲突等待';
  const blocking = wait.blocking.length === 0 ? '' : ` · 占着位置的 Task：${wait.blocking.join(', ')}`;
  return `${kind} · ${wait.code} · ${wait.detail}${blocking}`;
}

/** Unmet upstream dependencies, as the dependency queue recorded them (`DEPENDENCIES_UNMET`). */
export function retryDependencySummary(result: TaskRetryOutcomeView): string | null {
  if (result.dependencyReasons.length === 0) return null;
  return result.dependencyReasons
    .map((reason) => `${reason.code}（前置任务 ${reason.prerequisiteTaskId.slice(0, 8)}`
      + ` · revision ${reason.requiredRevisionId.slice(0, 8)}）`)
    .join('；');
}

/**
 * Plain-language notes for the stable codes the retry face can answer with. This is a **glossary**,
 * not a gate: the code itself is always displayed next to the note, and a code without a note is
 * shown as the raw code rather than being mapped to something invented. Every key here is a string
 * the Runtime/Storage/domain sources literally contain (asserted by the test, so the glossary cannot
 * grow a code the command face never answers with).
 */
const retryCodeGlossary: Record<string, string> = {
  // `planTaskRetry` / `decideRetryWorkspace` refusals (packages/domain/src/task-retry.ts).
  TASK_NOT_FAILED: '只有 FAILED 的任务可以重试（该任务没有失败，没有可重复的尝试）',
  TASK_CANCELLED: 'CANCELLED 是终态，重试不会重开它；需要重做请新建任务',
  TASK_STILL_RUNNING: '任务仍持有 writer（运行中/暂停中/等待回答/终止中），重试会构成第二个 writer',
  TASK_PAUSED: '已暂停的任务应继续同一条会话：用「继续」（task resume），不是重试',
  RECONCILE_REQUIRED: '执行状态需要人工对账，重试无法证明上一个 writer 已停止',
  TASK_ARCHIVED: '任务已归档；请先取消归档，归档的任务不会被启动',
  WORKSPACE_OWNERSHIP_UNVERIFIABLE: '工作树无法被证明属于这个任务，不会交给新的执行',
  WORKSPACE_RECLAIMED: '工作树已被回收且无法重建（分支缺失/与基线无关/已在别处检出/路径被占用）',
  // The retry service's own refusals and the start gate's answers.
  UNKNOWN_ADAPTER: '指定的 Adapter 不在 Runtime 的注册表里（见「已注册」下拉项）',
  CONCURRENT_MODIFICATION: '任务版本已前进：界面显示的版本过期了，请先刷新再重试',
  NOT_FOUND: '找不到这个任务（项目或任务 id 不对）',
  TASK_NOT_STARTABLE: '启动请求发出时任务已不在可启动状态（重试记录仍然成立）',
  START_FAILED: '调度门禁允许启动，但启动本身失败（详见执行记录）',
  DEPENDENCIES_UNMET: '上游依赖未满足：任务被重新入队为 BLOCKED，不会启动',
  // Capacity wait codes (packages/contracts CapacityWaitReasonCode) surface as `WAIT`, not errors.
  CAPACITY_GLOBAL_LIMIT_REACHED: '项目并发上限已满：本次未启动，等待下一个调度 tick',
  CAPACITY_ADAPTER_SLOT_LIMIT_REACHED: '该 Adapter 的槽位上限已满：本次未启动，等待下一个调度 tick',
  SCHEDULER_DRAINING: '调度器正在 draining（停止接收新启动）：本次未启动',
  // ADR-0061 D08: the whole Runtime is paused, so nothing may start. It is a wait (CLI exit 3), and
  // it is *not* a dependency verdict: the Task is not BLOCKED.
  SCHEDULER_GLOBALLY_PAUSED: 'Runtime 全局暂停中（scheduler control resume 之前不启动）：本次未启动',
};

/** The glossary note for one code, or null when this code has no documented note. */
export function retryCodeNote(code: string): string | null {
  return retryCodeGlossary[code] ?? null;
}

/** Every code the glossary documents; used by the tests to catch drift against the domain source. */
export function retryDocumentedCodes(): readonly string[] {
  return Object.keys(retryCodeGlossary);
}

/** A refusal surfaced as `CODE: message`, with the glossary note when there is one. */
export function retryRejectionNotice(code: string, message: string): string {
  const note = retryCodeNote(code);
  return note === null ? `${code}: ${message}` : `${code}: ${message}（${note}）`;
}

/** The label of one choice in the Adapter selector. */
export function retryAdapterOptionLabel(input: {
  readonly adapterId: string;
  readonly lastAdapterId: string | null;
  readonly registered: boolean;
}): string {
  const parts = [input.adapterId];
  if (input.lastAdapterId !== null && input.adapterId === input.lastAdapterId) {
    parts.push('上一次运行');
  }
  if (!input.registered) parts.push('不在当前注册表');
  return parts.join(' · ');
}

/**
 * The Adapter selector's choices: the registered ids, plus the Task's last one when it is no longer
 * registered. `registered` is carried per choice so the label can say which fact it is — the id list
 * and the label must not be derived from each other.
 */
export function retryAdapterChoices(input: {
  readonly registered: readonly string[];
  readonly lastAdapterId: string | null;
}): readonly { readonly adapterId: string; readonly registered: boolean }[] {
  const choices = input.registered.map((adapterId) => ({ adapterId, registered: true }));
  const last = input.lastAdapterId;
  if (last !== null && last.length > 0 && !input.registered.includes(last)) {
    choices.push({ adapterId: last, registered: false });
  }
  return choices;
}

/**
 * The Adapter this Task last ran on: the newest recorded Execution, which is exactly the attempt the
 * Runtime re-reads when `adapterId` is omitted (`adapterSource: RECORDED`).
 */
export function retryLastAdapterId(executions: readonly ExecutionView[]): string | null {
  return executions[0]?.adapterId ?? null;
}

/**
 * The form: current version (the CAS value that will be sent), the Adapter choice with its default
 * meaning, and the button. Presentational so a test can render it without a Runtime.
 */
export function TaskRetryForm(props: {
  readonly taskVersion: number;
  readonly lastAdapterId: string | null;
  readonly adapters: readonly { readonly adapterId: string; readonly registered: boolean }[];
  /** The Adapter list read (`runtime.ping`) failed; the reason, or null. */
  readonly adapterListError: string | null;
  readonly selectedAdapter: string;
  readonly busy: boolean;
  readonly onSelectAdapter: (adapterId: string) => void;
  readonly onRetry: () => void;
}) {
  const { taskVersion, lastAdapterId, selectedAdapter } = props;
  return (
    <div className="task-retry-panel">
      <h4>重试失败任务 <span className="muted hint">task retry · 会真的改状态</span></h4>
      <p className="muted hint">
        命令面只对 <span className="mono">FAILED</span> 生效：其它状态会返回稳定码
        （<span className="mono">TASK_NOT_FAILED</span> /
        {' '}<span className="mono">TASK_CANCELLED</span> /
        {' '}<span className="mono">TASK_STILL_RUNNING</span> /
        {' '}<span className="mono">TASK_PAUSED</span> /
        {' '}<span className="mono">RECONCILE_REQUIRED</span> /
        {' '}<span className="mono">TASK_ARCHIVED</span>）。
        这个按钮不做本地状态判断：它把请求发给 Runtime，被拒绝时如实显示 Runtime 返回的稳定码。
        重试会把任务重新入队，并发起「一次」启动请求——它在同一条调度门禁后面排队，不插队。
      </p>
      <dl className="kv">
        <dt>当前版本</dt>
        <dd className="mono">v{taskVersion}
          <div className="muted">作为 <span className="mono">expected-version</span>（CAS）原样发送；
          界面显示的版本过期时会被拒绝为 <span className="mono">CONCURRENT_MODIFICATION</span></div></dd>
        <dt>上一次运行的 Adapter</dt>
        <dd className="mono">{lastAdapterId ?? '—'}
          <div className="muted">来自该任务最新一次执行记录；不带 <span className="mono">--adapter</span>
            {' '}时命令面复用它（<span className="mono">adapterSource: RECORDED</span>）</div></dd>
        <dt>这次使用的 Adapter</dt>
        <dd>
          <select value={selectedAdapter} disabled={props.busy}
            aria-label="重试使用的 Adapter"
            onChange={(event) => { props.onSelectAdapter(event.target.value); }}>
            <option value="">沿用该任务上一次运行的 Adapter{lastAdapterId === null
              ? '（无记录：回退到默认 Adapter）' : `（${lastAdapterId}）`}</option>
            {props.adapters.map(({ adapterId, registered }) => (
              <option key={adapterId} value={adapterId}>
                {retryAdapterOptionLabel({ adapterId, lastAdapterId, registered })}
              </option>
            ))}
          </select>
          <div className="muted">已注册的 Adapter 列表来自 <span className="mono">runtime.ping</span>
            {' '}的 <span className="mono">adapters</span>
            {props.adapterListError === null ? null : `（读取失败：${props.adapterListError}）`}
          </div>
        </dd>
      </dl>
      <div className="actions">
        <button type="button" className="primary" disabled={props.busy}
          title="重新入队这个 FAILED 任务，并请调度门禁尝试启动一次；等待或拒绝都不会启动执行"
          onClick={props.onRetry}>重试（task retry）</button>
      </div>
    </div>
  );
}

/**
 * The outcome of one retry: the requeue that was recorded, and the scheduling answer that followed.
 * Rendered as a fact card so "started" cannot be confused with "queued and waiting".
 */
export function RetryOutcomeCard({ result }: { readonly result: TaskRetryOutcomeView }) {
  const kind = retryOutcomeKind(result);
  const wait = retryWaitSummary(result);
  const dependencies = retryDependencySummary(result);
  return (
    <div className="card nested retry-outcome" role="status">
      <div className="section-heading">
        <h5>{kind === 'STARTED' ? '已启动' : kind === 'WAITING' ? '已入队 · 在等待（退出码 3）'
          : '已入队 · 启动被拒绝'}</h5>
        <span className={kind === 'STARTED' ? 'state state-ready'
          : kind === 'WAITING' ? 'state state-waiting' : 'state state-failed'}>
          {retryOutcomeNotice(result)}
        </span>
      </div>
      <p className="muted">{retryRequeuedDetail(result)}</p>
      <dl className="kv">
        <dt>Adapter</dt>
        <dd className="mono">{result.adapterId}
          <div className="muted">{retryAdapterSourceLabel(result.adapterSource)}
            {result.adapterChanged && result.previousAdapterId !== null
              ? ` · 上一次运行是 ${result.previousAdapterId}` : ''}</div></dd>
        <dt>工作树</dt>
        <dd>{retryWorkspaceLabel(result.workspace.mode)}
          <div className="muted">{result.workspace.detail}
            {result.workspace.evidence === null ? '' : ` · 证据 ${result.workspace.evidence}`}</div></dd>
        <dt>启动答案</dt>
        <dd className="mono">{result.start.outcome}
          {result.start.code === null ? null : ` · ${result.start.code}`}
          <div className="muted">{result.start.detail}</div></dd>
      </dl>
      {wait === null ? null : <p className="muted">等待理由：{wait}</p>}
      {dependencies === null ? null : <p className="muted">未满足依赖：{dependencies}</p>}
      {kind !== 'STARTED' ? null : (
        <p className="muted">
          execution <span className="mono">{result.start.executionId ?? '—'}</span> · session
          {' '}<span className="mono">{result.start.sessionId ?? '—'}</span> · 工作树
          {' '}<span className="mono">{result.start.workspacePath ?? '—'}</span>
        </p>
      )}
      <p className="muted hint">
        这只说明重试这一步的结果。执行是否成功要另看任务详情里的执行记录与验证/集成投影
        （合入 dev 也不等于已提升到 main）。
      </p>
    </div>
  );
}

/**
 * The interactive control: reads the registered Adapters, sends `task.retry`, and shows either the
 * outcome card or the Runtime's refusal. Local state only — nothing here writes anything but the one
 * command the user pressed.
 */
export function TaskRetryControls(props: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  readonly task: TaskView;
  readonly executions: readonly ExecutionView[];
  readonly onChanged: () => Promise<void>;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [ping, setPing] = useState<RuntimePingView | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const [selectedAdapter, setSelectedAdapter] = useState('');
  const [outcome, setOutcome] = useState<TaskRetryOutcomeView | null>(null);
  const [rejection, setRejection] = useState<string | null>(null);
  /** Local to this control so a double click cannot send two retries before the first answers. */
  const [pending, setPending] = useState(false);

  const { client } = props;
  const loadAdapters = useCallback(async (): Promise<void> => {
    try {
      setPing(await client.command<RuntimePingView>({ command: 'runtime.ping' }));
      setPingError(null);
    } catch (caught) {
      setPing(null);
      setPingError(describeError(caught));
    }
  }, [client]);

  useEffect(() => { void loadAdapters(); }, [loadAdapters]);

  const lastAdapterId = retryLastAdapterId(props.executions);
  const adapters = retryAdapterChoices({ registered: ping?.adapters ?? [], lastAdapterId });

  const retry = (): void => {
    if (pending) return;
    setPending(true);
    void props.run('正在重试任务', async () => {
      setOutcome(null);
      setRejection(null);
      try {
        const result = await client.command<TaskRetryOutcomeView>(retryCommand({
          projectId: props.projectId,
          taskId: props.task.id,
          expectedVersion: props.task.version,
          adapterId: selectedAdapter.length === 0 ? null : selectedAdapter,
          commandId: crypto.randomUUID(),
        }));
        setOutcome(result);
      } catch (caught) {
        // A refusal writes nothing and is not an exception to hide: the stable code is the answer.
        const code = caught instanceof Error && 'code' in caught ? String(caught.code) : 'UNKNOWN';
        const message = caught instanceof Error ? caught.message : String(caught);
        setRejection(retryRejectionNotice(code, message));
      }
      await props.onChanged();
      await loadAdapters();
    }).finally(() => { setPending(false); });
  };

  return (
    <>
      <TaskRetryForm
        taskVersion={props.task.version}
        lastAdapterId={lastAdapterId}
        adapters={adapters}
        adapterListError={pingError}
        selectedAdapter={selectedAdapter}
        busy={pending}
        onSelectAdapter={setSelectedAdapter}
        onRetry={retry}
      />
      {rejection === null ? null : (
        <p className="error" role="alert">重试被拒绝：{rejection}</p>
      )}
      {outcome === null ? null : <RetryOutcomeCard result={outcome} />}
    </>
  );
}
