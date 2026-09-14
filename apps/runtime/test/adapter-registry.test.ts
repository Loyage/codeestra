import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapterRegistry } from '../src/adapter-registry.js';
import { cleanupTemporaryDirectories, registerTemporaryDirectory } from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

/**
 * The production registry must hand the real environment to the Adapter that spawns the provider.
 * With an empty environment there is no PATH, and `pi` cannot be launched at all — a failure that
 * only appears when the Runtime is actually wired up, not when the Adapter is constructed directly.
 */
describe('production Pi adapter registry', () => {
  test('passes the environment through so the provider executable is resolvable', async () => {
    const bin = temporaryDirectory('codeestra-pi-bin-');
    const home = temporaryDirectory('codeestra-pi-home-');
    const executable = join(bin, 'fake-pi');
    // A stand-in provider: probe() only runs `--version` through PATH resolution.
    await Bun.write(executable, '#!/bin/sh\necho 0.84.4\n');
    chmodSync(executable, 0o755);

    const registry = createAdapterRegistry({
      runtimeHome: home,
      environment: { PATH: bin, CODEESTRA_PI_EXECUTABLE: 'fake-pi' },
    });
    await expect(registry.resolve('pi').probe()).resolves.toMatchObject({ version: '0.84.4' });
  });

  test('an unresolvable provider is reported instead of pretending success', async () => {
    const bin = temporaryDirectory('codeestra-pi-empty-');
    const home = temporaryDirectory('codeestra-pi-home-');
    const registry = createAdapterRegistry({
      runtimeHome: home,
      environment: { PATH: bin, CODEESTRA_PI_EXECUTABLE: 'definitely-missing-pi' },
    });
    await expect(registry.resolve('pi').probe()).rejects.toMatchObject({
      code: 'PROVIDER_VERSION_UNAVAILABLE',
    });
  });

  test('does not bake the environment model into the process argv', async () => {
    // Model selection is resolved per Execution from the persisted scopes and the environment, so
    // the registry must not pin it at process start; otherwise changing it would require a
    // Runtime restart and the Execution record could disagree with what was actually launched.
    const bin = temporaryDirectory('codeestra-pi-bin-');
    const home = temporaryDirectory('codeestra-pi-home-');
    const executable = join(bin, 'fake-pi');
    const reportPath = join(bin, 'argv.json');
    await Bun.write(executable, `#!/bin/sh
echo "$@" > ${reportPath}
echo 0.84.4
`);
    chmodSync(executable, 0o755);
    const registry = createAdapterRegistry({
      runtimeHome: home,
      environment: {
        PATH: bin, CODEESTRA_PI_EXECUTABLE: 'fake-pi',
        CODEESTRA_PI_PROVIDER: 'github-copilot', CODEESTRA_PI_MODEL: 'gpt-5.6-luna',
      },
    });
    await registry.resolve('pi').probe();
    expect((await Bun.file(reportPath).text()).trim()).toBe('--version');
  });

  test('registers exactly one adapter instance and rejects unknown IDs', () => {
    const home = temporaryDirectory('codeestra-pi-home-');
    const registry = createAdapterRegistry({ runtimeHome: home, environment: {} });
    expect(registry.ids()).toEqual(['pi', 'codex']);
    expect(() => registry.resolve('claude-code'))
      .toThrow('No Agent Adapter is registered for claude-code');
  });
});
