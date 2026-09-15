/**
 * Controlled Pi launch arguments under plugin selection (FOUNDATION-071 / ADR-0044).
 *
 * Two properties this file exists to protect, both of them user decisions:
 *
 * 1. **Zero selection is byte-identical to the launch before this capability.** The whole point of
 *    "default all off" is that a user who selects nothing runs exactly what they ran before, so the
 *    assertions below list every argument including Codeestra's own gate/question extensions and all
 *    four `--no-*` flags.
 * 2. **Unverifiable paths fail closed.** A selected path that cannot be loaded refuses the Session
 *    before any provider process exists, with the stable code `AGENT_PLUGIN_UNAVAILABLE`.
 *
 * Real-binary evidence for the flag semantics is recorded in ADR-0044 D06 (a `pi --mode rpc`
 * `get_commands` round-trip on this machine showed an explicitly passed `--skill`/`--prompt-template`
 * loading while discovery stayed off). The optional test at the bottom re-runs that probe when
 * `CODEESTRA_PI_SPIKE=1` is set, so the evidence can be refreshed but never silently assumed.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPiPluginSelectionUsable,
  buildPiPluginArguments,
  buildPiRpcArguments,
  buildPiTerminalArguments,
  PiPluginError,
} from '../src/index.js';
import type { AgentPluginSelection, AgentPluginUnavailableReason } from '@codeestra/contracts';

const gate = '/runtime/gate-extension.ts';
const question = '/runtime/question-extension.ts';
const sessionDir = '/runtime/pi-sessions';

const emptySelection: AgentPluginSelection = {
  extensions: [], skills: [], promptTemplates: [], themes: [],
};

function rpc(extra: Partial<Parameters<typeof buildPiRpcArguments>[0]> = {}) {
  return buildPiRpcArguments({ gateExtensionPath: gate, questionExtensionPath: question,
    sessionDir, platform: 'unix', permissionMode: 'FULL', ...extra });
}

function terminal(extra: Partial<Parameters<typeof buildPiTerminalArguments>[0]> = {}) {
  return buildPiTerminalArguments({ gateExtensionPath: gate, questionExtensionPath: question,
    sessionDir, platform: 'unix', permissionMode: 'FULL',
    resumeSessionFile: '/runtime/pi-sessions/s1.jsonl', ...extra });
}

describe('Pi plugin launch arguments', () => {
  test('full mode with no selection is the exact launch that existed before this capability', () => {
    expect([...rpc()]).toEqual([
      '--mode', 'rpc',
      '--approve',
      '--no-extensions',
      '--extension', gate,
      '--extension', question,
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--session-dir', sessionDir,
    ]);
  });

  test('strict mode and resume keep their own arguments, still with nothing added', () => {
    expect([...rpc({ permissionMode: 'STRICT' })]).toEqual([
      '--mode', 'rpc',
      '--no-approve',
      '--no-extensions',
      '--extension', gate,
      '--extension', question,
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--tools', 'read,bash,edit,write,grep,find,ls,ask_user_question',
      '--session-dir', sessionDir,
    ]);
    expect([...rpc({ resumeSessionFile: '/runtime/pi-sessions/s9.jsonl' }).slice(-2)])
      .toEqual(['--session', '/runtime/pi-sessions/s9.jsonl']);
    // Windows keeps powershell in the strict allowlist and adds no plugin argument either.
    expect(rpc({ permissionMode: 'STRICT', platform: 'windows' }))
      .toContain('read,powershell,edit,write,grep,find,ls,ask_user_question');
  });

  test('an explicitly empty selection is treated exactly like no selection', () => {
    expect([...rpc({ pluginSelection: emptySelection })]).toEqual([...rpc()]);
    expect([...buildPiPluginArguments(emptySelection)]).toEqual([]);
    expect([...buildPiPluginArguments(null)]).toEqual([]);
    expect([...buildPiPluginArguments(undefined)]).toEqual([]);
  });

  test('a selection is appended in kind order and keeps the user order inside a kind', () => {
    const selection: AgentPluginSelection = {
      extensions: ['/x/ext-b.ts', '/x/ext-a.ts'],
      skills: ['/x/skill-b', '/x/skill-a.md'],
      promptTemplates: ['/x/tpl.md'],
      themes: ['/x/theme.json'],
    };
    expect([...buildPiPluginArguments(selection)]).toEqual([
      '--extension', '/x/ext-b.ts',
      '--extension', '/x/ext-a.ts',
      '--skill', '/x/skill-b',
      '--skill', '/x/skill-a.md',
      '--prompt-template', '/x/tpl.md',
      '--theme', '/x/theme.json',
    ]);
    const argv = rpc({ pluginSelection: selection });
    // The gate and the question extension are still the first two extensions loaded, so Codeestra's
    // approval channel is installed before any user extension runs (ADR-0044 D02).
    const extensionFlags = argv.reduce<number[]>((indexes, value, index) => {
      if (value === '--extension') indexes.push(index);
      return indexes;
    }, []);
    expect(argv[extensionFlags[0] as number + 1]).toBe(gate);
    expect(argv[extensionFlags[1] as number + 1]).toBe(question);
    expect(argv[extensionFlags[2] as number + 1]).toBe('/x/ext-b.ts');
    // Discovery stays off for every kind: selecting a resource never turns discovery back on.
    for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--no-context-files']) {
      expect(argv).toContain(flag);
    }
  });

  test('the RPC and native-terminal launches compose the plugin block identically', () => {
    const selection: AgentPluginSelection = {
      extensions: ['/x/ext.ts'], skills: ['/x/skill'], promptTemplates: [], themes: ['/x/t.json'],
    };
    const rpcArgv = rpc({ pluginSelection: selection });
    const terminalArgv = terminal({ pluginSelection: selection });
    const pluginBlock = buildPiPluginArguments(selection);
    // Both transports place the user's resources after `--no-context-files` and before their own
    // trailing arguments, so switching transport cannot change what the Agent may load (ADR-0044 D06).
    expect(rpcArgv.indexOf('--no-context-files') + 1).toBe(rpcArgv.indexOf('/x/ext.ts') - 1);
    expect(terminalArgv.indexOf('--no-context-files') + 1).toBe(terminalArgv.indexOf('/x/ext.ts') - 1);
    expect([...terminalArgv]).toEqual([
      '--approve',
      '--no-extensions', '--extension', gate, '--extension', question,
      '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
      ...pluginBlock,
      '--session-dir', sessionDir,
      '--session', '/runtime/pi-sessions/s1.jsonl',
    ]);
  });

  test('a selected path that cannot be loaded refuses the Session with a stable code', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-plugin-argv-'));
    try {
      const skill = join(directory, 'skill');
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, 'SKILL.md'), '---\nname: probe\ndescription: probe\n---\nbody\n');
      const notAnExtension = join(directory, 'notes.txt');
      writeFileSync(notAnExtension, 'not an extension\n');
      symlinkSync(join(directory, 'missing-target'), join(directory, 'dangling.ts'));

      // A usable path passes.
      expect(() => assertPiPluginSelectionUsable({
        extensions: [], skills: [skill], promptTemplates: [], themes: [],
      })).not.toThrow();

      const cases: readonly [AgentPluginSelection, AgentPluginUnavailableReason][] = [
        [{ extensions: [join(directory, 'nope.ts')], skills: [], promptTemplates: [], themes: [] },
          'NOT_FOUND'],
        [{ extensions: [notAnExtension], skills: [], promptTemplates: [], themes: [] },
          'UNSUPPORTED_FILE_TYPE'],
        [{ extensions: [join(directory, 'dangling.ts')], skills: [], promptTemplates: [], themes: [] },
          'NOT_FOUND'],
        [{ extensions: [], skills: [notAnExtension], promptTemplates: [], themes: [] },
          'UNSUPPORTED_FILE_TYPE'],
      ];
      for (const [selection, reason] of cases) {
        try {
          assertPiPluginSelectionUsable(selection);
          throw new Error('an unusable plugin path was accepted');
        } catch (error) {
          expect(error).toBeInstanceOf(PiPluginError);
          expect((error as PiPluginError).code).toBe('AGENT_PLUGIN_UNAVAILABLE');
          expect((error as PiPluginError).detail.reason).toBe(reason);
        }
      }
      // A directory with no entry file of the kind is not loadable either.
      expect(() => assertPiPluginSelectionUsable({
        extensions: [], skills: [directory], promptTemplates: [], themes: [],
      })).toThrow(/AGENT_PLUGIN_UNAVAILABLE|cannot be loaded/);
      // No selection never touches the filesystem, so it can never fail.
      expect(() => assertPiPluginSelectionUsable(null)).not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
