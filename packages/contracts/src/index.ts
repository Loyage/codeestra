import { z } from 'zod';
import { questionnaireAnswerSchema } from './questionnaire.js';
import { verificationPolicyConfirmationSchema } from './verification-policy.js';
import { impactPolicyConfirmationSchema } from './impact-policy.js';
import {
  maxProseQuestionAnswerLength,
  maxProseQuestionResolutionNoteLength,
  proseQuestionAttentionModeSchema,
  proseQuestionResolutionSchema,
} from './prose-question.js';

export * from './questionnaire.js';
export * from './verification-policy.js';
export * from './impact-policy.js';
export * from './targeted-test-plan.js';
export * from './prose-question.js';

export const repositoryIdentitySchema = z.strictObject({
  repoRoot: z.string().min(1),
  gitCommonDir: z.string().min(1),
  mainRef: z.string().min(1),
  objectFormat: z.enum(['sha1', 'sha256']),
  headCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
});
export type RepositoryIdentity = z.infer<typeof repositoryIdentitySchema>;

/**
 * What `project.inspect` reports and what `project.trust` must echo back: the repository identity
 * plus the development baseline a Task worktree would start from. Confirming trust therefore also
 * confirms the exact `dev` commit, and a baseline that moved between inspect and trust is refused.
 */
export const projectIdentitySchema = repositoryIdentitySchema.extend({
  devRef: z.string().min(1),
  devCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).nullable(),
  devRefPresent: z.boolean(),
});
export type ProjectIdentity = z.infer<typeof projectIdentitySchema>;

/**
 * The long-lived branch every Task worktree is based on and every finished Task is integrated
 * into (ADR-0009). The name is fixed: `main` is never a development baseline.
 */
export const devBranchRef = 'refs/heads/dev';

/**
 * Read cursor over the append-only event log. `sequence` is the only ordering guarantee;
 * it is a per-database counter, not a distributed clock. Readers resume with an exclusive
 * cursor so a reconnect neither skips nor repeats events.
 */
export const eventEnvelopeSchema = z.strictObject({
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  eventType: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  projectId: z.string().min(1),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  aggregateVersion: z.number().int().nonnegative(),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).nullable(),
  occurredAt: z.number().int().nonnegative(),
  payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/**
 * Frames of a long-lived subscription connection. A subscription is not a durable consumer:
 * `event_deliveries` stays the at-least-once outbox, while a subscriber that dies simply
 * reconnects with its last cursor.
 */
export const runtimeStreamFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal('subscribed'),
    requestId: z.string().uuid(),
    /** Sequence this subscriber is caught up to; events arrive only above it. */
    cursor: z.number().int().nonnegative(),
    projectId: z.string().uuid().nullable(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal('event'),
    cursor: z.number().int().positive(),
    event: eventEnvelopeSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal('heartbeat'),
    cursor: z.number().int().nonnegative(),
  }),
  /** Terminal frame: the Runtime stops the subscription after reporting it. */
  z.strictObject({
    schemaVersion: z.literal(1),
    type: z.literal('error'),
    code: z.string().min(1),
    message: z.string(),
  }),
]);
export type RuntimeStreamFrame = z.infer<typeof runtimeStreamFrameSchema>;

/** Upper bound for one event read, so a client cannot ask the Runtime to buffer unbounded rows. */
export const maxEventReadLimit = 500;

/**
 * Bounds for the read-only Agent session transcript view. A transcript read is a view over the
 * provider's own durable session file, not a Codeestra event: nothing here is written to SQLite,
 * and no business state is ever derived from it.
 */
export const maxTranscriptEntryReadLimit = 200;
export const defaultTranscriptEntryReadLimit = 100;
/** Characters of one part returned by a list read; longer parts are truncated but still fetchable. */
export const transcriptPartPreviewChars = 4_000;
/** Hard ceiling for one part fetch, so a single response stays bounded. */
export const maxTranscriptPartChars = 200_000;

/**
 * One content block of a transcript entry. `text` is a bounded preview: `truncated` says whether
 * `session.transcript.part` can return more of the same block, and `fullChars` is its real length.
 */
export interface SessionTranscriptPart {
  readonly partIndex: number;
  readonly type: 'TEXT' | 'THINKING' | 'TOOL_CALL' | 'IMAGE' | 'OTHER';
  readonly text: string;
  readonly truncated: boolean;
  readonly fullChars: number;
  /** Tool name for a TOOL_CALL part; `null` for every other part type. */
  readonly name: string | null;
  readonly toolCallId: string | null;
}

/** Provider-reported token accounting for one assistant message; absent fields stay null. */
export interface SessionTranscriptUsage {
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly reasoning: number | null;
  readonly total: number | null;
  readonly cost: number | null;
}

/**
 * One entry of the provider's session file, normalized for display. Unrecognized entry types are
 * reported as OTHER with a `note` instead of being silently dropped.
 */
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

/**
 * One window of a Session's transcript. The Runtime is the only reader of the provider session
 * file: clients never learn the file path, so this view carries identity and content, not locations.
 */
export interface SessionTranscriptView {
  readonly sessionId: string;
  readonly executionId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly attemptNumber: number;
  readonly executionState: string;
  readonly sessionState: string;
  readonly providerSessionId: string | null;
  /** False when the provider never created a durable session file, or it is gone. */
  readonly fileAvailable: boolean;
  /** Honest explanation when `fileAvailable` is false, or a bounded read caveat otherwise. */
  readonly note: string | null;
  readonly entries: readonly SessionTranscriptEntry[];
  /** Exclusive cursor for the next read: the last entry ID returned, or the requested cursor. */
  readonly cursor: string | null;
  readonly hasMore: boolean;
  /** Lines scanned in this read that were not valid session entries; never silently ignored. */
  readonly unparsedLines: number;
  readonly partPreviewChars: number;
}

/** One whole content block, fetched on demand after a truncated list read. */
export interface SessionTranscriptPartView {
  readonly sessionId: string;
  readonly entryId: string;
  readonly partIndex: number;
  readonly type: SessionTranscriptPart['type'];
  readonly name: string | null;
  readonly toolCallId: string | null;
  readonly text: string;
  readonly fullChars: number;
  /** True when `maxTranscriptPartChars` itself cut the block, so the client must say so. */
  readonly truncated: boolean;
}

const requestBase = {
  requestId: z.string().uuid(),
  schemaVersion: z.literal(1),
};

const taskKindSchema = z.enum(['DEVELOPMENT', 'SELF']);
const nonBlankString = z.string().min(1).refine((value) => value.trim().length > 0, 'Must not be blank');
const constraintSchema = z.strictObject({ id: z.string().min(1), text: nonBlankString });
export const agentAnswerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('CONFIRM'), confirmed: z.boolean() }),
  z.strictObject({ type: z.literal('VALUE'), value: z.string() }),
  // A structured answer to a questionnaire Attention. It is its own answer type rather than a
  // VALUE string so the answer stays validated data on the public command face, and only the
  // Adapter encodes it for its own provider dialog.
  z.strictObject({ type: z.literal('QUESTIONNAIRE'), answer: questionnaireAnswerSchema }),
  z.strictObject({ type: z.literal('CANCEL') }),
]);
export type AgentAnswer = z.infer<typeof agentAnswerSchema>;

/** Provider thinking levels Pi accepts via `--thinking`; it clamps them to the model's ability. */
export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const thinkingLevelSchema = z.enum(thinkingLevels);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

/**
 * Overrides one Agent Adapter's launch configuration at one scope. Every field is optional:
 * an absent field means "no override here", so a lower-precedence scope still applies. This is
 * the shape persisted per scope and the shape recorded with an Execution as its actual input.
 */
export const agentConfigurationSchema = z.strictObject({
  provider: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
});
export type AgentConfiguration = z.infer<typeof agentConfigurationSchema>;

/** Environment variable names that override persisted Agent configuration, highest precedence. */
export const agentConfigurationEnvironmentVariables = Object.freeze({
  pi: Object.freeze({
    provider: 'CODEESTRA_PI_PROVIDER',
    model: 'CODEESTRA_PI_MODEL',
    thinkingLevel: 'CODEESTRA_PI_THINKING',
  }),
  codex: Object.freeze({
    provider: 'CODEESTRA_CODEX_PROVIDER',
    model: 'CODEESTRA_CODEX_MODEL',
    thinkingLevel: 'CODEESTRA_CODEX_THINKING',
  }),
});

const constraintsSchema = z.array(constraintSchema).superRefine((constraints, context) => {
  const ids = new Set<string>();
  for (const [index, constraint] of constraints.entries()) {
    if (ids.has(constraint.id)) {
      context.addIssue({ code: 'custom', message: 'Constraint IDs must be unique', path: [index, 'id'] });
    }
    ids.add(constraint.id);
  }
});

/**
 * Runtime-owned resources a reclamation run may consider. Each kind is deleted only after its
 * path, its recorded ownership identity and its Git worktree registration all agree.
 */
export const reclaimKindSchema = z.enum([
  'TASK_WORKTREE', 'VERIFICATION_COPY', 'INTEGRATION_WORKTREE',
]);
export type ReclaimKind = z.infer<typeof reclaimKindSchema>;

/**
 * The structured STRICT permission request a controlled gate extension sends over the Runtime side
 * channel (ADR-0023). It is the `prompt_json` of such an Attention: tool name, the exact input, and
 * the input fingerprint, so "what was approved" stays reproducible from the row alone.
 */
export const permissionPromptSchema = z.strictObject({
  kind: z.literal('codeestra.permission'),
  version: z.literal(1),
  sessionId: z.string().min(1),
  incarnationId: z.string().min(1),
  incarnationNumber: z.number().int().positive(),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.unknown(),
  inputFingerprint: z.string().min(1),
  piMode: z.string().min(1),
  requestedAt: z.number().int().nonnegative(),
});
export type PermissionPrompt = z.infer<typeof permissionPromptSchema>;

/**
 * What `runtime.ping` reports about the Runtime process that answered it. `pid` alone is not
 * identity: `bootId` is what a client compares across a restart, and `startedAt` is when this boot
 * claimed its Runtime home (ADR-0025).
 */
export const runtimePingResultSchema = z.strictObject({
  pid: z.number().int().positive(),
  bootId: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
  status: z.string().min(1),
  permissionMode: z.enum(['FULL', 'STRICT']),
  adapters: z.array(z.string()),
  activeSessions: z.array(z.string()),
  eventSubscribers: z.number().int().nonnegative(),
  uiRunning: z.boolean(),
});
export type RuntimePingResult = z.infer<typeof runtimePingResultSchema>;

/**
 * What `runtime.stop` reports: the identity of the process that was asked to stop. It never claims
 * that the process stopped — only the caller can observe that, and `codeestra stop` waits for the
 * exit and reports it as a fact (ADR-0025).
 */
export const runtimeStopResultSchema = z.strictObject({
  stopping: z.literal(true),
  pid: z.number().int().positive(),
  bootId: z.string().min(1),
  startedAt: z.number().int().nonnegative(),
});
export type RuntimeStopResult = z.infer<typeof runtimeStopResultSchema>;

/**
 * Concurrency capacity and slot reservations (Phase 2, FOUNDATION-054 / ADR-0032).
 *
 * Two dimensions, both bounded by an explicit limit: the project-wide number of concurrent Tasks
 * (default 2, configurable) and the number of concurrent slots per Agent Adapter (an Adapter with
 * no explicit override follows the project limit). Nothing here is derived from host resources.
 *
 * A Task that cannot get a slot because of capacity is **waiting**, not blocked: `BLOCKED` is
 * reserved for unmet dependencies (PROJECT_SPEC §2.10), so a capacity wait is expressed as its own
 * stable reason code on the acquisition result and on `scheduler capacity get`.
 */
export const defaultConcurrencyLimit = 2;
/** Upper bound for a configured limit: a typo must be refused, never silently clamped. */
export const maxConcurrencyLimit = 16;
/** Upper bound for one reservation read, so a client cannot ask the Runtime for unbounded rows. */
export const maxSlotReservationReadLimit = 200;

/**
 * Why a Task did not get a slot. These are the codes a scheduler may surface as a *capacity wait*
 * (never as `BLOCKED`); the set is closed so a client can branch on it.
 */
export type CapacityWaitReasonCode =
  | 'CAPACITY_GLOBAL_LIMIT_REACHED'
  | 'CAPACITY_ADAPTER_SLOT_LIMIT_REACHED'
  | 'SCHEDULER_DRAINING';

export interface CapacityWaitReason {
  readonly code: CapacityWaitReasonCode;
  readonly adapterId: string | null;
  readonly limit: number | null;
  readonly used: number | null;
  /** Tasks occupying the slots that caused the wait; empty for a draining wait. */
  readonly blocking: readonly string[];
  readonly detail: string;
}

/** The capacity both dimensions as one acquisition is judged against, with where each limit came from. */
export interface SlotCapacityCheck {
  readonly globalLimit: number;
  readonly globalLimitSource: 'DEFAULT' | 'EXPLICIT';
  readonly globalUsed: number;
  readonly globalBlocking: readonly string[];
  readonly adapterId: string;
  readonly adapterLimit: number;
  readonly adapterLimitSource: 'DEFAULT' | 'EXPLICIT';
  readonly adapterUsed: number;
  readonly adapterBlocking: readonly string[];
}

/** One Adapter's capacity facts, as `scheduler capacity get` reports them. */
export interface AdapterCapacityView {
  readonly adapterId: string;
  readonly limit: number;
  readonly limitSource: 'DEFAULT' | 'EXPLICIT';
  readonly used: number;
  readonly available: number;
  /** The code an acquisition for this Adapter would report right now, or null when a slot is free. */
  readonly waitReason: CapacityWaitReasonCode | null;
}

export interface ProjectCapacityView {
  readonly projectId: string;
  readonly globalLimit: number;
  readonly globalLimitSource: 'DEFAULT' | 'EXPLICIT';
  readonly globalUsed: number;
  readonly globalAvailable: number;
  readonly globalWaitReason: CapacityWaitReasonCode | null;
  readonly adapters: readonly AdapterCapacityView[];
  readonly configVersion: number;
  readonly updatedAt: number | null;
  readonly updatedBy: string | null;
  /** Runtime-owned draining fact: new reservations are refused while it is true. */
  readonly draining: boolean;
  readonly drainReason: string | null;
  /** Tasks holding a slot right now, so a client can compute a waiting duration. */
  readonly occupants: readonly { readonly taskId: string;
    readonly reservationId: string | null; readonly adapterId: string; readonly since: number }[];
}

/** Who created a reservation and what evidence was recorded for it (never a bare "it was me"). */
export interface SlotHolderEvidenceView {
  readonly bootId: string;
  readonly pid: number;
  /** OS start token captured at acquisition; null when the OS could not answer. */
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
  readonly state: 'RESERVED' | 'RELEASED' | 'RECOVERY_REQUIRED';
  readonly version: number;
  readonly commandId: string;
  readonly holder: SlotHolderEvidenceView;
  readonly reservedAt: number;
  readonly updatedAt: number;
  readonly releasedAt: number | null;
  readonly releaseReason: string | null;
  readonly releaseKind: 'EXPLICIT' | 'RECONCILED_HOLDER_EXITED' | 'RECONCILED_PROCESS_ID_REUSED' | null;
  readonly releaseObservation: 'HOLDER_STOPPED' | 'HOLDER_PROCESS_ID_REUSED' | 'HOLDER_STILL_RUNNING'
    | 'HOLDER_OWNERSHIP_UNVERIFIABLE' | 'PROCESS_IDENTITY_MISSING' | null;
  readonly detail: string | null;
}

export interface SlotReservationDetailView extends SlotReservationView {
  readonly events: readonly SlotReservationEventView[];
}

export interface SlotReservationAcquisitionView {
  readonly outcome: 'RESERVED' | 'CAPACITY_WAIT' | 'DRAINING';
  readonly capacity: SlotCapacityCheck;
  readonly wait: CapacityWaitReason | null;
  readonly reservation: SlotReservationDetailView | null;
  /**
   * How the recorded holders of the slots that caused a wait looked when this command ran: a pid
   * and start token compared with a live process table. Never an automatic release — capacity is
   * only ever freed by an explicit release or by the audited startup reconcile.
   */
  readonly holderEvidence: readonly { readonly reservationId: string; readonly taskId: string;
    readonly observation: 'HOLDER_STOPPED' | 'HOLDER_PROCESS_ID_REUSED' | 'HOLDER_STILL_RUNNING'
      | 'HOLDER_OWNERSHIP_UNVERIFIABLE' | 'PROCESS_IDENTITY_MISSING'; readonly detail: string }[];
}

export interface SlotReservationReleaseView {
  readonly released: boolean;
  readonly outcome: 'RELEASED' | 'ALREADY_RELEASED';
  readonly reservation: SlotReservationDetailView;
}

export interface SlotReservationReconcileOutcomeView {
  readonly reservationId: string;
  readonly taskId: string;
  readonly outcome: 'RELEASED' | 'MARKED_RECOVERY_REQUIRED' | 'HELD' | 'ALREADY_RELEASED'
    | 'ALREADY_RECONCILED' | 'SKIPPED_HELD_BY_RUNTIME' | 'FAILED';
  readonly observation: 'HOLDER_STOPPED' | 'HOLDER_PROCESS_ID_REUSED' | 'HOLDER_STILL_RUNNING'
    | 'HOLDER_OWNERSHIP_UNVERIFIABLE' | 'PROCESS_IDENTITY_MISSING' | null;
  readonly previousState: string;
  readonly state: string;
  readonly detail: string;
}

export interface SlotReservationReconcileReport {
  readonly bootId: string;
  readonly outcomes: readonly SlotReservationReconcileOutcomeView[];
  /** Reservations whose recorded process was never signalled by this Runtime generation. */
  readonly notSignalled: readonly { readonly reservationId: string; readonly pid: number }[];
}

/**
 * A workspace prepared for an existing reservation. The reservation is the authority: the workspace
 * is bound to it, so a second Task can never claim the same worktree (the binding is enforced by a
 * partial unique index, not by convention).
 */
export interface ReservedWorkspaceView {
  readonly reservationId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly branchRef: string;
  readonly baseCommit: string;
  readonly ownershipToken: string;
  readonly created: boolean;
}

/**
 * The scheduling engine's vocabulary (FOUNDATION-055). A wait is never `BLOCKED` (§2.10):
 * `CONFLICT` carries the analyzer's reason codes and intersecting scopes, `CAPACITY` carries the
 * capacity reason code and the slots that produced it. `BLOCKED` is a separate disposition and only
 * ever means an unmet dependency.
 */
export type ScheduleWaitKind = 'CONFLICT' | 'CAPACITY';

/** One measured intersection behind a conflict wait, as the analyzer reported it. */
export interface ScheduleConflictHitView {
  readonly reason: string;
  readonly class: string;
  readonly taskId: string | null;
  readonly revisionId: string | null;
  readonly paths: readonly string[];
  readonly pathCount: number;
  readonly directories: readonly string[];
  readonly modules: readonly string[];
  readonly globalResources: readonly string[];
  readonly relation: string | null;
  readonly detail: string;
}

export interface ScheduleWaitView {
  readonly kind: ScheduleWaitKind;
  /** An analyzer reason code for a conflict wait, a capacity reason code for a capacity wait. */
  readonly code: string;
  readonly detail: string;
  readonly reasonCodes: readonly string[];
  readonly hits: readonly ScheduleConflictHitView[];
  /** Tasks occupying the slots / holding the conflicting scope. */
  readonly blocking: readonly string[];
  /** When this wait was first recorded, so a client can show the waiting duration. */
  readonly since: number | null;
}

/** The assessment a scheduling decision was made from; the binding an `--allow-unknown` release uses. */
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

export type ScheduleDisposition = 'STARTED' | 'WOULD_START' | 'WAITING' | 'BLOCKED' | 'SKIPPED'
  | 'FAILED';

export interface ScheduleCandidateView {
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly taskState: string;
  readonly taskVersion: number;
  readonly revisionId: string;
  readonly priority: number;
  readonly createdAt: number;
  readonly adapterId: string;
  readonly disposition: ScheduleDisposition;
  readonly detail: string;
  readonly wait: ScheduleWaitView | null;
  readonly blockedReasons: readonly { readonly code: string; readonly prerequisiteTaskId: string;
    readonly requiredRevisionId: string; readonly detail: string | null }[];
  readonly assessment: ScheduleAssessmentView | null;
  /** Present when this decision started an Execution. */
  readonly started: { readonly executionId: string; readonly sessionId: string;
    readonly workspaceId: string; readonly baseCommit: string;
    readonly reservationId: string | null } | null;
  /** The `UNKNOWN` release that permitted this start, if any. */
  readonly clearedUnknownBy: string | null;
}

/** One recorded growth of an active Task's observed diff beyond its recorded prediction (§4). */
export interface ScheduleImpactGrowthView {
  readonly taskId: string;
  readonly previousSnapshotId: string;
  readonly snapshotId: string;
  readonly addedPaths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly conflictingTaskIds: readonly string[];
  readonly reasonCodes: readonly string[];
  /** True when the grown Task was asked to enter a safe pause through the existing pause path. */
  readonly pauseRequested: boolean;
  readonly pauseOutcome: string | null;
  readonly detail: string;
}

export interface ScheduleProjectReport {
  readonly projectId: string;
  readonly candidates: readonly ScheduleCandidateView[];
  readonly impactGrowth: readonly ScheduleImpactGrowthView[];
  readonly activeTaskIds: readonly string[];
  readonly capacity: ProjectCapacityView;
}

export interface ScheduleTickReport {
  readonly tickId: string;
  readonly trigger: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly draining: boolean;
  /** True when the trigger was observed by an already running tick instead of starting a second one. */
  readonly coalesced: boolean;
  readonly projects: readonly ScheduleProjectReport[];
}

/** `task.schedule.status` / `task.schedule.plan` answer. `plan` sets `dryRun` and starts nothing. */
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

/** `task.schedule.explain` answer: the one-Task version of the overview, with its decision. */
export interface ScheduleExplanationView {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskState: string;
  readonly adapterId: string;
  readonly candidate: boolean;
  readonly decision: 'START_NOW' | 'WAIT_CONFLICT' | 'WAIT_CAPACITY' | 'BLOCKED'
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
    readonly releasedBy: string; readonly releasedAt: number; readonly consumed: boolean } | null;
  readonly explanation: readonly string[];
}

/** The audit record one `--allow-unknown` release writes. */
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

/**
 * The outcome of a start request routed through the scheduling gate (`task.run`).
 *
 * It is a **superset** of the result `task.run` has always returned, so a client that reads
 * `executionId`/`sessionId`/`workspacePath` keeps working: those fields are present exactly when a
 * start happened (non-null), and the scheduling facts are added next to them. A request that did not
 * start anything answers with `outcome` and the reason instead of pretending to be a run.
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
 * The result of `task retry` (ADR-0036): the audit facts the requeue recorded, plus the scheduling
 * answer for the one start request the Runtime issued afterwards. The two are separate facts on
 * purpose — a retry that was recorded but is waiting for capacity has still succeeded at requeuing
 * the Task, and it says so instead of reporting a start that did not happen.
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
  readonly workspace: {
    /**
     * `REUSE_VERIFIED` and `PREPARE_FRESH` are the worktree the Execution will use; `REBUILD_OWNED`
     * is a verified *plan*: the reclamation kept this Task's branch, and the workspace preparation
     * path re-creates the worktree from it (ADR-0042). The rebuild itself is attested by the
     * `WorkspacePrepared` event whose payload carries the `rebuild` outcome, so a script can tell
     * "verified, still to be created" from "created".
     */
    readonly mode: 'REUSE_VERIFIED' | 'PREPARE_FRESH' | 'REBUILD_OWNED';
    readonly workspaceId: string | null;
    readonly evidence: string | null;
    readonly detail: string;
  };
  readonly dependencyReasons: readonly unknown[];
  readonly start: ScheduleStartOutcomeView;
}

/* ---------------------------------------------------------------------------------------------
 * Domain event payloads of the session-handoff and native-terminal facts (FOUNDATION-063, ADR-0035).
 *
 * Each one observes exactly one state change: the Runtime commits the event in the *same* SQLite
 * transaction as that change, so neither "the state moved without an event" nor "an event without a
 * state change" can be stored. The shapes are strict because `events list`, the subscription
 * transport and the UI read them back, and history is append-only: these schemas may only ever gain
 * optional fields, never rename or reinterpret one that has already been written.
 *
 * A refusal is the one fact with no accompanying state change — nothing happened except that an
 * attempt was made and refused — so it is stored as its own event carrying the *stable reason code*
 * a client branches on, instead of leaving the refusal invisible in the log.
 * ------------------------------------------------------------------------------------------- */

/** The seven event names this lane adds to the ledger, in the order their facts usually arrive. */
export const sessionHandoffEventTypes = [
  'TakeoverRequested',
  'TakeoverSafePointReached',
  'SessionHandoffStarted',
  'SessionHandoffCompleted',
  'TerminalWriterLeaseChanged',
  'TakeoverReleased',
  'TakeoverFailed',
] as const;
export type SessionHandoffEventType = typeof sessionHandoffEventTypes[number];

/** One end of a writer-lease change: who held the single writer lease at that moment. */
export const sessionWriterLeaseHolderSchema = z.strictObject({
  incarnationId: z.string().min(1),
  holderKind: z.enum(['AUTOMATED_RPC', 'TERMINAL_ATTACHMENT']),
  holderRef: z.string().min(1),
});
export type SessionWriterLeaseHolder = z.infer<typeof sessionWriterLeaseHolderSchema>;

/** One takeover/return intent was persisted together with its handoff fence. */
export const takeoverRequestedPayloadSchema = z.strictObject({
  takeoverId: z.string().min(1),
  sessionId: z.string().min(1),
  executionId: z.string().min(1),
  incarnationId: z.string().min(1),
  /** `TAKEOVER` is automation → native terminal, `RETURN` is native terminal → automation. */
  kind: z.enum(['TAKEOVER', 'RETURN']),
  /** The incarnation mode the successor will run as; never the mode it replaced. */
  targetMode: z.enum(['AUTOMATED_RPC', 'HUMAN_TUI']),
});
export type TakeoverRequestedPayload = z.infer<typeof takeoverRequestedPayloadSchema>;

/**
 * The safe point a handoff is admitted from. The facts are stored verbatim, including the ones that
 * were *not* observed (`missing`), so a reader can tell "everything needed was seen" from "the
 * Runtime assumed something". Safe points reached through the terminal's own release say so through
 * `reachedFrom` instead of pretending a fence was acknowledged.
 */
export const takeoverSafePointReachedPayloadSchema = z.strictObject({
  takeoverId: z.string().min(1),
  sessionId: z.string().min(1),
  executionId: z.string().min(1),
  incarnationId: z.string().min(1),
  reachedFrom: z.enum(['RPC_FENCE', 'TERMINAL_RELEASE']),
  fenceAcknowledged: z.boolean(),
  settledAfterFenceAt: z.number().int().nonnegative().nullable(),
  activeTools: z.number().int().nonnegative(),
  /** Bounded reference to the evidence the safe point was decided from. */
  evidenceRef: z.string().min(1).nullable(),
  /** Provider session-file entry the predecessor was last known to have written, when known. */
  lastEntryRef: z.string().min(1).nullable(),
  /** Facts that were not available; empty means every safe-point fact was observed. */
  missing: z.array(z.string()),
});
export type TakeoverSafePointReachedPayload =
  z.infer<typeof takeoverSafePointReachedPayloadSchema>;

/**
 * The predecessor stopped being the writer and a successor process is about to be started on the same
 * conversation. This is *not* the hand over: at this point nothing has been started yet, and a
 * successor that cannot be launched is reported as `TakeoverFailed`.
 */
export const sessionHandoffStartedPayloadSchema = z.strictObject({
  takeoverId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  /** A handoff keeps the Session identity: the successor incarnation writes the same conversation. */
  targetSessionId: z.string().min(1),
  sourceIncarnationId: z.string().min(1),
  fromMode: z.enum(['AUTOMATED_RPC', 'HUMAN_TUI']),
  toMode: z.enum(['AUTOMATED_RPC', 'HUMAN_TUI']),
  /** The ownership observation of the predecessor that allowed the switch. */
  predecessorObservation: z.string().min(1),
  processEvidenceRef: z.string().min(1).nullable(),
});
export type SessionHandoffStartedPayload = z.infer<typeof sessionHandoffStartedPayloadSchema>;

/** The successor provider process was really started, recorded, and took the single writer lease. */
export const sessionHandoffCompletedPayloadSchema = z.strictObject({
  takeoverId: z.string().min(1),
  sourceSessionId: z.string().min(1),
  targetSessionId: z.string().min(1),
  sourceIncarnationId: z.string().min(1),
  successorIncarnationId: z.string().min(1),
  successorIncarnationNumber: z.number().int().positive(),
  fromMode: z.enum(['AUTOMATED_RPC', 'HUMAN_TUI']),
  toMode: z.enum(['AUTOMATED_RPC', 'HUMAN_TUI']),
  terminalTransport: z.enum(['PTY', 'RPC', 'NONE']),
  terminalId: z.string().min(1).nullable(),
  providerPid: z.number().int().positive().nullable(),
  processEvidenceRef: z.string().min(1).nullable(),
});
export type SessionHandoffCompletedPayload = z.infer<typeof sessionHandoffCompletedPayloadSchema>;

/**
 * The Runtime-enforced single writer lease changed holder. The lease is a *term*, not a holder
 * identity, so `before`/`after` describe the two ends of the change and the released term stays in
 * the ledger. `takeoverId` is filled in only when a handoff request was open at that moment.
 */
export const terminalWriterLeaseChangedPayloadSchema = z.strictObject({
  takeoverId: z.string().min(1).nullable(),
  sessionId: z.string().min(1),
  leaseId: z.string().min(1),
  action: z.enum(['ACQUIRED', 'RELEASED']),
  before: sessionWriterLeaseHolderSchema.nullable(),
  after: sessionWriterLeaseHolderSchema.nullable(),
  reason: z.string().min(1).nullable(),
});
export type TerminalWriterLeaseChangedPayload =
  z.infer<typeof terminalWriterLeaseChangedPayloadSchema>;

/**
 * A native terminal takeover ended *and* the conversation was proven intact: the provider exited, no
 * recorded descendant is still running, and the provider session file still holds the predecessor's
 * entries. A release that cannot be proven is a `TakeoverFailed`, never this event.
 */
export const takeoverReleasedPayloadSchema = z.strictObject({
  takeoverId: z.string().min(1),
  sessionId: z.string().min(1),
  executionId: z.string().min(1),
  incarnationId: z.string().min(1),
  terminalId: z.string().min(1).nullable(),
  reason: z.string().min(1),
  predecessorObservation: z.string().min(1),
  evidenceRef: z.string().min(1).nullable(),
  sessionFile: z.strictObject({
    file: z.string().min(1).nullable(),
    entriesAtStart: z.number().int().nonnegative().nullable(),
    entriesAtRelease: z.number().int().nonnegative().nullable(),
    lastEntryIdAtStart: z.string().min(1).nullable(),
    lastEntryIdAtRelease: z.string().min(1).nullable(),
    predecessorEntrySurvived: z.boolean().nullable(),
    truncated: z.boolean(),
  }),
});
export type TakeoverReleasedPayload = z.infer<typeof takeoverReleasedPayloadSchema>;

/**
 * A takeover or release attempt was refused, or a successor could not be started. `reason` is the
 * stable code the CLI and the Runtime already return (`SAFE_POINT_NOT_REACHED`, `ATTACHMENT_BUSY`,
 * `PREDECESSOR_NOT_STOPPED`, `RELEASE_NOT_CONFIRMED`, …); `detail` is the human-readable observation.
 */
export const takeoverFailedPayloadSchema = z.strictObject({
  takeoverId: z.string().min(1).nullable(),
  sessionId: z.string().min(1),
  executionId: z.string().min(1),
  incarnationId: z.string().min(1).nullable(),
  stage: z.enum(['REQUEST', 'SAFE_POINT', 'ADMIT', 'RELEASE']),
  reason: z.string().min(1),
  detail: z.string(),
  evidenceRef: z.string().min(1).nullable(),
});
export type TakeoverFailedPayload = z.infer<typeof takeoverFailedPayloadSchema>;

export const runtimeRequestSchema = z.discriminatedUnion('command', [
  z.strictObject({ ...requestBase, command: z.literal('runtime.ping') }),
  z.strictObject({ ...requestBase, command: z.literal('runtime.stop') }),
  z.strictObject({ ...requestBase, command: z.literal('permission.get') }),
  z.strictObject({
    ...requestBase,
    command: z.literal('permission.set'),
    mode: z.enum(['FULL', 'STRICT']),
  }),
  /**
   * Reads the Agent configuration for one Adapter together with the effective value per field and
   * where each field came from, so a client never has to re-implement the precedence rules.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('agent.config.get'),
    adapterId: nonBlankString.default('pi'),
    projectId: z.string().uuid().optional(),
  }),
  /**
   * Merges overrides into one scope. An absent field is left unchanged; `null` clears it. A scope
   * whose fields all become empty is removed, so it stops shadowing lower-precedence scopes.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('agent.config.set'),
    adapterId: nonBlankString.default('pi'),
    scope: z.enum(['GLOBAL', 'PROJECT']).default('GLOBAL'),
    projectId: z.string().uuid().optional(),
    provider: z.string().min(1).max(200).nullable().optional(),
    model: z.string().min(1).max(200).nullable().optional(),
    thinkingLevel: thinkingLevelSchema.nullable().optional(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('agent.config.clear'),
    adapterId: nonBlankString.default('pi'),
    scope: z.enum(['GLOBAL', 'PROJECT']).default('GLOBAL'),
    projectId: z.string().uuid().optional(),
  }),
  z.strictObject({ ...requestBase, command: z.literal('project.inspect'), path: z.string().min(1) }),
  z.strictObject({
    ...requestBase,
    command: z.literal('project.verificationPolicy'),
    path: z.string().min(1),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('project.trust'),
    path: z.string().min(1),
    /** The exact `project.inspect` result the user reviewed, including the dev baseline. */
    expectedIdentity: projectIdentitySchema,
    expectedVerificationPolicy: verificationPolicyConfirmationSchema,
    /**
     * The impact mapping the user reviewed (ADR-0031). Optional so a client that predates it still
     * works: a trust that never declares a mapping records none, and every ImpactSnapshot then stays
     * incomplete (`UNKNOWN`) — the safe direction. The CLI always sends it.
     */
    expectedImpactPolicy: impactPolicyConfirmationSchema.optional(),
  }),
  z.strictObject({ ...requestBase, command: z.literal('project.list') }),
  /**
   * Lazily starts the local UI HTTP service bound to 127.0.0.1 and returns its address. The token
   * only ever lives in Runtime memory and is handed out over this socket; it is never persisted.
   */
  z.strictObject({ ...requestBase, command: z.literal('runtime.ui') }),
  z.strictObject({
    ...requestBase,
    command: z.literal('events.list'),
    projectId: z.string().uuid().optional(),
    /** Exclusive cursor; defaults to 0, which reads the log from its beginning. */
    sinceSequence: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(maxEventReadLimit).default(100),
  }),
  /**
   * Opens a streaming connection. Without `sinceSequence` the Runtime starts from the current
   * tail, so a client takes a snapshot first and then subscribes without a message gap.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('events.subscribe'),
    projectId: z.string().uuid().optional(),
    sinceSequence: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.create'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    specification: nonBlankString,
    constraints: constraintsSchema.default([]),
    kind: taskKindSchema.default('DEVELOPMENT'),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.list'),
    projectId: z.string().uuid(),
    /** Archived Tasks are hidden unless a client explicitly asks for the full history. */
    includeArchived: z.boolean().default(false),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.submit'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
  }),
  /**
   * Starts one Task now, through the same conflict gate the automatic tick uses (FOUNDATION-055).
   * `allowUnknown` is the explicit single-shot release of an `UNKNOWN` verdict (ADR-0030 D05):
   * without it, a Task whose impact cannot be proven to be disjoint from the active set *waits*
   * (exit code 3) instead of starting. It is a widening of the gate, never a new one, and it is
   * recorded as an audit fact bound to the revision and the assessment versions.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.run'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedTaskVersion: z.number().int().nonnegative(),
    adapterId: nonBlankString.default('pi'),
    allowUnknown: z.boolean().default(false),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.status'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
  /** Cooperatively stops the running Agent and leaves the Task resumable in its workspace. */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.pause'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
  }),
  /**
   * PAUSED Task back to READY and immediately starts a new Execution in the same workspace. It is a
   * start path, so it passes the same conflict gate (scheduler.md §4): a resumed Task whose impact
   * cannot be proven disjoint from the active set stays paused. `allowUnknown` is that gate's
   * explicit single-shot release; the resumed Task already holds its slot, so no new capacity is
   * requested for it.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.resume'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    adapterId: nonBlankString.default('pi'),
    allowUnknown: z.boolean().default(false),
  }),
  /**
   * Explicit retry of a `FAILED` Task (ADR-0036). It requeues the Task (`READY`, or `BLOCKED` when
   * an upstream is unmet) and the Runtime then asks the scheduling gate for one start of *that* Task,
   * so a retry queues behind dependencies, conflicts and capacity like any other attempt.
   *
   * `adapterId` is optional on purpose: absent means "the Adapter this Task last ran on", which the
   * Runtime resolves from the failed Execution instead of the client guessing it.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.retry'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    adapterId: nonBlankString.optional(),
  }),
  /** Terminal stop: a running Agent is stopped cooperatively, everything else ends immediately. */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.cancel'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
  }),
  /** Soft delete: hides the Task from the default list without destroying any row or worktree. */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.archive'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.unarchive'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.result.prepare'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    executionId: z.string().uuid().optional(),
  }),
  /** Full-mode single-step capture; strict mode rejects this command. */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.result.capture'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    executionId: z.string().uuid().optional(),
  }),
  // Strict mode keeps the snapshot-bound confirmation contract as an opt-in path.
  z.strictObject({
    ...requestBase,
    command: z.literal('task.result.commit'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    authorizationId: z.string().uuid(),
    confirm: z.literal(true),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.verify'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    executionId: z.string().uuid().optional(),
    /** Return a durable Operation handle instead of blocking until the policy has run (ADR-0019). */
    background: z.boolean().default(false),
    /**
     * Which record defines the commands (ADR-0038/0039). `AUTO` prefers the Task's recorded
     * branch-targeted plan for this exact revision and commit and falls back to the fixed project
     * policy only when no plan was recorded; a recorded plan for another revision or commit is
     * refused instead of being silently replaced by the project policy.
     */
    policySource: z.enum(['AUTO', 'PROJECT_POLICY', 'TARGETED_TEST_PLAN']).default('AUTO'),
  }),
  /**
   * Records the branch's `.codeestra/tests.json` as an append-only plan bound to the exact
   * `(task, revision, commit, digest)`. Recording is what makes a scope change take effect, so an
   * edit inside a commit cannot silently widen or narrow what verification runs.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.tests.record'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    executionId: z.string().uuid().optional(),
    /** A full object ID to bind instead of the Task's captured result commit. */
    commit: z.string().min(7).max(64).optional(),
    /** The digest the caller expects to replace; a different current digest is refused. */
    expectedPlanDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }),
  /** The newest recorded targeted test plan of one Task, or null when none was recorded. */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.tests.show'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
  /** Every recorded plan of one Task, newest first: the append-only audit of its test scope. */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.tests.history'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    limit: z.number().int().min(1).max(500).default(50),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.verification.list'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
  /**
   * Long-command Operations for one Task: the Agent run and every verification run, with the steps
   * the Runtime actually reached. Read-only; progress is a fact, never a prediction (ADR-0019).
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.operation.list'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.operation.get'),
    projectId: z.string().uuid(),
    operationId: z.string().uuid(),
  }),
  /**
   * Cancels one long-command Operation. The Runtime only records a terminal state after the owned
   * process group has been confirmed stopped; an unconfirmed stop keeps ownership and needs a human.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.operation.cancel'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    operationId: z.string().uuid(),
  }),
  /**
   * Integrates one Task's captured result commit into the project's long-lived `dev` branch.
   * Independent integration verification must PASS on the merged commit before the `dev` ref is
   * advanced; a failure never changes `dev`.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.integrate'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.integration.list'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
  /**
   * Reads a window of the provider's own session file for one Agent Session. This is a read-only
   * observation of what the Agent did; it is not an event log and carries no delivery guarantees.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('session.transcript'),
    sessionId: z.string().uuid(),
    /** Exclusive cursor: an entry ID returned by a previous read. */
    afterEntryId: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(maxTranscriptEntryReadLimit)
      .default(defaultTranscriptEntryReadLimit),
  }),
  /** Fetches one content block whole after a list read reported it as truncated. */
  z.strictObject({
    ...requestBase,
    command: z.literal('session.transcript.part'),
    sessionId: z.string().uuid(),
    entryId: z.string().min(1).max(200),
    partIndex: z.number().int().nonnegative().max(500),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('attention.list'),
    projectId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('attention.answer'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    attentionId: z.string().uuid(),
    answer: agentAnswerSchema,
  }),
  /**
   * Ends a prose-question wait (FOUNDATION-069). It is deliberately separate from
   * `attention.answer`: that command answers a dialog the provider is still waiting on, while this
   * one records how a wait ended after the provider process already exited. Neither variant
   * resumes a conversation, and `text` is only accepted for `ANSWERED`.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('attention.resolve'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    attentionId: z.string().uuid(),
    resolution: proseQuestionResolutionSchema,
    text: z.string().trim().min(1).max(maxProseQuestionAnswerLength).optional(),
    note: z.string().trim().min(1).max(maxProseQuestionResolutionNoteLength).optional(),
  }),
  /**
   * Reads and writes the one global switch that decides whether a prose question becomes a wait.
   * It is a setting, not a gate: changing it needs no confirmation and rewriting it never touches
   * an already recorded wait.
   */
  z.strictObject({ ...requestBase, command: z.literal('settings.proseQuestionAttention.get') }),
  z.strictObject({
    ...requestBase,
    command: z.literal('settings.proseQuestionAttention.set'),
    mode: proseQuestionAttentionModeSchema,
  }),
  /**
   * Read-only preview of what a reclamation would remove and why. This is the dry run: it
   * performs no deletion, writes nothing, and returns the same decision shape as `reclaim.apply`.
   * Omitting `projectId` (or setting `allProjects`) covers every ACTIVE-trusted project and returns
   * the same decisions grouped per project, so one project's refusal never hides another's.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('reclaim.plan'),
    projectId: z.string().uuid().optional(),
    /** Explicit "every trusted project" scope; the alternative to naming one project. */
    allProjects: z.boolean().default(false),
    taskId: z.string().uuid().optional(),
    kinds: z.array(reclaimKindSchema).min(1).optional(),
    /** Failure scenes (failed/conflicted runs, dirty or unmerged worktrees) are retained by default. */
    includeFailureScenes: z.boolean().default(false),
    /** Also scan the Runtime data directory for directories no ledger row claims (ADR-0037). */
    unregistered: z.boolean().default(false),
    /** Absolute path inside the Runtime home that bounds that scan. */
    scanRoot: z.string().min(1).optional(),
    /** Paths selected for removal, so a preview shows the same decision a real run would take. */
    removeUnregistered: z.array(z.string().min(1)).max(200).optional(),
  }),
  /**
   * Executes one reclamation. It removes only Runtime-owned resources whose ownership was verified,
   * keeps every failure scene unless `includeFailureScenes` is set, and never deletes a branch.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('reclaim.apply'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid().optional(),
    allProjects: z.boolean().default(false),
    taskId: z.string().uuid().optional(),
    kinds: z.array(reclaimKindSchema).min(1).optional(),
    includeFailureScenes: z.boolean().default(false),
    /** Include unregistered directories in this run (they stay retained without a selection). */
    unregistered: z.boolean().default(false),
    scanRoot: z.string().min(1).optional(),
    /**
     * The explicit action that authorises deleting an unregistered directory. A path is only ever
     * removed when it is named here *and* every ownership fact still agrees at removal time; a
     * directory nobody named is reported, not deleted (FULL adds no confirmation step for this).
     */
    removeUnregistered: z.array(z.string().min(1)).max(200).optional(),
  }),
  /** The append-only ledger of reclamation decisions, newest first. */
  z.strictObject({
    ...requestBase,
    command: z.literal('reclaim.records'),
    projectId: z.string().uuid().optional(),
    allProjects: z.boolean().default(false),
    taskId: z.string().uuid().optional(),
    /** Read the ledger back by origin: recorded resources or unregistered directories. */
    source: z.enum(['ALL', 'REGISTERED', 'UNREGISTERED_DIRECTORY']).default('ALL'),
    /** Inclusive lower bound on the record time (epoch milliseconds). */
    since: z.number().int().nonnegative().optional(),
    /** Exclusive upper bound on the record time (epoch milliseconds). */
    until: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  /**
   * Declares that one Task depends on another. The edge pins the upstream revision that must reach
   * `dev` before the dependent may start (ADR-0009/ADR-0024); an edit that would make the project's
   * dependency graph cyclic is refused and nothing is written. This is not an approval step: in
   * FULL mode it adds no confirmation, and a cycle is a correctness rejection, not a permission one.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.depends.add'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    prerequisiteTaskId: z.string().uuid(),
    /** Pins this upstream revision; absent means the upstream's current revision. */
    requiredRevisionId: z.string().uuid().optional(),
    expectedVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.depends.remove'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    prerequisiteTaskId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
  }),
  /**
   * Read-only projection of the dependency graph. With `taskId` it reports that Task's edges, the
   * transitive prerequisite/impact closures, and the exact reason each edge is (un)satisfied;
   * without it, every edge of the project. `satisfied` is decided by the recorded integration fact
   * plus the current `dev` ref, so a rewritten `dev` shows up as blocked again.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.depends.list'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid().optional(),
  }),
  /**
   * Fixes the three facts a `dev → main` promotion may act on: the verified `dev` commit, the
   * expected old `main` commit, and the independent integration verification of the promoted
   * commit. The caller states all three; the Runtime refuses any promotion whose claim does not
   * match Git, so a promotion can never be built from "whatever dev happens to be".
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('promotion.prepare'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    batchId: z.string().uuid(),
    expectedDevCommit: z.string().min(7).max(64),
    expectedMainCommit: z.string().min(7).max(64),
  }),
  /**
   * Records one STRICT approval of exactly the prepared triple. FULL never needs it, so it is
   * refused there instead of being accepted as a no-op confirmation.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('promotion.approve'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    promotionId: z.string().uuid(),
  }),
  /**
   * Fast-forwards `main` to the fixed candidate inside the worktree that has `main` checked out,
   * then records the restart plan. The Runtime never advances a checked-out branch through its ref,
   * and never writes a second ref after this point.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('promotion.promote'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    promotionId: z.string().uuid(),
  }),
  /**
   * Records the observed Runtime restart after the client ran the recorded post-steps in the main
   * worktree. The submitted boot identity must be the Runtime answering this request and must not
   * be the one that moved `main`, and the step list must match the recorded plan exactly.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('promotion.restart.record'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    promotionId: z.string().uuid(),
    observedBootId: z.string().uuid(),
    runtimeStatus: z.string().min(1).max(40).nullable(),
    uiRunning: z.boolean().nullable(),
    steps: z.array(z.strictObject({
      id: z.string().min(1).max(40),
      argv: z.array(z.string()).min(1),
      cwd: z.string().min(1),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().int().nonnegative(),
      stdoutBytes: z.number().int().nonnegative(),
      stderrBytes: z.number().int().nonnegative(),
      stdoutDigest: z.string().min(16).max(128),
      stderrDigest: z.string().min(16).max(128),
      failureDetail: z.string().optional(),
    })).max(16),
  }),
  /**
   * Closes a promotion a restart left unresolved, without touching a ref. Used when the observed
   * `main` is not the promoted commit, so nothing may be resumed.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('promotion.abandon'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    promotionId: z.string().uuid(),
    reason: z.string().min(1).max(500),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('promotion.get'),
    projectId: z.string().uuid(),
    promotionId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('promotion.list'),
    projectId: z.string().uuid(),
    limit: z.number().int().min(1).max(200).default(20),
  }),
  /**
   * Runs the fixed project policy — the full suite — against the exact `dev` candidate commit in a
   * detached copy and records the observed result as append-only evidence (ADR-0038 D03). The
   * Runtime runs and observes it; a client cannot submit a result.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('promotion.fullSuite.run'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    /** Full object ID of the current `dev` ref; the evidence names exactly this SHA. */
    expectedDevCommit: z.string().min(7).max(64),
  }),
  /** Recorded dev full-suite evidence of one project, newest first (read-only). */
  z.strictObject({
    ...requestBase,
    command: z.literal('promotion.fullSuite.list'),
    projectId: z.string().uuid(),
    limit: z.number().int().min(1).max(200).default(20),
  }),
  /**
   * Session handoff control face (ADR-0010 Phase 3 / ADR-0023). These commands operate on the
   * Runtime-side contract only: the incarnation history, the single writer lease, the handoff fence
   * and the admission decision. The terminal transport itself is not implemented yet, and no command
   * on this face claims that a successor process was started.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('session.handoff.status'),
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
  }),
  /** Persists a takeover/return intent and installs the handoff fence; never aborts a running tool. */
  z.strictObject({
    ...requestBase,
    command: z.literal('session.handoff.request'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
    kind: z.enum(['TAKEOVER', 'RETURN']),
  }),
  /** Abandons an open handoff request and releases its fence so the Agent can use tools again. */
  z.strictObject({
    ...requestBase,
    command: z.literal('session.handoff.cancel'),
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
  }),
  /**
   * Takes the single writer lease for one Session. A second holder is answered `ATTACHMENT_BUSY`
   * with the current holder named: competition fails instead of queueing silently.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('session.handoff.writer.acquire'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
    holderKind: z.enum(['AUTOMATED_RPC', 'TERMINAL_ATTACHMENT']),
    holderRef: z.string().min(1).max(200),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('session.handoff.writer.release'),
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
    holderRef: z.string().min(1).max(200),
  }),
  /**
   * Evaluates whether a successor incarnation may be started, from recorded facts: safe point,
   * quiescent predecessor, no open Attention. When the decision is ADMITTED the Runtime starts the
   * successor provider on the same conversation in a PTY (takeover) or as an RPC process (return),
   * records the new incarnation and moves the writer lease; the response states which of the two it
   * actually did. A refused admission starts nothing.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('session.handoff.admit'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
  }),
  /**
   * Attaches this client to the running native terminal and returns the projected stream since a
   * cursor. At most one WRITER attachment exists per terminal: a second writer is answered
   * `ATTACHMENT_BUSY` with the current holder named (never queued, never approved).
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('session.handoff.attach'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
    holderRef: z.string().min(1).max(200),
    kind: z.enum(['WRITER', 'OBSERVER']).optional(),
    /** Terminal byte cursor to resume from; 0 means "from the start of the retained buffer". */
    since: z.number().int().min(0).optional(),
  }),
  /** Releases this client's attachment. The terminal and the provider keep running. */
  z.strictObject({
    ...requestBase,
    command: z.literal('session.handoff.detach'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
    holderRef: z.string().min(1).max(200),
    since: z.number().int().min(0).optional(),
  }),
  /**
   * Explicit release: writes the terminal's own release byte, waits for the provider process to exit,
   * verifies ownership and the session file, then hands the conversation back to automation. The exit
   * code is recorded but never decides success (Ctrl+D and SIGTERM both exit 0).
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('session.handoff.release'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
    /** Explicitly ask for the conversation to be handed back to RPC after the terminal exits. */
    resumeAutomation: z.boolean().optional(),
  }),
  /** Incremental read of the projected terminal stream (scriptable; the UI uses the same facts). */
  z.strictObject({
    ...requestBase,
    command: z.literal('session.handoff.terminal.read'),
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
    since: z.number().int().min(0).optional(),
  }),
  /** Writes bytes to the running terminal. Input, not a permission: it is not an approval channel. */
  z.strictObject({
    ...requestBase,
    command: z.literal('session.handoff.terminal.write'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
    /** Base64-encoded bytes; a release is the terminal's own Ctrl+D byte, not a Runtime decision. */
    dataBase64: z.string().max(16384),
  }),
  /**
   * Task revision delivery (PROJECT_SPEC §2.11, ADR-0028).
   *
   * `task.revision.create` appends an immutable revision and, when an Execution is holding the Task at
   * that moment, records a *delivery requirement* for it. The requirement is satisfied only by a real
   * acknowledgement from a channel that can acknowledge, or by the stop-and-restart fallback verified
   * against the successor Execution row; the read commands expose every attempt so the state is
   * auditable. `delivery.resolve` is the explicit disposition of an unconfirmed revision and never
   * adds a confirmation step to the normal path.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.revision.create'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    /** Absent means "keep the current specification and only add constraints". */
    specification: nonBlankString.optional(),
    constraints: constraintsSchema.default([]),
    reason: nonBlankString,
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.revision.list'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.revision.delivery.list'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.revision.delivery.get'),
    projectId: z.string().uuid(),
    deliveryId: z.string().uuid(),
  }),
  /**
   * The only explicit disposition of an unconfirmed revision. `STOP_AND_RESTART` cooperatively stops
   * the Execution that cannot be confirmed on the new revision and starts a successor that is recorded
   * with it — the successor row is the proof. `RETRY` re-attempts the conversation channel, and for an
   * Adapter that reports no acknowledgement capability the retry records `CHANNEL_UNSUPPORTED` again
   * rather than claiming a delivery.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.revision.delivery.resolve'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    deliveryId: z.string().uuid(),
    action: z.enum(['STOP_AND_RESTART', 'RETRY']),
    expectedVersion: z.number().int().nonnegative(),
    adapterId: nonBlankString.default('pi'),
  }),
  /**
   * Deterministic conflict analysis (ADR-0031, `docs/architecture/conflict-analyzer.md`).
   *
   * These commands are read-only observations: they derive an ImpactSnapshot from the mapping at the
   * project `main` ref plus the owned worktree's Git change set, persist it append-only, and return
   * the verdict with its stable reason codes and the exact intersecting scope. `UNKNOWN` here means
   * "cannot be proven", never "no conflict found", and nothing on this face ever starts, schedules,
   * or approves a Task — `task schedule` belongs to Wave F and capacity to E2.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('project.impact.validate'),
    path: z.string().min(1),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('project.impact.show'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('project.impact.explain'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
  /**
   * Project Knowledge (FOUNDATION-067 / ADR-0041, `PROJECT_SPEC.md` §4).
   *
   * The human-maintained layers (`.codeestra/instructions`, `.codeestra/skills`) are always read
   * from the project `main` ref — exactly like the verification policy and the impact mapping — so a
   * Task branch can never rewrite the knowledge that judges its own execution. The
   * machine-generated layer is Runtime data (`<CODEESTRA_HOME>/knowledge/<project-id>/generated/`),
   * not something inside the project tree. All four commands are read-only observations: they
   * derive entries and digests and never record a snapshot, materialize a context, or start a Task.
   *
   * `validate` reports every refused entry at once (a layer with any refusal is not a snapshot at
   * all); `show` reads back one recorded snapshot and the Executions bound to it; `list` reports the
   * knowledge declared now plus the snapshot history; `resolve` reports what the next Execution of
   * one Task *would* use, by the same scope rule that Execution would apply.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('project.knowledge.validate'),
    projectId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('project.knowledge.list'),
    projectId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('project.knowledge.show'),
    projectId: z.string().uuid(),
    snapshotId: nonBlankString.optional(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('project.knowledge.resolve'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
  /**
   * Capacity configuration (FOUNDATION-054 / ADR-0032). `get` reports the limits, where each one came
   * from, how many slots are occupied, the stable wait reason a new acquisition would get, and the
   * Runtime's draining fact. `set` writes one limit (project-wide, or one Adapter when `adapterId` is
   * given) and `clear` removes an Adapter override so it follows the project limit again. An invalid
   * value is refused with a stable code instead of being clamped to something plausible.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.capacity.get'),
    projectId: z.string().uuid(),
    adapterId: nonBlankString.optional(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.capacity.set'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    limit: z.number().int(),
    adapterId: nonBlankString.optional(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.capacity.clear'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    adapterId: nonBlankString,
  }),
  /**
   * Slot reservations: the primitive a scheduler reserves with before it prepares a workspace or
   * starts an agent (scheduler.md §3). `acquire` re-checks the Task version, revision, dependency
   * facts, capacity and the draining fact inside one immediate transaction, and either records a
   * reservation with its holder evidence or reports a capacity wait. `release` is explicit and
   * audited; nothing releases a reservation because a heartbeat expired or a client went away.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.reservations.list'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid().optional(),
    includeReleased: z.boolean().default(false),
    limit: z.number().int().min(1).max(maxSlotReservationReadLimit).optional(),
  }),
  /** One reservation with its append-only history: the audit view of a single slot. */
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.reservations.get'),
    projectId: z.string().uuid(),
    reservationId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.reservations.acquire'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedTaskVersion: z.number().int().nonnegative(),
    revisionId: z.string().uuid(),
    adapterId: nonBlankString.default('pi'),
    /**
     * The ImpactSnapshot the caller assessed against. When it is present the reservation rechecks its
     * generation inside the write transaction and refuses with `SNAPSHOT_STALE`/`SNAPSHOT_UNAVAILABLE`
     * instead of reserving on a superseded assessment; when it is absent the caller asserts no
     * assessment at all (the shape an explicitly released `UNKNOWN` has, ADR-0030 D05).
     */
    impactSnapshotId: z.string().uuid().optional(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.reservations.release'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    reservationId: z.string().uuid(),
    reason: nonBlankString,
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.reservations.workspace.prepare'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    reservationId: z.string().uuid(),
    expectedTaskVersion: z.number().int().nonnegative(),
  }),
  /**
   * Runs the startup reconcile of slot reservations explicitly (it also runs on every Runtime start).
   * It re-checks the recorded holder of every active reservation against the real process table and
   * either releases it (holder proven gone) or keeps it occupied (holder alive or unverifiable).
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.reservations.reconcile'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
  }),
  /**
   * The scheduling loop (FOUNDATION-055 / ADR-0030 D04). `status` reports the engine's own facts
   * (active set, capacity, occupancy, the last decisions); `plan` is the ordered dry run of the
   * candidate loop, and `explain` answers "why is this Task not running now" for one Task. None of
   * the three starts, reserves or releases anything. `run` requests a tick — the same loop the
   * Runtime runs on events and on its recovery period — and reports what it decided.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.schedule.status'),
    projectId: z.string().uuid(),
    adapterId: nonBlankString.optional(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.schedule.plan'),
    projectId: z.string().uuid(),
    adapterId: nonBlankString.optional(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.schedule.explain'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    adapterId: nonBlankString.optional(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.schedule.run'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    adapterId: nonBlankString.optional(),
  }),
  /**
   * Records the explicit single-shot release of one Task's `UNKNOWN` assessment without starting it
   * (ADR-0030 D05). The release is bound to the assessed revision, baseline and analyzer/policy
   * versions, is written to the audit ledger, and is consumed by exactly one start. It never
   * rewrites the assessment: the recorded verdict stays `UNKNOWN`.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.schedule.clearUnknown'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
]);
export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;

export const runtimeResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    requestId: z.string(),
    schemaVersion: z.literal(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    requestId: z.string(),
    schemaVersion: z.literal(1),
    ok: z.literal(false),
    /**
     * `detail` is the machine-readable half of a refusal that has facts a code alone cannot carry
     * (today: which generation components moved under a `SNAPSHOT_STALE`). It stays optional and
     * opaque to the envelope: an error without facts is still exactly `{code, message}`.
     */
    error: z.strictObject({ code: z.string(), message: z.string(),
      detail: z.unknown().optional() }),
  }),
]);
export type RuntimeResponse = z.infer<typeof runtimeResponseSchema>;

/**
 * The facts behind a refused reservation (`SNAPSHOT_STALE` / `SNAPSHOT_UNAVAILABLE`): the generation
 * the snapshot recorded, the generation observed now, and which components moved. A client renders
 * it; the Runtime owns it.
 */
export interface SlotSnapshotRefusalDetail {
  readonly code: 'SNAPSHOT_STALE' | 'SNAPSHOT_UNAVAILABLE';
  readonly snapshotId: string;
  readonly taskId: string;
  readonly snapshotTaskId?: string;
  readonly reasonCodes?: readonly string[];
  readonly differing?: readonly string[];
  readonly assessed?: Readonly<Record<string, unknown>>;
  readonly observed?: Readonly<Record<string, unknown>>;
}

export type AdapterSupport = 'SUPPORTED' | 'UNSUPPORTED' | 'REQUIRES_VALIDATION';
export interface AdapterCapabilities {
  readonly persistentSession: AdapterSupport;
  readonly structuredAttention: AdapterSupport;
  readonly nativePermissionRouting: AdapterSupport;
  readonly pauseWithQuiescence: AdapterSupport;
  readonly revisionAcknowledgement: AdapterSupport;
  readonly cooperativeStop: AdapterSupport;
  readonly attach: 'STRUCTURED' | 'PTY' | 'BOTH' | 'UNSUPPORTED';
  /**
   * Whether this provider can be handed over to (and back from) a *native terminal* process on the
   * same conversation, the way ADR-0010/0023/0026 implement for Pi: the Runtime ends the predecessor
   * incarnation, starts a successor provider on the same provider session file and keeps a single
   * writer. `SUPPORTED` states that the measured mechanism exists for this provider — Pi runs its own
   * TUI on a PTY the Runtime owns and reopens the same session file; it does not claim that every
   * mixed permission-mode transition or parallel-tool batch has been re-run (`REQUIRES_VALIDATION`
   * says that instead). `UNSUPPORTED` means handing this provider's conversation to a terminal would
   * be a second writer, so the Runtime must not offer it.
   */
  readonly nativeTerminalHandoff: AdapterSupport;
  /**
   * Whether the provider reports the structured facts a handoff safe point is decided from — tools
   * started and ended, and a settled fact that arrives after the fence — instead of the Runtime
   * having to guess from terminal bytes. Pi's controlled gate extension reports them (ADR-0026).
   * `UNSUPPORTED` means the Runtime cannot know this provider's safe point and must not pretend it
   * does: an unverifiable safe point is refused (`SAFE_POINT_NOT_REACHED`), never assumed.
   */
  readonly safePointNotification: AdapterSupport;
  readonly reconnectToLiveSession: AdapterSupport;
  readonly resumeAfterExit: AdapterSupport;
  /**
   * Whether a controlled launch can exclude ambient user configuration. A provider that always
   * loads its own user config, plugins, MCP servers or hooks changes the Agent's input outside
   * Codeestra's revision snapshot, so the Adapter must say so instead of implying isolation.
   */
  readonly controlledConfiguration: AdapterSupport;
}
/** Provider process evidence. A PID alone is never treated as proof of identity. */
export const agentProcessIdentitySchema = z.strictObject({
  pid: z.number().int().positive(),
  executable: z.string().min(1),
  startToken: z.string().min(1),
  argvHash: z.string().min(1),
  capturedAt: z.number().int().nonnegative(),
});
export type AgentProcessIdentity = z.infer<typeof agentProcessIdentitySchema>;

export interface AgentSessionRef {
  readonly id: string;
  readonly executionId: string;
  readonly adapterId: string;
  readonly providerSessionId?: string;
  readonly processIdentity?: AgentProcessIdentity;
  readonly sessionStorageRef?: string;
}
export interface AgentStartRequest {
  readonly operationId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly workspace: { readonly id: string; readonly cwd: string; readonly ownershipToken: string };
  readonly revision: {
    readonly id: string;
    readonly specification: string;
    readonly constraints: readonly { readonly id: string; readonly text: string }[];
  };
  readonly knowledgeSnapshotRefs: readonly string[];
  readonly permissionMode: 'FULL' | 'STRICT';
  /**
   * Effective Agent configuration for this start, resolved by the Runtime from environment,
   * project, and global scopes. Absent or empty means the Adapter's own default is used.
   */
  readonly agentConfig?: AgentConfiguration;
  /**
   * Set when this Execution continues an earlier paused one. Pi has no in-place resume, so the
   * adapter reopens the predecessor's persistent session file and sends a bounded continuation
   * instead of the full revision prompt.
   */
  readonly resume?: {
    readonly predecessorSessionId: string;
    readonly sessionStorageRef: string;
    readonly providerSessionId: string | null;
  };
  readonly environment: Readonly<Record<string, string>>;
}
export const agentStopEvidenceSchema = z.strictObject({
  ref: z.string().min(1),
  toolsQuiescent: z.literal(true),
  ownedWritersStopped: z.literal(true),
});
export type AgentStopEvidence = z.infer<typeof agentStopEvidenceSchema>;
/**
 * Provider-classified reason for a FAILURE completion. Adapters that can tell why a turn failed
 * report it here so the Runtime can persist a bounded, displayable reason instead of leaving the
 * provider text buried inside an evidence reference.
 */
export const agentTurnFailureSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type AgentTurnFailure = z.infer<typeof agentTurnFailureSchema>;

/**
 * Bounded, provider-reported facts about a completion. They are observations, never judgements:
 * the Runtime (not the Adapter) decides what they mean, and a fact the Adapter cannot report is
 * omitted rather than guessed — an absent `facts` means "unknown", not "no tool call".
 *
 * `toolCallCount` counts the whole observed run behind this completion, not the closing turn, so a
 * run that used a tool and merely ended with a question is not described as "no tool use".
 */
export const agentCompletionFactsSchema = z.strictObject({
  /** Tool invocations the provider reported during this Session run; 0 means it reported none. */
  toolCallCount: z.number().int().nonnegative(),
  /**
   * Tail of the last assistant text of the run, verbatim but bounded to 2000 characters so a
   * provider cannot force an unbounded row. `null` when the run produced no assistant text.
   */
  finalAssistantText: z.string().max(2000).nullable(),
  /** True when `finalAssistantText` is only the tail of a longer provider text. */
  finalAssistantTextTruncated: z.boolean(),
  /** Provider-reported stop reason of that message; `null` when the provider did not say. */
  finalAssistantStopReason: z.string().max(64).nullable(),
});
export type AgentCompletionFacts = z.infer<typeof agentCompletionFactsSchema>;
const observedEventBase = {
  sessionId: z.string().min(1),
  executionId: z.string().min(1),
  eventId: z.string().min(1),
  cursor: z.string().min(1),
};
export const agentObservedEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...observedEventBase,
    type: z.literal('attention'),
    providerRequestId: z.string().min(1),
    kind: z.enum(['QUESTION', 'PERMISSION']),
    responseType: z.enum(['CONFIRM', 'VALUE']),
    prompt: z.unknown(),
  }),
  z.strictObject({
    ...observedEventBase,
    type: z.literal('completed'),
    outcome: z.enum(['SUCCESS', 'FAILURE']),
    /** Only meaningful with `outcome: 'FAILURE'`; absent means the adapter reported no reason. */
    failure: agentTurnFailureSchema.optional(),
    evidence: agentStopEvidenceSchema,
    /**
     * Provider-reported completion facts, or absent when this Adapter cannot report them. The
     * Runtime evaluates them with a deterministic heuristic and records the outcome as a note —
     * a completion is never silently green (FOUNDATION-056).
     */
    facts: agentCompletionFactsSchema.optional(),
  }),
  z.strictObject({
    ...observedEventBase,
    type: z.literal('disconnected'),
    reason: z.string().min(1),
  }),
]);
export type AgentObservedEvent = z.infer<typeof agentObservedEventSchema>;

/** Phase 1 start-only port. */
export interface AgentStartAdapter {
  readonly id: string;
  probe(): Promise<{ readonly version: string; readonly capabilities: AdapterCapabilities }>;
  start(request: AgentStartRequest): Promise<AgentSessionRef>;
}

export interface AgentAnswerRequest {
  readonly operationId: string;
  readonly answerId: string;
  readonly attentionId: string;
  readonly providerRequestId: string;
  readonly responseType: 'CONFIRM' | 'VALUE';
  readonly answer: AgentAnswer;
}
export const agentControlReceiptSchema = z.strictObject({
  providerRequestId: z.string().min(1),
  accepted: z.literal(true),
});
export type AgentControlReceipt = z.infer<typeof agentControlReceiptSchema>;

/** Phase 1 observation subset; control methods are added only with coordinator semantics. */
export interface AgentObserveAdapter extends AgentStartAdapter {
  observe(session: AgentSessionRef, cursor?: string): AsyncIterable<AgentObservedEvent>;
}

/** Answer control is separate so start/observe-only Adapters do not claim unsupported control. */
export interface AgentAnswerAdapter extends AgentObserveAdapter {
  answer(session: AgentSessionRef, request: AgentAnswerRequest): Promise<AgentControlReceipt>;
}

/**
 * Optional capability: an Adapter that owns provider processes can be asked to release one
 * cooperatively. Absence means the Runtime cannot confirm a provider stop and must not
 * pretend that it did.
 */
export interface AgentProcessRelease {
  releaseSession(sessionId: string): Promise<{ readonly exited: boolean; readonly pid: number } | null>;
}

export function supportsProcessRelease(
  adapter: object,
): adapter is AgentProcessRelease {
  return 'releaseSession' in adapter && typeof adapter.releaseSession === 'function';
}
