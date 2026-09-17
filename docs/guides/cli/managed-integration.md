# §23 受管 integration（`project integration *` / `task integration show`）

> **适用版本** ADR-0070 S8 实现分支（2026-09-17） · **schema** v38 · **最后校对** 2026-09-17
> 本节的每条命令、参数、退出码与事实都从源码（`apps/cli/src/command-tree.ts`、
> `apps/runtime/src/managed-integration-service.ts`、`packages/git/src/managed-integration.ts`）核对得到；
> 覆盖由 `apps/runtime/test/cli-command-surface.test.ts` 核对（ADR-0068/0050）。
> 决策依据：[ADR-0074](../decisions/0074-managed-integration-ref-and-merge-queue.md)。

## 23.1 受管 integration ref 是什么

每个被信任的项目（Project Service）由 Codeestra **独占**管理一条 integration ref：

```text
ref:      refs/codeestra/integration          # 私有命名空间，不是 refs/heads/*
worktree: <CODEESTRA_HOME>/integration/<project-id>/   # detached，Runtime 数据目录内
advance:  git update-ref refs/codeestra/integration <new> <expected-old>   # 原子 CAS
```

- **不在 `refs/heads/`**：`git branch` 列不出它，默认 `push` refspec 带不走它，任何 checkout 都不可能停在它上面。
- **不碰用户工作树**：集成只在上面那个 detached worktree 里合并；用户当前检出的分支、HEAD 与工作区不被修改。
- **初始 commit 来自项目本身**：`project trust` 已经核验过 canonical root / main ref / HEAD，同一步顺手把 ref 建到**当时项目文件夹检出的分支 commit**。此后新 Task 的基线就是这条 ref 当时的 commit。
- 老库（schema v37 时期信任过的项目）没有这条 ref：**首次需要时按项目文件夹当时检出的分支补建**，已存在的 ref 永不被移动。项目文件夹处于 detached HEAD 且 ref 不存在时，基线无法建立，按未满足处理。

`--base-ref <refs/heads/…>` 仍可覆盖单个 Task 的基线（只接受本地分支或本受管 ref）；显式给的基线不会被偷偷换掉。

## 23.2 合并是怎么发生的

```text
Task Verification PASSED（Task 级，绑定 revision + result commit）
  → project integration request        # 只入队；幂等键 = Task 修订
  → 持久 merge queue（同项目严格串行）
  → project integration run            # 合并队首 → 独立 Integration Verification → CAS 推进 ref
  → Task integration 投影 MERGED，ref 前进
```

- **先固定 expected OID，再合并**：`run` 先读 ref 当时的值，把它记成这次合并的 expected OID；冲突、验证失败或 ref 在此期间被外部移动，都**不推进** ref。
- **`--no-ff`**：每个 Task 的成果都是一个独立 merge commit，第一个父提交就是当时的 integration commit；"这个状态是谁带来的"仍可从历史回答。
- **独立 Integration Verification**：在**候选 commit** 的独立副本里跑项目 main ref 上的人工验证策略（与 Task 验证不是同一份证据，也不复用它的结论）。没有验证策略的项目无法集成，以 `INTEGRATION_POLICY_ABSENT` 诚实失败。
- **CAS 之后才算 MERGED**：`git update-ref <new> <expected>` 成功后，queue item 才落 `MERGED`，同时推进 `project_integration` 记录并给 Task Service 发一条 `TASK_MERGE_SETTLED`（幂等回执）。
- **集成验证是一个持久 Operation**（ADR-0019）：`integration_runs.operation_id` 指向同事务写下的 `INTEGRATE_TASK` Operation，它随 run 一起收口（`PASSED` → `SUCCEEDED`，其余 → `FAILED`）；Runtime 中途重启时它被标成 `RECONCILE_REQUIRED`，不会留下一个看起来还在跑的 `IN_PROGRESS`。
- **同项目串行、跨项目并行**：`MERGING`/`VERIFYING` 状态上有部分唯一索引，两个并发 `run` 不可能同时合并同一个项目。

## 23.3 失败与恢复

| 情况 | 结果 | 现场 |
|---|---|---|
| 合并冲突 | item `CONFLICTED`，ref 不动，队列被阻塞 | integration worktree 保留冲突中的合并状态 |
| 独立验证失败/超时/树被改动 | item `FAILED` | 候选 ref 与验证副本都保留 |
| 验证期间 ref 被外部移动 | item `FAILED`（`INTEGRATION_REF_MOVED`），**不 force** | 保留候选 ref；记录 Git 当时的值 |
| Runtime 在合并/验证中途重启 | item `RECOVERY_REQUIRED`（`RUNTIME_RESTARTED`），项目记录也标记 | worktree、候选 ref、验证副本原样保留 |
| 尚无验证策略 | item `FAILED`（`INTEGRATION_POLICY_ABSENT`） | 无候选推进 |

**冲突不会自动重试，也不会被模型"解决"**：本轮不创建 Integration Process/Agent（ADR-0070 D05 允许它处理复杂合并，本切片刻意不实现），也**不新建 Attention 行**——v38 的 `attention_requests.session_id` 是指向 Agent 会话的非空外键，内核级冲突没有会话可挂（与 ADR-0072 D01 记录的同一边界）。冲突以 queue item、Task 投影、领域事件和 `project integration status` 的 `needsAttention` 表达。

## 23.4 命令

```sh
bun run codeestra project integration status <project-id> [--json]
bun run codeestra project integration init <project-id> [--json]
bun run codeestra project integration queue <project-id> [--limit <n>] [--json]
bun run codeestra project integration request <project-id> <task-id> \
  [--revision <id>] [--result-commit <sha>] [--verification <run-id>] [--priority <n>] [--json]
bun run codeestra project integration run <project-id> [<item-id>] [--json]
bun run codeestra project integration retry <project-id> <item-id> [--json]
bun run codeestra project integration cancel <project-id> <item-id> [--reason <text>] [--json]
bun run codeestra task integration show <project-id> <task-id> [--json]
```

### status / init

`status` 是只读的：`currentOid` 是 Git 现在的事实，`recordedOid` 是 Runtime 上一次推进时记下的值，两者**并列显示、不自动对账**（不一致就是 `refInSync: false`）。`worktree.state` 是 `OWNED` / `MISSING` / `FOREIGN` / `UNCERTAIN` 之一，并带上推出该结论的 `evidence` 字符串。`needsAttention` 在存在 `CONFLICTED`/`RECOVERY_REQUIRED` item 或 worktree 不属于我们时为 `true`。

`init` 幂等：创建/读取该项目独占的 ref 并记录 ownership token；`project trust` 已经做过同样一步，所以对新项目通常不需要手动执行。

### queue

按 `MERGING`/`VERIFYING` → `QUEUED` → 其它（终态）分组，组内 priority desc、请求时间 asc、id asc；`--limit` 默认 100。

### request

入队。前置条件（ADR-0070 D07）逐条检查并具名拒绝：

| 稳定码 | 含义 |
|---|---|
| `TASK_NOT_FOUND` | 该 Task 不属于这个项目 |
| `MERGE_REQUEST_REVISION_STALE` | 指定的 revision 不是 Task 当前 revision |
| `MERGE_REQUEST_RESULT_MISSING` | 没有为「该 revision + 该 result commit」捕获过成果 |
| `MERGE_REQUEST_VERIFICATION_MISSING` | 没有为当前 revision 通过的 Task 验证（或指定的 run 不存在） |
| `MERGE_REQUEST_VERIFICATION_NOT_PASSED` | 指定的 run 不是 `PASSED` |
| `MERGE_REQUEST_VERIFICATION_MISMATCH` | 该 run 判定的是别的 revision/commit |

省略 `--verification` 时取该 revision **最近一次 PASSED** 的 Task 验证；省略 `--revision` 时取当前 revision；省略 `--result-commit` 时取该 run 判定的 commit。**幂等**：同一个 Task 修订重复请求收敛到同一条 item（`created: false`）；同一 Task 的更新 revision 入队时，旧 revision 仍在 `QUEUED` 的请求会被记为 `STALE`（`SUPERSEDED_BY_NEWER_REVISION`），不合并一个 Task 已不再声明的修订。

### run

一次只推进队首一条，且可选的 `<item-id>` 必须是队首（`INTEGRATION_ITEM_NOT_HEAD`）——顺序是项目的，不是调用者的。它不是守护进程：队列留在数据库里，下一条仍停在 `QUEUED`，由显式 `run`（或脚本）决定何时继续。

退出码：`MERGED` 与 `NOOP`（队列空）为 `0`；`CONFLICTED`/`FAILED` 为 `1`（item 已成终态，需要 `retry` 或 `cancel`）；用法错误为 `2`。队列被未解决的冲突阻塞时以 `INTEGRATION_CONFLICT_UNRESOLVED` 退 `1`，而不是谎报"无事可做"。项目已有活动集成时以 `INTEGRATION_ALREADY_ACTIVE` 退 `1`。

### retry / cancel

`retry` 只接受 `CONFLICTED` / `FAILED`：先把 owned integration worktree 复位（`merge --abort` + `reset --hard` 回 integration ref，且只在它确实停在记录过的 commit 上时才动手），删掉临时候选 ref，再把 item 放回 `QUEUED` 并让 `attemptCount` 前进。

`cancel` 只接受还在 `QUEUED` 的请求（理由是：已经开始的合并要按事实收口，不能靠删行解决）。取消后该 Task 的 integration 投影回到 `NOT_REQUESTED`，queue item 保留审计与 `CANCELLED_BY_USER`。

### task integration show

读一个 Task 的 integration 投影：`state`（`NOT_REQUESTED` / `QUEUED` / `MERGING` / `VERIFYING` / `MERGED` / `CONFLICTED` / `FAILED` / `STALE` / `RECOVERY_REQUIRED`）、`queueItemId`、落地时的 `integrationOid`、投影 `version`，以及该 Task 的 item 历史与最近一次 Integration Verification 的结论。它是与 lifecycle、verification **正交**的第三个事实：Agent 完成、Task 验证通过、成果进入 integration ref 是三件事，投影不把它们压成一个"完成"。

## 23.5 Signal 面

```sh
bun run codeestra signal send <project-service-id> --kind SIG_A --subtype TASK_MERGE_REQUESTED \
  --payload-json '{"taskId":"<id>","revisionId":"<id>","resultCommit":"<sha>","taskVerificationRunId":"<id>","priority":0}' \
  --idempotency-key <key> [--json]
```

`TASK_MERGE_REQUESTED` 只被 PROJECT Service 接受（Task Service 向自己的父 Service 请求），走与 `project integration request` 完全相同的前置检查与幂等键，所以重复投递只入队一条。`TASK_MERGE_SETTLED` 只被 TASK Service 接受：Project Service 在推进 item 的**同一事务**里写好 Task 投影，这条通知的作用是让 Task Service 确认自己持有的投影版本就是通知描述的那一个——不一致就以 `SIGNAL_EFFECT_CONFLICT` 永久拒绝，而不是静默接受。

## 23.6 不做什么

- **不发布**：没有任何命令把 integration ref 推到 main、release 或用户分支（ADR-0070 D07 明确排除，也不恢复旧 `promotion *`）。要拿成果，用户自己决定怎么合并这条 ref。
- **不创建 Integration Process/Agent**：冲突只报告，不自动解决。
- **不自动回收**：集成成功后 worktree/branch 的回收仍是显式 `reclaim`（ADR-0062 随旧集成删除后没有自动路径）。
- **不新增确认**：以上命令在 FULL 模式全部零确认；STRICT 只沿用既有的验证策略确认门禁（`project trust` 时确认的那份 digest）。

## 23.7 与 Task 基线的关系

自此新 Task 的默认基线是**受管 integration ref 当时的 commit**（`workspaces.base_ref` 记为 `refs/codeestra/integration`，commit 同时固定）。因此：

- Task B 建立在 Task A 已合入的成果之上，"上游已完成"由结果 commit 对 integration ref 可达来释放依赖；
- 移动用户自己检出的分支**不再**改变任何已建 workspace 的基线，也不影响新 Task 的基线（新 Task 只看 integration ref）；
- 既有（S8 之前建立的）workspace 不回写，它们的 `base_ref` 仍是当时记录的那条分支。

---

## 相关阅读

- 内核命令（`service`/`process`/`signal`/`intent`）：[kernel.md](./kernel.md)
- 项目、信任与知识：[project.md](./project.md)
- Task 生命周期、成果与验证：[task-lifecycle.md](./task-lifecycle.md)、[task-result-verify.md](./task-result-verify.md)
- 决策：[ADR-0070](../decisions/0070-service-process-signal-kernel.md)、[ADR-0074](../decisions/0074-managed-integration-ref-and-merge-queue.md)
- 目标架构：[service-process-signal.md](../../architecture/service-process-signal.md)、[git-workspace-api.md](../../architecture/git-workspace-api.md)
