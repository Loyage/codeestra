# ADR-0013：只读 Agent 会话过程视图

Status：Accepted（用户本轮四题确认）。本 ADR 不新增权限门禁、不改变任何 Task/Execution 语义，也不实现 ADR-0010 的原生终端接管。

## Context

用户要求“在 Web UI 看到 Agent 执行过程的详细内容”。当前状态：

- Web UI 的「事件」页只显示 domain event（`TaskCreated`、`ExecutionStateChanged`、`UserAttentionRequested`…），全部是元数据：看不到 Agent 说了什么、调用了哪些工具、工具返回了什么、花了多少 token。
- `PiRpcAdapter.observe()` **已经**收到 Pi 的完整结构化事件流（`message_start/update/end`、`tool_execution_start/update/end`、`turn_end`、`agent_settled`…），但只把 `attention`/`completed`/`disconnected` 投影成 domain 事件，其余丢弃。
- Pi 同时把完整会话写入持久 session JSONL 文件，Runtime 已把路径记录在 `agent_sessions.session_storage_ref`，文件位于 `CODEESTRA_HOME/pi-sessions/`（`--session-dir` 传入）。该文件含 user 消息、assistant 文本、thinking、`toolCall`（名称+参数）、`toolResult`、`usage`（input/output/cache/reasoning/totalTokens/cost）与 `stopReason`。
- domain event 的既有边界明确禁止把原始终端数据写入事件（`docs/architecture/event-model.md` §4、ADR-0010 D06）：PTY 字节不入 domain event、Intent、TaskRevision。

因此“详细执行过程”有三条可行路线：读 provider 会话文件（只读视图）、把 RPC 事件投影入库（新的写入语义与存储增长）、或实现完整 PTY 原生终端接管（ADR-0010 Phase 3，前置 spike 未做）。

## Options

### 数据来源

- A. 读取 Pi 的持久 session 文件，作为只读视图暴露。完整（含 thinking/usage/cost）、不新增写入路径、不把敏感数据复制进 SQLite、Runtime 重启后仍可回看。代价是消息级粒度（provider 写完一条消息才可见），实时靠增量读取。
- B. 扩展 `observe()` 把 message/tool 生命周期投影成新的 AgentActivity 事件与表，经 SSE 实时推送。可做 token 级流式且可审计，但新增数据语义、存储增长、工具参数/输出默认入库，并需要新的保留策略。
- C. A+B 组合：运行时用 RPC 投影实时推送，结束后用 session 文件完整回看。能力最强，但两套语义需要同时维护并保持一致。
- D. 实现 ADR-0010 Phase 3 的 PTY 原生终端接管。真正的“像 TUI 一样看”，但需要先完成安全点进程交接、PTY transport、writer lease 与 session incarnation 改造，远超出本轮。

选择 A。

### 内容与敏感数据

- 显示内容：工具调用与工具返回、助手文本、thinking、token 用量与成本（全选）。
- 长内容：截断展示 + 可展开全文。默认每条内容块截断（4000 字符）并折叠，客户端可按需取回完整块；`maxTranscriptPartChars`（200000）是单次响应的硬上限。
- 实时性：运行中的 Session 由界面自动增量轮询（约 1.5s），不新增 SSE 帧类型。

## Decision

### D01：只读视图，不是事件，也不是 attach

- 新增 Runtime 命令 `session.transcript`（`--after <entryId>` 排他游标 + `limit`）与 `session.transcript.part`（取回单个完整内容块）。两者都只读：不写 SQLite、不写 `event_deliveries`、不改变 Task/Execution/Session 状态、不产生任何业务事实。
- 该视图**不是** attach，也不是终端接管：命名与文档不得声称进入 Agent 交互终端。ADR-0010 的原生 TUI 接管仍然是独立且未实现的 Phase 3 能力。
- 结束的 Session 仍然可读：transcript 是历史，不要求 Execution 处于 live 可观察状态（与 `getObservableAgentSession` 的约束不同）。

### D02：文件归属与路径边界

- 只允许读取 Runtime 自己的 Pi session 目录（`CODEESTRA_PI_SESSION_DIR` 或 `<CODEESTRA_HOME>/pi-sessions`）内的普通文件，该目录正是 Adapter 写入会话文件的位置，写入方与读取方共用同一个 owner 定义。
- 归属判定在 `realpath` 之后的规范路径上完成：配置目录本身位于符号链接之下（macOS `/tmp` → `/private/tmp`）仍可正常读取，而目录内指向外部的符号链接被拒绝（`SESSION_FILE_NOT_OWNED`）。
- 记录的路径、目录不存在、非普通文件分别给出明确结果或稳定错误码；不静默回退、不读取任意路径。
- Runtime 是唯一的文件读者：命令响应只携带身份与内容，**不把 provider 文件路径回传给客户端**。

### D03：内容边界与截断

- 列表读取对每个内容块给出有界预览（`transcriptPartPreviewChars`，4000 字符）、`truncated` 与真实长度 `fullChars`；`session.transcript.part` 用同一渲染函数返回完整块，因此“展开”看到的内容与预览是同源的同一份字节。
- 预览与完整块都不写入 SQLite。这与 ADR-0010 D06 一致：原始终端数据只存在于 provider 自己的文件中，Codeestra 只读地、有界地展示它。
- 未知条目类型、未知消息角色与无法解析的行都显式报告（`note` / `unparsedLines`），不静默丢弃。
- 该视图可能显示工具参数与工具输出（可能含密钥或大段文件内容）。这是本轮明确的取舍：用户要求看到真实过程，因此不脱敏、但在客户端侧截断并需显式展开。FOUNDATION-019 记录的“Attention `prompt_json` 是否入库/摘要化”仍是独立的未决问题。

### D04：CLI 完备（ADR-0008）

- CLI 提供 `task transcript <project-id> <task-id> [--execution <id>] [--after <entry-id>] [--limit <n>] [--json]`、`session transcript <session-id> […]` 与 `session transcript part <session-id> <entry-id> <part-index>`。
- `task transcript` 只组合既有命令（`task.status` 解析 Session，再调 `session.transcript`），不新增第二条业务语义路径。
- 人类可读渲染为默认输出（这是“看过程”的入口），`--json` 输出 Runtime 的原始视图供脚本消费；失败用稳定错误码与退出码 1。
- Web UI 只投影同一命令面，不新增只有 UI 可用的能力。

## Consequences

- 用户能在 Web UI 与 CLI 里看到 Agent 的真实过程（工具调用、工具返回、助手文本、thinking、token/成本），无需等待 Phase 3 接管。
- 不新增写入路径、不新增存储、不新增门禁：`session.transcript` 是纯查询，常态路径零额外确认。
- 代价一：这是**观察**而非**控制**。运行中的任务仍不能从该面板发送 guidance 或接管终端；那是 ADR-0010 的范围。
- 代价二：粒度是 provider 写入会话文件的粒度（通常一条消息一次），不是 token 级流式。若将来需要 token 级实时，需要按选项 B 决策新增投影与保留策略，本 ADR 不预先承诺。
- 代价三：可能把工具参数/输出（含密钥或大文件内容）渲染进浏览器与终端。缓解手段是截断与按需展开，以及 Runtime 不持久化这些内容；不引入脱敏规则（需要单独决策）。
- 代价四：`usage`/`cost` 是 provider 自报值，Codeestra 不做计费校验，也不据此产生业务事实。

## Verification

仅通过 CLI/Runtime 命令面断言（ADR-0008）：

1. 真实 Pi 会话文件形状的夹具：user/assistant（thinking + toolCall + usage）/toolResult/未知条目类型正确归一化，`thinkingSignature` 等 provider 回放产物不展示。
2. 排他游标分页：不重不漏；未知游标返回 `TRANSCRIPT_CURSOR_UNKNOWN` 而不是夹到尾部。
3. 截断与展开：列表返回有界预览且标记 `truncated`/`fullChars`，`session.transcript.part` 返回与预览同源的完整内容。
4. 归属：目录外路径、目录内指向外部的符号链接、非普通文件都被拒绝（`SESSION_FILE_NOT_OWNED`）；配置目录位于符号链接之下仍可读；文件缺失/未记录路径返回 `fileAvailable:false` 与说明。
5. CLI 端到端（真实 CLI 子进程 + 临时 `CODEESTRA_HOME` + 协议 stub provider 写出真实形状的会话文件）：`task transcript --json` 与人类可读输出、`session transcript --after` 续读、`session transcript part` 展开、未知道具与不存在的 Session 的稳定退出码。
6. 直接篡改数据库把 `session_storage_ref` 指到目录外后，`task transcript` 必须失败且不泄露该路径。
7. HTTP 传输（Web UI 实际使用的路径）：`/api/command` 上无 token/wrong token 401，`session.transcript` 与 `session.transcript.part` 返回与 socket 相同的结果；`events.subscribe` 仍然只能走 socket。
8. **不得**以 stub provider 的通过声称真实 Agent 集成已验收。

## Related

- `docs/architecture/event-model.md` §4（终端数据的边界）
- `docs/architecture/agent-adapter-api.md` §2（只读日志浏览必须诚实命名，不宣称 attach）
- ADR-0010（原生终端接管，仍未实现）、ADR-0008（CLI 完备与测试边界）、ADR-0011（零确认）
- FOUNDATION-019（Attention `prompt_json` 入库的未决问题）
