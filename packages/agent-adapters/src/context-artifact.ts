import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * Reading the Runtime-materialized context artifacts an Execution is launched with.
 *
 * Two artifacts are handed to a provider this way and they say different things: Project Knowledge
 * (what the project declares, ADR-0041/0051) and Session Guidance (what the user just told this
 * conversation, ADR-0057). The Runtime renders each of them into a file inside *its own* data
 * directory, records the exact bytes, and passes the absolute path plus digest and byte count.
 *
 * The verification rule is identical and lives here once, while each artifact keeps its own stable
 * refusal code: the Adapter is the last component before a provider process sees the artifact, so a
 * missing file, a symlink, a directory, a digest or byte-count mismatch, or content that is not
 * valid UTF-8 all refuse the launch. The alternative — starting the Agent with less input than its
 * Execution recorded — would silently turn "this Agent was told K" into a false statement.
 *
 * Nothing here writes, moves or deletes anything, and nothing here ever points inside a Task
 * worktree.
 */
export interface ContextArtifact {
  /** Absolute path of the artifact in the Runtime data directory. */
  readonly filePath: string;
  /** Digest of exactly the bytes the file must contain. */
  readonly digest: string;
  /** Size in bytes the file must have; a mismatch is a refusal, not a truncation. */
  readonly bytes: number;
}

/**
 * Reads one recorded context artifact and returns the exact text it holds, or refuses through the
 * caller's own refusal constructor (`fail`), which is where the artifact-specific stable code lives.
 *
 * The digest is computed over the raw bytes on disk, so a caller that hands the provider the path
 * (Pi, Claude's `-file` flag) and a caller that inlines the verified text (Claude's plain flag, Codex's
 * `developerInstructions`) both act on bytes that were checked.
 */
export function readVerifiedContextArtifact(
  artifact: ContextArtifact,
  fail: (message: string) => Error,
): string {
  if (!isAbsolute(artifact.filePath)) {
    throw fail('The recorded context path is not absolute, so it cannot be checked against the'
      + ' Runtime data directory');
  }
  let stats;
  try {
    stats = lstatSync(artifact.filePath);
  } catch {
    throw fail('The recorded context file does not exist; the Execution cannot be started with the'
      + ' context it is bound to');
  }
  if (stats.isSymbolicLink()) {
    throw fail('The recorded context path is a symbolic link, which a Runtime-owned artifact never is');
  }
  if (!stats.isFile()) {
    throw fail('The recorded context path is not a plain file');
  }
  const bytes = readFileSync(artifact.filePath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== artifact.digest) {
    throw fail(`The recorded context digest ${artifact.digest.slice(0, 12)} does not match the file`
      + ` content ${digest.slice(0, 12)}`);
  }
  if (bytes.length !== artifact.bytes) {
    throw fail(`The recorded context is ${artifact.bytes} bytes but the file is ${bytes.length}`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw fail('The recorded context is not valid UTF-8, so it cannot be handed to a provider as'
      + ' text');
  }
}
