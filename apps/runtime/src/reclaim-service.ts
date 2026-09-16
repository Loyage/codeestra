import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync }
  from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  inspectOwnedPath,
  inspectOwnedWorktreeRegistration,
  inspectWorktreeState,
  isAncestor,
  readLocalRefCommit,
  removeOwnedWorktree,
  type OwnedWorktreeRemoval,
} from '@codeestra/git';
import {
  Phase1Database,
  StorageError,
  type ReclamationCandidates,
  type ReclamationPathClaim,
  type ReclamationRecord,
  type ReclamationRecordInput,
  type ReclamationOutcome,
  type ReclamationSource,
  type TaskLifecycleState,
  type TrustedProject,
} from '@codeestra/storage';
import { DevRepoError } from './dev-repo-service.js';

export class ReclaimServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ReclaimServiceError';
  }
}

export type ReclaimKind = 'TASK_WORKTREE' | 'VERIFICATION_COPY' | 'INTEGRATION_WORKTREE';
export const reclaimKinds: readonly ReclaimKind[] = [
  'TASK_WORKTREE', 'VERIFICATION_COPY', 'INTEGRATION_WORKTREE',
];
export type ReclaimAction = 'RECLAIM' | 'RETAIN' | 'REFUSE' | 'ALREADY_ABSENT'
  | 'RECOVERY_REQUIRED';
/** A directory found in the Runtime data directory that the ledger does not claim. */
export const unregisteredReclaimKind = 'UNREGISTERED_DIRECTORY' as const;
export type ReclaimScopeKind = 'PROJECT' | 'ALL_PROJECTS';

/**
 * One resource a reclamation run considered. `action` is the decision, `reasonCode`/`detail` say
 * why, and `evidence` carries the ownership facts (recorded identity plus what was actually
 * observed) that authorized or refused it.
 */
export interface ReclaimTarget {
  readonly kind: ReclaimKind;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly resourceId: string;
  readonly resourceState: string;
  readonly path: string;
  readonly ownershipToken: string | null;
  readonly externalRef: string | null;
  readonly action: ReclaimAction;
  readonly reasonCode: string;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface ReclaimCounts {
  readonly total: number;
  readonly reclaim: number;
  readonly retain: number;
  readonly refuse: number;
  readonly alreadyAbsent: number;
  /** Ownership could not be verified, so nothing was (or would be) deleted. */
  readonly recoveryRequired: number;
}

/**
 * One directory in a Runtime-owned layout root that no ledger row claims. It carries the three
 * independent pieces of evidence a decision needs — where it sits (`layoutKind`/`runtimeHome`),
 * whether it carries a Git marker, and what the ledger and the OS say about it — and it is never
 * deleted unless the caller selected this exact path.
 */
export interface ReclaimUnregisteredTarget {
  readonly source: 'UNREGISTERED_DIRECTORY';
  readonly kind: 'UNREGISTERED_DIRECTORY';
  /** The owned root the directory was found in (`worktrees` / `verifications` / `integrations`). */
  readonly layoutKind: ReclaimKind;
  readonly runtimeHome: string;
  readonly path: string;
  /** The project segment of the path, when it names a project of this Runtime. */
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly taskId: string | null;
  readonly taskDisplayNumber: number | null;
  readonly resourceId: string;
  readonly resourceState: 'UNREGISTERED';
  readonly action: ReclaimAction;
  readonly reasonCode: string;
  readonly detail: string;
  /** True when this path was named by an explicit removal selection. */
  readonly selected: boolean;
  readonly evidence: Readonly<Record<string, unknown>>;
}

/** What the bounded unregistered-directory scan looked at, in facts rather than prose. */
export interface ReclaimUnregisteredScan {
  readonly home: string;
  readonly scanRoot: string | null;
  readonly layoutRoots: readonly string[];
  readonly projectDirectories: number;
  readonly resourceDirectories: number;
  /** Paths the ledger already claims; they are not unregistered and are handled elsewhere. */
  readonly claimedByLedger: readonly string[];
  readonly skippedEntries: number;
  readonly truncated: boolean;
  readonly processCheck: 'AVAILABLE' | 'UNAVAILABLE';
}

export interface ReclaimUnregisteredPlan {
  readonly scan: ReclaimUnregisteredScan;
  /** Candidates attributable to this plan's scope. */
  readonly targets: readonly ReclaimUnregisteredTarget[];
  readonly counts: ReclaimCounts;
}

/**
 * In a batch, the unregistered half is scanned once: each attributable candidate is grouped into its
 * project's own plan (so it is decided and recorded with that project's operation), and only the
 * candidates that belong to no trusted project are reported here. They are never deleted, because no
 * project can own the ledger row that would have to justify the deletion.
 */
export interface ReclaimBatchUnregisteredView {
  readonly scan: ReclaimUnregisteredScan;
  readonly unattributed: readonly ReclaimUnregisteredTarget[];
}

export interface ReclaimPlan {
  readonly scope: ReclaimScopeKind;
  readonly projectId: string;
  readonly projectName: string;
  readonly taskId: string | null;
  readonly includeFailureScenes: boolean;
  readonly kinds: readonly ReclaimKind[];
  readonly devCommit: string | null;
  readonly targets: readonly ReclaimTarget[];
  readonly counts: ReclaimCounts;
  /** Present only when the caller asked for unregistered directories. */
  readonly unregistered: ReclaimUnregisteredPlan | null;
  /**
   * Set only by a batch: this project could not even be planned. The project is still listed so the
   * batch cannot hide a project by omitting it.
   */
  readonly projectError?: { readonly code: string; readonly message: string } | null;
}

export interface ReclaimOutcomeCounts {
  readonly reclaimed: number;
  readonly alreadyAbsent: number;
  readonly retained: number;
  readonly refused: number;
  readonly failed: number;
  /** Ownership could not be verified; nothing was deleted and the reason is in the ledger. */
  readonly recoveryRequired: number;
}

export interface ReclaimReport extends ReclaimPlan {
  readonly operationId: string;
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly records: readonly ReclamationRecord[];
  readonly outcomeCounts: ReclaimOutcomeCounts;
  /** True when the recorded result of this command ID was returned instead of a second run. */
  readonly alreadyCompleted: boolean;
  readonly created: boolean;
}

/**
 * A batch reclamation over every trusted project. The grouping *is* the contract: one independent
 * decision set per project, executed and recorded as its own operation, so one project's refusal or
 * failure can never silently skip another project's resources.
 */
export interface ReclaimBatchPlan {
  readonly scope: 'ALL_PROJECTS';
  readonly projectIds: readonly string[];
  readonly projects: readonly ReclaimPlan[];
  readonly counts: ReclaimCounts;
  readonly unregistered: ReclaimBatchUnregisteredView | null;
  readonly includeFailureScenes: boolean;
  readonly kinds: readonly ReclaimKind[];
  readonly taskId: string | null;
  /**
   * `FAILED` when at least one project group could not even be planned. The group is still listed
   * with its `projectError`, so a batch never hides a project by failing on it.
   */
  readonly outcome?: 'SUCCEEDED' | 'FAILED';
}

export interface ReclaimBatchOperationSummary {
  readonly projectId: string;
  readonly operationId: string;
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly alreadyCompleted: boolean;
  readonly created: boolean;
}

export interface ReclaimBatchReport extends ReclaimBatchPlan {
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly outcomeCounts: ReclaimOutcomeCounts;
  readonly operations: readonly ReclaimBatchOperationSummary[];
  /** Projects whose group could not be started at all; the others were still attempted. */
  readonly failures: readonly {
    readonly projectId: string;
    readonly code: string;
    readonly message: string;
  }[];
  /** True only when every project group was answered from its recorded receipt. */
  readonly alreadyCompleted: boolean;
  readonly created: boolean;
}

/** Every input that decides both the registered and the unregistered half of one plan. */
export interface ReclaimPlanInput {
  readonly storage: Phase1Database;
  readonly runtimeHome: string;
  readonly projectId: string;
  readonly taskId?: string;
  readonly kinds?: readonly ReclaimKind[];
  readonly includeFailureScenes?: boolean;
  /** Include the unregistered-directory scan in this plan. */
  readonly unregistered?: boolean;
  /** Absolute path inside the Runtime home that bounds the scan. */
  readonly scanRoot?: string;
  /** Paths the caller selected for removal (`apply` only; `plan` reports them as selected). */
  readonly removeUnregistered?: readonly string[];
  /** A scan already performed for this command (batch scope), reused instead of repeated. */
  readonly unregisteredScan?: UnregisteredScanResult | undefined;
  /** Report unregistered candidates that belong to no trusted project (batch scope). */
  readonly reportUnattributed?: boolean;
  /**
   * ADR-0058 D09: treat the *live-claim* gates on this Task's resources as moot.
   *
   * Only `task purge --force` sets it, and only after it has decided the Task and its rows are going
   * away: `ACTIVE_EXECUTION`, `ACTIVE_RESERVATION`, `ACTIVE_VERIFICATION` and `TASK_NOT_TERMINAL`
   * protect a run this command has already retired (it terminated the provider first). The
   * *ownership* gates — symlink escape, a path outside the owned root, a registration/HEAD/branch that
   * does not match the record — are never bypassed here: a path the Runtime cannot prove is this
   * Task's is still never deleted.
   */
  readonly ignoreLiveClaims?: boolean;
}

export interface ReclaimBatchInput extends Omit<ReclaimPlanInput, 'projectId'> {
  /** Defaults to every ACTIVE-trusted project. */
  readonly projectIds?: readonly string[];
  /** A scan already performed for this command, reused instead of being repeated per project. */
  readonly unregisteredScan?: UnregisteredScanResult | undefined;
}

export interface ReclaimApplyInput extends ReclaimPlanInput {
  readonly commandId: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

export interface ReclaimBatchApplyInput extends ReclaimBatchInput {
  readonly commandId: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

export interface ReclamationReconcileResult {
  readonly operationId: string;
  readonly projectId: string;
  readonly outcome: 'COMPLETED' | 'FAILED' | 'NOT_STARTED';
  readonly reclaimed: number;
  readonly remaining: number;
}

/**
 * Task states that own a workspace and may still hold a provider process. Reclaiming one would
 * destroy live state, so it is refused no matter what the caller asked for.
 */
const activeTaskStates: ReadonlySet<TaskLifecycleState> = new Set([
  'RUNNING', 'PAUSING', 'PAUSED', 'WAITING_FOR_USER', 'CANCELLING', 'RECOVERY_REQUIRED',
]);

/** Task states in which a retained worktree is no longer expected to continue working. */
const terminalTaskStates: ReadonlySet<TaskLifecycleState> = new Set([
  'EXECUTED', 'SUCCEEDED', 'FAILED', 'CANCELLED',
]);

const activeIntegrationStates = new Set(['CREATED', 'PREPARING', 'VERIFYING', 'INTEGRATING_DEV']);
const failureIntegrationStates = new Set(['CONFLICTED', 'FAILED', 'RECOVERY_REQUIRED']);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The stable code an error carries, or a stable fallback so a report never contains `undefined`. */
function errorCodeOf(error: unknown): string {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'UNEXPECTED_ERROR';
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ownedRootFor(runtimeHome: string, kind: ReclaimKind): string {
  const directory = kind === 'TASK_WORKTREE' ? 'worktrees'
    : kind === 'VERIFICATION_COPY' ? 'verifications' : 'integrations';
  return join(runtimeHome, directory);
}

function samePath(left: string, right: string): boolean {
  return left === right;
}

// -----------------------------------------------------------------------------------------------
// Scope resolution (single project vs. every trusted project)
// -----------------------------------------------------------------------------------------------

export interface ReclaimScope {
  readonly kind: ReclaimScopeKind;
  readonly projectId: string | null;
}

/**
 * Turns the command face's two ways of naming a scope into one decision. Both a missing project and
 * two competing scope selectors are rejected here rather than guessed at, so `reclaim plan` can
 * never quietly widen from one project to all of them (or the other way round).
 */
export function resolveReclaimScope(input: {
  readonly projectId?: string | undefined;
  readonly allProjects?: boolean | undefined;
  readonly taskId?: string | undefined;
}): ReclaimScope {
  if (input.projectId !== undefined && input.allProjects === true) {
    throw new ReclaimServiceError('PROJECT_SCOPE_CONFLICT',
      'Give either --project or --all-projects, not both');
  }
  if (input.taskId !== undefined && input.projectId === undefined) {
    throw new ReclaimServiceError('PROJECT_SCOPE_REQUIRED',
      'A Task ID is project-scoped: give --project with --task');
  }
  if (input.projectId !== undefined) return { kind: 'PROJECT', projectId: input.projectId };
  if (input.allProjects === true) return { kind: 'ALL_PROJECTS', projectId: null };
  throw new ReclaimServiceError('PROJECT_SCOPE_REQUIRED',
    'Give --project <project-id> or --all-projects to choose what to reclaim');
}

// -----------------------------------------------------------------------------------------------
// Unregistered directories (ADR-0037)
//
// A directory under one of the three Runtime-owned layout roots that no ledger row claims. The scan
// is bounded by construction: it walks exactly `<root>/<project-id>/<resource-id>` and never
// descends further. Everything after the scan is evidence: where the directory sits, whether it
// carries a Git marker, what the ledger says about that path, whether Git still registers it, and
// whether an OS process is working inside it. A directory is only ever deleted when an explicit
// path selection names it *and* every one of those facts still agrees at removal time.
// -----------------------------------------------------------------------------------------------

const layoutDirectoryByKind: Readonly<Record<ReclaimKind, string>> = {
  TASK_WORKTREE: 'worktrees',
  VERIFICATION_COPY: 'verifications',
  INTEGRATION_WORKTREE: 'integrations',
};

const kindByLayoutDirectory: Readonly<Record<string, ReclaimKind>> = {
  worktrees: 'TASK_WORKTREE',
  verifications: 'VERIFICATION_COPY',
  integrations: 'INTEGRATION_WORKTREE',
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A bounded scan: at most this many candidates are ever evaluated in one run. */
const maxUnregisteredCandidates = 500;

function insidePath(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * The path with every symlinked ancestor resolved (`/tmp` and `/private/tmp` are one directory on
 * macOS). Recorded resource paths are canonical, so every comparison against the ledger, the Git
 * worktree registry and an explicit selection has to be canonical too — otherwise a registered
 * worktree would look like an unregistered directory whenever the Runtime home is reached through a
 * symlink.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function overlapsPath(left: string, right: string): boolean {
  return insidePath(left, right) || insidePath(right, left);
}

function directChildPaths(parent: string): readonly string[] {
  try {
    return readdirSync(parent).map((name) => join(parent, name)).sort();
  } catch {
    // An unreadable layout root yields no candidates instead of an error: the scan reports what it
    // could see, and the caller is never told a directory does not exist when it could not look.
    return [];
  }
}

/**
 * The working directories of every process this user can inspect, or null when the OS cannot
 * answer. `null` fails closed: a directory whose "is a process using it?" question cannot be
 * answered is never deleted.
 */
async function processWorkingDirectories(): Promise<ReadonlySet<string> | null> {
  const fromProc = procWorkingDirectories();
  if (fromProc !== null) return fromProc;
  return await lsofWorkingDirectories();
}

function procWorkingDirectories(): ReadonlySet<string> | null {
  if (!existsSync('/proc/self/cwd')) return null;
  const directories = new Set<string>();
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      directories.add(readlinkSync(`/proc/${entry}/cwd`));
    } catch {
      // The process exited, or its cwd is not ours to read; either way it is not evidence about us.
    }
  }
  return directories;
}

async function lsofWorkingDirectories(): Promise<ReadonlySet<string> | null> {
  try {
    const child = Bun.spawn(['lsof', '-a', '-d', 'cwd', '-Fpn'], {
      stdout: 'pipe', stderr: 'ignore',
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited, new Response(child.stdout).text(),
    ]);
    // `lsof` exits 1 when some process cannot be inspected, which is still a usable listing.
    if (exitCode !== 0 && exitCode !== 1) return null;
    const directories = new Set<string>();
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('n')) continue;
      const path = line.slice(1);
      if (path.length > 0) directories.add(path);
    }
    return directories;
  } catch {
    return null;
  }
}

interface GitMarkerInspection {
  readonly kind: 'FILE' | 'DIRECTORY' | 'ABSENT' | 'UNREADABLE';
  /** The `gitdir:`/`file:` target of a `.git` file, when it is a readable linked worktree. */
  readonly target: string | null;
}

/**
 * The Codeestra marker: every worktree this Runtime creates is a Git checkout, so a directory in an
 * owned root that carries no `.git` entry at all is not evidence of a Runtime-owned worktree.
 */
function inspectGitMarker(path: string): GitMarkerInspection {
  const marker = join(path, '.git');
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(marker);
  } catch {
    return { kind: 'ABSENT', target: null };
  }
  if (stats.isDirectory()) return { kind: 'DIRECTORY', target: null };
  if (!stats.isFile()) return { kind: 'UNREADABLE', target: null };
  try {
    const line = readFileSync(marker, 'utf8').split('\n')[0]?.trim() ?? '';
    const match = /^gitdir:\s*(.+)$/.exec(line);
    return { kind: 'FILE', target: match?.[1]?.trim() ?? null };
  } catch {
    return { kind: 'UNREADABLE', target: null };
  }
}

interface CandidateEvaluation {
  /** Null when the directory is not an unregistered candidate (the ledger already claims it). */
  readonly target: ReclaimUnregisteredTarget | null;
  /** True when the directory is present and every verified fact would allow a removal. */
  readonly removable: boolean;
}

interface UnregisteredScanContext {
  readonly storage: Phase1Database;
  readonly home: string;
  readonly scanRoot: string;
  readonly includeFailureScenes: boolean;
  readonly selected: readonly string[];
  /** Filled once per command by the scan; a recheck reuses the same read. */
  processDirectories: ReadonlySet<string> | null;
  readonly trustedProjects: Map<string, TrustedProject>;
  readonly taskCache: Map<string, Map<string, { displayNumber: number; state: TaskLifecycleState }>>;
  readonly claimedByLedger: string[];
}

function unregisteredTarget(input: {
  layoutKind: ReclaimKind;
  home: string;
  path: string;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskDisplayNumber: number | null;
  resourceId: string;
  action: ReclaimAction;
  reasonCode: string;
  detail: string;
  selected: boolean;
  evidence: Readonly<Record<string, unknown>>;
}): ReclaimUnregisteredTarget {
  return {
    source: 'UNREGISTERED_DIRECTORY',
    kind: 'UNREGISTERED_DIRECTORY',
    layoutKind: input.layoutKind,
    runtimeHome: input.home,
    path: input.path,
    projectId: input.projectId,
    projectName: input.projectName,
    taskId: input.taskId,
    taskDisplayNumber: input.taskDisplayNumber,
    resourceId: input.resourceId,
    resourceState: 'UNREGISTERED',
    action: input.action,
    reasonCode: input.reasonCode,
    detail: input.detail,
    selected: input.selected,
    evidence: input.evidence,
  };
}

function tasksOfProject(
  context: UnregisteredScanContext,
  projectId: string,
): Map<string, { displayNumber: number; state: TaskLifecycleState }> {
  const cached = context.taskCache.get(projectId);
  if (cached !== undefined) return cached;
  const tasks = new Map<string, { displayNumber: number; state: TaskLifecycleState }>();
  try {
    for (const task of context.storage.getReclamationCandidates(projectId).tasks) {
      tasks.set(task.taskId, { displayNumber: task.displayNumber, state: task.state });
    }
  } catch {
    // A project whose candidates cannot be read is attributed no Tasks; the directory is still
    // reported as unregistered, and the missing Task evidence keeps it unremovable.
  }
  context.taskCache.set(projectId, tasks);
  return tasks;
}

/**
 * Evaluates one candidate directory against every ownership fact. The order is the safety order:
 * a path that leaves the owned root, a path the ledger claims, a project that is not trusted, a
 * missing Git marker, unreadable Git state, an unanswerable process check, a process working inside
 * it, and uncommitted work all stop the deletion *before* the explicit selection is even looked at.
 */
async function evaluateUnregisteredCandidate(input: {
  readonly context: UnregisteredScanContext;
  readonly layoutKind: ReclaimKind;
  readonly path: string;
  readonly projectId: string | null;
  readonly resourceSegment: string;
}): Promise<CandidateEvaluation> {
  const { context } = input;
  const ownedRoot = ownedRootFor(context.home, input.layoutKind);
  const owned = await inspectOwnedPath({ ownedRoot, path: input.path });
  const selected = context.selected.some((candidate) => samePath(candidate, input.path));
  const trusted = input.projectId === null
    ? null : context.trustedProjects.get(input.projectId) ?? null;
  const tasks = trusted === null || input.projectId === null
    ? new Map<string, { displayNumber: number; state: TaskLifecycleState }>()
    : tasksOfProject(context, input.projectId);
  const task = input.layoutKind === 'TASK_WORKTREE' ? tasks.get(input.resourceSegment) : undefined;
  const claim: ReclamationPathClaim | null = context.storage.findReclaimPathClaim(input.path)
    // A recorded path may still be spelled through a symlink (an older row, or a home that was
    // reached differently when it was written), so the canonical spelling is asked about as well.
    ?? (owned.canonicalPath === null ? null
      : context.storage.findReclaimPathClaim(owned.canonicalPath));
  const marker = inspectGitMarker(input.path);
  const processesInUse = context.processDirectories === null
    ? []
    : [...context.processDirectories].filter((directory) => insidePath(directory, input.path));
  const evidence: Record<string, unknown> = {
    runtimeHome: context.home,
    ownedRoot: owned.ownedRoot,
    layout: `<home>/${layoutDirectoryByKind[input.layoutKind]}/<project-id>/<resource-id>`,
    pathExists: owned.exists,
    symlink: owned.symlink,
    canonicalPath: owned.canonicalPath,
    insideOwnedRoot: owned.insideOwnedRoot,
    projectSegment: input.projectId,
    projectTrusted: trusted !== null,
    projectName: trusted?.name ?? null,
    taskSegment: input.layoutKind === 'TASK_WORKTREE' ? input.resourceSegment : null,
    taskRecorded: task !== undefined,
    ledgerClaim: claim,
    gitMarker: marker.kind,
    gitMarkerTarget: marker.target,
    processCheck: context.processDirectories === null ? 'UNAVAILABLE' : 'AVAILABLE',
    processesInUse,
    explicitlySelected: selected,
  };
  const base = {
    layoutKind: input.layoutKind,
    home: context.home,
    path: input.path,
    projectId: input.projectId,
    projectName: trusted?.name ?? null,
    taskId: task === undefined ? null : input.resourceSegment,
    taskDisplayNumber: task?.displayNumber ?? null,
    resourceId: input.resourceSegment,
    selected,
    evidence,
  };
  const recovery = (reasonCode: string, detail: string): CandidateEvaluation => ({
    target: unregisteredTarget({ ...base, action: 'RECOVERY_REQUIRED', reasonCode, detail }),
    removable: false,
  });
  const refusal = (reasonCode: string, detail: string): CandidateEvaluation => ({
    target: unregisteredTarget({ ...base, action: 'REFUSE', reasonCode, detail }),
    removable: false,
  });

  if (owned.symlink) {
    return recovery('SYMLINK_ESCAPE',
      'The entry is a symlink and is never followed out of the Runtime data directory');
  }
  if (!owned.exists) {
    return recovery('MISSING', 'The directory disappeared while it was being evaluated');
  }
  if (!owned.insideOwnedRoot) {
    return recovery('PATH_OUTSIDE_OWNED_ROOT',
      'The entry resolves outside the Runtime-owned layout root');
  }
  if (claim !== null) {
    if (trusted !== null && claim.projectId === trusted.id) {
      // The ledger claims it: this is a registered resource, not an unregistered directory. It is
      // counted in the scan report and deliberately not listed as a second, competing target.
      context.claimedByLedger.push(input.path);
      return { removable: false, target: null };
    }
    return recovery('CLAIMED_BY_UNTRUSTED_PROJECT',
      `The ledger claims this path for project ${claim.projectId}, which is not an ACTIVE-trusted`
      + ' project of this Runtime; its ownership cannot be verified from here');
  }
  if (trusted === null || input.projectId === null) {
    return recovery('PROJECT_NOT_TRUSTED',
      `The path names project ${input.projectId ?? 'nothing'}, which is not an ACTIVE-trusted`
      + ' project of this Runtime; the directory cannot be attributed to a project');
  }
  if (task !== undefined && activeTaskStates.has(task.state)) {
    // The directory names a Task that is still live. A workspace row is missing, which is already
    // inconsistent, but the Task may be working in there: never delete under a running Task.
    return refusal('ACTIVE_TASK',
      `Task ${input.resourceSegment} is ${task.state} and may still be working in this directory`);
  }
  if (marker.kind === 'ABSENT' || marker.kind === 'UNREADABLE') {
    return recovery('NOT_A_CODEESTRA_WORKTREE',
      'The directory carries no readable .git marker, so it is not evidence of a Runtime-created'
      + ' worktree');
  }
  let registration: Awaited<ReturnType<typeof inspectOwnedWorktreeRegistration>>;
  try {
    // The owned worktree is registered in the repository that owns it: the project's dev clone when
    // one is recorded, otherwise the project folder itself (ADR-0056 / ADR-0060).
    registration = await inspectOwnedWorktreeRegistration({
      repositoryRoot: trusted.devRepoPath ?? trusted.repoRoot, path: input.path,
    });
  } catch (error) {
    if (error instanceof DevRepoError) {
      return recovery(error.code,
        `${error.message}; this directory's Git registration cannot be attributed to a repository`);
    }
    return recovery('GIT_INSPECTION_FAILED',
      `The Git worktree registry could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  evidence['registered'] = registration.registered;
  evidence['registeredPath'] = registration.registeredPath;
  evidence['registeredBranch'] = registration.branchRef;
  evidence['registrationHead'] = registration.headCommit;
  evidence['detached'] = registration.detached;
  let state: Awaited<ReturnType<typeof inspectWorktreeState>>;
  try {
    state = await inspectWorktreeState({ path: input.path });
  } catch (error) {
    return recovery('GIT_STATE_UNAVAILABLE',
      `The worktree state could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  evidence['clean'] = state.clean;
  evidence['trackedModifications'] = state.trackedModifications;
  evidence['untrackedFiles'] = state.untrackedFiles;
  if (state.available) evidence['headCommit'] = state.headCommit;
  if (!state.available) {
    return recovery('GIT_STATE_UNAVAILABLE',
      'Git cannot read this directory as a worktree, so its contents cannot be judged');
  }
  if (context.processDirectories === null) {
    return recovery('PROCESS_CHECK_UNAVAILABLE',
      'No process table could be read, so "is a process using this directory?" cannot be answered');
  }
  if (processesInUse.length > 0) {
    return recovery('PROCESS_IN_USE',
      `A running process works inside this directory (${processesInUse.join(', ')})`);
  }
  if (!state.clean && !context.includeFailureScenes) {
    return { removable: false, target: unregisteredTarget({ ...base, action: 'RETAIN',
      reasonCode: 'FAILURE_SCENE',
      detail: 'Retained as a failure scene: the worktree holds uncommitted work' }) };
  }
  if (!selected) {
    return { removable: false, target: unregisteredTarget({ ...base, action: 'RETAIN',
      reasonCode: 'UNREGISTERED_REQUIRES_EXPLICIT_SELECTION',
      detail: 'Unregistered directories are never removed implicitly; name this exact path with'
        + ' --remove-unregistered to reclaim it' }) };
  }
  return { removable: true, target: unregisteredTarget({ ...base, action: 'RECLAIM',
    reasonCode: state.clean ? 'UNREGISTERED_EXPLICIT_SELECTION' : 'FAILURE_SCENE_INCLUDED',
    detail: state.clean
      ? 'The explicitly selected unregistered directory passed every ownership check'
      : 'Included failure scene: the explicitly selected directory holds uncommitted work' }) };
}

function unregisteredCounts(targets: readonly ReclaimUnregisteredTarget[]): ReclaimCounts {
  return {
    total: targets.length,
    reclaim: targets.filter((target) => target.action === 'RECLAIM').length,
    retain: targets.filter((target) => target.action === 'RETAIN').length,
    refuse: targets.filter((target) => target.action === 'REFUSE').length,
    alreadyAbsent: 0,
    recoveryRequired: targets.filter((target) => target.action === 'RECOVERY_REQUIRED').length,
  };
}

interface UnregisteredScanResult {
  readonly output: ReclaimUnregisteredPlan;
  readonly candidates: readonly ReclaimUnregisteredTarget[];
  /** The project IDs a candidate may be attributed to at all (ACTIVE-trusted projects). */
  readonly trustedProjectIds: ReadonlySet<string>;
}

/**
 * Builds the read-only half of the scan: the identity of the home being scanned (the bounded scan
 * root, validated to live inside it), the path selection, the trusted projects and the process
 * table. Both a scan and a pre-removal recheck start from exactly this, so a recheck can never
 * judge a path against different facts than the plan did.
 */
async function createUnregisteredScanContext(input: {
  readonly storage: Phase1Database;
  readonly runtimeHome: string;
  readonly scanRoot?: string | undefined;
  readonly includeFailureScenes: boolean;
  readonly removeUnregistered?: readonly string[] | undefined;
}): Promise<UnregisteredScanContext> {
  const home = canonicalPath(input.runtimeHome);
  if (input.scanRoot !== undefined && !isAbsolute(input.scanRoot)) {
    throw new ReclaimServiceError('SCAN_ROOT_NOT_ABSOLUTE',
      'The unregistered scan root must be an absolute path');
  }
  const scanRoot = input.scanRoot === undefined ? home : canonicalPath(input.scanRoot);
  if (input.scanRoot !== undefined && !insidePath(scanRoot, home)) {
    throw new ReclaimServiceError('SCAN_ROOT_OUTSIDE_HOME',
      `The unregistered scan root ${scanRoot} is outside the Runtime home ${home}`);
  }
  return {
    storage: input.storage,
    home,
    scanRoot,
    includeFailureScenes: input.includeFailureScenes,
    // A selection may be spelled through a symlink too: it is canonicalized the same way the
    // candidate paths are, so `--remove-unregistered /tmp/...` and `/private/tmp/...` are the same.
    selected: [...new Set((input.removeUnregistered ?? []).map((path) => canonicalPath(path)))],
    processDirectories: null,
    trustedProjects: new Map(input.storage.listTrustedProjects()
      .map((project) => [project.id, project])),
    taskCache: new Map(),
    claimedByLedger: [],
  };
}

interface UnregisteredRecheck {
  readonly removable: boolean;
  readonly outcome: ReclamationOutcome;
  readonly reasonCode: string;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly registrationRegistered: boolean;
  readonly registrationBranchRef: string | null;
  readonly registrationHead: string | null;
  readonly repositoryRoot: string;
}

/**
 * Re-evaluates one selected directory immediately before it is deleted. Anything that changed since
 * the plan — a new symlink, an unclaimed-but-now-claimed path, a process that started inside it, a
 * new uncommitted file — turns into a recorded refusal instead of a deletion.
 */
async function recheckUnregisteredCandidate(input: {
  readonly context: UnregisteredScanContext;
  readonly target: ReclaimUnregisteredTarget;
}): Promise<UnregisteredRecheck> {
  const evaluation = await evaluateUnregisteredCandidate({
    context: input.context,
    layoutKind: input.target.layoutKind,
    path: input.target.path,
    projectId: input.target.projectId,
    resourceSegment: input.target.resourceId,
  });
  const repositoryRoot = input.target.projectId === null
    ? ''
    : (() => {
      const trusted = input.context.trustedProjects.get(input.target.projectId as string);
      // ADR-0060: the owning repository is the dev clone when one is recorded, otherwise the project
      // folder (`COALESCE(dev_repo_path, repo_root)`) — the same repository the worktree was created
      // in, so ownership can be re-proven at removal time either way.
      return trusted === undefined ? '' : trusted.devRepoPath ?? trusted.repoRoot;
    })();
  const fresh = evaluation.target;
  const evidence = fresh?.evidence ?? { recheck: 'CLAIMED_BY_LEDGER' };
  const facts = {
    registrationRegistered: evidence['registered'] === true,
    registrationBranchRef: typeof evidence['registeredBranch'] === 'string'
      ? evidence['registeredBranch'] : null,
    registrationHead: typeof evidence['registrationHead'] === 'string'
      ? evidence['registrationHead'] : null,
    repositoryRoot,
  };
  if (fresh === null) {
    return { removable: false, outcome: 'REFUSED', reasonCode: 'CLAIMED_BY_LEDGER',
      detail: 'The ledger claims this path now; it is no longer an unregistered directory',
      evidence, ...facts };
  }
  if (fresh.action === 'RECLAIM' && evaluation.removable) {
    // A removable directory must name the repository that owns it: without a dev clone the
    // ownership cannot be re-proven at removal time, so the recheck refuses instead of deleting.
    if (repositoryRoot.length === 0) {
      return { removable: false, outcome: 'RECOVERY_REQUIRED', reasonCode: 'DEV_REPO_REQUIRED',
        detail: 'This directory names a project whose owning repository cannot be named at removal'
          + ' time, so ownership cannot be re-proven; nothing is deleted',
        evidence, ...facts };
    }
    return { removable: true, outcome: 'RECLAIMED', reasonCode: fresh.reasonCode,
      detail: fresh.detail, evidence, ...facts };
  }
  if (fresh.action === 'RECOVERY_REQUIRED') {
    return { removable: false, outcome: 'RECOVERY_REQUIRED', reasonCode: fresh.reasonCode,
      detail: fresh.detail, evidence, ...facts };
  }
  return { removable: false, outcome: fresh.action === 'RETAIN' ? 'RETAINED' : 'REFUSED',
    reasonCode: fresh.reasonCode, detail: fresh.detail, evidence, ...facts };
}

/**
 * The removal itself, for a directory Git does not register as a worktree. It re-verifies the path
 * shape, the owned root and the Git marker one last time, then removes exactly that directory —
 * never a parent, never through a symlink, and never with a forced/recursive clean of anything
 * else. A registered worktree is always removed through `removeOwnedWorktree` instead.
 */
async function removeUnregisteredDirectory(input: {
  readonly ownedRoot: string;
  readonly path: string;
}): Promise<OwnedWorktreeRemoval> {
  const owned = await inspectOwnedPath({ ownedRoot: input.ownedRoot, path: input.path });
  const evidence: Record<string, unknown> = {
    ownedRoot: owned.ownedRoot, path: owned.path, canonicalPath: owned.canonicalPath,
    exists: owned.exists, symlink: owned.symlink, insideOwnedRoot: owned.insideOwnedRoot,
  };
  const refusal = (reasonCode: string, detail: string): OwnedWorktreeRemoval =>
    ({ outcome: 'REFUSED', reasonCode, detail, path: input.path, evidence });
  if (!owned.exists) {
    return { outcome: 'ALREADY_ABSENT', reasonCode: 'ALREADY_ABSENT',
      detail: 'The unregistered directory is already gone', path: input.path, evidence };
  }
  if (owned.symlink) {
    return refusal('SYMLINK_ESCAPE', 'The path became a symlink and is never followed');
  }
  if (!owned.insideOwnedRoot) {
    return refusal('PATH_OUTSIDE_OWNED_ROOT',
      'The path no longer resolves strictly inside the Runtime-owned layout root');
  }
  const segments = relative(owned.ownedRoot, owned.canonicalPath ?? input.path).split(sep);
  if (segments.length !== 2 || !segments.every((segment) => uuidPattern.test(segment))) {
    return refusal('UNRECOGNIZED_LAYOUT',
      'The path is not exactly <owned-root>/<project-id>/<resource-id>');
  }
  const marker = inspectGitMarker(owned.canonicalPath ?? input.path);
  evidence['gitMarker'] = marker.kind;
  if (marker.kind !== 'FILE' && marker.kind !== 'DIRECTORY') {
    return refusal('NOT_A_CODEESTRA_WORKTREE',
      'The directory no longer carries a readable .git marker');
  }
  try {
    rmSync(owned.canonicalPath ?? input.path, { recursive: true });
  } catch (error) {
    return { outcome: 'FAILED', reasonCode: 'REMOVAL_FAILED', path: input.path, evidence,
      detail: error instanceof Error ? error.message : String(error) };
  }
  if (existsSync(owned.canonicalPath ?? input.path)) {
    return { outcome: 'FAILED', reasonCode: 'REMOVAL_UNCONFIRMED', path: input.path, evidence,
      detail: 'The directory is still present after removal' };
  }
  return { outcome: 'REMOVED', reasonCode: 'UNREGISTERED_DIRECTORY_REMOVED', path: input.path,
    evidence,
    detail: 'The explicitly selected unregistered directory was removed; no branch was touched' };
}

/**
 * The bounded scan. It never follows a symlink, never descends past `<root>/<project>/<resource>`,
 * never leaves the given scan root, and stops after `maxUnregisteredCandidates` evaluations.
 */
async function scanUnregisteredDirectories(input: {
  readonly storage: Phase1Database;
  readonly runtimeHome: string;
  readonly scanRoot?: string | undefined;
  readonly includeFailureScenes: boolean;
  readonly removeUnregistered?: readonly string[] | undefined;
}): Promise<UnregisteredScanResult> {
  const context = await createUnregisteredScanContext(input);
  const home = context.home;
  const scanRoot = context.scanRoot;
  const scannedLayoutRoots: string[] = [];
  const candidates: string[] = [];
  let projectDirectories = 0;
  let resourceDirectories = 0;
  let skippedEntries = 0;
  let truncated = false;
  let needsProcessCheck = false;

  for (const layoutKind of reclaimKinds) {
    const layoutRoot = ownedRootFor(home, layoutKind);
    if (!overlapsPath(layoutRoot, scanRoot)) continue;
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(layoutRoot);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    scannedLayoutRoots.push(layoutRoot);
    for (const projectPath of directChildPaths(layoutRoot)) {
      if (!overlapsPath(projectPath, scanRoot)) continue;
      const projectSegment = relative(layoutRoot, projectPath);
      let projectStats: ReturnType<typeof lstatSync>;
      try {
        projectStats = lstatSync(projectPath);
      } catch {
        skippedEntries += 1;
        continue;
      }
      if (!projectStats.isDirectory() || projectStats.isSymbolicLink()) {
        if (uuidPattern.test(projectSegment) && insidePath(projectPath, scanRoot)) {
          candidates.push(projectPath);
          needsProcessCheck = true;
        } else {
          skippedEntries += 1;
        }
        continue;
      }
      projectDirectories += 1;
      if (!uuidPattern.test(projectSegment)) {
        // The layout itself does not hold here. The entry is reported as a candidate (so it is
        // visible and can be refused with a reason) but is never descended into.
        candidates.push(projectPath);
        needsProcessCheck = true;
        continue;
      }
      for (const resourcePath of directChildPaths(projectPath)) {
        if (!insidePath(resourcePath, scanRoot)) continue;
        let resourceStats: ReturnType<typeof lstatSync>;
        try {
          resourceStats = lstatSync(resourcePath);
        } catch {
          skippedEntries += 1;
          continue;
        }
        if (!resourceStats.isDirectory() && !resourceStats.isSymbolicLink()) {
          skippedEntries += 1;
          continue;
        }
        resourceDirectories += 1;
        candidates.push(resourcePath);
        needsProcessCheck = true;
        if (candidates.length >= maxUnregisteredCandidates) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    if (truncated) break;
  }

  if (needsProcessCheck) context.processDirectories = context.processDirectories
    ?? await processWorkingDirectories();
  const evaluations: CandidateEvaluation[] = [];
  for (const path of candidates) {
    const relativeSegments = relative(home, path).split(sep);
    const layoutSegment = relativeSegments.length > 1 ? relativeSegments[0] as string : '';
    const layoutKind = kindByLayoutDirectory[layoutSegment];
    const projectSegment = relativeSegments.length > 2 ? relativeSegments[1] as string : null;
    const resourceSegment = relativeSegments[relativeSegments.length - 1] as string;
    if (layoutKind === undefined) continue;
    evaluations.push(await evaluateUnregisteredCandidate({
      context,
      layoutKind,
      path,
      projectId: projectSegment !== null && uuidPattern.test(projectSegment)
        ? projectSegment : null,
      resourceSegment,
    }));
  }

  const attributable = evaluations.filter((evaluation) =>
    evaluation.target !== null
    && evaluation.target.projectId !== null
    && context.trustedProjects.has(evaluation.target.projectId));
  const unattributed = evaluations.filter((evaluation) =>
    evaluation.target !== null && !attributable.includes(evaluation));
  const allCandidates = [...attributable, ...unattributed]
    .map((evaluation) => evaluation.target as ReclaimUnregisteredTarget)
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    output: {
      scan: {
        home,
        scanRoot: input.scanRoot === undefined ? null : scanRoot,
        layoutRoots: scannedLayoutRoots,
        projectDirectories,
        resourceDirectories,
        claimedByLedger: [...context.claimedByLedger].sort(),
        skippedEntries,
        truncated,
        processCheck: context.processDirectories === null ? 'UNAVAILABLE' : 'AVAILABLE',
      },
      targets: allCandidates,
      counts: unregisteredCounts(allCandidates),
    },
    candidates: allCandidates,
    trustedProjectIds: new Set(context.trustedProjects.keys()),
  };
}

interface BuiltPlan {
  readonly plan: ReclaimPlan;
  readonly candidates: ReclamationCandidates;
}

/**
 * Decides, for every Runtime-owned resource of a project, whether it may be removed. Nothing is
 * written and nothing is deleted: this is the same read-only evaluation `reclaim.apply` starts
 * from, so a preview and a real run can never disagree about *what* is owned.
 *
 * Decision order matters: a live owner is refused before anything else, a resource whose path
 * escapes the Runtime root is refused before its registration is even considered, and a failure
 * scene is retained unless the caller explicitly asked for it.
 */
async function buildPlan(input: ReclaimPlanInput): Promise<BuiltPlan> {
  const kinds = input.kinds === undefined ? reclaimKinds : [...new Set(input.kinds)];
  const includeFailureScenes = input.includeFailureScenes ?? false;
  let candidates: ReclamationCandidates;
  try {
    candidates = input.storage.getReclamationCandidates(input.projectId, {
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    });
  } catch (error) {
    if (error instanceof StorageError) throw new ReclaimServiceError(error.code, error.message);
    throw error;
  }
  // ADR-0056 / ADR-0060: every recorded worktree and Task branch lives in the repository that owns
  // them — the dev clone when one is recorded, otherwise the project folder itself (`repoRoot` is
  // already that `COALESCE`). No project is refused for lacking a dev clone: a managed project's
  // worktrees are just as reclaimable as a promoting project's.
  const repositoryRoot = candidates.project.repoRoot;
  let devCommit: string | null = null;
  try {
    devCommit = await readLocalRefCommit({ repositoryRoot, ref: candidates.project.devRef });
  } catch {
    // An unreadable baseline only means "mergedness is unknown"; every unknown is treated as
    // "not merged", which retains the resource instead of deleting it.
    devCommit = null;
  }
  const taskById = new Map(candidates.tasks.map((task) => [task.taskId, task]));
  const targets: ReclaimTarget[] = [];
  const wanted = new Set(kinds);

  if (wanted.has('TASK_WORKTREE')) {
    for (const workspace of candidates.workspaces) {
      const task = taskById.get(workspace.taskId);
      if (task === undefined) continue;
      const ownedRoot = ownedRootFor(input.runtimeHome, 'TASK_WORKTREE');
      const owned = await inspectOwnedPath({ ownedRoot, path: workspace.path });
      const registration = await inspectOwnedWorktreeRegistration({
        repositoryRoot, path: workspace.path,
      });
      const state = registration.registered && registration.pathExists
        ? await inspectWorktreeState({ path: workspace.path })
        : null;
      let merged: boolean | null = null;
      if (task.resultCommit !== null) {
        // ADR-0060: "already merged" is measured against the ref this workspace was based on — the
        // dev clone's `dev` for a promoting project, the project folder's branch for a managed one.
        // A result that is not reachable from that ref is *not* merged, so the worktree is retained.
        const mergeTargetRef = workspace.baseRef ?? candidates.project.devRef;
        const mergeTarget = await readLocalRefCommit({
          repositoryRoot, ref: mergeTargetRef,
        }).catch(() => null);
        if (mergeTarget !== null) {
          try {
            merged = await isAncestor({
              repositoryRoot, ancestor: task.resultCommit, descendant: mergeTarget,
            });
          } catch {
            merged = null;
          }
        }
      }
      const evidence: Record<string, unknown> = {
        ownedRoot: owned.ownedRoot,
        pathExists: owned.exists,
        symlink: owned.symlink,
        canonicalPath: owned.canonicalPath,
        insideOwnedRoot: owned.insideOwnedRoot,
        registered: registration.registered,
        registeredPath: registration.registeredPath,
        registeredBranch: registration.branchRef,
        registrationHead: registration.headCommit,
        branchRef: workspace.branchRef,
        baseCommit: workspace.baseCommit,
        headCommit: state?.headCommit ?? registration.headCommit,
        taskState: task.state,
        workspaceState: workspace.state,
        resourceHeld: workspace.resourceHeld,
        activeReservation: workspace.activeReservation,
        reservationState: workspace.reservationState,
        activeReservationId: workspace.reservationId,
        resultCommit: task.resultCommit,
        devCommit,
        mergeTargetRef: workspace.baseRef ?? candidates.project.devRef,
        merged,
        clean: state === null ? null : state.clean,
        trackedModifications: state?.trackedModifications ?? [],
        untrackedFiles: state?.untrackedFiles ?? [],
      };
      const base = {
        kind: 'TASK_WORKTREE' as const,
        projectId: input.projectId,
        taskId: workspace.taskId,
        taskDisplayNumber: task.displayNumber,
        resourceId: workspace.workspaceId,
        resourceState: workspace.state,
        path: workspace.path,
        ownershipToken: workspace.ownershipToken,
        externalRef: workspace.branchRef,
        evidence,
      };
      const refusal = (reasonCode: string, detail: string): ReclaimTarget =>
        ({ ...base, action: 'REFUSE', reasonCode, detail });
      // ADR-0058 D09: a forced purge has already retired this Task, so the gates that protect a live
      // run no longer apply to it. Everything below them is an ownership check and still applies.
      const liveClaimsApply = input.ignoreLiveClaims !== true;
      if (liveClaimsApply && workspace.resourceHeld) {
        targets.push(refusal('ACTIVE_EXECUTION',
          'An Execution of this Task still holds its resources; cancel or wait for it first'));
      } else if (liveClaimsApply && workspace.activeReservation) {
        // A slot reservation outlives the Execution it will start, so it is a live claim in its own
        // right; `--include-failure-scenes` must not be able to override it.
        targets.push(refusal('ACTIVE_RESERVATION',
          `Slot reservation ${workspace.reservationId ?? 'unknown'}`
          + ` (${workspace.reservationState ?? 'RESERVED'}) still claims this workspace`));
      } else if (liveClaimsApply && activeTaskStates.has(task.state)) {
        targets.push(refusal('TASK_NOT_TERMINAL',
          `Task is ${task.state} and still owns its workspace`));
      } else if (liveClaimsApply && !terminalTaskStates.has(task.state)) {
        targets.push(refusal('TASK_NOT_TERMINAL',
          `Task is ${task.state}; only a finished Task's workspace can be reclaimed`));
      } else if (owned.symlink) {
        targets.push(refusal('SYMLINK_ESCAPE',
          'The recorded workspace path is a symlink and is never followed'));
      } else if (owned.exists && !owned.insideOwnedRoot) {
        targets.push(refusal('PATH_OUTSIDE_OWNED_ROOT',
          'The recorded workspace path resolves outside the Runtime worktrees root'));
      } else if (!registration.registered && !registration.pathExists) {
        targets.push({ ...base, action: 'ALREADY_ABSENT', reasonCode: 'ALREADY_ABSENT',
          detail: 'The worktree is neither registered nor present on disk' });
      } else if (registration.registered && !registration.pathExists) {
        targets.push({ ...base, action: 'RECLAIM', reasonCode: 'REGISTRATION_ONLY',
          detail: 'Only a stale worktree registration is left; it is pruned without deleting anything' });
      } else if (!registration.registered) {
        targets.push(refusal('UNREGISTERED_DIRECTORY',
          'A directory exists at the recorded path but Git does not register it as this worktree'));
      } else if (registration.registeredPath === null
        || !samePath(registration.registeredPath, owned.canonicalPath ?? workspace.path)) {
        targets.push(refusal('REGISTRATION_PATH_MISMATCH',
          'The Git worktree registration does not match the recorded workspace path'));
      } else if (registration.branchRef !== workspace.branchRef) {
        targets.push(refusal('BRANCH_MISMATCH',
          `The worktree is on ${registration.branchRef ?? 'a detached HEAD'}, not ${workspace.branchRef}`));
      } else {
        const scene: string[] = [];
        if (task.state === 'FAILED' || task.state === 'CANCELLED') scene.push(`task ${task.state}`);
        if (workspace.state === 'RECOVERY_REQUIRED') scene.push('workspace RECOVERY_REQUIRED');
        if (state !== null && !state.clean) scene.push('uncommitted work in the worktree');
        if (merged !== true) scene.push(merged === null
          ? 'no captured result commit, so nothing proves the work reached dev'
          : 'the result commit is not merged into dev');
        if (scene.length > 0 && !includeFailureScenes) {
          targets.push({ ...base, action: 'RETAIN', reasonCode: 'FAILURE_SCENE',
            detail: `Retained as a failure scene: ${scene.join('; ')}` });
        } else {
          targets.push({ ...base, action: 'RECLAIM',
            reasonCode: scene.length === 0 ? 'COMPLETED_AND_QUIESCENT' : 'FAILURE_SCENE_INCLUDED',
            detail: scene.length === 0
              ? 'The worktree is clean, its result is in dev, and no Execution holds it'
              : `Included failure scene: ${scene.join('; ')}` });
        }
      }
    }
  }

  if (wanted.has('VERIFICATION_COPY')) {
    for (const copy of candidates.verificationCopies) {
      const task = taskById.get(copy.taskId);
      if (task === undefined) continue;
      const ownedRoot = ownedRootFor(input.runtimeHome, 'VERIFICATION_COPY');
      const owned = await inspectOwnedPath({ ownedRoot, path: copy.copyPath });
      const registration = await inspectOwnedWorktreeRegistration({
        repositoryRoot, path: copy.copyPath,
      });
      const evidence: Record<string, unknown> = {
        ownedRoot: owned.ownedRoot,
        pathExists: owned.exists,
        symlink: owned.symlink,
        canonicalPath: owned.canonicalPath,
        insideOwnedRoot: owned.insideOwnedRoot,
        registered: registration.registered,
        registeredPath: registration.registeredPath,
        detached: registration.detached,
        registrationHead: registration.headCommit,
        testedCommit: copy.testedCommit,
        verificationState: copy.state,
        outcomeCode: copy.outcomeCode,
      };
      const base = {
        kind: 'VERIFICATION_COPY' as const,
        projectId: input.projectId,
        taskId: copy.taskId,
        taskDisplayNumber: task.displayNumber,
        resourceId: copy.verificationId,
        resourceState: copy.state,
        path: copy.copyPath,
        ownershipToken: null,
        externalRef: copy.testedCommit,
        evidence,
      };
      const refusal = (reasonCode: string, detail: string): ReclaimTarget =>
        ({ ...base, action: 'REFUSE', reasonCode, detail });
      if (input.ignoreLiveClaims !== true && (copy.state === 'QUEUED' || copy.state === 'RUNNING')) {
        targets.push(refusal('ACTIVE_VERIFICATION',
          `Verification run is ${copy.state} and still owns its copy`));
      } else if (owned.symlink) {
        targets.push(refusal('SYMLINK_ESCAPE',
          'The recorded copy path is a symlink and is never followed'));
      } else if (owned.exists && !owned.insideOwnedRoot) {
        targets.push(refusal('PATH_OUTSIDE_OWNED_ROOT',
          'The recorded copy path resolves outside the Runtime verifications root'));
      } else if (!registration.registered && !registration.pathExists) {
        targets.push({ ...base, action: 'ALREADY_ABSENT', reasonCode: 'ALREADY_ABSENT',
          detail: 'The verification copy is neither registered nor present on disk' });
      } else if (registration.registered && !registration.pathExists) {
        targets.push({ ...base, action: 'RECLAIM', reasonCode: 'REGISTRATION_ONLY',
          detail: 'Only a stale copy registration is left; it is pruned without deleting anything' });
      } else if (!registration.registered) {
        targets.push(refusal('UNREGISTERED_DIRECTORY',
          'A directory exists at the recorded copy path but Git does not register it'));
      } else if (!registration.detached || registration.headCommit !== copy.testedCommit) {
        targets.push(refusal('HEAD_MISMATCH',
          'The copy is not the detached checkout of the commit its verification tested'));
      } else if ((copy.state === 'FAILED' || copy.state === 'ERROR'
        || copy.state === 'CANCELLED') && !includeFailureScenes) {
        targets.push({ ...base, action: 'RETAIN', reasonCode: 'FAILURE_SCENE',
          detail: `Retained as a failure scene: verification ended ${copy.state}`
            + `${copy.outcomeCode === null ? '' : ` (${copy.outcomeCode})`}` });
      } else {
        targets.push({ ...base, action: 'RECLAIM',
          reasonCode: copy.state === 'FAILED' || copy.state === 'ERROR'
            || copy.state === 'CANCELLED'
            ? 'FAILURE_SCENE_INCLUDED' : 'COMPLETED_VERIFICATION',
          detail: 'The recorded copy still exists and its ownership matches its verification record' });
      }
    }
  }

  if (wanted.has('INTEGRATION_WORKTREE')) {
    for (const batch of candidates.integrationWorktrees) {
      const task = taskById.get(batch.taskId);
      if (task === undefined) continue;
      const ownedRoot = ownedRootFor(input.runtimeHome, 'INTEGRATION_WORKTREE');
      const owned = await inspectOwnedPath({ ownedRoot, path: batch.worktreePath });
      const registration = await inspectOwnedWorktreeRegistration({
        repositoryRoot, path: batch.worktreePath,
      });
      const recordedCommits = [batch.devCommit, batch.mergedCommit, batch.integratedCommit]
        .filter((commit): commit is string => commit !== null);
      const evidence: Record<string, unknown> = {
        ownedRoot: owned.ownedRoot,
        pathExists: owned.exists,
        symlink: owned.symlink,
        canonicalPath: owned.canonicalPath,
        insideOwnedRoot: owned.insideOwnedRoot,
        registered: registration.registered,
        registeredPath: registration.registeredPath,
        detached: registration.detached,
        registrationHead: registration.headCommit,
        devCommit: batch.devCommit,
        mergedCommit: batch.mergedCommit,
        integratedCommit: batch.integratedCommit,
        batchState: batch.state,
        worktreeOwnershipToken: batch.ownershipToken,
        batchDetail: batch.detail,
      };
      const base = {
        kind: 'INTEGRATION_WORKTREE' as const,
        projectId: input.projectId,
        taskId: batch.taskId,
        taskDisplayNumber: task.displayNumber,
        resourceId: batch.batchId,
        resourceState: batch.state,
        path: batch.worktreePath,
        ownershipToken: batch.ownershipToken,
        externalRef: batch.mergedCommit ?? batch.integratedCommit ?? batch.devCommit,
        evidence,
      };
      const refusal = (reasonCode: string, detail: string): ReclaimTarget =>
        ({ ...base, action: 'REFUSE', reasonCode, detail });
      if (activeIntegrationStates.has(batch.state)) {
        targets.push(refusal('ACTIVE_INTEGRATION',
          `Integration batch is ${batch.state} and still owns its worktree`));
      } else if (owned.symlink) {
        targets.push(refusal('SYMLINK_ESCAPE',
          'The recorded integration worktree path is a symlink and is never followed'));
      } else if (owned.exists && !owned.insideOwnedRoot) {
        targets.push(refusal('PATH_OUTSIDE_OWNED_ROOT',
          'The recorded integration path resolves outside the Runtime integrations root'));
      } else if (!registration.registered && !registration.pathExists) {
        targets.push({ ...base, action: 'ALREADY_ABSENT', reasonCode: 'ALREADY_ABSENT',
          detail: 'The integration worktree is neither registered nor present on disk' });
      } else if (registration.registered && !registration.pathExists) {
        targets.push({ ...base, action: 'RECLAIM', reasonCode: 'REGISTRATION_ONLY',
          detail: 'Only a stale integration worktree registration is left; it is pruned' });
      } else if (!registration.registered) {
        targets.push(refusal('UNREGISTERED_DIRECTORY',
          'A directory exists at the recorded integration path but Git does not register it'));
      } else if (!registration.detached || registration.headCommit === null
        || !recordedCommits.includes(registration.headCommit)) {
        targets.push(refusal('HEAD_MISMATCH',
          'The integration worktree is not the detached checkout of a commit its batch recorded'));
      } else if (failureIntegrationStates.has(batch.state) && !includeFailureScenes) {
        targets.push({ ...base, action: 'RETAIN', reasonCode: 'FAILURE_SCENE',
          detail: `Retained as a failure scene: integration batch is ${batch.state}` });
      } else {
        targets.push({ ...base, action: 'RECLAIM',
          reasonCode: failureIntegrationStates.has(batch.state)
            ? 'FAILURE_SCENE_INCLUDED' : 'COMPLETED_INTEGRATION',
          detail: 'The recorded integration worktree still exists and its ownership matches its batch' });
      }
    }
  }

  targets.sort((left, right) => left.taskDisplayNumber - right.taskDisplayNumber
    || left.kind.localeCompare(right.kind)
    || left.resourceId.localeCompare(right.resourceId));
  const counts = registeredCounts(targets);
  // The unregistered half of the plan. It is scanned once per command: a batch performs the scan
  // itself and hands the result down, so the bounded walk (and the single process-table read) is
  // never repeated per project.
  let unregistered: ReclaimUnregisteredPlan | null = null;
  if (input.unregistered === true) {
    const scan = input.unregisteredScan
      ?? await scanUnregisteredDirectories({
        storage: input.storage,
        runtimeHome: input.runtimeHome,
        scanRoot: input.scanRoot,
        includeFailureScenes,
        removeUnregistered: input.removeUnregistered,
      });
    const mine = scan.candidates.filter((candidate) => candidate.projectId === input.projectId);
    const unattributed = input.reportUnattributed === true
      ? scan.candidates.filter((candidate) => candidate.projectId === null
        || !scan.trustedProjectIds.has(candidate.projectId))
      : [];
    const targets = [...mine, ...unattributed]
      .sort((left, right) => left.path.localeCompare(right.path));
    unregistered = { scan: scan.output.scan, targets, counts: unregisteredCounts(targets) };
  }
  return {
    plan: {
      scope: 'PROJECT',
      projectId: input.projectId,
      projectName: candidates.project.name,
      taskId: input.taskId ?? null,
      includeFailureScenes,
      kinds,
      devCommit,
      targets,
      counts,
      unregistered,
    },
    candidates,
  };
}

function registeredCounts(targets: readonly ReclaimTarget[]): ReclaimCounts {
  return {
    total: targets.length,
    reclaim: targets.filter((target) => target.action === 'RECLAIM').length,
    retain: targets.filter((target) => target.action === 'RETAIN').length,
    refuse: targets.filter((target) => target.action === 'REFUSE').length,
    alreadyAbsent: targets.filter((target) => target.action === 'ALREADY_ABSENT').length,
    recoveryRequired: 0,
  };
}

/** Read-only preview: performs no deletion and writes nothing. */
export async function planReclamation(input: ReclaimPlanInput): Promise<ReclaimPlan> {
  return (await buildPlan(input)).plan;
}

interface RecordedTarget {
  readonly kind: ReclaimKind | 'UNREGISTERED_DIRECTORY';
  readonly source: ReclamationSource;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly resourceId: string;
  readonly path: string;
  readonly ownershipToken: string | null;
  readonly externalRef: string | null;
  readonly resourceState: string;
  /** Empty for an unregistered directory: there is no recorded repository to check it against. */
  readonly repositoryRoot: string;
  readonly action: ReclaimAction;
}

function recordInput(
  target: ReclaimTarget,
  id: string,
  outcome: ReclamationOutcome,
  reasonCode: string,
  detail: string,
  evidence: Readonly<Record<string, unknown>>,
): ReclamationRecordInput {
  return {
    id,
    taskId: target.taskId,
    kind: target.kind,
    source: 'REGISTERED',
    resourceId: target.resourceId,
    path: target.path,
    ownershipToken: target.ownershipToken,
    externalRef: target.externalRef,
    resourceState: target.resourceState,
    outcome,
    reasonCode,
    detail,
    evidence,
  };
}

function unregisteredRecordInput(
  target: ReclaimUnregisteredTarget,
  id: string,
  outcome: ReclamationOutcome,
  reasonCode: string,
  detail: string,
  evidence: Readonly<Record<string, unknown>>,
): ReclamationRecordInput {
  return {
    id,
    taskId: target.taskId,
    kind: 'UNREGISTERED_DIRECTORY',
    source: 'UNREGISTERED_DIRECTORY',
    // The recorded path is the identity of the resource: there is no row to point at, so the path
    // the ledger already claims (or the absence of such a claim) is the whole evidence chain.
    resourceId: target.path,
    path: target.path,
    ownershipToken: null,
    externalRef: null,
    resourceState: target.resourceState,
    outcome,
    reasonCode,
    detail,
    evidence,
  };
}

function removeOutcome(outcome: 'REMOVED' | 'ALREADY_ABSENT' | 'REFUSED' | 'FAILED'): ReclamationOutcome {
  if (outcome === 'REMOVED') return 'RECLAIMED';
  if (outcome === 'ALREADY_ABSENT') return 'ALREADY_ABSENT';
  return outcome;
}

/**
 * Executes one reclamation. The plan is rebuilt here, every removal re-verifies ownership at the
 * moment it acts, and each decision lands in the append-only ledger. A resource that is already
 * gone is reported, not treated as a failure, so running the command twice is harmless.
 */
export async function applyReclamation(input: ReclaimApplyInput): Promise<ReclaimReport> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const kinds = input.kinds === undefined ? reclaimKinds : [...new Set(input.kinds)];
  const includeFailureScenes = input.includeFailureScenes ?? false;
  const payloadHash = sha256(JSON.stringify({
    projectId: input.projectId,
    taskId: input.taskId ?? null,
    kinds: [...kinds].sort(),
    includeFailureScenes,
    unregistered: input.unregistered === true,
    scanRoot: input.scanRoot ?? null,
    // A selection of paths to delete is part of the request identity: replaying the same command
    // ID with a different selection must be a conflict, not a second, wider run.
    removeUnregistered: [...(input.removeUnregistered ?? [])].map((path) => resolve(path)).sort(),
  }));
  const existing = input.storage.findReclamationOperation(input.projectId, input.commandId);
  if (existing !== null) {
    if (existing.request['payloadHash'] !== payloadHash) {
      throw new ReclaimServiceError('COMMAND_CONFLICT',
        'Command ID was already used with a different reclamation request');
    }
    if (existing.result !== null
      && (existing.operationState === 'SUCCEEDED' || existing.operationState === 'FAILED')) {
      return {
        ...(existing.result as unknown as ReclaimReport),
        alreadyCompleted: true,
        created: false,
      };
    }
    throw new ReclaimServiceError('RECLAMATION_IN_PROGRESS',
      `Reclamation operation ${existing.operationId} is ${existing.operationState};`
      + ' it was interrupted and must be reconciled before it can be replayed');
  }

  const built = await buildPlan({ ...input, kinds, includeFailureScenes });
  const repositoryRoot = built.candidates.project.repoRoot;
  const unregisteredTargets = built.plan.unregistered?.targets ?? [];
  const recordedTargets: RecordedTarget[] = [
    ...built.plan.targets.map((target): RecordedTarget => ({
      kind: target.kind,
      source: 'REGISTERED',
      projectId: target.projectId,
      taskId: target.taskId,
      resourceId: target.resourceId,
      path: target.path,
      ownershipToken: target.ownershipToken,
      externalRef: target.externalRef,
      resourceState: target.resourceState,
      repositoryRoot,
      action: target.action,
    })),
    ...unregisteredTargets.map((target): RecordedTarget => ({
      kind: 'UNREGISTERED_DIRECTORY',
      source: 'UNREGISTERED_DIRECTORY',
      projectId: input.projectId,
      taskId: target.taskId,
      resourceId: target.path,
      path: target.path,
      ownershipToken: null,
      externalRef: null,
      resourceState: target.resourceState,
      repositoryRoot: '',
      action: target.action,
    })),
  ];
  const operation = input.storage.planReclamationOperation({
    operationId: randomUUID(),
    projectId: input.projectId,
    commandId: input.commandId,
    request: {
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      kinds,
      includeFailureScenes,
      unregistered: input.unregistered === true,
      payloadHash,
      targets: recordedTargets,
    },
    createdAt: now(),
  });
  input.storage.startReclamationOperation(operation.operationId, now());

  const records: ReclamationRecordInput[] = [];
  for (const target of built.plan.targets) {
    if (target.action === 'ALREADY_ABSENT') {
      records.push(recordInput(target, randomUUID(), 'ALREADY_ABSENT',
        target.reasonCode, target.detail, target.evidence));
      continue;
    }
    if (target.action === 'RETAIN' || target.action === 'REFUSE') {
      records.push(recordInput(target, randomUUID(),
        target.action === 'RETAIN' ? 'RETAINED' : 'REFUSED',
        target.reasonCode, target.detail, target.evidence));
      continue;
    }
    const ownedRoot = ownedRootFor(input.runtimeHome, target.kind);
    if (target.kind === 'TASK_WORKTREE') {
      // A reservation granted after the plan still claims this workspace: the directory must not be
      // deleted under it, so the claim is read again here rather than assumed to be unchanged. A
      // forced purge (ADR-0058 D09) has already retired the Task this reservation belongs to, so it
      // is the one caller that does not re-check it.
      const reservation = input.ignoreLiveClaims === true
        ? null
        : input.storage.findActiveWorkspaceReservation({
          projectId: input.projectId, workspaceId: target.resourceId,
        });
      if (reservation !== null) {
        records.push(recordInput(target, randomUUID(), 'REFUSED', 'ACTIVE_RESERVATION',
          `Slot reservation ${reservation.reservationId} (${reservation.state}) still claims this`
          + ' workspace', { ...target.evidence, reservation }));
        continue;
      }
    }
    const observedHead = typeof target.evidence['registrationHead'] === 'string'
      ? target.evidence['registrationHead'] as string
      : null;
    const removal = await removeOwnedWorktree({
      repositoryRoot,
      ownedRoot,
      path: target.path,
      ...(target.kind === 'TASK_WORKTREE'
        ? { expectedBranchRef: target.externalRef as string }
        : { expectedDetachedCommit: target.kind === 'VERIFICATION_COPY'
            ? target.externalRef as string
            : observedHead as string }),
    });
    const outcome = removeOutcome(removal.outcome);
    const evidence = { ...target.evidence, removal: removal.evidence,
      removalReasonCode: removal.reasonCode };
    // Set when a forced purge (ADR-0058 D09) could not release the workspace row because a live claim
    // still owns it. The removal itself stands: the purge deletes that row in its own transaction.
    let releaseNote: Readonly<Record<string, unknown>> = {};
    if (target.kind === 'TASK_WORKTREE' && (outcome === 'RECLAIMED' || outcome === 'ALREADY_ABSENT')) {
      try {
        input.storage.releaseWorkspaceForReclamation({
          projectId: input.projectId,
          taskId: target.taskId,
          workspaceId: target.resourceId,
          expectedPath: target.path,
          eventId: randomUUID(),
          reason: removal.reasonCode,
          releasedAt: now(),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (input.ignoreLiveClaims === true) {
          // A forced purge has already decided this Task is going away: the Execution holding the
          // workspace is one of the rows it deletes in the same command, so a refused release is a
          // note on the record instead of a failed removal that leaves the directory in place.
          releaseNote = { workspaceRelease: { outcome: 'REFUSED_UNDER_LIVE_CLAIM', detail } };
        } else {
          // The directory is gone but the workspace row still claims ownership. Saying so is the
          // honest outcome; the next run reconciles the row without deleting anything again.
          records.push(recordInput(target, randomUUID(), 'FAILED', 'WORKSPACE_RELEASE_FAILED',
            detail, evidence));
          continue;
        }
      }
    }
    records.push(recordInput(target, randomUUID(), outcome, removal.reasonCode,
      removal.detail, { ...evidence, ...releaseNote }));
  }

  // The unregistered half. Each candidate was already decided by the one scan this command
  // performed; a selected removal is evaluated *again* right here, so every ownership fact must
  // still agree at the moment of the deletion. The process table is read once for the whole command.
  const removalRecheckContext = unregisteredTargets.some((target) => target.action === 'RECLAIM')
    ? await (async () => {
      const context = await createUnregisteredScanContext({
        storage: input.storage,
        runtimeHome: input.runtimeHome,
        scanRoot: input.scanRoot,
        includeFailureScenes,
        removeUnregistered: input.removeUnregistered,
      });
      // The process table is read once for the whole command: the recheck must judge exactly the
      // same facts (including "no process is working in there") that the plan did.
      context.processDirectories = await processWorkingDirectories();
      return context;
    })()
    : null;
  for (const target of unregisteredTargets) {
    if (target.action === 'RETAIN') {
      records.push(unregisteredRecordInput(target, randomUUID(), 'RETAINED',
        target.reasonCode, target.detail, target.evidence));
      continue;
    }
    if (target.action === 'REFUSE' || target.action === 'ALREADY_ABSENT') {
      records.push(unregisteredRecordInput(target, randomUUID(),
        target.action === 'REFUSE' ? 'REFUSED' : 'ALREADY_ABSENT',
        target.reasonCode, target.detail, target.evidence));
      continue;
    }
    if (target.action === 'RECOVERY_REQUIRED') {
      records.push(unregisteredRecordInput(target, randomUUID(), 'RECOVERY_REQUIRED',
        target.reasonCode, target.detail, target.evidence));
      continue;
    }
    const recheck = await recheckUnregisteredCandidate({
      context: removalRecheckContext as UnregisteredScanContext,
      target,
    });
    if (!recheck.removable) {
      records.push(unregisteredRecordInput(target, randomUUID(), recheck.outcome,
        recheck.reasonCode, recheck.detail, { ...target.evidence, recheck: recheck.evidence }));
      continue;
    }
    const removal = recheck.registrationRegistered
      ? await removeOwnedWorktree({
        repositoryRoot: recheck.repositoryRoot,
        ownedRoot: ownedRootFor(input.runtimeHome, target.layoutKind),
        path: target.path,
        ...(recheck.registrationBranchRef === null
          ? { expectedDetachedCommit: recheck.registrationHead as string }
          : { expectedBranchRef: recheck.registrationBranchRef }),
      })
      : await removeUnregisteredDirectory({
        ownedRoot: ownedRootFor(input.runtimeHome, target.layoutKind),
        path: target.path,
      });
    records.push(unregisteredRecordInput(target, randomUUID(), removeOutcome(removal.outcome),
      removal.reasonCode, removal.detail,
      { ...target.evidence, removal: removal.evidence, removalReasonCode: removal.reasonCode }));
  }

  const outcomeCounts: ReclaimOutcomeCounts = {
    reclaimed: records.filter((record) => record.outcome === 'RECLAIMED').length,
    alreadyAbsent: records.filter((record) => record.outcome === 'ALREADY_ABSENT').length,
    retained: records.filter((record) => record.outcome === 'RETAINED').length,
    refused: records.filter((record) => record.outcome === 'REFUSED').length,
    failed: records.filter((record) => record.outcome === 'FAILED').length,
    recoveryRequired: records.filter((record) => record.outcome === 'RECOVERY_REQUIRED').length,
  };
  const outcome = outcomeCounts.failed > 0 ? 'FAILED' as const : 'SUCCEEDED' as const;
  const completedAt = now();
  const report: ReclaimReport = {
    ...built.plan,
    operationId: operation.operationId,
    outcome,
    records: records.map((record) => ({
      ...record,
      projectId: input.projectId,
      operationId: operation.operationId,
      commandId: input.commandId,
      createdAt: completedAt,
    })),
    outcomeCounts,
    alreadyCompleted: false,
    created: true,
  };
  input.storage.finishReclamationOperation({
    operationId: operation.operationId,
    projectId: input.projectId,
    commandId: input.commandId,
    payloadHash,
    state: outcome,
    result: report,
    records,
    eventId: randomUUID(),
    completedAt,
  });
  return report;
}

function recordedTargetsFromRequest(request: Readonly<Record<string, unknown>>): readonly RecordedTarget[] {
  const raw = request['targets'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const kind = record['kind'];
    if (kind !== 'TASK_WORKTREE' && kind !== 'VERIFICATION_COPY'
      && kind !== 'INTEGRATION_WORKTREE' && kind !== 'UNREGISTERED_DIRECTORY') return [];
    return [{
      kind,
      source: record['source'] === 'UNREGISTERED_DIRECTORY'
        ? 'UNREGISTERED_DIRECTORY' as const : 'REGISTERED' as const,
      projectId: String(record['projectId'] ?? ''),
      // An unregistered directory that cannot be attributed to a Task records no Task; an empty
      // string from an older record is read back as "no Task" the same way.
      taskId: typeof record['taskId'] === 'string' && record['taskId'].length > 0
        ? record['taskId'] : null,
      resourceId: String(record['resourceId'] ?? ''),
      path: String(record['path'] ?? ''),
      ownershipToken: typeof record['ownershipToken'] === 'string' ? record['ownershipToken'] : null,
      externalRef: typeof record['externalRef'] === 'string' ? record['externalRef'] : null,
      resourceState: String(record['resourceState'] ?? ''),
      repositoryRoot: String(record['repositoryRoot'] ?? ''),
      action: 'RECLAIM' as ReclaimAction,
    }];
  });
}

/**
 * Reconciles a reclamation the Runtime was killed in the middle of. It never deletes anything:
 * for every recorded target it inspects the actual state, records what it finds, releases a
 * workspace whose directory is already gone, and leaves the rest for the next explicit run.
 */
export async function reconcileInterruptedReclamations(input: {
  readonly storage: Phase1Database;
  readonly runtimeHome: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<readonly ReclamationReconcileResult[]> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const results: ReclamationReconcileResult[] = [];
  for (const operation of input.storage.listIncompleteReclamationOperations()) {
    const targets = recordedTargetsFromRequest(operation.request);
    const payloadHash = typeof operation.request['payloadHash'] === 'string'
      ? operation.request['payloadHash'] as string
      : sha256(JSON.stringify({ operationId: operation.operationId }));
    const completedAt = now();
    if (operation.operationState === 'PLANNED' || targets.length === 0) {
      const report = {
        projectId: operation.projectId,
        operationId: operation.operationId,
        outcome: 'FAILED',
        reconciled: 'NOT_STARTED',
        detail: 'The Runtime restarted before any reclamation side effect started; re-run reclaim apply',
      };
      input.storage.finishReclamationOperation({
        operationId: operation.operationId,
        projectId: operation.projectId,
        commandId: operation.commandId,
        payloadHash,
        state: 'FAILED',
        result: report,
        records: [],
        eventId: randomUUID(),
        completedAt,
      });
      results.push({ operationId: operation.operationId, projectId: operation.projectId,
        outcome: 'NOT_STARTED', reclaimed: 0, remaining: 0 });
      continue;
    }
    const records: ReclamationRecordInput[] = [];
    let remaining = 0;
    let reclaimed = 0;
    for (const target of targets) {
      const unregistered = target.kind === 'UNREGISTERED_DIRECTORY';
      // An unregistered directory has no repository registration to ask about: only its own
      // presence on disk is a fact the reconcile may use, and it never deletes anything.
      const registration = unregistered
        ? { registered: false, registeredPath: null, pathExists: existsSync(target.path),
          headCommit: null, branchRef: null, detached: true }
        : await inspectOwnedWorktreeRegistration({
          repositoryRoot: target.repositoryRoot,
          path: target.path,
        });
      const gone = !registration.registered && !registration.pathExists;
      const evidence: Record<string, unknown> = {
        reconciled: true,
        unregistered,
        registered: registration.registered,
        registeredPath: registration.registeredPath,
        pathExists: registration.pathExists,
        headCommit: registration.headCommit,
        branchRef: registration.branchRef,
      };
      const asTarget: ReclaimTarget = {
        kind: unregistered ? 'TASK_WORKTREE' : target.kind,
        projectId: target.projectId,
        taskId: target.taskId ?? '',
        taskDisplayNumber: 0,
        resourceId: target.resourceId,
        resourceState: target.resourceState,
        path: target.path,
        ownershipToken: target.ownershipToken,
        externalRef: target.externalRef,
        action: 'RECLAIM',
        reasonCode: 'RECONCILED',
        detail: '',
        evidence,
      };
      const recordOf = (outcome: ReclamationOutcome, reasonCode: string, detail: string) =>
        unregistered
          ? unregisteredRecordInput({
            source: 'UNREGISTERED_DIRECTORY', kind: 'UNREGISTERED_DIRECTORY',
            layoutKind: 'TASK_WORKTREE', runtimeHome: input.runtimeHome, path: target.path,
            projectId: target.projectId, projectName: null, taskId: target.taskId,
            taskDisplayNumber: null, resourceId: target.resourceId,
            resourceState: 'UNREGISTERED', action: 'RECLAIM', reasonCode: 'RECONCILED',
            detail: '', selected: true, evidence,
          }, randomUUID(), outcome, reasonCode, detail, evidence)
          : recordInput(asTarget, randomUUID(), outcome, reasonCode, detail, evidence);
      if (!gone) {
        remaining += 1;
        records.push(recordOf('RETAINED', 'INTERRUPTED_UNFINISHED',
          'The Runtime restarted before this resource was reclaimed; re-run reclaim apply'));
        continue;
      }
      let released = true;
      if (target.kind === 'TASK_WORKTREE' && target.taskId !== null) {
        try {
          input.storage.releaseWorkspaceForReclamation({
            projectId: target.projectId,
            taskId: target.taskId,
            workspaceId: target.resourceId,
            expectedPath: target.path,
            eventId: randomUUID(),
            reason: 'RECONCILED_INTERRUPTED',
            releasedAt: completedAt,
          });
        } catch {
          released = false;
        }
      }
      if (!released) {
        remaining += 1;
        records.push(recordOf('RETAINED', 'INTERRUPTED_UNFINISHED',
          'The resource is gone but its workspace row could not be released'));
        continue;
      }
      reclaimed += 1;
      records.push(recordOf('RECLAIMED', 'RECONCILED_INTERRUPTED',
        'The resource is gone; the interrupted reclamation was reconciled from the actual state'));
    }
    const state = remaining === 0 ? 'SUCCEEDED' as const : 'FAILED' as const;
    const report = {
      projectId: operation.projectId,
      operationId: operation.operationId,
      outcome: state,
      reconciled: true,
      reclaimed,
      remaining,
    };
    input.storage.finishReclamationOperation({
      operationId: operation.operationId,
      projectId: operation.projectId,
      commandId: operation.commandId,
      payloadHash,
      state,
      result: report,
      records,
      eventId: randomUUID(),
      completedAt,
    });
    results.push({ operationId: operation.operationId, projectId: operation.projectId,
      outcome: state === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED', reclaimed, remaining });
  }
  return results;
}

export interface ReclaimRecordsInput {
  readonly storage: Phase1Database;
  readonly projectId?: string;
  readonly projectIds?: readonly string[];
  readonly taskId?: string;
  readonly limit?: number;
  /** `ALL` (default) reads both sources; the others narrow the ledger to one of them. */
  readonly source?: 'ALL' | ReclamationSource;
  readonly since?: number;
  readonly until?: number;
}

/**
 * Reads the append-only ledger back. A single project is read directly; a batch merges the newest
 * `limit` rows of every trusted project, which is exact: the globally newest `limit` rows can never
 * include a row that is not among its own project's newest `limit` rows. The rows themselves are
 * returned unchanged (each carries its project, task, source and timestamp), so the shape of
 * `reclaim records --json` stays an array.
 */
export function listReclamationRecords(input: ReclaimRecordsInput): readonly ReclamationRecord[] {
  const projectIds = input.projectIds !== undefined
    ? [...input.projectIds]
    : input.projectId !== undefined ? [input.projectId] : [];
  if (projectIds.length === 0) {
    throw new ReclaimServiceError('PROJECT_SCOPE_REQUIRED',
      'Give --project <project-id> or --all-projects to choose whose ledger to read');
  }
  const limit = input.limit ?? 100;
  const options = {
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    limit,
    ...(input.source === undefined || input.source === 'ALL' ? {} : { source: input.source }),
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.until === undefined ? {} : { until: input.until }),
  };
  try {
    // The ledger is project data like every other query: an unknown or untrusted project is
    // reported as such instead of looking like an empty history.
    for (const projectId of projectIds) input.storage.getTrustedProject(projectId);
    return projectIds
      .flatMap((projectId) => input.storage.listReclamationRecords(projectId, options))
      .sort((left, right) => right.createdAt - left.createdAt
        || right.operationId.localeCompare(left.operationId)
        || right.id.localeCompare(left.id))
      .slice(0, limit);
  } catch (error) {
    if (error instanceof StorageError) throw new ReclaimServiceError(error.code, error.message);
    throw error;
  }
}

// -----------------------------------------------------------------------------------------------
// Batch reclamation across every trusted project (ADR-0037)
// -----------------------------------------------------------------------------------------------

function aggregateCounts(counts: readonly ReclaimCounts[]): ReclaimCounts {
  return {
    total: counts.reduce((sum, entry) => sum + entry.total, 0),
    reclaim: counts.reduce((sum, entry) => sum + entry.reclaim, 0),
    retain: counts.reduce((sum, entry) => sum + entry.retain, 0),
    refuse: counts.reduce((sum, entry) => sum + entry.refuse, 0),
    alreadyAbsent: counts.reduce((sum, entry) => sum + entry.alreadyAbsent, 0),
    recoveryRequired: counts.reduce((sum, entry) => sum + entry.recoveryRequired, 0),
  };
}

function aggregateOutcomeCounts(counts: readonly ReclaimOutcomeCounts[]): ReclaimOutcomeCounts {
  return {
    reclaimed: counts.reduce((sum, entry) => sum + entry.reclaimed, 0),
    alreadyAbsent: counts.reduce((sum, entry) => sum + entry.alreadyAbsent, 0),
    retained: counts.reduce((sum, entry) => sum + entry.retained, 0),
    refused: counts.reduce((sum, entry) => sum + entry.refused, 0),
    failed: counts.reduce((sum, entry) => sum + entry.failed, 0),
    recoveryRequired: counts.reduce((sum, entry) => sum + entry.recoveryRequired, 0),
  };
}

function trustedProjectIds(input: {
  readonly storage: Phase1Database;
  readonly projectIds?: readonly string[] | undefined;
}): readonly string[] {
  if (input.projectIds === undefined) {
    return input.storage.listTrustedProjects().map((project) => project.id);
  }
  for (const projectId of input.projectIds) input.storage.getTrustedProject(projectId);
  return [...input.projectIds];
}

/**
 * A per-project command ID derived from the batch command. The derivation is deterministic, so a
 * replayed batch command finds each project's recorded receipt instead of acting twice — while each
 * project still owns an independent operation, an independent outcome, and its own ledger rows.
 */
function projectCommandId(commandId: string, projectId: string): string {
  const digest = sha256(`${commandId}:${projectId}`);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}`
    + `-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function finalizeBatchPlan(input: {
  readonly projects: readonly ReclaimPlan[];
  readonly projectIds: readonly string[];
  readonly includeFailureScenes: boolean;
  readonly kinds: readonly ReclaimKind[];
  readonly taskId: string | null;
  readonly unregistered: ReclaimBatchUnregisteredView | null;
  /** True when at least one project group could not even be planned. */
  readonly failed?: boolean;
}): ReclaimBatchPlan {
  return {
    scope: 'ALL_PROJECTS',
    projectIds: input.projectIds,
    projects: input.projects,
    counts: aggregateCounts(input.projects.map((project) => project.counts)),
    unregistered: input.unregistered,
    includeFailureScenes: input.includeFailureScenes,
    kinds: input.kinds,
    taskId: input.taskId,
    ...(input.failed === true ? { outcome: 'FAILED' as const } : {}),
  };
}

function batchUnregisteredView(input: {
  readonly scan: UnregisteredScanResult | null;
}): ReclaimBatchUnregisteredView | null {
  const scan = input.scan;
  if (scan === null) return null;
  return {
    scan: scan.output.scan,
    unattributed: scan.candidates.filter((candidate) => candidate.projectId === null
      || !scan.trustedProjectIds.has(candidate.projectId)),
  };
}

/**
 * Plans a reclamation over every selected project. The unregistered scan happens once and each
 * attributable candidate is grouped into its own project's plan, so a script can read a batch as
 * "what would happen, per project" without a second query.
 */
export async function planReclamationBatch(input: ReclaimBatchInput): Promise<ReclaimBatchPlan> {
  const kinds = input.kinds === undefined ? reclaimKinds : [...new Set(input.kinds)];
  const includeFailureScenes = input.includeFailureScenes ?? false;
  const projectIds = trustedProjectIds(input);
  const scan = input.unregistered === true
    ? input.unregisteredScan ?? await scanUnregisteredDirectories({
      storage: input.storage,
      runtimeHome: input.runtimeHome,
      scanRoot: input.scanRoot,
      includeFailureScenes,
      removeUnregistered: input.removeUnregistered,
    })
    : null;
  const projects: ReclaimPlan[] = [];
  for (const projectId of projectIds) {
    // Each project is planned on its own. A project that cannot be planned at all is reported as a
    // failure of its own group instead of aborting the batch, which is what "one refusal must not
    // silently skip the others" means for a read-only preview.
    try {
      const plan = await buildPlan({
        ...input,
        projectId,
        kinds,
        includeFailureScenes,
        ...(scan === null ? {} : { unregisteredScan: scan }),
      });
      projects.push(plan.plan);
    } catch (error) {
      // A project that cannot be planned at all is a *reported* group, never an omitted one: a batch
      // must not be able to hide a project by failing on it, and one project's error must not stop
      // the others. The batch outcome becomes FAILED so a script still sees that something is wrong.
      projects.push({
        scope: 'PROJECT',
        projectId,
        projectName: projectId,
        taskId: input.taskId ?? null,
        includeFailureScenes,
        kinds,
        devCommit: null,
        targets: [],
        counts: { total: 0, reclaim: 0, retain: 0, refuse: 0, alreadyAbsent: 0,
          recoveryRequired: 0 },
        unregistered: null,
        projectError: { code: errorCodeOf(error), message: errorMessageOf(error) },
      });
    }
  }
  return finalizeBatchPlan({
    projects,
    projectIds,
    includeFailureScenes,
    kinds,
    taskId: input.taskId ?? null,
    unregistered: batchUnregisteredView({ scan }),
    ...(projects.some((project) => project.projectError != null) ? { failed: true } : {}),
  });
}

/**
 * Executes a batch reclamation. Every project is applied independently, in its own operation, with a
 * deterministic command ID derived from the batch command: a project that refuses, fails, or cannot
 * be read leaves the other projects' decisions untouched, and the aggregate report says exactly how
 * many resources of each kind were reclaimed, retained, refused, or left unverifiable.
 */
export async function applyReclamationBatch(
  input: ReclaimBatchApplyInput,
): Promise<ReclaimBatchReport> {
  const kinds = input.kinds === undefined ? reclaimKinds : [...new Set(input.kinds)];
  const includeFailureScenes = input.includeFailureScenes ?? false;
  const projectIds = trustedProjectIds(input);
  const scan = input.unregistered === true
    ? input.unregisteredScan ?? await scanUnregisteredDirectories({
      storage: input.storage,
      runtimeHome: input.runtimeHome,
      scanRoot: input.scanRoot,
      includeFailureScenes,
      removeUnregistered: input.removeUnregistered,
    })
    : null;
  const reports: ReclaimReport[] = [];
  const operations: ReclaimBatchOperationSummary[] = [];
  const failures: { projectId: string; code: string; message: string }[] = [];
  for (const projectId of projectIds) {
    try {
      const report = await applyReclamation({
        ...input,
        projectId,
        commandId: projectCommandId(input.commandId, projectId),
        kinds,
        includeFailureScenes,
        ...(scan === null ? {} : { unregisteredScan: scan }),
      });
      reports.push(report);
      operations.push({ projectId, operationId: report.operationId, outcome: report.outcome,
        alreadyCompleted: report.alreadyCompleted, created: report.created });
    } catch (error) {
      // Every project is attempted, and every failure is reported with the project that produced it:
      // "how much was really done, how much was skipped, and why" has to be answerable from the
      // result. The other projects' operations are already committed independently, so nothing is
      // rolled back into a false "nothing happened" either.
      failures.push({ projectId, code: errorCodeOf(error), message: errorMessageOf(error) });
    }
  }
  const outcomeCounts = aggregateOutcomeCounts(reports.map((report) => report.outcomeCounts));
  return {
    ...finalizeBatchPlan({
      projects: reports,
      projectIds,
      includeFailureScenes,
      kinds,
      taskId: input.taskId ?? null,
      unregistered: batchUnregisteredView({ scan }),
    }),
    outcome: failures.length > 0 || outcomeCounts.failed > 0 ? 'FAILED' : 'SUCCEEDED',
    outcomeCounts,
    operations,
    // The per-project failures are part of the result, not a thrown exception: an honest batch says
    // which groups it could not even start.
    failures,
    alreadyCompleted: reports.length > 0 && reports.every((report) => report.alreadyCompleted),
    created: reports.some((report) => report.created),
  };
}
