import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRepository } from '@codeestra/git';
import { Phase1Database } from '@codeestra/storage';

const directories: string[] = [];

export function registerTemporaryDirectory(path: string): void {
  directories.push(path);
}

export function cleanupTemporaryDirectories(): void {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

export interface AgentFixture {
  readonly storage: Phase1Database;
  readonly repo: string;
  readonly home: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly revisionId: string;
}

const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000002';
export const fixtureRevisionId = '60000000-0000-4000-8000-000000000006';

/**
 * Temporary Git repository plus an in-memory Runtime database with one READY Task.
 * Every path lives under the OS temp directory; no user repository is touched.
 */
export async function createAgentFixture(): Promise<AgentFixture> {
  const repo = mkdtempSync(join(tmpdir(), 'codeestra-agent-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'codeestra-agent-home-'));
  directories.push(repo, home);
  await git(repo, ['init', '-b', 'main']);
  await Bun.write(join(repo, 'README.md'), 'temporary repository\n');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial']);
  const identity = await inspectRepository(repo);
  const storage = new Phase1Database();
  storage.trustProject({
    id: projectId,
    trustId: '30000000-0000-4000-8000-000000000003',
    name: 'Temporary',
    repoRoot: identity.repoRoot,
    gitCommonDir: identity.gitCommonDir,
    mainRef: identity.mainRef,
    objectFormat: identity.objectFormat,
    policyVersion: 1,
    trustedAt: 1,
    actor: 'local-user',
  });
  storage.createTask({
    projectId,
    commandId: '40000000-0000-4000-8000-000000000004',
    payloadHash: 'create',
    intentId: '50000000-0000-4000-8000-000000000005',
    taskId,
    revisionId: fixtureRevisionId,
    intentEventId: '70000000-0000-4000-8000-000000000007',
    taskEventId: '80000000-0000-4000-8000-000000000008',
    specification: 'Run one Agent Session',
    constraints: [],
    kind: 'DEVELOPMENT',
    actor: 'local-user',
    createdAt: 2,
  });
  storage.submitTask({
    projectId,
    taskId,
    expectedVersion: 0,
    commandId: '90000000-0000-4000-8000-000000000009',
    payloadHash: 'submit',
    eventId: 'a0000000-0000-4000-8000-00000000000a',
    actor: 'local-user',
    submittedAt: 3,
  });
  return { storage, repo: identity.repoRoot, home: realpathSync(home), projectId, taskId,
    revisionId: fixtureRevisionId };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error('Timed out waiting for the expected Runtime state');
}
