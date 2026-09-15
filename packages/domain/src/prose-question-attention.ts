/**
 * Escalating "the Agent asked its question in prose and ended the turn" into a first-class wait.
 *
 * FOUNDATION-056 recorded that shape as a note on the completion (`PROSE_QUESTION_NO_TOOL_USE`) and
 * deliberately stopped there: the note explained an otherwise unexplained `SUCCESS` without
 * touching any state machine. That left the other half of ADR-0004/0014 undone, because a note
 * nobody has to act on can still leave a Task hanging with no Agent behind it. This module holds
 * the decision that turns the *same* narrow, deterministic observation into one recorded wait —
 * plus, and this is not optional, the explicit ways back out of it.
 *
 * Three limits are part of the design:
 *
 * 1. **The wait is derived from the FOUNDATION-056 note, not from a second judgement.** There is
 *    exactly one rule that decides "the Agent asked in prose and stopped"
 *    (`classifyAgentCompletion`); this module only decides what to do about a note that rule
 *    already produced. A miss stays a miss and a false alarm stays possible, which is why the
 *    downgrade switch and the resolution command exist.
 * 2. **No provider conversation is invented.** The provider process exited before this wait was
 *    recorded, so nothing here may route an answer through the Adapter's answer channel: there is
 *    no dialog to respond to, and writing one would report a delivery about a request that never
 *    existed. A resolution therefore never resumes the conversation.
 * 3. **An answer is not a revision.** Recording what the user said resolves *this wait*. It does
 *    not amend the Task specification, does not create a TaskRevision, and does not re-validate
 *    anything: `task amend` keeps its own semantics.
 *
 * Everything here is pure: no Bun, no database, no Git, no model.
 */

import {
  PROSE_QUESTION_NO_TOOL_USE,
  noToolCallsWithTrailingQuestionMarkHeuristic,
  type AgentCompletionFacts,
  type AgentCompletionNote,
} from './agent-completion-signal.js';

/** Prompt discriminator stored inside `attention_requests.prompt_json` (zero schema change). */
export const proseQuestionPromptKind = 'codeestra.prose-question' as const;

/**
 * `attention_requests.provider_request_id` is `NOT NULL` and unique per Session, but a prose
 * question has no provider request behind it. The Runtime records a derived, self-describing value
 * instead of leaving a hole or reusing a provider id that belongs to a real request.
 */
export const proseQuestionProviderRequestIdPrefix = 'codeestra-prose-question:' as const;

export function proseQuestionProviderRequestId(providerEventId: string): string {
  return `${proseQuestionProviderRequestIdPrefix}${providerEventId}`;
}

export function isProseQuestionProviderRequestId(providerRequestId: string): boolean {
  return providerRequestId.startsWith(proseQuestionProviderRequestIdPrefix);
}

/**
 * How eagerly the Runtime escalates the note into a wait.
 *
 * - `auto` (product default): the note becomes a `WAITING_FOR_USER` Task plus one Attention.
 *   ADR-0004 forbids an unbounded silent hang, and a Task whose Agent exited without doing
 *   anything is exactly that unless someone is told.
 * - `record-only`: FOUNDATION-056's behaviour exactly — annotate the completion, change no state.
 *   This is the explicit downgrade for anyone who would rather triage the notes themselves.
 * - `off`: do not even record the note.
 */
export const proseQuestionAttentionModes = ['auto', 'record-only', 'off'] as const;
export type ProseQuestionAttentionMode = (typeof proseQuestionAttentionModes)[number];

/** The product default. `record-only` is a downgrade, never the default. */
export const defaultProseQuestionAttentionMode: ProseQuestionAttentionMode = 'auto';

export function isProseQuestionAttentionMode(value: unknown): value is ProseQuestionAttentionMode {
  return typeof value === 'string'
    && (proseQuestionAttentionModes as readonly string[]).includes(value);
}

/** The payload recorded as the Attention's prompt for an escalated prose question. */
export interface ProseQuestionAttentionPrompt {
  readonly kind: typeof proseQuestionPromptKind;
  readonly code: typeof PROSE_QUESTION_NO_TOOL_USE;
  readonly heuristic: typeof noToolCallsWithTrailingQuestionMarkHeuristic;
  readonly message: string;
  /** The assistant text the rule saw; the same value as `facts.finalAssistantText`. */
  readonly text: string | null;
  readonly textTruncated: boolean;
  readonly facts: AgentCompletionFacts;
}

/**
 * The one place the Attention prompt is built, so the stored shape and the resolver agree on what
 * a prose-question Attention is. The note's own wording travels with it: a reader must be able to
 * see that this wait came from a heuristic about the shape of the ending.
 */
export function buildProseQuestionPrompt(note: AgentCompletionNote): ProseQuestionAttentionPrompt {
  return Object.freeze({
    kind: proseQuestionPromptKind,
    code: note.code,
    heuristic: note.heuristic,
    message: note.message,
    text: note.facts.finalAssistantText,
    textTruncated: note.facts.finalAssistantTextTruncated,
    facts: Object.freeze({ ...note.facts }),
  });
}

function isCompletionFacts(value: unknown): value is AgentCompletionFacts {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AgentCompletionFacts>;
  return typeof candidate.toolCallCount === 'number'
    && (typeof candidate.finalAssistantText === 'string' || candidate.finalAssistantText === null)
    && typeof candidate.finalAssistantTextTruncated === 'boolean'
    && (typeof candidate.finalAssistantStopReason === 'string'
      || candidate.finalAssistantStopReason === null);
}

/**
 * Reads a persisted prompt back into the prose-question shape, or `null` when it is not one.
 * A payload that does not validate is *not* a prose question: guessing here is what would let an
 * unrelated Attention be resolved through the prose-question route.
 */
export function readProseQuestionPrompt(prompt: unknown): ProseQuestionAttentionPrompt | null {
  if (typeof prompt !== 'object' || prompt === null) return null;
  const candidate = prompt as Partial<ProseQuestionAttentionPrompt>;
  if (candidate.kind !== proseQuestionPromptKind) return null;
  if (candidate.code !== PROSE_QUESTION_NO_TOOL_USE) return null;
  if (candidate.heuristic !== noToolCallsWithTrailingQuestionMarkHeuristic) return null;
  if (typeof candidate.message !== 'string') return null;
  if (typeof candidate.text !== 'string' && candidate.text !== null) return null;
  if (typeof candidate.textTruncated !== 'boolean') return null;
  if (!isCompletionFacts(candidate.facts)) return null;
  return {
    kind: proseQuestionPromptKind,
    code: candidate.code,
    heuristic: candidate.heuristic,
    message: candidate.message,
    text: candidate.text,
    textTruncated: candidate.textTruncated,
    facts: candidate.facts,
  };
}

/** Stable outcome codes of the escalation decision; a note is only ever escalated or not. */
export const proseQuestionEscalationCodes = {
  /** The note was escalated into a wait. */
  ESCALATED: 'PROSE_QUESTION_ESCALATED',
  /** The completion was annotated but no wait was recorded, because the mode says so. */
  RECORD_ONLY: 'PROSE_QUESTION_RECORD_ONLY',
  /** Nothing was recorded at all, because the mode says so. */
  DISABLED: 'PROSE_QUESTION_DISABLED',
} as const;

export type ProseQuestionEscalationCode =
  (typeof proseQuestionEscalationCodes)[keyof typeof proseQuestionEscalationCodes];

export interface ProseQuestionEscalationDecision {
  readonly note: AgentCompletionNote | null;
  readonly escalate: boolean;
  readonly code: ProseQuestionEscalationCode;
}

/**
 * The whole escalation policy, in one pure function: is there a note at all (mode), and does the
 * mode turn that note into a wait? A `null` completion note can only produce `RECORD_ONLY`.
 */
export function decideProseQuestionEscalation(
  mode: ProseQuestionAttentionMode,
  note: AgentCompletionNote | null,
): ProseQuestionEscalationDecision {
  if (mode === 'off') {
    return { note: null, escalate: false, code: proseQuestionEscalationCodes.DISABLED };
  }
  if (note === null) {
    return { note: null, escalate: false, code: proseQuestionEscalationCodes.RECORD_ONLY };
  }
  return {
    note,
    escalate: mode === 'auto',
    code: mode === 'auto'
      ? proseQuestionEscalationCodes.ESCALATED
      : proseQuestionEscalationCodes.RECORD_ONLY,
  };
}

/**
 * How the user ended a prose-question wait.
 *
 * - `DISMISSED_FALSE_POSITIVE`: the ending was an ordinary end of turn. The heuristic fired, the
 *   user says no answer is owed. This is the explicit downgrade the design owes a false alarm.
 * - `ANSWERED`: the user did answer in prose. The text is recorded as an audit fact and as the
 *   user's own account of what to do next. It is **not** delivered to a provider and it is **not**
 *   a TaskRevision.
 *
 * The two are different audit facts, so they are different values rather than one "resolved" flag.
 */
export const proseQuestionResolutions = ['DISMISSED_FALSE_POSITIVE', 'ANSWERED'] as const;
export type ProseQuestionResolution = (typeof proseQuestionResolutions)[number];

/** Stable reasons a resolution is refused. Refusals are recorded as facts, never guessed around. */
export const proseQuestionResolutionCodes = {
  /** The Attention exists but is not a prose-question Attention; use the normal answer channel. */
  NOT_A_PROSE_QUESTION: 'PROSE_QUESTION_ATTENTION_NOT_PROSE_QUESTION',
  /** The wait was already resolved (or delivered); a second resolution is not a second fact. */
  ALREADY_RESOLVED: 'PROSE_QUESTION_ATTENTION_ALREADY_RESOLVED',
  /** The provider Session is still alive, so this Attention is not the shape being resolved. */
  SESSION_NOT_EXITED: 'PROSE_QUESTION_SESSION_NOT_EXITED',
  /** The Execution is not the running attempt that asked; resolving would rewrite history. */
  EXECUTION_NOT_RUNNING: 'PROSE_QUESTION_EXECUTION_NOT_RUNNING',
  /** The Task is not waiting, so there is no wait to end. */
  TASK_NOT_WAITING: 'PROSE_QUESTION_TASK_NOT_WAITING',
  /** An answer must carry text and a dismissal must not. */
  INVALID_RESOLUTION_PAYLOAD: 'PROSE_QUESTION_INVALID_RESOLUTION_PAYLOAD',
} as const;

export type ProseQuestionResolutionCode =
  (typeof proseQuestionResolutionCodes)[keyof typeof proseQuestionResolutionCodes];

export type ProseQuestionResolutionDecision =
  | { readonly allowed: true; readonly code: null; readonly message: null }
  | { readonly allowed: false; readonly code: ProseQuestionResolutionCode; readonly message: string };

const allowed: ProseQuestionResolutionDecision = { allowed: true, code: null, message: null };

function refused(
  code: ProseQuestionResolutionCode,
  message: string,
): ProseQuestionResolutionDecision {
  return { allowed: false, code, message };
}

/** The recorded states a resolution decision reads. Strings, so storage may pass its own columns. */
export interface ProseQuestionResolutionFacts {
  /** `attention_requests.kind`. */
  readonly attentionKind: string;
  /** `attention_requests.status`. */
  readonly attentionStatus: string;
  /** The persisted `prompt_json`; the shape decides which route may resolve it. */
  readonly prompt: unknown;
  readonly sessionState: string;
  readonly executionState: string;
  readonly taskState: string;
}

/** Maximum accepted length of a recorded answer; longer text is refused, not truncated. */
export const maxProseQuestionAnswerLength = 4000;
/** Maximum accepted length of the optional free-text note on a dismissal. */
export const maxProseQuestionResolutionNoteLength = 2000;

export interface ProseQuestionResolutionInput {
  readonly resolution: ProseQuestionResolution;
  /** Required for `ANSWERED`, forbidden for `DISMISSED_FALSE_POSITIVE`. */
  readonly text: string | null;
  /** Optional explanation recorded with either resolution. */
  readonly note: string | null;
}

/**
 * Whether a resolution is well-formed. A missing answer or an answer smuggled into a dismissal is
 * refused rather than normalized, so the audit row always means exactly what it says.
 */
export function validateProseQuestionResolution(
  input: ProseQuestionResolutionInput,
): ProseQuestionResolutionDecision {
  const text = input.text === null ? null : input.text.trim();
  const note = input.note === null ? null : input.note.trim();
  if (input.resolution === 'ANSWERED') {
    if (text === null || text.length === 0) {
      return refused(proseQuestionResolutionCodes.INVALID_RESOLUTION_PAYLOAD,
        'An ANSWERED resolution must carry the text the user answered with');
    }
    if (text.length > maxProseQuestionAnswerLength) {
      return refused(proseQuestionResolutionCodes.INVALID_RESOLUTION_PAYLOAD,
        `The answer text exceeds ${maxProseQuestionAnswerLength} characters`);
    }
  } else if (text !== null) {
    return refused(proseQuestionResolutionCodes.INVALID_RESOLUTION_PAYLOAD,
      'A DISMISSED_FALSE_POSITIVE resolution must not carry answer text');
  }
  if (note !== null && note.length > maxProseQuestionResolutionNoteLength) {
    return refused(proseQuestionResolutionCodes.INVALID_RESOLUTION_PAYLOAD,
      `The resolution note exceeds ${maxProseQuestionResolutionNoteLength} characters`);
  }
  return allowed;
}

/**
 * Whether *this* Attention may be resolved through the prose-question route, and whether the
 * aggregates are in the shape the escalation recorded.
 *
 * The order matters: the prompt shape is checked before any state, because a provider-dialog
 * Attention must be sent back to the normal answer channel even when its states happen to line up.
 * Nothing here resumes a conversation, so a live Session is a refusal, not an alternative route.
 */
export function decideProseQuestionResolution(
  facts: ProseQuestionResolutionFacts,
): ProseQuestionResolutionDecision {
  if (facts.attentionKind !== 'QUESTION' || readProseQuestionPrompt(facts.prompt) === null) {
    return refused(proseQuestionResolutionCodes.NOT_A_PROSE_QUESTION,
      'This Attention is not a prose-question Attention; answer it through the answer channel');
  }
  if (facts.attentionStatus !== 'OPEN') {
    return refused(proseQuestionResolutionCodes.ALREADY_RESOLVED,
      `This prose-question Attention is already ${facts.attentionStatus}`);
  }
  if (facts.sessionState !== 'EXITED') {
    return refused(proseQuestionResolutionCodes.SESSION_NOT_EXITED,
      `The Agent Session is ${facts.sessionState}, so this wait cannot be resolved without`
      + ' discarding a live provider conversation');
  }
  if (facts.executionState !== 'RUNNING') {
    return refused(proseQuestionResolutionCodes.EXECUTION_NOT_RUNNING,
      `The Execution is ${facts.executionState}, so there is no waiting attempt to return to`);
  }
  if (facts.taskState !== 'WAITING_FOR_USER') {
    return refused(proseQuestionResolutionCodes.TASK_NOT_WAITING,
      `The Task is ${facts.taskState}, so it is not waiting for this answer`);
  }
  return allowed;
}
