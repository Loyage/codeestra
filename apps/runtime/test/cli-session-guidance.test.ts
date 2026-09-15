import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

/**
 * What this file proves, through the real CLI and the real Runtime: `session guide` and
 * `session guidance list|get` are a complete, scriptable command face (ADR-0008), a guidance message
 * recorded before anything runs is handed to the next Execution as a launch argument, the durable
 * record and the artifact each Execution was launched with are readable from the ledger, and the exit
 * code separates "handed over or recorded with nothing running" (0) from "a provider was asked and
 * did not take it" (1).
 *
 * What it does NOT prove: that a real provider read the guidance, and the live-conversation delivery
 * path (Pi's RPC `steer`) — that one needs a running provider turn and is covered by the Runtime
 * service test plus the Adapter channel test with a protocol stub, never by a real model here
 * (ADR-0038: no real model requests on a lane branch).
 *
 * **The fixture trusts a real dev clone** (ADR-0056). This lane's base predates `dev_repo_path` being
 * required, so `open <repo> --no-open` alone registered a project with **no** dev clone here and this
 * e2e stayed green on the lane while the same call is refused with `DEV_REPO_REQUIRED` on the merged
 * `dev`. The fixture therefore provisions the second, independent clone ADR-0056 describes (bare
 * origin shared with the main checkout, HEAD on the project's `dev` branch) and names it explicitly
 * on the trust command, which is the shape both contracts accept.
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
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Guidance Test',
      GIT_AUTHOR_EMAIL: 'guidance@example.invalid', GIT_COMMITTER_NAME: 'Guidance Test',
      GIT_COMMITTER_EMAIL: 'guidance@example.invalid' } });
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
 * A protocol stub, not a real provider: it records the launch argv it was given, writes one file into
 * the Task worktree and settles one turn. The argv report is what makes "the guidance reached the
 * provider as a launch argument" checkable instead of asserted.
 */
const stubSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) { process.stdout.write('0.85.1\\n'); process.exit(0); }
const sessionDirIndex = argv.indexOf('--session-dir');
const sessionDir = sessionDirIndex >= 0 ? argv[sessionDirIndex + 1] : process.cwd();
mkdirSync(sessionDir, { recursive: true });
const taskId = basename(process.cwd());
writeFileSync(join(sessionDir, 'argv-report-' + taskId + '.json'), JSON.stringify({ argv }) + '\\n');
const sessionFile = join(sessionDir, 'guidance-session-' + taskId + '.jsonl');
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
        sessionId: 'guidance-session-' + taskId, sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      const directory = join(process.cwd(), 'src', 'agent');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, taskId + '.ts'), 'export const task = ' +
        JSON.stringify(taskId) + ';\\n');
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'guidance-session-' + taskId, timestamp: '2026-09-16T09:00:00.000Z',
        cwd: process.cwd() }) + '\\n');
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Wrote the file.' }], stopReason: 'stop' } });
      emit({ type: 'agent_settled' });
    }
  }
}
`;

interface TaskPayload {
  readonly id: string;
  readonly state: string;
  readonly version: number;
}

interface GuidanceView {
  readonly id: string;
  readonly state: string;
  readonly body: string;
  readonly attempts: readonly { readonly state: string; readonly evidenceRef: string | null }[];
}

interface GuidanceList {
  readonly taskId: string;
  readonly guidance: readonly GuidanceView[];
  readonly launchedWith: readonly { readonly executionId: string; readonly guidanceIds: readonly string[];
    readonly contextDigest: string; readonly contextBytes: number }[];
}

interface GuidanceRecordResult {
  readonly guidance: GuidanceView;
  readonly outcome: string;
  readonly code: string | null;
  readonly detail: string;
  readonly modelAcknowledgement: string;
}

const message = 'Prefer the repository conventions file over ad-hoc styling.';

interface RepositoryFixture {
  readonly repository: string;
  readonly tools: string;
  readonly assets: string;
  /** The second, independent clone ADR-0056 requires; its path is what `--dev-repo` records. */
  readonly devClone: string;
}

/**
 * Gives the fixture repository the dev clone ADR-0056 resolves every dev fact from.
 *
 * The shape is dictated by `inspectDevRepo`, not by what would make a test pass quickly, and each of
 * its four checks is satisfied by a real Git object rather than by a relaxed assertion:
 *
 * 1. **another clone** — a bare `origin` plus an actual `git clone` of it, so the worktree root and
 *    the Git common directory both differ from the main checkout's (a worktree of the main checkout
 *    would share the common directory and be refused as `DEV_REPO_NOT_SEPARATE`);
 * 2. **the same origin** — the main checkout pushes to the bare repository the clone fetches from, so
 *    both report the identical `origin` URL (`DEV_REPO_ORIGIN_MISMATCH` otherwise);
 * 3. **HEAD on the project's `dev` branch** — `git checkout dev` in the clone
 *    (`DEV_REPO_BRANCH_MISMATCH` otherwise);
 * 4. **that branch exists locally** — `git push origin main dev` gives the clone a local
 *    `refs/heads/dev` (`DEV_REPO_DEV_REF_MISSING` otherwise).
 *
 * The canonical path is returned, because that is the path the Runtime compares against its own
 * inspection of the main checkout. The clone gets the fixture's local identity too: a `git clone`
 * does not inherit it, and a test must never resolve the developer's global Git identity.
 */
async function provisionDevClone(repository: string): Promise<string> {
  const origin = temporaryDirectory('codeestra-guidance-origin-');
  await git(origin, ['init', '--bare', '-q', '-b', 'main']);
  await git(repository, ['remote', 'add', 'origin', origin]);
  await git(repository, ['push', '-q', 'origin', 'main', 'dev']);
  const clone = temporaryDirectory('codeestra-guidance-dev-');
  await git(clone, ['clone', '-q', origin, '.']);
  await git(clone, ['checkout', '-q', 'dev']);
  await git(clone, ['config', 'user.name', 'Guidance Test']);
  await git(clone, ['config', 'user.email', 'guidance@example.invalid']);
  return realpathSync(clone);
}

async function createRepository(prefix: string): Promise<RepositoryFixture> {
  const repository = temporaryDirectory(`${prefix}-repo-`);
  const tools = temporaryDirectory(`${prefix}-tools-`);
  const assets = temporaryDirectory(`${prefix}-assets-`);
  await Bun.write(join(assets, 'index.html'), '<!doctype html><title>Codeestra</title>');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  await git(repository, ['branch', 'dev']);
  const stubPath = join(tools, 'stub-pi.ts');
  const shimPath = join(tools, 'pi');
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);
  const devClone = await provisionDevClone(repository);
  return { repository, tools: shimPath, assets, devClone };
}

describe('session guidance command face', () => {
  test('records guidance, hands it to the next Execution and never becomes a TaskRevision', async () => {
    const home = temporaryDirectory('codeestra-guidance-home-');
    const main = await createRepository('codeestra-guidance');
    const environment = { CODEESTRA_HOME: home, CODEESTRA_UI_DIST: main.assets,
      CODEESTRA_PI_EXECUTABLE: main.tools };
    // The dev clone is named explicitly, so this registration is accepted by the contract this lane's
    // base has (`--dev-repo` optional, but verified when given) **and** by ADR-0056's
    // (`DEV_REPO_REQUIRED` without one). A clone that failed any of the four checks is refused by
    // trust itself, so a green exit here is evidence the fixture is genuinely usable.
    const trusted = await cli(['project', 'trust', main.repository, '--dev-repo', main.devClone,
      '--yes'], environment);
    expect(trusted.exitCode).toBe(0);
    const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
      readonly { readonly id: string }[];
    const projectId = projects[0]?.id as string;
    // The recorded fact, not the fixture's intention: the project's dev clone path is the one this
    // test provisioned (the Runtime resolved it to its canonical form).
    const inspected = JSON.parse((await cli(['project', 'inspect', main.repository],
      environment)).stdout) as {
      readonly devRepoPath: { readonly path: string; readonly verified: boolean } | null;
    };
    expect(inspected.devRepoPath?.verified).toBe(true);
    expect(realpathSync(inspected.devRepoPath?.path as string)).toBe(main.devClone);
    const created = JSON.parse((await cli(['task', 'create', projectId, 'Change the first area'],
      environment)).stdout) as TaskPayload;
    expect((await cli(['task', 'submit', projectId, created.id, '0'], environment)).exitCode).toBe(0);

    // Nothing is running yet: the guidance is durably recorded, no attempt is opened, and the command
    // reports that honestly instead of pretending a delivery happened.
    const recorded = await cli(['session', 'guide', projectId, created.id, '--message', message,
      '--json'], environment);
    expect(recorded.exitCode).toBe(0);
    const result = JSON.parse(recorded.stdout) as GuidanceRecordResult;
    expect(result.outcome).toBe('RECORDED');
    expect(result.code).toBeNull();
    expect(result.modelAcknowledgement).toBe('UNSUPPORTED');
    expect(result.guidance.body).toBe(message);
    expect(result.guidance.attempts).toEqual([]);

    // A guidance message is not a revision: the Task still has exactly one revision.
    const revisions = JSON.parse((await cli(['task', 'revision', 'list', projectId, created.id],
      environment)).stdout) as { readonly revisions: readonly unknown[] };
    expect(revisions.revisions).toHaveLength(1);

    const run = await cli(['task', 'run', projectId, created.id, '1'], environment);
    expect(run.exitCode).toBe(0);
    const worktree = join(realpathSync(home), 'worktrees', projectId, created.id);
    await waitFor(() => existsSync(join(worktree, 'src', 'agent', `${created.id}.ts`)));

    // The artifact the Runtime materialized from the ledger, never a worktree file (ADR-0057).
    const artifactPath = join(home, 'guidance', projectId, created.id, 'guidance-context.md');
    expect(readFileSync(artifactPath, 'utf8')).toContain(message);
    const sessionDir = join(home, 'pi-sessions');
    const reportName = readdirSync(sessionDir)
      .find((entry) => entry.startsWith('argv-report-') && entry.includes(created.id));
    expect(reportName).toBeDefined();
    const reportPath = join(sessionDir, reportName as string);
    const argv = (JSON.parse(readFileSync(reportPath as string, 'utf8')) as {
      readonly argv: readonly string[] }).argv;
    // The last two arguments are the guidance append: the user's guidance reached the provider as a
    // launch argument, which is what makes it survive the process it was first given to.
    expect(argv.slice(-2)).toEqual(['--append-system-prompt', artifactPath]);

    // The ledger reports the record, its (absent) attempts, and the artifact that Execution was
    // launched with — the fact asserted above is readable, not merely claimed.
    const listed = JSON.parse((await cli(['session', 'guidance', 'list', projectId, created.id,
      '--json'], environment)).stdout) as GuidanceList;
    expect(listed.guidance).toHaveLength(1);
    expect(listed.guidance[0]?.id).toBe(result.guidance.id);
    expect(listed.guidance[0]?.body).toBe(message);
    expect(listed.launchedWith).toHaveLength(1);
    expect(listed.launchedWith[0]?.guidanceIds).toEqual([result.guidance.id]);
    expect(listed.launchedWith[0]?.contextDigest)
      .toMatch(/^[0-9a-f]{64}$/);

    const single = JSON.parse((await cli(['session', 'guidance', 'get', projectId,
      result.guidance.id, '--json'], environment)).stdout) as GuidanceView;
    expect(single.id).toBe(result.guidance.id);
    expect(single.body).toBe(message);

    // `task amend` is still the only specification path: it appends a revision and moves the Task's
    // current revision, which guidance never did.
    // The Task's version moved when the Execution was reserved, so the amend reads the current one
    // rather than assuming the version the guidance saw.
    const status = JSON.parse((await cli(['task', 'status', projectId, created.id, '--json'],
      environment)).stdout) as { readonly task: { readonly version: number } };
    const amended = await cli(['task', 'revision', 'create', projectId, created.id,
      String(status.task.version), '--specification', 'A changed acceptance criterion',
      '--reason', 'the user changed the requirement', '--json'], environment);
    expect(amended.exitCode).toBe(0);
    const after = JSON.parse((await cli(['task', 'revision', 'list', projectId, created.id],
      environment)).stdout) as { readonly revisions: readonly unknown[] };
    expect(after.revisions).toHaveLength(2);
    // ...and the guidance record is unchanged by it: the two channels are separate facts.
    const stillThere = JSON.parse((await cli(['session', 'guidance', 'list', projectId, created.id,
      '--json'], environment)).stdout) as GuidanceList;
    expect(stillThere.guidance).toHaveLength(1);
    expect(stillThere.guidance[0]?.state).toBe('RECORDED');
  }, 120_000);

  test('refuses a usage error instead of recording an empty message', async () => {
    const home = temporaryDirectory('codeestra-guidance-home-');
    const environment = { CODEESTRA_HOME: home };
    const blank = await cli(['session', 'guide', crypto.randomUUID(), crypto.randomUUID(),
      '--message', '   '], environment);
    expect(blank.exitCode).toBe(2);
  }, 60_000);
});
