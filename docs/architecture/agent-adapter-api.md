# Agent Adapter API

> 层级：L1 · 体量 ≈ 9k 字符 · **何时读**：改 Adapter 合约/能力位、判断某条控制路径是否真的存在、写新 Adapter · **权威来源**：`packages/contracts/src/index.ts`（端口与 `AdapterCapabilities`）、`packages/agent-adapters/src/**`（实现）。逐 provider 的实测能力矩阵与证据见 [`agent-adapter-providers.md`](./agent-adapter-providers.md)；终端交接与 PTY 见 [`terminal-and-handoff.md`](./terminal-and-handoff.md)。

状态：Runtime port 设计，不是任何 Provider SDK 的复述。ADR-0068 目标中 Adapter 永远由 Process 调用，Service 不直接拥有 Agent；S5 会把现有 Execution/Session 控制投影为 Process，但**不改写「按实测声明能力」的原则**。

## 1. 实现层端口（导出的就是这些）

| 类型 | 位置 | 说明 |
|---|---|---|
| `AgentStartAdapter` | `packages/contracts/src/index.ts` | `probe()` + `start(request)`：受控启动并返回 `AgentSessionRef` |
| `AgentObserveAdapter` | 同上 | 追加 `observe(session, cursor?)`，产出 `AgentObservedEvent`（`attention` / `completed` / `disconnected`） |
| `AgentAnswerAdapter` | 同上 | 追加 `answer(session, request)`：把 typed answer 写回 provider |
| `AgentProcessRelease`（可选） | 同上 | `releaseSession(sessionId)`：自有 provider 进程的协作释放；**缺少它时不假定已停止** |
| `AdapterCapabilities` | 同上 | 15 个能力位，全部是 `SUPPORTED` / `UNSUPPORTED` / `REQUIRES_VALIDATION`（`attach` 额外有 `STRUCTURED` / `PTY` / `BOTH`） |
| `AgentStartRequest` | 同上 | 受控启动的全部入参（revision、workspace、权限模式、生效配置、知识上下文等） |
| `agentProcessIdentitySchema` | 同上 | pid + executable + **startToken** + argvHash + capturedAt；只有 PID 可用时**拒绝启动** |

实现层的 `AdapterCapabilities` 与本文历史设计稿一致，并在此之上新增（均为如实声明，不是占位）：

- `controlledConfiguration`（ADR-0029）：受控启动能否排除环境用户配置（plugins / MCP servers / hooks）。`UNSUPPORTED` 表示 provider 总会加载自己的配置，从而在 revision 快照之外改变 Agent 的输入。
- `pluginSelection`（ADR-0044）：能否只加载用户选定的插件/资源。`UNSUPPORTED` 时 `agent plugins select` 以稳定码拒绝，**不写任何选择**。
- `sessionGuidance`（ADR-0057）：能否把 guidance 交给**正在运行**的会话并观察到 provider 接受了它。它只描述运行中会话通道；启动时把已记录的 guidance 交给**新** Execution 是另一套机制（ADR-0051 的知识先例），刻意不受这一位限制。
- `providerProcessSuspension`（ADR-0061 / FOUNDATION-097）：能否指出并证明**哪个受控主进程发起模型请求**，使 Runtime 能按 `pid + start token + incarnation` 只冻结/继续它、绝不向工具子进程发信号。它**不是** provider 原生 pause，也不等于 `pauseWithQuiescence`。

**目标端口（尚未导出，不得当成已实现）**：`requestPause`、`planProviderSuspension`、`applyRevision`、`resume`、`requestStop`、`requestHandoffSafePoint`、`startSuccessor`、`reconcile`、`attach`/`detach`。当前只有其中一部分的真实能力存在（如接管与 successor start 由 ADR-0026 实现），且分别按 ADR-0023/0026/0028/0061 的语义执行；类型先于实现存在不等于能力存在。

`packages/agent-adapters` 的 deterministic fake 只验证协议与编排行为，不执行任何真实命令，**不能作为 provider 验收**。

## 2. 语义（每条都对应一次真实事故或实测）

- `ACCEPTED`/`accepted: true` 只表示控制请求已受理，不代表已暂停、回答已生效或取消完成。
- **全局冻结不复用 `requestPause`**：前者保持 Task/Execution/Session 状态不变、只暂停模型驱动主进程；后者是单 Task 协作暂停，最终结束旧 Execution。真正的 `SIGSTOP`/`SIGCONT`、进程状态复读、pause epoch 与持久屏障都由 Runtime 控制层承担（`apps/runtime/src/runtime-control-service.ts`，命令面 `scheduler control status|pause|resume|reconcile`）。
- 冻结前后都要重验 `pid + start token + current incarnation`。只看到 PID、只成功调用 `kill(SIGSTOP)`、只看到 stdout 安静，**都不能**写 `STOPPED`。PID 复用或身份不可读时不发信号，进入全局控制 `RECOVERY_REQUIRED`。
- 已发出的模型请求不被取消；工具子进程不接收全局暂停信号。但「未发停止信号」不等于「工具绝不会停顿」：主进程被冻结后停止读管道，大输出工具可能因背压阻塞。
- start 超时**不能盲重试**（可能已创建真实进程），要用 operation/session identity 核对。丢失 stdio 后不得重接或重放，而是记 `DISCONNECTED` 并保留 Execution/workspace 占用。
- 完成证据必须说明依据：`agent_settled` 是判定的一部分，进程异常退出或 stdout 流损坏**不产生完成**，而是断连恢复。`agent_settled` 也不等于成功（被 gate 拒绝或被 fence 拦截的轮次同样会 settled）。
- 无可靠 ACK 时不能靠匹配「好的」判断修订已应用；完整新启动输入是唯一回退路径。
- Runtime 只能对当前持有 live provider 进程的 Session 投递 answer；无法投递时保留 `ANSWER_RECORDED`，不重放、不声称已投递。Runtime 自行释放的进程在投影里记为 Runtime 来源的断连，而不是伪造 provider event。
- 不能确认工具/后代进程静止就返回 UNKNOWN 并保留资源；**stdout 安静不是停止证据**。
- `resume`（已暂停且仍可控的同一会话）与「退出后按 provider conversation 重新开始」是两件事，后者另建 Execution 并保留来源。
- attach 必须操作对应真实会话；只能提供日志浏览的必须明确命名为只读视图。ADR-0013 的 `session.transcript` 就是后者：它不建立 writer lease、不要求 live 进程，不得描述为 attach、steering 或终端接管。
- Session Guidance 与 TaskRevision 是两条显式通道：Pi 的 `SAFE_POINT_STEER` 映射到 RPC `steer`，在当前 assistant turn 的工具调用结束后、下一次 LLM call 前生效；它**不修改** `appliedRevisionId`。**Task 修订不得降级为 guidance。**
- 原生 TUI 接管不是 attach 到现有 RPC 进程：Runtime 先记录 handoff，让 gate 建立 fence（已开始的工具继续完成，之后的新工具调用被 terminating result 收束），以 `agent_settled` + 活动工具计数 0 作为结构化安全点，随后确认旧 incarnation 退出，再用**同一个 provider session file** 启动 `HUMAN_TUI` successor；交还时反向执行。旧进程退出未确认时**不得** `startSuccessor`。
- 一个 Session 同时最多一个交互写入租约，多个客户端可只读；用户输入、自动 guidance/修订与权限回答由 coordinator 串行路由；writer 竞争明确返回 `ATTACHMENT_BUSY`。
- detach 只解除客户端 PTY attachment，不停止 Agent；`release takeover` 才请求安全点交还自动模式；显式 `requestStop` 才是取消执行。
- 权限模式跨 handoff 固定：FULL 下 TUI 对已注册工具零确认，gate side channel 只报告结构化工具/配置事实；STRICT 下 gate 经受控 side channel 报告 permission request/resolution，继续产生 typed Attention 审计并保持未知工具 fail-closed。**两种模式都不能从 ANSI 屏幕抓取业务事实。**
- STRICT 保留 provider 原生权限机制，Codeestra 不生成「同意」回复；FULL 按 ADR-0011 自动允许。Adapter 缺少当前模式所需能力时必须报告阻塞，不默默更换权限模型。
- **声明本身不改变行为**（如实记录）：当前没有把交接路径改成「先查能力再决定」，`session.handoff.*` 仍按 ADR-0023/0026 的平台与归属判定执行；把 Pi 专属机制套到 Codex 上确实会被拒。是否加能力门禁属另一次语义变更，尚未实施。
- Pi 自己的 `SessionHandoffCapabilities` 用另一套取值集（`IMPLEMENTED` / `UNSUPPORTED` / `PARTIAL` / `UNVERIFIED`，**不是** `SUPPORTED/UNSUPPORTED/REQUIRES_VALIDATION`），如实报告残留差距：`ptyResize: IMPLEMENTED`（平台范围 POSIX）、`parallelToolBatchSafePoint: IMPLEMENTED`、`crossHandoffPermissionModeMatrix: PARTIAL`，其余仍 `UNSUPPORTED`。
- 结构化问卷（ADR-0014）**没有新增事件类型**：复用 `attention`，把问卷放在 `prompt` 里（`kind: "codeestra.questionnaire"`），回答用 `AgentAnswer` 的 `QUESTIONNAIRE` 变体表达，因此「一条 Attention = 一个 provider 请求 = 一次 answer Operation」不变。
- observation 事件经 Zod 校验；只有显式 `toolsQuiescent=true` 与 `ownedWritersStopped=true` 的 completion evidence 才能释放失败 Execution 的资源。
- 相关代码注释与测试的落点：`packages/agent-adapters/src/**`、`packages/contracts/src/index.ts`、`docs/spikes/*.md`（实测证据）。
