import { useEffect, useState } from 'react';

type Theme = 'system' | 'light' | 'dark';
const themeKey = 'codeestra.theme';

/** Presentation preference only; unavailable browser storage must not prevent using the Runtime. */
export function ThemeSelector() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = window.localStorage.getItem(themeKey);
      return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch { return 'system'; }
  });
  useEffect(() => {
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset['theme'] = theme === 'system'
        ? (system.matches ? 'dark' : 'light') : theme;
    };
    apply();
    system.addEventListener('change', apply);
    try { window.localStorage.setItem(themeKey, theme); } catch { /* Session-only preference. */ }
    return () => system.removeEventListener('change', apply);
  }, [theme]);
  return (
    <label className="theme-selector">
      <span>外观</span>
      <select aria-label="界面主题" value={theme}
        onChange={(event) => setTheme(event.target.value as Theme)}>
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </label>
  );
}
