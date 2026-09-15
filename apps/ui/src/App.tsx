import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ThemeSelector } from './theme.js';
import { ChannelBanner, channelBrandName, uiChannel } from './channel.js';
import { AgentSettingsPanel } from './agent-settings.js';
import { SettingsPage, UiSettingsProvider } from './settings.js';
import { usePendingAction } from './use-pending-action.js';
import { RuntimeClient, describeError } from './api.js';
import { TranscriptPanel } from './transcript.js';
import { TerminalPanel } from './terminal.js';
import { DependencyPanel } from './dependencies.js';
import { PromotionPanel } from './promotion.js';
import { IntegrationBatchPanel, IntegrationBatchTable } from './integration-batches.js';
import {
  DevRepoInspectionRows,
  ProjectDevRepoInput,
  canSubmitProjectTrust,
  projectInspectCommand,
  projectTrustCommand,
  projectTrustPolicyConfirmation,
  projectTrustRejectionNotice,
} from './project-trust.js';
import { TaskRetryControls } from './task-retry.js';
import { RevisionDeliveryPanel } from './revisions.js';
import { ProseQuestionWaitCard, isProseQuestionWait, readProseQuestionWait, proseQuestionResolveCommand } from './prose-wait.js';
import { SchedulePanel, ScheduleExplainPanel, CapacityPanel } from './schedule.js';
import { ImpactPolicyPanel, ImpactTaskPanel } from './impact.js';
import {
  completionNoteHeading,
  completionNoteSummary,
  isSchedulingEventType,
  schedulingEventSummary,
} from './scheduling-labels.js';
import { NewTaskDock } from './new-task-dock.js';
import { TaskList, TaskStateBadge } from './task-list.js';
import {
  operationProgressFromEvent,
  questionnaireFromPrompt,
  type AttentionView,
  type EventEnvelopeView,
  type LiveOutputProgressView,
  type OperationProgressEventView,
  type OperationView,
  type ProseQuestionResolutionResultView,
  type ProjectIdentityView,
  type QuestionnaireView,
  type ResultCommitAuthorizationView,
  type StreamFrame,
  type TaskStatusView,
  type TaskView,
  type TrustedProjectView,
  type VerificationPolicyView,
  type VerificationRunView,
} from './types.js';

type Tab = 'tasks' | 'attention' | 'schedule' | 'events' | 'plugins' | 'project' | 'settings';
const tabLabels: Record<Tab, string> = {
  tasks: '任务工作台',
  attention: '待处理',
  schedule: '调度',
  events: '运行事件',
  plugins: 'Agent 设置',
  project: '项目',
  settings: '设置',
};

const valueLabels: Record<string, string> = {
  DRAFT: '草稿',
  READY: '就绪',
  RUNNING: '运行中',
  WAITING_FOR_USER: '等待用户',
  BLOCKED: '已阻塞',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  RECOVERY_REQUIRED: '需要恢复',
  PAUSING: '正在暂停',
  PAUSED: '已暂停',
  EXECUTED: '已执行',
  CANCELLING: '正在取消',
  SUCCEEDED: '已成功',
  CREATED: '已创建',
  PREPARING: '准备中',
  STARTING: '正在启动',
  STOPPING: '正在停止',
  SUPERSEDED: '已取代',
  EXITED: '已退出',
  DISCONNECTED: '已断开',
  RESERVED: '已预留',
  IN_USE: '使用中',
  RETAINED: '已保留',
  RELEASED: '已释放',
  QUEUED: '排队中',
  PASSED: '已通过',
  ERROR: '错误',
  STALE: '已过期',
  ACTIVE: '有效',
  CONSUMED: '已使用',
  INVALIDATED: '已失效',
  OPEN: '待处理',
  ANSWERED: '已回答',
  ANSWER_RECORDED: '已记录回答',
  DELIVERED: '已送达',
  CLOSED: '已关闭',
  QUESTION: '问题',
  PERMISSION: '权限请求',
  RECOVERY: '恢复',
  CONFIRM: '确认',
  VALUE: '文本',
  PREPARED: '已准备',
  VERIFYING: '正在集成验证',
  INTEGRATING_DEV: '正在更新 dev',
  INTEGRATED: '已合入 dev',
  CONFLICTED: '合并冲突',
  MERGED: '已合并',
  FAST_FORWARD: '快进',
  MERGE_COMMIT: '合并提交',
  PLANNED: '已计划',
  IN_PROGRESS: '进行中',
  INFO: '信息',
  CANCELLED_BY_USER: '已取消（用户）',
  STEP: '步骤',
  OUTPUT: '输出',
  SETTLED: '已结束',
  STARTED: '已开始',
};

/**
 * Long commands are labelled by what they cover. `RUN_TASK_VERIFICATION` is called what it is: the
 * same policy the Task verification uses, run on the merged commit.
 */
function operationKindLabel(kind: string): string {
  if (kind === 'RUN_TASK') return 'Agent 运行';
  if (kind === 'RUN_TASK_VERIFICATION') return '任务验证';
  return kind;
}

/**
 * A long-command Operation's own state as this client shows it. A cancel is recorded the ADR-0019
 * way (`FAILED` + `cancelled: true`) because a user stop is not a success — but showing it as
 * “failed” would misreport why it ended, so the recorded flag wins over the state word.
 */
function operationStateLabel(operation: OperationView): string {
  if (operation.result?.['cancelled'] === true) return '已取消（用户）';
  return labelValue(operation.state);
}

/** The newest recorded step, as one line — never a progress estimate the Runtime cannot know. */
function operationLatestStep(operation: OperationView): string {
  const step = operation.steps.at(-1);
  if (step === undefined) return '还没有记录步骤';
  const detail = step.detail === null ? '' : ` ${JSON.stringify(step.detail)}`;
  const rendered = `${step.step} · ${labelValue(step.state)}${detail}`;
  return rendered.length > 160 ? `${rendered.slice(0, 160)}…` : rendered;
}

/** Sub-step liveness from the newest `OUTPUT` event: sizes and elapsed time only, never output. */
function liveOutputLabel(live: LiveOutputProgressView): string {
  const parts: string[] = [];
  if (live.commandId !== null) parts.push(`命令 ${live.commandId}`);
  if (live.stream !== null) parts.push(live.stream);
  if (live.stdoutBytes !== null || live.stderrBytes !== null) {
    parts.push(`stdout ${live.stdoutBytes ?? 0} B / stderr ${live.stderrBytes ?? 0} B`);
  }
  if (live.elapsedMs !== null) parts.push(`已运行 ${(live.elapsedMs / 1000).toFixed(1)}s`);
  parts.push('仍在输出');
  return parts.join(' · ');
}

/**
 * Applies one progress event to the Operation it belongs to. Steps are merged by `stepKey` and only
 * appended when they are newer than the last one already held, so a re-delivered or out-of-order
 * event cannot duplicate or rewind the list. `phase: 'OUTPUT'` only refreshes the liveness line: it
 * is not a step and it is definitely not a result.
 */
function applyOperationProgress(
  operations: readonly OperationView[],
  progress: OperationProgressEventView,
  receivedAt: number,
): readonly OperationView[] | null {
  const known = operations.findIndex((operation) => operation.operationId === progress.operationId);
  if (known === -1) return null;
  const operation = operations[known] as OperationView;
  if (progress.phase === 'OUTPUT') {
    const previous = operation.liveOutput;
    if (previous !== null && previous !== undefined
      && previous.progressSequence >= progress.progressSequence) return operations;
    const detail = progress.detail ?? {};
    const live: LiveOutputProgressView = {
      progressSequence: progress.progressSequence,
      commandId: typeof detail['commandId'] === 'string' ? detail['commandId'] : null,
      stream: typeof detail['stream'] === 'string' ? detail['stream'] : null,
      stdoutBytes: typeof detail['stdoutBytes'] === 'number' ? detail['stdoutBytes'] : null,
      stderrBytes: typeof detail['stderrBytes'] === 'number' ? detail['stderrBytes'] : null,
      elapsedMs: typeof detail['elapsedMs'] === 'number' ? detail['elapsedMs'] : null,
      receivedAt,
    };
    const next = [...operations];
    next[known] = { ...operation, liveOutput: live };
    return next;
  }
  const latestStep = operation.steps.at(-1);
  if (latestStep !== undefined && progress.stepKey !== null
    && latestStep.stepKey === progress.stepKey) return operations;
  const next = [...operations];
  if (progress.phase === 'SETTLED') {
    next[known] = { ...operation,
      state: progress.operationState ?? operation.state,
      updatedAt: receivedAt,
    };
    return next;
  }
  next[known] = { ...operation,
    updatedAt: receivedAt,
    steps: [...operation.steps, {
      sequence: progress.stepSequence ?? operation.steps.length,
      stepKey: progress.stepKey ?? progress.dedupKey,
      step: progress.step ?? progress.phase,
      state: progress.stepState ?? 'INFO',
      detail: progress.detail,
      recordedAt: receivedAt,
    }],
  };
  return next;
}

function labelValue(value: string): string {
  return valueLabels[value] ?? value;
}

function streamStatusLabel(status: string): string {
  if (status === 'connecting') return '连接中';
  if (status === 'live') return '实时';
  if (status === 'stopped') return '已停止';
  const match = /^reconnecting \((\d+)\)$/.exec(status);
  return match === null ? status : `正在重连（第 ${match[1]} 次）`;
}

export function App({ initialToken, initialProjectId, tokenKey }: {
  readonly initialToken: string | null;
  readonly initialProjectId: string | null;
  readonly tokenKey: string;
}) {
  const [token, setToken] = useState(initialToken);
  if (token === null) {
    return (
      <>
        <ChannelBanner channel={uiChannel} />
        <div className="centered">
          <div className="theme-corner"><ThemeSelector /></div>
          <TokenForm onSubmit={(value) => {
            window.sessionStorage.setItem(tokenKey, value);
            setToken(value);
          }} />
        </div>
      </>
    );
  }
  return <Console token={token} initialProjectId={initialProjectId} />;
}

function TokenForm({ onSubmit }: { readonly onSubmit: (token: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="card token-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim().length > 0) onSubmit(value.trim());
      }}
    >
      <h1>Codeestra</h1>
      <p className="muted">
        此页面需要 Runtime 输出的令牌。请再次运行 <code>codeestra ui</code> 并打开所显示的地址，
        或在此粘贴 <code>#token=…</code> 片段中的令牌。
      </p>
      <input
        type="password"
        aria-label="Runtime 令牌"
        value={value}
        placeholder="Runtime 令牌"
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit">连接</button>
    </form>
  );
}

interface ConsoleState {
  projects: readonly TrustedProjectView[];
  projectId: string | null;
  tasks: readonly TaskView[];
  taskId: string | null;
  status: TaskStatusView | null;
  attentions: readonly AttentionView[];
  frames: readonly EventEnvelopeView[];
  cursor: number | null;
  following: boolean;
  streamStatus: string;
  /** Bumped by stream events that invalidate the Attention list or the selected task detail. */
  attentionToken: number;
  detailToken: number;
  /** Bumped when the bottom dock creates a draft, so the workbench drops its search and filter. */
  createToken: number;
  busy: string | null;
  error: string | null;
  notice: string | null;
  adapter: string;
  permissionMode: 'FULL' | 'STRICT';
}

function Console({ token, initialProjectId }: {
  readonly token: string;
  readonly initialProjectId: string | null;
}) {
  const client = useMemo(() => new RuntimeClient(window.location.origin, token), [token]);
  const [tab, setTab] = useState<Tab>('tasks');
  const [state, setState] = useState<ConsoleState>({
    projects: [], projectId: null, tasks: [], taskId: null, status: null, attentions: [],
    frames: [], cursor: null, following: true, streamStatus: 'connecting', busy: null,
    error: null, notice: null, adapter: 'pi', permissionMode: 'FULL',
    attentionToken: 0, detailToken: 0, createToken: 0,
  });
  const cursorRef = useRef<number | null>(null);
  const selectionRef = useRef({ projectId: state.projectId, taskId: state.taskId });
  const operationsRef = useRef(new Map<symbol, string>());
  const detailRequestRef = useRef(0);
  const listRequestRef = useRef(0);

  const update = useCallback((patch: Partial<ConsoleState>) => {
    if ('projectId' in patch) {
      selectionRef.current.projectId = patch.projectId ?? null;
      listRequestRef.current += 1;
      detailRequestRef.current += 1;
    }
    if ('taskId' in patch) {
      selectionRef.current.taskId = patch.taskId ?? null;
      detailRequestRef.current += 1;
    }
    setState((previous) => ({ ...previous, ...patch }));
  }, []);

  const run = useCallback(async (label: string, action: () => Promise<void>): Promise<void> => {
    const operation = Symbol(label);
    operationsRef.current.set(operation, label);
    update({ busy: label, error: null, notice: null });
    try {
      await action();
    } catch (error) {
      update({ error: `${label}：${describeError(error)}` });
    } finally {
      operationsRef.current.delete(operation);
      update({ busy: [...operationsRef.current.values()].at(-1) ?? null });
    }
  }, [update]);

  const loadProjects = useCallback(async (): Promise<void> => {
    const requestedProject = selectionRef.current.projectId;
    const [projects, permission] = await Promise.all([
      client.command<TrustedProjectView[]>({ command: 'project.list' }),
      client.command<{ mode: 'FULL' | 'STRICT' }>({ command: 'permission.get' }),
    ]);
    const requested = requestedProject ?? initialProjectId;
    const projectId = projects.find((project) => project.id === requested)?.id
      ?? projects[0]?.id ?? null;
    const tasks = projectId === null
      ? []
      : await client.command<TaskView[]>({ command: 'task.list', projectId, includeArchived: true });
    const attentions = projectId === null
      ? []
      : await client.command<AttentionView[]>({ command: 'attention.list', projectId });
    if (selectionRef.current.projectId !== requestedProject) return;
    update({ projects, projectId, tasks, attentions, permissionMode: permission.mode,
      ...(projectId === requestedProject ? {} : { taskId: null, status: null }) });
  }, [client, initialProjectId, update]);

  const loadTaskDetail = useCallback(async (projectId: string, taskId: string): Promise<void> => {
    const request = ++detailRequestRef.current;
    const status = await client.command<TaskStatusView>({ command: 'task.status', projectId, taskId });
    if (request !== detailRequestRef.current || selectionRef.current.projectId !== projectId
      || selectionRef.current.taskId !== taskId) return;
    setState((previous) => ({ ...previous,
      status: previous.status !== null && previous.status.task.version > status.task.version
        ? previous.status : status,
      tasks: previous.tasks.map((task) => (task.id === taskId && task.version <= status.task.version
        ? status.task : task)) }));
  }, [client]);

  const loadTaskList = useCallback(async (projectId: string): Promise<void> => {
    const request = ++listRequestRef.current;
    const tasks = await client.command<TaskView[]>({ command: 'task.list', projectId,
      includeArchived: true });
    if (request !== listRequestRef.current || selectionRef.current.projectId !== projectId) return;
    setState((previous) => ({ ...previous, tasks: tasks.map((task) => {
      const known = previous.tasks.find((candidate) => candidate.id === task.id);
      return known !== undefined && known.version > task.version ? known : task;
    }) }));
  }, [client]);

  useEffect(() => {
    // Runs once on mount; later reloads are explicit user actions.
    void run('正在加载项目', loadProjects);
  }, []);


  const onFrame = useCallback((frame: StreamFrame) => {
    if (frame.type === 'subscribed') {
      cursorRef.current = frame.cursor;
      // Reconcile snapshots on initial subscription and reconnection rather than leaving the
      // list indefinitely on its pre-disconnect projection when no new Task event arrives.
      setState((previous) => ({ ...previous, cursor: frame.cursor, streamStatus: 'live',
        detailToken: previous.detailToken + 1, attentionToken: previous.attentionToken + 1 }));
      return;
    }
    if (frame.type === 'heartbeat') {
      cursorRef.current = frame.cursor;
      setState((previous) => ({ ...previous, cursor: frame.cursor, streamStatus: 'live' }));
      return;
    }
    if (frame.type === 'error') {
      // A terminal frame carries a reason the client must not paper over (for example a stale
      // cursor): stop following and surface it instead of silently reconnecting forever.
      cursorRef.current = null;
      setState((previous) => ({
        ...previous, following: false, streamStatus: 'stopped',
        error: `${frame.code}: ${frame.message}`,
      }));
      return;
    }
    cursorRef.current = frame.cursor;
    // An Agent that blocks on a permission prompt must become visible without the user having to
    // guess and press Refresh: the stream itself invalidates the affected views.
    const invalidatesAttention = frame.event.eventType === 'UserAttentionRequested'
      || frame.event.eventType === 'UserAnswerRecorded'
      || frame.event.eventType === 'UserAnswerDelivered';
    const invalidatesDetail = invalidatesAttention
      || frame.event.eventType.startsWith('Execution')
      || frame.event.eventType.startsWith('Task')
      || frame.event.eventType.startsWith('AgentSession')
      || frame.event.eventType.startsWith('Verification')
      || frame.event.eventType.startsWith('ResultCommit')
      // A batch is composed, merged, invalidated or cancelled as its own aggregate, so its events
      // refresh the project's batch view and the selected Task's integration record.
      || frame.event.eventType.startsWith('Integration');
    // Long-command progress arrives as an event, so the Task detail is updated from the stream
    // instead of being polled. An Operation this client does not know yet (another client queued
    // it) triggers exactly one detail reload, after which its events merge in place.
    const progress = frame.event.eventType === 'OperationProgressed'
      || frame.event.eventType === 'OperationSettled'
      ? operationProgressFromEvent(frame.event.payload)
      : null;
    setState((previous) => {
      let status = previous.status;
      let needsReload = false;
      // Progress for another Task in the same project must not reload the selected detail: a chatty
      // command elsewhere would otherwise turn every step event into a read of this Task.
      const belongsHere = progress !== null
        && (previous.projectId === null || progress.projectId === previous.projectId)
        && (progress.taskId === null || status === null || progress.taskId === status.task.id);
      if (belongsHere && progress !== null) {
        if (status === null) {
          needsReload = true;
        } else {
          const merged = applyOperationProgress(status.operations, progress, frame.event.occurredAt);
          if (merged === null) needsReload = true;
          else status = { ...status, operations: merged };
        }
        // A settled Operation carries the terminal state but not the full projection (the recorded
        // result, the verification row), so it is reconciled by one read of the same detail
        // projection every client uses — not by a timer.
        if (progress.phase === 'SETTLED') needsReload = true;
      }
      const reloadAttention = invalidatesAttention
        ? previous.attentionToken + 1 : previous.attentionToken;
      const reloadDetail = invalidatesDetail || needsReload
        ? previous.detailToken + 1 : previous.detailToken;
      return {
        ...previous,
        cursor: frame.cursor,
        streamStatus: 'live',
        frames: [...previous.frames, frame.event].slice(-300),
        status,
        attentionToken: reloadAttention,
        detailToken: reloadDetail,
      };
    });
  }, []);

  // Refresh the Attention inbox whenever the stream says it changed.
  useEffect(() => {
    const projectId = state.projectId;
    if (projectId === null) return;
    let disposed = false;
    void client.command<AttentionView[]>({ command: 'attention.list', projectId })
      .then((attentions) => {
        if (!disposed && selectionRef.current.projectId === projectId) update({ attentions });
      })
      .catch((error: unknown) => {
        if (!disposed) update({ error: `待处理请求刷新失败：${describeError(error)}` });
      });
    return () => { disposed = true; };
  }, [client, state.projectId, state.attentionToken, update]);

  // Keep the selected task detail (Execution/Session/verifications) live as well.
  useEffect(() => {
    const projectId = state.projectId;
    const taskId = state.taskId;
    if (projectId === null || taskId === null) return;
    let disposed = false;
    void loadTaskDetail(projectId, taskId)
      .catch((error: unknown) => {
        if (!disposed) update({ error: `任务详情刷新失败：${describeError(error)}` });
      });
    return () => { disposed = true; };
  }, [loadTaskDetail, state.projectId, state.taskId, state.detailToken, update]);

  useEffect(() => {
    if (state.projectId !== null) {
      void loadTaskList(state.projectId).catch((error: unknown) => {
        update({ error: `任务列表刷新失败：${describeError(error)}` });
      });
    }
  }, [state.projectId, state.detailToken, loadTaskList, update]);

  // Long-command progress is event-driven: `OperationProgressed`/`OperationSettled` frames update
  // the Task detail directly, so while the stream is live nothing is polled.
  //
  // Tradeoff (ADR-0027 D06): a fallback poll is kept, but only while the stream is *not* live. The
  // event stream is best-effort — a subscriber whose connection stopped or that was opened while the
  // Runtime was restarting would otherwise freeze on stale progress until the user refreshed by
  // hand. Five seconds instead of the previous 1.5 s keeps that safety net from re-creating the
  // polling load the events exist to remove.
  const activeOperationCount = state.status?.operations.filter((operation) =>
    operation.state === 'PLANNED' || operation.state === 'IN_PROGRESS').length ?? 0;
  const fallbackPolling = activeOperationCount > 0 && state.streamStatus !== 'live';
  useEffect(() => {
    const projectId = state.projectId;
    const taskId = state.taskId;
    if (!fallbackPolling || projectId === null || taskId === null) return undefined;
    const timer = setInterval(() => {
      void loadTaskDetail(projectId, taskId).catch(() => { /* the next tick retries */ });
    }, 5_000);
    return () => { clearInterval(timer); };
  }, [fallbackPolling, state.projectId, state.taskId, loadTaskDetail]);

  // Event stream: reconnects from the last delivered cursor, so a dropped connection or a
  // restarted Runtime resumes without gaps or duplicates.
  useEffect(() => {
    if (!state.following) return undefined;
    const controller = new AbortController();
    let attempt = 0;
    const loop = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        try {
          await client.streamEvents(cursorRef.current ?? undefined, controller.signal, onFrame);
          if (controller.signal.aborted) return;
        } catch (error) {
          if (controller.signal.aborted) return;
          attempt += 1;
          if (attempt >= 5) {
            setState((previous) => ({
              ...previous, following: false, streamStatus: 'stopped', error: describeError(error),
            }));
            return;
          }
        }
        attempt = attempt === 0 ? 1 : attempt;
        setState((previous) => ({
          ...previous, streamStatus: `reconnecting (${attempt})`,
        }));
        await new Promise((resolve) => { setTimeout(resolve, Math.min(500 * attempt, 3_000)); });
      }
    };
    void loop();
    return () => { controller.abort(); };
  }, [client, state.following, onFrame]);

  const projectId = state.projectId;
  const selectedTask = state.tasks.find((task) => task.id === state.taskId) ?? null;
  const reloadAttentions = async (): Promise<void> => {
    if (projectId === null) return;
    const attentions = await client.command<AttentionView[]>({ command: 'attention.list', projectId });
    if (selectionRef.current.projectId === projectId) update({ attentions });
  };

  return (
    // One provider for the whole console, so the interface-effect settings (ADR-0045) apply on every
    // tab and the sidebar's theme selector and the settings page share one state. The element below
    // keeps its own indentation so this wrapper stays a two-line change.
    <UiSettingsProvider client={client}>
    <div className="app">
      <a className="skip-link" href="#workspace">跳转到工作区</a>
      <ChannelBanner channel={uiChannel} />
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">C</span>
          <div><strong>{channelBrandName(uiChannel)}</strong><span className="brand-caption">让意图成为成果</span></div>
        </div>
        <div className="header-controls">
          <select
            aria-label="当前项目"
            value={projectId ?? ''}
            onChange={(event) => {
              const next = event.target.value === '' ? null : event.target.value;
              update({ projectId: next, taskId: null, status: null, tasks: [], attentions: [],
                error: null, notice: null });
            }}
          >
            <option value="">未选择项目</option>
            {state.projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <button type="button" onClick={() => { void run('正在刷新', async () => {
            await loadProjects();
            const selection = selectionRef.current;
            if (selection.projectId !== null && selection.taskId !== null) {
              await loadTaskDetail(selection.projectId, selection.taskId);
            }
          }); }}>
            刷新
          </button>
        </div>
      </header>

      <aside className="sidebar">
      <nav aria-label="主导航">
        <span className="nav-caption">工作空间</span>
        {(['tasks', 'attention', 'schedule', 'project', 'plugins', 'events', 'settings'] as const).map((name) => (
          <button
            key={name}
            type="button"
            className={tab === name ? 'tab active' : 'tab'}
            aria-current={tab === name ? 'page' : undefined}
            onClick={() => setTab(name)}
          >
            {tabLabels[name]}
            {name === 'attention' && state.attentions.some((item) => item.status === 'OPEN')
              ? <span className="badge">{state.attentions.filter((item) => item.status === 'OPEN').length}</span>
              : null}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <ThemeSelector />
        <span className="muted">{state.permissionMode === 'FULL' ? 'FULL · 全权限，零确认' : 'STRICT · 严格模式'}</span>
        <span className={`connection ${state.streamStatus === 'live' ? 'live' : ''}`}>
          <span aria-hidden="true">●</span> 事件流 · {streamStatusLabel(state.streamStatus)}
        </span>
      </div>
      </aside>

      <div className="workspace-shell">
      <div className="page-heading">
        <div><span className="eyebrow">{state.projects.find((project) => project.id === projectId)?.name ?? '开始使用'}</span>
          <h1>{tab === 'tasks'
            ? (selectedTask === null ? '任务列表' : '任务详情')
            : tabLabels[tab]}</h1></div>
        <span className="muted busy" role="status">{state.busy === null ? '本地运行 · 关闭页面不影响任务' : `${state.busy}…`}</span>
      </div>

      {state.error === null ? null : (
        <div className="banner error" role="alert">
          {state.error}
          <button type="button" onClick={() => update({ error: null })}>关闭</button>
        </div>
      )}
      {state.notice === null ? null : (
        <div className="banner notice" role="status">
          {state.notice}
          <button type="button" onClick={() => update({ notice: null })}>关闭</button>
        </div>
      )}

      <main id="workspace" tabIndex={-1}>
        <div hidden={tab !== 'tasks'}>
          <TasksTab
            key={projectId ?? 'no-project'}
            client={client}
            attentions={state.attentions}
            reloadAttentions={reloadAttentions}
            openProjects={() => setTab('project')}
            projectId={projectId}
            tasks={state.tasks}
            taskId={state.taskId}
            status={state.status}
            adapter={state.adapter}
            permissionMode={state.permissionMode}
            run={run}
            update={(patch) => { if (selectionRef.current.projectId === projectId) update(patch); }}
            reloadTasks={async (id) => { await loadTaskList(id); }}
            loadDetail={loadTaskDetail}
            createToken={state.createToken}
            detailToken={state.detailToken}
            live={state.streamStatus === 'live'}
          />
        </div>
        {tab === 'attention' ? (
          <AttentionTab
            key={projectId}
            client={client}
            tasks={state.tasks}
            selectTask={(taskId) => { update({ taskId, status: null }); setTab('tasks'); }}
            projectId={projectId}
            attentions={state.attentions}
            run={run}
            update={update}
            reload={reloadAttentions}
          />
        ) : null}
        {tab === 'schedule' ? (
          projectId === null ? <p className="muted">请先选择一个项目。</p> : (
            <ScheduleTab
              key={projectId}
              client={client}
              projectId={projectId}
              repoRoot={state.projects.find((project) => project.id === projectId)?.repoRoot ?? ''}
              tasks={state.tasks}
              refreshToken={state.detailToken}
              run={run}
            />
          )
        ) : null}
        {tab === 'events' ? (
          <EventsTab
            frames={state.frames}
            cursor={state.cursor}
            following={state.following}
            streamStatus={state.streamStatus}
            update={update}
            clear={() => update({ frames: [] })}
          />
        ) : null}
        {tab === 'plugins' ? (
          <AgentSettingsPanel key={projectId} client={client} projectId={projectId} run={run} />
        ) : null}
        {tab === 'project' ? (
          <ProjectTab client={client} permissionMode={state.permissionMode} projectId={projectId}
            tasks={state.tasks} refreshToken={state.detailToken} run={run} update={update}
            reloadProjects={loadProjects} />
        ) : null}
        {tab === 'settings' ? <SettingsPage /> : null}
      </main>

      <footer className="muted">
        关闭页面不会停止任务 · 暂停与终止请在任务详情操作 · 合入 dev 不等于发布到 main。
        {selectedTask === null ? null : ` 当前选择：任务 #${selectedTask.displayNumber}。`}
      </footer>
      {projectId === null ? null : (
        <NewTaskDock
          key={projectId}
          client={client}
          projectId={projectId}
          run={run}
          onCreated={async (created) => {
            // The draft is created from any tab, so switch to the workbench where it is now
            // selected; the Runtime stays the only writer of task state.
            await loadTaskList(created.projectId);
            update({ taskId: created.id, status: null, createToken: state.createToken + 1 });
            setTab('tasks');
          }}
        />
      )}
      </div>
    </div>
    </UiSettingsProvider>
  );
}

interface CommonProps {
  readonly client: RuntimeClient;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
  readonly update: (patch: Partial<ConsoleState>) => void;
}

function TasksTab(props: CommonProps & {
  readonly projectId: string | null;
  readonly tasks: readonly TaskView[];
  readonly taskId: string | null;
  readonly status: TaskStatusView | null;
  readonly adapter: string;
  readonly permissionMode: 'FULL' | 'STRICT';
  readonly attentions: readonly AttentionView[];
  readonly reloadAttentions: () => Promise<void>;
  readonly openProjects: () => void;
  readonly reloadTasks: (projectId: string) => Promise<void>;
  readonly createToken: number;
  readonly detailToken: number;
  readonly loadDetail: (projectId: string, taskId: string) => Promise<void>;
  readonly live: boolean;
}) {
  const { client, projectId, tasks, taskId, status, adapter, permissionMode, update } = props;
  const actions = usePendingAction(props.run);
  // Every action here is scoped to one Task, so a slow task.run never blocks another Task's
  // controls. Creation lives in the bottom dock with its own key.
  const run: CommonProps['run'] = (label, action) => actions.run(taskId ?? 'none', label, action);
  const busy = actions.pending.has(taskId ?? 'none');
  const selectedRef = useRef(taskId);
  selectedRef.current = taskId;
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const navigationFocus = useRef<{ view: 'list' | 'detail'; taskId: string } | null>(null);
  useEffect(() => {
    const request = navigationFocus.current;
    if (request === null) return;
    if (request.view === 'detail' && request.taskId === taskId) backButtonRef.current?.focus();
    if (request.view === 'list' && taskId === null) {
      (document.getElementById(`task-row-${request.taskId}`)
        ?? document.getElementById('task-list-heading'))?.focus();
    }
    navigationFocus.current = null;
  }, [taskId]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('default');
  // Archived Tasks are kept out of the default view; the toggle reveals the same list the Runtime
  // returned with `includeArchived`, so nothing is hidden from a user who asks for it.
  const [showArchived, setShowArchived] = useState(false);
  const [authorization, setAuthorization] = useState<ResultCommitAuthorizationView | null>(null);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [verifyReport, setVerifyReport] = useState<VerificationRunView | null>(null);
  /** Empty means "the newest Execution that actually started a Session". */
  const [transcriptExecutionId, setTranscriptExecutionId] = useState<string | null>(null);
  const task = tasks.find((candidate) => candidate.id === taskId) ?? null;
  const archived = task?.archivedAt != null;
  const canPause = task !== null && ['RUNNING', 'WAITING_FOR_USER'].includes(task.state);
  const canResume = task?.state === 'PAUSED';
  const canCancel = task !== null && ['DRAFT', 'BLOCKED', 'READY', 'RUNNING', 'WAITING_FOR_USER',
    'PAUSING', 'PAUSED', 'EXECUTED', 'FAILED'].includes(task.state);
  const canArchive = task !== null && !archived && !['RUNNING', 'WAITING_FOR_USER', 'PAUSING',
    'PAUSED', 'CANCELLING', 'RECOVERY_REQUIRED'].includes(task.state);
  // A draft created in the bottom dock is always shown, even if a search or state filter would
  // hide it, so the workbench cannot look like the creation did nothing.
  useEffect(() => { setQuery(''); setFilter('all'); }, [props.createToken]);
  useEffect(() => {
    setTranscriptExecutionId(null);
    setAuthorization(null);
    setRunResult(null);
    setVerifyReport(null);
  }, [taskId]);
  const latestExecution = status?.executions[0] ?? null;
  const integrationBatches = status?.integrations ?? [];
  const operations = status?.operations ?? [];
  const integratedBatch = integrationBatches.find((batch) => batch.state === 'INTEGRATED') ?? null;
  const inFlightIntegration = integrationBatches.find((batch) =>
    ['CREATED', 'PREPARING', 'VERIFYING', 'INTEGRATING_DEV', 'RECOVERY_REQUIRED']
      .includes(batch.state)) ?? null;
  // Integration needs a PASSED Task verification of exactly this revision and result commit, and
  // needs `dev` to be advanceable: the Runtime still refuses if the ref moved or is checked out.
  const passedVerification = status?.verifications.find((verification) =>
    verification.state === 'PASSED'
    && verification.revisionId === task?.currentRevision.id
    && verification.testedCommit === latestExecution?.resultCommit) ?? null;
  const canIntegrate = task?.state === 'EXECUTED' && passedVerification !== null
    && integratedBatch === null && inFlightIntegration === null;
  const canCapture = task?.state === 'RUNNING'
    && latestExecution?.state === 'RUNNING' && latestExecution.resourceHeld
    && latestExecution.session?.state === 'EXITED';
  const taskAttentions = props.attentions.filter((attention) => attention.taskId === taskId);
  const waiting = taskAttentions.filter((attention) => attention.status === 'OPEN').length;
  const verifying = status?.verifications.some((verification) =>
    ['QUEUED', 'RUNNING'].includes(verification.state)) ?? false;
  const nextStep = task === null ? '' : archived ? '任务已归档，记录与现场保留；可在「更多操作」中取消归档。'
    : waiting > 0 ? '有待处理请求，请在下方回答。其他任务不受影响。'
    : task.state === 'DRAFT' ? '提交后进入自动调度，满足依赖、冲突与容量条件才会启动。创建草稿不会自动运行。'
    : task.state === 'READY' ? '任务等待调度；可手动尝试启动，Runtime 会核对依赖、冲突与容量，不保证立即运行。'
    : task.state === 'BLOCKED' ? '正在等待上游依赖满足。展开下方任务依赖，查看尚未满足的条件。'
    : inFlightIntegration !== null ? '集成尚未完成，请查看下方独立集成验证与合入记录。'
    : verifying ? '任务验证进行中。下方显示实际步骤，可请求取消；完成前不能合入 dev。'
    : canCapture ? 'Agent 会话已退出。若有代码变更，可提交成果，然后独立验证。'
    : task.state === 'EXECUTED' ? (integratedBatch === null
      ? (passedVerification === null
        ? '成果已提交。先在固定 commit 上运行任务验证；验证通过后才能合入 dev。'
        : '验证已通过，可以合入 dev。合入会产生独立集成验证，并只在通过后移动 dev 引用。')
      : '已合入 dev。dev → main 的稳定提升是另一条流程，不在这一步内。')
    : task.state === 'SUCCEEDED' ? '成果已合入 dev；这不等于已提升到稳定的 main。'
    : task.state === 'RUNNING' ? '查看下方执行过程；可暂停（保留现场、稍后继续）或终止。'
    : task.state === 'PAUSED' ? '任务已暂停，provider 进程已确认退出；「继续」会在同一工作树新建一次执行并复用该会话。'
    : task.state === 'CANCELLED' ? '任务已终止，不会自动重开；需要重做请新建任务。'
    : task.state === 'RECOVERY_REQUIRED' ? '执行状态需要人工检查，请展开执行与验证记录查看原因；不会自动重试。'
    : task.state === 'FAILED' ? '本次执行失败，请查看执行记录中的错误原因。'
    : `当前状态：${labelValue(task.state)}。详情以 Runtime 记录为准。`;
  // A failed start can leave an Execution without a Session; such an attempt has no process to
  // show, so only attempts with a recorded Session are offered here.
  const transcriptExecutions = (status?.executions ?? [])
    .filter((execution) => execution.session !== null);
  const transcriptExecution = transcriptExecutions
    .find((execution) => execution.executionId === transcriptExecutionId)
    ?? transcriptExecutions[0] ?? null;

  if (projectId === null) {
    return <section className="card empty-state">
      <span className="empty-symbol" aria-hidden="true">＋</span>
      <h2>从一个项目开始</h2>
      <p className="muted">添加本地 Git 仓库，然后描述你想完成的改动。</p>
      <button className="primary" type="button" onClick={props.openProjects}>前往添加项目</button>
    </section>;
  }

  if (task === null) {
    return <TaskList tasks={tasks} attentions={props.attentions} query={query} filter={filter}
      showArchived={showArchived} live={props.live} setQuery={setQuery} setFilter={setFilter}
      sort={sort} setSort={setSort} setShowArchived={setShowArchived}
      selectTask={(id) => {
        navigationFocus.current = { view: 'detail', taskId: id };
        update({ taskId: id, status: null });
      }} />;
  }

  return (
      <section className="card grow task-detail">
        <button
          type="button"
          className="back-link"
          ref={backButtonRef}
          onClick={() => {
            navigationFocus.current = { view: 'list', taskId: task.id };
            update({ taskId: null, status: null });
          }}
        >
          ← 返回任务列表
        </button>
        <div className="section-heading"><h2>任务 #{task.displayNumber}</h2>
              <TaskStateBadge state={task.state} live={props.live && !canCapture} />
              {canCapture ? <span className="muted hint">会话已退出 · 等待提交成果</span> : null}
              {task.archivedAt === null ? null : <span className="muted">已归档</span>}</div>
            <p className="muted hint">规格 r{task.currentRevision.number} · 状态版本 v{task.version}</p>
            <pre className="spec">{task.currentRevision.specification}</pre>
            {task.currentRevision.constraints.length === 0 ? null : (
              <ul>
                {task.currentRevision.constraints.map((constraint) => (
                  <li key={constraint.id}>{constraint.text}</li>
                ))}
              </ul>
            )}

            <div className="next-step"><span className="eyebrow">下一步</span><p>{nextStep}</p></div>
            <div className="actions task-actions" aria-label="任务操作">
              <button
                type="button"
                className="primary"
                hidden={task.state !== 'DRAFT' || archived}
                disabled={busy}
                onClick={() => {
                  void run('正在提交', async () => {
                    await client.command({
                      command: 'task.submit',
                      commandId: crypto.randomUUID(),
                      projectId,
                      taskId: task.id,
                      expectedVersion: task.version,
                    });
                    await props.reloadTasks(projectId);
                    await props.loadDetail(projectId, task.id);
                  });
                }}
              >
                提交为就绪
              </button>

              <label className="inline" hidden={!['READY', 'PAUSED'].includes(task.state) || archived}>
                Agent
                <select
                  value={adapter}
                  onChange={(event) => update({ adapter: event.target.value })}
                >
                  <option value="pi">pi</option>
                </select>
              </label>
              <button
                type="button"
                className="primary"
                hidden={task.state !== 'READY' || archived}
                disabled={busy}
                onClick={() => {
                  void run('正在运行任务', async () => {
                    const result = await client.command<unknown>({
                      command: 'task.run',
                      commandId: crypto.randomUUID(),
                      projectId,
                      taskId: task.id,
                      expectedTaskVersion: task.version,
                      adapterId: adapter,
                    });
                    if (selectedRef.current === task.id) setRunResult(JSON.stringify(result, null, 2));
                    await props.reloadTasks(projectId);
                    await props.loadDetail(projectId, task.id);
                  });
                }}
              >
                启动 Agent
              </button>

              <button
                type="button"
                hidden={!canPause || archived}
                disabled={busy}
                title="协作停止 provider 进程并确认静止；保留工作树与会话，可用「继续」在同一工作树恢复"
                onClick={() => {
                  void run('正在暂停任务', async () => {
                    await client.command({
                      command: 'task.pause',
                      commandId: crypto.randomUUID(),
                      projectId,
                      taskId: task.id,
                      expectedVersion: task.version,
                    });
                    await props.reloadTasks(projectId);
                    await props.loadDetail(projectId, task.id);
                  });
                }}
              >
                暂停
              </button>

              <button
                type="button"
                className="primary"
                hidden={!canResume || archived}
                disabled={busy}
                title="在同一工作树新建一次执行，并复用已暂停会话的 provider conversation"
                onClick={() => {
                  void run('正在继续任务', async () => {
                    const result = await client.command<unknown>({
                      command: 'task.resume',
                      commandId: crypto.randomUUID(),
                      projectId,
                      taskId: task.id,
                      expectedVersion: task.version,
                      adapterId: adapter,
                    });
                    if (selectedRef.current === task.id) setRunResult(JSON.stringify(result, null, 2));
                    await props.reloadTasks(projectId);
                    await props.loadDetail(projectId, task.id);
                  });
                }}
              >
                继续
              </button>

              <button
                type="button"
                className="primary"
                hidden={!canCapture || archived}
                disabled={busy}
                title={canCapture ? '提交工作树中的成果，Runtime 会再次核对静止证据与差异' : '等待 Agent 退出且可捕获成果后使用'}
                onClick={() => {
                  if (permissionMode === 'FULL') {
                    void run('正在提交成果', async () => {
                      await client.command({
                        command: 'task.result.capture',
                        commandId: crypto.randomUUID(),
                        projectId,
                        taskId: task.id,
                      });
                      await props.reloadTasks(projectId);
                      await props.loadDetail(projectId, task.id);
                    });
                  } else {
                    void run('正在准备成果提交', async () => {
                      const prepared = await client.command<ResultCommitAuthorizationView>({
                        command: 'task.result.prepare',
                        commandId: crypto.randomUUID(),
                        projectId,
                        taskId: task.id,
                      });
                      if (selectedRef.current === task.id) setAuthorization(prepared);
                    });
                  }
                }}
              >
                {permissionMode === 'FULL' ? '提交成果' : '准备成果提交'}
              </button>

              <button
                type="button"
                className={passedVerification === null ? 'primary' : ''}
                hidden={task.state !== 'EXECUTED' || archived}
                disabled={busy || verifying || inFlightIntegration !== null}
                title="提交成果后，在固定 commit 上独立运行验证；后台运行，可在此查看进度并取消"
                onClick={() => {
                  void run('正在排队验证', async () => {
                    // The UI asks for the background form so the long command does not block the
                    // page; progress and cancel stay on the same command face as the CLI.
                    const started = await client.command<{ verificationId: string }>({
                      command: 'task.verify',
                      commandId: crypto.randomUUID(),
                      projectId,
                      taskId: task.id,
                      background: true,
                    });
                    if (selectedRef.current === task.id) setVerifyReport(null);
                    await props.loadDetail(projectId, task.id);
                    if (selectedRef.current === task.id) setRunResult(JSON.stringify(started));
                  });
                }}
              >
                {verifying ? '验证进行中…' : passedVerification !== null ? '重新验证' : '验证任务'}
              </button>
              <button
                type="button"
                className="primary"
                hidden={!canIntegrate || archived}
                disabled={busy || verifying}
                title={canIntegrate
                  ? '把这次任务的成果 commit 合入 dev：先在独立工作树里合并，再跑独立集成验证，通过后才移动 dev 引用'
                  : '需要 EXECUTED 任务、该成果 commit 的验证已通过、且没有进行中或已完成的合入'}
                onClick={() => {
                  void run('正在合入 dev（独立集成验证可能需要一段时间）', async () => {
                    const report = await client.command<{ state: string }>({
                      command: 'task.integrate',
                      commandId: crypto.randomUUID(),
                      projectId,
                      taskId: task.id,
                      expectedVersion: task.version,
                    });
                    if (selectedRef.current === task.id) setVerifyReport(null);
                    await props.reloadTasks(projectId);
                    await props.loadDetail(projectId, task.id);
                    if (report.state !== 'INTEGRATED') {
                      throw new Error(`合入未完成：${labelValue(report.state)}`
                        + '（dev 未被改动，请看下方集成记录）');
                    }
                  });
                }}
              >
                合入 dev
              </button>
              <details key={task.id} className="secondary-actions">
                <summary>更多操作</summary>
                <div className="actions">
                  <button type="button" className="danger" disabled={busy || !canCancel || archived}
                    title="终止是终态；协作停止 Agent，保留工作树与全部记录"
                    onClick={() => {
                      void run('正在终止任务', async () => {
                        await client.command({ command: 'task.cancel', commandId: crypto.randomUUID(),
                          projectId, taskId: task.id, expectedVersion: task.version });
                        await props.reloadTasks(projectId);
                        await props.loadDetail(projectId, task.id);
                      });
                    }}>终止</button>
                  <button type="button" disabled={busy || (!archived && !canArchive)}
                    title="归档只隐藏任务，不删除记录或回收工作树；可随时取消归档"
                    onClick={() => {
                      void run(archived ? '正在取消归档' : '正在归档任务', async () => {
                        await client.command({ command: archived ? 'task.unarchive' : 'task.archive',
                          commandId: crypto.randomUUID(), projectId, taskId: task.id,
                          expectedVersion: task.version });
                        await props.reloadTasks(projectId);
                        await props.loadDetail(projectId, task.id);
                      });
                    }}>{archived ? '取消归档' : '归档'}</button>
                </div>
                <TaskRetryControls
                  client={client}
                  projectId={projectId}
                  task={task}
                  executions={status?.executions ?? []}
                  onChanged={async () => {
                    await props.reloadTasks(projectId);
                    await props.loadDetail(projectId, task.id);
                  }}
                  run={run}
                />
                <p className="muted hint">终止后不能重开；归档只隐藏任务，不删除记录或回收工作树。</p>
              </details>
            </div>
            {waiting === 0 ? null : (
              <AttentionTab key={task.id} client={client} projectId={projectId}
                attentions={taskAttentions} run={props.run} update={update} reload={props.reloadAttentions} />
            )}
            {operations.length === 0 ? null : (
              <section className="card nested operation-panel">
                <h3>长命令进度 <span className="muted hint">Runtime 记录的事实步骤</span></h3>
                <details className="hint"><summary>进度与取消说明</summary><p className="muted">
                  只显示实际步骤，不预估百分比。事件流中断时每 5 秒刷新进度。
                  取消是协作停止，确认静止后才结束；无法确认则保留占用并需要人工处理。
                </p></details>
                <div className="table-scroll"><table>
                  <thead>
                    <tr><th>类型</th><th>状态</th><th>最新步骤</th><th>更新时间</th><th>操作</th></tr>
                  </thead>
                  <tbody>
                    {operations.map((operation) => {
                      const active = operation.state === 'PLANNED'
                        || operation.state === 'IN_PROGRESS';
                      return (
                        <tr key={operation.operationId}>
                          <td>{operationKindLabel(operation.kind)}
                            <div className="muted mono">{operation.operationId.slice(0, 8)}</div></td>
                          <td>{operationStateLabel(operation)}
                            {operation.cancelRequestedAt === null ? null : (
                              <div className="muted">已请求取消</div>
                            )}</td>
                          <td>{operationLatestStep(operation)}
                            {operation.liveOutput === null || operation.liveOutput === undefined
                              ? null
                              : <div className="muted">
                                  {liveOutputLabel(operation.liveOutput)}
                                </div>}
                            {operation.result === null ? null : (
                              <details><summary>结果详情</summary><pre>{JSON.stringify(operation.result, null, 2)}</pre></details>
                            )}</td>
                          <td>{new Date(operation.updatedAt).toLocaleTimeString('zh-CN')}</td>
                          <td>{active ? (
                            <button
                              type="button"
                              disabled={busy}
                              title="取消这个长命令：只在该进程组确认静止后才记录终态；运行类会协作暂停任务"
                              onClick={() => {
                                void run('正在取消长命令', async () => {
                                  await client.command({
                                    command: 'task.operation.cancel',
                                    commandId: crypto.randomUUID(),
                                    projectId,
                                    taskId: task.id,
                                    operationId: operation.operationId,
                                  });
                                  await props.reloadTasks(projectId);
                                  await props.loadDetail(projectId, task.id);
                                });
                              }}
                            >
                              取消
                            </button>
                          ) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table></div>
                <details>
                  <summary>全部步骤</summary>
                  {operations.map((operation) => (
                    <div key={operation.operationId}>
                      <h4>{operationKindLabel(operation.kind)} · {operation.operationId.slice(0, 8)}</h4>
                      {operation.steps.length === 0 ? <p className="muted">还没有记录步骤。</p> : (
                        <ol>
                          {operation.steps.map((step) => (
                            <li key={step.stepKey}>
                              <code>{step.step}</code> {labelValue(step.state)}
                              {' · '}{new Date(step.recordedAt).toLocaleTimeString('zh-CN')}
                              {step.detail === null ? null
                                : <span className="muted"> {JSON.stringify(step.detail)}</span>}
                            </li>
                          ))}
                        </ol>
                      )}
                    </div>
                  ))}
                </details>
              </section>
            )}
            {permissionMode === 'FULL' || authorization === null
              || authorization.taskVersion !== task.version ? null : (
              <div className="card nested">
                <h3>成果提交授权</h3>
                <p className="muted">
                  请在确认差异符合预期后再继续。HEAD 或变更集发生任何变化都会使此授权失效。
                </p>
                <dl className="kv">
                  <dt>预期 HEAD</dt><dd className="mono">{authorization.expectedHead}</dd>
                  <dt>变更指纹</dt><dd className="mono">{authorization.changeFingerprint}</dd>
                  <dt>已静止</dt><dd>{authorization.quiescent ? '是' : '否'}</dd>
                  <dt>工作区</dt><dd className="mono">{authorization.workspacePath}</dd>
                </dl>
                <button
                  type="button"
                  disabled={busy || !authorization.quiescent}
                  onClick={() => {
                    void run('正在提交成果', async () => {
                      await client.command({
                        command: 'task.result.commit',
                        commandId: crypto.randomUUID(),
                        projectId,
                        taskId: task.id,
                        authorizationId: authorization.id,
                        confirm: true,
                      });
                      if (selectedRef.current === task.id) setAuthorization(null);
                      await props.reloadTasks(projectId);
                      await props.loadDetail(projectId, task.id);
                    });
                  }}
                >
                  确认成果提交
                </button>
              </div>
            )}

            {runResult === null ? null : (
              <details>
                <summary>最近一次任务运行 · 原始响应</summary>
                <pre>{runResult}</pre>
              </details>
            )}
            {verifyReport === null ? null : (
              <details>
                <summary>最近一次验证：{labelValue(verifyReport.state)}
                  {verifyReport.outcomeCode === null ? '' : `（${labelValue(verifyReport.outcomeCode)}）`}</summary>
                <pre>{JSON.stringify(verifyReport.evidence, null, 2)}</pre>
              </details>
            )}

            {status === null ? <p className="muted" role="status">正在加载详情…</p> : (
              <>
                {latestExecution?.error == null ? null : <p className="error" role="alert">
                  执行失败：{latestExecution.error.code} {latestExecution.error.message ?? ''}
                </p>}
                {status.verifications[0] === undefined ? null : <div className="verification-summary">
                  <span>最近验证</span>
                  <span className={`state state-${status.verifications[0].state.toLowerCase()}`}>
                    {labelValue(status.verifications[0].state)}</span>
                  <code>{status.verifications[0].testedCommit.slice(0, 10)}</code>
                  <span className="muted">{status.verifications[0].outcomeCode ?? '等待结果'} · 不代表集成或发布</span>
                </div>}
                <CompletionNotes executions={status.executions} />
                <details className="execution-evidence">
                <summary>执行、验证与集成记录 · {status.executions.length} 次执行 / {status.verifications.length} 次验证 / {integrationBatches.length} 次合入</summary>
                <h3>执行记录</h3>
                <div className="table-scroll"><table>
                  <thead>
                    <tr><th>#</th><th>状态</th><th>适配器</th><th>模型/思考</th><th>会话</th><th>占用资源</th>
                      <th>基线</th><th>失败原因</th></tr>
                  </thead>
                  <tbody>
                    {status.executions.map((execution) => (
                      <tr key={execution.executionId}>
                        <td>{execution.attemptNumber}</td>
                        <td>{labelValue(execution.state)}</td>
                        <td>{execution.adapterId}@{execution.adapterVersion}</td>
                        <td>
                          {execution.agentConfig === null ? '默认'
                            : [execution.agentConfig.model ?? execution.agentConfig.provider ?? '默认',
                              execution.agentConfig.thinkingLevel].filter((part) => part !== null).join(' · ')}
                        </td>
                        <td>{execution.session === null ? '—' : labelValue(execution.session.state)}</td>
                        <td>{execution.resourceHeld ? '是' : '否'}</td>
                        <td className="mono">{execution.baseCommit.slice(0, 10)}</td>
                        <td>
                          {execution.error === null ? '—' : (
                            <>
                              <span className="mono">{execution.error.code}</span>
                              {execution.error.message === undefined ? null : (
                                <div className="muted">{execution.error.message}</div>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                    {status.executions.length === 0 ? (
                      <tr><td colSpan={8} className="muted">暂无执行记录。</td></tr>
                    ) : null}
                  </tbody>
                </table></div>

                <h3>验证记录</h3>
                <div className="table-scroll"><table>
                  <thead>
                    <tr><th>状态</th><th>结果</th><th>提交</th><th>策略</th><th>结束时间</th></tr>
                  </thead>
                  <tbody>
                    {status.verifications.map((verification) => (
                      <tr key={verification.verificationId}>
                        <td><span className={`state state-${verification.state.toLowerCase()}`}>
                          {labelValue(verification.state)}</span></td>
                        <td>{verification.outcomeCode === null ? '—' : labelValue(verification.outcomeCode)}</td>
                        <td className="mono">{verification.testedCommit.slice(0, 10)}</td>
                        <td className="mono">{verification.policyDigest.slice(0, 10)}</td>
                        <td>{verification.endedAt === null ? '—'
                          : new Date(verification.endedAt).toLocaleTimeString('zh-CN')}</td>
                      </tr>
                    ))}
                    {status.verifications.length === 0 ? (
                      <tr><td colSpan={5} className="muted">暂无验证记录。</td></tr>
                    ) : null}
                  </tbody>
                </table></div>
                <h3>集成批次 · dev
                  <span className="muted hint">只读 · 一个批次可以跨多个任务（ADR-0053）</span></h3>
                <IntegrationBatchTable batches={integrationBatches}
                  emptyNote="本任务还没有集成批次；成果不会自动进入 dev。" />
                <p className="muted hint">
                  成员按 task_id 顺序列出；批级 INTEGRATED 只说明已合入 dev，不等于已进 main。
                </p>
                </details>

                <section className="process-panel">
                <h3>Agent 会话与执行过程
                  <span className="muted hint">只读过程 + 原生终端（同一 CLI 命令面）</span></h3>
                {transcriptExecution === null || transcriptExecution.session === null ? (
                  <p className="muted">
                    这个任务还没有启动过 Agent 会话，因此没有执行过程可显示。
                  </p>
                ) : (
                  <>
                    <div className="actions">
                      <label htmlFor="transcript-execution">执行</label>
                      <select
                        id="transcript-execution"
                        value={transcriptExecution.executionId}
                        onChange={(event) => { setTranscriptExecutionId(event.target.value); }}
                      >
                        {transcriptExecutions.map((execution) => (
                          <option key={execution.executionId} value={execution.executionId}>
                            第 {execution.attemptNumber} 次 · {labelValue(execution.state)}
                            {execution.session === null ? '' : ` · 会话${labelValue(execution.session.state)}`}
                          </option>
                        ))}
                      </select>
                    </div>
                    <TerminalPanel
                      key={`terminal-${transcriptExecution.session.sessionId}`}
                      client={client}
                      projectId={projectId}
                      sessionId={transcriptExecution.session.sessionId}
                      refreshToken={props.detailToken}
                      run={props.run}
                    />
                    <TranscriptPanel
                      key={transcriptExecution.session.sessionId}
                      client={client}
                      sessionId={transcriptExecution.session.sessionId}
                      executionState={transcriptExecution.state}
                      sessionState={transcriptExecution.session.state}
                      run={props.run}
                    />
                  </>
                )}
                </section>

                <section className="process-panel">
                  <RevisionDeliveryPanel
                    client={client}
                    projectId={projectId}
                    taskId={task.id}
                    taskVersion={status?.task.version ?? task.version}
                    adapterId={adapter}
                    refreshToken={props.detailToken}
                    run={props.run}
                    onChanged={async () => { await props.loadDetail(projectId, task.id); }}
                  />
                  <DependencyPanel
                    client={client}
                    projectId={projectId}
                    taskId={task.id}
                    tasks={tasks}
                    refreshToken={props.detailToken}
                    run={props.run}
                  />
                  <PromotionPanel
                    client={client}
                    projectId={projectId}
                    taskId={task.id}
                    refreshToken={props.detailToken}
                    run={props.run}
                  />
                </section>
                <section className="process-panel">
                  <ScheduleExplainPanel
                    client={client}
                    projectId={projectId}
                    taskId={task.id}
                    tasks={tasks}
                    refreshToken={props.detailToken}
                    run={props.run}
                  />
                  <ImpactTaskPanel
                    client={client}
                    projectId={projectId}
                    taskId={task.id}
                    tasks={tasks}
                    refreshToken={props.detailToken}
                    run={props.run}
                  />
                </section>
              </>
            )}
      </section>
  );
}

function ScheduleTab(props: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  readonly repoRoot: string;
  readonly tasks: readonly TaskView[];
  readonly refreshToken: number;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  return (
    <>
      <section className="card">
        <SchedulePanel client={props.client} projectId={props.projectId} tasks={props.tasks}
          refreshToken={props.refreshToken} run={props.run} />
      </section>
      <section className="card">
        <CapacityPanel client={props.client} projectId={props.projectId} tasks={props.tasks}
          refreshToken={props.refreshToken} run={props.run} />
      </section>
      <section className="card">
        <ImpactPolicyPanel client={props.client} projectId={props.projectId} repoRoot={props.repoRoot}
          refreshToken={props.refreshToken} run={props.run} />
      </section>
    </>
  );
}

/**
 * Executions whose Session recorded a completion, with the Runtime's note rendered as what it is:
 * an observation about the *shape of the ending*. It is not "the Agent is waiting for an answer"
 * and it is not a failure; the recorded outcome says which of those it is.
 */
function CompletionNotes({ executions }: {
  readonly executions: TaskStatusView['executions'];
}) {
  const recorded = executions.flatMap((execution) => execution.session?.completion == null
    ? [] : [{ execution, completion: execution.session.completion }]);
  if (recorded.length === 0) return null;
  return (
    <section className="card nested completion-notes">
      <h3>会话结束注记 <span className="muted hint">FOUNDATION-056</span></h3>
      <p className="muted hint">{completionNoteHeading}</p>
      <ul className="list">
        {recorded.map(({ execution, completion }) => (
          <li key={execution.executionId} className="muted">
            第 {execution.attemptNumber} 次执行 · 记录结果
            {' '}{completion.outcome === 'SUCCESS' ? '成功' : '失败'}
            {completion.failure === null ? null
              : <> · <span className="mono">{completion.failure.code}</span>
                {completion.failure.message === undefined
                  ? null : <div className="hint">{completion.failure.message}</div>}</>}
            {completion.note === null ? (
              <div className="hint">这个结束形态没有需要注记的地方。</div>
            ) : (
              <>
                <div className="mono note-code">{completion.note.code}</div>
                <div className="hint">{completionNoteSummary(completion.note)}</div>
                <div className="hint mono">
                  工具调用 {completion.note.facts.toolCallCount} · 最后文本截断
                  {' '}{completion.note.facts.finalAssistantTextTruncated ? '是' : '否'} · 停止原因
                  {' '}{completion.note.facts.finalAssistantStopReason ?? '未报告'}
                </div>
                <details>
                  <summary className="hint">Runtime 记录的原始注记与事实</summary>
                  <pre>{JSON.stringify(completion.note, null, 2)}</pre>
                </details>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One answer this form can produce. Questions left untouched are reported to the Agent as
 * unanswered, not as declined, so an empty submission is impossible: the button stays disabled.
 */
type QuestionnaireInputAnswer =
  | { readonly type: 'CHOICES'; readonly questionIndex: number; readonly choiceIndexes: readonly number[] }
  | { readonly type: 'TEXT'; readonly questionIndex: number; readonly text: string };

/**
 * One questionnaire Attention. Each question is answered either by picking options or by writing a
 * custom answer; the two are mutually exclusive per question, so what will be sent is never
 * ambiguous.
 */
function QuestionnaireCard(props: {
  readonly questionnaire: QuestionnaireView;
  readonly busy: boolean;
  readonly onSubmit: (answers: readonly QuestionnaireInputAnswer[]) => void;
  readonly onCancel: () => void;
}) {
  const { questionnaire, busy, onSubmit, onCancel } = props;
  const formId = useId();
  const [choices, setChoices] = useState<ReadonlyArray<readonly number[]>>(
    () => questionnaire.questions.map(() => []));
  const [texts, setTexts] = useState<readonly string[]>(() => questionnaire.questions.map(() => ''));

  const setChoice = (questionIndex: number, optionIndex: number, multiSelect: boolean) => {
    setChoices((previous) => previous.map((selected, index) => {
      if (index !== questionIndex) return selected;
      if (!multiSelect) return [optionIndex];
      return selected.includes(optionIndex)
        ? selected.filter((candidate) => candidate !== optionIndex)
        : [...selected, optionIndex];
    }));
    setTexts((previous) => previous.map((text, index) => (index === questionIndex ? '' : text)));
  };
  const setText = (questionIndex: number, text: string) => {
    setTexts((previous) => previous.map((value, index) => (index === questionIndex ? text : value)));
    setChoices((previous) => previous.map((selected, index) => (index === questionIndex ? [] : selected)));
  };
  const answered: QuestionnaireInputAnswer[] = [];
  questionnaire.questions.forEach((_question, questionIndex) => {
    const text = (texts[questionIndex] ?? '').trim();
    if (text.length > 0) {
      answered.push({ type: 'TEXT', questionIndex, text });
      return;
    }
    const selected = choices[questionIndex] ?? [];
    if (selected.length > 0) {
      answered.push({ type: 'CHOICES', questionIndex, choiceIndexes: [...selected] });
    }
  });

  return (
    <div>
      {questionnaire.questions.map((question, questionIndex) => (
        <div key={`${question.header}-${questionIndex}`} className="question">
          <h3>{questionIndex + 1}. [{question.header}] {question.question}
            {question.multiSelect ? ' （可多选）' : ''}</h3>
          <ul className="options">
            {question.options.map((option, optionIndex) => {
              const selected = (choices[questionIndex] ?? []).includes(optionIndex);
              return (
                <li key={option.label}>
                  <label className={`question-option ${selected ? 'selected' : ''}`}>
                    <input
                      type={question.multiSelect ? 'checkbox' : 'radio'}
                      name={`${formId}-${questionIndex}`}
                      checked={selected}
                      disabled={busy}
                      onChange={() => setChoice(questionIndex, optionIndex, question.multiSelect)}
                    />
                    <span><strong>{optionIndex + 1}. {option.label}</strong> — {option.description}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          <input
            aria-label={`第 ${questionIndex + 1} 题：自定义回答`}
            value={texts[questionIndex] ?? ''}
            placeholder="或用自己的话回答（会覆盖上面的选择）"
            disabled={busy}
            onChange={(event) => setText(questionIndex, event.target.value)}
          />
        </div>
      ))}
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy || answered.length === 0}
          onClick={() => onSubmit(answered)}
        >
          {answered.length === 0 ? '请至少回答一个问题' : `发送 ${answered.length} 个回答`}
        </button>
        <button type="button" className="danger" disabled={busy} onClick={onCancel}>拒绝回答</button>
      </div>
    </div>
  );
}

export function AttentionTab(props: CommonProps & {
  readonly projectId: string | null;
  readonly attentions: readonly AttentionView[];
  readonly reload: () => Promise<void>;
  readonly tasks?: readonly TaskView[];
  readonly selectTask?: (taskId: string) => void;
}) {
  const { client, projectId, attentions, reload } = props;
  const actions = usePendingAction(props.run);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (projectId === null) return <p className="muted">请选择一个项目。</p>;
  const open = attentions.filter((attention) => attention.status === 'OPEN');
  // A prose-question wait looks like an ordinary Attention in `attention.list`, but it is a different
  // fact: the provider process already exited and there is no dialog to answer (ADR-0043). Counting
  // them here is what keeps the two kinds distinguishable at the top of the inbox.
  const proseWaits = open.filter(isProseQuestionWait).length;
  return (
    <section className="card">
      <div className="section-heading"><h2>需要你的回答 <span className="badge">{open.length}</span></h2>
        <button type="button" disabled={actions.pending.has('reload')}
          onClick={() => { void actions.run('reload', '正在刷新待处理请求', reload); }}>刷新</button></div>
      <p className="muted hint">
        只暂停对应任务。权限请求与问卷的回答会由 Runtime 投递给 Agent。
        散文提问等待是另一类：provider 进程已退出，没有等待中的对话框，记录回答不会送进会话，
        解除后需要显式重新运行才能让 Agent 继续。
      </p>
      {proseWaits === 0 ? null : (
        <p className="muted hint">其中 {proseWaits} 条是散文提问等待
          （启发式识别：无工具调用且以问号结束），用 attention resolve 的两种记录方式结束。</p>
      )}
      <ul className="list">
        {open.map((attention) => {
          const questionnaire = questionnaireFromPrompt(attention.prompt);
          // Read structurally, exactly like the questionnaire: a payload that does not validate is
          // not treated as a prose question, so it can never be resolved through that route.
          const proseWait = readProseQuestionWait(attention.prompt);
          const busy = actions.pending.has(attention.id);
          const run: CommonProps['run'] = (label, action) => actions.run(attention.id, label, action);
          const task = props.tasks?.find((item) => item.id === attention.taskId);
          return (
          <li key={attention.id} className="card nested attention-card">
            <fieldset disabled={busy} aria-label="回答 Agent 请求" aria-busy={busy}>
            <div className="row-head">
              {props.selectTask === undefined ? null : <button type="button" onClick={() => props.selectTask?.(attention.taskId)}>
                {task === undefined ? '查看关联任务' : `任务 #${task.displayNumber}`}
              </button>}
              <span className={`state state-${attention.kind.toLowerCase()}`}>
                {labelValue(attention.kind)}
              </span>
              {proseWait === null ? null : (
                <span className="state state-waiting_for_user">散文提问等待 · provider 已退出</span>
              )}
              <span className="muted mono">{labelValue(attention.responseType)}</span>
              <span className="muted">{new Date(attention.createdAt).toLocaleTimeString('zh-CN')}</span>
            </div>
            {proseWait === null ? null : (
              <ProseQuestionWaitCard
                wait={proseWait}
                busy={busy}
                resolve={(request) => client.command<ProseQuestionResolutionResultView>(
                  proseQuestionResolveCommand({
                    projectId,
                    attentionId: attention.id,
                    commandId: crypto.randomUUID(),
                    resolution: request.resolution,
                    ...(request.text === undefined ? {} : { text: request.text }),
                    ...(request.note === undefined ? {} : { note: request.note }),
                  }))}
                onResolved={reload}
              />
            )}
            {proseWait !== null ? null : (<>
            {questionnaire !== null ? (
              <QuestionnaireCard
                questionnaire={questionnaire}
                busy={busy}
                onSubmit={(answers) => {
                  void run('正在回答', async () => {
                    await client.command({
                      command: 'attention.answer', commandId: crypto.randomUUID(),
                      projectId, attentionId: attention.id,
                      answer: { type: 'QUESTIONNAIRE', answer: { version: 1, answers: [...answers] } },
                    });
                    await reload();
                  });
                }}
                onCancel={() => {
                  void run('正在取消请求', async () => {
                    await client.command({
                      command: 'attention.answer', commandId: crypto.randomUUID(),
                      projectId, attentionId: attention.id, answer: { type: 'CANCEL' },
                    });
                    await reload();
                  });
                }}
              />
            ) : null}
            {questionnaire === null ? <pre>{JSON.stringify(attention.prompt, null, 2)}</pre> : null}
            {questionnaire !== null ? null : attention.responseType === 'CONFIRM' ? (
              <div className="actions">
                <button type="button" onClick={() => {
                  void run('正在回答', async () => {
                    await client.command({
                      command: 'attention.answer', commandId: crypto.randomUUID(),
                      projectId, attentionId: attention.id,
                      answer: { type: 'CONFIRM', confirmed: true },
                    });
                    await reload();
                  });
                }}>允许</button>
                <button type="button" className="danger" onClick={() => {
                  void run('正在回答', async () => {
                    await client.command({
                      command: 'attention.answer', commandId: crypto.randomUUID(),
                      projectId, attentionId: attention.id,
                      answer: { type: 'CONFIRM', confirmed: false },
                    });
                    await reload();
                  });
                }}>拒绝</button>
              </div>
            ) : (
              <div className="actions">
                <input
                  aria-label="回答内容"
                  value={answers[attention.id] ?? ''}
                  placeholder="输入回答"
                  onChange={(event) => setAnswers({ ...answers, [attention.id]: event.target.value })}
                />
                <button type="button" onClick={() => {
                  const value = answers[attention.id] ?? '';
                  void run('正在回答', async () => {
                    await client.command({
                      command: 'attention.answer', commandId: crypto.randomUUID(),
                      projectId, attentionId: attention.id, answer: { type: 'VALUE', value },
                    });
                    await reload();
                  });
                }}>发送</button>
              </div>
            )}
            {questionnaire === null ? (
              <button type="button" onClick={() => {
                void run('正在取消请求', async () => {
                  await client.command({
                    command: 'attention.answer', commandId: crypto.randomUUID(),
                    projectId, attentionId: attention.id, answer: { type: 'CANCEL' },
                  });
                  await reload();
                });
              }}>拒绝回答此请求</button>
            ) : null}
            </>)}
            {busy && proseWait === null ? <p className="muted" role="status">正在发送回答…</p> : null}
            </fieldset>
          </li>
          );
        })}
        {open.length === 0 ? <li className="muted">目前没有待处理请求。</li> : null}
      </ul>
      <details>
        <summary className="muted">{attentions.length - open.length} 个已回答或已关闭</summary>
        <ul className="list">
          {attentions.filter((attention) => attention.status !== 'OPEN').map((attention) => (
            <li key={attention.id} className="muted">
              {labelValue(attention.kind)} · {labelValue(attention.status)} ·{' '}
              {new Date(attention.createdAt).toLocaleTimeString('zh-CN')}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function EventsTab({ frames, cursor, following, streamStatus, update, clear }: {
  readonly frames: readonly EventEnvelopeView[];
  readonly cursor: number | null;
  readonly following: boolean;
  readonly streamStatus: string;
  readonly update: (patch: Partial<ConsoleState>) => void;
  readonly clear: () => void;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [frames]);
  return (
    <section className="card">
      <h2>Runtime 事件流 · 全部项目</h2>
      <div className="actions">
        <span className={streamStatus === 'live' ? 'state state-ready' : 'state'}>
          {streamStatusLabel(streamStatus)}
        </span>
        <span className="muted">游标 {cursor ?? '—'}</span>
        <button type="button" onClick={() => update({ following: !following })}>
          {following ? '停止跟随' : '继续跟随'}
        </button>
        <button type="button" onClick={clear}>清空</button>
      </div>
      <p className="muted">
        帧来自 CLI 使用的同一订阅。游标采用排他语义，因此使用此处显示的游标重连时，
        既不会重复也不会遗漏事件。
      </p>
      <ol className="events">
        {frames.map((event) => {
          const summary = isSchedulingEventType(event.eventType)
            ? schedulingEventSummary(event.eventType, event.payload) : null;
          return (
            <li key={event.eventId} className={summary === null ? undefined : 'scheduling-event'}>
              <span className="mono muted">{event.sequence}</span>
              <span className="mono">{event.eventType}</span>
              <span className="muted">{event.aggregateType}</span>
              <span className="truncate mono">{JSON.stringify(event.payload)}</span>
              {summary === null ? null : (
                <span className="event-human muted">
                  {summary}
                  <span className="hint">（原始 payload 即为左侧 JSON，未被改写）</span>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <div ref={endRef} />
    </section>
  );
}

/**
 * Agent configuration: the Runtime resolves environment > project > global > adapter default,
 * and this panel edits the persisted scopes through the same command plane the CLI uses. It
 * never computes precedence itself — `effective` and `sources` come from the Runtime, so the UI
 * cannot disagree with what a Task will actually run.
 */
function ProjectTab({ client, permissionMode, projectId, tasks, refreshToken, run, reloadProjects }: CommonProps & {
  readonly permissionMode: 'FULL' | 'STRICT';
  readonly projectId: string | null;
  readonly tasks: readonly TaskView[];
  /** Bumped by stream events, so a dependency verdict or a promotion record appears without a reload. */
  readonly refreshToken: number;
  readonly reloadProjects: () => Promise<void>;
}) {
  const actions = usePendingAction(run);
  const busy = actions.pending.size > 0;
  const [path, setPath] = useState('');
  const [devRepoPath, setDevRepoPath] = useState('');
  const [identity, setIdentity] = useState<ProjectIdentityView | null>(null);
  const [policy, setPolicy] = useState<VerificationPolicyView | null>(null);
  const [confirmation, setConfirmation] = useState('');
  /** The refusal of one `project.trust`, with the Runtime's stable code kept verbatim. */
  const [trustError, setTrustError] = useState<string | null>(null);
  return (
    <>
    <section className="card">
      <h2>添加本地项目</h2>
      <p className="muted">输入 Git 仓库的绝对路径，检查仓库与验证策略后添加。不会修改仓库文件。</p>
      <fieldset disabled={busy} aria-busy={busy}>
      <div className="actions">
        <input
          aria-label="Git 仓库绝对路径"
          value={path}
          placeholder="/仓库/路径"
          onChange={(event) => {
            setPath(event.target.value); setIdentity(null); setPolicy(null); setConfirmation('');
            setTrustError(null);
          }}
        />
        <button className="primary" type="button" disabled={path.trim().length === 0} onClick={() => {
          void actions.run('project', '正在检查项目与策略', async () => {
            setIdentity(null); setPolicy(null); setConfirmation(''); setTrustError(null);
            // The dev clone is inspected when one was typed, so the identity this form echoes back
            // below already carries the verification the user reviewed (ADR-0047 D05).
            const [identity, policy] = await Promise.all([
              client.command<ProjectIdentityView>(projectInspectCommand({ path, devRepoPath })),
              client.command<VerificationPolicyView>({ command: 'project.verificationPolicy', path }),
            ]);
            setIdentity(identity); setPolicy(policy);
          });
        }}>检查项目</button>
      </div>

      <ProjectDevRepoInput value={devRepoPath} busy={busy}
        onChange={(value) => {
          // Changing the path invalidates the inspected identity, exactly like the main path does:
          // the trust request echoes the identity the user actually reviewed.
          setDevRepoPath(value); setIdentity(null); setPolicy(null); setConfirmation('');
          setTrustError(null);
        }} />

      {identity === null ? null : (
        <dl className="kv">
          <dt>仓库根目录</dt><dd className="mono">{identity.repoRoot}</dd>
          <dt>main 引用</dt><dd className="mono">{identity.mainRef}</dd>
          <dt>对象格式</dt><dd>{identity.objectFormat}</dd>
          <dt>HEAD</dt><dd className="mono">{identity.headCommit}</dd>
          <dt>dev 基线</dt>
          <dd className="mono">{identity.devRef} {identity.devCommit?.slice(0, 12) ?? '—'}
            <div className="muted">{identity.devRefPresent
              ? '这个 ref 存在：Task 工作树与集成目标都从它建基线'
              : '这个 ref 不存在：信任会被拒绝为 DEV_REF_MISSING'}</div></dd>
          <DevRepoInspectionRows inspection={identity.devRepoPath} />
        </dl>
      )}

      {policy === null ? null : (
        <>
          <h3>验证策略</h3>
          {policy.state === 'ABSENT'
            ? <p className="muted">
                main 引用上没有策略。您仍可信任此项目，但在
                .codeestra/policies/verification.json 存在之前，验证会被拒绝。
              </p>
            : (
              <table>
                <thead><tr><th>ID</th><th>命令</th><th>工作目录</th><th>超时</th></tr></thead>
                <tbody>
                  {policy.policy?.commands.map((command) => (
                    <tr key={command.id}>
                      <td>{command.id}</td>
                      <td className="mono">{command.argv.join(' ')}</td>
                      <td className="mono">{command.cwd}</td>
                      <td>{command.timeoutSeconds} 秒</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          <p className="muted mono">main {policy.mainCommit.slice(0, 12)} · 摘要 {policy.digest?.slice(0, 12) ?? '—'}</p>
        </>
      )}

      {identity === null || policy === null ? null : (
        <div className="card nested">
          <h3>{permissionMode === 'FULL' ? '添加此项目' : '信任此项目'}</h3>
          <p>{permissionMode === 'FULL'
            ? '全权限模式已默认开启：Agent、未知工具、验证命令和 Git 钩子均以当前用户权限运行，不再请求确认。'
            : '严格模式下，信任后 Agent、验证命令和 Git 钩子可使用您的用户权限运行，但提交和未知工具仍受门禁。'}
          </p>
          {permissionMode === 'FULL' ? null : (
            <input
              aria-label="输入 TRUST 以确认信任"
              value={confirmation}
              placeholder="输入 TRUST 以确认"
              onChange={(event) => setConfirmation(event.target.value)}
            />
          )}
          <p className="muted hint">
            这个按钮会发出 <span className="mono">project.trust</span>：把你审阅的身份（含上面的 dev clone
            核验结果）、验证策略 digest 与 dev clone 路径一起提交。dev clone 路径为空时按钮不可点
            —— 信任需要它，界面不假装成功；路径能不能用由 Runtime 核验。
          </p>
          {trustError === null ? null : (
            <p className="error" role="alert">信任被拒绝：{trustError}</p>
          )}
          <button
            type="button"
            className="primary"
            disabled={!canSubmitProjectTrust({ permissionMode, confirmation, devRepoPath })}
            onClick={() => {
              void actions.run('project', '正在添加项目', async () => {
                setTrustError(null);
                try {
                  await client.command(projectTrustCommand({
                    path,
                    expectedIdentity: identity,
                    devRepoPath,
                    expectedVerificationPolicy: projectTrustPolicyConfirmation(policy),
                  }));
                } catch (caught) {
                  // A refusal writes nothing: the stable code is the answer, kept next to its note.
                  const code = caught instanceof Error && 'code' in caught
                    ? String(caught.code) : 'UNKNOWN';
                  const message = caught instanceof Error ? caught.message : String(caught);
                  setTrustError(projectTrustRejectionNotice(code, message));
                  return;
                }
                setConfirmation('');
                await reloadProjects();
              });
            }}
          >
            {permissionMode === 'FULL' ? '添加项目' : '信任项目'}
          </button>
        </div>
      )}
      </fieldset>
    </section>
    {projectId === null ? null : (
      <section className="card">
        <DependencyPanel client={client} projectId={projectId} taskId={null} tasks={tasks}
          refreshToken={refreshToken} run={run} />
        <IntegrationBatchPanel client={client} projectId={projectId} tasks={tasks}
          refreshToken={refreshToken} run={run} />
        <PromotionPanel client={client} projectId={projectId} taskId={null}
          refreshToken={refreshToken} run={run} />
      </section>
    )}
    </>
  );
}
