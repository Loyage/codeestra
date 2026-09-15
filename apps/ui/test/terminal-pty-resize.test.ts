import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ptyResizeFact } from '../src/terminal.js';

/**
 * Contract test for the terminal panel's `ptyResize` projection (ADR-0026).
 *
 * Scope — what this file does and does not prove:
 * - It proves the window row no longer hard-codes a capability: the sentence always quotes the
 *   `ptyResize` value the command face returned, so the panel cannot say 「支持」 next to an
 *   `UNSUPPORTED` matrix (or the old reverse: 「不支持」 next to a matrix that says `IMPLEMENTED`).
 * - It proves every value of the shared capability vocabulary has a sentence, that only the values
 *   meaning "implemented" read as working, and that an unknown value is **not** interpreted at all.
 * - It does **not** prove which value the Runtime reports (that is the Runtime's platform-dependent
 *   fact, exercised by its own handoff/PTY tests), nor how the row looks in a browser — human visual
 *   confirmation (ADR-0008 forbids browser and desktop automation here).
 */

const terminalSource = readFileSync(new URL('../src/terminal.tsx', import.meta.url), 'utf8');

/** The capability vocabulary, read from the view types so a new value cannot be missed. */
function capabilityValues(): readonly string[] {
  const types = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
  const union = /export type SessionHandoffCapabilityView =([\s\S]*?);/.exec(types);
  if (union === null) throw new Error('SessionHandoffCapabilityView not found');
  return [...(union[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1] as string);
}

describe('the window row reports the capability it was given, never a substitute', () => {
  it('quotes the wire value in every sentence', () => {
    for (const value of capabilityValues()) {
      expect(ptyResizeFact(value)).toContain(value);
    }
    // `SUPPORTED` is handled too: the contract union is `IMPLEMENTED|UNSUPPORTED|PARTIAL|UNVERIFIED`,
    // but a client that only knew this one word must still quote it rather than fall silent.
    expect(ptyResizeFact('SUPPORTED')).toContain('SUPPORTED');
  });

  it('lets only the implemented values read as working', () => {
    expect(ptyResizeFact('IMPLEMENTED')).toContain('可以改变');
    expect(ptyResizeFact('UNSUPPORTED')).toContain('不能改变');
    expect(ptyResizeFact('UNSUPPORTED')).not.toContain('可以改变');
    expect(ptyResizeFact('PARTIAL')).toContain('部分平台');
    expect(ptyResizeFact('PARTIAL')).not.toContain('不能改变');
    expect(ptyResizeFact('UNVERIFIED')).toContain('尚未验证');
  });

  it('draws no conclusion for a value outside the vocabulary', () => {
    const sentence = ptyResizeFact('SOMETHING_NEW');
    expect(sentence).toContain('SOMETHING_NEW');
    expect(sentence).not.toContain('不能改变');
    expect(sentence).not.toContain('可以改变');
  });

  it('no longer hard-codes the old claim anywhere in the panel source', () => {
    expect(terminalSource).not.toContain('能力矩阵为 UNSUPPORTED');
    expect(terminalSource).not.toContain('resize 不支持');
    // The row reads the capability instead of asserting one.
    expect(terminalSource).toContain('status?.capabilities.ptyResize');
    expect(terminalSource).toContain('ptyResizeFact(ptyResize)');
  });

  it('shows a missing capability as missing rather than as supported or unsupported', () => {
    expect(terminalSource).toContain('命令面没有报告');
  });
});
