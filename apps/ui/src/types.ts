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
  /**
   * The features this revision declares (ADR-0059): module ids from the project's
   * `.codeestra/impact.json`. Empty means the Task never participates in a feature conflict.
   */
  readonly features: readonly string[];
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
  /**
   * The newest Execution attempt and the ending its Agent Session recorded, as facts. It exists so
   * a list row can tell "the Agent is still running" from "its Session already recorded an ending"
   * without a second read per row.
   *
   * `null` means the Task never started an attempt. An absent `completionOutcome` means "not
   * recorded" — never "failed" and never "succeeded".
   */
  readonly latestExecution: {
    readonly executionId: string;
    readonly attemptNumber: number;
    readonly state: string;
    /** True while this attempt still owns its reservation and workspace. */
    readonly resourceHeld: boolean;
    /** `null` when the attempt never recorded a Session (for example a failed start). */
    readonly sessionState: string | null;
    readonly completionOutcome: 'SUCCESS' | 'FAILURE' | null;
  } | null;
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
    /**
     * The completion the Runtime recorded for this Session, including any note it had to add
     * (FOUNDATION-056). `null` while the Session has not completed. The note is an observation
     * about the *shape of the ending*; it is never a claim that the Agent is waiting for an answer.
     */
    readonly completion: AgentSessionCompletionView | null;
  } | null;
}

/** Provider-reported facts behind one completion; an absent fact means "unknown", never "none". */
export interface AgentCompletionFactsView {
  readonly toolCallCount: number;
  readonly finalAssistantText: string | null;
  readonly finalAssistantTextTruncated: boolean;
  readonly finalAssistantStopReason: string | null;
}

/**
 * The Runtime's own note about an ending it must not leave unexplained. It carries a stable code,
 * the heuristic that fired, and the facts it was applied to — never a judgement of intent.
 */
export interface AgentCompletionNoteView {
  readonly code: string;
  readonly heuristic: string;
  readonly message: string;
  readonly facts: AgentCompletionFactsView;
}

/** What the Runtime recorded next to a settled Agent run. `note` is `null` for an ordinary end. */
export interface AgentSessionCompletionView {
  readonly outcome: 'SUCCESS' | 'FAILURE';
  readonly evidenceRef: string | null;
  readonly failure: { readonly code: string; readonly message?: string } | null;
  readonly facts: AgentCompletionFactsView | null;
  readonly note: AgentCompletionNoteView | null;
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

/**
 * One fixed member of an IntegrationBatch, as `task.integration.list` (and every batch inside
 * `task.status`) reports it. `state` is the member's own item state; a batch is multi-member since
 * ADR-0053, so this is never "the one Task" the way it was before that.
 */
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
 * One member of an IntegrationBatch as the single-batch reads report it (`task.integration.get`,
 * `create`, `cancel`, and every member of the `integrate` report). This is the same record as
 * `IntegrationBatchItemView`, projected without the per-member `taskVersion` / `devCommit` /
 * `createdAt` / `completedAt` columns.
 */
export interface IntegrationBatchMemberView {
  readonly taskId: string;
  readonly executionId: string;
  readonly revisionId: string;
  readonly candidateCommit: string;
  readonly state: string;
  readonly integratedCommit: string | null;
  readonly detail: string | null;
}

/**
 * A batch of one or more Task results entering the long-lived `dev` branch (ADR-0018 / ADR-0053).
 * `integratedCommit` is only set once the ref actually moved; every other state means `dev` was left
 * untouched. This is the shape `task.integration.list` and `task.status` return, with every member
 * in `items`.
 */
export interface IntegrationBatchView {
  readonly batchId: string;
  readonly projectId: string;
  readonly devRef: string;
  readonly devCommit: string;
  readonly state: string;
  readonly integratedCommit: string | null;
  readonly mergeStrategy: 'FAST_FORWARD' | 'MERGE_COMMIT' | null;
  /** The merge Git produced, recorded before the ref moves; null until a merge was recorded. */
  readonly mergedCommit: string | null;
  readonly worktreePath: string | null;
  readonly verificationId: string | null;
  readonly outcomeCode: string | null;
  readonly detail: string | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly items: readonly IntegrationBatchItemView[];
}

/**
 * The recorded batch one single-batch command returns (`create` / `get` / `cancel`): the same facts
 * as `IntegrationBatchView`, keyed by `members` instead of `items`, plus whether this call created
 * the batch (`created: false` means the command was a replay of an already recorded batch).
 */
export interface IntegrationBatchRecordView {
  readonly batchId: string;
  readonly projectId: string;
  readonly devRef: string;
  readonly devCommit: string;
  readonly state: string;
  readonly integratedCommit: string | null;
  readonly mergeStrategy: 'FAST_FORWARD' | 'MERGE_COMMIT' | null;
  readonly mergedCommit: string | null;
  readonly worktreePath: string | null;
  readonly verificationId: string | null;
  readonly outcomeCode: string | null;
  readonly detail: string | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly members: readonly IntegrationBatchMemberView[];
  /** True when this call created the batch. */
  readonly created: boolean;
}

/** One policy command of the batch's independent integration verification, as it was observed. */
export interface IntegrationCommandOutcomeView {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  /** Transient tail for the caller's terminal; empty when the run was replayed. */
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly failureDetail?: string;
}

/** The tree the integration verification ran against (facts, never a pass/fail prediction). */
export interface IntegrationTreeEvidenceView {
  readonly headCommit: string;
  readonly trackedModifications: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly clean: boolean;
}

/**
 * What `task.integration.integrate` reports: the merge it produced, the one verification that
 * covered the whole batch, and every member's fixed binding. `alreadyCompleted` means the recorded
 * verdict of a finished batch was returned instead of a second integration.
 */
export interface IntegrationReportView extends IntegrationBatchRecordView {
  readonly mergedCommit: string | null;
  readonly worktreeDetail: string | null;
  readonly verificationState: string | null;
  readonly commands: readonly IntegrationCommandOutcomeView[];
  readonly tree: IntegrationTreeEvidenceView | null;
  readonly alreadyCompleted: boolean;
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

/**
 * The Runtime's verification of a project's dev clone (ADR-0047 D05 / ADR-0048): a second, separate
 * clone of the same origin sitting on the project's `dev` branch. `verified: false` always carries
 * the stable code that names the fact which could not be established; every other field is what the
 * check could still read.
 */
export interface DevRepoInspectionView {
  readonly path: string;
  /** The project's dev branch this clone is expected to have checked out. */
  readonly devRef: string;
  readonly verified: boolean;
  readonly code: string | null;
  readonly detail: string | null;
  readonly repoRoot: string | null;
  readonly gitCommonDir: string | null;
  readonly headCommit: string | null;
  readonly branchRef: string | null;
  readonly devRefCommit: string | null;
  readonly originUrl: string | null;
  readonly originMatchesProject: boolean | null;
  readonly clean: boolean | null;
}

/**
 * What `project.inspect` returns: the repository identity plus the development baseline and the
 * verified dev clone. It is also the value a trust echoes back as `expectedIdentity`, so the client
 * must return it unchanged.
 */
export interface ProjectIdentityView extends RepositoryIdentityView {
  readonly devRef: string;
  readonly devCommit: string | null;
  readonly devRefPresent: boolean;
  readonly devRepoPath: DevRepoInspectionView | null;
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

/**
 * Which pair of distinguishable facts a record states (ADR-0047 D03 / ADR-0052). The Runtime
 * **derives** it from the stored state and the recorded restart result; it is never an input the
 * client may send. `AWAITING_PULL` is the one that must never read as a finished promotion: the
 * candidate is on the remote `dev` and the main checkout has not pulled it yet.
 */
export type PromotionPhaseView = 'READY_TO_PUSH' | 'AWAITING_PULL' | 'RESTART_PENDING'
  | 'MAIN_PUSH_PENDING' | 'COMPLETE' | 'REFUSED';

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
    /** The exact dev full-suite evidence the approval also covered (ADR-0039); null when unrecorded. */
    readonly fullSuiteEvidenceId: string | null;
    readonly approvedAt: number;
  } | null;
  /** The dev full-suite evidence `promote` re-reads before it touches any ref (ADR-0038 D03). */
  readonly fullSuite: {
    readonly evidenceId: string;
    readonly devCommit: string;
    readonly policyVersion: string;
    readonly policyDigest: string;
    readonly lockfileDigest: string;
  } | null;
  readonly promotedCommit: string | null;
  readonly mainWorktreePath: string | null;
  readonly promotingBootId: string | null;
  /** The dev clone this promotion pushes its candidate from (ADR-0047 D05); null when none. */
  readonly devRepoPath: string | null;
  /**
   * Commit **read back** from the remote dev ref after the push. This is an observation, never an
   * input: it is only recorded once `git ls-remote` reported the fixed candidate, which is what makes
   * "the push exited 0" unable to stand in for "the candidate is on the remote".
   */
  readonly remoteDevCommit: string | null;
  /** Commit read back from the remote main ref after the stable commit was published there. */
  readonly remoteMainCommit: string | null;
  readonly pushedAt: number | null;
  readonly mainPushedAt: number | null;
  /** Which pair of facts (pushed / pulled-and-restarted) this record currently states. */
  readonly phase: PromotionPhaseView;
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

/* ------------------------------------------------------------------------------------------------
 * The scheduling engine and capacity (FOUNDATION-055 / ADR-0030, FOUNDATION-054 / ADR-0032).
 *
 * Every type here mirrors a projection the Runtime already sends on the same command face the CLI
 * uses. The UI adds no verdict of its own: an `UNKNOWN` assessment is rendered as "cannot be
 * proven", never as "no conflict", and a capacity wait is never folded into `BLOCKED`.
 */

export type CapacityWaitReasonCodeView = 'CAPACITY_GLOBAL_LIMIT_REACHED'
  | 'CAPACITY_ADAPTER_SLOT_LIMIT_REACHED' | 'SCHEDULER_DRAINING'
  /** ADR-0061 D08: the Runtime's persistent global barrier. A wait, never `BLOCKED`. */
  | 'SCHEDULER_GLOBALLY_PAUSED';

/** Why a Task did not get a slot; a capacity wait is a fact about now, not a failure. */
export interface CapacityWaitReasonView {
  readonly code: CapacityWaitReasonCodeView;
  readonly adapterId: string | null;
  readonly limit: number | null;
  readonly used: number | null;
  readonly blocking: readonly string[];
  readonly detail: string;
}

/**
 * One Task occupying a Runtime slot right now, with the facts that made it an occupant.
 *
 * `projectId` is part of it because the limit is Runtime-wide (ADR-0061 D01): the card has to be able
 * to say *which* Project holds each slot, not just how many are held.
 */
export interface CapacityOccupierView {
  readonly projectId: string;
  readonly taskId: string;
  readonly adapterId: string;
  readonly adapterIds: readonly string[];
  readonly reservationId: string | null;
  readonly since: number;
  readonly source: 'RESERVATION' | 'EXECUTION';
}

/** The pause state the capacity report carries, read from the one global control row. */
export interface RuntimePauseStateView {
  readonly state: 'RUNNING' | 'PAUSING' | 'PAUSED' | 'RESUMING' | 'RECOVERY_REQUIRED';
  readonly pauseEpoch: number;
  readonly detail: string | null;
}

/** The Runtime-wide capacity facts `scheduler capacity get` reports (ADR-0061 D02). */
export interface RuntimeCapacityView {
  readonly limit: number;
  readonly limitSource: 'DEFAULT' | 'EXPLICIT';
  readonly used: number;
  readonly available: number;
  readonly waitReason: CapacityWaitReasonCodeView | null;
  readonly occupiers: readonly CapacityOccupierView[];
  readonly pauseState: RuntimePauseStateView;
  readonly configVersion: number;
  readonly updatedAt: number | null;
  readonly updatedBy: string | null;
  readonly draining: boolean;
  readonly drainReason: string | null;
}

/**
 * The per-Project report of the same Runtime-wide capacity, carried by `task.schedule.*` and
 * `task.run`. The numbers are global; `projectId` only says which Project asked, and there is
 * deliberately no Adapter list left (ADR-0061 D01 retires the per-Adapter ceiling).
 */
export interface ProjectCapacityView {
  readonly projectId: string;
  readonly globalLimit: number;
  readonly globalLimitSource: 'DEFAULT' | 'EXPLICIT';
  readonly globalUsed: number;
  readonly globalAvailable: number;
  readonly globalWaitReason: CapacityWaitReasonCodeView | null;
  readonly configVersion: number;
  readonly updatedAt: number | null;
  readonly updatedBy: string | null;
  readonly draining: boolean;
  readonly drainReason: string | null;
  readonly occupants: readonly CapacityOccupierView[];
}

/** One measured intersection behind a conflict wait or an impact verdict. */
export interface ConflictHitView {
  readonly reason: string;
  readonly class: string;
  readonly taskId: string | null;
  readonly revisionId: string | null;
  readonly paths: readonly string[];
  readonly pathCount: number;
  readonly directories: readonly string[];
  readonly modules: readonly string[];
  readonly globalResources: readonly string[];
  /** The feature ids both sides declared (`SAME_UNFINISHED_FEATURE`); empty for older codes. */
  readonly features?: readonly string[];
  readonly relation: string | null;
  readonly detail: string;
}

export type ScheduleWaitKindView = 'CONFLICT' | 'CAPACITY';

/** A wait is never `BLOCKED`: it carries the analyzer's codes/scopes or the capacity numbers. */
export interface ScheduleWaitView {
  readonly kind: ScheduleWaitKindView;
  readonly code: string;
  readonly detail: string;
  readonly reasonCodes: readonly string[];
  readonly hits: readonly ConflictHitView[];
  readonly blocking: readonly string[];
  /** When this wait was first recorded, so the UI can show how long it has lasted. */
  readonly since: number | null;
}

/** The assessment a decision was made from; the binding an `--allow-unknown` release uses. */
export interface ScheduleAssessmentView {
  readonly verdict: 'SAFE_TO_PARALLELIZE' | 'UNKNOWN' | 'CONFLICTING';
  readonly reasonCodes: readonly string[];
  readonly revisionId: string;
  readonly baseCommit: string;
  readonly analyzerVersion: string;
  readonly policyVersion: string;
  readonly candidateSnapshotId: string | null;
  readonly candidateComplete: boolean;
  readonly candidateIncompleteReasons: readonly string[];
  readonly comparedTaskIds: readonly string[];
  readonly activeTaskIds: readonly string[];
  readonly explanation: readonly string[];
}

export type ScheduleDispositionView = 'STARTED' | 'WOULD_START' | 'WAITING' | 'BLOCKED' | 'SKIPPED'
  | 'FAILED';

/** One candidate in the ordered walk, with the decision the Runtime actually reached. */
export interface ScheduleCandidateView {
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly taskState: string;
  readonly taskVersion: number;
  readonly revisionId: string;
  readonly priority: number;
  readonly createdAt: number;
  readonly adapterId: string;
  readonly disposition: ScheduleDispositionView;
  readonly detail: string;
  readonly wait: ScheduleWaitView | null;
  readonly blockedReasons: readonly { readonly code: string; readonly prerequisiteTaskId: string;
    readonly requiredRevisionId: string; readonly detail: string | null }[];
  readonly assessment: ScheduleAssessmentView | null;
  readonly started: { readonly executionId: string; readonly sessionId: string;
    readonly workspaceId: string; readonly baseCommit: string;
    readonly reservationId: string | null } | null;
  readonly clearedUnknownBy: string | null;
}

/** A recorded growth of an active Task's observed diff beyond its prediction (scheduler.md §4). */
export interface ScheduleImpactGrowthView {
  readonly taskId: string;
  readonly previousSnapshotId: string;
  readonly snapshotId: string;
  readonly addedPaths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly conflictingTaskIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly pauseRequested: boolean;
  readonly pauseOutcome: string | null;
  readonly detail: string;
}

/** `task schedule status` / `task schedule plan`; `plan` is the dry run that starts nothing. */
export interface ScheduleOverviewView {
  readonly projectId: string;
  readonly dryRun: boolean;
  readonly adapterId: string;
  readonly draining: boolean;
  readonly running: boolean;
  readonly lastTick: { readonly tickId: string; readonly trigger: string;
    readonly completedAt: number } | null;
  readonly candidates: readonly ScheduleCandidateView[];
  readonly active: readonly { readonly taskId: string; readonly taskDisplayNumber: number;
    readonly taskState: string; readonly executionState: string; readonly adapterId: string;
    readonly reservationId: string | null; readonly since: number }[];
  readonly capacity: ProjectCapacityView;
  readonly impactGrowth: readonly ScheduleImpactGrowthView[];
}

/** `task schedule explain`: why one Task is (not) running now, in the Runtime's own words. */
export interface ScheduleExplanationView {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskState: string;
  readonly adapterId: string;
  readonly candidate: boolean;
  readonly decision: 'START_NOW' | 'WAIT_CONFLICT' | 'WAIT_CAPACITY' | 'WAIT_CONTROL' | 'BLOCKED'
    | 'ACTIVE' | 'NOT_A_CANDIDATE';
  readonly detail: string;
  readonly wait: ScheduleWaitView | null;
  readonly blockedReasons: readonly { readonly code: string; readonly prerequisiteTaskId: string;
    readonly requiredRevisionId: string; readonly detail: string | null }[];
  readonly assessment: ScheduleAssessmentView | null;
  readonly capacity: ProjectCapacityView;
  readonly activeTaskIds: readonly string[];
  /** The valid `--allow-unknown` release in effect for this Task and assessment, if any. */
  readonly unknownRelease: { readonly releaseId: string; readonly revisionId: string;
    readonly baseCommit: string; readonly analyzerVersion: string;
    readonly policyVersion: string; readonly reasonCodes: readonly string[];
    readonly releasedBy: string; readonly releasedAt: number;
    readonly consumed: boolean } | null;
  readonly explanation: readonly string[];
}

/** What `task schedule clearUnknown` recorded; `state` distinguishes a real release from a no-op. */
export interface ScheduleUnknownReleaseView {
  readonly recorded: boolean;
  readonly releaseId: string | null;
  readonly state: 'RECORDED' | 'ALREADY_VALID' | 'NOT_UNKNOWN' | 'SAFE' | 'CONFLICTING';
  readonly verdict: 'SAFE_TO_PARALLELIZE' | 'UNKNOWN' | 'CONFLICTING';
  readonly reasonCodes: readonly string[];
  readonly revisionId: string;
  readonly baseCommit: string;
  readonly analyzerVersion: string;
  readonly policyVersion: string;
  readonly detail: string;
}

/** One `task schedule run` pass: what it decided, for which projects. */
export interface ScheduleTickReportView {
  readonly tickId: string;
  readonly trigger: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly draining: boolean;
  readonly coalesced: boolean;
  readonly projects: readonly { readonly projectId: string;
    readonly candidates: readonly ScheduleCandidateView[];
    readonly impactGrowth: readonly ScheduleImpactGrowthView[];
    readonly activeTaskIds: readonly string[];
    readonly capacity: ProjectCapacityView }[];
}

/** The result of `scheduler capacity set` / `reset`; `changed: false` is an honest no-op. */
export interface CapacityMutationView {
  readonly changed: boolean;
  readonly capacity: RuntimeCapacityView;
  readonly schedule: ScheduleTickReportView | null;
}

/* -- Slot reservations (scheduler.md §3, ADR-0032) ------------------------------------------------ */

/** Who created a reservation and the OS evidence recorded for it — never a bare "it was me". */
export interface SlotHolderEvidenceView {
  readonly bootId: string;
  readonly pid: number;
  readonly startToken: string | null;
  readonly actor: string;
}

export interface SlotReservationEventView {
  readonly sequence: number;
  readonly kind: 'RESERVED' | 'RELEASED' | 'RECONCILE_OBSERVED';
  readonly domainEventId: string | null;
  readonly commandId: string;
  readonly actor: string;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly occurredAt: number;
}

export type SlotReservationStateView = 'RESERVED' | 'RELEASED' | 'RECOVERY_REQUIRED';

export type SlotHolderObservationStateView = 'HOLDER_STOPPED' | 'HOLDER_PROCESS_ID_REUSED'
  | 'HOLDER_STILL_RUNNING' | 'HOLDER_OWNERSHIP_UNVERIFIABLE' | 'PROCESS_IDENTITY_MISSING';

export interface SlotReservationView {
  readonly reservationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly revisionId: string;
  readonly taskVersion: number;
  readonly adapterId: string;
  readonly workspaceId: string | null;
  readonly impactSnapshotId: string | null;
  readonly dependencyFingerprint: string;
  readonly assessedDevCommit: string | null;
  readonly state: SlotReservationStateView;
  readonly version: number;
  readonly commandId: string;
  readonly holder: SlotHolderEvidenceView;
  readonly reservedAt: number;
  readonly updatedAt: number;
  readonly releasedAt: number | null;
  readonly releaseReason: string | null;
  readonly releaseKind: 'EXPLICIT' | 'RECONCILED_HOLDER_EXITED'
    | 'RECONCILED_PROCESS_ID_REUSED' | null;
  readonly releaseObservation: SlotHolderObservationStateView | null;
  readonly detail: string | null;
}

export interface SlotReservationDetailView extends SlotReservationView {
  readonly events: readonly SlotReservationEventView[];
}

export interface SlotReservationListView {
  readonly projectId: string;
  readonly reservations: readonly SlotReservationView[];
}

/** One reservation's verdict from `scheduler reservations reconcile`; nothing is signalled. */
export interface SlotReservationReconcileOutcomeView {
  readonly reservationId: string;
  readonly taskId: string;
  readonly outcome: 'RELEASED' | 'MARKED_RECOVERY_REQUIRED' | 'HELD' | 'ALREADY_RELEASED'
    | 'ALREADY_RECONCILED' | 'SKIPPED_HELD_BY_RUNTIME' | 'FAILED';
  readonly observation: SlotHolderObservationStateView | null;
  readonly previousState: string;
  readonly state: string;
  readonly detail: string;
}

export interface SlotReservationReconcileReportView {
  readonly bootId: string;
  readonly outcomes: readonly SlotReservationReconcileOutcomeView[];
  /** Reservations whose recorded process was never signalled by this Runtime generation. */
  readonly notSignalled: readonly { readonly reservationId: string; readonly pid: number }[];
}

/** `scheduler reservations release`: `released: false` with a code is a real answer, not an error. */
export interface SlotReservationReleaseView {
  readonly released: boolean;
  readonly outcome: 'RELEASED' | 'ALREADY_RELEASED';
  readonly reservation: SlotReservationDetailView;
  readonly schedule: ScheduleTickReportView | null;
}

/* -- Conflict analysis (ADR-0031) ------------------------------------------------------------------ */

/** The mapping report behind every impact verdict; `confirmed` is what makes it effective. */
export interface ImpactPolicyReportView {
  readonly state: 'ABSENT' | 'PRESENT' | 'INVALID';
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly digest: string | null;
  readonly contentDigest: string | null;
  readonly label: string | null;
  readonly confirmed: boolean;
  readonly confirmationState: 'ABSENT' | 'PRESENT' | 'INVALID' | 'NOT_RECORDED';
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly importantDirectories: number;
  readonly modules: number;
  readonly globalResources: number;
}

/** `project impact validate`; only `OK` / `OK_UNTRUSTED` mean the mapping is actually in effect. */
export interface ImpactPolicyValidationView {
  readonly code: 'OK' | 'OK_UNTRUSTED' | 'POLICY_ABSENT' | 'POLICY_INVALID' | 'POLICY_NOT_CONFIRMED';
  readonly valid: boolean;
  readonly repoRoot: string;
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly trusted: { readonly projectId: string; readonly name: string } | null;
  readonly policy: ImpactPolicyReportView;
  readonly warnings: readonly string[];
  readonly analyzerVersion: string;
}

/** One stored ImpactSnapshot, exactly as the analyzer recorded it (append-only, never edited). */
export interface ImpactSnapshotView {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly revisionId: string;
  readonly baseCommit: string;
  readonly analyzerVersion: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly caseMode: 'SENSITIVE' | 'INSENSITIVE';
  readonly changeFingerprint: string;
  readonly complete: boolean;
  readonly incompleteReasons: readonly string[];
  readonly files: readonly string[];
  readonly importantDirectories: readonly string[];
  readonly modules: readonly string[];
  readonly globalResources: readonly { readonly id: string; readonly kind: string;
    readonly written: boolean; readonly read: boolean }[];
  readonly unclassifiedFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly createdAt: number;
}

/** `project impact show`: the snapshot in effect for one Task, or why none could be derived. */
export interface ImpactTaskSnapshotView {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskState: string;
  readonly revisionId: string;
  readonly policy: ImpactPolicyReportView;
  readonly caseMode: 'SENSITIVE' | 'INSENSITIVE';
  readonly caseModeSource: string;
  readonly caseModeDetail: string;
  readonly disposition: 'RECORDED' | 'REUSED' | 'UNAVAILABLE';
  readonly dispositionDetail: string | null;
  readonly baseline: { readonly workspaceBaseCommit: string | null;
    readonly projectDevCommit: string | null; readonly matchesProjectDev: boolean };
  readonly snapshot: ImpactSnapshotView | null;
  readonly unavailableDetail: string | null;
}

/** `project impact explain`: the candidate against every active/reserved Task, with its verdict. */
export interface ImpactAssessmentReportView {
  readonly projectId: string;
  readonly taskId: string;
  readonly revisionId: string;
  readonly candidate: ImpactTaskSnapshotView;
  readonly active: readonly { readonly taskId: string; readonly taskState: string;
    readonly executionState: string; readonly revisionId: string;
    readonly disposition: 'RECORDED' | 'REUSED' | 'UNAVAILABLE';
    readonly complete: boolean; readonly incompleteReasons: readonly string[];
    readonly changeFingerprint: string | null; readonly detail: string | null }[];
  readonly assessment: {
    readonly verdict: 'SAFE_TO_PARALLELIZE' | 'UNKNOWN' | 'CONFLICTING';
    readonly reasonCodes: readonly string[];
    readonly candidateTaskId: string;
    readonly candidateRevisionId: string;
    readonly candidateChangeFingerprint: string;
    readonly candidateComplete: boolean;
    readonly candidateIncompleteReasons: readonly string[];
    readonly comparedTaskIds: readonly string[];
    readonly hits: readonly ConflictHitView[];
    readonly safePairs: readonly { readonly taskId: string; readonly revisionId: string;
      readonly changeFingerprint: string }[];
    readonly evidence: readonly string[];
  };
  readonly explanation: readonly string[];
  readonly recordedAssessments: readonly { readonly otherTaskId: string;
    readonly verdict: string; readonly reasonCodes: readonly string[] }[];
}

export type StreamFrame =
  | { readonly schemaVersion: 1; readonly type: 'subscribed'; readonly requestId: string;
      readonly cursor: number; readonly projectId: string | null }
  | { readonly schemaVersion: 1; readonly type: 'event'; readonly cursor: number;
      readonly event: EventEnvelopeView }
  | { readonly schemaVersion: 1; readonly type: 'heartbeat'; readonly cursor: number }
  | { readonly schemaVersion: 1; readonly type: 'error'; readonly code: string;
      readonly message: string };

// ---------------------------------------------------------------------------------------------
// Task revision history and revision delivery (PROJECT_SPEC §2.11 / ADR-0028)
//
// These mirror `task revision list|create` and `task revision delivery list|get|resolve`. The three
// facts they must keep apart are "recorded", "dispatched" and "confirmed": a delivery is satisfied
// only by a structured acknowledgement or by a successor Execution the Runtime read back, never
// because something was sent. The Runtime validates every response; this client only re-reads it.
// ---------------------------------------------------------------------------------------------

/** Domain FSM states of one delivery requirement (`packages/domain/src/revision-delivery.ts`). */
export type RevisionDeliveryStateView =
  | 'PENDING' | 'IN_FLIGHT' | 'ACKNOWLEDGED' | 'UNACKNOWLEDGED' | 'CHANNEL_UNSUPPORTED'
  | 'TIMED_OUT' | 'FAILED' | 'SUPERSEDED_BY_RESTART';

/** How a revision was (or was not) carried into the Execution. */
export type RevisionDeliveryChannelView = 'PROVIDER_CONVERSATION' | 'STOP_AND_RESTART';

/** One immutable revision as `task revision list` reports it; `current` marks the Task's current. */
export interface TaskRevisionSummaryView {
  readonly id: string;
  readonly number: number;
  readonly previousRevisionId: string | null;
  readonly specification: string;
  readonly constraints: readonly { readonly id: string; readonly text: string }[];
  readonly reason: string;
  readonly actor: string;
  readonly createdAt: number;
  readonly current: boolean;
}

/** One append-only attempt: which channel aimed the revision where, and the fact it produced. */
export interface RevisionDeliveryAttemptView {
  readonly id: string;
  readonly attemptNumber: number;
  readonly channel: RevisionDeliveryChannelView;
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly incarnationId: string | null;
  readonly state: RevisionDeliveryStateView;
  readonly evidenceRef: string | null;
  readonly errorCode: string | null;
  readonly detail: string;
  readonly deadlineAt: number | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/**
 * One delivery requirement as the ledger holds it. `satisfied` is the Runtime's verdict — true only
 * for a structured acknowledgement or a verified successor Execution. `stale` means the Task has
 * since moved on to a later revision, so a restart could never confirm this one.
 */
export interface RevisionDeliveryRecordView {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly incarnationId: string | null;
  readonly state: RevisionDeliveryStateView;
  readonly attemptCount: number;
  readonly channel: RevisionDeliveryChannelView | null;
  readonly deadlineAt: number | null;
  readonly evidenceRef: string | null;
  readonly detail: string | null;
  readonly supersededByExecutionId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly acknowledgedAt: number | null;
  readonly satisfied: boolean;
  readonly stale: boolean;
  readonly attempts: readonly RevisionDeliveryAttemptView[];
}

/** The list form adds one Runtime-side observation: an attempt is still in flight right now. */
export interface RevisionDeliveryView extends RevisionDeliveryRecordView {
  readonly attemptInFlight: boolean;
}

/** `task revision list` returns both ledgers of the specification history in one read. */
export interface TaskRevisionListView {
  readonly revisions: readonly TaskRevisionSummaryView[];
  readonly deliveries: readonly RevisionDeliveryView[];
}

/** What `task revision create` produced; `deliveryId` is set only when an Execution was holding it. */
export interface RevisionCreationView {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly previousRevisionId: string;
  readonly deliveryId: string | null;
  readonly executionId: string | null;
  readonly sessionId: string | null;
}

/**
 * The outcome of `task revision delivery resolve`. `RESOLVED` and `SUPERSEDED_BY_RESTART` are the
 * only ones that leave the delivery confirmed; `UNSATISFIED` is recorded honesty, not a success.
 */
export interface RevisionDeliveryResolutionView {
  readonly outcome: 'SUPERSEDED_BY_RESTART' | 'ALREADY_SATISFIED' | 'RESOLVED' | 'UNSATISFIED'
    | 'RECOVERY_REQUIRED';
  readonly delivery: RevisionDeliveryRecordView;
  readonly taskState: string;
  readonly taskVersion: number;
  readonly successorExecutionId: string | null;
  readonly predecessorExecutionId: string | null;
  readonly detail: string;
}

/**
 * The result of `attention.resolve` (FOUNDATION-069 / ADR-0043). It never claims a conversation was
 * reached: `deliveredToProvider` is always false and the Session stays `EXITED`.
 */
export interface ProseQuestionResolutionResultView {
  readonly attentionId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly resolution: 'ANSWERED' | 'DISMISSED_FALSE_POSITIVE';
  readonly answerText: string | null;
  readonly note: string | null;
  readonly actor: string;
  readonly taskState: string;
  readonly executionState: string;
  readonly sessionState: string;
  readonly attentionStatus: string;
  readonly deliveredToProvider: false;
  readonly resolvedAt: number;
}

/**
 * `runtime.ping` — what the Runtime that answered says about itself. `adapters` is the registered
 * Adapter id list (the same fact `task retry --adapter` validates against), so the client renders
 * the registered choices instead of assuming one.
 */
export interface RuntimePingView {
  readonly pid: number;
  readonly bootId: string;
  readonly startedAt: number;
  readonly status: string;
  readonly permissionMode: 'FULL' | 'STRICT';
  readonly adapters: readonly string[];
  readonly activeSessions: readonly string[];
  readonly eventSubscribers: number;
  readonly uiRunning: boolean;
}

/**
 * The one start request a `task.retry` (or `task.run`) issued afterwards, as the scheduling gate
 * answered it. `outcome` is the whole verdict: `STARTED`, `WAIT` (the CLI's exit code 3) or
 * `REFUSED` (with a stable `code`). The `sessionId`/`executionId` fields are present exactly when a
 * start happened, so nothing here can be read as a start that did not occur.
 */
export interface ScheduleStartOutcomeView {
  readonly projectId: string;
  readonly taskId: string;
  readonly outcome: 'STARTED' | 'WAIT' | 'REFUSED';
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly attemptNumber: number | null;
  readonly taskVersion: number | null;
  readonly workspaceId: string | null;
  readonly workspacePath: string | null;
  readonly baseCommit: string | null;
  readonly adapterId: string;
  readonly adapterVersion: string | null;
  readonly sessionState: string | null;
  readonly permissionMode: 'FULL' | 'STRICT' | null;
  readonly agentConfig: Readonly<Record<string, unknown>> | null;
  readonly reservationId: string | null;
  readonly wait: ScheduleWaitView | null;
  readonly assessment: ScheduleAssessmentView | null;
  readonly clearedUnknownBy: string | null;
  readonly code: string | null;
  readonly detail: string;
}

/**
 * The result of `task.purge` (ADR-0058). This is the one command whose success means the Task no
 * longer exists, so the view reports what was destroyed instead of a new state: the final state it
 * was deleted from, the rows deleted per table, the reclaimed resources, and the tip of every branch
 * that was deleted. `replayed: true` says the receipt answered rather than a second deletion.
 */
export interface TaskPurgeOutcomeView {
  readonly projectId: string;
  readonly taskId: string;
  readonly displayNumber: number;
  readonly state: string;
  readonly version: number;
  readonly archived: boolean;
  readonly reason: string | null;
  readonly purgedAt: number;
  readonly eventId: string;
  readonly currentRevisionId: string;
  readonly replayed: boolean;
  readonly stop: {
    readonly state: string;
    readonly stop: 'TERMINAL' | 'RELEASED' | 'RECOVERED' | 'FORCED' | 'UNCERTAIN';
    readonly executionId: string | null;
    readonly sessionId: string | null;
    readonly detail: string;
  } | null;
  readonly plan: {
    readonly worktrees: number;
    readonly verificationCopies: number;
    readonly branches: number;
  };
  readonly branchFacts: readonly {
    readonly branchRef: string;
    readonly tipCommit: string | null;
    readonly deleted: boolean;
    readonly detail: string;
  }[];
  readonly reclamation: readonly {
    readonly kind: string;
    readonly resourceId: string;
    readonly path: string;
    readonly outcome: string;
    readonly reasonCode: string;
    readonly branchRef: string | null;
  }[];
  /** What `--force` stepped over (ADR-0058 D09); null when the deletion was not forced. */
  readonly forced: {
    readonly bypassed: readonly { readonly code: string; readonly detail: string }[];
    readonly termination: {
      readonly attempted: boolean;
      readonly signalsSent: number;
      readonly terminated: boolean;
      readonly survivors: readonly number[];
      readonly unattributable: readonly number[];
      readonly detail: string;
    } | null;
  } | null;
  readonly dependencyEdgesRemoved: number;
  readonly rowsDeleted: Readonly<Record<string, number>>;
  readonly detail: string;
}

/**
 * The result of `task retry` (ADR-0036), which is deliberately **two** facts: the requeue the
 * Runtime recorded, and the scheduling answer for the one start request that followed it. A retry
 * that was recorded but is waiting for capacity (or refused by the gate) has still requeued the
 * Task, and this shape lets the client say that instead of reporting a start that did not happen.
 */
export interface TaskRetryOutcomeView {
  readonly projectId: string;
  readonly taskId: string;
  /** The Task's state after the requeue: `BLOCKED` when an upstream dependency is unmet. */
  readonly state: 'READY' | 'BLOCKED';
  readonly version: number;
  readonly retryId: string;
  readonly failedExecutionId: string;
  readonly failedAttemptNumber: number;
  readonly adapterId: string;
  readonly previousAdapterId: string | null;
  readonly adapterChanged: boolean;
  readonly adapterSource: 'REQUESTED' | 'RECORDED' | 'FALLBACK';
  /**
   * Where the new Execution's worktree comes from. `REUSE_VERIFIED` and `PREPARE_FRESH` are the
   * worktree it will use; `REBUILD_OWNED` is a verified *plan* the preparation path executes.
   */
  readonly workspace: {
    readonly mode: 'REUSE_VERIFIED' | 'PREPARE_FRESH' | 'REBUILD_OWNED';
    readonly workspaceId: string | null;
    readonly evidence: string | null;
    readonly detail: string;
  };
  readonly dependencyReasons: readonly {
    readonly code: string;
    readonly prerequisiteTaskId: string;
    readonly requiredRevisionId: string;
    readonly detail: string | null;
  }[];
  readonly start: ScheduleStartOutcomeView;
}

/* ------------------------------------------------------------------------------------------------
 * Runtime global load control (FOUNDATION-097 / ADR-0061 D04–D10).
 *
 * The whole shape is the `scheduler control status` result; the UI adds nothing to it and derives no
 * state of its own. `state` is the Runtime's own enumerated control state, and `targets` is the
 * per-incarnation evidence a caller needs to tell "every process is verified stopped" from "the
 * command was accepted".
 * ---------------------------------------------------------------------------------------------- */

export type RuntimeGlobalControlState =
  | 'RUNNING' | 'PAUSING' | 'PAUSED' | 'RESUMING' | 'RECOVERY_REQUIRED';

export type RuntimePauseTargetState =
  | 'PENDING' | 'STOPPED' | 'RESUMED' | 'EXITED' | 'RECOVERY_REQUIRED';

export interface RuntimePauseTargetObservationView {
  /** A stable code, or one of the settled names (`STOPPED`/`RESUMED`/`EXITED`/`PENDING`). */
  readonly code: string;
  readonly detail: string;
  readonly observedAt: number;
  /** The start token read from the real process at this observation; null when unreadable. */
  readonly startToken: string | null;
  readonly identityMatched: boolean;
  readonly processState: 'RUNNING' | 'STOPPED' | 'EXITED' | 'UNKNOWN';
  readonly adapterSupport: string;
}

export interface RuntimePauseTargetView {
  readonly targetId: string;
  readonly pauseEpoch: number;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly incarnationId: string;
  readonly providerPid: number;
  readonly providerStartToken: string;
  readonly state: RuntimePauseTargetState;
  readonly observation: RuntimePauseTargetObservationView;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RuntimeGlobalControlView {
  readonly state: RuntimeGlobalControlState;
  readonly pauseEpoch: number;
  readonly version: number;
  readonly requestedAt: number | null;
  readonly requestedBy: string | null;
  readonly settledAt: number | null;
  readonly detail: unknown;
  readonly code: string | null;
  readonly platformSupported: boolean;
  readonly platform: string;
  readonly targets: readonly RuntimePauseTargetView[];
  /**
   * Always `null`: the Runtime-global capacity numbers are `scheduler capacity get`'s contract
   * (schema v34's other half, ADR-0061 D01–D03). The UI must not invent them here.
   */
  readonly capacity: null;
  readonly capacityNote: string;
}

