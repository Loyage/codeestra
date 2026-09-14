import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

/**
 * Every fixture's Runtime home is reclaimed after each test, including a test that failed before
 * it reached its own stop: a Runtime whose temp home was deleted can no longer be reached by any
 * client, so leaking one would leave an unkillable orphan behind.
 */
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
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Promotion Test',
      GIT_AUTHOR_EMAIL: 'promotion@example.invalid', GIT_COMMITTER_NAME: 'Promotion Test',
      GIT_COMMITTER_EMAIL: 'promotion@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
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
const sessionFile = join(sessionDir, 'promotion-session.jsonl');
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
        sessionId: 'promotion-session', sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      writeFileSync(join(process.cwd(), 'agent-output.txt'), 'work\\n');
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'promotion-session', timestamp: '2026-09-13T09:00:00.000Z',
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

/**
 * The main worktree of a Codeestra checkout: it carries the `build:ui` script and a `codeestra`
 * script that runs this repository's CLI, so the recorded promotion post-steps
 * (`bun install --frozen-lockfile`, `bun run build:ui`, `bun run codeestra stop|status`) are the
 * real commands, executed for real, in a real worktree. Only the project contents are temporary.
 */
async function writeCheckoutScripts(repository: string, failingStep?: string): Promise<void> {
  await Bun.write(join(repository, 'package.json'), `${JSON.stringify({
    name: 'promotion-fixture-checkout',
    private: true,
    scripts: {
      'build:ui': failingStep === 'build-ui' ? 'false' : 'echo built',
      codeestra: `${process.execPath} ${cliEntry}`,
    },
  }, null, 2)}\n`);
  await git(repository, ['add', 'package.json']);
  await git(repository, ['commit', '-q', '-m', 'checkout scripts']);
}

async function fixture(options: { readonly failingStep?: string } = {}): Promise<{
  readonly environment: Record<string, string>;
  readonly repository: string;
  readonly projectId: string;
  readonly mainCommit: string;
}> {
  const repository = temporaryDirectory('codeestra-promotion-repo-');
  const home = temporaryDirectory('codeestra-promotion-home-');
  const tools = temporaryDirectory('codeestra-promotion-tools-');
  const assets = temporaryDirectory('codeestra-promotion-assets-');
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
  await writeCheckoutScripts(repository, options.failingStep);
  const mainCommit = await git(repository, ['rev-parse', 'refs/heads/main']);
  // ADR-0009: the long-lived dev branch is the workspace baseline and the integration target. It
  // starts at main's tip, so the Task result (and therefore the promoted commit) descends from the
  // expected main commit and the promotion is a fast-forward.
  await git(repository, ['branch', 'dev']);

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
  const opened = await cli(['open', repository, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  return { environment, repository, projectId: projects[0]?.id as string, mainCommit };
}

interface StatusPayload {
  readonly task: { readonly id: string; readonly state: string; readonly version: number };
  readonly executions: readonly { readonly session: { readonly state: string } | null }[];
}

async function status(
  environment: Record<string, string>,
  projectId: string,
  taskId: string,
): Promise<StatusPayload> {
  const listed = await cli(['task', 'status', projectId, taskId], environment);
  expect(listed.exitCode).toBe(0);
  return JSON.parse(listed.stdout) as StatusPayload;
}

interface PromotionPayload {
  readonly promotionId: string;
  readonly state: string;
  readonly outcomeCode: string | null;
  readonly candidateCommit: string;
  readonly expectedMainCommit: string;
  readonly promotedCommit: string | null;
  readonly mainWorktreePath: string | null;
  readonly restart: { readonly runtimeStatus: string | null; readonly uiRunning: boolean | null;
    readonly steps: readonly { readonly id: string; readonly exitCode: number | null }[] } | null;
}

/**
 * Drives one Task to an INTEGRATED dev commit through the CLI only, then prepares a promotion for
 * exactly that integration batch.
 */
async function integratedTask(options: { readonly failingStep?: string } = {}): Promise<{
  readonly environment: Record<string, string>;
  readonly repository: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly batchId: string;
  readonly resultCommit: string;
  readonly mainCommit: string;
}> {
  const { environment, repository, projectId, mainCommit } = await fixture(options);
  const created = JSON.parse((await cli(['task', 'create', projectId, 'Write a file'],
    environment)).stdout) as { readonly id: string };
  const taskId = created.id;
  expect((await cli(['task', 'submit', projectId, taskId, '0'], environment)).exitCode).toBe(0);
  expect((await cli(['task', 'run', projectId, taskId, '1'], environment)).exitCode).toBe(0);
  const deadline = Date.now() + 30_000;
  let exited = false;
  while (Date.now() < deadline) {
    if ((await status(environment, projectId, taskId)).executions[0]?.session?.state === 'EXITED') {
      exited = true;
      break;
    }
    await Bun.sleep(100);
  }
  expect(exited).toBe(true);
  const captured = await cli(['task', 'result', 'capture', projectId, taskId], environment);
  expect(captured.exitCode).toBe(0);
  const resultCommit = (JSON.parse(captured.stdout) as { readonly resultCommit: string }).resultCommit;
  expect((await cli(['task', 'verify', projectId, taskId], environment)).exitCode).toBe(0);
  const version = (await status(environment, projectId, taskId)).task.version;
  expect((await cli(['task', 'integrate', projectId, taskId, String(version)], environment)).exitCode)
    .toBe(0);
  const batches = JSON.parse((await cli(['task', 'integration', 'list', projectId, taskId],
    environment)).stdout) as readonly { readonly batchId: string; readonly state: string }[];
  expect(batches[0]?.state).toBe('INTEGRATED');
  return { environment, repository, projectId, taskId, mainCommit,
    batchId: batches[0]?.batchId as string, resultCommit };
}

describe('codeestra promotion', () => {
  test('promotes from the CLI, runs the recorded post-steps and only then reports success', async () => {
    const integrated = await integratedTask();
    const { environment, repository, projectId, mainCommit, resultCommit, batchId } = integrated;
    try {
      const prepared = await cli(['promotion', 'prepare', projectId, batchId, resultCommit, mainCommit],
        environment);
      expect(prepared.exitCode).toBe(0);
      expect(prepared.stderr).toBe('');
      const plan = JSON.parse(prepared.stdout) as PromotionPayload;
      expect(plan).toMatchObject({ state: 'CREATED', candidateCommit: resultCommit,
        expectedMainCommit: mainCommit, promotedCommit: null });
      // Preparing writes nothing to Git.
      expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(mainCommit);
      expect(await git(repository, ['rev-parse', 'refs/heads/dev'])).toBe(resultCommit);

      const promoted = await cli(['promotion', 'promote', projectId, plan.promotionId, '--json'],
        environment);
      expect(promoted.exitCode).toBe(0);
      const record = JSON.parse(promoted.stdout) as PromotionPayload;
      expect(record).toMatchObject({ state: 'SUCCEEDED', outcomeCode: 'RESTARTED',
        promotedCommit: resultCommit });
      // The whole recorded plan ran, in the recorded order, in the main worktree.
      expect(record.restart?.steps.map((step) => [step.id, step.exitCode])).toEqual([
        ['install', 0], ['build-ui', 0], ['stop', 0], ['status', 0],
      ]);
      expect(record.restart?.runtimeStatus).toBe('READY');
      // uiRunning is recorded as an observed fact, not required for success.
      expect(record.restart?.uiRunning).toBe(false);

      // main moved to the verified dev commit, dev did not move, and the checkout followed.
      expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(resultCommit);
      expect(await git(repository, ['rev-parse', 'refs/heads/dev'])).toBe(resultCommit);
      expect(await git(repository, ['rev-parse', 'HEAD'])).toBe(resultCommit);
      expect(await git(repository, ['status', '--porcelain'])).toBe('');
      // The post-step really ran in the main worktree: bun install left an install state behind.
      expect(await Bun.file(join(repository, 'agent-output.txt')).text()).toBe('work\n');

      // The Runtime came back after the stop, and the promotion record survives it.
      const after = await cli(['status'], environment);
      expect(after.exitCode).toBe(0);
      const read = JSON.parse((await cli(['promotion', 'get', projectId, plan.promotionId],
        environment)).stdout) as PromotionPayload;
      expect(read).toMatchObject({ state: 'SUCCEEDED', outcomeCode: 'RESTARTED' });
      const listed = JSON.parse((await cli(['promotion', 'list', projectId], environment)).stdout) as
        readonly PromotionPayload[];
      expect(listed).toHaveLength(1);
      expect(listed[0]?.promotionId).toBe(plan.promotionId);
    } finally {
      await cli(['stop'], environment);
    }
  }, 180_000);

  test('reports a failed post-step without rolling main back and without claiming a restart', async () => {
    const integrated = await integratedTask({ failingStep: 'build-ui' });
    const { environment, repository, projectId, mainCommit, resultCommit, batchId } = integrated;
    try {
      const plan = JSON.parse((await cli(['promotion', 'prepare', projectId, batchId, resultCommit,
        mainCommit], environment)).stdout) as PromotionPayload;
      const promoted = await cli(['promotion', 'promote', projectId, plan.promotionId], environment);
      expect(promoted.exitCode).toBe(1);
      expect(promoted.stderr).toContain('build-ui');
      const record = JSON.parse((await cli(['promotion', 'get', projectId, plan.promotionId],
        environment)).stdout) as PromotionPayload;
      expect(record).toMatchObject({ state: 'FAILED', outcomeCode: 'RESTART_STEP_FAILED',
        promotedCommit: resultCommit });
      // The steps after the failure were reported as not run rather than silently omitted.
      expect(record.restart?.steps.map((step) => [step.id, step.exitCode])).toEqual([
        ['install', 0], ['build-ui', 1], ['stop', null], ['status', null],
      ]);
      // Nothing is rolled back: main is at the promoted commit and the Runtime was never stopped.
      expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(resultCommit);
      expect((await cli(['status'], environment)).exitCode).toBe(0);

      // The failing restart is already terminal, so abandoning it is refused instead of silently
      // rewriting a finished record.
      const abandoned = await cli(['promotion', 'abandon', projectId, plan.promotionId,
        '--reason', 'the checkout build script was broken'], environment);
      expect(abandoned.exitCode).toBe(1);
      expect(abandoned.stderr).toContain('PROMOTION_FINISHED');
      const stillFailed = JSON.parse((await cli(['promotion', 'get', projectId, plan.promotionId],
        environment)).stdout) as PromotionPayload;
      expect(stillFailed).toMatchObject({ state: 'FAILED', outcomeCode: 'RESTART_STEP_FAILED' });
    } finally {
      await cli(['stop'], environment);
    }
  }, 180_000);

  test('keeps the STRICT approval gate on the CLI without a second confirmation', async () => {
    const integrated = await integratedTask();
    const { environment, repository, projectId, mainCommit, resultCommit, batchId } = integrated;
    try {
      expect((await cli(['permission', 'set', 'strict'], environment)).exitCode).toBe(0);
      const plan = JSON.parse((await cli(['promotion', 'prepare', projectId, batchId, resultCommit,
        mainCommit], environment)).stdout) as PromotionPayload;
      // STRICT without an approval of the exact triple: refused before any ref is touched.
      const refused = await cli(['promotion', 'promote', projectId, plan.promotionId], environment);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('PROMOTION_NOT_APPROVED');
      expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(mainCommit);

      const approved = await cli(['promotion', 'approve', projectId, plan.promotionId], environment);
      expect(approved.exitCode).toBe(0);
      expect(JSON.parse(approved.stdout) as PromotionPayload)
        .toMatchObject({ state: 'AWAITING_APPROVAL' });
      // The approval is the one gate: a single explicit step, recorded against the fixed triple.
      const read = JSON.parse((await cli(['promotion', 'get', projectId, plan.promotionId],
        environment)).stdout) as PromotionPayload;
      expect(read).toMatchObject({ state: 'AWAITING_APPROVAL', candidateCommit: resultCommit });

      // Abandoning an approved-but-unpromoted record is allowed and keeps the observed ref state.
      const abandoned = await cli(['promotion', 'abandon', projectId, plan.promotionId,
        '--reason', 'postponed to the next window'], environment);
      expect(abandoned.exitCode).toBe(0);
      expect(JSON.parse(abandoned.stdout) as PromotionPayload)
        .toMatchObject({ state: 'FAILED', outcomeCode: 'ABANDONED', promotedCommit: null });
      expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(mainCommit);
    } finally {
      await cli(['permission', 'set', 'full'], environment);
      await cli(['stop'], environment);
    }
  }, 180_000);

  test('refuses a promotion whose fixed evidence does not match Git', async () => {
    const integrated = await integratedTask();
    const { environment, repository, projectId, mainCommit, resultCommit, batchId } = integrated;
    try {
      const wrongMain = await cli(['promotion', 'prepare', projectId, batchId, resultCommit,
        'f'.repeat(40)], environment);
      expect(wrongMain.exitCode).toBe(1);
      expect(wrongMain.stderr).toContain('MAIN_REF_MOVED');
      const wrongDev = await cli(['promotion', 'prepare', projectId, batchId, mainCommit, mainCommit],
        environment);
      expect(wrongDev.exitCode).toBe(1);
      expect(wrongDev.stderr).toContain('PROMOTION_EVIDENCE_MISMATCH');
      // Neither refusal created a promotion or touched a ref.
      expect(JSON.parse((await cli(['promotion', 'list', projectId], environment)).stdout)).toEqual([]);
      expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(mainCommit);
      expect(await git(repository, ['rev-parse', 'refs/heads/dev'])).toBe(resultCommit);
    } finally {
      await cli(['stop'], environment);
    }
  }, 180_000);
});
