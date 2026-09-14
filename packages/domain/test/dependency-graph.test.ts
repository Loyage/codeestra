import { describe, expect, it } from 'vitest';
import {
  DependencyGraphError,
  assertAcyclic,
  createDependencyGraph,
  dependencyClosure,
  dependencyEdgeKey,
  dependencyImpact,
  detectCycle,
  topologicalOrder,
  transitiveDependents,
  transitivePrerequisites,
  wouldCreateCycle,
  type DependencyEdge,
  type DependencyGraphIssue,
} from '../src/index.js';

const edge = (dependentTaskId: string, prerequisiteTaskId: string): DependencyEdge => ({
  dependentTaskId,
  prerequisiteTaskId,
  requiredRevisionId: `${prerequisiteTaskId}-revision-1`,
});

/** Linear chain a -> b -> c, read as "a depends on b, b depends on c". */
const chain = (): readonly DependencyEdge[] => [edge('a', 'b'), edge('b', 'c')];
/** Diamond: d depends on b and c, both depend on a. */
const diamond = (): readonly DependencyEdge[] => [
  edge('d', 'b'), edge('d', 'c'), edge('b', 'a'), edge('c', 'a'),
];

function issueOf(run: () => unknown): DependencyGraphIssue {
  try {
    run();
  } catch (error) {
    if (error instanceof DependencyGraphError) return error.issue;
    throw error;
  }
  throw new Error('Expected the graph operation to be rejected');
}

describe('dependency graph construction', () => {
  it('indexes both directions and freezes every node', () => {
    const graph = createDependencyGraph(chain());
    expect(graph.taskIds).toEqual(['a', 'b', 'c']);
    expect(graph.edges).toHaveLength(2);
    expect(graph.prerequisitesByTask.get('a')?.map((entry) => entry.prerequisiteTaskId)).toEqual(['b']);
    expect(graph.dependentsByTask.get('c')?.map((entry) => entry.dependentTaskId)).toEqual(['b']);
    expect(graph.prerequisitesByTask.get('c')).toBeUndefined();
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.edges[0])).toBe(true);
  });

  it('accepts an empty graph', () => {
    const graph = createDependencyGraph([]);
    expect(graph.taskIds).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(topologicalOrder(graph)).toEqual([]);
    expect(detectCycle(graph)).toBeNull();
  });

  it('rejects a self-dependency', () => {
    expect(issueOf(() => createDependencyGraph([edge('a', 'a')])))
      .toEqual({ code: 'SELF_DEPENDENCY', taskId: 'a' });
  });

  it('rejects the same pair twice', () => {
    expect(issueOf(() => createDependencyGraph([edge('a', 'b'), edge('a', 'b')])))
      .toEqual({ code: 'DUPLICATE_EDGE', dependentTaskId: 'a', prerequisiteTaskId: 'b' });
  });

  it('rejects blank identifiers', () => {
    expect(issueOf(() => createDependencyGraph([edge('a', '  ')])))
      .toEqual({ code: 'INVALID_VALUE', field: 'prerequisiteTaskId' });
    expect(issueOf(() => createDependencyGraph([{ ...edge('a', 'b'), requiredRevisionId: '' }])))
      .toEqual({ code: 'INVALID_VALUE', field: 'requiredRevisionId' });
  });

  it('rejects an endpoint outside the declared task universe', () => {
    expect(issueOf(() => createDependencyGraph(chain(), { knownTaskIds: ['a', 'b'] })))
      .toEqual({ code: 'UNKNOWN_TASK', taskId: 'c' });
    expect(createDependencyGraph(chain(), { knownTaskIds: ['a', 'b', 'c'] }).edges).toHaveLength(2);
  });

  it('keys an edge by the ordered pair', () => {
    expect(dependencyEdgeKey('a', 'b')).not.toBe(dependencyEdgeKey('b', 'a'));
  });
});

describe('cycle detection', () => {
  it('accepts a chain and a diamond as acyclic', () => {
    expect(detectCycle(createDependencyGraph(chain()))).toBeNull();
    expect(detectCycle(createDependencyGraph(diamond()))).toBeNull();
    expect(topologicalOrder(createDependencyGraph(diamond()))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('detects a direct cycle', () => {
    const cycle = detectCycle(createDependencyGraph([edge('a', 'b'), edge('b', 'a')]));
    expect(cycle).not.toBeNull();
    expect(cycle?.[0]).toBe(cycle?.at(-1));
    expect([...(cycle ?? [])].sort()).toEqual(['a', 'a', 'b']);
  });

  it('detects an indirect cycle', () => {
    const cycle = detectCycle(createDependencyGraph([edge('a', 'b'), edge('b', 'c'), edge('c', 'a')]));
    expect(cycle?.[0]).toBe(cycle?.at(-1));
    expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('detects a cycle that leaves an acyclic prefix untouched', () => {
    // x -> a -> b -> c -> a: the cycle is inside the component reachable from x.
    const graph = createDependencyGraph([
      edge('x', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'a'),
    ]);
    expect(topologicalOrder(graph)).toBeNull();
    expect(new Set(detectCycle(graph))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('assertAcyclic returns the graph or reports the cycle path', () => {
    const acyclic = createDependencyGraph(chain());
    expect(assertAcyclic(acyclic)).toBe(acyclic);
    expect(issueOf(() => assertAcyclic(createDependencyGraph([edge('a', 'b'), edge('b', 'a')]))).code)
      .toBe('CYCLE');
  });
});

describe('proposed edge validation', () => {
  it('reports a cycle a proposed edge would introduce without mutating the graph', () => {
    const graph = createDependencyGraph(chain()); // a -> b -> c
    const cycle = wouldCreateCycle(graph, edge('c', 'a'));
    expect(cycle?.[0]).toBe('c');
    expect(cycle?.[0]).toBe(cycle?.at(-1));
    expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']));
    expect(graph.edges).toHaveLength(2);
  });

  it('accepts an edge that keeps the graph acyclic', () => {
    expect(wouldCreateCycle(createDependencyGraph(chain()), edge('c', 'd'))).toBeNull();
    // The same pair in the other direction is fine when nothing depends back on it.
    expect(wouldCreateCycle(createDependencyGraph(chain()), edge('c', 'a'))).not.toBeNull();
  });

  it('reports a self-dependency as a two-node cycle', () => {
    expect(wouldCreateCycle(createDependencyGraph(chain()), edge('a', 'a'))).toEqual(['a', 'a']);
  });
});

describe('closure and impact', () => {
  it('walks the full transitive closure, not just the direct edges', () => {
    const graph = createDependencyGraph([...chain(), edge('c', 'd')]);
    expect(transitivePrerequisites(graph, 'a')).toEqual(['b', 'c', 'd']);
    expect(transitiveDependents(graph, 'd')).toEqual(['a', 'b', 'c']);
    // The Task itself is never part of its own closure.
    expect(transitivePrerequisites(graph, 'a')).not.toContain('a');
    expect(transitiveDependents(graph, 'a')).toEqual([]);
  });

  it('de-duplicates a diamond', () => {
    const graph = createDependencyGraph(diamond());
    expect(transitivePrerequisites(graph, 'd')).toEqual(['a', 'b', 'c']);
    expect(transitiveDependents(graph, 'a')).toEqual(['b', 'c', 'd']);
    expect(dependencyImpact(graph, 'b')).toEqual({ prerequisites: ['a'], dependents: ['d'] });
  });

  it('terminates on a cyclic graph and never returns the start Task', () => {
    const graph = createDependencyGraph([edge('a', 'b'), edge('b', 'a')]);
    expect(dependencyClosure(graph, 'a', 'PREREQUISITES')).toEqual(['b']);
    expect(dependencyClosure(graph, 'a', 'DEPENDENTS')).toEqual(['b']);
  });

  it('returns an empty closure for an unknown Task', () => {
    const graph = createDependencyGraph(chain());
    expect(transitivePrerequisites(graph, 'missing')).toEqual([]);
    expect(transitiveDependents(graph, 'missing')).toEqual([]);
  });
});
