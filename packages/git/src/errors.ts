export type GitErrorCode = 'INVALID_REPOSITORY' | 'UNBORN_MAIN' | 'COMMAND_FAILED'
  | 'STALE_BASE' | 'MISSING_BASE_REF' | 'REF_CONFLICT' | 'FOREIGN_RESOURCE' | 'UNSAFE_CHECKOUT'
  | 'UNRESOLVED_CHANGE' | 'IDENTITY_NOT_CONFIGURED'
  | 'SENSITIVE_PATH_BLOCKED' | 'NOTHING_TO_COMMIT' | 'COMMIT_FAILED' | 'COMMIT_MISMATCH';

export class GitInspectionError extends Error {
  constructor(readonly code: GitErrorCode, message: string, readonly reconcileRequired = false) {
    super(message);
    this.name = 'GitInspectionError';
  }
}
