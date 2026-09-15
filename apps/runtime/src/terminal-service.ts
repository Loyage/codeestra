import {
  buildPiTerminalArguments,
  readPiSessionFileFacts,
  readProcessStartToken,
  terminalReleaseByte,
  PiPtyTerminal,
  type PiPtyExit,
  type PiPtyLaunchInput,
  type ProviderProcessTree,
  type PiSessionFileFacts,
} from '@codeestra/agent-adapters';
import type { AgentConfiguration } from '@codeestra/contracts';
import { resolveAgentPlugins } from './agent-config-service.js';
import {
  Phase1Database,
  type SessionTerminalAttachmentRecord,
  type SessionTerminalRecord,
} from '@codeestra/storage';

export class TerminalServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TerminalServiceError';
  }
}

/** What the Runtime knows about one session's native terminal, projected for clients. */
export interface SessionTerminalView {
  readonly terminalId: string;
  readonly incarnationId: string;
  readonly state: SessionTerminalRecord['state'];
  readonly helperPid: number | null;
  readonly providerPid: number | null;
  readonly ptySlave: string | null;
  readonly windowSize: SessionTerminalRecord['windowSize'];
  /** True while this Runtime still holds the terminal's control connection. */
  readonly held: boolean;
  /** Terminal byte cursor a client should resume reading from. */
  readonly cursor: number;
  readonly retainedBytes: number;
  readonly projectedBytes: number;
  readonly bufferTruncated: boolean;
  readonly release: {
    readonly commandId: string | null;
    readonly requestedAt: number | null;
    readonly releaseByte: string | null;
    readonly providerShutdownReportedAt: number | null;
    readonly exit: { readonly code: number | null; readonly signal: string | null;
      readonly reportedAt: number | null } | null;
    readonly sessionFileEntriesAtStart: number | null;
    readonly sessionFileEntriesAtRelease: number | null;
    readonly lastEntryIdAtStart: string | null;
    readonly lastEntryIdAtRelease: string | null;
    readonly detail: string | null;
  };
  readonly writer: { readonly holderRef: string; readonly attachedAt: number } | null;
  readonly attachments: readonly {
    readonly id: string; readonly kind: SessionTerminalAttachmentRecord['kind'];
    readonly holderRef: string; readonly state: SessionTerminalAttachmentRecord['state'];
    readonly cursorAtAttach: number; readonly cursorAtDetach: number | null;
    readonly attachedAt: number; readonly detachedAt: number | null;
    readonly detachedReason: string | null;
  }[];
}

/** A launched-but-not-yet-recorded terminal: the process facts a successor incarnation needs. */
export interface LaunchedTerminal {
  readonly sessionId: string;
  readonly terminal: PiPtyTerminal;
  readonly helperPid: number;
  readonly providerPid: number;
  /** The provider process start token, read while it was alive (identity for later checks). */
  readonly providerStartToken: string | null;
  readonly ptySlave: string;
  readonly windowSize: SessionTerminalRecord['windowSize'];
  readonly processTree: ProviderProcessTree | null;
  readonly sessionFile: string | null;
  readonly entriesAtStart: number | null;
  readonly lastEntryIdAtStart: string | null;
  /** Entry ids observed at launch, used to prove the release did not rewrite the conversation. */
  readonly entryIdsAtStart: readonly string[];
  readonly startedAt: number;
}

export interface TerminalReleaseOutcome {
  readonly released: boolean;
  readonly code: string;
  readonly detail: string;
  readonly terminalId: string | null;
  /** The provider's own exit fact; `null` means no exit was observed. */
  readonly exit: PiPtyExit | null;
  /** Ownership observation over the recorded process tree, as the string a client can branch on. */
  readonly predecessorObservation: string;
  readonly sessionFile: {
    readonly file: string | null;
    readonly entriesAtStart: number | null;
    readonly entriesAtRelease: number | null;
    readonly lastEntryIdAtStart: string | null;
    readonly lastEntryIdAtRelease: string | null;
    readonly predecessorEntrySurvived: boolean | null;
    readonly truncated: boolean;
  };
}

export interface TerminalServiceOptions {
  readonly storage: Phase1Database;
  /** The provider executable; the same one the RPC adapter launches. */
  readonly piExecutable?: string;
  /** Arguments placed before the provider argv, e.g. a launcher such as `run <script>`. */
  readonly launcherArgs?: readonly string[];
  readonly piSessionDir: string;
  readonly gateExtensionPath: string;
  readonly questionExtensionPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly permissionMode: () => 'FULL' | 'STRICT';
  readonly resolveAgentConfig?: (input: {
    readonly projectId: string; readonly adapterId: string;
  }) => AgentConfiguration | null;
  /**
   * The same plugin resolution the RPC adapter uses (ADR-0044 D06): taking over a Session in a
   * native terminal must not change which resources the Agent may load.
   */
  readonly resolveAgentPlugins?: (input: {
    readonly projectId: string; readonly adapterId: string;
  }) => ReturnType<typeof resolveAgentPlugins>;
  /** Test seam: launches the PTY-hosted provider. Defaults to the real `PiPtyTerminal`. */
  readonly launch?: (input: PiPtyLaunchInput) => Promise<PiPtyTerminal>;
  /** Test seam: the provider's session directory check and argv composition stay identical. */
  readonly platform?: 'unix' | 'windows';
  readonly cols?: number;
  readonly rows?: number;
  /** How long an explicit release waits for the provider process to exit. */
  readonly releaseGraceMs?: number;
  /** How long a stop waits for the provider/helper to exit before signalling it. */
  readonly stopGraceMs?: number;
  /** How often the terminal's process tree is refreshed while it is alive (ownership evidence). */
  readonly treeRefreshMs?: number;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly logger?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

interface HeldTerminal {
  readonly terminal: PiPtyTerminal;
  readonly record: SessionTerminalRecord;
  /** The process tree captured while the provider was still alive; the release's ownership evidence. */
  readonly processTree: ProviderProcessTree | null;
  readonly entriesAtStart: number | null;
}

/**
 * The Runtime's PTY transport (ADR-0026).
 *
 * It owns every native terminal this Runtime started: the PTY host helper, the provider running on
 * that terminal, the client attachments over the projected byte stream, and the evidence an explicit
 * release is decided from. The terminal bytes themselves live only in this process's bounded memory
 * and are never persisted (ADR-0010 D06) — what is persisted is the *fact* structure: which process
 * was launched, which release was requested, what the provider's session file contained before and
 * after, and whether the provider process exited.
 */
export class TerminalService {
  readonly #storage: Phase1Database;
  readonly #options: TerminalServiceOptions;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #logger: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  /** Terminals launched by *this* Runtime process, keyed by Session. */
  readonly #held = new Map<string, HeldTerminal>();
  /** The merged process tree of each held terminal, refreshed while it is alive. */
  readonly #trees = new Map<string, ProviderProcessTree>();
  readonly #treeTimers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(options: TerminalServiceOptions) {
    this.#storage = options.storage;
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#logger = options.logger ?? (() => {});
  }

  /**
   * Starts a native terminal on the same provider conversation and in the same workspace as the
   * automation it replaces. The permission mode, tool allowlist, gate/question extensions and the
   * session file are composed exactly as the RPC launch composes them, so the transport switch
   * cannot silently change what the Agent may do.
   */
  async launchTerminal(input: {
    readonly sessionId: string;
    readonly projectId: string;
    readonly adapterId: string;
    readonly workspacePath: string;
    readonly sessionFile: string;
    readonly agentConfig?: AgentConfiguration | null;
  }): Promise<LaunchedTerminal> {
    const permissionMode = this.#options.permissionMode();
    const resolvedConfig = input.agentConfig === undefined || input.agentConfig === null
      ? (this.#options.resolveAgentConfig?.({ projectId: input.projectId,
          adapterId: input.adapterId }) ?? null)
      : input.agentConfig;
    const resolvedPlugins = input.adapterId === 'pi'
      ? (this.#options.resolveAgentPlugins?.({ projectId: input.projectId,
          adapterId: input.adapterId }) ?? null)
      : null;
    const terminalArguments = buildPiTerminalArguments({
      gateExtensionPath: this.#options.gateExtensionPath,
      questionExtensionPath: this.#options.questionExtensionPath,
      sessionDir: this.#options.piSessionDir,
      ...(this.#options.platform === undefined ? {} : { platform: this.#options.platform }),
      permissionMode,
      resumeSessionFile: input.sessionFile,
      ...(resolvedConfig === null ? {} : { agentConfig: resolvedConfig }),
      ...(resolvedPlugins === null ? {} : { pluginSelection: resolvedPlugins.selection }),
    });
    const piExecutable = this.#options.piExecutable
      ?? this.#options.environment['CODEESTRA_PI_EXECUTABLE'] ?? 'pi';
    const argv = [...(this.#options.launcherArgs ?? []), piExecutable, ...terminalArguments];
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.#options.environment)) {
      if (typeof value === 'string') environment[key] = value;
    }
    // The same dual channel the RPC launch uses: the extension reads the mode from the environment.
    environment['CODEESTRA_PERMISSION_MODE'] = permissionMode;
    const launch = this.#options.launch ?? ((plan: PiPtyLaunchInput) => PiPtyTerminal.launch(plan));
    const terminal = await launch({
      argv,
      cwd: input.workspacePath,
      env: environment,
      ...(this.#options.cols === undefined ? {} : { cols: this.#options.cols }),
      ...(this.#options.rows === undefined ? {} : { rows: this.#options.rows }),
    });
    const facts = await readPiSessionFileFacts({
      file: input.sessionFile, collectEntryIds: true,
    });
    return {
      sessionId: input.sessionId,
      terminal,
      helperPid: terminal.helperPid,
      providerPid: terminal.providerPid,
      providerStartToken: await readProcessStartToken(terminal.providerPid),
      ptySlave: terminal.slavePath,
      windowSize: terminal.windowSize,
      processTree: await terminal.captureTree(),
      sessionFile: input.sessionFile,
      entriesAtStart: facts.exists ? facts.entryCount : null,
      lastEntryIdAtStart: facts.lastEntryId,
      entryIdsAtStart: facts.entryIds,
      startedAt: this.#now(),
    };
  }

  /**
   * Records a launched terminal against the successor incarnation that owns it. The incarnation must
   * already exist: the terminal row references it, so "which generation holds this terminal" is an
   * integrity constraint rather than bookkeeping.
   */
  commitTerminal(input: { readonly launched: LaunchedTerminal; readonly incarnationId: string }):
  SessionTerminalRecord {
    const write = this.#storage.recordSessionTerminal({
      id: this.#randomUUID(),
      sessionId: input.launched.sessionId,
      incarnationId: input.incarnationId,
      helperPid: input.launched.helperPid,
      helperStartToken: input.launched.processTree?.startToken ?? null,
      providerPid: input.launched.providerPid,
      ptySlave: input.launched.ptySlave,
      windowSize: input.launched.windowSize,
      sessionFile: input.launched.sessionFile,
      entriesAtStart: input.launched.entriesAtStart,
      lastEntryIdAtStart: input.launched.lastEntryIdAtStart,
      createdAt: input.launched.startedAt,
    });
    if (write.replayed) {
      // A second start on the same incarnation cannot happen through the admit path (that path is
      // idempotent by command id), but if it does, the freshly launched provider must not keep
      // running next to the recorded one.
      void input.launched.terminal.stop({ graceMs: this.#graceMs() });
      return write.terminal;
    }
    this.#held.set(input.launched.sessionId, {
      terminal: input.launched.terminal,
      record: write.terminal,
      processTree: input.launched.processTree,
      entriesAtStart: input.launched.entriesAtStart,
    });
    if (input.launched.processTree !== null) {
      this.#trees.set(input.launched.sessionId, input.launched.processTree);
    }
    // While the terminal is alive its process tree is refreshed, so a tool started later is still
    // part of the evidence a release (or a takeover) is decided from. The timer never holds the
    // Runtime open.
    const refreshMs = this.#options.treeRefreshMs ?? 2_000;
    const timer = setInterval(() => { void this.#refreshTree(input.launched.sessionId); }, refreshMs);
    (timer as { unref?: () => void }).unref?.();
    this.#treeTimers.set(input.launched.sessionId, timer);
    return write.terminal;
  }

  /**
   * Refreshes and merges one terminal's process tree, and persists the merged union on the
   * incarnation that owns it: the ownership check at admission time reads the stored tree, not
   * whatever this process happens to remember.
   */
  async #refreshTree(sessionId: string): Promise<ProviderProcessTree | null> {
    const held = this.#held.get(sessionId) ?? null;
    if (held === null) return null;
    const previous = this.#trees.get(sessionId) ?? held.processTree;
    const merged = await held.terminal.refreshTree(previous);
    if (merged === null) return null;
    this.#trees.set(sessionId, merged);
    try {
      this.#storage.mergeSessionIncarnationProcessTree({
        incarnationId: held.record.incarnationId, tree: merged,
      });
    } catch (error) {
      this.#logger('the refreshed terminal process tree could not be recorded', {
        sessionId, reason: error instanceof Error ? error.message : String(error),
      });
    }
    return merged;
  }

  #endHeldTerminal(sessionId: string): void {
    const timer = this.#treeTimers.get(sessionId);
    if (timer !== undefined) clearInterval(timer);
    this.#treeTimers.delete(sessionId);
    this.#trees.delete(sessionId);
    this.#held.delete(sessionId);
  }

  /** The terminal this Runtime process still holds for one Session, if any. */
  held(sessionId: string): { readonly terminal: PiPtyTerminal;
    readonly record: SessionTerminalRecord } | null {
    return this.#held.get(sessionId) ?? null;
  }

  /** The recorded terminal of one Session (running or ended), whether or not this Runtime holds it. */
  record(sessionId: string): SessionTerminalRecord | null {
    const held = this.#held.get(sessionId);
    if (held !== undefined) return held.record;
    const running = this.#storage.getRunningSessionTerminal(sessionId);
    if (running !== null) return running;
    const all = this.#storage.listSessionTerminals(sessionId);
    return all.at(-1) ?? null;
  }

  view(sessionId: string): SessionTerminalView | null {
    const record = this.record(sessionId);
    if (record === null) return null;
    const held = this.#held.get(sessionId) ?? null;
    const snapshot = held?.terminal.snapshot() ?? null;
    const writer = this.#storage.getAttachedSessionTerminalWriter(record.id);
    return {
      terminalId: record.id,
      incarnationId: record.incarnationId,
      state: record.state,
      helperPid: record.helperPid,
      providerPid: record.providerPid,
      ptySlave: record.ptySlave,
      windowSize: record.windowSize,
      held: held !== null && held.terminal.exit === null,
      cursor: snapshot?.cursor ?? 0,
      retainedBytes: snapshot?.retainedBytes ?? 0,
      projectedBytes: snapshot?.projectedBytes ?? 0,
      bufferTruncated: snapshot?.truncated ?? false,
      release: {
        commandId: record.releaseCommandId,
        requestedAt: record.releaseRequestedAt,
        releaseByte: record.releaseByte,
        providerShutdownReportedAt: record.providerShutdownReportedAt,
        exit: record.exitReportedAt === null ? null : {
          code: record.exitCode, signal: record.exitSignal, reportedAt: record.exitReportedAt,
        },
        sessionFileEntriesAtStart: record.entriesAtStart,
        sessionFileEntriesAtRelease: record.entriesAtRelease,
        lastEntryIdAtStart: record.lastEntryIdAtStart,
        lastEntryIdAtRelease: record.lastEntryIdAtRelease,
        detail: record.releaseDetail,
      },
      writer: writer === null ? null : { holderRef: writer.holderRef, attachedAt: writer.attachedAt },
      attachments: this.#storage.listSessionTerminalAttachments(sessionId).map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        holderRef: attachment.holderRef,
        state: attachment.state,
        cursorAtAttach: attachment.cursorAtAttach,
        cursorAtDetach: attachment.cursorAtDetach,
        attachedAt: attachment.attachedAt,
        detachedAt: attachment.detachedAt,
        detachedReason: attachment.detachedReason,
      })),
    };
  }

  /**
   * Reads the projected terminal stream. Bytes come from the Runtime's bounded in-memory buffer (and
   * only from there): a client asking for a cursor older than the retained window is told the read
   * was truncated instead of being handed a hole.
   */
  read(input: { readonly sessionId: string; readonly since?: number }): {
    readonly terminalId: string;
    readonly running: boolean;
    readonly cursor: number;
    readonly data: string;
    readonly truncated: boolean;
    readonly retainedBytes: number;
    readonly projectedBytes: number;
  } {
    const record = this.record(input.sessionId);
    if (record === null) {
      throw new TerminalServiceError('TERMINAL_NOT_FOUND',
        'This Session has no recorded native terminal');
    }
    const held = this.#held.get(input.sessionId) ?? null;
    if (held === null || held.terminal.exit !== null) {
      // The Runtime does not hold this terminal (it is not attachable), so there is nothing to
      // project: terminal bytes are Runtime memory only and were never persisted.
      return { terminalId: record.id, running: false, cursor: 0, data: '', truncated: false,
        retainedBytes: 0, projectedBytes: 0 };
    }
    const output = held.terminal.outputSince(input.since ?? 0);
    return { terminalId: record.id, running: true, cursor: output.cursor,
      data: output.data, truncated: output.truncated,
      retainedBytes: held.terminal.snapshot().retainedBytes,
      projectedBytes: held.terminal.snapshot().projectedBytes };
  }

  /** Writes terminal input. This is not an approval channel; STRICT approvals stay Attentions. */
  write(input: { readonly sessionId: string; readonly data: string }): {
    readonly terminalId: string; readonly cursor: number } {
    const held = this.#held.get(input.sessionId) ?? null;
    if (held === null) {
      throw new TerminalServiceError('TERMINAL_NOT_HELD',
        'This Runtime does not hold a live terminal for this Session');
    }
    if (held.terminal.exit !== null) {
      throw new TerminalServiceError('TERMINAL_EXITED', 'The provider terminal has already exited');
    }
    held.terminal.write(input.data);
    return { terminalId: held.record.id, cursor: held.terminal.snapshot().cursor };
  }

  /**
   * Attaches one client to the running terminal and returns the stream since its cursor. A second
   * WRITER is refused with `ATTACHMENT_BUSY` and the current holder named — never queued.
   */
  attach(input: {
    readonly sessionId: string;
    readonly commandId: string;
    readonly holderRef: string;
    readonly kind: SessionTerminalAttachmentRecord['kind'];
    readonly since?: number;
  }): { readonly terminalId: string; readonly attachment: SessionTerminalAttachmentRecord;
    readonly cursor: number; readonly data: string; readonly truncated: boolean } {
    const record = this.record(input.sessionId);
    if (record === null || record.state !== 'RUNNING') {
      throw new TerminalServiceError('TERMINAL_NOT_RUNNING',
        'This Session has no running native terminal to attach to');
    }
    const held = this.#held.get(input.sessionId) ?? null;
    if (held === null) {
      // The record exists but this Runtime does not hold the process: attaching would be a lie.
      throw new TerminalServiceError('TERMINAL_NOT_HELD',
        'This Runtime does not hold this Session\'s terminal; it was started by another Runtime'
        + ' generation and cannot be attached to');
    }
    const snapshot = held.terminal.snapshot();
    const acquisition = this.#storage.attachSessionTerminal({
      id: this.#randomUUID(),
      terminalId: record.id,
      sessionId: input.sessionId,
      kind: input.kind,
      holderRef: input.holderRef,
      commandId: input.commandId,
      cursor: input.since ?? snapshot.cursor,
      attachedAt: this.#now(),
    });
    if (!acquisition.attached || acquisition.attachment === null) {
      throw new TerminalServiceError(acquisition.code,
        acquisition.code === 'ATTACHMENT_BUSY'
          ? `Terminal ${record.id} already has a writer attachment: ${acquisition.holder?.holderRef}`
            + ` attached at ${acquisition.holder?.attachedAt}`
          : `Cannot attach to terminal ${record.id}: ${acquisition.code}`);
    }
    const output = held.terminal.outputSince(input.since ?? 0);
    return { terminalId: record.id, attachment: acquisition.attachment, cursor: output.cursor,
      data: output.data, truncated: output.truncated };
  }

  /**
   * Detaches this client. The terminal, the provider and the workspace keep running: detach is
   * client bookkeeping over the projection, never a stop.
   */
  detach(input: {
    readonly sessionId: string;
    readonly holderRef: string;
    readonly since?: number;
    readonly reason?: string;
  }): { readonly terminalId: string | null; readonly detached: boolean; readonly code: string;
    readonly cursor: number; readonly data: string; readonly truncated: boolean } {
    const record = this.record(input.sessionId);
    if (record === null) {
      throw new TerminalServiceError('TERMINAL_NOT_FOUND',
        'This Session has no recorded native terminal');
    }
    const held = this.#held.get(input.sessionId) ?? null;
    const cursor = held === null || held.terminal.exit !== null
      ? (input.since ?? 0)
      : held.terminal.snapshot().cursor;
    const output = held === null || held.terminal.exit !== null
      ? { cursor, data: '', truncated: false }
      : held.terminal.outputSince(input.since ?? 0);
    const result = this.#storage.detachSessionTerminal({
      sessionId: input.sessionId,
      holderRef: input.holderRef,
      cursor,
      reason: input.reason ?? 'detached by the client',
      at: this.#now(),
    });
    return { terminalId: record.id, detached: result.detached, code: result.code,
      cursor: output.cursor, data: output.data, truncated: output.truncated };
  }

  /**
   * The explicit release (ADR-0026). It writes the terminal's *own* release byte (Ctrl+D), waits for
   * the provider process to exit, then decides from facts whether the conversation is quiescent
   * enough to hand back:
   *
   * 1. the provider process must have exited (observed by the helper that owns it);
   * 2. nothing from the recorded process tree may still be running — a provider that exits does not
   *    stop a tool it already started, and FOUNDATION-040 measured an orphaned tool child writing the
   *    workspace afterwards;
   * 3. the provider's session file must still hold the entries it held at release time, and the entry
   *    the predecessor left behind must still be there.
   *
   * The exit *code* is recorded and never decides anything: Ctrl+D and SIGTERM both exit 0.
   */
  async release(input: {
    readonly sessionId: string;
    readonly commandId: string;
  }): Promise<TerminalReleaseOutcome> {
    const record = this.#storage.getRunningSessionTerminal(input.sessionId);
    const refusal = (code: string, detail: string, exit: PiPtyExit | null = null,
      observation = 'NOT_CHECKED', terminalId: string | null = null): TerminalReleaseOutcome => ({
      released: false, code, detail, terminalId: terminalId ?? record?.id ?? null, exit,
      predecessorObservation: observation,
      sessionFile: { file: record?.sessionFile ?? null, entriesAtStart: record?.entriesAtStart ?? null,
        entriesAtRelease: record?.entriesAtRelease ?? null,
        lastEntryIdAtStart: record?.lastEntryIdAtStart ?? null,
        lastEntryIdAtRelease: record?.lastEntryIdAtRelease ?? null,
        predecessorEntrySurvived: null, truncated: false },
    });
    if (record === null) {
      return refusal('TERMINAL_NOT_RUNNING', 'This Session has no running native terminal');
    }
    const held = this.#held.get(input.sessionId) ?? null;
    if (held === null || held.record.id !== record.id) {
      return refusal('TERMINAL_NOT_HELD',
        'This Runtime does not hold this terminal, so it cannot release it honestly; the provider'
        + ' may still be running and was not signalled', null, 'NOT_HELD', record.id);
    }
    if (held.terminal.exit !== null) {
      return refusal('TERMINAL_ALREADY_EXITED',
        'The provider terminal already exited; there is nothing to release', held.terminal.exit,
        'EXITED', record.id);
    }
    // The last refresh happens while the provider is still alive: after it exits its tool children
    // are reparented and their lineage to this Session is no longer visible in the process table.
    const evidenceTree = await this.#refreshTree(input.sessionId) ?? held.processTree;
    const file = record.sessionFile;
    const atRelease = file === null ? null : await readPiSessionFileFacts({ file });
    const entriesAtRelease = atRelease?.exists === true ? atRelease.entryCount : null;
    // The release request is recorded *before* the byte is written: a crash between the two must not
    // leave a terminal that looks like nobody ever asked it to release.
    this.#storage.markSessionTerminalReleaseRequested({
      terminalId: record.id,
      commandId: input.commandId,
      releaseByte: terminalReleaseByte,
      requestedAt: this.#now(),
      entriesAtRelease,
      lastEntryIdAtRelease: atRelease?.lastEntryId ?? null,
      detail: 'explicit release requested by the CLI; the terminal\'s own release byte was written',
    });
    try {
      held.terminal.write(terminalReleaseByte);
    } catch (error) {
      return refusal('RELEASE_WRITE_FAILED',
        `The release byte could not be written: ${error instanceof Error ? error.message : String(error)}`,
        null, 'NOT_CHECKED', record.id);
    }
    const exit = await held.terminal.waitForExit(this.#graceMs());
    if (exit === null) {
      // The provider did not exit. The Runtime does not kill it: a running tool is never aborted for
      // a handoff (ADR-0010 D03), and an unconfirmed release is reported as such.
      return refusal('RELEASE_NOT_CONFIRMED',
        `The provider did not exit within ${this.#graceMs()} ms of the release byte; it is still`
        + ' running and was not signalled', null, 'ALIVE', record.id);
    }
    const ownership = await held.terminal.inspectOwnership(evidenceTree);
    await this.#settleTerminalEnd(record.id, {
      // The provider did exit, so the terminal itself is RELEASED. Whether the *handoff* is allowed
      // is decided separately below, from the ownership observation and the session file facts.
      state: 'RELEASED',
      exit,
      detail: `provider exit reported by the PTY host (code ${exit.code ?? 'null'},`
        + ` signal ${exit.signal ?? 'null'}); ownership ${ownership.state}: ${ownership.detail}`,
    });
    this.#endHeldTerminal(input.sessionId);
    // An explicit release ends the attachments: a client that wanted to keep watching had to stay
    // attached to a running terminal, and this one is gone.
    this.#storage.releaseSessionTerminalAttachments({
      terminalId: record.id, cursor: held.terminal.snapshot().cursor,
      reason: 'the terminal was released', at: this.#now(),
    });
    if (ownership.state === 'DESCENDANTS_ALIVE') {
      return refusal('PREDECESSOR_DESCENDANTS_ALIVE', ownership.detail, exit, ownership.state, record.id);
    }
    if (ownership.state === 'UNVERIFIABLE') {
      return refusal('PREDECESSOR_UNVERIFIED', ownership.detail, exit, ownership.state, record.id);
    }
    const sessionFile = await this.#verifySessionFile({
      file, entriesAtRelease, entriesAtStart: held.entriesAtStart,
      lastEntryIdAtStart: record.lastEntryIdAtStart,
    });
    if (sessionFile.code !== 'OK') {
      return { released: false, code: sessionFile.code, detail: sessionFile.detail,
        terminalId: record.id, exit, predecessorObservation: ownership.state,
        sessionFile: sessionFile.view };
    }
    return { released: true, code: 'RELEASED',
      detail: `the provider exited after the explicit release and nothing from its process tree is`
        + ` running (${ownership.detail}); the session file still holds the predecessor's entries`,
      terminalId: record.id, exit, predecessorObservation: ownership.state,
      sessionFile: sessionFile.view };
  }

  /**
   * The provider's own shutdown notification from the gate extension. It is recorded as supporting
   * evidence only: FOUNDATION-040 measured that this notification is not reliably delivered, so no
   * release decision may depend on it.
   */
  noteProviderShutdown(input: { readonly sessionId: string; readonly at: number }): boolean {
    const record = this.record(input.sessionId);
    if (record === null || record.state !== 'RUNNING') return false;
    return this.#storage.markSessionTerminalProviderShutdownReported({
      terminalId: record.id, at: input.at,
    });
  }

  /** Ends a terminal this Runtime holds, without an explicit release (Runtime shutdown, reconcile). */
  async stopTerminal(input: { readonly sessionId: string; readonly reason: string;
    readonly state: 'STOPPED' | 'RECOVERY_REQUIRED' }): Promise<{ readonly stopped: boolean;
      readonly detail: string }> {
    const held = this.#held.get(input.sessionId) ?? null;
    if (held === null) return { stopped: false, detail: 'no terminal is held for this Session' };
    // Capture the tree once more while the provider is alive, so the stop is recorded with the
    // evidence a later check needs.
    await this.#refreshTree(input.sessionId);
    const result = await held.terminal.stop({ graceMs: this.#graceMs() });
    await this.#settleTerminalEnd(held.record.id, {
      state: result.exited ? input.state : 'RECOVERY_REQUIRED',
      exit: result.exit,
      detail: result.exited
        ? `${input.reason}; provider process stopped`
        : `${input.reason}; the provider process could NOT be confirmed stopped`,
    });
    this.#storage.releaseSessionTerminalAttachments({
      terminalId: held.record.id, cursor: held.terminal.snapshot().cursor,
      reason: input.reason, at: this.#now(),
    });
    // The terminal was the writer; once it is gone no lease may keep claiming the conversation.
    const lease = this.#storage.getSessionWriterLease(input.sessionId);
    if (lease !== null && lease.incarnationId === held.record.incarnationId) {
      this.#storage.releaseSessionWriterLeaseForSession({
        sessionId: input.sessionId, reason: `terminal ended: ${input.reason}`,
        releasedAt: this.#now(),
      });
    }
    this.#endHeldTerminal(input.sessionId);
    return { stopped: result.exited,
      detail: result.exited ? 'the provider process exited' : 'the provider process did not confirm exit' };
  }

  /**
   * Runtime shutdown: every terminal this process holds is stopped, because a Runtime that is gone
   * cannot own a terminal and leaving one behind would let a provider keep writing the workspace.
   */
  async close(): Promise<void> {
    for (const sessionId of [...this.#held.keys()]) {
      try {
        await this.stopTerminal({ sessionId, reason: 'the Runtime is shutting down', state: 'STOPPED' });
      } catch (error) {
        this.#logger('terminal could not be stopped during shutdown', {
          sessionId, reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async #settleTerminalEnd(terminalId: string, input: {
    readonly state: 'RELEASED' | 'STOPPED' | 'RECOVERY_REQUIRED';
    readonly exit: PiPtyExit | null;
    readonly detail: string;
  }): Promise<void> {
    this.#storage.markSessionTerminalEnded({
      terminalId,
      state: input.state,
      exitCode: input.exit?.code ?? null,
      exitSignal: input.exit?.signal ?? null,
      at: input.exit?.at ?? this.#now(),
      detail: input.detail,
    });
  }

  /**
   * Proves the conversation was appended to rather than rewritten: the file must still hold at least
   * the entries it held at release time, and the last entry the predecessor wrote must still exist.
   */
  async #verifySessionFile(input: {
    readonly file: string | null;
    readonly entriesAtStart: number | null;
    readonly entriesAtRelease: number | null;
    readonly lastEntryIdAtStart: string | null;
  }): Promise<{ readonly code: string; readonly detail: string;
    readonly view: TerminalReleaseOutcome['sessionFile'] }> {
    if (input.file === null) {
      return { code: 'SESSION_FILE_UNRECORDED',
        detail: 'this terminal has no recorded provider session file, so the conversation cannot be'
          + ' verified before handing it back',
        view: { file: null, entriesAtStart: input.entriesAtStart, entriesAtRelease: input.entriesAtRelease,
          lastEntryIdAtStart: input.lastEntryIdAtStart, lastEntryIdAtRelease: null,
          predecessorEntrySurvived: null, truncated: false } };
    }
    const facts: PiSessionFileFacts = await readPiSessionFileFacts({
      file: input.file, collectEntryIds: true,
    });
    const survived = input.lastEntryIdAtStart === null
      ? null
      : facts.entryIds.includes(input.lastEntryIdAtStart);
    const view = { file: input.file, entriesAtStart: input.entriesAtStart,
      entriesAtRelease: input.entriesAtRelease,
      lastEntryIdAtStart: input.lastEntryIdAtStart, lastEntryIdAtRelease: facts.lastEntryId,
      predecessorEntrySurvived: survived, truncated: facts.truncated };
    if (!facts.exists) {
      return { code: 'SESSION_FILE_MISSING',
        detail: `the provider session file ${input.file} is gone; the conversation cannot be handed back`,
        view };
    }
    if (facts.truncated) {
      return { code: 'SESSION_FILE_TRUNCATED_READ',
        detail: 'the provider session file is larger than this Runtime reads, so its history cannot'
          + ' be verified before handing it back',
        view };
    }
    if (input.entriesAtRelease !== null && facts.entryCount < input.entriesAtRelease) {
      return { code: 'SESSION_FILE_REWRITTEN',
        detail: `the provider session file lost entries during the release (${input.entriesAtRelease}`
          + ` before, ${facts.entryCount} now); the Runtime refuses to hand back a rewritten conversation`,
        view };
    }
    if (survived === false) {
      return { code: 'SESSION_FILE_REWRITTEN',
        detail: `the entry the predecessor left behind (${input.lastEntryIdAtStart}) is no longer in`
          + ' the provider session file',
        view };
    }
    return { code: 'OK', detail: 'the provider session file still holds the predecessor\'s entries',
      view };
  }

  #graceMs(): number {
    return this.#options.releaseGraceMs ?? 30_000;
  }
}
