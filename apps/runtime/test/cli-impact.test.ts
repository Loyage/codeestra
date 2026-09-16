import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';
import { taskWorkspaceName } from '@codeestra/domain';

/**
 * End-to-end evidence for `project impact` (ADR-0031) through the real CLI and the real Runtime:
 * a temporary Git repository, an independent `CODEESTRA_HOME`, and a protocol stub provider that
 * writes one file per Task worktree and then stays alive so the Task holds its resource.
 *
 * The stub proves the command face and the Git/Storage/orchestration behavior. It is never evidence
 * that a real Agent integration produces these change sets, and neither is any verdict here evidence
 * that a real model's work is conflict-free.
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
  // FOUNDATION-057: the shared runner refuses a non-temporary CODEESTRA_HOME (a test must never
  // reach the real Runtime home) and registers the home so teardown stops any Runtime it started,
  // including when an assertion fails before the test's own stop.
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Impact Test',
      GIT_AUTHOR_EMAIL: 'impact@example.invalid', GIT_COMMITTER_NAME: 'Impact Test',
      GIT_COMMITTER_EMAIL: 'impact@example.invalid' } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error('Timed out waiting for the expected state');
}

/**
 * A protocol stub, not a real provider: it writes `src/agent/<task-id>.ts` in its own working
 * directory (the Task worktree), reports the session, settles the turn, and then keeps reading
 * stdin so the Execution keeps holding its resource until the test stops it.
 */
const stubSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const sessionDirIndex = argv.indexOf('--session-dir');
const sessionDir = sessionDirIndex >= 0 ? argv[sessionDirIndex + 1] : process.cwd();
mkdirSync(sessionDir, { recursive: true });
const taskId = basename(process.cwd());
const sessionFile = join(sessionDir, 'impact-session-' + taskId + '.jsonl');
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
        sessionId: 'impact-session-' + taskId, sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      const directory = join(process.cwd(), 'src', 'agent');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, taskId + '.ts'), 'export const task = ' +
        JSON.stringify(taskId) + ';\\n');
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'impact-session-' + taskId, timestamp: '2026-09-14T09:00:00.000Z',
        cwd: process.cwd() }) + '\\n');
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Wrote the file.' }], stopReason: 'stop' } });
      emit({ type: 'agent_settled' });
    }
  }
}
`;

const impactMapping = {
  version: 1,
  importantDirectories: ['core'],
  modules: [{ id: 'core-module', paths: ['core/**'] }],
  globalResources: [
    { id: 'lockfile', kind: 'DEPENDENCY_LOCKFILE', paths: ['bun.lock'],
      consumers: { state: 'DECLARED', paths: ['package.json'] } },
  ],
};

interface RepositoryFixture {
  readonly repository: string;
  readonly tools: string;
}

async function createRepository(input: {
  readonly prefix: string;
  readonly withImpactMapping: boolean;
}): Promise<RepositoryFixture> {
  const repository = temporaryDirectory(`${input.prefix}-repo-`);
  const tools = temporaryDirectory(`${input.prefix}-tools-`);
  const assets = temporaryDirectory(`${input.prefix}-assets-`);
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  if (input.withImpactMapping) {
    await Bun.write(join(repository, '.codeestra', 'impact.json'),
      `${JSON.stringify(impactMapping, null, 2)}\n`);
  }
  await Bun.write(join(repository, 'package.json'), '{"name":"fixture","private":true}\n');
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  await git(repository, ['branch', 'dev']);
  // ADR-0056: every dev fact comes from a second clone of the same origin that sits on
  // `dev`; the project is trusted with it explicitly.

  const stubPath = join(tools, 'stub-pi.ts');
  const shimPath = join(tools, 'pi');
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);
  return { repository, tools: shimPath };
}

interface TaskPayload {
  readonly id: string;
  readonly displayNumber: number;
  readonly namingTitle: string | null;
  readonly state: string;
  readonly version: number;
}

/**
 * The worktree directory name of a Task, derived by the same rule the Runtime uses (ADR-0065 D03):
 * `<displayNumber>-<namingTitle>`, or the internal identity for a Task that predates the titles.
 */
function workspaceName(task: { readonly id: string; readonly displayNumber: number;
  readonly namingTitle: string | null }): string {
  return taskWorkspaceName({
    taskId: task.id, displayNumber: task.displayNumber, namingTitle: task.namingTitle,
  });
}

/**
 * The worktree directory of a Task, derived the way the Runtime derives it (ADR-0065 D03):
 * `<displayNumber>-<namingTitle>`, or the internal identity for a Task that predates the titles.
 */
function workspacePath(home: string, projectId: string,
  task: { readonly id: string; readonly displayNumber: number; readonly namingTitle: string | null },
): string {
  return join(realpathSync(home), 'worktrees', projectId, workspaceName(task));
}

interface SnapshotReport {
  readonly taskId: string;
  readonly taskState: string;
  readonly revisionId: string;
  readonly caseMode: string;
  readonly caseModeSource: string;
  readonly disposition: 'RECORDED' | 'REUSED' | 'UNAVAILABLE';
  readonly unavailableDetail: string | null;
  readonly baseline: { readonly workspaceBaseCommit: string | null;
    readonly projectDevCommit: string | null; readonly matchesProjectDev: boolean };
  readonly policy: { readonly state: string; readonly confirmed: boolean };
  readonly snapshot: {
    readonly id: string;
    readonly revisionId: string;
    readonly complete: boolean;
    readonly incompleteReasons: readonly string[];
    readonly files: readonly string[];
    readonly importantDirectories: readonly string[];
    readonly modules: readonly string[];
    readonly globalResources: readonly { readonly id: string; readonly written: boolean }[];
  } | null;
}

interface ExplainReport extends SnapshotReport {
  readonly candidate: SnapshotReport;
  readonly active: readonly { readonly taskId: string; readonly complete: boolean;
    /** The comparable Task's declared features (ADR-0059); the judged fact of a conflict. */
    readonly features: readonly string[] }[];
  readonly assessment: { readonly verdict: string; readonly reasonCodes: readonly string[];
    readonly hits: readonly { readonly features: readonly string[] }[] };
  readonly explanation: readonly string[];
  readonly recordedAssessments: readonly { readonly otherTaskId: string; readonly verdict: string;
    readonly reasonCodes: readonly string[] }[];
}

async function createAndSubmit(
  environment: Record<string, string>,
  projectId: string,
  specification: string,
): Promise<TaskPayload> {
  const created = JSON.parse((await cli(['task', 'create', projectId, specification,
    '--title', 'fixture task', '--name', 'fixture-task'],
    environment)).stdout) as TaskPayload;
  const submitted = await cli(['task', 'submit', projectId, created.id, '0'], environment);
  expect(submitted.exitCode).toBe(0);
  return { ...created, state: 'READY', version: 1 };
}

/**
 * Cancels a Task with the version it actually carries. The version is a fact about the Task, not a
 * constant: a periodic scheduling pass can bump it while the test runs, and the cancellation is a
 * compare-and-set that (correctly) refuses a stale version. A bounded re-read asserts the outcome
 * the command face promises — the Task is cancelled — instead of racing the scheduler.
 */
async function cancelWithCurrentVersion(
  projectId: string,
  taskId: string,
  environment: Record<string, string>,
): Promise<Awaited<ReturnType<typeof cli>>> {
  let last: Awaited<ReturnType<typeof cli>> | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const status = await cli(['task', 'status', projectId, taskId], environment);
    expect(status.exitCode).toBe(0);
    const version = (JSON.parse(status.stdout) as { readonly task: { readonly version: number } })
      .task.version;
    last = await cli(['task', 'cancel', projectId, taskId, String(version)], environment);
    if (last.exitCode === 0 || !last.stderr.includes('CONCURRENT_MODIFICATION')) return last;
    await Bun.sleep(250);
  }
  return last as Awaited<ReturnType<typeof cli>>;
}

describe('project impact', () => {
  test('derives SAFE and declared-feature verdicts from real change sets', async () => {
    const home = temporaryDirectory('codeestra-impact-home-');
    const assets = temporaryDirectory('codeestra-impact-assets-');
    await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
    const main = await createRepository({ prefix: 'codeestra-impact', withImpactMapping: true });
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: assets,
      CODEESTRA_PI_EXECUTABLE: main.tools };

    const opened = await cli(['open', main.repository, '--no-open'], environment);
    expect(opened.exitCode).toBe(0);
    expect(opened.stderr).toContain('Impact mapping');
    // The Runtime-wide concurrency limit is one fact for the whole `CODEESTRA_HOME` and defaults to
    // 2 (ADR-0061), so this fixture must raise it to the number of Executions it holds at once: the
    // two mapped Tasks keep their stub provider alive while the bare project's Task starts below.
    // Without this the third Task simply waits for a slot and the file it should write never appears.
    expect((await cli(['settings', 'concurrency', 'set', '--limit', '3', '--json'], environment))
      .exitCode).toBe(0);
    const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
      readonly { readonly id: string }[];
    const projectId = projects[0]?.id as string;
    expect(projectId).toBeDefined();

    // The mapping is present, parses, and is the digest the trust recorded.
    const validated = await cli(['project', 'impact', 'validate', main.repository, '--json'],
      environment);
    expect(validated.exitCode).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({
      code: 'OK', valid: true, policy: {
        state: 'PRESENT', confirmed: true, importantDirectories: 1, modules: 1, globalResources: 1,
      },
    });

    const first = await createAndSubmit(environment, projectId, 'Change the first area');
    const second = await createAndSubmit(environment, projectId, 'Change the second area');
    // Both Tasks enter scheduling on submit and the Runtime starts them there (ADR-0030 D04), so the
    // fixture no longer pushes each one by hand: it waits for the fact that both ran, which is what
    // gives both a held resource and a real worktree with a real change set.
    const firstWorktree = workspacePath(home, projectId, first);
    const secondWorktree = workspacePath(home, projectId, second);
    await waitFor(() => Bun.file(join(firstWorktree, 'src', 'agent', `${workspaceName(first)}.ts`))
      .size > 0);
    await waitFor(() => Bun.file(join(secondWorktree, 'src', 'agent', `${workspaceName(second)}.ts`))
      .size > 0);

    // SAFE: neither Task declares a feature, so there is nothing to conflict with — and under the
    // current rule that is the answer whatever the files look like.
    const safe = await cli(['project', 'impact', 'explain', projectId, second.id, '--json'],
      environment);
    expect(safe.exitCode).toBe(0);
    const safeReport = JSON.parse(safe.stdout) as ExplainReport;
    expect(safeReport.assessment).toMatchObject({
      verdict: 'SAFE_TO_PARALLELIZE', reasonCodes: ['NO_CONFLICT'],
    });
    // Only Tasks that declared a feature are compared (ADR-0059), so nothing was compared here and
    // nothing is recorded as a pair.
    expect(safeReport.active).toEqual([]);
    expect(safeReport.recordedAssessments).toEqual([]);
    expect(safeReport.candidate.snapshot?.complete).toBe(true);
    expect(safeReport.candidate.snapshot?.files).toEqual([`src/agent/${workspaceName(second)}.ts`]);
    expect(safeReport.candidate.caseModeSource).toBe('FILESYSTEM');
    expect(safeReport.candidate.baseline.matchesProjectDev).toBe(true);

    // The snapshot is reused while the facts hold, and the same read explains why.
    const replayed = JSON.parse((await cli(['project', 'impact', 'show', projectId, second.id,
      '--json'], environment)).stdout) as SnapshotReport;
    expect(replayed.disposition).toBe('REUSED');
    expect(replayed.snapshot?.id).toBe(safeReport.candidate.snapshot?.id);

    // A symlink is compared as the name Git reports, never dereferenced: the mapping and the change
    // set are both read from Git objects, so a link pointing outside the repository cannot make the
    // analyzer read outside it.
    symlinkSync(tmpdir(), join(firstWorktree, 'escape-link'));
    const withSymlink = JSON.parse((await cli(['project', 'impact', 'show', projectId, first.id,
      '--json'], environment)).stdout) as SnapshotReport;
    expect(withSymlink.snapshot?.files).toContain('escape-link');
    expect(withSymlink.snapshot?.complete).toBe(true);
    rmSync(join(firstWorktree, 'escape-link'), { force: true });

    // Overlapping change sets are still *observed* — and still not a conflict. Both Tasks now change
    // files of the declared `core` subtree, including the very same file, and the verdict stays SAFE:
    // this is the deliberate reversal of the old file-overlap rule (ADR-0059).
    await Bun.write(join(firstWorktree, 'core', 'first.ts'), 'export const first = 1;\n');
    await Bun.write(join(secondWorktree, 'core', 'shared.ts'), 'export const shared = 2;\n');
    await Bun.write(join(firstWorktree, 'core', 'shared.ts'), 'export const shared = 3;\n');
    const overlapping = JSON.parse((await cli(['project', 'impact', 'explain', projectId, second.id,
      '--json'], environment)).stdout) as ExplainReport;
    expect(overlapping.assessment.verdict).toBe('SAFE_TO_PARALLELIZE');
    expect(overlapping.explanation.join('\n'))
      .toContain('the rule compares declarations, not file overlap');

    // Declaring the same feature on both revisions is what makes them conflict, and the reason code
    // names the declaration rather than any path.
    for (const task of [first, second]) {
      const status = JSON.parse((await cli(['task', 'status', projectId, task.id],
        environment)).stdout) as { readonly task: { readonly version: number } };
      const declared = await cli(['task', 'revision', 'create', projectId, task.id,
        String(status.task.version), '--feature', 'core-module', '--reason', 'declare the feature',
        '--json'], environment);
      expect(declared.exitCode).toBe(0);
    }
    const conflicting = await cli(['project', 'impact', 'explain', projectId, second.id, '--json'],
      environment);
    // `explain` exits 0 only for SAFE; a declared overlap waits.
    expect(conflicting.exitCode).toBe(1);
    const conflictingReport = JSON.parse(conflicting.stdout) as ExplainReport;
    expect(conflictingReport.assessment.verdict).toBe('CONFLICTING');
    expect(conflictingReport.assessment.reasonCodes).toEqual(['SAME_UNFINISHED_FEATURE']);
    expect(conflictingReport.active.map((entry) => entry.taskId)).toEqual([first.id]);
    expect(conflictingReport.active[0]?.features).toEqual(['core-module']);
    expect(conflictingReport.assessment.hits[0]?.features).toEqual(['core-module']);
    expect(conflictingReport.explanation.join('\n')).toContain('features core-module');

    // Amending the Task revision makes the stored snapshot stale: a new one is recorded for the new
    // revision instead of the old prediction being reused.
    const secondStatus = JSON.parse((await cli(['task', 'status', projectId, second.id],
      environment)).stdout) as { readonly task: { readonly version: number } };
    const amended = await cli(['task', 'revision', 'create', projectId, second.id,
      String(secondStatus.task.version), '--specification', 'Change the second area, narrowed',
      '--reason', 'narrow the scope', '--json'], environment);
    expect(amended.exitCode).toBe(0);
    const afterAmendment = JSON.parse((await cli(['project', 'impact', 'show', projectId, second.id,
      '--json'], environment)).stdout) as SnapshotReport;
    expect(afterAmendment.disposition).toBe('RECORDED');
    expect(afterAmendment.revisionId).not.toBe(replayed.revisionId);
    expect(afterAmendment.snapshot?.revisionId).toBe(afterAmendment.revisionId);
    expect(afterAmendment.snapshot?.id).not.toBe(replayed.snapshot?.id);
    // ...and the reused snapshot of the superseded revision is not silently replayed either.
    const third = JSON.parse((await cli(['project', 'impact', 'show', projectId, second.id, '--json'],
      environment)).stdout) as SnapshotReport;
    expect(third.disposition).toBe('REUSED');
    expect(third.snapshot?.id).toBe(afterAmendment.snapshot?.id);
    // An amendment that omits `--feature` inherits the declaration, so the conflict survives it: a
    // specification change must not quietly drop the Task out of the feature rule.
    const explainAfterAmendment = await cli(['project', 'impact', 'explain', projectId, second.id,
      '--json'], environment);
    expect(explainAfterAmendment.exitCode).toBe(1);
    expect((JSON.parse(explainAfterAmendment.stdout) as ExplainReport).assessment
      .reasonCodes).toEqual(['SAME_UNFINISHED_FEATURE']);

    // A project with no mapping cannot *declare* a feature — that is now the refusal, instead of every
    // verdict being UNKNOWN.
    const bare = await createRepository({ prefix: 'codeestra-impact-bare', withImpactMapping: false });
    const bareEnvironment = { ...environment, CODEESTRA_PI_EXECUTABLE: bare.tools };
    expect((await cli(['open', bare.repository, '--no-open'], bareEnvironment)).exitCode).toBe(0);
    const bareProjects = JSON.parse((await cli(['project', 'list'], bareEnvironment)).stdout) as
      readonly { readonly id: string; readonly name: string }[];
    const bareProjectId = bareProjects.find((entry) => entry.id !== projectId)?.id as string;
    expect(bareProjectId).toBeDefined();
    const bareValidated = await cli(['project', 'impact', 'validate', bare.repository, '--json'],
      bareEnvironment);
    expect(bareValidated.exitCode).toBe(1);
    expect(JSON.parse(bareValidated.stdout)).toMatchObject({ code: 'POLICY_ABSENT' });
    const refusedFeature = await cli(['task', 'create', bareProjectId, 'Change something',
      '--title', 'Change something', '--name', 'change-something', '--feature', 'core-module'], bareEnvironment);
    expect(refusedFeature.exitCode).toBe(1);
    expect(refusedFeature.stderr).toContain('IMPACT_POLICY_ABSENT');
    // ...while a Task that declares nothing is perfectly usable, and its verdict is SAFE rather than
    // UNKNOWN: the missing mapping is a fact about the mapping, not about this Task.
    const bareTask = await createAndSubmit(bareEnvironment, bareProjectId, 'Change something');
    const bareWorktree = workspacePath(home, bareProjectId, bareTask);
    await waitFor(() => Bun.file(join(bareWorktree, 'src', 'agent', `${workspaceName(bareTask)}.ts`))
      .size > 0);
    const withoutMapping = await cli(['project', 'impact', 'explain', bareProjectId, bareTask.id,
      '--json'], bareEnvironment);
    expect(withoutMapping.exitCode).toBe(0);
    const withoutMappingReport = JSON.parse(withoutMapping.stdout) as ExplainReport;
    expect(withoutMappingReport.assessment.verdict).toBe('SAFE_TO_PARALLELIZE');
    // The snapshot still says, factually, that the mapping it observed is absent.
    expect(withoutMappingReport.candidate.snapshot?.complete).toBe(false);
    expect(withoutMappingReport.candidate.snapshot?.incompleteReasons).toEqual(['POLICY_ABSENT']);

    // A mapping that no longer parses is reported as INVALID, not as "no mapping". It does not change
    // the verdict (the verdict is about declarations, and nothing consulted the mapping here), but the
    // snapshot records it and `validate` refuses.
    await Bun.write(join(main.repository, '.codeestra', 'impact.json'), '{ not json }\n');
    await git(main.repository, ['add', '.codeestra/impact.json']);
    await git(main.repository, ['commit', '-q', '-m', 'break the mapping']);
    expect((await cli(['open', main.repository, '--no-open'], environment)).exitCode).toBe(0);
    const invalid = await cli(['project', 'impact', 'validate', main.repository, '--json'], environment);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      code: 'POLICY_INVALID', policy: { state: 'INVALID', errorCode: 'INVALID_IMPACT_POLICY' },
    });
    // The *declaration* itself is still what decides, and it is still the same declaration.
    const invalidExplain = await cli(['project', 'impact', 'explain', projectId, second.id,
      '--json'], environment);
    expect(invalidExplain.exitCode).toBe(1);
    expect((JSON.parse(invalidExplain.stdout) as ExplainReport).assessment
      .reasonCodes).toEqual(['SAME_UNFINISHED_FEATURE']);
    // A *new* declaration, on the other hand, is refused while the mapping cannot be read.
    const declareOnInvalid = await cli(['task', 'create', projectId, 'A brand new Task',
      '--title', 'A brand new Task', '--name', 'a-brand-new-task', '--feature', 'core-module'], environment);
    expect(declareOnInvalid.exitCode).toBe(1);
    expect(declareOnInvalid.stderr).toContain('INVALID_IMPACT_POLICY');

    // Only the command face is used above; the Runtime is stopped through the CLI like any client.
    // The Task version is re-read instead of assumed: the scheduling engine's recovery pass can
    // pause a Task whose impact prediction was revoked, which moves the version, and a hard-coded
    // `2` turned that legitimate transition into a false CONCURRENT_MODIFICATION.
    const cancelled = await cancelWithCurrentVersion(projectId, first.id, environment);
    expect(cancelled.exitCode).toBe(0);
    const stopped = await cli(['stop'], environment);
    expect(stopped.exitCode).toBe(0);
  }, 300_000);
});
