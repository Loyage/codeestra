# Git Workspace API 与安全边界

## 1. 合约

```ts
interface RepositorySnapshot {
  projectId: string;
  canonicalRoot: string;
  gitCommonDir: string;
  objectFormat: 'sha1' | 'sha256';
  mainRef: string;
  mainCommit: string;
  worktrees: readonly { path: string; ref?: string; dirty: boolean }[];
}
interface WorkspaceRef {
  id: string;
  taskId: string;
  branchRef: string;
  path: string;
  ownershipToken: string;
  baseCommit: string;
}
interface GitWorkspacePort {
  inspectRepository(root: string): Promise<RepositorySnapshot>;
  prepare(input: {
    operationId: string; projectId: string; taskId: string;
    workspaceId: string; baseCommit: string; expectedDevCommit: string;
    worktreesRoot: string;
  }): Promise<WorkspaceRef>;
  inspectChanges(workspace: WorkspaceRef): Promise<ChangeSet>;
  captureResult(input: {
    operationId: string; workspace: WorkspaceRef;
    executionId: string; revisionId: string;
    expectedHead: string; expectedTreeFingerprint: string;
    commitAuthorizationId: string;
  }): Promise<{ commit: string; tree: string }>;
  reconcile(workspace: WorkspaceRef): Promise<{
    state: 'OWNED' | 'MISSING' | 'FOREIGN' | 'UNCERTAIN'; evidenceRef: string;
  }>;
  release(input: {
    workspace: WorkspaceRef; expectedHead: string;
    userAuthorizationId: string;
  }): Promise<{ retainedBranch: string; evidenceRef: string }>;
}
interface ChangeSet {
  headCommit: string;
  tracked: readonly string[];
  untracked: readonly string[];
  renamed: readonly { from: string; to: string }[];
  treeFingerprint: string;
}
interface IntegrationGitPort {
  prepareDevCandidate(input: {
    operationId: string; batchId: string; projectId: string;
    expectedDevCommit: string; sourceCommits: readonly string[];
  }): Promise<{ integrationRef: string; worktreePath: string; candidateCommit: string }>;
  integrateDev(input: {
    operationId: string; batchId: string;
    expectedDevCommit: string; verifiedCandidateCommit: string;
  }): Promise<{ oldDevCommit: string; newDevCommit: string }>;
  promoteMain(input: {
    operationId: string; promotionId: string; approvalId: string;
    expectedDevCommit: string; expectedMainCommit: string;
    verifiedDevCommit: string;
  }): Promise<{ oldMainCommit: string; newMainCommit: string }>;
}
```

所有方法抛可分类错误：INVALID_REPOSITORY、UNBORN_MAIN、STALE_BASE、DIRTY_WORKTREE、FOREIGN_RESOURCE、REF_CONFLICT、MERGE_CONFLICT、UNSAFE_CHECKOUT、PROCESS_UNCERTAIN、COMMAND_FAILED。stdout/stderr 是诊断证据，不含凭据。

## 2. Task Workspace

- prepare 以**项目基线**的固定 SHA 为基线（ADR-0009 / ADR-0060），独立 `refs/heads/task/<task-id>` 与 Runtime 数据目录 `worktrees/<project-id>/<task-id>/`（ADR-0005）。ref/path 只使用校验后的内部 UUID，不把用户文本当 ref/path，也不在用户仓库根目录创建 worktree。
- **基线 ref 有两种来源，由「有没有记 dev clone」分派**（ADR-0056 / ADR-0060）：有 dev clone 的项目在该 clone 里解析长期 `dev` 分支（Task worktree、Task branch、结果 commit 与集成都发生在那个 clone）；**没有** dev clone 的项目（managed）在**项目文件夹**（`projects.repo_root`）里取**建 workspace 时当前检出的分支**，把 ref 与 commit 一起固定进 `workspaces.base_ref`/`base_commit`（此后切分支不会移动已建 Task 的基线），`task run --base-ref <refs/heads/…>` 可以显式选一条本地分支。`projects.repo_root`（稳定 main 检出）仍然拥有仓库身份与 `main` ref（判定策略、影响映射、提升的重启序列）。**哪个根指向哪个仓库**见下表：

| 根字段 / 事实 | 代表哪个仓库 | 谁消费它 |
|---|---|---|
| `TrustedProject.repoRoot` / `gitCommonDir` / `mainRef` | 稳定 main 检出 | 身份校验、`inspectVerificationPolicy`、`inspectImpactPolicy`、knowledge、提升的重启序列与 `main` 推回 |
| `TrustedProject.devRepoPath` | dev clone，或 null（managed，ADR-0060） | dev 事实的入口；为空时 Task 基线改取项目文件夹的检出分支，dev-only 操作以 `DEV_REPO_REQUIRED` 拒绝 |
| `WorkspacePreparationPlan.repoRoot` | **dev clone，或项目文件夹**（`COALESCE(dev_repo_path, repo_root)`，ADR-0060）（`gitCommonDir`/`mainRef` 仍是 main 检出的、与该计划无冲突的事实） | `prepareTaskWorkspace`、重启时 `reconcileWorkspacePreparations` 的 `reconcileWorkspace` |
| `WorkspacePreparationPlan.devRef` | 该 Task 实际使用的基线 ref（`workspaces.base_ref`，回退到 v33 之前的 `projects.dev_ref`） | worktree 创建、回收重建、报告 |
| `VerificationCandidates.repositoryRoot` | **dev clone**（被验证的 commit 是那里的对象） | 验证副本的创建、`testedCommit` 的 tree/计划文件读取 |
| `VerificationCandidates.mainRepositoryRoot`（新增） | 稳定 main 检出 | 验证策略读取（ADR-0006：策略是 main ref 的事实） |
| `DevFullSuiteCandidates.repositoryRoot` | **dev clone** | 全量证据的 detached 副本、候选 commit 的 tree、候选上的锁文件 |
| `DevFullSuiteCandidates.mainRepositoryRoot`（新增） | 稳定 main 检出 | 固定全量策略读取 |
| `IntegrationCandidates` / `IntegrationBatchCandidates`.repositoryRoot | **dev clone** | dev ref 读取、detached 合并 worktree、集成验证副本、ref 快进 |
| 两者的 `mainRepositoryRoot`（新增） | 稳定 main 检出 | 集成验证策略读取 |
| `IntegrationBatchPlan.repositoryRoot` | **dev clone** | 重启收敛时读 `dev` ref（`reconcileInterruptedIntegrations`） |
| `ReclamationProjectRef.repoRoot` | **dev clone，或项目文件夹**（`COALESCE`，ADR-0060） | worktree 注册与归属核验、Task branch、`dev` 可达性（managed 的「已合并」按该 workspace 记录的 `base_ref` 判定） |
| `ReclamationProjectRef.devRepoPath`（可空） | dev clone 路径，或 null。**ADR-0060 起不再作为拒绝依据**：回收按 `repoRoot` 归属核验，managed 项目的 worktree 同样可回收 | 回收的仓库根选择 |
| `StablePromotionPlan` / `PromotionCandidates.repositoryRoot` | 稳定 main 检出（不变） | 提升的 `main` ref、预期旧 main commit、重启序列（`promotion-service.ts` 本格未改） |
| `PromotionCandidates.devRepoPath` / `StablePromotionPlan.devRepoPath` | dev clone（不变） | push 源与候选对象核验 |
- Git 尚无首个 commit 的仓库返回 UNBORN_MAIN 并明确指引用户初始化；不擅自提交用户文件。本 Codeestra 开发仓库的初始化与产品处理外部项目是不同操作。
- 输入路径 canonicalize、检查父路径/symlink/归属；拒绝复用外来目录、非本 Task branch 或其他 worktree 注册记录。Git 输出用 `--porcelain -z` 等机器格式解析，支持空格/换行文件名。
- 每个 repo 的变更型 Git 操作用 Runtime 锁串行；仍假定外部用户/工具可能修改 refs，故每步重新核验预期 SHA。
- captureResult 先确认 Agent 与工具静止，检验当前 revision/HEAD/diff，并绑定 task/execution/revision/workspace、expected HEAD 与 ChangeSet fingerprint；任一变化使绑定失效。FULL 下 `task.result.capture` 单步执行（已实现）；STRICT 下保留 ADR-0003 两步：`task.result.prepare` 只读计算并落一次性 ACTIVE 授权，`task.result.commit` 必须携带 `confirm` 才进入暂存与提交。
- ChangeSet 实现在私有临时 index 上计算 worktree 完整 tree OID，因此指纹不依赖用户真实 index/暂存状态，只随内容、文件模式与 HEAD 变化；未跟踪但不被 ignore 的文件按 ADDED 计入。
- 敏感/运行数据 deny policy 带独立版本号（当前 v1）。STRICT 下在暂存前 fail-closed 列出命中项且不提供绕过参数；FULL 下不阻止，命中路径可进入成果 commit（ADR-0011），但 Runtime 仍不用 `git add .` 无边界暂存：暂存范围严格限定为 owned worktree 相对固定基线的增删改/rename。
- 暂存 owned worktree 相对固定基线的全部增删改/rename，只在 task branch 创建 commit，不 amend、不 main、不 push。commit message 由 task display number、revision 与 execution 确定性生成，供崩溃后按 HEAD/OID 核对。
- 使用仓库可解析的 `user.name` / `user.email`，缺失时请求配置但不代写 Git config。项目 trust 后正常执行 hooks；失败保留现场，不使用 `--no-verify`。commit 成功但回写失败先按 HEAD/OID reconcile，不能盲重试 hook。
- 如果 Agent 已创建成果 commit，核对可达关系和差异后固定该 OID；Runtime 不重写其历史。Agent 自建 commit 是否仍满足本次用户确认，按同一 HEAD/ChangeSet 授权边界核验，不把 Agent 行为当作用户授权。
- 验证固定 commit，在隔离验证工作树或等价受控副本运行；验证后若 tracked/untracked 变化影响被测输入，则不能直接标 PASSED。
- Verification 副本实现（ADR-0006）：在 Runtime 数据目录 `<CODEESTRA_HOME>/verifications/<project-id>/<verification-id>/` 以 `git worktree add --detach <path> <testedCommit>` 创建 detached 副本，不使用也不修改 Task worktree；path 段只接受 UUID，root 先 realpath 再创建，父目录 symlink 与越界路径拒绝。命令在副本内以 argv 数组直接 spawn，附加 `CI=1`，每个命令独立进程组以便超时按组停止。
- verification policy 通过 `readRefFile` 从配置 main ref 读取 `.codeestra/policies/verification.json`，返回值携带解析到的 commit 作为证据；缺失文件不是错误，但会使验证 fail-closed 拒绝。
- 副本改动检测用 `git status --porcelain=v1 -z --untracked-files=no`（不过 trim，首列可能是空格）与 `git ls-files --others --exclude-standard -z`：tracked 修改或 HEAD 移动使本次验证为 `ERROR/TREE_MUTATED`；新建的未忽略文件只记入证据。
- 副本删除用 `git worktree remove --force` + `git worktree prune`，并再次核对路径位于 copies root 内；Runtime 重启对未完成 run 保留副本路径而不是在可能有孤儿进程组时删除现场。
- release 只处理确认归属且已静止、无未保存改动的 worktree；取消/失败不自动调用。保留 branch/证据，不自动 prune 用户资源。

## 3. Integration

项目长期保留 `main`/`dev`（ADR-0009）：`main` 是稳定运行分支，`dev` 是功能实验与集成分支。所有 Task/worktree 从固定 dev OID 建立，Integration 分为“Task 进入 dev”和“dev 提升 main”两层。

1. 固定 expectedDevCommit 与有序 source commits；创建独立 integration worktree，候选目标为长期 `dev`。
2. 在该工作树形成 dev candidate：能 ff 就 ff，否则 `--no-ff`（合并提交以固定基线为第一父，候选必须是其后代）。冲突保留现场（worktree 与 `MERGE_HEAD` 不清理），不调用 Agent 静默替用户解决产品语义冲突。合并 worktree 与 Task worktree 一样建在 **dev clone**（ADR-0056），因此候选对象天然就是 dev clone 的对象（提升的 push 源）。
3. 冻结 dev candidate（`merged_commit`），执行独立 Integration Verification（独立实体 `integration_verification_runs`，独立副本）；成功后推进 `dev`。任何完成功能都必须先完成此层，不得直接进入 `main`。ADR-0038 规定开发 branch/worktree 只跑建分支时选定的测试，因此该层证据不能冒充稳定提升前的全量回归。

   **推进方式（ADR-0056，Amends ADR-0018）**：不再手写 ref，而是按固定顺序 ①读 `dev` 并与批次固定基线比对（不等即批级 `STALE`/`DEV_REF_MOVED`）；②核验那个持有 `dev` 的检出（必须是 dev clone 自己的长期检出，在 `dev` 上、`git status --porcelain` 为空、HEAD 与 `refs/heads/dev` 都等于基线，否则 `DEV_CHECKOUT_NOT_ON_DEV`/`DEV_CHECKOUT_DIRTY`/`DEV_CHECKOUT_MOVED`）；③`git -C <dev clone> merge --ff-only <merged_commit>` 由 Git 把 ref、索引与工作区**一起**前移；④事后核验 `HEAD == refs/heads/dev == merged_commit` **并且** `git status --porcelain` 为空。失败的写入与拒绝都照实记录（`DEV_CHECKOUT_FF_FAILED` 等），不回滚、不 `reset --hard`、不 `checkout -f`、不 `--force`。
3b. **实现边界（ADR-0018，由 ADR-0056 收窄一处）**：目标是 dev clone 里长期 `dev` 的 ref。除 **dev clone 自己的长期 `dev` 检出**（满足 §3 第 3 条的三项前置、并由同一步快进保持一致）外，任何其它工作树检出该 ref 时仍一律以 `DEV_REF_CHECKED_OUT` 拒绝；integration worktree 位于 `<CODEESTRA_HOME>/integrations/<project-id>/<batch-id>/` 且是 **dev clone** 的 detached worktree；成功后才尝试 `git worktree remove`（不加 force），失败现场与副本保留。崩溃恢复以 ref 实际值为准，不猜测、不重放。

   **实测事实（写入 ADR-0056 作证据）**：dev clone 的 `HEAD` 是 `refs/heads/dev` 的**符号引用**，因此 `git update-ref refs/heads/dev <new>` 之后 `rev-parse HEAD` 与 `rev-parse refs/heads/dev` 都已经是 `<new>`，而索引/工作区仍停在旧提交（`git status --porcelain` 会把新提交引入的文件报成 `D`），此时 `git merge --ff-only <new>` 只打印 `Already up to date.` 而不做任何事。**「三等式」单独不构成「检出已更新」的证据**，成功判据必须包含 `status` 为空。期望值的保护是**读取-比对-拒绝**（不是 `update-ref` 的原子 CAS），残余竞态窗口是「读 ref 之后、`merge --ff-only` 之前」——并发移动会让快进不可能成立（`merged_commit` 是从被核验的基线构建的），因此不会静默覆盖。
4. 稳定提升固定 expectedDevCommit、expectedMainCommit 与 verification evidence；其中必须包含在长期 `dev` 工作树对该精确 expectedDevCommit 运行并通过的全量测试证据（ADR-0038），dev SHA、测试配置或锁文件变化即失效。FULL 下直接提升，STRICT 下需用户批准 dev/main/verification 三元组。
4a. **ADR-0047 唯一提升路径（已实现，schema v29）**：本机 `main` 与 `dev` 是**两个分别 clone 的独立仓库**（ADR-0048），稳定提升不再由 Runtime 在 main 工作树内 ff 本地 `dev` ref。产品只执行「push 固定候选到远端 `dev` + 读回核对」并报告**「已推送、等待拉取」**（`phase: AWAITING_PULL`，退出码 3），main 检出的 `git fetch` + `git merge --ff-only origin/dev` 是**用户显式步骤**；再次调用同一命令核对到 main 检出已在候选上后，才记录重启序列、跑它、并在重启核对成功后把候选 push 回远端 `main`（`phase: MAIN_PUSH_PENDING` 期间不得报告完成）。旧的本机 `fastForwardCheckedOutWorktree` 已删除，不存在双路径。

   - **dev clone**：`projects.dev_repo_path` 记录第二个 clone。ADR-0056 之后它是**必需**的，而且是**全部 dev 事实的唯一来源**（不只是 push 源）：`project trust` 必须显式给出 `--dev-repo <path>`，省略或 `none` 以 `DEV_REPO_REQUIRED` 拒绝且**在任何写入之前**；已信任但路径为空的项目在任何需要 dev 基线的操作上同样以 `DEV_REPO_REQUIRED` 拒绝并给出补救命令，绝不回退到某个 clone 自己的本地 `dev` ref。`project trust --dev-repo <path>` 逐条核验它（是 Git work tree、是**另一个** clone 而非 main 检出或其 worktree、`origin` 与 main 检出一致、HEAD 在项目 `dev` 分支上且该分支存在），不可核验即用稳定码 `DEV_REPO_*` 拒绝且**不写入**；`project inspect [--dev-repo <path>]` 报告同样的核验结果与 `clean`，并额外报告只读的 `devRefRetirement`（被检查检出自己的本地 `dev` ref 状态 + 仍没有 dev clone 的已信任项目）。push 前另核对候选对象在该 clone 中存在（`DEV_REPO_CANDIDATE_MISSING`）。候选与副本根/锁文件从 **dev clone** 读，全量策略仍从 **main ref** 读。
   - **只推一个 ref**：push 源是固定候选 OID（不是分支名），目标是远端 `origin` 的 `dev`/`main`，从不 `--force`；远端自身的 fast-forward 规则决定能否更新。
   - **读回即证据**：`git ls-remote` 读回值、而不是 push 退出码，才是「候选/稳定点已在远端」的记录；push 成功但读回不等即 `REMOTE_DEV_READBACK_MISMATCH` / `REMOTE_MAIN_READBACK_MISMATCH`，不推进、不记完成。
   - **不写本地 ref**：本能力从不 `update-ref`、从不 ff 已检出的 `main`；`main` 只由用户在 main 检出自己 pull。
   - **断网与移动分开处理**：远端不可达（`REMOTE_DEV_UNREACHABLE`）只记拒绝、记录保持可重试；远端 `dev` 移到非候选 SHA（`REMOTE_DEV_MOVED`）则把记录标 `STALE`，`prepare/approve/promote` 均拒绝且不推进任何 ref。
5. 提升前核对成员 revision、dev/main SHA、dev candidate ancestry、验证证据与工作区安全；dev 或 main 移动使 STRICT 批准失效。ADR-0047 后 ancestry 在 dev clone 中核（候选对象在那里），pull 后再在 main 检出核一次，确保是 fast-forward 而不是 merge/reset。
6. main 被 checkout 时的处理仍成立（不得 `update-ref`）；ADR-0047 下 Runtime 已完全不写 `main`：拉取、重启与推回都在用户与命令面的显式步骤里，本机不再需要「安全交接」回退。
7. main 成功更新后立即在 main 检出执行 `bun run codeestra stop`，再执行 `bun run codeestra status` 自动拉起并检查 Runtime。重启不新增确认；恢复响应前不得报告提升完成，失败时不擅自回滚。**ADR-0047 之后 `main` 的更新由用户 pull 完成，命令面负责核对与重启记账；重启记录成功后立刻推回远端 `main` 并读回核对**（失败时不推回、保留现场，记录保持 `MAIN_PUSH_PENDING` 可重试）。
8. 不强制更新、不 reset 用户目录；除 ADR-0047 的「固定候选 push 到远端 `dev`」与「重启核对后 fast-forward 推回远端 `main`」之外不 push 任何 ref。任何 precondition 变化使 STRICT 批准失效，需重建候选与重验。

独立 worktree 不隔离 git config、hooks、对象库、凭据和操作系统权限；hooks/filters/子模块可能执行代码或访问网络。FULL 默认信任本机项目并执行 commit hooks（ADR-0011）；STRICT 下只有项目 trust 后才执行，且不把 trust 扩大解释为 main/push 授权。

## 4. 崩溃恢复与测试

Operation 在副作用前写 PLANNED；外部资源带 operation/ownership identity。Phase 1 workspace prepare 已在 Runtime 启动时使用 `git worktree list --porcelain -z`、canonical path、ref 与 HEAD reconcile：固定 base 的 owned 资源补记成功，确认完全缺失则记失败，任何 identity/HEAD 不确定均保留恢复态；不重放 `git worktree add`。进程归属核对随 Agent start Operation 实现。

测试至少覆盖：路径逃逸、恶意 ref、空仓库、dirty 用户目录、重复 prepare、分支存在但归属不符、Agent 未退出、验证后 diff 变化、main 移动、提升成功但 DB 未记录、取消与提升竞争。全部用临时 Git 仓库，禁止破坏实际项目。Phase 1 verification 已覆盖：副本在固定 commit 创建且用户仓库保持 clean、缺失/复用/非 UUID 路径拒绝、tracked 改动与 HEAD 移动检测、副本删除后无 worktree 残留、policy 越界（绝对路径/`~`/`..` cwd）拒绝。
