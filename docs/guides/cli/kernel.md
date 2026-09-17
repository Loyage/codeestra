# Service Kernel 命令

> **适用版本** ADR-0070 S1–S6 实现分支（2026-09-17） · **schema** v37 · **最后校对** 2026-09-17
> 当前已实现：内核、持久 Signal、兼容 facade、Process 完成写路径与只读进度事实（S5 的一部分），以及
> intention 解释结果的**结构化**一半（S6：`INTENTION_RESOLVED`，没有任何模型在解释意图）。
> **仍未实现**：Process 的原生 Agent 控制 API、真实意图解释、Attention 全局索引对 kernel-level Intention 的接通。

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

### 用 `INTENTION_RESOLVED` 把这个 Process 收口

没有新命令：`intent send` 建出的 Process 由**既有** `signal send` 推进。

```sh
bun run codeestra signal send <target-service-id> --kind SIG_A --subtype INTENTION_RESOLVED \
  --payload-json '{"processId":"<process-id>","expectedVersion":0,"outcome":{"kind":"ROUTE","targetServiceId":"<project-service-id>","instruction":"..."}}' \
  --idempotency-key <key>
```

`target-service-id` 必须是该 Process 的 parent Service（root / project / task 之一）：信号投错 Service 会被
`PROCESS_PARENT_MISMATCH` 拒绝。`outcome.kind` 只有三种：

| outcome | 行为 | 可见事实 |
|---|---|---|
| `ROUTE` | 目标必须是 parent 可见的 Service（root→直属 PROJECT，PROJECT→自己的 TASK），否则 `INTENTION_TARGET_NOT_VISIBLE` | Process → `SUCCEEDED`；`events list` 里一条 `IntentionRouted`；**不**创建 Process、**不**改 Task 规格 |
| `TYPED_COMMAND`（仅 `command: "SESSION_GUIDANCE_RECORD"`） | 走既有 Session Guidance 账本（ADR-0057），写 `targetTaskServiceId` 的消息 | Process → `SUCCEEDED`；`session guidance list <project> <task>` 能看到该条；`RECORDED` **不等于**模型已读。目标不是一个可解析 project/task 的 TASK Service → `INTENTION_TARGET_NOT_VISIBLE`；该 Task 正被 Execution 持有 → `INTENTION_GUIDANCE_CHANNEL_UNAVAILABLE`（kernel 派发器没有 provider 会话通道，请改用 `session guide`） |
| `REQUEST_CLARIFICATION` | 目标不明时**不猜**：提问并等用户，Process → `WAITING_FOR_USER` | `events list` 里一条 `IntentionClarificationRequested`；`signal get <id>` 的 receipt effect 里有 `requestId` 与 `attentionIndex: "NOT_CONNECTED"` |

`CREATE_TASK` **不在本轮**（创建 Task 是 S7 的写路径）：把它放进 `outcome.kind` 会被具名拒绝——Signal 直接
`DEAD_LETTER`，`signal get <id>` 的 `lastErrorCode` 是 `INTENTION_CREATE_TASK_UNSUPPORTED`，退出码 1，Process 不动、
不落审计、不写 receipt。

回答一个澄清：对**同一个** Process 再发一条 `INTENTION_RESOLVED`（新 `--idempotency-key`），并把上一步的
`requestId` 放进 `--causation`；`expectedVersion` 用 `process get` 读到的当前版本。对不上是
`INTENTION_CLARIFICATION_MISMATCH`，已有一个未收口澄清时再提新问题是 `INTENTION_CLARIFICATION_OPEN`。

**Attention 索引尚未接通（本轮明确不做）**：澄清**不会**在 `attention list <project-id>` 里出现。原因是 v37 的
`attention_requests.session_id` 非空外键指向 `agent_sessions`，而 native `INTENTION` Process 没有 provider 会话；
接通需要一次新的 migration（v38 号预留给 S8），未决前不得把它写成已实现（ADR-0072）。

幂等：同一 `(target-service-id, --idempotency-key)` 只应用一次；重复投递返回**同一个** Signal 与同一个 receipt，
不会产生第二条审计事实，也不会第二次推进 Process。`signal send` 的退出码沿用本页 Signal 一节：`ACKED` 为 0，
`PENDING`/`CLAIMED`/`RETRYABLE` 为 3，`DEAD_LETTER` 或拒绝为 1（稳定码可从输出 JSON 的 `lastErrorCode` 或
`signal get` 读到），用法错误为 2。
