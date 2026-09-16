import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  agentProcessIdentitySchema,
  type AdapterCapabilities,
  type AgentAnswerAdapter,
  type AgentConfiguration,
  type AgentAnswerRequest,
  type AgentCompletionFacts,
  type AgentControlReceipt,
  type AgentObservedEvent,
  type AgentProcessRelease,
  type AgentSessionRef,
  type AgentPluginSelection,
  type AgentStartRequest,
} from '@codeestra/contracts';
import { readProcessStartToken } from './pi-identity.js';
import { PiRpcClient, PiRpcProcessError } from './pi-process.js';
import {
  buildPiGuidanceArguments,
  buildPiKnowledgeArguments,
  buildPiModelArguments,
  buildPiRpcArguments,
  mapPiExtensionUiRequest,
  piExtensionUiResponseRecord,
} from './pi-rpc.js';
import { KnowledgeContextError, knowledgeContextUnavailableCode, readVerifiedKnowledgeContext } from './knowledge-context.js';
import { GuidanceContextError, guidanceContextUnavailableCode, readVerifiedGuidanceContext } from './guidance-context.js';
import {
  assertPiPluginSelectionUsable,
  PiPluginError,
} from './pi-plugins.js';

/**
 * Whether Pi can load exactly the resources the user selected (ADR-0044 D02/D06). Declared here as a
 * constant so a read-only projection (the Agent settings page) can answer without starting or
 * measuring the provider: a capability must not become "unsupported" merely because no provider
 * binary happens to be installed in this environment.
 */
export const piPluginSelectionSupport = 'SUPPORTED' as const;

/**
 * Whether Pi can hand a guidance message to a running conversation (ADR-0057). Declared as a constant
 * for the same reason as `piPluginSelectionSupport`: a read-only projection must be able to answer
 * without launching a provider.
 */
export const piGuidanceSupport = 'SUPPORTED' as const;

/**
 * Whether Pi can be frozen and continued at the process level (ADR-0061): declared as a constant for
 * the same reason as `piPluginSelectionSupport`, because a read-only projection must be able to
 * answer without launching a provider. The value is decided by the process-ownership spike recorded
 * in `docs/spikes/pi-0.84.4.md` — never by what this branch would like to use.
 */
export const piProviderProcessSuspension = 'SUPPORTED' as const;

const piCapabilities: AdapterCapabilities = Object.freeze({
  persistentSession: 'SUPPORTED',
  structuredAttention: 'SUPPORTED',
  nativePermissionRouting: 'SUPPORTED',
  pauseWithQuiescence: 'UNSUPPORTED',
  revisionAcknowledgement: 'UNSUPPORTED',
  cooperativeStop: 'REQUIRES_VALIDATION',
  attach: 'STRUCTURED',
  // ADR-0026 measured the whole chain with a real Pi 0.84.4 TUI: the predecessor stops being the
  // writer, the successor TUI reopens the *same* provider session file on a PTY the Runtime owns,
  // and a single writer lease is kept. Declaring it is what lets a reader tell Pi from a provider
  // whose conversation cannot be handed to a terminal at all (Codex, ADR-0029). The residual gaps
  // are narrower and are stated where they belong instead: the Runtime's own
  // `SessionHandoffCapabilities` reports `crossHandoffPermissionModeMatrix: PARTIAL` and
  // `parallelToolBatchSafePoint: UNVERIFIED`.
  nativeTerminalHandoff: 'SUPPORTED',
  // Pi's controlled gate extension reports `tool_start`/`tool_end`/`agent_settled`, which is exactly
  // the fact set a safe point is admitted from (fence acknowledged, no tool running, a settled fact
  // after the fence). Without them the Runtime could only guess from terminal bytes.
  safePointNotification: 'SUPPORTED',
  reconnectToLiveSession: 'UNSUPPORTED',
  resumeAfterExit: 'SUPPORTED',
  // Pi is launched with `--no-extensions` plus only Codeestra's own extensions, so nothing
  // ambient changes the Agent's input for a revision.
  controlledConfiguration: 'SUPPORTED',
  // Pi's launch composes explicit paths under `--no-extensions`/`--no-skills`/`--no-prompt-templates`
  // /`--no-themes`, so the user's selection is exactly what loads (ADR-0044 D02/D06).
  pluginSelection: piPluginSelectionSupport,
  // ADR-0057: Pi's RPC `steer` is a real channel into a *running* conversation. Measured behaviour
  // (ADR-0051): the command answers `success:true` and Pi then reports its own steering queue in a
  // separate `queue_update` record. That is the strongest fact any provider here produces, and it
  // still only says the message is **enqueued** — Pi has no channel that proves the model read it.
  // This is why `sessionGuidance: 'SUPPORTED'` is paired with a delivery state named `DELIVERED`,
  // never `ACKNOWLEDGED`.
  sessionGuidance: piGuidanceSupport,
  // ADR-0061, measured on the real Pi 0.85.1 RPC child with a real model
  // (`docs/spikes/pi-0.84.4.md` §「Provider 进程冻结（ADR-0061）」): the `pi --mode rpc` child is the
  // model-request origin, the bash tool it starts is its own descendant in its own process group, and
  // `SIGSTOP` on the child stops the next model request without touching that tool.
  providerProcessSuspension: piProviderProcessSuspension,
});

export interface PiRpcAdapterOptions {
  /** Executable used to launch Pi. Defaults to `pi` from PATH. */
  readonly piExecutable?: string;
  /** Arguments placed before the Pi argv, e.g. a launcher such as `run <script>`. */
  readonly launcherArgs?: readonly string[];
  readonly gateExtensionPath: string;
  /** Codeestra's own question extension, loaded alongside the gate under `--no-extensions`. */
  readonly questionExtensionPath: string;
  readonly sessionDir: string;
  readonly platform?: 'unix' | 'windows';
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
  readonly client: PiRpcClient;
  readonly providerSessionId: string;
  readonly sessionStorageRef: string;
  readonly processIdentity: unknown;
  readonly permissionMode: 'FULL' | 'STRICT';
  /** Effective configuration this process was launched with; part of the stop evidence. */
  readonly agentConfig: AgentConfiguration;
  /**
   * The plugin selection this process was launched with. It belongs in the evidence hash: two
   * Sessions that loaded different resources are not the same launch, even if the model matches.
   */
  readonly pluginSelection: AgentPluginSelection | null;
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
 * specification would ask the Agent to redo work it already did. The continuation stays bounded
 * and never invents progress the Runtime did not observe.
 */
function composeResumePrompt(revision: AgentStartRequest['revision']): string {
  return [
    `Codeestra: this execution was paused and has now resumed (revision ${revision.id}).`,
    'Continue the task from where you stopped; do not repeat work that is already done.',
  ].join('\n');
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PiRpcProcessError('INVALID_PROVIDER_RESPONSE',
      `Pi get_state did not report a usable ${field}`, true, false);
  }
  return value;
}

/**
 * Provider facts collected while one Pi run is observed. Every field is read straight out of Pi's
 * own RPC records — nothing here decides what the facts mean; the Runtime applies its own
 * deterministic rule (FOUNDATION-056).
 */
interface CompletionFactsAccumulator {
  /** Tool call IDs Pi named, deduplicated so a message seen twice is counted once. */
  readonly toolCallIds: Set<string>;
  /** Tool calls the provider reported without a usable ID; they still prove a tool was used. */
  unnamedToolCalls: number;
  finalAssistantText: string | null;
  finalAssistantTextTruncated: boolean;
  finalAssistantStopReason: string | null;
}

/** Bounded so a hostile or chatty provider cannot force an unbounded database row. */
const maxFinalAssistantTextChars = 2000;

function newCompletionFactsAccumulator(): CompletionFactsAccumulator {
  return { toolCallIds: new Set<string>(), unnamedToolCalls: 0, finalAssistantText: null,
    finalAssistantTextTruncated: false, finalAssistantStopReason: null };
}

function namedId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function noteToolCall(accumulator: CompletionFactsAccumulator, id: string | null): void {
  if (id === null) accumulator.unnamedToolCalls += 1;
  else accumulator.toolCallIds.add(id);
}

/** The assistant's own text blocks, in order; thinking and tool arguments are not assistant prose. */
function assistantProse(message: Record<string, unknown>): string {
  const content = message['content'];
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (typeof block !== 'object' || block === null) continue;
    const entry = block as Record<string, unknown>;
    if (entry['type'] === 'text' && typeof entry['text'] === 'string') parts.push(entry['text']);
  }
  return parts.join('\n');
}

function assistantToolCallIds(message: Record<string, unknown>): readonly (string | null)[] {
  const content = message['content'];
  if (!Array.isArray(content)) return [];
  const ids: (string | null)[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const entry = block as Record<string, unknown>;
    if (entry['type'] !== 'toolCall') continue;
    ids.push(namedId(entry['id']));
  }
  return ids;
}

function collectCompletionFacts(
  accumulator: CompletionFactsAccumulator,
  record: Record<string, unknown>,
): void {
  const type = typeof record['type'] === 'string' ? record['type'] : '';
  if (type === 'tool_execution_start') {
    noteToolCall(accumulator, namedId(record['toolCallId']));
    return;
  }
  if (type !== 'message_end' && type !== 'turn_end') return;
  const message = record['message'];
  if (typeof message !== 'object' || message === null) return;
  const entry = message as Record<string, unknown>;
  // Both the message's own tool-call blocks and a tool result message prove a tool was used. The
  // IDs come from the provider, so the same call observed twice is counted once.
  for (const id of assistantToolCallIds(entry)) noteToolCall(accumulator, id);
  if (entry['role'] === 'toolResult') {
    noteToolCall(accumulator, namedId(entry['toolCallId']));
    return;
  }
  if (entry['role'] !== 'assistant') return;
  const prose = assistantProse(entry);
  // A tool-call-only assistant message is not the run's closing text; keeping the previous text
  // means "the last thing the Agent said to the user".
  if (prose.trim().length === 0) return;
  accumulator.finalAssistantText = prose.length <= maxFinalAssistantTextChars
    ? prose : prose.slice(prose.length - maxFinalAssistantTextChars);
  accumulator.finalAssistantTextTruncated = prose.length > maxFinalAssistantTextChars;
  accumulator.finalAssistantStopReason = typeof entry['stopReason'] === 'string'
    ? entry['stopReason'].slice(0, 64) : null;
}

function completionFactsOf(accumulator: CompletionFactsAccumulator): AgentCompletionFacts {
  return {
    toolCallCount: accumulator.toolCallIds.size + accumulator.unnamedToolCalls,
    finalAssistantText: accumulator.finalAssistantText,
    finalAssistantTextTruncated: accumulator.finalAssistantTextTruncated,
    finalAssistantStopReason: accumulator.finalAssistantStopReason,
  };
}

/**
 * Real Pi adapter. It owns the `pi --mode rpc` child process and its pipes, so it can
 * only observe or answer a Session whose process it still holds; a lost process is
 * reported as disconnected instead of being reattached or replayed.
 */
export class PiRpcAdapter implements AgentAnswerAdapter, AgentProcessRelease {
  readonly id = 'pi';
  readonly #sessions = new Map<string, LiveSession>();
  readonly #unconfirmedStops: number[] = [];
  readonly #options: Required<Pick<PiRpcAdapterOptions,
    'piExecutable' | 'launcherArgs' | 'platform' | 'environment' | 'requestTimeoutMs' | 'stopGraceMs'>>;
  readonly #spawn: NonNullable<PiRpcAdapterOptions['spawn']>;
  readonly #readStartToken: (pid: number) => Promise<string | null>;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  #version: string | null = null;

  constructor(options: PiRpcAdapterOptions) {
    if (!isAbsolute(options.gateExtensionPath) || !isAbsolute(options.questionExtensionPath)
      || !isAbsolute(options.sessionDir)) {
      throw new PiRpcProcessError('PROVIDER_SPAWN_FAILED',
        'Pi gate and question extension paths and the session directory must be absolute', false, false);
    }
    this.gateExtensionPath = options.gateExtensionPath;
    this.questionExtensionPath = options.questionExtensionPath;
    this.sessionDir = options.sessionDir;
    this.#options = {
      piExecutable: options.piExecutable ?? 'pi',
      launcherArgs: options.launcherArgs ?? [],
      platform: options.platform ?? 'unix',
      environment: options.environment ?? {},
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
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
  }

  readonly gateExtensionPath: string;
  readonly questionExtensionPath: string;
  readonly sessionDir: string;
  readonly maxRecordBytes: number | undefined;

  capabilities(): AdapterCapabilities {
    return piCapabilities;
  }

  async probe(): Promise<{ readonly version: string; readonly capabilities: AdapterCapabilities }> {
    if (this.#version !== null) return { version: this.#version, capabilities: piCapabilities };
    const argv = [...this.#options.launcherArgs, '--version'];
    let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
    try {
      child = this.#spawn([this.#options.piExecutable, ...argv], { cwd: this.sessionDir,
        env: this.#options.environment });
    } catch (error) {
      throw new PiRpcProcessError('PROVIDER_VERSION_UNAVAILABLE',
        `Could not launch ${this.#options.piExecutable}: ${error instanceof Error ? error.message : String(error)}`,
        false, false);
    }
    let exitCode: number;
    let stdout: string;
    try {
      [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    } catch (error) {
      throw new PiRpcProcessError('PROVIDER_VERSION_UNAVAILABLE',
        `Could not run ${this.#options.piExecutable} --version: ${error instanceof Error ? error.message : String(error)}`,
        false, false);
    }
    const match = /^(\d+\.\d+\.\d+)/.exec(stdout.trim());
    if (exitCode !== 0 || match === null) {
      throw new PiRpcProcessError('PROVIDER_VERSION_UNAVAILABLE',
        `${this.#options.piExecutable} --version did not report a usable version`, false, false);
    }
    this.#version = match[1] as string;
    return { version: this.#version, capabilities: piCapabilities };
  }

  async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    const agentConfig = request.agentConfig ?? {};
    // Fail-closed before anything is spawned: a selected path that cannot be loaded refuses this
    // Session with the stable code instead of running the Agent with a silently reduced selection
    // (ADR-0044 D02). The Runtime checks the same selection before reserving an Execution; this is
    // the Adapter's own boundary, so no caller can start a provider with an unusable path.
    try {
      assertPiPluginSelectionUsable(request.pluginSelection);
    } catch (error) {
      if (error instanceof PiPluginError) {
        throw new PiRpcProcessError('AGENT_PLUGIN_UNAVAILABLE', error.message, false, false);
      }
      throw error;
    }
    // A resumed conversation file must be one this Runtime's session directory owns; a recorded
    // path is never trusted just because a database column returned it.
    if (request.resume !== undefined) {
      const root = resolve(this.sessionDir);
      const candidate = resolve(request.resume.sessionStorageRef);
      const inside = relative(root, candidate);
      if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) {
        throw new PiRpcProcessError('PROVIDER_SPAWN_FAILED',
          'The resumed session file is not inside the Runtime Pi session directory', false, false);
      }
    }
    // The knowledge this Execution is bound to is verified *before* anything is spawned: a file that
    // does not match its recorded digest refuses the start instead of running the Agent with a
    // silently reduced input set (ADR-0051). Pi then reads the same verified path itself.
    if (request.knowledgeContext !== undefined) {
      try {
        readVerifiedKnowledgeContext(request.knowledgeContext);
      } catch (error) {
        if (error instanceof KnowledgeContextError) {
          throw new PiRpcProcessError(knowledgeContextUnavailableCode, error.message, false, false);
        }
        throw error;
      }
    }
    // The Task's recorded Session Guidance is verified the same way and for the same reason: a file
    // that does not match its recorded digest refuses the start instead of running the Agent without
    // what the user recorded (ADR-0057).
    if (request.guidanceContext !== undefined) {
      try {
        readVerifiedGuidanceContext(request.guidanceContext);
      } catch (error) {
        if (error instanceof GuidanceContextError) {
          throw new PiRpcProcessError(guidanceContextUnavailableCode, error.message, false, false);
        }
        throw error;
      }
    }
    const argv = [
      ...this.#options.launcherArgs,
      ...buildPiRpcArguments({
        gateExtensionPath: this.gateExtensionPath,
        questionExtensionPath: this.questionExtensionPath,
        sessionDir: this.sessionDir,
        platform: this.#options.platform,
        permissionMode: request.permissionMode,
        ...(request.resume === undefined ? {} : { resumeSessionFile: request.resume.sessionStorageRef }),
        ...(request.pluginSelection === undefined ? {} : { pluginSelection: request.pluginSelection }),
      }),
      ...buildPiModelArguments(agentConfig),
      ...buildPiKnowledgeArguments(request.knowledgeContext),
      // Guidance is a second, separate append (ADR-0057): Pi documents
      // `--append-system-prompt` as repeatable, and keeping the two artifacts apart is what makes
      // "the project declared K" and "the user said G" separately checkable rather than merged.
      ...buildPiGuidanceArguments(request.guidanceContext),
    ];
    let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
    try {
      child = this.#spawn([this.#options.piExecutable, ...argv], {
        cwd: request.workspace.cwd,
        env: {
          ...this.#options.environment,
          ...request.environment,
          CODEESTRA_PERMISSION_MODE: request.permissionMode,
        },
      });
    } catch (error) {
      throw new PiRpcProcessError('PROVIDER_SPAWN_FAILED',
        `Could not launch ${this.#options.piExecutable}: ${error instanceof Error ? error.message : String(error)}`,
        false, false);
    }
    const client = new PiRpcClient(child, this.#randomUUID(), {
      ...(this.maxRecordBytes === undefined ? {} : { maxRecordBytes: this.maxRecordBytes }),
      requestTimeoutMs: this.#options.requestTimeoutMs,
    });
    try {
      const state = await client.request({ type: 'get_state' });
      const providerSessionId = requiredString(
        (state as Record<string, unknown> | null)?.['sessionId'], 'sessionId');
      const sessionStorageRef = requiredString(
        (state as Record<string, unknown> | null)?.['sessionFile'], 'sessionFile');
      const startToken = await this.#readStartToken(child.pid);
      if (startToken === null) {
        throw new PiRpcProcessError('PROCESS_IDENTITY_UNAVAILABLE',
          `Could not read a start token for the Pi child process ${child.pid}`, true, false);
      }
      const processIdentity = agentProcessIdentitySchema.parse({
        pid: child.pid,
        executable: this.#options.piExecutable,
        startToken,
        argvHash: createHash('sha256').update(JSON.stringify(argv)).digest('hex'),
        capturedAt: this.#now(),
      });
      // The first user message is what makes the persistent Pi session durable. A resumed
      // Execution reopens the predecessor's conversation and only sends a continuation.
      await client.request({
        type: 'prompt',
        message: request.resume === undefined
          ? composeRevisionPrompt(request.revision)
          : composeResumePrompt(request.revision),
      });
      this.#sessions.set(request.sessionId, {
        client, providerSessionId, sessionStorageRef, processIdentity,
        permissionMode: request.permissionMode, agentConfig,
        pluginSelection: request.pluginSelection ?? null,
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
      const code = error instanceof PiRpcProcessError ? error.code : 'PROVIDER_SPAWN_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      const suffix = cleanup.exited
        ? ` (Pi process ${cleanup.pid} was confirmed stopped)`
        : ` (Pi process ${cleanup.pid} could NOT be confirmed stopped)`;
      throw new PiRpcProcessError(code, `${message}${suffix}`, true, false);
    }
  }

  async *observe(session: AgentSessionRef, cursor?: string): AsyncIterable<AgentObservedEvent> {
    if (session.adapterId !== this.id) {
      throw new PiRpcProcessError('SESSION_IDENTITY_MISMATCH',
        `Pi adapter cannot observe ${session.adapterId}`, true, true);
    }
    const live = this.#sessions.get(session.id);
    if (live === undefined) {
      throw new PiRpcProcessError('LIVE_SESSION_UNAVAILABLE',
        `No live Pi RPC process is held for Session ${session.id}; a lost process is never reattached`,
        true, true);
    }
    if (session.providerSessionId !== undefined && session.providerSessionId !== live.providerSessionId) {
      throw new PiRpcProcessError('SESSION_IDENTITY_MISMATCH',
        'Session provider identity did not match the live Pi process', true, true);
    }
    if (cursor !== undefined && !cursor.startsWith(live.client.cursorPrefix())) {
      throw new PiRpcProcessError('CURSOR_EPOCH_MISMATCH',
        'Observation cursor belongs to a different Pi process epoch', true, true);
    }
    function assistantTurnFailure(record: Record<string, unknown>): string | null | undefined {
  if (record['type'] !== 'message_end' && record['type'] !== 'turn_end') return undefined;
  const message = record['message'];
  if (typeof message !== 'object' || message === null) return undefined;
  const entry = message as Record<string, unknown>;
  if (entry['role'] !== 'assistant') return undefined;
  const stopReason = typeof entry['stopReason'] === 'string' ? entry['stopReason'] : null;
  // A settled run is only a normal finish when its last assistant message ended normally.
  // Anything else (`error`, `aborted`, `length`, or an unknown reason) is reported as a failure
  // with the provider's own bounded text, so a failed model call is never recorded as success.
  if (stopReason === 'stop' || stopReason === 'toolUse') return null;
  const raw = typeof entry['errorMessage'] === 'string' ? entry['errorMessage'] : '';
  const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
  const reason = stopReason ?? 'unknown';
  return detail.length === 0 ? reason : `${reason}: ${detail}`;
}

const evidenceRef = `pi-rpc:agent_settled:session=${live.providerSessionId}`
      + `:epoch=${live.client.epoch}:tools=${createHash('sha256')
        .update([...buildPiRpcArguments({ gateExtensionPath: this.gateExtensionPath,
          questionExtensionPath: this.questionExtensionPath,
          sessionDir: this.sessionDir, platform: this.#options.platform,
          permissionMode: live.permissionMode,
          pluginSelection: live.pluginSelection }), ...buildPiModelArguments(live.agentConfig)].join(' '))
        .digest('hex').slice(0, 16)}`;
    let turnFailure: string | null = null;
    // Provider facts for the completion note. They are counted/collected from Pi's own records and
    // never interpreted here: the Runtime applies its heuristic to them (FOUNDATION-056).
    const facts = newCompletionFactsAccumulator();
    for await (const envelope of live.client.envelopes()) {
      if (envelope.kind === 'disconnected') {
        this.#sessions.delete(session.id);
        yield {
          sessionId: session.id,
          executionId: session.executionId,
          eventId: `pi-disconnect:${envelope.cursor}`,
          cursor: envelope.cursor,
          type: 'disconnected',
          reason: envelope.reason,
        };
        return;
      }
      const failure = assistantTurnFailure(envelope.record);
      if (failure !== undefined) turnFailure = failure;
      collectCompletionFacts(facts, envelope.record);
      const attention = mapPiExtensionUiRequest({
        record: envelope.record,
        sessionId: session.id,
        executionId: session.executionId,
        cursor: envelope.cursor,
      });
      if (attention !== null) {
        yield attention;
        continue;
      }
      if (envelope.record.type === 'agent_settled') {
        this.#sessions.delete(session.id);
        // Pi keeps an idle process alive after settling; Phase 1 never reattaches a live
        // process, so the completion evidence is only emitted after our own stop attempt.
        const stopped = await live.client.stop({ graceMs: this.#options.stopGraceMs });
        if (!stopped.exited) this.#unconfirmedStops.push(stopped.pid);
        yield {
          sessionId: session.id,
          executionId: session.executionId,
          eventId: `pi-settled:${envelope.cursor}`,
          cursor: envelope.cursor,
          type: 'completed',
          // A settled run whose last assistant message ended in an error is a failure: the Agent
          // did not finish the work, so the Runtime must not treat this Execution as successful.
          outcome: turnFailure === null ? 'SUCCESS' : 'FAILURE',
          ...(turnFailure === null
            ? {}
            : { failure: { code: 'PROVIDER_TURN_FAILED', message: turnFailure } }),
          evidence: {
            ref: turnFailure === null ? evidenceRef : `${evidenceRef}:turn=${turnFailure}`,
            toolsQuiescent: true,
            ownedWritersStopped: true,
          },
          facts: completionFactsOf(facts),
        };
        return;
      }
    }
  }

  async answer(session: AgentSessionRef, request: AgentAnswerRequest): Promise<AgentControlReceipt> {
    const live = this.#sessions.get(session.id);
    if (live === undefined || session.adapterId !== this.id) {
      throw new PiRpcProcessError('LIVE_SESSION_UNAVAILABLE',
        `No live Pi RPC process is held for Session ${session.id}; the answer was not written`,
        true, true);
    }
    // Pi has no answer acknowledgement: a successful write means "handed to the transport".
    await live.client.write(piExtensionUiResponseRecord({
      providerRequestId: request.providerRequestId,
      responseType: request.responseType,
      answer: request.answer,
    }));
    return { providerRequestId: request.providerRequestId, accepted: true };
  }

  /**
   * Hands one guidance message to this Adapter's **running** Pi conversation (ADR-0057).
   *
   * Pi's RPC `steer` is the channel: it delivers the message after the current assistant turn's tool
   * calls and before the next model call (measured, ADR-0010 D03 / ADR-0051). Success proves the
   * provider **accepted** the message into its steering queue — the `queue_update` record it then
   * reports is recorded as corroboration when it arrives — and it proves nothing about whether the
   * model read it. That distinction is why the Runtime records this as `DELIVERED` and never as a
   * confirmed revision acknowledgement.
   *
   * The adapter holds the child process, so a Session it no longer holds is refused rather than
   * silently dropped: losing a guidance message must not look like success.
   */
  async guide(request: {
    readonly session: AgentSessionRef;
    readonly executionId: string;
    readonly guidanceId: string;
    readonly message: string;
  }): Promise<{
    readonly accepted: boolean;
    readonly evidenceRef?: string;
    readonly detail?: string;
  }> {
    const live = this.#sessions.get(request.session.id);
    if (live === undefined || request.session.adapterId !== this.id) {
      throw new PiRpcProcessError('LIVE_SESSION_UNAVAILABLE',
        `No live Pi RPC process is held for Session ${request.session.id}; the guidance was not`
        + ' handed to any provider conversation', true, true);
    }
    if (request.session.providerSessionId !== undefined
      && request.session.providerSessionId !== live.providerSessionId) {
      throw new PiRpcProcessError('SESSION_IDENTITY_MISMATCH',
        'Session provider identity did not match the live Pi process', true, true);
    }
    // Register before sending: Pi emits the response and the queue update in that order, but a
    // registration after the write could miss a record that already arrived.
    const queueUpdate = live.client.awaitQueueUpdate(Math.min(this.#options.requestTimeoutMs, 2_000));
    await live.client.request({ type: 'steer', message: request.message });
    const reported = await queueUpdate;
    const steering = reported === null ? null : reported['steering'];
    const queued = Array.isArray(steering)
      ? steering.filter((entry): entry is string => typeof entry === 'string').length
      : null;
    return {
      accepted: true,
      // The evidence names exactly the facts Pi produced: its own acceptance response, and whether it
      // reported the steering queue. "enqueued" is the whole claim — never "the model read it".
      evidenceRef: `pi-rpc:steer:epoch=${live.client.epoch}:session=${live.providerSessionId}`
        + `:queue_update=${reported === null ? 'NOT_OBSERVED' : 'OBSERVED'}`,
      detail: reported === null
        ? `Pi accepted guidance ${request.guidanceId} into its steering queue (steer returned`
          + ' success); it did not report a queue_update within the observation window, so the queue'
          + ' contents were not observed'
        : `Pi accepted guidance ${request.guidanceId} into its steering queue (steer returned`
          + ` success) and reported ${queued ?? 0} pending steering message(s); this is an enqueued`
          + ' fact, not proof that the model read it',
    };
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
}
