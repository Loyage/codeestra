import { describe, expect, test } from 'bun:test';
import {
  readProcessStartToken,
  terminateProviderProcessTree,
  type ProviderProcessTree,
} from '../src/index.js';

/**
 * The forced-termination primitive behind `task purge --force` (ADR-0058 D09).
 *
 * The process table, the start tokens, the signals and the sleeps are all injected, so these tests
 * describe the *decision* (whom it is allowed to signal, in what order, and what it refuses to
 * claim) rather than this machine's timing. One real-process test at the end proves the signals
 * actually reach a running process.
 */

interface FakeProcess {
  readonly pid: number;
  /** The start token the process table reports *now*. */
  readonly startToken: string | null;
  /** The token that was recorded while the provider was alive; defaults to `startToken`. */
  readonly recordedStartToken?: string | null;
  /** True when this fake process is still in the table. */
  alive: boolean;
}

function harness(input: {
  readonly provider: FakeProcess;
  readonly descendants: readonly FakeProcess[];
  /** Pids that exit when they receive this signal; everything else survives it. */
  readonly diesOn: Partial<Record<'SIGTERM' | 'SIGKILL', readonly number[]>>;
}) {
  const processes = [input.provider, ...input.descendants];
  const signals: { readonly pid: number; readonly signal: 'SIGTERM' | 'SIGKILL' }[] = [];
  const sleeps: number[] = [];
  const tree: ProviderProcessTree = {
    pid: input.provider.pid,
    startToken: input.provider.startToken ?? 'provider-token',
    pgid: null,
    descendants: input.descendants.map((descendant) => ({
      pid: descendant.pid,
      startToken: descendant.recordedStartToken === undefined
        ? descendant.startToken
        : descendant.recordedStartToken,
      command: `child-${descendant.pid}`,
    })),
    capturedAt: 0,
    note: 'test tree',
  };
  return {
    tree,
    signals,
    sleeps,
    alivePids: (): readonly number[] => processes.filter((entry) => entry.alive)
      .map((entry) => entry.pid),
    run: async (options: { readonly graceMs?: number } = {}) => await terminateProviderProcessTree({
      tree,
      graceMs: options.graceMs ?? 50,
      readTable: async () => processes.filter((entry) => entry.alive)
        .map((entry) => ({ pid: entry.pid, ppid: 1, pgid: 1, command: `process-${entry.pid}` })),
      readStartToken: async (pid) => processes.find((entry) => entry.pid === pid)?.startToken ?? null,
      signal: (pid, signal) => {
        signals.push({ pid, signal });
        if (input.diesOn[signal]?.includes(pid) === true) {
          const target = processes.find((entry) => entry.pid === pid);
          if (target !== undefined) target.alive = false;
        }
      },
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    }),
  };
}

describe('terminateProviderProcessTree', () => {
  test('sends SIGTERM first, SIGKILL only to the survivors, and never claims a survivor is gone',
    async () => {
      // The shape FOUNDATION-040 measured: the provider takes SIGTERM, the tool child it started does
      // not, so the child needs its own SIGKILL.
      const fake = harness({
        provider: { pid: 7001, startToken: 'p', alive: true },
        descendants: [{ pid: 7002, startToken: 'c', alive: true }],
        diesOn: { SIGTERM: [7001], SIGKILL: [7002] },
      });
      const outcome = await fake.run();
      expect(outcome.attempted).toBe(true);
      expect(outcome.terminated).toBe(true);
      expect(fake.signals).toEqual([
        { pid: 7001, signal: 'SIGTERM' },
        { pid: 7002, signal: 'SIGTERM' },
        { pid: 7002, signal: 'SIGKILL' },
      ]);
      expect(outcome.signalsSent).toBe(3);
      expect(outcome.survivors).toEqual([]);
      expect(outcome.detail).toContain('no recorded process with a verified identity is still running');
    });

  test('reports a process that survives both signals instead of claiming quiescence', async () => {
    const fake = harness({
      provider: { pid: 7101, startToken: 'p', alive: true },
      descendants: [],
      diesOn: {},
    });
    const outcome = await fake.run();
    expect(outcome.terminated).toBe(false);
    expect(outcome.survivors).toEqual([7101]);
    expect(outcome.signalsSent).toBe(2);
    expect(outcome.detail).toContain('still running: 7101');
  });

  test('sends no signal when the recorded provider is already gone', async () => {
    const fake = harness({
      provider: { pid: 7201, startToken: 'p', alive: false },
      descendants: [{ pid: 7202, startToken: 'c', alive: false }],
      diesOn: {},
    });
    const outcome = await fake.run();
    expect(outcome).toMatchObject({ attempted: false, signalsSent: 0, terminated: true });
    expect(fake.signals).toEqual([]);
    expect(fake.sleeps).toEqual([]);
    expect(outcome.detail).toContain('no recorded provider process was still running');
  });

  test('never signals a recycled pid or a pid whose start token was never captured', async () => {
    // 7301 is occupied by a *different* process (the token recorded back then does not match the one
    // read now), and 7302 was recorded without a token, so neither can be attributed to this provider:
    // signalling either could kill a stranger's process.
    const fake = harness({
      provider: { pid: 7300, startToken: 'recorded', alive: true },
      descendants: [
        { pid: 7301, startToken: 'a-different-process', recordedStartToken: 'ours-back-then',
          alive: true },
        { pid: 7302, startToken: null, alive: true },
      ],
      diesOn: { SIGTERM: [7300], SIGKILL: [] },
    });
    const outcome = await fake.run();
    expect(fake.signals).toEqual([{ pid: 7300, signal: 'SIGTERM' }]);
    expect(outcome.signalled).toEqual([7300]);
    expect(outcome.terminated).toBe(true);
    expect(outcome.unattributable).toEqual([7302]);
    expect(fake.alivePids()).toContain(7301);
    expect(fake.alivePids()).toContain(7302);
  });

  test('an unreadable process table is an attempted-nothing fact, not a silent success', async () => {
    const outcome = await terminateProviderProcessTree({
      tree: { pid: 7401, startToken: 'p', pgid: null, descendants: [], capturedAt: 0,
        note: 'test' },
      readTable: async () => { throw new Error('ps is unavailable'); },
    });
    expect(outcome).toMatchObject({ attempted: false, signalsSent: 0, terminated: false,
      signalled: [], survivors: [] });
    expect(outcome.detail).toContain('the process table could not be read');
  });

  test('really terminates a running process it captured, and reports it gone', async () => {
    const child = Bun.spawn(['sleep', '60'], { stdout: 'pipe', stderr: 'pipe' });
    const startToken = await readProcessStartToken(child.pid);
    expect(typeof startToken).toBe('string');
    const outcome = await terminateProviderProcessTree({
      tree: { pid: child.pid, startToken: startToken as string, pgid: null, descendants: [],
        capturedAt: 0, note: 'test tree' },
      graceMs: 3_000,
    });
    await child.exited;
    expect(outcome.attempted).toBe(true);
    expect(outcome.terminated).toBe(true);
    expect(outcome.signalsSent).toBeGreaterThan(0);
    expect(() => { process.kill(child.pid, 0); }).toThrow();
  }, 15_000);
});
