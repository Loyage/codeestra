# ADR-0040：第三个真实 Adapter（Claude Code）的传输选择、能力矩阵与权限映射

Status：Accepted（Phase 5：接入第三个真实 Agent Adapter）。
**Amends**：无。**Amended by**：暂无。
关联：`docs/spikes/claude-2.1.268.md`（全部实测命令与原始输出）、ADR-0008/0011（默认 FULL 零确认、CLI 完备、测试边界）、ADR-0012（Agent 配置作用域）、ADR-0014（结构化提问通道）、ADR-0023/0026（STRICT Attention 与 Pi 专属 PTY 交接，**不套用到 Claude Code**）、ADR-0029（第二个真实 Adapter 的同类决策，本 ADR 沿用其形态）。

## Context

Phase 5 要求「Pi、Codex、Claude Code 接入；能力矩阵和一致性测试；失败后新 Execution 可更换 Agent」。前两个真实
Adapter 已由 FOUNDATION-019（Pi）与 ADR-0029（Codex）落地。本格接入本机已有的第三个 provider
（`claude 2.1.268`），并且：

1. 先用 spike 实测它到底给出什么程序化接口，再决定接什么；
2. 能力矩阵必须诚实，**不得**把 Pi 专属的 attach / PTY handoff / 安全点通知硬套到 Claude Code，也不得把
   "协议层可支持但未在真实模型下验证"写成已验证；
3. STRICT 复用 provider 自身的权限策略并映射到**既有** Attention 通道，FULL 保持零确认（ADR-0008/0011）；
4. 失败后换 Agent 走既有路径（新 Execution / `task retry`），不引入热切换。

**本格最重要的前提（决定了能力矩阵的写法）**：本机 `claude auth status` 报 `loggedIn:false`、`authMethod:none`，
env 无 `ANTHROPIC_API_KEY`，也没有 `~/.claude/.credentials.json`。**因此没有任何一次真实模型调用**。实测证据到
"发出真实模型请求之前"为止（`--help`、argv 接受性、`initialize` 往返、`system/init`、鉴权失败 `result` 帧、会话文件
布局、`--resume` 的会话加载、ambient 配置抑制）。凡需要模型产生的行为一律 `REQUIRES_VALIDATION`，而不是 `SUPPORTED`
加一段免责声明。

## Options

### D1. 传输

- A. `claude --print --output-format stream-json` 单向事件流。
- B. `claude --print --input-format stream-json --output-format stream-json --verbose`：双向 LF-JSONL + SDK
  control 协议（`control_request`/`control_response`/`control_cancel_request`）。
- C. 依赖官方 `@anthropic-ai/claude-agent-sdk` 包，用它包一层。

选 **B**。A 是单向的：没有应答通道，permission prompt 无处可去，只能把 `nativePermissionRouting` 报成
`UNSUPPORTED`，等于放弃 STRICT gate。C 被拒的三个理由：(1) 它本身就是"spawn 同一个 CLI + 说同一套 control 协议"的
包装，引入一个版本耦合的外部依赖却不多给任何能力；(2) 它会把我们决定要审计的帧（权限请求、初始化回读、终态帧）
藏在库内部；(3) ADR-0029 的先例是每个 provider 的协议形状集中在自己的 `*-protocol.ts` 里，Core 不依赖任何
provider SDK。B 的代价是这套控制协议随 CLI 版本变化：Adapter 因此把形状集中在 `claude-protocol.ts` 一处，并对
不可读的帧显式失败（`INVALID_PROVIDER_RESPONSE`），不静默错读。

### D2. 模型层验证的诚实边界

- A. 没有凭据也照旧声明 `SUPPORTED`，靠文档说明"未在真实模型下验证"。
- B. 凡需要真实模型才能确认的能力报 `REQUIRES_VALIDATION`，只把本地可完整观测的事实报 `SUPPORTED`。

选 **B**。能力矩阵是机器读的（`capabilities()` 会被记进 Execution），`SUPPORTED` 必须意味着"这条机制在本机被
端到端跑通过"。本机没有凭据，所以 `nativePermissionRouting`、`structuredAttention`、`cooperativeStop`、
`resumeAfterExit` 报 `REQUIRES_VALIDATION`；`persistentSession`（transcript 路径与 session id 钉死）、
`controlledConfiguration`（`--safe-mode` 实测抑制 ambient hook/agent）报 `SUPPORTED`。真实模型验收是独立后续项，
需要凭据与用户在场。

### D3. STRICT 的权限来源

- A. 复刻 Pi 的做法：加载 Codeestra 自己的 gate 扩展。
- B. 复用 Claude Code 自己的权限策略：STRICT = `--permission-mode manual`（= provider 的 `default`：危险操作才提示），
  FULL = `--permission-mode bypassPermissions` + `--dangerously-skip-permissions`；把提示请求映射到**既有**
  `PERMISSION`/`CONFIRM` Attention。
- C. 自己包一层沙箱/代理做二次审批。

选 **B**。A 不可能（Claude Code 没有 Pi 那种扩展 UI 协议，本格也不加载任何用户扩展）；C 会新增权限门禁与审批层，
违反 ADR-0008/0011，而且实测证明不需要：`can_use_tool` 是 provider 自己的提示通道，`--permission-prompts` 的默认值
就是 `host`（提示交给宿主）。

必须随矩阵一起读的边界（**不得**被简化成"STRICT 下每个工具都审批"）：

- provider 文档明确 `default` 只对"危险操作"提示，工作区内的文件编辑不需要提示；`acceptEdits` 还会自动接受编辑。
  这与 Codex 的 `workspace-write` 是同一类粒度边界：**Claude 的 STRICT 不是逐工具 allowlist**。
- `--permission-mode bypassPermissions` 实测**不带** `--dangerously-skip-permissions` 也已生效并被回读；Adapter 仍显式
  传该 flag，因为 provider 文档说它需要，且 Codeestra 的 FULL 语义就是显式的主机级零确认。
- `--permission-prompts none` 被拒：它让 provider 静默拒绝一切本会提示的操作，等于绕过 Codeestra 的 Attention 通道，
  而不是把提示交给用户。
- `initialize` 回读的 `current_permission_mode` 被当作生效值校验：与请求不符即启动失败，不允许"以为跑了
  bypassPermissions、其实是别的模式"。

### D4. 结构化提问

- A. 报 `REQUIRES_VALIDATION`，本轮**不实现**问卷编码，所有 `can_use_tool` 一律映射为 `PERMISSION`/`CONFIRM` Attention。
- B. 按 `can_use_tool`/`request_user_dialog` 的形状推测实现问卷通道。
- C. 报 `UNSUPPORTED`。

选 **A**。provider 有内置 `AskUserQuestion` 工具，控制协议里同时存在 `can_use_tool` 与带 `dialog_kind` 的
`request_user_dialog`，但**哪条路径投递、答案如何编码都没有实测**（需要真实模型）。B 会编造未验证的协议，本仓明令
禁止伪造能力；C 又比事实更弱（形状确实观测到了）。A 的诚实降级是：用户看到"Agent 想使用 `AskUserQuestion` 工具"并
可否决，但本轮不把它变成一份问卷，也不实现问卷答案编码。已知风险如实记录：若用户批准了 `AskUserQuestion` 的
permission 请求，provider 是否会在一个无人渲染的 dialog 上等待**未验证**；用户可取消/停止任务。

### D5. 受控启动

- A. 不额外加控制选项，如实报 `controlledConfiguration: UNSUPPORTED`（ambient 配置参与执行）。
- B. 加 `--safe-mode --strict-mcp-config`，报 `SUPPORTED`。
- C. 加 `--bare`。

选 **B**，**排除 C**。实测：默认启动会触发用户 `~/.claude/settings.json` 的 `SessionStart` hook，并在
`initialize` 响应里列出用户 agent `statusline-setup`；`--safe-mode` 抑制该 hook 且不再列出该 agent，而 provider 文档
说明 `--safe-mode` 保留 Auth、模型选择、内置工具与权限。C 被排除是因为 `--bare` 明确"OAuth 与 keychain 永不读取"，
会破坏用户自己的登录（只认 `ANTHROPIC_API_KEY`），在 ADR-0011 的"不新增门禁、不改变权限来源"下不可接受。
`--strict-mcp-config` 一并把 ambient MCP server 排除。若实现中发现 `--safe-mode` 在任何路径破坏鉴权、恢复或审批通道，
就改报 `UNSUPPORTED`——本格没有发现这种情况。

### D6. 会话身份与恢复归属

- A. 信任数据库里记录的会话路径。
- B. 用我们自己的 UUID 经 `--session-id` 钉死会话，按实测派生规则算出 transcript 路径；恢复时要求记录的路径是
  **`<configDir>/projects/` 的直接子目录里的普通文件、文件名为 `<session-id>.jsonl`**，并要求 provider 回读的
  session id 与记录一致，否则 `SESSION_NOT_OWNED`/`SESSION_IDENTITY_MISMATCH`。

选 **B**。实测：`--session-id <uuid>` 被 `system/init` 原样回读；transcript 写在
`<configDir>/projects/<sanitize(realpath(cwd))>/<session-id>.jsonl`（sanitize = 每个非 `[A-Za-z0-9]` 字符 → 单个 `-`，
三例实测），`CLAUDE_CONFIG_DIR` 可重定位 config home。恢复时**不**按当前 cwd 重新推导路径：一个 Task 的 worktree 在
两次 Execution 之间可能被重建到别的路径，那不该让同一个 conversation 失效；要成立的是"这个 conversation 在**本**
config home 里、且就是记录的那个"。

### D7. 终态判定与完成证据

- A. 只看 `result.subtype`。
- B. 同时看 `subtype`、`is_error`、`terminal_reason`；并把"关闭 stdin 并确认子进程退出"作为发 `completed` 的前提。

选 **B**。实测：鉴权失败以 `subtype:"success"` + `is_error:true` + `terminal_reason:"api_error"` 到达（退出码 1），
只看 `subtype` 会把失败记成 `SUCCESS`。另外 `result` 只结束 **turn**：`--print` 会话会继续等待输入，所以 Adapter 先
关闭 stdin（再 SIGTERM/SIGKILL）并确认退出，才写 `toolsQuiescent:true`/`ownedWritersStopped:true`；确认不了就报
`disconnected` 并记 `unconfirmedStops`，让 Runtime 保留现场。

### D8. ADR-0012 配置字段

- A. 强行把 `provider` 映射到某个 Claude 参数。
- B. `model` → `--model`；`thinkingLevel` → `--effort`（只接受 provider 支持的 `low|medium|high|xhigh|max`）；
  `provider` 在这个 scope 明确拒收。

选 **B**。first-party Claude Code 没有 provider 启动参数（模型用 `--model`，API 面由 provider 自己的环境变量决定），
把 provider 记成"已生效"就是说谎。实现分两处落地：`agent config set --adapter claude --provider …` 在写入前以
`INVALID_AGENT_CONFIGURATION` 拒绝（什么都不写），解析/启动路径也在 Adapter 边界以
`UNSUPPORTED_AGENT_CONFIGURATION` 拒绝。`thinkingLevel` 的 `off`/`minimal` 在 provider 没有对应档位，同样拒绝而不是
静默降级或四舍五入——Execution 记录的是"我请求的配置"，跑成另一个值会让这条记录失真。

## Decision

1. **传输**：`claude --print --input-format stream-json --output-format stream-json --verbose`，
   LF-JSONL；`claude-protocol.ts` 负责 framing、argv、权限映射、帧解析与答案编码，`claude-process.ts` 负责一个子进程
   的 stdio、控制请求路由与停止，`claude-adapter.ts` 实现既有 `AgentAnswerAdapter` + `AgentProcessRelease` port。
   `adapterId = "claude"`（provider 的产品名 `claude-code` **不是** adapter id）。不引入 Agent SDK 依赖。
2. **受控启动**：`--safe-mode --strict-mcp-config --permission-prompts host`；`model`/`thinkingLevel` 按 Execution 解析
   （ADR-0012）后以 `--model`/`--effort` 传入；会话 id 由 Runtime 生成 UUID 经 `--session-id` 钉死（恢复时用
   `--resume <id>`）。`initialize` 不声明任何 dialog kind（provider 文档：缺失即 fail-closed 降级），并核对回读的
   `current_permission_mode`。
3. **权限映射**：FULL = `bypassPermissions` + `--dangerously-skip-permissions`（零确认）；STRICT = `manual`，提示请求
   → 既有 `PERMISSION`/`CONFIRM` Attention，`CONFIRM true/false` → `{behavior:"allow"|"deny", toolUseID}`，
   `CANCEL` → `{behavior:"deny", interrupt:true, toolUseID}`。**不**发送 `updatedInput`（不改写工具输入）、**不**发送
   `updatedPermissions`（那会静默扩大后续权限）。不新增审批层、不新增确认（ADR-0008/0011）。
4. **能力矩阵**（实测见 spike §4）：
   `persistentSession: SUPPORTED`、`structuredAttention: REQUIRES_VALIDATION`、
   `nativePermissionRouting: REQUIRES_VALIDATION`、`pauseWithQuiescence: UNSUPPORTED`、
   `revisionAcknowledgement: UNSUPPORTED`、`cooperativeStop: REQUIRES_VALIDATION`、`attach: UNSUPPORTED`、
   `nativeTerminalHandoff: UNSUPPORTED`、`safePointNotification: UNSUPPORTED`、
   `reconnectToLiveSession: UNSUPPORTED`、`resumeAfterExit: REQUIRES_VALIDATION`、
   `controlledConfiguration: SUPPORTED`。
5. **完成证据**：终态帧三信号联合判定；发 `completed` 前必须确认自己的子进程已退出；无法确认即 `disconnected` +
   `unconfirmedStops`。`facts`（`toolCallCount`/`finalAssistantText`/`finalAssistantStopReason`）从 provider 自己的
   `assistant` 帧收集，供 Runtime 的散文提问判定使用（FOUNDATION-056）。
6. **Agent 配置**：`agentConfigurationEnvironmentVariables` 增加 `claude`（`CODEESTRA_CLAUDE_MODEL`/`CODEESTRA_CLAUDE_THINKING`，
   **不含** provider）。scope 声明的字段是该 Adapter 能承载的字段：不支持的字段在任何作用域被设置都报
   `INVALID_AGENT_CONFIGURATION`（解析路径），`agent.config.set` 在写入前拒绝。
7. **CLI**：`--adapter` 现在接受 `claude`（usage 文本列出 pi/codex/claude）；不需要新命令。`task retry` 的
   "失败后换 Agent"沿用 ADR-0036 的既有路径，本格未改调度。
8. **不实现**：attach/PTY/handoff、安全点通知、pause、revision ACK、live process 重连、结构化提问编码、
   `--bare`、`--permission-prompts none`。不修改用户 `~/.claude` 配置或凭据；不打印 token。

## Consequences

- Core（`packages/domain`、`packages/storage`、runtime 服务）不出现任何 Claude 类型：Claude 只存在于
  `packages/agent-adapters/src/claude-*.ts` 与 registry 的注册行。`capabilities` 继续以 JSON 记录。
- FULL 下 Claude 与 Pi/Codex 一样是 0 次确认；STRICT 下审批走**同一个** Attention/answer 命令面，CLI 与 UI 不需要为
  第三个 provider 增加任何命令。
- 诚实代价（必须与能力矩阵一起读）：
  - 四个 `REQUIRES_VALIDATION`：真实模型下的审批往返、interrupt 后工具是否静止、结构化提问投递、恢复对话内容，本机
    无凭据，一律未验证。真实模型验收是独立后续项。
  - STRICT 的粒度是 provider 的"危险操作才提示"，不是逐工具审批；`workspace-write` 类边界同样适用于 Claude。
  - `resumeAfterExit` 只验证到"会话被加载、id 被保留"；"内容被复述"未验证。
  - 结构化提问降级为工具级审批：用户看到的是"Agent 想使用 AskUserQuestion"，不是一份问卷。
  - `controlledConfiguration: SUPPORTED` 有明确前提：必须带 `--safe-mode`；不带它就退化为"ambient 配置参与执行"。
  - 控制协议随 CLI 版本变化；不可读的帧会明确失败（`INVALID_PROVIDER_RESPONSE`/`PROVIDER_RESPONSE_INVALID`），
    不静默错读。
- 跨 provider 恢复 fail-closed：把 Claude 的 transcript 路径交给 Pi Adapter 会被拒绝
  （`AGENT_START_FAILED: The resumed session file is not inside the Runtime Pi session directory`），实测见
  `apps/runtime/test/cli-claude-adapter.test.ts`。不存在"悄悄开一段新对话"的降级。
- 已知缺口（**不改**，如实记录）：`session.transcript`（ADR-0013）仍只认 Runtime 的 Pi 会话目录，因此 Claude Session
  上会以 `SESSION_FILE_NOT_OWNED` 明确失败，而不是显示执行过程。把它做成 provider-agnostic 需要另立一格。
- 既有测试中"`claude` 未注册"的三处断言按新事实更新（`apps/runtime/test/adapter-registry.test.ts` 的 adapter id 列表
  与未知 id 探针改为 `claude-code`；`slot-reservation-service.test.ts` 与 `cli-capacity-slots.test.ts` 的未知 adapter
  探针改为 `claude-code`），理由见 FOUNDATION-066 记录。

## Verification

协议层证据（真实 `claude` 2.1.268，命令与原始输出见 `docs/spikes/claude-2.1.268.md`）：

- 真实 CLI 接受 Adapter 实际使用的两套 argv（STRICT 与 FULL），`initialize` 往返成功并如实回读
  `current_permission_mode`（`manual`→`default`、`bypassPermissions`→`bypassPermissions`）；这两次探针只发
  `initialize`，**不发 user turn**，因此不触达模型（`account.tokenSource:"none"`）。
- 3 次**无凭据** `--print` 尝试（授权范围内）实测：鉴权失败帧形状（`subtype:"success"` + `is_error:true` +
  `terminal_reason:"api_error"`，退出码 1，`total_cost_usd:0`）、transcript 文件确实写在派生路径、
  `--resume <id>` 加载记录会话并保留同一 session id、`bypassPermissions` 不需要 danger flag 即生效。
- `--safe-mode` 抑制用户 `SessionStart` hook 与用户 agent（`initialize` 响应对比实测）。
- transcript 派生规则 3 例实测；`CLAUDE_CONFIG_DIR` 重定位实测。

Stub 证据（`bun test packages/agent-adapters/test/claude-adapter.test.ts`，29 项，全通过）：能力矩阵全量断言、
argv（STRICT/FULL/model/effort/`--session-id`/`--resume`）、`thinkingLevel off|minimal` 与 `provider` 拒绝、权限模式回读
不符即拒绝、会话 id 不符即拒绝、未开会话即超时后确认停止；resume 归属（越界/缺文件/文件名不符/symlink/嵌套过深/无 session id/provider
换了会话）；事件映射（SUCCESS + facts、**鉴权失败不得记 SUCCESS**、失败与不可读帧、`can_use_tool` → Attention →
`allow`/`deny`/`interrupt` 写回、非确认答案被拒且请求保持 OPEN、重复应答被拒、被撤回的请求不可再答、
未实现的 `request_user_dialog` 被显式拒绝而不是挂住 turn、意外退出 → `disconnected`、第二段会话冒用同一 Session →
`disconnected`、cursor epoch 与失联 Session 拒绝、`releaseSession` 确认退出）。

CLI/命令面证据（`bun test apps/runtime/test/cli-claude-adapter.test.ts`，5 项，全通过）：STRICT 下
`permission set strict` → `open --yes` → `task run --adapter claude` → `attention list` 看到 `PERMISSION`/`CONFIRM`
（`kind: claude.permission`）→ `attention answer … confirm no` → Session EXITED 且 stub 收到 deny；FULL 下无 Attention 且
argv 为 `bypassPermissions`+danger flag+受控启动选项；probe 失败的 run attempt 之后 Task 仍 READY，
`task run --adapter pi` 建立新的 Execution 并成功；`agent config set --adapter claude` 只影响 Claude 启动且拒收
`provider`（`INVALID_AGENT_CONFIGURATION`）；pause → `task resume --adapter claude` 以 `--resume` 重开同一会话，
`--adapter pi` 被 fail-closed 拒绝。

**未跑的检查与原因**：真实模型驱动完整 CLI 流程（`task run --adapter claude` 对真实 provider）未做——本机没有凭据，
本格无法发出真实模型请求；`can_use_tool` 的真实 fail-closed 往返、interrupt 后的工具静止、`AskUserQuestion` 的真实
投递、恢复对话内容、多工具批次、`--include-partial-messages`/`--include-hook-events`、`set_permission_mode`、Windows
未验证（spike §6 已列）。schema 未改动（仍 v24），未新增迁移号。

**已知文档不一致（需一次 doc-sync）**：`docs/architecture/agent-adapter-api.md` 的类型清单仍写 9 项
`AdapterCapabilities`（沿用 ADR-0019/0027/0029 对架构文档的先例：本格不动架构文档，在此显式记录）。

## 关联文档

- `docs/spikes/claude-2.1.268.md` — 实测命令、原始输出、能力结论与证据分级。
- `docs/tasks/README.md` 的 `## FOUNDATION-066` — 本格交付与验证记录。
- ADR-0012（配置作用域）、ADR-0014（结构化提问）、ADR-0023/0026（STRICT Attention 与 Pi PTY 交接的边界）、
  ADR-0029（Codex Adapter，同类决策的先例）。
