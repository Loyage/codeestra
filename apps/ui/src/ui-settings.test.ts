import { describe, expect, test } from 'vitest';
import {
  applyDocumentAttributes,
  documentAttributesFor,
  indexUiSettings,
  resolveThemeAttribute,
  uiSettingCommand,
  uiSettingHint,
  uiSettingKeyLabel,
  uiSettingValueLabel,
  updateTimeLabel,
  type DatasetTarget,
  type UiSettingsView,
} from './ui-settings.js';

/**
 * The browser-free half of the settings UI (FOUNDATION-073 / ADR-0045): the value → DOM attribute
 * mapping, the attribute application, the time-display rendering and the labels.
 *
 * Boundary, stated up front: this file does not render React, does not load the stylesheet and does
 * not open a browser, so it proves that the mapping and the labels are right — not that the page
 * looks right. Whether compact density, the font scale and reduced motion are *visually* satisfying,
 * and whether the settings page survives a narrow screen, is left to a human (ADR-0008).
 */

function viewOf(entries: readonly { key: string; value: string; values?: readonly string[];
  explicit?: boolean }[]): UiSettingsView {
  return {
    store: 'RUNTIME_FILE',
    file: '/tmp/ce-j4/ui-settings.json',
    appliesTo: 'test',
    settings: entries.map((entry) => ({
      key: entry.key,
      value: entry.value,
      default: entry.values?.[0] ?? entry.value,
      values: entry.values ?? [entry.value],
      explicit: entry.explicit ?? false,
      source: entry.explicit === true ? 'RUNTIME' : 'PRODUCT_DEFAULT',
    })),
  };
}

describe('theme resolution keeps ADR-0015 semantics', () => {
  test('system follows the operating system and light/dark pin the scheme', () => {
    expect(resolveThemeAttribute('system', true)).toBe('dark');
    expect(resolveThemeAttribute('system', false)).toBe('light');
    expect(resolveThemeAttribute('light', true)).toBe('light');
    expect(resolveThemeAttribute('dark', false)).toBe('dark');
  });

  test('an absent or unknown theme resolves to no attribute instead of a guess', () => {
    expect(resolveThemeAttribute(null, true)).toBeNull();
    expect(resolveThemeAttribute('sepia', true)).toBeNull();
  });
});

describe('document attributes for one settings view', () => {
  test('maps every key and resolves only the theme', () => {
    const entries = indexUiSettings(viewOf([
      { key: 'theme', value: 'dark' },
      { key: 'density', value: 'compact' },
      { key: 'fontSize', value: 'large' },
      { key: 'motion', value: 'reduced' },
      { key: 'timeDisplay', value: 'absolute' },
    ]));
    expect(documentAttributesFor({
      theme: 'dark', density: 'compact', fontSize: 'large', motion: 'reduced',
    }, false)).toEqual({ theme: 'dark', density: 'compact', fontSize: 'large', motion: 'reduced' });
    // `timeDisplay` is not an attribute: it changes a rendering choice, not the document.
    expect(Object.keys(documentAttributesFor({
      theme: 'system', density: null, fontSize: null, motion: null,
    }, true))).toEqual(['theme', 'density', 'fontSize', 'motion']);
    expect(entries.timeDisplay?.value).toBe('absolute');
  });

  test('ignores unknown keys and keys the Runtime did not report', () => {
    const entries = indexUiSettings(viewOf([
      { key: 'theme', value: 'system' },
      { key: 'density', value: 'compact' },
      { key: 'wobble', value: 'lots' },
    ]));
    expect(Object.keys(entries).sort()).toEqual(['density', 'theme']);
    // A key that is absent contributes no attribute at all, so an unreachable Runtime leaves the
    // document the way it was rather than half-applied.
    expect(documentAttributesFor({
      theme: null, density: 'compact', fontSize: null, motion: null,
    }, false)).toEqual({ theme: null, density: 'compact', fontSize: null, motion: null });
    expect(indexUiSettings(null)).toEqual({});
  });

  test('applies and removes exactly the attributes it is given', () => {
    // A structural stand-in for `document.documentElement.dataset`: the module's DOM surface is one
    // index signature wide, which is why this assertion needs no DOM implementation.
    const dataset: Record<string, string | undefined> = {};
    const root: DatasetTarget = { dataset };
    applyDocumentAttributes({ theme: 'dark', density: 'compact', fontSize: null, motion: null }, root);
    expect(dataset).toEqual({ theme: 'dark', density: 'compact' });
    applyDocumentAttributes({ theme: null, density: 'comfortable', fontSize: 'large', motion: null },
      root);
    expect(dataset).toEqual({ density: 'comfortable', fontSize: 'large' });
    expect('theme' in dataset).toBe(false);
  });
});

describe('update times', () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  test('the relative wording is the one the workbench already used', () => {
    expect(updateTimeLabel(now, now, 'relative')).toBe('刚刚更新');
    expect(updateTimeLabel(now - 5 * 60_000, now, 'relative')).toBe('5 分钟前更新');
    expect(updateTimeLabel(now - 3 * 3_600_000, now, 'relative')).toBe('3 小时前更新');
    expect(updateTimeLabel(now - 2 * 86_400_000, now, 'relative')).toBe('2 天前更新');
    // A clock that moved backwards never renders a negative age.
    expect(updateTimeLabel(now + 60_000, now, 'relative')).toBe('刚刚更新');
  });

  test('absolute prints the local time, and an unknown mode stays relative', () => {
    expect(updateTimeLabel(now, now, 'absolute')).toBe(new Date(now).toLocaleString('zh-CN'));
    expect(updateTimeLabel(now, now, 'absolute')).toContain('2026');
    expect(updateTimeLabel(now - 60_000, now, null)).toBe('1 分钟前更新');
    expect(updateTimeLabel(now - 60_000, now, 'relative')).toBe('1 分钟前更新');
  });
});

describe('labels and the CLI hint', () => {
  test('names every known value and falls back to the raw value', () => {
    expect(uiSettingKeyLabel('timeDisplay')).toBe('时间显示');
    expect(uiSettingKeyLabel('wobble')).toBe('wobble');
    expect(uiSettingValueLabel('theme', 'system')).toBe('跟随系统');
    expect(uiSettingValueLabel('motion', 'reduced')).toBe('减少动效');
    // A value the Runtime accepts but this client has no wording for is shown verbatim, never
    // relabelled into a different choice.
    expect(uiSettingValueLabel('theme', 'sepia')).toBe('sepia');
  });

  test('shows the exact CLI command and a hint for each key', () => {
    expect(uiSettingCommand('fontSize', 'large')).toBe('codeestra settings ui set fontSize large');
    expect(uiSettingHint('theme')).toContain('跟随系统');
    expect(uiSettingHint('wobble')).toBe('');
  });
});
