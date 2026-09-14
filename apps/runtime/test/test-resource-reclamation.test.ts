import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inspectRuntimeHome, pidExists, readProcessState,
  readProcessStartToken } from '../src/lifecycle.js';
import {
  normalizeRuntimeEnvironment,
  preserveFailureEvidence,
  reclaimTestResources,
  registerRuntimeHome,
  repositoryRoot,
  runCli,
  temporaryFixtureDirectory,
} from './support/runtime-reclamation.js';

/**
 * Self-check for the shared reclamation support (FOUNDATION-057).
 *
 * The reclamation must not depend on a test remembering to call it: these tests assert that teardown
 * really stops a Runtime the test left behind, really removes the fixtures, refuses to touch a
 * process it cannot attribute, and never lets a test CLI reach a real Runtime home.
 */

afterEach(async () => { await reclaimTestResources(); });

describe('test resource reclamation', () => {
  test('a test CLI invocation can never reach a real Runtime home', () => {
    // The safety floor: no home at all is a mistake, not a default.
    expect(() => normalizeRuntimeEnvironment({})).toThrow(/CODEESTRA_HOME/);
    // The developer's stable home and the stable worktree are explicitly refused.
    expect(() => normalizeRuntimeEnvironment({
      CODEESTRA_HOME: join(homedir(), '.local', 'state', 'codeestra'),
    })).toThrow(/Refusing/);
    expect(() => normalizeRuntimeEnvironment({
      CODEESTRA_HOME: join(homedir(), 'Documents', 'codeestra', '.codeestra'),
    })).toThrow(/Refusing/);
    // A temporary home passes and is normalized to an absolute path.
    const home = temporaryFixtureDirectory('codeestra-reclaim-env-');
    expect(normalizeRuntimeEnvironment({ CODEESTRA_HOME: home })['CODEESTRA_HOME']).toBe(home);
  });

  test('teardown stops a Runtime the test never stopped and removes its home', async () => {
    const home = temporaryFixtureDirectory('codeestra-reclaim-leak-');
    // A read-only command is enough: the CLI starts the Runtime itself through `ensureRuntime`.
    const started = await runCli(['status'], { CODEESTRA_HOME: home });
    expect(started.exitCode).toBe(0);
    const status = JSON.parse(started.stdout) as { readonly pid: number };
    expect(await readProcessState(status.pid)).toBe('RUNNING');

    // This test deliberately does not stop it: that is exactly the leak the helper has to reclaim.
    const report = await reclaimTestResources();

    expect(report.unconfirmed).toEqual([]);
    expect(report.stopped.map((entry) => entry.pid)).toContain(status.pid);
    expect(report.removedDirectories).toContain(home);
    expect(existsSync(home)).toBe(false);
    expect(await readProcessState(status.pid)).not.toBe('RUNNING');
    // Nothing is left behind to explain: a clean shutdown released its own lock.
    const after = await inspectRuntimeHome({ home });
    expect(after.verdict).toBe('NOT_RUNNING');
    expect(after.lock.present).toBe(false);
  }, 60_000);

  test('a Runtime the CLI started for a registered home is found without the test saying so',
    async () => {
      const home = temporaryFixtureDirectory('codeestra-reclaim-discovered-');
      // Only the directory is registered, exactly as every fixture helper registers its own.
      expect((await runCli(['status'], { CODEESTRA_HOME: home })).exitCode).toBe(0);
      const inspect = await inspectRuntimeHome({ home, readStartToken: readProcessStartToken });
      expect(inspect.verdict).toBe('RUNNING');
      const pid = inspect.lock.record?.pid as number;

      const report = await reclaimTestResources();

      expect(report.stopped.map((entry) => entry.pid)).toContain(pid);
      expect(pidExists(pid)).toBe(false);
      expect(existsSync(home)).toBe(false);
    }, 60_000);

  test('a live process this worktree cannot attribute is reported, never signalled',
    async () => {
      const home = temporaryFixtureDirectory('codeestra-reclaim-foreign-');
      registerRuntimeHome(home);
      mkdirSync(home, { recursive: true });
      const foreign = Bun.spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' });
      try {
        // A lock record that names a live process which is not this worktree's Runtime: the recorded
        // argv is a plain `sleep`, so the ownership gate has to refuse rather than guess.
        await Bun.write(join(home, 'runtime.lock'), `${JSON.stringify({
          bootId: 'boot-foreign', pid: foreign.pid, startedAt: Date.now(),
          startToken: await readProcessStartToken(foreign.pid),
          argv: [process.execPath, 'sleep', '60'], cwd: home,
        })}\n`);

        const report = await reclaimTestResources();

        expect(report.stopped).toEqual([]);
        expect(report.unattributed.map((entry) => entry.pid)).toContain(foreign.pid);
        expect(report.unattributed[0]?.looksOwned).toBe(false);
        // The foreign process was never signalled, and its home (this test's own fixture) is gone.
        expect(pidExists(foreign.pid)).toBe(true);
        expect(existsSync(home)).toBe(false);
      } finally {
        foreign.kill('SIGTERM');
        await foreign.exited;
      }
    }, 60_000);

  test('a process can never be attributed to the test session itself', async () => {
    const home = temporaryFixtureDirectory('codeestra-reclaim-self-');
    registerRuntimeHome(home);
    mkdirSync(home, { recursive: true });
    await Bun.write(join(home, 'runtime.lock'), `${JSON.stringify({
      bootId: 'boot-self', pid: process.pid, startedAt: Date.now(),
      startToken: await readProcessStartToken(process.pid),
      argv: [process.execPath, 'run', join(repositoryRoot, 'apps', 'runtime', 'src', 'main.ts')],
      cwd: repositoryRoot,
    })}\n`);

    const report = await reclaimTestResources();

    expect(report.stopped).toEqual([]);
    expect(report.unattributed.map((entry) => entry.pid)).toContain(process.pid);
    expect(pidExists(process.pid)).toBe(true);
  }, 60_000);

  test('a test that declares a failure scene keeps it, and the paths are printed', async () => {
    const home = temporaryFixtureDirectory('codeestra-reclaim-evidence-');
    await Bun.write(join(home, 'agent-output.txt'), 'evidence\n');
    preserveFailureEvidence('deliberate: this test asserts the evidence path');

    const report = await reclaimTestResources();

    expect(report.evidenceReason).toBe('deliberate: this test asserts the evidence path');
    expect(report.preservedDirectories).toContain(home);
    expect(report.removedDirectories).toEqual([]);
    expect(existsSync(join(home, 'agent-output.txt'))).toBe(true);
    // Retaining evidence is explicit, so this test also removes what it deliberately kept.
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
});
