import { DomainError, requireText, requireVersion } from './errors.js';

export interface Constraint {
  readonly id: string;
  readonly text: string;
}

export interface RevisionInput {
  readonly id: string;
  readonly specification: string;
  readonly constraints: readonly Constraint[];
  readonly actor: string;
  readonly reason: string;
  readonly sourceIntentId: string | null;
  readonly createdAt: number;
}

export interface TaskRevision extends RevisionInput {
  readonly taskId: string;
  readonly number: number;
  readonly previousRevisionId: string | null;
}

/** Specification history only, not the entire Task aggregate or its lifecycle. */
export interface SpecificationHistory {
  readonly taskId: string;
  readonly version: number;
  readonly currentRevision: TaskRevision;
  readonly revisions: readonly TaskRevision[];
}

function snapshot(
  taskId: string,
  input: RevisionInput,
  number: number,
  previousRevisionId: string | null,
): TaskRevision {
  requireText(taskId, 'taskId');
  for (const key of ['id', 'specification', 'actor', 'reason'] as const) {
    requireText(input[key], key);
  }
  if (input.sourceIntentId !== null) requireText(input.sourceIntentId, 'sourceIntentId');
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new DomainError('INVALID_VALUE', 'createdAt must be UTC epoch milliseconds');
  }
  const ids = new Set<string>();
  const constraints = input.constraints.map((constraint) => {
    requireText(constraint.id, 'constraint.id');
    requireText(constraint.text, 'constraint.text');
    if (ids.has(constraint.id)) {
      throw new DomainError('INVALID_VALUE', 'Duplicate constraint ID');
    }
    ids.add(constraint.id);
    return Object.freeze({ id: constraint.id, text: constraint.text });
  });
  return Object.freeze({
    id: input.id,
    taskId,
    number,
    previousRevisionId,
    specification: input.specification,
    constraints: Object.freeze(constraints),
    actor: input.actor,
    reason: input.reason,
    sourceIntentId: input.sourceIntentId,
    createdAt: input.createdAt,
  });
}

export function createSpecificationHistory(
  taskId: string,
  input: RevisionInput,
): SpecificationHistory {
  const revision = snapshot(taskId, input, 1, null);
  return Object.freeze({
    taskId,
    version: 0,
    currentRevision: revision,
    revisions: Object.freeze([revision]),
  });
}

export function appendTaskRevision(
  history: SpecificationHistory,
  expectedVersion: number,
  input: RevisionInput,
): SpecificationHistory {
  requireVersion(history.version, expectedVersion);
  if (history.revisions.some((revision) => revision.id === input.id)) {
    throw new DomainError('INVALID_VALUE', 'Revision ID must be new');
  }
  if (history.currentRevision.number === Number.MAX_SAFE_INTEGER) {
    throw new DomainError('INVALID_VALUE', 'Revision number exhausted');
  }
  const revision = snapshot(
    history.taskId,
    input,
    history.currentRevision.number + 1,
    history.currentRevision.id,
  );
  return Object.freeze({
    taskId: history.taskId,
    version: history.version + 1,
    currentRevision: revision,
    revisions: Object.freeze([...history.revisions, revision]),
  });
}
