import { createContext, useContext } from 'react';

/**
 * Interface-effect settings, as the Web UI sees them (FOUNDATION-073 / ADR-0045).
 *
 * The UI owns no setting values: it reads them from the Runtime with the same command the CLI uses
 * (`settings.ui.list`/`get`/`set`/`reset`), so there is exactly one place a preference is stored and
 * exactly one place it can be wrong. What this module owns is the *presentation* half — which DOM
 * attribute a value drives, what a value is called in Chinese, and how a Task time is rendered.
 *
 * This file is deliberately free of browser-only imports at the top level: `documentAttributesFor`
 * and the time labels are pure functions that the unit test exercises in Node, while
 * `applyDocumentAttributes` is the single, thin, DOM-touching step. That split is what makes the
 * mapping checkable without a browser (no screenshot, no automation — ADR-0008).
 */

export type UiSettingKey = 'theme' | 'density' | 'fontSize' | 'motion' | 'timeDisplay';

/** One key exactly as the command face reports it. `values` is authoritative, never re-declared. */
export interface UiSettingEntry {
  readonly key: string;
  readonly value: string;
  readonly default: string;
  readonly values: readonly string[];
  readonly explicit: boolean;
  readonly source: 'PRODUCT_DEFAULT' | 'RUNTIME';
}

export interface UiSettingsView {
  readonly store: 'RUNTIME_FILE';
  readonly file: string;
  readonly appliesTo: string;
  readonly settings: readonly UiSettingEntry[];
}

/** The settings that are currently known, by key. A key the Runtime did not report is absent. */
export type UiSettingMap = Readonly<Partial<Record<UiSettingKey, UiSettingEntry>>>;

export function indexUiSettings(view: UiSettingsView | null): UiSettingMap {
  const map: Partial<Record<UiSettingKey, UiSettingEntry>> = {};
  for (const entry of view?.settings ?? []) {
    if (entry.key === 'theme' || entry.key === 'density' || entry.key === 'fontSize'
      || entry.key === 'motion' || entry.key === 'timeDisplay') {
      map[entry.key] = entry;
    }
  }
  return map;
}

/** The raw values, with `null` for "the Runtime did not report this key". */
export interface UiSettingEffect {
  readonly theme: string | null;
  readonly density: string | null;
  readonly fontSize: string | null;
  readonly motion: string | null;
}

export function uiSettingEffectFrom(settings: UiSettingMap): UiSettingEffect {
  return {
    theme: settings.theme?.value ?? null,
    density: settings.density?.value ?? null,
    fontSize: settings.fontSize?.value ?? null,
    motion: settings.motion?.value ?? null,
  };
}

/**
 * The `data-*` attributes for one effect, or `null` for "no attribute at all".
 *
 * The theme keeps ADR-0015's meaning word for word: `system` resolves against the operating system's
 * colour scheme (live, because the caller re-applies on `change`), and `light`/`dark` pin it. An
 * unreadable theme value resolves to no attribute rather than to a guess. The other three are passed
 * through verbatim — the CSS only reacts to the values it knows, so an unexpected word is inert
 * instead of being translated into something the user did not ask for.
 */
export function documentAttributesFor(
  effect: UiSettingEffect,
  prefersDark: boolean,
): Readonly<Record<string, string | null>> {
  return {
    theme: resolveThemeAttribute(effect.theme, prefersDark),
    density: effect.density,
    fontSize: effect.fontSize,
    motion: effect.motion,
  };
}

export function resolveThemeAttribute(theme: string | null, prefersDark: boolean): 'light' | 'dark' | null {
  if (theme === 'light' || theme === 'dark') return theme;
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return null;
}

/**
 * The exact DOM surface this feature needs. Written as a structural type rather than `HTMLElement`
 * on purpose: the repository's Node-side `tsc` run has no DOM lib, and keeping this module free of
 * DOM-only names is what lets the pure half of it be type-checked and unit-tested in Node.
 */
export interface DatasetTarget {
  readonly dataset: Record<string, string | undefined>;
}

/**
 * The one DOM write of this feature. `null` removes the attribute, so an unreachable Runtime leaves
 * the page exactly as it renders without this feature rather than in a half-applied state.
 */
export function applyDocumentAttributes(
  attributes: Readonly<Record<string, string | null>>,
  root: DatasetTarget,
): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null) delete root.dataset[name];
    else root.dataset[name] = value;
  }
}

/**
 * Task update times. `relative` is the wording FOUNDATION-058 introduced ("3 分钟前更新"), moved
 * here unchanged so the setting and the rendering cannot drift apart; `absolute` prints the local
 * date and time. Both modes keep the absolute timestamp in the element's `title`.
 */
export function relativeUpdateLabel(timestamp: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return '刚刚更新';
  if (minutes < 60) return `${minutes} 分钟前更新`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前更新`;
  return `${Math.floor(minutes / 1440)} 天前更新`;
}

export function absoluteUpdateLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN');
}

/** An unknown or absent `timeDisplay` renders the way the workbench always rendered it. */
export function updateTimeLabel(timestamp: number, now: number, display: string | null): string {
  return display === 'absolute' ? absoluteUpdateLabel(timestamp) : relativeUpdateLabel(timestamp, now);
}

/** Display names. The *values* come from the Runtime; only their labels live here. */
const uiSettingKeyLabels: Readonly<Record<string, string>> = {
  theme: '主题',
  density: '密度',
  fontSize: '字号',
  motion: '动效',
  timeDisplay: '时间显示',
};

const uiSettingValueLabels: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  theme: { system: '跟随系统', light: '浅色', dark: '深色' },
  density: { comfortable: '宽松', compact: '紧凑' },
  fontSize: { medium: '中', small: '小', large: '大' },
  motion: { full: '完整动效', reduced: '减少动效' },
  timeDisplay: { relative: '相对时间', absolute: '绝对时间' },
};

export function uiSettingKeyLabel(key: string): string {
  return uiSettingKeyLabels[key] ?? key;
}

export function uiSettingValueLabel(key: string, value: string): string {
  return uiSettingValueLabels[key]?.[value] ?? value;
}

/**
 * What the Runtime reports about one key, one sentence of context per key so the page explains what
 * a choice does instead of leaving five bare dropdowns. Presentation only.
 */
const uiSettingHints: Readonly<Record<string, string>> = {
  theme: '跟随系统会实时跟随操作系统的浅色/深色外观。',
  density: '紧凑会收紧卡片、列表与表格的间距。',
  fontSize: '调整整体字号（含终端与代码块）。',
  motion: '减少动效会在系统允许时也关闭界面动画；它只会减少动效，不会增加。',
  timeDisplay: '任务列表里的更新时间：相对时间或本地绝对时间（两种模式都保留完整时间提示）。',
};

export function uiSettingHint(key: string): string {
  return uiSettingHints[key] ?? '';
}

/** The equivalent CLI command, shown next to each control: the UI adds no capability of its own. */
export function uiSettingCommand(key: string, value: string): string {
  return `codeestra settings ui set ${key} ${value}`;
}

/**
 * The value the UI uses before it can ask the Runtime (the token form, which has no client). It is
 * a per-render preview only: nothing is written anywhere, and once the app is authenticated the
 * Runtime's stored value takes over.
 */
export interface UiSettingsContextValue {
  readonly view: UiSettingsView | null;
  readonly entries: UiSettingMap;
  readonly error: string | null;
  readonly busy: boolean;
  readonly loading: boolean;
  readonly setValue: (key: UiSettingKey, value: string) => Promise<void>;
  readonly reset: (key?: UiSettingKey) => Promise<void>;
  readonly refresh: () => Promise<void>;
}

export const UiSettingsContext = createContext<UiSettingsContextValue | null>(null);

/** `null` outside the provider, which is exactly the unauthenticated token form. */
export function useUiSettingsOrNull(): UiSettingsContextValue | null {
  return useContext(UiSettingsContext);
}

/** The time-display mode in force. Outside the provider there is no Runtime to ask: keep relative. */
export function useTimeDisplay(): string {
  return useUiSettingsOrNull()?.entries.timeDisplay?.value ?? 'relative';
}
