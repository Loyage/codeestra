import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  decodeQuestionnaireDialogTitle,
  questionnairePromptSchema,
  serializeQuestionnaireAnswer,
} from '@codeestra/contracts';
import type { AgentAnswer, AgentConfiguration, AgentObservedEvent } from '@codeestra/contracts';
import { codeestraAskUserQuestionToolName } from './pi-question-extension.js';

export class PiRpcProtocolError extends Error {
  constructor(
    readonly code: 'INVALID_JSON' | 'INVALID_RECORD' | 'RECORD_TOO_LARGE' | 'INVALID_OPTIONS',
    message: string,
  ) {
    super(message);
    this.name = 'PiRpcProtocolError';
  }
}

/** Pi RPC framing is LF-only. U+2028/U+2029 remain ordinary JSON string content. */
export class PiRpcJsonlDecoder {
  readonly #decoder = new TextDecoder('utf-8', { fatal: true });
  #pending = '';
  #recordNumber = 0;

  constructor(readonly maxRecordBytes = 1024 * 1024) {
    if (!Number.isInteger(maxRecordBytes) || maxRecordBytes <= 0) {
      throw new PiRpcProtocolError('INVALID_OPTIONS', 'maxRecordBytes must be a positive integer');
    }
  }

  push(chunk: Uint8Array): readonly Readonly<Record<string, unknown>>[] {
    let decoded: string;
    try {
      decoded = this.#decoder.decode(chunk, { stream: true });
    } catch (error) {
      throw new PiRpcProtocolError('INVALID_JSON',
        `Pi RPC stdout was not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.#pending += decoded;
    return this.#drain(false);
  }

  finish(): readonly Readonly<Record<string, unknown>>[] {
    try {
      this.#pending += this.#decoder.decode();
    } catch (error) {
      throw new PiRpcProtocolError('INVALID_JSON',
        `Pi RPC stdout ended with invalid UTF-8: ${error instanceof Error ? error.message : String(error)}`);
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
      records.push(this.#parse(line));
    }
    if (includeFinalRecord && this.#pending.length > 0) {
      let line = this.#pending;
      this.#pending = '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      records.push(this.#parse(line));
    }
    if (Buffer.byteLength(this.#pending, 'utf8') > this.maxRecordBytes) {
      throw new PiRpcProtocolError('RECORD_TOO_LARGE',
        `Pi RPC record exceeds ${this.maxRecordBytes} bytes`);
    }
    return records;
  }

  #parse(line: string): Readonly<Record<string, unknown>> {
    this.#recordNumber += 1;
    if (Buffer.byteLength(line, 'utf8') > this.maxRecordBytes) {
      throw new PiRpcProtocolError('RECORD_TOO_LARGE',
        `Pi RPC record ${this.#recordNumber} exceeds ${this.maxRecordBytes} bytes`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new PiRpcProtocolError('INVALID_JSON',
        `Invalid Pi RPC JSON record ${this.#recordNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new PiRpcProtocolError('INVALID_RECORD',
        `Pi RPC record ${this.#recordNumber} must be a JSON object`);
    }
    return value as Readonly<Record<string, unknown>>;
  }
}

export function encodePiRpcRecord(record: Readonly<Record<string, unknown>>): Uint8Array {
  let json: string | undefined;
  try {
    json = JSON.stringify(record);
  } catch (error) {
    throw new PiRpcProtocolError('INVALID_RECORD',
      `Pi RPC command is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (json === undefined) {
    throw new PiRpcProtocolError('INVALID_RECORD', 'Pi RPC command serialized to undefined');
  }
  return new TextEncoder().encode(`${json}\n`);
}

export function encodePiExtensionUiResponse(input: {
  readonly providerRequestId: string;
  readonly responseType: 'CONFIRM' | 'VALUE';
  readonly answer: AgentAnswer;
}): Uint8Array {
  return encodePiRpcRecord(piExtensionUiResponseRecord(input));
}

export function piExtensionUiResponseRecord(input: {
  readonly providerRequestId: string;
  readonly responseType: 'CONFIRM' | 'VALUE';
  readonly answer: AgentAnswer;
}): Readonly<Record<string, unknown>> {
  if (input.answer.type === 'CANCEL') {
    return { type: 'extension_ui_response', id: input.providerRequestId, cancelled: true };
  }
  if (input.responseType === 'CONFIRM' && input.answer.type === 'CONFIRM') {
    return { type: 'extension_ui_response', id: input.providerRequestId, confirmed: input.answer.confirmed };
  }
  if (input.responseType === 'VALUE' && input.answer.type === 'VALUE') {
    return { type: 'extension_ui_response', id: input.providerRequestId, value: input.answer.value };
  }
  // A questionnaire answer is structured on the command face; the provider dialog only accepts a
  // string, so the Adapter — which owns this dialog's wire format — encodes it here.
  if (input.responseType === 'VALUE' && input.answer.type === 'QUESTIONNAIRE') {
    return { type: 'extension_ui_response', id: input.providerRequestId,
      value: serializeQuestionnaireAnswer(input.answer.answer) };
  }
  throw new PiRpcProtocolError('INVALID_RECORD',
    `${input.answer.type} answer does not match ${input.responseType} Pi dialog`);
}

export const codeestraPermissionTitlePrefix = 'CODEESTRA_PERMISSION';

const extensionUiRequestSchema = z.discriminatedUnion('method', [
  z.object({
    type: z.literal('extension_ui_request'), id: z.string().min(1), method: z.literal('select'),
    title: z.string().optional(), options: z.array(z.string()), timeout: z.number().optional(),
  }),
  z.object({
    type: z.literal('extension_ui_request'), id: z.string().min(1), method: z.literal('confirm'),
    title: z.string().optional(), message: z.string().optional(), timeout: z.number().optional(),
  }),
  z.object({
    type: z.literal('extension_ui_request'), id: z.string().min(1), method: z.literal('input'),
    title: z.string().optional(), placeholder: z.string().optional(), timeout: z.number().optional(),
  }),
  z.object({
    type: z.literal('extension_ui_request'), id: z.string().min(1), method: z.literal('editor'),
    title: z.string().optional(), prefill: z.string().optional(), timeout: z.number().optional(),
  }),
]);

/** The Pi extension UI methods that block on a user answer. Everything else is fire-and-forget. */
const piDialogMethods = ['select', 'confirm', 'input', 'editor'] as const;
type PiDialogMethod = (typeof piDialogMethods)[number];

function isPiDialogMethod(method: unknown): method is PiDialogMethod {
  return typeof method === 'string' && (piDialogMethods as readonly string[]).includes(method);
}

/**
 * A dialog request whose fields did not match the expected shape is still a dialog the provider is
 * blocked on, so it is surfaced as a question rather than dropped (dropping would hang the Agent)
 * or thrown (throwing would end the observation stream and fail the Execution). Only the fields a
 * client needs to answer it are kept.
 */
function lenientDialogRequest(
  record: Readonly<Record<string, unknown>>,
  id: string,
  method: PiDialogMethod,
): Readonly<Record<string, unknown>> {
  const request: Record<string, unknown> = { type: 'extension_ui_request', id, method };
  for (const field of ['title', 'message', 'placeholder', 'prefill'] as const) {
    const value = record[field];
    if (typeof value === 'string') request[field] = value;
  }
  const options = record['options'];
  request['options'] = Array.isArray(options)
    ? options.filter((option): option is string => typeof option === 'string')
    : [];
  return request;
}

export function mapPiExtensionUiRequest(input: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly sessionId: string;
  readonly executionId: string;
  readonly cursor: string;
}): AgentObservedEvent | null {
  if (input.record.type !== 'extension_ui_request') return null;
  const method = input.record.method;
  // Fire-and-forget methods, and any method this build does not know, are not questions: a future
  // Pi is free to add them without ending an Execution that is mid-flight.
  if (!isPiDialogMethod(method)) return null;
  const id = input.record.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  const parsed = extensionUiRequestSchema.safeParse(input.record);
  const request = parsed.success ? parsed.data : lenientDialogRequest(input.record, id, method);
  const title = typeof request['title'] === 'string' ? request['title'] : undefined;
  const permission = title?.startsWith(`${codeestraPermissionTitlePrefix}:`) === true;
  const questionnaire = !permission && method === 'select' && title !== undefined
    ? decodeQuestionnaireDialogTitle(title)
    : null;
  return {
    sessionId: input.sessionId,
    executionId: input.executionId,
    eventId: `pi-ui:${id}`,
    cursor: input.cursor,
    type: 'attention',
    providerRequestId: id,
    kind: permission ? 'PERMISSION' : 'QUESTION',
    responseType: method === 'confirm' ? 'CONFIRM' : 'VALUE',
    prompt: questionnaire === null
      ? request
      : questionnairePromptSchema.parse({ kind: 'codeestra.questionnaire', version: 1, questionnaire }),
  };
}

/**
 * Model selection flags for one controlled launch. Only explicitly configured values are passed,
 * so an unset field keeps Pi's own default instead of pinning a value Codeestra guessed.
 */
export function buildPiModelArguments(config?: AgentConfiguration): readonly string[] {
  const arguments_: string[] = [];
  if (config?.provider !== undefined) arguments_.push('--provider', config.provider);
  if (config?.model !== undefined) arguments_.push('--model', config.model);
  if (config?.thinkingLevel !== undefined) arguments_.push('--thinking', config.thinkingLevel);
  return arguments_;
}

/**
 * Controlled launch: no project trust, no discovered extension, no ambient prompt
 * resources. Only the persisted revision and the resolved Agent configuration are injected
 * as Task input, so the same revision plus the same configuration always produces the same
 * start arguments.
 */
export function buildPiRpcArguments(input: {
  readonly gateExtensionPath: string;
  readonly questionExtensionPath: string;
  readonly sessionDir: string;
  readonly platform?: 'unix' | 'windows';
  readonly permissionMode?: 'FULL' | 'STRICT';
}): readonly string[] {
  if (!isAbsolute(input.gateExtensionPath) || !isAbsolute(input.questionExtensionPath)
    || !isAbsolute(input.sessionDir)) {
    throw new PiRpcProtocolError('INVALID_OPTIONS',
      'Pi gate, question extension, and session paths must be absolute');
  }
  const mode = input.permissionMode ?? 'FULL';
  const tools = input.platform === 'windows'
    ? `read,powershell,edit,write,grep,find,ls,${codeestraAskUserQuestionToolName}`
    : `read,bash,edit,write,grep,find,ls,${codeestraAskUserQuestionToolName}`;
  const common = [
    '--mode', 'rpc',
    // Project trust is automatic in full mode. Strict mode retains the former ignore-by-default path.
    mode === 'FULL' ? '--approve' : '--no-approve',
    '--no-extensions',
    '--extension', input.gateExtensionPath,
    // Codeestra owns the question channel too: no ambient user extension decides how the Agent asks.
    '--extension', input.questionExtensionPath,
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
  ];
  // Full mode does not apply a tool allowlist: every tool registered by this controlled launch is active.
  if (mode === 'STRICT') common.push('--tools', tools);
  common.push('--session-dir', input.sessionDir);
  return common;
}
