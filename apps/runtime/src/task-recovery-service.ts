import { existsSync } from 'node:fs';
import {
  inspectProviderProcessOwnership,
  type ProviderOwnershipObservation,
  type ProviderProcessTree,
} from '@codeestra/agent-adapters';
import type { TaskRecoveryView } from '@codeestra/contracts';
import { Phase1Database, StorageError, type TaskRecoverySubject } from '@codeestra/storage';

/**
 * `task.recover` (FOUNDATION-086 / ADR-0055): the step `docs/architecture/state-machines.md` promises
 * for `RECOVERY_REQUIRED` — "reconcile: return to a proven state from real facts; must be audited,
 * must not simply release resources".
 *
 * Until this command existed that promise had no command face at all: `task cancel` / `task retry` /
 * `task resume` refuse a `RECOVERY_REQUIRED` Task (`RECONCILE_REQUIRED`), `reclaim` refuses it as
 * active, `scheduler reservations reconcile` only looks at reservation rows, and the startup
 * convergence query excludes `DISCONNECTED` / `RECOVERY_REQUIRED` outright. A run whose provider was
 * provably gone therefore kept its resource held forever, which kept the conflict analyzer from ever
 * observing it — `MISSING_IMPACT_SNAPSHOT` for every candidate, `UNKNOWN` for every assessment, and
 * every new Task of the project waiting behind a Task that could not change.
 *
 * What this service does, in order: it *reads* the recorded provider identity and the recorded
 * descendant snapshot, checks them against the real process table, and looks at whether the recorded
 * workspace path is still on disk. Only one combination may change anything: the provider is provably
 * gone. Everything else is a refusal that keeps every resource where it is.
 *
 * What it refuses to claim, deliberately:
 *
 *  - it never signals a process, never deletes or moves a worktree, and never deletes a Task branch
 *    (`signalsSent: 0` is part of the record, not a remark);
 *  - it never claims workspace quiescence. When the record kept no descendant snapshot, orphaned tool
 *    children cannot be attributed at all, so `descendantRecord: 'MISSING'` and
 *    `quiescenceProven: false` are recorded as facts. The converge target is `FAILED`: it resumes no
 *    conversation, integrates nothing and reuses no worktree, so it does not need the stronger fact —
 *    the paths that do need it (`task retry` reusing/rebuilding a worktree, `reclaim` removing a
 *    directory) keep their own ownership checks.
 */
export class TaskRecoveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TaskRecoveryError';
  }
}

/** The process-table observation, named so the refusal codes and the stored fact cannot drift. */
export type RecoveryProcessState = 'STOPPED' | 'ALIVE' | 'DESCENDANTS_ALIVE' | 'UNVERIFIABLE'
  | 'IDENTITY_MISSING';

export type RecoveryRefusalCode = 'RECOVERY_PROVIDER_ALIVE' | 'RECOVERY_DESCENDANTS_ALIVE'
  | 'RECOVERY_OWNERSHIP_UNVERIFIABLE' | 'RECOVERY_PROCESS_IDENTITY_MISSING';

const processStateOf = (observation: ProviderOwnershipObservation): RecoveryProcessState => {
  switch (observation.state) {
    case 'STOPPED': return 'STOPPED';
    case 'ALIVE': return 'ALIVE';
    case 'DESCENDANTS_ALIVE': return 'DESCENDANTS_ALIVE';
    default: return 'UNVERIFIABLE';
  }
};

/** The stable refusal code for an observation that must not converge anything. */
const refusalCodeOf = (state: RecoveryProcessState): RecoveryRefusalCode => {
  switch (state) {
    case 'ALIVE': return 'RECOVERY_PROVIDER_ALIVE';
    case 'DESCENDANTS_ALIVE': return 'RECOVERY_DESCENDANTS_ALIVE';
    case 'IDENTITY_MISSING': return 'RECOVERY_PROCESS_IDENTITY_MISSING';
    default: return 'RECOVERY_OWNERSHIP_UNVERIFIABLE';
  }
};

export interface RecoveryObservation {
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly workspaceId: string | null;
  readonly workspacePath: string | null;
  readonly providerPid: number | null;
  readonly processState: RecoveryProcessState;
  readonly descendantRecord: 'RECORDED' | 'MISSING';
  readonly descendantCount: number;
  readonly workspacePresent: boolean;
  readonly quiescenceProven: boolean;
  readonly signalsSent: number;
  readonly evidenceRef: string;
}

/** A recorded provider identity, read defensively: a malformed value is `missing`, never guessed. */
function recordedIdentity(value: unknown): { readonly pid: number; readonly startToken: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { readonly pid?: unknown; readonly startToken?: unknown };
  if (typeof candidate.pid !== 'number' || !Number.isSafeInteger(candidate.pid)
    || candidate.pid <= 0) return null;
  if (typeof candidate.startToken !== 'string' || candidate.startToken.length === 0) return null;
  return { pid: candidate.pid, startToken: candidate.startToken };
}

/**
 * The descendant snapshot recorded while the provider was alive, or `null` when none was kept.
 *
 * `null` is not "no descendants": it is "descendants were never enumerated", which is why the caller
 * records `descendantRecord: 'MISSING'` and refuses to claim quiescence. Only a snapshot shaped like
 * the Adapter's own `ProviderProcessTree` is used; anything else is treated as absent rather than
 * interpreted.
 */
function recordedTree(value: unknown): ProviderProcessTree | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as {
    readonly pid?: unknown; readonly startToken?: unknown; readonly descendants?: unknown;
  };
  if (typeof candidate.pid !== 'number' || typeof candidate.startToken !== 'string') return null;
  const descendants = Array.isArray(candidate.descendants) ? candidate.descendants : null;
  if (descendants === null) return null;
  const refs = descendants.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as { readonly pid?: unknown; readonly startToken?: unknown; readonly command?: unknown };
    if (typeof row.pid !== 'number') return [];
    return [{
      pid: row.pid,
      startToken: typeof row.startToken === 'string' ? row.startToken : null,
      command: typeof row.command === 'string' ? row.command : '',
    }];
  });
  return {
    pid: candidate.pid,
    startToken: candidate.startToken,
    pgid: null,
    descendants: refs,
    capturedAt: 0,
    note: 'recorded descendant snapshot',
  };
}

/**
 * Observes one `RECOVERY_REQUIRED` Task from real facts only. Pure with respect to the database and
 * the filesystem: it reads the process table (through the Adapter's ownership inspector, so the
 * PID-reuse rule lives in one place) and checks whether the recorded workspace path still exists.
 */
export async function observeTaskRecovery(input: {
  readonly subject: TaskRecoverySubject;
  readonly inspectOwnership?: (tree: ProviderProcessTree) => Promise<ProviderOwnershipObservation>;
  readonly pathExists?: (path: string) => boolean;
}): Promise<RecoveryObservation> {
  const { subject } = input;
  const pathExists = input.pathExists ?? existsSync;
  const workspacePresent = pathExists(subject.workspacePath);
  const tree = recordedTree(subject.incarnationProcessTree);
  const identity = recordedIdentity(subject.incarnationProcessIdentity)
    ?? recordedIdentity(subject.sessionProcessIdentity);
  const descendantCount = tree?.descendants.length ?? 0;
  const descendantRecord: 'RECORDED' | 'MISSING' = tree === null ? 'MISSING' : 'RECORDED';

  let processState: RecoveryProcessState;
  let providerPid: number | null = identity?.pid ?? null;
  if (identity === null) {
    processState = 'IDENTITY_MISSING';
  } else {
    // With no descendant snapshot the walk has nothing to check beyond the provider itself; the
    // observation still refuses to call that quiescence (see `descendantRecord`).
    const inspected = tree ?? {
      pid: identity.pid,
      startToken: identity.startToken,
      pgid: null,
      descendants: [],
      capturedAt: 0,
      note: 'synthesized from the recorded provider identity; no descendant snapshot was kept',
    };
    const inspector = input.inspectOwnership
      ?? ((value: ProviderProcessTree) => inspectProviderProcessOwnership({ tree: value }));
    const observation = await inspector(inspected);
    processState = processStateOf(observation);
    providerPid = observation.state === 'ALIVE' ? observation.pid : identity.pid;
  }
  const evidenceRef = `task-recover:${processState}:pid=${providerPid ?? 'unknown'}`
    + `:descendants=${descendantRecord}:workspace=${workspacePresent ? 'present' : 'missing'}`;
  return {
    executionId: subject.executionId,
    sessionId: subject.sessionId,
    workspaceId: subject.workspaceId,
    workspacePath: subject.workspacePath,
    providerPid,
    processState,
    descendantRecord,
    descendantCount,
    workspacePresent,
    // Never true: a descendant snapshot the record never captured cannot be excluded, and the
    // Runtime was not the process that observed the exit.
    quiescenceProven: false,
    signalsSent: 0,
    evidenceRef,
  };
}

/**
 * The one sentence a first reconcile and its replay both report, so a replayed command answers with
 * the same facts instead of a subtly different paraphrase.
 */
function reconciledDetail(): string {
  return 'the run was reconciled from facts: Execution and Task are FAILED, the workspace is'
    + ' retained, nothing was signalled and no worktree was removed (quiescence was not proven)';
}

/** What a refusal says, in the words the command face prints. Nothing about it is a state change. */
function refusalDetail(observation: RecoveryObservation): string {
  switch (observation.processState) {
    case 'ALIVE':
      return `provider process ${observation.providerPid ?? 'unknown'} is still running with the`
        + ' recorded start token; this Runtime does not own a handle to it and did not signal it, so'
        + ' the resource stays occupied. Stop that process yourself and run the command again';
    case 'DESCENDANTS_ALIVE':
      return 'the provider is gone but recorded tool descendant(s) are still running; they may still'
        + ' write the workspace, so the resource stays occupied and nothing was signalled';
    case 'IDENTITY_MISSING':
      return 'no usable provider process identity was recorded for this run (neither on the Session'
        + ' nor on an incarnation), so ownership cannot be checked and quiescence is not proven';
    default:
      return 'provider ownership could not be verified (the process table could not be read, the'
        + ' start token could not be read, or the recorded identity could not be compared), so the'
        + ' resource stays occupied';
  }
}

/**
 * Reconciles one `RECOVERY_REQUIRED` Task.
 *
 * Returns a view for every outcome a caller can branch on: `RECONCILED` (rows changed),
 * `ALREADY_RECONCILED` (the Task already left the state and its Execution is terminal — read-only)
 * and `REFUSED` (nothing changed). Only a genuinely inapplicable request throws.
 */
export async function recoverTask(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly commandId: string;
  readonly reason?: string | undefined;
  readonly actor: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly inspectOwnership?: (tree: ProviderProcessTree) => Promise<ProviderOwnershipObservation>;
  readonly pathExists?: (path: string) => boolean;
  readonly payloadHash: string;
}): Promise<TaskRecoveryView> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const subject = input.storage.getTaskRecoverySubject(input.projectId, input.taskId);
  if (subject === null) {
    throw new TaskRecoveryError('NOT_FOUND', 'Task was not found in this project');
  }
  // A replayed command reaches its own record before any state is judged — including the version,
  // which the first attempt itself changed. Same command id with a different payload stays a
  // conflict, exactly like `executeCommand` decides it.
  const replayed = input.storage.findTaskRecoveryOutcomeByCommand(input.projectId, input.commandId);
  if (replayed !== null) {
    if (replayed.payloadHash !== input.payloadHash) {
      throw new TaskRecoveryError('COMMAND_CONFLICT',
        'This command id was already used for a different recovery reconcile');
    }
    const observation = await observeTaskRecovery({
      subject,
      ...(input.inspectOwnership === undefined ? {} : { inspectOwnership: input.inspectOwnership }),
      ...(input.pathExists === undefined ? {} : { pathExists: input.pathExists }),
    });
    return {
      taskId: subject.taskId,
      displayNumber: subject.displayNumber,
      outcome: 'RECONCILED',
      code: null,
      detail: reconciledDetail(),
      observation,
      taskState: replayed.outcome.taskState,
      taskVersion: replayed.outcome.taskVersion,
      executionState: 'FAILED',
      reason: input.reason ?? null,
    };
  }
  // The version is compared before the state, exactly like `submit`/`pause`/`retry`: a caller whose
  // view is stale is told to re-read it instead of being handed a verdict about a State it never saw.
  if (subject.taskVersion !== input.expectedVersion) {
    throw new StorageError('CONCURRENT_MODIFICATION',
      `Task version is ${subject.taskVersion}, not the expected ${input.expectedVersion}`);
  }
  const reason = input.reason ?? null;
  if (subject.taskState !== 'RECOVERY_REQUIRED') {
    const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'SUPERSEDED']
      .includes(subject.executionState);
    if (!terminal) {
      throw new TaskRecoveryError('TASK_NOT_IN_RECOVERY',
        `Task is ${subject.taskState} and its Execution is ${subject.executionState}, so there is`
        + ' nothing for a reconcile to decide');
    }
    // Read-only: the reconcile this command performs already happened (by this command or by the
    // Runtime), and saying so is more useful than a second set of state events.
    return {
      taskId: subject.taskId,
      displayNumber: subject.displayNumber,
      outcome: 'ALREADY_RECONCILED',
      code: null,
      detail: `Task is ${subject.taskState} and its Execution is ${subject.executionState}; no`
        + ' reconcile was needed',
      observation: {
        executionId: subject.executionId,
        sessionId: subject.sessionId,
        workspaceId: subject.workspaceId,
        workspacePath: subject.workspacePath,
        providerPid: null,
        processState: 'STOPPED',
        descendantRecord: subject.incarnationProcessTree === null ? 'MISSING' : 'RECORDED',
        descendantCount: 0,
        workspacePresent: (input.pathExists ?? existsSync)(subject.workspacePath),
        quiescenceProven: false,
        signalsSent: 0,
        evidenceRef: 'task-recover:already-reconciled',
      },
      taskState: subject.taskState,
      taskVersion: subject.taskVersion,
      executionState: subject.executionState,
      reason,
    };
  }
  const observation = await observeTaskRecovery({
    subject,
    ...(input.inspectOwnership === undefined ? {} : { inspectOwnership: input.inspectOwnership }),
    ...(input.pathExists === undefined ? {} : { pathExists: input.pathExists }),
  });
  if (observation.processState !== 'STOPPED') {
    return {
      taskId: subject.taskId,
      displayNumber: subject.displayNumber,
      outcome: 'REFUSED',
      code: refusalCodeOf(observation.processState),
      detail: refusalDetail(observation),
      observation,
      taskState: subject.taskState,
      taskVersion: subject.taskVersion,
      executionState: subject.executionState,
      reason,
    };
  }
  const evidence = {
    providerPid: observation.providerPid,
    processState: observation.processState,
    descendantRecord: observation.descendantRecord,
    descendantCount: observation.descendantCount,
    workspacePresent: observation.workspacePresent,
    quiescenceProven: observation.quiescenceProven,
    signalsSent: observation.signalsSent,
    evidenceRef: observation.evidenceRef,
  };
  const outcome = input.storage.convergeRecoveredTask({
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: input.expectedVersion,
    commandId: input.commandId,
    payloadHash: input.payloadHash,
    reason,
    actor: input.actor,
    detail: `provider ${observation.providerPid ?? 'unknown'} is gone`
      + ` (descendant record: ${observation.descendantRecord}, workspace`
      + ` ${observation.workspacePresent ? 'present' : 'missing'}); the run is closed as FAILED and`
      + ' the workspace is retained',
    evidence,
    providerPid: observation.providerPid,
    executionEventId: randomUUID(),
    sessionEventId: randomUUID(),
    taskEventId: randomUUID(),
    recoveryEventId: randomUUID(),
    recordedAt: now(),
  });
  return {
    taskId: subject.taskId,
    displayNumber: subject.displayNumber,
    outcome: 'RECONCILED',
    code: null,
    detail: reconciledDetail(),
    observation,
    taskState: outcome.taskState,
    taskVersion: outcome.taskVersion,
    executionState: 'FAILED',
    reason,
  };
}
