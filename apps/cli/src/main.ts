import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultTranscriptEntryReadLimit, maxEventReadLimit, maxQuestionnaireOptions,
  maxQuestionnaireQuestions,
  maxTranscriptEntryReadLimit,
  runtimeResponseSchema, runtimeStreamFrameSchema,
  type QuestionnaireAnswer, type RepositoryIdentity, type RuntimeRequest, type RuntimeResponse,
  type SessionTranscriptView,
  type VerificationPolicyInspection } from '@codeestra/contracts';

/** The subset of `project.list` this client reads. */
interface TrustedProjectListing {
  readonly id: string;
  readonly name: string;
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  /** The active policy confirmation, or null when trust never confirmed one. */
  readonly confirmedPolicy:
    { readonly state: 'ABSENT' | 'PRESENT'; readonly digest: string | null;
      readonly mainRef: string; readonly mainCommit: string } | null;
}

type ClientRequest = RuntimeRequest extends infer Request
  ? Request extends RuntimeRequest ? Omit<Request, 'requestId' | 'schemaVersion'> : never
  : never;

const home = Bun.env.CODEESTRA_HOME
  ?? join(Bun.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'codeestra');
const socketPath = join(home, 'runtime.sock');
const runtimeEntry = resolve(import.meta.dir, '../../runtime/src/main.ts');

function request(command: ClientRequest): Promise<RuntimeResponse> {
  return new Promise((resolveResponse, reject) => {
    let buffer = '';
    void Bun.connect<{ sent: boolean }>({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.data = { sent: true };
          socket.write(`${JSON.stringify({ ...command, requestId: crypto.randomUUID(), schemaVersion: 1 })}\n`);
        },
        data(socket, bytes) {
          buffer += new TextDecoder().decode(bytes);
          const newline = buffer.indexOf('\n');
          if (newline !== -1) {
            socket.end();
            try {
              resolveResponse(runtimeResponseSchema.parse(JSON.parse(buffer.slice(0, newline))));
            } catch (error) {
              reject(error);
            }
          }
        },
        error(_socket, error) { reject(error); },
        close() {
          if (!buffer.includes('\n')) reject(new Error('Runtime closed the connection without a response'));
        },
      },
    }).catch(reject);
  });
}

async function ensureRuntime(): Promise<void> {
  try {
    await request({ command: 'runtime.ping' });
    return;
  } catch {
    const child = Bun.spawn([process.execPath, 'run', runtimeEntry], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      env: { ...Bun.env, CODEESTRA_HOME: home },
    });
    child.unref();
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await Bun.sleep(50);
    try {
      await request({ command: 'runtime.ping' });
      return;
    } catch { /* Runtime is still starting. */ }
  }
  throw new Error('Runtime did not become ready');
}

async function call(command: ClientRequest): Promise<unknown> {
  await ensureRuntime();
  const response = await request(command);
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.result;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * An Attention answer as the Runtime command face accepts it. A questionnaire answer stays
 * structured here rather than pre-serialized, so a bad option number is rejected by the Runtime
 * with a code the caller can act on instead of reaching the Agent as an opaque string.
 */
type AttentionAnswerInput =
  | { readonly type: 'CONFIRM'; readonly confirmed: boolean }
  | { readonly type: 'VALUE'; readonly value: string }
  | { readonly type: 'QUESTIONNAIRE'; readonly answer: QuestionnaireAnswer }
  | { readonly type: 'CANCEL' };

/**
 * Parse both accepted answer syntaxes. The positional form (`confirm yes|no` / `value <text>` /
 * `cancel`) is unchanged; the flag form is `--choose <question>:<options>` (repeatable),
 * `--text <question>=<text>` (repeatable), `--cancel`. Question and option numbers are 1-based,
 * matching how the questions and options are displayed.
 */
function parseAttentionAnswer(answerType: string | undefined, rest: readonly string[]): AttentionAnswerInput {
  if (answerType === 'confirm' && rest.length === 1 && ['yes', 'no'].includes(rest[0] ?? '')) {
    return { type: 'CONFIRM', confirmed: rest[0] === 'yes' };
  }
  if (answerType === 'value' && rest.length > 0) return { type: 'VALUE', value: rest.join(' ') };
  if (answerType === 'cancel' && rest.length === 0) return { type: 'CANCEL' };

  const tokens = [answerType, ...rest];
  if (answerType === undefined) usage();
  const choices = new Map<number, number[]>();
  const texts = new Map<number, string>();
  let cancel = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (flag === '--cancel' && value === undefined) {
      cancel = true;
      continue;
    }
    if (flag === '--choose' && value !== undefined) {
      const match = /^(\d+):(\d+(?:,\d+)*)$/.exec(value);
      if (match === null) {
        throw new Error('--choose expects <question>:<options>, for example --choose 1:2 or --choose 2:1,3');
      }
      const question = Number(match[1]) - 1;
      const options = (match[2] as string).split(',').map((option) => Number(option) - 1);
      // The contract's hard limits are checked here so an impossible-by-definition option number is
      // a readable CLI error, not an opaque boundary rejection. Whether the number exists in *this*
      // questionnaire is decided by the Runtime, which is the only side that has the questions.
      if (question < 0 || question >= maxQuestionnaireQuestions
        || options.some((option) => option < 0 || option >= maxQuestionnaireOptions)) {
        throw new Error(`Question ${question + 1} cannot be one of at most ${maxQuestionnaireQuestions}`
          + ` questions with at most ${maxQuestionnaireOptions} options each`);
      }
      if (choices.has(question) || texts.has(question)) {
        throw new Error(`Question ${question + 1} was answered twice`);
      }
      choices.set(question, options);
      index += 1;
      continue;
    }
    if (flag === '--text' && value !== undefined) {
      const separator = value.indexOf('=');
      const question = Number(value.slice(0, separator)) - 1;
      const text = value.slice(separator + 1);
      if (separator <= 0 || !Number.isInteger(question) || text.length === 0) {
        throw new Error('--text expects <question>=<text>, for example --text 1="use the existing helper"');
      }
      if (choices.has(question) || texts.has(question)) {
        throw new Error(`Question ${question + 1} was answered twice`);
      }
      texts.set(question, text);
      index += 1;
      continue;
    }
    usage();
  }
  if (cancel) {
    if (choices.size > 0 || texts.size > 0) throw new Error('--cancel cannot be combined with an answer');
    return { type: 'CANCEL' };
  }
  const answers: QuestionnaireAnswer['answers'][number][] = [];
  for (const [questionIndex, choiceIndexes] of choices) {
    answers.push({ type: 'CHOICES', questionIndex, choiceIndexes });
  }
  for (const [questionIndex, text] of texts) {
    answers.push({ type: 'TEXT', questionIndex, text });
  }
  if (answers.length === 0) usage();
  answers.sort((left, right) => left.questionIndex - right.questionIndex);
  return { type: 'QUESTIONNAIRE', answer: { version: 1, answers } };
}

/**
 * Renders one transcript window for a human. This is an observation view of what the Agent did, so
 * it is printed as text; `--json` prints the Runtime's view verbatim for scripts. Truncated blocks
 * say so and name the exact command that returns the whole block.
 */
function printTranscript(view: SessionTranscriptView, sessionId: string): void {
  const header = view.fileAvailable
    ? `task #${view.taskDisplayNumber} · 第 ${view.attemptNumber} 次执行 · 会话 ${view.sessionState}`
      + ` · 执行 ${view.executionState}`
    : `task #${view.taskDisplayNumber} · 第 ${view.attemptNumber} 次执行 · 无会话文件`;
  console.error(header);
  if (view.note !== null) console.error(view.note);
  if (!view.fileAvailable) return;
  console.error(`${view.entries.length} 条记录${view.hasMore ? '（还有更多，用 --after 继续）' : ''}`);
  if (view.unparsedLines > 0) console.error(`注意：本次扫描中有 ${view.unparsedLines} 行不是有效条目`);
  for (const entry of view.entries) {
    console.log(`\n=== ${entry.entryId} [${entry.kind}] ${entry.timestamp ?? ''}`.trimEnd());
    const meta = [
      entry.role === null ? null : `role=${entry.role}`,
      entry.provider === null && entry.model === null ? null
        : `model=${entry.provider ?? '?'}/${entry.model ?? '?'}`,
      entry.stopReason === null ? null : `stop=${entry.stopReason}`,
      entry.toolName === null ? null : `tool=${entry.toolName}`,
      entry.isError === null ? null : `isError=${String(entry.isError)}`,
      entry.usage === null ? null
        : `tokens in=${String(entry.usage.input)} out=${String(entry.usage.output)}`
          + ` total=${String(entry.usage.total)} reasoning=${String(entry.usage.reasoning)}`
          + ` cost=${String(entry.usage.cost)}`,
      entry.note,
    ].filter((value): value is string => value !== null && value !== undefined);
    if (meta.length > 0) console.log(`  ${meta.join(' · ')}`);
    for (const part of entry.parts) {
      const label = part.name === null ? part.type : `${part.type} ${part.name}`;
      console.log(`  --- [${label}] ${part.fullChars} 字符`);
      for (const line of part.text.split('\n')) console.log(`  ${line}`);
      if (part.truncated) {
        console.log(`  （已截断：仅显示前 ${view.partPreviewChars} 字符；完整内容：`
          + `codeestra session transcript part ${sessionId} ${entry.entryId} ${part.partIndex}）`);
      }
    }
  }
}

interface TranscriptFlags {
  readonly executionId?: string;
  readonly afterEntryId?: string;
  readonly limit?: number;
  readonly json: boolean;
}

function parseTranscriptFlags(flags: readonly string[]): TranscriptFlags {
  let executionId: string | undefined;
  let afterEntryId: string | undefined;
  let limit: number | undefined;
  let json = false;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (flag === '--json') {
      json = true;
    } else if (flag === '--execution' && value !== undefined) {
      executionId = value;
      index += 1;
    } else if (flag === '--after' && value !== undefined) {
      afterEntryId = value;
      index += 1;
    } else if (flag === '--limit' && value !== undefined) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxTranscriptEntryReadLimit) usage();
      limit = parsed;
      index += 1;
    } else {
      usage();
    }
  }
  return { ...(executionId === undefined ? {} : { executionId }),
    ...(afterEntryId === undefined ? {} : { afterEntryId }),
    ...(limit === undefined ? {} : { limit }), json };
}

/** The subset of `task.status` this client reads to find an execution's Agent session. */
interface TaskStatusExecutions {
  readonly executions: readonly {
    readonly executionId: string;
    readonly attemptNumber: number;
    readonly session: { readonly sessionId: string } | null;
  }[];
}

/**
 * Resolves which Session a Task transcript shows, then reads it. The Runtime stays the only place
 * that knows the provider file path; this command only composes `task.status` and
 * `session.transcript`.
 */
async function transcriptForTask(
  projectId: string,
  taskId: string,
  flags: TranscriptFlags,
): Promise<void> {
  const status = await call({ command: 'task.status', projectId, taskId }) as TaskStatusExecutions;
  const requested = flags.executionId === undefined ? null : flags.executionId;
  const candidates = status.executions.filter((execution) => execution.session !== null);
  const execution = requested === null
    ? candidates[0]
    : candidates.find((candidate) => candidate.executionId === requested);
  if (execution === undefined || execution.session === null) {
    if (requested !== null) {
      const known = status.executions.some((candidate) => candidate.executionId === requested);
      throw new Error(known
        ? `EXECUTION_HAS_NO_SESSION: 该执行（${requested}）没有启动 Agent 会话，因此没有执行过程`
        : 'NOT_FOUND: 该任务下没有这个执行');
    }
    throw new Error('NOT_FOUND: 该任务还没有启动过 Agent 会话，因此没有执行过程');
  }
  const view = await call({
    command: 'session.transcript',
    sessionId: execution.session.sessionId,
    ...(flags.afterEntryId === undefined ? {} : { afterEntryId: flags.afterEntryId }),
    limit: flags.limit ?? defaultTranscriptEntryReadLimit,
  }) as SessionTranscriptView;
  if (flags.json) print(view);
  else printTranscript(view, execution.session.sessionId);
}

/**
 * Follows the Runtime event log. stdout carries one JSON event envelope per line so it stays
 * script-friendly; subscription metadata goes to stderr.
 */
async function tailEvents(command: ClientRequest): Promise<void> {
  await ensureRuntime();
  const requestId = crypto.randomUUID();
  await new Promise<void>((resolveStream) => {
    let buffer = '';
    let finished = false;
    const finish = (code: number, error?: Error): void => {
      if (finished) return;
      finished = true;
      if (error !== undefined) {
        console.error(error.message);
        process.exitCode = code;
      }
      resolveStream();
    };
    void Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify({ ...command, requestId, schemaVersion: 1 })}\n`);
        },
        data(socket, bytes) {
          const closeQuietly = (): void => { try { socket.end(); } catch { /* already closing */ } };
          buffer += new TextDecoder().decode(bytes);
          for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              const frame = runtimeStreamFrameSchema.parse(JSON.parse(line));
              if (frame.type === 'event') console.log(JSON.stringify(frame.event));
              else if (frame.type === 'subscribed') {
                console.error(`Subscribed at cursor ${frame.cursor}`
                  + `${frame.projectId === null ? '' : ` for project ${frame.projectId}`}`);
              } else if (frame.type === 'error') {
                // Report before closing: end() can synchronously run the close handler, which
                // would otherwise finish this process with success.
                finish(1, new Error(`${frame.code}: ${frame.message}`));
                closeQuietly();
                return;
              }
            } catch (error) {
              finish(1, error instanceof Error ? error : new Error(String(error)));
              closeQuietly();
              return;
            }
          }
        },
        error(_socket, error) { finish(1, error); },
        close() { finish(0); },
      },
    }).catch((error: unknown) => {
      finish(1, error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function usage(): never {
  console.error(`Usage:
  bun run codeestra status
  bun run codeestra open [path] [--yes] [--no-open]
  bun run codeestra ui [--no-open]
  bun run codeestra stop
  bun run codeestra permission get
  bun run codeestra permission set <full|strict>
  bun run codeestra agent config get [--project <project-id>] [--adapter <id>]
  bun run codeestra agent config set [--project <project-id>] [--adapter <id>]
    [--provider <name>] [--model <id>] [--thinking <off|minimal|low|medium|high|xhigh|max>]
    [--unset provider|model|thinking]
  bun run codeestra agent config clear [--project <project-id>] [--adapter <id>]
  bun run codeestra project inspect [path]
  bun run codeestra project policy [path]
  bun run codeestra project trust [path] [--yes]
  bun run codeestra project list
  bun run codeestra task create <project-id> <specification>
  bun run codeestra task list <project-id>
  bun run codeestra task submit <project-id> <task-id> <expected-version>
  bun run codeestra task run <project-id> <task-id> <expected-version> [--adapter <id>]
  bun run codeestra task status <project-id> <task-id>
  bun run codeestra task transcript <project-id> <task-id> [--execution <id>] [--after <entry-id>]
    [--limit <n>] [--json]
  bun run codeestra session transcript <session-id> [--after <entry-id>] [--limit <n>] [--json]
  bun run codeestra session transcript part <session-id> <entry-id> <part-index>
  bun run codeestra task result capture <project-id> <task-id> [execution-id]
  bun run codeestra task result prepare <project-id> <task-id> [execution-id]   # strict mode
  bun run codeestra task result commit <project-id> <task-id> <authorization-id> --confirm
  bun run codeestra task verify <project-id> <task-id> [execution-id]
  bun run codeestra task verification list <project-id> <task-id>
  bun run codeestra events list [--project <project-id>] [--since <sequence>] [--limit <n>]
  bun run codeestra events tail [--project <project-id>] [--since <sequence>]
  bun run codeestra attention list <project-id>
  bun run codeestra attention answer <project-id> <attention-id> confirm <yes|no>
  bun run codeestra attention answer <project-id> <attention-id> value <text>
  bun run codeestra attention answer <project-id> <attention-id> cancel
  bun run codeestra attention answer <project-id> <attention-id> [--choose <question>:<options>]…
    [--text <question>=<text>]… [--cancel]`);
  process.exit(2);
}

const [group, action, firstArgument, ...remainingArguments] = Bun.argv.slice(2);

/**
 * The address the UI is opened at carries the token and the preselected project in its fragment:
 * fragments are never sent to the server, so neither value reaches a log or a history entry.
 */
function preselectProject(url: string, projectId: string): string {
  const separator = url.includes('#') ? '&' : '#';
  return `${url}${separator}project=${encodeURIComponent(projectId)}`;
}

function launchBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  Bun.spawn([opener, url], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref();
}

async function currentPermissionMode(): Promise<'FULL' | 'STRICT'> {
  const result = await call({ command: 'permission.get' }) as { mode: 'FULL' | 'STRICT' };
  return result.mode;
}

function describeVerificationPolicy(policy: VerificationPolicyInspection): void {
  if (policy.state !== 'PRESENT') {
    console.error('No verification policy at the main ref: task verify will refuse until'
      + ` ${'.codeestra/policies/verification.json'} exists at that ref.`);
    return;
  }
  console.error(`Verification policy (main ${policy.mainCommit.slice(0, 12)}`
    + `, digest ${String(policy.digest).slice(0, 12)}):`);
  for (const command of policy.policy?.commands ?? []) {
    console.error(`  ${command.id}: ${command.argv.join(' ')}`
      + ` (cwd ${command.cwd}, timeout ${command.timeoutSeconds}s)`);
  }
  console.error('task verify runs these in an isolated copy of the tested commit, never in your'
    + ' working tree.');
}

try {
  if (group === 'status' && action === undefined) {
    print(await call({ command: 'runtime.ping' }));
  } else if (group === 'ui') {
    // `ui` takes no positional arguments; every remaining token must be the --no-open flag.
    const flags = [action, firstArgument, ...remainingArguments]
      .filter((flag): flag is string => flag !== undefined);
    if (flags.some((flag) => flag !== '--no-open')) usage();
    const endpoint = await call({ command: 'runtime.ui' }) as { url: string };
    console.log(endpoint.url);
    console.error('The token is in the URL fragment: it stays in this terminal and in your browser session.');
    console.error('Closing the browser does not stop the Runtime or any Task.');
    if (!flags.includes('--no-open')) launchBrowser(endpoint.url);
  } else if (group === 'open') {
    // "Work on this repository": one complete, scriptable CLI path that inspects the repository,
    // shows the verification policy that will judge results, takes the same trust confirmation the
    // UI takes, then starts the Web UI with this project preselected. It composes existing
    // commands only, so nothing here is reachable from the UI that is not reachable from the CLI.
    const tokens = [action, firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined);
    const pathTokens = tokens.filter((token) => !token.startsWith('--'));
    const flagTokens = tokens.filter((token) => token.startsWith('--'));
    if (pathTokens.length > 1
      || flagTokens.some((flag) => flag !== '--yes' && flag !== '--no-open')) usage();
    const path = pathTokens[0] ?? process.cwd();

    const identity = await call({ command: 'project.inspect', path }) as RepositoryIdentity;
    console.error(`Repository: ${identity.repoRoot}`);
    console.error(`  main ref: ${identity.mainRef} · ${identity.objectFormat}`);
    console.error(`  HEAD: ${identity.headCommit}`);
    const policy = await call({ command: 'project.verificationPolicy',
      path }) as VerificationPolicyInspection;
    describeVerificationPolicy(policy);

    const mode = await currentPermissionMode();
    const known = (await call({ command: 'project.list' }) as TrustedProjectListing[])
      // A repository can have several worktrees (for example the stable main tree and this dev
      // tree). The Runtime identifies one Project by the Git common directory, not by a worktree
      // checkout path, so opening another owned worktree must remain idempotent.
      .find((candidate) => candidate.repoRoot === identity.repoRoot
        || candidate.gitCommonDir === identity.gitCommonDir);
    const confirmation = known?.confirmedPolicy ?? null;
    // One confirmation per project on the normal path. The rule mirrors the gate task verify
    // applies: the confirmed *policy digest* is what must still match, so committing to the main
    // ref without touching the policy file never asks for a new confirmation.
    const alreadyConfirmed = confirmation !== null
      && confirmation.state === policy.state
      && (policy.state !== 'PRESENT' || confirmation.digest === policy.digest);
    if (alreadyConfirmed) {
      console.error(`\nAlready trusted as ${String(known?.name)}; the policy at the main ref is the`
        + ' confirmed one, so nothing needs confirming again.');
    } else {
      if (known !== undefined) {
        console.error('\nThe confirmation on file no longer matches this repository: the policy at'
          + ' the main ref changed (or was never confirmed), so it needs confirming again.');
      }
      if (mode === 'FULL') {
        console.error('\nFULL permission mode: registering this project without confirmation.');
      } else {
        console.error('\nSTRICT permission mode: trusting allows an Agent, commands, and Git hooks'
          + ' to run with your user permissions.');
        console.error('It does not authorize commits, main updates, pushes, or unknown tools.');
        const confirmed = flagTokens.includes('--yes')
          || prompt('Type TRUST to confirm:') === 'TRUST';
        if (!confirmed) throw new Error('Project trust was not confirmed');
      }
      await call({
        command: 'project.trust',
        path,
        expectedIdentity: identity,
        expectedVerificationPolicy: policy.state === 'PRESENT'
          ? { state: 'PRESENT', mainCommit: policy.mainCommit, digest: policy.digest as string }
          : { state: 'ABSENT', mainCommit: policy.mainCommit },
      });
    }

    const projects = await call({ command: 'project.list' }) as TrustedProjectListing[];
    const project = projects.find((candidate) => candidate.repoRoot === identity.repoRoot
      || candidate.gitCommonDir === identity.gitCommonDir);
    if (project === undefined) throw new Error('The trusted project was not listed');
    console.error(`\nTrusted project ${project.id} (${project.name}).`);

    const endpoint = await call({ command: 'runtime.ui' }) as { url: string };
    const url = preselectProject(endpoint.url, project.id);
    console.log(url);
    console.error('The Web UI opens on this project. The token stays in the URL fragment and in'
      + ' your browser session.');
    console.error(mode === 'FULL'
      ? 'Next: create a draft task, submit it, then Run task…; tools run without permission prompts.'
      : 'Next: create a draft task, submit it, then Run task… and answer the gate prompts.');
    console.error('Results land on refs/heads/task/<task-id>; merge them yourself,'
      + ' for example: git merge task/<task-id>');
    if (!flagTokens.includes('--no-open')) launchBrowser(url);
  } else if (group === 'stop' && action === undefined) {
    print(await call({ command: 'runtime.stop' }));
  } else if (group === 'permission' && action === 'get'
    && firstArgument === undefined && remainingArguments.length === 0) {
    print(await call({ command: 'permission.get' }));
  } else if (group === 'permission' && action === 'set') {
    if (firstArgument === undefined || remainingArguments.length !== 0
      || !['full', 'strict'].includes(firstArgument.toLowerCase())) usage();
    print(await call({ command: 'permission.set', mode: firstArgument.toUpperCase() as 'FULL' | 'STRICT' }));
  } else if (group === 'agent' && action === 'config') {
    // Agent configuration is per Adapter and per scope. Omitting --project means the global
    // default; supplying it means that project's override. Every field is optional, so `set`
    // merges and `--unset` clears one field without disturbing the others.
    const subcommand = firstArgument;
    const tokens = remainingArguments;
    let projectId: string | undefined;
    let adapterId = 'pi';
    let provider: string | undefined;
    let model: string | undefined;
    let thinkingLevel: string | undefined;
    const unset: string[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const flag = tokens[index];
      const value = tokens[index + 1];
      if (flag === '--project' && value !== undefined) { projectId = value; index += 1; }
      else if (flag === '--adapter' && value !== undefined) { adapterId = value; index += 1; }
      else if (flag === '--provider' && value !== undefined) { provider = value; index += 1; }
      else if (flag === '--model' && value !== undefined) { model = value; index += 1; }
      else if (flag === '--thinking' && value !== undefined) { thinkingLevel = value; index += 1; }
      else if (flag === '--unset' && value !== undefined) { unset.push(value); index += 1; }
      else usage();
    }
    const scope = projectId === undefined ? 'GLOBAL' as const : 'PROJECT' as const;
    if (subcommand === 'get') {
      if (unset.length > 0 || provider !== undefined || model !== undefined
        || thinkingLevel !== undefined) usage();
      print(await call({
        command: 'agent.config.get', adapterId,
        ...(projectId === undefined ? {} : { projectId }),
      }));
    } else if (subcommand === 'clear') {
      if (unset.length > 0 || provider !== undefined || model !== undefined
        || thinkingLevel !== undefined) usage();
      print(await call({
        command: 'agent.config.clear', adapterId, scope,
        ...(projectId === undefined ? {} : { projectId }),
      }));
    } else if (subcommand === 'set') {
      const unsetFields = new Set(unset);
      for (const field of unsetFields) {
        if (field !== 'provider' && field !== 'model' && field !== 'thinking') usage();
      }
      if ((provider !== undefined && unsetFields.has('provider'))
        || (model !== undefined && unsetFields.has('model'))
        || (thinkingLevel !== undefined && unsetFields.has('thinking'))) usage();
      print(await call({
        command: 'agent.config.set', adapterId, scope,
        ...(projectId === undefined ? {} : { projectId }),
        ...(provider === undefined ? (unsetFields.has('provider') ? { provider: null } : {})
          : { provider }),
        ...(model === undefined ? (unsetFields.has('model') ? { model: null } : {})
          : { model }),
        ...(thinkingLevel === undefined ? (unsetFields.has('thinking')
          ? { thinkingLevel: null } : {})
          : { thinkingLevel: thinkingLevel as 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }),
      }));
    } else {
      usage();
    }
  } else if (group === 'project' && action === 'inspect') {
    print(await call({ command: 'project.inspect', path: firstArgument ?? process.cwd() }));
  } else if (group === 'project' && action === 'list') {
    print(await call({ command: 'project.list' }));
  } else if (group === 'project' && action === 'policy') {
    print(await call({ command: 'project.verificationPolicy', path: firstArgument ?? process.cwd() }));
  } else if (group === 'project' && action === 'trust') {
    const path = firstArgument !== undefined && firstArgument !== '--yes' ? firstArgument : process.cwd();
    const identity = await call({ command: 'project.inspect', path }) as RepositoryIdentity;
    print(identity);
    const policy = await call({ command: 'project.verificationPolicy',
      path }) as VerificationPolicyInspection;
    print(policy);
    const mode = await currentPermissionMode();
    console.error(mode === 'FULL'
      ? '\nFULL permission mode: the project will be registered without confirmation; Agent tools,'
        + ' commands, verification and Git hooks run with your user permissions.'
      : '\nSTRICT permission mode: trusting allows Agent tools, commands, and Git hooks to run with'
        + ' your user permissions, but does not authorize commits, main updates, pushes, or unknown tools.');
    if (policy.state === 'PRESENT') {
      console.error('task verify will run these commands in an isolated copy of the tested commit:');
      for (const command of policy.policy?.commands ?? []) {
        console.error(`  ${command.id}: ${command.argv.join(' ')}`
          + ` (cwd ${command.cwd}, timeout ${command.timeoutSeconds}s)`);
      }
    } else {
      console.error('This project has no verification policy; task verify will refuse until one is added.');
    }
    const confirmed = mode === 'FULL' || Bun.argv.includes('--yes')
      || prompt('Type TRUST to confirm:') === 'TRUST';
    if (!confirmed) throw new Error('Project trust was not confirmed');
    print(await call({
      command: 'project.trust',
      path,
      expectedIdentity: identity,
      expectedVerificationPolicy: policy.state === 'PRESENT'
        ? { state: 'PRESENT', mainCommit: policy.mainCommit, digest: policy.digest as string }
        : { state: 'ABSENT', mainCommit: policy.mainCommit },
    }));
  } else if (group === 'task' && action === 'create') {
    if (firstArgument === undefined || remainingArguments.length === 0) usage();
    print(await call({
      command: 'task.create',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      specification: remainingArguments.join(' '),
      constraints: [],
      kind: 'DEVELOPMENT',
    }));
  } else if (group === 'task' && action === 'list') {
    if (firstArgument === undefined || remainingArguments.length !== 0) usage();
    print(await call({ command: 'task.list', projectId: firstArgument }));
  } else if (group === 'task' && action === 'status') {
    const [taskId, ...extra] = remainingArguments;
    if (firstArgument === undefined || taskId === undefined || extra.length !== 0) usage();
    print(await call({ command: 'task.status', projectId: firstArgument, taskId }));
  } else if (group === 'task' && action === 'transcript') {
    const [taskId, ...flags] = remainingArguments;
    if (firstArgument === undefined || taskId === undefined) usage();
    await transcriptForTask(firstArgument, taskId, parseTranscriptFlags(flags));
  } else if (group === 'session' && action === 'transcript') {
    // `session transcript part <session-id> <entry-id> <part-index>` is a three-level command, so
    // the subcommand lands in firstArgument and the session ID is the first remaining argument.
    if (firstArgument === 'part') {
      const [sessionId, entryId, partIndexText, ...extra] = remainingArguments;
      const partIndex = Number(partIndexText);
      if (sessionId === undefined || entryId === undefined || partIndexText === undefined
        || extra.length !== 0 || !Number.isSafeInteger(partIndex) || partIndex < 0) usage();
      print(await call({ command: 'session.transcript.part', sessionId, entryId, partIndex }));
    } else {
      const sessionId = firstArgument;
      if (sessionId === undefined) usage();
      const flags = parseTranscriptFlags(remainingArguments);
      // `--execution` only means something when a Task is resolved; refusing it here keeps the flag
      // from being accepted and then silently ignored.
      if (flags.executionId !== undefined) usage();
      const view = await call({
        command: 'session.transcript',
        sessionId,
        ...(flags.afterEntryId === undefined ? {} : { afterEntryId: flags.afterEntryId }),
        limit: flags.limit ?? defaultTranscriptEntryReadLimit,
      }) as SessionTranscriptView;
      if (flags.json) print(view);
      else printTranscript(view, sessionId);
    }
  } else if (group === 'task' && action === 'run') {
    const [taskId, versionText, ...extra] = remainingArguments;
    const expectedTaskVersion = Number(versionText);
    if (firstArgument === undefined || taskId === undefined || versionText === undefined
      || !Number.isSafeInteger(expectedTaskVersion) || expectedTaskVersion < 0) usage();
    let adapterId = 'pi';
    const argumentsWithoutAdapter: string[] = [];
    for (let index = 0; index < extra.length; index += 1) {
      const argument = extra[index];
      if (argument === '--adapter') {
        const value = extra[index + 1];
        if (value === undefined) usage();
        adapterId = value;
        index += 1;
      } else {
        argumentsWithoutAdapter.push(argument as string);
      }
    }
    if (argumentsWithoutAdapter.length !== 0) usage();
    print(await call({
      command: 'task.run',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      taskId,
      expectedTaskVersion,
      adapterId,
    }));
  } else if (group === 'task' && action === 'verify') {
    const [taskId, executionId, ...extra] = remainingArguments;
    if (firstArgument === undefined || taskId === undefined || extra.length !== 0) usage();
    const report = await call({
      command: 'task.verify',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      taskId,
      ...(executionId === undefined ? {} : { executionId }),
    }) as { state: string };
    print(report);
    if (report.state !== 'PASSED') process.exit(1);
  } else if (group === 'task' && action === 'verification') {
    // `task verification <subcommand> …` lands the subcommand in firstArgument.
    const [projectId, taskId, ...extra] = remainingArguments;
    if (firstArgument !== 'list' || projectId === undefined || taskId === undefined
      || extra.length !== 0) usage();
    print(await call({ command: 'task.verification.list', projectId, taskId }));
  } else if (group === 'task' && action === 'result') {
    // `task result <subcommand> …` is a three-level command, so the subcommand lands in
    // firstArgument and the project ID is the first remaining argument.
    const subcommand = firstArgument;
    if (subcommand === 'capture') {
      const [projectId, taskId, executionId, ...extra] = remainingArguments;
      if (projectId === undefined || taskId === undefined || extra.length !== 0) usage();
      print(await call({
        command: 'task.result.capture',
        commandId: crypto.randomUUID(),
        projectId,
        taskId,
        ...(executionId === undefined ? {} : { executionId }),
      }));
    } else if (subcommand === 'prepare') {
      const [projectId, taskId, executionId, ...extra] = remainingArguments;
      if (projectId === undefined || taskId === undefined || extra.length !== 0) usage();
      print(await call({
        command: 'task.result.prepare',
        commandId: crypto.randomUUID(),
        projectId,
        taskId,
        ...(executionId === undefined ? {} : { executionId }),
      }));
    } else if (subcommand === 'commit') {
      const [projectId, taskId, authorizationId, ...extra] = remainingArguments;
      if (projectId === undefined || taskId === undefined || authorizationId === undefined) usage();
      if (!extra.includes('--confirm') || extra.some((argument) => argument !== '--confirm')) usage();
      print(await call({
        command: 'task.result.commit',
        commandId: crypto.randomUUID(),
        projectId,
        taskId,
        authorizationId,
        confirm: true,
      }));
    } else {
      usage();
    }
  } else if (group === 'events' && (action === 'list' || action === 'tail')) {
    let projectId: string | undefined;
    let sinceSequence: number | undefined;
    let limit: number | undefined;
    const flags = [firstArgument, ...remainingArguments]
      .filter((flag): flag is string => flag !== undefined);
    for (let index = 0; index < flags.length; index += 1) {
      const flag = flags[index];
      const value = flags[index + 1];
      if (flag === '--project' && value !== undefined) {
        projectId = value;
        index += 1;
      } else if (flag === '--since' && value !== undefined) {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0) usage();
        sinceSequence = parsed;
        index += 1;
      } else if (flag === '--limit' && value !== undefined && action === 'list') {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxEventReadLimit) usage();
        limit = parsed;
        index += 1;
      } else {
        usage();
      }
    }
    if (action === 'list') {
      print(await call({
        command: 'events.list',
        ...(projectId === undefined ? {} : { projectId }),
        sinceSequence: sinceSequence ?? 0,
        limit: limit ?? 100,
      }));
    } else {
      await tailEvents({
        command: 'events.subscribe',
        ...(projectId === undefined ? {} : { projectId }),
        ...(sinceSequence === undefined ? {} : { sinceSequence }),
      });
    }
  } else if (group === 'attention' && action === 'list') {
    if (firstArgument === undefined || remainingArguments.length !== 0) usage();
    print(await call({ command: 'attention.list', projectId: firstArgument }));
  } else if (group === 'attention' && action === 'answer') {
    const [attentionId, answerType, ...answerArguments] = remainingArguments;
    if (firstArgument === undefined || attentionId === undefined) usage();
    print(await call({
      command: 'attention.answer',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      attentionId,
      answer: parseAttentionAnswer(answerType, answerArguments),
    }));
  } else if (group === 'task' && action === 'submit') {
    const [taskId, versionText, ...extra] = remainingArguments;
    const expectedVersion = Number(versionText);
    if (firstArgument === undefined || taskId === undefined || versionText === undefined
      || extra.length !== 0 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) usage();
    print(await call({
      command: 'task.submit',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      taskId,
      expectedVersion,
    }));
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
