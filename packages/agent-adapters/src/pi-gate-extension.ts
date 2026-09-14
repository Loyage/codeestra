import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The question tool is a user-facing read of intent, not a side effect: STRICT never blocks it. */
const askUserQuestionTool = 'ask_user_question';

const automaticallyAllowedTools = new Set(['read', 'grep', 'find', 'ls', askUserQuestionTool]);
const approvalRequiredTools = new Set(['bash', 'powershell', 'edit', 'write']);

export type GateDecision = 'ALLOW' | 'REQUIRE_APPROVAL' | 'REJECT_UNKNOWN';
export type PiPermissionMode = 'FULL' | 'STRICT';

export function classifyPiTool(toolName: string, mode: PiPermissionMode = 'FULL'): GateDecision {
  // Full mode deliberately permits every registered tool, including names Codeestra does not know.
  if (mode === 'FULL') return 'ALLOW';
  if (automaticallyAllowedTools.has(toolName)) return 'ALLOW';
  if (approvalRequiredTools.has(toolName)) return 'REQUIRE_APPROVAL';
  return 'REJECT_UNKNOWN';
}

/** The terminating block a fenced run returns for a tool call that arrived after the safe point. */
export const handoffFenceReason = 'CODEESTRA_HANDOFF_FENCE: no new tools after the safe point';

/** Version of the Runtime side channel protocol; a mismatch is reported as a rejection. */
export const handoffChannelProtocol = 1;

/**
 * Where a controlled launch finds the Runtime's side channel. It is derived from the same
 * `CODEESTRA_HOME` the Runtime uses, so the extension never guesses a path the Runtime did not open.
 */
export function sessionHandoffSocketPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const explicit = environment['CODEESTRA_HANDOFF_SOCKET'];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const home = environment['CODEESTRA_HOME']
    ?? join(environment['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state'), 'codeestra');
  return join(home, 'session-handoff.sock');
}

/**
 * What the ExtensionContext of a controlled launch can tell the Runtime. Only facts the provider
 * itself reports are used: the Runtime never derives a business state from terminal text.
 */
export interface HandoffChannelHello {
  readonly kind: 'hello';
  readonly protocol: number;
  readonly mode: string;
  readonly hasUI: boolean;
  readonly permissionMode: PiPermissionMode;
  readonly pid: number;
  readonly providerSessionId: string | null;
  readonly providerSessionFile: string | null;
}

/** Frames the controlled gate extension sends to the Runtime over the side channel. */
export type HandoffChannelFrame =
  | HandoffChannelHello
  | { readonly kind: 'fence_ack'; readonly active: boolean }
  | { readonly kind: 'tool_start'; readonly toolCallId: string; readonly toolName: string }
  | { readonly kind: 'tool_end'; readonly toolCallId: string; readonly toolName: string;
      readonly isError: boolean }
  | { readonly kind: 'agent_settled' }
  /**
   * The provider's own shutdown notification. It is supporting evidence only: FOUNDATION-040 measured
   * that it is not reliably delivered, so no release decision may depend on it.
   */
  | { readonly kind: 'session_shutdown'; readonly mode: string }
  | { readonly kind: 'permission_request'; readonly requestId: string; readonly toolCallId: string;
      readonly toolName: string; readonly inputJson: string; readonly inputFingerprint: string;
      readonly mode: string };

/** Frames the Runtime sends back on the same connection. */
export type HandoffChannelCommand =
  | { readonly kind: 'welcome'; readonly fenceActive: boolean }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'fence'; readonly active: boolean }
  | { readonly kind: 'permission_decision'; readonly requestId: string;
      readonly decision: 'ALLOW' | 'DENY' | 'CANCEL';
      /** Set only when the Runtime refused for its own reason, not when the user decided. */
      readonly reason: string | null };

/**
 * The outcome of one STRICT approval. `UNAVAILABLE` is fail-closed: the Runtime side channel is the
 * only approval channel, so a tool cannot be allowed when it is missing. The provider's own dialog
 * (`ctx.ui.confirm`) is deliberately not used, because it would be a second, un-routable decision
 * channel whose answer cannot be bound to a Session incarnation.
 */
/** One decision as the gate needs it: the outcome plus the Runtime's own refusal reason. */
export interface PiPermissionOutcome {
  readonly decision: 'ALLOW' | 'DENY' | 'CANCEL' | 'UNAVAILABLE';
  readonly reason: string | null;
}

interface ToolCallEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: unknown;
}

interface ToolLifecycleEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly isError?: boolean;
}

interface GateContext {
  readonly mode: string;
  readonly hasUI: boolean;
  readonly sessionManager?: {
    getSessionId?(): string;
    getSessionFile?(): string | null;
  };
}

interface GateExtensionApi {
  on(event: 'tool_call', handler: (
    event: ToolCallEvent,
    context: GateContext,
  ) => Promise<{ block: true; reason: string; terminate: true } | undefined>): void;
  on(event: 'session_start', handler: (event: unknown, context: GateContext) => void): void;
  on(event: 'session_shutdown', handler: (event: unknown, context: GateContext) => void): void;
  on(event: 'tool_execution_start',
    handler: (event: ToolLifecycleEvent, context: GateContext) => void): void;
  on(event: 'tool_execution_end',
    handler: (event: ToolLifecycleEvent, context: GateContext) => void): void;
  on(event: 'agent_settled', handler: (event: unknown, context: GateContext) => void): void;
}

function serializedInput(input: unknown): string | null {
  try {
    const value = JSON.stringify(input);
    return value === undefined ? null : value;
  } catch {
    return null;
  }
}

/**
 * How long a tool call waits for the control connection to come up, and how the connection is
 * retried. The Runtime's side channel socket can be (re)created while a provider is already
 * running — for example when the Runtime restarts — so a single failed connect is not treated as
 * "there is no approval channel". Every retry is still fail-closed: nothing is approved while the
 * channel is down.
 */
const defaultChannelConnectTimeoutMs = 10_000;
const channelConnectRetryDelayMs = 250;

/**
 * How long the extension keeps re-dialling the Runtime side channel. It is overridable so a
 * deployment (or a test) can shorten the fail-closed window; the default covers a Runtime that is
 * starting or restarting while the provider is already running.
 */
function channelConnectTimeout(): number {
  const configured = Number(process.env.CODEESTRA_HANDOFF_CONNECT_MS);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : defaultChannelConnectTimeoutMs;
}

/**
 * Client half of the Runtime side channel (FOUNDATION-040 §5.1).
 *
 * It carries the handoff fence, the structured tool lifecycle facts the safe point needs, and the
 * STRICT permission request/decision round trip — in every provider mode, because it does not
 * depend on the terminal UI. Losing the channel never silently allows a tool: pending requests and
 * new ones fail closed until the Runtime is reachable again.
 */
class RuntimeSideChannel {
  #socket: Socket | null = null;
  #buffer = '';
  #fence = false;
  #accepted: boolean | null = null;
  #ready: Promise<boolean> | null = null;
  #settleReady: ((value: boolean) => void) | null = null;
  #deadline = 0;
  readonly #pending = new Map<string, (outcome: PiPermissionOutcome) => void>();
  #sequence = 0;

  get fenceActive(): boolean {
    return this.#fence;
  }

  /** Opens the control connection once; later calls reuse the same attempt. */
  open(context: GateContext): Promise<boolean> {
    if (this.#ready !== null) return this.#ready;
    this.#ready = new Promise<boolean>((resolve) => { this.#settleReady = resolve; });
    this.#deadline = Date.now() + channelConnectTimeout();
    this.#attemptConnect(context);
    return this.#ready;
  }

  #attemptConnect(context: GateContext): void {
    // Handlers are attached before `connect`, so a connection error is always delivered as an
    // event (the fail-closed case) instead of escaping as a thrown error inside a tool call.
    const socket = new Socket();
    let connected = false;
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      connected = true;
      this.#socket = socket;
      this.#send({
        kind: 'hello',
        protocol: handoffChannelProtocol,
        mode: context.mode,
        hasUI: context.hasUI === true,
        permissionMode: process.env.CODEESTRA_PERMISSION_MODE === 'STRICT' ? 'STRICT' : 'FULL',
        pid: process.pid,
        providerSessionId: context.sessionManager?.getSessionId?.() ?? null,
        providerSessionFile: context.sessionManager?.getSessionFile?.() ?? null,
      });
      this.#settleReady?.(true);
    });
    socket.on('data', (chunk: string) => { this.#consume(chunk); });
    socket.on('error', () => {
      if (this.#socket === socket) this.#socket = null;
      if (connected) {
        // The Runtime closed a live channel: report the loss and fail closed, do not re-dial
        // silently in the background while tools are being decided.
        this.#resolveAll('UNAVAILABLE');
        this.#settleReady?.(false);
        return;
      }
      if (Date.now() < this.#deadline) {
        const timer = setTimeout(() => { this.#attemptConnect(context); }, channelConnectRetryDelayMs);
        (timer as { unref?: () => void }).unref?.();
        return;
      }
      this.#settleReady?.(false);
    });
    socket.on('close', () => {
      if (this.#socket === socket) this.#socket = null;
      if (!connected) return;
      // A live channel closed: every decision still waiting must fail closed, and the connection
      // is not re-dialled silently while tools are being decided.
      this.#resolveAll('UNAVAILABLE');
      this.#settleReady?.(false);
    });
    try {
      socket.connect(sessionHandoffSocketPath());
    } catch {
      if (Date.now() < this.#deadline) {
        const timer = setTimeout(() => { this.#attemptConnect(context); }, channelConnectRetryDelayMs);
        (timer as { unref?: () => void }).unref?.();
      } else {
        this.#settleReady?.(false);
      }
    }
  }

  /**
   * Dial again after a lost channel. A later tool call must not stay fail-closed forever because
   * the Runtime was restarted earlier in the same provider session; each attempt gets a fresh
   * bounded window, and the fence state is re-synchronised from the Runtime's `welcome`.
   */
  reopenIfLost(context: GateContext): Promise<boolean> {
    if (this.#socket !== null) return this.#ready ?? Promise.resolve(true);
    this.#ready = null;
    this.#accepted = null;
    return this.open(context);
  }

  /** Best-effort structured fact. A missing channel is reported by the fence/permission paths. */
  notify(frame: HandoffChannelFrame): void {
    this.#send(frame);
  }

  /**
   * Asks the Runtime to decide one STRICT tool call. The request is always the structured form
   * (tool name, exact input, input fingerprint), so the Attention the user answers describes
   * exactly what would run.
   */
  async requestPermission(input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly inputJson: string;
    readonly inputFingerprint: string;
    readonly mode: string;
  }): Promise<PiPermissionOutcome> {
    const connected = await Promise.race([
      this.#ready ?? Promise.resolve(false),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { resolve(false); }, channelConnectTimeout() + 1_000);
        // `unref` keeps a pending timer from holding the provider process open.
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    if (!connected || this.#accepted === false) return { decision: 'UNAVAILABLE', reason: null };
    const requestId = `codeestra-permission:${process.pid}:${++this.#sequence}:${input.toolCallId}`;
    const decision = new Promise<PiPermissionOutcome>((resolve) => {
      this.#pending.set(requestId, resolve);
    });
    if (!this.#send({ kind: 'permission_request', requestId, ...input })) {
      this.#pending.delete(requestId);
      return { decision: 'UNAVAILABLE', reason: null };
    }
    return decision;
  }

  close(): void {
    try { this.#socket?.end(); } catch { /* the connection may be gone already. */ }
    this.#socket = null;
    this.#resolveAll('UNAVAILABLE');
    this.#settleReady?.(false);
  }

  #send(frame: HandoffChannelFrame): boolean {
    const socket = this.#socket;
    if (socket === null || socket.destroyed) return false;
    try {
      socket.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    for (let index = this.#buffer.indexOf('\n'); index !== -1; index = this.#buffer.indexOf('\n')) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      let command: HandoffChannelCommand;
      try {
        command = JSON.parse(line) as HandoffChannelCommand;
      } catch {
        continue;
      }
      this.#apply(command);
    }
  }

  #apply(command: HandoffChannelCommand): void {
    if (command.kind === 'welcome') {
      this.#accepted = true;
      this.#fence = command.fenceActive === true;
      return;
    }
    if (command.kind === 'rejected') {
      this.#accepted = false;
      this.#resolveAll('UNAVAILABLE');
      return;
    }
    if (command.kind === 'fence') {
      this.#fence = command.active === true;
      this.#send({ kind: 'fence_ack', active: this.#fence });
      return;
    }
    if (command.kind === 'permission_decision') {
      const resolve = this.#pending.get(command.requestId);
      if (resolve === undefined) return;
      this.#pending.delete(command.requestId);
      resolve({ decision: command.decision, reason: command.reason ?? null });
    }
  }

  #resolveAll(decision: PiPermissionOutcome['decision']): void {
    for (const resolve of this.#pending.values()) resolve({ decision, reason: null });
    this.#pending.clear();
  }
}

/** Explicitly loaded with --no-extensions so no later extension can mutate an approved call. */
export default function codeestraGate(pi: GateExtensionApi): void {
  const channel = new RuntimeSideChannel();
  let opened = false;
  const ensureOpen = (context: GateContext): Promise<boolean> => {
    if (!opened) {
      opened = true;
      return channel.open(context);
    }
    return channel.reopenIfLost(context);
  };

  pi.on('session_start', (_event, context) => { void ensureOpen(context); });
  pi.on('session_shutdown', (_event, context) => {
    // Best-effort: sent before the connection is closed, and never required by the Runtime.
    channel.notify({ kind: 'session_shutdown', mode: context.mode });
    channel.close();
  });
  // The safe point needs structured tool facts, and in a human terminal there is no RPC event
  // stream to read them from, so the extension reports them on the same channel it approves on.
  pi.on('tool_execution_start', (event) => {
    channel.notify({ kind: 'tool_start', toolCallId: event.toolCallId, toolName: event.toolName });
  });
  pi.on('tool_execution_end', (event) => {
    channel.notify({ kind: 'tool_end', toolCallId: event.toolCallId, toolName: event.toolName,
      isError: event.isError === true });
  });
  pi.on('agent_settled', () => { channel.notify({ kind: 'agent_settled' }); });

  pi.on('tool_call', async (event, context) => {
    void ensureOpen(context);
    if (channel.fenceActive) {
      return { block: true, reason: handoffFenceReason, terminate: true };
    }
    const mode: PiPermissionMode = process.env.CODEESTRA_PERMISSION_MODE === 'STRICT' ? 'STRICT' : 'FULL';
    const decision = classifyPiTool(event.toolName, mode);
    if (decision === 'ALLOW') return undefined;
    if (decision === 'REJECT_UNKNOWN') {
      return {
        block: true,
        reason: `Codeestra rejected unknown tool: ${event.toolName}`,
        terminate: true,
      };
    }
    const input = serializedInput(event.input);
    if (input === null) {
      return {
        block: true,
        reason: `Codeestra rejected non-serializable input for ${event.toolName}`,
        terminate: true,
      };
    }
    const fingerprint = `sha256:${createHash('sha256').update(input).digest('hex')}`;
    const outcome = await channel.requestPermission({
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      inputJson: input,
      inputFingerprint: fingerprint,
      mode: context.mode,
    });
    if (outcome.decision === 'ALLOW') return undefined;
    if (outcome.decision === 'DENY') {
      // A user denial and a Runtime refusal must not read the same in the transcript.
      return { block: true, terminate: true,
        reason: outcome.reason ?? 'Codeestra permission denied by user' };
    }
    if (outcome.decision === 'CANCEL') {
      return { block: true, reason: 'Codeestra permission request was cancelled', terminate: true };
    }
    return {
      block: true,
      reason: `Codeestra cannot approve ${event.toolName} without its Runtime permission channel`,
      terminate: true,
    };
  });
}
