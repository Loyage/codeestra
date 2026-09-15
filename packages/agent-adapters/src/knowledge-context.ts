import type { AgentKnowledgeContext } from '@codeestra/contracts';
import { readVerifiedContextArtifact } from './context-artifact.js';

/**
 * Reading the Project Knowledge artifact one Execution is bound to (ADR-0041 D05, ADR-0051).
 *
 * The Runtime materializes one Markdown file per Execution inside its **own data directory** and
 * records the exact bytes with the Execution's knowledge binding. This module is deliberately
 * fail-closed — the shared verification rule lives in `context-artifact.ts` — so a missing file, a
 * symlink, a size or digest mismatch, or content that is not UTF-8 all refuse the start. The
 * alternative, starting the Agent with less input than its Execution recorded, would silently turn
 * "this Execution used knowledge K" into a false statement, which is exactly what ADR-0041 D04
 * forbids.
 *
 * Nothing here writes, moves or deletes anything: the artifact belongs to the Runtime, and a machine
 * cannot overwrite human knowledge (ADR-0041 D02) or reach into a Task worktree (ADR-0041 D05).
 */
export const knowledgeContextUnavailableCode = 'KNOWLEDGE_CONTEXT_UNAVAILABLE' as const;

export class KnowledgeContextError extends Error {
  constructor(readonly code: typeof knowledgeContextUnavailableCode, message: string) {
    super(message);
    this.name = 'KnowledgeContextError';
  }
}

export function knowledgeContextUnavailable(message: string): KnowledgeContextError {
  return new KnowledgeContextError(knowledgeContextUnavailableCode, message);
}

/**
 * Reads the recorded knowledge context and returns its exact text.
 *
 * The digest is computed over the raw bytes on disk and compared with the digest the Execution
 * recorded, so a caller that hands the path to a provider (where the provider reads the file itself)
 * and a caller that inlines the text both act on verified bytes.
 */
export function readVerifiedKnowledgeContext(context: AgentKnowledgeContext): string {
  return readVerifiedContextArtifact(context, knowledgeContextUnavailable);
}
