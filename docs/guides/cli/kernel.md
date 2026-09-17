# Service Kernel 命令

> **适用版本** ADR-0070 S1–S4 实现分支（2026-09-17） · **schema** v37 · **最后校对** 2026-09-17
> 当前只实现内核、持久 Signal 与兼容 facade；Process 原生控制与 intention 解释仍分别属于 S5/S6。

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
`PROCESS_CONTROL_UNAVAILABLE` 诚实拒绝，等 S5/S6 才建立 Agent 与解释路由。

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
