import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  assertMachineGeneratedWriteTarget,
  writeRuntimeKnowledgeFile,
} from '../src/knowledge-service.js';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';
import { provisionDevClone } from './support/agent-fixture.js';
import { taskWorkspaceName } from '@codeestra/domain';

/**
 * End-to-end evidence for `project knowledge` (FOUNDATION-067 / ADR-0041) through the real CLI and
 * the real Runtime: a temporary Git repository, an independent `CODEESTRA_HOME`, and a protocol stub
 * provider that writes one file per Task worktree and then stays alive so the Task holds its
 * resource.
 *
 * What the stub proves: the command face, the Git/Storage/orchestration behavior, and that an
 * Execution is bound to the exact knowledge it resolved. It is **not** evidence that a real provider
 * *reads* the materialized context — `packages/agent-adapters/**` does not consume
 * `knowledgeSnapshotRefs` in this lane and is out of this lane's territory, so provider-side
 * consumption remains unverified and is reported as such.
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
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Knowledge Test',
      GIT_AUTHOR_EMAIL: 'knowledge@example.invalid', GIT_COMMITTER_NAME: 'Knowledge Test',
      GIT_COMMITTER_EMAIL: 'knowledge@example.invalid' } });
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

/** A protocol stub, not a real provider: it settles one turn and then keeps reading stdin. */
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
// The launch argv this Adapter handed to the provider, per Task: the end-to-end proof that the
// Execution's Project Knowledge reached the provider as a launch argument (ADR-0051).
writeFileSync(join(sessionDir, 'argv-report-' + taskId + '.json'), JSON.stringify({ argv }) + '\\n');
const sessionFile = join(sessionDir, 'knowledge-session-' + taskId + '.jsonl');
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
        sessionId: 'knowledge-session-' + taskId, sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      const directory = join(process.cwd(), 'src', 'agent');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, taskId + '.ts'), 'export const task = ' +
        JSON.stringify(taskId) + ';\\n');
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'knowledge-session-' + taskId, timestamp: '2026-09-14T09:00:00.000Z',
        cwd: process.cwd() }) + '\\n');
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Wrote the file.' }], stopReason: 'stop' } });
      emit({ type: 'agent_settled' });
    }
  }
}
`;

const conventions = `---
id: repo-conventions
---
Always run the focused test file for the package you touched.
`;

const releaseSkill = `---
id: release-checklist
scope: SELF
---
Only self tasks read this.
`;

interface RepositoryFixture {
  readonly repository: string;
  /** The dev clone the project is trusted with (ADR-0056). */
  readonly devRepo: string;
  readonly tools: string;
  readonly assets: string;
}

async function createRepository(input: {
  readonly prefix: string;
  readonly instructions?: string;
  readonly skills?: string;
}): Promise<RepositoryFixture> {
  const repository = temporaryDirectory(`${input.prefix}-repo-`);
  const tools = temporaryDirectory(`${input.prefix}-tools-`);
  const assets = temporaryDirectory(`${input.prefix}-assets-`);
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  if (input.instructions !== undefined) {
    mkdirSync(join(repository, '.codeestra', 'instructions'), { recursive: true });
    await Bun.write(join(repository, '.codeestra', 'instructions', 'conventions.md'),
      input.instructions);
  }
  if (input.skills !== undefined) {
    mkdirSync(join(repository, '.codeestra', 'skills'), { recursive: true });
    await Bun.write(join(repository, '.codeestra', 'skills', 'release.md'), input.skills);
    // A non-Markdown file in a knowledge directory must be ignored, not reported as an error.
    await Bun.write(join(repository, '.codeestra', 'skills', 'notes.txt'), 'ignored\n');
  }
  await Bun.write(join(repository, 'package.json'), '{"name":"fixture","private":true}\n');
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
  return { repository, devRepo, tools: shimPath, assets };
}

interface TaskPayload {
  readonly id: string;
  readonly displayNumber: number;
  readonly namingTitle: string | null;
  readonly state: string;
  readonly version: number;
}

/** The worktree directory name of a Task (ADR-0065 D03). */
function workspaceName(task: TaskPayload): string {
  return taskWorkspaceName({
    taskId: task.id, displayNumber: task.displayNumber, namingTitle: task.namingTitle,
  });
}

interface EntryView {
  readonly layer: string;
  readonly kind: string;
  readonly path: string;
  readonly id: string | null;
  readonly scope: string;
  readonly digest: string;
  readonly appliesToTask: boolean;
}

interface ValidationView {
  readonly code: string;
  readonly valid: boolean;
  readonly projectId: string;
  readonly mainCommit: string;
  readonly state: string;
  readonly errors: readonly { readonly layer: string | null; readonly code: string;
    readonly path: string | null; readonly message: string }[];
  readonly layers: readonly { readonly layer: string; readonly kind: string;
    readonly source: string; readonly entryCount: number; readonly bytes: number }[];
  readonly snapshotDigest: string | null;
  readonly humanDigest: string | null;
  readonly generatedDigest: string | null;
  readonly entryCount: number;
  readonly humanEntryCount: number;
  readonly generatedEntryCount: number;
}

interface ListView extends ValidationView {
  readonly entries: readonly EntryView[];
  readonly snapshots: readonly { readonly id: string; readonly snapshotDigest: string;
    readonly entryCount: number }[];
}

interface SnapshotView {
  readonly snapshot: { readonly id: string; readonly snapshotDigest: string;
    readonly humanDigest: string; readonly generatedDigest: string; readonly entryCount: number;
    readonly humanEntryCount: number; readonly generatedEntryCount: number;
    readonly mainCommit: string };
  readonly entries: readonly EntryView[];
  readonly executions: readonly { readonly executionId: string; readonly taskId: string;
    readonly contextPath: string; readonly contextDigest: string; readonly contextBytes: number;
    readonly entryCount: number; readonly refs: readonly string[] }[];
}

interface ResolveView {
  readonly state: string;
  readonly taskKind: string;
  readonly snapshotDigest: string | null;
  readonly contextPath: string;
  readonly contextDigest: string | null;
  readonly entryCount: number;
  readonly entries: readonly EntryView[];
}

async function openAndIdentify(
  environment: Record<string, string>,
  repository: string,
  devRepo: string,
): Promise<string> {
  const opened = await cli(['open', repository, '--dev-repo', devRepo, '--no-open'], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { readonly id: string }[];
  const projectId = projects[0]?.id as string;
  expect(projectId).toBeDefined();
  return projectId;
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

describe('project knowledge', () => {
  test('lays the human and machine layers out, loads them from the main ref and binds them to an Execution', async () => {
    const home = temporaryDirectory('codeestra-knowledge-home-');
    const main = await createRepository({
      prefix: 'codeestra-knowledge',
      instructions: conventions,
      skills: releaseSkill,
    });
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: main.assets,
      CODEESTRA_PI_EXECUTABLE: main.tools };
    const projectId = await openAndIdentify(environment, main.repository, main.devRepo);

    // validate/list read the human layers out of the main ref and ignore other extensions.
    const validated = await cli(['project', 'knowledge', 'validate', projectId, '--json'],
      environment);
    expect(validated.exitCode).toBe(0);
    const validation = JSON.parse(validated.stdout) as ValidationView;
    expect(validation).toMatchObject({
      code: 'OK', valid: true, state: 'VALID', entryCount: 2, humanEntryCount: 2,
      generatedEntryCount: 0, errors: [],
    });
    expect(validation.snapshotDigest).toHaveLength(64);
    expect(validation.layers).toEqual([
      { layer: 'instructions', kind: 'HUMAN', source: '.codeestra/instructions',
        entryCount: 1, bytes: expect.any(Number) },
      { layer: 'skills', kind: 'HUMAN', source: '.codeestra/skills',
        entryCount: 1, bytes: expect.any(Number) },
      { layer: 'generated', kind: 'MACHINE', source: join(home, 'knowledge',
        projectId, 'generated'), entryCount: 0, bytes: 0 },
    ]);

    const listed = JSON.parse((await cli(['project', 'knowledge', 'list', projectId, '--json'],
      environment)).stdout) as ListView;
    // Layer order is fixed: instructions before skills, and never the ignored `.txt`.
    expect(listed.entries.map((entry) => entry.path)).toEqual([
      '.codeestra/instructions/conventions.md',
      '.codeestra/skills/release.md',
    ]);
    expect(listed.entries.map((entry) => entry.scope)).toEqual(['ALL', 'SELF']);
    expect(listed.snapshots).toEqual([]);

    // A DEVELOPMENT Task does not read the SELF-scoped skill, before anything is started.
    const task = await createAndSubmit(environment, projectId, 'Change the first area');
    const resolved = await cli(['project', 'knowledge', 'resolve', projectId, task.id, '--json'],
      environment);
    expect(resolved.exitCode).toBe(0);
    const resolution = JSON.parse(resolved.stdout) as ResolveView;
    expect(resolution).toMatchObject({
      state: 'VALID', taskKind: 'DEVELOPMENT', entryCount: 1,
      // Runtime-relative: materialized knowledge never lands in the worktree (ADR-0041 D05).
      contextPath: `${task.id}/knowledge-context.md`,
    });
    expect(resolution.entries.map((entry) => entry.path))
      .toEqual(['.codeestra/instructions/conventions.md']);
    expect(resolution.snapshotDigest).toBe(validation.snapshotDigest);
    expect(validation.state).toBe('VALID');

    // ADR-0059 makes an undeclared Task SAFE, so submission already started the same Execution path.
    // Wait for the fact that it ran rather than assuming process completion from the submit response.
    const worktree = join(realpathSync(home), 'worktrees', projectId, workspaceName(task));
    await waitFor(() => Bun.file(join(worktree, 'src', 'agent', `${workspaceName(task)}.ts`)).size > 0);

    // The Execution materialized the context into the Runtime's own knowledge directory — *not* into
    // the worktree — and the binding records exactly those bytes.
    const contextPath = join(home, 'knowledge', projectId, task.id, 'knowledge-context.md');
    const contextText = readFileSync(contextPath, 'utf8');
    // ...and the provider process was actually launched with that artifact (ADR-0051): the argv the
    // Adapter handed to Pi names the Runtime-owned file, and it is the same file whose bytes the
    // binding recorded. Nothing about the rest of the controlled launch changed.
    const sessionDir = join(home, 'pi-sessions');
    // The report is named after the workspace the provider ran in (ADR-0065 D03), not the Task id.
    const launchArgv = (JSON.parse(readFileSync(
      join(sessionDir, `argv-report-${workspaceName(task)}.json`), 'utf8')) as {
        argv: readonly string[] }).argv;
    expect(launchArgv.filter((argument) => argument === '--append-system-prompt'))
      .toHaveLength(1);
    const handedOver = launchArgv[launchArgv.indexOf('--append-system-prompt') + 1];
    expect(handedOver).toBe(join(home, 'knowledge', projectId, task.id, 'knowledge-context.md'));
    expect(readFileSync(handedOver ?? '', 'utf8')).toBe(contextText);
    // The artifact the provider was pointed at is outside the Task worktree, even after resolving
    // the symlinked temp directory the fixture lives under.
    expect(relative(worktree, realpathSync(handedOver ?? ''))).toStartWith('..');
    expect(launchArgv).toContain('--no-context-files');
    expect(launchArgv).toContain('--no-extensions');
    expect(contextText).toContain('# Project knowledge');
    expect(contextText).toContain('Always run the focused test file');
    expect(contextText).not.toContain('Only self tasks read this');
    expect(contextText).toContain(`Snapshot digest: ${validation.snapshotDigest}`);

    const shown = await cli(['project', 'knowledge', 'show', projectId, '--json'], environment);
    expect(shown.exitCode).toBe(0);
    const snapshot = JSON.parse(shown.stdout) as SnapshotView;
    expect(snapshot.snapshot.snapshotDigest).toBe(String(validation.snapshotDigest));
    expect(snapshot.snapshot.humanDigest).toBe(String(validation.humanDigest));
    expect(snapshot.snapshot.generatedDigest).toBe(String(validation.generatedDigest));
    expect(snapshot.entries.map((entry) => entry.path)).toEqual([
      '.codeestra/instructions/conventions.md',
      '.codeestra/skills/release.md',
    ]);
    expect(snapshot.executions).toHaveLength(1);
    const binding = snapshot.executions[0];
    expect(binding?.taskId).toBe(task.id);
    expect(binding?.contextPath).toBe(`${task.id}/knowledge-context.md`);
    expect(binding?.contextBytes).toBe(Buffer.byteLength(contextText, 'utf8'));
    // The recorded content digest is the digest of the file that is actually on disk.
    const onDisk = await crypto.subtle.digest('SHA-256', Buffer.from(contextText, 'utf8'));
    expect(binding?.contextDigest)
      .toBe(Buffer.from(onDisk).toString('hex'));
    // Only the entries that applied to this Task kind are in the references.
    expect(binding?.refs[0]).toBe(`knowledge-snapshot:${validation.snapshotDigest}`);
    expect(binding?.refs).toHaveLength(2);
    expect(binding?.refs[1]).toContain('.codeestra/instructions/conventions.md');

    // Nothing was written into the worktree: the Execution's own change set is still exactly what the
    // Agent produced, so machine-generated knowledge can neither conflict with a peer Task nor be
    // staged into the result commit.
    const status = Bun.spawnSync({ cmd: ['git', '-C', worktree, 'status', '--porcelain', '-uall'],
      env: { PATH: Bun.env.PATH ?? '' } });
    expect(status.stdout.toString().trim().split('\n').filter((line) => line.length > 0))
      .toEqual([`?? src/agent/${workspaceName(task)}.ts`]);
    expect(existsSync(join(worktree, '.codeestra', 'generated'))).toBe(false);

    // The snapshot is the same one `list` would report now, and it is discoverable by id.
    expect((JSON.parse((await cli(['project', 'knowledge', 'list', projectId, '--json'],
      environment)).stdout) as ListView).snapshots.map((entry) => entry.id))
      .toEqual([snapshot.snapshot.id]);
    const byId = await cli(['project', 'knowledge', 'show', projectId, snapshot.snapshot.id, '--json'],
      environment);
    expect(byId.exitCode).toBe(0);
    expect((JSON.parse(byId.stdout) as SnapshotView).snapshot.id).toBe(snapshot.snapshot.id);
    const missing = await cli(['project', 'knowledge', 'show', projectId,
      crypto.randomUUID(), '--json'], environment);
    expect(missing.exitCode).not.toBe(0);
  }, 120_000);

  test('a Task branch cannot rewrite the knowledge its own Execution reads', async () => {
    const home = temporaryDirectory('codeestra-knowledge-branch-home-');
    const main = await createRepository({
      prefix: 'codeestra-knowledge-branch',
      instructions: conventions,
    });
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: main.assets,
      CODEESTRA_PI_EXECUTABLE: main.tools };
    const projectId = await openAndIdentify(environment, main.repository, main.devRepo);

    const before = JSON.parse((await cli(['project', 'knowledge', 'list', projectId, '--json'],
      environment)).stdout) as ListView;

    // Editing the same human file on a Task branch is what a Task would do. The human layer is read
    // from the project `main` ref only — exactly like the verification policy and the impact
    // mapping — so none of this can change what an Execution records it used.
    await git(main.repository, ['checkout', '-q', '-b', 'task/probe']);
    await Bun.write(join(main.repository, '.codeestra', 'instructions', 'conventions.md'),
      '---\nid: repo-conventions\n---\nREWRITTEN ON A TASK BRANCH\n');
    await Bun.write(join(main.repository, '.codeestra', 'instructions', 'branch-only.md'),
      '---\nid: branch-only\n---\nNot on main.\n');
    await git(main.repository, ['add', '.']);
    await git(main.repository, ['commit', '-q', '-m', 'branch rewrite']);
    await git(main.repository, ['checkout', '-q', 'main']);

    const after = JSON.parse((await cli(['project', 'knowledge', 'list', projectId, '--json'],
      environment)).stdout) as ListView;
    expect(after.snapshotDigest).toBe(before.snapshotDigest);
    expect(after.entries.map((entry) => entry.path))
      .toEqual(['.codeestra/instructions/conventions.md']);
    expect(after.mainCommit).toBe(before.mainCommit);

    // The refusal to let a machine write a human-maintained file is the second half of the same
    // invariant. It is asserted at the API the Runtime itself calls, because there is no CLI command
    // that writes generated knowledge (ADR-0041 D09: the writer is the Runtime, not the user).
    const human = join(main.repository, '.codeestra', 'instructions', 'conventions.md');
    const originalText = readFileSync(human, 'utf8');
    for (const path of [
      '.codeestra/instructions/conventions.md',
      '.codeestra/skills/release.md',
      '.codeestra/policies/verification.json',
      '.codeestra/impact.json',
    ]) {
      try {
        assertMachineGeneratedWriteTarget({ root: main.repository, relativePath: path });
        throw new Error(`expected ${path} to be refused`);
      } catch (error) {
        expect((error as { code?: string }).code).toBe('KNOWLEDGE_HUMAN_FILE_PROTECTED');
      }
    }
    // A path that leaves the generated area is refused too, and a write target that is a symlink or a
    // directory is never silently replaced.
    for (const relativePath of ['../outside.md', '.codeestra/generated/../../escape.md', 'a//b.md']) {
      expect(() => assertMachineGeneratedWriteTarget({ root: main.repository, relativePath }))
        .toThrow();
    }
    // Zero writes: the human file is byte-for-byte what it was, and no generated file appeared.
    expect(readFileSync(human, 'utf8')).toBe(originalText);
    expect(existsSync(join(main.repository, '.codeestra', 'generated'))).toBe(false);
    // The machine-generated area *inside a repository* is the only place a machine would ever be
    // allowed to write, and even there the repository working tree is never a Runtime write target.
    expect(assertMachineGeneratedWriteTarget({
      root: main.repository, relativePath: '.codeestra/generated/probe.md',
    })).toBe(join(main.repository, '.codeestra', 'generated', 'probe.md'));
    expect(existsSync(join(main.repository, '.codeestra', 'generated', 'probe.md'))).toBe(false);
    // The Runtime write API has no worktree parameter at all: it derives the target from the home.
    const written = await writeRuntimeKnowledgeFile({
      home,
      projectId,
      taskId: 'probe-task',
      fileName: 'knowledge-context.md',
      content: 'generated\n',
    });
    expect(written.relativePath).toBe('probe-task/knowledge-context.md');
    expect(written.absolutePath).toBe(join(home, 'knowledge', projectId, 'probe-task',
      'knowledge-context.md'));
    expect(readFileSync(written.absolutePath, 'utf8')).toBe('generated\n');
    // A per-Task context file is not part of the generated *layer*, so the layer stays empty.
    expect((JSON.parse((await cli(['project', 'knowledge', 'list', projectId,
      '--json'], environment)).stdout) as ListView).generatedEntryCount).toBe(0);
    // The repository is still clean of machine-generated knowledge after all of that.
    expect(existsSync(join(main.repository, '.codeestra', 'generated'))).toBe(false);
  }, 120_000);

  test('two concurrent Tasks never conflict because of machine-generated knowledge', async () => {
    // The regression this test locks down: materializing the resolved context into the Task worktree
    // made every Execution look like it changed `.codeestra/generated/knowledge-context.md`, so the
    // deterministic conflict analyzer reported `SAME_FILE` against every peer Task and a capacity
    // wait turned into a conflict refusal. Machine-generated knowledge is Runtime data now, so a
    // Task's change set contains only what its Agent produced.
    const home = temporaryDirectory('codeestra-knowledge-concurrent-home-');
    const main = await createRepository({
      prefix: 'codeestra-knowledge-concurrent',
      instructions: conventions,
    });
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: main.assets,
      CODEESTRA_PI_EXECUTABLE: main.tools };
    const projectId = await openAndIdentify(environment, main.repository, main.devRepo);

    // Neither Task declares a feature, so both are SAFE under ADR-0059 and submission starts them
    // without an UNKNOWN override. This is the concurrency behavior the regression now protects.
    const first = await createAndSubmit(environment, projectId, 'First area');
    const second = await createAndSubmit(environment, projectId, 'Second area');

    const worktrees = join(home, 'worktrees', projectId);
    await waitFor(() => Bun.file(join(worktrees, workspaceName(first), 'src', 'agent',
      `${workspaceName(first)}.ts`)).size > 0);
    await waitFor(() => Bun.file(join(worktrees, workspaceName(second), 'src', 'agent',
      `${workspaceName(second)}.ts`)).size > 0);

    for (const task of [first, second]) {
      const worktree = join(worktrees, workspaceName(task));
      const status = Bun.spawnSync({ cmd: ['git', '-C', worktree, 'status', '--porcelain', '-uall'],
        env: { PATH: Bun.env.PATH ?? '' } });
      expect(status.stdout.toString().trim().split('\n').filter((line) => line.length > 0))
        .toEqual([`?? src/agent/${workspaceName(task)}.ts`]);
      expect(existsSync(join(worktree, '.codeestra', 'generated'))).toBe(false);
    }

    // Every Execution still recorded its context and its binding, in the Runtime data directory.
    const shown = JSON.parse((await cli(['project', 'knowledge', 'show', projectId, '--json'],
      environment)).stdout) as SnapshotView;
    expect(shown.executions.map((execution) => execution.taskId).sort())
      .toEqual([first.id, second.id].sort());
    for (const execution of shown.executions) {
      expect(execution.contextPath).toBe(`${execution.taskId}/knowledge-context.md`);
      expect(existsSync(join(home, 'knowledge', projectId, execution.contextPath))).toBe(true);
    }

    // The analyzer sees only Agent work, so nothing overlaps and no `SAME_FILE` is reported.
    const explained = JSON.parse((await cli(['project', 'impact', 'explain', projectId, second.id,
      '--json'], environment)).stdout) as {
      readonly candidate: { readonly snapshot: { readonly files: readonly string[] } | null };
      readonly assessment: { readonly verdict: string; readonly reasonCodes: readonly string[] };
    };
    expect(explained.candidate.snapshot?.files).toEqual([`src/agent/${workspaceName(second)}.ts`]);
    expect(explained.assessment.reasonCodes).not.toContain('SAME_FILE');
    expect(explained.assessment.verdict).not.toBe('CONFLICTING');
  }, 120_000);

  test('a human layer that cannot be loaded refuses the Execution and reports every refusal', async () => {
    const home = temporaryDirectory('codeestra-knowledge-invalid-home-');
    const main = await createRepository({
      prefix: 'codeestra-knowledge-invalid',
      // `scpoe` is a typo for `scope`: it must fail loudly rather than silently mean "everywhere".
      instructions: '---\nscpoe: SELF\n---\nBody\n',
    });
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: main.assets,
      CODEESTRA_PI_EXECUTABLE: main.tools };
    const projectId = await openAndIdentify(environment, main.repository, main.devRepo);

    const validated = await cli(['project', 'knowledge', 'validate', projectId, '--json'],
      environment);
    expect(validated.exitCode).toBe(1);
    const validation = JSON.parse(validated.stdout) as ValidationView;
    expect(validation.code).toBe('KNOWLEDGE_LAYER_INVALID');
    expect(validation.valid).toBe(false);
    expect(validation.snapshotDigest).toBeNull();
    expect(validation.errors).toEqual([{
      layer: 'instructions',
      path: '.codeestra/instructions/conventions.md',
      code: 'KNOWLEDGE_INVALID_FRONT_MATTER',
      message: expect.any(String),
    }]);
    // A refused layer means there is no honest answer about what a run would use.
    const listed = await cli(['project', 'knowledge', 'list', projectId, '--json'], environment);
    expect(listed.exitCode).toBe(1);

    // The Task cannot be started: the refusal happens before the Execution row exists (ADR-0041 D04).
    const task = await createAndSubmit(environment, projectId, 'Change something');
    const refused = await cli(['task', 'run', projectId, task.id, String(task.version), '--json'],
      environment);
    expect(refused.exitCode).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain('KNOWLEDGE_LAYER_INVALID');
    const status = JSON.parse((await cli(['task', 'status', projectId, task.id],
      environment)).stdout) as { readonly executions: readonly unknown[] };
    expect(status.executions).toEqual([]);
    const resolve = await cli(['project', 'knowledge', 'resolve', projectId, task.id, '--json'],
      environment);
    expect(resolve.exitCode).toBe(1);
    expect((JSON.parse(resolve.stdout) as ResolveView).state).toBe('INVALID');
  }, 120_000);

  test('a machine-generated entry needs provenance, and an empty generated layer is normal', async () => {
    const home = temporaryDirectory('codeestra-knowledge-generated-home-');
    const main = await createRepository({
      prefix: 'codeestra-knowledge-generated',
      instructions: conventions,
    });
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: main.assets,
      CODEESTRA_PI_EXECUTABLE: main.tools };
    const projectId = await openAndIdentify(environment, main.repository, main.devRepo);
    const generated = join(home, 'knowledge', projectId, 'generated');

    // Absent or empty is a valid empty layer, never an error.
    expect((await cli(['project', 'knowledge', 'validate', projectId, '--json'],
      environment)).exitCode).toBe(0);

    // Content with no `.meta.json` beside it records nothing about where it came from.
    mkdirSync(generated, { recursive: true });
    await Bun.write(join(generated, 'anonymous.md'), 'no provenance\n');
    const anonymous = await cli(['project', 'knowledge', 'validate', projectId, '--json'],
      environment);
    expect(anonymous.exitCode).toBe(1);
    expect((JSON.parse(anonymous.stdout) as ValidationView).errors).toEqual([{
      layer: 'generated',
      path: 'anonymous.md',
      code: 'KNOWLEDGE_GENERATED_PROVENANCE_MISSING',
      message: expect.any(String),
    }]);

    // With provenance it is a real entry of the machine layer and participates in the digest.
    await Bun.write(join(generated, 'anonymous.meta.json'), JSON.stringify({
      version: 1, source: 'execution:probe', kind: 'runtime.knowledge-context', generatedAt: 1,
    }));
    const valid = await cli(['project', 'knowledge', 'validate', projectId, '--json'], environment);
    expect(valid.exitCode).toBe(0);
    const validation = JSON.parse(valid.stdout) as ValidationView;
    expect(validation.generatedEntryCount).toBe(1);
    expect(validation.entryCount).toBe(2);
    expect(validation.layers.find((layer) => layer.layer === 'generated')?.entryCount).toBe(1);
  }, 120_000);
});
