export {
  buildPiRpcArguments,
  codeestraPermissionTitlePrefix,
  encodePiExtensionUiResponse,
  encodePiRpcRecord,
  mapPiExtensionUiRequest,
  PiRpcJsonlDecoder,
  PiRpcProtocolError,
  piExtensionUiResponseRecord,
} from './pi-rpc.js';
export { classifyPiTool } from './pi-gate-extension.js';
export type { GateDecision } from './pi-gate-extension.js';
export { readProcessStartToken } from './pi-identity.js';
export { PiRpcClient, PiRpcProcessError } from './pi-process.js';
export type { PiRpcEnvelope, PiRpcErrorCode } from './pi-process.js';
export { PiRpcAdapter } from './pi-adapter.js';
export type { PiRpcAdapterOptions } from './pi-adapter.js';

import type {
  AdapterCapabilities,
  AgentAnswerAdapter,
  AgentAnswerRequest,
  AgentObservedEvent,
  AgentSessionRef,
  AgentStartRequest,
} from '@codeestra/contracts';

export class FakeAdapterStartError extends Error {
  constructor(message: string, readonly startMayHaveOccurred: boolean) {
    super(message);
    this.name = 'FakeAdapterStartError';
  }
}

export type FakeStartMode = 'SUCCEED' | 'FAIL_BEFORE_START' | 'FAIL_AFTER_START';
export type FakeAnswerMode = 'SUCCEED' | 'FAIL_BEFORE_DELIVERY' | 'FAIL_AFTER_DELIVERY';

export class FakeAdapterAnswerError extends Error {
  constructor(message: string, readonly deliveryMayHaveOccurred: boolean) {
    super(message);
    this.name = 'FakeAdapterAnswerError';
  }
}

const capabilities: AdapterCapabilities = Object.freeze({
  persistentSession: 'SUPPORTED',
  structuredAttention: 'SUPPORTED',
  nativePermissionRouting: 'UNSUPPORTED',
  pauseWithQuiescence: 'UNSUPPORTED',
  revisionAcknowledgement: 'UNSUPPORTED',
  cooperativeStop: 'UNSUPPORTED',
  attach: 'STRUCTURED',
  reconnectToLiveSession: 'SUPPORTED',
  resumeAfterExit: 'UNSUPPORTED',
});

export type FakeObservedEvent = Readonly<
  ({ eventId: string; cursor: string } & (
    | { type: 'attention'; providerRequestId: string; kind: 'QUESTION' | 'PERMISSION';
      responseType: 'CONFIRM' | 'VALUE'; prompt: unknown }
    | { type: 'completed'; outcome: 'SUCCESS' | 'FAILURE'; evidenceRef: string }
    | { type: 'disconnected'; reason: string }
  ))
>;

/** Deterministic protocol fake. It does not execute commands or prove a real provider integration. */
export class DeterministicFakeAdapter implements AgentAnswerAdapter {
  readonly id = 'fake';
  readonly #requests = new Map<string, AgentStartRequest>();
  readonly #answers = new Map<string, AgentAnswerRequest>();
  readonly #answerAttempts = new Map<string, number>();

  constructor(
    readonly mode: FakeStartMode = 'SUCCEED',
    readonly events: readonly FakeObservedEvent[] = [],
    readonly answerMode: FakeAnswerMode = 'SUCCEED',
  ) {}

  async probe(): Promise<{ readonly version: string; readonly capabilities: AdapterCapabilities }> {
    return { version: 'fake-1', capabilities };
  }

  async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    const existing = this.#requests.get(request.operationId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(request)) {
      throw new FakeAdapterStartError('Operation ID was reused with a different start request', false);
    }
    if (existing === undefined) this.#requests.set(request.operationId, request);
    if (this.mode === 'FAIL_BEFORE_START') {
      throw new FakeAdapterStartError('Fake failed before creating a session', false);
    }
    if (this.mode === 'FAIL_AFTER_START') {
      throw new FakeAdapterStartError('Fake may have created a session before transport failed', true);
    }
    return {
      id: request.sessionId,
      executionId: request.executionId,
      adapterId: this.id,
      providerSessionId: `fake:${request.sessionId}`,
    };
  }

  async *observe(session: AgentSessionRef, cursor?: string): AsyncIterable<AgentObservedEvent> {
    if (session.adapterId !== this.id || session.providerSessionId === undefined) {
      throw new Error('Fake observe received a mismatched Session');
    }
    let start = 0;
    if (cursor !== undefined) {
      const index = this.events.findIndex((event) => event.cursor === cursor);
      if (index < 0) throw new Error(`Fake does not recognize cursor ${cursor}`);
      start = index + 1;
    }
    for (const event of this.events.slice(start)) {
      const identity = {
        sessionId: session.id,
        executionId: session.executionId,
        eventId: event.eventId,
        cursor: event.cursor,
      };
      if (event.type === 'attention') {
        yield { ...identity, type: event.type, providerRequestId: event.providerRequestId,
          kind: event.kind, responseType: event.responseType, prompt: event.prompt };
      } else if (event.type === 'disconnected') {
        yield { ...identity, type: event.type, reason: event.reason };
      } else {
        yield { ...identity, type: event.type, outcome: event.outcome,
          evidence: { ref: event.evidenceRef, toolsQuiescent: true, ownedWritersStopped: true } };
      }
    }
  }

  async answer(session: AgentSessionRef, request: AgentAnswerRequest): Promise<{
    readonly providerRequestId: string; readonly accepted: true;
  }> {
    if (session.adapterId !== this.id || session.providerSessionId === undefined) {
      throw new FakeAdapterAnswerError('Fake answer received a mismatched Session', false);
    }
    this.#answerAttempts.set(request.operationId, (this.#answerAttempts.get(request.operationId) ?? 0) + 1);
    const existing = this.#answers.get(request.operationId);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(request)) {
        throw new FakeAdapterAnswerError('Answer Operation ID was reused with different content', true);
      }
      return { providerRequestId: request.providerRequestId, accepted: true };
    }
    if (this.answerMode === 'FAIL_BEFORE_DELIVERY') {
      throw new FakeAdapterAnswerError('Fake failed before delivering the answer', false);
    }
    this.#answers.set(request.operationId, request);
    if (this.answerMode === 'FAIL_AFTER_DELIVERY') {
      throw new FakeAdapterAnswerError('Fake may have delivered the answer before transport failed', true);
    }
    return { providerRequestId: request.providerRequestId, accepted: true };
  }

  startCount(operationId: string): number {
    return this.#requests.has(operationId) ? 1 : 0;
  }

  answerAttemptCount(operationId: string): number {
    return this.#answerAttempts.get(operationId) ?? 0;
  }
}
