import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { AgentKnowledgeContext } from '@codeestra/contracts';

/**
 * Reading the Project Knowledge artifact one Execution is bound to (ADR-0041 D05, ADR-0051).
 *
 * The Runtime materializes one Markdown file per Execution inside its **own data directory** and
 * records the exact bytes with the Execution's knowledge binding. The Adapter is the last component
 * before a provider process sees that knowledge, so this module is deliberately fail-closed: a
 * missing file, a file that is a symlink, a size or digest that does not match the recorded bytes, or
 * content that is not UTF-8 all refuse the start. The alternative — starting the Agent with less
 * input than its Execution recorded — would silently turn "this Execution used knowledge K" into a
 * false statement, which is exactly what ADR-0041 D04 forbids.
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
  if (!isAbsolute(context.filePath)) {
    throw knowledgeContextUnavailable(
      'The recorded knowledge context path is not absolute, so it cannot be checked against the'
      + ' Runtime data directory');
  }
  let stats;
  try {
    stats = lstatSync(context.filePath);
  } catch {
    throw knowledgeContextUnavailable(
      'The recorded knowledge context file does not exist; the Execution cannot be started with the'
      + ' knowledge it is bound to');
  }
  if (stats.isSymbolicLink()) {
    throw knowledgeContextUnavailable(
      'The recorded knowledge context path is a symbolic link, which a Runtime-owned artifact never is');
  }
  if (!stats.isFile()) {
    throw knowledgeContextUnavailable(
      'The recorded knowledge context path is not a plain file');
  }
  const bytes = readFileSync(context.filePath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== context.digest) {
    throw knowledgeContextUnavailable(
      `The recorded knowledge context digest ${context.digest.slice(0, 12)} does not match the file`
      + ` content ${digest.slice(0, 12)}`);
  }
  if (bytes.length !== context.bytes) {
    throw knowledgeContextUnavailable(
      `The recorded knowledge context is ${context.bytes} bytes but the file is ${bytes.length}`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw knowledgeContextUnavailable(
      'The recorded knowledge context is not valid UTF-8, so it cannot be handed to a provider as text');
  }
}
