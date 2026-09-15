import { z } from 'zod';
import {
  questionnairePromptSchema,
  questionnaireSchema,
  type AgentAnswer,
  type AgentCompletionFacts,
  type Questionnaire,
} from '@codeestra/contracts';

/**
 * Codex protocol surface used by the Adapter: framing, the two provider payloads we must answer
 * (approval requests and structured questions) and the launch arguments.
 *
 * Everything here was measured against `codex-cli 0.151.0` (`docs/spikes/codex-0.151.0.md`). Where
 * the provider has no channel, this module has no function: it never invents a Codex API.
 */
export type CodexAdapterErrorCode =
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
  /** The Execution's materialized knowledge could not be read at its recorded digest (ADR-0051). */
  | 'KNOWLEDGE_CONTEXT_UNAVAILABLE'
  /** The Task's recorded Session Guidance could not be read at its recorded digest (ADR-0057). */
  | 'GUIDANCE_CONTEXT_UNAVAILABLE'
  | 'INVALID_PROVIDER_RESPONSE';

/**
 * `startMayHaveOccurred` / `deliveryMayHaveOccurred` describe the external side effect.
 * `true` always means "unknown or possible", never "confirmed".
 */
export class CodexAdapterError extends Error {
  constructor(
    readonly code: CodexAdapterErrorCode,
    message: string,
    readonly startMayHaveOccurred = true,
    readonly deliveryMayHaveOccurred = true,
  ) {
    super(message);
    this.name = 'CodexAdapterError';
  }
}

export class CodexProtocolError extends Error {
  constructor(
    readonly code: 'INVALID_JSON' | 'INVALID_RECORD' | 'RECORD_TOO_LARGE' | 'INVALID_OPTIONS',
    message: string,
  ) {
    super(message);
    this.name = 'CodexProtocolError';
  }
}

/**
 * `codex app-server --stdio` speaks one JSON object per LF-terminated line. The split is on 0x0A
 * only, so U+2028/U+2029 inside a JSON string stay ordinary content.
 */
export class CodexJsonlDecoder {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  #pending = '';
  #recordNumber = 0;

  constructor(readonly maxRecordBytes = 1024 * 1024) {
    if (!Number.isInteger(maxRecordBytes) || maxRecordBytes <= 0) {
      throw new CodexProtocolError('INVALID_OPTIONS', 'maxRecordBytes must be a positive integer');
    }
  }

  push(chunk: Uint8Array): readonly Readonly<Record<string, unknown>>[] {
    let decoded: string;
    try {
      decoded = this.#decoder.decode(chunk, { stream: true });
    } catch (error) {
      throw new CodexProtocolError('INVALID_JSON',
        `Codex stdout was not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.#pending += decoded;
    return this.#drain(false);
  }

  finish(): readonly Readonly<Record<string, unknown>>[] {
    try {
      this.#pending += this.#decoder.decode();
    } catch (error) {
      throw new CodexProtocolError('INVALID_JSON',
        `Codex stdout ended with invalid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
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
      throw new CodexProtocolError('RECORD_TOO_LARGE',
        `Codex record exceeds ${this.maxRecordBytes} bytes`);
    }
    return records;
  }

  #parse(line: string): Readonly<Record<string, unknown>> {
    this.#recordNumber += 1;
    if (Buffer.byteLength(line, 'utf8') > this.maxRecordBytes) {
      throw new CodexProtocolError('RECORD_TOO_LARGE',
        `Codex record ${this.#recordNumber} exceeds ${this.maxRecordBytes} bytes`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new CodexProtocolError('INVALID_JSON',
        `Invalid Codex JSON record ${this.#recordNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new CodexProtocolError('INVALID_RECORD',
        `Codex record ${this.#recordNumber} must be a JSON object`);
    }
    return value as Readonly<Record<string, unknown>>;
  }
}

export function encodeCodexRecord(record: Readonly<Record<string, unknown>>): Uint8Array {
  let json: string | undefined;
  try {
    json = JSON.stringify(record);
  } catch (error) {
    throw new CodexProtocolError('INVALID_RECORD',
      `Codex record is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (json === undefined) {
    throw new CodexProtocolError('INVALID_RECORD', 'Codex record serialized to undefined');
  }
  return new TextEncoder().encode(`${json}\n`);
}

/** Locally measured app-server method names that the Adapter answers or reacts to. */
export const codexMethods = Object.freeze({
  commandApproval: 'item/commandExecution/requestApproval',
  fileChangeApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  legacyExecApproval: 'execCommandApproval',
  legacyPatchApproval: 'applyPatchApproval',
  userInput: 'item/tool/requestUserInput',
  turnCompleted: 'turn/completed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
});

/**
 * The controlled launch. `model`/`provider` are not here: they are resolved per Execution and sent
 * in `thread/start`, so a configuration change applies to the next Session without a Runtime
 * restart (ADR-0012). Reasoning effort is a config override because that is the documented
 * app-server input for it.
 *
 * `app-server` has no `--ignore-user-config` (measured), so the ambient `$CODEX_HOME` config,
 * plugins, MCP servers and hooks always participate. The Adapter reports that honestly as
 * `controlledConfiguration: UNSUPPORTED` instead of pretending the launch is isolated.
 */
export function buildCodexAppServerArguments(input: {
  readonly thinkingLevel?: string;
  readonly enableRequestUserInput?: boolean;
}): readonly string[] {
  const argv = ['app-server', '--stdio'];
  if (input.thinkingLevel !== undefined && input.thinkingLevel.length > 0) {
    argv.push('-c', `model_reasoning_effort=${input.thinkingLevel}`);
  }
  if (input.enableRequestUserInput === true) {
    // Measured: without this feature flag the model cannot call `request_user_input` at all.
    argv.push('--enable', 'default_mode_request_user_input');
  }
  return argv;
}

export interface CodexPermissionPolicy {
  readonly approvalPolicy: 'never' | 'untrusted';
  readonly sandbox: 'danger-full-access' | 'workspace-write';
}

/**
 * FULL keeps the Codeestra default of host-level permission with zero confirmations; STRICT routes
 * every model-generated command through the approval channel, which is what makes a fail-closed
 * gate possible. Both values were measured against 0.151.0.
 */
export function codexPermissionPolicy(permissionMode: 'FULL' | 'STRICT'): CodexPermissionPolicy {
  return permissionMode === 'FULL'
    ? { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    : { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
}

const threadIdentitySchema = z.looseObject({
  id: z.string().min(1),
  path: z.string().min(1),
});
const threadIdentityResultSchema = z.looseObject({ thread: threadIdentitySchema });
const turnStartResultSchema = z.looseObject({
  turn: z.looseObject({ id: z.string().min(1) }),
});
const turnErrorSchema = z.looseObject({ message: z.string().min(1) });
const turnCompletedParamsSchema = z.looseObject({
  threadId: z.string().min(1),
  turn: z.looseObject({
    id: z.string().min(1),
    status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
    error: turnErrorSchema.nullish(),
  }),
});

export interface CodexThreadIdentity {
  readonly providerSessionId: string;
  readonly sessionStorageRef: string;
}

/** Parses the two fields Codeestra persists from a `thread/start` or `thread/resume` result. */
export function parseCodexThreadIdentity(method: string, result: unknown): CodexThreadIdentity {
  const parsed = threadIdentityResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new CodexAdapterError('INVALID_PROVIDER_RESPONSE',
      `${method} did not report a usable thread id and rollout path`);
  }
  return {
    providerSessionId: parsed.data.thread.id,
    sessionStorageRef: parsed.data.thread.path,
  };
}

export function parseCodexTurnId(result: unknown): string {
  const parsed = turnStartResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new CodexAdapterError('INVALID_PROVIDER_RESPONSE', 'turn/start did not report a turn id');
  }
  return parsed.data.turn.id;
}

export type CodexTurnCompletion =
  | { readonly status: 'completed' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'interrupted' };

/**
 * Only `completed` and `failed` are turn outcomes the provider stands behind. `interrupted` means
 * the turn stopped while a tool may still be running (measured), so the caller must not emit a
 * completion with "tools are quiescent" evidence for it.
 */
export function parseCodexTurnCompletion(params: unknown): CodexTurnCompletion | null {
  const parsed = turnCompletedParamsSchema.safeParse(params);
  if (!parsed.success) return null;
  if (parsed.data.turn.status === 'completed') return { status: 'completed' };
  if (parsed.data.turn.status === 'failed') {
    return { status: 'failed', message: parsed.data.turn.error?.message ?? 'Codex reported a failed turn' };
  }
  if (parsed.data.turn.status === 'interrupted') return { status: 'interrupted' };
  return null;
}

const commandApprovalParamsSchema = z.looseObject({
  itemId: z.string().min(1),
  kind: z.string().optional(),
  command: z.string().optional(),
  cwd: z.string().optional(),
  reason: z.string().nullish(),
  availableDecisions: z.array(z.unknown()).optional(),
});
const fileChangeApprovalParamsSchema = z.looseObject({
  itemId: z.string().min(1),
  reason: z.string().nullish(),
  grantRoot: z.string().nullish(),
});
const permissionsApprovalParamsSchema = z.looseObject({
  itemId: z.string().min(1),
  reason: z.string().nullish(),
});

/** The three approval request kinds the Adapter can carry to an Attention. */
export function codexApprovalKind(method: string): 'command' | 'fileChange' | 'permissions' | null {
  if (method === codexMethods.commandApproval || method === codexMethods.legacyExecApproval) {
    return 'command';
  }
  if (method === codexMethods.fileChangeApproval || method === codexMethods.legacyPatchApproval) {
    return 'fileChange';
  }
  if (method === codexMethods.permissionsApproval) return 'permissions';
  return null;
}

/**
 * Bounded, displayable description of one approval request. It is what the CLI/UI shows the user
 * before they answer, so it keeps the command text but nothing unbounded.
 */
export function codexApprovalPrompt(input: {
  readonly kind: 'command' | 'fileChange' | 'permissions';
  readonly params: Readonly<Record<string, unknown>>;
}): Readonly<Record<string, unknown>> {
  const bounded = (value: unknown, limit = 500): string | null =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : null;
  if (input.kind === 'command') {
    const parsed = commandApprovalParamsSchema.safeParse(input.params);
    return {
      kind: 'codex.permission',
      version: 1,
      approvalKind: 'command',
      itemId: parsed.success ? parsed.data.itemId : null,
      command: parsed.success ? bounded(parsed.data.command) : null,
      cwd: parsed.success ? bounded(parsed.data.cwd, 200) : null,
      reason: parsed.success ? bounded(parsed.data.reason, 200) : null,
    };
  }
  if (input.kind === 'fileChange') {
    const parsed = fileChangeApprovalParamsSchema.safeParse(input.params);
    return {
      kind: 'codex.permission',
      version: 1,
      approvalKind: 'fileChange',
      itemId: parsed.success ? parsed.data.itemId : null,
      reason: parsed.success ? bounded(parsed.data.reason, 200) : null,
      grantRoot: parsed.success ? bounded(parsed.data.grantRoot, 200) : null,
    };
  }
  const parsed = permissionsApprovalParamsSchema.safeParse(input.params);
  return {
    kind: 'codex.permission',
    version: 1,
    approvalKind: 'permissions',
    itemId: parsed.success ? parsed.data.itemId : null,
    reason: parsed.success ? bounded(parsed.data.reason, 200) : null,
  };
}

const codexQuestionSchema = z.looseObject({
  id: z.string().min(1),
  header: z.string().min(1),
  question: z.string().min(1),
  isOther: z.boolean().optional(),
  options: z.array(z.looseObject({
    label: z.string().min(1),
    description: z.string().nullish(),
  })).nullish(),
});
const codexUserInputParamsSchema = z.looseObject({
  itemId: z.string().min(1),
  questions: z.array(codexQuestionSchema).min(1),
  isBlocking: z.boolean().optional(),
});

export interface CodexUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly isOther: boolean;
  readonly options: readonly { readonly label: string; readonly description: string | null }[];
}

export interface CodexUserInputRequest {
  readonly itemId: string;
  readonly questions: readonly CodexUserInputQuestion[];
}

/** Normalizes `item/tool/requestUserInput` params, or `null` when the payload is unusable. */
export function parseCodexUserInput(params: unknown): CodexUserInputRequest | null {
  const parsed = codexUserInputParamsSchema.safeParse(params);
  if (!parsed.success) return null;
  return {
    itemId: parsed.data.itemId,
    questions: parsed.data.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      isOther: question.isOther === true,
      options: (question.options ?? []).map((option) => ({
        label: option.label,
        description: option.description ?? null,
      })),
    })),
  };
}

const questionnaireHeaderLimit = 16;

/**
 * Maps a Codex question set onto the Codeestra questionnaire contract when it actually fits
 * (1–4 questions, 2–4 written-out options each, non-empty descriptions). Anything else returns
 * `null` and the caller degrades to a plain question Attention instead of shipping a payload that
 * would be rejected at answer time.
 */
export function codexQuestionnairePrompt(
  request: CodexUserInputRequest,
): { readonly prompt: unknown; readonly questionnaire: Questionnaire } | null {
  if (request.questions.length > 4) return null;
  const questions = [];
  for (const question of request.questions) {
    if (question.question.length > 500) return null;
    if (question.options.length < 2 || question.options.length > 4) return null;
    const options = [];
    for (const option of question.options) {
      if (option.label.length === 0 || option.label.length > 60) return null;
      if (option.description === null || option.description.length === 0
        || option.description.length > 300) return null;
      options.push({ label: option.label, description: option.description });
    }
    questions.push({
      question: question.question,
      // The header is a chip in the CLI/UI; our contract caps it at 16 characters.
      header: question.header.slice(0, questionnaireHeaderLimit),
      multiSelect: false,
      options,
    });
  }
  const questionnaire = questionnaireSchema.safeParse({ questions });
  if (!questionnaire.success) return null;
  return {
    prompt: questionnairePromptSchema.parse({ kind: 'codeestra.questionnaire', version: 1,
      questionnaire: questionnaire.data }),
    questionnaire: questionnaire.data,
  };
}

/** Fallback prompt for a Codex question set that does not fit the questionnaire contract. */
export function codexPlainQuestionPrompt(request: CodexUserInputRequest): Readonly<Record<string, unknown>> {
  return {
    kind: 'codex.question',
    version: 1,
    itemId: request.itemId,
    questions: request.questions.map((question) => ({
      id: question.id,
      header: question.header.slice(0, 120),
      question: question.question.slice(0, 500),
      isOther: question.isOther,
      options: question.options.map((option) => option.label.slice(0, 60)),
    })),
  };
}

/**
 * Codex expects `{ decision }` for an approval. `accept`/`decline`/`cancel` were all measured;
 * `acceptForSession` and execpolicy amendments are deliberately not offered, because Codeestra's
 * gate is one answer per request and must not silently widen future permissions.
 */
export function codexApprovalDecision(answer: AgentAnswer): 'accept' | 'decline' | 'cancel' {
  if (answer.type === 'CONFIRM') return answer.confirmed ? 'accept' : 'decline';
  if (answer.type === 'CANCEL') return 'cancel';
  throw new CodexAdapterError('UNSUPPORTED_ANSWER',
    `Codex approvals accept CONFIRM, CANCEL; received ${answer.type}`, false, false);
}

/**
 * Encodes one answer to `item/tool/requestUserInput` in the provider's own shape. A VALUE answer is
 * only accepted for a single-question request: with several questions a single string would have to
 * be attributed to one of them, and guessing is exactly what the structured contract forbids.
 */
export function encodeCodexUserInputResult(input: {
  readonly request: CodexUserInputRequest;
  readonly answer: AgentAnswer;
  readonly questionnaire?: Questionnaire | undefined;
}): { readonly answers: Readonly<Record<string, { readonly answers: readonly string[] }>> } {
  const { request, answer } = input;
  if (answer.type === 'CANCEL') {
    // No verified Codex encoding for "the user cancelled this question set".
    throw new CodexAdapterError('UNSUPPORTED_ANSWER',
      'Codex structured questions have no verified cancel encoding; decline the run instead',
      false, false);
  }
  if (answer.type === 'CONFIRM') {
    throw new CodexAdapterError('UNSUPPORTED_ANSWER',
      'Codex structured questions are not approvals', false, false);
  }
  if (answer.type === 'VALUE') {
    const question = request.questions[0];
    if (question === undefined || request.questions.length !== 1) {
      throw new CodexAdapterError('UNSUPPORTED_ANSWER',
        'A free-text answer is only accepted for a single Codex question', false, false);
    }
    return { answers: { [question.id]: { answers: [answer.value] } } };
  }
  const questionnaire = input.questionnaire;
  if (questionnaire === undefined || questionnaire.questions.length !== request.questions.length) {
    throw new CodexAdapterError('UNSUPPORTED_ANSWER',
      'The questionnaire does not match the Codex question set it answers', false, false);
  }
  const answers: Record<string, { readonly answers: readonly string[] }> = {};
  for (const entry of answer.answer.answers) {
    const question = request.questions[entry.questionIndex];
    const asked = questionnaire.questions[entry.questionIndex];
    if (question === undefined || asked === undefined) {
      throw new CodexAdapterError('UNSUPPORTED_ANSWER',
        `Question ${entry.questionIndex + 1} was not asked by Codex`, false, false);
    }
    if (entry.type === 'TEXT') {
      answers[question.id] = { answers: [entry.text] };
      continue;
    }
    const labels: string[] = [];
    for (const choice of entry.choiceIndexes) {
      const option = question.options[choice];
      if (option === undefined) {
        throw new CodexAdapterError('UNSUPPORTED_ANSWER',
          `Question ${entry.questionIndex + 1} has no option ${choice + 1}`, false, false);
      }
      labels.push(option.label);
    }
    answers[question.id] = { answers: labels };
  }
  const unanswered = request.questions.filter((question) => answers[question.id] === undefined);
  for (const question of unanswered) {
    // Unanswered questions are reported back to the Agent as unanswered rather than declined.
    answers[question.id] = { answers: [] };
  }
  return { answers };
}

// ---------------------------------------------------------------------------------------------
// Completion facts (ADR-0043 / FOUNDATION-056 semantics, implemented for Codex)
// ---------------------------------------------------------------------------------------------

/**
 * Codex item types that are a **tool invocation**. The list is deliberately the narrow one: an item
 * this Adapter does not recognize is not counted as a tool call (see the accumulator's doc comment),
 * and neither are Codex's own bookkeeping items (`reasoning`, `plan`, `userMessage`, `hookPrompt`,
 * compaction, review-mode markers). Measured against `codex-cli 0.154.0`
 * (`codex app-server generate-json-schema`, `ThreadItem`).
 */
const codexToolItemTypes: ReadonlySet<string> = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageGeneration',
]);

/**
 * Provider facts collected while one Codex turn is observed. Every field is read straight out of
 * Codex's own item notifications; nothing here decides what the facts mean — the Runtime applies its
 * own deterministic rule (FOUNDATION-056).
 *
 * A miss is preferred over a false statement:
 *
 * - `toolCallCount` only counts item types Codex itself names as a tool call, deduplicated by the
 *   provider's item id. An unrecognized item type therefore never becomes "a tool call", and an item
 *   observed in both `item/started` and `item/completed` is counted once.
 * - only a **completed** `agentMessage` item contributes `finalAssistantText`: a half-streamed delta
 *   is not "the last thing the Agent said".
 * - `finalAssistantStopReason` is never filled in: Codex reports no per-message stop reason, and the
 *   turn's outcome is already carried by the completion itself. Deriving one from the turn status
 *   would describe a different fact than the field means (compared with Pi, ADR-0043).
 */
export interface CodexFactAccumulator {
  readonly toolItemIds: Set<string>;
  /** Tool items the provider reported without a usable id; they still prove a tool was used. */
  unnamedToolItems: number;
  finalAssistantText: string | null;
  finalAssistantTextTruncated: boolean;
}

/** Bounded so a hostile or chatty provider cannot force an unbounded database row. */
const codexAssistantTextLimit = 2000;

export function newCodexFactAccumulator(): CodexFactAccumulator {
  return { toolItemIds: new Set<string>(), unnamedToolItems: 0,
    finalAssistantText: null, finalAssistantTextTruncated: false };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null
    ? value as Readonly<Record<string, unknown>> : null;
}

function codexItemId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** One provider notification's worth of facts. Unknown shapes are ignored, never guessed at. */
export function collectCodexCompletionFacts(
  accumulator: CodexFactAccumulator,
  frame: { readonly method: string | undefined; readonly params: unknown },
): void {
  if (frame.method !== codexMethods.itemStarted && frame.method !== codexMethods.itemCompleted) return;
  const item = asRecord(asRecord(frame.params)?.['item']);
  if (item === null) return;
  const type = typeof item['type'] === 'string' ? item['type'] : '';
  if (codexToolItemTypes.has(type)) {
    const id = codexItemId(item['id']);
    if (id === null) accumulator.unnamedToolItems += 1;
    else accumulator.toolItemIds.add(id);
    return;
  }
  if (type !== 'agentMessage') return;
  // Only the completed item carries the message's authoritative text; a delta is a fragment.
  if (frame.method !== codexMethods.itemCompleted) return;
  const text = typeof item['text'] === 'string' ? item['text'] : '';
  if (text.trim().length === 0) return;
  accumulator.finalAssistantText = text.length <= codexAssistantTextLimit
    ? text : text.slice(text.length - codexAssistantTextLimit);
  accumulator.finalAssistantTextTruncated = text.length > codexAssistantTextLimit;
}

export function codexCompletionFacts(accumulator: CodexFactAccumulator): AgentCompletionFacts {
  return {
    toolCallCount: accumulator.toolItemIds.size + accumulator.unnamedToolItems,
    finalAssistantText: accumulator.finalAssistantText,
    finalAssistantTextTruncated: accumulator.finalAssistantTextTruncated,
    // Codex reports no per-message stop reason; an absent fact is reported as absent.
    finalAssistantStopReason: null,
  };
}
