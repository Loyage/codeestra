import type {
  ProjectIdentityView,
  VerificationPolicyView,
} from './types.js';

/**
 * The `project.inspect` / `project.trust` projection this console uses (FOUNDATION-089 increment).
 *
 * Scope of this module — what it is and is not:
 * - ADR-0062 removed the second, independent clone a stable promotion used to push from, so trust no
 *   longer records a path: what a project is, is its repository identity plus the two committed
 *   policies. This module therefore only composes the two requests and explains their refusals.
 * - It echoes back exactly what `project.inspect` returned, so the facts a user reviewed are the facts
 *   the Runtime compares — never a client-side re-derivation of a path or a branch name.
 * - Every refusal is the Runtime's own stable code, displayed verbatim next to a local glossary
 *   sentence that never replaces the code.
 */

/** `project.inspect {path}`: the identity a trust then echoes back. */
export function projectInspectCommand(input: {
  readonly path: string;
}): Record<string, unknown> {
  return {
    command: 'project.inspect',
    path: input.path,
  };
}

/**
 * The verification-policy confirmation the trust request echoes back: the state the Runtime reported,
 * with the digest it reported for a `PRESENT` policy. The state is mirrored rather than normalised,
 * so a policy that moved is refused by the Runtime instead of being re-described by this client.
 */
export function projectTrustPolicyConfirmation(policy: VerificationPolicyView):
Readonly<Record<string, unknown>> {
  return policy.state === 'PRESENT'
    ? { state: 'PRESENT', mainCommit: policy.mainCommit, digest: policy.digest }
    : { state: 'ABSENT', mainCommit: policy.mainCommit };
}

/**
 * The `project.trust` request. `expectedIdentity` is echoed by reference: the Runtime compares it
 * byte for byte, so a repository that changed between inspect and trust is refused.
 */
export function projectTrustCommand(input: {
  readonly path: string;
  readonly expectedIdentity: ProjectIdentityView;
  readonly expectedVerificationPolicy: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    command: 'project.trust',
    path: input.path,
    expectedIdentity: input.expectedIdentity,
    expectedVerificationPolicy: input.expectedVerificationPolicy,
  };
}

/**
 * Whether the form may send `project.trust`. One reason only, and it is never a guess about the
 * repository: in STRICT the user has to type the confirmation.
 */
export function canSubmitProjectTrust(input: {
  readonly permissionMode: 'FULL' | 'STRICT';
  readonly confirmation: string;
}): boolean {
  return input.permissionMode === 'FULL' || input.confirmation === 'TRUST';
}

/**
 * The local wording for the refusals the trust face itself can produce. The code is always displayed
 * next to the note, and a code without a note is shown as the raw code rather than being mapped to
 * something invented.
 */
const projectTrustCodeGlossary: Record<string, string> = {
  // The trust face itself (apps/runtime/src/main.ts, `project.trust`).
  REPOSITORY_CHANGED: '你审阅的身份与实际读到的不一样（仓库身份在这期间变了）：请重新检查再信任',
  VERIFICATION_POLICY_CHANGED: 'main ref 上的验证策略在你确认之后变了：请重新检查策略',
  IMPACT_POLICY_CHANGED: 'main ref 上的影响映射在你确认之后变了：请重新检查映射',
  INVALID_STATE: '仓库身份与已信任项目不一致（存储层拒绝）：请重新检查后再信任',
  INVALID_REQUEST: '请求本身不合法（例如路径为空）',
};

/** The glossary note for one code, or null when this code has no documented note. */
export function projectTrustCodeNote(code: string): string | null {
  return projectTrustCodeGlossary[code] ?? null;
}

/** Every code with a local note; the tests use it to catch drift against the sources. */
export function projectTrustDocumentedCodes(): readonly string[] {
  return [...Object.keys(projectTrustCodeGlossary)];
}

/**
 * Codes this UI documents although the tree it was written in cannot show them.
 *
 * Deliberately empty: every documented code is grounded in a source file. A future ungrounded code
 * has to be added here by an explicit edit (the test pins the list).
 */
export function projectTrustForwardCodes(): readonly string[] {
  return [];
}

/** A refusal surfaced as `CODE: message`, with the glossary note when there is one. */
export function projectTrustRejectionNotice(code: string, message: string): string {
  const note = projectTrustCodeNote(code);
  return note === null ? `${code}: ${message}` : `${code}: ${message}（${note}）`;
}
