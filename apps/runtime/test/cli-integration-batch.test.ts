import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';
import { provisionDevClone } from './support/agent-fixture.js';

/**
 * The multi-member IntegrationBatch command face, driven through the real CLI and a real Runtime
 * (FOUNDATION-081 / ADR-0053). The provider is a protocol stub, so this file is evidence about the
 * Runtime's command face and its Git effects, never evidence that a real Agent integration works.
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
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Integration Test',
      GIT_AUTHOR_EMAIL: 'integration@example.invalid', GIT_COMMITTER_NAME: 'Integration Test',
      GIT_COMMITTER_EMAIL: 'integration@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

/**
 * The stub writes one file whose name is derived from its own worktree, so two Task members of the
 * same batch never touch the same path and the multi-member merge is a clean one.
 */
const stubSource = `
import { createHash } from 'node:crypto';
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
const memberFile = 'member-' + createHash('sha1').update(process.cwd()).digest('hex').slice(0, 8) + '.txt';

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
      writeFileSync(join(process.cwd(), memberFile), 'work\\n');
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

interface BatchFixture {
  readonly environment: Record<string, string>;
  readonly repository: string;
  /** The dev clone the project is trusted with (ADR-0056). */
  readonly devRepo: string;
  readonly projectId: string;
}

async function fixture(): Promise<BatchFixture> {
  const repository = temporaryDirectory('codeestra-batch-repo-');
  const home = temporaryDirectory('codeestra-batch-home-');
  const tools = temporaryDirectory('codeestra-batch-tools-');
  const assets = temporaryDirectory('codeestra-batch-assets-');
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1,
    commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
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

interface TaskStatusPayload {
  readonly task: { readonly state: string; readonly version: number };
  readonly executions: readonly { readonly session: { readonly state: string } | null }[];
  readonly integrations: readonly { readonly batchId: string; readonly state: string;
    readonly members: readonly { readonly taskId: string; readonly state: string }[] }[];
}

async function status(fixture: BatchFixture, taskId: string): Promise<TaskStatusPayload> {
  const listed = await cli(['task', 'status', fixture.projectId, taskId], fixture.environment);
  expect(listed.exitCode).toBe(0);
  return JSON.parse(listed.stdout) as TaskStatusPayload;
}

/** Drives one Task to a captured result commit and a PASSED Task verification through the CLI. */
async function capturedTask(fixture: BatchFixture): Promise<{ readonly taskId: string }> {
  const created = JSON.parse((await cli(['task', 'create', fixture.projectId, 'Write a file'],
    fixture.environment)).stdout) as { readonly id: string };
  const taskId = created.id;
  expect((await cli(['task', 'submit', fixture.projectId, taskId, '0'],
    fixture.environment)).exitCode).toBe(0);
  expect((await cli(['task', 'run', fixture.projectId, taskId, '1'],
    fixture.environment)).exitCode).toBe(0);
  const deadline = Date.now() + 30_000;
  let exited = false;
  while (Date.now() < deadline) {
    const current = await status(fixture, taskId);
    if (current.executions[0]?.session?.state === 'EXITED') { exited = true; break; }
    await Bun.sleep(100);
  }
  expect(exited).toBe(true);
  expect((await cli(['task', 'result', 'capture', fixture.projectId, taskId],
    fixture.environment)).exitCode).toBe(0);
  const verified = await cli(['task', 'verify', fixture.projectId, taskId], fixture.environment);
  expect(verified.exitCode).toBe(0);
  expect((JSON.parse(verified.stdout) as { readonly state: string }).state).toBe('PASSED');
  return { taskId };
}

/** Two captured-and-verified Tasks in one repository, plus the version each batch member needs. */
async function twoMembers(): Promise<{ readonly fixture: BatchFixture;
  readonly members: readonly { readonly taskId: string; readonly version: number }[] }> {
  const value = await fixture();
  const members: { taskId: string; version: number }[] = [];
  for (let index = 0; index < 2; index += 1) {
    const task = await capturedTask(value);
    const current = await status(value, task.taskId);
    members.push({ taskId: task.taskId, version: current.task.version });
  }
  return { fixture: value, members };
}

function memberFlags(members: readonly { readonly taskId: string; readonly version: number }[]) {
  return members.flatMap((member) => ['--member', `${member.taskId}:${member.version}`]);
}

describe('codeestra task integration (multi-member batch)', () => {
  test('composes and integrates two members with one verification, and dev moves only then',
    async () => {
      const { fixture: value, members } = await twoMembers();
      const devBefore = await git(value.devRepo, ['rev-parse', 'refs/heads/dev']);

      const created = await cli(['task', 'integration', 'create', value.projectId,
        ...memberFlags(members)], value.environment);
      expect(created.exitCode).toBe(0);
      const batch = JSON.parse(created.stdout) as { readonly batchId: string;
        readonly state: string; readonly devCommit: string;
        readonly members: readonly { readonly state: string }[] };
      expect(batch).toMatchObject({ state: 'CREATED', devCommit: devBefore });
      expect(batch.members).toHaveLength(2);
      // Composing writes no Git side effect at all: the batch is a record about facts.
      expect(await git(value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(devBefore);

      const integrated = await cli(['task', 'integration', 'integrate', value.projectId,
        batch.batchId], value.environment);
      expect(integrated.stderr).toBe('');
      expect(integrated.exitCode).toBe(0);
      const report = JSON.parse(integrated.stdout) as { readonly state: string;
        readonly integratedCommit: string; readonly verificationState: string;
        readonly members: readonly { readonly state: string }[] };
      expect(report).toMatchObject({ state: 'INTEGRATED', verificationState: 'PASSED' });
      expect(report.members.map((member) => member.state)).toEqual(['INTEGRATED', 'INTEGRATED']);
      expect(await git(value.devRepo, ['rev-parse', 'refs/heads/dev']))
        .toBe(report.integratedCommit);
      // Both members' work is in the integrated tree and both Tasks only reached SUCCEEDED here.
      const tree = await git(value.devRepo, ['ls-tree', '-r', '--name-only',
        report.integratedCommit]);
      expect(tree.split('\n').filter((path) => path.startsWith('member-'))).toHaveLength(2);
      for (const member of members) {
        expect((await status(value, member.taskId)).task.state).toBe('SUCCEEDED');
      }

      // The whole batch is one read: `list` without a Task ID and `get` show the members.
      const listed = JSON.parse((await cli(['task', 'integration', 'list', value.projectId],
        value.environment)).stdout) as readonly { readonly batchId: string }[];
      expect(listed).toEqual([expect.objectContaining({ batchId: batch.batchId })]);
      const read = await cli(['task', 'integration', 'get', value.projectId, batch.batchId],
        value.environment);
      expect(read.exitCode).toBe(0);
      expect(JSON.parse(read.stdout)).toMatchObject({ state: 'INTEGRATED',
        members: [{ state: 'INTEGRATED' }, { state: 'INTEGRATED' }] });

      // Integrating the same batch again reports the recorded verdict and moves nothing.
      const replay = await cli(['task', 'integration', 'integrate', value.projectId, batch.batchId],
        value.environment);
      expect(replay.exitCode).toBe(0);
      expect(JSON.parse(replay.stdout)).toMatchObject({ state: 'INTEGRATED',
        alreadyCompleted: true, integratedCommit: report.integratedCommit });
      expect(await git(value.devRepo, ['rev-parse', 'refs/heads/dev']))
        .toBe(report.integratedCommit);
      await cli(['stop'], value.environment);
    }, 180_000);

  test('marks the batch STALE when a member revision moved, and leaves dev untouched', async () => {
    const { fixture: value, members } = await twoMembers();
    const devBefore = await git(value.devRepo, ['rev-parse', 'refs/heads/dev']);
    const created = await cli(['task', 'integration', 'create', value.projectId,
      ...memberFlags(members)], value.environment);
    const batch = JSON.parse(created.stdout) as { readonly batchId: string };

    // A real revision is appended to one member: the batch's fixed revision is no longer current.
    const revised = await cli(['task', 'revision', 'create', value.projectId,
      members[1]?.taskId as string, String(members[1]?.version as number),
      '--specification', 'The member moved after the batch was composed',
      '--reason', 'the member moved after the batch was composed'],
    value.environment);
    expect(revised.exitCode).toBe(0);

    const integrated = await cli(['task', 'integration', 'integrate', value.projectId,
      batch.batchId], value.environment);
    expect(integrated.exitCode).toBe(1);
    expect(JSON.parse(integrated.stdout)).toMatchObject({ state: 'STALE',
      outcomeCode: 'MEMBER_EVIDENCE_MOVED', integratedCommit: null });
    expect(await git(value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(devBefore);
    await cli(['stop'], value.environment);
  }, 180_000);

  test('marks the batch STALE when dev moved before the integration, and cancels a fresh batch',
    async () => {
      const { fixture: value, members } = await twoMembers();
      const created = await cli(['task', 'integration', 'create', value.projectId,
        ...memberFlags(members)], value.environment);
      const batch = JSON.parse(created.stdout) as { readonly batchId: string };

      // `dev` moves exactly like a user's own commit to the long-lived branch. ADR-0056: that branch
      // is the dev clone's, and it is checked out there, so the commit happens in the dev clone.
      await Bun.write(join(value.devRepo, 'dev-moved.txt'), 'dev moved\n');
      await git(value.devRepo, ['add', 'dev-moved.txt']);
      await git(value.devRepo, ['commit', '-q', '-m', 'dev moves on']);
      const devMoved = await git(value.devRepo, ['rev-parse', 'HEAD']);

      const integrated = await cli(['task', 'integration', 'integrate', value.projectId,
        batch.batchId], value.environment);
      expect(integrated.exitCode).toBe(1);
      expect(JSON.parse(integrated.stdout)).toMatchObject({ state: 'STALE',
        outcomeCode: 'DEV_REF_MOVED', integratedCommit: null });
      expect(await git(value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(devMoved);

      // The stale batch is terminal, so the members can be composed again; cancelling that fresh
      // batch is a zero-confirmation terminal verdict that moves no ref.
      const fresh = await cli(['task', 'integration', 'create', value.projectId,
        ...memberFlags(members)], value.environment);
      expect(fresh.exitCode).toBe(0);
      const freshBatch = JSON.parse(fresh.stdout) as { readonly batchId: string;
        readonly devCommit: string };
      expect(freshBatch.devCommit).toBe(devMoved);
      const cancelled = await cli(['task', 'integration', 'cancel', value.projectId,
        freshBatch.batchId, '--reason', 'not needed any more'], value.environment);
      expect(cancelled.exitCode).toBe(0);
      expect(JSON.parse(cancelled.stdout)).toMatchObject({ state: 'CANCELLED',
        outcomeCode: 'CANCELLED_BY_USER', integratedCommit: null });
      expect(await git(value.devRepo, ['rev-parse', 'refs/heads/dev'])).toBe(devMoved);
      // Cancelling again reports the recorded verdict instead of inventing a second one.
      const again = await cli(['task', 'integration', 'cancel', value.projectId, freshBatch.batchId],
        value.environment);
      expect(again.exitCode).toBe(0);
      expect(JSON.parse(again.stdout)).toMatchObject({ state: 'CANCELLED' });
      await cli(['stop'], value.environment);
    }, 180_000);

  test('refuses a malformed member list as a usage error', async () => {
    const value = await fixture();
    const missing = await cli(['task', 'integration', 'create', value.projectId],
      value.environment);
    expect(missing.exitCode).toBe(2);
    const malformed = await cli(['task', 'integration', 'create', value.projectId,
      '--member', 'not-a-task-id'], value.environment);
    expect(malformed.exitCode).toBe(2);
    await cli(['stop'], value.environment);
  }, 180_000);
});
