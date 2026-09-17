import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { defaultTranscriptEntryReadLimit, maxEventReadLimit, maxQuestionnaireOptions,
  maxQuestionnaireQuestions,
  taskNamingTitlePattern,
  maxSlotReservationReadLimit,
  maxTranscriptEntryReadLimit,
  runtimePingResultSchema,
  runtimeResponseSchema, runtimeStopResultSchema, runtimeStreamFrameSchema,
  type ProjectIdentity, type QuestionnaireAnswer, type RuntimeRequest,
  type RuntimeResponse,
  type ImpactPolicyConfirmation,
  type ScheduleExplanationView, type ScheduleOverviewView, type ScheduleStartOutcomeView,
  type ScheduleTickReport,
  type ScheduleAssessmentView, type ScheduleCandidateView,
  type ScheduleUnknownReleaseView,
  type SessionTranscriptEntry, type SessionTranscriptView,
  type SlotReservationAcquisitionView,
  type SlotReservationReconcileReport, type SlotReservationReleaseView,
  type SlotSnapshotRefusalDetail,
  type TaskRetryOutcomeView,
  type TaskPurgeOutcomeView,
  type AgentPluginDetection,
  type VerificationPolicyInspection,
  agentPluginKinds,
  type SettingsListView } from '@codeestra/contracts';
/**
 * The Agent configuration view the Runtime returns for `agent.config.get|set|clear`. Only the fields
 * this client renders are named; anything else is ignored rather than invented.
 */
interface AgentConfigurationView {
  readonly adapterId: string;
  readonly pluginSelection: Record<string, readonly string[]> | null;
  readonly pluginSelectionSource: 'GLOBAL' | 'PROJECT' | null;
  readonly thirdPartyExtensionApprovalRisk: boolean;
}
import {
  inspectRuntimeHome,
  pidExists,
  readProcessStartToken,
  readProcessState,
  type RuntimeHomeInspection,
} from '../../runtime/src/lifecycle.js';

type ClientRequest = RuntimeRequest extends infer Request
  ? Request extends RuntimeRequest ? Omit<Request, 'requestId' | 'schemaVersion'> : never
  : never;

/** Resource kinds `reclaim` accepts; the Runtime boundary validates the same set again. */
const reclaimKindNames = ['TASK_WORKTREE', 'VERIFICATION_COPY', 'INTEGRATION_WORKTREE'] as const;
type ReclaimKindName = (typeof reclaimKindNames)[number];
const maxReclaimRecordLimit = 500;
/** Mirrors the contract's bound on an explicit unregistered-directory selection. */
const maxUnregisteredSelections = 200;

/** The two shapes `reclaim plan` can answer with; `--project` gives one, batch gives the other. */
interface ReclaimPlanGroupView {
  readonly counts: { readonly reclaim: number; readonly recoveryRequired: number };
  readonly unregistered?: { readonly counts: { readonly reclaim: number } } | null;
}
interface ReclaimPlanView extends ReclaimPlanGroupView {
  readonly scope: 'PROJECT' | 'ALL_PROJECTS';
  readonly projects?: readonly ReclaimPlanGroupView[];
  /** Present only on a batch; `FAILED` means at least one project group could not be planned. */
  readonly outcome?: 'SUCCEEDED' | 'FAILED';
}
interface ReclaimReportView extends ReclaimPlanView {
  readonly outcome: 'SUCCEEDED' | 'FAILED';
  readonly outcomeCounts: { readonly reclaimed: number };
}

function reclaimableCount(view: ReclaimPlanView): number {
  const groups = view.scope === 'ALL_PROJECTS' ? view.projects ?? [] : [view];
  return groups.reduce((sum, group) => sum
    + group.counts.reclaim
    + (group.unregistered?.counts.reclaim ?? 0), 0);
}

function reclaimedCount(view: ReclaimReportView): number {
  const groups = view.scope === 'ALL_PROJECTS' ? view.projects ?? [] : [view];
  return groups.reduce((sum, group) => sum
    + (group as ReclaimReportView).outcomeCounts.reclaimed, 0);
}

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

/**
 * A rejected Runtime command keeps its stable code. "A wait" and "a refusal" have to be told apart
 * without parsing prose (a conflict or capacity wait exits 3, a refusal exits 1), so the code
 * travels on the error itself, and the optional `detail` carries the facts the code cannot express.
 */
class CliRuntimeError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'CliRuntimeError';
  }
}

function errorCodeOf(error: unknown): string | null {
  return error instanceof CliRuntimeError ? error.code : null;
}

/**
 * A refusal detail only counts as one when it names a stable code: an unreadable payload is treated
 * as "no facts attached" and the error keeps its ordinary rendering, never a half-rendered JSON.
 */
function isSnapshotRefusal(value: unknown): value is SlotSnapshotRefusalDetail {
  return typeof value === 'object' && value !== null && 'code' in value
    && (value.code === 'SNAPSHOT_STALE' || value.code === 'SNAPSHOT_UNAVAILABLE');
}

async function call(command: ClientRequest): Promise<unknown> {
  await ensureRuntime();
  const response = await request(command);
  if (!response.ok) {
    throw new CliRuntimeError(response.error.code,
      `${response.error.code}: ${response.error.message}`, response.error.detail);
  }
  return response.result;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * The one Runtime-wide concurrency limit, under both of its spellings (ADR-0061 D01/D02).
 *
 * `scheduler capacity …` is the scheduler's face of the fact and `settings concurrency …` is the
 * settings face; both send the *same* Runtime commands, so the stored value, its
 * `SchedulerGlobalCapacityChanged` event and its commandId idempotency cannot diverge. The limit is
 * the only place this number lives (`runtime_capacity_settings`): the settings spelling is discoverable
 * where a user looks for settings, not a second copy of the rule.
 *
 * It is a setting, not a gate: zero confirmations, identical behavior in FULL and STRICT, and a change
 * applies in real time — the value is re-read inside every acquisition transaction, `set`/`reset`
 * trigger a scheduling pass for **every** project so a Task waiting on capacity can start immediately,
 * and lowering the limit never pauses, releases or terminates a Task that already holds a slot.
 */
async function runConcurrencyCommand(tokens: readonly string[]): Promise<void> {
  const split = splitFlagTokens(tokens, ['--limit'], ['--json']);
  const [concurrencyAction, ...extra] = split.positionals;
  if (concurrencyAction === undefined || extra.length !== 0) usage();
  const limitText = split.flags.get('--limit');
  if (concurrencyAction === 'get') {
    if (limitText !== undefined) usage();
    print(await call({ command: 'scheduler.capacity.get' }));
  } else if (concurrencyAction === 'set') {
    // A non-integer is a usage error here (exit 2); an integer outside 1-16 is passed on so the
    // Runtime answers with its own stable code (exit 1) instead of the CLI inventing a rule.
    const limit = Number(limitText);
    if (limitText === undefined || !Number.isSafeInteger(limit)) usage();
    print(await call({
      command: 'scheduler.capacity.set',
      commandId: crypto.randomUUID(),
      limit,
    }));
  } else if (concurrencyAction === 'reset') {
    if (limitText !== undefined) usage();
    print(await call({
      command: 'scheduler.capacity.reset',
      commandId: crypto.randomUUID(),
    }));
  } else {
    usage();
  }
}

/**
 * The completion note `task.status` reports for one Agent Session. The Runtime owns this shape; the
 * client only renders it, so an unreadable payload means "no note", never an invented one.
 */
interface TaskStatusExecutionListing {
  readonly executionId?: unknown;
  readonly session?: { readonly sessionId?: unknown;
    readonly completion?: { readonly outcome?: unknown;
      readonly note?: { readonly code?: unknown; readonly message?: unknown } | null } | null } | null;
}

/**
 * Renders the Agent-completion notes of a Task to stderr. A completion the Runtime had to annotate
 * is thus visible both to a human reading `task status` and to a script reading its JSON. This is a
 * rendering of a recorded fact: it changes no state, adds no confirmation, and never claims the
 * Agent is waiting for an answer (FOUNDATION-056).
 */
/**
 * ADR-0055 D04: name the active/reserved Tasks whose occupation could not be observed, in words, on
 * stderr — together with the command that can reconcile them.
 *
 * This is a diagnostic, not a verdict: the assessment is `UNKNOWN` either way, and the reason codes
 * are unchanged. What it removes is the guessing: a user facing "cannot be proven disjoint from 2
 * active Task(s)" now also reads *which* of them has a workspace that is not on disk any more, and
 * what to run about it.
 */
function printOccupierDiagnostics(
  projectId: string,
  assessment: ScheduleAssessmentView | null,
  activeTaskIds: readonly string[],
): void {
  const occupiers = assessment?.occupiers ?? [];
  const reported = new Set<string>();
  for (const occupier of occupiers) {
    if (occupier.code === 'OBSERVABLE') continue;
    reported.add(occupier.taskId);
    const remedy = occupier.taskState === 'RECOVERY_REQUIRED'
      ? `reconcile it from facts with \`task recover ${projectId} ${occupier.taskId}`
        + ' <expected-version>\` (the version is in `task status`)'
      : occupier.taskState === 'PAUSED'
        ? `resume it with \`task resume\` or retire it with \`task cancel\``
        : 'inspect it with `task status`';
    console.error(`[scheduler] occupier ${occupier.taskId} (${occupier.taskState}/`
      + `${occupier.executionState}) ${occupier.code}: ${occupier.detail}`
      + `${occupier.workspacePath === null ? '' : ` [${occupier.workspacePath}]`} → ${remedy}`);
  }
  // A Task can be in the active set with no assessment row at all (for example when the candidate's own
  // impact was unavailable, so no comparison ran). Saying only "it is active" is still better than
  // silence, because it names the exact Task the wait is about.
  for (const taskId of activeTaskIds) {
    if (reported.has(taskId)) continue;
    console.error(`[scheduler] occupier ${taskId}: active (no assessment row was produced for it)`);
  }
}

/** One line per candidate: which of its occupiers cannot be observed, and what to do about it. */
function printOccupierDiagnosticsForCandidates(
  projectId: string,
  candidates: readonly ScheduleCandidateView[],
): void {
  for (const candidate of candidates) {
    printOccupierDiagnostics(projectId, candidate.assessment, candidate.assessment?.activeTaskIds ?? []);
  }
}

function printCompletionNotes(view: unknown): void {
  if (typeof view !== 'object' || view === null) return;
  const executions = (view as { readonly executions?: unknown }).executions;
  if (!Array.isArray(executions)) return;
  for (const candidate of executions as readonly TaskStatusExecutionListing[]) {
    const executionId = candidate.executionId;
    const note = candidate.session?.completion?.note ?? null;
    if (note === null || typeof note.code !== 'string') continue;
    const sessionId = candidate.session?.sessionId;
    const outcome = candidate.session?.completion?.outcome;
    console.error(`[note] ${typeof executionId === 'string' ? executionId : 'unknown execution'}`
      + ` (${typeof sessionId === 'string' ? sessionId : 'unknown session'})`
      + ` ended ${typeof outcome === 'string' ? outcome : 'without a recorded outcome'}`
      + ` with ${note.code}: ${typeof note.message === 'string' ? note.message : 'no message'}`);
  }
}

/**
 * Renders the prose-question waits of a Task to stderr (FOUNDATION-069).
 *
 * The Task's own `state` already says `WAITING_FOR_USER`, but that state is shared with every other
 * reason to wait, so the human-facing line names the reason and the command that ends it. It is a
 * rendering of recorded facts: it changes nothing, and it never claims the Agent is still running.
 *
 * The list is only fetched for a Task that is actually waiting, so the common path pays nothing.
 */
async function printProseQuestionWaits(input: {
  readonly projectId: string;
  readonly view: unknown;
  readonly call: (request: ClientRequest) => Promise<unknown>;
}): Promise<void> {
  const task = (input.view as { readonly task?: { readonly state?: unknown } } | null)?.task;
  if (task?.state !== 'WAITING_FOR_USER') return;
  const listed = await input.call({ command: 'attention.list', projectId: input.projectId });
  if (!Array.isArray(listed)) return;
  for (const candidate of listed as readonly {
    readonly id?: unknown; readonly status?: unknown; readonly executionId?: unknown;
    readonly prompt?: { readonly kind?: unknown; readonly text?: unknown } | null }[]) {
    if (candidate.status !== 'OPEN') continue;
    if (candidate.prompt?.kind !== 'codeestra.prose-question') continue;
    const text = typeof candidate.prompt.text === 'string' ? candidate.prompt.text : 'no text';
    console.error(`[waiting] ${typeof candidate.id === 'string' ? candidate.id : 'unknown attention'}`
      + ` (${typeof candidate.executionId === 'string' ? candidate.executionId : 'unknown execution'})`
      + ` recorded PROSE_QUESTION_NO_TOOL_USE: the Agent ended its turn asking in prose and`
      + ` exited without using a tool. The provider is gone: nothing was delivered to it.`
      + ` End the wait with attention resolve --answer <text> | --dismiss.`);
    console.error(`[waiting] the Agent asked: ${text}`);
  }
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
 *
 * `reverse` prints the newest entry first. That is a rendering choice only: the entries are the
 * same ones the forward read returned, and their text is unchanged.
 */
function printTranscript(read: TranscriptRead, sessionId: string, reverse: boolean): void {
  const { view } = read;
  const header = view.fileAvailable
    ? `task #${view.taskDisplayNumber} · 第 ${view.attemptNumber} 次执行 · 会话 ${view.sessionState}`
      + ` · 执行 ${view.executionState}`
    : `task #${view.taskDisplayNumber} · 第 ${view.attemptNumber} 次执行 · 无会话文件`;
  console.error(header);
  if (view.note !== null) console.error(view.note);
  if (!view.fileAvailable) return;
  console.error(`${read.entries.length} 条记录${reverse ? '（倒序：最新在前）' : ''}`
    + `${view.hasMore ? '（还有更新的记录，用 --after 继续）' : ''}`);
  if (read.incomplete) {
    // Saying this out loud matters: at the cap the first printed entry is not the newest one.
    console.error(`注意：倒序只读取了 ${maxTranscriptReverseReads} 页就到上限，可能有更新的记录`
      + `未显示；用 --after ${view.cursor ?? ''} 继续`);
  }
  if (view.unparsedLines > 0) console.error(`注意：本次扫描中有 ${view.unparsedLines} 行不是有效条目`);
  const ordered = reverse ? [...read.entries].reverse() : read.entries;
  for (const entry of ordered) {
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
  readonly reverse: boolean;
}

/**
 * One transcript read as the CLI needs it: the last window read (for header facts) plus the entries
 * to print. Forward rendering uses exactly one window.
 */
interface TranscriptRead {
  readonly view: SessionTranscriptView;
  readonly entries: readonly SessionTranscriptEntry[];
  /** `--reverse` hit the page cap: entries newer than the ones read exist and were not fetched. */
  readonly incomplete: boolean;
}

/**
 * How many paged reads `--reverse` may chain. The command face only has a forward cursor, so the
 * newest entries are only reachable by reading everything before them; the cap keeps one command
 * from turning a long session into an unbounded loop, and `incomplete` says when it was hit.
 */
const maxTranscriptReverseReads = 50;

async function readTranscript(sessionId: string, flags: TranscriptFlags): Promise<TranscriptRead> {
  const limit = flags.limit ?? defaultTranscriptEntryReadLimit;
  const readPage = async (afterEntryId: string | undefined): Promise<SessionTranscriptView> =>
    await call({ command: 'session.transcript', sessionId,
      ...(afterEntryId === undefined ? {} : { afterEntryId }), limit }) as SessionTranscriptView;
  const first = await readPage(flags.afterEntryId);
  if (!flags.reverse) return { view: first, entries: first.entries, incomplete: false };
  const entries: SessionTranscriptEntry[] = [...first.entries];
  let view = first;
  let reads = 1;
  while (view.hasMore && view.cursor !== null && reads < maxTranscriptReverseReads) {
    view = await readPage(view.cursor);
    entries.push(...view.entries);
    reads += 1;
  }
  return { view, entries, incomplete: view.hasMore };
}

function parseTranscriptFlags(flags: readonly string[]): TranscriptFlags {
  let executionId: string | undefined;
  let afterEntryId: string | undefined;
  let limit: number | undefined;
  let json = false;
  let reverse = false;
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (flag === '--json') {
      json = true;
    } else if (flag === '--reverse') {
      reverse = true;
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
    ...(limit === undefined ? {} : { limit }), json, reverse };
}

interface TaskCreateInput {
  readonly displayTitle: string;
  readonly namingTitle: string;
  readonly specification: string;
  /** Declared feature ids (`--feature <id>`, repeatable); validated by the Runtime. */
  readonly features: string[];
}

/**
 * `task create` takes the Task detail as its positional text, so only the two titles and the
 * declared features are read as flags. Both titles are required (ADR-0065 D01): the display title is
 * what the task list shows, the naming title is what the branch and worktree directory are called,
 * and neither is derived from the other. The naming shape is checked here too, so a script gets the
 * usage error (exit 2) instead of a contract refusal.
 */
function parseTaskCreateFlags(tokens: readonly string[]): TaskCreateInput {
  const specification: string[] = [];
  const features: string[] = [];
  let displayTitle: string | undefined;
  let namingTitle: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const value = tokens[index + 1];
    if (token === '--feature') {
      // The id is validated against the project's declared mapping by the Runtime, not here: which
      // features exist is a property of the repository (ADR-0059).
      if (value === undefined || value.trim().length === 0) usage();
      features.push(value.trim());
      index += 1;
    } else if (token === '--title') {
      if (value === undefined || value.trim().length === 0) usage();
      displayTitle = value.trim();
      index += 1;
    } else if (token === '--name') {
      if (value === undefined || !taskNamingTitlePattern.test(value)) usage();
      namingTitle = value;
      index += 1;
    } else if (token.startsWith('--')) {
      // An unknown flag is a mistake, not part of the detail; the detail itself can always be passed
      // first or quoted. `--constraint` and `--kind` land here on purpose (ADR-0065 D04).
      usage();
    } else {
      specification.push(token);
    }
  }
  if (specification.length === 0 || displayTitle === undefined || namingTitle === undefined) usage();
  return { displayTitle, namingTitle, specification: specification.join(' '), features };
}

/**
 * Flags for `task revision create`. The detail is optional: omitting it keeps the current one and
 * changes only the feature declaration, which since ADR-0065 is the only other revision-level fact
 * (constraints were deleted, so there is no "only add a constraint" revision any more).
 */
function parseRevisionFlags(tokens: readonly string[]): {
  readonly specification: string | undefined;
  /** Absent means "inherit the current revision's declaration" (ADR-0059 D03). */
  readonly features: readonly string[] | undefined;
  readonly reason: string;
} {
  const specification: string[] = [];
  const features: string[] = [];
  let featuresGiven = false;
  let reason = 'user revision request';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const value = tokens[index + 1];
    if (token === '--specification') {
      if (value === undefined || value.trim().length === 0) usage();
      specification.push(value.trim());
      index += 1;
    } else if (token === '--feature') {
      // An explicit `--feature` is how a Task begins (or stops) declaring a feature: repeated flags
      // build the list, and no flag at all inherits the previous declaration instead of clearing it.
      if (value === undefined || value.trim().length === 0) usage();
      features.push(value.trim());
      featuresGiven = true;
      index += 1;
    } else if (token === '--reason') {
      if (value === undefined || value.trim().length === 0) usage();
      reason = value.trim();
      index += 1;
    } else if (token === '--json') {
      // Every revision command prints the Runtime result verbatim; the flag is accepted so a script
      // can state its intent without depending on that default.
    } else if (token.startsWith('--')) {
      usage();
    } else {
      specification.push(token);
    }
  }
  return {
    specification: specification.length === 0 ? undefined : specification.join(' '),
    features: featuresGiven ? features : undefined,
    reason,
  };
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
  const read = await readTranscript(execution.session.sessionId, flags);
  if (flags.json) print(read.view);
  else printTranscript(read, execution.session.sessionId, flags.reverse);
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

/** One recorded boundary of a long command, as the Runtime projects it. */
interface OperationProgressView {
  readonly sequence: number;
  readonly stepKey: string;
  readonly step: string;
  readonly state: string;
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly recordedAt: number;
}

interface OperationView {
  readonly operationId: string;
  readonly projectId: string;
  readonly kind: string;
  readonly aggregateId: string;
  readonly taskId: string | null;
  readonly state: string;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly cancelRequestedAt: number | null;
  readonly steps: readonly OperationProgressView[];
}

/** `--json` is the only flag these reads accept; anything else is a usage error. */
function jsonOnlyFlag(flags: readonly string[]): boolean {
  if (flags.some((flag) => flag !== '--json')) usage();
  return flags.length > 0;
}

function stepSummary(step: OperationProgressView): string {
  const detail = step.detail;
  if (detail === null) return '';
  if (Array.isArray(detail['argv'])) {
    return `${(detail['argv'] as readonly string[]).join(' ')} (cwd ${String(detail['cwd'] ?? '.')})`;
  }
  if ('durationMs' in detail) {
    return `exit ${detail['exitCode'] === null ? 'unknown' : String(detail['exitCode'])}`
      + `${detail['timedOut'] === true ? ' · 超时' : ''} · ${String(detail['durationMs'])}ms`;
  }
  if (typeof detail['executionId'] === 'string') {
    return `${detail['executionId'].slice(0, 8)}${'attemptNumber' in detail
      ? ` · 第 ${String(detail['attemptNumber'])} 次` : ''}`;
  }
  const rendered = JSON.stringify(detail);
  return rendered.length > 200 ? `${rendered.slice(0, 200)}…` : rendered;
}

function printOperation(operation: OperationView): void {
  // A cancelled Operation is recorded the ADR-0019 way (`FAILED` + `cancelled: true`): printing only
  // the state word would report a user stop as a failed command.
  const state = operation.result?.['cancelled'] === true
    ? `${operation.state} · 已取消（用户）`
    : operation.state;
  console.log(`=== ${operation.kind} ${operation.operationId.slice(0, 8)} ${state}`
    + `${operation.cancelRequestedAt === null ? '' : ' · 已请求取消'}`);
  console.log(`  created ${new Date(operation.createdAt).toLocaleString('zh-CN')}`
    + ` · updated ${new Date(operation.updatedAt).toLocaleString('zh-CN')}`);
  if (operation.result !== null) console.log(`  result ${JSON.stringify(operation.result)}`);
  if (operation.steps.length === 0) console.log('  （还没有记录任何步骤）');
  for (const step of operation.steps) {
    console.log(`  ${String(step.sequence).padStart(2, ' ')} ${step.step.padEnd(16, ' ')}`
      + ` ${step.state.padEnd(9, ' ')} ${stepSummary(step)}`);
  }
}

/**
 * Long-command Operations are a fact list, so the human view prints every step in order and
 * `--json` prints the Runtime's projection verbatim for scripts.
 */
function printOperations(operations: readonly OperationView[], json: boolean): void {
  if (json) { print(operations); return; }
  if (operations.length === 0) { console.log('这个任务没有长命令记录。'); return; }
  for (const operation of operations) printOperation(operation);
}

/** The `task.depends.list` projection this client reads. */
interface TaskDependencyView {
  readonly projectId: string;
  readonly taskId: string | null;
  readonly taskState: string | null;
  readonly taskVersion: number | null;
  readonly baseRef: string;
  readonly baseCommit: string | null;
  readonly edges: readonly {
    readonly dependentDisplayNumber: number;
    readonly prerequisiteDisplayNumber: number;
    readonly requiredRevisionNumber: number;
    readonly resultCommit: string | null;
    readonly satisfied: boolean;
    readonly reason: { readonly code: string } | null;
  }[];
  readonly blocked: boolean;
  readonly prerequisites: readonly string[];
  readonly dependents: readonly string[];
}

/**
 * Splits one command's tokens into positionals and flags. A flag that is not in either list is a
 * usage error rather than a silently ignored argument, and a `--flag` that needs a value must have
 * one (never swallowing the next flag).
 */
function splitFlagTokens(
  tokens: readonly string[],
  valuedFlags: readonly string[],
  bareFlags: readonly string[],
): { readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string>; readonly bare: ReadonlySet<string> } {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const bare = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    if (bareFlags.includes(token)) {
      bare.add(token);
      continue;
    }
    if (valuedFlags.includes(token) && !flags.has(token)) {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith('--')) usage();
      flags.set(token, value);
      index += 1;
      continue;
    }
    usage();
  }
  return { positionals, flags, bare };
}

/**
 * Human-readable projection of one detection read. The lines are deliberately narrow: kind, name,
 * the layer it came from, whether the provider has it enabled, whether Codeestra can enable it and
 * the stable reason when it cannot. `--json` prints the Runtime's own payload instead.
 */
function printAgentPlugins(detection: AgentPluginDetection): void {
  console.log(`adapter: ${detection.adapterId}`
    + `  pluginSelection: ${detection.pluginSelectionSupport}`);
  console.log(`provider config directory: ${detection.providerConfigDirectory}`
    + `${detection.providerStateReadable ? '' : '  (settings.json unreadable: provider enablement is UNVERIFIED)'}`);
  if (detection.pluginSelectionSupport !== 'SUPPORTED') {
    console.log('This adapter does not support plugin selection; no candidates are reported.');
    return;
  }
  if (detection.selection !== null) {
    const paths = agentPluginKinds.flatMap((kind) => detection.selection?.[kind] ?? []);
    console.log(`selected (${detection.selectionSource ?? 'UNKNOWN'}): ${paths.length === 0 ? '(none)' : ''}`);
    for (const path of paths) console.log(`  - ${path}`);
  } else {
    console.log('selected: (none)');
  }
  console.log(`candidates: ${detection.candidates.length}`);
  for (const candidate of detection.candidates) {
    const enabled = candidate.providerEnabled === null ? 'provider?=UNVERIFIED'
      : `provider=${candidate.providerEnabled ? 'on' : 'off'}`;
    const usable = candidate.selectable ? 'selectable' : `UNUSABLE(${candidate.reason ?? 'UNKNOWN'})`;
    console.log(`  [${candidate.selected ? 'x' : ' '}] ${candidate.kind.padEnd(15)}`
      + ` ${candidate.name.padEnd(24)} ${enabled} ${usable} ${candidate.source} ${candidate.path}`);
  }
}

/** Human-readable confirmation of one selection write, including the layers it applies to. */
function printAgentPluginSelection(view: AgentConfigurationView): void {
  const selection = view.pluginSelection;
  const total = selection === null
    ? 0
    : agentPluginKinds.reduce((sum, kind) => sum + (selection[kind]?.length ?? 0), 0);
  console.log(`pluginSelectionSource: ${view.pluginSelectionSource ?? '(none)'}`
    + `  paths: ${total}`);
  if (selection !== null) {
    for (const kind of agentPluginKinds) {
      for (const path of selection[kind] ?? []) console.log(`  ${kind} ${path}`);
    }
  }
  if (view.thirdPartyExtensionApprovalRisk) {
    console.log('note: a third-party extension is selected; it can influence or bypass '
      + "Codeestra's approval channel (ADR-0044 D03).");
  }
  console.log('Applies to the next Agent Session; the effective list is recorded with the Execution.');
}

/**
 * The settings overview as a person reads it: one line per setting with its effective value, whether
 * that value is this Runtime home's own choice or the product default, the values it accepts, and
 * where it is stored. `--json` prints the Runtime's payload verbatim instead — that payload is the
 * complete record, including what a change to each setting applies to.
 */
function printSettingsList(view: SettingsListView): void {
  console.log(`Runtime settings (${view.home})`);
  const keyWidth = Math.max(...view.settings.map((entry) => entry.key.length));
  const valueWidth = Math.max(...view.settings.map((entry) => String(entry.value).length));
  for (const entry of view.settings) {
    const accepted = entry.values === null
      ? `${String(entry.range?.min)}-${String(entry.range?.max)}`
      : entry.values.join('|');
    const stored = entry.store === 'RUNTIME_FILE' && entry.file !== null
      ? basename(entry.file) : 'Runtime database';
    console.log(`  ${entry.key.padEnd(keyWidth)}  ${String(entry.value).padEnd(valueWidth)}`
      + `  ${entry.source === 'RUNTIME' ? 'set    ' : 'default'}`
      + `  accepted ${accepted} · default ${String(entry.default)} · ${stored}`);
  }
  console.log(`  ${view.appliesTo}`);
  console.log('  `settings list --json` prints the full record, including what each change applies to.');
}

function usage(): never {
  console.error(`Usage:
  bun run codeestra status
  bun run codeestra stop [--wait <seconds>]
  bun run codeestra agent config get [--project <project-id>] [--adapter <id>]
  bun run codeestra agent config set [--project <project-id>] [--adapter <id>]
    [--provider <name>] [--model <id>] [--thinking <off|minimal|low|medium|high|xhigh|max>]
    [--unset provider|model|thinking]
  bun run codeestra agent config clear [--project <project-id>] [--adapter <id>]
  bun run codeestra agent plugins list [--project <project-id>] [--adapter <id>] [--json]
  bun run codeestra agent plugins select [--project <project-id>] [--adapter <id>]
    [--extension <path>]… [--skill <path>]… [--prompt-template <path>]… [--theme <path>]…
    [--clear] [--json]
    # The four kinds are the scope the user approved (ADR-0044): extensions, skills, prompt
    # templates and themes. "select" replaces the whole selection with exactly the flags given
    # (repeatable flags rather than a JSON file, so a path never needs a second escaping rule);
    # "--clear" removes the selection.
    # Every selected path is verified before anything is written and again before a Session starts;
    # a path that cannot be loaded is refused with a stable code and no Execution is created.
    # Exit codes: 0 applied, 1 refused (unusable path or adapter without plugin selection), 2 usage.
  bun run codeestra service list [--kind <ROOT|SCHEDULER|ATTENTION|PROJECT|TASK>]
    [--parent <service-id>] [--all] [--json]
  bun run codeestra service get <service-id> [--json]
  bun run codeestra service tree [service-id] [--json]
  bun run codeestra service state get <service-id> [--json]
  bun run codeestra service state set <service-id> --namespace <name> --key <name>
    --value-json <json> --expected-version <n> [--json]
  bun run codeestra process list [--service <service-id>] [--state <state>] [--json]
  bun run codeestra process get <process-id> [--json]
  bun run codeestra process input <process-id> --message <text> [--json]
  bun run codeestra process pause <process-id> <expected-control-version> [--json]
  bun run codeestra process resume <process-id> <expected-control-version> [--adapter <id>]
    [--allow-unknown] [--json]
  bun run codeestra process terminate <process-id> <expected-control-version> [--json]
  bun run codeestra signal send <target-service-id> --kind <SIG_A|SIG_P> --subtype <name>
    --payload-json <json> --idempotency-key <key> [--contract-version <n>] [--source-service <id>]
    [--source-process <id>] [--correlation <id>] [--causation <id>] [--priority <n>] [--json]
  bun run codeestra signal list [--service <id>] [--state <state>] [--kind <SIG_A|SIG_P>]
    [--limit <n>] [--json]
  bun run codeestra signal get <signal-id> [--json]
  bun run codeestra signal retry <signal-id> [--json]
  bun run codeestra intent send <text…> [--service <id>|--project <id>|--task <id>]
    [--adapter <id>] [--json]
  bun run codeestra project inspect [path]
  bun run codeestra project policy [path]
  bun run codeestra project trust [path] [--yes]
  bun run codeestra project list
    # ADR-0066: the product no longer models a dev clone, a long-lived dev branch, integration into
    # it or dev→main promotion, so there is no \`--dev-repo\` flag and no DEV_REPO_* code. A Task
    # worktree is based on the branch the project folder has checked out right now, fixed with the
    # workspace; a detached HEAD there is refused with TASK_BASE_REF_UNRESOLVED (check out a branch,
    # or pass --base-ref to task run). project inspect reports the repository identity and says the
    # baseline in one line.
  bun run codeestra project impact validate [path] [--json]
  bun run codeestra project impact show <project-id> <task-id> [--json]
  bun run codeestra project impact explain <project-id> <task-id> [--json]
    # exit 0 for validate only when a mapping exists at the main ref and is the confirmed one;
    # exit 0 for explain only for SAFE_TO_PARALLELIZE. UNKNOWN means "cannot be proven", not
    # "no conflict", and exits 1 like CONFLICTING does (the code is in --json).
  bun run codeestra project knowledge validate <project-id> [--json]
  bun run codeestra project knowledge list <project-id> [--json]
  bun run codeestra project knowledge show <project-id> [snapshot-id] [--json]
  bun run codeestra project knowledge resolve <project-id> <task-id> [--json]
    # The human-maintained layers (.codeestra/instructions, .codeestra/skills) are read from the
    # project main ref only, so a Task branch can never rewrite the knowledge that judges its own
    # execution. The machine-generated layer is Runtime data, not part of the project tree. validate
    # and list exit 1 when any entry is refused (there is then no snapshot at all); show exits 1 when
    # the project has no recorded snapshot; resolve reports what the next Execution would use and
    # exits 1 only when no honest answer exists.
  bun run codeestra task create <project-id> <任务详情…> --title <显示标题> --name <命名标题>
    [--feature <module-id>]…
    # 三个字段都必须给出（ADR-0065）：--title 是一句话摘要（任务列表显示它），
    # --name 是小写英文短横线 slug（^[a-z][a-z0-9]*(-[a-z0-9]+)*$，≤ 50 字符），
    # 用于分支 task/<编号>-<name> 与 worktree 目录；位置参数是任务详情。缺任一字段退出码 2。
    # --feature declares the feature(s) this Task works on: module ids from the project's
    # .codeestra/impact.json as read from its main ref. The Runtime refuses an id the mapping does
    # not declare (UNKNOWN_FEATURE), and refuses any declaration when the mapping cannot be read.
    # A Task that declares nothing is never in a feature conflict (ADR-0059).
    # --constraint 与 --kind 已删除（ADR-0065），传入会被当作未知 flag。
  bun run codeestra task list <project-id> [--all]
  bun run codeestra task submit <project-id> <task-id> <expected-version>
  bun run codeestra task run <project-id> <task-id> <expected-version> [--adapter <pi|codex|claude>]
    [--base-ref <refs/heads/...>] [--allow-unknown] [--json]
    Adapters: pi (default), codex, claude. Every run is bound to one Agent; changing --adapter starts a
    new Execution rather than switching the Agent inside one. This is the explicit start request of
    the same gate the automatic scheduler applies, so it exits 3 when the Task is *waiting* (the
    conflict or capacity reason code is in --json and on stderr) and 1 when it is refused.
    --base-ref fixes the baseline of a **new** workspace (ADR-0066): a local branch of the project
    folder. Omitted, the baseline is the branch that folder has checked out right now. A Task that
    already has a workspace keeps its recorded baseline and the flag
    is refused with TASK_BASE_REF_ALREADY_FIXED instead of being ignored; a ref that is not a local
    branch exits 1 with TASK_BASE_REF_NOT_A_BRANCH, and a missing one with TASK_BASE_REF_MISSING.
  bun run codeestra task pause <project-id> <task-id> <expected-version>
  bun run codeestra task resume <project-id> <task-id> <expected-version> [--adapter <pi|codex|claude>]
    [--allow-unknown]
    resume continues the *same* provider conversation of a PAUSED Task. A retry is a different
    operation: it requeues a FAILED Task and a new Execution follows.
  bun run codeestra task retry <project-id> <task-id> <expected-version> [--adapter <pi|codex|claude>]
    [--json]
    Retries a FAILED Task. Nothing is automatic: only this command requeues it. Without --adapter
    the Adapter this Task last ran on is reused. The Task goes back to READY (or BLOCKED when an
    upstream dependency is unmet) and the Runtime then asks the same scheduling gate that
    "task run" uses for one start of *that* Task, so a retry queues behind conflicts and capacity
    instead of jumping them. Exit 0 only when the new Execution started, 3 when the Task is
    requeued and waiting (the reason code is in --json and on stderr), 1 when the retry or the start
    was refused.
  bun run codeestra task recover <project-id> <task-id> <expected-version> [--reason <text>] [--json]
    The reconcile of a RECOVERY_REQUIRED Task (ADR-0055), the step the state machine promised and no
    command face had. It reads real facts only — the recorded provider process identity (checked
    against the real process table, start token and descendants), the recorded descendant snapshot,
    and whether the recorded workspace is still on disk — and it changes something only when the
    provider is provably gone: Execution and Task become FAILED (the resource is released), the
    Session becomes EXITED, and the workspace becomes RETAINED. It never signals a process, never
    removes or moves a worktree, never rewrites exit_json and never claims quiescence
    (quiescenceProven: false, signalsSent: 0). A refusal changes nothing and exits 1 with
    RECOVERY_PROVIDER_ALIVE / RECOVERY_DESCENDANTS_ALIVE / RECOVERY_OWNERSHIP_UNVERIFIABLE /
    RECOVERY_PROCESS_IDENTITY_MISSING; TASK_NOT_IN_RECOVERY is exit 1 as well, ALREADY_RECONCILED is
    exit 0 and read-only. After it, "task retry" can requeue the Task and "task cancel" can retire it
    ("task purge" performs this same reconcile itself before deleting, so a manual recover is optional).
  bun run codeestra task cancel <project-id> <task-id> <expected-version>
  bun run codeestra task archive <project-id> <task-id> <expected-version>
  bun run codeestra task unarchive <project-id> <task-id> <expected-version>
  bun run codeestra task purge <project-id> <task-id> <expected-version> --yes [--force] [--reason <text>] [--json]
    # DESTRUCTIVE and irreversible: deletes the Task, its revisions, executions, sessions, evidence,
    # owned worktrees, verification copies and branches. A non-terminal Task is cancelled first
    # through the ordinary cooperative stop, and a RECOVERY_REQUIRED Task is reconciled by
    # observation first (the "task recover" rule; result stop.stop: "RECOVERED"); a stop or a
    # provider that cannot be proven gone deletes nothing (RECONCILE_REQUIRED, exit 1).
    # --yes is required and is the only guard; without it the command exits 2 without sending
    # anything. --force (ADR-0058 D09) is the same caller saying "delete it anyway": the Runtime
    # first tries to terminate the provider processes the Task recorded (identity-verified pids
    # only), then deletes what it otherwise would have refused — a provider it could not prove gone
    # and resources whose ownership it cannot prove (those files are left on disk).
    # Everything stepped over is printed to stderr and recorded in the forced field of the view
    # (stop.stop: "FORCED") and in the TaskPurged audit event. Replaying the same command ID returns
    # the receipt instead of a second deletion.
    # stdout is the printed view (JSON shape regardless of --json), including rowsDeleted,
    # dependencyEdgesRemoved and the tip commit of every branch that was deleted.
  bun run codeestra task status <project-id> <task-id> [--json]
    # every Execution's Agent completion is printed with its note; a code such as
    # PROSE_QUESTION_NO_TOOL_USE marks a completion the Runtime annotated instead of
    # leaving an unexplained SUCCESS (heuristic: no tool call in the run and the last
    # assistant text ends with a question mark). The note is printed to stderr.
    # --json is accepted and is the default, so a script can state its intent.
  bun run codeestra task revision create <project-id> <task-id> <expected-version>
    [--specification <text>] [--feature <module-id>]… [--reason <text>] [--json]
    # --feature sets the feature declaration of the new revision (validated against the project's
    # mapping). Omitting it inherits the current revision's declaration; passing it at all replaces
    # the declaration with the ids given (ADR-0059).
    # 至少要有 --specification 或 --feature 之一：什么都不改的修订会被拒为 INVALID_REVISION。
    # --constraint 已删除（ADR-0065），传入会被当作未知 flag。
  bun run codeestra task revision list <project-id> <task-id> [--json]
  bun run codeestra task revision delivery list <project-id> <task-id> [--json]
  bun run codeestra task revision delivery get <project-id> <delivery-id> [--json]
  bun run codeestra task revision delivery resolve <project-id> <task-id> <delivery-id>
    <expected-version> --action <stop-and-restart|retry> [--adapter <id>] [--json]
    # exit 0 only when the delivery ended satisfied; 1 when it stays unconfirmed
  bun run codeestra task transcript <project-id> <task-id> [--execution <id>] [--after <entry-id>]
    [--limit <n>] [--reverse] [--json]
  bun run codeestra session transcript <session-id> [--after <entry-id>] [--limit <n>] [--reverse]
    [--json]
  bun run codeestra session transcript part <session-id> <entry-id> <part-index>
  bun run codeestra session guide <project-id> <task-id> --message <text> [--json]
    # Session Guidance, not a TaskRevision: it never changes the specification and never invalidates
    # a verification. exit 0 = handed to the running conversation or recorded with nothing running;
    # 1 = a provider was asked and did not take it (CHANNEL_UNSUPPORTED/TIMED_OUT/FAILED).
    # "delivered" means the provider's channel accepted the message (enqueued), not that the model
    # read it (ADR-0051/0057).
  bun run codeestra session guidance list <project-id> <task-id> [--json]
  bun run codeestra session guidance get <project-id> <guidance-id> [--json]
  bun run codeestra session handoff status <project-id> <session-id> [--json]
  bun run codeestra session handoff request <project-id> <session-id> <takeover|return>
  bun run codeestra session handoff cancel <project-id> <session-id>
  bun run codeestra session handoff writer acquire <project-id> <session-id> --holder <ref>
    [--kind AUTOMATED_RPC|TERMINAL_ATTACHMENT]
  bun run codeestra session handoff writer release <project-id> <session-id> --holder <ref>
  bun run codeestra session handoff admit <project-id> <session-id>
  bun run codeestra session handoff attach <project-id> <session-id> --holder <ref>
    [--writer|--observer] [--since <cursor>]
  bun run codeestra session handoff detach <project-id> <session-id> --holder <ref>
  bun run codeestra session handoff release <project-id> <session-id> [--no-resume]
  bun run codeestra session handoff terminal read <project-id> <session-id> [--since <cursor>]
  bun run codeestra session handoff terminal write <project-id> <session-id> --text <text>
  bun run codeestra session handoff terminal resize <project-id> <session-id> --cols <n> --rows <n>
    [--holder <ref>] [--json]
    # exit 0 only when the PTY really changed size (the transport's own answer), 1 when it refused
    # (not held, writer seat taken) or did not take effect, 2 for an out-of-range size
  bun run codeestra task result capture <project-id> <task-id> [execution-id]
  bun run codeestra task result prepare <project-id> <task-id> [execution-id]   # strict mode
  bun run codeestra task result commit <project-id> <task-id> <authorization-id> --confirm
  bun run codeestra task verify <project-id> <task-id> [execution-id] [--background]
    [--policy <auto|targeted|project>]
  bun run codeestra task verification list <project-id> <task-id>
  bun run codeestra task tests record <project-id> <task-id> [--commit <full-sha>]
    [--expected-plan-digest <sha256>] [--json]
  bun run codeestra task tests show <project-id> <task-id> [--json]
  bun run codeestra task tests history <project-id> <task-id> [--limit <n>] [--json]
  bun run codeestra task operation list <project-id> <task-id> [--json]
  bun run codeestra task operation get <project-id> <operation-id> [--json]
  bun run codeestra task operation cancel <project-id> <task-id> <operation-id> [--json]
  bun run codeestra task depends add <project-id> <task-id> <expected-version>
    <prerequisite-task-id> [--revision <revision-id>] [--json]
  bun run codeestra task depends remove <project-id> <task-id> <expected-version>
    <prerequisite-task-id> [--json]
  bun run codeestra task depends list <project-id> [task-id] [--json]
  bun run codeestra task schedule status <project-id> [--adapter <id>] [--json]
  bun run codeestra task schedule plan <project-id> [--adapter <id>] [--json]
  bun run codeestra task schedule explain <project-id> <task-id> [--adapter <id>] [--json]
  bun run codeestra task schedule run <project-id> [--adapter <id>] [--json]
  bun run codeestra task schedule clear-unknown <project-id> <task-id> [--json]
  bun run codeestra events list [--project <project-id>] [--since <sequence>] [--limit <n>] [--json]
  bun run codeestra events tail [--project <project-id>] [--since <sequence>]
  bun run codeestra attention list <project-id>
  bun run codeestra attention answer <project-id> <attention-id> confirm <yes|no>
  bun run codeestra attention answer <project-id> <attention-id> value <text>
  bun run codeestra attention answer <project-id> <attention-id> cancel
  bun run codeestra attention answer <project-id> <attention-id> [--choose <question>:<options>]…
    [--text <question>=<text>]… [--cancel]
  bun run codeestra attention resolve <project-id> <attention-id> --dismiss [--note <text>] [--json]
  bun run codeestra attention resolve <project-id> <attention-id> --answer <text> [--note <text>] [--json]
  bun run codeestra settings list [--json]
  bun run codeestra settings permission get [--json]
  bun run codeestra settings permission set <full|strict> [--json]
  bun run codeestra settings prose-question-attention [auto|record-only|off] [--json]
  bun run codeestra settings concurrency get [--json]
  bun run codeestra settings concurrency set --limit <n> [--json]
  bun run codeestra settings concurrency reset [--json]
  bun run codeestra reclaim plan [--project <project-id> | --all-projects] [--task <task-id>]
    [--kind <TASK_WORKTREE|VERIFICATION_COPY|INTEGRATION_WORKTREE>]… [--include-failure-scenes]
    [--unregistered] [--scan-root <path-inside-home>] [--remove-unregistered <path>]… [--json]
  bun run codeestra reclaim apply [--project <project-id> | --all-projects] [--task <task-id>]
    [--kind <kind>]… [--include-failure-scenes] [--unregistered] [--scan-root <path-inside-home>]
    [--remove-unregistered <path>]… [--json]
  bun run codeestra reclaim records [--project <project-id> | --all-projects] [--task <task-id>]
    [--source <ALL|REGISTERED|UNREGISTERED_DIRECTORY>] [--since <epoch-ms|ISO>] [--until <epoch-ms|ISO>]
    [--limit <n>] [--json]
  bun run codeestra scheduler capacity get [--json]
  bun run codeestra scheduler capacity set --limit <n> [--json]
  bun run codeestra scheduler capacity reset [--json]
  bun run codeestra scheduler reservations list <project-id> [--task <task-id>]
    [--include-released] [--limit <n>] [--json]
  bun run codeestra scheduler reservations get <project-id> <reservation-id> [--json]
  bun run codeestra scheduler reservations acquire <project-id> <task-id> <expected-task-version>
    --revision <revision-id> [--snapshot <impact-snapshot-id>] [--adapter <id>] [--json]
  bun run codeestra scheduler reservations release <project-id> <reservation-id> --reason <text>
    [--json]
  bun run codeestra scheduler reservations prepare-workspace <project-id> <reservation-id>
    <expected-task-version> [--json]
  bun run codeestra scheduler reservations reconcile <project-id> [--json]
  bun run codeestra scheduler control status [--json]
  bun run codeestra scheduler control pause [--json]
  bun run codeestra scheduler control resume [--json]
  bun run codeestra scheduler control reconcile [--json]
    The Runtime global load control (ADR-0061). It belongs to no Project: one CODEESTRA_HOME has one
    host-wide barrier. pause freezes the admitted execution set at the process level — no new
    Execution/Session starts and no new Provider delivery, while running tasks keep their Task,
    Execution and Session state and their capacity slot. resume continues exactly the processes this
    pause epoch verified and froze; a target whose pid changed or exited is reported instead of being
    woken. Exit codes: 0 reached the complete target state (or it was already there); 1 a target could
    not be verified, the platform cannot freeze a provider, or a resume is still in flight, with the
    stable code (GLOBAL_PAUSE_UNSUPPORTED, GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE,
    GLOBAL_PAUSE_TARGET_NOT_STOPPED, GLOBAL_RESUME_TARGET_CHANGED, GLOBAL_PAUSE_RECOVERY_REQUIRED,
    GLOBAL_CONTROL_IN_PROGRESS) in --json and on stderr; 3 is used only by a Task that *waits* for the
    barrier (SCHEDULER_GLOBALLY_PAUSED), never for a partially frozen Runtime. reconcile only observes
    and records: it sends no signal, and it never turns an unverifiable target into a stopped one.

attention resolve ends a prose-question wait: an Agent that used no tool and ended its turn by
asking its question in ordinary prose leaves a Task whose provider process already exited. The
Runtime records that as its own Attention (a heuristic about the shape of the ending, never a claim
about intent) and puts the Task in WAITING_FOR_USER; --dismiss records a false alarm, --answer
records the user's own text. Neither resumes the conversation and neither is a TaskRevision: an
answer is a statement about this wait, not an amendment of the specification. Delivering one through
attention answer is refused with PROSE_QUESTION_RESOLUTION_REQUIRED, because there is no provider
dialog to write to.

settings list is the overview of every enabled Runtime-level setting (ADR-0064/0067): the
permission mode, the prose-question switch and the one concurrency limit, each with its effective
value, its product default, whether it is this Runtime home's own choice or the product default, the
values it accepts and where it is stored. Every entry comes from the same read its own command uses,
so the list cannot disagree with settings permission get, settings prose-question-attention or
scheduler capacity get. Human-readable by default; --json prints the whole record.

settings permission reads or writes the permission mode (ADR-0011). It is a setting like any other:
get reports the mode in force with the product default, set accepts a case-insensitive full|strict,
needs no confirmation, and writes $CODEESTRA_HOME/permission-mode.json (0600, atomic replacement).
The mode applies to new operations and new Agent sessions; a Session already running keeps the mode
it started with.

settings prose-question-attention reads or writes the global switch that decides
whether such a completion becomes a wait at all (auto, the default; record-only; off). Changing it
needs no confirmation and never rewrites a wait that was already recorded.

settings concurrency is the settings spelling of the one Runtime-wide concurrency limit (ADR-0061):
get, set --limit <n> and reset send exactly the same Runtime commands as scheduler capacity, so the
value, its audit event and its idempotency can never diverge between the two spellings. It is a
setting, not a gate: zero confirmations, same behavior in FULL and STRICT, and a change takes effect
on the next scheduling decision — raising it triggers a scheduling pass for every project (a Task
waiting on capacity can therefore start immediately), while lowering it never pauses, releases or
terminates a Task that already holds a slot. Invalid limits are refused with the same stable codes.

--reverse prints the newest transcript entry first. It is a rendering choice for the human view
only (it is refused together with --json), and because the command face reads forward from a cursor
it may read up to ${maxTranscriptReverseReads} pages to reach the newest entries.

task verify --background returns a durable Operation handle instead of waiting for the policy to
finish; follow it with task operation list and stop it with task operation cancel. Exit code 0 there
means "the Operation was recorded and started", not "the verification passed".

Long-command progress is published as domain events: every step and every observed output chunk of
a running verification, and the Operation's settle, arrive on the same stream as everything else
(events tail). A progress event never carries a verdict — a passed
verification is only ever reported by VerificationCompleted and by the run's own state.

ADR-0066 removed the whole integration and promotion face this text used to describe: there is no
\`task integrate\`, no \`task integration *\`, no \`promotion *\`, no IntegrationBatch, no independent
integration verification and no dev clone. A Task's result commit stays on \`refs/heads/task/<task-id>\`
and merging it is the user's own Git step; the Runtime never merges, never pushes and keeps no
promotion records. Likewise no command reports a dev baseline any more: the one Task baseline is the
branch the project folder has checked out when the workspace is prepared.

ADR-0038 splits verification cost by branch responsibility. A \`task/*\`, \`lane/*\` or feature branch
commits its own small \`.codeestra/tests.json\` (a scope statement plus 1-16 argv commands, each with
what it covers); \`task tests record\` snapshots that file into an append-only record bound to the
exact task/revision/commit, and \`task verify\` runs that recorded plan -- never the file, so a scope
change is an explicit audited append. A Task with no recorded plan keeps using the fixed project
policy, and a recorded plan that belongs to another revision or commit is refused instead of being
silently replaced by the project policy. (The \`dev → main\` full-suite evidence gate this paragraph
used to describe went with the promotion face; this repository's own full-suite discipline is stated
in AGENTS.md instead.)

scheduler capacity get reports the **Runtime-wide** concurrency facts a scheduler uses: the single
limit for this CODEESTRA_HOME and where it came from, how many slots are occupied across every
project with the occupiers themselves (project, task, adapter, since, reservation or Execution), the
stable reason code a new acquisition would get right now, the global control state, and whether the
Runtime is draining. It takes no project and no adapter: a candidate's project and adapter no longer
produce a second ceiling. scheduler capacity set --limit <n> writes that one limit and reset removes
the explicit value so the documented default 2 applies again; both are zero-confirmation, both read
the value back, and writing the value that is already effective is an idempotent no-op. An invalid
limit (0, negative, above the ceiling) is refused with its own stable code instead of being clamped.
Exit codes: 0 written or read, 1 refused (CAPACITY_LIMIT_INVALID / CAPACITY_LIMIT_OUT_OF_RANGE), 2
usage. CAPACITY_ADAPTER_SLOT_LIMIT_REACHED is historical: no code path produces it any more, and it
stays readable in old events and old command results.

scheduler reservations acquire is the reservation primitive: it re-checks the Task version, the
assessed revision, the dependency facts, the cached ImpactSnapshot generation and both capacity
dimensions inside one immediate transaction, then records a reservation together with the evidence of
who created it (Runtime boot, pid, OS start token). --snapshot names the ImpactSnapshot the caller
assessed against: the mapping version, analyzer version and observed change set are read again, and
the Task revision and worktree baseline are re-read inside the write transaction, so a generation that
moved is refused with SNAPSHOT_STALE (or SNAPSHOT_UNAVAILABLE when it cannot be confirmed at all)
and no reservation row is written — the recheck is freshness, not a second conflict analysis. Exit code
0 means a slot is held, 3 means a *capacity wait* (the reason code says which limit), and 1 means a
refusal (unmet dependencies, a stale revision, a stale snapshot generation, an already-held slot, ...).
A refusal that carries facts prints them as JSON and then exits 1. Exit code 3 is never BLOCKED:
BLOCKED means unmet dependencies only.

scheduler reservations list shows the active reservations of a project with their holder evidence and
their append-only history (--include-released keeps the audit rows), and get reads one reservation
back by id together with that same history. release is explicit and requires
--reason; nothing releases a slot because a heartbeat expired, a client disappeared or a user waited.
A release refused with SLOT_HOLDER_STILL_RUNNING means the recorded holder process is provably still
alive and was not signalled. prepare-workspace prepares the Task worktree for one reservation and
binds it, and reconcile re-checks every active reservation's recorded holder against the real process
table: a holder proven gone is released and recorded, while a holder that is alive or unverifiable
keeps the slot (RECOVERY_REQUIRED) — no process is signalled and no resource is deleted.

task schedule is the scheduling engine's command face. The Runtime schedules on its own: a
relevant event (submit, integration into dev, a stop, a revision delivery, a freed slot, a capacity
change) triggers a pass, and a periodic recovery pass converges what a crash left behind. status
reports the facts (the active set, occupancy, the last pass), plan is the ordered dry run of the
candidate loop and starts nothing, and explain answers why one Task is not running now: its
dependency verdict, its conflict verdict against every active/reserved Task with the intersecting
paths/directories/modules/shared resources, and the capacity numbers. The order is priority
descending, then creation time, then ID ascending, and raising a priority only changes the next
order — it never interrupts a Task that already holds its resources. explain exits 0 when the Task
is running or would start now, 3 when it is *waiting* (a conflict or capacity wait is never BLOCKED:
BLOCKED means an unmet dependency only), and 1 when it is BLOCKED or not schedulable at all.

task schedule clear-unknown records the explicit single-shot release of an UNKNOWN assessment
(ADR-0030 D05): it is bound to the assessed revision, baseline and analyzer/policy versions, it is
written to the audit ledger, it is consumed by exactly one start, and it does *not* change the
recorded verdict, which stays UNKNOWN. It is a widening of the gate, never a new one: without it,
nothing changes. A CONFLICTING assessment is a proven overlap and is never released (exit 1).

stop asks the Runtime that owns this CODEESTRA_HOME to shut down and then checks the process it
named until it is gone (default 10s, bounded by --wait). It reports STOPPED (exit 0), NOT_EXITED
(exit 1) when the process is still there, NOT_RUNNING when no Runtime owns this home, and
UNREACHABLE_PROCESS (exit 1) when a Runtime process is still there but nothing answers on its
socket. It never starts a Runtime to stop it and never signals a process it cannot identify.

status starts the Runtime when none is running and prints the runtime.ping result together with an
ownership report read from this home's lifecycle records: the lock, the boot traces, and whether
the endpoint answers. It is read-only, so an unreachable Runtime process is reported rather than
replaced. Exit code 1 means the Runtime could not be reached or started.

session handoff attach/detach/release are the native terminal face: attach returns the projected
terminal stream from a cursor (at most one writer attachment; a second one exits 1 with
ATTACHMENT_BUSY), detach leaves the terminal and the provider running, and release writes the
terminal's own release byte, verifies the provider process exited and the provider session file still
holds the conversation, then hands it back to automation on the same session file. Exit code 1 means
the release or the successor start could not be confirmed — never "probably fine".

session handoff projects the Runtime-side handoff contract: the provider incarnation history, the
single writer lease, the handoff fence/safe point and the admission decision. A second writer lease
acquisition exits 1 with ATTACHMENT_BUSY, and a refused admission exits 1. admit really starts the
successor — a PTY-hosted native terminal for takeover, an RPC provider for the return — so it is the
command that moves the lease; it refuses before recording anything rather than leaving a half-started
successor, and an already admitted request replays the successor it recorded instead of starting a
second one.

project impact is deterministic conflict analysis: it maps the owned worktree's Git change set onto
the .codeestra/impact.json mapping at the project main ref and compares it with every Task that
currently holds a resource. It is read-only, it never starts or schedules a Task, and it uses no
model: the verdict is SAFE_TO_PARALLELIZE, UNKNOWN, or CONFLICTING, each with stable reason codes and
the exact intersecting paths, directories, modules, or shared resources. show prints one Task's
ImpactSnapshot, explain explains a verdict against the active Tasks, and validate reports whether a
mapping is present at the main ref and is the digest project trust confirmed. UNKNOWN is recorded
for every Task whose mapping is missing, unconfirmed, invalid, or empty, and for any active Task
whose change set cannot be observed — that is the point: nothing is called safe without proof.

project knowledge is the layered knowledge of PROJECT_SPEC section 4: human-maintained instructions
and skills, plus a machine-generated layer the Runtime owns. The human layers are read from the
project main ref, never from a Task branch, and the machine layer lives under the Runtime data
directory rather than inside the project tree, so it cannot be committed by accident. There is no
override semantics: every human entry that parses is in the snapshot, a duplicate id or path is a
refusal, and a layer with any refused entry produces no snapshot at all — which is what makes it
impossible for a machine to silently replace human knowledge. validate and list report every
refusal, show reads back one recorded snapshot with the Executions bound to it, and resolve reports
what the next Execution of one Task would use without starting anything.`);
  process.exit(2);
}

const [group, action, firstArgument, ...remainingArguments] = Bun.argv.slice(2);

async function currentPermissionMode(): Promise<'FULL' | 'STRICT'> {
  const result = await call({ command: 'permission.get' }) as { mode: 'FULL' | 'STRICT' };
  return result.mode;
}

/**
 * What `project.impact.validate` reports. Only the fields this client renders are named; the rest of
 * the payload is passed through untouched by `--json`.
 */
interface ImpactPolicyValidationView {
  readonly code: 'OK' | 'OK_UNTRUSTED' | 'POLICY_ABSENT' | 'POLICY_INVALID' | 'POLICY_NOT_CONFIRMED';
  readonly valid: boolean;
  readonly repoRoot: string;
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly trusted: { readonly projectId: string; readonly name: string } | null;
  readonly policy: {
    readonly state: 'ABSENT' | 'PRESENT' | 'INVALID';
    readonly digest: string | null;
    readonly contentDigest: string | null;
    readonly label: string | null;
    readonly confirmed: boolean;
    readonly confirmationState: string;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly importantDirectories: number;
    readonly modules: number;
    readonly globalResources: number;
  };
  readonly warnings: readonly string[];
  readonly analyzerVersion: string;
}

interface ImpactSnapshotView {
  readonly taskId: string;
  readonly taskState: string;
  readonly revisionId: string;
  readonly caseMode: string;
  readonly caseModeSource: string;
  readonly disposition: 'RECORDED' | 'REUSED' | 'UNAVAILABLE';
  readonly dispositionDetail: string | null;
  readonly unavailableDetail: string | null;
  readonly baseline: {
    readonly workspaceBaseCommit: string | null;
    readonly projectDevCommit: string | null;
    readonly matchesProjectDev: boolean;
  };
  readonly policy: ImpactPolicyValidationView['policy'];
  readonly snapshot: {
    readonly id: string;
    readonly baseCommit: string;
    readonly policyVersion: string;
    readonly complete: boolean;
    readonly incompleteReasons: readonly string[];
    readonly files: readonly string[];
    readonly importantDirectories: readonly string[];
    readonly modules: readonly string[];
    readonly globalResources: readonly {
      readonly id: string; readonly kind: string; readonly written: boolean; readonly read: boolean;
    }[];
    readonly unclassifiedFiles: readonly string[];
    readonly evidence: readonly string[];
  } | null;
}

interface ImpactExplainView extends ImpactSnapshotView {
  readonly candidate: ImpactSnapshotView;
  readonly active: readonly {
    readonly taskId: string;
    readonly taskState: string;
    readonly executionState: string;
    readonly complete: boolean;
    readonly incompleteReasons: readonly string[];
    readonly disposition: string;
    readonly detail: string | null;
  }[];
  readonly assessment: { readonly verdict: string; readonly reasonCodes: readonly string[] };
  readonly explanation: readonly string[];
}

/**
 * The exact impact-mapping facts the user reviewed, echoed into `project trust` so a mapping that
 * moves between the inspection and the confirmation is refused (`IMPACT_POLICY_CHANGED`) instead of
 * being confirmed silently.
 */
function expectedImpactPolicyConfirmation(report: ImpactPolicyValidationView): ImpactPolicyConfirmation {
  if (report.policy.state === 'PRESENT') {
    return { state: 'PRESENT', mainCommit: report.mainCommit,
      digest: report.policy.digest as string };
  }
  if (report.policy.state === 'INVALID') {
    return { state: 'INVALID', mainCommit: report.mainCommit,
      contentDigest: report.policy.contentDigest as string,
      code: report.policy.errorCode ?? 'INVALID_IMPACT_POLICY' };
  }
  return { state: 'ABSENT', mainCommit: report.mainCommit };
}

function describeImpactPolicy(report: ImpactPolicyValidationView['policy']): void {
  if (report.state === 'ABSENT') {
    console.error('Impact mapping (.codeestra/impact.json at the main ref): absent.');
    console.error('  Without a mapping no impact can be proven complete, so every conflict verdict'+
      ' is UNKNOWN and nothing runs in parallel.');
    return;
  }
  if (report.state === 'INVALID') {
    console.error('Impact mapping (.codeestra/impact.json at the main ref): INVALID.');
    console.error(`  ${report.errorMessage ?? report.errorCode ?? 'unparsable mapping'}`);
    console.error('  Every conflict verdict is UNKNOWN until the mapping parses.');
    return;
  }
  console.error(`Impact mapping (.codeestra/impact.json at the main ref):`+
    ` ${report.label ?? ''}${report.confirmed ? ' (confirmed)' : ' (NOT confirmed)'}`);
  console.error(`  declared: ${report.importantDirectories} important director(ies),`+
    ` ${report.modules} module(s), ${report.globalResources} shared resource(s)`);
  if (!report.confirmed) {
    console.error('  This digest is not the confirmed one, so every verdict is UNKNOWN until the'+
      ' project is trusted again.');
  }
}

/**
 * What `project knowledge *` reports. Only the fields this client renders are named; the rest of
 * each payload is passed through untouched by `--json`.
 */
interface KnowledgeLayerView {
  readonly layer: string;
  readonly kind: string;
  readonly source: string;
  readonly entryCount: number;
  readonly bytes: number;
}

interface KnowledgeErrorView {
  readonly layer: string | null;
  readonly path: string | null;
  readonly code: string;
  readonly message: string;
}

interface KnowledgeEntryView {
  readonly layer: string;
  readonly kind: string;
  readonly path: string;
  readonly id: string | null;
  readonly scope: string;
  readonly digest: string;
  readonly bytes: number;
  readonly origin: Readonly<Record<string, string>>;
  readonly appliesToTask: boolean;
}

interface KnowledgeValidationView {
  readonly projectId: string;
  readonly projectName: string;
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly policyVersion: string;
  readonly code: 'OK' | 'KNOWLEDGE_LAYER_INVALID';
  readonly valid: boolean;
  readonly errors: readonly KnowledgeErrorView[];
  readonly layers: readonly KnowledgeLayerView[];
  readonly snapshotDigest: string | null;
  readonly humanDigest: string | null;
  readonly generatedDigest: string | null;
  readonly entryCount: number;
  readonly humanEntryCount: number;
  readonly generatedEntryCount: number;
  readonly totalBytes: number;
}

interface KnowledgeListView extends KnowledgeValidationView {
  readonly snapshots: readonly {
    readonly id: string;
    readonly snapshotDigest: string;
    readonly mainCommit: string;
    readonly entryCount: number;
    readonly createdAt: number;
    readonly createdBy: string;
  }[];
  readonly entries: readonly KnowledgeEntryView[];
}

interface KnowledgeSnapshotView {
  readonly snapshot: {
    readonly id: string;
    readonly mainRef: string;
    readonly mainCommit: string;
    readonly policyVersion: string;
    readonly snapshotDigest: string;
    readonly humanDigest: string;
    readonly generatedDigest: string;
    readonly entryCount: number;
    readonly humanEntryCount: number;
    readonly generatedEntryCount: number;
    readonly totalBytes: number;
    readonly createdBy: string;
    readonly createdAt: number;
  };
  readonly entries: readonly KnowledgeEntryView[];
  readonly executions: readonly {
    readonly executionId: string;
    readonly taskId: string;
    readonly taskState: string;
    readonly executionState: string;
    readonly contextPath: string;
    readonly contextDigest: string;
    readonly contextBytes: number;
    readonly entryCount: number;
    readonly refs: readonly string[];
  }[];
}

interface KnowledgeResolveView {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskKind: string;
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly policyVersion: string;
  readonly state: 'VALID' | 'INVALID';
  readonly errors: readonly KnowledgeErrorView[];
  readonly snapshotDigest: string | null;
  readonly contextPath: string;
  readonly contextDigest: string | null;
  readonly contextBytes: number | null;
  readonly entryCount: number;
  readonly entries: readonly KnowledgeEntryView[];
}

function describeKnowledgeLayers(layers: readonly KnowledgeLayerView[]): void {
  for (const layer of layers) {
    console.log(`  ${layer.layer} (${layer.kind}, ${layer.entryCount} entries, ${layer.bytes} bytes)`);
    console.log(`    from ${layer.source}`);
  }
}

function describeKnowledgeErrors(errors: readonly KnowledgeErrorView[]): void {
  for (const error of errors) {
    const where = error.path === null ? error.layer ?? 'knowledge' : error.path;
    console.error(`  ${error.code} ${where}: ${error.message}`);
  }
}

function printKnowledgeValidation(report: KnowledgeValidationView): void {
  console.log(`project knowledge: ${report.code}`);
  console.log(`project ${report.projectName} (${report.projectId})`);
  console.log(`main ${report.mainRef} @ ${report.mainCommit.slice(0, 12)}`);
  console.log(`policy ${report.policyVersion}`);
  describeKnowledgeLayers(report.layers);
  if (report.valid) {
    console.log(`snapshot ${String(report.snapshotDigest).slice(0, 16)}`
      + ` (${report.humanEntryCount} human + ${report.generatedEntryCount} generated entries,`
      + ` ${report.totalBytes} bytes)`);
    console.log(`human ${String(report.humanDigest).slice(0, 16)}`
      + ` · generated ${String(report.generatedDigest).slice(0, 16)}`);
  } else {
    console.error(`${report.errors.length} entr${report.errors.length === 1 ? 'y' : 'ies'} refused;`
      + ' no snapshot exists and no Execution may start until they are fixed:');
    describeKnowledgeErrors(report.errors);
  }
}

function printKnowledgeList(report: KnowledgeListView): void {
  printKnowledgeValidation(report);
  if (report.valid) {
    for (const entry of report.entries) {
      console.log(`  ${entry.layer} ${entry.path}`
        + `${entry.id === null ? '' : ` id=${entry.id}`} scope=${entry.scope}`
        + ` ${entry.digest.slice(0, 12)} ${entry.bytes}B`);
    }
  }
  console.log(`recorded snapshots ${report.snapshots.length}`);
  for (const snapshot of report.snapshots) {
    console.log(`  ${snapshot.id.slice(0, 16)} ${snapshot.snapshotDigest.slice(0, 12)}`
      + ` main ${snapshot.mainCommit.slice(0, 12)} ${snapshot.entryCount} entries`
      + ` ${new Date(snapshot.createdAt).toISOString()} by ${snapshot.createdBy}`);
  }
}

function printKnowledgeSnapshot(view: KnowledgeSnapshotView): void {
  const snapshot = view.snapshot;
  console.log(`knowledge snapshot ${snapshot.id}`);
  console.log(`main ${snapshot.mainRef} @ ${snapshot.mainCommit.slice(0, 12)}`
    + ` · policy ${snapshot.policyVersion}`);
  console.log(`snapshot ${snapshot.snapshotDigest}`);
  console.log(`human ${snapshot.humanDigest} · generated ${snapshot.generatedDigest}`);
  console.log(`entries ${snapshot.entryCount}`
    + ` (${snapshot.humanEntryCount} human + ${snapshot.generatedEntryCount} generated),`
    + ` ${snapshot.totalBytes} bytes, recorded ${new Date(snapshot.createdAt).toISOString()}`
    + ` by ${snapshot.createdBy}`);
  for (const entry of view.entries) {
    console.log(`  ${entry.layer} ${entry.path} scope=${entry.scope} ${entry.digest.slice(0, 12)}`);
  }
  console.log(`executions bound to this snapshot ${view.executions.length}`);
  for (const execution of view.executions) {
    console.log(`  execution ${execution.executionId}`
      + ` task ${execution.taskId} (${execution.taskState}/${execution.executionState})`);
    console.log(`    ${execution.contextPath} ${execution.contextDigest.slice(0, 12)}`
      + ` ${execution.contextBytes}B · ${execution.entryCount} entries · ${execution.refs.length} refs`);
  }
}

function printKnowledgeResolve(view: KnowledgeResolveView): void {
  console.log(`project knowledge resolve: ${view.state}`);
  console.log(`task ${view.taskId} (${view.taskKind})`);
  console.log(`main ${view.mainRef} @ ${view.mainCommit.slice(0, 12)} · policy ${view.policyVersion}`);
  if (view.state !== 'VALID') {
    console.error('the knowledge layer is invalid, so no honest answer exists about what an'
      + ' Execution would use:');
    describeKnowledgeErrors(view.errors);
    return;
  }
  console.log(`snapshot ${String(view.snapshotDigest).slice(0, 16)}`);
  console.log(`context ${view.contextPath} ${String(view.contextDigest).slice(0, 12)}`
    + ` ${view.contextBytes}B · ${view.entryCount} entries apply to this Task kind`);
  for (const entry of view.entries) {
    console.log(`  ${entry.layer} ${entry.path}`
      + `${entry.id === null ? '' : ` id=${entry.id}`} scope=${entry.scope}`);
  }
  if (view.entryCount === 0) console.log('  (no knowledge applies to this Task kind)');
}

function printImpactValidation(report: ImpactPolicyValidationView): void {
  console.log(`project impact: ${report.code}`);
  console.log(`repo ${report.repoRoot}`);
  console.log(`main ${report.mainRef} @ ${report.mainCommit.slice(0, 12)}`);
  console.log(report.trusted === null
    ? 'not trusted (run project trust to make a mapping effective)'
    : `trusted as ${report.trusted.name} (${report.trusted.projectId})`);
  describeImpactPolicy(report.policy);
  for (const warning of report.warnings) console.error(`warning: ${warning}`);
  if (report.policy.state === 'INVALID' && report.policy.errorCode !== null) {
    console.log(`error ${report.policy.errorCode}`);
  }
}

function printImpactSnapshot(view: ImpactSnapshotView): void {
  const snapshot = view.snapshot;
  console.log(`task ${view.taskId} (${view.taskState}) revision ${view.revisionId}`);
  if (snapshot === null) {
    console.log(`impact unavailable: ${view.unavailableDetail ?? 'no snapshot could be derived'}`);
    return;
  }
  console.log(`impact ${snapshot.complete
    ? 'complete'
    : `incomplete: ${snapshot.incompleteReasons.join(', ')}`} (${view.disposition})`);
  console.log(`snapshot ${snapshot.id}`);
  console.log(`plan ${snapshot.baseCommit.slice(0, 12)} · mapping ${snapshot.policyVersion}`+
    ` · path case ${view.caseMode} (${view.caseModeSource})`);
  console.log(`baseline ${snapshot.baseCommit.slice(0, 12)} · project dev`+
    ` ${view.baseline.projectDevCommit?.slice(0, 12) ?? 'missing'}`+
    `${view.baseline.matchesProjectDev ? ' (matches)' : ' (DIFFERENT: peers on another baseline are UNKNOWN)'}`);
  console.log(`paths ${snapshot.files.length} changed, ${snapshot.unclassifiedFiles.length}`+
    ' not classified by the mapping');
  if (snapshot.files.length > 0 && snapshot.files.length <= 12) {
    console.log(`  ${snapshot.files.join('\n  ')}`);
  }
  console.log(`important directories: ${snapshot.importantDirectories.length === 0
    ? 'none matched'
    : snapshot.importantDirectories.join(', ')}`);
  console.log(`modules: ${snapshot.modules.length === 0 ? 'none matched' : snapshot.modules.join(', ')}`);
  console.log('shared resources:');
  if (snapshot.globalResources.length === 0) console.log('  none matched');
  for (const resource of snapshot.globalResources) {
    console.log(`  ${resource.id} (${resource.kind})`+
      `${resource.written ? ' changed' : ''}${resource.read ? ' + depends on it' : ''}`);
  }
  for (const line of snapshot.evidence) console.log(`evidence: ${line}`);
}

function printImpactExplanation(view: ImpactExplainView): void {
  printImpactSnapshot(view.candidate);
  console.log(`\ncompared ${view.active.length} active/reserved task(s)`);
  for (const peer of view.active) {
    console.log(`  ${peer.taskId} (${peer.taskState}/${peer.executionState})`+
      ` impact ${peer.complete ? 'complete' : `incomplete: ${peer.incompleteReasons.join(', ')}`}`+
      `${peer.disposition === 'UNAVAILABLE' ? ' UNAVAILABLE' : ''}`);
  }
  // `explainAssessment` already leads with the verdict and its reason codes, so the human view
  // simply prints those lines instead of repeating the header.
  console.log('');
  for (const line of view.explanation) console.log(`  ${line}`);
}

/**
 * The ownership facts `stop` and `status` report. They come from the Runtime's own lifecycle
 * records under this home and are read without writing anything or signalling any process.
 */
function ownershipSummary(inspection: RuntimeHomeInspection): Record<string, unknown> {
  return {
    home: inspection.home,
    socketPath: inspection.socketPath,
    socketPresent: inspection.socketPresent,
    endpointAnswers: inspection.endpointAnswers,
    verdict: inspection.verdict,
    lock: inspection.lock,
    traces: inspection.traces,
    unreadableRecords: inspection.unreadableRecords,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A bounded request that never starts a Runtime: `stop` must not create what it was asked to stop. */
async function tryRequest(command: ClientRequest): Promise<RuntimeResponse | null> {
  try {
    return await request(command);
  } catch {
    return null;
  }
}

const defaultStopWaitMs = 10_000;
const stopPollIntervalMs = 25;
/** Reading the OS process state costs a process spawn, so it is not done on every poll. */
const zombieCheckIntervalMs = 100;

/** `stop [--wait <seconds>]`: how long the client keeps checking whether the process really left. */
function parseStopWaitMs(tokens: readonly string[]): number {
  let waitMs = defaultStopWaitMs;
  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (flag === '--wait' && value !== undefined) {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) {
        throw new Error('--wait expects seconds between 0 and 600');
      }
      waitMs = Math.round(seconds * 1000);
      index += 1;
      continue;
    }
    usage();
  }
  return waitMs;
}

/**
 * Waits, for a bounded time, until the named process is no longer there.
 *
 * A PID is not identity, so the start token the Runtime recorded for itself is compared when it was
 * available: a PID that the OS gave to an unrelated process after the Runtime exited is reported as
 * exited instead of keeping `stop` waiting on a stranger. A zombie is already an exited Runtime
 * (its sockets and files are released), so it counts as stopped instead of waiting for a reap.
 */
async function waitForRuntimeExit(input: {
  readonly pid: number;
  readonly startToken: string | null;
  readonly waitMs: number;
}): Promise<{ readonly exited: boolean; readonly waitedMs: number;
  readonly identityVerified: boolean; readonly identityChanged: boolean }> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + input.waitMs;
  const identityVerified = input.startToken !== null
    && await readProcessStartToken(input.pid) === input.startToken;
  let lastStateCheck = 0;
  for (;;) {
    const waitedMs = Date.now() - startedAt;
    if (!pidExists(input.pid)) {
      return { exited: true, waitedMs, identityVerified, identityChanged: false };
    }
    if (Date.now() - lastStateCheck >= zombieCheckIntervalMs) {
      lastStateCheck = Date.now();
      const state = await readProcessState(input.pid);
      if (state === 'GONE' || state === 'ZOMBIE') {
        return { exited: true, waitedMs, identityVerified, identityChanged: false };
      }
    }
    if (Date.now() >= deadlineAt) {
      // One last identity check: a recycled PID means the Runtime this stop named is gone.
      const identityChanged = input.startToken !== null
        && await readProcessStartToken(input.pid) !== input.startToken;
      return { exited: identityChanged, waitedMs, identityVerified, identityChanged };
    }
    await Bun.sleep(stopPollIntervalMs);
  }
}

try {
  if (group === 'status' && action === undefined) {
    // Ownership facts are read from this home's lifecycle records, read-only, so an unreachable
    // Runtime process is reported instead of being hidden behind a freshly started one.
    try {
      const ping = await call({ command: 'runtime.ping' });
      const ownership = await inspectRuntimeHome({ home, socketPath });
      // A Runtime from before this contract (for example the stable one during an upgrade) still
      // answers without the newer fields: its own object is printed as it is rather than rejected.
      const parsed = runtimePingResultSchema.safeParse(ping);
      print({ ...(parsed.success ? parsed.data : (ping as Record<string, unknown>)),
        ownership: ownershipSummary(ownership) });
    } catch (error) {
      const ownership = await inspectRuntimeHome({ home, socketPath });
      print({ status: 'UNAVAILABLE', error: errorText(error),
        ownership: ownershipSummary(ownership) });
      process.exit(1);
    }
  } else if (group === 'stop' && (action === undefined || action.startsWith('--'))) {
    // Stop is two-phase and factual: the Runtime only reports which process was asked to stop, and
    // this client waits (bounded) for that process to actually disappear before reporting success.
    // It never starts a Runtime to stop it, and never signals a process it cannot identify.
    const tokens = [action, firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined);
    const waitMs = parseStopWaitMs(tokens);
    const before = await inspectRuntimeHome({ home, socketPath });
    const ping = await tryRequest({ command: 'runtime.ping' });
    if (ping === null || !ping.ok) {
      const ownership = await inspectRuntimeHome({ home, socketPath });
      if (ownership.verdict === 'UNREACHABLE_PROCESS') {
        // The defect this command exists to make decidable: a Runtime process that is still there
        // while nothing answers on its socket. It is reported, never killed on a guess.
        print({ status: 'UNREACHABLE_PROCESS', pid: ownership.lock.record?.pid ?? null,
          bootId: ownership.lock.record?.bootId ?? null, waitedMs: 0,
          ownership: ownershipSummary(ownership) });
        process.exit(1);
      }
      print({ status: 'NOT_RUNNING', pid: null, bootId: null, waitedMs: 0,
        ownership: ownershipSummary(ownership) });
    } else {
      const observed = ping.result as { readonly pid: number; readonly bootId: string;
        readonly startedAt?: number };
      // The ping names the process; the lock record (when this boot wrote one) adds the start token
      // that makes the PID checkable, and must agree on the boot it identifies.
      const holder = before.lock.record;
      const lockIdentifiesPing = holder !== null && holder.bootId === observed.bootId;
      const targetPid = lockIdentifiesPing ? holder.pid : observed.pid;
      const stopResponse = await tryRequest({ command: 'runtime.stop' });
      const stopResult: unknown = stopResponse !== null && stopResponse.ok ? stopResponse.result : null;
      // A Runtime from before this contract answers `{stopping: true}` without naming itself: the
      // request was accepted, but this client then has no recorded identity to verify against.
      const accepted = typeof stopResult === 'object' && stopResult !== null
        && (stopResult as { readonly stopping?: unknown }).stopping === true;
      const stopped = accepted ? runtimeStopResultSchema.safeParse(stopResult) : null;
      if (!accepted) {
        print({ status: 'STOP_FAILED', pid: targetPid, bootId: observed.bootId,
          error: stopResponse === null ? 'Runtime closed the connection without a response'
            : stopResponse.ok ? 'Runtime did not accept the stop request'
              : `${stopResponse.error.code}: ${stopResponse.error.message}` });
        process.exit(1);
      }
      const exit = await waitForRuntimeExit({
        pid: targetPid,
        startToken: lockIdentifiesPing ? holder.startToken : null,
        waitMs,
      });
      const ownership = await inspectRuntimeHome({ home, socketPath });
      const stopReportedPid = stopped?.success === true ? stopped.data.pid : null;
      print({
        status: exit.exited ? 'STOPPED' : 'NOT_EXITED',
        pid: targetPid,
        bootId: observed.bootId,
        // A stop response that names a different process than the one that answered the ping means
        // two Runtimes claimed this home; that is a fact the caller must see, not paper over.
        stopReportedPid,
        pidMismatch: stopReportedPid !== null && stopReportedPid !== observed.pid,
        waitedMs: exit.waitedMs,
        identityVerified: exit.identityVerified,
        identityChanged: exit.identityChanged,
        ownership: ownershipSummary(ownership),
      });
      if (!exit.exited) process.exit(1);
    }
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
  } else if (group === 'agent' && action === 'plugins') {
    // Plugin/resource selection and read-only detection (ADR-0044). Both halves stay one command
    // face with the Runtime: `list` projects the Runtime's detection, `select` writes the selection
    // through the same request the settings page uses.
    const subcommand = firstArgument;
    const tokens = remainingArguments;
    let projectId: string | undefined;
    let adapterId = 'pi';
    let json = false;
    let clear = false;
    const selection = {
      extensions: [] as string[], skills: [] as string[], promptTemplates: [] as string[],
      themes: [] as string[],
    };
    for (let index = 0; index < tokens.length; index += 1) {
      const flag = tokens[index];
      const value = tokens[index + 1];
      if (flag === '--project' && value !== undefined) { projectId = value; index += 1; }
      else if (flag === '--adapter' && value !== undefined) { adapterId = value; index += 1; }
      else if (flag === '--json') { json = true; }
      else if (flag === '--clear') { clear = true; }
      else if (flag === '--extension' && value !== undefined) { selection.extensions.push(value); index += 1; }
      else if (flag === '--skill' && value !== undefined) { selection.skills.push(value); index += 1; }
      else if (flag === '--prompt-template' && value !== undefined) { selection.promptTemplates.push(value); index += 1; }
      else if (flag === '--theme' && value !== undefined) { selection.themes.push(value); index += 1; }
      else usage();
    }
    const scope = projectId === undefined ? 'GLOBAL' as const : 'PROJECT' as const;
    if (subcommand === 'list') {
      if (clear || Object.values(selection).some((paths) => paths.length > 0)) usage();
      const detection = await call({
        command: 'agent.plugins.list', adapterId,
        ...(projectId === undefined ? {} : { projectId }),
      }) as AgentPluginDetection;
      if (json) print(detection);
      else printAgentPlugins(detection);
      // Exit 1 when the Adapter cannot apply a selection at all, so a script can tell "nothing
      // found" from "not supported here" without parsing prose.
      if (detection.pluginSelectionSupport !== 'SUPPORTED') process.exit(1);
    } else if (subcommand === 'select') {
      const chosen = agentPluginKinds.reduce(
        (total, kind) => total + selection[kind].length, 0);
      if (clear && chosen > 0) usage();
      if (!clear && chosen === 0) usage();
      const result = await call({
        command: 'agent.config.set', adapterId, scope,
        ...(projectId === undefined ? {} : { projectId }),
        pluginSelection: clear ? null : selection,
      }) as AgentConfigurationView;
      if (json) print(result);
      else printAgentPluginSelection(result);
    } else {
      usage();
    }
  } else if (group === 'service' && action === 'list') {
    const split = splitFlagTokens([firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined), ['--kind', '--parent'], ['--all', '--json']);
    if (split.positionals.length !== 0) usage();
    const kind = split.flags.get('--kind');
    if (kind !== undefined && !['ROOT', 'SCHEDULER', 'ATTENTION', 'PROJECT', 'TASK'].includes(kind)) usage();
    print(await call({ command: 'service.list',
      ...(kind === undefined ? {} : { kind: kind as 'ROOT' | 'SCHEDULER' | 'ATTENTION' | 'PROJECT' | 'TASK' }),
      ...(split.flags.get('--parent') === undefined ? {} : { parentServiceId: split.flags.get('--parent') as string }),
      includeRetired: split.bare.has('--all') }));
  } else if (group === 'service' && action === 'get') {
    if (firstArgument === undefined || remainingArguments.some((token) => token !== '--json')) usage();
    print(await call({ command: 'service.get', serviceId: firstArgument }));
  } else if (group === 'service' && action === 'tree') {
    const positional = [firstArgument, ...remainingArguments].filter((token): token is string =>
      token !== undefined && token !== '--json');
    if (positional.length > 1 || [firstArgument, ...remainingArguments]
      .some((token) => token?.startsWith('--') && token !== '--json')) usage();
    print(await call({ command: 'service.tree',
      ...(positional[0] === undefined ? {} : { serviceId: positional[0] }) }));
  } else if (group === 'service' && action === 'state') {
    const stateAction = firstArgument;
    const [serviceId, ...tokens] = remainingArguments;
    if (serviceId === undefined) usage();
    if (stateAction === 'get') {
      if (tokens.some((token) => token !== '--json')) usage();
      print(await call({ command: 'service.state.get', serviceId }));
    } else if (stateAction === 'set') {
      const split = splitFlagTokens(tokens,
        ['--namespace', '--key', '--value-json', '--expected-version'], ['--json']);
      if (split.positionals.length !== 0) usage();
      const namespace = split.flags.get('--namespace');
      const key = split.flags.get('--key');
      const encoded = split.flags.get('--value-json');
      const expectedVersion = Number(split.flags.get('--expected-version'));
      if (namespace === undefined || key === undefined || encoded === undefined
        || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) usage();
      let value: unknown;
      try { value = JSON.parse(encoded); }
      catch { throw new Error('--value-json must be valid JSON'); }
      print(await call({ command: 'service.state.set', commandId: crypto.randomUUID(), serviceId,
        namespace, key, value, expectedVersion }));
    } else usage();
  } else if (group === 'process' && action === 'list') {
    const split = splitFlagTokens([firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined), ['--service', '--state'], ['--json']);
    if (split.positionals.length !== 0) usage();
    const state = split.flags.get('--state');
    const states = ['CREATED', 'STARTING', 'RUNNING', 'WAITING_FOR_USER', 'PAUSING', 'PAUSED',
      'SUCCEEDED', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'] as const;
    if (state !== undefined && !states.includes(state as typeof states[number])) usage();
    print(await call({ command: 'process.list',
      ...(split.flags.get('--service') === undefined ? {} : { parentServiceId: split.flags.get('--service') as string }),
      ...(state === undefined ? {} : { state: state as typeof states[number] }) }));
  } else if (group === 'process' && action === 'get') {
    if (firstArgument === undefined || remainingArguments.some((token) => token !== '--json')) usage();
    print(await call({ command: 'process.get', processId: firstArgument }));
  } else if (group === 'process' && action === 'input') {
    if (firstArgument === undefined) usage();
    const split = splitFlagTokens(remainingArguments, ['--message'], ['--json']);
    const message = split.flags.get('--message');
    if (split.positionals.length !== 0 || message === undefined) usage();
    const result = await call({ command: 'process.input', commandId: crypto.randomUUID(),
      processId: firstArgument, message });
    print(result);
  } else if (group === 'process' && (action === 'pause' || action === 'terminate')) {
    const [versionText, ...tokens] = remainingArguments;
    const expectedControlVersion = Number(versionText);
    if (firstArgument === undefined || !Number.isSafeInteger(expectedControlVersion)
      || expectedControlVersion < 0 || tokens.some((token) => token !== '--json')) usage();
    print(await call({ command: action === 'pause' ? 'process.pause' : 'process.terminate',
      commandId: crypto.randomUUID(), processId: firstArgument, expectedControlVersion }));
  } else if (group === 'process' && action === 'resume') {
    const [versionText, ...tokens] = remainingArguments;
    const expectedControlVersion = Number(versionText);
    if (firstArgument === undefined || !Number.isSafeInteger(expectedControlVersion)
      || expectedControlVersion < 0) usage();
    const split = splitFlagTokens(tokens, ['--adapter'], ['--allow-unknown', '--json']);
    if (split.positionals.length !== 0) usage();
    try {
      print(await call({ command: 'process.resume', commandId: crypto.randomUUID(),
        processId: firstArgument, expectedControlVersion,
        ...(split.flags.get('--adapter') === undefined ? {} : { adapterId: split.flags.get('--adapter') as string }),
        allowUnknown: split.bare.has('--allow-unknown') }));
    } catch (error) {
      if (errorCodeOf(error) === 'CONFLICT_WAIT' || errorCodeOf(error) === 'SCHEDULER_GLOBALLY_PAUSED') {
        console.error(errorText(error)); process.exit(3);
      }
      throw error;
    }
  } else if (group === 'signal' && action === 'send') {
    if (firstArgument === undefined) usage();
    const split = splitFlagTokens(remainingArguments,
      ['--kind', '--subtype', '--payload-json', '--idempotency-key', '--contract-version',
        '--source-service', '--source-process', '--correlation', '--causation', '--priority'], ['--json']);
    if (split.positionals.length !== 0) usage();
    const kind = split.flags.get('--kind');
    const subtype = split.flags.get('--subtype');
    const encoded = split.flags.get('--payload-json');
    const idempotencyKey = split.flags.get('--idempotency-key');
    const priority = Number(split.flags.get('--priority') ?? '0');
    const contractVersion = Number(split.flags.get('--contract-version') ?? '1');
    if ((kind !== 'SIG_A' && kind !== 'SIG_P') || subtype === undefined || encoded === undefined
      || idempotencyKey === undefined || !Number.isSafeInteger(priority)
      || !Number.isSafeInteger(contractVersion) || contractVersion < 1) usage();
    let payload: unknown;
    try { payload = JSON.parse(encoded); }
    catch { throw new Error('--payload-json must be valid JSON'); }
    const result = await call({ command: 'signal.send', commandId: crypto.randomUUID(), kind,
      subtype, targetServiceId: firstArgument, contractVersion, payload, idempotencyKey,
      ...(split.flags.get('--source-service') === undefined ? {} : { sourceServiceId: split.flags.get('--source-service') as string }),
      ...(split.flags.get('--source-process') === undefined ? {} : { sourceProcessId: split.flags.get('--source-process') as string }),
      ...(split.flags.get('--correlation') === undefined ? {} : { correlationId: split.flags.get('--correlation') as string }),
      ...(split.flags.get('--causation') === undefined ? {} : { causationId: split.flags.get('--causation') as string }),
      priority }) as { readonly signal: { readonly state: string } };
    print(result);
    if (['PENDING', 'CLAIMED', 'RETRYABLE'].includes(result.signal.state)) process.exit(3);
    if (result.signal.state !== 'ACKED') process.exit(1);
  } else if (group === 'signal' && action === 'list') {
    const split = splitFlagTokens([firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined),
    ['--service', '--state', '--kind', '--limit'], ['--json']);
    if (split.positionals.length !== 0) usage();
    const limit = Number(split.flags.get('--limit') ?? '100');
    const kind = split.flags.get('--kind');
    const state = split.flags.get('--state');
    const states = ['PENDING', 'CLAIMED', 'RETRYABLE', 'ACKED', 'DEAD_LETTER',
      'RECOVERY_REQUIRED'] as const;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500
      || (kind !== undefined && kind !== 'SIG_A' && kind !== 'SIG_P')
      || (state !== undefined && !states.includes(state as typeof states[number]))) usage();
    print(await call({ command: 'signal.list',
      ...(split.flags.get('--service') === undefined ? {} : { targetServiceId: split.flags.get('--service') as string }),
      ...(kind === undefined ? {} : { kind }),
      ...(state === undefined ? {} : { state: state as typeof states[number] }), limit }));
  } else if (group === 'signal' && action === 'get') {
    if (firstArgument === undefined || remainingArguments.some((token) => token !== '--json')) usage();
    print(await call({ command: 'signal.get', signalId: firstArgument }));
  } else if (group === 'signal' && action === 'retry') {
    if (firstArgument === undefined || remainingArguments.some((token) => token !== '--json')) usage();
    const result = await call({ command: 'signal.retry', commandId: crypto.randomUUID(),
      signalId: firstArgument }) as { readonly state: string };
    print(result);
    if (['PENDING', 'CLAIMED', 'RETRYABLE'].includes(result.state)) process.exit(3);
    if (result.state !== 'ACKED') process.exit(1);
  } else if (group === 'intent' && action === 'send') {
    const split = splitFlagTokens([firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined),
    ['--service', '--project', '--task', '--adapter'], ['--json']);
    if (split.positionals.length === 0) usage();
    const targets = ['--service', '--project', '--task'].filter((flag) => split.flags.has(flag));
    if (targets.length > 1) usage();
    print(await call({ command: 'intent.send', commandId: crypto.randomUUID(),
      text: split.positionals.join(' '),
      ...(split.flags.get('--service') === undefined ? {} : { serviceId: split.flags.get('--service') as string }),
      ...(split.flags.get('--project') === undefined ? {} : { projectId: split.flags.get('--project') as string }),
      ...(split.flags.get('--task') === undefined ? {} : { taskId: split.flags.get('--task') as string }),
      adapterId: split.flags.get('--adapter') ?? 'pi' }));
  } else if (group === 'project' && action === 'inspect') {
    const positional = [firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined);
    if (positional.some((token) => token.startsWith('--')) || positional.length > 1) usage();
    const report = await call({
      command: 'project.inspect',
      path: positional[0] ?? process.cwd(),
    }) as ProjectIdentity;
    print(report);
    console.error('Task 基线：该项目文件夹当前检出的分支（建 Task 时固定 ref 与 commit）。');
  } else if (group === 'project' && action === 'list') {
    print(await call({ command: 'project.list' }));
  } else if (group === 'project' && action === 'policy') {
    print(await call({ command: 'project.verificationPolicy', path: firstArgument ?? process.cwd() }));
  } else if (group === 'project' && action === 'trust') {
    const tokens = [firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined);
    const positional: string[] = [];
    for (const token of tokens) {
      if (token === '--yes') {
        // The confirmation flag is read from the raw argv below; it never becomes a positional.
      } else if (token.startsWith('--')) usage();
      else positional.push(token);
    }
    if (positional.length > 1) usage();
    const path = positional[0] ?? process.cwd();
    const identity = await call({
      command: 'project.inspect',
      path,
    }) as ProjectIdentity;
    print(identity);
    const policy = await call({ command: 'project.verificationPolicy',
      path }) as VerificationPolicyInspection;
    print(policy);
    const impact = await call({ command: 'project.impact.validate',
      path }) as ImpactPolicyValidationView;
    describeImpactPolicy(impact.policy);
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
    const trusted = await call({
      command: 'project.trust',
      path,
      expectedIdentity: identity,
      expectedVerificationPolicy: policy.state === 'PRESENT'
        ? { state: 'PRESENT', mainCommit: policy.mainCommit, digest: policy.digest as string }
        : { state: 'ABSENT', mainCommit: policy.mainCommit },
      expectedImpactPolicy: expectedImpactPolicyConfirmation(impact),
    });
    print(trusted);
  } else if (group === 'project' && action === 'impact') {
    // Deterministic conflict analysis (ADR-0031). Read-only: it derives snapshots, records them
    // append-only, and explains a verdict. It never schedules, starts, or approves a Task.
    const subcommand = firstArgument;
    if (subcommand === 'validate') {
      const positional = remainingArguments.filter((token) => !token.startsWith('--'));
      const flags = remainingArguments.filter((token) => token.startsWith('--'));
      if (positional.length > 1) usage();
      const json = jsonOnlyFlag(flags);
      const report = await call({ command: 'project.impact.validate',
        path: positional[0] ?? process.cwd() }) as ImpactPolicyValidationView;
      if (json) print(report);
      else printImpactValidation(report);
      // Exit 0 only when a mapping is present *and* in effect: an unconfirmed or broken mapping
      // makes every verdict UNKNOWN, which is a failure for a script that wants parallelism.
      if (report.code !== 'OK' && report.code !== 'OK_UNTRUSTED') process.exit(1);
    } else if (subcommand === 'show' || subcommand === 'explain') {
      const [projectId, taskId, ...flags] = remainingArguments;
      if (projectId === undefined || taskId === undefined) usage();
      const json = jsonOnlyFlag(flags);
      if (subcommand === 'show') {
        const view = await call({ command: 'project.impact.show', projectId,
          taskId }) as ImpactSnapshotView;
        if (json) print(view);
        else printImpactSnapshot(view);
        // A Task whose change set cannot be observed has no snapshot at all; an incomplete one is
        // still reported (with `complete: false`) because that is what explains an UNKNOWN verdict.
        if (view.snapshot === null) process.exit(1);
      } else {
        const view = await call({ command: 'project.impact.explain', projectId,
          taskId }) as ImpactExplainView;
        if (json) print(view);
        else printImpactExplanation(view);
        // Exit 0 means "proven safe to parallelize". UNKNOWN is not a softer SAFE: it is a refusal,
        // and a script that treats it as success would run exactly the Task nobody could clear.
        if (view.assessment.verdict !== 'SAFE_TO_PARALLELIZE') process.exit(1);
      }
    } else {
      usage();
    }
  } else if (group === 'project' && action === 'knowledge') {
    // Project Knowledge (FOUNDATION-067 / ADR-0041). Read-only: it reports the layered knowledge
    // (human layers from the project main ref, machine layer from the Runtime data directory) and
    // the snapshots already bound to Executions. Nothing here records a snapshot or starts a Task.
    const subcommand = firstArgument;
    if (subcommand === 'validate' || subcommand === 'list') {
      const positional = remainingArguments.filter((token) => !token.startsWith('--'));
      const flags = remainingArguments.filter((token) => token.startsWith('--'));
      if (positional.length > 1) usage();
      const json = jsonOnlyFlag(flags);
      const projectId = positional[0] ?? process.cwd();
      if (subcommand === 'validate') {
        const report = await call({ command: 'project.knowledge.validate', projectId }) as KnowledgeValidationView;
        if (json) print(report);
        else printKnowledgeValidation(report);
        // Exit 0 only for a layer that is complete. A refused entry means there is no snapshot at
        // all, which is a failure for a script that wants to know what the next run would read.
        if (!report.valid) process.exit(1);
      } else {
        const report = await call({ command: 'project.knowledge.list', projectId }) as KnowledgeListView;
        if (json) print(report);
        else printKnowledgeList(report);
        if (!report.valid) process.exit(1);
      }
    } else if (subcommand === 'show') {
      const positional = remainingArguments.filter((token) => !token.startsWith('--'));
      const flags = remainingArguments.filter((token) => token.startsWith('--'));
      if (positional[0] === undefined || positional.length > 2) usage();
      const json = jsonOnlyFlag(flags);
      const view = await call({
        command: 'project.knowledge.show',
        projectId: positional[0],
        ...(positional[1] === undefined ? {} : { snapshotId: positional[1] }),
      }) as KnowledgeSnapshotView;
      if (json) print(view);
      else printKnowledgeSnapshot(view);
    } else if (subcommand === 'resolve') {
      const positional = remainingArguments.filter((token) => !token.startsWith('--'));
      const flags = remainingArguments.filter((token) => token.startsWith('--'));
      if (positional[0] === undefined || positional[1] === undefined || positional.length > 2) {
        usage();
      }
      const json = jsonOnlyFlag(flags);
      const view = await call({ command: 'project.knowledge.resolve', projectId: positional[0],
        taskId: positional[1] }) as KnowledgeResolveView;
      if (json) print(view);
      else printKnowledgeResolve(view);
      // Same rule as `validate`: an invalid layer has no honest answer, and "no knowledge applies"
      // is a successful answer that still exits 0.
      if (view.state !== 'VALID') process.exit(1);
    } else {
      usage();
    }
  } else if (group === 'task' && action === 'create') {
    if (firstArgument === undefined || remainingArguments.length === 0) usage();
    const input = parseTaskCreateFlags(remainingArguments);
    print(await call({
      command: 'task.create',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      displayTitle: input.displayTitle,
      namingTitle: input.namingTitle,
      specification: input.specification,
      features: input.features,
    }));
  } else if (group === 'task' && action === 'list') {
    const includeArchived = remainingArguments.length === 1 && remainingArguments[0] === '--all';
    if (firstArgument === undefined
      || (remainingArguments.length !== 0 && !includeArchived)) usage();
    print(await call({ command: 'task.list', projectId: firstArgument, includeArchived }));
  } else if (group === 'task' && action === 'purge') {
    const [taskId, versionText, ...flags] = remainingArguments;
    const expectedVersion = Number(versionText);
    if (firstArgument === undefined || taskId === undefined || versionText === undefined
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) usage();
    const split = splitFlagTokens(flags, ['--reason'], ['--yes', '--json', '--force']);
    if (split.positionals.length !== 0) usage();
    // `--yes` is the whole guard, and it is the command's own statement rather than a permission
    // layer: nothing else in the product costs a step because of it, and a script that meant to
    // archive cannot reach permanent deletion by accident.
    if (!split.bare.has('--yes')) {
      console.error('task purge permanently deletes the Task, its revisions, executions, evidence'
        + ' and its own worktree/branch. Pass --yes to confirm.');
      process.exit(2);
    }
    // ADR-0058 D09: `--force` is the same caller saying "delete it anyway". It is not a second gate
    // and it adds no step: it only widens what this one command may step over.
    const force = split.bare.has('--force');
    const reason = split.flags.get('--reason');
    const result = await call({
      command: 'task.purge',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      taskId,
      expectedVersion,
      confirmed: true,
      force,
      ...(reason === undefined ? {} : { reason }),
    }) as TaskPurgeOutcomeView;
    print(result);
    if (result.forced !== null) {
      // The facts a forced deletion stepped over go to stderr: stdout stays the one JSON document a
      // script parses, while a human sees what was stepped over without reading the whole view.
      console.error(`--force stepped over ${result.forced.bypassed.length} refusal(s):`);
      for (const entry of result.forced.bypassed) {
        console.error(`  ${entry.code} — ${entry.detail}`);
      }
      if (result.forced.termination !== null) {
        console.error(`provider termination: ${result.forced.termination.detail}`);
      }
    }
  } else if (group === 'task' && (action === 'pause'
    || action === 'cancel' || action === 'archive' || action === 'unarchive')) {
    const [taskId, versionText, ...extra] = remainingArguments;
    const expectedVersion = Number(versionText);
    if (firstArgument === undefined || taskId === undefined || versionText === undefined
      || extra.length !== 0 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) usage();
    const command = action === 'pause' ? 'task.pause' as const
      : action === 'cancel' ? 'task.cancel' as const
      : action === 'archive' ? 'task.archive' as const
      : 'task.unarchive' as const;
    const result = await call({
      command,
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      taskId,
      expectedVersion,
    }) as { state: string; stop?: string };
    print(result);
    // A stop the Runtime could not prove is a real failure for scripts, not a success.
    if (result.stop === 'UNCERTAIN') process.exit(1);
  } else if (group === 'task' && action === 'resume') {
    const [taskId, versionText, ...extra] = remainingArguments;
    const expectedVersion = Number(versionText);
    if (firstArgument === undefined || taskId === undefined || versionText === undefined
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) usage();
    // Resuming reopens the predecessor's provider conversation, so the adapter is part of the
    // request: a different Agent must be asked for explicitly instead of silently resuming with
    // one that cannot read the recorded conversation.
    // Resuming is a start path: it passes the same conflict gate as `task run`, so a Task whose
    // impact cannot be proven disjoint from the active set stays paused unless the user releases it
    // explicitly with --allow-unknown (single-shot, audited).
    const split = splitFlagTokens(extra, ['--adapter'], ['--allow-unknown', '--json']);
    if (split.positionals.length !== 0) usage();
    try {
      print(await call({
        command: 'task.resume',
        commandId: crypto.randomUUID(),
        projectId: firstArgument,
        taskId,
        expectedVersion,
        adapterId: split.flags.get('--adapter') ?? 'pi',
        allowUnknown: split.bare.has('--allow-unknown'),
      }));
    } catch (error) {
      if (errorCodeOf(error) === 'CONFLICT_WAIT'
        || errorCodeOf(error) === 'SCHEDULER_GLOBALLY_PAUSED') {
        // Both are *waits*, not refusals: a conflict verdict and the Runtime's global barrier each
        // mean "not now", and a script tells them apart by the stable code, not by the exit code.
        console.error(`[scheduler] the Task stays paused: ${errorText(error)}`);
        process.exit(3);
      }
      throw error;
    }
  } else if (group === 'task' && action === 'retry') {
    const [taskId, versionText, ...flags] = remainingArguments;
    const expectedVersion = Number(versionText);
    if (firstArgument === undefined || taskId === undefined || versionText === undefined
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) usage();
    const split = splitFlagTokens(flags, ['--adapter'], ['--json']);
    if (split.positionals.length !== 0) usage();
    // `--adapter` is passed only when the user asked for it: an absent Adapter means "the one this
    // Task last ran on", which the Runtime resolves from the failed Execution rather than the CLI
    // assuming today's default.
    const adapterId = split.flags.get('--adapter');
    const result = await call({
      command: 'task.retry',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      taskId,
      expectedVersion,
      ...(adapterId === undefined ? {} : { adapterId }),
    }) as TaskRetryOutcomeView;
    print(result);
    // The retry's own facts are on stdout; the exit code answers "did a new Execution start".
    if (result.start.outcome === 'WAIT') {
      console.error(`[scheduler] the retry is recorded; the Task is requeued and waiting: `
        + `${result.start.wait?.kind ?? 'WAIT'} ${result.start.wait?.code ?? result.start.code ?? ''}`
        + ` — ${result.start.detail}`);
      process.exit(3);
    }
    if (result.start.outcome === 'REFUSED') {
      console.error(`[scheduler] the retry is recorded, but nothing started: `
        + `${result.start.code ?? 'unknown'} — ${result.start.detail}`);
      process.exit(1);
    }
  } else if (group === 'task' && action === 'status') {
    const [taskId, ...flags] = remainingArguments;
    if (firstArgument === undefined || taskId === undefined) usage();
    // The JSON view is this command's only output; `--json` is accepted so a script can say what it
    // expects, and anything else stays a usage error instead of being silently ignored.
    for (const flag of flags) if (flag !== '--json') usage();
    const view = await call({ command: 'task.status', projectId: firstArgument, taskId });
    printCompletionNotes(view);
    await printProseQuestionWaits({ projectId: firstArgument, view, call });
    print(view);
  } else if (group === 'task' && action === 'transcript') {
    const [taskId, ...flags] = remainingArguments;
    if (firstArgument === undefined || taskId === undefined) usage();
    const parsed = parseTranscriptFlags(flags);
    if (parsed.reverse && parsed.json) usage();
    await transcriptForTask(firstArgument, taskId, parsed);
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
      // from being accepted and then silently ignored. `--reverse` is a rendering choice for the
      // human view, so it is refused together with `--json` instead of reordering data silently.
      if (flags.executionId !== undefined) usage();
      if (flags.reverse && flags.json) usage();
      const read = await readTranscript(sessionId, flags);
      if (flags.json) print(read.view);
      else printTranscript(read, sessionId, flags.reverse);
    }
  } else if (group === 'session' && action === 'guide') {
    // Session Guidance (ADR-0057): the other input channel of ADR-0010 D02. One command hands one
    // message to a running conversation and records the fact it produced; it never creates a
    // TaskRevision, never moves the Task's revision and never invalidates a verification. The exit
    // code separates "handed over or recorded with nothing running" (0) from "a provider was asked
    // and did not take it" (1), so a script never has to read prose to tell them apart.
    const [projectId, taskId, ...tokens] = [firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined);
    if (projectId === undefined || taskId === undefined) usage();
    let message: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
      const flag = tokens[index];
      const value = tokens[index + 1];
      if (flag === '--message' && value !== undefined) { message = value; index += 1; }
      else if (flag === '--json') continue;
      else usage();
    }
    if (message === undefined || message.trim().length === 0) usage();
    const recorded = await call({
      command: 'session.guidance.record',
      commandId: crypto.randomUUID(),
      projectId,
      taskId,
      message,
    }) as { readonly outcome: string; readonly code: string | null; readonly detail: string };
    print(recorded);
    if (recorded.outcome === 'DELIVERED' || recorded.outcome === 'RECORDED') process.exit(0);
    console.error(`[guidance] the guidance is recorded but was not handed over: `
      + `${recorded.code ?? recorded.outcome} — ${recorded.detail}`);
    process.exit(1);
  } else if (group === 'session' && action === 'guidance') {
    // Read-only side of the same face: the durable record, its append-only attempt ledger and the
    // artifact each Execution was launched with. `--json` is the default projection, as everywhere on
    // this command surface.
    const subcommand = firstArgument;
    if (subcommand === 'list') {
      const [projectId, taskId, ...extra] = remainingArguments;
      if (projectId === undefined || taskId === undefined) usage();
      for (const flag of extra) if (flag !== '--json') usage();
      print(await call({ command: 'session.guidance.list', projectId, taskId }));
    } else if (subcommand === 'get') {
      const [projectId, guidanceId, ...extra] = remainingArguments;
      if (projectId === undefined || guidanceId === undefined) usage();
      for (const flag of extra) if (flag !== '--json') usage();
      print(await call({ command: 'session.guidance.get', projectId, guidanceId }));
    } else {
      usage();
    }
  } else if (group === 'session' && action === 'handoff') {
    // `session handoff` is the control face of the Runtime-side handoff contract (ADR-0023): the
    // incarnation history, the single writer lease, the handoff fence and the admission decision.
    // Every subcommand prints the same JSON projection the Runtime returns; `--json` is accepted and
    // is also the default, so a script can state its intent without depending on that default.
    const subcommand = firstArgument;
    const tokens = remainingArguments;
    // Flags are consumed with their value, so `--holder probe` is never mistaken for positionals;
    // anything else starting with `--` is a usage error rather than a silently ignored flag.
    const positional: string[] = [];
    let holderRef: string | undefined;
    let holderKind = 'AUTOMATED_RPC';
    let attachmentKind: 'WRITER' | 'OBSERVER' = 'OBSERVER';
    let since: number | undefined;
    let terminalText: string | undefined;
    let cols: number | undefined;
    let rows: number | undefined;
    let noResume = false;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index] as string;
      const value = tokens[index + 1];
      if (token === '--json') continue;
      if (token === '--holder' && value !== undefined) { holderRef = value; index += 1; continue; }
      if (token === '--kind' && value !== undefined
        && (value === 'AUTOMATED_RPC' || value === 'TERMINAL_ATTACHMENT')) {
        holderKind = value;
        index += 1;
        continue;
      }
      if (token === '--writer') { attachmentKind = 'WRITER'; continue; }
      if (token === '--observer') { attachmentKind = 'OBSERVER'; continue; }
      if (token === '--no-resume') { noResume = true; continue; }
      if (token === '--since' && value !== undefined) {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0) usage();
        since = parsed;
        index += 1;
        continue;
      }
      if (token === '--text' && value !== undefined) { terminalText = value; index += 1; continue; }
      if (token === '--cols' && value !== undefined) { cols = Number(value); index += 1; continue; }
      if (token === '--rows' && value !== undefined) { rows = Number(value); index += 1; continue; }
      if (token.startsWith('--')) usage();
      positional.push(token);
    }
    if (subcommand === 'status') {
      const [projectId, sessionId, ...extra] = positional;
      if (projectId === undefined || sessionId === undefined || extra.length !== 0) usage();
      print(await call({ command: 'session.handoff.status', projectId, sessionId }));
    } else if (subcommand === 'request') {
      const [projectId, sessionId, kind, ...extra] = positional;
      if (projectId === undefined || sessionId === undefined
        || (kind !== 'takeover' && kind !== 'return') || extra.length !== 0) usage();
      print(await call({
        command: 'session.handoff.request',
        commandId: crypto.randomUUID(),
        projectId,
        sessionId,
        kind: kind === 'takeover' ? 'TAKEOVER' : 'RETURN',
      }));
    } else if (subcommand === 'cancel') {
      const [projectId, sessionId, ...extra] = positional;
      if (projectId === undefined || sessionId === undefined || extra.length !== 0) usage();
      print(await call({ command: 'session.handoff.cancel', projectId, sessionId }));
    } else if (subcommand === 'writer') {
      // The writer lease is the Runtime's answer to Pi having no session-file lock: competition is a
      // refusal (exit 1 with ATTACHMENT_BUSY), never a silent queue.
      const [writerAction, projectId, sessionId, ...extra] = positional;
      if (writerAction !== 'acquire' && writerAction !== 'release') usage();
      if (projectId === undefined || sessionId === undefined || extra.length !== 0) usage();
      if (holderRef === undefined) usage();
      if (writerAction === 'acquire') {
        print(await call({
          command: 'session.handoff.writer.acquire',
          commandId: crypto.randomUUID(),
          projectId,
          sessionId,
          holderKind: holderKind as 'AUTOMATED_RPC' | 'TERMINAL_ATTACHMENT',
          holderRef,
        }));
      } else {
        const released = await call({
          command: 'session.handoff.writer.release', projectId, sessionId, holderRef,
        }) as { readonly released: boolean };
        print(released);
        // Not releasing the lease is a real failure for a script: the Session keeps its writer.
        if (!released.released) process.exit(1);
      }
    } else if (subcommand === 'admit') {
      const [projectId, sessionId, ...extra] = positional;
      if (projectId === undefined || sessionId === undefined || extra.length !== 0) usage();
      const admission = await call({
        command: 'session.handoff.admit',
        commandId: crypto.randomUUID(),
        projectId,
        sessionId,
      }) as { readonly admitted: boolean; readonly successorStarted: boolean };
      print(admission);
      // A refused admission keeps the predecessor as the writer; exit code 0 would claim otherwise.
      if (!admission.admitted) process.exit(1);
    } else if (subcommand === 'attach') {
      const [projectId, sessionId, ...extra] = positional;
      if (projectId === undefined || sessionId === undefined || extra.length !== 0) usage();
      if (holderRef === undefined) usage();
      const attached = await call({
        command: 'session.handoff.attach',
        commandId: crypto.randomUUID(),
        projectId,
        sessionId,
        holderRef,
        kind: attachmentKind,
        ...(since === undefined ? {} : { since }),
      }) as { readonly attachment: { readonly id: string }; readonly stream: { readonly cursor: number } };
      print(attached);
      // The attachment id and the cursor are what a script needs to detach / keep reading.
      process.exitCode = 0;
    } else if (subcommand === 'detach') {
      const [projectId, sessionId, ...extra] = positional;
      if (projectId === undefined || sessionId === undefined || extra.length !== 0) usage();
      if (holderRef === undefined) usage();
      const detached = await call({
        command: 'session.handoff.detach',
        commandId: crypto.randomUUID(),
        projectId,
        sessionId,
        holderRef,
        ...(since === undefined ? {} : { since }),
      }) as { readonly detached: boolean };
      print(detached);
      // Detaching something this holder does not own is a refusal, not a silent success.
      if (!detached.detached) process.exit(1);
    } else if (subcommand === 'release') {
      const [projectId, sessionId, ...extra] = positional;
      if (projectId === undefined || sessionId === undefined || extra.length !== 0) usage();
      const released = await call({
        command: 'session.handoff.release',
        commandId: crypto.randomUUID(),
        projectId,
        sessionId,
        ...(noResume ? { resumeAutomation: false } : {}),
      }) as { readonly released: boolean; readonly successor: { readonly admitted: boolean } | null };
      print(released);
      // A release that could not be confirmed, or a successor that could not be started, is not a
      // completed hand-back: the exit code says so instead of reporting success.
      if (!released.released || (released.successor !== null && !released.successor.admitted)) {
        process.exit(1);
      }
    } else if (subcommand === 'terminal') {
      // The projected terminal stream is the CLI-complete form of the native terminal: reading it is
      // a normal command with a stable cursor, writing to it is input, and resizing it is a fact about
      // the terminal device. None of the three is an approval channel.
      const [terminalAction, projectId, sessionId, ...extra] = positional;
      if (terminalAction !== 'read' && terminalAction !== 'write' && terminalAction !== 'resize') {
        usage();
      }
      if (projectId === undefined || sessionId === undefined || extra.length !== 0) usage();
      if (terminalAction === 'read') {
        print(await call({
          command: 'session.handoff.terminal.read', projectId, sessionId,
          ...(since === undefined ? {} : { since }),
        }));
      } else if (terminalAction === 'write') {
        if (terminalText === undefined) usage();
        const written = await call({
          command: 'session.handoff.terminal.write',
          projectId,
          sessionId,
          commandId: crypto.randomUUID(),
          dataBase64: Buffer.from(terminalText, 'utf8').toString('base64'),
        }) as { readonly cursor: number };
        print(written);
        process.exitCode = 0;
      } else {
        // The size bound is the contract's own (ADR-0054), and it is checked here so an out-of-range
        // size is a stable, named refusal (exit 2) instead of a generic schema error from the Runtime.
        if (cols === undefined || rows === undefined) usage();
        if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)
          || cols < 1 || rows < 1 || cols > 1000 || rows > 1000) {
          console.error(`TERMINAL_RESIZE_INVALID_SIZE: --cols/--rows must be integers in 1..1000, got`
            + ` ${String(cols)}x${String(rows)}`);
          process.exit(2);
        }
        const resized = await call({
          command: 'session.handoff.terminal.resize',
          commandId: crypto.randomUUID(),
          projectId,
          sessionId,
          cols,
          rows,
          ...(holderRef === undefined ? {} : { holderRef }),
        }) as { readonly applied: string };
        print(resized);
        // The transport's own answer decides the exit code: a resize that did not take effect is a
        // refusal (exit 1), never a silent success.
        if (resized.applied !== 'APPLIED') process.exit(1);
      }
    } else {
      usage();
    }
  } else if (group === 'task' && action === 'run') {
    const [taskId, versionText, ...flags] = remainingArguments;
    const expectedTaskVersion = Number(versionText);
    if (firstArgument === undefined || taskId === undefined || versionText === undefined
      || !Number.isSafeInteger(expectedTaskVersion) || expectedTaskVersion < 0) usage();
    const split = splitFlagTokens(flags, ['--adapter', '--base-ref'], ['--allow-unknown', '--json']);
    if (split.positionals.length !== 0) usage();
    // `task run` is the explicit start request of the same gate the automatic tick applies: the
    // dependency verdict, the conflict verdict against every active/reserved Task, and capacity.
    // `--allow-unknown` is the explicit single-shot release of an UNKNOWN verdict (ADR-0030 D05) —
    // it widens the gate, adds no confirmation, and is written to the audit ledger.
    const result = await call({
      command: 'task.run',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      taskId,
      expectedTaskVersion,
      adapterId: split.flags.get('--adapter') ?? 'pi',
      allowUnknown: split.bare.has('--allow-unknown'),
      ...(split.flags.has('--base-ref') ? { baseRef: split.flags.get('--base-ref') } : {}),
    }) as ScheduleStartOutcomeView;
    print(result);
    // A wait is a fact about *now*, not a failure: exit 3 keeps it apart from a refusal (exit 1),
    // exactly like `scheduler reservations acquire`.
    if (result.outcome === 'WAIT') {
      console.error(`[scheduler] ${result.wait?.kind ?? 'WAIT'} wait: `
        + `${result.wait?.code ?? result.code ?? 'unknown'} — ${result.detail}`);
      printOccupierDiagnostics(firstArgument, result.assessment, result.assessment?.activeTaskIds ?? []);
      process.exit(3);
    }
    if (result.outcome === 'REFUSED') {
      console.error(`[scheduler] refused: ${result.code ?? 'unknown'} — ${result.detail}`);
      process.exit(1);
    }
  } else if (group === 'task' && action === 'verify') {
    const [taskId, ...rest] = remainingArguments;
    if (firstArgument === undefined || taskId === undefined) usage();
    let background = false;
    let policySource: 'AUTO' | 'PROJECT_POLICY' | 'TARGETED_TEST_PLAN' = 'AUTO';
    const positionals: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index] as string;
      if (token === '--background') background = true;
      else if (token === '--policy') {
        const value = rest[index + 1];
        if (value === 'targeted') policySource = 'TARGETED_TEST_PLAN';
        else if (value === 'project') policySource = 'PROJECT_POLICY';
        else if (value === 'auto') policySource = 'AUTO';
        else {
          console.error("`--policy` takes `auto`, `targeted` or `project`: 'auto' uses the Task's"
            + ' recorded branch-targeted plan when it matches this exact revision and commit,'
            + ' `targeted` requires such a plan, and `project` runs the fixed project policy');
          process.exit(2);
        }
        index += 1;
      } else if (token.startsWith('--')) usage();
      else positionals.push(token);
    }
    if (positionals.length > 1) usage();
    const executionId = positionals[0];
    const report = await call({
      command: 'task.verify',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      taskId,
      background,
      policySource,
      ...(executionId === undefined ? {} : { executionId }),
    }) as { state: string; operationId?: string; verificationId?: string; message?: string;
      policySource?: string; policyLabel?: string };
    print(report);
    if (background) {
      // The Operation is durable and may still be running: exit 0 means "accepted", and the verdict
      // must be read from task operation list instead of being assumed here.
      console.error('验证已在后台开始；用 `task operation list` 查看进度，'
        + '`task operation cancel` 取消。此处退出码 0 表示已受理，不代表验证通过。');
    } else if (report.state !== 'PASSED') {
      process.exit(1);
    }
  } else if (group === 'task' && action === 'tests') {
    // `task tests <subcommand> …` lands the subcommand in firstArgument. The plan is a repository
    // file (`--json` is the machine format for every subcommand); recording it is what makes it the
    // command set verification runs, and each record is append-only (ADR-0038/0039).
    const subcommand = firstArgument;
    if (subcommand === 'record') {
      const split = splitFlagTokens(remainingArguments,
        ['--commit', '--expected-plan-digest'], ['--json']);
      const [projectId, taskId, ...extra] = split.positionals;
      if (projectId === undefined || taskId === undefined || extra.length !== 0) usage();
      const commit = split.flags.get('--commit');
      const expectedPlanDigest = split.flags.get('--expected-plan-digest');
      const recorded = await call({
        command: 'task.tests.record',
        commandId: crypto.randomUUID(),
        projectId,
        taskId,
        ...(commit === undefined ? {} : { commit }),
        ...(expectedPlanDigest === undefined ? {} : { expectedPlanDigest }),
      }) as {
        created: boolean; planId: string; planLabel: string; testedCommit: string; scope: string;
        revisionId: string; commands: readonly { readonly id: string;
          readonly argv: readonly string[] }[];
        replacedExistingScope: boolean;
      };
      print(recorded);
      if (recorded.replacedExistingScope) {
        console.error('已追加新的定向测试计划记录；旧记录保留为审计，本次范围变化不是静默生效。');
      }
    } else if (subcommand === 'show') {
      const [projectId, taskId, ...flags] = remainingArguments;
      if (projectId === undefined || taskId === undefined) usage();
      jsonOnlyFlag(flags);
      const plan = await call({ command: 'task.tests.show', projectId, taskId });
      print(plan);
      if (plan === null) {
        console.error(`该 Task 没有已记录的定向测试计划；\`task verify\` 会用固定项目策略。`);
      }
    } else if (subcommand === 'history') {
      const split = splitFlagTokens(remainingArguments, ['--limit'], ['--json']);
      const [projectId, taskId, ...extra] = split.positionals;
      if (projectId === undefined || taskId === undefined || extra.length !== 0) usage();
      const limit = split.flags.get('--limit');
      print(await call({
        command: 'task.tests.history',
        projectId,
        taskId,
        limit: limit === undefined ? 50 : Number(limit),
      }));
    } else usage();
  } else if (group === 'task' && action === 'verification') {
    // `task verification <subcommand> …` lands the subcommand in firstArgument.
    const [projectId, taskId, ...extra] = remainingArguments;
    if (firstArgument !== 'list' || projectId === undefined || taskId === undefined
      || extra.length !== 0) usage();
    print(await call({ command: 'task.verification.list', projectId, taskId }));
  } else if (group === 'task' && action === 'operation') {
    // `task operation <subcommand> …` is a three-level command, so the subcommand lands in
    // firstArgument and the project ID is the first remaining argument.
    const subcommand = firstArgument;
    if (subcommand === 'list') {
      const [projectId, taskId, ...flags] = remainingArguments;
      if (projectId === undefined || taskId === undefined) usage();
      const json = jsonOnlyFlag(flags);
      const listed = await call({ command: 'task.operation.list', projectId, taskId });
      printOperations(listed as OperationView[], json);
    } else if (subcommand === 'get') {
      const [projectId, operationId, ...flags] = remainingArguments;
      if (projectId === undefined || operationId === undefined) usage();
      const json = jsonOnlyFlag(flags);
      const read = await call({ command: 'task.operation.get', projectId, operationId });
      if (json) print(read); else printOperation(read as OperationView);
    } else if (subcommand === 'cancel') {
      const [projectId, taskId, operationId, ...flags] = remainingArguments;
      if (projectId === undefined || taskId === undefined || operationId === undefined) usage();
      const json = jsonOnlyFlag(flags);
      const outcome = await call({
        command: 'task.operation.cancel',
        commandId: crypto.randomUUID(),
        projectId,
        taskId,
        operationId,
      }) as { stop: string; state: string; kind: string; detail: string };
      if (json) {
        print(outcome);
      } else {
        console.log(`${outcome.kind} ${operationId.slice(0, 8)} → ${outcome.state}`);
        console.log(`  ${outcome.stop}：${outcome.detail}`);
      }
      // An unconfirmed stop is a real failure for scripts: the process may still be running and the
      // Operation was left for a human, so the exit code must not report success.
      if (outcome.stop === 'UNCERTAIN') process.exit(1);
    } else {
      usage();
    }
  } else if (group === 'task' && action === 'depends') {
    // `task depends add|remove|list` is a three-level command, so the subcommand lands in
    // firstArgument. `add`/`remove` are commands (JSON result); `list` is a read that prints a human
    // view by default and the Runtime projection with `--json`.
    const subcommand = firstArgument;
    if (subcommand === 'add' || subcommand === 'remove') {
      // Flags may appear anywhere, so the arguments are walked in order instead of by position.
      const positionals: string[] = [];
      let requiredRevisionId: string | undefined;
      for (let index = 0; index < remainingArguments.length; index += 1) {
        const token = remainingArguments[index] as string;
        if (token === '--json') continue;
        if (subcommand === 'add' && token === '--revision') {
          const value = remainingArguments[index + 1];
          if (value === undefined) usage();
          requiredRevisionId = value;
          index += 1;
          continue;
        }
        if (token.startsWith('--')) usage();
        positionals.push(token);
      }
      const [projectId, taskId, versionText, prerequisiteTaskId, ...extra] = positionals;
      const expectedVersion = Number(versionText);
      if (projectId === undefined || taskId === undefined || versionText === undefined
        || prerequisiteTaskId === undefined || extra.length !== 0
        || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) usage();
      const result = await call({
        command: subcommand === 'add' ? 'task.depends.add' as const : 'task.depends.remove' as const,
        commandId: crypto.randomUUID(),
        projectId,
        taskId,
        prerequisiteTaskId,
        expectedVersion,
        ...(requiredRevisionId === undefined ? {} : { requiredRevisionId }),
      });
      print(result);
    } else if (subcommand === 'list') {
      const positionals: string[] = [];
      let json = false;
      for (const token of remainingArguments) {
        if (token === '--json') { json = true; continue; }
        if (token.startsWith('--')) usage();
        positionals.push(token);
      }
      const [projectId, taskId, ...extra] = positionals;
      if (projectId === undefined || extra.length !== 0) usage();
      const view = await call({ command: 'task.depends.list', projectId,
        ...(taskId === undefined ? {} : { taskId }) }) as TaskDependencyView;
      if (json) {
        print(view);
      } else {
        console.log(`project ${view.projectId} · ${view.baseRef} ${view.baseCommit ?? '缺失'}`
          + `${view.taskId === null ? '' : ` · 任务 ${view.taskId}`}`
          + ` · ${view.edges.length} 条依赖`);
        if (view.taskId !== null) {
          console.log(`状态 ${view.taskState ?? '?'} v${view.taskVersion ?? '?'}`
            + ` · ${view.blocked ? `依赖未满足（${view.edges.length} 条）` : '依赖已满足'}`);
        }
        for (const edge of view.edges) {
          console.log(`${edge.satisfied ? '✓' : '✗'} #${edge.dependentDisplayNumber}`
            + ` 依赖 #${edge.prerequisiteDisplayNumber}`
            + ` (revision #${edge.requiredRevisionNumber})`
            + `${edge.resultCommit === null ? '' : ` → ${edge.resultCommit.slice(0, 12)}`}`
            + `${edge.reason === null ? '' : ` · ${edge.reason.code}`}`);
        }
        if (view.taskId !== null
          && (view.prerequisites.length > 0 || view.dependents.length > 0)) {
          console.log(`上游闭包 ${view.prerequisites.length} 个 · 下游影响 ${view.dependents.length} 个`);
        }
      }
    } else {
      usage();
    }
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
      } else if (flag === '--json' && action === 'list') {
        // `list` already prints the Runtime projection verbatim; the flag is accepted so a script
        // can state its intent, exactly like `task revision list`.
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
  } else if (group === 'attention' && action === 'resolve') {
    // A prose-question wait has no provider dialog behind it: the Agent's process already exited.
    // This command records how the wait ended instead of pretending an answer was delivered, so
    // exactly one of `--dismiss` (false alarm) and `--answer <text>` is required, and neither adds
    // a confirmation step.
    const [attentionId, ...flags] = remainingArguments;
    if (firstArgument === undefined || attentionId === undefined) usage();
    let dismiss = false;
    let answer: string | undefined;
    let note: string | undefined;
    for (let index = 0; index < flags.length; index += 1) {
      const flag = flags[index];
      if (flag === '--dismiss') { dismiss = true; continue; }
      if (flag === '--json') continue;
      if (flag === '--note') {
        const value = flags[index + 1];
        if (value === undefined) usage();
        note = value;
        index += 1;
        continue;
      }
      if (flag === '--answer') {
        const value = flags[index + 1];
        if (value === undefined) usage();
        answer = value;
        index += 1;
        continue;
      }
      usage();
    }
    if (dismiss === (answer !== undefined)) usage();
    print(await call({
      command: 'attention.resolve',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      attentionId,
      resolution: dismiss ? 'DISMISSED_FALSE_POSITIVE' : 'ANSWERED',
      ...(answer === undefined ? {} : { text: answer }),
      ...(note === undefined ? {} : { note }),
    }));
  } else if (group === 'settings' && action === 'list') {
    // The settings overview (ADR-0064): one read that enumerates every Runtime-level setting, so
    // "which settings exist and what are they set to" is answered by the Runtime rather than by a
    // list this client maintains. Human-readable by default — a person asks this question — and
    // `--json` prints the Runtime's payload verbatim for a script.
    const tokens = [firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined);
    const json = tokens.includes('--json');
    if (tokens.length > 1 || tokens.some((token) => token !== '--json')) usage();
    const view = await call({ command: 'settings.list' }) as SettingsListView;
    if (json) print(view);
    else printSettingsList(view);
  } else if (group === 'settings' && action === 'permission') {
    // The permission mode is a setting (ADR-0011 / ADR-0064), so it is read and written where the
    // other Runtime-level switches are. Only the CLI spelling moved: the Runtime command, its file
    // (`permission-mode.json`) and its zero-confirmation semantics are unchanged.
    const tokens = [firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined && token !== '--json');
    if (tokens.some((token) => token.startsWith('--'))) usage();
    const [subcommand, mode, ...extra] = tokens;
    if (extra.length !== 0) usage();
    if (subcommand === 'get') {
      if (mode !== undefined) usage();
      print(await call({ command: 'permission.get' }));
    } else if (subcommand === 'set') {
      if (mode === undefined || !['full', 'strict'].includes(mode.toLowerCase())) usage();
      print(await call({
        command: 'permission.set',
        mode: mode.toUpperCase() as 'FULL' | 'STRICT',
      }));
    } else usage();
  } else if (group === 'settings' && action === 'prose-question-attention') {
    // The switch that decides whether a prose question becomes a wait. Reading and writing are one
    // command because the setting has exactly three values and no confirmation: `auto` (default),
    // `record-only` (annotate the completion but record no wait), `off` (record nothing).
    const tokens = [firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined && token !== '--json');
    if (tokens.length > 1) usage();
    const mode = tokens[0]?.toLowerCase();
    if (mode === undefined) {
      print(await call({ command: 'settings.proseQuestionAttention.get' }));
    } else {
      if (mode !== 'auto' && mode !== 'record-only' && mode !== 'off') usage();
      print(await call({ command: 'settings.proseQuestionAttention.set', mode }));
    }
  } else if (group === 'settings' && action === 'concurrency') {
    // The settings spelling of the one Runtime-wide concurrency limit (ADR-0061 D02). It is a thin
    // alias on purpose: the same story is told by `scheduler capacity`, and duplicating the rule here
    // (or worse, storing the value a second time) is how two readers end up disagreeing about the
    // same limit. The limit is discoverable where a user looks for settings, and it is adjusted in
    // real time — see `runConcurrencyCommand`.
    await runConcurrencyCommand([firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined));
  } else if (group === 'task' && action === 'revision') {
    // The revision face of PROJECT_SPEC §2.11: creating a revision is one command, and the delivery
    // of that revision into a running Execution is separately readable and separately resolvable. A
    // delivery is never reported as satisfied because the Runtime sent something — the state comes
    // from the recorded ledger, and for an Adapter without an acknowledgement channel it stays
    // visibly unconfirmed until the explicit stop-and-restart records a successor on that revision.
    const subcommand = firstArgument;
    if (subcommand === 'create') {
      const [projectId, taskId, versionText, ...flagTokens] = remainingArguments;
      const expectedVersion = Number(versionText);
      if (projectId === undefined || taskId === undefined || versionText === undefined
        || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) usage();
      const input = parseRevisionFlags(flagTokens);
      print(await call({
        command: 'task.revision.create',
        commandId: crypto.randomUUID(),
        projectId,
        taskId,
        expectedVersion,
        ...(input.specification === undefined ? {} : { specification: input.specification }),
        ...(input.features === undefined ? {} : { features: [...input.features] }),
        reason: input.reason,
      }));
    } else if (subcommand === 'list') {
      const [projectId, taskId, ...extra] = remainingArguments;
      if (projectId === undefined || taskId === undefined || extra.length !== 0) usage();
      print(await call({ command: 'task.revision.list', projectId, taskId }));
    } else if (subcommand === 'delivery') {
      const deliveryAction = remainingArguments[0];
      if (deliveryAction === 'list') {
        const [projectId, taskId, ...extra] = remainingArguments.slice(1);
        if (projectId === undefined || taskId === undefined || extra.length !== 0) usage();
        print(await call({ command: 'task.revision.delivery.list', projectId, taskId }));
      } else if (deliveryAction === 'get') {
        const [projectId, deliveryId, ...extra] = remainingArguments.slice(1);
        if (projectId === undefined || deliveryId === undefined || extra.length !== 0) usage();
        print(await call({ command: 'task.revision.delivery.get', projectId, deliveryId }));
      } else if (deliveryAction === 'resolve') {
        const [projectId, taskId, deliveryId, versionText, ...tokens] = remainingArguments.slice(1);
        const expectedVersion = Number(versionText);
        if (projectId === undefined || taskId === undefined || deliveryId === undefined
          || versionText === undefined || !Number.isSafeInteger(expectedVersion)
          || expectedVersion < 0) usage();
        let action: 'STOP_AND_RESTART' | 'RETRY' | undefined;
        let adapterId = 'pi';
        for (let index = 0; index < tokens.length; index += 1) {
          const flag = tokens[index];
          const value = tokens[index + 1];
          if (flag === '--action' && value === 'stop-and-restart') { action = 'STOP_AND_RESTART'; index += 1; }
          else if (flag === '--action' && value === 'retry') { action = 'RETRY'; index += 1; }
          else if (flag === '--adapter' && value !== undefined) { adapterId = value; index += 1; }
          else if (flag === '--json') continue;
          else usage();
        }
        if (action === undefined) usage();
        const resolved = await call({
          command: 'task.revision.delivery.resolve',
          commandId: crypto.randomUUID(),
          projectId,
          taskId,
          deliveryId,
          action,
          expectedVersion,
          adapterId,
        }) as { readonly outcome: string; readonly detail: string };
        print(resolved);
        // The command face only reports success when the revision is actually confirmed on an
        // Execution; a retry on an Adapter without an acknowledgement channel is honest and leaves
        // the delivery unconfirmed, which a script must be able to see from the exit code.
        if (!['SUPERSEDED_BY_RESTART', 'RESOLVED', 'ALREADY_SATISFIED'].includes(resolved.outcome)) {
          process.exit(1);
        }
      } else {
        usage();
      }
    } else {
      usage();
    }
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
  } else if (group === 'reclaim') {
    // `reclaim` is the only destructive command face. `plan` is its read-only dry run and returns
    // exactly the decision shape `apply` records, so a preview can never disagree with the run.
    // Without `--project` (or with `--all-projects`) the command covers every trusted project and
    // groups its answer per project; an unregistered directory is never deleted unless the caller
    // names that exact path with `--remove-unregistered` (ADR-0037).
    const [subcommand, ...flagTokens] = [action, firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined);
    if (subcommand !== 'plan' && subcommand !== 'apply' && subcommand !== 'records') usage();
    let projectId: string | undefined;
    let allProjects = false;
    let taskId: string | undefined;
    let scanRoot: string | undefined;
    let unregistered = false;
    let source: 'ALL' | 'REGISTERED' | 'UNREGISTERED_DIRECTORY' | undefined;
    let since: number | undefined;
    let until: number | undefined;
    const removeUnregistered: string[] = [];
    const kinds: ReclaimKindName[] = [];
    let includeFailureScenes = false;
    let limit: number | undefined;
    /** `--since`/`--until` accept epoch milliseconds or any ISO-8601 timestamp. */
    const timestamp = (value: string): number => {
      if (/^\d+$/.test(value)) {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed)) return parsed;
      }
      const parsed = Date.parse(value);
      if (Number.isNaN(parsed)) usage();
      return parsed;
    };
    for (let index = 0; index < flagTokens.length; index += 1) {
      const flag = flagTokens[index];
      const value = flagTokens[index + 1];
      if (flag === '--project' && value !== undefined) { projectId = value; index += 1; }
      else if (flag === '--all-projects') allProjects = true;
      else if (flag === '--task' && value !== undefined) { taskId = value; index += 1; }
      else if (flag === '--kind' && value !== undefined
        && (reclaimKindNames as readonly string[]).includes(value)) {
        kinds.push(value as ReclaimKindName);
        index += 1;
      } else if (flag === '--include-failure-scenes' && subcommand !== 'records') {
        includeFailureScenes = true;
      } else if (flag === '--unregistered' && subcommand !== 'records') {
        unregistered = true;
      } else if (flag === '--scan-root' && value !== undefined && subcommand !== 'records') {
        scanRoot = value;
        unregistered = true;
        index += 1;
      } else if (flag === '--remove-unregistered' && value !== undefined
        && subcommand !== 'records') {
        if (removeUnregistered.length >= maxUnregisteredSelections) usage();
        removeUnregistered.push(value);
        unregistered = true;
        index += 1;
      } else if (flag === '--source' && value !== undefined && subcommand === 'records') {
        const normalized = value.toUpperCase();
        if (normalized !== 'ALL' && normalized !== 'REGISTERED'
          && normalized !== 'UNREGISTERED_DIRECTORY') usage();
        source = normalized;
        index += 1;
      } else if (flag === '--since' && value !== undefined && subcommand === 'records') {
        since = timestamp(value);
        index += 1;
      } else if (flag === '--until' && value !== undefined && subcommand === 'records') {
        until = timestamp(value);
        index += 1;
      } else if (flag === '--json') {
        // Every reclaim subcommand already prints the Runtime result verbatim; the flag is
        // accepted so a script can state its intent without depending on that default.
      } else if (flag === '--limit' && value !== undefined && subcommand === 'records') {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxReclaimRecordLimit) usage();
        limit = parsed;
        index += 1;
      } else {
        usage();
      }
    }
    if (projectId !== undefined && allProjects) usage();
    if (taskId !== undefined && projectId === undefined) usage();
    if (since !== undefined && until !== undefined && since >= until) usage();
    // Both ways of naming a scope are explicit: one project, or every trusted project. A missing
    // `--project` is not an error here, but it means "all projects" only in the batch sense.
    const scope = projectId === undefined
      ? { allProjects: true as const, projectId: undefined }
      : { allProjects: false as const, projectId };
    const shared = {
      ...scope,
      ...(taskId === undefined ? {} : { taskId }),
      unregistered,
      ...(scanRoot === undefined ? {} : { scanRoot }),
    };
    if (subcommand === 'plan') {
      const plan = await call({ command: 'reclaim.plan', ...shared,
        ...(kinds.length === 0 ? {} : { kinds }),
        ...(removeUnregistered.length === 0 ? {} : { removeUnregistered }),
        includeFailureScenes }) as ReclaimPlanView;
      print(plan);
      // A group that could not even be planned makes the whole preview a failure; everything else
      // ("nothing to reclaim") is a normal answer reported as exit 3, which keeps it apart from both
      // a real error (1) and "there is work to do" (0) without parsing JSON. Nothing is written to
      // stderr, so `--json` output stays the only thing a script has to read.
      if (plan.outcome === 'FAILED') process.exit(1);
      if (reclaimableCount(plan) === 0) process.exit(3);
    } else if (subcommand === 'apply') {
      const report = await call({ command: 'reclaim.apply', commandId: crypto.randomUUID(),
        ...shared, ...(kinds.length === 0 ? {} : { kinds }),
        ...(removeUnregistered.length === 0 ? {} : { removeUnregistered }),
        includeFailureScenes }) as ReclaimReportView;
      print(report);
      // A resource that could not be removed is a real failure for scripts. Retained and refused
      // resources are intentional outcomes: a run that reclaimed nothing exits 3 (nothing was
      // reclaimed) while one that reclaimed something exits 0.
      if (report.outcome === 'FAILED') process.exit(1);
      if (reclaimedCount(report) === 0) process.exit(3);
    } else {
      print(await call({ command: 'reclaim.records', ...scope,
        ...(taskId === undefined ? {} : { taskId }),
        source: source ?? 'ALL',
        ...(since === undefined ? {} : { since }),
        ...(until === undefined ? {} : { until }),
        limit: limit ?? 100 }));
    }
  } else if (group === 'task' && action === 'schedule') {
    // The scheduling engine's command face (FOUNDATION-055). `status` and `plan` observe (plan is the
    // ordered dry run: it reserves nothing and starts nothing), `explain` answers why one Task is not
    // running now, `run` requests a pass of the loop the Runtime also runs on events and on its
    // recovery period, and `clear-unknown` records an explicit single-shot release without starting
    // anything. None of them adds a confirmation step.
    const subcommand = firstArgument;
    if (subcommand === 'status' || subcommand === 'plan' || subcommand === 'run') {
      const split = splitFlagTokens(remainingArguments, ['--adapter'], ['--json']);
      const [projectId, ...extra] = split.positionals;
      if (projectId === undefined || extra.length !== 0) usage();
      const adapterId = split.flags.get('--adapter');
      const adapter = adapterId === undefined ? {} : { adapterId };
      if (subcommand === 'status') {
        const view = await call({ command: 'task.schedule.status', projectId, ...adapter }) as
          ScheduleOverviewView;
        print(view);
        printOccupierDiagnosticsForCandidates(projectId, view.candidates);
      } else if (subcommand === 'plan') {
        // `plan` is the dry run of `status`, so it answers with the same overview shape (dryRun: true).
        const overview = await call({ command: 'task.schedule.plan', projectId, ...adapter }) as
          ScheduleOverviewView;
        print(overview);
        printOccupierDiagnosticsForCandidates(projectId, overview.candidates);
      } else {
        const report = await call({
          command: 'task.schedule.run',
          commandId: crypto.randomUUID(),
          projectId,
          ...adapter,
        }) as ScheduleTickReport;
        print(report);
        // A tick is a *pass*, not a verdict: exit 0 means the pass ran, and what it decided is in the
        // report (started, waiting with reason codes, blocked). Nothing starting is not a failure.
        for (const project of report.projects) {
          for (const candidate of project.candidates) {
            console.error(`[scheduler] ${candidate.disposition} ${candidate.taskId}`
              + `: ${candidate.detail}`);
          }
          printOccupierDiagnosticsForCandidates(projectId, project.candidates);
        }
      }
    } else if (subcommand === 'explain') {
      const split = splitFlagTokens(remainingArguments, ['--adapter'], ['--json']);
      const [projectId, taskId, ...extra] = split.positionals;
      if (projectId === undefined || taskId === undefined || extra.length !== 0) usage();
      const adapterId = split.flags.get('--adapter');
      const view = await call({
        command: 'task.schedule.explain',
        projectId,
        taskId,
        ...(adapterId === undefined ? {} : { adapterId }),
      }) as ScheduleExplanationView;
      print(view);
      console.error(`[scheduler] ${view.decision}: ${view.detail}`);
      printOccupierDiagnostics(view.projectId, view.assessment, view.activeTaskIds);
      // 0 = it is running or would start now, 3 = it is waiting (conflict or capacity — a wait is not
      // BLOCKED), 1 = it will not start for a reason that needs attention (unmet dependencies, or a
      // state that is not schedulable at all).
      if (view.decision === 'WAIT_CONFLICT' || view.decision === 'WAIT_CAPACITY') process.exit(3);
      if (view.decision === 'BLOCKED' || view.decision === 'NOT_A_CANDIDATE') process.exit(1);
    } else if (subcommand === 'clear-unknown') {
      const split = splitFlagTokens(remainingArguments, [], ['--json']);
      const [projectId, taskId, ...extra] = split.positionals;
      if (projectId === undefined || taskId === undefined || extra.length !== 0) usage();
      const released = await call({
        command: 'task.schedule.clearUnknown',
        commandId: crypto.randomUUID(),
        projectId,
        taskId,
      }) as ScheduleUnknownReleaseView;
      print(released);
      // CONFLICTING is a *proven* overlap: `--allow-unknown` widens the gate for an unproven one
      // only, so releasing it is refused with exit 1 instead of pretending it worked.
      if (released.state === 'CONFLICTING') process.exit(1);
    } else {
      usage();
    }
  } else if (group === 'scheduler') {
    // Capacity and slot reservations (FOUNDATION-054 / ADR-0032). This is the only scheduler command
    // group in this lane: candidate ordering, ticks and `task schedule *` belong to the scheduling
    // engine, and `project impact *` to the analyzer. A capacity wait is reported as a wait (exit
    // code 3, never as BLOCKED) with its stable reason code; a refusal to grant a slot is a real
    // error with a stable code and exit code 1.
    const [subcommand, ...tokens] = [action, firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined);
    if (subcommand === 'control') {
      // The Runtime global load control (FOUNDATION-097 / ADR-0061 D09). These commands belong to no
      // Project: the barrier is host-wide. `status` and `reconcile` only observe; `pause`/`resume`
      // are the explicit user command themselves (zero confirmation, in FULL and STRICT alike), and
      // they exit 1 with a stable code when any target could not be verified — a partial freeze is
      // never reported as a complete one. A Task merely *waiting* for the barrier still exits 3.
      const split = splitFlagTokens(tokens, [], ['--json']);
      const [controlAction, ...extra] = split.positionals;
      if (controlAction === undefined || extra.length !== 0) usage();
      const status = async (): Promise<void> => {
        print(await call({ command: 'scheduler.control.status' }));
      };
      if (controlAction === 'status') {
        await status();
      } else if (controlAction === 'pause' || controlAction === 'resume') {
        try {
          print(await call({
            command: controlAction === 'pause'
              ? 'scheduler.control.pause' : 'scheduler.control.resume',
            commandId: crypto.randomUUID(),
          }));
        } catch (error) {
          // The refusal carries a stable code and one sentence; the per-target facts are what makes it
          // actionable, and they are read back from the *command face* rather than guessed here.
          console.error(`[scheduler] ${errorText(error)}`);
          await status();
          process.exit(1);
        }
      } else if (controlAction === 'reconcile') {
        print(await call({ command: 'scheduler.control.reconcile' }));
      } else {
        usage();
      }
    } else if (subcommand === 'capacity') {
      // The Runtime-wide capacity face (ADR-0061 D02). `settings concurrency` is the same command
      // under its settings spelling — see `runConcurrencyCommand`.
      await runConcurrencyCommand(tokens);
    } else if (subcommand === 'reservations') {
      const split = splitFlagTokens(tokens,
        ['--task', '--revision', '--adapter', '--reason', '--limit', '--snapshot'],
        ['--include-released', '--json']);
      const [reservationAction, projectId, ...extra] = split.positionals;
      if (reservationAction === undefined || projectId === undefined) usage();
      const snapshotId = split.flags.get('--snapshot');
      if (snapshotId !== undefined && reservationAction !== 'acquire') usage();
      const limitText = split.flags.get('--limit');
      const limit = limitText === undefined ? undefined : Number(limitText);
      if (limitText !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1
        || (limit as number) > maxSlotReservationReadLimit)) usage();
      if (reservationAction === 'list') {
        if (extra.length !== 0) usage();
        print(await call({
          command: 'scheduler.reservations.list',
          projectId,
          includeReleased: split.bare.has('--include-released'),
          ...(split.flags.get('--task') === undefined ? {} : { taskId: split.flags.get('--task') }),
          ...(limit === undefined ? {} : { limit }),
        }));
      } else if (reservationAction === 'get') {
        const [reservationId, ...rest] = extra;
        if (reservationId === undefined || rest.length !== 0) usage();
        print(await call({ command: 'scheduler.reservations.get', projectId, reservationId }));
      } else if (reservationAction === 'acquire') {
        const [taskId, versionText, ...rest] = extra;
        const expectedTaskVersion = Number(versionText);
        const revisionId = split.flags.get('--revision');
        if (taskId === undefined || versionText === undefined || rest.length !== 0
          || revisionId === undefined || !Number.isSafeInteger(expectedTaskVersion)
          || expectedTaskVersion < 0) usage();
        let result: SlotReservationAcquisitionView;
        try {
          result = await call({
            command: 'scheduler.reservations.acquire',
            commandId: crypto.randomUUID(),
            projectId,
            taskId,
            expectedTaskVersion,
            revisionId,
            adapterId: split.flags.get('--adapter') ?? 'pi',
            ...(snapshotId === undefined ? {} : { impactSnapshotId: snapshotId }),
          }) as SlotReservationAcquisitionView;
        } catch (error) {
          const detail = error instanceof CliRuntimeError && isSnapshotRefusal(error.detail)
            ? error.detail : undefined;
          if (detail === undefined) throw error;
          // A refusal whose code cannot carry its facts (the generation recheck names the components
          // that moved) is printed as JSON and then reported through the exit code, the same way
          // `project impact explain` and `task schedule run` report a refusal. Nothing was written:
          // the transaction rolled back, so the facts a caller reads here are the whole failure.
          const code = errorCodeOf(error) ?? 'REFUSED';
          print({ outcome: 'REFUSED', code, message: (error as Error).message, detail });
          console.error(`[scheduler] refused: ${code} — ${(error as Error).message}`);
          process.exit(1);
        }
        print(result);
        // A granted slot is a fact; a *wait* is a fact too, but a script needs to tell them apart
        // without parsing JSON, so a wait exits 3 and a refusal exits 1.
        if (result.outcome !== 'RESERVED') {
          const label = result.outcome === 'DRAINING' ? 'draining' : 'capacity wait';
          console.error(`[scheduler] ${label}: ${result.wait?.code ?? 'unknown'}`
            + ` (${result.wait?.detail ?? 'no detail'})`);
          process.exit(3);
        }
      } else if (reservationAction === 'release') {
        const [reservationId, ...rest] = extra;
        const reason = split.flags.get('--reason');
        if (reservationId === undefined || rest.length !== 0 || reason === undefined) usage();
        const result = await call({
          command: 'scheduler.reservations.release',
          commandId: crypto.randomUUID(),
          projectId,
          reservationId,
          reason,
        }) as SlotReservationReleaseView;
        print(result);
        if (!result.released) {
          // Nothing was released because it already was: an honest no-op, not a failure.
          console.error('[scheduler] the reservation was already released');
        }
      } else if (reservationAction === 'prepare-workspace') {
        const [reservationId, versionText, ...rest] = extra;
        const expectedTaskVersion = Number(versionText);
        if (reservationId === undefined || versionText === undefined || rest.length !== 0
          || !Number.isSafeInteger(expectedTaskVersion) || expectedTaskVersion < 0) usage();
        print(await call({
          command: 'scheduler.reservations.workspace.prepare',
          commandId: crypto.randomUUID(),
          projectId,
          reservationId,
          expectedTaskVersion,
        }));
      } else if (reservationAction === 'reconcile') {
        if (extra.length !== 0) usage();
        const report = await call({
          command: 'scheduler.reservations.reconcile',
          commandId: crypto.randomUUID(),
          projectId,
        }) as SlotReservationReconcileReport;
        print(report);
        // A reconcile that decided to keep a slot occupied is a *successful* reconcile: the recorded
        // fact is the outcome, and an unverifiable holder is never reported as a failure to release.
        if (report.outcomes.some((outcome) => outcome.outcome === 'FAILED')) process.exit(1);
      } else {
        usage();
      }
    } else {
      usage();
    }
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
