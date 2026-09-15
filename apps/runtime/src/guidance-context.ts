import { createHash } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentGuidanceContext } from '@codeestra/contracts';
import { Phase1Database, type SessionGuidanceRecord } from '@codeestra/storage';

/**
 * Materializing the Session Guidance artifact one Execution is launched with (ADR-0057).
 *
 * This module deliberately depends on nothing but storage and the filesystem: both launch paths
 * (the initial `task.run` start and the successor/resume start) use it, and keeping it free of the
 * Runtime services is what lets them share one implementation without an import cycle.
 */
export class GuidanceContextError extends Error {
  constructor(readonly code: 'GUIDANCE_CONTEXT_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'GuidanceContextError';
  }
}

/**
 * Where one Task's materialized guidance artifact lives.
 *
 * It is Runtime data, never a Task worktree file: an untracked file inside a worktree would enter the
 * Task's Git change set, make concurrent Tasks look like they changed the same path, and be staged
 * into the result commit — the same structural argument ADR-0041 D05 makes for machine-generated
 * knowledge. Guidance and knowledge remain two artifacts in two directories, because they say two
 * different things.
 */
export function executionGuidanceRoot(home: string, projectId: string, taskId: string): string {
  return join(home, 'guidance', projectId, taskId);
}

export const guidanceContextFileName = 'guidance-context.md';

/**
 * Renders the guidance records of one Task into the artifact an Execution is launched with.
 *
 * The rendering is a pure function of the records (id, actor, time, body), so the same recorded
 * guidance always produces the same bytes and the digest an Adapter verifies is reproducible.
 */
export function renderGuidanceContext(records: readonly SessionGuidanceRecord[]): string {
  const lines = [
    '# Codeestra Session Guidance',
    '',
    'Session guidance the user gave to this Task\'s conversation. It shapes **how** the work is done',
    'and is not a specification revision: the acceptance criteria are unchanged, and no verification',
    'was invalidated by it. `task amend` is the only path that changes the specification.',
    '',
  ];
  for (const record of records) {
    lines.push(
      `## Guidance ${record.id}`,
      '',
      `recorded ${new Date(record.createdAt).toISOString()} by ${record.actor}`,
      '',
      record.body.trim(),
      '',
    );
  }
  return lines.join('\n');
}

/**
 * Materializes the guidance artifact one Execution is launched with and records that this Execution
 * was launched with it.
 *
 * Two rules mirror ADR-0051's knowledge handover:
 *
 * 1. **No guidance means no artifact.** A Task with no guidance record yields `{}`, so its controlled
 *    launch stays byte-identical to the launch before this capability.
 * 2. **Recorded guidance without a Runtime home is a refusal.** Handing the Adapter nothing while the
 *    ledger says the Task has guidance would silently turn "the Agent was told what the user
 *    recorded" into a false statement.
 */
export async function guidanceContextForExecution(input: {
  readonly storage: Phase1Database;
  readonly runtimeHome: string | undefined;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
}): Promise<{ readonly guidanceContext?: AgentGuidanceContext }> {
  const records = input.storage.listSessionGuidance(input.projectId, input.taskId);
  if (records.length === 0) return {};
  if (input.runtimeHome === undefined) {
    throw new GuidanceContextError('GUIDANCE_CONTEXT_UNAVAILABLE',
      `Task ${input.taskId} has ${records.length} recorded session guidance message(s) but no Runtime`
      + ' home was supplied, so the materialized artifact cannot be located; refusing to start an'
      + ' Agent without the guidance the Task recorded');
  }
  const root = resolve(executionGuidanceRoot(input.runtimeHome, input.projectId, input.taskId));
  const filePath = resolve(root, guidanceContextFileName);
  const inside = relative(root, filePath);
  if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) {
    throw new GuidanceContextError('GUIDANCE_CONTEXT_UNAVAILABLE',
      'The guidance artifact path is outside this Runtime\'s guidance directory, so it is not a'
      + ' Runtime-owned artifact');
  }
  const text = renderGuidanceContext(records);
  const existing = await lstat(filePath).catch(() => null);
  if (existing !== null && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new GuidanceContextError('GUIDANCE_CONTEXT_UNAVAILABLE',
      `${guidanceContextFileName} exists and is not a regular file; refusing to overwrite it`);
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, text, 'utf8');
  const encoded = Buffer.from(text, 'utf8');
  const digest = createHash('sha256').update(encoded).digest('hex');
  const guidanceIds = records.map((record) => record.id);
  input.storage.recordExecutionGuidanceContext({
    id: (input.randomUUID ?? (() => crypto.randomUUID()))(),
    projectId: input.projectId,
    taskId: input.taskId,
    executionId: input.executionId,
    guidanceIds,
    contextPath: filePath,
    contextDigest: digest,
    contextBytes: encoded.length,
    recordedAt: (input.now ?? Date.now)(),
  });
  return { guidanceContext: { filePath, digest, bytes: encoded.length, guidanceIds } };
}
