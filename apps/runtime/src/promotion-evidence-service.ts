import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  devFullSuiteLockfilePath,
  verificationPolicyVersion,
  VerificationPolicyError,
} from '@codeestra/contracts';
import { judgeDevFullSuiteEvidence, type DevFullSuiteEvidenceRef } from '@codeestra/domain';
import { readCommitTree, readLocalRefCommit, readRefFile } from '@codeestra/git';
import {
  Phase1Database,
  StorageError,
  type DevFullSuiteEvidenceRecord,
  type DevFullSuiteState,
  type StoredVerificationCommand,
} from '@codeestra/storage';
import {
  executeVerificationPolicy,
  inspectVerificationPolicy,
  type VerificationRunner,
} from './verification-service.js';

/**
 * The independent "the full suite passed on this exact `dev` SHA" evidence ADR-0038 D03 requires
 * before `dev → main` (ADR-0039).
 *
 * The Runtime both runs and observes it: the client cannot submit a result, because a self-reported
 * "I ran the full suite and it passed" would make the strongest gate in the pipeline exactly as
 * trustworthy as a shell prompt. The run happens in a detached copy of the exact candidate commit —
 * the same isolation a Task verification uses — so it cannot be influenced by uncommitted state,
 * and the commands come from the fixed project policy read at the project's `main` ref, so the
 * candidate cannot rewrite what judges it.
 *
 * The evidence binds three inputs, and a promotion re-reads all three before moving any ref:
 * the candidate commit, that policy's digest, and the lockfile at the candidate commit.
 */
export class PromotionEvidenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PromotionEvidenceError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface DevFullSuiteReport {
  readonly evidenceId: string;
  readonly projectId: string;
  readonly devRef: string;
  readonly devCommit: string;
  readonly testedTree: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly lockfilePath: string;
  readonly lockfilePresent: boolean;
  readonly lockfileDigest: string;
  readonly commands: readonly StoredVerificationCommand[];
  readonly state: DevFullSuiteState;
  readonly outcomeCode: string | null;
  readonly copyPath: string;
  readonly copyRemoved: boolean | null;
  readonly copyDetail: string | null;
  readonly createdAt: number;
  readonly endedAt: number | null;
  /** True when this command ID already recorded a run, so its result is replayed instead of re-run. */
  readonly alreadyRecorded: boolean;
}

function report(
  record: DevFullSuiteEvidenceRecord,
  input: {
    readonly testedTree: string;
    readonly copyRemoved: boolean | null;
    readonly copyDetail: string | null;
    readonly alreadyRecorded: boolean;
  },
): DevFullSuiteReport {
  const evidence = record.evidence ?? {};
  const tree = evidence['tree'];
  return {
    evidenceId: record.evidenceId,
    projectId: record.projectId,
    devRef: record.devRef,
    devCommit: record.devCommit,
    testedTree: typeof tree === 'object' && tree !== null
      && typeof (tree as { headCommit?: unknown }).headCommit === 'string'
      ? (tree as { headCommit: string }).headCommit
      : input.testedTree,
    policyVersion: record.policyVersion,
    policyDigest: record.policyDigest,
    lockfilePath: record.lockfilePath,
    lockfilePresent: record.lockfilePresent,
    lockfileDigest: record.lockfileDigest,
    commands: record.commands,
    state: record.state,
    outcomeCode: record.outcomeCode,
    copyPath: record.copyPath,
    copyRemoved: input.copyRemoved,
    copyDetail: input.copyDetail,
    createdAt: record.queuedAt,
    endedAt: record.endedAt,
    alreadyRecorded: input.alreadyRecorded,
  };
}

function replayReport(record: DevFullSuiteEvidenceRecord): DevFullSuiteReport {
  const evidence = record.evidence ?? {};
  const removal = evidence['copyRemoval'] as { removed?: unknown; detail?: unknown } | undefined;
  const tree = evidence['tree'] as { headCommit?: unknown } | undefined;
  return report(record, {
    testedTree: typeof tree?.headCommit === 'string' ? tree.headCommit : '',
    copyRemoved: typeof removal?.removed === 'boolean' ? removal.removed : null,
    copyDetail: typeof removal?.detail === 'string'
      ? removal.detail
      : 'this command already recorded a full-suite run',
    alreadyRecorded: true,
  });
}

/** Full object IDs only: the evidence must name the exact candidate, never a name that can move. */
function fullCommitId(value: string, label: string, objectFormat: 'sha1' | 'sha256'): string {
  const expectedLength = objectFormat === 'sha1' ? 40 : 64;
  if (!new RegExp(`^[0-9a-f]{${expectedLength}}$`).test(value)) {
    throw new PromotionEvidenceError('INVALID_COMMIT_ID',
      `${label} must be a full ${objectFormat} object ID (${expectedLength} hex characters)`);
  }
  return value;
}

export interface DevFullSuiteBindingsRead {
  readonly devCommit: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly lockfilePath: string;
  readonly lockfilePresent: boolean;
  readonly lockfileDigest: string;
}

/**
 * Reads the three bindings from Git as they are *right now* for one candidate commit: the fixed
 * project policy at the project's `main` ref and the lockfile at the candidate commit.
 *
 * `prepare` and `promote` both call this, which is what makes the evidence's invalidation real: a
 * policy edit on `main` or a lockfile change inside the candidate produces a different digest, and
 * a promotion prepared or approved against the old ones is refused instead of silently re-pointed.
 */
export async function readDevFullSuiteBindings(input: {
  readonly repositoryRoot: string;
  readonly mainRef: string;
  readonly devCommit: string;
  readonly objectFormat: 'sha1' | 'sha256';
}): Promise<DevFullSuiteBindingsRead> {
  const devCommit = fullCommitId(input.devCommit, 'devCommit', input.objectFormat);
  let inspection;
  try {
    inspection = await inspectVerificationPolicy({
      repositoryRoot: input.repositoryRoot,
      mainRef: input.mainRef,
    });
  } catch (error) {
    if (error instanceof VerificationPolicyError) {
      throw new PromotionEvidenceError(error.code, error.message);
    }
    throw error;
  }
  if (inspection.state === 'ABSENT') {
    throw new PromotionEvidenceError('VERIFICATION_POLICY_ABSENT',
      `No verification policy at ${input.mainRef}; the full suite is the project's fixed policy, so`
      + ' a promotion cannot be judged without one');
  }
  const lockfile = await readRefFile({
    repositoryRoot: input.repositoryRoot,
    ref: devCommit,
    path: devFullSuiteLockfilePath,
  });
  return {
    devCommit,
    policyVersion: verificationPolicyVersion,
    policyDigest: inspection.digest as string,
    lockfilePath: devFullSuiteLockfilePath,
    // A project without a lockfile binds that fact explicitly (the digest of no bytes): the evidence
    // still says exactly what it was checked against, and adding a lockfile later changes the
    // binding instead of leaving it quietly weaker.
    lockfilePresent: lockfile.text !== null,
    lockfileDigest: sha256(lockfile.text ?? ''),
  };
}

/**
 * Runs the fixed project policy — the full suite — against the exact `dev` candidate commit in a
 * detached copy, and records the observed result as append-only evidence.
 *
 * `--dev-commit` is required and must be the current `dev` ref: the whole point is that the evidence
 * names one SHA. A run against a moving ref would be evidence about nothing.
 */
export async function runDevFullSuite(input: {
  readonly storage: Phase1Database;
  readonly runner: VerificationRunner;
  readonly copiesRoot: string;
  readonly projectId: string;
  readonly expectedDevCommit: string;
  readonly commandId: string;
  readonly observedBy?: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<DevFullSuiteReport> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const candidates = input.storage.getDevFullSuiteCandidates(input.projectId);
  const bindings = await readDevFullSuiteBindings({
    repositoryRoot: candidates.repositoryRoot,
    mainRef: candidates.mainRef,
    devCommit: input.expectedDevCommit,
    objectFormat: candidates.objectFormat,
  });
  const liveDev = await readLocalRefCommit({
    repositoryRoot: candidates.repositoryRoot, ref: candidates.devRef,
  });
  if (liveDev !== bindings.devCommit) {
    throw new PromotionEvidenceError('DEV_REF_MOVED',
      `${candidates.devRef} is at ${liveDev ?? 'a missing ref'}, not the fixed dev commit`
      + ` ${bindings.devCommit}; the full suite must run against the exact candidate`);
  }
  const inspection = await inspectVerificationPolicy({
    repositoryRoot: candidates.repositoryRoot,
    mainRef: candidates.mainRef,
  });
  const commands = inspection.policy?.commands ?? [];
  const evidenceId = randomUUID();
  const testedTree = await readCommitTree({
    repositoryRoot: candidates.repositoryRoot,
    commit: bindings.devCommit,
  });
  const copyPath = join(resolve(input.copiesRoot), input.projectId, evidenceId);
  let begun;
  try {
    begun = input.storage.beginDevFullSuiteRun({
      evidenceId,
      projectId: input.projectId,
      devRef: candidates.devRef,
      devCommit: bindings.devCommit,
      policyVersion: bindings.policyVersion,
      policyDigest: bindings.policyDigest,
      lockfilePath: bindings.lockfilePath,
      lockfilePresent: bindings.lockfilePresent,
      lockfileDigest: bindings.lockfileDigest,
      commands,
      copyPath,
      commandId: input.commandId,
      payloadHash: sha256(JSON.stringify({
        projectId: input.projectId, devCommit: bindings.devCommit,
        policyDigest: bindings.policyDigest, lockfilePresent: bindings.lockfilePresent,
        lockfileDigest: bindings.lockfileDigest, commands,
      })),
      observedBy: input.observedBy ?? 'runtime-full-suite',
      startedAt: now(),
    });
  } catch (error) {
    if (error instanceof StorageError) {
      throw new PromotionEvidenceError(error.code, error.message);
    }
    throw error;
  }
  if (!begun.created) return replayReport(begun.evidence);

  const execution = await executeVerificationPolicy({
    repositoryRoot: candidates.repositoryRoot,
    copiesRoot: input.copiesRoot,
    projectId: input.projectId,
    runId: evidenceId,
    testedCommit: bindings.devCommit,
    commands,
    runner: input.runner,
  });
  const state: 'PASSED' | 'FAILED' | 'ERROR' = execution.copyCreated
    ? execution.terminalState
    : 'ERROR';
  const outcomeCode = execution.copyCreated ? execution.outcomeCode : 'WORKTREE_FAILED';
  const recorded = input.storage.completeDevFullSuiteRun({
    evidenceId,
    state,
    outcomeCode,
    evidence: {
      devRef: candidates.devRef,
      devCommit: bindings.devCommit,
      testedTree,
      policyVersion: bindings.policyVersion,
      policyDigest: bindings.policyDigest,
      lockfilePath: bindings.lockfilePath,
      lockfilePresent: bindings.lockfilePresent,
      lockfileDigest: bindings.lockfileDigest,
      commands: execution.outcomes.map((outcome) => ({
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
      })),
      tree: execution.tree,
      copyRemoval: { removed: execution.copyRemoval.removed, detail: execution.copyRemoval.detail },
      ...(execution.failureDetail === null ? {} : { failureDetail: execution.failureDetail }),
    },
    endedAt: now(),
  });
  return report(recorded, {
    testedTree,
    copyRemoved: execution.copyRemoval.removed,
    copyDetail: execution.copyRemoval.detail,
    alreadyRecorded: false,
  });
}

export interface FullSuiteEvidenceView {
  readonly evidenceId: string;
  readonly projectId: string;
  readonly devRef: string;
  readonly devCommit: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly lockfilePath: string;
  readonly lockfilePresent: boolean;
  readonly lockfileDigest: string;
  readonly state: DevFullSuiteState;
  readonly outcomeCode: string | null;
  readonly commandCount: number;
  readonly copyPath: string;
  readonly createdAt: number;
  readonly endedAt: number | null;
}

function evidenceView(record: DevFullSuiteEvidenceRecord): FullSuiteEvidenceView {
  return {
    evidenceId: record.evidenceId,
    projectId: record.projectId,
    devRef: record.devRef,
    devCommit: record.devCommit,
    policyVersion: record.policyVersion,
    policyDigest: record.policyDigest,
    lockfilePath: record.lockfilePath,
    lockfilePresent: record.lockfilePresent,
    lockfileDigest: record.lockfileDigest,
    state: record.state,
    outcomeCode: record.outcomeCode,
    commandCount: record.commands.length,
    copyPath: record.copyPath,
    createdAt: record.queuedAt,
    endedAt: record.endedAt,
  };
}

/** Read-only: the recorded full-suite evidence of one project, newest first. */
export function listFullSuiteEvidence(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly limit?: number;
}): readonly FullSuiteEvidenceView[] {
  return input.storage.listDevFullSuiteEvidence(input.projectId, input.limit ?? 20)
    .map(evidenceView);
}

export interface FullSuiteEvidenceCheck {
  readonly usable: true;
  readonly evidenceId: string;
  readonly bindings: DevFullSuiteBindingsRead;
}

/**
 * Decides whether a promotion of `devCommit` may proceed, from the recorded evidence and the three
 * bindings as Git reports them now. `recordedEvidenceId`, when given, additionally requires the
 * usable evidence to be exactly the one a prepared promotion fixed: a different newest record means
 * the evidence set moved, so a decision made against the old one is not reusable.
 */
export async function checkDevFullSuiteEvidence(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly mainRef: string;
  readonly devCommit: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly recordedEvidenceId?: string;
}): Promise<FullSuiteEvidenceCheck> {
  const bindings = await readDevFullSuiteBindings({
    repositoryRoot: input.repositoryRoot,
    mainRef: input.mainRef,
    devCommit: input.devCommit,
    objectFormat: input.objectFormat,
  });
  const rows = input.storage.listDevFullSuiteEvidenceForCommit(input.projectId, bindings.devCommit);
  const refs: readonly DevFullSuiteEvidenceRef[] = rows.map((row) => ({
    evidenceId: row.evidenceId,
    devCommit: row.devCommit,
    policyVersion: row.policyVersion,
    policyDigest: row.policyDigest,
    lockfilePresent: row.lockfilePresent,
    lockfileDigest: row.lockfileDigest,
    state: row.state,
    outcomeCode: row.outcomeCode,
  }));
  const decision = judgeDevFullSuiteEvidence({
    evidence: refs,
    expected: {
      devCommit: bindings.devCommit,
      policyVersion: bindings.policyVersion,
      policyDigest: bindings.policyDigest,
      lockfilePresent: bindings.lockfilePresent,
      lockfileDigest: bindings.lockfileDigest,
    },
  });
  if (!decision.usable) {
    throw new PromotionEvidenceError(decision.code, decision.reason);
  }
  if (input.recordedEvidenceId !== undefined && decision.evidenceId !== input.recordedEvidenceId) {
    throw new PromotionEvidenceError('DEV_FULL_SUITE_EVIDENCE_STALE',
      `This promotion fixed dev full-suite evidence ${input.recordedEvidenceId}, but the newest`
      + ` passing evidence for ${bindings.devCommit} is now ${decision.evidenceId}; the evidence set`
      + ' moved, so prepare the promotion again');
  }
  return { usable: true, evidenceId: decision.evidenceId, bindings };
}
