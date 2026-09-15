import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';
import { provisionDevClone } from './support/agent-fixture.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

/**
 * Every fixture's Runtime home is reclaimed after each test, including a test that failed before
 * it reached its own stop: a Runtime whose temp home was deleted can no longer be reached by any
 * client, so leaking one would leave an unkillable orphan behind.
 */
afterEach(async () => { await reclaimTestResources(); });

function temporaryDirectory(prefix: string): string {
  // Canonical paths: the Runtime records the dev clone as `realpath` resolves it, and a comparison
  // against a `/var`-vs-`/private/var` spelling would be a test artifact, not a product fact.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
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
    // A local `file:` dependency, so `bun install` produces a real lockfile offline. The dev
    // full-suite evidence binds that lockfile's digest (ADR-0039), and a fixture with no lockfile
    // could not exercise the binding at all.
    dependencies: { 'local-dep': 'file:./local-dep' },
  }, null, 2)}\n`);
  mkdirSync(join(repository, 'local-dep'), { recursive: true });
  await Bun.write(join(repository, 'local-dep', 'package.json'),
    `${JSON.stringify({ name: 'local-dep', version: '1.0.0' }, null, 2)}\n`);
  const installed = Bun.spawnSync({
    cmd: ['bun', 'install'], cwd: repository, stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '' },
  });
  if (installed.exitCode !== 0) {
    throw new Error(`bun install failed in the fixture: ${installed.stderr.toString()}`);
  }
  await git(repository, ['add', 'package.json', 'local-dep', 'bun.lock']);
  await git(repository, ['commit', '-q', '-m', 'checkout scripts']);
}

async function fixture(options: { readonly failingStep?: string } = {}): Promise<{
  readonly environment: Record<string, string>;
  readonly repository: string;
  readonly projectId: string;
  readonly mainCommit: string;
  /** A local bare repository; the promotion's only push target in these tests. */
  readonly remote: string;
  /** The second clone of that remote, recorded as the project's dev clone (ADR-0047 D05). */
  readonly devClone: string;
  /** The clone the project is trusted with, and where the integration advances `dev` (ADR-0056). */
  readonly devRepo: string;
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
  // `bun install --frozen-lockfile` is one of the recorded promotion post-steps and runs for real,
  // so the fixture must ignore what it installs to stay a clean worktree.
  await Bun.write(join(repository, '.gitignore'), 'node_modules\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  await writeCheckoutScripts(repository, options.failingStep);
  const mainCommit = await git(repository, ['rev-parse', 'refs/heads/main']);
  // ADR-0009: the long-lived dev branch is the workspace baseline and the integration target. It
  // starts at main's tip, so the Task result (and therefore the promoted commit) descends from the
  // expected main commit and the promotion is a fast-forward.
  await git(repository, ['branch', 'dev']);
  // ADR-0056: every dev fact comes from a second clone of the same origin that sits on
  // `dev`; the project is trusted with it explicitly.
  const devRepo = await provisionDevClone({ repository: repository });

  const stubPath = join(tools, 'stub-pi.ts');
  const shimPath = join(tools, 'pi');
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);

  // ADR-0048 D01: the main checkout and the dev clone are two independent clones of one origin.
  // Both `main` and `dev` are long-lived branches on that origin; every push in this file goes to
  // this local bare repository, never to a real GitHub repository.
  const remote = temporaryDirectory('codeestra-promotion-remote-');
  await git(remote, ['init', '--bare', '-b', 'main']);
  // Both clones are re-pointed at this bare repository, so they really are clones of one origin
  // (ADR-0056 compares them) and the promotion's only push target is this local remote.
  await git(repository, ['remote', 'set-url', 'origin', remote]);
  await git(devRepo, ['remote', 'set-url', 'origin', remote]);
  await git(repository, ['push', '-q', 'origin', 'refs/heads/main:refs/heads/main']);
  await git(repository, ['push', '-q', 'origin', 'refs/heads/dev:refs/heads/dev']);
  // The recorded dev clone is the fixture's own: ADR-0056 puts the integrated candidate there, so no
  // second clone and no fetch step are needed to model "the candidate is in the dev clone".
  const devClone = devRepo;

  const environment = {
    CODEESTRA_HOME: home,
    CODEESTRA_UI_DIST: assets,
    CODEESTRA_PI_EXECUTABLE: shimPath,
  };
  const opened = await cli(['open', repository, '--dev-repo', devRepo, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  // The dev clone is an explicit input to trust, and the command face verifies it: this is the
  // recorded fact a promotion needs before it may push anything (ADR-0047 D05).
  const trusted = await cli(['project', 'trust', repository, '--dev-repo', devClone, '--yes'],
    environment);
  expect(trusted.exitCode).toBe(0);
  // `project trust` prints the identity, the policy and the result; `project list` is the one
  // machine-readable document that shows what was actually recorded.
  const listed = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly devRepoPath: string | null }[];
  expect(listed[0]?.devRepoPath).toBe(devClone);
  return { environment, repository, projectId: projects[0]?.id as string, mainCommit,
    remote, devClone, devRepo };
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


/**
 * Drives one Task to an INTEGRATED dev commit through the CLI only, then prepares a promotion for
 * exactly that integration batch.
 */
async function integratedTask(options: { readonly failingStep?: string;
  readonly withoutFullSuiteEvidence?: boolean } = {}): Promise<{
  readonly environment: Record<string, string>;
  readonly repository: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly batchId: string;
  readonly resultCommit: string;
  readonly mainCommit: string;
  readonly remote: string;
  readonly devClone: string;
  readonly devRepo: string;
}> {
  const { environment, repository, projectId, mainCommit, remote, devClone, devRepo } =
    await fixture(options);
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
  if (options.withoutFullSuiteEvidence !== true) {
    // ADR-0038 D03: the full suite must be observed passing on the exact integrated dev commit
    // before any promotion of it can be prepared.
    const fullSuite = await cli(['promotion', 'full-suite', 'run', projectId,
      '--dev-commit', resultCommit], environment);
    expect(fullSuite.exitCode).toBe(0);
    expect(JSON.parse(fullSuite.stdout) as { readonly state: string })
      .toMatchObject({ state: 'PASSED' });
  }
  return { environment, repository, projectId, taskId, mainCommit, remote, devClone, devRepo,
    batchId: batches[0]?.batchId as string, resultCommit };
}

interface PromotionPayload {
  readonly promotionId: string;
  readonly state: string;
  /** Which pair of facts the record states; `COMPLETE` is the only finished one (ADR-0047 D03). */
  readonly phase: 'READY_TO_PUSH' | 'AWAITING_PULL' | 'RESTART_PENDING' | 'MAIN_PUSH_PENDING'
    | 'COMPLETE' | 'REFUSED';
  readonly outcomeCode: string | null;
  readonly candidateCommit: string;
  readonly expectedMainCommit: string;
  readonly promotedCommit: string | null;
  readonly mainWorktreePath: string | null;
  readonly devRepoPath: string | null;
  readonly remoteDevCommit: string | null;
  readonly remoteMainCommit: string | null;
  readonly restart: { readonly runtimeStatus: string | null; readonly uiRunning: boolean | null;
    readonly steps: readonly { readonly id: string; readonly exitCode: number | null }[] } | null;
}
describe('codeestra promotion', () => {
  test('pushes to the remote dev branch, waits for the pull, then restarts and publishes main', async () => {
    const integrated = await integratedTask();
    const { environment, repository, projectId, mainCommit, resultCommit, batchId, remote,
      devClone } = integrated;
    try {
      const prepared = await cli(['promotion', 'prepare', projectId, batchId, resultCommit, mainCommit],
        environment);
      expect(prepared.exitCode).toBe(0);
      expect(prepared.stderr).toBe('');
      const plan = JSON.parse(prepared.stdout) as PromotionPayload;
      expect(plan).toMatchObject({ state: 'CREATED', phase: 'READY_TO_PUSH',
        candidateCommit: resultCommit, expectedMainCommit: mainCommit, promotedCommit: null,
        devRepoPath: devClone, remoteDevCommit: null });
      // Preparing writes nothing to Git and nothing to the remote.
      expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(mainCommit);
      expect(await git(remote, ['rev-parse', 'refs/heads/dev'])).toBe(mainCommit);

      // ADR-0047 D03: the push is one distinct fact. The command face reports "pushed, awaiting
      // pull" with its own exit code (3), and does not run or record a single restart step.
      const pushed = await cli(['promotion', 'promote', projectId, plan.promotionId, '--json'],
        environment);
      expect(pushed.exitCode).toBe(3);
      expect(pushed.stderr).toContain('git merge --ff-only origin/dev');
      const awaiting = JSON.parse(pushed.stdout) as PromotionPayload;
      expect(awaiting).toMatchObject({ state: 'PROMOTING', phase: 'AWAITING_PULL',
        remoteDevCommit: resultCommit, promotedCommit: null, remoteMainCommit: null });
      expect(awaiting.restart).toBeNull();
      expect(awaiting.mainWorktreePath).toBeNull();
      // Only the remote dev branch moved: the main checkout is untouched.
      expect(await git(remote, ['rev-parse', 'refs/heads/dev'])).toBe(resultCommit);
      expect(await git(remote, ['rev-parse', 'refs/heads/main'])).toBe(mainCommit);
      expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(mainCommit);

      // Running the same command again while the pull has not happened is still "awaiting pull":
      // no second push, no restart, no completion.
      const again = await cli(['promotion', 'promote', projectId, plan.promotionId, '--json'],
        environment);
      expect(again.exitCode).toBe(3);
      expect(JSON.parse(again.stdout) as PromotionPayload)
        .toMatchObject({ phase: 'AWAITING_PULL', remoteMainCommit: null });

      // The pull is the user's explicit step in the main checkout (AGENTS.md): the product never
      // performs it, which is why this test does.
      await git(repository, ['fetch', '-q', 'origin']);
      await git(repository, ['merge', '--ff-only', '-q', 'origin/dev']);
      expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(resultCommit);

      const promoted = await cli(['promotion', 'promote', projectId, plan.promotionId, '--json'],
        environment);
      expect(promoted.exitCode).toBe(0);
      const record = JSON.parse(promoted.stdout) as PromotionPayload;
      expect(record).toMatchObject({ state: 'SUCCEEDED', phase: 'COMPLETE',
        outcomeCode: 'PROMOTED', promotedCommit: resultCommit, remoteMainCommit: resultCommit });
      // The whole recorded plan ran, in the recorded order, in the main worktree.
      expect(record.restart?.steps.map((step) => [step.id, step.exitCode])).toEqual([
        ['install', 0], ['build-ui', 0], ['stop', 0], ['status', 0],
      ]);
      expect(record.restart?.runtimeStatus).toBe('READY');
      // uiRunning is recorded as an observed fact, not required for success.
      expect(record.restart?.uiRunning).toBe(false);

      // The remote is the source of truth: both long-lived branches are at the candidate, the
      // checkout followed, and the post-step really ran there.
      expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(resultCommit);
      expect(await git(repository, ['rev-parse', 'HEAD'])).toBe(resultCommit);
      expect(await git(repository, ['status', '--porcelain'])).toBe('');
      expect(await git(remote, ['rev-parse', 'refs/heads/main'])).toBe(resultCommit);
      expect(await git(remote, ['rev-parse', 'refs/heads/dev'])).toBe(resultCommit);
      expect(await Bun.file(join(repository, 'agent-output.txt')).text()).toBe('work\n');

      // The Runtime came back after the stop, and the promotion record survives it.
      const after = await cli(['status'], environment);
      expect(after.exitCode).toBe(0);
      const read = JSON.parse((await cli(['promotion', 'get', projectId, plan.promotionId],
        environment)).stdout) as PromotionPayload;
      expect(read).toMatchObject({ state: 'SUCCEEDED', outcomeCode: 'PROMOTED' });
      const listed = JSON.parse((await cli(['promotion', 'list', projectId], environment)).stdout) as
        readonly PromotionPayload[];
      expect(listed).toHaveLength(1);
      expect(listed[0]?.promotionId).toBe(plan.promotionId);
    } finally {
      await cli(['stop'], environment);
    }
  }, 300_000);

  test('reports a failed post-step without publishing main and without claiming a restart', async () => {
    const integrated = await integratedTask({ failingStep: 'build-ui' });
    const { environment, repository, projectId, mainCommit, resultCommit, batchId, remote } =
      integrated;
    try {
      const plan = JSON.parse((await cli(['promotion', 'prepare', projectId, batchId, resultCommit,
        mainCommit], environment)).stdout) as PromotionPayload;
      expect((await cli(['promotion', 'promote', projectId, plan.promotionId], environment)).exitCode)
        .toBe(3);
      await git(repository, ['fetch', '-q', 'origin']);
      await git(repository, ['merge', '--ff-only', '-q', 'origin/dev']);

      const promoted = await cli(['promotion', 'promote', projectId, plan.promotionId], environment);
      expect(promoted.exitCode).toBe(1);
      expect(promoted.stderr).toContain('build-ui');
      const record = JSON.parse((await cli(['promotion', 'get', projectId, plan.promotionId],
        environment)).stdout) as PromotionPayload;
      expect(record).toMatchObject({ state: 'FAILED', outcomeCode: 'RESTART_STEP_FAILED',
        promotedCommit: resultCommit, remoteMainCommit: null });
      // The steps after the failure were reported as not run rather than silently omitted.
      expect(record.restart?.steps.map((step) => [step.id, step.exitCode])).toEqual([
        ['install', 0], ['build-ui', 1], ['stop', null], ['status', null],
      ]);
      // Nothing is rolled back and nothing is published: the main checkout is on the candidate, the
      // remote main branch is not, and the Runtime was never stopped.
      expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(resultCommit);
      expect(await git(remote, ['rev-parse', 'refs/heads/main'])).toBe(mainCommit);
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
  }, 300_000);

  test('keeps the STRICT approval gate on the CLI without a second confirmation', async () => {
    const integrated = await integratedTask();
    const { environment, repository, projectId, mainCommit, resultCommit, batchId, remote } =
      integrated;
    try {
      expect((await cli(['permission', 'set', 'strict'], environment)).exitCode).toBe(0);
      const plan = JSON.parse((await cli(['promotion', 'prepare', projectId, batchId, resultCommit,
        mainCommit], environment)).stdout) as PromotionPayload;
      // STRICT without an approval of the exact triple: refused before anything is pushed.
      const refused = await cli(['promotion', 'promote', projectId, plan.promotionId], environment);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('PROMOTION_NOT_APPROVED');
      expect(await git(remote, ['rev-parse', 'refs/heads/dev'])).toBe(mainCommit);

      const approved = await cli(['promotion', 'approve', projectId, plan.promotionId], environment);
      expect(approved.exitCode).toBe(0);
      expect(JSON.parse(approved.stdout) as PromotionPayload)
        .toMatchObject({ state: 'AWAITING_APPROVAL' });
      // The approval is the one gate: a single explicit step, recorded against the fixed triple.
      const promoted = await cli(['promotion', 'promote', projectId, plan.promotionId], environment);
      expect(promoted.exitCode).toBe(3);
      const record = JSON.parse((await cli(['promotion', 'get', projectId, plan.promotionId],
        environment)).stdout) as PromotionPayload;
      expect(record).toMatchObject({ state: 'PROMOTING', phase: 'AWAITING_PULL',
        candidateCommit: resultCommit, remoteDevCommit: resultCommit });

      // Abandoning a pushed-but-unpulled promotion keeps the observed ref state: the remote dev
      // branch is a fact the user resolves, never something the record pretends did not happen.
      const abandoned = await cli(['promotion', 'abandon', projectId, plan.promotionId,
        '--reason', 'postponed to the next window'], environment);
      expect(abandoned.exitCode).toBe(0);
      expect(JSON.parse(abandoned.stdout) as PromotionPayload)
        .toMatchObject({ state: 'FAILED', outcomeCode: 'ABANDONED', promotedCommit: null,
          remoteDevCommit: resultCommit });
      expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(mainCommit);
    } finally {
      await cli(['permission', 'set', 'full'], environment);
      await cli(['stop'], environment);
    }
  }, 300_000);

  test('refuses a promotion whose fixed evidence does not match Git, and a dev clone that is not one', async () => {
    const integrated = await integratedTask();
    const { environment, repository, projectId, mainCommit, resultCommit, batchId, remote } =
      integrated;
    try {
      const wrongMain = await cli(['promotion', 'prepare', projectId, batchId, resultCommit,
        'f'.repeat(40)], environment);
      expect(wrongMain.exitCode).toBe(1);
      expect(wrongMain.stderr).toContain('MAIN_REF_MOVED');
      const wrongDev = await cli(['promotion', 'prepare', projectId, batchId, mainCommit, mainCommit],
        environment);
      expect(wrongDev.exitCode).toBe(1);
      expect(wrongDev.stderr).toContain('PROMOTION_EVIDENCE_MISMATCH');
      // Neither refusal created a promotion or touched a ref, local or remote.
      expect(JSON.parse((await cli(['promotion', 'list', projectId], environment)).stdout)).toEqual([]);
      expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(mainCommit);
      expect(await git(integrated.devClone, ['rev-parse', 'refs/heads/dev'])).toBe(resultCommit);
      expect(await git(remote, ['rev-parse', 'refs/heads/dev'])).toBe(mainCommit);

      // The dev clone is verified as an explicit input: the main checkout itself is refused with a
      // stable code, and nothing is recorded in its place.
      const inspected = await cli(['project', 'inspect', repository, '--dev-repo', repository],
        environment);
      expect(inspected.exitCode).toBe(0);
      expect(JSON.parse(inspected.stdout) as {
        readonly devRepoPath: { readonly verified: boolean; readonly code: string | null } })
        .toMatchObject({ devRepoPath: { verified: false, code: 'DEV_REPO_NOT_SEPARATE' } });
      const trusted = await cli(['project', 'trust', repository, '--dev-repo', repository, '--yes'],
        environment);
      expect(trusted.exitCode).toBe(1);
      expect(trusted.stderr).toContain('DEV_REPO_NOT_SEPARATE');
      // The previously verified dev clone is still the recorded one.
      const listed = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
        readonly { readonly devRepoPath: string | null }[];
      expect(listed[0]?.devRepoPath).toBe(integrated.devClone);
    } finally {
      await cli(['stop'], environment);
    }
  }, 300_000);

  test('refuses a promotion with no full-suite evidence of the fixed dev commit', async () => {
    const integrated = await integratedTask({ withoutFullSuiteEvidence: true });
    const { environment, repository, projectId, mainCommit, resultCommit, batchId, remote } =
      integrated;
    try {
      const listed = await cli(['promotion', 'full-suite', 'list', projectId], environment);
      expect(listed.exitCode).toBe(0);
      expect(JSON.parse(listed.stdout)).toEqual([]);

      const prepared = await cli(['promotion', 'prepare', projectId, batchId, resultCommit,
        mainCommit], environment);
      expect(prepared.exitCode).toBe(1);
      expect(prepared.stderr).toContain('DEV_FULL_SUITE_EVIDENCE_MISSING');
      expect(JSON.parse((await cli(['promotion', 'list', projectId], environment)).stdout)).toEqual([]);
      expect(await git(repository, ['rev-parse', 'refs/heads/main'])).toBe(mainCommit);
      expect(await git(remote, ['rev-parse', 'refs/heads/dev'])).toBe(mainCommit);
    } finally {
      await cli(['stop'], environment);
    }
  }, 300_000);

  test('records the three bindings and refuses to push when the policy on main changes', async () => {
    const integrated = await integratedTask();
    const { environment, repository, projectId, mainCommit, resultCommit, batchId, remote } =
      integrated;
    try {
      const evidence = JSON.parse((await cli(['promotion', 'full-suite', 'list', projectId],
        environment)).stdout) as readonly {
          readonly evidenceId: string; readonly devCommit: string; readonly state: string;
          readonly policyVersion: string; readonly policyDigest: string;
          readonly lockfilePath: string; readonly lockfileDigest: string }[];
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ devCommit: resultCommit, state: 'PASSED',
        policyVersion: 'verification-policy-v1', lockfilePath: 'bun.lock' });
      expect(evidence[0]?.policyDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(evidence[0]?.lockfileDigest).toMatch(/^[0-9a-f]{64}$/);

      const plan = JSON.parse((await cli(['promotion', 'prepare', projectId, batchId, resultCommit,
        mainCommit], environment)).stdout) as PromotionPayload & {
          readonly fullSuite: { readonly evidenceId: string; readonly devCommit: string } | null };
      expect(plan.state).toBe('CREATED');
      expect(plan.fullSuite).toMatchObject({ evidenceId: evidence[0]?.evidenceId,
        devCommit: resultCommit });

      // The full suite's command set is the project policy read at the main ref, so editing it
      // there is exactly the change that must invalidate the evidence.
      await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'),
        `${JSON.stringify({ version: 1, commands: [{ id: 'check', argv: ['echo', 'changed'],
          cwd: '.', timeoutSeconds: 60 }] })}\n`);
      await git(repository, ['add', '.codeestra/policies/verification.json']);
      await git(repository, ['commit', '-q', '-m', 'different judging commands']);

      const promoted = await cli(['promotion', 'promote', projectId, plan.promotionId], environment);
      expect(promoted.exitCode).toBe(1);
      expect(promoted.stderr).toContain('DEV_FULL_SUITE_EVIDENCE_STALE');
      const read = JSON.parse((await cli(['promotion', 'get', projectId, plan.promotionId],
        environment)).stdout) as PromotionPayload;
      expect(read).toMatchObject({ state: 'STALE', outcomeCode: 'DEV_FULL_SUITE_EVIDENCE_STALE',
        promotedCommit: null, remoteDevCommit: null });
      // Nothing was pushed anywhere: the policy commit is on main and dev is still the candidate.
      expect(await git(integrated.devClone, ['rev-parse', 'refs/heads/dev'])).toBe(resultCommit);
      expect(await git(remote, ['rev-parse', 'refs/heads/dev'])).toBe(mainCommit);
    } finally {
      await cli(['stop'], environment);
    }
  }, 300_000);
});
