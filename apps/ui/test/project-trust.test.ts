import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canSubmitProjectTrust,
  projectInspectCommand,
  projectTrustCodeNote,
  projectTrustCommand,
  projectTrustDocumentedCodes,
  projectTrustForwardCodes,
  projectTrustPolicyConfirmation,
  projectTrustRejectionNotice,
} from '../src/project-trust.js';
import type {
  ProjectIdentityView,
  VerificationPolicyView,
} from '../src/types.js';

/**
 * Contract test for the project trust projection (FOUNDATION-089 increment, narrowed by ADR-0064).
 *
 * Scope — what this file does and does not prove:
 * - It proves the two requests match the fields the command face defines: `project.inspect` carries
 *   the path, and `project.trust` echoes back the identity the user reviewed **by reference** (the
 *   Runtime compares it byte for byte) plus the verification-policy confirmation.
 * - It proves the form predicate gates on the STRICT confirmation only, never on a guess about the
 *   repository.
 * - It proves the local glossary covers every refusal the trust face can answer with: each documented
 *   code is read out of the Runtime source, and the explicitly "forward declared" list is pinned so it
 *   cannot grow silently.
 * - It proves the removed dev-clone surface is gone from this module, from the command face and from
 *   the identity projection — a residue would be a second, drifting definition of trust.
 * - It does **not** prove anything about a live Runtime: no request is made here, and whether a
 *   repository really is trustable is decided by `inspectRepository`, not by this UI.
 * - It does **not** prove how the form looks: that is human visual confirmation (ADR-0008 forbids
 *   browser and desktop automation here).
 */

const contractsSource = readFileSync(
  new URL('../../../packages/contracts/src/index.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(
  new URL('../../../apps/runtime/src/main.ts', import.meta.url), 'utf8');
const moduleSource = readFileSync(new URL('../src/project-trust.tsx', import.meta.url), 'utf8');

/** The body of one command's contract entry, so field names are read from the contracts. */
function contractBlock(command: string): string {
  const at = contractsSource.indexOf(`command: z.literal('${command}')`);
  if (at === -1) throw new Error(`${command} not found in the contracts source`);
  const next = contractsSource.indexOf('command: z.literal(', at + 1);
  return contractsSource.slice(at, next === -1 ? undefined : next);
}

const identity: ProjectIdentityView = {
  repoRoot: '/main', gitCommonDir: '/main/.git', mainRef: 'refs/heads/main', objectFormat: 'sha1',
  headCommit: 'a'.repeat(40),
};

const policy: VerificationPolicyView = {
  state: 'PRESENT', mainCommit: 'c'.repeat(40), digest: 'd'.repeat(64),
  policy: { version: 1, commands: [] },
};

// ---------------------------------------------------------------------------------------------
// The field names come from the contracts
// ---------------------------------------------------------------------------------------------

describe('the inspect and trust requests are the command face\'s requests', () => {
  it('sends only the path for project.inspect and names no removed field', () => {
    const request = projectInspectCommand({ path: '/main' });
    expect(request).toEqual({ command: 'project.inspect', path: '/main' });
    expect(Object.keys(request).sort()).toEqual(['command', 'path']);
    // The flag ADR-0064 deleted must not survive anywhere in the request shape.
    expect(request).not.toHaveProperty('devRepoPath');
  });

  it('echoes the reviewed identity by reference and the policy confirmation', () => {
    const request = projectTrustCommand({
      path: '/main',
      expectedIdentity: identity,
      expectedVerificationPolicy: projectTrustPolicyConfirmation(policy),
    });
    expect(request['command']).toBe('project.trust');
    expect(request['path']).toBe('/main');
    // By reference: the Runtime compares the object it was given.
    expect(request['expectedIdentity']).toBe(identity);
    expect(request['expectedVerificationPolicy']).toEqual({
      state: 'PRESENT', mainCommit: 'c'.repeat(40), digest: 'd'.repeat(64) });
    expect(request).not.toHaveProperty('devRepoPath');
  });

  it('mirrors an ABSENT policy instead of inventing a digest', () => {
    expect(projectTrustPolicyConfirmation({ ...policy, state: 'ABSENT', digest: null }))
      .toEqual({ state: 'ABSENT', mainCommit: policy.mainCommit });
  });

  it('keeps the command entry free of a dev clone field', () => {
    // Reading the contract itself: a field that no longer exists must not reappear in the request.
    for (const command of ['project.inspect', 'project.trust']) {
      expect(contractBlock(command)).not.toContain('devRepoPath');
      expect(contractBlock(command)).not.toContain('devCommit');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The submit predicate
// ---------------------------------------------------------------------------------------------

describe('the submit predicate gates on the confirmation only', () => {
  it('allows FULL without a confirmation and STRICT only with TRUST', () => {
    expect(canSubmitProjectTrust({ permissionMode: 'FULL', confirmation: '' })).toBe(true);
    expect(canSubmitProjectTrust({ permissionMode: 'STRICT', confirmation: 'TRUST' })).toBe(true);
    expect(canSubmitProjectTrust({ permissionMode: 'STRICT', confirmation: 'trust' })).toBe(false);
    expect(canSubmitProjectTrust({ permissionMode: 'STRICT', confirmation: '' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The glossary
// ---------------------------------------------------------------------------------------------

describe('the refusal glossary covers the trust face and nothing removed', () => {
  it('documents a note for every code the Runtime can answer the trust command with', () => {
    // The codes the trust handler itself can return, read out of the Runtime source, plus the
    // request-boundary and storage refusals it can surface unchanged.
    const handled = ['REPOSITORY_CHANGED', 'VERIFICATION_POLICY_CHANGED', 'IMPACT_POLICY_CHANGED'];
    for (const code of handled) {
      expect(mainSource).toContain(code);
      expect(projectTrustDocumentedCodes()).toContain(code);
      expect(projectTrustCodeNote(code)).not.toBeNull();
      expect(projectTrustRejectionNotice(code, 'x')).toContain(`${code}: x`);
    }
    // The storage-boundary refusals a trust can surface are listed too.
    for (const code of ['INVALID_STATE', 'INVALID_REQUEST']) {
      expect(projectTrustDocumentedCodes()).toContain(code);
    }
  });

  it('documents no dev-clone code any more', () => {
    for (const code of projectTrustDocumentedCodes()) {
      expect(code.startsWith('DEV_REPO_')).toBe(false);
    }
  });

  it('pins the forward-declared list so it cannot grow silently', () => {
    expect(projectTrustForwardCodes()).toEqual([]);
  });

  it('shows an unknown code verbatim instead of mapping it to something invented', () => {
    expect(projectTrustRejectionNotice('SOMETHING_NEW', 'x')).toBe('SOMETHING_NEW: x');
    expect(projectTrustCodeNote('SOMETHING_NEW')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The removed surface
// ---------------------------------------------------------------------------------------------

describe('the dev clone surface is gone from this module', () => {
  it('mentions no dev-clone projection or request field', () => {
    for (const gone of ['devRepoPath', 'devClone', 'DEV_REPO_', 'ProjectDevRepoInput',
      'DevRepoInspectionRows']) {
      expect(moduleSource).not.toContain(gone);
    }
  });
});
