import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AttentionTab } from '../src/App.js';
import { RuntimeClient } from '../src/api.js';
import { proseQuestionHeuristic, proseQuestionNoToolUseCode,
  proseQuestionPromptKind } from '../src/prose-wait.js';
import type { AttentionView } from '../src/types.js';

/**
 * Contract test for the 「待处理」 inbox split (ADR-0043 / FOUNDATION-069).
 *
 * Scope — what this file does and does not prove:
 * - It proves a prose-question wait and a provider permission request are rendered as two different
 *   things in the same list: the prose card says the provider process exited and records (rather
 *   than sends) an answer, while the permission request keeps its allow/deny controls. It also proves
 *   the generic text-answer control (`attention.answer`'s VALUE form) is not offered for a prose
 *   wait — the Runtime would refuse it with `PROSE_QUESTION_RESOLUTION_REQUIRED`.
 * - It does **not** prove a live round trip, the visual difference between the two cards, or focus
 *   order; those are human visual confirmation (ADR-0008). No Runtime is contacted: under server
 *   rendering the effects that would fetch do not run.
 */

function proseAttention(): AttentionView {
  return {
    id: 'attention-prose', projectId: 'project-1', taskId: 'task-1', executionId: 'exec-1',
    providerRequestId: 'codeestra-prose-question:event-1', kind: 'QUESTION', responseType: 'VALUE',
    prompt: {
      kind: proseQuestionPromptKind, code: proseQuestionNoToolUseCode,
      heuristic: proseQuestionHeuristic, message: 'no tool call in this run',
      text: 'Should I migrate the ledger now?', textTruncated: false,
      facts: { toolCallCount: 0, finalAssistantText: 'Should I migrate the ledger now?',
        finalAssistantTextTruncated: false, finalAssistantStopReason: 'endTurn' },
    },
    status: 'OPEN', createdAt: 1_000,
  };
}

function permissionAttention(): AttentionView {
  return {
    id: 'attention-permission', projectId: 'project-1', taskId: 'task-1', executionId: 'exec-2',
    providerRequestId: 'provider-request-2', kind: 'PERMISSION', responseType: 'CONFIRM',
    prompt: { toolName: 'bash', toolCallId: 'call-1' }, status: 'OPEN', createdAt: 2_000,
  };
}

function inboxMarkup(attentions: readonly AttentionView[]): string {
  return renderToStaticMarkup(createElement(AttentionTab, {
    client: new RuntimeClient('http://127.0.0.1:0', 'inbox-test-token'),
    run: () => Promise.resolve(),
    update: () => {},
    projectId: 'project-1',
    attentions,
    reload: () => Promise.resolve(),
  }));
}

describe('the inbox tells a prose-question wait apart from a permission request', () => {
  it('renders the prose wait with its own marker and the permission request as a request', () => {
    const html = inboxMarkup([proseAttention(), permissionAttention()]);
    expect(html).toContain('散文提问等待 · provider 已退出');
    expect(html).toContain('其中 1 条是散文提问等待');
    // The permission request keeps the controls that deliver an answer to the provider.
    expect(html).toContain('允许');
    expect(html).toContain('拒绝');
    // Exactly one generic text-answer control would be rendered if the prose wait were shown as an
    // ordinary question card; a CONFIRM permission request never renders one, so this must be zero.
    expect((html.match(/>发送</gu) ?? [])).toHaveLength(0);
    expect((html.match(/记录回答（不投递）/gu) ?? [])).toHaveLength(1);
    expect((html.match(/记录为误报/gu) ?? [])).toHaveLength(1);
  });

  it('offers no provider-answer route for the prose wait', () => {
    const html = inboxMarkup([proseAttention()]);
    expect(html).toContain('不会送进 Agent 会话');
    expect(html).not.toContain('允许');
    expect(html).not.toContain('拒绝回答此请求');
    expect(html).not.toContain('>发送<');
  });

  it('keeps an ordinary VALUE question on the answer channel', () => {
    const value: AttentionView = {
      id: 'attention-value', projectId: 'project-1', taskId: 'task-1', executionId: 'exec-3',
      providerRequestId: 'provider-request-3', kind: 'QUESTION', responseType: 'VALUE',
      prompt: { question: 'which branch?' }, status: 'OPEN', createdAt: 3_000,
    };
    const html = inboxMarkup([value]);
    expect(html).toContain('>发送<');
    expect(html).toContain('拒绝回答此请求');
    // The header explains the two kinds in prose; the marker and the card must not appear.
    expect(html).not.toContain('散文提问等待 · provider 已退出');
    expect(html).not.toContain('记录回答（不投递）');
    expect(html).not.toContain('其中 1 条');
  });
});
