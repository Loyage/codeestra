import { useState } from 'react';
import { describeError } from './api.js';
import type { AttentionView, ProseQuestionResolutionResultView } from './types.js';

/**
 * The prose-question wait (FOUNDATION-069 / ADR-0043), projected onto `attention resolve`.
 *
 * A prose question is not a provider dialog. The Agent ended its turn without calling a single tool
 * and asked its question in ordinary prose, its process already exited, and the Runtime recorded the
 * wait from that shape alone (`PROSE_QUESTION_NO_TOOL_USE`, a heuristic about the *ending* — never a
 * claim about intent). Two consequences are the whole reason this view exists apart from the
 * permission/questionnaire cards in 「待处理」:
 *
 * 1. **There is no provider request to answer.** `attention answer` is refused by the Runtime with
 *    `PROSE_QUESTION_RESOLUTION_REQUIRED`; the only way out is `attention resolve`, which records
 *    either `ANSWERED` (the user's own text) or `DISMISSED_FALSE_POSITIVE` (a false alarm).
 * 2. **A recorded answer is not delivered anywhere.** It goes into the audit trail and the event
 *    log. It does not resume the conversation, and it is not a TaskRevision. Continuing the work
 *    needs an explicit `task resume` / `task run` afterwards — which is exactly what the wording
 *    here says, so nobody reads the card as "answer and the Agent carries on".
 *
 * The discriminators below are wire literals owned by `@codeestra/domain`
 * (`prose-question-attention.ts`, `agent-completion-signal.ts`). This client cannot import that
 * package (it is a browser bundle with no workspace code dependency), so it re-checks the stored
 * payload structurally instead of trusting it — the same approach the questionnaire view takes. A
 * payload that does not validate is *not* treated as a prose question: guessing here is what would
 * let an unrelated Attention be resolved through the wrong route. `apps/ui/test/prose-wait.test.ts`
 * reads the domain sources and asserts these literals still match.
 */
export const proseQuestionPromptKind = 'codeestra.prose-question';
export const proseQuestionNoToolUseCode = 'PROSE_QUESTION_NO_TOOL_USE';
export const proseQuestionHeuristic = 'NO_TOOL_CALLS_IN_RUN_AND_TRAILING_QUESTION_MARK';

/** The provider-reported facts the heuristic was applied to; an absent fact means "unknown". */
export interface ProseQuestionFactsView {
  readonly toolCallCount: number;
  readonly finalAssistantText: string | null;
  readonly finalAssistantTextTruncated: boolean;
  readonly finalAssistantStopReason: string | null;
}

/** The stored prose-question prompt, re-checked structurally before it is rendered as one. */
export interface ProseQuestionWaitView {
  readonly message: string;
  readonly text: string | null;
  readonly textTruncated: boolean;
  readonly facts: ProseQuestionFactsView;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFacts(value: unknown): ProseQuestionFactsView | null {
  if (!isRecord(value)) return null;
  const toolCallCount = value['toolCallCount'];
  const finalAssistantText = value['finalAssistantText'];
  const finalAssistantTextTruncated = value['finalAssistantTextTruncated'];
  const finalAssistantStopReason = value['finalAssistantStopReason'];
  if (typeof toolCallCount !== 'number') return null;
  if (typeof finalAssistantText !== 'string' && finalAssistantText !== null) return null;
  if (typeof finalAssistantTextTruncated !== 'boolean') return null;
  if (typeof finalAssistantStopReason !== 'string' && finalAssistantStopReason !== null) return null;
  return {
    toolCallCount,
    finalAssistantText,
    finalAssistantTextTruncated,
    finalAssistantStopReason,
  };
}

/**
 * Reads a stored Attention prompt back into the prose-question shape, or `null` when it is not one.
 * All three discriminators are required, so a provider-dialog Attention (or an approximated payload)
 * can never be routed into `attention.resolve`.
 */
export function readProseQuestionWait(prompt: unknown): ProseQuestionWaitView | null {
  if (!isRecord(prompt)) return null;
  if (prompt['kind'] !== proseQuestionPromptKind) return null;
  if (prompt['code'] !== proseQuestionNoToolUseCode) return null;
  if (prompt['heuristic'] !== proseQuestionHeuristic) return null;
  const message = prompt['message'];
  const text = prompt['text'];
  const textTruncated = prompt['textTruncated'];
  if (typeof message !== 'string') return null;
  if (typeof text !== 'string' && text !== null) return null;
  if (typeof textTruncated !== 'boolean') return null;
  const facts = readFacts(prompt['facts']);
  if (facts === null) return null;
  return { message, text, textTruncated, facts };
}

/** The one line that must never be missing: the answer is recorded, not delivered, not a revision. */
export const proseQuestionSemantics =
  'provider 进程已经退出，没有等待中的 provider 对话框。这里记录的回答只写入审计与事件，'
  + '不会送进 Agent 会话，也不会创建规格修订；要让它继续工作，必须在解除这次等待后显式重新运行'
  + '（task resume 复用会话 / task run 新建执行）。记录为「误报」同样只结束这次等待。';

/** The recorded shape of the ending, phrased as the heuristic it is rather than as intent. */
export function proseQuestionFactsLine(facts: ProseQuestionFactsView): string {
  return `工具调用 ${facts.toolCallCount} · 最后文本截断 ${facts.finalAssistantTextTruncated
    ? '是' : '否'} · 停止原因 ${facts.finalAssistantStopReason ?? '未报告'}`
    + ` · 判断规则 ${proseQuestionHeuristic}`;
}

/** How a resolution ended, in words that keep "nothing was delivered" explicit. */
export function proseResolutionNotice(result: ProseQuestionResolutionResultView): string {
  const what = result.resolution === 'ANSWERED'
    ? `已记录回答（${result.answerText === null ? '无文字' : '文字已存审计'}）`
    : '已记录为误报';
  return `${what}；未投递给 provider（deliveredToProvider=${String(result.deliveredToProvider)}）· `
    + `会话 ${result.sessionState} · 任务 ${result.taskState} · 等待 ${result.attentionStatus}。`
    + '如需 Agent 继续工作，请显式重新运行：task resume（复用会话）或 task run。';
}

/**
 * `attention resolve` exactly as the CLI builds it. `--answer <text>` requires text and
 * `--dismiss` must not carry any, so the payload cannot mean two things at once; the limits mirror
 * the contract (`maxProseQuestionAnswerLength` / `maxProseQuestionResolutionNoteLength`) and are
 * enforced here only to fail before a pointless round trip — the Runtime stays the boundary.
 */
export function proseQuestionResolveCommand(input: {
  readonly projectId: string;
  readonly attentionId: string;
  readonly commandId: string;
  readonly resolution: 'ANSWERED' | 'DISMISSED_FALSE_POSITIVE';
  readonly text?: string | null;
  readonly note?: string | null;
}): Record<string, unknown> {
  const text = input.text === undefined || input.text === null ? null : input.text.trim();
  const note = input.note === undefined || input.note === null ? null : input.note.trim();
  if (input.resolution === 'ANSWERED') {
    if (text === null || text.length === 0) throw new Error('记录回答必须填写回答文字');
    if (text.length > 4000) throw new Error('回答文字超过 4000 字符，Runtime 会拒绝而不是截断');
  } else if (text !== null) {
    throw new Error('误报不能携带回答文字');
  }
  if (note !== null && note.length > 2000) {
    throw new Error('备注超过 2000 字符，Runtime 会拒绝而不是截断');
  }
  return {
    command: 'attention.resolve',
    commandId: input.commandId,
    projectId: input.projectId,
    attentionId: input.attentionId,
    resolution: input.resolution,
    ...(text === null || text.length === 0 ? {} : { text }),
    ...(note === null || note.length === 0 ? {} : { note }),
  };
}

/**
 * One prose-question wait card. It is deliberately *not* the generic answer form: there is no
 * provider dialog, so the two controls record an answer (with text) or a false alarm (without), and
 * the card states plainly that neither resumes the conversation.
 */
export function ProseQuestionWaitCard({ wait, busy, resolve, onResolved }: {
  readonly wait: ProseQuestionWaitView;
  /** True while the surrounding inbox is already running an action for this Attention. */
  readonly busy: boolean;
  /** Sends `attention.resolve`; rejects with a `UiError` the card renders itself. */
  readonly resolve: (
    request: { readonly resolution: 'ANSWERED' | 'DISMISSED_FALSE_POSITIVE';
      readonly text?: string; readonly note?: string },
  ) => Promise<ProseQuestionResolutionResultView>;
  readonly onResolved: () => Promise<void>;
}) {
  const [answer, setAnswer] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProseQuestionResolutionResultView | null>(null);
  const disabled = busy || submitting || result !== null;
  const send = (resolution: 'ANSWERED' | 'DISMISSED_FALSE_POSITIVE'): void => {
    setSubmitting(true);
    setError(null);
    void (async () => {
      try {
        const resolved = await resolve({
          resolution,
          ...(resolution === 'ANSWERED' ? { text: answer } : {}),
          ...(note.trim().length === 0 ? {} : { note }),
        });
        setResult(resolved);
        await onResolved();
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setSubmitting(false);
      }
    })();
  };
  return (
    <div className="prose-wait">
      <p className="muted hint">{proseQuestionSemantics}</p>
      <dl className="kv">
        <dt>Runtime 的观察</dt>
        <dd className="muted">{wait.message}</dd>
        <dt>记录的事实</dt>
        <dd className="muted">{proseQuestionFactsLine(wait.facts)}</dd>
        <dt>最后一段文本</dt>
        <dd>{wait.text === null ? <span className="muted">没有记录到文本</span> : (
          <pre>{wait.text}{wait.textTruncated ? '\n…（Runtime 记录的是截断后的尾段）' : ''}</pre>
        )}</dd>
      </dl>
      <fieldset disabled={disabled} aria-busy={submitting}>
        <label htmlFor="prose-wait-answer">回答（只记录，不发送给 provider）</label>
        <textarea
          id="prose-wait-answer"
          value={answer}
          rows={3}
          placeholder="你打算怎么回答这个提问；这段文字只会进入审计与事件"
          onChange={(event) => { setAnswer(event.target.value); }}
        />
        <label htmlFor="prose-wait-note">备注（可选，记录在审计里）</label>
        <input
          id="prose-wait-note"
          value={note}
          placeholder="例如：这是不是误报、后续要做什么"
          onChange={(event) => { setNote(event.target.value); }}
        />
        <div className="actions">
          <button type="button" className="primary" disabled={disabled || answer.trim().length === 0}
            title="记录这段回答并结束这次等待；不会投递给 provider，也不会让 Agent 继续运行"
            onClick={() => { send('ANSWERED'); }}>
            记录回答（不投递）
          </button>
          <button type="button" disabled={disabled}
            title="这是启发式误报，不需要回答；只结束这次等待，不改变任何运行中的执行"
            onClick={() => { send('DISMISSED_FALSE_POSITIVE'); }}>
            记录为误报
          </button>
        </div>
      </fieldset>
      {error === null ? null : <p className="error" role="alert">记录失败：{error}</p>}
      {result === null ? null : (
        <p className="muted" role="status">{proseResolutionNotice(result)}</p>
      )}
    </div>
  );
}

/** True when this Attention is a prose-question wait rather than a provider dialog. */
export function isProseQuestionWait(attention: AttentionView): boolean {
  return attention.kind === 'QUESTION' && readProseQuestionWait(attention.prompt) !== null;
}
