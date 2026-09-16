import { useCallback, useEffect, useState } from 'react';
import { describeError, RuntimeClient } from './api.js';
import type {
  RevisionCreationView,
  RevisionDeliveryRecordView,
  RevisionDeliveryResolutionView,
  RevisionDeliveryView,
  TaskRevisionListView,
  TaskRevisionSummaryView,
} from './types.js';

/**
 * Task revision history and revision delivery (PROJECT_SPEC §2.11 / ADR-0028), projected onto the
 * same command face the CLI exposes (`task revision list|create`, `task revision delivery
 * list|get|resolve`).
 *
 * The whole point of this panel is that **sending a message is not a confirmation**. Every delivery
 * is therefore shown as three separate facts, never as one progress bar:
 *
 * - **recorded** — the Runtime wrote down that this revision has to become known to a running
 *   Execution. That is true the moment a revision is created while one is running.
 * - **dispatched** — at least one attempt on a channel (`PROVIDER_CONVERSATION`, or the
 *   stop-and-restart fallback) was recorded in the append-only ledger.
 * - **confirmed** — only a structured acknowledgement from a channel that can acknowledge, or a
 *   successor Execution the Runtime read back with exactly this revision, makes it true. An Adapter
 *   without an acknowledgement channel (the Pi Adapter reports `UNSUPPORTED`) can never reach it,
 *   and this panel says so instead of showing the delivery as done.
 *
 * Everything the panel renders comes from the Runtime; the client does not decide whether a delivery
 * was satisfied, and it does not re-derive the FSM. The two state-changing controls say what they
 * will do: creating a revision appends one and may record a delivery requirement, and "resolve"
 * either retries the conversation channel or stops the Execution and starts a successor.
 */

const deliveryStateLabels: Record<string, string> = {
  PENDING: '待投递',
  IN_FLIGHT: '投递进行中',
  ACKNOWLEDGED: '已确认（结构化 ACK）',
  UNACKNOWLEDGED: '未确认（通道未确认）',
  CHANNEL_UNSUPPORTED: '通道不支持',
  TIMED_OUT: '未确认（超时）',
  FAILED: '投递失败',
  SUPERSEDED_BY_RESTART: '已确认（后继执行）',
};

export function deliveryStateLabel(state: string): string {
  return deliveryStateLabels[state] ?? state;
}

export function deliveryChannelLabel(channel: string | null): string {
  if (channel === 'PROVIDER_CONVERSATION') return '会话通报';
  if (channel === 'STOP_AND_RESTART') return '停止并新建执行';
  return channel ?? '—';
}

export function resolutionOutcomeLabel(outcome: string): string {
  if (outcome === 'SUPERSEDED_BY_RESTART') return '已由后继执行确认';
  if (outcome === 'ALREADY_SATISFIED') return '此前已确认';
  if (outcome === 'RESOLVED') return '已确认';
  if (outcome === 'UNSATISFIED') return '仍未确认';
  if (outcome === 'RECOVERY_REQUIRED') return '需要人工处理';
  return outcome;
}

/**
 * The three facts of one delivery, kept apart exactly as the domain FSM defines them. This is a pure
 * projection of recorded fields — it never upgrades an attempt into a confirmation.
 */
export interface DeliveryFacts {
  /** The Runtime recorded that this revision must reach the Execution. Always true for a row. */
  readonly recorded: true;
  /** At least one channel attempt is in the ledger. Dispatched is *not* confirmed. */
  readonly dispatched: boolean;
  /** Only a structured ACK or a verified successor Execution satisfies the requirement. */
  readonly confirmed: boolean;
  /** True when an attempt is recorded in flight, so the Runtime can still conclude it. */
  readonly inFlight: boolean;
  /** True when no recorded channel can acknowledge, so the restart fallback is the honest route. */
  readonly channelUnsupported: boolean;
  /** The Task moved on to a later revision; a restart could never confirm this one. */
  readonly stale: boolean;
}

/** The recorded fields these facts are read from; `attemptInFlight` only exists on the list form. */
type DeliveryFactInput = Pick<RevisionDeliveryRecordView,
  'attempts' | 'attemptCount' | 'state' | 'satisfied' | 'stale'> & {
    readonly attemptInFlight?: boolean;
  };

export function deliveryFacts(delivery: DeliveryFactInput): DeliveryFacts {
  const attemptStates = delivery.attempts.map((attempt) => attempt.state);
  return {
    recorded: true,
    dispatched: delivery.attemptCount > 0 || delivery.attempts.length > 0,
    confirmed: delivery.satisfied,
    inFlight: (delivery.attemptInFlight ?? false) || attemptStates.includes('IN_FLIGHT'),
    channelUnsupported: delivery.state === 'CHANNEL_UNSUPPORTED'
      || (attemptStates.length > 0 && attemptStates.every((state) => state === 'CHANNEL_UNSUPPORTED')),
    stale: delivery.stale,
  };
}

/**
 * What an Adapter that cannot acknowledge means for the user: the revision cannot be carried into
 * the running conversation, so the only honest disposition is a stop-and-restart. Rendered as the
 * Runtime recorded it — the panel never decides an Adapter's capability by itself.
 */
export function deliveryAdvisory(delivery: RevisionDeliveryRecordView): string | null {
  const facts = deliveryFacts(delivery);
  if (facts.confirmed) return null;
  if (facts.stale) {
    return '该修订已被更晚的修订取代：停止并新建执行会以当前修订建立后继执行，'
      + '因此这条投递无法通过重启被确认，Runtime 会以 SUCCESSOR_REVISION_MISMATCH 拒绝。';
  }
  if (facts.channelUnsupported) {
    return '该 adapter 不支持热投递（Runtime 记录的通道事实为 CHANNEL_UNSUPPORTED）：重试会话通道只会'
      + '再记录一次同样的事实。需停止当前执行并新建一次执行，后继执行记录为该修订后才算确认。';
  }
  if (facts.inFlight) {
    return '有一次投递尝试正在进行（IN_FLIGHT）；Runtime 会自行得出结论，'
      + '在此之前不要重复发起投递或重启。';
  }
  return '记录里没有任何确认证据。可使「重试热投递」重新尝试会话通道，'
    + '或用「停止并新建执行」走停止并重启的兜底路径。';
}

/** Whether a resolve control may be offered at all: a confirmed or stale delivery cannot be fixed. */
export function deliveryResolvable(delivery: RevisionDeliveryRecordView): boolean {
  const facts = deliveryFacts(delivery);
  return !facts.confirmed && !facts.stale && !facts.inFlight;
}

/**
 * `task revision create` exactly as the CLI builds it. The detail is the only field this panel can
 * change (it exposes no feature declaration and constraints no longer exist, ADR-0065 D04), so a
 * revision that would change nothing is refused before it leaves the client — the Runtime refuses it
 * too, this only avoids a pointless round trip.
 */
export function revisionCreateCommand(input: {
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly commandId: string;
  readonly specification: string | null;
  readonly reason: string;
}): Record<string, unknown> {
  const specification = input.specification === null ? null : input.specification.trim();
  if (specification === null || specification.length === 0) {
    throw new Error('新建修订必须修改任务详情');
  }
  const reason = input.reason.trim();
  return {
    command: 'task.revision.create',
    commandId: input.commandId,
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: input.expectedVersion,
    specification,
    reason: reason.length === 0 ? 'user revision request' : reason,
  };
}

/**
 * `task revision delivery resolve`. `STOP_AND_RESTART` cooperatively stops the Execution that cannot
 * be confirmed on the new revision and starts a successor; `RETRY` re-attempts the conversation
 * channel, which for an Adapter without an acknowledgement channel records
 * `CHANNEL_UNSUPPORTED` again instead of claiming a delivery.
 */
export function revisionDeliveryResolveCommand(input: {
  readonly projectId: string;
  readonly taskId: string;
  readonly deliveryId: string;
  readonly action: 'STOP_AND_RESTART' | 'RETRY';
  readonly expectedVersion: number;
  readonly adapterId: string;
  readonly commandId: string;
}): Record<string, unknown> {
  return {
    command: 'task.revision.delivery.resolve',
    commandId: input.commandId,
    projectId: input.projectId,
    taskId: input.taskId,
    deliveryId: input.deliveryId,
    action: input.action,
    expectedVersion: input.expectedVersion,
    adapterId: input.adapterId,
  };
}

/** What a resolve actually produced, said in words that keep "still unconfirmed" visible. */
export function resolveOutcomeNotice(result: RevisionDeliveryResolutionView): string {
  const label = resolutionOutcomeLabel(result.outcome);
  const successor = result.successorExecutionId === null
    ? '' : `（后继执行 ${result.successorExecutionId.slice(0, 8)}）`;
  return `解决结果：${label}${successor} · ${result.detail}`;
}

/** What `task revision create` recorded, including the delivery requirement it may have created. */
export function creationNotice(created: RevisionCreationView): string {
  const base = `已新建修订 r${created.revisionNumber}（${created.revisionId.slice(0, 8)}）`;
  if (created.deliveryId === null) {
    return `${base}；此刻没有执行在运行该任务，因此没有产生投递要求。`;
  }
  return `${base}；此刻有执行在运行，已记录投递要求 ${created.deliveryId.slice(0, 8)}`
    + '（这说明它需要在执行里生效，不代表已经投递或确认）。';
}

/** One line summary of a specification body; the full text stays available in a `<details>`. */
export function revisionSpecSummary(specification: string, limit = 90): string {
  const collapsed = specification.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit)}…`;
}

function shortId(value: string | null): string {
  return value === null ? '—' : value.slice(0, 8);
}

function timeLabel(at: number | null): string {
  return at === null ? '—' : new Date(at).toLocaleString('zh-CN');
}

function factChip(text: string, tone: 'recorded' | 'dispatched' | 'confirmed' | 'missing') {
  return <span className={`fact fact-${tone}`}>{text}</span>;
}

/** The three facts as three separate chips, so no reader can merge them into one state word. */
function DeliveryFactsRow({ facts }: { readonly facts: DeliveryFacts }) {
  return (
    <p className="delivery-facts">
      {factChip('已记录', 'recorded')}
      {factChip(facts.dispatched ? '已投递（有通道尝试）' : '未投递（无通道尝试）',
        facts.dispatched ? 'dispatched' : 'missing')}
      {factChip(facts.confirmed ? '已确认' : '未确认', facts.confirmed ? 'confirmed' : 'missing')}
      {facts.stale ? factChip('已被更晚的修订取代', 'missing') : null}
    </p>
  );
}

/** The append-only attempt ledger of one delivery: channel, state, evidence, error code, times. */
function DeliveryAttempts({ delivery }: { readonly delivery: RevisionDeliveryRecordView }) {
  if (delivery.attempts.length === 0) {
    return <p className="muted">还没有任何投递尝试记录：只记录了这个修订必须生效的要求。</p>;
  }
  return (
    <div className="table-scroll"><table>
      <thead>
        <tr><th>#</th><th>通道</th><th>结果</th><th>执行 / 会话</th><th>证据</th><th>开始</th>
          <th>结束</th><th>错误码 / 说明</th></tr>
      </thead>
      <tbody>
        {delivery.attempts.map((attempt) => (
          <tr key={attempt.id}>
            <td>{attempt.attemptNumber}</td>
            <td>{deliveryChannelLabel(attempt.channel)}</td>
            <td>{deliveryStateLabel(attempt.state)}</td>
            <td className="mono">{shortId(attempt.executionId)} / {shortId(attempt.sessionId)}</td>
            <td className="mono">{attempt.evidenceRef ?? '—'}</td>
            <td>{timeLabel(attempt.startedAt)}</td>
            <td>{timeLabel(attempt.endedAt)}</td>
            <td>
              {attempt.errorCode === null ? null
                : <><span className="mono">{attempt.errorCode}</span>{' '}</>}
              <span className="muted">{attempt.detail}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

/** One delivery requirement with its ledger and its (explicit, state-changing) disposition controls. */
export function RevisionDeliveryCard({ delivery, adapterId, busy, onResolve }: {
  readonly delivery: RevisionDeliveryView;
  readonly adapterId: string;
  readonly busy: boolean;
  readonly onResolve: (delivery: RevisionDeliveryView, action: 'STOP_AND_RESTART' | 'RETRY') => void;
}) {
  const facts = deliveryFacts(delivery);
  const advisory = deliveryAdvisory(delivery);
  return (
    <li className="card nested delivery-card">
      <div className="row-head">
        <strong>修订 r{delivery.revisionNumber}</strong>
        <span className="state">{deliveryStateLabel(delivery.state)}</span>
        <span className="muted mono">{delivery.id.slice(0, 8)}</span>
        <span className="muted">记录于 {timeLabel(delivery.createdAt)}</span>
      </div>
      <DeliveryFactsRow facts={facts} />
      <dl className="kv">
        <dt>目标执行 / 会话</dt>
        <dd className="mono">{shortId(delivery.executionId)} / {shortId(delivery.sessionId)}</dd>
        <dt>确认证据</dt>
        <dd className="mono">{delivery.evidenceRef ?? '无（未确认）'}
          {delivery.acknowledgedAt === null ? null
            : <div className="muted">确认时间 {timeLabel(delivery.acknowledgedAt)}</div>}</dd>
        <dt>后继执行</dt>
        <dd className="mono">{shortId(delivery.supersededByExecutionId)}
          {delivery.supersededByExecutionId === null
            ? <span className="muted">（还没有由重启产生的后继执行）</span> : null}</dd>
        <dt>更新时间</dt>
        <dd>{timeLabel(delivery.updatedAt)}</dd>
        {delivery.detail === null ? null : (
          <>
            <dt>Runtime 说明</dt>
            <dd className="muted">{delivery.detail}</dd>
          </>
        )}
      </dl>
      {advisory === null ? null : <p className="muted hint">{advisory}</p>}
      <details>
        <summary>投递尝试台账 · {delivery.attempts.length} 次</summary>
        <DeliveryAttempts delivery={delivery} />
      </details>
      {facts.confirmed ? (
        <p className="muted hint">已确认的投递不再需要处置；重复确认会被 Runtime 拒绝。</p>
      ) : (
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={busy || !deliveryResolvable(delivery)}
            title={'以当前选择的 adapter（' + adapterId + '）停止这个无法确认的执行，'
              + '并在同一工作树新建一次后续执行；只有后继执行被记录为该修订时才算确认'}
            onClick={() => { onResolve(delivery, 'STOP_AND_RESTART'); }}
          >
            停止并新建执行（解决）
          </button>
          {facts.channelUnsupported ? null : (
            <button
              type="button"
              disabled={busy || !deliveryResolvable(delivery)}
              title="只重新尝试会话通道，不新建执行；不会把未确认记为已确认"
              onClick={() => { onResolve(delivery, 'RETRY'); }}
            >
              重试热投递
            </button>
          )}
          {facts.stale || facts.inFlight || facts.channelUnsupported ? null : (
            <span className="muted hint">两个动作都会写入记录；重试不会新建执行。</span>
          )}
        </div>
      )}
      {facts.stale ? (
        <p className="muted hint">这条投递已过期：Runtime 不会把它标记为已确认。</p>
      ) : null}
    </li>
  );
}

/** The revision history itself: version, time, detail, reason and the actor who recorded it. */
export function RevisionTable({ revisions }: { readonly revisions: readonly TaskRevisionSummaryView[] }) {
  if (revisions.length === 0) return <p className="muted">还没有读取到修订记录。</p>;
  return (
    <div className="table-scroll"><table>
      <thead>
        <tr><th>版本</th><th>修订</th><th>时间</th><th>任务详情摘要</th><th>原因 / 记录者</th></tr>
      </thead>
      <tbody>
        {revisions.map((revision) => (
          <tr key={revision.id}>
            <td>
              r{revision.number}
              {revision.current ? <div><span className="state state-ready">当前</span></div> : null}
            </td>
            <td className="mono">{revision.id.slice(0, 8)}
              {revision.previousRevisionId === null ? null
                : <div className="muted">上一个 {revision.previousRevisionId.slice(0, 8)}</div>}</td>
            <td>{timeLabel(revision.createdAt)}</td>
            <td>
              {revisionSpecSummary(revision.specification)}
              <details>
                <summary>完整任务详情</summary>
                <pre>{revision.specification}</pre>
              </details>
            </td>
            <td>{revision.reason}
              <div className="muted">{revision.actor}</div></td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

/** The one line of the create form that says what creating a revision will actually change. */
const createEffectNote = '新建修订会追加一条不可变的任务详情版本（当前详情与旧修订保留）。'
  + '若此刻有执行在运行该任务，Runtime 会额外记录一条投递要求；'
  + '记录投递要求不等于投递，更不等于确认。';

export function RevisionCreateForm({ busy, taskVersion, onCreate }: {
  readonly busy: boolean;
  readonly taskVersion: number;
  readonly onCreate: (draft: { readonly specification: string; readonly reason: string }) => void;
}) {
  const [specification, setSpecification] = useState('');
  const [reason, setReason] = useState('');
  // A revision that changes nothing is refused; the form says so before the button is usable.
  const valid = specification.trim().length > 0;
  return (
    <details className="revision-create">
      <summary>新建修订（会追加任务详情版本）</summary>
      <fieldset disabled={busy} aria-busy={busy}>
        <p className="muted hint">{createEffectNote}</p>
        <label htmlFor="revision-specification">任务详情（必填）</label>
        <textarea
          id="revision-specification"
          value={specification}
          rows={5}
          placeholder="新的完整任务详情"
          onChange={(event) => { setSpecification(event.target.value); }}
        />
        <label htmlFor="revision-reason">修改原因（记录在修订里）</label>
        <input
          id="revision-reason"
          value={reason}
          placeholder="用户修订请求"
          onChange={(event) => { setReason(event.target.value); }}
        />
        <p className="muted hint">将按当前任务版本 v{taskVersion} 提交；版本已变化会被拒绝，不会覆盖。</p>
        <button
          type="button"
          className="primary"
          disabled={busy || !valid}
          title={valid ? createEffectNote : '必须修改任务详情'}
          onClick={() => {
            onCreate({ specification, reason });
            setSpecification(''); setReason('');
          }}
        >
          新建修订（追加版本）
        </button>
      </fieldset>
    </details>
  );
}

/**
 * The revision/delivery projection for one Task, reading `task revision list` (which returns the
 * revision history and the delivery ledger in one response) and nothing else.
 */
export function RevisionDeliveryPanel({ client, projectId, taskId, taskVersion, adapterId,
  refreshToken, run, onChanged }: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  readonly taskId: string;
  /** The Task version this client last read; the write commands are validated against it. */
  readonly taskVersion: number;
  /** The adapter the successor Execution would use, exactly as `--adapter` on the CLI. */
  readonly adapterId: string;
  readonly refreshToken: number;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
  /** Called after a command changed the Task, so the surrounding detail view reloads. */
  readonly onChanged?: () => Promise<void>;
}) {
  const [view, setView] = useState<TaskRevisionListView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await client.command<TaskRevisionListView>({
        command: 'task.revision.list', projectId, taskId,
      });
      setView(next);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [client, projectId, taskId]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const after = async (message: string): Promise<void> => {
    setNotice(message);
    await load();
    if (onChanged !== undefined) await onChanged();
  };

  const create = (draft: { readonly specification: string; readonly reason: string }): void => {
    void run('正在新建修订', async () => {
      setPending(true);
      try {
        const created = await client.command<RevisionCreationView>(revisionCreateCommand({
          projectId,
          taskId,
          expectedVersion: taskVersion,
          commandId: crypto.randomUUID(),
          specification: draft.specification,
          reason: draft.reason,
        }));
        await after(creationNotice(created));
      } finally {
        setPending(false);
      }
    });
  };

  const resolve = (delivery: RevisionDeliveryView, action: 'STOP_AND_RESTART' | 'RETRY'): void => {
    void run(action === 'STOP_AND_RESTART' ? '正在停止执行并新建后续执行' : '正在重试热投递',
      async () => {
        setPending(true);
        try {
          const result = await client.command<RevisionDeliveryResolutionView>(
            revisionDeliveryResolveCommand({
              projectId,
              taskId,
              deliveryId: delivery.id,
              action,
              expectedVersion: taskVersion,
              adapterId,
              commandId: crypto.randomUUID(),
            }));
          await after(resolveOutcomeNotice(result));
        } finally {
          setPending(false);
        }
      });
  };

  return (
    <section className="revision-panel">
      <h4>修订与投递 <span className="muted hint">ADR-0028 · 记录 ≠ 投递 ≠ 确认</span></h4>
      <p className="muted hint">
        只有结构化 ACK（通道能确认并给出证据）或经核验的后继 Execution 才算确认。
        消息发出去了不算，Runtime 没有确认的记录会一直保持未确认。
      </p>
      {error === null ? null : <p className="error" role="alert">修订与投递读取失败：{error}</p>}
      {notice === null ? null : <p className="muted" role="status">{notice}</p>}
      <div className="actions">
        <button type="button" disabled={pending}
          onClick={() => { void run('正在刷新修订与投递', load); }}>刷新</button>
      </div>
      {view === null ? <p className="muted" role="status">正在读取修订与投递…</p> : (
        <>
          <h5>规格修订 · {view.revisions.length} 条</h5>
          <RevisionTable revisions={view.revisions} />
          <RevisionCreateForm busy={pending} taskVersion={taskVersion} onCreate={create} />
          <h5>投递台账 · {view.deliveries.length} 条</h5>
          {view.deliveries.length === 0 ? (
            <p className="muted">
              还没有投递要求：只有在执行正在运行时新建修订，Runtime 才会记录一条。
            </p>
          ) : (
            <ul className="list">
              {view.deliveries.map((delivery) => (
                <RevisionDeliveryCard key={delivery.id} delivery={delivery} adapterId={adapterId}
                  busy={pending} onResolve={resolve} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
