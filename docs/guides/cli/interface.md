# CLI 参考 · 事件与 Attention

> **适用版本** `dev@6c7de03`（2026-09-17） · **schema** v36 · **最后校对** 2026-09-17
> 版本会前进：`dev@6c7de03` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../../tasks/README.md) 的最新 FOUNDATION 记录为准。
> 拆分说明（ADR-0063）：本文件是 [`cli-reference.md`](../cli-reference.md) 按功能拆出的九篇之一（ADR-0066 之后为八篇），
> **内容自 `cli-reference.md @ dev@de03448` 搬移，一句未改写；本次未重新核对源码**，最后校对日期因此不变。
> 本文件覆盖 §17–§18 与 §20–§21（§19 在 [runtime.md](./runtime.md)）；章节号沿用拆分前的编号，因此可能不连续。正文里提到本文件没有的号（例如 §14、§17）时，到 [README.md](./README.md) 的索引表查它在哪一篇。

## 17. `events`（订阅）

```sh
bun run codeestra events list [--project <project-id>] [--since <sequence>] [--limit <n>] [--json]
bun run codeestra events tail [--project <project-id>] [--since <sequence>]
```

- `list` 的 `--limit` 范围 `1`–`500`，默认 `100`；`--since` 必须是非负安全整数（默认 0）。
  对 `list`，`--json` 被接受（它本来就打印 Runtime 投影原文）。
- `tail` **不接受** `--limit`；`--json` 也不是 `tail` 的参数。
- 游标语义（**排他**）：
  - `list` 的 `sinceSequence` 是「从这个序号**之后**开始」。
  - `tail` 不带 `--since` 表示「**从当前尾部开始**」——所以正确用法是**先取一次快照，再用快照游标订阅**，
    两次之间不丢事件。
  - `tail` 带一个**大于** Runtime 日志最新序号的游标时，会收到
    `{"type":"error","code":"INVALID_CURSOR"}` 并**结束订阅**。这是刻意的：客户端必须重新取快照，
    而不是以为自己已追上。运行时返回 `cursor: latest, active: false`。
- SSE 帧类型：`subscribed`（首个帧，带 `cursor` / `projectId`）、`event`（带 `cursor` 与 `event`）、
  `heartbeat`（每 15s）、`error`（`INVALID_CURSOR` / `EVENT_READ_FAILED` / `SUBSCRIPTION_FAILED`）。
- 订阅是**只读**的：不写事件、不碰 `event_deliveries` outbox、不重放任何命令。投递是 best-effort——
  错过帧的客户端用**最后一个游标**重连，这就是游标**排他且从不隐式重置**的原因。

### 主要事件名（源码核对）

| 领域 | 事件名 |
|---|---|
| Intent / Task | `IntentRecorded`、`TaskCreated`、`TaskStateChanged`、`TaskRevisionCreated`、`TaskRetryRequested`、`TaskDependencyAdded`、`TaskDependencyRemoved`、`VerificationInvalidated`、`RecoveryRequired` |
| Execution | `ExecutionReserved`、`ExecutionStateChanged`、`ExecutionFailed`、`ResultCommitAuthorized`、`ResultCommitCreated`、`ResultCommitAuthorizationInvalidated` |
| Attention | `UserAttentionRequested`、`UserAnswerRecorded`、`UserAnswerDelivered`、`ProseQuestionAttentionResolved` |
| Agent Session | `AgentSessionStarted`、`AgentSessionStateChanged`、`AgentSessionCompleted` |
| Workspace | `WorkspacePrepared`、`WorkspaceReclaimed` |
| 验证 | `VerificationCompleted` |
| 调度 | `TaskScheduleDecided`、`TaskWaitingForConflict`、`TaskWaitingForCapacity`、`TaskUnknownCleared`、`TaskImpactPredictionRevoked` |
| 容量 / 槽位 | `SchedulerCapacityChanged`、`ExecutionSlotReserved`、`ExecutionSlotReleased`、`ExecutionSlotReconciled`、`ExecutionSlotWorkspaceBound` |
| Operation | `OperationProgressed`、`OperationSettled`、`ResourcesReclaimed` |
| 交接 / 终端 | `TakeoverRequested`、`TakeoverSafePointReached`、`SessionHandoffStarted`、`SessionHandoffCompleted`、`TerminalWriterLeaseChanged`、`TakeoverReleased`、`TakeoverFailed` |
| 修订投递 | `TaskRevisionDeliveryRecorded` |

**已实现的事件名永不重命名**（ADR-0035）：改名会让同一语义长期存在两个名字。

---

## 18. `attention`

```sh
bun run codeestra attention list <project-id>

bun run codeestra attention answer <project-id> <attention-id> confirm <yes|no>
bun run codeestra attention answer <project-id> <attention-id> value <text>
bun run codeestra attention answer <project-id> <attention-id> cancel
bun run codeestra attention answer <project-id> <attention-id> [--choose <question>:<options>]…
  [--text <question>=<text>]… [--cancel]

bun run codeestra attention resolve <project-id> <attention-id> --dismiss [--note <text>] [--json]
bun run codeestra attention resolve <project-id> <attention-id> --answer <text> [--note <text>] [--json]
```

### `list`

返回数组，每条含 `id`、`kind`（`PERMISSION` / `QUESTION` / `RECOVERY`）、`status`
（`OPEN` / `ANSWER_RECORDED` / `DELIVERED` / `CLOSED` / `STALE`）、`responseType`（`CONFIRM` / `VALUE`）、
`prompt`、`taskId`、`executionId`、`createdAt`。**这是唯一不接受任何额外参数的 attention 子命令**：
多给一个 token（包括 `--json`）都是用法错误。

### `answer`（投递给 Agent）

三种形态：

- 位置式：`confirm yes|no`（`responseType = CONFIRM`）、`value <text>`（把剩余 token 用空格拼起来）、`cancel`。
- flag 式（结构化问卷）：`--choose <题>:<选项>[,<选项>]` 可重复、`--text <题>=<文本>` 可重复、`--cancel`。
  - 题号与选项号是 **1-based**，与界面显示一致。
  - 一道题只能答一次（重复报错）；`--cancel` 不能与任何答案同时给出。
  - 形式错误的示例：`--choose expects <question>:<options>`、`--text expects <question>=<text>`。
  - 超出契约上限的题号/选项号在 **CLI 侧**就会报错（可读错误，而不是不透明边界拒绝）；
    **是否存在于这份问卷**由 Runtime 判定。
- 越界/重复/单选多选不符由 Runtime 以 `INVALID_QUESTIONNAIRE_ANSWER:<PROBLEM>` 拒绝，
  其中 `<PROBLEM>` ∈ `QUESTION_INDEX_OUT_OF_RANGE`、`DUPLICATE_QUESTION_ANSWER`、`DUPLICATE_CHOICE`、
  `CHOICE_INDEX_OUT_OF_RANGE`、`MULTIPLE_CHOICES_FOR_SINGLE_SELECT`；请求**保持 OPEN**。
  给非问卷请求投递问卷答案是 `NOT_A_QUESTIONNAIRE`。

其他稳定码：`ANSWER_NOT_DELIVERABLE`、`ADAPTER_MISMATCH`、`PERMISSION_CHANNEL_UNAVAILABLE`、
`INVALID_STATE`、`INVALID_ADAPTER_RECEIPT`、`NOT_FOUND`。

### `resolve`（散文提问等待）

- **必须恰好给一个** `--dismiss`（误报）或 `--answer <text>`；两者都给或都不给是用法错误。
- `--note <text>` 可选。
- 记录 `DISMISSED_FALSE_POSITIVE` 或 `ANSWERED`。
- **不会恢复 provider 对话，也不是 TaskRevision**：回答是关于**这一次等待**的陈述，不是对规格的修改。
- 稳定码：`PROSE_QUESTION_RESOLUTION_REQUIRED`（试图用 `attention answer` 投递散文提问等待时）、
  `PROSE_QUESTION_ATTENTION_NOT_PROSE_QUESTION`、`PROSE_QUESTION_ATTENTION_ALREADY_RESOLVED`、
  `PROSE_QUESTION_SESSION_NOT_EXITED`、`PROSE_QUESTION_EXECUTION_NOT_RUNNING`、
  `PROSE_QUESTION_TASK_NOT_WAITING`、`PROSE_QUESTION_INVALID_RESOLUTION_PAYLOAD`。

---

## 20. HTTP / SSE 面（已暂停）

ADR-0067 起 Runtime 不再实例化 HTTP 服务，`runtime.ui`、`codeestra ui` 与 `codeestra open` 已删除；
`POST /api/command`、`GET /api/events` 和静态资产托管都不属于当前启用的产品面。

`apps/runtime/src/http-api.ts` 仅作为暂停前实现源码保留，不受当前默认测试保障。需要恢复时必须另立 ADR，
重新开放契约、安全边界、文档与测试，不能因为源码存在就宣称 HTTP/SSE 可用。

---

## 21. 其他只在源码里出现的东西

| 项 | 说明 |
|---|---|
| `session handoff writer acquire --kind` | `AUTOMATED_RPC`（默认）/ `TERMINAL_ATTACHMENT` |
| `session handoff attach --observer` | 显式声明观察者 attachment（默认就是 `OBSERVER`） |
| `session handoff detach --since` | detach 也接受 `--since` |
| `session handoff terminal write` 的 `--text` | 服务端收到的是 base64（CLI 负责编码） |
| `session handoff terminal resize --cols/--rows` | 必须是 `1..1000` 的整数；越界在 CLI 就以退出码 2 + `TERMINAL_RESIZE_INVALID_SIZE` 拒绝（不打给 Runtime） |
| `session handoff terminal resize --holder` | 终端已有 `WRITER` attachment 时必填且必须是该 holder；否则 `TERMINAL_RESIZE_WRITER_BUSY` |

---

