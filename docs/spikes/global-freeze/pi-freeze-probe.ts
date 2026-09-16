/**
 * GLC-2 / ADR-0061 process-ownership probe for **Pi** (FOUNDATION-097).
 *
 * It answers exactly three questions with real processes and a real model:
 *
 *  1. Which controlled process originates the model requests? (The `pi --mode rpc` child this script
 *     spawns: the same controlled argv `buildPiRpcArguments` produces for the production Adapter.)
 *  2. Which processes are the tool subprocesses, and does `SIGSTOP` on the main process reach them?
 *  3. After the main process is stopped, is there a next model request? The probe asks the model for
 *     *two sequential bash calls*; the first one sleeps past the freeze, so the second call can only
 *     happen if a new model request is issued after the freeze. The second marker must then be absent
 *     while frozen and appear after `SIGCONT`.
 *
 * Run it as:
 *   bun run docs/spikes/global-freeze/pi-freeze-probe.ts /tmp/ce-glc2/pi-freeze
 *
 * It never touches a user project, a running Runtime or the stable data directory: the working
 * directory and every marker live under the output directory it is given, and the provider session
 * lands in the Runtime-less `PI_CODING_AGENT_DIR` inherited from the caller.
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildPiRpcArguments } from '../../../packages/agent-adapters/src/pi-rpc.js';

const outDir = process.argv[2] ?? '/tmp/ce-glc2/pi-freeze';
const repo = join(outDir, 'repo');
const sessionDir = join(outDir, 'pi-sessions');
const gateExtension = join(process.cwd(), 'packages/agent-adapters/src/pi-gate-extension.ts');
const questionExtension = join(process.cwd(), 'packages/agent-adapters/src/pi-question-extension.ts');
const firstMarker = join(outDir, 'first.marker');
const secondMarker = join(outDir, 'second.marker');

for (const path of [firstMarker, secondMarker]) if (existsSync(path)) rmSync(path);
mkdirSync(repo, { recursive: true });
mkdirSync(sessionDir, { recursive: true });

function log(...parts: unknown[]): void {
  console.log(...parts);
}

/** The process table, as the probe observed it. `ps` output is the evidence, not a summary. */
async function processTable(): Promise<string[]> {
  const child = Bun.spawn(['ps', '-eo', 'pid=,ppid=,pgid=,stat=,command='], {
    stdout: 'pipe', stderr: 'ignore',
  });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0) return [];
  return stdout.split('\n').map((line) => line.trim() === '' ? '' : line);
}

async function psStat(pid: number): Promise<string> {
  const child = Bun.spawn(['ps', '-o', 'stat=', '-p', String(pid)], {
    stdout: 'pipe', stderr: 'ignore',
  });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return code === 0 ? stdout.trim() : '(gone)';
}

async function psStartToken(pid: number): Promise<string | null> {
  const child = Bun.spawn(['ps', '-o', 'lstart=', '-p', String(pid)], {
    stdout: 'pipe', stderr: 'ignore',
  });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const value = stdout.trim();
  return code === 0 && value.length > 0 ? value : null;
}

/** Every descendant of `root`, read from the real process table. */
function descendants(table: readonly string[], root: number): number[] {
  const byParent = new Map<number, number[]>();
  for (const line of table) {
    if (line === '') continue;
    const [pid, ppid] = line.split(/\s+/);
    const parent = Number(ppid);
    const child = Number(pid);
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

const argv = ['pi', ...buildPiRpcArguments({
  gateExtensionPath: gateExtension,
  questionExtensionPath: questionExtension,
  sessionDir,
  platform: 'unix',
  permissionMode: 'FULL',
})];
log('### argv', JSON.stringify(argv));

const child = Bun.spawn(argv, {
  cwd: repo,
  // The same controlled launch the Adapter uses (ADR-0011): FULL means the registered tools run with
  // zero confirmation, and the gate extension loads its side channel but needs nobody listening.
  env: { ...process.env, CODEESTRA_PERMISSION_MODE: 'FULL' },
  stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
});
const providerPid = child.pid;
log('### provider main pid', providerPid);
log('### provider start token (before freeze)', await psStartToken(providerPid));

let rawStdout = '';
void (async () => {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rawStdout += decoder.decode(value, { stream: true });
  }
})();
void (async () => {
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  for (;;) { const { value, done } = await reader.read(); if (done) break;
    process.stderr.write('[provider stderr] ' + decoder.decode(value)); }
})();

const prompt = [
  'You must use the bash tool exactly twice, as two separate tool calls, one after the other.',
  `First bash call: sleep 18 && echo FIRST_DONE > ${firstMarker}`,
  `Second bash call: echo SECOND_DONE > ${secondMarker}`,
  'Do not combine them. Do not use any other tool. After the second call, reply with the single',
  'word DONE and stop.',
].join('\n');
child.stdin.write(`${JSON.stringify({ type: 'prompt', message: prompt })}\n`);
child.stdin.flush();

async function waitFor(predicate: () => boolean, timeoutMs: number, everyMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return predicate();
}

// Wait until the first bash tool is really running: a descendant whose command mentions the marker.
let toolPid: number | null = null;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline && toolPid === null) {
  const table = await processTable();
  for (const pid of descendants(table, providerPid)) {
    const line = table.find((entry) => entry.startsWith(`${pid} `)) ?? '';
    if (line.includes('first.marker')) { toolPid = pid; break; }
  }
  if (toolPid === null) await new Promise((resolve) => setTimeout(resolve, 200));
}
if (toolPid === null) {
  log('### FATAL: the first bash tool never appeared as a descendant of the provider main process');
  log((await processTable()).filter((line) => line.includes(String(providerPid))).join('\n'));
  child.kill('SIGKILL');
  process.exit(1);
}
log('### tool subprocess pid', toolPid);
log('### tool start token', await psStartToken(toolPid));
log('');
log('### process table while the tool runs (provider subtree + tool line)');
const duringTable = await processTable();
for (const line of duringTable) {
  const pid = Number(line.split(/\s+/)[0]);
  if (pid === providerPid || pid === toolPid || descendants(duringTable, providerPid).includes(pid)) {
    log('  ' + line);
  }
}
log('');
log('### provider stat before SIGSTOP', await psStat(providerPid));
log('### tool stat before SIGSTOP', await psStat(toolPid));

// ---------------------------------------------------------------- freeze the main process only
process.kill(providerPid, 'SIGSTOP');
log('### sent SIGSTOP to provider main pid only:', providerPid);
await new Promise((resolve) => setTimeout(resolve, 500));
log('### provider stat after SIGSTOP', await psStat(providerPid));
log('### provider start token after SIGSTOP', await psStartToken(providerPid));
log('### tool stat after SIGSTOP', await psStat(toolPid));
log('### tool start token after SIGSTOP', await psStartToken(toolPid));
const stdoutAtFreeze = rawStdout.length;

// The first tool needs its 18s to finish; then a next model request would have to be issued.
await new Promise((resolve) => setTimeout(resolve, 26_000));
log('');
log('### 26s after the freeze');
log('### provider stat', await psStat(providerPid));
log('### tool stat', await psStat(toolPid));
log('### first marker exists', existsSync(firstMarker));
log('### second marker exists', existsSync(secondMarker));
log('### provider stdout bytes before freeze', stdoutAtFreeze,
  'after freeze', rawStdout.length);
log('### provider stdout records seen after the freeze:',
  rawStdout.slice(stdoutAtFreeze).split('\n').filter((line) => line.trim() !== '').length);
log('### tail of provider stdout after the freeze');
for (const line of rawStdout.slice(stdoutAtFreeze).split('\n').slice(-6)) {
  if (line.trim() !== '') log('  ' + line.slice(0, 300));
}

// ---------------------------------------------------------------- continue and observe recovery
process.kill(providerPid, 'SIGCONT');
log('');
log('### sent SIGCONT to provider main pid only');
await new Promise((resolve) => setTimeout(resolve, 500));
log('### provider stat after SIGCONT', await psStat(providerPid));
const secondAppeared = await waitFor(() => existsSync(secondMarker), 60_000, 500);
log('### second marker exists after SIGCONT', secondAppeared);
log('### both markers', existsSync(firstMarker), existsSync(secondMarker));
log('### provider stdout bytes total', rawStdout.length);

child.kill('SIGTERM');
await new Promise((resolve) => setTimeout(resolve, 1000));
child.kill('SIGKILL');
log('### provider exit', await child.exited.catch(() => 'unknown'));
