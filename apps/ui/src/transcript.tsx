import { useCallback, useEffect, useRef, useState } from 'react';
import { RuntimeClient, describeError } from './api.js';
import type {
  SessionTranscriptEntry,
  SessionTranscriptView,
} from './types.js';

/** How often a running Session is re-read. The provider file is appended to, not rewritten. */
const pollIntervalMs = 1_500;
const entriesPerRead = 100;

/**
 * How many paged reads one reverse catch-up may chain. The command face only has a forward cursor,
 * so the newest entries are only reachable by reading everything before them; the cap keeps a very
 * long session from turning "show newest first" into an unbounded burst of reads.
 */
const maxReverseReads = 50;

/** Which way the timeline reads. A presentation preference, stored next to the theme choice. */
type TranscriptOrder = 'forward' | 'reverse';
const orderKey = 'codeestra.transcript.order';

function initialOrder(): TranscriptOrder {
  try {
    return window.localStorage.getItem(orderKey) === 'reverse' ? 'reverse' : 'forward';
  } catch { return 'forward'; }
}

const kindLabels: Record<SessionTranscriptEntry['kind'], string> = {
  USER: '任务输入',
  ASSISTANT: 'Agent',
  TOOL_RESULT: '工具返回',
  MODEL_CHANGE: '切换模型',
  THINKING_LEVEL_CHANGE: '思考深度',
  OTHER: '其他记录',
};

/** How many characters of a part are shown inline on a collapsed entry line. */
const summaryChars = 160;

const partLabels: Record<string, string> = {
  TEXT: '文本',
  THINKING: '思考',
  TOOL_CALL: '工具调用',
  IMAGE: '图片',
  OTHER: '其他',
};

function partLabel(part: { readonly type: string; readonly name: string | null }): string {
  const label = partLabels[part.type] ?? part.type;
  return part.name === null ? label : `${label} · ${part.name}`;
}

function timeLabel(timestamp: string | null): string | null {
  if (timestamp === null) return null;
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleTimeString('zh-CN');
}

function usageLabel(entry: SessionTranscriptEntry): string | null {
  const usage = entry.usage;
  if (usage === null) return null;
  const parts: string[] = [];
  if (usage.input !== null) parts.push(`入 ${usage.input}`);
  if (usage.output !== null) parts.push(`出 ${usage.output}`);
  if (usage.reasoning !== null && usage.reasoning > 0) parts.push(`推理 ${usage.reasoning}`);
  if (usage.total !== null) parts.push(`合计 ${usage.total}`);
  if (usage.cost !== null) parts.push(`成本 ${usage.cost}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The single line shown while an entry is collapsed. It picks the most informative part (visible
 * text first, then a tool call name and its arguments, then thinking) and collapses it to one line,
 * so the panel reads as a timeline until the user asks for detail.
 */
function entrySummary(entry: SessionTranscriptEntry): string {
  const chosen = entry.parts.find((part) => part.type === 'TEXT' && part.text.trim() !== '')
    ?? entry.parts.find((part) => part.type === 'TOOL_CALL')
    ?? entry.parts.find((part) => part.type === 'THINKING' && part.text.trim() !== '')
    ?? entry.parts[0];
  const body = chosen === undefined ? '' : oneLine(chosen.text);
  // A tool call names itself on the part; a tool result only carries the name on the entry.
  const name = (chosen === undefined ? null : chosen.name) ?? entry.toolName;
  const prefix = name === null ? '' : `${name} `;
  if (prefix !== '' || body !== '') {
    return `${prefix}${body.length > summaryChars ? `${body.slice(0, summaryChars)}…` : body}`;
  }
  return entry.note === null ? '（无内容）' : oneLine(entry.note);
}

function sessionActive(executionState: string, sessionState: string): boolean {
  // An Execution keeps holding its workspace after the Agent exits, so the Execution state alone
  // would keep polling a file that cannot change. Once the Session itself is gone, stop reading.
  if (['EXITED', 'DISCONNECTED', 'RECOVERY_REQUIRED'].includes(sessionState)) return false;
  return ['ACTIVE', 'WAITING_FOR_USER'].includes(sessionState)
    || ['CREATED', 'PREPARING', 'STARTING', 'RUNNING', 'WAITING_FOR_USER']
      .includes(executionState);
}

/**
 * Renders the Agent's own process for one Session.
 *
 * The data comes from the Provider's session file through the Runtime's read-only
 * `session.transcript` command. Nothing here is a domain event, and no business state is derived
 * from it: this panel answers "what did the Agent actually do", nothing more. While the Session is
 * still running the panel re-reads incrementally from its last entry, so new work appears without
 * a manual refresh.
 */
export function TranscriptPanel({ client, sessionId, executionState, sessionState, run }: {
  readonly client: RuntimeClient;
  readonly sessionId: string;
  readonly executionState: string;
  readonly sessionState: string;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const active = sessionActive(executionState, sessionState);
  const [view, setView] = useState<SessionTranscriptView | null>(null);
  const [entries, setEntries] = useState<readonly SessionTranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [order, setOrder] = useState<TranscriptOrder>(initialOrder);
  const [drainCapped, setDrainCapped] = useState(false);
  const orderRef = useRef(order);
  const cursorRef = useRef<string | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const readPage = useCallback(async (recovered: boolean): Promise<SessionTranscriptView | null> => {
    try {
      const next = await client.command<SessionTranscriptView>({
        command: 'session.transcript',
        sessionId,
        ...(cursorRef.current === null ? {} : { afterEntryId: cursorRef.current }),
        limit: entriesPerRead,
      });
      cursorRef.current = next.cursor;
      setView(next);
      setEntries((previous) => (recovered
        ? next.entries
        : [...previous, ...next.entries.filter((entry) =>
          !previous.some((known) => known.entryId === entry.entryId))]));
      setError(null);
      return next;
    } catch (caught) {
      const message = describeError(caught);
      if (message.includes('TRANSCRIPT_CURSOR_UNKNOWN') && !recovered) {
        // The provider file was replaced under us: restart from the beginning exactly once, and
        // say so instead of silently showing a different region than the user was reading.
        cursorRef.current = null;
        setNotice('会话文件游标已失效，已从头重新读取。');
        return await readPage(true);
      }
      setError(message);
      return null;
    }
  }, [client, sessionId]);

  const read = useCallback((recovered: boolean): Promise<void> => {
    if (inFlightRef.current !== null) return inFlightRef.current;
    const request = (async () => {
      let page = await readPage(recovered);
      if (page === null || orderRef.current !== 'reverse') {
        setDrainCapped(false);
        return;
      }
      // Reverse order puts the newest entry at the top, so it has to read up to the end of the file
      // rather than stop at the first window.
      let reads = 1;
      while (page.hasMore && page.cursor !== null && reads < maxReverseReads) {
        page = await readPage(false);
        if (page === null) return;
        reads += 1;
      }
      setDrainCapped(page.hasMore);
    })().finally(() => { inFlightRef.current = null; });
    inFlightRef.current = request;
    return request;
  }, [readPage]);

  const changeOrder = (next: TranscriptOrder): void => {
    orderRef.current = next;
    setOrder(next);
    try { window.localStorage.setItem(orderKey, next); } catch { /* Session-only preference. */ }
    // Catch up immediately instead of waiting for the next polling tick.
    if (next === 'reverse') void read(false);
  };

  useEffect(() => {
    // One initial read per Session. Kept separate from the polling effect so that a Session ending
    // does not wipe what the user is already reading.
    cursorRef.current = null;
    setView(null);
    setEntries([]);
    setError(null);
    setNotice(null);
    setExpanded({});
    setOpen({});
    setDrainCapped(false);
    void read(false);
  }, [read]);

  useEffect(() => {
    if (!active) {
      // Catch the final provider messages even if EXITED arrives between polling ticks.
      let disposed = false;
      void (async () => {
        await inFlightRef.current;
        if (!disposed) await read(false);
      })();
      return () => { disposed = true; };
    }
    const timer = setInterval(() => { void read(false); }, pollIntervalMs);
    return () => { clearInterval(timer); };
  }, [active, read]);

  const expand = (entryId: string, partIndex: number): void => {
    const key = `${entryId}:${partIndex}`;
    void run('正在读取完整内容', async () => {
      const part = await client.command<{ readonly text: string }>({
        command: 'session.transcript.part', sessionId, entryId, partIndex,
      });
      setExpanded((previous) => ({ ...previous, [key]: part.text }));
    });
  };

  // The stored order is chronological; reverse only changes what the reader sees first.
  const ordered = order === 'reverse' ? [...entries].reverse() : entries;

  return (
    <div className="transcript">
      <div className="actions">
        <span className="muted">
          {view === null ? '正在读取…'
            : `${entries.length} 条记录 · ${view.sessionState} · ${active ? '自动刷新中' : '已结束'}`}
        </span>
        <label htmlFor="transcript-order">排列</label>
        <select
          id="transcript-order"
          value={order}
          onChange={(event) => { changeOrder(event.target.value as TranscriptOrder); }}
        >
          <option value="forward">正序（最早在前）</option>
          <option value="reverse">倒序（最新在前）</option>
        </select>
        <button type="button" onClick={() => { void read(false); }}>刷新</button>
        <span className="muted">
          内容来自 Provider 自己的会话文件，只读展示；不会写入数据库，也不改动任务状态。
        </span>
      </div>
      {error === null ? null : <p className="error" role="alert">{error}</p>}
      {notice === null ? null : <p className="muted">{notice}</p>}
      {view !== null && !view.fileAvailable ? (
        <p className="muted">{view.note ?? '没有可显示的执行过程。'}</p>
      ) : null}
      {view !== null && view.fileAvailable && view.note !== null ? (
        <p className="muted">{view.note}</p>
      ) : null}
      {view !== null && view.unparsedLines > 0 ? (
        <p className="muted">本次读取中有 {view.unparsedLines} 行不是可识别的会话条目。</p>
      ) : null}
      {view !== null && view.fileAvailable && entries.length === 0 && view.cursor === null ? (
        <p className="muted">会话文件里还没有内容。</p>
      ) : null}
      {drainCapped ? (
        <p className="muted">
          倒序已读到 {maxReverseReads} 次读取的上限，仍可能有更新的记录未显示；
          下面「加载更新的记录」可继续读取。
        </p>
      ) : null}
      <div className="transcript-entries">
        {ordered.map((entry) => {
          const when = timeLabel(entry.timestamp);
          const usage = usageLabel(entry);
          // The user's own input is part of the conversation, not Agent process noise, so it stays
          // open by default. Every other entry is one line until the user asks for detail.
          const isOpen = open[entry.entryId] ?? entry.kind === 'USER';
          return (
            <article
              key={entry.entryId}
              className={`transcript-entry kind-${entry.kind.toLowerCase()}${isOpen ? '' : ' collapsed'}`}
            >
              <button
                type="button"
                className="entry-line"
                aria-expanded={isOpen}
                onClick={() => {
                  setOpen((previous) => ({ ...previous, [entry.entryId]: !isOpen }));
                }}
              >
                <span className="caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                <span className="kind-chip">{kindLabels[entry.kind]}</span>
                <span className="entry-summary">{entrySummary(entry)}</span>
                <span className="entry-meta">
                  {entry.isError === null ? null : (
                    <span className={entry.isError ? 'error' : 'muted'}>
                      {entry.isError ? '工具报错' : '工具成功'}
                    </span>
                  )}
                  {entry.parts.length > 1 ? <span className="muted">{entry.parts.length} 段</span> : null}
                  {when === null ? null : <span className="muted">{when}</span>}
                </span>
              </button>
              {!isOpen ? null : (
                <div className="entry-detail">
                  <header>
                    {entry.role === null ? null : <span className="muted mono">{entry.role}</span>}
                    {entry.provider === null && entry.model === null ? null : (
                      <span className="muted mono">{entry.provider ?? '?'}/{entry.model ?? '?'}</span>
                    )}
                    {entry.stopReason === null ? null : (
                      <span className="muted mono">stop={entry.stopReason}</span>
                    )}
                    {entry.toolName === null ? null : (
                      <span className="muted mono">tool={entry.toolName}</span>
                    )}
                    {usage === null ? null : <span className="muted">{usage}</span>}
                    <span className="muted mono">{entry.entryId}</span>
                  </header>
                  {entry.note === null ? null : <p className="muted">{entry.note}</p>}
                  {entry.parts.map((part) => {
                    const key = `${entry.entryId}:${part.partIndex}`;
                    const full = expanded[key];
                    return (
                      <div key={part.partIndex} className={`transcript-part part-${part.type.toLowerCase()}`}>
                        <div className="part-head">
                          <span className="muted">{partLabel(part)}</span>
                          <span className="muted">{part.fullChars} 字符</span>
                          {part.truncated ? (full === undefined
                            ? (
                              <button type="button" onClick={() => { expand(entry.entryId, part.partIndex); }}>
                                展开全文
                              </button>
                            )
                            : (
                              <button type="button" onClick={() => {
                                setExpanded((previous) => {
                                  const next = { ...previous };
                                  delete next[key];
                                  return next;
                                });
                              }}>
                                收起
                              </button>
                            ))
                            : null}
                        </div>
                        <pre>{full ?? part.text}</pre>
                        {part.truncated && full === undefined ? (
                          <p className="muted">已截断，仅显示前 {view?.partPreviewChars ?? 0} 字符。</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </article>
          );
        })}
      </div>
      {view !== null && view.hasMore ? (
        <div className="actions">
          <button type="button" onClick={() => { void read(false); }}>
            {order === 'reverse' ? '加载更新的记录' : '加载后续记录'}
          </button>
          <span className="muted">
            {order === 'reverse'
              ? '还有更新的记录未显示；倒序下它们会出现在最上方。'
              : '还有记录未显示，按会话顺序从当前游标继续读取。'}
          </span>
        </div>
      ) : null}
    </div>
  );
}
