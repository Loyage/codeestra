import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentGuidanceContext } from '@codeestra/contracts';
import { buildClaudeArguments } from '../src/claude-protocol.js';
import { GuidanceContextError, readVerifiedGuidanceContext } from '../src/guidance-context.js';
import { codexDeveloperInstructions } from '../src/codex-guidance.js';

/**
 * What this file proves: the two providers that have **no** live guidance channel still each carry
 * recorded guidance through *their own* launch channel (ADR-0057) — Claude Code through its literal
 * `--append-system-prompt` (knowledge keeps the `-file` flag), Codex through the single
 * `developerInstructions` string its app-server accepts — and that a Task with no guidance adds
 * nothing at all, so those launches stay byte-identical. It also pins the shared artifact
 * verification rule: the file must match the recorded digest, byte count and UTF-8 shape, and the
 * refusal reaches the caller under the guidance-specific stable code.
 *
 * What it does NOT prove: that either provider *reads* what it is given, and that Codex's
 * `turn/steer` works — this Adapter declares `REQUIRES_VALIDATION` precisely because that channel was
 * never validated against a live turn (ADR-0051). No provider process is started here.
 */

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function guidanceContext(text: string): AgentGuidanceContext {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-guidance-'));
  directories.push(directory);
  const filePath = join(directory, 'guidance-context.md');
  writeFileSync(filePath, text);
  const bytes = new TextEncoder().encode(text);
  return {
    filePath,
    digest: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    guidanceIds: ['00000000-0000-4000-8000-0000000000aa'],
  };
}

describe('guidance launch arguments that do not invent a common abstraction', () => {
  test('Claude carries guidance as literal text beside the knowledge file flag, and adds nothing without it', () => {
    const knowledge = guidanceContext('# Project Knowledge\n');
    const providerSessionId = '50000000-0000-4000-8000-000000000005';
    const base = buildClaudeArguments({ permissionMode: 'FULL', sessionId: providerSessionId });
    const withKnowledge = buildClaudeArguments({ permissionMode: 'FULL',
      sessionId: providerSessionId, knowledgeContext: knowledge });
    const withBoth = buildClaudeArguments({ permissionMode: 'FULL', sessionId: providerSessionId,
      knowledgeContext: knowledge, guidancePrompt: 'Use the repo conventions.' });

    // No guidance means the argv is exactly what it was before this capability.
    expect(buildClaudeArguments({ permissionMode: 'FULL', sessionId: providerSessionId,
      guidancePrompt: undefined })).toEqual(base);
    expect(withBoth.slice(0, withKnowledge.length)).toEqual([...withKnowledge]);
    expect(withBoth.slice(withKnowledge.length)).toEqual([
      '--append-system-prompt', 'Use the repo conventions.',
    ]);
    // The two artifacts never share a flag: knowledge is the provider reading a verified file, the
    // guidance is bounded text the Adapter already verified itself.
    expect(withBoth.filter((token) => token === '--append-system-prompt-file')).toHaveLength(1);
  });

  test('Codex composes the two verified artifacts into the one instruction string it accepts', () => {
    expect(codexDeveloperInstructions({ knowledgeText: 'K', guidanceText: 'G' }))
      .toBe('K\n\n# Codeestra Session Guidance\nG');
    // Knowledge without guidance is passed verbatim: a Task that never had guidance sees the exact
    // string it saw before this capability existed.
    expect(codexDeveloperInstructions({ knowledgeText: 'K', guidanceText: null })).toBe('K');
    expect(codexDeveloperInstructions({ knowledgeText: null, guidanceText: 'G' }))
      .toBe('# Codeestra Session Guidance\nG');
    // Nothing recorded means nothing added, which is what keeps the thread parameters unchanged.
    expect(codexDeveloperInstructions({ knowledgeText: null, guidanceText: null })).toBeNull();
  });

  test('the artifact verification accepts the recorded bytes and refuses every mismatch', () => {
    const context = guidanceContext('# Codeestra Session Guidance\n\nBe brief.\n');
    expect(readVerifiedGuidanceContext(context)).toBe('# Codeestra Session Guidance\n\nBe brief.\n');

    expect(() => readVerifiedGuidanceContext({ ...context, digest: 'a'.repeat(64) }))
      .toThrow(GuidanceContextError);
    expect(() => readVerifiedGuidanceContext({ ...context, bytes: context.bytes + 1 }))
      .toThrow(GuidanceContextError);
    expect(() => readVerifiedGuidanceContext({ ...context, filePath: join(context.filePath, '..', 'gone.md') }))
      .toThrow(GuidanceContextError);
    expect(() => readVerifiedGuidanceContext({ ...context, filePath: 'relative/guidance-context.md' }))
      .toThrow(GuidanceContextError);
    try {
      readVerifiedGuidanceContext({ ...context, digest: 'a'.repeat(64) });
    } catch (error) {
      // The stable code is the Adapter's own, not the knowledge one: a caller must be able to tell
      // which artifact was missing.
      expect((error as GuidanceContextError).code).toBe('GUIDANCE_CONTEXT_UNAVAILABLE');
    }
  });
});
