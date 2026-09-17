import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

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
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Dependency Test',
      GIT_AUTHOR_EMAIL: 'dependency@example.invalid', GIT_COMMITTER_NAME: 'Dependency Test',
      GIT_COMMITTER_EMAIL: 'dependency@example.invalid' } });
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
const sessionFile = join(sessionDir, 'dependency-session.jsonl');
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
        sessionId: 'dependency-session', sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      writeFileSync(join(process.cwd(), 'agent-output.txt'), 'work\\n');
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'dependency-session', timestamp: '2026-09-14T09:00:00.000Z',
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

interface Fixture {
  readonly environment: Record<string, string>;
  readonly repository: string;
  readonly home: string;
  readonly projectId: string;
}

async function fixture(): Promise<Fixture> {
  const repository = temporaryDirectory('codeestra-deps-repo-');
  const home = temporaryDirectory('codeestra-deps-home-');
  const tools = temporaryDirectory('codeestra-deps-tools-');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1,
    commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  // ADR-0009: the long-lived dev branch is the workspace baseline and the integration target.
  await git(repository, ['branch', 'dev']);
  // ADR-0056: every dev fact comes from a second clone of the same origin that sits on
  // `dev`; the project is trusted with it explicitly.

  const stubPath = join(tools, 'stub-pi.ts');
  const shimPath = join(tools, 'pi');
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);

  const environment = {
    CODEESTRA_HOME: home,
    CODEESTRA_PI_EXECUTABLE: shimPath,
  };
  const opened = await cli(['project', 'trust', repository], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  return { environment, repository, home, projectId: projects[0]?.id as string };
}

interface DependencyEdgePayload {
  readonly dependentTaskId: string;
  readonly prerequisiteTaskId: string;
  readonly requiredRevisionId: string;
  readonly satisfied: boolean;
  readonly resultCommit: string | null;
  readonly reason: { readonly code: string } | null;
}

interface DependencyListPayload {
  readonly projectId: string;
  readonly taskId: string | null;
  readonly taskState: string | null;
  readonly taskVersion: number | null;
  readonly devCommit: string | null;
  readonly blocked: boolean;
  readonly edges: readonly DependencyEdgePayload[];
  readonly prerequisites: readonly string[];
  readonly dependents: readonly string[];
}

interface TaskStatusPayload {
  readonly task: { readonly id: string; readonly state: string; readonly version: number };
  readonly executions: readonly { readonly session: { readonly state: string } | null }[];
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

async function createTask(
  environment: Record<string, string>,
  projectId: string,
  specification: string,
): Promise<string> {
  const created = await cli(['task', 'create', projectId, specification,
    '--title', 'fixture task', '--name', 'fixture-task'], environment);
  expect(created.exitCode).toBe(0);
  return (JSON.parse(created.stdout) as { readonly id: string }).id;
}

async function dependsList(
  environment: Record<string, string>,
  projectId: string,
  taskId?: string,
): Promise<DependencyListPayload> {
  const listed = await cli(['task', 'depends', 'list', projectId,
    ...(taskId === undefined ? [] : [taskId]), '--json'], environment);
  expect(listed.exitCode).toBe(0);
  return JSON.parse(listed.stdout) as DependencyListPayload;
}

describe('codeestra task depends', () => {
  test('adds, lists, rejects a cycle and removes dependency edges from the CLI', async () => {
    const { environment, projectId } = await fixture();
    const upstream = await createTask(environment, projectId, 'Upstream work');
    const downstream = await createTask(environment, projectId, 'Consume the upstream');
    const stranger = await createTask(environment, projectId, 'Unrelated work');

    // A dependency on a Task that does not exist is refused and nothing is written.
    const unknown = await cli(['task', 'depends', 'add', projectId, downstream, '0',
      crypto.randomUUID()], environment);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('NOT_FOUND');
    expect((await dependsList(environment, projectId, downstream)).edges).toEqual([]);
    // A Task cannot depend on itself; the schema and the command face both refuse it.
    const self = await cli(['task', 'depends', 'add', projectId, downstream, '0', downstream],
      environment);
    expect(self.exitCode).toBe(1);
    expect(self.stderr).toContain('SELF_DEPENDENCY');
    expect((await dependsList(environment, projectId, downstream)).edges).toEqual([]);

    const added = await cli(['task', 'depends', 'add', projectId, downstream, '0', upstream],
      environment);
    expect(added.exitCode).toBe(0);
    const addedPayload = JSON.parse(added.stdout) as {
      readonly added: boolean; readonly taskState: string; readonly taskVersion: number;
      readonly dependencies: DependencyListPayload;
    };
    expect(addedPayload).toMatchObject({ added: true, taskState: 'DRAFT', taskVersion: 1 });
    expect(addedPayload.dependencies.edges).toHaveLength(1);
    expect(addedPayload.dependencies.edges[0]).toMatchObject({
      dependentTaskId: downstream, prerequisiteTaskId: upstream, satisfied: false,
      reason: { code: 'UPSTREAM_RESULT_MISSING' },
    });

    // The same edge again is reported as already present instead of a duplicate row or a version bump.
    const duplicate = await cli(['task', 'depends', 'add', projectId, downstream, '1', upstream],
      environment);
    expect(duplicate.exitCode).toBe(0);
    expect(JSON.parse(duplicate.stdout)).toMatchObject({ added: false, taskVersion: 1 });

    // upstream -> downstream would close downstream -> upstream, so it is refused as a cycle.
    const cycle = await cli(['task', 'depends', 'add', projectId, upstream, '0', downstream],
      environment);
    expect(cycle.exitCode).toBe(1);
    expect(cycle.stderr).toContain('DEPENDENCY_CYCLE');
    expect((await dependsList(environment, projectId, upstream)).edges).toEqual([]);

    // The project-wide listing shows the whole graph and each edge's verdict.
    const projectWide = await dependsList(environment, projectId);
    expect(projectWide.taskId).toBeNull();
    expect(projectWide.edges.map((edge) => edge.dependentTaskId)).toEqual([downstream]);

    // Impact analysis: the dependent closure of the upstream is the downstream Task.
    expect((await dependsList(environment, projectId, upstream)).dependents).toEqual([downstream]);

    // Removing an edge that does not exist is a failure, not a silent success.
    const missing = await cli(['task', 'depends', 'remove', projectId, downstream, '1', stranger],
      environment);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('NOT_FOUND');

    const removed = await cli(['task', 'depends', 'remove', projectId, downstream, '1', upstream],
      environment);
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ removed: true, taskVersion: 2 });
    expect((await dependsList(environment, projectId, downstream)).edges).toEqual([]);

    const unknownProject = await cli(['task', 'depends', 'list', crypto.randomUUID(), '--json'],
      environment);
    expect(unknownProject.exitCode).toBe(1);
    expect(unknownProject.stderr).toContain('NOT_FOUND');
    await cli(['stop'], environment);
  }, 60_000);

  test('keeps a downstream Task BLOCKED until the upstream is integrated, then unblocks it', async () => {
    const { environment, repository, home, projectId } = await fixture();
    const upstream = await createTask(environment, projectId, 'Produce the upstream result');
    const downstream = await createTask(environment, projectId, 'Consume the upstream result');

    const added = await cli(['task', 'depends', 'add', projectId, downstream, '0', upstream],
      environment);
    expect(added.exitCode).toBe(0);

    // Submitting the downstream Task records the specification-valid transition (DRAFT -> READY) and
    // is gated immediately afterwards, so the two recorded facts leave the Task BLOCKED: the upstream
    // revision is not in dev yet, and the response already reports the state the user will observe.
    const submitted = await cli(['task', 'submit', projectId, downstream, '1'], environment);
    expect(submitted.exitCode).toBe(0);
    const submittedPayload = JSON.parse(submitted.stdout) as {
      readonly state: string; readonly version: number;
      readonly dependencyState: { readonly changed: boolean;
        readonly blockedReasons: readonly { readonly code: string }[] };
    };
    expect(submittedPayload.state).toBe('BLOCKED');
    expect(submittedPayload.dependencyState.changed).toBe(true);
    expect(submittedPayload.dependencyState.blockedReasons.map((reason) => reason.code))
      .toEqual(['UPSTREAM_RESULT_MISSING']);
    const blockedVersion = (await status(environment, projectId, downstream)).task.version;
    expect(submittedPayload.version).toBe(blockedVersion);

    // Running a blocked Task fails with a stable code and reserves nothing: no Execution is created
    // and no worktree appears in the Runtime data directory.
    const ran = await cli(['task', 'run', projectId, downstream, String(blockedVersion)], environment);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain('DEPENDENCIES_UNMET');
    expect((await status(environment, projectId, downstream)).executions).toEqual([]);
    expect(existsSync(join(realpathSync(home), 'worktrees', projectId, downstream))).toBe(false);

    // Drive the upstream to a verified result commit.
    // The undeclared upstream is SAFE under ADR-0059, so submission starts it immediately.
    expect((await cli(['task', 'submit', projectId, upstream, '0'], environment)).exitCode).toBe(0);
    const deadline = Date.now() + 30_000;
    let exited = false;
    while (Date.now() < deadline) {
      const current = await status(environment, projectId, upstream);
      if (current.executions[0]?.session?.state === 'EXITED') { exited = true; break; }
      await Bun.sleep(100);
    }
    expect(exited).toBe(true);
    const captured = await cli(['task', 'result', 'capture', projectId, upstream], environment);
    expect(captured.exitCode).toBe(0);
    const resultCommit = (JSON.parse(captured.stdout) as { readonly resultCommit: string }).resultCommit;
    expect((await cli(['task', 'verify', projectId, upstream], environment)).exitCode).toBe(0);

    // ADR-0070 D07 / S8 (ADR-0074): the edge is satisfied by the upstream result becoming reachable
    // from the Project Service's managed integration ref — the fact `project integration run`
    // produces after a verified merge. There is still no `task integrate`; the ref is advanced here
    // directly because this test is about the dependency verdict, not the merge queue.
    await git(repository, ['update-ref', 'refs/codeestra/integration', resultCommit]);
    expect(await git(repository, ['rev-parse', 'refs/codeestra/integration'])).toBe(resultCommit);
    // The user's own checkout is untouched by that.
    expect(await git(repository, ['symbolic-ref', '-q', 'HEAD'])).toBe('refs/heads/main');

    // A scheduling pass re-evaluates BLOCKED Tasks. With the upstream result now reachable the
    // downstream is READY, and — being SAFE under ADR-0059 — it starts immediately.
    expect((await cli(['task', 'schedule', 'run', projectId], environment)).exitCode).toBe(0);
    const view = await dependsList(environment, projectId, downstream);
    expect(view.blocked).toBe(false);
    expect(view.edges[0]?.reason).toBeNull();
    expect(view.edges[0]).toMatchObject({ satisfied: true, resultCommit: resultCommit,
      reason: null });
    expect(view.taskState).toBe('RUNNING');
    expect((await status(environment, projectId, downstream)).task.state).toBe('RUNNING');

    // A running Task keeps the dependency set it was scheduled with, so the edit is refused with a
    // stable code instead of silently reshaping what the running Agent was started against.
    const downstreamVersion = (await status(environment, projectId, downstream)).task.version;
    const refused = await cli(['task', 'depends', 'remove', projectId, downstream,
      String(downstreamVersion), upstream], environment);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('INVALID_STATE');
    const stillEdged = await dependsList(environment, projectId, downstream);
    expect(stillEdged.edges).toHaveLength(1);
    expect(stillEdged.blocked).toBe(false);
    await cli(['stop'], environment);
  }, 180_000);
});
