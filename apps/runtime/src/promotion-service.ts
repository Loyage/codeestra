import { createHash } from 'node:crypto';
import {
  fastForwardCheckedOutWorktree,
  findCheckedOutWorktree,
  inspectPromotionWorktree,
  inspectRepository,
  isAncestor,
  readLocalRefCommit,
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
 * The list is recorded before `main` moves and is part of the promotion's evidence: the client
 * must run exactly these steps, and `promotion.restart.record` refuses a different list.
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

interface LiveFacts {
  readonly devCommit: string;
  readonly mainCommit: string;
  readonly mainWorktreePath: string;
}

/**
 * Reads what Git says right now and refuses any promotion whose three fixed facts no longer
 * match. `dev` and `main` are read from their refs, not from the record.
 */
async function requireLiveFacts(input: {
  readonly repositoryRoot: string;
  readonly devRef: string;
  readonly mainRef: string;
  readonly expectedDevCommit: string;
  readonly expectedMainCommit: string;
}): Promise<LiveFacts> {
  const devCommit = await readLocalRefCommit({
    repositoryRoot: input.repositoryRoot, ref: input.devRef,
  });
  if (devCommit !== input.expectedDevCommit) {
    throw new PromotionServiceError('DEV_REF_MOVED',
      `${input.devRef} is at ${devCommit ?? 'a missing ref'}, not the fixed dev commit`
      + ` ${input.expectedDevCommit}`);
  }
  const mainCommit = await readLocalRefCommit({
    repositoryRoot: input.repositoryRoot, ref: input.mainRef,
  });
  if (mainCommit !== input.expectedMainCommit) {
    throw new PromotionServiceError('MAIN_REF_MOVED',
      `${input.mainRef} is at ${mainCommit ?? 'a missing ref'}, not the expected main commit`
      + ` ${input.expectedMainCommit}`);
  }
  if (mainCommit === input.expectedDevCommit) {
    throw new PromotionServiceError('PROMOTION_NOTHING_TO_PROMOTE',
      `${input.mainRef} already is the verified dev commit ${input.expectedDevCommit}`);
  }
  if (!await isAncestor({
    repositoryRoot: input.repositoryRoot,
    ancestor: input.expectedMainCommit,
    descendant: input.expectedDevCommit,
  })) {
    throw new PromotionServiceError('PROMOTION_NOT_FAST_FORWARD',
      `${input.expectedDevCommit} is not a descendant of ${input.expectedMainCommit};`
      + ' a stable promotion is a fast-forward of the verified dev commit, never a merge of it');
  }
  const worktree = await findCheckedOutWorktree({
    repositoryRoot: input.repositoryRoot, ref: input.mainRef,
  });
  if (worktree === null) {
    throw new PromotionServiceError('MAIN_WORKTREE_MISSING',
      `${input.mainRef} is not checked out in any worktree; a promotion must fast-forward the`
      + ' worktree that has it checked out, and its restart sequence runs there');
  }
  const inspection = await inspectPromotionWorktree({
    path: worktree.path,
    expectedRef: input.mainRef,
    expectedCommit: input.expectedMainCommit,
  });
  if (!inspection.clean) {
    throw new PromotionServiceError('MAIN_WORKTREE_DIRTY',
      `The main worktree ${worktree.path} has ${inspection.trackedModifications.length} modified`
      + ` tracked file(s) (${inspection.trackedModifications.slice(0, 5).join(', ')});`
      + ' a promotion must not fast-forward a checkout that is being edited');
  }
  return { devCommit, mainCommit, mainWorktreePath: inspection.path };
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
 * and the independent integration verification of the promoted commit — and records them.
 *
 * This call writes nothing to Git. It reads the refs and the main worktree once, so a promotion
 * that is prepared against reality is never prepared against an assumption; anything that does
 * not match is refused with the specific fact that was wrong.
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
  const facts = await requireLiveFacts({
    repositoryRoot: candidates.repositoryRoot,
    devRef: candidates.devRef,
    mainRef: candidates.mainRef,
    expectedDevCommit,
    expectedMainCommit,
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
      })),
      createdEventId: randomUUID(),
      devRef: candidates.devRef,
      mainRef: candidates.mainRef,
      candidateCommit: expectedDevCommit,
      expectedMainCommit,
      verificationId: evidence.verificationId,
      verificationTestedCommit: evidence.verificationTestedCommit,
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
 */
export function approveStablePromotion(input: {
  readonly storage: Phase1Database;
  readonly projectId: string;
  readonly promotionId: string;
  readonly permissionMode: PromotionPermissionMode;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): PromotionReport {
  const now = input.now ?? Date.now;
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  const plan = input.storage.getStablePromotion(input.projectId, input.promotionId);
  if (plan.permissionMode !== 'STRICT' || input.permissionMode !== 'STRICT') {
    throw new PromotionServiceError('APPROVAL_NOT_REQUIRED',
      'This promotion does not need an approval: FULL mode promotes the fixed triple without one'
      + ' (ADR-0011)');
  }
  if (isFinished(plan.state)) {
    throw new PromotionServiceError('PROMOTION_FINISHED',
      `Promotion is ${plan.state}; a finished promotion cannot be approved`);
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
 * Fast-forwards `main` to the fixed candidate inside the worktree that has `main` checked out,
 * then records the restart plan and returns it to the client.
 *
 * The ref is never advanced through `git update-ref`: on this machine `main` is checked out in the
 * stable worktree, and moving its ref alone would leave that worktree's index and files on the old
 * commit. The fast-forward moves ref, index and files together, and `main` is read back afterwards
 * so "git said ok" is never treated as evidence that the ref moved.
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

  if (plan.state === 'RESTARTING' || plan.state === 'RECOVERY_REQUIRED') {
    // `main` already moved in an earlier attempt: this call only re-issues the restart plan. The
    // ref is not written twice, which is what makes a crash reconcilable.
    if (plan.promotedCommit !== plan.candidateCommit) {
      throw new PromotionServiceError('PROMOTION_IN_PROGRESS',
        `Promotion is ${plan.state} with main at ${plan.promotedCommit ?? 'an unknown commit'};`
        + ' reconcile it before promoting again');
    }
    return report(restartPlan(plan), { created: false, replayed: false });
  }

  // FULL means zero confirmations (ADR-0011); STRICT keeps the one recorded approval.
  if (input.permissionMode === 'STRICT') {
    const approval = plan.approval;
    if (approval === null || approval.devCommit !== plan.candidateCommit
      || approval.mainCommit !== plan.expectedMainCommit
      || approval.verificationId !== plan.verificationId) {
      throw new PromotionServiceError('PROMOTION_NOT_APPROVED',
        'STRICT mode requires an approval of this exact dev/main/verification triple;'
        + ' run promotion approve first');
    }
    // The approval is only valid while the evidence it was given for still matches.
    const candidates = input.storage.getPromotionCandidates(input.projectId, plan.integrationBatchId);
    requireIntegrationEvidence({ candidates, expectedDevCommit: plan.candidateCommit });
  }

  let facts: LiveFacts;
  try {
    facts = await requireLiveFacts({
      repositoryRoot: plan.repositoryRoot,
      devRef: plan.devRef,
      mainRef: plan.mainRef,
      expectedDevCommit: plan.candidateCommit,
      expectedMainCommit: plan.expectedMainCommit,
    });
  } catch (error) {
    // The fixed evidence no longer matches Git: the promotion is unusable as approved, and it has
    // to be prepared again rather than silently re-pointed at whatever moved.
    if (error instanceof PromotionServiceError
      && ['DEV_REF_MOVED', 'MAIN_REF_MOVED', 'PROMOTION_NOTHING_TO_PROMOTE'].includes(error.code)) {
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

  const steps = promotionRestartPlan(facts.mainWorktreePath);
  try {
    plan = input.storage.startStablePromotion({
      promotionId: plan.promotionId,
      mainWorktreePath: facts.mainWorktreePath,
      restartSteps: steps,
      promotingBootId: input.bootId,
      permissionMode: input.permissionMode,
      startedAt: now(),
      eventId: randomUUID(),
    });
  } catch (error) {
    mapStorageError(error);
  }
  let merged;
  try {
    merged = await fastForwardCheckedOutWorktree({
      path: facts.mainWorktreePath,
      expectedRef: plan.mainRef,
      expectedCommit: plan.expectedMainCommit,
      candidateCommit: plan.candidateCommit,
    });
  } catch (error) {
    // A repository that can no longer be inspected (race with a manual branch switch, a refusing
    // hook, an unreadable ref) is recorded as a failed promotion instead of leaving it in flight.
    const failed = input.storage.failStablePromotion({
      promotionId: plan.promotionId,
      outcomeCode: 'MAIN_UPDATE_FAILED',
      detail: (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
      eventId: randomUUID(),
      failedAt: now(),
    });
    return report(failed, { created: false, replayed: false });
  }
  if (merged.outcome !== 'FAST_FORWARD' || merged.commit !== plan.candidateCommit) {
    const failed = input.storage.failStablePromotion({
      promotionId: plan.promotionId,
      outcomeCode: 'MAIN_UPDATE_FAILED',
      detail: merged.detail.slice(0, 4_000),
      eventId: randomUUID(),
      failedAt: now(),
    });
    return report(failed, { created: false, replayed: false });
  }
  const observed = await readLocalRefCommit({
    repositoryRoot: plan.repositoryRoot, ref: plan.mainRef,
  });
  if (observed !== plan.candidateCommit) {
    // The ref does not show the promotion even though the merge reported success: the promotion is
    // not claimed, and a restart reconciles it from the ref rather than guessing.
    const uncertain = input.storage.failStablePromotion({
      promotionId: plan.promotionId,
      outcomeCode: 'MAIN_REF_MOVED',
      detail: `${plan.mainRef} reads ${observed ?? 'a missing ref'} after the fast-forward,`
        + ` not the promoted commit ${plan.candidateCommit}`,
      eventId: randomUUID(),
      failedAt: now(),
    });
    return report(uncertain, { created: false, replayed: false });
  }
  const restarting = input.storage.recordStablePromotionMainUpdate({
    promotionId: plan.promotionId,
    promotedCommit: plan.candidateCommit,
    observedAt: now(),
    eventId: randomUUID(),
  });
  return report(restartPlan(restarting), { created: false, replayed: false });
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
 * the one that moved `main` (so a Runtime that was never stopped cannot pass). The step list must
 * match the recorded plan exactly, and a promotion only succeeds when every step exited 0 and the
 * Runtime answered `status: READY`. `uiRunning` is recorded as an observed fact; the Web UI is an
 * on-demand client (ADR-0007), so it is not a promotion criterion.
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
    state: succeeded ? 'SUCCEEDED' : 'FAILED',
    outcomeCode,
    restart: restartResult(input, input.steps),
    detail,
    eventId: randomUUID(),
    completedEventId: randomUUID(),
    completedAt: now(),
  });
  return report(recorded, { created: false, replayed: false });
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
 * Closes a promotion a restart left unresolved without touching a ref. It is refused for a
 * promotion whose main update is unproven (`PROMOTING`): that one has to be reconciled first, so
 * an unresolved ref is never written off as abandoned.
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
  if (plan.state === 'PROMOTING') {
    throw new PromotionServiceError('PROMOTION_IN_PROGRESS',
      'This promotion may or may not have moved main; let the Runtime reconcile it from the ref'
      + ' before abandoning it');
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
