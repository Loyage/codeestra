# CLI 参考 · 修订投递、会话记录与终端接管

> **适用版本** `dev@06bcf97` + 本格分支 `Loyage/task_auto`（2026-09-17） · **schema** v38 · **最后校对** 2026-09-17
> 版本会前进：`dev@06bcf97` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../../tasks/README.md) 的最新 FOUNDATION 记录为准。
> **本次修订（ADR-0076）**：`task` 组不再以 `<project-id>` 开头：Task id 全局唯一，它自己就是地址，**project 是 Task 的字段**（`task create` 用 `--project`，`task list` 默认为本 Runtime 全部项目、`--project` 过滤；`task schedule status|plan|run` 仍收 `<project-id>`）。旧写法不再接受。
> 拆分说明（ADR-0063）：本文件是 [`cli-reference.md`](../cli-reference.md) 按功能拆出的九篇之一，
> **内容自 `cli-reference.md` 搬移，除下面列出的几节外一句未改写**。
> §5 的 `task revision create` 由本分支按 **ADR-0065** 更新：`--constraint` 已删除，
> 「必须改点什么」现在是「改任务详情或改功能声明，至少其一」。
> **本次修订（ADR-0066 / schema v36）**：删除 dev clone、长期 `dev` 集成分支、`task integrate` / `task integration *` / `promotion *` 与 dev 构建通道；Task 基线只有一种（项目文件夹建 workspace 时当前检出的分支），
> 成果停在 `refs/heads/task/<task-id>`，合并由你自己完成。
> **本次修订（ADR-0074 / schema v38）**：Task 基线改为项目受管的 integration ref（`refs/codeestra/integration`）；Task verification 通过后由 `project integration request` / `run` 合进该 ref，**发布到你的分支仍没有命令**；命令面见 [managed-integration.md](./managed-integration.md)。
> 本文件覆盖 §5、§6、§6.1、§7；章节号沿用拆分前的编号，因此可能不连续。正文里提到本文件没有的号（例如 §14、§17）时，到 [README.md](./README.md) 的索引表查它在哪一篇。
> §7 的 `session handoff terminal resize` 一节由 FOUNDATION-083 校对（ADR-0054）；

## 5. `task revision` 与投递

```sh
bun run codeestra task revision create <task-id> <expected-version>
  [--specification <text>] [--feature <module-id>]… [--reason <text>] [--json]
bun run codeestra task revision list <task-id> [--json]

bun run codeestra task revision delivery list <task-id> [--json]
bun run codeestra task revision delivery get  <delivery-id> [--json]
bun run codeestra task revision delivery resolve <task-id> <delivery-id> <expected-version>
  --action <stop-and-restart|retry> [--adapter <id>] [--json]
```

- `create` 至少需要 `--specification` 或 `--feature` 之一：什么都没改的修订会被拒为 `INVALID_REVISION`（ADR-0065 之后约束不再是可改的第三样东西）。`--constraint` 已删除，传入即错误用法。
- `--reason` 用于说明修订原因；缺省是 `initial task creation` 之外的自定义原因。
- `--action` 必填，且只接受那两个值。
- delivery 状态：`PENDING / IN_FLIGHT / ACKNOWLEDGED / UNACKNOWLEDGED / CHANNEL_UNSUPPORTED / TIMED_OUT / FAILED / SUPERSEDED_BY_RESTART`。
- `resolve` **退出码 `0` 仅当投递最终被满足**（`SUPERSEDED_BY_RESTART` / `RESOLVED` / `ALREADY_SATISFIED`）；
  否则 `1`——例如在**没有确认通道**的 Adapter 上 `retry`，它会诚实地留在未确认状态。
- **与 Session Guidance 的分界**（ADR-0010 D02 / ADR-0057）：本组命令改变的是**验收规格**，因此产生不可变 revision
  并使旧验证失效；只是想对**运行中的会话**说一句「怎么做」而不改验收标准，走 `session guide`（见 §6.1，它不产生 revision、
  不动 `appliedRevisionId`、不使验证失效）。两者不能互相代替。

稳定码：`TARGETED_TEST_PLAN_*` 不在此；投递相关有 `SUCCESSOR_NOT_RECORDED`、`SUCCESSOR_REVISION_MISMATCH`、
`INVALID_REVISION`、`NO_SUBJECT_EXECUTION`、`UNEXPECTED_TASK_STATE`、`CONCURRENT_MODIFICATION`。

---

## 6. `task transcript` / `session transcript`

```sh
bun run codeestra task transcript <task-id>
  [--execution <id>] [--after <entry-id>] [--limit <n>] [--reverse] [--json]
bun run codeestra session transcript <session-id>
  [--after <entry-id>] [--limit <n>] [--reverse] [--json]
bun run codeestra session transcript part <session-id> <entry-id> <part-index>
```

- `--limit` 范围 `1`–`200`，默认 `100`。
- `--after <entry-id>` 是**排他游标**（上一次读返回的 entry ID）。
- `--reverse` 打印最新条目在前。它是**纯渲染选择**，因此与 `--json` **互斥**（用法错误）。
  由于命令面是**向前**从游标读的，`--reverse` 最多可能读 50 页才能到最新条目。
- `session transcript` **不接受** `--execution`（用法错误），因为它不解析 Task。
- `--json` 打印 Runtime 视图原文；默认打印人读文本，截断的块会说明如何取回整块。
- `part` 不接受任何 flag，`part-index` 必须是非负整数。

它是**只读**的：不写数据库、不产生 domain event、不是 attach、不是终端接管、不改任何业务状态。
只允许读取 Runtime 自己的 session 目录（符号链接逃逸被拒绝）；file 路径只在 Runtime 内部使用，客户端拿不到。

稳定码：`TRANSCRIPT_CURSOR_UNKNOWN`、`TRANSCRIPT_ENTRY_UNKNOWN`、`TRANSCRIPT_PART_UNKNOWN`、
`SESSION_FILE_NOT_OWNED`、`SESSION_FILE_UNREADABLE`、`SESSION_FILE_MISSING`、`SESSION_FILE_TRUNCATED_READ`。

---

## 6.1 `session guide` / `session guidance`（Session Guidance）

```sh
bun run codeestra session guide <project-id> <task-id> --message <text> [--json]
bun run codeestra session guidance list <project-id> <task-id> [--json]
bun run codeestra session guidance get  <project-id> <guidance-id> [--json]
```

Session Guidance 是**另一条输入通道**（ADR-0010 D02 / ADR-0057）：它改变 Agent 「怎么做」，**不改变验收标准**。
它**不产生 TaskRevision**、不动 Task 的 revision 与 version、**不使任何验证失效**；改规格仍然只能 `task amend`
（`task revision create`），且旧验证仍然因此失效。

- `--message` 必填、去空白后非空，上限 16000 字符；缺 message 或给空白文本是**用法错误**（退出码 `2`）。
- `session guidance list|get` 只接受 `--json`（也是默认输出），其它 flag 是用法错误。

**退出码**（这是本组命令最重要的约定）：

| 码 | 含义 |
|---|---|
| `0` | 已交给运行中的 provider 通道（`DELIVERED`），**或**当时没有会话可交付而消息已记录（`RECORDED`——这是等待下一次 Execution 启动交付，不是拒绝） |
| `1` | 有 provider/会话被问过却没有交付：`CHANNEL_UNSUPPORTED` / `TIMED_OUT` / `FAILED`（stderr 打印稳定码与 detail） |
| `2` | 用法错误 |

本命令**不使用退出码 `3`**：投递有界（deadline 到点就写 `TIMED_OUT`），每次调用都落下一个明确结论，不存在「稍后再看可能变好」的等待语义。

**「已投递」到底指什么。** `DELIVERED` 只表示**provider 自己的通道接受了这条消息（入队）**，**不表示模型读了它**。
三个 provider 都没有可核验「已生效」的通道（ADR-0051 实测），所以命令面把这件事说出口：`--json` 里的
`modelAcknowledgement` 恒为 `UNSUPPORTED`。`state` 取值：`RECORDED` / `DELIVERED` / `CHANNEL_UNSUPPORTED` / `TIMED_OUT` / `FAILED`。

**通道与能力**（如实声明，ADR-0057）：Pi `sessionGuidance: SUPPORTED`（RPC `steer`，evidence 里写明是否观察到 provider
自己的 `queue_update`）；Codex `REQUIRES_VALIDATION`（`turn/steer` 需要活跃 turn，本 Adapter 不持有，且未验证）；
Claude Code `UNSUPPORTED`（print 模式控制协议没有承载运行中消息的子类型）。**能力不是 `SUPPORTED` 的 provider 会记
`CHANNEL_UNSUPPORTED`（退出码 1）**，不会降级、不会静默。

**记录之后发生什么。** 该 Task 的每一条 guidance 会在**新建 Execution**（含 `task resume` 的 successor 与 `task retry` 的
新 Execution）启动时随启动参数交给 provider，因此指导不随进程消失：Pi 用 `--append-system-prompt <绝对路径>`，
Claude Code 用 `--append-system-prompt <已验证文本>`（knowledge 继续用 `-file` flag），Codex 把两件已核验产物合成
`developerInstructions` 字符串。artifact 位于 `<CODEESTRA_HOME>/guidance/<project-id>/<task-id>/guidance-context.md`
（**绝不写进 Task worktree**），交付事实可从 `session guidance list` 的 `launchedWith[]` 读到。
**零 guidance 时启动参数逐字节不变**；Task 有 guidance 却拿不到 Runtime home 或 artifact 核验不过时**拒绝启动**
（`GUIDANCE_CONTEXT_UNAVAILABLE`），不静默少注入。

稳定码：`CHANNEL_UNSUPPORTED`、`NO_SESSION`、`NO_SUBJECT_EXECUTION`、`TIMED_OUT`、`MISSING_CHANNEL_EVIDENCE`、
`GUIDANCE_DELIVERY_FAILED`、`RUNTIME_RESTARTED`、`NOT_FOUND`、`INVALID_STATE`、`CONCURRENT_MODIFICATION`、
`GUIDANCE_CONTEXT_UNAVAILABLE`。

**零新增确认**：FULL 与 STRICT 下都是同一条命令、同样 0 步 0 等待；guidance 不是审批通道，STRICT 的工具审批仍走既有 Attention。

---

## 7. `session handoff`（原生终端接管）

```sh
bun run codeestra session handoff status <project-id> <session-id> [--json]
bun run codeestra session handoff request <project-id> <session-id> <takeover|return>
bun run codeestra session handoff cancel <project-id> <session-id>

bun run codeestra session handoff writer acquire <project-id> <session-id> --holder <ref>
  [--kind AUTOMATED_RPC|TERMINAL_ATTACHMENT]
bun run codeestra session handoff writer release <project-id> <session-id> --holder <ref>

bun run codeestra session handoff admit  <project-id> <session-id>
bun run codeestra session handoff attach <project-id> <session-id> --holder <ref> [--writer] [--observer] [--since <cursor>]
bun run codeestra session handoff detach <project-id> <session-id> --holder <ref> [--since <cursor>]
bun run codeestra session handoff release <project-id> <session-id> [--no-resume]

bun run codeestra session handoff terminal read  <project-id> <session-id> [--since <cursor>]
bun run codeestra session handoff terminal write <project-id> <session-id> --text <text>
bun run codeestra session handoff terminal resize <project-id> <session-id> --cols <n> --rows <n>
  [--holder <ref>] [--json]
```

要点与退出码：

- 每个子命令都打印 Runtime 返回的同一份 JSON 投影；`--json` 被接受且也是默认。
- `writer acquire` 的 `--kind` 默认 `AUTOMATED_RPC`；`--holder` 必填。**竞争是拒绝而不是排队**：
  第二个 writer 申请 → 退出码 `1`，码 `ATTACHMENT_BUSY`。
- `writer release` 只有在真的释放了才是 `0`；否则 `1`。
- `admit` **真的会启动后继**（takeover 是 PTY 原生终端，return 是 RPC provider），所以它才是**移动 lease** 的那一步。
  它拒绝时在记录任何东西之前就拒绝；已准入的请求会**重放**已记录的后继而不是启动第二个。被拒准入 → `1`。
- `attach` 返回 attachment id 与游标；`detach` 离开时**保持终端与 provider 继续运行**；不属于该 holder 的 detach 是拒绝（`1`）。
- `release` 写终端自己的释放字节，**验证 provider 进程已退出且会话文件仍然保有对话**，然后把它交还给同一会话文件上的自动化。
  `--no-resume` 表示不自动交还。退出码 `1` 表示释放或后继启动无法被确认——**绝不是「大概没问题」**。
- `terminal read` 从 `--since` 游标读投影终端流；`terminal write` 把 `--text` 以 base64 编码发送（是**输入**，不是审批）。
- `terminal resize` 改变 Runtime 持有的 PTY 的几何（ADR-0054）。退出码 `0` **只有真的改了尺寸**（Transport 自己的应答，
  `applied: "APPLIED"`）；`1` 拒绝或未生效；`2` 越界或缺参（stderr 打 `TERMINAL_RESIZE_INVALID_SIZE`）。
  `--cols`/`--rows` 必须是 `1..1000` 的整数（合约的取值域在 CLI、Runtime 与 PTY host 三处都拒绝越界）。
  `--holder <ref>` 是终端的写入者座位：已有客户端持有该终端的 `WRITER` attachment 时，**只有它能 resize**，
  其他 holder（或不带 `--holder`）→ 退出码 `1`、码 `TERMINAL_RESIZE_WRITER_BUSY`（报出当前 holder）。这不是审批，常态路径 0 新增步骤。
  结果同时反映在 `session handoff status` 的 `terminal.currentSize`（仅当本 Runtime 仍持有该终端时非 null）里；
  启动时的 `terminal.windowSize` 只说明**启动时**那次设置是否成功。

相关稳定码：`ATTACHMENT_BUSY`、`HANDOFF_KIND_MISMATCH`、`HANDOFF_NOT_REQUESTED`、`INCARNATION_NOT_CURRENT`、
`SESSION_INCARNATION_UNAVAILABLE`、`SESSION_UNKNOWN`、`NOT_FOUND`、`INVALID_STATE`、
`TERMINAL_NOT_RUNNING`、`TERMINAL_NOT_HELD`、`TERMINAL_NOT_FOUND`、`TERMINAL_EXITED`、
`TERMINAL_RESIZE_INVALID_SIZE`、`TERMINAL_RESIZE_WRITER_BUSY`、`TERMINAL_RESIZE_FAILED`、`PTY_RESIZE_TIMEOUT`、
`TERMINAL_TRANSPORT_UNAVAILABLE`、`PERMISSION_CHANNEL_UNAVAILABLE`、`NOT_A_PERMISSION_ATTENTION`。
相关事件名见 §17。

---

