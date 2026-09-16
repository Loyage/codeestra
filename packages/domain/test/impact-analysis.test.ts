import { describe, expect, it } from 'vitest';
import {
  assessCandidate,
  createImpactSnapshot,
  explainAssessment,
  impactAnalyzerVersion,
  impactDirectoriesOverlap,
  impactPatternMatches,
  isSnapshotCurrent,
  maxImpactFiles,
  normalizeObservedImpactPath,
  taskIsUnfinishedForConflict,
  type ConflictAssessment,
  type ImpactAssessmentContext,
  type ImpactIncompleteReason,
  type ImpactMapping,
  type ImpactPathCaseMode,
  type ImpactSnapshot,
  type ImpactSubject,
} from '../src/index.js';

/**
 * The conflict rule of ADR-0059: **two unfinished Tasks that declare the same feature conflict**, and
 * nothing else does. File overlap is deliberately *not* a conflict any more, which is the change the
 * tests below pin down — several of them assert `SAFE` for inputs the previous rule called
 * `CONFLICTING`.
 *
 * What this file does not cover: that a declared feature id exists in the project's mapping (that is
 * validated when the Task is written, in `apps/runtime`), and that the scheduler acts on the verdict.
 */

const baseCommit = 'a'.repeat(40);
const digest = 'f'.repeat(64);
const policyVersion = `impact-policy-v1#${digest.slice(0, 12)}`;

const mapping = (overrides: Partial<ImpactMapping> = {}): ImpactMapping => ({
  importantDirectories: [],
  modules: [],
  globalResources: [],
  ...overrides,
});

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
    mapping: options.mapping === undefined ? mapping() : options.mapping,
    ...(options.incompleteReasons === undefined
      ? {}
      : { incompleteReasons: options.incompleteReasons }),
    ...(options.analyzerVersion === undefined ? {} : { analyzerVersion: options.analyzerVersion }),
  });
}

/** A subject for the *verdict*: declarations and state are what count, the snapshot is evidence. */
function subject(options: {
  readonly taskId?: string;
  readonly revisionId?: string;
  readonly features?: readonly string[];
  readonly taskState?: string;
  readonly archived?: boolean;
  readonly withSnapshot?: SnapshotOptions | null;
} = {}): ImpactSubject {
  const built = options.withSnapshot === null || options.withSnapshot === undefined
    ? null
    : snapshot({ taskId: options.taskId ?? 'task-a', ...options.withSnapshot });
  return {
    taskId: options.taskId ?? 'task-a',
    currentRevisionId: options.revisionId ?? 'revision-a',
    features: options.features ?? Object.freeze([]),
    taskState: options.taskState ?? 'RUNNING',
    archived: options.archived ?? false,
    snapshot: built,
    observedFiles: built?.files ?? [],
  };
}

function assess(candidate: ImpactSubject, active: readonly ImpactSubject[] = [],
  overrides: Partial<ImpactAssessmentContext> = {}): ConflictAssessment {
  return assessCandidate({ candidate, active: [...active], context: context(overrides) });
}

describe('conflict rule: same unfinished feature', () => {
  it('conflicts when both declare the same feature and the peer has not finished it', () => {
    for (const taskState of ['DRAFT', 'BLOCKED', 'READY', 'RUNNING', 'PAUSING', 'PAUSED',
      'WAITING_FOR_USER', 'RECOVERY_REQUIRED', 'EXECUTED', 'FAILED', 'CANCELLING']) {
      const assessment = assess(
        subject({ taskId: 'a', features: ['scheduler'] }),
        [subject({ taskId: 'b', features: ['scheduler'], taskState })],
      );
      expect(assessment.verdict).toBe('CONFLICTING');
      expect(assessment.reasonCodes).toEqual(['SAME_UNFINISHED_FEATURE']);
      expect(assessment.hits[0]).toMatchObject({
        class: 'CONFLICT', taskId: 'b', features: ['scheduler'], relation: 'SAME_FEATURE',
      });
      expect(assessment.hits[0]?.detail).toContain(taskState);
    }
  });

  it('reports every shared feature, sorted, and only the shared ones', () => {
    const assessment = assess(
      subject({ taskId: 'a', features: ['runtime', 'scheduler', 'storage'] }),
      [subject({ taskId: 'b', features: ['storage', 'scheduler', 'cli'] })],
    );
    expect(assessment.hits[0]?.features).toEqual(['scheduler', 'storage']);
    expect(explainAssessment(assessment).join('\n')).toContain('features scheduler, storage');
  });

  it('is safe once the only Task working on the feature finished or was retired', () => {
    for (const taskState of ['SUCCEEDED', 'CANCELLED']) {
      const assessment = assess(
        subject({ taskId: 'a', features: ['scheduler'] }),
        [subject({ taskId: 'b', features: ['scheduler'], taskState })],
      );
      expect(assessment.verdict).toBe('SAFE_TO_PARALLELIZE');
      expect(assessment.reasonCodes).toEqual(['NO_CONFLICT']);
      expect(assessment.safePairs.map((pair) => pair.taskId)).toEqual(['b']);
    }
  });

  it('is safe against an archived Task whatever its state says', () => {
    // Archiving is the user saying "this is not in flight"; a DRAFT that was archived must not block.
    const assessment = assess(
      subject({ taskId: 'a', features: ['scheduler'] }),
      [subject({ taskId: 'b', features: ['scheduler'], taskState: 'RUNNING', archived: true })],
    );
    expect(assessment.verdict).toBe('SAFE_TO_PARALLELIZE');
  });

  it('is safe when the declarations do not intersect, either way round', () => {
    const disjoint = assess(
      subject({ taskId: 'a', features: ['scheduler'] }),
      [subject({ taskId: 'b', features: ['storage'] })],
    );
    expect(disjoint.verdict).toBe('SAFE_TO_PARALLELIZE');
    const undeclaredPeer = assess(
      subject({ taskId: 'a', features: ['scheduler'] }),
      [subject({ taskId: 'b' })],
    );
    expect(undeclaredPeer.verdict).toBe('SAFE_TO_PARALLELIZE');
    const undeclaredCandidate = assess(
      subject({ taskId: 'a' }),
      [subject({ taskId: 'b', features: ['scheduler'] })],
    );
    expect(undeclaredCandidate.verdict).toBe('SAFE_TO_PARALLELIZE');
    expect(undeclaredCandidate.evidence.join('\n')).toContain('declares no feature');
  });
});

describe('conflict rule: file overlap is no longer a conflict', () => {
  it('is safe when two Tasks change the very same file and declare nothing', () => {
    // This is the deliberate reversal of the old `SAME_FILE` rule: two Agents editing one file is the
    // user's risk to take, and the verdict now answers the question the user asked.
    const shared = { paths: ['apps/runtime/src/main.ts'] };
    const assessment = assess(
      subject({ taskId: 'a', withSnapshot: shared }),
      [subject({ taskId: 'b', withSnapshot: shared })],
    );
    expect(assessment.verdict).toBe('SAFE_TO_PARALLELIZE');
    expect(assessment.reasonCodes).toEqual(['NO_CONFLICT']);
  });

  it('is safe when they share an important directory, a module scope or a global resource', () => {
    const overlapping = mapping({
      importantDirectories: ['apps/runtime'],
      modules: [{ id: 'runtime', paths: ['apps/runtime/**'] }],
      globalResources: [{ id: 'lockfile', kind: 'DEPENDENCY_LOCKFILE', paths: ['bun.lock'],
        consumers: { state: 'UNKNOWN' } }],
    });
    const assessment = assess(
      subject({ taskId: 'a', withSnapshot: { paths: ['bun.lock'], mapping: overlapping } }),
      [subject({ taskId: 'b', withSnapshot: { paths: ['bun.lock'], mapping: overlapping } })],
    );
    expect(assessment.verdict).toBe('SAFE_TO_PARALLELIZE');
  });
});

describe('conflict rule: missing facts are not a conflict and not UNKNOWN', () => {
  it('judges a Task that has no snapshot at all by its declaration', () => {
    // A `READY` Task has no worktree, so it has no observed change set. Under the old rule that was
    // `MISSING_IMPACT_SNAPSHOT` → `UNKNOWN` → wait, which made the primary case unstartable.
    const conflicting = assess(
      subject({ taskId: 'a', features: ['scheduler'], withSnapshot: null }),
      [subject({ taskId: 'b', features: ['scheduler'], withSnapshot: null })],
    );
    expect(conflicting.verdict).toBe('CONFLICTING');
    const safe = assess(
      subject({ taskId: 'a', features: ['scheduler'], withSnapshot: null }),
      [subject({ taskId: 'b', features: ['storage'], withSnapshot: null })],
    );
    expect(safe.verdict).toBe('SAFE_TO_PARALLELIZE');
    expect(safe.evidence.join('\n')).toContain('no change set was observed');
  });

  it('never produces UNKNOWN, whatever the snapshots look like', () => {
    const incomplete = subject({ taskId: 'b', features: ['storage'],
      withSnapshot: { incompleteReasons: ['POLICY_ABSENT'] } });
    const stale = subject({ taskId: 'c', features: ['storage'],
      withSnapshot: { base: 'b'.repeat(40) } });
    const invalidAnalyzer = subject({ taskId: 'd', features: ['storage'],
      withSnapshot: { analyzerVersion: 'impact-analyzer-v1' } });
    const assessment = assess(subject({ taskId: 'a', features: ['scheduler'] }),
      [incomplete, stale, invalidAnalyzer]);
    expect(assessment.verdict).toBe('SAFE_TO_PARALLELIZE');
    // The candidate in this case has no snapshot at all, and that is still not an UNKNOWN: the
    // verdict is about declarations.
    expect(assessment.candidateComplete).toBe(false);
    expect(assessment.candidateIncompleteReasons).toEqual([]);
  });
});

describe('conflict rule: determinism and explanation', () => {
  const a = subject({ taskId: 'a', features: ['scheduler'] });
  const b = subject({ taskId: 'b', features: ['scheduler'] });
  const c = subject({ taskId: 'c', features: ['scheduler'], taskState: 'FAILED' });

  it('produces identical output regardless of the order the peers are supplied in', () => {
    expect(JSON.stringify(assess(a, [b, c]))).toBe(JSON.stringify(assess(a, [c, b])));
  });

  it('reports the compared Tasks even when every pair is safe', () => {
    const assessment = assess(a, [subject({ taskId: 'b', features: ['storage'] }),
      subject({ taskId: 'c', features: ['cli'] })]);
    expect(assessment.comparedTaskIds).toEqual(['b', 'c']);
    expect(assessment.safePairs.map((pair) => pair.taskId)).toEqual(['b', 'c']);
  });

  it('explains a conflict with the feature scope and the peer state', () => {
    const lines = explainAssessment(assess(a, [b]));
    expect(lines[0]).toContain('verdict CONFLICTING (SAME_UNFINISHED_FEATURE)');
    expect(lines.join('\n')).toContain('features scheduler');
    expect(lines.join('\n')).toContain('is RUNNING, which is not finished yet');
    expect(lines.join('\n')).toContain('evidence:');
  });

  it('says out loud that SAFE is about declarations, not about files', () => {
    const lines = explainAssessment(assess(a, [subject({ taskId: 'b', features: ['storage'] })]));
    expect(lines.join('\n')).toContain('the rule compares declarations, not file overlap');
  });
});

describe('taskIsUnfinishedForConflict', () => {
  it('is true for every state but the two terminal ones, and false for archived Tasks', () => {
    for (const state of ['DRAFT', 'BLOCKED', 'READY', 'RUNNING', 'PAUSED', 'EXECUTED', 'FAILED']) {
      expect(taskIsUnfinishedForConflict({ state, archived: false })).toBe(true);
      expect(taskIsUnfinishedForConflict({ state, archived: true })).toBe(false);
    }
    for (const state of ['SUCCEEDED', 'CANCELLED']) {
      expect(taskIsUnfinishedForConflict({ state, archived: false })).toBe(false);
    }
  });
});

describe('impact snapshots still record what was observed', () => {
  it('records an out-of-range change set as incomplete instead of truncating silently', () => {
    const many = Array.from({ length: maxImpactFiles + 5 }, (_, index) => `src/f${index}.ts`);
    const built = snapshot({ taskId: 'a', paths: many,
      mapping: mapping({ importantDirectories: ['src'] }) });
    expect(built.complete).toBe(false);
    expect(built.incompleteReasons).toEqual(['UNBOUNDED_SCOPE']);
    expect(built.files.length).toBe(maxImpactFiles);
  });

  it('deduplicates and sorts the observed change set', () => {
    expect(snapshot({ taskId: 'a', paths: ['b.ts', 'a.ts', 'b.ts'] }).files)
      .toEqual(['a.ts', 'b.ts']);
  });

  it('refuses paths that are not repository-relative', () => {
    for (const path of ['/etc/passwd', '~/secrets', '../outside', 'a/../b', '.git/config', 'a//b',
      'a\\b', 'a\u0000b', '']) {
      expect(() => normalizeObservedImpactPath(path)).toThrow();
    }
    expect(normalizeObservedImpactPath('src/map/a.ts')).toBe('src/map/a.ts');
  });

  it('compares directory components rather than prefixes', () => {
    expect(impactDirectoriesOverlap('src/map', 'src/map')).toBe(true);
    expect(impactDirectoriesOverlap('src/map', 'src/mapping')).toBe(false);
    expect(impactPatternMatches('src/map/a.ts', 'src/map/**')).toBe(true);
    expect(impactPatternMatches('src/mapping/a.ts', 'src/map/**')).toBe(false);
    expect(impactPatternMatches('src/map/a.ts', 'src/map/a.ts')).toBe(true);
  });

  it('reports a snapshot as current only while its generation still matches', () => {
    const built = snapshot({ taskId: 'a' });
    expect(isSnapshotCurrent({
      snapshot: built, observedFiles: built.files, context: context(),
      currentRevisionId: built.revisionId,
    })).toEqual({ current: true, reasonCodes: [] });
    expect(isSnapshotCurrent({
      snapshot: built, observedFiles: built.files, context: context(),
      currentRevisionId: 'revision-b',
    })).toEqual({ current: false, reasonCodes: ['STALE_REVISION'] });
  });
});
