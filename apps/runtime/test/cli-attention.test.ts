import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeQuestionnaireDialogTitle, type Questionnaire } from '@codeestra/contracts';
import {
  reclaimTestResources,
  registerTemporaryDirectory,
  runCli,
} from './support/runtime-reclamation.js';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const cliEntry = join(repositoryRoot, 'apps', 'cli', 'src', 'main.ts');

afterEach(async () => { await reclaimTestResources(); });

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  registerTemporaryDirectory(directory);
  return directory;
}

async function cli(args: readonly string[], environment: Record<string, string>) {
  // FOUNDATION-057: the shared runner refuses a non-temporary CODEESTRA_HOME (a test must never
  // reach the real Runtime home) and registers the home so teardown stops any Runtime it started,
  // including when an assertion fails before the test's own stop.
  return await runCli(args, environment, { entry: cliEntry });
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const child = Bun.spawn({ cmd: ['git', '-C', cwd, ...args], stdout: 'pipe', stderr: 'pipe',
    env: { PATH: Bun.env.PATH ?? '', GIT_AUTHOR_NAME: 'Question Test',
      GIT_AUTHOR_EMAIL: 'question@example.invalid', GIT_COMMITTER_NAME: 'Question Test',
      GIT_COMMITTER_EMAIL: 'question@example.invalid' } });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
}

const questionnaire: Questionnaire = {
  questions: [
    { question: 'Which package manager should the change use?', header: 'Packages', multiSelect: false,
      options: [{ label: 'npm', description: 'the repository default' },
        { label: 'bun', description: 'what the lockfile says' }] },
    { question: 'Which checks must pass?', header: 'Checks', multiSelect: true,
      options: [{ label: 'typecheck', description: 'tsc --noEmit' },
        { label: 'tests', description: 'vitest run' }] },
  ],
};

interface AttentionPayload {
  readonly id: string;
  readonly kind: string;
  readonly responseType: string;
  readonly status: string;
  readonly prompt: { readonly kind?: string; readonly version?: number;
    readonly questionnaire?: Questionnaire };
}

/**
 * A protocol stub, not a real provider. It asks one Codeestra questionnaire exactly the way the
 * question extension does (the questionnaire travels in the dialog title) and records the answer
 * the Adapter wrote back. It proves the Runtime's command face end to end; it is never evidence of
 * a real Agent integration.
 */
const stubSource = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = Bun.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('0.84.4\\n');
  process.exit(0);
}
const sessionDirIndex = argv.indexOf('--session-dir');
const sessionDir = sessionDirIndex >= 0 ? argv[sessionDirIndex + 1] : process.cwd();
mkdirSync(sessionDir, { recursive: true });
const sessionFile = join(sessionDir, 'question-session.jsonl');
const report = process.env.CODEESTRA_QUESTION_REPORT;
const title = process.env.CODEESTRA_QUESTION_TITLE;
const emit = (record) => process.stdout.write(JSON.stringify(record) + '\\n');

let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line);
    if (record.type === 'get_state') {
      emit({ id: record.id, type: 'response', command: 'get_state', success: true, data: {
        sessionId: 'question-session', sessionFile, messageCount: 0 } });
    } else if (record.type === 'prompt') {
      emit({ id: record.id, type: 'response', command: 'prompt', success: true });
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3,
        id: 'question-session', timestamp: '2026-09-13T09:00:00.000Z', cwd: process.cwd() }) + '\\n');
      emit({ type: 'extension_ui_request', id: 'question-1', method: 'select', title,
        options: ['Q1 [Packages] Which package manager should the change use?'] });
    } else if (record.type === 'extension_ui_response' && record.id === 'question-1') {
      if (report) {
        writeFileSync(report, JSON.stringify({
          value: record.value ?? null, cancelled: record.cancelled === true }));
      }
      emit({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'Answered and stopped.' }], stopReason: 'stop' } });
      emit({ type: 'agent_settled' });
    }
  }
}
`;

async function startQuestionnaireTask(title: string): Promise<{
  readonly environment: Record<string, string>;
  readonly projectId: string;
  readonly taskId: string;
  readonly reportPath: string;
}> {
  const repository = temporaryDirectory('codeestra-question-repo-');
  const home = temporaryDirectory('codeestra-question-home-');
  const tools = temporaryDirectory('codeestra-question-tools-');
  mkdirSync(join(repository, '.codeestra', 'policies'), { recursive: true });
  await Bun.write(join(repository, '.codeestra', 'policies', 'verification.json'), JSON.stringify({
    version: 1, commands: [{ id: 'check', argv: ['true'], cwd: '.', timeoutSeconds: 60 }],
  }));
  await Bun.write(join(repository, 'README.md'), 'fixture\n');
  await git(repository, ['init', '-q', '-b', 'main']);
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  // ADR-0009: the long-lived dev branch is the baseline every workspace is created from.
  await git(repository, ['branch', 'dev']);
  // ADR-0056: every dev fact comes from a second clone of the same origin that sits on
  // `dev`; the project is trusted with it explicitly.

  const reportPath = join(tools, 'report.json');
  const stubPath = join(tools, 'stub-pi.ts');
  const shimPath = join(tools, 'pi');
  await Bun.write(stubPath, stubSource);
  await Bun.write(shimPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  chmodSync(shimPath, 0o755);

  const environment = {
    CODEESTRA_HOME: home,
    CODEESTRA_PI_EXECUTABLE: shimPath,
    CODEESTRA_QUESTION_REPORT: reportPath,
    CODEESTRA_QUESTION_TITLE: title,
  };
  const opened = await cli(['project', 'trust', repository], environment);
  expect(opened.exitCode).toBe(0);
  const projects = JSON.parse((await cli(['project', 'list'], environment)).stdout) as
    readonly { id: string }[];
  const projectId = projects[0]?.id as string;
  const created = JSON.parse((await cli(['task', 'create', projectId,
    'Ask before choosing a package manager', '--title', 'Ask before choosing a package manager',
    '--name', 'ask-package-manager'], environment)).stdout) as { readonly id: string };
  const taskId = created.id;
  // Submission starts this undeclared Task immediately under ADR-0059.
  expect((await cli(['task', 'submit', projectId, taskId, '0'], environment)).exitCode).toBe(0);
  return { environment, projectId, taskId, reportPath };
}

/** Poll the same command face a user would use until the Agent's question is waiting. */
async function waitForAttention(
  environment: Record<string, string>,
  projectId: string,
): Promise<AttentionPayload> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const listed = await cli(['attention', 'list', projectId], environment);
    if (listed.exitCode === 0) {
      const attentions = JSON.parse(listed.stdout) as readonly AttentionPayload[];
      const open = attentions.find((attention) => attention.status === 'OPEN');
      if (open !== undefined) return open;
    }
    await Bun.sleep(100);
  }
  throw new Error('The questionnaire Attention never appeared');
}

describe('codeestra attention answer', () => {
  test('carries one structured questionnaire to the CLI and the answer back to the Agent', async () => {
    const { environment, projectId, taskId, reportPath } =
      await startQuestionnaireTask(encodeQuestionnaireDialogTitle(questionnaire));
    try {
      const attention = await waitForAttention(environment, projectId);
      expect(attention.kind).toBe('QUESTION');
      expect(attention.responseType).toBe('VALUE');
      // The whole questionnaire is one Attention, decoded out of the provider dialog title.
      expect(attention.prompt.kind).toBe('codeestra.questionnaire');
      expect(attention.prompt.questionnaire).toEqual(questionnaire);

      // An option number outside the contract's hard limit is refused by the CLI itself; an option
      // number that exists in the contract but not in this questionnaire is refused by the Runtime.
      // Either way the request stays open and a typo can never reach the Agent as a decline.
      const impossible = await cli(['attention', 'answer', projectId, attention.id, '--choose', '1:9'],
        environment);
      expect(impossible.exitCode).toBe(1);
      expect(impossible.stderr).toContain('at most 4 options each');
      const rejected = await cli(['attention', 'answer', projectId, attention.id, '--choose', '1:3'],
        environment);
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr).toContain('INVALID_QUESTIONNAIRE_ANSWER:CHOICE_INDEX_OUT_OF_RANGE');
      expect(rejected.stderr).toContain('Question 1 has no option 3');
      const stillOpen = JSON.parse((await cli(['attention', 'list', projectId],
        environment)).stdout) as readonly AttentionPayload[];
      expect(stillOpen.find((candidate) => candidate.id === attention.id)?.status).toBe('OPEN');

      const answered = await cli(['attention', 'answer', projectId, attention.id,
        '--choose', '1:2', '--choose', '2:1,2'], environment);
      expect(answered.exitCode).toBe(0);
      expect(JSON.parse(answered.stdout)).toMatchObject({ status: 'DELIVERED' });

      // The Adapter encoded the structured answer for its own dialog; the stub saw exactly that.
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as
        { readonly value: string; readonly cancelled: boolean };
      expect(report.cancelled).toBe(false);
      expect(JSON.parse(report.value)).toEqual({ version: 1, answers: [
        { type: 'CHOICES', questionIndex: 0, choiceIndexes: [1] },
        { type: 'CHOICES', questionIndex: 1, choiceIndexes: [0, 1] },
      ] });

      const status = JSON.parse((await cli(['task', 'status', projectId, taskId],
        environment)).stdout) as { readonly taskState: string;
          readonly executions: readonly { readonly state: string;
            readonly session: { readonly state: string } | null }[] };
      // The answer unblocked the Agent: it is no longer waiting, and its session ended. The
      // Execution stays RUNNING until the result is committed, which is a separate step.
      expect(status.taskState).not.toBe('WAITING_FOR_USER');
      expect(status.executions[0]?.session?.state).toBe('EXITED');
    } finally {
      await cli(['stop'], environment);
    }
  });

  test('refuses a structured answer for an Attention that is not a questionnaire', async () => {
    // The same stub, but its dialog carries an ordinary title: the Attention is a plain provider
    // question, so a structured answer would be a shape nothing can read. It must be refused with
    // a stable code, while the raw VALUE path stays available for a real host that can answer it.
    const { environment, projectId, taskId } =
      await startQuestionnaireTask('Which package manager?');
    try {
      const attention = await waitForAttention(environment, projectId);
      expect(attention.prompt.kind).toBeUndefined();
      const structured = await cli(['attention', 'answer', projectId, attention.id, '--choose', '1:1'],
        environment);
      expect(structured.exitCode).toBe(1);
      expect(structured.stderr).toContain('NOT_A_QUESTIONNAIRE');

      const raw = await cli(['attention', 'answer', projectId, attention.id, 'value', 'bun'], environment);
      expect(raw.exitCode).toBe(0);
      const deadline = Date.now() + 5_000;
      let state = '';
      while (Date.now() < deadline) {
        const current = JSON.parse((await cli(['task', 'status', projectId, taskId],
          environment)).stdout) as { readonly executions: readonly {
            readonly session: { readonly state: string } | null }[] };
        state = current.executions[0]?.session?.state ?? '';
        if (state === 'EXITED') break;
        await Bun.sleep(50);
      }
      expect(state).toBe('EXITED');
    } finally {
      await cli(['stop'], environment);
    }
  });
});
