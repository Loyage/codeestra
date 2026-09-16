/**
 * GLC-2 / ADR-0061 process-ownership probe for **Codex** (FOUNDATION-097).
 *
 * Same three questions as the Pi probe, answered against the real `codex app-server --stdio` child the
 * production `CodexAdapter` owns. The JSON-RPC framing here is the adapter's own
 * (`LF-JSONL`/`initialize`/`thread/start`/`turn/start`); only the client is inlined so the probe stays
 * a single file.
 *
 * Run it as:
 *   bun run docs/spikes/global-freeze/codex-freeze-probe.ts /tmp/ce-glc2/codex-freeze
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? '/tmp/ce-glc2/codex-freeze';
const repo = join(outDir, 'repo');
const firstMarker = join(outDir, 'first.marker');
const secondMarker = join(outDir, 'second.marker');
for (const path of [firstMarker, secondMarker]) if (existsSync(path)) rmSync(path);
mkdirSync(repo, { recursive: true });
mkdirSync(join(repo, '.git'), { recursive: true });

function log(...parts: unknown[]): void {
  console.log(...parts);
}

async function processTable(): Promise<string[]> {
  const child = Bun.spawn(['ps', '-eo', 'pid=,ppid=,pgid=,stat=,command='], {
    stdout: 'pipe', stderr: 'ignore',
  });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return code === 0 ? stdout.split('\n').map((line) => line.trim()) : [];
}
async function psStat(pid: number): Promise<string> {
  const child = Bun.spawn(['ps', '-o', 'stat=', '-p', String(pid)],
    { stdout: 'pipe', stderr: 'ignore' });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return code === 0 ? stdout.trim() : '(gone)';
}
async function psStartToken(pid: number): Promise<string | null> {
  const child = Bun.spawn(['ps', '-o', 'lstart=', '-p', String(pid)],
    { stdout: 'pipe', stderr: 'ignore' });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const value = stdout.trim();
  return code === 0 && value.length > 0 ? value : null;
}
function descendants(table: readonly string[], root: number): number[] {
  const byParent = new Map<number, number[]>();
  for (const line of table) {
    if (line === '') continue;
    const [pid, ppid] = line.split(/\s+/);
    const parent = Number(ppid); const child = Number(pid);
    if (!Number.isInteger(parent) || !Number.isInteger(child)) continue;
    byParent.set(parent, [...(byParent.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const walk = (pid: number): void => {
    for (const child of byParent.get(pid) ?? []) { found.push(child); walk(child); }
  };
  walk(root);
  return found;
}

const child = Bun.spawn(['codex', 'app-server', '--stdio'], {
  cwd: repo,
  env: { ...process.env, CODEESTRA_PERMISSION_MODE: 'FULL' },
  stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
});
const providerPid = child.pid;
log('### provider main pid', providerPid, '(codex app-server --stdio)');

let received = 0;
let rawStdout = '';
const pending = new Map<string, (value: unknown) => void>();
void (async () => {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    rawStdout += text;
    buffer += text;
    for (const line of buffer.split('\n').slice(0, -1)) {
      if (line.trim() === '') continue;
      received += 1;
      const record = JSON.parse(line) as { id?: string; method?: string };
      if (record.id !== undefined && pending.has(record.id)) {
        const envelope = record as { result?: unknown; error?: unknown };
        pending.get(record.id)?.(envelope.error ?? envelope.result);
        pending.delete(record.id);
      }
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
  }
})();
void (async () => {
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  for (;;) { const { value, done } = await reader.read(); if (done) break;
    process.stderr.write('[provider stderr] ' + decoder.decode(value)); }
})();

let sequence = 0;
async function request(method: string, params: Record<string, unknown>,
  timeoutMs = 120_000): Promise<unknown> {
  const id = `glc2-${++sequence}`;
  const outcome = new Promise<unknown>((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  child.stdin.flush();
  return await outcome;
}

await request('initialize', { clientInfo: { name: 'codeestra-glc2-spike', version: '0.0.0' } });
log('### initialize ok');
const thread = await request('thread/start', {
  cwd: repo, approvalPolicy: 'never', sandbox: 'danger-full-access',
}) as { thread: { id: string; path: string } };
log('### thread', thread.thread.id, thread.thread.path);
log('### provider start token (before freeze)', await psStartToken(providerPid));

const prompt = [
  'You must use the shell tool exactly twice, as two separate tool calls, one after the other.',
  `First call: sleep 18 && echo FIRST_DONE > ${firstMarker}`,
  `Second call: echo SECOND_DONE > ${secondMarker}`,
  'Do not combine them. Do not use any other tool. After the second call, reply with the single',
  'word DONE and stop.',
].join('\n');
const turn = await request('turn/start', {
  threadId: thread.thread.id, input: [{ type: 'text', text: prompt }],
}) as { turn: { id: string } };
log('### turn', turn.turn.id);

let toolPid: number | null = null;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline && toolPid === null) {
  const table = await processTable();
  for (const pid of descendants(table, providerPid)) {
    const line = table.find((entry) => entry.startsWith(`${pid} `)) ?? '';
    if (line.includes('first.marker') && !line.includes('ps -eo')) { toolPid = pid; break; }
  }
  if (toolPid === null) await new Promise((resolve) => setTimeout(resolve, 200));
}
if (toolPid === null) {
  log('### FATAL: the first shell tool never appeared as a descendant of the app-server');
  log((await processTable()).join('\n'));
  child.kill('SIGKILL');
  process.exit(1);
}
log('### tool subprocess pid', toolPid);
log('### tool start token', await psStartToken(toolPid));
log('');
log('### process table while the tool runs');
const table = await processTable();
const subtree = new Set([providerPid, toolPid, ...descendants(table, providerPid)]);
for (const line of table) {
  if (subtree.has(Number(line.split(/\s+/)[0]))) log('  ' + line);
}
log('');
log('### provider stat before SIGSTOP', await psStat(providerPid));
log('### tool stat before SIGSTOP', await psStat(toolPid));

process.kill(providerPid, 'SIGSTOP');
log('### sent SIGSTOP to provider main pid only:', providerPid);
await new Promise((resolve) => setTimeout(resolve, 500));
log('### provider stat after SIGSTOP', await psStat(providerPid));
log('### provider start token after SIGSTOP', await psStartToken(providerPid));
log('### tool stat after SIGSTOP', await psStat(toolPid));

const recordsAtFreeze = received;
const bytesAtFreeze = rawStdout.length;
await new Promise((resolve) => setTimeout(resolve, 26_000));
log('');
log('### 26s after the freeze');
log('### provider stat', await psStat(providerPid));
log('### tool stat', await psStat(toolPid));
log('### first marker exists', existsSync(firstMarker));
log('### second marker exists', existsSync(secondMarker));
log('### app-server records before freeze', recordsAtFreeze, 'after freeze', received);
log('### app-server bytes before freeze', bytesAtFreeze, 'after freeze', rawStdout.length);

process.kill(providerPid, 'SIGCONT');
log('');
log('### sent SIGCONT to provider main pid only');
await new Promise((resolve) => setTimeout(resolve, 500));
log('### provider stat after SIGCONT', await psStat(providerPid));
let secondAppeared = false;
const contDeadline = Date.now() + 90_000;
while (Date.now() < contDeadline && !secondAppeared) {
  secondAppeared = existsSync(secondMarker);
  if (!secondAppeared) await new Promise((resolve) => setTimeout(resolve, 500));
}
log('### second marker exists after SIGCONT', secondAppeared);
log('### both markers', existsSync(firstMarker), existsSync(secondMarker));
log('### app-server records total', received, 'bytes', rawStdout.length);
child.kill('SIGTERM');
await new Promise((resolve) => setTimeout(resolve, 1000));
child.kill('SIGKILL');
log('### provider exit', await child.exited.catch(() => 'unknown'));
