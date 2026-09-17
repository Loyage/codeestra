import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attentionServiceId, rootServiceId } from '@codeestra/storage';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

/**
 * What this file proves, through the real CLI and a real (temporary) Runtime: an `INTENTION_RESOLVED`
 * `SIG_A` moves the Intention Process `intent send` created, the outcome's audit facts and receipt are
 * readable from existing commands, a refusal carries its own stable code, and the same
 * `(target Service, idempotency key)` applies exactly once.
 *
 * What it does NOT prove:
 * - that `attention list` shows a `QUESTION` for a kernel-level clarification — it does not, on purpose:
 *   `attention_requests.session_id` is a non-null foreign key into `agent_sessions`, and a native
 *   `INTENTION` Process has no provider conversation. This round records the wait as a kernel fact
 *   instead (ADR-0072), and the test asserts that boundary rather than working around it.
 * - that any model interpreted anything: the interpretation arrives inside the Signal, not from a
 *   provider (the Agent-driven intention runner is a later wave).
 * - an Execution-backed Process being refused: proving that needs a real provider Execution, so it is
 *   covered by `intention-service.test.ts` with the port faked (lane contract §3 dependency note).
 */

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => { await reclaimTestResources(); });

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn({
    cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Intention Test',
      GIT_AUTHOR_EMAIL: 'intention@example.invalid', GIT_COMMITTER_NAME: 'Intention Test',
      GIT_COMMITTER_EMAIL: 'intention@example.invalid' },
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

interface IntentionSendView {
  readonly signal: { readonly id: string };
  readonly process: { readonly id: string; readonly kind: string; readonly state: string;
    readonly parentServiceId: string; readonly version: number };
  readonly interpretation: string;
}

interface SignalSendView {
  readonly signal: { readonly id: string; readonly state: string;
    readonly lastErrorCode: string | null; readonly receipt: { readonly effect: unknown } | null };
}

/** A trusted temporary project; no Agent, provider or worktree is involved. */
async function trustedProject(): Promise<{ environment: Record<string, string>; projectId: string }> {
  const repository = temporaryDirectory('codeestra-intention-repo-');
  const home = temporaryDirectory('codeestra-intention-home-');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  await git(repository, ['branch', 'dev']);
  const environment = { CODEESTRA_HOME: home };
  const opened = await cli(['project', 'trust', repository], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  return { environment, projectId: projects[0]?.id as string };
}

async function sendIntention(environment: Record<string, string>, text: string,
  target?: { readonly projectId?: string; readonly taskId?: string }): Promise<IntentionSendView> {
  const sent = await cli(['intent', 'send', text,
    ...(target?.projectId === undefined ? [] : ['--project', target.projectId]),
    ...(target?.taskId === undefined ? [] : ['--task', target.taskId]), '--json'], environment);
  expect(sent.exitCode).toBe(0);
  return JSON.parse(sent.stdout) as IntentionSendView;
}

async function sendResolved(environment: Record<string, string>, input: {
  readonly targetServiceId: string;
  readonly processId: string;
  readonly expectedVersion: number;
  readonly outcome: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly causationId?: string;
}): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return await cli(['signal', 'send', input.targetServiceId, '--kind', 'SIG_A',
    '--subtype', 'INTENTION_RESOLVED',
    '--payload-json', JSON.stringify({ processId: input.processId,
      expectedVersion: input.expectedVersion, outcome: input.outcome }),
    '--idempotency-key', input.idempotencyKey,
    ...(input.causationId === undefined ? [] : ['--causation', input.causationId]), '--json'],
  environment);
}

async function processView(environment: Record<string, string>, processId: string) {
  const read = await cli(['process', 'get', processId, '--json'], environment);
  expect(read.exitCode).toBe(0);
  return JSON.parse(read.stdout) as { readonly state: string; readonly version: number };
}

async function events(environment: Record<string, string>) {
  const listed = await cli(['events', 'list', '--limit', '500', '--json'], environment);
  expect(listed.exitCode).toBe(0);
  return JSON.parse(listed.stdout) as { readonly events: readonly {
    readonly eventType: string; readonly aggregateId: string;
    readonly payload: Record<string, unknown> }[] };
}

describe('codeestra intent resolution', () => {
  test('routes a root intention to a visible Project Service and keeps the audit trail readable',
    async () => {
      const { environment, projectId } = await trustedProject();
      const sent = await sendIntention(environment, 'unify error handling');
      expect(sent.process).toMatchObject({ kind: 'INTENTION', state: 'CREATED',
        parentServiceId: rootServiceId, version: 0 });
      expect(sent.interpretation).toBe('PENDING_S6');

      const routed = await sendResolved(environment, { targetServiceId: rootServiceId,
        processId: sent.process.id, expectedVersion: 0,
        outcome: { kind: 'ROUTE', targetServiceId: projectId, instruction: 'unify error handling' },
        idempotencyKey: 'route-once' });
      expect(routed.exitCode).toBe(0);
      const signal = JSON.parse(routed.stdout) as SignalSendView;
      expect(signal.signal.state).toBe('ACKED');
      expect(signal.signal.receipt?.effect).toMatchObject({ type: 'INTENTION_RESOLVED',
        outcomeKind: 'ROUTE', processId: sent.process.id, targetServiceId: projectId,
        processState: 'SUCCEEDED' });

      // The Process the CLI created is the one that moved, and it went through the legal FSM path
      // (CREATED -> STARTING -> RUNNING -> SUCCEEDED): three version bumps, one settled state.
      const process = await processView(environment, sent.process.id);
      expect(process).toMatchObject({ state: 'SUCCEEDED', version: 3 });

      const trail = await events(environment);
      const audit = trail.events.filter((event) =>
        event.eventType === 'IntentionRouted' && event.aggregateId === sent.process.id);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.payload).toMatchObject({ targetServiceId: projectId,
        instruction: 'unify error handling' });
      expect(trail.events.filter((event) => event.eventType === 'ProcessStateChanged'
        && event.aggregateId === sent.process.id).map((event) => event.payload['to']))
        .toEqual(['STARTING', 'RUNNING', 'SUCCEEDED']);

      // The same (target Service, idempotency key) is applied once: the second send answers with the
      // same Signal and neither a second audit fact nor a second state change appears.
      const repeated = await sendResolved(environment, { targetServiceId: rootServiceId,
        processId: sent.process.id, expectedVersion: 0,
        outcome: { kind: 'ROUTE', targetServiceId: projectId, instruction: 'unify error handling' },
        idempotencyKey: 'route-once' });
      expect(repeated.exitCode).toBe(0);
      expect((JSON.parse(repeated.stdout) as SignalSendView).signal.id).toBe(signal.signal.id);
      const after = await events(environment);
      expect(after.events.filter((event) => event.eventType === 'IntentionRouted')).toHaveLength(1);
      expect(after.events.filter((event) => event.eventType === 'ProcessStateChanged'
        && event.aggregateId === sent.process.id)).toHaveLength(3);
      expect(await processView(environment, sent.process.id)).toMatchObject({ state: 'SUCCEEDED',
        version: 3 });
    }, 180_000);

  test('records a clarification as a kernel fact and routes the answer back to the same Process',
    async () => {
      const { environment, projectId } = await trustedProject();
      const sent = await sendIntention(environment, 'make the tests pass too');

      const asked = await sendResolved(environment, { targetServiceId: rootServiceId,
        processId: sent.process.id, expectedVersion: 0,
        outcome: { kind: 'REQUEST_CLARIFICATION', question: 'which project?',
          options: ['payments', 'search'] },
        idempotencyKey: 'clarify-once' });
      expect(asked.exitCode).toBe(0);
      const askedSignal = JSON.parse(asked.stdout) as SignalSendView;
      const requestId = (askedSignal.signal.receipt?.effect as { requestId: string }).requestId;
      expect(requestId).toBeTruthy();
      expect(askedSignal.signal.receipt?.effect).toMatchObject({ attentionIndex: 'NOT_CONNECTED',
        question: 'which project?', processState: 'WAITING_FOR_USER' });

      const waiting = await processView(environment, sent.process.id);
      expect(waiting).toMatchObject({ state: 'WAITING_FOR_USER', version: 3 });

      // The honest boundary: the wait is a kernel fact, so the Attention index has no row for it.
      const attention = await cli(['attention', 'list', projectId], environment);
      expect(attention.exitCode).toBe(0);
      expect(JSON.parse(attention.stdout)).toEqual([]);
      const trail = await events(environment);
      const recorded = trail.events.filter((event) =>
        event.eventType === 'IntentionClarificationRequested');
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.payload).toMatchObject({ processId: sent.process.id, requestId,
        question: 'which project?', options: ['payments', 'search'] });

      // A reply that names some other question is refused by name and moves nothing.
      const mismatched = await sendResolved(environment, { targetServiceId: rootServiceId,
        processId: sent.process.id, expectedVersion: 3,
        outcome: { kind: 'ROUTE', targetServiceId: projectId, instruction: 'the payments one' },
        idempotencyKey: 'answer-wrong', causationId: 'some-other-question' });
      expect(mismatched.exitCode).toBe(1);
      expect((JSON.parse(mismatched.stdout) as SignalSendView).signal).toMatchObject({
        state: 'DEAD_LETTER', lastErrorCode: 'INTENTION_CLARIFICATION_MISMATCH' });
      expect(await processView(environment, sent.process.id)).toMatchObject({
        state: 'WAITING_FOR_USER', version: 3 });

      // The reply that names the open clarification resumes the Process and settles it.
      const answered = await sendResolved(environment, { targetServiceId: rootServiceId,
        processId: sent.process.id, expectedVersion: 3,
        outcome: { kind: 'ROUTE', targetServiceId: projectId, instruction: 'the payments one' },
        idempotencyKey: 'answer-right', causationId: requestId });
      expect(answered.exitCode).toBe(0);
      expect(await processView(environment, sent.process.id)).toMatchObject({ state: 'SUCCEEDED',
        version: 5 });
      const answeredTrail = await events(environment);
      expect(answeredTrail.events.filter((event) =>
        event.eventType === 'IntentionClarificationAnswered')).toHaveLength(1);
    }, 180_000);

  test('records Session Guidance through the existing ledger for a TYPED_COMMAND', async () => {
    const { environment, projectId } = await trustedProject();
    const created = await cli(['task', 'create', '--project', projectId, 'Reuse', 'the', 'existing', 'helper',
      '--title', '复用现有 helper', '--name', 'reuse-helper'], environment);
    expect(created.exitCode).toBe(0);
    const taskId = (JSON.parse(created.stdout) as { readonly id: string }).id;
    const sent = await sendIntention(environment, 'no new dependencies please', { taskId });

    const guided = await sendResolved(environment, { targetServiceId: taskId,
      processId: sent.process.id, expectedVersion: 0,
      outcome: { kind: 'TYPED_COMMAND', command: 'SESSION_GUIDANCE_RECORD',
        targetTaskServiceId: taskId, message: 'reuse the existing helper' },
      idempotencyKey: 'guide-once' });
    expect(guided.exitCode).toBe(0);
    const signal = JSON.parse(guided.stdout) as SignalSendView;
    // "recorded" is the whole claim: no provider was asked and no model read anything (ADR-0051/0057).
    expect(signal.signal.receipt?.effect).toMatchObject({ command: 'SESSION_GUIDANCE_RECORD',
      guidanceOutcome: 'RECORDED', modelAcknowledgement: 'UNSUPPORTED' });
    expect(await processView(environment, sent.process.id)).toMatchObject({ state: 'SUCCEEDED' });

    const guidance = await cli(['session', 'guidance', 'list', projectId, taskId, '--json'],
      environment);
    expect(guidance.exitCode).toBe(0);
    const listed = JSON.parse(guidance.stdout) as { readonly guidance: readonly {
      readonly body: string; readonly state: string }[] };
    expect(listed.guidance).toHaveLength(1);
    expect(listed.guidance[0]).toMatchObject({ body: 'reuse the existing helper', state: 'RECORDED' });
  }, 180_000);

  test('refuses CREATE_TASK by name, and a Signal that does not own the Process', async () => {
    const { environment, projectId } = await trustedProject();
    const sent = await sendIntention(environment, 'create me a task');

    // `ROUTE` reaches only the parent's visible children: root can reach a PROJECT, never the system
    // Services beside it or a Task below a Project.
    const invisible = await sendResolved(environment, { targetServiceId: rootServiceId,
      processId: sent.process.id, expectedVersion: 0,
      outcome: { kind: 'ROUTE', targetServiceId: attentionServiceId, instruction: 'x' },
      idempotencyKey: 'invisible-target' });
    expect(invisible.exitCode).toBe(1);
    expect((JSON.parse(invisible.stdout) as SignalSendView).signal).toMatchObject({
      state: 'DEAD_LETTER', lastErrorCode: 'INTENTION_TARGET_NOT_VISIBLE' });
    expect(await processView(environment, sent.process.id)).toMatchObject({ state: 'CREATED',
      version: 0 });

    const refused = await sendResolved(environment, { targetServiceId: rootServiceId,
      processId: sent.process.id, expectedVersion: 0,
      outcome: { kind: 'CREATE_TASK', displayTitle: 'a new task', detail: 'something' },
      idempotencyKey: 'create-task-once' });
    expect(refused.exitCode).toBe(1);
    expect((JSON.parse(refused.stdout) as SignalSendView).signal).toMatchObject({
      state: 'DEAD_LETTER', lastErrorCode: 'INTENTION_CREATE_TASK_UNSUPPORTED' });
    // Refused by name means refused without a trace of application: the Process never moved.
    expect(await processView(environment, sent.process.id)).toMatchObject({ state: 'CREATED',
      version: 0 });
    const trail = await events(environment);
    expect(trail.events.filter((event) => event.eventType.startsWith('Intention'))).toEqual([]);

    // A Signal addressed to a Service that does not own the Process cannot move it either.
    const mismatched = await sendResolved(environment, { targetServiceId: projectId,
      processId: sent.process.id, expectedVersion: 0,
      outcome: { kind: 'ROUTE', targetServiceId: projectId, instruction: 'x' },
      idempotencyKey: 'wrong-owner' });
    expect(mismatched.exitCode).toBe(1);
    expect((JSON.parse(mismatched.stdout) as SignalSendView).signal).toMatchObject({
      state: 'DEAD_LETTER', lastErrorCode: 'PROCESS_PARENT_MISMATCH' });

    const missing = await sendResolved(environment, { targetServiceId: rootServiceId,
      processId: 'not-a-process', expectedVersion: 0,
      outcome: { kind: 'ROUTE', targetServiceId: projectId, instruction: 'x' },
      idempotencyKey: 'missing-process' });
    expect(missing.exitCode).toBe(1);
    expect((JSON.parse(missing.stdout) as SignalSendView).signal).toMatchObject({
      state: 'DEAD_LETTER', lastErrorCode: 'PROCESS_NOT_FOUND' });
  }, 180_000);
});
