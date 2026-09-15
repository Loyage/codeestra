import { useEffect, useState } from 'react';
import {
  resolveThemeAttribute,
  uiSettingValueLabel,
  useUiSettingsOrNull,
} from './ui-settings.js';

type Theme = 'system' | 'light' | 'dark';

/**
 * The theme selector (ADR-0015), now backed by the Runtime's `theme` setting (ADR-0045).
 *
 * What did not change: `document.documentElement`'s `data-theme` is still the mechanism, `system`
 * still means "follow the operating system live", and light/dark still pin the scheme. What changed
 * is where the choice is *stored* — the Runtime home, through the same command the CLI uses, instead
 * of `window.localStorage`. The provider applies the theme for the whole session, so this component
 * only reads and writes the value.
 *
 * One case still exists without a provider: the token form, which runs before a client exists and
 * therefore cannot reach the Runtime at all. There the selector keeps today's capability (a dark
 * login screen) as a per-render preview that writes nowhere — it is not storage, and it is replaced
 * by the Runtime's value the moment the app loads.
 */
export function ThemeSelector() {
  const settings = useUiSettingsOrNull();
  const [preview, setPreview] = useState<Theme>('system');
  const stored = settings?.entries.theme;
  const theme: Theme = settings === null
    ? preview
    : ((stored?.value === 'light' || stored?.value === 'dark' || stored?.value === 'system')
      ? stored.value : 'system');

  useEffect(() => {
    if (settings !== null) return undefined;
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      const resolved = resolveThemeAttribute(preview, system.matches);
      if (resolved === null) delete document.documentElement.dataset['theme'];
      else document.documentElement.dataset['theme'] = resolved;
    };
    apply();
    system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, [settings, preview]);

  // The Runtime's own list of accepted values is used whenever it is known; the three names here
  // are only the labels for the value the selector can offer before a Runtime is reachable.
  const values = stored?.values ?? ['system', 'light', 'dark'];
  return (
    <label className="theme-selector">
      <span>外观</span>
      <select
        aria-label="界面主题"
        value={theme}
        disabled={settings?.busy ?? false}
        onChange={(event) => {
          const next = event.target.value;
          if (settings === null) {
            setPreview(next === 'light' || next === 'dark' ? next : 'system');
            return;
          }
          void settings.setValue('theme', next);
        }}
      >
        {values.map((value) => (
          <option key={value} value={value}>{uiSettingValueLabel('theme', value)}</option>
        ))}
      </select>
    </label>
  );
}
