/**
 * Composing the instruction artifacts Codex is launched with (ADR-0051 / ADR-0057).
 *
 * Codex's app-server takes instructions as a **single string** (`thread/start` / `thread/resume`
 * `developerInstructions`, measured from `codex app-server generate-json-schema`), so a Codex
 * Execution that has both Project Knowledge and Session Guidance can only be given one field. The
 * Adapter verifies each artifact separately, keeps each under its own header so the two stay
 * distinguishable inside that field, and never invents a channel Codex does not have.
 *
 * Nothing recorded means no field at all, which is what keeps the thread parameters byte-identical to
 * the launch before these capabilities.
 *
 * The Project Knowledge text is passed verbatim — exactly what a knowledge-only launch sent before
 * this capability — and the guidance, when present, is appended under its own header. That way an
 * Execution with knowledge but no guidance sees the *same* string as before, while a string that does
 * carry guidance can never be mistaken for project knowledge.
 */
export function codexDeveloperInstructions(input: {
  readonly knowledgeText: string | null;
  readonly guidanceText: string | null;
}): string | null {
  if (input.knowledgeText === null && input.guidanceText === null) return null;
  if (input.guidanceText === null) return input.knowledgeText;
  return [
    ...(input.knowledgeText === null ? [] : [input.knowledgeText]),
    `# Codeestra Session Guidance\n${input.guidanceText}`,
  ].join('\n\n');
}
