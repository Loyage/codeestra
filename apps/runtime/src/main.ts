import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { impactPolicyPath, runtimeRequestSchema,
  processViewSchema, serviceViewSchema, signalViewSchema,
  runtimeCommandSummaries,
  validateQuestionnaireAnswer,
  questionnairePromptSchema,
  type RuntimePauseStateView, type RuntimeRequest, type RuntimeResponse,
  type RuntimeStreamFrame } from '@codeestra/contracts';
import { inspectRepository } from '@codeestra/git';
import {
  defaultProseQuestionAttentionMode,
  type ProseQuestionAttentionMode,
} from '@codeestra/domain';
import { Phase1Database, ServiceKernelStore, StorageError, systemServiceIds,
  type AgentAnswerPlan } from '@codeestra/storage';
import {
  createAdapterRegistry,
  piControlledLaunch,
  piSessionDirectory,
} from './adapter-registry.js';
import {
  agentConfigurationPayload,
  agentConfigurationUnsupportedFields,
  resolveAgentConfiguration,
  resolveAgentPlugins,
} from './agent-config-service.js';
import {
  detectAgentPlugins,
  piProviderConfigDirectory,
} from './agent-plugin-detection-service.js';
import { declaredProviderProcessSuspension, declaredPluginSelectionSupport, inspectPiPluginPath } from '@codeestra/agent-adapters';
import { agentPluginKinds, agentPluginSelectionSchema,
  type AgentPluginSelection } from '@codeestra/contracts';
import { AgentRuntimeCoordinator, deriveCommandId } from './agent-runtime-service.js';
import { EventSubscriptionHub, type EventSubscriptionHandle } from './event-subscription-service.js';
import {
  acquireRuntimeOwnership,
  probeRuntimeEndpoint,
  readProcessStartToken,
  releaseRuntimeOwnership,
} from './lifecycle.js';
import {
  assessTaskImpact,
  impactPolicyConfirmation,
  inspectImpactPolicy,
  inspectTaskImpact,
  impactPolicyReport,
  validateImpactPolicy,
} from './impact-analysis-service.js';
import {
  listProjectKnowledge,
  resolveProjectKnowledge,
  showProjectKnowledge,
  validateProjectKnowledge,
} from './knowledge-service.js';
import { recoverTask } from './task-recovery-service.js';
import {
  RuntimeDrainState,
  inspectRuntimeCapacity,
  resetRuntimeCapacity,
  setRuntimeCapacity,
} from './capacity-service.js';
import { RuntimeGlobalControlService, RuntimeControlMutex } from './runtime-control-service.js';
import { ScheduleService } from './schedule-service.js';
import { SlotReservationService } from './slot-reservation-service.js';
import { prepareReservedWorkspace } from './workspace-service.js';
import { LongOperationService } from './operation-service.js';
import { runtimeHome, runtimeSocketPath } from './paths.js';
import { SessionHandoffService } from './session-handoff-service.js';
import { TerminalService } from './terminal-service.js';
import { inspectSettings } from './settings-view.js';
import { defaultPermissionMode, permissionModePath, readPermissionMode, writePermissionMode,
  type PermissionMode } from './permission-mode.js';
import {
  proseQuestionAttentionPath,
  readProseQuestionAttentionMode,
  writeProseQuestionAttentionMode,
} from './prose-question-attention-settings.js';
import {
  applyReclamation,
  applyReclamationBatch,
  listReclamationRecords,
  planReclamation,
  planReclamationBatch,
  reconcileInterruptedReclamations,
  resolveReclaimScope,
} from './reclaim-service.js';
import { captureResultCommit, prepareResultCommit } from './result-commit-service.js';
import {
  assertDependenciesSatisfied,
  inspectTaskDependencies,
  reconcileTaskDependencyState,
} from './scheduler.js';
import { pauseOrCancelTask, resumePausedTask, retryFailedTask } from './task-control-service.js';
import { resolveDeclaredFeatures } from './impact-analysis-service.js';
import { purgeTask } from './task-purge-service.js';
import {
  readSessionTranscript,
  readSessionTranscriptPart,
} from './session-transcript-service.js';
import {
  reconcileInterruptedAgentAnswers,
  reconcileInterruptedAgentStarts,
  reconcileInterruptedResultCommits,
  reconcileInterruptedRunOperations,
  reconcileInterruptedVerifications,
  reconcileSessionHandoffs,
  reconcileSessionTerminals,
  reconcileStaleAgentSessions,
  reconcileWorkspacePreparations,
} from './recovery-service.js';
import { RevisionDeliveryService } from './revision-delivery-service.js';
import { SessionGuidanceService } from './session-guidance-service.js';
import { ServiceContractRegistry, SignalDispatcher, intentionSignalSubtype,
  serviceMetadataSignalSubtype } from './service-kernel.js';
import {
  VerificationRunner,
  inspectVerificationPolicy,
  latestTargetedTestPlanView,
  listTargetedTestPlanViews,
  recordTargetedTestPlan,
} from './verification-service.js';

interface SocketState {
  buffer: string;
  subscription: EventSubscriptionHandle | null;
  /**
   * Bytes the socket has not accepted yet. `end(payload)` only takes what fits in the socket
   * buffer — 8192 bytes on this platform — and then never flushes the rest nor closes, so a
   * client would wait forever for a response that cannot arrive. Larger payloads are queued and
   * flushed as the socket drains.
   */
  pending: Uint8Array | null;
  /** Callers waiting for `pending` to reach the socket. */
  drainWaiters: (() => void)[];
}

const home = runtimeHome();
const socketPath = runtimeSocketPath(home);
/**
 * The only directory a transcript read may read from. It is the same directory the Pi Adapter
 * writes provider session files into, so a recorded path is checked against one owner, not two.
 */
const piSessionDir = piSessionDirectory({ runtimeHome: home, environment: Bun.env });
mkdirSync(home, { recursive: true, mode: 0o700 });
chmodSync(home, 0o700);

/**
 * Identity of this Runtime process. A stable promotion records the boot that moved `main`, and its
 * restart evidence is only accepted from a different boot: that is how "the Runtime was really
 * restarted" is checked instead of assumed from a client's report.
 */
const bootId = crypto.randomUUID();
const startedAt = Date.now();
/**
 * A Runtime owns its home exclusively, and the claim happens before anything is opened.
 *
 * Two starters used to be able to reach the same home at once: both opened the one SQLite file,
 * and both unlinked and rebound `runtime.sock`, so the loser could delete the winner's socket path
 * and leave it alive on an inode nobody could connect to. The lock makes "who owns this home" a
 * single atomic decision: exactly one process gets through, and every other starter either steps
 * aside because the endpoint already answers or reports the owner it found.
 */
const ownership = await acquireRuntimeOwnership({
  home,
  pid: process.pid,
  bootId,
  startedAt,
  argv: Bun.argv.slice(0, 8),
  cwd: process.cwd(),
});
if (!ownership.acquired) {
  // A live owner that cannot be reached is not this process's to replace: the endpoint is the
  // authority, and a second Runtime on one home would mean two writers on one database.
  console.error('[runtime] another Runtime owns this Runtime home',
    `pid=${ownership.owner?.pid ?? 'unknown'}`,
    `bootId=${ownership.owner?.bootId ?? 'unknown'}`,
    `problem=${ownership.problem ?? 'none'}`);
  process.exit(ownership.ownerAlive ? 3 : 4);
}
if (!ownership.bootRecordWritten) {
  console.error('[runtime] this boot could not record its ownership trace', home);
}
// A Runtime started before this ownership record existed can still be serving this home without a
// lock. The endpoint decides: if it answers, this process is a duplicate and steps aside.
if (await probeRuntimeEndpoint(socketPath)) {
  releaseRuntimeOwnership({ home, bootId });
  process.exit(0);
}
// Only now is the socket file known to be a leftover of a Runtime that is not answering.
rmSync(socketPath, { force: true });

// The recorded-vs-default question is answered from the boot read, next to the value it produced:
// `settings.list` must never report a value from one moment and an "explicitly set" flag from
// another. A Runtime that writes the file itself is answering that question with "yes" from here on,
// which is why these two are reassigned by `permission.set` and
// `settings.proseQuestionAttention.set`.
let permissionModeExplicit = existsSync(permissionModePath(home));
let permissionMode: PermissionMode = await readPermissionMode(home);
// The prose-question escalation setting is a downgrade-only switch, so an unreadable file must not
// stop the Runtime from starting: the failure is reported and the product default is used.
let proseQuestionAttentionMode: ProseQuestionAttentionMode = defaultProseQuestionAttentionMode;
let proseQuestionAttentionExplicit = existsSync(proseQuestionAttentionPath(home));
try {
  proseQuestionAttentionMode = await readProseQuestionAttentionMode(home);
} catch (error) {
  console.error('[runtime] the prose-question attention setting could not be read',
    error instanceof Error ? error.message : String(error));
}
/** The settings face reports the current value, the default, and what the value applies to. */
const proseQuestionAttentionSettings = () => ({
  mode: proseQuestionAttentionMode,
  default: defaultProseQuestionAttentionMode,
  appliesTo: 'Agent completions observed after this change; an already recorded wait is unchanged',
});
const storage = new Phase1Database(join(home, 'runtime.sqlite'));
// S2/S3 kernel bootstrap: projections are repaired from the still-authoritative Project/Task/
// Execution rows, then expired Signal claims are reconciled before any command can enqueue more.
const kernelStore = new ServiceKernelStore(storage);
kernelStore.reconcileProjections(Date.now());
const serviceContracts = new ServiceContractRegistry();
const signalDispatcher = new SignalDispatcher({ store: kernelStore, contracts: serviceContracts,
  bootId });
signalDispatcher.dispatchAvailable();
// Event wake-ups call the same bounded dispatcher immediately. This periodic pass is only recovery;
// it is one Runtime timer, never one busy-loop per Service.
const signalReconcileTimer = setInterval(() => {
  try { signalDispatcher.dispatchAvailable(); }
  catch (error) {
    console.error('[runtime] Signal reconcile failed', error instanceof Error ? error.message : String(error));
  }
}, 1_000);
const registry = createAdapterRegistry({ runtimeHome: home, environment: Bun.env });
/**
 * The Runtime global control plane (FOUNDATION-097 / ADR-0061). It is created before anything that
 * can start a provider or deliver to one, because the barrier it publishes has to be observable from
 * the first start of this boot. Its mutex is the section shared with the provider-start paths.
 */
const controlMutex = new RuntimeControlMutex();
// A function declaration, not a `const`: the control service is constructed below and its
// `afterResume` hook has to call the same scheduling/delivery pass the rest of the Runtime uses,
// which is only assembled after it.
let deliverAfterResume: () => Promise<void> = async () => {};
const globalControl = new RuntimeGlobalControlService({
  storage,
  // The Adapter's own declaration, never a probe: a pause must not claim an Adapter is unsupported
  // merely because its provider binary cannot be started at this moment.
  adapterSupport: () => declaredProviderProcessSuspension,
  mutex: controlMutex,
  logger: (message, detail) => console.error(`[runtime] ${message}`, detail ?? ''),
  afterResume: () => deliverAfterResume(),
});
/**
 * The startup read of the persisted barrier (ADR-0061 D07). It happens here — before the reconciles
 * below, before the first scheduling pass and before any Adapter can be started — so a barrier left
 * by an earlier boot is in force from the first instant of this one. Nothing is signalled: a provider
 * a previous boot froze is left exactly as it is, never continued and never killed.
 */
const startupControl = globalControl.startupBarrier();
if (startupControl.blocked) {
  console.error(`[runtime] the global control barrier is ${startupControl.state}`
    + ` (pause epoch ${startupControl.pauseEpoch}, ${startupControl.targetCount} recorded target(s));`
    + ' no scheduling, Agent start or Provider delivery happens until `scheduler control resume`'
    + ' (or `scheduler control reconcile` first, if the recorded identities cannot be verified)');
}
const coordinator = new AgentRuntimeCoordinator({
  storage,
  registry,
  runtimeHome: home,
  // The provider-start path reads the persisted barrier at the instant it is about to spawn, inside
  // the section shared with `scheduler control pause` (ADR-0061 D05 step 1).
  control: globalControl,
  // The Runtime generation that owns a slot reservation may only start its Execution; the
  // scheduling engine passes the same boot id it recorded on the reservation.
  bootId,
  // Configuration is resolved per Execution from the live environment and persisted scopes, so a
  // change applies to the next Agent Session without restarting the Runtime.
  resolveAgentConfig: ({ projectId, adapterId }) => {
    const { effective } = resolveAgentConfiguration({
      storage, adapterId, projectId, environment: Bun.env,
    });
    return Object.keys(effective).length === 0 ? null : effective;
  },
  resolveAgentPlugins: ({ projectId, adapterId }) =>
    resolveAgentPlugins({ storage, adapterId, projectId }),
  permissionMode: () => permissionMode,
  proseQuestionAttentionMode: () => proseQuestionAttentionMode,
  logger: (message, detail) => console.error(`[runtime] ${message}`, detail ?? ''),
});
const subscriptions = new EventSubscriptionHub({ storage });
/**
 * The native terminal transport (ADR-0026): the same controlled launch the RPC adapter uses, except
 * that the provider runs its own terminal UI on a PTY this Runtime owns. It is created before the
 * handoff service, because an admitted takeover starts a terminal.
 */
const launchPaths = piControlledLaunch({ runtimeHome: home, environment: Bun.env });
const terminals = new TerminalService({
  storage,
  // The same provider executable and controlled launch the RPC adapter uses: switching transport
  // must not switch the provider.
  piExecutable: launchPaths.piExecutable,
  piSessionDir: launchPaths.sessionDir,
  gateExtensionPath: launchPaths.gateExtensionPath,
  questionExtensionPath: launchPaths.questionExtensionPath,
  environment: Bun.env,
  permissionMode: () => permissionMode,
  platform: launchPaths.platform,
  resolveAgentConfig: ({ projectId, adapterId }) => {
    const { effective } = resolveAgentConfiguration({
      storage, adapterId, projectId, environment: Bun.env,
    });
    return Object.keys(effective).length === 0 ? null : effective;
  },
  resolveAgentPlugins: ({ projectId, adapterId }) =>
    resolveAgentPlugins({ storage, adapterId, projectId }),
  logger: (message, detail) => console.error(`[runtime] ${message}`, detail ?? ''),
});
/**
 * Runtime side of the Session handoff contract (ADR-0023): the incarnation history, the single
 * writer lease, the handoff fence and the STRICT permission decision channel. It is created before
 * any Agent can start, because a controlled launch connects to its socket during `session_start`.
 */
const handoff = new SessionHandoffService({
  storage,
  runtimeHome: home,
  resolveAdapter: (adapterId) => registry.resolve(adapterId),
  permissionMode: () => permissionMode,
  platform: launchPaths.platform,
  terminal: terminals,
  // The RPC successor of a returned conversation is started by the coordinator that owns provider
  // processes and their event projection; this service only records the resulting incarnation.
  startAutomationSuccessor: (input) => coordinator.startAutomationSuccessor(input),
  releaseAutomationProcess: (input) => coordinator.releaseExecutionProcess(input.executionId),
  releaseAutomationSuccessor: async ({ executionId, reason }) => {
    const released = await coordinator.releaseExecutionProcess(executionId);
    if (!released.released) {
      console.error(`[runtime] ${reason}: the automation successor did not confirm its stop`,
        released.detail);
    }
  },
  logger: (message, detail) => console.error(`[runtime] ${message}`, detail ?? ''),
});
handoff.listen();
/**
 * Task revision delivery (ADR-0028). It owns the delivery ledger, the capability-gated conversation
 * attempt, and the explicit stop-and-restart disposition; scheduling stays with the coordinator.
 */
const revisionDeliveries = new RevisionDeliveryService({
  storage,
  registry,
  coordinator,
  logger: (message, detail) => console.error(`[runtime] ${message}`, detail ?? ''),
});
/**
 * Session Guidance (ADR-0057). It owns the durable guidance ledger, the capability-gated attempt
 * through the provider's own channel, and the artifact each new Execution is launched with. It never
 * touches a Task revision, a Task version or a verification run: guidance is the other input channel
 * (ADR-0010 D02).
 */
const sessionGuidance = new SessionGuidanceService({
  storage,
  registry,
  runtimeHome: home,
  // Guidance recorded while the global barrier is up is durable but not handed over (ADR-0061 D08).
  deliveryAllowed: () => globalControl.deliveryAllowed(),
  logger: (message, detail) => console.error(`[runtime] ${message}`, detail ?? ''),
});
/**
 * Capacity and slot reservations (FOUNDATION-054 / ADR-0032). The drain fact is Runtime-owned: it
 * becomes true when this Runtime starts shutting down and in-memory only, because a persisted
 * "draining" flag would survive a crash and silently refuse every future reservation.
 */
const drain = new RuntimeDrainState();
/**
 * The persistent global control state a capacity query reports alongside its numbers (ADR-0061 D04).
 *
 * The capacity report carries the pause state, and it is read from the one control row the pause half
 * owns (`runtime_pause_control`) — never from a second copy. Both halves were integrated into one
 * schema version and there is one answer to "is the Runtime paused": the control service's. The
 * seam the capacity half left here is filled by that read, so the two halves cannot drift apart.
 */
const globalPauseState = (): RuntimePauseStateView => {
  const control = storage.getRuntimePauseControl();
  // `detail` in the capacity report is one sentence, never the structured control detail: the report
  // says *what* the state is, `scheduler control status` is where the per-target evidence lives.
  return {
    state: control.state,
    pauseEpoch: control.pauseEpoch,
    detail: control.detail === null ? null : summarizePauseDetail(control.detail),
  };
};

/** One readable sentence for the capacity report's `pauseState.detail`; never the raw object. */
function summarizePauseDetail(detail: unknown): string {
  if (typeof detail !== 'object' || detail === null) return 'the Runtime global control state';
  const record = detail as { readonly stage?: unknown; readonly code?: unknown };
  const stage = typeof record.stage === 'string' ? record.stage : null;
  const code = typeof record.code === 'string' ? record.code : null;
  return `${stage === null ? 'global control' : stage}${code === null ? '' : `: ${code}`}`;
}
const slotReservations = new SlotReservationService({
  storage,
  bootId,
  pid: process.pid,
  // The identity of *this* Runtime process, read once. Every reservation records it, and a later
  // generation compares the same token before it believes a recorded holder is gone.
  startToken: await readProcessStartToken(process.pid),
  draining: () => drain.state(),
  // A `reservations acquire` while the host is paused is a wait on the barrier, checked inside the
  // same write transaction that would otherwise grant the slot (ADR-0061 D05 step 1).
  barrier: () => ({ blocked: globalControl.barrier().blocked,
    state: globalControl.barrier().state }),
  logger: (message, detail) => console.error(`[runtime] ${message}`, detail ?? ''),
});
/**
 * The scheduling engine (FOUNDATION-055 / ADR-0030 D04). It composes what already exists — the
 * dependency verdict, the deterministic analyzer and the slot reservation primitive — into the
 * ordered loop of `docs/architecture/scheduler.md` §2, and it is the only thing that decides which
 * Task runs now. It starts exactly one primary Agent per decision, through the coordinator, so the
 * Execution it produces is the same one `task.run` has always produced.
 */
const schedule = new ScheduleService({
  storage,
  adapters: registry,
  slots: slotReservations,
  // An Execution the engine started owns its Session exactly as an explicitly requested one does:
  // the incarnation history and the single writer lease (ADR-0023) are facts about the provider
  // process, and the automatic path produces the same provider process `task.run` does. Recording
  // them only on the explicit paths left every automatically started Session without an incarnation,
  // so a terminal handoff had no predecessor to verify (ADR-0026).
  start: async (request) => {
    const outcome = await coordinator.runScheduledExecution(request);
    if (outcome.sessionId !== null) {
      await handoff.recordAutomationIncarnation({ sessionId: outcome.sessionId });
    }
    return outcome;
  },
  // §4: an execution whose observed diff grew past the prediction its concurrency was allowed on is
  // asked to pause through the existing cooperative stop; a stop that cannot be confirmed becomes
  // RECOVERY_REQUIRED there, with the failure scene retained and nothing integrated.
  pause: async ({ projectId, taskId, reason, actor }) => {
    const task = storage.getTask(projectId, taskId);
    if (task === null) {
      throw new RuntimeCommandError('NOT_FOUND', 'Task was not found in this project');
    }
    const stopped = await pauseOrCancelTask({
      storage,
      coordinator,
      kind: 'PAUSE',
      projectId,
      taskId,
      expectedVersion: task.version,
      commandId: crypto.randomUUID(),
      actor,
    });
    // The reason travels with the outcome so the audit shows *why* the Runtime asked for the pause
    // (an observed diff that grew past the prediction its concurrency was allowed on).
    return { ...stopped, detail: `${stopped.detail} (requested: ${reason})` };
  },
  draining: () => drain.state(),
  // The global barrier is judged before every other reason a Task might not run (ADR-0061 D08).
  control: () => ({ blocked: globalControl.barrier().blocked, state: globalControl.barrier().state }),
  // The Adapter a scheduled start uses when nothing else is said is the same default the CLI has:
  // `pi`, or the first registered Adapter when Pi is not there.
  defaultAdapterId: 'pi',
  logger: (message, detail) => console.error(`[runtime] ${message}`, detail ?? ''),
});
await reconcileWorkspacePreparations({ storage });
reconcileInterruptedAgentStarts({ storage });
reconcileInterruptedAgentAnswers({ storage });
await reconcileInterruptedResultCommits({ storage });
reconcileInterruptedVerifications({ storage });
// A reclamation the Runtime was killed in the middle of is reconciled from the actual filesystem
// state; it never deletes anything, and it leaves what is still there for the next explicit run.
await reconcileInterruptedReclamations({ storage, runtimeHome: home });
// A Session/Execution projection that still says ACTIVE/RUNNING after a restart describes a provider
// process this generation cannot observe, attach to, or claim. It is converged from the recorded
// process-ownership evidence — never into a running state, never by claiming quiescence, and never by
// signalling a process or deleting a worktree. It runs before the handoff reconcile so the audit row
// records the incarnation state as it was at startup.
const staleSessions = await reconcileStaleAgentSessions({
  storage,
  isHeldByThisRuntime: (sessionId) => coordinator.activeSessionIds().includes(sessionId),
  logger: (message, detail) => console.error(`[runtime] ${message}`, detail ?? ''),
});
for (const stale of staleSessions) {
  if (stale.outcome !== 'CONVERGED') continue;
  console.error(`[runtime] stale Agent Session ${stale.sessionId} (${stale.observation}) was`
    + ` converged to ${stale.projectedSessionState}/${stale.projectedExecutionState}`, stale.detail);
}
// The Runtime cannot prove it still holds any provider process or PTY after a restart, so its own
// handoff state is reconciled from that fact instead of being restored optimistically.
reconcileSessionHandoffs({ storage });
// A revision delivery attempt that was in flight when the Runtime went down was never acknowledged;
// it is concluded from that fact instead of being replayed or claimed.
for (const attempt of revisionDeliveries.reconcileAtStartup()) {
  console.error(`[runtime] revision delivery attempt ${attempt.attemptId} was concluded as`
    + ` ${attempt.outcome}`, attempt.detail);
}
// A guidance delivery that was in flight when the Runtime went down observed no channel fact, so it
// is concluded from that fact rather than replayed; the guidance record itself stays recorded and is
// still handed to the next Execution at launch.
for (const attempt of sessionGuidance.reconcileAtStartup()) {
  console.error(`[runtime] session guidance delivery ${attempt.attemptId} was concluded as`
    + ` ${attempt.outcome}`, attempt.detail);
}
// A terminal this Runtime does not hold cannot be attached to or released; the fact is recorded and
// the recorded processes are reported instead of being killed on a guess.
const terminalReconcile = reconcileSessionTerminals({ storage });
for (const terminal of terminalReconcile.maybeStillRunning) {
  console.error('[runtime] a previous terminal generation was not signalled; its recorded processes'
    + ' may still exist', terminal);
}
const verificationRunner = new VerificationRunner();
/** Verification copies live inside the Runtime data directory, never in the user's repo. */
const verificationCopiesRoot = join(home, 'verifications');
// Long commands (task.run / task.verify) are durable Operations: their progress is recorded as
// facts, a cancel stops the owned process group and confirms it, and a restart reconciles them.
const longOperations = new LongOperationService({
  storage,
  runner: verificationRunner,
  coordinator,
  copiesRoot: verificationCopiesRoot,
  permissionMode: () => permissionMode,
  logger: (message, detail) => console.error(`[runtime] ${message}`, detail ?? ''),
});
reconcileInterruptedRunOperations({ storage });
// Appended last on purpose: a slot reservation is judged from the *converged* picture of everything
// else, because other reconciles above may have just projected a Session/Execution as
// RECOVERY_REQUIRED while its slot is still held (that is why a held Execution keeps counting against
// capacity). It changes no existing ordering — the revision delivery reconcile above stays where D1
// deliberately put it, before the handoff and terminal convergence. And it is honest about limits:
// only a holder proven gone is released; an unverifiable one stays occupied as RECOVERY_REQUIRED, and
// no recorded process is signalled.
const slotReconcileReport = await slotReservations.reconcile({
  commandId: bootId,
  actor: 'runtime-startup',
});
for (const outcome of slotReconcileReport.outcomes) {
  if (outcome.outcome === 'SKIPPED_HELD_BY_RUNTIME') continue;
  console.error(`[runtime] slot reservation ${outcome.reservationId} (${outcome.taskId})`
    + ` reconcile: ${outcome.previousState} -> ${outcome.state} (${outcome.outcome},`
    + ` ${outcome.observation ?? 'no observation'})`, outcome.detail);
}
// The scheduling engine's periodic recovery tick (ADR-0030 D04). It is started after every
// reconcile above so its first pass judges the converged picture, and it only ever re-runs the same
// judgements: it introduces no state of its own, and a pass that is already running makes the next
// trigger a no-op instead of two ticks racing for one Task.
const scheduleTickMs = Number(Bun.env.CODEESTRA_SCHEDULE_TICK_MS ?? 5_000);
try {
  const startup = await schedule.tick('STARTUP');
  for (const project of startup.projects) {
    for (const candidate of project.candidates) {
      if (candidate.disposition === 'STARTED' || candidate.disposition === 'FAILED'
        || candidate.disposition === 'WAITING') {
        console.error(`[runtime] schedule ${candidate.disposition} ${candidate.taskId}`
          + ` (${candidate.adapterId}): ${candidate.detail}`);
      }
    }
  }
} catch (error) {
  console.error('[runtime] the startup scheduling pass failed',
    error instanceof Error ? error.message : String(error));
}
schedule.startPeriodicTicks(scheduleTickMs);
/**
 * What `scheduler control resume` does once every target is verified resumed (ADR-0061 D06 step 5):
 * one event-driven scheduling pass, then the deliveries that were durably recorded while the barrier
 * was up. Both are the *existing* idempotent paths — the pass re-runs the same judgements, and each
 * delivery re-reads its own durable record — so a resume cannot start or deliver anything twice.
 */
deliverAfterResume = async () => {
  try {
    await schedule.tick('GLOBAL_RESUME');
  } catch (error) {
    console.error('[runtime] the post-resume scheduling pass failed',
      error instanceof Error ? error.message : String(error));
  }
  for (const result of await coordinator.deliverPendingAnswers()) {
    console.error(`[runtime] post-resume answer ${result.operationId}: ${result.delivery}`
      + `${result.code === null ? '' : ` (${result.code})`}`);
  }
  for (const result of await sessionGuidance.deliverDeferred()) {
    console.error(`[runtime] post-resume guidance ${result.guidanceId}: ${result.outcome}`
      + `${result.code === null ? '' : ` (${result.code})`}`);
  }
};


let listener: ReturnType<typeof Bun.listen<SocketState>>;

function success(requestId: string, result: unknown): RuntimeResponse {
  return { requestId, schemaVersion: 1, ok: true, result };
}

/** Scope and project ID must agree before anything is written; the contract cannot express it. */
function validateAgentConfigurationScope(
  scope: 'GLOBAL' | 'PROJECT',
  projectId: string | null,
): { readonly code: string; readonly message: string } | null {
  if (scope === 'GLOBAL' && projectId !== null) {
    return { code: 'INVALID_AGENT_CONFIGURATION',
      message: 'A global Agent configuration cannot name a project' };
  }
  if (scope === 'PROJECT' && projectId === null) {
    return { code: 'INVALID_AGENT_CONFIGURATION',
      message: 'A project-scoped Agent configuration requires projectId' };
  }
  return null;
}

function failure(requestId: string, code: string, message: string,
  detail?: unknown): RuntimeResponse {
  return { requestId, schemaVersion: 1, ok: false,
    error: { code, message, ...(detail === undefined ? {} : { detail }) } };
}

/** A rejected command carries a stable code so a script can branch on it. */
class RuntimeCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RuntimeCommandError';
  }
}

/**
 * A structured answer is only meaningful for the exact questionnaire that produced the Attention.
 * A `VALUE` answer is left alone: it is the raw-dialog escape hatch used when an Attention is a
 * plain provider question rather than a Codeestra questionnaire. Storage re-checks the pairing.
 */
function assertQuestionnaireAnswerFits(
  request: Extract<RuntimeRequest, { command: 'attention.answer' }>,
): void {
  if (request.answer.type !== 'QUESTIONNAIRE') return;
  const attention = storage.getAttentionRequest(request.projectId, request.attentionId);
  if (attention === null) {
    throw new RuntimeCommandError('NOT_FOUND', 'Open Attention request was not found');
  }
  const prompt = questionnairePromptSchema.safeParse(attention.prompt);
  if (!prompt.success) {
    throw new RuntimeCommandError('NOT_A_QUESTIONNAIRE',
      'This Attention does not carry a Codeestra questionnaire; answer it with a VALUE or CANCEL');
  }
  const problem = validateQuestionnaireAnswer(prompt.data.questionnaire, request.answer.answer);
  if (problem !== null) {
    throw new RuntimeCommandError(`INVALID_QUESTIONNAIRE_ANSWER:${problem.code}`, problem.message);
  }
}

/**
 * One event-driven scheduling pass, summarised. A failing pass never turns the command that triggered
 * it into a failure: that command's own fact is already recorded, the failure is logged with its
 * stable code, and the next trigger (event or the recovery period) re-runs the same judgement.
 */
async function scheduleTick(trigger: string, projectId?: string): Promise<{
  readonly tickId: string;
  readonly trigger: string;
  readonly started: readonly { readonly taskId: string; readonly executionId: string }[];
  readonly waiting: readonly { readonly taskId: string; readonly kind: string;
    readonly code: string }[];
  readonly blocked: readonly string[];
  readonly skipped: readonly { readonly taskId: string; readonly detail: string }[];
  readonly failed: readonly { readonly taskId: string; readonly detail: string }[];
  readonly error: { readonly code: string; readonly message: string } | null;
}> {
  try {
    const report = await schedule.tick(trigger, {
      ...(projectId === undefined ? {} : { projectId }),
    });
    const started: { taskId: string; executionId: string }[] = [];
    const waiting: { taskId: string; kind: string; code: string }[] = [];
    const blocked: string[] = [];
    const skipped: { taskId: string; detail: string }[] = [];
    const failed: { taskId: string; detail: string }[] = [];
    for (const project of report.projects) {
      for (const candidate of project.candidates) {
        if (candidate.disposition === 'STARTED' && candidate.started !== null) {
          started.push({ taskId: candidate.taskId, executionId: candidate.started.executionId });
        } else if (candidate.disposition === 'WAITING' && candidate.wait !== null) {
          waiting.push({ taskId: candidate.taskId, kind: candidate.wait.kind,
            code: candidate.wait.code });
        } else if (candidate.disposition === 'BLOCKED') {
          blocked.push(candidate.taskId);
        } else if (candidate.disposition === 'FAILED') {
          failed.push({ taskId: candidate.taskId, detail: candidate.detail });
        } else if (candidate.disposition === 'SKIPPED') {
          skipped.push({ taskId: candidate.taskId, detail: candidate.detail });
        }
      }
    }
    return { tickId: report.tickId, trigger: report.trigger, started, waiting, blocked, skipped,
      failed, error: null };
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code) : 'SCHEDULE_TICK_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[runtime] scheduling pass ${trigger} failed`, code, message);
    return { tickId: '', trigger, started: [], waiting: [], blocked: [], skipped: [],
      failed: [], error: { code, message } };
  }
}

/**
 * Whether one Adapter declares that it can load exactly the plugins the user selected (ADR-0044).
 * The capability comes from the Adapter itself, never from a table here: Codex and Claude Code say
 * `UNSUPPORTED` and the settings page shows that instead of an empty picker that would do nothing.
 */
/**
 * Whether this build's Adapter for `adapterId` can load exactly the plugins the user selected
 * (ADR-0044 D03). It reads the Adapter's own declaration instead of probing a provider: a projection
 * must not report "unsupported" because a provider binary could not be started right now.
 */
function adapterSupportsPluginSelection(
  registry: ReturnType<typeof createAdapterRegistry>,
  adapterId: string,
): boolean {
  if (!registry.has(adapterId)) return false;
  return declaredPluginSelectionSupport[adapterId] === 'SUPPORTED';
}

/** The first selected path that cannot be loaded, or `null` when every path is usable. */
function firstUnusablePluginPath(
  selection: AgentPluginSelection,
): { readonly kind: string; readonly path: string; readonly reason: string } | null {
  for (const kind of agentPluginKinds) {
    for (const path of selection[kind]) {
      const verdict = inspectPiPluginPath(kind, path);
      if (!verdict.ok) return { kind, path, reason: verdict.reason };
    }
  }
  return null;
}

async function dispatch(request: RuntimeRequest): Promise<RuntimeResponse> {
  switch (request.command) {
    case 'runtime.ping':
      return success(request.requestId, {
        pid: process.pid,
        bootId,
        startedAt,
        status: 'READY',
        permissionMode,
        adapters: registry.ids(),
        activeSessions: coordinator.activeSessionIds(),
        eventSubscribers: subscriptions.subscriberCount(),
      });
    case 'runtime.commands': {
      // The discovery answer of this face (ADR-0068). The list comes from `runtimeRequestSchema`
      // itself, so it can never name a command this switch does not have; the descriptions are a
      // `Record` over the same union, so a new command without one does not compile.
      const commands = runtimeRequestSchema.options
        .map((option) => (option as { shape: { command: { value: RuntimeRequest['command'] } } })
          .shape.command.value)
        .map((name) => runtimeCommandSummaries[name])
        .sort((left, right) => left.group.localeCompare(right.group)
          || left.command.localeCompare(right.command));
      return success(request.requestId, { schemaVersion: 1 as const, commands });
    }
    case 'runtime.stop':
      // The response reports which process was asked to stop, never that it stopped: only the
      // caller can observe the exit, and `codeestra stop` waits for it and reports the fact.
      setTimeout(() => { void shutdown(); }, 10);
      return success(request.requestId, { stopping: true, pid: process.pid, bootId, startedAt });
    case 'permission.get':
      return success(request.requestId, { mode: permissionMode, default: defaultPermissionMode });
    case 'permission.set':
      permissionMode = request.mode;
      writePermissionMode(home, permissionMode);
      permissionModeExplicit = true;
      return success(request.requestId, {
        mode: permissionMode,
        appliesTo: 'new operations and new Agent sessions',
      });
    // The settings face (ADR-0064): one read that enumerates every Runtime-level setting with its
    // effective value, its product default and where the value is stored. Each entry is filled from
    // the same read its own command uses, so the list cannot disagree with `permission.get`,
    // `settings prose-question-attention` or
    // `scheduler capacity get`.
    case 'settings.list':
      return success(request.requestId, inspectSettings({
        runtimeHome: home,
        permissionMode,
        permissionModeExplicit,
        proseQuestionAttention: proseQuestionAttentionSettings(),
        proseQuestionAttentionExplicit,
        storage,
      }));
    case 'settings.proseQuestionAttention.get':
      return success(request.requestId, proseQuestionAttentionSettings());
    case 'settings.proseQuestionAttention.set':
      proseQuestionAttentionMode = request.mode;
      writeProseQuestionAttentionMode(home, proseQuestionAttentionMode);
      proseQuestionAttentionExplicit = true;
      return success(request.requestId, proseQuestionAttentionSettings());
    case 'agent.config.get':
      return success(request.requestId, agentConfigurationPayload(resolveAgentConfiguration({
        storage,
        adapterId: request.adapterId,
        projectId: request.projectId ?? null,
        environment: Bun.env,
      })));
    case 'agent.config.set': {
      const projectId = request.projectId ?? null;
      const invalid = validateAgentConfigurationScope(request.scope, projectId);
      if (invalid !== null) return failure(request.requestId, invalid.code, invalid.message);
      // Refused before anything is written, so a scope can never hold a field this Adapter would
      // have to ignore (ADR-0012: the recorded configuration must be the applied one).
      const unsupported = agentConfigurationUnsupportedFields(request.adapterId);
      const refused = unsupported.find((field) => request[field] !== undefined);
      if (refused !== undefined) {
        return failure(request.requestId, 'INVALID_AGENT_CONFIGURATION',
          `The ${request.adapterId} Adapter does not accept ${refused}; nothing was written`);
      }
      // Plugin selection is parsed with its own strict schema here, so a malformed selection is
      // refused with the capability's stable code and the offending paths, not a generic request
      // error; nothing is written.
      let pluginSelection: AgentPluginSelection | null = null;
      if (request.pluginSelection !== undefined && request.pluginSelection !== null) {
        const parsed = agentPluginSelectionSchema.safeParse(request.pluginSelection);
        if (!parsed.success) {
          return failure(request.requestId, 'INVALID_AGENT_PLUGIN_SELECTION',
            `Invalid Agent plugin selection; nothing was written: ${parsed.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
        }
        pluginSelection = parsed.data;
        // Refused for an Adapter that cannot apply it, instead of being stored and ignored (D03).
        if (!adapterSupportsPluginSelection(registry, request.adapterId)) {
          return failure(request.requestId, 'AGENT_PLUGIN_KIND_UNSUPPORTED',
            `The ${request.adapterId} Adapter does not support plugin selection; nothing was written`);
        }
        // A selected path that cannot be loaded is refused here too, so a scope never holds a
        // selection the Runtime would have to reject at every start (stable code, zero writes).
        const unusable = firstUnusablePluginPath(pluginSelection);
        if (unusable !== null) {
          return failure(request.requestId, 'AGENT_PLUGIN_UNAVAILABLE',
            `The selected ${unusable.kind} path ${JSON.stringify(unusable.path)} cannot be loaded`
            + ` (${unusable.reason}); nothing was written`);
        }
      }
      storage.setAgentConfiguration({
        id: crypto.randomUUID(),
        scope: request.scope,
        projectId,
        adapterId: request.adapterId,
        ...(request.provider === undefined ? {} : { provider: request.provider }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
        ...(request.pluginSelection === undefined ? {} : { pluginSelection }),
        updatedAt: Date.now(),
        // Unlike project trust in FULL mode, changing configuration is always the user's own
        // explicit command, so the actor is the local user in either permission mode.
        updatedBy: 'local-user',
      });
      return success(request.requestId, agentConfigurationPayload(resolveAgentConfiguration({
        storage, adapterId: request.adapterId, projectId, environment: Bun.env,
      })));
    }
    case 'agent.config.clear': {
      const projectId = request.projectId ?? null;
      const invalid = validateAgentConfigurationScope(request.scope, projectId);
      if (invalid !== null) return failure(request.requestId, invalid.code, invalid.message);
      const cleared = storage.clearAgentConfiguration({
        scope: request.scope,
        projectId,
        adapterId: request.adapterId,
      });
      return success(request.requestId, {
        ...agentConfigurationPayload(resolveAgentConfiguration({
          storage, adapterId: request.adapterId, projectId, environment: Bun.env,
        })),
        cleared,
      });
    }
    case 'agent.plugins.list': {
      const projectId = request.projectId ?? null;
      if (!registry.has(request.adapterId)) {
        return failure(request.requestId, 'UNKNOWN_ADAPTER',
          `No Agent Adapter is registered for ${request.adapterId}`);
      }
      const plugins = resolveAgentPlugins({ storage, adapterId: request.adapterId, projectId });
      return success(request.requestId, detectAgentPlugins({
        adapterId: request.adapterId,
        pluginSelectionSupport: adapterSupportsPluginSelection(registry, request.adapterId)
          ? 'SUPPORTED' : 'UNSUPPORTED',
        selection: plugins?.selection ?? null,
        selectionSource: plugins?.source ?? null,
        environment: Bun.env,
        configDirectory: piProviderConfigDirectory(Bun.env),
      }));
    }
    case 'project.inspect': {
      // ADR-0062: what a Task would be based on is this folder's currently checked out branch, so
      // the identity a client reviews and echoes back is the repository identity itself.
      const identity = await inspectRepository(request.path);
      return success(request.requestId, { ...identity });
    }
    case 'project.verificationPolicy': {
      const identity = await inspectRepository(request.path);
      return success(request.requestId, await inspectVerificationPolicy({
        repositoryRoot: identity.repoRoot,
        mainRef: identity.mainRef,
      }));
    }
    // Deterministic conflict analysis (ADR-0031). These three commands observe facts and persist
    // append-only rows; none of them starts, schedules, or approves anything.
    case 'project.impact.validate': {
      return success(request.requestId, await validateImpactPolicy({
        storage, path: request.path,
      }));
    }
    case 'project.impact.show': {
      return success(request.requestId, await inspectTaskImpact({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        now: Date.now(),
      }));
    }
    case 'project.impact.explain': {
      return success(request.requestId, await assessTaskImpact({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        now: Date.now(),
      }));
    }
    // Project Knowledge (FOUNDATION-067 / ADR-0041). Read-only inspection of the layered knowledge:
    // the human layers come from the project `main` ref, the machine layer from the Runtime data
    // directory. Nothing here records a snapshot, materializes a context, or starts a Task —
    // recording happens exactly once, when an Execution is established.
    case 'project.knowledge.validate': {
      return success(request.requestId, await validateProjectKnowledge({
        storage, home, projectId: request.projectId,
      }));
    }
    case 'project.knowledge.list': {
      return success(request.requestId, await listProjectKnowledge({
        storage, home, projectId: request.projectId,
      }));
    }
    case 'project.knowledge.show': {
      return success(request.requestId, showProjectKnowledge({
        storage,
        projectId: request.projectId,
        ...(request.snapshotId === undefined ? {} : { snapshotId: request.snapshotId }),
      }));
    }
    case 'project.knowledge.resolve': {
      return success(request.requestId, await resolveProjectKnowledge({
        storage, home, projectId: request.projectId, taskId: request.taskId,
      }));
    }
    case 'project.list':
      // `confirmedPolicy` is the active ADR-0006 confirmation, so a client can tell whether the
      // policy at the main ref still matches what a human confirmed without re-confirming blindly.
      // `confirmedImpactPolicy` is the same fact for the ADR-0031 impact mapping.
      return success(request.requestId, storage.listTrustedProjects().map((project) => ({
        ...project,
        confirmedPolicy: storage.getConfirmedVerificationPolicy(project.id),
        confirmedImpactPolicy: storage.getConfirmedImpactPolicy(project.id),
      })));
    case 'service.list':
      return success(request.requestId, serviceViewSchema.array().parse(kernelStore.listServices({
        ...(request.kind === undefined ? {} : { kind: request.kind }),
        ...(request.parentServiceId === undefined ? {} : { parentServiceId: request.parentServiceId }),
        includeRetired: request.includeRetired,
      })));
    case 'service.get':
    case 'service.state.get':
      return success(request.requestId, serviceViewSchema.parse(kernelStore.getService(request.serviceId)));
    case 'service.tree':
      return success(request.requestId, serviceViewSchema.array().parse(
        kernelStore.serviceTree(request.serviceId)));
    case 'service.state.set': {
      signalDispatcher.send({ signalId: request.commandId, kind: 'SIG_A',
        subtype: serviceMetadataSignalSubtype, sourceServiceId: null, sourceProcessId: null,
        targetServiceId: request.serviceId, contractVersion: 1,
        payload: { namespace: request.namespace, key: request.key, value: request.value,
          expectedVersion: request.expectedVersion },
        idempotencyKey: request.commandId, correlationId: request.commandId,
        causationId: request.commandId, priority: 0 });
      signalDispatcher.dispatchAvailable();
      const signal = kernelStore.getSignal(request.commandId);
      if (signal.state !== 'ACKED') {
        throw new RuntimeCommandError(signal.lastErrorCode ?? 'SIGNAL_NOT_ACKNOWLEDGED',
          signal.lastErrorMessage ?? `Signal ended in ${signal.state}`);
      }
      return success(request.requestId, { service: serviceViewSchema.parse(
        kernelStore.getService(request.serviceId)), signal: signalViewSchema.parse(signal) });
    }
    case 'process.list':
      return success(request.requestId, processViewSchema.array().parse(kernelStore.listProcesses({
        ...(request.parentServiceId === undefined ? {} : { parentServiceId: request.parentServiceId }),
        ...(request.state === undefined ? {} : { state: request.state }),
      })));
    case 'process.get':
      return success(request.requestId, processViewSchema.parse(kernelStore.getProcess(request.processId)));
    case 'process.input': {
      const process = kernelStore.getProcess(request.processId);
      if (process.executionId === null || process.projectId === null || process.taskId === null) {
        throw new RuntimeCommandError('PROCESS_CONTROL_UNAVAILABLE',
          'This Process has no projected Agent conversation; intention interpretation starts in S6');
      }
      const result = await sessionGuidance.record({ projectId: process.projectId,
        taskId: process.taskId, commandId: request.commandId, message: request.message,
        actor: 'local-user' });
      return success(request.requestId, { process: kernelStore.getProcess(request.processId), input: result });
    }
    case 'process.pause': {
      const process = kernelStore.getProcess(request.processId);
      if (process.projectId === null || process.taskId === null || process.executionId === null) {
        throw new RuntimeCommandError('PROCESS_CONTROL_UNAVAILABLE',
          'Only an Execution-backed Development Process can be paused in S4');
      }
      if (process.controlVersion !== request.expectedControlVersion) {
        throw new RuntimeCommandError('VERSION_CONFLICT', 'Process control version did not match');
      }
      const result = await pauseOrCancelTask({ storage, coordinator, kind: 'PAUSE',
        projectId: process.projectId, taskId: process.taskId,
        expectedVersion: request.expectedControlVersion, commandId: request.commandId,
        actor: 'local-user' });
      kernelStore.reconcileProjections(Date.now());
      return success(request.requestId, { process: kernelStore.getProcess(request.processId), result,
        schedule: await scheduleTick('PROCESS_PAUSED', process.projectId) });
    }
    case 'process.terminate': {
      const process = kernelStore.getProcess(request.processId);
      if (process.projectId === null || process.taskId === null || process.executionId === null) {
        throw new RuntimeCommandError('PROCESS_CONTROL_UNAVAILABLE',
          'Only an Execution-backed Development Process can be terminated in S4');
      }
      if (process.controlVersion !== request.expectedControlVersion) {
        throw new RuntimeCommandError('VERSION_CONFLICT', 'Process control version did not match');
      }
      const result = await pauseOrCancelTask({ storage, coordinator, kind: 'CANCEL',
        projectId: process.projectId, taskId: process.taskId,
        expectedVersion: request.expectedControlVersion, commandId: request.commandId,
        actor: 'local-user' });
      return success(request.requestId, { process: kernelStore.getProcess(request.processId), result,
        schedule: await scheduleTick('PROCESS_TERMINATED', process.projectId) });
    }
    case 'process.resume': {
      const process = kernelStore.getProcess(request.processId);
      if (process.projectId === null || process.taskId === null || process.executionId === null) {
        throw new RuntimeCommandError('PROCESS_CONTROL_UNAVAILABLE',
          'Only an Execution-backed Development Process can be resumed in S4');
      }
      if (process.controlVersion !== request.expectedControlVersion) {
        throw new RuntimeCommandError('VERSION_CONFLICT', 'Process control version did not match');
      }
      await assertDependenciesSatisfied({ storage, projectId: process.projectId, taskId: process.taskId });
      const adapterId = request.adapterId ?? process.adapterId ?? 'pi';
      const gate = await schedule.assertResumeAllowed({ projectId: process.projectId,
        taskId: process.taskId, adapterId, commandId: request.commandId,
        allowUnknown: request.allowUnknown, actor: 'local-user' });
      if (gate.outcome !== 'ALLOWED') {
        throw new RuntimeCommandError(gate.outcome === 'WAIT' ? 'CONFLICT_WAIT' : 'CONFLICTING',
          `The Process stays paused: ${gate.detail}`);
      }
      const result = await resumePausedTask({ storage, coordinator, projectId: process.projectId,
        taskId: process.taskId, expectedVersion: request.expectedControlVersion,
        commandId: request.commandId, adapterId });
      if (result.sessionId !== null) await handoff.recordAutomationIncarnation({ sessionId: result.sessionId });
      kernelStore.reconcileProjections(Date.now());
      const successors = kernelStore.listProcesses({ parentServiceId: process.parentServiceId });
      return success(request.requestId, { predecessor: kernelStore.getProcess(request.processId),
        successor: successors.at(-1) ?? null, result, conflictGate: gate });
    }
    case 'signal.send': {
      const sent = signalDispatcher.send({ signalId: request.commandId, kind: request.kind,
        subtype: request.subtype, sourceServiceId: request.sourceServiceId ?? null,
        sourceProcessId: request.sourceProcessId ?? null, targetServiceId: request.targetServiceId,
        contractVersion: request.contractVersion, payload: request.payload,
        idempotencyKey: request.idempotencyKey,
        correlationId: request.correlationId ?? request.commandId,
        causationId: request.causationId ?? null, priority: request.priority });
      signalDispatcher.dispatchAvailable();
      return success(request.requestId, { created: sent.created,
        signal: signalViewSchema.parse(kernelStore.getSignal(sent.signal.id)) });
    }
    case 'signal.list':
      return success(request.requestId, signalViewSchema.array().parse(kernelStore.listSignals({
        ...(request.targetServiceId === undefined ? {} : { targetServiceId: request.targetServiceId }),
        ...(request.state === undefined ? {} : { state: request.state }),
        ...(request.kind === undefined ? {} : { kind: request.kind }), limit: request.limit,
      })));
    case 'signal.get':
      return success(request.requestId, signalViewSchema.parse(kernelStore.getSignal(request.signalId)));
    case 'signal.retry': {
      kernelStore.retrySignal({ signalId: request.signalId, now: Date.now(),
        eventId: crypto.randomUUID() });
      signalDispatcher.dispatchAvailable();
      return success(request.requestId, signalViewSchema.parse(kernelStore.getSignal(request.signalId)));
    }
    case 'intent.send': {
      const targets = [request.serviceId, request.projectId, request.taskId]
        .filter((value): value is string => value !== undefined);
      if (targets.length > 1) {
        throw new RuntimeCommandError('INTENT_TARGET_AMBIGUOUS',
          'Choose only one of service, project, or task as the intention target');
      }
      const targetServiceId = targets[0] ?? systemServiceIds.root;
      const service = kernelStore.getService(targetServiceId);
      if ((request.projectId !== undefined && service.kind !== 'PROJECT')
        || (request.taskId !== undefined && service.kind !== 'TASK')) {
        throw new RuntimeCommandError('INTENT_TARGET_KIND_MISMATCH',
          `Target ${targetServiceId} is ${service.kind}`);
      }
      const sent = signalDispatcher.send({ signalId: request.commandId, kind: 'SIG_P',
        subtype: intentionSignalSubtype, sourceServiceId: null, sourceProcessId: null,
        targetServiceId, contractVersion: 1,
        payload: { text: request.text, adapterId: request.adapterId },
        idempotencyKey: request.commandId, correlationId: request.commandId,
        causationId: request.commandId, priority: 0 });
      signalDispatcher.dispatchAvailable();
      const signal = kernelStore.getSignal(sent.signal.id);
      if (signal.state !== 'ACKED') {
        throw new RuntimeCommandError(signal.lastErrorCode ?? 'INTENT_NOT_ACCEPTED',
          signal.lastErrorMessage ?? `Intention Signal ended in ${signal.state}`);
      }
      const processId = (signal.receipt?.effect as { processId?: unknown } | null)?.processId;
      return success(request.requestId, { signal: signalViewSchema.parse(signal),
        process: typeof processId === 'string'
          ? processViewSchema.parse(kernelStore.getProcess(processId)) : null,
        interpretation: 'PENDING_S6' });
    }
    case 'events.list': {
      const events = storage.listEventsAfter({
        sinceSequence: request.sinceSequence,
        limit: request.limit,
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
      });
      return success(request.requestId, {
        events,
        // Exclusive cursor for the next read: the last event returned, or the cursor we asked from.
        cursor: events.at(-1)?.sequence ?? request.sinceSequence,
        hasMore: events.length === request.limit,
      });
    }
    case 'events.subscribe':
      // Streaming subscriptions are opened by the connection handler, not by the one-shot
      // dispatcher; reaching here would mean the request was routed incorrectly.
      throw new Error('events.subscribe must be handled as a streaming connection');
    case 'task.list':
      return success(request.requestId, storage.listTasks(request.projectId, {
        includeArchived: request.includeArchived,
      }));
    case 'task.status': {
      const task = storage.getTask(request.projectId, request.taskId);
      if (task === null) throw new StorageError('NOT_FOUND', 'Task was not found');
      return success(request.requestId, {
        task,
        executions: storage.listTaskExecutions(request.projectId, request.taskId),
        verifications: storage.listVerificationRuns(request.projectId, request.taskId),
        // Long-command progress travels with the Task detail so every client gets it in one read
        // the CLI gets from task.operation.list; both are the same projection.
        operations: storage.listTaskOperations(request.projectId, request.taskId),
      });
    }
    case 'task.pause': {
      const paused = await pauseOrCancelTask({
        storage,
        coordinator,
        kind: 'PAUSE',
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        actor: 'local-user',
      });
      // A stop changes the active set (a paused Task keeps its slot, a cancelled one releases it), so
      // the scheduling engine is asked to look again; the answer is reported, not assumed.
      const scheduling = await scheduleTick('TASK_STOPPED', request.projectId);
      return success(request.requestId, { ...paused, schedule: scheduling });
    }
    case 'task.recover': {
      // The reconcile `state-machines.md` promises for `RECOVERY_REQUIRED` (ADR-0055). It only reads
      // facts first: a refusal changes nothing, and only a provably gone provider closes the run.
      const payloadHash = createHash('sha256').update(JSON.stringify({
        command: 'task.recover',
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        reason: request.reason ?? null,
      })).digest('hex');
      const recovery = await recoverTask({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        actor: 'local-user',
        payloadHash,
      });
      if (recovery.outcome === 'REFUSED') {
        // A refusal is a value, not an exception: the observation is the answer, and a script needs
        // the code together with the facts that produced it.
        return success(request.requestId, { ...recovery, schedule: null });
      }
      if (recovery.outcome === 'ALREADY_RECONCILED') {
        return success(request.requestId, { ...recovery, schedule: null });
      }
      // The recoverable set changed, so the engine is asked to look again; the answer is reported.
      const scheduling = await scheduleTick('TASK_RECOVERED', request.projectId);
      return success(request.requestId, { ...recovery, schedule: scheduling });
    }
    case 'task.cancel': {
      const cancelled = await pauseOrCancelTask({
        storage,
        coordinator,
        kind: 'CANCEL',
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        actor: 'local-user',
      });
      const scheduling = await scheduleTick('TASK_CANCELLED', request.projectId);
      return success(request.requestId, { ...cancelled, schedule: scheduling });
    }
    case 'task.resume': {
      // Resuming starts a new Execution in the retained workspace, so it is a start path and honours
      // the same dependency gate. The Task stays PAUSED and nothing is written when it is blocked.
      await assertDependenciesSatisfied({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
      });
      // Resuming is a start path, so it passes the same conflict gate (scheduler.md §4, invariant 11):
      // a resumed Task whose impact cannot be proven disjoint from the active set stays paused. It
      // already holds its slot, so no new capacity is requested for it.
      const gate = await schedule.assertResumeAllowed({
        projectId: request.projectId,
        taskId: request.taskId,
        adapterId: request.adapterId,
        commandId: request.commandId,
        allowUnknown: request.allowUnknown,
        actor: 'local-user',
      });
      if (gate.outcome !== 'ALLOWED') {
        throw new RuntimeCommandError(gate.outcome === 'WAIT' ? 'CONFLICT_WAIT' : 'CONFLICTING',
          `The Task stays paused: ${gate.detail}`);
      }
      const resumed = await resumePausedTask({
        storage,
        coordinator,
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        adapterId: request.adapterId,
      });
      if (resumed.sessionId !== null) {
        await handoff.recordAutomationIncarnation({ sessionId: resumed.sessionId });
      }
      return success(request.requestId, {
        ...resumed,
        conflictGate: { outcome: gate.outcome, assessment: gate.assessment,
          clearedUnknownBy: gate.clearedUnknownBy, detail: gate.detail },
      });
    }
    case 'task.retry': {
      // An explicit retry of a FAILED Task (ADR-0036). The requeue happens first and is durable on
      // its own: it re-derives the dependency verdict and reuses the Task's own verified worktree.
      const retried = await retryFailedTask({
        storage,
        runtimeHome: home,
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        ...(request.adapterId === undefined ? {} : { adapterId: request.adapterId }),
        knownAdapterIds: registry.ids(),
        defaultAdapterId: schedule.resolveAdapterId(undefined),
        actor: 'local-user',
      });
      // The new Execution is *not* created here. The retried Task is handed to the same gate every
      // other start goes through — dependencies, the conflict verdict against every active Task, and
      // capacity — so a retry queues behind other work instead of jumping it. A retry that cannot
      // start now stays READY and is picked up by the next tick; nothing is widened, and the
      // start request uses its own derived command ID so a replayed `task retry` reaches the same
      // receipts instead of colliding with the requeue's own receipt.
      const outcome = await schedule.runNow({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedTaskVersion: retried.retry.version,
        adapterId: retried.retry.adapterId,
        commandId: deriveCommandId(request.commandId, 'retry-start'),
        allowUnknown: false,
        actor: 'local-user',
      });
      if (outcome.sessionId !== null) {
        await handoff.recordAutomationIncarnation({ sessionId: outcome.sessionId });
      }
      return success(request.requestId, {
        projectId: request.projectId,
        taskId: request.taskId,
        state: retried.retry.state,
        version: retried.retry.version,
        retryId: retried.retry.retryId,
        failedExecutionId: retried.retry.failedExecutionId,
        failedAttemptNumber: retried.retry.failedAttemptNumber,
        adapterId: retried.retry.adapterId,
        previousAdapterId: retried.retry.previousAdapterId,
        adapterChanged: retried.retry.adapterChanged,
        adapterSource: retried.adapterSource,
        workspace: retried.workspace,
        dependencyReasons: retried.retry.dependencyReasons,
        start: outcome,
      });
    }
    case 'task.purge': {
      // Permanent deletion (ADR-0058). The only command face that asks for an explicit confirmation
      // bit, and the bit is the caller's own statement, not a permission gate: the Runtime adds no
      // approval step on top of it, and a request without it is refused before anything is read or
      // stopped, so "no" costs nothing.
      if (!request.confirmed) {
        throw new RuntimeCommandError('PURGE_CONFIRMATION_REQUIRED',
          'Permanent deletion requires --yes: it destroys the Task, its revisions, executions,'
          + ' evidence and its worktree/branch. Nothing was read or changed.');
      }
      const purged = await purgeTask({
        storage,
        runtimeHome: home,
        coordinator,
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        // `--force` (ADR-0058 D09) is the caller's own wider statement about this deletion; the
        // Runtime adds no step on top of it and records in the outcome what it stepped over.
        force: request.force,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        actor: 'local-user',
      });
      // The Task is gone, so there is nothing for the scheduler to reconsider; a purge releases no
      // slot through the engine (the rows that held one are deleted) and inventing a tick here would
      // only report an unrelated Task's wait.
      return success(request.requestId, purged);
    }
    case 'task.archive': {
      const payloadHash = createHash('sha256').update(JSON.stringify({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
      })).digest('hex');
      return success(request.requestId, storage.archiveTask({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        payloadHash,
        eventId: crypto.randomUUID(),
        actor: 'local-user',
        archivedAt: Date.now(),
      }));
    }
    case 'task.unarchive': {
      const payloadHash = createHash('sha256').update(JSON.stringify({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
      })).digest('hex');
      return success(request.requestId, storage.unarchiveTask({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        payloadHash,
        eventId: crypto.randomUUID(),
        actor: 'local-user',
        unarchivedAt: Date.now(),
      }));
    }
    case 'task.revision.create':
      // Creating a revision is a specification change, not an execution control: the running Agent is
      // not paused here. What the Agent must know is recorded as a delivery requirement, and an
      // Adapter with no acknowledgement channel leaves it visibly unsatisfied.
      return success(request.requestId, await revisionDeliveries.createRevision({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        ...(request.specification === undefined ? {} : { specification: request.specification }),
        // Validated against the project's mapping like `task create`; absent means "inherit".
        features: request.features === undefined
          ? null
          : await resolveDeclaredFeatures({
            storage, projectId: request.projectId, features: request.features,
          }),
        reason: request.reason,
        actor: 'local-user',
      }));
    case 'task.revision.list':
      return success(request.requestId, {
        revisions: revisionDeliveries.listRevisions(request.projectId, request.taskId),
        deliveries: revisionDeliveries.listDeliveries(request.projectId, request.taskId),
      });
    case 'task.revision.delivery.list':
      return success(request.requestId,
        revisionDeliveries.listDeliveries(request.projectId, request.taskId));
    case 'task.revision.delivery.get':
      return success(request.requestId,
        revisionDeliveries.getDelivery(request.projectId, request.deliveryId));
    case 'task.revision.delivery.resolve': {
      const resolved = await revisionDeliveries.resolveDelivery({
        projectId: request.projectId,
        taskId: request.taskId,
        deliveryId: request.deliveryId,
        action: request.action,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        adapterId: request.adapterId,
        actor: 'local-user',
      });
      // A revision delivery changes what the active set is working on, so the engine looks again.
      return success(request.requestId, {
        ...resolved,
        schedule: await scheduleTick('REVISION_DELIVERY', request.projectId),
      });
    }
    case 'task.verify': {
      // The Operation (and the verification run) exists before any command is spawned, so the
      // background form can return a handle and a cancel or a restart can still find the run.
      const started = await longOperations.startVerification({
        projectId: request.projectId,
        taskId: request.taskId,
        ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
        commandId: request.commandId,
        background: request.background,
        policySource: request.policySource,
      });
      return success(request.requestId, started.background ? started.handle : started.report);
    }
    case 'task.tests.record':
      return success(request.requestId, await recordTargetedTestPlan({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
        ...(request.commit === undefined ? {} : { commit: request.commit }),
        ...(request.expectedPlanDigest === undefined
          ? {} : { expectedPlanDigest: request.expectedPlanDigest }),
      }));
    case 'task.tests.show':
      return success(request.requestId, latestTargetedTestPlanView({
        storage, projectId: request.projectId, taskId: request.taskId,
      }));
    case 'task.tests.history':
      return success(request.requestId, listTargetedTestPlanViews({
        storage, projectId: request.projectId, taskId: request.taskId, limit: request.limit,
      }));
    case 'task.verification.list':
      return success(request.requestId,
        storage.listVerificationRuns(request.projectId, request.taskId));
    case 'task.operation.list':
      return success(request.requestId,
        longOperations.listForTask(request.projectId, request.taskId));
    case 'task.operation.get':
      return success(request.requestId,
        longOperations.get(request.projectId, request.operationId));
    case 'task.operation.cancel':
      return success(request.requestId, await longOperations.cancel({
        projectId: request.projectId,
        taskId: request.taskId,
        operationId: request.operationId,
        commandId: request.commandId,
        actor: 'local-user',
      }));
    // Transcript reads are a view over the provider's own session file. They never write, never
    // change Task/Execution state, and are readable after the Session has long since exited.
    // Session Guidance: the other input channel. Recording guidance is one command, and the delivery
    // fact it produced is written to an append-only ledger; a Task with nothing running keeps the
    // record and hands it to the next Execution instead of pretending it was told. Read commands
    // expose the record, its attempts and the artifact each Execution was launched with.
    case 'session.guidance.record':
      return success(request.requestId, await sessionGuidance.record({
        projectId: request.projectId,
        taskId: request.taskId,
        commandId: request.commandId,
        message: request.message,
        actor: 'local-user',
      }));
    case 'session.guidance.list':
      return success(request.requestId,
        sessionGuidance.list(request.projectId, request.taskId));
    case 'session.guidance.get':
      return success(request.requestId,
        sessionGuidance.get(request.projectId, request.guidanceId));
    case 'session.transcript':
      return success(request.requestId, await readSessionTranscript({
        target: storage.getSessionTranscriptTarget(request.sessionId),
        sessionDir: piSessionDir,
        limit: request.limit,
        ...(request.afterEntryId === undefined ? {} : { afterEntryId: request.afterEntryId }),
      }));
    case 'session.transcript.part':
      return success(request.requestId, await readSessionTranscriptPart({
        target: storage.getSessionTranscriptTarget(request.sessionId),
        sessionDir: piSessionDir,
        entryId: request.entryId,
        partIndex: request.partIndex,
      }));
    case 'task.run': {
      // The start path now goes through the scheduling gate (FOUNDATION-055): the same dependency,
      // conflict and capacity judgements the automatic tick applies, so a start that the scheduler
      // would refuse cannot be smuggled in by asking for it directly. `allowUnknown` is the explicit
      // single-shot release of an UNKNOWN verdict (ADR-0030 D05) — it widens the gate, never adds one.
      const outcome = await schedule.runNow({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedTaskVersion: request.expectedTaskVersion,
        adapterId: request.adapterId,
        commandId: request.commandId,
        allowUnknown: request.allowUnknown,
        actor: 'local-user',
        ...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
      });
      if (outcome.sessionId !== null) {
        // The automation takes the Session's single writer lease as soon as it owns a provider
        // process, from the identity the Adapter already recorded.
        await handoff.recordAutomationIncarnation({ sessionId: outcome.sessionId });
      }
      return success(request.requestId, outcome);
    }
    case 'task.result.prepare':
      return success(request.requestId, await prepareResultCommit({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
        commandId: request.commandId,
        actor: 'local-user',
        permissionMode,
      }));
    case 'task.result.capture': {
      if (permissionMode !== 'FULL') {
        return failure(request.requestId, 'FULL_PERMISSION_REQUIRED',
          'Single-step result capture is available only in FULL permission mode');
      }
      let prepareIndex = 0;
      const prepared = await prepareResultCommit({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
        commandId: deriveCommandId(request.commandId, 'full-result-prepare'),
        actor: 'runtime-full-permission',
        permissionMode,
        randomUUID: () => deriveCommandId(request.commandId, `full-result-prepare-${prepareIndex++}`),
      });
      let captureIndex = 0;
      return success(request.requestId, await captureResultCommit({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        authorizationId: prepared.authorizationId,
        commandId: deriveCommandId(request.commandId, 'full-result-commit'),
        permissionMode,
        randomUUID: () => deriveCommandId(request.commandId, `full-result-commit-${captureIndex++}`),
      }));
    }
    case 'task.result.commit':
      return success(request.requestId, await captureResultCommit({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        authorizationId: request.authorizationId,
        commandId: request.commandId,
        permissionMode,
      }));
    case 'task.depends.add': {
      const payloadHash = createHash('sha256').update(JSON.stringify({
        command: 'task.depends.add',
        projectId: request.projectId,
        taskId: request.taskId,
        prerequisiteTaskId: request.prerequisiteTaskId,
        requiredRevisionId: request.requiredRevisionId ?? null,
      })).digest('hex');
      const mutation = storage.addTaskDependency({
        projectId: request.projectId,
        taskId: request.taskId,
        prerequisiteTaskId: request.prerequisiteTaskId,
        ...(request.requiredRevisionId === undefined
          ? {} : { requiredRevisionId: request.requiredRevisionId }),
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        payloadHash,
        eventId: crypto.randomUUID(),
        actor: 'local-user',
        createdAt: Date.now(),
      });
      // Adding an edge never changes the Task state by itself: the dependency verdict does, and it
      // is computed in the same command so the response is exactly the state the user will observe.
      const reconcile = await reconcileTaskDependencyState({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        commandId: request.commandId,
        actor: 'local-user',
      });
      return success(request.requestId, {
        projectId: request.projectId,
        taskId: request.taskId,
        prerequisiteTaskId: request.prerequisiteTaskId,
        requiredRevisionId: mutation.requiredRevisionId,
        added: mutation.added,
        taskState: reconcile.state,
        taskVersion: reconcile.version,
        dependencyReconcile: reconcile,
        // The same projection `task.depends.list` returns, so a client never has to re-derive the
        // graph from a command result.
        dependencies: await inspectTaskDependencies({
          storage,
          projectId: request.projectId,
          taskId: request.taskId,
        }),
      });
    }
    case 'task.depends.remove': {
      const payloadHash = createHash('sha256').update(JSON.stringify({
        command: 'task.depends.remove',
        projectId: request.projectId,
        taskId: request.taskId,
        prerequisiteTaskId: request.prerequisiteTaskId,
      })).digest('hex');
      const removal = storage.removeTaskDependency({
        projectId: request.projectId,
        taskId: request.taskId,
        prerequisiteTaskId: request.prerequisiteTaskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        payloadHash,
        eventId: crypto.randomUUID(),
        actor: 'local-user',
        removedAt: Date.now(),
      });
      const reconcile = await reconcileTaskDependencyState({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        commandId: request.commandId,
        actor: 'local-user',
      });
      return success(request.requestId, {
        projectId: request.projectId,
        taskId: request.taskId,
        prerequisiteTaskId: request.prerequisiteTaskId,
        removed: removal.removed,
        taskState: reconcile.state,
        taskVersion: reconcile.version,
        dependencyReconcile: reconcile,
        dependencies: await inspectTaskDependencies({
          storage,
          projectId: request.projectId,
          taskId: request.taskId,
        }),
      });
    }
    case 'task.depends.list':
      return success(request.requestId, await inspectTaskDependencies({
        storage,
        projectId: request.projectId,
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      }));
    case 'reclaim.plan': {
      // The scope selector is validated in the service so a missing project cannot silently widen
      // into a batch: `--project` plans one project, everything else is an explicit batch.
      const scope = resolveReclaimScope({
        projectId: request.projectId,
        allProjects: request.allProjects,
        taskId: request.taskId,
      });
      const shared = {
        storage,
        runtimeHome: home,
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
        includeFailureScenes: request.includeFailureScenes,
        unregistered: request.unregistered,
        ...(request.scanRoot === undefined ? {} : { scanRoot: request.scanRoot }),
        ...(request.removeUnregistered === undefined
          ? {} : { removeUnregistered: request.removeUnregistered }),
      };
      return success(request.requestId, scope.kind === 'PROJECT'
        ? await planReclamation({ ...shared, projectId: scope.projectId as string })
        : await planReclamationBatch(shared));
    }
    case 'reclaim.apply': {
      const scope = resolveReclaimScope({
        projectId: request.projectId,
        allProjects: request.allProjects,
        taskId: request.taskId,
      });
      const shared = {
        storage,
        runtimeHome: home,
        commandId: request.commandId,
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
        includeFailureScenes: request.includeFailureScenes,
        unregistered: request.unregistered,
        ...(request.scanRoot === undefined ? {} : { scanRoot: request.scanRoot }),
        ...(request.removeUnregistered === undefined
          ? {} : { removeUnregistered: request.removeUnregistered }),
      };
      return success(request.requestId, scope.kind === 'PROJECT'
        ? await applyReclamation({ ...shared, projectId: scope.projectId as string })
        : await applyReclamationBatch(shared));
    }
    case 'reclaim.records': {
      const scope = resolveReclaimScope({
        projectId: request.projectId,
        allProjects: request.allProjects,
        taskId: request.taskId,
      });
      return success(request.requestId, listReclamationRecords({
        storage,
        ...(scope.kind === 'PROJECT'
          ? { projectId: scope.projectId as string }
          : { projectIds: storage.listTrustedProjects().map((project) => project.id) }),
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        source: request.source,
        ...(request.since === undefined ? {} : { since: request.since }),
        ...(request.until === undefined ? {} : { until: request.until }),
        limit: request.limit,
      }));
    }
    /**
     * The Runtime-wide capacity face (ADR-0061 D01/D02, schema v34). `get` takes no Project and no
     * Adapter: one `CODEESTRA_HOME` is one resource domain, so it reports the single limit, its
     * source, the Runtime-wide occupancy with every occupier, and the stable wait reason a new
     * acquisition would get. `set` writes that limit and `reset` removes the explicit value so the
     * documented default applies again; both are zero-confirmation and idempotent, and neither
     * releases, pauses or terminates a Task that already holds a slot. A changed limit triggers an
     * event-driven scheduling pass for **every** Project, because a global limit can unblock a
     * candidate anywhere. The reservation commands are unchanged: a reservation still belongs to a
     * Task/Project, only the capacity judgement is Runtime-wide.
     */
    case 'scheduler.capacity.get':
      return success(request.requestId, inspectRuntimeCapacity({
        storage,
        draining: drain.state(),
        pauseState: globalPauseState,
      }));
    case 'scheduler.capacity.set': {
      const mutation = setRuntimeCapacity({
        storage,
        limit: request.limit,
        actor: 'local-user',
        commandId: request.commandId,
        draining: drain.state(),
        pauseState: globalPauseState,
      });
      return success(request.requestId, { changed: mutation.changed, capacity: mutation.view,
        schedule: await scheduleTick('CAPACITY_CHANGED') });
    }
    case 'scheduler.capacity.reset': {
      const mutation = resetRuntimeCapacity({
        storage,
        actor: 'local-user',
        commandId: request.commandId,
        draining: drain.state(),
        pauseState: globalPauseState,
      });
      return success(request.requestId, { changed: mutation.changed, capacity: mutation.view,
        schedule: await scheduleTick('CAPACITY_CHANGED') });
    }
    case 'scheduler.reservations.list':
      return success(request.requestId, {
        projectId: request.projectId,
        reservations: slotReservations.list({
          projectId: request.projectId,
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
          includeReleased: request.includeReleased,
          ...(request.limit === undefined ? {} : { limit: request.limit }),
        }),
      });
    case 'scheduler.reservations.get':
      return success(request.requestId,
        slotReservations.get(request.projectId, request.reservationId));
    case 'scheduler.reservations.acquire':
      return success(request.requestId, await slotReservations.acquire({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedTaskVersion: request.expectedTaskVersion,
        revisionId: request.revisionId,
        adapterId: request.adapterId,
        actor: 'local-user',
        commandId: request.commandId,
        ...(request.impactSnapshotId === undefined
          ? {} : { impactSnapshotId: request.impactSnapshotId }),
      }));
    case 'scheduler.reservations.release': {
      const released = await slotReservations.release({
        projectId: request.projectId,
        reservationId: request.reservationId,
        reason: request.reason,
        actor: 'local-user',
        commandId: request.commandId,
      });
      // A freed slot is an eligibility change: the engine looks again in the same command.
      return success(request.requestId, {
        ...released,
        schedule: released.released
          ? await scheduleTick('SLOT_RELEASED', request.projectId)
          : null,
      });
    }
    case 'scheduler.reservations.workspace.prepare':
      return success(request.requestId, {
        workspace: await prepareReservedWorkspace({
          storage,
          runtimeHome: home,
          bootId,
          commandId: request.commandId,
          projectId: request.projectId,
          reservationId: request.reservationId,
          expectedTaskVersion: request.expectedTaskVersion,
          actor: 'local-user',
        }),
      });
    case 'scheduler.reservations.reconcile': {
      const report = await slotReservations.reconcile({
        projectId: request.projectId,
        commandId: request.commandId,
        actor: 'local-user',
      });
      return success(request.requestId, report);
    }
    /**
     * The scheduling engine's command face (FOUNDATION-055). `status` and `plan` are read-only
     * (`plan` is the ordered dry run: it reserves nothing and starts nothing), `explain` answers why
     * one Task is not running now, `run` requests a pass of the same loop the Runtime runs on events
     * and on its recovery period, and `clearUnknown` records an explicit single-shot release with no
     * start. None of them adds a confirmation step.
     */
    case 'task.schedule.status':
      return success(request.requestId, await schedule.status(request.projectId, request.adapterId));
    case 'task.schedule.plan':
      return success(request.requestId, await schedule.plan(request.projectId, request.adapterId));
    case 'task.schedule.explain':
      return success(request.requestId, await schedule.explain({
        projectId: request.projectId,
        taskId: request.taskId,
        ...(request.adapterId === undefined ? {} : { adapterId: request.adapterId }),
      }));
    case 'task.schedule.run':
      return success(request.requestId, await schedule.tick('REQUESTED', {
        projectId: request.projectId,
        ...(request.adapterId === undefined ? {} : { adapterId: request.adapterId }),
      }));
    case 'task.schedule.clearUnknown':
      return success(request.requestId, await schedule.clearUnknown({
        projectId: request.projectId,
        taskId: request.taskId,
        commandId: request.commandId,
        actor: 'local-user',
      }));
    /**
     * Runtime global load control (FOUNDATION-097 / ADR-0061 D09). These four commands belong to no
     * Project: the barrier they touch is host-wide, so none of them takes a `projectId`.
     *
     * `status` and `reconcile` only observe and record. `pause`/`resume` are the explicit user
     * command themselves — zero confirmation in FULL and STRICT, exactly one state transition each,
     * and a partial result is returned as a *refusal* with its own stable code (exit 1), never as a
     * tidy `PAUSED`.
     */
    case 'scheduler.control.status':
      return success(request.requestId, globalControl.status());
    case 'scheduler.control.pause': {
      const outcome = await globalControl.pause({
        commandId: request.commandId, actor: 'local-user',
      });
      if (outcome.code !== null) {
        // The state and its event are already recorded; the refusal is reported as a failure so a
        // script sees a non-zero exit and the stable code, not a success with a warning inside.
        throw new RuntimeCommandError(outcome.code, outcome.detail);
      }
      return success(request.requestId, outcome.view);
    }
    case 'scheduler.control.resume': {
      const outcome = await globalControl.resume({
        commandId: request.commandId, actor: 'local-user',
      });
      if (outcome.code !== null) {
        throw new RuntimeCommandError(outcome.code, outcome.detail);
      }
      return success(request.requestId, outcome.view);
    }
    case 'scheduler.control.reconcile':
      return success(request.requestId, (await globalControl.reconcile({ actor: 'local-user' })).view);
    case 'attention.list':
      return success(request.requestId, storage.listAttentionRequests(request.projectId));
    case 'attention.answer': {
      assertQuestionnaireAnswerFits(request);
      // A STRICT permission that arrived over the Runtime side channel is decided on that channel:
      // the provider emitted no dialog this Runtime could answer, so routing it through the
      // Adapter would report a delivery about a request that does not exist.
      if (handoff.isPermissionAttention(request.attentionId)) {
        return success(request.requestId, await handoff.answerPermission({
          projectId: request.projectId,
          attentionId: request.attentionId,
          commandId: request.commandId,
          answer: request.answer,
          actor: 'local-user',
        }));
      }
      const payloadHash = createHash('sha256').update(JSON.stringify({
        projectId: request.projectId,
        attentionId: request.attentionId,
        answer: request.answer,
      })).digest('hex');
      const planned: AgentAnswerPlan = storage.planAttentionAnswer({
        projectId: request.projectId,
        attentionId: request.attentionId,
        commandId: request.commandId,
        payloadHash,
        intentId: crypto.randomUUID(),
        answerId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        answer: request.answer,
        intentEventId: crypto.randomUUID(),
        recordedEventId: crypto.randomUUID(),
        actor: 'local-user',
        recordedAt: Date.now(),
      });
      const delivery = await coordinator.deliverAnswer(planned.operationId);
      return success(request.requestId, {
        attentionId: planned.id,
        answerId: planned.answerId,
        operationId: planned.operationId,
        operationState: delivery.plan.operationState,
        status: delivery.plan.status,
        delivery: delivery.delivery,
        ...(delivery.error === undefined ? {} : { error: delivery.error }),
      });
    }
    case 'attention.resolve': {
      // A prose question is a wait, not a dialog: the provider process already exited, so there is
      // nothing to deliver and no conversation to resume. The command records how the wait ended
      // and puts the Task back where it was, which is the only honest end state (FOUNDATION-069).
      const payloadHash = createHash('sha256').update(JSON.stringify({
        projectId: request.projectId,
        attentionId: request.attentionId,
        resolution: request.resolution,
        text: request.text ?? null,
        note: request.note ?? null,
      })).digest('hex');
      return success(request.requestId, storage.resolveProseQuestionAttention({
        projectId: request.projectId,
        attentionId: request.attentionId,
        commandId: request.commandId,
        payloadHash,
        resolution: request.resolution,
        text: request.text ?? null,
        note: request.note ?? null,
        actor: 'local-user',
        answerId: crypto.randomUUID(),
        resolutionEventId: crypto.randomUUID(),
        taskEventId: crypto.randomUUID(),
        resolvedAt: Date.now(),
      }));
    }
    case 'session.handoff.status':
      return success(request.requestId,
        handoff.status({ projectId: request.projectId, sessionId: request.sessionId }));
    case 'session.handoff.request':
      return success(request.requestId, handoff.requestHandoff({
        projectId: request.projectId,
        sessionId: request.sessionId,
        kind: request.kind,
        commandId: request.commandId,
      }));
    case 'session.handoff.cancel':
      return success(request.requestId,
        handoff.cancelHandoff({ projectId: request.projectId, sessionId: request.sessionId }));
    case 'session.handoff.writer.acquire':
      return success(request.requestId, handoff.acquireWriterLease({
        projectId: request.projectId,
        sessionId: request.sessionId,
        holderKind: request.holderKind,
        holderRef: request.holderRef,
        commandId: request.commandId,
      }));
    case 'session.handoff.writer.release':
      return success(request.requestId, handoff.releaseWriterLease({
        projectId: request.projectId,
        sessionId: request.sessionId,
        holderRef: request.holderRef,
      }));
    case 'session.handoff.admit':
      return success(request.requestId, await handoff.admitSuccessor({
        projectId: request.projectId,
        sessionId: request.sessionId,
        commandId: request.commandId,
      }));
    case 'session.handoff.attach':
      return success(request.requestId, handoff.attachTerminal({
        projectId: request.projectId,
        sessionId: request.sessionId,
        commandId: request.commandId,
        holderRef: request.holderRef,
        ...(request.kind === undefined ? {} : { kind: request.kind }),
        ...(request.since === undefined ? {} : { since: request.since }),
      }));
    case 'session.handoff.detach':
      return success(request.requestId, handoff.detachTerminal({
        projectId: request.projectId,
        sessionId: request.sessionId,
        holderRef: request.holderRef,
        ...(request.since === undefined ? {} : { since: request.since }),
      }));
    case 'session.handoff.release':
      return success(request.requestId, await handoff.releaseTerminal({
        projectId: request.projectId,
        sessionId: request.sessionId,
        commandId: request.commandId,
        ...(request.resumeAutomation === undefined
          ? {} : { resumeAutomation: request.resumeAutomation }),
      }));
    case 'session.handoff.terminal.read':
      return success(request.requestId, handoff.readTerminal({
        projectId: request.projectId,
        sessionId: request.sessionId,
        ...(request.since === undefined ? {} : { since: request.since }),
      }));
    case 'session.handoff.terminal.write':
      return success(request.requestId, handoff.writeTerminal({
        sessionId: request.sessionId,
        data: Buffer.from(request.dataBase64, 'base64').toString('utf8'),
      }));
    case 'session.handoff.terminal.resize':
      return success(request.requestId, await handoff.resizeTerminal({
        projectId: request.projectId,
        sessionId: request.sessionId,
        cols: request.cols,
        rows: request.rows,
        ...(request.holderRef === undefined ? {} : { holderRef: request.holderRef }),
      }));
    case 'task.submit': {
      const payloadHash = createHash('sha256').update(JSON.stringify({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
      })).digest('hex');
      const submitted = storage.submitTask({
        projectId: request.projectId,
        taskId: request.taskId,
        expectedVersion: request.expectedVersion,
        commandId: request.commandId,
        payloadHash,
        eventId: crypto.randomUUID(),
        actor: 'local-user',
        submittedAt: Date.now(),
      });
      // Submitting records the specification-valid transition (DRAFT → READY); the dependency gate is
      // enforced immediately afterwards in the same command, so a Task whose upstream has not reached
      // `dev` is never observably READY and can never be scheduled (§2.5, state-machines §1).
      const dependencies = await reconcileTaskDependencyState({
        storage,
        projectId: request.projectId,
        taskId: request.taskId,
        commandId: request.commandId,
        actor: 'local-user',
      });
      // Submitting enters scheduling in the same command: the candidate takes part in the next tick,
      // and the tick runs here so the user does not have to push anything (ADR-0030 D04). Failure of
      // the *submission* is never reported from the scheduling pass, which is a separate fact.
      const scheduling = await scheduleTick('SUBMIT', request.projectId);
      return success(request.requestId, {
        ...submitted,
        state: dependencies.state,
        version: dependencies.version,
        dependencyState: dependencies,
        schedule: scheduling,
      });
    }
    case 'task.create': {
      // Declared features are validated before anything is written (ADR-0059 D03): an id that the
      // project's mapping does not declare is a refusal with its own code, not a stored string that a
      // later judgment would have to guess about.
      const features = await resolveDeclaredFeatures({
        storage, projectId: request.projectId, features: request.features,
      });
      const payloadHash = createHash('sha256').update(JSON.stringify({
        projectId: request.projectId,
        displayTitle: request.displayTitle,
        namingTitle: request.namingTitle,
        specification: request.specification,
        features,
      })).digest('hex');
      return success(request.requestId, storage.createTask({
        projectId: request.projectId,
        commandId: request.commandId,
        payloadHash,
        intentId: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
        revisionId: crypto.randomUUID(),
        intentEventId: crypto.randomUUID(),
        taskEventId: crypto.randomUUID(),
        displayTitle: request.displayTitle,
        namingTitle: request.namingTitle,
        specification: request.specification,
        features,
        actor: 'local-user',
        createdAt: Date.now(),
      }));
    }
    case 'project.trust': {
      const identity = await inspectRepository(request.path);
      // ADR-0062: every Task baseline is read from this folder's checked out branch at preparation
      // time, so trust pins the repository identity and the two committed policies — nothing else.
      const actual = { ...identity };
      if (JSON.stringify(actual) !== JSON.stringify(request.expectedIdentity)) {
        return failure(request.requestId, 'REPOSITORY_CHANGED', 'Repository identity changed after confirmation');
      }
      const policy = await inspectVerificationPolicy({
        repositoryRoot: actual.repoRoot,
        mainRef: actual.mainRef,
      });
      const expected = request.expectedVerificationPolicy;
      const policyMatches = policy.state === expected.state
        && policy.mainCommit === expected.mainCommit
        && (expected.state !== 'PRESENT' || policy.digest === expected.digest);
      if (!policyMatches) {
        return failure(request.requestId, 'VERIFICATION_POLICY_CHANGED',
          'The verification policy at the main ref changed after confirmation; inspect it again');
      }
      // The impact mapping is confirmed by the same trust event as the verification policy: in FULL
      // mode that is zero user steps, and in STRICT it is the same single confirmation the user is
      // already giving, now covering both policies (ADR-0031). A client that pinned the mapping it
      // inspected (the CLI does) is refused if the file moved in between.
      const impactPolicy = await inspectImpactPolicy({
        repositoryRoot: actual.repoRoot,
        mainRef: actual.mainRef,
      });
      if (request.expectedImpactPolicy !== undefined) {
        const expectedImpact = request.expectedImpactPolicy;
        const impactMatches = impactPolicy.state === expectedImpact.state
          && impactPolicy.mainCommit === expectedImpact.mainCommit
          && (expectedImpact.state !== 'PRESENT' || impactPolicy.digest === expectedImpact.digest)
          && (expectedImpact.state !== 'INVALID'
            || impactPolicy.contentDigest === expectedImpact.contentDigest);
        if (!impactMatches) {
          return failure(request.requestId, 'IMPACT_POLICY_CHANGED',
            `${impactPolicyPath} at the main ref changed after it was inspected; inspect it again`);
        }
      }
      const now = Date.now();
      storage.trustProject({
        id: crypto.randomUUID(),
        trustId: crypto.randomUUID(),
        name: basename(actual.repoRoot),
        repoRoot: actual.repoRoot,
        gitCommonDir: actual.gitCommonDir,
        mainRef: actual.mainRef,
        objectFormat: actual.objectFormat,
        policyVersion: 1,
        verificationPolicyConfirmationId: crypto.randomUUID(),
        verificationPolicy: policy.state === 'PRESENT'
          ? { state: 'PRESENT', digest: policy.digest as string, mainRef: actual.mainRef,
              mainCommit: policy.mainCommit }
          : { state: 'ABSENT', digest: null, mainRef: actual.mainRef,
              mainCommit: policy.mainCommit },
        impactPolicyConfirmationId: crypto.randomUUID(),
        impactPolicy: impactPolicyConfirmation(impactPolicy),
        trustedAt: now,
        actor: permissionMode === 'FULL' ? 'runtime-full-permission' : 'local-user',
      });
      return success(request.requestId, {
        trusted: true,
        permissionMode,
        repository: identity,
        verificationPolicy: policy,
        impactPolicy: impactPolicyReport({ inspection: impactPolicy, confirmation: null }),
      });
    }
  }
}

/**
 * Opens a streaming subscription instead of a one-shot response. The connection stays open until
 * the client disconnects, the cursor is rejected, or the Runtime stops.
 */
function openSubscription(
  socket: Bun.Socket<SocketState>,
  request: Extract<RuntimeRequest, { command: 'events.subscribe' }>,
): void {
  let ended = false;
  const send = (frame: RuntimeStreamFrame): boolean => {
    if (ended) return false;
    const line = `${JSON.stringify(frame)}\n`;
    try {
      // A terminal frame is flushed as part of the close: a bare write followed by end() can
      // lose the frame, and the client would then never learn why the subscription stopped.
      if (frame.type === 'error') {
        ended = true;
        void sendAndClose(socket, line);
        return false;
      }
      return queueWrite(socket, line);
    } catch {
      return false;
    }
  };
  const handle = subscriptions.subscribe({
    requestId: request.requestId,
    ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
    ...(request.sinceSequence === undefined ? {} : { sinceSequence: request.sinceSequence }),
    send,
    // Flush whatever is still queued before closing, so a slow reader never loses a frame.
    onStop: () => { if (!ended) { ended = true; void sendAndClose(socket, ''); } },
  });
  // A rejected cursor was already reported as a terminal frame; the socket is closing.
  if (!handle.active) return;
  socket.data.subscription = handle;
}

async function handleLine(socket: Bun.Socket<SocketState>, line: string): Promise<void> {
  let requestId = 'unknown';
  try {
    const raw: unknown = JSON.parse(line);
    if (typeof raw === 'object' && raw !== null && 'requestId' in raw && typeof raw.requestId === 'string') {
      requestId = raw.requestId;
    }
    const request = runtimeRequestSchema.parse(raw);
    if (request.command === 'events.subscribe') {
      openSubscription(socket, request);
      return;
    }
    await sendAndClose(socket, `${JSON.stringify(await dispatch(request))}\n`);
  } catch (error) {
    // Domain, storage, Git, registry, and Adapter errors all carry a stable code; a
    // transport or system error without one is reported as an invalid request.
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'string' && error.code.length > 0
      ? error.code
      : 'INVALID_REQUEST';
    const message = error instanceof Error ? error.message : 'Unknown Runtime error';
    // A refusal whose code cannot carry its facts (a stale snapshot generation names the components
    // that moved) passes them through as a structured detail; a client renders them, so a script
    // never has to parse the sentence above.
    const detail = typeof error === 'object' && error !== null && 'detail' in error
      ? error.detail : undefined;
    await sendAndClose(socket, `${JSON.stringify(failure(requestId, code, message, detail ?? undefined))}\n`);
  }
}

/** Writes queued bytes until the socket stops accepting them. */
function flushPending(socket: Bun.Socket<SocketState>): void {
  const state = socket.data;
  while (state.pending !== null && state.pending.byteLength > 0) {
    let written = 0;
    try {
      written = socket.write(state.pending);
    } catch {
      state.pending = null;
      break;
    }
    if (written <= 0) return;
    state.pending = written >= state.pending.byteLength
      ? null : state.pending.subarray(written);
  }
  for (const waiter of state.drainWaiters.splice(0)) waiter();
}

/** Queues one whole frame and reports whether the socket already accepted all of it. */
function queueWrite(socket: Bun.Socket<SocketState>, text: string): boolean {
  const state = socket.data;
  const bytes = Buffer.from(text, 'utf8');
  if (state.pending === null) {
    let written = 0;
    try {
      written = socket.write(bytes);
    } catch {
      return false;
    }
    if (written >= bytes.byteLength) return true;
    state.pending = bytes.subarray(Math.max(written, 0));
    return false;
  }
  state.pending = Buffer.concat([state.pending, bytes]);
  return false;
}

/** Writes every queued byte and only then closes, so no response is lost on the way out. */
async function sendAndClose(socket: Bun.Socket<SocketState>, text: string): Promise<void> {
  if (text.length > 0) queueWrite(socket, text);
  let guard = 0;
  while (socket.data.pending !== null && guard < 10_000) {
    guard += 1;
    await new Promise<void>((resolveDrain) => { socket.data.drainWaiters.push(resolveDrain); });
    flushPending(socket);
  }
  socket.end();
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Draining starts before anything else is torn down: the socket may still deliver a request that
  // was already in flight, and a reservation must not be granted by a Runtime that is stopping.
  drain.begin('RUNTIME_SHUTDOWN');
  schedule.stopPeriodicTicks();
  clearInterval(signalReconcileTimer);
  listener.stop(true);
  subscriptions.close();
  // Terminals this Runtime owns are ended first, while the database is still open: the recorded
  // fact is then STOPPED instead of a stale RUNNING row that the next start could only report as
  // RECOVERY_REQUIRED. `handoff.close()` below repeats the same best-effort stop, which is a no-op
  // once this one has run; a hard kill is still covered by the PTY host's own rule that a closed
  // control pipe means "no writer owns this terminal".
  await terminals.close();
  handoff.close();
  // Signal first: an in-flight long command stops at its next step boundary without writing a
  // verdict, so a restart cannot turn a killed command into a judged failure.
  longOperations.beginShutdown();
  try {
    await coordinator.close();
  } catch (error) {
    console.error('[runtime] shutdown could not release every Agent Session',
      error instanceof Error ? error.message : String(error));
  }
  try {
    await verificationRunner.close();
  } catch (error) {
    console.error('[runtime] shutdown could not stop every verification command',
      error instanceof Error ? error.message : String(error));
  }
  if (verificationRunner.unconfirmedStops.length > 0) {
    console.error('[runtime] verification commands did not confirm their stop',
      verificationRunner.unconfirmedStops.join(','));
  }
  // The jobs were already told to stop before their command groups were killed, so none of them
  // writes a verdict on the way down: the next start records RUNTIME_RESTARTED from the facts.
  await longOperations.close();
  storage.close();
  rmSync(socketPath, { force: true });
  // Ownership is released last: "this home is free" must only become true once everything else has
  // been released, so a starter that still sees the lock keeps waiting instead of opening a second
  // connection to the same database.
  releaseRuntimeOwnership({ home, bootId });
  // Ordered shutdown is complete. Anything still holding the event loop is a library timer whose
  // own work has already finished (Bun keeps the loop alive for a pending `Bun.sleep`, and every
  // bounded grace in a subsystem is written that way), so the process ends here instead of staying
  // alive as an unreachable Runtime that no client can stop. A provider process or verification
  // command that could not be confirmed stopped is the one thing that must not be exited over: it
  // is logged, projected as recovery-required, and this process stays observable so a client can
  // report that the stop did not complete.
  const unconfirmed = [
    ...coordinator.activeSessionIds().map((sessionId) => `session ${sessionId}`),
    ...verificationRunner.unconfirmedStops.map((pid) => `verification command ${pid}`),
  ];
  if (unconfirmed.length === 0) {
    process.exit(0);
  }
  console.error('[runtime] shutdown could not confirm every owned process stopped;'
    + ' not exiting so the state stays observable', unconfirmed.join(', '));
}

listener = Bun.listen<SocketState>({
  unix: socketPath,
  socket: {
    open(socket) {
      socket.data = { buffer: '', subscription: null, pending: null, drainWaiters: [] };
    },
    drain(socket) { flushPending(socket); },
    data(socket, bytes) {
      if (socket.data.subscription !== null) {
        // One command per connection: a subscriber must not smuggle a second request in.
        socket.end();
        return;
      }
      socket.data.buffer += new TextDecoder().decode(bytes);
      const newline = socket.data.buffer.indexOf('\n');
      if (newline === -1) {
        if (socket.data.buffer.length > 1_000_000) socket.end();
        return;
      }
      const line = socket.data.buffer.slice(0, newline);
      socket.data.buffer = socket.data.buffer.slice(newline + 1);
      void handleLine(socket, line);
    },
    close(socket) { socket.data.subscription?.close(); },
    error() {},
  },
});
chmodSync(socketPath, 0o600);
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
