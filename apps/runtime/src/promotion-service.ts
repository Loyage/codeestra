import { createHash } from 'node:crypto';
import {
  findCheckedOutWorktree,
  inspectPromotionWorktree,
  inspectRepository,
  isAncestor,
  promotionRemote,
  pushCommitToRemote,
  readLocalRefCommit,
  readRemoteRef,
} from '@codeestra/git';
import {
  Phase1Database,
  StorageError,
  type PromotionMember,
  type PromotionPermissionMode,
  type PromotionRestartPlanStep,
  type PromotionRestartStepOutcome,
  type StablePromotionPlan,
  type StablePromotionState,
} from '@codeestra/storage';
import { DevRepoError, requireCandidateInDevRepo, requireDevRepo } from './dev-repo-service.js';
import { checkDevFullSuiteEvidence, PromotionEvidenceError } from './promotion-evidence-service.js';

export class PromotionServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PromotionServiceError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mapStorageError(error: unknown): never {
  if (error instanceof StorageError) throw new PromotionServiceError(error.code, error.message);
  throw error;
}

/**
 * The fixed post-promotion sequence, executed in the worktree that has `main` checked out
 * (ADR-0009 D03). `node_modules` and `apps/ui/dist` are per-worktree, gitignored local state, so a
 * promotion that skipped them would run new code against stale dependencies or UI assets.
 *
 * The list is recorded when the pull is observed and before any step runs, and it is part of the
 * promotion's evidence: the client must run exactly these steps, and `promotion.restart.record`
 * refuses a different list. It cannot be recorded earlier, because until the pull happened there is
 * no worktree holding the candidate to name.
 */
export function promotionRestartPlan(mainWorktreePath: string): readonly PromotionRestartPlanStep[] {
  return [
    { id: 'install', argv: ['bun', 'install', '--frozen-lockfile'], cwd: mainWorktreePath },
    { id: 'build-ui', argv: ['bun', 'run', 'build:ui'], cwd: mainWorktreePath },
    { id: 'stop', argv: ['bun', 'run', 'codeestra', 'stop'], cwd: mainWorktreePath },
    { id: 'status', argv: ['bun', 'run', 'codeestra', 'status'], cwd: mainWorktreePath },
  ];
}

export interface PromotionReport extends StablePromotionPlan {
  /** True when this call created the promotion record. */
  readonly created: boolean;
  /** True when the call reported an already finished promotion instead of doing the work again. */
  readonly replayed: boolean;
}

function report(
  plan: StablePromotionPlan,
  input: { readonly created: boolean; readonly replayed: boolean },
): PromotionReport {
  return { ...plan, created: input.created, replayed: input.replayed };
}

function isFinished(state: StablePromotionState): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'STALE';
}

/** Full object IDs only: a promotion must state the exact commit, never a name that could move. */
function requireFullCommitId(input: {
  readonly value: string;
  readonly label: string;
  readonly objectFormat: 'sha1' | 'sha256';
}): string {
  const expectedLength = input.objectFormat === 'sha1' ? 40 : 64;
  const pattern = new RegExp(`^[0-9a-f]{${expectedLength}}$`);
  if (!pattern.test(input.value)) {
    throw new PromotionServiceError('INVALID_COMMIT_ID',
      `${input.label} must be a full ${input.objectFormat} object ID (${expectedLength} hex`
      + ` characters) so the promotion cannot silently follow a moved branch`);
  }
  return input.value;
}

interface FixedEvidence {
  readonly members: readonly PromotionMember[];
  readonly verificationId: string;
  readonly verificationTestedCommit: string;
}

/**
 * Refuses a promotion whose fixed claim does not match the records it came from. Nothing here
 * reads a ref yet: the point is to reject a stale or invented triple before Git is involved.
 */
function requireIntegrationEvidence(input: {
  readonly candidates: ReturnType<Phase1Database['getPromotionCandidates']>;
  readonly expectedDevCommit: string;
}): FixedEvidence {
  const { candidates } = input;
  if (candidates.batchState !== 'INTEGRATED') {
    throw new PromotionServiceError('BATCH_NOT_INTEGRATED',
      `Integration batch ${candidates.batchId} is ${candidates.batchState}; only an INTEGRATED`
      + ' batch carries a verified dev commit');
  }
  if (candidates.batchDevRef !== candidates.devRef) {
    throw new PromotionServiceError('PROMOTION_EVIDENCE_MISMATCH',
      `Integration batch ${candidates.batchId} was integrated into ${candidates.batchDevRef},`
      + ` but this project promotes ${candidates.devRef}`);
  }
  if (candidates.batchIntegratedCommit !== input.expectedDevCommit) {
    throw new PromotionServiceError('PROMOTION_EVIDENCE_MISMATCH',
      `Integration batch ${candidates.batchId} integrated ${candidates.batchIntegratedCommit ?? 'nothing'},`
      + ` not the requested dev commit ${input.expectedDevCommit}`);
  }
  if (candidates.verificationState !== 'PASSED') {
    throw new PromotionServiceError('VERIFICATION_NOT_PASSED',
      `The independent integration verification of batch ${candidates.batchId} is`
      + ` ${candidates.verificationState ?? 'missing'}`
      + `${candidates.verificationOutcomeCode === null ? '' : ` (${candidates.verificationOutcomeCode})`}`
      + '; a promotion needs a PASSED verification of the merged commit');
  }
  if (candidates.verificationTestedCommit !== candidates.batchMergedCommit
    || candidates.verificationTestedCommit !== input.expectedDevCommit
    || candidates.verificationDevCommit !== candidates.batchDevCommit) {
    throw new PromotionServiceError('PROMOTION_EVIDENCE_MISMATCH',
      'The integration verification is not bound to the merge commit that produced the dev commit,'
      + ' or was judged against a different dev baseline');
  }
  return {
    members: candidates.members,
    verificationId: candidates.verificationId as string,
    verificationTestedCommit: candidates.verificationTestedCommit as string,
  };
}

/**
 * The dev full-suite evidence a promotion fixes (ADR-0038 D03). The three bindings are read from
 * Git, never from the evidence row alone: a `main`-ref policy edit or a lockfile change inside the
 * candidate changes the digest the promotion is checked against, which is what makes the fixed
 * evidence expire instead of quietly outliving the fact it described.
 */
async function requireFullSuiteEvidence(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly mainRef: string;
  readonly devCommit: string;
  readonly objectFormat: 'sha1' | 'sha256';
}): Promise<{ readonly evidenceId: string;
  readonly bindings: Awaited<ReturnType<typeof checkDevFullSuiteEvidence>>['bindings'] }> {
  try {
    const check = await checkDevFullSuiteEvidence({
      storage: input.storage,
      projectId: input.projectId,
      repositoryRoot: input.repositoryRoot,
      mainRef: input.mainRef,
      devCommit: input.devCommit,
      objectFormat: input.objectFormat,
    });
    return { evidenceId: check.evidenceId, bindings: check.bindings };
  } catch (error) {
    if (error instanceof PromotionEvidenceError) {
      throw new PromotionServiceError(error.code, error.message);
    }
    throw error;
  }
}

/**
 * What the main checkout says right now, read from Git rather than from the promotion record.
 */
interface MainCheckoutFacts {
  /** Commit `${mainRef}` really has in the main checkout. */
  readonly mainCommit: string | null;
  readonly mainWorktreePath: string;
}

/**
 * Reads the main checkout and refuses unless it is exactly where the requested step says it is.
 *
 * Two callers use this with different expectations, which is the whole point of ADR-0047 D03: at
 * preparation the checkout must still be on the expected old main commit (`expectedCommit`), and
 * after the user pulled the pushed candidate the checkout must be on the candidate. The main ref is
 * read from the repository and the worktree is inspected, so "the pull happened" is never assumed
 * from the push having succeeded.
 */
async function requireMainCheckoutAt(input: {
  readonly repositoryRoot: string;
  readonly mainRef: string;
  readonly expectedCommit: string;
  readonly expectation: 'EXPECTED_MAIN' | 'PULLED_CANDIDATE';
}): Promise<MainCheckoutFacts> {
  const mainCommit = await readLocalRefCommit({
    repositoryRoot: input.repositoryRoot, ref: input.mainRef,
  });
  if (mainCommit !== input.expectedCommit) {
    throw new PromotionServiceError('MAIN_REF_MOVED',
      input.expectation === 'EXPECTED_MAIN'
        ? `${input.mainRef} is at ${mainCommit ?? 'a missing ref'}, not the expected main commit`
          + ` ${input.expectedCommit}`
        : `${input.mainRef} is at ${mainCommit ?? 'a missing ref'}, not the fixed candidate`
          + ` ${input.expectedCommit}`);
  }
  const worktree = await findCheckedOutWorktree({
    repositoryRoot: input.repositoryRoot, ref: input.mainRef,
  });
  if (worktree === null) {
    throw new PromotionServiceError('MAIN_WORKTREE_MISSING',
      `${input.mainRef} is not checked out in any worktree; the promotion's pull and its restart`
      + ' sequence both happen in the worktree that has it checked out');
  }
  const inspection = await inspectPromotionWorktree({
    path: worktree.path,
    expectedRef: input.mainRef,
    expectedCommit: input.expectedCommit,
  });
  if (!inspection.clean) {
    throw new PromotionServiceError('MAIN_WORKTREE_DIRTY',
      `The main worktree ${worktree.path} has ${inspection.trackedModifications.length} modified`
      + ` tracked file(s) (${inspection.trackedModifications.slice(0, 5).join(', ')});`
      + ' a promotion must not run against a checkout that is being edited');
  }
  return { mainCommit, mainWorktreePath: inspection.path };
}

/**
 * The fixed candidate must descend from the expected old main commit, so the pull in the main
 * checkout is a fast-forward and never a merge. The check runs in the dev clone, where the
 * candidate object lives (ADR-0047 D05): the main checkout may not even have it before the pull.
 */
async function requireFastForwardCandidate(input: {
  readonly devRepoPath: string;
  readonly candidateCommit: string;
  readonly expectedMainCommit: string;
}): Promise<void> {
  let descendant = false;
  try {
    descendant = await isAncestor({
      repositoryRoot: input.devRepoPath,
      ancestor: input.expectedMainCommit,
      descendant: input.candidateCommit,
    });
  } catch (error) {
    throw new PromotionServiceError('DEV_REPO_BASE_MISSING',
      `The dev clone ${input.devRepoPath} does not hold the expected main commit`
      + ` ${input.expectedMainCommit}, so the fast-forward relation cannot be established`
      + ` (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!descendant) {
    throw new PromotionServiceError('PROMOTION_NOT_FAST_FORWARD',
      `${input.candidateCommit} is not a descendant of ${input.expectedMainCommit};`
      + ' a stable promotion is a fast-forward of the verified dev commit, never a merge of it');
  }
}

/**
 * The remote dev ref as of now, and whether that state is compatible with pushing the fixed
 * candidate.
 *
 * Before the promotion pushed: the remote may be absent, already the candidate, or an ancestor of
 * it (an ordinary lagging `dev`). Anything else means the remote branch moved somewhere this
 * promotion does not know about, and ADR-0047 D02/D03 makes that a refusal rather than a force
 * push. After the push the same readback is compared exactly with the recorded commit, so a remote
 * moved away from the candidate is detected instead of being pushed over.
 */
async function readRemoteDevState(input: {
  readonly devRepoPath: string;
  readonly devRef: string;
  readonly candidateCommit: string;
  readonly expectedRemoteCommit: string | null;
}): Promise<{
  readonly commit: string | null;
  readonly acceptable: boolean;
  /** The stable refusal code when the remote state cannot be used; null when it is acceptable. */
  readonly code: 'REMOTE_DEV_UNREACHABLE' | 'REMOTE_DEV_MOVED' | null;
  readonly detail: string;
}> {
  const read = await readRemoteRef({
    repositoryRoot: input.devRepoPath, remote: promotionRemote, ref: input.devRef,
  });
  if (!read.reachable) {
    return { commit: null, acceptable: false, code: 'REMOTE_DEV_UNREACHABLE',
      detail: `${promotionRemote} ${input.devRef} could not be read back: ${read.detail ?? 'unknown error'}` };
  }
  if (input.expectedRemoteCommit !== null) {
    return read.commit === input.expectedRemoteCommit
      ? { commit: read.commit, acceptable: true, code: null, detail: '' }
      : { commit: read.commit, acceptable: false, code: 'REMOTE_DEV_MOVED',
          detail: `${promotionRemote} ${input.devRef} is at ${read.commit ?? 'a missing ref'}, not the`
            + ` recorded readback ${input.expectedRemoteCommit}` };
  }
  if (read.commit === null || read.commit === input.candidateCommit) {
    return { commit: read.commit, acceptable: true, code: null, detail: '' };
  }
  let ancestor = false;
  try {
    ancestor = await isAncestor({
      repositoryRoot: input.devRepoPath,
      ancestor: read.commit,
      descendant: input.candidateCommit,
    });
  } catch {
    return { commit: read.commit, acceptable: false, code: 'REMOTE_DEV_MOVED',
      detail: `${promotionRemote} ${input.devRef} is at ${read.commit}, which this dev clone does not`
        + ' hold; fetch it before promoting so the remote branch can be judged' };
  }
  return ancestor
    ? { commit: read.commit, acceptable: true, code: null, detail: '' }
    : { commit: read.commit, acceptable: false, code: 'REMOTE_DEV_MOVED',
        detail: `${promotionRemote} ${input.devRef} is at ${read.commit}, which is not`
          + ` ${input.candidateCommit} nor an ancestor of it` };
}

/**
 * The promotion's dev clone: verified as a separate clone of this project's origin (ADR-0047 D05)
 * and holding the fixed candidate, so the push has something to send.
 */
async function requirePromotionDevRepo(input: {
  readonly repositoryRoot: string;
  readonly devRef: string;
  readonly devRepoPath: string;
  readonly candidateCommit: string;
}): Promise<{ readonly devRepoPath: string }> {
  try {
    const inspection = await requireDevRepo({
      repositoryRoot: input.repositoryRoot,
      devRef: input.devRef,
      devRepoPath: input.devRepoPath,
    });
    await requireCandidateInDevRepo({
      devRepoPath: inspection.path, candidateCommit: input.candidateCommit,
    });
    return { devRepoPath: inspection.path };
  } catch (error) {
    if (error instanceof DevRepoError) {
      throw new PromotionServiceError(error.code, error.message);
    }
    throw error;
  }
}

/**
 * Marks the project's open promotion STALE, if it has one that can still be marked. A record whose
 * pull was already observed is left alone: it is handled by the caller's own refusal, and rewriting
 * it as STALE would claim nothing had happened when `main` really is on the candidate.
 */
function markOpenPromotionStale(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly outcomeCode: string;
  readonly reason: string;
  readonly eventId: string;
  readonly at: number;
}): void {
  const open = input.storage.getOpenStablePromotion(input.projectId);
  if (open === null) return;
  if (open.state !== 'CREATED' && open.state !== 'AWAITING_APPROVAL'
    && open.state !== 'PROMOTING') return;
  input.storage.markStablePromotionStale({
    promotionId: open.promotionId,
    outcomeCode: input.outcomeCode,
    reason: input.reason,
    eventId: input.eventId,
    at: input.at,
  });
}

/**
 * Records what a refused remote `dev` state does to the project's record.
 *
 * The two cases are deliberately different: a remote that moved away from the candidate makes the
 * prepared record unusable (`STALE`, prepare again), while a remote that could not be reached is a
 * network fact about a record that is still exactly right — it is recorded as a refused attempt and
 * stays open, so the same command can be retried without re-preparing anything.
 */
function refuseOnRemoteDevState(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly outcomeCode: 'REMOTE_DEV_UNREACHABLE' | 'REMOTE_DEV_MOVED' | null;
  readonly detail: string;
  readonly eventId: string;
  readonly at: number;
  readonly staleRecord: StablePromotionPlan | null;
}): void {
  if (input.outcomeCode === 'REMOTE_DEV_UNREACHABLE') {
    if (input.staleRecord !== null) {
      input.storage.recordStablePromotionPushFailure({
        promotionId: input.staleRecord.promotionId,
        outcomeCode: 'REMOTE_DEV_UNREACHABLE',
        detail: input.detail,
        eventId: input.eventId,
        at: input.at,
      });
    }
    return;
  }
  if (input.staleRecord === null) {
    markOpenPromotionStale({
      storage: input.storage, projectId: input.projectId, outcomeCode: 'REMOTE_DEV_MOVED',
      reason: input.detail, eventId: input.eventId, at: input.at,
    });
    return;
  }
  input.storage.markStablePromotionStale({
    promotionId: input.staleRecord.promotionId,
    outcomeCode: 'REMOTE_DEV_MOVED',
    reason: input.detail,
    eventId: input.eventId,
    at: input.at,
  });
}

/**
 * Trust is re-validated before any ref is read: a repository whose identity changed invalidates
 * the ref names the promotion was prepared against.
 */
async function requireUnchangedRepository(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly now: () => number;
}): Promise<void> {
  const repository = await inspectRepository(input.repositoryRoot);
  if (repository.repoRoot !== input.repositoryRoot
    || repository.gitCommonDir !== input.gitCommonDir
    || repository.objectFormat !== input.objectFormat) {
    input.storage.invalidateProjectTrust(input.projectId, input.now());
    throw new PromotionServiceError('REPOSITORY_CHANGED',
      'Project trust invalidated after the repository identity changed');
  }
}

/**
 * Fixes the promotion's three facts — the verified `dev` commit, the expected old `main` commit,
 * and the independent integration verification of the promoted commit — together with the dev clone
 * the candidate will be pushed from, and records them.
 *
 * This call writes nothing to Git and nothing to the remote. It reads the main checkout, the dev
 * clone and the current remote `dev` once, so a promotion prepared against reality is never
 * prepared against an assumption; anything that does not match is refused with the specific fact
 * that was wrong. A remote `dev` that already moved away from the fixed candidate makes the call
 * refuse **and** marks an open promotion of this project STALE (ADR-0047 D02), because the record
 * that was prepared against the other remote state is no longer usable.
 */
export async function prepareStablePromotion(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly batchId: string;
  readonly expectedDevCommit: string;
  readonly expectedMainCommit: string;
  readonly commandId: string;
  readonly permissionMode: PromotionPermissionMode;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<PromotionReport> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const replay = input.storage.findStablePromotionByCommand(input.projectId, input.commandId);
  if (replay !== null) return report(replay, { created: false, replayed: true });
  const candidates = input.storage.getPromotionCandidates(input.projectId, input.batchId);
  const expectedDevCommit = requireFullCommitId({
    value: input.expectedDevCommit, label: 'expectedDevCommit', objectFormat: candidates.objectFormat,
  });
  const expectedMainCommit = requireFullCommitId({
    value: input.expectedMainCommit, label: 'expectedMainCommit', objectFormat: candidates.objectFormat,
  });
  const evidence = requireIntegrationEvidence({ candidates, expectedDevCommit });
  await requireUnchangedRepository({
    storage: input.storage, projectId: input.projectId,
    repositoryRoot: candidates.repositoryRoot, gitCommonDir: candidates.gitCommonDir,
    objectFormat: candidates.objectFormat, now,
  });
  // ADR-0047 D05: without a verified dev clone the promotion has no way to reach the remote, so
  // this is a named refusal instead of a promotion that would silently have nothing to push.
  if (candidates.devRepoPath === null) {
    throw new PromotionServiceError('DEV_REPO_PATH_MISSING',
      `Project ${input.projectId} has no dev clone recorded; run`
      + ` \`project trust ${candidates.repositoryRoot} --dev-repo <dev-clone>\` so a promotion can`
      + ' push the fixed candidate to the remote dev branch');
  }
  const devRepo = await requirePromotionDevRepo({
    repositoryRoot: candidates.repositoryRoot,
    devRef: candidates.devRef,
    devRepoPath: candidates.devRepoPath,
    candidateCommit: expectedDevCommit,
  });
  const facts = await requireMainCheckoutAt({
    repositoryRoot: candidates.repositoryRoot,
    mainRef: candidates.mainRef,
    expectedCommit: expectedMainCommit,
    expectation: 'EXPECTED_MAIN',
  });
  if (facts.mainCommit === expectedDevCommit) {
    throw new PromotionServiceError('PROMOTION_NOTHING_TO_PROMOTE',
      `${candidates.mainRef} already is the verified dev commit ${expectedDevCommit}`);
  }
  await requireFastForwardCandidate({
    devRepoPath: devRepo.devRepoPath,
    candidateCommit: expectedDevCommit,
    expectedMainCommit,
  });
  const remote = await readRemoteDevState({
    devRepoPath: devRepo.devRepoPath,
    devRef: candidates.devRef,
    candidateCommit: expectedDevCommit,
    expectedRemoteCommit: null,
  });
  if (!remote.acceptable) {
    refuseOnRemoteDevState({
      storage: input.storage, projectId: input.projectId, outcomeCode: remote.code,
      detail: remote.detail, eventId: randomUUID(), at: now(), staleRecord: null,
    });
    throw new PromotionServiceError(remote.code as string,
      `${remote.detail}; the remote dev branch is the promotion's source of truth, so nothing was`
      + ' prepared — resolve it and prepare again');
  }
  // ADR-0038 D03: a promotion additionally needs a PASSED full-suite run of this exact dev SHA,
  // bound to the fixed project policy and to the lockfile at that commit. The bindings are read
  // from Git here and fixed into the promotion, so a later policy or lockfile change is detectable.
  const fullSuite = await requireFullSuiteEvidence({
    storage: input.storage,
    projectId: input.projectId,
    repositoryRoot: candidates.repositoryRoot,
    mainRef: candidates.mainRef,
    devCommit: expectedDevCommit,
    objectFormat: candidates.objectFormat,
  });
  let begun;
  try {
    begun = input.storage.beginStablePromotion({
      projectId: input.projectId,
      batchId: input.batchId,
      promotionId: randomUUID(),
      operationId: randomUUID(),
      commandId: input.commandId,
      payloadHash: sha256(JSON.stringify({
        projectId: input.projectId, batchId: input.batchId, expectedDevCommit,
        expectedMainCommit, verificationId: evidence.verificationId,
        devRepoPath: devRepo.devRepoPath,
        fullSuiteEvidenceId: fullSuite.evidenceId,
        fullSuitePolicyDigest: fullSuite.bindings.policyDigest,
        fullSuiteLockfileDigest: fullSuite.bindings.lockfileDigest,
      })),
      createdEventId: randomUUID(),
      devRef: candidates.devRef,
      mainRef: candidates.mainRef,
      candidateCommit: expectedDevCommit,
      expectedMainCommit,
      verificationId: evidence.verificationId,
      verificationTestedCommit: evidence.verificationTestedCommit,
      devRepoPath: devRepo.devRepoPath,
      fullSuiteEvidenceId: fullSuite.evidenceId,
      fullSuiteDevCommit: fullSuite.bindings.devCommit,
      fullSuitePolicyVersion: fullSuite.bindings.policyVersion,
      fullSuitePolicyDigest: fullSuite.bindings.policyDigest,
      fullSuiteLockfileDigest: fullSuite.bindings.lockfileDigest,
      permissionMode: input.permissionMode,
      actor: 'runtime-promotion',
      createdAt: now(),
    });
  } catch (error) {
    mapStorageError(error);
  }
  return report({ ...begun.plan, mainWorktreePath: facts.mainWorktreePath },
    { created: begun.created, replayed: false });
}

/**
 * Records one STRICT approval of exactly the prepared triple. FULL has no approval step at all,
 * so asking for one there is refused instead of being accepted as a pointless confirmation.
 *
 * ADR-0047 D02 is re-checked here as well: an approval given while the remote `dev` branch already
 * holds something other than the fixed candidate is refused and the record is marked STALE, so an
 * approval can never outlive the remote state it was given for.
 */
export async function approveStablePromotion(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly promotionId: string;
  readonly permissionMode: PromotionPermissionMode;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<PromotionReport> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const plan = input.storage.getStablePromotionPlan(input.projectId, input.promotionId);
  if (plan.permissionMode !== 'STRICT' || input.permissionMode !== 'STRICT') {
    throw new PromotionServiceError('APPROVAL_NOT_REQUIRED',
      'This promotion does not need an approval: FULL mode promotes the fixed triple without one'
      + ' (ADR-0011)');
  }
  if (isFinished(plan.state)) {
    throw new PromotionServiceError('PROMOTION_FINISHED',
      `Promotion is ${plan.state}; a finished promotion cannot be approved`);
  }
  if (plan.state === 'CREATED') {
    await requireRemoteDevUnmoved({ storage: input.storage, plan, now, randomUUID });
  }
  let approved;
  try {
    approved = input.storage.approveStablePromotion({
      promotionId: input.promotionId,
      actor: 'local-user',
      approvedAt: now(),
      eventId: randomUUID(),
    });
  } catch (error) {
    mapStorageError(error);
  }
  return report(approved, { created: false, replayed: false });
}

/**
 * Advances the promotion by exactly one step of ADR-0047 D01/D03, and never by two:
 *
 * 1. nothing pushed yet → push the fixed candidate to the remote `dev` and **read it back**; record
 *    the readback (PROMOTING / `AWAITING_PULL`). That is where this call stops while the main
 *    checkout has not pulled the candidate: "pushed" is reported as pushed, with its own exit code.
 * 2. pushed and verified → re-read the remote (a remote `dev` moved away from the candidate is
 *    STALE) and ask the main checkout whether the pull happened.
 * 3. the main checkout is on the candidate → verify the fast-forward relation, record the restart
 *    plan and hand it to the client, which runs the steps.
 * 4. the restart was already recorded → retry publishing the remote `main` only, so a network
 *    failure after a successful restart does not stop the Runtime a second time.
 *
 * No branch is ever written through `git update-ref`, no local `dev` ref is fast-forwarded into
 * `main`, and `main` is never advanced by this service at all: the only ref this capability moves is
 * a remote one, by push, and only after reading back what the remote actually says.
 */
export async function promoteStableBranch(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly promotionId: string;
  readonly bootId: string;
  readonly permissionMode: PromotionPermissionMode;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<PromotionReport> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());

  let plan = input.storage.getStablePromotionPlan(input.projectId, input.promotionId);
  if (isFinished(plan.state)) return report(plan, { created: false, replayed: true });
  await requireUnchangedRepository({
    storage: input.storage, projectId: input.projectId, repositoryRoot: plan.repositoryRoot,
    gitCommonDir: plan.gitCommonDir, objectFormat: plan.objectFormat, now,
  });
  if (plan.devRepoPath !== null) {
    // The project's recorded dev clone is what this promotion pushes from; a different one would
    // make the recorded readback describe a remote state this clone never wrote.
    const project = input.storage.getTrustedProject(input.projectId);
    if (project.devRepoPath !== plan.devRepoPath) {
      throw new PromotionServiceError('DEV_REPO_PATH_CHANGED',
        `The project's dev clone changed from ${plan.devRepoPath} to`
        + ` ${project.devRepoPath ?? 'nothing'}; the promotion was prepared against the other one`);
    }
  }

  if (plan.state === 'RESTARTING' || plan.state === 'RECOVERY_REQUIRED') {
    // `main` already carries the candidate (the pull was observed). Nothing local is written again;
    // a restart that was already recorded leaves only the remote publish to retry.
    if (plan.promotedCommit !== plan.candidateCommit) {
      throw new PromotionServiceError('PROMOTION_IN_PROGRESS',
        `Promotion is ${plan.state} with main at ${plan.promotedCommit ?? 'an unknown commit'};`
        + ' reconcile it before promoting again');
    }
    if (plan.restart === null) return report(restartPlan(plan), { created: false, replayed: false });
    return await publishMain({ storage: input.storage, plan, now, randomUUID });
  }

  // ADR-0038 D03, re-checked against Git immediately before any side effect: the candidate SHA, the
  // fixed project policy digest and the lockfile digest must still be exactly what this promotion
  // fixed. `main` has not moved at this point, so a promotion that fails this check is marked STALE
  // and has to be prepared again rather than re-pointed at whatever changed.
  if (plan.fullSuite === null) {
    throw new PromotionServiceError('DEV_FULL_SUITE_EVIDENCE_MISSING',
      `Promotion ${plan.promotionId} was prepared without dev full-suite evidence; abandon it and`
      + ' prepare it again (ADR-0038 requires a PASSED full-suite run of the exact dev candidate)');
  }
  try {
    await checkDevFullSuiteEvidence({
      storage: input.storage,
      projectId: input.projectId,
      repositoryRoot: plan.repositoryRoot,
      mainRef: plan.mainRef,
      devCommit: plan.candidateCommit,
      objectFormat: plan.objectFormat,
      recordedEvidenceId: plan.fullSuite.evidenceId,
    });
  } catch (error) {
    if (!(error instanceof PromotionEvidenceError)) throw error;
    if (plan.state === 'CREATED' || plan.state === 'AWAITING_APPROVAL') {
      input.storage.markStablePromotionStale({
        promotionId: plan.promotionId,
        outcomeCode: error.code,
        reason: error.message,
        eventId: randomUUID(),
        at: now(),
      });
      throw new PromotionServiceError(error.code,
        `${error.message} — the promotion was marked STALE; prepare and approve it again`);
    }
    throw new PromotionServiceError(error.code, error.message);
  }

  // FULL means zero confirmations (ADR-0011); STRICT keeps the one recorded approval.
  if (input.permissionMode === 'STRICT') {
    const approval = plan.approval;
    if (approval === null || approval.devCommit !== plan.candidateCommit
      || approval.mainCommit !== plan.expectedMainCommit
      || approval.verificationId !== plan.verificationId
      || approval.fullSuiteEvidenceId !== (plan.fullSuite?.evidenceId ?? null)) {
      throw new PromotionServiceError('PROMOTION_NOT_APPROVED',
        'STRICT mode requires an approval of this exact dev/main/verification/full-suite-evidence'
        + ' triple; run promotion approve first');
    }
    // The approval is only valid while the evidence it was given for still matches.
    const candidates = input.storage.getPromotionCandidates(input.projectId, plan.integrationBatchId);
    requireIntegrationEvidence({ candidates, expectedDevCommit: plan.candidateCommit });
  }

  if (plan.state === 'CREATED' || plan.state === 'AWAITING_APPROVAL') {
    if (plan.devRepoPath === null) {
      throw new PromotionServiceError('DEV_REPO_PATH_MISSING',
        `Promotion ${plan.promotionId} has no recorded dev clone; prepare it again after`
        + ' `project trust <main-checkout> --dev-repo <dev-clone>`');
    }
    const devRepo = await requirePromotionDevRepo({
      repositoryRoot: plan.repositoryRoot,
      devRef: plan.devRef,
      devRepoPath: plan.devRepoPath,
      candidateCommit: plan.candidateCommit,
    });
    let facts: MainCheckoutFacts;
    try {
      facts = await requireMainCheckoutAt({
        repositoryRoot: plan.repositoryRoot,
        mainRef: plan.mainRef,
        expectedCommit: plan.expectedMainCommit,
        expectation: 'EXPECTED_MAIN',
      });
    } catch (error) {
      if (error instanceof PromotionServiceError && error.code === 'MAIN_REF_MOVED') {
        input.storage.markStablePromotionStale({
          promotionId: plan.promotionId,
          outcomeCode: error.code,
          reason: error.message,
          eventId: randomUUID(),
          at: now(),
        });
        throw new PromotionServiceError('PROMOTION_STALE',
          `${error.message} — the promotion was marked STALE; prepare and approve it again`);
      }
      throw error;
    }
    if (facts.mainCommit === plan.candidateCommit) {
      throw new PromotionServiceError('PROMOTION_NOTHING_TO_PROMOTE',
        `${plan.mainRef} already is the verified dev commit ${plan.candidateCommit}`);
    }
    await requireFastForwardCandidate({
      devRepoPath: devRepo.devRepoPath,
      candidateCommit: plan.candidateCommit,
      expectedMainCommit: plan.expectedMainCommit,
    });
    const remote = await readRemoteDevState({
      devRepoPath: devRepo.devRepoPath,
      devRef: plan.devRef,
      candidateCommit: plan.candidateCommit,
      expectedRemoteCommit: null,
    });
    if (!remote.acceptable) {
      refuseOnRemoteDevState({
        storage: input.storage, projectId: input.projectId, outcomeCode: remote.code,
        detail: remote.detail, eventId: randomUUID(), at: now(), staleRecord: plan,
      });
      throw new PromotionServiceError(remote.code as string,
        `${remote.detail}` + (remote.code === 'REMOTE_DEV_MOVED'
          ? ' — the promotion was marked STALE; prepare and approve it again'
          : ' — nothing was pushed; retry promotion promote when the remote is reachable again'));
    }
    const push = await pushCommitToRemote({
      repositoryRoot: devRepo.devRepoPath,
      remote: promotionRemote,
      commit: plan.candidateCommit,
      ref: plan.devRef,
    });
    if (!push.ok) {
      // No ref moved, local or remote (a refused push leaves the remote exactly as it was), so the
      // record stays prepared and the same command can be retried once the remote is reachable.
      input.storage.recordStablePromotionPushFailure({
        promotionId: plan.promotionId,
        outcomeCode: 'DEV_PUSH_REFUSED',
        detail: push.detail,
        eventId: randomUUID(),
        at: now(),
      });
      throw new PromotionServiceError('DEV_PUSH_REFUSED',
        `Pushing ${plan.candidateCommit} to ${promotionRemote} ${plan.devRef} failed from`
        + ` ${devRepo.devRepoPath}: ${push.detail}. Nothing was recorded as pushed; fix the remote`
        + ' and run promotion promote again');
    }
    const readback = await readRemoteDevState({
      devRepoPath: devRepo.devRepoPath,
      devRef: plan.devRef,
      candidateCommit: plan.candidateCommit,
      expectedRemoteCommit: null,
    });
    if (readback.commit !== plan.candidateCommit) {
      // "The push exited 0" is not evidence that the remote holds the candidate (ADR-0047 D02).
      input.storage.recordStablePromotionPushFailure({
        promotionId: plan.promotionId,
        outcomeCode: 'REMOTE_DEV_READBACK_MISMATCH',
        detail: readback.detail.length > 0 ? readback.detail
          : `${promotionRemote} ${plan.devRef} reads ${readback.commit ?? 'a missing ref'} after the push`,
        eventId: randomUUID(),
        at: now(),
      });
      throw new PromotionServiceError('REMOTE_DEV_READBACK_MISMATCH',
        `The push reported success, but ${promotionRemote} ${plan.devRef} reads`
        + ` ${readback.commit ?? 'a missing ref'} instead of ${plan.candidateCommit}; the promotion`
        + ' is not recorded as pushed (ADR-0047 D02)');
    }
    try {
      plan = input.storage.startStablePromotion({
        promotionId: plan.promotionId,
        devRepoPath: devRepo.devRepoPath,
        remoteDevCommit: readback.commit,
        permissionMode: input.permissionMode,
        pushedAt: now(),
        eventId: randomUUID(),
      });
    } catch (error) {
      mapStorageError(error);
    }
  }

  // Pushed and verified: from here on the question is whether the main checkout pulled it.
  if (plan.state === 'PROMOTING') {
    await requireRemoteDevUnmoved({ storage: input.storage, plan, now, randomUUID });
    const mainCommit = await readLocalRefCommit({
      repositoryRoot: plan.repositoryRoot, ref: plan.mainRef,
    });
    if (mainCommit !== plan.candidateCommit) {
      if (mainCommit !== plan.expectedMainCommit) {
        // The main checkout moved somewhere this promotion cannot explain. It is not touched, and
        // the promotion stays open in PROMOTING for reconciliation rather than being claimed.
        throw new PromotionServiceError('MAIN_REF_MOVED',
          `${plan.mainRef} is at ${mainCommit ?? 'a missing ref'} instead of the expected`
          + ` ${plan.expectedMainCommit} or the pushed candidate ${plan.candidateCommit}; the pull in`
          + ' the main checkout is the user\'s step, so resolve it there and promote again');
      }
      return report(plan, { created: false, replayed: false });
    }
    const facts = await requireMainCheckoutAt({
      repositoryRoot: plan.repositoryRoot,
      mainRef: plan.mainRef,
      expectedCommit: plan.candidateCommit,
      expectation: 'PULLED_CANDIDATE',
    });
    // The candidate reached the main checkout by a fast-forward, not by a merge or a reset: the
    // relation is checkable now because the object is finally present there.
    if (!await isAncestor({
      repositoryRoot: plan.repositoryRoot,
      ancestor: plan.expectedMainCommit,
      descendant: plan.candidateCommit,
    })) {
      throw new PromotionServiceError('PROMOTION_NOT_FAST_FORWARD',
        `${plan.candidateCommit} is not a descendant of ${plan.expectedMainCommit} in the main`
        + ' checkout; a stable promotion only ever fast-forwards');
    }
    const steps = promotionRestartPlan(facts.mainWorktreePath);
    try {
      plan = input.storage.recordStablePromotionMainUpdate({
        promotionId: plan.promotionId,
        promotedCommit: plan.candidateCommit,
        mainWorktreePath: facts.mainWorktreePath,
        restartSteps: steps,
        promotingBootId: input.bootId,
        observedAt: now(),
        eventId: randomUUID(),
      });
    } catch (error) {
      mapStorageError(error);
    }
    return report(restartPlan(plan), { created: false, replayed: false });
  }

  throw new PromotionServiceError('PROMOTION_STATE_INVALID',
    `Promotion ${plan.promotionId} is ${plan.state}; promotion promote has no step for it`);
}

/**
 * The remote `dev` branch still holds what this promotion recorded, or a STALE refusal.
 *
 * When the remote moved somewhere else the promotion is marked STALE and nothing is pushed: the
 * fixed candidate is no longer the remote's state, and ADR-0047 D02 makes the readback — not a
 * force push — the way that is resolved.
 */
async function requireRemoteDevUnmoved(input: {
  readonly storage: Phase1Database;
  readonly plan: StablePromotionPlan;
  readonly now: () => number;
  readonly randomUUID: () => string;
}): Promise<void> {
  const { plan } = input;
  if (plan.devRepoPath === null) {
    throw new PromotionServiceError('DEV_REPO_PATH_MISSING',
      `Promotion ${plan.promotionId} has no recorded dev clone; prepare it again after`
      + ' `project trust <main-checkout> --dev-repo <dev-clone>`');
  }
  const remote = await readRemoteDevState({
    devRepoPath: plan.devRepoPath,
    devRef: plan.devRef,
    candidateCommit: plan.candidateCommit,
    expectedRemoteCommit: plan.remoteDevCommit,
  });
  if (remote.acceptable) return;
  refuseOnRemoteDevState({
    storage: input.storage, projectId: plan.projectId, outcomeCode: remote.code,
    detail: remote.detail, eventId: input.randomUUID(), at: input.now(), staleRecord: plan,
  });
  throw new PromotionServiceError(remote.code as string,
    `${remote.detail}` + (remote.code === 'REMOTE_DEV_MOVED'
      ? ' — the promotion was marked STALE; prepare and approve it again'
      : ' — nothing was pushed; retry promotion promote when the remote is reachable again'));
}

/**
 * Publishes the stable commit to the remote `main`, which is the last step of ADR-0047 D01 and the
 * only thing that turns a restarted main checkout into a finished promotion.
 *
 * The push names the fixed candidate and is never forced, so the remote's fast-forward rule decides;
 * the remote is then read back, because "the push exited 0" is not evidence about the remote. A
 * refused publish keeps the promotion open (RESTARTING / `MAIN_PUSH_PENDING`) with the failure
 * recorded: `main` is already updated and running, nothing is rolled back, and the same command
 * retries only the publish.
 */
async function publishMain(input: {
  readonly storage: Phase1Database;
  readonly plan: StablePromotionPlan;
  readonly now: () => number;
  readonly randomUUID: () => string;
}): Promise<PromotionReport> {
  const { plan } = input;
  const push = await pushCommitToRemote({
    repositoryRoot: plan.repositoryRoot,
    remote: promotionRemote,
    commit: plan.candidateCommit,
    ref: plan.mainRef,
  });
  if (!push.ok) {
    const remote = await readRemoteRef({
      repositoryRoot: plan.repositoryRoot, remote: promotionRemote, ref: plan.mainRef,
    });
    const observed = remote.reachable
      ? `${promotionRemote} ${plan.mainRef} reads ${remote.commit ?? 'a missing ref'}`
      : `${promotionRemote} ${plan.mainRef} could not be read back: ${remote.detail ?? 'unknown error'}`;
    input.storage.recordStablePromotionMainPush({
      promotionId: plan.promotionId,
      remoteMainCommit: null,
      outcomeCode: 'MAIN_PUSH_REFUSED',
      detail: `${push.detail}; ${observed}`.slice(0, 4_000),
      eventId: input.randomUUID(),
      at: input.now(),
    });
    throw new PromotionServiceError('MAIN_PUSH_REFUSED',
      `The main checkout is at ${plan.candidateCommit} and the restarted Runtime was recorded, but`
      + ` publishing it to ${promotionRemote} ${plan.mainRef} failed: ${push.detail}. The promotion`
      + ' is not reported as completed; publish the remote main branch or run promotion promote'
      + ' again to retry just this step');
  }
  const readback = await readRemoteRef({
    repositoryRoot: plan.repositoryRoot, remote: promotionRemote, ref: plan.mainRef,
  });
  if (!readback.reachable || readback.commit !== plan.candidateCommit) {
    const detail = !readback.reachable
      ? `${promotionRemote} ${plan.mainRef} could not be read back: ${readback.detail ?? 'unknown error'}`
      : `${promotionRemote} ${plan.mainRef} reads ${readback.commit ?? 'a missing ref'} after the`
        + ` push, not ${plan.candidateCommit}`;
    input.storage.recordStablePromotionMainPush({
      promotionId: plan.promotionId,
      remoteMainCommit: null,
      outcomeCode: 'REMOTE_MAIN_READBACK_MISMATCH',
      detail,
      eventId: input.randomUUID(),
      at: input.now(),
    });
    throw new PromotionServiceError('REMOTE_MAIN_READBACK_MISMATCH',
      `${detail}; the promotion is not reported as completed (ADR-0047 D02)`);
  }
  let completed;
  try {
    completed = input.storage.recordStablePromotionMainPush({
      promotionId: plan.promotionId,
      remoteMainCommit: readback.commit,
      outcomeCode: 'PROMOTED',
      detail: `${plan.candidateCommit} was pushed to ${promotionRemote} ${plan.mainRef} after the main`
        + ' checkout was observed at the candidate and the restarted Runtime answered READY',
      eventId: input.randomUUID(),
      at: input.now(),
    });
  } catch (error) {
    mapStorageError(error);
  }
  return report(completed, { created: false, replayed: false });
}

/** The plan a client needs to run the recorded restart sequence; parts of it are only plans. */
function restartPlan(plan: StablePromotionPlan): StablePromotionPlan {
  if (plan.mainWorktreePath === null || plan.promotingBootId === null) {
    throw new PromotionServiceError('PROMOTION_STATE_INVALID',
      `Promotion ${plan.promotionId} is ${plan.state} without a recorded main worktree or boot`);
  }
  return plan;
}

function stepsMatch(
  recorded: readonly PromotionRestartPlanStep[],
  submitted: readonly PromotionRestartStepOutcome[],
): string | null {
  if (recorded.length !== submitted.length) {
    return `the recorded restart plan has ${recorded.length} step(s) but ${submitted.length} were reported`;
  }
  for (const [index, step] of recorded.entries()) {
    const outcome = submitted[index] as PromotionRestartStepOutcome;
    if (outcome.id !== step.id || outcome.cwd !== step.cwd
      || outcome.argv.length !== step.argv.length
      || outcome.argv.some((argument, position) => argument !== step.argv[position])) {
      return `step ${index + 1} was reported as ${outcome.id} ${outcome.argv.join(' ')} in`
        + ` ${outcome.cwd}, but the recorded plan is ${step.id} ${step.argv.join(' ')} in ${step.cwd}`;
    }
  }
  return null;
}

/**
 * Records the observed Runtime restart and decides the promotion's outcome from evidence.
 *
 * The client cannot claim a restart that did not happen: the boot identity it reports must be the
 * Runtime answering this request (so the observation is of *this* process) and must differ from
 * the boot that issued the restart plan after reading the pull (so a Runtime that was never stopped
 * cannot pass). The step list must match the recorded plan exactly, and the restart counts as
 * recorded only when every step exited 0 and the Runtime answered `status: READY`. `uiRunning` is
 * recorded as an observed fact; the Web UI is an on-demand client (ADR-0007), so it is not a
 * promotion criterion.
 *
 * A recorded restart is **not** the end of the promotion: ADR-0047 D01 publishes the stable commit
 * to the remote `main` after the restart was checked, so a successful restart immediately tries that
 * publish in the same call. A failed restart ends the promotion as FAILED and never publishes.
 */
export async function recordPromotionRestart(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly promotionId: string;
  readonly bootId: string;
  readonly observedBootId: string;
  readonly runtimeStatus: string | null;
  readonly uiRunning: boolean | null;
  readonly steps: readonly PromotionRestartStepOutcome[];
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<PromotionReport> {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const plan = input.storage.getStablePromotionPlan(input.projectId, input.promotionId);
  if (isFinished(plan.state)) return report(plan, { created: false, replayed: true });
  if (plan.state !== 'RESTARTING' && plan.state !== 'RECOVERY_REQUIRED') {
    throw new PromotionServiceError('PROMOTION_STATE_INVALID',
      `Promotion is ${plan.state}; only a promotion whose main update was observed records a restart`);
  }
  if (input.observedBootId !== input.bootId) {
    throw new PromotionServiceError('RUNTIME_NOT_OBSERVED',
      'The reported Runtime boot identity is not the Runtime answering this request;'
      + ' re-read status from the running Runtime and record again');
  }
  if (plan.promotedCommit !== plan.candidateCommit) {
    throw new PromotionServiceError('PROMOTION_STATE_INVALID',
      `Promotion is ${plan.state} but main was not observed at the promoted commit`
      + ` ${plan.candidateCommit}`);
  }
  const mainCommit = await readLocalRefCommit({
    repositoryRoot: plan.repositoryRoot, ref: plan.mainRef,
  });
  if (mainCommit !== plan.candidateCommit) {
    throw new PromotionServiceError('MAIN_REF_MOVED',
      `${plan.mainRef} is at ${mainCommit ?? 'a missing ref'}, not the promoted commit`
      + ` ${plan.candidateCommit}; the restart evidence describes a state that no longer exists`);
  }
  const mismatch = stepsMatch(plan.restartSteps, input.steps);
  if (mismatch !== null) {
    throw new PromotionServiceError('RESTART_PLAN_MISMATCH', mismatch);
  }
  const promotingBootId = plan.promotingBootId;
  if (promotingBootId === null) {
    throw new PromotionServiceError('PROMOTION_STATE_INVALID',
      `Promotion ${plan.promotionId} has no recorded boot identity to compare the restart against`);
  }
  // A step that did not exit 0 is reported as such: that is the actionable cause, and it also
  // explains why the Runtime may never have been stopped at all.
  const failedStep = input.steps.find((step) => step.exitCode !== 0);
  const succeeded = failedStep === undefined && input.runtimeStatus === 'READY'
    && input.observedBootId !== promotingBootId;
  const outcomeCode = failedStep !== undefined
    ? 'RESTART_STEP_FAILED'
    : input.observedBootId === promotingBootId ? 'RUNTIME_NOT_RESTARTED'
      : input.runtimeStatus === 'READY' ? 'RESTARTED' : 'RUNTIME_NOT_READY';
  const detail = succeeded
    ? `main is at ${plan.candidateCommit}; ${input.steps.length} post-step(s) exited 0 and the`
      + ` restarted Runtime answered status READY (uiRunning ${String(input.uiRunning)})`
    : failedStep !== undefined
      ? `The post-step ${failedStep.id} (${failedStep.argv.join(' ')})`
        + (failedStep.exitCode === null
          ? ' was not run because an earlier post-step failed'
          : ` exited ${String(failedStep.exitCode)}`)
        + ` in ${failedStep.cwd}; main stays at ${plan.candidateCommit}`
        + ' and the Runtime restart was not completed by Codeestra'
      : input.observedBootId === promotingBootId
        ? 'The Runtime answering this request is the same boot that moved main, so the Runtime was'
          + ` not restarted; main stays at ${plan.candidateCommit}`
        : `The Runtime answered ${input.runtimeStatus ?? 'nothing'} instead of READY after the`
          + ` restart sequence; main stays at ${plan.candidateCommit}`;
  const recorded = input.storage.recordStablePromotionRestart({
    promotionId: plan.promotionId,
    state: succeeded ? 'RESTARTED' : 'FAILED',
    outcomeCode,
    restart: restartResult(input, input.steps),
    detail,
    eventId: randomUUID(),
    completedEventId: randomUUID(),
    completedAt: now(),
  });
  // ADR-0047 D01: the stable commit is published only after the restarted Runtime was checked, so
  // the same call that recorded the restart is the one that publishes it. A promotion that stops
  // here would leave a running main checkout that GitHub does not know about.
  if (!succeeded) return report(recorded, { created: false, replayed: false });
  return await publishMain({ storage: input.storage, plan: recorded, now, randomUUID });
}

function restartResult(
  input: {
    readonly observedBootId: string;
    readonly runtimeStatus: string | null;
    readonly uiRunning: boolean | null;
  },
  steps: readonly PromotionRestartStepOutcome[],
): {
  readonly observedBootId: string;
  readonly runtimeStatus: string | null;
  readonly uiRunning: boolean | null;
  readonly steps: readonly PromotionRestartStepOutcome[];
} {
  return {
    observedBootId: input.observedBootId,
    runtimeStatus: input.runtimeStatus,
    uiRunning: input.uiRunning,
    steps,
  };
}

/**
 * Closes a promotion whose outcome is still open, without touching a ref.
 *
 * It is allowed once the pull was observed as well: at that point the main checkout really is on the
 * candidate and may be running it, and `main` — not this record — is what says so. The record keeps
 * `promoted_commit`, so closing it never claims nothing happened.
 */
export function abandonStablePromotion(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly promotionId: string;
  readonly reason: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): PromotionReport {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const plan = input.storage.getStablePromotion(input.projectId, input.promotionId);
  if (isFinished(plan.state)) {
    throw new PromotionServiceError('PROMOTION_FINISHED',
      `Promotion is ${plan.state}; there is nothing to abandon`);
  }
  if (plan.state === 'PROMOTING' && plan.remoteDevCommit === null) {
    // Unreachable through the state machine (PROMOTING is only entered with a readback), but the
    // record must never be closed as "abandoned" while it cannot say what the remote holds.
    throw new PromotionServiceError('PROMOTION_IN_PROGRESS',
      'This promotion is in flight without a recorded remote readback; let the Runtime reconcile it'
      + ' from the remote before abandoning it');
  }
  let abandoned;
  try {
    abandoned = input.storage.failStablePromotion({
      promotionId: input.promotionId,
      outcomeCode: 'ABANDONED',
      detail: input.reason,
      eventId: randomUUID(),
      failedAt: now(),
    });
  } catch (error) {
    mapStorageError(error);
  }
  return report(abandoned, { created: false, replayed: false });
}

/** Reads the boot identity the Runtime recorded when it moved `main`; parts of the plan only. */
