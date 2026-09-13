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
| nativePermissionRouting | `SUPPORTED`（Pi extension UI），非默认全工具审批 | 受控 gate extension；无 UI/未知工具 fail-closed |
| pauseWithQuiescence | `UNSUPPORTED` | Pi 只有 abort 当前 operation，没有 pause/resume 原语 |
| revisionAcknowledgement | `UNSUPPORTED` | 不从自然语言推断 ACK；修订走停止并新建 Execution |
| cooperativeStop | `REQUIRES_VALIDATION` | 内置 bash spike 通过；限定工具集逐项验证，超时进入恢复 |
| attach | `STRUCTURED`（仅 Runtime 持有 live RPC pipes 时） | 客户端 attach 到 Codeestra Runtime，不直接重接 Pi 进程 |
| reconnectToLiveSession | `UNSUPPORTED` | Runtime 失联后不声称恢复 live process |
| resumeAfterExit | `SUPPORTED`（conversation resume） | 必须新建 Execution/进程，保留来源关系 |

## 对设计的影响

1. Phase 1 使用 RPC 子进程，而非把 Agent SDK 与 Runtime 放入同一故障域。
2. Pi adapter 不实现 `requestPause/applyRevision/resume`；运行中修订采用 ADR-0001 fallback：协作停止、确认静止、旧 Execution `SUPERSEDED`、新 Execution 使用完整 revision 启动。
3. Codeestra session identity 与 Pi session ID/file 分开保存。RPC process PID/start token、session file 和 workspace ownership 都要核对。
4. 事件 cursor 不能只依赖瞬时 RPC event。耐久回放使用 Codeestra event ID；Pi session entries 的稳定 entry ID 可作为 conversation 增量 cursor，但 tool streaming event 仍需 Runtime 自己持久化。Phase 1 Pi cursor 采用 `pi:<epoch>:<seq>`，epoch 与一次子进程生命周期绑定；陈旧 epoch 的 cursor 被拒绝。
5. 只允许受控工具集降低了“后代写入”风险，但不能证明任意工具静止；因此取消/失败仍需要证据或进入 recovery。
5. 启动 timeout 不盲重试；先核对 owned process 和 session identity。

## 尚未通过的门禁

- 成果 commit 与项目 trust 策略已由 ADR-0003/0004 确认，但对应授权/失效服务尚未实现。
- 已实现并单测 LF-only RPC framing/parser、Codeestra gate extension 与 `PiRpcAdapter`（自有子进程、受控 argv、身份采集、attention/completion/disconnect 映射、typed answer 写入）。尚未实现 Runtime 事件/回答 pump、真实事件重投与孤儿进程 reconcile。
- adapter transport 的本机真实 Pi 0.84.4 smoke：用受控 argv 启动 `pi --mode rpc`，`get_state` 返回 provider sessionId/session file，`ps -o lstart` 取得 start token，SIGTERM 后确认进程已退出；未发送 prompt、未调用模型。
- stub-transport 集成测试覆盖：受控 argv、身份入库字段、revision prompt 组成、permission dialog→typed Attention→confirm(false) 写回、`agent_settled`→SUCCESS、**意外退出→disconnected 而非完成**、无 live 进程/陈旧 cursor 拒绝。
- 尚未证明 edit/write 和所有允许 extension tools 的 abort 后静止边界。
- 受控启动使用 `--no-approve --no-extensions --extension <fixed gate> --no-skills --no-prompt-templates --no-themes --no-context-files`，避免项目动态 Pi 资源和环境 prompt 资源改变 Task 输入；项目知识将来通过 `knowledgeSnapshotRefs` 显式交付。已确认该 argv 可被真实 Pi 0.84.4 接受。环境变量 allowlist 尚未定稿。
- 用户已确认：`agent_settled` 可作为 SUCCESS 完成依据，但 evidence 必须写明依据（当前为 `pi-rpc:agent_settled:session=...:epoch=...:tools=<hash>`）；进程异常退出不声明静止，而是 DISCONNECTED + RECOVERY_REQUIRED 且保留占用。
