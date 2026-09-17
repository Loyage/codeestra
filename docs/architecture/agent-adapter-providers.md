# Agent Adapter：逐 Provider 实测能力与证据

> 层级：L2 按需参考 · 体量 ≈ 10k 字符 · **何时读**：判断某个 provider 能不能做某件事、写它的启动参数、核对能力位依据 · 证据原始记录在 [`../spikes/`](../spikes/)（`pi-0.84.4.md`、`codex-0.151.0.md`、`claude-2.1.268.md`、`pi-parallel-tool-batch.md`）。端口与语义见 [`agent-adapter-api.md`](./agent-adapter-api.md)。

## 1. 能力位汇总（全部来自实测）

| 维度 | Pi | Codex | Claude Code |
|---|---|---|---|
| `persistentSession` | `SUPPORTED` | `SUPPORTED` | `SUPPORTED` |
| `structuredAttention` | `SUPPORTED` | `SUPPORTED` / `UNSUPPORTED`（随 `--enable default_mode_request_user_input`） | `REQUIRES_VALIDATION` |
| `nativePermissionRouting` | `SUPPORTED` | `SUPPORTED` | `REQUIRES_VALIDATION` |
| `pauseWithQuiescence` | `UNSUPPORTED` | `UNSUPPORTED` | `UNSUPPORTED` |
| `revisionAcknowledgement` | `UNSUPPORTED` | `UNSUPPORTED` | `UNSUPPORTED` |
| `cooperativeStop` | `SUPPORTED` | `REQUIRES_VALIDATION` | `REQUIRES_VALIDATION` |
| `nativeTerminalHandoff` | `SUPPORTED` | `UNSUPPORTED` | `UNSUPPORTED` |
| `safePointNotification` | `SUPPORTED` | `UNSUPPORTED` | `UNSUPPORTED` |
| `controlledConfiguration` | `SUPPORTED` | `UNSUPPORTED` | `SUPPORTED` |
| `pluginSelection` | `SUPPORTED` | `UNSUPPORTED` | `UNSUPPORTED` |
| `sessionGuidance`（ADR-0057） | `SUPPORTED` | `REQUIRES_VALIDATION` | `UNSUPPORTED` |
| `providerProcessSuspension`（ADR-0061） | `SUPPORTED` | `REQUIRES_VALIDATION` | `REQUIRES_VALIDATION` |
| `attach` | `STRUCTURED` / `PTY` | `UNSUPPORTED` | `UNSUPPORTED` |
| `reconnectToLiveSession` | `UNSUPPORTED` | `UNSUPPORTED` | `UNSUPPORTED` |
| `resumeAfterExit` | `SUPPORTED` | `SUPPORTED` | `REQUIRES_VALIDATION` |

deterministic fake 与测试 stub 一律声明 `pluginSelection: 'UNSUPPORTED'`（它们不启动任何 provider）。

`providerProcessSuspension` 的 `SUPPORTED` 只来自一次真实进程测量（`docs/spikes/pi-0.84.4.md` §「Provider 进程冻结」）：`pi --mode rpc` 子进程就是模型请求发起者，bash 工具是它自己的后代且在独立 process group；只对该主进程 `SIGSTOP` 时工具不被触碰、冻结期间新增 0 条 provider 记录、恢复后下一次模型请求才发生。Codex 只完成了「进程归属」的一半（`codex app-server` 子进程及其第三方插件后代），模型那一半被本机额度挡住；Claude Code 因本机无凭据连工具层都没跑起来。因此后两者保持 `REQUIRES_VALIDATION`，全局 `pause` 遇到它们 fail closed 到 `RECOVERY_REQUIRED`，而不是假装已冻结。

`revisionAcknowledgement` 三者都是 `UNSUPPORTED`，依据是 ADR-0051 的实测：投递通道存在但「新修订已生效」无处可核验（Pi RPC 有 `prompt`/`steer`/`follow_up` 但成功只回 `queue_update`；Codex `turn/steer` 需活跃 turn 且只回 `{turnId}`；Claude 控制协议只有 `initialize`/`interrupt`/`can_use_tool`）。因此 `applyRevision` 不实现，修订一律走「协作停止 + 新建 Execution」。

## 2. Pi（首个真实 Adapter）

- 受控启动：`pi --mode rpc` 子进程，Runtime 持有 stdio；RPC framing 只接受 LF（不接受 CRLF）。
- 权限模式：FULL = `--approve` 且无工具 allowlist（全部已注册工具零确认）；STRICT = `--no-approve` + `--tools <白名单>`，gate extension 以 fail-closed 报告权限请求并映射成既有 Attention。
- 身份：启动后 `get_state` 采集 provider session id 与进程身份（pid + start token + argv hash）。
- 观察：gate extension 上报 `tool_start`/`tool_end`/`agent_settled`；`attention`/`completed`/`disconnected` 映射为 `AgentObservedEvent`。
- 安全点：fence 已确认 + 活动工具计数 0 + fence 之后有 `agent_settled` + 无待决 Attention（见 [`terminal-and-handoff.md`](./terminal-and-handoff.md) §2）。
- 已知缺口：没有 pause/resume 与可靠 revision ACK 原语；失去 stdio 的 live 进程不可重接。

## 3. Codex（ADR-0029）

`CodexAdapter`（`packages/agent-adapters/src/codex-adapter.ts`，`adapterId = "codex"`）接入 Codex CLI 0.151.0。

**传输**：`codex app-server --stdio`（LF-JSONL JSON-RPC），不用 `codex exec --json`：只有 app-server 提供可承载 fail-closed gate 的审批应答通道、结构化提问、`turn/interrupt` 与 `thread/resume`。`codex-protocol.ts` 负责 framing、方法名、payload 解析与答案编码；`codex-process.ts` 负责一个子进程的 stdio 与请求/应答/服务端请求路由。

**受控启动**：`codex app-server --stdio [-c model_reasoning_effort=<level>] [--enable default_mode_request_user_input]`。`model`/`modelProvider` 走 `thread/start`（按 Execution 解析，ADR-0012），不在进程启动时钉死。结构化提问工具只在 `--enable default_mode_request_user_input` 下存在（under development），因此是显式选项（registry 由 `CODEESTRA_CODEX_REQUEST_USER_INPUT=1` 打开），默认关闭并在能力矩阵如实反映。

**权限映射**：FULL = `approvalPolicy: never` + `sandbox: danger-full-access`（0 确认）；STRICT = `untrusted` + `workspace-write`，审批请求映射到**既有** `PERMISSION`/`CONFIRM` Attention，`CONFIRM true/false` → `accept`/`decline`，`CANCEL` → `cancel`。不提供 `acceptForSession` 或 execpolicy amendment（那会静默扩大后续权限），不新增审批层、不新增确认。

**行为边界**：交互 TUI 连的是共享 app-server daemon，不是这个 stdio 子进程，所以 attach 会是同一 conversation 的第二个 writer，因此不提供；`interrupted` 的 turn **不**产生 `completed` 证据（否则会写入假的 `toolsQuiescent`），而是报 `disconnected`；对 app-server 发 SIGTERM 会留下孤儿（`cooperativeStop` 因此只是 `REQUIRES_VALIDATION`）。Pi 的 PTY 交接机制不套用到 Codex。

## 4. Claude Code（ADR-0040）

`ClaudeAdapter`（`packages/agent-adapters/src/claude-adapter.ts`，`adapterId = "claude"`）接入 Claude Code 2.1.268 的 `--print` 控制通道（`claude-protocol.ts` + `claude-process.ts`），实现 `AgentAnswerAdapter` + 可选 `AgentProcessRelease`。

**本机无凭据，诚实边界**：spike 实测到「发出真实模型请求之前」为止——argv 的 STRICT/FULL 两套被真实 CLI 接受、`initialize` 往返与 `current_permission_mode` 回读、`--safe-mode` 对用户 hook/agent 的抑制、transcript 派生路径、`--resume` 加载记录会话、**鉴权失败以 `subtype:"success"` + `is_error:true` 到达**这一关键形状。凡需要模型产生的行为一律 `REQUIRES_VALIDATION`，不写成 `SUPPORTED`。

- 受控配置：`--safe-mode --strict-mcp-config` 排除用户 hooks/agents/MCP，同时保留 OAuth/模型/内置工具（`--bare` 因会禁用 OAuth/keychain 被排除）。
- **已知简化**：所有 `can_use_tool`（含 `AskUserQuestion`）一律映射为既有 `PERMISSION`/`CONFIRM` Attention，**不实现问卷编码**；因此「用户批准 `AskUserQuestion` 后 provider 是否会在无人渲染的 dialog 上等待」**未验证**。
- `session.transcript` 是 Pi 专属：Claude Session 上以 `SESSION_FILE_NOT_OWNED` 明确失败，不显示执行过程。
- stub 测试只证明编排，不是真实 Agent 集成验收。

## 5. Project Knowledge 的交付通道（ADR-0051）

`AgentStartRequest.knowledgeContext` 是每个 Execution **自己**记录的那份物化知识（写在 Runtime 数据目录，绝不写 Task worktree）。Runtime 从 `execution_knowledge_snapshots` 回读并解析成绝对路径；Adapter 在 spawn 之前核验「绝对路径 + 普通文件（拒绝符号链接/目录）+ 原始字节 sha256 == digest + 字节数 == bytes + 合法 UTF-8」，任何一条不成立即 `KNOWLEDGE_CONTEXT_UNAVAILABLE` 拒绝启动（`startMayHaveOccurred: false`）。**每个 provider 用自己的通道**，没有统一抽象、也没有新增能力位：

| Adapter | 通道 | 交付形态 | 依据 |
|---|---|---|---|
| Pi | `--append-system-prompt <绝对路径>` | 路径（Pi 自己读文件） | Pi 0.85.1 `resolvePromptInput`：路径存在则读文件，否则按字面文本 |
| Claude Code | `--append-system-prompt-file <绝对路径>` | 路径 | 真实 CLI 2.1.268 接受该选项（未知选项 exit 1） |
| Codex | `thread/start` / `thread/resume` 的 `developerInstructions` | 已核验文本（内联） | `generate-json-schema`（0.154.0）的 `ThreadStartParams`/`ThreadResumeParams` |

**零知识 == 现状**：无绑定或 `entryCount === 0` 时不产生该字段，受控启动的 argv/入参与改动前逐字节相同。三条启动路径（主启动、successor、pause→resume）都携带它。**未验证**：provider 是否真的读了这份知识、模型是否据此行动（需真实模型验收）。

## 6. Agent 插件 / 资源选择（ADR-0044，命令面）

- `agent plugins list [--project <id>] [--adapter <id>] [--json]` **只读**报出 provider 自己的候选插件/资源 + 当前选择 + 该 Adapter 的支持情况。检测只读 provider 用户配置目录（`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）与其中的 `settings.json`，**绝不扫描仓库内目录、不跟随符号链接进入 Git 工作树、零写入**。
- `agent plugins select … [--extension <path>]… [--skill <path>]… [--prompt-template <path>]… [--theme <path>]… [--clear] [--json]` 写入**整份**选择（重复 flag 而非 JSON 文件，一个路径不需要第二条转义规则），零确认、幂等，退出码 0 applied / 1 refused / 2 usage。每个路径在写入前核验一次、在 Session 启动前再核验一次。
- 选择按作用域持久化（`agent_configurations.plugin_selection_json`），在 Execution 预留时解析成生效值并写入 `executions.agent_config_json`，因此同一 Execution 的启动参数可事后读回；`agent.config.get` 同时报告生效值与来源层。
- 对 `pluginSelection: UNSUPPORTED` 的 Adapter，`select` 以稳定码拒绝且**不写入选择**；Agent 设置页在同一字段为 `UNSUPPORTED` 时不显示候选列表。
- **未验证（不得当成已成立）**：真实模型下「确实使用了所选 skill/theme」只有 argv 与命令面证据；themes 的显式路径加载未单独实测；第三方 extension 是否能绕过 gate 未做对抗验证。

## 7. Pi Spike 验收门禁（Phase 1，逐条状态）

1. [已完成首轮] 阅读 Pi 0.84.4 SDK/RPC/Session/extension 文档与 examples，固定版本 0.84.4、MIT、Node `>=22.19.0`。
2. [部分完成] RPC framing、按权限模式选择的受控 gate、真实 `PiRpcAdapter` 子进程与持久 answer Operation 已实现；**仍需真实 Pi 的 FULL 工具执行验收**。
3. [部分完成] 内置 bash abort/process-group spike 通过；任意 extension/逃逸进程不在保证内，限定工具集仍需逐项验证。
4. [已明确边界] 持久 conversation 可跨进程恢复；**不能**重接失去 stdio 的 live Pi 进程。
5. [部分完成] Runtime 持有 RPC pipes 时可提供结构化 attach；Runtime 重启后的 live attach 不支持。当前 adapter 明确拒绝无 live 进程的 observe/answer。
6. [部分完成] fake 已覆盖启动部分失败、answer 投递失败与 provider event/outbox 重投；Pi adapter 已覆盖受控 argv/身份/断连/答案往返的 stub-transport 测试；**真实 Pi 的修订 fallback、取消超时、事件重投与孤儿进程仍未完成**。

Pi 0.84.4 没有 pause/resume 与可靠 revision ACK 原语，因此运行中修订必须走「停止、确认静止、旧 Execution `SUPERSEDED`、新 Execution 完整启动」的 fallback。真实运行的 Git 授权按权限模式处理（FULL 单步 capture、无敏感路径拦截；STRICT 保留 prepare/confirm）；fake adapter 不能替代这些验收。
