# ADR-0053：多成员 IntegrationBatch（批级 `STALE`／`CANCELLED`、成员级部分失败、一次批次验证）

Status：Accepted（实现随 FOUNDATION-081 落地，schema v30）。**不新增任何门禁或确认**（ADR-0011 不变）。

## Context

ADR-0018 定义了「Task 的结果提交经 IntegrationBatch 进入 `dev`」，但只实现了**单成员**形态：
`integration_batch_items` 的主键 `(batch_id,task_id)` 已可承载多成员，`task.integrate` 每次却只接受一个
Task、只固定一个 revision/commit。其后果不是「少一个便利功能」，而是三条真实事实：

1. **产品提升路径缺证据**。ADR-0022/ADR-0047/0052 的 `promotion prepare` 需要「IntegrationBatch 的集成
   验证证据」；本仓库自身的四次 `dev → main` 提升都走 `AGENTS.md` 的人工路径，产品批次从未为它们产生证据。
   要在一个批次里表达「这一批 Task 一起进入 `dev`」，就必须真的支持多成员。
2. **批级终态缺失**。既有状态集合只有 `CREATED/PREPARING/VERIFYING/INTEGRATING_DEV/INTEGRATED/
   CONFLICTED/FAILED/RECOVERY_REQUIRED`：**「固定证据已经过期」与「用户不再需要这个批次」都没有位置**，
   于是前者只能被写成 `FAILED`（把「世界变了」说成「操作失败」），后者只能不动它（一个永不使用的批次
   长期占用成员）。本格实测确认了这一点：`dev` 在集成期间被移动时，旧实现写 `FAILED/DEV_REF_MOVED`。
3. **部分成功的可读性**。`failIntegrationBatch` 原来把**所有** `PREPARED`/`MERGED` 成员一并改写为
   `FAILED`/`CONFLICTED`。多成员批次里，一个成员合并成功、下一个成员冲突时，这个写法会把已发生的合并
   抹掉——既不诚实地报失败，也让「哪一步真的发生了」不可追溯。

同时必须守住既有不变量：失败不动 `dev`、保留现场、`dev` 被检出时拒绝、推进用 CAS、幂等、崩溃按 ref 事实
reconcile、成员清单不可被静默改写。

## Options

1. **批次如何组成**：(a) 扩展现有 `task integrate` 的载荷，在一次调用里同时组成并集成 N 个成员；
   (b) 显式两步：先 `task integration create`（组成，固定成员与基线），再 `task integration integrate`
   （合并、验证、推进）。
2. **成员顺序**：(a) 按命令行给出的顺序；(b) 按 `task_id` 排序（确定性，与请求顺序无关）。
3. **批级「证据过期」的表达**：(a) 复用 `FAILED` + `outcome_code`；(b) 新增一等终态 `STALE`。
4. **批级取消**：(a) 不做；(b) `CREATED` 且记录中无任何 Git 副作用时落 `CANCELLED`，否则落
   `RECOVERY_REQUIRED/RECONCILE_REQUIRED` 并保留占用；(c) 任何状态都可直接 `CANCELLED`。
5. **一个成员失败时其他成员的状态**：(a) 全部改写为失败；(b) 只标失败者，已合并者保留 `MERGED`、
   未尝试者保留 `PREPARED`。
6. **schema**：(a) 新增表/列表达 `STALE`/`CANCELLED`；(b) 重建 `integration_batches` 以加宽 `state` 的
   `CHECK`（占 v30）。
7. **`task integrate`（单 Task 一行式）是否保留**：(a) 保留为「一个成员批次」的简写；(b) 删除，只留两步。

## Decision

选择 1(b)、2(b)、3(b)、4(b)、5(b)、6(b)、7(a)。

### D01：组成与集成是两个命令，`task integrate` 保留为单成员简写

- **`task integrate <project-id> <task-id> <expected-version>`**（退出码见 D06）：**不变**——它等价于
  「组成一个成员批次并立刻集成」，这是既有命令面与既有测试所依赖的形态。
- **`task integration create <project-id> --member <task-id>:<expected-version> …`**：组成批次，
  **不碰 Git**。每个成员在写入前核验：Task 是 `EXECUTED`、`expectedVersion` 匹配、当前 revision 有一个
  `SUCCEEDED` 且已捕获结果提交的 Execution、并且存在**同一 revision 同一 commit** 的 `PASSED`
  Task 验证。全部成员一次性校验、全部失败即整体拒绝（不写半批）。批次同时固定 `dev` 基线
  （`devRef` + `devCommit`）与项目验证策略摘要，因此 `CREATED` 的含义是「已固定、可集成」，而不是
  「尝试过」。
- **`task integration integrate <project-id> <batch-id>`**：合并 → 一次独立集成验证 → CAS 推进 `dev`。
- **`task integration list <project-id> [task-id]` / `get <project-id> <batch-id>`**：读回批次与成员。
  `list` 的 `taskId` 变为可选：多成员批次跨多个 Task，按 Task 过滤会看不到完整成员清单。
- **`task integration cancel <project-id> <batch-id> [--reason <text>]`**：见 D04。
- 已存在的、覆盖同一成员且未结算的批次会**拒绝**组成（稳定码 `INTEGRATION_IN_PROGRESS`），
  因为两个批次都以为自己固定了该成员的结果提交。

### D02：成员按 `task_id` 排序，请求顺序不是批次的一部分

成员在写入、读取与合并三处一律按 `task_id` 排序。理由是**同一成员集合必须产生同一次集成**：
若按命令行顺序合并，同一组 Task 因参数顺序不同就会得到不同的合并提交与不同的验证对象，
`promotion prepare` 之后的「同一个 dev SHA」也就不再是对同一件事的复核。CLI 的 create 输出会打印
实际成员清单，请求顺序不被静默使用也不被静默改写。

### D03：一个批次 = 顺序合并 + 一次覆盖整批的独立集成验证

- 合并在同一个 detached integration worktree 中**顺序**进行：第 i 个成员的 `baseline` 是前 i-1 个成员的结果，
  可行性判定沿用既有 `mergeResultCommit` 的规则（能 ff 就 `--ff-only`，否则 `--no-ff`，第一父必须是固定基线，
  候选必须是其后代）。
- 批次级 `merge_strategy`/`merged_commit` 取**最后一个成员**的那一步：最终树要么正好是最后一个候选
  （每一步都 ff），要么是最后一步产生的合并提交。这与既有单成员语义一致。
- **一次**独立集成验证（`integration_verification_runs` 的 `UNIQUE(batch_id)` 不变）跑在最终合并提交上；
  它的 evidence 里记录**整批成员**的 `taskId/revisionId/executionId/candidateCommit` 与各自的
  Task 验证 ID/commit，因此「这次验证判的是哪一批事实」可读。只有 `PASSED` 才以 CAS 推进 `dev`。
- 每个成员的合并单独落一条 `IntegrationMemberMerged` 事件与成员状态，合并到哪一步可追溯。

### D04：批级 `STALE` 与 `CANCELLED` 是两个不同的终态

- **`STALE`**：批次固定的证据不再是当前事实。两个触发点，二者都不合并、不推进、不改写已记录的成员结果：
  - `MEMBER_EVIDENCE_MOVED`：某成员的 Task 不再是 `EXECUTED`／当前 revision 已不是批次固定的 revision／
    其 Execution 已不是 `SUCCEEDED` 且结果提交等于固定候选／该 revision+commit 的 `PASSED`
    Task 验证不再存在；
  - `DEV_REF_CHANGED`：项目重新 trust 后基线 ref **名字**变了（批次固定的是旧名字）；
  - `DEV_REF_MOVED`：集成的 CAS 没能从记录的基线推进 `dev`（`dev` 在批次组成后、验证期间被移动）。
    **这是对既有行为的收窄**：旧实现写 `FAILED/DEV_REF_MOVED`，本 ADR 起写 `STALE/DEV_REF_MOVED`
    ——`outcome_code` 不变，状态从「失败」改为「证据过期」。理由：候选本身没有失败，失败的是
    「候选相对某个基线」这个前提；把它写成 `FAILED` 会让用户以为需要重试同一个批次。
  - 具体：批次进入 `STALE` 时，成员状态**保持原样**（未合并的仍 `PREPARED`），成员/Task 状态不被改写，
    Operation 落 `FAILED` 且 `result_json.state='STALE'`，并写 `IntegrationBatchStale` 事件。
- **`CANCELLED`**：只有**记录本身能证明没有未结算的成员副作用**时才落，即批次仍在 `CREATED` 且
  `worktree_path`/`merge_strategy`/`merged_commit`/`verification_id` 全为空。否则落
  `RECOVERY_REQUIRED/RECONCILE_REQUIRED` 并**保留占用**（阻塞新批次、不自动清理），因为「合并已发生但没回写」
  「验证副本可能还在被写」「ref 可能已经写过」都不是运行时能从自己的记录里排除的。**取消不新增确认**：
  FULL 与 STRICT 下都零确认（它写的是一个从未碰过 Git 的批次的终态），符合 ADR-0011。
- 两个终态都是**终态**（不阻塞新批次），但 `RECOVERY_REQUIRED` 不是：它继续占用成员，直到人工按记录的
  ref/证据事实处理。

### D05：部分失败如实可读

一个成员的合并失败（冲突或 Git 失败）时：**只有该成员**被写成 `CONFLICTED`/`FAILED`（并带 detail），
已经合并的成员保持 `MERGED`，尚未尝试的成员保持 `PREPARED`，批次落 `CONFLICTED`/`FAILED`，`dev` 不动、
integration worktree 保留。批次级失败（验证失败、检查失败）不指向任何成员，因此成员保持 `MERGED`
（它们的合并确实发生了）。**任何情况下都不会把部分成功写成整批成功**：只有全部成员 `MERGED` 且验证
`PASSED` 才会出现 `INTEGRATED`。

### D06：集成命令族的退出码

`task integrate`、`task integration integrate`、`task integration cancel` 统一：

| 退出码 | 含义 |
|---|---|
| `0` | `dev` 已按本批次的证据推进（`INTEGRATED`）；或取消/读取得到已记录的终态 |
| `1` | 拒绝（请求不合法、前置条件不满足、策略未确认）或已记录的**非集成终态**（`FAILED`/`CONFLICTED`/`STALE`/`CANCELLED`） |
| `2` | 用法错误（既有 `usage()`） |
| `3` | 批次未收口、需要人工先处理（`RECOVERY_REQUIRED`） |

退出码 3 沿用既有约定（ADR-0052 的 `AWAITING_PULL`、调度等待）：它表示「不是被拒绝，而是世界需要先改变」。
`--json` 输出即为记录的批次/报告本身（`task integration list|get|create|cancel` 与 `task integrate` 都是
JSON 输出；`--json` 在这些命令上是显式同义写法）。

### D07：schema v30 只加宽一个 `CHECK`，不新建表

`integration_batches.state` 的 `CHECK` 加宽为含 `STALE`、`CANCELLED`。`STRICT` 表的 `CHECK` 无法就地加宽，
因此 v30 **重建** `integration_batches`（create → 复制 → drop → rename，外键关闭），并按 v28 `intents`
的先例做**前置校验 + 行数核对**：Bun 的 `exec()` 会吞掉多语句脚本里的 step 错误并继续执行后面的
`DROP TABLE`，所以重建后的行数比对把「静默丢行」变成一次回滚。

`integration_batch_items`、`integration_verification_runs`、`stable_promotions` 按名字引用该表，旧表在
新表改名**之前**被删除，因此引用继续成立；不重建其他表、不加列、不动任何既有行（两个新状态是纯加宽，
所有既有行本来就满足放宽后的 `CHECK`）。成员状态集合**不变**（`PREPARED` 就是「未处理」，
文档里写明这一点），因此没有为成员新增取值。

**成员清单不可被静默改写**：组成之后没有任何代码路径会 `UPDATE` `integration_batch_items` 的
`task_id`/`revision_id`/`execution_id`/`candidate_commit`/`dev_commit`——只有 `state`/`detail`/`integrated_commit`
/`completed_at` 会被推进。批次一旦组成，它「固定了哪些成员的哪个 revision 与哪个结果提交」就是只读事实。

### D08：`promotion prepare` 消费批级证据——无需改动 promotion-service

`getPromotionCandidates` 的 `members` 一直取自 `integration_batch_items`，`requireIntegrationEvidence`
只要求「批次 `INTEGRATED` + `devRef` 一致 + `integratedCommit` 等于请求的 dev SHA + 独立验证 `PASSED` 且
绑定到该 merge/基线」。这些都已经是批级的，因此多成员批次**不需要**改 `promotion-service.ts`：
本格用两个成员的真实 PASSED 批次验证了 `prepare` 成立并固定两个成员，且证据不匹配时仍以
`PROMOTION_EVIDENCE_MISMATCH`/`NOT_FOUND` 拒绝。**没有为多成员放宽或新增任何提升门禁。**

### D09：新增事件

`IntegrationMemberMerged`（每个成员的合并）、`IntegrationBatchStale`、`IntegrationBatchCancelled`；
`IntegrationBatchCreated` 的载荷由单成员字段改为 `members[]`（并保留成员级 revision/commit 绑定）。
既有事件名不重命名、不删除。

## Consequences

- 一个批次可以为多个 Task 产生**一次**可提升的集成证据，`promotion prepare` 因此第一次真正建立在产品批次上；
  `dev → main` 的人工路径与产品路径之间的证据缺口被关掉。
- `dev` 在验证期间被移动时的记录从 `FAILED` 变成 `STALE`：既有断言（`state`）需要相应更新，
  但「`dev` 未被本批次改写」这一不变量不变。
- 组成与集成分离后，一个 `CREATED` 批次会占用其成员：既有的 `task integrate` 对该 Task 会以
  `INTEGRATION_IN_PROGRESS` 拒绝，直到批次被集成或被取消。这是刻意的（见 D04 的取消路径）。
- v30 是一次表重建：任何升级必须走行数核对（已实现），且它不是纯 `ADD COLUMN`，因此不能声称「零风险」。
- 成员顺序确定性（D02）意味着「先合并谁」不由命令行决定；需要特定顺序的用户会看到与请求顺序不同的
  合并顺序——这一点在 `create` 的输出与本文档中写明，而不是静默处理。

## Verification

本格实际运行（定向，ADR-0038）：

- `apps/runtime/test/integration-service.test.ts`（22 项，含新增的
  `multi-member IntegrationBatch (ADR-0053)` 7 项）：多成员成功 + 一次验证 + `dev` 只在 `PASSED` 后推进、
  成员与批次结果可读、同一 command id 重放不二次推进；成员 revision 移动 → `STALE/MEMBER_EVIDENCE_MOVED`
  且 `dev` 不动；`dev` 移动 → `STALE/DEV_REF_MOVED`；一个成员冲突 → 批次 `CONFLICTED`、成员分别为
  `MERGED`/`CONFLICTED`、`dev` 不动；取消 `CREATED` → `CANCELLED`，有 worktree 记录时 →
  `RECOVERY_REQUIRED/RECONCILE_REQUIRED` 且保留占用；INTEGRATING_DEV 崩溃 → 按 ref 事实收敛且
  不二次写 ref；同一成员被未结算批次占用时拒绝组成与集成。
- `apps/runtime/test/cli-integration-batch.test.ts`（4 项，真实 CLI + Runtime + 假 provider）：
  `create`/`integrate`/`list`/`get`/`cancel` 的端到端命令面与退出码（成功 0、`STALE` 1、用法 2）。
- `apps/runtime/test/promotion-service.test.ts`（27 项，含新增 1 项）：多成员 PASSED 批次上
  `promotion prepare` 成立并固定两个成员；证据不匹配仍拒绝。
- `packages/storage/test/integration-batch-terminal-states.test.ts`（2 项）：v29 → v30 真实文件库迁移，
  既有行（8 个状态）全部保留、新 `CHECK` 生效（`STALE`/`CANCELLED` 可写、伪造状态被拒）、
  `PRAGMA foreign_key_check` 为空、索引仍在；版本断言用 `>= 30`。
- `bun run typecheck` 退出码 0。所有 Git 测试使用临时仓库与临时裸远端。

未运行（并说明原因）：`bun run check`/`just verify` 等全量检查按 ADR-0038 禁止在开发分支运行，
全量测试只在 `dev` 候选上执行。

## 关联文档

`docs/architecture/state-machines.md` §4、`docs/architecture/event-model.md` §2、
`docs/architecture/sqlite-schema.md` §5/§8、`docs/guides/cli-reference.md` §14/§15、
`docs/tasks/README.md` FOUNDATION-081；上游 ADR-0018（单成员集成管线）、ADR-0022/0047/0052
（稳定提升）、ADR-0011（权限语义）、ADR-0038（开发分支只跑定向测试）。
