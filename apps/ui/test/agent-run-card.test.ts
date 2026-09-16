import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentRunCard } from '../src/agent-run-card.js';
import type { AgentSessionCompletionView } from '../src/types.js';

/**
 * What the run card puts at the top of the Task detail.
 *
 * It proves three rendering contracts only: the recorded final text is shown, an absent text says
 * so instead of rendering an empty block, and the link to the full process appears only when there
 * is a process to link to. Layout, tone resolution in a real browser, and how it reads at narrow
 * widths are human checks (ADR-0008).
 */

function completion(overrides: Partial<AgentSessionCompletionView> = {}): AgentSessionCompletionView {
  return {
    outcome: 'SUCCESS',
    evidenceRef: 'quiescence',
    failure: null,
    facts: {
      toolCallCount: 14,
      finalAssistantText: '已把 X 改成 Y，测试通过。',
      finalAssistantTextTruncated: false,
      finalAssistantStopReason: 'end_turn',
    },
    note: null,
    ...overrides,
  };
}

function render(node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(node);
}

describe('AgentRunCard', () => {
  it('shows the recorded last output and the facts behind it', () => {
    const html = render(createElement(AgentRunCard, {
      run: { state: 'RUNNING', resourceHeld: true, sessionState: 'EXITED',
        completionOutcome: 'SUCCESS' },
      attemptNumber: 2,
      completion: completion(),
      transcriptAnchorId: null,
    }));
    expect(html).toContain('已把 X 改成 Y，测试通过。');
    expect(html).toContain('provider 记为成功');
    expect(html).toContain('第 2 次尝试');
    expect(html).toContain('工具调用 14 次');
    expect(html).toContain('最后的输出（全文）');
  });

  it('says a truncated text is only the tail rather than implying it is complete', () => {
    const html = render(createElement(AgentRunCard, {
      run: { state: 'RUNNING', resourceHeld: true, sessionState: 'EXITED',
        completionOutcome: 'SUCCESS' },
      attemptNumber: 1,
      completion: completion({ facts: { toolCallCount: 14, finalAssistantText: '尾部',
        finalAssistantTextTruncated: true, finalAssistantStopReason: null } }),
      transcriptAnchorId: null,
    }));
    expect(html).toContain('最后的输出（尾部）');
    expect(html).toContain('只保留了尾部');
    expect(html).toContain('最后 2000 个字符');
  });

  it('reports a missing output as missing instead of rendering an empty block', () => {
    const html = render(createElement(AgentRunCard, {
      run: { state: 'RUNNING', resourceHeld: true, sessionState: 'EXITED',
        completionOutcome: null },
      attemptNumber: 1,
      completion: completion({ facts: null }),
      transcriptAnchorId: null,
    }));
    expect(html).toContain('没有记录到结局');
    expect(html).toContain('没有记录到助手文本');
    expect(html).not.toContain('<pre');
  });

  it('surfaces a provider-reported failure with its stable code', () => {
    const html = render(createElement(AgentRunCard, {
      run: { state: 'FAILED', resourceHeld: false, sessionState: 'EXITED',
        completionOutcome: 'FAILURE' },
      attemptNumber: 1,
      completion: completion({ outcome: 'FAILURE',
        failure: { code: 'AGENT_REPORTED_FAILURE', message: 'boom' } }),
      transcriptAnchorId: null,
    }));
    expect(html).toContain('provider 记为失败');
    expect(html).toContain('AGENT_REPORTED_FAILURE');
  });

  it('links to the recorded process only when one is on the page', () => {
    const linked = render(createElement(AgentRunCard, {
      run: { state: 'RUNNING', resourceHeld: true, sessionState: 'EXITED',
        completionOutcome: 'SUCCESS' },
      attemptNumber: 1,
      completion: completion(),
      transcriptAnchorId: 'agent-session-transcript',
    }));
    expect(linked).toContain('href="#agent-session-transcript"');
    const unlinked = render(createElement(AgentRunCard, {
      run: { state: 'RUNNING', resourceHeld: true, sessionState: 'EXITED',
        completionOutcome: 'SUCCESS' },
      attemptNumber: 1,
      completion: completion(),
      transcriptAnchorId: null,
    }));
    expect(unlinked).not.toContain('href="#');
  });
});
