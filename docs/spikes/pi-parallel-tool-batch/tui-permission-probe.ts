/**
 * Real-Pi probe: the permission-mode matrix *inside a native TUI takeover* (ADR-0011/0023/0026).
 *
 * What is real: the `pi` binary in its native TUI on the production PTY transport
 * (`packages/agent-adapters/src/pi-pty.ts` + `pi-pty-host.ts`, the code this lane just extended for
 * resize), the production gate extension, real tool execution, and the handoff side channel.
 * What is scripted: the model (a local OpenAI-compatible server answering with two tool calls).
 *
 * Usage: bun tui-probe.ts [--mode FULL|STRICT] [--deny N] [--cols 100] [--rows 30]
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// The *production* PTY transport (and, with it, the resize this lane added).
import { PiPtyTerminal, terminalReleaseByte }
  from '../../../packages/agent-adapters/src/pi-pty.ts';

/** This file lives in <worktree>/docs/spikes/pi-parallel-tool-batch/. */
const worktree = resolve(import.meta.dir, '..', '..', '..');
const gateExtensionPath = join(worktree, 'packages/agent-adapters/src/pi-gate-extension.ts');

const args = Bun.argv.slice(2);
const value = (flag: string, fallback: string): string =>
  args.includes(flag) ? String(args[args.indexOf(flag) + 1]) : fallback;
const mode = value('--mode', 'FULL') as 'FULL' | 'STRICT';
const denyIndex = Number(value('--deny', '0'));       // which permission request (1-based) to deny
const cols = Number(value('--cols', '100'));
const rows = Number(value('--rows', '30'));

const root = join(tmpdir(), `ce-m3-tui-perm-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'sessions'), { recursive: true });
mkdirSync(join(root, 'agent'), { recursive: true });
mkdirSync(join(root, 'ws'), { recursive: true });

const started = Date.now();
const facts: string[] = [];
function fact(text: string): void {
  const line = `+${String(Date.now() - started).padStart(6)}ms ${text}`;
  facts.push(line);
  console.log(line);
}

let modelCalls = 0;
const modelServer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const body = await request.json() as { messages?: readonly { role?: string }[] };
    modelCalls += 1;
    const call = modelCalls;
    const toolMessages = (body.messages ?? []).filter((m) => m.role === 'tool').length;
    fact(`model request #${call} (tool results so far: ${toolMessages})`);
    const chunks: string[] = [];
    const push = (delta: unknown, finish: string | null = null): void => {
      chunks.push(`data: ${JSON.stringify({ id: `c-${call}`, object: 'chat.completion.chunk',
        created: 1, model: 'scripted-1',
        choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    };
    push({ role: 'assistant', content: '' });
    if (toolMessages === 0) {
      push({ tool_calls: [{ index: 0, id: 'call_a', type: 'function',
        function: { name: 'bash', arguments: '' } }] });
      push({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({
        command: `echo TUI-TOOL-A-RAN > ${join(root, 'ws', 'a.txt')}; echo TUI-A-END` }) } }] });
      push({ tool_calls: [{ index: 1, id: 'call_b', type: 'function',
        function: { name: 'bash', arguments: '' } }] });
      push({ tool_calls: [{ index: 1, function: { arguments: JSON.stringify({
        command: `echo TUI-TOOL-B-RAN > ${join(root, 'ws', 'b.txt')}; echo TUI-B-END` }) } }] });
      push({}, 'tool_calls');
    } else {
      push({ content: 'TUI-PROBE-SETTLED' });
      push({}, 'stop');
    }
    chunks.push('data: [DONE]\n\n');
    return new Response(chunks.join(''), {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  },
});

writeFileSync(join(root, 'agent', 'models.json'), JSON.stringify({
  providers: { scripted: { baseUrl: `http://127.0.0.1:${modelServer.port}/v1`,
    api: 'openai-completions', apiKey: 'scripted-key',
    models: [{ id: 'scripted-1', name: 'Scripted 1', reasoning: false }] } },
}, null, 2));

// ---------------------------------------------------------------------------------------------
// Side channel: what the Runtime would own. It records facts and answers STRICT requests.
// ---------------------------------------------------------------------------------------------
const socketPath = join(root, 'session-handoff.sock');
let settled = false;
let permissionRequests = 0;
const answers: string[] = [];

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
        fact(`side-channel hello mode=${String(frame['mode'])} hasUI=${String(frame['hasUI'])}`
          + ` permissionMode=${String(frame['permissionMode'])}`);
        send({ kind: 'welcome', fenceActive: false });
        continue;
      }
      if (frame['kind'] === 'tool_start') {
        fact(`tool_start ${String(frame['toolName'])} id=${String(frame['toolCallId'])}`);
        continue;
      }
      if (frame['kind'] === 'tool_end') {
        fact(`tool_end ${String(frame['toolName'])} isError=${String(frame['isError'])}`);
        continue;
      }
      if (frame['kind'] === 'permission_request') {
        permissionRequests += 1;
        const deny = permissionRequests === denyIndex;
        fact(`permission_request #${permissionRequests} tool=${String(frame['toolName'])}`
          + ` input=${String(frame['inputJson'])} piMode=${String(frame['mode'])}`
          + ` → RUNTIME answers ${deny ? 'DENY' : 'ALLOW'}`);
        answers.push(deny ? 'DENY' : 'ALLOW');
        // Answered over the Runtime side channel, not through the terminal dialog.
        send({ kind: 'permission_decision', requestId: String(frame['requestId']),
          decision: deny ? 'DENY' : 'ALLOW', reason: null });
        continue;
      }
      if (frame['kind'] === 'agent_settled') {
        fact('agent_settled');
        settled = true;
        continue;
      }
      if (frame['kind'] === 'session_shutdown') { fact('session_shutdown'); continue; }
      fact(`frame ${JSON.stringify(frame)}`);
    }
  });
  socket.on('error', () => {});
});
await new Promise<void>((resolve) => { channelServer.listen(socketPath, resolve); });

// ---------------------------------------------------------------------------------------------
// Real native TUI on the production PTY transport.
// ---------------------------------------------------------------------------------------------
const sessionFile = join(root, 'sessions', 'tui.jsonl');
const argv = [
  mode === 'FULL' ? '--approve' : '--no-approve',
  '--no-extensions', '--extension', gateExtensionPath,
  '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
];
if (mode === 'STRICT') argv.push('--tools', 'read,bash,edit,write,grep,find,ls,ask_user_question');
argv.push('--session-dir', join(root, 'sessions'), '--session', sessionFile,
  '--provider', 'scripted', '--model', 'scripted-1');

const terminal = await PiPtyTerminal.launch({
  argv: ['pi', ...argv],
  cwd: join(root, 'ws'),
  env: {
    PATH: Bun.env.PATH ?? '', HOME: Bun.env.HOME ?? '',
    PI_CODING_AGENT_DIR: join(root, 'agent'),
    CODEESTRA_HANDOFF_SOCKET: socketPath,
    CODEESTRA_PERMISSION_MODE: mode,
    CODEESTRA_HANDOFF_CONNECT_MS: '4000',
  },
  cols, rows,
});
fact(`TUI launched pid=${terminal.providerPid} slave=${terminal.slavePath}`
  + ` windowSize=${terminal.windowSize}`);
// The resize this lane implemented, on a real TUI: the provider reflows and reads the new size.
const resized = await terminal.resize({ cols: 120, rows: 40 });
fact(`transport resize → ${JSON.stringify(resized)}`);
fact(`terminal size now ${JSON.stringify(terminal.size)}`);

// Let the TUI draw, then type the prompt as a human would.
await Bun.sleep(2500);
const screen = terminal.outputSince(0).data;
fact(`TUI screen contains the editor hint: ${screen.includes('Ask') || screen.includes('>')}`);
terminal.write('Use the bash tool twice in one message. Please go.\r');

const deadline = Date.now() + 60_000;
while (Date.now() < deadline && !settled) await Bun.sleep(100);
fact(`settled observed: ${settled} (permission requests: ${permissionRequests})`);

const { existsSync, readFileSync } = await import('node:fs');
const toolA = existsSync(join(root, 'ws', 'a.txt'));
const toolB = existsSync(join(root, 'ws', 'b.txt'));
fact(`tool A artefact written: ${toolA} (${toolA ? readFileSync(join(root, 'ws', 'a.txt'), 'utf8').trim() : '-'})`);
fact(`tool B artefact written: ${toolB} (${toolB ? readFileSync(join(root, 'ws', 'b.txt'), 'utf8').trim() : '-'})`);
const finalScreen = terminal.outputSince(0).data;
fact(`screen contains TUI-A-END: ${finalScreen.includes('TUI-A-END')}`);
fact(`screen contains TUI-B-END: ${finalScreen.includes('TUI-B-END')}`);
fact(`screen mentions 'Codeestra' + 'permission' wording: ${finalScreen.includes('Codeestra') && finalScreen.includes('permission')} (raw byte presence only — it cannot tell a native dialog from a denial message, and a denied command's text also appears)`);
fact(`session file exists: ${existsSync(sessionFile)}`);

terminal.write(terminalReleaseByte);
const exit = await terminal.waitForExit(15_000);
fact(`release: provider exit ${JSON.stringify(exit)}`);
await terminal.stop({ graceMs: 3000 });
channelServer.close();
modelServer.stop(true);
console.log('--- facts ---');
for (const line of facts) console.log(line);
process.exit(0);
