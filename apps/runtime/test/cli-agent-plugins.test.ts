/**
 * CLI e2e for Agent plugin selection and read-only detection (FOUNDATION-071 / ADR-0044).
 *
 * Everything is driven through the real command face with a temporary `CODEESTRA_HOME` and a
 * temporary provider configuration directory (passed as `PI_CODING_AGENT_DIR`), so the test never
 * reads or writes the developer's own `~/.pi/agent` and never reaches the stable Runtime.
 *
 * The reclamation helper is used for every temporary directory and for stopping the Runtime this
 * test starts, including when an assertion fails before the test's own teardown.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => { await reclaimTestResources(); });

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

interface Candidate {
  readonly kind: string;
  readonly name: string;
  readonly path: string;
  readonly source: string;
  readonly providerEnabled: boolean | null;
  readonly selectable: boolean;
  readonly reason: string | null;
  readonly selected: boolean;
}

interface Detection {
  readonly adapterId: string;
  readonly pluginSelectionSupport: string;
  readonly providerConfigDirectory: string;
  readonly providerStateReadable: boolean;
  readonly candidates: readonly Candidate[];
  readonly selection: Record<string, readonly string[]> | null;
  readonly selectionSource: string | null;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  return await runCli(args, environment, { entry: cliEntry });
}

/** A fake provider user configuration directory with one loadable resource of each kind. */
function providerConfigDirectory(): { directory: string; skillPath: string; promptPath: string } {
  const directory = temporaryDirectory('codeestra-plugin-provider-');
  mkdirSync(join(directory, 'extensions'), { recursive: true });
  mkdirSync(join(directory, 'skills', 'cli-skill'), { recursive: true });
  mkdirSync(join(directory, 'prompts'), { recursive: true });
  mkdirSync(join(directory, 'themes'), { recursive: true });
  writeFileSync(join(directory, 'extensions', 'cli-extension.ts'), 'export default () => {};\n');
  writeFileSync(join(directory, 'extensions', 'not-an-extension.txt'), 'nope\n');
  writeFileSync(join(directory, 'skills', 'cli-skill', 'SKILL.md'),
    '---\nname: cli-skill\ndescription: cli probe\n---\nbody\n');
  writeFileSync(join(directory, 'prompts', 'cli-template.md'), '---\ndescription: cli\n---\nbody\n');
  writeFileSync(join(directory, 'themes', 'cli-theme.json'), '{"name":"cli-theme"}\n');
  writeFileSync(join(directory, 'settings.json'), '{"theme":"cli-theme"}\n');
  return {
    directory,
    skillPath: join(directory, 'skills', 'cli-skill'),
    promptPath: join(directory, 'prompts', 'cli-template.md'),
  };
}

function environmentFor(providerDirectory: string): Record<string, string> {
  return {
    CODEESTRA_HOME: temporaryDirectory('codeestra-plugin-home-'),
    // The controlled launch is irrelevant here (no Agent is started), but an absent Pi must never
    // make this test depend on the developer's installation for detection.
    CODEESTRA_PI_EXECUTABLE: 'pi-not-installed',
    PI_CODING_AGENT_DIR: providerDirectory,
  };
}

describe('CLI agent plugins', () => {
  test('lists candidates and the current selection, then writes and clears a selection', async () => {
    const provider = providerConfigDirectory();
    const environment = environmentFor(provider.directory);

    const empty = await cli(['agent', 'plugins', 'list', '--json'], environment);
    expect(empty.exitCode).toBe(0);
    const detection = JSON.parse(empty.stdout) as Detection;
    expect(detection.providerConfigDirectory).toBe(provider.directory);
    expect(detection.pluginSelectionSupport).toBe('SUPPORTED');
    expect(detection.selection).toBeNull();
    expect(detection.selectionSource).toBeNull();
    const names = detection.candidates.map((candidate) => candidate.name).sort();
    expect(names).toEqual(['cli-extension', 'cli-skill', 'cli-template', 'cli-theme',
      'not-an-extension.txt'].sort());
    expect(detection.candidates.find((candidate) => candidate.name === 'cli-skill'))
      .toMatchObject({ kind: 'skills', selectable: true, providerEnabled: true, selected: false });
    expect(detection.candidates.find((candidate) => candidate.name === 'not-an-extension.txt'))
      .toMatchObject({ selectable: false, reason: 'UNSUPPORTED_FILE_TYPE' });
    // The human-readable projection is the default; `--json` is the scriptable one.
    const human = await cli(['agent', 'plugins', 'list'], environment);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('cli-skill');

    // `--clear` on an empty selection is a no-op rather than an error: the command is idempotent.
    const clearedFirst = await cli(['agent', 'plugins', 'select', '--clear', '--json'], environment);
    expect(clearedFirst.exitCode).toBe(0);

    const selected = await cli(['agent', 'plugins', 'select',
      '--extension', join(provider.directory, 'extensions', 'cli-extension.ts'),
      '--skill', provider.skillPath,
      '--prompt-template', provider.promptPath,
      '--json'], environment);
    expect(selected.exitCode).toBe(0);
    const view = JSON.parse(selected.stdout) as {
      pluginSelection: Record<string, readonly string[]> | null;
      pluginSelectionSource: string | null;
      thirdPartyExtensionApprovalRisk: boolean;
    };
    expect(view.pluginSelectionSource).toBe('GLOBAL');
    expect(view.thirdPartyExtensionApprovalRisk).toBe(true);
    expect(view.pluginSelection?.['skills']).toEqual([provider.skillPath]);
    expect(view.pluginSelection?.['themes']).toEqual([]);

    // Repeating the identical command is idempotent: same selection, same layer, still exit 0.
    const repeated = await cli(['agent', 'plugins', 'select',
      '--extension', join(provider.directory, 'extensions', 'cli-extension.ts'),
      '--skill', provider.skillPath,
      '--prompt-template', provider.promptPath,
      '--json'], environment);
    expect(repeated.exitCode).toBe(0);
    // Idempotent in what it decides: the same selection at the same layer, and the model fields
    // untouched. `updatedAt` is the one field that legitimately moves, because a write is a write.
    const repeatedView = JSON.parse(repeated.stdout) as {
      pluginSelection: unknown; pluginSelectionSource: unknown;
      thirdPartyExtensionApprovalRisk: unknown;
    };
    expect(repeatedView.pluginSelection).toEqual(view.pluginSelection);
    expect(repeatedView.pluginSelectionSource).toEqual(view.pluginSelectionSource);
    expect(repeatedView.thirdPartyExtensionApprovalRisk).toEqual(view.thirdPartyExtensionApprovalRisk);

    // The detection read now reports the selection state per candidate.
    const afterSelection = await cli(['agent', 'plugins', 'list', '--json'], environment);
    const selectedDetection = JSON.parse(afterSelection.stdout) as Detection;
    expect(selectedDetection.selectionSource).toBe('GLOBAL');
    expect(selectedDetection.candidates.filter((candidate) => candidate.selected)
      .map((candidate) => candidate.name).sort()).toEqual(['cli-extension', 'cli-skill', 'cli-template']);

    // Clearing removes the selection from the scope entirely.
    const cleared = await cli(['agent', 'plugins', 'select', '--clear', '--json'], environment);
    expect(cleared.exitCode).toBe(0);
    expect((JSON.parse(cleared.stdout) as { pluginSelection: unknown }).pluginSelection).toBeNull();
  });

  test('refuses an unusable path and an adapter without plugin selection, writing nothing', async () => {
    const provider = providerConfigDirectory();
    const environment = environmentFor(provider.directory);

    const missing = await cli(['agent', 'plugins', 'select', '--skill',
      join(provider.directory, 'skills', 'does-not-exist'), '--json'], environment);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('AGENT_PLUGIN_UNAVAILABLE');

    const wrongType = await cli(['agent', 'plugins', 'select', '--skill',
      join(provider.directory, 'extensions', 'not-an-extension.txt'), '--json'], environment);
    expect(wrongType.exitCode).toBe(1);
    expect(wrongType.stderr).toContain('AGENT_PLUGIN_UNAVAILABLE');
    expect(wrongType.stderr).toContain('nothing was written');

    // Nothing was written by either refusal, and a relative path never reaches the Runtime at all.
    const after = await cli(['agent', 'plugins', 'list', '--json'], environment);
    expect((JSON.parse(after.stdout) as Detection).selection).toBeNull();
    const relative = await cli(['agent', 'plugins', 'select', '--skill', 'relative/path'],
      environment);
    expect(relative.exitCode).toBe(1);
    expect(relative.stderr).toContain('INVALID_AGENT_PLUGIN_SELECTION');

    // Codex declares no plugin selection, so the request is refused instead of stored and ignored.
    const codex = await cli(['agent', 'plugins', 'select', '--adapter', 'codex', '--skill',
      provider.skillPath, '--json'], environment);
    expect(codex.exitCode).toBe(1);
    expect(codex.stderr).toContain('AGENT_PLUGIN_KIND_UNSUPPORTED');
  });
});
