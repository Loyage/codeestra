import { useCallback, useEffect, useRef, useState } from 'react';
import { RuntimeClient, describeError } from './api.js';
import type {
  SessionTranscriptEntry,
  SessionTranscriptView,
} from './types.js';

/** How often a running Session is re-read. The provider file is appended to, not rewritten. */
const pollIntervalMs = 1_500;
const entriesPerRead = 100;

const kindLabels: Record<SessionTranscriptEntry['kind'], string> = {
  USER: '任务输入',
  ASSISTANT: 'Agent',
  TOOL_RESULT: '工具返回',
  MODEL_CHANGE: '切换模型',
  THINKING_LEVEL_CHANGE: '思考深度',
  OTHER: '其他记录',
};

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
  const cursorRef = useRef<string | null>(null);

  const read = useCallback(async (recovered: boolean): Promise<void> => {
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
    } catch (caught) {
      const message = describeError(caught);
      if (message.includes('TRANSCRIPT_CURSOR_UNKNOWN') && !recovered) {
        // The provider file was replaced under us: restart from the beginning exactly once, and
        // say so instead of silently showing a different region than the user was reading.
        cursorRef.current = null;
        setNotice('会话文件游标已失效，已从头重新读取。');
        await read(true);
        return;
      }
      setError(message);
    }
  }, [client, sessionId]);

  useEffect(() => {
    // One initial read per Session. Kept separate from the polling effect so that a Session ending
    // does not wipe what the user is already reading.
    cursorRef.current = null;
    setView(null);
    setEntries([]);
    setError(null);
    setNotice(null);
    setExpanded({});
    void read(false);
  }, [read]);

  useEffect(() => {
    if (!active) return undefined;
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

  return (
    <div className="transcript">
      <div className="actions">
        <span className="muted">
          {view === null ? '正在读取…'
            : `${entries.length} 条记录 · ${view.sessionState} · ${active ? '自动刷新中' : '已结束'}`}
        </span>
        <button type="button" onClick={() => { void read(false); }}>刷新</button>
        <span className="muted">
          内容来自 Provider 自己的会话文件，只读展示；不会写入数据库，也不改动任务状态。
        </span>
      </div>
      {error === null ? null : <p className="error">{error}</p>}
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
      <div className="transcript-entries">
        {entries.map((entry) => {
          const when = timeLabel(entry.timestamp);
          const usage = usageLabel(entry);
          return (
            <article key={entry.entryId} className={`transcript-entry kind-${entry.kind.toLowerCase()}`}>
              <header>
                <span className="state">{kindLabels[entry.kind]}</span>
                {when === null ? null : <span className="muted">{when}</span>}
                {entry.role === null ? null : <span className="muted mono">{entry.role}</span>}
                {entry.provider === null && entry.model === null ? null : (
                  <span className="muted mono">{entry.provider ?? '?'}/{entry.model ?? '?'}</span>
                )}
                {entry.stopReason === null ? null : (
                  <span className="muted mono">stop={entry.stopReason}</span>
                )}
                {entry.isError === null ? null : (
                  <span className={entry.isError ? 'error mono' : 'muted mono'}>
                    {entry.isError ? '工具报错' : '工具成功'}
                  </span>
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
            </article>
          );
        })}
      </div>
      {view !== null && view.hasMore ? (
        <p className="muted">还有更早的记录未显示；此面板会从游标继续读取。</p>
      ) : null}
    </div>
  );
}
