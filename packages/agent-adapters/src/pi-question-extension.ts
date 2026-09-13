import {
  encodeQuestionnaireDialogTitle,
  maxQuestionnaireOptions,
  maxQuestionnaireQuestions,
  parseQuestionnaireAnswer,
  questionnaireOptionLine,
  questionnaireSchema,
  type Questionnaire,
  type QuestionnaireAnswer,
  type QuestionnaireQuestion,
} from '@codeestra/contracts';

/**
 * Codeestra's structured-question extension.
 *
 * It registers one tool — `ask_user_question` — and turns a questionnaire into exactly one
 * provider dialog, so the Runtime sees one Attention for one decision instead of one Attention
 * per question. The questionnaire travels in the dialog title (see
 * `encodeQuestionnaireDialogTitle`) because the Pi extension UI protocol has no other structured
 * field; Codeestra is the only client of this dialog, and it answers with the encoded answer
 * payload rather than with an option label.
 *
 * This extension is loaded explicitly by the controlled launch (`--no-extensions --extension …`),
 * like the permission gate. It must not import Pi's own types at runtime: the extension is
 * evaluated inside the Pi process, and the structural shapes below are the whole contract it uses.
 */

/** Name the tool is exposed under. Kept identical to the widely used tool of the same shape. */
export const codeestraAskUserQuestionToolName = 'ask_user_question';

/**
 * Structural slice of `ExtensionContext` this extension needs. Deliberately local: the Pi
 * process evaluates this file, and the pinned SDK types are not a dependency of this package.
 */
interface QuestionContext {
  readonly hasUI: boolean;
  readonly mode?: string;
  readonly ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
  };
}

interface QuestionToolResult {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
  readonly details: unknown;
  readonly isError?: boolean;
}

interface QuestionTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: unknown,
    onUpdate: unknown,
    ctx: QuestionContext,
  ): Promise<QuestionToolResult>;
}

interface QuestionExtensionApi {
  registerTool(tool: QuestionTool): void;
}

const optionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'description'],
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 60,
      description: 'Short option text the user picks (1-5 words).' },
    description: { type: 'string', minLength: 1, maxLength: 300,
      description: 'What choosing this option means or costs. One line.' },
  },
} as const;

const questionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'header', 'options'],
  properties: {
    question: { type: 'string', minLength: 1, maxLength: 500,
      description: 'The complete question, ending in a question mark.' },
    header: { type: 'string', minLength: 1, maxLength: 16,
      description: 'Very short label for the question (max 16 characters).' },
    multiSelect: { type: 'boolean',
      description: 'True when more than one option may be chosen. Defaults to false.' },
    options: { type: 'array', minItems: 2, maxItems: maxQuestionnaireOptions, items: optionSchema,
      description: 'Two to four mutually distinct options, each with a description.' },
  },
} as const;

const parameters = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: { type: 'array', minItems: 1, maxItems: maxQuestionnaireQuestions, items: questionSchema,
      description: 'One to four questions asked together in a single interruption.' },
  },
} as const;

const toolDescription = [
  'Ask the user one to four questions, each with two to four written-out options, when a decision',
  'would change the deliverable and guessing would waste work. The questions are put to the user',
  'as a single request and the task waits until they answer, so ask everything you need at once.',
  'Prefer acting on a reasonable default when the choice is reversible or incidental. Do not use',
  'this tool to ask for permission to run a command, and do not use it to report progress.',
].join(' ');

const promptGuidelines = [
  'Use ask_user_question when a decision genuinely changes the deliverable and you cannot settle it',
  'from the task specification or the repository. Ask everything you need in one call (up to four',
  'questions), never one question at a time.',
  'Do not use ask_user_question for permission to execute tools, for progress reports, or for',
  'choices that are reversible and incidental: pick a reasonable default and continue.',
];

function textResult(text: string, details: unknown, isError = false): QuestionToolResult {
  return { content: [{ type: 'text', text }], details, ...(isError ? { isError: true } : {}) };
}

/**
 * A raw dialog host (for example a hand-driven `pi --mode rpc` session) cannot build the encoded
 * answer payload, so the dialog still lists the questions and their options readably. Codeestra
 * itself never reads this list; it reads the questionnaire out of the dialog title.
 */
function readableOptions(questionnaire: Questionnaire): readonly string[] {
  const lines: string[] = [];
  questionnaire.questions.forEach((question: QuestionnaireQuestion, questionIndex: number) => {
    lines.push(`Q${questionIndex + 1} [${question.header}] ${question.question}`
      + (question.multiSelect ? '  (choose one or more)' : ''));
    question.options.forEach((option, optionIndex) => {
      lines.push(`   ${questionnaireOptionLine(option, optionIndex)}`);
    });
  });
  return lines;
}

function answeredText(questionnaire: Questionnaire, answer: QuestionnaireAnswer): string {
  const lines: string[] = [];
  let answered = 0;
  questionnaire.questions.forEach((question, questionIndex) => {
    const entry = answer.answers.find((candidate) => candidate.questionIndex === questionIndex);
    if (entry === undefined) {
      lines.push(`[${questionIndex + 1}] ${question.header} — ${question.question}\n    (unanswered)`);
      return;
    }
    answered += 1;
    if (entry.type === 'TEXT') {
      lines.push(`[${questionIndex + 1}] ${question.header} — ${question.question}\n`
        + `    the user wrote: ${entry.text}`);
      return;
    }
    const labels = entry.choiceIndexes.map((index) => {
      const option = question.options[index];
      return option === undefined ? `option ${index + 1}` : `${option.label} — ${option.description}`;
    });
    lines.push(`[${questionIndex + 1}] ${question.header} — ${question.question}\n`
      + labels.map((label) => `    selected: ${label}`).join('\n'));
  });
  const header = `The user answered ${answered} of ${questionnaire.questions.length} question`
    + `${questionnaire.questions.length === 1 ? '' : 's'}.`;
  return `${header}\n\n${lines.join('\n')}`;
}

export function registerAskUserQuestionTool(pi: QuestionExtensionApi): void {
  pi.registerTool({
    name: codeestraAskUserQuestionToolName,
    label: 'Ask the user',
    description: toolDescription,
    promptSnippet: 'Ask the user up to four questions with written-out options before guessing',
    promptGuidelines,
    parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return textResult(
          'Error: UI not available (this Agent has no user-facing question channel). Continue with '
          + 'a reasonable default and say which assumption you made.',
          { cancelled: true, answers: [], error: 'no_ui' });
      }
      const parsed = questionnaireSchema.safeParse(params);
      if (!parsed.success) {
        return textResult(`Error: invalid questionnaire: ${parsed.error.message}`,
          { cancelled: true, answers: [], error: 'invalid_questionnaire' }, true);
      }
      const questionnaire = parsed.data;
      const title = encodeQuestionnaireDialogTitle(questionnaire);
      const chosen = await ctx.ui.select(title, [...readableOptions(questionnaire)]);
      if (chosen === undefined) {
        return textResult('User declined to answer questions',
          { answers: [], cancelled: true });
      }
      // The title is the payload's carrier; a host that answers with something else (an option
      // label, or a truncated string) is reported as unreadable instead of being treated as a
      // decline, so the Agent can decide to ask again rather than silently proceed.
      const answer = parseQuestionnaireAnswer(chosen);
      if (answer === null) {
        return textResult(
          'Error: the user answered, but the answer could not be read (it did not carry a valid '
          + 'questionnaire answer). The questions were shown. Do not treat this as a decline; ask '
          + 'again or continue with a stated assumption.',
          { answers: [], cancelled: false, error: 'unreadable_answer' }, true);
      }
      return textResult(answeredText(questionnaire, answer),
        { answers: answer.answers, cancelled: false });
    },
  });
}

export default function codeestraQuestionExtension(pi: QuestionExtensionApi): void {
  registerAskUserQuestionTool(pi);
}
