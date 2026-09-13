import { describe, expect, test } from 'bun:test';
import codeestraGate, { classifyPiTool } from '../src/pi-gate-extension.js';
import {
  buildPiRpcArguments,
  codeestraPermissionTitlePrefix,
  encodePiExtensionUiResponse,
  encodePiRpcRecord,
  mapPiExtensionUiRequest,
  PiRpcJsonlDecoder,
  piExtensionUiResponseRecord,
} from '../src/pi-rpc.js';

type GateResult = { block: true; reason: string; terminate: true } | undefined;
type GateHandler = (
  event: { toolName: string; toolCallId: string; input: unknown },
  context: { mode: string; hasUI: boolean; ui: { confirm(title: string, message: string): Promise<boolean> } },
) => Promise<GateResult>;

function captureGate(): GateHandler {
  let handler: GateHandler | undefined;
  codeestraGate({ on: (_event, registered) => { handler = registered; } });
  if (handler === undefined) throw new Error('Gate did not register its tool handler');
  return handler;
}

describe('Pi RPC JSONL framing', () => {
  test('handles split UTF-8, CRLF, and Unicode separators without false records', () => {
    const first = JSON.stringify({ type: 'message_update', text: 'a\u2028b😀' });
    const bytes = new TextEncoder().encode(`${first}\n{"type":"agent_settled"}\r\n`);
    const emojiStart = bytes.findIndex((value) => value === 0xf0);
    const decoder = new PiRpcJsonlDecoder();
    expect(decoder.push(bytes.slice(0, emojiStart + 2))).toEqual([]);
    expect(decoder.push(bytes.slice(emojiStart + 2))).toEqual([
      { type: 'message_update', text: 'a\u2028b😀' },
      { type: 'agent_settled' },
    ]);
    expect(decoder.finish()).toEqual([]);
  });

  test('rejects malformed, non-object, and oversized records', () => {
    expect(() => new PiRpcJsonlDecoder().push(new TextEncoder().encode('not-json\n')))
      .toThrow('Invalid Pi RPC JSON record');
    expect(() => new PiRpcJsonlDecoder().push(new TextEncoder().encode('[]\n')))
      .toThrow('must be a JSON object');
    expect(() => new PiRpcJsonlDecoder(4).push(new TextEncoder().encode('{"long":true}')))
      .toThrow('exceeds 4 bytes');
  });

  test('encodes commands and typed extension UI answers with exactly one LF', () => {
    expect(new TextDecoder().decode(encodePiRpcRecord({ id: 'request-1', type: 'get_state' })))
      .toBe('{"id":"request-1","type":"get_state"}\n');
    expect(new TextDecoder().decode(encodePiExtensionUiResponse({
      providerRequestId: 'permission-1', responseType: 'CONFIRM',
      answer: { type: 'CONFIRM', confirmed: false },
    }))).toBe('{"type":"extension_ui_response","id":"permission-1","confirmed":false}\n');
    expect(new TextDecoder().decode(encodePiExtensionUiResponse({
      providerRequestId: 'question-1', responseType: 'VALUE', answer: { type: 'CANCEL' },
    }))).toBe('{"type":"extension_ui_response","id":"question-1","cancelled":true}\n');
    expect(() => encodePiExtensionUiResponse({
      providerRequestId: 'bad', responseType: 'CONFIRM', answer: { type: 'VALUE', value: 'yes' },
    })).toThrow('does not match CONFIRM Pi dialog');
  });
});

describe('Codeestra Pi gate', () => {
  test('full mode allows every tool without a UI channel or serializable input', async () => {
    const previous = process.env.CODEESTRA_PERMISSION_MODE;
    delete process.env.CODEESTRA_PERMISSION_MODE;
    try {
      const handler = captureGate();
      const circular: { self?: unknown } = {};
      circular.self = circular;
      expect(classifyPiTool('custom-danger')).toBe('ALLOW');
      // The question tool changes no file and runs no command: STRICT must never gate it either.
      expect(classifyPiTool('ask_user_question', 'STRICT')).toBe('ALLOW');
      expect(await handler(
        { toolName: 'custom-danger', toolCallId: 'x', input: circular },
        { mode: 'json', hasUI: false, ui: { confirm: async () => false } },
      )).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.CODEESTRA_PERMISSION_MODE;
      else process.env.CODEESTRA_PERMISSION_MODE = previous;
    }
  });

  test('maps a Codeestra questionnaire dialog to one structured Attention', () => {
    const questionnaire = {
      questions: [{ question: 'Which scope?', header: 'Scope', multiSelect: false,
        options: [{ label: 'Global', description: 'everywhere' },
          { label: 'Project', description: 'this project only' }] }],
    };
    const mapped = mapPiExtensionUiRequest({
      sessionId: 'session-1', executionId: 'execution-1', cursor: 'rpc:9',
      record: { type: 'extension_ui_request', id: 'question-1', method: 'select',
        title: `CODEESTRA_QUESTIONNAIRE:v1:${JSON.stringify(questionnaire)}`,
        options: ['Q1 [Scope] Which scope?', '   1. Global — everywhere'] },
    });
    // One dialog, one Attention, with the questionnaire decoded rather than left as raw text.
    expect(mapped).toMatchObject({ type: 'attention', kind: 'QUESTION', responseType: 'VALUE',
      providerRequestId: 'question-1',
      prompt: { kind: 'codeestra.questionnaire', version: 1, questionnaire } });
  });

  test('encodes a structured answer for the provider dialog', () => {
    const record = piExtensionUiResponseRecord({
      providerRequestId: 'question-1', responseType: 'VALUE',
      answer: { type: 'QUESTIONNAIRE', answer: { version: 1, answers: [
        { type: 'CHOICES', questionIndex: 0, choiceIndexes: [1] },
      ] } },
    });
    expect(record['type']).toBe('extension_ui_response');
    expect(record['id']).toBe('question-1');
    expect(JSON.parse(String(record['value']))).toEqual({ version: 1, answers: [
      { type: 'CHOICES', questionIndex: 0, choiceIndexes: [1] }] });
    expect(() => piExtensionUiResponseRecord({
      providerRequestId: 'question-1', responseType: 'CONFIRM',
      answer: { type: 'QUESTIONNAIRE', answer: { version: 1, answers: [
        { type: 'CHOICES', questionIndex: 0, choiceIndexes: [0] }] } },
    })).toThrow('does not match CONFIRM');
  });

  test('strict mode allows read-only tools, prompts once for known mutations, and rejects unknown tools', async () => {
    process.env.CODEESTRA_PERMISSION_MODE = 'STRICT';
    const handler = captureGate();
    let title = '';
    let message = '';
    const context = {
      mode: 'rpc',
      hasUI: true,
      ui: { confirm: async (nextTitle: string, nextMessage: string) => {
        title = nextTitle;
        message = nextMessage;
        return true;
      } },
    };
    expect(classifyPiTool('read', 'STRICT')).toBe('ALLOW');
    expect(await handler({ toolName: 'read', toolCallId: 'read-1', input: { path: 'a' } }, context))
      .toBeUndefined();
    expect(await handler({ toolName: 'write', toolCallId: 'write-1', input: { path: 'a' } }, context))
      .toBeUndefined();
    expect(title.startsWith(`${codeestraPermissionTitlePrefix}:write-1:write:`)).toBe(true);
    expect(message).toContain('"path":"a"');
    expect(await handler({ toolName: 'custom-danger', toolCallId: 'x', input: {} }, context))
      .toMatchObject({ block: true, terminate: true });
  });

  test('strict mode blocks sensitive calls when denied or outside the RPC permission channel', async () => {
    process.env.CODEESTRA_PERMISSION_MODE = 'STRICT';
    const handler = captureGate();
    const denied = await handler(
      { toolName: 'bash', toolCallId: 'bash-1', input: { command: 'true' } },
      { mode: 'rpc', hasUI: true, ui: { confirm: async () => false } },
    );
    expect(denied).toMatchObject({ block: true, reason: 'Codeestra permission denied by user' });
    const unavailable = await handler(
      { toolName: 'edit', toolCallId: 'edit-1', input: {} },
      { mode: 'json', hasUI: false, ui: { confirm: async () => true } },
    );
    expect(unavailable).toMatchObject({ block: true, terminate: true });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(await handler(
      { toolName: 'write', toolCallId: 'write-bad', input: circular },
      { mode: 'rpc', hasUI: true, ui: { confirm: async () => true } },
    )).toMatchObject({ block: true, reason: 'Codeestra rejected non-serializable input for write' });
  });

  test('maps only valid dialog requests to persisted Attention events', () => {
    const record = {
      type: 'extension_ui_request',
      id: 'pi-request-1',
      method: 'confirm',
      title: `${codeestraPermissionTitlePrefix}:call-1:write:fingerprint`,
      message: 'Allow once?',
    };
    expect(mapPiExtensionUiRequest({
      record, sessionId: 'session-1', executionId: 'execution-1', cursor: 'rpc:1',
    })).toMatchObject({
      type: 'attention', kind: 'PERMISSION', responseType: 'CONFIRM',
      providerRequestId: 'pi-request-1', eventId: 'pi-ui:pi-request-1', cursor: 'rpc:1',
    });
    expect(mapPiExtensionUiRequest({
      record: { type: 'agent_settled' },
      sessionId: 'session-1', executionId: 'execution-1', cursor: 'rpc:2',
    })).toBeNull();
    expect(mapPiExtensionUiRequest({
      record: { type: 'extension_ui_request', id: 'notice', method: 'notify' },
      sessionId: 'session-1', executionId: 'execution-1', cursor: 'rpc:3',
    })).toBeNull();
    // An unknown method is not a question this build can answer. Ignoring it keeps a future Pi
    // from ending an Execution that is mid-flight; it must not throw out of the observe loop.
    expect(mapPiExtensionUiRequest({
      record: { type: 'extension_ui_request', id: 'bad', method: 'future-dialog' },
      sessionId: 'session-1', executionId: 'execution-1', cursor: 'rpc:4',
    })).toBeNull();
    // A dialog whose fields do not match this build's schema is still a dialog the provider waits
    // on, so it is surfaced leniently instead of being dropped (which would hang the Agent).
    const lenient = mapPiExtensionUiRequest({
      record: { type: 'extension_ui_request', id: 'lenient', method: 'select', options: 'nope' },
      sessionId: 'session-1', executionId: 'execution-1', cursor: 'rpc:5',
    });
    expect(lenient).toMatchObject({ type: 'attention', kind: 'QUESTION', responseType: 'VALUE',
      providerRequestId: 'lenient', prompt: { method: 'select', options: [] } });
  });

  test('builds a controlled RPC launch without discovered extensions or unknown tools', () => {
    const gate = '/runtime/codeestra-gate.ts';
    const question = '/runtime/codeestra-question.ts';
    expect(buildPiRpcArguments({
      gateExtensionPath: gate,
      questionExtensionPath: question,
      sessionDir: '/runtime/pi-sessions',
      platform: 'unix',
      permissionMode: 'STRICT',
    })).toEqual([
      '--mode', 'rpc', '--no-approve', '--no-extensions', '--extension', gate,
      '--extension', question, '--no-skills', '--no-prompt-templates', '--no-themes',
      '--no-context-files', '--tools', 'read,bash,edit,write,grep,find,ls,ask_user_question',
      '--session-dir', '/runtime/pi-sessions',
    ]);
    expect(buildPiRpcArguments({
      gateExtensionPath: gate,
      questionExtensionPath: question,
      sessionDir: '/runtime/pi-sessions',
      platform: 'unix',
      permissionMode: 'FULL',
    })).toEqual([
      '--mode', 'rpc', '--approve', '--no-extensions', '--extension', gate,
      '--extension', question, '--no-skills', '--no-prompt-templates', '--no-themes',
      '--no-context-files', '--session-dir', '/runtime/pi-sessions',
    ]);
  });
});
