import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { describeError, type RuntimeClient } from './api.js';
import type { AutoReclaimView } from './types.js';
import {
  UiSettingsContext,
  applyDocumentAttributes,
  documentAttributesFor,
  indexUiSettings,
  uiSettingCommand,
  uiSettingEffectFrom,
  uiSettingHint,
  uiSettingKeyLabel,
  uiSettingValueLabel,
  useUiSettingsOrNull,
  type UiSettingKey,
  type UiSettingsContextValue,
  type UiSettingsView,
} from './ui-settings.js';

/**
 * The interface-effect settings (FOUNDATION-073 / ADR-0045).
 *
 * The provider is what makes these settings *global*: it loads them once, applies them to the
 * document (so they hold on every tab, not only on the settings page) and gives the sidebar's theme
 * selector and the settings page one shared state. Every write goes to the Runtime through the same
 * command the CLI uses; the browser stores nothing, so a different browser — or one whose storage
 * was cleared — sees the same values.
 */
export function UiSettingsProvider({ client, children }: {
  readonly client: RuntimeClient;
  readonly children: ReactNode;
}) {
  const [view, setView] = useState<UiSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const listed = await client.command<UiSettingsView>({ command: 'settings.ui.list' });
      setView(listed);
      setError(null);
    } catch (failure) {
      // The Runtime is authoritative about whether it can read its own settings file. A file it
      // cannot read is reported as such and *no* attribute is applied: the page falls back to its
      // own defaults instead of showing a preference that is not actually recorded.
      setError(describeError(failure));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  const entries = useMemo(() => indexUiSettings(view), [view]);

  // Applying is a presentation step and nothing else. While the theme is `system` the operating
  // system's choice is followed live, which is ADR-0015's semantics kept exactly; `reduced` motion
  // is attribute-driven so it works whether or not the system asks for reduced motion.
  useEffect(() => {
    const system = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      applyDocumentAttributes(
        documentAttributesFor(uiSettingEffectFrom(entries), system.matches),
        document.documentElement);
    };
    apply();
    system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, [entries]);

  const setValue = useCallback(async (key: UiSettingKey, value: string): Promise<void> => {
    setBusy(true);
    try {
      // The Runtime answers with the whole settings face, so the page never has to guess what the
      // file now says (and a refusal — an unknown key, an invalid value, a broken file — changes
      // nothing and is reported verbatim).
      setView(await client.command<UiSettingsView>({ command: 'settings.ui.set', key, value }));
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }, [client]);

  const reset = useCallback(async (key?: UiSettingKey): Promise<void> => {
    setBusy(true);
    try {
      setView(await client.command<UiSettingsView>({
        command: 'settings.ui.reset',
        ...(key === undefined ? {} : { key }),
      }));
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }, [client]);

  const value = useMemo<UiSettingsContextValue>(() => ({
    view, entries, error, busy, loading, setValue, reset, refresh,
  }), [view, entries, error, busy, loading, setValue, reset, refresh]);

  return <UiSettingsContext.Provider value={value}>{children}</UiSettingsContext.Provider>;
}

/**
 * The settings page. It shows what the Runtime records — effective value, product default, and
 * whether the value was explicitly chosen — plus the exact CLI command for each change, because the
 * UI is a front end to that command face and never a second implementation of it (ADR-0008).
 */
export function SettingsPage({ client }: { readonly client: RuntimeClient }) {
  const settings = useUiSettingsOrNull();
  if (settings === null) {
    return <p className="muted">设置尚未加载。</p>;
  }
  const { view, entries, error, busy, loading, setValue, reset, refresh } = settings;
  return (
    <>
    <section className="card settings-page">
      <div className="section-heading">
        <h2>界面效果</h2>
        <button type="button" disabled={busy || loading} onClick={() => { void refresh(); }}>
          {loading ? '正在读取…' : '重新读取'}
        </button>
      </div>
      <p className="hint">
        设置存放在 Runtime（<span className="mono">CODEESTRA_HOME</span>）里，不是浏览器本地存储：
        换浏览器、清理浏览器存储或重启 Runtime 后依然生效，命令行
        （<span className="mono">codeestra settings ui …</span>）读写的是同一份值。
      </p>
      {error === null ? null : (
        <div className="banner error" role="alert">
          读取或写入 Runtime 设置失败：{error}
        </div>
      )}
      {view === null ? <p className="muted">Runtime 尚未返回设置。</p> : (
        <>
          <p className="muted hint mono">{view.file}</p>
          <p className="muted hint">{view.appliesTo}</p>
          <ul className="settings-list">
            {view.settings.map((entry) => (
              <li key={entry.key} className="settings-row">
                <div className="settings-row-head">
                  <strong>{uiSettingKeyLabel(entry.key)}</strong>
                  <span className="mono muted">{entry.key}</span>
                </div>
                <p className="hint muted">{uiSettingHint(entry.key)}</p>
                <div className="settings-row-control">
                  <select
                    aria-label={`${uiSettingKeyLabel(entry.key)}（${entry.key}）`}
                    value={entry.value}
                    disabled={busy}
                    onChange={(event) => {
                      void setValue(entry.key as UiSettingKey, event.target.value);
                    }}
                  >
                    {entry.values.map((value) => (
                      <option key={value} value={value}>{uiSettingValueLabel(entry.key, value)}</option>
                    ))}
                  </select>
                  <span className="muted hint">
                    当前 <span className="mono">{entry.value}</span> · 默认{' '}
                    <span className="mono">{entry.default}</span> ·{' '}
                    {entry.explicit ? '已显式设置' : '未显式设置（使用默认值）'}
                  </span>
                  <button type="button" disabled={busy || !entry.explicit}
                    onClick={() => { void reset(entry.key as UiSettingKey); }}>
                    恢复默认
                  </button>
                </div>
                <p className="hint muted mono">{uiSettingCommand(entry.key, entry.value)}</p>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button type="button" disabled={busy
              || !view.settings.some((item) => item.explicit)}
              onClick={() => { void reset(); }}>
              全部恢复默认
            </button>
            <span className="muted hint">
              这只会删掉 Runtime 里记录的显式选择，不删除文件本身，也不改变任何任务状态。
            </span>
          </div>
        </>
      )}
      {entries.theme === undefined ? null : (
        <p className="hint muted">
          外观选择仍可从侧栏的「外观」下拉框修改，两处写的是同一个设置。
        </p>
      )}
    </section>
    <AutoReclaimCard client={client} />
    </>
  );
}

/**
 * The automatic task-worktree reclamation switch (ADR-0062). Like every settings control, it writes
 * through the same Runtime command the CLI uses and shows the exact CLI spelling; nothing is stored
 * in the browser.
 */
function AutoReclaimCard({ client }: { readonly client: RuntimeClient }) {
  const [view, setView] = useState<AutoReclaimView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      setView(await client.command<AutoReclaimView>({ command: 'settings.autoReclaim.get' }));
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  const setEnabled = useCallback(async (enabled: boolean): Promise<void> => {
    setBusy(true);
    try {
      setView(await client.command<AutoReclaimView>({
        command: 'settings.autoReclaim.set', enabled,
      }));
      setError(null);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }, [client]);

  return (
    <section className="card settings-page">
      <div className="section-heading">
        <h2>资源回收</h2>
        <button type="button" disabled={busy} onClick={() => { void refresh(); }}>
          {busy ? '正在读取…' : '重新读取'}
        </button>
      </div>
      <p className="hint">
        集成成功后，Codeestra 按 <span className="mono">reclaim</span> 的同一套归属校验自动回收该批成员的
        Task worktree；失败现场（脏 / 未合入 / 失败或取消）仍然保留。关闭后回到手动
        <span className="mono">reclaim</span>。
      </p>
      {error === null ? null : (
        <div className="banner error" role="alert">读取或写入 Runtime 设置失败：{error}</div>
      )}
      {view === null ? <p className="muted">Runtime 尚未返回设置。</p> : (
        <div className="settings-row">
          <div className="settings-row-head">
            <strong>集成后自动回收 worktree</strong>
            <span className="mono muted">auto-reclaim</span>
          </div>
          <p className="hint muted mono">{view.file}</p>
          <p className="hint muted">{view.appliesTo}</p>
          <div className="settings-row-control">
            <label>
              <input
                type="checkbox"
                checked={view.enabled}
                disabled={busy}
                onChange={(event) => { void setEnabled(event.target.checked); }}
              />{' '}
              自动回收（当前 <span className="mono">{view.enabled ? 'on' : 'off'}</span> · 默认{' '}
              <span className="mono">{view.default ? 'on' : 'off'}</span>）
            </label>
            <p className="hint muted mono">
              codeestra settings auto-reclaim {view.enabled ? 'off' : 'on'}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
