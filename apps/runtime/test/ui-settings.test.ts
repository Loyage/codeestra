import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UiSettingsError,
  inspectUiSettings,
  resetUiSettings,
  setUiSetting,
  uiSettingsPath,
} from '../src/ui-settings.js';

/**
 * The interface-effect settings file (FOUNDATION-073 / ADR-0045), at the module level.
 *
 * This file drives the storage half only — no Runtime, no browser, no CLI. It pins the three
 * properties the feature's honesty rests on: an unreadable file is reported rather than repaired,
 * a value is never clamped to a neighbouring one, and a write replaces the file atomically with
 * user-only permissions. The command face (exit codes, `--json`, persistence across a restart) is
 * covered separately by `cli-ui-settings.test.ts`.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

function home(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-ui-settings-'));
  chmodSync(directory, 0o700);
  directories.push(directory);
  return directory;
}

function entry(view: ReturnType<typeof inspectUiSettings>, key: string) {
  const found = view.settings.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`${key} was not reported`);
  return found;
}

/** Runs a refusal and returns its stable code, failing loudly if it was not refused at all. */
function refusal(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof UiSettingsError) return error.code;
    throw error;
  }
  throw new Error('the call was expected to be refused, but it succeeded');
}

/** Turns off the write bit on a directory, reporting whether the filesystem then refuses writes. */
function makeUnwritable(directory: string): boolean {
  chmodSync(directory, 0o500);
  try {
    writeFileSync(join(directory, '.probe'), 'x');
  } catch {
    return true;
  }
  rmSync(join(directory, '.probe'), { force: true });
  chmodSync(directory, 0o700);
  return false;
}

describe('interface-effect settings storage', () => {
  test('reports the product default for every key when no file exists', () => {
    const directory = home();
    const view = inspectUiSettings(directory);
    expect(view.store).toBe('RUNTIME_FILE');
    expect(view.file).toBe(uiSettingsPath(directory));
    expect(view.settings.map((setting) => [setting.key, setting.value, setting.source,
      setting.explicit])).toEqual([
      ['theme', 'system', 'PRODUCT_DEFAULT', false],
      ['density', 'comfortable', 'PRODUCT_DEFAULT', false],
      ['fontSize', 'medium', 'PRODUCT_DEFAULT', false],
      ['motion', 'full', 'PRODUCT_DEFAULT', false],
      ['timeDisplay', 'relative', 'PRODUCT_DEFAULT', false],
    ]);
    // The values each key accepts travel with the report, so no client re-declares them.
    expect(entry(view, 'theme')).toMatchObject({ default: 'system', values: ['system', 'light', 'dark'] });
    expect(entry(view, 'timeDisplay')).toMatchObject({ values: ['relative', 'absolute'] });
    // Nothing was created just by reading.
    expect(readdirSync(directory)).toEqual([]);
  });

  test('records one explicit value and leaves the other keys at their defaults', () => {
    const directory = home();
    const view = setUiSetting(directory, 'fontSize', 'large');
    expect(entry(view, 'fontSize')).toMatchObject({ value: 'large', default: 'medium',
      explicit: true, source: 'RUNTIME' });
    expect(entry(view, 'theme')).toMatchObject({ value: 'system', explicit: false,
      source: 'PRODUCT_DEFAULT' });
    expect(JSON.parse(readFileSync(uiSettingsPath(directory), 'utf8'))).toEqual({
      version: 1, settings: { fontSize: 'large' },
    });
    expect(statSync(uiSettingsPath(directory)).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  test('is idempotent and keeps the last write', () => {
    const directory = home();
    setUiSetting(directory, 'theme', 'dark');
    const second = setUiSetting(directory, 'theme', 'dark');
    expect(entry(second, 'theme')).toMatchObject({ value: 'dark', explicit: true });
    expect(JSON.parse(readFileSync(uiSettingsPath(directory), 'utf8')).settings).toEqual({
      theme: 'dark',
    });
    expect(entry(setUiSetting(directory, 'theme', 'light'), 'theme').value).toBe('light');
  });

  test('reads the file rather than a cached copy, so an outside edit is honoured', () => {
    const directory = home();
    setUiSetting(directory, 'motion', 'reduced');
    writeFileSync(uiSettingsPath(directory),
      `${JSON.stringify({ version: 1, settings: { motion: 'full' } })}\n`);
    expect(entry(inspectUiSettings(directory), 'motion').value).toBe('full');
    // A file that disappears is "no explicit choice", not an error.
    rmSync(uiSettingsPath(directory));
    expect(entry(inspectUiSettings(directory), 'motion')).toMatchObject({ value: 'full',
      explicit: false, source: 'PRODUCT_DEFAULT' });
  });

  test('refuses an unknown key and an unsupported value with stable codes', () => {
    const directory = home();
    expect(refusal(() => setUiSetting(directory, 'colourScheme', 'dark'))).toBe('UNKNOWN_UI_SETTING');
    for (const [key, value] of [['theme', 'blue'], ['density', 'roomy'], ['fontSize', 'huge'],
      ['motion', 'off'], ['timeDisplay', 'auto']] as const) {
      expect(refusal(() => setUiSetting(directory, key, value))).toBe('INVALID_UI_SETTING');
    }
    // A refusal writes nothing at all.
    expect(readdirSync(directory)).toEqual([]);
  });

  test('fails closed on a file it cannot trust instead of reporting defaults', () => {
    const directory = home();
    const broken = [
      'not json at all',
      '{"version":2,"settings":{"theme":"dark"}}',
      '{"version":1,"settings":{"theme":"dark"},"extra":true}',
      '{"version":1,"settings":{"unknownKey":"dark"}}',
      '{"version":1,"settings":{"theme":"blue"}}',
      '{"version":1}',
      '{}',
      '{"version":1,"settings":{"theme":"dark"}} trailing',
    ];
    for (const content of broken) {
      writeFileSync(uiSettingsPath(directory), content);
      expect(refusal(() => inspectUiSettings(directory))).toBe('INVALID_UI_SETTING');
      // Writing is refused too: merging would mean discarding the parts we did not understand.
      expect(refusal(() => setUiSetting(directory, 'density', 'compact'))).toBe('INVALID_UI_SETTING');
      expect(readFileSync(uiSettingsPath(directory), 'utf8')).toBe(content);
    }
    // An unreadable path (here: a directory wearing the file's name) is refused the same way.
    rmSync(uiSettingsPath(directory), { force: true });
    mkdirSync(uiSettingsPath(directory));
    expect(refusal(() => inspectUiSettings(directory))).toBe('INVALID_UI_SETTING');
    rmSync(uiSettingsPath(directory), { recursive: true, force: true });
  });

  test('reset drops one explicit choice, or all of them, and repairs a broken file', () => {
    const directory = home();
    setUiSetting(directory, 'theme', 'dark');
    setUiSetting(directory, 'density', 'compact');
    const single = resetUiSettings(directory, 'theme');
    expect(entry(single, 'theme')).toMatchObject({ value: 'system', explicit: false,
      source: 'PRODUCT_DEFAULT' });
    expect(entry(single, 'density')).toMatchObject({ value: 'compact', explicit: true });
    expect(JSON.parse(readFileSync(uiSettingsPath(directory), 'utf8')).settings).toEqual({
      density: 'compact',
    });

    // Resetting one key on a broken file is refused (it would need the rest of the file) …
    writeFileSync(uiSettingsPath(directory), '{"version":1,"settings":{"density":"roomy"}}');
    expect(refusal(() => resetUiSettings(directory, 'theme'))).toBe('INVALID_UI_SETTING');
    // … while resetting everything is the documented recovery: it never reads the file.
    const all = resetUiSettings(directory);
    expect(all.settings.every((setting) => setting.explicit === false)).toBe(true);
    expect(JSON.parse(readFileSync(uiSettingsPath(directory), 'utf8'))).toEqual({
      version: 1, settings: {},
    });
    expect(refusal(() => resetUiSettings(directory, 'colourScheme'))).toBe('UNKNOWN_UI_SETTING');
  });

  test('replaces the file atomically: no temp leftovers, and a failed write changes nothing', () => {
    const directory = home();
    setUiSetting(directory, 'theme', 'dark');
    setUiSetting(directory, 'timeDisplay', 'absolute');
    // The successful path leaves exactly the target file behind, never a half-written sibling.
    expect(readdirSync(directory)).toEqual(['ui-settings.json']);
    const before = readFileSync(uiSettingsPath(directory), 'utf8');

    if (!makeUnwritable(directory)) {
      // Reported rather than silently treated as a pass: on a filesystem that ignores directory
      // write permissions (a root-owned container) this half of the test cannot run.
      console.error('[ui-settings] the write-failure half was not exercised: the filesystem still'
        + ' accepted a write into a directory without its write bit');
      chmodSync(directory, 0o700);
      return;
    }
    try {
      expect(refusal(() => setUiSetting(directory, 'theme', 'light'))).toBe('UI_SETTINGS_WRITE_FAILED');
      // No half-written target and no orphaned temp file: the previous file is exactly as it was.
      chmodSync(directory, 0o700);
      expect(readFileSync(uiSettingsPath(directory), 'utf8')).toBe(before);
      expect(readdirSync(directory)).toEqual(['ui-settings.json']);
      expect(entry(inspectUiSettings(directory), 'theme')).toMatchObject({ value: 'dark',
        explicit: true });
    } finally {
      chmodSync(directory, 0o700);
    }
  });
});
