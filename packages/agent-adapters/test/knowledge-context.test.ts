import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentKnowledgeContext } from '@codeestra/contracts';
import {
  KnowledgeContextError,
  knowledgeContextUnavailableCode,
  readVerifiedKnowledgeContext,
} from '../src/knowledge-context.js';

/**
 * The Adapter-side boundary for Project Knowledge (ADR-0051).
 *
 * These tests are about the *refusal* rules, because they are what keeps "this Execution ran with
 * knowledge K" true: a context the Adapter cannot read at the recorded digest must stop the launch,
 * never quietly become a launch with less input.
 */
const directories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writeContext(prefix: string, text: string): AgentKnowledgeContext {
  const directory = temporaryDirectory(prefix);
  const filePath = join(directory, 'knowledge-context.md');
  Bun.write(filePath, text);
  const bytes = new TextEncoder().encode(text);
  return {
    filePath,
    digest: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

describe('knowledge context verification', () => {
  test('returns the exact recorded text when path, digest and size all match', () => {
    const text = '# Project knowledge\n\nlayer: instructions | digest: abc\n\nthe body\n';
    const context = writeContext('codeestra-knowledge-ok-', text);
    expect(readVerifiedKnowledgeContext(context)).toBe(text);
  });

  test('refuses a missing file instead of starting with less knowledge', () => {
    const text = 'body\n';
    const context = writeContext('codeestra-knowledge-missing-', text);
    rmSync(context.filePath);
    expect(() => readVerifiedKnowledgeContext(context)).toThrow(KnowledgeContextError);
    try {
      readVerifiedKnowledgeContext(context);
    } catch (error) {
      expect((error as KnowledgeContextError).code).toBe(knowledgeContextUnavailableCode);
      expect((error as Error).message).toContain('does not exist');
    }
  });

  test('refuses content whose digest differs from the Execution record', () => {
    const context = writeContext('codeestra-knowledge-digest-', 'recorded body\n');
    Bun.write(context.filePath, 'a different body\n');
    expect(() => readVerifiedKnowledgeContext(context)).toThrow(/does not match the file content/);
  });

  test('refuses a size that differs from the record even when the digest is right', () => {
    const context = writeContext('codeestra-knowledge-size-', 'body\n');
    expect(() => readVerifiedKnowledgeContext({ ...context, bytes: context.bytes + 1 }))
      .toThrow(/bytes but the file is/);
  });

  test('refuses a relative path, a directory and a symlink', () => {
    const context = writeContext('codeestra-knowledge-shape-', 'body\n');
    expect(() => readVerifiedKnowledgeContext({ ...context, filePath: 'knowledge-context.md' }))
      .toThrow(/not absolute/);
    const directory = temporaryDirectory('codeestra-knowledge-dir-');
    expect(() => readVerifiedKnowledgeContext({ ...context, filePath: directory }))
      .toThrow(/not a plain file/);
    const linkPath = join(temporaryDirectory('codeestra-knowledge-link-'), 'link.md');
    symlinkSync(context.filePath, linkPath);
    expect(() => readVerifiedKnowledgeContext({ ...context, filePath: linkPath }))
      .toThrow(/symbolic link/);
  });

  test('refuses bytes that are not UTF-8 text', () => {
    const directory = temporaryDirectory('codeestra-knowledge-utf8-');
    const filePath = join(directory, 'knowledge-context.md');
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
    Bun.write(filePath, bytes);
    const context = {
      filePath,
      digest: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    };
    expect(() => readVerifiedKnowledgeContext(context)).toThrow(/not valid UTF-8/);
    // The directory itself must not be treated as knowledge either.
    mkdirSync(join(directory, 'nested'), { recursive: true });
  });
});
