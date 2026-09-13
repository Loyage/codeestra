# Agent Adapter API

状态：Runtime port 设计，不是 Pi SDK API 的复述。当前代码导出 start/observation/typed-answer 子集与 deterministic fake、以及真实 `PiRpcAdapter`（自有子进程、身份采集、attention/completion/disconnect 映射、typed answer 写入）；pause/revision/stop control 尚未落地。Runtime 尚未接入 adapter registry 与事件 pump（提交/回答仍由 CLI 显式触发）。Pi 0.84.4 首轮文档核对、受控 RPC spike 与 adapter transport smoke 已完成，结论见 [`../spikes/pi-0.84.4.md`](../spikes/pi-0.84.4.md)；commit/trust 产品策略已确认，真实工具执行/取消门禁仍未验收。

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

这是完整设计层类型；当前 `packages/contracts` 只导出 `AgentStartAdapter` / `AgentObserveAdapter` / `AgentAnswerAdapter` 及 attention/completed/disconnected event 子集，不用尚未实现的方法冒充完整 Adapter。自有 provider 进程的 Adapter 可额外实现可选的 `AgentProcessRelease`（`releaseSession`），供 Runtime shutdown 请求协作释放；缺少该能力时不假定已停止。观察事件经 Zod 校验；只有显式 `toolsQuiescent=true` 与 `ownedWritersStopped=true` 的 completion evidence 才能释放失败 Execution 的资源。`packages/agent-adapters` 的 deterministic fake 只验证协议与编排行为，不执行命令，也不能作为 Pi 验收。PTY 原始字节、resize、input 路由是独立 versioned TerminalTransport 合约，不混入 AdapterEvent。`nativeTerminalHandoff`、`safePointNotification`、`guide`、successor start 与 PTY attachment 均是 ADR-0010 的完整设计，当前代码尚未导出或实现，不能因本文类型存在就声称可接管。

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
- attach 必须操作对应真实会话；若只能提供日志浏览，应明确命名 read-only log view，不宣称 attach。
- Session Guidance 与 TaskRevision 是两条显式通道：Pi 的 `SAFE_POINT_STEER` 映射 RPC `steer`，在当前 assistant turn 的工具调用结束后、下一次 LLM call 前生效；它不修改 `appliedRevisionId`。Task 修订不得降级为 guidance。
- 原生 TUI 接管不是 attach 到现有 RPC 进程。Runtime 先记录 handoff，并让 Pi gate 建立 fence：当前 assistant turn 已开始的工具继续完成，之后的新 Agent 工具调用被 terminating result 收束；以 `agent_settled` + 活动工具计数 0 作为结构化 safe point。随后确认旧 process incarnation 退出，再用相同 provider session file 启动 `HUMAN_TUI` successor；交还时反向执行。旧进程退出未确认时不得 startSuccessor。
- 一个 Session 同时最多一个交互写入租约，多个客户端可以只读；用户输入、自动 guidance/修订与权限回答由 coordinator 串行路由。writer 竞争明确返回 `ATTACHMENT_BUSY`。
- detach 只解除客户端 PTY attachment，不停止 Agent；`release takeover` 才请求安全点交还自动模式，显式 requestStop 才是取消执行。
- 权限模式跨 handoff 固定：FULL 下 TUI 对已注册工具零确认，gate side channel 只报告结构化工具/配置事实；STRICT 下 gate extension 经受控 side channel 报告 permission request/resolution，继续产生 typed Attention 审计并保持未知工具 fail-closed。两种模式都不能从 ANSI 屏幕抓取业务事实。
- STRICT 保留 provider 原生权限机制，Codeestra 不生成“同意”回复；FULL 按 ADR-0011 自动允许。Adapter 缺少当前模式所需能力时必须报告阻塞，不默默更换权限模型。

## 3. Phase 1 Pi Spike 验收门禁

1. [已完成首轮] 阅读 Pi 0.84.4 SDK/RPC/Session/extension 文档与 examples，固定版本 0.84.4、MIT、Node `>=22.19.0`。
2. [部分完成] RPC framing、按权限模式选择的受控 gate（STRICT fail-closed；FULL 全工具自动允许，ADR-0011）、真实 `PiRpcAdapter` 子进程（受控 argv、get_state 身份、prompt 注入 revision、attention/completion/disconnect 映射、typed answer 写入）与持久 answer Operation 已实现；仍需真实 Pi 的 FULL 工具执行验收。
3. [部分完成] 内置 bash abort/process-group spike 通过；任意 extension/逃逸进程不在保证内，限定工具集仍需逐项验证。
4. [已明确边界] 持久 conversation 可跨进程恢复；不能重接失去 stdio 的 live Pi 进程。
5. [部分完成] Runtime 持有 RPC pipes 时可提供结构化 attach；Runtime 重启后的 live attach 不支持。当前 adapter 明确拒绝无 live 进程的 observe/answer。
6. [部分完成] fake 已覆盖启动部分失败、answer 投递失败与 provider event/outbox 重投；Pi adapter 已覆盖受控 argv/身份/断连/答案往返的 stub-transport 测试；真实 Pi 的修订 fallback、取消超时、事件重投与孤儿进程仍未完成。

Pi 0.84.4 没有 pause/resume 与可靠 revision ACK 原语。Phase 1 运行中修订必须走停止、确认静止、旧 Execution `SUPERSEDED`、新 Execution 完整启动的 fallback。真实运行的 Git 授权按权限模式处理（FULL 单步 capture、无敏感路径拦截；STRICT 保留 prepare/confirm）；fake adapter 不能替代这些验收。
