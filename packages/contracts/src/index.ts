import { z } from 'zod';
import type { AgentPluginSelection } from './agent-plugins.js';
import { questionnaireAnswerSchema } from './questionnaire.js';
import { verificationPolicyConfirmationSchema } from './verification-policy.js';
import { impactPolicyConfirmationSchema } from './impact-policy.js';
import {
  maxProseQuestionAnswerLength,
  maxProseQuestionResolutionNoteLength,
  proseQuestionAttentionModeSchema,
  proseQuestionResolutionSchema,
} from './prose-question.js';
import { uiSettingKeySchema, uiSettingValueSchema } from './ui-settings.js';
import { permissionModeSchema } from './settings.js';

export * from './questionnaire.js';
export * from './verification-policy.js';
export * from './impact-policy.js';
export * from './targeted-test-plan.js';
export * from './prose-question.js';
export * from './ui-settings.js';
export * from './settings.js';
export * from './agent-plugins.js';

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
/**
 * What `project inspect` reports about one dev clone, and what `project trust` verifies before it
 * records one. Every field is an observation: `verified` is false with a stable `code` when the
 * path is not a separate clone of this origin sitting on the project's dev branch, and the partial
 * facts that could be read are reported next to it so a client can say *why* it is unusable.
 */
export const devRepoInspectionSchema = z.strictObject({
  path: z.string().min(1),
  /** The project's dev branch this clone is expected to have checked out. */
  devRef: z.string().min(1),
  verified: z.boolean(),
  /** Stable refusal code when `verified` is false; null otherwise. */
  code: z.string().min(1).nullable(),
  detail: z.string().nullable(),
  repoRoot: z.string().nullable(),
  gitCommonDir: z.string().nullable(),
  headCommit: z.string().nullable(),
  branchRef: z.string().nullable(),
  devRefCommit: z.string().nullable(),
  originUrl: z.string().nullable(),
  originMatchesProject: z.boolean().nullable(),
  clean: z.boolean().nullable(),
});
export type DevRepoInspection = z.infer<typeof devRepoInspectionSchema>;

/**
 * What `project inspect` reports about the *inspected checkout's own* local `dev` branch, and whether
 * that ref still carries anything nobody else has.
 *
 * ADR-0048 D04 kept that branch in the stable checkout as a transitional Task baseline and said it
 * must not be treated as promotion evidence; ADR-0056 stopped reading it (every dev fact now comes
 * from `projects.dev_repo_path`). This report is the read-only evidence for retiring it by hand:
 * `localDevRef*` is a fact about the clone that was inspected, and `remoteRefsContainingLocalDevCommit`
 * (with the derived `publishedOnRemote`) says whether that commit already exists on a remote — the
 * only question that decides whether deleting the local ref can lose history.
 *
 * ADR-0060 removed the old proxy criterion: `projectsWithoutDevRepo` used to mean "these projects'
 * last copy of `dev` is that ref". A project without a dev clone is now a normal, supported state
 * (its Task baselines come from its own folder), so that list is a read-only report and no longer
 * decides anything. It never was — and still is not — a fall back to that ref.
 */
export const devRefRetirementSchema = z.strictObject({
  localDevRefPresent: z.boolean(),
  localDevRefCommit: z.string().nullable(),
  /** Remote-tracking refs (`refs/remotes/...`) whose history contains the local `dev` tip. */
  remoteRefsContainingLocalDevCommit: z.array(z.string()),
  /**
   * True when at least one remote-tracking ref contains the local `dev` tip: the commit is already
   * elsewhere, so deleting this clone's ref removes a local convenience, not history. False for a ref
   * that is absent (nothing to publish) and for a local-only commit (deleting it can lose commits).
   */
  publishedOnRemote: z.boolean(),
  projectsWithoutDevRepo: z.array(z.strictObject({
    projectId: z.string().min(1),
    name: z.string(),
    repoRoot: z.string().min(1),
  })),
});
export type DevRefRetirement = z.infer<typeof devRefRetirementSchema>;

export const projectIdentitySchema = repositoryIdentitySchema.extend({
  devRef: z.string().min(1),
  /**
   * Commit of the **dev clone's** local `dev` ref (ADR-0047 D05 / ADR-0056), or null when the project
   * has no verifiable dev clone. It is part of the identity a client echoes back.
   *
   * ADR-0060: a project without a dev clone is not a broken project — its Task worktrees are based on
   * the project folder's **currently checked out branch** instead, so this field being null changes
   * what `task integrate` / `promotion *` can do (they need the long-lived `dev`), not whether the
   * project works.
   */
  devCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).nullable(),
  devRefPresent: z.boolean(),
  /**
   * The verified dev clone of this project (ADR-0047 D05), or null when none is recorded.
   *
   * It is part of the identity a client echoes back: trust confirms *which* second clone pushes
   * this project's promotion candidate, and a path that changed between inspect and trust is a
   * different fact than the one the user reviewed.
   */
  devRepoPath: devRepoInspectionSchema.nullable(),
  /** Read-only retirement evidence for the stable checkout's transitional local `dev` ref. */
  devRefRetirement: devRefRetirementSchema,
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
  /**
   * The Project this fact belongs to, or `null` for a Runtime-global fact (ADR-0061 D10, schema v34).
   *
   * A global capacity change or a global pause decision is delivered to a Project-filtered
   * subscriber *in addition to* that Project's own events, because it affects every Project. `null`
   * means "belongs to no Project", never "unknown".
   */
  projectId: z.string().min(1).nullable(),
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
 * Upper bound for one IntegrationBatch's members (ADR-0053). A batch is one merge plus one
 * verification, so the bound keeps a single command from turning into an unbounded amount of Git
 * work; it is a request-shape limit, not a policy on how many Tasks may be integrated.
 */
export const maxIntegrationBatchMembers = 32;

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

const nonBlankString = z.string().min(1).refine((value) => value.trim().length > 0, 'Must not be blank');

/**
 * The two Task-level titles (ADR-0065).
 *
 * `displayTitle` is the one line the task list and the task detail render, so it is bounded and
 * explicitly single-line: a summary that wraps is not a summary. `namingTitle` becomes a Git ref
 * component and a directory name, so the accepted shape is the one that is safe in both: lowercase
 * ASCII letters and digits separated by single hyphens, starting with a letter. Both are required at
 * creation and neither is a revision fact — there is no command that changes them afterwards.
 */
export const maxTaskDisplayTitleChars = 200;
export const maxTaskNamingTitleChars = 50;
export const taskNamingTitlePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const taskDisplayTitleSchema = z.string()
  .min(1)
  .max(maxTaskDisplayTitleChars)
  .refine((value) => value.trim().length > 0, 'Must not be blank')
  .refine((value) => !/\r|\n/.test(value), 'A display title must be a single line');
const taskNamingTitleSchema = z.string()
  .min(1)
  .max(maxTaskNamingTitleChars)
  .regex(taskNamingTitlePattern,
    'A naming title is lowercase ASCII, hyphen-separated, and starts with a letter');
/**
 * A declared feature is a module id from the project's `.codeestra/impact.json` (ADR-0059). The
 * schema only bounds the shape — the id is validated against the project's own mapping before it is
 * written, because "which features exist" is a property of the repository, not of this contract.
 */
export const maxTaskFeatures = 32;
export const taskFeaturesSchema = z.array(nonBlankString).max(maxTaskFeatures);
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
  /**
   * Claude Code has no provider launch parameter (the model is chosen with `--model`; the API
   * surface is chosen by the provider's own environment), so this scope deliberately names no
   * provider variable. A configured provider is refused with `INVALID_AGENT_CONFIGURATION` instead
   * of being recorded as applied.
   */
  claude: Object.freeze({
    model: 'CODEESTRA_CLAUDE_MODEL',
    thinkingLevel: 'CODEESTRA_CLAUDE_THINKING',
  }),
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
 * Concurrency capacity and slot reservations (ADR-0061 D01/D02, schema v34).
 *
 * There is **one** limit and it belongs to the whole Runtime: a `CODEESTRA_HOME` is one resource
 * domain, and the number of Tasks occupying a slot is counted across every Project. The former
 * project-wide and per-Adapter ceilings are retired, not hidden: a candidate's Project and Adapter
 * cannot produce a second bound. Nothing here is derived from host resources.
 *
 * A Task that cannot get a slot because of capacity is **waiting**, not blocked: `BLOCKED` is
 * reserved for unmet dependencies (PROJECT_SPEC §2.10), so a capacity wait is expressed as its own
 * stable reason code on the acquisition result and on `scheduler capacity get`.
 */
export const defaultConcurrencyLimit = 2;
/** Lower bound for a configured limit: a limit below one slot is not a smaller number, it is a stop. */
export const minConcurrencyLimit = 1;
/** Upper bound for a configured limit: a typo must be refused, never silently clamped. */
export const maxConcurrencyLimit = 16;
/** Upper bound for one reservation read, so a client cannot ask the Runtime for unbounded rows. */
export const maxSlotReservationReadLimit = 200;

/**
 * Why a Task did not get a slot. These are the codes a scheduler may surface as a *capacity wait*
 * (never as `BLOCKED`); the set is closed so a client can branch on it.
 *
 * `CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` is **historical**: the Adapter-level ceiling it described no
 * longer exists (ADR-0061 D01), so no new event, command result or wait reason carries it. It stays in
 * this union because the ledger and `command_receipts` still hold results that do, and those must
 * remain readable rather than being reinterpreted as a code that never existed.
 */
export type CapacityWaitReasonCode =
  | 'CAPACITY_GLOBAL_LIMIT_REACHED'
  | 'CAPACITY_ADAPTER_SLOT_LIMIT_REACHED'
  | 'SCHEDULER_DRAINING'
  /**
   * ADR-0061 D08: the Runtime's persistent global barrier is up, so no new Execution/Session may
   * start. It is a **wait** (exit code 3), never `BLOCKED`: `BLOCKED` still means exactly one thing —
   * an unmet dependency. It is also not a capacity verdict, so it is checked before capacity.
   */
  | 'SCHEDULER_GLOBALLY_PAUSED';

export interface CapacityWaitReason {
  readonly code: CapacityWaitReasonCode;
  /** The Adapter the acquisition asked for; the Runtime-wide limit itself belongs to no Adapter. */
  readonly adapterId: string | null;
  readonly limit: number | null;
  readonly used: number | null;
  /** Tasks occupying the slots that caused the wait; empty for a draining wait. */
  readonly blocking: readonly string[];
  readonly detail: string;
}

/**
 * The capacity one acquisition is judged against, with where the limit came from.
 *
 * The field names stay `global*` because they *are* the global facts — and the occupancy is now
 * counted across the whole Runtime rather than inside one Project, which is what makes the limit a
 * real total. The former per-Adapter fields are gone: there is no second ceiling to report.
 */
export interface SlotCapacityCheck {
  readonly globalLimit: number;
  readonly globalLimitSource: 'DEFAULT' | 'EXPLICIT';
  readonly globalUsed: number;
  readonly globalBlocking: readonly string[];
}

/**
 * The persistent global control state a capacity query reports alongside the numbers (ADR-0061 D04).
 *
 * The state machine is declared here because it is part of the command-face contract; the persistent
 * pause half of ADR-0061 is implemented by a later change, and until then a Runtime has no barrier to
 * report, which is why `RUNNING` is the honest answer for it.
 */
export type GlobalControlState = 'RUNNING' | 'PAUSING' | 'PAUSED' | 'RESUMING' | 'RECOVERY_REQUIRED';

export interface RuntimePauseStateView {
  readonly state: GlobalControlState;
  readonly pauseEpoch: number;
  readonly detail: string | null;
}

/** One Task occupying a Runtime slot right now, with the facts that made it an occupant. */
export interface CapacityOccupierView {
  readonly projectId: string;
  readonly taskId: string;
  readonly adapterId: string;
  readonly adapterIds: readonly string[];
  readonly reservationId: string | null;
  readonly since: number;
  /** Which fact occupies the slot: a live reservation, or an Execution holding its resource. */
  readonly source: 'RESERVATION' | 'EXECUTION';
  readonly state: 'RESERVED' | 'RECOVERY_REQUIRED' | null;
}

/**
 * The Runtime-wide capacity facts `scheduler capacity get` reports (ADR-0061 D02). The command takes
 * no Project and no Adapter, and the answer lists every occupier across every Project.
 */
export interface RuntimeCapacityView {
  readonly limit: number;
  readonly limitSource: 'DEFAULT' | 'EXPLICIT';
  readonly used: number;
  /** `max(limit - used, 0)`: a lower limit never releases a slot, so `used` may exceed `limit`. */
  readonly available: number;
  /** The code a new acquisition would report right now, or null when a slot is free. */
  readonly waitReason: CapacityWaitReasonCode | null;
  readonly occupiers: readonly CapacityOccupierView[];
  readonly pauseState: RuntimePauseStateView;
  readonly configVersion: number;
  readonly updatedAt: number | null;
  readonly updatedBy: string | null;
  /** Runtime-owned draining fact: new reservations are refused while it is true. */
  readonly draining: boolean;
  readonly drainReason: string | null;
}

/**
 * The per-Project report of the same Runtime-wide capacity, used by `task.schedule.*`. The numbers
 * are global; `projectId` only says which Project asked. There is deliberately no Adapter list left.
 */
export interface ProjectCapacityView {
  readonly projectId: string;
  readonly globalLimit: number;
  readonly globalLimitSource: 'DEFAULT' | 'EXPLICIT';
  readonly globalUsed: number;
  readonly globalAvailable: number;
  readonly globalWaitReason: CapacityWaitReasonCode | null;
  readonly configVersion: number;
  readonly updatedAt: number | null;
  readonly updatedBy: string | null;
  /** Runtime-owned draining fact: new reservations are refused while it is true. */
  readonly draining: boolean;
  readonly drainReason: string | null;
  /** Tasks holding a slot right now, so a client can compute a waiting duration. */
  readonly occupants: readonly { readonly projectId: string; readonly taskId: string;
    readonly reservationId: string | null; readonly adapterId: string;
    readonly adapterIds: readonly string[]; readonly since: number;
    readonly source: 'RESERVATION' | 'EXECUTION' }[];
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
 * capacity reason code and the slots that produced it, and `CONTROL` (ADR-0061 D08) carries the
 * Runtime's own global barrier fact, which is neither of the two. `BLOCKED` is a separate disposition
 * and only ever means an unmet dependency.
 */
export type ScheduleWaitKind = 'CONFLICT' | 'CAPACITY' | 'CONTROL';

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
  /**
   * The feature ids both sides declared, for `SAME_UNFINISHED_FEATURE` (ADR-0059). Empty for the
   * historical codes, which were about paths and declared scopes rather than about a declaration.
   */
  readonly features: readonly string[];
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

/**
 * Why one member of the active/reserved set cannot be observed (ADR-0055 D04).
 *
 * This is a *scheduling* diagnostic code, not an analyzer reason code: it answers "who is occupying a
 * resource and can that occupation even be read?" without changing any verdict. `WORKSPACE_MISSING`
 * is the case where the ledger records a workspace path that is not on disk any more (an external
 * tool moved the worktree, or a reclamation was not observed), which is exactly why no change set can
 * be derived and therefore why the assessment is `UNKNOWN`.
 */
export type ScheduleOccupierCode = 'OBSERVABLE' | 'WORKSPACE_MISSING' | 'WORKSPACE_UNREADABLE'
  | 'NO_WORKSPACE';

export interface ScheduleOccupierView {
  readonly taskId: string;
  readonly taskState: string;
  readonly executionState: string;
  readonly code: ScheduleOccupierCode;
  /** The recorded workspace path, whether or not it exists on disk. */
  readonly workspacePath: string | null;
  readonly detail: string;
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
  /** One entry per active/reserved Task: whether its occupation could be observed at all (D04). */
  readonly occupiers: readonly ScheduleOccupierView[];
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

/**
 * The facts `task.purge` reports (ADR-0058). This is the one command whose success means the Task no
 * longer exists, so the view carries what was destroyed rather than a new state: the final state it
 * was deleted from, the rows deleted per table, the reclaimed resources, and the tip of each branch
 * that was deleted. `replayed: true` says the receipt answered instead of a second deletion.
 */
export interface TaskPurgeOutcomeView {
  readonly projectId: string;
  readonly taskId: string;
  readonly displayNumber: number;
  /** The state the Task was in when it was deleted, after the optional cancel. */
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
    readonly stop: 'TERMINAL' | 'RELEASED' | 'RECOVERED' | 'UNCERTAIN';
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
  /**
   * What `--force` stepped over (ADR-0058 D09); null when `--force` was not requested. Each entry names
   * a refusal an ordinary purge would have ended with, so a forced deletion stays readable as one.
   */
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

/**
 * ADR-0061 D09/D10 — the Runtime global control surface.
 *
 * The state machine is `RUNNING → PAUSING → PAUSED → RESUMING → RUNNING`, with any failure to
 * *verify* an identity, a stop or a resume leading to `RECOVERY_REQUIRED`. It is a control-plane
 * overlay: it never rewrites `Task.state`, `Execution.state` or `AgentSession.state`, and it never
 * releases a slot, a workspace or a writer lease.
 */
/**
 * The control states, under the name the global load control surface uses. It is an alias of
 * `GlobalControlState` (defined with the capacity contract) and deliberately **not** a second union:
 * the capacity report's `pauseState` and the control command's `state` must be the same five values,
 * and two declarations of them would be two things to keep in step.
 */
export type RuntimeGlobalControlState = GlobalControlState;

/** One freeze target's own state (ADR-0061 D10). `RESUMED` and `EXITED` are both settled closures. */
export type RuntimePauseTargetState =
  | 'PENDING' | 'STOPPED' | 'RESUMED' | 'EXITED' | 'RECOVERY_REQUIRED';

/**
 * The stable codes the global control commands return (ADR-0061 D09). They are **not** collapsed into
 * `INVALID_STATE`: a caller has to be able to tell "this platform cannot freeze a provider" from
 * "this target's identity could not be read" from "this target is not stopped", because the remedies
 * differ. `SCHEDULER_GLOBALLY_PAUSED` is a *wait* (CLI exit code 3); every other code is a refusal
 * (exit code 1) and leaves the barrier up.
 */
export type RuntimeGlobalControlCode =
  | 'SCHEDULER_GLOBALLY_PAUSED'
  | 'GLOBAL_PAUSE_UNSUPPORTED'
  | 'GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE'
  | 'GLOBAL_PAUSE_TARGET_NOT_STOPPED'
  | 'GLOBAL_RESUME_TARGET_CHANGED'
  | 'GLOBAL_PAUSE_RECOVERY_REQUIRED'
  /** A `resume` was still in flight; no second state transition is started from `RESUMING`. */
  | 'GLOBAL_CONTROL_IN_PROGRESS';

/**
 * One target's *observed* facts, as the Runtime recorded them. `startToken` is the token read back
 * from the real process at this observation — never the one the freeze was planned with — because
 * comparing the two is the whole point (ADR-0061: PID 复用 must be caught here).
 */
export interface RuntimePauseTargetObservation {
  readonly code: RuntimeGlobalControlCode | 'STOPPED' | 'RESUMED' | 'EXITED' | 'PENDING';
  readonly detail: string;
  readonly observedAt: number;
  /** Null when the recorded process could not be read at all. */
  readonly startToken: string | null;
  /** Whether the recorded identity still matches the live process at the time of observation. */
  readonly identityMatched: boolean;
  /** The raw OS process state the observation is based on (`RUNNING`/`STOPPED`/`EXITED`/`UNKNOWN`). */
  readonly processState: 'RUNNING' | 'STOPPED' | 'EXITED' | 'UNKNOWN';
  /** The Adapter's own `providerProcessSuspension` declaration at the time of the observation. */
  readonly adapterSupport: AdapterSupport | 'ADAPTER_NOT_REGISTERED';
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
  readonly observation: RuntimePauseTargetObservation;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * The whole control-plane picture `scheduler control status` reports: the state and its epoch, who
 * asked and when, and **every** target with its own observation. A caller never has to infer a
 * per-target fact from a global boolean — `PAUSED` is only ever written when every target is
 * `STOPPED` or provably `EXITED` (ADR-0061 D04/D05).
 */
export interface RuntimeGlobalControlView {
  readonly state: RuntimeGlobalControlState;
  readonly pauseEpoch: number;
  readonly version: number;
  readonly requestedAt: number | null;
  readonly requestedBy: string | null;
  readonly settledAt: number | null;
  readonly detail: unknown;
  /** The code this state means, or null while `RUNNING` with nothing recorded. */
  readonly code: RuntimeGlobalControlCode | null;
  /** Whether this platform has the POSIX stop/continue semantics the design requires. */
  readonly platformSupported: boolean;
  readonly platform: string;
  readonly targets: readonly RuntimePauseTargetView[];
  /**
   * The Runtime-global capacity numbers are **not** here. They belong to the capacity command face
   * (`scheduler capacity get`), which is the other half of schema v34 (ADR-0061 D01–D03); inventing
   * fields for them in this projection would create a second, drifting definition.
   */
  readonly capacity: null;
  readonly capacityNote: string;
}

/**
 * The five Events ADR-0061 D10 names, with the aggregate type they are written under and the
 * `project_id = NULL` fact that makes them Runtime-global. `Requested` is never `Paused`, and
 * `ResumeRequested` is never `Resumed`: a partial result is written as
 * `SchedulerGlobalControlRecoveryRequired` instead.
 */
export const schedulerGlobalEventTypes = [
  'SchedulerGlobalPauseRequested',
  'SchedulerGlobalPaused',
  'SchedulerGlobalResumeRequested',
  'SchedulerGlobalResumed',
  'SchedulerGlobalControlRecoveryRequired',
] as const;
export type SchedulerGlobalEventType = (typeof schedulerGlobalEventTypes)[number];
/** Every global control event has this aggregate; its id is the singleton control row. */
export const schedulerGlobalAggregateType = 'RuntimeSchedulerControl';

export const runtimeRequestSchema = z.discriminatedUnion('command', [
  z.strictObject({ ...requestBase, command: z.literal('runtime.ping') }),
  z.strictObject({ ...requestBase, command: z.literal('runtime.stop') }),
  z.strictObject({ ...requestBase, command: z.literal('permission.get') }),
  z.strictObject({
    ...requestBase,
    command: z.literal('permission.set'),
    mode: permissionModeSchema,
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
    /**
     * The plugin/resources this scope selects (ADR-0044). A whole-list override: absent leaves the
     * scope's selection unchanged, `null` clears it, and a selection replaces the lower-precedence
     * scope's list entirely. Nothing is written when any selected path cannot be verified.
     *
     * It is validated *in the handler* with `agentPluginSelectionSchema` rather than here, so a
     * malformed selection is refused with the capability's own stable code
     * (`INVALID_AGENT_PLUGIN_SELECTION`) and its offending paths, instead of a generic request
     * error. The value is still parsed by that strict schema before anything is written.
     */
    pluginSelection: z.union([z.record(z.string(), z.unknown()), z.null()]).optional(),
  }),
  /**
   * Lists every Agent plugin/resource the provider itself has, together with the current selection.
   * Read-only: the Runtime never writes provider configuration and never scans a repository
   * directory (ADR-0044 D05). Adapters that cannot apply a selection report `UNSUPPORTED`.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('agent.plugins.list'),
    adapterId: nonBlankString.default('pi'),
    projectId: z.string().uuid().optional(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('agent.config.clear'),
    adapterId: nonBlankString.default('pi'),
    scope: z.enum(['GLOBAL', 'PROJECT']).default('GLOBAL'),
    projectId: z.string().uuid().optional(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('project.inspect'),
    path: z.string().min(1),
    /**
     * The dev clone to verify, as an explicit input (ADR-0047 D05 / ADR-0060). Omitted, the path
     * recorded by a previous trust is inspected; `null` states "this project has no dev clone"
     * (managed mode); a path is verified instead, so a user can see whether a candidate dev clone
     * is usable before trusting it.
     */
    devRepoPath: z.string().min(1).nullable().optional(),
  }),
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
    /**
     * The dev clone to record (ADR-0047 D05 / ADR-0060). The Runtime verifies it (another clone,
     * same origin, on the dev branch) and refuses with a stable code when it cannot; it never
     * records an empty path in place of one it could not verify.
     *
     * Since ADR-0060 a dev clone is **optional**: omitting the field keeps whatever the project
     * recorded, and `null` states that this project has none — its Task baselines then come from the
     * project folder's checked out branch and `task integrate` / `promotion *` refuse with
     * `DEV_REPO_REQUIRED` because they need the long-lived `dev` branch.
     */
    devRepoPath: z.string().min(1).nullable().optional(),
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
    /** The one-line summary the task list shows (ADR-0065). Required; there is no derived default. */
    displayTitle: taskDisplayTitleSchema,
    /** The Task's name as it appears in its branch and worktree directory (ADR-0065). Required. */
    namingTitle: taskNamingTitleSchema,
    /** The Task detail: the revision body the Agent works from (ADR-0065 D01). */
    specification: nonBlankString,
    /**
     * The features this Task declares (ADR-0059): module ids from the project's
     * `.codeestra/impact.json`. They are validated against that mapping before anything is written,
     * so an undeclared id is refused (`UNKNOWN_FEATURE`) instead of stored. An omitted list means the
     * Task declares no feature, which is why it can never be in a feature conflict.
     */
    features: taskFeaturesSchema.default([]),
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
    /**
     * Explicit Task baseline ref for a **new** workspace (ADR-0060): a local branch of whichever
     * repository provides the baseline — the project's dev clone when one is recorded, otherwise the
     * project folder itself. Omitted, the baseline is the project's default: the dev clone's `dev`,
     * or the project folder's **currently checked out branch**.
     *
     * A Task that already has a workspace keeps the baseline it recorded, so passing this flag there
     * is refused with `TASK_BASE_REF_ALREADY_FIXED` instead of being ignored: "which commit did this
     * Task start from" must never depend on when the command was replayed.
     */
    baseRef: z.string().min(1).optional(),
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
  /**
   * Reconciles a Task whose Execution is `RECOVERY_REQUIRED` from real facts (ADR-0055).
   *
   * The state machine promised this step (`state-machines.md`, `RECOVERY_REQUIRED | reconcile`) but no
   * command face implemented it, which made a provably finished run an unfixable occupier: the Runtime
   * kept its resource held, the conflict analyzer could never observe it, and every new Task of the
   * project waited. This command only *reads* — provider process ownership, the recorded descendant
   * snapshot, and whether the recorded workspace is still on disk — and it refuses, keeping every
   * resource, unless the provider is provably gone. It never signals a process, never deletes or moves
   * a worktree and never claims workspace quiescence.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.recover'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    /** The user's own statement about the reconcile; recorded verbatim in the audit, not judged. */
    reason: nonBlankString.optional(),
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
  /**
   * Permanent deletion (ADR-0058). Unlike `task.archive` this destroys the Task, its revisions,
   * Executions, Sessions, evidence and its owned worktree/branch; it is irreversible and therefore
   * the only command face in the product that requires an explicit `confirmed: true`.
   *
   * The `confirmed` bit is the command's own statement that the caller knows this is destructive, not
   * a permission gate: the Runtime adds no approval step on top of it, and FULL keeps zero
   * confirmations on every normal path. A request without it is refused as
   * `PURGE_CONFIRMATION_REQUIRED` **before** anything is read or stopped.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.purge'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    confirmed: z.boolean(),
    /**
     * `--force` (ADR-0058 D09): step over the refusals that would otherwise stop the deletion — the
     * Runtime tries to terminate a provider it could not prove gone, skips resources whose ownership it
     * cannot prove (leaving those files on disk) and deletes a Task whose commit already reached
     * `dev`/`main`. It is a wider statement by the same caller, not a second approval layer: the Runtime
     * adds no step on top of it, and the outcome plus the audit record what was stepped over.
     */
    force: z.boolean().default(false),
    /** The user's own statement about the deletion; recorded verbatim in the audit, not judged. */
    reason: nonBlankString.optional(),
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
    /** Omitted lists every batch of the project; a multi-member batch spans several Tasks. */
    taskId: z.string().uuid().optional(),
  }),
  /**
   * Composes an IntegrationBatch of one or more members without touching Git (ADR-0053). Every
   * member's current revision and captured result commit are fixed together with the `dev` baseline
   * the batch will be integrated into, so the batch is a statement about the facts that existed when
   * it was composed. `task.integration.integrate` is what merges and verifies it.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.integration.create'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    members: z.array(z.strictObject({
      taskId: z.string().uuid(),
      expectedVersion: z.number().int().nonnegative(),
    })).min(1).max(maxIntegrationBatchMembers),
  }),
  /**
   * Merges every member of a composed batch, runs one independent integration verification over the
   * whole result, and advances `dev` by compare-and-swap only after it PASSes. A member whose
   * revision or result commit moved, or a `dev` that is no longer the recorded baseline, makes the
   * batch `STALE` instead: nothing is merged and the ref keeps its value.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.integration.integrate'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    batchId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.integration.get'),
    projectId: z.string().uuid(),
    batchId: z.string().uuid(),
  }),
  /**
   * Ends a composed batch. It reaches `CANCELLED` only when the record proves no member side effect
   * exists yet; otherwise it becomes `RECOVERY_REQUIRED/RECONCILE_REQUIRED` and keeps its slot,
   * because a merge, a verification or the ref write cannot be confirmed settled from here.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.integration.cancel'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    batchId: z.string().uuid(),
    reason: z.string().trim().min(1).max(1_000).optional(),
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
   * Every Runtime-level setting in one read (ADR-0064): the permission mode, the prose-question
   * switch, the automatic-reclamation switch, the five interface settings and the one concurrency
   * limit. "Which settings exist" is then a fact a client reads instead of a list it maintains, and
   * the CLI's `settings list` and a future UI page cannot disagree about the set or about any value:
   * each entry is filled from the same read the setting's own command uses.
   */
  z.strictObject({ ...requestBase, command: z.literal('settings.list') }),
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
   * Reads and writes the one global switch that decides whether a Task worktree is reclaimed right
   * after its integration succeeds (ADR-0062). It is a setting, not a gate: changing it needs no
   * confirmation, and the explicit `reclaim` command keeps working while it is off.
   */
  z.strictObject({ ...requestBase, command: z.literal('settings.autoReclaim.get') }),
  z.strictObject({
    ...requestBase,
    command: z.literal('settings.autoReclaim.set'),
    enabled: z.boolean(),
  }),
  /**
   * The interface-effect settings (FOUNDATION-073 / ADR-0045): one Runtime home, five keys, no
   * confirmation anywhere. `list` reports every key with its effective value, its product default
   * and whether it was explicitly chosen; `get`/`set` address one key; `reset` drops one explicit
   * choice (or all of them) so the product default applies again. The key and value are enumerated
   * here, so an unknown key or an unsupported value fails validation instead of reaching a file.
   */
  z.strictObject({ ...requestBase, command: z.literal('settings.ui.list') }),
  z.strictObject({
    ...requestBase,
    command: z.literal('settings.ui.get'),
    key: uiSettingKeySchema,
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('settings.ui.set'),
    key: uiSettingKeySchema,
    value: uiSettingValueSchema,
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('settings.ui.reset'),
    /** Absent means every key: that is the documented recovery from an unreadable file. */
    key: uiSettingKeySchema.optional(),
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
   * Advances the promotion by exactly one step of ADR-0047 D01/D03: push the fixed candidate to the
   * remote `dev` and read the remote ref back (reporting `phase: AWAITING_PULL` while the main
   * checkout has not pulled it), then — once the pull is observed — record the restart plan and, when
   * the restart was recorded and checked, push the candidate to the remote `main`. The Runtime never
   * advances a checked-out branch through its ref: `main` moves only when the user pulls it.
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
   * worktree, and then publishes the stable commit to the remote `main`. The submitted boot identity
   * must be the Runtime answering this request and must not be the boot that read the pull and issued
   * the plan, and the step list must match the recorded plan exactly.
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
   * Closes a promotion whose outcome is still open, without touching a ref. Used when the observed
   * state cannot be resumed (for example a `main` checkout moved by hand); the record keeps what was
   * observed rather than claiming nothing happened.
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
   * Changes the size of the PTY the Runtime holds for one Session (ADR-0054).
   *
   * The size is a TerminalTransport fact about the terminal device, not an AdapterEvent and not a
   * permission: the provider learns it from its own descriptor, exactly as it learns the size it was
   * launched with, and no terminal byte is interpreted to decide it. The command answers with the
   * transport's own observation (`applied`) and with the geometry the Runtime now projects
   * (`currentSize` on `session.handoff.status`), so a caller never has to guess whether the provider
   * reflowed.
   *
   * The bound is part of the contract, not a client-side courtesy: a terminal far above this is not a
   * terminal a provider can render, and an unbounded width is a way to make a provider allocate
   * enormous line buffers. `holderRef` is a caller's terminal writer seat: when a client holds the
   * terminal's WRITER attachment, only that holder may change its geometry.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('session.handoff.terminal.resize'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    sessionId: z.string().uuid(),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
    holderRef: z.string().min(1).max(200).optional(),
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
    /** Absent means "keep the current detail and only change the feature declaration" (ADR-0065). */
    specification: nonBlankString.optional(),
    /**
     * The features of the *new* revision. Absent means "inherit the current revision's declaration"
     * (ADR-0059 D03) — amending a specification must not silently drop the Task out of the feature
     * rule. An explicit empty list *does* clear the declaration, which is how a Task stops declaring
     * a feature.
     */
    features: taskFeaturesSchema.optional(),
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
   * The single Runtime-wide capacity limit (ADR-0061 D02). `get` takes no Project and no Adapter:
   * one `CODEESTRA_HOME` is one resource domain, so the answer is the limit, its source, the
   * Runtime-wide occupancy with every occupier, and the stable wait reason a new acquisition would
   * get. `set` writes the only limit there is, and `reset` removes the explicit value so the
   * documented default applies again. Both are zero-confirmation and idempotent: writing the value
   * that is already effective changes nothing and emits no event.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.capacity.get'),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.capacity.set'),
    commandId: z.string().uuid(),
    limit: z.number().int(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.capacity.reset'),
    commandId: z.string().uuid(),
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
   * The Runtime global load-control face (FOUNDATION-097 / ADR-0061 D09). These four are the only
   * commands here that belong to **no Project**: the barrier they control is host-wide, so they
   * carry no `projectId`, their events are written with `project_id = NULL`, and their receipts live
   * in the Runtime-global `runtime_command_receipts` table.
   *
   * `status`/`reconcile` only observe and record. `pause`/`resume` are the explicit user commands
   * themselves: zero confirmation in FULL and STRICT, exactly one state transition each.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.control.status'),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.control.pause'),
    commandId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.control.resume'),
    commandId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('scheduler.control.reconcile'),
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
  /**
   * Session Guidance (FOUNDATION-088 / ADR-0057, `PROJECT_SPEC.md` §2.11 and ADR-0010 D02).
   *
   * Guidance is the *other* input channel: it hands one message to a real provider conversation and
   * changes what the Agent is doing without changing the acceptance specification. It never creates a
   * TaskRevision, never moves `tasks.current_revision_id` and never invalidates a verification run —
   * `task amend` is still the only path that changes the specification, and it still invalidates old
   * evidence.
   *
   * `DELIVERED` in the answer means the provider's own channel **accepted** the message (it is
   * enqueued). It does not mean the model read it, and nothing on this face claims that: ADR-0051
   * measured that no provider here has a channel that can prove it. A provider whose capability is
   * not `SUPPORTED`, or a Task with nothing running, is recorded as exactly that instead.
   *
   * `list` and `get` are read-only: they expose the durable record, its append-only attempt ledger
   * and the artifact each Execution was launched with, so "the guidance survived the process" is
   * readable rather than asserted.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('session.guidance.record'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    /** The guidance text. It is stored durably before delivery and never enters a domain event. */
    message: z.string().min(1).max(16000)
      .refine((value) => value.trim().length > 0, 'Guidance must not be blank'),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('session.guidance.list'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('session.guidance.get'),
    projectId: z.string().uuid(),
    guidanceId: z.string().uuid(),
  }),
]);
export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;

/**
 * One guidance delivery attempt as a client reads it (ADR-0057).
 *
 * `state` is the attempt's own fact. `DELIVERED` means the provider channel accepted the message
 * (enqueued); `capability` records what the Adapter reported at that moment, so "why nothing was
 * sent" stays answerable after the fact.
 */
export interface SessionGuidanceDeliveryView {
  readonly id: string;
  readonly attemptNumber: number;
  readonly channel: 'PROVIDER_CONVERSATION';
  readonly state: 'IN_FLIGHT' | 'DELIVERED' | 'CHANNEL_UNSUPPORTED' | 'TIMED_OUT' | 'FAILED';
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly incarnationId: string | null;
  readonly capability: string | null;
  readonly evidenceRef: string | null;
  readonly errorCode: string | null;
  readonly detail: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/**
 * One durable guidance record as a client reads it. The body travels with the record because the
 * record *is* the durable copy of what the user said (ADR-0010 D02); the domain event does not carry
 * it (ADR-0010 D06).
 */
export interface SessionGuidanceView {
  readonly id: string;
  readonly taskId: string;
  readonly source: 'COMMAND';
  readonly body: string;
  readonly bodyHash: string;
  readonly bodyBytes: number;
  readonly actor: string;
  readonly state: 'RECORDED' | 'DELIVERED' | 'CHANNEL_UNSUPPORTED' | 'TIMED_OUT' | 'FAILED';
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly incarnationId: string | null;
  readonly evidenceRef: string | null;
  readonly deliveryDetail: string | null;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
  readonly attempts: readonly SessionGuidanceDeliveryView[];
}

/** What `session.guidance.record` reports. */
export interface SessionGuidanceRecordView {
  readonly guidance: SessionGuidanceView;
  readonly taskState: string;
  readonly taskVersion: number;
  /** The single conclusion a caller acts on; `RECORDED` means "recorded, not handed over yet". */
  readonly outcome: 'DELIVERED' | 'RECORDED' | 'CHANNEL_UNSUPPORTED' | 'TIMED_OUT' | 'FAILED';
  /** Stable code when the outcome is not a delivery; null on `DELIVERED` and on a plain record. */
  readonly code: string | null;
  readonly detail: string;
  /**
   * Always `UNSUPPORTED`. It is spelled out rather than omitted so a caller cannot read `DELIVERED`
   * as "the model read it": no provider here has a channel that could prove that (ADR-0051).
   */
  readonly modelAcknowledgement: 'UNSUPPORTED';
}

/** The guidance artifact one Execution was launched with. */
export interface ExecutionGuidanceContextView {
  readonly executionId: string;
  readonly guidanceIds: readonly string[];
  readonly guidanceCount: number;
  readonly contextDigest: string;
  readonly contextBytes: number;
  readonly recordedAt: number;
}

/** What `session.guidance.list` reports. */
export interface SessionGuidanceListView {
  readonly taskId: string;
  readonly taskState: string;
  readonly guidance: readonly SessionGuidanceView[];
  readonly launchedWith: readonly ExecutionGuidanceContextView[];
}

/**
 * `task.recover`'s answer (ADR-0055 D01/D03).
 *
 * `outcome` distinguishes the two facts a caller must not confuse: `RECONCILED` changed rows,
 * `ALREADY_RECONCILED` found the Task already out of `RECOVERY_REQUIRED` with a terminal Execution,
 * and `REFUSED` changed nothing. The observation travels with every answer, because "why it refused"
 * is the whole point of the command.
 */
export interface TaskRecoveryView {
  readonly taskId: string;
  readonly displayNumber: number;
  readonly outcome: 'RECONCILED' | 'ALREADY_RECONCILED' | 'REFUSED';
  readonly code: string | null;
  readonly detail: string;
  readonly observation: {
    readonly executionId: string | null;
    readonly sessionId: string | null;
    readonly workspaceId: string | null;
    readonly workspacePath: string | null;
    readonly providerPid: number | null;
    readonly processState: 'STOPPED' | 'ALIVE' | 'DESCENDANTS_ALIVE' | 'UNVERIFIABLE'
      | 'IDENTITY_MISSING';
    readonly descendantRecord: 'RECORDED' | 'MISSING';
    readonly descendantCount: number;
    readonly workspacePresent: boolean;
    readonly quiescenceProven: boolean;
    readonly signalsSent: number;
    readonly evidenceRef: string;
  };
  readonly taskState: string;
  readonly taskVersion: number;
  readonly executionState: string | null;
  readonly reason: string | null;
}

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
  /**
   * Whether this Adapter can load exactly the plugin/resources the user selected (ADR-0044). Pi
   * composes a controlled launch, so it can; Codex and Claude Code have no equivalent, so they say
   * `UNSUPPORTED` instead of a common abstraction being invented over them.
   */
  readonly pluginSelection: AdapterSupport;
  /**
   * Whether this Adapter can hand a guidance message to a **currently running** conversation through
   * the provider's own channel, and observe the fact that the provider accepted it (ADR-0051/0057).
   *
   * `SUPPORTED` means the mechanism exists and was measured: Pi's RPC `steer` answers successfully
   * and the provider reports its own `queue_update`, which is the strongest fact any of the three
   * providers produces — the message is **enqueued**, not read. `REQUIRES_VALIDATION` means a
   * provider primitive plausibly exists (Codex `turn/steer` needs an active turn id this Adapter never
   * holds) but the Adapter has no validated channel. `UNSUPPORTED` means there is no channel at all
   * (Claude Code's print-mode control protocol exposes `initialize`/`interrupt`/`can_use_tool` and
   * nothing that accepts a message into a running turn). A value that is not `SUPPORTED` makes the
   * Runtime record `CHANNEL_UNSUPPORTED` instead of claiming the conversation was told anything.
   *
   * This bit describes the **running conversation** channel only. Handing already-recorded guidance
   * to a *new* Execution at launch is a separate mechanism each Adapter implements where it has a
   * startup channel (ADR-0051's knowledge precedent), and is deliberately not gated by this bit.
   */
  readonly sessionGuidance: AdapterSupport;
  /**
   * Whether this Adapter can name and prove **which controlled process originates this provider's
   * model requests**, so the Runtime can freeze and resume exactly that main process by
   * `pid + OS start token + incarnation` without ever signalling the tool subprocesses that process
   * started (ADR-0061 D05).
   *
   * This is *not* a provider-native pause and it is not `pauseWithQuiescence`: nothing here asks the
   * provider to stop at a safe point, and the frozen Task keeps its Task/Execution/Session state and
   * its capacity slot. `SUPPORTED` claims exactly two things, both measured on real processes:
   * (1) the Adapter's own child process is the model-request origin (so a stopped main process
   * produces no next request), and (2) the tools that child spawned are *its* descendants rather than
   * peers, so the Runtime's signal never reaches them. `REQUIRES_VALIDATION` means the shape looks
   * right but no real measurement exists, and `UNSUPPORTED` means the Adapter cannot prove the
   * ownership at all. A value other than `SUPPORTED` makes a global `pause` fail closed: the target
   * is recorded as `RECOVERY_REQUIRED` and the global barrier stays up, never `PAUSED`.
   */
  readonly providerProcessSuspension: AdapterSupport;
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
/**
 * The materialized Project Knowledge artifact one Execution is bound to (ADR-0041 D05, ADR-0051).
 *
 * It names a file inside the Runtime's own data directory — never a Task worktree path — and the
 * exact bytes the Runtime recorded for this Execution, so an Adapter can verify that what it hands
 * to its provider is the knowledge the Execution actually used. An Adapter that cannot read the file
 * at this digest must refuse to start instead of running the Agent with less input than recorded.
 *
 * The field is optional and additive: an Execution with no knowledge to hand over (no binding, or a
 * binding with zero entries) yields no `knowledgeContext` at all, and its controlled launch stays
 * byte-identical to the launch before this field existed.
 */
export interface AgentKnowledgeContext {
  /** Absolute path of the materialized knowledge context file in the Runtime data directory. */
  readonly filePath: string;
  /** Digest of exactly the bytes that file must contain for this Execution. */
  readonly digest: string;
  /** Size in bytes the file must have; a mismatch is a refusal, not a truncation. */
  readonly bytes: number;
}
/**
 * The materialized Session Guidance artifact one Execution is launched with (ADR-0057).
 *
 * Guidance is a conversation fact, not a specification revision: it is rendered from the guidance
 * records of the Task into a file inside the Runtime's own data directory — never into a Task
 * worktree, and never mixed into the Project Knowledge artifact (the two are different things even
 * though both reach a provider as an appended system prompt). The Adapter is the last component
 * before a provider process sees it, so it verifies the file at this digest and the recorded byte
 * count and refuses to start when either does not hold, with `GUIDANCE_CONTEXT_UNAVAILABLE`.
 */
export interface AgentGuidanceContext {
  /** Absolute path of the materialized guidance context file in the Runtime data directory. */
  readonly filePath: string;
  /** Digest of exactly the bytes that file must contain for this launch. */
  readonly digest: string;
  /** Size in bytes the file must have; a mismatch is a refusal, not a truncation. */
  readonly bytes: number;
  /** The guidance records this artifact was rendered from, oldest first. */
  readonly guidanceIds: readonly string[];
}
export interface AgentStartRequest {
  readonly operationId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly workspace: { readonly id: string; readonly cwd: string; readonly ownershipToken: string };
  readonly revision: {
    readonly id: string;
    /** The Task-level one-line summary; part of every prompt (ADR-0065 D02). */
    readonly displayTitle: string;
    readonly specification: string;
  };
  readonly knowledgeSnapshotRefs: readonly string[];
  /**
   * The knowledge artifact this Execution is bound to, when it has one (ADR-0051). Absent means the
   * Execution resolved no entry to hand over, and the controlled launch must not change.
   */
  readonly knowledgeContext?: AgentKnowledgeContext;
  /**
   * The Session Guidance artifact this Execution is launched with, when the Task has recorded any
   * (ADR-0057). Absent means the Task has no guidance at all, and the controlled launch must stay
   * byte-identical to the launch before this capability — exactly like an absent `knowledgeContext`.
   *
   * It is a *different* artifact from Project Knowledge and is passed as its own append, because the
   * two say different things: knowledge is what the project declares, guidance is what the user just
   * told this conversation. An Adapter that receives this field must verify the file (absolute path,
   * plain file, digest and byte count) and refuse to start when it cannot, with
   * `GUIDANCE_CONTEXT_UNAVAILABLE`.
   */
  readonly guidanceContext?: AgentGuidanceContext;
  /**
   * The plugin/resources this Session may load, exactly as recorded with its Execution (ADR-0044).
   * Absent means the Adapter's controlled default: the same launch as before this capability, with
   * no user resource loaded. An Adapter that cannot verify a selected path must refuse to start.
   */
  readonly pluginSelection?: AgentPluginSelection;
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
