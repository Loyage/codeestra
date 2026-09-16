import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';
import { provisionDevClone } from './support/agent-fixture.js';
import { recordedWorkspaceBranch, recordedWorkspacePath } from './support/workspace-naming.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => { await reclaimTestResources(); });

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  // FOUNDATION-057: the shared runner refuses a non-temporary CODEESTRA_HOME (a test must never
  // reach the real Runtime home) and registers the home so teardown stops any Runtime it started,
  // including when an assertion fails before the test's own stop.
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Integration Test',
      GIT_AUTHOR_EMAIL: 'integration@example.invalid', GIT_COMMITTER_NAME: 'Integration Test',
      GIT_COMMITTER_EMAIL: 'integration@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

interface ExecutionPayload {
  readonly state: string;
  readonly session: { readonly state: string } | null;
}

interface TaskStatusPayload {
  readonly task: { readonly id: string; readonly state: string; readonly version: number };
  readonly executions: readonly ExecutionPayload[];
  readonly verifications: readonly { readonly state: string; readonly testedCommit: string }[];
  readonly integrations: readonly { readonly state: string;
    readonly integratedCommit: string | null }[];
}

/**
 * A protocol stub, not a real provider: it writes one file in the Task worktree, reports the
 * session, settles, and exits. It proves the Runtime's command face end to end and is never
 * evidence that a real Agent integration works.
 */
const stubSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const sessionDirIndex = argv.indexOf('--session-dir');
const sessionDir = sessionDirIndex >= 0 ? argv[sessionDirIndex + 1] : process.cwd();
mkdirSync(sessionDir, { recursive: true });
const sessionFile = join(sessionDir, 'integration-session.jsonl');
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
        sessionId: 'integration-session', sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      writeFileSync(join(process.cwd(), 'agent-output.txt'), 'work\\n');
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'integration-session', timestamp: '2026-09-13T09:00:00.000Z',
        cwd: process.cwd() }) + '\\n');
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Wrote the file.' }], stopReason: 'stop' } });
      emit({ type: 'agent_settled' });
      setTimeout(() => process.exit(0), 50);
    }
  }
}
`;

async function fixture(options: { readonly failingPolicy?: boolean } = {}): Promise<{
  readonly environment: Record<string, string>;
  readonly repository: string;
  readonly devRepo: string;
  readonly projectId: string;
}> {
  const repository = temporaryDirectory('codeestra-integrate-repo-');
  const home = temporaryDirectory('codeestra-integrate-home-');
  const tools = temporaryDirectory('codeestra-integrate-tools-');
  const assets = temporaryDirectory('codeestra-integrate-assets-');
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1,
    commands: [{ id: 'check', argv: [options.failingPolicy === true ? 'false' : 'true'],
      cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  // ADR-0009: the long-lived dev branch is the workspace baseline and the integration target.
  await git(repository, ['branch', 'dev']);
  // ADR-0056: every dev fact comes from a second clone of the same origin that sits on
  // `dev`; the project is trusted with it explicitly.
  const devRepo = await provisionDevClone({ repository: repository });

  const stubPath = join(tools, 'stub-pi.ts');
  const shimPath = join(tools, 'pi');
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);

  const environment = {
    CODEESTRA_HOME: home,
    CODEESTRA_UI_DIST: assets,
    CODEESTRA_PI_EXECUTABLE: shimPath,
  };
  const opened = await cli(['open', repository, '--dev-repo', devRepo, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  return { environment, repository, devRepo, projectId: projects[0]?.id as string };
}

async function status(
  environment: Record<string, string>,
  projectId: string,
  taskId: string,
): Promise<TaskStatusPayload> {
  const listed = await cli(['task', 'status', projectId, taskId], environment);
  expect(listed.exitCode).toBe(0);
  return JSON.parse(listed.stdout) as TaskStatusPayload;
}

/** Drives one Task to a captured result commit through the CLI only. */
async function capturedTask(options: { readonly failingPolicy?: boolean } = {}): Promise<{
  readonly environment: Record<string, string>;
  readonly repository: string;
  readonly devRepo: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly resultCommit: string;
}> {
  const { environment, repository, devRepo, projectId } = await fixture(options);
  const created = JSON.parse((await cli(['task', 'create', projectId, 'Write a file',
    '--title', 'Write a file', '--name', 'write-a-file'],
    environment)).stdout) as { readonly id: string };
  const taskId = created.id;
  // Submission immediately enters scheduling. Under ADR-0059 an undeclared Task is SAFE, so the
  // automatic pass starts it without a second `task run` command.
  expect((await cli(['task', 'submit', projectId, taskId, '0'], environment)).exitCode).toBe(0);
  // The Agent process exits on its own; capture needs the Session to be observed as EXITED.
  const deadline = Date.now() + 30_000;
  let exited = false;
  while (Date.now() < deadline) {
    const current = await status(environment, projectId, taskId);
    if (current.executions[0]?.session?.state === 'EXITED') { exited = true; break; }
    await Bun.sleep(100);
  }
  expect(exited).toBe(true);
  const captured = await cli(['task', 'result', 'capture', projectId, taskId], environment);
  expect(captured.exitCode).toBe(0);
  const resultCommit = (JSON.parse(captured.stdout) as { readonly resultCommit: string }).resultCommit;
  return { environment, repository, devRepo, projectId, taskId, resultCommit };
}

describe('codeestra task integrate', () => {
  test('runs the whole integration from the CLI and moves dev only after it passes', async () => {
    const { environment, repository, devRepo, projectId, taskId, resultCommit } = await capturedTask();
    const devBefore = await git(devRepo, ['rev-parse', 'refs/heads/dev']);
    const mainBefore = await git(repository, ['rev-parse', 'refs/heads/main']);

    const verified = await cli(['task', 'verify', projectId, taskId], environment);
    expect(verified.exitCode).toBe(0);
    expect((JSON.parse(verified.stdout) as { readonly state: string }).state).toBe('PASSED');

    const version = (await status(environment, projectId, taskId)).task.version;
    const integrated = await cli(['task', 'integrate', projectId, taskId, String(version)], environment);
    expect(integrated.stderr).toBe('');
    expect(integrated.exitCode).toBe(0);
    const report = JSON.parse(integrated.stdout) as { readonly state: string;
      readonly integratedCommit: string; readonly mergeStrategy: string;
      readonly verificationState: string;
      readonly reclamation?: { readonly enabled: boolean; readonly attempted: number;
        readonly reclaimed: number; readonly alreadyAbsent: number; readonly retained: number;
        readonly refused: number; readonly failed: number; readonly detail: string | null } };
    expect(report).toMatchObject({ state: 'INTEGRATED', integratedCommit: resultCommit,
      mergeStrategy: 'FAST_FORWARD', verificationState: 'PASSED' });

    // ADR-0062: a successful integration reclaims the member Task worktree by default, through the
    // same ownership-checked decision `reclaim` uses. The branch is never touched, so `task retry`
    // can still rebuild from it (ADR-0042). ADR-0065 D03: the workspace is named
    // `<displayNumber>-<namingTitle>`, so the recorded row — not the Task id — is the fact.
    const home = environment['CODEESTRA_HOME'] as string;
    const worktreePath = recordedWorkspacePath(home, taskId);
    expect(report.reclamation).toMatchObject({ enabled: true, attempted: 1, reclaimed: 1,
      retained: 0, failed: 0 });
    expect(existsSync(worktreePath)).toBe(false);
    expect(await git(devRepo, ['rev-parse', '--verify', recordedWorkspaceBranch(home, taskId)]))
      .toBe(resultCommit);

    // The ref moved, the stable branch did not, and the Task reached SUCCEEDED.
    expect(await git(devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(resultCommit);
    expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(mainBefore);
    expect(devBefore).not.toBe(resultCommit);
    const after = await status(environment, projectId, taskId);
    expect(after.task.state).toBe('SUCCEEDED');
    expect(after.integrations).toEqual([expect.objectContaining({ state: 'INTEGRATED',
      integratedCommit: resultCommit })]);

    // `task integration list` is the CLI view of the same records, and a replay of the same
    // command ID is reported as an already completed integration instead of a second merge.
    const listed = JSON.parse((await cli(['task', 'integration', 'list', projectId, taskId],
      environment)).stdout) as readonly { readonly state: string; readonly devRef: string }[];
    expect(listed).toEqual([expect.objectContaining({ state: 'INTEGRATED', devRef: 'refs/heads/dev' })]);
    await cli(['stop'], environment);
  }, 120_000);

  test('leaves the worktree in place when auto-reclaim is off, and the explicit reclaim still takes it',
    async () => {
      const { environment, projectId, taskId, resultCommit } = await capturedTask();
      const home = environment['CODEESTRA_HOME'] as string;
      const worktreePath = recordedWorkspacePath(home, taskId);
      expect(existsSync(worktreePath)).toBe(true);

      const off = await cli(['settings', 'auto-reclaim', 'off'], environment);
      expect(off.exitCode).toBe(0);
      expect(JSON.parse(off.stdout)).toMatchObject({ enabled: false, default: true });

      expect((await cli(['task', 'verify', projectId, taskId], environment)).exitCode).toBe(0);
      const version = (await status(environment, projectId, taskId)).task.version;
      const integrated = await cli(['task', 'integrate', projectId, taskId, String(version)],
        environment);
      expect(integrated.exitCode).toBe(0);
      const report = JSON.parse(integrated.stdout) as { readonly state: string;
        readonly integratedCommit: string;
        readonly reclamation?: { readonly enabled: boolean; readonly attempted: number } };
      expect(report).toMatchObject({ state: 'INTEGRATED', integratedCommit: resultCommit });
      expect(report.reclamation).toMatchObject({ enabled: false, attempted: 0 });
      // The setting turned the automatic path off; the directory is still there.
      expect(existsSync(worktreePath)).toBe(true);

      // The explicit command is unaffected by the setting and reclaims it now that it is merged.
      const reclaimed = await cli(['reclaim', 'apply', '--project', projectId, '--task', taskId,
        '--kind', 'TASK_WORKTREE', '--json'], environment);
      expect(reclaimed.exitCode).toBe(0);
      const reclamation = JSON.parse(reclaimed.stdout) as {
        readonly outcomeCounts: { readonly reclaimed: number } };
      expect(reclamation.outcomeCounts.reclaimed).toBe(1);
      expect(existsSync(worktreePath)).toBe(false);
      await cli(['stop'], environment);
    }, 120_000);

  test('refuses to integrate without a PASSED verification and leaves dev untouched', async () => {
    const { environment, devRepo, projectId, taskId } = await capturedTask({ failingPolicy: true });
    const devBefore = await git(devRepo, ['rev-parse', 'refs/heads/dev']);
    const verified = await cli(['task', 'verify', projectId, taskId], environment);
    expect(verified.exitCode).toBe(1);

    const version = (await status(environment, projectId, taskId)).task.version;
    const integrated = await cli(['task', 'integrate', projectId, taskId, String(version)], environment);
    expect(integrated.exitCode).toBe(1);
    expect(integrated.stderr).toContain('TASK_VERIFICATION_NOT_PASSED');
    expect(await git(devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(devBefore);
    const after = await status(environment, projectId, taskId);
    expect(after.task.state).toBe('EXECUTED');
    expect(after.integrations).toHaveLength(0);
    await cli(['stop'], environment);
  }, 120_000);
});
