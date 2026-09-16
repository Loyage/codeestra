import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTemporaryDirectories, registerTemporaryDirectory } from './support/agent-fixture.js';
import { reclaimTestResources, runCli } from './support/runtime-reclamation.js';

/**
 * The automatic task-worktree reclamation switch through the real command face (ADR-0062).
 *
 * The behaviour it gates (a successful integration reclaiming the member worktrees) is asserted
 * end to end in `cli-integrate.test.ts`; this file proves the setting itself: the product default,
 * the on/off write, the exact file, the stable refusal for an unreadable file, and the fact that the
 * Web UI transport reaches the very same Runtime command. No browser, screenshot or desktop
 * automation is involved (ADR-0008).
 */

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

process.env['no_proxy'] = '127.0.0.1,localhost';

afterEach(async () => {
  await reclaimTestResources();
  cleanupTemporaryDirectories();
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  return await runCli(args, environment, { entry: cliEntry });
}

interface AutoReclaimView {
  readonly enabled: boolean;
  readonly default: boolean;
  readonly file: string;
  readonly appliesTo: string;
}

async function fixture(): Promise<{ readonly environment: Record<string, string>;
  readonly home: string }> {
  const home = temporaryDirectory('ce-auto-reclaim-home-');
  const assets = temporaryDirectory('ce-auto-reclaim-assets-');
  // `codeestra ui` refuses to start the HTTP surface without built assets.
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  return { environment: { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets }, home };
}

function settingsFile(home: string): string {
  return join(home, 'auto-reclaim.json');
}

async function read(environment: Record<string, string>): Promise<AutoReclaimView> {
  const result = await cli(['settings', 'auto-reclaim', '--json'], environment);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as AutoReclaimView;
}

describe('codeestra auto-reclaim setting', () => {
  test('reports the product default and creates no file on a read', async () => {
    const { environment, home } = await fixture();
    try {
      const view = await read(environment);
      expect(view).toMatchObject({ enabled: true, default: true, file: settingsFile(home) });
      expect(view.appliesTo).toContain('reclaim');
      // Reading does not invent a file: "no explicit choice" stays visible as the default.
      expect(readdirSync(home).includes('auto-reclaim.json')).toBe(false);

      // The usage text documents the face, and an unknown value is a usage error that writes nothing.
      const usage = await cli(['settings', 'auto-reclaim'], environment);
      expect(usage.exitCode).toBe(0);
      const bad = await cli(['settings', 'auto-reclaim', 'maybe'], environment);
      expect(bad.exitCode).toBe(2);
      const extra = await cli(['settings', 'auto-reclaim', 'on', 'off'], environment);
      expect(extra.exitCode).toBe(2);
      expect(readdirSync(home).includes('auto-reclaim.json')).toBe(false);
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);

  test('writes the switch with no confirmation, in a 0600 versioned file', async () => {
    const { environment, home } = await fixture();
    try {
      const off = await cli(['settings', 'auto-reclaim', 'off', '--json'], environment);
      expect(off.exitCode).toBe(0);
      expect(JSON.parse(off.stdout) as AutoReclaimView).toMatchObject({ enabled: false,
        default: true });
      expect(JSON.parse(readFileSync(settingsFile(home), 'utf8'))).toEqual({
        version: 1, enabled: false,
      });
      expect(statSync(settingsFile(home)).mode & 0o777).toBe(0o600);
      expect(readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect((await read(environment)).enabled).toBe(false);

      const on = await cli(['settings', 'auto-reclaim', 'on', '--json'], environment);
      expect(on.exitCode).toBe(0);
      expect(JSON.parse(on.stdout) as AutoReclaimView).toMatchObject({ enabled: true });
      expect(JSON.parse(readFileSync(settingsFile(home), 'utf8'))).toEqual({
        version: 1, enabled: true,
      });
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);

  test('uses the product default for an unreadable file, and a write repairs it', async () => {
    const { environment, home } = await fixture();
    try {
      writeFileSync(settingsFile(home), '{"version":1,"enabled":"yes"}');
      // The Runtime reports the unreadable file at startup and falls back to the product default
      // rather than refusing to boot or silently rewriting what it cannot understand.
      expect((await read(environment)).enabled).toBe(true);
      expect(readFileSync(settingsFile(home), 'utf8')).toBe('{"version":1,"enabled":"yes"}');

      // The write is the documented way out: it replaces the file with a valid one.
      const repaired = await cli(['settings', 'auto-reclaim', 'off'], environment);
      expect(repaired.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(settingsFile(home), 'utf8'))).toEqual({
        version: 1, enabled: false,
      });
      expect((await read(environment)).enabled).toBe(false);
    } finally {
      chmodSync(home, 0o700);
      await cli(['stop'], environment);
    }
  }, 120_000);

  test('the Web UI transport reads and writes the very same setting', async () => {
    const { environment } = await fixture();
    try {
      expect((await cli(['settings', 'auto-reclaim', 'off'], environment)).exitCode).toBe(0);
      const ui = await cli(['ui', '--no-open'], environment);
      expect(ui.exitCode).toBe(0);
      const url = new URL(ui.stdout.trim());
      const token = new URLSearchParams(url.hash.replace(/^#/, '')).get('token');
      expect(typeof token).toBe('string');

      const command = async (body: Record<string, unknown>): Promise<{
        readonly status: number; readonly ok: boolean; readonly result?: unknown;
        readonly errorCode?: string }> => {
        const response = await fetch(`${url.origin}/api/command`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token as string}`, 'content-type': 'application/json' },
          body: JSON.stringify({ requestId: crypto.randomUUID(), schemaVersion: 1, ...body }),
        });
        const envelope = await response.json() as { readonly ok?: boolean;
          readonly result?: unknown; readonly error?: unknown };
        const failure = envelope.error;
        return {
          status: response.status,
          ok: envelope.ok === true,
          result: envelope.result,
          ...(typeof failure === 'string' ? { errorCode: failure }
            : typeof failure === 'object' && failure !== null && 'code' in failure
              && typeof failure.code === 'string' ? { errorCode: failure.code } : {}),
        };
      };

      const overHttp = await command({ command: 'settings.autoReclaim.get' });
      expect(overHttp.ok).toBe(true);
      expect(JSON.stringify(overHttp.result)).toBe(JSON.stringify(await read(environment)));

      const written = await command({ command: 'settings.autoReclaim.set', enabled: true });
      expect(written.ok).toBe(true);
      expect((await read(environment)).enabled).toBe(true);
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);
});
