import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseVerificationPolicy,
  verificationPolicyDigest,
  verificationPolicyPath,
  type VerificationCommand,
} from '@codeestra/contracts';
import { inspectRepository } from '@codeestra/git';
import { Phase1Database } from '@codeestra/storage';
import {
  cleanupTemporaryDirectories,
  registerTemporaryDirectory,
} from './runtime-reclamation.js';

// The fixture registry lives in `runtime-reclamation.ts` so Runtime homes and plain fixture
// directories are reclaimed from one place (FOUNDATION-057).
export { cleanupTemporaryDirectories, registerTemporaryDirectory };

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
  /** Main commit that carries the committed verification policy. */
  readonly mainCommit: string;
  readonly verificationPolicy: { readonly state: 'ABSENT' | 'PRESENT'; readonly digest: string | null };
}

export interface AgentFixtureOptions {
  /** Commands committed to `.codeestra/policies/verification.json` before trust. */
  readonly verificationCommands?: readonly VerificationCommand[];
  /** Omit the policy file entirely, so the project has no verification policy. */
  readonly withoutVerificationPolicy?: boolean;
}

const defaultVerificationCommands = [{ id: 'smoke', argv: ['echo', 'verification-ok'],
  cwd: '.', timeoutSeconds: 60 }];

const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000002';
export const fixtureRevisionId = '60000000-0000-4000-8000-000000000006';

/**
 * Temporary Git repository plus an in-memory Runtime database with one READY Task.
 * Every path lives under the OS temp directory; no user repository is touched.
 */
export async function createAgentFixture(options: AgentFixtureOptions = {}): Promise<AgentFixture> {
  const repo = mkdtempSync(join(tmpdir(), 'codeestra-agent-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'codeestra-agent-home-'));
  registerTemporaryDirectory(repo);
  registerTemporaryDirectory(home);
  await git(repo, ['init', '-b', 'main']);
  // Repository-local identity only: the fixture never writes global Git config.
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await Bun.write(join(repo, 'README.md'), 'temporary repository\n');
  // The project lockfile: the dev full-suite evidence binds its digest (ADR-0039), and a fixture
  // that modelled a Bun project without one could not exercise that binding at all.
  await Bun.write(join(repo, 'bun.lock'), '{\n  "lockfileVersion": 1\n}\n');
  await git(repo, ['add', 'README.md', 'bun.lock']);
  let verificationPolicy: AgentFixture['verificationPolicy'] = { state: 'ABSENT', digest: null };
  if (options.withoutVerificationPolicy !== true) {
    const commands = options.verificationCommands ?? defaultVerificationCommands;
    const policy = parseVerificationPolicy(JSON.stringify({ version: 1, commands }));
    await Bun.write(join(repo, verificationPolicyPath), `${JSON.stringify(policy, null, 2)}\n`);
    verificationPolicy = { state: 'PRESENT', digest: verificationPolicyDigest(policy) };
    await git(repo, ['add', verificationPolicyPath]);
  }
  await git(repo, ['commit', '-m', 'initial']);
  // ADR-0009: every Task worktree is based on the long-lived `dev` branch, so the fixture repo has
  // one. It starts at the same commit as `main` and is never checked out here.
  await git(repo, ['branch', 'dev']);
  const identity = await inspectRepository(repo);
  const storage = new Phase1Database();
  storage.trustProject({
    id: projectId,
    trustId: '30000000-0000-4000-8000-000000000003',
    name: 'Temporary',
    repoRoot: identity.repoRoot,
    gitCommonDir: identity.gitCommonDir,
    mainRef: identity.mainRef,
    devRef: 'refs/heads/dev',
    objectFormat: identity.objectFormat,
    policyVersion: 1,
    verificationPolicyConfirmationId: 'b0000000-0000-4000-8000-00000000000b',
    verificationPolicy: {
      state: verificationPolicy.state,
      digest: verificationPolicy.digest,
      mainRef: identity.mainRef,
      mainCommit: identity.headCommit,
    },
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
    revisionId: fixtureRevisionId, mainCommit: identity.headCommit, verificationPolicy };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error('Timed out waiting for the expected Runtime state');
}
