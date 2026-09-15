import { describe, expect, it } from 'vitest';
import {
  assessCandidate,
  createImpactSnapshot,
  deriveImpactScope,
  explainAssessment,
  impactAnalyzerVersion,
  impactDirectoriesOverlap,
  impactPatternMatches,
  isSnapshotCurrent,
  maxImpactFiles,
  normalizeObservedImpactPath,
  type ConflictAssessment,
  type ImpactAssessmentContext,
  type ImpactIncompleteReason,
  type ImpactMapping,
  type ImpactPathCaseMode,
  type ImpactSnapshot,
  type ImpactSubject,
} from '../src/index.js';

const baseCommit = 'a'.repeat(40);
const otherBaseCommit = 'b'.repeat(40);
const digest = 'f'.repeat(64);
const policyVersion = `impact-policy-v1#${digest.slice(0, 12)}`;

const mapping = (overrides: Partial<ImpactMapping> = {}): ImpactMapping => ({
  importantDirectories: [],
  modules: [],
  globalResources: [],
  ...overrides,
});

/**
 * A complete mapping that matches none of the file-focused test paths, so those tests exercise file
 * and staleness behavior instead of accidentally overlapping on a declared directory.
 */
const completeMapping = mapping({ importantDirectories: ['declared-only'] });

const context = (overrides: Partial<ImpactAssessmentContext> = {}): ImpactAssessmentContext => ({
  baseCommit,
  policyVersion,
  analyzerVersion: impactAnalyzerVersion,
  ...overrides,
});

interface SnapshotOptions {
  readonly taskId?: string;
  readonly revisionId?: string;
  readonly paths?: readonly string[];
  readonly mapping?: ImpactMapping | null;
  readonly caseMode?: ImpactPathCaseMode;
  readonly incompleteReasons?: readonly ImpactIncompleteReason[];
  readonly base?: string;
  readonly fingerprint?: string;
  readonly analyzerVersion?: string;
}

function snapshot(options: SnapshotOptions = {}): ImpactSnapshot {
  return createImpactSnapshot({
    taskId: options.taskId ?? 'task-a',
    revisionId: options.revisionId ?? 'revision-a',
    baseCommit: options.base ?? baseCommit,
    policyVersion,
    policyDigest: digest,
    caseMode: options.caseMode ?? 'SENSITIVE',
    paths: options.paths ?? [],
    changeFingerprint: options.fingerprint ?? `fingerprint-${options.taskId ?? 'task-a'}`,
    mapping: options.mapping === undefined ? completeMapping : options.mapping,
    ...(options.incompleteReasons === undefined
      ? {}
      : { incompleteReasons: options.incompleteReasons }),
    ...(options.analyzerVersion === undefined ? {} : { analyzerVersion: options.analyzerVersion }),
  });
}

function subject(from: SnapshotOptions = {}, observedFiles?: readonly string[]): ImpactSubject {
  const built = snapshot(from);
  return {
    taskId: built.taskId,
    currentRevisionId: built.revisionId,
    snapshot: built,
    ...(observedFiles === undefined ? {} : { observedFiles }),
  };
}

function assess(
  candidate: SnapshotOptions,
  active: readonly SnapshotOptions[] = [],
  overrides: Partial<ImpactAssessmentContext> = {},
): ConflictAssessment {
  return assessCandidate({
    candidate: subject(candidate),
    active: active.map((entry) => subject(entry)),
    context: context(overrides),
  });
}

describe('conflict analyzer: files', () => {
  it('reports the same changed file with the intersecting path', () => {
    const assessment = assess(
      { taskId: 'a', paths: ['src/map/handler.ts', 'README.md'] },
      [{ taskId: 'b', paths: ['src/map/handler.ts'] }],
    );
    expect(assessment.verdict).toBe('CONFLICTING');
    expect(assessment.reasonCodes).toEqual(['SAME_FILE']);
    expect(assessment.hits[0]).toMatchObject({
      reason: 'SAME_FILE',
      class: 'CONFLICT',
      taskId: 'b',
      paths: ['src/map/handler.ts'],
      pathCount: 1,
      relation: 'SAME_FILE',
    });
  });

  it('treats a rename as both the old and the new path', () => {
    // The caller (Runtime) expands a rename into both entry points; the analyzer must catch an
    // overlap on either side, so moving a file into another Task's file is a conflict.
    const assessment = assess(
      { taskId: 'a', paths: ['src/old.ts', 'src/new.ts'] },
      [{ taskId: 'b', paths: ['src/new.ts'] }],
    );
    expect(assessment.verdict).toBe('CONFLICTING');
    expect(assessment.hits[0]?.paths).toEqual(['src/new.ts']);
  });

  it('is SAFE for disjoint files with a complete mapping', () => {
    const assessment = assess(
      { taskId: 'a', paths: ['src/map/handler.ts'] },
      [{ taskId: 'b', paths: ['src/other/handler.ts'] }],
    );
    expect(assessment.verdict).toBe('SAFE_TO_PARALLELIZE');
    expect(assessment.reasonCodes).toEqual(['NO_CONFLICT']);
    expect(assessment.safePairs).toEqual([
      { taskId: 'b', revisionId: 'revision-a', changeFingerprint: 'fingerprint-b' },
    ]);
    expect(assessment.evidence.join(' ')).toContain('compared 1 active/reserved Task');
  });

  it('is SAFE with no active Task at all, and says so', () => {
    const assessment = assess({ taskId: 'a', paths: ['src/map/handler.ts'] });
    expect(assessment.verdict).toBe('SAFE_TO_PARALLELIZE');
    expect(assessment.evidence.join(' ')).toContain('none');
  });
});

describe('conflict analyzer: important directories', () => {
  const directories = mapping({ importantDirectories: ['src/map', 'src/mapping', 'core'] });

  it('overlaps inside one important directory', () => {
    const assessment = assess(
      { taskId: 'a', paths: ['src/map/a.ts'], mapping: directories },
      [{ taskId: 'b', paths: ['src/map/b.ts'], mapping: directories }],
    );
    expect(assessment.verdict).toBe('CONFLICTING');
    expect(assessment.reasonCodes).toEqual(['IMPORTANT_DIRECTORY_OVERLAP']);
    expect(assessment.hits[0]).toMatchObject({
      reason: 'IMPORTANT_DIRECTORY_OVERLAP',
      relation: 'SAME_DIRECTORY',
      directories: ['src/map'],
    });
  });

  it('overlaps when one revision changes an ancestor directory', () => {
    // Derived matching means an ancestor overlap always also shares an exact directory, so the hit
    // names both the ancestor and the nested directory instead of hiding which one caused it.
    const nested = mapping({ importantDirectories: ['core', 'core/api'] });
    expect(impactDirectoriesOverlap('core', 'core/api')).toBe(true);
    const assessment = assess(
      { taskId: 'a', paths: ['core/a.ts'], mapping: nested },
      [{ taskId: 'b', paths: ['core/api/b.ts'], mapping: nested }],
    );
    expect(assessment.verdict).toBe('CONFLICTING');
    expect(assessment.hits[0]).toMatchObject({
      reason: 'IMPORTANT_DIRECTORY_OVERLAP',
      relation: 'SAME_DIRECTORY',
      directories: ['core', 'core/api'],
    });
    expect(assessment.hits[0]?.detail).toContain('core/api');
  });

  it('does NOT treat src/map and src/mapping as the same directory', () => {
    // Component-wise comparison: a naive prefix match would call this a conflict.
    expect(impactDirectoriesOverlap('src/map', 'src/mapping')).toBe(false);
    expect(impactDirectoriesOverlap('src/map', 'src/map/deep')).toBe(true);
    const assessment = assess(
      { taskId: 'a', paths: ['src/map/a.ts'], mapping: directories },
      [{ taskId: 'b', paths: ['src/mapping/b.ts'], mapping: directories }],
    );
    expect(assessment.verdict).toBe('SAFE_TO_PARALLELIZE');
  });

  it('matches a subtree pattern by component, not by string prefix', () => {
    expect(impactPatternMatches('src/map/a.ts', 'src/map/**')).toBe(true);
    expect(impactPatternMatches('src/map', 'src/map/**')).toBe(true);
    expect(impactPatternMatches('src/mapping/a.ts', 'src/map/**')).toBe(false);
    expect(impactPatternMatches('src/map/a.ts', 'src/map/a.ts')).toBe(true);
    expect(impactPatternMatches('src/map/a.ts', 'src/map')).toBe(false);
  });
});

describe('conflict analyzer: modules', () => {
  const modules = mapping({
    modules: [
      { id: 'scheduler', paths: ['src/scheduler/**'] },
      { id: 'storage', paths: ['src/storage/**'] },
    ],
  });

  it('conflicts when two revisions change different files of one module', () => {
    const assessment = assess(
      { taskId: 'a', paths: ['src/scheduler/queue.ts'], mapping: modules },
      [{ taskId: 'b', paths: ['src/scheduler/tick.ts'], mapping: modules }],
    );
    expect(assessment.verdict).toBe('CONFLICTING');
    expect(assessment.reasonCodes).toEqual(['SAME_MODULE']);
    expect(assessment.hits[0]?.modules).toEqual(['scheduler']);
  });

  it('does not conflict across modules', () => {
    const assessment = assess(
      { taskId: 'a', paths: ['src/scheduler/queue.ts'], mapping: modules },
      [{ taskId: 'b', paths: ['src/storage/rows.ts'], mapping: modules }],
    );
    expect(assessment.verdict).toBe('SAFE_TO_PARALLELIZE');
  });

  it('leaves a path no module declares unclassified but still compared as a file', () => {
    const scope = deriveImpactScope({
      paths: ['src/unknown/thing.ts'],
      mapping: modules,
      caseMode: 'SENSITIVE',
    });
    expect(scope.modules).toEqual([]);
    expect(scope.unclassifiedFiles).toEqual(['src/unknown/thing.ts']);
  });
});

describe('conflict analyzer: shared resources', () => {
  const resources = mapping({
    globalResources: [
      { id: 'lockfile', kind: 'DEPENDENCY_LOCKFILE', paths: ['bun.lock'],
        consumers: { state: 'DECLARED', paths: ['package.json'] } },
      { id: 'schema', kind: 'SCHEMA_MIGRATION', paths: ['src/schema/**'],
        consumers: { state: 'DECLARED', paths: ['src/storage/database.ts'] } },
      { id: 'build', kind: 'BUILD_CONFIG', paths: ['tsconfig.json'],
        consumers: { state: 'UNKNOWN' } },
    ],
  });

  it('conflicts when both revisions change the same shared resource', () => {
    const assessment = assess(
      { taskId: 'a', paths: ['src/schema/001-add-column.ts'], mapping: resources },
      [{ taskId: 'b', paths: ['src/schema/002-add-index.ts'], mapping: resources }],
    );
    expect(assessment.verdict).toBe('CONFLICTING');
    expect(assessment.reasonCodes).toEqual(['GLOBAL_RESOURCE']);
    expect(assessment.hits[0]).toMatchObject({
      reason: 'GLOBAL_RESOURCE', relation: 'WRITE_WRITE', globalResources: ['schema'],
    });
  });

  it('conflicts when one revision rewrites a shared file both revisions touch', () => {
    const assessment = assess(
      { taskId: 'a', paths: ['bun.lock'], mapping: resources },
      [{ taskId: 'b', paths: ['bun.lock'], mapping: resources }],
    );
    expect(assessment.verdict).toBe('CONFLICTING');
    expect(assessment.reasonCodes).toEqual(['SAME_FILE', 'GLOBAL_RESOURCE']);
    expect(assessment.hits.map((hit) => hit.globalResources)).toContainEqual(['lockfile']);
  });

  it('conflicts when one writes a resource and the other depends on it', () => {
    const assessment = assess(
      { taskId: 'a', paths: ['src/schema/001-add-column.ts'], mapping: resources },
      [{ taskId: 'b', paths: ['src/storage/database.ts'], mapping: resources }],
    );
    expect(assessment.verdict).toBe('CONFLICTING');
    expect(assessment.reasonCodes).toEqual(['GLOBAL_RESOURCE_DEPENDENCY']);
    expect(assessment.hits[0]).toMatchObject({
      reason: 'GLOBAL_RESOURCE_DEPENDENCY', relation: 'READ_WRITE', globalResources: ['schema'],
    });
  });

  it('treats a write to a resource with undeclared consumers as UNKNOWN', () => {
    // "Nobody reads tsconfig.json" is a claim nobody made, so the effect is unbounded: no SAFE.
    const a = snapshot({ taskId: 'a', paths: ['tsconfig.json'], mapping: resources });
    expect(a.complete).toBe(false);
    expect(a.incompleteReasons).toEqual(['UNCERTAIN_GLOBAL_EFFECT']);
    const assessment = assess(
      { taskId: 'a', paths: ['tsconfig.json'], mapping: resources },
      [{ taskId: 'b', paths: ['tsconfig.json'], mapping: resources }],
    );
    // A real overlap still outranks incompleteness, so the conflict is reported as CONFLICTING.
    expect(assessment.verdict).toBe('CONFLICTING');
    const alone = assess({ taskId: 'a', paths: ['tsconfig.json'], mapping: resources });
    expect(alone.verdict).toBe('UNKNOWN');
    expect(alone.reasonCodes).toEqual(['INCOMPLETE_IMPACT']);
    expect(alone.hits[0]?.detail).toContain('UNCERTAIN_GLOBAL_EFFECT');
  });

  it('does not treat a read-only dependency as a conflict with an unrelated revision', () => {
    const assessment = assess(
      { taskId: 'a', paths: ['package.json'], mapping: resources },
      [{ taskId: 'b', paths: ['src/scheduler/queue.ts'], mapping: resources }],
    );
    expect(assessment.verdict).toBe('SAFE_TO_PARALLELIZE');
  });
});

describe('conflict analyzer: incomplete and stale facts never become SAFE', () => {
  it('is UNKNOWN when the project declares no mapping', () => {
    const assessment = assess(
      { taskId: 'a', paths: ['src/a.ts'], mapping: null, incompleteReasons: ['POLICY_ABSENT'] },
      [],
    );
    expect(assessment.verdict).toBe('UNKNOWN');
    expect(assessment.reasonCodes).toEqual(['INCOMPLETE_IMPACT']);
    expect(assessment.candidateComplete).toBe(false);
    expect(assessment.candidateIncompleteReasons).toEqual(['POLICY_ABSENT']);
  });

  it('is UNKNOWN for a valid but empty mapping', () => {
    const built = snapshot({ taskId: 'a', paths: ['src/a.ts'], mapping: mapping() });
    expect(built.complete).toBe(false);
    expect(built.incompleteReasons).toEqual(['EMPTY_MAPPING']);
    expect(assess({ taskId: 'a', paths: ['src/a.ts'], mapping: mapping() }).verdict).toBe('UNKNOWN');
  });

  it('is UNKNOWN when an unconfirmed mapping was used', () => {
    const assessment = assess({
      taskId: 'a',
      paths: ['src/a.ts'],
      mapping: mapping({ importantDirectories: ['src'] }),
      incompleteReasons: ['POLICY_NOT_CONFIRMED'],
    });
    expect(assessment.verdict).toBe('UNKNOWN');
    expect(assessment.candidateIncompleteReasons).toEqual(['POLICY_NOT_CONFIRMED']);
  });

  it('is UNKNOWN for an empty change set whose completeness is insufficient', () => {
    const assessment = assess({ taskId: 'a', paths: [], mapping: mapping() });
    expect(assessment.verdict).toBe('UNKNOWN');
    expect(assessment.reasonCodes).toEqual(['INCOMPLETE_IMPACT']);
  });

  it('is SAFE for an empty change set with a complete mapping, but never claims overlap', () => {
    const assessment = assess(
      { taskId: 'a', paths: [], mapping: mapping({ importantDirectories: ['src'] }) },
      [{ taskId: 'b', paths: ['src/b.ts'], mapping: mapping({ importantDirectories: ['src'] }) }],
    );
    expect(assessment.verdict).toBe('SAFE_TO_PARALLELIZE');
  });

  it('is UNKNOWN when an active Task has no derivable snapshot', () => {
    const assessment = assessCandidate({
      candidate: subject({ taskId: 'a', paths: ['src/a.ts'],
        mapping: mapping({ importantDirectories: ['src'] }) }),
      active: [{ taskId: 'b', currentRevisionId: 'revision-b', snapshot: null,
        unavailableDetail: 'workspace is gone' }],
      context: context(),
    });
    expect(assessment.verdict).toBe('UNKNOWN');
    expect(assessment.reasonCodes).toEqual(['MISSING_IMPACT_SNAPSHOT']);
    expect(assessment.hits[0]?.detail).toContain('workspace is gone');
    expect(assessment.safePairs).toEqual([]);
  });

  it('is UNKNOWN, not a crash, when the candidate itself has no derivable snapshot', () => {
    // FOUNDATION-086: this is the shape `project impact explain` produces for a Task whose workspace
    // was removed (or which never had one). The verdict must be the analyzer's own UNKNOWN, with the
    // missing snapshot named — dereferencing the absent generation crashed instead.
    const assessment = assessCandidate({
      candidate: { taskId: 'a', currentRevisionId: 'revision-a', snapshot: null,
        unavailableDetail: 'the recorded workspace is not on disk' },
      active: [],
      context: context(),
    });
    expect(assessment.verdict).toBe('UNKNOWN');
    expect(assessment.reasonCodes).toEqual(['MISSING_IMPACT_SNAPSHOT']);
    expect(assessment.hits[0]?.detail).toContain('the recorded workspace is not on disk');
  });

  it('is UNKNOWN when an active Task is incomplete', () => {
    const assessment = assess(
      { taskId: 'a', paths: ['src/a.ts'], mapping: mapping({ importantDirectories: ['src'] }) },
      [{ taskId: 'b', paths: ['other/b.ts'], mapping: mapping() }],
    );
    expect(assessment.verdict).toBe('UNKNOWN');
    expect(assessment.reasonCodes).toEqual(['INCOMPLETE_IMPACT']);
    expect(assessment.hits[0]?.taskId).toBe('b');
    expect(assessment.safePairs).toEqual([]);
  });
});

describe('conflict analyzer: staleness', () => {
  const complete = mapping({ importantDirectories: ['src'] });

  it('reports a base, policy, analyzer or revision mismatch as stale_or_invalid', () => {
    const stale = assess({ taskId: 'a', paths: ['src/a.ts'], mapping: complete },
      [{ taskId: 'b', paths: ['src/b.ts'], mapping: complete }],
      { baseCommit: otherBaseCommit });
    expect(stale.verdict).toBe('UNKNOWN');
    expect(stale.reasonCodes).toEqual(['STALE_BASE']);

    const otherPolicy = assess({ taskId: 'a', paths: ['src/a.ts'], mapping: complete }, [],
      { policyVersion: 'impact-policy-v1#000000000000' });
    expect(otherPolicy.reasonCodes).toEqual(['STALE_POLICY']);

    const otherAnalyzer = assess({ taskId: 'a', paths: ['src/a.ts'], mapping: complete,
      analyzerVersion: 'impact-analyzer-v0' }, [], {});
    expect(otherAnalyzer.reasonCodes).toEqual(['STALE_ANALYZER']);

    const amended = assessCandidate({
      candidate: { taskId: 'a', currentRevisionId: 'revision-2',
        snapshot: snapshot({ taskId: 'a', paths: ['src/a.ts'], mapping: complete }) },
      active: [],
      context: context(),
    });
    expect(amended.verdict).toBe('UNKNOWN');
    expect(amended.reasonCodes).toEqual(['STALE_REVISION']);
  });

  it('invalidates a snapshot when the observed diff grew past it', () => {
    const built = snapshot({ taskId: 'a', paths: ['src/a.ts'], mapping: complete });
    const stillContained = isSnapshotCurrent({
      snapshot: built, observedFiles: ['src/a.ts'], context: context(), currentRevisionId: 'revision-a',
    });
    expect(stillContained.current).toBe(true);
    const grew = isSnapshotCurrent({
      snapshot: built, observedFiles: ['src/a.ts', 'src/b.ts'], context: context(),
      currentRevisionId: 'revision-a',
    });
    expect(grew.current).toBe(false);
    expect(grew.reasonCodes).toEqual(['ACTUAL_DIFF_EXCEEDS_SNAPSHOT']);

    const assessment = assessCandidate({
      candidate: { ...subject({ taskId: 'a', paths: ['src/a.ts'], mapping: complete }),
        observedFiles: ['src/a.ts', 'src/b.ts'] },
      active: [],
      context: context(),
    });
    expect(assessment.verdict).toBe('UNKNOWN');
    expect(assessment.reasonCodes).toEqual(['ACTUAL_DIFF_EXCEEDS_SNAPSHOT']);
  });

  it('supersedes a snapshot whose scope no longer matches the worktree', () => {
    // A recorded superset would keep reporting a conflict on a path the worktree no longer changes,
    // so a removed change supersedes the prediction instead of being reused.
    const built = snapshot({ taskId: 'a', paths: ['src/a.ts', 'src/b.ts'], mapping: complete });
    const shrunk = isSnapshotCurrent({
      snapshot: built, observedFiles: ['src/a.ts'], context: context(), currentRevisionId: 'revision-a',
    });
    expect(shrunk.current).toBe(false);
    expect(shrunk.reasonCodes).toEqual(['SNAPSHOT_SCOPE_MISMATCH']);
    const identical = isSnapshotCurrent({
      snapshot: built, observedFiles: ['src/b.ts', 'src/a.ts'], context: context(),
      currentRevisionId: 'revision-a',
    });
    expect(identical.current).toBe(true);
  });
});

describe('conflict analyzer: path case behavior', () => {
  it('treats paths differing only by case as one file on a case-insensitive filesystem', () => {
    const assessment = assess(
      { taskId: 'a', paths: ['src/Map/handler.ts'], caseMode: 'INSENSITIVE' },
      [{ taskId: 'b', paths: ['src/map/handler.ts'], caseMode: 'INSENSITIVE' }],
    );
    expect(assessment.verdict).toBe('CONFLICTING');
    expect(assessment.reasonCodes).toEqual(['SAME_FILE']);
    expect(assessment.hits[0]?.detail).toContain('differ only by case');
  });

  it('keeps them distinct on a case-sensitive filesystem', () => {
    const assessment = assess(
      { taskId: 'a', paths: ['src/Map/handler.ts'],
        mapping: mapping({ importantDirectories: ['src'] }), caseMode: 'SENSITIVE' },
      [{ taskId: 'b', paths: ['src/map/handler.ts'],
        mapping: mapping({ importantDirectories: ['src'] }), caseMode: 'SENSITIVE' }],
    );
    // Both revisions still fall inside the important directory `src`, which is a real overlap.
    expect(assessment.reasonCodes).toEqual(['IMPORTANT_DIRECTORY_OVERLAP']);
    const withoutDirectory = assess(
      { taskId: 'a', paths: ['src/Map/handler.ts'], caseMode: 'SENSITIVE' },
      [{ taskId: 'b', paths: ['src/map/handler.ts'], caseMode: 'SENSITIVE' }],
    );
    expect(withoutDirectory.verdict).toBe('SAFE_TO_PARALLELIZE');
  });
});

describe('conflict analyzer: scope validation', () => {
  it('refuses paths that are not repository-relative', () => {
    for (const path of ['/etc/passwd', '~/secrets', '../outside', 'a/../b', '.git/config', 'a//b',
      'a\\b', 'a\u0000b', '']) {
      expect(() => normalizeObservedImpactPath(path)).toThrow();
    }
    expect(normalizeObservedImpactPath('src/map/a.ts')).toBe('src/map/a.ts');
  });

  it('records an out-of-range change set as incomplete instead of truncating silently', () => {
    const many = Array.from({ length: maxImpactFiles + 5 }, (_, index) => `src/f${index}.ts`);
    const built = snapshot({ taskId: 'a', paths: many, mapping: mapping({ importantDirectories: ['src'] }) });
    expect(built.complete).toBe(false);
    expect(built.incompleteReasons).toEqual(['UNBOUNDED_SCOPE']);
    expect(built.files.length).toBe(maxImpactFiles);
  });

  it('deduplicates and sorts the observed change set', () => {
    const built = snapshot({ taskId: 'a', paths: ['b.ts', 'a.ts', 'b.ts'] });
    expect(built.files).toEqual(['a.ts', 'b.ts']);
  });
});

describe('conflict analyzer: determinism', () => {
  const a = { taskId: 'a', paths: ['src/a.ts'], mapping: mapping({ importantDirectories: ['src'] }) };
  const b = { taskId: 'b', paths: ['src/b.ts'], mapping: mapping({ importantDirectories: ['src'] }) };
  const c = { taskId: 'c', paths: ['src/c.ts'], mapping: mapping({ importantDirectories: ['src'] }) };

  it('produces identical output regardless of the order active Tasks are supplied in', () => {
    const inOrder = assess(a, [b, c]);
    const reversed = assess(a, [c, b]);
    expect(JSON.stringify(inOrder)).toBe(JSON.stringify(reversed));
  });

  it('produces identical output when the same inputs are analyzed twice', () => {
    expect(JSON.stringify(assess(a, [b]))).toBe(JSON.stringify(assess(a, [b])));
  });

  it('reports the whole intersecting scope, not a single red or green state', () => {
    const assessment = assess(
      { taskId: 'a', paths: ['src/a.ts', 'bun.lock'],
        mapping: mapping({ importantDirectories: ['src'], globalResources: [
          { id: 'lockfile', kind: 'DEPENDENCY_LOCKFILE', paths: ['bun.lock'],
            consumers: { state: 'DECLARED', paths: [] } },
        ] }) },
      [{ taskId: 'b', paths: ['src/b.ts', 'bun.lock'],
        mapping: mapping({ importantDirectories: ['src'], globalResources: [
          { id: 'lockfile', kind: 'DEPENDENCY_LOCKFILE', paths: ['bun.lock'],
            consumers: { state: 'DECLARED', paths: [] } },
        ] }) }],
    );
    expect(assessment.verdict).toBe('CONFLICTING');
    expect(assessment.reasonCodes).toEqual(['SAME_FILE', 'IMPORTANT_DIRECTORY_OVERLAP',
      'GLOBAL_RESOURCE']);
    const lines = explainAssessment(assessment);
    expect(lines[0]).toContain('verdict CONFLICTING');
    expect(lines.join('\n')).toContain('directories src');
    expect(lines.join('\n')).toContain('shared resources lockfile');
  });
});
