import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PromotionNextStepCard,
  mainCheckoutPullCommands,
  promotionMainResultLabel,
  promotionNextStep,
  promotionPhaseClass,
  promotionPhaseFinished,
  promotionPhaseLabel,
  promotionRestartCommands,
  promotionRestartLabel,
} from '../src/promotion.js';
import type { PromotionPhaseView, StablePromotionView } from '../src/types.js';

/**
 * Contract test for the 「已推送 ≠ 已提升」 projection (ADR-0047 / ADR-0052, FOUNDATION-077).
 *
 * Scope — what this file does and does not prove:
 * - It proves the promotion panel keeps the two distinguishable facts apart: with
 *   `phase: AWAITING_PULL` the candidate has only reached the remote `dev`, so nothing on that screen
 *   may read as 「已提升」/「已完成」, and the one step the UI cannot perform — the `git fetch` +
 *   `git merge --ff-only origin/dev` **in the main checkout** — is stated with its exact commands.
 * - It proves the phase vocabulary and the "only `COMPLETE` is finished" rule come from the Runtime's
 *   own derivation, not from a client-side guess: the phase union is read out of the storage source
 *   here, so a new phase cannot be added without this test failing.
 * - It proves the exit code 3 case is presented as a wait: the state label for `PROMOTING` no longer
 *   claims progress, and `AWAITING_PULL` uses the waiting tone rather than the success tone.
 * - It does **not** prove anything about a live Runtime: no request is made here and this panel sends
 *   no command at all (it is a read-only projection of `promotion.list` / `promotion.get`).
 * - It does **not** prove that `git ls-remote`, the push, the pull or the restart behave as
 *   described: those are the Runtime's own promotion tests (`apps/runtime/test/promotion-service`,
 *   `cli-promotion`) and the CLI reference. It also does not prove how the panel looks in a browser
 *   (human visual confirmation — ADR-0008 forbids browser and desktop automation here).
 */

const storageSource = readFileSync(
  new URL('../../../packages/storage/src/database.ts', import.meta.url), 'utf8');

/** The phase union the Runtime derives, read from its source so this test cannot drift. */
function domainPhases(): readonly string[] {
  const union = /export type PromotionPhase =([\s\S]*?);/.exec(storageSource);
  if (union === null) throw new Error('PromotionPhase not found in the storage source');
  return [...(union[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1] as string);
}

function fixture(overrides: Partial<StablePromotionView>): StablePromotionView {
  return {
    promotionId: 'promotion-1', projectId: 'project-1', devRef: 'refs/heads/dev',
    mainRef: 'refs/heads/main', candidateCommit: 'c'.repeat(40), expectedMainCommit: 'd'.repeat(40),
    integrationBatchId: 'batch-1', verificationId: 'verification-1',
    verificationTestedCommit: 'c'.repeat(40), permissionMode: 'FULL', state: 'CREATED',
    approval: null, fullSuite: null, promotedCommit: null, mainWorktreePath: null,
    promotingBootId: null, devRepoPath: '/repo-dev', remoteDevCommit: null, remoteMainCommit: null,
    pushedAt: null, mainPushedAt: null, phase: 'READY_TO_PUSH', restartSteps: [], restart: null,
    outcomeCode: null, detail: null, createdAt: 1_000, completedAt: null, members: [],
    ...overrides,
  };
}

/** What a promotion looks like right after the push and the readback: pushed, not pulled. */
const awaitingPull = fixture({
  state: 'PROMOTING', phase: 'AWAITING_PULL', remoteDevCommit: 'c'.repeat(40), pushedAt: 2_000,
});

const complete = fixture({
  state: 'SUCCEEDED', phase: 'COMPLETE', promotedCommit: 'c'.repeat(40),
  mainWorktreePath: '/repo-main', remoteDevCommit: 'c'.repeat(40), remoteMainCommit: 'c'.repeat(40),
  pushedAt: 2_000, mainPushedAt: 9_000, completedAt: 9_000,
  restart: { observedBootId: 'boot-2', runtimeStatus: 'READY', uiRunning: true, steps: [] },
});

function markup(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element);
}

// ---------------------------------------------------------------------------------------------
// The phase vocabulary and the one phase that may claim completion
// ---------------------------------------------------------------------------------------------

describe('only the Runtime-derived COMPLETE phase may read as finished', () => {
  it('labels every phase the Runtime can derive', () => {
    const phases = domainPhases();
    expect(phases).toContain('AWAITING_PULL');
    expect(phases).toContain('MAIN_PUSH_PENDING');
    for (const phase of phases) {
      const label = promotionPhaseLabel(phase as PromotionPhaseView);
      expect(label).not.toBe(phase);
      expect(label.length).toBeGreaterThan(0);
    }
    expect(promotionPhaseLabel('AWAITING_PULL')).toContain('等待拉取');
  });

  it('treats AWAITING_PULL and MAIN_PUSH_PENDING as waits, never as success', () => {
    for (const phase of domainPhases()) {
      const finished = promotionPhaseFinished(phase as PromotionPhaseView);
      expect(finished).toBe(phase === 'COMPLETE');
      if (!finished) expect(promotionPhaseClass(phase as PromotionPhaseView)).not.toContain('state-ready');
    }
    expect(promotionPhaseClass('AWAITING_PULL')).toContain('state-waiting');
    expect(promotionPhaseClass('MAIN_PUSH_PENDING')).toContain('state-waiting');
    expect(promotionPhaseClass('REFUSED')).toContain('state-failed');
    expect(promotionPhaseClass('COMPLETE')).toContain('state-ready');
  });

  it('reads the storage derivation and agrees that PROMOTING means pushed-only', () => {
    // The phase is derived, not stored: `PROMOTING` is exactly the "pushed, awaiting pull" record.
    expect(/state === 'PROMOTING'\) return 'AWAITING_PULL'/.test(storageSource)).toBe(true);
    expect(promotionPhaseFinished('AWAITING_PULL')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The next step, including the manual pull in the main checkout
// ---------------------------------------------------------------------------------------------

describe('the AWAITING_PULL next step is the user\'s own git pull in the main checkout', () => {
  it('names the two commands and says the exit code 3 is a wait, not a failure', () => {
    const step = promotionNextStep(awaitingPull);
    expect(step.headline).toContain('已推送 ≠ 已提升');
    expect(step.commands).toEqual([...mainCheckoutPullCommands]);
    expect(step.detail).toContain('退出码 3');
    expect(step.detail).toContain('不执行 Git');
  });

  it('never claims a push-only record has moved main or restarted anything', () => {
    expect(promotionMainResultLabel(awaitingPull)).toBe('尚未拉到 main 检出');
    expect(promotionRestartLabel(awaitingPull)).toBe('此阶段不记录');
    expect(promotionMainResultLabel(complete)).toBe('c'.repeat(10));
    expect(promotionRestartLabel(complete)).toBe('READY');
    expect(promotionRestartLabel(fixture({ state: 'FAILED', phase: 'REFUSED' }))).toBe('未记录');
    expect(promotionMainResultLabel(fixture({ state: 'CREATED' }))).toBe('未改动');
  });

  it('describes the later phases with the commands they will actually run', () => {
    expect(promotionNextStep(fixture({ state: 'RESTARTING', phase: 'RESTART_PENDING' })).commands)
      .toEqual([...promotionRestartCommands]);
    const pushPending = promotionNextStep(fixture({ state: 'RESTARTING', phase: 'MAIN_PUSH_PENDING' }));
    expect(pushPending.headline).toContain('远端 main 还没有发布');
    expect(pushPending.commands).toEqual([]);
    expect(promotionNextStep(complete).headline).toContain('已完成');
    expect(promotionNextStep(fixture({ state: 'STALE', phase: 'REFUSED' })).headline)
      .toContain('失效');
  });
});

// ---------------------------------------------------------------------------------------------
// Rendered projection (no browser, no Runtime)
// ---------------------------------------------------------------------------------------------

describe('rendered promotion next-step card', () => {
  it('renders the manual main-checkout step with both commands', () => {
    const html = markup(createElement(PromotionNextStepCard, { promotion: awaitingPull }));
    expect(html).toContain('phase AWAITING_PULL');
    expect(html).toContain('已推送 ≠ 已提升');
    for (const command of mainCheckoutPullCommands) expect(html).toContain(command);
    expect(html).toContain('检出 main 的那个 clone');
    expect(html).toContain('只能在 main 检出里由你执行');
    expect(html).not.toContain('已完成');
  });

  it('renders the completed record without inventing a manual step', () => {
    const html = markup(createElement(PromotionNextStepCard, { promotion: complete }));
    expect(html).toContain('phase COMPLETE');
    expect(html).toContain('已完成');
    expect(html).not.toContain('git fetch origin');
    expect(html).not.toContain('只能在 main 检出里由你执行');
  });

  it('renders the restart-pending step with the fixed four commands in order', () => {
    const html = markup(createElement(PromotionNextStepCard, {
      promotion: fixture({ state: 'RESTARTING', phase: 'RESTART_PENDING' }),
    }));
    let cursor = -1;
    for (const command of promotionRestartCommands) {
      const at = html.indexOf(command);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(html).not.toContain('已完成');
  });
});
