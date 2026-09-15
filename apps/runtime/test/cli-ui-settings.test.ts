import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTemporaryDirectories, registerTemporaryDirectory } from './support/agent-fixture.js';
import { reclaimTestResources, runCli } from './support/runtime-reclamation.js';

/**
 * The interface-effect settings through the real command face (FOUNDATION-073 / ADR-0045).
 *
 * Everything here is asserted from outside the product: a real CLI process, a real Runtime started by
 * that CLI, a real settings file in a temporary `CODEESTRA_HOME`, and one direct HTTP call on the
 * *same* command face the Web UI uses. No browser, no screenshot and no desktop automation is
 * involved (ADR-0008), so what this file can prove is the storage, the exit codes, the stable error
 * codes and the fact that a value survives a Runtime restart. What it cannot prove is how the
 * settings *look* — that is recorded as a human confirmation in the task note.
 *
 * The home is a registered temporary directory rather than a hand-written `/tmp/ce-j4`: the shared
 * reclamation helper refuses any home outside `os.tmpdir()`, because that check is what keeps a
 * leaked Runtime attributable to this worktree. The prefix keeps the directory recognizable.
 */

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

// A developer machine may have an HTTP proxy configured (this repository's own AGENTS.md documents
// one). Loopback must bypass it for this test's own request, exactly as the reclamation helper does
// for the CLI children it spawns — otherwise the Runtime's HTTP surface is reached through the proxy
// and answers 502.
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

interface UiSettingEntryView {
  readonly key: string;
  readonly value: string;
  readonly default: string;
  readonly values: readonly string[];
  readonly explicit: boolean;
  readonly source: string;
}

interface UiSettingsView {
  readonly store: string;
  readonly file: string;
  readonly appliesTo: string;
  readonly settings: readonly UiSettingEntryView[];
}

async function fixture(): Promise<{ readonly environment: Record<string, string>;
  readonly home: string }> {
  const home = temporaryDirectory('ce-j4-home-');
  const assets = temporaryDirectory('ce-j4-assets-');
  // `codeestra ui` refuses to start the HTTP surface without built assets.
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  return { environment: { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets }, home };
}

function settingsFile(home: string): string {
  return join(home, 'ui-settings.json');
}

function entry(view: UiSettingsView, key: string): UiSettingEntryView {
  const found = view.settings.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`${key} was not reported`);
  return found;
}

async function list(environment: Record<string, string>): Promise<UiSettingsView> {
  const listed = await cli(['settings', 'ui', 'list', '--json'], environment);
  expect(listed.exitCode).toBe(0);
  return JSON.parse(listed.stdout) as UiSettingsView;
}

async function bootId(environment: Record<string, string>): Promise<string> {
  const status = await cli(['status'], environment);
  expect(status.exitCode).toBe(0);
  return (JSON.parse(status.stdout) as { readonly bootId: string }).bootId;
}

describe('codeestra interface-effect settings', () => {
  test('reports every key with its product default and creates nothing on a read', async () => {
    const { environment, home } = await fixture();
    try {
      const view = await list(environment);
      expect(view.store).toBe('RUNTIME_FILE');
      expect(view.file).toBe(settingsFile(home));
      expect(view.settings.map((setting) => [setting.key, setting.value, setting.source,
        setting.explicit])).toEqual([
        ['theme', 'system', 'PRODUCT_DEFAULT', false],
        ['density', 'comfortable', 'PRODUCT_DEFAULT', false],
        ['fontSize', 'medium', 'PRODUCT_DEFAULT', false],
        ['motion', 'full', 'PRODUCT_DEFAULT', false],
        ['timeDisplay', 'relative', 'PRODUCT_DEFAULT', false],
      ]);
      // Each key carries the values it accepts, so a client never re-declares the enumeration.
      expect(entry(view, 'theme')).toMatchObject({ default: 'system',
        values: ['system', 'light', 'dark'] });
      expect(entry(view, 'motion')).toMatchObject({ values: ['full', 'reduced'] });
      // Reading does not invent a file: "no explicit choice" stays visible as such.
      expect(readdirSync(home).includes('ui-settings.json')).toBe(false);

      // `get` answers about one key, and the usage text documents the face.
      const one = await cli(['settings', 'ui', 'get', 'timeDisplay'], environment);
      expect(one.exitCode).toBe(0);
      expect(JSON.parse(one.stdout) as UiSettingEntryView).toMatchObject({ key: 'timeDisplay',
        value: 'relative', explicit: false });
      const usage = await cli(['settings', 'ui'], environment);
      expect(usage.exitCode).toBe(2);
      expect(usage.stderr).toContain('settings ui set <key> <value>');
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);

  test('writes one key with no confirmation and reads it back from the Runtime file', async () => {
    const { environment, home } = await fixture();
    try {
      const written = await cli(['settings', 'ui', 'set', 'theme', 'dark', '--json'], environment);
      expect(written.exitCode).toBe(0);
      expect(JSON.parse(written.stdout) as UiSettingsView).toMatchObject({
        store: 'RUNTIME_FILE', file: settingsFile(home) });
      expect(entry(JSON.parse(written.stdout) as UiSettingsView, 'theme')).toMatchObject({
        value: 'dark', default: 'system', explicit: true, source: 'RUNTIME' });

      const read = await cli(['settings', 'ui', 'get', 'theme', '--json'], environment);
      expect(read.exitCode).toBe(0);
      expect(JSON.parse(read.stdout) as UiSettingEntryView).toMatchObject({ value: 'dark',
        explicit: true, source: 'RUNTIME' });

      // The value is in the Runtime home, in a versioned file only this user can read, and the
      // neighbouring keys keep their defaults.
      expect(JSON.parse(readFileSync(settingsFile(home), 'utf8'))).toEqual({
        version: 1, settings: { theme: 'dark' },
      });
      expect(statSync(settingsFile(home)).mode & 0o777).toBe(0o600);
      expect(readdirSync(home).filter((name) => name.endsWith('.tmp'))).toEqual([]);

      // Setting the same value again is idempotent: same answer, same bytes.
      const before = readFileSync(settingsFile(home), 'utf8');
      const repeated = await cli(['settings', 'ui', 'set', 'theme', 'dark', '--json'], environment);
      expect(repeated.exitCode).toBe(0);
      expect(repeated.stdout).toBe(written.stdout);
      expect(readFileSync(settingsFile(home), 'utf8')).toBe(before);

      // `reset <key>` drops one explicit choice only, and `reset` drops all of them.
      await cli(['settings', 'ui', 'set', 'density', 'compact'], environment);
      const oneReset = await cli(['settings', 'ui', 'reset', 'theme', '--json'], environment);
      expect(oneReset.exitCode).toBe(0);
      const afterOne = JSON.parse(oneReset.stdout) as UiSettingsView;
      expect(entry(afterOne, 'theme')).toMatchObject({ value: 'system', explicit: false });
      expect(entry(afterOne, 'density')).toMatchObject({ value: 'compact', explicit: true });
      const allReset = await cli(['settings', 'ui', 'reset', '--json'], environment);
      expect(allReset.exitCode).toBe(0);
      expect((JSON.parse(allReset.stdout) as UiSettingsView).settings
        .every((setting) => setting.explicit)).toBe(false);
      expect(JSON.parse(readFileSync(settingsFile(home), 'utf8'))).toEqual({
        version: 1, settings: {},
      });
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);

  test('refuses unknown keys and unsupported values as usage errors, writing nothing', async () => {
    const { environment, home } = await fixture();
    try {
      const unknownKey = await cli(['settings', 'ui', 'set', 'colourScheme', 'dark'], environment);
      expect(unknownKey.exitCode).toBe(2);
      expect(unknownKey.stderr).toContain('colourScheme');
      expect(unknownKey.stderr).toContain('theme|density|fontSize|motion|timeDisplay');
      const unknownGet = await cli(['settings', 'ui', 'get', 'colourScheme'], environment);
      expect(unknownGet.exitCode).toBe(2);

      const badValue = await cli(['settings', 'ui', 'set', 'theme', 'blue'], environment);
      expect(badValue.exitCode).toBe(2);
      expect(badValue.stderr).toContain('system|light|dark');
      // The right word for the wrong key is still wrong: values are not clamped across keys.
      expect((await cli(['settings', 'ui', 'set', 'motion', 'dark'], environment)).exitCode).toBe(2);
      expect((await cli(['settings', 'ui', 'set', 'density', 'reduced'], environment)).exitCode)
        .toBe(2);

      for (const argv of [['settings', 'ui', 'set', 'theme'], ['settings', 'ui', 'set'],
        ['settings', 'ui', 'get'], ['settings', 'ui', 'explain'], ['settings', 'ui', 'list', 'extra'],
        ['settings', 'ui', 'list', '--bogus'], ['settings', 'ui', 'reset', 'theme', 'density']]) {
        expect((await cli(argv, environment)).exitCode).toBe(2);
      }
      // A usage error writes nothing, prints no JSON on stdout, and leaves the file at defaults.
      expect(readdirSync(home).includes('ui-settings.json')).toBe(false);
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);

  test('keeps the value across a Runtime restart and reports a broken file instead of defaults',
    async () => {
      const { environment, home } = await fixture();
      try {
        expect((await cli(['settings', 'ui', 'set', 'theme', 'dark'], environment)).exitCode).toBe(0);
        expect((await cli(['settings', 'ui', 'set', 'timeDisplay', 'absolute'], environment)).exitCode)
          .toBe(0);
        const firstBoot = await bootId(environment);
        const stopped = await cli(['stop'], environment);
        expect(stopped.exitCode).toBe(0);

        // The next command starts a *different* Runtime: the value cannot be coming from a live
        // in-memory copy, so this is persistence in the Runtime home and nothing else.
        const after = await cli(['settings', 'ui', 'get', 'theme', '--json'], environment);
        expect(after.exitCode).toBe(0);
        expect(JSON.parse(after.stdout) as UiSettingEntryView).toMatchObject({ value: 'dark',
          explicit: true, source: 'RUNTIME' });
        expect(await bootId(environment)).not.toBe(firstBoot);
        expect(entry(await list(environment), 'timeDisplay')).toMatchObject({
          value: 'absolute', explicit: true });

        // A file the Runtime cannot understand is refused with a stable code — never reported as
        // defaults, and never silently rewritten.
        writeFileSync(settingsFile(home), '{"version":1,"settings":{"theme":"blue"}}');
        const refusedRead = await cli(['settings', 'ui', 'get', 'theme'], environment);
        expect(refusedRead.exitCode).toBe(1);
        expect(refusedRead.stderr).toContain('INVALID_UI_SETTING');
        const refusedWrite = await cli(['settings', 'ui', 'set', 'density', 'compact'], environment);
        expect(refusedWrite.exitCode).toBe(1);
        expect(refusedWrite.stderr).toContain('INVALID_UI_SETTING');
        expect(readFileSync(settingsFile(home), 'utf8'))
          .toBe('{"version":1,"settings":{"theme":"blue"}}');

        // `reset` is the documented way out: it rewrites the file and the defaults are back.
        const repaired = await cli(['settings', 'ui', 'reset', '--json'], environment);
        expect(repaired.exitCode).toBe(0);
        expect(entry(JSON.parse(repaired.stdout) as UiSettingsView, 'theme')).toMatchObject({
          value: 'system', explicit: false });
        expect((await cli(['settings', 'ui', 'get', 'theme'], environment)).exitCode).toBe(0);
      } finally {
        chmodSync(home, 0o700);
        await cli(['stop'], environment);
      }
    }, 120_000);

  test('the Web UI transport reads and writes the very same values and codes', async () => {
    const { environment, home } = await fixture();
    try {
      expect((await cli(['settings', 'ui', 'set', 'density', 'compact'], environment)).exitCode)
        .toBe(0);
      // The UI talks to /api/command with a per-Runtime bearer token. Driving that surface directly
      // is the browser-free half of "the UI is a front end to the same command face".
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

      const overHttp = await command({ command: 'settings.ui.list' });
      expect(overHttp.ok).toBe(true);
      // Byte-for-byte the same view the CLI printed: one command face, two transports.
      expect(JSON.stringify(overHttp.result)).toBe(JSON.stringify(await list(environment)));

      // A write from the UI transport is what the CLI reads next.
      expect((await command({ command: 'settings.ui.set', key: 'motion', value: 'reduced' })).ok)
        .toBe(true);
      const fromCli = await cli(['settings', 'ui', 'get', 'motion', '--json'], environment);
      expect(JSON.parse(fromCli.stdout) as UiSettingEntryView).toMatchObject({ value: 'reduced',
        explicit: true });

      // The request schema enumerates keys and values, so an unknown key or an unsupported value
      // never reaches the settings layer over a transport: the boundary answers 400 before dispatch.
      // That is the same reason the CLI can refuse both as usage errors without a Runtime at all. The
      // settings layer's own codes — UNKNOWN_UI_SETTING from a direct caller, INVALID_UI_SETTING for a
      // file that cannot be trusted — are asserted in ui-settings.test.ts and just below.
      const unknown = await command({ command: 'settings.ui.get', key: 'colourScheme' });
      expect(unknown.status).toBe(400);
      expect(unknown.ok).toBe(false);
      expect(unknown.errorCode).toBe('INVALID_REQUEST');
      const invalid = await command({ command: 'settings.ui.set', key: 'theme', value: 'blue' });
      expect(invalid.status).toBe(400);
      expect(invalid.errorCode).toBe('INVALID_REQUEST');

      // A file the Runtime cannot trust is reported to the UI with its own code (the page renders
      // exactly this) and repaired by an explicit reset, never by silently rewriting the file.
      writeFileSync(settingsFile(home), '{"version":9}');
      const unreadable = await command({ command: 'settings.ui.list' });
      expect(unreadable.ok).toBe(false);
      expect(unreadable.errorCode).toBe('INVALID_UI_SETTING');
      expect(readFileSync(settingsFile(home), 'utf8')).toBe('{"version":9}');
      expect((await command({ command: 'settings.ui.reset' })).ok).toBe(true);
      const repaired = await command({ command: 'settings.ui.list' });
      expect(repaired.ok).toBe(true);
      expect(entry(repaired.result as UiSettingsView, 'motion')).toMatchObject({ value: 'full',
        explicit: false });
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);
});
