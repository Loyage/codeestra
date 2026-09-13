import { describe, expect, test } from 'bun:test';
import {
  decodeQuestionnaireDialogTitle,
  serializeQuestionnaireAnswer,
  validateQuestionnaireAnswer,
  type Questionnaire,
} from '@codeestra/contracts';
import {
  codeestraAskUserQuestionToolName,
  registerAskUserQuestionTool,
} from '../src/pi-question-extension.js';

interface CapturedTool {
  readonly name: string;
  readonly description: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: { hasUI: boolean; ui: { select(title: string, options: string[]): Promise<string | undefined> } },
  ): Promise<{ content: readonly { type: 'text'; text: string }[]; details: unknown; isError?: boolean }>;
}

function captureTool(): CapturedTool {
  let tool: CapturedTool | undefined;
  registerAskUserQuestionTool({ registerTool: (registered) => { tool = registered as CapturedTool; } });
  if (tool === undefined) throw new Error('The question tool was not registered');
  return tool;
}

const questions: Questionnaire['questions'] = [
  { question: 'Which package manager?', header: 'Packages', multiSelect: false,
    options: [{ label: 'npm', description: 'the default' }, { label: 'bun', description: 'repo default' }] },
  { question: 'Which checks?', header: 'Checks', multiSelect: true,
    options: [{ label: 'typecheck', description: 'tsc' }, { label: 'tests', description: 'vitest' }] },
];

function contextReturning(answer: string | undefined) {
  const seen: { title?: string; options?: readonly string[] } = {};
  return {
    seen,
    ctx: {
      hasUI: true,
      ui: { select: async (title: string, options: string[]) => {
        seen.title = title;
        seen.options = options;
        return answer;
      } },
    },
  };
}

describe('Codeestra question extension', () => {
  test('registers the questionnaire tool with a non-empty schema and prompt guidance', () => {
    const tool = captureTool();
    expect(tool.name).toBe(codeestraAskUserQuestionToolName);
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
    expect(tool.parameters).toMatchObject({ type: 'object', required: ['questions'] });
  });

  test('sends one dialog whose title carries the whole questionnaire', async () => {
    const { ctx, seen } = contextReturning(undefined);
    const result = await captureTool().execute('call-1', { questions }, undefined, undefined, ctx);
    const questionnaire = decodeQuestionnaireDialogTitle(seen.title ?? '');
    expect(questionnaire).toEqual({ questions });
    // The readable fallback lists every question and option for a host that cannot decode the title.
    expect(seen.options?.join('\n')).toContain('Q1 [Packages] Which package manager?');
    expect(seen.options?.join('\n')).toContain('2. bun — repo default');
    expect(result.content[0]?.text).toContain('declined');
    expect(result.details).toMatchObject({ cancelled: true, answers: [] });
  });

  test('reports exactly which questions were answered and which were not', async () => {
    const answer = { version: 1 as const, answers: [
      { type: 'CHOICES' as const, questionIndex: 1, choiceIndexes: [0, 1] },
    ] };
    const { ctx } = contextReturning(serializeQuestionnaireAnswer(answer));
    const result = await captureTool().execute('call-2', { questions }, undefined, undefined, ctx);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('answered 1 of 2 questions');
    expect(text).toContain('(unanswered)');
    expect(text).toContain('selected: typecheck — tsc');
    expect(text).toContain('selected: tests — vitest');
    expect(result.details).toEqual({ answers: answer.answers, cancelled: false });
    expect(result.isError).toBeUndefined();
  });

  test('keeps a custom answer verbatim', async () => {
    const answer = { version: 1 as const, answers: [
      { type: 'TEXT' as const, questionIndex: 0, text: 'pnpm, and pin it' },
    ] };
    const { ctx } = contextReturning(serializeQuestionnaireAnswer(answer));
    const result = await captureTool().execute('call-3', { questions }, undefined, undefined, ctx);
    expect(result.content[0]?.text).toContain('the user wrote: pnpm, and pin it');
  });

  test('treats an unreadable answer as an error, never as a decline', async () => {
    const { ctx } = contextReturning('1. npm — the default');
    const result = await captureTool().execute('call-4', { questions }, undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ error: 'unreadable_answer', cancelled: false });
    expect(result.content[0]?.text).toContain('Do not treat this as a decline');
  });

  test('refuses an invalid questionnaire and a missing UI channel without asking anything', async () => {
    let asked = false;
    const spy = { hasUI: true, ui: { select: async () => { asked = true; return undefined; } } };
    const noUi = { hasUI: false, ui: { select: async () => { asked = true; return undefined; } } };
    const withoutUi = await captureTool().execute('call-5', { questions }, undefined, undefined, noUi);
    expect(withoutUi.details).toMatchObject({ error: 'no_ui' });

    const oneOption = await captureTool().execute('call-6', { questions: [{
      question: 'q', header: 'h', options: [{ label: 'only', description: 'd' }],
    }] }, undefined, undefined, spy);
    expect(oneOption.isError).toBe(true);
    expect(oneOption.details).toMatchObject({ error: 'invalid_questionnaire' });
    expect(asked).toBe(false);
  });

  test('a questionnaire the tool would ask always validates as an answer target', async () => {
    const { ctx, seen } = contextReturning(undefined);
    await captureTool().execute('call-7', { questions }, undefined, undefined, ctx);
    const questionnaire = decodeQuestionnaireDialogTitle(seen.title ?? '');
    if (questionnaire === null) throw new Error('The dialog title did not decode');
    expect(validateQuestionnaireAnswer(questionnaire, { version: 1, answers: [
      { type: 'CHOICES', questionIndex: 0, choiceIndexes: [1] },
      { type: 'CHOICES', questionIndex: 1, choiceIndexes: [0, 1] },
    ] })).toBeNull();
  });
});
