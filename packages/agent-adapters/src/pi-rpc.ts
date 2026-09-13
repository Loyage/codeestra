import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { AgentAnswer, AgentObservedEvent } from '@codeestra/contracts';

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

export function mapPiExtensionUiRequest(input: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly sessionId: string;
  readonly executionId: string;
  readonly cursor: string;
}): AgentObservedEvent | null {
  if (input.record.type !== 'extension_ui_request') return null;
  if (typeof input.record.method === 'string'
    && ['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(input.record.method)) {
    return null;
  }
  const parsed = extensionUiRequestSchema.safeParse(input.record);
  if (!parsed.success) {
    throw new PiRpcProtocolError('INVALID_RECORD', `Invalid Pi extension UI request: ${parsed.error.message}`);
  }
  const request = parsed.data;
  const permission = request.title?.startsWith(`${codeestraPermissionTitlePrefix}:`) === true;
  return {
    sessionId: input.sessionId,
    executionId: input.executionId,
    eventId: `pi-ui:${request.id}`,
    cursor: input.cursor,
    type: 'attention',
    providerRequestId: request.id,
    kind: permission ? 'PERMISSION' : 'QUESTION',
    responseType: request.method === 'confirm' ? 'CONFIRM' : 'VALUE',
    prompt: request,
  };
}

/**
 * Controlled launch: no project trust, no discovered extension, no ambient prompt
 * resources. Only the persisted revision is injected as Task input, so the same
 * revision always produces the same start arguments.
 */
export function buildPiRpcArguments(input: {
  readonly gateExtensionPath: string;
  readonly sessionDir: string;
  readonly platform?: 'unix' | 'windows';
  readonly permissionMode?: 'FULL' | 'STRICT';
}): readonly string[] {
  if (!isAbsolute(input.gateExtensionPath) || !isAbsolute(input.sessionDir)) {
    throw new PiRpcProtocolError('INVALID_OPTIONS', 'Pi gate and session paths must be absolute');
  }
  const mode = input.permissionMode ?? 'FULL';
  const tools = input.platform === 'windows'
    ? 'read,powershell,edit,write,grep,find,ls'
    : 'read,bash,edit,write,grep,find,ls';
  const common = [
    '--mode', 'rpc',
    // Project trust is automatic in full mode. Strict mode retains the former ignore-by-default path.
    mode === 'FULL' ? '--approve' : '--no-approve',
    '--no-extensions',
    '--extension', input.gateExtensionPath,
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
