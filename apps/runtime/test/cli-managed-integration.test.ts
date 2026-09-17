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
 * S8 through the command face only (ADR-0008/0070 D07, ADR-0074): `project trust` materializes the
 * managed integration ref, a Task's verified result enters the merge queue and the ref advances, and
 * the next Task is really based on what the previous one produced. Everything is driven with the CLI
 * against a temporary repository; no desktop or window automation is involved.
 *
 * The provider is the same protocol stub `cli-managed-project.test.ts` uses: it answers the RPC
 * handshake, writes one file and settles. It is not a model, and nothing here claims a real provider
 * was exercised.
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
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'S8 Test', GIT_AUTHOR_EMAIL: 's8@example.invalid',
      GIT_COMMITTER_NAME: 'S8 Test', GIT_COMMITTER_EMAIL: 's8@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, 'merge-base', '--is-ancestor', ancestor,
    descendant], stdout: 'ignore', stderr: 'ignore', env: { PATH: Bun.env.PATH ?? '' } });
  return (await child.exited) === 0;
}

/**
 * The provider stub, copied from `cli-managed-project.test.ts`: it answers the Codeestra RPC
 * handshake, writes one file per prompt and settles the turn. `from-agent.txt` is *not* written by
 * it; the test observes the stub's own `<taskId>.txt` file for liveness and the result commit for
 * the baseline claim.
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

async function createProject(input: { readonly home: string }):
Promise<{ readonly repository: string; readonly projectId: string }> {
  const repository = temporaryDirectory('codeestra-s8-repo-');
  const tools = temporaryDirectory('codeestra-s8-tools-');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'),
    JSON.stringify({ version: 1, commands: [{ id: 'smoke', argv: ['true'], cwd: '.',
      timeoutSeconds: 60 }] }, null, 2));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  const stubPath = join(tools, 'stub-pi.ts');
  const shimPath = join(tools, 'pi');
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);
  const environment = { CODEESTRA_HOME: input.home, CODEESTRA_PI_EXECUTABLE: shimPath };
  const trusted = await cli(['project', 'trust', repository, '--yes'], environment);
  expect(trusted.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  return { repository: realpathSync(repository), projectId: projects[0]?.id as string };
}

/** Runs one Task to EXECUTED with a captured result commit and a PASSED Task verification. */
async function runAndVerify(input: {
  readonly projectId: string; readonly repository: string; readonly displayNumber: number;
  readonly name: string; readonly title: string; readonly environment: Record<string, string>;
}): Promise<{ readonly taskId: string; readonly resultCommit: string }> {
  const created = JSON.parse((await cli(['task', 'create', '--project', input.projectId, input.title,
    '--title', input.title, '--name', input.name], input.environment)).stdout) as
    { readonly id: string; readonly version: number };
  const submitted = await cli(['task', 'submit', created.id,
    String(created.version)], input.environment);
  expect(submitted.exitCode).toBe(0);
  const workspaceName = `${input.displayNumber}-${input.name}`;
  const worktree = join(input.environment['CODEESTRA_HOME'] as string, 'worktrees', input.projectId,
    workspaceName);
  await waitFor(() => existsSync(join(worktree, `${workspaceName}.txt`)));
  const captured = await waitForCapturedResult(created.id, input.environment);
  const verified = JSON.parse((await cli(['task', 'verify', created.id],
    input.environment)).stdout) as { readonly state: string };
  expect(verified.state).toBe('PASSED');
  expect(await git(input.repository, ['cat-file', '-t', captured.resultCommit])).toBe('commit');
  return { taskId: created.id, resultCommit: captured.resultCommit };
}

/** The captured result commit, once the Runtime has observed the provider settle. */
async function waitForCapturedResult(taskId: string,
  environment: Record<string, string>): Promise<{ readonly resultCommit: string }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const capture = await cli(['task', 'result', 'capture', taskId], environment);
    if (capture.exitCode === 0) return JSON.parse(capture.stdout) as { readonly resultCommit: string };
    await Bun.sleep(250);
  }
  throw new Error('the Task result was never captured');
}

async function waitFor(predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error('Timed out waiting for the expected state');
}

describe('managed integration CLI', () => {
  test('trust creates the managed ref, and status/queue/run report it honestly', async () => {
    const home = temporaryDirectory('codeestra-s8-home-');
    const environment = { CODEESTRA_HOME: home };
    const project = await createProject({ home });
    try {
      // Trust materialized the ref from the folder's checked-out branch, with no extra user step.
      expect(await git(project.repository, ['symbolic-ref', '-q', 'HEAD'])).toBe('refs/heads/main');
      const head = await git(project.repository, ['rev-parse', 'HEAD']);
      expect(await git(project.repository, ['rev-parse', 'refs/codeestra/integration'])).toBe(head);
      // It is not a branch: `git branch` cannot list it and no checkout can hold it.
      expect(await git(project.repository, ['branch', '--list'])).not.toContain('codeestra');

      const status = await cli(['project', 'integration', 'status', project.projectId, '--json'],
        environment);
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ currentOid: head, recordedOid: head,
        refInSync: true, worktree: { state: 'MISSING' }, queuedCount: 0, state: 'ACTIVE',
        needsAttention: false });

      const queue = await cli(['project', 'integration', 'queue', project.projectId, '--json'],
        environment);
      expect(JSON.parse(queue.stdout)).toMatchObject({ items: [] });

      const ran = await cli(['project', 'integration', 'run', project.projectId, '--json'],
        environment);
      expect(ran.exitCode).toBe(0);
      expect(JSON.parse(ran.stdout)).toMatchObject({ outcome: 'NOOP' });

      // A Task that never passed verification cannot enter the queue, and nothing is queued.
      const refused = await cli(['project', 'integration', 'request', project.projectId,
        '20000000-0000-4000-8000-0000000000aa'], environment);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('TASK_NOT_FOUND');
      expect(JSON.parse((await cli(['project', 'integration', 'queue', project.projectId, '--json'],
        environment)).stdout)).toMatchObject({ items: [] });
    } finally {
      await cli(['stop'], environment);
    }
  }, 180_000);

  test('a verified Task result is merged into the managed ref and the next Task is based on it',
    async () => {
      const home = temporaryDirectory('codeestra-s8-home-');
      const environment = { CODEESTRA_HOME: home };
      const project = await createProject({ home });
      try {
        const first = await runAndVerify({ projectId: project.projectId,
          repository: project.repository, displayNumber: 1, name: 'first-task',
          title: 'First task', environment });

        const requested = await cli(['project', 'integration', 'request', project.projectId,
          first.taskId, '--json'], environment);
        expect(requested.exitCode).toBe(0);
        const queued = JSON.parse(requested.stdout) as { readonly created: boolean;
          readonly item: { readonly id: string; readonly state: string;
            readonly resultCommit: string } };
        expect(queued.created).toBe(true);
        expect(queued.item.state).toBe('QUEUED');
        expect(queued.item.resultCommit).toBe(first.resultCommit);

        const merged = await cli(['project', 'integration', 'run', project.projectId, '--json'],
          environment);
        expect(merged.exitCode).toBe(0);
        const report = JSON.parse(merged.stdout) as { readonly outcome: string;
          readonly candidateCommit: string; readonly integrationOid: string;
          readonly integrationVerification: { readonly state: string } };
        expect(report.outcome).toBe('MERGED');
        expect(report.integrationVerification.state).toBe('PASSED');
        expect(await git(project.repository, ['rev-parse', 'refs/codeestra/integration']))
          .toBe(report.candidateCommit);
        expect(await isAncestor(project.repository, first.resultCommit, report.candidateCommit))
          .toBe(true);

        // The Task's integration projection is MERGED and carries the commit it landed at.
        const taskView = JSON.parse((await cli(['task', 'integration', 'show',
          first.taskId, '--json'], environment)).stdout) as { readonly state: string;
          readonly integrationOid: string };
        expect(taskView.state).toBe('MERGED');
        expect(taskView.integrationOid).toBe(report.candidateCommit);

        // The user's working tree was never touched: still on main, still clean, and only the managed
        // ref moved.
        expect(await git(project.repository, ['symbolic-ref', '-q', 'HEAD'])).toBe('refs/heads/main');
        expect(await git(project.repository, ['status', '--porcelain'])).toBe('');

        // A second Task is based on the integration commit, so that commit is an ancestor of its
        // result while it is *not* an ancestor of the user's main branch.
        const second = await runAndVerify({ projectId: project.projectId,
          repository: project.repository, displayNumber: 2, name: 'second-task',
          title: 'Second task', environment });
        const mainCommit = await git(project.repository, ['rev-parse', 'refs/heads/main']);
        expect(await isAncestor(project.repository, report.candidateCommit, second.resultCommit))
          .toBe(true);
        expect(await isAncestor(project.repository, report.candidateCommit, mainCommit)).toBe(false);
        // …and integrating the second Task advances the same ref again.
        const mergedSecond = await cli(['project', 'integration', 'request', project.projectId,
          second.taskId, '--json'], environment);
        expect(mergedSecond.exitCode).toBe(0);
        const secondRun = await cli(['project', 'integration', 'run', project.projectId, '--json'],
          environment);
        expect(secondRun.exitCode).toBe(0);
        const secondReport = JSON.parse(secondRun.stdout) as { readonly outcome: string;
          readonly candidateCommit: string };
        expect(secondReport.outcome).toBe('MERGED');
        expect(await isAncestor(project.repository, first.resultCommit,
          secondReport.candidateCommit)).toBe(true);
      } finally {
        await cli(['stop'], environment);
      }
    }, 600_000);

  test('the merge-request Signal reaches the same handler and refuses by name', async () => {
    const home = temporaryDirectory('codeestra-s8-home-');
    const environment = { CODEESTRA_HOME: home };
    const project = await createProject({ home });
    try {
      // A PROJECT Service accepts `TASK_MERGE_REQUESTED`; the payload is well formed but names a Task
      // that does not exist, so the handler refuses it by name instead of the Runtime answering
      // `SIGNAL_HANDLER_NOT_FOUND` — which is what would happen if the subtype were not wired.
      const sent = await cli(['signal', 'send', project.projectId, '--kind', 'SIG_A', '--subtype',
        'TASK_MERGE_REQUESTED', '--payload-json', JSON.stringify({
          taskId: '20000000-0000-4000-8000-0000000000bb',
          revisionId: '30000000-0000-4000-8000-0000000000bb',
          resultCommit: 'a'.repeat(40),
          taskVerificationRunId: '40000000-0000-4000-8000-0000000000bb',
          priority: 0,
        }), '--idempotency-key', 'merge-request-1', '--json'], environment);
      expect(sent.exitCode).toBe(1);
      const signal = JSON.parse(sent.stdout) as { readonly signal: { readonly state: string;
        readonly lastErrorCode: string | null } };
      expect(signal.signal.state).toBe('DEAD_LETTER');
      expect(signal.signal.lastErrorCode).toBe('TASK_NOT_FOUND');
      // Nothing was queued by a refused request.
      expect(JSON.parse((await cli(['project', 'integration', 'queue', project.projectId, '--json'],
        environment)).stdout)).toMatchObject({ items: [] });
      // A settle notification is only accepted by a TASK Service: the Project Service refuses it.
      const wrongTarget = await cli(['signal', 'send', project.projectId, '--kind', 'SIG_A',
        '--subtype', 'TASK_MERGE_SETTLED', '--payload-json', JSON.stringify({
          taskId: project.projectId, queueItemId: 'x', state: 'MERGED',
          integrationOid: null, projectionVersion: 0,
        }), '--idempotency-key', 'settle-1'], environment);
      expect(wrongTarget.exitCode).toBe(1);
      expect(wrongTarget.stderr).toContain('SIGNAL_NOT_ACCEPTED');
    } finally {
      await cli(['stop'], environment);
    }
  }, 180_000);

  test('usage errors stay one line and point at the level that owns the command', async () => {
    const home = temporaryDirectory('codeestra-s8-home-');
    const environment = { CODEESTRA_HOME: home };
    try {
      const missing = await cli(['project', 'integration', 'status'], environment);
      expect(missing.exitCode).toBe(2);
      expect(missing.stderr.trim().split('\n')).toHaveLength(1);
      expect(missing.stderr).toContain('project integration help');
      const unknown = await cli(['project', 'integration', 'nope'], environment);
      expect(unknown.exitCode).toBe(2);
      expect(unknown.stderr.trim().split('\n')).toHaveLength(1);
      // `help` answers every level from the command tree, without a Runtime.
      const help = await cli(['project', 'integration', 'help'], environment);
      expect(help.exitCode).toBe(0);
      for (const command of ['status', 'init', 'request', 'queue', 'run', 'retry', 'cancel']) {
        expect(help.stdout).toContain(command);
      }
      expect(help.stdout).toContain('refs/codeestra/integration');
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);
});
