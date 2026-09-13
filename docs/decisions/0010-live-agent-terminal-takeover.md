# ADR-0010：运行中 Agent 的原生终端接管与安全点进程交接

Status：Accepted；**Amended by ADR-0011**：FULL 下接管后的工具不确认，STRICT 保留审批；安全点与单 writer 不变。

## Context

Codeestra 当前以 Pi RPC 子进程运行 Agent。Runtime 持有结构化事件、Attention 与回答通路，但用户只能观察状态和回答问题，不能进入 Agent 的原生交互终端。

Pi 0.84.4 支持 RPC `steer`，却不能把原生 TUI 附着到已经运行的 RPC 进程；持久 session 可以在旧进程退出后由新进程恢复。因此“直接进入原生 TUI”不能伪装成普通日志 attach，也不能让第二个 Pi 进程与原 RPC 进程同时打开同一 session/worktree。

用户希望：

1. 直接进入 Provider 原生终端/TUI，而不是仅看日志或使用仿终端聊天框。
2. 会话指导与任务规格修改分开：普通输入立即指导当前 Agent；改变验收目标仍走 TaskRevision。
3. 新指导不强杀正在执行的工具，在当前工具完成后的安全点尽快生效。
4. Pi 采用安全点进程交接：自动 RPC 进程退出后，以同一持久 conversation 启动 TUI；交还后再恢复 RPC 自动运行。

## Options

### 介入界面

- A. 原生终端/TUI 完全接管。
- B. RPC 上实现终端式结构化控制台。
- C. 只提供单次 steering 消息。

选择 A。

### 指令语义

- A. 双通道：会话指导不改变验收规格；任务修订生成 TaskRevision。
- B. 所有输入都生成 TaskRevision。
- C. 所有输入都只影响 conversation。

选择 A。

### 生效时机

- A. 等待当前工具/模型轮次到可证实安全点后立即交接。
- B. 强制 abort 当前轮次。
- C. 当前任务自然完成后再处理。

选择 A。

### Pi 原生 TUI 的实现

- A. RPC↔TUI 安全点进程交接，复用持久 conversation。
- B. 保持 RPC，只提供近似终端的控制台。
- C. 所有 Agent 从启动起都运行在 TUI/PTY，并另建旁路推断状态。

选择 A。

## Decision

### D01：Task-first 的接管命令面

接管是 Execution 的控制模式，不建立以 Terminal 为业务主实体的新调度模型。权威入口先提供 CLI/Runtime 命令面：

- `task takeover request <project-id> <task-id> [execution-id]`：持久化接管请求；`--wait` 可等待到终端可附着，`--json` 返回稳定状态与退出码。
- `task takeover attach <project-id> <task-id> [execution-id]`：请求并附着的常态快捷路径；一次命令完成，不增加确认步骤。
- `task takeover status ...`：查询请求、交接阶段、当前 process/session 与 writer lease。
- `task takeover release ...`：请求在安全点退出 TUI 并恢复自动 RPC 模式。
- `task guide ... --message <text>`：无需原生终端时的脚本化会话指导，Pi RPC 使用 `steer` 语义。
- `task amend ...`：改变规格/约束，生成 TaskRevision，沿用既有暂停或停止后新 Execution 规则。

Web UI/未来桌面只能投影同一命令和双工终端传输；不得拥有只有 UI 可用的接管能力。原始 PTY attach 也必须有 versioned framing、明确终止原因和稳定 CLI 退出码。

接管请求本身就是用户的显式操作，不再追加“是否接管”的第二次确认。Session 继承启动时的 `FULL | STRICT` 权限模式：FULL 下接管与工具均不确认；STRICT 下项目 trust、敏感工具审批、成果 commit 与其他兼容门禁继续有效（ADR-0011）。

### D02：双通道输入

- 原生 TUI 中的普通输入与 `task guide` 都是 **Session Guidance**：写入真实 provider conversation 并审计来源/投递元数据，但不生成 TaskRevision、不改变 `appliedRevisionId`，也不自动使验证失效。它不能悄悄改写验收标准。`task guide` 的正文需先耐久保存才能在崩溃前后可靠投递；TUI 已写入 provider session 的正文不再复制，只保存 entry 引用/hash/长度。
- 规格、约束或验收目标的改变必须由 `task amend` 明确提交为 **Task Revision**。Pi 0.84.4 没有可靠 revision ACK/pause，因此仍采用协作停止、确认静止、旧 Execution `SUPERSEDED`、新 Execution 以完整 revision 启动的 fallback；终端接管不绕过该规则。
- UI/CLI 必须明确标注当前输入属于“会话指导”还是“修改任务”，不能依靠自然语言分类暗中切换通道。

### D03：安全点与竞态顺序

接管请求只表示 intent 已持久化，不表示终端已经可用。Pi 的安全点必须同时满足：

1. 当前模型轮次和已开始的工具调用已结束；
2. Adapter/受控 extension 报告没有活动工具；
3. Runtime 持有的 writer/process identity 仍匹配；
4. 没有尚未解决、正阻塞当前 RPC 工具调用的 Attention。

Runtime 不为接管强杀当前工具。Pi RPC 收到请求后先建立 **handoff fence**：用受控 steering 在当前 assistant turn 的工具调用结束后通知 Agent 让出控制；gate extension 从该时点起阻止新启动的 Agent 工具调用并以 terminating result 收束当前 run，但不终止已经开始的工具。最终以 `agent_settled`（Pi 文档定义为无 retry、compaction retry 或 queued continuation）和活动工具计数为安全点。接管请求先于可信 settled 被记录时，该 settled 事实作为交接安全点，不能同时把 Execution 投影为已完成；若 completion 已先提交，后来请求返回 `EXECUTION_NOT_ACTIVE`。数据库事务顺序决定竞态，不依赖客户端时间，也不依赖模型自愿停止。

若 Permission/Question 正阻塞 RPC，接管状态显示 `WAITING_FOR_ATTENTION`；用户先通过既有命令面回答或取消该请求，随后继续等待安全点。超时只报告仍在等待，不强杀、不释放资源。

### D04：进程交接而非双开 session

一次 Execution 在任意时刻最多有一个可写 Provider 进程，但允许保存有序的 AgentSession process incarnation 历史：

```text
AUTOMATED_RPC
  → TAKEOVER_REQUESTED
  → HANDOFF_TO_TERMINAL
  → HUMAN_TUI
  → RETURN_REQUESTED
  → HANDOFF_TO_AUTOMATION
  → AUTOMATED_RPC
```

交接步骤：

1. 固定 takeover request、当前 AgentSession、provider session ID/file、process identity 与最后 provider cursor。
2. 等待 D03 安全点；停止接受新的自动 guidance/revision delivery，并串行化 Attention 回答。
3. 在 `agent_settled` 后请求 RPC 进程正常退出并确认其归属进程已停止；受控 extension 可用 Pi `ctx.shutdown()`（文档保证延迟到 idle）辅助正常关闭。未确认停止则进入 `RECOVERY_REQUIRED`，绝不启动第二个进程。
4. 核对 session file 身份与最后 entry，使用相同 workspace、受控工具集、gate extension、provider/model 和持久 session 启动 Pi 原生 TUI 于 Runtime 持有的 PTY。
5. 创建 successor AgentSession（mode=`HUMAN_TUI`，记录 predecessor）；同一时刻只有该 Session ACTIVE。恢复相同 provider conversation 不伪造成同一 OS 进程。
6. 用户请求交还时等待 TUI 安全点，确认 TUI 进程退出，再以同一 session file 创建 mode=`AUTOMATED_RPC` 的 successor Session。Runtime 写入固定、可审计的 continuation guidance 后恢复自动运行。

任一步身份、退出或 session file 状态不确定，Execution/workspace 保持占用并进入恢复态。不得让 RPC 与 TUI 两个进程同时访问同一 conversation/worktree。Runtime 重启后如果丢失 PTY/RPC 控制连接，仍不能声称重新附着 live process。

### D05：附着、分离与写入租约

- 一个 HUMAN_TUI Session 同时最多一个 PTY writer lease；其他客户端可只读观察。writer 竞争返回稳定的 `ATTACHMENT_BUSY`，不是新增审批。
- CLI 以本地 escape prefix 区分“发给 Pi 的字节”和“Codeestra 控制动作”；至少提供 detach 与 release。具体按键可配置，协议动作不可只存在于按键。
- detach 只释放客户端 attachment，不停止 TUI、不交还自动模式。再次 attach 连接到 Runtime 仍持有的同一 PTY。
- release 才触发 D04 的 TUI→RPC 交接。客户端异常断开等同 detach。
- resize、input、output、lease acquired/released 使用独立 TerminalTransport 帧；业务状态不从 ANSI 输出或终端提示词推断。

### D06：权限模式、审计与终端数据

原生 TUI 沿用该 Session 启动时的权限模式，不得因进程交接暗中切换：

- `FULL`：所有已注册 Agent 工具继续自动允许，不建立 Permission Attention，不重新引入工具确认；handoff fence 阻止接管请求之后的新工具是进程交接正确性控制，不是权限门禁。
- `STRICT`：继续执行 ADR-0004 的 Agent 工具逐次审批与 unknown-tool fail-closed。受控 gate extension 在 TUI 模式通过 Runtime side channel 报告 permission request/resolution；Runtime 建立 AttentionRequest、保存 typed answer 事实并保持一请求一次决议。原生 TUI 与其他 Codeestra 客户端竞相回答时，coordinator 只接受第一份合法决议，extension 以 AbortSignal 关闭另一侧仍在等待的 dialog，其余作为迟到输入拒绝或审计，不能二次驱动工具。

原生 TUI 自带的模型选择、会话命令与 `!` 人工 shell 仍属于用户直接操作，不伪装为 Agent 工具调用；受控 extension 必须通过结构化 side channel 记录会影响 provider 配置或 workspace 的事实。用户已直接键入的 shell 命令不再增加确认，但其文件变化仍进入最终固定 ChangeSet；FULL 单步 capture，STRICT 按其成果 commit 门禁处理。恢复自动 RPC 时重新应用 Execution 固定的权限模式、工具配置与 extension；若用户改变 provider/model，先记录实际值，不能沿用旧能力快照谎称未变化。

PTY 字节和用户键入可能包含密钥、ANSI 控制序列与 prompt injection：

- 不写入 domain event payload、Intent 或 TaskRevision；
- 首版只保留 Runtime 内存中的有界重连缓冲和截断标记，不持久化原始 PTY 日志；
- 结构化业务事实来自 Adapter/extension side channel，不从屏幕文本抓取；
- Session Guidance 的 domain event 只含来源、provider entry 引用、hash、长度、actor 与时间，不含正文；`task guide` 命令正文保存在 guidance 记录以支持耐久投递，TUI 已落 provider conversation 的正文不重复保存。

## Consequences

- 用户可一条 CLI 命令进入真实 Pi TUI，并在退出客户端后保持 Agent/PTY 运行；不会把只读日志谎称为 attach。
- 相比 RPC steering，首次接管需等待安全点并重启 Provider 进程，延迟更高，但保留原生 TUI 与现有结构化自动运行边界。
- `agent_sessions.execution_id UNIQUE` 不再适合：一个 Execution 可有多条顺序 Session incarnation，但任意时刻最多一条活动 Session。
- 需要 PTY transport、writer lease、handoff Operation、Pi TUI gate side channel 与 session-file 交接 spike。它们属于 Phase 3，不在本文档变更中伪装为已实现。
- 普通会话指导不会改变验收标准；用户若实际改变需求，需要明确走 `task amend`。这是效率与可追溯性的有意分界。
- 未新增权限门禁；常态 attach 是一次操作。等待安全点是正确性条件，不是审批层。

## Verification

仅通过 CLI/Runtime 命令面和临时仓库验证：

1. 工具运行中请求 takeover 不 abort 工具；在结构化安全点后才启动 TUI。
2. 任意时刻最多一个归属 Provider writer；旧进程未确认退出时不启动 successor。
3. 原生 Pi TUI 读取同一 provider conversation，用户输入真实出现在 session history；交还后 RPC 从该历史继续。
4. detach 不停止 TUI；重新 attach 可继续；第二 writer 得到 `ATTACHMENT_BUSY`。
5. Session Guidance 不创建 TaskRevision、不改变 applied revision；`task amend` 创建 revision 并走既有 Pi fallback。
6. 权限模式跨交接保持：FULL 中已注册工具零确认；STRICT 中 write/edit/bash/powershell 逐次产生可审计 Attention、未知工具拒绝。
7. PTY 输出不进入 domain event/Intent/Revision，缓冲截断明确报告。
8. 在 RPC 退出后、TUI 启动前以及反向交接各故障点注入崩溃，均不双开进程、不释放 workspace，并进入可解释恢复态。
9. CLI `--json` 的 request/status/release 具有稳定 schema 与退出码；PTY framing 可由 headless 测试驱动，不使用桌面或键鼠自动化。

## Related

- `PROJECT_SPEC.md` §1.1、§2、§6、§7
- ADR-0001 D01/D04
- ADR-0002（Pi 能力与取消）
- ADR-0004（原生审批与 typed answer）
- ADR-0008（CLI 完备、效率优先、测试边界）
- ADR-0011（默认 FULL 零确认；修订本 ADR 的工具确认语义）
- `docs/spikes/pi-0.84.4.md`
- `docs/architecture/agent-adapter-api.md`
- `docs/architecture/state-machines.md`
