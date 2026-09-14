import { z } from 'zod';
import { questionnaireAnswerSchema } from './questionnaire.js';
import { verificationPolicyConfirmationSchema } from './verification-policy.js';

export * from './questionnaire.js';
export * from './verification-policy.js';

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
  z.strictObject({
    ...requestBase,
    command: z.literal('task.run'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedTaskVersion: z.number().int().nonnegative(),
    adapterId: nonBlankString.default('pi'),
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
  /** PAUSED Task back to READY and immediately starts a new Execution in the same workspace. */
  z.strictObject({
    ...requestBase,
    command: z.literal('task.resume'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    adapterId: nonBlankString.default('pi'),
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
   * Read-only preview of what a reclamation would remove and why. This is the dry run: it
   * performs no deletion, writes nothing, and returns the same decision shape as `reclaim.apply`.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('reclaim.plan'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid().optional(),
    kinds: z.array(reclaimKindSchema).min(1).optional(),
    /** Failure scenes (failed/conflicted runs, dirty or unmerged worktrees) are retained by default. */
    includeFailureScenes: z.boolean().default(false),
  }),
  /**
   * Executes one reclamation. It removes only Runtime-owned resources whose ownership was verified,
   * keeps every failure scene unless `includeFailureScenes` is set, and never deletes a branch.
   */
  z.strictObject({
    ...requestBase,
    command: z.literal('reclaim.apply'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid().optional(),
    kinds: z.array(reclaimKindSchema).min(1).optional(),
    includeFailureScenes: z.boolean().default(false),
  }),
  /** The append-only ledger of reclamation decisions, newest first. */
  z.strictObject({
    ...requestBase,
    command: z.literal('reclaim.records'),
    projectId: z.string().uuid(),
    taskId: z.string().uuid().optional(),
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
    error: z.strictObject({ code: z.string(), message: z.string() }),
  }),
]);
export type RuntimeResponse = z.infer<typeof runtimeResponseSchema>;

export type AdapterSupport = 'SUPPORTED' | 'UNSUPPORTED' | 'REQUIRES_VALIDATION';
export interface AdapterCapabilities {
  readonly persistentSession: AdapterSupport;
  readonly structuredAttention: AdapterSupport;
  readonly nativePermissionRouting: AdapterSupport;
  readonly pauseWithQuiescence: AdapterSupport;
  readonly revisionAcknowledgement: AdapterSupport;
  readonly cooperativeStop: AdapterSupport;
  readonly attach: 'STRUCTURED' | 'PTY' | 'BOTH' | 'UNSUPPORTED';
  readonly reconnectToLiveSession: AdapterSupport;
  readonly resumeAfterExit: AdapterSupport;
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
