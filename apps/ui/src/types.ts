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
  /** Set when the Task is archived; the Runtime keeps every row and the owned worktree. */
  readonly archivedAt: number | null;
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
  /** The captured result commit of this attempt; null until a result commit is recorded. */
  readonly resultCommit: string | null;
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

/** One member of an IntegrationBatch; this round always carries exactly one Task. */
export interface IntegrationBatchItemView {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly revisionId: string;
  readonly executionId: string;
  readonly candidateCommit: string;
  readonly devCommit: string;
  readonly state: string;
  readonly integratedCommit: string | null;
  readonly detail: string | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
}

/**
 * A Task result entering the long-lived `dev` branch. `integratedCommit` is only set once the ref
 * actually moved; every other state means `dev` was left untouched.
 */
export interface IntegrationBatchView {
  readonly batchId: string;
  readonly devRef: string;
  readonly devCommit: string;
  readonly state: string;
  readonly integratedCommit: string | null;
  readonly mergeStrategy: 'FAST_FORWARD' | 'MERGE_COMMIT' | null;
  readonly worktreePath: string | null;
  readonly verificationId: string | null;
  readonly outcomeCode: string | null;
  readonly detail: string | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly items: readonly IntegrationBatchItemView[];
}

export interface TaskStatusView {
  readonly task: TaskView;
  readonly executions: readonly ExecutionView[];
  readonly verifications: readonly VerificationRunView[];
  readonly integrations: readonly IntegrationBatchView[];
  /**
   * Long-command Operations (ADR-0019): the Agent run and every verification run, with the steps
   * the Runtime actually recorded. Progress is a fact list, not a predicted percentage.
   */
  readonly operations: readonly OperationView[];
}

export interface OperationProgressView {
  readonly sequence: number;
  readonly stepKey: string;
  readonly step: string;
  readonly state: string;
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly recordedAt: number;
}

export interface OperationView {
  readonly operationId: string;
  readonly projectId: string;
  readonly kind: string;
  readonly aggregateId: string;
  readonly taskId: string | null;
  readonly state: string;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cancelRequestedAt: number | null;
  readonly steps: readonly OperationProgressView[];
  /**
   * UI-only, not part of the Runtime projection: the newest `OUTPUT` progress event this client
   * received over the stream, so a running command shows that it is producing output without
   * polling. `null`/absent means no output event has arrived (yet).
   */
  readonly liveOutput?: LiveOutputProgressView | null;
}

/** Liveness facts of the newest output-progress event; sizes and elapsed time, never output text. */
export interface LiveOutputProgressView {
  readonly progressSequence: number;
  readonly commandId: string | null;
  readonly stream: string | null;
  readonly stdoutBytes: number | null;
  readonly stderrBytes: number | null;
  readonly elapsedMs: number | null;
  readonly receivedAt: number;
}

/** Phases of a long-command progress event; `SETTLED` is the Operation's terminal transition. */
export type OperationProgressPhaseView = 'STEP' | 'OUTPUT' | 'CANCEL' | 'SETTLED';

/**
 * A long-command progress event as this client reads it off the stream.
 *
 * The Runtime sends an event payload as `unknown`, so this client re-checks the shape instead of
 * trusting it. `verdict` must be literally `false`: a progress event says what the Runtime reached,
 * never that anything passed, so a client that received only progress still shows an accepted long
 * command as accepted (the judgement of a verification lives in `VerificationCompleted`).
 */
export interface OperationProgressEventView {
  readonly operationId: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly kind: string;
  readonly progressSequence: number;
  readonly dedupKey: string;
  readonly phase: OperationProgressPhaseView;
  readonly stepKey: string | null;
  readonly step: string | null;
  readonly stepState: string | null;
  readonly stepSequence: number | null;
  readonly operationState: string | null;
  readonly detail: Readonly<Record<string, unknown>> | null;
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

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reads one `OperationProgressed` / `OperationSettled` payload. Returns `null` for anything this
 * client does not understand, including a payload that claims a verdict: unrecognized progress is
 * ignored rather than guessed at, and a progress event can never mark a long command as passed.
 */
export function operationProgressFromEvent(payload: unknown): OperationProgressEventView | null {
  if (!isRecord(payload)) return null;
  const operationId = payload['operationId'];
  const progressSequence = payload['progressSequence'];
  const dedupKey = payload['dedupKey'];
  const phase = payload['phase'];
  if (typeof operationId !== 'string' || typeof dedupKey !== 'string') return null;
  if (typeof progressSequence !== 'number' || !Number.isInteger(progressSequence)) return null;
  if (phase !== 'STEP' && phase !== 'OUTPUT' && phase !== 'CANCEL' && phase !== 'SETTLED') {
    return null;
  }
  if (payload['verdict'] !== false) return null;
  const detail = payload['detail'];
  return {
    operationId,
    projectId: typeof payload['projectId'] === 'string' ? payload['projectId'] : '',
    taskId: optionalString(payload['taskId']),
    kind: optionalString(payload['kind']) ?? '',
    progressSequence,
    dedupKey,
    phase,
    stepKey: optionalString(payload['stepKey']),
    step: optionalString(payload['step']),
    stepState: optionalString(payload['stepState']),
    stepSequence: optionalNumber(payload['stepSequence']),
    operationState: optionalString(payload['operationState']),
    detail: isRecord(detail) ? detail : null,
  };
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

/* ------------------------------------------------------------------------------------------------
 * Session handoff and the native terminal (ADR-0023 / ADR-0026).
 *
 * These mirror the projections `session handoff status|attach|detach|release|terminal read|write`
 * return on the same command face the CLI uses. Nothing here is a new capability: the panel only
 * renders what the Runtime reports and never decides a handoff itself.
 */

export type SessionIncarnationModeView = 'AUTOMATED_RPC' | 'HUMAN_TUI';
export type SessionIncarnationStateView = 'ACTIVE' | 'FENCED' | 'RECOVERY_REQUIRED' | 'EXITED';

/** One provider process generation of a conversation; the OS process is never the conversation. */
export interface SessionIncarnationView {
  readonly incarnationId: string;
  readonly incarnationNumber: number;
  readonly mode: SessionIncarnationModeView;
  readonly state: SessionIncarnationStateView;
  readonly providerPid: number | null;
  readonly providerSessionId: string | null;
  readonly sessionStorageRef: string | null;
  readonly predecessorIncarnationId: string | null;
  /** Descendants recorded while the provider was still alive, not a live process count. */
  readonly recordedDescendants: number;
  readonly createdAt: number;
  readonly endedAt: number | null;
  readonly exit: unknown;
}

export interface SessionHandoffRequestView {
  readonly requestId: string;
  readonly kind: 'TAKEOVER' | 'RETURN';
  readonly state: 'REQUESTED' | 'FENCED' | 'AT_SAFE_POINT' | 'ADMITTED' | 'CANCELLED'
    | 'RECOVERY_REQUIRED';
  readonly incarnationId: string;
  readonly fenceActive: boolean;
  readonly fenceConfirmedAt: number | null;
  readonly settledAfterFenceAt: number | null;
  readonly safePointAt: number | null;
  readonly admittedAt: number | null;
  readonly detail: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The structured facts a handoff waits for; `missing` names what is still absent. */
export interface SessionHandoffSafePointView {
  readonly reached: boolean;
  readonly fenceAcknowledged: boolean;
  readonly activeTools: number;
  readonly settledAfterFence: boolean;
  readonly openAttention: boolean;
  readonly missing: readonly string[];
}

export type SessionHandoffCapabilityView = 'IMPLEMENTED' | 'UNSUPPORTED' | 'PARTIAL' | 'UNVERIFIED';

/**
 * The Runtime's honest capability table. Unknown keys stay visible as they arrived: a capability
 * this client does not know about must never be silently dropped or shown as supported.
 */
export interface SessionHandoffCapabilitiesView {
  readonly runtimeContract: SessionHandoffCapabilityView;
  readonly singleWriterLease: SessionHandoffCapabilityView;
  readonly strictPermissionOverSideChannel: SessionHandoffCapabilityView;
  readonly ptyTransport: SessionHandoffCapabilityView;
  readonly successorProcessStart: SessionHandoffCapabilityView;
  readonly nativeTerminalAttach: SessionHandoffCapabilityView;
  readonly terminalDetach: SessionHandoffCapabilityView;
  readonly releaseBackToAutomation: SessionHandoffCapabilityView;
  readonly attachToLiveRpcProcess: SessionHandoffCapabilityView;
  readonly crossHandoffPermissionModeMatrix: SessionHandoffCapabilityView;
  readonly parallelToolBatchSafePoint: SessionHandoffCapabilityView;
  readonly sessionCompactionDuringHandoff: SessionHandoffCapabilityView;
  readonly ptyResize: SessionHandoffCapabilityView;
  readonly windows: SessionHandoffCapabilityView;
  readonly [capability: string]: SessionHandoffCapabilityView;
}

export type SessionTerminalStateView = 'RUNNING' | 'RELEASED' | 'STOPPED' | 'RECOVERY_REQUIRED';
export type SessionTerminalAttachmentKindView = 'WRITER' | 'OBSERVER';

export interface SessionTerminalAttachmentView {
  readonly id: string;
  readonly kind: SessionTerminalAttachmentKindView;
  readonly holderRef: string;
  readonly state: 'ATTACHED' | 'DETACHED';
  readonly cursorAtAttach: number;
  readonly cursorAtDetach: number | null;
  readonly attachedAt: number;
  readonly detachedAt: number | null;
  readonly detachedReason: string | null;
}

/** What the Runtime knows about one Session's native terminal, including its release evidence. */
export interface SessionTerminalView {
  readonly terminalId: string;
  readonly incarnationId: string;
  readonly state: SessionTerminalStateView;
  readonly helperPid: number | null;
  readonly providerPid: number | null;
  readonly ptySlave: string | null;
  readonly windowSize: 'APPLIED' | 'NOT_APPLIED';
  /** True while this Runtime generation still holds the terminal's control connection. */
  readonly held: boolean;
  readonly cursor: number;
  readonly retainedBytes: number;
  readonly projectedBytes: number;
  readonly bufferTruncated: boolean;
  readonly release: {
    readonly commandId: string | null;
    readonly requestedAt: number | null;
    readonly releaseByte: string | null;
    readonly providerShutdownReportedAt: number | null;
    /** The provider's own exit fact; the code is audit data and never decides a release. */
    readonly exit: { readonly code: number | null; readonly signal: string | null;
      readonly reportedAt: number | null } | null;
    readonly sessionFileEntriesAtStart: number | null;
    readonly sessionFileEntriesAtRelease: number | null;
    readonly lastEntryIdAtStart: string | null;
    readonly lastEntryIdAtRelease: string | null;
    readonly detail: string | null;
  };
  readonly writer: { readonly holderRef: string; readonly attachedAt: number } | null;
  readonly attachments: readonly SessionTerminalAttachmentView[];
}

/** One open STRICT permission request the side channel routed into an Attention. */
export interface SessionHandoffPermissionView {
  readonly attentionId: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly inputFingerprint: string;
  readonly piMode: string;
  readonly decision: string;
  readonly requestedAt: number;
}

export interface SessionHandoffStatusView {
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly sessionState: string;
  readonly executionState: string;
  readonly permissionMode: 'FULL' | 'STRICT';
  readonly providerSessionId: string | null;
  readonly sessionStorageRef: string | null;
  readonly incarnation: SessionIncarnationView | null;
  readonly incarnations: readonly SessionIncarnationView[];
  readonly writerLease: {
    readonly incarnationId: string;
    readonly holderKind: 'AUTOMATED_RPC' | 'TERMINAL_ATTACHMENT';
    readonly holderRef: string;
    readonly acquiredAt: number;
  } | null;
  readonly handoff: SessionHandoffRequestView | null;
  readonly handoffHistory: readonly SessionHandoffRequestView[];
  readonly safePoint: SessionHandoffSafePointView;
  readonly terminal: SessionTerminalView | null;
  readonly sideChannel: {
    readonly connected: boolean;
    readonly mode: string | null;
    readonly permissionMode: string | null;
    readonly pid: number | null;
    readonly activeTools: readonly string[];
  } | null;
  readonly permission: SessionHandoffPermissionView | null;
  readonly lastPermission: {
    readonly attentionId: string;
    readonly toolName: string;
    readonly toolCallId: string;
    readonly inputFingerprint: string;
    readonly decision: string;
    readonly decidedAt: number | null;
    readonly decidedBy: string | null;
  } | null;
  readonly capabilities: SessionHandoffCapabilitiesView;
}

/**
 * The outcome of `session.handoff.admit`. `successorStarted` is false whenever no provider process
 * was started, so a refusal and a real succession can never be confused by a client.
 */
export interface SuccessorAdmissionView {
  readonly admitted: boolean;
  readonly code: string;
  readonly detail: string;
  readonly predecessorObservation: string;
  readonly successorMode: SessionIncarnationModeView | null;
  readonly successorStarted: boolean;
  readonly terminalTransport: 'PTY' | 'RPC' | 'NONE';
  readonly successorIncarnation: SessionIncarnationView | null;
  readonly terminal: SessionTerminalView | null;
  /** True when this answer replayed an admission that had already been applied. */
  readonly replayed: boolean;
}

export interface TerminalAttachResultView {
  readonly terminal: SessionTerminalView | null;
  readonly attachment: {
    readonly id: string;
    readonly kind: SessionTerminalAttachmentKindView;
    readonly holderRef: string;
    readonly cursorAtAttach: number;
    readonly attachedAt: number;
  };
  readonly stream: { readonly cursor: number; readonly data: string; readonly truncated: boolean };
}

/** The incremental projection of terminal bytes; `truncated` means a cursor fell out of the buffer. */
export interface TerminalReadView {
  readonly terminalId: string;
  readonly running: boolean;
  readonly cursor: number;
  readonly data: string;
  readonly truncated: boolean;
  readonly retainedBytes: number;
  readonly projectedBytes: number;
}

/**
 * The explicit release outcome. `released: false` is a real answer — the terminal is still the
 * writer and nothing was handed back — so it is rendered as such instead of as an error toast.
 */
export interface TerminalReleaseResultView {
  readonly released: boolean;
  readonly code: string;
  readonly detail: string;
  readonly terminal: SessionTerminalView | null;
  readonly release: {
    readonly exit: { readonly code: number | null; readonly signal: string | null } | null;
    readonly predecessorObservation: string;
    readonly sessionFile: {
      readonly file: string | null;
      readonly entriesAtStart: number | null;
      readonly entriesAtRelease: number | null;
      readonly lastEntryIdAtStart: string | null;
      readonly lastEntryIdAtRelease: string | null;
      readonly predecessorEntrySurvived: boolean | null;
      readonly truncated: boolean;
    };
  };
  readonly successor: SuccessorAdmissionView | null;
}

/* ------------------------------------------------------------------------------------------------
 * Stable promotion (ADR-0022) and the dependency graph (ADR-0024), read-only projections.
 */

export type StablePromotionStateView = 'CREATED' | 'AWAITING_APPROVAL' | 'PROMOTING' | 'RESTARTING'
  | 'SUCCEEDED' | 'STALE' | 'FAILED' | 'RECOVERY_REQUIRED';

export interface PromotionMemberView {
  readonly batchId: string;
  readonly taskId: string;
  readonly revisionId: string;
  readonly executionId: string;
  readonly candidateCommit: string;
}

/** One restart step the client executed and observed; the exit code is a fact, not a verdict. */
export interface PromotionRestartStepView {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  readonly failureDetail?: string;
}

export interface PromotionRestartView {
  readonly observedBootId: string;
  readonly runtimeStatus: string | null;
  readonly uiRunning: boolean | null;
  readonly steps: readonly PromotionRestartStepView[];
}

/**
 * `dev → main` as the Runtime recorded it. `promotedCommit` is only set once `main` really moved,
 * and `restart` only says what the promoting client observed — a moved ref is not a live Runtime.
 */
export interface StablePromotionView {
  readonly promotionId: string;
  readonly projectId: string;
  readonly devRef: string;
  readonly mainRef: string;
  readonly candidateCommit: string;
  readonly expectedMainCommit: string;
  readonly integrationBatchId: string;
  readonly verificationId: string;
  readonly verificationTestedCommit: string;
  readonly permissionMode: 'FULL' | 'STRICT';
  readonly state: StablePromotionStateView;
  readonly approval: {
    readonly devCommit: string;
    readonly mainCommit: string;
    readonly verificationId: string;
    readonly approvedAt: number;
  } | null;
  readonly promotedCommit: string | null;
  readonly mainWorktreePath: string | null;
  readonly promotingBootId: string | null;
  readonly restartSteps: readonly { readonly id: string; readonly argv: readonly string[];
    readonly cwd: string }[];
  readonly restart: PromotionRestartView | null;
  readonly outcomeCode: string | null;
  readonly detail: string | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly members: readonly PromotionMemberView[];
}

/** Why one dependency edge is not satisfied; `satisfied` is true exactly when this is null. */
export interface TaskDependencyBlockReasonView {
  readonly code: 'UPSTREAM_NOT_INTEGRATED' | 'DEV_BASELINE_MISSING' | 'DEV_REF_UNREADABLE'
    | 'NOT_REACHABLE_FROM_DEV';
  readonly prerequisiteTaskId: string;
  readonly requiredRevisionId: string;
  readonly detail: string | null;
}

export interface TaskDependencyEdgeView {
  readonly dependentTaskId: string;
  readonly dependentDisplayNumber: number;
  readonly dependentState: string;
  readonly prerequisiteTaskId: string;
  readonly prerequisiteDisplayNumber: number;
  readonly prerequisiteState: string;
  readonly requiredRevisionId: string;
  readonly requiredRevisionNumber: number;
  readonly createdAt: number;
  readonly integratedCommit: string | null;
  readonly integrationBatchId: string | null;
  readonly satisfied: boolean;
  readonly reason: TaskDependencyBlockReasonView | null;
}

/** The `task.depends.list` projection; `taskId` is null for the project-wide listing. */
export interface TaskDependencyView {
  readonly projectId: string;
  readonly taskId: string | null;
  readonly taskState: string | null;
  readonly taskVersion: number | null;
  readonly devRef: string;
  readonly devCommit: string | null;
  readonly edges: readonly TaskDependencyEdgeView[];
  readonly blocked: boolean;
  readonly blockedReasons: readonly TaskDependencyBlockReasonView[];
  readonly prerequisites: readonly string[];
  readonly dependents: readonly string[];
}

export type StreamFrame =
  | { readonly schemaVersion: 1; readonly type: 'subscribed'; readonly requestId: string;
      readonly cursor: number; readonly projectId: string | null }
  | { readonly schemaVersion: 1; readonly type: 'event'; readonly cursor: number;
      readonly event: EventEnvelopeView }
  | { readonly schemaVersion: 1; readonly type: 'heartbeat'; readonly cursor: number }
  | { readonly schemaVersion: 1; readonly type: 'error'; readonly code: string;
      readonly message: string };
