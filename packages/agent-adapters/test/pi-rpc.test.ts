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
  context: { mode: string; hasUI: boolean },
) => Promise<GateResult>;

/**
 * Captures the gate's `tool_call` handler. The gate now registers lifecycle handlers as well, and
 * it never takes a `ctx.ui` approval: STRICT decisions come from the Runtime side channel, which
 * `handoff-gate.test.ts` drives over a real socket.
 */
function captureGate(): GateHandler {
  let handler: GateHandler | undefined;
  codeestraGate({
    on: (event: string, registered: unknown) => {
      if (event === 'tool_call') handler = registered as GateHandler;
    },
  } as unknown as Parameters<typeof codeestraGate>[0]);
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
      // Full mode never asks anyone: no side channel, no dialog, no Attention.
      expect(await handler(
        { toolName: 'custom-danger', toolCallId: 'x', input: circular },
        { mode: 'json', hasUI: false },
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

  test('strict mode classifies read-only, known mutating, and unknown tools', () => {
    expect(classifyPiTool('read', 'STRICT')).toBe('ALLOW');
    expect(classifyPiTool('grep', 'STRICT')).toBe('ALLOW');
    expect(classifyPiTool('write', 'STRICT')).toBe('REQUIRE_APPROVAL');
    expect(classifyPiTool('bash', 'STRICT')).toBe('REQUIRE_APPROVAL');
    expect(classifyPiTool('custom-danger', 'STRICT')).toBe('REJECT_UNKNOWN');
    // Full mode permits every registered tool, including names Codeestra does not know.
    expect(classifyPiTool('custom-danger', 'FULL')).toBe('ALLOW');
  });

  test('strict mode fails closed when no Runtime permission channel is reachable', async () => {
    const previous = process.env.CODEESTRA_PERMISSION_MODE;
    const previousSocket = process.env.CODEESTRA_HANDOFF_SOCKET;
    const previousConnect = process.env.CODEESTRA_HANDOFF_CONNECT_MS;
    process.env.CODEESTRA_PERMISSION_MODE = 'STRICT';
    // A path nothing listens on: the Runtime side channel is the only approval channel, so a
    // sensitive call must be blocked with a stated reason instead of prompting a terminal dialog.
    process.env.CODEESTRA_HANDOFF_SOCKET = '/nonexistent/codeestra-handoff.sock';
    // The production default keeps re-dialling for 10s (a Runtime may be restarting); this test
    // checks the fail-closed outcome itself, so the window is shortened.
    process.env.CODEESTRA_HANDOFF_CONNECT_MS = '200';
    try {
      const handler = captureGate();
      const blocked = await handler(
        { toolName: 'bash', toolCallId: 'bash-1', input: { command: 'true' } },
        { mode: 'rpc', hasUI: true },
      );
      expect(blocked).toMatchObject({ block: true, terminate: true });
      expect(blocked?.reason).toContain('without its Runtime permission channel');
      const circular: { self?: unknown } = {};
      circular.self = circular;
      expect(await handler(
        { toolName: 'write', toolCallId: 'write-bad', input: circular },
        { mode: 'rpc', hasUI: true },
      )).toMatchObject({ block: true, reason: 'Codeestra rejected non-serializable input for write' });
      expect(await handler(
        { toolName: 'custom-danger', toolCallId: 'x', input: {} },
        { mode: 'rpc', hasUI: true },
      )).toMatchObject({ block: true, terminate: true });
    } finally {
      if (previous === undefined) delete process.env.CODEESTRA_PERMISSION_MODE;
      else process.env.CODEESTRA_PERMISSION_MODE = previous;
      if (previousSocket === undefined) delete process.env.CODEESTRA_HANDOFF_SOCKET;
      else process.env.CODEESTRA_HANDOFF_SOCKET = previousSocket;
      if (previousConnect === undefined) delete process.env.CODEESTRA_HANDOFF_CONNECT_MS;
      else process.env.CODEESTRA_HANDOFF_CONNECT_MS = previousConnect;
    }
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

  test('reopens a specific persistent session file when resuming', () => {
    const gate = '/runtime/codeestra-gate.ts';
    const question = '/runtime/codeestra-question.ts';
    const argv = buildPiRpcArguments({
      gateExtensionPath: gate,
      questionExtensionPath: question,
      sessionDir: '/runtime/pi-sessions',
      platform: 'unix',
      permissionMode: 'FULL',
      resumeSessionFile: '/runtime/pi-sessions/conversation-1.jsonl',
    });
    expect(argv.slice(-2)).toEqual(['--session', '/runtime/pi-sessions/conversation-1.jsonl']);
    expect(argv[argv.indexOf('--session-dir') + 1]).toBe('/runtime/pi-sessions');
    // A relative resume path is refused before any process is launched.
    expect(() => buildPiRpcArguments({
      gateExtensionPath: gate,
      questionExtensionPath: question,
      sessionDir: '/runtime/pi-sessions',
      resumeSessionFile: 'conversation-1.jsonl',
    })).toThrow();
  });
});
