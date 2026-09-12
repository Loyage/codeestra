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
    workspaceId: string; baseCommit: string; expectedMainCommit: string;
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
  prepareCandidate(input: {
    operationId: string; batchId: string; projectId: string;
    expectedMainCommit: string; sourceCommits: readonly string[];
  }): Promise<{ integrationRef: string; worktreePath: string; candidateCommit: string }>;
  promote(input: {
    operationId: string; batchId: string; approvalId: string;
    expectedMainCommit: string; verifiedCandidateCommit: string;
  }): Promise<{ oldMainCommit: string; newMainCommit: string }>;
}
```

所有方法抛可分类错误：INVALID_REPOSITORY、UNBORN_MAIN、STALE_BASE、DIRTY_WORKTREE、FOREIGN_RESOURCE、REF_CONFLICT、MERGE_CONFLICT、UNSAFE_CHECKOUT、PROCESS_UNCERTAIN、COMMAND_FAILED。stdout/stderr 是诊断证据，不含凭据。

## 2. Task Workspace

- prepare 以固定 main SHA 为基线，独立 `refs/heads/task/<task-id>` 与 Runtime 数据目录 `worktrees/<project-id>/<task-id>/`（ADR-0005）。ref/path 只使用校验后的内部 UUID，不把用户文本当 ref/path，也不在用户仓库根目录创建 worktree。
- Git 尚无首个 commit 的仓库返回 UNBORN_MAIN 并明确指引用户初始化；不擅自提交用户文件。本 Codeestra 开发仓库的初始化与产品处理外部项目是不同操作。
- 输入路径 canonicalize、检查父路径/symlink/归属；拒绝复用外来目录、非本 Task branch 或其他 worktree 注册记录。Git 输出用 `--porcelain -z` 等机器格式解析，支持空格/换行文件名。
- 每个 repo 的变更型 Git 操作用 Runtime 锁串行；仍假定外部用户/工具可能修改 refs，故每步重新核验预期 SHA。
- captureResult 先确认 Agent 与工具静止，检验当前 revision/HEAD/diff。按 ADR-0003 要求用户确认绑定 task/execution/revision/workspace、expected HEAD 与 ChangeSet fingerprint；任一变化使确认失效。
- 获得有效确认后，暂存 owned worktree 相对固定基线的全部增删改/rename；敏感与运行数据路径策略先 fail-closed，不能用 `git add .` 无边界打包密钥、日志、SQLite 或 session。只在 task branch 创建 commit，不 amend、不 main、不 push。
- 使用仓库可解析的 `user.name` / `user.email`，缺失时请求配置但不代写 Git config。项目 trust 后正常执行 hooks；失败保留现场，不使用 `--no-verify`。commit 成功但回写失败先按 HEAD/OID reconcile，不能盲重试 hook。
- 如果 Agent 已创建成果 commit，核对可达关系和差异后固定该 OID；Runtime 不重写其历史。Agent 自建 commit 是否仍满足本次用户确认，按同一 HEAD/ChangeSet 授权边界核验，不把 Agent 行为当作用户授权。
- 验证固定 commit，在隔离验证工作树或等价受控副本运行；验证后若 tracked/untracked 变化影响被测输入，则不能直接标 PASSED。
- release 只处理确认归属且已静止、无未保存改动的 worktree；取消/失败不自动调用。保留 branch/证据，不自动 prune 用户资源。

## 3. Integration

1. 固定 expectedMainCommit 与有序 source commits；创建独立 integration branch/worktree。
2. 在该工作树形成候选（第一版不自动 rebase 用户/Agent 历史；具体 merge 提交策略 Phase 4 ADR 决定）。冲突保留现场，不调用 Agent 静默替用户解决产品语义冲突。
3. 冻结 candidate，独立 Integration Verification。
4. 用户批准 candidate/main/verification 三元组。
5. 提升前核对版本、成员 revision、main SHA、candidate ancestry 与工作区安全。
6. main 未被 checkout 时可使用带 expected old OID 的 ref CAS；main 被 checkout 时不得直接 update-ref 导致 index/worktree 不一致。MVP 安全回退为拒绝自动提升并要求安全交接；自动更新已 checkout main 的具体策略 Phase 4 前确认。
7. 不强制更新、不 push、不 reset 用户目录。任何 precondition 变化使审批失效，重建候选、重验和重新审批。

独立 worktree 不隔离 git config、hooks、对象库、凭据和操作系统权限；hooks/filters/子模块可能执行代码或访问网络。首次项目接入必须清晰展示信任边界；只有项目 trust 后才执行 commit hooks，不偷偷禁用 hooks，也不把 trust 扩大解释为 main/push 授权。

## 4. 崩溃恢复与测试

Operation 在副作用前写 PLANNED；外部资源带 operation/ownership identity。Phase 1 workspace prepare 已在 Runtime 启动时使用 `git worktree list --porcelain -z`、canonical path、ref 与 HEAD reconcile：固定 base 的 owned 资源补记成功，确认完全缺失则记失败，任何 identity/HEAD 不确定均保留恢复态；不重放 `git worktree add`。进程归属核对随 Agent start Operation 实现。

测试至少覆盖：路径逃逸、恶意 ref、空仓库、dirty 用户目录、重复 prepare、分支存在但归属不符、Agent 未退出、验证后 diff 变化、main 移动、提升成功但 DB 未记录、取消与提升竞争。全部用临时 Git 仓库，禁止破坏实际项目。
