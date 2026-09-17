import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Phase1Database, ServiceWriteStore, rootServiceId } from '@codeestra/storage';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  repositoryRoot,
  runCli,
} from './support/runtime-reclamation.js';

/**
 * S7 (ADR-0070): Project and Task Service creation have one authoritative handler each, and the old
 * CLI and the Service face read the same row.
 *
 * What this file drives: the real CLI against a real temporary Runtime (`project trust`, `task
 * create`, `task status`, `service tree|get|list`), plus the write path itself for the two failures
 * the CLI cannot reach (an illegal Service parent and a repeated `taskId`). What it does NOT prove:
 * anything about a provider — no Agent, no Execution, no verification runs here.
 */

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

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn({
    cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Task Service Test',
      GIT_AUTHOR_EMAIL: 'task-service@example.invalid',
      GIT_COMMITTER_NAME: 'Task Service Test',
      GIT_COMMITTER_EMAIL: 'task-service@example.invalid' },
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

/** A committed repository that declares one feature id, so `--feature` can be accepted or refused. */
async function projectFixture(): Promise<string> {
  const repository = temporaryDirectory('codeestra-s7-repo-');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, '.codeestra', 'impact.json'), `${JSON.stringify({
    version: 1, importantDirectories: ['core'], modules: [{ id: 'core-module', paths: ['core/**'] }],
    globalResources: [],
  }, null, 2)}\n`);
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  return repository;
}

interface ServiceJson {
  readonly id: string;
  readonly kind: string;
  readonly parentServiceId: string | null;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly lifecycle: string;
  readonly stateVersion: number;
  readonly coreVersion: number;
  readonly coreState: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
}

interface TaskJson {
  readonly id: string;
  readonly projectId: string;
  readonly state: string;
  readonly version: number;
  readonly currentRevision: { readonly id: string; readonly specification: string };
}

async function serviceTree(environment: Record<string, string>): Promise<readonly ServiceJson[]> {
  const tree = await cli(['service', 'tree', '--json'], environment);
  expect(tree.exitCode).toBe(0);
  return JSON.parse(tree.stdout) as readonly ServiceJson[];
}

async function serviceGet(environment: Record<string, string>, serviceId: string): Promise<ServiceJson> {
  const read = await cli(['service', 'get', serviceId, '--json'], environment);
  expect(read.exitCode).toBe(0);
  return JSON.parse(read.stdout) as ServiceJson;
}

async function trustedProject(): Promise<{ environment: Record<string, string>; projectId: string }> {
  const repository = await projectFixture();
  const home = temporaryDirectory('codeestra-s7-home-');
  const environment = { CODEESTRA_HOME: home };
  const trusted = await cli(['project', 'trust', repository], environment);
  expect(trusted.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  return { environment, projectId: projects[0]?.id as string };
}

describe('Project/Task Service are the single write path (S7, ADR-0070)', () => {
  test('trust registers a PROJECT Service under root and create registers a TASK Service under it',
    async () => {
      const { environment, projectId } = await trustedProject();

      const afterTrust = await serviceTree(environment);
      const projectService = afterTrust.find((service) => service.kind === 'PROJECT');
      // The Service identity is the project identity, and its place in the tree is the root Service.
      expect(projectService).toMatchObject({ id: projectId, parentServiceId: rootServiceId,
        projectId, taskId: null, lifecycle: 'ACTIVE' });

      const created = await cli(['task', 'create', '--project', projectId, 'Do the thing',
        '--title', 'Do the thing', '--name', 'do-the-thing', '--feature', 'core-module'], environment);
      expect(created.exitCode).toBe(0);
      const task = JSON.parse(created.stdout) as TaskJson;
      expect(task.currentRevision.specification).toBe('Do the thing');

      const afterCreate = await serviceTree(environment);
      const taskService = afterCreate.find((service) => service.kind === 'TASK');
      expect(taskService).toMatchObject({ id: task.id, parentServiceId: projectId,
        projectId: null, taskId: task.id, lifecycle: 'ACTIVE' });

      // `task status` and `service get <taskServiceId>` are two readings of one row: the same
      // lifecycle and the same version, not a second state machine that can drift.
      const status = JSON.parse((await cli(['task', 'status', task.id], environment)).stdout) as
        { readonly task: TaskJson };
      expect(status.task).toMatchObject({ state: 'DRAFT', version: 0 });
      const readTaskService = await serviceGet(environment, task.id);
      expect(readTaskService.coreState).toMatchObject({ taskId: task.id, lifecycleState: 'DRAFT',
        currentRevisionId: task.currentRevision.id });
      expect(readTaskService.coreVersion).toBe(status.task.version);
    }, 120_000);

  test('trusting the same repository twice converges on one PROJECT Service and one registration',
    async () => {
      const repository = await projectFixture();
      const home = temporaryDirectory('codeestra-s7-retrust-home-');
      const environment = { CODEESTRA_HOME: home };
      expect((await cli(['project', 'trust', repository], environment)).exitCode).toBe(0);

      const projects = () => cli(['project', 'list'], environment);
      const first = JSON.parse((await projects()).stdout) as readonly { readonly id: string }[];
      expect(first).toHaveLength(1);
      const projectId = first[0]?.id as string;
      const before = await serviceGet(environment, projectId);
      expect(before.metadata['kernel/registered']).toBeDefined();

      expect((await cli(['project', 'trust', repository], environment)).exitCode).toBe(0);
      const second = JSON.parse((await projects()).stdout) as readonly { readonly id: string }[];
      // One project, one Service, and the registration fact is the first one: the second trust
      // reused the row instead of rewriting where the Service came from.
      expect(second.map((project) => project.id)).toEqual([projectId]);
      const services = JSON.parse((await cli(['service', 'list', '--kind', 'PROJECT', '--json'],
        environment)).stdout) as readonly ServiceJson[];
      expect(services.map((service) => service.id)).toEqual([projectId]);
      expect((await serviceGet(environment, projectId)).metadata).toEqual(before.metadata);
      expect((await serviceGet(environment, projectId)).stateVersion).toBe(before.stateVersion);
    }, 120_000);

  test('refuses a trust whose root Service is missing and writes nothing', async () => {
    const repository = await projectFixture();
    const home = temporaryDirectory('codeestra-s7-no-root-home-');
    // A root Service cannot be deleted through any command, so the missing-root fixture is the
    // database itself: the tree is broken before the Runtime ever starts.
    const database = new Phase1Database(join(home, 'runtime.sqlite'));
    database.sqlite.exec('PRAGMA foreign_keys=OFF');
    database.sqlite.query("DELETE FROM services WHERE kind='ROOT'").run();
    database.close();

    const environment = { CODEESTRA_HOME: home };
    const refused = await cli(['project', 'trust', repository], environment);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('SERVICE_NOT_FOUND');
    // The project row and the Service row are one transaction: neither survived the refusal.
    expect(JSON.parse((await cli(['project', 'list'], environment)).stdout)).toEqual([]);
    expect(JSON.parse((await cli(['service', 'list', '--kind', 'PROJECT', '--json'],
      environment)).stdout)).toEqual([]);
  }, 120_000);

  test('a refused task create leaves no TASK Service behind', async () => {
    const { environment, projectId } = await trustedProject();
    const refused = await cli(['task', 'create', '--project', projectId, 'Declare nothing',
      '--title', 'Declare nothing', '--name', 'declare-nothing', '--feature', 'not-declared'],
    environment);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('UNKNOWN_FEATURE');
    expect(JSON.parse((await cli(['task', 'list', '--project', projectId], environment)).stdout)).toEqual([]);
    // No Task row, no revision, and no orphan TASK Service: the Service row is written by the same
    // transaction as the Task it projects, so a refused declaration cannot leave half of it.
    expect(JSON.parse((await cli(['service', 'list', '--kind', 'TASK', '--json'],
      environment)).stdout)).toEqual([]);
  }, 120_000);

  test('`INSERT INTO tasks|projects` lives in one file and not in the Runtime command branch', () => {
    const writePath = join('packages', 'storage', 'src', 'service-write-store.ts');
    const scanned = [
      join(repositoryRoot, 'apps', 'runtime', 'src'),
      join(repositoryRoot, 'apps', 'cli', 'src'),
      ...readdirSync(join(repositoryRoot, 'packages'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(repositoryRoot, 'packages', entry.name, 'src')),
    ].flatMap(sourceFiles);
    expect(scanned.length).toBeGreaterThan(40);

    const insert = /INSERT\s+(OR\s+IGNORE\s+)?INTO\s+(tasks|projects)\b/i;
    const writers = scanned
      .filter((file) => insert.test(readFileSync(file, 'utf8')))
      .map((file) => relative(repositoryRoot, file));
    expect(writers).toEqual([writePath]);
    expect(readFileSync(join(repositoryRoot, writePath), 'utf8')).toMatch(insert);

    // The Runtime branch of `task.create` calls the one handler and writes nothing itself.
    const main = readFileSync(join(repositoryRoot, 'apps', 'runtime', 'src', 'main.ts'), 'utf8');
    const start = main.indexOf("case 'task.create':");
    const end = main.indexOf("case 'project.trust':", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const branch = main.slice(start, end);
    expect(branch).toContain('await taskService.create(');
    expect(branch).not.toContain('storage.createTask(');
    expect(branch).not.toMatch(/INSERT\s+INTO/i);
  });
});

/**
 * The two failures the CLI cannot produce directly: an illegal Service parent and a repeated
 * `taskId`. Both are about what the write path leaves behind, so they are asserted on the rows.
 */
describe('ServiceWriteStore applies nothing when it refuses', () => {
  const opened: Phase1Database[] = [];
  afterEach(() => { for (const storage of opened.splice(0)) storage.close(); });

  function seeded(): { readonly storage: Phase1Database; readonly store: ServiceWriteStore } {
    const storage = new Phase1Database();
    opened.push(storage);
    for (const projectId of ['p-1', 'p-2']) {
      storage.sqlite.query(`INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,
        object_format,policy_version,created_at)
        VALUES (?1,?1,?2,?2,'refs/heads/main','sha1',1,1)`).run(projectId, `/repo/${projectId}`);
      storage.sqlite.query(`INSERT INTO project_trusts(id,project_id,repo_root,git_common_dir,
        object_format,policy_version,actor,status,accepted_at)
        VALUES (?1,?2,?3,?3,'sha1',1,'user','ACTIVE',1)`)
        .run(`trust-${projectId}`, projectId, `/repo/${projectId}`);
    }
    const store = new ServiceWriteStore(storage);
    store.ensureProjectService({ projectId: 'p-1', rootServiceId, now: 2, eventId: 'event-1' });
    store.ensureProjectService({ projectId: 'p-2', rootServiceId, now: 2, eventId: 'event-2' });
    return { storage, store };
  }

  function counts(storage: Phase1Database): Record<string, number> {
    const count = (table: string) => storage.sqlite.query<{ count: number }, []>(
      `SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? -1;
    return { tasks: count('tasks'), revisions: count('task_revisions'),
      taskServices: storage.sqlite.query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM services WHERE kind='TASK'").get()?.count ?? -1,
      events: count('domain_events'), intents: count('intents') };
  }

  test('an illegal parent and a repeated taskId leave no row, no Service and no event behind', () => {
    const { storage, store } = seeded();
    const task = (taskId: string, projectId = 'p-1', projectServiceId = 'p-1') => ({
      projectId, projectServiceId, taskId, displayNumber: 1, displayTitle: 'Work',
      namingTitle: 'work', revisionId: `revision-${taskId}`, specification: 'Do work',
      feature: null, now: 5, eventIds: [`intent-event-${taskId}`, `task-event-${taskId}`] as
        readonly [string, string],
      command: { intentId: `intent-${taskId}`, commandId: `command-${taskId}`, actor: 'local-user' },
    });

    // A parent that is not a PROJECT Service is refused before anything is written.
    expect(refusal(() => store.createTaskService(task('k-1', 'p-1', rootServiceId))))
      .toBe('INVALID_SERVICE_PARENT');
    expect(refusal(() => store.createTaskService(task('k-1', 'p-1', 'p-2-missing'))))
      .toBe('SERVICE_NOT_FOUND');
    expect(counts(storage)).toEqual({ tasks: 0, revisions: 0, taskServices: 0, events: 0,
      intents: 0 });

    // The product path writes the Task through the same handler.
    storage.createTask({ projectId: 'p-1', commandId: 'command-k-1', payloadHash: 'hash',
      intentId: 'intent-k-1', taskId: 'k-1', revisionId: 'revision-k-1',
      intentEventId: 'intent-event-k-1', taskEventId: 'task-event-k-1', displayTitle: 'Work',
      namingTitle: 'work', specification: 'Do work', features: [], actor: 'local-user', createdAt: 5 });
    const afterCreate = counts(storage);
    expect(afterCreate).toMatchObject({ tasks: 1, revisions: 1, taskServices: 1, events: 2 });

    // The same `taskId` converges on the Service that already projects it ...
    const converged = store.createTaskService(task('k-1'));
    expect(converged.taskId).toBe('k-1');
    expect(converged.service.id).toBe('k-1');
    expect(counts(storage)).toEqual(afterCreate);
    // ... and a `taskId` that belongs to another project is refused without a second row.
    expect(refusal(() => store.createTaskService(task('k-1', 'p-2', 'p-2'))))
      .toBe('TASK_ID_CONFLICT');
    expect(counts(storage)).toEqual(afterCreate);
  });
});

/** The stable code of a refusal, without depending on the sentence a person reads. */
function refusal(run: () => unknown): string {
  try {
    run();
    return 'NO_REFUSAL';
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error) return String(error.code);
    return error instanceof Error ? error.name : String(error);
  }
}

/** Every `.ts` file under a directory tree, skipping `node_modules` and dot directories. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}
