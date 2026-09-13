import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PiRpcAdapter } from '@codeestra/agent-adapters';
import type { AgentAnswerAdapter } from '@codeestra/contracts';

export class AdapterRegistryError extends Error {
  constructor(readonly code: 'DUPLICATE_ADAPTER' | 'UNKNOWN_ADAPTER', message: string) {
    super(message);
    this.name = 'AdapterRegistryError';
  }
}

/**
 * Process-wide registry of Agent Adapters. A registry holds exactly one instance per
 * Adapter ID, because an Adapter owns the provider processes it can observe or answer.
 */
export class AdapterRegistry {
  readonly #adapters = new Map<string, AgentAnswerAdapter>();

  register(adapter: AgentAnswerAdapter): void {
    if (adapter.id.trim().length === 0) {
      throw new AdapterRegistryError('DUPLICATE_ADAPTER', 'Agent Adapter ID must not be blank');
    }
    if (this.#adapters.has(adapter.id)) {
      throw new AdapterRegistryError('DUPLICATE_ADAPTER', `Agent Adapter ${adapter.id} is already registered`);
    }
    this.#adapters.set(adapter.id, adapter);
  }

  resolve(adapterId: string): AgentAnswerAdapter {
    const adapter = this.#adapters.get(adapterId);
    if (adapter === undefined) {
      throw new AdapterRegistryError('UNKNOWN_ADAPTER', `No Agent Adapter is registered for ${adapterId}`);
    }
    return adapter;
  }

  has(adapterId: string): boolean {
    return this.#adapters.has(adapterId);
  }

  ids(): readonly string[] {
    return [...this.#adapters.keys()];
  }
}

/**
 * The directory the Pi Adapter is allowed to keep provider session files in. It is also the
 * ownership boundary for transcript reads, so both the writer and the reader must agree on it.
 */
export function piSessionDirectory(input: {
  readonly runtimeHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): string {
  return (input.environment ?? {})['CODEESTRA_PI_SESSION_DIR']
    ?? join(input.runtimeHome, 'pi-sessions');
}

/**
 * Phase 1 production registry. Pi is the only registered Adapter; a deterministic fake is
 * never registered here because a fake Session must not be reported as a real execution.
 */
export function createPiAdapterRegistry(input: {
  readonly runtimeHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): AdapterRegistry {
  const environment = input.environment ?? {};
  // The Adapter spawns the provider process, so it needs the real environment: an empty env has no
  // PATH and `pi` could never be launched from the production Runtime.
  const adapterEnvironment: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) adapterEnvironment[name] = value;
  }
  const gateExtensionPath = environment['CODEESTRA_PI_GATE_EXTENSION']
    ?? resolve(import.meta.dir, '../../../packages/agent-adapters/src/pi-gate-extension.ts');
  const sessionDir = piSessionDirectory({ runtimeHome: input.runtimeHome, environment });
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  // Model, provider, and thinking level are not baked in here: the Runtime resolves them per
  // Execution from the environment, project, and global Agent configuration scopes and passes
  // the effective values in the start request. Nothing is pinned at process start, so a
  // configuration change applies to the next Session without restarting the Runtime.
  const registry = new AdapterRegistry();
  registry.register(new PiRpcAdapter({
    piExecutable: environment['CODEESTRA_PI_EXECUTABLE'] ?? 'pi',
    gateExtensionPath,
    sessionDir,
    platform: environment['CODEESTRA_PI_PLATFORM'] === 'windows' ? 'windows' : 'unix',
    environment: adapterEnvironment,
  }));
  return registry;
}
