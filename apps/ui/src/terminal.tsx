import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeError, RuntimeClient } from './api.js';
import type {
  SessionHandoffCapabilitiesView,
  SessionHandoffStatusView,
  SessionTerminalAttachmentKindView,
  SuccessorAdmissionView,
  TerminalAttachResultView,
  TerminalReadView,
  TerminalReleaseResultView,
} from './types.js';

/**
 * The native terminal and the handoff around it (ADR-0023 / ADR-0026), as a projection of the same
 * commands the CLI uses: `session handoff status|request|cancel|admit|attach|detach|release` and
 * `terminal read|write`.
 *
 * Three rules this panel follows on purpose:
 *
 * 1. **Nothing here is an approval channel.** Terminal input is terminal input; a STRICT permission
 *    request is answered on the Attention page, and this panel only points at the Attention it sees.
 * 2. **A refusal is rendered as a refusal.** A second WRITER attachment is `ATTACHMENT_BUSY` with the
 *    current holder named, a release that could not be proven stays `released: false`, and an
 *    admission that started nothing says `successorStarted: false`. None of them are turned into a
 *    success, a queue or a retry loop.
 * 3. **Terminal bytes are untrusted.** They are shown as text with control characters made visible;
 *    no ANSI sequence is interpreted and nothing is injected into the DOM as markup.
 */

/** How often the handoff/terminal projection is re-read while a handoff or a terminal is live. */
const handoffPollIntervalMs = 2_000;
/**
 * How often the projected terminal stream is read while this client is attached. Terminal bytes are
 * Runtime memory only and are not part of the event catalog, so a cursor read is the only transport
 * there is; the read only runs while this client is attached and the terminal is running.
 */
const streamPollIntervalMs = 700;
/** The display buffer this client keeps. The Runtime's retained buffer is its own, separate window. */
const streamBufferChars = 240_000;
/** The Runtime rejects a write whose base64 payload exceeds its own limit; refuse locally first. */
const maxWriteBase64Chars = 16_384;

const incarnationModeLabels: Record<string, string> = {
  AUTOMATED_RPC: '自动（RPC）',
  HUMAN_TUI: '人工终端（TUI）',
};

const handoffKindLabels: Record<string, string> = {
  TAKEOVER: '接管（自动化 → 终端）',
  RETURN: '交还（终端 → 自动化）',
};

const valueLabels: Record<string, string> = {
  REQUESTED: '已请求',
  FENCED: '已装 fence',
  AT_SAFE_POINT: '已到安全点',
  ADMITTED: '已交接',
  CANCELLED: '已取消',
  ACTIVE: '存活',
  EXITED: '已退出',
  RUNNING: '运行中',
  RELEASED: '已交还',
  STOPPED: '已停止',
  RECOVERY_REQUIRED: '需要恢复',
  FAILED: '失败',
  WRITER: '写入者',
  OBSERVER: '观察者',
  ATTACHED: '已附加',
  DETACHED: '已分离',
  AUTOMATED_RPC: '自动化',
  TERMINAL_ATTACHMENT: '终端',
  APPLIED: '已应用',
  NOT_APPLIED: '未应用',
  IMPLEMENTED: '已实现',
  UNSUPPORTED: '不支持',
  PARTIAL: '部分',
  UNVERIFIED: '未验证',
  STOPPED_OBSERVATION: '已停止',
  ALIVE: '仍存活',
  DESCENDANTS_ALIVE: '后代仍存活',
  UNVERIFIABLE: '无法核验',
  NOT_CHECKED: '未检查',
  RELEASED_CODE: '已交还',
  NOT_RELEASED: '未交还',
  OPEN: '待处理',
  ALLOW: '已允许',
  DENY: '已拒绝',
  CANCEL: '已取消',
  DECIDING: '正在决定',
  STALE: '已过期',
  PTY: 'PTY',
  RPC: 'RPC',
  NONE: '无',
};

/** A label for the handoff/terminal vocabulary, falling back to the raw value it was given. */
export function handoffLabel(value: string | null): string {
  if (value === null) return '—';
  return valueLabels[value] ?? value;
}

/**
 * The `ptyResize` capability as one sentence, with the **wire value quoted verbatim** (ADR-0026).
 *
 * The old UI hard-coded a "不支持" claim for the window size next to an UNSUPPORTED claim about the
 * capability matrix, which becomes a false statement the moment the Runtime reports anything else
 * (and it contradicted the capability matrix directly below it, which reports the same value). This
 * function never rewrites or guesses the value: every branch names the value the command face
 * returned, and a value this client does not know is shown as-is with no conclusion drawn for it.
 */
export function ptyResizeFact(capability: string): string {
  if (capability === 'IMPLEMENTED' || capability === 'SUPPORTED') {
    return `窗口大小可以改变（命令面报告 ${capability}）`;
  }
  if (capability === 'UNSUPPORTED') return '窗口大小不能改变（命令面报告 UNSUPPORTED）';
  if (capability === 'PARTIAL') {
    return '窗口大小只在部分平台上可改变（命令面报告 PARTIAL；具体平台范围以命令面与 ADR 为准）';
  }
  if (capability === 'UNVERIFIED') return '窗口大小能否改变尚未验证（命令面报告 UNVERIFIED）';
  return `本界面没有这个取值的词汇表，不作解释：命令面报告的 ptyResize 取值是 ${capability}`;
}

function incarnationModeLabel(mode: string): string {
  return incarnationModeLabels[mode] ?? mode;
}

function handoffKindLabel(kind: string): string {
  return handoffKindLabels[kind] ?? kind;
}

function timeLabel(at: number | null): string {
  return at === null ? '—' : new Date(at).toLocaleTimeString('zh-CN');
}

function shortId(value: string | null): string {
  return value === null ? '—' : value.slice(0, 10);
}

/** The last path segment of a provider session file; the full path stays in the title attribute. */
function basename(path: string | null): string {
  if (path === null) return '—';
  const parts = path.split('/');
  return parts.at(-1) ?? path;
}

/**
 * Renders terminal bytes as text without interpreting them.
 *
 * `\r\n` and a lone `\r` become a newline so lines read as lines, an escape character becomes `␛`
 * and every other C0 control character becomes `·`. That is a display transformation only: the
 * bytes are never parsed as a terminal control language and never reach the DOM as markup.
 */
export function displayTerminalText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u001b/g, '␛')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '·');
}

/** Keeps the display buffer bounded; the oldest characters are dropped, and the caller says so. */
export function trimStreamBuffer(text: string, limit = streamBufferChars): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

/** Base64 for one terminal write, which is the transport shape the command face requires. */
export function terminalInputBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * One Session's handoff and native terminal.
 *
 * The Runtime is the only authority on state here. This panel reads the projection, calls the same
 * commands the CLI calls, and reports exactly what came back — including a refusal that nothing was
 * started, and a release that could not be proven.
 */
export function TerminalPanel({ client, projectId, sessionId, refreshToken, run }: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  readonly sessionId: string;
  /** Bumped by stream events that touch this Session; it only triggers one extra read. */
  readonly refreshToken: number;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [status, setStatus] = useState<SessionHandoffStatusView | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [identity, setIdentity] = useState<SessionTerminalAttachmentKindView>('WRITER');
  const [attachment, setAttachment] = useState<TerminalAttachResultView['attachment'] | null>(null);
  const [streamText, setStreamText] = useState('');
  const [streamTruncated, setStreamTruncated] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [admission, setAdmission] = useState<SuccessorAdmissionView | null>(null);
  const [release, setRelease] = useState<TerminalReleaseResultView | null>(null);
  const [resumeAutomation, setResumeAutomation] = useState(true);
  const [writeText, setWriteText] = useState('');
  const [appendCarriageReturn, setAppendCarriageReturn] = useState(true);
  const cursorRef = useRef(0);
  const readInFlightRef = useRef(false);
  const streamRef = useRef<HTMLPreElement | null>(null);
  // One identity per mounted panel: a holder ref names *this* client so a busy writer answer can be
  // attributed. It is generated locally and never derived from anything the user typed.
  const holderRef = useMemo(() => `ui-${crypto.randomUUID().slice(0, 8)}`, []);

  const loadStatus = useCallback(async (): Promise<SessionHandoffStatusView | null> => {
    try {
      const next = await client.command<SessionHandoffStatusView>({
        command: 'session.handoff.status', projectId, sessionId,
      });
      setStatus(next);
      setStatusError(null);
      return next;
    } catch (error) {
      setStatusError(describeError(error));
      return null;
    }
  }, [client, projectId, sessionId]);

  // A new Session is a new terminal: nothing about the previous one may be carried over.
  useEffect(() => {
    setStatus(null);
    setAttachment(null);
    setStreamText('');
    setStreamTruncated(false);
    setStreamError(null);
    setAdmission(null);
    setRelease(null);
    setActionError(null);
    setNotice(null);
    cursorRef.current = 0;
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (refreshToken === 0) return;
    void loadStatus();
  }, [loadStatus, refreshToken]);

  const openHandoff = status?.handoff !== null && status !== null
    && ['REQUESTED', 'FENCED', 'AT_SAFE_POINT'].includes(status.handoff.state);
  const terminal = status?.terminal ?? null;
  const terminalRunning = terminal !== null && terminal.state === 'RUNNING';
  // The handoff and terminal tables are not part of the event catalog, so this panel polls while a
  // handoff or a terminal can still change, and reads on demand otherwise.
  const live = openHandoff || terminalRunning;
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => { void loadStatus(); }, handoffPollIntervalMs);
    return () => { clearInterval(timer); };
  }, [live, loadStatus]);

  // The projected terminal stream. It only follows while this client is attached to a running
  // terminal; detaching or the terminal ending stops the read instead of leaving a timer behind.
  useEffect(() => {
    if (attachment === null || !terminalRunning) return undefined;
    let disposed = false;
    const tick = async (): Promise<void> => {
      if (readInFlightRef.current) return;
      readInFlightRef.current = true;
      try {
        const read = await client.command<TerminalReadView>({
          command: 'session.handoff.terminal.read',
          projectId, sessionId, since: cursorRef.current,
        });
        if (disposed) return;
        cursorRef.current = read.cursor;
        setStreamError(null);
        if (read.truncated) setStreamTruncated(true);
        if (read.data.length > 0) {
          setStreamText((previous) => trimStreamBuffer(previous + displayTerminalText(read.data)));
        }
        if (!read.running) {
          setNotice('终端已结束，投影不再前进；已显示的内容保留在下方。');
        }
      } catch (error) {
        if (!disposed) setStreamError(describeError(error));
      } finally {
        readInFlightRef.current = false;
      }
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, streamPollIntervalMs);
    return () => { disposed = true; clearInterval(timer); };
  }, [attachment, client, projectId, sessionId, terminalRunning]);

  // Follow the newest projected output; the user can still scroll up while it keeps appending.
  useEffect(() => {
    const node = streamRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [streamText]);

  const perform = useCallback(async (
    name: string, label: string, action: () => Promise<void>,
  ): Promise<void> => {
    setPending(name);
    setActionError(null);
    setNotice(null);
    await run(label, async () => {
      try {
        await action();
      } catch (error) {
        // Shown inside this panel: an `ATTACHMENT_BUSY` is a fact about this Session, not a page
        // level failure, and the Runtime's own message names the current holder.
        setActionError(describeError(error));
      }
    });
    setPending(null);
  }, [run]);

  const attach = (): void => {
    void perform('attach', '正在附加到终端', async () => {
      const result = await client.command<TerminalAttachResultView>({
        command: 'session.handoff.attach',
        commandId: crypto.randomUUID(),
        projectId,
        sessionId,
        holderRef,
        kind: identity,
        // 0 means "from the start of the Runtime's retained buffer"; a cursor that fell out of that
        // window comes back as `truncated` instead of a hole, and the panel says so.
        since: 0,
      });
      setAttachment(result.attachment);
      cursorRef.current = result.stream.cursor;
      setStreamText(displayTerminalText(result.stream.data));
      setStreamTruncated(result.stream.truncated);
      setNotice(`已以${handoffLabel(result.attachment.kind)}身份附加（${shortId(result.attachment.id)}）。`
        + (result.attachment.kind === 'OBSERVER'
          ? '观察者只读：输入框在附加为写入者之前保持关闭。' : ''));
      await loadStatus();
    });
  };

  const detach = (): void => {
    void perform('detach', '正在分离终端', async () => {
      const result = await client.command<{ readonly detached: boolean; readonly code: string }>({
        command: 'session.handoff.detach', commandId: crypto.randomUUID(),
        projectId, sessionId, holderRef,
      });
      setAttachment(null);
      // The Runtime answers with a code instead of an error when this client owns no attachment
      // (for example because a release or a stop already closed it). Reporting that as “已分离”
      // would be an accepted-as-succeeded claim, so the refusal is surfaced as it is.
      if (result.detached) {
        setNotice('已分离。这只释放本客户端的附加：终端与 provider 进程不受影响。');
      } else {
        setActionError(`${result.code}: Runtime 没有记录本客户端的附加`
          + '（可能已由 release/stop 关闭）；已停止跟随投影。');
      }
      await loadStatus();
    });
  };

  const write = (): void => {
    const payload = appendCarriageReturn ? `${writeText}\r` : writeText;
    const encoded = terminalInputBase64(payload);
    if (encoded.length > maxWriteBase64Chars) {
      setActionError(`WRITE_TOO_LARGE: 单次写入上限 ${maxWriteBase64Chars} 个 base64 字符；`
        + '请分次发送。');
      return;
    }
    void perform('write', '正在写入终端', async () => {
      await client.command({
        command: 'session.handoff.terminal.write', commandId: crypto.randomUUID(),
        projectId, sessionId, dataBase64: encoded,
      });
      setWriteText('');
      setNotice('已写入终端输入。写入不是审批：STRICT 的权限请求仍在「待处理」页面回答。');
    });
  };

  const requestTakeover = (): void => {
    void perform('request', '正在请求接管', async () => {
      await client.command({
        command: 'session.handoff.request', commandId: crypto.randomUUID(),
        projectId, sessionId, kind: 'TAKEOVER',
      });
      setNotice('已持久化接管意图并装上 fence；fence 只阻止新的工具调用，不中止进行中的工具。');
      await loadStatus();
    });
  };

  const cancelHandoff = (): void => {
    void perform('cancel', '正在取消接管请求', async () => {
      await client.command({
        command: 'session.handoff.cancel', commandId: crypto.randomUUID(), projectId, sessionId,
      });
      setNotice('已取消接管请求并释放 fence，Agent 可以继续使用工具。');
      await loadStatus();
    });
  };

  const admit = (): void => {
    void perform('admit', '正在接管（启动原生终端）', async () => {
      const result = await client.command<SuccessorAdmissionView>({
        command: 'session.handoff.admit', commandId: crypto.randomUUID(), projectId, sessionId,
      });
      setAdmission(result);
      await loadStatus();
    });
  };

  const releaseTerminal = (): void => {
    void perform('release', '正在交还自动化', async () => {
      const result = await client.command<TerminalReleaseResultView>({
        command: 'session.handoff.release', commandId: crypto.randomUUID(),
        projectId, sessionId, resumeAutomation,
      });
      setRelease(result);
      setAttachment(null);
      if (result.released) {
        setNotice('终端已交还：provider 进程已退出、归属核验通过、会话文件未被重写。');
      }
      await loadStatus();
    });
  };

  const busy = pending !== null;
  const canWrite = attachment !== null && attachment.kind === 'WRITER' && terminalRunning;
  // The `ptyResize` capability is displayed exactly as the Runtime reported it (never rewritten):
  // the window row and the capability matrix below it must always agree.
  const ptyResize = status?.capabilities.ptyResize;

  return (
    <section className="handoff-panel">
      <h4>原生终端与会话交接 <span className="muted hint">ADR-0023 / ADR-0026 · 同一 CLI 命令面</span></h4>
      <p className="muted hint">
        终端是 Runtime 自己持有的真实 PTY。附加只表示本客户端在看它；分离不停终端、不动 provider。
        向终端写入是终端输入，<strong>不是审批通道</strong>：STRICT 的权限请求在「待处理」页面回答。
        这个面板不新增语义、不加确认步骤，也不替 Runtime 判定任何交接。
      </p>

      {statusError === null ? null : (
        <p className="error" role="alert">会话交接状态读取失败：{statusError}</p>
      )}
      {actionError === null ? null : <p className="error" role="alert">{actionError}</p>}
      {notice === null ? null : <p className="muted" role="status">{notice}</p>}
      {status === null ? <p className="muted" role="status">正在读取会话交接状态…</p> : (
        <>
          <dl className="kv">
            <dt>会话</dt>
            <dd className="mono">{shortId(status.sessionId)} · 状态 {handoffLabel(status.sessionState)}
              {' · 执行 '}{handoffLabel(status.executionState)}
              {' · 权限模式 '}{status.permissionMode}</dd>
            <dt>Provider 会话</dt>
            <dd className="mono" title={status.sessionStorageRef ?? ''}>
              {status.providerSessionId ?? '—'} · {basename(status.sessionStorageRef)}</dd>
            <dt>当前 incarnation</dt>
            <dd>{status.incarnation === null ? '没有：这个会话没有可交接的 provider 进程'
              : `#${status.incarnation.incarnationNumber} ${incarnationModeLabel(status.incarnation.mode)}`
                + ` · ${handoffLabel(status.incarnation.state)}`
                + ` · pid ${status.incarnation.providerPid ?? '—'}`}</dd>
            <dt>写入租约</dt>
            <dd>{status.writerLease === null ? '无（没有任何未释放的租约）'
              : `${handoffLabel(status.writerLease.holderKind)} · ${status.writerLease.holderRef}`
                + ` · 自 ${timeLabel(status.writerLease.acquiredAt)}`}</dd>
            <dt>side channel</dt>
            <dd>{status.sideChannel === null ? '未连接'
              : `已连接（mode ${status.sideChannel.mode ?? '?'}`
                + ` · ${status.sideChannel.permissionMode ?? '?'} · pid ${status.sideChannel.pid ?? '—'}`
                + ` · 活动工具 ${status.sideChannel.activeTools.length}${status.sideChannel.activeTools.length === 0 ? '' : `：${status.sideChannel.activeTools.join(', ')}`}）`}</dd>
          </dl>

          {status.permission === null && status.lastPermission === null ? null : (
            <p className="muted hint">
              {status.permission === null
                ? `最近一次权限请求：${status.lastPermission?.toolName} · ${handoffLabel(status.lastPermission?.decision ?? null)}`
                : `有一条待回答的 STRICT 权限请求（${status.permission.toolName}，工具调用 ${status.permission.toolCallId}）。`
                  + '请在「待处理」页面回答；终端输入不能批准它。'}
            </p>
          )}

          <h5>安全点与 fence</h5>
          {status.safePoint.reached ? (
            <p>
              <span className="state state-ready">已到安全点</span>{' '}
              <span className="muted">fence 已被 provider 确认、无活动工具、fence 后有 settled 事实、无未决 Attention。</span>
            </p>
          ) : (
            <p>
              <span className="state state-waiting_for_user">未到安全点</span>{' '}
              <span className="muted">仍缺：
                {status.safePoint.missing.length === 0 ? '（Runtime 未说明）'
                  : status.safePoint.missing.join('；')}
                。安全点只由结构化事实判定，不从终端屏幕文本推断。</span>
            </p>
          )}
          <ul className="list facts">
            <li className={status.safePoint.fenceAcknowledged ? 'muted' : ''}>
              fence 已确认：{status.safePoint.fenceAcknowledged ? '是' : '否'}
            </li>
            <li className={status.safePoint.activeTools === 0 ? 'muted' : ''}>
              活动工具：{status.safePoint.activeTools}
            </li>
            <li className={status.safePoint.settledAfterFence ? 'muted' : ''}>
              fence 后出现 settled 事实：{status.safePoint.settledAfterFence ? '是' : '否'}
            </li>
            <li className={status.safePoint.openAttention ? '' : 'muted'}>
              未决 Attention：{status.safePoint.openAttention ? '有' : '无'}
            </li>
          </ul>

          <div className="actions">
            <button type="button" disabled={busy || openHandoff}
              title="持久化接管意图并装上 fence；不会中止正在运行的工具"
              onClick={requestTakeover}>
              请求接管
            </button>
            <button type="button" className={status.safePoint.reached && openHandoff ? 'primary' : ''}
              disabled={busy} onClick={admit}
              title="由 Runtime 判定：安全点、predecessor 归属、Execution 仍为 RUNNING 全部通过才会启动原生终端">
              接管（启动原生终端）
            </button>
            <button type="button" disabled={busy || !openHandoff} onClick={cancelHandoff}
              title="放弃接管请求并释放 fence，Agent 可以继续使用工具">
              取消接管请求
            </button>
            <button type="button" disabled={busy} onClick={() => { void loadStatus(); }}>刷新状态</button>
          </div>

          {admission === null ? null : (
            <div className={admission.admitted && admission.successorStarted
              ? 'banner notice' : 'banner error'} role="status">
              <div>
                <strong>{admission.successorStarted
                  ? (admission.replayed ? '已交接（回放既有结果）' : '已交接')
                  : '未交接'}</strong>
                {' '}<span className="mono">{admission.code}</span>
                <div>{admission.detail}</div>
                <div className="muted">
                  predecessor 核验：{handoffLabel(admission.predecessorObservation)}
                  {' · 传输：'}{handoffLabel(admission.terminalTransport)}
                  {' · successor：'}{admission.successorStarted
                    ? `#${admission.successorIncarnation?.incarnationNumber ?? '?'} ${incarnationModeLabel(admission.successorMode ?? '')}（已启动）`
                    : '未启动任何进程'}
                </div>
              </div>
              <button type="button" onClick={() => setAdmission(null)}>关闭</button>
            </div>
          )}

          {status.handoff === null ? null : (
            <p className="muted">
              最新交接请求：{handoffKindLabel(status.handoff.kind)} · {handoffLabel(status.handoff.state)}
              {' · fence '}{status.handoff.fenceActive ? '生效中' : '已释放'}
              {' · 请求于 '}{timeLabel(status.handoff.createdAt)}
              {status.handoff.detail === null ? null : ` · ${status.handoff.detail}`}
            </p>
          )}

          <h5>Incarnation 历史 <span className="muted hint">同一 conversation 的进程代号，不是同一个进程</span></h5>
          {status.incarnations.length === 0 ? <p className="muted">还没有记录任何 incarnation。</p> : (
            <div className="table-scroll"><table>
              <thead>
                <tr><th>#</th><th>模式</th><th>状态</th><th>provider pid</th><th>记录的后代</th>
                  <th>前身</th><th>开始</th><th>结束</th></tr>
              </thead>
              <tbody>
                {status.incarnations.map((incarnation) => (
                  <tr key={incarnation.incarnationId}>
                    <td>{incarnation.incarnationNumber}</td>
                    <td>{incarnationModeLabel(incarnation.mode)}</td>
                    <td>{handoffLabel(incarnation.state)}</td>
                    <td className="mono">{incarnation.providerPid ?? '—'}</td>
                    <td>{incarnation.recordedDescendants}</td>
                    <td className="mono">
                      {incarnation.predecessorIncarnationId === null
                        ? '—' : shortId(incarnation.predecessorIncarnationId)}
                    </td>
                    <td>{timeLabel(incarnation.createdAt)}</td>
                    <td>{timeLabel(incarnation.endedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}

          <h5>原生终端</h5>
          {terminal === null ? (
            <p className="muted">
              这个会话还没有原生终端。接管（上一步）成功启动 provider 后，这里会出现终端的
              PTY、游标与附加状态。
            </p>
          ) : (
            <>
              <dl className="kv">
                <dt>终端</dt>
                <dd className="mono">{shortId(terminal.terminalId)} · {handoffLabel(terminal.state)}
                  {' · '}{terminal.held
                    ? '本 Runtime 持有（可附加）'
                    : '本 Runtime 不持有（无法附加：不是它启动的进程）'}</dd>
                <dt>进程</dt>
                <dd className="mono">helper pid {terminal.helperPid ?? '—'} · provider pid {terminal.providerPid ?? '—'}
                  {' · '}{terminal.ptySlave ?? '—'}</dd>
                <dt>窗口</dt>
                <dd>{handoffLabel(terminal.windowSize)}
                  {ptyResize === undefined ? (
                    <div className="muted">命令面没有报告 <span className="mono">ptyResize</span>
                      {' '}这一项。</div>
                  ) : (
                    <div className="muted">ptyResize: <span className="mono">{ptyResize}</span>
                      {' · '}{ptyResizeFact(ptyResize)}
                      <div>取值直接来自 <span className="mono">session.handoff.status</span> 的能力矩阵；
                        这里不改写也不猜测</div></div>
                  )}
                </dd>
                <dt>投影游标</dt>
                <dd className="mono">{terminal.cursor} · 保留 {terminal.retainedBytes} B
                  {' · 已产生 '}{terminal.projectedBytes} B
                  {terminal.bufferTruncated ? ' · 有界缓冲已丢弃过期字节' : ''}</dd>
                <dt>当前写入者</dt>
                <dd>{terminal.writer === null ? '无附加写入者'
                  : `${terminal.writer.holderRef} · 自 ${timeLabel(terminal.writer.attachedAt)}`}</dd>
              </dl>

              {terminal.attachments.length === 0 ? null : (
                <details>
                  <summary className="muted">{terminal.attachments.length} 条附加记录</summary>
                  <ul className="list">
                    {terminal.attachments.map((item) => (
                      <li key={item.id} className="muted">
                        {handoffLabel(item.kind)} · {item.holderRef} · {handoffLabel(item.state)}
                        {' · 附加于 '}{timeLabel(item.attachedAt)}
                        {item.detachedAt === null ? '' : ` · 分离于 ${timeLabel(item.detachedAt)}`}
                        {item.detachedReason === null ? '' : `（${item.detachedReason}）`}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="actions terminal-attach">
                <label className="inline">
                  身份
                  <select value={identity} disabled={busy || attachment !== null}
                    onChange={(event) => {
                      setIdentity(event.target.value as SessionTerminalAttachmentKindView);
                    }}>
                    <option value="WRITER">写入者（每个终端至多一个）</option>
                    <option value="OBSERVER">观察者（可多个，只读）</option>
                  </select>
                </label>
                <span className="muted mono">holder {holderRef}</span>
                {attachment === null ? (
                  <button type="button" disabled={busy || !terminalRunning || !terminal.held}
                    onClick={attach}
                    title={terminalRunning
                      ? (terminal.held ? '附加到本 Runtime 持有的终端' : '本 Runtime 不持有该终端，无法附加')
                      : '终端不处于 RUNNING，无法附加'}>
                    附加
                  </button>
                ) : (
                  <button type="button" disabled={busy} onClick={detach}>
                    分离（当前：{handoffLabel(attachment.kind)}）
                  </button>
                )}
                {attachment === null ? null : (
                  <span className="muted">
                    本客户端以{handoffLabel(attachment.kind)}身份附加中
                    {attachment.kind === 'OBSERVER' ? '，只读' : '，可以输入'}。
                  </span>
                )}
              </div>
              {attachment !== null && attachment.kind === 'WRITER' ? null : (
                <p className="muted hint">
                  输入框只在以<strong>写入者</strong>身份附加时可用。第二个写入者会被 Runtime
                  稳定拒绝为 <span className="mono">ATTACHMENT_BUSY</span> 并报出当前 holder；
                  这里不会排队，也不会伪装成功。
                </p>
              )}

              {streamTruncated ? (
                <p className="muted">
                  投影被标记为 <span className="mono">truncated</span>：请求的游标已经落在 Runtime
                  有界缓冲之外，这里显示的是仍然保留的部分，中间可能有缺失。
                </p>
              ) : null}
              {streamError === null ? null : <p className="error">终端读取失败：{streamError}</p>}
              {attachment === null && streamText === '' ? (
                <p className="muted">附加后这里会跟随显示终端投影（终端字节只在 Runtime 内存里，不落盘）。</p>
              ) : (
                <>
                  <pre className="terminal-stream mono" ref={streamRef} tabIndex={0}
                    aria-label="终端投影（不可信内容，按文本显示）">{streamText}</pre>
                  <div className="actions">
                    <button type="button" disabled={!canWrite || busy}
                      onClick={() => { setStreamText(''); setStreamTruncated(false); }}>
                      清空显示
                    </button>
                    <span className="muted hint">
                      控制字符按可见字符显示（ESC → ␛），不解释 ANSI 序列；内容按不可信文本渲染。
                    </span>
                  </div>
                </>
              )}

              <div className="actions terminal-write">
                <input aria-label="终端输入" value={writeText} disabled={!canWrite || busy}
                  placeholder={canWrite ? '终端输入（写入不是审批通道）' : '需要以写入者身份附加'}
                  onChange={(event) => setWriteText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && canWrite && !busy) {
                      event.preventDefault();
                      write();
                    }
                  }} />
                <label className="inline">
                  <input type="checkbox" checked={appendCarriageReturn} disabled={!canWrite}
                    onChange={(event) => setAppendCarriageReturn(event.target.checked)} />
                  末尾附加回车（CR，等同按 Enter）
                </label>
                <button type="button" disabled={!canWrite || busy || writeText.length === 0}
                  onClick={write}>
                  写入
                </button>
              </div>

              <div className="actions terminal-release">
                <label className="inline">
                  <input type="checkbox" checked={resumeAutomation} disabled={busy}
                    onChange={(event) => setResumeAutomation(event.target.checked)} />
                  交还后继续自动化（启动 RPC successor）
                </label>
                <button type="button" className="danger" disabled={busy || !terminalRunning}
                  onClick={releaseTerminal}
                  title="写入终端自己的 release 字节（Ctrl+D），等待 provider 退出并核验归属与会话文件；不杀 provider，不中止工具">
                  交还自动化（release）
                </button>
              </div>
              {terminal.state !== 'RUNNING' ? (
                <p className="muted">
                  终端当前为 {handoffLabel(terminal.state)}，不能写入或再次 release；
                  {' '}release 只对 RUNNING 的终端有意义（否则 Runtime 返回 <span className="mono">TERMINAL_NOT_RUNNING</span>）。
                </p>
              ) : null}

              {release === null ? null : (
                <div className={release.released ? 'banner notice' : 'banner error'} role="status">
                  <div>
                    <strong>{release.released ? '已交还自动化' : '未交还'}</strong>
                    {' '}<span className="mono">{release.code}</span>
                    <div>{release.detail}</div>
                    <div className="muted mono">
                      provider 退出码 {release.release.exit?.code ?? '—'}
                      {release.release.exit?.signal == null ? '' : ` · signal ${release.release.exit.signal}`}
                      {' · predecessor '}{handoffLabel(release.release.predecessorObservation)}
                      {' · 前身条目保留 '}
                      {release.release.sessionFile.predecessorEntrySurvived === null
                        ? '未核验' : (release.release.sessionFile.predecessorEntrySurvived ? '是' : '否')}
                      {release.release.sessionFile.truncated ? ' · 会话文件读取被截断' : ''}
                    </div>
                    <div className="muted">
                      退出码只是审计数据，不参与判定（Ctrl+D 与 SIGTERM 都可能是 0）。
                      {' '}successor：{release.successor === null ? '未启动'
                        : `${release.successor.successorStarted ? '已启动' : '未启动'}（${release.successor.code}）`}
                    </div>
                  </div>
                  <button type="button" onClick={() => setRelease(null)}>关闭</button>
                </div>
              )}
            </>
          )}

          <details>
            <summary className="muted">能力矩阵 · Runtime 自己报告的实现程度</summary>
            <p className="muted hint">
              不支持的必须显式反馈，不静默降级：这里只显示 Runtime 报来的值。
            </p>
            <div className="table-scroll"><table>
              <thead><tr><th>能力</th><th>值</th></tr></thead>
              <tbody>
                {capabilityRows(status.capabilities).map(([name, value]) => (
                  <tr key={name}>
                    <td className="mono">{name}</td>
                    <td><span className={`state state-${value.toLowerCase()}`}>{handoffLabel(value)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </details>
        </>
      )}
    </section>
  );
}

/** Stable display order for the capability table; unknown keys are appended, never hidden. */
const capabilityOrder = [
  'runtimeContract', 'singleWriterLease', 'strictPermissionOverSideChannel', 'ptyTransport',
  'successorProcessStart', 'nativeTerminalAttach', 'terminalDetach', 'releaseBackToAutomation',
  'attachToLiveRpcProcess', 'crossHandoffPermissionModeMatrix', 'parallelToolBatchSafePoint',
  'sessionCompactionDuringHandoff', 'ptyResize', 'windows',
];

function capabilityRows(
  capabilities: SessionHandoffCapabilitiesView,
): readonly (readonly [string, string])[] {
  const entries = Object.entries(capabilities);
  const known = capabilityOrder
    .filter((name) => capabilities[name] !== undefined)
    .map((name): readonly [string, string] => [name, capabilities[name] ?? 'UNVERIFIED']);
  const extra = entries
    .filter(([name]) => !capabilityOrder.includes(name))
    .map(([name, value]): readonly [string, string] => [name, value]);
  return [...known, ...extra];
}

/** Exported so callers and readers share one vocabulary with this panel. */
export const terminalLabels = valueLabels;
