import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultPermissionMode,
  permissionModePath,
  readPermissionMode,
  writePermissionMode,
} from '../src/permission-mode.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function home(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-permission-mode-'));
  directories.push(directory);
  return directory;
}

describe('permission mode configuration', () => {
  test('defaults to full permissions when no setting exists', async () => {
    expect(defaultPermissionMode).toBe('FULL');
    expect(await readPermissionMode(home())).toBe('FULL');
  });

  test('persists a strict opt-in atomically with user-only permissions', async () => {
    const directory = home();
    writePermissionMode(directory, 'STRICT');
    expect(await readPermissionMode(directory)).toBe('STRICT');
    expect(JSON.parse(readFileSync(permissionModePath(directory), 'utf8'))).toEqual({
      version: 1,
      mode: 'STRICT',
    });
    expect(statSync(permissionModePath(directory)).mode & 0o777).toBe(0o600);
  });

  test('refuses malformed persisted values instead of silently changing modes', async () => {
    const directory = home();
    await Bun.write(permissionModePath(directory), '{"version":1,"mode":"UNKNOWN"}\n');
    await expect(readPermissionMode(directory)).rejects.toThrow('INVALID_PERMISSION_MODE');
  });
});
