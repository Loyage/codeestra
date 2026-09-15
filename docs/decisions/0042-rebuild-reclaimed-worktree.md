# ADR-0042：从 reclaim 保留的 task branch 重建 owned worktree（补 ADR-0036 缺口）

Status：Accepted（用户已拍板：闭环重建；`task retry` 记录「核验通过、待重建」的计划事实、真实重建在既有
workspace preparation 路径执行；只保留既有拒绝码；**无 schema 变更、不占迁移号**）

## Context

ADR-0036 / FOUNDATION-061 如实保留了一个缺口，本 ADR 关闭它：

- `reclaim`（ADR-0021/0037）**故意不删除 task branch**，只删 worktree 目录与它的 Git 注册；
- 既有 `prepareWorkspace`（`packages/git/src/index.ts`）在「分支已存在」时以 `REF_CONFLICT` 拒绝创建
  worktree，因为它只做「从基线新建分支」这一件事；
- 于是**已被 reclaim 的 worktree 无法重建**：`task retry` 只能以稳定码 `WORKSPACE_RECLAIMED` 拒绝，
  Execution 无法建立，一个失败过又被回收的 Task 实际上再也跑不起来；
- 另一个硬事实是 `workspaces.path TEXT NOT NULL UNIQUE`：一个 Task 在账本里**永远只有一个 workspace 行**
  （`one_live_workspace` 只允许一个非 `RELEASED` 行）。所以「重建」在数据语义上只能是**复用同一行**
  （同一 `workspace_id` / `path` / `branch_ref` / `ownership_token`），不可能是第二行。

本 ADR 只补「重建」这一件事：不改变 `reclaim` 的删除语义（不清 branch、不 `--force`）、不改变
「不自动重试」（ADR-0036）、不新增确认/门禁（ADR-0008/0011）。

## Options

1. 重建判据（哪些事实同时成立才允许重建）：
   - A. **路径 = 账本记录的 path 且是 `worktrees/<project>/<task>` 形态、canonical、无 symlink；分支 ref =
     账本 `branch_ref` = `refs/heads/task/<taskId>`；分支 HEAD 等于账本 `base_commit` 或为其后代；该分支未在
     其它 worktree 注册；记录路径当前没有被目录占用（除崩溃后「已注册在同一路径同一分支」的采纳情形）**（选择）
   - B. 更严：分支 HEAD 必须恰好等于 `base_commit`，失败尝试已提交过就拒绝；
   - C. 更宽（混合）：分支无关甚至缺失时也允许「从当前 dev 重新开始」，接受丢弃失败尝试已提交的工作。
2. 谁执行 `git worktree add`：
   - A. **既有 workspace preparation（`task run` / 调度 tick 建立 Execution 时）执行；`task retry` 只核验并
     记录 `workspaceMode=REBUILD_OWNED`（含义：核验通过、待重建）**（选择）
   - B. `task retry` 命令内立即重建（即使随后因容量/依赖排队，worktree 也已存在）。
3. 重建事实如何入账：
   - A. **复用同一 workspace 行 `RELEASED → READY` + 既有 `WorkspacePrepared` 事件（payload 带 rebuild 事实）
     + `TaskRetryRequested.workspaceMode=REBUILD_OWNED`；无 schema 变更**（选择）
   - B. 另加新事件名 `WorkspaceRebuilt`；
   - C. 新 workspace 状态值 / 新表列（需要迁移，本格不占版本）。
4. 是否允许删除/改名既有 task branch：
   - A. **绝不删除、绝不改名、绝不复用别人的分支；重建只做 attach（`git worktree add <path> <branch>`）**（选择）
   - B. 允许删除后重建同名分支。
5. 记录路径被「Git 未注册的残留目录」占用时：
   - A. **拒绝并给稳定码，绝不删除；用户用既有 `reclaim --remove-unregistered <path>` 显式清理后再重试**（选择）
   - B. 重建时自动按 reclaim 的既有核验路径回收该残留。
6. 拒绝码集合：
   - A. **`task retry` 决策层继续只有 `WORKSPACE_RECLAIMED` / `WORKSPACE_OWNERSHIP_UNVERIFIABLE`，不新增码；
     具体事实写进证据串**（选择）
   - B. 拆成 `WORKSPACE_BRANCH_DIVERGED` / `WORKSPACE_BRANCH_CHECKED_OUT_ELSEWHERE` 等细分码。
7. 重建入口范围：
   - A. **任何走到 workspace preparation 的路径都用同一条判据**（归属证明来自 reclaim 账本 + 分支事实，
     不来自「retry 授权」）（选择）
   - B. 只有 `task retry` 记录过 `REBUILD_OWNED` 之后才允许重建，其余路径仍 `REF_CONFLICT`。
8. `packages/storage` 的最小追加：
   - A. **允许最小纯追加：`TaskRetryWorkspaceMode` 加 `'REBUILD_OWNED'` + 一个受保护的 `RELEASED → READY`
     转移方法（与事件同事务）**（选择）
   - B. 不改 `packages/storage`，接线留给后续 lane。

## Decision

### D01：重建的全部判据都是事实，不是记录

允许重建当且仅当以下事实同时成立（缺一即 `WORKSPACE_RECLAIMED`，且拒绝时**一个字节都不写**）：

1. 账本里该 Task 的 workspace 行状态是 `RELEASED`（即「目录已被回收、行仍在」），且 `path` / `branch_ref`
   与本次要重建的目标一致；
2. `path` 等于 `<runtimeHome>/worktrees/<projectId>/<taskId>`（canonical），且路径本身及其 project 目录
   都不是 symlink、且解析后仍在 owned root 内；
3. 记录路径当前**没有被目录占用**；若已有目录而 Git 未注册它，直接拒绝（D05）；
4. `refs/heads/task/<taskId>` 仍存在，且其 commit 与账本 `base_commit` 的关系是 `EQUAL` 或 `DESCENDANT`
   （后代 = 失败尝试已经提交过的工作，必须保留，不被「从 dev 重新开始」替换）；
5. 该分支**没有**在其它 worktree 里被 checkout；
6. 没有 held Execution、也没有活跃槽位预留（`RESERVED`/`RECOVERY_REQUIRED`）指向该 workspace。

关系不可读（对象缺失、Git 命令失败）报 `UNKNOWN` 并拒绝：**不可读不是归属证明**。

### D02：`task retry` 记录计划，workspace preparation 执行

`task retry` 只做只读核验，并把 `workspaceMode: 'REBUILD_OWNED'` 写进 `TaskRetryRequested` 审计事件；`--json`
里同时可见 `workspace.detail` 说明「目录尚不存在」。真实 `git worktree add` 一律发生在既有
workspace preparation 路径（`prepareTaskWorkspace`），也就是 `task run`、调度 tick、reservation
prepare-workspace 三条入口共用的那一个。这样做的理由有二：

- 重建**不是 retry 的副作用**：retry 只 requeue，随后那次启动可能因依赖/冲突/容量排队；在 retry 里建
  worktree 会为一个还没开始的尝试提前产生 Git 副作用；
- 归属判据属于「准备一个 workspace」这件事本身，放在 preparation 里意味着**没有第二条 Git 逻辑**：
  retry 决策与 preparation 决策调用同一个纯函数 `decideRetryWorkspace`，读同一份事实。

### D03：账本复用同一行，事件复用同一个名字

- `workspaces` 行 `RELEASED → READY`，`id`/`path`/`branch_ref`/`ownership_token`/`base_commit` 全部不变
  （`path` 唯一约束决定了这是唯一自洽的形态）；转移由新的 `markReclaimedWorkspaceRebuilt` 在同一事务内
  完成，并写入既有 `WorkspacePrepared` 事件，payload 增加
  `reattachedBranch: true`、`previousState: 'RELEASED'`、`rebuild: { outcome, reasonCode, detail, headCommit }`。
- 该转移只接受 `RELEASED` 行，并在事务内重新核验 held Execution 与活跃预约；行已是 `READY` 时返回
  `changed: false`（两个并发 preparation 都对同一结果负责时都能成功，且不会产生第二个 worktree）。
- `TaskRetryWorkspaceMode` 增加 `'REBUILD_OWNED'`；**不新增事件名、不新增表/列、不占迁移号**。
- 「核验通过、待重建」与「已重建」因此可脚本区分：前者是 retry 的 `workspace.mode`，后者是
  `WorkspacePrepared.payload.rebuild.outcome`（`REBUILT` / `ADOPTED`）。

### D04：只 attach，不删除、不改名、不 `--force`

`git worktree add <path> <branch>`（**短分支名**，因为带 `refs/heads/` 前缀的参数会让 Git 检出 detached，
那就不是这个 Task 拥有的 workspace 了）从不带 `--force`。Git 自己拒绝把已 attach 的分支再 attach 一次，
这个拒绝被保留为证据（`BRANCH_CHECKED_OUT_ELSEWHERE`），不被绕过。任何路径下都**不删分支、不改名分支、
不复用别人的分支**。

### D05：占用路径一律拒绝，删除永远是显式决定

记录路径存在但 Git 未注册（残留目录、别人放的目录）→ `UNREGISTERED_DIRECTORY` 拒绝，目录原样保留；
用户要用既有 `reclaim --remove-unregistered <path>`（ADR-0037）显式点名清理后再重试。注册存在但目录已不在
→ `REGISTERED_WITHOUT_DIRECTORY` 拒绝（`git worktree prune` 属于 reclaim 的 `REGISTRATION_ONLY` 决定，
不在这里偷偷执行）。

### D06：稳定码分层，`task retry` 的码不变

- **retry 决策层**（`packages/domain`）：仍然是 `WORKSPACE_RECLAIMED`（reclaimed 且不可证明可重建）与
  `WORKSPACE_OWNERSHIP_UNVERIFIABLE`（其它不可核验），不新增码；具体失败事实（分支缺失 / 无关 / 被别处
  checkout / 路径被占用）写进 `evidence`，成功时是 `REBUILD_OWNED`/`REUSE_VERIFIED`/`PREPARE_FRESH`。
- **action 层**（`packages/git`，与 reclaim 的 `reasonCode` 同风格）：`BRANCH_ABSENT`、
  `BRANCH_DIVERGED`、`BRANCH_CHECKED_OUT_ELSEWHERE`、`UNREGISTERED_DIRECTORY`、
  `REGISTERED_WITHOUT_DIRECTORY`、`PATH_NOT_OWNED_LAYOUT`、`SYMLINK_ESCAPE`、`PATH_OUTSIDE_OWNED_ROOT`、
  `BRANCH_MISMATCH`、`HEAD_UNREADABLE`、`HEAD_MISMATCH`、`REBUILD_FAILED`、`REBUILD_UNCONFIRMED`。
  两者都是稳定值，且都不可被 `--force` 之类选项越过。

### D07：入口范围由归属证明决定，不由命令决定

任何走到 workspace preparation 的路径（`task run`、`task retry` 后的启动、调度 tick 的 scheduled run、
`task.schedule.run`）都能重建，判据完全相同：**归属证明是 reclaim 账本 + 分支事实**，而不是「哪条命令发起的」。
记录的 `REBUILD_OWNED` 只是一个已核验的意图记录，不是许可令牌；事实变了（分支被删/被改）时，preparation
照样以稳定码拒绝。

### D08：幂等与崩溃 reconcile 靠事实核对，不发明中间状态

- 重复调用：第二次看到「已注册在同一路径、同一分支、同一 commit」→ `ADOPTED`，**不运行任何 Git 命令**，
  也不会产生第二个 worktree。
- 中途崩溃（`git worktree add` 成功但账本还没转 `READY`）：账本行仍是 `RELEASED`，下一次 preparation 观察到
  已注册且事实一致 → `ADOPTED` → 转 `READY`。崩溃在 `add` 之前则照常重建。
- 因此不需要新增「RECREATING」之类中间状态，也不使用 `git worktree prune`/`--force` 掩盖状态；沿用
  ADR-0021/0025/0032 的事实核对风格：**只按已存在的 ref / worktree 注册 / 账本行收敛**。
- 并发（同一 Runtime 两个 preparation 争同一路径）：`git worktree add` 本身会拒绝其中一个；失败方**重新观测**
  后只有在事实完全一致时才采纳，否则报 `FAILED`/`REBUILD_UNCONFIRMED` 并保留现场（不删除、不重试掩盖）。
- 事后核验失败（`REBUILD_UNCONFIRMED`）时新建的 worktree **故意留在原地**：删除是 reclaim 的职责。

## Consequences

- 一个失败且已被 reclaim 的 Task 现在可以真正重跑，且失败尝试**已提交**的工作被带进新 Execution；未提交的
  工作仍由 reclaim 的既有语义决定（默认作为失败现场保留，除非显式 `--include-failure-scenes`）。
- 旧 Execution 的失败、错误、证据一律不改写；不伪造 RUNNING/RESULT；不因心跳/等待自动释放任何预留。
- `reclaim` 语义不变（仍不删 branch、不 `--force`）；未注册目录的处置权仍只在 `reclaim` 手里。
- 已知边界（如实记录，未在本次解决）：
  - 账本行 `RELEASED` 且**分支也已不存在**时，`decideRetryWorkspace` 仍按 ADR-0036 判为 `PREPARE_FRESH`；
    而 `workspaces.path` 的唯一约束意味着同一 Task 无法再新建第二个 workspace 行，这条路径实际上会以数据库
    约束错误收场。它需要独立决策（要么允许复用 `RELEASED` 行做一次真正的 fresh prepare，要么让
    `PREPARE_FRESH` 也变成稳定拒绝码），本 ADR 不改 ADR-0036 的既有判定。
  - 重建后的首次启动，impact/conflict 观察仍把该 Task 视为「尚无 workspace」（`getImpactCandidateTask`
    过滤 `state <> 'RELEASED'`，落在工作树准备之前），因此第一次启动的改动集观察为空；这是既有语义，
    本 ADR 不扩大领地修改 `slot-reservation-service`。
  - 真实模型/真实 provider 在重建出的 worktree 里跑完整流程未验收（本次 e2e 用的是协议 stub provider）。
  - UI 仍未投影 `REBUILD_OWNED` 与 rebuild 事件（本格不改 `apps/ui/**`）。

## Verification

命令面驱动（临时 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider），不新增确认：

- `packages/domain/test/task-retry.test.ts`：`RELEASED + FOREIGN + 分支 EQUAL/DESCENDANT` → `REBUILD_OWNED`；
  分支缺失 / `UNRELATED` / `UNKNOWN` / 被别处 checkout / 路径被占用 / 已注册 → 一律 `WORKSPACE_RECLAIMED`
  且 `mode: null`；`UNCERTAIN` 不因分支事实变绿。
- `packages/git/test/rebuild.test.ts`（真实临时仓库）：重建成功（含失败尝试已提交的 commit 仍在）、
  幂等 `ADOPTED`（不再跑 Git、注册数仍为 1）、陈旧注册无目录被拒、分支分叉被拒、分支缺失被拒、分支在别的
  worktree 被拒（并保持那个 worktree 原样）、未注册残留目录被拒且文件原样、注册在别的分支被拒、
  非本 Task 布局路径被拒、symlink 被拒、布局无法创建时报 `FAILED` 且不留下注册；所有拒绝都不删/不改分支。
- `apps/runtime/test/cli-task-retry.test.ts`（真实 CLI + Runtime + 临时 home/仓库 + stub provider）：
  `reclaim` → `task retry` 返回 `workspace.mode=REBUILD_OWNED` 且退出 0、attempt 2 由真实 stub 启动、
  worktree 确实重建在同一路径同一分支且 HEAD = 失败尝试的 commit、`git worktree list` 只有一条该路径注册、
  分支 commit 未被移动、`TaskRetryRequested.workspaceMode=REBUILD_OWNED` 与
  `WorkspacePrepared.reattachedBranch=true`（`rebuild.outcome=REBUILT`）可读、重复 retry 以
  `CONCURRENT_MODIFICATION` 拒绝且注册数不变；分支分叉与路径被占用两种情形都以 `WORKSPACE_RECLAIMED`
  拒绝、版本不变、无新 Execution、无 `TaskRetryRequested`、无 rebuild 事件、现场零写入。

## References

- ADR-0021（资源回收）、ADR-0037（批量与未注册目录）、ADR-0025/0032（事实核对式 reconcile）
- ADR-0036（`task retry`；本 ADR 关闭其中如实保留的 reclaim 缺口，不改变其余判定）
- ADR-0008/0009/0011（效率优先、CLI 完备、默认 FULL 零确认）
- `packages/git/src/rebuild.ts`、`packages/domain/src/task-retry.ts`、
  `apps/runtime/src/{workspace-service,task-control-service}.ts`
