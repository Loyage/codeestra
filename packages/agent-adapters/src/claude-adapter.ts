import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';import {
  agentProcessIdentitySchema,
  type AdapterCapabilities,
  type AgentAnswerAdapter,
  type AgentAnswerRequest,
  type AgentControlReceipt,
  type AgentObservedEvent,
  type AgentProcessRelease,
  type AgentSessionRef,
  type AgentStartRequest,
} from '@codeestra/contracts';
import { ClaudeStreamClient, type ClaudeFrame } from './claude-process.js';
import {
  assertClaudeAcceptsAgentConfiguration,
  assertOwnedClaudeTranscript,
  buildClaudeArguments,
  claudeCompletionFacts,
  claudeControlSubtypes,
  claudeFrameTypes,
  claudePermissionPrompt,
  claudePermissionResult,
  claudeResultVerdict,
  ClaudeAdapterError,
  claudeTranscriptPath,
  collectClaudeCompletionFacts,
  defaultClaudeConfigDir,
  expectedReportedPermissionMode,
  newClaudeFactAccumulator,
  parseClaudeInit,
  parseClaudePermissionRequest,
  parseClaudeResult,
} from './claude-protocol.js';
import { readProcessStartToken } from './pi-identity.js';

/**
 * The measured matrix for `claude 2.1.268`; see `docs/spikes/claude-2.1.268.md`.
 *
 * Every `SUPPORTED` here is backed by a local observation that does not need a model (frame shapes,
 * the CLI's own protocol code, the hook/agent suppression of `--safe-mode`, the transcript layout).
 * Everything whose verification needs a real model call is `REQUIRES_VALIDATION` instead, because
 * this machine has no Claude Code credentials: claiming those as verified would be a lie.
 */
/**
 * Claude Code has no per-resource launch selection (ADR-0044 D03): declared here so a read-only
 * projection reports UNSUPPORTED without probing the provider.
 */
export const claudePluginSelectionSupport = 'UNSUPPORTED' as const;

function claudeCapabilities(): AdapterCapabilities {
  return Object.freeze({
    // Measured: `--session-id <uuid>` pins the conversation and the transcript is written at
    // `<configDir>/projects/<key>/<session-id>.jsonl`.
    persistentSession: 'SUPPORTED',
    // The provider has an AskUserQuestion tool and the control channel carries both
    // `can_use_tool` and `request_user_dialog`, but which one delivers a question, and how an
    // answer is encoded, was **not** measured. This Adapter therefore does not claim a structured
    // question channel; see the ADR.
    structuredAttention: 'REQUIRES_VALIDATION',
    // The permission channel (`can_use_tool` request → `control_response` answer) is taken from the
    // CLI's own protocol implementation and documentation, and it is the provider's only path for a
    // prompt in `--print` mode; a real prompt round trip was not observed.
    nativePermissionRouting: 'REQUIRES_VALIDATION',
    // No pause/resume primitive exists: the CLI has no "pause this session" request.
    pauseWithQuiescence: 'UNSUPPORTED',
    // No revision-acknowledgement channel; corrections are delivered by stopping and starting again
    // (ADR-0028 refuses to infer an ACK from natural language).
    revisionAcknowledgement: 'UNSUPPORTED',
    // A `control_request{interrupt}` subtype exists, but whether an already started tool stops was
    // not measured, so this Adapter will not claim a cooperative stop it cannot prove.
    cooperativeStop: 'REQUIRES_VALIDATION',
    // The interactive TUI is a separate process writing the same conversation; attaching to a
    // `--print` child would be a second writer.
    attach: 'UNSUPPORTED',
    // ADR-0010/0023/0026 are Pi mechanisms and are deliberately *not* assumed here: handing a Claude
    // conversation to a terminal would need its own spike, its own measurement and its own ADR.
    nativeTerminalHandoff: 'UNSUPPORTED',
    // No tool-level start/end notification is exposed on the control channel, so the Runtime cannot
    // know a Claude safe point; the handoff must be refused instead of guessed from output.
    safePointNotification: 'UNSUPPORTED',
    // A lost `--print` child is never reattached; the provider has no rejoin for a stdio child.
    reconnectToLiveSession: 'UNSUPPORTED',
    // Measured: `--resume <session-id>` reopens the recorded session under the same id (the
    // transcript at the derived path is loaded, and no "conversation not found" error is raised).
    // Whether the resumed conversation is *recalled* needs a model answer and was not observed.
    resumeAfterExit: 'REQUIRES_VALIDATION',
    // Measured: `--safe-mode --strict-mcp-config` keeps the user's hooks (a SessionStart hook from
    // `~/.claude/settings.json`), user agents and MCP servers out of the session while OAuth,
    // model selection, built-in tools and permissions stay available. `--bare` would also disable
    // OAuth/keychain reads, so it would break the user's own login and is not used.
    controlledConfiguration: 'SUPPORTED',
    // Claude Code's safe-mode launch has no per-resource selection either; plugin selection is not
    // supported in this step and is reported as such (ADR-0044 D03).
    pluginSelection: claudePluginSelectionSupport,
  });
}

export interface ClaudeAdapterOptions {
  /** Executable used to launch Claude. Defaults to `claude` from PATH. */
  readonly claudeExecutable?: string;
  /** Arguments placed before the Claude argv, e.g. a launcher such as `run <script>`. */
  readonly launcherArgs?: readonly string[];
  /** Provider config home; `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
  readonly configDir?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  /** How long the CLI may take to answer `initialize` and to open the first turn. */
  readonly startTimeoutMs?: number;
  readonly maxRecordBytes?: number;
  readonly stopGraceMs?: number;
  readonly spawn?: (argv: readonly string[], options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  }) => Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  readonly readStartToken?: (pid: number) => Promise<string | null>;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

interface LiveSession {
  readonly client: ClaudeStreamClient;
  readonly providerSessionId: string;
  readonly sessionStorageRef: string;
  readonly processIdentity: unknown;
  readonly argv: readonly string[];
}

function composeRevisionPrompt(revision: AgentStartRequest['revision']): string {
  const lines = [`Codeestra revision ${revision.id}`, '', revision.specification.trim()];
  if (revision.constraints.length > 0) {
    lines.push('', 'Constraints:');
    for (const constraint of revision.constraints) {
      lines.push(`- ${constraint.id}: ${constraint.text.trim()}`);
    }
  }
  return lines.join('\n');
}

/**
 * A resumed Execution continues the same persistent conversation, so re-sending the whole
 * specification would ask the Agent to redo work it already did.
 */
function composeResumePrompt(revision: AgentStartRequest['revision']): string {
  return [
    `Codeestra: this execution was paused and has now resumed (revision ${revision.id}).`,
    'Continue the task from where you stopped; do not repeat work that is already done.',
  ].join('\n');
}

/**
 * Real Claude Code adapter over the `claude --print` stream-json control channel.
 *
 * It owns the CLI child and its pipes, so it can only observe or answer a Session whose process it
 * still holds. A lost process is reported as disconnected; it is never reattached, because a second
 * writer on one conversation is not something the provider prevents for us.
 */
export class ClaudeAdapter implements AgentAnswerAdapter, AgentProcessRelease {
  readonly id = 'claude';
  readonly #sessions = new Map<string, LiveSession>();
  readonly #unconfirmedStops: number[] = [];
  readonly #options: Required<Pick<ClaudeAdapterOptions,
    'claudeExecutable' | 'launcherArgs' | 'configDir' | 'environment'
    | 'requestTimeoutMs' | 'startTimeoutMs' | 'stopGraceMs'>>;
  readonly #spawn: NonNullable<ClaudeAdapterOptions['spawn']>;
  readonly #readStartToken: (pid: number) => Promise<string | null>;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #capabilities: AdapterCapabilities;
  #version: string | null = null;

  constructor(options: ClaudeAdapterOptions = {}) {
    const environment = options.environment ?? {};
    this.#options = {
      claudeExecutable: options.claudeExecutable ?? 'claude',
      launcherArgs: options.launcherArgs ?? [],
      configDir: resolveConfigDir(options.configDir, environment),
      environment,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      startTimeoutMs: options.startTimeoutMs ?? 60_000,
      stopGraceMs: options.stopGraceMs ?? 5_000,
    };
    this.#spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn([...argv], {
      cwd: spawnOptions.cwd,
      env: { ...spawnOptions.env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }));
    this.#readStartToken = options.readStartToken ?? readProcessStartToken;
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.maxRecordBytes = options.maxRecordBytes;
    this.#capabilities = claudeCapabilities();
  }

  readonly maxRecordBytes: number | undefined;

  capabilities(): AdapterCapabilities {
    return this.#capabilities;
  }

  /** The provider config home whose `projects/` directory owns the conversations we resume. */
  get configDirectory(): string {
    return this.#options.configDir;
  }

  async probe(): Promise<{ readonly version: string; readonly capabilities: AdapterCapabilities }> {
    if (this.#version !== null) return { version: this.#version, capabilities: this.#capabilities };
    let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
    try {
      child = this.#spawn([this.#options.claudeExecutable, ...this.#options.launcherArgs, '--version'], {
        cwd: homedir(),
        env: this.#options.environment,
      });
    } catch (error) {
      throw new ClaudeAdapterError('PROVIDER_VERSION_UNAVAILABLE',
        `Could not launch ${this.#options.claudeExecutable}: `
        + `${error instanceof Error ? error.message : String(error)}`, false, false);
    }
    let exitCode: number;
    let stdout: string;
    try {
      [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    } catch (error) {
      throw new ClaudeAdapterError('PROVIDER_VERSION_UNAVAILABLE',
        `Could not run ${this.#options.claudeExecutable} --version: `
        + `${error instanceof Error ? error.message : String(error)}`, false, false);
    }
    // `claude --version` prints `2.1.268 (Claude Code)`.
    const match = /(\d+\.\d+\.\d+)/.exec(stdout.trim());
    if (exitCode !== 0 || match === null) {
      throw new ClaudeAdapterError('PROVIDER_VERSION_UNAVAILABLE',
        `${this.#options.claudeExecutable} --version did not report a usable version`, false, false);
    }
    this.#version = match[1] as string;
    return { version: this.#version, capabilities: this.#capabilities };
  }

  async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    const agentConfig = request.agentConfig ?? {};
    // A configured provider cannot take effect in first-party Claude Code; failing here is how the
    // Execution record stays true instead of naming a provider that was never used.
    assertClaudeAcceptsAgentConfiguration({ provider: agentConfig.provider });
    // The provider keys its project directory on the *resolved* working directory, so the path this
    // Adapter records has to be derived from the same resolved path — otherwise a workspace reached
    // through a symlink would leave the recorded conversation path pointing at nothing.
    const workspaceCwd = canonicalCwd(request.workspace.cwd);
    let providerSessionId: string;
    let recordedRef: string | null = null;
    if (request.resume === undefined) {
      providerSessionId = this.#randomUUID();
    } else {
      if (request.resume.providerSessionId === null) {
        throw new ClaudeAdapterError('RESUME_SESSION_NOT_OWNED',
          'Claude resumes a conversation by session id; the recorded Session has none', false, false);
      }
      providerSessionId = request.resume.providerSessionId;
      if (request.resume.sessionStorageRef.trim().length === 0) {
        throw new ClaudeAdapterError('RESUME_SESSION_NOT_OWNED',
          'The recorded Claude Session has no session file path, so it cannot be resumed',
          false, false);
      }
      recordedRef = assertOwnedClaudeTranscript({
        configDir: this.#options.configDir,
        sessionStorageRef: request.resume.sessionStorageRef,
        providerSessionId,
        lstat: lstatSync,
        realpath: realpathSync,
      });
    }
    // `buildClaudeArguments` refuses a thinking level the provider cannot express, before any
    // process exists, so an unusable configuration never becomes a launched Session.
    const argv = buildClaudeArguments({
      permissionMode: request.permissionMode,
      ...(agentConfig.model === undefined ? {} : { model: agentConfig.model }),
      ...(agentConfig.thinkingLevel === undefined ? {} : { thinkingLevel: agentConfig.thinkingLevel }),
      ...(request.resume === undefined
        ? { sessionId: providerSessionId }
        : { resumeSessionId: providerSessionId }),
    });
    let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
    try {
      child = this.#spawn([this.#options.claudeExecutable, ...this.#options.launcherArgs, ...argv], {
        cwd: workspaceCwd,
        env: { ...this.#options.environment, ...request.environment,
          CODEESTRA_PERMISSION_MODE: request.permissionMode },
      });
    } catch (error) {
      throw new ClaudeAdapterError('PROVIDER_SPAWN_FAILED',
        `Could not launch ${this.#options.claudeExecutable}: `
        + `${error instanceof Error ? error.message : String(error)}`, false, false);
    }
    const client = new ClaudeStreamClient(child, this.#randomUUID(), {
      ...(this.maxRecordBytes === undefined ? {} : { maxRecordBytes: this.maxRecordBytes }),
      requestTimeoutMs: this.#options.requestTimeoutMs,
    });
    try {
      await this.#initialize(client, request.permissionMode);
      await client.write({
        type: 'user',
        message: {
          role: 'user',
          content: request.resume === undefined
            ? composeRevisionPrompt(request.revision)
            : composeResumePrompt(request.revision),
        },
      });
      const initFrame = await client.takeUntil(
        (frame) => frame.kind === 'message' && parseClaudeInit(frame.payload) !== null,
        this.#options.startTimeoutMs,
      );
      const init = initFrame !== null && initFrame.kind === 'message'
        ? parseClaudeInit(initFrame.payload)
        : null;
      if (init === null) {
        throw new ClaudeAdapterError('INVALID_PROVIDER_RESPONSE',
          'Claude did not open the conversation with a session identity this Adapter can read');
      }
      if (init.sessionId !== providerSessionId) {
        throw new ClaudeAdapterError('SESSION_IDENTITY_MISMATCH',
          `Claude opened conversation ${init.sessionId} instead of ${providerSessionId}`);
      }
      const reportedMode = init.permissionMode;
      if (reportedMode !== null
        && !expectedReportedPermissionMode(request.permissionMode).includes(reportedMode)) {
        throw new ClaudeAdapterError('INVALID_PROVIDER_RESPONSE',
          `Claude reports permission mode ${reportedMode} where ${request.permissionMode} requires`
          + ` ${expectedReportedPermissionMode(request.permissionMode).join(' or ')}`);
      }
      const startToken = await this.#readStartToken(child.pid);
      if (startToken === null) {
        throw new ClaudeAdapterError('PROCESS_IDENTITY_UNAVAILABLE',
          `Could not read a start token for the Claude child process ${child.pid}`);
      }
      const processIdentity = agentProcessIdentitySchema.parse({
        pid: child.pid,
        executable: this.#options.claudeExecutable,
        startToken,
        argvHash: createHash('sha256').update(JSON.stringify(argv)).digest('hex'),
        capturedAt: this.#now(),
      });
      const sessionStorageRef = recordedRef ?? claudeTranscriptPath({
        configDir: this.#options.configDir,
        cwd: workspaceCwd,
        sessionId: providerSessionId,
      });
      this.#sessions.set(request.sessionId, {
        client,
        providerSessionId,
        sessionStorageRef,
        processIdentity,
        argv,
      });
      return {
        id: request.sessionId,
        executionId: request.executionId,
        adapterId: this.id,
        providerSessionId,
        processIdentity,
        sessionStorageRef,
      };
    } catch (error) {
      const cleanup = await client.stop({ graceMs: this.#options.stopGraceMs });
      const code = error instanceof ClaudeAdapterError ? error.code : 'PROVIDER_SPAWN_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      const suffix = cleanup.exited
        ? ` (Claude process ${cleanup.pid} was confirmed stopped)`
        : ` (Claude process ${cleanup.pid} could NOT be confirmed stopped)`;
      throw new ClaudeAdapterError(code, `${message}${suffix}`, true, false);
    }
  }

  async *observe(session: AgentSessionRef, cursor?: string): AsyncIterable<AgentObservedEvent> {
    if (session.adapterId !== this.id) {
      throw new ClaudeAdapterError('SESSION_IDENTITY_MISMATCH',
        `Claude adapter cannot observe ${session.adapterId}`);
    }
    const live = this.#sessions.get(session.id);
    if (live === undefined) {
      throw new ClaudeAdapterError('LIVE_SESSION_UNAVAILABLE',
        `No live Claude process is held for Session ${session.id};`
        + ' a lost process is never reattached');
    }
    if (session.providerSessionId !== undefined && session.providerSessionId !== live.providerSessionId) {
      throw new ClaudeAdapterError('SESSION_IDENTITY_MISMATCH',
        'Session provider identity did not match the live Claude conversation');
    }
    if (cursor !== undefined && !cursor.startsWith(live.client.cursorPrefix())) {
      throw new ClaudeAdapterError('CURSOR_EPOCH_MISMATCH',
        'Observation cursor belongs to a different Claude process epoch');
    }
    const evidenceRef = `claude-stream:result:session=${live.providerSessionId}`
      + `:epoch=${live.client.epoch}:launch=${createHash('sha256')
        .update(JSON.stringify(live.argv)).digest('hex').slice(0, 16)}`;
    const facts = newClaudeFactAccumulator();
    for await (const frame of live.client.frames()) {
      if (frame.kind === 'disconnected') {
        this.#sessions.delete(session.id);
        yield {
          sessionId: session.id,
          executionId: session.executionId,
          eventId: `claude-disconnect:${frame.cursor}`,
          cursor: frame.cursor,
          type: 'disconnected',
          reason: frame.reason,
        };
        return;
      }
      if (frame.kind === 'control-request') {
        const attention = this.#mapControlRequest({ frame, session });
        if (attention !== null) {
          yield attention;
          continue;
        }
        // An unanswerable control request is refused explicitly: leaving it open would hang the
        // Agent with no way for the user to see or answer it, and a dialog this host never declared
        // must fail closed rather than block the turn.
        await live.client.respondUnsupported(frame.id,
          `Codeestra Claude adapter does not implement ${frame.subtype}`);
        continue;
      }
      // A withdrawn request needs no event: the provider no longer accepts an answer for it, and
      // the Attention the Runtime already recorded stays answerable as a delivery that is refused
      // with `UNKNOWN_PROVIDER_REQUEST` — never as a silent success.
      if (frame.kind === 'control-cancel') continue;

      const payload = frame.payload;
      collectClaudeCompletionFacts(facts, payload);
      const init = parseClaudeInit(payload);
      if (init !== null && init.sessionId !== live.providerSessionId) {
        // A second conversation claiming this Session's identity must not be observed as if it were
        // the same run; the scene is kept and the Runtime is told the transport is gone.
        this.#sessions.delete(session.id);
        const stopped = await live.client.stop({ graceMs: this.#options.stopGraceMs });
        if (!stopped.exited) this.#unconfirmedStops.push(stopped.pid);
        yield {
          sessionId: session.id,
          executionId: session.executionId,
          eventId: `claude-identity:${frame.cursor}`,
          cursor: frame.cursor,
          type: 'disconnected',
          reason: `Claude reported conversation ${init.sessionId} instead of`
            + ` ${live.providerSessionId}, so this run can no longer be attributed`,
        };
        return;
      }
      if (payload['type'] !== claudeFrameTypes.result) continue;

      const result = parseClaudeResult(payload);
      this.#sessions.delete(session.id);
      // The result frame only ends the *turn*: a `--print` session stays alive for more input, and
      // Phase 1 never reattaches a live process. A completion is therefore only reported once our
      // own child is confirmed gone.
      const stopped = await live.client.stop({ graceMs: this.#options.stopGraceMs });
      if (!stopped.exited) {
        this.#unconfirmedStops.push(stopped.pid);
        yield {
          sessionId: session.id,
          executionId: session.executionId,
          eventId: `claude-unstopped:${frame.cursor}`,
          cursor: frame.cursor,
          type: 'disconnected',
          reason: `Claude process ${stopped.pid} did not confirm its stop, so no writer`
            + ' ownership can be claimed for this Session',
        };
        return;
      }
      if (result === null) {
        yield this.#completed({
          session, frame, evidenceRef: `${evidenceRef}:invalid`,
          outcome: 'FAILURE',
          failure: { code: 'PROVIDER_RESPONSE_INVALID',
            message: 'Claude reported a result this Adapter could not interpret' },
          facts: claudeCompletionFacts(facts),
        });
        return;
      }
      if (result.sessionId !== null && result.sessionId !== live.providerSessionId) {
        yield {
          sessionId: session.id,
          executionId: session.executionId,
          eventId: `claude-identity:${frame.cursor}`,
          cursor: frame.cursor,
          type: 'disconnected',
          reason: `Claude reported the result of conversation ${result.sessionId} instead of`
            + ` ${live.providerSessionId}`,
        };
        return;
      }
      const verdict = claudeResultVerdict(result);
      yield this.#completed({
        session, frame, evidenceRef,
        outcome: verdict.outcome,
        ...(verdict.failure === undefined ? {} : { failure: verdict.failure }),
        facts: claudeCompletionFacts(facts),
      });
      return;
    }
  }

  async answer(session: AgentSessionRef, request: AgentAnswerRequest): Promise<AgentControlReceipt> {
    const live = this.#sessions.get(session.id);
    if (live === undefined || session.adapterId !== this.id) {
      throw new ClaudeAdapterError('LIVE_SESSION_UNAVAILABLE',
        `No live Claude process is held for Session ${session.id}; the answer was not written`,
        false, true);
    }
    const pending = live.client.controlRequest(request.providerRequestId);
    if (pending === null) {
      throw new ClaudeAdapterError('UNKNOWN_PROVIDER_REQUEST',
        `Claude request ${request.providerRequestId} is no longer open; the answer was not written`,
        false, false);
    }
    if (pending.subtype !== claudeControlSubtypes.canUseTool) {
      throw new ClaudeAdapterError('UNSUPPORTED_ANSWER',
        `Claude request ${pending.subtype} is not answerable through this Adapter`, false, false);
    }
    const parsed = parseClaudePermissionRequest(pending.params);
    if (parsed === null) {
      throw new ClaudeAdapterError('UNSUPPORTED_ANSWER',
        'Claude asked for permission with a payload this Adapter cannot interpret', false, false);
    }
    await live.client.respond(pending.id, claudePermissionResult({ request: parsed, answer: request.answer }));
    return { providerRequestId: request.providerRequestId, accepted: true };
  }

  /** Provider PIDs this adapter could not confirm stopped. The Runtime must surface them. */
  unconfirmedStops(): readonly number[] {
    return this.#unconfirmedStops;
  }

  /** Called by the Runtime to release a live child it no longer tracks. */
  async releaseSession(sessionId: string): Promise<{ readonly exited: boolean; readonly pid: number } | null> {
    const live = this.#sessions.get(sessionId);
    if (live === undefined) return null;
    this.#sessions.delete(sessionId);
    return live.client.stop({ graceMs: this.#options.stopGraceMs });
  }

  /**
   * Opens the control session.
   *
   * The CLI answers this locally, before any model request, and its reply reports the permission
   * mode that is actually in force — which is checked against the requested one, so a launch that
   * silently ran with a weaker mode cannot be recorded as the requested mode.
   *
   * No dialog kind is declared. The CLI documents that an absent declaration means "cannot
   * display" and that a dialog-gated flow then degrades to its no-dialog behavior — the fail-closed
   * direction. This Adapter implements no dialogs, so it declares none instead of pretending it
   * could render them.
   */
  async #initialize(client: ClaudeStreamClient, permissionMode: 'FULL' | 'STRICT'): Promise<void> {
    const response = await client.request(claudeControlSubtypes.initialize);
    if (typeof response !== 'object' || response === null) {
      throw new ClaudeAdapterError('INVALID_PROVIDER_RESPONSE',
        'Claude returned an unreadable initialize response');
    }
    const reported = (response as Readonly<Record<string, unknown>>)['current_permission_mode'];
    if (typeof reported === 'string' && !expectedReportedPermissionMode(permissionMode).includes(reported)) {
      throw new ClaudeAdapterError('INVALID_PROVIDER_RESPONSE',
        `Claude opened the session in permission mode ${reported} where ${permissionMode} requires`
        + ` ${expectedReportedPermissionMode(permissionMode).join(' or ')}`);
    }
  }

  #completed(input: {
    readonly session: AgentSessionRef;
    readonly frame: Extract<ClaudeFrame, { kind: 'message' }>;
    readonly evidenceRef: string;
    readonly outcome: 'SUCCESS' | 'FAILURE';
    readonly failure?: { readonly code: string; readonly message: string };
    readonly facts: ReturnType<typeof claudeCompletionFacts>;
  }): AgentObservedEvent {
    const failure = input.failure;
    return {
      sessionId: input.session.id,
      executionId: input.session.executionId,
      eventId: `claude-settled:${input.frame.cursor}`,
      cursor: input.frame.cursor,
      type: 'completed',
      outcome: input.outcome,
      ...(failure === undefined ? {} : { failure }),
      facts: input.facts,
      evidence: {
        ref: failure === undefined ? input.evidenceRef : `${input.evidenceRef}:failure=${failure.message}`,
        // The provider process is confirmed gone by the time a completion is emitted.
        toolsQuiescent: true,
        ownedWritersStopped: true,
      },
    };
  }

  #mapControlRequest(input: {
    readonly frame: Extract<ClaudeFrame, { kind: 'control-request' }>;
    readonly session: AgentSessionRef;
  }): AgentObservedEvent | null {
    if (input.frame.subtype !== claudeControlSubtypes.canUseTool) return null;
    const parsed = parseClaudePermissionRequest(input.frame.params);
    if (parsed === null) return null;
    return {
      sessionId: input.session.id,
      executionId: input.session.executionId,
      eventId: `claude-request:${input.frame.cursor}`,
      cursor: input.frame.cursor,
      providerRequestId: input.frame.id,
      type: 'attention',
      kind: 'PERMISSION',
      responseType: 'CONFIRM',
      prompt: claudePermissionPrompt(parsed),
    };
  }
}

function canonicalCwd(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // A workspace that cannot be resolved is still spawned in; the derived conversation path then
    // simply will not be found at resume time, which refuses the resume instead of guessing.
    return resolve(path);
  }
}

function resolveConfigDir(
  configured: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (configured !== undefined && configured.trim().length > 0) return resolve(configured);
  return defaultClaudeConfigDir(environment);
}
