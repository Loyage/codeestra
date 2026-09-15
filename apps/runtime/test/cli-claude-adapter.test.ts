import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';
import { provisionDevClone } from './support/agent-fixture.js';

/**
 * CLI/command-face acceptance for the Claude Code adapter (ADR-0040).
 *
 * The provider is a protocol stub. It proves the Runtime's command face, the permission routing and
 * the failure paths; it is **not** evidence of a real Claude Code integration — the real evidence
 * (and its limits: no model credentials on this machine) lives in `docs/spikes/claude-2.1.268.md`.
 */
const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => { await reclaimTestResources(); });

function temporaryDirectory(prefix: string): string {
  // macOS resolves /var to /private/var; provider processes report resolved paths.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  // FOUNDATION-057: the shared runner refuses a non-temporary CODEESTRA_HOME (a test must never
  // reach the real Runtime home) and registers the home so teardown stops any Runtime it started.
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Claude Adapter Test',
      GIT_AUTHOR_EMAIL: 'claude-adapter@example.invalid', GIT_COMMITTER_NAME: 'Claude Adapter Test',
      GIT_COMMITTER_EMAIL: 'claude-adapter@example.invalid' } });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

interface ClaudeStubReport {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly userMessages: readonly string[];
  readonly controlRequests: readonly { readonly subtype: string | null }[];
  readonly controlResponses: readonly { readonly subtype: string | null;
    readonly result: unknown; readonly error: string | null }[];
}

/**
 * A protocol stub for `claude --print --input-format stream-json`. It answers `initialize`, writes
 * the `system/init` frame, then behaves per `CODEESTRA_CLAUDE_CLI_STUB_MODE`: it either asks for
 * permission for one `Bash` call and settles after the answer, or settles immediately. It also
 * writes the transcript file the real CLI would write, so the resume path can be exercised.
 */
const claudeStubSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('2.1.268 (Claude Code)\\n');
  process.exit(0);
}
const flag = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] ?? null : null; };
const mode = process.env.CODEESTRA_CLAUDE_CLI_STUB_MODE ?? 'APPROVAL';
const reportPath = process.env.CODEESTRA_CLAUDE_CLI_STUB_REPORT;
const configDir = process.env.CLAUDE_CONFIG_DIR ?? '';
const sessionId = flag('--session-id') ?? flag('--resume') ?? 'cli-stub-session';
const requestedMode = flag('--permission-mode') ?? 'manual';
const echoMode = requestedMode === 'bypassPermissions' ? 'bypassPermissions' : 'default';
const received = { argv, cwd: process.cwd(), userMessages: [], controlRequests: [], controlResponses: [] };
const save = () => {
  if (!reportPath) return;
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(received, null, 2));
};
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
const writeTranscript = () => {
  if (!configDir) return;
  const key = process.cwd().replace(/[^A-Za-z0-9]/g, '-');
  const path = configDir + '/projects/' + key + '/' + sessionId + '.jsonl';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: 'user', message: { role: 'user', content: 'earlier' } }) + '\\n');
};
save();

const beginTurn = () => {
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: sessionId,
    tools: ['Bash', 'Read', 'Write'], mcp_servers: [], model: 'claude-opus-5[1m]',
    permissionMode: echoMode, apiKeySource: 'none', claude_code_version: '2.1.268' });
  if (mode === 'CANCEL') {
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, num_turns: 1,
      terminal_reason: 'completed', total_cost_usd: 0, result: 'nothing to do' });
    return;
  }
  emit({ type: 'control_request', request_id: 'cli-approval-1', request: {
    subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'toolu-cli-1',
    input: { command: '/bin/sh -lc "echo cli-stub"' },
    permission_suggestions: [], blocked_path: null, decision_reason: 'command needs approval' } });
};

const handle = (frame) => {
  if (frame.type === 'control_request') {
    received.controlRequests.push({ subtype: frame.request?.subtype ?? null });
    save();
    if (frame.request?.subtype === 'initialize') {
      emit({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
        response: { commands: [], agents: [], output_style: 'default',
          current_permission_mode: echoMode, models: [] } } });
    }
    return;
  }
  if (frame.type === 'user') {
    const content = frame.message?.content;
    received.userMessages.push(typeof content === 'string' ? content : JSON.stringify(content));
    save();
    writeTranscript();
    beginTurn();
    return;
  }
  if (frame.type === 'control_response') {
    received.controlResponses.push({ subtype: frame.response?.subtype ?? null,
      result: frame.response?.response ?? null, error: frame.response?.error ?? null });
    save();
    if (frame.response?.subtype === 'error') return;
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, num_turns: 1,
      terminal_reason: 'completed', total_cost_usd: 0, result: 'done' });
  }
};

let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    handle(JSON.parse(line));
  }
}
`;

/** Minimal Pi protocol stub, used only as the second adapter in the replacement test. */
const piStubSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const sessionDir = argv[argv.indexOf('--session-dir') + 1] ?? process.cwd();
mkdirSync(sessionDir, { recursive: true });
const sessionFile = join(sessionDir, 'pi-cli-session.jsonl');
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
        sessionId: 'pi-cli-session', sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'pi-cli-session',
        timestamp: '2026-09-14T09:00:00.000Z', cwd: process.cwd() }) + '\\n');
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'pi did it' }], stopReason: 'stop' } });
      emit({ type: 'agent_settled' });
    }
  }
}
`;

interface Fixture {
  readonly environment: Record<string, string>;
  readonly repository: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly claudeReportPath: string;
  readonly configDir: string;
}

async function fixture(options: { readonly strict?: boolean; readonly mode?: string;
  readonly claudeExecutable?: 'stub' | 'missing' } = {}): Promise<Fixture> {
  const repository = temporaryDirectory('codeestra-claude-cli-repo-');
  const home = temporaryDirectory('codeestra-claude-cli-home-');
  const configDir = temporaryDirectory('codeestra-claude-cli-provider-');
  const tools = temporaryDirectory('codeestra-claude-cli-tools-');
  const assets = temporaryDirectory('codeestra-claude-cli-assets-');
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  await git(repository, ['branch', 'dev']);
  // ADR-0056: every dev fact comes from a second clone of the same origin that sits on
  // `dev`; the project is trusted with it explicitly.
  const devRepo = await provisionDevClone({ repository: repository });

  const claudeStubPath = join(tools, 'claude-stub.ts');
  await Bun.write(claudeStubPath, claudeStubSource);
  const claudeShim = join(tools, 'claude');
  await Bun.write(claudeShim, `#!/bin/sh\nexec "${process.execPath}" "${claudeStubPath}" "$@"\n`);
  chmodSync(claudeShim, 0o755);
  const piStubPath = join(tools, 'pi-stub.ts');
  await Bun.write(piStubPath, piStubSource);
  const piShim = join(tools, 'pi');
  await Bun.write(piShim, `#!/bin/sh\nexec "${process.execPath}" "${piStubPath}" "$@"\n`);
  chmodSync(piShim, 0o755);

  const claudeReportPath = join(tools, 'claude-report.json');
  const environment = {
    CODEESTRA_HOME: home,
    CODEESTRA_UI_DIST: assets,
    CODEESTRA_PI_EXECUTABLE: piShim,
    CODEESTRA_CLAUDE_EXECUTABLE: options.claudeExecutable === 'missing'
      ? join(tools, 'definitely-missing-claude')
      : claudeShim,
    // The provider's own config home, which the Adapter also treats as the conversation root.
    CLAUDE_CONFIG_DIR: configDir,
    CODEESTRA_CLAUDE_CLI_STUB_REPORT: claudeReportPath,
    CODEESTRA_CLAUDE_CLI_STUB_MODE: options.mode ?? 'APPROVAL',
  };
  if (options.strict === true) {
    // STRICT is a live Runtime switch; the project trust then needs the explicit confirmation flag.
    expect((await cli(['permission', 'set', 'strict'], environment)).exitCode).toBe(0);
  }
  const opened = await cli(['open', repository, '--dev-repo', devRepo, '--no-open',
    ...(options.strict === true ? ['--yes'] : [])], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  const projectId = projects[0]?.id as string;
  const created = JSON.parse((await cli(['task', 'create', projectId, 'Write a file'],
    environment)).stdout) as { readonly id: string };
  expect((await cli(['task', 'submit', projectId, created.id, '0'], environment)).exitCode).toBe(0);
  return { environment, repository, projectId, taskId: created.id, claudeReportPath, configDir };
}

interface TaskStatus {
  readonly task: { readonly id: string; readonly state: string; readonly version: number };
  readonly taskState: string;
  readonly executions: readonly { readonly adapterId?: string; readonly state: string;
    readonly session: { readonly state: string; readonly providerSessionId?: string | null;
      readonly sessionStorageRef?: string | null } | null }[];
}

async function status(environment: Record<string, string>,
  projectId: string, taskId: string): Promise<TaskStatus> {
  const listed = await cli(['task', 'status', projectId, taskId], environment);
  expect(listed.exitCode).toBe(0);
  return JSON.parse(listed.stdout) as TaskStatus;
}

async function waitForSessionExit(environment: Record<string, string>,
  projectId: string, taskId: string, timeoutMs = 30_000): Promise<TaskStatus> {
  const deadline = Date.now() + timeoutMs;
  let current = await status(environment, projectId, taskId);
  while (Date.now() < deadline) {
    if (current.executions.some((execution) => execution.session?.state === 'EXITED')) return current;
    await Bun.sleep(100);
    current = await status(environment, projectId, taskId);
  }
  throw new Error(`The Claude Session never exited; last status was ${JSON.stringify(current.task)}`);
}

async function waitForAttention(environment: Record<string, string>, projectId: string): Promise<{
  readonly id: string; readonly kind: string; readonly responseType: string;
  readonly prompt: Readonly<Record<string, unknown>>;
}> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const listed = await cli(['attention', 'list', projectId], environment);
    if (listed.exitCode === 0) {
      const attentions = JSON.parse(listed.stdout) as readonly {
        readonly id: string; readonly kind: string; readonly responseType: string; readonly status: string;
        readonly prompt: Readonly<Record<string, unknown>> }[];
      const open = attentions.find((attention) => attention.status === 'OPEN');
      if (open !== undefined) return open;
    }
    await Bun.sleep(100);
  }
  throw new Error('The Claude permission Attention never appeared');
}

function claudeReport(path: string): ClaudeStubReport {
  return JSON.parse(readFileSync(path, 'utf8')) as ClaudeStubReport;
}

describe('codeestra task run --adapter claude', () => {
  test('routes a STRICT permission request to the existing Attention face and back to Claude',
    async () => {
      const { environment, projectId, taskId, claudeReportPath } = await fixture({ strict: true });
      // FULL would launch Claude with `bypassPermissions`; STRICT must let the provider ask.
      expect((await cli(['permission', 'get'], environment)).stdout)
        .toContain('"mode": "STRICT"');
      const ran = await cli(['task', 'run', projectId, taskId, '1', '--adapter', 'claude'], environment);
      expect(ran.exitCode).toBe(0);
      expect(JSON.parse(ran.stdout)).toMatchObject({ adapterId: 'claude' });

      const attention = await waitForAttention(environment, projectId);
      expect(attention.kind).toBe('PERMISSION');
      expect(attention.responseType).toBe('CONFIRM');
      expect(attention.prompt).toMatchObject({ kind: 'claude.permission', toolName: 'Bash',
        blockedPath: null, decisionReason: 'command needs approval' });

      const answered = await cli(['attention', 'answer', projectId, attention.id, 'confirm', 'no'],
        environment);
      expect(answered.exitCode).toBe(0);
      expect(JSON.parse(answered.stdout)).toMatchObject({ status: 'DELIVERED' });

      const exited = await waitForSessionExit(environment, projectId, taskId);
      // A denial is not a failed turn: the provider continues without the tool and the turn settles.
      expect(exited.executions[0]?.session?.state).toBe('EXITED');
      const report = claudeReport(claudeReportPath);
      expect(report.argv).toContain('--permission-mode');
      expect(report.argv).toContain('manual');
      expect(report.argv).not.toContain('--dangerously-skip-permissions');
      expect(report.controlResponses).toEqual([{ subtype: 'success',
        result: { behavior: 'deny', message: 'Denied by the Codeestra user', toolUseID: 'toolu-cli-1' },
        error: null }]);
      await cli(['stop'], environment);
    }, 120_000);

  test('runs without any approval in FULL mode and never asks for confirmation', async () => {
    // FULL is driven by `bypassPermissions`, so the stub's prompt never appears in this mode.
    const { environment, projectId, taskId, claudeReportPath } = await fixture({ mode: 'CANCEL' });
    const ran = await cli(['task', 'run', projectId, taskId, '1', '--adapter', 'claude'], environment);
    expect(ran.exitCode).toBe(0);
    const exited = await waitForSessionExit(environment, projectId, taskId);
    expect(exited.executions[0]?.session?.state).toBe('EXITED');
    const attentions = JSON.parse((await cli(['attention', 'list', projectId], environment)).stdout) as
      readonly unknown[];
    expect(attentions).toEqual([]);
    const report = claudeReport(claudeReportPath);
    expect(report.argv).toContain('bypassPermissions');
    expect(report.argv).toContain('--dangerously-skip-permissions');
    expect(report.argv).toContain('--safe-mode');
    expect(report.argv).toContain('--strict-mcp-config');
    await cli(['stop'], environment);
  }, 120_000);

  test('replaces a failed run attempt with a new run on a different adapter', async () => {
    // The Claude executable is missing, so this attempt fails during the version probe, before any
    // Execution or worktree is reserved. The Task stays runnable and a different Agent can run it.
    const { environment, projectId, taskId } = await fixture({ claudeExecutable: 'missing' });
    const failed = await cli(['task', 'run', projectId, taskId, '1', '--adapter', 'claude'], environment);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('PROVIDER_VERSION_UNAVAILABLE');
    const afterFailure = await status(environment, projectId, taskId);
    expect(afterFailure.task.state).toBe('READY');
    expect(afterFailure.executions).toEqual([]);

    const replaced = await cli(['task', 'run', projectId, taskId, '1', '--adapter', 'pi'], environment);
    expect(replaced.exitCode).toBe(0);
    expect(JSON.parse(replaced.stdout)).toMatchObject({ adapterId: 'pi' });
    const exited = await waitForSessionExit(environment, projectId, taskId);
    expect(exited.executions).toHaveLength(1);
    expect(exited.executions[0]?.session?.state).toBe('EXITED');
    await cli(['stop'], environment);
  }, 120_000);

  test('applies the per-adapter Agent configuration to the Claude launch, and refuses provider',
    async () => {
      const { environment, projectId, taskId, claudeReportPath } = await fixture({ mode: 'CANCEL' });
      // Claude Code has no provider launch parameter, so the scope refuses the field instead of
      // recording a provider that could never take effect.
      const refused = await cli(['agent', 'config', 'set', '--adapter', 'claude',
        '--provider', 'bedrock'], environment);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('INVALID_AGENT_CONFIGURATION');

      const configured = await cli(['agent', 'config', 'set', '--adapter', 'claude',
        '--model', 'claude-opus-5[1m]', '--thinking', 'high'], environment);
      expect(configured.exitCode).toBe(0);
      const claude = JSON.parse((await cli(['agent', 'config', 'get', '--adapter', 'claude'],
        environment)).stdout) as { readonly effective: Readonly<Record<string, string>> };
      expect(claude.effective).toMatchObject({ model: 'claude-opus-5[1m]', thinkingLevel: 'high' });
      // The Pi scope is untouched by the Claude scope.
      const pi = JSON.parse((await cli(['agent', 'config', 'get', '--adapter', 'pi'],
        environment)).stdout) as { readonly effective: Readonly<Record<string, string>> };
      expect(pi.effective.model).toBeNull();

      expect((await cli(['task', 'run', projectId, taskId, '1', '--adapter', 'claude'],
        environment)).exitCode).toBe(0);
      await waitForSessionExit(environment, projectId, taskId);
      const report = claudeReport(claudeReportPath);
      expect(report.argv).toEqual(expect.arrayContaining([
        '--model', 'claude-opus-5[1m]', '--effort', 'high']));
      await cli(['stop'], environment);
    }, 120_000);

  test('resumes a paused Claude Task on Claude and refuses a cross-provider resume', async () => {
    const { environment, projectId, taskId, claudeReportPath } = await fixture({ mode: 'CANCEL' });
    expect((await cli(['task', 'run', projectId, taskId, '1', '--adapter', 'claude'],
      environment)).exitCode).toBe(0);
    await waitForSessionExit(environment, projectId, taskId);

    const version = (await status(environment, projectId, taskId)).task.version;
    expect((await cli(['task', 'pause', projectId, taskId, String(version)], environment)).exitCode)
      .toBe(0);
    const pausedVersion = (await status(environment, projectId, taskId)).task.version;
    const resumed = await cli(['task', 'resume', projectId, taskId, String(pausedVersion),
      '--adapter', 'claude'], environment);
    expect(resumed.exitCode).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({ state: 'RUNNING' });
    await waitForSessionExit(environment, projectId, taskId);
    // The provider reopened the recorded conversation instead of starting a fresh one.
    const report = claudeReport(claudeReportPath);
    expect(report.argv).toContain('--resume');
    expect(report.argv).not.toContain('--session-id');
    expect(report.userMessages.at(-1)).toContain('has now resumed');

    const secondPause = (await status(environment, projectId, taskId)).task.version;
    expect((await cli(['task', 'pause', projectId, taskId, String(secondPause)],
      environment)).exitCode).toBe(0);
    const beforeRefusal = (await status(environment, projectId, taskId)).task.version;
    const refused = await cli(['task', 'resume', projectId, taskId, String(beforeRefusal),
      '--adapter', 'pi'], environment);
    // A Claude conversation cannot be handed to the Pi adapter, and the Runtime says so instead of
    // silently starting a conversation the Task never had.
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('AGENT_START_FAILED');
    await cli(['stop'], environment);
  }, 180_000);
});
