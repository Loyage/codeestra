import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootServiceId } from '@codeestra/storage';
import { cleanupTemporaryDirectories, registerTemporaryDirectory } from './support/agent-fixture.js';
import { reclaimTestResources, runCli } from './support/runtime-reclamation.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => {
  await reclaimTestResources();
  cleanupTemporaryDirectories();
});

function fixture(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'ce-service-kernel-'));
  registerTemporaryDirectory(home);
  return { CODEESTRA_HOME: home };
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  return await runCli(args, environment, { entry: cliEntry });
}

describe('Service kernel CLI', () => {
  test('lists the stable Service tree and writes metadata only through a durable SIG_A', async () => {
    const environment = fixture();
    try {
      const listed = await cli(['service', 'list', '--json'], environment);
      expect(listed.exitCode).toBe(0);
      const services = JSON.parse(listed.stdout) as { readonly id: string; readonly kind: string }[];
      expect(services.map((service) => service.kind)).toEqual(['ROOT', 'SCHEDULER', 'ATTENTION']);

      const tree = await cli(['service', 'tree', '--json'], environment);
      expect(tree.exitCode).toBe(0);
      expect(JSON.parse(tree.stdout)).toMatchObject([
        { id: rootServiceId, kind: 'ROOT', parentServiceId: null },
        { kind: 'SCHEDULER', parentServiceId: rootServiceId },
        { kind: 'ATTENTION', parentServiceId: rootServiceId },
      ]);

      const set = await cli(['service', 'state', 'set', rootServiceId, '--namespace', 'agent',
        '--key', 'label', '--value-json', '{"name":"root"}', '--expected-version', '0', '--json'],
      environment);
      expect(set.exitCode).toBe(0);
      expect(JSON.parse(set.stdout)).toMatchObject({
        service: { stateVersion: 1, metadata: { 'agent/label': { name: 'root' } } },
        signal: { kind: 'SIG_A', subtype: 'SERVICE_METADATA_SET', state: 'ACKED',
          receipt: { effect: { stateVersion: 1 } } },
      });
      const read = await cli(['service', 'state', 'get', rootServiceId, '--json'], environment);
      expect(JSON.parse(read.stdout)).toMatchObject({ coreVersion: 0, stateVersion: 1,
        metadata: { 'agent/label': { name: 'root' } } });

      const stale = await cli(['service', 'state', 'set', rootServiceId, '--namespace', 'agent',
        '--key', 'label', '--value-json', 'null', '--expected-version', '0'], environment);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr).toContain('SERVICE_VERSION_CONFLICT');
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);

  test('accepts an intention as SIG_P, creates a CREATED Process, and exposes its receipt', async () => {
    const environment = fixture();
    try {
      const sent = await cli(['intent', 'send', 'Draft', 'a', 'plan', '--adapter', 'pi', '--json'],
        environment);
      expect(sent.exitCode).toBe(0);
      const accepted = JSON.parse(sent.stdout) as {
        readonly signal: { readonly id: string; readonly state: string;
          readonly receipt: { readonly effect: { readonly processId: string } } };
        readonly process: { readonly id: string; readonly state: string; readonly objective: string };
        readonly interpretation: string;
      };
      expect(accepted.signal.state).toBe('ACKED');
      expect(accepted.process).toMatchObject({ state: 'CREATED', objective: 'Draft a plan' });
      expect(accepted.process.id).toBe(accepted.signal.receipt.effect.processId);
      expect(accepted.interpretation).toBe('PENDING_S6');

      const process = await cli(['process', 'get', accepted.process.id, '--json'], environment);
      expect(process.exitCode).toBe(0);
      expect(JSON.parse(process.stdout)).toMatchObject({ kind: 'INTENTION', state: 'CREATED',
        parentServiceId: rootServiceId });
      const signals = await cli(['signal', 'list', '--kind', 'SIG_P', '--json'], environment);
      expect(signals.exitCode).toBe(0);
      expect(JSON.parse(signals.stdout)).toHaveLength(1);
      const fetched = await cli(['signal', 'get', accepted.signal.id, '--json'], environment);
      expect(fetched.exitCode).toBe(0);
      expect(JSON.parse(fetched.stdout)).toMatchObject({ state: 'ACKED', attempts: [{ state: 'ACKED' }] });

      const unavailable = await cli(['process', 'input', accepted.process.id,
        '--message', 'continue'], environment);
      expect(unavailable.exitCode).toBe(1);
      expect(unavailable.stderr).toContain('PROCESS_CONTROL_UNAVAILABLE');
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);

  test('uses stable usage and failure exit codes for malformed JSON and incompatible contracts', async () => {
    const environment = fixture();
    try {
      const malformed = await cli(['signal', 'send', rootServiceId, '--kind', 'SIG_A',
        '--subtype', 'SERVICE_METADATA_SET', '--payload-json', '{', '--idempotency-key', 'bad'],
      environment);
      expect(malformed.exitCode).toBe(1);
      expect(malformed.stderr).toContain('--payload-json must be valid JSON');

      const usage = await cli(['service', 'state', 'set', rootServiceId, '--namespace', 'agent'],
        environment);
      expect(usage.exitCode).toBe(2);

      const incompatible = await cli(['signal', 'send', rootServiceId, '--kind', 'SIG_A',
        '--subtype', 'UNKNOWN_SIGNAL', '--payload-json', '{}', '--idempotency-key', 'unknown'],
      environment);
      expect(incompatible.exitCode).toBe(1);
      expect(incompatible.stderr).toContain('SIGNAL_NOT_ACCEPTED');
    } finally {
      await cli(['stop'], environment);
    }
  }, 120_000);
});
