import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCompletionFacts, AgentStartRequest } from '@codeestra/contracts';
import { PiRpcAdapter } from '../src/pi-adapter.js';

const gateExtensionPath = fileURLToPath(new URL('../src/pi-gate-extension.ts', import.meta.url));
const questionExtensionPath = fileURLToPath(new URL('../src/pi-question-extension.ts', import.meta.url));

/**
 * A protocol stub, not a real provider. It replays Pi's own RPC record shapes so the Adapter's
 * fact collection can be checked against the documented format; it is never evidence that a real
 * Agent behaves this way.
 */
const stubSource = `
import { join } from 'node:path';

const mode = Bun.env.CODEESTRA_STUB_MODE ?? 'PROSE_QUESTION';
if (Bun.argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line);
    if (record.type === 'get_state') {
      emit({ id: record.id, type: 'response', command: 'get_state', success: true, data: {
        sessionId: 'facts-session-1', sessionFile: join(process.cwd(), 'session.jsonl'),
        messageCount: 0 } });
    } else if (record.type === 'prompt') {
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      if (mode === 'PROSE_QUESTION') {
        emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop',
          content: [{ type: 'text', text: 'Which package manager should I use?' }] } });
      } else if (mode === 'TOOL_THEN_QUESTION') {
        // The same tool call is named by three records; the Adapter must count it once.
        emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'write', args: {} });
        emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse',
          content: [{ type: 'text', text: 'Writing the file now.' },
            { type: 'toolCall', id: 'call-1', name: 'write', arguments: {} }] } });
        emit({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'call-1',
          toolName: 'write', isError: false, content: [{ type: 'text', text: 'written' }] } });
        emit({ type: 'turn_end', message: { role: 'assistant', stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: {} }] },
          toolResults: [{ toolCallId: 'call-1' }] });
        emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop',
          content: [{ type: 'text', text: 'Wrote the file. Want me to update the README?' }] } });
      } else if (mode === 'LONG_TEXT') {
        emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop',
          content: [{ type: 'text', text: 'x'.repeat(2500) + ' Is that right?' }] } });
      } else if (mode === 'NO_TEXT') {
        emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'call-9', name: 'write', arguments: {} }] } });
      }
      emit({ type: 'agent_settled' });
    }
  }
}
`;

type StubMode = 'PROSE_QUESTION' | 'TOOL_THEN_QUESTION' | 'LONG_TEXT' | 'NO_TEXT';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-pi-facts-'));
  directories.push(directory);
  return directory;
}

async function observedFacts(mode: StubMode): Promise<AgentCompletionFacts> {
  const root = temporaryDirectory();
  const stubPath = join(root, 'stub-pi.ts');
  const sessionDir = join(root, 'pi-sessions');
  const workspace = join(root, 'workspace');
  Bun.spawnSync(['mkdir', '-p', sessionDir, workspace]);
  await Bun.write(stubPath, stubSource);
  const adapter = new PiRpcAdapter({
    piExecutable: process.execPath,
    launcherArgs: [stubPath],
    gateExtensionPath,
    questionExtensionPath,
    sessionDir,
    environment: { CODEESTRA_STUB_MODE: mode },
    requestTimeoutMs: 5_000,
    stopGraceMs: 2_000,
  });
  const request: AgentStartRequest = {
    operationId: '10000000-0000-4000-8000-000000000001',
    sessionId: 'session-under-test',
    executionId: '20000000-0000-4000-8000-000000000002',
    workspace: { id: '30000000-0000-4000-8000-000000000003', cwd: workspace, ownershipToken: 'owner' },
    revision: { id: '40000000-0000-4000-8000-000000000004',
      displayTitle: 'Implement the owned worktree change',
      specification: 'Implement the owned worktree change' },
    knowledgeSnapshotRefs: [],
    permissionMode: 'FULL',
    environment: {},
  };
  const ref = await adapter.start(request);
  const events = [];
  for await (const event of adapter.observe(ref)) events.push(event);
  expect(events).toHaveLength(1);
  const completion = events[0];
  if (completion?.type !== 'completed') throw new Error('The stub did not produce a completion');
  expect(completion.facts).toBeDefined();
  return completion.facts as AgentCompletionFacts;
}

describe('Pi completion facts', () => {
  test('reports no tool call and the closing question of a run that used no tool', async () => {
    expect(await observedFacts('PROSE_QUESTION')).toEqual({
      toolCallCount: 0,
      finalAssistantText: 'Which package manager should I use?',
      finalAssistantTextTruncated: false,
      finalAssistantStopReason: 'stop',
    });
  });

  test('counts a tool call once however many provider records name it', async () => {
    const facts = await observedFacts('TOOL_THEN_QUESTION');
    // Three records name `call-1` (start, assistant message, tool result) and `turn_end` repeats
    // the message; the fact is one tool call, because the provider's own ID identifies it.
    expect(facts.toolCallCount).toBe(1);
    // The closing text is the last thing the Agent said, not the tool-call prefixed message.
    expect(facts.finalAssistantText).toBe('Wrote the file. Want me to update the README?');
    expect(facts.finalAssistantStopReason).toBe('stop');
  });

  test('bounds a long final text to its tail and says that it did', async () => {
    const facts = await observedFacts('LONG_TEXT');
    expect(facts.finalAssistantTextTruncated).toBe(true);
    expect(facts.finalAssistantText?.length).toBe(2000);
    expect(facts.finalAssistantText?.endsWith(' Is that right?')).toBe(true);
  });

  test('reports no final text when the run never produced assistant prose', async () => {
    const facts = await observedFacts('NO_TEXT');
    expect(facts.finalAssistantText).toBeNull();
    expect(facts.toolCallCount).toBe(1);
  });
});
