import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  parseVerificationPolicy,
  verificationPolicyDigest,
  verificationPolicyLabel,
  verificationPolicyPath,
  verificationPolicyVersion,
  type VerificationPolicyInspection,
} from '@codeestra/contracts';
import {
  createVerificationCopy,
  inspectVerificationCopy,
  readCommitTree,
  readRefFile,
  removeVerificationCopy,
} from '@codeestra/git';
import {
  Phase1Database,
  StorageError,
  type StoredVerificationCommand,
  type VerificationEvidence,
  type VerificationRunPlan,
} from '@codeestra/storage';

/** Bounded transient output kept for the caller's terminal; never persisted. */
const maxOutputTailChars = 8_000;
const stopGraceMs = 2_000;

export class VerificationServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'VerificationServiceError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Reads the verification policy from the project's configured main ref. */
export async function inspectVerificationPolicy(input: {
  readonly repositoryRoot: string;
  readonly mainRef: string;
}): Promise<VerificationPolicyInspection> {
  const read = await readRefFile({
    repositoryRoot: input.repositoryRoot,
    ref: input.mainRef,
    path: verificationPolicyPath,
  });
  if (read.text === null) {
    return { state: 'ABSENT', mainRef: input.mainRef, mainCommit: read.commit };
  }
  const policy = parseVerificationPolicy(read.text);
  const digest = verificationPolicyDigest(policy);
  return {
    state: 'PRESENT',
    mainRef: input.mainRef,
    mainCommit: read.commit,
    digest,
    label: verificationPolicyLabel(digest),
    policy,
  };
}

export interface VerificationCommandOutcome {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutDigest: string;
  readonly stderrDigest: string;
  /** Transient tail for the caller's terminal; empty when the run was replayed. */
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly failureDetail?: string;
}

export interface VerificationTreeEvidence {
  readonly headCommit: string;
  readonly trackedModifications: readonly string[];
  readonly untrackedFiles: readonly string[];
  readonly clean: boolean;
}

export interface VerificationReport {
  readonly verificationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly revisionId: string;
  readonly testedCommit: string;
  readonly testedTree: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly policyLabel: string;
  readonly mainCommit: string;
  readonly state: VerificationRunPlan['state'];
  readonly outcomeCode: string | null;
  readonly commands: readonly VerificationCommandOutcome[];
  readonly tree: VerificationTreeEvidence | null;
  readonly copyPath: string;
  readonly copyRemoved: boolean | null;
  readonly copyDetail: string | null;
  readonly staleEvidenceInvalidated: number;
  readonly alreadyCompleted: boolean;
  readonly evidence: VerificationEvidence | null;
}

/** Tracks verification children so shutdown can stop the process group it started. */
export class VerificationRunner {
  readonly #active = new Map<string, Bun.Subprocess<'ignore', 'pipe', 'pipe'>>();
  readonly #unconfirmed: string[] = [];

  get activeVerificationIds(): readonly string[] {
    return [...this.#active.keys()];
  }

  get unconfirmedStops(): readonly string[] {
    return [...this.#unconfirmed];
  }

  register(verificationId: string, child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): void {
    this.#active.set(verificationId, child);
  }

  unregister(verificationId: string): void {
    this.#active.delete(verificationId);
  }

  /** Stops every owned child group; a child that ignores SIGKILL is reported, not assumed gone. */
  async close(): Promise<readonly string[]> {
    const stopped: string[] = [];
    for (const [verificationId, child] of this.#active) {
      const exited = await killProcessGroup(child, stopGraceMs);
      if (exited) {
        this.#active.delete(verificationId);
        stopped.push(verificationId);
      } else {
        this.#unconfirmed.push(verificationId);
      }
    }
    return stopped;
  }
}

async function killProcessGroup(
  child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
  graceMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) return true;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch { /* The process may already be gone. */ }
    }
    const done = await Promise.race([
      child.exited.then(() => true, () => true),
      Bun.sleep(graceMs).then(() => false),
    ]);
    if (done) return true;
  }
  return false;
}

function boundedTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= maxOutputTailChars ? next : next.slice(next.length - maxOutputTailChars);
}

interface StreamCapture {
  readonly bytes: number;
  readonly digest: string;
  readonly tail: string;
  readonly drained: boolean;
}

/** A killed process group normally closes its pipes promptly; a stalled reader is bounded. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, Bun.sleep(ms).then(() => null)]);
}

async function captureStream(
  stream: ReadableStream<Uint8Array>,
): Promise<StreamCapture> {
  const digest = createHash('sha256');
  let bytes = 0;
  let tail = '';
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    digest.update(chunk);
    bytes += chunk.byteLength;
    tail = boundedTail(tail, decoder.decode(chunk, { stream: true }));
  }
  tail = boundedTail(tail, decoder.decode());
  return { bytes, digest: digest.digest('hex'), tail, drained: true };
}

/**
 * Runs one policy command in the verification copy. Commands are argv arrays spawned
 * directly, never through a shell, in their own process group so a timeout can stop the
 * whole tree instead of only the first process.
 */
async function runCommand(input: {
  readonly verificationId: string;
  readonly command: StoredVerificationCommand;
  readonly copyPath: string;
  readonly runner: VerificationRunner;
}): Promise<VerificationCommandOutcome> {
  const cwd = input.command.cwd === '.' ? input.copyPath : join(input.copyPath, input.command.cwd);
  const resolvedCwd = resolve(cwd);
  if (!resolvedCwd.startsWith(`${resolve(input.copyPath)}/`) && resolvedCwd !== resolve(input.copyPath)) {
    throw new VerificationServiceError('INVALID_VERIFICATION_POLICY',
      `Command ${input.command.id} cwd escapes the verification copy`);
  }
  const startedAt = Date.now();
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    child = Bun.spawn({
      cmd: [...input.command.argv],
      cwd: resolvedCwd,
      env: { ...Bun.env, CI: '1' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    });
  } catch (error) {
    return {
      id: input.command.id,
      argv: input.command.argv,
      cwd: input.command.cwd,
      timeoutSeconds: input.command.timeoutSeconds,
      exitCode: null,
      timedOut: false,
      durationMs: Date.now() - startedAt,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutDigest: sha256(''),
      stderrDigest: sha256(''),
      stdoutTail: '',
      stderrTail: '',
      failureDetail: error instanceof Error ? error.message : String(error),
    };
  }
  input.runner.register(input.verificationId, child);
  let exitCode: number | null = null;
  const exitPromise = child.exited.then(
    (code) => { exitCode = code; return code; },
    () => { exitCode = null; return null; },
  );
  const stdoutPromise = captureStream(child.stdout);
  const stderrPromise = captureStream(child.stderr);
  const timedOut = await Promise.race([
    exitPromise.then(() => false),
    Bun.sleep(input.command.timeoutSeconds * 1_000).then(() => true),
  ]);
  let stopped = true;
  if (timedOut) stopped = await killProcessGroup(child, stopGraceMs);
  // Wait for the real exit code unless the process survived even SIGKILL.
  await Promise.race([exitPromise, Bun.sleep(stopGraceMs).then(() => null)]);
  const drainDeadline = stopGraceMs + 5_000;
  const undrained = { bytes: 0, digest: sha256(''), tail: '', drained: false } as const;
  const stdout = await withDeadline(stdoutPromise, drainDeadline) ?? undrained;
  const stderr = await withDeadline(stderrPromise, drainDeadline) ?? undrained;
  input.runner.unregister(input.verificationId);
  const outcome: VerificationCommandOutcome = {
    id: input.command.id,
    argv: input.command.argv,
    cwd: input.command.cwd,
    timeoutSeconds: input.command.timeoutSeconds,
    exitCode,
    timedOut,
    durationMs: Date.now() - startedAt,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutDigest: stdout.digest,
    stderrDigest: stderr.digest,
    stdoutTail: stdout.tail,
    stderrTail: stderr.tail,
  };
  if (timedOut && !stopped) {
    return { ...outcome,
      failureDetail: 'the command group did not confirm its stop within the grace period' };
  }
  if (!stdout.drained || !stderr.drained) {
    return { ...outcome,
      failureDetail: 'command output could not be drained after the process stopped' };
  }
  return outcome;
}

function commandEvidence(outcome: VerificationCommandOutcome): Readonly<Record<string, unknown>> {
  return {
    id: outcome.id,
    argv: outcome.argv,
    cwd: outcome.cwd,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
    stdoutBytes: outcome.stdoutBytes,
    stderrBytes: outcome.stderrBytes,
    stdoutDigest: outcome.stdoutDigest,
    stderrDigest: outcome.stderrDigest,
    ...(outcome.failureDetail === undefined ? {} : { failureDetail: outcome.failureDetail }),
  };
}

interface SelectedExecution {
  readonly executionId: string;
  readonly revisionId: string;
  readonly testedCommit: string;
}

/** Chooses the Execution whose captured result commit is the current revision's evidence. */
function selectExecution(
  candidates: ReturnType<Phase1Database['getVerificationCandidates']>,
  executionId: string | undefined,
): SelectedExecution {
  if (executionId !== undefined) {
    const execution = candidates.executions.find((row) => row.executionId === executionId);
    if (execution === undefined) {
      throw new VerificationServiceError('EXECUTION_NOT_FOUND',
        'Execution was not found for this Task');
    }
    if (execution.appliedRevisionId !== candidates.currentRevisionId) {
      throw new VerificationServiceError('STALE_REVISION',
        'Task revision changed after this Execution started; verification needs the current revision');
    }
    if (execution.state !== 'SUCCEEDED' || execution.resultCommit === null) {
      throw new VerificationServiceError('NO_CAPTURED_RESULT',
        `Execution is ${execution.state} without a captured result commit; capture it before verifying`);
    }
    return {
      executionId: execution.executionId,
      revisionId: execution.appliedRevisionId,
      testedCommit: execution.resultCommit,
    };
  }
  const current = candidates.executions.find((row) =>
    row.appliedRevisionId === candidates.currentRevisionId
    && row.state === 'SUCCEEDED' && row.resultCommit !== null);
  if (current === undefined) {
    const anyCaptured = candidates.executions.some((row) => row.state === 'SUCCEEDED'
      && row.resultCommit !== null);
    if (anyCaptured) {
      throw new VerificationServiceError('STALE_REVISION',
        'A result commit exists for an older revision; verification needs the current revision');
    }
    throw new VerificationServiceError('NO_CAPTURED_RESULT',
      'No Execution captured a result commit for this Task; run and capture a result first');
  }
  return {
    executionId: current.executionId,
    revisionId: current.appliedRevisionId,
    testedCommit: current.resultCommit as string,
  };
}

function reportFromPlan(
  plan: VerificationRunPlan,
  input: {
    readonly commands: readonly VerificationCommandOutcome[];
    readonly tree: VerificationTreeEvidence | null;
    readonly copyRemoved: boolean | null;
    readonly copyDetail: string | null;
    readonly staleEvidenceInvalidated: number;
    readonly alreadyCompleted: boolean;
  },
): VerificationReport {
  return {
    verificationId: plan.verificationId,
    projectId: plan.projectId,
    taskId: plan.taskId,
    executionId: plan.executionId,
    revisionId: plan.revisionId,
    testedCommit: plan.testedCommit,
    testedTree: plan.testedTree,
    policyVersion: plan.policyVersion,
    policyDigest: plan.policyDigest,
    policyLabel: verificationPolicyLabel(plan.policyDigest),
    mainCommit: plan.mainCommit,
    state: plan.state,
    outcomeCode: plan.outcomeCode,
    commands: input.commands,
    tree: input.tree,
    copyPath: plan.copyPath,
    copyRemoved: input.copyRemoved,
    copyDetail: input.copyDetail,
    staleEvidenceInvalidated: input.staleEvidenceInvalidated,
    alreadyCompleted: input.alreadyCompleted,
    evidence: plan.evidence,
  };
}

/** Replay of a finished command shows the recorded commands without inventing output tails. */
function replayCommands(plan: VerificationRunPlan): readonly VerificationCommandOutcome[] {
  const evidence = plan.evidence;
  const recorded = evidence === null ? undefined : evidence['commands'];
  const rows = Array.isArray(recorded) ? recorded : [];
  return plan.commands.map((command, index) => {
    const row = (rows[index] ?? {}) as Record<string, unknown>;
    return {
      id: command.id,
      argv: command.argv,
      cwd: command.cwd,
      timeoutSeconds: command.timeoutSeconds,
      exitCode: typeof row['exitCode'] === 'number' ? row['exitCode'] : null,
      timedOut: row['timedOut'] === true,
      durationMs: typeof row['durationMs'] === 'number' ? row['durationMs'] : 0,
      stdoutBytes: typeof row['stdoutBytes'] === 'number' ? row['stdoutBytes'] : 0,
      stderrBytes: typeof row['stderrBytes'] === 'number' ? row['stderrBytes'] : 0,
      stdoutDigest: typeof row['stdoutDigest'] === 'string' ? row['stdoutDigest'] : sha256(''),
      stderrDigest: typeof row['stderrDigest'] === 'string' ? row['stderrDigest'] : sha256(''),
      stdoutTail: '',
      stderrTail: '',
      ...(typeof row['failureDetail'] === 'string' ? { failureDetail: row['failureDetail'] } : {}),
    };
  });
}

/**
 * Runs the confirmed verification policy against one frozen result commit in an isolated
 * detached copy of that commit. Nothing is staged, committed, or pushed, and the Task
 * worktree is never used, so verification cannot see uncommitted Agent edits.
 */
export async function runTaskVerification(input: {
  readonly storage: Phase1Database;
  readonly runner: VerificationRunner;
  readonly copiesRoot: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId?: string;
  readonly commandId: string;
  readonly permissionMode?: 'FULL' | 'STRICT';
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<VerificationReport> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const candidates = input.storage.getVerificationCandidates(input.projectId, input.taskId);
  if (candidates.taskState !== 'EXECUTED') {
    throw new VerificationServiceError('TASK_NOT_EXECUTED',
      `Task is ${candidates.taskState}; verification needs an EXECUTED Task with a captured result commit`);
  }
  const selected = selectExecution(candidates, input.executionId);
  const inspection = await inspectVerificationPolicy({
    repositoryRoot: candidates.repositoryRoot,
    mainRef: candidates.mainRef,
  });
  if (inspection.state === 'ABSENT') {
    throw new VerificationServiceError('VERIFICATION_POLICY_ABSENT',
      `No verification policy at ${candidates.mainRef}:${verificationPolicyPath}; add one and re-run project trust`);
  }
  const digest = inspection.digest as string;
  if ((input.permissionMode ?? 'STRICT') === 'STRICT') {
    const confirmation = input.storage.getConfirmedVerificationPolicy(input.projectId);
    if (confirmation === null || confirmation.state !== 'PRESENT') {
      throw new VerificationServiceError('VERIFICATION_POLICY_NOT_CONFIRMED',
        'This project has no confirmed verification policy; run project trust to confirm it');
    }
    if (confirmation.digest !== digest) {
      throw new VerificationServiceError('VERIFICATION_POLICY_NOT_CONFIRMED',
        `The verification policy changed (confirmed ${confirmation.digest?.slice(0, 12) ?? 'none'},`
        + ` now ${digest.slice(0, 12)}); run project trust to confirm the new policy`);
    }
  }
  const testedTree = await readCommitTree({
    repositoryRoot: candidates.repositoryRoot,
    commit: selected.testedCommit,
  });
  const verificationId = randomUUID();
  const operationId = randomUUID();
  const copyPath = join(resolve(input.copiesRoot), input.projectId, verificationId);
  const commands = inspection.policy?.commands ?? [];
  let begun;
  try {
    begun = input.storage.beginVerificationRun({
      projectId: input.projectId,
      taskId: input.taskId,
      executionId: selected.executionId,
      revisionId: selected.revisionId,
      testedCommit: selected.testedCommit,
      testedTree,
      policyVersion: verificationPolicyVersion,
      policyDigest: digest,
      mainCommit: inspection.mainCommit,
      commands,
      copyPath,
      verificationId,
      operationId,
      commandId: input.commandId,
      payloadHash: sha256(JSON.stringify({
        projectId: input.projectId, taskId: input.taskId, executionId: selected.executionId,
        testedCommit: selected.testedCommit, testedTree, policyDigest: digest,
      })),
      queuedAt: now(),
    });
  } catch (error) {
    if (error instanceof StorageError) {
      throw new VerificationServiceError(error.code, error.message);
    }
    throw error;
  }
  if (!begun.created) {
    return reportFromPlan(begun.plan, {
      commands: replayCommands(begun.plan),
      tree: null,
      copyRemoved: null,
      copyDetail: 'this command already recorded a verification run',
      staleEvidenceInvalidated: 0,
      alreadyCompleted: true,
    });
  }
  const stale = input.storage.markVerificationsStale({
    projectId: input.projectId,
    taskId: input.taskId,
    testedCommit: selected.testedCommit,
    policyDigest: digest,
    reason: 'a newer verification evidence set replaced this run',
    eventId: randomUUID(),
    invalidatedAt: now(),
  });
  input.storage.startVerificationRun({ verificationId, startedAt: now() });

  let copy;
  try {
    copy = await createVerificationCopy({
      repositoryRoot: candidates.repositoryRoot,
      copiesRoot: input.copiesRoot,
      projectId: input.projectId,
      verificationId,
      testedCommit: selected.testedCommit,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const plan = input.storage.completeVerificationRun({
      verificationId,
      state: 'ERROR',
      outcomeCode: 'WORKTREE_FAILED',
      evidence: {
        testedCommit: selected.testedCommit,
        testedTree,
        policyVersion: verificationPolicyVersion,
        policyDigest: digest,
        mainCommit: inspection.mainCommit,
        failureDetail: detail,
      },
      eventId: randomUUID(),
      completedAt: now(),
    });
    return reportFromPlan(plan, {
      commands: [],
      tree: null,
      copyRemoved: null,
      copyDetail: detail,
      staleEvidenceInvalidated: stale,
      alreadyCompleted: false,
    });
  }

  const outcomes: VerificationCommandOutcome[] = [];
  let treeEvidence: VerificationTreeEvidence | null = null;
  let terminalState: 'PASSED' | 'FAILED' | 'ERROR' = 'PASSED';
  let outcomeCode = 'PASSED';
  try {
    for (const command of commands) {
      const outcome = await runCommand({
        verificationId, command, copyPath: copy.path, runner: input.runner,
      });
      outcomes.push(outcome);
      if (outcome.timedOut) {
        terminalState = 'ERROR';
        outcomeCode = 'COMMAND_TIMEOUT';
        break;
      }
      if (outcome.exitCode !== 0) {
        terminalState = 'FAILED';
        outcomeCode = 'COMMAND_FAILED';
        break;
      }
    }
    const inspectionCopy = await inspectVerificationCopy({
      path: copy.path,
      testedCommit: selected.testedCommit,
    });
    treeEvidence = {
      headCommit: inspectionCopy.headCommit,
      trackedModifications: inspectionCopy.trackedModifications,
      untrackedFiles: inspectionCopy.untrackedFiles,
      clean: inspectionCopy.clean,
    };
    if (!inspectionCopy.clean && terminalState === 'PASSED') {
      terminalState = 'ERROR';
      outcomeCode = 'TREE_MUTATED';
    }
  } catch (error) {
    terminalState = 'ERROR';
    outcomeCode = 'VERIFICATION_FAILED';
    outcomes.push({
      id: 'internal',
      argv: [],
      cwd: '.',
      timeoutSeconds: 0,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutDigest: sha256(''),
      stderrDigest: sha256(''),
      stdoutTail: '',
      stderrTail: '',
      failureDetail: error instanceof Error ? error.message : String(error),
    });
  }

  const removal = await removeVerificationCopy({
    repositoryRoot: candidates.repositoryRoot,
    copiesRoot: input.copiesRoot,
    path: copy.path,
  }).catch((error: unknown) => ({
    removed: false,
    detail: error instanceof Error ? error.message : String(error),
  }));

  const plan = input.storage.completeVerificationRun({
    verificationId,
    state: terminalState,
    outcomeCode,
    evidence: {
      testedCommit: selected.testedCommit,
      testedTree,
      policyVersion: verificationPolicyVersion,
      policyDigest: digest,
      mainCommit: inspection.mainCommit,
      commands: outcomes.map(commandEvidence),
      tree: treeEvidence === null ? null : {
        headCommit: treeEvidence.headCommit,
        clean: treeEvidence.clean,
        trackedModifications: treeEvidence.trackedModifications,
        trackedModifiedDigest: sha256(treeEvidence.trackedModifications.join('\0')),
        untrackedFiles: treeEvidence.untrackedFiles,
        untrackedDigest: sha256(treeEvidence.untrackedFiles.join('\0')),
      },
      copyRemoval: { removed: removal.removed, detail: removal.detail },
    },
    eventId: randomUUID(),
    completedAt: now(),
  });
  return reportFromPlan(plan, {
    commands: outcomes,
    tree: treeEvidence,
    copyRemoved: removal.removed,
    copyDetail: removal.detail,
    staleEvidenceInvalidated: stale,
    alreadyCompleted: false,
  });
}
