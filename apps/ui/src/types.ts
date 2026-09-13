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

export interface AgentConfigurationView {
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinkingLevel: string | null;
}

/** One persisted scope; the timestamps say who last changed it. */
export interface AgentConfigurationScopeView extends AgentConfigurationView {
  readonly updatedAt: number;
  readonly updatedBy: string;
}

/**
 * The Runtime's resolution of the effective Agent configuration for one project. `sources` names
 * the layer each field came from, so the client can explain precedence instead of guessing.
 */
export interface AgentConfigurationResolutionView {
  readonly adapterId: string;
  readonly projectId: string | null;
  readonly global: AgentConfigurationScopeView | null;
  readonly project: AgentConfigurationScopeView | null;
  readonly environment: AgentConfigurationView | null;
  readonly effective: AgentConfigurationView;
  readonly sources: {
    readonly provider: string;
    readonly model: string;
    readonly thinkingLevel: string;
  };
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
  /** Effective Agent configuration recorded when the Execution was reserved. */
  readonly agentConfig: AgentConfigurationView | null;
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

/**
 * The Runtime's read-only view of the provider's own session file. It is an observation of what
 * the Agent did, not a Codeestra event: nothing here is authoritative business state.
 */
export interface SessionTranscriptPart {
  readonly partIndex: number;
  readonly type: 'TEXT' | 'THINKING' | 'TOOL_CALL' | 'IMAGE' | 'OTHER';
  /** Bounded preview; `truncated` means `session.transcript.part` returns more. */
  readonly text: string;
  readonly truncated: boolean;
  readonly fullChars: number;
  readonly name: string | null;
  readonly toolCallId: string | null;
}

export interface SessionTranscriptUsage {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly reasoning: number | null;
  readonly total: number | null;
  readonly cost: number | null;
}

export interface SessionTranscriptEntry {
  readonly entryId: string;
  readonly parentId: string | null;
  readonly timestamp: string | null;
  readonly kind: 'USER' | 'ASSISTANT' | 'TOOL_RESULT' | 'MODEL_CHANGE' | 'THINKING_LEVEL_CHANGE'
    | 'OTHER';
  readonly role: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly stopReason: string | null;
  readonly toolName: string | null;
  readonly toolCallId: string | null;
  readonly isError: boolean | null;
  readonly usage: SessionTranscriptUsage | null;
  readonly parts: readonly SessionTranscriptPart[];
  readonly note: string | null;
}

export interface SessionTranscriptView {
  readonly sessionId: string;
  readonly executionId: string;
  readonly taskDisplayNumber: number;
  readonly attemptNumber: number;
  readonly executionState: string;
  readonly sessionState: string;
  readonly providerSessionId: string | null;
  readonly fileAvailable: boolean;
  readonly note: string | null;
  readonly entries: readonly SessionTranscriptEntry[];
  readonly cursor: string | null;
  readonly hasMore: boolean;
  readonly unparsedLines: number;
  readonly partPreviewChars: number;
}

export interface SessionTranscriptPartView {
  readonly sessionId: string;
  readonly entryId: string;
  readonly partIndex: number;
  readonly type: SessionTranscriptPart['type'];
  readonly name: string | null;
  readonly toolCallId: string | null;
  readonly text: string;
  readonly fullChars: number;
  readonly truncated: boolean;
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

/**
 * A Codeestra questionnaire as this client renders it. The Runtime already validated the shape
 * before storing it; this client still re-checks structurally instead of trusting `prompt`, and
 * falls back to the raw prompt view when the shape is not one it knows.
 */
export interface QuestionnaireOptionView {
  readonly label: string;
  readonly description: string;
}

export interface QuestionnaireQuestionView {
  readonly question: string;
  readonly header: string;
  readonly multiSelect: boolean;
  readonly options: readonly QuestionnaireOptionView[];
}

export interface QuestionnaireView {
  readonly questions: readonly QuestionnaireQuestionView[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function questionnaireFromPrompt(prompt: unknown): QuestionnaireView | null {
  if (!isRecord(prompt) || prompt['kind'] !== 'codeestra.questionnaire') return null;
  const questionnaire = prompt['questionnaire'];
  if (!isRecord(questionnaire) || !Array.isArray(questionnaire['questions'])) return null;
  const questions: QuestionnaireQuestionView[] = [];
  for (const candidate of questionnaire['questions']) {
    if (!isRecord(candidate) || typeof candidate['question'] !== 'string'
      || typeof candidate['header'] !== 'string' || typeof candidate['multiSelect'] !== 'boolean'
      || !Array.isArray(candidate['options'])) return null;
    const options: QuestionnaireOptionView[] = [];
    for (const option of candidate['options']) {
      if (!isRecord(option) || typeof option['label'] !== 'string'
        || typeof option['description'] !== 'string') return null;
      options.push({ label: option['label'], description: option['description'] });
    }
    if (options.length < 2) return null;
    questions.push({ question: candidate['question'], header: candidate['header'],
      multiSelect: candidate['multiSelect'], options });
  }
  return questions.length === 0 ? null : { questions };
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
