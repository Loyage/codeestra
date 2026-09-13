import { z } from 'zod';

/**
 * A structured question set an Agent may put to the user instead of guessing.
 *
 * The shape deliberately mirrors the widely used `ask_user_question` tool (one to four
 * questions, each with two to four written-out options and descriptions, optional
 * multi-select), so a model that has seen that tool needs no extra teaching. It is a
 * Codeestra-owned contract: nothing here depends on a third-party extension being installed.
 *
 * One questionnaire is one Attention and one provider dialog. That keeps the existing
 * "one Attention = one awaited provider request = one answer Operation" invariant intact.
 */
export const questionnaireOptionSchema = z.strictObject({
  label: z.string().min(1).max(60),
  description: z.string().min(1).max(300),
});
export type QuestionnaireOption = z.infer<typeof questionnaireOptionSchema>;

export const questionnaireQuestionSchema = z.strictObject({
  question: z.string().min(1).max(500),
  /** Short chip/tag shown next to the question; also the CLI row label. */
  header: z.string().min(1).max(16),
  multiSelect: z.boolean(),
  options: z.array(questionnaireOptionSchema).min(2).max(4),
});
export type QuestionnaireQuestion = z.infer<typeof questionnaireQuestionSchema>;

export const questionnaireSchema = z.strictObject({
  questions: z.array(questionnaireQuestionSchema).min(1).max(4),
});
export type Questionnaire = z.infer<typeof questionnaireSchema>;

export const maxQuestionnaireQuestions = 4;
export const maxQuestionnaireOptions = 4;
export const questionnaireChoiceIndexLimit = maxQuestionnaireOptions;
export const questionnaireTextAnswerMaxChars = 4_000;

/**
 * The stored shape of a questionnaire Attention's `prompt`. A stored prompt is untyped in the
 * database, so it carries its own discriminator: clients must not guess from the presence of
 * fields that an arbitrary provider dialog is a Codeestra questionnaire.
 */
export const questionnairePromptSchema = z.strictObject({
  kind: z.literal('codeestra.questionnaire'),
  version: z.literal(1),
  questionnaire: questionnaireSchema,
});
export type QuestionnairePrompt = z.infer<typeof questionnairePromptSchema>;

/** One question answered by picking existing options. */
export const questionnaireChoicesAnswerSchema = z.strictObject({
  type: z.literal('CHOICES'),
  questionIndex: z.number().int().nonnegative().max(maxQuestionnaireQuestions - 1),
  choiceIndexes: z.array(z.number().int().nonnegative().max(maxQuestionnaireOptions - 1))
    .min(1).max(maxQuestionnaireOptions),
});
/** One question answered in the user's own words. */
export const questionnaireTextAnswerSchema = z.strictObject({
  type: z.literal('TEXT'),
  questionIndex: z.number().int().nonnegative().max(maxQuestionnaireQuestions - 1),
  text: z.string().min(1).max(questionnaireTextAnswerMaxChars),
});
export type QuestionnaireQuestionAnswer =
  | z.infer<typeof questionnaireChoicesAnswerSchema>
  | z.infer<typeof questionnaireTextAnswerSchema>;

/**
 * A structured answer to a questionnaire Attention. Questions left out are reported back to the
 * Agent as unanswered rather than silently declined, which is why at least one answer is required:
 * "answer nothing" is expressed as `{ type: 'CANCEL' }`, never as an empty answer list.
 */
export const questionnaireAnswerSchema = z.strictObject({
  version: z.literal(1),
  answers: z.array(z.discriminatedUnion('type', [
    questionnaireChoicesAnswerSchema,
    questionnaireTextAnswerSchema,
  ])).min(1).max(maxQuestionnaireQuestions),
});
export type QuestionnaireAnswer = z.infer<typeof questionnaireAnswerSchema>;

export type QuestionnaireAnswerProblem = Readonly<{ code: string; message: string }>;

/**
 * Check one structured answer against the questionnaire it claims to answer. This is the only
 * place the rules live, so the CLI, the Web UI and the Runtime all reject an impossible answer
 * with the same codes instead of three slightly different interpretations.
 *
 * A rejected answer is never "interpreted": an out-of-range option is a user mistake the caller
 * must report, not an implicit decline (which would throw away the answers that were valid).
 */
export function validateQuestionnaireAnswer(
  questionnaire: Questionnaire,
  answer: QuestionnaireAnswer,
): QuestionnaireAnswerProblem | null {
  const seen = new Set<number>();
  for (const entry of answer.answers) {
    // Messages number questions and options from 1, matching how both are displayed to the user.
    if (entry.questionIndex >= questionnaire.questions.length) {
      return { code: 'QUESTION_INDEX_OUT_OF_RANGE',
        message: `There is no question ${entry.questionIndex + 1}` };
    }
    if (seen.has(entry.questionIndex)) {
      return { code: 'DUPLICATE_QUESTION_ANSWER',
        message: `Question ${entry.questionIndex + 1} was answered more than once` };
    }
    seen.add(entry.questionIndex);
    if (entry.type === 'TEXT') continue;
    const question = questionnaire.questions[entry.questionIndex];
    if (question === undefined) {
      return { code: 'QUESTION_INDEX_OUT_OF_RANGE',
        message: `There is no question ${entry.questionIndex + 1}` };
    }
    const unique = new Set(entry.choiceIndexes);
    if (unique.size !== entry.choiceIndexes.length) {
      return { code: 'DUPLICATE_CHOICE',
        message: `Question ${entry.questionIndex + 1} lists the same option twice` };
    }
    for (const choice of entry.choiceIndexes) {
      if (choice >= question.options.length) {
        return { code: 'CHOICE_INDEX_OUT_OF_RANGE',
          message: `Question ${entry.questionIndex + 1} has no option ${choice + 1}` };
      }
    }
    if (!question.multiSelect && entry.choiceIndexes.length !== 1) {
      return { code: 'MULTIPLE_CHOICES_FOR_SINGLE_SELECT',
        message: `Question ${entry.questionIndex + 1} accepts exactly one option` };
    }
  }
  return null;
}

const questionnaireTitlePrefix = 'CODEESTRA_QUESTIONNAIRE:v1:';

/**
 * The provider dialog title that carries a questionnaire. The Pi extension UI protocol has no
 * structured payload field other than the dialog title/message, so the validated questionnaire is
 * JSON-encoded inside it (the same technique the permission gate already uses to carry a tool-call
 * fingerprint). Keeping it readable JSON instead of base64 means a raw RPC log is still legible.
 */
export function encodeQuestionnaireDialogTitle(questionnaire: Questionnaire): string {
  return `${questionnaireTitlePrefix}${JSON.stringify(questionnaireSchema.parse(questionnaire))}`;
}

/**
 * Decode a dialog title this project wrote. Returns `null` for anything else, including a
 * Codeestra questionnaire title that no longer validates: the caller degrades to a plain
 * question Attention instead of failing the observation stream.
 */
export function decodeQuestionnaireDialogTitle(title: string): Questionnaire | null {
  if (!title.startsWith(questionnaireTitlePrefix)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(title.slice(questionnaireTitlePrefix.length));
  } catch {
    return null;
  }
  const questionnaire = questionnaireSchema.safeParse(parsed);
  return questionnaire.success ? questionnaire.data : null;
}

/**
 * The provider-facing payload of one questionnaire answer. It is only ever produced by an Adapter
 * for its own dialog walker, so it is not part of any public command.
 */
export function serializeQuestionnaireAnswer(answer: QuestionnaireAnswer): string {
  return JSON.stringify(questionnaireAnswerSchema.parse(answer));
}

/** Decode what the provider dialog returned. `null` means the dialog did not carry a valid answer. */
export function parseQuestionnaireAnswer(value: string): QuestionnaireAnswer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const answer = questionnaireAnswerSchema.safeParse(parsed);
  return answer.success ? answer.data : null;
}

/** Human-readable option line used by both the CLI/UI and the provider dialog fallback. */
export function questionnaireOptionLine(option: QuestionnaireOption, index: number): string {
  return `${index + 1}. ${option.label} — ${option.description}`;
}
