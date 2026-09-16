# Pi 0.84.4 Adapter Spike

状态：已完成文档核对、受控本机 RPC spike、adapter transport smoke、真实 `PiRpcAdapter` 子进程实现，以及 FOUNDATION-019 的真实模型/工具受控验收（deepseek-flash：真实 `write` 调用被 fail-closed gate 拦下并在 UI 逐次审批，随后成果 commit 与 Task verification PASSED）。Runtime 事件/回答 pump 与 Git 授权服务已在其后实现；本文中“未以真实模型运行”的记录仅代表当时状态，已由 FOUNDATION-019 取代；取消超时与孤儿进程 reconcile 仍未验收。

## 范围与环境

- Pi CLI / SDK：`@earendil-works/pi-coding-agent` 0.84.4，MIT。
- Node 要求：`>=22.19.0`；本机 Node 24.19.0。
- 接入候选：独立 `pi --mode rpc` 子进程。它比同进程 SDK 更符合 Runtime 的故障隔离与进程归属需求。
- Spike 只在 `/tmp` 下运行；未修改用户项目、未 commit、未 push。

核对资料：安装包内 `docs/sdk.md`、`docs/rpc.md`、`docs/extensions.md`、`docs/session-format.md`，以及 SDK session runtime、RPC UI、permission gate examples。

## 已证实

### 启动、事件与关联

RPC 使用 LF 分隔的 JSONL；请求可带 `id`，command response 可关联。Agent/tool 生命周期事件提供 `toolCallId`，`agent_settled` 表示 retry、compaction retry 和 queued continuation 都已结束。客户端不能用会把 U+2028/U+2029 当换行的通用 line reader。

### 原生交互通路

Pi extension 的 `ctx.ui.select/confirm/input/editor` 在 RPC 模式产生 `extension_ui_request`，客户端用同一 `id` 的 `extension_ui_response` 回答。本机 spike 通过 CLI 显式加载 extension，收到 `confirm` 请求、返回允许，并收到成功 command response。

这证明 Pi 自身的 extension UI/RPC 通路可承载权限和结构化问题；它不证明 Pi 默认对所有工具提供权限审批。Codeestra 必须加载受控 gate extension，在 `tool_call` 执行前 fail-closed，并把真实 UI request 建成 AttentionRequest。RPC 不支持 `ctx.ui.custom()`，复杂 questionnaire 必须降级为 dialog primitives。

### 中断与内置 shell 清理

`AgentSession.abort()` 会 abort retry、调用 agent abort，并等待 session idle；RPC `abort` response 在该等待后返回。Pi 0.84.4 的内置 bash 在 Unix 使用独立 process group，abort 时向 process group 发 `SIGKILL` 并等待直接 child 退出。

本机 spike 让 Agent 执行写 PID 后 `sleep 30`，在 `tool_execution_start` 后发 `abort`。结果：abort response 成功；对应 tool 先以 error 结束；response 返回时 PID 已不存在。

边界：这不是任意 extension、自行 daemonize 或逃离 process group 的普遍静止证明。Codeestra 只能对审核过且遵守 AbortSignal/进程归属的工具声明该能力；超时或身份不明仍进入 `RECOVERY_REQUIRED`。

### 持久化与退出后恢复

持久 session 有稳定 session file / session ID。包含真实 user/assistant 消息的 session 在关闭 RPC 进程后，用 `--session <file>` 重开可恢复相同 ID、消息和 extension custom entry。

仅含 extension custom entry、没有 conversation message 的空 session 会在 shutdown 清理；不能在获得首个持久用户消息前把 session file 当作耐久身份凭据。

恢复的是持久 conversation/tree，不是原 OS 进程。Runtime 丢失 RPC 子进程 stdio 后，没有文档化机制重新接管该 live process。

## 能力结论

| Adapter 能力 | Pi 0.84.4 结论 | Codeestra 处理 |
|---|---|---|
| persistentSession | `SUPPORTED`（持久 conversation） | 保存 provider session ID 与 file；启动早期身份另持久化 |
| structuredAttention | `SUPPORTED`（受控 extension + RPC dialog） | 映射 request ID；custom UI 不可用 |
| nativePermissionRouting | `SUPPORTED`（Pi extension UI），非默认全工具审批 | 受控 gate extension；STRICT 下无 UI/未知工具 fail-closed，FULL 下全部已注册工具自动允许（ADR-0011） |
| pauseWithQuiescence | `UNSUPPORTED` | Pi 只有 abort 当前 operation，没有 pause/resume 原语 |
| revisionAcknowledgement | `UNSUPPORTED` | 不从自然语言推断 ACK；修订走停止并新建 Execution |
| cooperativeStop | `REQUIRES_VALIDATION` | 内置 bash spike 通过；限定工具集逐项验证，超时进入恢复 |
| attach | `STRUCTURED`（仅 Runtime 持有 live RPC pipes 时）；不能把原生 TUI 附着到该 RPC 进程 | 结构化客户端 attach 到 Codeestra Runtime；原生 TUI 按 ADR-0010 另做安全点进程交接，不伪装原地 attach |
| nativeTerminalHandoff | `REQUIRES_VALIDATION`（持久 session 可跨进程恢复，但双向 RPC↔TUI 与 gate side channel 未做 spike） | Phase 3 先验证旧进程退出、同 session file TUI resume、PTY、TUI 退出与 RPC resume；全程单 writer |
| reconnectToLiveSession | `UNSUPPORTED` | Runtime 失联后不声称恢复 live process |
| resumeAfterExit | `SUPPORTED`（conversation resume） | 必须新建 Execution/进程，保留来源关系 |

## 对设计的影响

1. Phase 1 使用 RPC 子进程，而非把 Agent SDK 与 Runtime 放入同一故障域。
2. Pi adapter 不实现 `requestPause/applyRevision/resume`；运行中修订采用 ADR-0001 fallback：协作停止、确认静止、旧 Execution `SUPERSEDED`、新 Execution 使用完整 revision 启动。
3. Codeestra session identity 与 Pi session ID/file 分开保存。RPC process PID/start token、session file 和 workspace ownership 都要核对。
4. 事件 cursor 不能只依赖瞬时 RPC event。耐久回放使用 Codeestra event ID；Pi session entries 的稳定 entry ID 可作为 conversation 增量 cursor，但 tool streaming event 仍需 Runtime 自己持久化。Phase 1 Pi cursor 采用 `pi:<epoch>:<seq>`，epoch 与一次子进程生命周期绑定；陈旧 epoch 的 cursor 被拒绝。
5. 只允许受控工具集降低了“后代写入”风险，但不能证明任意工具静止；因此取消/失败仍需要证据或进入 recovery。
6. RPC `steer` 可在当前 assistant turn 的工具调用结束后、下一次 LLM call 前投递 Session Guidance；`agent_settled` 明确表示无 retry、compaction retry 或 queued continuation；extension `ctx.shutdown()` 会延迟到 idle。这些原语可组成 ADR-0010 的 handoff fence 与安全退出，但不是原生 TUI attach。原生接管仍必须经真实 spike 验证：收束新工具→settled→确认 RPC 退出→同 session 启动 TUI/PTY。
7. 启动 timeout 不盲重试；先核对 owned process 和 session identity。

## 尚未通过的门禁

- 成果 commit 与项目 trust 授权/失效服务已实现；ADR-0011 后 FULL 下单步 capture、无 project trust 确认，STRICT 保留旧门禁。
- 已实现并单测 LF-only RPC framing/parser、Codeestra gate extension 与 `PiRpcAdapter`（自有子进程、受控 argv、身份采集、attention/completion/disconnect 映射、typed answer 写入）。尚未实现 Runtime 事件/回答 pump、真实事件重投与孤儿进程 reconcile。
- adapter transport 的本机真实 Pi 0.84.4 smoke：用受控 argv 启动 `pi --mode rpc`，`get_state` 返回 provider sessionId/session file，`ps -o lstart` 取得 start token，SIGTERM 后确认进程已退出；未发送 prompt、未调用模型。
- stub-transport 集成测试覆盖：受控 argv、身份入库字段、revision prompt 组成、permission dialog→typed Attention→confirm(false) 写回、`agent_settled`→SUCCESS、**意外退出→disconnected 而非完成**、无 live 进程/陈旧 cursor 拒绝。
- 尚未证明 edit/write 和所有允许 extension tools 的 abort 后静止边界。
- 受控启动使用 `--no-extensions --extension <fixed gate> --no-skills --no-prompt-templates --no-themes --no-context-files`，避免项目动态 Pi 资源和环境 prompt 资源改变 Task 输入；FULL 使用 `--approve` 且不传 `--tools`（全部已注册工具），STRICT 使用 `--no-approve --tools read,bash,edit,write,grep,find,ls`。项目知识将来通过 `knowledgeSnapshotRefs` 显式交付。已确认该 argv 可被真实 Pi 0.84.4 接受。环境变量 allowlist 尚未定稿。
- 用户已确认：`agent_settled` 可作为 SUCCESS 完成依据，但 evidence 必须写明依据（当前为 `pi-rpc:agent_settled:session=...:epoch=...:tools=<hash>`）；进程异常退出不声明静止，而是 DISCONNECTED + RECOVERY_REQUIRED 且保留占用。

## Provider 进程冻结（ADR-0061，FOUNDATION-097 补测）

状态：**已实测 SUPPORTED**。这一节回答的是 ADR-0061 的一个新维度：**哪个受控进程是模型请求发起者**，以及
冻结它时工具子进程会不会被 Codeestra 的信号碰到。它不是 provider 原生 pause，也不改变本文件上面任何结论。

方法与可复跑探针（已入库）：`docs/spikes/global-freeze/pi-freeze-probe.ts`（`bun run
docs/spikes/global-freeze/pi-freeze-probe.ts <输出目录>`）。spike 的临时目录（`/tmp/ce-glc2/…`）在交付收尾时
按任务要求清理；下方逐字引用当时的关键原始输出行，结论不依赖那份临时文件，探针可随时复跑。环境：本机 `pi` **0.85.1**、真实模型
`deepseek-flash`（`PI_PROVIDER=deepseek`）、macOS darwin/arm64。argv 由本仓库自己的
`buildPiRpcArguments` 生成（与生产 `PiRpcAdapter` 的受控启动逐字相同），工作目录与所有 marker 都在
`/tmp` 下，未触碰用户项目或稳定数据目录。

判据：探针要求模型**连续两次** bash 调用——第一次 `sleep 18`，第二次写另一个 marker。因此
「冻结后不再产生下一次模型请求」有一个直接观测：第二次 bash 只能在第一次返回后、由**新的模型请求**
决定发起。

```text
### argv ["pi","--mode","rpc","--approve","--no-extensions","--extension",…gate…,"--extension",…question…,
        "--no-skills","--no-prompt-templates","--no-themes","--no-context-files","--session-dir",…]
### provider main pid 21366
### provider start token (before freeze) 三  9月/16 20:57:01 2026
### tool subprocess pid 21865
### tool start token 三  9月/16 20:57:04 2026

### process table while the tool runs (provider subtree + tool line)
  21366 21360 21356 S    pi
  21865 21366 21865 Ss   /bin/bash -c sleep 18 && echo FIRST_DONE > /tmp/ce-glc2/pi-freeze/first.marker
  21866 21865 21865 S    sleep 18

### sent SIGSTOP to provider main pid only: 21366
### provider stat after SIGSTOP T
### provider start token after SIGSTOP 三  9月/16 20:57:01 2026
### tool stat after SIGSTOP Ss
### tool start token after SIGSTOP 三  9月/16 20:57:04 2026

### 26s after the freeze
### provider stat T
### tool stat Z
### first marker exists true
### second marker exists false
### provider stdout bytes before freeze 20001 after freeze 20001
### provider stdout records seen after the freeze: 0

### sent SIGCONT to provider main pid only
### provider stat after SIGCONT S
### second marker exists after SIGCONT true
### both markers true true
```

结论（每条都对应上面的一行原文）：

| 问题 | 实测事实 |
|---|---|
| 模型请求发起者 | `pi --mode rpc` 子进程（pid 21366）本身。它就是 Adapter 记录 `{pid,startToken}` 的那个 child，也是它读取 stdin/stdout 的 JSONL 通道。 |
| 工具子进程归属 | bash 工具是它的**子进程**（ppid=21366），且在**自己的 process group**（pgid=21865，与 provider 的 21356 不同），`sleep 18` 是它的子进程。因此「只对主进程发信号」不会连带那些工具。 |
| `SIGSTOP` 只作用于主进程 | 主进程 stat 由 `S` 变 `T`，start token 前后逐字相同（`三 9月/16 20:57:01 2026`）；同一时刻工具子进程仍是 `Ss`，其 start token 也未变。Codeestra 没有向工具发任何信号。 |
| 工具继续运行 | 冻结期间 `first.marker` 被真实写入（`true`），随后工具自然退出（`Z`）。 |
| 冻结后没有下一次模型请求 | 冻结后 26 秒内 provider stdout **新增 0 条记录**（字节数 20001 → 20001），`second.marker` 为 `false`。 |
| 恢复确实是被冻结的那一个 | `SIGCONT` 后主进程回到 `S`，`second.marker` 变为 `true`——第二次模型请求确实是被这次冻结挡住的，不是模型自己决定不做。 |

`providerProcessSuspension` 因此声明为 **`SUPPORTED`**（`packages/agent-adapters/src/pi-adapter.ts` 的
`piProviderProcessSuspension`）。

**本节的诚实边界（不得外推）**：

- **未实测背压**：本次工具的输出只有一行，无法触发「provider 停止读管道 → 大输出工具因 OS 管道背压阻塞」。
  「工具没收到停止信号」不等于「工具在任何情况下都不会停顿」。
- **未实测**：第三方 extension、hook 或 MCP 进程的归属；`--no-extensions` 下的受控启动把这类进程排除在外，
  但它们一旦存在就不在冻结的保证内。
- **未实测**：冻结期间 provider 已发出的那个模型请求是否已在服务端完成/计费（ADR-0061 明确不取消它）。
- 本次用 0.85.1 实测，而本文件首轮核对的是 0.84.4；差异不影响上述进程层结论，但版本组合已如实记录。
