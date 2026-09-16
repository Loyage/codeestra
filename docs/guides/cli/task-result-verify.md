# CLI 参考 · 成果 commit、验证与长命令

> **适用版本** `dev@de03448`（2026-09-16） · **schema** v34 · **最后校对** 2026-09-16
> 版本会前进：`dev@de03448` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../../tasks/README.md) 的最新 FOUNDATION 记录为准。
> 拆分说明（ADR-0063）：本文件是 [`cli-reference.md`](../cli-reference.md) 按功能拆出的九篇之一，
> **内容自 `cli-reference.md @ dev@de03448` 搬移，一句未改写；本次未重新核对源码**，最后校对日期因此不变。
> 本文件覆盖 §8–§10；章节号沿用拆分前的编号，因此可能不连续。正文里提到本文件没有的号（例如 §14、§17）时，到 [README.md](./README.md) 的索引表查它在哪一篇。

## 8. `task result`（成果 commit）

```sh
bun run codeestra task result capture <project-id> <task-id> [execution-id]
bun run codeestra task result prepare <project-id> <task-id> [execution-id]   # STRICT
bun run codeestra task result commit  <project-id> <task-id> <authorization-id> --confirm
```

- **`capture` 只在 FULL 模式可用**。STRICT 下会被以 `FULL_PERMISSION_REQUIRED` 拒绝。
  它在 Runtime 内部合成一次 prepare + 一次 commit（派生 commandId），所以是一条命令。
- `commit` **必须**带 `--confirm`，且除它之外不接受别的 flag（用法错误）。
- 省略 `execution-id` 时 Runtime 解析该 Task 的成果来源；有歧义时以 `AMBIGUOUS_EXECUTION` 拒绝。

前提与影响（两条路径都一样）：只在**已核验归属**的 task worktree 提交；创建 commit 前固定
**HEAD / ChangeSet / revision**，之后发生变化即拒绝；沿用仓库**已有** Git identity，缺失时停止（不代写 `git config`）；
正常执行 hooks，失败保留现场（不 `--no-verify`）；成果落在 `refs/heads/task/<task-id>`。
STRICT 下额外拒绝敏感路径；**FULL 下不做敏感路径拒绝**。

稳定码：`NOTHING_TO_COMMIT`、`AGENT_NOT_QUIESCENT`、`NO_CAPTURED_RESULT`、`NO_ACTIVE_EXECUTION`、
`INVALID_EXECUTION_STATE`、`STALE_AUTHORIZATION`、`AUTHORIZATION_NOT_ACTIVE`、`AUTHORIZATION_MISMATCH`、
`COMMIT_MISMATCH`、`COMMIT_FAILED`、`STALE_REVISION`、`WORKSPACE_NOT_OWNED`、
`SENSITIVE_PATH_BLOCKED`（STRICT）、`FULL_PERMISSION_REQUIRED`（`capture` 在 STRICT 下）。

---

## 9. `task verify` / `task verification` / `task tests`

### `task verify <project-id> <task-id> [execution-id] [--background] [--policy <auto|targeted|project>]`

- `--policy` 取值：
  - `auto`（默认）：该 Task 有**已记录**且与本次 revision/commit 匹配的定向计划就用它，否则用固定项目策略；
  - `targeted`：**必须**有这样一个计划；
  - `project`：用固定项目策略。
  非法取值 → **退出码 2**，并在 stderr 解释三个取值。
- 命令来自项目 `main` ref 上人工维护的 `.codeestra/policies/verification.json`；
  在**固定 commit 的 detached 副本**中运行；**证据不含原始命令输出**。
- 不加 `--background`：只有 `state === "PASSED"` 是 `0`，否则 `1`。
- 加 `--background`：**`0` 表示「已受理并开始」，不代表验证通过**；进度用 `task operation list` 看，
  用 `task operation cancel` 停止。

稳定码：`VERIFICATION_POLICY_ABSENT`、`VERIFICATION_POLICY_NOT_CONFIRMED`、
`VERIFICATION_POLICY_UNREADABLE`、`INVALID_VERIFICATION_POLICY`、`TASK_NOT_EXECUTED`、`NO_CAPTURED_RESULT`、
`STALE_REVISION`、`EXECUTION_NOT_FOUND`、`INVALID_COMMIT_ID`、`VERIFICATION_FAILED`，
以及定向计划相关：`TARGETED_TEST_PLAN_ABSENT`、`TARGETED_TEST_PLAN_NOT_RECORDED`、
`TARGETED_TEST_PLAN_UNREADABLE`、`TARGETED_TEST_PLAN_REVISION_MISMATCH`、`TARGETED_TEST_PLAN_COMMIT_MISMATCH`、
`TARGETED_TEST_PLAN_DIGEST_MISMATCH`、`INVALID_TARGETED_TEST_PLAN`。

### `task verification list <project-id> <task-id>`

列出该 Task 的验证记录（`state`、`outcomeCode` 等）。

### `task tests record|show|history`

```sh
bun run codeestra task tests record <project-id> <task-id> [--commit <full-sha>] [--expected-plan-digest <sha256>] [--json]
bun run codeestra task tests show   <project-id> <task-id> [--json]
bun run codeestra task tests history<project-id> <task-id> [--limit <n>] [--json]
```

- `record` 读取该分支的 `.codeestra/tests.json`（含 `scope` 与 1–16 条命令，每条带 `covers`），
  把它快照成绑定 `(task, revision, commit, digest)` 的**append-only** 记录。
- `--commit` 可指定要绑定的 commit；`--expected-plan-digest` 是防漂移（文件变了就拒绝）。
- 若替换了此前的范围，返回 `replacedExistingScope: true`，CLI 会在 stderr 明确说明「旧记录保留为审计，
  本次范围变化不是静默生效」。
- `show` 打印当前已记录的计划；**没有记录时返回 `null`**，CLI 在 stderr 说明 `task verify` 会用固定项目策略。
- `history` 的 `--limit` 默认 50（上限 500）。`--json` 对三个子命令都是机器格式，且被显式接受。

### JSON 输出与 `--json`

`task tests` 的每个子命令都用 `--json` 声明机器格式；`show` 还接受 `--json` 之外的**无** flag。

---

## 10. `task operation`（长命令）

```sh
bun run codeestra task operation list   <project-id> <task-id> [--json]
bun run codeestra task operation get    <project-id> <operation-id> [--json]
bun run codeestra task operation cancel <project-id> <task-id> <operation-id> [--json]
```

- `list` / `get` 的默认输出是**人读**视图（`--json` 打印 Runtime 原文）：每个 Operation 一行摘要，
  加上逐步进度（`STEP` / `OUTPUT` / `SETTLED`）。
- `cancel` 打印 `stop` / `state` / `kind` / `detail`。**`stop === "UNCERTAIN"` → 退出码 1**
  （进程可能还在跑，Operation 被留给人处理）。
- 稳定码：`NOT_CANCELLABLE`、`NOT_FOUND`、`RECONCILE_REQUIRED`、`CANCEL_UNCONFIRMED`。
- 进度事件与 Operation settle 会作为 domain event 出现在 `events` 流上（`OperationProgressed`、`OperationSettled`）。
  **进度事件永不携带判定**：验证通过只由 `VerificationCompleted` 与该运行自身的状态报告。

---

