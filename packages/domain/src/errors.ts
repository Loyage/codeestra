export type DomainErrorCode =
  | 'INVALID_VALUE'
  | 'VERSION_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'GUARD_REJECTED';

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
