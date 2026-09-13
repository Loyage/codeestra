import { z } from 'zod';
import { verificationPolicyConfirmationSchema } from './verification-policy.js';

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
    expectedIdentity: repositoryIdentitySchema,
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
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.verification.list'),
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
