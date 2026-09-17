import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeResponseSchema, type RuntimeRequest } from '@codeestra/contracts';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

/**
 * The Task-scoped command face (ADR-0076): `codeestra task …` names a **Task**, and the project is a
 * field of that Task rather than part of how it is addressed. These tests drive the CLI and the
 * Runtime command face only — they assert what the command faces answer, not what an internal
 * function returns.
 *
 * The negative cases matter as much as the positive ones: an id that belongs to nothing, a caller
 * that names a project the Task does not belong to, and a dependency read with no subject at all
 * each have their own answer, and none of them may silently fall back to "the only project I know".
 */

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => { await reclaimTestResources(); });

type ClientRequest = RuntimeRequest extends infer Request
  ? Request extends RuntimeRequest ? Omit<Request, 'requestId' | 'schemaVersion'> : never
  : never;

async function cli(args: readonly string[], environment: Record<string, string>) {
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Scope Test',
      GIT_AUTHOR_EMAIL: 'scope@example.invalid', GIT_COMMITTER_NAME: 'Scope Test',
      GIT_COMMITTER_EMAIL: 'scope@example.invalid' } });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

interface TrustedProject {
  readonly projectId: string;
  readonly repository: string;
}

/** Trusts a fresh temporary repository and returns the project id the Runtime assigned it. */
async function trustProject(home: string): Promise<TrustedProject> {
  const repository = mkdtempSync(join(tmpdir(), 'codeestra-scope-repo-'));
  registerTemporaryDirectory(repository);
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  const environment = { CODEESTRA_HOME: home };
  const before = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  const trusted = await cli(['project', 'trust', repository], environment);
  expect(trusted.exitCode).toBe(0);
  // `project trust` answers with a few documents (identity, policy, registration), so the id is read
  // from the authoritative list instead of from a mixed stdout — and by difference rather than by
  // path, because the Runtime records the resolved repository root.
  const after = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  const known = new Set(before.map((project) => project.id));
  const added = after.filter((project) => !known.has(project.id));
  expect(added.length).toBe(1);
  return { projectId: (added[0] as { readonly id: string }).id, repository };
}

async function createTask(
  environment: Record<string, string>,
  projectId: string,
  specification: string,
): Promise<string> {
  const created = await cli([
    'task', 'create', '--project', projectId, specification,
    '--title', 'A task for the scope test', '--name', 'scope-test-task',
  ], environment);
  expect(created.exitCode).toBe(0);
  return (JSON.parse(created.stdout) as { readonly id: string }).id;
}

/** One Runtime request over the socket the CLI already started, so no client logic is in the way. */
async function sendRuntimeRequest(
  home: string,
  request: ClientRequest,
): Promise<unknown> {
  const socketPath = join(home, 'runtime.sock');
  return await new Promise((resolveReply, rejectReply) => {
    let buffer = '';
    void Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify({ ...request, requestId: crypto.randomUUID(),
            schemaVersion: 1 })}\n`);
        },
        data(socket, chunk) {
          buffer += new TextDecoder().decode(chunk);
          const newline = buffer.indexOf('\n');
          if (newline === -1) return;
          socket.end();
          try {
            resolveReply(runtimeResponseSchema.parse(JSON.parse(buffer.slice(0, newline))));
          } catch (error) {
            rejectReply(error instanceof Error ? error : new Error(String(error)));
          }
        },
        error(_socket, error) { rejectReply(error); },
        close() {
          if (buffer.includes('\n')) return;
          rejectReply(new Error('the Runtime closed the connection without an answer'));
        },
      },
    }).catch(rejectReply);
  });
}

describe('codeestra task addresses a Task by its own id', () => {
  test('lists every trusted project and filters with --project', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codeestra-scope-home-'));
    registerTemporaryDirectory(home);
    const environment = { CODEESTRA_HOME: home };
    const first = await trustProject(home);
    const second = await trustProject(home);
    const firstTask = await createTask(environment, first.projectId, 'First project work');
    const secondTask = await createTask(environment, second.projectId, 'Second project work');

    // No project named: every trusted project's Tasks, each row carrying its own project (D03).
    const all = JSON.parse((await cli(['task', 'list'], environment)).stdout) as
      readonly { readonly id: string; readonly projectId: string }[];
    expect(all.map((task) => [task.id, task.projectId]).sort()).toEqual([
      [firstTask, first.projectId], [secondTask, second.projectId],
    ].sort());

    const filtered = JSON.parse(
      (await cli(['task', 'list', '--project', first.projectId], environment)).stdout,
    ) as readonly { readonly id: string }[];
    expect(filtered.map((task) => task.id)).toEqual([firstTask]);

    // An untrusted project is not a scope this Runtime can be asked about.
    const unknown = await cli(['task', 'list', '--project', crypto.randomUUID()], environment);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('NOT_FOUND');
  }, 120_000);

  test('reads and writes one Task without naming its project', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codeestra-scope-one-home-'));
    registerTemporaryDirectory(home);
    const environment = { CODEESTRA_HOME: home };
    const project = await trustProject(home);
    const taskId = await createTask(environment, project.projectId, 'Only this Task matters');

    const view = JSON.parse((await cli(['task', 'status', taskId], environment)).stdout) as
      { readonly task: { readonly id: string; readonly projectId: string } };
    expect([view.task.id, view.task.projectId]).toEqual([taskId, project.projectId]);

    // The id is the address, so an id that belongs to nothing is `NOT_FOUND` rather than a guess.
    const unknown = await cli(['task', 'status', crypto.randomUUID()], environment);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('NOT_FOUND');
  }, 120_000);

  test('refuses a Runtime request whose project contradicts the Task', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codeestra-scope-mismatch-home-'));
    registerTemporaryDirectory(home);
    const environment = { CODEESTRA_HOME: home };
    const project = await trustProject(home);
    const other = await trustProject(home);
    const taskId = await createTask(environment, project.projectId, 'The Task with an owner');

    // Without a project the Runtime resolves the Task's own project, which is what the CLI relies on.
    const resolved = await sendRuntimeRequest(home, { command: 'task.status', taskId }) as
      { readonly ok: boolean; readonly result?: { readonly task: { readonly projectId: string } } };
    expect([resolved.ok, resolved.result?.task.projectId]).toEqual([true, project.projectId]);

    // Naming a *different* trusted project is a refusal with its own code, not a silent preference:
    // which of the two the Runtime ignored must never be a guess.
    const contradicted = await sendRuntimeRequest(home,
      { command: 'task.status', taskId, projectId: other.projectId }) as
      { readonly ok: boolean; readonly error?: { readonly code: string } };
    expect([contradicted.ok, contradicted.error?.code]).toEqual([false, 'TASK_PROJECT_MISMATCH']);
  }, 120_000);

  test('answers the dependency read from the Task, or from a project, but never from neither', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codeestra-scope-depends-home-'));
    registerTemporaryDirectory(home);
    const environment = { CODEESTRA_HOME: home };
    const project = await trustProject(home);
    const first = await createTask(environment, project.projectId, 'Dependent work');
    const second = await createTask(environment, project.projectId, 'Prerequisite work');
    const added = await cli(['task', 'depends', 'add', first, '0', second], environment);
    expect(added.exitCode).toBe(0);

    // The Task names the project (D04).
    const forTask = JSON.parse((await cli(['task', 'depends', 'list', first, '--json'], environment)).stdout) as
      { readonly taskId: string; readonly projectId: string; readonly edges: readonly unknown[] };
    expect([forTask.taskId, forTask.projectId, forTask.edges.length])
      .toEqual([first, project.projectId, 1]);

    // The project names itself, for the whole-project graph.
    const forProject = JSON.parse(
      (await cli(['task', 'depends', 'list', '--project', project.projectId, '--json'], environment)).stdout,
    ) as { readonly taskId: string | null; readonly edges: readonly unknown[] };
    expect([forProject.taskId, forProject.edges.length]).toEqual([null, 1]);

    // Neither: the projection is bound to one project's baseline, so there is no answer to give, and
    // the usage error names the level whose help explains the two forms.
    const noSubject = await cli(['task', 'depends', 'list'], environment);
    expect(noSubject.exitCode).toBe(2);
    expect(noSubject.stdout).toBe('');
    expect(noSubject.stderr).toContain('task depends');
  }, 120_000);
});
