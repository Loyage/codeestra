import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  declaredProviderProcessSuspension,
  DeterministicFakeAdapter,
  readProcessStartToken,
} from '@codeestra/agent-adapters';
import type { AdapterSupport } from '@codeestra/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  Phase1Database,
  type ActiveProviderIncarnation,
} from '@codeestra/storage';
import type { AgentAnswerAdapter } from '@codeestra/contracts';
import { AdapterRegistry } from '../src/adapter-registry.js';
import { AgentRuntimeCoordinator } from '../src/agent-runtime-service.js';
import {
  RuntimeGlobalControlService,
  RuntimeControlMutex,
  systemProcessControl,
  type RuntimeProcessControl,
} from '../src/runtime-control-service.js';
import {
  cleanupTemporaryDirectories,
  createAgentFixture,
  registerTemporaryDirectory,
  type AgentFixture,
} from './support/agent-fixture.js';

/**
 * The Runtime global load control plane (FOUNDATION-097 / ADR-0061 D04–D10).
 *
 * Two kinds of evidence are mixed here on purpose, and neither one stands in for the other:
 *
 *  - **Real POSIX processes.** Every frozen target is a real `sh` child with a real tool child of its
 *    own, and `SIGSTOP`/`SIGCONT`/process state come from the machine — never from a stub. This is
 *    what makes "the recorded identity still matches and the process really is stopped" a fact here
 *    rather than a restatement of the code.
 *  - **Injected adapter declarations.** The `providerProcessSuspension` values are supplied through
 *    the same callback the Runtime wires to `declaredProviderProcessSuspension`, so the fail-closed
 *    gate is exercised against the *real* declaration table for Codex and Claude and against a
 *    test-only `SUPPORTED` for the deterministic fake (which starts no provider at all).
 *
 * Nothing here is evidence about a real Agent integration: the real-provider process measurement is
 * `docs/spikes/pi-0.84.4.md` §「Provider 进程冻结（ADR-0061）」.
 */

afterEach(() => { cleanupTemporaryDirectories(); });

let counter = 0;
const nextId = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

const support: Readonly<Record<string, AdapterSupport>> = Object.freeze({
  ...declaredProviderProcessSuspension,
  // The deterministic fake owns no provider process, so this value describes the *test's* subject
  // (the real child spawned below), not the fake. It is supplied through the declaration callback so
  // the service reads it exactly as it reads the production table.
  fake: 'SUPPORTED',
});

/** One real process tree: a main process and the tool child it started. */
interface RealProcessTree {
  readonly providerPid: number;
  readonly providerStartToken: string;
  readonly marker: string;
  stop(): Promise<void>;
  toolChildPid(): Promise<number | null>;
}

const trees: RealProcessTree[] = [];

/**
 * A real provider main process whose *tool child* keeps writing to a marker file every second. The
 * marker is what makes "the tool was not signalled" an observation instead of an assumption: if the
 * tool received a stopping signal, or if the parent stopped running it, the file would stop growing.
 */
async function spawnRealTree(): Promise<RealProcessTree> {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-glc2-tree-'));
  registerTemporaryDirectory(directory);
  const marker = join(directory, 'tool.marker');
  // The shape the real measurement has (docs/spikes/pi-0.84.4.md): the main process *starts a tool
  // and waits for it*. The tool is therefore an independent process that keeps making progress while
  // its parent is stopped — which is exactly the claim under test. A single `sh` running the loop
  // itself would prove nothing, because stopping it would obviously stop its own loop.
  //
  // The tool lives in its own script file so no shell can fold the two levels into one process by
  // `exec`-ing a lone command; `& wait` additionally keeps the parent in a real wait.
  const toolScript = join(directory, 'tool.sh');
  await Bun.write(toolScript, `#!/bin/sh\nwhile :; do echo tick >> ${marker}; sleep 1; done\n`);
  const child = Bun.spawn(['sh', '-c', `sh ${toolScript} & wait`], {
    stdout: 'ignore', stderr: 'ignore',
  });
  const startToken = await readProcessStartToken(child.pid);
  if (startToken === null) throw new Error('the test provider process has no start token');
  const tree: RealProcessTree = {
    providerPid: child.pid,
    providerStartToken: startToken,
    marker,
    async stop(): Promise<void> {
      try { process.kill(child.pid, 'SIGCONT'); } catch { /* already gone */ }
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      await child.exited.catch(() => 0);
    },
    async toolChildPid(): Promise<number | null> {
      const probe = Bun.spawn(['pgrep', '-P', String(child.pid)], { stdout: 'pipe', stderr: 'ignore' });
      const [code, stdout] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
      if (code !== 0) return null;
      const first = stdout.trim().split('\n')[0]?.trim();
      const pid = Number(first);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    },
  };
  trees.push(tree);
  return tree;
}

afterEach(async () => {
  for (const tree of trees.splice(0)) await tree.stop();
});

async function processState(pid: number): Promise<string> {
  const probe = Bun.spawn(['ps', '-o', 'stat=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
  const [code, stdout] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
  return code === 0 ? stdout.trim() : 'GONE';
}

async function markerLines(path: string): Promise<number> {
  try {
    return (await Bun.file(path).text()).split('\n').filter((line) => line.trim() !== '').length;
  } catch { return 0; }
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 5_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A deterministic fake registered under another Adapter id, so one fixture can hold two Sessions. */
/**
 * The deterministic fake under another Adapter id. `DeterministicFakeAdapter.id` is the literal
 * `'fake'`, and a fixture that needs two Sessions under different Adapter ids needs two registry
 * entries; this forwards every call and changes only the name the registry keys it by.
 */
function identifiedAs(id: string): AgentAnswerAdapter {
  const fake = new DeterministicFakeAdapter();
  // The fake reports its own id in the Session it returns and validates it when it is observed or
  // answered, so the wrapper substitutes the name on the way in and on the way out.
  const asFake = <T extends { readonly adapterId: string }>(session: T): T =>
    ({ ...session, adapterId: fake.id });
  return {
    id,
    probe: () => fake.probe(),
    start: async (request) => ({ ...await fake.start(request), adapterId: id }),
    observe: (session, cursor) => fake.observe(asFake(session), cursor),
    answer: (session, request) => fake.answer(asFake(session), request),
  };
}

interface Harness {
  readonly fixture: AgentFixture;
  readonly service: RuntimeGlobalControlService;
  readonly coordinator: AgentRuntimeCoordinator;
  readonly registry: AdapterRegistry;
  readonly control: RuntimeProcessControl;
  target(adapterId: string, taskId: string, tree: RealProcessTree,
    tokenOverride?: string): Promise<{ sessionId: string; executionId: string }>;
}

async function harness(options: {
  readonly filename?: string;
  readonly control?: RuntimeProcessControl;
} = {}): Promise<Harness> {
  const fixture = await createAgentFixture(
    options.filename === undefined ? {} : { databaseFilename: options.filename });
  return await bind(fixture, options.control ?? systemProcessControl(), fixture.storage);
}

/**
 * Bind the control plane and the coordinator to an *already existing* fixture and database. A
 * restart test uses this for its second boot: the same home and the same rows, a new Runtime.
 */
async function bind(fixture: AgentFixture, control: RuntimeProcessControl,
  storage: Phase1Database): Promise<Harness> {
  const registry = new AdapterRegistry();
  for (const id of ['fake', 'codex']) registry.register(identifiedAs(id));
  const service = new RuntimeGlobalControlService({
    storage,
    adapterSupport: () => support,
    control,
    mutex: new RuntimeControlMutex(),
  });
  const coordinator = new AgentRuntimeCoordinator({
    storage,
    registry,
    runtimeHome: fixture.home,
    control: service,
  });
  return {
    fixture,
    service,
    coordinator,
    registry,
    control,
    async target(adapterId, taskId, tree, tokenOverride) {
      const run = await coordinator.runTask({
        projectId: fixture.projectId,
        taskId,
        expectedTaskVersion: 1,
        commandId: nextId(),
        adapterId,
      });
      storage.recordSessionIncarnation({
        id: nextId(),
        sessionId: run.sessionId,
        mode: 'AUTOMATED_RPC',
        commandId: `automation:${run.sessionId}`,
        providerPid: tree.providerPid,
        processIdentity: {
          pid: tree.providerPid,
          executable: 'sh',
          startToken: tokenOverride ?? tree.providerStartToken,
          argvHash: 'glc2-test-argv',
          capturedAt: 1,
        },
        processTree: null,
        providerSessionId: `fake:${run.sessionId}`,
        sessionStorageRef: `${fixture.home}/sessions/fake.jsonl`,
        createdAt: 10,
      });
      return { sessionId: run.sessionId, executionId: run.executionId };
    },
  };
}

function addTask(storage: Phase1Database, projectId: string, specification: string): void {
  const taskId = nextId();
  storage.createTask({
    projectId,
    commandId: nextId(),
    payloadHash: `create-${taskId}`,
    intentId: nextId(),
    taskId,
    revisionId: nextId(),
    intentEventId: nextId(),
    taskEventId: nextId(),
    specification,
    constraints: [],
    features: [],
    kind: 'DEVELOPMENT',
    actor: 'local-user',
    createdAt: Date.now(),
  });
  storage.submitTask({
    projectId,
    taskId,
    expectedVersion: 0,
    commandId: nextId(),
    payloadHash: `submit-${taskId}`,
    eventId: nextId(),
    actor: 'local-user',
    submittedAt: Date.now(),
  });
}

function controlRow(storage: Phase1Database): { state: string; pause_epoch: number } {
  const row = storage.sqlite.query<{ state: string; pause_epoch: number }, []>(
    'SELECT state,pause_epoch FROM runtime_pause_control WHERE singleton_id=1').get();
  if (row === null || row === undefined) throw new Error('the control row disappeared');
  return row;
}

function globalEvents(storage: Phase1Database): readonly string[] {
  return storage.sqlite.query<{ event_type: string; project_id: string | null }, []>(`
    SELECT event_type,project_id FROM domain_events
    WHERE aggregate_type='RuntimeSchedulerControl' ORDER BY sequence
  `).all().map((row) => row.event_type);
}

describe('Runtime global load control (ADR-0061)', () => {
  test('freezes the recorded provider main process, leaves its tool child untouched, and only then says PAUSED', async () => {
    const h = await harness();
    const tree = await spawnRealTree();
    const toolPid = await waitFor(() => tree.toolChildPid());
    expect(toolPid).not.toBeNull();
    const target = await h.target('fake', h.fixture.taskId, tree);

    const paused = await h.service.pause({ commandId: nextId(), actor: 'local-user' });
    expect(paused.code).toBeNull();
    expect(paused.view.state).toBe('PAUSED');
    expect(paused.view.pauseEpoch).toBe(1);
    expect(paused.view.targets).toHaveLength(1);
    const targetView = paused.view.targets[0];
    expect(targetView?.state).toBe('STOPPED');
    expect(targetView?.observation.code).toBe('STOPPED');
    expect(targetView?.observation.identityMatched).toBe(true);
    expect(targetView?.observation.processState).toBe('STOPPED');
    expect(targetView?.sessionId).toBe(target.sessionId);
    expect(targetView?.providerStartToken).toBe(tree.providerStartToken);

    // The real process really is stopped, and its identity did not change.
    expect(await processState(tree.providerPid)).toBe('T');
    expect(await readProcessStartToken(tree.providerPid)).toBe(tree.providerStartToken);
    // The tool child is *not* stopped, and it keeps running while its parent is frozen.
    const before = await markerLines(tree.marker);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await markerLines(tree.marker)).toBeGreaterThan(before);
    expect(await processState(toolPid as number)).not.toBe('T');

    // Requested is not Paused: both facts are recorded, in order, and with no Project.
    const events = globalEvents(h.fixture.storage);
    expect(events).toEqual(['SchedulerGlobalPauseRequested', 'SchedulerGlobalPaused']);
    const projectIds = h.fixture.storage.sqlite.query<{ project_id: string | null }, []>(
      "SELECT project_id FROM domain_events WHERE aggregate_type='RuntimeSchedulerControl'").all();
    expect(projectIds.every((row) => row.project_id === null)).toBe(true);

    const resumed = await h.service.resume({ commandId: nextId(), actor: 'local-user' });
    expect(resumed.code).toBeNull();
    expect(resumed.view.state).toBe('RUNNING');
    expect(resumed.view.targets[0]?.state).toBe('RESUMED');
    expect(await processState(tree.providerPid)).toBe('S');
    expect(globalEvents(h.fixture.storage).at(-1)).toBe('SchedulerGlobalResumed');

    // The Task/Execution/Session keep their own states throughout: the barrier is not a Task pause.
    const session = h.fixture.storage.sqlite.query<{ state: string }, [string]>(
      'SELECT state FROM agent_sessions WHERE id=?1').get(target.sessionId);
    expect(session?.state).toBe('ACTIVE');
    const execution = h.fixture.storage.sqlite.query<{ state: string; resource_held: number }, [string]>(
      'SELECT state,resource_held FROM executions WHERE id=?1').get(target.executionId);
    expect(execution).toEqual({ state: 'RUNNING', resource_held: 1 });
  });

  test('refuses to freeze a target whose recorded identity cannot be verified and never says PAUSED', async () => {
    const h = await harness();
    const tree = await spawnRealTree();
    await h.target('fake', h.fixture.taskId, tree, 'a-different-start-token');

    const paused = await h.service.pause({ commandId: nextId(), actor: 'local-user' });
    expect(paused.code).toBe('GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE');
    expect(paused.view.state).toBe('RECOVERY_REQUIRED');
    expect(paused.view.targets[0]?.state).toBe('RECOVERY_REQUIRED');
    expect(paused.view.targets[0]?.observation.identityMatched).toBe(false);
    // Nothing was signalled: the process is still running.
    expect(await processState(tree.providerPid)).toBe('S');
    expect(globalEvents(h.fixture.storage)).toEqual([
      'SchedulerGlobalPauseRequested', 'SchedulerGlobalControlRecoveryRequired',
    ]);
  });

  test('a target whose Adapter has not measured the capability is not signalled and is not counted as frozen', async () => {
    // `codex` is the real declaration table's entry and says REQUIRES_VALIDATION: the gate must fail
    // closed instead of freezing on a hope.
    const h = await harness();
    const tree = await spawnRealTree();
    await h.target('codex', h.fixture.taskId, tree);

    const paused = await h.service.pause({ commandId: nextId(), actor: 'local-user' });
    expect(paused.code).toBe('GLOBAL_PAUSE_UNSUPPORTED');
    expect(paused.view.state).toBe('RECOVERY_REQUIRED');
    expect(paused.view.targets[0]?.state).toBe('RECOVERY_REQUIRED');
    expect(paused.view.targets[0]?.observation.adapterSupport).toBe('REQUIRES_VALIDATION');
    expect(await processState(tree.providerPid)).toBe('S');
  });

  test('a partial freeze keeps the frozen target frozen and reports RECOVERY_REQUIRED', async () => {
    const h = await harness();
    const frozen = await spawnRealTree();
    const unverifiable = await spawnRealTree();
    addTask(h.fixture.storage, h.fixture.projectId, 'The second Task of this project');
    const secondTask = h.fixture.storage.listTasks(h.fixture.projectId)
      .find((task) => task.id !== h.fixture.taskId);
    if (secondTask === undefined) throw new Error('the second Task was not created');
    await h.target('fake', h.fixture.taskId, frozen);
    await h.target('fake', secondTask.id, unverifiable, 'a-different-start-token');

    const paused = await h.service.pause({ commandId: nextId(), actor: 'local-user' });
    expect(paused.code).toBe('GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE');
    expect(paused.view.state).toBe('RECOVERY_REQUIRED');
    const byState = paused.view.targets.map((target) => target.state).sort();
    expect(byState).toEqual(['RECOVERY_REQUIRED', 'STOPPED']);
    // The successfully frozen target stays frozen: a tidy result is never bought by thawing it.
    expect(await processState(frozen.providerPid)).toBe('T');
    expect(await processState(unverifiable.providerPid)).toBe('S');
  });

  test('resume never continues a pid whose identity changed, and never resurrects an exited one', async () => {
    const h = await harness();
    const changed = await spawnRealTree();
    await h.target('fake', h.fixture.taskId, changed);
    expect((await h.service.pause({ commandId: nextId(), actor: 'local-user' })).view.state).toBe('PAUSED');

    // Simulate pid reuse: the recorded token no longer matches the live process.
    h.fixture.storage.sqlite.query(
      "UPDATE runtime_pause_targets SET provider_start_token='reused-elsewhere'").run();
    const resumed = await h.service.resume({ commandId: nextId(), actor: 'local-user' });
    expect(resumed.code).toBe('GLOBAL_RESUME_TARGET_CHANGED');
    expect(resumed.view.state).toBe('RECOVERY_REQUIRED');
    expect(resumed.view.targets[0]?.state).toBe('RECOVERY_REQUIRED');
    // The wrong process was never woken.
    expect(await processState(changed.providerPid)).toBe('T');

    // A target that exited while the barrier was up is closed as EXITED, not resurrected, and a
    // resume whose every target has resolved settles RUNNING.
    const exited = await spawnRealTree();
    const second = await harness();
    await second.target('fake', second.fixture.taskId, exited);
    expect((await second.service.pause({ commandId: nextId(), actor: 'local-user' })).view.state)
      .toBe('PAUSED');
    await exited.stop();
    expect(await waitFor(async () => (await processState(exited.providerPid)) === 'GONE' ? true : null))
      .toBe(true);
    const afterExit = await second.service.resume({ commandId: nextId(), actor: 'local-user' });
    expect(afterExit.code).toBeNull();
    expect(afterExit.view.state).toBe('RUNNING');
    expect(afterExit.view.targets[0]?.state).toBe('EXITED');
  });

  test('the barrier survives a restart, startup signals nothing, and a start is refused before it writes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-glc2-home-'));
    registerTemporaryDirectory(directory);
    const filename = join(directory, 'runtime.sqlite');
    const first = await harness({ filename });
    const tree = await spawnRealTree();
    await first.target('fake', first.fixture.taskId, tree);
    expect((await first.service.pause({ commandId: nextId(), actor: 'local-user' })).view.state)
      .toBe('PAUSED');
    const executionsBefore = first.fixture.storage.sqlite.query<{ rows: number }, []>(
      'SELECT COUNT(*) AS rows FROM executions').get()?.rows ?? 0;
    first.fixture.storage.close();

    // A second boot of the same home: the barrier is read before anything can start.
    const storage = new Phase1Database(filename);
    const second = await bind(first.fixture, systemProcessControl(), storage);
    const startup = second.service.startupBarrier();
    expect(startup).toMatchObject({ blocked: true, state: 'PAUSED', pauseEpoch: 1, targetCount: 1 });
    // Startup continues nothing and kills nothing: the frozen provider is exactly as it was.
    expect(await processState(tree.providerPid)).toBe('T');

    // A Task that is READY right now, so the only thing that can refuse it is the barrier: the Task
    // the first boot ran is RUNNING (a global pause does not change that), and starting it again
    // would be refused for a different reason.
    addTask(storage, second.fixture.projectId,
      'A Task that is READY when the second boot starts');
    const ready = storage.listTasks(second.fixture.projectId)
      .find((candidate) => candidate.state === 'READY');
    if (ready === undefined) throw new Error('no READY Task was created');
    await expect(second.coordinator.runTask({
      projectId: second.fixture.projectId,
      taskId: ready.id,
      expectedTaskVersion: ready.version,
      commandId: nextId(),
      adapterId: 'fake',
    })).rejects.toMatchObject({ code: 'SCHEDULER_GLOBALLY_PAUSED' });
    expect(storage.sqlite.query<{ rows: number }, []>(
      'SELECT COUNT(*) AS rows FROM executions').get()?.rows).toBe(executionsBefore);
    expect(controlRow(storage).state).toBe('PAUSED');

    // `runtime stop` does not clear the global pause state: only an explicit resume does.
    await second.coordinator.close();
    expect(controlRow(storage).state).toBe('PAUSED');
    const resumed = await second.service.resume({ commandId: nextId(), actor: 'local-user' });
    expect(resumed.view.state).toBe('RUNNING');
    storage.close();
  });

  test('a platform without POSIX stop semantics is GLOBAL_PAUSE_UNSUPPORTED and never PAUSED', async () => {
    // A real process, a control layer that reports the platform has no stop/continue semantics. This
    // is the Windows branch, driven by a value instead of by the machine the test runs on.
    const h = await harness({ control: { platform: 'win32', posix: false,
      observe: async (pid) => ({ pid, startToken: null, state: 'UNKNOWN' }),
      signal: async () => { throw new Error('a non-POSIX platform has no SIGSTOP'); } } });
    const tree = await spawnRealTree();
    await h.target('fake', h.fixture.taskId, tree);

    const paused = await h.service.pause({ commandId: nextId(), actor: 'local-user' });
    expect(paused.code).toBe('GLOBAL_PAUSE_UNSUPPORTED');
    expect(paused.view.platformSupported).toBe(false);
    expect(paused.view.state).toBe('RECOVERY_REQUIRED');
    expect(paused.view.state).not.toBe('PAUSED');
    // The Runtime did not fall back to "only the scheduler is paused" and did not signal anything.
    expect(await processState(tree.providerPid)).toBe('S');
  });

  test('the same command id replays its receipt and the same key with a different payload is refused', async () => {
    const h = await harness();
    const tree = await spawnRealTree();
    await h.target('fake', h.fixture.taskId, tree);
    const commandId = nextId();
    const first = await h.service.pause({ commandId, actor: 'local-user' });
    const replay = await h.service.pause({ commandId, actor: 'local-user' });
    expect(replay.view.pauseEpoch).toBe(first.view.pauseEpoch);
    expect(replay.view.state).toBe('PAUSED');
    // Exactly one epoch and one pair of events: a replayed command is not a second pause.
    expect(globalEvents(h.fixture.storage)).toEqual([
      'SchedulerGlobalPauseRequested', 'SchedulerGlobalPaused',
    ]);
    expect(controlRow(h.fixture.storage).pause_epoch).toBe(1);
    await expect(h.service.pause({ commandId, actor: 'someone-else' }))
      .rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
  });

  test('pausing releases no resource and rewrites no business state', async () => {
    const h = await harness();
    const tree = await spawnRealTree();
    const target = await h.target('fake', h.fixture.taskId, tree);
    const snapshot = (): unknown => h.fixture.storage.sqlite.query(`
      SELECT (SELECT state FROM tasks WHERE id=(SELECT task_id FROM executions WHERE id=?1)) AS task,
        (SELECT version FROM tasks WHERE id=(SELECT task_id FROM executions WHERE id=?1)) AS task_version,
        (SELECT state FROM executions WHERE id=?1) AS execution,
        (SELECT resource_held FROM executions WHERE id=?1) AS resource_held,
        (SELECT state FROM agent_sessions WHERE execution_id=?1) AS session,
        (SELECT version FROM agent_sessions WHERE execution_id=?1) AS session_version,
        (SELECT COUNT(*) FROM session_writer_leases WHERE released_at IS NULL) AS writer_leases,
        (SELECT COUNT(*) FROM execution_slot_reservations WHERE state='RESERVED') AS reservations
    `).get(target.executionId);
    const before = snapshot();
    expect((await h.service.pause({ commandId: nextId(), actor: 'local-user' })).view.state).toBe('PAUSED');
    expect(snapshot()).toEqual(before);
    expect((await h.service.resume({ commandId: nextId(), actor: 'local-user' })).view.state).toBe('RUNNING');
    expect(snapshot()).toEqual(before);
  });

  test('reconcile observes without signalling and never promotes an unverifiable target', async () => {
    const h = await harness();
    const tree = await spawnRealTree();
    await h.target('fake', h.fixture.taskId, tree, 'a-different-start-token');
    expect((await h.service.pause({ commandId: nextId(), actor: 'local-user' })).view.state)
      .toBe('RECOVERY_REQUIRED');

    const reconciled = await h.service.reconcile({ actor: 'local-user' });
    expect(reconciled.view.state).toBe('RECOVERY_REQUIRED');
    expect(reconciled.view.targets[0]?.state).toBe('RECOVERY_REQUIRED');
    // Nothing was signalled by the read-only pass, and it did not guess a stop.
    expect(await processState(tree.providerPid)).toBe('S');
    // A reconcile that changed nothing writes no event: "looked and it was as it was" is not a
    // recovery, and emitting one would be a fact that did not happen.
    const before = globalEvents(h.fixture.storage);
    const quiet = await h.service.reconcile({ actor: 'local-user' });
    expect(quiet.view.state).toBe('RECOVERY_REQUIRED');
    expect(globalEvents(h.fixture.storage)).toEqual(before);
  });

  test('a Session whose recorded identity is unreadable is reported, not silently dropped', async () => {
    const h = await harness();
    const tree = await spawnRealTree();
    const target = await h.target('fake', h.fixture.taskId, tree);
    h.fixture.storage.sqlite.query(
      'UPDATE session_incarnations SET process_identity_json=NULL WHERE session_id=?1').run(target.sessionId);
    const active: readonly ActiveProviderIncarnation[] = h.fixture.storage.listActiveProviderIncarnations();
    expect(active).toHaveLength(1);

    const paused = await h.service.pause({ commandId: nextId(), actor: 'local-user' });
    expect(paused.code).toBe('GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE');
    expect(paused.view.state).toBe('RECOVERY_REQUIRED');
    // No target row could be written for an identity nobody can read, and the fact is in the detail
    // rather than lost — a Session must never disappear from the picture because its record is bad.
    expect(paused.view.targets).toHaveLength(0);
    expect(JSON.stringify(paused.view.detail)).toContain(target.sessionId);
    expect(await processState(tree.providerPid)).toBe('S');
  });
});
