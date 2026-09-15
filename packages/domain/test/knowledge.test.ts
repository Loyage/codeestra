import { describe, expect, test } from 'bun:test';
import {
  KnowledgeError,
  buildKnowledgeSnapshot,
  knowledgeEntriesDigest,
  knowledgeEntryAppliesToTaskKind,
  knowledgeLayerOrder,
  knowledgeLayerPolicyVersion,
  knowledgeSnapshotRefs,
  maxKnowledgeEntriesPerLayer,
  parseKnowledgeEntry,
  parseKnowledgeFrontMatter,
  renderKnowledgeContext,
  selectKnowledgeEntriesForTaskKind,
  type KnowledgeEntry,
  type KnowledgeTaskKind,
} from '../src/knowledge.js';

/**
 * Pure layer semantics of Project Knowledge (FOUNDATION-067 / ADR-0041). These tests fix the part
 * that must never depend on Git, SQLite or a model: which files are entries, what is refused, what
 * order and digest an entry set produces, and which entries a Task kind would actually read.
 */

/** Infers the layer from the path unless the test names one, so the path stays the readable fact. */
function layerForPath(path: string): 'instructions' | 'skills' | 'generated' {
  if (path.startsWith('.codeestra/skills/')) return 'skills';
  if (path.startsWith('.codeestra/instructions/')) return 'instructions';
  return 'generated';
}

function entry(input: {
  readonly layer?: 'instructions' | 'skills' | 'generated';
  readonly path: string;
  readonly text: string;
  readonly origin?: { readonly source?: string; readonly revision?: string; readonly commit?: string };
}): KnowledgeEntry {
  return parseKnowledgeEntry({
    layer: input.layer ?? layerForPath(input.path),
    path: input.path,
    text: input.text,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
  });
}

describe('knowledge front matter', () => {
  test('reads the supported top-level scalar subset and reports the body', () => {
    const parsed = parseKnowledgeFrontMatter('---\nid: always-tests\nscope: SELF\n---\nBody line\n');
    expect(parsed.frontMatter).toEqual({ id: 'always-tests', scope: 'SELF' });
    expect(parsed.body).toBe('Body line\n');
  });

  test('accepts quoted values and a CRLF document', () => {
    const parsed = parseKnowledgeFrontMatter('---\r\nid: "quoted"\r\nscope: \'ALL\'\r\n---\r\nx\r\n');
    expect(parsed.frontMatter).toEqual({ id: 'quoted', scope: 'ALL' });
  });

  test('a document with no fence is all body', () => {
    const parsed = parseKnowledgeFrontMatter('# Title\n\ntext\n');
    expect(parsed.frontMatter).toEqual({});
    expect(parsed.body).toBe('# Title\n\ntext\n');
  });

  test('refuses an unknown key instead of ignoring it', () => {
    // `scpoe: SELF` must not silently mean "applies everywhere". Failing closed is the whole point.
    expect(() => parseKnowledgeFrontMatter('---\nscpoe: SELF\n---\nbody\n'))
      .toThrow(KnowledgeError);
    try {
      parseKnowledgeFrontMatter('---\nscpoe: SELF\n---\nbody\n');
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as KnowledgeError).code).toBe('KNOWLEDGE_INVALID_FRONT_MATTER');
    }
  });

  test('refuses nesting, sequences, duplicates and an unclosed fence', () => {
    for (const text of [
      '---\nid: a\n  nested: b\n---\n',
      '---\nid:\n  - a\n---\n',
      '---\nid: [a, b]\n---\n',
      '---\nid: |\n---\n',
      '---\nid: a\nid: b\n---\n',
      '---\nid: a\n',
      '---\n# comment\n---\n',
    ]) {
      expect(() => parseKnowledgeFrontMatter(text)).toThrow(KnowledgeError);
    }
  });
});

describe('knowledge entries', () => {
  test('only Markdown under a layer directory is an entry', () => {
    expect(entry({ path: '.codeestra/instructions/a.md', text: 'x' }).path)
      .toBe('.codeestra/instructions/a.md');
    for (const path of [
      '.codeestra/instructions/a.txt',
      '.codeestra/instructions/nested/a.json',
    ]) {
      expect(() => entry({ path, text: 'x' })).toThrow(KnowledgeError);
    }
  });

  test('a human entry must stay inside its own layer', () => {
    try {
      entry({ layer: 'skills', path: '.codeestra/instructions/a.md', text: 'x' });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as KnowledgeError).code).toBe('KNOWLEDGE_PATH_OUTSIDE_LAYER');
    }
  });

  test('paths that leave the layer are refused for meaning', () => {
    for (const path of [
      '/etc/passwd.md',
      '~/.ssh/id.md',
      '.codeestra/instructions/../../outside.md',
      '.codeestra/instructions/a\\b.md',
      '.codeestra/instructions/.git/config.md',
      '.codeestra/instructions//a.md',
    ]) {
      expect(() => entry({ path, text: 'x' })).toThrow(KnowledgeError);
    }
  });

  test('the body digest ignores the front matter, so metadata cannot fake a content change', () => {
    const first = entry({ path: '.codeestra/instructions/a.md', text: '---\nid: a\n---\nBody\n' });
    const second = entry({ path: '.codeestra/instructions/a.md', text: '---\nid: b\n---\nBody\n' });
    expect(first.digest).toBe(second.digest);
    expect(first.id).toBe('a');
    expect(second.id).toBe('b');
  });

  test('refuses invalid ids, scopes, oversized entries and NUL bytes', () => {
    expect(() => entry({ path: '.codeestra/instructions/a.md', text: '---\nid: 9 bad\n---\n' }))
      .toThrow(KnowledgeError);
    expect(() => entry({ path: '.codeestra/instructions/a.md', text: '---\nscope: SOMETIMES\n---\n' }))
      .toThrow(KnowledgeError);
    expect(() => entry({ path: '.codeestra/instructions/a.md', text: `x${'\u0000'}y` }))
      .toThrow(KnowledgeError);
    expect(() => entry({ path: '.codeestra/instructions/a.md', text: 'x'.repeat(65_537) }))
      .toThrow(KnowledgeError);
  });

  test('scope is normalized to the Task-kind vocabulary', () => {
    expect(entry({ path: '.codeestra/instructions/a.md', text: 'x' }).scope).toBe('ALL');
    expect(entry({ path: '.codeestra/instructions/a.md', text: '---\nscope: self\n---\n' }).scope)
      .toBe('SELF');
  });

  test('a machine-generated entry must carry provenance', () => {
    try {
      entry({ layer: 'generated', path: 'summary.md', text: 'x' });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as KnowledgeError).code).toBe('KNOWLEDGE_GENERATED_PROVENANCE_MISSING');
    }
    const generated = entry({
      layer: 'generated',
      path: 'nested/summary.md',
      text: 'x',
      origin: { source: 'execution:e1', revision: 'r1', commit: 'a'.repeat(40) },
    });
    expect(generated.origin).toEqual({
      source: 'execution:e1', revision: 'r1', commit: 'a'.repeat(40),
    });
  });
});

describe('layer order and conflicts', () => {
  test('the declared layer order is instructions, skills, generated', () => {
    expect(knowledgeLayerOrder).toEqual(['instructions', 'skills', 'generated']);
    expect(knowledgeLayerPolicyVersion).toBe('knowledge-layers-v1');
  });

  test('ordering is layer order first, then path', () => {
    const snapshot = buildKnowledgeSnapshot({
      mainRef: 'refs/heads/main',
      mainCommit: 'a'.repeat(40),
      entries: [
        entry({ layer: 'generated', path: 'z.md', text: 'z', origin: { source: 'e1' } }),
        entry({ layer: 'skills', path: '.codeestra/skills/b.md', text: 'b' }),
        entry({ layer: 'instructions', path: '.codeestra/instructions/z.md', text: 'z' }),
        entry({ layer: 'instructions', path: '.codeestra/instructions/a.md', text: 'a' }),
      ],
    });
    expect(snapshot.entries.map((candidate) => candidate.path)).toEqual([
      '.codeestra/instructions/a.md',
      '.codeestra/instructions/z.md',
      '.codeestra/skills/b.md',
      'z.md',
    ]);
    expect(snapshot.humanEntryCount).toBe(3);
    expect(snapshot.generatedEntryCount).toBe(1);
  });

  test('a duplicate id is a refusal, never a silent winner', () => {
    try {
      buildKnowledgeSnapshot({
        mainRef: 'refs/heads/main',
        mainCommit: 'a'.repeat(40),
        entries: [
          entry({ path: '.codeestra/instructions/a.md', text: '---\nid: shared\n---\nfirst\n' }),
          entry({ path: '.codeestra/skills/b.md', text: '---\nid: shared\n---\nsecond\n' }),
        ],
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as KnowledgeError).code).toBe('KNOWLEDGE_DUPLICATE_ID');
      expect((error as KnowledgeError).path).toBe('.codeestra/skills/b.md');
    }
  });

  test('a duplicate path is a refusal', () => {
    const path = '.codeestra/instructions/a.md';
    expect(() => buildKnowledgeSnapshot({
      mainRef: 'refs/heads/main',
      mainCommit: 'a'.repeat(40),
      entries: [entry({ path, text: 'one' }), entry({ path, text: 'two' })],
    })).toThrow(KnowledgeError);
  });

  test('an empty snapshot is valid, and an unbounded layer is not', () => {
    const empty = buildKnowledgeSnapshot({
      mainRef: 'refs/heads/main', mainCommit: 'a'.repeat(40), entries: [],
    });
    expect(empty.entryCount).toBe(0);
    expect(empty.snapshotDigest).toHaveLength(64);

    const tooMany = Array.from({ length: maxKnowledgeEntriesPerLayer + 1 }, (_value, index) =>
      entry({ path: `.codeestra/instructions/${index}.md`, text: `${index}` }));
    expect(() => buildKnowledgeSnapshot({
      mainRef: 'refs/heads/main', mainCommit: 'a'.repeat(40), entries: tooMany,
    })).toThrow(KnowledgeError);
  });
});

describe('snapshot identity', () => {
  test('the same knowledge produces the same digest regardless of input order', () => {
    const first = entry({ path: '.codeestra/instructions/a.md', text: 'alpha' });
    const second = entry({ path: '.codeestra/skills/b.md', text: 'beta' });
    const left = buildKnowledgeSnapshot({
      mainRef: 'refs/heads/main', mainCommit: 'a'.repeat(40), entries: [first, second],
    });
    const right = buildKnowledgeSnapshot({
      mainRef: 'refs/heads/main', mainCommit: 'a'.repeat(40), entries: [second, first],
    });
    expect(left.snapshotDigest).toBe(right.snapshotDigest);
    expect(left.humanDigest).toBe(right.humanDigest);
  });

  test('a content change, a path change, a scope change or a commit change moves the digest', () => {
    const base = { path: '.codeestra/instructions/a.md', text: 'alpha' };
    const digestOf = (input: {
      readonly entries: readonly KnowledgeEntry[];
      readonly mainCommit?: string;
    }): string => buildKnowledgeSnapshot({
      mainRef: 'refs/heads/main',
      mainCommit: input.mainCommit ?? 'a'.repeat(40),
      entries: input.entries,
    }).snapshotDigest;
    const original = digestOf({ entries: [entry(base)] });
    expect(digestOf({ entries: [entry({ ...base, text: 'alpha2' })] })).not.toBe(original);
    expect(digestOf({ entries: [entry({ ...base, path: '.codeestra/instructions/b.md' })] }))
      .not.toBe(original);
    expect(digestOf({ entries: [
      entry({ ...base, text: '---\nscope: SELF\n---\nalpha' }),
    ] })).not.toBe(original);
    expect(digestOf({ entries: [entry(base)], mainCommit: 'b'.repeat(40) })).not.toBe(original);
  });

  test('provenance participates in the digest, but a timestamp does not', () => {
    const generated = (origin: { source: string; revision?: string }): KnowledgeEntry =>
      entry({ layer: 'generated', path: 'summary.md', text: 'body', origin });
    const left = knowledgeEntriesDigest([generated({ source: 'e1', revision: 'r1' })]);
    const right = knowledgeEntriesDigest([generated({ source: 'e1', revision: 'r2' })]);
    expect(left).not.toBe(right);
    // `generatedAt` is not part of `KnowledgeEntryOrigin`, so regenerating identical content with a
    // new timestamp cannot move the digest: identity is content plus provenance, not a clock.
    expect(knowledgeEntriesDigest([generated({ source: 'e1', revision: 'r1' })])).toBe(left);
  });

  test('references name the whole snapshot first and then each entry', () => {
    const entries = [entry({ path: '.codeestra/instructions/a.md', text: 'alpha' })];
    const refs = knowledgeSnapshotRefs('f'.repeat(64), entries);
    expect(refs[0]).toBe(`knowledge-snapshot:${'f'.repeat(64)}`);
    expect(refs[1]).toBe(`knowledge-entry:instructions:.codeestra/instructions/a.md#`
      + `${entries[0]?.digest.slice(0, 12)}`);
  });
});

describe('applicability and materialization', () => {
  const entries = [
    entry({ path: '.codeestra/instructions/all.md', text: '---\nid: all\n---\neveryone\n' }),
    entry({ path: '.codeestra/instructions/dev.md', text: '---\nscope: DEVELOPMENT\n---\ndev\n' }),
    entry({ path: '.codeestra/skills/self.md', text: '---\nscope: SELF\n---\nself\n' }),
  ];

  test('scope filters by the Task kind that already exists in the domain', () => {
    const kinds: readonly KnowledgeTaskKind[] = ['DEVELOPMENT', 'SELF'];
    expect(entries.map((candidate) => knowledgeEntryAppliesToTaskKind(candidate, kinds[0] as
      KnowledgeTaskKind))).toEqual([true, true, false]);
    expect(entries.map((candidate) => knowledgeEntryAppliesToTaskKind(candidate, kinds[1] as
      KnowledgeTaskKind))).toEqual([true, false, true]);
    expect(selectKnowledgeEntriesForTaskKind(entries, 'SELF').map((candidate) => candidate.path))
      .toEqual(['.codeestra/instructions/all.md', '.codeestra/skills/self.md']);
  });

  test('the rendered context is deterministic and names its provenance', () => {
    const snapshot = buildKnowledgeSnapshot({
      mainRef: 'refs/heads/main', mainCommit: 'c'.repeat(40), entries,
    });
    const bodies = new Map(entries.map((candidate) => [candidate.path, 'body of ' + candidate.path]));
    const render = (kind: KnowledgeTaskKind): ReturnType<typeof renderKnowledgeContext> =>
      renderKnowledgeContext({
        snapshot, taskKind: kind, readBody: (candidate) => bodies.get(candidate.path) ?? '',
      });
    const development = render('DEVELOPMENT');
    expect(development.fileName).toBe('knowledge-context.md');
    expect(development.text).toContain(`Snapshot digest: ${snapshot.snapshotDigest}`);
    expect(development.text).toContain(`Task kind: DEVELOPMENT`);
    expect(development.text).toContain('body of .codeestra/instructions/dev.md');
    expect(development.text).not.toContain('body of .codeestra/skills/self.md');
    expect(development.entries).toHaveLength(2);
    expect(development.digest).toHaveLength(64);
    expect(development.bytes).toBe(new TextEncoder().encode(development.text).length);
    // Same inputs, same bytes — an Execution's recorded context digest must be reproducible.
    expect(render('DEVELOPMENT')).toEqual(development);
    // A different Task kind is a different document, and therefore a different digest.
    expect(render('SELF').digest).not.toBe(development.digest);
  });
});
