# Agent Adapter API

状态：Runtime port 设计，不是 Pi SDK API 的复述。ADR-0068 目标中，Adapter 永远由 Process 调用，Service 不直接拥有 Agent；S5 会把现有 Execution/Session 控制投影为 Process，但不会改写这里按实测声明能力的原则。当前代码导出 start/observation/typed-answer 子集与 deterministic fake、真实 `PiRpcAdapter`（自有子进程、身份采集、attention/completion/disconnect 映射、typed answer 写入）、第二个真实 Adapter **`CodexAdapter`**（ADR-0029，`codex app-server --stdio`）与第三个真实 Adapter **`ClaudeAdapter`**（ADR-0040，`claude --print` 控制通道）；pause/revision/stop control 尚未落地。**ADR-0061 新增的能力维度「可核验的 Provider 模型驱动进程冻结」已由 FOUNDATION-097 落地：`AdapterCapabilities.providerProcessSuspension` 已导出并如实声明，Runtime 控制层在 `apps/runtime/src/runtime-control-service.ts`。它不是 `pauseWithQuiescence`；只有完成真实进程归属 spike 的 Adapter 才是 `SUPPORTED`（当前只有 Pi）。**Runtime 已接入 adapter registry 与事件 pump；提交/回答仍由 CLI 显式触发。Pi 0.84.4 首轮文档核对、受控 RPC spike 与 adapter transport smoke 已完成，结论见 [`../spikes/pi-0.84.4.md`](../spikes/pi-0.84.4.md)；Codex 0.151.0 结论见 [`../spikes/codex-0.151.0.md`](../spikes/codex-0.151.0.md)；Claude 2.1.268 结论见 [`../spikes/claude-2.1.268.md`](../spikes/claude-2.1.268.md)（本机无凭据，模型层全部未验证）；commit/trust 产品策略已确认，真实工具执行/取消门禁仍未验收。

## 1. 合约草案

```ts
type Support = 'SUPPORTED' | 'UNSUPPORTED' | 'REQUIRES_VALIDATION';
interface AdapterCapabilities {
  persistentSession: Support;
  structuredAttention: Support;
  nativePermissionRouting: Support;
  pauseWithQuiescence: Support;
  revisionAcknowledgement: Support;
  cooperativeStop: Support;
  attach: 'STRUCTURED' | 'PTY' | 'BOTH' | 'UNSUPPORTED';
  nativeTerminalHandoff: Support;
  safePointNotification: Support;
  reconnectToLiveSession: Support;
  resumeAfterExit: Support;
  // ADR-0029：受控启动能否排除环境用户配置（plugins/MCP servers/hooks）。
  // UNSUPPORTED 表示 provider 总会加载自己的配置，从而在 Codeestra 的 revision 快照之外
  // 改变 Agent 的输入；Adapter 必须如实报告，而不是暗示实现了隔离。
  controlledConfiguration: Support;
  // ADR-0044：能否只加载用户选定的插件/资源（extensions/skills/prompt templates/themes）。
  // Pi 的受控启动可以组合显式路径；Codex 与 Claude Code 没有等价机制，因此必须报告
  // UNSUPPORTED，而不是在它们上面发明一个共同抽象。UNSUPPORTED 不是占位符：
  // `agent plugins select` 对它以稳定码拒绝，且不写任何选择。
  pluginSelection: Support;
  // ADR-0061：Adapter 能否给出并证明“哪个受控主进程会发起模型请求”，使 Runtime 可在
  // 不向已运行工具子进程发停止信号的前提下，用 pid + start token 核验后冻结/继续它。
  // 这不是 provider 原生 pause，也不等于 pauseWithQuiescence。
  providerProcessSuspension: Support;
}
interface SessionRef {
  id: string;                 // Codeestra identity
  executionId: string;
  adapterId: string;
  providerSessionId?: string;
}
interface StartRequest {
  operationId: string;        // 持久化操作，不等于供应商自动幂等
  sessionId: string;
  executionId: string;
  mode: 'AUTOMATED_RPC' | 'HUMAN_TUI';
  resumeFrom?: {
    predecessorSessionId: string;
    providerSessionId: string;
    sessionStorageRef: string;
    expectedLastEntryId?: string;
  };
  workspace: { id: string; cwd: string; ownershipToken: string };
  revision: { id: string; displayTitle: string; specification: string };
  knowledgeSnapshotRefs: readonly string[];
  // ADR-0051：该 Execution 绑定的**物化知识产物**（Runtime 数据目录内的绝对路径 + digest + 字节数）。
  // 缺失 = 该 Execution 没有可交出的知识（无绑定或 entryCount 为 0），Adapter 的受控启动必须逐字节不变；
  // Adapter 必须在 spawn 前核验 digest/字节数/文件形态，读不到即拒绝启动（KNOWLEDGE_CONTEXT_UNAVAILABLE）。
  knowledgeContext?: { filePath: string; digest: string; bytes: number };
  permissionMode: 'FULL' | 'STRICT';
  // ADR-0012：本次 Execution 预留时解析出的生效配置；未设字段必须交由 Adapter 自身默认处理，
  // Adapter 不得在 start 时重新读取全局配置，否则实际启动参数会与 Execution 记录不一致。
  agentConfig?: { provider?: string; model?: string; thinkingLevel?: string };
  environment: Readonly<Record<string, string>>; // 允许列表，不复制全部父进程环境
}
interface Constraint { id: string; text: string }
interface SafePointEvidence {
  ref: string;
  modelTurnSettled: true;
  toolsQuiescent: true;
}
interface StopEvidence extends SafePointEvidence {
  ownedWritersStopped: true;
}
interface AgentAdapter {
  readonly id: string;
  probe(): Promise<{ version: string; capabilities: AdapterCapabilities }>;
  start(request: StartRequest): Promise<SessionRef>;
  observe(session: SessionRef, cursor?: string): AsyncIterable<AdapterEvent>;
  requestPause(session: SessionRef, operationId: string): Promise<ControlReceipt>;
  // ADR-0061 完整设计层端口；**当前实现仍然没有导出它**。FOUNDATION-097 落地的是 Runtime 控制层：
  // 它从 `session_incarnations` 的进程身份（Adapter 启动时写入的 {pid,startToken}）构建 target，
  // 自己完成重验、SIGSTOP/SIGCONT、状态复读与持久屏障。这个类型仍然描述目标语义：Adapter 不得只凭
  // “信号已发送”声称进程已经 stopped/resumed，而 `excludedToolProcesses` 是“不要向它们发信号”的清单。
  planProviderSuspension(session: SessionRef): Promise<ProviderSuspensionPlan>;
  applyRevision(session: SessionRef, input: RevisionInput): Promise<ControlReceipt>;
  guide(session: SessionRef, input: GuidanceInput): Promise<ControlReceipt>;
  answer(session: SessionRef, input: AnswerInput): Promise<ControlReceipt>;
  resume(session: SessionRef, operationId: string): Promise<ControlReceipt>;
  requestStop(session: SessionRef, operationId: string): Promise<ControlReceipt>;
  requestHandoffSafePoint(session: SessionRef, operationId: string): Promise<ControlReceipt>;
  startSuccessor(request: StartRequest): Promise<SessionRef>;
  reconcile(session: SessionRef): Promise<SessionObservation>;
  attach(session: SessionRef, clientId: string, access: 'READ_ONLY' | 'WRITER'): Promise<Attachment>;
  detach(attachmentId: string): Promise<void>;
}
interface ProviderSuspensionPlan {
  sessionId: string;
  incarnationId: string;
  providerProcess: { pid: number; startToken: string; role: 'MODEL_REQUEST_ORIGIN' };
  excludedToolProcesses: ReadonlyArray<{ pid: number; startToken: string }>;
  evidenceRef: string;
}
interface RevisionInput {
  deliveryKey: string;
  revisionId: string;
  displayTitle: string;
  specification: string;
}
interface GuidanceInput {
  commandId: string;
  message: string;
  behavior: 'SAFE_POINT_STEER' | 'FOLLOW_UP';
}
interface AnswerInput {
  commandId: string;
  attentionId: string;
  providerRequestId: string;
  value: unknown;             // Adapter 使用对应问题的 schema 检验
}
type ControlReceipt =
  | { status: 'ACCEPTED'; operationId: string }
  | { status: 'UNSUPPORTED'; reason: string }
  | { status: 'REJECTED'; reason: string };
type SessionObservation =
  | { state: 'ACTIVE' | 'WAITING_FOR_USER'; identityEvidenceRef: string }
  | { state: 'PAUSED' | 'EXITED'; evidence: StopEvidence }
  | { state: 'UNKNOWN'; reason: string };
interface Attachment {
  attachmentId: string;
  mode: 'STRUCTURED' | 'PTY';
  access: 'READ_ONLY' | 'WRITER';
  sessionId: string;
  readCursor: string;
  writerLeaseId?: string;
}
type AdapterEvent = {
  sessionId: string;
  executionId: string;
  eventId: string;
  cursor: string;
} & (
  | { type: 'started'; providerSessionId: string }
  | { type: 'attention'; providerRequestId: string; kind: 'QUESTION' | 'PERMISSION'; prompt: unknown }
  | { type: 'paused'; evidence: StopEvidence }
  | { type: 'safe_point'; reason: 'TURN_AND_TOOLS_SETTLED'; evidence: SafePointEvidence; lastEntryId?: string }
  | { type: 'guidance_accepted'; commandId: string; entryId?: string }
  | { type: 'revision_acknowledged'; deliveryKey: string; revisionId: string; evidenceRef: string }
  | { type: 'active' }
  | { type: 'completed'; outcome: 'SUCCESS' | 'FAILURE'; evidence: StopEvidence }
  | { type: 'exited'; reason: string; evidence: StopEvidence }
  | { type: 'disconnected'; reason: string }
);
```

这是完整设计层类型；当前 `packages/contracts` 只导出 `AgentStartAdapter` / `AgentObserveAdapter` / `AgentAnswerAdapter` 及 attention/completed/disconnected event 子集，不用尚未实现的方法冒充完整 Adapter。

实现层的 `AdapterCapabilities`（`packages/contracts/src/index.ts`）在 ADR-0061 之前**已与本文旧类型一致**（FOUNDATION-063 / ADR-0035）：它包含 `controlledConfiguration`（ADR-0029）、`pluginSelection`（ADR-0044，FOUNDATION-074 补记）与本文的 `nativeTerminalHandoff`、`safePointNotification` 两个维度。**`providerProcessSuspension` 是 ADR-0061 新增的维度，已由 FOUNDATION-097 随 schema v34 一起导出并如实声明**（`declaredProviderProcessSuspension` 是给只读投影用的声明表，与 `declaredPluginSelectionSupport` 同一模式）。这些维度由各 Adapter **如实声明**，不是占位：

| 维度 | Pi | Codex | Claude Code |
|---|---|---|---|
| `nativeTerminalHandoff` | `SUPPORTED` | `UNSUPPORTED` | `UNSUPPORTED` |
| `safePointNotification` | `SUPPORTED` | `UNSUPPORTED` | `UNSUPPORTED` |
| `controlledConfiguration` | `SUPPORTED` | `UNSUPPORTED` | `SUPPORTED` |
| `pluginSelection` | `SUPPORTED` | `UNSUPPORTED` | `UNSUPPORTED` |
| `sessionGuidance`（ADR-0057） | `SUPPORTED` | `REQUIRES_VALIDATION` | `UNSUPPORTED` |
| `providerProcessSuspension`（ADR-0061，FOUNDATION-097 实测） | `SUPPORTED` | `REQUIRES_VALIDATION` | `REQUIRES_VALIDATION` |

`providerProcessSuspension` 的 `SUPPORTED` 只来自一次真实进程测量（`docs/spikes/pi-0.84.4.md` §「Provider 进程冻结（ADR-0061）」）：`pi --mode rpc` 子进程就是模型请求发起者，bash 工具是它自己的后代且在独立 process group，只对该主进程 `SIGSTOP` 时工具不被触碰、且冻结期间新增 0 条 provider 记录、恢复后下一次模型请求才发生。Codex 只完成了「进程归属」那一半（`codex app-server` 子进程及其第三方插件后代），模型那一半被本机 ChatGPT 额度挡住；Claude Code 因本机无凭据连工具层都未跑起来。因此后两者保持 `REQUIRES_VALIDATION`，全局 `pause` 遇到它们会 fail closed 到 `RECOVERY_REQUIRED` 而不是假装已冻结。

Pi 按 ADR-0010/0023/0026 的实测声明前两者 `SUPPORTED`（原生 TUI 在同一 provider session file 上接管、gate extension 上报 tool_start/tool_end/agent_settled）；Codex 按 `docs/spikes/codex-0.151.0.md` 的实测声明两者 `UNSUPPORTED`（app-server 无终端交接，其 TUI 是同一 thread 的第二个 writer；interrupted turn 不产生完成事实）；Claude Code 按 `docs/spikes/claude-2.1.268.md` 声明两者 `UNSUPPORTED`（`--print` 子进程无终端交接，控制通道不暴露工具级开始/结束）。deterministic fake 与测试 stub 声明 `pluginSelection: 'UNSUPPORTED'`（它们不启动任何 provider）。**声明本身不改变行为**：本版本没有把交接路径改为「查能力再决定」，`session.handoff.*` 仍按 ADR-0023/0026 的平台与归属判定执行（在 macOS/unix 上可用），把 Pi 专属机制套到 Codex 上确实会被拒；是否加适配器能力门禁属另一次语义变更，未在本格实施。Pi 自己的 `SessionHandoffCapabilities` 也如实报告残留差距，其取值集是 `IMPLEMENTED / UNSUPPORTED / PARTIAL / UNVERIFIED`（**不是** `AdapterCapabilities` 的 `SUPPORTED/UNSUPPORTED/REQUIRES_VALIDATION`）：`ptyResize: IMPLEMENTED`（ADR-0054，平台范围 = POSIX，见 §5）、`parallelToolBatchSafePoint: IMPLEMENTED`（ADR-0054，真实 Pi 实测，见 §6）、`crossHandoffPermissionModeMatrix: PARTIAL`（ADR-0054，矩阵与**不成立的那一格**见 §7）、`attachToLiveRpcProcess`/`sessionCompactionDuringHandoff`/`windows` 仍 `UNSUPPORTED`。交接与终端的事实现在也有七个 domain event（`TakeoverRequested`、`TakeoverSafePointReached`、`SessionHandoffStarted`、`SessionHandoffCompleted`、`TerminalWriterLeaseChanged`、`TakeoverReleased`、`TakeoverFailed`，见 `event-model.md` §2.1）。**结构化问卷（ADR-0014）没有新增事件类型**：它复用 `attention`，把问卷放在 `prompt` 里（`kind: "codeestra.questionnaire"`），回答用 `AgentAnswer` 的 `QUESTIONNAIRE` 变体表达，因此“一条 Attention = 一个 provider 请求 = 一次 answer Operation”不变。自有 provider 进程的 Adapter 可额外实现可选的 `AgentProcessRelease`（`releaseSession`），供 Runtime shutdown 请求协作释放；缺少该能力时不假定已停止。观察事件经 Zod 校验；只有显式 `toolsQuiescent=true` 与 `ownedWritersStopped=true` 的 completion evidence 才能释放失败 Execution 的资源。`packages/agent-adapters` 的 deterministic fake 只验证协议与编排行为，不执行命令，也不能作为 Pi 验收。PTY 原始字节、resize、input 路由是独立 versioned TerminalTransport 合约，不混入 AdapterEvent（契约与帧表见 §5）。`guide`（会话指导）已实现（FOUNDATION-088 / ADR-0057）：契约面用 `AdapterCapabilities.sessionGuidance` 如实声明，运行中会话的投递由 Adapter 自己的端口（`guide`）承担——Pi `SUPPORTED`（RPC `steer` + provider 自己的 `queue_update`）、Codex `REQUIRES_VALIDATION`、Claude Code `UNSUPPORTED`；Runtime 在投递那一刻读该能力位，不是 `SUPPORTED` 或缺少该端口一律记 `CHANNEL_UNSUPPORTED`，绝不把「消息发出去了」当成投递（「已入队 ≠ 模型已读」，见 ADR-0057）。本文 §1 的类型仍是完整设计层类型，实现层只导出实际落地的方法。原生接管、successor start 与 PTY attachment 已由 ADR-0026 实现，不能因本文类型存在就声称其他 provider 也能接管。

## 2. 语义

- ACCEPTED 仅表示控制请求已受理，不代表已经暂停、回答生效或取消完成。
- ADR-0061 的全局冻结不复用 `requestPause`：前者保持 Task/Execution/Session 状态不变并暂停模型驱动主进程；后者属于单 Task 协作暂停，最终结束旧 Execution。`providerProcessSuspension=SUPPORTED` 只表示 Adapter 能给出并证明模型请求发起进程与应排除的工具进程；真正的 `SIGSTOP`/`SIGCONT`、进程状态复读、pause epoch 与持久屏障由 Runtime 控制层承担（FOUNDATION-097 实现：`apps/runtime/src/runtime-control-service.ts`，命令面 `scheduler control status|pause|resume|reconcile`）。
- 全局冻结前后都要重验 `pid + start token + current incarnation`。只看到 PID、只成功调用 `kill(SIGSTOP)`、只看到 stdout 安静，都不能写 `STOPPED`。PID 复用或身份不可读时不发信号并进入全局控制 `RECOVERY_REQUIRED`。
- 已发出的模型请求不被取消；工具子进程不接收全局暂停信号。若 Provider 主进程被冻结后停止读取管道，大输出工具可能因背压阻塞，因此“未发停止信号”不等于“工具绝不会停顿”。
- start timeout 不能盲重试，可能已创建真实进程。通过 operation/session identity 核对。
- provider 进程身份必须包含 PID 以外的 start token；只有 PID 可用时拒绝启动。丢失 stdio 后不得重接或重放，而是记录 DISCONNECTED 并保留 Execution/workspace 占用。
- 完成证据必须能说明依据。Phase 1 Pi 将 `agent_settled`（且仅允许受控工具集）作为 SUCCESS 依据，并把该依据写入 evidence ref；进程异常退出或 stdout 流损坏不产生完成，而是断连恢复。
- 不支持暂停时按 ADR-0001 协作停止→确认静止→旧 Execution SUPERSEDED→新 Execution。运行中修订保留完整快照与投递审计。
- 无可靠 ACK 时不能通过匹配“好的”判断约束已应用；完整新启动输入是回退路径。
- Runtime 仅能对当前持有 live provider 进程的 Session 投递 answer；无法投递时保留 ANSWER_RECORDED，不重放、不声称已投递。Runtime 自行释放的 provider 进程在投影中标记为 Runtime 来源的断连，而非伪造 provider event。
- 不能确认工具/后代进程静止就返回 UNKNOWN 并保留执行资源，不用 session 的 stdout 安静作为停止证据。
- resume 是已暂停且仍可控的同一会话恢复。退出后 provider resume 另建 Execution，保留来源，不混淆两种恢复。
- attach 必须操作对应真实会话；若只能提供日志浏览，应明确命名 read-only log view，不宣称 attach。ADR-0013 的 `session.transcript`/`session.transcript.part` 就属于后者：它直接读取 provider 持久会话文件的只读视图，既不建立 writer lease，也不要求 live 进程，因此不得被描述为 attach、steering 或终端接管。
- Session Guidance 与 TaskRevision 是两条显式通道：Pi 的 `SAFE_POINT_STEER` 映射 RPC `steer`，在当前 assistant turn 的工具调用结束后、下一次 LLM call 前生效；它不修改 `appliedRevisionId`。Task 修订不得降级为 guidance。
- 原生 TUI 接管不是 attach 到现有 RPC 进程。Runtime 先记录 handoff，并让 Pi gate 建立 fence：当前 assistant turn 已开始的工具继续完成，之后的新 Agent 工具调用被 terminating result 收束；以 `agent_settled` + 活动工具计数 0 作为结构化 safe point。随后确认旧 process incarnation 退出，再用相同 provider session file 启动 `HUMAN_TUI` successor；交还时反向执行。旧进程退出未确认时不得 startSuccessor。
- 一个 Session 同时最多一个交互写入租约，多个客户端可以只读；用户输入、自动 guidance/修订与权限回答由 coordinator 串行路由。writer 竞争明确返回 `ATTACHMENT_BUSY`。
- detach 只解除客户端 PTY attachment，不停止 Agent；`release takeover` 才请求安全点交还自动模式，显式 requestStop 才是取消执行。
- 权限模式跨 handoff 固定：FULL 下 TUI 对已注册工具零确认，gate side channel 只报告结构化工具/配置事实；STRICT 下 gate extension 经受控 side channel 报告 permission request/resolution，继续产生 typed Attention 审计并保持未知工具 fail-closed。两种模式都不能从 ANSI 屏幕抓取业务事实。
- STRICT 保留 provider 原生权限机制，Codeestra 不生成“同意”回复；FULL 按 ADR-0011 自动允许。Adapter 缺少当前模式所需能力时必须报告阻塞，不默默更换权限模型。

## 3. Codex（第二个真实 Adapter，ADR-0029）

`CodexAdapter`（`packages/agent-adapters/src/codex-adapter.ts`，`adapterId = "codex"`）接入 Codex CLI 0.151.0。

**传输**：`codex app-server --stdio`（LF-JSONL JSON-RPC）而不是 `codex exec --json`：只有 app-server 提供可承载 fail-closed gate 的审批应答通道、结构化提问、`turn/interrupt` 与 `thread/resume`。`codex-protocol.ts` 负责 framing、方法名、payload 解析与答案编码；`codex-process.ts` 负责一个子进程的 stdio 与请求/应答/服务端请求路由。

**受控启动**：`codex app-server --stdio [-c model_reasoning_effort=<level>] [--enable default_mode_request_user_input]`。`model`/`modelProvider` 走 `thread/start`（按 Execution 解析，ADR-0012），不在进程启动时钉死。结构化提问工具只在 `--enable default_mode_request_user_input` 下存在（under development），因此是显式选项（registry 由 `CODEESTRA_CODEX_REQUEST_USER_INPUT=1` 打开），默认关闭并在能力矩阵如实反映。

**权限映射**：FULL = `approvalPolicy: never` + `sandbox: danger-full-access`（0 确认）；STRICT = `untrusted` + `workspace-write`，审批请求映射到**既有** `PERMISSION`/`CONFIRM` Attention，`CONFIRM true/false` → `accept`/`decline`，`CANCEL` → `cancel`。不提供 `acceptForSession` 或 execpolicy amendment（那会静默扩大后续权限），不新增审批层、不新增确认。

**能力矩阵（实测，见 [`../spikes/codex-0.151.0.md`](../spikes/codex-0.151.0.md)）**：

| 维度 | 值 | 依据 |
|---|---|---|
| `persistentSession` | `SUPPORTED` | `thread/start` / `thread/resume` |
| `structuredAttention` | `SUPPORTED` / `UNSUPPORTED` | 随 `--enable default_mode_request_user_input` 开关 |
| `nativePermissionRouting` | `SUPPORTED` | 审批 fail-closed 直到客户端回答；accept 与 decline 端到端实测 |
| `pauseWithQuiescence` | `UNSUPPORTED` | 无 pause 原语 |
| `revisionAcknowledgement` | `UNSUPPORTED` | 无 revision ACK；修订走既有停止并新建 Execution |
| `cooperativeStop` | `REQUIRES_VALIDATION` | `turn/interrupt` 返回后已开始的 shell 工具仍在跑；对 app-server 发 SIGTERM 留下孤儿 |
| `attach` | `UNSUPPORTED` | 交互 TUI 连的是共享 app-server daemon，不是这个 stdio 子进程；attach 会是同一 conversation 的第二个 writer |
| `reconnectToLiveSession` | `UNSUPPORTED` | Runtime 重启后不能重接失去 stdio 的 live 进程 |
| `resumeAfterExit` | `SUPPORTED` | 实测同 thread / 同 rollout 路径 |
| `controlledConfiguration` | `UNSUPPORTED` | app-server 没有 `--ignore-user-config`；环境 plugins/MCP servers/hooks 参与执行 |

**Pi 的 PTY 交接机制不套用到 Codex**：ADR-0010/0023/0026 的 handoff fence、successor incarnation、PTY attach、`agent_settled` 安全点都是 Pi 实现。Codex 的 `attach`/`pause`/`revisionAcknowledgement`/`reconnectToLiveSession` 均为 `UNSUPPORTED`，因此**没有** Codex 的终端接管、**不**假设 Codex 能热更新 revision、也**不**把它当作可 attach 的 live 会话。`interrupted` 的 turn **不**产生 `completed` 证据（否则会写入假的 `toolsQuiescent`），而是报 `disconnected`。

> 更正（FOUNDATION-074）：本文曾写「Runtime 目前没有 `FAILED → READY` 路径，因此『Execution 失败后换 Agent』只在 Execution 建立前失败或 pause→resume 路径上成立」。**该缺口已由 ADR-0036/FOUNDATION-061 关闭**：`task retry <project-id> <task-id> <expected-version> [--adapter <pi|codex|claude>]` 显式重试一个 `FAILED` Task（不自动重试），默认复用上次的 Adapter、可换 Adapter，并把换 Agent 的事实写进 `TaskRetryRequested` 的 `adapterId`/`previousAdapterId`/`adapterChanged`。

### 3.1 Claude Code（第三个真实 Adapter，ADR-0040）

`ClaudeAdapter`（`packages/agent-adapters/src/claude-adapter.ts`，`adapterId = "claude"`）接入 Claude Code 2.1.268的 `--print` 控制通道（`claude-protocol.ts` + `claude-process.ts`）。实现 `AgentAnswerAdapter` + 可选 `AgentProcessRelease`。

**能力的诚实边界（本机无凭据）**：spike 实测到「发出真实模型请求之前」为止——argv 的 STRICT/FULL 两套被真实 CLI 接受、`initialize` 往返与 `current_permission_mode` 回读、`--safe-mode` 对用户 hook/agent 的抑制、transcript 派生路径、`--resume` 加载记录会话、**鉴权失败以 `subtype:"success"` + `is_error:true` 到达**这一关键形状。凡需要模型产生的行为一律 `REQUIRES_VALIDATION`，**不写成 `SUPPORTED`**（`structuredAttention`、`nativePermissionRouting`、`cooperativeStop`、`resumeAfterExit`）。

| 维度 | 值 | 依据 |
|---|---|---|
| `persistentSession` | `SUPPORTED` | `--session-id <uuid>` 固定 conversation，transcript 写在派生路径 |
| `controlledConfiguration` | `SUPPORTED` | `--safe-mode --strict-mcp-config` 排除用户 hooks/agents/MCP，同时保留 OAuth/模型/内置工具（`--bare` 因会禁用 OAuth/keychain 被排除） |
| `structuredAttention` | `REQUIRES_VALIDATION` | 有 `AskUserQuestion` 与 `request_user_dialog`，但哪条通道投递、答案如何编码未测 |
| `nativePermissionRouting` | `REQUIRES_VALIDATION` | `can_use_tool` → `control_response` 的形状来自 CLI 自带协议文档与 SDK 客户端代码，未观测真实 prompt 往返 |
| `cooperativeStop` | `REQUIRES_VALIDATION` | `control_request{interrupt}` 存在，但已在运行的工具是否停止未测 |
| `resumeAfterExit` | `REQUIRES_VALIDATION` | `--resume <id>` 确实重开同一 session id；是否真的复述 conversation 内容需要模型回答 |
| `attach` / `nativeTerminalHandoff` / `safePointNotification` / `reconnectToLiveSession` / `pauseWithQuiescence` / `revisionAcknowledgement` | `UNSUPPORTED` | 交互 TUI 是写同一 conversation 的另一个进程；`--print` 子进程失去 stdio 后不可重接；无 pause 原语；无 revision ACK 通道 |
| `pluginSelection` | `UNSUPPORTED` | safe-mode 启动没有 per-resource 选择机制 |

**已知简化**：所有 `can_use_tool`（含 `AskUserQuestion`）一律映射为既有 `PERMISSION`/`CONFIRM` Attention，**不实现问卷编码**；因此「用户批准 `AskUserQuestion` 后 provider 是否会在无人渲染的 dialog 上等待」**未验证**。`session.transcript` 仍是 Pi 专属，Claude Session 上以 `SESSION_FILE_NOT_OWNED` 明确失败，不显示执行过程。stub 测试只证明编排，不是真实 Agent 集成验收。

### 3.1.1 Project Knowledge 的交付通道（ADR-0051）

`AgentStartRequest.knowledgeContext` 是每个 Execution **自己**记录的那份物化知识（ADR-0041 D05 写在 Runtime 数据目录，绝不写 Task worktree）。Runtime 从 `execution_knowledge_snapshots` 回读并解析成绝对路径；Adapter 在 spawn 之前核验「绝对路径 + 普通文件（拒绝符号链接/目录）+ 原始字节 sha256 == digest + 字节数 == bytes + 合法 UTF-8」，任何一条不成立即 `KNOWLEDGE_CONTEXT_UNAVAILABLE` 拒绝启动（`startMayHaveOccurred: false`）。**每个 provider 用它自己的通道**，没有统一抽象、也没有新增能力位：

| Adapter | 通道 | 交付形态 | 依据 |
|---|---|---|---|
| Pi | `--append-system-prompt <绝对路径>` | 路径（Pi 自己读文件内容） | Pi 0.85.1 `resolvePromptInput`：路径存在则读文件，否则按字面文本 |
| Claude Code | `--append-system-prompt-file <绝对路径>` | 路径 | 真实 CLI 2.1.268 接受该选项（未知选项 exit 1），自身帮助把该对写作 `--append-system-prompt[-file]` |
| Codex | `thread/start` / `thread/resume` 的 `developerInstructions` | 已核验文本（内联） | `generate-json-schema`（0.154.0）的 `ThreadStartParams`/`ThreadResumeParams`，真实 app-server 接受 |

**零知识 == 现状**：无绑定或 `entryCount === 0` 时不产生该字段，受控启动的 argv/入参与改动前逐字节相同。三条启动路径（主启动、successor、pause→resume）都携带它。**未验证**：provider 是否真的读了这份知识、模型是否据此行动（需真实模型验收）。

### 3.2 Agent 插件 / 资源选择（ADR-0044，命令面）

`pluginSelection` 是 ADR-0044 新增的第十二个能力维度（`packages/contracts/src/index.ts` 的 `AdapterCapabilities`）：

- `agent plugins list [--project <id>] [--adapter <id>] [--json]` **只读**报出 provider 自己的候选插件/资源 + 当前选择 + 该 Adapter 的支持情况。检测只读 provider 用户配置目录（`PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）与其中的 `settings.json`，**绝不扫描仓库内目录、不跟随符号链接进入 Git 工作树、零写入**。
- `agent plugins select … [--extension <path>]… [--skill <path>]… [--prompt-template <path>]… [--theme <path>]… [--clear] [--json]` 写入**整份**选择（重复 flag 而非 JSON 文件，一个路径不需要第二条转义规则），零确认、幂等，退出码 0 applied / 1 refused / 2 usage。每个路径在写入前核验一次、在 Session 启动前再核验一次。
- 选择按作用域持久化（`agent_configurations.plugin_selection_json`，schema v27），在 Execution 预留时解析成生效值并写入 `executions.agent_config_json`，因此同一 Execution 的启动参数可事后读回；`agent.config.get` 同时报告生效值与来源层。
- 对 `pluginSelection: UNSUPPORTED` 的 Adapter，`agent plugins select` 以稳定码拒绝，**不写入选择**；Agent 设置页在同一字段为 `UNSUPPORTED` 时不显示候选列表。

**未验证（不得当成已成立）**：真实模型下「确实使用了所选 skill/theme」只有 argv 与命令面证据；themes 的显式路径加载未单独实测（ADR-0044 D06 标注为同构代码路径推断）；第三方 extension 是否能绕过 gate 未做对抗验证。

## 4. Phase 1 Pi Spike 验收门禁
1. [已完成首轮] 阅读 Pi 0.84.4 SDK/RPC/Session/extension 文档与 examples，固定版本 0.84.4、MIT、Node `>=22.19.0`。
2. [部分完成] RPC framing、按权限模式选择的受控 gate（STRICT fail-closed；FULL 全工具自动允许，ADR-0011）、真实 `PiRpcAdapter` 子进程（受控 argv、get_state 身份、prompt 注入 revision、attention/completion/disconnect 映射、typed answer 写入）与持久 answer Operation 已实现；仍需真实 Pi 的 FULL 工具执行验收。
3. [部分完成] 内置 bash abort/process-group spike 通过；任意 extension/逃逸进程不在保证内，限定工具集仍需逐项验证。
4. [已明确边界] 持久 conversation 可跨进程恢复；不能重接失去 stdio 的 live Pi 进程。
5. [部分完成] Runtime 持有 RPC pipes 时可提供结构化 attach；Runtime 重启后的 live attach 不支持。当前 adapter 明确拒绝无 live 进程的 observe/answer。
6. [部分完成] fake 已覆盖启动部分失败、answer 投递失败与 provider event/outbox 重投；Pi adapter 已覆盖受控 argv/身份/断连/答案往返的 stub-transport 测试；真实 Pi 的修订 fallback、取消超时、事件重投与孤儿进程仍未完成。

Pi 0.84.4 没有 pause/resume 与可靠 revision ACK 原语。Phase 1 运行中修订必须走停止、确认静止、旧 Execution `SUPERSEDED`、新 Execution 完整启动的 fallback。真实运行的 Git 授权按权限模式处理（FULL 单步 capture、无敏感路径拦截；STRICT 保留 prepare/confirm）；fake adapter 不能替代这些验收。

## 5. TerminalTransport（versioned 合约，ADR-0026 + ADR-0054）

PTY 的原始字节、input 路由与**窗口尺寸**是 Runtime 与它锁拥有的 PTY host helper 之间的传输事实，
**不是** `AdapterEvent`，也永远不从终端字节推断任何业务状态（ADR-0010 D06）。合约版本号显式协商：
Runtime 在 spawn plan 里带 `transport: 1`，helper 只接受它支持的那一版并在 `ready` 帧回显，版本不符即拒绝
（`PTY_TRANSPORT_PROTOCOL_MISMATCH`），不猜、不降级。帧表（v1）：

| 方向 | 帧 | 含义 |
|---|---|---|
| helper → Runtime | `ready { providerPid, slave, transport, cols, rows, windowSize }` | provider 已在真实终端上运行；`windowSize: 'APPLIED' \| 'NOT_APPLIED'` 只描述**启动时**那一次设置 |
| helper → Runtime | `output { data }` / `exit { code, signal }` / `error { code, message }` | 投影字节流与进程退出事实（退出码只作审计） |
| helper → Runtime | `resized { cols, rows, applied, detail }` | 一次 resize 的**结果**。`detail` 是稳定原因串（`stty` / `STTY_FAILED` / `INVALID_SIZE` / `PROVIDER_EXITED`），**永不出现「没有回答」** |
| Runtime → helper | `resize { cols, rows }` | 改变终端几何 |
| Runtime → helper | `input { data }` / `eof` / `signal` / `shutdown` | 输入与停止 |

- **机制**：`stty rows R cols C` 作用在**该终端的 slave fd** 上——与启动时设初始尺寸用的是同一个接口，
  也是 provider 自己读尺寸的接口（`TIOCGWINSZ`）。因此 helper 保留自己的 slave 副本到终端结束；
  provider 是否退出由 `waitpid` 判定（实测 master 在 provider 退出后不保证报 EOF）。
  `ioctl(TIOCSWINSZ)` 经 Bun FFI 在本机 darwin/arm64 会返回 0 却写入垃圾尺寸（AArch64 变参 ABI），理由写在代码注释里。
- **取值域是合约的一部分**：`1..1000` 的整数行列，Runtime / helper / Zod 三处都拒绝越界。
- **命令面**：`session handoff terminal resize`（`docs/guides/cli/task-revision-session.md` §7）。退出码 `0` 只有真的改了尺寸；
  `1` 拒绝或未生效；`2` 越界。`session.handoff.status` 的 `terminal.currentSize` 只在**本 Runtime 仍持有该终端**时非 null：
  启动时的 `windowSize` 不是「现在的尺寸」。
- **写入者座位拥有视口**：已有客户端持有该终端的 `WRITER` attachment 时，只有它能 resize；其他 holder 得到
  `TERMINAL_RESIZE_WRITER_BUSY`（当前 holder 被报出）。这与 `attach` 的单 writer 规则是同一条，**不是新增审批**。
- **实测**：真实 PTY 上 provider 自己读到 `30 100` → `33 99` → `12 40`；真实 Pi 原生 TUI 收到 `120x40` 后回 `APPLIED`。
- **平台范围**：POSIX（Runtime 持有的 PTY）为 `IMPLEMENTED`；Windows 没有 PTY 传输，随 `ptyTransport`/`windows` 一起 `UNSUPPORTED`；
  Linux 走同一段代码路径但本机未实测。

## 6. 并行工具批次下的安全点（ADR-0054）

安全点规则**没有改变**（ADR-0010 D03）：`fence 已确认` + `活动工具计数 == 0` + `fence 之后有 agent_settled` + `无待决 Attention`。
本格用真实 Pi（脚本化模型、生产 gate、真实 side channel）实测它在**同一 assistant 消息的多个 tool call** 下仍可判定且不会被绕过：

- 每个 tool call 各上报一次 `tool_start`/`tool_end`（按 provider `toolCallId`）；**全部 `tool_start` 先于任何 `tool_end`**，
  `tool_end` 按完成顺序，`agent_settled` 在最后一个 `tool_end` 之后。Runtime 因此在整个批次中看到 `activeTools > 0`。
- 批次进行中打开 fence：**已开始的兄弟调用不被 abort**（真实输出、`isError=false`），下一个到达的工具调用被 terminating block
  （`CODEESTRA_HANDOFF_FENCE: no new tools after the safe point`），随后 `agent_settled`。被拦下的调用**也有** `tool_end`
  （Pi 的 immediate 分支），所以活动计数不会泄漏成「永不静止」。
- 待决的 STRICT Attention 即使 `settled` 且 `activeTools === 0` 也**不构成安全点**（`#evaluateSafePoint` 的 open-Attention 分支）。
- **未实测**：「fence 恰好落在同批次预检中间」的亚毫秒窗口（只有代码推断，见 spike §3/§5）。

证据与可复跑探针：`docs/spikes/pi-parallel-tool-batch.md`、`docs/spikes/pi-parallel-tool-batch/*.ts`。

## 7. 跨交接权限模式矩阵（ADR-0054）

`crossHandoffPermissionModeMatrix` 保持 **`PARTIAL`**：下面每一格都有测试或明确的「无法在本机验证」，并点名**不成立的那一格**。

| 阶段 | FULL | STRICT |
|---|---|---|
| 交接前（`AUTOMATED_RPC`） | 工具零确认；argv `--approve`、env `CODEESTRA_PERMISSION_MODE=FULL`（CLI e2e 逐 incarnation 从 provider 自己读回） | argv `--no-approve` + `--tools <白名单>`；工具经**既有** Attention（分类器单元测试 + Runtime Attention/原子拒绝测试） |
| 接管中（原生 TUI） | **零** `permission_request`，工具真执行（真实 Pi TUI + 生产 gate + 生产 PTY） | 每个 `bash` 一条 `permission_request`（`piMode=tui`），决议经 side channel 生效；ALLOW 真执行、DENY 不执行且不挂死（同一套真实环境） |
| 交还后（`AUTOMATED_RPC`） | argv/env 与工具白名单逐字保持（CLI e2e，两个模式各双向一遍） | 同上 |
| 交接本身是否新增确认 | **否**：`request`/`admit`/`attach`/`detach`/`release` 全零确认（命令面没有确认输入） | 同左 |
| incarnation 绑定的过期决议 | 原子拒绝 `INCARNATION_NOT_CURRENT`；两个 answer 不可能都成功 | 同左 |
| **不成立的那一格** | — | **真实 provider + 由人经记录下来的 Attention 决定 + 原生 TUI 接管的组合**：两半各自有证据（真实 Pi → side channel；Runtime Attention → 投递与原子拒绝），合起来没跑过。工具类别也只实测了 `bash`；`edit`/`write` 与未知工具的 fail-closed 由分类器单元测试覆盖 |

`agent_settled` **不等于成功**（被 gate 拒绝或被 fence 拦截的轮次同样会 settled），完成判定仍由 Adapter 的终止性 block 事实参与。
