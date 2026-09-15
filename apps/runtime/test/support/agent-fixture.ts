import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
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
  /** The second clone of the same origin, on `refs/heads/dev`: where every dev fact lives now. */
  readonly devRepo: string;
  readonly home: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly revisionId: string;
  /** Main commit that carries the committed verification policy. */
  readonly mainCommit: string;
  readonly verificationPolicy: { readonly state: 'ABSENT' | 'PRESENT'; readonly digest: string | null };
}

/**
 * Gives a fixture repository the second, independent clone ADR-0056 requires: same `origin`, HEAD on
 * the project's `dev` branch, and a separate Git common directory (a worktree of the same clone would
 * be refused by `inspectDevRepo`, so a bare origin plus a real `clone` is the honest shape).
 *
 * Returns the dev clone's canonical path, which is what `project trust --dev-repo` records.
 */
export async function provisionDevClone(input: {
  readonly repository: string;
  /** Branch that must exist in the repository and be checked out in the clone. */
  readonly devBranch?: string;
  /** Remote name to share; `origin` is what the Runtime verifies against. */
  readonly remote?: string;
}): Promise<string> {
  const devBranch = input.devBranch ?? 'dev';
  const remote = input.remote ?? 'origin';
  const originPath = mkdtempSync(join(tmpdir(), 'codeestra-fixture-origin-'));
  registerTemporaryDirectory(originPath);
  await git(originPath, ['init', '--bare', '-q', '-b', 'main']);
  // `remote add` fails when the name is already configured; a fixture that calls this twice should
  // get a clear error rather than a second, silently different origin.
  await git(input.repository, ['remote', 'add', remote, originPath]);
  await git(input.repository, ['push', '-q', remote, 'main', devBranch]);
  const dev = mkdtempSync(join(tmpdir(), 'codeestra-fixture-dev-'));
  registerTemporaryDirectory(dev);
  await git(dev, ['clone', '-q', originPath, '.']);
  await git(dev, ['checkout', '-q', devBranch]);
  // A `git clone` does not inherit the fixture repository's local configuration, and the Runtime
  // writes commits in worktrees of *this* clone, so the fixture's identity is set again here. A test
  // must never resolve the developer's global Git identity.
  for (const key of ['user.name', 'user.email'] as const) {
    const configured = await gitOrNull(input.repository, ['config', '--get', key]);
    if (configured !== null) await git(dev, ['config', key, configured]);
  }
  return realpathSync(dev);
}

/** `git`, but a non-zero exit is reported as `null` instead of thrown (for optional configuration). */
async function gitOrNull(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/**
 * Fast-forwards the dev clone's own `dev` checkout to the main checkout's current `dev` commit, the way
 * a person would after committing on the dev branch: fetch (never into a checked-out ref) and then
 * fast-forward. A fixture that moves the main checkout's `dev` has to call this, because ADR-0056 makes
 * the dev clone's branch the baseline every dev fact is read from.
 */
export async function syncDevClone(input: {
  readonly devRepo: string;
  readonly repository: string;
  readonly devBranch?: string;
}): Promise<void> {
  const devBranch = input.devBranch ?? 'dev';
  await git(input.devRepo, ['fetch', '-q', input.repository, `refs/heads/${devBranch}`]);
  await git(input.devRepo, ['merge', '-q', '--ff-only', 'FETCH_HEAD']);
}

export interface AgentFixtureOptions {
  /** Commands committed to `.codeestra/policies/verification.json` before trust. */
  readonly verificationCommands?: readonly VerificationCommand[];
  /** Omit the policy file entirely, so the project has no verification policy. */
  readonly withoutVerificationPolicy?: boolean;
  /**
   * Contents of `.codeestra/instructions/conventions.md` committed to `main` **before** trust.
   * Knowledge is read from the project's `main` ref, so a fixture that needs Project Knowledge has
   * to commit it before the project is trusted (ADR-0041).
   */
  readonly instructions?: string;
  /**
   * Contents of one machine-generated knowledge entry (`<home>/knowledge/<project>/generated/...`)
   * written before trust, so a fixture can tell the human layer apart from the machine layer.
   */
  readonly generatedKnowledge?: string;
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
  if (options.instructions !== undefined) {
    mkdirSync(join(repo, '.codeestra', 'instructions'), { recursive: true });
    await Bun.write(join(repo, '.codeestra', 'instructions', 'conventions.md'), options.instructions);
    await git(repo, ['add', '.codeestra/instructions/conventions.md']);
  }
  // The machine-generated layer lives in the Runtime data directory, never in the repository
  // (ADR-0041 D05), so a fixture that wants one writes it there. Provenance is mandatory in that
  // layer: an entry without its `<name>.meta.json` sidecar is refused, not accepted as anonymous
  // text (PROJECT_SPEC §4).
  if (options.generatedKnowledge !== undefined) {
    const generatedRoot = join(home, 'knowledge', projectId, 'generated');
    mkdirSync(generatedRoot, { recursive: true });
    await Bun.write(join(generatedRoot, 'machine-notes.md'), options.generatedKnowledge);
    await Bun.write(join(generatedRoot, 'machine-notes.meta.json'), `${JSON.stringify({
      version: 1,
      source: 'fixture',
      kind: 'generated',
    }, null, 2)}\n`);
  }
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
  // one. ADR-0056: that branch is read from the project's dev clone, so the fixture provisions a
  // second clone of the same origin with `dev` checked out.
  await git(repo, ['branch', 'dev']);
  const devRepo = await provisionDevClone({ repository: repo });
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
    devRepoPath: devRepo,
    recordDevRepoPath: true,
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
  return { storage, repo: identity.repoRoot, devRepo, home: realpathSync(home), projectId, taskId,
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
