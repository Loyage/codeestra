import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  isProseQuestionWait,
  ProseQuestionWaitCard,
  proseQuestionFactsLine,
  proseQuestionHeuristic,
  proseQuestionNoToolUseCode,
  proseQuestionPromptKind,
  proseQuestionResolveCommand,
  proseQuestionSemantics,
  proseResolutionNotice,
  readProseQuestionWait,
} from '../src/prose-wait.js';
import type { AttentionView, ProseQuestionResolutionResultView } from '../src/types.js';

/**
 * Contract test for the prose-question wait (FOUNDATION-069 / ADR-0043).
 *
 * Scope — what this file does and does not prove:
 * - It proves the client recognises the wait by all three domain discriminators (so a provider
 *   dialog can never be resolved through `attention.resolve`), that the two resolutions are built
 *   exactly like the CLI's `--answer <text>` / `--dismiss`, and that the rendered card says in words
 *   that the provider process exited, that nothing is delivered, and that continuing needs an
 *   explicit re-run.
 * - It reads the domain sources to check the mirrored literals still match, so a rename in
 *   `@codeestra/domain` fails here instead of silently turning every wait into a normal Attention.
 * - It does **not** prove a live round trip: no Runtime is contacted and `attention.resolve` is not
 *   executed here (that is covered by the Runtime's own CLI tests). It also does not prove how the
 *   card looks in a browser — human visual confirmation (ADR-0008).
 */

// ---------------------------------------------------------------------------------------------
// The discriminators are the domain's own literals
// ---------------------------------------------------------------------------------------------

const proseSource = readFileSync(
  new URL('../../../packages/domain/src/prose-question-attention.ts', import.meta.url), 'utf8');
const completionSource = readFileSync(
  new URL('../../../packages/domain/src/agent-completion-signal.ts', import.meta.url), 'utf8');

function domainLiteral(source: string, name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(source);
  if (match === null) throw new Error(`${name} not found in the domain source`);
  return match[1] as string;
}

describe('the prose-question discriminators match the domain', () => {
  it('mirrors the prompt kind, the note code and the heuristic name', () => {
    expect(proseQuestionPromptKind)
      .toBe(domainLiteral(proseSource, 'proseQuestionPromptKind'));
    expect(proseQuestionNoToolUseCode)
      .toBe(domainLiteral(completionSource, 'PROSE_QUESTION_NO_TOOL_USE'));
    expect(proseQuestionHeuristic)
      .toBe(domainLiteral(completionSource, 'noToolCallsWithTrailingQuestionMarkHeuristic'));
  });
});

// ---------------------------------------------------------------------------------------------
// Reading the stored prompt
// ---------------------------------------------------------------------------------------------

function prosePrompt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: proseQuestionPromptKind,
    code: proseQuestionNoToolUseCode,
    heuristic: proseQuestionHeuristic,
    message: 'the provider reported no tool call and the last text ends with a question mark',
    text: 'Which package manager should I use?',
    textTruncated: false,
    facts: {
      toolCallCount: 0,
      finalAssistantText: 'Which package manager should I use?',
      finalAssistantTextTruncated: false,
      finalAssistantStopReason: 'endTurn',
    },
    ...overrides,
  };
}

describe('a prose question is recognised only by its full recorded shape', () => {
  it('reads a valid wait with its message, text and facts', () => {
    const wait = readProseQuestionWait(prosePrompt());
    expect(wait).not.toBeNull();
    expect(wait?.text).toBe('Which package manager should I use?');
    expect(wait?.facts.toolCallCount).toBe(0);
    expect(wait?.textTruncated).toBe(false);
  });

  it('accepts a truncated or absent final text and an unreported stop reason', () => {
    const wait = readProseQuestionWait(prosePrompt({
      text: null, textTruncated: true,
      facts: { toolCallCount: 0, finalAssistantText: null, finalAssistantTextTruncated: true,
        finalAssistantStopReason: null },
    }));
    expect(wait?.text).toBeNull();
    expect(wait?.facts.finalAssistantStopReason).toBeNull();
  });

  it('rejects anything that is not exactly this shape', () => {
    for (const prompt of [
      null,
      'a string',
      [],
      prosePrompt({ kind: 'codeestra.questionnaire' }),
      prosePrompt({ code: 'SOMETHING_ELSE' }),
      prosePrompt({ heuristic: 'SOME_OTHER_HEURISTIC' }),
      prosePrompt({ message: undefined }),
      prosePrompt({ textTruncated: 'false' }),
      prosePrompt({ facts: undefined }),
      prosePrompt({ facts: { toolCallCount: '0', finalAssistantText: null,
        finalAssistantTextTruncated: false, finalAssistantStopReason: null } }),
    ]) {
      expect(readProseQuestionWait(prompt)).toBeNull();
    }
  });

  it('does not classify a provider dialog as a prose-question wait', () => {
    const attention: AttentionView = {
      id: 'attention-1', projectId: 'project-1', taskId: 'task-1', executionId: 'exec-1',
      providerRequestId: 'provider-request-1', kind: 'QUESTION', responseType: 'VALUE',
      prompt: { kind: 'codeestra.questionnaire', questionnaire: { questions: [] } },
      status: 'OPEN', createdAt: 1_000,
    };
    expect(isProseQuestionWait(attention)).toBe(false);
    expect(isProseQuestionWait({ ...attention, prompt: prosePrompt() })).toBe(true);
  });

  it('describes the recorded facts as the heuristic they are', () => {
    const wait = readProseQuestionWait(prosePrompt());
    const line = proseQuestionFactsLine(wait?.facts as NonNullable<typeof wait>['facts']);
    expect(line).toContain('工具调用 0');
    expect(line).toContain(proseQuestionHeuristic);
  });
});

// ---------------------------------------------------------------------------------------------
// The two resolutions, built exactly as the CLI builds them
// ---------------------------------------------------------------------------------------------

describe('attention resolve is built like the CLI command', () => {
  it('requires text for an answer and carries it as `text`', () => {
    expect(proseQuestionResolveCommand({
      projectId: 'project-1', attentionId: 'attention-1', commandId: 'cmd-1',
      resolution: 'ANSWERED', text: '  use bun  ',
    })).toEqual({
      command: 'attention.resolve', commandId: 'cmd-1', projectId: 'project-1',
      attentionId: 'attention-1', resolution: 'ANSWERED', text: 'use bun',
    });
  });

  it('sends a dismissal with no answer text at all', () => {
    const command = proseQuestionResolveCommand({
      projectId: 'project-1', attentionId: 'attention-1', commandId: 'cmd-2',
      resolution: 'DISMISSED_FALSE_POSITIVE', note: 'the Agent simply finished its turn',
    });
    expect(command).toEqual({
      command: 'attention.resolve', commandId: 'cmd-2', projectId: 'project-1',
      attentionId: 'attention-1', resolution: 'DISMISSED_FALSE_POSITIVE',
      note: 'the Agent simply finished its turn',
    });
    expect('text' in command).toBe(false);
  });

  it('refuses a payload the Runtime would refuse, instead of sending it', () => {
    expect(() => proseQuestionResolveCommand({
      projectId: 'project-1', attentionId: 'attention-1', commandId: 'cmd-3',
      resolution: 'ANSWERED', text: '   ',
    })).toThrow(/必须填写回答文字/u);
    expect(() => proseQuestionResolveCommand({
      projectId: 'project-1', attentionId: 'attention-1', commandId: 'cmd-3',
      resolution: 'ANSWERED', text: 'x'.repeat(4_001),
    })).toThrow(/4000/u);
    expect(() => proseQuestionResolveCommand({
      projectId: 'project-1', attentionId: 'attention-1', commandId: 'cmd-3',
      resolution: 'DISMISSED_FALSE_POSITIVE', text: 'sneaked in',
    })).toThrow(/误报不能携带回答文字/u);
    expect(() => proseQuestionResolveCommand({
      projectId: 'project-1', attentionId: 'attention-1', commandId: 'cmd-3',
      resolution: 'DISMISSED_FALSE_POSITIVE', note: 'n'.repeat(2_001),
    })).toThrow(/2000/u);
  });

  it('reports a recorded answer as recorded, never as delivered', () => {
    const resolved: ProseQuestionResolutionResultView = {
      attentionId: 'attention-1', projectId: 'project-1', taskId: 'task-1',
      executionId: 'exec-1', sessionId: 'session-1', resolution: 'ANSWERED',
      answerText: 'use bun', note: null, actor: 'local-user', taskState: 'RUNNING',
      executionState: 'RUNNING', sessionState: 'EXITED', attentionStatus: 'CLOSED',
      deliveredToProvider: false, resolvedAt: 2_000,
    };
    const notice = proseResolutionNotice(resolved);
    expect(notice).toContain('已记录回答');
    expect(notice).toContain('deliveredToProvider=false');
    expect(notice).toContain('task resume');
    expect(notice).not.toContain('已送达');
  });
});

// ---------------------------------------------------------------------------------------------
// The rendered card
// ---------------------------------------------------------------------------------------------

function cardMarkup(): string {
  const wait = readProseQuestionWait(prosePrompt({
    text: 'Should I migrate the ledger now?',
    message: 'no tool call in this run; the last assistant text ends with a question mark',
  }));
  if (wait === null) throw new Error('fixture should be a prose-question wait');
  return renderToStaticMarkup(createElement(ProseQuestionWaitCard, {
    wait,
    busy: false,
    resolve: () => Promise.resolve({
      attentionId: 'attention-1', projectId: 'project-1', taskId: 'task-1',
      executionId: 'exec-1', sessionId: 'session-1', resolution: 'ANSWERED' as const,
      answerText: 'yes', note: null, actor: 'local-user', taskState: 'RUNNING' as const,
      executionState: 'RUNNING' as const, sessionState: 'EXITED' as const,
      attentionStatus: 'CLOSED' as const, deliveredToProvider: false as const, resolvedAt: 1,
    }),
    onResolved: () => Promise.resolve(),
  }));
}

describe('the rendered prose-question card', () => {
  it('states the provider exited, that the answer is not delivered, and that a re-run is needed', () => {
    const html = cardMarkup();
    expect(html).toContain('provider 进程已经退出');
    expect(html).toContain('不会送进 Agent 会话');
    expect(html).toContain('不会创建规格修订');
    expect(html).toContain('task resume');
    // The semantics are also the exported sentence the card renders, so wording cannot drift.
    expect(proseQuestionSemantics).toContain('显式重新运行');
  });

  it('offers exactly the two recorded endings and labels the answer as not delivered', () => {
    const html = cardMarkup();
    expect(html).toContain('记录回答（不投递）');
    expect(html).toContain('记录为误报');
    // Nothing here claims the Agent will continue, and the generic answer control is absent.
    expect(html).not.toContain('>发送<');
    expect(html).not.toContain('允许');
    expect(html).not.toContain('拒绝回答此请求');
  });

  it('shows the recorded ending and the question text as recorded facts', () => {
    const html = cardMarkup();
    expect(html).toContain('Should I migrate the ledger now?');
    expect(html).toContain('no tool call in this run');
    expect(html).toContain(proseQuestionHeuristic);
    // The submit control cannot be used before something was answered.
    expect(html).toContain('disabled=""');
  });
});
