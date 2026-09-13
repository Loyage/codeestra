import { describe, expect, test } from 'bun:test';
import {
  decodeQuestionnaireDialogTitle,
  encodeQuestionnaireDialogTitle,
  parseQuestionnaireAnswer,
  questionnaireSchema,
  serializeQuestionnaireAnswer,
  validateQuestionnaireAnswer,
  type Questionnaire,
} from '../src/index.js';

const questionnaire: Questionnaire = {
  questions: [
    { question: 'Which package manager?', header: 'Packages', multiSelect: false,
      options: [{ label: 'npm', description: 'the default' },
        { label: 'bun', description: 'what this repository uses' }] },
    { question: 'Which checks should run?', header: 'Checks', multiSelect: true,
      options: [{ label: 'typecheck', description: 'tsc --noEmit' },
        { label: 'tests', description: 'vitest run' },
        { label: 'build', description: 'vite build' }] },
  ],
};

describe('questionnaire contract', () => {
  test('enforces the documented limits', () => {
    expect(questionnaireSchema.safeParse({ questions: [] }).success).toBe(false);
    expect(questionnaireSchema.safeParse({ questions: [{
      question: 'q', header: 'h', multiSelect: false,
      options: [{ label: 'only one', description: 'd' }],
    }] }).success).toBe(false);
    expect(questionnaireSchema.safeParse({ questions: Array.from({ length: 5 }, () => ({
      question: 'q', header: 'h', multiSelect: false,
      options: [{ label: 'a', description: 'd' }, { label: 'b', description: 'd' }],
    })) }).success).toBe(false);
    expect(questionnaireSchema.safeParse({ questions: [{
      question: 'q', header: 'h', multiSelect: false,
      options: [{ label: 'a', description: 'd' }, { label: 'b', description: 'd' }],
    }] }).success).toBe(true);
  });

  test('round-trips through the provider dialog title and rejects foreign titles', () => {
    const title = encodeQuestionnaireDialogTitle(questionnaire);
    expect(title.startsWith('CODEESTRA_QUESTIONNAIRE:v1:')).toBe(true);
    expect(decodeQuestionnaireDialogTitle(title)).toEqual(questionnaire);
    expect(decodeQuestionnaireDialogTitle('Allow this bash call?\n\nrm -rf /')).toBeNull();
    expect(decodeQuestionnaireDialogTitle('CODEESTRA_QUESTIONNAIRE:v1:{not json')).toBeNull();
    // A title from a future version, or one whose payload no longer validates, degrades to a
    // plain question instead of being interpreted.
    expect(decodeQuestionnaireDialogTitle('CODEESTRA_QUESTIONNAIRE:v2:{}')).toBeNull();
    expect(decodeQuestionnaireDialogTitle('CODEESTRA_QUESTIONNAIRE:v1:{"questions":[]}')).toBeNull();
  });

  test('round-trips an answer payload', () => {
    const answer = { version: 1 as const, answers: [
      { type: 'CHOICES' as const, questionIndex: 1, choiceIndexes: [0, 2] },
      { type: 'TEXT' as const, questionIndex: 0, text: 'use pnpm' },
    ] };
    expect(parseQuestionnaireAnswer(serializeQuestionnaireAnswer(answer))).toEqual(answer);
    expect(parseQuestionnaireAnswer('2. bun — what this repository uses')).toBeNull();
    expect(parseQuestionnaireAnswer('{"version":1,"answers":[]}')).toBeNull();
  });

  test('accepts every well-formed answer, including a partial one', () => {
    expect(validateQuestionnaireAnswer(questionnaire, { version: 1, answers: [
      { type: 'CHOICES', questionIndex: 0, choiceIndexes: [1] },
      { type: 'CHOICES', questionIndex: 1, choiceIndexes: [0, 2] },
    ] })).toBeNull();
    expect(validateQuestionnaireAnswer(questionnaire, { version: 1, answers: [
      { type: 'TEXT', questionIndex: 1, text: 'run everything except the build' },
    ] })).toBeNull();
  });

  test('names the exact problem instead of accepting an impossible answer', () => {
    expect(validateQuestionnaireAnswer(questionnaire, { version: 1, answers: [
      { type: 'CHOICES', questionIndex: 0, choiceIndexes: [2] },
    ] })).toEqual({ code: 'CHOICE_INDEX_OUT_OF_RANGE', message: 'Question 1 has no option 3' });
    expect(validateQuestionnaireAnswer(questionnaire, { version: 1, answers: [
      { type: 'CHOICES', questionIndex: 0, choiceIndexes: [0, 1] },
    ] })).toEqual({ code: 'MULTIPLE_CHOICES_FOR_SINGLE_SELECT',
      message: 'Question 1 accepts exactly one option' });
    expect(validateQuestionnaireAnswer(questionnaire, { version: 1, answers: [
      { type: 'CHOICES', questionIndex: 0, choiceIndexes: [0] },
      { type: 'TEXT', questionIndex: 0, text: 'and also this' },
    ] })).toEqual({ code: 'DUPLICATE_QUESTION_ANSWER',
      message: 'Question 1 was answered more than once' });
    expect(validateQuestionnaireAnswer(questionnaire, { version: 1, answers: [
      { type: 'CHOICES', questionIndex: 9, choiceIndexes: [0] },
    ] })).toEqual({ code: 'QUESTION_INDEX_OUT_OF_RANGE', message: 'There is no question 10' });
    expect(validateQuestionnaireAnswer(questionnaire, { version: 1, answers: [
      { type: 'CHOICES', questionIndex: 1, choiceIndexes: [0, 0] },
    ] })).toEqual({ code: 'DUPLICATE_CHOICE',
      message: 'Question 2 lists the same option twice' });
  });
});

describe('agent answer contract', () => {
  test('carries a structured questionnaire answer as its own type', async () => {
    const { agentAnswerSchema } = await import('../src/index.js');
    expect(agentAnswerSchema.safeParse({ type: 'QUESTIONNAIRE', answer: { version: 1, answers: [
      { type: 'CHOICES', questionIndex: 0, choiceIndexes: [0] },
    ] } }).success).toBe(true);
    // A structured answer with nothing in it is not a valid way to decline; CANCEL is.
    expect(agentAnswerSchema.safeParse({ type: 'QUESTIONNAIRE',
      answer: { version: 1, answers: [] } }).success).toBe(false);
  });
});
