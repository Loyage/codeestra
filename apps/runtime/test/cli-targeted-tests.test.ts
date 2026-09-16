import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  createFixtureTaskForExplicitStart,
  runCli,
} from './support/runtime-reclamation.js';
import { provisionDevClone } from './support/agent-fixture.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

/**
 * Branch-targeted test plans through the real command face (ADR-0038 implemented by ADR-0039).
 *
 * The fixture makes the two command sets *distinguishable on purpose*: the project policy at the
 * main ref is a command that fails, so a PASSED verification can only have run the branch's own
 * recorded plan. That is what proves the Runtime consumed the plan rather than reporting a policy
 * run under a new label.
 *
 * The plan is a committed file (`.codeestra/tests.json`) but the verification consumes the
 * *recorded* plan, never the file at read time: recording is a separate, audited CLI step, so an
 * edit inside a commit cannot silently widen or narrow what a Task is judged by.
 */

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
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Layering Test',
      GIT_AUTHOR_EMAIL: 'layering@example.invalid', GIT_COMMITTER_NAME: 'Layering Test',
      GIT_COMMITTER_EMAIL: 'layering@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

/** The plan the stub commits onto the Task branch, as `.codeestra/tests.json`. */
const planFile = {
  version: 1,
  scope: 'the targeted tests this branch needs and nothing else',
  commands: [{
    id: 'targeted', argv: ['echo', 'targeted-ok'], cwd: '.', timeoutSeconds: 60,
    covers: 'the recorded plan is the command set verification runs',
  }],
};

/**
 * A protocol stub (never evidence that a real Agent integration works): it answers the Runtime's
 * RPC framing sufficiently to complete one turn, and it writes both the Task's own deliverable and
 * the branch's targeted test plan into the worktree, so the captured result commit carries a plan.
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
const sessionFile = join(sessionDir, 'layering-session.jsonl');
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
        sessionId: 'layering-session', sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      writeFileSync(join(process.cwd(), 'agent-output.txt'), 'work\\n');
      mkdirSync(join(process.cwd(), '.codeestra'), { recursive: true });
      writeFileSync(join(process.cwd(), '.codeestra', 'tests.json'),
        JSON.stringify(${JSON.stringify(planFile)}, null, 2) + '\\n');
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'layering-session', timestamp: '2026-09-13T09:00:00.000Z',
        cwd: process.cwd() }) + '\\n');
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Wrote the files.' }], stopReason: 'stop' } });
      emit({ type: 'agent_settled' });
      setTimeout(() => process.exit(0), 50);
    }
  }
}
`;

async function fixture(): Promise<{
  readonly environment: Record<string, string>;
  readonly repository: string;
  readonly projectId: string;
}> {
  const repository = temporaryDirectory('codeestra-layering-repo-');
  const home = temporaryDirectory('codeestra-layering-home-');
  const tools = temporaryDirectory('codeestra-layering-tools-');
  const assets = temporaryDirectory('codeestra-layering-assets-');
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  // A project policy that FAILS: a PASSED Task verification can therefore only have run the
  // branch's recorded targeted plan, never the fixed project policy.
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1,
    commands: [{ id: 'project-check', argv: ['false'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await Bun.write(join(repository, 'bun.lock'), '{\n  "lockfileVersion": 1\n}\n');
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
    CODEESTRA_SCHEDULE_TICK_MS: '600000',
  };
  const opened = await cli(['open', repository, '--dev-repo', devRepo, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  return { environment, repository, projectId: projects[0]?.id as string };
}

async function capturedTask(input: {
  readonly environment: Record<string, string>;
  readonly projectId: string;
}): Promise<{ readonly taskId: string; readonly resultCommit: string }> {
  await cli(['stop'], input.environment);
  const ready = await createFixtureTaskForExplicitStart({
    home: input.environment.CODEESTRA_HOME!, environment: input.environment,
    projectId: input.projectId, specification: 'Write a file', startable: true,
  });
  const taskId = ready.taskId;
  expect((await cli(['task', 'run', input.projectId, taskId, String(ready.expectedVersion)],
    input.environment)).exitCode).toBe(0);
  const deadline = Date.now() + 30_000;
  let exited = false;
  while (Date.now() < deadline) {
    const status = JSON.parse((await cli(['task', 'status', input.projectId, taskId],
      input.environment)).stdout) as {
        readonly executions: readonly { readonly session: { readonly state: string } | null }[] };
    if (status.executions[0]?.session?.state === 'EXITED') { exited = true; break; }
    await Bun.sleep(100);
  }
  expect(exited).toBe(true);
  const captured = await cli(['task', 'result', 'capture', input.projectId, taskId],
    input.environment);
  expect(captured.exitCode).toBe(0);
  return { taskId,
    resultCommit: (JSON.parse(captured.stdout) as { readonly resultCommit: string }).resultCommit };
}

interface PlanView {
  readonly planId: string;
  readonly created?: boolean;
  readonly testedCommit: string;
  readonly planDigest: string;
  readonly planLabel: string;
  readonly scope: string;
  readonly commands: readonly { readonly id: string; readonly argv: readonly string[];
    readonly cwd: string; readonly timeoutSeconds: number }[];
}

interface VerificationRunView {
  readonly verificationId: string;
  readonly state: string;
  readonly policySource: string;
  readonly planId: string | null;
  readonly planDigest: string | null;
  readonly policyLabel: string;
}

describe('branch-targeted test plans (ADR-0038 / ADR-0039)', () => {
  test('records the plan from the tested commit and runs it instead of the project policy', async () => {
    const { environment, projectId } = await fixture();
    try {
      const { taskId, resultCommit } = await capturedTask({ environment, projectId });

      // Nothing is recorded yet: the file may exist in the commit, but the Runtime has no plan.
      const before = await cli(['task', 'tests', 'show', projectId, taskId], environment);
      expect(before.exitCode).toBe(0);
      expect(JSON.parse(before.stdout)).toBeNull();
      const refused = await cli(['task', 'verify', projectId, taskId, '--policy', 'targeted'],
        environment);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('TARGETED_TEST_PLAN_NOT_RECORDED');
      // The refusal wrote no verification run.
      const empty = await cli(['task', 'verification', 'list', projectId, taskId], environment);
      expect(JSON.parse(empty.stdout)).toEqual([]);

      const recorded = await cli(['task', 'tests', 'record', projectId, taskId], environment);
      expect(recorded.exitCode).toBe(0);
      const plan = JSON.parse(recorded.stdout) as PlanView;
      expect(plan).toMatchObject({ created: true, testedCommit: resultCommit,
        scope: planFile.scope });
      expect(plan.commands).toEqual([{ id: 'targeted', argv: ['echo', 'targeted-ok'], cwd: '.',
        timeoutSeconds: 60 }]);
      expect(plan.planLabel).toBe(`targeted-test-plan-v1#${plan.planDigest.slice(0, 12)}`);

      // The identical plan replays instead of appending a second record.
      const replayed = await cli(['task', 'tests', 'record', projectId, taskId], environment);
      expect(replayed.exitCode).toBe(0);
      expect(JSON.parse(replayed.stdout)).toMatchObject({ created: false, planId: plan.planId });
      const history = await cli(['task', 'tests', 'history', projectId, taskId], environment);
      expect(JSON.parse(history.stdout)).toHaveLength(1);

      // A scope change on top of a record the caller never saw is refused (append-only + CAS).
      const stale = await cli(['task', 'tests', 'record', projectId, taskId,
        '--expected-plan-digest', 'f'.repeat(64)], environment);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr).toContain('TARGETED_TEST_PLAN_DIGEST_MISMATCH');

      // AUTO uses the recorded plan; the project policy would have failed.
      const verified = await cli(['task', 'verify', projectId, taskId], environment);
      expect(verified.exitCode).toBe(0);
      const report = JSON.parse(verified.stdout) as VerificationRunView & {
        readonly state: string; readonly policySource: string };
      expect(report).toMatchObject({ state: 'PASSED', policySource: 'TARGETED_TEST_PLAN',
        planId: plan.planId });
      expect(report.policyLabel).toBe(plan.planLabel);

      // The same Task judged by the fixed project policy really does fail, which is what makes the
      // PASSED targeted run meaningful rather than a label.
      const policyRun = await cli(['task', 'verify', projectId, taskId, '--policy', 'project'],
        environment);
      expect(policyRun.exitCode).toBe(1);
      const policyReport = JSON.parse(policyRun.stdout) as VerificationRunView;
      expect(policyReport).toMatchObject({ state: 'FAILED', policySource: 'PROJECT_POLICY',
        planId: null });

      // Both runs are readable as recorded facts, with their source spelled out.
      const runs = JSON.parse((await cli(['task', 'verification', 'list', projectId, taskId],
        environment)).stdout) as readonly VerificationRunView[];
      expect(runs.map((run) => [run.policySource, run.state]))
        .toEqual([['PROJECT_POLICY', 'FAILED'], ['TARGETED_TEST_PLAN', 'STALE']]);
      expect(runs[1]?.planId).toBe(plan.planId);
    } finally {
      await cli(['stop'], environment);
    }
  }, 240_000);

  test('refuses a plan that is absent or abbreviated instead of guessing', async () => {
    const { environment, projectId, repository } = await fixture();
    try {
      const { taskId } = await capturedTask({ environment, projectId });
      const mainTip = await git(repository, ['rev-parse', 'refs/heads/main']);
      // The commit before the Task branch carries no plan file at all: that is reported as an
      // absent plan, never as an empty one that would run nothing and pass.
      const absent = await cli(['task', 'tests', 'record', projectId, taskId,
        '--commit', mainTip], environment);
      expect(absent.exitCode).toBe(1);
      expect(absent.stderr).toContain('TARGETED_TEST_PLAN_ABSENT');
      // An abbreviated commit is refused: the plan binds one exact commit.
      const abbreviated = await cli(['task', 'tests', 'record', projectId, taskId,
        '--commit', mainTip.slice(0, 8)], environment);
      expect(abbreviated.exitCode).toBe(1);
      expect(abbreviated.stderr).toContain('INVALID_COMMIT_ID');

      const summary = await cli(['task', 'tests', 'show', projectId, taskId], environment);
      expect(JSON.parse(summary.stdout)).toBeNull();
      // Both refusals left no record behind and did not touch the repository.
      const history = await cli(['task', 'tests', 'history', projectId, taskId], environment);
      expect(JSON.parse(history.stdout)).toEqual([]);
      expect(await git(repository, ['status', '--porcelain'])).toBe('');
    } finally {
      await cli(['stop'], environment);
    }
  }, 240_000);
});
