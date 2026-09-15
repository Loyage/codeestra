# Agent Adapter API

状态：Runtime port 设计，不是 Pi SDK API 的复述。当前代码导出 start/observation/typed-answer 子集与 deterministic fake、真实 `PiRpcAdapter`（自有子进程、身份采集、attention/completion/disconnect 映射、typed answer 写入），以及第二个真实 Adapter **`CodexAdapter`**（ADR-0029，`codex app-server --stdio`）；pause/revision/stop control 尚未落地。Runtime 已接入 adapter registry 与事件 pump；提交/回答仍由 CLI 显式触发。Pi 0.84.4 首轮文档核对、受控 RPC spike 与 adapter transport smoke 已完成，结论见 [`../spikes/pi-0.84.4.md`](../spikes/pi-0.84.4.md)；Codex 0.151.0 结论见 [`../spikes/codex-0.151.0.md`](../spikes/codex-0.151.0.md)；commit/trust 产品策略已确认，真实工具执行/取消门禁仍未验收。

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
  revision: { id: string; specification: string; constraints: readonly Constraint[] };
  knowledgeSnapshotRefs: readonly string[];
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
interface RevisionInput {
  deliveryKey: string;
  revisionId: string;
  specification: string;
  constraints: readonly Constraint[];
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

实现层的 `AdapterCapabilities`（`packages/contracts/src/index.ts`）**已与本文类型一致**（FOUNDATION-063 / ADR-0035）：它包含 `controlledConfiguration`（ADR-0029），也已包含本文的 `nativeTerminalHandoff` 与 `safePointNotification` 两个维度。两个维度由各 Adapter **如实声明**，不是占位：Pi 按 ADR-0010/0023/0026 的实测声明两者 `SUPPORTED`（原生 TUI 在同一 provider session file 上接管、gate extension 上报 tool_start/tool_end/agent_settled）；Codex 按 `docs/spikes/codex-0.151.0.md` 的实测声明两者 `UNSUPPORTED`（app-server 无终端交接，其 TUI 是同一 thread 的第二个 writer；interrupted turn 不产生完成事实）；deterministic fake 与测试 stub 声明 `UNSUPPORTED`（它们不启动任何 provider）。**声明本身不改变行为**：本版本没有把交接路径改为「查能力再决定」，`session.handoff.*` 仍按 ADR-0023/0026 的平台与归属判定执行（在 macOS/unix 上可用），把 Pi 专属机制套到 Codex 上确实会被拒；是否加适配器能力门禁属另一次语义变更，未在本格实施。交接与终端的事实现在也有七个 domain event（`TakeoverRequested`、`TakeoverSafePointReached`、`SessionHandoffStarted`、`SessionHandoffCompleted`、`TerminalWriterLeaseChanged`、`TakeoverReleased`、`TakeoverFailed`，见 `event-model.md` §2.1）。**结构化问卷（ADR-0014）没有新增事件类型**：它复用 `attention`，把问卷放在 `prompt` 里（`kind: "codeestra.questionnaire"`），回答用 `AgentAnswer` 的 `QUESTIONNAIRE` 变体表达，因此“一条 Attention = 一个 provider 请求 = 一次 answer Operation”不变。自有 provider 进程的 Adapter 可额外实现可选的 `AgentProcessRelease`（`releaseSession`），供 Runtime shutdown 请求协作释放；缺少该能力时不假定已停止。观察事件经 Zod 校验；只有显式 `toolsQuiescent=true` 与 `ownedWritersStopped=true` 的 completion evidence 才能释放失败 Execution 的资源。`packages/agent-adapters` 的 deterministic fake 只验证协议与编排行为，不执行命令，也不能作为 Pi 验收。PTY 原始字节、resize、input 路由是独立 versioned TerminalTransport 合约，不混入 AdapterEvent。`guide`（会话指导）仍未导出或实现；原生接管、successor start 与 PTY attachment 已由 ADR-0026 实现，不能因本文类型存在就声称其他 provider 也能接管。

## 2. 语义

- ACCEPTED 仅表示控制请求已受理，不代表已经暂停、回答生效或取消完成。
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

**Pi 的 PTY 交接机制不套用到 Codex**：ADR-0010/0023/0026 的 handoff fence、successor incarnation、PTY attach、`agent_settled` 安全点都是 Pi 实现。Codex 的 `attach`/`pause`/`revisionAcknowledgement`/`reconnectToLiveSession` 均为 `UNSUPPORTED`，因此**没有** Codex 的终端接管、**不**假设 Codex 能热更新 revision、也**不**把它当作可 attach 的 live 会话。`interrupted` 的 turn **不**产生 `completed` 证据（否则会写入假的 `toolsQuiescent`），而是报 `disconnected`。未完成项（ADR-0029 记录）：Runtime 目前没有 `FAILED → READY` 路径，因此「Execution 失败后换 Agent」只在 Execution 建立前失败或 pause→resume 路径上成立。

## 4. Phase 1 Pi Spike 验收门禁

1. [已完成首轮] 阅读 Pi 0.84.4 SDK/RPC/Session/extension 文档与 examples，固定版本 0.84.4、MIT、Node `>=22.19.0`。
2. [部分完成] RPC framing、按权限模式选择的受控 gate（STRICT fail-closed；FULL 全工具自动允许，ADR-0011）、真实 `PiRpcAdapter` 子进程（受控 argv、get_state 身份、prompt 注入 revision、attention/completion/disconnect 映射、typed answer 写入）与持久 answer Operation 已实现；仍需真实 Pi 的 FULL 工具执行验收。
3. [部分完成] 内置 bash abort/process-group spike 通过；任意 extension/逃逸进程不在保证内，限定工具集仍需逐项验证。
4. [已明确边界] 持久 conversation 可跨进程恢复；不能重接失去 stdio 的 live Pi 进程。
5. [部分完成] Runtime 持有 RPC pipes 时可提供结构化 attach；Runtime 重启后的 live attach 不支持。当前 adapter 明确拒绝无 live 进程的 observe/answer。
6. [部分完成] fake 已覆盖启动部分失败、answer 投递失败与 provider event/outbox 重投；Pi adapter 已覆盖受控 argv/身份/断连/答案往返的 stub-transport 测试；真实 Pi 的修订 fallback、取消超时、事件重投与孤儿进程仍未完成。

Pi 0.84.4 没有 pause/resume 与可靠 revision ACK 原语。Phase 1 运行中修订必须走停止、确认静止、旧 Execution `SUPERSEDED`、新 Execution 完整启动的 fallback。真实运行的 Git 授权按权限模式处理（FULL 单步 capture、无敏感路径拦截；STRICT 保留 prepare/confirm）；fake adapter 不能替代这些验收。
