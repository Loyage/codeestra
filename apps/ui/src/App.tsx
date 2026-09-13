import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RuntimeClient, describeError } from './api.js';
import type {
  AttentionView,
  EventEnvelopeView,
  RepositoryIdentityView,
  ResultCommitAuthorizationView,
  StreamFrame,
  TaskStatusView,
  TaskView,
  TrustedProjectView,
  VerificationPolicyView,
  VerificationRunView,
} from './types.js';

type Tab = 'tasks' | 'attention' | 'events' | 'project';

const tabLabels: Record<Tab, string> = {
  tasks: '任务',
  attention: '待处理',
  events: '事件',
  project: '项目',
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
};

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
      <div className="centered">
        <TokenForm onSubmit={(value) => {
          window.sessionStorage.setItem(tokenKey, value);
          setToken(value);
        }} />
      </div>
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
  busy: string | null;
  error: string | null;
  notice: string | null;
  adapter: string;
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
    error: null, notice: null, adapter: 'pi', attentionToken: 0, detailToken: 0,
  });
  const cursorRef = useRef<number | null>(null);

  const update = useCallback((patch: Partial<ConsoleState>) => {
    setState((previous) => ({ ...previous, ...patch }));
  }, []);

  const run = useCallback(async (label: string, action: () => Promise<void>): Promise<void> => {
    update({ busy: label, error: null });
    try {
      await action();
    } catch (error) {
      update({ error: describeError(error) });
    } finally {
      update({ busy: null });
    }
  }, [update]);

  const loadProjects = useCallback(async (): Promise<void> => {
    const projects = await client.command<TrustedProjectView[]>({ command: 'project.list' });
    const requested = state.projectId ?? initialProjectId;
    const projectId = projects.find((project) => project.id === requested)?.id
      ?? projects[0]?.id ?? null;
    const tasks = projectId === null
      ? []
      : await client.command<TaskView[]>({ command: 'task.list', projectId });
    const attentions = projectId === null
      ? []
      : await client.command<AttentionView[]>({ command: 'attention.list', projectId });
    update({ projects, projectId, tasks, attentions });
  }, [client, initialProjectId, state.projectId, update]);

  const loadTaskDetail = useCallback(async (projectId: string, taskId: string): Promise<void> => {
    const status = await client.command<TaskStatusView>({ command: 'task.status', projectId, taskId });
    update({ status, tasks: state.tasks.map((task) => (task.id === taskId ? status.task : task)) });
  }, [client, state.tasks, update]);

  const loadTaskList = useCallback(async (projectId: string): Promise<void> => {
    const tasks = await client.command<TaskView[]>({ command: 'task.list', projectId });
    update({ tasks });
  }, [client, update]);

  useEffect(() => {
    // Runs once on mount; later reloads are explicit user actions.
    void run('正在加载项目', loadProjects);
  }, []);


  const onFrame = useCallback((frame: StreamFrame) => {
    if (frame.type === 'subscribed') {
      cursorRef.current = frame.cursor;
      setState((previous) => ({ ...previous, cursor: frame.cursor, streamStatus: 'live' }));
      return;
    }
    if (frame.type === 'heartbeat') {
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
      || frame.event.eventType.startsWith('TaskState')
      || frame.event.eventType.startsWith('AgentSession')
      || frame.event.eventType.startsWith('Verification')
      || frame.event.eventType.startsWith('ResultCommit');
    setState((previous) => ({
      ...previous,
      cursor: frame.cursor,
      streamStatus: 'live',
      frames: [...previous.frames, frame.event].slice(-300),
      attentionToken: invalidatesAttention ? previous.attentionToken + 1 : previous.attentionToken,
      detailToken: invalidatesDetail ? previous.detailToken + 1 : previous.detailToken,
    }));
  }, []);

  // Refresh the Attention inbox whenever the stream says it changed.
  useEffect(() => {
    const projectId = state.projectId;
    if (projectId === null) return;
    void client.command<AttentionView[]>({ command: 'attention.list', projectId })
      .then((attentions) => { update({ attentions }); })
      .catch(() => { /* Failures surface through the command banner. */ });
  }, [client, state.projectId, state.attentionToken, update]);

  // Keep the selected task detail (Execution/Session/verifications) live as well.
  useEffect(() => {
    const projectId = state.projectId;
    const taskId = state.taskId;
    if (projectId === null || taskId === null) return;
    void client.command<TaskStatusView>({ command: 'task.status', projectId, taskId })
      .then((status) => {
        setState((previous) => ({
          ...previous,
          status,
          tasks: previous.tasks.map((task) => (task.id === taskId ? status.task : task)),
        }));
      })
      .catch(() => { /* Failures surface through the command banner. */ });
  }, [client, state.projectId, state.taskId, state.detailToken]);

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

  return (
    <div className="app">
      <header>
        <div className="brand">
          <strong>Codeestra</strong>
          <span className="muted">本地 Runtime 控制台</span>
        </div>
        <div className="header-controls">
          <select
            value={projectId ?? ''}
            onChange={(event) => {
              const next = event.target.value === '' ? null : event.target.value;
              update({ projectId: next, taskId: null, status: null });
              if (next !== null) void run('正在加载任务', async () => {
                await loadTaskList(next);
                const attentions = await client.command<AttentionView[]>(
                  { command: 'attention.list', projectId: next });
                update({ attentions });
              });
            }}
          >
            <option value="">未选择项目</option>
            {state.projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <button type="button" onClick={() => { void run('正在刷新', loadProjects); }}>
            刷新
          </button>
        </div>
      </header>

      <nav>
        {(['tasks', 'attention', 'events', 'project'] as const).map((name) => (
          <button
            key={name}
            type="button"
            className={tab === name ? 'tab active' : 'tab'}
            onClick={() => setTab(name)}
          >
            {tabLabels[name]}
            {name === 'attention' && state.attentions.some((item) => item.status === 'OPEN')
              ? <span className="badge">{state.attentions.filter((item) => item.status === 'OPEN').length}</span>
              : null}
          </button>
        ))}
        {state.busy === null ? null : <span className="muted busy">{state.busy}…</span>}
      </nav>

      {state.error === null ? null : (
        <div className="banner error">
          {state.error}
          <button type="button" onClick={() => update({ error: null })}>关闭</button>
        </div>
      )}
      {state.notice === null ? null : (
        <div className="banner notice">
          {state.notice}
          <button type="button" onClick={() => update({ notice: null })}>关闭</button>
        </div>
      )}

      <main>
        {tab === 'tasks' ? (
          <TasksTab
            client={client}
            projectId={projectId}
            tasks={state.tasks}
            taskId={state.taskId}
            status={state.status}
            adapter={state.adapter}
            run={run}
            update={update}
            reloadTasks={async (id) => { await loadTaskList(id); }}
            loadDetail={loadTaskDetail}
          />
        ) : null}
        {tab === 'attention' ? (
          <AttentionTab
            client={client}
            projectId={projectId}
            attentions={state.attentions}
            run={run}
            update={update}
            reload={async () => {
              if (projectId === null) return;
              const attentions = await client.command<AttentionView[]>(
                { command: 'attention.list', projectId });
              update({ attentions });
            }}
          />
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
        {tab === 'project' ? (
          <ProjectTab client={client} run={run} update={update} reloadProjects={loadProjects} />
        ) : null}
      </main>

      <footer className="muted">
        关闭此页面不会停止 Runtime 或任何任务。目前尚未实现任务取消或暂停；令牌在 Runtime
        停止前一直有效。
        {selectedTask === null ? null : ` 当前选择：任务 #${selectedTask.displayNumber}。`}
      </footer>
    </div>
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
  readonly reloadTasks: (projectId: string) => Promise<void>;
  readonly loadDetail: (projectId: string, taskId: string) => Promise<void>;
}) {
  const { client, projectId, tasks, taskId, status, adapter, run, update } = props;
  const [specification, setSpecification] = useState('');
  const [authorization, setAuthorization] = useState<ResultCommitAuthorizationView | null>(null);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [verifyReport, setVerifyReport] = useState<VerificationRunView | null>(null);
  const task = tasks.find((candidate) => candidate.id === taskId) ?? null;

  if (projectId === null) {
    return <p className="muted">请先在<strong>项目</strong>标签页中信任一个项目。</p>;
  }

  return (
    <div className="columns">
      <section className="card">
        <h2>任务</h2>
        <ul className="list">
          {tasks.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                className={candidate.id === taskId ? 'row active' : 'row'}
                onClick={() => {
                  update({ taskId: candidate.id, status: null });
                  void run('正在加载任务', () => props.loadDetail(projectId, candidate.id));
                }}
              >
                <span>#{candidate.displayNumber}</span>
                <span className={`state state-${candidate.state.toLowerCase()}`}>
                  {labelValue(candidate.state)}
                </span>
                <span className="truncate">{candidate.currentRevision.specification}</span>
                <span className="muted">v{candidate.version}</span>
              </button>
            </li>
          ))}
          {tasks.length === 0 ? <li className="muted">暂无任务。</li> : null}
        </ul>
        <h3>新建任务</h3>
        <textarea
          rows={3}
          value={specification}
          placeholder="描述一项具体的改动"
          onChange={(event) => setSpecification(event.target.value)}
        />
        <button
          type="button"
          disabled={specification.trim().length === 0}
          onClick={() => {
            void run('正在创建任务', async () => {
              await client.command({
                command: 'task.create',
                commandId: crypto.randomUUID(),
                projectId,
                specification,
                constraints: [],
                kind: 'DEVELOPMENT',
              });
              setSpecification('');
              await props.reloadTasks(projectId);
            });
          }}
        >
          创建草稿
        </button>
      </section>

      <section className="card grow">
        {task === null ? <p className="muted">请选择一个任务。</p> : (
          <>
            <h2>#{task.displayNumber} · {labelValue(task.state)} · v{task.version}</h2>
            <pre className="spec">{task.currentRevision.specification}</pre>
            {task.currentRevision.constraints.length === 0 ? null : (
              <ul>
                {task.currentRevision.constraints.map((constraint) => (
                  <li key={constraint.id}>{constraint.text}</li>
                ))}
              </ul>
            )}

            <div className="actions">
              <button
                type="button"
                disabled={task.state !== 'DRAFT'}
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
                提交（转为就绪）
              </button>

              <label className="inline">
                适配器
                <select
                  value={adapter}
                  onChange={(event) => update({ adapter: event.target.value })}
                >
                  <option value="pi">pi</option>
                </select>
              </label>
              <button
                type="button"
                disabled={task.state !== 'READY'}
                onClick={() => {
                  void run('正在运行任务（暂不支持取消）', async () => {
                    const result = await client.command<unknown>({
                      command: 'task.run',
                      commandId: crypto.randomUUID(),
                      projectId,
                      taskId: task.id,
                      expectedTaskVersion: task.version,
                      adapterId: adapter,
                    });
                    setRunResult(JSON.stringify(result, null, 2));
                    await props.reloadTasks(projectId);
                    await props.loadDetail(projectId, task.id);
                  });
                }}
              >
                运行任务…
              </button>

              <button
                type="button"
                onClick={() => {
                  void run('正在准备成果提交', async () => {
                    const prepared = await client.command<ResultCommitAuthorizationView>({
                      command: 'task.result.prepare',
                      commandId: crypto.randomUUID(),
                      projectId,
                      taskId: task.id,
                    });
                    setAuthorization(prepared);
                  });
                }}
              >
                准备成果提交
              </button>

              <button
                type="button"
                onClick={() => {
                  void run('正在执行验证', async () => {
                    const report = await client.command<VerificationRunView>({
                      command: 'task.verify',
                      commandId: crypto.randomUUID(),
                      projectId,
                      taskId: task.id,
                    });
                    setVerifyReport(report);
                    await props.loadDetail(projectId, task.id);
                  });
                }}
              >
                验证任务
              </button>
            </div>

            {authorization === null ? null : (
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
                  disabled={!authorization.quiescent}
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
                      setAuthorization(null);
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
              <details open>
                <summary>最近一次任务运行</summary>
                <pre>{runResult}</pre>
              </details>
            )}
            {verifyReport === null ? null : (
              <details open>
                <summary>最近一次验证：{labelValue(verifyReport.state)}
                  {verifyReport.outcomeCode === null ? '' : `（${labelValue(verifyReport.outcomeCode)}）`}</summary>
                <pre>{JSON.stringify(verifyReport.evidence, null, 2)}</pre>
              </details>
            )}

            {status === null ? <p className="muted">正在加载详情…</p> : (
              <>
                <h3>执行记录</h3>
                <table>
                  <thead>
                    <tr><th>#</th><th>状态</th><th>适配器</th><th>会话</th><th>占用资源</th><th>基线</th></tr>
                  </thead>
                  <tbody>
                    {status.executions.map((execution) => (
                      <tr key={execution.executionId}>
                        <td>{execution.attemptNumber}</td>
                        <td>{labelValue(execution.state)}</td>
                        <td>{execution.adapterId}@{execution.adapterVersion}</td>
                        <td>{execution.session === null ? '—' : labelValue(execution.session.state)}</td>
                        <td>{execution.resourceHeld ? '是' : '否'}</td>
                        <td className="mono">{execution.baseCommit.slice(0, 10)}</td>
                      </tr>
                    ))}
                    {status.executions.length === 0 ? (
                      <tr><td colSpan={6} className="muted">暂无执行记录。</td></tr>
                    ) : null}
                  </tbody>
                </table>

                <h3>验证记录</h3>
                <table>
                  <thead>
                    <tr><th>状态</th><th>结果</th><th>提交</th><th>策略</th><th>结束时间</th></tr>
                  </thead>
                  <tbody>
                    {status.verifications.map((verification) => (
                      <tr key={verification.verificationId}>
                        <td>{labelValue(verification.state)}</td>
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
                </table>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function AttentionTab(props: CommonProps & {
  readonly projectId: string | null;
  readonly attentions: readonly AttentionView[];
  readonly reload: () => Promise<void>;
}) {
  const { client, projectId, attentions, run, reload } = props;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (projectId === null) return <p className="muted">请选择一个项目。</p>;
  const open = attentions.filter((attention) => attention.status === 'OPEN');
  return (
    <section className="card">
      <h2>待处理请求</h2>
      <p className="muted">
        在此等待的 Agent 只会暂停自己的任务。回答会记录为意图和类型化操作；敏感文本绝不会写入事件。
      </p>
      <button type="button" onClick={() => { void run('正在刷新待处理请求', reload); }}>刷新</button>
      <ul className="list">
        {open.map((attention) => (
          <li key={attention.id} className="card nested">
            <div className="row-head">
              <span className={`state state-${attention.kind.toLowerCase()}`}>
                {labelValue(attention.kind)}
              </span>
              <span className="muted mono">{labelValue(attention.responseType)}</span>
              <span className="muted">{new Date(attention.createdAt).toLocaleTimeString('zh-CN')}</span>
            </div>
            <pre>{JSON.stringify(attention.prompt, null, 2)}</pre>
            {attention.responseType === 'CONFIRM' ? (
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
            <button type="button" onClick={() => {
              void run('正在取消请求', async () => {
                await client.command({
                  command: 'attention.answer', commandId: crypto.randomUUID(),
                  projectId, attentionId: attention.id, answer: { type: 'CANCEL' },
                });
                await reload();
              });
            }}>取消此请求</button>
          </li>
        ))}
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
      <h2>事件流</h2>
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
        {frames.map((event) => (
          <li key={event.eventId}>
            <span className="mono muted">{event.sequence}</span>
            <span className="mono">{event.eventType}</span>
            <span className="muted">{event.aggregateType}</span>
            <span className="truncate mono">{JSON.stringify(event.payload)}</span>
          </li>
        ))}
      </ol>
      <div ref={endRef} />
    </section>
  );
}

function ProjectTab({ client, run, reloadProjects }: CommonProps & {
  readonly reloadProjects: () => Promise<void>;
}) {
  const [path, setPath] = useState('');
  const [identity, setIdentity] = useState<RepositoryIdentityView | null>(null);
  const [policy, setPolicy] = useState<VerificationPolicyView | null>(null);
  const [confirmation, setConfirmation] = useState('');
  return (
    <section className="card">
      <h2>项目</h2>
      <div className="actions">
        <input
          value={path}
          placeholder="/仓库/路径"
          onChange={(event) => setPath(event.target.value)}
        />
        <button type="button" onClick={() => {
          void run('正在检查', async () => {
            setIdentity(await client.command<RepositoryIdentityView>({ command: 'project.inspect', path }));
          });
        }}>检查</button>
        <button type="button" onClick={() => {
          void run('正在读取策略', async () => {
            setPolicy(await client.command<VerificationPolicyView>(
              { command: 'project.verificationPolicy', path }));
          });
        }}>验证策略</button>
      </div>

      {identity === null ? null : (
        <dl className="kv">
          <dt>仓库根目录</dt><dd className="mono">{identity.repoRoot}</dd>
          <dt>main 引用</dt><dd className="mono">{identity.mainRef}</dd>
          <dt>对象格式</dt><dd>{identity.objectFormat}</dd>
          <dt>HEAD</dt><dd className="mono">{identity.headCommit}</dd>
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
          <h3>信任此项目</h3>
          <p>
            信任后，Agent、验证命令和 Git 钩子可以使用您的用户权限运行。
            这不会授权提交、更新 main、推送或使用未知工具。
          </p>
          <input
            value={confirmation}
            placeholder="输入 TRUST 以确认"
            onChange={(event) => setConfirmation(event.target.value)}
          />
          <button
            type="button"
            className="danger"
            disabled={confirmation !== 'TRUST'}
            onClick={() => {
              void run('正在信任项目', async () => {
                await client.command({
                  command: 'project.trust',
                  path,
                  expectedIdentity: identity,
                  expectedVerificationPolicy: policy.state === 'PRESENT'
                    ? { state: 'PRESENT', mainCommit: policy.mainCommit, digest: policy.digest }
                    : { state: 'ABSENT', mainCommit: policy.mainCommit },
                });
                setConfirmation('');
                await reloadProjects();
              });
            }}
          >
            信任项目
          </button>
        </div>
      )}
    </section>
  );
}
