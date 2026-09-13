import { createHash } from 'node:crypto';
import {
  GitInspectionError,
  changeSetPaths,
  classifySensitivePaths,
  createResultCommit,
  inspectChangeSet,
  inspectResultCommit,
  reconcileWorkspace,
  resolveCommitIdentity,
  sensitivePathPolicyVersion,
  stageResultChangeSet,
  type ChangeSetEntry,
  type CommitIdentity,
} from '@codeestra/git';
import {
  Phase1Database,
  StorageError,
  type ResultCommitAuthorization,
  type ResultCommitCapturePlan,
} from '@codeestra/storage';

export class ResultCommitServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ResultCommitServiceError';
  }
}

/** Deterministic commit message: reconciliation can recompute it without extra schema. */
export function resultCommitMessage(input: {
  readonly taskDisplayNumber: number;
  readonly revisionId: string;
  readonly executionId: string;
}): string {
  return `Codeestra result for task #${input.taskDisplayNumber}`
    + ` (revision ${input.revisionId}, execution ${input.executionId})`;
}

export interface PreparedResultCommit {
  readonly authorizationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly revisionId: string;
  readonly workspacePath: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly treeFingerprint: string;
  readonly policyVersion: number;
  readonly identity: CommitIdentity;
  readonly entries: readonly ChangeSetEntry[];
  readonly createdAt: number;
}

export interface CapturedResultCommit {
  readonly operationId: string;
  readonly authorizationId: string;
  readonly executionId: string;
  readonly taskId: string;
  readonly resultCommit: string;
  readonly resultTree: string;
  readonly identity: CommitIdentity;
  readonly hookOutcome: 'PASSED' | 'REPORTED_FAILURE_AFTER_COMMIT';
  readonly hookDetail: string;
  readonly source: 'CONFIRMED' | 'RECONCILED';
  readonly alreadyCaptured: boolean;
}

/** Resolves the one Execution that holds the Task workspace, or fails clearly. */
export function resolveHeldExecutionId(
  storage: Phase1Database,
  projectId: string,
  taskId: string,
): string {
  const held = storage.listTaskExecutions(projectId, taskId).filter((execution) => execution.resourceHeld);
  const first = held[0];
  if (first === undefined) {
    throw new ResultCommitServiceError('NO_ACTIVE_EXECUTION',
      'No Execution currently holds this Task workspace');
  }
  if (held.length > 1) {
    throw new ResultCommitServiceError('AMBIGUOUS_EXECUTION',
      'More than one Execution claims this Task workspace');
  }
  return first.executionId;
}

function sensitivePathError(paths: readonly string[]): ResultCommitServiceError {
  const hits = classifySensitivePaths(paths);
  const detail = hits.map((hit) => `${hit.path} (${hit.reason})`).join(', ');
  return new ResultCommitServiceError('SENSITIVE_PATH_BLOCKED',
    `Result commit refused: ${hits.length} path(s) match the sensitive/runtime deny policy `
    + `v${sensitivePathPolicyVersion}: ${detail}. Move them out of the worktree and prepare again.`);
}

async function assertOwnedWorkspace(input: {
  readonly repositoryRoot: string;
  readonly workspacePath: string;
  readonly branchRef: string;
  readonly executionId: string;
}): Promise<void> {
  const observation = await reconcileWorkspace({
    repositoryRoot: input.repositoryRoot,
    path: input.workspacePath,
    branchRef: input.branchRef,
  });
  if (observation.state !== 'OWNED') {
    throw new ResultCommitServiceError('WORKSPACE_NOT_OWNED',
      `Execution ${input.executionId} workspace is ${observation.state}: ${observation.evidenceRef}`);
  }
}

function assertQuiescent(authorization: ResultCommitAuthorization): void {
  if (!authorization.quiescent) {
    throw new ResultCommitServiceError('AGENT_NOT_QUIESCENT',
      'Agent tools and owned writers are not proven stopped; result commit is not allowed yet');
  }
  if (authorization.executionState !== 'RUNNING' || !authorization.resourceHeld
    || authorization.workspaceState !== 'IN_USE' || authorization.taskState !== 'RUNNING') {
    throw new ResultCommitServiceError('INVALID_EXECUTION_STATE',
      `Execution is ${authorization.executionState}/${authorization.workspaceState}/${authorization.taskState}`
      + '; a result commit needs a running, quiescent Execution');
  }
}

/**
 * Snapshots the workspace change set and records a one-shot authorization. Nothing is
 * staged or committed here: the user sees the exact HEAD, ChangeSet fingerprint, identity,
 * and policy version that a later confirmation would consume.
 */
export async function prepareResultCommit(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskId: string;
  /** Defaults to the single Execution that currently holds the Task workspace. */
  readonly executionId?: string;
  readonly commandId: string;
  readonly actor: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<PreparedResultCommit> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const executionId = input.executionId
    ?? resolveHeldExecutionId(input.storage, input.projectId, input.taskId);
  const subject = input.storage.getResultCommitSubject(input.projectId, input.taskId, executionId);
  if (subject.currentRevisionId !== subject.appliedRevisionId) {
    throw new ResultCommitServiceError('STALE_REVISION',
      'Task revision changed after the Execution started; a result commit needs a new Execution');
  }
  if (!subject.quiescent) {
    throw new ResultCommitServiceError('AGENT_NOT_QUIESCENT',
      'Agent tools and owned writers are not proven stopped; result commit is not allowed yet');
  }
  const project = input.storage.getTrustedProject(input.projectId);
  await assertOwnedWorkspace({
    repositoryRoot: project.repoRoot,
    workspacePath: subject.workspacePath,
    branchRef: subject.workspaceBranchRef,
    executionId: subject.executionId,
  });
  const changeSet = await inspectChangeSet({
    workspacePath: subject.workspacePath,
    baseCommit: subject.baseCommit,
  });
  if (changeSet.entries.length === 0) {
    throw new ResultCommitServiceError('NOTHING_TO_COMMIT',
      'The task worktree has no changes relative to its fixed base');
  }
  const paths = changeSetPaths(changeSet);
  const hits = classifySensitivePaths(paths);
  if (hits.length > 0) throw sensitivePathError(paths);
  const identity = await resolveCommitIdentity(subject.workspacePath);
  const createdAt = now();
  const authorizationId = randomUUID();
  const authorization = input.storage.prepareResultCommitAuthorization({
    projectId: input.projectId,
    taskId: input.taskId,
    executionId,
    authorizationId,
    commandId: input.commandId,
    payloadHash: createHash('sha256').update(JSON.stringify({
      authorizationId, expectedHead: changeSet.headCommit, changeFingerprint: changeSet.treeFingerprint,
      policyVersion: sensitivePathPolicyVersion,
    })).digest('hex'),
    expectedHead: changeSet.headCommit,
    changeFingerprint: changeSet.treeFingerprint,
    policyVersion: sensitivePathPolicyVersion,
    eventId: randomUUID(),
    invalidatedEventId: randomUUID(),
    actor: input.actor,
    createdAt,
  });
  return {
    authorizationId: authorization.id,
    projectId: input.projectId,
    taskId: input.taskId,
    executionId,
    revisionId: authorization.appliedRevisionId,
    workspacePath: authorization.workspacePath,
    baseCommit: authorization.baseCommit,
    headCommit: authorization.expectedHead,
    treeFingerprint: authorization.changeFingerprint,
    policyVersion: sensitivePathPolicyVersion,
    identity,
    entries: changeSet.entries,
    createdAt: authorization.createdAt,
  };
}

function captureFailureCode(detail: string): string {
  return /nothing to commit|no changes added to commit/i.test(detail) ? 'NOTHING_TO_COMMIT' : 'COMMIT_FAILED';
}

/**
 * Consumes one authorization to create the result commit. The authorization is only
 * consumed when HEAD, the ChangeSet fingerprint, the revision, and the quiescence proof
 * still match; a commit that Git created while reporting a failure is adopted instead of
 * being rewritten or reported as missing.
 */
export async function captureResultCommit(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly taskId: string;
  readonly authorizationId: string;
  readonly commandId: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<CapturedResultCommit> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const authorization = input.storage.getResultCommitAuthorization(input.authorizationId);
  if (authorization.projectId !== input.projectId || authorization.taskId !== input.taskId) {
    throw new ResultCommitServiceError('AUTHORIZATION_MISMATCH',
      'Result commit authorization belongs to a different project or task');
  }
  // A consumed authorization with a recorded commit is an idempotent replay, not a new commit.
  if (authorization.status === 'CONSUMED') {
    if (authorization.resultCommit === null) {
      throw new ResultCommitServiceError('AUTHORIZATION_NOT_ACTIVE',
        'Result commit authorization is CONSUMED without a recorded commit');
    }
    return {
      operationId: '',
      authorizationId: authorization.id,
      executionId: authorization.executionId,
      taskId: authorization.taskId,
      resultCommit: authorization.resultCommit,
      resultTree: '',
      identity: await resolveCommitIdentity(authorization.workspacePath),
      hookOutcome: 'PASSED' as const,
      hookDetail: 'authorization was already consumed; no second commit was created',
      source: 'CONFIRMED' as const,
      alreadyCaptured: true,
    };
  }
  if (authorization.status !== 'ACTIVE') {
    throw new ResultCommitServiceError('AUTHORIZATION_NOT_ACTIVE',
      `Result commit authorization is ${authorization.status}`);
  }
  assertQuiescent(authorization);
  const project = input.storage.getTrustedProject(input.projectId);
  await assertOwnedWorkspace({
    repositoryRoot: project.repoRoot,
    workspacePath: authorization.workspacePath,
    branchRef: authorization.workspaceBranchRef,
    executionId: authorization.executionId,
  });
  const message = resultCommitMessage({
    taskDisplayNumber: authorization.taskDisplayNumber,
    revisionId: authorization.appliedRevisionId,
    executionId: authorization.executionId,
  });

  // A commit that already exists on top of the authorized head is adopted: the Runtime
  // never rewrites it and never runs the hooks a second time.
  const adopted = await inspectResultCommit({
    workspacePath: authorization.workspacePath,
    expectedHead: authorization.expectedHead,
    expectedMessage: message,
  });
  if (adopted !== null) {
    return completeCapture(input, authorization, {
      operationId: randomUUID(),
      resultCommit: adopted.commit,
      resultTree: adopted.tree,
      identityName: adopted.authorName,
      identityEmail: adopted.authorEmail,
      hookOutcome: 'PASSED',
      hookDetail: 'adopted an existing result commit without re-running hooks',
      source: 'RECONCILED',
    });
  }

  const changeSet = await inspectChangeSet({
    workspacePath: authorization.workspacePath,
    baseCommit: authorization.baseCommit,
  });
  if (changeSet.headCommit !== authorization.expectedHead
    || changeSet.treeFingerprint !== authorization.changeFingerprint) {
    input.storage.invalidateResultCommitAuthorization({
      authorizationId: authorization.id,
      reason: 'HEAD or ChangeSet changed after the authorization was prepared',
      eventId: randomUUID(),
      invalidatedAt: now(),
    });
    throw new ResultCommitServiceError('STALE_AUTHORIZATION',
      'The worktree changed after this authorization was prepared; prepare a new result commit');
  }
  const paths = changeSetPaths(changeSet);
  if (classifySensitivePaths(paths).length > 0) {
    input.storage.invalidateResultCommitAuthorization({
      authorizationId: authorization.id,
      reason: 'ChangeSet now matches the sensitive/runtime deny policy',
      eventId: randomUUID(),
      invalidatedAt: now(),
    });
    throw sensitivePathError(paths);
  }
  const identity = await resolveCommitIdentity(authorization.workspacePath);

  let plan: ResultCommitCapturePlan;
  try {
    plan = input.storage.startResultCommitCapture({
      operationId: randomUUID(),
      commandId: input.commandId,
      authorizationId: authorization.id,
      expectedHead: authorization.expectedHead,
      changeFingerprint: authorization.changeFingerprint,
      startedAt: now(),
    });
  } catch (error) {
    if (error instanceof StorageError) {
      throw new ResultCommitServiceError(error.code, error.message);
    }
    throw error;
  }
  if (plan.operationState === 'SUCCEEDED') {
    return {
      operationId: plan.operationId,
      authorizationId: plan.authorizationId,
      executionId: plan.executionId,
      taskId: plan.taskId,
      resultCommit: plan.resultCommit ?? '',
      resultTree: plan.resultTree ?? '',
      identity,
      hookOutcome: 'PASSED' as const,
      hookDetail: 'capture command replayed; no second commit was created',
      source: 'CONFIRMED' as const,
      alreadyCaptured: true,
    };
  }
  if (plan.operationState === 'FAILED') {
    throw new ResultCommitServiceError('COMMIT_FAILED',
      'The previous capture for this command failed; re-run with a new command');
  }

  await stageResultChangeSet(authorization.workspacePath);
  let outcome;
  try {
    outcome = await createResultCommit({
      workspacePath: authorization.workspacePath,
      expectedHead: authorization.expectedHead,
      message,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    input.storage.failResultCommitCapture({
      operationId: plan.operationId,
      error: { code: error instanceof GitInspectionError ? error.code : 'COMMIT_FAILED', message: detail },
      reconcileRequired: false,
      failedAt: now(),
    });
    throw new ResultCommitServiceError('COMMIT_FAILED', detail);
  }
  if (!outcome.commitExists) {
    const detail = outcome.detail ?? 'git commit did not create a commit';
    input.storage.failResultCommitCapture({
      operationId: plan.operationId,
      error: { code: captureFailureCode(detail), message: detail },
      reconcileRequired: false,
      failedAt: now(),
    });
    throw new ResultCommitServiceError(captureFailureCode(detail), detail);
  }

  const inspected = await inspectResultCommit({
    workspacePath: authorization.workspacePath,
    expectedHead: authorization.expectedHead,
    expectedMessage: message,
    expectedEntries: changeSet.entries,
  });
  if (inspected === null) {
    input.storage.failResultCommitCapture({
      operationId: plan.operationId,
      error: { code: 'COMMIT_MISMATCH', message: 'Created commit did not match the authorized change set' },
      reconcileRequired: true,
      failedAt: now(),
    });
    input.storage.invalidateResultCommitAuthorization({
      authorizationId: authorization.id,
      reason: 'Created commit did not match the authorized change set',
      eventId: randomUUID(),
      invalidatedAt: now(),
    });
    throw new ResultCommitServiceError('COMMIT_MISMATCH',
      'A commit exists but does not match this authorization; inspect the worktree before continuing');
  }
  return completeCapture(input, authorization, {
    operationId: plan.operationId,
    resultCommit: inspected.commit,
    resultTree: inspected.tree,
    identityName: inspected.authorName,
    identityEmail: inspected.authorEmail,
    hookOutcome: outcome.detail === undefined ? 'PASSED' : 'REPORTED_FAILURE_AFTER_COMMIT',
    hookDetail: outcome.detail ?? '',
    source: 'CONFIRMED',
  });
}

interface CaptureCompletion {
  readonly operationId: string;
  readonly resultCommit: string;
  readonly resultTree: string;
  readonly identityName: string;
  readonly identityEmail: string;
  readonly hookOutcome: 'PASSED' | 'REPORTED_FAILURE_AFTER_COMMIT';
  readonly hookDetail: string;
  readonly source: 'CONFIRMED' | 'RECONCILED';
}

function completeCapture(
  input: {
    readonly storage: Phase1Database;
    readonly now?: () => number;
    readonly randomUUID?: () => string;
  },
  authorization: ResultCommitAuthorization,
  completion: CaptureCompletion,
): CapturedResultCommit {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const plan = input.storage.completeResultCommitCapture({
    operationId: completion.operationId,
    resultCommit: completion.resultCommit,
    resultTree: completion.resultTree,
    identityName: completion.identityName,
    identityEmail: completion.identityEmail,
    hookOutcome: completion.hookOutcome,
    hookDetail: completion.hookDetail,
    source: completion.source,
    eventId: randomUUID(),
    executionEventId: randomUUID(),
    taskEventId: randomUUID(),
    completedAt: now(),
  });
  return {
    operationId: plan.operationId,
    authorizationId: authorization.id,
    executionId: authorization.executionId,
    taskId: authorization.taskId,
    resultCommit: completion.resultCommit,
    resultTree: completion.resultTree,
    identity: { name: completion.identityName, email: completion.identityEmail },
    hookOutcome: completion.hookOutcome,
    hookDetail: completion.hookDetail,
    source: completion.source,
    alreadyCaptured: false,
  };
}
