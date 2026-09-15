import { z } from 'zod';

/**
 * The command-face shapes of the prose-question wait (FOUNDATION-069).
 *
 * A prose-question Attention is *not* a provider dialog: the Agent ended its turn and its process
 * exited, so there is no awaited provider request behind it. It therefore has its own resolution
 * command instead of reusing `attention.answer`, whose delivery path writes a provider response.
 * Nothing in this file carries an approval, a confirmation or a permission: resolving a wait is
 * bookkeeping about a wait, not a decision about what the Agent may do.
 */

/**
 * How eagerly the Runtime escalates the FOUNDATION-056 completion note into a wait.
 * `auto` is the product default; `record-only` and `off` are explicit downgrades.
 */
export const proseQuestionAttentionModes = ['auto', 'record-only', 'off'] as const;
export const proseQuestionAttentionModeSchema = z.enum(proseQuestionAttentionModes);
export type ProseQuestionAttentionMode = z.infer<typeof proseQuestionAttentionModeSchema>;

export const defaultProseQuestionAttentionMode: ProseQuestionAttentionMode = 'auto';

/** The two ways a prose-question wait ends; they are different audit facts, not one flag. */
export const proseQuestionResolutionSchema = z.enum(['DISMISSED_FALSE_POSITIVE', 'ANSWERED']);
export type ProseQuestionResolution = z.infer<typeof proseQuestionResolutionSchema>;

/** Mirrors the domain limit; longer text is refused by the Runtime rather than truncated here. */
export const maxProseQuestionAnswerLength = 4_000;
export const maxProseQuestionResolutionNoteLength = 2_000;

/**
 * One resolution of one prose-question wait. `text` is required exactly for `ANSWERED`: an answer
 * with no text is refused, and a dismissal that smuggles text in is refused, so the recorded audit
 * row always means what it says.
 */
export const proseQuestionResolutionRequestSchema = z.strictObject({
  resolution: proseQuestionResolutionSchema,
  text: z.string().trim().min(1).max(maxProseQuestionAnswerLength).optional(),
  note: z.string().trim().min(1).max(maxProseQuestionResolutionNoteLength).optional(),
});
export type ProseQuestionResolutionRequest = z.infer<typeof proseQuestionResolutionRequestSchema>;

/** What the Runtime reports after recording a resolution; it never claims a conversation resumed. */
export const proseQuestionResolutionResultSchema = z.strictObject({
  attentionId: z.string().uuid(),
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
  executionId: z.string().uuid(),
  sessionId: z.string().uuid(),
  resolution: proseQuestionResolutionSchema,
  answerText: z.string().nullable(),
  note: z.string().nullable(),
  actor: z.string().min(1),
  /** The recorded states the wait returned to. The provider is gone either way. */
  taskState: z.literal('RUNNING'),
  executionState: z.literal('RUNNING'),
  sessionState: z.literal('EXITED'),
  attentionStatus: z.literal('CLOSED'),
  /** Always false: a prose question has no provider dialog, so no answer is ever delivered. */
  deliveredToProvider: z.literal(false),
  resolvedAt: z.number().int().nonnegative(),
});
export type ProseQuestionResolutionResult = z.infer<typeof proseQuestionResolutionResultSchema>;

/** Current setting plus where it came from, so a client never re-implements the default. */
export const proseQuestionAttentionSettingsSchema = z.strictObject({
  mode: proseQuestionAttentionModeSchema,
  default: proseQuestionAttentionModeSchema,
  appliesTo: z.string().min(1),
});
export type ProseQuestionAttentionSettings = z.infer<typeof proseQuestionAttentionSettingsSchema>;
