import { DomainError } from './errors.js';

/**
 * One Task dependency edge. The edge is directed **dependent → prerequisite**: `dependentTaskId`
 * cannot start before the revision `requiredRevisionId` of `prerequisiteTaskId` has been integrated
 * into the long-lived `dev` branch (ADR-0009). The revision is pinned on the edge so the dependency
 * does not silently follow later edits of the upstream specification.
 */
export interface DependencyEdge {
  readonly dependentTaskId: string;
  readonly prerequisiteTaskId: string;
  readonly requiredRevisionId: string;
}

export type DependencyGraphIssue =
  | { readonly code: 'INVALID_VALUE'; readonly field: string }
  | { readonly code: 'SELF_DEPENDENCY'; readonly taskId: string }
  | {
    readonly code: 'DUPLICATE_EDGE';
    readonly dependentTaskId: string;
    readonly prerequisiteTaskId: string;
  }
  | { readonly code: 'UNKNOWN_TASK'; readonly taskId: string }
  | { readonly code: 'CYCLE'; readonly cycle: readonly string[] };

function describeIssue(issue: DependencyGraphIssue): string {
  switch (issue.code) {
    case 'INVALID_VALUE':
      return `${issue.field} must not be blank`;
    case 'SELF_DEPENDENCY':
      return `Task ${issue.taskId} cannot depend on itself`;
    case 'DUPLICATE_EDGE':
      return `Dependency ${issue.dependentTaskId} -> ${issue.prerequisiteTaskId} is already in the graph`;
    case 'UNKNOWN_TASK':
      return `Task ${issue.taskId} is not part of the graph`;
    case 'CYCLE':
      return `Dependency cycle: ${issue.cycle.join(' -> ')}`;
    default: {
      const exhaustive: never = issue;
      throw new DomainError('INVALID_VALUE', `Unknown dependency graph issue: ${String(exhaustive)}`);
    }
  }
}

/**
 * Rejected graph edit. The structured `issue` is what a caller branches on; the message is only the
 * human-readable rendering, so a command face can map a cycle to its own stable error code without
 * parsing prose.
 */
export class DependencyGraphError extends DomainError {
  constructor(readonly issue: DependencyGraphIssue) {
    super('GUARD_REJECTED', describeIssue(issue));
    this.name = 'DependencyGraphError';
  }
}

export interface DependencyGraph {
  readonly edges: readonly DependencyEdge[];
  /** Every task mentioned by an edge, sorted; the graph has no other notion of a task. */
  readonly taskIds: readonly string[];
  /** Edges keyed by the dependent Task: what this Task waits for. */
  readonly prerequisitesByTask: ReadonlyMap<string, readonly DependencyEdge[]>;
  /** Edges keyed by the prerequisite Task: who waits for this Task. */
  readonly dependentsByTask: ReadonlyMap<string, readonly DependencyEdge[]>;
}

export type DependencyDirection = 'PREREQUISITES' | 'DEPENDENTS';

export function dependencyEdgeKey(dependentTaskId: string, prerequisiteTaskId: string): string {
  return `${dependentTaskId}\u0000${prerequisiteTaskId}`;
}

function requireIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DependencyGraphError({ code: 'INVALID_VALUE', field });
  }
}

function push(map: Map<string, DependencyEdge[]>, key: string, edge: DependencyEdge): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [edge]);
  else existing.push(edge);
}

/**
 * Validates and indexes an edge list. Illegal graphs are rejected here — a self-dependency, the same
 * pair twice, or an endpoint outside the declared task universe — so every later function can treat
 * the graph as structurally sound. The graph is **not** required to be acyclic: cycle detection is a
 * separate, explicit step so a rejected edit can report the cycle it would have created.
 */
export function createDependencyGraph(
  edges: readonly DependencyEdge[],
  options: { readonly knownTaskIds?: readonly string[] } = {},
): DependencyGraph {
  const seen = new Set<string>();
  const normalized: DependencyEdge[] = [];
  const taskIds = new Set<string>();
  const prerequisitesByTask = new Map<string, DependencyEdge[]>();
  const dependentsByTask = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    requireIdentifier(edge.dependentTaskId, 'dependentTaskId');
    requireIdentifier(edge.prerequisiteTaskId, 'prerequisiteTaskId');
    requireIdentifier(edge.requiredRevisionId, 'requiredRevisionId');
    if (edge.dependentTaskId === edge.prerequisiteTaskId) {
      throw new DependencyGraphError({ code: 'SELF_DEPENDENCY', taskId: edge.dependentTaskId });
    }
    const key = dependencyEdgeKey(edge.dependentTaskId, edge.prerequisiteTaskId);
    if (seen.has(key)) {
      throw new DependencyGraphError({
        code: 'DUPLICATE_EDGE',
        dependentTaskId: edge.dependentTaskId,
        prerequisiteTaskId: edge.prerequisiteTaskId,
      });
    }
    seen.add(key);
    const frozen = Object.freeze({
      dependentTaskId: edge.dependentTaskId,
      prerequisiteTaskId: edge.prerequisiteTaskId,
      requiredRevisionId: edge.requiredRevisionId,
    });
    normalized.push(frozen);
    taskIds.add(frozen.dependentTaskId);
    taskIds.add(frozen.prerequisiteTaskId);
    push(prerequisitesByTask, frozen.dependentTaskId, frozen);
    push(dependentsByTask, frozen.prerequisiteTaskId, frozen);
  }
  if (options.knownTaskIds !== undefined) {
    const known = new Set(options.knownTaskIds);
    for (const taskId of [...taskIds].sort()) {
      if (!known.has(taskId)) {
        throw new DependencyGraphError({ code: 'UNKNOWN_TASK', taskId });
      }
    }
  }
  return Object.freeze({
    edges: Object.freeze(normalized),
    taskIds: Object.freeze([...taskIds].sort()),
    prerequisitesByTask,
    dependentsByTask,
  });
}

/** `[from, ..., to]` following prerequisite edges, or null when `to` is not reachable. */
function findPrerequisitePath(
  graph: DependencyGraph,
  from: string,
  to: string,
): readonly string[] | null {
  if (from === to) return [from];
  const visited = new Set<string>([from]);
  const stack: { readonly taskId: string; readonly path: readonly string[] }[] = [
    { taskId: from, path: [from] },
  ];
  while (stack.length > 0) {
    const current = stack.pop() as { readonly taskId: string; readonly path: readonly string[] };
    for (const edge of graph.prerequisitesByTask.get(current.taskId) ?? []) {
      const next = edge.prerequisiteTaskId;
      if (next === to) return [...current.path, next];
      if (visited.has(next)) continue;
      visited.add(next);
      stack.push({ taskId: next, path: [...current.path, next] });
    }
  }
  return null;
}

/**
 * Deterministic topological order (smallest Task ID first), or null when the graph has a cycle.
 * Used both as the acyclicity check and as the scheduling order later phases need.
 */
export function topologicalOrder(graph: DependencyGraph): readonly string[] | null {
  const unresolvedPrerequisites = new Map<string, number>();
  for (const taskId of graph.taskIds) unresolvedPrerequisites.set(taskId, 0);
  for (const edge of graph.edges) {
    unresolvedPrerequisites.set(
      edge.dependentTaskId,
      (unresolvedPrerequisites.get(edge.dependentTaskId) ?? 0) + 1,
    );
  }
  const queue = graph.taskIds.filter((taskId) => unresolvedPrerequisites.get(taskId) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    queue.sort();
    const taskId = queue.shift() as string;
    order.push(taskId);
    for (const edge of graph.dependentsByTask.get(taskId) ?? []) {
      const remaining = (unresolvedPrerequisites.get(edge.dependentTaskId) ?? 0) - 1;
      unresolvedPrerequisites.set(edge.dependentTaskId, remaining);
      if (remaining === 0) queue.push(edge.dependentTaskId);
    }
  }
  return order.length === graph.taskIds.length ? Object.freeze(order) : null;
}

function findCycle(graph: DependencyGraph): readonly string[] {
  for (const edge of graph.edges) {
    const path = findPrerequisitePath(graph, edge.prerequisiteTaskId, edge.dependentTaskId);
    if (path !== null) return [edge.dependentTaskId, ...path];
  }
  // Unreachable for a graph that failed the topological check, but never guess a cycle.
  return graph.taskIds.length > 0 ? [graph.taskIds[0] as string] : [];
}

/** A reportable cycle (`a -> b -> a`) or null. */
export function detectCycle(graph: DependencyGraph): readonly string[] | null {
  if (topologicalOrder(graph) !== null) return null;
  return Object.freeze(findCycle(graph));
}

/**
 * The cycle a proposed edge would introduce, or null when the edit keeps the graph acyclic. The
 * proposed edge is *not* part of `graph`, so this answers "can I add this?" before anything is
 * written. A self-dependency is reported as the two-node cycle `[a, a]` rather than as an error, so
 * one code path covers every rejected addition.
 */
export function wouldCreateCycle(
  graph: DependencyGraph,
  edge: DependencyEdge,
): readonly string[] | null {
  if (edge.dependentTaskId === edge.prerequisiteTaskId) {
    return Object.freeze([edge.dependentTaskId, edge.dependentTaskId]);
  }
  const path = findPrerequisitePath(graph, edge.prerequisiteTaskId, edge.dependentTaskId);
  return path === null ? null : Object.freeze([edge.dependentTaskId, ...path]);
}

export function assertAcyclic(graph: DependencyGraph): DependencyGraph {
  const cycle = detectCycle(graph);
  if (cycle !== null) throw new DependencyGraphError({ code: 'CYCLE', cycle });
  return graph;
}

/**
 * Every Task reachable from `taskId` along one direction, excluding `taskId` itself. PREREQUISITES
 * is the dependency closure a Task must wait for; DEPENDENTS is the impact closure — every Task
 * whose readiness depends on this one. Both are sorted so a projection is stable.
 */
export function dependencyClosure(
  graph: DependencyGraph,
  taskId: string,
  direction: DependencyDirection,
): readonly string[] {
  const adjacency = direction === 'PREREQUISITES'
    ? graph.prerequisitesByTask
    : graph.dependentsByTask;
  const nextTaskId = direction === 'PREREQUISITES'
    ? (edge: DependencyEdge): string => edge.prerequisiteTaskId
    : (edge: DependencyEdge): string => edge.dependentTaskId;
  const reached = new Set<string>();
  const queue: string[] = [taskId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of adjacency.get(current) ?? []) {
      const target = nextTaskId(edge);
      if (target === taskId || reached.has(target)) continue;
      reached.add(target);
      queue.push(target);
    }
  }
  return Object.freeze([...reached].sort());
}

export function transitivePrerequisites(
  graph: DependencyGraph,
  taskId: string,
): readonly string[] {
  return dependencyClosure(graph, taskId, 'PREREQUISITES');
}

export function transitiveDependents(graph: DependencyGraph, taskId: string): readonly string[] {
  return dependencyClosure(graph, taskId, 'DEPENDENTS');
}

export interface DependencyImpact {
  /** Everything this Task transitively waits for. */
  readonly prerequisites: readonly string[];
  /** Everything that transitively waits for this Task. */
  readonly dependents: readonly string[];
}

export function dependencyImpact(graph: DependencyGraph, taskId: string): DependencyImpact {
  return Object.freeze({
    prerequisites: transitivePrerequisites(graph, taskId),
    dependents: transitiveDependents(graph, taskId),
  });
}
