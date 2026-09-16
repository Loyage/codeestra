import {
  agentFinalOutput,
  agentRunFactLines,
  agentRunHeadline,
  agentRunLabel,
  agentRunPhase,
  agentRunTone,
  type AgentRunFactView,
} from './agent-run.js';
import type { AgentSessionCompletionView } from './types.js';

/**
 * What the newest Agent attempt did, at the top of the Task detail: how it ended, the provider's
 * recorded facts, and the last text the Agent produced.
 *
 * The card is a projection, not a summary the client wrote: every line either comes from a recorded
 * fact or says that the fact is missing. It is also where the Agent's final output is read first,
 * so the full process below is a link, not a requirement.
 */

const toneBadgeClass = {
  ok: 'state state-ready',
  danger: 'state state-failed',
  unknown: 'state state-unknown',
  active: 'state state-running',
  neutral: 'state',
} as const;

const toneCardClass = {
  ok: 'tone-success',
  danger: 'tone-danger',
  unknown: 'tone-attention',
  active: 'tone-active',
  neutral: 'tone-neutral',
} as const;

export function AgentRunCard({ run, attemptNumber, completion, transcriptAnchorId }: {
  readonly run: AgentRunFactView;
  /** Which attempt this is, so the card cannot be mistaken for an older run. */
  readonly attemptNumber: number;
  /** The completion the Session recorded, with the provider facts; `null` when none was recorded. */
  readonly completion: AgentSessionCompletionView | null;
  /** Id of the in-page element holding the full session process; `null` hides the jump link. */
  readonly transcriptAnchorId: string | null;
}) {
  const phase = agentRunPhase(run);
  const tone = agentRunTone(phase);
  const facts = completion?.facts ?? null;
  const output = agentFinalOutput(facts);
  return (
    <section className={`agent-run-card ${toneCardClass[tone]}`}
      aria-label="Agent 运行结果">
      <div className="section-heading agent-run-heading">
        <h3>{agentRunHeadline(phase)}</h3>
        <span className={toneBadgeClass[tone]}>{agentRunLabel(phase)}</span>
      </div>
      <p className="muted hint">
        第 {attemptNumber} 次尝试 · {agentRunFactLines(facts).join(' · ')}
      </p>
      {completion?.failure == null ? null : (
        <p className="error" role="alert">
          provider 报告的失败：<span className="mono">{completion.failure.code}</span>
          {completion.failure.message === null || completion.failure.message === undefined
            ? null : ` ${completion.failure.message}`}
        </p>
      )}
      <div className="agent-run-output-block">
        <span className="eyebrow">最后的输出
          {facts === null ? '' : facts.finalAssistantTextTruncated ? '（尾部）' : '（全文）'}
        </span>
        {output === null ? (
          <p className="muted">
            没有记录到助手文本。这不表示 Agent 什么都没说，只表示这次结束没有把文本记录下来。
          </p>
        ) : (
          <pre className="agent-run-output">{output}</pre>
        )}
        {facts?.finalAssistantTextTruncated === true ? (
          <p className="muted hint">
            Runtime 只保留了这段文本的最后 2000 个字符；更早的部分不在记录里。
          </p>
        ) : null}
      </div>
      {transcriptAnchorId === null ? null : (
        <p className="agent-run-jump">
          <a href={`#${transcriptAnchorId}`}>查看完整会话记录 ↓</a>
          <span className="muted hint">（下方「Agent 会话与执行过程」；只读，不改任务状态）</span>
        </p>
      )}
    </section>
  );
}
