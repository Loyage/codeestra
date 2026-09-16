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
    workspaceId: string; baseRef: string; baseCommit: string;
    expectedBaseCommit: string; worktreesRoot: string;
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
```

所有方法抛可分类错误：INVALID_REPOSITORY、UNBORN_MAIN、STALE_BASE、DIRTY_WORKTREE、FOREIGN_RESOURCE、REF_CONFLICT、MERGE_CONFLICT、UNSAFE_CHECKOUT、PROCESS_UNCERTAIN、COMMAND_FAILED。stdout/stderr 是诊断证据，不含凭据。

## 2. Task Workspace

- prepare 以**项目基线**的固定 SHA 为基线（ADR-0009 / ADR-0060），独立 `refs/heads/task/<task-id>` 与 Runtime 数据目录 `worktrees/<project-id>/<task-id>/`（ADR-0005）。ref/path 只使用校验后的内部 UUID，不把用户文本当 ref/path，也不在用户仓库根目录创建 worktree。
- **基线只有一种来源**（ADR-0064）：在**项目文件夹**（`projects.repo_root`）里取**建 workspace 时当前检出的分支**，把 ref 与 commit 一起固定进 `workspaces.base_ref`/`base_commit`（此后切分支不会移动已建 Task 的基线）；`task run --base-ref <refs/heads/…>` 可以显式选一条本地分支。`HEAD` detached 时以 `TASK_BASE_REF_UNRESOLVED` 拒绝，不猜一条分支。同一目录同时拥有仓库身份与 `main` ref（判定策略、影响映射的读取来源）。**哪个根指向哪个仓库**见下表：

| 根字段 / 事实 | 代表哪个仓库 | 谁消费它 |
|---|---|---|
| `TrustedProject.repoRoot` / `gitCommonDir` / `mainRef` | **项目文件夹**（唯一的仓库根） | 身份校验、Task 基线与 worktree、结果 commit 归属、回收、`inspectVerificationPolicy`、`inspectImpactPolicy`、knowledge |
| `taskWorkspaceRepositoryRoot(project)`（Runtime 辅助） | 项目文件夹（ADR-0064 之前是 `devRepoPath ?? repoRoot`） | 结果 commit 的 worktree 归属校验（`assertOwnedWorkspace`）、`task retry` 的 worktree 观测、`task purge` 的 Task 分支删除 |
| `WorkspacePreparationPlan.repoRoot` | 项目文件夹 | `prepareTaskWorkspace`、重启时 `reconcileWorkspacePreparations` 的 `reconcileWorkspace` |
| `WorkspacePreparationPlan.baseRef` | 该 Task 实际使用的基线 ref（`workspaces.base_ref`，v33 之前的历史行已由 v35 迁移回填） | worktree 创建、回收重建、报告、`task.depends.list` |
| `VerificationCandidates.repositoryRoot` | 项目文件夹（被验证的 commit 是那个仓库里的对象） | 验证副本的创建、`testedCommit` 的 tree/计划文件读取 |
| `VerificationCandidates.mainRepositoryRoot` | 项目文件夹 | 验证策略读取（ADR-0006：策略是 main ref 的事实） |
| `ReclamationProjectRef.repoRoot` | 项目文件夹 | worktree 注册与归属核验、Task branch、「已合并」按该 workspace 记录的 `base_ref` 判定 |
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

## 3. 成果去向：停在 task 分支（ADR-0064）

产品不再建模 dev clone、长期 `dev` 集成分支或 `dev → main` 提升：`task integrate`、
`task integration *`、`promotion *`、`promotion full-suite run` 全部从命令面删除，schema **v35** 也
DROP 了 `integration_batches(_items)`、`integration_verification_runs`、`stable_promotions(_members)`
与 `dev_full_suite_evidence`。`packages/git` 侧的 `IntegrationGitPort` / `promotion.ts` 随之删除，
只保留 `refs.ts` 的 `readLocalRefCommit` / `isAncestor` / `listCheckedOutRefs`。

- **成果 commit 停在 `refs/heads/task/<task-id>`**（ADR-0005 的既有事实）。是否合并、何时合并、合并到
  哪条分支由用户自己决定；Codeestra 不自动合、不自动推、不做提升记账。
- **「已合并」的判定**因此改为：对该 workspace 记录的 `base_ref` 做
  `git merge-base --is-ancestor <resultCommit> <baseRef>`。读不到该 ref（或 workspace 没有记录
  `base_ref`）就不按已合并处理，回收保留现场。
- **依赖释放**不再读「集成事实」：一条依赖边的事实是**上游修订自己的 result commit**
  （`executions.applied_revision_id = required_revision_id` 的最新非空 `result_commit`），该 commit 对
  项目当前 Task 基线 ref 可达才释放（ADR-0064 D03）。原因码是有界枚举：
  `UPSTREAM_RESULT_MISSING`、`BASE_REF_MISSING`、`BASE_REF_UNREADABLE`、`NOT_REACHABLE_FROM_BASE`。
- **`BLOCKED → READY` 的触发点随之改变**：`task integrate` 已不存在（它是旧实现里唯一的触发者），
  所以 scheduling pass 在挑选候选之前先对每个 `BLOCKED` 任务调用 `reconcileTaskDependencyState`
  （`schedule-service.#reconcileBlockedTasks`）。`task depends list` / `task schedule status` 是只读的，
  因此下游状态最多滞后一个 tick（默认 5s，或一次显式 `task schedule run`）——这不改变「读不到基线按
  未满足阻塞」的口径，只是把「谁去看」从集成命令移到了调度 pass。
- **本仓库自身**仍以 `main`/`dev` 两个 clone 开发并把 `dev` 提升到 `main`：那是**仓库约定**
  （`AGENTS.md` 的人工四步、`docs/agents/runbook.md` 的命令序列），产品不提供命令、不记账、不校验它。

## 4. 崩溃恢复与测试

Operation 在副作用前写 PLANNED；外部资源带 operation/ownership identity。Phase 1 workspace prepare 已在 Runtime 启动时使用 `git worktree list --porcelain -z`、canonical path、ref 与 HEAD reconcile：固定 base 的 owned 资源补记成功，确认完全缺失则记失败，任何 identity/HEAD 不确定均保留恢复态；不重放 `git worktree add`。进程归属核对随 Agent start Operation 实现。

测试至少覆盖：路径逃逸、恶意 ref、空仓库、dirty 用户目录、重复 prepare、分支存在但归属不符、Agent 未退出、验证后 diff 变化、`HEAD` detached 的基线解析拒绝、基线移动后的依赖重判与快照失效、回收的「已合并」判定（含基线读不到时保留现场）。全部用临时 Git 仓库，禁止破坏实际项目。Phase 1 verification 已覆盖：副本在固定 commit 创建且用户仓库保持 clean、缺失/复用/非 UUID 路径拒绝、tracked 改动与 HEAD 移动检测、副本删除后无 worktree 残留、policy 越界（绝对路径/`~`/`..` cwd）拒绝。
