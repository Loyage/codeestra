import { describe, expect, it } from 'vitest';
import {
  PROSE_QUESTION_NO_TOOL_USE,
  classifyAgentCompletion,
  noToolCallsWithTrailingQuestionMarkHeuristic,
  proseQuestionNoteMessage,
  type AgentCompletionFacts,
} from '../src/index.js';

const facts = (overrides: Partial<AgentCompletionFacts> = {}): AgentCompletionFacts => ({
  toolCallCount: 0,
  finalAssistantText: 'Which package manager should I use?',
  finalAssistantTextTruncated: false,
  finalAssistantStopReason: 'stop',
  ...overrides,
});

describe('agent completion signals', () => {
  it('annotates a run with no tool call whose last assistant text ends with a question mark', () => {
    const note = classifyAgentCompletion(facts());
    expect(note).not.toBeNull();
    expect(note?.code).toBe('PROSE_QUESTION_NO_TOOL_USE');
    expect(note?.code).toBe(PROSE_QUESTION_NO_TOOL_USE);
    expect(note?.heuristic).toBe(noToolCallsWithTrailingQuestionMarkHeuristic);
    // The wording itself has to say "heuristic": a reader must not take the note for intent.
    expect(note?.message).toBe(proseQuestionNoteMessage);
    expect(note?.message).toContain('heuristic');
    // The facts travel with the note, so the rule can always be re-checked against what it saw.
    expect(note?.facts).toEqual(facts());
    expect(note?.facts).not.toBe(facts());
  });

  it('accepts a full-width question mark and Markdown decoration around it', () => {
    expect(classifyAgentCompletion(facts({ finalAssistantText: '要用哪个包管理器？' }))?.code)
      .toBe(PROSE_QUESTION_NO_TOOL_USE);
    expect(classifyAgentCompletion(facts({ finalAssistantText: '**Which one should I take?**' }))?.code)
      .toBe(PROSE_QUESTION_NO_TOOL_USE);
    expect(classifyAgentCompletion(facts({ finalAssistantText: 'Ready (which file?)' }))?.code)
      .toBe(PROSE_QUESTION_NO_TOOL_USE);
    expect(classifyAgentCompletion(facts({
      finalAssistantText: 'First line.\n\nSecond line, still asking?' }))?.code)
      .toBe(PROSE_QUESTION_NO_TOOL_USE);
  });

  it('does not annotate a run that used a tool, however it ended', () => {
    expect(classifyAgentCompletion(facts({ toolCallCount: 1 }))).toBeNull();
    expect(classifyAgentCompletion(facts({
      toolCallCount: 3, finalAssistantText: 'Should I continue?',
      finalAssistantStopReason: 'toolUse' }))).toBeNull();
    // A structured `ask_user_question` is a tool call, so the existing Attention path owns it and
    // this heuristic must not annotate the same ending twice.
    expect(classifyAgentCompletion(facts({
      toolCallCount: 1, finalAssistantText: 'Which package manager should I use?' }))).toBeNull();
  });

  it('does not annotate text that is absent, empty, or not a question', () => {
    expect(classifyAgentCompletion(facts({ finalAssistantText: null }))).toBeNull();
    expect(classifyAgentCompletion(facts({ finalAssistantText: '' }))).toBeNull();
    expect(classifyAgentCompletion(facts({ finalAssistantText: '   \n\t ' }))).toBeNull();
    expect(classifyAgentCompletion(facts({
      finalAssistantText: 'I wrote the file and stopped.' }))).toBeNull();
    expect(classifyAgentCompletion(facts({
      finalAssistantText: 'Done — nothing else is pending!' }))).toBeNull();
    // A question mark in the middle is prose, not a closing question.
    expect(classifyAgentCompletion(facts({
      finalAssistantText: 'Should I continue? Yes, I continued and finished.' }))).toBeNull();
    // Chinese questions without a question mark are deliberately missed, not guessed at.
    expect(classifyAgentCompletion(facts({ finalAssistantText: '请问要用哪一个包管理器' }))).toBeNull();
  });

  it('does not annotate a bare question mark or an unanswerably short tail', () => {
    expect(classifyAgentCompletion(facts({ finalAssistantText: '?' }))).toBeNull();
    expect(classifyAgentCompletion(facts({ finalAssistantText: '??' }))).toBeNull();
    expect(classifyAgentCompletion(facts({ finalAssistantText: '**?' }))).toBeNull();
    expect(classifyAgentCompletion(facts({ finalAssistantText: 'ok?' }))?.code)
      .toBe(PROSE_QUESTION_NO_TOOL_USE);
  });

  it('keeps firing when only the tail of a long text was reported', () => {
    const note = classifyAgentCompletion(facts({
      finalAssistantText: '…which of the two should I pick?',
      finalAssistantTextTruncated: true,
      finalAssistantStopReason: null,
    }));
    expect(note?.code).toBe(PROSE_QUESTION_NO_TOOL_USE);
    expect(note?.facts.finalAssistantTextTruncated).toBe(true);
    expect(note?.facts.finalAssistantStopReason).toBeNull();
  });

  it('is deterministic: the same facts always produce the same note', () => {
    const first = classifyAgentCompletion(facts());
    const second = classifyAgentCompletion(facts());
    expect(first).toEqual(second);
  });
});
