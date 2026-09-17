import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => {
  // The Runtime is a daemon: teardown stops any Runtime this test started, including one started by
  // a read-only command, before the temporary home is removed.
  await reclaimTestResources();
});

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

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn({
    cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Task Create Test',
      GIT_AUTHOR_EMAIL: 'task-create@example.invalid', GIT_COMMITTER_NAME: 'Task Create Test',
      GIT_COMMITTER_EMAIL: 'task-create@example.invalid' },
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

interface TaskCreateView {
  readonly id: string;
  readonly displayNumber: number;
  readonly displayTitle: string;
  readonly namingTitle: string | null;
  readonly currentRevision: { readonly specification: string };
}

/**
 * A trusted temporary project on an isolated Runtime home. `task create` needs a Project ID, so the
 * project is registered through the same `open` path a user would take; no Agent or provider is
 * involved anywhere in this file.
 */
async function trustedProject(): Promise<{ environment: Record<string, string>; projectId: string }> {
  const repository = temporaryDirectory('codeestra-task-create-repo-');
  const home = temporaryDirectory('codeestra-task-create-home-');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  // ADR-0009: the long-lived dev branch is the baseline every workspace is created from.
  await git(repository, ['branch', 'dev']);
  // ADR-0056: every dev fact comes from a second clone of the same origin that sits on
  // `dev`; the project is trusted with it explicitly.

  const environment = { CODEESTRA_HOME: home };
  const opened = await cli(['project', 'trust', repository], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  return { environment, projectId: projects[0]?.id as string };
}

describe('codeestra task create', () => {
  test('stores the two required titles and the detail on the first revision (ADR-0065)', async () => {
    const { environment, projectId } = await trustedProject();
    const created = await cli(['task', 'create', '--project', projectId, 'Fix', 'the', 'parser',
      '--title', '修复 parser 的 CRLF 输入', '--name', 'fix-parser-crlf'],
    environment);
    expect(created.exitCode).toBe(0);
    const view = JSON.parse(created.stdout) as TaskCreateView;
    expect(view.displayTitle).toBe('修复 parser 的 CRLF 输入');
    expect(view.namingTitle).toBe('fix-parser-crlf');
    // The positional text stays a free-form multi-word detail, exactly as before.
    expect(view.currentRevision.specification).toBe('Fix the parser');

    // The three fields are stored facts, not just an echo of the command.
    const listed = JSON.parse((await cli(['task', 'list', '--project', projectId], environment)).stdout) as
      readonly TaskCreateView[];
    expect(listed[0]).toMatchObject({
      displayTitle: '修复 parser 的 CRLF 输入',
      namingTitle: 'fix-parser-crlf',
      currentRevision: { specification: 'Fix the parser' },
    });
  });

  test('requires both titles and refuses the removed flags without creating anything', async () => {
    const { environment, projectId } = await trustedProject();
    const titleOnly = await cli(['task', 'create', '--project', projectId, 'Detail', '--title', 'A title'],
      environment);
    expect(titleOnly.exitCode).toBe(2);
    const nameOnly = await cli(['task', 'create', '--project', projectId, 'Detail', '--name', 'a-name'],
      environment);
    expect(nameOnly.exitCode).toBe(2);
    const noDetail = await cli(['task', 'create', '--project', projectId, '--title', 'A title',
      '--name', 'a-name'], environment);
    expect(noDetail.exitCode).toBe(2);
    // ADR-0065 D04: `--constraint` and `--kind` are gone, so they are unknown flags now.
    for (const removed of [['--constraint', 'x'], ['--kind', 'DEVELOPMENT']]) {
      const refused = await cli(['task', 'create', '--project', projectId, 'Detail', '--title', 'A title',
        '--name', 'a-name', ...removed], environment);
      expect(refused.exitCode).toBe(2);
    }
    expect(JSON.parse((await cli(['task', 'list', '--project', projectId], environment)).stdout)).toEqual([]);
  });

  test('refuses a naming title that is not a lowercase slug, and an unknown flag', async () => {
    const { environment, projectId } = await trustedProject();
    for (const namingTitle of ['Has Spaces', 'Upper', 'trailing-', 'double--dash', '1-leading']) {
      const refused = await cli(['task', 'create', '--project', projectId, 'Detail', '--title', 'A title',
        '--name', namingTitle], environment);
      expect(refused.exitCode).toBe(2);
    }
    const unknown = await cli(['task', 'create', '--project', projectId, 'Spec', '--title', 'A title',
      '--name', 'a-name', '--nope'], environment);
    expect(unknown.exitCode).toBe(2);
    expect(JSON.parse((await cli(['task', 'list', '--project', projectId], environment)).stdout)).toEqual([]);
  });
});
