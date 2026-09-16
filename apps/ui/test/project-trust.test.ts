import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DevRepoInspectionRows,
  ProjectDevRepoInput,
  canSubmitProjectTrust,
  devRepoVerifiedLabel,
  projectDevRepoPathMissing,
  projectInspectCommand,
  projectTrustCodeNote,
  projectTrustCommand,
  projectTrustDocumentedCodes,
  projectTrustForwardCodes,
  projectTrustPolicyConfirmation,
  projectTrustRejectionNotice,
} from '../src/project-trust.js';
import type {
  DevRepoInspectionView,
  ProjectIdentityView,
  VerificationPolicyView,
} from '../src/types.js';

/**
 * Contract test for the dev clone half of the project trust projection (ADR-0047 D05 / ADR-0048,
 * FOUNDATION-089 increment).
 *
 * Scope — what this file does and does not prove:
 * - It proves the trust request carries the field the command face defines (`devRepoPath`), with the
 *   value **as typed**, and that the identity the user reviewed is echoed back by reference — the
 *   Runtime compares it byte for byte, including the dev clone it verified.
 * - It proves a blank dev clone path cannot look like a successful trust: the form predicate refuses
 *   it, the request then omits `devRepoPath` instead of inventing one, and the input states why.
 * - It proves the local glossary covers every code the dev-clone inspection can answer with, read
 *   out of the `DevRepoCode` union in the Runtime source, plus the refusals of the trust face itself.
 *   The one documented code this tree cannot show is pinned in an explicit forward list, so it
 *   cannot grow silently. That list is empty in the integrated tree: FOUNDATION-087 landed in the
 *   same integration, so `DEV_REPO_REQUIRED` is now verified against the Runtime source like every
 *   other code.
 * - It proves the identity rows render the Runtime's own verdict (verified / stable code / detail /
 *   branch / HEAD / dev ref commit / clean / origin) and never colour an unverified clone as success.
 * - It does **not** prove anything about a live Runtime: no request is made here, and whether a path
 *   really is a separate clone of the same origin is decided by `inspectDevRepo`, not by this UI. Its
 *   refusals are the Runtime's own tests.
 * - It does **not** prove how the form looks, whether the two path inputs are distinguishable at a
 *   glance, or how the identity table reflows on a narrow window: those are human visual confirmation
 *   (ADR-0008 forbids browser and desktop automation here).
 */

const contractsSource = readFileSync(
  new URL('../../../packages/contracts/src/index.ts', import.meta.url), 'utf8');
const devRepoSource = readFileSync(
  new URL('../../../apps/runtime/src/dev-repo-service.ts', import.meta.url), 'utf8');
const mainSource = readFileSync(
  new URL('../../../apps/runtime/src/main.ts', import.meta.url), 'utf8');
const storageSource = readFileSync(
  new URL('../../../packages/storage/src/database.ts', import.meta.url), 'utf8');
const cliSource = readFileSync(
  new URL('../../../apps/cli/src/main.ts', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
const moduleSource = readFileSync(new URL('../src/project-trust.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

/** The body of one command's contract entry, so field names are read from the contracts. */
function contractBlock(command: string): string {
  const at = contractsSource.indexOf(`command: z.literal('${command}')`);
  if (at === -1) throw new Error(`${command} not found in the contracts source`);
  const next = contractsSource.indexOf('command: z.literal(', at + 1);
  return contractsSource.slice(at, next === -1 ? undefined : next);
}

/** The field names of one `export const … = z.strictObject({…})` schema. */
function schemaKeys(name: string): readonly string[] {
  const body = new RegExp(`export const ${name} = z\\.strictObject\\(\\{([\\s\\S]*?)\\n\\}\\);`)
    .exec(contractsSource);
  if (body === null) throw new Error(`${name} not found`);
  return [...(body[1] ?? '').matchAll(/^\s{2}(\w+):/gm)].map((match) => match[1] as string);
}

/** The field names of one `export interface …View {…}` declared in the UI types. */
function interfaceKeys(name: string): readonly string[] {
  const body = new RegExp(`export interface ${name}(?: extends \\w+)? \\{([\\s\\S]*?)\\n\\}`)
    .exec(typesSource);
  if (body === null) throw new Error(`${name} not found in the UI types`);
  return [...(body[1] ?? '').matchAll(/readonly (\w+):/g)].map((match) => match[1] as string);
}

/** The dev-clone refusal codes the Runtime declares. */
function devRepoCodes(): readonly string[] {
  const body = /export type DevRepoCode =([\s\S]*?);/.exec(devRepoSource);
  if (body === null) throw new Error('DevRepoCode not found');
  return [...(body[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((match) => match[1] as string);
}

const identity: ProjectIdentityView = {
  repoRoot: '/main', gitCommonDir: '/main/.git', mainRef: 'refs/heads/main', objectFormat: 'sha1',
  headCommit: 'a'.repeat(40), devRef: 'refs/heads/dev', devCommit: 'b'.repeat(40),
  devRefPresent: true, devRepoPath: null,
};

const policy: VerificationPolicyView = {
  state: 'PRESENT', mainCommit: 'c'.repeat(40), digest: 'd'.repeat(64),
  policy: { version: 1, commands: [] },
};

function inspection(overrides: Partial<DevRepoInspectionView>): DevRepoInspectionView {
  return {
    path: '/dev', devRef: 'refs/heads/dev', verified: true, code: null, detail: null,
    repoRoot: '/dev', gitCommonDir: '/dev/.git', headCommit: 'e'.repeat(40),
    branchRef: 'refs/heads/dev', devRefCommit: 'f'.repeat(40), originUrl: 'git@example.com:repo.git',
    originMatchesProject: true, clean: true,
    ...overrides,
  };
}

function markup(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element);
}

// ---------------------------------------------------------------------------------------------
// The field names come from the contracts
// ---------------------------------------------------------------------------------------------

describe('the dev clone fields are the command face\'s fields', () => {
  it('sends `project.inspect` with the dev clone only when one was typed', () => {
    const withPath = projectInspectCommand({ path: '/main', devRepoPath: '/dev' });
    expect(Object.keys(withPath)).toEqual(['command', 'path', 'devRepoPath']);
    expect(withPath.command).toBe('project.inspect');
    expect(withPath.devRepoPath).toBe('/dev');
    // Blank means "no candidate clone to inspect", which is the CLI's behaviour without --dev-repo.
    for (const blank of ['', '   ']) {
      const without = projectInspectCommand({ path: '/main', devRepoPath: blank });
      expect(Object.keys(without)).toEqual(['command', 'path']);
    }
  });

  it('sends `project.trust` with the dev clone, the reviewed identity and the policy', () => {
    const request = projectTrustCommand({
      path: '/main', expectedIdentity: identity, devRepoPath: '/dev',
      expectedVerificationPolicy: projectTrustPolicyConfirmation(policy),
    });
    expect(Object.keys(request)).toEqual(
      ['command', 'path', 'expectedIdentity', 'devRepoPath', 'expectedVerificationPolicy']);
    expect(request.command).toBe('project.trust');
    expect(request.devRepoPath).toBe('/dev');
    // The identity is echoed by reference: the Runtime compares it byte for byte.
    expect(request.expectedIdentity).toBe(identity);
    expect(request.expectedVerificationPolicy).toEqual({
      state: 'PRESENT', mainCommit: policy.mainCommit, digest: policy.digest,
    });
  });

  it('passes the value through as typed, and omits it when the field is blank', () => {
    // A path is a fact of the file system: this client does not normalise or "repair" it. Whatever
    // the user typed is what the Runtime verifies, exactly like the CLI's argv.
    const padded = projectTrustCommand({
      path: '/main', expectedIdentity: identity, devRepoPath: '  /dev/clone  ',
      expectedVerificationPolicy: projectTrustPolicyConfirmation(policy),
    });
    expect(padded.devRepoPath).toBe('  /dev/clone  ');
    const blank = projectTrustCommand({
      path: '/main', expectedIdentity: identity, devRepoPath: '   ',
      expectedVerificationPolicy: projectTrustPolicyConfirmation(policy),
    });
    expect(Object.keys(blank)).toEqual(
      ['command', 'path', 'expectedIdentity', 'expectedVerificationPolicy']);
  });

  it('mirrors the verification-policy state instead of re-describing it', () => {
    expect(projectTrustPolicyConfirmation(policy)).toEqual({
      state: 'PRESENT', mainCommit: policy.mainCommit, digest: policy.digest,
    });
    expect(projectTrustPolicyConfirmation({ ...policy, digest: null })).toEqual({
      state: 'PRESENT', mainCommit: policy.mainCommit, digest: null,
    });
    const absent = projectTrustPolicyConfirmation({
      state: 'ABSENT', mainCommit: policy.mainCommit, digest: null, policy: null,
    });
    expect(absent).toEqual({ state: 'ABSENT', mainCommit: policy.mainCommit });
    expect(Object.keys(absent)).not.toContain('digest');
  });

  it('agrees with the contracts about every field it sends', () => {
    // `project.inspect`: the main path plus an optional candidate dev clone (ADR-0047 D05).
    const inspect = contractBlock('project.inspect');
    expect(inspect).toContain('path: z.string().min(1)');
    expect(inspect).toContain('devRepoPath: z.string().min(1).nullable().optional()');
    // `project.trust`: the reviewed identity, the policy confirmation, and the dev clone to record.
    const trust = contractBlock('project.trust');
    for (const field of ['path', 'expectedIdentity', 'devRepoPath', 'expectedVerificationPolicy',
      'expectedImpactPolicy']) {
      expect(trust).toContain(field);
    }
    expect(trust).toContain('expectedIdentity: projectIdentitySchema');
    expect(trust).toContain('devRepoPath: z.string().min(1).nullable().optional()');
    // The CLI takes the same fact from `--dev-repo`, and `--dev-repo none` is the explicit clear.
    expect(cliSource).toContain("if (token === '--dev-repo')");
    expect(cliSource).toContain("devRepoPath = value === 'none' ? null : value;");
    expect(cliSource).toContain('...(devRepoPath === undefined ? {} : { devRepoPath })');
  });

  it('keeps the inspection type and the identity type in step with their schemas', () => {
    expect([...interfaceKeys('DevRepoInspectionView')].sort())
      .toEqual([...schemaKeys('devRepoInspectionSchema')].sort());
    // The identity is the schema the trust compares against, so its dev fields must be mirrored too.
    for (const field of ['devRef', 'devCommit', 'devRefPresent', 'devRepoPath']) {
      expect(contractsSource).toContain(field);
      expect(interfaceKeys('ProjectIdentityView')).toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// A blank path means "no dev clone" (ADR-0060), and the form says so
// ---------------------------------------------------------------------------------------------

describe('a blank dev clone path means a managed project, not a failed trust', () => {
  it('treats a blank path as "no dev clone" and lets the form be submitted', () => {
    expect(projectDevRepoPathMissing('')).toBe(true);
    expect(projectDevRepoPathMissing('   ')).toBe(true);
    expect(projectDevRepoPathMissing('/dev')).toBe(false);
    expect(projectDevRepoPathMissing('  /dev  ')).toBe(false);
    // ADR-0060: the dev clone is optional, so only the STRICT declaration gates submission.
    const cases: readonly [('FULL' | 'STRICT'), string, string, boolean][] = [
      ['FULL', '', '/dev', true],
      ['FULL', '', '', true],
      ['FULL', '', '   ', true],
      ['STRICT', 'TRUST', '/dev', true],
      ['STRICT', 'TRUST', '', true],
      ['STRICT', 'TRUST', '   ', true],
      ['STRICT', '', '/dev', false],
      ['STRICT', 'trust', '/dev', false],
    ];
    for (const [permissionMode, confirmation, devRepoPath, expected] of cases) {
      expect(canSubmitProjectTrust({ permissionMode, confirmation, devRepoPath }))
        .toBe(expected);
    }
    // The App's button uses exactly this predicate, so no separate rule can drift from it.
    expect(appSource).toContain('canSubmitProjectTrust({ permissionMode, confirmation, devRepoPath })');
  });

  it('states what a blank field means, in the form itself', () => {
    const blank = markup(createElement(ProjectDevRepoInput, {
      value: '', busy: false, onChange: () => {},
    }));
    expect(blank).toContain('data-project-trust="dev-repo-missing"');
    expect(blank).toContain('留空 = 这个项目没有 dev clone');
    expect(blank).toContain('DEV_REPO_REQUIRED');
    const filled = markup(createElement(ProjectDevRepoInput, {
      value: '/dev', busy: false, onChange: () => {},
    }));
    expect(filled).not.toContain('data-project-trust="dev-repo-missing"');
    for (const html of [blank, filled]) {
      // The field names the CLI flag it corresponds to and where the value goes, and it no longer
      // claims to be a required input (ADR-0060).
      expect(html).toContain('--dev-repo');
      expect(html).toContain('devRepoPath');
      expect(html).toContain('可留空');
      expect(html).not.toContain('**');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The glossary, read out of the sources that can answer with these codes
// ---------------------------------------------------------------------------------------------

describe('the refusal glossary covers the dev-clone codes and the trust face', () => {
  it('documents every code in the Runtime\'s DevRepoCode union', () => {
    const codes = devRepoCodes();
    expect(codes).toContain('DEV_REPO_NOT_SEPARATE');
    expect(codes).toContain('DEV_REPO_ORIGIN_MISMATCH');
    expect(codes.length).toBeGreaterThanOrEqual(7);
    for (const code of codes) {
      expect(projectTrustDocumentedCodes()).toContain(code);
      const note = projectTrustCodeNote(code);
      expect(note).not.toBeNull();
      expect((note ?? '').length).toBeGreaterThan(8);
      expect(note).not.toBe(code);
      expect(projectTrustRejectionNotice(code, 'x')).toContain(`${code}: x`);
    }
  });

  it('documents the trust-face refusals the Runtime returns before it writes anything', () => {
    for (const [code, source] of [
      ['REPOSITORY_CHANGED', mainSource], ['DEV_REF_MISSING', mainSource],
      ['VERIFICATION_POLICY_CHANGED', mainSource], ['IMPACT_POLICY_CHANGED', mainSource],
      ['INVALID_STATE', storageSource], ['INVALID_REQUEST', mainSource],
    ] as const) {
      expect(source).toContain(`'${code}'`);
      expect(projectTrustDocumentedCodes()).toContain(code);
    }
  });

  it('keeps no unverifiable code: every documented code is grounded in a source', () => {
    const sources = [contractsSource, devRepoSource, mainSource, storageSource, cliSource].join('\n');
    const forward = projectTrustForwardCodes();
    // FOUNDATION-087 (ADR-0056) landed in the same integration as this UI, so `DEV_REPO_REQUIRED`
    // is no longer a forward declaration: it is grounded in `apps/runtime/src/main.ts` and
    // `dev-repo-service.ts`, and the loop below proves it like every other code.
    expect(forward).toEqual([]);
    expect(projectTrustCodeNote('DEV_REPO_REQUIRED')).not.toBeNull();
    for (const code of projectTrustDocumentedCodes()) {
      expect(sources).toContain(`'${code}'`);
    }
  });

  it('keeps the stable code verbatim and never invents one for an unknown code', () => {
    const notice = projectTrustRejectionNotice('DEV_REPO_NOT_SEPARATE', 'a worktree of the main checkout');
    expect(notice).toContain('DEV_REPO_NOT_SEPARATE: a worktree of the main checkout');
    expect(notice).toContain('第二个独立 clone');
    expect(projectTrustRejectionNotice('SOMETHING_NEW', 'x')).toBe('SOMETHING_NEW: x');
    expect(projectTrustCodeNote('SOMETHING_NEW')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The identity review, including the dev clone the user is about to record
// ---------------------------------------------------------------------------------------------

describe('the identity review shows the dev clone verdict verbatim', () => {
  it('renders a verified clone with the facts the verification read', () => {
    const html = markup(createElement(DevRepoInspectionRows, { inspection: inspection({}) }));
    expect(html).toContain('dev clone（这次会记录）');
    expect(html).toContain('/dev');
    expect(html).toContain('data-dev-repo-verified="true"');
    expect(html).toContain('已核验');
    expect(html).toContain('state-ready');
    expect(html).toContain('refs/heads/dev');
    expect(html).toContain('工作树干净 是');
    expect(html).toContain('origin 与主检出相同 是');
    expect(html).toContain('git@example.com:repo.git');
    expect(devRepoVerifiedLabel(inspection({}))).toContain('已核验');
  });

  it('renders an unverified clone as a refusal with its code and the local note', () => {
    const unverified = inspection({
      verified: false, code: 'DEV_REPO_NOT_SEPARATE',
      detail: '/dev is a worktree of the main checkout /main',
      clean: null, originMatchesProject: null,
    });
    const html = markup(createElement(DevRepoInspectionRows, { inspection: unverified }));
    expect(html).toContain('data-dev-repo-verified="false"');
    expect(html).toContain('state-failed');
    expect(html).not.toContain('state-ready');
    expect(html).toContain('DEV_REPO_NOT_SEPARATE');
    expect(html).toContain('同一个 origin 的第二个独立 clone');
    expect(html).toContain('/dev is a worktree of the main checkout /main');
    expect(devRepoVerifiedLabel(unverified)).toContain('未通过核验');
    // The facts the check could still read are shown with an explicit "not established" wording.
    expect(html).toContain('未核验');
  });

  it('says a trust without a dev clone path needs one', () => {
    const html = markup(createElement(DevRepoInspectionRows, { inspection: null }));
    expect(html).toContain('dev clone（这次会记录）');
    expect(html).toContain('未指定');
    expect(html).toContain('信任需要它');
    expect(html).not.toContain('state-ready');
  });

  it('renders no path or ref of its own: every fact comes from the record', () => {
    // The only branch name in this module is the one inside a glossary sentence about the code
    // `DEV_REPO_DEV_REF_MISSING`; no path or ref the components render is written here.
    expect(moduleSource).not.toContain("startsWith('/')");
    expect(moduleSource).not.toContain('repoRoot =');
    expect(moduleSource).not.toContain('branchRef =');
  });
});
