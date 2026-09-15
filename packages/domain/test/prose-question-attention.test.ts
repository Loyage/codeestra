import { describe, expect, it } from 'vitest';
import {
  buildProseQuestionPrompt,
  classifyAgentCompletion,
  decideProseQuestionEscalation,
  decideProseQuestionResolution,
  defaultProseQuestionAttentionMode,
  isProseQuestionAttentionMode,
  isProseQuestionProviderRequestId,
  maxProseQuestionAnswerLength,
  maxProseQuestionResolutionNoteLength,
  proseQuestionAttentionModes,
  proseQuestionPromptKind,
  proseQuestionProviderRequestId,
  readProseQuestionPrompt,
  validateProseQuestionResolution,
  type AgentCompletionFacts,
  type AgentCompletionNote,
} from '../src/index.js';

/**
 * The decision matrix of the prose-question wait (FOUNDATION-069 / ADR-0043).
 *
 * The rules under test are pure, so every branch is pinned here rather than through the Runtime.
 * The two properties that matter most are that the wait is derived from the FOUNDATION-056 note
 * rather than from a second judgement, and that every state which is *not* the recorded wait shape
 * is refused with its own code instead of being coerced into a resolution.
 */

const facts = (overrides: Partial<AgentCompletionFacts> = {}): AgentCompletionFacts => ({
  toolCallCount: 0,
  finalAssistantText: 'Which package manager should I use?',
  finalAssistantTextTruncated: false,
  finalAssistantStopReason: 'stop',
  ...overrides,
});

const note = (): AgentCompletionNote => {
  const produced = classifyAgentCompletion(facts());
  if (produced === null) throw new Error('the fixture must produce a note');
  return produced;
};

const prompt = () => buildProseQuestionPrompt(note());

describe('prose question attention', () => {
  it('derives the wait from the FOUNDATION-056 note, never from a second judgement', () => {
    // The prompt is the note restated: same code, same heuristic, same facts, same wording.
    expect(prompt()).toEqual({
      kind: proseQuestionPromptKind,
      code: 'PROSE_QUESTION_NO_TOOL_USE',
      heuristic: 'NO_TOOL_CALLS_IN_RUN_AND_TRAILING_QUESTION_MARK',
      message: note().message,
      text: 'Which package manager should I use?',
      textTruncated: false,
      facts: facts(),
    });
    // A completion the rule did not annotate cannot be escalated, whatever the mode says.
    expect(decideProseQuestionEscalation('auto', null)).toEqual({
      note: null, escalate: false, code: 'PROSE_QUESTION_RECORD_ONLY',
    });
  });

  it('escalates in auto, records only in record-only, and records nothing when off', () => {
    expect(defaultProseQuestionAttentionMode).toBe('auto');
    expect(decideProseQuestionEscalation('auto', note())).toMatchObject({
      escalate: true, code: 'PROSE_QUESTION_ESCALATED',
    });
    // The downgrade keeps the annotation and drops the wait: strictly less, never more.
    expect(decideProseQuestionEscalation('record-only', note())).toMatchObject({
      escalate: false, code: 'PROSE_QUESTION_RECORD_ONLY',
    });
    expect(decideProseQuestionEscalation('record-only', note()).note).not.toBeNull();
    expect(decideProseQuestionEscalation('off', note())).toEqual({
      note: null, escalate: false, code: 'PROSE_QUESTION_DISABLED',
    });
  });

  it('accepts only the three documented modes', () => {
    expect([...proseQuestionAttentionModes]).toEqual(['auto', 'record-only', 'off']);
    for (const mode of proseQuestionAttentionModes) expect(isProseQuestionAttentionMode(mode)).toBe(true);
    for (const value of ['AUTO', 'record_only', 'on', '', null, 3, undefined]) {
      expect(isProseQuestionAttentionMode(value)).toBe(false);
    }
  });

  it('stores a self-describing provider request id it can always recognize as its own', () => {
    const derived = proseQuestionProviderRequestId('evt-1');
    expect(derived).toBe('codeestra-prose-question:evt-1');
    expect(isProseQuestionProviderRequestId(derived)).toBe(true);
    // A real provider request id is never mistaken for a derived one.
    expect(isProseQuestionProviderRequestId('req_abc123')).toBe(false);
  });

  it('reads back exactly the recorded prompt and refuses everything else', () => {
    expect(readProseQuestionPrompt(prompt())).toEqual(prompt());
    // A questionnaire Attention and a permission prompt are not prose questions.
    expect(readProseQuestionPrompt({ kind: 'codeestra.questionnaire', version: 1 })).toBeNull();
    expect(readProseQuestionPrompt({ kind: 'codeestra.permission' })).toBeNull();
    expect(readProseQuestionPrompt(null)).toBeNull();
    expect(readProseQuestionPrompt('prose')).toBeNull();
    // A prompt that lost a field, or whose facts no longer validate, is not silently accepted.
    const { facts: _facts, ...withoutFacts } = prompt();
    expect(readProseQuestionPrompt(withoutFacts)).toBeNull();
    expect(readProseQuestionPrompt({ ...prompt(), code: 'SOMETHING_ELSE' })).toBeNull();
    expect(readProseQuestionPrompt({ ...prompt(), facts: { ...facts(), toolCallCount: '0' } })).toBeNull();
  });

  it('requires text for an answer and forbids it for a dismissal', () => {
    expect(validateProseQuestionResolution({ resolution: 'ANSWERED', text: 'use bun', note: null }))
      .toMatchObject({ allowed: true });
    expect(validateProseQuestionResolution({ resolution: 'DISMISSED_FALSE_POSITIVE', text: null,
      note: 'not asking' })).toMatchObject({ allowed: true });
    // Both directions are refusals rather than normalizations: the audit row must mean what it says.
    expect(validateProseQuestionResolution({ resolution: 'ANSWERED', text: null, note: null }))
      .toMatchObject({ allowed: false, code: 'PROSE_QUESTION_INVALID_RESOLUTION_PAYLOAD' });
    expect(validateProseQuestionResolution({ resolution: 'ANSWERED', text: '   ', note: null }))
      .toMatchObject({ allowed: false, code: 'PROSE_QUESTION_INVALID_RESOLUTION_PAYLOAD' });
    expect(validateProseQuestionResolution({ resolution: 'DISMISSED_FALSE_POSITIVE', text: 'bun',
      note: null })).toMatchObject({
      allowed: false, code: 'PROSE_QUESTION_INVALID_RESOLUTION_PAYLOAD' });
    expect(validateProseQuestionResolution({ resolution: 'ANSWERED',
      text: 'x'.repeat(maxProseQuestionAnswerLength + 1), note: null })).toMatchObject({
      allowed: false, code: 'PROSE_QUESTION_INVALID_RESOLUTION_PAYLOAD' });
    expect(validateProseQuestionResolution({ resolution: 'ANSWERED', text: 'bun',
      note: 'y'.repeat(maxProseQuestionResolutionNoteLength + 1) })).toMatchObject({
      allowed: false, code: 'PROSE_QUESTION_INVALID_RESOLUTION_PAYLOAD' });
  });

  it('allows a resolution only for the exact shape the escalation records', () => {
    const recorded = {
      attentionKind: 'QUESTION',
      attentionStatus: 'OPEN',
      prompt: prompt(),
      sessionState: 'EXITED',
      executionState: 'RUNNING',
      taskState: 'WAITING_FOR_USER',
    };
    expect(decideProseQuestionResolution(recorded)).toMatchObject({ allowed: true });
    // A dismissed-then-answered history is refused by the recorded status, not by guesswork.
    expect(decideProseQuestionResolution({ ...recorded, attentionStatus: 'CLOSED' }))
      .toMatchObject({ allowed: false, code: 'PROSE_QUESTION_ATTENTION_ALREADY_RESOLVED' });
    // The route is decided by what the Attention is, before any state is considered.
    expect(decideProseQuestionResolution({ ...recorded,
      attentionKind: 'PERMISSION', prompt: { kind: 'codeestra.permission' } }))
      .toMatchObject({ allowed: false, code: 'PROSE_QUESTION_ATTENTION_NOT_PROSE_QUESTION' });
    expect(decideProseQuestionResolution({ ...recorded,
      prompt: { kind: 'codeestra.questionnaire', version: 1 } }))
      .toMatchObject({ allowed: false, code: 'PROSE_QUESTION_ATTENTION_NOT_PROSE_QUESTION' });
    // Resolving must not throw away a live provider conversation.
    expect(decideProseQuestionResolution({ ...recorded, sessionState: 'WAITING_FOR_USER' }))
      .toMatchObject({ allowed: false, code: 'PROSE_QUESTION_SESSION_NOT_EXITED' });
    expect(decideProseQuestionResolution({ ...recorded, executionState: 'FAILED' }))
      .toMatchObject({ allowed: false, code: 'PROSE_QUESTION_EXECUTION_NOT_RUNNING' });
    expect(decideProseQuestionResolution({ ...recorded, taskState: 'RUNNING' }))
      .toMatchObject({ allowed: false, code: 'PROSE_QUESTION_TASK_NOT_WAITING' });
    // A Task already stopped or cancelled cannot be "returned to" either.
    for (const state of ['CANCELLED', 'PAUSED', 'PAUSING', 'FAILED', 'SUCCEEDED', 'RECOVERY_REQUIRED',
      'RECONCILE_REQUIRED']) {
      expect(decideProseQuestionResolution({ ...recorded, taskState: state }))
        .toMatchObject({ allowed: false, code: 'PROSE_QUESTION_TASK_NOT_WAITING' });
    }
  });

  it('is a pure function: the same facts always produce the same decision', () => {
    const first = decideProseQuestionResolution({
      attentionKind: 'QUESTION', attentionStatus: 'OPEN', prompt: prompt(),
      sessionState: 'EXITED', executionState: 'RUNNING', taskState: 'WAITING_FOR_USER',
    });
    const second = decideProseQuestionResolution({
      attentionKind: 'QUESTION', attentionStatus: 'OPEN', prompt: prompt(),
      sessionState: 'EXITED', executionState: 'RUNNING', taskState: 'WAITING_FOR_USER',
    });
    expect(first).toEqual(second);
  });
});
