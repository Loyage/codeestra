import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GlobalControlPanel } from '../src/global-control.js';
import { CapacityTable } from '../src/schedule.js';
import { App } from '../src/App.js';
import type {
  RuntimeGlobalControlView,
  RuntimePauseTargetView,
} from '../src/types.js';

/**
 * The global load control panel (FOUNDATION-097 / ADR-0061 D09), asserted from static markup.
 *
 * Scope — exactly what this file proves and what it does not:
 * - It proves the **element tree**: which controls exist, which `data-*` facts are projected, and that
 *   a partial freeze is rendered as per-target facts instead of one optimistic boolean.
 * - It does **not** prove how it looks, that a click reaches the Runtime, or anything about a real
 *   browser. No browser, layout engine, key/mouse automation or desktop session is involved: clicks
 *   are the Runtime's command face and are covered by `apps/runtime/test/cli-global-control.test.ts`.
 *   Readability in the three themes and at narrow widths is human visual confirmation (ADR-0008).
 */

function target(overrides: Partial<RuntimePauseTargetView> = {}): RuntimePauseTargetView {
  return {
    targetId: 'target-1',
    pauseEpoch: 1,
    projectId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    executionId: '33333333-3333-4333-8333-333333333333',
    sessionId: '44444444-4444-4444-8444-444444444444',
    incarnationId: '55555555-5555-4555-8555-555555555555',
    providerPid: 4321,
    providerStartToken: 'ps:Mon Sep 16 20:57:01 2026',
    state: 'STOPPED',
    observation: {
      code: 'STOPPED',
      detail: 'process 4321 is STOPPED and its start token still matches the recorded incarnation',
      observedAt: 10,
      startToken: 'ps:Mon Sep 16 20:57:01 2026',
      identityMatched: true,
      processState: 'STOPPED',
      adapterSupport: 'SUPPORTED',
    },
    createdAt: 10,
    updatedAt: 11,
    ...overrides,
  };
}

function view(overrides: Partial<RuntimeGlobalControlView> = {}): RuntimeGlobalControlView {
  return {
    state: 'PAUSED',
    pauseEpoch: 1,
    version: 4,
    requestedAt: 1_700_000_000_000,
    requestedBy: 'local-user',
    settledAt: 1_700_000_001_000,
    detail: { stage: 'PAUSE' },
    code: null,
    platformSupported: true,
    platform: 'darwin',
    targets: [target()],
    capacity: null,
    capacityNote: 'The Runtime-global capacity numbers are reported by `scheduler capacity get`.',
    ...overrides,
  };
}

function panel(overrides: Partial<Parameters<typeof GlobalControlPanel>[0]> = {}): string {
  return renderToStaticMarkup(createElement(GlobalControlPanel, {
    view: view(),
    loading: false,
    busy: false,
    error: null,
    onPause: () => {},
    onResume: () => {},
    onReconcile: () => {},
    ...overrides,
  }));
}

/** Every per-target row as its `data-*` facts, so nesting and styling cannot affect the assertions. */
function targetRows(markup: string): readonly Readonly<Record<string, string>>[] {
  return (markup.match(/<tr [^>]*data-pause-target="[^"]*"[^>]*>/g) ?? []).map((tag) => {
    const facts: Record<string, string> = {};
    for (const match of tag.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
      facts[match[1] as string] = match[2] as string;
    }
    return facts;
  });
}

describe('the global control panel projects the command result', () => {
  it('renders all three controls without any local allow-list hiding or disabling one', () => {
    const markup = panel({ view: null, loading: true });
    expect(markup).toContain('data-action="pause-all"');
    expect(markup).toContain('data-action="resume-all"');
    expect(markup).toContain('data-action="reconcile"');
    // Pause is an explicit user command, so it is never disabled while the state is being read.
    expect(markup).not.toMatch(/data-action="pause-all"[^>]*disabled/u);
    expect(markup).not.toMatch(/data-action="resume-all"[^>]*disabled/u);
    // Before the first read the panel says so instead of guessing a state.
    expect(markup).toContain('data-global-control-state="UNKNOWN"');
    expect(markup).toContain('正在读取全局控制状态');
  });

  it('shows PAUSED only from the Runtime state, with the epoch and the settled time', () => {
    const markup = panel();
    expect(markup).toContain('data-global-control-state="PAUSED"');
    expect(markup).toContain('data-global-control-epoch="1"');
    expect(markup).toContain('已暂停（全部目标已核验停止）');
    expect(markup).toContain('暂停 epoch 1');
    expect(markup).toContain('目标 1');
  });

  it('renders per-target facts, never one optimistic boolean, while a freeze is partial', () => {
    const markup = panel({
      view: view({
        state: 'RECOVERY_REQUIRED',
        code: 'GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE',
        targets: [
          target(),
          target({
            targetId: 'target-2',
            incarnationId: '66666666-6666-4666-8666-666666666666',
            providerPid: 8765,
            state: 'RECOVERY_REQUIRED',
            observation: {
              code: 'GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE',
              detail: 'process 8765 has start token X instead of the recorded Y, so it is a different'
                + ' process (pid reuse)',
              observedAt: 12,
              startToken: 'ps:Mon Sep 16 21:00:00 2026',
              identityMatched: false,
              processState: 'RUNNING',
              adapterSupport: 'SUPPORTED',
            },
          }),
          target({
            targetId: 'target-3',
            incarnationId: '77777777-7777-4777-8777-777777777777',
            providerPid: 9999,
            state: 'RECOVERY_REQUIRED',
            observation: {
              code: 'GLOBAL_PAUSE_UNSUPPORTED',
              detail: 'adapter codex declares REQUIRES_VALIDATION',
              observedAt: 12,
              startToken: null,
              identityMatched: false,
              processState: 'UNKNOWN',
              adapterSupport: 'REQUIRES_VALIDATION',
            },
          }),
        ],
      }),
    });
    expect(markup).toContain('data-global-control-state="RECOVERY_REQUIRED"');
    expect(markup).toContain('data-global-control-state-label="RECOVERY_REQUIRED"');
    // The control state's own code is shown verbatim on the panel.
    expect(markup).toContain('data-global-control-code="GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE"');
    const rows = targetRows(markup);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row['target-state']).sort())
      .toEqual(['RECOVERY_REQUIRED', 'RECOVERY_REQUIRED', 'STOPPED']);
    expect(rows.map((row) => row['target-identity']).sort())
      .toEqual(['CHANGED', 'MATCHED', 'UNREADABLE']);
    // The identity facts and the process state are per target, so "which one is still running"
    // is answerable from the panel alone.
    const stillRunning = rows.filter((row) => row['target-process-state'] === 'RUNNING');
    expect(stillRunning).toHaveLength(1);
    expect(stillRunning[0]?.['target-pid']).toBe('8765');
    // A target whose Adapter has not measured the capability says so on its own row.
    expect(rows.find((row) => row['target-pid'] === '9999')?.['target-adapter-support'])
      .toBe('REQUIRES_VALIDATION');
  });

  it('reports a refusal with the runtime code and reads the facts back instead of claiming success', () => {
    const markup = panel({
      error: { code: 'GLOBAL_PAUSE_TARGET_NOT_STOPPED',
        message: 'after SIGSTOP the process read back as RUNNING' },
      view: view({ state: 'PAUSED', targets: [target()] }),
    });
    expect(markup).toContain('data-global-control-error="GLOBAL_PAUSE_TARGET_NOT_STOPPED"');
    expect(markup).toContain('发出了 SIGSTOP，但复读进程状态没有证实它停止，因此不算已冻结。');
    // The refusal does not erase the facts that were read back.
    expect(targetRows(markup)).toHaveLength(1);
  });

  it('never shows PAUSED as a fallback on a platform without POSIX stop semantics', () => {
    const markup = panel({
      view: view({ state: 'RECOVERY_REQUIRED', code: 'GLOBAL_PAUSE_UNSUPPORTED',
        platformSupported: false, platform: 'win32', targets: [] }),
    });
    expect(markup).toContain('data-global-control-platform="UNSUPPORTED"');
    expect(markup).toContain('data-global-control-platform-note="true"');
    expect(markup).toContain('不会降级成“只暂停调度”后仍显示已暂停');
    expect(markup).not.toContain('data-global-control-state="PAUSED"');
  });

  it('does not invent capacity fields of its own', () => {
    const markup = panel();
    expect(markup).toContain('data-global-control-capacity-note="true"');
    expect(markup).toContain('scheduler capacity get');
    // The ADR-0061 D02 capacity shape must not be re-derived here: no limit/used numbers appear.
    expect(markup).not.toMatch(/data-global-capacity-(limit|used|available)/u);
  });
});

describe('the global control bar lives in the shell, not in a project page', () => {
  // Console reads `window.location.origin` to build its Runtime client. Server rendering runs no
  // effects, so no request is made; this stub only makes the origin readable.
  (globalThis as { window?: unknown }).window ??= { location: { origin: 'http://127.0.0.1:0' } };
  const shell = renderToStaticMarkup(createElement(App, {
    initialToken: 'global-control-test-token', initialProjectId: null, tokenKey: 'codeestra.token',
  }));

  it('is reachable with no project selected, and is not inside the scrolling workspace column', () => {
    expect(shell).toContain('data-global-control="true"');
    expect(shell).toContain('data-action="pause-all"');
    expect(shell).toContain('data-action="resume-all"');
    // The workspace column contains the page content; the control bar is a sibling of it.
    const workspaceStart = shell.indexOf('class="workspace-shell"');
    const workspaceEnd = shell.lastIndexOf('</div>');
    const barIndex = shell.indexOf('data-global-control="true"');
    expect(workspaceStart).toBeGreaterThan(-1);
    expect(barIndex).toBeLessThan(workspaceStart);
    expect(barIndex).toBeGreaterThan(-1);
    expect(workspaceEnd).toBeGreaterThan(workspaceStart);
  });

  it('titles the capacity card as the Runtime-global capacity', () => {
    // The card only renders on the scheduling tab, and server rendering never visits a tab, so this
    // is a source-level assertion: the copy and the scope marker must be in the panel that owns them.
    const source = readFileSync(new URL('../src/schedule.tsx', import.meta.url), 'utf8');
    expect(source).toContain('Runtime 全局容量');
    expect(source).toContain('data-capacity-scope="GLOBAL"');
    expect(source).toContain('data-capacity-scope-note="GLOBAL"');
    // ...and the panel must say which command it reads.
    expect(source).toContain('scheduler.capacity.get');
    expect(shell).not.toContain('data-capacity-scope="PROJECT"');
  });

  it('renders the capacity table as the Runtime-global one, with cross-project occupiers', () => {
    const markup = renderToStaticMarkup(createElement(CapacityTable, {
      capacity: {
        limit: 2,
        limitSource: 'DEFAULT',
        used: 1,
        available: 1,
        waitReason: null,
        occupiers: [{ projectId: '11111111-1111-4111-8111-111111111111',
          taskId: '22222222-2222-4222-8222-222222222222', adapterId: 'pi',
          adapterIds: ['pi'], reservationId: null, since: 1_700_000_000_000, source: 'EXECUTION' }],
        pauseState: { state: 'PAUSED', pauseEpoch: 3, detail: 'PAUSE' },
        configVersion: 1,
        updatedAt: null,
        updatedBy: null,
        draining: false,
        drainReason: null,
      },
      tasks: [],
      now: 1_700_000_000_000,
    }));
    // The scope marker says GLOBAL because the numbers really are the whole Runtime's (ADR-0061 D01).
    expect(markup).toContain('data-capacity-scope="GLOBAL"');
    expect(markup).toContain('data-capacity-row="runtime-global"');
    expect(markup).toContain('Runtime 全局（跨全部项目与 Adapter）');
    // Who holds the slot is per Project, and the pause state is carried by the same report.
    expect(markup).toContain('data-capacity-occupier-project="11111111-1111-4111-8111-111111111111"');
    expect(markup).toContain('data-capacity-pause-state="PAUSED"');
    expect(markup).not.toContain('项目内（本次构建的容量命令面）');
  });
});
