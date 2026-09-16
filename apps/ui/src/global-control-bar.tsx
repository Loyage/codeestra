import { useCallback, useEffect, useState } from 'react';
import { RuntimeClient, UiError, describeError } from './api.js';
import { GlobalControlPanel } from './global-control.js';
import type { RuntimeGlobalControlView } from './types.js';

/**
 * The global shell's control bar (FOUNDATION-097 / ADR-0061 D09).
 *
 * It belongs to no Project: the barrier it drives is host-wide, so this component is mounted in the
 * shell rather than on a project page, and it never reads the selected project.
 *
 * Three rules it follows, all of them from ADR-0061 D09:
 *
 * 1. **Only the command face.** `scheduler control status|pause|resume|reconcile` — nothing else, no
 *    direct database access, no second definition of the state.
 * 2. **No local gate.** The buttons are always rendered; a refusal from the Runtime is displayed with
 *    its stable code. Whether a pause is possible is the Runtime's answer, not the shell's guess.
 * 3. **The view is refreshed after every command**, and the panel keeps showing the *previous*
 *    per-target facts while a new state settles, because those facts are what makes a partial freeze
 *    visible instead of a spinner.
 */
export function GlobalControlBar({ client }: { readonly client: RuntimeClient }) {
  const [view, setView] = useState<RuntimeGlobalControlView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setView(await client.command<RuntimeGlobalControlView>({ command: 'scheduler.control.status' }));
      setError(null);
    } catch (caught) {
      setError(asError(caught));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  // The state can change without this tab (another client, or the Runtime's own recovery), so the
  // bar re-reads it: a shell that showed a stale barrier would be worse than no indicator at all.
  useEffect(() => {
    const timer = setInterval(() => { void load(); }, 10_000);
    return () => { clearInterval(timer); };
  }, [load]);

  const run = useCallback(async (
    command: 'scheduler.control.pause' | 'scheduler.control.resume' | 'scheduler.control.reconcile',
  ): Promise<void> => {
    setBusy(true);
    try {
      const result = await client.command<RuntimeGlobalControlView>({
        command, ...(command === 'scheduler.control.reconcile' ? {} : { commandId: crypto.randomUUID() }),
      });
      setView(result);
      setError(null);
    } catch (caught) {
      // A refusal is reported as itself and the *facts* are read back from the command face: the
      // panel then shows which target could not be verified instead of only that something failed.
      setError(asError(caught));
      await load();
    } finally {
      setBusy(false);
    }
  }, [client, load]);

  return (
    <div className="global-control-bar">
      <GlobalControlPanel
        view={view}
        loading={loading}
        busy={busy}
        error={error}
        onPause={() => { void run('scheduler.control.pause'); }}
        onResume={() => { void run('scheduler.control.resume'); }}
        onReconcile={() => { void run('scheduler.control.reconcile'); }}
      />
    </div>
  );
}

function asError(caught: unknown): { code: string; message: string } {
  return caught instanceof UiError
    ? { code: caught.code, message: caught.message }
    : { code: 'UNKNOWN', message: describeError(caught) };
}
