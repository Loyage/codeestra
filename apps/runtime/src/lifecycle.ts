import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Runtime lifecycle facts: which process owns a Runtime home, which boot wrote a record, and what a
 * client can still verify about a process it did not start.
 *
 * Everything in this module is deliberately free of workspace imports. The CLI reads exactly these
 * records (read-only, without signalling anything) to answer "is a Runtime running for this home,
 * and did it really stop", and the CLI must not gain a dependency on the Runtime's Adapter packages
 * for that. The only identity source available to both is the OS's own process start token, so this
 * module reads it directly. `@codeestra/agent-adapters` reads the same token for provider processes
 * with the same format; both must change together if that format ever changes.
 */

/** A PID is reused by the OS, so a start token is what makes a process identifiable later. */
export interface RuntimeProcessIdentity {
  readonly pid: number;
  readonly startToken: string | null;
}

export interface RuntimeOwnershipRecord extends RuntimeProcessIdentity {
  readonly bootId: string;
  readonly startedAt: number;
  readonly argv: readonly string[];
  readonly cwd: string;
}

export type RuntimeProcessVerdict =
  /** The recorded process is still there and is the same process (or its identity is unverifiable). */
  | 'RUNNING'
  /** The recorded process is gone: this boot never recorded a clean shutdown. */
  | 'EXITED_WITHOUT_CLEAN_SHUTDOWN'
  /** A process holds this PID, but its start token differs: the recorded process is gone. */
  | 'PROCESS_ID_REUSED';

export interface RuntimeBootTrace extends RuntimeOwnershipRecord {
  readonly recordPath: string;
  readonly processAlive: boolean;
  /** `null` when the OS could not answer; callers must treat `null` as "not proven". */
  readonly identityMatches: boolean | null;
  readonly verdict: RuntimeProcessVerdict;
}

/** Facts about a live Runtime are only facts about a *running* process, never about a zombie. */

export interface RuntimeLockInspection {
  readonly lockPath: string;
  readonly present: boolean;
  /** Set when the lock file exists but is not a usable ownership record. */
  readonly problem: string | null;
  readonly record: RuntimeOwnershipRecord | null;
  readonly holderAlive: boolean;
  readonly holderIdentityMatches: boolean | null;
}

export interface RuntimeHomeInspection {
  readonly home: string;
  readonly socketPath: string;
  readonly socketPresent: boolean;
  /** A read-only connect probe: `true` means a Runtime is serving this home. */
  readonly endpointAnswers: boolean;
  readonly lock: RuntimeLockInspection;
  /** Every boot record found, with the facts that are true about it right now. */
  readonly bootRecords: readonly RuntimeBootTrace[];
  /**
   * Boot records that are not the live, reachable Runtime of this home: processes that are still
   * there and cannot be reached, and boots that never recorded a clean shutdown.
   */
  readonly traces: readonly RuntimeBootTrace[];
  /** Lifecycle files that could not be parsed; never silently ignored. */
  readonly unreadableRecords: readonly string[];
  readonly verdict: 'NOT_RUNNING' | 'RUNNING' | 'UNREACHABLE_PROCESS' | 'STALE_LOCK' | 'CORRUPT_LOCK';
}

export const runtimeLockPath = (home: string): string => join(home, 'runtime.lock');

export const runtimeBootsDirectory = (home: string): string => join(home, 'runtime-boots');

export const runtimeBootRecordPath = (home: string, bootId: string): string =>
  join(runtimeBootsDirectory(home), `${bootId}.json`);

/** Preserved evidence of a lock file that could not be read as an ownership record. */
const corruptLockPath = (home: string): string => join(home, 'runtime.lock.corrupt');

/** True while the OS still reserves this PID, which includes a zombie awaiting its parent. */
export function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the PID exists but belongs to another user: still not a process we may reuse.
    return (error as { readonly code?: string }).code !== 'ESRCH';
  }
}

export type RuntimeProcessState = 'GONE' | 'ZOMBIE' | 'RUNNING' | 'UNKNOWN';

/** `/proc` is the cheap state source where it exists; otherwise `ps` answers the same question. */
const procfsAvailable = existsSync('/proc/self/stat');

/**
 * The OS's state for a PID. A zombie has already exited and holds no socket, no file, and no child:
 * it is only an unreaped exit status, so it counts as stopped. `UNKNOWN` fails closed: callers must
 * treat it as still running rather than claim a process they cannot see is gone.
 */
export async function readProcessState(pid: number): Promise<RuntimeProcessState> {
  if (!Number.isInteger(pid) || pid <= 0) return 'GONE';
  const fromProc = readProcState(pid);
  if (fromProc !== null) return fromProc;
  return await readPsState(pid);
}

function readProcState(pid: number): RuntimeProcessState | null {
  if (!procfsAvailable) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[0];
    if (state === undefined) return 'UNKNOWN';
    return state === 'Z' || state === 'X' ? 'ZOMBIE' : 'RUNNING';
  } catch {
    // On Linux a missing /proc entry means the PID is gone.
    return 'GONE';
  }
}

async function readPsState(pid: number): Promise<RuntimeProcessState> {
  try {
    const process = Bun.spawn(['ps', '-o', 'state=', '-p', String(pid)], {
      stdout: 'pipe', stderr: 'ignore',
    });
    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ]);
    const value = stdout.trim();
    if (exitCode !== 0 || value.length === 0) return pidExists(pid) ? 'UNKNOWN' : 'GONE';
    // macOS and Linux report a zombie as `Z` (possibly with flags, such as `Z+`).
    return value.startsWith('Z') ? 'ZOMBIE' : 'RUNNING';
  } catch {
    return pidExists(pid) ? 'UNKNOWN' : 'GONE';
  }
}

/**
 * True while the OS reports a live process. Ownership is never decided from a live PID alone, and a
 * zombie is not a live process: the Runtime behind it has already exited.
 */
export async function isProcessRunning(pid: number): Promise<boolean> {
  const state = await readProcessState(pid);
  return state === 'RUNNING' || state === 'UNKNOWN';
}

/**
 * The OS's own start token for a PID, in the same format `@codeestra/agent-adapters` uses. It
 * returns `null` when no token can be read, and every caller fails closed on `null` rather than
 * assuming the process is gone.
 */
export async function readProcessStartToken(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return (await readLinuxStartToken(pid)) ?? (await readPsStartToken(pid));
}

async function readLinuxStartToken(pid: number): Promise<string | null> {
  let stat: string;
  let bootId: string;
  try {
    [stat, bootId] = await Promise.all([
      readFileSync(`/proc/${pid}/stat`, 'utf8'),
      readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'),
    ]);
  } catch {
    return null;
  }
  const afterName = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  // Fields after the command name start at 1-based field 3; starttime is field 22.
  const startTime = afterName[19];
  const boot = bootId.trim();
  if (startTime === undefined || boot.length === 0) return null;
  return `linux:${boot}:${startTime}`;
}

async function readPsStartToken(pid: number): Promise<string | null> {
  try {
    const process = Bun.spawn(['ps', '-o', 'lstart=', '-p', String(pid)], {
      stdout: 'pipe', stderr: 'ignore',
    });
    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ]);
    const value = stdout.trim();
    if (exitCode !== 0 || value.length === 0) return null;
    return `ps:${value}`;
  } catch {
    return null;
  }
}

export type DeadlineOutcome<T> =
  | { readonly settled: true; readonly value: T }
  | { readonly settled: false };

/**
 * Races `work` against a deadline and always clears the deadline timer.
 *
 * Bun keeps the event loop alive while any timer is pending, so `Bun.sleep(graceMs)` inside a
 * `Promise.race` makes an already finished shutdown wait out the whole grace period before the
 * process can exit. A deadline that never fires must not be able to hold the Runtime open.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<DeadlineOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<DeadlineOutcome<T>>([
      work.then((value) => ({ settled: true, value }) as const),
      new Promise<DeadlineOutcome<T>>((resolveDeadline) => {
        timer = setTimeout(() => resolveDeadline({ settled: false }), Math.max(timeoutMs, 0));
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * True when a Runtime answers on this endpoint. It is a connect-and-close probe: it sends no
 * command and writes nothing, so it cannot change the state it observes.
 */
export async function probeRuntimeEndpoint(socketPath: string, timeoutMs = 1_000): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  const connect = (async (): Promise<boolean> => {
    try {
      const socket = await Bun.connect({
        unix: socketPath,
        socket: {
          open(peer) { peer.end(); },
          data() {},
          error() {},
          drain() {},
        },
      });
      socket.end();
      return true;
    } catch {
      return false;
    }
  })();
  const outcome = await withDeadline(connect, timeoutMs);
  // A probe that could not answer in time is not proof that a Runtime is serving this home.
  return outcome.settled ? outcome.value : false;
}

function readOwnershipRecord(path: string): {
  readonly record: RuntimeOwnershipRecord | null;
  readonly problem: string | null;
} {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // A missing file is not a problem: it is the normal state of a home no Runtime owns.
    return (error as { readonly code?: string }).code === 'ENOENT'
      ? { record: null, problem: null }
      : { record: null,
        problem: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { record: null,
      problem: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof parsed !== 'object' || parsed === null) return { record: null, problem: 'not an object' };
  const candidate = parsed as Record<string, unknown>;
  const { bootId, pid, startedAt } = candidate;
  if (typeof bootId !== 'string' || bootId.length === 0
    || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0
    || typeof startedAt !== 'number' || !Number.isFinite(startedAt)) {
    return { record: null, problem: 'missing bootId, pid, or startedAt' };
  }
  return {
    record: {
      bootId,
      pid,
      startedAt,
      startToken: typeof candidate.startToken === 'string' ? candidate.startToken : null,
      argv: Array.isArray(candidate.argv)
        ? candidate.argv.filter((entry): entry is string => typeof entry === 'string')
        : [],
      cwd: typeof candidate.cwd === 'string' ? candidate.cwd : '',
    },
    problem: null,
  };
}

/** `identityMatches === false` is the only unambiguously negative answer; `null` fails closed. */
async function matchesRecordedIdentity(
  record: RuntimeOwnershipRecord,
  readStartToken: (pid: number) => Promise<string | null>,
): Promise<boolean | null> {
  if (record.startToken === null) return null;
  const current = await readStartToken(record.pid);
  if (current === null) return null;
  return current === record.startToken;
}

/**
 * Collects the facts about one boot record: whether its process is still there, and whether it is
 * still the *same* process.
 */
async function traceBootRecord(
  recordPath: string,
  readStartToken: (pid: number) => Promise<string | null>,
): Promise<RuntimeBootTrace | null> {
  const read = readOwnershipRecord(recordPath);
  if (read.record === null) return null;
  const processAlive = await isProcessRunning(read.record.pid);
  const identityMatches = processAlive
    ? await matchesRecordedIdentity(read.record, readStartToken)
    : null;
  const verdict: RuntimeProcessVerdict = !processAlive
    ? 'EXITED_WITHOUT_CLEAN_SHUTDOWN'
    : identityMatches === false ? 'PROCESS_ID_REUSED' : 'RUNNING';
  return { ...read.record, recordPath, processAlive, identityMatches, verdict };
}

function listBootRecordFiles(home: string): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(runtimeBootsDirectory(home)).sort();
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const path = join(runtimeBootsDirectory(home), entry);
    try {
      if (statSync(path).isFile()) paths.push(path);
    } catch { /* The file disappeared between listing and stat: nothing to report. */ }
  }
  return paths;
}

export interface AcquireRuntimeOwnershipInput {
  readonly home: string;
  readonly pid: number;
  readonly bootId: string;
  readonly startedAt: number;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly readStartToken?: (pid: number) => Promise<string | null>;
  /** Bounded retries while another starter is replacing a stale lock. */
  readonly attempts?: number;
}

export type RuntimeOwnershipOutcome =
  | { readonly acquired: true; readonly record: RuntimeOwnershipRecord;
      readonly bootRecordWritten: boolean }
  | { readonly acquired: false; readonly owner: RuntimeOwnershipRecord | null;
      readonly ownerAlive: boolean; readonly problem: string | null };

/**
 * Claims exclusive ownership of a Runtime home, or reports who already holds it.
 *
 * The lock file is created by hard-linking a fully written temporary file, so a reader either sees
 * no lock or a complete record. There is no window in which a starter could read a half-written
 * lock, decide its owner is gone, and delete a live Runtime's lock — the race that used to leave a
 * second Runtime alive on a socket path nobody could reach.
 */
export async function acquireRuntimeOwnership(
  input: AcquireRuntimeOwnershipInput,
): Promise<RuntimeOwnershipOutcome> {
  mkdirSync(input.home, { recursive: true, mode: 0o700 });
  const lockPath = runtimeLockPath(input.home);
  const readStartToken = input.readStartToken ?? readProcessStartToken;
  const attempts = input.attempts ?? 20;
  const record: RuntimeOwnershipRecord = {
    bootId: input.bootId,
    pid: input.pid,
    startedAt: input.startedAt,
    startToken: await readStartToken(input.pid),
    argv: [...input.argv],
    cwd: input.cwd,
  };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = `${lockPath}.${input.pid}.tmp`;
    writeFileSync(candidate, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try {
      linkSync(candidate, lockPath);
      return { acquired: true, record, bootRecordWritten: writeBootRecord(input.home, record) };
    } catch (error) {
      if ((error as { readonly code?: string }).code !== 'EEXIST') throw error;
      const existing = readOwnershipRecord(lockPath);
      if (existing.record !== null) {
        const ownerAlive = await isProcessRunning(existing.record.pid);
        const identityMatches = ownerAlive
          ? await matchesRecordedIdentity(existing.record, readStartToken)
          : false;
        if (ownerAlive && identityMatches !== false) {
          return { acquired: false, owner: existing.record, ownerAlive: true, problem: null };
        }
      } else if (existing.problem !== null) {
        // Keep the unreadable file as evidence instead of deleting what it recorded.
        try {
          rmSync(corruptLockPath(input.home), { force: true });
          renameSync(lockPath, corruptLockPath(input.home));
        } catch { rmSync(lockPath, { force: true }); }
      }
      // The recorded owner is gone, its PID was reused, or the file vanished while another starter
      // was releasing it: this lock is not a live claim, and its boot record stays for a client to
      // report if it never recorded a clean shutdown.
      rmSync(lockPath, { force: true });
    } finally {
      rmSync(candidate, { force: true });
    }
  }
  return { acquired: false, owner: null, ownerAlive: false, problem: 'LOCK_CONTENDED' };
}

function writeBootRecord(home: string, record: RuntimeOwnershipRecord): boolean {
  try {
    mkdirSync(runtimeBootsDirectory(home), { recursive: true, mode: 0o700 });
    writeFileSync(runtimeBootRecordPath(home, record.bootId), `${JSON.stringify(record)}\n`,
      { mode: 0o600 });
    return true;
  } catch {
    // A missing boot record only degrades diagnostics; it never blocks the Runtime from starting.
    return false;
  }
}

/**
 * Releases ownership at the very end of a clean shutdown. Only this boot's own lock and boot record
 * are removed: a stale lock left by another boot is evidence, not something this process deletes.
 */
export function releaseRuntimeOwnership(input: {
  readonly home: string;
  readonly bootId: string;
}): { readonly lockReleased: boolean; readonly bootRecordRemoved: boolean } {
  const existing = readOwnershipRecord(runtimeLockPath(input.home));
  const lockReleased = existing.record?.bootId === input.bootId;
  if (lockReleased) rmSync(runtimeLockPath(input.home), { force: true });
  let bootRecordRemoved = false;
  try {
    unlinkSync(runtimeBootRecordPath(input.home, input.bootId));
    bootRecordRemoved = true;
  } catch { /* The record was never written, or an earlier release already removed it. */ }
  return { lockReleased, bootRecordRemoved };
}

/**
 * Read-only inspection of a Runtime home: it never writes, never deletes, and never signals a
 * process. It is how a client answers "is a Runtime running, and are there Runtime processes left
 * over that it cannot reach" from facts instead of assumptions.
 */
export async function inspectRuntimeHome(input: {
  readonly home: string;
  readonly socketPath?: string;
  readonly readStartToken?: (pid: number) => Promise<string | null>;
}): Promise<RuntimeHomeInspection> {
  const socketPath = input.socketPath ?? join(input.home, 'runtime.sock');
  const readStartToken = input.readStartToken ?? readProcessStartToken;
  const socketPresent = existsSync(socketPath);
  const endpointAnswers = socketPresent ? await probeRuntimeEndpoint(socketPath) : false;

  const lockPath = runtimeLockPath(input.home);
  const existing = readOwnershipRecord(lockPath);
  const lockPresent = existsSync(lockPath);
  let holderAlive = false;
  let holderIdentityMatches: boolean | null = null;
  if (existing.record !== null) {
    holderAlive = await isProcessRunning(existing.record.pid);
    holderIdentityMatches = holderAlive
      ? await matchesRecordedIdentity(existing.record, readStartToken)
      : null;
  }

  const unreadableRecords: string[] = [];
  const bootRecords: RuntimeBootTrace[] = [];
  for (const path of listBootRecordFiles(input.home)) {
    const trace = await traceBootRecord(path, readStartToken);
    if (trace === null) unreadableRecords.push(path);
    else bootRecords.push(trace);
  }
  if (existsSync(corruptLockPath(input.home))) unreadableRecords.push(corruptLockPath(input.home));

  const liveOwnerBootId = holderAlive && holderIdentityMatches !== false
    ? existing.record?.bootId ?? null
    : null;
  const liveReachableOwner = liveOwnerBootId !== null && endpointAnswers;
  const traces = bootRecords.filter((trace) => !(liveReachableOwner && trace.bootId === liveOwnerBootId));
  const liveLockHolderUnreachable = liveOwnerBootId !== null && !endpointAnswers;
  const liveTraceUnreachable = traces.some((trace) => trace.verdict === 'RUNNING');

  const verdict: RuntimeHomeInspection['verdict'] =
    existing.record === null && existing.problem !== null && lockPresent ? 'CORRUPT_LOCK'
      : liveLockHolderUnreachable || liveTraceUnreachable ? 'UNREACHABLE_PROCESS'
        : endpointAnswers ? 'RUNNING'
          : lockPresent || bootRecords.length > 0 ? 'STALE_LOCK'
            : 'NOT_RUNNING';

  return {
    home: input.home,
    socketPath,
    socketPresent,
    endpointAnswers,
    lock: {
      lockPath,
      present: lockPresent,
      problem: existing.problem,
      record: existing.record,
      holderAlive,
      holderIdentityMatches,
    },
    bootRecords,
    traces,
    unreadableRecords,
    verdict,
  };
}
