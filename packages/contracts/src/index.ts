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
  // `confirm` is part of the IPC contract so an unconfirmed capture can never reach Git.
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
  readonly permissionMode: 'NATIVE';
  readonly environment: Readonly<Record<string, string>>;
}
export const agentStopEvidenceSchema = z.strictObject({
  ref: z.string().min(1),
  toolsQuiescent: z.literal(true),
  ownedWritersStopped: z.literal(true),
});
export type AgentStopEvidence = z.infer<typeof agentStopEvidenceSchema>;
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
