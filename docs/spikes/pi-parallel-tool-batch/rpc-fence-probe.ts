/**
 * Real-Pi probe: does the production gate extension expose a usable safe point while several tool
 * calls from ONE assistant message run in parallel (ADR-0023/0026 "only hand over at a safe point")?
 *
 * What is real: the `pi` binary, its agent loop and extension runner, the production gate extension
 * (`packages/agent-adapters/src/pi-gate-extension.ts`), real tool execution (`bash`), and the handoff
 * side channel the gate talks to. What is scripted: the *model*, which is a local OpenAI-compatible
 * server that answers the first request with two tool calls in a single assistant message (that is
 * what "parallel tool batch" means) and the second request with plain text.
 *
 * Usage: bun probe.ts [--fence-after-start N] [--fence-delay-ms M]
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** This file lives in <worktree>/docs/spikes/pi-parallel-tool-batch/. */
const worktree = resolve(import.meta.dir, '..', '..', '..');
const gateExtensionPath = join(worktree, 'packages/agent-adapters/src/pi-gate-extension.ts');

const args = Bun.argv.slice(2);
const fenceAfterStart = args.includes('--fence-after-start')
  ? Number(args[args.indexOf('--fence-after-start') + 1]) : 0;
const fenceDelayMs = args.includes('--fence-delay-ms')
  ? Number(args[args.indexOf('--fence-delay-ms') + 1]) : 0;
const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] as 'FULL' | 'STRICT' : 'FULL';
// With `--second-turn-tool` the scripted model asks for ANOTHER tool call in the turn that follows
// the batch, so the probe can show what the fence does to a tool that starts after the safe point.
const secondTurnTool = args.includes('--second-turn-tool');

const root = join(tmpdir(), `ce-m3-parallel-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'sessions'), { recursive: true });
mkdirSync(join(root, 'agent'), { recursive: true });

const started = Date.now();
const record: string[] = [];
function log(fact: string): void {
  const line = `+${String(Date.now() - started).padStart(6)}ms ${fact}`;
  record.push(line);
  console.log(line);
}

// ---------------------------------------------------------------------------------------------
// The scripted model: an OpenAI-compatible streaming endpoint returning one parallel tool batch.
// ---------------------------------------------------------------------------------------------
let modelCalls = 0;
const modelServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    const body = await request.json() as { messages?: readonly { role?: string }[] };
    modelCalls += 1;
    const call = modelCalls;
    const toolMessages = (body.messages ?? []).filter((m) => m.role === 'tool').length;
    log(`model request #${call} (tool messages so far: ${toolMessages})`);

    const chunks: string[] = [];
    const push = (delta: unknown, finish: string | null = null): void => {
      chunks.push(`data: ${JSON.stringify({
        id: `chatcmpl-${call}`, object: 'chat.completion.chunk', created: 1, model: 'scripted-1',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
    };
    push({ role: 'assistant', content: '' });
    if (toolMessages === 0) {
      // ONE assistant message with TWO tool calls: the default parallel tool execution mode.
      push({ tool_calls: [{ index: 0, id: 'call_a', type: 'function',
        function: { name: 'bash', arguments: '' } }] });
      push({ tool_calls: [{ index: 0,
        function: { arguments: JSON.stringify({ command: 'sleep 2; echo PROBE-A-END' }) } }] });
      push({ tool_calls: [{ index: 1, id: 'call_b', type: 'function',
        function: { name: 'bash', arguments: '' } }] });
      push({ tool_calls: [{ index: 1,
        function: { arguments: JSON.stringify({ command: 'sleep 1; echo PROBE-B-END' }) } }] });
      push({}, 'tool_calls');
    } else if (secondTurnTool && toolMessages < 3) {
      push({ tool_calls: [{ index: 0, id: `call_after_${call}`, type: 'function',
        function: { name: 'bash', arguments: '' } }] });
      push({ tool_calls: [{ index: 0,
        function: { arguments: JSON.stringify({ command: 'echo PROBE-SHOULD-NOT-RUN' }) } }] });
      push({}, 'tool_calls');
    } else {
      push({ content: 'PROBE-SETTLED' });
      push({}, 'stop');
    }
    chunks.push('data: [DONE]\n\n');
    return new Response(chunks.join(''), {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  },
});
const modelPort = modelServer.port;

writeFileSync(join(root, 'agent', 'models.json'), JSON.stringify({
  providers: {
    scripted: {
      baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      api: 'openai-completions',
      apiKey: 'scripted-key',
      models: [{ id: 'scripted-1', name: 'Scripted 1', reasoning: false }],
    },
  },
}, null, 2));

// ---------------------------------------------------------------------------------------------
// The Runtime half of the side channel, reduced to what this probe observes.
// ---------------------------------------------------------------------------------------------
const socketPath = join(root, 'session-handoff.sock');
const activeTools = new Map<string, string>();
let fenceSent = false;
let startedTools = 0;
let lastToolEndAt = 0;
const facts: { at: number; fact: string }[] = [];
function fact(text: string): void {
  facts.push({ at: Date.now() - started, fact: text });
  log(text);
}

const channelServer = createServer((socket: Socket) => {
  socket.setEncoding('utf8');
  let buffer = '';
  const send = (frame: unknown): void => { socket.write(`${JSON.stringify(frame)}\n`); };
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (frame['kind'] === 'hello') {
        fact(`side-channel hello mode=${frame['mode']} permissionMode=${frame['permissionMode']}`
          + ` pid=${frame['pid']}`);
        send({ kind: 'welcome', fenceActive: false });
        continue;
      }
      if (frame['kind'] === 'tool_start') {
        startedTools += 1;
        activeTools.set(String(frame['toolCallId']), String(frame['toolName']));
        fact(`tool_start #${startedTools} ${String(frame['toolName'])}`
          + ` id=${String(frame['toolCallId'])} activeTools=${activeTools.size}`);
        if (fenceAfterStart > 0 && startedTools === fenceAfterStart && !fenceSent) {
          fenceSent = true;
          const delay = fenceDelayMs;
          setTimeout(() => {
            fact(`RUNTIME sends fence(active=true) activeTools=${activeTools.size}`);
            send({ kind: 'fence', active: true });
          }, delay);
        }
        continue;
      }
      if (frame['kind'] === 'tool_end') {
        activeTools.delete(String(frame['toolCallId']));
        lastToolEndAt = Date.now() - started;
        fact(`tool_end ${String(frame['toolName'])} id=${String(frame['toolCallId'])}`
          + ` isError=${String(frame['isError'])} activeTools=${activeTools.size}`);
        continue;
      }
      if (frame['kind'] === 'fence_ack') {
        fact(`fence_ack active=${String(frame['active'])} activeTools=${activeTools.size}`);
        continue;
      }
      if (frame['kind'] === 'agent_settled') {
        fact(`agent_settled activeTools=${activeTools.size}`
          + ` (ms after last tool_end: ${lastToolEndAt === 0 ? 'n/a' : (Date.now() - started) - lastToolEndAt})`);
        continue;
      }
      fact(`frame ${JSON.stringify(frame)}`);
    }
  });
  socket.on('error', () => {});
});
await new Promise<void>((resolve) => { channelServer.listen(socketPath, resolve); });

// ---------------------------------------------------------------------------------------------
// The real Pi RPC process with the production gate extension.
// ---------------------------------------------------------------------------------------------
const sessionFile = join(root, 'sessions', 'probe.jsonl');
const pi = Bun.spawn([
  'pi', '--mode', 'rpc',
  mode === 'FULL' ? '--approve' : '--no-approve',
  '--no-extensions', '--extension', gateExtensionPath,
  '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
  '--provider', 'scripted', '--model', 'scripted-1',
  '--session-dir', join(root, 'sessions'), '--session', sessionFile,
], {
  cwd: worktree,
  env: {
    PATH: Bun.env.PATH ?? '',
    HOME: Bun.env.HOME ?? '',
    PI_CODING_AGENT_DIR: join(root, 'agent'),
    CODEESTRA_HANDOFF_SOCKET: socketPath,
    CODEESTRA_PERMISSION_MODE: mode,
    CODEESTRA_HANDOFF_CONNECT_MS: '4000',
  },
  stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
});

const rpcEvents: string[] = [];
let stdoutBuffer = '';
let promptSent = false;
const pump = (async () => {
  for await (const chunk of pi.stdout) {
    stdoutBuffer += new TextDecoder().decode(chunk);
    for (let index = stdoutBuffer.indexOf('\n'); index !== -1;
      index = stdoutBuffer.indexOf('\n')) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      let record2: Record<string, unknown>;
      try { record2 = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const type = String(record2['type'] ?? '');
      if (!['message_start', 'message_update', 'message_end', 'tool_execution_update',
        'context', 'queue_update', 'before_provider_request'].includes(type)) {
        const detail = type === 'tool_execution_end'
          ? ` isError=${String(record2['isError'])} result=${JSON.stringify(record2['result'] ?? null).slice(0, 220)}`
          : (record2['toolName'] === undefined ? '' : ` toolName=${String(record2['toolName'])}`);
        log(`rpc ${type}${detail}`);
      }
      rpcEvents.push(type);
      if (type === 'session_state' || type === 'ready' || type === 'response') {
        if (!promptSent) {
          promptSent = true;
          log('rpc sending prompt');
          pi.stdin.write(`${JSON.stringify({ id: 'p1', type: 'prompt',
            message: 'Run the two bash tool calls in one message.' })}\n`);
          void pi.stdin.flush();
        }
      }
    }
  }
})();
// The RPC server may not print a ready banner; send the prompt unconditionally after a moment.
setTimeout(() => {
  if (!promptSent) {
    promptSent = true;
    log('rpc sending prompt (timer)');
    pi.stdin.write(`${JSON.stringify({ id: 'p1', type: 'prompt',
      message: 'Run the two bash tool calls in one message.' })}\n`);
    void pi.stdin.flush();
  }
}, 1500);

const stderrText = new Response(pi.stderr).text();
const settled = await Promise.race([
  (async () => {
    while (true) {
      if (facts.some((entry) => entry.fact.startsWith('agent_settled'))) return true;
      await Bun.sleep(50);
    }
  })(),
  Bun.sleep(45_000).then(() => false),
]);
log(`observed agent_settled: ${settled}`);
pi.kill('SIGTERM');
await Promise.race([pi.exited, Bun.sleep(3000)]);
void pump;
console.log('--- pi stderr ---');
console.log((await stderrText).slice(-3000));
console.log('--- facts ---');
for (const entry of facts) console.log(`+${String(entry.at).padStart(6)}ms ${entry.fact}`);
console.log(`--- rpc event types seen: ${[...new Set(rpcEvents)].join(', ')}`);
modelServer.stop(true);
channelServer.close();
process.exit(0);
