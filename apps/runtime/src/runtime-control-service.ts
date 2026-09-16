import {
  type AdapterSupport,
  type RuntimeGlobalControlCode,
  type RuntimeGlobalControlState,
  type RuntimeGlobalControlView,
  type RuntimePauseTargetObservation,
  type RuntimePauseTargetView,
} from '@codeestra/contracts';
import {
  type ActiveProviderIncarnation,
  type Phase1Database,
  type RuntimeCommandReceiptInput,
  type RuntimePauseTargetRecord,
  type RuntimePauseTargetState,
  type RuntimePauseTargetUpdate,
} from '@codeestra/storage';
import { readProcessStartToken as readRuntimeProcessStartToken } from './lifecycle.js';

/**
 * Runtime global load control (FOUNDATION-097 / ADR-0061 D04–D10).
 *
 * This service owns one thing: the persisted, host-wide barrier and the per-incarnation process
 * freeze it publishes. It deliberately does **not** know anything about Task state. A frozen Task is
 * still `RUNNING`, still holds its Execution, its workspace and its capacity slot; whether the
 * controller reports `PAUSED` is a statement about processes, never about Tasks (ADR-0061 D04).
 *
 * Three rules shape the whole file:
 *
 * 1. **The barrier comes first.** `pause` persists `PAUSING` and the fixed target list before it
 *    looks at a single process. Every start path in the Runtime reads that row, so "no new provider
 *    after this commit" is a fact rather than a race. The last line of defence is the check the
 *    coordinator makes immediately before it spawns a provider.
 * 2. **Verification, not intent.** A target is only `STOPPED` when the recorded `pid + start token`
 *    still matches the live process *and* that process reads back as stopped. Sending `SIGSTOP`,
 *    merely seeing a PID, or seeing a quiet stdout prove nothing (ADR-0061 D05 step 4).
 * 3. **Fail closed, and keep the barrier.** An unreadable identity, a platform without POSIX
 *    stop/continue, or an Adapter that has not declared `providerProcessSuspension: SUPPORTED` means
 *    the epoch settles `RECOVERY_REQUIRED` with the frozen targets left frozen. A tidy `PAUSED` is
 *    never bought by guessing (ADR-0061 D05 step 5/D09).
 *
 * It never signals a tool subprocess: the only signal any code path here sends is to the single
 * recorded provider main process, and only after its identity has been re-verified.
 */

/** A refused global control command. The code is one of the stable ADR-0061 D09 codes. */
export class RuntimeControlError extends Error {
  constructor(
    readonly code: RuntimeGlobalControlCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'RuntimeControlError';
  }
}

/** What the OS says about one process. `EXITED` means "not in the process table at all". */
export interface ProviderProcessObservation {
  readonly pid: number;
  /** Read back from the live process right now; null when it could not be read. */
  readonly startToken: string | null;
  readonly state: 'RUNNING' | 'STOPPED' | 'EXITED' | 'UNKNOWN';
}

/**
 * The OS control layer, behind an interface so tests can drive it deterministically — and so the
 * platform gate is a *value* the service reads rather than an assumption baked into `process.kill`.
 */
export interface RuntimeProcessControl {
  readonly platform: string;
  readonly posix: boolean;
  observe(pid: number): Promise<ProviderProcessObservation>;
  signal(pid: number, signal: 'SIGSTOP' | 'SIGCONT'): Promise<void>;
}

/**
 * The real implementation.
 *
 * `ps -o stat=` is used on both Linux and darwin: it is the one interface that answers "is this
 * process currently stopped?" without reading provider-owned state, and a stopped process reports
 * `T`. `ps -o lstart=` (through `readProcessStartToken`) is the project's existing identity token, so
 * this reuses it instead of inventing a second notion of "the same process".
 *
 * An empty `stat` answer means the pid is not in the table — that is the only way this reports
 * `EXITED`. A pid whose token cannot be read while it *does* exist reports `UNKNOWN`, which callers
 * must treat as "cannot verify" rather than as "gone".
 */
export function systemProcessControl(platform = process.platform): RuntimeProcessControl {
  return {
    platform,
    posix: platform !== 'win32',
    async observe(pid: number): Promise<ProviderProcessObservation> {
      if (!Number.isInteger(pid) || pid <= 0) {
        return { pid, startToken: null, state: 'UNKNOWN' };
      }
      const stat = await readPsField(pid, 'stat');
      if (stat === null) return { pid, startToken: null, state: 'EXITED' };
      const startToken = await readRuntimeProcessStartToken(pid);
      // A zombie is not a running process: it holds no pipes and cannot issue a model request. It is
      // reported as exited rather than as running-but-mysterious.
      const stopped = /^[Tt]/.test(stat.trim());
      const zombie = stat.trim().startsWith('Z');
      return {
        pid,
        startToken,
        state: zombie ? 'EXITED' : stopped ? 'STOPPED' : 'RUNNING',
      };
    },
    async signal(pid: number, signal: 'SIGSTOP' | 'SIGCONT'): Promise<void> {
      process.kill(pid, signal);
    },
  };
}

async function readPsField(pid: number, field: string): Promise<string | null> {
  try {
    const child = Bun.spawn(['ps', '-o', `${field}=`, '-p', String(pid)], {
      stdout: 'pipe', stderr: 'ignore',
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    if (exitCode !== 0) return null;
    const value = stdout.trim();
    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

/**
 * A serialising section shared by the global control commands and the provider-start paths.
 *
 * The barrier itself is durable, so this is not what makes the guarantee true — the row does. What
 * this closes is the window inside one Runtime: a start that already read `RUNNING` must finish
 * launching (or be refused) before the barrier commit, and a `pause` must not commit between a
 * start's check and its spawn. Holding one lock across both makes those two orderings the only ones
 * that exist.
 */
export class RuntimeControlMutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(operation, operation);
    // The chain must not keep a rejected result around, or every later section would reject too.
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface RuntimeGlobalControlOptions {
  readonly storage: Phase1Database;
  /**
   * The `providerProcessSuspension` each registered Adapter declares, by adapter id. It is a read of
   * the Adapter's own declaration, never a probe: a pause must not claim an Adapter is unsupported
   * merely because its provider binary could not be started right now.
   */
  readonly adapterSupport: () => Readonly<Record<string, AdapterSupport>>;
  readonly control?: RuntimeProcessControl;
  readonly mutex?: RuntimeControlMutex;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly logger?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  /**
   * Run once after a resume settles `RUNNING`: the event-driven scheduling pass, and the delivery of
   * answers/guidance that were durably recorded while the barrier was up (ADR-0061 D06 step 5). A
   * failure here is reported and does not undo the resume — the barrier really is down.
   */
  readonly afterResume?: () => Promise<void> | void;
}

/** The result of one global control command: the view plus the code it must be reported with. */
export interface RuntimeGlobalControlOutcome {
  readonly view: RuntimeGlobalControlView;
  /** Null when the command reached a complete, stable state (CLI exit 0). */
  readonly code: RuntimeGlobalControlCode | null;
  readonly detail: string;
}

export class RuntimeGlobalControlService {
  readonly #storage: Phase1Database;
  readonly #adapterSupport: () => Readonly<Record<string, AdapterSupport>>;
  readonly #control: RuntimeProcessControl;
  readonly #mutex: RuntimeControlMutex;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #logger: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  readonly #afterResume: (() => Promise<void> | void) | null;

  constructor(options: RuntimeGlobalControlOptions) {
    this.#storage = options.storage;
    this.#adapterSupport = options.adapterSupport;
    this.#control = options.control ?? systemProcessControl();
    this.#mutex = options.mutex ?? new RuntimeControlMutex();
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#logger = options.logger ?? (() => {});
    this.#afterResume = options.afterResume ?? null;
  }

  /** The shared section. Provider-start paths take it so a start and a barrier never interleave. */
  get mutex(): RuntimeControlMutex {
    return this.#mutex;
  }

  /**
   * The barrier as every start/delivery path reads it: `RUNNING` means go, anything else means wait.
   * It is one indexed read of a singleton row, and it is the value — not a cached copy — so a start
   * that begins after a barrier commit can never see `RUNNING`.
   */
  barrier(): { readonly blocked: boolean; readonly state: RuntimeGlobalControlState;
    readonly code: 'SCHEDULER_GLOBALLY_PAUSED' | null } {
    const state = this.#storage.getRuntimePauseControl().state;
    return state === 'RUNNING'
      ? { blocked: false, state, code: null }
      : { blocked: true, state, code: 'SCHEDULER_GLOBALLY_PAUSED' };
  }

  /**
   * The check a provider-start path makes. Throwing (rather than returning) is deliberate: every
   * caller already has a failure path that records nothing and releases what it reserved, so a start
   * refused here leaves no Execution claiming to run.
   */
  assertStartAllowed(): void {
    const barrier = this.barrier();
    if (!barrier.blocked) return;
    throw new RuntimeControlError('SCHEDULER_GLOBALLY_PAUSED',
      `The Runtime is globally ${barrier.state}, so no new Agent Session may start;`
      + ' run `scheduler control status` and, when the freeze is settled, `scheduler control resume`');
  }

  /** Same fact, for the delivery paths that record instead of throwing (a deferred answer). */
  deliveryAllowed(): boolean {
    return !this.barrier().blocked;
  }

  status(): RuntimeGlobalControlView {
    return this.#view(this.#storage.getRuntimePauseControl().state, null);
  }

  /**
   * `scheduler control pause` (ADR-0061 D05). Steps, in this order:
   *
   * 1. Replay the receipt of this command id, if it has one.
   * 2. Commit the barrier: `PAUSING`, a new (or the in-flight) pause epoch, and the identity snapshot
   *    of every active provider incarnation.
   * 3. Per target, re-verify `pid + start token` against the live process; the Adapter must declare
   *    `providerProcessSuspension: SUPPORTED` and the platform must have POSIX stop semantics.
   * 4. Only then send `SIGSTOP` to the provider main process — never to a tool subprocess — and read
   *    the process back. `STOPPED` is written only from that second read.
   * 5. Settle `PAUSED` only when every target is `STOPPED` or provably `EXITED`; otherwise
   *    `RECOVERY_REQUIRED`, leaving already-frozen targets frozen.
   */
  async pause(input: { readonly commandId: string; readonly actor: string }):
  Promise<RuntimeGlobalControlOutcome> {
    const payloadHash = hashOf({ command: 'scheduler.control.pause', actor: input.actor });
    return await this.#mutex.run(async () => {
      const replay = this.#storage.findRuntimeCommandReceipt({
        commandId: input.commandId, payloadHash,
      });
      if (replay !== null) return replay.result as RuntimeGlobalControlOutcome;

      const at = this.#now();
      let control = this.#storage.getRuntimePauseControl();
      if (control.state === 'RESUMING') {
        throw new RuntimeControlError('GLOBAL_CONTROL_IN_PROGRESS',
          'A resume is still in flight; read `scheduler control status` before requesting another'
          + ' state change');
      }
      const unrecordable: UnrecordableTarget[] = [];
      if (control.state === 'RUNNING') {
        const epoch = control.pauseEpoch + 1;
        const snapshot = this.#snapshotTargets(unrecordable);
        this.#storage.beginRuntimeGlobalPause({
          commandId: input.commandId,
          payloadHash,
          actor: input.actor,
          epoch,
          targets: snapshot,
          eventId: this.#randomUUID(),
          occurredAt: at,
        });
        control = this.#storage.getRuntimePauseControl();
      }
      // A `pause` that arrives while this epoch is still being frozen (or after a partial failure)
      // continues *that* epoch: a second epoch would forget which processes the first one froze.
      const epoch = control.pauseEpoch;
      const targets = this.#storage.listRuntimePauseTargets(epoch);
      const updates: RuntimePauseTargetUpdate[] = [];
      for (const target of targets) {
        updates.push(await this.#freezeTarget(target, at, unrecordable));
      }
      // `PAUSED` is only ever written from this conjunction: every target is verified stopped or
      // proven exited, and nothing was left unrecordable. Any other combination is a partial freeze,
      // and a partial freeze is `RECOVERY_REQUIRED` (ADR-0061 D04/D05 step 5).
      const complete = unrecordable.length === 0
        && updates.every((update) => update.state === 'STOPPED' || update.state === 'EXITED');
      const outcome = complete ? 'PAUSED' as const : 'RECOVERY_REQUIRED' as const;
      const code = complete ? null : this.#failureCode(updates, unrecordable);
      const detail = {
        stage: 'PAUSE',
        code,
        platform: this.#control.platform,
        platformSupported: this.#control.posix,
        unverifiableTargets: unrecordable,
        targets: updates.map((update) => ({
          targetId: update.targetId, state: update.state, observation: update.observation,
        })),
      };
      const view = await this.#settlePause({
        epoch,
        outcome,
        detail,
        updates,
        code,
        input,
        payloadHash,
        at,
      });
      return { view, code, detail: describeOutcome(outcome, code) };
    });
  }

  /**
   * `scheduler control resume` (ADR-0061 D06). Only `PAUSED` and a disposible `RECOVERY_REQUIRED`
   * may enter `RESUMING`, and only the epoch's own targets are touched: each one is re-verified
   * against `pid + start token` before `SIGCONT`, so a pid that was reused is never woken. A target
   * proven exited is not resurrected — its Session/Execution convergence belongs to the existing
   * recovery path.
   */
  async resume(input: { readonly commandId: string; readonly actor: string }):
  Promise<RuntimeGlobalControlOutcome> {
    const payloadHash = hashOf({ command: 'scheduler.control.resume', actor: input.actor });
    const settled = await this.#mutex.run(async () => {
      const replay = this.#storage.findRuntimeCommandReceipt({
        commandId: input.commandId, payloadHash,
      });
      if (replay !== null) {
        return { result: replay.result as RuntimeGlobalControlOutcome, resumed: false as const };
      }

      const at = this.#now();
      const control = this.#storage.getRuntimePauseControl();
      if (control.state === 'RUNNING') {
        const result: RuntimeGlobalControlOutcome = {
          view: this.#view('RUNNING', null),
          code: null,
          detail: 'the Runtime is already RUNNING; nothing was signalled',
        };
        this.#storage.writeRuntimeCommandReceipt(
          this.#receipt(input, payloadHash, result), at);
        return { result, resumed: false as const };
      }
      if (control.state === 'PAUSING' || control.state === 'RESUMING') {
        throw new RuntimeControlError('GLOBAL_CONTROL_IN_PROGRESS',
          `The Runtime is ${control.state}; only a settled PAUSED or RECOVERY_REQUIRED state can be`
          + ' continued');
      }
      const epoch = control.pauseEpoch;
      const started = this.#storage.beginRuntimeGlobalResume({
        epoch,
        actor: input.actor,
        commandId: input.commandId,
        eventId: this.#randomUUID(),
        occurredAt: at,
      });
      const updates: RuntimePauseTargetUpdate[] = [];
      const unrecordable: UnrecordableTarget[] = [];
      let changedTarget = false;
      for (const target of started.targets) {
        const result = await this.#continueTarget(target, at);
        if (result.changed) changedTarget = true;
        if (result.unrecordable !== null) unrecordable.push(result.unrecordable);
        updates.push(result.update);
      }
      const allResolved = updates.every((update) =>
        update.state === 'RESUMED' || update.state === 'EXITED');
      const outcome = allResolved ? 'RUNNING' as const : 'RECOVERY_REQUIRED' as const;
      const code = allResolved ? null : this.#resumeFailureCode(updates, unrecordable, changedTarget);
      const detail = {
        stage: 'RESUME',
        code,
        unverifiableTargets: unrecordable,
        targets: updates.map((update) => ({
          targetId: update.targetId, state: update.state, observation: update.observation,
        })),
      };
      const settled = this.#storage.settleRuntimeGlobalResume({
        epoch,
        outcome,
        detail,
        targetUpdates: updates,
        commandId: input.commandId,
        actor: input.actor,
        eventId: this.#randomUUID(),
        occurredAt: this.#now(),
      });
      const view = this.#view(settled.control.state, code);
      const result: RuntimeGlobalControlOutcome = {
        view, code, detail: describeOutcome(outcome, code),
      };
      this.#storage.writeRuntimeCommandReceipt(
        this.#receipt(input, payloadHash, result), this.#now());
      return { result, resumed: outcome === 'RUNNING' as const };
    });
    if (settled.resumed && this.#afterResume !== null) {
      // The barrier is down, and this runs **after** the control section is released on purpose: the
      // scheduling pass starts providers through the coordinator, which takes the same section, and
      // holding it here would deadlock against itself. A failure is reported without pretending the
      // resume did not happen — the state really is `RUNNING`.
      try {
        await this.#afterResume();
      } catch (error) {
        this.#logger('the post-resume scheduling pass failed', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return settled.result;
  }

  /**
   * `scheduler control reconcile` (ADR-0061 D07/D09). Read-only with respect to processes: it never
   * sends `SIGSTOP`, `SIGCONT` or a termination signal. It records what it observed, closes the
   * targets that are provably gone, and may settle a still-`PAUSING` epoch from those observations.
   * It never promotes `RECOVERY_REQUIRED` to `PAUSED`: that is the whole point of the state.
   */
  async reconcile(input: { readonly actor: string }): Promise<RuntimeGlobalControlOutcome> {
    return await this.#mutex.run(async () => {
      const at = this.#now();
      const control = this.#storage.getRuntimePauseControl();
      const targets = this.#storage.listRuntimePauseTargets(control.pauseEpoch);
      const updates: RuntimePauseTargetUpdate[] = [];
      let closedTarget = false;
      for (const target of targets) {
        const observation = await this.#observeTarget(target, at, null);
        const state = reconcileTargetState(target.state, observation);
        if (state !== target.state) closedTarget = true;
        updates.push({ targetId: target.id, state, observation });
      }
      const anyUnverifiable = updates.some((update) =>
        (update.observation as RuntimePauseTargetObservation).code
          === 'GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE');
      const allResolved = updates.every((update) =>
        update.state === 'STOPPED' || update.state === 'EXITED');
      const outcome: 'UNCHANGED' | 'PAUSED' | 'RECOVERY_REQUIRED' = control.state === 'PAUSING'
        ? anyUnverifiable ? 'RECOVERY_REQUIRED' : allResolved ? 'PAUSED' : 'RECOVERY_REQUIRED'
        : 'UNCHANGED';
      const detail = {
        stage: 'STARTUP_RECONCILE',
        platform: this.#control.platform,
        targets: updates.map((update) => ({
          targetId: update.targetId, state: update.state, observation: update.observation,
        })),
      };
      const settled = this.#storage.recordRuntimeGlobalReconcile({
        epoch: control.pauseEpoch,
        targetUpdates: updates,
        outcome,
        detail,
        actor: input.actor,
        // An observation that changed nothing writes no event: the five global events describe facts
        // that happened, and "reconcile looked and everything was as it was" is not a recovery.
        recordEvent: outcome === 'RECOVERY_REQUIRED' || closedTarget,
        eventId: this.#randomUUID(),
        occurredAt: at,
      });
      const view = this.#view(settled.control.state, null);
      return {
        view,
        code: null,
        detail: `observed ${targets.length} target(s); the global state is ${view.state}`,
      };
    });
  }

  /**
   * The startup read (ADR-0061 D07). The Runtime calls this before its first scheduler tick, its
   * first Adapter start and its first delivery, so a barrier persisted by an earlier boot is in force
   * from the first instant of this one. It signals nothing: a provider a previous boot froze is left
   * exactly as it is — not continued, not killed.
   */
  startupBarrier(): { readonly blocked: boolean; readonly state: RuntimeGlobalControlState;
    readonly pauseEpoch: number; readonly targetCount: number } {
    const control = this.#storage.getRuntimePauseControl();
    return {
      blocked: control.state !== 'RUNNING',
      state: control.state,
      pauseEpoch: control.pauseEpoch,
      targetCount: this.#storage.listRuntimePauseTargets(control.pauseEpoch).length,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  /**
   * The identity snapshot the barrier fixes. A Session whose recorded incarnation has no `pid` or no
   * start token cannot be recorded as a target at all — the table requires a real identity, and
   * inventing one would be worse than admitting the gap — so it is reported separately and makes the
   * epoch settle `RECOVERY_REQUIRED`.
   */
  #snapshotTargets(
    unrecordable: UnrecordableTarget[],
  ): readonly {
    readonly id: string; readonly projectId: string; readonly taskId: string;
    readonly executionId: string; readonly sessionId: string; readonly incarnationId: string;
    readonly providerPid: number; readonly providerStartToken: string; readonly observation: unknown;
  }[] {
    const active = this.#storage.listActiveProviderIncarnations();
    const support = this.#adapterSupport();
    const snapshot = [];
    for (const incarnation of active) {
      const identity = processIdentityOf(incarnation);
      if (identity === null) {
        unrecordable.push({
          projectId: incarnation.projectId,
          taskId: incarnation.taskId,
          executionId: incarnation.executionId,
          sessionId: incarnation.sessionId,
          incarnationId: incarnation.incarnationId,
          adapterId: incarnation.adapterId,
          reason: 'the recorded provider incarnation has no readable pid + start token, so its'
            + ' identity cannot be verified and no signal may be sent to it',
        });
        continue;
      }
      snapshot.push({
        id: this.#randomUUID(),
        projectId: incarnation.projectId,
        taskId: incarnation.taskId,
        executionId: incarnation.executionId,
        sessionId: incarnation.sessionId,
        incarnationId: incarnation.incarnationId,
        providerPid: identity.pid,
        providerStartToken: identity.startToken,
        observation: {
          code: 'PENDING',
          detail: 'the barrier was committed; no process has been observed yet',
          observedAt: this.#now(),
          startToken: null,
          identityMatched: false,
          processState: 'UNKNOWN',
          adapterSupport: support[incarnation.adapterId] ?? 'ADAPTER_NOT_REGISTERED',
          adapterId: incarnation.adapterId,
        } satisfies RuntimePauseTargetObservation & { readonly adapterId: string },
      });
    }
    return snapshot;
  }

  async #freezeTarget(
    target: RuntimePauseTargetRecord,
    at: number,
    unrecordable: UnrecordableTarget[],
  ): Promise<RuntimePauseTargetUpdate> {
    if (!this.#control.posix) {
      // No POSIX stop/continue semantics: the design says `GLOBAL_PAUSE_UNSUPPORTED`, and it must
      // not be downgraded into "the scheduler is paused but the panel says PAUSED".
      return this.#update(target, 'RECOVERY_REQUIRED',
        await this.#observeTarget(target, at, 'GLOBAL_PAUSE_UNSUPPORTED'));
    }
    const support = this.#adapterSupportFor(target, unrecordable);
    if (support !== null && support !== 'SUPPORTED') {
      return this.#update(target, 'RECOVERY_REQUIRED',
        await this.#observeTarget(target, at, 'GLOBAL_PAUSE_UNSUPPORTED', support));
    }
    const before = await this.#observeTarget(target, at, null, support ?? undefined);
    if (before.code === 'EXITED') return this.#update(target, 'EXITED', before);
    if (!before.identityMatched) {
      return this.#update(target, 'RECOVERY_REQUIRED',
        await this.#observeTarget(target, at, 'GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE',
          support ?? undefined));
    }
    try {
      await this.#control.signal(target.providerPid, 'SIGSTOP');
    } catch (error) {
      return this.#update(target, 'RECOVERY_REQUIRED',
        await this.#observeTarget(target, at, 'GLOBAL_PAUSE_TARGET_NOT_STOPPED',
          support ?? undefined, error instanceof Error ? error.message : String(error)));
    }
    // The signal's acceptance is not evidence. Only this second read is.
    const after = await this.#observeTarget(target, at, null, support ?? undefined);
    if (after.processState !== 'STOPPED' || !after.identityMatched) {
      return this.#update(target, 'RECOVERY_REQUIRED',
        await this.#observeTarget(target, at, 'GLOBAL_PAUSE_TARGET_NOT_STOPPED',
          support ?? undefined,
          `after SIGSTOP the process read back as ${after.processState}`
          + `${after.identityMatched ? '' : ' with an unmatched identity'}`));
    }
    return this.#update(target, 'STOPPED', after);
  }

  async #continueTarget(
    target: RuntimePauseTargetRecord,
    at: number,
  ): Promise<{ readonly update: RuntimePauseTargetUpdate; readonly changed: boolean;
    readonly unrecordable: UnrecordableTarget | null }> {
    if (target.state === 'RESUMED' || target.state === 'EXITED') {
      return {
        update: this.#update(target, target.state, await this.#observeTarget(target, at, null)),
        changed: false,
        unrecordable: null,
      };
    }
    if (!this.#control.posix) {
      return {
        update: this.#update(target, 'RECOVERY_REQUIRED',
          await this.#observeTarget(target, at, 'GLOBAL_PAUSE_UNSUPPORTED')),
        changed: false,
        unrecordable: null,
      };
    }
    const before = await this.#observeTarget(target, at, null);
    if (before.code === 'EXITED') {
      // A target that exited while the barrier was up is not resurrected. Its Task/Execution are
      // reconciled by the existing Session/Execution path, which is the only thing that may write
      // those states.
      return { update: this.#update(target, 'EXITED', before), changed: false, unrecordable: null };
    }
    if (!before.identityMatched) {
      const detail = before.startToken === null
        ? 'the recorded process could not be read, so no SIGCONT was sent'
        : 'the pid now belongs to a different process (a different start token), so no SIGCONT was'
          + ' sent';
      return {
        update: this.#update(target, 'RECOVERY_REQUIRED',
          await this.#observeTarget(target, at, 'GLOBAL_RESUME_TARGET_CHANGED', undefined, detail)),
        changed: false,
        unrecordable: null,
      };
    }
    if (before.processState === 'RUNNING') {
      // Already running again (for example an explicit `task recover` continued it): the fact is
      // recorded instead of a second signal being sent.
      return { update: this.#update(target, 'RESUMED', { ...before, code: 'RESUMED' }),
        changed: false, unrecordable: null };
    }
    if (before.processState !== 'STOPPED') {
      return {
        update: this.#update(target, 'RECOVERY_REQUIRED',
          await this.#observeTarget(target, at, 'GLOBAL_RESUME_TARGET_CHANGED', undefined,
            `the process read back as ${before.processState}, which is not a stopped main process`)),
        changed: false,
        unrecordable: null,
      };
    }
    try {
      await this.#control.signal(target.providerPid, 'SIGCONT');
    } catch (error) {
      return {
        update: this.#update(target, 'RECOVERY_REQUIRED',
          await this.#observeTarget(target, at, 'GLOBAL_RESUME_TARGET_CHANGED', undefined,
            `SIGCONT failed: ${error instanceof Error ? error.message : String(error)}`)),
        changed: false,
        unrecordable: null,
      };
    }
    const after = await this.#observeTarget(target, at, null);
    if (after.processState !== 'RUNNING' || !after.identityMatched) {
      return {
        update: this.#update(target, 'RECOVERY_REQUIRED',
          await this.#observeTarget(target, at, 'GLOBAL_RESUME_TARGET_CHANGED', undefined,
            `after SIGCONT the process read back as ${after.processState}`)),
        changed: false,
        unrecordable: null,
      };
    }
    return { update: this.#update(target, 'RESUMED', { ...after, code: 'RESUMED' }),
      changed: true, unrecordable: null };
  }

  async #observeTarget(
    target: RuntimePauseTargetRecord,
    at: number,
    code: RuntimePauseTargetObservation['code'] | null,
    adapterSupport?: AdapterSupport | 'ADAPTER_NOT_REGISTERED',
    detailOverride?: string,
  ): Promise<RuntimePauseTargetObservation> {
    const support = adapterSupport
      ?? this.#adapterSupport()[adapterIdOf(target.observation) ?? ''] ?? 'ADAPTER_NOT_REGISTERED';
    const observed = await this.#control.observe(target.providerPid);
    const identityMatched = observed.startToken !== null
      && observed.startToken === target.providerStartToken;
    // The observation's own code names what this read concluded. A verified stop is `STOPPED`, not
    // `PENDING`: a target read back as running (or freshly snapshotted) is the only `PENDING`.
    const derived: RuntimePauseTargetObservation['code'] = code ?? (
      observed.state === 'EXITED' ? 'EXITED'
        : !identityMatched ? 'GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE'
          : observed.state === 'STOPPED' ? 'STOPPED'
            : 'PENDING');
    return {
      code: derived,
      detail: detailOverride ?? describeObservation(target, observed, identityMatched),
      observedAt: at,
      startToken: observed.startToken,
      identityMatched,
      processState: observed.state,
      adapterSupport: support,
    };
  }

  #adapterSupportFor(
    target: RuntimePauseTargetRecord,
    unrecordable: UnrecordableTarget[],
  ): AdapterSupport | 'ADAPTER_NOT_REGISTERED' | null {
    const adapterId = adapterIdOf(target.observation);
    if (adapterId === null) return null;
    const support = this.#adapterSupport()[adapterId];
    if (support === undefined) {
      unrecordable.push({
        projectId: target.projectId,
        taskId: target.taskId,
        executionId: target.executionId,
        sessionId: target.sessionId,
        incarnationId: target.incarnationId,
        adapterId,
        reason: 'this Adapter is not registered in this Runtime, so its provider-process ownership'
          + ' cannot be verified and no signal may be sent to it',
      });
      return 'ADAPTER_NOT_REGISTERED';
    }
    return support;
  }

  #update(
    target: RuntimePauseTargetRecord,
    state: RuntimePauseTargetState,
    observation: RuntimePauseTargetObservation,
  ): RuntimePauseTargetUpdate {
    return { targetId: target.id, state, observation };
  }

  #failureCode(
    updates: readonly RuntimePauseTargetUpdate[],
    unrecordable: readonly UnrecordableTarget[],
  ): RuntimeGlobalControlCode {
    if (!this.#control.posix) return 'GLOBAL_PAUSE_UNSUPPORTED';
    const observations = updates.map((update) =>
      update.observation as RuntimePauseTargetObservation);
    if (unrecordable.length > 0
      || observations.some((o) => o.code === 'GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE')) {
      return 'GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE';
    }
    if (observations.some((o) => o.adapterSupport !== 'SUPPORTED')) {
      return 'GLOBAL_PAUSE_UNSUPPORTED';
    }
    if (observations.some((o) => o.code === 'GLOBAL_PAUSE_TARGET_NOT_STOPPED')) {
      return 'GLOBAL_PAUSE_TARGET_NOT_STOPPED';
    }
    return 'GLOBAL_PAUSE_RECOVERY_REQUIRED';
  }

  #resumeFailureCode(
    updates: readonly RuntimePauseTargetUpdate[],
    unrecordable: readonly UnrecordableTarget[],
    changedTarget: boolean,
  ): RuntimeGlobalControlCode {
    const observations = updates.map((update) =>
      update.observation as RuntimePauseTargetObservation);
    if (!changedTarget && observations.some((o) => o.code === 'GLOBAL_RESUME_TARGET_CHANGED')) {
      return 'GLOBAL_RESUME_TARGET_CHANGED';
    }
    if (unrecordable.length > 0
      || observations.some((o) => o.code === 'GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE')) {
      return 'GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE';
    }
    return 'GLOBAL_PAUSE_RECOVERY_REQUIRED';
  }

  async #settlePause(input: {
    readonly epoch: number;
    readonly outcome: 'PAUSED' | 'RECOVERY_REQUIRED';
    readonly detail: unknown;
    readonly updates: readonly RuntimePauseTargetUpdate[];
    readonly code: RuntimeGlobalControlCode | null;
    readonly input: { readonly commandId: string; readonly actor: string };
    readonly payloadHash: string;
    readonly at: number;
  }): Promise<RuntimeGlobalControlView> {
    const settled = this.#storage.settleRuntimeGlobalPause({
      epoch: input.epoch,
      outcome: input.outcome,
      detail: input.detail,
      targetUpdates: input.updates,
      commandId: input.input.commandId,
      actor: input.input.actor,
      eventId: this.#randomUUID(),
      occurredAt: this.#now(),
    });
    const view = this.#view(settled.control.state, input.code);
    const result: RuntimeGlobalControlOutcome = {
      view, code: input.code, detail: describeOutcome(input.outcome, input.code),
    };
    this.#storage.writeRuntimeCommandReceipt(
      this.#receipt(input.input, input.payloadHash, result), this.#now());
    return view;
  }

  #receipt(
    input: { readonly commandId: string; readonly actor: string },
    payloadHash: string,
    result: unknown,
  ): RuntimeCommandReceiptInput {
    return { commandId: input.commandId, payloadHash, actor: input.actor, result };
  }

  #view(state: RuntimeGlobalControlState, code: RuntimeGlobalControlCode | null,
    targets?: readonly RuntimePauseTargetRecord[]): RuntimeGlobalControlView {
    const control = this.#storage.getRuntimePauseControl();
    const rows = targets ?? (control.pauseEpoch === 0
      ? []
      : this.#storage.listRuntimePauseTargets(control.pauseEpoch));
    return {
      state,
      pauseEpoch: control.pauseEpoch,
      version: control.version,
      requestedAt: control.requestedAt,
      requestedBy: control.requestedBy,
      settledAt: control.settledAt,
      detail: control.detail,
      code,
      platformSupported: this.#control.posix,
      platform: this.#control.platform,
      targets: rows.map(targetView),
      capacity: null,
      capacityNote: 'The Runtime-global capacity numbers are reported by `scheduler capacity get`;'
        + ' this projection reports only the control state that command reads as `pauseState`.',
    };
  }
}

/** A target that could not even be recorded, carried in the control row's detail. */
interface UnrecordableTarget {
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly incarnationId: string;
  readonly adapterId: string;
  readonly reason: string;
}

function targetView(target: RuntimePauseTargetRecord): RuntimePauseTargetView {
  return {
    targetId: target.id,
    pauseEpoch: target.pauseEpoch,
    projectId: target.projectId,
    taskId: target.taskId,
    executionId: target.executionId,
    sessionId: target.sessionId,
    incarnationId: target.incarnationId,
    providerPid: target.providerPid,
    providerStartToken: target.providerStartToken,
    state: target.state,
    observation: target.observation as RuntimePauseTargetObservation,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}

function processIdentityOf(incarnation: ActiveProviderIncarnation): {
  readonly pid: number; readonly startToken: string;
} | null {
  const identity = incarnation.processIdentity;
  if (typeof identity !== 'object' || identity === null) return null;
  const pid = (identity as { readonly pid?: unknown }).pid;
  const startToken = (identity as { readonly startToken?: unknown }).startToken;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startToken !== 'string' || startToken.trim().length === 0) return null;
  return { pid, startToken };
}

function adapterIdOf(observation: unknown): string | null {
  if (typeof observation !== 'object' || observation === null) return null;
  const adapterId = (observation as { readonly adapterId?: unknown }).adapterId;
  return typeof adapterId === 'string' && adapterId.length > 0 ? adapterId : null;
}

/**
 * The state a reconcile observation may write. A reconcile never promotes an unverified target, and
 * it keeps `RECOVERY_REQUIRED` sticky: only a new process observation that proves a stop or an exit
 * can move a target out of it, and this read cannot prove a stop.
 */
function reconcileTargetState(
  current: RuntimePauseTargetState,
  observation: RuntimePauseTargetObservation,
): RuntimePauseTargetState {
  if (observation.code === 'EXITED') return 'EXITED';
  if (current === 'RESUMED' || current === 'EXITED') return current;
  if (observation.code === 'GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE'
    || observation.adapterSupport !== 'SUPPORTED') {
    return current === 'STOPPED' ? 'RECOVERY_REQUIRED' : current === 'PENDING'
      ? 'RECOVERY_REQUIRED' : current;
  }
  return current;
}

function describeObservation(
  target: RuntimePauseTargetRecord,
  observed: ProviderProcessObservation,
  identityMatched: boolean,
): string {
  if (observed.state === 'EXITED') {
    return `the recorded provider process ${target.providerPid} is not in the process table`;
  }
  if (observed.startToken === null) {
    return `process ${target.providerPid} exists but its start token could not be read, so it is`
      + ' not the recorded incarnation as far as this Runtime can prove';
  }
  if (!identityMatched) {
    return `process ${target.providerPid} has start token ${observed.startToken} instead of the`
      + ` recorded ${target.providerStartToken}, so it is a different process (pid reuse)`;
  }
  return `process ${target.providerPid} is ${observed.state} and its start token still matches the`
    + ' recorded incarnation';
}

function describeOutcome(
  outcome: 'PAUSED' | 'RECOVERY_REQUIRED' | 'RUNNING',
  code: RuntimeGlobalControlCode | null,
): string {
  if (outcome === 'PAUSED') {
    return 'every target provider main process is verified stopped; no new model request can be'
      + ' issued by a controlled provider while this barrier is up';
  }
  if (outcome === 'RUNNING') {
    return 'every target was verified resumed or proven exited; the barrier is down';
  }
  return `the global state requires recovery (${code ?? 'GLOBAL_PAUSE_RECOVERY_REQUIRED'}); the`
    + ' barrier stays up and already-frozen targets stay frozen';
}

function hashOf(value: unknown): string {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(value)).digest('hex');
}
