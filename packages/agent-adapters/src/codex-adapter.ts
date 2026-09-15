import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  agentProcessIdentitySchema,
  type AdapterCapabilities,
  type AgentAnswerAdapter,
  type AgentAnswerRequest,
  type AgentConfiguration,
  type AgentControlReceipt,
  type AgentObservedEvent,
  type AgentProcessRelease,
  type AgentSessionRef,
  type AgentStartRequest,
} from '@codeestra/contracts';
import { CodexAppServerClient, type CodexFrame } from './codex-process.js';
import {
  buildCodexAppServerArguments,
  codexApprovalDecision,
  codexApprovalKind,
  codexApprovalPrompt,
  codexMethods,
  codexPermissionPolicy,
  codexPlainQuestionPrompt,
  codexQuestionnairePrompt,
  CodexAdapterError,
  encodeCodexUserInputResult,
  parseCodexThreadIdentity,
  parseCodexTurnCompletion,
  parseCodexTurnId,
  parseCodexUserInput,
} from './codex-protocol.js';
import { readProcessStartToken } from './pi-identity.js';

/** The measured matrix for `codex-cli 0.151.0`; see `docs/spikes/codex-0.151.0.md`. */
/**
 * Codex has no per-resource launch selection (ADR-0044 D03): declared here so a read-only
 * projection reports UNSUPPORTED without probing the provider.
 */
export const codexPluginSelectionSupport = 'UNSUPPORTED' as const;

function codexCapabilities(options: { readonly enableRequestUserInput: boolean }): AdapterCapabilities {
  return Object.freeze({
    persistentSession: 'SUPPORTED',
    // The provider has the channel, but its `request_user_input` tool only exists behind an
    // under-development feature flag; without it the Agent cannot ask at all.
    structuredAttention: options.enableRequestUserInput ? 'SUPPORTED' : 'UNSUPPORTED',
    // Measured: approval requests are fail-closed until the client answers, and both accept and
    // decline were verified end to end.
    nativePermissionRouting: 'SUPPORTED',
    pauseWithQuiescence: 'UNSUPPORTED',
    revisionAcknowledgement: 'UNSUPPORTED',
    // Measured: `turn/interrupt` returns but an already started shell tool keeps running, and
    // SIGTERM to the app-server leaves it running as an orphan.
    cooperativeStop: 'REQUIRES_VALIDATION',
    // The interactive TUI talks to the shared app-server daemon, not to this stdio child, so
    // attaching would be a second writer on one conversation.
    attach: 'UNSUPPORTED',
    // Measured (docs/spikes/codex-0.151.0.md §3): the app-server protocol has no terminal handoff
    // and Codex's own TUI is a different writer on the same thread. ADR-0010/0023/0026 are Pi
    // mechanisms and are deliberately *not* assumed here; handing a Codex conversation to a terminal
    // would need its own spike and its own ADR.
    nativeTerminalHandoff: 'UNSUPPORTED',
    // Measured: an interrupted turn produces no `completed` event, and there is no tool-level
    // start/end notification. The Runtime therefore cannot know a Codex safe point; it must refuse
    // the handoff (`SAFE_POINT_NOT_REACHED`) instead of guessing from output.
    safePointNotification: 'UNSUPPORTED',
    reconnectToLiveSession: 'UNSUPPORTED',
    // Measured: `thread/resume` recovers the same thread id, rollout path and conversation.
    resumeAfterExit: 'SUPPORTED',
    // Measured: app-server has no `--ignore-user-config`; ambient plugins/MCP servers/hooks run.
    controlledConfiguration: 'UNSUPPORTED',
    // Codex has no per-resource selection on its launch: plugin selection is not supported in this
    // step and is reported as such instead of being faked (ADR-0044 D03).
    pluginSelection: codexPluginSelectionSupport,
  });
}

export interface CodexAdapterOptions {
  /** Executable used to launch Codex. Defaults to `codex` from PATH. */
  readonly codexExecutable?: string;
  /** Arguments placed before the Codex argv, e.g. a launcher such as `run <script>`. */
  readonly launcherArgs?: readonly string[];
  /**
   * Enables the provider's `request_user_input` tool (`--enable default_mode_request_user_input`).
   * It is an under-development feature, so it is off unless the operator opts in.
   */
  readonly enableRequestUserInput?: boolean;
  /** `$CODEX_HOME`; also the ownership root for resume paths. Defaults to env or `~/.codex`. */
  readonly codexHome?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
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
  readonly client: CodexAppServerClient;
  readonly providerSessionId: string;
  readonly sessionStorageRef: string;
  readonly processIdentity: unknown;
  readonly permissionMode: 'FULL' | 'STRICT';
  readonly agentConfig: AgentConfiguration;
  readonly turnId: string;
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
 * A resumed Execution continues the same persistent Codex thread, so re-sending the whole
 * specification would ask the Agent to redo work it already did.
 */
function composeResumePrompt(revision: AgentStartRequest['revision']): string {
  return [
    `Codeestra: this execution was paused and has now resumed (revision ${revision.id}).`,
    'Continue the task from where you stopped; do not repeat work that is already done.',
  ].join('\n');
}

function defaultCodexHome(environment: Readonly<Record<string, string | undefined>>): string {
  const configured = environment['CODEX_HOME'];
  if (configured !== undefined && configured.trim().length > 0) return resolve(configured);
  return join(homedir(), '.codex');
}

/**
 * Real Codex adapter over the app-server JSONL JSON-RPC transport.
 *
 * It owns the `codex app-server --stdio` child and its pipes, so it can only observe or answer a
 * Session whose process it still holds. A lost process is reported as disconnected; it is never
 * reattached, because a second writer on one thread is not something Codex prevents for us.
 */
export class CodexAdapter implements AgentAnswerAdapter, AgentProcessRelease {
  readonly id = 'codex';
  readonly #sessions = new Map<string, LiveSession>();
  readonly #unconfirmedStops: number[] = [];
  readonly #options: Required<Pick<CodexAdapterOptions,
    | 'codexExecutable' | 'launcherArgs' | 'enableRequestUserInput' | 'codexHome'
    | 'environment' | 'requestTimeoutMs' | 'stopGraceMs'>>;
  readonly #spawn: NonNullable<CodexAdapterOptions['spawn']>;
  readonly #readStartToken: (pid: number) => Promise<string | null>;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #capabilities: AdapterCapabilities;
  #version: string | null = null;

  constructor(options: CodexAdapterOptions = {}) {
    const environment = options.environment ?? {};
    this.#options = {
      codexExecutable: options.codexExecutable ?? 'codex',
      launcherArgs: options.launcherArgs ?? [],
      enableRequestUserInput: options.enableRequestUserInput ?? false,
      codexHome: resolve(options.codexHome ?? defaultCodexHome(environment)),
      environment,
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
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
    this.#capabilities = codexCapabilities({ enableRequestUserInput: this.#options.enableRequestUserInput });
  }

  readonly maxRecordBytes: number | undefined;

  capabilities(): AdapterCapabilities {
    return this.#capabilities;
  }

  /** The provider session directory this Adapter is willing to resume from. */
  get sessionDirectory(): string {
    return join(this.#options.codexHome, 'sessions');
  }

  async probe(): Promise<{ readonly version: string; readonly capabilities: AdapterCapabilities }> {
    if (this.#version !== null) return { version: this.#version, capabilities: this.#capabilities };
    let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
    try {
      child = this.#spawn([this.#options.codexExecutable, ...this.#options.launcherArgs, '--version'], {
        cwd: this.#options.codexHome,
        env: this.#options.environment,
      });
    } catch (error) {
      throw new CodexAdapterError('PROVIDER_VERSION_UNAVAILABLE',
        `Could not launch ${this.#options.codexExecutable}: ${error instanceof Error ? error.message : String(error)}`,
        false, false);
    }
    let exitCode: number;
    let stdout: string;
    try {
      [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    } catch (error) {
      throw new CodexAdapterError('PROVIDER_VERSION_UNAVAILABLE',
        `Could not run ${this.#options.codexExecutable} --version: `
        + `${error instanceof Error ? error.message : String(error)}`, false, false);
    }
    // `codex --version` prints `codex-cli 0.151.0`.
    const match = /(\d+\.\d+\.\d+)/.exec(stdout.trim());
    if (exitCode !== 0 || match === null) {
      throw new CodexAdapterError('PROVIDER_VERSION_UNAVAILABLE',
        `${this.#options.codexExecutable} --version did not report a usable version`, false, false);
    }
    this.#version = match[1] as string;
    return { version: this.#version, capabilities: this.#capabilities };
  }

  async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    const agentConfig = request.agentConfig ?? {};
    const policy = codexPermissionPolicy(request.permissionMode);
    const argv = [
      ...this.#options.launcherArgs,
      ...buildCodexAppServerArguments({
        ...(agentConfig.thinkingLevel === undefined ? {} : { thinkingLevel: agentConfig.thinkingLevel }),
        enableRequestUserInput: this.#options.enableRequestUserInput,
      }),
    ];
    let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
    try {
      child = this.#spawn([this.#options.codexExecutable, ...argv], {
        cwd: request.workspace.cwd,
        env: { ...this.#options.environment, ...request.environment, CODEESTRA_PERMISSION_MODE: request.permissionMode },
      });
    } catch (error) {
      throw new CodexAdapterError('PROVIDER_SPAWN_FAILED',
        `Could not launch ${this.#options.codexExecutable}: ${error instanceof Error ? error.message : String(error)}`,
        false, false);
    }
    const client = new CodexAppServerClient(child, this.#randomUUID(), {
      ...(this.maxRecordBytes === undefined ? {} : { maxRecordBytes: this.maxRecordBytes }),
      requestTimeoutMs: this.#options.requestTimeoutMs,
    });
    try {
      await client.initialize({ name: 'codeestra', version: '0.0.0' });
      const threadParams = {
        cwd: request.workspace.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandbox: policy.sandbox,
        ...(agentConfig.model === undefined ? {} : { model: agentConfig.model }),
        ...(agentConfig.provider === undefined ? {} : { modelProvider: agentConfig.provider }),
      };
      let identity;
      let prompt: string;
      if (request.resume === undefined) {
        identity = parseCodexThreadIdentity('thread/start',
          await client.request('thread/start', threadParams));
        prompt = composeRevisionPrompt(request.revision);
      } else {
        const recorded = this.#assertOwnedResumePath(request.resume.sessionStorageRef);
        if (request.resume.providerSessionId === null) {
          throw new CodexAdapterError('RESUME_SESSION_NOT_OWNED',
            'Codex resumes a conversation by thread id; the recorded Session has none', false, false);
        }
        identity = parseCodexThreadIdentity('thread/resume', await client.request('thread/resume', {
          threadId: request.resume.providerSessionId,
          ...threadParams,
        }));
        // A resumed conversation must be the very one this Runtime recorded, not merely a thread
        // that happens to have the same id in a different Codex home.
        if (identity.providerSessionId !== request.resume.providerSessionId
          || identity.sessionStorageRef !== recorded) {
          throw new CodexAdapterError('SESSION_IDENTITY_MISMATCH',
            'The resumed Codex thread did not match the recorded thread id and rollout path');
        }
        prompt = composeResumePrompt(request.revision);
      }
      const turnId = parseCodexTurnId(await client.request('turn/start', {
        threadId: identity.providerSessionId,
        input: [{ type: 'text', text: prompt }],
      }));
      const startToken = await this.#readStartToken(child.pid);
      if (startToken === null) {
        throw new CodexAdapterError('PROCESS_IDENTITY_UNAVAILABLE',
          `Could not read a start token for the Codex child process ${child.pid}`);
      }
      const processIdentity = agentProcessIdentitySchema.parse({
        pid: child.pid,
        executable: this.#options.codexExecutable,
        startToken,
        argvHash: createHash('sha256').update(JSON.stringify(argv)).digest('hex'),
        capturedAt: this.#now(),
      });
      this.#sessions.set(request.sessionId, {
        client,
        providerSessionId: identity.providerSessionId,
        sessionStorageRef: identity.sessionStorageRef,
        processIdentity,
        permissionMode: request.permissionMode,
        agentConfig,
        turnId,
      });
      return {
        id: request.sessionId,
        executionId: request.executionId,
        adapterId: this.id,
        providerSessionId: identity.providerSessionId,
        processIdentity,
        sessionStorageRef: identity.sessionStorageRef,
      };
    } catch (error) {
      const cleanup = await client.stop({ graceMs: this.#options.stopGraceMs });
      const code = error instanceof CodexAdapterError ? error.code : 'PROVIDER_SPAWN_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      const suffix = cleanup.exited
        ? ` (Codex process ${cleanup.pid} was confirmed stopped)`
        : ` (Codex process ${cleanup.pid} could NOT be confirmed stopped)`;
      throw new CodexAdapterError(code, `${message}${suffix}`, true, false);
    }
  }

  async *observe(session: AgentSessionRef, cursor?: string): AsyncIterable<AgentObservedEvent> {
    if (session.adapterId !== this.id) {
      throw new CodexAdapterError('SESSION_IDENTITY_MISMATCH',
        `Codex adapter cannot observe ${session.adapterId}`);
    }
    const live = this.#sessions.get(session.id);
    if (live === undefined) {
      throw new CodexAdapterError('LIVE_SESSION_UNAVAILABLE',
        `No live Codex app-server process is held for Session ${session.id};`
        + ' a lost process is never reattached');
    }
    if (session.providerSessionId !== undefined && session.providerSessionId !== live.providerSessionId) {
      throw new CodexAdapterError('SESSION_IDENTITY_MISMATCH',
        'Session provider identity did not match the live Codex thread');
    }
    if (cursor !== undefined && !cursor.startsWith(live.client.cursorPrefix())) {
      throw new CodexAdapterError('CURSOR_EPOCH_MISMATCH',
        'Observation cursor belongs to a different Codex process epoch');
    }
    const evidenceRef = `codex-app-server:turn_terminal:thread=${live.providerSessionId}`
      + `:turn=${live.turnId}:epoch=${live.client.epoch}:launch=${createHash('sha256')
        .update(JSON.stringify(buildCodexAppServerArguments({
          ...(live.agentConfig.thinkingLevel === undefined ? {} : { thinkingLevel: live.agentConfig.thinkingLevel }),
          enableRequestUserInput: this.#options.enableRequestUserInput,
        }))).digest('hex').slice(0, 16)}`;
    for await (const frame of live.client.frames()) {
      if (frame.kind === 'disconnected') {
        this.#sessions.delete(session.id);
        yield {
          sessionId: session.id,
          executionId: session.executionId,
          eventId: `codex-disconnect:${frame.cursor}`,
          cursor: frame.cursor,
          type: 'disconnected',
          reason: frame.reason,
        };
        return;
      }
      if (frame.kind === 'server-request') {
        const attention = this.#mapServerRequest({ frame, session });
        if (attention !== null) {
          yield attention;
          continue;
        }
        // An unanswerable server request is refused explicitly: leaving it open would hang the
        // Agent with no way for the user to see or answer it.
        await live.client.respondUnsupported(frame.id,
          `Codeestra Codex adapter does not implement ${frame.method}`);
        continue;
      }
      // Error notifications (`willRetry: true`) and `item` errors are provider diagnostics that
      // can accompany a turn which still completes. The turn's own terminal status is the only
      // verdict this Adapter will report as an outcome.
      if (frame.method !== codexMethods.turnCompleted) continue;

      const completion = parseCodexTurnCompletion(frame.params);
      if (completion !== null && completion.status === 'interrupted') {
        // Measured: an interrupted turn does not stop a tool that already started. Never claim
        // quiescence here; report a transport-level loss so the Runtime keeps the scene.
        // The Session entry is deliberately kept: this Runtime still owns the child and remains
        // the only component that can stop it (`releaseSession` / Runtime shutdown).
        yield {
          sessionId: session.id,
          executionId: session.executionId,
          eventId: `codex-interrupted:${frame.cursor}`,
          cursor: frame.cursor,
          type: 'disconnected',
          reason: 'Codex reported the turn as interrupted; tool quiescence is not proven, so this'
            + ' Adapter will not report a completion',
        };
        return;
      }
      this.#sessions.delete(session.id);
      // Codex keeps an idle app-server alive after the turn; Phase 1 never reattaches a live
      // process, so the completion is only reported once our own child is confirmed stopped.
      // An unparseable turn completion is reported with the same rule: without a confirmed stop
      // there is no honest completion, whatever the payload said.
      const stopped = await live.client.stop({ graceMs: this.#options.stopGraceMs });
      if (!stopped.exited) {
        this.#unconfirmedStops.push(stopped.pid);
        yield {
          sessionId: session.id,
          executionId: session.executionId,
          eventId: `codex-unstopped:${frame.cursor}`,
          cursor: frame.cursor,
          type: 'disconnected',
          reason: `Codex app-server process ${stopped.pid} did not confirm its stop, so no writer`
            + ' ownership can be claimed for this Session',
        };
        return;
      }
      if (completion === null) {
        yield {
          sessionId: session.id,
          executionId: session.executionId,
          eventId: `codex-settled:${frame.cursor}`,
          cursor: frame.cursor,
          type: 'completed',
          outcome: 'FAILURE',
          failure: { code: 'PROVIDER_RESPONSE_INVALID',
            message: 'Codex reported a turn completion this Adapter could not interpret' },
          evidence: { ref: `${evidenceRef}:invalid`, toolsQuiescent: true, ownedWritersStopped: true },
        };
        return;
      }
      const failure = completion.status === 'failed'
        ? { code: 'PROVIDER_TURN_FAILED', message: completion.message.slice(0, 300) }
        : null;
      yield {
        sessionId: session.id,
        executionId: session.executionId,
        eventId: `codex-settled:${frame.cursor}`,
        cursor: frame.cursor,
        type: 'completed',
        outcome: failure === null ? 'SUCCESS' : 'FAILURE',
        ...(failure === null ? {} : { failure }),
        evidence: {
          ref: failure === null ? evidenceRef : `${evidenceRef}:failure=${failure.message}`,
          toolsQuiescent: true,
          ownedWritersStopped: true,
        },
      };
      return;
    }
  }

  async answer(session: AgentSessionRef, request: AgentAnswerRequest): Promise<AgentControlReceipt> {
    const live = this.#sessions.get(session.id);
    if (live === undefined || session.adapterId !== this.id) {
      throw new CodexAdapterError('LIVE_SESSION_UNAVAILABLE',
        `No live Codex app-server is held for Session ${session.id}; the answer was not written`,
        false, true);
    }
    const pending = live.client.serverRequest(request.providerRequestId);
    if (pending === null) {
      throw new CodexAdapterError('UNKNOWN_PROVIDER_REQUEST',
        `Codex request ${request.providerRequestId} is no longer open; the answer was not written`,
        false, false);
    }
    const approvalKind = codexApprovalKind(pending.method);
    if (approvalKind !== null) {
      await live.client.respond(pending.id, { decision: codexApprovalDecision(request.answer) });
      return { providerRequestId: request.providerRequestId, accepted: true };
    }
    if (pending.method === codexMethods.userInput) {
      const parsed = parseCodexUserInput(pending.params);
      if (parsed === null) {
        throw new CodexAdapterError('UNSUPPORTED_ANSWER',
          'Codex asked a question whose payload this Adapter cannot interpret', false, false);
      }
      const mapped = codexQuestionnairePrompt(parsed);
      await live.client.respond(pending.id, encodeCodexUserInputResult({
        request: parsed,
        answer: request.answer,
        questionnaire: mapped?.questionnaire,
      }));
      return { providerRequestId: request.providerRequestId, accepted: true };
    }
    throw new CodexAdapterError('UNSUPPORTED_ANSWER',
      `Codex request ${pending.method} is not answerable through this Adapter`, false, false);
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

  #mapServerRequest(input: {
    readonly frame: Extract<CodexFrame, { kind: 'server-request' }>;
    readonly session: AgentSessionRef;
  }): AgentObservedEvent | null {
    const identity = {
      sessionId: input.session.id,
      executionId: input.session.executionId,
      eventId: `codex-request:${input.frame.cursor}`,
      cursor: input.frame.cursor,
      providerRequestId: input.frame.id,
    };
    const approvalKind = codexApprovalKind(input.frame.method);
    if (approvalKind !== null) {
      return {
        ...identity,
        type: 'attention',
        kind: 'PERMISSION',
        responseType: 'CONFIRM',
        prompt: codexApprovalPrompt({ kind: approvalKind, params: input.frame.params }),
      };
    }
    if (input.frame.method === codexMethods.userInput) {
      const parsed = parseCodexUserInput(input.frame.params);
      if (parsed === null) return null;
      const mapped = codexQuestionnairePrompt(parsed);
      return {
        ...identity,
        type: 'attention',
        kind: 'QUESTION',
        responseType: 'VALUE',
        prompt: mapped?.prompt ?? codexPlainQuestionPrompt(parsed),
      };
    }
    return null;
  }

  /**
   * A recorded rollout path is only trusted when it is a plain file inside the session directory of
   * the Codex home this Adapter will launch with. A stored string is never treated as proof that the
   * path belongs to this Runtime.
   */
  #assertOwnedResumePath(sessionStorageRef: string): string {
    const root = resolve(this.sessionDirectory);
    const candidate = isAbsolute(sessionStorageRef)
      ? resolve(sessionStorageRef)
      : resolve(root, sessionStorageRef);
    const inside = relative(root, candidate);
    if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) {
      throw new CodexAdapterError('RESUME_SESSION_NOT_OWNED',
        'The resumed session file is not inside the Codex session directory', false, false);
    }
    let stats;
    try {
      stats = lstatSync(candidate);
    } catch {
      throw new CodexAdapterError('RESUME_SESSION_NOT_OWNED',
        'The recorded Codex session file does not exist, so it cannot be resumed', false, false);
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new CodexAdapterError('RESUME_SESSION_NOT_OWNED',
        'The recorded Codex session path is not a plain file', false, false);
    }
    return candidate;
  }
}
