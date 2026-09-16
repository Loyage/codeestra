import type {
  DevRepoInspectionView,
  ProjectIdentityView,
  VerificationPolicyView,
} from './types.js';

/**
 * The `project.inspect` / `project.trust` projection for the dev clone (ADR-0047 D05 / ADR-0048,
 * FOUNDATION-089 increment).
 *
 * Scope of this module — what it is and is not:
 * - A project's stable promotion pushes its fixed candidate to the remote `dev` branch **from a
 *   second, independent clone of the same origin**. That clone is part of what a trust records, and
 *   the field that carries it (`devRepoPath`) has existed on the command face since FOUNDATION-077
 *   (schema v29); this module is the UI half of it, so a project added from the interface records a
 *   dev clone instead of being refused by the Runtime for having none.
 * - It sends the value the user typed **as is** — the same string the CLI passes through its
 *   `--dev-repo` argv — and it **never decides whether a path is usable**. Every refusal is the
 *   Runtime's own stable code, displayed verbatim next to a local glossary sentence that never
 *   replaces the code.
 * - A dev clone is **optional** since ADR-0060: a project that records one keeps the long-lived `dev`
 *   baseline and `dev → main` promotion; one that does not gets its Task baselines from **its own
 *   folder's currently checked out branch**. The form therefore does not gate submission on the path;
 *   the hint states what a blank field means instead.
 * - It reads the copy it shows out of the identity `project.inspect` returned, so the facts on screen
 *   are the facts the same request echoed back — never a client-side re-derivation of a path or a
 *   branch name.
 */

/** True when the dev clone path input is effectively empty (blank input is not a path). */
export function projectDevRepoPathMissing(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * `project.inspect {path, devRepoPath?}`: the candidate dev clone is inspected when one was typed,
 * and omitted when the field is blank — exactly what `project inspect` without `--dev-repo` does
 * (it then reports the path a previous trust recorded, or null).
 */
export function projectInspectCommand(input: {
  readonly path: string;
  readonly devRepoPath: string;
}): Record<string, unknown> {
  return {
    command: 'project.inspect',
    path: input.path,
    ...(projectDevRepoPathMissing(input.devRepoPath) ? {} : { devRepoPath: input.devRepoPath }),
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
 * `project.trust {path, expectedIdentity, devRepoPath?, expectedVerificationPolicy}`.
 *
 * `devRepoPath` is sent **verbatim** (no trimming, no normalisation: it is a path the Runtime has to
 * verify, and a client that "fixed it up" would be reporting a different fact than the one the user
 * typed). It is omitted only when the field is blank, which is also the state in which this UI does
 * not offer the button at all.
 *
 * `expectedIdentity` is echoed by reference: the Runtime compares it byte for byte, including the dev
 * clone and the `dev` baseline the user reviewed.
 */
export function projectTrustCommand(input: {
  readonly path: string;
  readonly expectedIdentity: ProjectIdentityView;
  readonly devRepoPath: string;
  readonly expectedVerificationPolicy: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    command: 'project.trust',
    path: input.path,
    expectedIdentity: input.expectedIdentity,
    ...(projectDevRepoPathMissing(input.devRepoPath) ? {} : { devRepoPath: input.devRepoPath }),
    expectedVerificationPolicy: input.expectedVerificationPolicy,
  };
}

/**
 * Whether the form may send `project.trust`. One reason only, and it is never a guess about the
 * repository: in STRICT the user has to type the confirmation. A blank dev clone path is **not** a
 * blocker (ADR-0060): it means "this project has no dev clone", and the Runtime decides what that
 * makes usable.
 */
export function canSubmitProjectTrust(input: {
  readonly permissionMode: 'FULL' | 'STRICT';
  readonly confirmation: string;
  readonly devRepoPath: string;
}): boolean {
  return input.permissionMode === 'FULL' || input.confirmation === 'TRUST';
}

/**
 * One dev clone fact as the identity table shows it: what was inspected, whether the Runtime could
 * verify it, and the stable code when it could not.
 */
export function devRepoVerifiedLabel(inspection: DevRepoInspectionView): string {
  return inspection.verified
    ? '已核验（这个 clone 可以作为该项目的 dev clone）'
    : `未通过核验 · ${inspection.code ?? '（未给出稳定码）'}`;
}

/** The `clean`/`originMatchesProject` facts are nullable booleans: null means "not established". */
function triState(value: boolean | null): string {
  return value === null ? '未核验' : (value ? '是' : '否');
}

/**
 * Plain-language notes for the stable codes this face can answer with. This is a **glossary**, not a
 * gate: the code is always displayed next to the note, and a code without a note is shown as the raw
 * code rather than being mapped to something invented.
 *
 * Every key except the ones in `projectTrustForwardCodes()` is a string the Runtime sources literally
 * contain (asserted by the test), and the dev-clone family is read out of the `DevRepoCode` union so
 * a new member of that family cannot appear without a note.
 */
const projectTrustCodeGlossary: Record<string, string> = {
  // `inspectDevRepo` / `requireCandidateInDevRepo` (apps/runtime/src/dev-repo-service.ts).
  DEV_REPO_NOT_A_REPOSITORY: '这个路径不是 Git 工作树（或读不出来），不能作为 dev clone',
  DEV_REPO_NOT_SEPARATE: '这是主检出本身或它的某个工作树：稳定提升需要同一个 origin 的第二个独立 clone',
  DEV_REPO_ORIGIN_UNKNOWN: '主检出或这个 clone 没有 origin；提升要把候选推到 origin，没有它就无从判断是不是同一个远端',
  DEV_REPO_ORIGIN_MISMATCH: '这个 clone 的 origin 与主检出的 origin 不同：推过去会把候选提升到另一个仓库',
  DEV_REPO_BRANCH_MISMATCH: '这个 clone 的 HEAD 不在项目的 dev 分支上（dev clone 就是长期检出 dev 的那个树）',
  DEV_REPO_DEV_REF_MISSING: '这个 clone 里没有本地 dev 分支',
  DEV_REPO_CANDIDATE_MISSING: '这个 clone 里没有要被推送的固定候选 commit（提升前要先在 dev clone 里抓到集成后的 dev）',
  // ADR-0056 (FOUNDATION-087) makes the dev clone mandatory, so a trust without it is refused
  // before anything is written. It used to live in an explicit "forward declared" list because the
  // lane that introduced it was not merged yet; now that both are in `dev`, the ordinary guard below
  // proves it against `apps/runtime/src/main.ts` instead of exempting it.
  DEV_REPO_REQUIRED: '信任请求没有给出 dev clone 路径，因此在任何写入之前被拒绝（ADR-0056 起它变成必需）',
  // The trust face itself (apps/runtime/src/main.ts, `project.trust`).
  REPOSITORY_CHANGED: '你审阅的身份与实际读到的不一样（dev clone、dev 基线或仓库身份在这期间变了）：请重新检查再信任',
  DEV_REF_MISSING: '这个仓库没有 refs/heads/dev：项目必须长期保留 dev，先建它再信任',
  VERIFICATION_POLICY_CHANGED: 'main ref 上的验证策略在你确认之后变了：请重新检查策略',
  IMPACT_POLICY_CHANGED: 'main ref 上的影响映射在你确认之后变了：请重新检查映射',
  INVALID_STATE: '仓库身份与已信任项目不一致（存储层拒绝）：请重新检查后再信任',
  INVALID_REQUEST: '请求本身不合法（例如路径为空）',
};

/**
 * Codes that this UI documents although the tree it was written in cannot show them.
 *
 * The mechanism exists for cross-lane work: FOUNDATION-089 was written beside FOUNDATION-087, which
 * is the lane that makes `dev_repo_path` mandatory, so `DEV_REPO_REQUIRED` could not be grounded in
 * this tree's sources yet. Both lanes are now in `dev`, so the list is deliberately **empty**: every
 * documented code is verified against a source by the guard, and a future ungrounded code has to be
 * added here by an explicit edit (the test pins the list).
 */
const forwardDeclaredTrustCodeNotes: Record<string, string> = {};
const forwardDeclaredTrustCodes: readonly string[] = Object.keys(forwardDeclaredTrustCodeNotes);

/** The glossary note for one code, or null when this code has no documented note. */
export function projectTrustCodeNote(code: string): string | null {
  return projectTrustCodeGlossary[code] ?? forwardDeclaredTrustCodeNotes[code] ?? null;
}

/** Every code with a local note; the tests use it to catch drift against the sources. */
export function projectTrustDocumentedCodes(): readonly string[] {
  return [...Object.keys(projectTrustCodeGlossary), ...forwardDeclaredTrustCodes];
}
/** The codes documented here that no source in this tree can confirm (see above). */
export function projectTrustForwardCodes(): readonly string[] {
  return [...forwardDeclaredTrustCodes];
}

/** A refusal surfaced as `CODE: message`, with the glossary note when there is one. */
export function projectTrustRejectionNotice(code: string, message: string): string {
  const note = projectTrustCodeNote(code);
  return note === null ? `${code}: ${message}` : `${code}: ${message}（${note}）`;
}

/**
 * The dev clone path input. Written so the field states its own rule: the hint under it names the CLI
 * flag it corresponds to, says the value is sent as typed, says the Runtime — not this form — decides
 * whether the path is usable, and says what an empty field means now that a dev clone is optional
 * (ADR-0060).
 */
export function ProjectDevRepoInput({ value, busy, onChange }: {
  readonly value: string;
  readonly busy: boolean;
  readonly onChange: (value: string) => void;
}) {
  const missing = projectDevRepoPathMissing(value);
  return (
    <div className="project-dev-repo">
      <label htmlFor="project-dev-repo-path">dev clone 路径（可留空）</label>
      <input id="project-dev-repo-path" aria-label="dev clone 绝对路径"
        placeholder="/另一个检出 dev 的 clone" value={value} disabled={busy}
        onChange={(event) => { onChange(event.target.value); }} />
      <p className="muted hint">
        与 CLI 的 <span className="mono">--dev-repo</span> 同一个字段（
        <span className="mono">project.trust</span> 的 <span className="mono">devRepoPath</span>）：记了它，稳定提升就用这个 clone 把固定候选推到远端 dev。
        值<strong>原样</strong>放进请求；能不能用由 Runtime 核验 —— 拒绝时这里显示它返回的
        {' '}<span className="mono">DEV_REPO_*</span> 稳定码与解释。
      </p>
      {missing ? (
        <p className="muted" role="status" data-project-trust="dev-repo-missing">
          留空 = 这个项目没有 dev clone（ADR-0060）：Task 基线取该项目文件夹当前检出的分支，
          <span className="mono">task integrate</span> 与 <span className="mono">promotion</span> 会在需要 dev 分支时以
          {' '}<span className="mono">DEV_REPO_REQUIRED</span> 拒绝。
        </p>
      ) : null}
    </div>
  );
}

/**
 * The dev clone as the identity review shows it. Read-only: the path, the Runtime's verification
 * verdict with its stable code and detail, and the facts the verification read (branch, HEAD, dev
 * ref commit, cleanliness, origin). Nothing here is derived by the client.
 */
export function DevRepoInspectionRows({ inspection }: {
  readonly inspection: DevRepoInspectionView | null;
}) {
  if (inspection === null) {
    return (
      <>
        <dt>dev clone（这次会记录）</dt>
        <dd className="muted">
          未指定：检查时没有给 dev clone 路径，也没有已记录的路径。
          <div>不要 dev clone 也能用（ADR-0060）：Task 基线取该项目文件夹当前检出的分支；
            <span className="mono">task integrate</span> / <span className="mono">promotion</span> 会在需要 dev
            分支时以 <span className="mono">DEV_REPO_REQUIRED</span> 拒绝。</div>
        </dd>
      </>
    );
  }
  const note = inspection.code === null ? null : projectTrustCodeNote(inspection.code);
  return (
    <>
      <dt>dev clone（这次会记录）</dt>
      <dd className="mono">{inspection.path}
        <div>
          <span className={inspection.verified ? 'state state-ready' : 'state state-failed'}
            data-dev-repo-verified={inspection.verified ? 'true' : 'false'}>
            {devRepoVerifiedLabel(inspection)}
          </span>
        </div>
        {inspection.detail === null ? null : <div className="muted">{inspection.detail}</div>}
        {note === null ? null : <div className="muted">{note}</div>}
        <div className="muted">
          dev 分支 <span className="mono">{inspection.devRef}</span>
          {' · '}HEAD 的 ref <span className="mono">{inspection.branchRef ?? '（detached）'}</span>
          {' · '}dev ref commit <span className="mono">{inspection.devRefCommit?.slice(0, 12) ?? '—'}</span>
          {' · '}HEAD <span className="mono">{inspection.headCommit?.slice(0, 12) ?? '—'}</span>
        </div>
        <div className="muted">
          工作树干净 {triState(inspection.clean)}
          {' · '}origin 与主检出相同 {triState(inspection.originMatchesProject)}
          {' · '}origin <span className="mono">{inspection.originUrl ?? '—'}</span>
        </div>
      </dd>
    </>
  );
}
