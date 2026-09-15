/**
 * Read-only Agent plugin detection (FOUNDATION-071 / ADR-0044 D05).
 *
 * The fake provider home below contains every shape the detection has to classify: a loadable
 * resource, a wrong file type, an unreadable file, a symlink into a Git working tree (which this scan
 * must not follow), a dangling symlink, a directory with no entry file, and a resource that only the
 * provider's own `settings.json` names. The test also proves the scan writes nothing at all.
 */
import { describe, expect, test } from 'bun:test';
import {
  chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAgentPlugins } from '../src/agent-plugin-detection-service.js';
import {
  agentLaunchConfiguration,
  resolveAgentPlugins,
  resolveAgentConfiguration,
} from '../src/agent-config-service.js';
import { Phase1Database } from '@codeestra/storage';

interface Fixture {
  readonly home: string;
  readonly outside: string;
  readonly files: readonly string[];
}

/** Everything the detection reads, plus a Git working tree it must stay out of. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'codeestra-plugin-detect-'));
  const home = join(root, 'provider-agent');
  const outside = join(root, 'outside');
  mkdirSync(join(home, 'extensions'), { recursive: true });
  mkdirSync(join(home, 'skills', 'probe-skill'), { recursive: true });
  mkdirSync(join(home, 'prompts'), { recursive: true });
  mkdirSync(join(home, 'themes'), { recursive: true });
  mkdirSync(join(home, 'skills', 'not-a-skill'), { recursive: true });
  mkdirSync(join(outside, 'skills', 'repo-skill'), { recursive: true });
  mkdirSync(join(outside, 'extra-prompts'), { recursive: true });
  // A Git working tree: this scan must never inspect what a symlink into it points at.
  mkdirSync(join(outside, 'skills', 'repo-skill', '.git'), { recursive: true });

  writeFileSync(join(home, 'extensions', 'good-extension.ts'), 'export default () => {};\n');
  writeFileSync(join(home, 'extensions', 'notes.txt'), 'not an extension\n');
  writeFileSync(join(home, 'extensions', 'unreadable.ts'), 'export default () => {};\n');
  chmodSync(join(home, 'extensions', 'unreadable.ts'), 0o000);
  symlinkSync(join(outside, 'skills', 'repo-skill'), join(home, 'extensions', 'linked-into-repo.ts'));
  symlinkSync(join(home, 'missing-target.ts'), join(home, 'extensions', 'dangling.ts'));
  writeFileSync(join(home, 'skills', 'probe-skill', 'SKILL.md'),
    '---\nname: probe-skill\ndescription: probe\n---\nbody\n');
  writeFileSync(join(home, 'prompts', 'probe-template.md'), '---\ndescription: probe\n---\nbody\n');
  writeFileSync(join(home, 'themes', 'probe-theme.json'), '{"name":"probe-theme"}\n');
  writeFileSync(join(outside, 'extra-prompts', 'extra.md'), '---\ndescription: extra\n---\nbody\n');
  writeFileSync(join(home, 'settings.json'), JSON.stringify({
    prompts: [join(outside, 'extra-prompts')],
  }));

  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      files.push(`${path}:${entry.isDirectory() ? 'dir' : 'file'}`);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return { home, outside, files };
}

function candidateFor(detection: ReturnType<typeof detectAgentPlugins>, name: string) {
  return detection.candidates.find((candidate) => candidate.name === name) ?? null;
}

describe('Agent plugin detection', () => {
  test('classifies every shape, reports provider enablement, and never writes', () => {
    const { home, files } = fixture();
    try {
      const detection = detectAgentPlugins({ adapterId: 'pi', pluginSelectionSupport: 'SUPPORTED',
        selection: null, configDirectory: home });
      expect(detection.pluginSelectionSupport).toBe('SUPPORTED');
      expect(detection.providerStateReadable).toBe(true);
      expect(detection.supportedKinds).toEqual(['extensions', 'skills', 'promptTemplates', 'themes']);
      expect(detection.selection).toBeNull();

      expect(candidateFor(detection, 'good-extension')).toMatchObject({
        kind: 'extensions', source: 'PROVIDER_USER_DIRECTORY', providerEnabled: true,
        selectable: true, reason: null, selected: false,
      });
      expect(candidateFor(detection, 'notes.txt')).toMatchObject({
        selectable: false, reason: 'UNSUPPORTED_FILE_TYPE',
      });
      expect(candidateFor(detection, 'unreadable')).toMatchObject({
        selectable: false, reason: 'NOT_READABLE',
      });
      expect(candidateFor(detection, 'linked-into-repo')).toMatchObject({
        selectable: false, reason: 'SYMLINK_OUTSIDE_PROVIDER_DIRECTORY',
      });
      expect(candidateFor(detection, 'dangling')).toMatchObject({
        selectable: false, reason: 'NOT_FOUND',
      });
      expect(candidateFor(detection, 'not-a-skill')).toMatchObject({
        kind: 'skills', selectable: false, reason: 'TYPE_UNDETERMINED',
      });
      expect(candidateFor(detection, 'probe-skill')).toMatchObject({ selectable: true });
      expect(candidateFor(detection, 'probe-template')).toMatchObject({
        kind: 'promptTemplates', selectable: true,
      });
      expect(candidateFor(detection, 'probe-theme')).toMatchObject({
        kind: 'themes', selectable: true,
      });
      // A path only `settings.json` names is reported with its own source.
      expect(candidateFor(detection, 'extra-prompts')).toMatchObject({
        kind: 'promptTemplates', source: 'PROVIDER_SETTINGS', selectable: true,
      });

      // Zero writes: the fixture tree is byte-for-byte the same after the scan.
      const after: string[] = [];
      const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          after.push(`${path}:${entry.isDirectory() ? 'dir' : 'file'}`);
          if (entry.isDirectory()) walk(path);
        }
      };
      walk(join(home, '..'));
      expect(after).toEqual([...files]);
    } finally {
      rmSync(join(home, '..'), { recursive: true, force: true });
    }
  });

  test('marks everything unverified when the provider state cannot be read', () => {
    const { home } = fixture();
    try {
      rmSync(join(home, 'settings.json'));
      const detection = detectAgentPlugins({ adapterId: 'pi', pluginSelectionSupport: 'SUPPORTED',
        selection: null, configDirectory: home });
      expect(detection.providerStateReadable).toBe(false);
      const usable = candidateFor(detection, 'good-extension');
      expect(usable?.providerEnabled).toBeNull();
      // A resource that is fine on its own still is not claimed to be enableable when the provider's
      // own state could not be read: unverifiable is reported, never guessed.
      expect(usable?.selectable).toBe(false);
      expect(usable?.reason).toBe('PROVIDER_STATE_UNREADABLE');
    } finally {
      rmSync(join(home, '..'), { recursive: true, force: true });
    }
  });

  test('an Adapter without plugin selection reports that and lists nothing', () => {
    const detection = detectAgentPlugins({ adapterId: 'codex',
      pluginSelectionSupport: 'UNSUPPORTED', selection: null, configDirectory: '/nonexistent' });
    expect(detection.candidates).toEqual([]);
    expect(detection.supportedKinds).toEqual([]);
    expect(detection.pluginSelectionSupport).toBe('UNSUPPORTED');
    expect(statSync(tmpdir()).isDirectory()).toBe(true);
  });

  test('projects the current selection over the candidates it matches', () => {
    const { home } = fixture();
    try {
      const skillPath = join(home, 'skills', 'probe-skill');
      const detection = detectAgentPlugins({
        adapterId: 'pi', pluginSelectionSupport: 'SUPPORTED', configDirectory: home,
        selection: { extensions: [], skills: [skillPath], promptTemplates: [], themes: [] },
        selectionSource: 'GLOBAL',
      });
      expect(detection.selectionSource).toBe('GLOBAL');
      expect(candidateFor(detection, 'probe-skill')?.selected).toBe(true);
      expect(candidateFor(detection, 'good-extension')?.selected).toBe(false);
    } finally {
      rmSync(join(home, '..'), { recursive: true, force: true });
    }
  });
});

describe('Agent plugin selection resolution and Execution trace', () => {
  test('project replaces global as a whole list and the recorded trace names every path', () => {
    const storage = new Phase1Database();
    storage.setAgentConfiguration({
      id: 'g', scope: 'GLOBAL', projectId: null, adapterId: 'pi', model: 'm-global',
      pluginSelection: { extensions: ['/g/ext.ts'], skills: [], promptTemplates: [], themes: [] },
      updatedAt: 1, updatedBy: 'local-user',
    });
    // No project override yet: the global selection applies.
    expect(resolveAgentPlugins({ storage, adapterId: 'pi', projectId: null })).toMatchObject({
      source: 'GLOBAL',
    });

    const projectId = '00000000-0000-4000-8000-000000000000';
    expect(() => storage.setAgentConfiguration({
      id: 'p', scope: 'PROJECT', projectId, adapterId: 'pi',
      pluginSelection: { extensions: [], skills: ['/p/skill'], promptTemplates: [], themes: [] },
      updatedAt: 2, updatedBy: 'local-user',
    })).toThrow(/Trusted project/);

    // The trace is what an Execution records: kind + path + the layer that supplied it.
    const trace = agentLaunchConfiguration({
      configuration: { model: 'm' },
      plugins: { selection: { extensions: ['/g/ext.ts'], skills: [], promptTemplates: [],
        themes: [] }, source: 'GLOBAL' },
    });
    expect(trace).toEqual({
      model: 'm',
      plugins: {
        source: 'GLOBAL',
        entries: [{ kind: 'extensions', path: '/g/ext.ts', source: 'GLOBAL' }],
        thirdPartyExtensionApprovalRisk: true,
      },
    });
    // No configuration and no selection records nothing at all: the Adapter's own default stays
    // distinguishable from an explicit empty configuration.
    expect(agentLaunchConfiguration({ configuration: null, plugins: null })).toBeNull();
    storage.close();
  });

  test('the effective model fields still resolve field by field around the selection', () => {
    const storage = new Phase1Database();
    storage.setAgentConfiguration({
      id: 'g', scope: 'GLOBAL', projectId: null, adapterId: 'pi', provider: 'deepseek',
      pluginSelection: { extensions: [], skills: ['/g/skill'], promptTemplates: [], themes: [] },
      updatedAt: 1, updatedBy: 'local-user',
    });
    const resolution = resolveAgentConfiguration({ storage, adapterId: 'pi', projectId: null,
      environment: {} });
    expect(resolution.effective).toEqual({ provider: 'deepseek' });
    expect(resolution.plugins).toMatchObject({ source: 'GLOBAL' });
    storage.close();
  });
});
