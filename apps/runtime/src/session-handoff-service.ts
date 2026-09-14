import { createHash } from 'node:crypto';
import { chmodSync, rmSync } from 'node:fs';
import {
  captureProviderProcessTree,
  handoffChannelProtocol,
  inspectProviderProcessOwnership,
  sessionHandoffSocketPath,
  type HandoffChannelCommand,
  type HandoffChannelHello,
  type ProviderProcessTree,
} from '@codeestra/agent-adapters';
import {
  permissionPromptSchema,
  type AgentAnswer,
  type AgentAnswerAdapter,
} from '@codeestra/contracts';
import {
  Phase1Database,
  type SessionHandoffRequestRecord,
  type SessionHandoffState,
  type SessionIncarnationRecord,
  type SessionPermissionRequestRecord,
  type SessionWriterLeaseRecord,
} from '@codeestra/storage';
import { deliverAgentAnswer } from './agent-answer-service.js';

export class SessionHandoffServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SessionHandoffServiceError';
  }
}

/** What one provider incarnation looks like to a client. */
export interface SessionIncarnationView {
  readonly incarnationId: string;
  readonly incarnationNumber: number;
  readonly mode: SessionIncarnationRecord['mode'];
  readonly state: SessionIncarnationRecord['state'];
  readonly providerPid: number | null;
  readonly providerSessionId: string | null;
  readonly sessionStorageRef: string | null;
  readonly predecessorIncarnationId: string | null;
  /** Recorded descendants of the provider, captured while it was still alive. */
  readonly recordedDescendants: number;
  readonly createdAt: number;
  readonly endedAt: number | null;
  readonly exit: unknown;
}

export interface SessionHandoffRequestView {
  readonly requestId: string;
  readonly kind: SessionHandoffRequestRecord['kind'];
  readonly state: SessionHandoffState;
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

export interface SessionHandoffSafePointView {
  readonly reached: boolean;
  readonly fenceAcknowledged: boolean;
  readonly activeTools: number;
  readonly settledAfterFence: boolean;
  readonly openAttention: boolean;
  readonly missing: readonly string[];
}

/**
 * The honest capability statement of this Runtime version. The Runtime-side state, lease, fence and
 * decision routing exist; the PTY transport and the successor process start do not, and no command
 * claims otherwise.
 */
export interface SessionHandoffCapabilities {
  readonly runtimeContract: 'IMPLEMENTED';
  readonly singleWriterLease: 'IMPLEMENTED';
  readonly strictPermissionOverSideChannel: 'IMPLEMENTED';
  readonly nativeTerminalAttach: 'UNSUPPORTED';
  readonly terminalTransport: 'UNIMPLEMENTED';
  readonly successorProcessStart: 'UNIMPLEMENTED';
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
    readonly holderKind: SessionWriterLeaseRecord['holderKind'];
    readonly holderRef: string;
    readonly acquiredAt: number;
  } | null;
  /** The newest handoff request of this Session, whatever state it ended in. */
  readonly handoff: SessionHandoffRequestView | null;
  readonly handoffHistory: readonly SessionHandoffRequestView[];
  readonly safePoint: SessionHandoffSafePointView;
  readonly sideChannel: {
    readonly connected: boolean;
    readonly mode: string | null;
    readonly permissionMode: string | null;
    readonly pid: number | null;
    readonly activeTools: readonly string[];
  } | null;
  /** The permission request a decision can still reach, if one is open. */
  readonly permission: {
    readonly attentionId: string;
    readonly toolName: string;
    readonly toolCallId: string;
    readonly inputFingerprint: string;
    readonly piMode: string;
    readonly decision: SessionPermissionRequestRecord['decision'];
    readonly requestedAt: number;
  } | null;
  /** The newest permission request of any decision, so a denial stays auditable. */
  readonly lastPermission: {
    readonly attentionId: string;
    readonly toolName: string;
    readonly toolCallId: string;
    readonly inputFingerprint: string;
    readonly decision: SessionPermissionRequestRecord['decision'];
    readonly decidedAt: number | null;
    readonly decidedBy: string | null;
  } | null;
  readonly capabilities: SessionHandoffCapabilities;
}

/**
 * The outcome of answering one STRICT permission Attention. `delivery` says whether the decision
 * reached the provider side channel; a `NOT_DELIVERED` answer stays recorded (and retryable, unless
 * its incarnation was superseded) instead of being reported as applied.
 */
export interface PermissionAnswerResult {
  readonly attentionId: string;
  readonly answerId: string;
  readonly operationId: string;
  readonly operationState: string;
  readonly status: string;
  readonly delivery: 'DELIVERED' | 'NOT_DELIVERED';
  readonly decision: string;
  readonly error?: Readonly<{ readonly code: string; readonly message: string }>;
}

export interface SuccessorAdmission {
  readonly admitted: boolean;
  readonly code: string;
  readonly detail: string;
  readonly predecessorObservation: string;
  readonly successorMode: SessionIncarnationRecord['mode'] | null;
  /** This Runtime records the decision; it does not start the successor process. */
  readonly successorStarted: false;
  readonly terminalTransport: 'UNIMPLEMENTED';
}

const capabilities: SessionHandoffCapabilities = Object.freeze({
  runtimeContract: 'IMPLEMENTED',
  singleWriterLease: 'IMPLEMENTED',
  strictPermissionOverSideChannel: 'IMPLEMENTED',
  nativeTerminalAttach: 'UNSUPPORTED',
  terminalTransport: 'UNIMPLEMENTED',
  successorProcessStart: 'UNIMPLEMENTED',
});

type ChannelSocket = Bun.Socket<{ channel: ChannelState }>;

interface ChannelState {
  socket: ChannelSocket | null;
  handshake: boolean;
  hello: HandoffChannelHello | null;
  sessionId: string | null;
  incarnationId: string | null;
  buffer: string;
  activeTools: Map<string, string>;
  /** Business frames that arrived before the Runtime could name this Session's incarnation. */
  pendingLines: string[];
  draining: boolean;
  closed: boolean;
}

/**
 * How long a provider frame may wait for the Runtime to name its Session. A controlled launch can
 * report its first tool before the start transaction has recorded the incarnation, and the provider
 * is blocked on that frame anyway; waiting is the honest behavior, and the deadline keeps a wrong
 * or stale channel from waiting forever.
 */
const defaultChannelResolutionTimeoutMs = 10_000;
const channelResolutionRetryDelayMs = 100;

function hashPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function incarnationView(
  incarnation: SessionIncarnationRecord,
  tree: ProviderProcessTree | null,
): SessionIncarnationView {
  return {
    incarnationId: incarnation.id,
    incarnationNumber: incarnation.incarnationNumber,
    mode: incarnation.mode,
    state: incarnation.state,
    providerPid: incarnation.providerPid,
    providerSessionId: incarnation.providerSessionId,
    sessionStorageRef: incarnation.sessionStorageRef,
    predecessorIncarnationId: incarnation.predecessorIncarnationId,
    recordedDescendants: tree?.descendants.length ?? 0,
    createdAt: incarnation.createdAt,
    endedAt: incarnation.endedAt,
    exit: incarnation.exit,
  };
}

function handoffView(request: SessionHandoffRequestRecord): SessionHandoffRequestView {
  return {
    requestId: request.id,
    kind: request.kind,
    state: request.state,
    incarnationId: request.incarnationId,
    fenceActive: request.fenceActive,
    fenceConfirmedAt: request.fenceConfirmedAt,
    settledAfterFenceAt: request.settledAfterFenceAt,
    safePointAt: request.safePointAt,
    admittedAt: request.admittedAt,
    detail: request.detail,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function processTreeOf(incarnation: SessionIncarnationRecord): ProviderProcessTree | null {
  const tree = incarnation.processTree;
  if (typeof tree !== 'object' || tree === null) return null;
  const candidate = tree as Partial<ProviderProcessTree>;
  if (typeof candidate.pid !== 'number' || typeof candidate.startToken !== 'string'
    || !Array.isArray(candidate.descendants)) return null;
  return candidate as ProviderProcessTree;
}

function processIdentityOf(incarnation: SessionIncarnationRecord): {
  readonly pid: number; readonly startToken: string } | null {
  const identity = incarnation.processIdentity;
  if (typeof identity !== 'object' || identity === null) return null;
  const candidate = identity as { pid?: unknown; startToken?: unknown };
  if (typeof candidate.pid !== 'number' || typeof candidate.startToken !== 'string') return null;
  return { pid: candidate.pid, startToken: candidate.startToken };
}

export interface SessionHandoffServiceOptions {
  readonly storage: Phase1Database;
  readonly runtimeHome: string;
  readonly resolveAdapter: (adapterId: string) => AgentAnswerAdapter;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly permissionMode?: () => 'FULL' | 'STRICT';
  readonly socketPath?: string;
  /** How long a provider frame waits for the Runtime to name its Session (tests use a short one). */
  readonly channelResolutionTimeoutMs?: number;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly readProcessTable?: Parameters<typeof inspectProviderProcessOwnership>[0]['readTable'];
  readonly readStartToken?: Parameters<typeof inspectProviderProcessOwnership>[0]['readStartToken'];
  readonly logger?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

/**
 * Runtime side of the Session handoff contract (ADR-0023).
 *
 * It owns three things the provider cannot provide itself, all measured as missing in
 * FOUNDATION-040:
 *
 * 1. the single writer lease and the ordered incarnation history, because Pi lets two processes
 *    write one session file without an error;
 * 2. the handoff fence and the structured safe-point facts, because the Runtime must not abort a
 *    running tool and must not start a successor while the predecessor's ownership is unclear;
 * 3. the STRICT permission round trip on a side channel that works in every provider mode, so a
 *    decision is an Attention of the existing `attention list`/`attention answer` face and can be
 *    refused when it belongs to an incarnation that is no longer the writer.
 *
 * The PTY transport and the successor process start are *not* implemented here and this service
 * never claims to have done them.
 */
export class SessionHandoffService {
  readonly #storage: Phase1Database;
  readonly #resolveAdapter: (adapterId: string) => AgentAnswerAdapter;
  readonly #permissionMode: () => 'FULL' | 'STRICT';
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #channelResolutionTimeoutMs: number;
  readonly #readProcessTable: SessionHandoffServiceOptions['readProcessTable'];
  readonly #readStartToken: SessionHandoffServiceOptions['readStartToken'];
  readonly #logger: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  readonly #channels = new Map<string, ChannelState>();
  /** Connections that said hello; a Session is only claimed once a frame needs it. */
  readonly #pendingChannels = new Set<ChannelState>();
  #listener: ReturnType<typeof Bun.listen<{ channel: ChannelState }>> | null = null;

  constructor(options: SessionHandoffServiceOptions) {
    this.#storage = options.storage;
    this.#resolveAdapter = options.resolveAdapter;
    this.#permissionMode = options.permissionMode ?? (() => 'FULL');
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#channelResolutionTimeoutMs = options.channelResolutionTimeoutMs
      ?? defaultChannelResolutionTimeoutMs;
    this.#readProcessTable = options.readProcessTable;
    this.#readStartToken = options.readStartToken;
    this.#logger = options.logger ?? (() => {});
    this.socketPath = options.socketPath ?? sessionHandoffSocketPath({
      ...options.environment, CODEESTRA_HOME: options.runtimeHome,
    });
  }

  readonly socketPath: string;

  permissionChannel(): PermissionDecisionChannel {
    return {
      deliverDecision: async (input) => { await this.#deliverDecision(input); },
    };
  }

  /** Opens the side channel socket. A leftover socket file from a crash is removed first. */
  listen(): string {
    if (this.#listener !== null) return this.socketPath;
    rmSync(this.socketPath, { force: true });
    this.#listener = Bun.listen<{ channel: ChannelState }>({
      unix: this.socketPath,
      socket: {
        open: (socket) => {
          const channel: ChannelState = {
            socket,
            handshake: false,
            hello: null,
            sessionId: null,
            incarnationId: null,
            buffer: '',
            activeTools: new Map(),
            pendingLines: [],
            draining: false,
            closed: false,
          };
          socket.data = { channel };
        },
        data: (socket, bytes) => {
          const state = socket.data.channel;
          state.buffer += new TextDecoder().decode(bytes);
          for (let index = state.buffer.indexOf('\n'); index !== -1;
            index = state.buffer.indexOf('\n')) {
            const line = state.buffer.slice(0, index);
            state.buffer = state.buffer.slice(index + 1);
            if (line.trim().length === 0) continue;
            this.#handleFrame(state, line);
          }
        },
        close: (socket) => {
          socket.data.channel.socket = null;
          this.#closeChannel(socket.data.channel);
        },
        error: (socket) => {
          socket.data.channel.socket = null;
          this.#closeChannel(socket.data.channel);
        },
      },
    });
    chmodSync(this.socketPath, 0o600);
    return this.socketPath;
  }

  close(): void {
    this.#listener?.stop(true);
    this.#listener = null;
    this.#channels.clear();
    rmSync(this.socketPath, { force: true });
  }

  /**
   * Records the automation's own incarnation for a Session that just started, from the identity the
   * Adapter already recorded. It is idempotent: the incarnation is keyed by the command ID derived
   * from the Session, so a replayed `task run` cannot create a second one.
   */
  async recordAutomationIncarnation(input: { readonly sessionId: string }): Promise<SessionIncarnationView | null> {
    const session = this.#storage.getAgentSessionIdentity(input.sessionId);
    if (session === null) return null;
    const existing = this.#storage.listSessionIncarnations(input.sessionId);
    if (existing.length > 0) {
      return incarnationView(existing[existing.length - 1] as SessionIncarnationRecord,
        processTreeOf(existing[existing.length - 1] as SessionIncarnationRecord));
    }
    const identity = session.processIdentity as { pid?: unknown; startToken?: unknown } | null;
    const pid = typeof identity?.pid === 'number' ? identity.pid : null;
    const startToken = typeof identity?.startToken === 'string' ? identity.startToken : null;
    let tree: ProviderProcessTree | null = null;
    if (pid !== null && startToken !== null) {
      try {
        tree = await captureProviderProcessTree({
          pid,
          startToken,
          now: this.#now,
          ...(this.#readProcessTable === undefined ? {} : { readTable: this.#readProcessTable }),
          ...(this.#readStartToken === undefined ? {} : { readStartToken: this.#readStartToken }),
        });
      } catch (error) {
        // No tree means a later ownership check cannot clear this process; the refusal is stated
        // at admission time instead of being papered over here.
        this.#logger('provider process tree could not be captured', {
          sessionId: input.sessionId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const write = this.#storage.recordSessionIncarnation({
      id: this.#randomUUID(),
      sessionId: input.sessionId,
      mode: 'AUTOMATED_RPC',
      commandId: `automation:${input.sessionId}`,
      providerPid: pid,
      processIdentity: session.processIdentity,
      processTree: tree,
      providerSessionId: session.providerSessionId,
      sessionStorageRef: session.sessionStorageRef,
      createdAt: this.#now(),
    });
    return incarnationView(write.incarnation, tree);
  }

  status(input: { readonly projectId: string; readonly sessionId: string }): SessionHandoffStatusView {
    const session = this.#requireSession(input.projectId, input.sessionId);
    const incarnations = this.#storage.listSessionIncarnations(input.sessionId);
    const current = this.#storage.getCurrentSessionIncarnation(input.sessionId);
    const lease = this.#storage.getSessionWriterLease(input.sessionId);
    const requests = this.#storage.listSessionHandoffRequests(input.sessionId);
    const handoff = requests.at(-1) ?? null;
    const openHandoff = this.#storage.getOpenSessionHandoffRequest(input.sessionId);
    const permissions = this.#storage.listSessionPermissionRequests(input.sessionId);
    const permission = this.#storage.getOpenSessionPermissionRequest(input.sessionId);
    const channel = this.#findChannel(input.sessionId);
    const fences = openHandoff !== null && openHandoff.fenceActive;
    const missing: string[] = [];
    if (openHandoff === null) missing.push('no open handoff request');
    else {
      if (!openHandoff.fenceActive) missing.push('the provider has not acknowledged the fence');
      if (channel !== null && channel.activeTools.size > 0) {
        missing.push(`${channel.activeTools.size} tool call(s) are still running`);
      }
      if (openHandoff.settledAfterFenceAt === null) missing.push('no settled fact after the fence');
      if (permission !== null) missing.push('an Attention is still open');
    }
    return {
      projectId: session.projectId,
      taskId: session.taskId,
      executionId: session.executionId,
      sessionId: session.sessionId,
      sessionState: session.sessionState,
      executionState: session.executionState,
      permissionMode: this.#permissionMode(),
      providerSessionId: session.providerSessionId,
      sessionStorageRef: session.sessionStorageRef,
      incarnation: current === null ? null : incarnationView(current, processTreeOf(current)),
      incarnations: incarnations.map((incarnation) => incarnationView(incarnation,
        processTreeOf(incarnation))),
      writerLease: lease === null ? null : {
        incarnationId: lease.incarnationId,
        holderKind: lease.holderKind,
        holderRef: lease.holderRef,
        acquiredAt: lease.acquiredAt,
      },
      handoff: handoff === null ? null : handoffView(handoff),
      handoffHistory: requests.map(handoffView),
      safePoint: {
        reached: handoff?.state === 'AT_SAFE_POINT' || handoff?.state === 'ADMITTED',
        fenceAcknowledged: fences,
        activeTools: channel?.activeTools.size ?? 0,
        settledAfterFence: handoff?.settledAfterFenceAt !== null && handoff?.settledAfterFenceAt !== undefined,
        openAttention: permission !== null,
        missing,
      },
      sideChannel: channel === null ? null : {
        connected: true,
        mode: channel.hello?.mode ?? null,
        permissionMode: channel.hello?.permissionMode ?? null,
        pid: channel.hello?.pid ?? null,
        activeTools: [...channel.activeTools.values()],
      },
      permission: permission === null ? null : {
        attentionId: permission.attentionId,
        toolName: permission.toolName,
        toolCallId: permission.toolCallId,
        inputFingerprint: permission.inputFingerprint,
        piMode: permission.piMode,
        decision: permission.decision,
        requestedAt: permission.requestedAt,
      },
      lastPermission: permissions.length === 0 ? null : (() => {
        const latest = permissions[permissions.length - 1] as SessionPermissionRequestRecord;
        return {
          attentionId: latest.attentionId,
          toolName: latest.toolName,
          toolCallId: latest.toolCallId,
          inputFingerprint: latest.inputFingerprint,
          decision: latest.decision,
          decidedAt: latest.decidedAt,
          decidedBy: latest.decidedBy,
        };
      })(),
      capabilities,
    };
  }

  /**
   * Takes the single writer lease for one Session. A second holder is refused with
   * `ATTACHMENT_BUSY` and the current holder named — never queued, never approved.
   */
  acquireWriterLease(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly holderKind: SessionWriterLeaseRecord['holderKind'];
    readonly holderRef: string;
    readonly commandId: string;
  }): SessionHandoffStatusView {
    this.#requireSession(input.projectId, input.sessionId);
    const current = this.#storage.getCurrentSessionIncarnation(input.sessionId);
    if (current === null) {
      throw new SessionHandoffServiceError('SESSION_INCARNATION_UNAVAILABLE',
        'This Session has no current provider incarnation; the Runtime cannot name the writer');
    }
    const acquisition = this.#storage.acquireSessionWriterLease({
      sessionId: input.sessionId,
      incarnationId: current.id,
      holderKind: input.holderKind,
      holderRef: input.holderRef,
      commandId: input.commandId,
      acquiredAt: this.#now(),
    });
    if (!acquisition.acquired) {
      const holder = acquisition.holder;
      throw new SessionHandoffServiceError(acquisition.code as string,
        acquisition.code === 'ATTACHMENT_BUSY'
          ? `Session ${input.sessionId} already has a writer: ${holder?.holderKind} holder`
            + ` ${holder?.holderRef} acquired the lease at ${holder?.acquiredAt}`
          : `Cannot take the writer lease: ${acquisition.code}`);
    }
    return this.status({ projectId: input.projectId, sessionId: input.sessionId });
  }

  releaseWriterLease(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly holderRef: string;
    readonly reason?: string;
  }): { readonly released: boolean; readonly code: string } {
    this.#requireSession(input.projectId, input.sessionId);
    const result = this.#storage.releaseSessionWriterLease({
      sessionId: input.sessionId,
      holderRef: input.holderRef,
      reason: input.reason ?? 'released by the CLI',
      releasedAt: this.#now(),
    });
    return result;
  }

  /** Persists the takeover/return intent and installs the handoff fence on the live incarnation. */
  requestHandoff(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly kind: SessionHandoffRequestRecord['kind'];
    readonly commandId: string;
  }): SessionHandoffStatusView {
    const session = this.#requireSession(input.projectId, input.sessionId);
    const current = this.#storage.getCurrentSessionIncarnation(input.sessionId);
    if (current === null) {
      throw new SessionHandoffServiceError('SESSION_INCARNATION_UNAVAILABLE',
        'This Session has no current provider incarnation to hand over');
    }
    const lease = this.#storage.getSessionWriterLease(input.sessionId);
    if (input.kind === 'TAKEOVER' && lease !== null && lease.holderKind === 'TERMINAL_ATTACHMENT'
      && lease.incarnationId !== current.id) {
      throw new SessionHandoffServiceError('ATTACHMENT_BUSY',
        `Another terminal already holds the writer lease for this Session (${lease.holderRef})`);
    }
    const write = this.#storage.recordSessionHandoffRequest({
      id: this.#randomUUID(),
      sessionId: input.sessionId,
      executionId: session.executionId,
      incarnationId: current.id,
      kind: input.kind,
      commandId: input.commandId,
      createdAt: this.#now(),
    });
    const channel = this.#findChannel(input.sessionId);
    if (channel !== null && !write.replayed) {
      this.#send(channel, { kind: 'fence', active: true });
    }
    return this.status({ projectId: input.projectId, sessionId: input.sessionId });
  }

  /** Releases an abandoned handoff's fence so the Agent can use tools again. */
  cancelHandoff(input: {
    readonly projectId: string;
    readonly sessionId: string;
  }): SessionHandoffStatusView {
    this.#requireSession(input.projectId, input.sessionId);
    const open = this.#storage.getOpenSessionHandoffRequest(input.sessionId);
    if (open === null) {
      throw new SessionHandoffServiceError('HANDOFF_NOT_REQUESTED',
        'This Session has no open handoff request');
    }
    this.#storage.cancelSessionHandoffRequest({
      requestId: open.id,
      at: this.#now(),
      detail: 'cancelled by the CLI; the fence was released',
    });
    const channel = this.#findChannel(input.sessionId);
    if (channel !== null) this.#send(channel, { kind: 'fence', active: false });
    return this.status({ projectId: input.projectId, sessionId: input.sessionId });
  }

  /**
   * Decides whether a successor incarnation may be started, from recorded facts only. It never
   * starts a process and never moves the lease: a successor that is admitted still needs the
   * terminal transport, which this Runtime version does not implement.
   */
  async admitSuccessor(input: {
    readonly projectId: string;
    readonly sessionId: string;
  }): Promise<SuccessorAdmission> {
    this.#requireSession(input.projectId, input.sessionId);
    const refusal = (code: string, detail: string, observation = 'NOT_CHECKED'): SuccessorAdmission => ({
      admitted: false, code, detail, predecessorObservation: observation,
      successorMode: null, successorStarted: false, terminalTransport: 'UNIMPLEMENTED',
    });
    const request = this.#storage.getOpenSessionHandoffRequest(input.sessionId);
    if (request === null) {
      return refusal('HANDOFF_NOT_REQUESTED', 'No handoff request is open for this Session');
    }
    const view = this.status({ projectId: input.projectId, sessionId: input.sessionId });
    if (!view.safePoint.reached) {
      return refusal('SAFE_POINT_NOT_REACHED',
        `The handoff has not reached its safe point: ${view.safePoint.missing.join('; ')}`);
    }
    if (view.permission !== null) {
      return refusal('WAITING_FOR_ATTENTION',
        `Attention ${view.permission.attentionId} is still open; answer or cancel it first`);
    }
    const incarnation = this.#storage.getSessionIncarnation(request.incarnationId);
    if (incarnation === null) {
      return refusal('INCARNATION_UNKNOWN', 'The handoff names an incarnation that no longer exists');
    }
    const lease = this.#storage.getSessionWriterLease(input.sessionId);
    if (lease !== null && lease.incarnationId !== incarnation.id) {
      return refusal('ATTACHMENT_BUSY',
        `Writer lease is held by ${lease.holderRef} for incarnation ${lease.incarnationId}`);
    }
    const tree = processTreeOf(incarnation);
    if (tree === null) {
      return refusal('PREDECESSOR_EVIDENCE_MISSING',
        'No provider process tree was captured while the predecessor was alive, so its descendants'
        + ' cannot be cleared: refusing to start a successor', 'UNKNOWN');
    }
    const observation = await inspectProviderProcessOwnership({
      tree,
      ...(this.#readProcessTable === undefined ? {} : { readTable: this.#readProcessTable }),
      ...(this.#readStartToken === undefined ? {} : { readStartToken: this.#readStartToken }),
    });
    if (observation.state === 'ALIVE') {
      return refusal('PREDECESSOR_NOT_STOPPED', observation.detail, 'ALIVE');
    }
    if (observation.state === 'DESCENDANTS_ALIVE') {
      return refusal('PREDECESSOR_DESCENDANTS_ALIVE', observation.detail, 'DESCENDANTS_ALIVE');
    }
    if (observation.state === 'UNVERIFIABLE') {
      return refusal('PREDECESSOR_UNVERIFIED', observation.detail, 'UNVERIFIABLE');
    }
    this.#storage.markSessionHandoffAdmitted({
      requestId: request.id,
      at: this.#now(),
      detail: `safe point reached and the predecessor is quiescent: ${observation.detail}`,
    });
    return {
      admitted: true,
      code: 'ADMITTED',
      detail: 'The Runtime-side preconditions are satisfied; the terminal transport is not'
        + ' implemented in this Runtime version, so no successor process was started and the writer'
        + ' lease was not moved',
      predecessorObservation: observation.state,
      successorMode: incarnation.mode === 'AUTOMATED_RPC' ? 'HUMAN_TUI' : 'AUTOMATED_RPC',
      successorStarted: false,
      terminalTransport: 'UNIMPLEMENTED',
    };
  }

  /** True when this Attention came from the Runtime side channel rather than a provider dialog. */
  isPermissionAttention(attentionId: string): boolean {
    return this.#storage.getSessionPermissionRequest(attentionId) !== null;
  }

  /**
   * Records the user's answer and routes it to the incarnation that asked. A decision for an
   * incarnation that is no longer current is refused by the atomic claim in storage, and the
   * answered Operation is marked failed instead of retryable, because it can never be applied.
   */
  async answerPermission(input: {
    readonly projectId: string;
    readonly attentionId: string;
    readonly commandId: string;
    readonly answer: AgentAnswer;
    readonly actor: string;
  }): Promise<PermissionAnswerResult> {
    const attention = this.#storage.getAttentionRequest(input.projectId, input.attentionId);
    if (attention === null) {
      throw new SessionHandoffServiceError('NOT_FOUND', 'Open Attention request was not found');
    }
    const permission = this.#storage.getSessionPermissionRequest(input.attentionId);
    if (permission === null) {
      throw new SessionHandoffServiceError('NOT_A_PERMISSION_ATTENTION',
        'This Attention is not a Runtime side-channel permission request');
    }
    if (input.answer.type !== 'CONFIRM' && input.answer.type !== 'CANCEL') {
      throw new SessionHandoffServiceError('INVALID_STATE',
        `A STRICT permission Attention needs a CONFIRM or CANCEL answer, got ${input.answer.type}`);
    }
    const planned = this.#storage.planAttentionAnswer({
      projectId: input.projectId,
      attentionId: input.attentionId,
      commandId: input.commandId,
      payloadHash: hashPayload({ projectId: input.projectId, attentionId: input.attentionId,
        answer: input.answer }),
      intentId: this.#randomUUID(),
      answerId: this.#randomUUID(),
      operationId: this.#randomUUID(),
      answer: input.answer,
      intentEventId: this.#randomUUID(),
      recordedEventId: this.#randomUUID(),
      actor: input.actor,
      recordedAt: this.#now(),
    });
    try {
      const delivered = await deliverAgentAnswer({
        storage: this.#storage,
        adapter: this.#resolveAdapter(planned.adapterId),
        operationId: planned.operationId,
        permissionChannel: this.permissionChannel(),
        now: this.#now,
        randomUUID: this.#randomUUID,
      });
      return {
        attentionId: planned.id,
        answerId: planned.answerId,
        operationId: planned.operationId,
        operationState: delivered.operationState,
        status: delivered.status,
        delivery: 'DELIVERED',
        decision: this.#storage.getSessionPermissionRequest(input.attentionId)?.decision ?? 'UNKNOWN',
      };
    } catch (error) {
      const plan = this.#storage.getAgentAnswerPlan(planned.operationId);
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'PERMISSION_ANSWER_FAILED';
      return {
        attentionId: planned.id,
        answerId: planned.answerId,
        operationId: planned.operationId,
        operationState: plan.operationState,
        status: plan.status,
        delivery: 'NOT_DELIVERED',
        decision: this.#storage.getSessionPermissionRequest(input.attentionId)?.decision ?? 'UNKNOWN',
        error: { code, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  // -------------------------------------------------------------------------------------------
  // Side channel
  // -------------------------------------------------------------------------------------------

  #handleFrame(state: ChannelState, line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.#reject(state, 'INVALID_FRAME', 'The side channel frame was not valid JSON');
      return;
    }
    if (frame['kind'] === 'hello') {
      if (state.handshake) {
        this.#reject(state, 'DUPLICATE_HELLO', 'This connection already said hello');
        return;
      }
      if (frame['protocol'] !== handoffChannelProtocol) {
        this.#reject(state, 'PROTOCOL_MISMATCH',
          `This Runtime speaks handoff channel protocol ${handoffChannelProtocol}`);
        return;
      }
      state.handshake = true;
      state.hello = {
        kind: 'hello',
        protocol: handoffChannelProtocol,
        mode: typeof frame['mode'] === 'string' ? frame['mode'] : 'unknown',
        hasUI: frame['hasUI'] === true,
        permissionMode: frame['permissionMode'] === 'STRICT' ? 'STRICT' : 'FULL',
        pid: typeof frame['pid'] === 'number' ? frame['pid'] : 0,
        providerSessionId: typeof frame['providerSessionId'] === 'string'
          ? frame['providerSessionId'] : null,
        providerSessionFile: typeof frame['providerSessionFile'] === 'string'
          ? frame['providerSessionFile'] : null,
      };
      this.#pendingChannels.add(state);
      this.#send(state, { kind: 'welcome', fenceActive: false });
      return;
    }
    if (!state.handshake || state.hello === null) {
      this.#reject(state, 'HANDSHAKE_REQUIRED', 'The first frame on this channel must be hello');
      return;
    }
    // A controlled launch says hello during `session_start`, which can be *before* the Runtime has
    // recorded the provider identity and incarnation. Frames are therefore queued and applied in
    // order once the Session can be named, instead of being dropped or rejected in that window.
    state.pendingLines.push(line);
    void this.#drainFrames(state);
  }

  /**
   * Resolves the Session for one channel and applies its queued frames in arrival order. A frame
   * is never applied to a Session the Runtime cannot name: the provider waits, and a hard identity
   * mismatch (a different pid or session file) closes the channel instead of being retried.
   */
  async #drainFrames(state: ChannelState): Promise<void> {
    if (state.draining) return;
    state.draining = true;
    try {
      while (state.pendingLines.length > 0 && !state.closed) {
        const resolved = await this.#resolveWithRetry(state);
        if (resolved === null) return;
        const line = state.pendingLines.shift() as string;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.#reject(state, 'INVALID_FRAME', 'The side channel frame was not valid JSON');
          return;
        }
        this.#applyBusinessFrame(state, frame, resolved);
      }
    } finally {
      state.draining = false;
    }
  }

  /**
   * Waits for the Runtime's own start transaction to finish before naming the Session. Only the
   * two "not knowable yet" outcomes are retried; identity mismatches fail immediately.
   */
  async #resolveWithRetry(state: ChannelState): Promise<{
    readonly sessionId: string; readonly executionId: string;
    readonly incarnation: SessionIncarnationRecord } | null> {
    const deadline = this.#now() + this.#channelResolutionTimeoutMs;
    while (!state.closed) {
      const attempt = this.#resolveChannel(state);
      if (attempt.ok) return attempt.resolved;
      if (!attempt.retryable || this.#now() >= deadline) {
        this.#reject(state, attempt.code, attempt.message);
        return null;
      }
      await Bun.sleep(channelResolutionRetryDelayMs);
    }
    return null;
  }

  #applyBusinessFrame(
    state: ChannelState,
    frame: Record<string, unknown>,
    resolved: { readonly sessionId: string; readonly executionId: string;
      readonly incarnation: SessionIncarnationRecord },
  ): void {
    if (frame['kind'] === 'tool_start') {
      const toolCallId = typeof frame['toolCallId'] === 'string' ? frame['toolCallId'] : null;
      const toolName = typeof frame['toolName'] === 'string' ? frame['toolName'] : 'unknown';
      if (toolCallId !== null) state.activeTools.set(toolCallId, toolName);
      return;
    }
    if (frame['kind'] === 'tool_end') {
      const toolCallId = typeof frame['toolCallId'] === 'string' ? frame['toolCallId'] : null;
      if (toolCallId !== null) state.activeTools.delete(toolCallId);
      this.#evaluateSafePoint(resolved.sessionId, state);
      return;
    }
    if (frame['kind'] === 'agent_settled') {
      const open = this.#storage.getOpenSessionHandoffRequest(resolved.sessionId);
      if (open !== null && open.fenceActive) {
        try {
          this.#storage.recordSessionHandoffSettled({ requestId: open.id, at: this.#now() });
        } catch (error) {
          this.#logger('settled fact did not match a fenced handoff request', {
            sessionId: resolved.sessionId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.#evaluateSafePoint(resolved.sessionId, state);
      return;
    }
    if (frame['kind'] === 'fence_ack') {
      const active = frame['active'] === true;
      const open = this.#storage.getOpenSessionHandoffRequest(resolved.sessionId);
      if (open === null) return;
      if (active) {
        try {
          this.#storage.confirmSessionHandoffFence({ requestId: open.id, at: this.#now() });
        } catch (error) {
          this.#logger('fence acknowledgement did not match a requested handoff', {
            sessionId: resolved.sessionId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        this.#evaluateSafePoint(resolved.sessionId, state);
      } else if (open.state !== 'CANCELLED') {
        this.#storage.cancelSessionHandoffRequest({
          requestId: open.id,
          at: this.#now(),
          detail: 'the provider reported the fence as inactive',
        });
      }
      return;
    }
    if (frame['kind'] === 'permission_request') {
      this.#recordPermissionRequest(state, frame, resolved);
      return;
    }
  }

  #recordPermissionRequest(
    state: ChannelState,
    frame: Record<string, unknown>,
    resolved: { readonly sessionId: string; readonly executionId: string;
      readonly incarnation: SessionIncarnationRecord },
  ): void {
    const requestId = typeof frame['requestId'] === 'string' ? frame['requestId'] : null;
    const toolCallId = typeof frame['toolCallId'] === 'string' ? frame['toolCallId'] : null;
    const toolName = typeof frame['toolName'] === 'string' ? frame['toolName'] : null;
    const inputJson = typeof frame['inputJson'] === 'string' ? frame['inputJson'] : null;
    const inputFingerprint = typeof frame['inputFingerprint'] === 'string'
      ? frame['inputFingerprint'] : null;
    if (requestId === null || toolCallId === null || toolName === null || inputJson === null
      || inputFingerprint === null) {
      this.#reject(state, 'INVALID_PERMISSION_REQUEST',
        'A permission request needs requestId, toolCallId, toolName, inputJson and inputFingerprint');
      return;
    }
    if (resolved.incarnation.state === 'RECOVERY_REQUIRED' || resolved.incarnation.state === 'EXITED') {
      this.#denyPermissionRequest(state, requestId,
        `incarnation ${resolved.incarnation.incarnationNumber} is ${resolved.incarnation.state}`);
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(inputJson) as unknown;
    } catch {
      this.#reject(state, 'INVALID_PERMISSION_REQUEST',
        'The permission request input was not valid JSON');
      return;
    }
    const requestedAt = this.#now();
    const prompt = permissionPromptSchema.parse({
      kind: 'codeestra.permission',
      version: 1,
      sessionId: resolved.sessionId,
      incarnationId: resolved.incarnation.id,
      incarnationNumber: resolved.incarnation.incarnationNumber,
      toolCallId,
      toolName,
      input,
      inputFingerprint,
      piMode: state.hello?.mode ?? 'unknown',
      requestedAt,
    });
    try {
      const write = this.#storage.recordSessionPermissionRequest({
        id: this.#randomUUID(),
        sessionId: resolved.sessionId,
        executionId: resolved.executionId,
        incarnationId: resolved.incarnation.id,
        providerRequestId: requestId,
        providerEventId: `handoff-permission:${requestId}`,
        cursor: `handoff:${resolved.incarnation.incarnationNumber}:${requestId}`,
        toolCallId,
        toolName,
        inputJson,
        inputFingerprint,
        piMode: state.hello?.mode ?? 'unknown',
        prompt,
        attentionId: this.#randomUUID(),
        attentionEventId: this.#randomUUID(),
        executionEventId: this.#randomUUID(),
        taskEventId: this.#randomUUID(),
        requestedAt,
      });
      if (write.duplicate) {
        // A replayed request keeps the Attention it already has; the decision is written once.
        this.#logger('duplicate permission request ignored', { sessionId: resolved.sessionId, requestId });
      }
      return;
    } catch (error) {
      // The request could not become an Attention (for example the Session is not in a state that
      // admits one). That tool call is refused with a stated reason, but the channel stays open:
      // killing it would turn one unrecordable call into "no approval channel" for the whole run.
      this.#denyPermissionRequest(state, requestId,
        error instanceof Error ? error.message : String(error));
    }
  }

  /** Fail-closed refusal of one permission request, with the Runtime's own reason. */
  #denyPermissionRequest(state: ChannelState, requestId: string | null, reason: string): void {
    if (requestId === null) return;
    this.#logger('permission request was refused without a decision', { reason });
    this.#send(state, { kind: 'permission_decision', requestId, decision: 'DENY',
      reason: `Codeestra could not record this permission request: ${reason}` });
  }

  #evaluateSafePoint(sessionId: string, state: ChannelState): void {
    const open = this.#storage.getOpenSessionHandoffRequest(sessionId);
    if (open === null || open.state !== 'FENCED' || !open.fenceActive) return;
    if (state.activeTools.size > 0) return;
    if (open.settledAfterFenceAt === null) return;
    if (this.#storage.getOpenSessionPermissionRequest(sessionId) !== null) return;
    try {
      this.#storage.recordSessionHandoffSafePoint({
        requestId: open.id,
        at: this.#now(),
        detail: `fence acknowledged; ${state.activeTools.size} active tool(s); settled after the fence;`
          + ' no Attention is open',
      });
    } catch (error) {
      this.#logger('safe point could not be recorded', {
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #resolveChannel(state: ChannelState):
    | { readonly ok: true; readonly resolved: { readonly sessionId: string;
        readonly executionId: string; readonly incarnation: SessionIncarnationRecord } }
    | { readonly ok: false; readonly code: string; readonly message: string;
        readonly retryable: boolean } {
    if (state.sessionId !== null && state.incarnationId !== null) {
      const incarnation = this.#storage.getSessionIncarnation(state.incarnationId);
      if (incarnation !== null) {
        return { ok: true, resolved: { sessionId: state.sessionId,
          executionId: incarnation.executionId, incarnation } };
      }
      state.sessionId = null;
      state.incarnationId = null;
    }
    const providerSessionId = state.hello?.providerSessionId ?? null;
    if (providerSessionId === null) {
      return { ok: false, retryable: false, code: 'SESSION_UNKNOWN',
        message: 'The side channel hello did not report a provider session id' };
    }
    const found = this.#storage.findSessionByProviderIdentity({ providerSessionId });
    if (found === null) {
      return { ok: false, retryable: true, code: 'SESSION_UNKNOWN',
        message: `No live Agent Session matches provider session ${providerSessionId} yet` };
    }
    const incarnation = this.#storage.getCurrentSessionIncarnation(found.sessionId);
    if (incarnation === null) {
      // Deliberately no optimistic recovery: without a current incarnation the Runtime does not
      // know which process it is talking to, so it never creates a writer for it.
      return { ok: false, retryable: true, code: 'SESSION_INCARNATION_UNAVAILABLE',
        message: 'This Session has no current provider incarnation yet; the Runtime will not adopt'
          + ' an unknown provider process' };
    }
    const identity = processIdentityOf(incarnation);
    if (identity !== null && state.hello !== null && state.hello.pid > 0
      && state.hello.pid !== identity.pid) {
      return { ok: false, retryable: false, code: 'PROCESS_IDENTITY_MISMATCH',
        message: `The side channel reports pid ${state.hello.pid} but incarnation`
          + ` ${incarnation.incarnationNumber} was recorded with pid ${identity.pid}` };
    }
    if (state.hello !== null && state.hello.providerSessionFile !== null
      && incarnation.sessionStorageRef !== null
      && state.hello.providerSessionFile !== incarnation.sessionStorageRef) {
      return { ok: false, retryable: false, code: 'SESSION_FILE_MISMATCH',
        message: 'The side channel reports a different provider session file than this incarnation'
          + ' owns' };
    }
    const existing = this.#channels.get(found.sessionId);
    if (existing !== undefined && existing !== state) {
      return { ok: false, retryable: false, code: 'CHANNEL_ALREADY_OPEN',
        message: 'This Session already has an open side channel connection' };
    }
    state.sessionId = found.sessionId;
    state.incarnationId = incarnation.id;
    this.#pendingChannels.delete(state);
    this.#channels.set(found.sessionId, state);
    const open = this.#storage.getOpenSessionHandoffRequest(found.sessionId);
    if (open !== null && open.fenceActive) this.#send(state, { kind: 'fence', active: true });
    return { ok: true, resolved: { sessionId: found.sessionId,
      executionId: found.executionId, incarnation } };
  }

  async #deliverDecision(input: {
    readonly sessionId: string;
    readonly incarnationId: string;
    readonly providerRequestId: string;
    readonly decision: 'ALLOW' | 'DENY' | 'CANCEL';
  }): Promise<void> {
    const state = this.#channels.get(input.sessionId) ?? null;
    if (state === null) {
      // Only a resolved connection may carry a decision: an unresolved one cannot be proven to be
      // the incarnation that asked.
      throw new SessionHandoffServiceError('PERMISSION_CHANNEL_UNAVAILABLE',
        'No side channel connection is open for this Session; the decision was not written');
    }
    if (state.incarnationId !== input.incarnationId) {
      throw new SessionHandoffServiceError('INCARNATION_NOT_CURRENT',
        'The side channel belongs to another incarnation; the decision was not written');
    }
    if (!this.#send(state, { kind: 'permission_decision', requestId: input.providerRequestId,
      decision: input.decision, reason: null })) {
      throw new SessionHandoffServiceError('PERMISSION_CHANNEL_UNAVAILABLE',
        'The side channel write failed; the decision may not have reached the provider');
    }
  }

  #requireSession(projectId: string, sessionId: string): {
    readonly projectId: string; readonly taskId: string; readonly executionId: string;
    readonly sessionId: string; readonly sessionState: string; readonly executionState: string;
    readonly providerSessionId: string | null; readonly sessionStorageRef: string | null } {
    const session = this.#storage.getAgentSessionIdentity(sessionId);
    if (session === null) {
      throw new SessionHandoffServiceError('NOT_FOUND', 'Agent Session was not found');
    }
    if (session.projectId !== projectId) {
      throw new SessionHandoffServiceError('NOT_FOUND', 'Agent Session does not belong to this project');
    }
    return session;
  }

  /**
   * The channel a Session owns. A connection that arrived before the Runtime recorded its
   * incarnation is still findable, because a controlled launch says hello during `session_start`,
   * which can happen just before the Runtime records the provider identity.
   */
  #findChannel(sessionId: string): ChannelState | null {
    const resolved = this.#channels.get(sessionId) ?? null;
    if (resolved !== null) return resolved;
    const identity = this.#storage.getAgentSessionIdentity(sessionId);
    if (identity === null || identity.providerSessionId === null) return null;
    for (const state of this.#pendingChannels) {
      if (state.hello?.providerSessionId === identity.providerSessionId) return state;
    }
    return null;
  }

  #send(state: ChannelState, command: HandoffChannelCommand): boolean {
    const socket = state.socket;
    if (socket === null || state.closed) return false;
    try {
      socket.write(`${JSON.stringify(command)}\n`);
      return true;
    } catch {
      state.socket = null;
      this.#closeChannel(state);
      return false;
    }
  }

  #reject(state: ChannelState, code: string, message: string): void {
    this.#rejectState(state, code, message);
  }

  #rejectState(state: ChannelState, code: string, message: string): void {
    this.#logger('side channel rejected a provider request', { code, message });
    const socket = state.socket;
    if (socket === null) return;
    try {
      socket.write(`${JSON.stringify({ kind: 'rejected', code, message })}\n`);
      socket.end();
    } catch { /* the connection is already gone. */ }
    state.socket = null;
    this.#closeChannel(state);
  }

  #closeChannel(state: ChannelState): void {
    if (state.closed) return;
    state.closed = true;
    if (state.sessionId !== null && this.#channels.get(state.sessionId) === state) {
      this.#channels.delete(state.sessionId);
    }
    this.#pendingChannels.delete(state);
    state.activeTools.clear();
  }
}

/** The seam agent-answer-service uses to write one permission decision to its provider channel. */
export interface PermissionDecisionChannel {
  deliverDecision(input: {
    readonly sessionId: string;
    readonly incarnationId: string;
    readonly providerRequestId: string;
    readonly decision: 'ALLOW' | 'DENY' | 'CANCEL';
  }): Promise<void>;
}
