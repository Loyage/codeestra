import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

/**
 * An ordinary managed project — no dev clone, and no `dev` branch in the repository at all (ADR-0060:
 * a project Codeestra manages has no reason to carry Codeestra's own two-branch shape) — driven only
 * through the CLI and the Runtime command face (ADR-0008).
 *
 * What this proves: `project trust` accepts it, `task submit` starts it (the dependency verdict and
 * the scheduling gate no longer refuse with `DEV_REPO_REQUIRED`), the Execution really runs in a
 * worktree based on the folder's checked out branch, the result commit is an object of that folder's
 * repository, `task depends list` reads that branch, and `task verify` passes — the whole
 * `trust → task → run → verify` path ADR-0060 D02 promised for a managed project.
 *
 * What it does NOT prove: anything about a real provider. The `pi` beside it is a protocol stub that
 * writes one file and settles (ADR-0038: no real model requests here).
 */

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => { await reclaimTestResources(); });

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Managed Test',
      GIT_AUTHOR_EMAIL: 'managed@example.invalid',
      GIT_COMMITTER_NAME: 'Managed Test', GIT_COMMITTER_EMAIL: 'managed@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error('Timed out waiting for the expected state');
}

/**
 * A protocol stub, not a real provider: it answers `get_state`, writes one file per prompt and
 * settles the turn (the shape `packages/agent-adapters` turns into a SUCCESS completion).
 */
const stubSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('0.85.1\\n'); process.exit(0); }
const sessionDirIndex = argv.indexOf('--session-dir');
const sessionDir = sessionDirIndex >= 0 ? argv[sessionDirIndex + 1] : process.cwd();
mkdirSync(sessionDir, { recursive: true });
const taskId = basename(process.cwd());
const sessionFile = join(sessionDir, 'managed-session-' + taskId + '.jsonl');
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
        sessionId: 'managed-session-' + taskId, sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      writeFileSync(join(process.cwd(), taskId + '.txt'), 'work\\n');
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'managed-session-' + taskId, timestamp: '2026-09-16T09:00:00.000Z',
        cwd: process.cwd() }) + '\\n');
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Wrote the file.' }], stopReason: 'stop' } });
      emit({ type: 'agent_settled' });
    }
  }
}
`;

interface ManagedFixture {
  readonly repository: string;
  readonly tools: string;
}

/** A repository with a verification policy and **no** `dev` branch and **no** second clone. */
async function managedFixture(): Promise<ManagedFixture> {
  const repository = temporaryDirectory('codeestra-managed-repo-');
  const tools = temporaryDirectory('codeestra-managed-tools-');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }, null, 2));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  const stubPath = join(tools, 'stub-pi.ts');
  const shimPath = join(tools, 'pi');
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);
  return { repository, tools: shimPath };
}

describe('codeestra runs Tasks in the project folder itself (ADR-0064)', () => {
  test('trusts, starts, commits and verifies a Task whose baseline is the folder\'s checked out branch',
    async () => {
      const home = temporaryDirectory('codeestra-managed-home-');
      const main = await managedFixture();
      const environment = { CODEESTRA_HOME: home,
        CODEESTRA_PI_EXECUTABLE: main.tools };

      // ADR-0064: there is no dev clone to record, so a repository with no `dev` branch at all is the
      // ordinary shape. Trust pins the repository identity and the committed policies.
      const trusted = await cli(['project', 'trust', main.repository, '--yes'], environment);
      expect(trusted.exitCode).toBe(0);
      const inspected = JSON.parse((await cli(['project', 'inspect', main.repository],
        environment)).stdout) as { readonly repoRoot: string; readonly mainRef: string };
      expect(inspected.repoRoot).toBe(realpathSync(main.repository));
      expect(inspected.mainRef).toBe('refs/heads/main');
      const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
        readonly { readonly id: string }[];
      const projectId = projects[0]?.id as string;

      const created = JSON.parse((await cli(['task', 'create', '--project', projectId, 'Write one file',
        '--title', 'Write one file', '--name', 'write-one-file'],
        environment)).stdout) as { readonly id: string; readonly version: number };
      // Submitting is where the defect reported itself: the dependency verdict refused the command
      // with `DEV_REPO_REQUIRED` before the Task could ever be scheduled.
      const submitted = await cli(['task', 'submit', created.id, String(created.version)],
        environment);
      expect(submitted.exitCode).toBe(0);

      // The stub provider wrote its file, so the Execution really started — in a worktree based on the
      // branch the project folder has checked out, whose Task branch is registered in that folder.
      // ADR-0065 D03: the workspace namespace is the display number plus the naming title, and this is
      // the project's first Task.
      const workspaceName = '1-write-one-file';
      const worktree = join(realpathSync(home), 'worktrees', projectId, workspaceName);
      await waitFor(() => existsSync(join(worktree, `${workspaceName}.txt`)));
      const mainCommit = await git(main.repository, ['rev-parse', 'refs/heads/main']);
      expect(await git(main.repository, ['rev-parse', `refs/heads/task/${workspaceName}`]))
        .toBe(mainCommit);

      // The dependency projection reads that same baseline ref and names it plainly. Since ADR-0070
      // D07 / S8 that baseline is the Project Service's managed integration ref, materialized by
      // `project trust` from the commit this folder had checked out.
      const dependencies = JSON.parse((await cli(['task', 'depends', 'list', created.id,
        '--json'], environment)).stdout) as {
        readonly baseRef: string; readonly baseCommit: string | null; readonly blocked: boolean;
      };
      expect(dependencies.baseRef).toBe('refs/codeestra/integration');
      expect(dependencies.baseCommit).toBe(mainCommit);
      expect(await git(main.repository, ['rev-parse', 'refs/codeestra/integration'])).toBe(mainCommit);
      expect(dependencies.blocked).toBe(false);

      // FULL mode captures the result commit in one step. The Runtime proves quiescence from its own
      // observation of the settled provider, so the command is retried until that evidence exists —
      // the same wait a person would do, never a claim that it already holds.
      const captured = await waitForCapturedResult(created.id, environment);
      expect(await git(main.repository, ['cat-file', '-t', captured.resultCommit])).toBe('commit');

      const verified = JSON.parse((await cli(['task', 'verify', created.id], environment))
        .stdout) as { readonly state: string; readonly testedCommit: string };
      expect(verified.state).toBe('PASSED');
      expect(verified.testedCommit).toBe(captured.resultCommit);

      // The Task is a first-class finished Task: its own tree, its own commit, nothing in a dev clone.
      const status = JSON.parse((await cli(['task', 'status', created.id], environment))
        .stdout) as { readonly task: { readonly state: string } };
      expect(status.task.state).toBe('EXECUTED');

      await cli(['stop'], environment);
    }, 180_000);
});

/** The captured result commit, once the Runtime has observed the provider settle. */
async function waitForCapturedResult(
  taskId: string,
  environment: Record<string, string>,
): Promise<{ readonly resultCommit: string }> {
  const deadline = Date.now() + 60_000;
  let last = '';
  while (Date.now() < deadline) {
    const capture = await cli(['task', 'result', 'capture', taskId], environment);
    if (capture.exitCode === 0) {
      return JSON.parse(capture.stdout) as { readonly resultCommit: string };
    }
    last = capture.stderr.trim().split('\n').at(-1) ?? capture.stdout.trim();
    await Bun.sleep(250);
  }
  throw new Error(`task result capture never succeeded; last output: ${last}`);
}
