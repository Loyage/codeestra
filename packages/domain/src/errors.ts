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
  | 'INVALID_IMPACT_MAPPING';

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
