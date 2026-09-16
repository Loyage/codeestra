import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  DependencyGraphError,
  createDependencyGraph,
  decideProseQuestionResolution,
  DomainError,
  noToolCallsWithTrailingQuestionMarkHeuristic,
  proseQuestionPromptKind,
  PROSE_QUESTION_NO_TOOL_USE,
  revisionDeliverySatisfied,
  recheckImpactSnapshotGeneration,
  transitionRevisionDelivery,
  validateProseQuestionResolution,
  wouldCreateCycle,
  type AgentCompletionFacts,
  type AgentCompletionNote,
  type ProseQuestionResolution,
  type ProseQuestionResolutionCode,
  type DependencyEdge,
  type ImpactSnapshotGeneration,
  type ImpactSnapshotRecheck,
  type RevisionDelivery,
  type RevisionDeliveryChannel,
  type RevisionDeliveryState,
} from '@codeestra/domain';
import type { AgentAnswer, CapacityWaitReason, SessionHandoffCompletedPayload,
  SessionHandoffEventType, SessionHandoffStartedPayload, SlotCapacityCheck, SlotReservationDetailView,
  SlotReservationView, TakeoverFailedPayload, TakeoverReleasedPayload, TakeoverRequestedPayload,
  TakeoverSafePointReachedPayload, TerminalWriterLeaseChangedPayload } from '@codeestra/contracts';
import { defaultConcurrencyLimit, maxConcurrencyLimit, sessionHandoffEventTypes,
  schedulerGlobalAggregateType,
  type SchedulerGlobalEventType, type RuntimeGlobalControlState,
  sessionHandoffStartedPayloadSchema, sessionHandoffCompletedPayloadSchema,
  takeoverFailedPayloadSchema, takeoverReleasedPayloadSchema, takeoverRequestedPayloadSchema,
  takeoverSafePointReachedPayloadSchema,
  agentPluginSelectionSchema, agentPluginTraceSchema,
  terminalWriterLeaseChangedPayloadSchema } from '@codeestra/contracts';
import type { AgentPluginSelection } from '@codeestra/contracts';
import {
  agentAnswerMigration,
  agentConfigurationMigration,
  agentPluginSelectionMigration,
  agentDisconnectMigration,
  agentObservationMigration,
  agentStartMigration,
  capacitySlotReservationMigration,
  devClonePromotionMigration,
  impactAnalysisMigration,
  integrationBatchTerminalStatesMigration,
  integrationPipelineMigration,
  intentKindShrinkMigration,
  intentKinds,
  knowledgeLayerMigration,
  operationProgressMigration,
  phase1Migration,
  phase1SchemaVersion,
  reclamationMigration,
  resolveMigratedGlobalLimit,
  revisionDeliveryMigration,
  runtimeGlobalCapacityMigration,
  runtimePauseControlMigration,
  sessionGuidanceMigration,
  taskBaselineRefMigration,
  taskRevisionFeaturesMigration,
  sessionHandoffMigration,
  sessionTerminalMigration,
  stablePromotionMigration,
  taskControlMigration,
  taskDependenciesMigration,
  taskRetryMigration,
  taskVerificationMigration,
  unregisteredReclamationMigration,
  verificationLayeringMigration,
  verificationProgressMigration,
  workspaceRetryMigration,
} from './migration.js';
import type { IntentKind } from './migration.js';

/**
 * The `intents.kind` values this build accepts (ADR-0046). The database CHECK is the last line of
 * defence; this list is what a boundary refusal is checked against, so a removed kind fails with a
 * stable code instead of surfacing as a raw SQLite constraint error.
 */
export { intentKinds };
export type { IntentKind };

/**
 * Refuses an Intent kind the schema no longer declares. The writers of `intents` are internal
 * (Task creation, revision creation, Attention answering), so this guard exists to keep a future
 * caller from discovering the shrink as an opaque `CHECK constraint failed`.
 */
export function assertIntentKind(kind: string): IntentKind {
  const match = intentKinds.find((candidate) => candidate === kind);
  if (match === undefined) {
    throw new StorageError('UNSUPPORTED_INTENT_KIND',
      `Intent kind ${kind} is not one of ${intentKinds.join(', ')}`);
  }
  return match;
}

export class StorageError extends Error {
  constructor(
    readonly code: 'UNSUPPORTED_SCHEMA' | 'COMMAND_CONFLICT' | 'CONCURRENT_MODIFICATION'
      | 'NOT_FOUND' | 'INVALID_STATE'
      // Prose-question waits carry their own stable codes (FOUNDATION-069), so a refusal names
      // exactly which part of the wait was wrong instead of a generic state error.
      | ProseQuestionResolutionCode | 'PROSE_QUESTION_RESOLUTION_REQUIRED'
      // The `intents.kind` CHECK was narrowed in schema v28 (ADR-0046), so a removed kind is a
      // boundary refusal with its own code rather than a raw SQLite constraint error.
      | 'UNSUPPORTED_INTENT_KIND'
      // `task.recover` only means something for a Task the Runtime is waiting to reconcile
      // (ADR-0055), so "there is nothing to reconcile here" is its own refusal instead of a generic
      // state error a caller would have to read a sentence to understand.
      | 'TASK_NOT_IN_RECOVERY'
      // `task.purge` (ADR-0058) permanently deletes a Task, so a Task that already put a commit into
      // `dev` or into a stable promotion is refused with its own code instead of one generic
      // "cannot delete": deleting it would erase the record of which commit entered which ref.
      | 'TASK_INTEGRATED_INTO_DEV'
      | 'TASK_IN_STABLE_PROMOTION',
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export type CommandResult = Readonly<Record<string, unknown>>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A UUID derived from stable parts instead of random bytes. A migration that writes a fixed fact
 * (the adopted legacy capacity value) reuses one event identity if it ever has to re-derive it, so
 * the ledger records "this is the v34 adoption" rather than a new random id per attempt.
 */
function deterministicUuid(seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The Task a long-command Operation belongs to. A run owns its Task directly; a verification
 * Operation names it in the request payload it was created with. Kept in one place so the event
 * payload and the Operation projection can never disagree about which Task progress belongs to.
 */
function operationTaskId(
  kind: string,
  aggregateId: string,
  requestJson: string,
): string | null {
  try {
    const request = JSON.parse(requestJson) as Record<string, unknown>;
    if (typeof request['taskId'] === 'string') return request['taskId'] as string;
  } catch { /* A malformed request payload must not break a progress write. */ }
  return kind === 'RUN_TASK' ? aggregateId : null;
}

/**
 * Capacity configuration and resource reservations (FOUNDATION-054 / ADR-0032).
 *
 * A reservation carries the evidence of who created it — the Runtime boot, the process id, and the
 * OS start token for that pid — because a bare "this row is mine" claim is not ownership evidence.
 * `holderStartToken` is nullable on purpose: the OS may refuse to answer, and a missing token is a
 * fact that the reconcile must treat as "unverifiable", never as "gone".
 */
export type SlotReservationState = 'RESERVED' | 'RELEASED' | 'RECOVERY_REQUIRED';
export type SlotReservationReleaseKind = 'EXPLICIT' | 'RECONCILED_HOLDER_EXITED'
  | 'RECONCILED_PROCESS_ID_REUSED';
export type SlotHolderObservationKind = 'HOLDER_STOPPED' | 'HOLDER_PROCESS_ID_REUSED'
  | 'HOLDER_STILL_RUNNING' | 'HOLDER_OWNERSHIP_UNVERIFIABLE' | 'PROCESS_IDENTITY_MISSING';
export type SlotReservationEventKind = 'RESERVED' | 'RELEASED' | 'RECONCILE_OBSERVED';

/**
 * The Runtime-wide concurrency configuration (ADR-0061 D01/D02, schema v34).
 *
 * One `CODEESTRA_HOME` is one resource domain with exactly one limit, so the record carries no
 * Project and no Adapter: `DEFAULT` means the singleton row does not exist and the documented
 * default 2 applies. Project-scoped capacity no longer exists, which is why the two former
 * configuration tables (`project_capacity_limits`, `project_adapter_slot_limits`) are retired by
 * the v34 migration rather than kept as a hidden override layer.
 */
export interface RuntimeCapacityRecord {
  readonly limit: number;
  /** `DEFAULT` means no singleton row exists and the documented default applies. */
  readonly limitSource: 'DEFAULT' | 'EXPLICIT';
  readonly version: number;
  readonly updatedAt: number | null;
  readonly updatedBy: string | null;
}

export interface RuntimeCapacityChange {
  readonly changed: boolean;
  readonly capacity: RuntimeCapacityRecord;
}

/** One Task occupying a slot right now, with the facts that made it an occupant. */
export interface SlotOccupant {
  readonly taskId: string;
  /** The Project the occupying Task belongs to; capacity itself is Runtime-wide (ADR-0061). */
  readonly projectId: string;
  /** Every Adapter this Task occupies a slot for (normally exactly one). */
  readonly adapterIds: readonly string[];
  /** The active reservation, or null when the occupant is an Execution holding its workspace. */
  readonly reservationId: string | null;
  readonly state: SlotReservationState | null;
  readonly since: number;
  /**
   * Which of the two facts made this Task an occupant. A reservation is the stronger fact and wins
   * when a Task has both, so the reported source is the one a client can act on (release it, or
   * wait for the Execution to finish).
   */
  readonly source: 'RESERVATION' | 'EXECUTION';
}

/**
 * Who occupies a slot right now: counted per Task across the whole Runtime, never per row.
 *
 * `ADAPTER_SLOT_LIMIT_REACHED` used to be a second dimension of this same read; ADR-0061 removed
 * the Adapter limit, so `adapterUsed`/`adapterBlocking` are gone rather than always zero. The
 * historical wait code and every historical event stay readable; they are simply never produced
 * again.
 */
export interface SlotOccupancy {
  readonly globalUsed: number;
  readonly globalBlocking: readonly string[];
  readonly occupants: readonly SlotOccupant[];
}

export interface ExecutionSlotAcquisition {
  readonly outcome: 'RESERVED' | 'CAPACITY_WAIT' | 'DRAINING';
  readonly capacity: SlotCapacityCheck;
  readonly wait: CapacityWaitReason | null;
  readonly reservation: SlotReservationDetail | null;
}

/**
 * What one acquisition observed about the ImpactSnapshot generation it names, handed to the write
 * transaction so the *same* E1 judgment (`scheduler.md` §2: "recheck cached snapshot generations")
 * is applied again under the write lock.
 *
 * The observation is not the decision: `files`, `policyVersion`, `analyzerVersion` and (before a
 * worktree exists) `baseCommit` are facts the caller read from Git, because they are not persisted
 * anywhere the transaction could re-read. What the transaction *can* re-read — the snapshot row, the
 * Task's current revision, and the worktree's baseline — is re-read here, so a writer that moved one
 * of them between the caller's observation and this write is a refusal rather than a reservation on
 * a stale assessment.
 */
export interface SlotSnapshotRecheckInput {
  readonly snapshotId: string;
  /** The change set observed for the Task right now: worktree paths, or empty without a worktree. */
  readonly files: readonly string[];
  readonly policyVersion: string;
  readonly analyzerVersion: string;
  /** Where the baseline came from: the Task's own worktree, or the project's Task baseline ref
   * (the dev clone's `dev`, or the project folder's checked out branch) before one exists (ADR-0060). */
  readonly baselineSource: 'WORKSPACE' | 'BASELINE_REF';
  /** The observed baseline; re-read from the worktree row when `baselineSource` is `WORKSPACE`. */
  readonly baseCommit: string;
  /** Evidence for the refusal facts only; the change-set decision is the exact path set. */
  readonly changeFingerprint: string | null;
}

export interface SlotReservationAcquireInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly reservationId: string;
  readonly expectedTaskVersion: number;
  readonly expectedRevisionId: string;
  readonly adapterId: string;
  readonly workspaceId: string | null;
  readonly impactSnapshotId: string | null;
  /**
   * The generation recheck, or `null`/absent when the caller asserted no impact assessment at all.
   * `null` is not "the snapshot is valid": it means there is no cached generation to be stale, which
   * is the shape an explicitly released `UNKNOWN` assessment has (ADR-0030 D05).
   */
  readonly snapshotRecheck?: SlotSnapshotRecheckInput | null;
  /** Fingerprint of the Task's dependency facts as the caller assessed them. */
  readonly dependencyFingerprint: string;
  readonly assessedDevCommit: string | null;
  readonly holder: {
    readonly bootId: string;
    readonly pid: number;
    readonly startToken: string | null;
    readonly actor: string;
  };
  /** Read again inside the transaction: draining may start between the caller's check and this write. */
  readonly draining: () => { readonly draining: boolean; readonly reason: string | null };
  readonly commandId: string;
  readonly payloadHash: string;
  readonly eventId: string;
  readonly createdAt: number;
}

export interface SlotReservationReleaseResult {
  readonly released: boolean;
  readonly outcome: 'RELEASED' | 'ALREADY_RELEASED';
  readonly reservation: SlotReservationDetail;
}

export interface SlotReservationReconcileOutcome {
  readonly outcome: 'RELEASED' | 'MARKED_RECOVERY_REQUIRED' | 'HELD' | 'ALREADY_RELEASED'
    | 'ALREADY_RECONCILED';
  readonly state: SlotReservationState;
  readonly reservation: SlotReservationDetail;
}

/**
 * A refused reservation carries its own stable code: "the dependency graph moved", "the Task is not
 * reservable", "a slot is already held" and "the revision changed" are different answers, and so is
 * "the cached snapshot generation this reservation was assessed against is no longer current".
 *
 * `SNAPSHOT_STALE` and `SNAPSHOT_UNAVAILABLE` are deliberately separate: the first says the snapshot
 * was read and no longer describes the Task (with `detail` naming the components that moved), the
 * second says the snapshot could not be read or the current facts could not be observed at all — and
 * an unreadable snapshot is never treated as a valid one.
 */
export class SlotReservationError extends Error {
  constructor(readonly code: 'CAPACITY_LIMIT_INVALID' | 'CAPACITY_LIMIT_OUT_OF_RANGE'
    | 'UNKNOWN_ADAPTER' | 'TASK_NOT_RESERVABLE' | 'REVISION_CHANGED' | 'DEPENDENCY_STATE_CHANGED'
    | 'SLOT_ALREADY_RESERVED' | 'SLOT_NOT_ACTIVE' | 'SLOT_ALREADY_BOUND'
    | 'SLOT_HELD_BY_ANOTHER_RUNTIME' | 'SLOT_HOLDER_STILL_RUNNING'
    | 'SNAPSHOT_STALE' | 'SNAPSHOT_UNAVAILABLE', message: string,
  /** Machine-readable facts behind the code, so a script never has to parse the sentence. */
  readonly detail: Readonly<Record<string, unknown>> | null = null) {
    super(message);
    this.name = 'SlotReservationError';
  }
}

export interface TrustedProject {
  readonly id: string;
  readonly name: string;
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  /** Ref whose committed verification policy governs this project (ADR-0006). */
  readonly mainRef: string;
  /** Ref every Task worktree is based on and every result is integrated into (ADR-0009). */
  readonly devRef: string;
  /**
   * The second clone of the same origin a promotion pushes its fixed candidate from (ADR-0047
   * D05), or null when the project has none. Recorded only after it was verified as a separate
   * clone of this origin sitting on `dev`; a path that cannot be verified is refused, never stored.
   */
  readonly devRepoPath: string | null;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly policyVersion: number;
  readonly trustedAt: number;
}

export interface StoredConstraint {
  readonly id: string;
  readonly text: string;
}

export type TaskLifecycleState = 'DRAFT' | 'BLOCKED' | 'READY' | 'RUNNING' | 'PAUSING'
  | 'PAUSED' | 'WAITING_FOR_USER' | 'RECOVERY_REQUIRED' | 'EXECUTED' | 'FAILED'
  | 'CANCELLING' | 'CANCELLED' | 'SUCCEEDED';

/**
 * States that own a workspace and may hold a provider process. Archiving one would hide a Task
 * whose Execution still consumes Git/resources, so it must be cancelled first.
 */
const ACTIVE_TASK_STATES: ReadonlySet<TaskLifecycleState> = new Set([
  'RUNNING', 'PAUSING', 'PAUSED', 'WAITING_FOR_USER', 'CANCELLING', 'RECOVERY_REQUIRED',
]);

export interface AgentStartPlan {
  readonly operationId: string;
  readonly operationState: 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
  readonly projectId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly executionId: string;
  readonly executionVersion: number;
  readonly sessionId: string;
  readonly sessionState: 'STARTING' | 'ACTIVE' | 'EXITED' | 'RECOVERY_REQUIRED';
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly ownershipToken: string;
  readonly revisionId: string;
  readonly specification: string;
  readonly constraints: readonly StoredConstraint[];
  readonly providerSessionId: string | null;
  /** Effective Agent configuration this Execution was reserved with; `null` means defaults. */
  readonly agentConfig: StoredAgentConfiguration | null;
}

export interface ObservableAgentSession {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly executionId: string;
  readonly executionVersion: number;
  readonly executionState: 'RUNNING' | 'WAITING_FOR_USER';
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly sessionState: 'ACTIVE' | 'WAITING_FOR_USER';
  readonly adapterId: string;
  readonly providerSessionId: string;
  readonly cursor?: string;
}

/**
 * Everything a transcript read needs about one recorded Agent Session, including the provider's
 * own session file path. The path stays inside the Runtime: it is never part of a client response.
 */
export interface SessionTranscriptTarget {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly executionId: string;
  readonly attemptNumber: number;
  readonly executionState: ExecutionLifecycleState;
  readonly sessionId: string;
  readonly sessionState: AgentSessionLifecycleState;
  readonly providerSessionId: string | null;
  readonly sessionStorageRef: string | null;
}

/**
 * The answer as persisted for one Attention. It is the public command answer type rather than a
 * second, hand-maintained union: a stored answer must be exactly what a client was allowed to send.
 */
export type StoredAgentAnswer = Readonly<AgentAnswer>;

export interface AttentionSummary {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly providerRequestId: string;
  readonly kind: 'QUESTION' | 'PERMISSION' | 'RECOVERY';
  readonly responseType: 'CONFIRM' | 'VALUE';
  readonly prompt: unknown;
  readonly status: 'OPEN' | 'ANSWER_RECORDED' | 'DELIVERED' | 'CLOSED' | 'STALE';
  readonly createdAt: number;
}

export interface AgentAnswerPlan extends AttentionSummary {
  readonly operationId: string;
  readonly operationState: 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
  readonly answerId: string;
  readonly answer: StoredAgentAnswer;
  readonly adapterId: string;
  readonly providerSessionId: string;
}

/**
 * The recorded outcome of ending one prose-question wait. It states the resolved states in full so
 * a caller never has to guess what happened: the provider is gone, the wait is closed, and the
 * answer — if there was one — stayed on this side.
 */
export interface ProseQuestionResolutionPlan {
  readonly attentionId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly resolution: ProseQuestionResolution;
  readonly answerText: string | null;
  readonly note: string | null;
  readonly actor: string;
  readonly taskState: 'RUNNING';
  readonly executionState: 'RUNNING';
  readonly sessionState: 'EXITED';
  readonly attentionStatus: 'CLOSED';
  readonly deliveredToProvider: false;
  readonly resolvedAt: number;
}

/**
 * The recorded shape of one escalated prose question. The Attention carries no provider request, so
 * `providerRequestId` is a derived stand-in the Runtime can always recognize as its own, and the
 * prompt is the FOUNDATION-056 note restated as a wait.
 */
export interface ProseQuestionWaitProjection {
  readonly attentionId: string;
  readonly attentionEventId: string;
  readonly taskEventId: string;
  readonly providerRequestId: string;
  readonly prompt: unknown;
}

export interface AdapterEventResult {
  readonly duplicate: boolean;
  readonly eventId: string;
  readonly cursor: string;
  readonly sessionState: 'ACTIVE' | 'WAITING_FOR_USER' | 'EXITED' | 'DISCONNECTED';
  readonly executionState: 'RUNNING' | 'WAITING_FOR_USER' | 'FAILED' | 'RECOVERY_REQUIRED';
  readonly attentionId?: string;
}

export interface StoredEventEnvelope {
  readonly eventId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly schemaVersion: number;
  /**
   * The Project this fact belongs to, or `null` for a Runtime-global fact (ADR-0061 D10, schema v34).
   *
   * `NULL` is not "unknown": it means the fact genuinely belongs to no Project — a global capacity
   * change and a global pause — and a Project-filtered subscriber receives it *in addition to* that
   * Project's own events, because a global decision affects every Project.
   */
  readonly projectId: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly occurredAt: number;
  readonly payload: unknown;
}

export interface PendingEventDelivery extends StoredEventEnvelope {
  readonly consumerId: string;
  readonly attemptCount: number;
}

export interface ExecutionReservation {
  readonly executionId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly attemptNumber: number;
  readonly revisionId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly ownershipToken: string;
  readonly baseCommit: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly state: 'CREATED';
}

/** Result of requesting a Task stop (pause or cancel). */
export interface TaskStopRequest {
  readonly taskId: string;
  /** `PAUSING`/`CANCELLING` when a provider process must be released; a terminal state otherwise. */
  readonly state: TaskLifecycleState;
  readonly version: number;
  readonly executionId: string | null;
  readonly sessionId: string | null;
  /** True when the Task reached its terminal state without an Execution to stop. */
  readonly terminal: boolean;
}

/** Result of a Task resume that hands off to a new Execution in the retained workspace. */
export interface TaskResumeRequest {
  readonly taskId: string;
  readonly state: 'READY';
  readonly version: number;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly resumeFromExecutionId: string;
  readonly predecessorSessionId: string;
  readonly predecessorSessionStorageRef: string;
  readonly predecessorProviderSessionId: string | null;
}

/**
 * How a retry treats the Task's own worktree (ADR-0036, extended by ADR-0042). `REUSE_VERIFIED`
 * means the filesystem and Git confirmed the recorded worktree is this Task's own; `PREPARE_FRESH`
 * means nothing is there at all, so the existing preparation path may create one; `REBUILD_OWNED`
 * means the recorded worktree was reclaimed but the Task branch it kept still descends from the
 * recorded baseline, so the existing preparation path re-creates the worktree at the recorded path
 * from that branch. `REBUILD_OWNED` is a verified plan, not a completed rebuild.
 */
export type TaskRetryWorkspaceMode = 'REUSE_VERIFIED' | 'PREPARE_FRESH' | 'REBUILD_OWNED';

/** Result of an explicit retry of a failed Task, including the audit record it wrote. */
export interface TaskRetryRequest {
  readonly taskId: string;
  /** `BLOCKED` when the dependency verdict was re-evaluated as unmet by the same command. */
  readonly state: 'READY' | 'BLOCKED';
  readonly version: number;
  /** The append-only audit event this retry wrote. */
  readonly retryId: string;
  readonly failedExecutionId: string;
  readonly failedAttemptNumber: number;
  readonly adapterId: string;
  readonly previousAdapterId: string | null;
  readonly adapterChanged: boolean;
  readonly workspaceMode: TaskRetryWorkspaceMode;
  readonly workspaceId: string | null;
  readonly workspaceEvidence: string | null;
  readonly dependencyReasons: readonly TaskDependencyBlockReason[];
}

/** The most recent worktree record for one Task, in whatever state it was left. */
export interface TaskWorkspaceRecord {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly path: string;
  readonly branchRef: string;
  readonly ownershipToken: string;
  readonly baseCommit: string;
  readonly state: WorkspaceLifecycleState;
  readonly createdAt: number;
}

export type ExecutionLifecycleState = 'CREATED' | 'PREPARING' | 'STARTING' | 'RUNNING'
  | 'WAITING_FOR_USER' | 'PAUSING' | 'PAUSED' | 'STOPPING' | 'RECOVERY_REQUIRED' | 'SUCCEEDED'
  | 'FAILED' | 'CANCELLED' | 'SUPERSEDED';

export type AgentSessionLifecycleState = 'CREATED' | 'STARTING' | 'ACTIVE' | 'WAITING_FOR_USER'
  | 'PAUSING' | 'PAUSED' | 'STOPPING' | 'EXITED' | 'DISCONNECTED' | 'RECOVERY_REQUIRED';

export type WorkspaceLifecycleState = 'RESERVED' | 'PREPARING' | 'READY' | 'IN_USE'
  | 'RECOVERY_REQUIRED' | 'RETAINED' | 'RELEASED';

/**
 * Bounded failure reason persisted with a terminal Execution. `code` is the Runtime's own
 * classification; `message` is the provider's own text when an adapter reported one.
 */
export const executionErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1).optional(),
});
export type ExecutionError = z.infer<typeof executionErrorSchema>;

/**
 * Parse schema for the completion note the Runtime records next to a settled Agent run. The shape
 * is a typed twin of the domain's `AgentCompletionNote`, so a change on either side is a compile
 * error here rather than a silently dropped note.
 */
const completionFactsSchema: z.ZodType<AgentCompletionFacts> = z.strictObject({
  toolCallCount: z.number().int().nonnegative(),
  finalAssistantText: z.string().max(2000).nullable(),
  finalAssistantTextTruncated: z.boolean(),
  finalAssistantStopReason: z.string().max(64).nullable(),
});

const agentCompletionNoteSchema: z.ZodType<AgentCompletionNote> = z.strictObject({
  code: z.literal(PROSE_QUESTION_NO_TOOL_USE),
  heuristic: z.literal(noToolCallsWithTrailingQuestionMarkHeuristic),
  message: z.string().min(1),
  facts: completionFactsSchema,
});

/**
 * The recorded Agent-session completion: the provider's outcome, the facts behind it (when the
 * Adapter could report them) and the Runtime's own note about an ending it must not leave
 * unexplained. `note` is `null` for an ordinary completion.
 */
export interface AgentSessionCompletion {
  readonly outcome: 'SUCCESS' | 'FAILURE';
  readonly evidenceRef: string | null;
  readonly failure: ExecutionError | null;
  readonly facts: AgentCompletionFacts | null;
  /** A stable code plus the facts it was applied to; see FOUNDATION-056. */
  readonly note: AgentCompletionNote | null;
}

const sessionCompletionSchema = z.object({
  outcome: z.enum(['SUCCESS', 'FAILURE']),
  evidence: z.object({ ref: z.string().min(1) }).partial().optional(),
  failure: executionErrorSchema.optional(),
  facts: completionFactsSchema.optional(),
  note: agentCompletionNoteSchema.optional(),
});

/**
 * Reads the completion projection out of `agent_sessions.exit_json`. The same column also carries
 * unrelated payloads (a start failure, a disconnect reason), so anything without a completion
 * outcome is reported as "no completion recorded" instead of an invented one.
 */
function parseSessionCompletion(json: string | null): AgentSessionCompletion | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  const result = sessionCompletionSchema.safeParse(parsed);
  if (!result.success) return null;
  const data = result.data;
  return {
    outcome: data.outcome,
    evidenceRef: data.evidence?.ref ?? null,
    failure: data.failure ?? null,
    facts: data.facts ?? null,
    note: data.note ?? null,
  };
}

function parseExecutionError(json: string | null): ExecutionError | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    // The column is JSON-validated by the schema; a parse failure means the row was edited
    // outside this code path. Report the Execution without inventing a reason.
    return null;
  }
  const result = executionErrorSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Thinking levels Pi accepts; the Runtime passes them through and Pi clamps to the model. */
export const agentThinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const agentThinkingLevelSchema = z.enum(agentThinkingLevels);
export type AgentThinkingLevel = z.infer<typeof agentThinkingLevelSchema>;

/**
 * One Execution's resolved configuration. Only explicitly set fields are present, so an absent
 * key means the Adapter's own default was used for that field rather than a value Codeestra
 * invented.
 */
export const storedAgentConfigurationSchema = z.strictObject({
  provider: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  thinkingLevel: agentThinkingLevelSchema.optional(),
  /**
   * The plugin/resources this Execution's Agent Session was allowed to load, with the layer that
   * supplied them and the recorded third-party-extension approval risk (ADR-0044 D04). Absent means
   * "the controlled launch with no user resource", which is the same launch Codeestra always used.
   */
  plugins: agentPluginTraceSchema.optional(),
});
export type StoredAgentConfiguration = z.infer<typeof storedAgentConfigurationSchema>;

function parseAgentConfiguration(json: string | null): StoredAgentConfiguration | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    // JSON-validated by the column; a parse failure means the row was edited outside this path.
    return null;
  }
  const result = storedAgentConfigurationSchema.safeParse(parsed);
  if (!result.success) return null;
  return Object.keys(result.data).length === 0 ? null : result.data;
}

/** A persisted per-scope override; `null` fields mean "no override at this scope". */
export interface AgentConfigurationRecord {
  readonly scope: 'GLOBAL' | 'PROJECT';
  readonly projectId: string | null;
  readonly adapterId: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinkingLevel: AgentThinkingLevel | null;
  /**
   * This scope's plugin selection, or `null` when this scope overrides nothing. A selection is a
   * whole-field override: a scope that names plugins replaces the lower-precedence scope's list
   * rather than adding to it (ADR-0044 D01).
   */
  readonly pluginSelection: AgentPluginSelection | null;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

interface AgentConfigurationRow {
  readonly id: string;
  readonly scope: 'GLOBAL' | 'PROJECT';
  readonly project_id: string | null;
  readonly adapter_id: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinking_level: AgentThinkingLevel | null;
  readonly plugin_selection_json: string | null;
  readonly updated_at: number;
  readonly updated_by: string;
}

/** Read-only projection of one Execution attempt and the Agent Session it started, if any. */
export interface ExecutionSummary {
  readonly executionId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly state: ExecutionLifecycleState;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly resourceHeld: boolean;
  readonly baseCommit: string;
  readonly revisionId: string;
  /** The captured result commit of this attempt; null until a result commit is recorded. */
  readonly resultCommit: string | null;
  /** Recorded reason for a terminal failure; `null` while running or when none was recorded. */
  readonly error: ExecutionError | null;
  /** Why a terminal Execution stopped; `null` while active or when none applies. */
  readonly stopReason: 'USER_CANCEL' | 'USER_PAUSE' | 'REVISION_RESTART' | 'SHUTDOWN' | null;
  /** The Execution this attempt continued through provider conversation resume, if any. */
  readonly resumeFromExecutionId: string | null;
  /**
   * The failed Execution an explicit retry (`task retry`, ADR-0036) followed, if any. This is the
   * relation a retry creates: a *new* Execution, not a continuation of the old conversation, so it
   * is a different fact from `resumeFromExecutionId` and is stored in its own column.
   */
  readonly retryFromExecutionId: string | null;
  /** Effective Agent configuration this Execution started with, as recorded at reservation. */
  readonly agentConfig: StoredAgentConfiguration | null;
  readonly session: {
    readonly sessionId: string;
    readonly state: AgentSessionLifecycleState;
    readonly providerSessionId: string | null;
    readonly cursor: string | null;
    /**
     * The completion this Session recorded, including any note the Runtime had to add. `null` while
     * the Session has not completed (or completed without a recorded outcome).
     */
    readonly completion: AgentSessionCompletion | null;
  } | null;
}

export interface ResultCommitAuthorization {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly taskVersion: number;
  readonly taskState: TaskLifecycleState;
  readonly currentRevisionId: string;
  readonly executionId: string;
  readonly executionState: ExecutionLifecycleState;
  readonly appliedRevisionId: string;
  readonly resourceHeld: boolean;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly workspaceBranchRef: string;
  readonly workspaceState: WorkspaceLifecycleState;
  readonly baseCommit: string;
  readonly expectedHead: string;
  readonly changeFingerprint: string;
  readonly status: 'ACTIVE' | 'CONSUMED' | 'INVALIDATED';
  readonly createdAt: number;
  /** Recorded result commit once the authorization was consumed. */
  readonly resultCommit: string | null;
  /** True only when a SUCCESS completion proved tools and owned writers stopped. */
  readonly quiescent: boolean;
  readonly sessionState: AgentSessionLifecycleState | null;
}

export interface ResultCommitCapturePlan {
  readonly operationId: string;
  readonly operationState: 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
  readonly authorizationId: string;
  readonly executionId: string;
  readonly taskId: string;
  readonly expectedHead: string;
  readonly changeFingerprint: string;
  readonly authorization: ResultCommitAuthorization;
  /** Recorded commit and tree when the capture already succeeded. */
  readonly resultCommit: string | null;
  readonly resultTree: string | null;
}

export interface WorkspacePreparationPlan {
  readonly operationId: string;
  readonly operationState: 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
  readonly projectId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly workspaceState: 'RESERVED' | 'PREPARING' | 'READY' | 'RECOVERY_REQUIRED' | 'RELEASED';
  /**
   * The repository that owns this worktree: the project's dev clone (ADR-0056). It is what a
   * restart re-reads when it reconciles an interrupted preparation (`git worktree list` has to be
   * asked in the clone the worktree was created in). The record's `gitCommonDir` and `mainRef`
   * stay the trusted main checkout's facts.
   */
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  /** Fixed base ref for the worktree this plan prepares; the base commit is read from it. */
  readonly devRef: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly baseCommit: string;
  readonly ownershipToken: string;
  readonly branchRef: string;
  readonly path: string;
}

/** Internal projection used while a result commit is being authorized or captured. */
export interface ResultCommitSubject {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly taskVersion: number;
  readonly taskState: TaskLifecycleState;
  readonly currentRevisionId: string;
  readonly executionId: string;
  readonly executionVersion: number;
  readonly executionState: ExecutionLifecycleState;
  readonly appliedRevisionId: string;
  readonly resourceHeld: boolean;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly workspaceBranchRef: string;
  readonly workspaceState: WorkspaceLifecycleState;
  readonly baseCommit: string;
  readonly quiescent: boolean;
  readonly sessionState: AgentSessionLifecycleState | null;
}

/** The verification policy confirmation that established project trust. */
export interface VerificationPolicyConfirmationInput {
  readonly state: 'ABSENT' | 'PRESENT';
  readonly digest: string | null;
  readonly mainRef: string;
  readonly mainCommit: string;
}

/** Read projection of an active confirmation, including who confirmed it and when. */
export interface ConfirmedVerificationPolicy extends VerificationPolicyConfirmationInput {
  readonly actor: string;
  readonly confirmedAt: number;
}

/**
 * The impact mapping (`ADR-0031`) declared when trust was established. `INVALID` keeps the digest of
 * the raw bytes: a mapping that cannot be parsed is a recorded fact, not a silent "no mapping".
 */
export interface ImpactPolicyConfirmationInput {
  readonly state: 'ABSENT' | 'PRESENT' | 'INVALID';
  readonly digest: string | null;
  readonly contentDigest: string | null;
  readonly code: string | null;
  readonly mainRef: string;
  readonly mainCommit: string;
}

export interface ConfirmedImpactPolicy extends ImpactPolicyConfirmationInput {
  readonly actor: string;
  readonly confirmedAt: number;
}

/** One shared resource a snapshot touched, kept as data so a rehydrated snapshot stays analyzable. */
export interface StoredImpactResourceRef {
  readonly id: string;
  readonly kind: string;
  readonly written: boolean;
  readonly read: boolean;
}

/**
 * A stored ImpactSnapshot. It carries exactly what the pure analyzer needs to be re-run later
 * (`files`, matched scope, completeness and its reasons) plus the facts its reuse is keyed on.
 */
export interface ImpactSnapshotInput {
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
  readonly globalResources: readonly StoredImpactResourceRef[];
  readonly unclassifiedFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly createdAt: number;
}

export type ImpactSnapshotRecord = ImpactSnapshotInput;

/** The reuse key of `docs/architecture/conflict-analyzer.md` §4: any component moving invalidates. */
export interface ImpactSnapshotKey {
  readonly taskId: string;
  readonly revisionId: string;
  readonly baseCommit: string;
  readonly analyzerVersion: string;
  readonly policyVersion: string;
  readonly changeFingerprint: string;
}

/** Pair-wise audit row. The pair itself is the key, so a changed fact needs a new snapshot. */
export interface ImpactAssessmentInput {
  readonly id: string;
  readonly projectId: string;
  readonly candidateTaskId: string;
  readonly candidateRevisionId: string;
  readonly candidateSnapshotId: string;
  readonly otherTaskId: string;
  readonly otherRevisionId: string;
  readonly otherSnapshotId: string;
  readonly verdict: 'SAFE_TO_PARALLELIZE' | 'UNKNOWN' | 'CONFLICTING';
  readonly reasonCodes: readonly string[];
  readonly hits: readonly unknown[];
  readonly evidence: readonly string[];
  readonly createdAt: number;
}

export type ImpactAssessmentRecord = ImpactAssessmentInput;

// ---------------------------------------------------------------------------------------------
// Project Knowledge (FOUNDATION-067 / ADR-0041). The persisted model is described in
// `knowledgeLayerMigration`; these types are what a reader gets back.
// ---------------------------------------------------------------------------------------------

export type KnowledgeLayerName = 'instructions' | 'skills' | 'generated';
export type KnowledgeScopeName = 'ALL' | 'DEVELOPMENT' | 'SELF';

/** Provenance of one entry. Present only for machine-generated entries (`source` is required). */
export interface StoredKnowledgeEntryOrigin {
  readonly source?: string;
  readonly kind?: string;
  readonly revision?: string;
  readonly commit?: string;
}

/** One entry as it was resolved, without its body: the body digest is what identity is made of. */
export interface StoredKnowledgeEntry {
  readonly layer: KnowledgeLayerName;
  readonly path: string;
  readonly id: string | null;
  readonly scope: KnowledgeScopeName;
  readonly digest: string;
  readonly bytes: number;
  readonly origin: StoredKnowledgeEntryOrigin;
}

/**
 * One immutable knowledge snapshot: the complete entry list a project declared at one `main`
 * commit, plus the digests that identify it. Written once and never updated (the table has no
 * update path at all), so an Execution bound to it stays truthful after the knowledge is edited.
 */
export interface KnowledgeSnapshotInput {
  readonly id: string;
  readonly projectId: string;
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly policyVersion: string;
  readonly snapshotDigest: string;
  readonly humanDigest: string;
  readonly generatedDigest: string;
  readonly entryCount: number;
  readonly humanEntryCount: number;
  readonly generatedEntryCount: number;
  readonly totalBytes: number;
  readonly entries: readonly StoredKnowledgeEntry[];
  readonly createdBy: string;
  readonly createdAt: number;
}

export type KnowledgeSnapshotRecord = KnowledgeSnapshotInput;

/** The reuse key: the same declared knowledge at the same commit is the same snapshot. */
export interface KnowledgeSnapshotKey {
  readonly projectId: string;
  readonly mainCommit: string;
  readonly snapshotDigest: string;
}

/**
 * The binding between one Execution and the knowledge it actually used, including the digest of the
 * exact context file materialized into that Execution's worktree. This is the row that answers
 * "which knowledge version did this run use".
 */
export interface ExecutionKnowledgeSnapshotInput {
  readonly executionId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly contextPath: string;
  readonly contextDigest: string;
  readonly contextBytes: number;
  readonly entryCount: number;
  readonly refs: readonly string[];
  readonly commandId: string;
  readonly createdAt: number;
}

export type ExecutionKnowledgeSnapshotRecord = ExecutionKnowledgeSnapshotInput;

/**
 * One Task the analyzer must compare against: a Task that holds a resource, which is exactly the
 * active/reserved set of `docs/architecture/scheduler.md` §1 (readying, RUNNING, WAITING_FOR_USER,
 * PAUSING/PAUSED, stopping/cancelling, RECOVERY_REQUIRED, and reserved-but-unstarted Executions all
 * hold their Execution row).
 */
export interface ImpactActiveTaskRef {
  readonly taskId: string;
  readonly taskState: TaskLifecycleState;
  readonly revisionId: string;
  readonly executionId: string;
  readonly executionState: ExecutionLifecycleState;
  readonly workspaceId: string | null;
  readonly workspacePath: string | null;
  readonly workspaceBaseCommit: string | null;
  readonly workspaceState: WorkspaceLifecycleState | null;
}

/**
 * One Task a feature conflict is decided against (ADR-0059): its state, its archive flag and the
 * features its current revision declares. `features` is never empty — the projection that produces
 * this shape excludes Tasks that declare nothing, because a Task with no declaration cannot share a
 * feature with anyone.
 */
export interface FeatureConflictPeerRef {
  readonly taskId: string;
  readonly displayNumber: number;
  readonly taskState: TaskLifecycleState;
  readonly archived: boolean;
  readonly revisionId: string;
  readonly features: readonly string[];
}

/** The Task an assessment is made for, plus the newest workspace it could still produce changes in. */
export interface ImpactCandidateTaskRef {
  readonly taskId: string;
  readonly taskState: TaskLifecycleState;
  readonly revisionId: string;
  readonly archived: boolean;
  /** The declared features of the current revision; the only judged fact of a conflict (ADR-0059). */
  readonly features: readonly string[];
  readonly workspaceId: string | null;
  readonly workspacePath: string | null;
  readonly workspaceBaseCommit: string | null;
  readonly workspaceState: WorkspaceLifecycleState | null;
}

/**
 * Task verification states. `CANCELLED` is a terminal state of its own (ADR-0027): a run the user
 * stopped is not a failed command, so it must not be recorded as `ERROR` with a borrowed outcome
 * code. `CANCELLED` is only ever written after the owned command group was confirmed stopped; an
 * unconfirmed stop leaves the run `RUNNING` (see `LongOperationService.cancel`).
 */
export type VerificationState = 'QUEUED' | 'RUNNING' | 'PASSED' | 'FAILED' | 'ERROR'
  | 'CANCELLED' | 'STALE';

/** One command of a confirmed policy, as it was frozen into a run. */
export interface StoredVerificationCommand {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds: number;
}

/** Non-secret evidence: exit facts, digests, and paths, never captured command output. */
export type VerificationEvidence = Readonly<Record<string, unknown>>;

export interface VerificationCandidateExecution {
  readonly executionId: string;
  readonly attemptNumber: number;
  readonly state: ExecutionLifecycleState;
  readonly appliedRevisionId: string;
  readonly resultCommit: string | null;
  readonly baseCommit: string;
}

/** Read-only facts the verification service needs before it may run anything. */
export interface VerificationCandidates {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly taskState: TaskLifecycleState;
  readonly currentRevisionId: string;
  /**
   * The repository the *tested commits* live in: the project's dev clone (ADR-0056). A Task's
   * candidate is captured in a Task worktree, and every Task worktree is a worktree of the dev
   * clone, so a detached verification copy has to be created from that clone.
   */
  readonly repositoryRoot: string;
  /** The stable main checkout: its `main` ref carries the verification policy (ADR-0006). */
  readonly mainRepositoryRoot: string;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly executions: readonly VerificationCandidateExecution[];
}

export interface VerificationRunSummary {
  readonly verificationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly revisionId: string;
  readonly testedCommit: string;
  readonly testedTree: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  /** Which record the executed commands came from (ADR-0038/0039); never inferred from the digest. */
  readonly policySource: VerificationPolicySource;
  /** The recorded targeted test plan this run used, when the source is that plan. */
  readonly planId: string | null;
  readonly planVersion: string | null;
  readonly planDigest: string | null;
  readonly mainCommit: string;
  readonly commands: readonly StoredVerificationCommand[];
  readonly copyPath: string;
  readonly state: VerificationState;
  readonly outcomeCode: string | null;
  readonly evidence: VerificationEvidence | null;
  readonly queuedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

export interface VerificationRunPlan extends VerificationRunSummary {
  readonly operationId: string;
  readonly operationState: 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
}

/**
 * Where a verification run's commands came from (ADR-0038/0039). The digest alone cannot say this:
 * the same bytes could in principle describe both a policy and a plan, and a report that guessed
 * would be claiming the branch-targeted run and the fixed project policy are the same thing.
 */
export type VerificationPolicySource = 'PROJECT_POLICY' | 'TARGETED_TEST_PLAN';

/**
 * One append-only targeted test plan record (ADR-0038/0039). It binds a branch's
 * `.codeestra/tests.json` to the exact `(task, revision, commit, digest)` it was chosen for; a
 * scope change appends a new row, so the evidence a verification produced stays attributable.
 */
export interface TargetedTestPlanRecord {
  readonly planId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly revisionId: string;
  readonly testedCommit: string;
  readonly planVersion: string;
  readonly planDigest: string;
  readonly sourcePath: string;
  readonly scope: string;
  readonly commands: readonly StoredVerificationCommand[];
  readonly recordedBy: string;
  readonly recordedAt: number;
}

/** One dev full-suite run. Only `PASSED` can carry a `dev → main` promotion. */
export type DevFullSuiteState = 'QUEUED' | 'RUNNING' | 'PASSED' | 'FAILED' | 'ERROR';

/**
 * Independent "full suite passed on this exact dev SHA" evidence (ADR-0038 D03, ADR-0039). Every
 * run is one row bound to the candidate commit, the fixed project policy read from `main`, and the
 * lockfile at that commit; a re-run inserts a new row instead of rewriting the old one.
 */
export interface DevFullSuiteEvidenceRecord {
  readonly evidenceId: string;
  readonly projectId: string;
  readonly devRef: string;
  readonly devCommit: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly lockfilePath: string;
  /** False when the project has no lockfile at the candidate commit; the absence is the binding. */
  readonly lockfilePresent: boolean;
  readonly lockfileDigest: string;
  readonly commands: readonly StoredVerificationCommand[];
  readonly copyPath: string;
  readonly state: DevFullSuiteState;
  readonly outcomeCode: string | null;
  readonly evidence: VerificationEvidence | null;
  readonly commandId: string;
  readonly observedBy: string;
  readonly queuedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

/** Repository facts a dev full-suite run needs; no Task is involved in this evidence. */
export interface DevFullSuiteCandidates {
  readonly projectId: string;
  /** The dev clone: the fixed candidate commit is an object of this clone (ADR-0056). */
  readonly repositoryRoot: string;
  /** The stable main checkout, whose `main` ref carries the fixed full-suite policy. */
  readonly mainRepositoryRoot: string;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  readonly devRef: string;
  readonly objectFormat: 'sha1' | 'sha256';
}

export type PromotionPermissionMode = 'FULL' | 'STRICT';

/**
 * Stable branch promotion projections (ADR-0009 D02/D03, ADR-0022, ADR-0047). One promotion fixes
 * the facts it is allowed to act on — the verified `dev` commit, the expected old `main` commit, and
 * the independent integration verification of the promoted commit — together with the permission
 * mode, the dev clone it pushes from, the remote readbacks, and the Runtime restart result.
 *
 * `CREATED` holds the fixed evidence. `AWAITING_APPROVAL` exists only in STRICT and records the
 * exact approved triple, so a later `dev`/`main`/evidence movement is detectable as `STALE`.
 * `PROMOTING` means the fixed candidate was pushed to the remote `dev` and the remote was read back
 * and matched: it is "pushed, awaiting the manual pull in the main checkout" (ADR-0047 D03), **not**
 * "main moved". `RESTARTING` means the main checkout was observed at the candidate (the user pulled)
 * and the restart sequence was recorded; its result has to be recorded by a later Runtime.
 * `RECOVERY_REQUIRED` is a resumable, blocking state: reconciliation found the promotion mid-flight
 * and states what the refs actually say.
 */
export type StablePromotionState = 'CREATED' | 'AWAITING_APPROVAL' | 'PROMOTING' | 'RESTARTING'
  | 'SUCCEEDED' | 'STALE' | 'FAILED' | 'RECOVERY_REQUIRED';

/**
 * Which of the two distinguishable promotion facts a record currently states (ADR-0047 D03).
 * `AWAITING_PULL` and `MAIN_PUSH_PENDING` are the two that must never be reported as a finished
 * promotion: the first has pushed to the remote `dev` only, the second has a restarted main
 * checkout whose new commit is not published on the remote `main` yet.
 */
export type PromotionPhase = 'READY_TO_PUSH' | 'AWAITING_PULL' | 'RESTART_PENDING'
  | 'MAIN_PUSH_PENDING' | 'COMPLETE' | 'REFUSED';

/** One Task revision whose result the promoted `dev` commit contains. */
export interface PromotionMember {
  readonly batchId: string;
  readonly taskId: string;
  readonly revisionId: string;
  readonly executionId: string;
  readonly candidateCommit: string;
}

/** The fixed restart sequence: absolute cwd plus argv. Recorded before the Runtime stops. */
export interface PromotionRestartPlanStep {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
}

export interface PromotionRestartStepOutcome {
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

/** What the client observed when it checked the restarted Runtime. */
export interface PromotionRestartResult {
  readonly observedBootId: string;
  readonly runtimeStatus: string | null;
  readonly uiRunning: boolean | null;
  readonly steps: readonly PromotionRestartStepOutcome[];
}

/** Everything the promoting client needs to run the post-steps without asking again. */
export interface StablePromotionSummary {
  readonly promotionId: string;
  readonly projectId: string;
  readonly devRef: string;
  readonly mainRef: string;
  readonly candidateCommit: string;
  readonly expectedMainCommit: string;
  readonly integrationBatchId: string;
  readonly verificationId: string;
  readonly verificationTestedCommit: string;
  readonly permissionMode: PromotionPermissionMode;
  readonly state: StablePromotionState;
  readonly approval: {
    readonly devCommit: string; readonly mainCommit: string;
    readonly verificationId: string;
    /** The exact dev full-suite evidence the approval also covered (ADR-0039). */
    readonly fullSuiteEvidenceId: string | null;
    readonly approvedAt: number;
  } | null;
  /**
   * The exact dev full-suite evidence this promotion was prepared against (ADR-0038 D03).
   * `promote` re-reads all three bindings and refuses if any of them moved.
   */
  readonly fullSuite: {
    readonly evidenceId: string;
    readonly devCommit: string;
    readonly policyVersion: string;
    readonly policyDigest: string;
    readonly lockfileDigest: string;
  } | null;
  /** Commit the main checkout was observed at; NULL until the pull was observed (ADR-0047 D03). */
  readonly promotedCommit: string | null;
  /** The worktree that has `main` checked out; NULL until the pull was observed there. */
  readonly mainWorktreePath: string | null;
  /** Boot identity of the Runtime that issued the restart plan after the pull was observed. */
  readonly promotingBootId: string | null;
  /** The dev clone this promotion pushes its candidate from (ADR-0047 D05). */
  readonly devRepoPath: string | null;
  /**
   * Commit read back from the remote dev ref after the push. This is a *readback*, never an input:
   * the promotion only records it after `git ls-remote` reported the fixed candidate, which is what
   * makes "the push exited 0" unable to stand in for "the candidate is on the remote".
   */
  readonly remoteDevCommit: string | null;
  /** Commit read back from the remote main ref after the stable commit was published there. */
  readonly remoteMainCommit: string | null;
  readonly pushedAt: number | null;
  readonly mainPushedAt: number | null;
  /** Which pair of facts (pushed / pulled-and-restarted) this record currently states. */
  readonly phase: PromotionPhase;
  readonly restartSteps: readonly PromotionRestartPlanStep[];
  readonly restart: PromotionRestartResult | null;
  readonly outcomeCode: string | null;
  readonly detail: string | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
  /** Task revisions the promoted commit contains, fixed at preparation time. */
  readonly members: readonly PromotionMember[];
}

export interface StablePromotionPlan extends StablePromotionSummary {
  readonly operationId: string;
  readonly operationState: 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  readonly objectFormat: 'sha1' | 'sha256';
}

/** Read-only facts the promotion service needs before it may touch any ref. */
export interface PromotionCandidates {
  readonly projectId: string;
  readonly batchId: string;
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  readonly devRef: string;
  /** The project's recorded dev clone, or null when it has none (ADR-0047 D05). */
  readonly devRepoPath: string | null;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly batchState: IntegrationBatchState;
  readonly batchDevRef: string;
  readonly batchDevCommit: string;
  readonly batchMergedCommit: string | null;
  readonly batchIntegratedCommit: string | null;
  readonly verificationState: VerificationState | null;
  readonly verificationId: string | null;
  readonly verificationTestedCommit: string | null;
  readonly verificationDevCommit: string | null;
  readonly verificationOutcomeCode: string | null;
  readonly members: readonly PromotionMember[];
  /** The open promotion of this project, if any; a second attempt must not race it. */
  readonly openPromotion: StablePromotionSummary | null;
}

/**
 * Integration pipeline projections (ADR-0018, ADR-0053). A batch fixes the `dev` baseline, carries
 * one or more member candidates, and records the merges and the single independent integration
 * verification that allowed the `dev` ref to advance. `integratedCommit` is null until the ref
 * actually moved.
 *
 * The states follow `docs/architecture/state-machines.md` §4: `CREATED → PREPARING → VERIFYING →
 * INTEGRATING_DEV → INTEGRATED`, with `CONFLICTED`/`FAILED`/`RECOVERY_REQUIRED` as the other ends.
 * `INTEGRATING_DEV` exists because a crash between the ref write and the record is only resolvable
 * by comparing the recorded `mergedCommit` against the ref that was actually written.
 *
 * Two further terminal verdicts belong to the multi-member contract (ADR-0053) and are never mixed
 * with a failure:
 *
 * - `STALE`: the fixed evidence (a member's revision/result commit, or the recorded `dev` baseline)
 *   stopped being the current fact before anything was integrated. `dev` is untouched and no merge
 *   ran; the batch has to be composed again from the current facts.
 * - `CANCELLED`: the user ended a batch that had no Git side effect yet. A batch that already has a
 *   recorded worktree, merge or verification is never cancelled from here — it needs reconciliation
 *   first, so it becomes `RECOVERY_REQUIRED/RECONCILE_REQUIRED` instead.
 */
export type IntegrationBatchState = 'CREATED' | 'PREPARING' | 'VERIFYING' | 'INTEGRATING_DEV'
  | 'INTEGRATED' | 'CONFLICTED' | 'FAILED' | 'RECOVERY_REQUIRED' | 'STALE' | 'CANCELLED';
export type IntegrationItemState = 'PREPARED' | 'MERGED' | 'INTEGRATED' | 'FAILED' | 'CONFLICTED';
export type MergeStrategy = 'FAST_FORWARD' | 'MERGE_COMMIT';

export interface IntegrationBatchItemSummary {
  readonly batchId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly revisionId: string;
  readonly executionId: string;
  readonly candidateCommit: string;
  readonly devCommit: string;
  readonly state: IntegrationItemState;
  readonly integratedCommit: string | null;
  readonly detail: string | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
}

export interface IntegrationBatchSummary {
  readonly batchId: string;
  readonly projectId: string;
  readonly devRef: string;
  readonly devCommit: string;
  readonly state: IntegrationBatchState;
  readonly integratedCommit: string | null;
  readonly mergeStrategy: MergeStrategy | null;
  /** The merge Git produced, recorded before the ref moves; null until a merge was recorded. */
  readonly mergedCommit: string | null;
  readonly worktreePath: string | null;
  readonly verificationId: string | null;
  readonly outcomeCode: string | null;
  readonly detail: string | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
  readonly items: readonly IntegrationBatchItemSummary[];
}

/** One member of a batch, with the facts its fixed record has to be compared against. */
export interface IntegrationBatchMemberFacts {
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly taskState: TaskLifecycleState;
  readonly taskVersion: number;
  readonly currentRevisionId: string;
  /** The revision the batch fixed for this member. */
  readonly revisionId: string;
  readonly executionId: string;
  readonly executionState: ExecutionLifecycleState;
  readonly resultCommit: string | null;
  /** The result commit the batch fixed for this member. */
  readonly candidateCommit: string;
  /** The PASSED Task verification of exactly this revision and result commit, when one exists. */
  readonly taskVerificationId: string | null;
  readonly taskVerificationTestedCommit: string | null;
}

/** Reads for one composed batch: its record, its project, and every member's current facts. */
export interface IntegrationBatchCandidates {
  readonly projectId: string;
  readonly batchId: string;
  /** The dev clone: the batch's `dev` ref, merge and compare-and-swap all happen there (ADR-0056). */
  readonly repositoryRoot: string;
  /** The stable main checkout; the verification policy is read from its `main` ref. */
  readonly mainRepositoryRoot: string;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  readonly devRef: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly batch: IntegrationBatchSummary;
  readonly members: readonly IntegrationBatchMemberFacts[];
}

/** Read-only facts the integration service needs before it may touch any ref. */
export interface IntegrationCandidates {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly taskState: TaskLifecycleState;
  readonly taskVersion: number;
  readonly currentRevisionId: string;
  /** The dev clone: the project's `dev` ref and every Task branch commit live there (ADR-0056). */
  readonly repositoryRoot: string;
  /** The stable main checkout; the verification policy is read from its `main` ref. */
  readonly mainRepositoryRoot: string;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  readonly devRef: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly executions: readonly VerificationCandidateExecution[];
  /** Task verification runs for this Task, newest first. */
  readonly verificationRuns: readonly VerificationRunSummary[];
  readonly batches: readonly IntegrationBatchSummary[];
}

/** Plan for the merge side effect: reserved before anything is written to Git. */
export interface IntegrationBatchPlan extends IntegrationBatchSummary {
  readonly operationId: string;
  readonly operationState: 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
  readonly worktreeOwnershipToken: string;
  /**
   * The dev clone: a restart reconciles an interrupted batch by reading the `dev` ref *there*
   * (ADR-0056). The plan's `mainRef` stays the stable main ref the policy came from.
   */
  readonly repositoryRoot: string;
  readonly mainRef: string;
  readonly objectFormat: 'sha1' | 'sha256';
  /** The batch's first member; `items` carries every member (ADR-0053). */
  readonly item: IntegrationBatchItemSummary;
}

export interface IntegrationVerificationSummary {
  readonly verificationId: string;
  readonly batchId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly revisionId: string;
  readonly testedCommit: string;
  readonly testedTree: string;
  readonly devCommit: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly mainCommit: string;
  readonly commands: readonly StoredVerificationCommand[];
  readonly copyPath: string;
  readonly state: VerificationState;
  readonly outcomeCode: string | null;
  readonly evidence: VerificationEvidence | null;
  readonly queuedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

export interface IntegrationVerificationPlan extends IntegrationVerificationSummary {
  readonly operationId: string;
  readonly operationState: 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
}

export interface TaskSummary {
  readonly id: string;
  readonly projectId: string;
  readonly displayNumber: number;
  readonly kind: 'DEVELOPMENT' | 'SELF';
  readonly state: TaskLifecycleState;
  readonly priority: number;
  readonly version: number;
  readonly currentRevision: {
    readonly id: string;
    readonly number: number;
    readonly specification: string;
    readonly constraints: readonly StoredConstraint[];
    /**
     * The feature ids this revision declares (ADR-0059). They are the only judged fact of a conflict:
     * two unfinished Tasks that declare the same feature conflict, and a Task that declares none is
     * never in a feature conflict.
     */
    readonly features: readonly string[];
    readonly createdAt: number;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Set when the Task is archived (soft-deleted); archived Tasks keep every row and worktree. */
  readonly archivedAt: number | null;
}

/** What `task.purge` would delete, read without touching anything (ADR-0058). */
export interface TaskPurgeSubject {
  readonly taskId: string;
  readonly displayNumber: number;
  readonly state: TaskLifecycleState;
  readonly version: number;
  readonly archived: boolean;
  readonly currentRevisionId: string;
  readonly revisionCount: number;
  readonly executionCount: number;
}

/**
 * History outside the Task that a purge would outlive. `dev` (or a stable promotion) would keep a
 * commit whose origin record the deletion erased, so the refusal names which relation holds it.
 */
export interface TaskPurgeBlocker {
  readonly code: 'TASK_INTEGRATED_INTO_DEV' | 'TASK_IN_STABLE_PROMOTION';
  readonly detail: string;
  readonly count: number;
}

/** One owned resource the purge removed, recorded in the audit event before the rows disappear. */
export interface TaskPurgeReclaimedResource {
  readonly kind: string;
  readonly resourceId: string;
  readonly path: string;
  readonly outcome: string;
  readonly reasonCode: string;
  readonly branchRef: string | null;
}

/**
 * The tip of a branch a purge deleted. The branch itself is the Task's unmerged growth and is gone
 * afterwards, so the commit it pointed at is recorded: "a branch was destroyed, at this OID" is a
 * fact, while "a Task was deleted" alone would hide it.
 */
export interface TaskPurgeBranchFact {
  readonly branchRef: string;
  readonly tipCommit: string | null;
  readonly deleted: boolean;
  readonly detail: string;
}

export interface TaskPurgeInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly commandId: string;
  readonly payloadHash: string;
  readonly eventId: string;
  readonly actor: string;
  readonly reason: string | null;
  readonly purgedAt: number;
  readonly reclamation: readonly TaskPurgeReclaimedResource[];
  readonly branches: readonly TaskPurgeBranchFact[];
}

export interface TaskPurgeResult {
  readonly projectId: string;
  readonly taskId: string;
  readonly displayNumber: number;
  readonly state: TaskLifecycleState;
  readonly version: number;
  readonly archived: boolean;
  readonly reason: string | null;
  readonly purgedAt: number;
  readonly eventId: string;
  readonly currentRevisionId: string;
  readonly branchFacts: readonly TaskPurgeBranchFact[];
  readonly reclamation: readonly TaskPurgeReclaimedResource[];
  readonly dependencyEdgesRemoved: number;
  readonly rowsDeleted: Readonly<Record<string, number>>;
  readonly detail: string;
}

/**
 * Which pair of distinguishable promotion facts a record states (ADR-0047 D03).
 *
 * It is derived from the stored state and the recorded restart result, never stored on its own: a
 * second source of truth for the same fact could disagree with the state machine, and the record a
 * client reads would then be the wrong one. `READY_TO_PUSH`/`AWAITING_PULL`/`RESTART_PENDING`/
 * `MAIN_PUSH_PENDING` are **not** a finished promotion; only `COMPLETE` is.
 */
function promotionPhase(input: {
  readonly state: StablePromotionState;
  readonly restart: PromotionRestartResult | null;
}): PromotionPhase {
  if (input.state === 'SUCCEEDED') return 'COMPLETE';
  if (input.state === 'STALE' || input.state === 'FAILED') return 'REFUSED';
  if (input.state === 'CREATED' || input.state === 'AWAITING_APPROVAL') return 'READY_TO_PUSH';
  if (input.state === 'PROMOTING') return 'AWAITING_PULL';
  return input.restart === null ? 'RESTART_PENDING' : 'MAIN_PUSH_PENDING';
}

/**
 * A stored feature list is re-validated on read (ADR-0059). The column only guarantees that the JSON
 * parses as an array; a row edited outside this path must not become a judged fact, and a non-string
 * element would otherwise reach the comparison as `undefined`.
 */
function parseTaskFeatures(json: string): readonly string[] {
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) return Object.freeze([]);
  return Object.freeze(parsed.filter((value): value is string =>
    typeof value === 'string' && value.trim().length > 0));
}

function mapAgentConfigurationRow(row: AgentConfigurationRow): AgentConfigurationRecord {
  return {
    scope: row.scope,
    projectId: row.project_id,
    adapterId: row.adapter_id,
    provider: row.provider,
    model: row.model,
    thinkingLevel: row.thinking_level,
    pluginSelection: parsePluginSelection(row.plugin_selection_json),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/**
 * A stored selection is re-validated on read: the column only guarantees JSON, and a row edited
 * outside this path must not turn into launch arguments for a provider process.
 */
function parsePluginSelection(json: string | null): AgentPluginSelection | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return null;
  }
  const result = agentPluginSelectionSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data;
}

export class Phase1Database {
  readonly sqlite: Database;

  constructor(filename = ':memory:') {
    this.sqlite = new Database(filename, { create: true, strict: true });
    this.sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (filename !== ':memory:') this.sqlite.exec('PRAGMA journal_mode=WAL;');
    try {
      this.migrate();
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
  }

  close(): void {
    this.sqlite.close();
  }

  private migrate(): void {
    const row = this.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get();
    const version = row?.user_version ?? 0;
    if (version > phase1SchemaVersion) {
      throw new StorageError('UNSUPPORTED_SCHEMA', `Database schema ${version} is newer than ${phase1SchemaVersion}`);
    }
    if (version === phase1SchemaVersion) return;
    // `workspaces` (v7), `executions` (v9), `intents` (v28), `integration_batches` (v30) and
    // `domain_events` (v34) are each referenced by name from other tables, so every upgrade below
    // the newest such step runs with foreign keys off and verifies the whole schema before the
    // connection is used.
    const rebuildsTable = version < 34;
    if (rebuildsTable) this.sqlite.exec('PRAGMA foreign_keys=OFF;');
    try {
      this.sqlite.transaction(() => {
        if (version < 1) this.sqlite.exec(phase1Migration);
        if (version < 2) this.sqlite.exec(agentStartMigration);
        if (version < 3) this.sqlite.exec(agentObservationMigration);
        if (version < 4) this.sqlite.exec(agentAnswerMigration);
        if (version < 5) this.sqlite.exec(agentDisconnectMigration);
        if (version < 6) this.sqlite.exec(taskVerificationMigration);
        if (version < 7) this.sqlite.exec(workspaceRetryMigration);
        if (version < 8) this.sqlite.exec(agentConfigurationMigration);
        if (version < 9) this.sqlite.exec(taskControlMigration);
        if (version < 10) this.sqlite.exec(integrationPipelineMigration);
        if (version < 11) this.sqlite.exec(operationProgressMigration);
        if (version < 12) this.sqlite.exec(reclamationMigration);
        if (version < 13) this.sqlite.exec(stablePromotionMigration);
        if (version < 14) this.sqlite.exec(sessionHandoffMigration);
        if (version < 15) this.sqlite.exec(taskDependenciesMigration);
        if (version < 17) this.sqlite.exec(verificationProgressMigration);
        if (version < 18) this.sqlite.exec(sessionTerminalMigration);
        if (version < 19) this.sqlite.exec(revisionDeliveryMigration);
        if (version < 20) this.sqlite.exec(impactAnalysisMigration);
        // Version 21 is this step's own number, so a database stamped 17–20 still gets the
        // capacity/slot tables. No earlier number is ever inserted.
        if (version < 21) this.sqlite.exec(capacitySlotReservationMigration);
        // Version 23 is the Task-retry step (ADR-0036); version 22 remains unoccupied.
        if (version < 23) this.sqlite.exec(taskRetryMigration);
        // Version 24 is this step's own number, so a database stamped 21–23 still gets the
        // unregistered-directory ledger columns. No earlier number is ever inserted.
        if (version < 24) this.sqlite.exec(unregisteredReclamationMigration);
        // Version 25 (FOUNDATION-065 / ADR-0039) and version 26 (FOUNDATION-067 / ADR-0041) are
        // this wave's own numbers, appended in ascending order: a database stamped 21–24 still gets
        // both, and one stamped 25 (from a branch that carried only the first) still gets the
        // second. Version 16 stays permanently unused and no earlier number is ever inserted.
        if (version < 25) this.sqlite.exec(verificationLayeringMigration);
        if (version < 26) this.sqlite.exec(knowledgeLayerMigration);
        // Version 27 is this step's own number (FOUNDATION-071 / ADR-0044): agent plugin selection.
        // A database stamped 17–26 still gets it, and no earlier number is ever inserted.
        if (version < 27) this.sqlite.exec(agentPluginSelectionMigration);
        if (version < 28) {
          // ADR-0046 shrinks `intents.kind`. A row that still uses a removed kind must stop the
          // upgrade with a named reason and leave the original database untouched rather than be
          // dropped or rewritten: the rebuild below cannot express it, and silently losing history
          // is exactly what the audit rules forbid.
          //
          // This pre-check is load-bearing, not decorative. Bun's `Database.exec()` swallows a
          // *step-time* error inside a multi-statement script and keeps executing the rest, so if
          // the `INSERT ... SELECT` inside the rebuild ever violated the narrowed CHECK, the
          // following `DROP TABLE` would still run and the rows would be gone without an error.
          // The comparison after the rebuild turns that failure mode into a loud rollback; any
          // future migration that rebuilds a table must guard its copy the same way.
          const stranded = this.sqlite.query<{ kind: string | null; rows: number }, []>(`
            SELECT kind, COUNT(*) AS rows FROM intents
            WHERE kind IS NOT NULL AND kind NOT IN ('CREATE_TASK','AMEND_TASK','ADD_CONSTRAINT',
              'CANCEL_TASK','ANSWER_AGENT')
            GROUP BY kind ORDER BY kind
          `).all();
          if (stranded.length > 0) {
            const detail = stranded.map((row) => `${row.kind ?? 'NULL'} x${row.rows}`).join(', ');
            throw new StorageError('INVALID_STATE',
              'intents.kind shrinks to five kinds in schema v28 (ADR-0046) and this database still'
              + ` holds rows using a removed kind: ${detail}. Migrate those rows deliberately`
              + ' before upgrading; nothing was changed.');
          }
          const intentsBefore = this.sqlite.query<{ rows: number }, []>(
            'SELECT COUNT(*) AS rows FROM intents').get()?.rows ?? 0;
          this.sqlite.exec(intentKindShrinkMigration);
          const intentsAfter = this.sqlite.query<{ rows: number }, []>(
            'SELECT COUNT(*) AS rows FROM intents').get()?.rows ?? -1;
          if (intentsAfter !== intentsBefore) {
            throw new StorageError('INVALID_STATE',
              `Schema v28 rebuild of intents lost rows (${intentsBefore} before, ${intentsAfter}`
              + ' after); the upgrade was rolled back and nothing was changed');
          }
        }
        // Version 29 is the dev clone and GitHub-mediated promotion step (FOUNDATION-077 /
        // ADR-0047). It is a pure `ADD COLUMN` step, so it runs after the v28 rebuild and needs no
        // foreign-key handling of its own. No earlier number is ever inserted.
        if (version < 29) this.sqlite.exec(devClonePromotionMigration);
        if (version < 30) {
          // ADR-0053 widens `integration_batches.state` with the two terminal verdicts a
          // multi-member batch needs (`STALE`, `CANCELLED`). Widening a `STRICT` table's CHECK means
          // rebuilding the table, so the copy is guarded the same way the v28 `intents` rebuild is:
          // an unexpected row count turns a silently-dropped table into a loud rollback, because
          // Bun's `exec()` swallows a step-time error inside a multi-statement script and would run
          // the following `DROP TABLE` anyway.
          const batchesBefore = this.sqlite.query<{ rows: number }, []>(
            'SELECT COUNT(*) AS rows FROM integration_batches').get()?.rows ?? 0;
          this.sqlite.exec(integrationBatchTerminalStatesMigration);
          const batchesAfter = this.sqlite.query<{ rows: number }, []>(
            'SELECT COUNT(*) AS rows FROM integration_batches').get()?.rows ?? -1;
          if (batchesAfter !== batchesBefore) {
            throw new StorageError('INVALID_STATE',
              `Schema v30 rebuild of integration_batches lost rows (${batchesBefore} before,`
              + ` ${batchesAfter} after); the upgrade was rolled back and nothing was changed`);
          }
        }
        // Version 31 is the Session Guidance step (FOUNDATION-088 / ADR-0057). It only creates three
        // new tables, so it needs no foreign-key handling of its own; the guard above still runs
        // `PRAGMA foreign_key_check` because an upgrade from any older stamped version may rebuild a
        // table on the way. No earlier number is ever inserted.
        if (version < 31) this.sqlite.exec(sessionGuidanceMigration);
        // Version 32 is this step's own number (FOUNDATION-091 / ADR-0059): declared features on a
        // Task revision. A pure `ADD COLUMN`, so it needs no foreign-key handling of its own; a
        // database stamped 17–31 still gets it, and no earlier number is ever inserted.
        if (version < 32) this.sqlite.exec(taskRevisionFeaturesMigration);
        // Version 33 is this step's own number (FOUNDATION-093 / ADR-0060): the base ref a Task
        // worktree was prepared from. A pure `ADD COLUMN` on `workspaces`; a database stamped
        // 17–32 still gets it, and earlier numbers are never re-pointed.
        if (version < 33) this.sqlite.exec(taskBaselineRefMigration);
        // Version 34 is one schema version for **two** halves of ADR-0061: the Runtime-wide capacity
        // limit with its command receipts and the nullable `domain_events.project_id`
        // (FOUNDATION-096), and the persistent global pause state with its freeze targets
        // (FOUNDATION-097). Both branches appended their own block under this number; the integration
        // merged them into this single step, so a database stamped 17–33 gets all of it at once and
        // the capacity half's `domain_events` rebuild happens exactly once.
        //
        // Each half keeps its own method: the capacity half owns the two new tables, the rebuild and
        // the retirement of the legacy configuration tables, the pause half owns `runtime_pause_control`
        // / `runtime_pause_targets` and asserts the end state of the step.
        if (version < 34) {
          this.migrateRuntimeGlobalCapacity();
          this.migrateRuntimePauseControl();
        }
        this.sqlite.exec(`PRAGMA user_version=${phase1SchemaVersion}`);
      })();
      if (rebuildsTable) {
        const violations = this.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new StorageError('INVALID_STATE',
            `Schema migration left ${violations.length} foreign key violation(s)`);
        }
      }
    } finally {
      if (rebuildsTable) this.sqlite.exec('PRAGMA foreign_keys=ON;');
    }
  }

  /**
   * Schema v34, this half of ADR-0061 (FOUNDATION-096): one Runtime-wide capacity limit, the
   * retirement of the two project-scoped configuration tables, and a `domain_events.project_id`
   * that may be NULL for a global fact.
   *
   * The order is load-bearing. Every explicit legacy value is read **before** the DDL script that
   * drops the tables holding them, the deterministic minimum is computed from that read, and a value
   * outside the documented range stops the upgrade with a named reason while the original database is
   * still untouched. Bun's `Database.exec()` swallows a step-time error inside a multi-statement
   * script and keeps going, so `INSERT ... SELECT` copy failures are turned into a loud rollback by
   * comparing the `domain_events` and `event_deliveries` row counts around the rebuild. The whole
   * step runs in `migrate()`'s transaction: any failure rolls back the drops too, which is why the
   * old rows can never be deleted before their values are safely carried over.
   */
  private migrateRuntimeGlobalCapacity(): void {
    const legacyLimits = this.sqlite.query<{ legacy_limit: number }, []>(`
      SELECT global_limit AS legacy_limit FROM project_capacity_limits
      UNION ALL SELECT slot_limit AS legacy_limit FROM project_adapter_slot_limits
    `).all().map((row) => row.legacy_limit);
    const outOfRange = legacyLimits.filter((limit) => !Number.isSafeInteger(limit)
      || limit < 1 || limit > maxConcurrencyLimit);
    if (outOfRange.length > 0) {
      throw new StorageError('INVALID_STATE',
        'Schema v34 adopts the smallest explicit capacity value as the new Runtime-wide limit, and'
        + ` this database records a value outside 1-${maxConcurrencyLimit}: ${outOfRange.join(', ')}.`
        + ' Nothing was changed; resolve those rows deliberately before upgrading.');
    }
    const migratedLimit = resolveMigratedGlobalLimit(legacyLimits);
    const eventsBefore = this.countTableRows('domain_events');
    const deliveriesBefore = this.countTableRows('event_deliveries');
    this.sqlite.exec(runtimeGlobalCapacityMigration);
    if (migratedLimit !== null) {
      const occurredAt = Date.now();
      this.sqlite.query(`
        INSERT INTO runtime_capacity_settings(singleton_id,global_limit,version,updated_at,updated_by)
        VALUES (1,?1,0,?2,'schema-migration')
      `).run(migratedLimit, occurredAt);
      this.appendGlobalCapacityEvent({
        eventId: deterministicUuid(`v34-runtime-capacity:${migratedLimit}`),
        limit: migratedLimit,
        previousLimit: null,
        source: 'MIGRATED_MINIMUM',
        actor: 'schema-migration',
        occurredAt,
      });
    }
    // The rebuild may legitimately add exactly one row: the `MIGRATED_MINIMUM` fact above. Anything
    // else means the copy or the drop lost or duplicated history, and the transaction must roll back.
    const expectedEvents = eventsBefore + (migratedLimit === null ? 0 : 1);
    const eventsAfter = this.countTableRows('domain_events');
    if (eventsAfter !== expectedEvents) {
      throw new StorageError('INVALID_STATE',
        `Schema v34 rebuild of domain_events changed the row count (${eventsBefore} before,`
        + ` ${eventsAfter} after, ${expectedEvents} expected); the upgrade was rolled back and`
        + ' nothing was changed');
    }
    const deliveriesAfter = this.countTableRows('event_deliveries');
    if (deliveriesAfter !== deliveriesBefore) {
      throw new StorageError('INVALID_STATE',
        `Schema v34 rebuild of domain_events changed event_deliveries (${deliveriesBefore} before,`
        + ` ${deliveriesAfter} after); the upgrade was rolled back and nothing was changed`);
    }
  }

  private countTableRows(table: 'domain_events' | 'event_deliveries'): number {
    return this.sqlite.query<{ rows: number }, []>(
      `SELECT COUNT(*) AS rows FROM ${table}`).get()?.rows ?? 0;
  }

  /**
   * Schema v34, the pause half (FOUNDATION-097 / ADR-0061 D07/D10): the persistent Runtime global
   * control state, its per-incarnation freeze targets, and the only pre-existing state a fresh
   * database may be in (`RUNNING`, epoch 0).
   *
   * It runs in the same transaction as the capacity half and after it, because the two halves are one
   * schema version: `domain_events` is rebuilt exactly once (by the capacity half, which owns that
   * statement) and `runtime_command_receipts` is created exactly once (also there, because both
   * halves' global commands share it).
   *
   * The end-state assertions matter as much as the DDL. Bun's `Database.exec()` swallows a step-time
   * error inside a multi-statement script and keeps going, so a statement that failed *after* the
   * capacity half's `DROP TABLE domain_events` would leave the row counts equal while the schema
   * stayed half-built. These reads turn exactly that case into a loud rollback.
   */
  private migrateRuntimePauseControl(): void {
    this.sqlite.exec(runtimePauseControlMigration);
    const globalColumn = this.sqlite.query<{ name: string; notnull: number }, []>(
      "PRAGMA table_info('domain_events')").all()
      .find((column) => column.name === 'project_id');
    if (globalColumn === undefined || globalColumn.notnull !== 0) {
      throw new StorageError('INVALID_STATE',
        'Schema v34 promised a nullable domain_events.project_id and the rebuilt table does not have'
        + ' one; the upgrade was rolled back and nothing was changed');
    }
    const controlRows = this.sqlite.query<{ rows: number }, []>(
      'SELECT COUNT(*) AS rows FROM runtime_pause_control WHERE singleton_id=1')
      .get()?.rows ?? 0;
    if (controlRows !== 1) {
      throw new StorageError('INVALID_STATE',
        'Schema v34 promised one runtime_pause_control singleton row; the upgrade was rolled back'
        + ' and nothing was changed');
    }
  }

  /** Records the explicit confirmation that established project trust, including the
   * verification policy the user saw. Re-trusting an identical repository supersedes the
   * previous trust and policy confirmation instead of rewriting them. */
  trustProject(input: Omit<TrustedProject, 'devRepoPath'> & {
    readonly trustId: string;
    readonly actor: string;
    readonly verificationPolicyConfirmationId: string;
    /**
     * The dev clone this trust records (ADR-0047 D05), or null to clear a previously recorded one.
     * Omit the property to leave whatever the project recorded untouched: trust never silently
     * clears a path it was not asked about, and never stores a path it has not verified.
     */
    readonly devRepoPath?: string | null;
    readonly recordDevRepoPath?: boolean;
    readonly verificationPolicy: VerificationPolicyConfirmationInput;
    /**
     * The impact mapping confirmed by this trust (ADR-0031). When a caller omits it, no active
     * confirmation is written and any previous one is superseded: forgetting to declare the mapping
     * leaves every ImpactSnapshot incomplete (`UNKNOWN`), which is the safe direction — it can never
     * make a Task look parallelizable.
     */
    readonly impactPolicyConfirmationId?: string;
    readonly impactPolicy?: ImpactPolicyConfirmationInput;
  }): void {
    this.sqlite.transaction(() => {
      const existing = this.sqlite.query<{
        id: string; repo_root: string; git_common_dir: string; main_ref: string;
        object_format: 'sha1' | 'sha256';
      }, [string]>(`
        SELECT id,repo_root,git_common_dir,main_ref,object_format FROM projects WHERE repo_root=?1
      `).get(input.repoRoot);
      let projectId = input.id;
      const devRepoPath = input.devRepoPath ?? null;
      // A path is written when this trust declared one (including an explicit null, which clears
      // it); otherwise the project keeps what it already had.
      const writeDevRepoPath = input.recordDevRepoPath === true || input.devRepoPath !== undefined;
      if (existing === null) {
        this.sqlite.query(`
          INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,dev_ref,dev_repo_path,
            object_format,policy_version,created_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
        `).run(input.id, input.name, input.repoRoot, input.gitCommonDir, input.mainRef, input.devRef,
          devRepoPath, input.objectFormat, input.policyVersion, input.trustedAt);
      } else {
        if (existing.repo_root !== input.repoRoot || existing.git_common_dir !== input.gitCommonDir
          || existing.object_format !== input.objectFormat) {
          throw new StorageError('INVALID_STATE', 'Repository identity does not match the trusted project');
        }
        projectId = existing.id;
        // Re-trusting refreshes the baseline ref name as well: it is part of what the user
        // confirmed, and a later integration record must not point at a stale ref name.
        this.sqlite.query(`
          UPDATE projects SET dev_ref=?1 WHERE id=?2
        `).run(input.devRef, projectId);
        // The dev clone path is only written when this trust actually declared one: a re-trust that
        // says nothing about it keeps the recorded path instead of clearing it behind the user's
        // back. Clearing is explicit (`recordDevRepoPath` with a null path).
        if (writeDevRepoPath) {
          this.sqlite.query(`
            UPDATE projects SET dev_repo_path=?1 WHERE id=?2
          `).run(devRepoPath, projectId);
        }
        this.sqlite.query(`
          UPDATE project_trusts SET status='INVALIDATED',invalidated_at=?1
          WHERE project_id=?2 AND status='ACTIVE'
        `).run(input.trustedAt, projectId);
        this.sqlite.query(`
          UPDATE project_verification_policy_confirmations SET status='SUPERSEDED',superseded_at=?1
          WHERE project_id=?2 AND status='ACTIVE'
        `).run(input.trustedAt, projectId);
        this.sqlite.query(`
          UPDATE project_impact_policy_confirmations SET status='SUPERSEDED',superseded_at=?1
          WHERE project_id=?2 AND status='ACTIVE'
        `).run(input.trustedAt, projectId);
      }
      this.sqlite.query(`
        INSERT INTO project_trusts
          (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,'ACTIVE',?8)
      `).run(input.trustId, projectId, input.repoRoot, input.gitCommonDir, input.objectFormat,
        input.policyVersion, input.actor, input.trustedAt);
      this.sqlite.query(`
        INSERT INTO project_verification_policy_confirmations
          (id,project_id,policy_state,policy_digest,main_ref,main_commit,actor,status,confirmed_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,'ACTIVE',?8)
      `).run(input.verificationPolicyConfirmationId, projectId, input.verificationPolicy.state,
        input.verificationPolicy.digest, input.verificationPolicy.mainRef,
        input.verificationPolicy.mainCommit, input.actor, input.trustedAt);
      if (input.impactPolicy !== undefined && input.impactPolicyConfirmationId !== undefined) {
        this.sqlite.query(`
          INSERT INTO project_impact_policy_confirmations
            (id,project_id,policy_state,policy_digest,content_digest,error_code,main_ref,main_commit,
             actor,status,confirmed_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'ACTIVE',?10)
        `).run(input.impactPolicyConfirmationId, projectId, input.impactPolicy.state,
          input.impactPolicy.digest, input.impactPolicy.contentDigest, input.impactPolicy.code,
          input.impactPolicy.mainRef, input.impactPolicy.mainCommit, input.actor, input.trustedAt);
      }
    })();
  }

  invalidateProjectTrust(projectId: string, invalidatedAt: number): void {
    this.sqlite.transaction(() => {
      const result = this.sqlite.query(`
        UPDATE project_trusts SET status='INVALIDATED',invalidated_at=?1
        WHERE project_id=?2 AND status='ACTIVE'
      `).run(invalidatedAt, projectId);
      if (result.changes !== 1) throw new StorageError('NOT_FOUND', 'Active project trust was not found');
      this.sqlite.query(`
        UPDATE project_verification_policy_confirmations SET status='SUPERSEDED',superseded_at=?1
        WHERE project_id=?2 AND status='ACTIVE'
      `).run(invalidatedAt, projectId);
      this.sqlite.query(`
        UPDATE project_impact_policy_confirmations SET status='SUPERSEDED',superseded_at=?1
        WHERE project_id=?2 AND status='ACTIVE'
      `).run(invalidatedAt, projectId);
    })();
  }

  /** Active impact-mapping confirmation for a trusted project, or null when none was recorded. */
  getConfirmedImpactPolicy(projectId: string): ConfirmedImpactPolicy | null {
    const row = this.sqlite.query<{
      policy_state: 'ABSENT' | 'PRESENT' | 'INVALID'; policy_digest: string | null;
      content_digest: string | null; error_code: string | null; main_ref: string;
      main_commit: string; actor: string; confirmed_at: number;
    }, [string]>(`
      SELECT c.policy_state,c.policy_digest,c.content_digest,c.error_code,c.main_ref,c.main_commit,
             c.actor,c.confirmed_at
      FROM project_impact_policy_confirmations c
      JOIN project_trusts trust ON trust.project_id=c.project_id AND trust.status='ACTIVE'
      WHERE c.project_id=?1 AND c.status='ACTIVE'
    `).get(projectId);
    if (row === null) return null;
    return {
      state: row.policy_state,
      digest: row.policy_digest,
      contentDigest: row.content_digest,
      code: row.error_code,
      mainRef: row.main_ref,
      mainCommit: row.main_commit,
      actor: row.actor,
      confirmedAt: row.confirmed_at,
    };
  }

  /** Active confirmation for a trusted project, or null when trust never confirmed one. */
  getConfirmedVerificationPolicy(projectId: string): ConfirmedVerificationPolicy | null {
    const row = this.sqlite.query<{
      policy_state: 'ABSENT' | 'PRESENT'; policy_digest: string | null; main_ref: string;
      main_commit: string; actor: string; confirmed_at: number;
    }, [string]>(`
      SELECT c.policy_state,c.policy_digest,c.main_ref,c.main_commit,c.actor,c.confirmed_at
      FROM project_verification_policy_confirmations c
      JOIN project_trusts trust ON trust.project_id=c.project_id AND trust.status='ACTIVE'
      WHERE c.project_id=?1 AND c.status='ACTIVE'
    `).get(projectId);
    if (row === null) return null;
    return {
      state: row.policy_state,
      digest: row.policy_digest,
      mainRef: row.main_ref,
      mainCommit: row.main_commit,
      actor: row.actor,
      confirmedAt: row.confirmed_at,
    };
  }

  getTrustedProject(projectId: string): TrustedProject {
    const project = this.listTrustedProjects().find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new StorageError('NOT_FOUND', 'Trusted project was not found');
    return project;
  }

  listTrustedProjects(): readonly TrustedProject[] {
    return this.sqlite.query<{
      id: string; name: string; repo_root: string; git_common_dir: string; main_ref: string;
      dev_ref: string; dev_repo_path: string | null;
      object_format: 'sha1' | 'sha256'; policy_version: number; accepted_at: number;
    }, []>(`
      SELECT p.id,p.name,p.repo_root,p.git_common_dir,p.main_ref,p.dev_ref,p.dev_repo_path,
             p.object_format,p.policy_version,t.accepted_at
      FROM projects p JOIN project_trusts t ON t.project_id=p.id AND t.status='ACTIVE'
      ORDER BY t.accepted_at,p.id
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      repoRoot: row.repo_root,
      gitCommonDir: row.git_common_dir,
      mainRef: row.main_ref,
      devRef: row.dev_ref,
      devRepoPath: row.dev_repo_path,
      objectFormat: row.object_format,
      policyVersion: row.policy_version,
      trustedAt: row.accepted_at,
    }));
  }

  createTask(input: {
    readonly projectId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly intentId: string;
    readonly taskId: string;
    readonly revisionId: string;
    readonly intentEventId: string;
    readonly taskEventId: string;
    readonly specification: string;
    readonly constraints: readonly StoredConstraint[];
    /**
     * Feature ids already validated against the project's declared mapping (ADR-0059). Omitting the
     * list means exactly what an empty list means: this Task declares no feature, so it can never be
     * in a feature conflict.
     */
    readonly features?: readonly string[];
    readonly kind: 'DEVELOPMENT' | 'SELF';
    readonly actor: string;
    readonly createdAt: number;
  }): TaskSummary {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.createdAt,
      apply: (database) => {
        const project = database.query<{ id: string }, [string]>(`
          SELECT p.id FROM projects p JOIN project_trusts t
            ON t.project_id=p.id AND t.status='ACTIVE' WHERE p.id=?1
        `).get(input.projectId);
        if (project === null) throw new StorageError('NOT_FOUND', 'Trusted project was not found');
        const next = database.query<{ display_number: number }, [string]>(`
          SELECT COALESCE(MAX(display_number),0)+1 AS display_number FROM tasks WHERE project_id=?1
        `).get(input.projectId);
        if (next === null) throw new Error('Could not allocate a Task display number');

        this.insertIntent(database, {
          id: input.intentId, projectId: input.projectId, idempotencyKey: input.commandId,
          rawText: input.specification, kind: 'CREATE_TASK', status: 'APPLIED',
          actor: input.actor, createdAt: input.createdAt,
        });
        database.query(`
          INSERT INTO tasks(id,project_id,display_number,kind,current_revision_id,state,
            priority,version,created_at,updated_at)
          VALUES (?1,?2,?3,?4,?5,'DRAFT',0,0,?6,?6)
        `).run(input.taskId, input.projectId, next.display_number, input.kind,
          input.revisionId, input.createdAt);
        database.query(`
          INSERT INTO task_revisions(id,task_id,number,previous_revision_id,specification,
            constraints_json,features_json,source_intent_id,actor,reason,created_at)
          VALUES (?1,?2,1,NULL,?3,?4,?5,?6,?7,'initial task creation',?8)
        `).run(input.revisionId, input.taskId, input.specification,
          JSON.stringify(input.constraints), JSON.stringify(input.features ?? []), input.intentId,
          input.actor, input.createdAt);
        database.query('INSERT INTO intent_targets(intent_id,task_id) VALUES (?1,?2)')
          .run(input.intentId, input.taskId);
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'IntentRecorded',1,'Intent',?3,0,?4,?4,?5,?6)
        `).run(input.intentEventId, input.projectId, input.intentId, input.commandId, input.createdAt,
          JSON.stringify({ intentId: input.intentId, kind: 'CREATE_TASK' }));
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskCreated',1,'Task',?3,0,?4,?5,?6,?7)
        `).run(input.taskEventId, input.projectId, input.taskId, input.commandId,
          input.intentEventId, input.createdAt,
          JSON.stringify({ taskId: input.taskId, revisionId: input.revisionId, kind: input.kind,
        features: input.features ?? [] }));
        return {
          id: input.taskId,
          projectId: input.projectId,
          displayNumber: next.display_number,
          kind: input.kind,
          state: 'DRAFT' as const,
          priority: 0,
          version: 0,
          currentRevision: {
            id: input.revisionId,
            number: 1,
            specification: input.specification,
            constraints: input.constraints,
            features: Object.freeze([...(input.features ?? [])]),
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          archivedAt: null,
        };
      },
    });
  }

  listTasks(projectId: string, options?: { readonly includeArchived?: boolean }): readonly TaskSummary[] {
    const project = this.sqlite.query<{ id: string }, [string]>(`
      SELECT p.id FROM projects p JOIN project_trusts t
        ON t.project_id=p.id AND t.status='ACTIVE' WHERE p.id=?1
    `).get(projectId);
    if (project === null) throw new StorageError('NOT_FOUND', 'Trusted project was not found');
    const archivedClause = options?.includeArchived === true ? '' : 'AND t.archived_at IS NULL';
    return this.sqlite.query<{
      id: string; project_id: string; display_number: number; kind: 'DEVELOPMENT' | 'SELF';
      state: TaskLifecycleState; priority: number; version: number; revision_id: string; revision_number: number;
      specification: string; constraints_json: string; features_json: string;
      revision_created_at: number;
      created_at: number; updated_at: number; archived_at: number | null;
    }, [string]>(`
      SELECT t.id,t.project_id,t.display_number,t.kind,t.state,t.priority,t.version,
        r.id AS revision_id,r.number AS revision_number,r.specification,r.constraints_json,
        r.features_json,
        r.created_at AS revision_created_at,t.created_at,t.updated_at,t.archived_at
      FROM tasks t JOIN task_revisions r ON r.task_id=t.id AND r.id=t.current_revision_id
      WHERE t.project_id=?1 ${archivedClause} ORDER BY t.display_number
    `).all(projectId).map((row) => this.mapTaskSummary(row));
  }

  /** One Task by ID regardless of archive state; `task status` must still read an archived Task. */
  getTask(projectId: string, taskId: string): TaskSummary | null {
    const project = this.sqlite.query<{ id: string }, [string]>(`
      SELECT p.id FROM projects p JOIN project_trusts t
        ON t.project_id=p.id AND t.status='ACTIVE' WHERE p.id=?1
    `).get(projectId);
    if (project === null) throw new StorageError('NOT_FOUND', 'Trusted project was not found');
    const row = this.sqlite.query<{
      id: string; project_id: string; display_number: number; kind: 'DEVELOPMENT' | 'SELF';
      state: TaskLifecycleState; priority: number; version: number; revision_id: string; revision_number: number;
      specification: string; constraints_json: string; features_json: string;
      revision_created_at: number;
      created_at: number; updated_at: number; archived_at: number | null;
    }, [string, string]>(`
      SELECT t.id,t.project_id,t.display_number,t.kind,t.state,t.priority,t.version,
        r.id AS revision_id,r.number AS revision_number,r.specification,r.constraints_json,
        r.features_json,
        r.created_at AS revision_created_at,t.created_at,t.updated_at,t.archived_at
      FROM tasks t JOIN task_revisions r ON r.task_id=t.id AND r.id=t.current_revision_id
      WHERE t.project_id=?1 AND t.id=?2
    `).get(projectId, taskId);
    return row === null ? null : this.mapTaskSummary(row);
  }

  private mapTaskSummary(row: {
    id: string; project_id: string; display_number: number; kind: 'DEVELOPMENT' | 'SELF';
    state: TaskLifecycleState; priority: number; version: number; revision_id: string; revision_number: number;
    specification: string; constraints_json: string; features_json: string;
    revision_created_at: number;
    created_at: number; updated_at: number; archived_at: number | null;
  }): TaskSummary {
    return {
      id: row.id,
      projectId: row.project_id,
      displayNumber: row.display_number,
      kind: row.kind,
      state: row.state,
      priority: row.priority,
      version: row.version,
      currentRevision: {
        id: row.revision_id,
        number: row.revision_number,
        specification: row.specification,
        constraints: JSON.parse(row.constraints_json) as readonly StoredConstraint[],
        features: parseTaskFeatures(row.features_json),
        createdAt: row.revision_created_at,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    };
  }

  /** Execution attempts for one Task, newest first, with the current Agent Session if one exists. */
  listTaskExecutions(projectId: string, taskId: string): readonly ExecutionSummary[] {
    const project = this.sqlite.query<{ id: string }, [string]>(`
      SELECT p.id FROM projects p JOIN project_trusts t
        ON t.project_id=p.id AND t.status='ACTIVE' WHERE p.id=?1
    `).get(projectId);
    if (project === null) throw new StorageError('NOT_FOUND', 'Trusted project was not found');
    const task = this.sqlite.query<{ id: string }, [string, string]>(
      'SELECT id FROM tasks WHERE project_id=?1 AND id=?2',
    ).get(projectId, taskId);
    if (task === null) throw new StorageError('NOT_FOUND', 'Task was not found');
    return this.sqlite.query<{
      execution_id: string; task_id: string; attempt_number: number;
      state: ExecutionLifecycleState; adapter_id: string; adapter_version: string;
      resource_held: number; base_commit: string; revision_id: string;
      result_commit: string | null; error_json: string | null;
      agent_config_json: string | null; stop_reason: ExecutionSummary['stopReason'];
      resume_from_execution_id: string | null; retry_from_execution_id: string | null;
      session_id: string | null; session_state: AgentSessionLifecycleState | null;
      provider_session_id: string | null; observation_cursor: string | null;
      session_exit_json: string | null;
    }, [string]>(`
      SELECT execution.id AS execution_id,execution.task_id,execution.attempt_number,execution.state,
        execution.adapter_id,execution.adapter_version,execution.resource_held,execution.base_commit,
        execution.applied_revision_id AS revision_id,execution.result_commit,execution.error_json,
        execution.agent_config_json,
        execution.stop_reason,execution.resume_from_execution_id,execution.retry_from_execution_id,
        session.id AS session_id,session.state AS session_state,
        session.provider_session_id,session.observation_cursor,session.exit_json AS session_exit_json
      FROM executions execution LEFT JOIN agent_sessions session ON session.execution_id=execution.id
      WHERE execution.task_id=?1 ORDER BY execution.attempt_number DESC
    `).all(taskId).map((row) => ({
      executionId: row.execution_id,
      taskId: row.task_id,
      attemptNumber: row.attempt_number,
      state: row.state,
      adapterId: row.adapter_id,
      adapterVersion: row.adapter_version,
      resourceHeld: row.resource_held === 1,
      baseCommit: row.base_commit,
      revisionId: row.revision_id,
      resultCommit: row.result_commit,
      error: parseExecutionError(row.error_json),
      stopReason: row.stop_reason,
      resumeFromExecutionId: row.resume_from_execution_id,
      retryFromExecutionId: row.retry_from_execution_id,
      agentConfig: parseAgentConfiguration(row.agent_config_json),
      session: row.session_id === null || row.session_state === null ? null : {
        sessionId: row.session_id,
        state: row.session_state,
        providerSessionId: row.provider_session_id,
        cursor: row.observation_cursor,
        completion: parseSessionCompletion(row.session_exit_json),
      },
    }));
  }

  findWorkspacePreparation(
    projectId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): WorkspacePreparationPlan | null {
    const existing = this.sqlite.query<{
      id: string; state: WorkspacePreparationPlan['operationState']; request_json: string;
    }, [string, string]>(`
      SELECT id,state,request_json FROM operations
      WHERE project_id=?1 AND kind='PREPARE_WORKSPACE' AND idempotency_key=?2
    `).get(projectId, idempotencyKey);
    if (existing === null) return null;
    const request = JSON.parse(existing.request_json) as { payloadHash: string; workspaceId: string };
    if (request.payloadHash !== payloadHash) {
      throw new StorageError('COMMAND_CONFLICT', 'Workspace command ID was reused with a different payload');
    }
    const workspace = this.workspacePreparationRow(request.workspaceId);
    if (workspace === null) throw new StorageError('INVALID_STATE', 'Workspace operation lost its reservation');
    return { ...workspace, operationId: existing.id, operationState: existing.state };
  }

  listIncompleteWorkspacePreparations(): readonly WorkspacePreparationPlan[] {
    return this.sqlite.query<{ workspace_id: string }, []>(`
      SELECT json_extract(request_json,'$.workspaceId') AS workspace_id
      FROM operations
      WHERE kind='PREPARE_WORKSPACE' AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED')
      ORDER BY created_at,id
    `).all().map((row) => {
      const plan = this.workspacePreparationRow(row.workspace_id);
      if (plan === null) throw new StorageError('INVALID_STATE', 'Workspace operation lost its reservation');
      return plan;
    });
  }

  reserveWorkspacePreparation(input: {
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedTaskVersion: number;
    readonly workspaceId: string;
    readonly ownershipToken: string;
    readonly branchRef: string;
    readonly path: string;
    readonly baseCommit: string;
    /**
     * The ref this Task's worktree is based on (ADR-0060). It is decided per Task by the caller —
     * the dev clone's `dev` ref when one is recorded, otherwise the project folder's currently
     * checked out branch — and recorded with the workspace so later readers report the ref that was
     * actually used instead of re-deriving it from the project row.
     */
    readonly baseRef: string;
    readonly createdAt: number;
  }): WorkspacePreparationPlan {
    return this.sqlite.transaction(() => {
      const existing = this.findWorkspacePreparation(
        input.projectId,
        input.idempotencyKey,
        input.payloadHash,
      );
      if (existing !== null) return existing;

      const subject = this.sqlite.query<{
        state: TaskLifecycleState; version: number; repo_root: string; git_common_dir: string;
        main_ref: string; dev_ref: string; object_format: 'sha1' | 'sha256';
      }, [string, string]>(`
        SELECT task.state,task.version,COALESCE(p.dev_repo_path,p.repo_root) AS repo_root,
               p.git_common_dir,p.main_ref,p.dev_ref,p.object_format
        FROM tasks task JOIN projects p ON p.id=task.project_id
        JOIN project_trusts trust ON trust.project_id=p.id AND trust.status='ACTIVE'
        WHERE task.project_id=?1 AND task.id=?2
      `).get(input.projectId, input.taskId);
      if (subject === null) throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
      if (subject.version !== input.expectedTaskVersion) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
      }
      if (subject.state !== 'READY') {
        throw new StorageError('INVALID_STATE', `Workspace cannot be reserved while Task is ${subject.state}`);
      }
      if (input.baseRef.trim().length === 0) {
        throw new StorageError('INVALID_STATE', 'Workspace preparation needs the base ref it was planned from');
      }
      const requestJson = JSON.stringify({
        payloadHash: input.payloadHash,
        taskId: input.taskId,
        expectedTaskVersion: input.expectedTaskVersion,
        workspaceId: input.workspaceId,
        ownershipToken: input.ownershipToken,
        branchRef: input.branchRef,
        path: input.path,
        baseCommit: input.baseCommit,
        baseRef: input.baseRef,
      });
      this.sqlite.query(`
        INSERT INTO workspaces(id,task_id,branch_ref,path,ownership_token,base_commit,base_ref,state,created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,'RESERVED',?8)
      `).run(input.workspaceId, input.taskId, input.branchRef, input.path,
        input.ownershipToken, input.baseCommit, input.baseRef, input.createdAt);
      this.sqlite.query(`
        INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,
          request_json,created_at,updated_at)
        VALUES (?1,?2,'PREPARE_WORKSPACE',?3,?4,'PLANNED',?5,?6,?6)
      `).run(input.operationId, input.projectId, input.taskId, input.idempotencyKey,
        requestJson, input.createdAt);
      return {
        operationId: input.operationId,
        operationState: 'PLANNED' as const,
        projectId: input.projectId,
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        workspaceState: 'RESERVED' as const,
        repoRoot: subject.repo_root,
        gitCommonDir: subject.git_common_dir,
        mainRef: subject.main_ref,
        devRef: input.baseRef,
        objectFormat: subject.object_format,
        baseCommit: input.baseCommit,
        ownershipToken: input.ownershipToken,
        branchRef: input.branchRef,
        path: input.path,
      };
    })();
  }

  startWorkspacePreparation(operationId: string, workspaceId: string, updatedAt: number): void {
    this.sqlite.transaction(() => {
      const operation = this.sqlite.query(`
        UPDATE operations SET state='IN_PROGRESS',updated_at=?1
        WHERE id=?2 AND state='PLANNED'
      `).run(updatedAt, operationId);
      const workspace = this.sqlite.query(`
        UPDATE workspaces SET state='PREPARING' WHERE id=?1 AND state='RESERVED'
      `).run(workspaceId);
      if (operation.changes !== 1 || workspace.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Workspace preparation could not start from its recorded state');
      }
    })();
  }

  completeWorkspacePreparation(input: {
    readonly operationId: string;
    readonly workspaceId: string;
    readonly eventId: string;
    readonly preparedPath: string;
    readonly preparedBranch: string;
    readonly completedAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const plan = this.workspacePreparationRow(input.workspaceId);
      if (plan === null) throw new StorageError('INVALID_STATE', 'Workspace reservation was not found');
      const completable = plan.operationId === input.operationId
        && ((plan.operationState === 'IN_PROGRESS' && plan.workspaceState === 'PREPARING')
          || (plan.operationState === 'RECONCILE_REQUIRED' && plan.workspaceState === 'RECOVERY_REQUIRED'));
      if (!completable || plan.path !== input.preparedPath || plan.branchRef !== input.preparedBranch) {
        throw new StorageError('INVALID_STATE', 'Prepared workspace did not match its reservation');
      }
      this.sqlite.query("UPDATE workspaces SET state='READY' WHERE id=?1").run(input.workspaceId);
      this.sqlite.query(`
        UPDATE operations SET state='SUCCEEDED',result_json=?1,updated_at=?2 WHERE id=?3
      `).run(JSON.stringify({ workspaceId: input.workspaceId, path: input.preparedPath,
        branchRef: input.preparedBranch }), input.completedAt, input.operationId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'WorkspacePrepared',1,'Workspace',?3,0,?4,?4,?5,?6)
      `).run(input.eventId, plan.projectId, input.workspaceId, input.operationId,
        input.completedAt, JSON.stringify({ workspaceId: input.workspaceId,
          taskId: plan.taskId, branch: input.preparedBranch, baseCommit: plan.baseCommit }));
    })();
  }

  recordMissingWorkspacePreparation(input: {
    readonly operationId: string;
    readonly workspaceId: string;
    readonly evidenceRef: string;
    readonly reconciledAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const operation = this.sqlite.query(`
        UPDATE operations SET state='FAILED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state IN ('IN_PROGRESS','RECONCILE_REQUIRED')
      `).run(JSON.stringify({ error: { code: 'MISSING', message: input.evidenceRef } }),
        input.reconciledAt, input.operationId);
      const workspace = this.sqlite.query(`
        UPDATE workspaces SET state='RELEASED'
        WHERE id=?1 AND state IN ('PREPARING','RECOVERY_REQUIRED')
      `).run(input.workspaceId);
      if (operation.changes !== 1 || workspace.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Missing workspace reconciliation did not match recorded state');
      }
    })();
  }

  markWorkspacePreparationUncertain(input: {
    readonly operationId: string;
    readonly workspaceId: string;
    readonly evidenceRef: string;
    readonly reconciledAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const operation = this.sqlite.query(`
        UPDATE operations SET state='RECONCILE_REQUIRED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state IN ('IN_PROGRESS','RECONCILE_REQUIRED')
      `).run(JSON.stringify({ error: { code: 'UNCERTAIN', message: input.evidenceRef } }),
        input.reconciledAt, input.operationId);
      const workspace = this.sqlite.query(`
        UPDATE workspaces SET state='RECOVERY_REQUIRED'
        WHERE id=?1 AND state IN ('PREPARING','RECOVERY_REQUIRED')
      `).run(input.workspaceId);
      if (operation.changes !== 1 || workspace.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Uncertain workspace reconciliation did not match recorded state');
      }
    })();
  }

  failWorkspacePreparation(input: {
    readonly operationId: string;
    readonly workspaceId: string;
    readonly reconcileRequired: boolean;
    readonly error: Readonly<{ code: string; message: string }>;
    readonly failedAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const operationState = input.reconcileRequired ? 'RECONCILE_REQUIRED' : 'FAILED';
      const workspaceState = input.reconcileRequired ? 'RECOVERY_REQUIRED' : 'RELEASED';
      const operation = this.sqlite.query(`
        UPDATE operations SET state=?1,result_json=?2,updated_at=?3
        WHERE id=?4 AND state='IN_PROGRESS'
      `).run(operationState, JSON.stringify({ error: input.error }), input.failedAt, input.operationId);
      const workspace = this.sqlite.query(`
        UPDATE workspaces SET state=?1 WHERE id=?2 AND state='PREPARING'
      `).run(workspaceState, input.workspaceId);
      if (operation.changes !== 1 || workspace.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Workspace preparation failure could not be recorded');
      }
    })();
  }

  private workspacePreparationRow(workspaceId: string): WorkspacePreparationPlan | null {
    const row = this.sqlite.query<{
      operation_id: string; operation_state: WorkspacePreparationPlan['operationState']; project_id: string;
      task_id: string; workspace_id: string; workspace_state: WorkspacePreparationPlan['workspaceState'];
      repo_root: string; git_common_dir: string; main_ref: string; dev_ref: string;
      object_format: 'sha1' | 'sha256';
      base_commit: string; ownership_token: string; branch_ref: string; path: string;
    }, [string]>(`
      SELECT operation.id AS operation_id,operation.state AS operation_state,
        operation.project_id,workspace.task_id,workspace.id AS workspace_id,
        workspace.state AS workspace_state,COALESCE(p.dev_repo_path,p.repo_root) AS repo_root,
        p.git_common_dir,p.main_ref,COALESCE(workspace.base_ref,p.dev_ref) AS dev_ref,
        p.object_format,workspace.base_commit,workspace.ownership_token,workspace.branch_ref,workspace.path
      FROM workspaces workspace JOIN tasks task ON task.id=workspace.task_id
      JOIN projects p ON p.id=task.project_id
      JOIN operations operation ON operation.aggregate_id=task.id AND operation.kind='PREPARE_WORKSPACE'
        AND json_extract(operation.request_json,'$.workspaceId')=workspace.id
      WHERE workspace.id=?1
    `).get(workspaceId);
    if (row === null) return null;
    return {
      operationId: row.operation_id,
      operationState: row.operation_state,
      projectId: row.project_id,
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      workspaceState: row.workspace_state,
      repoRoot: row.repo_root,
      gitCommonDir: row.git_common_dir,
      mainRef: row.main_ref,
      devRef: row.dev_ref,
      objectFormat: row.object_format,
      baseCommit: row.base_commit,
      ownershipToken: row.ownership_token,
      branchRef: row.branch_ref,
      path: row.path,
    };
  }

  markExecutionPreparing(input: {
    readonly projectId: string;
    readonly executionId: string;
    readonly expectedExecutionVersion: number;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly eventId: string;
    readonly changedAt: number;
  }): Readonly<{ executionId: string; state: 'PREPARING'; version: number }> {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.changedAt,
      apply: (database) => {
        const execution = database.query<{ state: string; version: number }, [string, string]>(`
          SELECT execution.state,execution.version FROM executions execution
          JOIN tasks task ON task.id=execution.task_id
          WHERE task.project_id=?1 AND execution.id=?2
        `).get(input.projectId, input.executionId);
        if (execution === null) throw new StorageError('NOT_FOUND', 'Execution was not found');
        if (execution.version !== input.expectedExecutionVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Execution version did not match');
        }
        if (execution.state !== 'CREATED') {
          throw new StorageError('INVALID_STATE', `Execution cannot prepare from ${execution.state}`);
        }
        const version = input.expectedExecutionVersion + 1;
        database.query("UPDATE executions SET state='PREPARING',version=?1 WHERE id=?2")
          .run(version, input.executionId);
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?5,?6,?7)
        `).run(input.eventId, input.projectId, input.executionId, version, input.commandId,
          input.changedAt, JSON.stringify({ executionId: input.executionId,
            from: 'CREATED', to: 'PREPARING', reason: 'workspace ready' }));
        return { executionId: input.executionId, state: 'PREPARING' as const, version };
      },
    });
  }

  findAgentStart(projectId: string, idempotencyKey: string, payloadHash: string): AgentStartPlan | null {
    const operation = this.sqlite.query<{
      id: string; state: AgentStartPlan['operationState']; request_json: string;
    }, [string, string]>(`
      SELECT id,state,request_json FROM operations
      WHERE project_id=?1 AND kind='START_AGENT' AND idempotency_key=?2
    `).get(projectId, idempotencyKey);
    if (operation === null) return null;
    const request = JSON.parse(operation.request_json) as { payloadHash: string; sessionId: string };
    if (request.payloadHash !== payloadHash) {
      throw new StorageError('COMMAND_CONFLICT', 'Agent start command ID was reused with a different payload');
    }
    const plan = this.agentStartRow(request.sessionId);
    if (plan === null) throw new StorageError('INVALID_STATE', 'Agent start operation lost its Session');
    return { ...plan, operationId: operation.id, operationState: operation.state };
  }

  listIncompleteAgentStarts(): readonly AgentStartPlan[] {
    return this.sqlite.query<{ session_id: string }, []>(`
      SELECT json_extract(request_json,'$.sessionId') AS session_id
      FROM operations
      WHERE kind='START_AGENT' AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED')
      ORDER BY created_at,id
    `).all().map((row) => {
      const plan = this.agentStartRow(row.session_id);
      if (plan === null) throw new StorageError('INVALID_STATE', 'Agent start Operation lost its Session');
      return plan;
    });
  }

  planAgentStart(input: {
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly projectId: string;
    readonly executionId: string;
    readonly expectedExecutionVersion: number;
    readonly sessionId: string;
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly capabilities: unknown;
    readonly eventId: string;
    readonly plannedAt: number;
  }): AgentStartPlan {
    return this.sqlite.transaction(() => {
      const existing = this.findAgentStart(input.projectId, input.idempotencyKey, input.payloadHash);
      if (existing !== null) return existing;
      const subject = this.sqlite.query<{
        task_id: string; execution_state: string; execution_version: number; adapter_id: string;
        adapter_version: string; workspace_id: string; workspace_path: string; ownership_token: string;
        revision_id: string; specification: string; constraints_json: string;
      }, [string, string]>(`
        SELECT task.id AS task_id,execution.state AS execution_state,
          execution.version AS execution_version,execution.adapter_id,execution.adapter_version,
          workspace.id AS workspace_id,workspace.path AS workspace_path,workspace.ownership_token,
          revision.id AS revision_id,revision.specification,revision.constraints_json
        FROM executions execution JOIN tasks task ON task.id=execution.task_id
        JOIN workspaces workspace ON workspace.id=execution.workspace_id AND workspace.task_id=task.id
        JOIN task_revisions revision ON revision.id=execution.applied_revision_id AND revision.task_id=task.id
        WHERE task.project_id=?1 AND execution.id=?2 AND task.state='RUNNING'
          AND workspace.state='IN_USE'
      `).get(input.projectId, input.executionId);
      if (subject === null) throw new StorageError('NOT_FOUND', 'Runnable Execution was not found');
      if (subject.execution_version !== input.expectedExecutionVersion) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Execution version did not match');
      }
      if (subject.execution_state !== 'PREPARING') {
        throw new StorageError('INVALID_STATE', `Agent cannot start from ${subject.execution_state}`);
      }
      if (subject.adapter_id !== input.adapterId || subject.adapter_version !== input.adapterVersion) {
        throw new StorageError(
          'INVALID_STATE',
          `Execution reserved ${subject.adapter_id}@${subject.adapter_version}, got ${input.adapterId}@${input.adapterVersion}`,
        );
      }
      const requestJson = JSON.stringify({
        payloadHash: input.payloadHash,
        executionId: input.executionId,
        expectedExecutionVersion: input.expectedExecutionVersion,
        sessionId: input.sessionId,
      });
      this.sqlite.query(`
        INSERT INTO agent_sessions(id,execution_id,capabilities_json,state,version,last_observed_at)
        VALUES (?1,?2,?3,'STARTING',0,?4)
      `).run(input.sessionId, input.executionId, JSON.stringify(input.capabilities), input.plannedAt);
      this.sqlite.query(`
        INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,
          request_json,created_at,updated_at)
        VALUES (?1,?2,'START_AGENT',?3,?4,'PLANNED',?5,?6,?6)
      `).run(input.operationId, input.projectId, input.executionId, input.idempotencyKey,
        requestJson, input.plannedAt);
      const executionVersion = input.expectedExecutionVersion + 1;
      this.sqlite.query("UPDATE executions SET state='STARTING',version=?1 WHERE id=?2")
        .run(executionVersion, input.executionId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?5,?6,?7)
      `).run(input.eventId, input.projectId, input.executionId, executionVersion,
        input.idempotencyKey, input.plannedAt, JSON.stringify({ executionId: input.executionId,
          from: 'PREPARING', to: 'STARTING', reason: 'agent start planned' }));
      const plan = this.agentStartRow(input.sessionId);
      if (plan === null) throw new Error('Agent start plan was not persisted');
      return plan;
    })();
  }

  startAgentOperation(operationId: string, startedAt: number): void {
    const result = this.sqlite.query(`
      UPDATE operations SET state='IN_PROGRESS',updated_at=?1 WHERE id=?2 AND state='PLANNED'
    `).run(startedAt, operationId);
    if (result.changes !== 1) throw new StorageError('INVALID_STATE', 'Agent start Operation was not PLANNED');
  }

  completeAgentStart(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly providerSessionId: string;
    readonly adapterId: string;
    readonly sessionEventId: string;
    readonly executionEventId: string;
    readonly processIdentity?: unknown;
    readonly sessionStorageRef?: string;
    readonly completedAt: number;
  }): AgentStartPlan {
    return this.sqlite.transaction(() => {
      const plan = this.agentStartRow(input.sessionId);
      if (plan === null || plan.operationId !== input.operationId
        || plan.operationState !== 'IN_PROGRESS' || plan.sessionState !== 'STARTING'
        || plan.adapterId !== input.adapterId) {
        throw new StorageError('INVALID_STATE', 'Started Agent Session did not match its plan');
      }
      this.sqlite.query(`
        UPDATE agent_sessions SET state='ACTIVE',provider_session_id=?1,version=version+1,
          last_observed_at=?2,process_identity_json=?3,session_storage_ref=?4 WHERE id=?5
      `).run(input.providerSessionId, input.completedAt,
        input.processIdentity === undefined ? null : JSON.stringify(input.processIdentity),
        input.sessionStorageRef ?? null, input.sessionId);
      this.sqlite.query(`
        UPDATE executions SET state='RUNNING',version=version+1,started_at=?1
        WHERE id=?2 AND state='STARTING'
      `).run(input.completedAt, plan.executionId);
      this.sqlite.query(`
        UPDATE operations SET state='SUCCEEDED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state='IN_PROGRESS'
      `).run(JSON.stringify({ sessionId: input.sessionId, providerSessionId: input.providerSessionId }),
        input.completedAt, input.operationId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?5,?6,?7)
      `).run(input.executionEventId, plan.projectId, plan.executionId, plan.executionVersion + 1,
        input.operationId, input.completedAt, JSON.stringify({ executionId: plan.executionId,
          from: 'STARTING', to: 'RUNNING', reason: 'agent session started' }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'AgentSessionStarted',1,'AgentSession',?3,1,?4,?5,?6,?7)
      `).run(input.sessionEventId, plan.projectId, input.sessionId, input.operationId,
        input.executionEventId, input.completedAt, JSON.stringify({ executionId: plan.executionId,
          sessionId: input.sessionId, adapterId: input.adapterId,
          providerSessionId: input.providerSessionId }));
      const completed = this.agentStartRow(input.sessionId);
      if (completed === null) throw new Error('Completed Agent Session was not found');
      return completed;
    })();
  }

  failAgentStartBeforeSideEffect(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly error: Readonly<{ code: string; message: string }>;
    readonly failedAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const plan = this.agentStartRow(input.sessionId);
      if (plan === null || plan.operationId !== input.operationId
        || plan.operationState !== 'IN_PROGRESS' || plan.sessionState !== 'STARTING') {
        throw new StorageError('INVALID_STATE', 'Failed Agent start did not match its plan');
      }
      this.sqlite.query(`
        UPDATE agent_sessions SET state='EXITED',version=version+1,last_observed_at=?1,exit_json=?2
        WHERE id=?3
      `).run(input.failedAt, JSON.stringify(input.error), input.sessionId);
      this.sqlite.query(`
        UPDATE executions SET state='FAILED',resource_held=0,version=version+1,ended_at=?1,error_json=?2
        WHERE id=?3 AND state='STARTING'
      `).run(input.failedAt, JSON.stringify(input.error), plan.executionId);
      this.sqlite.query("UPDATE workspaces SET state='RETAINED' WHERE id=?1 AND state='IN_USE'")
        .run(plan.workspaceId);
      this.sqlite.query(`
        UPDATE tasks SET state='FAILED',version=version+1,updated_at=?1
        WHERE id=?2 AND state='RUNNING'
      `).run(input.failedAt, plan.taskId);
      this.sqlite.query(`
        UPDATE operations SET state='FAILED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state='IN_PROGRESS'
      `).run(JSON.stringify({ error: input.error }), input.failedAt, input.operationId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionFailed',1,'Execution',?3,?4,?5,?5,?6,?7)
      `).run(input.executionEventId, plan.projectId, plan.executionId, plan.executionVersion + 1,
        input.operationId, input.failedAt, JSON.stringify({ executionId: plan.executionId,
          reason: input.error.code, stopEvidenceRef: 'no-session-created' }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
      `).run(input.taskEventId, plan.projectId, plan.taskId, plan.taskVersion + 1,
        input.operationId, input.executionEventId, input.failedAt,
        JSON.stringify({ taskId: plan.taskId, from: 'RUNNING', to: 'FAILED',
          reason: 'agent start failed before side effect' }));
    })();
  }

  markAgentStartUncertain(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly recoveryEventId: string;
    readonly taskEventId: string;
    readonly error: Readonly<{ code: string; message: string }>;
    readonly failedAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const plan = this.agentStartRow(input.sessionId);
      if (plan === null || plan.operationId !== input.operationId
        || plan.operationState !== 'IN_PROGRESS' || plan.sessionState !== 'STARTING') {
        throw new StorageError('INVALID_STATE', 'Uncertain Agent start did not match its plan');
      }
      this.sqlite.query("UPDATE agent_sessions SET state='RECOVERY_REQUIRED',version=version+1,last_observed_at=?1 WHERE id=?2")
        .run(input.failedAt, input.sessionId);
      this.sqlite.query("UPDATE executions SET state='RECOVERY_REQUIRED',version=version+1 WHERE id=?1")
        .run(plan.executionId);
      this.sqlite.query("UPDATE workspaces SET state='RECOVERY_REQUIRED' WHERE id=?1")
        .run(plan.workspaceId);
      this.sqlite.query("UPDATE tasks SET state='RECOVERY_REQUIRED',version=version+1,updated_at=?1 WHERE id=?2")
        .run(input.failedAt, plan.taskId);
      this.sqlite.query(`
        UPDATE operations SET state='RECONCILE_REQUIRED',result_json=?1,updated_at=?2 WHERE id=?3
      `).run(JSON.stringify({ error: input.error }), input.failedAt, input.operationId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'RecoveryRequired',1,'Execution',?3,?4,?5,?5,?6,?7)
      `).run(input.recoveryEventId, plan.projectId, plan.executionId, plan.executionVersion + 1,
        input.operationId, input.failedAt, JSON.stringify({ resourceType: 'AgentSession',
          resourceId: input.sessionId, reason: input.error.code }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
      `).run(input.taskEventId, plan.projectId, plan.taskId, plan.taskVersion + 1,
        input.operationId, input.recoveryEventId, input.failedAt,
        JSON.stringify({ taskId: plan.taskId, from: 'RUNNING', to: 'RECOVERY_REQUIRED',
          reason: 'agent start uncertain' }));
    })();
  }

  private agentStartRow(sessionId: string): AgentStartPlan | null {
    const row = this.sqlite.query<{
      operation_id: string; operation_state: AgentStartPlan['operationState']; project_id: string;
      task_id: string; task_version: number; execution_id: string; execution_version: number; session_id: string;
      session_state: AgentStartPlan['sessionState']; adapter_id: string; adapter_version: string;
      workspace_id: string; workspace_path: string; ownership_token: string; revision_id: string;
      specification: string; constraints_json: string; provider_session_id: string | null;
      agent_config_json: string | null;
    }, [string]>(`
      SELECT operation.id AS operation_id,operation.state AS operation_state,operation.project_id,
        task.id AS task_id,task.version AS task_version,execution.id AS execution_id,
        execution.version AS execution_version,
        session.id AS session_id,session.state AS session_state,execution.adapter_id,execution.adapter_version,
        workspace.id AS workspace_id,workspace.path AS workspace_path,workspace.ownership_token,
        revision.id AS revision_id,revision.specification,revision.constraints_json,session.provider_session_id,
        execution.agent_config_json
      FROM agent_sessions session JOIN executions execution ON execution.id=session.execution_id
      JOIN tasks task ON task.id=execution.task_id JOIN workspaces workspace ON workspace.id=execution.workspace_id
      JOIN task_revisions revision ON revision.id=execution.applied_revision_id
      JOIN operations operation ON operation.aggregate_id=execution.id AND operation.kind='START_AGENT'
        AND json_extract(operation.request_json,'$.sessionId')=session.id
      WHERE session.id=?1
    `).get(sessionId);
    if (row === null) return null;
    return {
      operationId: row.operation_id,
      operationState: row.operation_state,
      projectId: row.project_id,
      taskId: row.task_id,
      taskVersion: row.task_version,
      executionId: row.execution_id,
      executionVersion: row.execution_version,
      sessionId: row.session_id,
      sessionState: row.session_state,
      adapterId: row.adapter_id,
      adapterVersion: row.adapter_version,
      workspaceId: row.workspace_id,
      workspacePath: row.workspace_path,
      ownershipToken: row.ownership_token,
      revisionId: row.revision_id,
      specification: row.specification,
      constraints: JSON.parse(row.constraints_json) as readonly StoredConstraint[],
      providerSessionId: row.provider_session_id,
      agentConfig: parseAgentConfiguration(row.agent_config_json),
    };
  }

  getObservableAgentSession(sessionId: string): ObservableAgentSession {
    const row = this.observableAgentSessionRow(sessionId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Observable Agent Session was not found');
    if (row.providerSessionId === null) {
      throw new StorageError('INVALID_STATE', 'Agent Session has no provider identity');
    }
    if (!['ACTIVE', 'WAITING_FOR_USER'].includes(row.sessionState)
      || !['RUNNING', 'WAITING_FOR_USER'].includes(row.executionState)) {
      throw new StorageError('INVALID_STATE', `Agent Session cannot be observed from ${row.sessionState}`);
    }
    return { ...row, providerSessionId: row.providerSessionId } as ObservableAgentSession;
  }

  /**
   * The Session recorded for one Execution in any lifecycle state. Stopping needs the Session
   * identity even after it exited, when `getObservableAgentSession` would refuse to answer.
   */
  findAgentSessionByExecution(executionId: string): {
    readonly sessionId: string;
    readonly adapterId: string;
    readonly state: AgentSessionLifecycleState;
    readonly sessionStorageRef: string | null;
    readonly providerSessionId: string | null;
  } | null {
    const row = this.sqlite.query<{
      id: string; adapter_id: string; state: AgentSessionLifecycleState;
      session_storage_ref: string | null; provider_session_id: string | null;
    }, [string]>(`
      SELECT session.id,session.state,session.session_storage_ref,session.provider_session_id,
        execution.adapter_id
      FROM agent_sessions session JOIN executions execution ON execution.id=session.execution_id
      WHERE session.execution_id=?1
    `).get(executionId);
    return row === null ? null : {
      sessionId: row.id,
      adapterId: row.adapter_id,
      state: row.state,
      sessionStorageRef: row.session_storage_ref,
      providerSessionId: row.provider_session_id,
    };
  }

  /**
   * Resolves one recorded Agent Session for a read-only transcript view. Unlike
   * `getObservableAgentSession` this works for finished Sessions too: a transcript is history, so
   * it is readable long after the execution stopped being observable in the live sense.
   */
  getSessionTranscriptTarget(sessionId: string): SessionTranscriptTarget {
    const row = this.sqlite.query<{
      project_id: string; task_id: string; display_number: number; execution_id: string;
      attempt_number: number; execution_state: ExecutionLifecycleState; session_id: string;
      session_state: AgentSessionLifecycleState; provider_session_id: string | null;
      session_storage_ref: string | null;
    }, [string]>(`
      SELECT task.project_id,task.id AS task_id,task.display_number,execution.id AS execution_id,
        execution.attempt_number,execution.state AS execution_state,session.id AS session_id,
        session.state AS session_state,session.provider_session_id,session.session_storage_ref
      FROM agent_sessions session
      JOIN executions execution ON execution.id=session.execution_id
      JOIN tasks task ON task.id=execution.task_id
      WHERE session.id=?1
    `).get(sessionId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Agent Session was not found');
    return {
      projectId: row.project_id,
      taskId: row.task_id,
      taskDisplayNumber: row.display_number,
      executionId: row.execution_id,
      attemptNumber: row.attempt_number,
      executionState: row.execution_state,
      sessionId: row.session_id,
      sessionState: row.session_state,
      providerSessionId: row.provider_session_id,
      sessionStorageRef: row.session_storage_ref,
    };
  }

  recordAgentAttention(input: {
    readonly sessionId: string;
    readonly executionId: string;
    readonly providerEventId: string;
    readonly cursor: string;
    readonly providerRequestId: string;
    readonly kind: 'QUESTION' | 'PERMISSION';
    readonly responseType: 'CONFIRM' | 'VALUE';
    readonly prompt: unknown;
    readonly attentionId: string;
    readonly attentionEventId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly observedAt: number;
  }): AdapterEventResult {
    return this.sqlite.transaction(() => {
      const payload = { providerRequestId: input.providerRequestId, kind: input.kind,
        responseType: input.responseType, prompt: input.prompt };
      const payloadJson = JSON.stringify(payload);
      const duplicate = this.adapterEventDuplicate(input.sessionId, input.providerEventId,
        input.cursor, 'attention', payloadJson);
      if (duplicate) return this.adapterEventResult(input.sessionId, input.providerEventId);
      const subject = this.observableAgentSessionRow(input.sessionId);
      if (subject === null || subject.executionId !== input.executionId) {
        throw new StorageError('NOT_FOUND', 'Adapter event Session identity did not match');
      }
      if (subject.sessionState !== 'ACTIVE' || subject.executionState !== 'RUNNING') {
        throw new StorageError('INVALID_STATE',
          `Attention requires ACTIVE/RUNNING, got ${subject.sessionState}/${subject.executionState}`);
      }
      const promptJson = JSON.stringify(input.prompt);
      if (promptJson === undefined) throw new StorageError('INVALID_STATE', 'Attention prompt is not JSON serializable');
      this.insertAdapterEvent(input.sessionId, input.providerEventId, input.cursor,
        'attention', payloadJson, input.observedAt);
      this.sqlite.query(`
        INSERT INTO attention_requests(id,session_id,provider_request_id,kind,prompt_json,status,created_at,response_type)
        VALUES (?1,?2,?3,?4,?5,'OPEN',?6,?7)
      `).run(input.attentionId, input.sessionId, input.providerRequestId, input.kind,
        promptJson, input.observedAt, input.responseType);
      const sessionUpdate = this.sqlite.query(`
        UPDATE agent_sessions SET state='WAITING_FOR_USER',version=version+1,
          observation_cursor=?1,last_observed_at=?2 WHERE id=?3 AND state='ACTIVE'
      `).run(input.cursor, input.observedAt, input.sessionId);
      const executionUpdate = this.sqlite.query(`
        UPDATE executions SET state='WAITING_FOR_USER',version=version+1
        WHERE id=?1 AND state='RUNNING'
      `).run(input.executionId);
      const taskUpdate = this.sqlite.query(`
        UPDATE tasks SET state='WAITING_FOR_USER',version=version+1,updated_at=?1
        WHERE id=?2 AND state='RUNNING'
      `).run(input.observedAt, subject.taskId);
      if (sessionUpdate.changes !== 1 || executionUpdate.changes !== 1 || taskUpdate.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Attention subject changed during projection');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'UserAttentionRequested',1,'Attention',?3,0,?4,?5,?6,?7)
      `).run(input.attentionEventId, subject.projectId, input.attentionId, input.executionId,
        input.providerEventId, input.observedAt, JSON.stringify({ attentionId: input.attentionId,
          sessionId: input.sessionId, kind: input.kind, responseType: input.responseType,
          providerRequestId: input.providerRequestId }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?6,?7,?8)
      `).run(input.executionEventId, subject.projectId, input.executionId,
        subject.executionVersion + 1, input.executionId, input.attentionEventId, input.observedAt,
        JSON.stringify({ executionId: input.executionId, from: 'RUNNING',
          to: 'WAITING_FOR_USER', reason: 'agent requested attention' }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
      `).run(input.taskEventId, subject.projectId, subject.taskId, subject.taskVersion + 1,
        input.executionId, input.executionEventId, input.observedAt,
        JSON.stringify({ taskId: subject.taskId, from: 'RUNNING',
          to: 'WAITING_FOR_USER', reason: 'agent requested attention' }));
      return { duplicate: false as const, eventId: input.providerEventId, cursor: input.cursor,
        sessionState: 'WAITING_FOR_USER' as const, executionState: 'WAITING_FOR_USER' as const,
        attentionId: input.attentionId };
    })();
  }

  listAttentionRequests(projectId: string): readonly AttentionSummary[] {
    const trusted = this.sqlite.query<{ id: string }, [string]>(`
      SELECT project.id FROM projects project JOIN project_trusts trust
        ON trust.project_id=project.id AND trust.status='ACTIVE' WHERE project.id=?1
    `).get(projectId);
    if (trusted === null) throw new StorageError('NOT_FOUND', 'Trusted project was not found');
    return this.sqlite.query<{
      id: string; project_id: string; task_id: string; execution_id: string; session_id: string;
      provider_request_id: string; kind: AttentionSummary['kind']; response_type: AttentionSummary['responseType'];
      prompt_json: string; status: AttentionSummary['status']; created_at: number;
    }, [string]>(`
      SELECT attention.id,task.project_id,task.id AS task_id,execution.id AS execution_id,
        session.id AS session_id,attention.provider_request_id,attention.kind,attention.response_type,
        attention.prompt_json,attention.status,attention.created_at
      FROM attention_requests attention JOIN agent_sessions session ON session.id=attention.session_id
      JOIN executions execution ON execution.id=session.execution_id
      JOIN tasks task ON task.id=execution.task_id
      WHERE task.project_id=?1 ORDER BY attention.created_at,attention.id
    `).all(projectId).map((row) => ({
      id: row.id, projectId: row.project_id, taskId: row.task_id, executionId: row.execution_id,
      sessionId: row.session_id, providerRequestId: row.provider_request_id, kind: row.kind,
      responseType: row.response_type, prompt: JSON.parse(row.prompt_json) as unknown,
      status: row.status, createdAt: row.created_at,
    }));
  }

  /**
   * One Attention of a trusted project. Used to decide whether an answer is even well-formed for
   * the request it targets *before* anything is recorded.
   */
  getAttentionRequest(projectId: string, attentionId: string): AttentionSummary | null {
    const row = this.sqlite.query<{
      id: string; project_id: string; task_id: string; execution_id: string; session_id: string;
      provider_request_id: string; kind: AttentionSummary['kind']; response_type: AttentionSummary['responseType'];
      prompt_json: string; status: AttentionSummary['status']; created_at: number;
    }, [string, string]>(`
      SELECT attention.id,task.project_id,task.id AS task_id,execution.id AS execution_id,
        session.id AS session_id,attention.provider_request_id,attention.kind,attention.response_type,
        attention.prompt_json,attention.status,attention.created_at
      FROM attention_requests attention JOIN agent_sessions session ON session.id=attention.session_id
      JOIN executions execution ON execution.id=session.execution_id
      JOIN tasks task ON task.id=execution.task_id JOIN project_trusts trust
        ON trust.project_id=task.project_id AND trust.status='ACTIVE'
      WHERE task.project_id=?1 AND attention.id=?2
    `).get(projectId, attentionId);
    if (row === null) return null;
    return {
      id: row.id, projectId: row.project_id, taskId: row.task_id, executionId: row.execution_id,
      sessionId: row.session_id, providerRequestId: row.provider_request_id, kind: row.kind,
      responseType: row.response_type, prompt: JSON.parse(row.prompt_json) as unknown,
      status: row.status, createdAt: row.created_at,
    };
  }

  planAttentionAnswer(input: {
    readonly projectId: string;
    readonly attentionId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly intentId: string;
    readonly answerId: string;
    readonly operationId: string;
    readonly answer: StoredAgentAnswer;
    readonly intentEventId: string;
    readonly recordedEventId: string;
    readonly actor: string;
    readonly recordedAt: number;
  }): AgentAnswerPlan {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.recordedAt,
      apply: (database) => {
        const subject = database.query<{
          response_type: 'CONFIRM' | 'VALUE'; attention_status: string; session_state: string;
          execution_state: string; task_state: string; prompt_kind: string | null;
        }, [string, string]>(`
          SELECT attention.response_type,attention.status AS attention_status,
            json_extract(attention.prompt_json,'$.kind') AS prompt_kind,
            session.state AS session_state,execution.state AS execution_state,task.state AS task_state
          FROM attention_requests attention JOIN agent_sessions session ON session.id=attention.session_id
          JOIN executions execution ON execution.id=session.execution_id
          JOIN tasks task ON task.id=execution.task_id JOIN project_trusts trust
            ON trust.project_id=task.project_id AND trust.status='ACTIVE'
          WHERE task.project_id=?1 AND attention.id=?2
        `).get(input.projectId, input.attentionId);
        if (subject === null) throw new StorageError('NOT_FOUND', 'Open Attention request was not found');
        // A prose question has no provider dialog behind it. Answering it here would plan a
        // delivery for a request that never existed, so it is refused with its own code and the
        // caller is pointed at the command that actually ends that wait (FOUNDATION-069).
        if (subject.prompt_kind === proseQuestionPromptKind) {
          throw new StorageError('PROSE_QUESTION_RESOLUTION_REQUIRED',
            'This Attention carries a prose question, not a provider dialog;'
            + ' end the wait with attention.resolve instead of delivering an answer');
        }
        if (subject.attention_status !== 'OPEN' || subject.session_state !== 'WAITING_FOR_USER'
          || subject.execution_state !== 'WAITING_FOR_USER' || subject.task_state !== 'WAITING_FOR_USER') {
          throw new StorageError('INVALID_STATE', 'Attention request is not open on a waiting Agent');
        }
        // A structured answer is a VALUE answer, and only for an Attention that actually carries a
        // Codeestra questionnaire prompt. Both halves are checked here, not only by the caller, so
        // an answer can never be stored against a request it does not fit.
        const compatible = input.answer.type === 'CANCEL'
          || input.answer.type === subject.response_type
          || (input.answer.type === 'QUESTIONNAIRE' && subject.response_type === 'VALUE'
            && subject.prompt_kind === 'codeestra.questionnaire');
        if (!compatible) {
          throw new StorageError('INVALID_STATE',
            `${input.answer.type} answer does not match ${subject.response_type} Attention`);
        }
        const answerJson = JSON.stringify(input.answer);
        this.insertIntent(database, {
          id: input.intentId, projectId: input.projectId, idempotencyKey: input.commandId,
          rawText: answerJson, kind: 'ANSWER_AGENT', status: 'APPLIED',
          actor: input.actor, createdAt: input.recordedAt,
        });
        database.query('INSERT INTO intent_attention_targets(intent_id,attention_id) VALUES (?1,?2)')
          .run(input.intentId, input.attentionId);
        database.query(`
          INSERT INTO attention_answers(id,request_id,command_id,actor,answer_json,created_at)
          VALUES (?1,?2,?3,?4,?5,?6)
        `).run(input.answerId, input.attentionId, input.commandId, input.actor, answerJson, input.recordedAt);
        database.query("UPDATE attention_requests SET status='ANSWER_RECORDED' WHERE id=?1 AND status='OPEN'")
          .run(input.attentionId);
        database.query(`
          INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,
            request_json,created_at,updated_at)
          VALUES (?1,?2,'ANSWER_AGENT',?3,?4,'PLANNED',?5,?6,?6)
        `).run(input.operationId, input.projectId, input.attentionId, input.commandId,
          JSON.stringify({ payloadHash: input.payloadHash, attentionId: input.attentionId,
            answerId: input.answerId }), input.recordedAt);
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'IntentRecorded',1,'Intent',?3,0,?4,?4,?5,?6)
        `).run(input.intentEventId, input.projectId, input.intentId, input.commandId, input.recordedAt,
          JSON.stringify({ intentId: input.intentId, kind: 'ANSWER_AGENT' }));
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'UserAnswerRecorded',1,'Attention',?3,1,?4,?5,?6,?7)
        `).run(input.recordedEventId, input.projectId, input.attentionId, input.commandId,
          input.intentEventId, input.recordedAt,
          JSON.stringify({ attentionId: input.attentionId, answerId: input.answerId }));
        const plan = this.agentAnswerRow(input.operationId);
        if (plan === null) throw new Error('Agent answer plan was not persisted');
        return plan;
      },
    });
  }

  getAgentAnswerPlan(operationId: string): AgentAnswerPlan {
    const plan = this.agentAnswerRow(operationId);
    if (plan === null) throw new StorageError('NOT_FOUND', 'Agent answer Operation was not found');
    return plan;
  }

  listIncompleteAgentAnswers(): readonly AgentAnswerPlan[] {
    return this.sqlite.query<{ id: string }, []>(`
      SELECT id FROM operations WHERE kind='ANSWER_AGENT'
        AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED') ORDER BY created_at,id
    `).all().map((row) => this.getAgentAnswerPlan(row.id));
  }

  startAgentAnswerOperation(operationId: string, startedAt: number): AgentAnswerPlan {
    const result = this.sqlite.query(`
      UPDATE operations SET state='IN_PROGRESS',result_json=NULL,updated_at=?1
      WHERE id=?2 AND kind='ANSWER_AGENT' AND state='PLANNED'
    `).run(startedAt, operationId);
    if (result.changes !== 1) throw new StorageError('INVALID_STATE', 'Agent answer Operation was not PLANNED');
    return this.getAgentAnswerPlan(operationId);
  }

  retryAgentAnswerAfterProvenFailure(input: {
    readonly operationId: string;
    readonly error: Readonly<{ code: string; message: string }>;
    readonly failedAt: number;
  }): void {
    const result = this.sqlite.query(`
      UPDATE operations SET state='PLANNED',result_json=?1,updated_at=?2
      WHERE id=?3 AND kind='ANSWER_AGENT' AND state='IN_PROGRESS'
    `).run(JSON.stringify({ error: input.error, deliveryMayHaveOccurred: false }),
      input.failedAt, input.operationId);
    if (result.changes !== 1) throw new StorageError('INVALID_STATE', 'Failed Agent answer was not IN_PROGRESS');
  }

  completeAgentAnswer(input: {
    readonly operationId: string;
    readonly deliveredEventId: string;
    readonly sessionEventId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly deliveredAt: number;
  }): AgentAnswerPlan {
    return this.sqlite.transaction(() => {
      const plan = this.getAgentAnswerPlan(input.operationId);
      if (plan.operationState !== 'IN_PROGRESS' || plan.status !== 'ANSWER_RECORDED') {
        throw new StorageError('INVALID_STATE', 'Delivered Agent answer did not match its plan');
      }
      this.sqlite.query("UPDATE attention_requests SET status='DELIVERED' WHERE id=?1 AND status='ANSWER_RECORDED'")
        .run(plan.id);
      this.sqlite.query(`
        UPDATE operations SET state='SUCCEEDED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state='IN_PROGRESS'
      `).run(JSON.stringify({ attentionId: plan.id, answerId: plan.answerId,
        providerRequestId: plan.providerRequestId }), input.deliveredAt, input.operationId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'UserAnswerDelivered',1,'Attention',?3,2,?4,?4,?5,?6)
      `).run(input.deliveredEventId, plan.projectId, plan.id, input.operationId, input.deliveredAt,
        JSON.stringify({ attentionId: plan.id, answerId: plan.answerId }));
      const blockers = this.sqlite.query<{ count: number }, [string]>(`
        SELECT count(*) AS count FROM attention_requests
        WHERE session_id=?1 AND status IN ('OPEN','ANSWER_RECORDED')
      `).get(plan.sessionId)?.count ?? 0;
      if (blockers === 0) {
        const session = this.sqlite.query<{ version: number }, [string]>(
          "SELECT version FROM agent_sessions WHERE id=?1 AND state='WAITING_FOR_USER'",
        ).get(plan.sessionId);
        const execution = this.sqlite.query<{ version: number }, [string]>(
          "SELECT version FROM executions WHERE id=?1 AND state='WAITING_FOR_USER'",
        ).get(plan.executionId);
        const task = this.sqlite.query<{ version: number }, [string]>(
          "SELECT version FROM tasks WHERE id=?1 AND state='WAITING_FOR_USER'",
        ).get(plan.taskId);
        if (session === null || execution === null || task === null) {
          throw new StorageError('INVALID_STATE', 'Waiting Agent aggregates did not match delivered answer');
        }
        this.sqlite.query("UPDATE agent_sessions SET state='ACTIVE',version=version+1,last_observed_at=?1 WHERE id=?2")
          .run(input.deliveredAt, plan.sessionId);
        this.sqlite.query("UPDATE executions SET state='RUNNING',version=version+1 WHERE id=?1")
          .run(plan.executionId);
        this.sqlite.query("UPDATE tasks SET state='RUNNING',version=version+1,updated_at=?1 WHERE id=?2")
          .run(input.deliveredAt, plan.taskId);
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'AgentSessionStateChanged',1,'AgentSession',?3,?4,?5,?6,?7,?8)
        `).run(input.sessionEventId, plan.projectId, plan.sessionId, session.version + 1,
          input.operationId, input.deliveredEventId, input.deliveredAt,
          JSON.stringify({ sessionId: plan.sessionId, from: 'WAITING_FOR_USER', to: 'ACTIVE' }));
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?6,?7,?8)
        `).run(input.executionEventId, plan.projectId, plan.executionId, execution.version + 1,
          input.operationId, input.sessionEventId, input.deliveredAt,
          JSON.stringify({ executionId: plan.executionId, from: 'WAITING_FOR_USER', to: 'RUNNING',
            reason: 'all Attention answers delivered' }));
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
        `).run(input.taskEventId, plan.projectId, plan.taskId, task.version + 1,
          input.operationId, input.executionEventId, input.deliveredAt,
          JSON.stringify({ taskId: plan.taskId, from: 'WAITING_FOR_USER', to: 'RUNNING',
            reason: 'all Attention answers delivered' }));
      }
      return this.getAgentAnswerPlan(input.operationId);
    })();
  }

  markAgentAnswerUncertain(input: {
    readonly operationId: string;
    readonly recoveryEventId: string;
    readonly taskEventId: string;
    readonly error: Readonly<{ code: string; message: string }>;
    readonly failedAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const plan = this.getAgentAnswerPlan(input.operationId);
      if (plan.operationState !== 'IN_PROGRESS') {
        throw new StorageError('INVALID_STATE', 'Uncertain Agent answer was not IN_PROGRESS');
      }
      this.sqlite.query("UPDATE operations SET state='RECONCILE_REQUIRED',result_json=?1,updated_at=?2 WHERE id=?3")
        .run(JSON.stringify({ error: input.error, deliveryMayHaveOccurred: true }),
          input.failedAt, input.operationId);
      this.sqlite.query("UPDATE agent_sessions SET state='RECOVERY_REQUIRED',version=version+1,last_observed_at=?1 WHERE id=?2")
        .run(input.failedAt, plan.sessionId);
      this.sqlite.query("UPDATE executions SET state='RECOVERY_REQUIRED',version=version+1 WHERE id=?1")
        .run(plan.executionId);
      this.sqlite.query("UPDATE workspaces SET state='RECOVERY_REQUIRED' WHERE id=(SELECT workspace_id FROM executions WHERE id=?1)")
        .run(plan.executionId);
      const taskVersion = this.sqlite.query<{ version: number }, [string]>(
        "SELECT version FROM tasks WHERE id=?1 AND state='WAITING_FOR_USER'",
      ).get(plan.taskId)?.version;
      if (taskVersion === undefined) {
        throw new StorageError('INVALID_STATE', 'Uncertain Agent answer Task was not waiting');
      }
      this.sqlite.query("UPDATE tasks SET state='RECOVERY_REQUIRED',version=version+1,updated_at=?1 WHERE id=?2")
        .run(input.failedAt, plan.taskId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'RecoveryRequired',1,'Attention',?3,2,?4,?4,?5,?6)
      `).run(input.recoveryEventId, plan.projectId, plan.id, input.operationId, input.failedAt,
        JSON.stringify({ resourceType: 'AgentAnswer', resourceId: plan.answerId,
          reason: input.error.code }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
      `).run(input.taskEventId, plan.projectId, plan.taskId, taskVersion + 1,
        input.operationId, input.recoveryEventId, input.failedAt,
        JSON.stringify({ taskId: plan.taskId, from: 'WAITING_FOR_USER',
          to: 'RECOVERY_REQUIRED', reason: 'Agent answer delivery uncertain' }));
    })();
  }

  /**
   * Ends one prose-question wait, idempotently by command (FOUNDATION-069 / ADR-0043).
   *
   * A prose question is not a provider dialog: its Session already exited, so no answer is ever
   * delivered and no conversation is resumed. What this records is how the wait ended — a false
   * alarm the user dismissed, or an answer the user gave in prose — plus the Task going back to the
   * state it was in before the escalation. The user's input is kept in `attention_answers` (the
   * Attention answer ledger) and in append-only events; it is deliberately *not* recorded as an
   * `ANSWER_AGENT` intent, because no Agent received it and inventing that intent would report a
   * delivery that did not happen. `deliveredToProvider: false` is the same statement in the result.
   *
   * Every refusal is thrown *before* anything is written: a refused resolution leaves no partial
   * wait behind, and its reason is the stable code the command face reports.
   */
  resolveProseQuestionAttention(input: {
    readonly projectId: string;
    readonly attentionId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly resolution: ProseQuestionResolution;
    readonly text: string | null;
    readonly note: string | null;
    readonly actor: string;
    readonly answerId: string;
    readonly resolutionEventId: string;
    readonly taskEventId: string;
    readonly resolvedAt: number;
  }): ProseQuestionResolutionPlan {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.resolvedAt,
      apply: (database) => {
        const payload = validateProseQuestionResolution({
          resolution: input.resolution,
          text: input.text,
          note: input.note,
        });
        if (!payload.allowed) {
          throw new StorageError(payload.code, payload.message);
        }
        const subject = database.query<{
          kind: string; attention_status: string; prompt_json: string;
          session_state: string; execution_state: string; task_state: string;
          task_id: string; task_version: number; execution_id: string; session_id: string;
        }, [string, string]>(`
          SELECT attention.kind,attention.status AS attention_status,attention.prompt_json,
            session.state AS session_state,execution.state AS execution_state,
            task.state AS task_state,task.id AS task_id,task.version AS task_version,
            execution.id AS execution_id,session.id AS session_id
          FROM attention_requests attention JOIN agent_sessions session ON session.id=attention.session_id
          JOIN executions execution ON execution.id=session.execution_id
          JOIN tasks task ON task.id=execution.task_id JOIN project_trusts trust
            ON trust.project_id=task.project_id AND trust.status='ACTIVE'
          WHERE task.project_id=?1 AND attention.id=?2
        `).get(input.projectId, input.attentionId);
        if (subject === null) {
          throw new StorageError('NOT_FOUND', 'Prose question Attention was not found');
        }
        const decision = decideProseQuestionResolution({
          attentionKind: subject.kind,
          attentionStatus: subject.attention_status,
          prompt: JSON.parse(subject.prompt_json) as unknown,
          sessionState: subject.session_state,
          executionState: subject.execution_state,
          taskState: subject.task_state,
        });
        if (!decision.allowed) {
          throw new StorageError(decision.code, decision.message);
        }
        const answerJson = JSON.stringify({
          type: 'PROSE_QUESTION_RESOLUTION',
          resolution: input.resolution,
          text: input.text,
          note: input.note,
          actor: input.actor,
        });
        database.query(`
          INSERT INTO attention_answers(id,request_id,command_id,actor,answer_json,created_at)
          VALUES (?1,?2,?3,?4,?5,?6)
        `).run(input.answerId, input.attentionId, input.commandId, input.actor, answerJson,
          input.resolvedAt);
        const attentionUpdate = database.query(
          "UPDATE attention_requests SET status='CLOSED' WHERE id=?1 AND status='OPEN'",
        ).run(input.attentionId);
        const taskUpdate = database.query(`
          UPDATE tasks SET state='RUNNING',version=version+1,updated_at=?1
          WHERE id=?2 AND state='WAITING_FOR_USER'
        `).run(input.resolvedAt, subject.task_id);
        if (attentionUpdate.changes !== 1 || taskUpdate.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION',
            'Prose question resolution raced another change');
        }
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ProseQuestionAttentionResolved',1,'Attention',?3,1,?4,?4,?5,?6)
        `).run(input.resolutionEventId, input.projectId, input.attentionId, input.commandId,
          input.resolvedAt, JSON.stringify({ attentionId: input.attentionId,
            resolution: input.resolution, answerText: input.text, note: input.note,
            actor: input.actor, attentionStatus: 'CLOSED',
            // The wait ended; nothing was sent to the Agent and no conversation was resumed.
            deliveredToProvider: false,
            reason: 'a prose question has no provider dialog to answer' }));
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
        `).run(input.taskEventId, input.projectId, subject.task_id, subject.task_version + 1,
          input.commandId, input.resolutionEventId, input.resolvedAt,
          JSON.stringify({ taskId: subject.task_id, from: 'WAITING_FOR_USER', to: 'RUNNING',
            reason: 'prose question resolved by the user; no provider conversation was resumed' }));
        return {
          attentionId: input.attentionId,
          projectId: input.projectId,
          taskId: subject.task_id,
          executionId: subject.execution_id,
          sessionId: subject.session_id,
          resolution: input.resolution,
          answerText: input.text,
          note: input.note,
          actor: input.actor,
          taskState: 'RUNNING' as const,
          executionState: 'RUNNING' as const,
          sessionState: 'EXITED' as const,
          attentionStatus: 'CLOSED' as const,
          deliveredToProvider: false as const,
          resolvedAt: input.resolvedAt,
        };
      },
    });
  }

  private agentAnswerRow(operationId: string): AgentAnswerPlan | null {
    const row = this.sqlite.query<{
      operation_id: string; operation_state: AgentAnswerPlan['operationState']; project_id: string;
      attention_id: string; provider_request_id: string; kind: AgentAnswerPlan['kind'];
      response_type: AgentAnswerPlan['responseType']; prompt_json: string; attention_status: AgentAnswerPlan['status'];
      attention_created_at: number; answer_id: string; answer_json: string; session_id: string;
      execution_id: string; task_id: string; adapter_id: string; provider_session_id: string | null;
    }, [string]>(`
      SELECT operation.id AS operation_id,operation.state AS operation_state,operation.project_id,
        attention.id AS attention_id,attention.provider_request_id,attention.kind,attention.response_type,
        attention.prompt_json,attention.status AS attention_status,attention.created_at AS attention_created_at,
        answer.id AS answer_id,answer.answer_json,session.id AS session_id,execution.id AS execution_id,
        task.id AS task_id,execution.adapter_id,session.provider_session_id
      FROM operations operation JOIN attention_requests attention ON attention.id=operation.aggregate_id
      JOIN attention_answers answer ON answer.request_id=attention.id
      JOIN agent_sessions session ON session.id=attention.session_id
      JOIN executions execution ON execution.id=session.execution_id JOIN tasks task ON task.id=execution.task_id
      WHERE operation.id=?1 AND operation.kind='ANSWER_AGENT'
    `).get(operationId);
    if (row === null) return null;
    if (row.provider_session_id === null) {
      throw new StorageError('INVALID_STATE', 'Answer target Session has no provider identity');
    }
    return {
      operationId: row.operation_id, operationState: row.operation_state,
      id: row.attention_id, projectId: row.project_id, taskId: row.task_id,
      executionId: row.execution_id, sessionId: row.session_id,
      providerRequestId: row.provider_request_id, kind: row.kind, responseType: row.response_type,
      prompt: JSON.parse(row.prompt_json) as unknown, status: row.attention_status,
      createdAt: row.attention_created_at, answerId: row.answer_id,
      answer: JSON.parse(row.answer_json) as StoredAgentAnswer,
      adapterId: row.adapter_id, providerSessionId: row.provider_session_id,
    };
  }

  recordAgentCompleted(input: {
    readonly sessionId: string;
    readonly executionId: string;
    readonly providerEventId: string;
    readonly cursor: string;
    readonly outcome: 'SUCCESS' | 'FAILURE';
    readonly evidence: Readonly<{ ref: string; toolsQuiescent: true; ownedWritersStopped: true }>;
    /** Bounded provider-classified reason; only recorded for a FAILURE outcome. */
    readonly failure?: Readonly<{ code: string; message: string }>;
    /**
     * Provider-reported completion facts when the Adapter could report them. They are stored with
     * the completion so a reader can always check the Runtime's note against the observations.
     */
    readonly facts?: AgentCompletionFacts;
    /**
     * The Runtime's deterministically derived note, or absent for an ordinary completion. Recording
     * it is what makes "SUCCESS" explain itself; it changes no state and is not an Attention.
     */
    readonly note?: AgentCompletionNote;
    /**
     * The escalated wait for a note the Runtime decided to act on (FOUNDATION-069). It is projected
     * in the same transaction as the completion, so "the Agent ended by asking in prose" and "this
     * Task is waiting for a human" can never be recorded one without the other.
     *
     * Absent means the completion is not escalated — either the rule did not fire, or the runtime
     * setting says `record-only`/`off`. Neither case is a wait, and neither is invented here.
     */
    readonly proseQuestion?: ProseQuestionWaitProjection;
    readonly sessionEventId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly observedAt: number;
  }): AdapterEventResult {
    return this.sqlite.transaction(() => {
      const payloadJson = JSON.stringify({ outcome: input.outcome, evidence: input.evidence,
        ...(input.failure === undefined ? {} : { failure: input.failure }),
        ...(input.facts === undefined ? {} : { facts: input.facts }),
        ...(input.note === undefined ? {} : { note: input.note }) });
      const duplicate = this.adapterEventDuplicate(input.sessionId, input.providerEventId,
        input.cursor, 'completed', payloadJson);
      if (duplicate) return this.adapterEventResult(input.sessionId, input.providerEventId);
      const subject = this.observableAgentSessionRow(input.sessionId);
      if (subject === null || subject.executionId !== input.executionId) {
        throw new StorageError('NOT_FOUND', 'Adapter completion Session identity did not match');
      }
      if (subject.sessionState !== 'ACTIVE' || subject.executionState !== 'RUNNING') {
        throw new StorageError('INVALID_STATE',
          `Completion requires ACTIVE/RUNNING, got ${subject.sessionState}/${subject.executionState}`);
      }
      this.insertAdapterEvent(input.sessionId, input.providerEventId, input.cursor,
        'completed', payloadJson, input.observedAt);
      const sessionUpdate = this.sqlite.query(`
        UPDATE agent_sessions SET state='EXITED',version=version+1,observation_cursor=?1,
          last_observed_at=?2,exit_json=?3 WHERE id=?4 AND state='ACTIVE'
      `).run(input.cursor, input.observedAt, payloadJson, input.sessionId);
      if (sessionUpdate.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Agent Session changed during completion projection');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'AgentSessionCompleted',1,'AgentSession',?3,?4,?5,?6,?7,?8)
      `).run(input.sessionEventId, subject.projectId, input.sessionId, subject.sessionVersion + 1,
        input.executionId, input.providerEventId, input.observedAt,
        JSON.stringify({ executionId: input.executionId, sessionId: input.sessionId,
          outcome: input.outcome, evidenceRef: input.evidence.ref,
          // The note travels with the append-only completion fact, so "why does this SUCCESS say
          // nothing happened" is answerable from the event log alone (FOUNDATION-056).
          ...(input.note === undefined ? {} : { note: input.note }) }));
      // The escalation is part of this same transaction, not a follow-up the caller could skip:
      // what is recorded is exactly "this completion, and this wait", or neither.
      let proseQuestionAttentionId: string | null = null;
      if (input.proseQuestion !== undefined
        && this.#projectProseQuestionWait({
          projectId: subject.projectId,
          taskId: subject.taskId,
          taskVersion: subject.taskVersion,
          sessionId: input.sessionId,
          executionId: input.executionId,
          providerEventId: input.providerEventId,
          observedAt: input.observedAt,
          proseQuestion: input.proseQuestion,
        })) {
        proseQuestionAttentionId = input.proseQuestion.attentionId;
      }
      if (input.outcome === 'FAILURE') {
        const executionUpdate = this.sqlite.query(`
          UPDATE executions SET state='FAILED',resource_held=0,version=version+1,
            ended_at=?1,error_json=?2 WHERE id=?3 AND state='RUNNING'
        `).run(input.observedAt, JSON.stringify({ code: 'AGENT_REPORTED_FAILURE',
          ...(input.failure === undefined ? {} : { message: input.failure.message }) }),
        input.executionId);
        const workspaceUpdate = this.sqlite.query(
          "UPDATE workspaces SET state='RETAINED' WHERE id=?1 AND state='IN_USE'",
        ).run(subject.workspaceId);
        const taskUpdate = this.sqlite.query(`
          UPDATE tasks SET state='FAILED',version=version+1,updated_at=?1
          WHERE id=?2 AND state='RUNNING'
        `).run(input.observedAt, subject.taskId);
        if (executionUpdate.changes !== 1 || workspaceUpdate.changes !== 1 || taskUpdate.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Failure subject changed during projection');
        }
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ExecutionFailed',1,'Execution',?3,?4,?5,?6,?7,?8)
        `).run(input.executionEventId, subject.projectId, input.executionId,
          subject.executionVersion + 1, input.executionId, input.sessionEventId, input.observedAt,
          JSON.stringify({ executionId: input.executionId, reason: 'AGENT_REPORTED_FAILURE',
            stopEvidenceRef: input.evidence.ref,
            ...(input.failure === undefined ? {} : { failure: input.failure }) }));
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
        `).run(input.taskEventId, subject.projectId, subject.taskId, subject.taskVersion + 1,
          input.executionId, input.executionEventId, input.observedAt,
          JSON.stringify({ taskId: subject.taskId, from: 'RUNNING', to: 'FAILED',
            reason: 'agent reported failure' }));
      }
      return { duplicate: false as const, eventId: input.providerEventId, cursor: input.cursor,
        sessionState: 'EXITED' as const,
        executionState: input.outcome === 'FAILURE' ? 'FAILED' as const : 'RUNNING' as const,
        ...(proseQuestionAttentionId === null ? {} : { attentionId: proseQuestionAttentionId }) };
    })();
  }

  /**
   * Records one escalated prose question: the Attention, the `WAITING_FOR_USER` Task, and the two
   * append-only events. Session and Execution are deliberately left alone — the provider process
   * really did exit and the Execution really is still the attempt holding the workspace, so this
   * wait is only ever expressed on the Task (invariant 10: it pauses that Task alone).
   *
   * The Task must be `RUNNING`. When it is not (a stop raced this completion), the wait is skipped
   * and nothing is written: the completion keeps its note, but escalating a Task the user is
   * already stopping would create a wait nobody can act on. Skipping is not a silent success — the
   * caller records the note as always, and `attention list` simply has no new row.
   *
   * Returns whether the wait was recorded.
   */
  #projectProseQuestionWait(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly taskVersion: number;
    readonly sessionId: string;
    readonly executionId: string;
    readonly providerEventId: string;
    readonly observedAt: number;
    readonly proseQuestion: ProseQuestionWaitProjection;
  }): boolean {
    const promptJson = JSON.stringify(input.proseQuestion.prompt);
    if (promptJson === undefined) {
      throw new StorageError('INVALID_STATE', 'Prose question Attention prompt is not JSON serializable');
    }
    // The Task moves first: it is the only conditional step, so a Task that is not RUNNING ends this
    // helper before any row or event exists.
    const taskUpdate = this.sqlite.query(`
      UPDATE tasks SET state='WAITING_FOR_USER',version=version+1,updated_at=?1
      WHERE id=?2 AND state='RUNNING'
    `).run(input.observedAt, input.taskId);
    if (taskUpdate.changes !== 1) return false;
    this.sqlite.query(`
      INSERT INTO attention_requests(id,session_id,provider_request_id,kind,prompt_json,status,
        created_at,response_type)
      VALUES (?1,?2,?3,'QUESTION',?4,'OPEN',?5,'VALUE')
    `).run(input.proseQuestion.attentionId, input.sessionId,
      input.proseQuestion.providerRequestId, promptJson, input.observedAt);
    this.sqlite.query(`
      INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
        aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
      VALUES (?1,?2,'UserAttentionRequested',1,'Attention',?3,0,?4,?5,?6,?7)
    `).run(input.proseQuestion.attentionEventId, input.projectId,
      input.proseQuestion.attentionId, input.executionId, input.providerEventId, input.observedAt,
      JSON.stringify({ attentionId: input.proseQuestion.attentionId, sessionId: input.sessionId,
        kind: 'QUESTION', responseType: 'VALUE',
        providerRequestId: input.proseQuestion.providerRequestId,
        // Says out loud that no provider dialog is behind this Attention, so a client never waits
        // for a provider response that will not come.
        proseQuestion: true }));
    this.sqlite.query(`
      INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
        aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
      VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
    `).run(input.proseQuestion.taskEventId, input.projectId, input.taskId,
      input.taskVersion + 1, input.executionId, input.proseQuestion.attentionEventId,
      input.observedAt, JSON.stringify({ taskId: input.taskId, from: 'RUNNING',
        to: 'WAITING_FOR_USER', reason: 'agent asked its question in prose and ended the turn' }));
    return true;
  }

  /** A lost provider transport keeps Execution/workspace ownership: quiescence was never proven. */
  recordAgentDisconnected(input: {
    readonly sessionId: string;
    readonly executionId: string;
    readonly providerEventId: string;
    readonly cursor: string;
    readonly reason: string;
    readonly sessionEventId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly observedAt: number;
  }): AdapterEventResult {
    return this.sqlite.transaction(() => {
      const payloadJson = JSON.stringify({ reason: input.reason });
      const duplicate = this.adapterEventDuplicate(input.sessionId, input.providerEventId,
        input.cursor, 'disconnected', payloadJson);
      if (duplicate) return this.adapterEventResult(input.sessionId, input.providerEventId);
      const subject = this.observableAgentSessionRow(input.sessionId);
      if (subject === null || subject.executionId !== input.executionId) {
        throw new StorageError('NOT_FOUND', 'Adapter disconnect Session identity did not match');
      }
      if (!['ACTIVE', 'WAITING_FOR_USER'].includes(subject.sessionState)
        || !['RUNNING', 'WAITING_FOR_USER'].includes(subject.executionState)) {
        throw new StorageError('INVALID_STATE',
          `Disconnect requires an active Session, got ${subject.sessionState}/${subject.executionState}`);
      }
      this.insertAdapterEvent(input.sessionId, input.providerEventId, input.cursor,
        'disconnected', payloadJson, input.observedAt);
      this.sqlite.query(`
        UPDATE agent_sessions SET state='DISCONNECTED',version=version+1,observation_cursor=?1,
          last_observed_at=?2,exit_json=?3 WHERE id=?4 AND state IN ('ACTIVE','WAITING_FOR_USER')
      `).run(input.cursor, input.observedAt, payloadJson, input.sessionId);
      const executionUpdate = this.sqlite.query(`
        UPDATE executions SET state='RECOVERY_REQUIRED',version=version+1 WHERE id=?1
          AND state IN ('RUNNING','WAITING_FOR_USER')
      `).run(input.executionId);
      const workspaceUpdate = this.sqlite.query(`
        UPDATE workspaces SET state='RECOVERY_REQUIRED' WHERE id=?1 AND state='IN_USE'
      `).run(subject.workspaceId);
      const taskUpdate = this.sqlite.query(`
        UPDATE tasks SET state='RECOVERY_REQUIRED',version=version+1,updated_at=?1
        WHERE id=?2 AND state IN ('RUNNING','WAITING_FOR_USER')
      `).run(input.observedAt, subject.taskId);
      if (executionUpdate.changes !== 1 || workspaceUpdate.changes !== 1 || taskUpdate.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Disconnect subject changed during projection');
      }
      const sessionFrom = subject.sessionState;
      const executionFrom = subject.executionState;
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'AgentSessionStateChanged',1,'AgentSession',?3,?4,?5,?5,?6,?7)
      `).run(input.sessionEventId, subject.projectId, input.sessionId, subject.sessionVersion + 1,
        input.providerEventId, input.observedAt, JSON.stringify({ sessionId: input.sessionId,
          from: sessionFrom, to: 'DISCONNECTED', reason: input.reason }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?6,?7,?8)
      `).run(input.executionEventId, subject.projectId, input.executionId,
        subject.executionVersion + 1, input.providerEventId, input.sessionEventId, input.observedAt,
        JSON.stringify({ executionId: input.executionId, from: executionFrom,
          to: 'RECOVERY_REQUIRED', reason: 'agent transport lost' }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
      `).run(input.taskEventId, subject.projectId, subject.taskId, subject.taskVersion + 1,
        input.providerEventId, input.executionEventId, input.observedAt,
        JSON.stringify({ taskId: subject.taskId, from: 'RUNNING',
          to: 'RECOVERY_REQUIRED', reason: 'agent transport lost' }));
      return { duplicate: false as const, eventId: input.providerEventId, cursor: input.cursor,
        sessionState: 'DISCONNECTED' as const, executionState: 'RECOVERY_REQUIRED' as const };
    })();
  }

  /**
   * Projects a disconnect the Runtime caused itself, for example by releasing its own provider
   * process during shutdown. It is not a provider event, so no Adapter event or cursor is written,
   * and it never claims the Execution succeeded.
   */
  recordRuntimeDisconnect(input: {
    readonly sessionId: string;
    readonly reason: string;
    readonly sessionEventId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly recoveryEventId: string;
    readonly recoveredAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const subject = this.observableAgentSessionRow(input.sessionId);
      if (subject === null) throw new StorageError('NOT_FOUND', 'Runtime disconnect Session was not found');
      if (!['ACTIVE', 'WAITING_FOR_USER'].includes(subject.sessionState)
        || !['RUNNING', 'WAITING_FOR_USER'].includes(subject.executionState)) {
        throw new StorageError('INVALID_STATE',
          `Runtime disconnect requires an active Session, got ${subject.sessionState}/${subject.executionState}`);
      }
      const sessionUpdate = this.sqlite.query(`
        UPDATE agent_sessions SET state='DISCONNECTED',version=version+1,last_observed_at=?1,exit_json=?2
        WHERE id=?3 AND state IN ('ACTIVE','WAITING_FOR_USER')
      `).run(input.recoveredAt, JSON.stringify({ reason: input.reason }), input.sessionId);
      const executionUpdate = this.sqlite.query(`
        UPDATE executions SET state='RECOVERY_REQUIRED',version=version+1
        WHERE id=?1 AND state IN ('RUNNING','WAITING_FOR_USER')
      `).run(subject.executionId);
      const workspaceUpdate = this.sqlite.query(
        "UPDATE workspaces SET state='RECOVERY_REQUIRED' WHERE id=?1 AND state='IN_USE'",
      ).run(subject.workspaceId);
      const taskUpdate = this.sqlite.query(`
        UPDATE tasks SET state='RECOVERY_REQUIRED',version=version+1,updated_at=?1
        WHERE id=?2 AND state IN ('RUNNING','WAITING_FOR_USER')
      `).run(input.recoveredAt, subject.taskId);
      if (sessionUpdate.changes !== 1 || executionUpdate.changes !== 1
        || workspaceUpdate.changes !== 1 || taskUpdate.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Runtime disconnect subject changed during projection');
      }
      // Session, Execution, and Task states move together in this FSM, so the Execution
      // state is the honest `from` value for the Task transition as well.
      const taskFrom = subject.executionState === 'WAITING_FOR_USER' ? 'WAITING_FOR_USER' : 'RUNNING';
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'RecoveryRequired',1,'AgentSession',?3,?4,?5,?5,?6,?7)
      `).run(input.recoveryEventId, subject.projectId, input.sessionId, subject.sessionVersion + 1,
        input.sessionId, input.recoveredAt, JSON.stringify({ resourceType: 'AgentSession',
          resourceId: input.sessionId, reason: input.reason }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'AgentSessionStateChanged',1,'AgentSession',?3,?4,?5,?6,?7,?8)
      `).run(input.sessionEventId, subject.projectId, input.sessionId, subject.sessionVersion + 1,
        input.recoveryEventId, input.recoveryEventId, input.recoveredAt,
        JSON.stringify({ sessionId: input.sessionId, from: subject.sessionState,
          to: 'DISCONNECTED', reason: input.reason }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?6,?7,?8)
      `).run(input.executionEventId, subject.projectId, subject.executionId,
        subject.executionVersion + 1, input.recoveryEventId, input.sessionEventId, input.recoveredAt,
        JSON.stringify({ executionId: subject.executionId, from: subject.executionState,
          to: 'RECOVERY_REQUIRED', reason: input.reason }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
      `).run(input.taskEventId, subject.projectId, subject.taskId, subject.taskVersion + 1,
        input.recoveryEventId, input.executionEventId, input.recoveredAt,
        JSON.stringify({ taskId: subject.taskId, from: taskFrom,
          to: 'RECOVERY_REQUIRED', reason: input.reason }));
    })();
  }

  /**
   * Records one-shot authorization to create a result commit for a quiescent Execution.
   * Any previous ACTIVE authorization for the same Execution is invalidated, because a new
   * preparation always describes a fresh HEAD/ChangeSet snapshot.
   */
  prepareResultCommitAuthorization(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly executionId: string;
    readonly authorizationId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly expectedHead: string;
    readonly changeFingerprint: string;
    readonly policyVersion: number;
    readonly eventId: string;
    readonly invalidatedEventId: string;
    readonly actor: string;
    readonly createdAt: number;
  }): ResultCommitAuthorization {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.createdAt,
      apply: (database) => {
        const subject = this.resultCommitSubject(input.projectId, input.taskId, input.executionId);
        if (subject.currentRevisionId !== subject.appliedRevisionId) {
          throw new StorageError('INVALID_STATE',
            'Task revision changed after the Execution started; a result commit needs a new Execution');
        }
        if (!subject.quiescent) {
          throw new StorageError('INVALID_STATE',
            'Agent tools and owned writers are not proven stopped; result commit is not allowed yet');
        }
        const previous = database.query<{ id: string }, [string]>(`
          SELECT id FROM result_commit_authorizations
          WHERE execution_id=?1 AND status='ACTIVE'
        `).get(input.executionId);
        if (previous !== null) {
          database.query(`
            UPDATE result_commit_authorizations SET status='INVALIDATED',invalidated_at=?1
            WHERE id=?2 AND status='ACTIVE'
          `).run(input.createdAt, previous.id);
          database.query(`
            INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
              aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
            VALUES (?1,?2,'ResultCommitAuthorizationInvalidated',1,'Execution',?3,0,?4,?4,?5,?6)
          `).run(input.invalidatedEventId, input.projectId, input.executionId, input.authorizationId,
            input.createdAt, JSON.stringify({ authorizationId: previous.id,
              executionId: input.executionId, reason: 'superseded by a new preparation' }));
        }
        database.query(`
          INSERT INTO result_commit_authorizations(id,task_id,execution_id,revision_id,workspace_id,
            expected_head,change_fingerprint,actor,status,created_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'ACTIVE',?9)
        `).run(input.authorizationId, input.taskId, input.executionId, subject.appliedRevisionId,
          subject.workspaceId, input.expectedHead, input.changeFingerprint, input.actor, input.createdAt);
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ResultCommitAuthorized',1,'Execution',?3,0,?4,?4,?5,?6)
        `).run(input.eventId, input.projectId, input.executionId, input.commandId, input.createdAt,
          JSON.stringify({ authorizationId: input.authorizationId, executionId: input.executionId,
            revisionId: subject.appliedRevisionId, workspaceId: subject.workspaceId,
            expectedHead: input.expectedHead, changeFingerprint: input.changeFingerprint,
            policyVersion: input.policyVersion }));
        const authorization = this.resultCommitAuthorizationRow(input.authorizationId);
        if (authorization === null) throw new Error('Result commit authorization was not persisted');
        return authorization;
      },
    });
  }

  getResultCommitAuthorization(authorizationId: string): ResultCommitAuthorization {
    const authorization = this.resultCommitAuthorizationRow(authorizationId);
    if (authorization === null) throw new StorageError('NOT_FOUND', 'Result commit authorization was not found');
    return authorization;
  }

  invalidateResultCommitAuthorization(input: {
    readonly authorizationId: string;
    readonly reason: string;
    readonly eventId: string;
    readonly invalidatedAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const row = this.sqlite.query<{ project_id: string; execution_id: string }, [string]>(`
        SELECT task.project_id,authorization.execution_id FROM result_commit_authorizations authorization
        JOIN tasks task ON task.id=authorization.task_id WHERE authorization.id=?1
      `).get(input.authorizationId);
      if (row === null) throw new StorageError('NOT_FOUND', 'Result commit authorization was not found');
      const updated = this.sqlite.query(`
        UPDATE result_commit_authorizations SET status='INVALIDATED',invalidated_at=?1
        WHERE id=?2 AND status='ACTIVE'
      `).run(input.invalidatedAt, input.authorizationId);
      if (updated.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Result commit authorization was not ACTIVE');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ResultCommitAuthorizationInvalidated',1,'Execution',?3,0,?4,?4,?5,?6)
      `).run(input.eventId, row.project_id, row.execution_id, input.authorizationId, input.invalidatedAt,
        JSON.stringify({ authorizationId: input.authorizationId, executionId: row.execution_id,
          reason: input.reason }));
    })();
  }

  /**
   * Persists the capture Operation before the Runtime runs `git add`/`git commit`. The
   * Operation is never replayed: a replay returns a finished Operation, and an interrupted
   * one is reported for reconciliation instead of running the commit side effect twice.
   */
  startResultCommitCapture(input: {
    readonly operationId: string;
    readonly commandId: string;
    readonly authorizationId: string;
    readonly expectedHead: string;
    readonly changeFingerprint: string;
    readonly startedAt: number;
  }): ResultCommitCapturePlan {
    return this.sqlite.transaction(() => {
      const authorization = this.resultCommitAuthorizationRow(input.authorizationId);
      if (authorization === null) {
        throw new StorageError('NOT_FOUND', 'Result commit authorization was not found');
      }
      const existing = this.sqlite.query<{ id: string }, [string, string]>(`
        SELECT id FROM operations WHERE project_id=?1 AND kind='CAPTURE_RESULT' AND idempotency_key=?2
      `).get(authorization.projectId, input.commandId);
      if (existing !== null) {
        const plan = this.resultCommitCapturePlan(existing.id);
        if (plan.operationState === 'SUCCEEDED' || plan.operationState === 'FAILED') return plan;
        throw new StorageError('INVALID_STATE',
          `Result commit capture is ${plan.operationState}; reconcile it instead of replaying the commit`);
      }
      if (authorization.status !== 'ACTIVE') {
        throw new StorageError('INVALID_STATE',
          `Result commit authorization is ${authorization.status}; prepare a new one`);
      }
      if (authorization.expectedHead !== input.expectedHead
        || authorization.changeFingerprint !== input.changeFingerprint) {
        throw new StorageError('INVALID_STATE', 'Capture does not match its authorization snapshot');
      }
      const subject = this.resultCommitSubject(authorization.projectId, authorization.taskId,
        authorization.executionId);
      if (!subject.quiescent) {
        throw new StorageError('INVALID_STATE', 'Agent is no longer proven quiescent');
      }
      if (subject.currentRevisionId !== subject.appliedRevisionId) {
        throw new StorageError('INVALID_STATE', 'Task revision changed after the Execution started');
      }
      this.sqlite.query(`
        INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,
          request_json,created_at,updated_at)
        VALUES (?1,?2,'CAPTURE_RESULT',?3,?4,'IN_PROGRESS',?5,?6,?6)
      `).run(input.operationId, authorization.projectId, authorization.executionId, input.commandId,
        JSON.stringify({ authorizationId: input.authorizationId, executionId: authorization.executionId,
          taskId: authorization.taskId, expectedHead: input.expectedHead,
          changeFingerprint: input.changeFingerprint }), input.startedAt);
      return this.resultCommitCapturePlan(input.operationId);
    })();
  }

  listIncompleteResultCommitCaptures(): readonly ResultCommitCapturePlan[] {
    return this.sqlite.query<{ id: string }, []>(`
      SELECT id FROM operations WHERE kind='CAPTURE_RESULT'
        AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED') ORDER BY created_at,id
    `).all().map((row) => this.resultCommitCapturePlan(row.id));
  }

  /**
   * Consumes the authorization and fixes the created commit on the Execution. The Execution
   * becomes SUCCEEDED, the workspace is retained for verification, and the Task only reaches
   * EXECUTED: a result commit is not a verification and not an integration.
   */
  completeResultCommitCapture(input: {
    readonly operationId: string;
    readonly resultCommit: string;
    readonly resultTree: string;
    readonly identityName: string;
    readonly identityEmail: string;
    readonly hookOutcome: 'PASSED' | 'REPORTED_FAILURE_AFTER_COMMIT';
    /** Bounded Git diagnostics from a commit command that reported a failure after committing. */
    readonly hookDetail: string;
    readonly source: 'CONFIRMED' | 'AUTOMATIC_FULL' | 'RECONCILED';
    readonly eventId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly completedAt: number;
  }): ResultCommitCapturePlan {
    return this.sqlite.transaction(() => {
      const existing = this.resultCommitCapturePlan(input.operationId);
      if (existing.operationState === 'SUCCEEDED') return existing;
      if (existing.operationState !== 'IN_PROGRESS') {
        throw new StorageError('INVALID_STATE',
          `Result commit capture cannot complete from ${existing.operationState}`);
      }
      const authorization = this.resultCommitAuthorizationRow(existing.authorizationId);
      if (authorization === null) {
        throw new StorageError('NOT_FOUND', 'Result commit authorization was not found');
      }
      if (authorization.status !== 'ACTIVE') {
        throw new StorageError('INVALID_STATE',
          `Result commit authorization is ${authorization.status}`);
      }
      if (authorization.expectedHead !== existing.expectedHead
        || authorization.changeFingerprint !== existing.changeFingerprint) {
        throw new StorageError('INVALID_STATE', 'Capture snapshot no longer matches its authorization');
      }
      const subject = this.resultCommitSubject(authorization.projectId,
        authorization.taskId, authorization.executionId);
      if (subject.currentRevisionId !== subject.appliedRevisionId) {
        throw new StorageError('INVALID_STATE', 'Task revision changed before the result commit was recorded');
      }
      if (subject.executionState !== 'RUNNING' || !subject.resourceHeld
        || subject.workspaceState !== 'IN_USE' || subject.taskState !== 'RUNNING') {
        throw new StorageError('INVALID_STATE',
          `Execution is ${subject.executionState}/${subject.workspaceState}/${subject.taskState}; cannot record a result commit`);
      }
      this.sqlite.query(`
        UPDATE result_commit_authorizations SET status='CONSUMED',consumed_at=?1
        WHERE id=?2 AND status='ACTIVE'
      `).run(input.completedAt, authorization.id);
      const executionUpdate = this.sqlite.query(`
        UPDATE executions SET state='SUCCEEDED',resource_held=0,result_commit=?1,version=version+1,
          ended_at=?2 WHERE id=?3 AND state='RUNNING' AND resource_held=1
      `).run(input.resultCommit, input.completedAt, authorization.executionId);
      const workspaceUpdate = this.sqlite.query(
        "UPDATE workspaces SET state='RETAINED' WHERE id=?1 AND state='IN_USE'",
      ).run(authorization.workspaceId);
      const taskUpdate = this.sqlite.query(`
        UPDATE tasks SET state='EXECUTED',version=version+1,updated_at=?1
        WHERE id=?2 AND state='RUNNING'
      `).run(input.completedAt, authorization.taskId);
      if (executionUpdate.changes !== 1 || workspaceUpdate.changes !== 1 || taskUpdate.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Result commit subject changed during capture');
      }
      this.sqlite.query(`
        UPDATE operations SET state='SUCCEEDED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state='IN_PROGRESS'
      `).run(JSON.stringify({ resultCommit: input.resultCommit, resultTree: input.resultTree,
        authorizationId: authorization.id }), input.completedAt, input.operationId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ResultCommitCreated',1,'Execution',?3,?4,?5,?6,?7,?8)
      `).run(input.eventId, authorization.projectId, authorization.executionId,
        subject.executionVersion + 1, input.operationId, null, input.completedAt,
        JSON.stringify({ authorizationId: authorization.id, executionId: authorization.executionId,
          revisionId: authorization.appliedRevisionId, baseCommit: authorization.baseCommit,
          resultCommit: input.resultCommit, resultTree: input.resultTree,
          identity: { name: input.identityName, email: input.identityEmail },
          hookOutcome: input.hookOutcome, hookDetail: input.hookDetail, source: input.source }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?6,?7,?8)
      `).run(input.executionEventId, authorization.projectId, authorization.executionId,
        subject.executionVersion + 1, input.operationId, input.eventId, input.completedAt,
        JSON.stringify({ executionId: authorization.executionId, from: 'RUNNING',
          to: 'SUCCEEDED', reason: 'result commit captured' }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
      `).run(input.taskEventId, authorization.projectId, authorization.taskId,
        subject.taskVersion + 1, input.operationId, input.executionEventId, input.completedAt,
        JSON.stringify({ taskId: authorization.taskId, from: 'RUNNING', to: 'EXECUTED',
          reason: 'result commit captured' }));
      return this.resultCommitCapturePlan(input.operationId);
    })();
  }

  failResultCommitCapture(input: {
    readonly operationId: string;
    readonly error: Readonly<{ code: string; message: string }>;
    readonly reconcileRequired: boolean;
    readonly failedAt: number;
  }): void {
    const state = input.reconcileRequired ? 'RECONCILE_REQUIRED' : 'FAILED';
    const result = this.sqlite.query(`
      UPDATE operations SET state=?1,result_json=?2,updated_at=?3
      WHERE id=?4 AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED')
    `).run(state, JSON.stringify({ error: input.error }), input.failedAt, input.operationId);
    if (result.changes !== 1) {
      throw new StorageError('INVALID_STATE', 'Result commit capture failure did not match its state');
    }
  }

  /** Public projection of one Execution's result-commit subject, including quiescence proof. */
  getResultCommitSubject(projectId: string, taskId: string, executionId: string): ResultCommitSubject {
    return this.resultCommitSubject(projectId, taskId, executionId);
  }

  private resultCommitSubject(
    projectId: string,
    taskId: string,
    executionId: string,
  ): ResultCommitSubject {
    const row = this.sqlite.query<{
      project_id: string; task_id: string; display_number: number; task_version: number;
      task_state: TaskLifecycleState; current_revision_id: string; execution_id: string;
      execution_version: number; execution_state: ExecutionLifecycleState;
      applied_revision_id: string; resource_held: number;
      workspace_id: string; workspace_path: string; workspace_branch_ref: string;
      workspace_state: WorkspaceLifecycleState; base_commit: string;
      session_state: AgentSessionLifecycleState | null; quiescent: number;
    }, [string, string, string]>(`
      SELECT task.project_id,task.id AS task_id,task.display_number,task.version AS task_version,
        task.state AS task_state,task.current_revision_id,execution.id AS execution_id,
        execution.version AS execution_version,execution.state AS execution_state,
        execution.applied_revision_id,execution.resource_held,
        workspace.id AS workspace_id,workspace.path AS workspace_path,
        workspace.branch_ref AS workspace_branch_ref,workspace.state AS workspace_state,
        workspace.base_commit,session.state AS session_state,
        CASE WHEN session.state='EXITED' AND json_extract(session.exit_json,'$.outcome')='SUCCESS'
          AND json_extract(session.exit_json,'$.evidence.toolsQuiescent')=1
          AND json_extract(session.exit_json,'$.evidence.ownedWritersStopped')=1
          THEN 1 ELSE 0 END AS quiescent
      FROM tasks task
      JOIN project_trusts trust ON trust.project_id=task.project_id AND trust.status='ACTIVE'
      JOIN executions execution ON execution.task_id=task.id AND execution.id=?3
      JOIN workspaces workspace ON workspace.id=execution.workspace_id
      LEFT JOIN agent_sessions session ON session.execution_id=execution.id
      WHERE task.project_id=?1 AND task.id=?2
    `).get(projectId, taskId, executionId);
    if (row === null) {
      throw new StorageError('NOT_FOUND', 'Trusted Task, Execution, or workspace was not found');
    }
    return {
      projectId: row.project_id,
      taskId: row.task_id,
      taskDisplayNumber: row.display_number,
      taskVersion: row.task_version,
      taskState: row.task_state,
      currentRevisionId: row.current_revision_id,
      executionId: row.execution_id,
      executionVersion: row.execution_version,
      executionState: row.execution_state,
      appliedRevisionId: row.applied_revision_id,
      resourceHeld: row.resource_held === 1,
      workspaceId: row.workspace_id,
      workspacePath: row.workspace_path,
      workspaceBranchRef: row.workspace_branch_ref,
      workspaceState: row.workspace_state,
      baseCommit: row.base_commit,
      quiescent: row.quiescent === 1,
      sessionState: row.session_state,
    };
  }

  private resultCommitAuthorizationRow(
    authorizationId: string,
    database: Database = this.sqlite,
  ): ResultCommitAuthorization | null {
    const row = database.query<{
      id: string; project_id: string; task_id: string; display_number: number; task_version: number;
      task_state: TaskLifecycleState; current_revision_id: string; execution_id: string;
      execution_state: ExecutionLifecycleState; applied_revision_id: string; resource_held: number;
      workspace_id: string; workspace_path: string; workspace_branch_ref: string;
      workspace_state: WorkspaceLifecycleState; base_commit: string;
      expected_head: string; change_fingerprint: string; status: ResultCommitAuthorization['status'];
      created_at: number; result_commit: string | null;
      session_state: AgentSessionLifecycleState | null; quiescent: number;
    }, [string]>(`
      SELECT authorization.id,task.project_id,task.id AS task_id,task.display_number,
        task.version AS task_version,task.state AS task_state,task.current_revision_id,
        authorization.execution_id,execution.state AS execution_state,execution.applied_revision_id,
        execution.resource_held,authorization.workspace_id,workspace.path AS workspace_path,
        workspace.branch_ref AS workspace_branch_ref,workspace.state AS workspace_state,
        workspace.base_commit,authorization.expected_head,authorization.change_fingerprint,
        authorization.status,authorization.created_at,execution.result_commit,
        session.state AS session_state,
        CASE WHEN session.state='EXITED' AND json_extract(session.exit_json,'$.outcome')='SUCCESS'
          AND json_extract(session.exit_json,'$.evidence.toolsQuiescent')=1
          AND json_extract(session.exit_json,'$.evidence.ownedWritersStopped')=1
          THEN 1 ELSE 0 END AS quiescent
      FROM result_commit_authorizations authorization
      JOIN tasks task ON task.id=authorization.task_id
      JOIN executions execution ON execution.id=authorization.execution_id
      JOIN workspaces workspace ON workspace.id=authorization.workspace_id
      LEFT JOIN agent_sessions session ON session.execution_id=execution.id
      WHERE authorization.id=?1
    `).get(authorizationId);
    if (row === null) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      taskDisplayNumber: row.display_number,
      taskVersion: row.task_version,
      taskState: row.task_state,
      currentRevisionId: row.current_revision_id,
      executionId: row.execution_id,
      executionState: row.execution_state,
      appliedRevisionId: row.applied_revision_id,
      resourceHeld: row.resource_held === 1,
      workspaceId: row.workspace_id,
      workspacePath: row.workspace_path,
      workspaceBranchRef: row.workspace_branch_ref,
      workspaceState: row.workspace_state,
      baseCommit: row.base_commit,
      expectedHead: row.expected_head,
      changeFingerprint: row.change_fingerprint,
      status: row.status,
      createdAt: row.created_at,
      resultCommit: row.result_commit,
      quiescent: row.quiescent === 1,
      sessionState: row.session_state,
    };
  }

  private resultCommitCapturePlan(
    operationId: string,
    database: Database = this.sqlite,
  ): ResultCommitCapturePlan {
    const row = database.query<{
      id: string; state: ResultCommitCapturePlan['operationState']; request_json: string;
      result_json: string | null;
    }, [string]>(`
      SELECT id,state,request_json,result_json FROM operations WHERE id=?1 AND kind='CAPTURE_RESULT'
    `).get(operationId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Result commit capture Operation was not found');
    const request = JSON.parse(row.request_json) as {
      authorizationId: string; executionId: string; taskId: string;
      expectedHead: string; changeFingerprint: string;
    };
    const recorded = row.result_json === null
      ? null
      : JSON.parse(row.result_json) as { resultCommit?: string; resultTree?: string };
    const authorization = this.resultCommitAuthorizationRow(request.authorizationId, database);
    if (authorization === null) {
      throw new StorageError('INVALID_STATE', 'Result commit capture lost its authorization');
    }
    return {
      operationId: row.id,
      operationState: row.state,
      authorizationId: request.authorizationId,
      executionId: request.executionId,
      taskId: request.taskId,
      expectedHead: request.expectedHead,
      changeFingerprint: request.changeFingerprint,
      authorization,
      resultCommit: recorded?.resultCommit ?? null,
      resultTree: recorded?.resultTree ?? null,
    };
  }

  /**
   * Highest committed sequence, or 0 for an empty log. A new subscriber stores this as its
   * snapshot cursor, so events committed after the snapshot are never missed.
   */
  latestEventSequence(): number {
    const row = this.sqlite.query<{ sequence: number | null }, []>(
      'SELECT MAX(sequence) AS sequence FROM domain_events').get();
    return row?.sequence ?? 0;
  }

  /**
   * Ordered read over the append-only event log. `sinceSequence` is exclusive, so a reader that
   * persists the last delivered cursor resumes with neither a gap nor a duplicate at the boundary.
   * This is a subscription read, not a durable consumer: `event_deliveries` remains the
   * at-least-once outbox.
   *
   * A Project-filtered read delivers that Project's events **and** the Runtime global events
   * (`project_id IS NULL`), because a global capacity fact affects every Project (ADR-0061 D10). The
   * cursor still advances over the same single sequence, so reconnecting never skips and never repeats
   * an event at the boundary; an unfiltered read (`projectId` absent) remains the whole log.
   */
  listEventsAfter(input: {
    readonly sinceSequence: number;
    readonly limit: number;
    readonly projectId?: string;
  }): readonly StoredEventEnvelope[] {
    if (!Number.isInteger(input.sinceSequence) || input.sinceSequence < 0) {
      throw new StorageError('INVALID_STATE', 'Event cursor must be a non-negative integer');
    }
    if (!Number.isInteger(input.limit) || input.limit <= 0 || input.limit > 500) {
      throw new StorageError('INVALID_STATE', 'Event read limit must be between 1 and 500');
    }
    return this.sqlite.query<{
      event_id: string; sequence: number; event_type: string; schema_version: number;
      project_id: string | null; aggregate_type: string; aggregate_id: string;
      aggregate_version: number; correlation_id: string;
      causation_id: string | null; occurred_at: number; payload_json: string;
    }, [number, string | null, number]>(`
      SELECT event_id,sequence,event_type,schema_version,project_id,aggregate_type,aggregate_id,
        aggregate_version,correlation_id,causation_id,occurred_at,payload_json
      FROM domain_events
      -- ADR-0061 D10: a Project-filtered reader must also receive the Runtime-global facts
      -- (project_id IS NULL), because global capacity and global pause affect every Project. The
      -- cursor still advances by the one shared sequence, so nothing is delivered twice.
      WHERE sequence>?1 AND (?2 IS NULL OR project_id=?2 OR project_id IS NULL)
      ORDER BY sequence LIMIT ?3
    `).all(input.sinceSequence, input.projectId ?? null, input.limit).map((row) => ({
      eventId: row.event_id, sequence: row.sequence, eventType: row.event_type,
      schemaVersion: row.schema_version, projectId: row.project_id,
      aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version, correlationId: row.correlation_id,
      causationId: row.causation_id, occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json) as unknown,
    }));
  }

  enqueueEventDeliveries(consumerId: string): number {
    if (consumerId.trim().length === 0) throw new StorageError('INVALID_STATE', 'Consumer ID must not be blank');
    return this.sqlite.query(`
      INSERT OR IGNORE INTO event_deliveries(event_id,consumer_id,state,attempt_count)
      SELECT event_id,?1,'PENDING',0 FROM domain_events
    `).run(consumerId).changes;
  }

  listDueEventDeliveries(consumerId: string, now: number, limit: number): readonly PendingEventDelivery[] {
    if (!Number.isInteger(limit) || limit <= 0) throw new StorageError('INVALID_STATE', 'Delivery limit must be positive');
    return this.sqlite.query<{
      event_id: string; sequence: number; event_type: string; schema_version: number; project_id: string;
      aggregate_type: string; aggregate_id: string; aggregate_version: number; correlation_id: string;
      causation_id: string | null; occurred_at: number; payload_json: string; attempt_count: number;
    }, [string, number, number]>(`
      SELECT event.event_id,event.sequence,event.event_type,event.schema_version,event.project_id,
        event.aggregate_type,event.aggregate_id,event.aggregate_version,event.correlation_id,
        event.causation_id,event.occurred_at,event.payload_json,delivery.attempt_count
      FROM event_deliveries delivery JOIN domain_events event ON event.event_id=delivery.event_id
      WHERE delivery.consumer_id=?1 AND delivery.state IN ('PENDING','FAILED')
        AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at<=?2)
      ORDER BY event.sequence LIMIT ?3
    `).all(consumerId, now, limit).map((row) => ({
      eventId: row.event_id, sequence: row.sequence, eventType: row.event_type,
      schemaVersion: row.schema_version, projectId: row.project_id,
      aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version, correlationId: row.correlation_id,
      causationId: row.causation_id, occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json) as unknown, consumerId,
      attemptCount: row.attempt_count,
    }));
  }

  markEventDelivered(eventId: string, consumerId: string): void {
    const result = this.sqlite.query(`
      UPDATE event_deliveries SET state='DELIVERED',attempt_count=attempt_count+1,
        next_attempt_at=NULL,last_error=NULL
      WHERE event_id=?1 AND consumer_id=?2 AND state IN ('PENDING','FAILED')
    `).run(eventId, consumerId);
    if (result.changes !== 1) throw new StorageError('INVALID_STATE', 'Event delivery was not pending');
  }

  markEventDeliveryFailed(input: {
    readonly eventId: string;
    readonly consumerId: string;
    readonly error: string;
    readonly nextAttemptAt: number;
  }): void {
    const result = this.sqlite.query(`
      UPDATE event_deliveries SET state='FAILED',attempt_count=attempt_count+1,
        next_attempt_at=?1,last_error=?2
      WHERE event_id=?3 AND consumer_id=?4 AND state IN ('PENDING','FAILED')
    `).run(input.nextAttemptAt, input.error, input.eventId, input.consumerId);
    if (result.changes !== 1) throw new StorageError('INVALID_STATE', 'Event delivery was not pending');
  }

  private adapterEventDuplicate(
    sessionId: string,
    providerEventId: string,
    cursor: string,
    eventType: 'attention' | 'completed' | 'disconnected',
    payloadJson: string,
  ): boolean {
    const byId = this.sqlite.query<{
      cursor: string; event_type: string; payload_json: string;
    }, [string, string]>(`
      SELECT cursor,event_type,payload_json FROM adapter_events
      WHERE session_id=?1 AND provider_event_id=?2
    `).get(sessionId, providerEventId);
    if (byId !== null) {
      if (byId.cursor !== cursor || byId.event_type !== eventType
        || canonicalJson(JSON.parse(byId.payload_json) as unknown)
          !== canonicalJson(JSON.parse(payloadJson) as unknown)) {
        throw new StorageError('COMMAND_CONFLICT', 'Provider event ID was reused with different content');
      }
      return true;
    }
    const byCursor = this.sqlite.query<{ provider_event_id: string }, [string, string]>(`
      SELECT provider_event_id FROM adapter_events WHERE session_id=?1 AND cursor=?2
    `).get(sessionId, cursor);
    if (byCursor !== null) {
      throw new StorageError('COMMAND_CONFLICT', 'Provider cursor was reused by a different event');
    }
    return false;
  }

  private insertAdapterEvent(
    sessionId: string,
    providerEventId: string,
    cursor: string,
    eventType: 'attention' | 'completed' | 'disconnected',
    payloadJson: string,
    observedAt: number,
  ): void {
    this.sqlite.query(`
      INSERT INTO adapter_events(session_id,provider_event_id,cursor,event_type,payload_json,observed_at)
      VALUES (?1,?2,?3,?4,?5,?6)
    `).run(sessionId, providerEventId, cursor, eventType, payloadJson, observedAt);
  }

  private adapterEventResult(sessionId: string, providerEventId: string): AdapterEventResult {
    const row = this.sqlite.query<{
      cursor: string; event_type: 'attention' | 'completed' | 'disconnected'; payload_json: string;
      attention_id: string | null;
    }, [string, string]>(`
      SELECT adapter.cursor,adapter.event_type,adapter.payload_json,attention.id AS attention_id
      FROM adapter_events adapter
      LEFT JOIN attention_requests attention ON attention.session_id=adapter.session_id
        AND attention.provider_request_id=json_extract(adapter.payload_json,'$.providerRequestId')
      WHERE adapter.session_id=?1 AND adapter.provider_event_id=?2
    `).get(sessionId, providerEventId);
    if (row === null) throw new StorageError('INVALID_STATE', 'Recorded Adapter event was not found');
    if (row.event_type === 'attention') {
      if (row.attention_id === null) {
        throw new StorageError('INVALID_STATE', 'Recorded Attention event lost its request');
      }
      return { duplicate: true, eventId: providerEventId, cursor: row.cursor,
        sessionState: 'WAITING_FOR_USER', executionState: 'WAITING_FOR_USER',
        attentionId: row.attention_id };
    }
    if (row.event_type === 'disconnected') {
      return { duplicate: true, eventId: providerEventId, cursor: row.cursor,
        sessionState: 'DISCONNECTED', executionState: 'RECOVERY_REQUIRED' };
    }
    const payload = JSON.parse(row.payload_json) as { outcome: 'SUCCESS' | 'FAILURE' };
    return { duplicate: true, eventId: providerEventId, cursor: row.cursor,
      sessionState: 'EXITED', executionState: payload.outcome === 'FAILURE' ? 'FAILED' : 'RUNNING' };
  }

  /** One persisted override scope, or `null` when that scope overrides nothing. */
  getAgentConfiguration(
    scope: 'GLOBAL' | 'PROJECT',
    projectId: string | null,
    adapterId: string,
  ): AgentConfigurationRecord | null {
    this.assertAgentConfigurationScope(scope, projectId);
    const row = this.agentConfigurationRow(scope, projectId, adapterId);
    return row === null ? null : mapAgentConfigurationRow(row);
  }

  /**
   * Merges overrides into one scope: an absent field is left unchanged, `null` clears it, and a
   * scope whose fields all become empty is removed so it stops shadowing lower-precedence scopes.
   */
  setAgentConfiguration(input: {
    readonly id: string;
    readonly scope: 'GLOBAL' | 'PROJECT';
    readonly projectId: string | null;
    readonly adapterId: string;
    readonly provider?: string | null;
    readonly model?: string | null;
    readonly thinkingLevel?: string | null;
    /**
     * A whole-list override, or `null` to clear it. A malformed selection is refused here rather
     * than stored, so the Execution's recorded selection is always one the Runtime could apply.
     */
    readonly pluginSelection?: AgentPluginSelection | null;
    readonly updatedAt: number;
    readonly updatedBy: string;
  }): AgentConfigurationRecord | null {
    this.assertAgentConfigurationScope(input.scope, input.projectId);
    if (input.scope === 'PROJECT') this.assertTrustedProject(input.projectId as string);
    const existing = this.agentConfigurationRow(input.scope, input.projectId, input.adapterId);
    const merged = {
      provider: input.provider === undefined ? existing?.provider ?? null : input.provider,
      model: input.model === undefined ? existing?.model ?? null : input.model,
      thinkingLevel: input.thinkingLevel === undefined
        ? existing?.thinking_level ?? null : input.thinkingLevel,
    };
    const present = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== null),
    );
    const parsed = storedAgentConfigurationSchema.safeParse(present);
    if (!parsed.success) {
      throw new StorageError('INVALID_STATE',
        `Invalid Agent configuration: ${parsed.error.message}`);
    }
    const mergedSelection = input.pluginSelection === undefined
      ? parsePluginSelection(existing?.plugin_selection_json ?? null)
      : input.pluginSelection;
    const selectionResult = mergedSelection === null
      ? null
      : agentPluginSelectionSchema.safeParse(mergedSelection);
    if (selectionResult !== null && !selectionResult.success) {
      throw new StorageError('INVALID_STATE',
        `Invalid Agent plugin selection: ${selectionResult.error.message}`);
    }
    const selection = selectionResult === null ? null : selectionResult.data;
    const selectionJson = selection === null ? null : JSON.stringify(selection);
    return this.sqlite.transaction(() => {
      if (Object.keys(parsed.data).length === 0 && selection === null) {
        this.clearAgentConfiguration(input);
        return null;
      }
      if (existing === null) {
        this.sqlite.query(`
          INSERT INTO agent_configurations(id,scope,project_id,adapter_id,provider,model,
            thinking_level,plugin_selection_json,updated_at,updated_by)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
        `).run(input.id, input.scope, input.projectId, input.adapterId,
          merged.provider, merged.model, merged.thinkingLevel, selectionJson,
          input.updatedAt, input.updatedBy);
      } else {
        this.sqlite.query(`
          UPDATE agent_configurations SET provider=?1,model=?2,thinking_level=?3,
            plugin_selection_json=?4,updated_at=?5,updated_by=?6 WHERE id=?7
        `).run(merged.provider, merged.model, merged.thinkingLevel, selectionJson,
          input.updatedAt, input.updatedBy, existing.id);
      }
      const saved = this.agentConfigurationRow(input.scope, input.projectId, input.adapterId);
      if (saved === null) throw new Error('Agent configuration was not persisted');
      return mapAgentConfigurationRow(saved);
    })();
  }

  /** Removes one scope's override. Returns whether a record existed. */
  clearAgentConfiguration(input: {
    readonly scope: 'GLOBAL' | 'PROJECT';
    readonly projectId: string | null;
    readonly adapterId: string;
  }): boolean {
    this.assertAgentConfigurationScope(input.scope, input.projectId);
    return this.sqlite.transaction(() => {
      const row = this.agentConfigurationRow(input.scope, input.projectId, input.adapterId);
      if (row === null) return false;
      this.sqlite.query('DELETE FROM agent_configurations WHERE id=?1').run(row.id);
      return true;
    })();
  }

  private assertAgentConfigurationScope(
    scope: 'GLOBAL' | 'PROJECT',
    projectId: string | null,
  ): void {
    if (scope === 'GLOBAL' && projectId !== null) {
      throw new StorageError('INVALID_STATE', 'Global Agent configuration cannot name a project');
    }
    if (scope === 'PROJECT' && projectId === null) {
      throw new StorageError('INVALID_STATE', 'Project Agent configuration requires a project');
    }
  }

  private assertTrustedProject(projectId: string): void {
    const project = this.sqlite.query<{ id: string }, [string]>(`
      SELECT p.id FROM projects p JOIN project_trusts t
        ON t.project_id=p.id AND t.status='ACTIVE' WHERE p.id=?1
    `).get(projectId);
    if (project === null) throw new StorageError('NOT_FOUND', 'Trusted project was not found');
  }

  private agentConfigurationRow(
    scope: 'GLOBAL' | 'PROJECT',
    projectId: string | null,
    adapterId: string,
  ): AgentConfigurationRow | null {
    return this.sqlite.query<AgentConfigurationRow, [string, string | null, string]>(`
      SELECT id,scope,project_id,adapter_id,provider,model,thinking_level,plugin_selection_json,
        updated_at,updated_by
      FROM agent_configurations
      WHERE scope=?1 AND adapter_id=?3 AND ((project_id IS NULL AND ?2 IS NULL) OR project_id=?2)
    `).get(scope, projectId, adapterId);
  }

  private observableAgentSessionRow(sessionId: string): (Omit<ObservableAgentSession,
    'providerSessionId'> & { readonly providerSessionId: string | null; readonly workspaceId: string }) | null {
    const row = this.sqlite.query<{
      project_id: string; task_id: string; task_version: number; execution_id: string;
      execution_version: number; execution_state: ObservableAgentSession['executionState'];
      session_id: string; session_version: number; session_state: ObservableAgentSession['sessionState'];
      adapter_id: string; provider_session_id: string | null; observation_cursor: string | null;
      workspace_id: string;
    }, [string]>(`
      SELECT task.project_id,task.id AS task_id,task.version AS task_version,
        execution.id AS execution_id,execution.version AS execution_version,
        execution.state AS execution_state,session.id AS session_id,session.version AS session_version,
        session.state AS session_state,execution.adapter_id,session.provider_session_id,
        session.observation_cursor,execution.workspace_id
      FROM agent_sessions session JOIN executions execution ON execution.id=session.execution_id
      JOIN tasks task ON task.id=execution.task_id WHERE session.id=?1
    `).get(sessionId);
    if (row === null) return null;
    return { projectId: row.project_id, taskId: row.task_id, taskVersion: row.task_version,
      executionId: row.execution_id, executionVersion: row.execution_version,
      executionState: row.execution_state, sessionId: row.session_id,
      sessionVersion: row.session_version, sessionState: row.session_state,
      adapterId: row.adapter_id, providerSessionId: row.provider_session_id,
      ...(row.observation_cursor === null ? {} : { cursor: row.observation_cursor }),
      workspaceId: row.workspace_id };
  }

  reserveExecution(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedTaskVersion: number;
    readonly workspaceId: string;
    readonly executionId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly reservationEventId: string;
    readonly taskEventId: string;
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly agentConfig?: StoredAgentConfiguration | null;
    /** Set when this attempt continues an earlier paused Execution's conversation. */
    readonly resumeFromExecutionId?: string;
    /**
     * The knowledge snapshot this Execution used (FOUNDATION-067 / ADR-0041). It is inserted in the
     * same write transaction as the Execution row, so "the Execution exists" and "the Execution is
     * bound to the knowledge it used" can never be observed apart — a binding is not a second,
     * losable write. Absent only for a caller that resolved no knowledge at all; there is no
     * silently empty binding.
     */
    readonly knowledgeBinding?: {
      readonly snapshotId: string;
      readonly snapshotDigest: string;
      readonly contextPath: string;
      readonly contextDigest: string;
      readonly contextBytes: number;
      readonly entryCount: number;
      readonly refs: readonly string[];
      readonly commandId: string;
    };
    readonly actor: string;
    readonly createdAt: number;
  }): ExecutionReservation {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.createdAt,
      apply: (database) => {
        const subject = database.query<{
          task_state: TaskLifecycleState; task_version: number; revision_id: string;
          workspace_state: string; workspace_path: string; ownership_token: string; base_commit: string;
          pending_retry_from_execution_id: string | null;
        }, [string, string, string]>(`
          SELECT task.state AS task_state,task.version AS task_version,
            task.current_revision_id AS revision_id,workspace.state AS workspace_state,
            workspace.path AS workspace_path,workspace.ownership_token,workspace.base_commit,
            task.pending_retry_from_execution_id
          FROM tasks task
          JOIN project_trusts trust ON trust.project_id=task.project_id AND trust.status='ACTIVE'
          JOIN workspaces workspace ON workspace.task_id=task.id AND workspace.id=?3
          WHERE task.project_id=?1 AND task.id=?2
        `).get(input.projectId, input.taskId, input.workspaceId);
        if (subject === null) {
          throw new StorageError('NOT_FOUND', 'Task, workspace, or active project trust was not found');
        }
        if (subject.task_version !== input.expectedTaskVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
        }
        if (subject.task_state !== 'READY' || subject.workspace_state !== 'READY') {
          throw new StorageError(
            'INVALID_STATE',
            `Execution requires READY Task and workspace; got ${subject.task_state}/${subject.workspace_state}`,
          );
        }
        const attempt = database.query<{ number: number }, [string]>(`
          SELECT COALESCE(MAX(attempt_number),0)+1 AS number FROM executions WHERE task_id=?1
        `).get(input.taskId);
        if (attempt === null) throw new Error('Could not allocate an Execution attempt number');
        const agentConfigJson = input.agentConfig === undefined || input.agentConfig === null
            || Object.keys(input.agentConfig).length === 0
          ? null : canonicalJson(input.agentConfig);
        database.query(`
          INSERT INTO executions(id,task_id,attempt_number,initial_revision_id,applied_revision_id,
            workspace_id,adapter_id,adapter_version,state,resource_held,base_commit,version,
            agent_config_json,resume_from_execution_id,retry_from_execution_id)
          VALUES (?1,?2,?3,?4,?4,?5,?6,?7,'CREATED',1,?8,0,?9,?10,?11)
        `).run(input.executionId, input.taskId, attempt.number, subject.revision_id,
          input.workspaceId, input.adapterId, input.adapterVersion, subject.base_commit,
          agentConfigJson, input.resumeFromExecutionId ?? null,
          subject.pending_retry_from_execution_id);
        const knowledgeBinding = input.knowledgeBinding;
        if (knowledgeBinding !== undefined) {
          database.query(`
            INSERT INTO execution_knowledge_snapshots(execution_id,project_id,task_id,snapshot_id,
              snapshot_digest,context_path,context_digest,context_bytes,entry_count,refs_json,
              command_id,created_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
          `).run(input.executionId, input.projectId, input.taskId, knowledgeBinding.snapshotId,
            knowledgeBinding.snapshotDigest, knowledgeBinding.contextPath,
            knowledgeBinding.contextDigest, knowledgeBinding.contextBytes,
            knowledgeBinding.entryCount, JSON.stringify(knowledgeBinding.refs),
            knowledgeBinding.commandId, input.createdAt);
        }
        const workspaceUpdate = database.query(
          "UPDATE workspaces SET state='IN_USE' WHERE id=?1 AND state='READY'",
        ).run(input.workspaceId);
        if (workspaceUpdate.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Workspace changed during Execution reservation');
        }
        const taskVersion = input.expectedTaskVersion + 1;
        // The retry intent is consumed here and now: exactly one Execution becomes the failure's
        // successor, and a later attempt cannot inherit a relation it did not earn.
        const taskUpdate = database.query(`
          UPDATE tasks SET state='RUNNING',version=?1,updated_at=?2,pending_retry_from_execution_id=NULL
          WHERE id=?3 AND project_id=?4 AND version=?5 AND state='READY'
        `).run(taskVersion, input.createdAt, input.taskId, input.projectId, input.expectedTaskVersion);
        if (taskUpdate.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during Execution reservation');
        }
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ExecutionReserved',1,'Execution',?3,0,?4,?4,?5,?6)
        `).run(input.reservationEventId, input.projectId, input.executionId, input.commandId,
          input.createdAt, JSON.stringify({ executionId: input.executionId, taskId: input.taskId,
            revisionId: subject.revision_id, workspaceId: input.workspaceId,
            ...(input.resumeFromExecutionId === undefined
              ? {} : { resumeFromExecutionId: input.resumeFromExecutionId }),
            ...(subject.pending_retry_from_execution_id === null
              ? {} : { retryFromExecutionId: subject.pending_retry_from_execution_id }) }));
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
        `).run(input.taskEventId, input.projectId, input.taskId, taskVersion,
          input.commandId, input.reservationEventId, input.createdAt,
          JSON.stringify({ taskId: input.taskId, from: 'READY', to: 'RUNNING',
            reason: 'execution reserved', actor: input.actor }));
        return {
          executionId: input.executionId,
          taskId: input.taskId,
          taskVersion,
          attemptNumber: attempt.number,
          revisionId: subject.revision_id,
          workspaceId: input.workspaceId,
          workspacePath: subject.workspace_path,
          ownershipToken: subject.ownership_token,
          baseCommit: subject.base_commit,
          adapterId: input.adapterId,
          adapterVersion: input.adapterVersion,
          state: 'CREATED' as const,
        };
      },
    });
  }

  submitTask(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly eventId: string;
    readonly actor: string;
    readonly submittedAt: number;
  }): Readonly<{ taskId: string; state: 'READY'; version: number }> {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.submittedAt,
      apply: (database) => {
        const task = database.query<{
          id: string; state: TaskLifecycleState; version: number;
        }, [string, string]>(`
          SELECT t.id,t.state,t.version FROM tasks t
          JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
          WHERE t.project_id=?1 AND t.id=?2
        `).get(input.projectId, input.taskId);
        if (task === null) throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
        if (task.version !== input.expectedVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
        }
        if (task.state !== 'DRAFT') {
          throw new StorageError('INVALID_STATE', `Task cannot be submitted from ${task.state}`);
        }
        const version = input.expectedVersion + 1;
        const update = database.query(`
          UPDATE tasks SET state='READY',version=?1,updated_at=?2
          WHERE project_id=?3 AND id=?4 AND version=?5 AND state='DRAFT'
        `).run(version, input.submittedAt, input.projectId, input.taskId, input.expectedVersion);
        if (update.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during submit');
        }
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?5,?6,?7)
        `).run(input.eventId, input.projectId, input.taskId, version, input.commandId,
          input.submittedAt,
          JSON.stringify({ taskId: input.taskId, from: 'DRAFT', to: 'READY', reason: 'submitted', actor: input.actor }));
        return { taskId: input.taskId, state: 'READY' as const, version };
      },
    });
  }

  /**
   * Soft-delete: sets `archived_at` only. Every Task/Revision/Execution/Session/event row and the
   * owned worktree/branch stay untouched; `unarchiveTask` is the exact inverse.
   */
  archiveTask(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly eventId: string;
    readonly actor: string;
    readonly archivedAt: number;
  }): Readonly<{ taskId: string; state: TaskLifecycleState; version: number; archived: boolean }> {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.archivedAt,
      apply: (database) => this.setTaskArchived(database, { ...input, archived: true }),
    });
  }

  unarchiveTask(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly eventId: string;
    readonly actor: string;
    readonly unarchivedAt: number;
  }): Readonly<{ taskId: string; state: TaskLifecycleState; version: number; archived: boolean }> {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.unarchivedAt,
      apply: (database) => this.setTaskArchived(database, { ...input, archivedAt: input.unarchivedAt,
        archived: false }),
    });
  }

  private setTaskArchived(database: Database, input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly eventId: string;
    readonly actor: string;
    readonly archivedAt: number;
    readonly archived: boolean;
  }): Readonly<{ taskId: string; state: TaskLifecycleState; version: number; archived: boolean }> {
    const task = database.query<{
      state: TaskLifecycleState; version: number; archived_at: number | null;
    }, [string, string]>(`
      SELECT t.state,t.version,t.archived_at FROM tasks t
      JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
      WHERE t.project_id=?1 AND t.id=?2
    `).get(input.projectId, input.taskId);
    if (task === null) throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
    // Idempotent on replay: archiving an archived Task (or unarchiving a live one) succeeds without
    // a second version bump, so a retried command never rewrites already-true state.
    const already = input.archived ? task.archived_at !== null : task.archived_at === null;
    if (already) {
      return { taskId: input.taskId, state: task.state, version: task.version, archived: input.archived };
    }
    if (task.version !== input.expectedVersion) {
      throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
    }
    if (input.archived && ACTIVE_TASK_STATES.has(task.state)) {
      throw new StorageError('INVALID_STATE',
        `Task cannot be archived while it is ${task.state}; cancel it first`);
    }
    const version = task.version + 1;
    const update = database.query(`
      UPDATE tasks SET archived_at=?1,version=?2,updated_at=?3
      WHERE project_id=?4 AND id=?5 AND version=?6
    `).run(input.archived ? input.archivedAt : null, version, input.archivedAt,
      input.projectId, input.taskId, input.expectedVersion);
    if (update.changes !== 1) {
      throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during archive');
    }
    database.query(`
      INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
        aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
      VALUES (?1,?2,?3,1,'Task',?4,?5,?6,?6,?7,?8)
    `).run(input.eventId, input.projectId, input.archived ? 'TaskArchived' : 'TaskUnarchived',
      input.taskId, version, input.actor, input.archivedAt,
      JSON.stringify({ taskId: input.taskId, from: task.state, to: task.state,
        reason: input.archived ? 'archived' : 'unarchived', actor: input.actor }));
    return { taskId: input.taskId, state: task.state, version, archived: input.archived };
  }

  /**
   * The read-only half of `task.purge` (ADR-0058): who would be deleted, and whether anything in the
   * repository's history forbids it.
   *
   * It is separated from {@link purgeTask} because the irreversible Git side effects (removing the
   * owned worktrees and branches) must be decided *before* the database transaction opens, and a
   * refusal must therefore be knowable without having touched anything. `purgeTask` re-runs both
   * checks inside its transaction, so a race cannot turn this pre-flight answer into the decision.
   */
  inspectTaskPurge(input: {
    readonly projectId: string;
    readonly taskId: string;
  }): TaskPurgeSubject | null {
    const row = this.sqlite.query<{
      id: string; display_number: number; state: TaskLifecycleState; version: number;
      archived_at: number | null; current_revision_id: string;
    }, [string, string]>(`
      SELECT t.id,t.display_number,t.state,t.version,t.archived_at,t.current_revision_id
      FROM tasks t
      JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
      WHERE t.project_id=?1 AND t.id=?2
    `).get(input.projectId, input.taskId);
    if (row === null) return null;
    const revisions = this.sqlite.query<{ count: number }, [string]>(
      'SELECT COUNT(*) AS count FROM task_revisions WHERE task_id=?1').get(input.taskId);
    const executions = this.sqlite.query<{ count: number }, [string]>(
      'SELECT COUNT(*) AS count FROM executions WHERE task_id=?1').get(input.taskId);
    return {
      taskId: row.id,
      displayNumber: row.display_number,
      state: row.state,
      version: row.version,
      archived: row.archived_at !== null,
      currentRevisionId: row.current_revision_id,
      revisionCount: revisions?.count ?? 0,
      executionCount: executions?.count ?? 0,
    };
  }

  /**
   * Why this Task may not be purged, as facts rather than a guess. Both reasons are about history
   * that lives outside the Task: a commit this Task put into `dev` (or into a stable promotion)
   * outlives it, and deleting the Task would leave that commit in the ref with nothing naming where
   * it came from. Archiving keeps every row and is the answer for those Tasks.
   */
  inspectTaskPurgeBlockers(input: {
    readonly projectId: string;
    readonly taskId: string;
  }): readonly TaskPurgeBlocker[] {
    const blockers: TaskPurgeBlocker[] = [];
    const batchItems = this.countTaskRows('integration_batch_items', input.taskId);
    const batchVerifications = this.countTaskRows('integration_verification_runs', input.taskId);
    if (batchItems > 0 || batchVerifications > 0) {
      blockers.push({
        code: 'TASK_INTEGRATED_INTO_DEV',
        detail: `the Task is a member of ${batchItems} integration batch item(s) and`
          + ` ${batchVerifications} integration verification run(s)`,
        count: batchItems + batchVerifications,
      });
    }
    const promotionMembers = this.countTaskRows('stable_promotion_members', input.taskId);
    if (promotionMembers > 0) {
      blockers.push({
        code: 'TASK_IN_STABLE_PROMOTION',
        detail: `the Task is a member of ${promotionMembers} stable promotion record(s)`,
        count: promotionMembers,
      });
    }
    return blockers;
  }

  private countTaskRows(table: string, taskId: string): number {
    // The table name is never user text: the only callers pass string literals from this file.
    const row = this.sqlite.query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE task_id=?1`).get(taskId);
    return row?.count ?? 0;
  }

  /**
   * Permanent deletion of one Task (ADR-0058).
   *
   * Everything this Task owns is deleted in one transaction — revisions, Executions, Sessions,
   * terminals, guidance, Attention, verification runs, impact snapshots and their paired
   * assessments, slot reservations, reclamation records and the Task row itself — and the deletion is
   * recorded as a `TaskPurged` domain event before the transaction commits.
   *
   * Three deliberate exceptions to the usual rules are stated here instead of being implied:
   *
   *  - **The append-only `no_delete` triggers are suspended for this command only.** `task_revisions`,
   *    `impact_snapshots`, `impact_assessments`, `targeted_test_plans` and
   *    `execution_knowledge_snapshots` can be deleted by a purge and by nothing else. Their trigger SQL
   *    is read from `sqlite_master`, dropped, and re-created verbatim inside the same transaction, so
   *    a rollback restores them and a failure to restore aborts the whole command.
   *  - **`domain_events` are kept.** The Task's own history stays readable: a purge removes rows the
   *    Runtime owns, not the record of what happened. `command_receipts`, `operations` and `intents`
   *    are project-scoped audit and are likewise kept; `intent_targets` (which references the Task) is
   *    deleted.
   *  - **Foreign keys are checked, not disabled.** `PRAGMA defer_foreign_keys=ON` moves every check to
   *    commit time, which is what makes "delete the whole subgraph in any order" safe while still
   *    refusing a deletion that would leave a dangling reference.
   */
  /**
   * The purge one command already performed, so a replayed `task.purge` reaches its own receipt
   * instead of being refused with `NOT_FOUND` — the Task it names no longer exists, which is exactly
   * what makes the ordinary pre-flight check useless for a replay.
   */
  findTaskPurgeByCommand(input: {
    readonly projectId: string;
    readonly commandId: string;
    readonly taskId: string;
    readonly payloadHash: string;
  }): TaskPurgeResult | null {
    const receipt = this.sqlite.query<{ payload_hash: string; result_json: string }, [string, string]>(
      'SELECT payload_hash,result_json FROM command_receipts WHERE project_id=?1 AND command_id=?2')
      .get(input.projectId, input.commandId);
    if (receipt === null) return null;
    if (receipt.payload_hash !== input.payloadHash) {
      throw new StorageError('COMMAND_CONFLICT',
        'Command ID was already used with a different payload');
    }
    const recorded = JSON.parse(receipt.result_json) as Partial<TaskPurgeResult>;
    // The receipt has to be the purge it claims to be: a same-hash replay of some *other* command
    // that was given this ID is a conflict here, never a silent `NOT_FOUND` that would hide it.
    if (recorded.taskId !== input.taskId || recorded.purgedAt === undefined
      || recorded.rowsDeleted === undefined) {
      throw new StorageError('COMMAND_CONFLICT', 'Command receipt does not describe a Task purge');
    }
    return recorded as TaskPurgeResult;
  }

  purgeTask(input: TaskPurgeInput): TaskPurgeResult {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.purgedAt,
      apply: (database) => this.applyTaskPurge(database, input),
    });
  }

  private applyTaskPurge(database: Database, input: TaskPurgeInput): TaskPurgeResult {
    const row = database.query<{
      id: string; display_number: number; state: TaskLifecycleState; version: number;
      archived_at: number | null; current_revision_id: string;
    }, [string, string]>(`
      SELECT t.id,t.display_number,t.state,t.version,t.archived_at,t.current_revision_id
      FROM tasks t
      JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
      WHERE t.project_id=?1 AND t.id=?2
    `).get(input.projectId, input.taskId);
    if (row === null) {
      throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
    }
    if (row.version !== input.expectedVersion) {
      throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
    }
    // Re-checked in the transaction: the caller's pre-flight answer is evidence, not the decision.
    const blockers = this.inspectTaskPurgeBlockers({
      projectId: input.projectId, taskId: input.taskId,
    });
    if (blockers.length > 0) {
      const first = blockers[0] as TaskPurgeBlocker;
      throw new StorageError(first.code, `Task cannot be purged: ${first.detail}`);
    }

    // Every check that follows happens with the checks deferred to commit; nothing is written yet.
    database.exec('PRAGMA defer_foreign_keys=ON');
    const suspended = this.suspendAppendOnlyTriggers(database);
    const rowsDeleted: Record<string, number> = {};
    for (const [table, statement] of taskPurgeDeletions()) {
      const result = database.query(statement).run(input.taskId);
      if (result.changes > 0) rowsDeleted[table] = result.changes;
    }
    this.restoreAppendOnlyTriggers(database, suspended);

    const removed = database.query(
      'DELETE FROM tasks WHERE id=?1 AND project_id=?2').run(input.taskId, input.projectId);
    if (removed.changes !== 1) {
      throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during purge');
    }
    rowsDeleted['tasks'] = 1;

    const aggregateVersion = row.version + 1;
    insertDomainEvent(database, {
      eventId: input.eventId,
      projectId: input.projectId,
      eventType: 'TaskPurged',
      aggregateType: 'Task',
      aggregateId: input.taskId,
      aggregateVersion,
      correlationId: input.actor,
      causationId: input.actor,
      occurredAt: input.purgedAt,
      payload: {
        taskId: input.taskId,
        displayNumber: row.display_number,
        from: row.state,
        to: 'PURGED',
        actor: input.actor,
        reason: input.reason,
        archived: row.archived_at !== null,
        currentRevisionId: row.current_revision_id,
        rowsDeleted,
        dependencyEdgesRemoved: rowsDeleted['task_dependencies'] ?? 0,
        branchFacts: input.branches,
        reclamation: input.reclamation,
        appendOnlyTriggersSuspended: suspended.map((trigger) => trigger.name),
      },
    });

    return {
      projectId: input.projectId,
      taskId: input.taskId,
      displayNumber: row.display_number,
      state: row.state,
      version: row.version,
      archived: row.archived_at !== null,
      reason: input.reason,
      purgedAt: input.purgedAt,
      eventId: input.eventId,
      currentRevisionId: row.current_revision_id,
      branchFacts: input.branches,
      reclamation: input.reclamation,
      dependencyEdgesRemoved: rowsDeleted['task_dependencies'] ?? 0,
      rowsDeleted,
      detail: `Task #${row.display_number} (${row.state}) and every row it owned were deleted`,
    };
  }

  /**
   * Takes the append-only delete guards down for the duration of one purge transaction. The SQL is
   * read back from `sqlite_master` rather than hard-coded, so a trigger whose definition was widened
   * by a later migration is restored exactly as it was found.
   */
  private suspendAppendOnlyTriggers(database: Database): readonly { name: string; sql: string }[] {
    const tables = appendOnlyTaskTables.map((table) => `'${table}'`).join(',');
    const triggers = database.query<{ name: string; sql: string }, []>(`
      SELECT name,sql FROM sqlite_master
      WHERE type='trigger' AND tbl_name IN (${tables}) AND name LIKE '%no_delete'
    `).all();
    // A guard this command never suspends is a guard it can never break: the expected set is fixed,
    // so a missing trigger is a refusal rather than a silent append-only bypass.
    const missing = appendOnlyTaskTables.filter((table) =>
      !triggers.some((trigger) => trigger.name === `${table}_no_delete`));
    if (missing.length > 0) {
      throw new StorageError('INVALID_STATE',
        `Append-only guard missing for ${missing.join(', ')}; refusing to purge`);
    }
    for (const trigger of triggers) database.exec(`DROP TRIGGER ${trigger.name}`);
    return triggers;
  }

  private restoreAppendOnlyTriggers(
    database: Database,
    suspended: readonly { name: string; sql: string }[],
  ): void {
    for (const trigger of suspended) database.exec(trigger.sql);
    const restored = database.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger'
      AND name IN (${suspended.map((trigger) => `'${trigger.name}'`).join(',')})
    `).get();
    if ((restored?.count ?? 0) !== suspended.length) {
      throw new StorageError('INVALID_STATE',
        'Append-only guards could not be restored; the purge was rolled back');
    }
  }

  /**
   * Records a user stop request. `PAUSE` is only meaningful for a running Agent; `CANCEL` also
   * terminalizes a Task that holds no provider process. The caller must then confirm quiescence
   * through `confirmTaskStopped` or record uncertainty through `markTaskStopUncertain`.
   */
  requestTaskStop(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly kind: 'PAUSE' | 'CANCEL';
    readonly commandId: string;
    readonly payloadHash: string;
    readonly taskEventId: string;
    readonly executionEventId: string;
    readonly actor: string;
    readonly requestedAt: number;
  }): TaskStopRequest {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.requestedAt,
      apply: (database) => {
        const task = database.query<{ state: TaskLifecycleState; version: number }, [string, string]>(`
          SELECT t.state,t.version FROM tasks t
          JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
          WHERE t.project_id=?1 AND t.id=?2
        `).get(input.projectId, input.taskId);
        if (task === null) throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
        if (task.version !== input.expectedVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
        }
        // A repeat of a stop that already reached its terminal state is a no-op, so a caller does
        // not have to guess whether the first request landed.
        if (input.kind === 'CANCEL' && task.state === 'CANCELLED') {
          return { taskId: input.taskId, state: 'CANCELLED', version: task.version,
            executionId: null, sessionId: null, terminal: true };
        }
        if (input.kind === 'PAUSE' && task.state === 'PAUSED') {
          return { taskId: input.taskId, state: 'PAUSED', version: task.version,
            executionId: null, sessionId: null, terminal: false };
        }
        const held = database.query<{
          execution_id: string; execution_state: ExecutionLifecycleState; session_id: string | null;
        }, [string]>(`
          SELECT execution.id AS execution_id,execution.state AS execution_state,session.id AS session_id
          FROM executions execution LEFT JOIN agent_sessions session ON session.execution_id=execution.id
          WHERE execution.task_id=?1 AND execution.resource_held=1
        `).get(input.taskId) ?? null;

        const toCancelling = input.kind === 'CANCEL'
          && ['RUNNING', 'WAITING_FOR_USER', 'PAUSING'].includes(task.state);
        const toPausing = input.kind === 'PAUSE'
          && ['RUNNING', 'WAITING_FOR_USER'].includes(task.state);
        const toCancelled = input.kind === 'CANCEL'
          && ['DRAFT', 'BLOCKED', 'READY', 'EXECUTED', 'FAILED', 'PAUSED'].includes(task.state);

        if (toCancelling || toPausing) {
          if (held === null) {
            throw new StorageError('INVALID_STATE',
              `Task is ${task.state} but holds no Execution to stop`);
          }
          const taskState = toPausing ? 'PAUSING' : 'CANCELLING';
          const stopReason = toPausing ? 'USER_PAUSE' : 'USER_CANCEL';
          const version = task.version + 1;
          const taskUpdate = database.query(`
            UPDATE tasks SET state=?1,version=?2,updated_at=?3
            WHERE project_id=?4 AND id=?5 AND version=?6 AND state=?7
          `).run(taskState, version, input.requestedAt, input.projectId, input.taskId,
            input.expectedVersion, task.state);
          if (taskUpdate.changes !== 1) {
            throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during stop request');
          }
          const executionUpdate = database.query(`
            UPDATE executions SET state='STOPPING',stop_reason=?1,version=version+1
            WHERE id=?2 AND state IN ('CREATED','PREPARING','STARTING','RUNNING',
              'WAITING_FOR_USER','PAUSING','PAUSED','STOPPING')
          `).run(stopReason, held.execution_id);
          if (executionUpdate.changes !== 1) {
            throw new StorageError('CONCURRENT_MODIFICATION', 'Execution changed during stop request');
          }
          database.query(`
            INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
              aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
            VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?5,?6,?7)
          `).run(input.taskEventId, input.projectId, input.taskId, version, input.commandId,
            input.requestedAt, JSON.stringify({ taskId: input.taskId, from: task.state, to: taskState,
              reason: toPausing ? 'pause requested' : 'cancel requested', actor: input.actor }));
          database.query(`
            INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
              aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
            VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?6,?7,?8)
          `).run(input.executionEventId, input.projectId, held.execution_id, 0, input.commandId,
            input.taskEventId, input.requestedAt,
            JSON.stringify({ executionId: held.execution_id, from: held.execution_state,
              to: 'STOPPING', stopReason }));
          return { taskId: input.taskId, state: taskState as TaskLifecycleState, version,
            executionId: held.execution_id, sessionId: held.session_id, terminal: false };
        }

        if (toCancelled) {
          if (held !== null) {
            throw new StorageError('INVALID_STATE',
              `Task is ${task.state} but still holds a live Execution`);
          }
          const version = task.version + 1;
          const taskUpdate = database.query(`
            UPDATE tasks SET state='CANCELLED',version=?1,updated_at=?2
            WHERE project_id=?3 AND id=?4 AND version=?5 AND state=?6
          `).run(version, input.requestedAt, input.projectId, input.taskId,
            input.expectedVersion, task.state);
          if (taskUpdate.changes !== 1) {
            throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during cancel');
          }
          database.query(`
            INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
              aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
            VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?5,?6,?7)
          `).run(input.taskEventId, input.projectId, input.taskId, version, input.commandId,
            input.requestedAt, JSON.stringify({ taskId: input.taskId, from: task.state,
              to: 'CANCELLED', reason: 'cancelled', actor: input.actor }));
          return { taskId: input.taskId, state: 'CANCELLED', version, executionId: null,
            sessionId: null, terminal: true };
        }

        // Replaying the exact same command already produced the requested in-progress state.
        const expectedState = input.kind === 'PAUSE' ? 'PAUSING' : 'CANCELLING';
        if (task.state === expectedState) {
          return { taskId: input.taskId, state: task.state, version: task.version,
            executionId: held?.execution_id ?? null, sessionId: held?.session_id ?? null,
            terminal: false };
        }
        throw new StorageError('INVALID_STATE',
          `Task cannot be ${input.kind === 'PAUSE' ? 'paused' : 'cancelled'} from ${task.state}`);
      },
    });
  }

  /**
   * Confirms a stop after the Adapter proved the owned provider process exited. A pause ends in
   * `PAUSED`/`SUPERSEDED`; a cancel ends in `CANCELLED`/`CANCELLED`. The workspace is retained
   * in both cases: cancellation never implicitly cleans up Git resources.
   */
  confirmTaskStopped(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly kind: 'PAUSE' | 'CANCEL';
    readonly executionId: string | null;
    readonly sessionId: string | null;
    readonly evidenceRef: string;
    readonly taskEventId: string;
    readonly executionEventId: string;
    readonly sessionEventId: string;
    readonly stoppedAt: number;
  }): Readonly<{ taskId: string; state: TaskLifecycleState; version: number }> {
    return this.sqlite.transaction(() => {
      const task = this.sqlite.query<{
        state: TaskLifecycleState; version: number;
      }, [string, string]>(`
        SELECT t.state,t.version FROM tasks t
        JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
        WHERE t.project_id=?1 AND t.id=?2
      `).get(input.projectId, input.taskId);
      if (task === null) throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
      const target: TaskLifecycleState = input.kind === 'PAUSE' ? 'PAUSED' : 'CANCELLED';
      const from = input.kind === 'PAUSE' ? 'PAUSING' : 'CANCELLING';
      if (task.state === target) {
        return { taskId: input.taskId, state: task.state, version: task.version };
      }
      if (task.state !== from) {
        throw new StorageError('INVALID_STATE',
          `Stop confirmation requires ${from}, got ${task.state}`);
      }
      const version = task.version + 1;
      const taskUpdate = this.sqlite.query(`
        UPDATE tasks SET state=?1,version=?2,updated_at=?3
        WHERE project_id=?4 AND id=?5 AND version=?6 AND state=?7
      `).run(target, version, input.stoppedAt, input.projectId, input.taskId,
        task.version, from);
      if (taskUpdate.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during stop confirmation');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?5,?6,?7)
      `).run(input.taskEventId, input.projectId, input.taskId, version, input.evidenceRef,
        input.stoppedAt, JSON.stringify({ taskId: input.taskId, from, to: target,
          reason: input.kind === 'PAUSE' ? 'paused' : 'cancelled', evidenceRef: input.evidenceRef }));

      if (input.executionId !== null) {
        const executionTarget = input.kind === 'PAUSE' ? 'SUPERSEDED' : 'CANCELLED';
        const execution = this.sqlite.query<{ state: ExecutionLifecycleState; version: number }, [string, string]>(`
          SELECT state,version FROM executions WHERE id=?1 AND task_id=?2
        `).get(input.executionId, input.taskId);
        if (execution === null) {
          throw new StorageError('NOT_FOUND', 'Execution to stop was not found');
        }
        if (execution.state !== executionTarget) {
          const update = this.sqlite.query(`
            UPDATE executions SET state=?1,resource_held=0,version=version+1,ended_at=?2
            WHERE id=?3 AND state='STOPPING'
          `).run(executionTarget, input.stoppedAt, input.executionId);
          if (update.changes !== 1) {
            throw new StorageError('CONCURRENT_MODIFICATION', 'Execution changed during stop confirmation');
          }
          this.sqlite.query(`
            INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
              aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
            VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?6,?7,?8)
          `).run(input.executionEventId, input.projectId, input.executionId, execution.version + 1,
            input.evidenceRef, input.taskEventId, input.stoppedAt,
            JSON.stringify({ executionId: input.executionId, from: 'STOPPING', to: executionTarget,
              stopReason: input.kind === 'PAUSE' ? 'USER_PAUSE' : 'USER_CANCEL',
              evidenceRef: input.evidenceRef }));
        }
        this.sqlite.query<unknown, [string]>(
          "UPDATE workspaces SET state='RETAINED' WHERE task_id=?1 AND state='IN_USE'",
        ).run(input.taskId);
      }

      if (input.sessionId !== null) {
        const session = this.sqlite.query<{ state: AgentSessionLifecycleState; version: number }, [string]>(`
          SELECT state,version FROM agent_sessions WHERE id=?1
        `).get(input.sessionId);
        if (session !== null && session.state !== 'EXITED') {
          const update = this.sqlite.query(`
            UPDATE agent_sessions SET state='EXITED',version=version+1,last_observed_at=?1,exit_json=?2
            WHERE id=?3 AND state IN ('CREATED','STARTING','ACTIVE','WAITING_FOR_USER',
              'PAUSING','PAUSED','STOPPING')
          `).run(input.stoppedAt, JSON.stringify({ reason: 'runtime-initiated stop',
            kind: input.kind, evidenceRef: input.evidenceRef }), input.sessionId);
          if (update.changes === 1) {
            this.sqlite.query(`
              INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
                aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
              VALUES (?1,?2,'AgentSessionStateChanged',1,'AgentSession',?3,?4,?5,?6,?7,?8)
            `).run(input.sessionEventId, input.projectId, input.sessionId, session.version + 1,
              input.evidenceRef, input.executionEventId, input.stoppedAt,
              JSON.stringify({ sessionId: input.sessionId, from: session.state, to: 'EXITED',
                reason: 'runtime-initiated stop', evidenceRef: input.evidenceRef }));
          }
        }
      }
      return { taskId: input.taskId, state: target, version };
    })();
  }

  /** The stop could not be proven: keep every resource and require an audited reconcile. */
  markTaskStopUncertain(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly executionId: string | null;
    readonly sessionId: string | null;
    readonly evidenceRef: string;
    readonly taskEventId: string;
    readonly executionEventId: string;
    readonly sessionEventId: string;
    readonly recoveredAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const task = this.sqlite.query<{ state: TaskLifecycleState; version: number }, [string, string]>(`
        SELECT t.state,t.version FROM tasks t
        JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
        WHERE t.project_id=?1 AND t.id=?2
      `).get(input.projectId, input.taskId);
      if (task === null) throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
      if (!['PAUSING', 'CANCELLING'].includes(task.state)) {
        throw new StorageError('INVALID_STATE',
          `Uncertain stop requires PAUSING/CANCELLING, got ${task.state}`);
      }
      const version = task.version + 1;
      const taskUpdate = this.sqlite.query(`
        UPDATE tasks SET state='RECOVERY_REQUIRED',version=?1,updated_at=?2
        WHERE project_id=?3 AND id=?4 AND version=?5
      `).run(version, input.recoveredAt, input.projectId, input.taskId, task.version);
      if (taskUpdate.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during uncertain stop');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'RecoveryRequired',1,'Task',?3,?4,?5,?5,?6,?7)
      `).run(input.taskEventId, input.projectId, input.taskId, version, input.evidenceRef,
        input.recoveredAt, JSON.stringify({ taskId: input.taskId, from: task.state,
          to: 'RECOVERY_REQUIRED', reason: 'provider stop could not be confirmed',
          evidenceRef: input.evidenceRef }));
      if (input.executionId !== null) {
        const execution = this.sqlite.query<{ version: number }, [string]>(`
          SELECT version FROM executions WHERE id=?1
        `).get(input.executionId);
        this.sqlite.query(`
          UPDATE executions SET state='RECOVERY_REQUIRED',version=version+1
          WHERE id=?1 AND state='STOPPING'
        `).run(input.executionId);
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?6,?7,?8)
        `).run(input.executionEventId, input.projectId, input.executionId,
          (execution?.version ?? 0) + 1, input.evidenceRef,
          input.taskEventId, input.recoveredAt,
          JSON.stringify({ executionId: input.executionId, from: 'STOPPING',
            to: 'RECOVERY_REQUIRED', reason: 'provider stop could not be confirmed',
            evidenceRef: input.evidenceRef }));
      }
      if (input.sessionId !== null) {
        const session = this.sqlite.query<{ state: AgentSessionLifecycleState; version: number }, [string]>(`
          SELECT state,version FROM agent_sessions WHERE id=?1
        `).get(input.sessionId);
        const update = this.sqlite.query(`
          UPDATE agent_sessions SET state='RECOVERY_REQUIRED',version=version+1
          WHERE id=?1 AND state IN ('CREATED','STARTING','ACTIVE','WAITING_FOR_USER','STOPPING')
        `).run(input.sessionId);
        if (session !== null && update.changes === 1) {
          this.sqlite.query(`
            INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
              aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
            VALUES (?1,?2,'AgentSessionStateChanged',1,'AgentSession',?3,?4,?5,?6,?7,?8)
          `).run(input.sessionEventId, input.projectId, input.sessionId, session.version + 1,
            input.evidenceRef, input.executionEventId, input.recoveredAt,
            JSON.stringify({ sessionId: input.sessionId, from: session.state,
              to: 'RECOVERY_REQUIRED', reason: 'provider stop could not be confirmed',
              evidenceRef: input.evidenceRef }));
        }
      }
    })();
  }

  /**
   * Moves a `PAUSED` Task back to `READY` in its retained workspace and identifies the paused
   * Execution whose provider conversation the next attempt continues.
   */
  resumeTask(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly taskEventId: string;
    readonly resumedAt: number;
  }): TaskResumeRequest {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.resumedAt,
      apply: (database) => {
        const task = database.query<{ state: TaskLifecycleState; version: number }, [string, string]>(`
          SELECT t.state,t.version FROM tasks t
          JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
          WHERE t.project_id=?1 AND t.id=?2
        `).get(input.projectId, input.taskId);
        if (task === null) throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
        if (task.state === 'READY' || task.state === 'RUNNING') {
          throw new StorageError('INVALID_STATE',
            `Task is already ${task.state}; only a PAUSED Task can resume`);
        }
        if (task.state !== 'PAUSED') {
          throw new StorageError('INVALID_STATE', `Task cannot be resumed from ${task.state}`);
        }
        if (task.version !== input.expectedVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
        }
        const workspace = database.query<{
          id: string; path: string; base_commit: string;
        }, [string]>(`
          SELECT id,path,base_commit FROM workspaces
          WHERE task_id=?1 AND state='RETAINED'
        `).get(input.taskId);
        if (workspace === null) {
          throw new StorageError('INVALID_STATE', 'Paused Task has no retained workspace to resume in');
        }
        const predecessor = database.query<{
          execution_id: string; session_id: string; session_storage_ref: string | null;
          provider_session_id: string | null;
        }, [string]>(`
          SELECT execution.id AS execution_id,session.id AS session_id,
            session.session_storage_ref,session.provider_session_id
          FROM executions execution
          JOIN agent_sessions session ON session.execution_id=execution.id
          WHERE execution.task_id=?1 AND execution.stop_reason='USER_PAUSE'
            AND execution.state='SUPERSEDED'
          ORDER BY execution.attempt_number DESC LIMIT 1
        `).get(input.taskId);
        if (predecessor === null || predecessor.session_storage_ref === null) {
          throw new StorageError('INVALID_STATE',
            'Paused Task has no recorded provider conversation to resume');
        }
        const version = task.version + 1;
        const taskUpdate = database.query(`
          UPDATE tasks SET state='READY',version=?1,updated_at=?2
          WHERE project_id=?3 AND id=?4 AND version=?5 AND state='PAUSED'
        `).run(version, input.resumedAt, input.projectId, input.taskId, input.expectedVersion);
        if (taskUpdate.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during resume');
        }
        database.query("UPDATE workspaces SET state='READY' WHERE id=?1 AND state='RETAINED'")
          .run(workspace.id);
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?5,?6,?7)
        `).run(input.taskEventId, input.projectId, input.taskId, version, input.commandId,
          input.resumedAt, JSON.stringify({ taskId: input.taskId, from: 'PAUSED', to: 'READY',
            reason: 'resumed', resumeFromExecutionId: predecessor.execution_id }));
        return {
          taskId: input.taskId,
          state: 'READY' as const,
          version,
          workspaceId: workspace.id,
          workspacePath: workspace.path,
          baseCommit: workspace.base_commit,
          resumeFromExecutionId: predecessor.execution_id,
          predecessorSessionId: predecessor.session_id,
          predecessorSessionStorageRef: predecessor.session_storage_ref,
          predecessorProviderSessionId: predecessor.provider_session_id,
        };
      },
    });
  }

  /** The READY workspace a resumed Execution reuses instead of preparing a second worktree. */
  findReusableWorkspace(taskId: string): {
    readonly workspaceId: string; readonly path: string; readonly branchRef: string;
    readonly baseCommit: string; readonly ownershipToken: string;
  } | null {
    const row = this.sqlite.query<{
      id: string; path: string; branch_ref: string; base_commit: string; ownership_token: string;
    }, [string]>(`
      SELECT id,path,branch_ref,base_commit,ownership_token FROM workspaces
      WHERE task_id=?1 AND state='READY' ORDER BY created_at DESC LIMIT 1
    `).get(taskId);
    return row === null ? null : {
      workspaceId: row.id,
      path: row.path,
      branchRef: row.branch_ref,
      baseCommit: row.base_commit,
      ownershipToken: row.ownership_token,
    };
  }

  /**
   * The most recent worktree recorded for one Task, in whatever state it was left (and even when it
   * was reclaimed, so the caller can tell "nothing here" from "reclaimed but its branch survived").
   * Used by the retry path to decide what to do with the Task's own worktree; it is a read, and the
   * ownership check is done against the real filesystem by the caller.
   */
  getLatestTaskWorkspace(taskId: string): TaskWorkspaceRecord | null {
    const row = this.sqlite.query<{
      id: string; task_id: string; path: string; branch_ref: string; ownership_token: string;
      base_commit: string; state: WorkspaceLifecycleState; created_at: number;
    }, [string]>(`
      SELECT id,task_id,path,branch_ref,ownership_token,base_commit,state,created_at FROM workspaces
      WHERE task_id=?1 ORDER BY created_at DESC,id DESC LIMIT 1
    `).get(taskId);
    return row === null ? null : {
      workspaceId: row.id,
      taskId: row.task_id,
      path: row.path,
      branchRef: row.branch_ref,
      ownershipToken: row.ownership_token,
      baseCommit: row.base_commit,
      state: row.state,
      createdAt: row.created_at,
    };
  }

  /**
   * Explicit retry of a `FAILED` Task (ADR-0036): the source state is re-checked inside this command
   * transaction, the Task is requeued (`READY`, or `BLOCKED` when the dependency verdict the caller
   * re-evaluated is unmet), and the intent — which failure this retry follows — is recorded on the
   * Task so the next Execution can name it. A worktree verified as this Task's own moves back to
   * `READY` in the same transaction, so the new Execution reuses it instead of preparing a second
   * one.
   *
   * The old Execution is not touched: its failure, error and evidence stay exactly as they were,
   * because a retry is a new attempt rather than a rewrite of the previous one.
   */
  retryTask(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly actor: string;
    readonly adapterId: string;
    readonly failedExecutionId: string;
    readonly target: 'READY' | 'BLOCKED';
    readonly dependencyReasons: readonly TaskDependencyBlockReason[];
    readonly workspace: {
      readonly mode: TaskRetryWorkspaceMode;
      readonly workspaceId: string | null;
      readonly evidence: string | null;
    };
    readonly taskEventId: string;
    readonly retryEventId: string;
    readonly requestedAt: number;
  }): TaskRetryRequest {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.requestedAt,
      apply: (database) => {
        const task = database.query<{
          state: TaskLifecycleState; version: number; archived_at: number | null;
        }, [string, string]>(`
          SELECT t.state,t.version,t.archived_at FROM tasks t
          JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
          WHERE t.project_id=?1 AND t.id=?2
        `).get(input.projectId, input.taskId);
        if (task === null) throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
        if (task.version !== input.expectedVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
        }
        // The eligibility decision belongs to the domain, but the last word is the atomic read: a
        // Task that moved between the caller's check and this transaction is refused, never retried.
        if (task.archived_at !== null) {
          throw new StorageError('INVALID_STATE', 'An archived Task is never retried');
        }
        if (task.state !== 'FAILED') {
          throw new StorageError('INVALID_STATE', `Task cannot be retried from ${task.state}`);
        }
        const failed = database.query<{
          attempt_number: number; state: ExecutionLifecycleState; adapter_id: string;
        }, [string, string]>(`
          SELECT attempt_number,state,adapter_id FROM executions WHERE id=?1 AND task_id=?2
        `).get(input.failedExecutionId, input.taskId);
        if (failed === null || failed.state !== 'FAILED') {
          throw new StorageError('INVALID_STATE',
            'A retry must name a FAILED Execution of this Task as the attempt it follows');
        }
        const newest = database.query<{ attempt_number: number | null }, [string]>(`
          SELECT MAX(attempt_number) AS attempt_number FROM executions WHERE task_id=?1
        `).get(input.taskId);
        if (newest?.attempt_number !== failed.attempt_number) {
          throw new StorageError('INVALID_STATE',
            `Execution attempt ${failed.attempt_number} is not the failure that ended this Task;`
            + ` attempt ${newest?.attempt_number ?? 0} is`);
        }
        if (input.target === 'BLOCKED' && input.dependencyReasons.length === 0) {
          throw new StorageError('INVALID_STATE',
            'A retry cannot requeue a Task as BLOCKED without naming the unmet dependency');
        }
        if (input.target === 'READY' && input.dependencyReasons.length > 0) {
          throw new StorageError('INVALID_STATE',
            'A retry cannot requeue a Task as READY while an unmet dependency is still named');
        }
        if (input.workspace.mode === 'REUSE_VERIFIED') {
          if (input.workspace.workspaceId === null) {
            throw new StorageError('INVALID_STATE',
              'A verified reuse must name the workspace it verified');
          }
          const reused = database.query(`
            UPDATE workspaces SET state='READY'
            WHERE id=?1 AND task_id=?2 AND state IN ('READY','RETAINED')
          `).run(input.workspace.workspaceId, input.taskId);
          if (reused.changes !== 1) {
            throw new StorageError('CONCURRENT_MODIFICATION',
              'The workspace changed before it could be reused by this retry');
          }
        }
        const version = task.version + 1;
        const taskUpdate = database.query(`
          UPDATE tasks SET state=?1,version=?2,updated_at=?3,pending_retry_from_execution_id=?4
          WHERE project_id=?5 AND id=?6 AND version=?7 AND state='FAILED'
        `).run(input.target, version, input.requestedAt, input.failedExecutionId,
          input.projectId, input.taskId, input.expectedVersion);
        if (taskUpdate.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during retry');
        }
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?5,?6,?7)
        `).run(input.taskEventId, input.projectId, input.taskId, version, input.commandId,
          input.requestedAt, JSON.stringify({ taskId: input.taskId, from: 'FAILED',
            to: input.target,
            reason: input.target === 'BLOCKED'
              ? 'explicit retry; dependencies are unmet' : 'explicit retry',
            retryFromExecutionId: input.failedExecutionId,
            dependencies: input.dependencyReasons, actor: input.actor }));
        // The retry's own audit record, append-only and separate from the state change it caused: it
        // answers "who retried which failure, on which Agent, and with which workspace decision".
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskRetryRequested',1,'Task',?3,?4,?5,?6,?7,?8)
        `).run(input.retryEventId, input.projectId, input.taskId, version, input.commandId,
          input.taskEventId, input.requestedAt, JSON.stringify({
            taskId: input.taskId, from: 'FAILED', to: input.target,
            failedExecutionId: input.failedExecutionId,
            failedAttemptNumber: failed.attempt_number,
            adapterId: input.adapterId,
            previousAdapterId: failed.adapter_id,
            adapterChanged: input.adapterId !== failed.adapter_id,
            workspaceMode: input.workspace.mode,
            workspaceId: input.workspace.workspaceId,
            workspaceEvidence: input.workspace.evidence,
            dependencies: input.dependencyReasons,
            actor: input.actor }));
        return {
          taskId: input.taskId,
          state: input.target,
          version,
          retryId: input.retryEventId,
          failedExecutionId: input.failedExecutionId,
          failedAttemptNumber: failed.attempt_number,
          adapterId: input.adapterId,
          previousAdapterId: failed.adapter_id,
          adapterChanged: input.adapterId !== failed.adapter_id,
          workspaceMode: input.workspace.mode,
          workspaceId: input.workspace.workspaceId,
          workspaceEvidence: input.workspace.evidence,
          dependencyReasons: input.dependencyReasons,
        };
      },
    });
  }

  /** Task, revision, repository facts and Execution attempts for verification decisions. */
  getVerificationCandidates(projectId: string, taskId: string): VerificationCandidates {
    const task = this.sqlite.query<{
      id: string; project_id: string; display_number: number; state: TaskLifecycleState;
      current_revision_id: string; repo_root: string; main_repo_root: string;
      git_common_dir: string; main_ref: string;
      object_format: 'sha1' | 'sha256';
    }, [string, string]>(`
      SELECT task.id,task.project_id,task.display_number,task.state,task.current_revision_id,
             COALESCE(p.dev_repo_path,p.repo_root) AS repo_root,p.repo_root AS main_repo_root,
             p.git_common_dir,p.main_ref,p.object_format
      FROM tasks task
      JOIN projects p ON p.id=task.project_id
      JOIN project_trusts trust ON trust.project_id=p.id AND trust.status='ACTIVE'
      WHERE task.project_id=?1 AND task.id=?2
    `).get(projectId, taskId);
    if (task === null) {
      throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
    }
    const executions = this.sqlite.query<{
      id: string; attempt_number: number; state: ExecutionLifecycleState;
      applied_revision_id: string; result_commit: string | null; base_commit: string;
    }, [string]>(`
      SELECT id,attempt_number,state,applied_revision_id,result_commit,base_commit
      FROM executions WHERE task_id=?1 ORDER BY attempt_number DESC
    `).all(taskId).map((row) => ({
      executionId: row.id,
      attemptNumber: row.attempt_number,
      state: row.state,
      appliedRevisionId: row.applied_revision_id,
      resultCommit: row.result_commit,
      baseCommit: row.base_commit,
    }));
    return {
      projectId: task.project_id,
      taskId: task.id,
      taskDisplayNumber: task.display_number,
      taskState: task.state,
      currentRevisionId: task.current_revision_id,
      repositoryRoot: task.repo_root,
      mainRepositoryRoot: task.main_repo_root,
      gitCommonDir: task.git_common_dir,
      mainRef: task.main_ref,
      objectFormat: task.object_format,
      executions,
    };
  }

  /**
   * Records one verification run as QUEUED together with its Operation and command receipt.
   * Replaying the same command returns the recorded run instead of queuing a second one; a
   * different payload under the same command ID is rejected.
   */
  beginVerificationRun(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly executionId: string;
    readonly revisionId: string;
    readonly testedCommit: string;
    readonly testedTree: string;
    readonly policyVersion: string;
    readonly policyDigest: string;
    /** Which record defined the commands; recorded as a fact, never derived from the digest. */
    readonly policySource?: VerificationPolicySource;
    readonly planId?: string | null;
    readonly planVersion?: string | null;
    readonly planDigest?: string | null;
    readonly mainCommit: string;
    readonly commands: readonly StoredVerificationCommand[];
    readonly copyPath: string;
    readonly verificationId: string;
    readonly operationId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly queuedAt: number;
  }): Readonly<{ plan: VerificationRunPlan; created: boolean }> {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<{ payload_hash: string; result_json: string }, [string, string]>(
        'SELECT payload_hash,result_json FROM command_receipts WHERE project_id=?1 AND command_id=?2',
      ).get(input.projectId, input.commandId);
      if (existing !== null) {
        if (existing.payload_hash !== input.payloadHash) {
          throw new StorageError('COMMAND_CONFLICT',
            'Command ID was already used with a different payload');
        }
        const recorded = JSON.parse(existing.result_json) as { verificationId: string };
        return { plan: this.verificationRunPlan(recorded.verificationId), created: false };
      }
      const task = this.sqlite.query<{ state: TaskLifecycleState; current_revision_id: string }, [string, string]>(
        `SELECT t.state,t.current_revision_id FROM tasks t
         JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
         WHERE t.project_id=?1 AND t.id=?2`,
      ).get(input.projectId, input.taskId);
      if (task === null) {
        throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
      }
      if (task.state !== 'EXECUTED') {
        throw new StorageError('INVALID_STATE',
          `Task is ${task.state}; verification needs an EXECUTED Task with a captured result commit`);
      }
      if (task.current_revision_id !== input.revisionId) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Task revision changed before verification was queued');
      }
      const execution = this.sqlite.query<{
        state: ExecutionLifecycleState; applied_revision_id: string; result_commit: string | null;
      }, [string, string]>(`
        SELECT state,applied_revision_id,result_commit FROM executions WHERE task_id=?1 AND id=?2
      `).get(input.taskId, input.executionId);
      if (execution === null) {
        throw new StorageError('NOT_FOUND', 'Execution was not found for this Task');
      }
      if (execution.state !== 'SUCCEEDED' || execution.result_commit !== input.testedCommit
        || execution.applied_revision_id !== input.revisionId) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Execution evidence changed before verification was queued');
      }
      this.sqlite.query(`
        INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,request_json,
          created_at,updated_at)
        VALUES (?1,?2,'RUN_TASK_VERIFICATION',?3,?4,'PLANNED',?5,?6,?6)
      `).run(input.operationId, input.projectId, input.verificationId, input.commandId,
        JSON.stringify({ verificationId: input.verificationId, taskId: input.taskId,
          executionId: input.executionId, testedCommit: input.testedCommit,
          policyDigest: input.policyDigest }), input.queuedAt);
      this.sqlite.query(`
        INSERT INTO verification_runs(id,project_id,task_id,execution_id,revision_id,operation_id,
          command_id,tested_commit,tested_tree,policy_version,policy_digest,main_commit,commands_json,
          copy_path,state,queued_at,policy_source,plan_id,plan_version,plan_digest)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'QUEUED',?15,?16,?17,?18,?19)
      `).run(input.verificationId, input.projectId, input.taskId, input.executionId, input.revisionId,
        input.operationId, input.commandId, input.testedCommit, input.testedTree, input.policyVersion,
        input.policyDigest, input.mainCommit, JSON.stringify(input.commands), input.copyPath,
        input.queuedAt, input.policySource ?? 'PROJECT_POLICY', input.planId ?? null,
        input.planVersion ?? null, input.planDigest ?? null);
      this.sqlite.query(`
        INSERT INTO command_receipts(project_id,command_id,payload_hash,result_json,created_at)
        VALUES (?1,?2,?3,?4,?5)
      `).run(input.projectId, input.commandId, input.payloadHash,
        JSON.stringify({ verificationId: input.verificationId }), input.queuedAt);
      return { plan: this.verificationRunPlan(input.verificationId), created: true };
    })();
  }

  /** QUEUED → RUNNING with its Operation IN_PROGRESS, before any command is spawned. */
  startVerificationRun(input: {
    readonly verificationId: string;
    readonly startedAt: number;
  }): VerificationRunPlan {
    return this.sqlite.transaction(() => {
      const run = this.verificationRunPlan(input.verificationId);
      if (run.state !== 'QUEUED') return run;
      const updated = this.sqlite.query(`
        UPDATE verification_runs SET state='RUNNING',started_at=?1
        WHERE id=?2 AND state='QUEUED'
      `).run(input.startedAt, input.verificationId);
      const operation = this.sqlite.query(`
        UPDATE operations SET state='IN_PROGRESS',updated_at=?1 WHERE id=?2 AND state='PLANNED'
      `).run(input.startedAt, run.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Verification run changed while starting');
      }
      return this.verificationRunPlan(input.verificationId);
    })();
  }

  /**
   * Records the terminal state, its non-secret evidence, the `VerificationCompleted` event, and the
   * `OperationSettled` progress event of the Operation that owns this run. `CANCELLED` is a terminal
   * state of its own, so a stopped run keeps its judgement distinct from a failed command; the
   * Operation keeps the ADR-0019 vocabulary (`FAILED` + `cancelled: true`) because a user stop is
   * not a success.
   */
  completeVerificationRun(input: {
    readonly verificationId: string;
    readonly state: 'PASSED' | 'FAILED' | 'ERROR' | 'CANCELLED';
    readonly outcomeCode: string;
    readonly evidence: VerificationEvidence;
    readonly eventId: string;
    readonly completedAt: number;
  }): VerificationRunPlan {
    return this.sqlite.transaction(() => {
      const run = this.verificationRunPlan(input.verificationId);
      if (run.state !== 'QUEUED' && run.state !== 'RUNNING') return run;
      const updated = this.sqlite.query(`
        UPDATE verification_runs SET state=?1,outcome_code=?2,evidence_json=?3,ended_at=?4
        WHERE id=?5 AND state IN ('QUEUED','RUNNING')
      `).run(input.state, input.outcomeCode, JSON.stringify(input.evidence),
        input.completedAt, input.verificationId);
      const operationState = input.state === 'PASSED' ? 'SUCCEEDED' : 'FAILED';
      const operationResult = { verificationId: input.verificationId,
        state: input.state, outcomeCode: input.outcomeCode,
        cancelled: input.state === 'CANCELLED' };
      const operation = this.sqlite.query(`
        UPDATE operations SET state=?1,result_json=?2,updated_at=?3
        WHERE id=?4 AND state IN ('PLANNED','IN_PROGRESS')
      `).run(operationState, JSON.stringify(operationResult), input.completedAt, run.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Verification run changed while completing');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'VerificationCompleted',1,'VerificationRun',?3,0,?4,?5,?6,?7)
      `).run(input.eventId, run.projectId, input.verificationId, input.eventId, null, input.completedAt,
        JSON.stringify({ verificationId: input.verificationId, taskId: run.taskId,
          executionId: run.executionId, revisionId: run.revisionId, testedCommit: run.testedCommit,
          testedTree: run.testedTree, policyVersion: run.policyVersion,
          policyDigest: run.policyDigest, mainCommit: run.mainCommit,
          state: input.state, outcomeCode: input.outcomeCode, evidence: input.evidence }));
      // The Operation this run owns settled in the same transaction, so a subscriber learns both
      // facts from the same event log without polling the projection.
      this.publishOperationSettled({
        operationId: run.operationId,
        operationState,
        detail: operationResult,
        recordedAt: input.completedAt,
      });
      return this.verificationRunPlan(input.verificationId);
    })();
  }

  /**
   * Marks successful runs whose tested commit or confirmed policy no longer applies as STALE.
   * Old evidence is never rewritten: a stale run keeps its outcome and gains a stale reason.
   */
  markVerificationsStale(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly testedCommit: string;
    readonly policyDigest: string;
    readonly reason: string;
    readonly eventId: string;
    readonly invalidatedAt: number;
  }): number {
    return this.sqlite.transaction(() => {
      const stale = this.sqlite.query<{ id: string }, [string, string, string, string]>(`
        SELECT id FROM verification_runs
        WHERE project_id=?1 AND task_id=?2 AND state='PASSED'
          AND (tested_commit<>?3 OR policy_digest<>?4)
      `).all(input.projectId, input.taskId, input.testedCommit, input.policyDigest);
      if (stale.length === 0) return 0;
      for (const row of stale) {
        this.sqlite.query(`
          UPDATE verification_runs
          SET state='STALE',
              evidence_json=json_set(COALESCE(evidence_json,'{}'),'$.staleReason',?1,
                '$.staleAt',?2)
          WHERE id=?3 AND state='PASSED'
        `).run(input.reason, input.invalidatedAt, row.id);
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'VerificationInvalidated',1,'Task',?3,0,?1,NULL,?4,?5)
      `).run(input.eventId, input.projectId, input.taskId, input.invalidatedAt,
        JSON.stringify({ taskId: input.taskId, reason: input.reason,
          verificationIds: stale.map((row) => row.id), testedCommit: input.testedCommit,
          policyDigest: input.policyDigest }));
      return stale.length;
    })();
  }

  listVerificationRuns(projectId: string, taskId: string): readonly VerificationRunSummary[] {
    return this.sqlite.query<{ id: string }, [string, string]>(`
      SELECT id FROM verification_runs WHERE project_id=?1 AND task_id=?2
      ORDER BY queued_at DESC,id
    `).all(projectId, taskId).map((row) => this.verificationRunPlan(row.id));
  }

  getVerificationRun(projectId: string, verificationId: string): VerificationRunSummary {
    const plan = this.verificationRunPlan(verificationId);
    if (plan.projectId !== projectId) {
      throw new StorageError('NOT_FOUND', 'Verification run was not found for this project');
    }
    return plan;
  }

  /**
   * The same run including its Operation identity and state. A cancel needs both to report what it
   * actually recorded, and the summary projection deliberately hides the Operation.
   */
  getVerificationRunPlan(projectId: string, verificationId: string): VerificationRunPlan {
    const plan = this.verificationRunPlan(verificationId);
    if (plan.projectId !== projectId) {
      throw new StorageError('NOT_FOUND', 'Verification run was not found for this project');
    }
    return plan;
  }

  /** Runs a previous Runtime left QUEUED or RUNNING; a restart reconciles them explicitly. */
  listIncompleteVerificationRuns(): readonly VerificationRunPlan[] {
    return this.sqlite.query<{ id: string }, []>(`
      SELECT id FROM verification_runs WHERE state IN ('QUEUED','RUNNING') ORDER BY queued_at,id
    `).all().map((row) => this.verificationRunPlan(row.id));
  }

  private verificationRunPlan(verificationId: string): VerificationRunPlan {
    const row = this.sqlite.query<{
      id: string; project_id: string; task_id: string; execution_id: string; revision_id: string;
      operation_id: string; operation_state: VerificationRunPlan['operationState'];
      tested_commit: string; tested_tree: string; policy_version: string; policy_digest: string;
      policy_source: VerificationPolicySource; plan_id: string | null; plan_version: string | null;
      plan_digest: string | null;
      main_commit: string; commands_json: string; copy_path: string; state: VerificationState;
      outcome_code: string | null; evidence_json: string | null; queued_at: number;
      started_at: number | null; ended_at: number | null;
    }, [string]>(`
      SELECT r.id,r.project_id,r.task_id,r.execution_id,r.revision_id,r.operation_id,
             o.state AS operation_state,r.tested_commit,r.tested_tree,r.policy_version,
             r.policy_digest,r.policy_source,r.plan_id,r.plan_version,r.plan_digest,r.main_commit,
             r.commands_json,r.copy_path,r.state,r.outcome_code,
             r.evidence_json,r.queued_at,r.started_at,r.ended_at
      FROM verification_runs r JOIN operations o ON o.id=r.operation_id
      WHERE r.id=?1
    `).get(verificationId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Verification run was not found');
    return {
      verificationId: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      executionId: row.execution_id,
      revisionId: row.revision_id,
      operationId: row.operation_id,
      operationState: row.operation_state,
      testedCommit: row.tested_commit,
      testedTree: row.tested_tree,
      policyVersion: row.policy_version,
      policyDigest: row.policy_digest,
      policySource: row.policy_source,
      planId: row.plan_id,
      planVersion: row.plan_version,
      planDigest: row.plan_digest,
      mainCommit: row.main_commit,
      commands: JSON.parse(row.commands_json) as readonly StoredVerificationCommand[],
      copyPath: row.copy_path,
      state: row.state,
      outcomeCode: row.outcome_code,
      evidence: row.evidence_json === null
        ? null
        : JSON.parse(row.evidence_json) as VerificationEvidence,
      queuedAt: row.queued_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Integration pipeline (ADR-0018). These methods only record what happened; every Git side
  // effect is executed by the integration service between calls, so a crash always leaves a
  // batch in a state that can be reconciled without guessing what `dev` points at.
  // ---------------------------------------------------------------------------------------------

  /** Task, revision, refs and existing integration history for one Task's integration decision. */
  getIntegrationCandidates(projectId: string, taskId: string): IntegrationCandidates {
    const task = this.sqlite.query<{
      id: string; project_id: string; display_number: number; state: TaskLifecycleState;
      version: number; current_revision_id: string; repo_root: string; main_repo_root: string;
      git_common_dir: string;
      main_ref: string; dev_ref: string; object_format: 'sha1' | 'sha256';
    }, [string, string]>(`
      SELECT task.id,task.project_id,task.display_number,task.state,task.version,
             task.current_revision_id,COALESCE(p.dev_repo_path,p.repo_root) AS repo_root,
             p.repo_root AS main_repo_root,p.git_common_dir,p.main_ref,p.dev_ref,p.object_format
      FROM tasks task
      JOIN projects p ON p.id=task.project_id
      JOIN project_trusts trust ON trust.project_id=p.id AND trust.status='ACTIVE'
      WHERE task.project_id=?1 AND task.id=?2
    `).get(projectId, taskId);
    if (task === null) {
      throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
    }
    const executions = this.sqlite.query<{
      id: string; attempt_number: number; state: ExecutionLifecycleState;
      applied_revision_id: string; result_commit: string | null; base_commit: string;
    }, [string]>(`
      SELECT id,attempt_number,state,applied_revision_id,result_commit,base_commit
      FROM executions WHERE task_id=?1 ORDER BY attempt_number DESC
    `).all(taskId).map((row) => ({
      executionId: row.id,
      attemptNumber: row.attempt_number,
      state: row.state,
      appliedRevisionId: row.applied_revision_id,
      resultCommit: row.result_commit,
      baseCommit: row.base_commit,
    }));
    return {
      projectId: task.project_id,
      taskId: task.id,
      taskDisplayNumber: task.display_number,
      taskState: task.state,
      taskVersion: task.version,
      currentRevisionId: task.current_revision_id,
      repositoryRoot: task.repo_root,
      mainRepositoryRoot: task.main_repo_root,
      gitCommonDir: task.git_common_dir,
      mainRef: task.main_ref,
      devRef: task.dev_ref,
      objectFormat: task.object_format,
      executions,
      verificationRuns: this.listVerificationRuns(projectId, taskId),
      batches: this.listIntegrationBatches(projectId, taskId),
    };
  }

  /**
   * Reads for one composed batch: its record, the project it belongs to, and every member's current
   * facts. Nothing here decides anything; the integration service compares the fixed record against
   * these facts before touching a ref.
   */
  getIntegrationBatchCandidates(projectId: string, batchId: string): IntegrationBatchCandidates {
    const project = this.sqlite.query<{
      repo_root: string; main_repo_root: string; git_common_dir: string; main_ref: string;
      dev_ref: string;
      object_format: 'sha1' | 'sha256';
    }, [string, string]>(`
      SELECT COALESCE(p.dev_repo_path,p.repo_root) AS repo_root,p.repo_root AS main_repo_root,
             p.git_common_dir,p.main_ref,p.dev_ref,p.object_format
      FROM projects p
      JOIN project_trusts trust ON trust.project_id=p.id AND trust.status='ACTIVE'
      WHERE p.id=?1 AND EXISTS(SELECT 1 FROM integration_batches b WHERE b.id=?2 AND b.project_id=p.id)
    `).get(projectId, batchId);
    if (project === null) {
      throw new StorageError('NOT_FOUND', 'Integration batch or active project trust was not found');
    }
    const batch = this.integrationBatchSummary(batchId);
    if (batch.projectId !== projectId) {
      throw new StorageError('NOT_FOUND', 'Integration batch was not found for this project');
    }
    const members = this.sqlite.query<{
      task_id: string; display_number: number; task_state: TaskLifecycleState;
      task_version: number; current_revision_id: string; revision_id: string; execution_id: string;
      execution_state: ExecutionLifecycleState; result_commit: string | null;
      candidate_commit: string; task_verification_id: string | null;
      task_verification_tested_commit: string | null;
    }, [string, string]>(`
      SELECT item.task_id,task.display_number,task.state AS task_state,task.version AS task_version,
             task.current_revision_id,item.revision_id,item.execution_id,
             execution.state AS execution_state,execution.result_commit,item.candidate_commit,
             (SELECT run.id FROM verification_runs run
               WHERE run.task_id=item.task_id AND run.revision_id=item.revision_id
                 AND run.tested_commit=item.candidate_commit AND run.state='PASSED'
               ORDER BY run.queued_at DESC,run.id LIMIT 1) AS task_verification_id,
             (SELECT run.tested_commit FROM verification_runs run
               WHERE run.task_id=item.task_id AND run.revision_id=item.revision_id
                 AND run.tested_commit=item.candidate_commit AND run.state='PASSED'
               ORDER BY run.queued_at DESC,run.id LIMIT 1) AS task_verification_tested_commit
      FROM integration_batch_items item
      JOIN tasks task ON task.id=item.task_id
      JOIN executions execution ON execution.task_id=item.task_id AND execution.id=item.execution_id
      WHERE item.project_id=?1 AND item.batch_id=?2
      ORDER BY item.task_id
    `).all(projectId, batchId).map((row) => ({
      taskId: row.task_id,
      taskDisplayNumber: row.display_number,
      taskState: row.task_state,
      taskVersion: row.task_version,
      currentRevisionId: row.current_revision_id,
      revisionId: row.revision_id,
      executionId: row.execution_id,
      executionState: row.execution_state,
      resultCommit: row.result_commit,
      candidateCommit: row.candidate_commit,
      taskVerificationId: row.task_verification_id,
      taskVerificationTestedCommit: row.task_verification_tested_commit,
    }));
    return {
      projectId,
      batchId,
      repositoryRoot: project.repo_root,
      mainRepositoryRoot: project.main_repo_root,
      gitCommonDir: project.git_common_dir,
      mainRef: project.main_ref,
      devRef: project.dev_ref,
      objectFormat: project.object_format,
      batch,
      members,
    };
  }

  /**
   * Marks a batch unusable because its fixed evidence stopped being the current fact (ADR-0053).
   * `STALE` is terminal and never touches `dev`: the merge/verification evidence that already exists
   * stays readable, and the remedy is to compose a new batch from the current facts. A batch whose
   * ref already moved (`INTEGRATED`) cannot become stale.
   */
  markIntegrationBatchStale(input: {
    readonly batchId: string;
    readonly outcomeCode: string;
    readonly reason: string;
    readonly eventId: string;
    readonly at: number;
  }): IntegrationBatchPlan {
    return this.sqlite.transaction(() => {
      const batch = this.integrationBatchPlan(input.batchId);
      if (batch.state === 'STALE') return batch;
      if (batch.state !== 'CREATED' && batch.state !== 'PREPARING'
        && batch.state !== 'VERIFYING' && batch.state !== 'INTEGRATING_DEV') {
        throw new StorageError('INVALID_STATE',
          `Integration batch is ${batch.state}; only a batch that did not integrate can be stale`);
      }
      const updated = this.sqlite.query(`
        UPDATE integration_batches SET state='STALE',outcome_code=?1,detail=?2,completed_at=?3
        WHERE id=?4 AND state IN ('CREATED','PREPARING','VERIFYING','INTEGRATING_DEV')
      `).run(input.outcomeCode, input.reason, input.at, input.batchId);
      const operation = this.sqlite.query(`
        UPDATE operations SET state='FAILED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state IN ('PLANNED','IN_PROGRESS')
      `).run(JSON.stringify({ batchId: input.batchId, state: 'STALE',
        outcomeCode: input.outcomeCode }), input.at, batch.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Integration batch changed while marking it stale');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'IntegrationBatchStale',1,'IntegrationBatch',?3,0,?1,?1,?4,?5)
      `).run(input.eventId, batch.projectId, input.batchId, input.at,
        JSON.stringify({ batchId: input.batchId, devRef: batch.devRef, devCommit: batch.devCommit,
          integratedCommit: null, outcomeCode: input.outcomeCode, reason: input.reason,
          previousState: batch.state,
          members: batch.items.map((member) => ({ taskId: member.taskId,
            revisionId: member.revisionId, candidateCommit: member.candidateCommit,
            state: member.state })) }));
      return this.integrationBatchPlan(input.batchId);
    })();
  }

  /**
   * Ends a composed batch before it integrated (ADR-0053). A cancellation is only recorded as
   * `CANCELLED` when the record itself proves that no member side effect exists yet: the batch is
   * still `CREATED` and it recorded no worktree, no merge and no verification. Anything else is left
   * for reconciliation instead of being called cancelled — a merge may exist, a verification process
   * may still be writing its copy, or the ref write may have happened — so the batch keeps its slot
   * as `RECOVERY_REQUIRED/RECONCILE_REQUIRED` and a human resolves it from the recorded evidence.
   *
   * Cancelling is idempotent: a batch that is already terminal is reported as it stands.
   */
  cancelIntegrationBatch(input: {
    readonly batchId: string;
    readonly reason: string;
    readonly eventId: string;
    readonly at: number;
  }): IntegrationBatchPlan {
    const observed = this.integrationBatchPlan(input.batchId);
    if (observed.state === 'INTEGRATED' || observed.state === 'FAILED'
      || observed.state === 'CONFLICTED' || observed.state === 'CANCELLED'
      || observed.state === 'STALE' || observed.state === 'RECOVERY_REQUIRED') {
      return observed;
    }
    // `markIntegrationRecoveryRequired` owns its own transaction, so the unconfirmed path is decided
    // before the cancel transaction starts rather than nested inside it. A batch that already left
    // `CREATED`, or that recorded a worktree/merge/verification while it was `CREATED`, cannot be
    // confirmed side-effect-free from the records alone.
    if (observed.state !== 'CREATED' || !this.memberSideEffectsSettled(observed)) {
      return this.markIntegrationRecoveryRequired({
        batchId: input.batchId,
        outcomeCode: 'RECONCILE_REQUIRED',
        reason: `cancellation was requested but batch ${input.batchId} recorded a worktree, a merge`
          + ' or a verification, so its member side effects cannot be confirmed settled:'
          + ` ${input.reason}`,
        eventId: input.eventId,
        at: input.at,
      });
    }
    return this.sqlite.transaction(() => {
      const batch = this.integrationBatchPlan(input.batchId);
      if (batch.state !== 'CREATED') return batch;
      if (!this.memberSideEffectsSettled(batch)) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Integration batch recorded a side effect while it was being cancelled');
      }
      const updated = this.sqlite.query(`
        UPDATE integration_batches SET state='CANCELLED',outcome_code='CANCELLED_BY_USER',
          detail=?1,completed_at=?2
        WHERE id=?3 AND state='CREATED'
      `).run(input.reason, input.at, input.batchId);
      const operation = this.sqlite.query(`
        UPDATE operations SET state='FAILED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state IN ('PLANNED','IN_PROGRESS')
      `).run(JSON.stringify({ batchId: input.batchId, state: 'CANCELLED',
        outcomeCode: 'CANCELLED_BY_USER' }), input.at, batch.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Integration batch changed while cancelling it');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'IntegrationBatchCancelled',1,'IntegrationBatch',?3,0,?1,?1,?4,?5)
      `).run(input.eventId, batch.projectId, input.batchId, input.at,
        JSON.stringify({ batchId: input.batchId, devRef: batch.devRef, devCommit: batch.devCommit,
          integratedCommit: null, outcomeCode: 'CANCELLED_BY_USER', reason: input.reason,
          members: batch.items.map((member) => ({ taskId: member.taskId,
            revisionId: member.revisionId, candidateCommit: member.candidateCommit,
            state: member.state })) }));
      return this.integrationBatchPlan(input.batchId);
    })();
  }

  /**
   * Reserves one IntegrationBatch for one or more Task members and fixes the `dev` baseline it was
   * prepared against (ADR-0018, ADR-0053). Every member must still be an EXECUTED Task at the exact
   * revision and result commit the batch will carry, so a batch is always a statement about facts
   * that existed when it was composed. Validation is all-or-nothing: one unusable member refuses the
   * whole batch and no row is written.
   *
   * Members are stored (and therefore merged) in `task_id` order, so the same member set always
   * produces the same integration no matter which order the request listed it in.
   */
  beginIntegrationBatch(input: {
    readonly projectId: string;
    readonly batchId: string;
    readonly operationId: string;
    readonly worktreeOwnershipToken: string;
    readonly devRef: string;
    readonly devCommit: string;
    readonly members: readonly {
      readonly taskId: string;
      readonly executionId: string;
      readonly expectedVersion: number;
    }[];
    readonly commandId: string;
    readonly payloadHash: string;
    readonly createdEventId: string;
    readonly actor: string;
    readonly createdAt: number;
  }): Readonly<{ plan: IntegrationBatchPlan; created: boolean }> {
    if (input.members.length === 0) {
      throw new StorageError('INVALID_STATE', 'An IntegrationBatch needs at least one member');
    }
    if (new Set(input.members.map((member) => member.taskId)).size !== input.members.length) {
      throw new StorageError('INVALID_STATE', 'An IntegrationBatch cannot name the same Task twice');
    }
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<{ payload_hash: string; result_json: string }, [string, string]>(
        'SELECT payload_hash,result_json FROM command_receipts WHERE project_id=?1 AND command_id=?2',
      ).get(input.projectId, input.commandId);
      if (existing !== null) {
        if (existing.payload_hash !== input.payloadHash) {
          throw new StorageError('COMMAND_CONFLICT',
            'Command ID was already used with a different payload');
        }
        const recorded = JSON.parse(existing.result_json) as { batchId: string };
        return { plan: this.integrationBatchPlan(recorded.batchId), created: false };
      }
      const project = this.sqlite.query<{ dev_ref: string }, [string]>(`
        SELECT p.dev_ref FROM projects p
        JOIN project_trusts trust ON trust.project_id=p.id AND trust.status='ACTIVE'
        WHERE p.id=?1
      `).get(input.projectId);
      if (project === null) {
        throw new StorageError('NOT_FOUND', 'Project or active project trust was not found');
      }
      if (project.dev_ref !== input.devRef) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Project baseline ref changed before integration');
      }
      // The request order is not authoritative: a batch is merged in `task_id` order so the same
      // member set cannot produce two different integrations.
      const ordered = [...input.members].sort((left, right) =>
        left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0);
      const fixed: { taskId: string; revisionId: string; executionId: string;
        candidateCommit: string }[] = [];
      for (const member of ordered) {
        const task = this.sqlite.query<{
          state: TaskLifecycleState; version: number; current_revision_id: string;
        }, [string, string]>(`
          SELECT t.state,t.version,t.current_revision_id FROM tasks t
          JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
          WHERE t.project_id=?1 AND t.id=?2
        `).get(input.projectId, member.taskId);
        if (task === null) {
          throw new StorageError('NOT_FOUND', `Task ${member.taskId} or active project trust was not found`);
        }
        if (task.version !== member.expectedVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION',
            `Task ${member.taskId} version did not match`);
        }
        if (task.state !== 'EXECUTED') {
          throw new StorageError('INVALID_STATE',
            `Task ${member.taskId} is ${task.state}; integration needs an EXECUTED Task with a`
            + ' captured result commit');
        }
        const execution = this.sqlite.query<{
          state: ExecutionLifecycleState; applied_revision_id: string; result_commit: string | null;
        }, [string, string]>(`
          SELECT state,applied_revision_id,result_commit FROM executions WHERE task_id=?1 AND id=?2
        `).get(member.taskId, member.executionId);
        if (execution === null) {
          throw new StorageError('NOT_FOUND', `Execution was not found for Task ${member.taskId}`);
        }
        if (execution.state !== 'SUCCEEDED' || execution.result_commit === null
          || execution.applied_revision_id !== task.current_revision_id) {
          throw new StorageError('CONCURRENT_MODIFICATION',
            `Execution evidence of Task ${member.taskId} changed before integration was prepared`);
        }
        fixed.push({
          taskId: member.taskId,
          revisionId: task.current_revision_id,
          executionId: member.executionId,
          candidateCommit: execution.result_commit,
        });
      }
      this.sqlite.query(`
        INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,request_json,
          created_at,updated_at)
        VALUES (?1,?2,'INTEGRATE_TASK_RESULT',?3,?4,'PLANNED',?5,?6,?6)
      `).run(input.operationId, input.projectId, input.batchId, input.commandId,
        JSON.stringify({ batchId: input.batchId, devRef: input.devRef, devCommit: input.devCommit,
          members: fixed.map((member) => ({ taskId: member.taskId, revisionId: member.revisionId,
            executionId: member.executionId, candidateCommit: member.candidateCommit })) }),
        input.createdAt);
      this.sqlite.query(`
        INSERT INTO integration_batches(id,project_id,dev_ref,dev_commit,state,
          worktree_ownership_token,created_at)
        VALUES (?1,?2,?3,?4,'CREATED',?5,?6)
      `).run(input.batchId, input.projectId, input.devRef, input.devCommit,
        input.worktreeOwnershipToken, input.createdAt);
      for (const member of fixed) {
        this.sqlite.query(`
          INSERT INTO integration_batch_items(batch_id,project_id,task_id,revision_id,execution_id,
            candidate_commit,dev_commit,state,created_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,'PREPARED',?8)
        `).run(input.batchId, input.projectId, member.taskId, member.revisionId,
          member.executionId, member.candidateCommit, input.devCommit, input.createdAt);
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'IntegrationBatchCreated',1,'IntegrationBatch',?3,0,?4,?4,?5,?6)
      `).run(input.createdEventId, input.projectId, input.batchId, input.commandId, input.createdAt,
        JSON.stringify({ batchId: input.batchId, devRef: input.devRef, devCommit: input.devCommit,
          actor: input.actor,
          members: fixed.map((member) => ({ taskId: member.taskId, revisionId: member.revisionId,
            executionId: member.executionId, candidateCommit: member.candidateCommit })) }));
      this.sqlite.query(`
        INSERT INTO command_receipts(project_id,command_id,payload_hash,result_json,created_at)
        VALUES (?1,?2,?3,?4,?5)
      `).run(input.projectId, input.commandId, input.payloadHash,
        JSON.stringify({ batchId: input.batchId }), input.createdAt);
      return { plan: this.integrationBatchPlan(input.batchId), created: true };
    })();
  }

  /** CREATED → PREPARING, with the retained integration worktree recorded before Git is touched. */
  startIntegrationMerge(input: {
    readonly batchId: string;
    readonly worktreePath: string;
    readonly startedAt: number;
  }): IntegrationBatchPlan {
    return this.sqlite.transaction(() => {
      const batch = this.integrationBatchPlan(input.batchId);
      if (batch.state !== 'CREATED') return batch;
      const updated = this.sqlite.query(`
        UPDATE integration_batches SET state='PREPARING',worktree_path=?1
        WHERE id=?2 AND state='CREATED'
      `).run(input.worktreePath, input.batchId);
      const operation = this.sqlite.query(`
        UPDATE operations SET state='IN_PROGRESS',updated_at=?1
        WHERE id=?2 AND state='PLANNED'
      `).run(input.startedAt, batch.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Integration batch changed while starting its merge');
      }
      return this.integrationBatchPlan(input.batchId);
    })();
  }

  /**
   * Records one member's merge. The `dev` ref is still untouched at this point, and the batch keeps
   * the merge of its last member as its own `mergeStrategy`/`mergedCommit`: the final integration
   * tree either is that member's candidate commit (every step fast-forwarded) or the merge commit
   * that member produced.
   */
  recordIntegrationMerge(input: {
    readonly batchId: string;
    readonly taskId: string;
    readonly mergeStrategy: MergeStrategy;
    readonly mergedCommit: string;
    readonly eventId: string;
    readonly mergedAt: number;
  }): IntegrationBatchPlan {
    return this.sqlite.transaction(() => {
      const batch = this.integrationBatchPlan(input.batchId);
      if (batch.state !== 'PREPARING') return batch;
      const item = batch.items.find((entry) => entry.taskId === input.taskId);
      if (item === undefined) {
        throw new StorageError('NOT_FOUND', `Task ${input.taskId} is not a member of batch ${input.batchId}`);
      }
      if (item.state !== 'PREPARED') return batch;
      const updated = this.sqlite.query(`
        UPDATE integration_batches SET merge_strategy=?1,merged_commit=?2
        WHERE id=?3 AND state='PREPARING'
      `).run(input.mergeStrategy, input.mergedCommit, input.batchId);
      const member = this.sqlite.query(`
        UPDATE integration_batch_items SET state='MERGED'
        WHERE batch_id=?1 AND task_id=?2 AND state='PREPARED'
      `).run(input.batchId, input.taskId);
      if (updated.changes !== 1 || member.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Integration batch changed while recording a member merge');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'IntegrationMemberMerged',1,'IntegrationBatch',?3,0,?1,?1,?4,?5)
      `).run(input.eventId, batch.projectId, input.batchId, input.mergedAt,
        JSON.stringify({ batchId: input.batchId, taskId: input.taskId,
          revisionId: item.revisionId, candidateCommit: item.candidateCommit,
          mergeStrategy: input.mergeStrategy, mergedCommit: input.mergedCommit }));
      return this.integrationBatchPlan(input.batchId);
    })();
  }

  /**
   * Queues one independent integration verification on the merged commit together with its
   * Operation. It is a separate record from Task verification: the tested commit is the
   * integration result, and the fixed `dev` baseline is part of its evidence.
   */
  beginIntegrationVerification(input: {
    readonly batchId: string;
    readonly verificationId: string;
    readonly operationId: string;
    readonly commandId: string;
    readonly testedCommit: string;
    readonly testedTree: string;
    readonly policyVersion: string;
    readonly policyDigest: string;
    readonly mainCommit: string;
    readonly commands: readonly StoredVerificationCommand[];
    readonly copyPath: string;
    readonly queuedAt: number;
  }): Readonly<{ plan: IntegrationVerificationPlan; created: boolean }> {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<{ id: string }, [string]>(`
        SELECT id FROM integration_verification_runs WHERE batch_id=?1
      `).get(input.batchId);
      if (existing !== null) {
        return { plan: this.integrationVerificationPlan(existing.id), created: false };
      }
      const batch = this.integrationBatchPlan(input.batchId);
      if (batch.state !== 'PREPARING' || batch.mergeStrategy === null) {
        throw new StorageError('INVALID_STATE',
          `Integration batch is ${batch.state}; verification needs a recorded merge`);
      }
      if (batch.items.some((item) => item.state !== 'MERGED')) {
        throw new StorageError('INVALID_STATE',
          'Integration verification needs every member of the batch to be merged');
      }
      this.sqlite.query(`
        INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,request_json,
          created_at,updated_at)
        VALUES (?1,?2,'RUN_INTEGRATION_VERIFICATION',?3,?4,'PLANNED',?5,?6,?6)
      `).run(input.operationId, batch.projectId, input.verificationId, input.commandId,
        JSON.stringify({ verificationId: input.verificationId, batchId: input.batchId,
          testedCommit: input.testedCommit, devCommit: batch.devCommit,
          policyDigest: input.policyDigest,
          members: batch.items.map((item) => ({ taskId: item.taskId, revisionId: item.revisionId,
            executionId: item.executionId, candidateCommit: item.candidateCommit })) }),
        input.queuedAt);
      // The verification row names the batch's first member for the per-Task columns the table has
      // always carried; the batch itself is the subject (`batch_id` is unique here), and the full
      // member list lives in the evidence and in `integration_batch_items`.
      this.sqlite.query(`
        INSERT INTO integration_verification_runs(id,batch_id,project_id,task_id,execution_id,
          revision_id,operation_id,command_id,tested_commit,tested_tree,dev_commit,policy_version,
          policy_digest,main_commit,commands_json,copy_path,state,queued_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,'QUEUED',?17)
      `).run(input.verificationId, input.batchId, batch.projectId, batch.items[0]?.taskId as string,
        batch.items[0]?.executionId as string, batch.items[0]?.revisionId as string,
        input.operationId, input.commandId,
        input.testedCommit, input.testedTree, batch.devCommit, input.policyVersion,
        input.policyDigest, input.mainCommit, JSON.stringify(input.commands), input.copyPath,
        input.queuedAt);
      const updated = this.sqlite.query(`
        UPDATE integration_batches SET state='VERIFYING',verification_id=?1
        WHERE id=?2 AND state='PREPARING'
      `).run(input.verificationId, input.batchId);
      if (updated.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Integration batch changed while queuing its verification');
      }
      return { plan: this.integrationVerificationPlan(input.verificationId), created: true };
    })();
  }

  /** QUEUED → RUNNING with its Operation IN_PROGRESS, before any command is spawned. */
  startIntegrationVerification(input: {
    readonly verificationId: string;
    readonly startedAt: number;
  }): IntegrationVerificationPlan {
    return this.sqlite.transaction(() => {
      const run = this.integrationVerificationPlan(input.verificationId);
      if (run.state !== 'QUEUED') return run;
      const updated = this.sqlite.query(`
        UPDATE integration_verification_runs SET state='RUNNING',started_at=?1
        WHERE id=?2 AND state='QUEUED'
      `).run(input.startedAt, input.verificationId);
      const operation = this.sqlite.query(`
        UPDATE operations SET state='IN_PROGRESS',updated_at=?1 WHERE id=?2 AND state='PLANNED'
      `).run(input.startedAt, run.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Integration verification changed while starting');
      }
      return this.integrationVerificationPlan(input.verificationId);
    })();
  }

  completeIntegrationVerification(input: {
    readonly verificationId: string;
    readonly state: 'PASSED' | 'FAILED' | 'ERROR';
    readonly outcomeCode: string;
    readonly evidence: VerificationEvidence;
    readonly eventId: string;
    readonly completedAt: number;
  }): IntegrationVerificationPlan {
    return this.sqlite.transaction(() => {
      const run = this.integrationVerificationPlan(input.verificationId);
      if (run.state !== 'QUEUED' && run.state !== 'RUNNING') return run;
      const updated = this.sqlite.query(`
        UPDATE integration_verification_runs
        SET state=?1,outcome_code=?2,evidence_json=?3,ended_at=?4
        WHERE id=?5 AND state IN ('QUEUED','RUNNING')
      `).run(input.state, input.outcomeCode, JSON.stringify(input.evidence), input.completedAt,
        input.verificationId);
      const operation = this.sqlite.query(`
        UPDATE operations SET state=?1,result_json=?2,updated_at=?3
        WHERE id=?4 AND state IN ('PLANNED','IN_PROGRESS')
      `).run(input.state === 'PASSED' ? 'SUCCEEDED' : 'FAILED',
        JSON.stringify({ verificationId: input.verificationId, state: input.state,
          outcomeCode: input.outcomeCode }), input.completedAt, run.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Integration verification changed while completing');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'IntegrationVerificationCompleted',1,'IntegrationBatch',?3,0,?4,?4,?5,?6)
      `).run(input.eventId, run.projectId, run.batchId, input.eventId, input.completedAt,
        JSON.stringify({ batchId: run.batchId, verificationId: input.verificationId,
          taskId: run.taskId, executionId: run.executionId, revisionId: run.revisionId,
          testedCommit: run.testedCommit, testedTree: run.testedTree, devCommit: run.devCommit,
          policyVersion: run.policyVersion, policyDigest: run.policyDigest,
          mainCommit: run.mainCommit, state: input.state, outcomeCode: input.outcomeCode,
          evidence: input.evidence }));
      return this.integrationVerificationPlan(input.verificationId);
    })();
  }

  /**
   * Records that `dev` now contains every member of the batch. Each Task only reaches SUCCEEDED here:
   * a captured result commit is not an integration, and verification does not move a ref. Every member
   * is guarded by the exact revision the batch fixed, so a Task that moved on since the batch was
   * composed cannot be reported as integrated.
   */
  completeIntegrationBatch(input: {
    readonly batchId: string;
    readonly integratedCommit: string;
    readonly worktreeDetail: string;
    readonly completedEventId: string;
    /** One event ID per member, in `items` order. */
    readonly taskEventIds: readonly string[];
    readonly completedAt: number;
  }): IntegrationBatchPlan {
    return this.sqlite.transaction(() => {
      const batch = this.integrationBatchPlan(input.batchId);
      if (batch.state === 'INTEGRATED') return batch;
      if (batch.state !== 'VERIFYING' && batch.state !== 'INTEGRATING_DEV') {
        throw new StorageError('INVALID_STATE',
          `Integration batch is ${batch.state}; only a verified batch can be completed`);
      }
      if (input.taskEventIds.length !== batch.items.length) {
        throw new StorageError('INVALID_STATE',
          'Completing an integration needs one Task event ID per member');
      }
      const verification = this.integrationVerificationPlan(batch.verificationId as string);
      if (verification.state !== 'PASSED') {
        throw new StorageError('INVALID_STATE',
          `Integration verification is ${verification.state}; the dev ref cannot advance`);
      }
      const item = this.sqlite.query(`
        UPDATE integration_batch_items SET state='INTEGRATED',integrated_commit=?1,completed_at=?2
        WHERE batch_id=?3 AND state='MERGED'
      `).run(input.integratedCommit, input.completedAt, input.batchId);
      const updated = this.sqlite.query(`
        UPDATE integration_batches SET state='INTEGRATED',integrated_commit=?1,detail=?2,completed_at=?3
        WHERE id=?4 AND state IN ('VERIFYING','INTEGRATING_DEV')
      `).run(input.integratedCommit, input.worktreeDetail, input.completedAt, input.batchId);
      if (item.changes !== batch.items.length || updated.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Integration batch or its members changed while completing the integration');
      }
      for (const [index, member] of batch.items.entries()) {
        const taskEventId = input.taskEventIds[index];
        if (taskEventId === undefined) {
          throw new StorageError('INVALID_STATE',
            'Completing an integration needs one Task event ID per member');
        }
        const task = this.sqlite.query(`
          UPDATE tasks SET state='SUCCEEDED',version=version+1,updated_at=?1
          WHERE id=?2 AND project_id=?3 AND state='EXECUTED' AND current_revision_id=?4
        `).run(input.completedAt, member.taskId, batch.projectId, member.revisionId);
        if (task.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION',
            `Task ${member.taskId} changed while completing the integration`);
        }
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
        `).run(taskEventId, batch.projectId, member.taskId, member.taskVersion + 1,
          input.completedEventId, input.completedEventId, input.completedAt,
          JSON.stringify({ taskId: member.taskId, from: 'EXECUTED', to: 'SUCCEEDED',
            reason: 'result integrated into dev', actor: 'runtime-integration' }));
      }
      const operation = this.sqlite.query(`
        UPDATE operations SET state='SUCCEEDED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state IN ('PLANNED','IN_PROGRESS')
      `).run(JSON.stringify({ batchId: input.batchId, state: 'INTEGRATED',
        integratedCommit: input.integratedCommit,
        members: batch.items.map((member) => ({ taskId: member.taskId,
          revisionId: member.revisionId, candidateCommit: member.candidateCommit })) }),
        input.completedAt, batch.operationId);
      if (operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Integration batch operation changed while completing the integration');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'IntegrationCompleted',1,'IntegrationBatch',?3,0,?4,?4,?5,?6)
      `).run(input.completedEventId, batch.projectId, input.batchId, input.completedEventId,
        input.completedAt, JSON.stringify({ batchId: input.batchId, devRef: batch.devRef,
          devCommit: batch.devCommit, integratedCommit: input.integratedCommit,
          mergeStrategy: batch.mergeStrategy, verificationId: batch.verificationId,
          worktree: input.worktreeDetail,
          members: batch.items.map((member) => ({ taskId: member.taskId,
            executionId: member.executionId, revisionId: member.revisionId,
            candidateCommit: member.candidateCommit })) }));
      return this.integrationBatchPlan(input.batchId);
    })();
  }

  /**
   * Terminal failure of a batch. `dev` is untouched by definition: the service only calls this
   * when the ref was not advanced, and the failed merge/verification evidence stays attached.
   */
  failIntegrationBatch(input: {
    readonly batchId: string;
    readonly state: 'FAILED' | 'CONFLICTED';
    readonly outcomeCode: string;
    readonly detail: string;
    /** The member whose merge or evidence failed; omitted when the batch itself failed (verification). */
    readonly failedTaskId?: string;
    readonly mergeStrategy?: MergeStrategy;
    readonly mergedCommit?: string;
    readonly eventId: string;
    readonly failedAt: number;
  }): IntegrationBatchPlan {
    return this.sqlite.transaction(() => {
      const batch = this.integrationBatchPlan(input.batchId);
      if (batch.state === 'INTEGRATED' || batch.state === 'FAILED'
        || batch.state === 'CONFLICTED' || batch.state === 'RECOVERY_REQUIRED'
        || batch.state === 'STALE' || batch.state === 'CANCELLED') {
        return batch;
      }
      if (input.mergeStrategy !== undefined && batch.mergeStrategy === null) {
        this.sqlite.query(`UPDATE integration_batches SET merge_strategy=?1 WHERE id=?2`)
          .run(input.mergeStrategy, input.batchId);
      }
      // Only the member whose merge actually failed is marked. Members that were already merged keep
      // `MERGED` and members that were never attempted keep `PREPARED`, so a partial integration is
      // never reported as a whole-batch success *or* as a whole-batch failure.
      const failingState = input.state === 'CONFLICTED' ? 'CONFLICTED' : 'FAILED';
      const candidates = batch.items.filter((item) => item.state === 'PREPARED' || item.state === 'MERGED');
      if (input.failedTaskId !== undefined
        && !candidates.some((item) => item.taskId === input.failedTaskId)) {
        throw new StorageError('INVALID_STATE',
          `Task ${input.failedTaskId} has no unsettled member record in batch ${input.batchId}`);
      }
      const failedTaskId = input.failedTaskId;
      const item = failedTaskId === undefined ? null : this.sqlite.query(`
        UPDATE integration_batch_items SET state=?1,detail=?2,completed_at=?3
        WHERE batch_id=?4 AND task_id=?5 AND state IN ('PREPARED','MERGED')
      `).run(failingState, input.detail, input.failedAt, input.batchId, failedTaskId);
      const updated = this.sqlite.query(`
        UPDATE integration_batches
        SET state=?1,outcome_code=?2,detail=?3,completed_at=?4
        WHERE id=?5 AND state IN ('CREATED','PREPARING','VERIFYING','INTEGRATING_DEV')
      `).run(input.state, input.outcomeCode, input.detail, input.failedAt, input.batchId);
      const operation = this.sqlite.query(`
        UPDATE operations SET state='FAILED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED')
      `).run(JSON.stringify({ batchId: input.batchId, state: input.state,
        outcomeCode: input.outcomeCode, mergedCommit: input.mergedCommit ?? null,
        failedTaskId: input.failedTaskId ?? null }),
        input.failedAt, batch.operationId);
      if (updated.changes !== 1 || operation.changes !== 1
        || (item !== null && item.changes !== 1)) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Integration batch changed while recording its failure');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'IntegrationFailed',1,'IntegrationBatch',?3,0,?4,?4,?5,?6)
      `).run(input.eventId, batch.projectId, input.batchId, input.eventId, input.failedAt,
        JSON.stringify({ batchId: input.batchId, devRef: batch.devRef,
          devCommit: batch.devCommit, state: input.state, outcomeCode: input.outcomeCode,
          detail: input.detail, mergeStrategy: input.mergeStrategy ?? batch.mergeStrategy,
          mergedCommit: input.mergedCommit ?? null,
          failedTaskId: input.failedTaskId ?? null,
          members: batch.items.map((member) => ({ taskId: member.taskId,
            executionId: member.executionId, revisionId: member.revisionId,
            candidateCommit: member.candidateCommit })) }));
      return this.integrationBatchPlan(input.batchId);
    })();
  }

  /**
   * Reconciliation entry for a batch a restart found in flight. The caller has already read the
   * `dev` ref, so the record states what was observed instead of assuming the ref did not move.
   * `RECOVERY_REQUIRED` is terminal and blocks a new attempt until a human resolves it.
   */
  markIntegrationRecoveryRequired(input: {
    readonly batchId: string;
    readonly outcomeCode: 'RECONCILE_REQUIRED' | 'DEV_REF_OBSERVED';
    readonly reason: string;
    readonly eventId: string;
    readonly at: number;
  }): IntegrationBatchPlan {
    return this.sqlite.transaction(() => {
      const batch = this.integrationBatchPlan(input.batchId);
      if (!['CREATED', 'PREPARING', 'VERIFYING', 'INTEGRATING_DEV'].includes(batch.state)) return batch;
      const item = this.sqlite.query(`
        UPDATE integration_batch_items SET detail=?1
        WHERE batch_id=?2 AND state IN ('PREPARED','MERGED')
      `).run(input.reason, input.batchId);
      const unsettled = batch.items.filter((member) =>
        member.state === 'PREPARED' || member.state === 'MERGED').length;
      const updated = this.sqlite.query(`
        UPDATE integration_batches SET state='RECOVERY_REQUIRED',outcome_code=?1,detail=?2,completed_at=?3
        WHERE id=?4 AND state IN ('CREATED','PREPARING','VERIFYING','INTEGRATING_DEV')
      `).run(input.outcomeCode, input.reason, input.at, input.batchId);
      const operation = this.sqlite.query(`
        UPDATE operations SET state='RECONCILE_REQUIRED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state IN ('PLANNED','IN_PROGRESS')
      `).run(JSON.stringify({ batchId: input.batchId, state: 'RECOVERY_REQUIRED',
        outcomeCode: input.outcomeCode }), input.at, batch.operationId);
      if (item.changes !== unsettled || updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Integration batch changed while recording its recovery');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'IntegrationReconcileRequired',1,'IntegrationBatch',?3,0,?1,?1,?4,?5)
      `).run(input.eventId, batch.projectId, input.batchId, input.at,
        JSON.stringify({ batchId: input.batchId, devRef: batch.devRef,
          devCommit: batch.devCommit, mergedCommit: batch.mergedCommit,
          previousState: batch.state, outcomeCode: input.outcomeCode, reason: input.reason,
          members: batch.items.map((member) => ({ taskId: member.taskId,
            executionId: member.executionId, revisionId: member.revisionId,
            candidateCommit: member.candidateCommit, state: member.state })) }));
      return this.integrationBatchPlan(input.batchId);
    })();
  }

  /**
   * VERIFYING/INTEGRATING_DEV → INTEGRATING_DEV: recorded immediately before the ref write, so an
   * interrupted update is identifiable and resolvable by comparing `merged_commit` with `dev`.
   */
  startIntegrationDevUpdate(input: {
    readonly batchId: string;
    readonly updatedAt: number;
  }): IntegrationBatchPlan {
    return this.sqlite.transaction(() => {
      const batch = this.integrationBatchPlan(input.batchId);
      if (batch.state !== 'VERIFYING') return batch;
      const verification = batch.verificationId === null
        ? null
        : this.integrationVerificationPlan(batch.verificationId);
      if (verification === null || verification.state !== 'PASSED') {
        throw new StorageError('INVALID_STATE',
          `Integration verification is ${verification?.state ?? 'missing'}; the dev ref cannot advance`);
      }
      if (batch.mergedCommit === null) {
        throw new StorageError('INVALID_STATE', 'Integration batch has no recorded merge to apply');
      }
      const updated = this.sqlite.query(`
        UPDATE integration_batches SET state='INTEGRATING_DEV'
        WHERE id=?1 AND state='VERIFYING'
      `).run(input.batchId);
      const operation = this.sqlite.query(`
        UPDATE operations SET updated_at=?1 WHERE id=?2 AND state='IN_PROGRESS'
      `).run(input.updatedAt, batch.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Integration batch changed while starting its dev update');
      }
      return this.integrationBatchPlan(input.batchId);
    })();
  }

  listIntegrationBatches(projectId: string, taskId?: string): readonly IntegrationBatchSummary[] {
    const rows = taskId === undefined
      ? this.sqlite.query<{ id: string }, [string]>(`
          SELECT batch.id FROM integration_batches batch
          WHERE batch.project_id=?1 ORDER BY batch.created_at DESC,batch.id
        `).all(projectId)
      : this.sqlite.query<{ id: string }, [string, string]>(`
          SELECT batch.id FROM integration_batches batch
          JOIN integration_batch_items item ON item.batch_id=batch.id
          WHERE batch.project_id=?1 AND item.task_id=?2 ORDER BY batch.created_at DESC,batch.id
        `).all(projectId, taskId);
    return rows.map((row) => this.integrationBatchSummary(row.id));
  }

  /** Reads one recorded batch with its Operation and project refs, for an integration attempt. */
  getIntegrationBatchPlan(projectId: string, batchId: string): IntegrationBatchPlan {
    const plan = this.integrationBatchPlan(batchId);
    if (plan.projectId !== projectId) {
      throw new StorageError('NOT_FOUND', 'Integration batch was not found for this project');
    }
    return plan;
  }

  getIntegrationBatch(projectId: string, batchId: string): IntegrationBatchSummary {
    const summary = this.integrationBatchSummary(batchId);
    if (summary.projectId !== projectId) {
      throw new StorageError('NOT_FOUND', 'Integration batch was not found for this project');
    }
    return summary;
  }

  /** Batches a previous Runtime left in flight; a restart reconciles them explicitly. */
  listIncompleteIntegrationBatches(): readonly IntegrationBatchPlan[] {
    return this.sqlite.query<{ id: string }, []>(`
      SELECT id FROM integration_batches
      WHERE state IN ('CREATED','PREPARING','VERIFYING','INTEGRATING_DEV') ORDER BY created_at,id
    `).all().map((row) => this.integrationBatchPlan(row.id));
  }

  /**
   * Batches that still block a new integration attempt for their members: the in-flight states plus
   * `RECOVERY_REQUIRED`, which is terminal but unresolved and therefore keeps its slot (ADR-0053).
   */
  listBlockingIntegrationBatches(): readonly IntegrationBatchPlan[] {
    return this.sqlite.query<{ id: string }, []>(`
      SELECT id FROM integration_batches
      WHERE state IN ('CREATED','PREPARING','VERIFYING','INTEGRATING_DEV','RECOVERY_REQUIRED')
      ORDER BY created_at,id
    `).all().map((row) => this.integrationBatchPlan(row.id));
  }

  listIncompleteIntegrationVerifications(): readonly IntegrationVerificationPlan[] {
    return this.sqlite.query<{ id: string }, []>(`
      SELECT id FROM integration_verification_runs
      WHERE state IN ('QUEUED','RUNNING') ORDER BY queued_at,id
    `).all().map((row) => this.integrationVerificationPlan(row.id));
  }

  // ---------------------------------------------------------------------------------------------
  // Layered verification records (ADR-0038, ADR-0039). Targeted test plans are append-only: a
  // scope change is a new row, never an edit, and the triggers in the migration refuse UPDATE and
  // DELETE outright. Dev full-suite evidence is one row per observed run.
  // ---------------------------------------------------------------------------------------------

  /**
   * Appends one targeted test plan record for its exact subject, or returns the recorded row when
   * the identical digest was already recorded for that `(task, revision, commit)`.
   */
  recordTargetedTestPlan(input: {
    readonly planId: string;
    readonly projectId: string;
    readonly taskId: string;
    readonly revisionId: string;
    readonly testedCommit: string;
    readonly planVersion: string;
    readonly planDigest: string;
    readonly sourcePath: string;
    readonly scope: string;
    readonly commands: readonly StoredVerificationCommand[];
    readonly recordedBy: string;
    readonly recordedAt: number;
  }): Readonly<{ plan: TargetedTestPlanRecord; created: boolean }> {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<{ id: string }, [string, string, string, string, string]>(`
        SELECT id FROM targeted_test_plans
        WHERE project_id=?1 AND task_id=?2 AND revision_id=?3 AND tested_commit=?4 AND plan_digest=?5
      `).get(input.projectId, input.taskId, input.revisionId, input.testedCommit, input.planDigest);
      if (existing !== null) {
        return { plan: this.targetedTestPlanRecord(existing.id), created: false };
      }
      const task = this.sqlite.query<{
        state: TaskLifecycleState; current_revision_id: string;
      }, [string, string]>(`
        SELECT t.state,t.current_revision_id FROM tasks t
        JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
        WHERE t.project_id=?1 AND t.id=?2
      `).get(input.projectId, input.taskId);
      if (task === null) {
        throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
      }
      if (task.current_revision_id !== input.revisionId) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Task revision changed before the targeted test plan was recorded');
      }
      this.sqlite.query(`
        INSERT INTO targeted_test_plans(id,project_id,task_id,revision_id,tested_commit,plan_version,
          plan_digest,source_path,commands_json,scope,recorded_by,recorded_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
      `).run(input.planId, input.projectId, input.taskId, input.revisionId, input.testedCommit,
        input.planVersion, input.planDigest, input.sourcePath, JSON.stringify(input.commands),
        input.scope, input.recordedBy, input.recordedAt);
      return { plan: this.targetedTestPlanRecord(input.planId), created: true };
    })();
  }

  /** The newest recorded plan for one exact subject, or null when nothing was recorded for it. */
  getLatestTargetedTestPlan(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly revisionId: string;
    readonly testedCommit: string;
  }): TargetedTestPlanRecord | null {
    const row = this.sqlite.query<{ id: string }, [string, string, string, string]>(`
      SELECT id FROM targeted_test_plans
      WHERE project_id=?1 AND task_id=?2 AND revision_id=?3 AND tested_commit=?4
      ORDER BY recorded_at DESC,id DESC LIMIT 1
    `).get(input.projectId, input.taskId, input.revisionId, input.testedCommit);
    return row === null ? null : this.targetedTestPlanRecord(row.id);
  }

  /** Every recorded plan of one Task, newest first: the append-only audit of its test scope. */
  listTargetedTestPlans(projectId: string, taskId: string,
    limit = 100): readonly TargetedTestPlanRecord[] {
    return this.sqlite.query<{ id: string }, [string, string, number]>(`
      SELECT id FROM targeted_test_plans WHERE project_id=?1 AND task_id=?2
      ORDER BY recorded_at DESC,id DESC LIMIT ?3
    `).all(projectId, taskId, limit).map((row) => this.targetedTestPlanRecord(row.id));
  }

  private targetedTestPlanRecord(planId: string): TargetedTestPlanRecord {
    const row = this.sqlite.query<{
      id: string; project_id: string; task_id: string; revision_id: string; tested_commit: string;
      plan_version: string; plan_digest: string; source_path: string; commands_json: string;
      scope: string; recorded_by: string; recorded_at: number;
    }, [string]>(`
      SELECT id,project_id,task_id,revision_id,tested_commit,plan_version,plan_digest,source_path,
             commands_json,scope,recorded_by,recorded_at
      FROM targeted_test_plans WHERE id=?1
    `).get(planId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Targeted test plan was not found');
    return {
      planId: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      revisionId: row.revision_id,
      testedCommit: row.tested_commit,
      planVersion: row.plan_version,
      planDigest: row.plan_digest,
      sourcePath: row.source_path,
      scope: row.scope,
      commands: JSON.parse(row.commands_json) as readonly StoredVerificationCommand[],
      recordedBy: row.recorded_by,
      recordedAt: row.recorded_at,
    };
  }

  /** Repository refs a dev full-suite run binds its evidence to; no Task is involved. */
  getDevFullSuiteCandidates(projectId: string): DevFullSuiteCandidates {
    const row = this.sqlite.query<{
      id: string; repo_root: string; main_repo_root: string; git_common_dir: string;
      main_ref: string; dev_ref: string;
      object_format: 'sha1' | 'sha256';
    }, [string]>(`
      SELECT p.id,COALESCE(p.dev_repo_path,p.repo_root) AS repo_root,
             p.repo_root AS main_repo_root,p.git_common_dir,p.main_ref,p.dev_ref,p.object_format
      FROM projects p
      JOIN project_trusts trust ON trust.project_id=p.id AND trust.status='ACTIVE'
      WHERE p.id=?1
    `).get(projectId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Active project trust was not found');
    return {
      projectId: row.id,
      repositoryRoot: row.repo_root,
      mainRepositoryRoot: row.main_repo_root,
      gitCommonDir: row.git_common_dir,
      mainRef: row.main_ref,
      devRef: row.dev_ref,
      objectFormat: row.object_format,
    };
  }

  /**
   * Records the start of one dev full-suite run. Replaying the same command ID returns the recorded
   * run instead of starting a second one; a different payload under it is refused.
   */
  beginDevFullSuiteRun(input: {
    readonly evidenceId: string;
    readonly projectId: string;
    readonly devRef: string;
    readonly devCommit: string;
    readonly policyVersion: string;
    readonly policyDigest: string;
    readonly lockfilePath: string;
    readonly lockfilePresent: boolean;
    readonly lockfileDigest: string;
    readonly commands: readonly StoredVerificationCommand[];
    readonly copyPath: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly observedBy: string;
    readonly startedAt: number;
  }): Readonly<{ evidence: DevFullSuiteEvidenceRecord; created: boolean }> {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<{ payload_hash: string; result_json: string }, [string, string]>(
        'SELECT payload_hash,result_json FROM command_receipts WHERE project_id=?1 AND command_id=?2',
      ).get(input.projectId, input.commandId);
      if (existing !== null) {
        if (existing.payload_hash !== input.payloadHash) {
          throw new StorageError('COMMAND_CONFLICT',
            'Command ID was already used with a different payload');
        }
        const recorded = JSON.parse(existing.result_json) as { evidenceId: string };
        return { evidence: this.devFullSuiteEvidenceRecord(recorded.evidenceId), created: false };
      }
      const project = this.sqlite.query<{ id: string }, [string]>(`
        SELECT p.id FROM projects p
        JOIN project_trusts trust ON trust.project_id=p.id AND trust.status='ACTIVE'
        WHERE p.id=?1
      `).get(input.projectId);
      if (project === null) {
        throw new StorageError('NOT_FOUND', 'Active project trust was not found');
      }
      this.sqlite.query(`
        INSERT INTO dev_full_suite_evidence(id,project_id,dev_ref,dev_commit,policy_version,
          policy_digest,lockfile_path,lockfile_present,lockfile_digest,commands_json,copy_path,state,
          command_id,observed_by,queued_at,started_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'RUNNING',?12,?13,?14,?14)
      `).run(input.evidenceId, input.projectId, input.devRef, input.devCommit, input.policyVersion,
        input.policyDigest, input.lockfilePath, input.lockfilePresent ? 1 : 0, input.lockfileDigest,
        JSON.stringify(input.commands), input.copyPath, input.commandId, input.observedBy,
        input.startedAt);
      this.sqlite.query(`
        INSERT INTO command_receipts(project_id,command_id,payload_hash,result_json,created_at)
        VALUES (?1,?2,?3,?4,?5)
      `).run(input.projectId, input.commandId, input.payloadHash,
        JSON.stringify({ evidenceId: input.evidenceId }), input.startedAt);
      return { evidence: this.devFullSuiteEvidenceRecord(input.evidenceId), created: true };
    })();
  }

  /** RUNNING → a terminal state with the observed evidence; the bindings are never rewritten. */
  completeDevFullSuiteRun(input: {
    readonly evidenceId: string;
    readonly state: 'PASSED' | 'FAILED' | 'ERROR';
    readonly outcomeCode: string;
    readonly evidence: VerificationEvidence;
    readonly endedAt: number;
  }): DevFullSuiteEvidenceRecord {
    return this.sqlite.transaction(() => {
      const current = this.devFullSuiteEvidenceRecord(input.evidenceId);
      if (current.state === 'PASSED' || current.state === 'FAILED' || current.state === 'ERROR') {
        return current;
      }
      const updated = this.sqlite.query(`
        UPDATE dev_full_suite_evidence
        SET state=?1,outcome_code=?2,evidence_json=?3,ended_at=?4
        WHERE id=?5 AND state IN ('QUEUED','RUNNING')
      `).run(input.state, input.outcomeCode, JSON.stringify(input.evidence), input.endedAt,
        input.evidenceId);
      if (updated.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Dev full-suite evidence changed while recording its outcome');
      }
      return this.devFullSuiteEvidenceRecord(input.evidenceId);
    })();
  }

  /**
   * Closes runs a previous Runtime left QUEUED or RUNNING. A run nobody is driving is a failure,
   * not a pass: it is recorded as `ERROR` with the fact that the Runtime restarted, and its copy
   * stays on disk for the ordinary reclamation path.
   */
  reconcileDevFullSuiteEvidence(now: number): readonly string[] {
    return this.sqlite.transaction(() => {
      const rows = this.sqlite.query<{ id: string }, []>(`
        SELECT id FROM dev_full_suite_evidence WHERE state IN ('QUEUED','RUNNING') ORDER BY queued_at,id
      `).all().map((row) => row.id);
      for (const id of rows) {
        this.sqlite.query(`
          UPDATE dev_full_suite_evidence
          SET state='ERROR',outcome_code='RUNTIME_RESTARTED',ended_at=?1,
              evidence_json=?2
          WHERE id=?3 AND state IN ('QUEUED','RUNNING')
        `).run(now, JSON.stringify({
          reason: 'the Runtime that started this full-suite run restarted before it finished;'
            + ' the observed state is not a verdict',
        }), id);
      }
      return rows;
    })();
  }

  getDevFullSuiteEvidence(projectId: string, evidenceId: string): DevFullSuiteEvidenceRecord {
    const evidence = this.devFullSuiteEvidenceRecord(evidenceId);
    if (evidence.projectId !== projectId) {
      throw new StorageError('NOT_FOUND', 'Dev full-suite evidence was not found for this project');
    }
    return evidence;
  }

  listDevFullSuiteEvidence(projectId: string,
    limit = 20): readonly DevFullSuiteEvidenceRecord[] {
    return this.sqlite.query<{ id: string }, [string, number]>(`
      SELECT id FROM dev_full_suite_evidence WHERE project_id=?1
      ORDER BY queued_at DESC,id DESC LIMIT ?2
    `).all(projectId, limit).map((row) => this.devFullSuiteEvidenceRecord(row.id));
  }

  /** Records of one exact candidate commit, newest first: what a promotion is checked against. */
  listDevFullSuiteEvidenceForCommit(projectId: string, devCommit: string,
    limit = 20): readonly DevFullSuiteEvidenceRecord[] {
    return this.sqlite.query<{ id: string }, [string, string, number]>(`
      SELECT id FROM dev_full_suite_evidence WHERE project_id=?1 AND dev_commit=?2
      ORDER BY queued_at DESC,id DESC LIMIT ?3
    `).all(projectId, devCommit, limit).map((row) => this.devFullSuiteEvidenceRecord(row.id));
  }

  private devFullSuiteEvidenceRecord(evidenceId: string): DevFullSuiteEvidenceRecord {
    const row = this.sqlite.query<{
      id: string; project_id: string; dev_ref: string; dev_commit: string; policy_version: string;
      policy_digest: string; lockfile_path: string; lockfile_present: number;
      lockfile_digest: string; commands_json: string;
      copy_path: string; state: DevFullSuiteState; outcome_code: string | null;
      evidence_json: string | null; command_id: string; observed_by: string; queued_at: number;
      started_at: number | null; ended_at: number | null;
    }, [string]>(`
      SELECT id,project_id,dev_ref,dev_commit,policy_version,policy_digest,lockfile_path,
             lockfile_present,lockfile_digest,commands_json,copy_path,state,outcome_code,
             evidence_json,command_id,observed_by,queued_at,started_at,ended_at
      FROM dev_full_suite_evidence WHERE id=?1
    `).get(evidenceId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Dev full-suite evidence was not found');
    return {
      evidenceId: row.id,
      projectId: row.project_id,
      devRef: row.dev_ref,
      devCommit: row.dev_commit,
      policyVersion: row.policy_version,
      policyDigest: row.policy_digest,
      lockfilePath: row.lockfile_path,
      lockfilePresent: row.lockfile_present === 1,
      lockfileDigest: row.lockfile_digest,
      commands: JSON.parse(row.commands_json) as readonly StoredVerificationCommand[],
      copyPath: row.copy_path,
      state: row.state,
      outcomeCode: row.outcome_code,
      evidence: row.evidence_json === null
        ? null
        : JSON.parse(row.evidence_json) as VerificationEvidence,
      commandId: row.command_id,
      observedBy: row.observed_by,
      queuedAt: row.queued_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Stable branch promotion (ADR-0009 D02/D03, ADR-0022). These methods only record facts and
  // enforce state transitions; the Git side effect (fast-forwarding the checked-out `main`
  // worktree) and the Runtime restart sequence are executed by the promotion service and its
  // client between calls, so a crash always leaves a state that can be reconciled from refs.
  // ---------------------------------------------------------------------------------------------

  /**
   * The integration evidence a promotion would fix, plus any promotion this project already has
   * open. A promotion is only ever built from records that already exist: nothing here re-runs
   * the integration verification, because the independent verification is what made `dev` move.
   */
  getPromotionCandidates(projectId: string, batchId: string): PromotionCandidates {
    const row = this.sqlite.query<{
      project_id: string; repo_root: string; git_common_dir: string; main_ref: string;
      dev_ref: string; dev_repo_path: string | null;
      object_format: 'sha1' | 'sha256';
      batch_state: IntegrationBatchState; batch_dev_ref: string; batch_dev_commit: string;
      merged_commit: string | null;
      integrated_commit: string | null;
      verification_state: VerificationState | null;
      verification_id: string | null;
      verification_tested_commit: string | null;
      verification_dev_commit: string | null;
      verification_outcome_code: string | null;
    }, [string, string]>(`
      SELECT p.id AS project_id,p.repo_root,p.git_common_dir,p.main_ref,p.dev_ref,p.dev_repo_path,
             p.object_format,
             batch.state AS batch_state,batch.dev_ref AS batch_dev_ref,
             batch.dev_commit AS batch_dev_commit,batch.merged_commit,batch.integrated_commit,
             run.state AS verification_state,run.id AS verification_id,
             run.tested_commit AS verification_tested_commit,
             run.dev_commit AS verification_dev_commit,run.outcome_code AS verification_outcome_code
      FROM integration_batches batch
      JOIN projects p ON p.id=batch.project_id
      JOIN project_trusts trust ON trust.project_id=p.id AND trust.status='ACTIVE'
      LEFT JOIN integration_verification_runs run ON run.batch_id=batch.id
      WHERE batch.project_id=?1 AND batch.id=?2
    `).get(projectId, batchId);
    if (row === null) {
      throw new StorageError('NOT_FOUND', 'Integration batch or active project trust was not found');
    }
    const open = this.sqlite.query<{ id: string }, [string]>(`
      SELECT id FROM stable_promotions
      WHERE project_id=?1 AND state IN ('CREATED','AWAITING_APPROVAL','PROMOTING','RESTARTING',
        'RECOVERY_REQUIRED')
    `).get(projectId);
    return {
      projectId: row.project_id,
      batchId,
      repositoryRoot: row.repo_root,
      gitCommonDir: row.git_common_dir,
      mainRef: row.main_ref,
      devRef: row.dev_ref,
      devRepoPath: row.dev_repo_path,
      objectFormat: row.object_format,
      batchState: row.batch_state,
      batchDevRef: row.batch_dev_ref,
      batchDevCommit: row.batch_dev_commit,
      batchMergedCommit: row.merged_commit,
      batchIntegratedCommit: row.integrated_commit,
      verificationState: row.verification_state,
      verificationId: row.verification_id,
      verificationTestedCommit: row.verification_tested_commit,
      verificationDevCommit: row.verification_dev_commit,
      verificationOutcomeCode: row.verification_outcome_code,
      members: this.stablePromotionBatchMembers(projectId, batchId),
      openPromotion: open === null ? null : this.stablePromotionSummary(open.id),
    };
  }

  /**
   * Fixes the promotion's three facts and its member revisions. Every value is copied from a
   * record that already exists, so the promotion can be re-checked later against the same claim.
   */
  beginStablePromotion(input: {
    readonly projectId: string;
    readonly batchId: string;
    readonly promotionId: string;
    readonly operationId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly createdEventId: string;
    readonly devRef: string;
    readonly mainRef: string;
    readonly candidateCommit: string;
    readonly expectedMainCommit: string;
    readonly verificationId: string;
    readonly verificationTestedCommit: string;
    /** The verified dev clone this promotion will push from; re-checked on every side-effecting call. */
    readonly devRepoPath: string | null;
    /** The dev full-suite evidence triple this promotion is fixed to (ADR-0039). */
    readonly fullSuiteEvidenceId: string;
    readonly fullSuiteDevCommit: string;
    readonly fullSuitePolicyVersion: string;
    readonly fullSuitePolicyDigest: string;
    readonly fullSuiteLockfileDigest: string;
    readonly permissionMode: PromotionPermissionMode;
    readonly actor: string;
    readonly createdAt: number;
  }): Readonly<{ plan: StablePromotionPlan; created: boolean }> {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<{ payload_hash: string; result_json: string }, [string, string]>(
        'SELECT payload_hash,result_json FROM command_receipts WHERE project_id=?1 AND command_id=?2',
      ).get(input.projectId, input.commandId);
      if (existing !== null) {
        if (existing.payload_hash !== input.payloadHash) {
          throw new StorageError('COMMAND_CONFLICT',
            'Command ID was already used with a different payload');
        }
        const recorded = JSON.parse(existing.result_json) as { promotionId: string };
        return { plan: this.stablePromotionPlan(recorded.promotionId), created: false };
      }
      const open = this.sqlite.query<{ id: string; state: StablePromotionState }, [string]>(`
        SELECT id,state FROM stable_promotions
        WHERE project_id=?1 AND state IN ('CREATED','AWAITING_APPROVAL','PROMOTING','RESTARTING',
          'RECOVERY_REQUIRED')
      `).get(input.projectId);
      if (open !== null) {
        throw new StorageError('INVALID_STATE',
          `Promotion ${open.id} is ${open.state}; it must be resumed or abandoned first`);
      }
      const project = this.sqlite.query<{
        repo_root: string; main_ref: string; dev_ref: string; dev_repo_path: string | null;
        object_format: 'sha1' | 'sha256';
      }, [string]>(`
        SELECT p.repo_root,p.main_ref,p.dev_ref,p.dev_repo_path,p.object_format FROM projects p
        JOIN project_trusts trust ON trust.project_id=p.id AND trust.status='ACTIVE'
        WHERE p.id=?1
      `).get(input.projectId);
      if (project === null) {
        throw new StorageError('NOT_FOUND', 'Active project trust was not found');
      }
      if (project.dev_ref !== input.devRef || project.main_ref !== input.mainRef) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Project baseline refs changed before the promotion was prepared');
      }
      if (project.dev_repo_path !== input.devRepoPath) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'The project dev clone changed before the promotion was prepared');
      }
      this.sqlite.query(`
        INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,request_json,
          created_at,updated_at)
        VALUES (?1,?2,'PROMOTE_STABLE_BRANCH',?3,?4,'PLANNED',?5,?6,?6)
      `).run(input.operationId, input.projectId, input.promotionId, input.commandId,
        JSON.stringify({ promotionId: input.promotionId, batchId: input.batchId,
          devRef: input.devRef, mainRef: input.mainRef, candidateCommit: input.candidateCommit,
          expectedMainCommit: input.expectedMainCommit, verificationId: input.verificationId,
          devRepoPath: input.devRepoPath }),
        input.createdAt);
      this.sqlite.query(`
        INSERT INTO stable_promotions(id,project_id,dev_ref,main_ref,candidate_commit,
          expected_main_commit,integration_batch_id,verification_id,verification_tested_commit,
          permission_mode,state,created_at,full_suite_evidence_id,full_suite_dev_commit,
          full_suite_policy_version,full_suite_policy_digest,full_suite_lockfile_digest,dev_repo_path)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'CREATED',?11,?12,?13,?14,?15,?16,?17)
      `).run(input.promotionId, input.projectId, input.devRef, input.mainRef,
        input.candidateCommit, input.expectedMainCommit, input.batchId, input.verificationId,
        input.verificationTestedCommit, input.permissionMode, input.createdAt,
        input.fullSuiteEvidenceId, input.fullSuiteDevCommit, input.fullSuitePolicyVersion,
        input.fullSuitePolicyDigest, input.fullSuiteLockfileDigest, input.devRepoPath);
      for (const member of this.stablePromotionBatchMembers(input.projectId, input.batchId)) {
        this.sqlite.query(`
          INSERT INTO stable_promotion_members(promotion_id,batch_id,project_id,task_id,revision_id,
            execution_id,candidate_commit,created_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
        `).run(input.promotionId, input.batchId, input.projectId, member.taskId,
          member.revisionId, member.executionId, member.candidateCommit, input.createdAt);
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'PromotionCreated',1,'Promotion',?3,0,?4,?4,?5,?6)
      `).run(input.createdEventId, input.projectId, input.promotionId, input.commandId,
        input.createdAt, JSON.stringify({ promotionId: input.promotionId, batchId: input.batchId,
          devRef: input.devRef, mainRef: input.mainRef, candidateCommit: input.candidateCommit,
          expectedMainCommit: input.expectedMainCommit, verificationId: input.verificationId,
          fullSuiteEvidenceId: input.fullSuiteEvidenceId,
          fullSuiteDevCommit: input.fullSuiteDevCommit,
          fullSuitePolicyDigest: input.fullSuitePolicyDigest,
          fullSuiteLockfileDigest: input.fullSuiteLockfileDigest,
          permissionMode: input.permissionMode, actor: input.actor }));
      this.sqlite.query(`
        INSERT INTO command_receipts(project_id,command_id,payload_hash,result_json,created_at)
        VALUES (?1,?2,?3,?4,?5)
      `).run(input.projectId, input.commandId, input.payloadHash,
        JSON.stringify({ promotionId: input.promotionId }), input.createdAt);
      return { plan: this.stablePromotionPlan(input.promotionId), created: true };
    })();
  }

  /**
   * Records the STRICT approval of exactly the fixed triple. The approved values are copied from
   * the promotion's own fixed evidence, so an approval can only ever mean those three facts — and
   * `promote` re-reads both refs so a movement after this point invalidates it.
   */
  approveStablePromotion(input: {
    readonly promotionId: string;
    readonly actor: string;
    readonly approvedAt: number;
    readonly eventId: string;
  }): StablePromotionPlan {
    return this.sqlite.transaction(() => {
      const promotion = this.stablePromotionPlan(input.promotionId);
      if (promotion.state === 'AWAITING_APPROVAL') return promotion;
      if (promotion.state !== 'CREATED') {
        throw new StorageError('INVALID_STATE',
          `Promotion is ${promotion.state}; only a CREATED promotion can be approved`);
      }
      const updated = this.sqlite.query(`
        UPDATE stable_promotions
        SET state='AWAITING_APPROVAL',approved_dev_commit=candidate_commit,
            approved_main_commit=expected_main_commit,approved_verification_id=verification_id,
            approved_full_suite_evidence_id=full_suite_evidence_id,approved_at=?1
        WHERE id=?2 AND state='CREATED'
      `).run(input.approvedAt, input.promotionId);
      if (updated.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Promotion changed while recording its approval');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'PromotionApproved',1,'Promotion',?3,0,?1,?1,?4,?5)
      `).run(input.eventId, promotion.projectId, input.promotionId, input.approvedAt,
        JSON.stringify({ promotionId: input.promotionId, devRef: promotion.devRef,
          mainRef: promotion.mainRef, candidateCommit: promotion.candidateCommit,
          expectedMainCommit: promotion.expectedMainCommit,
          verificationId: promotion.verificationId,
          fullSuiteEvidenceId: promotion.fullSuite?.evidenceId ?? null,
          actor: input.actor }));
      return this.stablePromotionPlan(input.promotionId);
    })();
  }

  /**
   * Records the readback of the remote `dev` ref after the fixed candidate was pushed, and moves
   * CREATED/AWAITING_APPROVAL → PROMOTING (ADR-0047 D02/D03).
   *
   * The value stored here is the commit Git reported for the remote ref, not the commit that was
   * pushed: entering PROMOTING means "the candidate is on the remote and the main checkout has not
   * pulled it yet", which is exactly the distinction "push exited 0" cannot make. STRICT requires a
   * recorded approval that still matches the fixed triple; that is the only gate.
   */
  startStablePromotion(input: {
    readonly promotionId: string;
    readonly devRepoPath: string;
    /** Read back from the remote dev ref by `git ls-remote` after the push. */
    readonly remoteDevCommit: string;
    readonly permissionMode: PromotionPermissionMode;
    readonly pushedAt: number;
    readonly eventId: string;
  }): StablePromotionPlan {
    return this.sqlite.transaction(() => {
      const promotion = this.stablePromotionPlan(input.promotionId);
      if (promotion.state !== 'CREATED' && promotion.state !== 'AWAITING_APPROVAL') {
        return promotion;
      }
      if (input.permissionMode === 'STRICT') {
        const approval = promotion.approval;
        if (promotion.state !== 'AWAITING_APPROVAL' || approval === null
          || approval.devCommit !== promotion.candidateCommit
          || approval.mainCommit !== promotion.expectedMainCommit
          || approval.verificationId !== promotion.verificationId
          || approval.fullSuiteEvidenceId !== (promotion.fullSuite?.evidenceId ?? null)) {
          throw new StorageError('INVALID_STATE',
            'STRICT mode needs a recorded approval of this dev/main/verification/full-suite-evidence'
            + ' triple before promoting');
        }
      }
      if (input.remoteDevCommit !== promotion.candidateCommit) {
        throw new StorageError('INVALID_STATE',
          'The remote dev readback must be the fixed candidate commit; a promotion is never recorded'
          + ' as pushed when the remote holds something else');
      }
      const updated = this.sqlite.query(`
        UPDATE stable_promotions
        SET state='PROMOTING',dev_repo_path=?1,remote_dev_commit=?2,pushed_at=?3,
            permission_mode=?4,outcome_code=NULL,detail=NULL
        WHERE id=?5 AND state IN ('CREATED','AWAITING_APPROVAL')
      `).run(input.devRepoPath, input.remoteDevCommit, input.pushedAt, input.permissionMode,
        input.promotionId);
      const operation = this.sqlite.query(`
        UPDATE operations SET state='IN_PROGRESS',updated_at=?1
        WHERE id=?2 AND state IN ('PLANNED','RECONCILE_REQUIRED')
      `).run(input.pushedAt, promotion.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Promotion changed while recording its dev push');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'PromotionDevPushed',1,'Promotion',?3,0,?1,?1,?4,?5)
      `).run(input.eventId, promotion.projectId, input.promotionId, input.pushedAt,
        JSON.stringify({ promotionId: input.promotionId, devRef: promotion.devRef,
          mainRef: promotion.mainRef, candidateCommit: promotion.candidateCommit,
          expectedMainCommit: promotion.expectedMainCommit, devRepoPath: input.devRepoPath,
          remoteDevCommit: input.remoteDevCommit, remote: 'origin',
          awaitingPullFrom: promotion.mainRef }));
      return this.stablePromotionPlan(input.promotionId);
    })();
  }

  /**
   * Records a refused push attempt on an open record **without changing its state**: the promotion
   * stays prepared so the same command can be retried once the remote is reachable again. Nothing
   * about the remote or the local refs is claimed by this row — it exists so the failure is
   * auditable and readable in `promotion get` instead of only in one client's stderr.
   */
  recordStablePromotionPushFailure(input: {
    readonly promotionId: string;
    readonly outcomeCode: string;
    readonly detail: string;
    readonly eventId: string;
    readonly at: number;
  }): StablePromotionPlan {
    return this.sqlite.transaction(() => {
      const promotion = this.stablePromotionPlan(input.promotionId);
      if (promotion.state === 'STALE' || promotion.state === 'FAILED'
        || promotion.state === 'SUCCEEDED') {
        return promotion;
      }
      const updated = this.sqlite.query(`
        UPDATE stable_promotions SET outcome_code=?1,detail=?2
        WHERE id=?3 AND state IN ('CREATED','AWAITING_APPROVAL','PROMOTING','RESTARTING',
          'RECOVERY_REQUIRED')
      `).run(input.outcomeCode, input.detail, input.promotionId);
      if (updated.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Promotion changed while recording its refused push');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'PromotionPushRefused',1,'Promotion',?3,0,?1,?1,?4,?5)
      `).run(input.eventId, promotion.projectId, input.promotionId, input.at,
        JSON.stringify({ promotionId: input.promotionId, devRef: promotion.devRef,
          mainRef: promotion.mainRef, candidateCommit: promotion.candidateCommit,
          state: promotion.state, outcomeCode: input.outcomeCode, detail: input.detail }));
      return this.stablePromotionPlan(input.promotionId);
    })();
  }

  /**
   * PROMOTING → RESTARTING once the main checkout was observed at the fixed candidate, i.e. the
   * user pulled the pushed dev candidate (ADR-0047 D03).
   *
   * The restart plan is recorded here rather than before the push, because the plan has to name the
   * worktree the pull landed in; recording it before that would describe a worktree state that did
   * not exist yet. `promotingBootId` is the boot that read the pull, so a restart can only be
   * recorded from a Runtime that is not this one.
   */
  recordStablePromotionMainUpdate(input: {
    readonly promotionId: string;
    readonly promotedCommit: string;
    readonly mainWorktreePath: string;
    readonly restartSteps: readonly PromotionRestartPlanStep[];
    readonly promotingBootId: string;
    readonly observedAt: number;
    readonly eventId: string;
  }): StablePromotionPlan {
    return this.sqlite.transaction(() => {
      const promotion = this.stablePromotionPlan(input.promotionId);
      if (promotion.state !== 'PROMOTING') return promotion;
      const updated = this.sqlite.query(`
        UPDATE stable_promotions SET state='RESTARTING',promoted_commit=?1,main_worktree_path=?2,
            restart_steps_json=?3,promoting_boot_id=?4,outcome_code=NULL,detail=NULL
        WHERE id=?5 AND state='PROMOTING'
      `).run(input.promotedCommit, input.mainWorktreePath, JSON.stringify(input.restartSteps),
        input.promotingBootId, input.promotionId);
      if (updated.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Promotion changed while recording its main update');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'PromotionMainUpdated',1,'Promotion',?3,0,?1,?1,?4,?5)
      `).run(input.eventId, promotion.projectId, input.promotionId, input.observedAt,
        JSON.stringify({ promotionId: input.promotionId, mainRef: promotion.mainRef,
          expectedMainCommit: promotion.expectedMainCommit,
          promotedCommit: input.promotedCommit, candidateCommit: promotion.candidateCommit,
          remoteDevCommit: promotion.remoteDevCommit,
          mainWorktreePath: input.mainWorktreePath, restartSteps: input.restartSteps }));
      return this.stablePromotionPlan(input.promotionId);
    })();
  }

  /**
   * Records the observed restart result (ADR-0009 D03) on a promotion whose main checkout was
   * observed at the candidate.
   *
   * A failing restart ends the promotion as FAILED with the evidence that caused it. A successful
   * one **does not** end it: `main` is at the candidate and the Runtime is back, but the stable
   * commit is not published on the remote yet, and ADR-0047 D01 puts that push after the restart.
   * The record therefore stays RESTARTING with `MAIN_PUSH_PENDING` until `recordStablePromotionMainPush`
   * read back the remote. "Main is updated and restarted" is never reported as a promotion by itself.
   */
  recordStablePromotionRestart(input: {
    readonly promotionId: string;
    readonly state: 'RESTARTED' | 'FAILED';
    readonly outcomeCode: string;
    readonly restart: PromotionRestartResult;
    readonly detail: string;
    readonly eventId: string;
    readonly completedEventId: string;
    readonly completedAt: number;
  }): StablePromotionPlan {
    return this.sqlite.transaction(() => {
      const promotion = this.stablePromotionPlan(input.promotionId);
      if (promotion.state === 'SUCCEEDED' || promotion.state === 'FAILED') return promotion;
      if (promotion.state !== 'RESTARTING' && promotion.state !== 'RECOVERY_REQUIRED') {
        throw new StorageError('INVALID_STATE',
          `Promotion is ${promotion.state}; only a promotion whose main update was observed can record a restart`);
      }
      const updated = input.state === 'RESTARTED'
        ? this.sqlite.query(`
            UPDATE stable_promotions
            SET state='RESTARTING',restart_result_json=?1,outcome_code=?2,detail=?3
            WHERE id=?4 AND state IN ('RESTARTING','RECOVERY_REQUIRED')
          `).run(JSON.stringify(input.restart), input.outcomeCode, input.detail, input.promotionId)
        : this.sqlite.query(`
            UPDATE stable_promotions
            SET state='FAILED',restart_result_json=?1,outcome_code=?2,detail=?3,completed_at=?4
            WHERE id=?5 AND state IN ('RESTARTING','RECOVERY_REQUIRED')
          `).run(JSON.stringify(input.restart), input.outcomeCode, input.detail,
            input.completedAt, input.promotionId);
      const operation = input.state === 'RESTARTED'
        ? this.sqlite.query(`
            UPDATE operations SET state='IN_PROGRESS',updated_at=?1
            WHERE id=?2 AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED')
          `).run(input.completedAt, promotion.operationId)
        : this.sqlite.query(`
            UPDATE operations SET state='FAILED',result_json=?1,updated_at=?2
            WHERE id=?3 AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED')
          `).run(JSON.stringify({ promotionId: input.promotionId, state: 'FAILED',
            outcomeCode: input.outcomeCode, promotedCommit: promotion.promotedCommit }),
            input.completedAt, promotion.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Promotion changed while recording its restart result');
      }
      const recordedState = input.state === 'RESTARTED' ? 'RESTARTING' : 'FAILED';
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'PromotionRestartRecorded',1,'Promotion',?3,0,?1,?1,?4,?5)
      `).run(input.completedEventId, promotion.projectId, input.promotionId, input.completedAt,
        JSON.stringify({ promotionId: input.promotionId, mainRef: promotion.mainRef,
          promotedCommit: promotion.promotedCommit, state: recordedState,
          outcomeCode: input.outcomeCode, observedBootId: input.restart.observedBootId,
          runtimeStatus: input.restart.runtimeStatus, uiRunning: input.restart.uiRunning,
          steps: input.restart.steps }));
      if (input.state === 'FAILED') {
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'PromotionFailed',1,'Promotion',?3,0,?4,?4,?5,?6)
        `).run(input.eventId, promotion.projectId, input.promotionId, input.completedEventId,
          input.completedAt,
          JSON.stringify({ promotionId: input.promotionId, devRef: promotion.devRef,
            mainRef: promotion.mainRef, candidateCommit: promotion.candidateCommit,
            expectedMainCommit: promotion.expectedMainCommit,
            promotedCommit: promotion.promotedCommit, state: 'FAILED',
            outcomeCode: input.outcomeCode, detail: input.detail }));
      }
      return this.stablePromotionPlan(input.promotionId);
    })();
  }

  /**
   * Publishes (or fails to publish) the stable commit on the remote `main`, and with it decides the
   * promotion's outcome (ADR-0047 D01/D02).
   *
   * `remoteMainCommit` is the value read back from the remote, or null when the push was refused or
   * the readback did not match. Only a non-null readback equal to the candidate completes the
   * promotion as SUCCEEDED; a failed publish keeps the record open in RESTARTING/MAIN_PUSH_PENDING
   * with the failure recorded, so the same command can retry the publish without stopping the
   * Runtime again — nothing is rolled back and nothing is claimed.
   */
  recordStablePromotionMainPush(input: {
    readonly promotionId: string;
    readonly remoteMainCommit: string | null;
    readonly outcomeCode: string;
    readonly detail: string;
    readonly eventId: string;
    readonly at: number;
  }): StablePromotionPlan {
    return this.sqlite.transaction(() => {
      const promotion = this.stablePromotionPlan(input.promotionId);
      if (promotion.state === 'SUCCEEDED' || promotion.state === 'FAILED') return promotion;
      if (promotion.state !== 'RESTARTING') {
        throw new StorageError('INVALID_STATE',
          `Promotion is ${promotion.state}; only a promotion whose restart was recorded can publish main`);
      }
      if (promotion.restart === null) {
        throw new StorageError('INVALID_STATE',
          'The promotion has no recorded restart result; main is never published before the restart');
      }
      if (input.remoteMainCommit === null) {
        const updated = this.sqlite.query(`
          UPDATE stable_promotions SET outcome_code=?1,detail=?2
          WHERE id=?3 AND state='RESTARTING'
        `).run(input.outcomeCode, input.detail, input.promotionId);
        if (updated.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION',
            'Promotion changed while recording its refused main publish');
        }
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'PromotionMainPushRefused',1,'Promotion',?3,0,?1,?1,?4,?5)
        `).run(input.eventId, promotion.projectId, input.promotionId, input.at,
          JSON.stringify({ promotionId: input.promotionId, mainRef: promotion.mainRef,
            candidateCommit: promotion.candidateCommit, promotedCommit: promotion.promotedCommit,
            outcomeCode: input.outcomeCode, detail: input.detail }));
        return this.stablePromotionPlan(input.promotionId);
      }
      if (input.remoteMainCommit !== promotion.candidateCommit) {
        throw new StorageError('INVALID_STATE',
          'The remote main readback must be the promoted commit; the remote holds something else');
      }
      const updated = this.sqlite.query(`
        UPDATE stable_promotions
        SET state='SUCCEEDED',remote_main_commit=?1,main_pushed_at=?2,outcome_code=?3,detail=?4,
            completed_at=?2
        WHERE id=?5 AND state='RESTARTING'
      `).run(input.remoteMainCommit, input.at, input.outcomeCode, input.detail, input.promotionId);
      const operation = this.sqlite.query(`
        UPDATE operations SET state='SUCCEEDED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED')
      `).run(JSON.stringify({ promotionId: input.promotionId, state: 'SUCCEEDED',
        outcomeCode: input.outcomeCode, promotedCommit: promotion.promotedCommit,
        remoteMainCommit: input.remoteMainCommit }), input.at, promotion.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Promotion changed while publishing its main commit');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'PromotionCompleted',1,'Promotion',?3,0,?1,?1,?4,?5)
      `).run(input.eventId, promotion.projectId, input.promotionId, input.at,
        JSON.stringify({ promotionId: input.promotionId, devRef: promotion.devRef,
          mainRef: promotion.mainRef, candidateCommit: promotion.candidateCommit,
          expectedMainCommit: promotion.expectedMainCommit,
          remoteDevCommit: promotion.remoteDevCommit,
          promotedCommit: promotion.promotedCommit, remoteMainCommit: input.remoteMainCommit,
          state: 'SUCCEEDED', outcomeCode: input.outcomeCode, detail: input.detail }));
      return this.stablePromotionPlan(input.promotionId);
    })();
  }

  /**
   * Marks a recorded promotion unusable because a ref or the evidence moved. STALE is terminal:
   * the candidate has to be prepared and approved again. It is refused once the pull has been
   * observed (RESTARTING and beyond), because there `main` really is on the candidate and STALE
   * would read as "nothing happened".
   */
  markStablePromotionStale(input: {
    readonly promotionId: string;
    readonly outcomeCode: string;
    readonly reason: string;
    readonly eventId: string;
    readonly at: number;
  }): StablePromotionPlan {
    return this.sqlite.transaction(() => {
      const promotion = this.stablePromotionPlan(input.promotionId);
      if (promotion.state === 'STALE') return promotion;
      if (promotion.state !== 'CREATED' && promotion.state !== 'AWAITING_APPROVAL'
        && promotion.state !== 'PROMOTING') {
        throw new StorageError('INVALID_STATE',
          `Promotion is ${promotion.state}; only a promotion whose pull was not observed yet can be stale`);
      }
      const updated = this.sqlite.query(`
        UPDATE stable_promotions SET state='STALE',outcome_code=?1,detail=?2,completed_at=?3
        WHERE id=?4 AND state IN ('CREATED','AWAITING_APPROVAL','PROMOTING')
      `).run(input.outcomeCode, input.reason, input.at, input.promotionId);
      const operation = this.sqlite.query(`
        UPDATE operations SET state='FAILED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED')
      `).run(JSON.stringify({ promotionId: input.promotionId, state: 'STALE',
        outcomeCode: input.outcomeCode }), input.at, promotion.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Promotion changed while marking it stale');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'PromotionStale',1,'Promotion',?3,0,?1,?1,?4,?5)
      `).run(input.eventId, promotion.projectId, input.promotionId, input.at,
        JSON.stringify({ promotionId: input.promotionId, devRef: promotion.devRef,
          mainRef: promotion.mainRef, candidateCommit: promotion.candidateCommit,
          expectedMainCommit: promotion.expectedMainCommit,
          verificationId: promotion.verificationId, outcomeCode: input.outcomeCode,
          reason: input.reason }));
      return this.stablePromotionPlan(input.promotionId);
    })();
  }

  /**
   * Terminal failure without touching a ref: the caller only uses this when `main` was not
   * advanced, or when the restart result is known to have failed.
   */
  failStablePromotion(input: {
    readonly promotionId: string;
    readonly outcomeCode: string;
    readonly detail: string;
    readonly eventId: string;
    readonly failedAt: number;
  }): StablePromotionPlan {
    return this.sqlite.transaction(() => {
      const promotion = this.stablePromotionPlan(input.promotionId);
      if (promotion.state === 'FAILED') return promotion;
      if (promotion.state === 'SUCCEEDED' || promotion.state === 'STALE') {
        throw new StorageError('INVALID_STATE',
          `Promotion is ${promotion.state}; it cannot be failed after that outcome`);
      }
      const promoted = promotion.promotedCommit;
      const updated = this.sqlite.query(`
        UPDATE stable_promotions SET state='FAILED',outcome_code=?1,detail=?2,completed_at=?3,
            promoted_commit=?4
        WHERE id=?5 AND state IN ('CREATED','AWAITING_APPROVAL','PROMOTING','RESTARTING',
          'RECOVERY_REQUIRED')
      `).run(input.outcomeCode, input.detail, input.failedAt, promoted, input.promotionId);
      const operation = this.sqlite.query(`
        UPDATE operations SET state='FAILED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED')
      `).run(JSON.stringify({ promotionId: input.promotionId, state: 'FAILED',
        outcomeCode: input.outcomeCode, promotedCommit: promoted }), input.failedAt,
        promotion.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Promotion changed while recording its failure');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'PromotionFailed',1,'Promotion',?3,0,?1,?1,?4,?5)
      `).run(input.eventId, promotion.projectId, input.promotionId, input.failedAt,
        JSON.stringify({ promotionId: input.promotionId, devRef: promotion.devRef,
          mainRef: promotion.mainRef, candidateCommit: promotion.candidateCommit,
          expectedMainCommit: promotion.expectedMainCommit,
          promotedCommit: promoted, state: 'FAILED', outcomeCode: input.outcomeCode,
          detail: input.detail }));
      return this.stablePromotionPlan(input.promotionId);
    })();
  }

  /**
   * Reconciliation entry for a promotion a restart found in flight. The caller has already read
   * `main`, so the record states what was observed instead of assuming the ref did not move. It is
   * resumable (the restart sequence can be re-run without a second ref write) and until then it
   * blocks a new promotion for the project.
   */
  markStablePromotionRecoveryRequired(input: {
    readonly promotionId: string;
    readonly outcomeCode: string;
    readonly reason: string;
    readonly promotedCommit: string | null;
    readonly eventId: string;
    readonly at: number;
  }): StablePromotionPlan {
    return this.sqlite.transaction(() => {
      const promotion = this.stablePromotionPlan(input.promotionId);
      if (promotion.state === 'RECOVERY_REQUIRED') return promotion;
      if (promotion.state !== 'PROMOTING' && promotion.state !== 'RESTARTING') {
        throw new StorageError('INVALID_STATE',
          `Promotion is ${promotion.state}; only an in-flight promotion needs reconciliation`);
      }
      const updated = this.sqlite.query(`
        UPDATE stable_promotions
        SET state='RECOVERY_REQUIRED',outcome_code=?1,detail=?2,promoted_commit=?3
        WHERE id=?4 AND state IN ('PROMOTING','RESTARTING')
      `).run(input.outcomeCode, input.reason,
        input.promotedCommit ?? promotion.promotedCommit, input.promotionId);
      const operation = this.sqlite.query(`
        UPDATE operations SET state='RECONCILE_REQUIRED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state IN ('PLANNED','IN_PROGRESS')
      `).run(JSON.stringify({ promotionId: input.promotionId, state: 'RECOVERY_REQUIRED',
        outcomeCode: input.outcomeCode }), input.at, promotion.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Promotion changed while recording its recovery');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'PromotionReconcileRequired',1,'Promotion',?3,0,?1,?1,?4,?5)
      `).run(input.eventId, promotion.projectId, input.promotionId, input.at,
        JSON.stringify({ promotionId: input.promotionId, devRef: promotion.devRef,
          mainRef: promotion.mainRef, candidateCommit: promotion.candidateCommit,
          expectedMainCommit: promotion.expectedMainCommit,
          promotedCommit: input.promotedCommit ?? promotion.promotedCommit,
          previousState: promotion.state, outcomeCode: input.outcomeCode,
          reason: input.reason }));
      return this.stablePromotionPlan(input.promotionId);
    })();
  }

  /**
   * The promotion one command already produced, so a replayed `promotion.prepare` reaches its own
   * record instead of being refused as a second attempt.
   */
  findStablePromotionByCommand(projectId: string, commandId: string): StablePromotionPlan | null {
    const receipt = this.sqlite.query<{ result_json: string }, [string, string]>(`
      SELECT receipt.result_json FROM command_receipts receipt
      JOIN stable_promotions promotion ON promotion.id=json_extract(receipt.result_json,'$.promotionId')
      WHERE receipt.project_id=?1 AND receipt.command_id=?2
    `).get(projectId, commandId);
    if (receipt === null) return null;
    const recorded = JSON.parse(receipt.result_json) as { promotionId?: string };
    if (recorded.promotionId === undefined) return null;
    return this.stablePromotionPlan(recorded.promotionId);
  }

  /**
   * The project's open promotion, or null. A second attempt must not race an open record, and the
   * remote-movement checks need to know which record a refusal invalidates (ADR-0047 D02).
   */
  getOpenStablePromotion(projectId: string): StablePromotionSummary | null {
    const row = this.sqlite.query<{ id: string }, [string]>(`
      SELECT id FROM stable_promotions
      WHERE project_id=?1 AND state IN ('CREATED','AWAITING_APPROVAL','PROMOTING','RESTARTING',
        'RECOVERY_REQUIRED')
      ORDER BY created_at DESC,id LIMIT 1
    `).get(projectId);
    return row === null ? null : this.stablePromotionSummary(row.id);
  }

  listStablePromotions(projectId: string, limit = 20): readonly StablePromotionSummary[] {
    return this.sqlite.query<{ id: string }, [string, number]>(`
      SELECT id FROM stable_promotions WHERE project_id=?1 ORDER BY created_at DESC,id LIMIT ?2
    `).all(projectId, limit).map((row) => this.stablePromotionSummary(row.id));
  }

  getStablePromotion(projectId: string, promotionId: string): StablePromotionSummary {
    const summary = this.stablePromotionSummary(promotionId);
    if (summary.projectId !== projectId) {
      throw new StorageError('NOT_FOUND', 'Promotion was not found for this project');
    }
    return summary;
  }

  /** The plan form: project refs, object format and Operation state, for a state-changing call. */
  getStablePromotionPlan(projectId: string, promotionId: string): StablePromotionPlan {
    const plan = this.stablePromotionPlan(promotionId);
    if (plan.projectId !== projectId) {
      throw new StorageError('NOT_FOUND', 'Promotion was not found for this project');
    }
    return plan;
  }

  /** Promotions a previous Runtime left in flight; a restart reconciles them explicitly. */
  listIncompleteStablePromotions(): readonly StablePromotionPlan[] {
    return this.sqlite.query<{ id: string }, []>(`
      SELECT id FROM stable_promotions WHERE state IN ('PROMOTING','RESTARTING')
      ORDER BY created_at,id
    `).all().map((row) => this.stablePromotionPlan(row.id));
  }

  private stablePromotionBatchMembers(projectId: string, batchId: string): readonly PromotionMember[] {
    return this.sqlite.query<{
      batch_id: string; task_id: string; revision_id: string; execution_id: string;
      candidate_commit: string;
    }, [string, string]>(`
      SELECT batch_id,task_id,revision_id,execution_id,candidate_commit
      FROM integration_batch_items WHERE project_id=?1 AND batch_id=?2 ORDER BY task_id
    `).all(projectId, batchId).map((row) => ({
      batchId: row.batch_id,
      taskId: row.task_id,
      revisionId: row.revision_id,
      executionId: row.execution_id,
      candidateCommit: row.candidate_commit,
    }));
  }

  private stablePromotionSummary(promotionId: string): StablePromotionSummary {
    const row = this.sqlite.query<{
      id: string; project_id: string; dev_ref: string; main_ref: string; candidate_commit: string;
      expected_main_commit: string; integration_batch_id: string; verification_id: string;
      verification_tested_commit: string; permission_mode: PromotionPermissionMode;
      state: StablePromotionState; approved_dev_commit: string | null;
      approved_main_commit: string | null; approved_verification_id: string | null;
      approved_full_suite_evidence_id: string | null;
      approved_at: number | null; promoted_commit: string | null; main_worktree_path: string | null;
      promoting_boot_id: string | null;
      full_suite_evidence_id: string | null; full_suite_dev_commit: string | null;
      full_suite_policy_version: string | null; full_suite_policy_digest: string | null;
      full_suite_lockfile_digest: string | null;
      restart_steps_json: string | null; restart_result_json: string | null;
      dev_repo_path: string | null; remote_dev_commit: string | null;
      remote_main_commit: string | null; pushed_at: number | null; main_pushed_at: number | null;
      outcome_code: string | null; detail: string | null; created_at: number;
      completed_at: number | null;
    }, [string]>(`
      SELECT id,project_id,dev_ref,main_ref,candidate_commit,expected_main_commit,
             integration_batch_id,verification_id,verification_tested_commit,permission_mode,state,
             approved_dev_commit,approved_main_commit,approved_verification_id,
             approved_full_suite_evidence_id,approved_at,
             promoted_commit,main_worktree_path,promoting_boot_id,full_suite_evidence_id,
             full_suite_dev_commit,full_suite_policy_version,full_suite_policy_digest,
             full_suite_lockfile_digest,restart_steps_json,
             restart_result_json,dev_repo_path,remote_dev_commit,remote_main_commit,pushed_at,
             main_pushed_at,outcome_code,detail,created_at,completed_at
      FROM stable_promotions WHERE id=?1
    `).get(promotionId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Promotion was not found');
    const restart = row.restart_result_json === null
      ? null
      : JSON.parse(row.restart_result_json) as PromotionRestartResult;
    return {
      promotionId: row.id,
      projectId: row.project_id,
      devRef: row.dev_ref,
      mainRef: row.main_ref,
      candidateCommit: row.candidate_commit,
      expectedMainCommit: row.expected_main_commit,
      integrationBatchId: row.integration_batch_id,
      verificationId: row.verification_id,
      verificationTestedCommit: row.verification_tested_commit,
      permissionMode: row.permission_mode,
      state: row.state,
      approval: row.approved_at === null || row.approved_dev_commit === null
        || row.approved_main_commit === null || row.approved_verification_id === null
        ? null
        : {
            devCommit: row.approved_dev_commit,
            mainCommit: row.approved_main_commit,
            verificationId: row.approved_verification_id,
            fullSuiteEvidenceId: row.approved_full_suite_evidence_id,
            approvedAt: row.approved_at,
          },
      fullSuite: row.full_suite_evidence_id === null || row.full_suite_dev_commit === null
        || row.full_suite_policy_version === null || row.full_suite_policy_digest === null
        || row.full_suite_lockfile_digest === null
        ? null
        : {
            evidenceId: row.full_suite_evidence_id,
            devCommit: row.full_suite_dev_commit,
            policyVersion: row.full_suite_policy_version,
            policyDigest: row.full_suite_policy_digest,
            lockfileDigest: row.full_suite_lockfile_digest,
          },
      promotedCommit: row.promoted_commit,
      mainWorktreePath: row.main_worktree_path,
      promotingBootId: row.promoting_boot_id,
      devRepoPath: row.dev_repo_path,
      remoteDevCommit: row.remote_dev_commit,
      remoteMainCommit: row.remote_main_commit,
      pushedAt: row.pushed_at,
      mainPushedAt: row.main_pushed_at,
      phase: promotionPhase({ state: row.state, restart }),
      restartSteps: row.restart_steps_json === null
        ? []
        : JSON.parse(row.restart_steps_json) as readonly PromotionRestartPlanStep[],
      restart,
      outcomeCode: row.outcome_code,
      detail: row.detail,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      members: this.sqlite.query<{
        batch_id: string; task_id: string; revision_id: string; execution_id: string;
        candidate_commit: string;
      }, [string]>(`
        SELECT batch_id,task_id,revision_id,execution_id,candidate_commit
        FROM stable_promotion_members WHERE promotion_id=?1 ORDER BY task_id
      `).all(promotionId).map((member) => ({
        batchId: member.batch_id,
        taskId: member.task_id,
        revisionId: member.revision_id,
        executionId: member.execution_id,
        candidateCommit: member.candidate_commit,
      })),
    };
  }

  private stablePromotionPlan(promotionId: string): StablePromotionPlan {
    const summary = this.stablePromotionSummary(promotionId);
    const row = this.sqlite.query<{
      repo_root: string; git_common_dir: string; object_format: 'sha1' | 'sha256';
      operation_id: string; operation_state: StablePromotionPlan['operationState'];
    }, [string]>(`
      SELECT p.repo_root,p.git_common_dir,p.object_format,o.id AS operation_id,
             o.state AS operation_state
      FROM stable_promotions promotion
      JOIN projects p ON p.id=promotion.project_id
      JOIN operations o ON o.kind='PROMOTE_STABLE_BRANCH'
        AND o.aggregate_id=promotion.id
      WHERE promotion.id=?1
    `).get(promotionId);
    if (row === null) {
      throw new StorageError('NOT_FOUND', 'Promotion is missing its project or Operation');
    }
    return {
      ...summary,
      operationId: row.operation_id,
      operationState: row.operation_state,
      repositoryRoot: row.repo_root,
      gitCommonDir: row.git_common_dir,
      objectFormat: row.object_format,
    };
  }

  /**
   * Whether the batch record proves that no member side effect exists: nothing was merged and no
   * verification was queued. Only such a batch may be cancelled; anything else needs reconciliation.
   */
  private memberSideEffectsSettled(batch: {
    readonly worktreePath: string | null;
    readonly mergeStrategy: MergeStrategy | null;
    readonly mergedCommit: string | null;
    readonly verificationId: string | null;
  }): boolean {
    return batch.worktreePath === null && batch.mergeStrategy === null
      && batch.mergedCommit === null && batch.verificationId === null;
  }

  private integrationBatchSummary(batchId: string): IntegrationBatchSummary {
    const row = this.sqlite.query<{
      id: string; project_id: string; dev_ref: string; dev_commit: string;
      state: IntegrationBatchState; integrated_commit: string | null;
      merge_strategy: MergeStrategy | null; merged_commit: string | null;
      worktree_path: string | null;
      verification_id: string | null; outcome_code: string | null; detail: string | null;
      created_at: number; completed_at: number | null;
    }, [string]>(`
      SELECT id,project_id,dev_ref,dev_commit,state,integrated_commit,merge_strategy,merged_commit,
             worktree_path,verification_id,outcome_code,detail,created_at,completed_at
      FROM integration_batches WHERE id=?1
    `).get(batchId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Integration batch was not found');
    return {
      batchId: row.id,
      projectId: row.project_id,
      devRef: row.dev_ref,
      devCommit: row.dev_commit,
      state: row.state,
      integratedCommit: row.integrated_commit,
      mergeStrategy: row.merge_strategy,
      mergedCommit: row.merged_commit,
      worktreePath: row.worktree_path,
      verificationId: row.verification_id,
      outcomeCode: row.outcome_code,
      detail: row.detail,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      items: this.integrationBatchItemSummaries(batchId),
    };
  }

  private integrationBatchItemSummaries(batchId: string): readonly IntegrationBatchItemSummary[] {
    return this.sqlite.query<{
      batch_id: string; project_id: string; task_id: string; task_version: number;
      revision_id: string; execution_id: string;
      candidate_commit: string; dev_commit: string; state: IntegrationItemState;
      integrated_commit: string | null; detail: string | null;
      created_at: number; completed_at: number | null;
    }, [string]>(`
      SELECT item.batch_id,item.project_id,item.task_id,task.version AS task_version,
             item.revision_id,item.execution_id,item.candidate_commit,item.dev_commit,item.state,
             item.integrated_commit,item.detail,item.created_at,item.completed_at
      FROM integration_batch_items item JOIN tasks task ON task.id=item.task_id
      WHERE item.batch_id=?1 ORDER BY item.task_id
    `).all(batchId).map((row) => ({
      batchId: row.batch_id,
      projectId: row.project_id,
      taskId: row.task_id,
      taskVersion: row.task_version,
      revisionId: row.revision_id,
      executionId: row.execution_id,
      candidateCommit: row.candidate_commit,
      devCommit: row.dev_commit,
      state: row.state,
      integratedCommit: row.integrated_commit,
      detail: row.detail,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }));
  }

  private integrationBatchPlan(batchId: string): IntegrationBatchPlan {
    const summary = this.integrationBatchSummary(batchId);
    const item = summary.items[0];
    const operation = this.sqlite.query<{
      id: string; state: IntegrationBatchPlan['operationState'];
    }, [string]>(`
      SELECT id,state FROM operations WHERE kind='INTEGRATE_TASK_RESULT' AND aggregate_id=?1
    `).get(batchId);
    const project = this.sqlite.query<{
      repo_root: string; main_ref: string; object_format: 'sha1' | 'sha256';
      ownership_token: string;
    }, [string]>(`
      SELECT COALESCE(p.dev_repo_path,p.repo_root) AS repo_root,p.main_ref,p.object_format,
             batch.worktree_ownership_token
      FROM integration_batches batch
      JOIN projects p ON p.id=batch.project_id
      WHERE batch.id=?1
    `).get(batchId);
    if (item === undefined || operation === null || project === null) {
      throw new StorageError('NOT_FOUND', 'Integration batch is missing its item, operation, or project');
    }
    return {
      ...summary,
      operationId: operation.id,
      operationState: operation.state,
      worktreeOwnershipToken: project.ownership_token,
      repositoryRoot: project.repo_root,
      mainRef: project.main_ref,
      objectFormat: project.object_format,
      item,
    };
  }

  private integrationVerificationPlan(verificationId: string): IntegrationVerificationPlan {
    const row = this.sqlite.query<{
      id: string; batch_id: string; project_id: string; task_id: string; execution_id: string;
      revision_id: string; operation_id: string; operation_state: IntegrationVerificationPlan['operationState'];
      tested_commit: string; tested_tree: string; dev_commit: string; policy_version: string;
      policy_digest: string; main_commit: string; commands_json: string; copy_path: string;
      state: VerificationState; outcome_code: string | null; evidence_json: string | null;
      queued_at: number; started_at: number | null; ended_at: number | null;
    }, [string]>(`
      SELECT r.id,r.batch_id,r.project_id,r.task_id,r.execution_id,r.revision_id,r.operation_id,
        o.state AS operation_state,r.tested_commit,r.tested_tree,r.dev_commit,r.policy_version,
        r.policy_digest,r.main_commit,r.commands_json,r.copy_path,r.state,r.outcome_code,
        r.evidence_json,r.queued_at,r.started_at,r.ended_at
      FROM integration_verification_runs r JOIN operations o ON o.id=r.operation_id
      WHERE r.id=?1
    `).get(verificationId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Integration verification was not found');
    return {
      verificationId: row.id,
      batchId: row.batch_id,
      projectId: row.project_id,
      taskId: row.task_id,
      executionId: row.execution_id,
      revisionId: row.revision_id,
      operationId: row.operation_id,
      operationState: row.operation_state,
      testedCommit: row.tested_commit,
      testedTree: row.tested_tree,
      devCommit: row.dev_commit,
      policyVersion: row.policy_version,
      policyDigest: row.policy_digest,
      mainCommit: row.main_commit,
      commands: JSON.parse(row.commands_json) as readonly StoredVerificationCommand[],
      copyPath: row.copy_path,
      state: row.state,
      outcomeCode: row.outcome_code,
      evidence: row.evidence_json === null
        ? null
        : JSON.parse(row.evidence_json) as VerificationEvidence,
      queuedAt: row.queued_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }

  /**
   * Creates one long-command Operation, or returns the one the same command already created.
   * `idempotencyKey` is the command ID, so a replayed `task.run` reaches its recorded Operation
   * instead of starting a second one.
   */
  beginRunOperation(input: {
    readonly operationId: string;
    readonly projectId: string;
    readonly kind: string;
    readonly aggregateId: string;
    readonly idempotencyKey: string;
    readonly request: Readonly<Record<string, unknown>>;
    readonly createdAt: number;
  }): Readonly<{ operation: OperationSummary; created: boolean }> {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<{ id: string }, [string, string, string]>(`
        SELECT id FROM operations WHERE project_id=?1 AND kind=?2 AND idempotency_key=?3
      `).get(input.projectId, input.kind, input.idempotencyKey);
      if (existing !== null) {
        return { operation: this.operationSummary(existing.id), created: false };
      }
      this.sqlite.query(`
        INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,request_json,
          created_at,updated_at)
        VALUES (?1,?2,?3,?4,?5,'PLANNED',?6,?7,?7)
      `).run(input.operationId, input.projectId, input.kind, input.aggregateId,
        input.idempotencyKey, JSON.stringify(input.request), input.createdAt);
      return { operation: this.operationSummary(input.operationId), created: true };
    })();
  }

  /**
   * Appends one progress step **without** publishing a progress event. `step_key` is unique per
   * Operation, so replaying a command that already recorded this step is a no-op rather than a
   * duplicated fact. The return value says whether a row was written, so a caller can tell "this
   * happened now" from "this already happened" instead of pretending to redo work.
   *
   * A long command should use `recordOperationProgressEvent` instead: that form writes the step and
   * the `OperationProgressed` fact in one transaction, which is what makes progress streamable. This
   * primitive is for recording a boundary that deliberately stays off the event stream.
   */
  recordOperationProgress(input: {
    readonly operationId: string;
    readonly stepKey: string;
    readonly step: string;
    readonly state: OperationProgressState;
    readonly detail?: Readonly<Record<string, unknown>>;
    readonly recordedAt: number;
  }): Readonly<{ recorded: boolean; sequence: number }> {
    return this.sqlite.transaction(() => {
      const operation = this.sqlite.query<{ id: string }, [string]>(
        'SELECT id FROM operations WHERE id=?1').get(input.operationId);
      if (operation === null) throw new StorageError('NOT_FOUND', 'Operation was not found');
      const existing = this.sqlite.query<{ sequence: number }, [string, string]>(
        'SELECT sequence FROM operation_progress WHERE operation_id=?1 AND step_key=?2',
      ).get(input.operationId, input.stepKey);
      if (existing !== null) return { recorded: false, sequence: existing.sequence };
      const next = this.sqlite.query<{ next: number }, [string]>(`
        SELECT COALESCE(MAX(sequence) + 1, 0) AS next FROM operation_progress WHERE operation_id=?1
      `).get(input.operationId)?.next ?? 0;
      this.sqlite.query(`
        INSERT INTO operation_progress(operation_id,sequence,step_key,step,state,detail_json,recorded_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7)
      `).run(input.operationId, next, input.stepKey, input.step, input.state,
        input.detail === undefined ? null : JSON.stringify(input.detail), input.recordedAt);
      // Progress doubles as a heartbeat, so a reader can tell "still moving" from "stuck" without
      // the Runtime inventing a percentage it cannot know. The first recorded step also moves the
      // Operation out of PLANNED: recording a step means the work itself has begun.
      this.sqlite.query(`
        UPDATE operations
        SET updated_at=max(updated_at,?1),
            state=CASE WHEN state='PLANNED' THEN 'IN_PROGRESS' ELSE state END
        WHERE id=?2
      `).run(input.recordedAt, input.operationId);
      return { recorded: true, sequence: next };
    })();
  }

  /**
   * Publishes one progress event for a long command, optionally together with the durable step it
   * describes, in a single transaction.
   *
   * Three invariants are enforced here instead of being left to callers:
   *
   * 1. **No progress after a verdict.** Once the Operation is terminal nothing more is published, so
   *    a late callback from a command that was killed during a cancel cannot make a settled
   *    Operation look like it is still moving. The step row (if any) is still recorded — it is a
   *    fact about what the Runtime reached — but the event is refused.
   * 2. **Idempotent.** `dedup_key` is unique per Operation, so replaying the same boundary publishes
   *    a single fact. A caller that re-emits gets `eventRecorded: false` and the already-assigned
   *    `progressSequence`, never a duplicate.
   * 3. **Orderable.** `progressSequence` is monotonic per Operation, so a consumer that receives
   *    events out of order can keep the highest one and ignore stale progress of the same Operation
   *    (the global cursor is `domain_events.sequence`, which is assigned here as well).
   *
   * The published payload never contains a verdict; `verdict: false` is written down so a consumer
   * can assert that instead of inferring it.
   */
  recordOperationProgressEvent(input: {
    readonly operationId: string;
    readonly eventId: string;
    readonly phase: OperationProgressPhase;
    readonly dedupKey: string;
    readonly detail: Readonly<Record<string, unknown>>;
    readonly recordedAt: number;
    readonly step?: OperationProgressEventStep;
  }): RecordOperationProgressEventResult {
    if (input.phase === 'SETTLED') {
      throw new StorageError('INVALID_STATE',
        'A settled Operation event is written by the terminal write itself, not by a progress call');
    }
    return this.sqlite.transaction(() => {
      const operation = this.sqlite.query<{
        id: string; project_id: string; kind: string; aggregate_id: string; request_json: string;
      }, [string]>(`
        SELECT id,project_id,kind,aggregate_id,request_json FROM operations WHERE id=?1
      `).get(input.operationId);
      if (operation === null) throw new StorageError('NOT_FOUND', 'Operation was not found');
      let stepRecorded = false;
      let stepSequence: number | null = null;
      if (input.step !== undefined) {
        const existingStep = this.sqlite.query<{ sequence: number }, [string, string]>(
          'SELECT sequence FROM operation_progress WHERE operation_id=?1 AND step_key=?2',
        ).get(input.operationId, input.step.stepKey);
        if (existingStep === null) {
          stepSequence = this.sqlite.query<{ next: number }, [string]>(`
            SELECT COALESCE(MAX(sequence) + 1, 0) AS next FROM operation_progress WHERE operation_id=?1
          `).get(input.operationId)?.next ?? 0;
          this.sqlite.query(`
            INSERT INTO operation_progress(operation_id,sequence,step_key,step,state,detail_json,recorded_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7)
          `).run(input.operationId, stepSequence, input.step.stepKey, input.step.step,
            input.step.state, JSON.stringify(input.detail), input.recordedAt);
          stepRecorded = true;
        } else {
          stepSequence = existingStep.sequence;
        }
      }
      // Progress doubles as a heartbeat. The first recorded step also moves the Operation out of
      // PLANNED: recording progress means the work itself has begun.
      this.sqlite.query(`
        UPDATE operations
        SET updated_at=max(updated_at,?1),
            state=CASE WHEN state='PLANNED' THEN 'IN_PROGRESS' ELSE state END
        WHERE id=?2
      `).run(input.recordedAt, input.operationId);
      const operationState = this.sqlite.query<{ state: OperationState }, [string]>(
        'SELECT state FROM operations WHERE id=?1').get(input.operationId)?.state ?? 'FAILED';
      if (operationState !== 'PLANNED' && operationState !== 'IN_PROGRESS') {
        return { stepRecorded, eventRecorded: false, progressSequence: null,
          eventSequence: null, refused: 'TERMINAL' as const };
      }
      const existingEvent = this.sqlite.query<{ progress_sequence: number; event_id: string }, [string, string]>(`
        SELECT progress_sequence,event_id FROM operation_progress_events
        WHERE operation_id=?1 AND dedup_key=?2
      `).get(input.operationId, input.dedupKey);
      if (existingEvent !== null) {
        const published = this.sqlite.query<{ sequence: number }, [string]>(
          'SELECT sequence FROM domain_events WHERE event_id=?1').get(existingEvent.event_id);
        return { stepRecorded, eventRecorded: false,
          progressSequence: existingEvent.progress_sequence,
          eventSequence: published?.sequence ?? null, refused: null };
      }
      const progressSequence = this.sqlite.query<{ next: number }, [string]>(`
        SELECT COALESCE(MAX(progress_sequence) + 1, 0) AS next FROM operation_progress_events
        WHERE operation_id=?1
      `).get(input.operationId)?.next ?? 0;
      this.sqlite.query(`
        INSERT INTO operation_progress_events(operation_id,progress_sequence,event_id,dedup_key,phase,
          detail_json,recorded_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7)
      `).run(input.operationId, progressSequence, input.eventId, input.dedupKey, input.phase,
        JSON.stringify(input.detail), input.recordedAt);
      const taskId = operationTaskId(operation.kind, operation.aggregate_id, operation.request_json);
      const inserted = this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'OperationProgressed',1,'Operation',?3,?4,?5,NULL,?6,?7)
      `).run(input.eventId, operation.project_id, input.operationId, progressSequence,
        input.operationId, input.recordedAt, JSON.stringify({
          operationId: input.operationId,
          projectId: operation.project_id,
          taskId,
          kind: operation.kind,
          progressSequence,
          dedupKey: input.dedupKey,
          phase: input.phase,
          verdict: false,
          ...(input.step === undefined ? {} : {
            stepKey: input.step.stepKey,
            step: input.step.step,
            stepState: input.step.state,
            stepSequence,
          }),
          detail: input.detail,
        }));
      return { stepRecorded, eventRecorded: true, progressSequence,
        eventSequence: Number(inserted.lastInsertRowid), refused: null };
    })();
  }

  /**
   * The published progress projection of one Operation, ordered by its own monotonic sequence.
   * `afterProgressSequence` is exclusive, so a consumer can resume from the last one it projected.
   */
  listOperationProgressEvents(
    operationId: string,
    options: { readonly afterProgressSequence?: number } = {},
  ): readonly OperationProgressEventSummary[] {
    return this.sqlite.query<{
      progress_sequence: number; event_id: string; phase: OperationProgressPhase;
      dedup_key: string; detail_json: string; recorded_at: number; sequence: number;
    }, [string, number]>(`
      SELECT p.progress_sequence,p.event_id,p.phase,p.dedup_key,p.detail_json,p.recorded_at,
        e.sequence
      FROM operation_progress_events p JOIN domain_events e ON e.event_id=p.event_id
      WHERE p.operation_id=?1 AND p.progress_sequence>?2
      ORDER BY p.progress_sequence
    `).all(operationId, options.afterProgressSequence ?? -1).map((row) => ({
      operationId,
      progressSequence: row.progress_sequence,
      eventId: row.event_id,
      eventSequence: row.sequence,
      phase: row.phase,
      dedupKey: row.dedup_key,
      detail: JSON.parse(row.detail_json) as Readonly<Record<string, unknown>>,
      recordedAt: row.recorded_at,
    }));
  }

  getOperation(projectId: string, operationId: string): OperationSummary {
    const summary = this.operationSummary(operationId);
    if (summary.projectId !== projectId) {
      throw new StorageError('NOT_FOUND', 'Operation was not found for this project');
    }
    return summary;
  }

  /**
   * The long-command Operations belonging to one Task: the Agent run plus every verification run.
   * Sub-operations of a run (workspace, Agent start, result capture) are not listed; they are
   * already covered by the run's own steps.
   */
  listTaskOperations(projectId: string, taskId: string): readonly OperationSummary[] {
    return this.sqlite.query<{ id: string }, [string, string]>(`
      SELECT o.id FROM operations o
      WHERE o.project_id=?1 AND (
        (o.kind='RUN_TASK' AND o.aggregate_id=?2)
        OR (o.kind='RUN_TASK_VERIFICATION' AND o.id IN (
          SELECT r.operation_id FROM verification_runs r
          WHERE r.project_id=?1 AND r.task_id=?2))
      )
      ORDER BY o.created_at DESC, o.id
    `).all(projectId, taskId).map((row) => this.operationSummary(row.id));
  }

  /** The run Operation this Task is currently inside, if any. */
  findActiveRunOperation(projectId: string, taskId: string): OperationSummary | null {
    const row = this.sqlite.query<{ id: string }, [string, string]>(`
      SELECT id FROM operations
      WHERE project_id=?1 AND kind='RUN_TASK' AND aggregate_id=?2
        AND state IN ('PLANNED','IN_PROGRESS')
      ORDER BY created_at DESC, id LIMIT 1
    `).get(projectId, taskId);
    return row === null ? null : this.operationSummary(row.id);
  }

  /** Runs a previous Runtime left unfinished; startup reconcile decides what the facts allow. */
  listIncompleteRunOperations(): readonly OperationSummary[] {
    return this.sqlite.query<{ id: string }, []>(`
      SELECT id FROM operations WHERE kind='RUN_TASK' AND state IN ('PLANNED','IN_PROGRESS')
      ORDER BY created_at, id
    `).all().map((row) => this.operationSummary(row.id));
  }

  /**
   * Terminal write for a long-command Operation. A second writer (a cancel racing the run loop)
   * finds the Operation already terminal and returns the recorded outcome instead of overwriting it.
   */
  completeOperation(input: {
    readonly operationId: string;
    readonly state: 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
    readonly result: Readonly<Record<string, unknown>>;
    readonly completedAt: number;
  }): OperationSummary {
    return this.sqlite.transaction(() => {
      const current = this.operationSummary(input.operationId);
      if (current.state !== 'PLANNED' && current.state !== 'IN_PROGRESS') return current;
      const updated = this.sqlite.query(`
        UPDATE operations SET state=?1,result_json=?2,updated_at=?3
        WHERE id=?4 AND state IN ('PLANNED','IN_PROGRESS')
      `).run(input.state, JSON.stringify(input.result), input.completedAt, input.operationId);
      if (updated.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Operation changed while completing');
      }
      // A long command that published progress also publishes its settle, in the same transaction,
      // so an event-driven client learns it ended without polling. Operations that never published
      // progress (workspace preparation, Agent start, result commit, ...) stay out of the progress
      // stream: this event exists to close a stream that was opened, not to announce every write.
      if (this.sqlite.query<{ count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM operation_progress_events WHERE operation_id=?1',
      ).get(input.operationId)?.count !== 0) {
        this.publishOperationSettled({
          operationId: input.operationId,
          operationState: input.state,
          detail: input.result,
          recordedAt: input.completedAt,
        });
      }
      return this.operationSummary(input.operationId);
    })();
  }

  /**
   * Appends the `OperationSettled` fact for one Operation. The event ID is derived from the
   * Operation, not random, so a retried terminal write can only ever publish the same fact; the
   * `dedup_key` row makes the retry a no-op.
   */
  private publishOperationSettled(input: {
    readonly operationId: string;
    readonly operationState: OperationState;
    readonly detail: Readonly<Record<string, unknown>>;
    readonly recordedAt: number;
  }): Readonly<{ eventRecorded: boolean; eventSequence: number | null }> {
    const operation = this.sqlite.query<{
      project_id: string; kind: string; aggregate_id: string; request_json: string;
    }, [string]>(`
      SELECT project_id,kind,aggregate_id,request_json FROM operations WHERE id=?1
    `).get(input.operationId);
    if (operation === null) throw new StorageError('NOT_FOUND', 'Operation was not found');
    const existing = this.sqlite.query<{ event_id: string }, [string]>(`
      SELECT event_id FROM operation_progress_events WHERE operation_id=?1 AND dedup_key='SETTLED'
    `).get(input.operationId);
    if (existing !== null) {
      const published = this.sqlite.query<{ sequence: number }, [string]>(
        'SELECT sequence FROM domain_events WHERE event_id=?1').get(existing.event_id);
      return { eventRecorded: false, eventSequence: published?.sequence ?? null };
    }
    const eventId = createHash('sha256').update(`OperationSettled:${input.operationId}`).digest('hex');
    const progressSequence = this.sqlite.query<{ next: number }, [string]>(`
      SELECT COALESCE(MAX(progress_sequence) + 1, 0) AS next FROM operation_progress_events
      WHERE operation_id=?1
    `).get(input.operationId)?.next ?? 0;
    this.sqlite.query(`
      INSERT INTO operation_progress_events(operation_id,progress_sequence,event_id,dedup_key,phase,
        detail_json,recorded_at)
      VALUES (?1,?2,?3,'SETTLED','SETTLED',?4,?5)
    `).run(input.operationId, progressSequence, eventId, JSON.stringify(input.detail),
      input.recordedAt);
    const taskId = operationTaskId(operation.kind, operation.aggregate_id, operation.request_json);
    const inserted = this.sqlite.query(`
      INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
        aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
      VALUES (?1,?2,'OperationSettled',1,'Operation',?3,?4,?5,NULL,?6,?7)
    `).run(eventId, operation.project_id, input.operationId, progressSequence, input.operationId,
      input.recordedAt, JSON.stringify({
        operationId: input.operationId,
        projectId: operation.project_id,
        taskId,
        kind: operation.kind,
        progressSequence,
        dedupKey: 'SETTLED',
        phase: 'SETTLED',
        // Not a verdict: this says the long command ended, never that anything passed.
        verdict: false,
        operationState: input.operationState,
        detail: input.detail,
      }));
    return { eventRecorded: true, eventSequence: Number(inserted.lastInsertRowid) };
  }

  private operationSummary(operationId: string): OperationSummary {
    const row = this.sqlite.query<{
      id: string; project_id: string; kind: string; aggregate_id: string; state: OperationState;
      request_json: string; result_json: string | null; created_at: number; updated_at: number;
    }, [string]>(`
      SELECT id,project_id,kind,aggregate_id,state,request_json,result_json,created_at,updated_at
      FROM operations WHERE id=?1
    `).get(operationId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Operation was not found');
    const steps = this.sqlite.query<{
      sequence: number; step_key: string; step: string; state: OperationProgressState;
      detail_json: string | null; recorded_at: number;
    }, [string]>(`
      SELECT sequence,step_key,step,state,detail_json,recorded_at FROM operation_progress
      WHERE operation_id=?1 ORDER BY sequence
    `).all(operationId).map((step) => ({
      sequence: step.sequence,
      stepKey: step.step_key,
      step: step.step,
      state: step.state,
      detail: step.detail_json === null
        ? null
        : JSON.parse(step.detail_json) as Readonly<Record<string, unknown>>,
      recordedAt: step.recorded_at,
    }));
    const cancelStep = steps.find((step) => step.stepKey === 'CANCEL_REQUESTED');
    return {
      operationId: row.id,
      projectId: row.project_id,
      kind: row.kind,
      aggregateId: row.aggregate_id,
      // A run owns its Task directly; a verification Operation names it in its request payload.
      taskId: operationTaskId(row.kind, row.aggregate_id, row.request_json),
      state: row.state,
      result: row.result_json === null
        ? null
        : JSON.parse(row.result_json) as Readonly<Record<string, unknown>>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      cancelRequestedAt: cancelStep?.recordedAt ?? null,
      steps,
    };
  }

  updateTaskPriority(input: {
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly priority: number;
    readonly updatedAt: number;
  }): number {
    const result = this.sqlite.query(`
      UPDATE tasks SET priority=?1, updated_at=?2, version=version+1
      WHERE id=?3 AND version=?4
    `).run(input.priority, input.updatedAt, input.taskId, input.expectedVersion);
    if (result.changes !== 1) {
      throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
    }
    return input.expectedVersion + 1;
  }

  /**
   * The only place an `intents` row is written. Funnelling all three writers (Task creation,
   * revision creation, Attention answering) through one guard is what makes the ADR-0046 shrink a
   * boundary rule instead of three independent literals: a kind outside the narrowed set fails with
   * `UNSUPPORTED_INTENT_KIND` before SQLite can answer with an opaque CHECK error.
   */
  private insertIntent(database: Database, input: {
    readonly id: string;
    readonly projectId: string;
    readonly idempotencyKey: string;
    readonly rawText: string;
    readonly kind: string;
    readonly status: 'RECORDED' | 'NEEDS_CLARIFICATION' | 'APPLIED' | 'REJECTED';
    readonly actor: string;
    readonly createdAt: number;
  }): void {
    database.query(`
      INSERT INTO intents(id,project_id,idempotency_key,raw_text,kind,status,actor,created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
    `).run(input.id, input.projectId, input.idempotencyKey, input.rawText,
      assertIntentKind(input.kind), input.status, input.actor, input.createdAt);
  }

  executeCommand<T extends object>(input: {
    readonly projectId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly createdAt: number;
    readonly apply: (database: Database) => T;
  }): T {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<
        { payload_hash: string; result_json: string },
        [string, string]
      >('SELECT payload_hash,result_json FROM command_receipts WHERE project_id=?1 AND command_id=?2')
        .get(input.projectId, input.commandId);
      if (existing !== null) {
        if (existing.payload_hash !== input.payloadHash) {
          throw new StorageError('COMMAND_CONFLICT', 'Command ID was already used with a different payload');
        }
        return JSON.parse(existing.result_json) as T;
      }

      const result = input.apply(this.sqlite);
      this.sqlite.query(`
        INSERT INTO command_receipts(project_id,command_id,payload_hash,result_json,created_at)
        VALUES (?1,?2,?3,?4,?5)
      `).run(input.projectId, input.commandId, input.payloadHash, JSON.stringify(result), input.createdAt);
      return result;
    })();
  }

  // ---------------------------------------------------------------------------------------------
  // Resource reclamation (ADR-0021). These methods only record and read; every filesystem or Git
  // side effect is executed by the reclaim service between calls. The decision itself is kept in
  // an append-only ledger, so `reclaim.records` can always explain what was deleted and why.
  // ---------------------------------------------------------------------------------------------

  /**
   * Every Runtime-owned resource of one project that a `reclaim` run may consider, together with
   * the recorded ownership identity of each one. The Runtime-managed path itself is not trusted
   * here: ownership is checked by the caller against the real filesystem and the Git worktree
   * registry before anything is removed.
   */
  getReclamationCandidates(
    projectId: string,
    options: { readonly taskId?: string } = {},
  ): ReclamationCandidates {
    const project = this.sqlite.query<{
      id: string; name: string; repo_root: string; dev_repo_path: string | null;
      git_common_dir: string; main_ref: string;
      dev_ref: string; object_format: 'sha1' | 'sha256';
    }, [string]>(`
      SELECT p.id,p.name,COALESCE(p.dev_repo_path,p.repo_root) AS repo_root,p.dev_repo_path,
             p.git_common_dir,
             p.main_ref,p.dev_ref,p.object_format
      FROM projects p
      JOIN project_trusts trust ON trust.project_id=p.id AND trust.status='ACTIVE'
      WHERE p.id=?1
    `).get(projectId);
    if (project === null) {
      throw new StorageError('NOT_FOUND', 'Project or active project trust was not found');
    }
    const taskFilter = options.taskId === undefined ? '' : 'AND t.id=?2';
    const taskParameters: [string] | [string, string] = options.taskId === undefined
      ? [projectId] : [projectId, options.taskId];
    const tasks = this.sqlite.query<{
      id: string; display_number: number; state: TaskLifecycleState; archived_at: number | null;
      result_commit: string | null;
    }, [string] | [string, string]>(`
      SELECT t.id,t.display_number,t.state,t.archived_at,
        (SELECT e.result_commit FROM executions e
          WHERE e.task_id=t.id AND e.state='SUCCEEDED' AND e.result_commit IS NOT NULL
          ORDER BY e.attempt_number DESC LIMIT 1) AS result_commit
      FROM tasks t
      WHERE t.project_id=?1 ${taskFilter}
      ORDER BY t.display_number
    `).all(...taskParameters);
    const workspaceFilter = options.taskId === undefined ? '' : 'AND w.task_id=?2';
    const workspaces = this.sqlite.query<{
      id: string; task_id: string; path: string; branch_ref: string; ownership_token: string;
      base_commit: string; base_ref: string | null; state: WorkspaceLifecycleState; resource_held: number;
      active_reservation: string | null; active_reservation_id: string | null;
    }, [string] | [string, string]>(`
      SELECT w.id,w.task_id,w.path,w.branch_ref,w.ownership_token,w.base_commit,w.base_ref,w.state,
        EXISTS(SELECT 1 FROM executions e WHERE e.task_id=w.task_id AND e.resource_held=1)
          AS resource_held,
        (SELECT r.state FROM execution_slot_reservations r
          WHERE r.project_id=t.project_id AND r.workspace_id=w.id
            AND r.state IN ('RESERVED','RECOVERY_REQUIRED')
          ORDER BY r.reserved_at,r.id LIMIT 1) AS active_reservation,
        (SELECT r.id FROM execution_slot_reservations r
          WHERE r.project_id=t.project_id AND r.workspace_id=w.id
            AND r.state IN ('RESERVED','RECOVERY_REQUIRED')
          ORDER BY r.reserved_at,r.id LIMIT 1) AS active_reservation_id
      FROM workspaces w JOIN tasks t ON t.id=w.task_id
      WHERE t.project_id=?1 ${workspaceFilter}
      ORDER BY w.created_at,w.id
    `).all(...taskParameters);
    const verificationFilter = options.taskId === undefined ? '' : 'AND task_id=?2';
    const verificationCopies = this.sqlite.query<{
      id: string; task_id: string; execution_id: string; tested_commit: string; copy_path: string;
      state: VerificationState; outcome_code: string | null;
    }, [string] | [string, string]>(`
      SELECT id,task_id,execution_id,tested_commit,copy_path,state,outcome_code
      FROM verification_runs
      WHERE project_id=?1 ${verificationFilter}
      ORDER BY queued_at DESC,id
    `).all(...taskParameters);
    const integrationFilter = options.taskId === undefined ? ''
      : 'AND EXISTS(SELECT 1 FROM integration_batch_items i'
        + ' WHERE i.batch_id=b.id AND i.task_id=?2)';
    const integrationWorktrees = this.sqlite.query<{
      id: string; task_id: string | null; state: IntegrationBatchState; dev_commit: string;
      merged_commit: string | null; integrated_commit: string | null; worktree_path: string;
      worktree_ownership_token: string; detail: string | null;
    }, [string] | [string, string]>(`
      SELECT b.id,
        (SELECT i.task_id FROM integration_batch_items i WHERE i.batch_id=b.id
          ORDER BY i.created_at,i.task_id LIMIT 1) AS task_id,
        b.state,b.dev_commit,b.merged_commit,b.integrated_commit,b.worktree_path,
        b.worktree_ownership_token,b.detail
      FROM integration_batches b
      WHERE b.project_id=?1 AND b.worktree_path IS NOT NULL ${integrationFilter}
      ORDER BY b.created_at DESC,b.id
    `).all(...taskParameters);
    return {
      project: {
        projectId: project.id,
        name: project.name,
        repoRoot: project.repo_root,
        gitCommonDir: project.git_common_dir,
        mainRef: project.main_ref,
        devRepoPath: project.dev_repo_path,
        devRef: project.dev_ref,
        objectFormat: project.object_format,
      },
      tasks: tasks.map((row) => ({
        taskId: row.id,
        displayNumber: row.display_number,
        state: row.state,
        archivedAt: row.archived_at,
        resultCommit: row.result_commit,
      })),
      workspaces: workspaces.map((row) => ({
        workspaceId: row.id,
        taskId: row.task_id,
        path: row.path,
        branchRef: row.branch_ref,
        ownershipToken: row.ownership_token,
        baseCommit: row.base_commit,
        baseRef: row.base_ref,
        state: row.state,
        resourceHeld: row.resource_held === 1,
        /** A RESERVED or RECOVERY_REQUIRED slot still claims this workspace (ADR-0032). */
        activeReservation: row.active_reservation !== null,
        reservationState: row.active_reservation,
        reservationId: row.active_reservation_id,
      })),
      verificationCopies: verificationCopies.map((row) => ({
        verificationId: row.id,
        taskId: row.task_id,
        executionId: row.execution_id,
        testedCommit: row.tested_commit,
        copyPath: row.copy_path,
        state: row.state,
        outcomeCode: row.outcome_code,
      })),
      integrationWorktrees: integrationWorktrees
        .filter((row): row is typeof row & { task_id: string } => row.task_id !== null)
        .map((row) => ({
          batchId: row.id,
          taskId: row.task_id,
          state: row.state,
          devCommit: row.dev_commit,
          mergedCommit: row.merged_commit,
          integratedCommit: row.integrated_commit,
          worktreePath: row.worktree_path,
          ownershipToken: row.worktree_ownership_token,
          detail: row.detail,
        })),
    };
  }

  /**
   * Marks a workspace RELEASED after its worktree was confirmed gone. The recorded path, branch
   * and ownership token stay in the row as the audit trail; only the live-ownership flag changes.
   * A held Execution refuses the transition, so reclamation can never race an active Agent.
   */
  releaseWorkspaceForReclamation(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly expectedPath: string;
    readonly eventId: string;
    readonly reason: string;
    readonly releasedAt: number;
  }): Readonly<{ previousState: WorkspaceLifecycleState; changed: boolean }> {
    return this.sqlite.transaction(() => {
      const workspace = this.sqlite.query<{
        id: string; path: string; state: WorkspaceLifecycleState; project_id: string;
      }, [string, string]>(`
        SELECT w.id,w.path,w.state,t.project_id FROM workspaces w
        JOIN tasks t ON t.id=w.task_id
        WHERE w.id=?1 AND w.task_id=?2
      `).get(input.workspaceId, input.taskId);
      if (workspace === null || workspace.project_id !== input.projectId) {
        throw new StorageError('NOT_FOUND', 'Workspace was not found for this project and Task');
      }
      if (workspace.path !== input.expectedPath) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Workspace path changed before it could be released');
      }
      const held = this.sqlite.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM executions WHERE task_id=?1 AND resource_held=1
      `).get(input.taskId);
      if ((held?.count ?? 0) > 0) {
        throw new StorageError('INVALID_STATE', 'A held Execution still owns this workspace');
      }
      // A workspace a slot reservation still claims must not be released either: a RESERVED (or
      // RECOVERY_REQUIRED) reservation outlives the Execution it will start, so releasing the row
      // under it would let a reclaimed directory be handed to a Task that believes it owns it.
      const reserved = this.sqlite.query<{ count: number }, [string, string]>(`
        SELECT COUNT(*) AS count FROM execution_slot_reservations
        WHERE project_id=?1 AND workspace_id=?2 AND state IN ('RESERVED','RECOVERY_REQUIRED')
      `).get(input.projectId, input.workspaceId);
      if ((reserved?.count ?? 0) > 0) {
        throw new StorageError('INVALID_STATE', 'An active slot reservation still owns this workspace');
      }
      if (workspace.state === 'RELEASED') {
        return { previousState: 'RELEASED' as const, changed: false };
      }
      const updated = this.sqlite.query(
        "UPDATE workspaces SET state='RELEASED' WHERE id=?1 AND state<>'RELEASED'",
      ).run(input.workspaceId);
      if (updated.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Workspace state changed before release');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'WorkspaceReclaimed',1,'Workspace',?3,0,?4,?4,?5,?6)
      `).run(input.eventId, input.projectId, input.workspaceId, input.workspaceId, input.releasedAt,
        JSON.stringify({ workspaceId: input.workspaceId, taskId: input.taskId,
          path: input.expectedPath, previousState: workspace.state, reason: input.reason }));
      return { previousState: workspace.state, changed: true };
    })();
  }

  /**
   * Revives one reclaimed workspace after its worktree was re-created from the Task branch the
   * reclamation kept (FOUNDATION-068 / ADR-0042).
   *
   * Only a `RELEASED` row can come back, and only while nothing live claims it: a held Execution or an
   * active slot reservation still means another writer owns this workspace, so the transition is
   * refused instead of racing it. The row keeps its id, path, branch and ownership token because that
   * row *is* this checkout's description (`one_live_workspace_path` keeps exactly one live row per
   * path), so re-creating the directory revives that same workspace instead of inventing a second
   * owner for it. The fact is recorded as the existing `WorkspacePrepared` event with the rebuild
   * evidence in its payload, in the same transaction as the state change.
   *
   * A row already back in `READY` is reported as unchanged instead of failing: two preparations that
   * observed the same re-created worktree must both end in "this workspace is ready".
   */
  markReclaimedWorkspaceRebuilt(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly expectedPath: string;
    readonly expectedBranchRef: string;
    readonly rebuild: Readonly<{
      readonly outcome: 'REBUILT' | 'ADOPTED';
      readonly reasonCode: string;
      readonly detail: string;
      readonly headCommit: string | null;
    }>;
    readonly eventId: string;
    readonly rebuiltAt: number;
  }): Readonly<{ previousState: WorkspaceLifecycleState; changed: boolean }> {
    return this.sqlite.transaction(() => {
      const workspace = this.sqlite.query<{
        id: string; path: string; branch_ref: string; base_commit: string;
        state: WorkspaceLifecycleState; project_id: string;
      }, [string, string]>(`
        SELECT w.id,w.path,w.branch_ref,w.base_commit,w.state,t.project_id FROM workspaces w
        JOIN tasks t ON t.id=w.task_id
        WHERE w.id=?1 AND w.task_id=?2
      `).get(input.workspaceId, input.taskId);
      if (workspace === null || workspace.project_id !== input.projectId) {
        throw new StorageError('NOT_FOUND', 'Workspace was not found for this project and Task');
      }
      if (workspace.path !== input.expectedPath) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Workspace path changed before it could be rebuilt');
      }
      if (workspace.branch_ref !== input.expectedBranchRef) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Workspace branch changed before it could be rebuilt');
      }
      const held = this.sqlite.query<{ count: number }, [string]>(`
        SELECT COUNT(*) AS count FROM executions WHERE task_id=?1 AND resource_held=1
      `).get(input.taskId);
      if ((held?.count ?? 0) > 0) {
        throw new StorageError('INVALID_STATE', 'A held Execution still owns this workspace');
      }
      const reserved = this.sqlite.query<{ count: number }, [string, string]>(`
        SELECT COUNT(*) AS count FROM execution_slot_reservations
        WHERE project_id=?1 AND workspace_id=?2 AND state IN ('RESERVED','RECOVERY_REQUIRED')
      `).get(input.projectId, input.workspaceId);
      if ((reserved?.count ?? 0) > 0) {
        throw new StorageError('INVALID_STATE',
          'An active slot reservation still owns this workspace');
      }
      if (workspace.state === 'READY') return { previousState: 'READY' as const, changed: false };
      if (workspace.state !== 'RELEASED') {
        throw new StorageError('INVALID_STATE',
          `Only a reclaimed workspace can be rebuilt; this one is ${workspace.state}`);
      }
      const updated = this.sqlite.query(
        "UPDATE workspaces SET state='READY' WHERE id=?1 AND state='RELEASED'",
      ).run(input.workspaceId);
      if (updated.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Workspace state changed before it could be rebuilt');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'WorkspacePrepared',1,'Workspace',?3,0,?4,?4,?5,?6)
      `).run(input.eventId, input.projectId, input.workspaceId, input.workspaceId, input.rebuiltAt,
        JSON.stringify({ workspaceId: input.workspaceId, taskId: input.taskId, path: workspace.path,
          branchRef: workspace.branch_ref, baseCommit: workspace.base_commit,
          reattachedBranch: true, previousState: 'RELEASED', rebuild: input.rebuild }));
      return { previousState: 'RELEASED' as const, changed: true };
    })();
  }

  /** Looks up the reclamation operation a command ID maps to, if it exists. */
  findReclamationOperation(projectId: string, commandId: string): ReclamationOperationPlan | null {
    const row = this.sqlite.query<{ id: string }, [string, string]>(`
      SELECT id FROM operations
      WHERE project_id=?1 AND kind='RECLAIM_RESOURCES' AND idempotency_key=?2
    `).get(projectId, commandId);
    return row === null ? null : this.reclamationOperationPlan(row.id);
  }

  /** Reserves one reclamation operation before any side effect, so a crash is always resolvable. */
  planReclamationOperation(input: {
    readonly operationId: string;
    readonly projectId: string;
    readonly commandId: string;
    readonly request: Readonly<Record<string, unknown>>;
    readonly createdAt: number;
  }): ReclamationOperationPlan {
    return this.sqlite.transaction(() => {
      const existing = this.findReclamationOperation(input.projectId, input.commandId);
      if (existing !== null) return existing;
      this.sqlite.query(`
        INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,request_json,
          created_at,updated_at)
        VALUES (?1,?2,'RECLAIM_RESOURCES',?2,?3,'PLANNED',?4,?5,?5)
      `).run(input.operationId, input.projectId, input.commandId,
        JSON.stringify(input.request), input.createdAt);
      return this.reclamationOperationPlan(input.operationId);
    })();
  }

  startReclamationOperation(operationId: string, startedAt: number): void {
    const updated = this.sqlite.query(`
      UPDATE operations SET state='IN_PROGRESS',updated_at=?1
      WHERE id=?2 AND state='PLANNED' AND kind='RECLAIM_RESOURCES'
    `).run(startedAt, operationId);
    if (updated.changes !== 1) {
      throw new StorageError('INVALID_STATE', 'Reclamation operation could not start from its recorded state');
    }
  }

  /**
   * Finalizes one reclamation: the per-resource ledger rows, the operation state, the replayable
   * command receipt and the summary event all land in one transaction. If the receipt already
   * exists the call is a no-op, so a replayed command never records a second ledger.
   */
  finishReclamationOperation(input: {
    readonly operationId: string;
    readonly projectId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly state: 'SUCCEEDED' | 'FAILED';
    readonly result: unknown;
    readonly records: readonly ReclamationRecordInput[];
    readonly eventId: string;
    readonly completedAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const existing = this.sqlite.query<{ payload_hash: string }, [string, string]>(
        'SELECT payload_hash FROM command_receipts WHERE project_id=?1 AND command_id=?2',
      ).get(input.projectId, input.commandId);
      if (existing !== null) {
        if (existing.payload_hash !== input.payloadHash) {
          throw new StorageError('COMMAND_CONFLICT',
            'Command ID was already used with a different payload');
        }
        return;
      }
      for (const record of input.records) {
        this.sqlite.query(`
          INSERT INTO reclamation_records(id,project_id,task_id,operation_id,command_id,source,kind,
            resource_id,path,ownership_token,external_ref,resource_state,outcome,reason_code,detail,
            evidence_json,created_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
        `).run(record.id, input.projectId, record.taskId, input.operationId, input.commandId,
          record.source, record.kind, record.resourceId, record.path, record.ownershipToken,
          record.externalRef, record.resourceState, record.outcome, record.reasonCode, record.detail,
          JSON.stringify(record.evidence), input.completedAt);
      }
      const updated = this.sqlite.query(`
        UPDATE operations SET state=?1,result_json=?2,updated_at=?3
        WHERE id=?4 AND kind='RECLAIM_RESOURCES' AND state IN ('PLANNED','IN_PROGRESS')
      `).run(input.state, JSON.stringify(input.result), input.completedAt, input.operationId);
      if (updated.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Reclamation operation was not in a finishable state');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ResourcesReclaimed',1,'Operation',?3,0,?4,?4,?5,?6)
      `).run(input.eventId, input.projectId, input.operationId, input.commandId, input.completedAt,
        JSON.stringify(input.result));
      this.sqlite.query(`
        INSERT INTO command_receipts(project_id,command_id,payload_hash,result_json,created_at)
        VALUES (?1,?2,?3,?4,?5)
      `).run(input.projectId, input.commandId, input.payloadHash,
        JSON.stringify(input.result), input.completedAt);
    })();
  }

  /** Reclamation operations a restart interrupted; the Runtime reconciles them before accepting work. */
  listIncompleteReclamationOperations(): readonly ReclamationOperationPlan[] {
    return this.sqlite.query<{ id: string }, []>(`
      SELECT id FROM operations WHERE kind='RECLAIM_RESOURCES'
        AND state IN ('PLANNED','IN_PROGRESS') ORDER BY created_at,id
    `).all().map((row) => this.reclamationOperationPlan(row.id));
  }

  /** The append-only reclamation ledger, newest first, filterable by task, source and time. */
  listReclamationRecords(
    projectId: string,
    options: {
      readonly taskId?: string;
      readonly limit?: number;
      readonly source?: ReclamationSource;
      /** Inclusive lower bound on `created_at` (epoch milliseconds). */
      readonly since?: number;
      /** Exclusive upper bound on `created_at` (epoch milliseconds). */
      readonly until?: number;
    } = {},
  ): readonly ReclamationRecord[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new StorageError('INVALID_STATE', 'Reclamation record limit must be between 1 and 500');
    }
    const parameters: (string | number)[] = [projectId];
    const filters: string[] = [];
    if (options.taskId !== undefined) {
      parameters.push(options.taskId);
      filters.push(`task_id=?${parameters.length}`);
    }
    if (options.source !== undefined) {
      parameters.push(options.source);
      filters.push(`source=?${parameters.length}`);
    }
    if (options.since !== undefined) {
      parameters.push(options.since);
      filters.push(`created_at>=?${parameters.length}`);
    }
    if (options.until !== undefined) {
      parameters.push(options.until);
      filters.push(`created_at<?${parameters.length}`);
    }
    parameters.push(limit);
    return this.sqlite.query<{
      id: string; project_id: string; task_id: string | null; operation_id: string; command_id: string;
      source: ReclamationSource; kind: ReclamationKind; resource_id: string; path: string;
      ownership_token: string | null; external_ref: string | null; resource_state: string;
      outcome: ReclamationOutcome; reason_code: string; detail: string | null;
      evidence_json: string; created_at: number;
    }, (string | number)[]>(`
      SELECT id,project_id,task_id,operation_id,command_id,source,kind,resource_id,path,
        ownership_token,external_ref,resource_state,outcome,reason_code,detail,evidence_json,
        created_at
      FROM reclamation_records
      WHERE project_id=?1${filters.length === 0 ? '' : ` AND ${filters.join(' AND ')}`}
      ORDER BY created_at DESC,id DESC LIMIT ?${parameters.length}
    `).all(...parameters).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      operationId: row.operation_id,
      commandId: row.command_id,
      source: row.source,
      kind: row.kind,
      resourceId: row.resource_id,
      path: row.path,
      ownershipToken: row.ownership_token,
      externalRef: row.external_ref,
      resourceState: row.resource_state,
      outcome: row.outcome,
      reasonCode: row.reason_code,
      detail: row.detail,
      evidence: JSON.parse(row.evidence_json) as Readonly<Record<string, unknown>>,
      createdAt: row.created_at,
    }));
  }

  /**
   * The recorded resource that claims one exact path, if any. The unregistered-directory scan uses
   * this so a directory can only ever be called "unregistered" after the ledger was asked about it;
   * the check runs again immediately before any removal.
   */
  findReclaimPathClaim(path: string): ReclamationPathClaim | null {
    const workspace = this.sqlite.query<{
      id: string; project_id: string; task_id: string; state: string;
    }, [string]>(`
      SELECT w.id,t.project_id,w.task_id,w.state FROM workspaces w
      JOIN tasks t ON t.id=w.task_id WHERE w.path=?1 ORDER BY w.created_at,w.id LIMIT 1
    `).get(path);
    if (workspace !== null) {
      return { kind: 'TASK_WORKTREE', projectId: workspace.project_id, taskId: workspace.task_id,
        resourceId: workspace.id, resourceState: workspace.state };
    }
    const verification = this.sqlite.query<{
      id: string; project_id: string; task_id: string; state: string;
    }, [string]>(
      'SELECT id,project_id,task_id,state FROM verification_runs WHERE copy_path=?1 LIMIT 1',
    ).get(path);
    if (verification !== null) {
      return { kind: 'VERIFICATION_COPY', projectId: verification.project_id,
        taskId: verification.task_id, resourceId: verification.id,
        resourceState: verification.state };
    }
    const integration = this.sqlite.query<{
      id: string; project_id: string; state: string;
    }, [string]>(
      'SELECT id,project_id,state FROM integration_batches WHERE worktree_path=?1 LIMIT 1',
    ).get(path);
    if (integration === null) return null;
    const member = this.sqlite.query<{ task_id: string }, [string]>(
      'SELECT task_id FROM integration_batch_items WHERE batch_id=?1 ORDER BY created_at LIMIT 1',
    ).get(integration.id);
    return { kind: 'INTEGRATION_WORKTREE', projectId: integration.project_id,
      taskId: member?.task_id ?? null, resourceId: integration.id,
      resourceState: integration.state };
  }

  /**
   * The active slot reservation that claims one workspace, if any. Read again right before a removal
   * so a workspace can never be deleted under a reservation that was granted after the plan.
   */
  findActiveWorkspaceReservation(input: {
    readonly projectId: string;
    readonly workspaceId: string;
  }): Readonly<{ reservationId: string; taskId: string; state: string; reservedAt: number }> | null {
    const row = this.sqlite.query<{ id: string; task_id: string; state: string; reserved_at: number },
      [string, string]>(`
      SELECT id,task_id,state,reserved_at FROM execution_slot_reservations
      WHERE project_id=?1 AND workspace_id=?2 AND state IN ('RESERVED','RECOVERY_REQUIRED')
      ORDER BY reserved_at,id LIMIT 1
    `).get(input.projectId, input.workspaceId);
    if (row === null) return null;
    return { reservationId: row.id, taskId: row.task_id, state: row.state,
      reservedAt: row.reserved_at };
  }

  private reclamationOperationPlan(operationId: string): ReclamationOperationPlan {
    const row = this.sqlite.query<{
      id: string; project_id: string; idempotency_key: string;
      state: ReclamationOperationPlan['operationState']; request_json: string;
      result_json: string | null;
    }, [string]>(`
      SELECT id,project_id,idempotency_key,state,request_json,result_json FROM operations
      WHERE id=?1 AND kind='RECLAIM_RESOURCES'
    `).get(operationId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Reclamation operation was not found');
    return {
      operationId: row.id,
      operationState: row.state,
      projectId: row.project_id,
      commandId: row.idempotency_key,
      request: JSON.parse(row.request_json) as Readonly<Record<string, unknown>>,
      result: row.result_json === null
        ? null
        : JSON.parse(row.result_json) as Readonly<Record<string, unknown>>,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Task dependencies (ADR-0024). These methods own the persisted graph and its integrity: the
  // ordered pair is unique, both endpoints must be Tasks of one project, the pinned revision must
  // belong to the prerequisite, and an edge that would introduce a cycle is refused before anything
  // is written. The cycle reasoning runs through the pure domain graph *inside* the write
  // transaction, so two edges that are each legal cannot be committed together into a cycle.
  //
  // Whether an edge is satisfied is deliberately not decided here: these methods expose the
  // recorded integration fact (`integratedCommit`), while the Git question — is that commit still
  // reachable from the project's current `dev` ref — belongs to the scheduler, which has the
  // repository.
  // ---------------------------------------------------------------------------------------------

  /**
   * Every dependency edge of one project, optionally narrowed to one dependent or one prerequisite.
   * Read-only; it verifies the project is trusted but never touches the graph.
   */
  listTaskDependencyFacts(
    projectId: string,
    options: { readonly taskId?: string; readonly prerequisiteTaskId?: string } = {},
  ): readonly TaskDependencyFact[] {
    this.getTrustedProject(projectId);
    const filters: string[] = [];
    const parameters: [string, ...string[]] = [projectId];
    if (options.taskId !== undefined) {
      parameters.push(options.taskId);
      filters.push(`AND dependency.dependent_task_id=?${parameters.length}`);
    }
    if (options.prerequisiteTaskId !== undefined) {
      parameters.push(options.prerequisiteTaskId);
      filters.push(`AND dependency.prerequisite_task_id=?${parameters.length}`);
    }
    // The correlated subqueries pick the newest integration fact for the exact pinned revision. A
    // batch that is not INTEGRATED, or an item that never produced a merged commit, is not a fact at
    // all, so the edge reads as "not integrated" instead of guessing.
    return this.sqlite.query<{
      project_id: string; dependent_task_id: string; dependent_display_number: number;
      dependent_state: TaskLifecycleState; prerequisite_task_id: string;
      prerequisite_display_number: number; prerequisite_state: TaskLifecycleState;
      required_revision_id: string; required_revision_number: number; created_by: string;
      created_at: number; integrated_commit: string | null; integration_batch_id: string | null;
    }, [string, ...string[]]>(`
      SELECT dependency.project_id,dependency.dependent_task_id,
        dependent.display_number AS dependent_display_number,
        dependent.state AS dependent_state,
        dependency.prerequisite_task_id,
        prerequisite.display_number AS prerequisite_display_number,
        prerequisite.state AS prerequisite_state,
        dependency.required_revision_id,revision.number AS required_revision_number,
        dependency.created_by,dependency.created_at,
        (SELECT item.integrated_commit FROM integration_batch_items item
          JOIN integration_batches batch ON batch.id=item.batch_id
          WHERE item.task_id=dependency.prerequisite_task_id
            AND item.revision_id=dependency.required_revision_id
            AND item.state='INTEGRATED' AND item.integrated_commit IS NOT NULL
            AND batch.state='INTEGRATED'
          ORDER BY item.created_at DESC,item.batch_id DESC LIMIT 1) AS integrated_commit,
        (SELECT item.batch_id FROM integration_batch_items item
          JOIN integration_batches batch ON batch.id=item.batch_id
          WHERE item.task_id=dependency.prerequisite_task_id
            AND item.revision_id=dependency.required_revision_id
            AND item.state='INTEGRATED' AND item.integrated_commit IS NOT NULL
            AND batch.state='INTEGRATED'
          ORDER BY item.created_at DESC,item.batch_id DESC LIMIT 1) AS integration_batch_id
      FROM task_dependencies dependency
      JOIN tasks dependent ON dependent.id=dependency.dependent_task_id
      JOIN tasks prerequisite ON prerequisite.id=dependency.prerequisite_task_id
      JOIN task_revisions revision ON revision.task_id=dependency.prerequisite_task_id
        AND revision.id=dependency.required_revision_id
      WHERE dependency.project_id=?1 ${filters.join(' ')}
      ORDER BY dependent.display_number,dependent.id,prerequisite.display_number,prerequisite.id
    `).all(...parameters).map((row) => ({
      projectId: row.project_id,
      dependentTaskId: row.dependent_task_id,
      dependentDisplayNumber: row.dependent_display_number,
      dependentState: row.dependent_state,
      prerequisiteTaskId: row.prerequisite_task_id,
      prerequisiteDisplayNumber: row.prerequisite_display_number,
      prerequisiteState: row.prerequisite_state,
      requiredRevisionId: row.required_revision_id,
      requiredRevisionNumber: row.required_revision_number,
      createdBy: row.created_by,
      createdAt: row.created_at,
      integratedCommit: row.integrated_commit,
      integrationBatchId: row.integration_batch_id,
    }));
  }

  /**
   * Adds one dependency edge, or reports that the identical edge already exists. The pin defaults to
   * the prerequisite's current revision; an existing edge with a *different* pin is refused instead
   * of being retargeted, because edges are immutable (see the `task_dependencies_no_update` trigger).
   */
  addTaskDependency(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly prerequisiteTaskId: string;
    readonly requiredRevisionId?: string | null;
    readonly expectedVersion: number;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly eventId: string;
    readonly actor: string;
    readonly createdAt: number;
  }): TaskDependencyMutation {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.createdAt,
      apply: (database) => {
        const dependent = database.query<{
          state: TaskLifecycleState; version: number;
        }, [string, string]>(`
          SELECT task.state,task.version FROM tasks task
          JOIN project_trusts trust ON trust.project_id=task.project_id AND trust.status='ACTIVE'
          WHERE task.project_id=?1 AND task.id=?2
        `).get(input.projectId, input.taskId);
        if (dependent === null) {
          throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
        }
        if (dependent.version !== input.expectedVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
        }
        if (!taskDependencyEditableStates.has(dependent.state)) {
          throw new StorageError('INVALID_STATE',
            `Dependencies cannot be edited while the Task is ${dependent.state}`);
        }
        if (input.taskId === input.prerequisiteTaskId) {
          throw new TaskDependencyError('SELF_DEPENDENCY', 'A Task cannot depend on itself');
        }
        const prerequisite = database.query<{
          current_revision_id: string;
        }, [string, string]>(`
          SELECT current_revision_id FROM tasks WHERE project_id=?1 AND id=?2
        `).get(input.projectId, input.prerequisiteTaskId);
        if (prerequisite === null) {
          throw new StorageError('NOT_FOUND', 'Prerequisite Task was not found in this project');
        }
        const pinnedRevisionId = input.requiredRevisionId ?? prerequisite.current_revision_id;
        const revision = database.query<{ id: string }, [string, string]>(`
          SELECT id FROM task_revisions WHERE task_id=?1 AND id=?2
        `).get(input.prerequisiteTaskId, pinnedRevisionId);
        if (revision === null) {
          throw new StorageError('NOT_FOUND',
            'The pinned revision does not belong to the prerequisite Task');
        }
        const existing = database.query<{
          required_revision_id: string;
        }, [string, string]>(`
          SELECT required_revision_id FROM task_dependencies
          WHERE dependent_task_id=?1 AND prerequisite_task_id=?2
        `).get(input.taskId, input.prerequisiteTaskId);
        if (existing !== null) {
          if (existing.required_revision_id !== pinnedRevisionId) {
            throw new StorageError('INVALID_STATE',
              'This dependency already exists with a different pinned revision; remove it first');
          }
          return {
            projectId: input.projectId,
            taskId: input.taskId,
            prerequisiteTaskId: input.prerequisiteTaskId,
            requiredRevisionId: pinnedRevisionId,
            taskState: dependent.state,
            version: dependent.version,
            added: false,
          };
        }
        const edges = database.query<{
          dependent_task_id: string; prerequisite_task_id: string; required_revision_id: string;
        }, [string]>(`
          SELECT dependent_task_id,prerequisite_task_id,required_revision_id
          FROM task_dependencies WHERE project_id=?1
        `).all(input.projectId).map((row): DependencyEdge => ({
          dependentTaskId: row.dependent_task_id,
          prerequisiteTaskId: row.prerequisite_task_id,
          requiredRevisionId: row.required_revision_id,
        }));
        const cycle = wouldCreateCycle(dependencyGraphOf(edges), {
          dependentTaskId: input.taskId,
          prerequisiteTaskId: input.prerequisiteTaskId,
          requiredRevisionId: pinnedRevisionId,
        });
        if (cycle !== null) {
          throw new TaskDependencyError('DEPENDENCY_CYCLE',
            `Adding this dependency would create a cycle: ${cycle.join(' -> ')}`);
        }
        database.query(`
          INSERT INTO task_dependencies(dependent_task_id,prerequisite_task_id,project_id,
            required_revision_id,created_by,created_at)
          VALUES (?1,?2,?3,?4,?5,?6)
        `).run(input.taskId, input.prerequisiteTaskId, input.projectId, pinnedRevisionId,
          input.actor, input.createdAt);
        const version = dependent.version + 1;
        const update = database.query(`
          UPDATE tasks SET version=?1,updated_at=?2
          WHERE project_id=?3 AND id=?4 AND version=?5
        `).run(version, input.createdAt, input.projectId, input.taskId, input.expectedVersion);
        if (update.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during the dependency edit');
        }
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskDependencyAdded',1,'Task',?3,?4,?5,?5,?6,?7)
        `).run(input.eventId, input.projectId, input.taskId, version, input.commandId,
          input.createdAt, JSON.stringify({ taskId: input.taskId,
            prerequisiteTaskId: input.prerequisiteTaskId, requiredRevisionId: pinnedRevisionId,
            actor: input.actor }));
        return {
          projectId: input.projectId,
          taskId: input.taskId,
          prerequisiteTaskId: input.prerequisiteTaskId,
          requiredRevisionId: pinnedRevisionId,
          taskState: dependent.state,
          version,
          added: true,
        };
      },
    });
  }

  /**
   * Removes one dependency edge. A removal that finds nothing is refused rather than reported as a
   * success: a script that meant to remove a real edge must learn that the graph was not what it
   * assumed. Replaying the *same* command ID returns the recorded removal instead.
   */
  removeTaskDependency(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly prerequisiteTaskId: string;
    readonly expectedVersion: number;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly eventId: string;
    readonly actor: string;
    readonly removedAt: number;
  }): TaskDependencyRemoval {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.removedAt,
      apply: (database) => {
        const dependent = database.query<{
          state: TaskLifecycleState; version: number;
        }, [string, string]>(`
          SELECT task.state,task.version FROM tasks task
          JOIN project_trusts trust ON trust.project_id=task.project_id AND trust.status='ACTIVE'
          WHERE task.project_id=?1 AND task.id=?2
        `).get(input.projectId, input.taskId);
        if (dependent === null) {
          throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
        }
        if (dependent.version !== input.expectedVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
        }
        if (!taskDependencyEditableStates.has(dependent.state)) {
          throw new StorageError('INVALID_STATE',
            `Dependencies cannot be edited while the Task is ${dependent.state}`);
        }
        const removed = database.query(`
          DELETE FROM task_dependencies WHERE dependent_task_id=?1 AND prerequisite_task_id=?2
        `).run(input.taskId, input.prerequisiteTaskId);
        if (removed.changes !== 1) {
          throw new StorageError('NOT_FOUND', 'Dependency edge was not found');
        }
        const version = dependent.version + 1;
        const update = database.query(`
          UPDATE tasks SET version=?1,updated_at=?2
          WHERE project_id=?3 AND id=?4 AND version=?5
        `).run(version, input.removedAt, input.projectId, input.taskId, input.expectedVersion);
        if (update.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during the dependency edit');
        }
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskDependencyRemoved',1,'Task',?3,?4,?5,?5,?6,?7)
        `).run(input.eventId, input.projectId, input.taskId, version, input.commandId,
          input.removedAt, JSON.stringify({ taskId: input.taskId,
            prerequisiteTaskId: input.prerequisiteTaskId, actor: input.actor }));
        return {
          projectId: input.projectId,
          taskId: input.taskId,
          prerequisiteTaskId: input.prerequisiteTaskId,
          taskState: dependent.state,
          version,
          removed: true,
        };
      },
    });
  }

  /**
   * Applies the dependency verdict the scheduler computed: READY when every edge is satisfied,
   * BLOCKED otherwise. Only these two states may change here, and BLOCKED requires a named reason —
   * an unexplained "blocked" is exactly the state machine's forbidden bucket for conflicts,
   * capacity, and failures (§2.10). A no-op writes no event and does not move the version.
   */
  applyTaskDependencyState(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly target: 'READY' | 'BLOCKED';
    readonly reasons: readonly TaskDependencyBlockReason[];
    readonly commandId: string;
    readonly payloadHash: string;
    readonly eventId: string;
    readonly actor: string;
    readonly at: number;
  }): TaskDependencyStateChange {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.at,
      apply: (database) => {
        const task = database.query<{
          state: TaskLifecycleState; version: number;
        }, [string, string]>(`
          SELECT task.state,task.version FROM tasks task
          JOIN project_trusts trust ON trust.project_id=task.project_id AND trust.status='ACTIVE'
          WHERE task.project_id=?1 AND task.id=?2
        `).get(input.projectId, input.taskId);
        if (task === null) {
          throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
        }
        if (task.version !== input.expectedVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
        }
        if (task.state !== 'READY' && task.state !== 'BLOCKED') {
          throw new StorageError('INVALID_STATE',
            `Dependency state only moves between READY and BLOCKED; the Task is ${task.state}`);
        }
        if (input.target === 'READY' && input.reasons.length > 0) {
          throw new StorageError('INVALID_STATE',
            'A Task cannot become READY while an unmet dependency is still named');
        }
        if (input.target === 'BLOCKED' && input.reasons.length === 0) {
          throw new StorageError('INVALID_STATE',
            'A Task cannot become BLOCKED without naming the unmet dependency');
        }
        if (task.state === input.target) {
          return {
            taskId: input.taskId,
            state: task.state,
            version: task.version,
            changed: false,
            reasons: input.reasons,
          };
        }
        const version = task.version + 1;
        const update = database.query(`
          UPDATE tasks SET state=?1,version=?2,updated_at=?3
          WHERE project_id=?4 AND id=?5 AND version=?6 AND state=?7
        `).run(input.target, version, input.at, input.projectId, input.taskId,
          input.expectedVersion, task.state);
        if (update.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during the dependency verdict');
        }
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?5,?6,?7)
        `).run(input.eventId, input.projectId, input.taskId, version, input.commandId, input.at,
          JSON.stringify({ taskId: input.taskId, from: task.state, to: input.target,
            reason: input.target === 'BLOCKED' ? 'dependency unmet' : 'dependencies satisfied',
            dependencies: input.reasons, actor: input.actor }));
        return {
          taskId: input.taskId,
          state: input.target,
          version,
          changed: true,
          reasons: input.reasons,
        };
      },
    });
  }
  // -------------------------------------------------------------------------------------------
  // Session handoff (ADR-0023): the ordered incarnation history of one Agent Session, the single
  // writer lease, the handoff fence facts, and the routing of one STRICT permission decision back
  // to the exact incarnation that asked for it.
  //
  // Pi offers no session-file exclusivity (FOUNDATION-040 T6-E measured two writers appending to
  // one file without an error), so "one provider writer per conversation" is enforced here: a
  // successor incarnation may only be recorded once its predecessor stopped claiming to be current
  // *and* nobody holds the writer lease, and at most one un-released lease exists per Session.
  // -------------------------------------------------------------------------------------------

  /** Ordered process-generation history of one Agent Session, oldest first. */
  listSessionIncarnations(sessionId: string): readonly SessionIncarnationRecord[] {
    return this.sqlite.query<SessionIncarnationRow, [string]>(`
      SELECT id,session_id,execution_id,incarnation_number,mode,state,provider_pid,
        process_identity_json,process_tree_json,provider_session_id,session_storage_ref,
        predecessor_incarnation_id,command_id,created_at,ended_at,exit_json
      FROM session_incarnations WHERE session_id=?1 ORDER BY incarnation_number
    `).all(sessionId).map(mapSessionIncarnationRow);
  }

  /**
   * The one incarnation a decision may still reach. `agent_sessions.current_incarnation_id` is the
   * single place that answers this, so a successor recording itself and a permission decision being
   * applied cannot both be right: the decision checks this value in its own conditional update.
   */
  getCurrentSessionIncarnation(sessionId: string): SessionIncarnationRecord | null {
    const row = this.sqlite.query<SessionIncarnationRow, [string]>(`
      SELECT incarnation.id,incarnation.session_id,incarnation.execution_id,
        incarnation.incarnation_number,incarnation.mode,incarnation.state,incarnation.provider_pid,
        incarnation.process_identity_json,incarnation.process_tree_json,
        incarnation.provider_session_id,incarnation.session_storage_ref,
        incarnation.predecessor_incarnation_id,incarnation.command_id,incarnation.created_at,
        incarnation.ended_at,incarnation.exit_json
      FROM session_incarnations incarnation JOIN agent_sessions session
        ON session.current_incarnation_id=incarnation.id
      WHERE session.id=?1
    `).get(sessionId);
    return row === null ? null : mapSessionIncarnationRow(row);
  }

  getSessionIncarnation(incarnationId: string): SessionIncarnationRecord | null {
    const row = this.sqlite.query<SessionIncarnationRow, [string]>(`
      SELECT id,session_id,execution_id,incarnation_number,mode,state,provider_pid,
        process_identity_json,process_tree_json,provider_session_id,session_storage_ref,
        predecessor_incarnation_id,command_id,created_at,ended_at,exit_json
      FROM session_incarnations WHERE id=?1
    `).get(incarnationId);
    return row === null ? null : mapSessionIncarnationRow(row);
  }

  /** Incarnations that still claim the conversation: they must be reconciled before a successor. */
  listLiveSessionIncarnations(): readonly SessionIncarnationRecord[] {
    return this.sqlite.query<SessionIncarnationRow, []>(`
      SELECT id,session_id,execution_id,incarnation_number,mode,state,provider_pid,
        process_identity_json,process_tree_json,provider_session_id,session_storage_ref,
        predecessor_incarnation_id,command_id,created_at,ended_at,exit_json
      FROM session_incarnations WHERE state IN ('ACTIVE','FENCED') ORDER BY created_at,id
    `).all().map(mapSessionIncarnationRow);
  }

  /** The un-released writer lease of one Session, or null when the Session has no writer. */
  getSessionWriterLease(sessionId: string): SessionWriterLeaseRecord | null {
    const row = this.sqlite.query<SessionWriterLeaseRow, [string]>(`
      SELECT id,session_id,incarnation_id,holder_kind,holder_ref,command_id,acquired_at,
        released_at,release_reason
      FROM session_writer_leases WHERE session_id=?1 AND released_at IS NULL
    `).get(sessionId);
    return row === null ? null : mapSessionWriterLeaseRow(row);
  }

  listActiveSessionWriterLeases(): readonly SessionWriterLeaseRecord[] {
    return this.sqlite.query<SessionWriterLeaseRow, []>(`
      SELECT id,session_id,incarnation_id,holder_kind,holder_ref,command_id,acquired_at,
        released_at,release_reason
      FROM session_writer_leases WHERE released_at IS NULL ORDER BY acquired_at,id
    `).all().map(mapSessionWriterLeaseRow);
  }

  listSessionWriterLeases(sessionId: string): readonly SessionWriterLeaseRecord[] {
    return this.sqlite.query<SessionWriterLeaseRow, [string]>(`
      SELECT id,session_id,incarnation_id,holder_kind,holder_ref,command_id,acquired_at,
        released_at,release_reason
      FROM session_writer_leases WHERE session_id=?1 ORDER BY acquired_at,id
    `).all(sessionId).map(mapSessionWriterLeaseRow);
  }

  /**
   * Records one provider incarnation and takes the single writer lease for it.
   *
   * Replaying the same `commandId` returns the recorded incarnation instead of creating a second
   * one. A new incarnation is refused while any incarnation of the Session is still ACTIVE/FENCED
   * or while a writer lease is un-released: that refusal is what keeps two provider processes from
   * writing one conversation, and it is a stable error code rather than a silent queue.
   */
  recordSessionIncarnation(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly mode: SessionIncarnationMode;
    readonly commandId: string;
    readonly providerPid: number | null;
    readonly processIdentity: unknown;
    readonly processTree: unknown;
    readonly providerSessionId: string | null;
    readonly sessionStorageRef: string | null;
    readonly createdAt: number;
  }): SessionIncarnationWrite {
    return this.sqlite.transaction(() => {
      const replayed = this.sessionIncarnationByCommand(input.sessionId, input.commandId);
      if (replayed !== null) {
        return { incarnation: replayed, lease: this.getSessionWriterLease(input.sessionId),
          takenOver: false, replayed: true };
      }
      const session = this.sqlite.query<{ execution_id: string }, [string]>(
        'SELECT execution_id FROM agent_sessions WHERE id=?1',
      ).get(input.sessionId);
      if (session === null) throw new StorageError('NOT_FOUND', 'Agent Session was not found');
      const live = this.sqlite.query<{ incarnation_number: number; state: string }, [string]>(`
        SELECT incarnation_number,state FROM session_incarnations
        WHERE session_id=?1 AND state IN ('ACTIVE','FENCED') ORDER BY incarnation_number DESC LIMIT 1
      `).get(input.sessionId);
      if (live !== null) {
        throw new StorageError('INVALID_STATE', 'PREDECESSOR_STILL_ACTIVE:'
          + ` incarnation ${live.incarnation_number} is still ${live.state}`);
      }
      const held = this.getSessionWriterLease(input.sessionId);
      if (held !== null) {
        throw new StorageError('INVALID_STATE',
          `WRITER_LEASE_HELD: ${held.holderKind} holder ${held.holderRef} has not released the lease`);
      }
      const previous = this.sqlite.query<{
        id: string; incarnation_number: number; provider_session_id: string | null;
        session_storage_ref: string | null;
      }, [string]>(`
        SELECT id,incarnation_number,provider_session_id,session_storage_ref FROM session_incarnations
        WHERE session_id=?1 ORDER BY incarnation_number DESC LIMIT 1
      `).get(input.sessionId);
      if (previous !== null && previous.session_storage_ref !== null
        && input.sessionStorageRef !== null
        && previous.session_storage_ref !== input.sessionStorageRef) {
        // A successor continues the *same* conversation; pointing it at another file would be a
        // second conversation wearing the same Session identity.
        throw new StorageError('INVALID_STATE',
          'SESSION_FILE_CHANGED: a successor incarnation must reopen the same provider session file');
      }
      const incarnationNumber = (previous?.incarnation_number ?? 0) + 1;
      this.sqlite.query(`
        INSERT INTO session_incarnations(id,session_id,execution_id,incarnation_number,mode,state,
          provider_pid,process_identity_json,process_tree_json,provider_session_id,
          session_storage_ref,predecessor_incarnation_id,command_id,created_at)
        VALUES (?1,?2,?3,?4,?5,'ACTIVE',?6,?7,?8,?9,?10,?11,?12,?13)
      `).run(input.id, input.sessionId, session.execution_id, incarnationNumber, input.mode,
        input.providerPid, input.processIdentity === null ? null : JSON.stringify(input.processIdentity),
        input.processTree === null ? null : JSON.stringify(input.processTree),
        input.providerSessionId, input.sessionStorageRef, previous?.id ?? null, input.commandId,
        input.createdAt);
      this.sqlite.query('UPDATE agent_sessions SET current_incarnation_id=?1 WHERE id=?2')
        .run(input.id, input.sessionId);
      const lease = this.#insertSessionWriterLease({
        sessionId: input.sessionId,
        incarnationId: input.id,
        holderKind: input.mode === 'AUTOMATED_RPC' ? 'AUTOMATED_RPC' : 'TERMINAL_ATTACHMENT',
        holderRef: `${input.mode}:${input.id}`,
        commandId: input.commandId,
        acquiredAt: input.createdAt,
      });
      return {
        incarnation: this.getSessionIncarnation(input.id) as SessionIncarnationRecord,
        lease,
        takenOver: false,
        replayed: false,
      };
    })();
  }

  /**
   * Takes the writer lease for one existing incarnation. A second holder never waits: it is told
   * the Session already has a writer (`ATTACHMENT_BUSY`), which is what a script can assert.
   */
  acquireSessionWriterLease(input: {
    readonly sessionId: string;
    readonly incarnationId: string;
    readonly holderKind: SessionWriterLeaseRecord['holderKind'];
    readonly holderRef: string;
    readonly commandId: string;
    readonly acquiredAt: number;
  }): SessionWriterLeaseAcquisition {
    return this.sqlite.transaction(() => {
      const active = this.getSessionWriterLease(input.sessionId);
      if (active !== null) {
        if (active.holderRef === input.holderRef) {
          return { acquired: true as const, code: null, lease: active, replayed: true, holder: null };
        }
        return { acquired: false as const, code: 'ATTACHMENT_BUSY' as const, lease: null,
          replayed: false, holder: { holderKind: active.holderKind, holderRef: active.holderRef,
            acquiredAt: active.acquiredAt } };
      }
      const current = this.getCurrentSessionIncarnation(input.sessionId);
      if (current === null || current.id !== input.incarnationId) {
        return { acquired: false as const, code: 'INCARNATION_NOT_CURRENT' as const, lease: null,
          replayed: false, holder: null };
      }
      const expected = current.mode === 'AUTOMATED_RPC' ? 'AUTOMATED_RPC' : 'TERMINAL_ATTACHMENT';
      if (input.holderKind !== expected) {
        return { acquired: false as const, code: 'HOLDER_MISMATCH' as const, lease: null,
          replayed: false, holder: null };
      }
      const lease = this.#insertSessionWriterLease(input);
      return { acquired: true as const, code: null, lease, replayed: false, holder: null };
    })();
  }

  /** Releases the writer lease when the given holder still owns it; never releases another's. */
  releaseSessionWriterLease(input: {
    readonly sessionId: string;
    readonly holderRef: string;
    readonly reason: string;
    readonly releasedAt: number;
  }): { readonly released: boolean; readonly code: 'RELEASED' | 'NO_LEASE' | 'HOLDER_MISMATCH' } {
    return this.sqlite.transaction(() => {
      const active = this.getSessionWriterLease(input.sessionId);
      const result = this.sqlite.query(`
        UPDATE session_writer_leases SET released_at=?1,release_reason=?2
        WHERE session_id=?3 AND holder_ref=?4 AND released_at IS NULL
      `).run(input.releasedAt, input.reason, input.sessionId, input.holderRef);
      if (result.changes !== 1) {
        return { released: false as const,
          code: (active === null ? 'NO_LEASE' : 'HOLDER_MISMATCH') as 'NO_LEASE' | 'HOLDER_MISMATCH' };
      }
      if (active !== null) this.#appendWriterLeaseChangeForRelease(this.sqlite, active, input.reason,
        input.releasedAt);
      return { released: true as const, code: 'RELEASED' as const };
    })();
  }

  releaseSessionWriterLeaseForSession(input: {
    readonly sessionId: string;
    readonly reason: string;
    readonly releasedAt: number;
  }): boolean {
    return this.sqlite.transaction(() => {
      const active = this.getSessionWriterLease(input.sessionId);
      const result = this.sqlite.query(`
        UPDATE session_writer_leases SET released_at=?1,release_reason=?2
        WHERE session_id=?3 AND released_at IS NULL
      `).run(input.releasedAt, input.reason, input.sessionId);
      if (result.changes !== 1) return false;
      if (active !== null) this.#appendWriterLeaseChangeForRelease(this.sqlite, active, input.reason,
        input.releasedAt);
      return true;
    })();
  }

  /**
   * Records the persisted handoff intent and the fence. The fence is a fact only once the provider
   * acknowledges it, so the row starts as REQUESTED with `fence_active=0`.
   */
  recordSessionHandoffRequest(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly executionId: string;
    readonly incarnationId: string;
    readonly kind: SessionHandoffKind;
    readonly commandId: string;
    readonly createdAt: number;
    /** The domain event id of the `TakeoverRequested` fact this insert is committed with. */
    readonly eventId: string;
  }): { readonly request: SessionHandoffRequestRecord; readonly replayed: boolean } {
    return this.sqlite.transaction(() => {
      const replayed = this.sqlite.query<SessionHandoffRequestRow, [string, string]>(`
        SELECT id,session_id,execution_id,incarnation_id,kind,state,command_id,fence_active,
          fence_confirmed_at,settled_after_fence_at,safe_point_at,admitted_at,detail,created_at,updated_at
        FROM session_handoff_requests WHERE session_id=?1 AND command_id=?2
      `).get(input.sessionId, input.commandId);
      if (replayed !== null) {
        return { request: mapSessionHandoffRequestRow(replayed), replayed: true };
      }
      const open = this.getOpenSessionHandoffRequest(input.sessionId);
      if (open !== null) {
        throw new StorageError('INVALID_STATE',
          `HANDOFF_ALREADY_REQUESTED: ${open.kind} request ${open.id} is ${open.state}`);
      }
      const existing = this.getSessionIncarnation(input.incarnationId);
      if (existing === null) {
        throw new StorageError('NOT_FOUND', 'Session incarnation was not found');
      }
      this.sqlite.query(`
        INSERT INTO session_handoff_requests(id,session_id,execution_id,incarnation_id,kind,state,
          command_id,fence_active,detail,created_at,updated_at)
        VALUES (?1,?2,?3,?4,?5,'REQUESTED',?6,0,NULL,?7,?7)
      `).run(input.id, input.sessionId, input.executionId, input.incarnationId, input.kind,
        input.commandId, input.createdAt);
      // The intent and its event are one fact: a recorded request without its event (or the reverse)
      // would let a reader see a takeover that was never asked for.
      this.#handoffEventScope(this.sqlite, input.sessionId, input.eventId, 'TakeoverRequested',
        input.id, input.commandId, input.createdAt, {
          takeoverId: input.id,
          sessionId: input.sessionId,
          executionId: input.executionId,
          incarnationId: input.incarnationId,
          kind: input.kind,
          targetMode: existing.mode === 'AUTOMATED_RPC' ? 'HUMAN_TUI' : 'AUTOMATED_RPC',
        } satisfies TakeoverRequestedPayload);
      return {
        request: this.getSessionHandoffRequest(input.id) as SessionHandoffRequestRecord,
        replayed: false,
      };
    })();
  }

  getSessionHandoffRequest(requestId: string): SessionHandoffRequestRecord | null {
    const row = this.sqlite.query<SessionHandoffRequestRow, [string]>(`
      SELECT id,session_id,execution_id,incarnation_id,kind,state,command_id,fence_active,
        fence_confirmed_at,settled_after_fence_at,safe_point_at,admitted_at,detail,created_at,updated_at
      FROM session_handoff_requests WHERE id=?1
    `).get(requestId);
    return row === null ? null : mapSessionHandoffRequestRow(row);
  }

  /** The handoff request that is still in flight for one Session, if any. */
  getOpenSessionHandoffRequest(sessionId: string): SessionHandoffRequestRecord | null {
    const row = this.sqlite.query<SessionHandoffRequestRow, [string]>(`
      SELECT id,session_id,execution_id,incarnation_id,kind,state,command_id,fence_active,
        fence_confirmed_at,settled_after_fence_at,safe_point_at,admitted_at,detail,created_at,updated_at
      FROM session_handoff_requests WHERE session_id=?1
        AND state IN ('REQUESTED','FENCED','AT_SAFE_POINT') ORDER BY created_at DESC LIMIT 1
    `).get(sessionId);
    return row === null ? null : mapSessionHandoffRequestRow(row);
  }

  listSessionHandoffRequests(sessionId: string): readonly SessionHandoffRequestRecord[] {
    return this.sqlite.query<SessionHandoffRequestRow, [string]>(`
      SELECT id,session_id,execution_id,incarnation_id,kind,state,command_id,fence_active,
        fence_confirmed_at,settled_after_fence_at,safe_point_at,admitted_at,detail,created_at,updated_at
      FROM session_handoff_requests WHERE session_id=?1 ORDER BY created_at,id
    `).all(sessionId).map(mapSessionHandoffRequestRow);
  }

  listOpenSessionHandoffRequests(): readonly SessionHandoffRequestRecord[] {
    return this.sqlite.query<SessionHandoffRequestRow, []>(`
      SELECT id,session_id,execution_id,incarnation_id,kind,state,command_id,fence_active,
        fence_confirmed_at,settled_after_fence_at,safe_point_at,admitted_at,detail,created_at,updated_at
      FROM session_handoff_requests WHERE state IN ('REQUESTED','FENCED','AT_SAFE_POINT')
      ORDER BY created_at,id
    `).all().map(mapSessionHandoffRequestRow);
  }

  /** Records the provider's own acknowledgement that the handoff fence is installed. */
  confirmSessionHandoffFence(input: {
    readonly requestId: string;
    readonly at: number;
  }): SessionHandoffRequestRecord {
    return this.sqlite.transaction(() => {
      const result = this.sqlite.query(`
        UPDATE session_handoff_requests SET state='FENCED',fence_active=1,fence_confirmed_at=?1,
          updated_at=?1 WHERE id=?2 AND state='REQUESTED'
      `).run(input.at, input.requestId);
      if (result.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Handoff fence acknowledgement did not match a REQUESTED handoff');
      }
      const request = this.getSessionHandoffRequest(input.requestId) as SessionHandoffRequestRecord;
      this.sqlite.query(`
        UPDATE session_incarnations SET state='FENCED'
        WHERE id=?1 AND state='ACTIVE'
      `).run(request.incarnationId);
      return request;
    })();
  }

  /** Records the settled fact that arrived after the fence; the safe point needs it. */
  recordSessionHandoffSettled(input: {
    readonly requestId: string;
    readonly at: number;
  }): SessionHandoffRequestRecord {
    const result = this.sqlite.query(`
      UPDATE session_handoff_requests SET settled_after_fence_at=?1,updated_at=?1
      WHERE id=?2 AND state IN ('FENCED','AT_SAFE_POINT') AND fence_active=1
    `).run(input.at, input.requestId);
    if (result.changes !== 1) {
      throw new StorageError('INVALID_STATE', 'Settled fact did not match a fenced handoff request');
    }
    return this.getSessionHandoffRequest(input.requestId) as SessionHandoffRequestRecord;
  }

  recordSessionHandoffSafePoint(input: {
    readonly requestId: string;
    readonly at: number;
    readonly detail: string;
    readonly eventId: string;
    /** Facts the Runtime observed when it decided the safe point; stored verbatim, never re-derived. */
    readonly activeTools: number;
    readonly missing: readonly string[];
    readonly evidenceRef: string | null;
  }): SessionHandoffRequestRecord {
    return this.sqlite.transaction(() => {
      const result = this.sqlite.query(`
        UPDATE session_handoff_requests SET state='AT_SAFE_POINT',safe_point_at=?1,detail=?2,updated_at=?1
        WHERE id=?3 AND state='FENCED' AND fence_active=1
      `).run(input.at, input.detail, input.requestId);
      if (result.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Safe point did not match a fenced handoff request');
      }
      const request = this.getSessionHandoffRequest(input.requestId) as SessionHandoffRequestRecord;
      this.#handoffEventScope(this.sqlite, request.sessionId, input.eventId,
        'TakeoverSafePointReached', request.id, request.commandId, input.at, {
          takeoverId: request.id,
          sessionId: request.sessionId,
          executionId: request.executionId,
          incarnationId: request.incarnationId,
          reachedFrom: 'RPC_FENCE',
          fenceAcknowledged: request.fenceActive,
          settledAfterFenceAt: request.settledAfterFenceAt,
          activeTools: input.activeTools,
          evidenceRef: input.evidenceRef,
          lastEntryRef: null,
          missing: [...input.missing],
        } satisfies TakeoverSafePointReachedPayload);
      return request;
    })();
  }

  markSessionHandoffAdmitted(input: {
    readonly requestId: string;
    readonly at: number;
    readonly detail: string;
    readonly eventId: string;
    /** The successor process that was really started, recorded and holding the writer lease. */
    readonly completion: {
      readonly successorIncarnationId: string;
      readonly successorIncarnationNumber: number;
      readonly terminalTransport: 'PTY' | 'RPC' | 'NONE';
      readonly terminalId: string | null;
      readonly providerPid: number | null;
      readonly processEvidenceRef: string | null;
    };
  }): SessionHandoffRequestRecord {
    return this.sqlite.transaction(() => {
      const result = this.sqlite.query(`
        UPDATE session_handoff_requests SET state='ADMITTED',admitted_at=?1,detail=?2,updated_at=?1
        WHERE id=?3 AND state='AT_SAFE_POINT'
      `).run(input.at, input.detail, input.requestId);
      if (result.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Admission did not match a handoff request at its safe point');
      }
      const request = this.getSessionHandoffRequest(input.requestId) as SessionHandoffRequestRecord;
      const source = this.getSessionIncarnation(request.incarnationId);
      const successor = this.getSessionIncarnation(input.completion.successorIncarnationId);
      if (source === null || successor === null) {
        throw new StorageError('NOT_FOUND', 'The admitted handoff names an incarnation that is gone');
      }
      this.#handoffEventScope(this.sqlite, request.sessionId, input.eventId,
        'SessionHandoffCompleted', request.id, request.commandId, input.at, {
          takeoverId: request.id,
          sourceSessionId: request.sessionId,
          targetSessionId: request.sessionId,
          sourceIncarnationId: request.incarnationId,
          successorIncarnationId: successor.id,
          successorIncarnationNumber: input.completion.successorIncarnationNumber,
          fromMode: source.mode,
          toMode: successor.mode,
          terminalTransport: input.completion.terminalTransport,
          terminalId: input.completion.terminalId,
          providerPid: input.completion.providerPid,
          processEvidenceRef: input.completion.processEvidenceRef,
        } satisfies SessionHandoffCompletedPayload);
      return request;
    })();
  }

  /** An abandoned handoff releases its fence; the incarnation may run tools again. */
  cancelSessionHandoffRequest(input: {
    readonly requestId: string;
    readonly at: number;
    readonly detail: string;
  }): SessionHandoffRequestRecord {
    return this.sqlite.transaction(() => {
      const result = this.sqlite.query(`
        UPDATE session_handoff_requests SET state='CANCELLED',fence_active=0,detail=?1,updated_at=?2
        WHERE id=?3 AND state IN ('REQUESTED','FENCED','AT_SAFE_POINT')
      `).run(input.detail, input.at, input.requestId);
      if (result.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Handoff request was not open');
      }
      const request = this.getSessionHandoffRequest(input.requestId) as SessionHandoffRequestRecord;
      this.sqlite.query(`
        UPDATE session_incarnations SET state='ACTIVE' WHERE id=?1 AND state='FENCED'
      `).run(request.incarnationId);
      return request;
    })();
  }

  markSessionHandoffRecoveryRequired(input: {
    readonly requestId: string;
    readonly at: number;
    readonly detail: string;
  }): SessionHandoffRequestRecord {
    this.sqlite.query(`
      UPDATE session_handoff_requests SET state='RECOVERY_REQUIRED',fence_active=0,detail=?1,updated_at=?2
      WHERE id=?3 AND state IN ('REQUESTED','FENCED','AT_SAFE_POINT')
    `).run(input.detail, input.at, input.requestId);
    return this.getSessionHandoffRequest(input.requestId) as SessionHandoffRequestRecord;
  }

  /**
   * A reconciliation fact: this incarnation may no longer write the conversation. It stops being
   * the current incarnation in the same statement, so no later decision can reach it.
   */
  markSessionIncarnationRecoveryRequired(input: {
    readonly incarnationId: string;
    readonly at: number;
    readonly detail: Readonly<Record<string, unknown>>;
  }): void {
    this.sqlite.transaction(() => {
      const incarnation = this.getSessionIncarnation(input.incarnationId);
      if (incarnation === null) throw new StorageError('NOT_FOUND', 'Session incarnation was not found');
      this.sqlite.query(`
        UPDATE session_incarnations SET state='RECOVERY_REQUIRED',exit_json=?1
        WHERE id=?2 AND state IN ('ACTIVE','FENCED')
      `).run(JSON.stringify(input.detail), input.incarnationId);
      this.sqlite.query(`
        UPDATE agent_sessions SET current_incarnation_id=NULL
        WHERE id=?1 AND current_incarnation_id=?2
      `).run(incarnation.sessionId, input.incarnationId);
    })();
  }

  /**
   * Records one STRICT permission request as a real Attention together with the incarnation that
   * asked. The two are written in one transaction: an Attention without its incarnation binding
   * could never be routed, and a binding without its Attention could never be answered.
   *
   * `prompt` is the structured request (`codeestra.permission`: tool name, exact input, input
   * fingerprint), so what the user approves is reproducible from the row alone.
   */
  recordSessionPermissionRequest(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly executionId: string;
    readonly incarnationId: string;
    readonly providerRequestId: string;
    readonly providerEventId: string;
    readonly cursor: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly inputJson: string;
    readonly inputFingerprint: string;
    readonly piMode: string;
    readonly prompt: unknown;
    readonly attentionId: string;
    readonly attentionEventId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly requestedAt: number;
  }): { readonly permission: SessionPermissionRequestRecord; readonly duplicate: boolean } {
    return this.sqlite.transaction(() => {
      const existing = this.getSessionPermissionRequestByProviderRequestId(
        input.sessionId, input.providerRequestId);
      if (existing !== null) return { permission: existing, duplicate: true };
      this.recordAgentAttention({
        sessionId: input.sessionId,
        executionId: input.executionId,
        providerEventId: input.providerEventId,
        cursor: input.cursor,
        providerRequestId: input.providerRequestId,
        kind: 'PERMISSION',
        responseType: 'CONFIRM',
        prompt: input.prompt,
        attentionId: input.attentionId,
        attentionEventId: input.attentionEventId,
        executionEventId: input.executionEventId,
        taskEventId: input.taskEventId,
        observedAt: input.requestedAt,
      });
      this.sqlite.query(`
        INSERT INTO session_permission_requests(id,attention_id,session_id,incarnation_id,
          provider_request_id,tool_call_id,tool_name,input_json,input_fingerprint,pi_mode,decision,
          requested_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'OPEN',?11)
      `).run(input.id, input.attentionId, input.sessionId, input.incarnationId,
        input.providerRequestId, input.toolCallId, input.toolName, input.inputJson,
        input.inputFingerprint, input.piMode, input.requestedAt);
      return {
        permission: this.getSessionPermissionRequest(input.attentionId) as SessionPermissionRequestRecord,
        duplicate: false,
      };
    })();
  }

  getSessionPermissionRequest(attentionId: string): SessionPermissionRequestRecord | null {
    const row = this.sqlite.query<SessionPermissionRequestRow, [string]>(`
      SELECT id,attention_id,session_id,incarnation_id,provider_request_id,tool_call_id,tool_name,
        input_json,input_fingerprint,pi_mode,decision,requested_at,decided_at,decided_by
      FROM session_permission_requests WHERE attention_id=?1
    `).get(attentionId);
    return row === null ? null : mapSessionPermissionRequestRow(row);
  }

  getSessionPermissionRequestByProviderRequestId(
    sessionId: string,
    providerRequestId: string,
  ): SessionPermissionRequestRecord | null {
    const row = this.sqlite.query<SessionPermissionRequestRow, [string, string]>(`
      SELECT id,attention_id,session_id,incarnation_id,provider_request_id,tool_call_id,tool_name,
        input_json,input_fingerprint,pi_mode,decision,requested_at,decided_at,decided_by
      FROM session_permission_requests WHERE session_id=?1 AND provider_request_id=?2
    `).get(sessionId, providerRequestId);
    return row === null ? null : mapSessionPermissionRequestRow(row);
  }

  /** Every permission request of one Session, oldest first; the audit view of STRICT decisions. */
  listSessionPermissionRequests(sessionId: string): readonly SessionPermissionRequestRecord[] {
    return this.sqlite.query<SessionPermissionRequestRow, [string]>(`
      SELECT id,attention_id,session_id,incarnation_id,provider_request_id,tool_call_id,tool_name,
        input_json,input_fingerprint,pi_mode,decision,requested_at,decided_at,decided_by
      FROM session_permission_requests WHERE session_id=?1 ORDER BY requested_at,id
    `).all(sessionId).map(mapSessionPermissionRequestRow);
  }

  getOpenSessionPermissionRequest(sessionId: string): SessionPermissionRequestRecord | null {
    const row = this.sqlite.query<SessionPermissionRequestRow, [string]>(`
      SELECT id,attention_id,session_id,incarnation_id,provider_request_id,tool_call_id,tool_name,
        input_json,input_fingerprint,pi_mode,decision,requested_at,decided_at,decided_by
      FROM session_permission_requests WHERE session_id=?1 AND decision IN ('OPEN','DECIDING')
      ORDER BY requested_at,id LIMIT 1
    `).get(sessionId);
    return row === null ? null : mapSessionPermissionRequestRow(row);
  }

  listOpenSessionPermissionRequests(): readonly SessionPermissionRequestRecord[] {
    return this.sqlite.query<SessionPermissionRequestRow, []>(`
      SELECT id,attention_id,session_id,incarnation_id,provider_request_id,tool_call_id,tool_name,
        input_json,input_fingerprint,pi_mode,decision,requested_at,decided_at,decided_by
      FROM session_permission_requests WHERE decision IN ('OPEN','DECIDING')
      ORDER BY requested_at,id
    `).all().map(mapSessionPermissionRequestRow);
  }

  /**
   * Atomically claims one open permission decision for the incarnation that is still current.
   *
   * The incarnation is checked inside the conditional update, not by the caller beforehand, so a
   * decision recorded for a superseded incarnation is refused even if it arrives at the same moment
   * as the successor: only one of the two can change the row.
   */
  claimSessionPermissionDecision(input: {
    readonly attentionId: string;
    readonly claimedAt: number;
  }): SessionPermissionClaimResult {
    return this.sqlite.transaction(() => {
      const permission = this.getSessionPermissionRequest(input.attentionId);
      if (permission === null) return { claimed: false as const, code: 'NOT_FOUND' as const };
      if (permission.decision === 'DECIDING') {
        return { claimed: false as const, code: 'ALREADY_DECIDING' as const };
      }
      if (permission.decision !== 'OPEN') {
        return { claimed: false as const, code: 'ALREADY_DECIDED' as const };
      }
      const result = this.sqlite.query(`
        UPDATE session_permission_requests SET decision='DECIDING',decided_at=?1
        WHERE attention_id=?2 AND decision='OPEN' AND incarnation_id=(
          SELECT session.current_incarnation_id FROM agent_sessions session WHERE session.id=session_id)
      `).run(input.claimedAt, input.attentionId);
      if (result.changes !== 1) {
        return { claimed: false as const, code: 'STALE_INCARNATION' as const, permission };
      }
      return {
        claimed: true as const,
        code: 'CLAIMED' as const,
        permission: this.getSessionPermissionRequest(input.attentionId) as SessionPermissionRequestRecord,
      };
    })();
  }

  /** Releases a claim whose decision could not be written, so the user can answer again. */
  releaseSessionPermissionClaim(attentionId: string): void {
    this.sqlite.query(`
      UPDATE session_permission_requests SET decision='OPEN',decided_at=NULL,decided_by=NULL
      WHERE attention_id=?1 AND decision='DECIDING'
    `).run(attentionId);
  }

  completeSessionPermissionDecision(input: {
    readonly attentionId: string;
    readonly decision: 'ALLOW' | 'DENY' | 'CANCEL';
    readonly decidedAt: number;
    readonly decidedBy: string;
  }): SessionPermissionRequestRecord {
    const result = this.sqlite.query(`
      UPDATE session_permission_requests SET decision=?1,decided_at=?2,decided_by=?3
      WHERE attention_id=?4 AND decision='DECIDING'
    `).run(input.decision, input.decidedAt, input.decidedBy, input.attentionId);
    if (result.changes !== 1) {
      throw new StorageError('INVALID_STATE', 'Permission decision was not claimed before it was completed');
    }
    return this.getSessionPermissionRequest(input.attentionId) as SessionPermissionRequestRecord;
  }

  /** Records that an answer arrived too late to be applied; the provider side is never touched. */
  markSessionPermissionRequestStale(input: {
    readonly attentionId: string;
    readonly at: number;
    readonly detail: string;
  }): SessionPermissionRequestRecord {
    return this.sqlite.transaction(() => {
      this.sqlite.query(`
        UPDATE session_permission_requests SET decision='STALE',decided_at=?1,decided_by='runtime'
        WHERE attention_id=?2 AND decision IN ('OPEN','DECIDING')
      `).run(input.at, input.attentionId);
      this.sqlite.query(`
        UPDATE attention_requests SET status='STALE' WHERE id=?1 AND status IN ('OPEN','ANSWER_RECORDED')
      `).run(input.attentionId);
      const permission = this.getSessionPermissionRequest(input.attentionId);
      if (permission === null) throw new StorageError('NOT_FOUND', 'Permission request was not found');
      return permission;
    })();
  }

  /**
   * Marks a recorded answer that can never be delivered as failed instead of retryable. Used when
   * the decision belongs to a superseded incarnation: the answer was recorded, but applying it
   * would drive a provider process the Runtime no longer owns.
   */
  failAgentAnswerOperation(input: {
    readonly operationId: string;
    readonly attentionId: string;
    readonly error: Readonly<{ code: string; message: string }>;
    readonly failedAt: number;
  }): void {
    this.sqlite.transaction(() => {
      this.sqlite.query(`
        UPDATE operations SET state='FAILED',result_json=?1,updated_at=?2
        WHERE id=?3 AND kind='ANSWER_AGENT' AND state IN ('PLANNED','IN_PROGRESS')
      `).run(JSON.stringify({ error: input.error }), input.failedAt, input.operationId);
      this.sqlite.query("UPDATE attention_requests SET status='STALE' WHERE id=?1 AND status<>'DELIVERED'")
        .run(input.attentionId);
    })();
  }

  /** Every Session that recorded a provider process tree, for ownership reconciliation. */
  listSessionsWithRecordedIncarnations(): readonly string[] {
    return this.sqlite.query<{ session_id: string }, []>(
      'SELECT DISTINCT session_id FROM session_incarnations ORDER BY session_id',
    ).all().map((row) => row.session_id);
  }

  /** Resolves the Agent Session a provider reported over the Runtime side channel. */
  findSessionByProviderIdentity(input: {
    readonly providerSessionId: string;
  }): { readonly sessionId: string; readonly executionId: string; readonly projectId: string;
    readonly taskId: string; readonly sessionState: string; readonly executionState: string } | null {
    const row = this.sqlite.query<{
      session_id: string; execution_id: string; project_id: string; task_id: string;
      session_state: string; execution_state: string;
    }, [string]>(`
      SELECT session.id AS session_id,execution.id AS execution_id,task.project_id,task.id AS task_id,
        session.state AS session_state,execution.state AS execution_state
      FROM agent_sessions session JOIN executions execution ON execution.id=session.execution_id
      JOIN tasks task ON task.id=execution.task_id
      WHERE session.provider_session_id=?1 AND session.state IN ('ACTIVE','WAITING_FOR_USER','STARTING')
      ORDER BY session.rowid DESC LIMIT 1
    `).get(input.providerSessionId);
    if (row === null) return null;
    return {
      sessionId: row.session_id,
      executionId: row.execution_id,
      projectId: row.project_id,
      taskId: row.task_id,
      sessionState: row.session_state,
      executionState: row.execution_state,
    };
  }

  /**
   * The recorded facts of one Agent Session, including the Adapter's process identity. Used to
   * describe an incarnation without re-reading the Adapter's own state.
   */
  getAgentSessionIdentity(sessionId: string): {
    readonly sessionId: string;
    readonly executionId: string;
    readonly projectId: string;
    readonly taskId: string;
    readonly sessionState: AgentSessionLifecycleState;
    readonly executionState: ExecutionLifecycleState;
    readonly providerSessionId: string | null;
    readonly sessionStorageRef: string | null;
    readonly processIdentity: unknown;
  } | null {
    const row = this.sqlite.query<{
      session_id: string; execution_id: string; project_id: string; task_id: string;
      session_state: AgentSessionLifecycleState; execution_state: ExecutionLifecycleState;
      provider_session_id: string | null; session_storage_ref: string | null;
      process_identity_json: string | null;
    }, [string]>(`
      SELECT session.id AS session_id,execution.id AS execution_id,task.project_id,task.id AS task_id,
        session.state AS session_state,execution.state AS execution_state,
        session.provider_session_id,session.session_storage_ref,session.process_identity_json
      FROM agent_sessions session JOIN executions execution ON execution.id=session.execution_id
      JOIN tasks task ON task.id=execution.task_id
      WHERE session.id=?1
    `).get(sessionId);
    if (row === null) return null;
    return {
      sessionId: row.session_id,
      executionId: row.execution_id,
      projectId: row.project_id,
      taskId: row.task_id,
      sessionState: row.session_state,
      executionState: row.execution_state,
      providerSessionId: row.provider_session_id,
      sessionStorageRef: row.session_storage_ref,
      processIdentity: row.process_identity_json === null
        ? null : JSON.parse(row.process_identity_json) as unknown,
    };
  }

  private sessionIncarnationByCommand(sessionId: string, commandId: string): SessionIncarnationRecord | null {
    const row = this.sqlite.query<SessionIncarnationRow, [string, string]>(`
      SELECT id,session_id,execution_id,incarnation_number,mode,state,provider_pid,
        process_identity_json,process_tree_json,provider_session_id,session_storage_ref,
        predecessor_incarnation_id,command_id,created_at,ended_at,exit_json
      FROM session_incarnations WHERE session_id=?1 AND command_id=?2
    `).get(sessionId, commandId);
    return row === null ? null : mapSessionIncarnationRow(row);
  }

  #insertSessionWriterLease(input: {
    readonly sessionId: string;
    readonly incarnationId: string;
    readonly holderKind: SessionWriterLeaseRecord['holderKind'];
    readonly holderRef: string;
    readonly commandId: string;
    readonly acquiredAt: number;
  }): SessionWriterLeaseRecord {
    // A lease row is a lease *term*, not a holder identity: a released lease stays as history, so
    // re-acquiring after a release appends a new row instead of rewriting the old one.
    const id = crypto.randomUUID();
    this.sqlite.query(`
      INSERT INTO session_writer_leases(id,session_id,incarnation_id,holder_kind,holder_ref,
        command_id,acquired_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7)
    `).run(id, input.sessionId, input.incarnationId, input.holderKind, input.holderRef,
      input.commandId, input.acquiredAt);
    const row = this.sqlite.query<SessionWriterLeaseRow, [string]>(`
      SELECT id,session_id,incarnation_id,holder_kind,holder_ref,command_id,acquired_at,
        released_at,release_reason FROM session_writer_leases WHERE id=?1
    `).get(id);
    if (row === null) throw new StorageError('INVALID_STATE', 'Session writer lease was not persisted');
    // Only a lease that was really inserted produces a change fact: the callers return early on a
    // replay, so a repeated command cannot append a second `TerminalWriterLeaseChanged`.
    this.#appendWriterLeaseChangedEvent(this.sqlite, {
      eventId: crypto.randomUUID(),
      sessionId: input.sessionId,
      leaseId: id,
      action: 'ACQUIRED',
      before: null,
      after: { incarnationId: input.incarnationId, holderKind: input.holderKind,
        holderRef: input.holderRef },
      commandId: input.commandId,
      reason: null,
      occurredAt: input.acquiredAt,
    });
    return mapSessionWriterLeaseRow(row);
  }

  // -------------------------------------------------------------------------------------------
  // Native terminal transport (ADR-0026): one PTY-hosted provider terminal per incarnation, the
  // client attachments over its projected stream, and the evidence an explicit release is decided
  // from. The exit code is stored for audit only; it never decides whether a release succeeded.
  // -------------------------------------------------------------------------------------------

  getSessionTerminal(terminalId: string): SessionTerminalRecord | null {
    const row = this.sqlite.query<SessionTerminalRow, [string]>(
      `${sessionTerminalSelect} WHERE id=?1`,
    ).get(terminalId);
    return row === null ? null : mapSessionTerminalRow(row);
  }

  getSessionTerminalByIncarnation(incarnationId: string): SessionTerminalRecord | null {
    const row = this.sqlite.query<SessionTerminalRow, [string]>(
      `${sessionTerminalSelect} WHERE incarnation_id=?1`,
    ).get(incarnationId);
    return row === null ? null : mapSessionTerminalRow(row);
  }

  /** The terminal of one Session that still claims to be running, if any. */
  getRunningSessionTerminal(sessionId: string): SessionTerminalRecord | null {
    const row = this.sqlite.query<SessionTerminalRow, [string]>(
      `${sessionTerminalSelect} WHERE session_id=?1 AND state='RUNNING'`,
    ).get(sessionId);
    return row === null ? null : mapSessionTerminalRow(row);
  }

  listSessionTerminals(sessionId: string): readonly SessionTerminalRecord[] {
    return this.sqlite.query<SessionTerminalRow, [string]>(
      `${sessionTerminalSelect} WHERE session_id=?1 ORDER BY created_at,id`,
    ).all(sessionId).map(mapSessionTerminalRow);
  }

  /** Terminals that still claim to run; the Runtime must reconcile these after a restart. */
  listLiveSessionTerminals(): readonly SessionTerminalRecord[] {
    return this.sqlite.query<SessionTerminalRow, []>(
      `${sessionTerminalSelect} WHERE state='RUNNING' ORDER BY created_at,id`,
    ).all().map(mapSessionTerminalRow);
  }

  /**
   * Records one PTY-hosted terminal for an incarnation. Replaying the same incarnation returns the
   * recorded terminal: a replayed `session handoff admit` must not start a second provider on the
   * same conversation.
   */
  recordSessionTerminal(input: {
    readonly id: string;
    readonly sessionId: string;
    readonly incarnationId: string;
    readonly helperPid: number | null;
    readonly helperStartToken: string | null;
    readonly providerPid: number | null;
    readonly ptySlave: string | null;
    readonly windowSize: SessionTerminalWindowSize;
    readonly sessionFile: string | null;
    readonly entriesAtStart: number | null;
    readonly lastEntryIdAtStart: string | null;
    readonly createdAt: number;
  }): SessionTerminalWrite {
    return this.sqlite.transaction(() => {
      const existing = this.getSessionTerminalByIncarnation(input.incarnationId);
      if (existing !== null) return { terminal: existing, replayed: true };
      const running = this.getRunningSessionTerminal(input.sessionId);
      if (running !== null) {
        throw new StorageError('INVALID_STATE',
          `TERMINAL_ALREADY_RUNNING: terminal ${running.id} is still RUNNING for this Session`);
      }
      this.sqlite.query(`
        INSERT INTO session_terminals(id,session_id,incarnation_id,helper_pid,helper_start_token,
          provider_pid,pty_slave,window_size,state,session_file,entries_at_start,
          last_entry_id_at_start,created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'RUNNING',?9,?10,?11,?12)
      `).run(input.id, input.sessionId, input.incarnationId, input.helperPid,
        input.helperStartToken, input.providerPid, input.ptySlave, input.windowSize,
        input.sessionFile, input.entriesAtStart, input.lastEntryIdAtStart, input.createdAt);
      const terminal = this.getSessionTerminal(input.id);
      if (terminal === null) {
        throw new StorageError('INVALID_STATE', 'Session terminal was not persisted');
      }
      return { terminal, replayed: false };
    })();
  }

  /**
   * Records the explicit release request (the byte the Runtime wrote, the CLI command that asked for
   * it) together with the provider session-file facts observed at that moment. The optional
   * side-channel acknowledgement is recorded when it arrives, never required: FOUNDATION-040 measured
   * that the extension's shutdown notification is not reliably delivered.
   */
  markSessionTerminalReleaseRequested(input: {
    readonly terminalId: string;
    readonly commandId: string;
    readonly releaseByte: string;
    readonly requestedAt: number;
    readonly entriesAtRelease: number | null;
    readonly lastEntryIdAtRelease: string | null;
    readonly detail: string;
  }): SessionTerminalRecord {
    return this.sqlite.transaction(() => {
      const terminal = this.getSessionTerminal(input.terminalId);
      if (terminal === null) throw new StorageError('NOT_FOUND', 'Session terminal was not found');
      if (terminal.state !== 'RUNNING') {
        if (terminal.releaseCommandId === input.commandId) return terminal;
        throw new StorageError('INVALID_STATE',
          `TERMINAL_NOT_RUNNING: this terminal is ${terminal.state}`);
      }
      this.sqlite.query(`
        UPDATE session_terminals SET release_command_id=?1,release_requested_at=?2,release_byte=?3,
          entries_at_release=?4,last_entry_id_at_release=?5,release_detail=?6
        WHERE id=?7
      `).run(input.commandId, input.requestedAt, input.releaseByte, input.entriesAtRelease,
        input.lastEntryIdAtRelease, input.detail, input.terminalId);
      const updated = this.getSessionTerminal(input.terminalId);
      if (updated === null) throw new StorageError('NOT_FOUND', 'Session terminal was not found');
      return updated;
    })();
  }

  markSessionTerminalProviderShutdownReported(input: {
    readonly terminalId: string;
    readonly at: number;
  }): boolean {
    const result = this.sqlite.query(`
      UPDATE session_terminals SET provider_shutdown_reported_at=?1
      WHERE id=?2 AND provider_shutdown_reported_at IS NULL
    `).run(input.at, input.terminalId);
    return result.changes === 1;
  }

  /**
   * Ends a terminal. `RELEASED` means the provider exited after the explicit release; `STOPPED`
   * means it was ended by the Runtime (a kill, a restart, or a runtime that no longer holds it);
   * `RECOVERY_REQUIRED` means no exit was observed and the Runtime refuses to guess.
   */
  markSessionTerminalEnded(input: {
    readonly terminalId: string;
    readonly state: 'RELEASED' | 'STOPPED' | 'RECOVERY_REQUIRED';
    readonly exitCode: number | null;
    readonly exitSignal: string | null;
    readonly at: number;
    readonly detail: string;
  }): SessionTerminalRecord {
    return this.sqlite.transaction(() => {
      const terminal = this.getSessionTerminal(input.terminalId);
      if (terminal === null) throw new StorageError('NOT_FOUND', 'Session terminal was not found');
      if (terminal.state !== 'RUNNING') return terminal;
      this.sqlite.query(`
        UPDATE session_terminals SET state=?1,exit_code=?2,exit_signal=?3,exit_reported_at=?4,
          ended_at=?5,release_detail=COALESCE(release_detail,'')||?6
        WHERE id=?7 AND state='RUNNING'
      `).run(input.state, input.exitCode, input.exitSignal, input.at, input.at,
        terminal.releaseDetail === null ? input.detail : `; ${input.detail}`, input.terminalId);
      const updated = this.getSessionTerminal(input.terminalId);
      if (updated === null) throw new StorageError('NOT_FOUND', 'Session terminal was not found');
      return updated;
    })();
  }

  listSessionTerminalAttachments(sessionId: string): readonly SessionTerminalAttachmentRecord[] {
    return this.sqlite.query<SessionTerminalAttachmentRow, [string]>(`
      SELECT id,terminal_id,session_id,kind,holder_ref,state,cursor_at_attach,cursor_at_detach,
        command_id,attached_at,detached_at,detached_reason
      FROM session_terminal_attachments WHERE session_id=?1 ORDER BY attached_at,id
    `).all(sessionId).map(mapSessionTerminalAttachmentRow);
  }

  getAttachedSessionTerminalWriter(terminalId: string): SessionTerminalAttachmentRecord | null {
    const row = this.sqlite.query<SessionTerminalAttachmentRow, [string]>(`
      SELECT id,terminal_id,session_id,kind,holder_ref,state,cursor_at_attach,cursor_at_detach,
        command_id,attached_at,detached_at,detached_reason
      FROM session_terminal_attachments
      WHERE terminal_id=?1 AND state='ATTACHED' AND kind='WRITER'
    `).get(terminalId);
    return row === null ? null : mapSessionTerminalAttachmentRow(row);
  }

  /**
   * Attaches one client to a running terminal. A second WRITER never queues: it is refused with
   * `ATTACHMENT_BUSY` and the current holder named, which a script can assert on. Replaying the same
   * command ID returns the recorded attachment.
   */
  attachSessionTerminal(input: {
    readonly id: string;
    readonly terminalId: string;
    readonly sessionId: string;
    readonly kind: SessionTerminalAttachmentKind;
    readonly holderRef: string;
    readonly commandId: string;
    readonly cursor: number;
    readonly attachedAt: number;
  }): SessionTerminalAttachmentAcquisition {
    return this.sqlite.transaction(() => {
      const replayed = this.sqlite.query<SessionTerminalAttachmentRow, [string, string]>(`
        SELECT id,terminal_id,session_id,kind,holder_ref,state,cursor_at_attach,cursor_at_detach,
          command_id,attached_at,detached_at,detached_reason
        FROM session_terminal_attachments WHERE terminal_id=?1 AND command_id=?2
      `).get(input.terminalId, input.commandId);
      if (replayed !== null) {
        return { attached: true as const, code: 'REPLAYED' as const,
          attachment: mapSessionTerminalAttachmentRow(replayed), holder: null };
      }
      const terminal = this.getSessionTerminal(input.terminalId);
      if (terminal === null) throw new StorageError('NOT_FOUND', 'Session terminal was not found');
      if (terminal.state !== 'RUNNING') {
        return { attached: false as const, code: 'TERMINAL_NOT_RUNNING' as const, attachment: null,
          holder: null };
      }
      if (input.kind === 'WRITER') {
        const writer = this.getAttachedSessionTerminalWriter(input.terminalId);
        if (writer !== null) {
          return { attached: false as const, code: 'ATTACHMENT_BUSY' as const, attachment: null,
            holder: { holderRef: writer.holderRef, attachedAt: writer.attachedAt } };
        }
      }
      this.sqlite.query(`
        INSERT INTO session_terminal_attachments(id,terminal_id,session_id,kind,holder_ref,state,
          cursor_at_attach,command_id,attached_at)
        VALUES (?1,?2,?3,?4,?5,'ATTACHED',?6,?7,?8)
      `).run(input.id, input.terminalId, input.sessionId, input.kind, input.holderRef, input.cursor,
        input.commandId, input.attachedAt);
      const attachment = this.sqlite.query<SessionTerminalAttachmentRow, [string]>(`
        SELECT id,terminal_id,session_id,kind,holder_ref,state,cursor_at_attach,cursor_at_detach,
          command_id,attached_at,detached_at,detached_reason
        FROM session_terminal_attachments WHERE id=?1
      `).get(input.id);
      if (attachment === null) {
        throw new StorageError('INVALID_STATE', 'Session terminal attachment was not persisted');
      }
      return { attached: true as const, code: 'ATTACHED' as const,
        attachment: mapSessionTerminalAttachmentRow(attachment), holder: null };
    })();
  }

  /** Detaches an attachment by holder. Detaching never stops the terminal or the provider. */
  detachSessionTerminal(input: {
    readonly sessionId: string;
    readonly holderRef: string;
    readonly cursor: number;
    readonly reason: string;
    readonly at: number;
  }): { readonly detached: boolean; readonly code: 'DETACHED' | 'NOT_ATTACHED';
    readonly attachment: SessionTerminalAttachmentRecord | null } {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.query<{ id: string }, [string, string]>(`
        SELECT attachment.id AS id FROM session_terminal_attachments attachment
        JOIN session_terminals terminal ON terminal.id=attachment.terminal_id
        WHERE attachment.session_id=?1 AND attachment.holder_ref=?2
          AND attachment.state='ATTACHED' AND terminal.state='RUNNING'
      `).get(input.sessionId, input.holderRef);
      if (row === null) return { detached: false, code: 'NOT_ATTACHED' as const, attachment: null };
      this.sqlite.query(`
        UPDATE session_terminal_attachments SET state='DETACHED',cursor_at_detach=?1,
          detached_at=?2,detached_reason=?3
        WHERE id=?4 AND state='ATTACHED'
      `).run(input.cursor, input.at, input.reason, row.id);
      const attachment = this.sqlite.query<SessionTerminalAttachmentRow, [string]>(`
        SELECT id,terminal_id,session_id,kind,holder_ref,state,cursor_at_attach,cursor_at_detach,
          command_id,attached_at,detached_at,detached_reason
        FROM session_terminal_attachments WHERE id=?1
      `).get(row.id);
      return { detached: true, code: 'DETACHED' as const,
        attachment: attachment === null ? null : mapSessionTerminalAttachmentRow(attachment) };
    })();
  }

  /** Detaches every attachment of one terminal (used when that terminal ends). */
  releaseSessionTerminalAttachments(input: {
    readonly terminalId: string;
    readonly cursor: number;
    readonly reason: string;
    readonly at: number;
  }): number {
    const result = this.sqlite.query(`
      UPDATE session_terminal_attachments SET state='DETACHED',cursor_at_detach=?1,
        detached_at=?2,detached_reason=?3
      WHERE terminal_id=?4 AND state='ATTACHED'
    `).run(input.cursor, input.at, input.reason, input.terminalId);
    return result.changes;
  }

  // -------------------------------------------------------------------------------------------
  // Handoff and native-terminal domain events (FOUNDATION-063, ADR-0035)
  // -------------------------------------------------------------------------------------------

  /**
   * Appends one handoff / native-terminal fact inside the caller's transaction.
   *
   * Two rules are enforced here rather than trusted to callers: the payload is parsed against its
   * contract schema first, and the aggregate version is allocated per aggregate inside the same
   * transaction, so a takeover's facts read back in the order they happened
   * (`TakeoverRequested` → safe point → started → completed/failed).
   */
  #appendSessionHandoffEvent(database: Database, input: {
    readonly eventId: string;
    readonly eventType: SessionHandoffEventType;
    readonly projectId: string;
    readonly aggregateId: string;
    readonly correlationId: string;
    readonly occurredAt: number;
    readonly payload: unknown;
    readonly causationId?: string | null;
  }): void {
    if (!(sessionHandoffEventTypes as readonly string[]).includes(input.eventType)) {
      throw new StorageError('INVALID_STATE',
        `Unknown handoff event type ${String(input.eventType)}`);
    }
    const parsed = sessionHandoffPayloadSchemas[input.eventType].parse(input.payload);
    const aggregateType = input.eventType === 'TerminalWriterLeaseChanged'
      ? sessionWriterLeaseAggregateType : sessionHandoffAggregateType;
    const next = database.query<{ version: number }, [string, string]>(`
      SELECT COALESCE(MAX(aggregate_version),0)+1 AS version FROM domain_events
      WHERE aggregate_type=?1 AND aggregate_id=?2
    `).get(aggregateType, input.aggregateId)?.version ?? 1;
    database.query(`
      INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
        aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
      VALUES (?1,?2,?3,1,?4,?5,?6,?7,?8,?9,?10)
    `).run(input.eventId, input.projectId, input.eventType, aggregateType, input.aggregateId,
      next, input.correlationId, input.causationId ?? null, input.occurredAt,
      JSON.stringify(parsed));
  }

  /** Appends one writer-lease change. The lease term is history, so a change is never an update. */
  #appendWriterLeaseChangedEvent(database: Database, input: {
    readonly eventId: string;
    readonly sessionId: string;
    readonly leaseId: string;
    readonly action: 'ACQUIRED' | 'RELEASED';
    readonly before: SessionWriterLeaseHolderFact | null;
    readonly after: SessionWriterLeaseHolderFact | null;
    readonly commandId: string;
    readonly reason: string | null;
    readonly occurredAt: number;
  }): void {
    const scope = this.#sessionEventScope(database, input.sessionId);
    this.#appendSessionHandoffEvent(database, {
      eventId: input.eventId,
      eventType: 'TerminalWriterLeaseChanged',
      projectId: scope.projectId,
      aggregateId: input.leaseId,
      correlationId: input.commandId,
      occurredAt: input.occurredAt,
      payload: {
        takeoverId: this.#openTakeoverId(database, input.sessionId),
        sessionId: input.sessionId,
        leaseId: input.leaseId,
        action: input.action,
        before: input.before,
        after: input.after,
        reason: input.reason,
      } satisfies TerminalWriterLeaseChangedPayload,
    });
  }

  /** Appends the `RELEASED` half of a lease change for a term that was still active a moment ago. */
  #appendWriterLeaseChangeForRelease(database: Database,
    lease: SessionWriterLeaseRecord, reason: string, at: number): void {
    this.#appendWriterLeaseChangedEvent(database, {
      eventId: crypto.randomUUID(),
      sessionId: lease.sessionId,
      leaseId: lease.id,
      action: 'RELEASED',
      before: { incarnationId: lease.incarnationId, holderKind: lease.holderKind,
        holderRef: lease.holderRef },
      after: null,
      commandId: lease.commandId,
      reason,
      occurredAt: at,
    });
  }

  /** The project and execution a Session belongs to; every handoff fact is attributed to both. */
  #sessionEventScope(database: Database, sessionId: string): {
    readonly projectId: string; readonly executionId: string } {
    const row = database.query<{ project_id: string; execution_id: string }, [string]>(`
      SELECT task.project_id AS project_id,session.execution_id AS execution_id
      FROM agent_sessions session JOIN executions execution ON execution.id=session.execution_id
      JOIN tasks task ON task.id=execution.task_id WHERE session.id=?1
    `).get(sessionId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Agent Session was not found');
    return { projectId: row.project_id, executionId: row.execution_id };
  }

  /**
   * The handoff request that was still open when a fact was recorded, if any. It is read inside the
   * same transaction, so a lease change or a safe point is correlated with the takeover that really
   * was in flight at that moment instead of with a later one.
   */
  #openTakeoverId(database: Database, sessionId: string): string | null {
    const row = database.query<{ id: string }, [string]>(`
      SELECT id FROM session_handoff_requests WHERE session_id=?1
        AND state IN ('REQUESTED','FENCED','AT_SAFE_POINT') ORDER BY created_at DESC LIMIT 1
    `).get(sessionId);
    return row?.id ?? null;
  }

  #handoffEventScope(database: Database, sessionId: string, eventId: string, eventType:
  SessionHandoffEventType, aggregateId: string, correlationId: string, occurredAt: number,
  payload: unknown): void {
    const scope = this.#sessionEventScope(database, sessionId);
    this.#appendSessionHandoffEvent(database, {
      eventId, eventType, projectId: scope.projectId, aggregateId, correlationId, occurredAt, payload,
    });
  }

  /**
   * Appends one observed refusal as a domain fact.
   *
   * A refusal has no state change to commit with, so it is the one event written on its own. It is
   * idempotent by construction: the event id is derived from the command that produced it and the
   * stable reason code, so replaying one command adds no second fact while a *different* refusal
   * remains visible as history (a stored event is never rewritten to hide an earlier failure).
   */
  recordSessionHandoffFailure(input: {
    readonly sessionId: string;
    readonly takeoverId: string | null;
    readonly incarnationId: string | null;
    readonly stage: TakeoverFailedPayload['stage'];
    readonly reason: string;
    readonly detail: string;
    readonly commandId: string;
    readonly evidenceRef: string | null;
    readonly occurredAt: number;
  }): boolean {
    return this.sqlite.transaction(() => {
      const scope = this.#sessionEventScope(this.sqlite, input.sessionId);
      const eventId = createHash('sha256')
        .update(`${input.commandId}:${input.stage}:${input.reason}`).digest('hex');
      const payload = takeoverFailedPayloadSchema.parse({
        takeoverId: input.takeoverId,
        sessionId: input.sessionId,
        executionId: scope.executionId,
        incarnationId: input.incarnationId,
        stage: input.stage,
        reason: input.reason,
        detail: input.detail,
        evidenceRef: input.evidenceRef,
      } satisfies TakeoverFailedPayload);
      const inserted = this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        SELECT ?1,?2,'TakeoverFailed',1,?3,?4,COALESCE((
          SELECT MAX(aggregate_version) FROM domain_events
          WHERE aggregate_type=?3 AND aggregate_id=?4
        ),0)+1,?5,NULL,?6,?7
        WHERE NOT EXISTS(SELECT 1 FROM domain_events WHERE event_id=?1)
      `).run(eventId, scope.projectId, sessionHandoffAggregateType,
        input.takeoverId ?? input.sessionId, input.commandId, input.occurredAt,
        JSON.stringify(payload));
      return inserted.changes === 1;
    })();
  }

  /**
   * Ends the predecessor incarnation and releases its writer lease in one transaction, together with
   * the two facts that describes: the handoff started, and the lease changed holder.
   *
   * This is *not* the hand over. It is the moment the automation stops being able to write, which is
   * what has to happen before a successor may be launched. A successor that cannot be started after
   * this point is reported as `TakeoverFailed`, and the predecessor's exit stays in the history.
   */
  beginSessionHandoff(input: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly at: number;
    readonly eventId: string;
    readonly leaseEventId: string;
    readonly sourceIncarnationId: string;
    readonly targetMode: SessionIncarnationRecord['mode'];
    readonly predecessorObservation: string;
    readonly processEvidenceRef: string | null;
    readonly exit: Readonly<Record<string, unknown>>;
    readonly exitDetail: string;
    readonly releaseReason: string;
  }): { readonly request: SessionHandoffRequestRecord;
    readonly incarnation: SessionIncarnationRecord } {
    return this.sqlite.transaction(() => {
      const request = this.getSessionHandoffRequest(input.requestId);
      if (request === null) throw new StorageError('NOT_FOUND', 'Handoff request was not found');
      const incarnation = this.getSessionIncarnation(input.sourceIncarnationId);
      if (incarnation === null) throw new StorageError('NOT_FOUND', 'Session incarnation was not found');
      const active = incarnation.state !== 'EXITED';
      if (active) {
        this.sqlite.query(`
          UPDATE session_incarnations SET state='EXITED',ended_at=?1,exit_json=?2
          WHERE id=?3 AND state IN ('ACTIVE','FENCED')
        `).run(input.at, JSON.stringify({ ...input.exit, detail: input.exitDetail }),
          input.sourceIncarnationId);
        this.sqlite.query(`
          UPDATE agent_sessions SET current_incarnation_id=NULL
          WHERE id=?1 AND current_incarnation_id=?2
        `).run(incarnation.sessionId, input.sourceIncarnationId);
      }
      const lease = this.getSessionWriterLease(incarnation.sessionId);
      let releasedLease: SessionWriterLeaseRecord | null = null;
      if (lease !== null) {
        const released = this.sqlite.query(`
          UPDATE session_writer_leases SET released_at=?1,release_reason=?2
          WHERE session_id=?3 AND released_at IS NULL
        `).run(input.at, input.releaseReason, incarnation.sessionId);
        if (released.changes === 1) releasedLease = lease;
      }
      this.#handoffEventScope(this.sqlite, incarnation.sessionId, input.eventId,
        'SessionHandoffStarted', input.requestId, request.commandId, input.at, {
          takeoverId: input.requestId,
          sourceSessionId: incarnation.sessionId,
          targetSessionId: incarnation.sessionId,
          sourceIncarnationId: input.sourceIncarnationId,
          fromMode: incarnation.mode,
          toMode: input.targetMode,
          predecessorObservation: input.predecessorObservation,
          processEvidenceRef: input.processEvidenceRef,
        } satisfies SessionHandoffStartedPayload);
      if (releasedLease !== null) {
        this.#appendWriterLeaseChangedEvent(this.sqlite, {
          eventId: input.leaseEventId,
          sessionId: incarnation.sessionId,
          leaseId: releasedLease.id,
          action: 'RELEASED',
          before: { incarnationId: releasedLease.incarnationId,
            holderKind: releasedLease.holderKind, holderRef: releasedLease.holderRef },
          after: null,
          commandId: request.commandId,
          reason: input.releaseReason,
          occurredAt: input.at,
        });
      }
      return {
        request: this.getSessionHandoffRequest(input.requestId) as SessionHandoffRequestRecord,
        // `as`/`satisfies` may not follow a line break, so this assertion stays on one line.
        incarnation: this.getSessionIncarnation(input.sourceIncarnationId) as SessionIncarnationRecord,
      };
    })();
  }

  // -------------------------------------------------------------------------------------------
  // Small additions the terminal handoff needs from the session-handoff contract. They are appended
  // here (rather than inside the FOUNDATION-043 block) so a concurrent lane's copy of that block
  // cannot conflict with them.
  // -------------------------------------------------------------------------------------------

  /**
   * Ends one incarnation with an exit fact, and stops it from being the current incarnation in the
   * same statement. This is the prerequisite for recording a successor: `recordSessionIncarnation`
   * refuses while any incarnation is still ACTIVE/FENCED, and a decision that was still routable to
   * this incarnation must become unroutable (`STALE_INCARNATION`) the moment it is superseded.
   */
  markSessionIncarnationExited(input: {
    readonly incarnationId: string;
    readonly at: number;
    readonly exit: Readonly<Record<string, unknown>>;
    readonly detail: string;
  }): SessionIncarnationRecord {
    return this.sqlite.transaction(() => {
      const incarnation = this.getSessionIncarnation(input.incarnationId);
      if (incarnation === null) throw new StorageError('NOT_FOUND', 'Session incarnation was not found');
      if (incarnation.state === 'EXITED') return incarnation;
      this.sqlite.query(`
        UPDATE session_incarnations SET state='EXITED',ended_at=?1,exit_json=?2
        WHERE id=?3 AND state IN ('ACTIVE','FENCED')
      `).run(input.at, JSON.stringify({ ...input.exit, detail: input.detail }), input.incarnationId);
      this.sqlite.query(`
        UPDATE agent_sessions SET current_incarnation_id=NULL
        WHERE id=?1 AND current_incarnation_id=?2
      `).run(incarnation.sessionId, input.incarnationId);
      const updated = this.getSessionIncarnation(input.incarnationId);
      if (updated === null) throw new StorageError('NOT_FOUND', 'Session incarnation was not found');
      return updated;
    })();
  }

  /**
   * A safe point that was not reached through the RPC fence: the terminal's own release. The fence
   * exists to stop an *automation* process from starting new tools after the request; a human
   * terminal that is explicitly released does not need one, and the facts used instead are the
   * provider exit, the ownership observation and the provider session file (see `TerminalService`).
   */
  markSessionTerminalHandoffSafePoint(input: {
    readonly requestId: string;
    readonly at: number;
    readonly detail: string;
    readonly eventId: string;
    /** The release that was proven complete; it is what makes this a safe point. */
    readonly release: {
      readonly releaseEventId: string;
      readonly terminalId: string | null;
      readonly reason: string;
      readonly predecessorObservation: string;
      readonly evidenceRef: string | null;
      readonly sessionFile: TakeoverReleasedPayload['sessionFile'];
    };
  }): SessionHandoffRequestRecord {
    return this.sqlite.transaction(() => {
      const result = this.sqlite.query(`
        UPDATE session_handoff_requests SET state='AT_SAFE_POINT',safe_point_at=?1,detail=?2,updated_at=?1
        WHERE id=?3 AND state IN ('REQUESTED','FENCED') AND fence_active=0
      `).run(input.at, input.detail, input.requestId);
      if (result.changes !== 1) {
        throw new StorageError('INVALID_STATE',
          'Terminal release safe point did not match an unfenced open handoff request');
      }
      const request = this.getSessionHandoffRequest(input.requestId) as SessionHandoffRequestRecord;
      this.#handoffEventScope(this.sqlite, request.sessionId, input.eventId,
        'TakeoverSafePointReached', request.id, request.commandId, input.at, {
          takeoverId: request.id,
          sessionId: request.sessionId,
          executionId: request.executionId,
          incarnationId: request.incarnationId,
          reachedFrom: 'TERMINAL_RELEASE',
          fenceAcknowledged: false,
          settledAfterFenceAt: null,
          activeTools: 0,
          evidenceRef: input.release.evidenceRef,
          lastEntryRef: input.release.sessionFile.lastEntryIdAtRelease,
          missing: [],
        } satisfies TakeoverSafePointReachedPayload);
      // `TakeoverReleased` is written here and not when the terminal row was marked RELEASED: only a
      // release whose session file still holds the predecessor's entries has handed the conversation
      // back. A release that could not be proven stays a `TakeoverFailed`.
      this.#handoffEventScope(this.sqlite, request.sessionId, input.release.releaseEventId,
        'TakeoverReleased', request.id, request.commandId, input.at, {
          takeoverId: request.id,
          sessionId: request.sessionId,
          executionId: request.executionId,
          incarnationId: request.incarnationId,
          terminalId: input.release.terminalId,
          reason: input.release.reason,
          predecessorObservation: input.release.predecessorObservation,
          evidenceRef: input.release.evidenceRef,
          sessionFile: input.release.sessionFile,
        } satisfies TakeoverReleasedPayload);
      return request;
    })();
  }

  /**
   * Merges a *refreshed* process tree into a recorded incarnation.
   *
   * The tree captured at launch can only see what was already running then, and a tool the provider
   * starts later is exactly the process FOUNDATION-040 measured surviving a provider kill. Refresh
   * points (the settled fact after a handoff fence, and the last moment before an explicit release)
   * capture the union, which is what a later ownership check must compare against. Descendants are
   * merged by PID: an entry is never removed, because "this pid once belonged to this Session" is
   * the fact that makes a reused pid distinguishable from a surviving tool.
   */
  mergeSessionIncarnationProcessTree(input: {
    readonly incarnationId: string;
    readonly tree: ProviderProcessTreeLike;
  }): SessionIncarnationRecord {
    return this.sqlite.transaction(() => {
      const incarnation = this.getSessionIncarnation(input.incarnationId);
      if (incarnation === null) throw new StorageError('NOT_FOUND', 'Session incarnation was not found');
      const existing = incarnation.processTree === null || typeof incarnation.processTree !== 'object'
        ? null
        : incarnation.processTree as Partial<ProviderProcessTreeLike>;
      const byPid = new Map<number, ProviderProcessRefLike>();
      for (const descendant of existing?.descendants ?? []) {
        if (typeof descendant?.pid === 'number') byPid.set(descendant.pid, descendant);
      }
      for (const descendant of input.tree.descendants) {
        const known = byPid.get(descendant.pid);
        // A later capture can only add detail (a token that could not be read before); it never
        // overwrites a known identity with an unknown one.
        byPid.set(descendant.pid, known === undefined
          ? descendant
          : { ...known, startToken: known.startToken ?? descendant.startToken });
      }
      const merged = {
        ...input.tree,
        startToken: existing?.startToken ?? input.tree.startToken,
        descendants: [...byPid.values()],
        note: existing === null
          ? input.tree.note
          : `${existing.note ?? ''} | refreshed: ${input.tree.note}`.trim(),
      };
      this.sqlite.query('UPDATE session_incarnations SET process_tree_json=?1 WHERE id=?2')
        .run(JSON.stringify(merged), input.incarnationId);
      const updated = this.getSessionIncarnation(input.incarnationId);
      if (updated === null) throw new StorageError('NOT_FOUND', 'Session incarnation was not found');
      return updated;
    })();
  }

  /**
   * Everything one Agent Session's start was composed from (workspace, ownership token, revision,
   * adapter, effective Agent configuration). A successor process launched outside the normal start
   * path must use exactly these, otherwise "the same execution continues" would be a claim about
   * different inputs.
   */
  getAgentStartPlanForSession(sessionId: string): AgentStartPlan | null {
    return this.agentStartRow(sessionId);
  }

  // ---------------------------------------------------------------------------------------------
  // Revision delivery (PROJECT_SPEC §2.11, ADR-0028).
  //
  // Creating a revision while an Execution is running records a *requirement*: the Execution that
  // must know the new specification. Every attempt to carry it there is appended to a ledger with
  // the channel, the Execution/Session/incarnation it was aimed at, and how it ended. The delivery
  // state is advanced through the pure domain FSM, so "already acknowledged" and "stale
  // acknowledgement" are rejected by the same guards the domain tests cover — never by a claim that
  // a message was sent.
  // ---------------------------------------------------------------------------------------------

  /**
   * Appends one immutable Task revision, moves `tasks.current_revision_id`, and records a delivery
   * requirement when an Execution is holding the Task at that moment. The revision itself never
   * changes an Execution: what must happen to a running Agent is decided by the delivery, not here.
   */
  createTaskRevision(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly intentId: string;
    readonly revisionId: string;
    readonly deliveryId: string;
    readonly intentEventId: string;
    readonly revisionEventId: string;
    readonly deliveryEventId: string;
    readonly specification: string;
    readonly constraints: readonly StoredConstraint[];
    /**
     * The feature declaration of the *new* revision. An omitted list inherits the previous
     * revision's declaration instead of silently dropping it: amending a specification is not a
     * statement that the Task stopped working on that feature (ADR-0059 D03).
     */
    readonly features?: readonly string[] | null;
    readonly kind: 'AMEND_TASK' | 'ADD_CONSTRAINT';
    readonly reason: string;
    readonly actor: string;
    readonly createdAt: number;
  }): TaskRevisionCreation {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.createdAt,
      apply: (database) => {
        const task = database.query<{
          state: TaskLifecycleState; version: number; current_revision_id: string; display_number: number;
        }, [string, string]>(`
          SELECT t.state,t.version,t.current_revision_id,t.display_number FROM tasks t
          JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
          WHERE t.project_id=?1 AND t.id=?2
        `).get(input.projectId, input.taskId);
        if (task === null) throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
        if (task.version !== input.expectedVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
        }
        if (task.state === 'CANCELLED' || task.state === 'SUCCEEDED') {
          throw new StorageError('INVALID_STATE',
            `A ${task.state} Task is terminal and cannot be revised`);
        }
        const next = database.query<{ number: number }, [string]>(`
          SELECT COALESCE(MAX(number),0)+1 AS number FROM task_revisions WHERE task_id=?1
        `).get(input.taskId);
        if (next === null) throw new Error('Could not allocate a Task revision number');
        this.insertIntent(database, {
          id: input.intentId, projectId: input.projectId, idempotencyKey: input.commandId,
          rawText: input.specification, kind: input.kind, status: 'APPLIED',
          actor: input.actor, createdAt: input.createdAt,
        });
        const requested = input.features ?? null;
        const inherited = requested === null
          ? database.query<{ features_json: string }, [string]>(
            'SELECT features_json FROM task_revisions WHERE id=?1').get(task.current_revision_id)
          : null;
        const features = requested
          ?? (inherited === null ? [] : JSON.parse(inherited.features_json) as readonly string[]);
        database.query(`
          INSERT INTO task_revisions(id,task_id,number,previous_revision_id,specification,
            constraints_json,features_json,source_intent_id,actor,reason,created_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
        `).run(input.revisionId, input.taskId, next.number, task.current_revision_id,
          input.specification, JSON.stringify(input.constraints), JSON.stringify(features),
          input.intentId, input.actor, input.reason, input.createdAt);
        const taskVersion = input.expectedVersion + 1;
        const taskUpdate = database.query(`
          UPDATE tasks SET current_revision_id=?1,version=?2,updated_at=?3
          WHERE id=?4 AND project_id=?5 AND version=?6
        `).run(input.revisionId, taskVersion, input.createdAt, input.taskId, input.projectId,
          input.expectedVersion);
        if (taskUpdate.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during revision creation');
        }
        database.query('INSERT INTO intent_targets(intent_id,task_id) VALUES (?1,?2)')
          .run(input.intentId, input.taskId);
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'IntentRecorded',1,'Intent',?3,0,?4,?4,?5,?6)
        `).run(input.intentEventId, input.projectId, input.intentId, input.commandId,
          input.createdAt, JSON.stringify({ intentId: input.intentId, kind: input.kind,
            taskId: input.taskId }));
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskRevisionCreated',1,'Task',?3,?4,?5,?6,?7,?8)
        `).run(input.revisionEventId, input.projectId, input.taskId, taskVersion, input.commandId,
          input.intentEventId, input.createdAt,
          JSON.stringify({ taskId: input.taskId, revisionId: input.revisionId,
            revisionNumber: next.number, previousRevisionId: task.current_revision_id,
            constraintCount: input.constraints.length, features, reason: input.reason,
            actor: input.actor }));
        const running = database.query<{
          execution_id: string; session_id: string | null; incarnation_id: string | null;
        }, [string]>(`
          SELECT execution.id AS execution_id,session.id AS session_id,
            session.current_incarnation_id AS incarnation_id
          FROM executions execution
          LEFT JOIN agent_sessions session ON session.execution_id=execution.id
          WHERE execution.task_id=?1 AND execution.resource_held=1
        `).get(input.taskId) ?? null;
        if (running !== null) {
          database.query(`
            INSERT INTO task_revision_deliveries(id,project_id,task_id,revision_id,execution_id,
              session_id,incarnation_id,state,attempt_count,created_at,updated_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7,'PENDING',0,?8,?8)
          `).run(input.deliveryId, input.projectId, input.taskId, input.revisionId,
            running.execution_id, running.session_id, running.incarnation_id, input.createdAt);
          database.query(`
            INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
              aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
            VALUES (?1,?2,'TaskRevisionDeliveryRecorded',1,'TaskRevisionDelivery',?3,0,?4,?5,?6,?7)
          `).run(input.deliveryEventId, input.projectId, input.deliveryId, input.commandId,
            input.revisionEventId, input.createdAt,
            JSON.stringify({ deliveryId: input.deliveryId, taskId: input.taskId,
              revisionId: input.revisionId, executionId: running.execution_id,
              sessionId: running.session_id, incarnationId: running.incarnation_id,
              state: 'PENDING' }));
        }
        return {
          taskId: input.taskId,
          taskVersion,
          revisionId: input.revisionId,
          revisionNumber: next.number,
          previousRevisionId: task.current_revision_id,
          deliveryId: running === null ? null : input.deliveryId,
          executionId: running === null ? null : running.execution_id,
          sessionId: running === null ? null : running.session_id,
        };
      },
    });
  }

  listTaskRevisions(projectId: string, taskId: string): readonly TaskRevisionSummary[] {
    const task = this.sqlite.query<{ current_revision_id: string }, [string, string]>(`
      SELECT t.current_revision_id FROM tasks t
      JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
      WHERE t.project_id=?1 AND t.id=?2
    `).get(projectId, taskId);
    if (task === null) throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
    return this.sqlite.query<{
      id: string; number: number; previous_revision_id: string | null; specification: string;
      constraints_json: string; reason: string; actor: string; created_at: number;
    }, [string]>(`
      SELECT id,number,previous_revision_id,specification,constraints_json,reason,actor,created_at
      FROM task_revisions WHERE task_id=?1 ORDER BY number
    `).all(taskId).map((row) => ({
      id: row.id,
      number: row.number,
      previousRevisionId: row.previous_revision_id,
      specification: row.specification,
      constraints: JSON.parse(row.constraints_json) as readonly StoredConstraint[],
      reason: row.reason,
      actor: row.actor,
      createdAt: row.created_at,
      current: row.id === task.current_revision_id,
    }));
  }

  listTaskRevisionDeliveries(projectId: string, taskId: string): readonly TaskRevisionDeliveryRecord[] {
    const task = this.sqlite.query<{ current_revision_id: string }, [string, string]>(`
      SELECT t.current_revision_id FROM tasks t
      JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
      WHERE t.project_id=?1 AND t.id=?2
    `).get(projectId, taskId);
    if (task === null) throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
    const attempts = this.revisionDeliveryAttemptsForDeliveries(
      this.sqlite.query<{ id: string }, [string]>(
        'SELECT id FROM task_revision_deliveries WHERE task_id=?1 ORDER BY created_at,id',
      ).all(taskId).map((row) => row.id),
    );
    return this.sqlite.query<RevisionDeliveryRow, [string]>(`${revisionDeliverySelect}
      WHERE delivery.task_id=?1 ORDER BY delivery.created_at,delivery.id
    `).all(taskId).map((row) => this.mapTaskRevisionDelivery(row, task.current_revision_id,
      attempts.get(row.id) ?? []));
  }

  getTaskRevisionDelivery(projectId: string, deliveryId: string): TaskRevisionDeliveryRecord {
    const row = this.sqlite.query<RevisionDeliveryRow & { current_revision_id: string }, [string, string]>(`
      SELECT delivery.id,delivery.project_id,delivery.task_id,delivery.revision_id,
        revision.number AS revision_number,delivery.execution_id,delivery.session_id,
        delivery.incarnation_id,delivery.state,delivery.attempt_count,delivery.channel,
        delivery.deadline_at,delivery.evidence_ref,delivery.detail,
        delivery.superseded_by_execution_id,delivery.created_at,delivery.updated_at,
        delivery.acknowledged_at,delivery.version,task.current_revision_id
      FROM task_revision_deliveries delivery
      JOIN tasks task ON task.id=delivery.task_id
      JOIN task_revisions revision ON revision.task_id=delivery.task_id
        AND revision.id=delivery.revision_id
      JOIN project_trusts trust ON trust.project_id=delivery.project_id AND trust.status='ACTIVE'
      WHERE delivery.project_id=?1 AND delivery.id=?2
    `).get(projectId, deliveryId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Revision delivery was not found');
    return this.mapTaskRevisionDelivery(row, row.current_revision_id,
      this.revisionDeliveryAttemptsForDeliveries([row.id]).get(row.id) ?? []);
  }

  /**
   * The newest delivery of one Task that no acknowledgement and no successor Execution satisfied.
   * Optional subject filters answer "is *this* Execution/Session on an unconfirmed revision?".
   */
  findUnsatisfiedRevisionDelivery(input: {
    readonly taskId: string;
    readonly executionId?: string;
    readonly sessionId?: string;
  }): TaskRevisionDeliveryRecord | null {
    const row = this.sqlite.query<RevisionDeliveryRow & { current_revision_id: string }, [string]>(`
      SELECT delivery.id,delivery.project_id,delivery.task_id,delivery.revision_id,
        revision.number AS revision_number,delivery.execution_id,delivery.session_id,
        delivery.incarnation_id,delivery.state,delivery.attempt_count,delivery.channel,
        delivery.deadline_at,delivery.evidence_ref,delivery.detail,
        delivery.superseded_by_execution_id,delivery.created_at,delivery.updated_at,
        delivery.acknowledged_at,delivery.version,task.current_revision_id
      FROM task_revision_deliveries delivery
      JOIN tasks task ON task.id=delivery.task_id
      JOIN task_revisions revision ON revision.task_id=delivery.task_id
        AND revision.id=delivery.revision_id
      WHERE delivery.task_id=?1
        AND delivery.state NOT IN ('ACKNOWLEDGED','SUPERSEDED_BY_RESTART')
      ORDER BY revision.number DESC,delivery.created_at DESC LIMIT 1
    `).get(input.taskId);
    if (row === null) return null;
    if (input.executionId !== undefined && row.execution_id !== input.executionId) return null;
    if (input.sessionId !== undefined && row.session_id !== input.sessionId) return null;
    return this.mapTaskRevisionDelivery(row, row.current_revision_id,
      this.revisionDeliveryAttemptsForDeliveries([row.id]).get(row.id) ?? []);
  }

  /**
   * Opens one attempt to carry a revision to a specific Execution through a specific channel. The
   * delivery state is advanced by the domain FSM, so an attempt cannot be opened on top of an
   * attempt that is still in flight, and a satisfied delivery can never be re-opened.
   */
  beginRevisionDeliveryAttempt(input: {
    readonly projectId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly channel: TaskRevisionDeliveryChannel;
    readonly detail: string;
    readonly deadlineAt: number | null;
    readonly eventId: string;
    readonly startedAt: number;
  }): TaskRevisionDeliveryAttemptRecord {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.startedAt,
      apply: (database) => {
        const row = this.revisionDeliveryRow(input.deliveryId);
        if (row === null) throw new StorageError('NOT_FOUND', 'Revision delivery was not found');
        const next = this.applyRevisionDeliveryEvent(row, {
          type: 'ATTEMPT_STARTED', channel: input.channel,
        }, input.startedAt);
        const attemptNumber = next.attemptCount;
        database.query(`
          INSERT INTO task_revision_delivery_attempts(id,delivery_id,attempt_number,channel,
            execution_id,session_id,incarnation_id,state,detail,deadline_at,started_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,'IN_FLIGHT',?8,?9,?10)
        `).run(input.attemptId, input.deliveryId, attemptNumber, input.channel, row.execution_id,
          row.session_id, row.incarnation_id, input.detail, input.deadlineAt, input.startedAt);
        this.sqlite.query(`
          UPDATE task_revision_deliveries SET channel=?1,deadline_at=?2,detail=?3 WHERE id=?4
        `).run(input.channel, input.deadlineAt, input.detail, input.deliveryId);
        this.insertRevisionDeliveryEvent({
          eventId: input.eventId, projectId: row.project_id, deliveryId: input.deliveryId,
          eventType: 'TaskRevisionDeliveryAttempted', correlationId: input.commandId,
          causationId: null, occurredAt: input.startedAt,
          payload: { deliveryId: input.deliveryId, taskId: row.task_id, revisionId: row.revision_id,
            attemptNumber, channel: input.channel, executionId: row.execution_id,
            sessionId: row.session_id, incarnationId: row.incarnation_id, state: 'IN_FLIGHT',
            deadlineAt: input.deadlineAt },
        });
        return {
          id: input.attemptId,
          attemptNumber,
          channel: input.channel,
          executionId: row.execution_id,
          sessionId: row.session_id,
          incarnationId: row.incarnation_id,
          state: 'IN_FLIGHT' as const,
          evidenceRef: null,
          errorCode: null,
          detail: input.detail,
          deadlineAt: input.deadlineAt,
          startedAt: input.startedAt,
          endedAt: null,
        };
      },
    });
  }

  /**
   * Closes one attempt with the fact it actually produced and advances the delivery with the same
   * fact. `ACKNOWLEDGED` requires the adapter's structured evidence and is rejected when the Task
   * has already moved on to another revision (a stale acknowledgement is not a satisfied delivery).
   */
  completeRevisionDeliveryAttempt(input: {
    readonly projectId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly state: RevisionDeliveryAttemptState;
    readonly evidenceRef: string | null;
    readonly errorCode: string | null;
    readonly detail: string;
    readonly eventId: string;
    readonly completedAt: number;
  }): TaskRevisionDeliveryRecord {
    try {
      return this.completeRevisionDeliveryAttemptInTransaction(input);
    } catch (error) {
      // A rejected acknowledgement must not leave the attempt open forever: the guarded transition
      // rolled the delivery back, so the attempt itself is closed as FAILED in its own transaction.
      // Otherwise the delivery would stay IN_FLIGHT with an attempt that no retry could replace.
      if (error instanceof DomainError && error.code === 'STALE_REVISION_ACKNOWLEDGEMENT') {
        this.sqlite.query(`
          UPDATE task_revision_delivery_attempts SET state='FAILED',error_code=?1,detail=?2,
            ended_at=?3 WHERE id=?4 AND delivery_id=?5 AND state='IN_FLIGHT'
        `).run(error.code, `rejected: ${error.message}`, input.completedAt, input.attemptId,
          input.deliveryId);
      }
      throw error;
    }
  }

  private completeRevisionDeliveryAttemptInTransaction(input: {
    readonly projectId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly deliveryId: string;
    readonly attemptId: string;
    readonly state: RevisionDeliveryAttemptState;
    readonly evidenceRef: string | null;
    readonly errorCode: string | null;
    readonly detail: string;
    readonly eventId: string;
    readonly completedAt: number;
  }): TaskRevisionDeliveryRecord {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.completedAt,
      apply: (database) => {
        const row = this.revisionDeliveryRow(input.deliveryId);
        if (row === null) throw new StorageError('NOT_FOUND', 'Revision delivery was not found');
        if (input.state === 'IN_FLIGHT') {
          throw new StorageError('INVALID_STATE', 'An attempt cannot be closed as IN_FLIGHT');
        }
        const taskRow = this.sqlite.query<{ current_revision_id: string }, [string]>(`
          SELECT current_revision_id FROM tasks WHERE id=?1
        `).get(row.task_id);
        if (taskRow === null) throw new StorageError('NOT_FOUND', 'Task of the delivery was not found');
        const next = this.applyRevisionDeliveryEvent(row, input.state === 'ACKNOWLEDGED'
          ? { type: 'ACKNOWLEDGED', revisionId: row.revision_id,
              requiredRevisionId: taskRow.current_revision_id, evidenceRef: input.evidenceRef ?? '' }
          : input.state === 'UNACKNOWLEDGED'
            ? { type: 'NOT_ACKNOWLEDGED', detail: input.detail }
            : input.state === 'CHANNEL_UNSUPPORTED'
              ? { type: 'CHANNEL_UNSUPPORTED', capability: input.evidenceRef ?? 'unknown' }
              : input.state === 'TIMED_OUT'
                ? { type: 'TIMED_OUT', detail: input.detail }
                : { type: 'FAILED', code: input.errorCode ?? 'DELIVERY_FAILED' }, input.completedAt);
        const attemptUpdate = database.query(`
          UPDATE task_revision_delivery_attempts SET state=?1,evidence_ref=?2,error_code=?3,
            detail=?4,ended_at=?5 WHERE id=?6 AND delivery_id=?7 AND state='IN_FLIGHT'
        `).run(input.state, input.evidenceRef, input.errorCode, input.detail, input.completedAt,
          input.attemptId, input.deliveryId);
        if (attemptUpdate.changes !== 1) {
          throw new StorageError('INVALID_STATE', 'No in-flight attempt matched this completion');
        }
        database.query(`
          UPDATE task_revision_deliveries SET detail=?1,deadline_at=NULL WHERE id=?2
        `).run(input.detail, input.deliveryId);
        this.insertRevisionDeliveryEvent({
          eventId: input.eventId, projectId: row.project_id, deliveryId: input.deliveryId,
          eventType: 'TaskRevisionDeliveryResolved', correlationId: input.commandId,
          causationId: null, occurredAt: input.completedAt,
          payload: { deliveryId: input.deliveryId, taskId: row.task_id, revisionId: row.revision_id,
            attemptId: input.attemptId, state: next.state, channel: input.state === 'ACKNOWLEDGED'
              ? row.channel : (row.channel ?? null), evidenceRef: next.evidenceRef,
            errorCode: input.errorCode, detail: input.detail,
            satisfied: revisionDeliverySatisfied(next.state) },
        });
        return this.mapTaskRevisionDelivery(
          this.revisionDeliveryRow(input.deliveryId) as RevisionDeliveryRow,
          taskRow.current_revision_id,
          this.revisionDeliveryAttemptsForDeliveries([input.deliveryId]).get(input.deliveryId) ?? [],
        );
      },
    });
  }

  /** Attempts still in flight whose deadline has passed; the caller records the timeout verdict. */
  listExpiredRevisionDeliveryAttempts(now: number): readonly {
    readonly attemptId: string; readonly deliveryId: string; readonly projectId: string;
    readonly taskId: string; readonly channel: TaskRevisionDeliveryChannel;
    readonly deadlineAt: number;
  }[] {
    return this.sqlite.query<{
      attempt_id: string; delivery_id: string; project_id: string; task_id: string;
      channel: TaskRevisionDeliveryChannel; deadline_at: number;
    }, [number]>(`
      SELECT attempt.id AS attempt_id,attempt.delivery_id,delivery.project_id,delivery.task_id,
        attempt.channel,attempt.deadline_at
      FROM task_revision_delivery_attempts attempt
      JOIN task_revision_deliveries delivery ON delivery.id=attempt.delivery_id
      WHERE attempt.state='IN_FLIGHT' AND attempt.deadline_at IS NOT NULL AND attempt.deadline_at<=?1
      ORDER BY attempt.deadline_at,attempt.id
    `).all(now).map((row) => ({
      attemptId: row.attempt_id,
      deliveryId: row.delivery_id,
      projectId: row.project_id,
      taskId: row.task_id,
      channel: row.channel,
      deadlineAt: row.deadline_at,
    }));
  }

  listInFlightRevisionDeliveryAttempts(): readonly {
    readonly attemptId: string; readonly deliveryId: string; readonly projectId: string;
    readonly taskId: string; readonly channel: TaskRevisionDeliveryChannel;
    readonly deadlineAt: number | null; readonly startedAt: number;
  }[] {
    return this.sqlite.query<{
      attempt_id: string; delivery_id: string; project_id: string; task_id: string;
      channel: TaskRevisionDeliveryChannel; deadline_at: number | null; started_at: number;
    }, []>(`
      SELECT attempt.id AS attempt_id,attempt.delivery_id,delivery.project_id,delivery.task_id,
        attempt.channel,attempt.deadline_at,attempt.started_at
      FROM task_revision_delivery_attempts attempt
      JOIN task_revision_deliveries delivery ON delivery.id=attempt.delivery_id
      WHERE attempt.state='IN_FLIGHT' ORDER BY attempt.started_at,attempt.id
    `).all().map((row) => ({
      attemptId: row.attempt_id,
      deliveryId: row.delivery_id,
      projectId: row.project_id,
      taskId: row.task_id,
      channel: row.channel,
      deadlineAt: row.deadline_at,
      startedAt: row.started_at,
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Session Guidance (FOUNDATION-088 / ADR-0057). A guidance message is a conversation fact, not a
  // specification change: nothing below touches `task_revisions`, `tasks.current_revision_id` or any
  // verification run. The three facts this face keeps apart are "recorded", "delivered" (the
  // provider's own channel accepted the message — it is enqueued) and "the model read it". Only the
  // first two exist: ADR-0051 measured that no provider in this project has a channel that can prove
  // the third, so no column here could hold it honestly.
  // ---------------------------------------------------------------------------------------------

  /**
   * Records one guidance message durably and, when an Execution is holding the Task at this moment,
   * opens the single delivery attempt that will carry it into that conversation.
   *
   * The body is stored before any delivery is attempted (ADR-0010 D02) so a crash cannot lose what
   * the user said, and the domain event carries only its hash and length (ADR-0010 D06). A Task that
   * is not running simply gets no attempt: the record stays `RECORDED` and is handed to the next
   * Execution at launch, which is how guidance survives the process that was told about it.
   */
  recordSessionGuidance(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly guidanceId: string;
    readonly attemptId: string;
    readonly eventId: string;
    readonly body: string;
    readonly bodyHash: string;
    readonly bodyBytes: number;
    readonly actor: string;
    readonly recordedAt: number;
  }): SessionGuidanceCreation {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.recordedAt,
      apply: (database) => {
        const task = database.query<{ state: TaskLifecycleState; version: number }, [string, string]>(`
          SELECT t.state,t.version FROM tasks t
          JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
          WHERE t.project_id=?1 AND t.id=?2
        `).get(input.projectId, input.taskId);
        if (task === null) {
          throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
        }
        if (task.state === 'CANCELLED' || task.state === 'SUCCEEDED') {
          throw new StorageError('INVALID_STATE',
            `A ${task.state} Task is terminal and cannot receive session guidance`);
        }
        const running = database.query<{
          execution_id: string; session_id: string | null; incarnation_id: string | null;
        }, [string]>(`
          SELECT execution.id AS execution_id,session.id AS session_id,
            session.current_incarnation_id AS incarnation_id
          FROM executions execution
          LEFT JOIN agent_sessions session ON session.execution_id=execution.id
          WHERE execution.task_id=?1 AND execution.resource_held=1
        `).get(input.taskId) ?? null;
        database.query(`
          INSERT INTO session_guidance(id,project_id,task_id,execution_id,session_id,incarnation_id,
            source,body,body_hash,body_bytes,actor,state,channel,evidence_ref,delivery_detail,
            command_id,payload_hash,created_at,updated_at,delivered_at)
          VALUES (?1,?2,?3,?4,?5,?6,'COMMAND',?7,?8,?9,?10,'RECORDED',NULL,NULL,NULL,?11,?12,?13,?13,
            NULL)
        `).run(input.guidanceId, input.projectId, input.taskId, running?.execution_id ?? null,
          running?.session_id ?? null, running?.incarnation_id ?? null, input.body, input.bodyHash,
          input.bodyBytes, input.actor, input.commandId, input.payloadHash, input.recordedAt);
        if (running !== null) {
          database.query(`
            INSERT INTO session_guidance_deliveries(id,guidance_id,attempt_number,channel,
              execution_id,session_id,incarnation_id,state,capability,evidence_ref,error_code,detail,
              deadline_at,started_at,ended_at)
            VALUES (?1,?2,1,'PROVIDER_CONVERSATION',?3,?4,?5,'IN_FLIGHT',NULL,NULL,NULL,?6,NULL,?7,
              NULL)
          `).run(input.attemptId, input.guidanceId, running.execution_id, running.session_id,
            running.incarnation_id,
            `attempting to hand guidance ${input.guidanceId} to Execution ${running.execution_id}`,
            input.recordedAt);
        }
        insertDomainEvent(database, {
          eventId: input.eventId, projectId: input.projectId,
          eventType: 'SessionGuidanceRecorded', aggregateType: 'SessionGuidance',
          aggregateId: input.guidanceId, aggregateVersion: 0, correlationId: input.commandId,
          causationId: null, occurredAt: input.recordedAt,
          payload: { guidanceId: input.guidanceId, taskId: input.taskId, source: 'COMMAND',
            executionId: running?.execution_id ?? null, sessionId: running?.session_id ?? null,
            incarnationId: running?.incarnation_id ?? null, bodyHash: input.bodyHash,
            bodyBytes: input.bodyBytes, actor: input.actor,
            attemptId: running === null ? null : input.attemptId },
        });
        return {
          guidance: this.sessionGuidanceRecord(input.guidanceId),
          taskVersion: task.version,
          attemptId: running === null ? null : input.attemptId,
        };
      },
    });
  }

  /**
   * Closes the one attempt of a guidance record with the fact it actually produced.
   *
   * `DELIVERED` requires the channel fact the Adapter observed; a claim without evidence is refused,
   * exactly as an unproven revision acknowledgement is (ADR-0028). An attempt that is no longer in
   * flight is refused rather than overwritten: the ledger is append-only and a second conclusion is
   * a visible error, not a silent update.
   */
  completeSessionGuidanceDelivery(input: {
    readonly projectId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly guidanceId: string;
    readonly attemptId: string;
    readonly state: SessionGuidanceDeliveryState;
    readonly capability: string | null;
    readonly evidenceRef: string | null;
    readonly errorCode: string | null;
    readonly detail: string;
    readonly eventId: string;
    readonly completedAt: number;
  }): SessionGuidanceRecord {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.completedAt,
      apply: (database) => {
        const attempt = database.query<{
          state: SessionGuidanceDeliveryState; execution_id: string | null; session_id: string | null;
          incarnation_id: string | null;
        }, [string, string]>(`
          SELECT state,execution_id,session_id,incarnation_id FROM session_guidance_deliveries
          WHERE id=?1 AND guidance_id=?2
        `).get(input.attemptId, input.guidanceId);
        if (attempt === null) {
          throw new StorageError('NOT_FOUND', 'Guidance delivery attempt was not found');
        }
        if (attempt.state !== 'IN_FLIGHT') {
          throw new StorageError('INVALID_STATE',
            `The guidance delivery attempt is already ${attempt.state}`);
        }
        if (input.state === 'DELIVERED'
          && (input.evidenceRef === null || input.evidenceRef.trim().length === 0)) {
          throw new StorageError('INVALID_STATE',
            'A delivered guidance must name the channel fact that was observed; a claim without'
            + ' evidence is not a delivery');
        }
        database.query(`
          UPDATE session_guidance_deliveries SET state=?1,capability=?2,evidence_ref=?3,
            error_code=?4,detail=?5,ended_at=?6 WHERE id=?7 AND guidance_id=?8 AND state='IN_FLIGHT'
        `).run(input.state, input.capability, input.evidenceRef, input.errorCode, input.detail,
          input.completedAt, input.attemptId, input.guidanceId);
        database.query(`
          UPDATE session_guidance SET state=?1,channel='PROVIDER_CONVERSATION',evidence_ref=?2,
            delivery_detail=?3,delivered_at=?4,updated_at=?5 WHERE id=?6
        `).run(input.state, input.evidenceRef, input.detail,
          input.state === 'DELIVERED' ? input.completedAt : null, input.completedAt,
          input.guidanceId);
        insertDomainEvent(database, {
          eventId: input.eventId, projectId: input.projectId,
          eventType: 'SessionGuidanceDelivered', aggregateType: 'SessionGuidance',
          aggregateId: input.guidanceId, aggregateVersion: 1, correlationId: input.commandId,
          causationId: null, occurredAt: input.completedAt,
          payload: { guidanceId: input.guidanceId, attemptId: input.attemptId, channel:
            'PROVIDER_CONVERSATION', state: input.state, capability: input.capability,
            evidenceRef: input.evidenceRef, errorCode: input.errorCode, detail: input.detail,
            executionId: attempt.execution_id, sessionId: attempt.session_id,
            incarnationId: attempt.incarnation_id, delivered: input.state === 'DELIVERED' },
        });
        return this.sessionGuidanceRecord(input.guidanceId);
      },
    });
  }

  /** Every guidance record of one Task, oldest first, with its attempt ledger. */
  listSessionGuidance(projectId: string, taskId: string): readonly SessionGuidanceRecord[] {
    const task = this.sqlite.query<{ id: string }, [string, string]>(`
      SELECT t.id FROM tasks t
      JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
      WHERE t.project_id=?1 AND t.id=?2
    `).get(projectId, taskId);
    if (task === null) {
      throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
    }
    return this.sqlite.query<SessionGuidanceRow, [string]>(
      `${sessionGuidanceSelect} WHERE guidance.task_id=?1 ORDER BY guidance.created_at,guidance.id`,
    ).all(taskId).map((row) => this.mapSessionGuidance(row));
  }

  getSessionGuidance(projectId: string, guidanceId: string): SessionGuidanceRecord {
    const row = this.sqlite.query<SessionGuidanceRow, [string, string]>(`
      ${sessionGuidanceSelect}
      JOIN project_trusts trust ON trust.project_id=guidance.project_id AND trust.status='ACTIVE'
      WHERE guidance.project_id=?1 AND guidance.id=?2
    `).get(projectId, guidanceId);
    if (row === null) {
      throw new StorageError('NOT_FOUND',
        'Session guidance or active project trust was not found');
    }
    return this.mapSessionGuidance(row);
  }

  private sessionGuidanceRecord(guidanceId: string): SessionGuidanceRecord {
    const row = this.sqlite.query<SessionGuidanceRow, [string]>(
      `${sessionGuidanceSelect} WHERE guidance.id=?1`).get(guidanceId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Session guidance was not found');
    return this.mapSessionGuidance(row);
  }

  private mapSessionGuidance(row: SessionGuidanceRow): SessionGuidanceRecord {
    const attempts = this.sqlite.query<SessionGuidanceAttemptRow, [string]>(`
      SELECT id,attempt_number,channel,execution_id,session_id,incarnation_id,state,capability,
        evidence_ref,error_code,detail,deadline_at,started_at,ended_at
      FROM session_guidance_deliveries WHERE guidance_id=?1 ORDER BY attempt_number,id
    `).all(row.id);
    return {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      executionId: row.execution_id,
      sessionId: row.session_id,
      incarnationId: row.incarnation_id,
      source: row.source,
      body: row.body,
      bodyHash: row.body_hash,
      bodyBytes: row.body_bytes,
      actor: row.actor,
      state: row.state,
      channel: row.channel,
      evidenceRef: row.evidence_ref,
      deliveryDetail: row.delivery_detail,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deliveredAt: row.delivered_at,
      attempts: attempts.map((attempt) => ({
        id: attempt.id,
        attemptNumber: attempt.attempt_number,
        channel: attempt.channel,
        executionId: attempt.execution_id,
        sessionId: attempt.session_id,
        incarnationId: attempt.incarnation_id,
        state: attempt.state,
        capability: attempt.capability,
        evidenceRef: attempt.evidence_ref,
        errorCode: attempt.error_code,
        detail: attempt.detail,
        deadlineAt: attempt.deadline_at,
        startedAt: attempt.started_at,
        endedAt: attempt.ended_at,
      })),
    };
  }

  /**
   * Every guidance delivery attempt a restart interrupted. This Runtime holds no provider process
   * after a restart, so an attempt recorded as in flight cannot be replayed or claimed: the startup
   * reconcile closes it as `FAILED/RUNTIME_RESTARTED`, leaving the guidance record visibly
   * unconcluded (and still handed to the next Execution at launch).
   */
  listInFlightSessionGuidanceDeliveries(): readonly {
    readonly attemptId: string; readonly guidanceId: string; readonly projectId: string;
    readonly taskId: string; readonly startedAt: number;
  }[] {
    return this.sqlite.query<{
      attempt_id: string; guidance_id: string; project_id: string; task_id: string;
      started_at: number;
    }, []>(`
      SELECT attempt.id AS attempt_id,guidance.id AS guidance_id,guidance.project_id,guidance.task_id,
        attempt.started_at
      FROM session_guidance_deliveries attempt
      JOIN session_guidance guidance ON guidance.id=attempt.guidance_id
      WHERE attempt.state='IN_FLIGHT' ORDER BY attempt.started_at,attempt.id
    `).all().map((row) => ({
      attemptId: row.attempt_id,
      guidanceId: row.guidance_id,
      projectId: row.project_id,
      taskId: row.task_id,
      startedAt: row.started_at,
    }));
  }

  /**
   * Records the guidance artifact one Execution was launched with.
   *
   * Repeated launches of the same Execution (a resume replay, a retried start) are idempotent for the
   * same content, and a launch that carries a *different* set of recorded guidance appends a new row
   * rather than rewriting the old one: what an Execution was launched with must stay readable even
   * after the user adds more guidance.
   */
  recordExecutionGuidanceContext(input: {
    readonly id: string;
    readonly projectId: string;
    readonly taskId: string;
    readonly executionId: string;
    readonly guidanceIds: readonly string[];
    readonly contextPath: string;
    readonly contextDigest: string;
    readonly contextBytes: number;
    readonly recordedAt: number;
  }): ExecutionGuidanceContextRecord {
    this.sqlite.query(`
      INSERT INTO execution_guidance_contexts(id,project_id,task_id,execution_id,guidance_ids_json,
        guidance_count,context_path,context_digest,context_bytes,recorded_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
      ON CONFLICT(execution_id,context_digest) DO NOTHING
    `).run(input.id, input.projectId, input.taskId, input.executionId,
      JSON.stringify(input.guidanceIds), input.guidanceIds.length, input.contextPath,
      input.contextDigest, input.contextBytes, input.recordedAt);
    const row = this.sqlite.query<ExecutionGuidanceContextRow, [string, string]>(`
      SELECT id,project_id,task_id,execution_id,guidance_ids_json,guidance_count,context_path,
        context_digest,context_bytes,recorded_at
      FROM execution_guidance_contexts WHERE execution_id=?1 AND context_digest=?2
    `).get(input.executionId, input.contextDigest);
    if (row === null) {
      throw new StorageError('INVALID_STATE', 'The guidance context could not be recorded');
    }
    return mapExecutionGuidanceContextRow(row);
  }

  listExecutionGuidanceContexts(projectId: string, taskId: string):
  readonly ExecutionGuidanceContextRecord[] {
    const task = this.sqlite.query<{ id: string }, [string, string]>(`
      SELECT t.id FROM tasks t
      JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
      WHERE t.project_id=?1 AND t.id=?2
    `).get(projectId, taskId);
    if (task === null) {
      throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
    }
    return this.sqlite.query<ExecutionGuidanceContextRow, [string]>(`
      SELECT id,project_id,task_id,execution_id,guidance_ids_json,guidance_count,context_path,
        context_digest,context_bytes,recorded_at
      FROM execution_guidance_contexts WHERE task_id=?1 ORDER BY recorded_at,id
    `).all(taskId).map((row) => mapExecutionGuidanceContextRow(row));
  }

  /**
   * Satisfies a delivery from the stop-and-restart fact: the successor Execution row must actually
   * have been recorded with this delivery's revision. The check is part of the same transaction, so
   * a Runtime claim that "the successor continues on the new revision" cannot be recorded as true
   * when the Execution says otherwise (`SUCCESSOR_REVISION_MISMATCH`).
   */
  resolveRevisionDeliveryByRestart(input: {
    readonly projectId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly deliveryId: string;
    readonly successorExecutionId: string;
    readonly attemptId: string;
    readonly detail: string;
    readonly eventId: string;
    readonly resolvedAt: number;
  }): TaskRevisionDeliveryRecord {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.resolvedAt,
      apply: (database) => {
        const row = this.revisionDeliveryRow(input.deliveryId);
        if (row === null) throw new StorageError('NOT_FOUND', 'Revision delivery was not found');
        const successor = database.query<{
          applied_revision_id: string; state: string;
        }, [string, string]>(`
          SELECT applied_revision_id,state FROM executions WHERE id=?1 AND task_id=?2
        `).get(input.successorExecutionId, row.task_id);
        if (successor === null) {
          throw new StorageError('NOT_FOUND', 'The successor Execution was not found for this Task');
        }
        const next = this.applyRevisionDeliveryEvent(row, {
          type: 'SUPERSEDED_BY_RESTART',
          successorExecutionId: input.successorExecutionId,
          successorRevisionId: successor.applied_revision_id,
        }, input.resolvedAt);
        const attemptUpdate = database.query(`
          UPDATE task_revision_delivery_attempts SET state='SUPERSEDED_BY_RESTART',detail=?1,
            ended_at=?2 WHERE id=?3 AND delivery_id=?4 AND state='IN_FLIGHT'
        `).run(input.detail, input.resolvedAt, input.attemptId, input.deliveryId);
        if (attemptUpdate.changes !== 1) {
          throw new StorageError('INVALID_STATE', 'No in-flight attempt matched this restart resolution');
        }
        database.query(`
          UPDATE task_revision_deliveries SET detail=?1,superseded_by_execution_id=?2,
            deadline_at=NULL WHERE id=?3
        `).run(input.detail, input.successorExecutionId, input.deliveryId);
        this.insertRevisionDeliveryEvent({
          eventId: input.eventId, projectId: row.project_id, deliveryId: input.deliveryId,
          eventType: 'TaskRevisionDeliveryResolved', correlationId: input.commandId,
          causationId: input.attemptId, occurredAt: input.resolvedAt,
          payload: { deliveryId: input.deliveryId, taskId: row.task_id, revisionId: row.revision_id,
            predecessorExecutionId: row.execution_id, successorExecutionId: input.successorExecutionId,
            state: next.state, channel: 'STOP_AND_RESTART', evidenceRef: next.evidenceRef,
            satisfied: true, detail: input.detail },
        });
        const taskRow = this.sqlite.query<{ current_revision_id: string }, [string]>(
          'SELECT current_revision_id FROM tasks WHERE id=?1').get(row.task_id);
        return this.mapTaskRevisionDelivery(
          this.revisionDeliveryRow(input.deliveryId) as RevisionDeliveryRow,
          taskRow?.current_revision_id ?? row.revision_id,
          this.revisionDeliveryAttemptsForDeliveries([input.deliveryId]).get(input.deliveryId) ?? [],
        );
      },
    });
  }

  private insertRevisionDeliveryEvent(input: {
    readonly eventId: string;
    readonly projectId: string;
    readonly deliveryId: string;
    readonly eventType: string;
    readonly correlationId: string;
    readonly causationId: string | null;
    readonly occurredAt: number;
    readonly payload: Readonly<Record<string, unknown>>;
  }): void {
    this.sqlite.query(`
      INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
        aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
      VALUES (?1,?2,?3,1,'TaskRevisionDelivery',?4,0,?5,?6,?7,?8)
    `).run(input.eventId, input.projectId, input.eventType, input.deliveryId, input.correlationId,
      input.causationId, input.occurredAt, JSON.stringify(input.payload));
  }

  private revisionDeliveryRow(deliveryId: string): RevisionDeliveryRow | null {
    return this.sqlite.query<RevisionDeliveryRow, [string]>(`${revisionDeliverySelect}
      WHERE delivery.id=?1
    `).get(deliveryId);
  }

  private revisionDeliveryAttemptsForDeliveries(
    deliveryIds: readonly string[],
  ): Map<string, TaskRevisionDeliveryAttemptRecord[]> {
    const grouped = new Map<string, TaskRevisionDeliveryAttemptRecord[]>();
    if (deliveryIds.length === 0) return grouped;
    const placeholders = deliveryIds.map((_, index) => `?${index + 1}`).join(',');
    const rows = this.sqlite.query<{
      id: string; delivery_id: string; attempt_number: number; channel: TaskRevisionDeliveryChannel;
      execution_id: string | null; session_id: string | null; incarnation_id: string | null;
      state: RevisionDeliveryAttemptState; evidence_ref: string | null; error_code: string | null;
      detail: string; deadline_at: number | null; started_at: number; ended_at: number | null;
    }, string[]>(`
      SELECT id,delivery_id,attempt_number,channel,execution_id,session_id,incarnation_id,state,
        evidence_ref,error_code,detail,deadline_at,started_at,ended_at
      FROM task_revision_delivery_attempts WHERE delivery_id IN (${placeholders})
      ORDER BY delivery_id,attempt_number
    `).all(...deliveryIds);
    for (const row of rows) {
      const attempt: TaskRevisionDeliveryAttemptRecord = {
        id: row.id,
        attemptNumber: row.attempt_number,
        channel: row.channel,
        executionId: row.execution_id,
        sessionId: row.session_id,
        incarnationId: row.incarnation_id,
        state: row.state,
        evidenceRef: row.evidence_ref,
        errorCode: row.error_code,
        detail: row.detail,
        deadlineAt: row.deadline_at,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      };
      const list = grouped.get(row.delivery_id);
      if (list === undefined) grouped.set(row.delivery_id, [attempt]);
      else list.push(attempt);
    }
    return grouped;
  }

  private mapTaskRevisionDelivery(
    row: RevisionDeliveryRow,
    currentRevisionId: string,
    attempts: readonly TaskRevisionDeliveryAttemptRecord[],
  ): TaskRevisionDeliveryRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      revisionId: row.revision_id,
      revisionNumber: row.revision_number,
      executionId: row.execution_id,
      sessionId: row.session_id,
      incarnationId: row.incarnation_id,
      state: row.state,
      attemptCount: row.attempt_count,
      channel: row.channel,
      deadlineAt: row.deadline_at,
      evidenceRef: row.evidence_ref,
      detail: row.detail,
      supersededByExecutionId: row.superseded_by_execution_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      acknowledgedAt: row.acknowledged_at,
      satisfied: revisionDeliverySatisfied(row.state),
      stale: row.revision_id !== currentRevisionId,
      attempts,
    };
  }

  /**
   * Advances one delivery row through the pure domain FSM. The row's `version` column is the
   * optimistic version, so a concurrent resolution is rejected instead of overwriting a fact.
   */
  private applyRevisionDeliveryEvent(
    row: RevisionDeliveryRow,
    event: Parameters<typeof transitionRevisionDelivery>[2],
    updatedAt: number,
  ): RevisionDelivery {
    const delivery: RevisionDelivery = {
      id: row.id,
      taskId: row.task_id,
      revisionId: row.revision_id,
      state: row.state,
      attemptCount: row.attempt_count,
      evidenceRef: row.evidence_ref,
      version: row.version,
    };
    const next = transitionRevisionDelivery(delivery, row.version, event);
    // The FSM projection is persisted here, so the row and the returned aggregate cannot diverge: a
    // concurrent transition that did not see this version is rejected instead of overwriting it.
    // `acknowledged_at` moves with the state in the same statement: the table CHECK
    // `(state='ACKNOWLEDGED') = (acknowledged_at IS NOT NULL)` must hold at every intermediate step.
    const acknowledgedAt = next.state === 'ACKNOWLEDGED' ? updatedAt : null;
    const update = this.sqlite.query(`
      UPDATE task_revision_deliveries SET state=?1,attempt_count=?2,evidence_ref=?3,version=?4,
        updated_at=?5,acknowledged_at=?6 WHERE id=?7 AND version=?8
    `).run(next.state, next.attemptCount, next.evidenceRef, next.version, updatedAt, acknowledgedAt,
      row.id, row.version);
    if (update.changes !== 1) {
      throw new StorageError('CONCURRENT_MODIFICATION', 'Revision delivery changed during transition');
    }
    return next;
  }

  // ---------------------------------------------------------------------------------------------
  // Startup convergence of stale Session projections (ADR-0028).
  //
  // After a restart this Runtime holds no provider process, so a `agent_sessions`/`executions` row
  // that still says ACTIVE/RUNNING describes a process this generation cannot observe, attach to, or
  // claim. These methods list those projections with the recorded process-ownership evidence and
  // converge them from the *observed* facts; they never set a running state and never delete a
  // worktree, copy, or branch.
  // ---------------------------------------------------------------------------------------------

  /**
   * Sessions whose projection still claims a running provider, with the recorded incarnation and
   * writer lease facts a caller needs to check ownership. A Session whose Execution is already
   * terminal or `RECOVERY_REQUIRED` is not listed: that pair is already converged.
   */
  listStaleAgentSessions(): readonly StaleAgentSessionRecord[] {
    return this.sqlite.query<{
      project_id: string; task_id: string; task_state: TaskLifecycleState; task_version: number;
      execution_id: string; execution_state: ExecutionLifecycleState; execution_version: number;
      workspace_id: string; workspace_state: WorkspaceLifecycleState;
      session_id: string; session_state: AgentSessionLifecycleState; session_version: number;
      adapter_id: string; current_incarnation_id: string | null;
      incarnation_id: string | null; incarnation_number: number | null;
      incarnation_state: SessionIncarnationState | null; provider_pid: number | null;
      process_identity_json: string | null; process_tree_json: string | null;
      incarnation_created_at: number | null;
      lease_id: string | null; holder_kind: string | null; holder_ref: string | null;
    }, []>(`
      SELECT task.project_id,task.id AS task_id,task.state AS task_state,task.version AS task_version,
        execution.id AS execution_id,execution.state AS execution_state,
        execution.version AS execution_version,execution.workspace_id,
        workspace.state AS workspace_state,
        session.id AS session_id,session.state AS session_state,session.version AS session_version,
        execution.adapter_id,session.current_incarnation_id,
        incarnation.id AS incarnation_id,incarnation.incarnation_number,
        incarnation.state AS incarnation_state,incarnation.provider_pid,
        incarnation.process_identity_json,incarnation.process_tree_json,
        incarnation.created_at AS incarnation_created_at,
        lease.id AS lease_id,lease.holder_kind,lease.holder_ref
      FROM agent_sessions session
      JOIN executions execution ON execution.id=session.execution_id
      JOIN tasks task ON task.id=execution.task_id
      JOIN workspaces workspace ON workspace.id=execution.workspace_id
      LEFT JOIN session_incarnations incarnation ON incarnation.id=(
        SELECT candidate.id FROM session_incarnations candidate
        WHERE candidate.session_id=session.id
        ORDER BY candidate.incarnation_number DESC LIMIT 1)
      LEFT JOIN session_writer_leases lease
        ON lease.session_id=session.id AND lease.released_at IS NULL
      WHERE session.state NOT IN ('EXITED','DISCONNECTED','RECOVERY_REQUIRED')
        AND execution.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SUPERSEDED','RECOVERY_REQUIRED')
      ORDER BY session.id
    `).all().map((row) => ({
      projectId: row.project_id,
      taskId: row.task_id,
      taskState: row.task_state,
      taskVersion: row.task_version,
      executionId: row.execution_id,
      executionState: row.execution_state,
      executionVersion: row.execution_version,
      workspaceId: row.workspace_id,
      workspaceState: row.workspace_state,
      sessionId: row.session_id,
      sessionState: row.session_state,
      sessionVersion: row.session_version,
      adapterId: row.adapter_id,
      currentIncarnationId: row.current_incarnation_id,
      incarnation: row.incarnation_id === null ? null : {
        id: row.incarnation_id,
        incarnationNumber: row.incarnation_number as number,
        state: row.incarnation_state as SessionIncarnationState,
        providerPid: row.provider_pid,
        processIdentity: parseJsonValue(row.process_identity_json),
        processTree: parseJsonValue(row.process_tree_json),
        createdAt: row.incarnation_created_at as number,
      },
      writerLease: row.lease_id === null ? null : {
        id: row.lease_id,
        holderKind: row.holder_kind as string,
        holderRef: row.holder_ref as string,
      },
    }));
  }

  /**
   * Everything `task.recover` (ADR-0055) needs to *observe* before it may change anything: the Task,
   * the Execution that holds its resource, the Session and the newest incarnation (with the recorded
   * provider process identity and, when it exists, the descendant snapshot), and the workspace row.
   *
   * This is a read: it records nothing and decides nothing. The decision belongs to the caller, which
   * can only ever refuse or converge from the facts returned here.
   */
  getTaskRecoverySubject(projectId: string, taskId: string): TaskRecoverySubject | null {
    const row = this.sqlite.query<{
      project_id: string; task_id: string; display_number: number; task_state: TaskLifecycleState;
      task_version: number; archived_at: number | null;
      execution_id: string; execution_state: ExecutionLifecycleState; resource_held: number;
      execution_version: number; workspace_id: string; workspace_path: string;
      workspace_state: WorkspaceLifecycleState;
      session_id: string | null; session_state: AgentSessionLifecycleState | null;
      session_version: number | null; session_process_identity_json: string | null;
      incarnation_id: string | null; incarnation_process_identity_json: string | null;
      incarnation_process_tree_json: string | null;
    }, [string, string]>(`
      SELECT task.project_id,task.id AS task_id,task.display_number,task.state AS task_state,
        task.version AS task_version,task.archived_at,
        execution.id AS execution_id,execution.state AS execution_state,
        execution.resource_held,execution.version AS execution_version,
        workspace.id AS workspace_id,workspace.path AS workspace_path,workspace.state AS workspace_state,
        session.id AS session_id,session.state AS session_state,session.version AS session_version,
        session.process_identity_json AS session_process_identity_json,
        incarnation.id AS incarnation_id,
        incarnation.process_identity_json AS incarnation_process_identity_json,
        incarnation.process_tree_json AS incarnation_process_tree_json
      FROM tasks task
      JOIN executions execution ON execution.task_id=task.id
      JOIN workspaces workspace ON workspace.id=execution.workspace_id
      LEFT JOIN agent_sessions session ON session.execution_id=execution.id
      LEFT JOIN session_incarnations incarnation ON incarnation.id=(
        SELECT candidate.id FROM session_incarnations candidate
        WHERE candidate.session_id=session.id
        ORDER BY candidate.incarnation_number DESC LIMIT 1)
      WHERE task.project_id=?1 AND task.id=?2
      ORDER BY execution.attempt_number DESC LIMIT 1
    `).get(projectId, taskId);
    if (row === null) return null;
    return {
      projectId: row.project_id,
      taskId: row.task_id,
      displayNumber: row.display_number,
      taskState: row.task_state,
      taskVersion: row.task_version,
      archived: row.archived_at !== null,
      executionId: row.execution_id,
      executionState: row.execution_state,
      executionResourceHeld: row.resource_held === 1,
      executionVersion: row.execution_version,
      workspaceId: row.workspace_id,
      workspacePath: row.workspace_path,
      workspaceState: row.workspace_state,
      sessionId: row.session_id,
      sessionState: row.session_state,
      sessionVersion: row.session_version,
      sessionProcessIdentity: parseJsonValue(row.session_process_identity_json),
      incarnationId: row.incarnation_id,
      incarnationProcessIdentity: parseJsonValue(row.incarnation_process_identity_json),
      incarnationProcessTree: parseJsonValue(row.incarnation_process_tree_json),
    };
  }

  /**
   * The recovery reconcile one command already produced, so a replayed `task.recover` reaches its own
   * record instead of being answered from the Task's *current* state (the same rule `promotion.prepare`
   * follows). The payload hash travels with it because a replayed command id with a different payload
   * must stay a conflict rather than being silently answered.
   */
  findTaskRecoveryOutcomeByCommand(
    projectId: string,
    commandId: string,
  ): { readonly payloadHash: string; readonly outcome: TaskRecoveryOutcome } | null {
    const receipt = this.sqlite.query<{ payload_hash: string; result_json: string }, [string, string]>(
      'SELECT payload_hash,result_json FROM command_receipts WHERE project_id=?1 AND command_id=?2',
    ).get(projectId, commandId);
    if (receipt === null) return null;
    let recorded: unknown;
    try {
      recorded = JSON.parse(receipt.result_json) as unknown;
    } catch {
      return null;
    }
    if (typeof recorded !== 'object' || recorded === null) return null;
    const candidate = recorded as Partial<TaskRecoveryOutcome>;
    if (candidate.outcome !== 'RECONCILED' || typeof candidate.taskVersion !== 'number'
      || typeof candidate.taskId !== 'string') return null;
    return { payloadHash: receipt.payload_hash, outcome: candidate as TaskRecoveryOutcome };
  }

  /**
   * The one *write* `task.recover` performs (ADR-0055 D02): closes a `RECOVERY_REQUIRED` run as
   * `FAILED` from the observation the caller made, and appends that observation to the ledger.
   *
   * Every update is conditional on the state it expects, so a concurrent converge is a no-op rather
   * than a rewrite, and the whole call is one command receipt: a replayed command returns the first
   * answer instead of appending a second set of events.
   *
   * What it deliberately does not do: it never signals a process, never deletes or moves the
   * workspace (the row becomes `RETAINED`, which keeps `reclaim` the only path that removes the
   * directory), never rewrites `exit_json` (that is what was observed at the time), and never claims
   * quiescence — `quiescenceProven` is stored as `false` because a descendant snapshot the record
   * never captured cannot be excluded.
   */
  convergeRecoveredTask(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly reason: string | null;
    readonly actor: string;
    readonly detail: string;
    readonly evidence: Readonly<Record<string, unknown>>;
    readonly providerPid: number | null;
    readonly executionEventId: string;
    readonly sessionEventId: string;
    readonly taskEventId: string;
    readonly recoveryEventId: string;
    readonly recordedAt: number;
  }): TaskRecoveryOutcome {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.recordedAt,
      apply: (database) => {
        const subject = this.getTaskRecoverySubject(input.projectId, input.taskId);
        if (subject === null) throw new StorageError('NOT_FOUND', 'Task was not found');
        if (subject.taskVersion !== input.expectedVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION',
            `Task version is ${subject.taskVersion}, not the expected ${input.expectedVersion}`);
        }
        if (subject.taskState !== 'RECOVERY_REQUIRED') {
          throw new StorageError('TASK_NOT_IN_RECOVERY',
            `Task is ${subject.taskState}, so there is nothing to reconcile`);
        }
        const sessionUpdate = subject.sessionId === null ? 0 : database.query(`
          UPDATE agent_sessions SET state='EXITED',version=version+1,last_observed_at=?1
          WHERE id=?2 AND state<>'EXITED'
        `).run(input.recordedAt, subject.sessionId).changes;
        // The Execution is closed only if it still claims the run; an Execution that already reached
        // a terminal state is left exactly as it is (its failure is its own record).
        const executionUpdate = database.query(`
          UPDATE executions SET state='FAILED',resource_held=0,version=version+1,ended_at=?1,error_json=?2
          WHERE id=?3 AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SUPERSEDED')
        `).run(input.recordedAt, JSON.stringify({ code: 'RECOVERY_RECONCILED',
          message: input.detail, quiescenceProven: false }), subject.executionId).changes;
        database.query(`
          UPDATE workspaces SET state='RETAINED' WHERE id=?1 AND state IN ('RECOVERY_REQUIRED','IN_USE')
        `).run(subject.workspaceId);
        const taskUpdate = database.query(`
          UPDATE tasks SET state='FAILED',version=version+1,updated_at=?1
          WHERE id=?2 AND version=?3 AND state='RECOVERY_REQUIRED'
        `).run(input.recordedAt, subject.taskId, input.expectedVersion).changes;
        if (taskUpdate !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION',
            'Task changed during recovery reconcile');
        }
        appendRecoveryEvents(this.sqlite, {
          projectId: input.projectId, subject, expectedVersion: input.expectedVersion,
          commandId: input.commandId, actor: input.actor, reason: input.reason,
          detail: input.detail, evidence: input.evidence,
          executionEventId: input.executionEventId, sessionEventId: input.sessionEventId,
          taskEventId: input.taskEventId, recoveryEventId: input.recoveryEventId,
          recordedAt: input.recordedAt, sessionChanged: sessionUpdate === 1,
          executionChanged: executionUpdate === 1,
        });
        return {
          outcome: 'RECONCILED' as const,
          taskId: subject.taskId,
          displayNumber: subject.displayNumber,
          previousTaskState: 'RECOVERY_REQUIRED' as const,
          taskState: 'FAILED' as const,
          taskVersion: input.expectedVersion + 1,
          executionId: subject.executionId,
          sessionId: subject.sessionId,
          providerPid: input.providerPid,
        };
      },
    });
  }

  /**
   * Projects one stale Session/Execution pair as `DISCONNECTED`/`RECOVERY_REQUIRED` from the
   * ownership fact the caller observed, and appends that observation to the audit ledger. The update
   * is conditional on the states still being non-terminal, so a second startup (or a concurrent
   * converge) is a no-op rather than a rewrite.
   */
  convergeStaleAgentSession(input: {
    readonly sessionId: string;
    readonly observation: StaleSessionObservation;
    readonly providerPid: number | null;
    readonly detail: string;
    readonly evidence: Readonly<Record<string, unknown>>;
    readonly reconciliationId: string;
    readonly commandId: string;
    readonly sessionEventId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly recoveryEventId: string;
    readonly recordedAt: number;
  }): StaleAgentSessionConvergence {
    return this.sqlite.transaction(() => {
      const subject = this.sqlite.query<{
        project_id: string; task_id: string; task_state: TaskLifecycleState; task_version: number;
        execution_id: string; execution_state: ExecutionLifecycleState;
        execution_version: number; workspace_id: string;
        session_id: string; session_state: AgentSessionLifecycleState; session_version: number;
        incarnation_id: string | null; provider_pid: number | null;
      }, [string]>(`
        SELECT task.project_id,task.id AS task_id,task.state AS task_state,task.version AS task_version,
          execution.id AS execution_id,execution.state AS execution_state,
          execution.version AS execution_version,execution.workspace_id,
          session.id AS session_id,session.state AS session_state,session.version AS session_version,
          incarnation.id AS incarnation_id,incarnation.provider_pid
        FROM agent_sessions session
        JOIN executions execution ON execution.id=session.execution_id
        JOIN tasks task ON task.id=execution.task_id
        LEFT JOIN session_incarnations incarnation ON incarnation.id=(
          SELECT candidate.id FROM session_incarnations candidate
          WHERE candidate.session_id=session.id
          ORDER BY candidate.incarnation_number DESC LIMIT 1)
        WHERE session.id=?1
      `).get(input.sessionId);
      if (subject === null) throw new StorageError('NOT_FOUND', 'Stale Agent Session was not found');
      const terminalSession = ['EXITED', 'DISCONNECTED', 'RECOVERY_REQUIRED'].includes(subject.session_state);
      const terminalExecution = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'SUPERSEDED', 'RECOVERY_REQUIRED']
        .includes(subject.execution_state);
      if (terminalSession || terminalExecution) {
        return {
          converted: false,
          reason: 'ALREADY_CONVERGED' as const,
          sessionId: input.sessionId,
          executionId: subject.execution_id,
          previousSessionState: subject.session_state,
          previousExecutionState: subject.execution_state,
          projectedSessionState: subject.session_state,
          projectedExecutionState: subject.execution_state,
        };
      }
      const sessionUpdate = this.sqlite.query(`
        UPDATE agent_sessions SET state='DISCONNECTED',version=version+1,last_observed_at=?1,
          current_incarnation_id=NULL,exit_json=?2
        WHERE id=?3 AND state IN ('CREATED','STARTING','ACTIVE','WAITING_FOR_USER','PAUSING',
          'PAUSED','STOPPING')
      `).run(input.recordedAt, JSON.stringify({ reason: input.detail,
        observation: input.observation, reconciledAtBoot: true }), input.sessionId);
      const executionUpdate = this.sqlite.query(`
        UPDATE executions SET state='RECOVERY_REQUIRED',version=version+1
        WHERE id=?1 AND state IN ('CREATED','PREPARING','STARTING','RUNNING','WAITING_FOR_USER',
          'PAUSING','PAUSED','STOPPING')
      `).run(subject.execution_id);
      // The workspace keeps holding its resource: an orphaned tool child may still be writing it, so
      // ownership is retained and reclamation stays the only path that removes it (ADR-0021).
      this.sqlite.query("UPDATE workspaces SET state='RECOVERY_REQUIRED' WHERE id=?1 AND state IN ('RESERVED','PREPARING','READY','IN_USE')")
        .run(subject.workspace_id);
      const taskMoved = this.sqlite.query(`
        UPDATE tasks SET state='RECOVERY_REQUIRED',version=version+1,updated_at=?1
        WHERE id=?2 AND state IN ('RUNNING','WAITING_FOR_USER','PAUSING','PAUSED')
      `).run(input.recordedAt, subject.task_id).changes === 1;
      if (sessionUpdate.changes !== 1 || executionUpdate.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Stale Agent Session changed during startup convergence');
      }
      this.sqlite.query(`
        INSERT INTO agent_session_startup_reconciliations(id,project_id,task_id,session_id,
          execution_id,incarnation_id,previous_session_state,previous_execution_state,
          projected_session_state,projected_execution_state,observation,provider_pid,detail,
          evidence_json,command_id,recorded_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'DISCONNECTED','RECOVERY_REQUIRED',?9,?10,?11,?12,?13,?14)
      `).run(input.reconciliationId, subject.project_id, subject.task_id, subject.session_id,
        subject.execution_id, subject.incarnation_id, subject.session_state, subject.execution_state,
        input.observation, input.providerPid ?? subject.provider_pid, input.detail,
        JSON.stringify(input.evidence), input.commandId, input.recordedAt);
      const taskFrom = subject.execution_state === 'WAITING_FOR_USER' ? 'WAITING_FOR_USER' : 'RUNNING';
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'RecoveryRequired',1,'AgentSession',?3,?4,?5,?5,?6,?7)
      `).run(input.recoveryEventId, subject.project_id, subject.session_id,
        subject.session_version + 1, input.commandId, input.recordedAt,
        JSON.stringify({ resourceType: 'AgentSession', resourceId: subject.session_id,
          reason: 'STALE_ACTIVE_SESSION_AT_STARTUP', observation: input.observation,
          detail: input.detail }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'AgentSessionStateChanged',1,'AgentSession',?3,?4,?5,?6,?7,?8)
      `).run(input.sessionEventId, subject.project_id, subject.session_id,
        subject.session_version + 1, input.recoveryEventId, input.recoveryEventId,
        input.recordedAt, JSON.stringify({ sessionId: subject.session_id,
          from: subject.session_state, to: 'DISCONNECTED',
          reason: 'startup convergence of a stale ACTIVE Session',
          observation: input.observation }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?6,?7,?8)
      `).run(input.executionEventId, subject.project_id, subject.execution_id,
        subject.execution_version + 1, input.recoveryEventId, input.sessionEventId,
        input.recordedAt, JSON.stringify({ executionId: subject.execution_id,
          from: subject.execution_state, to: 'RECOVERY_REQUIRED',
          reason: 'startup convergence: quiescence is not proven', observation: input.observation }));
      if (taskMoved) {
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
        `).run(input.taskEventId, subject.project_id, subject.task_id, subject.task_version + 1,
          input.recoveryEventId, input.executionEventId, input.recordedAt,
          JSON.stringify({ taskId: subject.task_id, from: taskFrom, to: 'RECOVERY_REQUIRED',
            reason: 'stale Agent Session at startup', observation: input.observation }));
      }
      return {
        converted: true,
        reason: 'CONVERGED' as const,
        sessionId: subject.session_id,
        executionId: subject.execution_id,
        previousSessionState: subject.session_state,
        previousExecutionState: subject.execution_state,
        projectedSessionState: 'DISCONNECTED' as const,
        projectedExecutionState: 'RECOVERY_REQUIRED' as const,
      };
    })();
  }

  listAgentSessionStartupReconciliations(sessionId: string): readonly AgentSessionStartupReconciliationRecord[] {
    return this.sqlite.query<{
      id: string; project_id: string; task_id: string; session_id: string; execution_id: string;
      incarnation_id: string | null; previous_session_state: AgentSessionLifecycleState;
      previous_execution_state: ExecutionLifecycleState;
      projected_session_state: AgentSessionLifecycleState;
      projected_execution_state: ExecutionLifecycleState;
      observation: StaleSessionObservation; provider_pid: number | null; detail: string;
      evidence_json: string; command_id: string; recorded_at: number;
    }, [string]>(`
      SELECT id,project_id,task_id,session_id,execution_id,incarnation_id,previous_session_state,
        previous_execution_state,projected_session_state,projected_execution_state,observation,
        provider_pid,detail,evidence_json,command_id,recorded_at
      FROM agent_session_startup_reconciliations WHERE session_id=?1 ORDER BY recorded_at,id
    `).all(sessionId).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      sessionId: row.session_id,
      executionId: row.execution_id,
      incarnationId: row.incarnation_id,
      previousSessionState: row.previous_session_state,
      previousExecutionState: row.previous_execution_state,
      projectedSessionState: row.projected_session_state,
      projectedExecutionState: row.projected_execution_state,
      observation: row.observation,
      providerPid: row.provider_pid,
      detail: row.detail,
      evidence: JSON.parse(row.evidence_json) as Readonly<Record<string, unknown>>,
      commandId: row.command_id,
      recordedAt: row.recorded_at,
    }));
  }

  /**
   * Records one ImpactSnapshot. The reuse key is `(task, revision, base, analyzer, mapping,
   * change fingerprint)`: an identical recomputation returns the existing row instead of writing a
   * second one, and any component moving writes a *new* row. Nothing here can update an old row —
   * the table refuses it — so a verdict computed from an old fact stays readable as audit.
   */
  recordImpactSnapshot(input: ImpactSnapshotInput): ImpactSnapshotRecord {
    this.sqlite.transaction(() => {
      this.sqlite.query(`
        INSERT INTO impact_snapshots(id,project_id,task_id,revision_id,base_commit,analyzer_version,
          policy_version,policy_digest,case_mode,change_fingerprint,complete,incomplete_reasons_json,
          files_json,important_directories_json,modules_json,global_resources_json,
          unclassified_files_json,evidence_json,created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)
        ON CONFLICT(task_id,revision_id,base_commit,analyzer_version,policy_version,change_fingerprint)
        DO NOTHING
      `).run(input.id, input.projectId, input.taskId, input.revisionId, input.baseCommit,
        input.analyzerVersion, input.policyVersion, input.policyDigest, input.caseMode,
        input.changeFingerprint, input.complete ? 1 : 0, JSON.stringify(input.incompleteReasons),
        JSON.stringify(input.files), JSON.stringify(input.importantDirectories),
        JSON.stringify(input.modules), JSON.stringify(input.globalResources),
        JSON.stringify(input.unclassifiedFiles), JSON.stringify(input.evidence), input.createdAt);
    })();
    const stored = this.findImpactSnapshot({
      taskId: input.taskId,
      revisionId: input.revisionId,
      baseCommit: input.baseCommit,
      analyzerVersion: input.analyzerVersion,
      policyVersion: input.policyVersion,
      changeFingerprint: input.changeFingerprint,
    });
    if (stored === null) {
      throw new StorageError('INVALID_STATE', 'Impact snapshot was not readable after it was recorded');
    }
    if (stored.projectId !== input.projectId) {
      throw new StorageError('INVALID_STATE', 'Impact snapshot key belongs to a different project');
    }
    return stored;
  }

  findImpactSnapshot(key: ImpactSnapshotKey): ImpactSnapshotRecord | null {
    const row = this.sqlite.query<ImpactSnapshotRow, [string, string, string, string, string, string]>(`
      ${impactSnapshotSelect}
      WHERE task_id=?1 AND revision_id=?2 AND base_commit=?3 AND analyzer_version=?4
        AND policy_version=?5 AND change_fingerprint=?6
    `).get(key.taskId, key.revisionId, key.baseCommit, key.analyzerVersion, key.policyVersion,
      key.changeFingerprint);
    return row === null ? null : mapImpactSnapshotRow(row);
  }

  /** Stored snapshots newest first, so a reader can see how a Task's prediction moved over time. */
  listImpactSnapshots(input: {
    readonly projectId: string;
    readonly taskId?: string;
    readonly limit?: number;
  }): readonly ImpactSnapshotRecord[] {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
    return this.sqlite.query<ImpactSnapshotRow, [string, string, number]>(`
      ${impactSnapshotSelect}
      WHERE project_id=?1 AND (?2 = '' OR task_id=?2)
      ORDER BY created_at DESC,id DESC LIMIT ?3
    `).all(input.projectId, input.taskId ?? '', limit).map(mapImpactSnapshotRow);
  }

  /**
   * Records one pair-wise assessment. The key is the two snapshots it was computed from, so an
   * unchanged pair replays the stored verdict and a changed fact produces a new pair instead of
   * rewriting the old verdict.
   */
  recordImpactAssessment(input: ImpactAssessmentInput): ImpactAssessmentRecord {
    this.sqlite.transaction(() => {
      this.sqlite.query(`
        INSERT INTO impact_assessments(id,project_id,candidate_task_id,candidate_revision_id,
          candidate_snapshot_id,other_task_id,other_revision_id,other_snapshot_id,verdict,
          reason_codes_json,hits_json,evidence_json,created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
        ON CONFLICT(candidate_snapshot_id,other_snapshot_id) DO NOTHING
      `).run(input.id, input.projectId, input.candidateTaskId, input.candidateRevisionId,
        input.candidateSnapshotId, input.otherTaskId, input.otherRevisionId, input.otherSnapshotId,
        input.verdict, JSON.stringify(input.reasonCodes), JSON.stringify(input.hits),
        JSON.stringify(input.evidence), input.createdAt);
    })();
    const row = this.sqlite.query<ImpactAssessmentRow, [string, string]>(`
      ${impactAssessmentSelect}
      WHERE candidate_snapshot_id=?1 AND other_snapshot_id=?2
    `).get(input.candidateSnapshotId, input.otherSnapshotId);
    if (row === null) {
      throw new StorageError('INVALID_STATE', 'Impact assessment was not readable after it was recorded');
    }
    return mapImpactAssessmentRow(row);
  }

  listImpactAssessments(input: {
    readonly projectId: string;
    readonly taskId?: string;
    readonly limit?: number;
  }): readonly ImpactAssessmentRecord[] {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
    return this.sqlite.query<ImpactAssessmentRow, [string, string, number]>(`
      ${impactAssessmentSelect}
      WHERE project_id=?1 AND (?2 = '' OR candidate_task_id=?2 OR other_task_id=?2)
      ORDER BY created_at DESC,id DESC LIMIT ?3
    `).all(input.projectId, input.taskId ?? '', limit).map(mapImpactAssessmentRow);
  }

  /**
   * Every Task the analyzer must be compared against: the active/reserved set of
   * `docs/architecture/scheduler.md` §1. Holding an Execution row is exactly that state — a
   * reserved-but-unstarted, running, waiting, pausing, paused, stopping, or recovery-required
   * Execution all hold their resource, while a finished one has released it.
   */
  listImpactActiveTasks(projectId: string, excludeTaskId?: string): readonly ImpactActiveTaskRef[] {
    return this.sqlite.query<{
      task_id: string; task_state: TaskLifecycleState; current_revision_id: string;
      execution_id: string; execution_state: ExecutionLifecycleState;
      workspace_id: string | null; workspace_path: string | null; workspace_base_commit: string | null;
      workspace_state: WorkspaceLifecycleState | null;
    }, [string, string]>(`
      SELECT task.id AS task_id,task.state AS task_state,task.current_revision_id,
        execution.id AS execution_id,execution.state AS execution_state,
        workspace.id AS workspace_id,workspace.path AS workspace_path,
        workspace.base_commit AS workspace_base_commit,workspace.state AS workspace_state
      FROM tasks task
      JOIN executions execution ON execution.task_id=task.id AND execution.resource_held=1
      LEFT JOIN workspaces workspace ON workspace.id=execution.workspace_id
      WHERE task.project_id=?1 AND (?2 = '' OR task.id <> ?2)
      ORDER BY task.id
    `).all(projectId, excludeTaskId ?? '').map((row) => ({
      taskId: row.task_id,
      taskState: row.task_state,
      revisionId: row.current_revision_id,
      executionId: row.execution_id,
      executionState: row.execution_state,
      workspaceId: row.workspace_id,
      workspacePath: row.workspace_path,
      workspaceBaseCommit: row.workspace_base_commit,
      workspaceState: row.workspace_state,
    }));
  }

  /**
   * One Task plus the newest workspace that was not released. An ImpactSnapshot is an observation of
   * that workspace's change set, so it stays derivable after a run finished.
   */
  getImpactCandidateTask(projectId: string, taskId: string): ImpactCandidateTaskRef | null {
    const row = this.sqlite.query<{
      task_id: string; task_state: TaskLifecycleState; revision_id: string;
      archived_at: number | null; features_json: string;
      workspace_id: string | null; workspace_path: string | null;
      workspace_base_commit: string | null; workspace_state: WorkspaceLifecycleState | null;
    }, [string, string]>(`
      SELECT task.id AS task_id,task.state AS task_state,task.current_revision_id AS revision_id,
        task.archived_at,revision.features_json,
        workspace.id AS workspace_id,workspace.path AS workspace_path,
        workspace.base_commit AS workspace_base_commit,workspace.state AS workspace_state
      FROM tasks task
      JOIN task_revisions revision ON revision.task_id=task.id
        AND revision.id=task.current_revision_id
      LEFT JOIN workspaces workspace
        ON workspace.task_id=task.id AND workspace.state <> 'RELEASED'
      WHERE task.project_id=?1 AND task.id=?2
      ORDER BY workspace.created_at DESC,workspace.id DESC LIMIT 1
    `).get(projectId, taskId);
    if (row === null) return null;
    return {
      taskId: row.task_id,
      taskState: row.task_state,
      revisionId: row.revision_id,
      archived: row.archived_at !== null,
      features: parseTaskFeatures(row.features_json),
      workspaceId: row.workspace_id,
      workspacePath: row.workspace_path,
      workspaceBaseCommit: row.workspace_base_commit,
      workspaceState: row.workspace_state,
    };
  }

  /**
   * The Tasks a feature conflict can be decided against (ADR-0059): every Task of the project that is
   * **unfinished** (any state other than `SUCCEEDED`/`CANCELLED`) and **not archived**, and that
   * **declares at least one feature**. A Task that declares nothing can never share a feature, so it
   * is excluded here rather than compared and answered `SAFE` — the rule is about declarations, not
   * about every Task the project happens to contain.
   *
   * This projection replaces "Tasks holding an Execution resource" as the conflict input (ADR-0031
   * D06): a `READY` Task that has not started yet is exactly the case the rule is about, so the judge
   * can no longer be limited to Tasks that already hold a worktree.
   */
  listFeatureConflictPeers(projectId: string, excludeTaskId?: string): readonly FeatureConflictPeerRef[] {
    return this.sqlite.query<{
      task_id: string; display_number: number; task_state: TaskLifecycleState;
      archived_at: number | null; revision_id: string; features_json: string;
    }, [string, string]>(`
      SELECT task.id AS task_id,task.display_number,task.state AS task_state,task.archived_at,
        revision.id AS revision_id,revision.features_json
      FROM tasks task
      JOIN task_revisions revision ON revision.task_id=task.id
        AND revision.id=task.current_revision_id
      WHERE task.project_id=?1 AND (?2 = '' OR task.id <> ?2)
        AND task.archived_at IS NULL
        AND task.state NOT IN ('SUCCEEDED','CANCELLED')
        AND json_array_length(revision.features_json) > 0
      ORDER BY task.id
    `).all(projectId, excludeTaskId ?? '').map((row) => ({
      taskId: row.task_id,
      displayNumber: row.display_number,
      taskState: row.task_state,
      archived: row.archived_at !== null,
      revisionId: row.revision_id,
      features: parseTaskFeatures(row.features_json),
    }));
  }
  // ---------------------------------------------------------------------------------------------
  // Project Knowledge (FOUNDATION-067 / ADR-0041).
  //
  // Both tables are append-only by trigger, so there is deliberately no update or delete method
  // here. What these methods own:
  //
  // - a snapshot is keyed by the *facts it was derived from* (`project`, `mainCommit`, digest), so
  //   recording the same declared knowledge twice reuses one row instead of accumulating
  //   duplicates, and a changed knowledge file is necessarily a different row;
  // - a binding is keyed by the Execution (one Execution used one knowledge snapshot), and
  //   re-recording the identical binding is a replay, while a different one is an error rather
  //   than a silent overwrite.
  // ---------------------------------------------------------------------------------------------

  /**
   * Records one knowledge snapshot. Idempotent by `(project, mainCommit, snapshotDigest)`: the same
   * declared knowledge recorded twice yields the first row, including when a parallel writer won
   * the insert.
   */
  recordKnowledgeSnapshot(input: KnowledgeSnapshotInput): KnowledgeSnapshotRecord {
    this.sqlite.transaction(() => {
      this.sqlite.query(`
        INSERT INTO knowledge_snapshots(id,project_id,main_ref,main_commit,policy_version,
          snapshot_digest,human_digest,generated_digest,entry_count,human_entry_count,
          generated_entry_count,total_bytes,entries_json,created_by,created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
        ON CONFLICT(project_id,main_commit,snapshot_digest) DO NOTHING
      `).run(input.id, input.projectId, input.mainRef, input.mainCommit, input.policyVersion,
        input.snapshotDigest, input.humanDigest, input.generatedDigest, input.entryCount,
        input.humanEntryCount, input.generatedEntryCount, input.totalBytes,
        JSON.stringify(input.entries), input.createdBy, input.createdAt);
    })();
    const stored = this.findKnowledgeSnapshot({
      projectId: input.projectId,
      mainCommit: input.mainCommit,
      snapshotDigest: input.snapshotDigest,
    });
    if (stored === null) {
      throw new StorageError('INVALID_STATE',
        'Knowledge snapshot was not readable after it was recorded');
    }
    return stored;
  }

  findKnowledgeSnapshot(key: KnowledgeSnapshotKey): KnowledgeSnapshotRecord | null {
    const row = this.sqlite.query<KnowledgeSnapshotRow, [string, string, string]>(`
      ${knowledgeSnapshotSelect}
      WHERE project_id=?1 AND main_commit=?2 AND snapshot_digest=?3
    `).get(key.projectId, key.mainCommit, key.snapshotDigest);
    return row === null ? null : mapKnowledgeSnapshotRow(row);
  }

  getKnowledgeSnapshot(id: string): KnowledgeSnapshotRecord | null {
    const row = this.sqlite.query<KnowledgeSnapshotRow, [string]>(`
      ${knowledgeSnapshotSelect} WHERE id=?1
    `).get(id);
    return row === null ? null : mapKnowledgeSnapshotRow(row);
  }

  /** Stored snapshots newest first, so a reader can see how a project's knowledge moved. */
  listKnowledgeSnapshots(input: {
    readonly projectId: string;
    readonly limit?: number;
  }): readonly KnowledgeSnapshotRecord[] {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new StorageError('INVALID_STATE', `Invalid knowledge snapshot limit ${limit}`);
    }
    return this.sqlite.query<KnowledgeSnapshotRow, [string, number]>(`
      ${knowledgeSnapshotSelect}
      WHERE project_id=?1 ORDER BY created_at DESC, id DESC LIMIT ?2
    `).all(input.projectId, limit).map(mapKnowledgeSnapshotRow);
  }

  /**
   * Binds one Execution to the knowledge snapshot it used, together with the digest of the context
   * file it materialized. Called inside `reserveExecution`'s transaction for the real path, and
   * directly by tests; re-recording the identical binding is a replay, and a *different* snapshot
   * for the same Execution is an error — an Execution's binding is never rewritten.
   */
  recordExecutionKnowledgeSnapshot(
    input: ExecutionKnowledgeSnapshotInput,
  ): ExecutionKnowledgeSnapshotRecord {
    this.sqlite.query(`
      INSERT INTO execution_knowledge_snapshots(execution_id,project_id,task_id,snapshot_id,
        snapshot_digest,context_path,context_digest,context_bytes,entry_count,refs_json,command_id,
        created_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
      ON CONFLICT(execution_id) DO NOTHING
    `).run(input.executionId, input.projectId, input.taskId, input.snapshotId, input.snapshotDigest,
      input.contextPath, input.contextDigest, input.contextBytes, input.entryCount,
      JSON.stringify(input.refs), input.commandId, input.createdAt);
    const stored = this.getExecutionKnowledgeSnapshot(input.executionId);
    if (stored === null) {
      throw new StorageError('INVALID_STATE',
        'Execution knowledge binding was not readable after it was recorded');
    }
    if (stored.snapshotId !== input.snapshotId || stored.contextDigest !== input.contextDigest) {
      throw new StorageError('COMMAND_CONFLICT',
        `Execution ${input.executionId} is already bound to knowledge snapshot`
          + ` ${stored.snapshotId}; a binding is immutable`);
    }
    return stored;
  }

  getExecutionKnowledgeSnapshot(executionId: string): ExecutionKnowledgeSnapshotRecord | null {
    const row = this.sqlite.query<ExecutionKnowledgeSnapshotRow, [string]>(`
      SELECT execution_id,project_id,task_id,snapshot_id,snapshot_digest,context_path,context_digest,
        context_bytes,entry_count,refs_json,command_id,created_at
      FROM execution_knowledge_snapshots WHERE execution_id=?1
    `).get(executionId);
    return row === null ? null : mapExecutionKnowledgeSnapshotRow(row);
  }

  /** Bindings of one project, newest first; scoped to one Task when `taskId` is given. */
  listExecutionKnowledgeSnapshots(input: {
    readonly projectId: string;
    readonly taskId?: string;
    readonly limit?: number;
  }): readonly ExecutionKnowledgeSnapshotRecord[] {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new StorageError('INVALID_STATE', `Invalid knowledge binding limit ${limit}`);
    }
    const rows = input.taskId === undefined
      ? this.sqlite.query<ExecutionKnowledgeSnapshotRow, [string, number]>(`
          SELECT execution_id,project_id,task_id,snapshot_id,snapshot_digest,context_path,
            context_digest,context_bytes,entry_count,refs_json,command_id,created_at
          FROM execution_knowledge_snapshots WHERE project_id=?1
          ORDER BY created_at DESC, execution_id DESC LIMIT ?2
        `).all(input.projectId, limit)
      : this.sqlite.query<ExecutionKnowledgeSnapshotRow, [string, string, number]>(`
          SELECT execution_id,project_id,task_id,snapshot_id,snapshot_digest,context_path,
            context_digest,context_bytes,entry_count,refs_json,command_id,created_at
          FROM execution_knowledge_snapshots WHERE project_id=?1 AND task_id=?2
          ORDER BY created_at DESC, execution_id DESC LIMIT ?3
        `).all(input.projectId, input.taskId, limit);
    return rows.map(mapExecutionKnowledgeSnapshotRow);
  }

  // ---------------------------------------------------------------------------------------------
  // Capacity and resource reservations (Phase 2, FOUNDATION-054 / ADR-0032). The persisted model is
  // described in `capacitySlotReservationMigration`; these methods own its invariants.
  //
  // What they deliberately do **not** decide:
  //
  // - whether a dependency edge is *satisfied* — that needs the repository (Git reachability from
  //   the project's `dev` ref) and lives in the scheduler. Here the edge facts are re-read inside
  //   the write transaction and compared with the fingerprint the caller assessed, so a graph edit
  //   between the Git check and this write is refused instead of silently reserved;
  // - whether the recorded holder process is still alive — that is an OS question the Runtime
  //   answers, and the answer is passed in as an observation to record.
  // ---------------------------------------------------------------------------------------------

  /**
   * The Runtime-wide capacity configuration (ADR-0061 D01/D02). One `CODEESTRA_HOME`, one limit.
   *
   * A missing singleton row is not an error and not a zero: it means the user never set the limit
   * explicitly, so the documented default 2 applies and the source is reported as `DEFAULT`. Nothing
   * in this read is derived from host resources — the limit is a configuration, not a measurement.
   */
  getRuntimeCapacity(): RuntimeCapacityRecord {
    const row = this.sqlite.query<{
      global_limit: number; version: number; updated_at: number; updated_by: string;
    }, []>(`
      SELECT global_limit,version,updated_at,updated_by FROM runtime_capacity_settings
      WHERE singleton_id=1
    `).get();
    return {
      limit: row?.global_limit ?? defaultConcurrencyLimit,
      limitSource: row === null ? 'DEFAULT' : 'EXPLICIT',
      version: row?.version ?? 0,
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
    };
  }

  private assertCapacityLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new SlotReservationError('CAPACITY_LIMIT_INVALID',
        `A concurrency limit must be an integer of at least 1; got ${String(limit)}`);
    }
    if (limit > maxConcurrencyLimit) {
      throw new SlotReservationError('CAPACITY_LIMIT_OUT_OF_RANGE',
        `A concurrency limit must not exceed ${maxConcurrencyLimit}; got ${limit}`);
    }
  }

  /**
   * Sets the one Runtime-wide limit. It changes the number the *next* acquisition is judged against
   * and nothing else: a lower limit never releases, pauses or terminates a Task that already holds a
   * slot, so `used` may honestly exceed `limit` until those Tasks finish.
   *
   * Setting the value that is already effective is an idempotent no-op: no version bump and no event,
   * because nothing changed. The command identity is recorded in `runtime_command_receipts` rather
   * than `command_receipts`, because this command belongs to no Project.
   */
  setRuntimeCapacityLimit(input: {
    readonly limit: number;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly eventId: string;
    readonly actor: string;
    readonly updatedAt: number;
  }): RuntimeCapacityChange {
    this.assertCapacityLimit(input.limit);
    return this.executeRuntimeCommand({
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.updatedAt,
      apply: (database) => {
        const existing = database.query<{ global_limit: number; version: number }, []>(`
          SELECT global_limit,version FROM runtime_capacity_settings WHERE singleton_id=1
        `).get();
        if (existing === null) {
          database.query(`
            INSERT INTO runtime_capacity_settings(singleton_id,global_limit,version,updated_at,
              updated_by) VALUES (1,?1,0,?2,?3)
          `).run(input.limit, input.updatedAt, input.actor);
        } else if (existing.global_limit !== input.limit) {
          database.query(`
            UPDATE runtime_capacity_settings SET global_limit=?1,version=?2,updated_at=?3,
              updated_by=?4 WHERE singleton_id=1 AND global_limit=?5 AND version=?6
          `).run(input.limit, existing.version + 1, input.updatedAt, input.actor,
            existing.global_limit, existing.version);
        }
        const changed = existing === null || existing.global_limit !== input.limit;
        if (changed) {
          this.appendGlobalCapacityEvent({
            eventId: input.eventId,
            limit: input.limit,
            previousLimit: existing?.global_limit ?? defaultConcurrencyLimit,
            source: 'EXPLICIT',
            actor: input.actor,
            occurredAt: input.updatedAt,
          });
        }
        return { changed, capacity: this.getRuntimeCapacity() };
      },
    });
  }

  /**
   * Removes the explicit limit so the documented default applies again (ADR-0061 D02 `reset`).
   *
   * Deleting the row is the only honest way to say "back to the default": writing `2` with an
   * `EXPLICIT` source would record a user decision the user never made, and a later change of the
   * documented default would silently not apply to this Runtime. Resetting an already-default
   * configuration is an idempotent no-op with no event.
   */
  resetRuntimeCapacityLimit(input: {
    readonly commandId: string;
    readonly payloadHash: string;
    readonly eventId: string;
    readonly actor: string;
    readonly updatedAt: number;
  }): RuntimeCapacityChange {
    return this.executeRuntimeCommand({
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.updatedAt,
      apply: (database) => {
        const existing = database.query<{ global_limit: number }, []>(
          'SELECT global_limit FROM runtime_capacity_settings WHERE singleton_id=1').get();
        if (existing !== null) {
          database.query('DELETE FROM runtime_capacity_settings WHERE singleton_id=1').run();
          this.appendGlobalCapacityEvent({
            eventId: input.eventId,
            limit: defaultConcurrencyLimit,
            previousLimit: existing.global_limit,
            source: 'DEFAULT',
            actor: input.actor,
            occurredAt: input.updatedAt,
          });
        }
        return { changed: existing !== null, capacity: this.getRuntimeCapacity() };
      },
    });
  }

  /**
   * Appends one Runtime global capacity fact: `project_id = NULL`, because a global fact must not be
   * disguised as some Project's event (ADR-0061 D10). `source` distinguishes a user's explicit write,
   * a `reset` back to the default, and the value the v34 migration adopted from legacy config.
   */
  private appendGlobalCapacityEvent(input: {
    readonly eventId: string;
    readonly limit: number;
    readonly previousLimit: number | null;
    readonly source: 'DEFAULT' | 'EXPLICIT' | 'MIGRATED_MINIMUM';
    readonly actor: string;
    readonly occurredAt: number;
  }): void {
    this.sqlite.query(`
      INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
        aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
      VALUES (?1,NULL,'SchedulerGlobalCapacityChanged',1,'RuntimeSchedulerControl','runtime',1,?2,
        NULL,?3,?4)
    `).run(input.eventId, input.eventId, input.occurredAt, JSON.stringify({
      from: input.previousLimit, to: input.limit, source: input.source, actor: input.actor,
    }));
  }

  /**
   * The idempotency wrapper for a command that belongs to no Project (ADR-0061 D10): the same
   * command id answers with the recorded result, and the same key with a different payload is
   * refused. It is the `runtime_command_receipts` twin of `executeCommand`, and it exists because
   * `command_receipts` carries a `NOT NULL project_id` that a global command has nothing to fill.
   */
  private executeRuntimeCommand<T extends object>(input: {
    readonly commandId: string;
    readonly payloadHash: string;
    readonly createdAt: number;
    readonly apply: (database: Database) => T;
  }): T {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<
        { payload_hash: string; result_json: string },
        [string]
      >('SELECT payload_hash,result_json FROM runtime_command_receipts WHERE command_id=?1')
        .get(input.commandId);
      if (existing !== null) {
        if (existing.payload_hash !== input.payloadHash) {
          throw new StorageError('COMMAND_CONFLICT',
            'Command ID was already used with a different payload');
        }
        return JSON.parse(existing.result_json) as T;
      }
      const result = input.apply(this.sqlite);
      this.sqlite.query(`
        INSERT INTO runtime_command_receipts(command_id,payload_hash,result_json,created_at)
        VALUES (?1,?2,?3,?4)
      `).run(input.commandId, input.payloadHash, JSON.stringify(result), input.createdAt);
      return result;
    })();
  }

  /**
   * Who currently occupies a slot, read as facts across the whole Runtime (ADR-0061 D01).
   *
   * A slot is occupied by a Task that either holds an active reservation or is running with
   * `resource_held=1` (the pre-reservation `task.run` path). Counting per *Task* — never per row —
   * means a reserved Task that then starts an Execution consumes exactly one slot, and `excludeTaskId`
   * keeps a Task from blocking itself when its reservation is re-checked. The Project a candidate
   * belongs to and the Adapter it would use no longer narrow this read: there is no second limit.
   */
  countActiveSlotOccupants(input: {
    readonly excludeTaskId?: string;
  } = {}): SlotOccupancy {
    return countSlotOccupants(this.sqlite, input);
  }

  /** Every reservation of one project, newest first. Released rows are kept as audit. */
  listSlotReservations(projectId: string, options: {
    readonly taskId?: string;
    readonly includeReleased?: boolean;
    readonly limit?: number;
  } = {}): readonly ExecutionSlotReservationRecord[] {
    this.assertTrustedProject(projectId);
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxSlotReservationReadLimit) {
      throw new StorageError('INVALID_STATE',
        `A reservation read limit must be between 1 and ${maxSlotReservationReadLimit}`);
    }
    const filters = ['reservation.project_id=?1'];
    const parameters: [string, ...(string | number)[]] = [projectId];
    if (options.taskId !== undefined) {
      parameters.push(options.taskId);
      filters.push(`AND reservation.task_id=?${parameters.length}`);
    }
    if (options.includeReleased !== true) filters.push("AND reservation.state<>'RELEASED'");
    parameters.push(limit);
    return this.sqlite.query<SlotReservationRow, [string, ...(string | number)[]]>(`
      ${slotReservationSelect}
      WHERE ${filters.join(' ')}
      ORDER BY reservation.reserved_at DESC,reservation.id
      LIMIT ?${parameters.length}
    `).all(...parameters).map(mapSlotReservationRow);
  }

  /**
   * Every active reservation in the database, across projects. The startup reconcile needs exactly
   * this set: after a restart no generation owns any reservation, so nothing is filtered out by
   * project — a residual slot anywhere is residual capacity everywhere.
   */
  listActiveSlotReservations(): readonly ExecutionSlotReservationRecord[] {
    return this.sqlite.query<SlotReservationRow, []>(`
      ${slotReservationSelect}
      WHERE reservation.state IN ('RESERVED','RECOVERY_REQUIRED')
      ORDER BY reservation.reserved_at,reservation.id
    `).all().map(mapSlotReservationRow);
  }

  getSlotReservation(projectId: string, reservationId: string): SlotReservationDetail {
    this.assertTrustedProject(projectId);
    const row = this.sqlite.query<SlotReservationRow, [string, string]>(`
      ${slotReservationSelect}
      WHERE reservation.project_id=?1 AND reservation.id=?2
    `).get(projectId, reservationId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Slot reservation was not found');
    const events = this.sqlite.query<{
      sequence: number; kind: SlotReservationEventKind; domain_event_id: string | null;
      command_id: string; actor: string; detail: string; evidence_json: string; occurred_at: number;
    }, [string]>(`
      SELECT sequence,kind,domain_event_id,command_id,actor,detail,evidence_json,occurred_at
      FROM execution_slot_reservation_events WHERE reservation_id=?1 ORDER BY sequence
    `).all(reservationId).map((event) => ({
      sequence: event.sequence,
      kind: event.kind,
      domainEventId: event.domain_event_id,
      commandId: event.command_id,
      actor: event.actor,
      detail: event.detail,
      evidence: JSON.parse(event.evidence_json) as Readonly<Record<string, unknown>>,
      occurredAt: event.occurred_at,
    }));
    return { ...mapSlotReservationRow(row), events };
  }

  /**
   * Acquires one reservation, or reports why it could not be granted.
   *
   * Everything that decides the outcome is re-read *inside* the `BEGIN IMMEDIATE` transaction: the
   * Task version and revision (the caller's compare-and-swap), the dependency facts (against the
   * fingerprint the caller assessed), the cached ImpactSnapshot generation (against the generation the
   * caller observed, with the Task revision and worktree baseline re-read here), the draining fact,
   * and the capacity of both dimensions. Two concurrent acquirers therefore cannot both see a free
   * slot: the second one blocks on the write lock and then observes the committed row, and the partial
   * unique index is the second guard.
   *
   * A refused acquisition writes nothing at all: the transaction rolls back, so a capacity wait and a
   * `SNAPSHOT_STALE` refusal are both observations rather than side effects. (A capacity wait returns a
   * value and therefore does record its command receipt, which is what makes a repeated wait answer the
   * same way; a refusal throws, so retrying the same command also re-evaluates it.)
   */
  reserveExecutionSlot(input: SlotReservationAcquireInput): ExecutionSlotAcquisition {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.createdAt,
      apply: (database) => {
        this.assertTrustedProject(input.projectId);
        const task = database.query<{
          state: TaskLifecycleState; version: number; current_revision_id: string;
        }, [string, string]>(`
          SELECT task.state,task.version,task.current_revision_id FROM tasks task
          WHERE task.project_id=?1 AND task.id=?2
        `).get(input.projectId, input.taskId);
        if (task === null) throw new StorageError('NOT_FOUND', 'Task was not found in this project');
        if (task.version !== input.expectedTaskVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
        }
        if (task.current_revision_id !== input.expectedRevisionId) {
          throw new SlotReservationError('REVISION_CHANGED',
            `Task revision is ${task.current_revision_id}, not ${input.expectedRevisionId}`);
        }
        if (task.state !== 'READY') {
          throw new SlotReservationError('TASK_NOT_RESERVABLE',
            `A slot can only be reserved for a READY Task; this Task is ${task.state}`);
        }
        // The same connection, therefore the same transaction: the facts cannot change between this
        // read and the insert, and any graph or integration change since the caller's check shows up
        // as a fingerprint mismatch instead of a reservation on a stale assessment.
        const facts = this.listTaskDependencyFacts(input.projectId, { taskId: input.taskId });
        const fingerprint = slotDependencyFingerprint(facts);
        if (fingerprint !== input.dependencyFingerprint) {
          throw new SlotReservationError('DEPENDENCY_STATE_CHANGED',
            'The dependency facts changed since they were assessed; re-assess before reserving');
        }
        // scheduler.md §2: recheck the *cached snapshot generation* this reservation was assessed
        // against, inside this same immediate transaction. The caller observed the Git-side facts
        // (mapping version, change set, and the development baseline of a Task with no worktree yet);
        // what a concurrent writer can move in the meantime is re-read here — the stored row, the
        // Task's current revision, and the worktree's baseline — and fed to the analyzer's own
        // `recheckImpactSnapshotGeneration`, so this is the same verdict the analyzer would give, not
        // a second opinion with weaker rules.
        const expected = input.snapshotRecheck ?? null;
        if (expected !== null) {
          const row = database.query<ImpactSnapshotRow, [string, string]>(`
            ${impactSnapshotSelect} WHERE project_id=?1 AND id=?2
          `).get(input.projectId, expected.snapshotId);
          if (row === null) {
            throw new SlotReservationError('SNAPSHOT_UNAVAILABLE',
              `ImpactSnapshot ${expected.snapshotId} is not readable in this project, so the`
              + ' generation it was assessed from cannot be confirmed; nothing was reserved',
              { code: 'SNAPSHOT_UNAVAILABLE', snapshotId: expected.snapshotId,
                taskId: input.taskId });
          }
          if (row.task_id !== input.taskId) {
            throw new SlotReservationError('SNAPSHOT_UNAVAILABLE',
              `ImpactSnapshot ${row.id} belongs to Task ${row.task_id}, not to the Task being`
              + ' reserved; nothing was reserved',
              { code: 'SNAPSHOT_UNAVAILABLE', snapshotId: row.id, taskId: input.taskId,
                snapshotTaskId: row.task_id });
          }
          // The worktree row is read in this transaction: a Task without a live worktree was assessed
          // against the caller's development-ref observation, which SQLite cannot re-read, and one
          // with a worktree has a baseline this transaction can and does confirm.
          const worktree = database.query<{ base_commit: string }, [string]>(`
            SELECT base_commit FROM workspaces WHERE task_id=?1 AND state<>'RELEASED'
            ORDER BY created_at DESC,id DESC LIMIT 1
          `).get(input.taskId);
          if (expected.baselineSource === 'WORKSPACE' && worktree === null) {
            throw slotSnapshotStaleRefusal({
              row,
              taskId: input.taskId,
              currentRevisionId: task.current_revision_id,
              reasonCodes: ['STALE_BASE'],
              differing: ['baseCommit'],
              observedBaseCommit: null,
              observedPolicyVersion: expected.policyVersion,
              observedAnalyzerVersion: expected.analyzerVersion,
              observedChangeFingerprint: expected.changeFingerprint,
              observedPathCount: expected.files.length,
              detail: `ImpactSnapshot ${row.id} was assessed against worktree baseline`
                + ` ${expected.baseCommit.slice(0, 12)}, but this Task has no live worktree any more`,
            });
          }
          if (expected.baselineSource === 'BASELINE_REF' && worktree !== null) {
            // The caller observed "no worktree, predicted against the Task baseline ref" and the
            // Task now has one: the facts the prediction described are not the facts of this write.
            throw slotSnapshotStaleRefusal({
              row,
              taskId: input.taskId,
              currentRevisionId: task.current_revision_id,
              reasonCodes: ['STALE_BASE'],
              differing: ['baseCommit'],
              observedBaseCommit: worktree.base_commit,
              observedPolicyVersion: expected.policyVersion,
              observedAnalyzerVersion: expected.analyzerVersion,
              observedChangeFingerprint: expected.changeFingerprint,
              observedPathCount: expected.files.length,
              detail: `ImpactSnapshot ${row.id} was assessed while this Task had no worktree, and it`
                + ` now has one at ${worktree.base_commit.slice(0, 12)}`,
            });
          }
          const recheck = slotSnapshotGenerationRecheck({
            row,
            currentRevisionId: task.current_revision_id,
            baseCommit: worktree?.base_commit ?? expected.baseCommit,
            files: expected.files,
            policyVersion: expected.policyVersion,
            analyzerVersion: expected.analyzerVersion,
            changeFingerprint: expected.changeFingerprint,
          });
          if (!recheck.current) {
            throw new SlotReservationError('SNAPSHOT_STALE',
              `ImpactSnapshot ${row.id} is no longer the current assessment of Task`
              + ` ${input.taskId}: ${recheck.reasonCodes.join(', ')}`
              + ` (${recheck.differing.join(', ')} differ); nothing was reserved`,
              { code: 'SNAPSHOT_STALE', snapshotId: row.id, taskId: input.taskId,
                reasonCodes: recheck.reasonCodes, differing: recheck.differing,
                assessed: recheck.assessed, observed: recheck.observed });
          }
        }
        const existing = database.query<{ id: string; state: SlotReservationState }, [string]>(`
          SELECT id,state FROM execution_slot_reservations
          WHERE task_id=?1 AND state IN ('RESERVED','RECOVERY_REQUIRED')
        `).get(input.taskId);
        if (existing !== null) {
          throw new SlotReservationError('SLOT_ALREADY_RESERVED',
            `Task already has an active slot reservation ${existing.id} (${existing.state})`);
        }
        const capacity = this.slotCapacityFor(database, { excludeTaskId: input.taskId });
        const drain = input.draining();
        if (drain.draining) {
          return {
            outcome: 'DRAINING' as const,
            wait: {
              code: 'SCHEDULER_DRAINING' as const,
              adapterId: input.adapterId,
              limit: null,
              used: null,
              blocking: [],
              detail: drain.reason ?? 'the Runtime is draining and accepts no new reservations',
            },
            capacity,
            reservation: null,
          };
        }
        if (capacity.globalUsed >= capacity.globalLimit) {
          return {
            outcome: 'CAPACITY_WAIT' as const,
            wait: {
              code: 'CAPACITY_GLOBAL_LIMIT_REACHED' as const,
              adapterId: input.adapterId,
              limit: capacity.globalLimit,
              used: capacity.globalUsed,
              blocking: capacity.globalBlocking,
              detail: `${capacity.globalUsed} of ${capacity.globalLimit} Runtime-wide slots are in use`,
            },
            capacity,
            reservation: null,
          };
        }
        if (input.workspaceId !== null && input.workspaceId !== undefined) {
          const workspace = database.query<{ state: string }, [string, string]>(`
            SELECT state FROM workspaces WHERE task_id=?1 AND id=?2 AND state<>'RELEASED'
          `).get(input.taskId, input.workspaceId);
          if (workspace === null) {
            throw new StorageError('NOT_FOUND', 'Workspace was not found for this Task');
          }
        }
        database.query(`
          INSERT INTO execution_slot_reservations(id,project_id,task_id,revision_id,task_version,
            adapter_id,workspace_id,impact_snapshot_id,dependency_fingerprint,assessed_dev_commit,state,
            version,command_id,holder_boot_id,holder_pid,holder_start_token,holder_actor,reserved_at,
            updated_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'RESERVED',0,?11,?12,?13,?14,?15,?16,?16)
        `).run(input.reservationId, input.projectId, input.taskId, input.expectedRevisionId,
          input.expectedTaskVersion, input.adapterId, input.workspaceId ?? null,
          input.impactSnapshotId ?? null, input.dependencyFingerprint, input.assessedDevCommit,
          input.commandId, input.holder.bootId, input.holder.pid, input.holder.startToken,
          input.holder.actor, input.createdAt);
        insertSlotReservationEvent(database, {
          reservationId: input.reservationId,
          kind: 'RESERVED',
          domainEventId: input.eventId,
          commandId: input.commandId,
          actor: input.holder.actor,
          detail: `reserved one ${input.adapterId} slot for Task ${input.taskId}`,
          evidence: {
            source: 'ACQUIRE',
            holder: { bootId: input.holder.bootId, pid: input.holder.pid,
              startToken: input.holder.startToken },
            adapterId: input.adapterId,
            revisionId: input.expectedRevisionId,
            taskVersion: input.expectedTaskVersion,
            workspaceId: input.workspaceId ?? null,
            impactSnapshotId: input.impactSnapshotId ?? null,
            dependencyFingerprint: input.dependencyFingerprint,
            assessedDevCommit: input.assessedDevCommit,
            capacity,
          },
          occurredAt: input.createdAt,
        });
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ExecutionSlotReserved',1,'ExecutionSlot',?3,1,?4,NULL,?5,?6)
        `).run(input.eventId, input.projectId, input.reservationId, input.commandId, input.createdAt,
          JSON.stringify({
            reservationId: input.reservationId,
            taskId: input.taskId,
            revisionId: input.expectedRevisionId,
            adapterId: input.adapterId,
            workspaceId: input.workspaceId ?? null,
            holder: { bootId: input.holder.bootId, pid: input.holder.pid,
              startToken: input.holder.startToken },
            capacity,
          }));
        // Reported *after* the insert: the capacity facts a caller reads back must include the slot
        // it just acquired, otherwise a client would have to add one itself.
        return {
          outcome: 'RESERVED' as const,
          capacity: this.slotCapacityFor(database, {}),
          wait: null,
          reservation: this.getSlotReservation(input.projectId, input.reservationId),
        };
      },
    });
  }

  /**
   * Binds a prepared workspace to an active reservation. The workspace belongs to the same Task and
   * to no other active reservation (enforced by the partial unique index).
   */
  bindReservationWorkspace(input: {
    readonly projectId: string;
    readonly reservationId: string;
    readonly workspaceId: string;
    readonly expectedReservationVersion: number;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly eventId: string;
    readonly actor: string;
    readonly at: number;
  }): ExecutionSlotReservationRecord {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.at,
      apply: (database) => {
        const subject = database.query<{
          id: string; task_id: string; state: SlotReservationState; version: number;
          workspace_id: string | null;
        }, [string, string]>(`
          SELECT id,task_id,state,version,workspace_id FROM execution_slot_reservations
          WHERE project_id=?1 AND id=?2
        `).get(input.projectId, input.reservationId);
        if (subject === null) {
          throw new StorageError('NOT_FOUND', 'Slot reservation was not found');
        }
        if (subject.state !== 'RESERVED') {
          throw new SlotReservationError('SLOT_NOT_ACTIVE',
            `Reservation ${subject.id} is ${subject.state}; it holds no workspace to bind`);
        }
        if (subject.version !== input.expectedReservationVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Reservation version did not match');
        }
        if (subject.workspace_id === input.workspaceId) {
          return this.getSlotReservation(input.projectId, input.reservationId);
        }
        if (subject.workspace_id !== null) {
          throw new SlotReservationError('SLOT_ALREADY_BOUND',
            `Reservation ${subject.id} already holds workspace ${subject.workspace_id}`);
        }
        const update = database.query(`
          UPDATE execution_slot_reservations SET workspace_id=?1,version=?2,updated_at=?3
          WHERE project_id=?4 AND id=?5 AND version=?6 AND state='RESERVED' AND workspace_id IS NULL
        `).run(input.workspaceId, subject.version + 1, input.at, input.projectId, input.reservationId,
          subject.version);
        if (update.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Reservation changed while binding a workspace');
        }
        insertSlotReservationEvent(this.sqlite, {
          reservationId: input.reservationId,
          kind: 'RESERVED',
          domainEventId: input.eventId,
          commandId: input.commandId,
          actor: input.actor,
          detail: `bound workspace ${input.workspaceId} to the reservation`,
          evidence: { source: 'WORKSPACE_BIND', workspaceId: input.workspaceId,
            taskId: subject.task_id },
          occurredAt: input.at,
        });
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ExecutionSlotWorkspaceBound',1,'ExecutionSlot',?3,?4,?5,NULL,?6,?7)
        `).run(input.eventId, input.projectId, input.reservationId, subject.version + 1,
          input.commandId, input.at, JSON.stringify({
            reservationId: input.reservationId, taskId: subject.task_id,
            workspaceId: input.workspaceId,
          }));
        return this.getSlotReservation(input.projectId, input.reservationId);
      },
    });
  }

  /**
   * Releases one reservation explicitly. The caller has already decided that releasing is allowed
   * (it owns the reservation, or the recorded holder was verified as gone); what is re-checked here
   * is the row's own state and version, so two concurrent releases cannot both apply.
   */
  releaseExecutionSlot(input: {
    readonly projectId: string;
    readonly reservationId: string;
    readonly expectedReservationVersion: number;
    readonly reason: string;
    readonly actor: string;
    readonly releaseKind: SlotReservationReleaseKind;
    readonly observation: SlotHolderObservationKind | null;
    readonly evidence: Readonly<Record<string, unknown>>;
    readonly eventId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly at: number;
  }): SlotReservationReleaseResult {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.at,
      apply: (database) => {
        const subject = database.query<{
          id: string; task_id: string; state: SlotReservationState; version: number;
        }, [string, string]>(`
          SELECT id,task_id,state,version FROM execution_slot_reservations
          WHERE project_id=?1 AND id=?2
        `).get(input.projectId, input.reservationId);
        if (subject === null) throw new StorageError('NOT_FOUND', 'Slot reservation was not found');
        if (subject.state === 'RELEASED') {
          return {
            released: false,
            outcome: 'ALREADY_RELEASED' as const,
            reservation: this.getSlotReservation(input.projectId, input.reservationId),
          };
        }
        if (subject.version !== input.expectedReservationVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Reservation version did not match');
        }
        const update = database.query(`
          UPDATE execution_slot_reservations SET state='RELEASED',version=?1,updated_at=?2,
            released_at=?2,release_reason=?3,release_kind=?4,release_observation=?5,detail=?3
          WHERE project_id=?6 AND id=?7 AND version=?8 AND state<>'RELEASED'
        `).run(subject.version + 1, input.at, input.reason, input.releaseKind, input.observation,
          input.projectId, input.reservationId, subject.version);
        if (update.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Reservation changed during release');
        }
        insertSlotReservationEvent(this.sqlite, {
          reservationId: input.reservationId,
          kind: 'RELEASED',
          domainEventId: input.eventId,
          commandId: input.commandId,
          actor: input.actor,
          detail: input.reason,
          evidence: {
            source: 'RELEASE',
            releaseKind: input.releaseKind,
            observation: input.observation,
            previousState: subject.state,
            ...input.evidence,
          },
          occurredAt: input.at,
        });
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ExecutionSlotReleased',1,'ExecutionSlot',?3,?4,?5,NULL,?6,?7)
        `).run(input.eventId, input.projectId, input.reservationId, subject.version + 1,
          input.commandId, input.at, JSON.stringify({
            reservationId: input.reservationId,
            taskId: subject.task_id,
            releaseKind: input.releaseKind,
            observation: input.observation,
            reason: input.reason,
          }));
        return {
          released: true,
          outcome: 'RELEASED' as const,
          reservation: this.getSlotReservation(input.projectId, input.reservationId),
        };
      },
    });
  }

  /**
   * Records one reconcile decision about a reservation and appends its observation — including the
   * decision to keep the slot occupied, which changes nothing but must still be auditable.
   *
   * The command ID is what makes it idempotent: the startup reconcile derives it from this boot and
   * the reservation, so a second run inside the same generation appends no second observation and
   * applies no second state change.
   */
  recordSlotReservationReconcile(input: {
    readonly projectId: string;
    readonly reservationId: string;
    readonly expectedReservationVersion: number;
    readonly decision: 'RELEASE' | 'KEEP_HELD' | 'MARK_RECOVERY_REQUIRED';
    readonly observation: SlotHolderObservationKind;
    readonly releaseKind: SlotReservationReleaseKind | null;
    readonly detail: string;
    readonly evidence: Readonly<Record<string, unknown>>;
    readonly ledgerEventId: string;
    readonly eventId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly actor: string;
    readonly at: number;
  }): SlotReservationReconcileOutcome {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.at,
      apply: (database) => {
        const subject = database.query<{
          id: string; task_id: string; state: SlotReservationState; version: number;
        }, [string, string]>(`
          SELECT id,task_id,state,version FROM execution_slot_reservations
          WHERE project_id=?1 AND id=?2
        `).get(input.projectId, input.reservationId);
        if (subject === null) throw new StorageError('NOT_FOUND', 'Slot reservation was not found');
        if (subject.version !== input.expectedReservationVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Reservation version did not match');
        }
        const alreadyReconciled = database.query<{ sequence: number }, [string, string]>(`
          SELECT sequence FROM execution_slot_reservation_events
          WHERE reservation_id=?1 AND command_id=?2
        `).get(input.reservationId, input.commandId);
        if (alreadyReconciled !== null) {
          return {
            outcome: 'ALREADY_RECONCILED' as const,
            state: subject.state,
            reservation: this.getSlotReservation(input.projectId, input.reservationId),
          };
        }
        let state: SlotReservationState = subject.state;
        let outcome: SlotReservationReconcileOutcome['outcome'] = 'HELD';
        if (input.decision === 'RELEASE') {
          if (subject.state === 'RELEASED') {
            outcome = 'ALREADY_RELEASED';
          } else {
            const update = database.query(`
              UPDATE execution_slot_reservations SET state='RELEASED',version=?1,updated_at=?2,
                released_at=?2,release_reason=?3,release_kind=?4,release_observation=?5,detail=?3
              WHERE project_id=?6 AND id=?7 AND version=?8 AND state<>'RELEASED'
            `).run(subject.version + 1, input.at, input.detail, input.releaseKind, input.observation,
              input.projectId, input.reservationId, subject.version);
            if (update.changes !== 1) {
              throw new StorageError('CONCURRENT_MODIFICATION', 'Reservation changed during reconcile');
            }
            state = 'RELEASED';
            outcome = 'RELEASED';
          }
        } else if (input.decision === 'MARK_RECOVERY_REQUIRED') {
          if (subject.state !== 'RECOVERY_REQUIRED') {
            const update = database.query(`
              UPDATE execution_slot_reservations SET state='RECOVERY_REQUIRED',version=?1,
                updated_at=?2,release_observation=?3,detail=?4
              WHERE project_id=?5 AND id=?6 AND version=?7 AND state='RESERVED'
            `).run(subject.version + 1, input.at, input.observation, input.detail, input.projectId,
              input.reservationId, subject.version);
            if (update.changes !== 1) {
              throw new StorageError('CONCURRENT_MODIFICATION',
                'Reservation changed while being marked RECOVERY_REQUIRED');
            }
            state = 'RECOVERY_REQUIRED';
            outcome = 'MARKED_RECOVERY_REQUIRED';
          } else {
            outcome = 'HELD';
          }
        }
        insertSlotReservationEvent(this.sqlite, {
          reservationId: input.reservationId,
          kind: 'RECONCILE_OBSERVED',
          domainEventId: input.eventId,
          commandId: input.commandId,
          actor: input.actor,
          detail: input.detail,
          evidence: {
            source: 'RECONCILE',
            decision: input.decision,
            observation: input.observation,
            releaseKind: input.releaseKind,
            previousState: subject.state,
            projectedState: state,
            ...input.evidence,
          },
          occurredAt: input.at,
        });
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ExecutionSlotReconciled',1,'ExecutionSlot',?3,?4,?5,NULL,?6,?7)
        `).run(input.eventId, input.projectId, input.reservationId,
          database.query<{ sequence: number | null }, [string]>(`
            SELECT MAX(sequence) AS sequence FROM execution_slot_reservation_events WHERE reservation_id=?1
          `).get(input.reservationId)?.sequence ?? 1,
          input.commandId, input.at, JSON.stringify({
            reservationId: input.reservationId,
            taskId: subject.task_id,
            decision: input.decision,
            observation: input.observation,
            previousState: subject.state,
            projectedState: state,
            detail: input.detail,
          }));
        return {
          outcome,
          state,
          reservation: this.getSlotReservation(input.projectId, input.reservationId),
        };
      },
    });
  }

  /**
   * The capacity facts as the next acquisition would be judged against (ADR-0061 D01): the single
   * Runtime-wide limit and the Runtime-wide occupancy. There is no second dimension to report, so the
   * old Adapter limit fields are gone rather than meaningless zeroes.
   */
  private slotCapacityFor(database: Database, input: {
    readonly excludeTaskId?: string;
  }): SlotCapacityCheck {
    const capacity = this.getRuntimeCapacity();
    const occupancy = countSlotOccupants(database, input);
    return {
      globalLimit: capacity.limit,
      globalLimitSource: capacity.limitSource,
      globalUsed: occupancy.globalUsed,
      globalBlocking: occupancy.globalBlocking,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Scheduling decisions (Phase 2, FOUNDATION-055 / ADR-0030). The scheduling engine writes its
  // decisions into the same append-only `domain_events` ledger everything else uses, and reads them
  // back through these two methods. No new table is opened for this: a decision, a wait transition
  // and an explicit `--allow-unknown` release are all *facts about the past* and belong in the
  // ledger, which is exactly what the audit requirement asks for.
  //
  // Idempotency is keyed on the caller's command: one command writes at most one event of each
  // type. A replayed tick therefore appends nothing, and the read side can treat
  // `(event_type, correlation_id)` as the identity of a decision.
  // ---------------------------------------------------------------------------------------------

  /**
   * Appends one scheduling fact. The event is returned as it was stored, so a caller can record the
   * event id (for example the release a start consumed) without a second read.
   */
  recordTaskScheduleEvent(input: {
    readonly eventId: string;
    readonly projectId: string;
    readonly eventType: TaskScheduleEventType;
    readonly taskId: string;
    readonly aggregateVersion: number;
    readonly commandId: string;
    readonly actor: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly occurredAt: number;
  }): StoredEventEnvelope {
    if (input.taskId.trim().length === 0) {
      throw new StorageError('INVALID_STATE', 'A scheduling fact must name the Task it is about');
    }
    if (!taskScheduleEventTypes.includes(input.eventType)) {
      throw new StorageError('INVALID_STATE',
        `Unknown scheduling event type ${input.eventType}`);
    }
    // A replayed command must not append a second copy of the same decision, and the ledger has no
    // unique index on the correlation id, so the guard is an explicit existence check inside the
    // same statement.
    const statement = `
      INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
        aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
      SELECT ?1,?2,?3,1,'TaskSchedule',?4,?5,?6,NULL,?7,?8
      WHERE NOT EXISTS(
        SELECT 1 FROM domain_events WHERE event_type=?3 AND correlation_id=?6 AND aggregate_id=?4
      )
    `;
    this.sqlite.query(statement).run(input.eventId, input.projectId, input.eventType, input.taskId,
      input.aggregateVersion, input.commandId, input.occurredAt, JSON.stringify(input.payload));
    const row = this.sqlite.query<{
      event_id: string; sequence: number; event_type: string; schema_version: number;
      project_id: string; aggregate_type: string; aggregate_id: string; aggregate_version: number;
      correlation_id: string; causation_id: string | null; occurred_at: number; payload_json: string;
    }, [string, string, string, string]>(`
      SELECT event_id,sequence,event_type,schema_version,project_id,aggregate_type,aggregate_id,
        aggregate_version,correlation_id,causation_id,occurred_at,payload_json
      FROM domain_events WHERE event_id=?1 OR (event_type=?2 AND correlation_id=?3 AND aggregate_id=?4)
      ORDER BY sequence DESC LIMIT 1
    `).get(input.eventId, input.eventType, input.commandId, input.taskId);
    if (row === null) {
      throw new StorageError('INVALID_STATE', 'A scheduling fact was not readable after it was written');
    }
    return {
      eventId: row.event_id,
      sequence: row.sequence,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      projectId: row.project_id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json) as unknown,
    };
  }

  /**
   * Newest-first read of one Task's scheduling facts. The aggregate of these events is the Task, so
   * every decision, wait transition, released prediction and explicit `UNKNOWN` release of a Task is
   * one ordered history.
   */
  listTaskScheduleEvents(input: {
    readonly projectId: string;
    readonly taskId?: string;
    readonly limit?: number;
  }): readonly StoredEventEnvelope[] {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 500);
    return this.sqlite.query<{
      event_id: string; sequence: number; event_type: string; schema_version: number;
      project_id: string; aggregate_type: string; aggregate_id: string; aggregate_version: number;
      correlation_id: string; causation_id: string | null; occurred_at: number; payload_json: string;
    }, [string, string, number, ...string[]]>(`
      SELECT event_id,sequence,event_type,schema_version,project_id,aggregate_type,aggregate_id,
        aggregate_version,correlation_id,causation_id,occurred_at,payload_json
      FROM domain_events
      WHERE project_id=?1 AND aggregate_type='TaskSchedule'
        AND (?2='' OR aggregate_id=?2) AND event_type IN (${taskScheduleEventTypes.map((_type, index) => `?${index + 4}`).join(',')})
      ORDER BY sequence DESC LIMIT ?3
    `).all(input.projectId, input.taskId ?? '', limit, ...taskScheduleEventTypes).map((row) => ({
      eventId: row.event_id,
      sequence: row.sequence,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      projectId: row.project_id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json) as unknown,
    }));
  }

  // -------------------------------------------------------------------------------------------
  // Runtime global load control (FOUNDATION-097 / ADR-0061 D04–D10, schema v34).
  //
  // These are control-plane facts, not Task business state. Every write below is one immediate
  // transaction so that "the receipt exists" and "the state moved" are the same fact, and so a
  // crash can never leave a recorded receipt whose transition did not happen (or the reverse).
  // The methods deliberately take *observations* and *state*, never a signal: this layer never
  // touches a process. Process identity verification and the OS signals live in the Runtime service.
  // -------------------------------------------------------------------------------------------

  /** The singleton control row. The v34 migration always writes it, so it is never absent. */
  getRuntimePauseControl(): RuntimePauseControlRecord {
    const row = this.sqlite.query<{
      state: RuntimeGlobalControlState; pause_epoch: number; version: number;
      requested_at: number | null; requested_by: string | null; settled_at: number | null;
      detail_json: string | null;
    }, []>(`
      SELECT state,pause_epoch,version,requested_at,requested_by,settled_at,detail_json
      FROM runtime_pause_control WHERE singleton_id=1
    `).get();
    if (row === null || row === undefined) {
      throw new StorageError('INVALID_STATE',
        'The Runtime global control row is missing; the schema v34 migration always creates it');
    }
    return {
      state: row.state,
      pauseEpoch: row.pause_epoch,
      version: row.version,
      requestedAt: row.requested_at,
      requestedBy: row.requested_by,
      settledAt: row.settled_at,
      detail: row.detail_json === null ? null : JSON.parse(row.detail_json) as unknown,
    };
  }

  /**
   * The targets of one pause epoch, oldest first. Absent epoch = the newest epoch that has targets,
   * which is what `status` reports; an explicit epoch is what `resume` needs, because it must
   * continue **the epoch it paused**, not whatever epoch is newest by the time it runs.
   */
  listRuntimePauseTargets(pauseEpoch?: number): readonly RuntimePauseTargetRecord[] {
    const epoch = pauseEpoch ?? this.sqlite.query<{ pause_epoch: number | null }, []>(
      'SELECT MAX(pause_epoch) AS pause_epoch FROM runtime_pause_targets').get()?.pause_epoch ?? 0;
    if (epoch === 0) return Object.freeze([]);
    return Object.freeze(this.sqlite.query<RuntimePauseTargetRow, [number]>(`
      SELECT id,pause_epoch,project_id,task_id,execution_id,session_id,incarnation_id,provider_pid,
        provider_start_token,state,observation_json,created_at,updated_at
      FROM runtime_pause_targets WHERE pause_epoch=?1 ORDER BY created_at,id
    `).all(epoch).map(mapRuntimePauseTargetRow));
  }

  /**
   * A global command's receipt, or null when it has not run. A replayed command id with a different
   * payload is `COMMAND_CONFLICT` — the same rule project commands already follow — because
   * `pause`/`resume`/`reconcile` belong to no Project, so `command_receipts` (which is keyed by
   * `project_id`) cannot hold them.
   */
  findRuntimeCommandReceipt(input: {
    readonly commandId: string;
    readonly payloadHash: string;
  }): RuntimeCommandReceiptRecord | null {
    const row = this.sqlite.query<{ payload_hash: string; result_json: string; created_at: number },
      [string]>('SELECT payload_hash,result_json,created_at FROM runtime_command_receipts WHERE command_id=?1')
      .get(input.commandId);
    if (row === null || row === undefined) return null;
    if (row.payload_hash !== input.payloadHash) {
      throw new StorageError('COMMAND_CONFLICT',
        'Command ID was already used with a different payload');
    }
    return { commandId: input.commandId, payloadHash: row.payload_hash,
      result: JSON.parse(row.result_json) as unknown, createdAt: row.created_at };
  }

  /**
   * Commits the barrier (ADR-0061 D05 step 1): from this instant the control row says `PAUSING`, the
   * epoch has moved, and every target of that epoch is recorded as `PENDING` with the identity
   * snapshot taken now. Callers must have verified nothing yet — the barrier comes first, which is
   * what makes "no new start after this commit" a fact rather than a race.
   *
   * A replay of the same command returns the recorded receipt instead of opening a second epoch.
   */
  beginRuntimeGlobalPause(input: {
    readonly commandId: string;
    readonly payloadHash: string;
    readonly actor: string;
    readonly epoch: number;
    readonly targets: readonly RuntimePauseTargetInput[];
    readonly eventId: string;
    readonly occurredAt: number;
  }): RuntimeGlobalControlWrite {
    return this.sqlite.transaction(() => {
      const existing = this.findRuntimeCommandReceipt({
        commandId: input.commandId, payloadHash: input.payloadHash,
      });
      if (existing !== null) {
        const control = this.getRuntimePauseControl();
        return { control, targets: this.listRuntimePauseTargets(control.pauseEpoch),
          replayed: true };
      }
      const current = this.getRuntimePauseControl();
      this.sqlite.query(`
        UPDATE runtime_pause_control SET state='PAUSING',pause_epoch=?1,version=version+1,
          requested_at=?2,requested_by=?3,settled_at=NULL,detail_json=?4 WHERE singleton_id=1
      `).run(input.epoch, input.occurredAt, input.actor,
        JSON.stringify({ stage: 'PAUSE', requestedBy: input.actor }));
      const insert = this.sqlite.query(`
        INSERT INTO runtime_pause_targets(id,pause_epoch,project_id,task_id,execution_id,session_id,
          incarnation_id,provider_pid,provider_start_token,state,observation_json,created_at,
          updated_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'PENDING',?10,?11,?11)
        ON CONFLICT(pause_epoch,incarnation_id) DO NOTHING
      `);
      for (const target of input.targets) {
        insert.run(target.id, input.epoch, target.projectId, target.taskId, target.executionId,
          target.sessionId, target.incarnationId, target.providerPid, target.providerStartToken,
          JSON.stringify(target.observation), input.occurredAt);
      }
      this.appendRuntimeGlobalEvent({
        eventId: input.eventId,
        eventType: 'SchedulerGlobalPauseRequested',
        aggregateVersion: current.pauseEpoch + 1,
        commandId: input.commandId,
        actor: input.actor,
        occurredAt: input.occurredAt,
        payload: {
          pauseEpoch: input.epoch,
          actor: input.actor,
          targets: input.targets.map((target) => ({
            sessionId: target.sessionId,
            executionId: target.executionId,
            incarnationId: target.incarnationId,
            projectId: target.projectId,
            taskId: target.taskId,
            providerPid: target.providerPid,
          })),
        },
      });
      return {
        control: this.getRuntimePauseControl(),
        targets: this.listRuntimePauseTargets(input.epoch),
        replayed: false,
      };
    })();
  }

  /**
   * Settles a pause epoch: records each target's observed outcome and writes either
   * `SchedulerGlobalPaused` (every target `STOPPED`/`EXITED`) or
   * `SchedulerGlobalControlRecoveryRequired`. A partial result is never written as `PAUSED` — the
   * caller passes the verdict it can prove, and the state and the event are written together.
   */
  settleRuntimeGlobalPause(input: {
    readonly epoch: number;
    readonly outcome: 'PAUSED' | 'RECOVERY_REQUIRED';
    readonly detail: unknown;
    readonly targetUpdates: readonly RuntimePauseTargetUpdate[];
    /** The command that caused this settlement, for the event's correlation only. */
    readonly commandId: string;
    readonly actor: string;
    readonly eventId: string;
    readonly occurredAt: number;
  }): RuntimeGlobalControlWrite {
    return this.sqlite.transaction(() => {
      this.applyRuntimePauseTargetUpdates(input.targetUpdates, input.occurredAt);
      this.sqlite.query(`
        UPDATE runtime_pause_control SET state=?1,version=version+1,settled_at=?2,detail_json=?3
        WHERE singleton_id=1
      `).run(input.outcome, input.occurredAt, JSON.stringify(input.detail));
      const targets = this.listRuntimePauseTargets(input.epoch);
      this.appendRuntimeGlobalEvent({
        eventId: input.eventId,
        eventType: input.outcome === 'PAUSED'
          ? 'SchedulerGlobalPaused' : 'SchedulerGlobalControlRecoveryRequired',
        aggregateVersion: input.epoch,
        commandId: input.commandId,
        actor: input.actor,
        occurredAt: input.occurredAt,
        payload: {
          pauseEpoch: input.epoch,
          settledAt: input.occurredAt,
          stage: 'PAUSE',
          detail: input.detail,
          targets: targets.map(runtimePauseTargetFact),
        },
      });
      return { control: this.getRuntimePauseControl(), targets, replayed: false };
    })();
  }

  /**
   * Entering `RESUMING` for one epoch (ADR-0061 D06 step 1). Only `PAUSED` and a disposible
   * `RECOVERY_REQUIRED` may get here; the caller decides that from the control row it read, and this
   * write records the transition and its request event.
   */
  beginRuntimeGlobalResume(input: {
    readonly epoch: number;
    readonly actor: string;
    readonly commandId: string;
    readonly eventId: string;
    readonly occurredAt: number;
  }): RuntimeGlobalControlWrite {
    return this.sqlite.transaction(() => {
      this.sqlite.query(`
        UPDATE runtime_pause_control SET state='RESUMING',version=version+1,settled_at=NULL,
          detail_json=?1 WHERE singleton_id=1
      `).run(JSON.stringify({ stage: 'RESUME', requestedBy: input.actor }));
      const targets = this.listRuntimePauseTargets(input.epoch);
      this.appendRuntimeGlobalEvent({
        eventId: input.eventId,
        eventType: 'SchedulerGlobalResumeRequested',
        aggregateVersion: input.epoch,
        commandId: input.commandId,
        actor: input.actor,
        occurredAt: input.occurredAt,
        payload: { pauseEpoch: input.epoch, actor: input.actor, targetCount: targets.length },
      });
      return { control: this.getRuntimePauseControl(), targets, replayed: false };
    })();
  }

  /**
   * Settles a resume: `RUNNING` only when every target was verified resumed or provably exited,
   * otherwise `RECOVERY_REQUIRED` — never a global `RUNNING` over targets that are still stopped or
   * unverifiable, because that would silently drop the barrier the user asked for.
   */
  settleRuntimeGlobalResume(input: {
    readonly epoch: number;
    readonly outcome: 'RUNNING' | 'RECOVERY_REQUIRED';
    readonly detail: unknown;
    readonly targetUpdates: readonly RuntimePauseTargetUpdate[];
    /** The command that caused this settlement, for the event's correlation only. */
    readonly commandId: string;
    readonly actor: string;
    readonly eventId: string;
    readonly occurredAt: number;
  }): RuntimeGlobalControlWrite {
    return this.sqlite.transaction(() => {
      this.applyRuntimePauseTargetUpdates(input.targetUpdates, input.occurredAt);
      this.sqlite.query(`
        UPDATE runtime_pause_control SET state=?1,version=version+1,settled_at=?2,detail_json=?3
        WHERE singleton_id=1
      `).run(input.outcome, input.occurredAt, JSON.stringify(input.detail));
      const targets = this.listRuntimePauseTargets(input.epoch);
      this.appendRuntimeGlobalEvent({
        eventId: input.eventId,
        eventType: input.outcome === 'RUNNING'
          ? 'SchedulerGlobalResumed' : 'SchedulerGlobalControlRecoveryRequired',
        aggregateVersion: input.epoch,
        commandId: input.commandId,
        actor: input.actor,
        occurredAt: input.occurredAt,
        payload: {
          pauseEpoch: input.epoch,
          settledAt: input.occurredAt,
          stage: 'RESUME',
          detail: input.detail,
          targets: targets.map(runtimePauseTargetFact),
        },
      });
      return { control: this.getRuntimePauseControl(), targets, replayed: false };
    })();
  }

  /**
   * `scheduler control reconcile`: records what was **observed** and closes the targets that are
   * provably gone. It sends no signal, and it never turns an unverifiable target into a stopped one.
   * When the state is `PAUSING` and every target has now resolved, the epoch is settled to the state
   * those observations prove; from `RECOVERY_REQUIRED` the barrier stays up, because dropping it
   * would be exactly the "assume it worked" the design forbids.
   */
  recordRuntimeGlobalReconcile(input: {
    readonly epoch: number;
    readonly targetUpdates: readonly RuntimePauseTargetUpdate[];
    readonly outcome: 'UNCHANGED' | 'PAUSED' | 'RECOVERY_REQUIRED';
    readonly detail: unknown;
    readonly actor: string;
    /**
     * Whether this reconcile recorded a fact worth an event. A read-only pass that changed nothing must
     * not write `SchedulerGlobalControlRecoveryRequired` — that event says a target needs attention,
     * and emitting it for a quiet observation would be a false statement (ADR-0061 D10: only facts
     * that happened are written).
     */
    readonly recordEvent: boolean;
    readonly eventId: string;
    readonly occurredAt: number;
  }): RuntimeGlobalControlWrite {
    return this.sqlite.transaction(() => {
      this.applyRuntimePauseTargetUpdates(input.targetUpdates, input.occurredAt);
      const current = this.getRuntimePauseControl();
      let state = current.state;
      if (input.outcome === 'PAUSED' && current.state === 'PAUSING') state = 'PAUSED';
      if (input.outcome === 'RECOVERY_REQUIRED' && current.state === 'PAUSING') {
        state = 'RECOVERY_REQUIRED';
      }
      this.sqlite.query(`
        UPDATE runtime_pause_control SET state=?1,version=version+1,settled_at=?2,detail_json=?3
        WHERE singleton_id=1
      `).run(state, state === current.state ? current.settledAt : input.occurredAt,
        JSON.stringify(input.detail));
      const targets = this.listRuntimePauseTargets(input.epoch);
      if (input.recordEvent) {
        this.appendRuntimeGlobalEvent({
          eventId: input.eventId,
          eventType: 'SchedulerGlobalControlRecoveryRequired',
          aggregateVersion: input.epoch,
          commandId: input.actor,
          actor: input.actor,
          occurredAt: input.occurredAt,
          payload: {
            pauseEpoch: input.epoch,
            stage: 'STARTUP_RECONCILE',
            reasonCode: input.outcome,
            state,
            targets: targets.map(runtimePauseTargetFact),
          },
        });
      }
      return { control: this.getRuntimePauseControl(), targets, replayed: false };
    })();
  }

  /**
   * The `pause`/`resume` receipt on its own, for the paths that settle by recording a fact instead
   * of a state change (an idempotent command that finds the target state already reached).
   */
  writeRuntimeCommandReceipt(input: RuntimeCommandReceiptInput, at: number): void {
    const existing = this.sqlite.query<{ payload_hash: string }, [string]>(
      'SELECT payload_hash FROM runtime_command_receipts WHERE command_id=?1').get(input.commandId);
    if (existing !== null && existing !== undefined) {
      if (existing.payload_hash !== input.payloadHash) {
        throw new StorageError('COMMAND_CONFLICT',
          'Command ID was already used with a different payload');
      }
      return;
    }
    this.sqlite.query(`
      INSERT INTO runtime_command_receipts(command_id,payload_hash,result_json,created_at)
      VALUES (?1,?2,?3,?4)
    `).run(input.commandId, input.payloadHash, JSON.stringify(input.result), at);
  }

  private applyRuntimePauseTargetUpdates(
    updates: readonly RuntimePauseTargetUpdate[],
    at: number,
  ): void {
    const statement = this.sqlite.query(`
      UPDATE runtime_pause_targets SET state=?1,observation_json=?2,updated_at=?3 WHERE id=?4
    `);
    for (const update of updates) {
      statement.run(update.state, JSON.stringify(update.observation), at, update.targetId);
    }
  }

  /**
   * A Runtime-global event: `project_id = NULL` is the whole point (ADR-0061 D10). It is written
   * through the same `domain_events` log so a Project-filtered subscriber receives it and its cursor
   * keeps advancing by the one shared sequence.
   */
  private appendRuntimeGlobalEvent(input: {
    readonly eventId: string;
    readonly eventType: SchedulerGlobalEventType;
    readonly aggregateVersion: number;
    readonly commandId: string;
    readonly actor: string;
    readonly occurredAt: number;
    readonly payload: Readonly<Record<string, unknown>>;
  }): void {
    this.sqlite.query(`
      INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
        aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
      VALUES (?1,NULL,?2,1,?3,'runtime-global-control',?4,?5,NULL,?6,?7)
    `).run(input.eventId, input.eventType, schedulerGlobalAggregateType, input.aggregateVersion,
      input.commandId, input.occurredAt, JSON.stringify(input.payload));
  }

  /**
   * Every active provider incarnation this Runtime must consider when it builds a pause target list
   * (ADR-0061 D05 step 1). It is the same read the startup Session/Execution convergence uses — a
   * Session whose projection still claims a running provider — so a Session that already converged to
   * `RECOVERY_REQUIRED` is not frozen again on the next pause.
   *
   * It is a read: it signals nothing and decides nothing.
   */
  listActiveProviderIncarnations(): readonly ActiveProviderIncarnation[] {
    const incarnations: ActiveProviderIncarnation[] = [];
    for (const session of this.listStaleAgentSessions()) {
      const incarnation = session.incarnation;
      if (incarnation === null || incarnation.providerPid === null) continue;
      incarnations.push({
        projectId: session.projectId,
        taskId: session.taskId,
        executionId: session.executionId,
        sessionId: session.sessionId,
        incarnationId: incarnation.id,
        adapterId: session.adapterId,
        providerPid: incarnation.providerPid,
        processIdentity: incarnation.processIdentity,
        processTree: incarnation.processTree,
      });
    }
    return Object.freeze(incarnations);
  }
}

/**
 * Runtime global load-control records (FOUNDATION-097 / ADR-0061 D10, schema v34).
 *
 * `observation` is deliberately `unknown` here: this layer stores and returns the facts the Runtime
 * control service recorded, and the contract that gives them shape (`RuntimePauseTargetObservation`)
 * lives in `@codeestra/contracts`. Storage validating a projection it does not own would create a
 * second definition of the same fact.
 */
export interface RuntimePauseControlRecord {
  readonly state: RuntimeGlobalControlState;
  readonly pauseEpoch: number;
  readonly version: number;
  readonly requestedAt: number | null;
  readonly requestedBy: string | null;
  readonly settledAt: number | null;
  readonly detail: unknown;
}

export type RuntimePauseTargetState = 'PENDING' | 'STOPPED' | 'RESUMED' | 'EXITED'
  | 'RECOVERY_REQUIRED';

export interface RuntimePauseTargetRecord {
  readonly id: string;
  readonly pauseEpoch: number;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly incarnationId: string;
  readonly providerPid: number;
  readonly providerStartToken: string;
  readonly state: RuntimePauseTargetState;
  readonly observation: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** One target as the barrier is committed. The identity snapshot is taken by the caller. */
export interface RuntimePauseTargetInput {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly incarnationId: string;
  readonly providerPid: number;
  readonly providerStartToken: string;
  readonly observation: unknown;
}

/** One target's observed outcome, applied by the settling write. */
export interface RuntimePauseTargetUpdate {
  readonly targetId: string;
  readonly state: RuntimePauseTargetState;
  readonly observation: unknown;
}

export interface RuntimeCommandReceiptRecord {
  readonly commandId: string;
  readonly payloadHash: string;
  readonly result: unknown;
  readonly createdAt: number;
}

export interface RuntimeCommandReceiptInput {
  readonly commandId: string;
  readonly payloadHash: string;
  readonly actor: string;
  readonly result: unknown;
}

export interface RuntimeGlobalControlWrite {
  readonly control: RuntimePauseControlRecord;
  readonly targets: readonly RuntimePauseTargetRecord[];
  readonly replayed: boolean;
}

/**
 * One active provider incarnation as the control service sees it before any signal is sent: which
 * Session/Execution/Task it belongs to, which Adapter declares it, and the recorded process identity
 * that must be re-verified against the live process table.
 */
export interface ActiveProviderIncarnation {
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly incarnationId: string;
  readonly adapterId: string;
  readonly providerPid: number;
  readonly processIdentity: unknown;
  readonly processTree: unknown;
}

interface RuntimePauseTargetRow {
  id: string; pause_epoch: number; project_id: string; task_id: string; execution_id: string;
  session_id: string; incarnation_id: string; provider_pid: number;
  provider_start_token: string; state: RuntimePauseTargetState; observation_json: string;
  created_at: number; updated_at: number;
}

function mapRuntimePauseTargetRow(row: RuntimePauseTargetRow): RuntimePauseTargetRecord {
  return {
    id: row.id,
    pauseEpoch: row.pause_epoch,
    projectId: row.project_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    sessionId: row.session_id,
    incarnationId: row.incarnation_id,
    providerPid: row.provider_pid,
    providerStartToken: row.provider_start_token,
    state: row.state,
    observation: JSON.parse(row.observation_json) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The per-target facts a global control event carries. Identity and outcome only: the payload never
 * contains provider output, a prompt or anything else a user wrote (ADR-0061 D10).
 */
function runtimePauseTargetFact(target: RuntimePauseTargetRecord): Readonly<Record<string, unknown>> {
  return {
    projectId: target.projectId,
    taskId: target.taskId,
    executionId: target.executionId,
    sessionId: target.sessionId,
    incarnationId: target.incarnationId,
    providerPid: target.providerPid,
    providerStartToken: target.providerStartToken,
    state: target.state,
    observation: target.observation,
  };
}

/**
 * The scheduling engine's own event names. E2's `ExecutionSlot*` and `SchedulerCapacityChanged` are
 * deliberately not reused or renamed: a reservation and a scheduling decision are different facts.
 */
export const taskScheduleEventTypes = [
  'TaskScheduleDecided',
  'TaskWaitingForConflict',
  'TaskWaitingForCapacity',
  'TaskUnknownCleared',
  'TaskImpactPredictionRevoked',
] as const;

export type TaskScheduleEventType = typeof taskScheduleEventTypes[number];

/** One reservation as the shared projection every read returns. */
export type ExecutionSlotReservationRecord = SlotReservationView;
export type SlotReservationDetail = SlotReservationDetailView;

/** Hard ceiling for one `scheduler reservations list`, so a read stays bounded. */
export const maxSlotReservationReadLimit = 200;

interface SlotReservationRow {
  readonly id: string; readonly project_id: string; readonly task_id: string;
  readonly task_display_number: number; readonly revision_id: string; readonly task_version: number;
  readonly adapter_id: string; readonly workspace_id: string | null;
  readonly impact_snapshot_id: string | null; readonly dependency_fingerprint: string;
  readonly assessed_dev_commit: string | null; readonly state: SlotReservationState;
  readonly version: number; readonly command_id: string; readonly holder_boot_id: string;
  readonly holder_pid: number; readonly holder_start_token: string | null;
  readonly holder_actor: string; readonly reserved_at: number; readonly updated_at: number;
  readonly released_at: number | null; readonly release_reason: string | null;
  readonly release_kind: SlotReservationReleaseKind | null;
  readonly release_observation: SlotHolderObservationKind | null; readonly detail: string | null;
}

const slotReservationSelect = `
  SELECT reservation.id,reservation.project_id,reservation.task_id,
    task.display_number AS task_display_number,reservation.revision_id,reservation.task_version,
    reservation.adapter_id,reservation.workspace_id,reservation.impact_snapshot_id,
    reservation.dependency_fingerprint,reservation.assessed_dev_commit,reservation.state,
    reservation.version,reservation.command_id,reservation.holder_boot_id,reservation.holder_pid,
    reservation.holder_start_token,reservation.holder_actor,reservation.reserved_at,
    reservation.updated_at,reservation.released_at,reservation.release_reason,
    reservation.release_kind,reservation.release_observation,reservation.detail
  FROM execution_slot_reservations reservation
  JOIN tasks task ON task.id=reservation.task_id
`;

function mapSlotReservationRow(row: SlotReservationRow): ExecutionSlotReservationRecord {
  return {
    reservationId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    taskDisplayNumber: row.task_display_number,
    revisionId: row.revision_id,
    taskVersion: row.task_version,
    adapterId: row.adapter_id,
    workspaceId: row.workspace_id,
    impactSnapshotId: row.impact_snapshot_id,
    dependencyFingerprint: row.dependency_fingerprint,
    assessedDevCommit: row.assessed_dev_commit,
    state: row.state,
    version: row.version,
    commandId: row.command_id,
    holder: {
      bootId: row.holder_boot_id,
      pid: row.holder_pid,
      startToken: row.holder_start_token,
      actor: row.holder_actor,
    },
    reservedAt: row.reserved_at,
    updatedAt: row.updated_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    releaseKind: row.release_kind,
    releaseObservation: row.release_observation,
    detail: row.detail,
  };
}

/**
 * The six-component generation of a stored snapshot row. Building it here (rather than rehydrating the
 * whole snapshot) keeps the reservation recheck independent of the fields the reuse key does not
 * contain — a snapshot's `complete` flag or evidence cannot make it current.
 */
function slotSnapshotGenerationFromRow(row: ImpactSnapshotRow): ImpactSnapshotGeneration {
  return {
    taskId: row.task_id,
    revisionId: row.revision_id,
    baseCommit: row.base_commit,
    analyzerVersion: row.analyzer_version,
    policyVersion: row.policy_version,
    changeFingerprint: row.change_fingerprint,
    caseMode: row.case_mode,
    files: JSON.parse(row.files_json) as readonly string[],
  };
}

/**
 * A refusal the generation judgment cannot express: the *shape* of the observation no longer matches
 * the Task (the worktree it was made in is gone, or one appeared where the prediction assumed none).
 * It reports the same facts as {@link slotSnapshotGenerationRecheck} — the recorded generation, the
 * observed one, and which component moved — so a caller reads one shape either way.
 */
function slotSnapshotStaleRefusal(input: {
  readonly row: ImpactSnapshotRow;
  readonly taskId: string;
  readonly currentRevisionId: string;
  readonly reasonCodes: readonly string[];
  readonly differing: readonly string[];
  readonly observedBaseCommit: string | null;
  readonly observedPolicyVersion: string;
  readonly observedAnalyzerVersion: string;
  readonly observedChangeFingerprint: string | null;
  readonly observedPathCount: number;
  readonly detail: string;
}): SlotReservationError {
  const files = JSON.parse(input.row.files_json) as readonly string[];
  return new SlotReservationError('SNAPSHOT_STALE', `${input.detail}; nothing was reserved`, {
    code: 'SNAPSHOT_STALE',
    snapshotId: input.row.id,
    taskId: input.taskId,
    reasonCodes: input.reasonCodes,
    differing: input.differing,
    assessed: { taskId: input.row.task_id, revisionId: input.row.revision_id,
      baseCommit: input.row.base_commit, analyzerVersion: input.row.analyzer_version,
      policyVersion: input.row.policy_version, changeFingerprint: input.row.change_fingerprint,
      pathCount: files.length },
    observed: { taskId: input.taskId, revisionId: input.currentRevisionId,
      baseCommit: input.observedBaseCommit, analyzerVersion: input.observedAnalyzerVersion,
      policyVersion: input.observedPolicyVersion,
      changeFingerprint: input.observedChangeFingerprint,
      pathCount: input.observedPathCount },
  });
}

/**
 * Applies the analyzer's own generation judgment to a stored row, with the facts the reservation
 * transaction re-read (`currentRevisionId`, the live worktree baseline) and the facts the caller
 * observed from Git (the change set, the mapping version, the analyzer version).
 *
 * The change-set comparison is the *exact path set*, which is how E1 itself decides reuse; the
 * fingerprint is carried as evidence only. A fingerprint also covers file contents and `HEAD`, so
 * requiring it to be equal would refuse a snapshot the analyzer still considers current — a Task
 * whose diff changed only in content would never be reservable.
 */
function slotSnapshotGenerationRecheck(input: {
  readonly row: ImpactSnapshotRow;
  readonly currentRevisionId: string;
  readonly baseCommit: string;
  readonly files: readonly string[];
  readonly policyVersion: string;
  readonly analyzerVersion: string;
  readonly changeFingerprint: string | null;
}): ImpactSnapshotRecheck {
  return recheckImpactSnapshotGeneration({
    generation: slotSnapshotGenerationFromRow(input.row),
    observedFiles: input.files,
    context: {
      baseCommit: input.baseCommit,
      policyVersion: input.policyVersion,
      analyzerVersion: input.analyzerVersion,
    },
    currentRevisionId: input.currentRevisionId,
    observedChangeFingerprint: input.changeFingerprint,
  });
}

/**
 * A fingerprint of the dependency facts of one Task, recomputed inside the reservation transaction
 * and compared with the value the caller assessed. It covers the whole edge, including the recorded
 * integration fact the satisfaction verdict was derived from, so an upstream integration that lands
 * between the Git check and this write is refused instead of being reserved against a stale read.
 */
export function slotDependencyFingerprint(facts: readonly TaskDependencyFact[]): string {
  const canonical = [...facts]
    .map((fact) => ({
      prerequisiteTaskId: fact.prerequisiteTaskId,
      requiredRevisionId: fact.requiredRevisionId,
      integratedCommit: fact.integratedCommit,
      integrationBatchId: fact.integrationBatchId,
    }))
    .sort((left, right) => (left.prerequisiteTaskId < right.prerequisiteTaskId ? -1
      : left.prerequisiteTaskId > right.prerequisiteTaskId ? 1 : 0));
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

/**
 * The real occupants of the Runtime's slots, per Task (ADR-0061 D01).
 *
 * Two sources are unioned across the whole Runtime — every Project's active reservation (this
 * primitive) and every Execution that still holds its workspace (`resource_held=1`, the
 * pre-reservation `task.run` path). Union rather than sum keeps a reserved Task that then starts
 * exactly one slot, and counting across Projects is what makes the limit a real total: a candidate's
 * Project and Adapter no longer narrow anything, and Task ids are globally unique, so the union key is
 * unambiguous.
 */
function countSlotOccupants(database: Database, input: {
  readonly excludeTaskId?: string;
}): SlotOccupancy {
  const rows = database.query<{
    task_id: string; project_id: string; adapter_id: string; reservation_id: string | null;
    state: SlotReservationState | null; since_at: number; source: 'RESERVATION' | 'EXECUTION';
  }, [string]>(`
    SELECT task_id,project_id,adapter_id,reservation_id,state,since_at,source FROM (
      SELECT task_id,project_id,adapter_id,id AS reservation_id,state,reserved_at AS since_at,
        'RESERVATION' AS source FROM execution_slot_reservations
        WHERE state IN ('RESERVED','RECOVERY_REQUIRED')
      UNION
      SELECT execution.task_id AS task_id,task.project_id AS project_id,
        execution.adapter_id AS adapter_id,NULL AS reservation_id,NULL AS state,
        COALESCE(execution.started_at,0) AS since_at,'EXECUTION' AS source
        FROM executions execution JOIN tasks task ON task.id=execution.task_id
        WHERE execution.resource_held=1
    ) WHERE task_id<>?1
  `).all(input.excludeTaskId ?? '');
  interface MutableOccupant {
    taskId: string;
    projectId: string;
    adapterIds: Set<string>;
    reservationId: string | null;
    state: SlotReservationState | null;
    since: number;
    source: 'RESERVATION' | 'EXECUTION';
  }
  const byTask = new Map<string, MutableOccupant>();
  for (const row of rows) {
    const existing = byTask.get(row.task_id);
    if (existing === undefined) {
      byTask.set(row.task_id, {
        taskId: row.task_id,
        projectId: row.project_id,
        adapterIds: new Set([row.adapter_id]),
        reservationId: row.reservation_id,
        state: row.state,
        since: row.since_at,
        source: row.source,
      });
      continue;
    }
    existing.adapterIds.add(row.adapter_id);
    // A reservation is the stronger fact: it is what the scheduler holds, and it carries the slot
    // identity, so it wins over the Execution row for the same Task.
    if (existing.reservationId === null && row.reservation_id !== null) {
      existing.reservationId = row.reservation_id;
      existing.state = row.state;
      existing.since = row.since_at;
      existing.source = row.source;
    }
  }
  const occupants = [...byTask.values()].sort((left, right) => (left.taskId < right.taskId ? -1 : 1));
  const globalBlocking = occupants.map((occupant) => occupant.taskId);
  return {
    globalUsed: globalBlocking.length,
    globalBlocking,
    occupants: occupants.map((occupant) => ({
      taskId: occupant.taskId,
      projectId: occupant.projectId,
      adapterIds: [...occupant.adapterIds].sort(),
      reservationId: occupant.reservationId,
      state: occupant.state,
      since: occupant.since,
      source: occupant.source,
    })),
  };
}

/** Appends one reservation history row; the sequence is allocated inside the caller's transaction. */
function insertSlotReservationEvent(database: Database, input: {
  readonly reservationId: string;
  readonly kind: SlotReservationEventKind;
  readonly domainEventId: string | null;
  readonly commandId: string;
  readonly actor: string;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly occurredAt: number;
}): void {
  database.query(`
    INSERT INTO execution_slot_reservation_events(reservation_id,sequence,kind,domain_event_id,
      command_id,actor,detail,evidence_json,occurred_at)
    VALUES (?1,(SELECT COALESCE(MAX(sequence),0)+1 FROM execution_slot_reservation_events
      WHERE reservation_id=?1),?2,?3,?4,?5,?6,?7,?8)
  `).run(input.reservationId, input.kind, input.domainEventId, input.commandId, input.actor,
    input.detail, JSON.stringify(input.evidence), input.occurredAt);
}

/* ---------------------------------------------------------------------------------------------
 * Session-handoff / native-terminal domain events (FOUNDATION-063, ADR-0035).
 *
 * The seven events are appended by the same storage methods that perform the state change they
 * observe, inside that method's transaction, so the log cannot disagree with the state. Six of them
 * ride an existing writer (`recordSessionHandoffRequest`, the two safe-point writers,
 * `beginSessionHandoff`, `markSessionHandoffAdmitted`, the writer-lease writers); `TakeoverFailed` is
 * the one fact with no state change of its own and therefore has its own writer.
 * ------------------------------------------------------------------------------------------- */

const sessionHandoffAggregateType = 'SessionHandoff';
const sessionWriterLeaseAggregateType = 'SessionWriterLease';

/**
 * The contract schema of each event. It is applied on the write path, so a producer cannot store a
 * payload shape the contract does not describe (the same fail-closed rule the Runtime boundary
 * applies to commands).
 */
const sessionHandoffPayloadSchemas: Record<SessionHandoffEventType, { parse(value: unknown): unknown }> = {
  TakeoverRequested: takeoverRequestedPayloadSchema,
  TakeoverSafePointReached: takeoverSafePointReachedPayloadSchema,
  SessionHandoffStarted: sessionHandoffStartedPayloadSchema,
  SessionHandoffCompleted: sessionHandoffCompletedPayloadSchema,
  TerminalWriterLeaseChanged: terminalWriterLeaseChangedPayloadSchema,
  TakeoverReleased: takeoverReleasedPayloadSchema,
  TakeoverFailed: takeoverFailedPayloadSchema,
};

/** One end of a writer-lease change, as stored in a `TerminalWriterLeaseChanged` payload. */
interface SessionWriterLeaseHolderFact {
  readonly incarnationId: string;
  readonly holderKind: SessionWriterLeaseRecord['holderKind'];
  readonly holderRef: string;
}

const sessionTerminalSelect = `
  SELECT id,session_id,incarnation_id,helper_pid,helper_start_token,provider_pid,pty_slave,
    window_size,state,release_command_id,release_requested_at,release_byte,
    provider_shutdown_reported_at,exit_code,exit_signal,exit_reported_at,session_file,
    entries_at_start,last_entry_id_at_start,entries_at_release,last_entry_id_at_release,
    release_detail,created_at,ended_at
  FROM session_terminals
`;

interface KnowledgeSnapshotRow {
  id: string; project_id: string; main_ref: string; main_commit: string; policy_version: string;
  snapshot_digest: string; human_digest: string; generated_digest: string; entry_count: number;
  human_entry_count: number; generated_entry_count: number; total_bytes: number;
  entries_json: string; created_by: string; created_at: number;
}

const knowledgeSnapshotSelect = `
  SELECT id,project_id,main_ref,main_commit,policy_version,snapshot_digest,human_digest,
    generated_digest,entry_count,human_entry_count,generated_entry_count,total_bytes,entries_json,
    created_by,created_at
  FROM knowledge_snapshots
`;

function mapKnowledgeSnapshotRow(row: KnowledgeSnapshotRow): KnowledgeSnapshotRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    mainRef: row.main_ref,
    mainCommit: row.main_commit,
    policyVersion: row.policy_version,
    snapshotDigest: row.snapshot_digest,
    humanDigest: row.human_digest,
    generatedDigest: row.generated_digest,
    entryCount: row.entry_count,
    humanEntryCount: row.human_entry_count,
    generatedEntryCount: row.generated_entry_count,
    totalBytes: row.total_bytes,
    entries: JSON.parse(row.entries_json) as readonly StoredKnowledgeEntry[],
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

interface ExecutionKnowledgeSnapshotRow {
  execution_id: string; project_id: string; task_id: string; snapshot_id: string;
  snapshot_digest: string; context_path: string; context_digest: string; context_bytes: number;
  entry_count: number; refs_json: string; command_id: string; created_at: number;
}

function mapExecutionKnowledgeSnapshotRow(
  row: ExecutionKnowledgeSnapshotRow,
): ExecutionKnowledgeSnapshotRecord {
  return {
    executionId: row.execution_id,
    projectId: row.project_id,
    taskId: row.task_id,
    snapshotId: row.snapshot_id,
    snapshotDigest: row.snapshot_digest,
    contextPath: row.context_path,
    contextDigest: row.context_digest,
    contextBytes: row.context_bytes,
    entryCount: row.entry_count,
    refs: JSON.parse(row.refs_json) as readonly string[],
    commandId: row.command_id,
    createdAt: row.created_at,
  };
}

interface ImpactSnapshotRow {
  id: string; project_id: string; task_id: string; revision_id: string; base_commit: string;
  analyzer_version: string; policy_version: string; policy_digest: string;
  case_mode: 'SENSITIVE' | 'INSENSITIVE'; change_fingerprint: string; complete: number;
  incomplete_reasons_json: string; files_json: string; important_directories_json: string;
  modules_json: string; global_resources_json: string; unclassified_files_json: string;
  evidence_json: string; created_at: number;
}

const impactSnapshotSelect = `
  SELECT id,project_id,task_id,revision_id,base_commit,analyzer_version,policy_version,
    policy_digest,case_mode,change_fingerprint,complete,incomplete_reasons_json,files_json,
    important_directories_json,modules_json,global_resources_json,unclassified_files_json,
    evidence_json,created_at
  FROM impact_snapshots
`;

function mapImpactSnapshotRow(row: ImpactSnapshotRow): ImpactSnapshotRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    revisionId: row.revision_id,
    baseCommit: row.base_commit,
    analyzerVersion: row.analyzer_version,
    policyVersion: row.policy_version,
    policyDigest: row.policy_digest,
    caseMode: row.case_mode,
    changeFingerprint: row.change_fingerprint,
    complete: row.complete === 1,
    incompleteReasons: JSON.parse(row.incomplete_reasons_json) as readonly string[],
    files: JSON.parse(row.files_json) as readonly string[],
    importantDirectories: JSON.parse(row.important_directories_json) as readonly string[],
    modules: JSON.parse(row.modules_json) as readonly string[],
    globalResources: JSON.parse(row.global_resources_json) as readonly StoredImpactResourceRef[],
    unclassifiedFiles: JSON.parse(row.unclassified_files_json) as readonly string[],
    evidence: JSON.parse(row.evidence_json) as readonly string[],
    createdAt: row.created_at,
  };
}

interface ImpactAssessmentRow {
  id: string; project_id: string; candidate_task_id: string; candidate_revision_id: string;
  candidate_snapshot_id: string; other_task_id: string; other_revision_id: string;
  other_snapshot_id: string; verdict: 'SAFE_TO_PARALLELIZE' | 'UNKNOWN' | 'CONFLICTING';
  reason_codes_json: string; hits_json: string; evidence_json: string; created_at: number;
}

const impactAssessmentSelect = `
  SELECT id,project_id,candidate_task_id,candidate_revision_id,candidate_snapshot_id,other_task_id,
    other_revision_id,other_snapshot_id,verdict,reason_codes_json,hits_json,evidence_json,created_at
  FROM impact_assessments
`;

function mapImpactAssessmentRow(row: ImpactAssessmentRow): ImpactAssessmentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    candidateTaskId: row.candidate_task_id,
    candidateRevisionId: row.candidate_revision_id,
    candidateSnapshotId: row.candidate_snapshot_id,
    otherTaskId: row.other_task_id,
    otherRevisionId: row.other_revision_id,
    otherSnapshotId: row.other_snapshot_id,
    verdict: row.verdict,
    reasonCodes: JSON.parse(row.reason_codes_json) as readonly string[],
    hits: JSON.parse(row.hits_json) as readonly unknown[],
    evidence: JSON.parse(row.evidence_json) as readonly string[],
    createdAt: row.created_at,
  };
}

export type TaskRevisionDeliveryState = RevisionDeliveryState;
export type TaskRevisionDeliveryChannel = RevisionDeliveryChannel;

/** One immutable Task revision as `task revision list` reads it. */
export interface TaskRevisionSummary {
  readonly id: string;
  readonly number: number;
  readonly previousRevisionId: string | null;
  readonly specification: string;
  readonly constraints: readonly StoredConstraint[];
  readonly reason: string;
  readonly actor: string;
  readonly createdAt: number;
  readonly current: boolean;
}

/** What creating one revision produced, including the delivery requirement it may have created. */
export interface TaskRevisionCreation {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly previousRevisionId: string;
  /** Present only when an Execution was holding the Task, so the revision must be delivered. */
  readonly deliveryId: string | null;
  readonly executionId: string | null;
  readonly sessionId: string | null;
}

export type RevisionDeliveryAttemptState = 'IN_FLIGHT' | 'ACKNOWLEDGED' | 'UNACKNOWLEDGED'
  | 'CHANNEL_UNSUPPORTED' | 'TIMED_OUT' | 'FAILED' | 'SUPERSEDED_BY_RESTART';

/** One append-only attempt record: which channel carried (or failed to carry) the revision where. */
export interface TaskRevisionDeliveryAttemptRecord {
  readonly id: string;
  readonly attemptNumber: number;
  readonly channel: TaskRevisionDeliveryChannel;
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly incarnationId: string | null;
  readonly state: RevisionDeliveryAttemptState;
  readonly evidenceRef: string | null;
  readonly errorCode: string | null;
  readonly detail: string;
  readonly deadlineAt: number | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface TaskRevisionDeliveryRecord {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly incarnationId: string | null;
  readonly state: TaskRevisionDeliveryState;
  readonly attemptCount: number;
  readonly channel: TaskRevisionDeliveryChannel | null;
  readonly deadlineAt: number | null;
  readonly evidenceRef: string | null;
  readonly detail: string | null;
  readonly supersededByExecutionId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly acknowledgedAt: number | null;
  /** True only for an acknowledgement or a verified successor Execution (see the domain FSM). */
  readonly satisfied: boolean;
  /** True when the Task has since moved on to another revision. */
  readonly stale: boolean;
  readonly attempts: readonly TaskRevisionDeliveryAttemptRecord[];
}

interface RevisionDeliveryRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly revision_id: string;
  readonly revision_number: number;
  readonly execution_id: string | null;
  readonly session_id: string | null;
  readonly incarnation_id: string | null;
  readonly state: RevisionDeliveryState;
  readonly attempt_count: number;
  readonly channel: TaskRevisionDeliveryChannel | null;
  readonly deadline_at: number | null;
  readonly evidence_ref: string | null;
  readonly detail: string | null;
  readonly superseded_by_execution_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly acknowledged_at: number | null;
  readonly version: number;
}

const revisionDeliverySelect = `
  SELECT delivery.id,delivery.project_id,delivery.task_id,delivery.revision_id,
    revision.number AS revision_number,delivery.execution_id,delivery.session_id,
    delivery.incarnation_id,delivery.state,delivery.attempt_count,delivery.channel,
    delivery.deadline_at,delivery.evidence_ref,delivery.detail,
    delivery.superseded_by_execution_id,delivery.created_at,delivery.updated_at,
    delivery.acknowledged_at,delivery.version
  FROM task_revision_deliveries delivery
  JOIN task_revisions revision ON revision.task_id=delivery.task_id
    AND revision.id=delivery.revision_id
`;

/**
 * Session Guidance (FOUNDATION-088 / ADR-0057).
 *
 * Guidance is the *other* input channel of ADR-0010 D02: it changes what the Agent is doing without
 * changing the acceptance specification. Nothing on this face writes a `task_revisions` row, moves
 * `tasks.current_revision_id`, or invalidates a verification run — `task amend` stays the only path
 * that does, and it still invalidates the old evidence.
 */

/** The source of one guidance record. Only the command face produces one today (ADR-0057). */
export type SessionGuidanceSource = 'COMMAND';

/**
 * The delivery fact of one guidance record.
 *
 * `RECORDED` means the message is durably recorded but no provider channel has accepted it yet
 * (either nothing was running when it was given, or the attempt has not concluded). `DELIVERED`
 * means the provider's own channel accepted the message — it is enqueued — which is **not** the same
 * as the model having read it, and there is deliberately no value here for "applied" (ADR-0051).
 */
export type SessionGuidanceState = 'RECORDED' | 'DELIVERED' | 'CHANNEL_UNSUPPORTED' | 'TIMED_OUT'
  | 'FAILED';

export type SessionGuidanceDeliveryState = 'IN_FLIGHT' | 'DELIVERED' | 'CHANNEL_UNSUPPORTED'
  | 'TIMED_OUT' | 'FAILED';

/** One attempt to hand a guidance record into a provider conversation. Append-only. */
export interface SessionGuidanceDeliveryAttemptRecord {
  readonly id: string;
  readonly attemptNumber: number;
  readonly channel: 'PROVIDER_CONVERSATION';
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly incarnationId: string | null;
  readonly state: SessionGuidanceDeliveryState;
  /** The Adapter's reported capability at the moment of the attempt; null when never probed. */
  readonly capability: string | null;
  readonly evidenceRef: string | null;
  readonly errorCode: string | null;
  readonly detail: string;
  readonly deadlineAt: number | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/** One durable guidance record with its attempt ledger. */
export interface SessionGuidanceRecord {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly incarnationId: string | null;
  readonly source: SessionGuidanceSource;
  /** The durable body (ADR-0010 D02). It is never written into a domain event (ADR-0010 D06). */
  readonly body: string;
  readonly bodyHash: string;
  readonly bodyBytes: number;
  readonly actor: string;
  readonly state: SessionGuidanceState;
  readonly channel: 'PROVIDER_CONVERSATION' | null;
  readonly evidenceRef: string | null;
  readonly deliveryDetail: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deliveredAt: number | null;
  readonly attempts: readonly SessionGuidanceDeliveryAttemptRecord[];
}

/** What recording one guidance message produced. */
export interface SessionGuidanceCreation {
  readonly guidance: SessionGuidanceRecord;
  readonly taskVersion: number;
  /** The open delivery attempt, when an Execution held the Task; null means nothing was running. */
  readonly attemptId: string | null;
}

/** The guidance artifact one Execution was launched with (ADR-0057). */
export interface ExecutionGuidanceContextRecord {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly guidanceIds: readonly string[];
  readonly guidanceCount: number;
  readonly contextPath: string;
  readonly contextDigest: string;
  readonly contextBytes: number;
  readonly recordedAt: number;
}

interface SessionGuidanceRow {
  id: string; project_id: string; task_id: string; execution_id: string | null;
  session_id: string | null; incarnation_id: string | null; source: SessionGuidanceSource;
  body: string; body_hash: string; body_bytes: number; actor: string; state: SessionGuidanceState;
  channel: 'PROVIDER_CONVERSATION' | null; evidence_ref: string | null;
  delivery_detail: string | null; created_at: number; updated_at: number; delivered_at: number | null;
}

interface SessionGuidanceAttemptRow {
  id: string; attempt_number: number; channel: 'PROVIDER_CONVERSATION';
  execution_id: string | null; session_id: string | null; incarnation_id: string | null;
  state: SessionGuidanceDeliveryState; capability: string | null; evidence_ref: string | null;
  error_code: string | null; detail: string; deadline_at: number | null; started_at: number;
  ended_at: number | null;
}

interface ExecutionGuidanceContextRow {
  id: string; project_id: string; task_id: string; execution_id: string; guidance_ids_json: string;
  guidance_count: number; context_path: string; context_digest: string; context_bytes: number;
  recorded_at: number;
}

/**
 * The projection of one guidance row without its attempts. Qualified on purpose: the same string is
 * used both standalone and joined onto `project_trusts`.
 */
const sessionGuidanceSelect = `
  SELECT guidance.id,guidance.project_id,guidance.task_id,guidance.execution_id,guidance.session_id,
    guidance.incarnation_id,guidance.source,guidance.body,guidance.body_hash,guidance.body_bytes,
    guidance.actor,guidance.state,guidance.channel,guidance.evidence_ref,guidance.delivery_detail,
    guidance.created_at,guidance.updated_at,guidance.delivered_at
  FROM session_guidance guidance
`;

function mapExecutionGuidanceContextRow(
  row: ExecutionGuidanceContextRow,
): ExecutionGuidanceContextRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    guidanceIds: JSON.parse(row.guidance_ids_json) as readonly string[],
    guidanceCount: row.guidance_count,
    contextPath: row.context_path,
    contextDigest: row.context_digest,
    contextBytes: row.context_bytes,
    recordedAt: row.recorded_at,
  };
}

/** What a startup check can honestly say about the provider process of a stale Session. */
export type StaleSessionObservation = 'PROVIDER_STOPPED' | 'PROVIDER_STILL_RUNNING'
  | 'PROVIDER_DESCENDANTS_ALIVE' | 'PROVIDER_OWNERSHIP_UNVERIFIABLE' | 'PROCESS_IDENTITY_MISSING';

/** One Session whose projection still claims a running provider, with its recorded owner evidence. */
export interface StaleAgentSessionRecord {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskState: TaskLifecycleState;
  readonly taskVersion: number;
  readonly executionId: string;
  readonly executionState: ExecutionLifecycleState;
  readonly executionVersion: number;
  readonly workspaceId: string;
  readonly workspaceState: WorkspaceLifecycleState;
  readonly sessionId: string;
  readonly sessionState: AgentSessionLifecycleState;
  readonly sessionVersion: number;
  readonly adapterId: string;
  readonly currentIncarnationId: string | null;
  readonly incarnation: {
    readonly id: string;
    readonly incarnationNumber: number;
    readonly state: SessionIncarnationState;
    readonly providerPid: number | null;
    readonly processIdentity: unknown;
    readonly processTree: unknown;
    readonly createdAt: number;
  } | null;
  readonly writerLease: {
    readonly id: string;
    readonly holderKind: string;
    readonly holderRef: string;
  } | null;
}

/** The outcome of converging one stale projection: the states it had and the states it now has. */
export interface StaleAgentSessionConvergence {
  readonly converted: boolean;
  readonly reason: 'CONVERGED' | 'ALREADY_CONVERGED';
  readonly sessionId: string;
  readonly executionId: string;
  readonly previousSessionState: AgentSessionLifecycleState;
  readonly previousExecutionState: ExecutionLifecycleState;
  readonly projectedSessionState: AgentSessionLifecycleState;
  readonly projectedExecutionState: ExecutionLifecycleState;
}

/** The append-only audit row of one startup convergence, including the observed ownership fact. */
export interface AgentSessionStartupReconciliationRecord {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly incarnationId: string | null;
  readonly previousSessionState: AgentSessionLifecycleState;
  readonly previousExecutionState: ExecutionLifecycleState;
  readonly projectedSessionState: AgentSessionLifecycleState;
  readonly projectedExecutionState: ExecutionLifecycleState;
  readonly observation: StaleSessionObservation;
  readonly providerPid: number | null;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly commandId: string;
  readonly recordedAt: number;
}

/**
 * The facts `task.recover` observes before it may change anything (ADR-0055). Every field is read from
 * the ledger; nothing here is derived, and the process facts are re-checked against the real process
 * table by the caller rather than trusted.
 */
export interface TaskRecoverySubject {
  readonly projectId: string;
  readonly taskId: string;
  readonly displayNumber: number;
  readonly taskState: TaskLifecycleState;
  readonly taskVersion: number;
  readonly archived: boolean;
  readonly executionId: string;
  readonly executionState: ExecutionLifecycleState;
  readonly executionResourceHeld: boolean;
  readonly executionVersion: number;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly workspaceState: WorkspaceLifecycleState;
  readonly sessionId: string | null;
  readonly sessionState: AgentSessionLifecycleState | null;
  readonly sessionVersion: number | null;
  /** The Session-level provider identity, which exists even when no incarnation row was kept. */
  readonly sessionProcessIdentity: unknown;
  readonly incarnationId: string | null;
  readonly incarnationProcessIdentity: unknown;
  /** The descendant snapshot taken while the provider was alive; absent means orphans cannot be
   * attributed at all, which is recorded as `descendantRecord: 'MISSING'` rather than assumed empty. */
  readonly incarnationProcessTree: unknown;
}

/** The stored answer of one recovery reconcile, so a replayed command returns the first one. */
export interface TaskRecoveryOutcome {
  readonly outcome: 'RECONCILED';
  readonly taskId: string;
  readonly displayNumber: number;
  readonly previousTaskState: 'RECOVERY_REQUIRED';
  readonly taskState: 'FAILED';
  readonly taskVersion: number;
  readonly executionId: string;
  readonly sessionId: string | null;
  readonly providerPid: number | null;
}

/**
 * One `domain_events` row, used by the recovery reconcile path (ADR-0055). The rest of this file keeps
 * its inline inserts; this helper exists because that path writes four events that share one payload
 * shape, and spelling the same statement out four times invites them to drift apart.
 */
/**
 * The append-only tables a purge is allowed to delete from, and nothing else is (ADR-0058 D03).
 *
 * This list is also the guard's expectation: {@link Phase1Database.suspendAppendOnlyTriggers} refuses
 * to purge when one of these `_no_delete` triggers is absent, so the list cannot silently fall behind
 * a migration that renamed or dropped one. `knowledge_snapshots` is deliberately absent: it is
 * project-scoped, so a Task's deletion has no claim on it.
 */
const appendOnlyTaskTables: readonly string[] = Object.freeze([
  'task_revisions', 'impact_snapshots', 'impact_assessments', 'targeted_test_plans',
  'execution_knowledge_snapshots',
]);

/**
 * Everything one purge deletes, in an order that reads children-before-parents even though the
 * command defers foreign-key checking to commit. The order is documentation, not a correctness
 * requirement: `PRAGMA defer_foreign_keys=ON` is what makes "the whole subgraph or none of it" hold.
 *
 * The three guarded tables (`integration_batch_items`, `integration_verification_runs`,
 * `stable_promotion_members`) are absent on purpose: a Task named by one of them is refused, because
 * the commit it put into `dev`/`main` outlives it.
 */
function taskPurgeDeletions(): readonly (readonly [string, string])[] {
  const executions = 'SELECT e.id FROM executions e WHERE e.task_id=?1';
  const sessions = `SELECT s.id FROM agent_sessions s WHERE s.execution_id IN (${executions})`;
  return [
    ['adapter_events',
      `DELETE FROM adapter_events WHERE session_id IN (${sessions})`],
    ['attention_answers',
      `DELETE FROM attention_answers WHERE request_id IN (SELECT r.id FROM attention_requests r WHERE r.session_id IN (${sessions}))`],
    ['intent_attention_targets',
      `DELETE FROM intent_attention_targets WHERE attention_id IN (SELECT r.id FROM attention_requests r WHERE r.session_id IN (${sessions}))`],
    ['session_permission_requests',
      `DELETE FROM session_permission_requests WHERE session_id IN (${sessions})`],
    ['attention_requests',
      `DELETE FROM attention_requests WHERE session_id IN (${sessions})`],
    ['session_guidance_deliveries',
      'DELETE FROM session_guidance_deliveries WHERE guidance_id IN (SELECT id FROM session_guidance WHERE task_id=?1)'],
    ['session_guidance', 'DELETE FROM session_guidance WHERE task_id=?1'],
    ['execution_guidance_contexts', 'DELETE FROM execution_guidance_contexts WHERE task_id=?1'],
    ['session_writer_leases',
      `DELETE FROM session_writer_leases WHERE session_id IN (${sessions})`],
    ['session_terminal_attachments',
      `DELETE FROM session_terminal_attachments WHERE session_id IN (${sessions})`],
    ['session_terminals', `DELETE FROM session_terminals WHERE session_id IN (${sessions})`],
    ['session_handoff_requests',
      `DELETE FROM session_handoff_requests WHERE session_id IN (${sessions}) OR execution_id IN (${executions})`],
    ['task_revision_delivery_attempts',
      `DELETE FROM task_revision_delivery_attempts WHERE delivery_id IN (SELECT id FROM task_revision_deliveries WHERE task_id=?1) OR session_id IN (${sessions})`],
    ['task_revision_deliveries', 'DELETE FROM task_revision_deliveries WHERE task_id=?1'],
    ['agent_session_startup_reconciliations',
      `DELETE FROM agent_session_startup_reconciliations WHERE execution_id IN (${executions}) OR session_id IN (${sessions})`],
    ['session_incarnations',
      `DELETE FROM session_incarnations WHERE execution_id IN (${executions})`],
    ['agent_sessions', `DELETE FROM agent_sessions WHERE execution_id IN (${executions})`],
    ['execution_slot_reservation_events',
      'DELETE FROM execution_slot_reservation_events WHERE reservation_id IN (SELECT id FROM execution_slot_reservations WHERE task_id=?1)'],
    ['execution_slot_reservations', 'DELETE FROM execution_slot_reservations WHERE task_id=?1'],
    ['result_commit_authorizations', 'DELETE FROM result_commit_authorizations WHERE task_id=?1'],
    ['verification_runs', 'DELETE FROM verification_runs WHERE task_id=?1'],
    ['execution_knowledge_snapshots',
      'DELETE FROM execution_knowledge_snapshots WHERE task_id=?1'],
    ['targeted_test_plans', 'DELETE FROM targeted_test_plans WHERE task_id=?1'],
    ['impact_assessments',
      'DELETE FROM impact_assessments WHERE candidate_snapshot_id IN (SELECT id FROM impact_snapshots WHERE task_id=?1) OR other_snapshot_id IN (SELECT id FROM impact_snapshots WHERE task_id=?1)'],
    ['impact_snapshots', 'DELETE FROM impact_snapshots WHERE task_id=?1'],
    ['reclamation_records', 'DELETE FROM reclamation_records WHERE task_id=?1'],
    ['task_dependencies',
      'DELETE FROM task_dependencies WHERE prerequisite_task_id=?1 OR dependent_task_id=?1'],
    ['intent_targets', 'DELETE FROM intent_targets WHERE task_id=?1'],
    ['executions', 'DELETE FROM executions WHERE task_id=?1'],
    ['task_revisions', 'DELETE FROM task_revisions WHERE task_id=?1'],
    ['workspaces', 'DELETE FROM workspaces WHERE task_id=?1'],
  ];
}

function insertDomainEvent(database: Database, event: {
  readonly eventId: string;
  readonly projectId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly occurredAt: number;
  readonly payload: Readonly<Record<string, unknown>>;
}): void {
  database.query(`
    INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
      aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
    VALUES (?1,?2,?3,1,?4,?5,?6,?7,?8,?9,?10)
  `).run(event.eventId, event.projectId, event.eventType, event.aggregateType, event.aggregateId,
    event.aggregateVersion, event.correlationId, event.causationId, event.occurredAt,
    JSON.stringify(event.payload));
}

/**
 * The four events one recovery reconcile appends (ADR-0055 D02), in one place so the aggregate
 * versions and the causation chain between them cannot drift per call site: the observation
 * (`TaskRecoveryReconciled`) is the cause of the three state projections that follow it.
 */
function appendRecoveryEvents(database: Database, input: {
  readonly projectId: string;
  readonly subject: TaskRecoverySubject;
  readonly expectedVersion: number;
  readonly commandId: string;
  readonly actor: string;
  readonly reason: string | null;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly executionEventId: string;
  readonly sessionEventId: string;
  readonly taskEventId: string;
  readonly recoveryEventId: string;
  readonly recordedAt: number;
  readonly sessionChanged: boolean;
  readonly executionChanged: boolean;
}): void {
  const { subject } = input;
  insertDomainEvent(database, { eventId: input.recoveryEventId, projectId: input.projectId,
    eventType: 'TaskRecoveryReconciled', aggregateType: 'Task', aggregateId: subject.taskId,
    aggregateVersion: input.expectedVersion + 1, correlationId: input.commandId, causationId: null,
    occurredAt: input.recordedAt,
    payload: { taskId: subject.taskId, executionId: subject.executionId,
      sessionId: subject.sessionId, workspaceId: subject.workspaceId,
      workspacePath: subject.workspacePath, reason: input.reason, actor: input.actor,
      detail: input.detail, ...input.evidence } });
  if (input.sessionChanged && subject.sessionId !== null) {
    insertDomainEvent(database, { eventId: input.sessionEventId, projectId: input.projectId,
      eventType: 'AgentSessionStateChanged', aggregateType: 'AgentSession',
      aggregateId: subject.sessionId, aggregateVersion: (subject.sessionVersion ?? 0) + 1,
      correlationId: input.commandId, causationId: input.recoveryEventId,
      occurredAt: input.recordedAt,
      payload: { sessionId: subject.sessionId, from: subject.sessionState, to: 'EXITED',
        reason: 'recovery reconciled' } });
  }
  if (input.executionChanged) {
    insertDomainEvent(database, { eventId: input.executionEventId, projectId: input.projectId,
      eventType: 'ExecutionStateChanged', aggregateType: 'Execution',
      aggregateId: subject.executionId, aggregateVersion: subject.executionVersion + 1,
      correlationId: input.commandId, causationId: input.recoveryEventId,
      occurredAt: input.recordedAt,
      payload: { executionId: subject.executionId, from: subject.executionState, to: 'FAILED',
        reason: 'RECOVERY_RECONCILED', evidenceRef: String(input.evidence['evidenceRef'] ?? '') } });
  }
  insertDomainEvent(database, { eventId: input.taskEventId, projectId: input.projectId,
    eventType: 'TaskStateChanged', aggregateType: 'Task', aggregateId: subject.taskId,
    aggregateVersion: input.expectedVersion + 1, correlationId: input.commandId,
    causationId: input.executionEventId, occurredAt: input.recordedAt,
    payload: { taskId: subject.taskId, from: 'RECOVERY_REQUIRED', to: 'FAILED',
      reason: 'recovery reconciled', actor: input.actor } });
}

/** JSON columns of the probe tables are read back as-is; a malformed value is reported, not guessed. */
function parseJsonValue(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}


/** One Runtime-owned resource a reclamation run may consider, with its recorded ownership facts. */
export interface ReclamationProjectRef {
  readonly projectId: string;
  readonly name: string;
  /**
   * The repository that owns this project's Task worktrees: the dev clone when one is recorded
   * (ADR-0056), otherwise the project folder itself (ADR-0060) — `COALESCE(dev_repo_path, repo_root)`.
   * Ownership is proven by asking this repository, so it is never guessed from a path.
   */
  readonly repoRoot: string;
  /**
   * The recorded dev clone path, or null. A reclamation proves ownership by asking the repository
   * that owns the worktree, so a project without one is refused (`DEV_REPO_REQUIRED`) instead of
   * having its `repoRoot` silently read as the stable checkout's.
   */
  readonly devRepoPath: string | null;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  readonly devRef: string;
  readonly objectFormat: 'sha1' | 'sha256';
}

export interface ReclamationTaskRef {
  readonly taskId: string;
  readonly displayNumber: number;
  readonly state: TaskLifecycleState;
  readonly archivedAt: number | null;
  /** Result commit of the newest SUCCEEDED Execution, or null when nothing was captured. */
  readonly resultCommit: string | null;
}

export interface ReclamationWorkspaceRef {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly path: string;
  readonly branchRef: string;
  readonly ownershipToken: string;
  readonly baseCommit: string;
  /**
   * The ref this workspace was based on (ADR-0060), or null for rows written before schema v33. This
   * is the ref a Task's result would be merged into, so it is what "already merged" is measured
   * against: the dev clone's `dev` for a promoting project, the project folder's branch for a managed
   * one.
   */
  readonly baseRef: string | null;
  readonly state: WorkspaceLifecycleState;
  /** True while an Execution of this Task still holds its resources. */
  readonly resourceHeld: boolean;
  /**
   * True while a slot reservation (RESERVED or RECOVERY_REQUIRED) still claims this workspace.
   * A reserved workspace that no Execution has started yet is just as unavailable as a running one.
   */
  readonly activeReservation: boolean;
  readonly reservationState: string | null;
  /** The reservation that still claims the workspace, when one does. */
  readonly reservationId: string | null;
}

export interface ReclamationVerificationRef {
  readonly verificationId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly testedCommit: string;
  readonly copyPath: string;
  readonly state: VerificationState;
  readonly outcomeCode: string | null;
}

export interface ReclamationIntegrationRef {
  readonly batchId: string;
  readonly taskId: string;
  readonly state: IntegrationBatchState;
  readonly devCommit: string;
  readonly mergedCommit: string | null;
  readonly integratedCommit: string | null;
  readonly worktreePath: string;
  readonly ownershipToken: string;
  readonly detail: string | null;
}

/** Everything a reclamation plan needs, in one read, including each resource's ownership token. */
export interface ReclamationCandidates {
  readonly project: ReclamationProjectRef;
  readonly tasks: readonly ReclamationTaskRef[];
  readonly workspaces: readonly ReclamationWorkspaceRef[];
  readonly verificationCopies: readonly ReclamationVerificationRef[];
  readonly integrationWorktrees: readonly ReclamationIntegrationRef[];
}

export type ReclamationOutcome = 'RECLAIMED' | 'ALREADY_ABSENT' | 'RETAINED' | 'REFUSED' | 'FAILED'
  | 'RECOVERY_REQUIRED';

/** Where a ledger row came from: a recorded resource, or a directory no record claimed. */
export type ReclamationSource = 'REGISTERED' | 'UNREGISTERED_DIRECTORY';

/** The resource kinds a ledger row can describe (ADR-0021 plus unregistered directories). */
export type ReclamationKind = 'TASK_WORKTREE' | 'VERIFICATION_COPY' | 'INTEGRATION_WORKTREE'
  | 'UNREGISTERED_DIRECTORY';

export interface ReclamationRecordInput {
  readonly id: string;
  /** Null for an unregistered directory that cannot be attributed to a Task honestly. */
  readonly taskId: string | null;
  readonly kind: ReclamationKind;
  readonly source: ReclamationSource;
  readonly resourceId: string;
  readonly path: string;
  readonly ownershipToken: string | null;
  readonly externalRef: string | null;
  readonly resourceState: string;
  readonly outcome: ReclamationOutcome;
  readonly reasonCode: string;
  readonly detail: string | null;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface ReclamationRecord extends ReclamationRecordInput {
  readonly projectId: string;
  readonly operationId: string;
  readonly commandId: string;
  readonly createdAt: number;
}

/**
 * A directory in the Runtime data directory that some record already claims by path. Used by the
 * unregistered-directory scan so a leftover path can never be treated as unclaimed when it is not.
 */
export interface ReclamationPathClaim {
  readonly kind: 'TASK_WORKTREE' | 'VERIFICATION_COPY' | 'INTEGRATION_WORKTREE';
  readonly projectId: string;
  readonly taskId: string | null;
  readonly resourceId: string;
  readonly resourceState: string;
}

export interface ReclamationOperationPlan {
  readonly operationId: string;
  readonly operationState: 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
  readonly projectId: string;
  readonly commandId: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>> | null;
}

export type OperationState = 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED'
  | 'RECONCILE_REQUIRED';

export type OperationProgressState = 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INFO';

/** One recorded boundary of a long command. Ordered by `sequence`, unique by `stepKey`. */
export interface OperationProgressEntry {
  readonly sequence: number;
  readonly stepKey: string;
  readonly step: string;
  readonly state: OperationProgressState;
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly recordedAt: number;
}

/**
 * What kind of progress one published event describes. `STEP` and `CANCEL` are the durable
 * boundaries; `OUTPUT` is sub-step liveness while a command is producing output; `SETTLED` is the
 * Operation's terminal transition. None of them is a verdict — see `OperationProgressEventSummary`.
 */
export type OperationProgressPhase = 'STEP' | 'OUTPUT' | 'CANCEL' | 'SETTLED';

/**
 * One published progress event as this Runtime recorded it. `progressSequence` is monotonic per
 * Operation, so a consumer can order two events of the same Operation and ignore one that arrived
 * late; `eventSequence` is the global event-log cursor `domain_events` assigned to the same fact.
 *
 * A progress event never carries a verdict: it says what the Runtime reached, not whether anything
 * passed. The judgement of a verification lives in `VerificationCompleted` alone, which is why
 * `verdict` is always false here.
 */
export interface OperationProgressEventSummary {
  readonly operationId: string;
  readonly progressSequence: number;
  readonly eventId: string;
  readonly eventSequence: number;
  readonly phase: OperationProgressPhase;
  readonly dedupKey: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly recordedAt: number;
}

/** The step a progress event also recorded, when it recorded one. */
export interface OperationProgressEventStep {
  readonly stepKey: string;
  readonly step: string;
  readonly state: OperationProgressState;
}

export interface RecordOperationProgressEventResult {
  /** True when this call appended the durable step row (false when that boundary already existed). */
  readonly stepRecorded: boolean;
  /** True when this call published the event (false when it was already published, or refused). */
  readonly eventRecorded: boolean;
  readonly progressSequence: number | null;
  readonly eventSequence: number | null;
  /** Set when no event was published because the Operation already reached a terminal state. */
  readonly refused: 'TERMINAL' | null;
}

/**
 * A long-command Operation as it is projected to clients: its durable state, its ordered steps,
 * and whether a cancel has been requested. It carries facts only — never a predicted remaining
 * time or a percentage the Runtime cannot know.
 */
export interface OperationSummary {
  readonly operationId: string;
  readonly projectId: string;
  readonly kind: string;
  readonly aggregateId: string;
  readonly taskId: string | null;
  readonly state: OperationState;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cancelRequestedAt: number | null;
  readonly steps: readonly OperationProgressEntry[];
}

/**
 * One persisted dependency edge projected for clients: the pinned upstream revision and the display
 * identity of both endpoints. `integratedCommit` is the recorded fact that the pinned revision has
 * been merged into `dev`; it is not yet a satisfied dependency, because reachability from the
 * project's current `dev` ref is a Git question the scheduler answers.
 */
export interface TaskDependencyRecord {
  readonly projectId: string;
  readonly dependentTaskId: string;
  readonly dependentDisplayNumber: number;
  readonly dependentState: TaskLifecycleState;
  readonly prerequisiteTaskId: string;
  readonly prerequisiteDisplayNumber: number;
  readonly prerequisiteState: TaskLifecycleState;
  readonly requiredRevisionId: string;
  readonly requiredRevisionNumber: number;
  readonly createdBy: string;
  readonly createdAt: number;
}

export interface TaskDependencyFact extends TaskDependencyRecord {
  /** Merged commit of an INTEGRATED batch for the pinned revision, or null when none exists. */
  readonly integratedCommit: string | null;
  readonly integrationBatchId: string | null;
}

export interface TaskDependencyMutation {
  readonly projectId: string;
  readonly taskId: string;
  readonly prerequisiteTaskId: string;
  readonly requiredRevisionId: string;
  readonly taskState: TaskLifecycleState;
  readonly version: number;
  /** False when the identical edge already existed: the graph did not change, so no version bump. */
  readonly added: boolean;
}

export interface TaskDependencyRemoval {
  readonly projectId: string;
  readonly taskId: string;
  readonly prerequisiteTaskId: string;
  readonly taskState: TaskLifecycleState;
  readonly version: number;
  readonly removed: boolean;
}

/** Why one edge is not satisfied. Bounded codes, never a paraphrase of an upstream message. */
export interface TaskDependencyBlockReason {
  readonly code: 'UPSTREAM_NOT_INTEGRATED' | 'DEV_BASELINE_MISSING' | 'DEV_REF_UNREADABLE'
    | 'NOT_REACHABLE_FROM_DEV';
  readonly prerequisiteTaskId: string;
  readonly requiredRevisionId: string;
  readonly detail: string | null;
}

export interface TaskDependencyStateChange {
  readonly taskId: string;
  readonly state: TaskLifecycleState;
  readonly version: number;
  readonly changed: boolean;
  readonly reasons: readonly TaskDependencyBlockReason[];
}

/**
 * A Task's dependency edges may only be edited while a dependency could still be honoured by the
 * next attempt. A running or paused Task keeps the set it was scheduled with; a finished Task keeps
 * the set its evidence was produced under. `EXECUTED` is excluded on purpose: a result commit was
 * already captured, so a dependency added afterwards could not have shaped it, and this step does
 * not implement "invalidate the captured evidence when a dependency changes" — that belongs with the
 * not-yet-implemented revision path (`EXECUTED | revision added | →READY | BLOCKED`).
 */
const taskDependencyEditableStates: ReadonlySet<TaskLifecycleState> = new Set([
  'DRAFT', 'BLOCKED', 'READY', 'FAILED',
]);

/** Domain graph construction with the storage error code callers can branch on. */
function dependencyGraphOf(edges: readonly DependencyEdge[]) {
  try {
    return createDependencyGraph(edges);
  } catch (error) {
    if (error instanceof DependencyGraphError) {
      throw new StorageError('INVALID_STATE', `Stored dependency graph is invalid: ${error.message}`);
    }
    throw error;
  }
}

/**
 * A rejected dependency edit carries its own stable code instead of reusing `StorageError`'s closed
 * set: a caller (or a script) must be able to tell "the graph would have become cyclic" from
 * "the version did not match", and a cycle is not an invalid stored state — it is a refused edit.
 */
export class TaskDependencyError extends Error {
  constructor(readonly code: 'DEPENDENCY_CYCLE' | 'SELF_DEPENDENCY', message: string) {
    super(message);
    this.name = 'TaskDependencyError';
  }
}
/**
 * One provider process generation of one Agent Session (ADR-0010 D04 / ADR-0023). The same
 * provider conversation (session file + session ID) survives the handoff; the OS process does not,
 * so incarnations are an ordered history rather than a rename of one row.
 */
export type SessionIncarnationMode = 'AUTOMATED_RPC' | 'HUMAN_TUI';
export type SessionIncarnationState = 'ACTIVE' | 'FENCED' | 'RECOVERY_REQUIRED' | 'EXITED';

export interface SessionIncarnationRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly incarnationNumber: number;
  readonly mode: SessionIncarnationMode;
  readonly state: SessionIncarnationState;
  readonly providerPid: number | null;
  /** Adapter-recorded process identity (pid + start token + argv hash); never just a PID. */
  readonly processIdentity: unknown;
  /** Process tree captured while the provider was alive; the owner evidence for a later check. */
  readonly processTree: unknown;
  readonly providerSessionId: string | null;
  /** The provider session file this incarnation writes; successors must reopen the same one. */
  readonly sessionStorageRef: string | null;
  readonly predecessorIncarnationId: string | null;
  readonly commandId: string;
  readonly createdAt: number;
  readonly endedAt: number | null;
  readonly exit: unknown;
}

/**
 * The Runtime-enforced single writer lease of one Session. Pi does not lock a session file, so this
 * row — not the provider — is what makes a second writer fail as `ATTACHMENT_BUSY` instead of
 * silently appending to a conversation another process is still writing.
 */
export interface SessionWriterLeaseRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly incarnationId: string;
  readonly holderKind: 'AUTOMATED_RPC' | 'TERMINAL_ATTACHMENT';
  readonly holderRef: string;
  readonly commandId: string;
  readonly acquiredAt: number;
  readonly releasedAt: number | null;
  readonly releaseReason: string | null;
}

/** Why a lease acquisition did not succeed. `ATTACHMENT_BUSY` is the stable "someone else writes". */
export type SessionWriterLeaseCode = 'ATTACHMENT_BUSY' | 'INCARNATION_NOT_CURRENT' | 'HOLDER_MISMATCH';

export interface SessionWriterLeaseAcquisition {
  readonly acquired: boolean;
  readonly code: SessionWriterLeaseCode | null;
  readonly lease: SessionWriterLeaseRecord | null;
  readonly replayed: boolean;
  /** The holder that already owns the Session, so the refusal can name it instead of queueing. */
  readonly holder: { readonly holderKind: string; readonly holderRef: string;
    readonly acquiredAt: number } | null;
}

export interface SessionIncarnationWrite {
  readonly incarnation: SessionIncarnationRecord;
  readonly lease: SessionWriterLeaseRecord | null;
  readonly takenOver: boolean;
  readonly replayed: boolean;
}

export type SessionHandoffKind = 'TAKEOVER' | 'RETURN';
export type SessionHandoffState = 'REQUESTED' | 'FENCED' | 'AT_SAFE_POINT' | 'ADMITTED'
  | 'CANCELLED' | 'RECOVERY_REQUIRED';

/** A persisted takeover/return intent plus the fence and safe-point facts observed for it. */
export interface SessionHandoffRequestRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly incarnationId: string;
  readonly kind: SessionHandoffKind;
  readonly state: SessionHandoffState;
  readonly commandId: string;
  readonly fenceActive: boolean;
  readonly fenceConfirmedAt: number | null;
  readonly settledAfterFenceAt: number | null;
  readonly safePointAt: number | null;
  readonly admittedAt: number | null;
  readonly detail: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type SessionPermissionDecision = 'OPEN' | 'DECIDING' | 'ALLOW' | 'DENY' | 'CANCEL' | 'STALE';

/**
 * One STRICT permission request, bound to the incarnation that asked. The binding is what makes a
 * late answer for a superseded incarnation a refusal instead of a write to the wrong process.
 */
export interface SessionPermissionRequestRecord {
  readonly id: string;
  readonly attentionId: string;
  readonly sessionId: string;
  readonly incarnationId: string;
  readonly providerRequestId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly inputFingerprint: string;
  readonly piMode: string;
  readonly decision: SessionPermissionDecision;
  readonly requestedAt: number;
  readonly decidedAt: number | null;
  readonly decidedBy: string | null;
}

/**
 * One PTY-hosted provider terminal (ADR-0026). The Runtime holds the helper process (which owns the
 * terminal); the provider runs on that terminal. `exitCode` is audit data only: a native terminal
 * released with Ctrl+D and one killed by SIGTERM both exit 0 (FOUNDATION-040), so no decision may
 * branch on it.
 */
/** The shape of a captured provider process tree, as stored (structurally compatible with the
 * Agent adapter's `ProviderProcessTree`, without making storage depend on that package). */
export interface ProviderProcessRefLike {
  readonly pid: number;
  readonly startToken: string | null;
  readonly command: string;
}

export interface ProviderProcessTreeLike {
  readonly pid: number;
  readonly startToken: string;
  readonly pgid: number | null;
  readonly descendants: readonly ProviderProcessRefLike[];
  readonly capturedAt: number;
  readonly note: string;
}

export type SessionTerminalState = 'RUNNING' | 'RELEASED' | 'STOPPED' | 'RECOVERY_REQUIRED';
export type SessionTerminalWindowSize = 'APPLIED' | 'NOT_APPLIED';

export interface SessionTerminalRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly incarnationId: string;
  readonly helperPid: number | null;
  readonly helperStartToken: string | null;
  readonly providerPid: number | null;
  readonly ptySlave: string | null;
  readonly windowSize: SessionTerminalWindowSize;
  readonly state: SessionTerminalState;
  readonly releaseCommandId: string | null;
  readonly releaseRequestedAt: number | null;
  /** The byte the Runtime wrote to ask the provider to release (audit, not a success criterion). */
  readonly releaseByte: string | null;
  readonly providerShutdownReportedAt: number | null;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  readonly exitReportedAt: number | null;
  readonly sessionFile: string | null;
  readonly entriesAtStart: number | null;
  readonly lastEntryIdAtStart: string | null;
  readonly entriesAtRelease: number | null;
  readonly lastEntryIdAtRelease: string | null;
  readonly releaseDetail: string | null;
  readonly createdAt: number;
  readonly endedAt: number | null;
}

export interface SessionTerminalWrite {
  readonly terminal: SessionTerminalRecord;
  readonly replayed: boolean;
}

export type SessionTerminalAttachmentKind = 'WRITER' | 'OBSERVER';
export type SessionTerminalAttachmentState = 'ATTACHED' | 'DETACHED';

export interface SessionTerminalAttachmentRecord {
  readonly id: string;
  readonly terminalId: string;
  readonly sessionId: string;
  readonly kind: SessionTerminalAttachmentKind;
  readonly holderRef: string;
  readonly state: SessionTerminalAttachmentState;
  readonly cursorAtAttach: number;
  readonly cursorAtDetach: number | null;
  readonly commandId: string;
  readonly attachedAt: number;
  readonly detachedAt: number | null;
  readonly detachedReason: string | null;
}

export type SessionTerminalAttachmentCode = 'ATTACHED' | 'REPLAYED' | 'ATTACHMENT_BUSY'
  | 'TERMINAL_NOT_RUNNING';

export interface SessionTerminalAttachmentAcquisition {
  readonly attached: boolean;
  readonly code: SessionTerminalAttachmentCode;
  readonly attachment: SessionTerminalAttachmentRecord | null;
  readonly holder: { readonly holderRef: string; readonly attachedAt: number } | null;
}

export type SessionPermissionClaimCode = 'CLAIMED' | 'STALE_INCARNATION' | 'ALREADY_DECIDING'
  | 'ALREADY_DECIDED' | 'NOT_FOUND';

export interface SessionPermissionClaimResult {
  readonly claimed: boolean;
  readonly code: SessionPermissionClaimCode;
  readonly permission?: SessionPermissionRequestRecord;
}

interface SessionIncarnationRow {
  id: string; session_id: string; execution_id: string; incarnation_number: number;
  mode: SessionIncarnationMode; state: SessionIncarnationState; provider_pid: number | null;
  process_identity_json: string | null; process_tree_json: string | null;
  provider_session_id: string | null; session_storage_ref: string | null;
  predecessor_incarnation_id: string | null; command_id: string; created_at: number;
  ended_at: number | null; exit_json: string | null;
}

function mapSessionIncarnationRow(row: SessionIncarnationRow): SessionIncarnationRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    incarnationNumber: row.incarnation_number,
    mode: row.mode,
    state: row.state,
    providerPid: row.provider_pid,
    processIdentity: row.process_identity_json === null
      ? null : JSON.parse(row.process_identity_json) as unknown,
    processTree: row.process_tree_json === null
      ? null : JSON.parse(row.process_tree_json) as unknown,
    providerSessionId: row.provider_session_id,
    sessionStorageRef: row.session_storage_ref,
    predecessorIncarnationId: row.predecessor_incarnation_id,
    commandId: row.command_id,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    exit: row.exit_json === null ? null : JSON.parse(row.exit_json) as unknown,
  };
}

interface SessionWriterLeaseRow {
  id: string; session_id: string; incarnation_id: string;
  holder_kind: SessionWriterLeaseRecord['holderKind']; holder_ref: string; command_id: string;
  acquired_at: number; released_at: number | null; release_reason: string | null;
}

function mapSessionWriterLeaseRow(row: SessionWriterLeaseRow): SessionWriterLeaseRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    incarnationId: row.incarnation_id,
    holderKind: row.holder_kind,
    holderRef: row.holder_ref,
    commandId: row.command_id,
    acquiredAt: row.acquired_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  };
}

interface SessionHandoffRequestRow {
  id: string; session_id: string; execution_id: string; incarnation_id: string;
  kind: SessionHandoffKind; state: SessionHandoffState; command_id: string;
  fence_active: number; fence_confirmed_at: number | null; settled_after_fence_at: number | null;
  safe_point_at: number | null; admitted_at: number | null; detail: string | null;
  created_at: number; updated_at: number;
}

function mapSessionHandoffRequestRow(row: SessionHandoffRequestRow): SessionHandoffRequestRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    executionId: row.execution_id,
    incarnationId: row.incarnation_id,
    kind: row.kind,
    state: row.state,
    commandId: row.command_id,
    fenceActive: row.fence_active === 1,
    fenceConfirmedAt: row.fence_confirmed_at,
    settledAfterFenceAt: row.settled_after_fence_at,
    safePointAt: row.safe_point_at,
    admittedAt: row.admitted_at,
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface SessionPermissionRequestRow {
  id: string; attention_id: string; session_id: string; incarnation_id: string;
  provider_request_id: string; tool_call_id: string; tool_name: string; input_json: string;
  input_fingerprint: string; pi_mode: string; decision: SessionPermissionDecision;
  requested_at: number; decided_at: number | null; decided_by: string | null;
}

function mapSessionPermissionRequestRow(
  row: SessionPermissionRequestRow,
): SessionPermissionRequestRecord {
  return {
    id: row.id,
    attentionId: row.attention_id,
    sessionId: row.session_id,
    incarnationId: row.incarnation_id,
    providerRequestId: row.provider_request_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    input: JSON.parse(row.input_json) as unknown,
    inputFingerprint: row.input_fingerprint,
    piMode: row.pi_mode,
    decision: row.decision,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

interface SessionTerminalRow {
  id: string; session_id: string; incarnation_id: string; helper_pid: number | null;
  helper_start_token: string | null; provider_pid: number | null; pty_slave: string | null;
  window_size: SessionTerminalWindowSize; state: SessionTerminalState;
  release_command_id: string | null; release_requested_at: number | null; release_byte: string | null;
  provider_shutdown_reported_at: number | null; exit_code: number | null; exit_signal: string | null;
  exit_reported_at: number | null; session_file: string | null; entries_at_start: number | null;
  last_entry_id_at_start: string | null; entries_at_release: number | null;
  last_entry_id_at_release: string | null; release_detail: string | null;
  created_at: number; ended_at: number | null;
}

function mapSessionTerminalRow(row: SessionTerminalRow): SessionTerminalRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    incarnationId: row.incarnation_id,
    helperPid: row.helper_pid,
    helperStartToken: row.helper_start_token,
    providerPid: row.provider_pid,
    ptySlave: row.pty_slave,
    windowSize: row.window_size,
    state: row.state,
    releaseCommandId: row.release_command_id,
    releaseRequestedAt: row.release_requested_at,
    releaseByte: row.release_byte,
    providerShutdownReportedAt: row.provider_shutdown_reported_at,
    exitCode: row.exit_code,
    exitSignal: row.exit_signal,
    exitReportedAt: row.exit_reported_at,
    sessionFile: row.session_file,
    entriesAtStart: row.entries_at_start,
    lastEntryIdAtStart: row.last_entry_id_at_start,
    entriesAtRelease: row.entries_at_release,
    lastEntryIdAtRelease: row.last_entry_id_at_release,
    releaseDetail: row.release_detail,
    createdAt: row.created_at,
    endedAt: row.ended_at,
  };
}

interface SessionTerminalAttachmentRow {
  id: string; terminal_id: string; session_id: string; kind: SessionTerminalAttachmentKind;
  holder_ref: string; state: SessionTerminalAttachmentState; cursor_at_attach: number;
  cursor_at_detach: number | null; command_id: string; attached_at: number;
  detached_at: number | null; detached_reason: string | null;
}

function mapSessionTerminalAttachmentRow(
  row: SessionTerminalAttachmentRow,
): SessionTerminalAttachmentRecord {
  return {
    id: row.id,
    terminalId: row.terminal_id,
    sessionId: row.session_id,
    kind: row.kind,
    holderRef: row.holder_ref,
    state: row.state,
    cursorAtAttach: row.cursor_at_attach,
    cursorAtDetach: row.cursor_at_detach,
    commandId: row.command_id,
    attachedAt: row.attached_at,
    detachedAt: row.detached_at,
    detachedReason: row.detached_reason,
  };
}
