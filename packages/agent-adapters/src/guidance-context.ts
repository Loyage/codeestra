import type { AgentGuidanceContext } from '@codeestra/contracts';
import { readVerifiedContextArtifact } from './context-artifact.js';

/**
 * Reading the Session Guidance artifact one Execution is launched with (ADR-0057).
 *
 * Guidance and Project Knowledge reach a provider through the same *kind* of mechanism — a
 * Runtime-owned file whose bytes were recorded — but they are different facts and never share a file:
 * knowledge is what the project declares (ADR-0041), guidance is what the user just told a running
 * conversation. The Runtime renders the guidance records of the Task into this artifact inside its own
 * data directory, never into a Task worktree, and records the exact bytes.
 *
 * An Adapter that receives a `guidanceContext` must verify it here before anything is spawned. A
 * missing file, a symlink, a directory, a digest or byte-count mismatch, or content that is not UTF-8
 * refuses the launch with `GUIDANCE_CONTEXT_UNAVAILABLE` — starting the Agent with less input than the
 * Runtime recorded would silently make "the Agent was told what the user recorded" false.
 */
export const guidanceContextUnavailableCode = 'GUIDANCE_CONTEXT_UNAVAILABLE' as const;

export class GuidanceContextError extends Error {
  constructor(readonly code: typeof guidanceContextUnavailableCode, message: string) {
    super(message);
    this.name = 'GuidanceContextError';
  }
}

export function guidanceContextUnavailable(message: string): GuidanceContextError {
  return new GuidanceContextError(guidanceContextUnavailableCode, message);
}

/** Reads the recorded guidance context and returns its exact text. */
export function readVerifiedGuidanceContext(context: AgentGuidanceContext): string {
  return readVerifiedContextArtifact(context, guidanceContextUnavailable);
}
