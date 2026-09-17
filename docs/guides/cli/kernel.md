# Service Kernel 命令

> **适用版本** ADR-0070 S1–S5 实现分支（2026-09-17） · **schema** v37 · **最后校对** 2026-09-17
> 当前只实现内核、持久 Signal 与兼容 facade；Process 的原生控制 API 与 intention 解释仍分别属于后续波次与 S6。

## Service

```sh
bun run codeestra service list [--kind ROOT|SCHEDULER|ATTENTION|PROJECT|TASK] \
  [--parent <service-id>] [--all] [--json]
bun run codeestra service get <service-id> [--json]
bun run codeestra service tree [service-id] [--json]
bun run codeestra service state get <service-id> [--json]
bun run codeestra service state set <service-id> --namespace <name> --key <name> \
  --value-json '<json>' --expected-version <n> [--json]
```

`service tree` 返回 root 与其后代的扁平数组；用 `parentServiceId` 重建树。root、Scheduler、Attention 使用稳定 ID。
Project/Task Service 的 ID 直接复用现有 Project/Task ID，core state 仍由旧表权威提供。`state set` 只能写
namespaced metadata，实际会发送 `SERVICE_METADATA_SET` `SIG_A`；不能借 metadata 修改 Task 生命周期、调度、Git 或权限。
并发写必须带 `stateVersion`，旧版本以 `SERVICE_VERSION_CONFLICT` 拒绝。

## Process

```sh
bun run codeestra process list [--service <service-id>] [--state <state>] [--json]
bun run codeestra process get <process-id> [--json]
bun run codeestra process input <process-id> --message <text> [--json]
bun run codeestra process pause <process-id> <expected-control-version> [--json]
bun run codeestra process resume <process-id> <expected-control-version> \
  [--adapter <id>] [--allow-unknown] [--json]
bun run codeestra process terminate <process-id> <expected-control-version> [--json]
```

每个既有 Execution 投影为同 ID 的 `DEVELOPMENT` Process；查询与控制读取现有 Task/Execution/Session 事实，
不复制第二套生命周期。四个控制命令复用既有 Session guidance 与 Task pause/resume/cancel handler。
S4 创建的 `INTENTION` Process 只停在 `CREATED`；对它调用控制命令会以
`PROCESS_CONTROL_UNAVAILABLE` 诚实拒绝，等 S6 才建立解释路由与 Agent。

`process get`/`process list` 额外返回只读的 `progress`：`lastProgressAt` 是该 Process 最近被记录的事实时间；
`budgetKnown` 表示是否已记录预算；`tokenUsage`、`costUsd`、`toolCallCount` 在 schema v37 没有对应事实，
**恒为 `null`（UNAVAILABLE）**，不由 session、消息数或时钟推算。

### Process 完成

```sh
bun run codeestra signal send <parent-service-id> --kind SIG_A --subtype PROCESS_COMPLETED \
  --payload-json '{"processId":"<id>","outcome":"SUCCEEDED|FAILED|CANCELLED","expectedVersion":<n>,"summary":"<text>"}' \
  --idempotency-key <key> [--json]
```

`PROCESS_COMPLETED` 只被 ROOT、PROJECT、TASK 接受（Process 的 parent Service 必为三者之一）；Scheduler 与
Attention 监督不了 Process，以 `SIGNAL_NOT_ACCEPTED` 拒绝。同一 `(targetServiceId, idempotencyKey)` 幂等：
重发返回同一 receipt，不二次改变状态。

退出码：`ACKED` 为 0；`PENDING`/`CLAIMED`/`RETRYABLE` 为 3（等待）；下面这些稳定码是**永久拒绝**，Signal
首次尝试即进入 `DEAD_LETTER`，CLI 退出码 1，码出现在 `--json` 输出的 `signal.lastErrorCode`：

| 码 | 含义 |
|---|---|
| `PROCESS_VERSION_CONFLICT` | `expectedVersion` 不是当前 `processes.version` |
| `PROCESS_PARENT_MISMATCH` | Signal 的 target 不是该 Process 的 parent Service |
| `PROCESS_STATUS_SOURCE_READONLY` | 该 Process 的状态由 Execution 权威提供，不能由 Process 直接写（包括所有 Development Process） |
| `PROCESS_TERMINAL` | 终态 Process 不会被复活 |
| `PROCESS_COMPLETION_MISMATCH` | payload 的 `processId` 与 Signal 声明的 Process 不一致 |
| `INVALID_SIGNAL_PAYLOAD` | payload 形状不符合 `PROCESS_COMPLETED` 契约 |
| `INVALID_PROCESS_TRANSITION` | 非法状态迁移（例如 `CREATED → SUCCEEDED`） |
| `PROCESS_STATE_UNAVAILABLE` | 该 Process 没有 Process-owned 状态；v37 的 CHECK 约束下不应出现 |

这些拒绝都不产生部分应用：被拒绝时 `processes.status`、`processes.version` 与 `domain_events` 都不变。要重发必须
显式 `signal retry`，并带上当前 `expectedVersion`。

## Signal

```sh
bun run codeestra signal send <target-service-id> --kind SIG_A|SIG_P --subtype <name> \
  --payload-json '<json>' --idempotency-key <key> [--contract-version <n>] \
  [--source-service <id>] [--source-process <id>] [--correlation <id>] \
  [--causation <id>] [--priority <n>] [--json]
bun run codeestra signal list [--service <id>] [--state <state>] [--kind SIG_A|SIG_P] \
  [--limit <1..500>] [--json]
bun run codeestra signal get <signal-id> [--json]
bun run codeestra signal retry <signal-id> [--json]
```

Signal 在 SQLite 持久 inbox 中先 enqueue，再以 30 秒 lease claim。失败按 1/5/30/120/300 秒做五次自动重试；
第六次自动尝试仍失败才进入 `DEAD_LETTER`，只能显式 `signal retry`。target + idempotency key 相同且 payload 相同会
返回同一 Signal；不同 payload 以 `SIGNAL_IDEMPOTENCY_CONFLICT` 拒绝。ACK 与 receipt 同事务写入；这里保证
at-least-once + 幂等收敛，不宣称跨 SQLite/Provider exactly-once。

退出码：`ACKED` 为 0；仍处于 `PENDING`/`CLAIMED`/`RETRYABLE` 为 3；dead-letter、recovery 或拒绝为 1；
CLI 用法错误为 2。`--payload-json` 必须是合法 JSON，结构化值不接受普通字符串 flag 代替。

## Intention

```sh
bun run codeestra intent send <text…> \
  [--service <id> | --project <project-id> | --task <task-id>] [--adapter <id>] [--json]
```

省略目标时发给 root；三个目标 flag 只能选一个。命令持久化 `INTENT_SUBMITTED` `SIG_P`，并幂等创建一个
`CREATED` Intention Process。返回值的 `interpretation: "PENDING_S6"` 表示**已可靠受理但尚未解释/执行**，
不是工作完成。当前不会直接把 Agent 挂到 Service，也不会把自然语言猜成 Task revision 或 guidance。
