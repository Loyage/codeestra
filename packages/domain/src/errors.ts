export type DomainErrorCode =
  | 'INVALID_VALUE'
  | 'VERSION_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'GUARD_REJECTED'
  // Revision delivery (ADR-0028). A delivery may only be satisfied by a real acknowledgement or by
  // a verified successor Execution, so the ways it can be violated are distinct, stable codes.
  | 'REVISION_ALREADY_ACKNOWLEDGED'
  | 'STALE_REVISION_ACKNOWLEDGEMENT'
  | 'SUCCESSOR_REVISION_MISMATCH'
  // Impact analysis (ADR-0031). A scope that is not a set of repository-relative paths, or a
  // mapping that cannot be derived from, is a rejected input rather than a weaker verdict.
  | 'INVALID_IMPACT_SCOPE'
  | 'INVALID_IMPACT_MAPPING'
  // Service kernel (ADR-0070 / S1). These errors are pure domain refusals: callers may map them to
  // CLI stable codes, but the domain never imports a transport, database, or Agent SDK.
  | 'DUPLICATE_SERVICE'
  | 'INVALID_SERVICE_TREE'
  | 'INVALID_SERVICE_PARENT'
  | 'SERVICE_TREE_CYCLE'
  | 'INVALID_METADATA_KEY'
  | 'INVALID_METADATA_VALUE'
  | 'INVALID_SIGNAL_TRANSITION'
  | 'INVALID_PROCESS_TRANSITION'
  | 'PROCESS_TERMINAL'
  | 'PROCESS_PREDECESSOR_ACTIVE'
  | 'PROCESS_AGENT_CARDINALITY'
  // Intention routing (ADR-0070 §8 / S6 lane contract §3). A structured outcome that cannot be
  // routed is refused with its own code: none of these is an approval, a permission decision or a
  // weakened judgement, and the domain that raises them imports no transport or database.
  | 'INTENTION_PROCESS_NOT_RESOLVABLE'
  | 'INTENTION_TARGET_NOT_VISIBLE'
  | 'INVALID_INTENTION_OUTCOME'
  | 'INTENTION_CREATE_TASK_UNSUPPORTED'
  | 'INTENTION_CLARIFICATION_OPEN'
  | 'INTENTION_CLARIFICATION_NOT_FOUND'
  | 'INTENTION_CLARIFICATION_MISMATCH'
  | 'INTENTION_GUIDANCE_UNAVAILABLE'
  | 'INTENTION_GUIDANCE_CHANNEL_UNAVAILABLE';

export class DomainError extends Error {
  constructor(readonly code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

export function requireText(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError('INVALID_VALUE', `${name} must not be empty`);
  }
}

export function requireVersion(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0 || actual !== expected) {
    throw new DomainError('VERSION_CONFLICT', 'Aggregate version does not match');
  }
  if (actual === Number.MAX_SAFE_INTEGER) {
    throw new DomainError('INVALID_VALUE', 'Aggregate version exhausted');
  }
}
