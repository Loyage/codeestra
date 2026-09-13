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
        This page needs the token the Runtime printed. Run <code>codeestra ui</code> again and open
        the address it shows, or paste the token from the <code>#token=…</code> fragment here.
      </p>
      <input
        type="password"
        value={value}
        placeholder="Runtime token"
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit">Connect</button>
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
    void run('Loading projects', loadProjects);
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
          <span className="muted">local runtime console</span>
        </div>
        <div className="header-controls">
          <select
            value={projectId ?? ''}
            onChange={(event) => {
              const next = event.target.value === '' ? null : event.target.value;
              update({ projectId: next, taskId: null, status: null });
              if (next !== null) void run('Loading tasks', async () => {
                await loadTaskList(next);
                const attentions = await client.command<AttentionView[]>(
                  { command: 'attention.list', projectId: next });
                update({ attentions });
              });
            }}
          >
            <option value="">No project</option>
            {state.projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <button type="button" onClick={() => { void run('Refreshing', loadProjects); }}>
            Refresh
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
            {name}
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
          <button type="button" onClick={() => update({ error: null })}>dismiss</button>
        </div>
      )}
      {state.notice === null ? null : (
        <div className="banner notice">
          {state.notice}
          <button type="button" onClick={() => update({ notice: null })}>dismiss</button>
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
        Closing this page does not stop the Runtime or any Task. Task cancel/pause is not implemented
        yet, and the token is valid until the Runtime stops.
        {selectedTask === null ? null : ` Selected task #${selectedTask.displayNumber}.`}
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
    return <p className="muted">Trust a project in the <strong>project</strong> tab first.</p>;
  }

  return (
    <div className="columns">
      <section className="card">
        <h2>Tasks</h2>
        <ul className="list">
          {tasks.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                className={candidate.id === taskId ? 'row active' : 'row'}
                onClick={() => {
                  update({ taskId: candidate.id, status: null });
                  void run('Loading task', () => props.loadDetail(projectId, candidate.id));
                }}
              >
                <span>#{candidate.displayNumber}</span>
                <span className={`state state-${candidate.state.toLowerCase()}`}>{candidate.state}</span>
                <span className="truncate">{candidate.currentRevision.specification}</span>
                <span className="muted">v{candidate.version}</span>
              </button>
            </li>
          ))}
          {tasks.length === 0 ? <li className="muted">No tasks yet.</li> : null}
        </ul>
        <h3>New task</h3>
        <textarea
          rows={3}
          value={specification}
          placeholder="Describe one focused change"
          onChange={(event) => setSpecification(event.target.value)}
        />
        <button
          type="button"
          disabled={specification.trim().length === 0}
          onClick={() => {
            void run('Creating task', async () => {
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
          Create draft
        </button>
      </section>

      <section className="card grow">
        {task === null ? <p className="muted">Select a task.</p> : (
          <>
            <h2>#{task.displayNumber} · {task.state} · v{task.version}</h2>
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
                  void run('Submitting', async () => {
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
                Submit (READY)
              </button>

              <label className="inline">
                adapter
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
                  void run('Running task (no cancel yet)', async () => {
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
                Run task…
              </button>

              <button
                type="button"
                onClick={() => {
                  void run('Preparing result commit', async () => {
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
                Prepare result commit
              </button>

              <button
                type="button"
                onClick={() => {
                  void run('Running verification', async () => {
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
                Verify task
              </button>
            </div>

            {authorization === null ? null : (
              <div className="card nested">
                <h3>Result commit authorization</h3>
                <p className="muted">
                  Confirm only after checking the differences you expect. Any change to HEAD or the
                  change set invalidates this authorization.
                </p>
                <dl className="kv">
                  <dt>expected HEAD</dt><dd className="mono">{authorization.expectedHead}</dd>
                  <dt>change fingerprint</dt><dd className="mono">{authorization.changeFingerprint}</dd>
                  <dt>quiescent</dt><dd>{authorization.quiescent ? 'yes' : 'no'}</dd>
                  <dt>workspace</dt><dd className="mono">{authorization.workspacePath}</dd>
                </dl>
                <button
                  type="button"
                  disabled={!authorization.quiescent}
                  onClick={() => {
                    void run('Committing result', async () => {
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
                  Confirm result commit
                </button>
              </div>
            )}

            {runResult === null ? null : (
              <details open>
                <summary>Last task run</summary>
                <pre>{runResult}</pre>
              </details>
            )}
            {verifyReport === null ? null : (
              <details open>
                <summary>Last verification: {verifyReport.state}
                  {verifyReport.outcomeCode === null ? '' : ` (${verifyReport.outcomeCode})`}</summary>
                <pre>{JSON.stringify(verifyReport.evidence, null, 2)}</pre>
              </details>
            )}

            {status === null ? <p className="muted">Loading detail…</p> : (
              <>
                <h3>Executions</h3>
                <table>
                  <thead>
                    <tr><th>#</th><th>state</th><th>adapter</th><th>session</th><th>held</th><th>base</th></tr>
                  </thead>
                  <tbody>
                    {status.executions.map((execution) => (
                      <tr key={execution.executionId}>
                        <td>{execution.attemptNumber}</td>
                        <td>{execution.state}</td>
                        <td>{execution.adapterId}@{execution.adapterVersion}</td>
                        <td>{execution.session === null ? '—' : execution.session.state}</td>
                        <td>{execution.resourceHeld ? 'yes' : 'no'}</td>
                        <td className="mono">{execution.baseCommit.slice(0, 10)}</td>
                      </tr>
                    ))}
                    {status.executions.length === 0 ? (
                      <tr><td colSpan={6} className="muted">No executions yet.</td></tr>
                    ) : null}
                  </tbody>
                </table>

                <h3>Verifications</h3>
                <table>
                  <thead>
                    <tr><th>state</th><th>outcome</th><th>commit</th><th>policy</th><th>ended</th></tr>
                  </thead>
                  <tbody>
                    {status.verifications.map((verification) => (
                      <tr key={verification.verificationId}>
                        <td>{verification.state}</td>
                        <td>{verification.outcomeCode ?? '—'}</td>
                        <td className="mono">{verification.testedCommit.slice(0, 10)}</td>
                        <td className="mono">{verification.policyDigest.slice(0, 10)}</td>
                        <td>{verification.endedAt === null ? '—'
                          : new Date(verification.endedAt).toLocaleTimeString()}</td>
                      </tr>
                    ))}
                    {status.verifications.length === 0 ? (
                      <tr><td colSpan={5} className="muted">No verification runs yet.</td></tr>
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
  if (projectId === null) return <p className="muted">Select a project.</p>;
  const open = attentions.filter((attention) => attention.status === 'OPEN');
  return (
    <section className="card">
      <h2>Attention inbox</h2>
      <p className="muted">
        An Agent waiting here pauses only its own Task. Answers are recorded as Intent plus a typed
        Operation; sensitive text is never written into events.
      </p>
      <button type="button" onClick={() => { void run('Refreshing attentions', reload); }}>Refresh</button>
      <ul className="list">
        {open.map((attention) => (
          <li key={attention.id} className="card nested">
            <div className="row-head">
              <span className={`state state-${attention.kind.toLowerCase()}`}>{attention.kind}</span>
              <span className="muted mono">{attention.responseType}</span>
              <span className="muted">{new Date(attention.createdAt).toLocaleTimeString()}</span>
            </div>
            <pre>{JSON.stringify(attention.prompt, null, 2)}</pre>
            {attention.responseType === 'CONFIRM' ? (
              <div className="actions">
                <button type="button" onClick={() => {
                  void run('Answering', async () => {
                    await client.command({
                      command: 'attention.answer', commandId: crypto.randomUUID(),
                      projectId, attentionId: attention.id,
                      answer: { type: 'CONFIRM', confirmed: true },
                    });
                    await reload();
                  });
                }}>Allow</button>
                <button type="button" className="danger" onClick={() => {
                  void run('Answering', async () => {
                    await client.command({
                      command: 'attention.answer', commandId: crypto.randomUUID(),
                      projectId, attentionId: attention.id,
                      answer: { type: 'CONFIRM', confirmed: false },
                    });
                    await reload();
                  });
                }}>Deny</button>
              </div>
            ) : (
              <div className="actions">
                <input
                  value={answers[attention.id] ?? ''}
                  placeholder="Answer text"
                  onChange={(event) => setAnswers({ ...answers, [attention.id]: event.target.value })}
                />
                <button type="button" onClick={() => {
                  const value = answers[attention.id] ?? '';
                  void run('Answering', async () => {
                    await client.command({
                      command: 'attention.answer', commandId: crypto.randomUUID(),
                      projectId, attentionId: attention.id, answer: { type: 'VALUE', value },
                    });
                    await reload();
                  });
                }}>Send</button>
              </div>
            )}
            <button type="button" onClick={() => {
              void run('Cancelling attention', async () => {
                await client.command({
                  command: 'attention.answer', commandId: crypto.randomUUID(),
                  projectId, attentionId: attention.id, answer: { type: 'CANCEL' },
                });
                await reload();
              });
            }}>Cancel this request</button>
          </li>
        ))}
        {open.length === 0 ? <li className="muted">Nothing is waiting for you.</li> : null}
      </ul>
      <details>
        <summary className="muted">{attentions.length - open.length} answered or closed</summary>
        <ul className="list">
          {attentions.filter((attention) => attention.status !== 'OPEN').map((attention) => (
            <li key={attention.id} className="muted">
              {attention.kind} · {attention.status} · {new Date(attention.createdAt).toLocaleTimeString()}
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
      <h2>Event stream</h2>
      <div className="actions">
        <span className={streamStatus === 'live' ? 'state state-ready' : 'state'}>{streamStatus}</span>
        <span className="muted">cursor {cursor ?? '—'}</span>
        <button type="button" onClick={() => update({ following: !following })}>
          {following ? 'Stop' : 'Follow'}
        </button>
        <button type="button" onClick={clear}>Clear</button>
      </div>
      <p className="muted">
        Frames come from the same subscription the CLI uses. A cursor is exclusive, so reconnecting
        with the cursor shown here repeats nothing and skips nothing.
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
      <h2>Project</h2>
      <div className="actions">
        <input
          value={path}
          placeholder="/path/to/repository"
          onChange={(event) => setPath(event.target.value)}
        />
        <button type="button" onClick={() => {
          void run('Inspecting', async () => {
            setIdentity(await client.command<RepositoryIdentityView>({ command: 'project.inspect', path }));
          });
        }}>Inspect</button>
        <button type="button" onClick={() => {
          void run('Reading policy', async () => {
            setPolicy(await client.command<VerificationPolicyView>(
              { command: 'project.verificationPolicy', path }));
          });
        }}>Verification policy</button>
      </div>

      {identity === null ? null : (
        <dl className="kv">
          <dt>repo root</dt><dd className="mono">{identity.repoRoot}</dd>
          <dt>main ref</dt><dd className="mono">{identity.mainRef}</dd>
          <dt>object format</dt><dd>{identity.objectFormat}</dd>
          <dt>HEAD</dt><dd className="mono">{identity.headCommit}</dd>
        </dl>
      )}

      {policy === null ? null : (
        <>
          <h3>Verification policy</h3>
          {policy.state === 'ABSENT'
            ? <p className="muted">
                No policy at the main ref. Trust is possible, but verification will refuse until
                .codeestra/policies/verification.json exists.
              </p>
            : (
              <table>
                <thead><tr><th>id</th><th>command</th><th>cwd</th><th>timeout</th></tr></thead>
                <tbody>
                  {policy.policy?.commands.map((command) => (
                    <tr key={command.id}>
                      <td>{command.id}</td>
                      <td className="mono">{command.argv.join(' ')}</td>
                      <td className="mono">{command.cwd}</td>
                      <td>{command.timeoutSeconds}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          <p className="muted mono">main {policy.mainCommit.slice(0, 12)} · digest {policy.digest?.slice(0, 12) ?? '—'}</p>
        </>
      )}

      {identity === null || policy === null ? null : (
        <div className="card nested">
          <h3>Trust this project</h3>
          <p>
            Trusting lets an Agent, verification commands and Git hooks run with your user
            permissions. It does not authorize commits, main updates, pushes, or unknown tools.
          </p>
          <input
            value={confirmation}
            placeholder="Type TRUST to confirm"
            onChange={(event) => setConfirmation(event.target.value)}
          />
          <button
            type="button"
            className="danger"
            disabled={confirmation !== 'TRUST'}
            onClick={() => {
              void run('Trusting', async () => {
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
            Trust project
          </button>
        </div>
      )}
    </section>
  );
}
