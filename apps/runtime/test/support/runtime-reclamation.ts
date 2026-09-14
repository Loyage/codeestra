import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  inspectRuntimeHome,
  readProcessStartToken,
  readProcessState,
  type RuntimeHomeInspection,
  type RuntimeOwnershipRecord,
} from '../../src/lifecycle.js';

/**
 * Shared reclamation for tests that drive the real command face (FOUNDATION-057).
 *
 * The defect this module exists for: the Runtime is a daemon. A CLI invocation in a test starts one
 * through `ensureRuntime` as an `unref`'d child, and that child outlives the test process. Tests that
 * stopped their Runtime as the *last statement of the test body* leaked it whenever an earlier
 * assertion failed, and `cleanupTemporaryDirectories()` then deleted the home out from under the
 * still-running process — an orphan that no client could reach and that is hard to attribute later.
 *
 * Three rules make the reclamation safe to run on every teardown, including a failing one:
 *
 * 1. **Ownership first.** A process is only signalled when the record it wrote is provably about
 *    *this* worktree: its `cwd` is this worktree, its `argv` names this worktree's Runtime entry, its
 *    OS start token matches the recorded one, its home is a temporary directory, and it is not this
 *    test process. Anything that cannot be proven is reported and left alone — never killed by name,
 *    never killed on a guess.
 * 2. **SIGTERM, then wait.** The Runtime's own ordered shutdown runs; only if it does not exit inside
 *    the grace is it reported as unconfirmed. This module never sends SIGKILL.
 * 3. **Evidence over tidiness.** A directory is kept (and its path printed) when a process could not
 *    be stopped or when a test explicitly asked to preserve the failure scene.
 *
 * `normalizeRuntimeEnvironment` is the safety floor: every test CLI invocation must name a temporary
 * `CODEESTRA_HOME`, so a test can never connect to the developer's real Runtime.
 */

/** The worktree this test file belongs to; never a path outside it is ever signalled. */
export const repositoryRoot = resolve(import.meta.dir, '..', '..', '..', '..');
export const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');
const runtimeEntry = join(repositoryRoot, 'apps', 'runtime', 'src', 'main.ts');

/** How long a stopped Runtime may take to finish its own ordered shutdown. */
const defaultStopGraceMs = 15_000;

const temporaryDirectories: string[] = [];
const runtimeHomes = new Set<string>();
const runtimeChildren = new Map<number, string>();
let evidenceReason: string | null = null;

/**
 * Filesystem path with every symlinked ancestor resolved (`/var` and `/private/var` are the same
 * directory on macOS, and fixtures use both spellings).
 */
function canonical(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  let resolved = current;
  try {
    resolved = realpathSync(current);
  } catch { /* The ancestor is gone between the check and the read; keep the logical path. */ }
  return resolve(resolved, ...missing);
}

const temporaryRoot = canonical(tmpdir());

/** True only for paths inside the OS temporary directory. A real home never passes this. */
export function isTemporaryPath(path: string): boolean {
  const target = canonical(path);
  return target === temporaryRoot || target.startsWith(`${temporaryRoot}${sep}`);
}

/** Registers a temporary fixture directory so teardown can reclaim it on success and failure. */
export function registerTemporaryDirectory(path: string): void {
  temporaryDirectories.push(path);
}

/**
 * Legacy synchronous cleanup, kept for the fixture-only tests that never start a Runtime.
 *
 * It refuses to delete a directory that still holds a Runtime lock: deleting the home of a live
 * Runtime is exactly how a leaked process becomes unreachable. Such a directory is reported instead,
 * so the failure is visible rather than tidied away. Tests that start Runtimes use
 * `reclaimTestResources()`, which stops them first and then removes the directory.
 */
export function cleanupTemporaryDirectories(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    const locks = [join(directory, 'runtime.lock'), join(directory, 'home', 'runtime.lock')];
    if (locks.some((path) => existsSync(path))) {
      console.error(`[test-reclamation] kept ${directory}: it still holds a Runtime lock; use`
        + ' reclaimTestResources() so the Runtime is stopped before its home is deleted');
      continue;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Registers a Runtime home explicitly (used when a home is a subdirectory of a fixture dir). */
export function registerRuntimeHome(home: string): void {
  runtimeHomes.add(resolve(home));
}

/** Registers a Runtime process this test spawned itself, so teardown can also account for it. */
export function registerRuntimeProcess(pid: number, home: string): void {
  runtimeChildren.set(pid, resolve(home));
}

/** Creates a fresh temporary directory and registers it in one step. */
export function temporaryFixtureDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

/**
 * The safety floor for CLI-driving tests. The returned environment is exactly the caller's, with
 * `CODEESTRA_HOME` normalized to an absolute path; the value is validated rather than defaulted so a
 * test that forgets it fails loudly instead of talking to the developer's real Runtime.
 */
export function normalizeRuntimeEnvironment(
  environment: Record<string, string>,
): Record<string, string> {
  const home = environment['CODEESTRA_HOME'];
  if (home === undefined || home.length === 0) {
    throw new Error('A test CLI invocation must set CODEESTRA_HOME so it can never reach the real'
      + ' Runtime home; use a temporary fixture home instead');
  }
  if (!isTemporaryPath(home)) {
    throw new Error(`Refusing to run a test CLI against ${home}: a test home must live inside`
      + ` ${temporaryRoot}, never a real or stable Runtime home`);
  }
  const normalized = resolve(home);
  runtimeHomes.add(normalized);
  return { ...environment, CODEESTRA_HOME: normalized };
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCliOptions {
  /** Defaults to this worktree's CLI entry. */
  readonly entry?: string;
  /** Defaults to this worktree, matching how a person would run the CLI from the repository. */
  readonly cwd?: string;
}

/**
 * Runs the CLI the way the tests did before, but through the `CODEESTRA_HOME` safety floor so the
 * home is registered for reclamation. The returned shape is unchanged.
 */
export async function runCli(
  args: readonly string[],
  environment: Record<string, string>,
  options: RunCliOptions = {},
): Promise<CliResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, options.entry ?? cliEntry, ...args],
    cwd: options.cwd ?? repositoryRoot,
    env: { ...Bun.env, ...normalizeRuntimeEnvironment(environment), no_proxy: '127.0.0.1,localhost' },
    // stdin is /dev/null so an unanswered confirmation fails immediately instead of hanging.
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Declares that this test wants its failure scene kept on disk. Nothing is deleted, and every path
 * is printed so a person can find it. The reason is written into the reclamation report.
 */
export function preserveFailureEvidence(reason: string): void {
  evidenceReason = reason;
}

export interface StoppedRuntime {
  readonly pid: number;
  readonly home: string;
  readonly waitedMs: number;
}

export interface UnattributedProcess {
  readonly pid: number;
  readonly home: string;
  readonly detail: string;
  /**
   * True when the record looks like this worktree's own Runtime (cwd and argv match, and it is not
   * this test session) but ownership still could not be proven. Only these are printed: a test
   * fixture's synthetic lock record is recorded but is not worth a warning on every teardown.
   */
  readonly looksOwned: boolean;
}

export interface UnconfirmedProcess {
  readonly pid: number;
  readonly home: string;
  readonly detail: string;
}

export interface ReclamationReport {
  /** Processes this worktree provably owned, signalled with SIGTERM and confirmed gone. */
  readonly stopped: readonly StoppedRuntime[];
  /** Processes that could not be attributed to this worktree; never signalled. */
  readonly unattributed: readonly UnattributedProcess[];
  /** Processes this worktree owned that were still running after the grace period. */
  readonly unconfirmed: readonly UnconfirmedProcess[];
  readonly removedDirectories: readonly string[];
  readonly preservedDirectories: readonly string[];
  /** The explicit reason a test gave for keeping its evidence, or null. */
  readonly evidenceReason: string | null;
}

export interface ReclaimOptions {
  /** Keeps every fixture directory of this test instead of deleting it. */
  readonly preserveEvidence?: string;
  /** Fails the teardown when an owned Runtime did not exit inside the grace. Defaults to true. */
  readonly strict?: boolean;
  readonly stopGraceMs?: number;
}

function runtimeEntryArguments(record: RuntimeOwnershipRecord): boolean {
  return record.argv.some((argument) => resolve(record.cwd, argument) === runtimeEntry);
}

/**
 * The three-way ownership gate. `OWNED` is the only verdict that permits a signal; every other
 * outcome is an explanation for why this process is not ours to stop.
 */
async function attribute(home: string, record: RuntimeOwnershipRecord): Promise<Attribution> {
  const pointsHere = resolve(record.cwd) === repositoryRoot && runtimeEntryArguments(record)
    && record.pid !== process.pid && record.pid !== process.ppid;
  const foreign = (detail: string): Attribution =>
    ({ verdict: 'UNATTRIBUTED', detail, looksOwned: pointsHere });
  if (!isTemporaryPath(home)) {
    return foreign(`home ${home} is not under ${temporaryRoot}`);
  }
  if (record.pid === process.pid || record.pid === process.ppid || record.pid <= 1) {
    return foreign(`pid ${record.pid} is this test session, not a Runtime`);
  }
  if (resolve(record.cwd) !== repositoryRoot) {
    return foreign(`recorded cwd ${record.cwd} is not this worktree`);
  }
  if (!runtimeEntryArguments(record)) {
    return foreign(`recorded argv does not name ${runtimeEntry}`);
  }
  // It can exit between the inspection and this check (a test may have stopped it through the
  // command face in the meantime); that is not a leak and not an ownership question.
  const state = await readProcessState(record.pid);
  if (state === 'GONE' || state === 'ZOMBIE') return { verdict: 'STOPPED' };
  const token = await readProcessStartToken(record.pid);
  if (record.startToken === null || token === null) {
    const after = await readProcessState(record.pid);
    if (after === 'GONE' || after === 'ZOMBIE') return { verdict: 'STOPPED' };
    return foreign(`no comparable start token (recorded ${record.startToken ?? 'null'}, observed`
      + ` ${token ?? 'null'}); ownership is unproven`);
  }
  if (token !== record.startToken) {
    return foreign(`pid ${record.pid} was reused by another process`);
  }
  return { verdict: 'OWNED' };
}

/** The OS's own command line for a PID, used to re-verify a process this test spawned itself. */
async function processCommandLine(pid: number): Promise<string | null> {
  try {
    const child = Bun.spawn(['ps', '-o', 'command=', '-p', String(pid)], {
      stdout: 'pipe', stderr: 'ignore',
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited, new Response(child.stdout).text(),
    ]);
    return exitCode === 0 && stdout.trim().length > 0 ? stdout : null;
  } catch {
    return null;
  }
}

async function stopWithSigterm(pid: number, graceMs: number): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    // ESRCH means it exited between the check and the signal: the outcome we want.
    if ((error as { readonly code?: string }).code === 'ESRCH') return true;
    return false;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const state = await readProcessState(pid);
    // A zombie has already exited; UNKNOWN fails closed and keeps waiting.
    if (state === 'GONE' || state === 'ZOMBIE') return true;
    await Bun.sleep(50);
  }
  return (await readProcessState(pid)) === 'GONE' || (await readProcessState(pid)) === 'ZOMBIE';
}

interface Candidate {
  readonly pid: number;
  readonly home: string;
  readonly record: RuntimeOwnershipRecord | null;
}

type Attribution =
  | { readonly verdict: 'OWNED' }
  /** The recorded process is already gone; there is nothing to stop and nothing to report. */
  | { readonly verdict: 'STOPPED' }
  | { readonly verdict: 'UNATTRIBUTED'; readonly detail: string; readonly looksOwned: boolean };

/**
 * Every home this test file could have started a Runtime for: explicitly registered homes plus any
 * registered fixture directory that holds a `runtime.lock` (a live Runtime always has one). A home
 * whose Runtime stopped cleanly has no lock and therefore nothing to reclaim.
 */
function candidateHomes(): string[] {
  const homes = new Set<string>(runtimeHomes);
  for (const directory of temporaryDirectories) {
    for (const candidate of [directory, join(directory, 'home')]) {
      if (existsSync(join(candidate, 'runtime.lock'))) homes.add(resolve(candidate));
    }
  }
  return [...homes];
}

function liveRecords(inspection: RuntimeHomeInspection): readonly RuntimeOwnershipRecord[] {
  const records: RuntimeOwnershipRecord[] = [];
  for (const trace of inspection.bootRecords) {
    if (trace.verdict === 'RUNNING' && trace.identityMatches !== false) records.push(trace);
  }
  const lock = inspection.lock;
  if (lock.holderAlive && lock.holderIdentityMatches !== false && lock.record !== null) {
    records.push(lock.record);
  }
  const seen = new Set<number>();
  return records.filter((record) => {
    if (seen.has(record.pid)) return false;
    seen.add(record.pid);
    return true;
  });
}

/**
 * Stops every Runtime this test file owns and reclaims its fixture directories.
 *
 * Runs on both the success and the failure path: it never depends on the test having reached its
 * own `stop`. Existing test assertions are untouched — the Runtime a test stops itself is already
 * gone and has no lock left, so it is no longer a candidate.
 */
export async function reclaimTestResources(
  options: ReclaimOptions = {},
): Promise<ReclamationReport> {
  const graceMs = options.stopGraceMs ?? defaultStopGraceMs;
  const reason = options.preserveEvidence ?? evidenceReason;
  evidenceReason = null;

  const candidates: Candidate[] = [];
  const unattributed: UnattributedProcess[] = [];
  for (const home of candidateHomes()) {
    if (!isTemporaryPath(home)) {
      unattributed.push({ pid: 0, home, looksOwned: false,
        detail: `refusing to inspect a non-temporary home (${home})` });
      continue;
    }
    const inspection = await inspectRuntimeHome({ home, readStartToken: readProcessStartToken });
    for (const record of liveRecords(inspection)) {
      const verdict = await attribute(home, record);
      if (verdict.verdict === 'OWNED') candidates.push({ pid: record.pid, home, record });
      else if (verdict.verdict === 'UNATTRIBUTED') {
        unattributed.push({ pid: record.pid, home, detail: verdict.detail,
          looksOwned: verdict.looksOwned });
      }
    }
  }
  for (const [pid, home] of runtimeChildren) {
    const state = await readProcessState(pid);
    if (state !== 'RUNNING' && state !== 'UNKNOWN') continue;
    if (candidates.some((candidate) => candidate.pid === pid)) continue;
    if (!isTemporaryPath(home)) {
      unattributed.push({ pid, home, looksOwned: true,
        detail: 'registered process home is not temporary' });
      continue;
    }
    // A PID can be reused between the spawn and the teardown, so this test's own child is only
    // signalled while its command line still names this worktree's Runtime entry.
    const commandLine = await processCommandLine(pid);
    if (commandLine === null || !commandLine.includes(runtimeEntry)) {
      unattributed.push({ pid, home, looksOwned: true,
        detail: 'the registered pid no longer names this worktree\'s Runtime entry' });
      continue;
    }
    candidates.push({ pid, home, record: null });
  }

  const stopped: StoppedRuntime[] = [];
  const unconfirmed: UnconfirmedProcess[] = [];
  for (const candidate of candidates) {
    const beganAt = Date.now();
    const exited = await stopWithSigterm(candidate.pid, graceMs);
    if (exited) stopped.push({ pid: candidate.pid, home: candidate.home,
      waitedMs: Date.now() - beganAt });
    else unconfirmed.push({ pid: candidate.pid, home: candidate.home,
      detail: `still running ${graceMs}ms after SIGTERM; not killed, its state is left observable` });
  }

  // A home whose Runtime could not be stopped is kept: deleting it would turn an observable process
  // into an unreachable orphan, which is exactly the failure this module exists to prevent.
  const keptHomes = new Set(unconfirmed.map((entry) => canonical(entry.home)));
  const removedDirectories: string[] = [];
  const preservedDirectories: string[] = [];
  for (const directory of temporaryDirectories.splice(0)) {
    const keepsHome = keptHomes.has(canonical(directory))
      || keptHomes.has(canonical(join(directory, 'home')));
    if (reason !== null || keepsHome) {
      preservedDirectories.push(directory);
      continue;
    }
    rmSync(directory, { recursive: true, force: true });
    removedDirectories.push(directory);
  }
  runtimeHomes.clear();
  runtimeChildren.clear();

  const report: ReclamationReport = {
    stopped, unattributed, unconfirmed, removedDirectories, preservedDirectories,
    evidenceReason: reason,
  };
  for (const entry of unattributed) {
    if (!entry.looksOwned) continue;
    console.error(`[test-reclamation] looks like this worktree's Runtime but ownership is unproven;`
      + ` left alone: pid ${entry.pid} (${entry.detail})`);
  }
  for (const entry of unconfirmed) {
    console.error(`[test-reclamation] UNCONFIRMED STOP: pid ${entry.pid} home ${entry.home}`
      + ` — ${entry.detail}`);
  }
  if (reason !== null) {
    console.error(`[test-reclamation] keeping evidence (${reason}):`
      + ` ${preservedDirectories.join(', ')}`);
  }
  if (unconfirmed.length > 0 && options.strict !== false) {
    throw new Error('A Runtime this test started did not stop within'
      + ` ${graceMs}ms: ${unconfirmed.map((entry) => `${entry.pid} (${entry.home})`).join(', ')}`
      + '. Its directory was kept so the state stays observable; no SIGKILL was sent.');
  }
  return report;
}
