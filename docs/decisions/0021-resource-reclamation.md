# ADR-0021：验证副本与失败现场的回收（`reclaim`）

Status：Accepted（本轮实现：FOUNDATION-041；无新增确认门禁）

## Context

ADR-0016 D04 明确「归档不回收 worktree/branch」，并把「归档 + 归属校验后回收 worktree/branch」留作**独立高风险命令**，要求另行决策。FOUNDATION-016 的已知限制也写到「副本目录尚无 `task verification prune`，失败现场需人工清理」。`docs/tasks/README.md` 的 NEXT 第 5 项因此是「验证副本与失败现场的回收：明确的 `prune`/归属校验与可追溯记录；同时决定 Attention 工具参数是否入库/摘要化」。

现状造成两类长期占用的资源：

- **Runtime 拥有的 worktree**：`<CODEESTRA_HOME>/worktrees/<project-id>/<task-id>`（Task worktree，branch 为 `refs/heads/task/<task-id>`）、`<CODEESTRA_HOME>/verifications/<project-id>/<verification-id>`（Task/Integration 验证的 detached 副本）、`<CODEESTRA_HOME>/integrations/<project-id>/<batch-id>`（integration 合并用的 detached worktree）。
- **失败现场**：冲突的 integration worktree、未确认静止的验证副本、未合入或带未提交改动的 Task worktree。规格要求优先保留失败现场。

这些资源既不能依赖用户手工 `rm -rf`（无归属校验、无审计），也不能用 `git clean`/`reset --hard` 处理（会破坏证据且不限于 Runtime 拥有的对象）。同时 §1.1 第一原则禁止为此新增确认：本能力只能是**显式用户命令 + 归属校验 + 审计**，而不是新的审批层。

本轮需要同一轮决定的另一件事（来自 FOUNDATION-019 限制）：Attention 的 `prompt_json` 会原样保存工具输入（可能含文件内容或凭据），是否摘要化。

## Options

1. 回收范围：
   - A. 仅验证副本；
   - B. 三类 Runtime 拥有资源（Task worktree、验证副本、integration worktree）；**（选择）**
   - C. 递归清理整个 `CODEESTRA_HOME` 下未被识别的目录。
2. 失败现场：
   - A. 终态即回收，不做区分；
   - B. 默认保留，显式 `--include-failure-scenes` 才回收；**（选择）**
   - C. 永不回收失败现场。
3. 命令面：
   - A. 只读预览 `reclaim plan` + 执行 `reclaim apply`（同一决策结构）；**（选择）**
   - B. 单一 `reclaim` 命令，默认执行、`--dry-run` 预览。
4. 确认门禁：
   - A. 零确认（显式命令即授权，FULL 与 STRICT 都不新增门禁）；**（选择）**
   - B. `apply` 要求 `--yes`；
   - C. 要求输入资源数量/名称确认。
5. 审计持久化：
   - A. 专用 append-only 表 `reclamation_records`（schema v12）；**（选择）**
   - B. 只写 domain event，不建表。
6. Attention 工具参数：保留原样入库 / Runtime 摘要化 / 只存摘要哈希。

## Decision

### D01：只回收 Runtime 自己拥有的三类资源

- `TASK_WORKTREE`：`workspaces` 行（`path`/`ownership_token`/`branch_ref`）对应的 `<CODEESTRA_HOME>/worktrees/<project-id>/<task-id>`。
- `VERIFICATION_COPY`：`verification_runs.copy_path` 对应的 `<CODEESTRA_HOME>/verifications/<project-id>/<verification-id>`。
- `INTEGRATION_WORKTREE`：`integration_batches.worktree_path` 对应的 `<CODEESTRA_HOME>/integrations/<project-id>/<batch-id>`。

删除对象**只由**这三条记录决定，绝不凭显示名、CLI 传入路径或未校验的 ref。判定顺序（任一不满足即拒绝）：

1. 路径必须绝对，且 realpath 后严格位于对应 owned root 内；路径本身是 symlink 时直接拒绝（`SYMLINK_ESCAPE`），绝不跟随。
2. 该路径必须出现在 `git worktree list --porcelain -z` 的注册记录里，且注册路径与记录路径一致（`UNREGISTERED_DIRECTORY` / `REGISTRATION_PATH_MISMATCH`）。
3. Task worktree 的注册 branch 必须等于 `workspaces.branch_ref`（`BRANCH_MISMATCH`）；detached 副本的 HEAD 必须等于其记录承诺的 commit（验证副本 = `tested_commit`；integration worktree ∈ {`dev_commit`,`merged_commit`,`integrated_commit`}）。
4. 有 held Execution（`executions.resource_held=1`）或 Task 处于 `RUNNING/PAUSING/PAUSED/WAITING_FOR_USER/CANCELLING/RECOVERY_REQUIRED` 时，无论参数如何一律拒绝（`ACTIVE_EXECUTION` / `TASK_NOT_TERMINAL`）。

**不删除任何 branch**，不执行 `git clean`，不执行 `git reset --hard`。Task worktree 回收只移除 checkout 目录并 `git worktree prune` 其注册，`refs/heads/task/<id>` 原样保留。

### D02：默认保留失败现场，显式 opt-in 才回收

- 判定为 failure scene 的条件：Task 处于 `FAILED`/`CANCELLED`、workspace 处于 `RECOVERY_REQUIRED`、worktree 有 tracked/untracked 改动、结果 commit 未合入 `dev`（含“没有结果 commit，无法证明工作已进入 dev”）；验证 run 处于 `FAILED`/`ERROR`；integration batch 处于 `CONFLICTED`/`FAILED`/`RECOVERY_REQUIRED`。
- 默认只回收「完成且静止」的资源：Task `EXECUTED`/`SUCCEEDED` + worktree clean + 结果已合入 `dev` + 无 held Execution；验证 `PASSED`/`STALE`；integration `INTEGRATED`。
- `--include-failure-scenes` 才回收失败现场；即使带该参数，D01 第 4 条的活跃状态与归属校验仍然生效。这样“优先保留失败现场”是默认行为，而不是口头承诺。

### D03：`reclaim plan`（只读预览）与 `reclaim apply` 共用同一决策

- `reclaim.plan` 是 dry run：只读 Git/DB/Filesystem，不写库、不删除，返回与 `apply` 完全相同的 target/action/reason/evidence 形状，因此预览与执行不可能对“什么被拥有”产生分歧。
- `reclaim.apply` 在执行每个删除动作前**重新校验**注册、branch/HEAD、路径归属；apply 会把每一次判断（`RECLAIMED`/`ALREADY_ABSENT`/`RETAINED`/`REFUSED`/`FAILED`）写入审计。已经不在的资源报 `ALREADY_ABSENT`，重复执行天然幂等。
- `reclaim.records` 读取 append-only 审计账本。
- 三个子命令都只输出机器可读 JSON（与既有 CLI 命令一致），并显式接受 `--json` 作为脚本意图；`apply` 有资源删除失败时退出码 1，`retained`/`refused` 是正常决策、退出码 0；未知或未信任项目返回 `NOT_FOUND` 且退出码 1。
- 破坏性命令**不新增确认**：它是显式用户命令，与 ADR-0016 的 pause/cancel/archive 同级别。FULL 的零确认预算保持为 0；STRICT 也不新增（这是用户自己的命令，不是 Agent 副作用）。若将来要把回收接入 Agent 自动路径，则需要单独 ADR 并评估效率成本。

### D04：审计账本 `reclamation_records`（schema v12）

- 每次 apply 在**副作用之前的 operation 行**（`operations.kind='RECLAIM_RESOURCES'`）之后，写入每个被检查资源的账本行：`kind`、`resource_id`、`path`、`ownership_token`、`external_ref`、`resource_state`、`outcome`、`reason_code`、`detail`、`evidence_json`（记录归属证据：注册路径/branch/HEAD、clean/merged 结论、owned root）。
- 账本是 append-only：同一资源再次被检查会追加新行，不覆盖历史。`UNIQUE(operation_id,kind,resource_id)` 只防止同一次操作内重复记账。
- 回收中途崩溃：operation 的 `request_json` 在副作用前保存目标列表与 payload 哈希；Runtime 启动时 `reconcileInterruptedReclamations` 按**真实文件系统状态**判定 —— 已消失的目标记为 `RECLAIMED/RECONCILED_INTERRUPTED` 并补做 workspace→`RELEASED` 的数据库迁移，仍存在的记为 `RETAINED/INTERRUPTED_UNFINISHED` 并留给下一次显式 `apply`。reconcile 自身不删除任何东西。
- Task worktree 的目录被删除后，`workspaces.state` 才置 `RELEASED`（保留 path/branch/token 作为审计）；`releaseWorkspaceForReclamation` 拒绝存在 held Execution 的行，因此回收不可能与活跃 Agent 竞争。
- 未被任何记录识别的目录（例如数据库写入前崩溃留下的空目录、用户手放的文件）一律 `REFUSED/UNREGISTERED_DIRECTORY` 或 `ALREADY_ABSENT`，不删除。未记录且未注册的目录需要人工确认后处理，本轮不提供“清理一切”的开关。

### D05：Attention 工具参数保留原样入库（本轮结论）

- `attention_requests.prompt_json` 继续保存 provider dialog 的完整输入（含工具完整参数，以及标题中用于绑定审批的输入 SHA-256），**不做 Runtime 侧摘要化**。
- 理由：(a) 本机单用户、FULL 主机级权限的信任边界内，数据库目录 0700、socket 0600，与用户在同一终端看得到的工具调用是同一信任级；(b) 审批绑定的是**精确输入**（`CODEESTRA_PERMISSION:<toolCallId>:<tool>:<input sha256>`），截断/摘要会让审计无法复现“当时批准了什么”，也削弱 fail-closed gate 的证据链；(c) 由 Runtime 改写 provider 原始材料属于“机器生成的替代叙述”，与规格反对静默重新解释一致。
- 后果：工具参数可能含敏感内容，会随 `runtime.sqlite` 长期保留；本轮不提供脱敏、加密或轮转。若将来要最小化存储，必须作为独立 ADR（决定摘要/哈希/截断策略与迁移），不在回收能力里隐式改变。

## Consequences

- 用户可以只按 CLI 完成“预览 → 回收 → 查账本”，不再需要手工 `rm -rf` 或停 Runtime；FULL 下无任何新增等待。
- 安全边界是“只删自己注册过的东西”：外来目录、symlink escape、注册/分支/HEAD 不匹配、活跃 Execution 全部拒绝；失败现场默认保留。
- 依赖 GitHub 语义的取舍：未注册目录无法回收，因此极端崩溃（DB 写入前）会留下需要人工确认的目录。这是刻意的诚实缺口，而不是静默删除。
- schema v12 被本 ADR 占用（v11 属于并行的 A1 lane）。合并时 runner 必须保留两条 `version <` 步骤并按升序执行；`reclamation_records` 只依赖既有表，迁移是纯 additive，不改任何既有列。
- 回收只改变 worktree 与 workspace 的**所有权状态**；Task/Execution/Verification/Integration 记录、branch、事件全部保留，与“不级联删除审计”一致。
- 失败现场仍可能被显式回收；`--include-failure-scenes` 会丢弃未提交的 worktree 改动（branch 上的 commit 仍然保留），这是用户显式承担的风险，且会写进账本证据。

## Verification

只通过 CLI/Runtime 命令面与临时仓库验证（ADR-0008），不使用桌面/键鼠自动化：

1. `packages/git/test/reclaim.test.ts`：路径归属、symlink escape、外来目录、未注册目录、branch/HEAD 不匹配、detached 副本 commit 校验、重复回收幂等、stale 注册 prune、脏 worktree 判定、branch 保留。
2. `apps/runtime/test/cli-reclaim.test.ts`：CLI `reclaim plan/apply/records`；EXECUTED+已合入+clean 的 Task worktree 被回收且 branch/用户工作区不受影响；失败现场默认 `RETAIN` 且 `--include-failure-scenes` 才回收；记录路径不属于本 Runtime 时 `REFUSE/PATH_OUTSIDE_OWNED_ROOT` 且外来目录未被删除；held Execution 时 `REFUSE/ACTIVE_EXECUTION`；未知/未信任项目返回 `NOT_FOUND` 且退出码 1；中途崩溃的 operation 由 reconcile 按真实状态收敛且不删除任何东西。
3. `apps/runtime/test/cli-reclaim.test.ts` 的 schema 用例：v10 数据库 additive 升级到 v12、`foreign_key_check` 无违规、账本 CHECK 拒绝非法 outcome。
4. 未验证：真实 macOS/Linux 之外的环境；未注册目录的人工处理流程；跨 project 一次性回收；并发多次 `reclaim apply` 的竞争（当前按 command ID 幂等与 operation 状态拒绝重放，但未做压力测试）；Attention 参数保留决策未做敏感性扫描。

## Related

- `PROJECT_SPEC.md` §1.1 / §2（不变量 7、12、24）/ §3
- `docs/architecture/git-workspace-api.md` §2、§4
- `docs/decisions/0005-task-entry-and-worktree-location.md`
- `docs/decisions/0008-efficiency-first-service-form.md`
- `docs/decisions/0011-default-full-permission-mode.md`
- `docs/decisions/0016-task-pause-cancel-archive.md`（D04）
- `docs/decisions/0018-task-result-integration-into-dev.md`
- `docs/tasks/README.md` FOUNDATION-041
