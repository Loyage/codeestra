/**
 * Annotating a completion the Runtime must not report as an unexplained success.
 *
 * An Agent sometimes ends a run without calling a single tool and asks its question in ordinary
 * prose ("Which package manager should I use?"). The Runtime records such a run as `SUCCESS`
 * today, which reads as "success, and yet nothing happened". Recording the completion is not a
 * lie; leaving it unexplained is. This module holds the one deterministic rule that decides when
 * that happened, plus the stable reason code of the note.
 *
 * Two limits are part of the design, not an accident:
 *
 * 1. **This is a heuristic, not a semantic judgement.** The rule looks at provider-reported facts
 *    (`toolCallCount`, the trailing characters of the last assistant text). It does not understand
 *    language, intent, or whether the Agent is actually waiting for the user. Every consumer must
 *    present the code as a note about the shape of the ending, not as "the Agent wants an answer".
 * 2. **A miss is preferred over a false alarm.** Labelling an ordinary completion as suspicious is
 *    the same kind of lie as an unexplained success, so the rule only fires on the narrowest shape
 *    we can state exactly: no tool call in the whole run, and the last assistant text whose final
 *    character is a question mark. Chinese questions that end without `？` (for example `…可以吗`),
 *    questions followed by other prose, and adapters that report no facts are deliberately missed.
 *
 * The note changes no Task/Execution state, adds no confirmation, and is not an Attention: this
 * channel never turns "maybe waiting" into `WAITING_FOR_USER` (ADR-0004/0014, invariant 9).
 */

/** Stable reason code of the annotation. It is the machine-readable half of the note. */
export const PROSE_QUESTION_NO_TOOL_USE = 'PROSE_QUESTION_NO_TOOL_USE' as const;

/** Stable identifier of the rule that produced the note; renaming it is a breaking change. */
export const noToolCallsWithTrailingQuestionMarkHeuristic =
  'NO_TOOL_CALLS_IN_RUN_AND_TRAILING_QUESTION_MARK' as const;

/**
 * One completion's provider-reported facts, as the domain needs them. Structurally a twin of the
 * contract's `AgentCompletionFacts` so this package stays free of wire dependencies.
 */
export interface AgentCompletionFacts {
  /** Tool invocations the provider reported during the run; 0 means it reported none. */
  readonly toolCallCount: number;
  /** Tail of the last assistant text of the run; `null` when the run produced none. */
  readonly finalAssistantText: string | null;
  /** True when `finalAssistantText` is only the tail of a longer text. */
  readonly finalAssistantTextTruncated: boolean;
  /** Provider-reported stop reason of that message; `null` when the provider did not say. */
  readonly finalAssistantStopReason: string | null;
}

/** The recorded note: a stable code, the rule that fired, and the facts it was applied to. */
export interface AgentCompletionNote {
  readonly code: typeof PROSE_QUESTION_NO_TOOL_USE;
  readonly heuristic: typeof noToolCallsWithTrailingQuestionMarkHeuristic;
  readonly message: string;
  readonly facts: AgentCompletionFacts;
}

/**
 * Wording shown to users and scripts. It states the observation and the heuristic in the same
 * breath, so no reader can mistake the note for a claim about the Agent's intent.
 */
export const proseQuestionNoteMessage =
  'The provider reported no tool call in this run, and the last assistant text ends with a question'
  + ' mark. This is a heuristic about the shape of the ending, not a semantic judgement that the'
  + ' Agent is waiting for an answer.';

/**
 * Characters an assistant may end a sentence with *after* its question mark (Markdown emphasis,
 * quotes, closing brackets). Stripping them keeps `**Ready to proceed?**` detectable without
 * loosening the rule: the question mark still has to be the last punctuation-free character.
 */
const trailingDecoration = new Set([
  '*', '_', '`', '"', "'", '\u2018', '\u2019', '\u201c', '\u201d',
  ')', ']', '}', '\u3011', '\u300b', '>', '.',
]);

function withoutTrailingDecoration(text: string): string {
  let end = text.length;
  while (end > 0 && trailingDecoration.has(text[end - 1] as string)) end -= 1;
  return text.slice(0, end);
}

/**
 * The single rule. Returns the note to record, or `null` when the completion needs no annotation.
 * Pure: it reads only its argument and allocates nothing shared.
 */
export function classifyAgentCompletion(
  facts: AgentCompletionFacts,
): AgentCompletionNote | null {
  // A run that used a tool did something; the complaint this channel answers is "SUCCESS and
  // nothing happened", so anything with a tool call is out of scope by construction.
  if (facts.toolCallCount !== 0) return null;
  const text = facts.finalAssistantText;
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const tail = withoutTrailingDecoration(trimmed);
  const mark = tail.slice(-1);
  if (mark !== '?' && mark !== '\uff1f') return null;
  // A bare `?` (or `??`) is punctuation, not a question, and `Done?` in a table cell is noise.
  // Requiring two characters of actual wording before the mark is the cheapest guard against both
  // (decoration such as `**?` is stripped first, so emphasis alone never counts as wording).
  const body = withoutTrailingDecoration(tail.slice(0, -1)).trim();
  if (body.length < 2) return null;
  return Object.freeze({
    code: PROSE_QUESTION_NO_TOOL_USE,
    heuristic: noToolCallsWithTrailingQuestionMarkHeuristic,
    message: proseQuestionNoteMessage,
    facts: Object.freeze({ ...facts }),
  });
}
