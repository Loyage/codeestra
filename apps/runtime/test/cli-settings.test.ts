import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTemporaryDirectories, registerTemporaryDirectory } from './support/agent-fixture.js';
import { reclaimTestResources, runCli } from './support/runtime-reclamation.js';

/**
 * The settings face through the real command face (ADR-0064).
 *
 * Two things changed and both are asserted from outside the product: the permission mode is now a
 * setting (`settings permission get|set`, with no top-level `permission` command left), and
 * `settings list` answers "which settings exist and what are they set to" from the Runtime itself.
 *
 * The point of the list is that it cannot disagree with the dedicated commands, so every test here
 * compares the aggregate against `settings permission get`, `settings prose-question-attention`
 * and `scheduler capacity get` rather than against a second expectation
 * written by hand. Everything is driven through a real CLI process against a real Runtime in a
 * temporary `CODEESTRA_HOME` — no browser, no desktop automation (ADR-0008).
 */

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

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

interface SettingEntryView {
  readonly key: string;
  readonly value: string | number;
  readonly default: string | number;
  readonly values: readonly string[] | null;
  readonly range: { readonly min: number; readonly max: number } | null;
  readonly explicit: boolean;
  readonly source: string;
  readonly store: string;
  readonly file: string | null;
  readonly appliesTo: string;
}

interface SettingsListView {
  readonly home: string;
  readonly appliesTo: string;
  readonly settings: readonly SettingEntryView[];
}

async function fixture(): Promise<{ readonly environment: Record<string, string>;
  readonly home: string }> {
  const home = temporaryDirectory('ce-settings-home-');
  return { environment: { CODEESTRA_HOME: home }, home };
}

/** The settings file a value must be in for the Runtime to read it after a restart. */
function permissionFile(home: string): string {
  return join(home, 'permission-mode.json');
}

function entry(view: SettingsListView, key: string): SettingEntryView {
  const found = view.settings.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`${key} was not reported`);
  return found;
}

async function list(environment: Record<string, string>): Promise<SettingsListView> {
  const listed = await cli(['settings', 'list', '--json'], environment);
  expect(listed.exitCode).toBe(0);
  return JSON.parse(listed.stdout) as SettingsListView;
}

async function bootId(environment: Record<string, string>): Promise<string> {
  const status = await cli(['status'], environment);
  expect(status.exitCode).toBe(0);
  return (JSON.parse(status.stdout) as { readonly bootId: string }).bootId;
}

describe('codeestra settings', () => {
  test('lists every setting with its product default and creates nothing on a read', async () => {
    const { environment, home } = await fixture();
    try {
      const view = await list(environment);
      expect(view.home).toBe(home);
      // Every setting this Runtime home has, each with the default in force before anything is set.
      expect(view.settings.map((setting) => [setting.key, setting.value, setting.default,
        setting.source, setting.explicit])).toEqual([
        ['permission.mode', 'FULL', 'FULL', 'PRODUCT_DEFAULT', false],
        ['attention.proseQuestion', 'auto', 'auto', 'PRODUCT_DEFAULT', false],
        ['capacity.globalLimit', 2, 2, 'PRODUCT_DEFAULT', false],
      ]);
      // A closed word set carries its values; a number carries its range. Exactly one, never both.
      expect(entry(view, 'permission.mode')).toMatchObject({
        values: ['FULL', 'STRICT'], range: null, store: 'RUNTIME_FILE',
        file: permissionFile(home) });
      expect(entry(view, 'capacity.globalLimit')).toMatchObject({
        values: null, range: { min: 1, max: 16 }, store: 'RUNTIME_DATABASE', file: null });
      // Each entry says what a change to it applies to, so the list needs no second explanation.
      for (const setting of view.settings) expect(setting.appliesTo.length).toBeGreaterThan(0);

      // A read invents no settings file: "no explicit choice" stays visible as such.
      for (const name of ['permission-mode.json', 'prose-question-attention.json']) {
        expect(existsSync(join(home, name))).toBe(false);
      }

      // The default rendering is a human list; `--json` prints the Runtime's payload verbatim.
      const human = await cli(['settings', 'list'], environment);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain('permission.mode');
      expect(human.stdout).toContain('capacity.globalLimit');
      expect(human.stdout).toContain('FULL');
      expect(human.stdout.trimStart().startsWith('{')).toBe(false);

      for (const argv of [['settings', 'list', 'extra'], ['settings', 'list', '--bogus'],
        ['settings', 'list', '--json', '--json']]) {
        expect((await cli(argv, environment)).exitCode).toBe(2);
      }
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);

  test('reads and writes the permission mode as one setting, with no confirmation', async () => {
    const { environment, home } = await fixture();
    try {
      const before = await cli(['settings', 'permission', 'get', '--json'], environment);
      expect(before.exitCode).toBe(0);
      expect(JSON.parse(before.stdout)).toMatchObject({ mode: 'FULL', default: 'FULL' });

      const written = await cli(['settings', 'permission', 'set', 'strict', '--json'], environment);
      expect(written.exitCode).toBe(0);
      expect(JSON.parse(written.stdout)).toMatchObject({ mode: 'STRICT' });

      // The mode is in the Runtime home, in a versioned file only this user can read.
      expect(JSON.parse(readFileSync(permissionFile(home), 'utf8')))
        .toEqual({ version: 1, mode: 'STRICT' });
      expect(statSync(permissionFile(home)).mode & 0o777).toBe(0o600);
      expect(JSON.parse((await cli(['settings', 'permission', 'get'], environment)).stdout))
        .toMatchObject({ mode: 'STRICT' });

      // The list reports the same value its own command reports, and marks it as this home's choice.
      expect(entry(await list(environment), 'permission.mode')).toMatchObject({
        value: 'STRICT', default: 'FULL', explicit: true, source: 'RUNTIME' });

      // `full` is accepted case-insensitively, as it always was.
      expect((await cli(['settings', 'permission', 'set', 'FULL'], environment)).exitCode).toBe(0);
      expect(entry(await list(environment), 'permission.mode')).toMatchObject({ value: 'FULL' });

      // The old spelling is gone: the mode has exactly one place in the command face now.
      for (const argv of [['permission', 'get'], ['permission', 'set', 'strict'],
        ['settings', 'permission'], ['settings', 'permission', 'set'],
        ['settings', 'permission', 'set', 'maybe'], ['settings', 'permission', 'get', 'extra'],
        ['settings', 'permission', 'explain'], ['settings', 'permission', 'set', 'strict', '--bogus']]) {
        const refused = await cli(argv, environment);
        expect(refused.exitCode).toBe(2);
        expect(refused.stdout).toBe('');
      }
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);

  test('agrees with every dedicated command, and the aggregate survives a restart', async () => {
    const { environment } = await fixture();
    try {
      expect((await cli(['settings', 'permission', 'set', 'strict'], environment)).exitCode).toBe(0);
      expect((await cli(['settings', 'prose-question-attention', 'record-only'], environment))
        .exitCode).toBe(0);
      expect((await cli(['settings', 'concurrency', 'set', '--limit', '3'], environment)).exitCode)
        .toBe(0);

      const view = await list(environment);
      expect(entry(view, 'attention.proseQuestion')).toMatchObject({ value: 'record-only',
        explicit: true, source: 'RUNTIME' });
      expect(entry(view, 'capacity.globalLimit')).toMatchObject({ value: 3, default: 2,
        explicit: true, source: 'RUNTIME' });

      // The aggregate is only useful if it *is* the same fact: compare with the commands that own
      // each value instead of with a hand-written expectation.
      const permission = JSON.parse((await cli(['settings', 'permission', 'get'], environment))
        .stdout) as { readonly mode: string };
      const attention = JSON.parse((await cli(['settings', 'prose-question-attention'], environment))
        .stdout) as { readonly mode: string };
      const capacity = JSON.parse((await cli(['scheduler', 'capacity', 'get'], environment)).stdout) as { readonly limit: number };
      expect(entry(view, 'permission.mode').value).toBe(permission.mode);
      expect(entry(view, 'attention.proseQuestion').value).toBe(attention.mode);
      expect(entry(view, 'capacity.globalLimit').value).toBe(capacity.limit);

      // A restart reads the recorded choices again: the values cannot be coming from an in-memory
      // copy, and "explicitly set" is decided by what this home stores, not by what it equals.
      const firstBoot = await bootId(environment);
      expect((await cli(['stop'], environment)).exitCode).toBe(0);
      const afterRestart = await list(environment);
      expect(await bootId(environment)).not.toBe(firstBoot);
      expect(entry(afterRestart, 'permission.mode')).toMatchObject({ value: 'STRICT',
        explicit: true, source: 'RUNTIME' });
      expect(entry(afterRestart, 'attention.proseQuestion')).toMatchObject({ value: 'record-only',
        explicit: true, source: 'RUNTIME' });
      expect(entry(afterRestart, 'capacity.globalLimit')).toMatchObject({ value: 3, explicit: true });

      // A value equal to the default that this home explicitly recorded is still reported as set:
      // "you chose full" and "FULL is the default" are different facts.
      expect((await cli(['settings', 'permission', 'set', 'full'], environment)).exitCode).toBe(0);
      expect(entry(await list(environment), 'permission.mode')).toMatchObject({
        value: 'FULL', explicit: true, source: 'RUNTIME' });
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);
});
