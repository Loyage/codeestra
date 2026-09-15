import { createHash } from 'node:crypto';
import { chmodSync, rmSync } from 'node:fs';
import {
  captureProviderProcessTree,
  handoffChannelProtocol,
  inspectProviderProcessOwnership,
  sessionHandoffSocketPath,
  type HandoffChannelCommand,
  type HandoffChannelHello,
  type ProviderOwnershipObservation,
  type ProviderProcessTree,
} from '@codeestra/agent-adapters';
import {
  TerminalService,
  type SessionTerminalView,
} from './terminal-service.js';
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
 * The honest capability statement of this Runtime version (ADR-0026).
 *
 * Everything that is implemented is stated as such; everything that is not stays `UNSUPPORTED` or
 * `UNVERIFIED` and is never silently degraded. In particular this Runtime can attach to a *native
 * terminal it started*, but it still cannot attach to a running RPC provider process (Pi has no such
 * primitive, FOUNDATION-040 §4.1) — those are two different claims and are reported separately.
 */
export interface SessionHandoffCapabilities {
  readonly runtimeContract: 'IMPLEMENTED';
  readonly singleWriterLease: 'IMPLEMENTED';
  readonly strictPermissionOverSideChannel: 'IMPLEMENTED';
  /** The provider runs on a real PTY; the Runtime owns the PTY host that holds the terminal. */
  readonly ptyTransport: 'IMPLEMENTED' | 'UNSUPPORTED';
  /** A successor provider process is started on the same conversation (RPC or native TUI). */
  readonly successorProcessStart: 'IMPLEMENTED' | 'UNSUPPORTED';
  /** Attaching a client to a native terminal this Runtime started. */
  readonly nativeTerminalAttach: 'IMPLEMENTED' | 'UNSUPPORTED';
  readonly terminalDetach: 'IMPLEMENTED' | 'UNSUPPORTED';
  readonly releaseBackToAutomation: 'IMPLEMENTED' | 'UNSUPPORTED';
  /** Attaching to an already-running `pi --mode rpc` process. Pi offers no primitive for it. */
  readonly attachToLiveRpcProcess: 'UNSUPPORTED';
  /**
   * The permission mode and tool allowlist are re-applied by the Runtime on every successor argv, but
   * the full cross-handoff matrix (every mode/tool combination, both directions, repeatedly) has not
   * been measured; only single transitions with a real provider have.
   */
  readonly crossHandoffPermissionModeMatrix: 'PARTIAL';
  /** A safe point while several tool calls from one assistant turn run in parallel. */
  readonly parallelToolBatchSafePoint: 'UNVERIFIED';
  readonly sessionCompactionDuringHandoff: 'UNSUPPORTED';
  readonly ptyResize: 'UNSUPPORTED';
  readonly windows: 'UNSUPPORTED';
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
  /** The native terminal of this Session: the PTY, its projection cursor and its release evidence. */
  readonly terminal: SessionTerminalView | null;
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
  /** True only when a successor provider process was really started and recorded. */
  readonly successorStarted: boolean;
  readonly terminalTransport: 'PTY' | 'RPC' | 'NONE';
  /** The successor incarnation this admission recorded, when one was started. */
  readonly successorIncarnation: SessionIncarnationView | null;
  /** The native terminal the successor runs on, when the successor is a HUMAN_TUI incarnation. */
  readonly terminal: SessionTerminalView | null;
  /** True when this answer replayed an admission that had already been applied. */
  readonly replayed: boolean;
}

function capabilitiesFor(platform: 'unix' | 'windows'): SessionHandoffCapabilities {
  const posix: 'IMPLEMENTED' | 'UNSUPPORTED' = platform === 'windows'
    ? 'UNSUPPORTED' : 'IMPLEMENTED';
  const capabilities: SessionHandoffCapabilities = {
    runtimeContract: 'IMPLEMENTED',
    singleWriterLease: 'IMPLEMENTED',
    strictPermissionOverSideChannel: 'IMPLEMENTED',
    ptyTransport: posix,
    successorProcessStart: posix,
    nativeTerminalAttach: posix,
    terminalDetach: 'IMPLEMENTED',
    releaseBackToAutomation: posix,
    attachToLiveRpcProcess: 'UNSUPPORTED',
    crossHandoffPermissionModeMatrix: 'PARTIAL',
    parallelToolBatchSafePoint: 'UNVERIFIED',
    sessionCompactionDuringHandoff: 'UNSUPPORTED',
    ptyResize: 'UNSUPPORTED',
    windows: 'UNSUPPORTED',
  };
  return Object.freeze(capabilities);
}

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

/**
 * The bounded evidence reference a handoff fact carries. It names the incarnation *and* the OS
 * identity it was recorded with (pid plus start token), because a pid alone cannot distinguish this
 * provider from a later process that reused the number — the same rule the ownership check uses.
 * A reference that cannot be built is `null`, never a made-up value.
 */
function processEvidenceRef(incarnation: SessionIncarnationRecord): string | null {
  const identity = processIdentityOf(incarnation);
  if (identity === null) return null;
  return `incarnation:${incarnation.id}#pid=${identity.pid}@${identity.startToken}`;
}

/**
 * The stable reason code of a refusal.
 *
 * A `SessionHandoffServiceError` already carries one in `code`. A `StorageError` carries a generic
 * class (`INVALID_STATE`), so the specific code of a *refusal* is the `CODE:` prefix the storage
 * layer writes into its message (`HANDOFF_ALREADY_REQUESTED: …`). The prefix wins when both exist,
 * because "which rule refused this" is what a client branches on.
 */
function refusalCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : '';
  const prefixed = /^([A-Z][A-Z0-9_]{2,}):/.exec(message);
  if (prefixed !== null) return prefixed[1] as string;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return fallback;
}

/** What starting an automation successor (the `RETURN` direction) reports back. */
export interface AutomationSuccessorStart {
  readonly adapterId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly providerSessionId: string | null;
  readonly sessionStorageRef: string | null;
  readonly providerPid: number | null;
  readonly processIdentity: unknown;
}

export interface SessionHandoffServiceOptions {
  readonly storage: Phase1Database;
  readonly runtimeHome: string;
  readonly resolveAdapter: (adapterId: string) => AgentAnswerAdapter;
  /**
   * The PTY transport. Without it the `TAKEOVER` successor cannot be started, and an admission says
   * so instead of reporting a process that does not exist.
   */
  readonly terminal?: TerminalService;
  /**
   * Starts the RPC successor that takes the conversation back from a released terminal. The Runtime
   * supplies this; the handoff service never launches an automation process itself, because the
   * observation loop that owns it lives in the Agent Runtime coordinator.
   */
  readonly startAutomationSuccessor?: (input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly reason: string;
  }) => Promise<AutomationSuccessorStart>;
  /** Stops an automation successor this Runtime started but refused to record. */
  readonly releaseAutomationSuccessor?: (input: {
    readonly executionId: string;
    readonly reason: string;
  }) => Promise<void>;
  /**
   * Cooperatively stops the automation provider of an Execution this Runtime still holds. The
   * settled fact a handoff fence produces means the automation *should* stop itself; this hook lets
   * the admission ask it to (and confirm), instead of reporting `PREDECESSOR_NOT_STOPPED` for
   * something the Runtime itself is still holding.
   */
  readonly releaseAutomationProcess?: (input: {
    readonly executionId: string;
  }) => Promise<{ readonly released: boolean; readonly detail: string }>;
  readonly platform?: 'unix' | 'windows';
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
 * ADR-0026 adds the transport half: an admitted handoff really starts a successor provider process
 * on the same conversation (a PTY-hosted native terminal for `TAKEOVER`, an RPC process for
 * `RETURN`), records the new incarnation and moves the single writer lease. Nothing here reports a
 * successor it did not start, and nothing hands the conversation over while the predecessor's
 * ownership is unclear.
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
  readonly #terminal: TerminalService | null;
  readonly #startAutomationSuccessor: SessionHandoffServiceOptions['startAutomationSuccessor'];
  readonly #releaseAutomationSuccessor: SessionHandoffServiceOptions['releaseAutomationSuccessor'];
  readonly #releaseAutomationProcess: SessionHandoffServiceOptions['releaseAutomationProcess'];
  readonly #capabilities: SessionHandoffCapabilities;
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
    this.#terminal = options.terminal ?? null;
    this.#startAutomationSuccessor = options.startAutomationSuccessor;
    this.#releaseAutomationSuccessor = options.releaseAutomationSuccessor;
    this.#releaseAutomationProcess = options.releaseAutomationProcess;
    this.#capabilities = capabilitiesFor(options.platform ?? 'unix');
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
    // A terminal this Runtime owns must not outlive it. The stop is best-effort here (this method is
    // called from the Runtime's shutdown path, which does not await it); the guarantee is the PTY
    // host's own rule that a closed control pipe means "no writer is left to control this terminal",
    // so even a hard Runtime exit terminates the provider instead of orphaning it.
    void this.#terminal?.close();
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
      terminal: this.#terminal?.view(input.sessionId) ?? null,
      capabilities: this.#capabilities,
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
      this.#recordHandoffFailure({
        sessionId: input.sessionId, takeoverId: null, incarnationId: null, stage: 'REQUEST',
        code: 'SESSION_INCARNATION_UNAVAILABLE',
        detail: 'This Session has no current provider incarnation to hand over',
        commandId: input.commandId,
      });
      throw new SessionHandoffServiceError('SESSION_INCARNATION_UNAVAILABLE',
        'This Session has no current provider incarnation to hand over');
    }
    const lease = this.#storage.getSessionWriterLease(input.sessionId);
    if (input.kind === 'TAKEOVER' && lease !== null && lease.holderKind === 'TERMINAL_ATTACHMENT'
      && lease.incarnationId !== current.id) {
      this.#recordHandoffFailure({
        sessionId: input.sessionId, takeoverId: null, incarnationId: current.id, stage: 'REQUEST',
        code: 'ATTACHMENT_BUSY',
        detail: `Another terminal already holds the writer lease for this Session`
          + ` (${lease.holderRef})`,
        commandId: input.commandId, evidenceRef: processEvidenceRef(current),
      });
      throw new SessionHandoffServiceError('ATTACHMENT_BUSY',
        `Another terminal already holds the writer lease for this Session (${lease.holderRef})`);
    }
    let write;
    try {
      write = this.#storage.recordSessionHandoffRequest({
        id: this.#randomUUID(),
        sessionId: input.sessionId,
        executionId: session.executionId,
        incarnationId: current.id,
        kind: input.kind,
        commandId: input.commandId,
        createdAt: this.#now(),
        // The intent and its `TakeoverRequested` event are one transaction inside storage: a request
        // that was recorded without its event (or the reverse) would be a takeover nobody can audit.
        eventId: this.#randomUUID(),
      });
    } catch (error) {
      // A request storage refused (an open request already exists) leaves no `TakeoverRequested`
      // fact, because no request was recorded; the refusal itself is the fact that must be visible.
      this.#recordHandoffFailure({
        sessionId: input.sessionId, takeoverId: null, incarnationId: current.id, stage: 'REQUEST',
        code: refusalCode(error, 'HANDOFF_REQUEST_REFUSED'),
        detail: error instanceof Error ? error.message : String(error),
        commandId: input.commandId, evidenceRef: processEvidenceRef(current),
      });
      throw error;
    }
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
   * Decides whether a successor incarnation may be started, and — when the decision is ADMITTED —
   * really starts it (ADR-0026).
   *
   * The decision itself is unchanged from ADR-0023: the safe point must be reached from structured
   * facts, no Attention may be open, the writer lease must not belong to somebody else, and the
   * predecessor's ownership must be `STOPPED` — an unverifiable predecessor is refused rather than
   * optimistically taken over.
   *
   * What is new is that ADMITTED now does the transition end to end:
   *
   * 1. end the predecessor incarnation (it stops being the incarnation a decision can reach);
   * 2. release its writer lease, so the successor can take it;
   * 3. launch the successor provider on the *same* provider session file — a PTY-hosted native TUI
   *    for `TAKEOVER`, an RPC process for `RETURN` — and verify it reopened the same conversation;
   * 4. record the successor incarnation (which takes the single writer lease) and, for a terminal,
   *    the terminal row;
   * 5. mark the request ADMITTED.
   *
   * Every step is refused with a stable code when a fact is missing. A repeated call after a
   * successful admission replays the recorded successor instead of starting a second process.
   */
  async admitSuccessor(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly commandId: string;
  }): Promise<SuccessorAdmission> {
    this.#requireSession(input.projectId, input.sessionId);
    // Every refusal below is recorded as a `TakeoverFailed` fact with its stable code: a takeover
    // that did not happen is still something that happened, and "no event" would make a refusal
    // indistinguishable from an attempt nobody made.
    let takeoverId: string | null = null;
    let incarnationId: string | null = null;
    const refusal = (code: string, detail: string, observation = 'NOT_CHECKED'): SuccessorAdmission => {
      this.#recordHandoffFailure({
        sessionId: input.sessionId, takeoverId, incarnationId, stage: 'ADMIT',
        code, detail, commandId: input.commandId,
      });
      return {
        admitted: false, code, detail, predecessorObservation: observation,
        successorMode: null, successorStarted: false, terminalTransport: 'NONE',
        successorIncarnation: null, terminal: null, replayed: false,
      };
    };
    const request = this.#storage.getOpenSessionHandoffRequest(input.sessionId);
    if (request !== null) {
      takeoverId = request.id;
      incarnationId = request.incarnationId;
    }
    if (request === null) {
      // An admission that already happened is replayed from what it recorded: a repeated command
      // must never start a second provider on one conversation.
      const newest = this.#storage.listSessionHandoffRequests(input.sessionId).at(-1) ?? null;
      if (newest !== null && newest.state === 'ADMITTED') {
        const successor = this.#storage.listSessionIncarnations(input.sessionId)
          .find((incarnation) => incarnation.predecessorIncarnationId === newest.incarnationId) ?? null;
        if (successor !== null) {
          return {
            admitted: true, code: 'ADMITTED',
            detail: 'this handoff was already admitted; the recorded successor incarnation is'
              + ' reported instead of starting a second provider process',
            predecessorObservation: 'STOPPED',
            successorMode: successor.mode,
            successorStarted: true,
            terminalTransport: successor.mode === 'HUMAN_TUI' ? 'PTY' : 'RPC',
            successorIncarnation: incarnationView(successor, processTreeOf(successor)),
            terminal: this.#terminal?.view(input.sessionId) ?? null,
            replayed: true,
          };
        }
      }
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
    if (view.executionState !== 'RUNNING') {
      return refusal('EXECUTION_NOT_ACTIVE',
        `Execution ${view.executionId} is ${view.executionState}; a handoff cannot take over a`
        + ' finished Execution');
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
    let observation = await inspectProviderProcessOwnership({
      tree,
      ...(this.#readProcessTable === undefined ? {} : { readTable: this.#readProcessTable }),
      ...(this.#readStartToken === undefined ? {} : { readStartToken: this.#readStartToken }),
    });
    if (observation.state === 'ALIVE' && incarnation.mode === 'AUTOMATED_RPC'
      && this.#releaseAutomationProcess !== undefined) {
      // The automation is still alive after its own settled fact. That is the normal race: the
      // Runtime's side channel learns about the fence before the Adapter has stopped the process it
      // owns. The Runtime stops what it holds and checks the process table again — a process it does
      // not hold is never signalled, and a provider that survives the stop is still refused below.
      let released = false;
      try {
        const stop = await this.#releaseAutomationProcess({ executionId: view.executionId });
        released = stop.released;
      } catch (error) {
        this.#logger('the automation predecessor could not be released', {
          sessionId: input.sessionId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      if (released) {
        observation = await inspectProviderProcessOwnership({
          tree,
          ...(this.#readProcessTable === undefined ? {} : { readTable: this.#readProcessTable }),
          ...(this.#readStartToken === undefined ? {} : { readStartToken: this.#readStartToken }),
        });
      }
    }
    if (observation.state === 'ALIVE') {
      return refusal('PREDECESSOR_NOT_STOPPED', observation.detail, 'ALIVE');
    }
    if (observation.state === 'DESCENDANTS_ALIVE') {
      return refusal('PREDECESSOR_DESCENDANTS_ALIVE', observation.detail, 'DESCENDANTS_ALIVE');
    }
    if (observation.state === 'UNVERIFIABLE') {
      return refusal('PREDECESSOR_UNVERIFIED', observation.detail, 'UNVERIFIABLE');
    }
    const successorMode: SessionIncarnationRecord['mode'] = incarnation.mode === 'AUTOMATED_RPC'
      ? 'HUMAN_TUI' : 'AUTOMATED_RPC';
    if (successorMode === 'HUMAN_TUI') {
      return this.#admitTerminalSuccessor({
        request, incarnation, observation, view, commandId: input.commandId,
      });
    }
    return this.#admitAutomationSuccessor({
      request, incarnation, observation, view, commandId: input.commandId,
    });
  }

  /** RPC → native TUI: the transport this lane adds. */
  async #admitTerminalSuccessor(input: {
    readonly request: SessionHandoffRequestRecord;
    readonly incarnation: SessionIncarnationRecord;
    readonly observation: ProviderOwnershipObservation;
    readonly view: SessionHandoffStatusView;
    readonly commandId: string;
  }): Promise<SuccessorAdmission> {
    const { request, incarnation, observation } = input;
    const refusal = (code: string, detail: string): SuccessorAdmission => {
      this.#recordHandoffFailure({
        sessionId: request.sessionId, takeoverId: request.id, incarnationId: incarnation.id,
        stage: 'ADMIT', code, detail, commandId: input.commandId,
        evidenceRef: processEvidenceRef(incarnation),
      });
      return {
        admitted: false, code, detail, predecessorObservation: observation.state,
        successorMode: 'HUMAN_TUI', successorStarted: false, terminalTransport: 'NONE',
        successorIncarnation: null, terminal: this.#terminal?.view(request.sessionId) ?? null,
        replayed: false,
      };
    };
    const terminalService = this.#terminal;
    if (terminalService === null) {
      return refusal('TERMINAL_TRANSPORT_UNAVAILABLE',
        'This Runtime has no terminal transport configured, so no native terminal was started');
    }
    const sessionFile = incarnation.sessionStorageRef;
    if (sessionFile === null) {
      return refusal('SESSION_FILE_UNRECORDED',
        'The predecessor has no recorded provider session file, so a successor cannot reopen the'
        + ' same conversation');
    }
    const plan = this.#storage.getAgentStartPlanForSession(request.sessionId);
    if (plan === null) {
      return refusal('SESSION_PLAN_UNAVAILABLE',
        'The Runtime cannot reconstruct this Session\'s workspace and revision, so it refuses to'
        + ' start a successor with different inputs');
    }
    if (this.#storage.getRunningSessionTerminal(request.sessionId) !== null) {
      return refusal('TERMINAL_ALREADY_RUNNING',
        'This Session already has a running native terminal');
    }
    // The conversation must not be handed to a second writer: the predecessor stops claiming to be
    // current, its lease is released, and both facts (the handoff started, the writer lease changed)
    // are committed with the state change in one transaction inside storage. This is not the hand
    // over yet: nothing has been started, and a successor that cannot be launched becomes a
    // `TakeoverFailed` while the predecessor's exit stays in the history.
    this.#storage.beginSessionHandoff({
      requestId: request.id,
      sessionId: request.sessionId,
      at: this.#now(),
      eventId: this.#randomUUID(),
      leaseEventId: this.#randomUUID(),
      sourceIncarnationId: incarnation.id,
      targetMode: 'HUMAN_TUI',
      predecessorObservation: observation.state,
      processEvidenceRef: processEvidenceRef(incarnation),
      exit: { kind: 'HANDOFF', ownership: observation.state, detail: observation.detail,
        sessionFile },
      exitDetail: `superseded by a native terminal successor after ${observation.detail}`,
      releaseReason: 'handoff to a native terminal',
    });
    let launched;
    try {
      launched = await terminalService.launchTerminal({
        sessionId: request.sessionId,
        projectId: plan.projectId,
        adapterId: plan.adapterId,
        workspacePath: plan.workspacePath,
        sessionFile,
        agentConfig: plan.agentConfig,
      });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'TERMINAL_LAUNCH_FAILED';
      return refusal(code, `The native terminal could not be started: `
        + `${error instanceof Error ? error.message : String(error)}`);
    }
    // Identity is the *provider* process (that is the pid the gate extension reports in its hello),
    // captured while it is alive so a later ownership check can tell it from a reused pid.
    const providerIdentity = launched.providerStartToken === null
      ? { pid: launched.providerPid, kind: 'PTY_PROVIDER' }
      : { pid: launched.providerPid, startToken: launched.providerStartToken,
        adapterId: plan.adapterId, adapterVersion: plan.adapterVersion, kind: 'PTY_PROVIDER',
        capturedAt: this.#now() };
    let write;
    try {
      write = this.#storage.recordSessionIncarnation({
        id: this.#randomUUID(),
        sessionId: request.sessionId,
        mode: 'HUMAN_TUI',
        commandId: `handoff:${request.id}`,
        providerPid: launched.providerPid,
        processIdentity: providerIdentity,
        // The tree is rooted at the PTY host (the session leader and the provider's parent), so it
        // covers the helper *and* the provider and any tool child the provider starts.
        processTree: launched.processTree,
        providerSessionId: incarnation.providerSessionId,
        sessionStorageRef: sessionFile,
        createdAt: this.#now(),
      });
    } catch (error) {
      // No successor incarnation means no writer may stay alive: the launched terminal is stopped
      // instead of being left as an unowned provider in the user's workspace.
      await terminalService.stopTerminal({ sessionId: request.sessionId,
        reason: 'the successor incarnation could not be recorded', state: 'STOPPED' });
      return refusal('SUCCESSOR_NOT_RECORDED',
        `The successor incarnation could not be recorded: `
        + `${error instanceof Error ? error.message : String(error)}`);
    }
    terminalService.commitTerminal({ launched, incarnationId: write.incarnation.id });
    this.#storage.markSessionHandoffAdmitted({
      requestId: request.id,
      at: this.#now(),
      eventId: this.#randomUUID(),
      detail: `native terminal started as incarnation ${write.incarnation.incarnationNumber};`
        + ` predecessor ownership ${observation.state}: ${observation.detail}`,
      completion: {
        successorIncarnationId: write.incarnation.id,
        successorIncarnationNumber: write.incarnation.incarnationNumber,
        terminalTransport: 'PTY',
        terminalId: terminalService.view(request.sessionId)?.terminalId ?? null,
        providerPid: launched.providerPid,
        processEvidenceRef: processEvidenceRef(write.incarnation),
      },
    });
    return {
      admitted: true,
      code: 'ADMITTED',
      detail: `the predecessor is quiescent (${observation.detail}) and a native Pi terminal was`
        + ` started on the same provider session file (incarnation`
        + ` ${write.incarnation.incarnationNumber}, PTY ${launched.ptySlave})`,
      predecessorObservation: observation.state,
      successorMode: 'HUMAN_TUI',
      successorStarted: true,
      terminalTransport: 'PTY',
      successorIncarnation: incarnationView(write.incarnation,
        processTreeOf(write.incarnation) ?? launched.processTree),
      terminal: terminalService.view(request.sessionId),
      replayed: false,
    };
  }

  /** Native TUI → RPC: the return direction, after an explicit release. */
  async #admitAutomationSuccessor(input: {
    readonly request: SessionHandoffRequestRecord;
    readonly incarnation: SessionIncarnationRecord;
    readonly observation: ProviderOwnershipObservation;
    readonly view: SessionHandoffStatusView;
    readonly commandId: string;
  }): Promise<SuccessorAdmission> {
    const { request, incarnation, observation } = input;
    const refusal = (code: string, detail: string): SuccessorAdmission => {
      this.#recordHandoffFailure({
        sessionId: request.sessionId, takeoverId: request.id, incarnationId: incarnation.id,
        stage: 'ADMIT', code, detail, commandId: input.commandId,
        evidenceRef: processEvidenceRef(incarnation),
      });
      return {
        admitted: false, code, detail, predecessorObservation: observation.state,
        successorMode: 'AUTOMATED_RPC', successorStarted: false, terminalTransport: 'NONE',
        successorIncarnation: null, terminal: this.#terminal?.view(request.sessionId) ?? null,
        replayed: false,
      };
    };
    const running = this.#storage.getRunningSessionTerminal(request.sessionId);
    if (running !== null) {
      return refusal('TERMINAL_STILL_RUNNING',
        `Terminal ${running.id} is still RUNNING; release it explicitly before handing the`
        + ' conversation back to automation');
    }
    const start = this.#startAutomationSuccessor;
    if (start === undefined) {
      return refusal('AUTOMATION_SUCCESSOR_UNAVAILABLE',
        'This Runtime cannot start an automation successor process, so the conversation was not'
        + ' handed back');
    }
    const sessionFile = incarnation.sessionStorageRef;
    if (sessionFile === null) {
      return refusal('SESSION_FILE_UNRECORDED',
        'The predecessor has no recorded provider session file, so a successor cannot reopen the'
        + ' same conversation');
    }
    this.#storage.beginSessionHandoff({
      requestId: request.id,
      sessionId: request.sessionId,
      at: this.#now(),
      eventId: this.#randomUUID(),
      leaseEventId: this.#randomUUID(),
      sourceIncarnationId: incarnation.id,
      targetMode: 'AUTOMATED_RPC',
      predecessorObservation: observation.state,
      processEvidenceRef: processEvidenceRef(incarnation),
      exit: { kind: 'RELEASE', ownership: observation.state, detail: observation.detail,
        sessionFile },
      exitDetail: `released by an explicit terminal release after ${observation.detail}`,
      releaseReason: 'handoff back to automation',
    });
    let started: AutomationSuccessorStart;
    try {
      started = await start({
        sessionId: request.sessionId,
        commandId: `handoff:${request.id}`,
        reason: 'handoff back to automation after an explicit terminal release',
      });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : 'AUTOMATION_SUCCESSOR_FAILED';
      return refusal(code, `The automation successor could not be started: `
        + `${error instanceof Error ? error.message : String(error)}`);
    }
    if (started.sessionStorageRef !== null && started.sessionStorageRef !== sessionFile) {
      // A successor that reopened a different file is a second conversation wearing this Session's
      // identity; it is stopped rather than recorded.
      await this.#stopAutomationSuccessor(started, 'the successor reopened a different session file');
      return refusal('SESSION_FILE_CHANGED',
        `The successor reopened ${started.sessionStorageRef} instead of ${sessionFile}`);
    }
    const identity = started.processIdentity;
    let tree: ProviderProcessTree | null = null;
    const identityPid = typeof identity === 'object' && identity !== null
      && typeof (identity as { pid?: unknown }).pid === 'number'
      ? (identity as { pid: number }).pid : started.providerPid;
    const identityToken = typeof identity === 'object' && identity !== null
      && typeof (identity as { startToken?: unknown }).startToken === 'string'
      ? (identity as { startToken: string }).startToken : null;
    if (identityPid !== null && identityToken !== null) {
      try {
        tree = await captureProviderProcessTree({
          pid: identityPid, startToken: identityToken, now: this.#now,
          ...(this.#readProcessTable === undefined ? {} : { readTable: this.#readProcessTable }),
          ...(this.#readStartToken === undefined ? {} : { readStartToken: this.#readStartToken }),
        });
      } catch (error) {
        this.#logger('the successor process tree could not be captured', {
          sessionId: request.sessionId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    let write;
    try {
      write = this.#storage.recordSessionIncarnation({
        id: this.#randomUUID(),
        sessionId: request.sessionId,
        mode: 'AUTOMATED_RPC',
        commandId: `handoff:${request.id}`,
        providerPid: identityPid,
        processIdentity: identity,
        processTree: tree,
        providerSessionId: started.providerSessionId,
        sessionStorageRef: sessionFile,
        createdAt: this.#now(),
      });
    } catch (error) {
      await this.#stopAutomationSuccessor(started, 'the successor incarnation could not be recorded');
      return refusal('SUCCESSOR_NOT_RECORDED',
        `The successor incarnation could not be recorded: `
        + `${error instanceof Error ? error.message : String(error)}`);
    }
    this.#storage.markSessionHandoffAdmitted({
      requestId: request.id,
      at: this.#now(),
      eventId: this.#randomUUID(),
      detail: `automation successor started as incarnation`
        + ` ${write.incarnation.incarnationNumber} on the same provider session file`,
      completion: {
        successorIncarnationId: write.incarnation.id,
        successorIncarnationNumber: write.incarnation.incarnationNumber,
        terminalTransport: 'RPC',
        terminalId: null,
        providerPid: identityPid,
        processEvidenceRef: processEvidenceRef(write.incarnation),
      },
    });
    return {
      admitted: true,
      code: 'ADMITTED',
      detail: `the released terminal is quiescent (${observation.detail}) and an automation process`
        + ` resumed the same provider session file (incarnation`
        + ` ${write.incarnation.incarnationNumber})`,
      predecessorObservation: observation.state,
      successorMode: 'AUTOMATED_RPC',
      successorStarted: true,
      terminalTransport: 'RPC',
      successorIncarnation: incarnationView(write.incarnation,
        processTreeOf(write.incarnation) ?? tree),
      terminal: this.#terminal?.view(request.sessionId) ?? null,
      replayed: false,
    };
  }

  /**
   * The explicit release of a native terminal (ADR-0026 D05/D06). It is one command, not a second
   * confirmation: the Runtime records the RETURN intent, writes the terminal's own release byte,
   * waits for the provider process to exit, and then — only if ownership is cleared and the provider
   * session file still holds the predecessor's entries — hands the conversation back to automation.
   *
   * A release that cannot be proven is reported as unfinished; the terminal is not killed (a running
   * tool is never aborted for a handoff) and no successor is started.
   */
  async releaseTerminal(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly commandId: string;
    readonly resumeAutomation?: boolean;
  }): Promise<{
    readonly released: boolean;
    readonly code: string;
    readonly detail: string;
    readonly terminal: SessionTerminalView | null;
    readonly release: {
      readonly exit: { readonly code: number | null; readonly signal: string | null } | null;
      readonly predecessorObservation: string;
      readonly sessionFile: unknown;
    };
    readonly successor: SuccessorAdmission | null;
  }> {
    const session = this.#requireSession(input.projectId, input.sessionId);
    const terminalService = this.#terminal;
    if (terminalService === null) {
      this.#recordHandoffFailure({
        sessionId: input.sessionId, takeoverId: null, incarnationId: null, stage: 'RELEASE',
        code: 'TERMINAL_TRANSPORT_UNAVAILABLE', detail: 'This Runtime has no terminal transport',
        commandId: input.commandId, evidenceRef: null,
      });
      throw new SessionHandoffServiceError('TERMINAL_TRANSPORT_UNAVAILABLE',
        'This Runtime has no terminal transport configured');
    }
    const running = this.#storage.getRunningSessionTerminal(input.sessionId);
    if (running === null) {
      this.#recordHandoffFailure({
        sessionId: input.sessionId, takeoverId: null, incarnationId: null, stage: 'RELEASE',
        code: 'TERMINAL_NOT_RUNNING', detail: 'This Session has no running native terminal',
        commandId: input.commandId, evidenceRef: null,
      });
      throw new SessionHandoffServiceError('TERMINAL_NOT_RUNNING',
        'This Session has no running native terminal to release');
    }
    // The RETURN intent is persisted before the release byte is written, so a crash in between is
    // explainable from the recorded request rather than invisible.
    const open = this.#storage.getOpenSessionHandoffRequest(input.sessionId);
    if (open !== null && open.kind !== 'RETURN') {
      this.#recordHandoffFailure({
        sessionId: input.sessionId, takeoverId: open.id, incarnationId: running.incarnationId,
        stage: 'RELEASE', code: 'HANDOFF_KIND_MISMATCH',
        detail: `This Session has an open ${open.kind} handoff request`,
        commandId: input.commandId, evidenceRef: null,
      });
      throw new SessionHandoffServiceError('HANDOFF_KIND_MISMATCH',
        `This Session has an open ${open.kind} handoff request; cancel it before releasing the terminal`);
    }
    const recorded = open === null ? this.#storage.recordSessionHandoffRequest({
      id: this.#randomUUID(),
      sessionId: input.sessionId,
      executionId: session.executionId,
      incarnationId: running.incarnationId,
      kind: 'RETURN',
      commandId: `release:${input.commandId}`,
      createdAt: this.#now(),
      eventId: this.#randomUUID(),
    }) : null;
    const request = recorded === null ? (open as SessionHandoffRequestRecord) : recorded.request;
    const outcome = await terminalService.release({
      sessionId: input.sessionId,
      commandId: input.commandId,
    });
    if (!outcome.released) {
      // The release could not be proven (the provider is still running, a descendant survived, the
      // session file was rewritten). That is a failed takeover release, not silence.
      this.#recordHandoffFailure({
        sessionId: input.sessionId, takeoverId: request.id, incarnationId: request.incarnationId,
        stage: 'RELEASE', code: outcome.code, detail: outcome.detail,
        commandId: input.commandId,
        evidenceRef: outcome.terminalId === null ? null
          : `terminal:${outcome.terminalId}#observation=${outcome.predecessorObservation}`,
      });
      return { released: false, code: outcome.code, detail: outcome.detail,
        terminal: terminalService.view(input.sessionId), release: {
          exit: outcome.exit === null ? null
            : { code: outcome.exit.code, signal: outcome.exit.signal },
          predecessorObservation: outcome.predecessorObservation,
          sessionFile: outcome.sessionFile,
        }, successor: null };
    }
    // A terminal release is its own safe point: no fence is involved (the human terminal was
    // released explicitly), so the facts *are* the evidence: recorded above by `release`.
    //
    // `TakeoverSafePointReached` and `TakeoverReleased` are committed in that one transaction with the
    // request's move to its safe point. `TakeoverReleased` is written only for a release that was
    // *proven* (provider exited, no recorded descendant alive, the session file still holds the
    // predecessor's entries) — a release that could not be proven became a `TakeoverFailed` above.
    try {
      this.#storage.markSessionTerminalHandoffSafePoint({
        requestId: request.id,
        at: this.#now(),
        eventId: this.#randomUUID(),
        detail: `terminal ${outcome.terminalId} released: ${outcome.detail}`,
        release: {
          releaseEventId: this.#randomUUID(),
          terminalId: outcome.terminalId,
          reason: outcome.detail,
          predecessorObservation: outcome.predecessorObservation,
          evidenceRef: outcome.terminalId === null ? null
            : `terminal:${outcome.terminalId}#release=${input.commandId}`,
          sessionFile: outcome.sessionFile,
        },
      });
    } catch (error) {
      this.#logger('terminal release safe point could not be recorded', {
        sessionId: input.sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (input.resumeAutomation === false) {
      return { released: true, code: outcome.code, detail: outcome.detail,
        terminal: terminalService.view(input.sessionId), release: {
          exit: outcome.exit === null ? null
            : { code: outcome.exit.code, signal: outcome.exit.signal },
          predecessorObservation: outcome.predecessorObservation,
          sessionFile: outcome.sessionFile,
        }, successor: null };
    }
    const successor = await this.admitSuccessor({
      projectId: input.projectId,
      sessionId: input.sessionId,
      commandId: `${input.commandId}:successor`,
    });
    return { released: true, code: outcome.code, detail: outcome.detail,
      terminal: terminalService.view(input.sessionId), release: {
        exit: outcome.exit === null ? null
          : { code: outcome.exit.code, signal: outcome.exit.signal },
        predecessorObservation: outcome.predecessorObservation,
        sessionFile: outcome.sessionFile,
      }, successor };
  }

  /** Attaches this client to the running native terminal; a second writer gets `ATTACHMENT_BUSY`. */
  attachTerminal(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly commandId: string;
    readonly holderRef: string;
    readonly kind?: 'WRITER' | 'OBSERVER';
    readonly since?: number;
  }): {
    readonly terminal: SessionTerminalView | null;
    readonly attachment: {
      readonly id: string; readonly kind: string; readonly holderRef: string;
      readonly cursorAtAttach: number; readonly attachedAt: number };
    readonly stream: { readonly cursor: number; readonly data: string; readonly truncated: boolean };
  } {
    this.#requireSession(input.projectId, input.sessionId);
    const terminalService = this.#requireTerminalTransport();
    const attached = terminalService.attach({
      sessionId: input.sessionId,
      commandId: input.commandId,
      holderRef: input.holderRef,
      kind: input.kind ?? 'WRITER',
      ...(input.since === undefined ? {} : { since: input.since }),
    });
    return {
      terminal: terminalService.view(input.sessionId),
      attachment: {
        id: attached.attachment.id,
        kind: attached.attachment.kind,
        holderRef: attached.attachment.holderRef,
        cursorAtAttach: attached.attachment.cursorAtAttach,
        attachedAt: attached.attachment.attachedAt,
      },
      stream: { cursor: attached.cursor, data: attached.data, truncated: attached.truncated },
    };
  }

  /** Detaches this client. The terminal and the provider keep running. */
  detachTerminal(input: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly holderRef: string;
    readonly since?: number;
  }): { readonly terminal: SessionTerminalView | null; readonly detached: boolean;
    readonly code: string; readonly stream: { readonly cursor: number; readonly data: string;
      readonly truncated: boolean } } {
    this.#requireSession(input.projectId, input.sessionId);
    const terminalService = this.#requireTerminalTransport();
    const detached = terminalService.detach({
      sessionId: input.sessionId,
      holderRef: input.holderRef,
      ...(input.since === undefined ? {} : { since: input.since }),
    });
    return { terminal: terminalService.view(input.sessionId), detached: detached.detached,
      code: detached.code,
      stream: { cursor: detached.cursor, data: detached.data, truncated: detached.truncated } };
  }

  /** Scriptable incremental read of the projected terminal stream. */
  readTerminal(input: { readonly projectId: string; readonly sessionId: string;
    readonly since?: number }): ReturnType<TerminalService['read']> {
    this.#requireSession(input.projectId, input.sessionId);
    return this.#requireTerminalTransport().read({
      sessionId: input.sessionId,
      ...(input.since === undefined ? {} : { since: input.since }),
    });
  }

  /** Writes bytes to the running terminal. Not an approval channel: STRICT decisions stay Attentions. */
  writeTerminal(input: { readonly sessionId: string; readonly data: string }): {
    readonly terminalId: string; readonly cursor: number } {
    return this.#requireTerminalTransport().write(input);
  }

  #requireTerminalTransport(): TerminalService {
    if (this.#terminal === null) {
      throw new SessionHandoffServiceError('TERMINAL_TRANSPORT_UNAVAILABLE',
        'This Runtime has no terminal transport configured');
    }
    return this.#terminal;
  }

  async #stopAutomationSuccessor(started: AutomationSuccessorStart, reason: string): Promise<void> {
    // The coordinator owns the process it started, so the stop goes through the same release path
    // the Runtime uses for a normal pause/cancel instead of a second kill mechanism.
    const stop = this.#releaseAutomationSuccessor;
    if (stop === undefined) {
      this.#logger('a misidentified automation successor could not be stopped', {
        sessionId: started.sessionId, reason,
      });
      return;
    }
    try {
      await stop({ executionId: started.executionId, reason });
    } catch (error) {
      this.#logger('stopping the automation successor failed', {
        sessionId: started.sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
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
    if (frame['kind'] === 'session_shutdown') {
      // Supporting evidence only: the release decision is taken from the provider process exit, the
      // ownership check and the provider session file (this notification is not reliably delivered).
      this.#terminal?.noteProviderShutdown({
        sessionId: resolved.sessionId, at: this.#now(),
      });
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

  /**
   * Records a refused handoff attempt as a `TakeoverFailed` fact.
   *
   * A refusal is an event, not a silent `null`: "the takeover did not happen" is something that
   * happened, and a subscriber must see it with the stable code a client branches on. Storage derives
   * the event id from the command and the code, so replaying one command adds no second fact while a
   * genuinely different refusal stays in the history. A fact that cannot be recorded is logged
   * instead of replacing the refusal the caller asked about, so the gap stays visible.
   */
  #recordHandoffFailure(input: {
    readonly sessionId: string;
    readonly takeoverId: string | null;
    readonly incarnationId: string | null;
    readonly stage: 'REQUEST' | 'SAFE_POINT' | 'ADMIT' | 'RELEASE';
    readonly code: string;
    readonly detail: string;
    readonly commandId: string;
    readonly evidenceRef?: string | null;
  }): void {
    try {
      this.#storage.recordSessionHandoffFailure({
        sessionId: input.sessionId,
        takeoverId: input.takeoverId,
        incarnationId: input.incarnationId,
        stage: input.stage,
        reason: input.code,
        detail: input.detail,
        commandId: input.commandId,
        evidenceRef: input.evidenceRef ?? null,
        occurredAt: this.#now(),
      });
    } catch (error) {
      this.#logger('handoff refusal could not be recorded as an event', {
        sessionId: input.sessionId,
        reason: input.code,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #evaluateSafePoint(sessionId: string, state: ChannelState): void {
    const open = this.#storage.getOpenSessionHandoffRequest(sessionId);
    if (open === null || open.state !== 'FENCED' || !open.fenceActive) return;
    if (state.activeTools.size > 0) return;
    if (open.settledAfterFenceAt === null) return;
    if (this.#storage.getOpenSessionPermissionRequest(sessionId) !== null) return;
    const detail = `fence acknowledged; ${state.activeTools.size} active tool(s); settled after the`
      + ' fence; no Attention is open';
    try {
      this.#storage.recordSessionHandoffSafePoint({
        requestId: open.id,
        at: this.#now(),
        detail,
        eventId: this.#randomUUID(),
        // The facts are the ones just checked: every condition held, so nothing is missing. They are
        // stored rather than re-derived later, so the event says what the Runtime really observed.
        activeTools: state.activeTools.size,
        missing: [],
        evidenceRef: `handoff:${open.id}#fence=${open.fenceConfirmedAt ?? 'unknown'}`,
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
