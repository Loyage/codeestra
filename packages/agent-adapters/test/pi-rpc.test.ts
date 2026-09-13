import { describe, expect, test } from 'bun:test';
import codeestraGate, { classifyPiTool } from '../src/pi-gate-extension.js';
import {
  buildPiRpcArguments,
  codeestraPermissionTitlePrefix,
  encodePiExtensionUiResponse,
  encodePiRpcRecord,
  mapPiExtensionUiRequest,
  PiRpcJsonlDecoder,
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
  test('allows read-only tools, prompts once for known mutations, and rejects unknown tools', async () => {
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
    expect(classifyPiTool('read')).toBe('ALLOW');
    expect(await handler({ toolName: 'read', toolCallId: 'read-1', input: { path: 'a' } }, context))
      .toBeUndefined();
    expect(await handler({ toolName: 'write', toolCallId: 'write-1', input: { path: 'a' } }, context))
      .toBeUndefined();
    expect(title.startsWith(`${codeestraPermissionTitlePrefix}:write-1:write:`)).toBe(true);
    expect(message).toContain('"path":"a"');
    expect(await handler({ toolName: 'custom-danger', toolCallId: 'x', input: {} }, context))
      .toMatchObject({ block: true, terminate: true });
  });

  test('blocks sensitive calls when denied or outside the RPC permission channel', async () => {
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
    expect(() => mapPiExtensionUiRequest({
      record: { type: 'extension_ui_request', id: 'bad', method: 'future-dialog' },
      sessionId: 'session-1', executionId: 'execution-1', cursor: 'rpc:4',
    })).toThrow('Invalid Pi extension UI request');
  });

  test('builds a controlled RPC launch without discovered extensions or unknown tools', () => {
    expect(buildPiRpcArguments({
      gateExtensionPath: '/runtime/codeestra-gate.ts',
      sessionDir: '/runtime/pi-sessions',
      platform: 'unix',
    })).toEqual([
      '--mode', 'rpc', '--no-approve', '--no-extensions', '--extension',
      '/runtime/codeestra-gate.ts', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--no-context-files', '--tools', 'read,bash,edit,write,grep,find,ls',
      '--session-dir', '/runtime/pi-sessions',
    ]);
  });
});
