import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionRef, AgentStartRequest } from '@codeestra/contracts';
import { DeterministicFakeAdapter } from '@codeestra/agent-adapters';
import { AdapterRegistry } from '../../runtime/src/adapter-registry.js';
import { AgentRuntimeCoordinator } from '../../runtime/src/agent-runtime-service.js';
import { reconcileSessionTerminals } from '../../runtime/src/recovery-service.js';
import { SessionHandoffService } from '../../runtime/src/session-handoff-service.js';
import { TerminalService, TerminalServiceError } from '../../runtime/src/terminal-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  registerTemporaryDirectory,
  waitFor,
} from './support/agent-fixture.js';

afterEach(() => { cleanupTemporaryDirectories(); });

const providerPid = 5151;
const providerStartToken = 'fake:provider:token';

class ProcessIdentityFakeAdapter extends DeterministicFakeAdapter {
  constructor(private readonly sessionFile: string) { super(); }

  override async start(request: AgentStartRequest): Promise<AgentSessionRef> {
    const session = await super.start(request);
    return {
      ...session,
      // A real provider reports the file it writes; the successor incarnation must reopen exactly it.
      sessionStorageRef: this.sessionFile,
      processIdentity: { pid: providerPid, executable: 'fake-provider',
        startToken: providerStartToken, argvHash: 'fake-argv-hash', capturedAt: 1 },
    };
  }
}

/**
 * The provider of a native terminal, as a *fake*: it prints to its terminal, reads input, appends one
 * entry to the provider session file and exits with a code. The transport, the PTY host, the writer
 * lease, the ownership check and the session-file verification are all real; only Pi itself is
 * replaced, because the real TUI's rendering is a user-visible check this lane cannot make.
 */
function fakeTerminalProvider(options: {
  readonly exitCode?: number;
  /** Ignore the release byte, so the provider does not exit (the unconfirmed-release case). */
  readonly ignoreRelease?: boolean;
  /** Truncate the session file instead of appending (the rewritten-conversation case). */
  readonly rewriteSessionFile?: boolean;
} = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-terminal-provider-'));
  registerTemporaryDirectory(directory);
  const script = join(directory, 'provider.ts');
  writeFileSync(script, `
import { appendFileSync, writeFileSync } from 'node:fs';
const argv = Bun.argv.slice(2);
const sessionIndex = argv.indexOf('--session');
const sessionDirIndex = argv.indexOf('--session-dir');
const sessionFile = sessionIndex >= 0 ? argv[sessionIndex + 1]
  : (sessionDirIndex >= 0 ? argv[sessionDirIndex + 1] + '/fallback.jsonl' : '/tmp/fallback.jsonl');
process.stdout.write('CODEESTRA-FAKE-TUI ready\\n');
process.stdout.write('terminal=' + (process.stdout.isTTY === true ? 'yes' : 'no') + '\\n');
// A native terminal UI switches its terminal to raw mode, so Ctrl+D arrives as a byte instead of
// being interpreted as end-of-input by the line discipline. The fake provider does the same, so the
// release protocol under test is the one a real TUI sees.
Bun.spawnSync(['stty', 'raw', '-echo'], { stdio: ['inherit', 'pipe', 'pipe'] });
// A fact the test can wait for: until this line the terminal is still canonical, and Ctrl+D would
// be read as end-of-input by the line discipline instead of arriving as the release byte.
process.stdout.write('raw-mode=ready\\n');
const decoder = new TextDecoder();
let seen = '';
for await (const chunk of Bun.stdin.stream()) {
  const text = decoder.decode(chunk);
  process.stdout.write('input:' + text.replace(/\\r?\\n/g, '') + '\\n');
  seen += text;
  if (text.includes('SPAWN-ORPHAN')) {
    const { spawn } = await import('node:child_process');
    spawn('nohup', ['bash', '-c', 'sleep 30'], { stdio: 'ignore' });
  }
  // The geometry the provider itself reads from its own terminal: this is how a real TUI learns the
  // size it renders at, so a resize assertion that waits for this line is about the PTY, not about
  // the Runtime's bookkeeping.
  if (text.includes('SIZE?')) {
    const size = Bun.spawnSync(['stty', 'size'], { stdio: ['inherit', 'pipe', 'pipe'] })
      .stdout.toString().trim();
    process.stdout.write('size:' + size + '\\n');
  }
  if (seen.includes('\\u0004')) {
    ${options.ignoreRelease === true ? 'continue;' : `
    if (${options.rewriteSessionFile === true ? 'true' : 'false'}) {
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'rewritten' }) + '\\n');
    } else {
      appendFileSync(sessionFile, JSON.stringify({ type: 'message', id: 'tui-turn-' + Date.now() }) + '\\n');
    }
    process.stdout.write('releasing\\n');
    process.exit(${options.exitCode ?? 0});`}
  }
}
process.exit(${options.exitCode ?? 0});
`);
  const shim = join(directory, 'pi');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

interface Harness {
  readonly storage: ReturnType<typeof createAgentFixture> extends Promise<infer T>
    ? T extends { readonly storage: infer S } ? S : never : never;
  readonly terminals: TerminalService;
  readonly handoff: SessionHandoffService;
  readonly sessionId: string;
  readonly projectId: string;
  readonly sessionFile: string;
  readonly incarnationId: string;
}

/**
 * One running Task (fake RPC provider), then one *real* PTY-hosted native terminal recorded as the
 * successor incarnation — the same sequence `session handoff admit` performs.
 */
async function startHarness(options: Parameters<typeof fakeTerminalProvider>[0] & {
  readonly releaseGraceMs?: number;
  readonly treeRefreshMs?: number;
} = {}): Promise<Harness> {
  const fixture = await createAgentFixture();
  // The provider session file the fake RPC provider claims to write; the fixture supplies the entry
  // history a real provider would have written.
  const sessionDir = join(fixture.home, 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, 'terminal-session.jsonl');
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: 'fake-session' })}\n`
    + `${JSON.stringify({ type: 'message', id: 'rpc-turn-1' })}\n`);
  const adapter = new ProcessIdentityFakeAdapter(sessionFile);
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const coordinator = new AgentRuntimeCoordinator({
    storage: fixture.storage, registry, runtimeHome: fixture.home,
  });
  const run = await coordinator.runTask({
    projectId: fixture.projectId,
    taskId: fixture.taskId,
    expectedTaskVersion: 1,
    commandId: crypto.randomUUID(),
    adapterId: 'fake',
  });
  await coordinator.settle();
  const identity = fixture.storage.getAgentSessionIdentity(run.sessionId);
  expect(identity?.sessionStorageRef).toBe(sessionFile);
  const provider = fakeTerminalProvider(options);
  const terminals = new TerminalService({
    storage: fixture.storage,
    // The real PTY transport with the fake provider as the provider executable: the argv the Runtime
    // composes is used exactly as production composes it.
    piExecutable: provider,
    piSessionDir: sessionDir,
    gateExtensionPath: '/tmp/gate-extension.ts',
    questionExtensionPath: '/tmp/question-extension.ts',
    environment: { PATH: Bun.env.PATH ?? '' },
    permissionMode: () => 'FULL',
    releaseGraceMs: options.releaseGraceMs ?? 8_000,
    treeRefreshMs: options.treeRefreshMs ?? 300,
  });
  const handoff = new SessionHandoffService({
    storage: fixture.storage,
    runtimeHome: fixture.home,
    resolveAdapter: (adapterId) => registry.resolve(adapterId),
    socketPath: join(fixture.home, 'unused-handoff.sock'),
    terminal: terminals,
  });
  // The automation incarnation exists first, exactly as `task.run` records it.
  const automation = await handoff.recordAutomationIncarnation({ sessionId: run.sessionId });
  expect(automation).not.toBeNull();
  // The transition the handoff service performs: end the predecessor, release its lease, launch the
  // successor, record its incarnation, commit the terminal.
  const predecessor = fixture.storage.listSessionIncarnations(run.sessionId)[0]!;
  fixture.storage.markSessionIncarnationExited({
    incarnationId: predecessor.id, at: Date.now(),
    exit: { kind: 'HANDOFF', ownership: 'STOPPED' }, detail: 'test',
  });
  fixture.storage.releaseSessionWriterLeaseForSession({
    sessionId: run.sessionId, reason: 'test handoff', releasedAt: Date.now(),
  });
  const launched = await terminals.launchTerminal({
    sessionId: run.sessionId,
    projectId: fixture.projectId,
    adapterId: 'fake',
    workspacePath: fixture.home,
    sessionFile,
  });
  const incarnation = fixture.storage.recordSessionIncarnation({
    id: crypto.randomUUID(),
    sessionId: run.sessionId,
    mode: 'HUMAN_TUI',
    commandId: `handoff:${crypto.randomUUID()}`,
    providerPid: launched.providerPid,
    processIdentity: { pid: launched.providerPid, startToken: launched.providerStartToken,
      kind: 'PTY_PROVIDER' },
    processTree: launched.processTree,
    providerSessionId: identity?.providerSessionId ?? null,
    sessionStorageRef: sessionFile,
    createdAt: Date.now(),
  });
  terminals.commitTerminal({ launched, incarnationId: incarnation.incarnation.id });
  // A bounded wait for the fact the release decision is built on: the ownership check compares a
  // process tree captured *while the provider was alive*. A launch that raced the provider's startup
  // records none, and the release then refuses as PREDECESSOR_UNVERIFIED — which is the honest
  // production answer, but not the scenario these tests are about. The Runtime refreshes the tree on
  // its own timer, so this waits for that observed fact instead of assuming the first capture won.
  const treeDeadline = Date.now() + 5_000;
  while (Date.now() < treeDeadline
    && (fixture.storage.getSessionIncarnation(incarnation.incarnation.id)?.processTree ?? null)
      === null) {
    await Bun.sleep(25);
  }
  return { storage: fixture.storage, terminals, handoff, sessionId: run.sessionId,
    projectId: fixture.projectId, sessionFile, incarnationId: incarnation.incarnation.id };
}

/**
 * Waits until the provider reports that it has switched its terminal to raw mode. Every release
 * assertion below depends on that fact; waiting for the TUI banner alone assumed a timing
 * relationship between two lines the provider prints, which a loaded machine does not guarantee.
 */
async function waitForRawMode(harness: Harness): Promise<void> {
  await waitFor(() => harness.terminals.read({ sessionId: harness.sessionId }).data
    .includes('raw-mode=ready'));
}

describe('native terminal transport service (ADR-0026)', () => {
  test('records the terminal, projects its stream and gives the second writer ATTACHMENT_BUSY', async () => {
    const harness = await startHarness();
    try {
      const view = harness.terminals.view(harness.sessionId);
      expect(view).toMatchObject({ state: 'RUNNING', held: true, windowSize: 'APPLIED' });
      expect(view?.providerPid).toBeGreaterThan(0);
      expect(view?.writer).toBeNull();
      const record = harness.storage.getRunningSessionTerminal(harness.sessionId);
      expect(record?.sessionFile).toBe(harness.sessionFile);
      expect(record?.entriesAtStart).toBeGreaterThanOrEqual(1);

      // The stream is projected with a cursor; a second read from that cursor returns only new bytes.
      await waitFor(() => harness.terminals.read({ sessionId: harness.sessionId }).data
        .includes('CODEESTRA-FAKE-TUI'));
      const first = harness.terminals.read({ sessionId: harness.sessionId });
      expect(first.running).toBe(true);
      expect(first.data).toContain('terminal=yes');
      const incremental = harness.terminals.read({ sessionId: harness.sessionId, since: first.cursor });
      expect(incremental.data).toBe('');

      // Writing is terminal input, and the provider echoes it from its own terminal.
      harness.terminals.write({ sessionId: harness.sessionId, data: 'hello terminal\n' });
      await waitFor(() => harness.terminals.read({ sessionId: harness.sessionId, since: first.cursor })
        .data.includes('input:hello terminal'));

      // One writer attachment, plus observers; a second writer is refused with the holder named.
      const writer = harness.terminals.attach({ sessionId: harness.sessionId,
        commandId: crypto.randomUUID(), holderRef: 'cli-a', kind: 'WRITER' });
      expect(writer.attachment.kind).toBe('WRITER');
      const observer = harness.terminals.attach({ sessionId: harness.sessionId,
        commandId: crypto.randomUUID(), holderRef: 'ui-b', kind: 'OBSERVER' });
      expect(observer.attachment.kind).toBe('OBSERVER');
      let busy: unknown = null;
      try {
        harness.terminals.attach({ sessionId: harness.sessionId, commandId: crypto.randomUUID(),
          holderRef: 'cli-c', kind: 'WRITER' });
      } catch (error) {
        busy = error;
      }
      expect(busy).toBeInstanceOf(TerminalServiceError);
      expect((busy as TerminalServiceError).code).toBe('ATTACHMENT_BUSY');
      expect((busy as TerminalServiceError).message).toContain('cli-a');
      // The same command ID replays instead of creating a second attachment.
      const replayed = harness.terminals.attach({ sessionId: harness.sessionId,
        commandId: observer.attachment.commandId, holderRef: 'ui-b', kind: 'OBSERVER' });
      expect(replayed.attachment.id).toBe(observer.attachment.id);

      // Detach is client bookkeeping: the provider keeps running and its pid does not change.
      const providerPidBefore = harness.terminals.view(harness.sessionId)?.providerPid;
      const detached = harness.terminals.detach({ sessionId: harness.sessionId, holderRef: 'cli-a',
        reason: 'client went away' });
      expect(detached.detached).toBe(true);
      await Bun.sleep(100);
      const afterDetach = harness.terminals.view(harness.sessionId);
      expect(afterDetach?.state).toBe('RUNNING');
      expect(afterDetach?.providerPid).toBe(providerPidBefore);
      harness.terminals.write({ sessionId: harness.sessionId, data: 'still here\n' });
      await waitFor(() => harness.terminals.read({ sessionId: harness.sessionId }).data
        .includes('input:still here'));
      // Reattach works and the writer slot is free again.
      const again = harness.terminals.attach({ sessionId: harness.sessionId,
        commandId: crypto.randomUUID(), holderRef: 'cli-d', kind: 'WRITER' });
      expect(again.attachment.holderRef).toBe('cli-d');
      // An unauthorized holder cannot detach somebody else's attachment.
      expect(harness.terminals.detach({ sessionId: harness.sessionId, holderRef: 'nobody' }))
        .toMatchObject({ detached: false, code: 'NOT_ATTACHED' });
    } finally {
      await harness.terminals.close();
    }
  }, 60_000);

  test('releases only when the provider exited, the tree is quiescent and the session file survived', async () => {
    // The provider exits with 7 on release: the exit code is audit data, never the criterion.
    const harness = await startHarness({ exitCode: 7 });
    try {
      await waitForRawMode(harness);
      const outcome = await harness.terminals.release({
        sessionId: harness.sessionId, commandId: crypto.randomUUID(),
      });
      expect(outcome.released).toBe(true);
      expect(outcome.exit?.code).toBe(7);
      expect(outcome.predecessorObservation).toBe('STOPPED');
      expect(outcome.sessionFile.predecessorEntrySurvived).toBe(true);
      expect(outcome.sessionFile.entriesAtRelease).toBeGreaterThan(
        outcome.sessionFile.entriesAtStart as number - 1);
      const record = harness.storage.getSessionTerminal(outcome.terminalId as string);
      // The release evidence is persisted: the byte that was written, the requested command, the
      // observed exit and the two session-file facts.
      expect(record?.state).toBe('RELEASED');
      expect(record?.releaseByte).toBe('\u0004');
      expect(record?.releaseCommandId).not.toBeNull();
      expect(record?.exitCode).toBe(7);
      expect(record?.releaseRequestedAt).not.toBeNull();
      expect(record?.entriesAtRelease).not.toBeNull();
      // The session file grew: the entry the provider appended during the release is the one the
      // verification read afterwards, and it is not the entry the predecessor had left behind.
      expect(record?.lastEntryIdAtStart).toBe('rpc-turn-1');
      expect(outcome.sessionFile.lastEntryIdAtRelease).not.toBe('rpc-turn-1');
      // The persisted columns are the facts as they were *before* the release byte; the outcome
      // carries the verified post-release facts.
      expect(record?.lastEntryIdAtRelease).toBe('rpc-turn-1');
      // The released terminal can no longer be attached to or released again.
      expect(() => harness.terminals.attach({ sessionId: harness.sessionId,
        commandId: crypto.randomUUID(), holderRef: 'late', kind: 'WRITER' }))
        .toThrow(TerminalServiceError);
      expect(await harness.terminals.release({ sessionId: harness.sessionId,
        commandId: crypto.randomUUID() })).toMatchObject({
        released: false, code: 'TERMINAL_NOT_RUNNING' });
    } finally {
      await harness.terminals.close();
    }
  }, 60_000);

  test('refuses a release it cannot confirm, and does not kill the provider to get one', async () => {
    const harness = await startHarness({ ignoreRelease: true, releaseGraceMs: 1_500 });
    try {
      await waitForRawMode(harness);
      const outcome = await harness.terminals.release({
        sessionId: harness.sessionId, commandId: crypto.randomUUID(),
      });
      expect(outcome.released).toBe(false);
      expect(outcome.code).toBe('RELEASE_NOT_CONFIRMED');
      expect(outcome.predecessorObservation).toBe('ALIVE');
      // The unconfirmed release is recorded, and the terminal is still the writer: nothing was
      // aborted and no successor may start.
      const record = harness.storage.getRunningSessionTerminal(harness.sessionId);
      expect(record?.releaseRequestedAt).not.toBeNull();
      expect(record?.state).toBe('RUNNING');
      expect(harness.terminals.view(harness.sessionId)?.held).toBe(true);
    } finally {
      await harness.terminals.close();
    }
  }, 60_000);

  test('refuses a release when the provider session file was rewritten', async () => {
    const harness = await startHarness({ rewriteSessionFile: true });
    try {
      await waitForRawMode(harness);
      const outcome = await harness.terminals.release({
        sessionId: harness.sessionId, commandId: crypto.randomUUID(),
      });
      expect(outcome.released).toBe(false);
      expect(outcome.code).toBe('SESSION_FILE_REWRITTEN');
      expect(outcome.exit).not.toBeNull();
    } finally {
      await harness.terminals.close();
    }
  }, 60_000);

  test('refuses a release while a tool child the provider started is still running', async () => {
    const harness = await startHarness();
    try {
      await waitForRawMode(harness);
      // A tool the provider started that outlives it: the release must not hand the conversation
      // over while this process can still write the workspace.
      harness.terminals.write({ sessionId: harness.sessionId, data: 'SPAWN-ORPHAN\n' });
      // Wait for the tool child to appear in the recorded (refreshed) tree.
      const deadline = Date.now() + 10_000;
      let descendants = 0;
      while (Date.now() < deadline) {
        const incarnation = harness.storage.getSessionIncarnation(harness.incarnationId);
        const tree = incarnation?.processTree as { descendants?: readonly unknown[] } | null;
        descendants = tree?.descendants?.length ?? 0;
        if (descendants >= 2) break;
        await Bun.sleep(200);
      }
      expect(descendants).toBeGreaterThanOrEqual(2);
      const outcome = await harness.terminals.release({
        sessionId: harness.sessionId, commandId: crypto.randomUUID(),
      });
      // Either the provider is gone with a live descendant (the orphan case), or the release is
      // refused for a stated reason; what must never happen is `released: true`.
      expect(outcome.released).toBe(false);
      expect(['PREDECESSOR_DESCENDANTS_ALIVE', 'PREDECESSOR_UNVERIFIED'])
        .toContain(outcome.code);
      expect(harness.handoff).toBeDefined();
    } finally {
      await harness.terminals.close();
    }
  }, 60_000);

  test('reconciles a terminal this Runtime no longer holds instead of claiming it stopped', async () => {
    const harness = await startHarness({ ignoreRelease: true });
    try {
      const record = harness.storage.getRunningSessionTerminal(harness.sessionId);
      expect(record).not.toBeNull();
      const reconciled = reconcileSessionTerminals({ storage: harness.storage, now: () => 1234 });
      expect(reconciled.reconciled).toContain(record?.id as string);
      // The recorded processes are reported, never claimed dead: the Runtime did not signal them.
      expect(reconciled.maybeStillRunning[0]).toMatchObject({ terminalId: record?.id });
      const after = harness.storage.getSessionTerminal(record?.id as string);
      expect(after?.state).toBe('RECOVERY_REQUIRED');
      // A second reconcile is a no-op: the fact was already recorded.
      expect(reconcileSessionTerminals({ storage: harness.storage }).reconciled).toHaveLength(0);
    } finally {
      await harness.terminals.close();
    }
  }, 60_000);

  test('keeps the whole handoff on one provider session file and one writer at a time', async () => {
    const harness = await startHarness({ exitCode: 0 });
    try {
      const incarnations = harness.storage.listSessionIncarnations(harness.sessionId);
      expect(incarnations).toHaveLength(2);
      expect(incarnations[0]).toMatchObject({ mode: 'AUTOMATED_RPC', state: 'EXITED' });
      expect(incarnations[1]).toMatchObject({ mode: 'HUMAN_TUI', state: 'ACTIVE' });
      expect(incarnations[1]?.predecessorIncarnationId).toBe(incarnations[0]?.id);
      // Same conversation: the successor reopened the same provider session file.
      expect(incarnations[1]?.sessionStorageRef).toBe(incarnations[0]?.sessionStorageRef);
      // Exactly one writer lease, now held by the terminal incarnation.
      const leases = harness.storage.listSessionWriterLeases(harness.sessionId);
      expect(leases.filter((lease) => lease.releasedAt === null)).toHaveLength(1);
      expect(harness.storage.getSessionWriterLease(harness.sessionId)?.holderKind)
        .toBe('TERMINAL_ATTACHMENT');
      await harness.terminals.close();
      // Ending the terminal releases its lease with a stated reason.
      const leasesAfter = harness.storage.listSessionWriterLeases(harness.sessionId);
      expect(leasesAfter.filter((lease) => lease.releasedAt === null)).toHaveLength(0);
      expect(leasesAfter.at(-1)?.releaseReason).toContain('shutting down');
    } finally {
      await harness.terminals.close();
    }
  }, 60_000);

  test('resizes the held terminal for real, and refuses a size the writer seat does not own', async () => {
    const harness = await startHarness();
    try {
      await waitForRawMode(harness);
      // The launch-time fact is recorded; the *current* geometry is only stated once the Runtime has
      // applied one, because a Runtime that has not resized cannot know what the provider renders at.
      expect(harness.terminals.view(harness.sessionId)?.windowSize).toBe('APPLIED');
      expect(harness.terminals.view(harness.sessionId)?.currentSize).toBeNull();

      const cursor = harness.terminals.read({ sessionId: harness.sessionId }).cursor;
      const resized = await harness.terminals.resize({
        sessionId: harness.sessionId, cols: 90, rows: 30,
      });
      expect(resized).toMatchObject({ cols: 90, rows: 30, applied: 'APPLIED', detail: 'stty' });
      expect(harness.terminals.view(harness.sessionId)?.currentSize)
        .toEqual({ cols: 90, rows: 30 });
      // The provider reads the new size from its own terminal descriptor: the PTY really changed.
      harness.terminals.write({ sessionId: harness.sessionId, data: 'SIZE?\n' });
      await waitFor(() => harness.terminals.read({ sessionId: harness.sessionId, since: cursor })
        .data.includes('size:30 90'));

      // The bound is enforced by the service as well as by the CLI, with its own stable code.
      for (const invalid of [{ cols: 0, rows: 30 }, { cols: 90, rows: -1 }, { cols: 1001, rows: 30 }]) {
        let refusal: unknown = null;
        try {
          await harness.terminals.resize({ sessionId: harness.sessionId, ...invalid });
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toBeInstanceOf(TerminalServiceError);
        expect((refusal as TerminalServiceError).code).toBe('TERMINAL_RESIZE_INVALID_SIZE');
      }
      // The refused sizes changed nothing.
      expect(harness.terminals.view(harness.sessionId)?.currentSize)
        .toEqual({ cols: 90, rows: 30 });

      // A WRITER attachment owns the viewport: another holder (or an anonymous caller) is refused
      // with the writer named, and the writer itself can resize.
      harness.terminals.attach({ sessionId: harness.sessionId, commandId: crypto.randomUUID(),
        holderRef: 'cli-a', kind: 'WRITER' });
      for (const holderRef of [undefined, 'cli-b']) {
        let refusal: unknown = null;
        try {
          await harness.terminals.resize({ sessionId: harness.sessionId, cols: 80, rows: 24,
            ...(holderRef === undefined ? {} : { holderRef }) });
        } catch (error) {
          refusal = error;
        }
        expect((refusal as TerminalServiceError).code).toBe('TERMINAL_RESIZE_WRITER_BUSY');
        expect((refusal as TerminalServiceError).message).toContain('cli-a');
      }
      expect((await harness.terminals.resize({ sessionId: harness.sessionId, cols: 80, rows: 24,
        holderRef: 'cli-a' })).applied).toBe('APPLIED');

      // A Runtime generation that does not hold the terminal cannot resize it: it has no PTY to
      // change, and saying "resized" would be a claim about a process it does not own.
      const otherGeneration = new TerminalService({
        storage: harness.storage,
        piSessionDir: join(tmpdir(), 'codeestra-unused-sessions'),
        gateExtensionPath: '/tmp/gate-extension.ts',
        questionExtensionPath: '/tmp/question-extension.ts',
        environment: { PATH: Bun.env.PATH ?? '' },
        permissionMode: () => 'FULL',
      });
      let notHeld: unknown = null;
      try {
        await otherGeneration.resize({ sessionId: harness.sessionId, cols: 70, rows: 20 });
      } catch (error) {
        notHeld = error;
      }
      expect((notHeld as TerminalServiceError).code).toBe('TERMINAL_NOT_HELD');
    } finally {
      await harness.terminals.close();
    }
  }, 60_000);
});
