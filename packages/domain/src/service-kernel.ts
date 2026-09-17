import { DomainError, requireText, requireVersion } from './errors.js';

export const serviceKinds = ['ROOT', 'SCHEDULER', 'ATTENTION', 'PROJECT', 'TASK'] as const;
export type ServiceKind = (typeof serviceKinds)[number];
export type ServiceLifecycle = 'ACTIVE' | 'PAUSED' | 'RECOVERY_REQUIRED' | 'RETIRED';

export interface ServiceNode {
  readonly id: string;
  readonly kind: ServiceKind;
  readonly parentServiceId: string | null;
}

/** Pure validation for one complete Service tree. It never returns a partially accepted tree. */
export function validateServiceTree(nodes: readonly ServiceNode[]): readonly ServiceNode[] {
  const byId = new Map<string, ServiceNode>();
  for (const node of nodes) {
    requireText(node.id, 'Service id');
    if (byId.has(node.id)) throw new DomainError('DUPLICATE_SERVICE', `Service ${node.id} is duplicated`);
    byId.set(node.id, node);
  }
  const roots = nodes.filter((node) => node.kind === 'ROOT');
  if (roots.length !== 1) throw new DomainError('INVALID_SERVICE_TREE', 'A Service tree has exactly one ROOT');
  const root = roots[0] as ServiceNode;
  if (root.parentServiceId !== null) {
    throw new DomainError('INVALID_SERVICE_PARENT', 'ROOT cannot have a parent');
  }
  const systemKinds = new Set<ServiceKind>(['SCHEDULER', 'ATTENTION']);
  for (const node of nodes) {
    if (node.id === root.id) continue;
    if (node.parentServiceId === null) {
      throw new DomainError('INVALID_SERVICE_PARENT', `${node.kind} Service requires a parent`);
    }
    const parent = byId.get(node.parentServiceId);
    if (parent === undefined) {
      throw new DomainError('INVALID_SERVICE_PARENT', `Parent ${node.parentServiceId} does not exist`);
    }
    if (node.kind === 'TASK' && parent.kind !== 'PROJECT') {
      throw new DomainError('INVALID_SERVICE_PARENT', 'TASK Service must be a direct child of PROJECT');
    }
    if ((node.kind === 'PROJECT' || systemKinds.has(node.kind)) && parent.kind !== 'ROOT') {
      throw new DomainError('INVALID_SERVICE_PARENT', `${node.kind} Service must be a direct child of ROOT`);
    }
  }
  for (const node of nodes) {
    const seen = new Set<string>();
    let cursor: ServiceNode | undefined = node;
    while (cursor !== undefined) {
      if (seen.has(cursor.id)) throw new DomainError('SERVICE_TREE_CYCLE', `Service tree contains a cycle at ${cursor.id}`);
      seen.add(cursor.id);
      cursor = cursor.parentServiceId === null ? undefined : byId.get(cursor.parentServiceId);
    }
  }
  return Object.freeze(nodes.map((node) => Object.freeze({ ...node })));
}

export const maxServiceMetadataBytes = 65_536;
const metadataSegment = /^[a-z][a-z0-9_.-]{0,62}$/;
export interface ServiceMetadataState {
  readonly serviceId: string;
  readonly stateVersion: number;
  readonly entries: Readonly<Record<string, unknown>>;
}

export function serviceMetadataKey(namespace: string, key: string): string {
  if (!metadataSegment.test(namespace) || namespace === 'core' || namespace === 'codeestra') {
    throw new DomainError('INVALID_METADATA_KEY', 'Metadata namespace must be a non-reserved lowercase name');
  }
  if (!metadataSegment.test(key)) {
    throw new DomainError('INVALID_METADATA_KEY', 'Metadata key must be a lowercase name');
  }
  return `${namespace}/${key}`;
}

/** CAS reducer for metadata only. Core state is absent from the input, so this API cannot mutate it. */
export function setServiceMetadata(input: {
  readonly state: ServiceMetadataState;
  readonly expectedVersion: number;
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
}): ServiceMetadataState {
  requireVersion(input.state.stateVersion, input.expectedVersion);
  const fullKey = serviceMetadataKey(input.namespace, input.key);
  let encoded: string;
  try {
    encoded = JSON.stringify(input.value) as string;
  } catch {
    throw new DomainError('INVALID_METADATA_VALUE', 'Metadata value must be JSON serializable');
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > maxServiceMetadataBytes) {
    throw new DomainError('INVALID_METADATA_VALUE', `Metadata value exceeds ${maxServiceMetadataBytes} bytes`);
  }
  return Object.freeze({
    serviceId: input.state.serviceId,
    stateVersion: input.state.stateVersion + 1,
    entries: Object.freeze({ ...input.state.entries, [fullKey]: JSON.parse(encoded) as unknown }),
  });
}

export const signalKinds = ['SIG_A', 'SIG_P'] as const;
export type SignalKind = (typeof signalKinds)[number];
export const signalStates = ['PENDING', 'CLAIMED', 'RETRYABLE', 'ACKED', 'DEAD_LETTER',
  'RECOVERY_REQUIRED'] as const;
export type SignalState = (typeof signalStates)[number];

export interface SignalEnvelope {
  readonly id: string;
  readonly kind: SignalKind;
  readonly subtype: string;
  readonly sourceServiceId: string | null;
  readonly sourceProcessId: string | null;
  readonly targetServiceId: string;
  readonly contractVersion: number;
  readonly payload: unknown;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly priority: number;
  readonly createdAt: number;
}

export function signalDedupeKey(signal: Pick<SignalEnvelope, 'targetServiceId' | 'idempotencyKey'>): string {
  requireText(signal.targetServiceId, 'Signal target');
  requireText(signal.idempotencyKey, 'Signal idempotency key');
  return `${signal.targetServiceId}\u0000${signal.idempotencyKey}`;
}

export function transitionSignal(state: SignalState, action: 'CLAIM' | 'ACK' | 'NACK_RETRY'
  | 'NACK_DEAD' | 'RETRY' | 'RECOVERY_REQUIRED'): SignalState {
  const transitions: Readonly<Record<SignalState, Readonly<Partial<Record<typeof action, SignalState>>>>> = {
    PENDING: { CLAIM: 'CLAIMED' },
    CLAIMED: { ACK: 'ACKED', NACK_RETRY: 'RETRYABLE', NACK_DEAD: 'DEAD_LETTER',
      RECOVERY_REQUIRED: 'RECOVERY_REQUIRED' },
    RETRYABLE: { CLAIM: 'CLAIMED', RETRY: 'PENDING' },
    ACKED: {},
    DEAD_LETTER: { RETRY: 'PENDING' },
    RECOVERY_REQUIRED: { RETRY: 'PENDING' },
  };
  const next = transitions[state][action];
  if (next === undefined) {
    throw new DomainError('INVALID_SIGNAL_TRANSITION', `Cannot ${action} a ${state} Signal`);
  }
  return next;
}

export const processKinds = ['DEVELOPMENT', 'INTENTION', 'INTEGRATION'] as const;
export type ProcessKind = (typeof processKinds)[number];
export const processStates = ['CREATED', 'STARTING', 'RUNNING', 'WAITING_FOR_USER', 'PAUSING',
  'PAUSED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'] as const;
export type ProcessState = (typeof processStates)[number];
const terminalProcessStates = new Set<ProcessState>(['SUCCEEDED', 'FAILED', 'CANCELLED']);

export function transitionProcess(state: ProcessState, next: ProcessState): ProcessState {
  if (terminalProcessStates.has(state)) {
    throw new DomainError('PROCESS_TERMINAL', `Terminal Process ${state} cannot transition to ${next}`);
  }
  const allowed: Readonly<Record<ProcessState, readonly ProcessState[]>> = {
    CREATED: ['STARTING', 'CANCELLED', 'FAILED'],
    STARTING: ['RUNNING', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'],
    RUNNING: ['WAITING_FOR_USER', 'PAUSING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'],
    WAITING_FOR_USER: ['RUNNING', 'PAUSING', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'],
    PAUSING: ['PAUSED', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'],
    PAUSED: ['STARTING', 'CANCELLED', 'RECOVERY_REQUIRED'],
    SUCCEEDED: [], FAILED: [], CANCELLED: [],
    RECOVERY_REQUIRED: ['FAILED', 'CANCELLED'],
  };
  if (!allowed[state].includes(next)) {
    throw new DomainError('INVALID_PROCESS_TRANSITION', `Cannot transition Process ${state} to ${next}`);
  }
  return next;
}

export function assertSinglePrimaryAgent(processState: ProcessState, primaryAgentIds: readonly string[]): void {
  const active = !terminalProcessStates.has(processState) && processState !== 'CREATED';
  if (active && primaryAgentIds.length !== 1) {
    throw new DomainError('PROCESS_AGENT_CARDINALITY', 'An active Process has exactly one primary Agent');
  }
  if (primaryAgentIds.length > 1) {
    throw new DomainError('PROCESS_AGENT_CARDINALITY', 'A Process cannot have multiple primary Agents');
  }
}

export interface TaskEligibility {
  readonly taskServiceId: string;
  readonly revisionId: string;
  readonly eligible: boolean;
  readonly reasons: readonly ('DEPENDENCY' | 'CONFLICT' | 'REVISION' | 'CONTROL')[];
  readonly evidenceVersion: number;
}

export function assertEligibilityVersion(eligibility: TaskEligibility, expectedVersion: number): void {
  requireVersion(eligibility.evidenceVersion, expectedVersion);
}
