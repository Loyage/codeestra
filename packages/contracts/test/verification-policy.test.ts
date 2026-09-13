import { describe, expect, test } from 'bun:test';
import {
  VerificationPolicyError,
  parseVerificationPolicy,
  verificationPolicyDigest,
  verificationPolicyLabel,
} from '../src/index.js';

describe('verification policy parsing', () => {
  test('applies the working directory and timeout defaults', () => {
    const policy = parseVerificationPolicy(JSON.stringify({
      version: 1,
      commands: [{ id: 'check', argv: ['bun', 'run', 'check'] }],
    }));
    expect(policy.commands).toEqual([
      { id: 'check', argv: ['bun', 'run', 'check'], cwd: '.', timeoutSeconds: 900 },
    ]);
  });

  test('rejects unknown keys, duplicate IDs, empty command lists, and oversized budgets', () => {
    const bad = [
      '{"version":1,"commands":[{"id":"a","argv":["echo"],"shell":true}]}',
      '{"version":1,"commands":[{"id":"a","argv":["echo"]},{"id":"a","argv":["echo"]}]}',
      '{"version":1,"commands":[]}',
      '{"version":2,"commands":[{"id":"a","argv":["echo"]}]}',
      '{"version":1,"commands":[{"id":"a","argv":["echo"],"timeoutSeconds":1801}]}',
      '{"version":1,"commands":[{"id":"a","argv":["echo"],"timeoutSeconds":1800},'
        + '{"id":"b","argv":["echo"],"timeoutSeconds":1800},'
        + '{"id":"c","argv":["echo"],"timeoutSeconds":1800}]}',
      '{"version":1,"commands":[{"id":"bad id","argv":["echo"]}]}',
    ];
    for (const text of bad) {
      expect(() => parseVerificationPolicy(text)).toThrow(VerificationPolicyError);
    }
    expect(() => parseVerificationPolicy('not json')).toThrow(VerificationPolicyError);
  });

  test('refuses commands that could escape the verification copy', () => {
    const escapes = [
      '{"version":1,"commands":[{"id":"a","argv":["/bin/sh","-c","rm -rf /"]}]}',
      '{"version":1,"commands":[{"id":"a","argv":["../../evil.sh"]}]}',
      '{"version":1,"commands":[{"id":"a","argv":["~/evil.sh"]}]}',
      '{"version":1,"commands":[{"id":"a","argv":["echo"],"cwd":"/tmp"}]}',
      '{"version":1,"commands":[{"id":"a","argv":["echo"],"cwd":"../outside"}]}',
      '{"version":1,"commands":[{"id":"a","argv":["echo"],"cwd":"~"}]}',
    ];
    for (const text of escapes) {
      expect(() => parseVerificationPolicy(text)).toThrow(VerificationPolicyError);
    }
    // A relative program inside the copy stays allowed: it is resolved against the copy cwd.
    const inside = parseVerificationPolicy(
      '{"version":1,"commands":[{"id":"a","argv":["./scripts/verify.sh"],"cwd":"sub"}]}',
    );
    expect(inside.commands[0]?.argv).toEqual(['./scripts/verify.sh']);
  });
});

describe('verification policy digest', () => {
  const policy = parseVerificationPolicy(JSON.stringify({
    version: 1,
    commands: [{ id: 'check', argv: ['bun', 'run', 'check'] }],
  }));

  test('is a stable content digest over the normalized policy', () => {
    // Pinned so that a change to the hashing contract cannot silently invalidate or
    // preserve previous confirmations unnoticed.
    expect(verificationPolicyDigest(policy))
      .toBe('2afad8dfb1e75b507a82d7a5567cc309dfc512b4c7f08f53a1eaf9705bbc5430');
    expect(verificationPolicyDigest(policy)).toBe(verificationPolicyDigest(policy));
  });

  test('changes when any command, argument, working directory, or timeout changes', () => {
    const variants = [
      '{"version":1,"commands":[{"id":"check","argv":["bun","run","test"]}]}',
      '{"version":1,"commands":[{"id":"check","argv":["bun","run","check"],"cwd":"packages"}]}',
      '{"version":1,"commands":[{"id":"check","argv":["bun","run","check"],"timeoutSeconds":901}]}',
      '{"version":1,"commands":[{"id":"lint","argv":["bun","run","check"]}]}',
    ];
    for (const text of variants) {
      expect(verificationPolicyDigest(parseVerificationPolicy(text)))
        .not.toBe(verificationPolicyDigest(policy));
    }
    // Command order is part of the confirmed meaning, so it is part of the digest.
    const reversed = parseVerificationPolicy(JSON.stringify({
      version: 1,
      commands: [
        { id: 'b', argv: ['echo', 'b'] },
        { id: 'a', argv: ['echo', 'a'] },
      ],
    }));
    const reordered = parseVerificationPolicy(JSON.stringify({
      version: 1,
      commands: [
        { id: 'a', argv: ['echo', 'a'] },
        { id: 'b', argv: ['echo', 'b'] },
      ],
    }));
    expect(verificationPolicyDigest(reversed)).not.toBe(verificationPolicyDigest(reordered));
  });

  test('labels a digest with the policy semantics version', () => {
    expect(verificationPolicyLabel(verificationPolicyDigest(policy)))
      .toBe(`verification-policy-v1#${verificationPolicyDigest(policy).slice(0, 12)}`);
  });
});
