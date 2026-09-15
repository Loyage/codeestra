import { isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { AgentAnswer, AgentCompletionFacts, AgentKnowledgeContext } from '@codeestra/contracts';

/**
 * Claude Code protocol surface used by the Adapter: framing, the SDK control channel (permission
 * requests and their answers), the terminal `result` frame, and the launch arguments.
 *
 * The shapes here come from `claude 2.1.268` itself: the command line it accepts (`--help`), the
 * control-protocol documentation embedded in the shipped binary, the binary's own SDK client code
 * (which parses and writes these frames), and local runs of the real CLI
 * (`docs/spikes/claude-2.1.268.md`). Where no channel was measured, this module has no function: it
 * never invents a Claude Code API.
 *
 * Honesty boundary: the wire shapes below were **not** exercised under a real model on this machine
 * (no credentials — `claude auth status` reports `loggedIn: false`), so they are protocol-layer
 * facts, not a verified Agent integration.
 */
export type ClaudeAdapterErrorCode =
  | 'PROVIDER_SPAWN_FAILED'
  | 'PROVIDER_VERSION_UNAVAILABLE'
  | 'PROCESS_IDENTITY_UNAVAILABLE'
  | 'PROCESS_EXITED'
  | 'REQUEST_TIMEOUT'
  | 'COMMAND_REJECTED'
  | 'TRANSPORT_WRITE_FAILED'
  | 'TRANSPORT_STREAM_INVALID'
  | 'LIVE_SESSION_UNAVAILABLE'
  | 'SESSION_IDENTITY_MISMATCH'
  | 'RESUME_SESSION_NOT_OWNED'
  | 'CURSOR_EPOCH_MISMATCH'
  | 'UNKNOWN_PROVIDER_REQUEST'
  | 'UNSUPPORTED_ANSWER'
  | 'UNSUPPORTED_AGENT_CONFIGURATION'
  /** The Execution's materialized knowledge could not be read at its recorded digest (ADR-0051). */
  | 'KNOWLEDGE_CONTEXT_UNAVAILABLE'
  /** The Task's recorded Session Guidance could not be read at its recorded digest (ADR-0057). */
  | 'GUIDANCE_CONTEXT_UNAVAILABLE'
  | 'INVALID_PROVIDER_RESPONSE';

/**
 * `startMayHaveOccurred` / `deliveryMayHaveOccurred` describe the external side effect.
 * `true` always means "unknown or possible", never "confirmed".
 */
export class ClaudeAdapterError extends Error {
  constructor(
    readonly code: ClaudeAdapterErrorCode,
    message: string,
    readonly startMayHaveOccurred = true,
    readonly deliveryMayHaveOccurred = true,
  ) {
    super(message);
    this.name = 'ClaudeAdapterError';
  }
}

export class ClaudeProtocolError extends Error {
  constructor(
    readonly code: 'INVALID_JSON' | 'INVALID_RECORD' | 'RECORD_TOO_LARGE' | 'INVALID_OPTIONS',
    message: string,
  ) {
    super(message);
    this.name = 'ClaudeProtocolError';
  }
}

/**
 * `claude --print --output-format stream-json` writes one JSON object per LF-terminated line. The
 * split is on 0x0A only, so U+2028/U+2029 inside a JSON string stay ordinary content.
 */
export class ClaudeJsonlDecoder {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  #pending = '';
  #recordNumber = 0;

  constructor(readonly maxRecordBytes = 4 * 1024 * 1024) {
    if (!Number.isInteger(maxRecordBytes) || maxRecordBytes <= 0) {
      throw new ClaudeProtocolError('INVALID_OPTIONS', 'maxRecordBytes must be a positive integer');
    }
  }

  push(chunk: Uint8Array): readonly Readonly<Record<string, unknown>>[] {
    let decoded: string;
    try {
      decoded = this.#decoder.decode(chunk, { stream: true });
    } catch (error) {
      throw new ClaudeProtocolError('INVALID_JSON',
        `Claude stdout was not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.#pending += decoded;
    return this.#drain(false);
  }

  finish(): readonly Readonly<Record<string, unknown>>[] {
    try {
      this.#pending += this.#decoder.decode();
    } catch (error) {
      throw new ClaudeProtocolError('INVALID_JSON',
        `Claude stdout ended with invalid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.#drain(true);
  }

  #drain(includeFinalRecord: boolean): readonly Readonly<Record<string, unknown>>[] {
    const records: Readonly<Record<string, unknown>>[] = [];
    while (true) {
      const newline = this.#pending.indexOf('\n');
      if (newline < 0) break;
      let line = this.#pending.slice(0, newline);
      this.#pending = this.#pending.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim().length > 0) records.push(this.#parse(line));
    }
    if (includeFinalRecord && this.#pending.trim().length > 0) {
      const line = this.#pending;
      this.#pending = '';
      records.push(this.#parse(line));
    }
    if (Buffer.byteLength(this.#pending, 'utf8') > this.maxRecordBytes) {
      throw new ClaudeProtocolError('RECORD_TOO_LARGE',
        `Claude record exceeds ${this.maxRecordBytes} bytes`);
    }
    return records;
  }

  #parse(line: string): Readonly<Record<string, unknown>> {
    this.#recordNumber += 1;
    if (Buffer.byteLength(line, 'utf8') > this.maxRecordBytes) {
      throw new ClaudeProtocolError('RECORD_TOO_LARGE',
        `Claude record ${this.#recordNumber} exceeds ${this.maxRecordBytes} bytes`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new ClaudeProtocolError('INVALID_JSON',
        `Invalid Claude JSON record ${this.#recordNumber}:`
        + ` ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ClaudeProtocolError('INVALID_RECORD',
        `Claude record ${this.#recordNumber} must be a JSON object`);
    }
    return value as Readonly<Record<string, unknown>>;
  }
}

export function encodeClaudeRecord(record: Readonly<Record<string, unknown>>): Uint8Array {
  let json: string | undefined;
  try {
    json = JSON.stringify(record);
  } catch (error) {
    throw new ClaudeProtocolError('INVALID_RECORD',
      `Claude record is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (json === undefined) {
    throw new ClaudeProtocolError('INVALID_RECORD', 'Claude record serialized to undefined');
  }
  return new TextEncoder().encode(`${json}\n`);
}

/** Stream frame types the Adapter reacts to, as measured on `claude 2.1.268`. */
export const claudeFrameTypes = Object.freeze({
  controlRequest: 'control_request',
  controlResponse: 'control_response',
  controlCancelRequest: 'control_cancel_request',
  system: 'system',
  result: 'result',
});

/** Control-request subtypes. The Adapter sends `initialize`/`interrupt` and answers `can_use_tool`. */
export const claudeControlSubtypes = Object.freeze({
  initialize: 'initialize',
  interrupt: 'interrupt',
  canUseTool: 'can_use_tool',
});

/**
 * The controlled launch.
 *
 * - `--print` + `--input-format/--output-format stream-json` (+ `--verbose`) is the only channel
 *   that carries the two-way SDK control protocol: permission prompts arrive as
 *   `control_request{can_use_tool}` and are answered with `control_response`. A one-way
 *   `--output-format stream-json` cannot carry an answer, so it could not host a fail-closed gate.
 * - `--safe-mode` excludes ambient user configuration (measured: the user's `SessionStart` hook no
 *   longer runs and the user agent `statusline-setup` is no longer listed) while keeping OAuth
 *   authentication, model selection, built-in tools and permissions, which is what makes
 *   `controlledConfiguration: SUPPORTED` true here. `--bare` was rejected: it disables OAuth and
 *   keychain reads, so it would break the user's own login.
 * - `--strict-mcp-config` keeps ambient MCP servers out of the session.
 * - `--permission-mode` + `--permission-prompts host` are the permission source; see
 *   `claudePermissionPolicy`.
 * - `model` / `provider` are not pinned here beyond what ADR-0012 resolved for this Execution.
 *
 * `--session-id` pins the conversation to a UUID this Runtime chooses, so the provider session
 * file it will write is knowable (`claudeTranscriptPath`) and resumable by identity.
 */
export function buildClaudeArguments(input: {
  readonly permissionMode: 'FULL' | 'STRICT';
  readonly model?: string | undefined;
  readonly thinkingLevel?: string | undefined;
  /** Pins a fresh conversation; mutually exclusive with `resumeSessionId`. */
  readonly sessionId?: string | undefined;
  /** Reopens a recorded conversation; mutually exclusive with `sessionId`. */
  readonly resumeSessionId?: string | undefined;
  /**
   * The materialized Project Knowledge this Execution is bound to (ADR-0051). Claude's own
   * `--append-system-prompt-file` option is the channel: the Adapter verified the file against the
   * recorded digest and passes its absolute path, so the provider reads the knowledge itself and the
   * launch argv stays bounded. Absent means the launch is byte-identical to before this capability.
   */
  readonly knowledgeContext?: AgentKnowledgeContext | undefined;
  /**
   * The verified Session Guidance text this Execution is launched with (ADR-0057).
   *
   * Claude's CLI has both `--append-system-prompt` (literal text) and `--append-system-prompt-file`
   * (a path the provider reads), and knowledge already uses the file variant. Guidance is passed as
   * literal text through the other flag so the two artifacts stay separate — and so the Adapter never
   * depends on either flag being repeatable, which was not measured. Absent means no guidance was
   * recorded for the Task, leaving the launch byte-identical to before this capability.
   */
  readonly guidancePrompt?: string | undefined;
}): readonly string[] {
  const policy = claudePermissionPolicy(input.permissionMode);
  const effort = claudeThinkingEffort(input.thinkingLevel);
  const argv = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    // Ambient user configuration (hooks, skills, plugins, user agents, MCP servers) would change
    // the Agent's input outside the revision snapshot, so the controlled launch excludes it.
    '--safe-mode',
    '--strict-mcp-config',
    // Declared default; passed explicitly so the review of a live process shows where prompts go.
    '--permission-prompts', 'host',
    '--permission-mode', policy.permissionMode,
    ...(policy.dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : []),
  ];
  if (input.model !== undefined && input.model.length > 0) argv.push('--model', input.model);
  if (effort !== null) argv.push('--effort', effort);
  if (input.resumeSessionId !== undefined) {
    argv.push('--resume', input.resumeSessionId);
  } else if (input.sessionId !== undefined) {
    argv.push('--session-id', input.sessionId);
  }
  if (input.knowledgeContext !== undefined) {
    argv.push('--append-system-prompt-file', input.knowledgeContext.filePath);
  }
  if (input.guidancePrompt !== undefined) {
    argv.push('--append-system-prompt', input.guidancePrompt);
  }
  return argv;
}

export interface ClaudePermissionPolicy {
  readonly permissionMode: 'manual' | 'bypassPermissions';
  readonly dangerouslySkipPermissions: boolean;
}

/**
 * FULL keeps the Codeestra default of host-level permission with zero confirmations (ADR-0011):
 * `bypassPermissions` skips every permission check. STRICT is the provider's own `manual` mode —
 * measured to be reported back as `default`, i.e. "prompts for dangerous operations" — and the
 * prompts are routed to the existing Attention face.
 *
 * Honest boundary (same class as Codex's `workspace-write`): `manual` is **not** a per-tool
 * approval for every tool. Tools the provider already treats as safe (reads, in-workspace edits)
 * do not prompt, so "every tool is approved in STRICT" would be false for Claude Code too.
 *
 * Measured locally: `--permission-mode bypassPermissions` is accepted **without**
 * `--dangerously-skip-permissions` and is reported back as `bypassPermissions`. The flag is still
 * passed in FULL because the provider's own documentation says bypassPermissions requires it and
 * the Codeestra semantics for FULL is explicitly "host-level, zero confirmation".
 */
export function claudePermissionPolicy(permissionMode: 'FULL' | 'STRICT'): ClaudePermissionPolicy {
  return permissionMode === 'FULL'
    ? { permissionMode: 'bypassPermissions', dangerouslySkipPermissions: true }
    : { permissionMode: 'manual', dangerouslySkipPermissions: false };
}

/** The permission mode the CLI echoes back on `initialize` for a requested one. */
export function expectedReportedPermissionMode(permissionMode: 'FULL' | 'STRICT'): readonly string[] {
  // `manual` is the CLI's spelling of the provider's `default` mode (measured: `--permission-mode
  // manual` is reported back as `default`). Both spellings are accepted so a version that echoes
  // the requested spelling verbatim does not break the launch.
  return permissionMode === 'FULL' ? ['bypassPermissions'] : ['default', 'manual'];
}

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Every effort level `claude --effort` accepts (measured from `--help` and the model list). */
export const claudeEfforts: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Maps a Codeestra thinking level onto the provider's `--effort`.
 *
 * The two vocabularies only overlap partially: Codeestra also has `off` and `minimal`, which the
 * provider has no equivalent for. Those are refused instead of being silently rounded up or
 * dropped — the Execution records the configuration it asked for, so running a different one would
 * make that record untrue. `null` means "no thinking level was configured".
 */
export function claudeThinkingEffort(thinkingLevel: string | undefined): ClaudeEffort | null {
  if (thinkingLevel === undefined || thinkingLevel.length === 0) return null;
  if ((claudeEfforts as readonly string[]).includes(thinkingLevel)) return thinkingLevel as ClaudeEffort;
  throw new ClaudeAdapterError('UNSUPPORTED_AGENT_CONFIGURATION',
    `claude --effort supports ${claudeEfforts.join(', ')}; got thinking level`
    + ` ${JSON.stringify(thinkingLevel)}`, false, false);
}

/**
 * First-party Claude Code has no provider launch parameter: the model is chosen with `--model` and
 * the API surface with environment variables the Codeestra permission model does not touch. A
 * configured `provider` would therefore change nothing, so it is refused rather than recorded as
 * applied.
 */
export function assertClaudeAcceptsAgentConfiguration(input: {
  readonly provider?: string | undefined;
}): void {
  if (input.provider !== undefined && input.provider.trim().length > 0) {
    throw new ClaudeAdapterError('UNSUPPORTED_AGENT_CONFIGURATION',
      'Claude Code has no provider launch parameter, so a configured provider cannot take effect'
      + ' (use --model, or clear the provider for this Adapter)', false, false);
  }
}

/** `$CLAUDE_CONFIG_DIR` when set, else `~/.claude` (measured: the env var relocates the config home). */
export function defaultClaudeConfigDir(environment: Readonly<Record<string, string | undefined>>): string {
  const configured = environment['CLAUDE_CONFIG_DIR'];
  if (configured !== undefined && configured.trim().length > 0) return resolve(configured);
  return join(homedir(), '.claude');
}

/**
 * The provider's project directory key: measured on `claude 2.1.268`, every character that is not
 * `[A-Za-z0-9]` in the realpath-resolved working directory becomes a single `-` (runs are not
 * collapsed): `/private/tmp/ce-i2-spike/a..b--c__d` → `-private-tmp-ce-i2-spike-a--b--c--d`.
 */
export function claudeProjectKey(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Where the provider will write this conversation's transcript (measured layout). */
export function claudeTranscriptPath(input: {
  readonly configDir: string;
  readonly cwd: string;
  readonly sessionId: string;
}): string {
  return join(resolve(input.configDir), 'projects', claudeProjectKey(input.cwd), `${input.sessionId}.jsonl`);
}

/**
 * A recorded transcript path is only trusted when it is a plain file directly inside this config
 * home's `projects/` directory and is named after the conversation it claims to be. A stored string
 * is never treated as proof that the path belongs to this Runtime.
 *
 * The check does not re-derive the project key from the current working directory on purpose: a
 * Task's worktree can be rebuilt at a different path between Executions, and refusing a resume
 * because the worktree moved would be wrong. What must hold is that the conversation lives in this
 * provider config home and is the recorded conversation.
 */
export function assertOwnedClaudeTranscript(input: {
  readonly configDir: string;
  readonly sessionStorageRef: string;
  readonly providerSessionId: string;
  readonly lstat: (path: string) => { readonly isFile: () => boolean; readonly isSymbolicLink: () => boolean };
  readonly realpath: (path: string) => string;
}): string {
  const root = resolve(input.configDir, 'projects');
  const candidate = isAbsolute(input.sessionStorageRef)
    ? resolve(input.sessionStorageRef)
    : resolve(root, input.sessionStorageRef);
  // The symlink check is on the *recorded* path: realpath would already have resolved it away.
  let stats: { readonly isFile: () => boolean; readonly isSymbolicLink: () => boolean };
  try {
    stats = input.lstat(candidate);
  } catch {
    throw new ClaudeAdapterError('RESUME_SESSION_NOT_OWNED',
      'The recorded Claude session file does not exist, so it cannot be resumed', false, false);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ClaudeAdapterError('RESUME_SESSION_NOT_OWNED',
      'The recorded Claude session path is not a plain file', false, false);
  }
  // Resolving the path as well keeps a symlinked *parent* from smuggling the check outside this
  // config home; the containment test below is done on the real path.
  let realRoot: string;
  let real: string;
  try {
    realRoot = input.realpath(root);
    real = input.realpath(candidate);
  } catch {
    throw new ClaudeAdapterError('RESUME_SESSION_NOT_OWNED',
      'The recorded Claude session file could not be resolved inside this config home', false, false);
  }
  const parent = real.slice(0, real.lastIndexOf(sep));
  const grandparent = parent.slice(0, parent.lastIndexOf(sep));
  if (grandparent !== realRoot) {
    throw new ClaudeAdapterError('RESUME_SESSION_NOT_OWNED',
      'The recorded Claude session file is not directly inside this config home\'s projects directory',
      false, false);
  }
  if (!real.endsWith(`${sep}${input.providerSessionId}.jsonl`)) {
    throw new ClaudeAdapterError('RESUME_SESSION_NOT_OWNED',
      `The recorded Claude session file is not named after conversation ${input.providerSessionId}`,
      false, false);
  }
  return real;
}

/** One `user` turn on the CLI's stdin stream (measured shape). */
export function claudeUserMessage(text: string): Readonly<Record<string, unknown>> {
  return { type: 'user', message: { role: 'user', content: text } };
}

/** Success answer to one control request the CLI sent us. */
export function claudeControlResponse(input: {
  readonly requestId: string;
  readonly result: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> {
  return {
    type: claudeFrameTypes.controlResponse,
    response: { subtype: 'success', request_id: input.requestId, response: input.result },
  };
}

/** Failure answer to one control request the CLI sent us. */
export function claudeControlError(input: {
  readonly requestId: string;
  readonly message: string;
}): Readonly<Record<string, unknown>> {
  return {
    type: claudeFrameTypes.controlResponse,
    response: { subtype: 'error', request_id: input.requestId, error: input.message },
  };
}

/**
 * Asks the CLI to stop the current turn. Measured to exist as a control-request subtype; whether an
 * already started tool is stopped by it was **not** measured (that needs a real model).
 */
export function claudeInterruptRequest(input: {
  readonly requestId: string;
}): Readonly<Record<string, unknown>> {
  return {
    type: claudeFrameTypes.controlRequest,
    request_id: input.requestId,
    request: { subtype: claudeControlSubtypes.interrupt },
  };
}

export interface ClaudeInitFacts {
  readonly sessionId: string;
  readonly model: string | null;
  readonly permissionMode: string | null;
  readonly toolCount: number;
  readonly apiKeySource: string | null;
  readonly claudeCodeVersion: string | null;
}

/** Reads the `system/init` frame, or `null` when the frame is not one. */
export function parseClaudeInit(frame: Readonly<Record<string, unknown>>): ClaudeInitFacts | null {
  if (frame['type'] !== claudeFrameTypes.system || frame['subtype'] !== 'init') return null;
  const sessionId = frame['session_id'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;
  return {
    sessionId,
    model: text(frame['model']),
    permissionMode: text(frame['permissionMode']),
    toolCount: Array.isArray(frame['tools']) ? frame['tools'].length : 0,
    apiKeySource: text(frame['apiKeySource']),
    claudeCodeVersion: text(frame['claude_code_version']),
  };
}

export interface ClaudeResultFacts {
  readonly sessionId: string | null;
  readonly subtype: string;
  readonly isError: boolean;
  readonly terminalReason: string | null;
  readonly numTurns: number | null;
  readonly totalCostUsd: number | null;
  readonly text: string;
}

/** Reads the terminal `result` frame, or `null` when the frame is not one this Adapter can read. */
export function parseClaudeResult(frame: Readonly<Record<string, unknown>>): ClaudeResultFacts | null {
  if (frame['type'] !== claudeFrameTypes.result) return null;
  // A `result` frame with no readable subtype is not a verdict this Adapter will invent one for.
  const rawSubtype = frame['subtype'];
  if (typeof rawSubtype !== 'string' || rawSubtype.length === 0) return null;
  const subtype = rawSubtype;
  return {
    sessionId: typeof frame['session_id'] === 'string' ? frame['session_id'] : null,
    subtype,
    isError: frame['is_error'] === true,
    terminalReason: typeof frame['terminal_reason'] === 'string' ? frame['terminal_reason'] : null,
    numTurns: typeof frame['num_turns'] === 'number' ? frame['num_turns'] : null,
    totalCostUsd: typeof frame['total_cost_usd'] === 'number' ? frame['total_cost_usd'] : null,
    text: boundedText(frame['result'], 300),
  };
}

/**
 * The verdict of a `result` frame.
 *
 * Measured: an authentication failure arrives as `subtype: "success"` **with `is_error: true`**
 * (`terminal_reason: "api_error"`, exit code 1), so a verdict computed from `subtype` alone would
 * record a failed run as `SUCCESS`. All three signals are therefore inspected.
 */
export function claudeResultVerdict(result: ClaudeResultFacts): {
  readonly outcome: 'SUCCESS' | 'FAILURE';
  readonly failure?: { readonly code: string; readonly message: string };
} {
  if (result.subtype === 'success' && !result.isError) return { outcome: 'SUCCESS' };
  const detail = [
    `subtype=${result.subtype}`,
    `is_error=${result.isError}`,
    ...(result.terminalReason === null ? [] : [`terminal_reason=${result.terminalReason}`]),
  ].join(' ');
  return {
    outcome: 'FAILURE',
    failure: {
      code: 'PROVIDER_TURN_FAILED',
      message: `Claude reported ${detail}: ${result.text}`.slice(0, 300),
    },
  };
}

export interface ClaudePermissionRequest {
  readonly toolName: string;
  readonly toolUseId: string | null;
  readonly input: unknown;
  readonly blockedPath: string | null;
  readonly decisionReason: string | null;
  readonly suggestions: readonly unknown[];
  readonly agentId: string | null;
}

/**
 * Reads one `can_use_tool` control request. It is the provider asking its host whether the model
 * may use a tool with a given input; the turn does not proceed until the host answers.
 */
export function parseClaudePermissionRequest(params: unknown): ClaudePermissionRequest | null {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  const record = params as Readonly<Record<string, unknown>>;
  const toolName = record['tool_name'];
  if (typeof toolName !== 'string' || toolName.length === 0) return null;
  const text = (value: unknown, limit: number): string | null =>
    typeof value === 'string' && value.length > 0 ? value.slice(0, limit) : null;
  return {
    toolName,
    toolUseId: text(record['tool_use_id'], 200),
    input: record['input'],
    blockedPath: text(record['blocked_path'], 200),
    decisionReason: text(record['decision_reason'], 200),
    suggestions: Array.isArray(record['permission_suggestions']) ? record['permission_suggestions'] : [],
    agentId: text(record['agent_id'], 200),
  };
}

/**
 * Bounded, displayable description of one permission request. It is what the CLI/UI shows the user
 * before they answer. The tool input is arbitrary JSON (it can carry file contents or a command),
 * so it is serialized, whitespace-collapsed and truncated — never stored or forwarded whole.
 */
export function claudePermissionPrompt(request: ClaudePermissionRequest): Readonly<Record<string, unknown>> {
  let input: string | null = null;
  try {
    const json = JSON.stringify(request.input ?? null);
    if (json !== undefined) input = json.replace(/\s+/g, ' ').trim().slice(0, 500);
  } catch {
    input = null;
  }
  return {
    kind: 'claude.permission',
    version: 1,
    toolName: request.toolName,
    toolUseId: request.toolUseId,
    input,
    blockedPath: request.blockedPath,
    decisionReason: request.decisionReason,
    suggestionCount: request.suggestions.length,
    agentId: request.agentId,
  };
}

/**
 * Encodes one answer to `can_use_tool` in the provider's own shape.
 *
 * `{behavior: "allow"}` without `updatedInput` is what the provider falls back to when no input
 * rewrite is requested (measured in its own SDK client: "updatedInput is missing or empty, falling
 * back to original tool input"). Codeestra never rewrites a tool input behind the user's back, so
 * it never sends one. A cancellation denies **and** interrupts, which is how the provider's own
 * client aborts the turn on a deny-with-interrupt.
 */
export function claudePermissionResult(input: {
  readonly request: ClaudePermissionRequest;
  readonly answer: AgentAnswer;
}): Readonly<Record<string, unknown>> {
  const identity = input.request.toolUseId === null ? {} : { toolUseID: input.request.toolUseId };
  if (input.answer.type === 'CONFIRM') {
    return input.answer.confirmed
      ? { behavior: 'allow', ...identity }
      : { behavior: 'deny', message: 'Denied by the Codeestra user', ...identity };
  }
  if (input.answer.type === 'CANCEL') {
    return {
      behavior: 'deny',
      message: 'Cancelled by the Codeestra user',
      interrupt: true,
      ...identity,
    };
  }
  throw new ClaudeAdapterError('UNSUPPORTED_ANSWER',
    `Claude permission requests accept CONFIRM and CANCEL; received ${input.answer.type}`, false, false);
}

/**
 * Provider facts collected while one Claude run is observed. Every field is read straight out of the
 * frames the CLI writes — nothing here decides what the facts mean; the Runtime applies its own
 * policy to them, and a fact this Adapter cannot observe is reported as unknown rather than guessed.
 */
export interface ClaudeFactAccumulator {
  toolCallCount: number;
  finalAssistantText: string | null;
  truncated: boolean;
  finalAssistantStopReason: string | null;
}

export function newClaudeFactAccumulator(): ClaudeFactAccumulator {
  return { toolCallCount: 0, finalAssistantText: null, truncated: false,
    finalAssistantStopReason: null };
}

const assistantTextLimit = 2000;

/** Reads one frame's worth of facts. Unknown frame shapes are ignored, never guessed at. */
export function collectClaudeCompletionFacts(
  accumulator: ClaudeFactAccumulator,
  frame: Readonly<Record<string, unknown>>,
): void {
  if (frame['type'] !== 'assistant') return;
  const message = frame['message'];
  if (typeof message !== 'object' || message === null) return;
  const content = (message as Readonly<Record<string, unknown>>)['content'];
  if (!Array.isArray(content)) return;
  let text = '';
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Readonly<Record<string, unknown>>;
    if (record['type'] === 'tool_use') accumulator.toolCallCount += 1;
    if (record['type'] === 'text' && typeof record['text'] === 'string') text += record['text'];
  }
  if (text.length > 0) {
    accumulator.finalAssistantText = text.slice(-assistantTextLimit);
    accumulator.truncated = text.length > assistantTextLimit;
  }
  const stopReason = (message as Readonly<Record<string, unknown>>)['stop_reason'];
  if (typeof stopReason === 'string' && stopReason.length > 0) {
    accumulator.finalAssistantStopReason = stopReason.slice(0, 64);
  }
}

export function claudeCompletionFacts(accumulator: ClaudeFactAccumulator): AgentCompletionFacts {
  return {
    toolCallCount: accumulator.toolCallCount,
    finalAssistantText: accumulator.finalAssistantText,
    finalAssistantTextTruncated: accumulator.truncated,
    finalAssistantStopReason: accumulator.finalAssistantStopReason,
  };
}

function boundedText(value: unknown, limit: number): string {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim().slice(0, limit);
  if (value === undefined || value === null) return '';
  try {
    const json = JSON.stringify(value);
    return json === undefined ? '' : json.replace(/\s+/g, ' ').trim().slice(0, limit);
  } catch {
    return '';
  }
}
