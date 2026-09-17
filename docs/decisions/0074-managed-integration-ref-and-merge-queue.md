# ADR-0074：受管 integration ref、持久 merge queue 与 Task 基线切换（S8）

Status：Accepted（本次用户选择题确认：ref 命名/初始化时机/CLI 归属/Task 基线切换四项均为推荐项）；**已实现于 schema v38**。本 ADR 只冻结 [ADR-0070](0070-service-process-signal-kernel.md) D07 留给 S8 的**准确拼写与落地边界**，不改变 D07 的目标语义。

**Amends** ADR-0066 的「Task 基线只有一种：项目文件夹建 workspace 时当前检出的分支」——基线来源改为 Project Service 的受管 integration commit；ADR-0066 关于「产品不发布、不恢复旧 promotion」的部分继续有效，并由本 ADR 明确保留。

## Context

ADR-0070 S1–S7 已把 Service/Process/Signal 内核、Process 完成写路径、intention 结构化路由与 Project/Task 创建单一写路径落地，但 D07 的受管集成仍只有目标语义：

- integration ref 的**精确名字**、命名空间与初始化时机未定；
- CLI facade 的**准确拼写**未定（D09 只给了 `service/process/signal/intent`）；
- 新 Task 是否以及何时改从 integration commit 建基线未定（ADR-0066 仍是唯一的兼容规则）；
- 「integration ref 如何发布到用户 main/release」被 D07 明确排除，本 ADR 也不回答。

没有这些决定就无法实现 D07 的验收（两项目并行、同项目串行、用户工作树不被碰、Task A 合入后新 Task B 可达 A、ref 外部移动 `STALE` 不 force）。

## Options

### D01 integration ref 的命名与位置

- **A（选中）`refs/codeestra/integration`**：私有命名空间，不在 `refs/heads/*`。`git branch` 列不出、默认 `push` refspec 带不走、任何 checkout 都不可能停在它上面，于是「Codeestra 独占这条 ref」是命名空间的性质而不是约定。worktree 用 `--detach`，ref 前进用 `git update-ref <new> <expected-old>`（原子 CAS）。每项目仓库一个固定名（`projects.repo_root` 唯一，一个仓库就是一个项目）。
- B `refs/heads/codeestra/integration`：普通本地分支，Git 原语与 `worktree add -b` 最自然、用户可 `git log` 直接审阅；代价是出现在 `git branch`、可能被误检出/误推，需要额外守卫，且「分支」会诱使人们把它当成可以自己 merge 的对象。
- C `refs/codeestra/<project-id>/integration`：同样私有，但多一段通常冗余的 project id，只在一仓库多项目时才有意义（当前 schema 不允许）。

### D02 初始化时机

- **A（选中）`project trust` 时创建，缺失时补建**：trust 已经核验 canonical root / main ref / HEAD，同一步顺手把 ref 建到**当时项目文件夹检出的分支 commit**，`= 0 步 0 等待`。v37 迁移来的既有项目在**首次需要时**（解析 Task 基线）按当时项目文件夹检出的分支补建；已存在的 ref 永不被移动。规则统一、无隐藏 lazy 语义。
- B 首次 `task create` 时惰性创建：trust 完全不碰仓库 Git，但初始化前后 Task 基线来源不同，需要有隐藏状态。
- C 显式 `project integration init`：能力变成 opt-in，把「受管集成」变成用户必须记住的额外一步，与 ADR-0008 的效率原则相悖。

### D03 CLI facade

- **A（选中）挂在既有 `project` 组**：`project integration status|init|queue|request|run|retry|cancel`，加只读 `task integration show`。integration 不是内核一等对象（内核里由 Project Service 持有），挂到 `project` 与「Project Service 独占 integration ref/worktree」一致，也避免在命令树里多一层与 `project` 重复的顶层组。
- B 新顶层 `integration`：跨项目查询更顺，但会与 `project` 语义重复。
- C `task merge ...`：贴近「Task 成果要合并」的视角，但队列是项目级事实，读队列要从 task 反查项目。

### D04 Task 基线切换

- **A（选中）本轮即切换为默认**：新 Task 默认从 integration ref 当时 OID 建固定 base；`--base-ref` 仍可覆盖为项目本地分支；既有 workspace 不回写；依赖释放改读「结果 commit 对 integration ref 可达」。任务之间因此真正串行累积。
- B 默认不切，只加显式 `--base-ref refs/codeestra/integration`：风险更低，但本轮「受管集成」只有显式使用时成立，且默认路径仍会把成果留在用户分支上。
- C 基线切、依赖释放暂不切：两套判定并存，会出现「上游已 `MERGED` 但下游仍 `BLOCKED`」的解释缺口。

### D05 首个切片要不要 Integration Process

- **A（选中）不创建 Integration Process/Agent**：ADR-0070 D05 允许它在复杂合并时出现，但本轮只交付确定性路径——Git merge（`--no-ff`）、独立 Integration Verification、CAS 推进。冲突**如实报告并保留现场**，不自动解决、不交给模型。
- B 冲突时创建 Integration Process 让 Agent 解决：引入「Agent 改 integration ref」的非确定路径，需要 Project Git API、预算与归属校验先行，超出本轮。

## Decision

1. **ref**：`refs/codeestra/integration`（`packages/domain/src/managed-integration.ts` 的 `managedIntegrationRef`）。worktree 位于 `<CODEESTRA_HOME>/integration/<project-id>/`，detached。
2. **初始化**：`project trust` 调用 `ManagedIntegrationService.initialize`（幂等，`INSERT OR IGNORE` 语义的 `git update-ref <ref> <commit> ''`）；`project integration init` 是同一件事的显式入口；Task 基线解析在 ref 缺失且文件夹有检出分支时补建；detached HEAD 且 ref 缺失 → 基线无法建立（`TASK_BASE_REF_UNRESOLVED` / 依赖按未满足）。
3. **队列**：`merge_queue_items` 持久化，`(project, idempotencyKey)` 与 `(task, revision)` 双幂等；`MERGING`/`VERIFYING` 上的部分唯一索引 `one_active_integration_per_project` 让「同项目一次只有一个活动集成」成为数据库事实；顺序 `priority desc → requested_at asc → id asc`；同一 Task 的新 revision 入队把旧 `QUEUED` 请求记为 `STALE`。
4. **执行**：`project integration run` 一次推进队首一条（`item-id` 必须是队首）。顺序是「claim（CAS + 唯一索引）→ 读 ref 当时的 OID 作为 expected → 在 owned worktree 里 `--no-ff` 合并 → 候选 ref（`refs/codeestra/candidates/<item>`）→ 独立 Integration Verification（候选 commit 的独立副本，策略取自项目 main ref，落在 `INTEGRATE_TASK` 持久 Operation 上，ADR-0019）→ `git update-ref` CAS → item `MERGED` + Task 投影 `MERGED` + `TASK_MERGE_SETTLED` 通知 → 删掉候选 ref」。下一条保持 `QUEUED`，不自动接续。
5. **前置条件**：Task 当前 revision、该 revision 捕获的 result commit、以及对该 `(revision, commit)` **PASSED** 的 Task verification run。缺一以具名稳定码拒绝，不入队。
6. **失败**：冲突 → `CONFLICTED`（保留冲突中的 worktree，阻塞该项目队列，`retry` 复位后重排）；验证失败 → `FAILED`（保留候选 ref 与副本）；验证期间 ref 被移动 → `FAILED` + `INTEGRATION_REF_MOVED`（**不 force**）；Runtime 中途重启 → `RECOVERY_REQUIRED`（worktree/候选 ref/副本原样保留，不自动重跑）；无验证策略 → `INTEGRATION_POLICY_ABSENT`。
7. **不作为**：不发布 ref 到任何用户分支（D07 排除，不恢复 `promotion *`）；不创建 Attention 行（v38 的 `attention_requests.session_id` 是指向 Agent 会话的非空外键，与 ADR-0072 D01 同一边界）；不自动回收（仍是显式 `reclaim`）；FULL 下零确认，STRICT 只沿用既有验证策略确认。
8. **Task 基线**：`resolveTaskBaselineRepository` 默认返回受管 integration ref 及其当时 commit；`--base-ref` 仍只接受本地分支或该 ref；依赖释放、回收的「已合并」判定、workspace 准备都读同一条 ref。既有 workspace 的 `base_ref` 不回写。

## Consequences

### Positive

- 多 Task 的成果自动汇合到一条 Codeestra 独占的 ref；用户工作树与分支不被写。
- 「同项目串行、跨项目并行」由数据库约束保证，不依赖调用者自律。
- 失败现场（worktree、候选 ref、验证副本）可核验，`STALE`/`MOVED` 不会被 force 掩盖。
- Task 之间的先后关系变成 Git 事实（结果 commit 对 integration ref 可达），依赖判定因此与「成果是否真的合进去了」一致。

### Costs and risks

- **Task 基线语义改变**：移动用户自己检出的分支不再影响新 Task；依赖释放的读法随之改变（本仓库自身的历史测试与文档都已按 ADR-0074 同步）。
- 老项目第一次解析 Task 基线时会在仓库里创建一个 ref（`refs/codeestra/integration`）：这是可观测的新行为，且只在缺失时发生。
- 「已合进 integration ref」不等于「已到用户 main/release」：用户仍需自己决定怎么发布（本 ADR 不提供、也不假装提供该能力）。
- 冲突目前只能人工 `retry`/`cancel`；没有 Agent 辅助解决的路径（D05 A）。这与「不谎报能力」一致，但确实比旧的多成员 IntegrationBatch 少了自动冲突处理。
- 集成验证会重跑项目验证策略（在候选 commit 的独立副本上），因此一次集成可能耗时等于一次策略执行；这是独立证据的代价。

## Verification

已实现并由定向测试覆盖（`.codeestra/tests.json` 的 `managed-integration-*` 与 `cli-managed-integration`）：

1. `packages/domain/test/managed-integration.test.ts`：ref 名与命名空间、queue FSM 与终态、并发槽、投影派生、队列排序、CAS 判据。
2. `packages/storage/test/managed-integration-migration.test.ts`：真实 v37→v38 文件升级不丢行、双幂等与部分唯一索引、零部分应用的拒绝、integration run 一次性终态、集成记录不可删除。
3. `apps/runtime/test/managed-integration-service.test.ts`（真实临时仓库）：merge→验证→CAS 推进 ref；冲突保留现场并阻塞队列且可 `retry`；验证期间 ref 被移动不前进；验证失败不回退 ref；无策略拒绝；重启按 `RECOVERY_REQUIRED` 收口；`cancel` 只在 `QUEUED`。
4. `apps/runtime/test/cli-managed-integration.test.ts`（真实 CLI + Runtime + 临时仓库）：`project trust` 物化 ref；`status/queue/run` 的 JSON 与退出码；已验证结果入队并合入且 Task 投影 `MERGED`；**第二个 Task 的 result commit 以 integration commit 为祖先，而该 commit 不是用户 `main` 的祖先**；用户工作树保持 clean、仍在 `main`；用法错误一行且不启动 Runtime。

未覆盖、必须如实声明的部分：

- **Integration Process/Agent**：未实现（D05 A）。
- **发布出口**：未实现、未定义；没有 `promotion *`。
- **Attention 行**：内核级冲突不产生 `attention_requests` 行（v38 外键约束）。
- **真实 provider 下的集成验证**：本轮的证据来自真实 Git 仓库与真实验证命令，但集成验证跑的是项目策略而非真实模型；「Agent 解决冲突」没有任何实测。
- **跨项目并发集成**：队列串行由数据库约束与测试证明；两个项目同时跑真实验证尚未压力测试。

## Related

- [ADR-0070](0070-service-process-signal-kernel.md)（D05/D07/D09 的目标语义）
- [ADR-0066](0066-remove-dev-clone-and-dual-baseline.md)（本条 amend 其基线规则，保留其「不发布」结论）
- [ADR-0008](0008-efficiency-first-service-form.md) / [ADR-0011](0011-default-full-permission-mode.md)（0 步 0 等待、FULL 零确认）
- [ADR-0019](0019-long-command-operations.md)（集成验证是持久 Operation）
- [ADR-0038](0038-branch-targeted-tests-and-dev-full-suite.md) / [ADR-0039](0039-layered-verification-evidence.md)（证据绑定 revision/commit）
- [ADR-0050](0050-user-manual-and-doc-sync-discipline.md) / [ADR-0063](0063-split-cli-reference-by-command-group.md)（用户文档同步与落点）
- [ADR-0058](0058-task-purge.md)（沿用「只有证明 provider 已退出才继续」的收口纪律）
- [ADR-0072](0072-kernel-intention-clarification-fact.md)（同一边界：内核级事实不能凭空造 Agent 会话外键）
- `docs/architecture/service-process-signal.md`、`docs/architecture/git-workspace-api.md`、`docs/architecture/state-machines.md`、`docs/guides/cli/managed-integration.md`
