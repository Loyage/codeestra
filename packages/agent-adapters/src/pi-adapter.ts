import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  agentProcessIdentitySchema,
  type AdapterCapabilities,
  type AgentAnswerAdapter,
  type AgentAnswerRequest,
  type AgentControlReceipt,
  type AgentObservedEvent,
  type AgentSessionRef,
  type AgentStartRequest,
} from '@codeestra/contracts';
import { readProcessStartToken } from './pi-identity.js';
import { PiRpcClient, PiRpcProcessError } from './pi-process.js';
import {
  buildPiRpcArguments,
  mapPiExtensionUiRequest,
  piExtensionUiResponseRecord,
} from './pi-rpc.js';

const piCapabilities: AdapterCapabilities = Object.freeze({
  persistentSession: 'SUPPORTED',
  structuredAttention: 'SUPPORTED',
  nativePermissionRouting: 'SUPPORTED',
  pauseWithQuiescence: 'UNSUPPORTED',
  revisionAcknowledgement: 'UNSUPPORTED',
  cooperativeStop: 'REQUIRES_VALIDATION',
  attach: 'STRUCTURED',
  reconnectToLiveSession: 'UNSUPPORTED',
  resumeAfterExit: 'SUPPORTED',
});

export interface PiRpcAdapterOptions {
  /** Executable used to launch Pi. Defaults to `pi` from PATH. */
  readonly piExecutable?: string;
  /** Arguments placed before the Pi argv, e.g. a launcher such as `run <script>`. */
  readonly launcherArgs?: readonly string[];
  readonly gateExtensionPath: string;
  readonly sessionDir: string;
  readonly platform?: 'unix' | 'windows';
  readonly environment?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly maxRecordBytes?: number;
  readonly stopGraceMs?: number;
  readonly spawn?: (argv: readonly string[], options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  }) => Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  readonly readStartToken?: (pid: number) => Promise<string | null>;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}

interface LiveSession {
  readonly client: PiRpcClient;
  readonly providerSessionId: string;
  readonly sessionStorageRef: string;
  readonly processIdentity: unknown;
}

function composeRevisionPrompt(revision: AgentStartRequest['revision']): string {
  const lines = [`Codeestra revision ${revision.id}`, '', revision.specification.trim()];
  if (revision.constraints.length > 0) {
    lines.push('', 'Constraints:');
    for (const constraint of revision.constraints) {
      lines.push(`- ${constraint.id}: ${constraint.text.trim()}`);
    }
  }
  return lines.join('\n');
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PiRpcProcessError('INVALID_PROVIDER_RESPONSE',
      `Pi get_state did not report a usable ${field}`, true, false);
  }
  return value;
}

/**
 * Real Pi adapter. It owns the `pi --mode rpc` child process and its pipes, so it can
 * only observe or answer a Session whose process it still holds; a lost process is
 * reported as disconnected instead of being reattached or replayed.
 */
export class PiRpcAdapter implements AgentAnswerAdapter {
  readonly id = 'pi';
  readonly #sessions = new Map<string, LiveSession>();
  readonly #unconfirmedStops: number[] = [];
  readonly #options: Required<Pick<PiRpcAdapterOptions,
    'piExecutable' | 'launcherArgs' | 'platform' | 'environment' | 'requestTimeoutMs' | 'stopGraceMs'>>;
  readonly #spawn: NonNullable<PiRpcAdapterOptions['spawn']>;
  readonly #readStartToken: (pid: number) => Promise<string | null>;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  #version: string | null = null;

  constructor(options: PiRpcAdapterOptions) {
    if (!isAbsolute(options.gateExtensionPath) || !isAbsolute(options.sessionDir)) {
      throw new PiRpcProcessError('PROVIDER_SPAWN_FAILED',
        'Pi gate extension and session directory paths must be absolute', false, false);
    }
    this.gateExtensionPath = options.gateExtensionPath;
    this.sessionDir = options.sessionDir;
    this.#options = {
      piExecutable: options.piExecutable ?? 'pi',
      launcherArgs: options.launcherArgs ?? [],
      platform: options.platform ?? 'unix',
      environment: options.environment ?? {},
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      stopGraceMs: options.stopGraceMs ?? 5_000,
    };
    this.#spawn = options.spawn ?? ((argv, spawnOptions) => Bun.spawn([...argv], {
      cwd: spawnOptions.cwd,
      env: { ...spawnOptions.env },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }));
    this.#readStartToken = options.readStartToken ?? readProcessStartToken;
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.maxRecordBytes = options.maxRecordBytes;
  }

  readonly gateExtensionPath: string;
  readonly sessionDir: string;
  readonly maxRecordBytes: number | undefined;

  capabilities(): AdapterCapabilities {
    return piCapabilities;
  }

  async probe(): Promise<{ readonly version: string; readonly capabilities: AdapterCapabilities }> {
    if (this.#version !== null) return { version: this.#version, capabilities: piCapabilities };
    const argv = [...this.#options.launcherArgs, '--version'];
    let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
    try {
      child = this.#spawn([this.#options.piExecutable, ...argv], { cwd: this.sessionDir,
        env: this.#options.environment });
    } catch (error) {
      throw new PiRpcProcessError('PROVIDER_VERSION_UNAVAILABLE',
        `Could not launch ${this.#options.piExecutable}: ${error instanceof Error ? error.message : String(error)}`,
        false, false);
    }
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    const match = /^(\d+\.\d+\.\d+)/.exec(stdout.trim());
    if (exitCode !== 0 || match === null) {
      throw new PiRpcProcessError('PROVIDER_VERSION_UNAVAILABLE',
        `${this.#options.piExecutable} --version did not report a usable version`, false, false);
    }
    this.#version = match[1] as string;
    return { version: this.#version, capabilities: piCapabilities };
  }

  async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    const argv = [...this.#options.launcherArgs, ...buildPiRpcArguments({
      gateExtensionPath: this.gateExtensionPath,
      sessionDir: this.sessionDir,
      platform: this.#options.platform,
    })];
    let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
    try {
      child = this.#spawn([this.#options.piExecutable, ...argv], {
        cwd: request.workspace.cwd,
        env: { ...this.#options.environment, ...request.environment },
      });
    } catch (error) {
      throw new PiRpcProcessError('PROVIDER_SPAWN_FAILED',
        `Could not launch ${this.#options.piExecutable}: ${error instanceof Error ? error.message : String(error)}`,
        false, false);
    }
    const client = new PiRpcClient(child, this.#randomUUID(), {
      ...(this.maxRecordBytes === undefined ? {} : { maxRecordBytes: this.maxRecordBytes }),
      requestTimeoutMs: this.#options.requestTimeoutMs,
    });
    try {
      const state = await client.request({ type: 'get_state' });
      const providerSessionId = requiredString(
        (state as Record<string, unknown> | null)?.['sessionId'], 'sessionId');
      const sessionStorageRef = requiredString(
        (state as Record<string, unknown> | null)?.['sessionFile'], 'sessionFile');
      const startToken = await this.#readStartToken(child.pid);
      if (startToken === null) {
        throw new PiRpcProcessError('PROCESS_IDENTITY_UNAVAILABLE',
          `Could not read a start token for the Pi child process ${child.pid}`, true, false);
      }
      const processIdentity = agentProcessIdentitySchema.parse({
        pid: child.pid,
        executable: this.#options.piExecutable,
        startToken,
        argvHash: createHash('sha256').update(JSON.stringify(argv)).digest('hex'),
        capturedAt: this.#now(),
      });
      // The first user message is what makes the persistent Pi session durable.
      await client.request({ type: 'prompt', message: composeRevisionPrompt(request.revision) });
      this.#sessions.set(request.sessionId, { client, providerSessionId, sessionStorageRef, processIdentity });
      return {
        id: request.sessionId,
        executionId: request.executionId,
        adapterId: this.id,
        providerSessionId,
        processIdentity,
        sessionStorageRef,
      };
    } catch (error) {
      const cleanup = await client.stop({ graceMs: this.#options.stopGraceMs });
      const code = error instanceof PiRpcProcessError ? error.code : 'PROVIDER_SPAWN_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      const suffix = cleanup.exited
        ? ` (Pi process ${cleanup.pid} was confirmed stopped)`
        : ` (Pi process ${cleanup.pid} could NOT be confirmed stopped)`;
      throw new PiRpcProcessError(code, `${message}${suffix}`, true, false);
    }
  }

  async *observe(session: AgentSessionRef, cursor?: string): AsyncIterable<AgentObservedEvent> {
    if (session.adapterId !== this.id) {
      throw new PiRpcProcessError('SESSION_IDENTITY_MISMATCH',
        `Pi adapter cannot observe ${session.adapterId}`, true, true);
    }
    const live = this.#sessions.get(session.id);
    if (live === undefined) {
      throw new PiRpcProcessError('LIVE_SESSION_UNAVAILABLE',
        `No live Pi RPC process is held for Session ${session.id}; a lost process is never reattached`,
        true, true);
    }
    if (session.providerSessionId !== undefined && session.providerSessionId !== live.providerSessionId) {
      throw new PiRpcProcessError('SESSION_IDENTITY_MISMATCH',
        'Session provider identity did not match the live Pi process', true, true);
    }
    if (cursor !== undefined && !cursor.startsWith(live.client.cursorPrefix())) {
      throw new PiRpcProcessError('CURSOR_EPOCH_MISMATCH',
        'Observation cursor belongs to a different Pi process epoch', true, true);
    }
    const evidenceRef = `pi-rpc:agent_settled:session=${live.providerSessionId}`
      + `:epoch=${live.client.epoch}:tools=${createHash('sha256')
        .update(buildPiRpcArguments({ gateExtensionPath: this.gateExtensionPath,
          sessionDir: this.sessionDir, platform: this.#options.platform }).join(' '))
        .digest('hex').slice(0, 16)}`;
    for await (const envelope of live.client.envelopes()) {
      if (envelope.kind === 'disconnected') {
        this.#sessions.delete(session.id);
        yield {
          sessionId: session.id,
          executionId: session.executionId,
          eventId: `pi-disconnect:${envelope.cursor}`,
          cursor: envelope.cursor,
          type: 'disconnected',
          reason: envelope.reason,
        };
        return;
      }
      const attention = mapPiExtensionUiRequest({
        record: envelope.record,
        sessionId: session.id,
        executionId: session.executionId,
        cursor: envelope.cursor,
      });
      if (attention !== null) {
        yield attention;
        continue;
      }
      if (envelope.record.type === 'agent_settled') {
        this.#sessions.delete(session.id);
        // Pi keeps an idle process alive after settling; Phase 1 never reattaches a live
        // process, so the completion evidence is only emitted after our own stop attempt.
        const stopped = await live.client.stop({ graceMs: this.#options.stopGraceMs });
        if (!stopped.exited) this.#unconfirmedStops.push(stopped.pid);
        yield {
          sessionId: session.id,
          executionId: session.executionId,
          eventId: `pi-settled:${envelope.cursor}`,
          cursor: envelope.cursor,
          type: 'completed',
          outcome: 'SUCCESS',
          evidence: { ref: evidenceRef, toolsQuiescent: true, ownedWritersStopped: true },
        };
        return;
      }
    }
  }

  async answer(session: AgentSessionRef, request: AgentAnswerRequest): Promise<AgentControlReceipt> {
    const live = this.#sessions.get(session.id);
    if (live === undefined || session.adapterId !== this.id) {
      throw new PiRpcProcessError('LIVE_SESSION_UNAVAILABLE',
        `No live Pi RPC process is held for Session ${session.id}; the answer was not written`,
        true, true);
    }
    // Pi has no answer acknowledgement: a successful write means "handed to the transport".
    await live.client.write(piExtensionUiResponseRecord({
      providerRequestId: request.providerRequestId,
      responseType: request.responseType,
      answer: request.answer,
    }));
    return { providerRequestId: request.providerRequestId, accepted: true };
  }

  /** Provider PIDs this adapter could not confirm stopped. The Runtime must surface them. */
  unconfirmedStops(): readonly number[] {
    return this.#unconfirmedStops;
  }

  /** Called by the Runtime to release a live child it no longer tracks. */
  async dispose(sessionId: string): Promise<{ readonly exited: boolean; readonly pid: number } | null> {
    const live = this.#sessions.get(sessionId);
    if (live === undefined) return null;
    this.#sessions.delete(sessionId);
    return live.client.stop({ graceMs: this.#options.stopGraceMs });
  }
}
