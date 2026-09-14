import { describe, expect, test } from 'bun:test';
import {
  ImpactPolicyError,
  impactPolicyDigest,
  impactPolicyIsEmpty,
  impactPolicyLabel,
  impactPolicyPath,
  impactPolicyVersion,
  normalizeImpactPath,
  parseImpactPolicy,
  type ImpactPolicy,
} from '../src/index.js';

function policy(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    importantDirectories: ['src/core'],
    modules: [{ id: 'scheduler', paths: ['src/scheduler/**'] }],
    globalResources: [
      { id: 'lockfile', kind: 'DEPENDENCY_LOCKFILE', paths: ['bun.lock'],
        consumers: { state: 'DECLARED', paths: ['package.json'] } },
    ],
    ...overrides,
  });
}

function parseFailure(text: string): ImpactPolicyError {
  try {
    parseImpactPolicy(text);
  } catch (error) {
    if (error instanceof ImpactPolicyError) return error;
    throw error;
  }
  throw new Error('Expected the mapping to be rejected');
}

describe('impact mapping parsing', () => {
  test('accepts a declared mapping and reports its label', () => {
    const parsed = parseImpactPolicy(policy());
    expect(parsed.version).toBe(1);
    expect(parsed.importantDirectories).toEqual(['src/core']);
    expect(parsed.modules[0]).toEqual({ id: 'scheduler', paths: ['src/scheduler/**'] });
    expect(parsed.globalResources[0]?.consumers).toEqual({
      state: 'DECLARED', paths: ['package.json'],
    });
    const digest = impactPolicyDigest(parsed);
    expect(impactPolicyLabel(digest)).toBe(`${impactPolicyVersion}#${digest.slice(0, 12)}`);
    expect(impactPolicyPath).toBe('.codeestra/impact.json');
  });

  test('accepts an empty mapping: valid, useless, and never enough for SAFE', () => {
    const parsed = parseImpactPolicy(JSON.stringify({
      version: 1, importantDirectories: [], modules: [], globalResources: [],
    }));
    expect(impactPolicyIsEmpty(parsed)).toBe(true);
    expect(impactPolicyIsEmpty(parseImpactPolicy(policy()))).toBe(false);
  });

  test('keeps the digest free of declaration order', () => {
    const left = parseImpactPolicy(JSON.stringify({
      version: 1,
      importantDirectories: ['src/a', 'src/b'],
      modules: [{ id: 'b', paths: ['b/**'] }, { id: 'a', paths: ['a/**'] }],
      globalResources: [
        { id: 'z', kind: 'BUILD_CONFIG', paths: ['z.json'], consumers: { state: 'UNKNOWN' } },
        { id: 'a', kind: 'BUILD_CONFIG', paths: ['a.json'], consumers: { state: 'UNKNOWN' } },
      ],
    }));
    const right = parseImpactPolicy(JSON.stringify({
      version: 1,
      importantDirectories: ['src/a', 'src/b'],
      modules: [{ id: 'a', paths: ['a/**'] }, { id: 'b', paths: ['b/**'] }],
      globalResources: [
        { id: 'a', kind: 'BUILD_CONFIG', paths: ['a.json'], consumers: { state: 'UNKNOWN' } },
        { id: 'z', kind: 'BUILD_CONFIG', paths: ['z.json'], consumers: { state: 'UNKNOWN' } },
      ],
    }));
    expect(impactPolicyDigest(left)).toBe(impactPolicyDigest(right));
  });

  test('changes the digest when any declared path changes', () => {
    const before = parseImpactPolicy(policy());
    const after = parseImpactPolicy(policy({ importantDirectories: ['src/core', 'src/other'] }));
    expect(impactPolicyDigest(before)).not.toBe(impactPolicyDigest(after));
  });

  test('rejects a mapping that is not valid JSON or not a valid shape', () => {
    expect(parseFailure('{').code).toBe('INVALID_IMPACT_POLICY');
    const bad = [
      // Unknown keys are refused so a typo cannot silently disable a declaration.
      '{"version":1,"importantDirectories":[],"modules":[],"globalResources":[],"ignore":[]}',
      '{"version":2,"importantDirectories":[],"modules":[],"globalResources":[]}',
      '{"version":1,"importantDirectories":[],"modules":[]}',
      '{"version":1,"importantDirectories":["src/core"],"modules":[],"globalResources":[],'
        + '"notes":"hello"}',
      // Duplicate IDs and duplicate declared paths would make the digest ambiguous.
      '{"version":1,"importantDirectories":["src/a","src/a"],"modules":[],"globalResources":[]}',
      '{"version":1,"importantDirectories":[],"modules":[{"id":"a","paths":["a/**"]},'
        + '{"id":"a","paths":["b/**"]}],"globalResources":[]}',
      '{"version":1,"importantDirectories":[],"modules":[{"id":"a","paths":["a/**","a/**"]}],'
        + '"globalResources":[]}',
      // An empty path list declares nothing and is refused, unlike an empty top-level list.
      '{"version":1,"importantDirectories":[],"modules":[{"id":"a","paths":[]}],'
        + '"globalResources":[]}',
      '{"version":1,"importantDirectories":[],"modules":[],"globalResources":[]}',
      '{"version":1,"importantDirectories":[],"modules":[],'
        + '"globalResources":[{"id":"a","kind":"NOPE","paths":["a"],'
        + '"consumers":{"state":"DECLARED","paths":[]}}]}',
      '{"version":1,"importantDirectories":[],"modules":[],'
        + '"globalResources":[{"id":"a","kind":"BUILD_CONFIG","paths":["a"],'
        + '"consumers":{"state":"DECLARED","paths":[],"extra":1}}]}',
      '{"version":1,"importantDirectories":[" src/core"],"modules":[],"globalResources":[]}',
      '{"version":1,"importantDirectories":[""],"modules":[],"globalResources":[]}',
    ];
    for (const text of bad) {
      if (text === '{"version":1,"importantDirectories":[],"modules":[],"globalResources":[]}') {
        // The one valid entry of the list is asserted separately: it must parse.
        expect(parseImpactPolicy(text).importantDirectories).toEqual([]);
        continue;
      }
      expect(parseFailure(text).code).toBe('INVALID_IMPACT_POLICY');
    }
  });

  test('rejects every path that could leave the repository or name something else', () => {
    const rejected = [
      '/etc/passwd', '~/.ssh/id_rsa', '~', '../outside', 'src/../../outside', './src', 'src/',
      'src//core', '.git/config', 'src/.git/config', 'src/core\\nested', 'src/core\u0000x',
      ' src/core', 'src/core ', 'a?b', 'src/**/core', '*', 'src/*',
    ];
    for (const path of rejected) {
      const text = JSON.stringify({
        version: 1, importantDirectories: [path], modules: [], globalResources: [],
      });
      expect(parseFailure(text).code).toBe('INVALID_IMPACT_POLICY');
    }
    // Only a trailing `/**` subtree is a wildcard, and it is rewritten to nothing here.
    expect(normalizeImpactPath('src/scheduler/**', 'pattern')).toBe('src/scheduler/**');
    expect(normalizeImpactPath('bun.lock', 'file')).toBe('bun.lock');
    expect(normalizeImpactPath('src/core', 'directory')).toBe('src/core');
  });

  test('refuses the repository root as an important directory', () => {
    // Declaring `.` would make every revision share one directory and hide which one overlapped.
    for (const path of ['.', './', '.']) {
      const text = JSON.stringify({
        version: 1, importantDirectories: [path], modules: [], globalResources: [],
      });
      expect(parseFailure(text).code).toBe('INVALID_IMPACT_POLICY');
    }
  });

  test('refuses a subtree pattern where a directory or file is required', () => {
    const asDirectory = JSON.stringify({
      version: 1, importantDirectories: ['src/**'], modules: [], globalResources: [],
    });
    expect(parseFailure(asDirectory).code).toBe('INVALID_IMPACT_POLICY');
    const asModulePath = JSON.stringify({
      version: 1, importantDirectories: [], modules: [{ id: 'm', paths: ['src'] }],
      globalResources: [],
    });
    // A module path without a wildcard is an exact *file* path, which is legal but matches no
    // directory; the honest reading is that the module declares one file.
    expect(parseImpactPolicy(asModulePath).modules[0]?.paths).toEqual(['src']);
  });

  test('requires consumers to be explicitly declared or explicitly unknown', () => {
    const unknown = JSON.stringify({
      version: 1, importantDirectories: [], modules: [],
      globalResources: [{ id: 'tsconfig', kind: 'BUILD_CONFIG', paths: ['tsconfig.json'],
        consumers: { state: 'UNKNOWN' } }],
    });
    const parsed = parseImpactPolicy(unknown) as ImpactPolicy;
    expect(parsed.globalResources[0]?.consumers).toEqual({ state: 'UNKNOWN' });
    const missing = JSON.stringify({
      version: 1, importantDirectories: [], modules: [],
      globalResources: [{ id: 'tsconfig', kind: 'BUILD_CONFIG', paths: ['tsconfig.json'] }],
    });
    // An absent `consumers` is refused instead of being read as "nobody reads it".
    expect(parseFailure(missing).code).toBe('INVALID_IMPACT_POLICY');
  });
});
