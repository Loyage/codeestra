# ADR-0058：`task purge` — 任务可被永久删除（任何状态、append-only 的显式例外、已进 ref 即拒绝）

Status：Accepted（用户 2026-09-16 就本格语义逐项明确选择；**无 schema 变更、不占迁移号**；**唯一新增一次显式确认 `--yes`，且它不在任何常态路径上**，见 D07）
任务：本格（`lane/p1-task-purge`，格 1「先删除」）。基线：`dev = 17b4dd6`（schema v31）。

## Context

用户的诉求是两件事，本 ADR 只做第一件（第二件「冲突判定放宽」是下一格）：

> 「任务需要可以被删除，避免影响冲突判断。」
> 「现在的冲突判断太保守了，我需要快，可以把冲突判断改成默认不认为冲突，只有在用户想改进某个功能，但这个功能还没开发完的时候，才视作冲突。」

第一句对应的缺口是**真实存在且已实现能力无法替代的**：

- ADR-0016 D04 只提供 `task archive`：写 `tasks.archived_at`，不删除任何行、不回收 worktree/branch。归档**不影响冲突判定**——判定看的是任务状态与资源占用，不是 `archived_at`。
- 因此一个卡住的任务（`FAILED`/`RECOVERY_REQUIRED`/长期 `PAUSED`，或用户已不再需要的 `CANCELLED` 任务）会永久留在库里，占用冲突判定的输入、占用磁盘上的 worktree 与分支，且**没有任何命令面可以清理它**。`docs/architecture/sqlite-schema.md` 的「默认不级联删除审计」与 `domain-model.md` 的「删除必须另有明确授权」正是把这件事留给一次显式决策。
- 用户本轮确认「删除」就是**物理删除**，不是又一次软删除。

本格动手前实测了三条硬事实（来自迁移后的真实 schema，而不是 `migration.ts` 的文本——多张表被 v7/v9/v24/v28/v30 重建过）：

1. **外键层面没有任何 `ON DELETE CASCADE`**：`tasks` 的传递外键闭包有 **35 张表**（`task_revisions`、`executions`、`agent_sessions`、`attention_*`、`session_*`、`verification_runs`、`impact_*`、`targeted_test_plans`、`execution_slot_reservations`、`reclamation_records`、`task_dependencies`、`workspaces` …），删除必须按 FK 顺序显式逐表进行。
2. **五张任务子表带 append-only `no_delete` 触发器**：`task_revisions`、`impact_snapshots`、`impact_assessments`、`targeted_test_plans`、`execution_knowledge_snapshots`。硬删除与「append-only 证据」直接冲突，必须显式决策谁让路。
3. **三张表记录「这个任务的成果已经进入了某个 ref」**：`integration_batch_items`、`integration_verification_runs`（`task_id` 复合外键指回 `executions`/`task_revisions`）、`stable_promotion_members`。删掉任务就要删掉这些行，而它们正是「哪个 commit 被谁带进 `dev`/`main`」的唯一条目。

## Options

| 选项 | 说明 | 否决理由 |
|---|---|---|
| **A. 新增 `task purge`：最窄的一条硬删除命令**（本格采用） | 显式命令、显式 `--yes`、按归属校验回收资源、在一个事务里删掉任务与其全部子行 | — |
| B. 把 `task archive` 升级成硬删除 | 复用既有命令名 | `archive` 的语义在 ADR-0016 里已经被用户确认为「软删除、保留全部审计」，改名或改义会让已写下的审计承诺失真 |
| C. 不做删除，只让「终态/归档任务退出冲突判定」 | 零风险 | 用户的诉求包含「任务需要可以被删除」本身；且磁盘上的 worktree 与分支仍然永久累积（ADR-0021 的 reclaim 会保分支） |
| D. 用 SQLite 的 `ON DELETE CASCADE` 重建相关表 | 一条 `DELETE FROM tasks` 即可 | 要重建 35 张表；级联删除是**隐式**的，与「外部操作与数据库写入采用可恢复步骤、不假定原子性」相冲突，也让「删了什么」无法在审计里逐项列出 |

用户的逐项选择（本轮问答的实际答复，未答复项不作批准）：

1. 冲突判定的放宽方式（下一格）：**只保留「同一功能声明 + 对方未完成」**，连「改同一文件」也不再拦截。（本格不实现）
2. 「功能」的表达：**复用 `.codeestra/impact.json` 的 `modules[].id`**，`task create --feature <id>`。（本格不实现）
3. 「未完成」的边界：**任何非终态**。（本格不实现）
4. 删除语义：**`task purge` 硬删除 + archive/终态退出判定**。
5. 仍有活动执行或 `RECOVERY_REQUIRED` 的任务：**非终态先自动走「协作停止 + 静止核验」，核验不通过即拒绝且保留现场**（`--force` 不作为一个独立开关，而是内建在 `purge` 上）。
6. append-only 证据：**purge 是唯一显式例外，一并删除**，并在新 ADR 里写明白。
7. 已参与 IntegrationBatch 的任务：**拒绝**，只能用 `task archive`。
8. UI：**CLI + UI 同批**。

## Decision

### D01：`task purge` 是全产品唯一要求显式确认的命令

```
bun run codeestra task purge <project-id> <task-id> <expected-version> --yes [--reason <text>] [--json]
```

- 请求面新增 `task.purge`（`confirmed: boolean`、可选 `reason`）。**缺少 `--yes` → CLI 退出码 2 且不发送任何请求**；`confirmed: false` 的请求由 Runtime 在任何读取之前以 `PURGE_CONFIRMATION_REQUIRED` 拒绝。
- 这是**唯一**一处「显式确认」，也不是审批层或权限门禁：Runtime 不再叠第二次询问，`confirmed` 是调用者自己的声明。**常态路径效率成本为 0**——项目接入、Agent 工具、成果 commit、验证策略、调度、提升、`cancel`/`archive` 全都不经过它；只有「永久删除一个任务」这一次动作需要它。
- 退出码：`0` 成功；`1` 拒绝（`TASK_INTEGRATED_INTO_DEV` / `TASK_IN_STABLE_PROMOTION` / `RECONCILE_REQUIRED` / `PURGE_RESOURCE_NOT_OWNED` / `NOT_FOUND` / `CONCURRENT_MODIFICATION`）；`2` 缺 `--yes`（用法错误）；**不使用 3**（这里没有等待语义）。

### D02：任何状态都可 purge，但非终态必须先被证明已停止

- 任务状态为 `SUCCEEDED` / `CANCELLED` 时直接删除。
- 其它任何状态先走**既有**的协作停止（`pauseOrCancelTask(kind:'CANCEL')`，用派生 command ID，不改写既有事实）：`DRAFT/BLOCKED/READY/EXECUTED/FAILED/PAUSED` 直接 `CANCELLED`；`RUNNING/WAITING_FOR_USER/PAUSING` 先 `CANCELLING` 并请 Adapter 释放 provider 进程，**只有 Adapter 确认进程退出**才落 `CANCELLED`。
- 停止无法确认（`UNCERTAIN`）→ `RECONCILE_REQUIRED`，**什么都不删**。任务本来就是 `RECOVERY_REQUIRED` 时，purge 先执行**与 `task recover` 同一实现**的观察对账（派生 command ID，ADR-0055）：只有能证明 provider 已退出才收口为 `FAILED` 并继续删除（结果里 `stop.stop: "RECOVERED"`）；provider 仍存活 / 记录的后代仍存活 / 身份缺失 / 所有权无法核验 → `RECONCILE_REQUIRED`，**什么都不删**。理由与 ADR-0016/0055 一致：**不删除「可能仍有存活进程」的记录**。
  > **修订（本次）**：原 D02 写的是「本来就是 `RECOVERY_REQUIRED` 就直接 `RECONCILE_REQUIRED`，提示先用 `task recover`」，与 Options 第 5 项「非终态先自动走『协作停止 + 静止核验』」不一致，也让界面上出错的 Task 无路可清（界面没有 recover 入口）。现按 Options 第 5 项把观察对账内建进 purge：安全不变（未证明静止仍拒绝），只是不再要求用户先手敲第二条命令。
- 删除用的 `expectedVersion` 是**停止之后**读到的版本：调用者的 `expectedVersion` 描述的是他看到的状态，停止合法地移动了它，两者都被记账。

### D03：append-only 是显式例外，且只在 purge 事务内让路

- `task_revisions`、`impact_snapshots`、`impact_assessments`、`targeted_test_plans`、`execution_knowledge_snapshots` 的 `_no_delete` 触发器在 purge 事务内被**读出 `sqlite_master` 的原文 → DROP → DELETE → 原文重建 → 复核数量**。触发器的 SQL 不硬编码，迁移改写过的定义会被原样恢复；**失败即抛错并整笔回滚**（DDL 在 SQLite 里是事务性的）。
- 任一期望中的 `_no_delete` 触发器**不存在**即 `INVALID_STATE` 拒绝：这条路径永远不能变成「append-only 可以悄悄绕过」。这是 `appendOnlyTaskTables` 列表同时承担的实现与守卫。
- `knowledge_snapshots`（项目级知识快照）**不删**：它不是任务子行，purge 对项目级知识没有主张。

### D04：数据库是「整个子图或什么都没有」，外键仍然被检查

- 一次 `PRAGMA defer_foreign_keys=ON` 把全部外键检查推迟到 commit：这让 35 张表的删除顺序成为**文档**而不是正确性前提（`tasks.current_revision_id` ↔ `task_revisions.task_id`、`agent_sessions.current_incarnation_id` ↔ `session_incarnations.session_id`、`tasks.pending_retry_from_execution_id` → `executions` 都是环）。**外键不被关闭**，留下悬空引用仍然会让整笔事务失败。
- `intent_targets`（按 `task_id` 引用任务）删除；`domain_events`、`command_receipts`、`operations`、`intents`（项目级审计）**保留**：purge 删除 Runtime 拥有的行，不删除「发生过什么」。任务自己的历史事件因此仍可在事件流里读到，并以最后一条 `TaskPurged` 收口。
- `task_dependencies` 中该任务作为任一端点的边一并删除，删除条数在返回值与审计里明示（`dependencyEdgesRemoved`）。这是**可见的**语义后果：依赖它的任务会重新判定，而不是静默解封。

### D05：资源回收走既有归属校验，先删 worktree/验证副本，再删分支

- 复用 ADR-0021 的 `planReclamation` / `applyReclamation`（`kinds = TASK_WORKTREE + VERIFICATION_COPY`，`includeFailureScenes: true`，派生 command ID）。**plan 阶段只要有一个 target 不是 `RECLAIM`/`ALREADY_ABSENT`**（活跃预留、`TASK_NOT_TERMINAL`、symlink 逃逸、注册路径不符、分支不符…）→ `PURGE_RESOURCE_NOT_OWNED`，**一行都不删**。
- 分支删除由新增的 `packages/git/src/purge.ts`（`deleteOwnedTaskBranch`）承担。`reclaim.ts` 明确声明「不删分支」（ADR-0021/0042 要保持分支以便重建），purge 恰好相反，所以它是独立的一小片表面：只接受本地分支；**被任何 worktree 检出的分支拒绝**；删除是 `git update-ref -d <ref> <expected-tip>` 的**比较交换**；删除前读出 tip 并记入审计——**分支是任务未合入的生长，它消失了，它指向的 commit 不会**。
- 顺序是 plan（只读）→ apply（worktree/副本）→ 分支 → 数据库事务。任一步失败即中止并**不删数据库行**；此时 `reclaim.records` 与 workspace 行仍如实描述已发生的删除（ADR-0042 的 REBUILD 路径可恢复），这是「可恢复步骤」而非「原子」。

### D06：成果已进入 ref 的任务一律拒绝

- `integration_batch_items` / `integration_verification_runs` 有行 → `TASK_INTEGRATED_INTO_DEV`；`stable_promotion_members` 有行 → `TASK_IN_STABLE_PROMOTION`。在事务内**重新检查**（调用方的前置答案是证据，不是决定）。
- 后果必须写明：`SUCCEEDED` 按定义是在成果进入 `dev` 之后才写的（ADR-0053），所以**每个 `SUCCEEDED` 任务都会被拒绝**，`purge` 的常规对象是 `CANCELLED`（以及取消过的 `FAILED`）任务。这正是我们要的不变量：**`dev`/`main` 里已有的 commit 永远保留「谁把它带进来的」这一条目**，需要隐藏它的用 `task archive`。

### D07：命令幂等由收据承担，因为任务已经不存在

- 常规前置检查（读任务）在重放时必然 `NOT_FOUND`，所以 purge **先查 `command_receipts`**：相同 command ID + 相同 payload hash → 返回上次的记录结果（`replayed: true`）；hash 不同 → `COMMAND_CONFLICT`。收据不是 purge 形状的也一律 `COMMAND_CONFLICT`，不做「大概是同一条命令」的猜测。
- 不新增墓碑表（用户未选「墓碑 + 硬删除」）：留下的是 `command_receipts` 的收据、项目级 `TaskPurged` 域事件与 `intents`，它们都不是任务行。

### D08：`TaskPurged` 事件与 UI 投影

- 新域事件 `TaskPurged`（`aggregate_type='Task'`、`aggregate_id=被删任务`、`aggregate_version=删除前版本+1`），在**同一个事务**里写入。payload 记录：最终状态、`archived`、`currentRevisionId`、逐表删除行数、`dependencyEdgesRemoved`、每个被删分支的 `{branchRef, tipCommit, deleted, detail}`、每个被回收资源的 `{kind, resourceId, path, outcome, reasonCode, branchRef}`、被让路的 append-only 触发器名单、操作者与 `reason`。
- **不做**「删除即遗忘」：事件没有外键，任务行消失后它仍在 `events.list`/SSE 里可读。
- UI（`apps/ui/src/task-purge.tsx`）只是同一命令面的投影：危险区折叠块 + **输入该任务编号才启用**的按钮 + 可选原因输入；发送的就是 CLI 那一条请求（`confirmed: true`），**不自己判断可删性**，拒绝按 Runtime 返回的稳定码显示。它不碰 Git、不删文件。

## Consequences

- 已实现：`packages/contracts/src/index.ts`（`task.purge` 请求 + `TaskPurgeOutcomeView`）；`packages/storage/src/database.ts`（`inspectTaskPurge` / `inspectTaskPurgeBlockers` / `purgeTask` / `findTaskPurgeByCommand`、`taskPurgeDeletions`、append-only 触发器让路与复核、两个新的稳定拒绝码）；`packages/git/src/purge.ts`（新）；`apps/runtime/src/task-purge-service.ts`（新）与 `apps/runtime/src/main.ts` 接线；`apps/cli/src/main.ts`（`task purge` + `usage()`）；`apps/ui/src/task-purge.tsx`（新）+ `App.tsx` 接线 + `styles.css`；本 ADR、`docs/decisions/README.md`、`docs/architecture/event-model.md`、`docs/architecture/sqlite-schema.md`、`docs/architecture/domain-model.md`、`docs/architecture/state-machines.md`、`docs/guides/{cli-reference,ui,manual,troubleshooting}.md`、`docs/tasks/README.md`、`PROJECT_SPEC.md` 状态段。
- **无 schema 变更**：不新增表/列/触发器，`phase1SchemaVersion` 仍为 31，`v16` 继续永久未使用。删除是数据操作，不是结构变化。
- 明确的已知后果（不掩盖）：
  - `SUCCEEDED` 任务实际上无法 purge（D06），它们只能归档；这是有意的。
  - 删除一个任务**会连带删除跨任务的事实**：指向它的依赖边（会改变下游任务的依赖判定）、以及另一方 `impact_assessments` 中与它配对的那一行。前者在返回值与审计里明示，后者是「配对判定的另一半已不存在」的必然结果。
  - 「删除了什么」在逐表行数层面是完整的，但**不保证可恢复**：没有墓碑、没有备份；分支 tip 与 revision id 只留在 `TaskPurged` 事件的 payload 里。
  - 非终态任务的 purge 会**先真实地终止它**（协作停止，可能中断正在运行的 Agent）。这是用户选择的语义，不是副作用。
- 效率：FULL 下常态路径新增确认 **0 步**；`task purge` 自身需要一次 `--yes`（CLI 层面），UI 需要输入任务编号——两者都是**显式用户命令**的组成部分，不是审批层。

## Verification

只用 CLI/命令面与 Runtime 命令面（含临时 `CODEESTRA_HOME` 与临时仓库）断言（ADR-0008），不使用浏览器/桌面/键鼠自动化。定向测试按 ADR-0038 只跑下列文件（本格在 lane 分支上，**未**运行全量 `bun run check` / `just check`）：

1. `packages/storage/test/task-purge.test.ts`（4 项，`bun test`，**通过**）：已进 IntegrationBatch → `TASK_INTEGRATED_INTO_DEV` 且一行未删（任务、revision、batch item 仍在，无 `TaskPurged` 事件）；两个任务的配对快照 + 一条判定 → 只删本任务那侧的快照与判定、另一任务快照保留、项目级 `TaskStateChanged` 与新的 `TaskPurged` 都在且顺序正确、`PRAGMA foreign_key_check` 为空；同一 command ID 重放返回收据（`purgeTask` 二次调用不报错且 `purgedAt` 相同）、不同 payload hash → `COMMAND_CONFLICT`；**人为 DROP 一个 `_no_delete` 触发器后 purge 拒绝**且任务仍在、其余四个触发器随回滚复原。
2. `packages/git/test/purge.test.ts`（3 项，`bun test`，**通过**）：无附加分支被删除并回报 tip（`cat-file -t` 仍为 commit）；被 worktree 检出的分支 → `BRANCH_CHECKED_OUT` 且分支仍在；按读到的 tip 做比较交换、缺失分支 → `ALREADY_ABSENT`、非本地分支 ref → `NOT_A_LOCAL_BRANCH`。
3. `apps/runtime/test/cli-task-purge.test.ts`（2 项，`bun test`，**通过**，真实 CLI + 真实 Runtime + 独立 `CODEESTRA_HOME` + 真实 worktree/branch）：`EXECUTED` 任务 `--yes` 删除 → 退出码 0、先 `CANCELLED`（`stop.state='CANCELLED'`）、`plan.worktrees=1`/`branches=1`、`branchFacts[0].tipCommit` 是 40 位 OID、`rowsDeleted` 含 `task_revisions`/`executions`/`workspaces`/`tasks`，**worktree 目录与分支都真的消失**、`task list --all` 不含它、`task status` 以 `NOT_FOUND` 退出 1，且五个 `_no_delete` 触发器事后都在；缺 `--yes` → 退出码 2、worktree 与分支仍在、任务仍是 `EXECUTED`。
4. `apps/ui/test/task-purge.test.ts`（3 项，`vitest`，**通过**）：输入框只接受该任务的编号（`012`/空白通过，`#12`/别的编号/非数字/空/负数不通过）；`purgeCommand` 发送 `confirmed: true` 且空原因不带字段、原因被 trim；结果行如实说出被删行数、工作树/验证副本/分支数量、删除前的终止与依赖边数量，以及分支 tip。

5. `apps/runtime/test/task-purge-recovery.test.ts`（3 项，`bun test`，**通过**，本次修订新增）：`RECOVERY_REQUIRED` 任务在观察为 `STOPPED` 时先写 `TaskRecoveryReconciled` 再写 `TaskPurged`、worktree 与分支真的消失、结果 `stop.stop='RECOVERED'`/最终状态 `FAILED`；观察为 `ALIVE` 或无 provider 身份时 `RECONCILE_REQUIRED` 且任务仍 `RECOVERY_REQUIRED`、worktree 仍在、无 `TaskPurged`。

未验证（不得声称）：`PURGE_RESOURCE_NOT_OWNED` 的真实 Git 竞态、reclaim 与分支删除之间崩溃的恢复全流程、UI 的实际点击（ADR-0008 边界）。

## 关联文档

- `PROJECT_SPEC.md` §1.1（效率至上、CLI 完备、测试仅限命令面）、状态段
- ADR-0016（`archive` 是软删除、`cancel` 是终态、回收独立——本 ADR 是它 D04「本轮不提供物理删除」的后续决策）、ADR-0021/0037/0042（归属校验与可重建性）、ADR-0053（`SUCCEEDED` 只在成果进入 `dev` 之后写入，因此必然被 D06 拒绝）、ADR-0055（`RECOVERY_REQUIRED` 只能按观察对账）、ADR-0008/0011（零确认与 CLI 完备）、ADR-0038/0039（定向测试与证据绑定）、ADR-0050（本文档同步纪律）
- `docs/architecture/sqlite-schema.md`（append-only 的唯一例外）、`docs/architecture/event-model.md`（`TaskPurged`）、`docs/architecture/domain-model.md`（删除语义）、`docs/architecture/state-machines.md`（任务行消失，不是新状态）
- `docs/guides/cli-reference.md` §`task purge`、`docs/guides/ui.md`（任务工作台危险区）、`docs/guides/manual.md`、`docs/guides/troubleshooting.md`
