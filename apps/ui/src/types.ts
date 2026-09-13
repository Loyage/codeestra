/**
 * View types for the Runtime API.
 *
 * These mirror only the fields this client renders. The Runtime remains authoritative: every
 * response is validated there with the shared Zod contracts before it is sent, and this client
 * re-checks `ok` instead of assuming a shape.
 */

export interface TrustedProjectView {
  readonly id: string;
  readonly name: string;
  readonly repoRoot: string;
  readonly mainRef: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly trustedAt: number;
}

export interface TaskRevisionView {
  readonly id: string;
  readonly number: number;
  readonly specification: string;
  readonly constraints: readonly { readonly id: string; readonly text: string }[];
  readonly createdAt: number;
}

export interface TaskView {
  readonly id: string;
  readonly projectId: string;
  readonly displayNumber: number;
  readonly kind: 'DEVELOPMENT' | 'SELF';
  readonly state: string;
  readonly priority: number;
  readonly version: number;
  readonly currentRevision: TaskRevisionView;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ExecutionView {
  readonly executionId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly state: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly resourceHeld: boolean;
  readonly baseCommit: string;
  readonly revisionId: string;
  /** Recorded failure reason; `null` while running or when none was recorded. */
  readonly error: { readonly code: string; readonly message?: string } | null;
  readonly session: {
    readonly sessionId: string;
    readonly state: string;
    readonly providerSessionId: string | null;
    readonly cursor: string | null;
  } | null;
}

export interface VerificationCommandView {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds: number;
}

export interface VerificationRunView {
  readonly verificationId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly revisionId: string;
  readonly testedCommit: string;
  readonly policyDigest: string;
  readonly mainCommit: string;
  readonly commands: readonly VerificationCommandView[];
  readonly copyPath: string;
  readonly state: string;
  readonly outcomeCode: string | null;
  readonly evidence: Readonly<Record<string, unknown>> | null;
  readonly queuedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

export interface TaskStatusView {
  readonly task: TaskView;
  readonly executions: readonly ExecutionView[];
  readonly verifications: readonly VerificationRunView[];
}

export interface AttentionView {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly providerRequestId: string;
  readonly kind: 'QUESTION' | 'PERMISSION' | 'RECOVERY';
  readonly responseType: 'CONFIRM' | 'VALUE';
  readonly prompt: unknown;
  readonly status: string;
  readonly createdAt: number;
}

export interface RepositoryIdentityView {
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly headCommit: string;
}

export interface VerificationPolicyView {
  readonly state: 'PRESENT' | 'ABSENT';
  readonly mainCommit: string;
  readonly digest: string | null;
  readonly policy: {
    readonly version: number;
    readonly commands: readonly VerificationCommandView[];
  } | null;
}

export interface ResultCommitAuthorizationView {
  readonly id: string;
  readonly taskDisplayNumber: number;
  readonly taskVersion: number;
  readonly executionId: string;
  readonly baseCommit: string;
  readonly expectedHead: string;
  readonly changeFingerprint: string;
  readonly status: 'ACTIVE' | 'CONSUMED' | 'INVALIDATED';
  readonly resultCommit: string | null;
  readonly quiescent: boolean;
  readonly sessionState: string | null;
  readonly workspacePath: string;
}

export interface EventEnvelopeView {
  readonly eventId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly projectId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly occurredAt: number;
  readonly payload: unknown;
}

export type StreamFrame =
  | { readonly schemaVersion: 1; readonly type: 'subscribed'; readonly requestId: string;
      readonly cursor: number; readonly projectId: string | null }
  | { readonly schemaVersion: 1; readonly type: 'event'; readonly cursor: number;
      readonly event: EventEnvelopeView }
  | { readonly schemaVersion: 1; readonly type: 'heartbeat'; readonly cursor: number }
  | { readonly schemaVersion: 1; readonly type: 'error'; readonly code: string;
      readonly message: string };
