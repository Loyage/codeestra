# 内部 Event Model

> 层级：L1 · 体量 ≈ 13k 字符 · **何时读**：新增/消费 domain event、改订阅或 outbox、判断某个事实该不该成为事件 · **权威来源**：`packages/storage/src/database.ts` 与 `apps/runtime/src/**` 真实写入的名字与 payload；本目录只解释它们。逐事件的完整 payload 与事实边界见 [`event-model-payloads.md`](./event-model-payloads.md)（**默认不用读**）。

## 1. 边界与信封

客户端发 command（期望行为），Runtime 写 domain event（已发生事实）；Adapter event（外部观察）先经身份、顺序、状态校验，再转换为领域事实。数据库是权威状态，事件支持审计与订阅；**不用终端日志重建业务状态**。

**Signal 不是 domain event**：Signal 是有目标 Service、可 claim/ack/retry 的持久工作信封；domain event 是已经发生且 append-only 的事实。一个 handler 可以因一个 Signal 产生多个 event，也可以幂等命中而不产生新 event。跨 SQLite/Git/Provider 只承诺 at-least-once + 幂等收敛，不宣称 exactly-once（见 [`service-process-signal.md`](./service-process-signal.md) §5）。

```ts
type EventEnvelope<T extends string, P> = {
  eventId: string;
  sequence: number;                  // SQLite 分配，本 Runtime 数据库内有序
  eventType: T;
  schemaVersion: number;
  projectId: string | null;           // NULL = Runtime 全局事实（ADR-0061/v34），不是「未知 Project」
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: number;
  correlationId: string;              // 一次用户意图/工作链
  causationId: string | null;         // 导致此事实的 command/event
  payload: P;
};
type CommandEnvelope<T extends string, P> = {
  commandId: string;
  type: T;
  projectId: string | null;           // 全局调度命令为 null；项目命令仍必须非空
  expectedVersion?: number;           // 修改聚合时必填，创建时例外
  actor: string;                      // 从受信入口赋值，不相信任意外部声明
  payload: P;
};
```

跨进程输入用 Zod discriminated union；未知 `schemaVersion` 返回明确错误，不宽松吞掉新字段语义。

## 2. 事件目录（以实现实际写入的名字为准）

### 2.1 核心生命周期与 Service Kernel

| Event | aggregate | payload 要点 |
|---|---|---|
| `IntentRecorded` | `Intent` | intentId, kind |
| `TaskCreated` | `Task` | taskId, revisionId, displayTitle, namingTitle, features |
| `TaskStateChanged` | `Task` | taskId, from, to, reason |
| `TaskArchived` / `TaskUnarchived` | `Task` | taskId, from, to（同态，只改 `archived_at`）, reason, actor |
| `TaskPurged` | `Task` | taskId, displayNumber, rowsDeleted, branchFacts, reclamation, `forced`（`--force` 时非 null）, taskId 已不存在；完整字段见 payloads 篇 |
| `TaskRevisionCreated` | `Task` | taskId, revisionId, revisionNumber, previousRevisionId, features, reason, actor |
| `TaskDependencyAdded` / `TaskDependencyRemoved` | `Task` | dependentId, prerequisiteId, requiredRevisionId |
| `ExecutionReserved` | `Execution` | executionId, taskId, revisionId, workspaceId |
| `ExecutionStateChanged` | `Execution` | executionId, from, to, reason |
| `ExecutionFailed` | `Execution` | executionId, reason, stopEvidenceRef |
| `WorkspacePrepared` | `Workspace` | workspaceId, taskId, branch, baseCommit（重建时另带 `rebuild.outcome` 等，事件名不变） |
| `AgentSessionStarted` | `AgentSession` | executionId, sessionId, adapterId, providerSessionId |
| `AgentSessionStateChanged` | `AgentSession` | sessionId, from, to |
| `AgentSessionCompleted` | `AgentSession` | executionId, sessionId, outcome, evidenceRef, 可选 note |
| `UserAttentionRequested` | `Attention` | attentionId, sessionId, kind, responseType |
| `UserAnswerRecorded` / `UserAnswerDelivered` | `Attention` | attentionId, answerId；不广播敏感回答正文 |
| `ResultCommitAuthorized` / `ResultCommitAuthorizationInvalidated` | `Execution` | authorizationId, executionId, revisionId, expectedHead, changeFingerprint |
| `ResultCommitCreated` | `Execution` | authorizationId, executionId, revisionId, baseCommit, resultCommit, resultTree, identity, hookOutcome |
| `RecoveryRequired` | `Execution` \| `Attention` \| `AgentSession` \| `Task` | resourceType + resourceId + reason（Task 变体是投影到 `RECOVERY_REQUIRED` 的事实） |
| `TaskRecoveryReconciled` | `Task` | 只读对账的观察与收口结论；**拒绝路径不写事件**（无状态变化），完整字段见 payloads 篇 |
| `VerificationCompleted` | `VerificationRun` | verificationId, testedCommit, testedTree, policyVersion/Digest, mainCommit, state, outcomeCode |
| `VerificationInvalidated` | `Task` | taskId, reason, verificationIds, testedCommit, policyDigest |

**Service Kernel（schema v37 / ADR-0070 S2–S4）**

| Event | aggregate | payload 要点 |
|---|---|---|
| `SignalEnqueued` | `Signal` | signalId, kind, subtype, targetServiceId |
| `SignalClaimed` | `Signal` | signalId, attempt, bootId |
| `SignalRetryScheduled` | `Signal` | signalId, state, code, retryAt |
| `SignalDeadLettered` / `SignalRecoveryRequired` | `Signal` | signalId, state, code, retryAt=null |
| `SignalAcknowledged` | `Signal` | signalId, effect（与 receipt 同事务） |
| `SignalRetryRequested` | `Signal` | signalId |
| `ServiceMetadataChanged` | `Service` | serviceId, namespace, key, stateVersion |
| `ProcessCreated` | `Process` | processId, kind, parentServiceId, objective, adapterId, sourceSignalId |

事件不承载 metadata value 或 intention 正文；这些值留在受约束的状态与 Signal payload 里。claim lease 过期先把旧 attempt 记为 `RETRYABLE` 并发布 retry 事实，再由新 boot 重新 claim；幂等命中已有 Signal/receipt 不追加第二个副作用事实。

### 2.2 其余域的事件（名字与一行说明）

**长命令进度（ADR-0019/0027）**

| Event | aggregate | 要点 |
|---|---|---|
| `OperationProgressed` | `Operation` | 每 Operation 单调的 `progressSequence` + `dedupKey` + `phase`(STEP/OUTPUT/CANCEL/SETTLED)；`verdict: false` |
| `OperationSettled` | `Operation` | `dedupKey='SETTLED'`；只声明「这条长命令结束了」，**不是判定**；`eventId` 由 operationId 推导，重试只能发布同一事实 |

**修订投递（ADR-0028）**：`TaskRevisionDeliveryRecorded` → `TaskRevisionDeliveryAttempted` → `TaskRevisionDeliveryResolved`（`TaskRevisionDelivery`）。

**容量与调度（ADR-0032/0033/0061）**：`ExecutionSlotReserved` / `ExecutionSlotWorkspaceBound` / `ExecutionSlotReleased` / `ExecutionSlotReconciled`（`ExecutionSlot`）、`TaskScheduleDecided` / `TaskWaitingForConflict` / `TaskWaitingForCapacity` / `TaskUnknownCleared` / `TaskImpactPredictionRevoked`（`TaskSchedule`）、`SchedulerGlobalCapacityChanged`（`RuntimeSchedulerControl`）。

**交接与原生终端（ADR-0023/0026/0035）**：`TakeoverRequested`、`TakeoverSafePointReached`、`SessionHandoffStarted`、`SessionHandoffCompleted`、`TakeoverReleased`、`TakeoverFailed`（`SessionHandoff`）、`TerminalWriterLeaseChanged`（`SessionWriterLease`）。**只有 `SessionHandoffCompleted` 表示 successor 真的启动并持有 writer lease**；`...Requested` 与 `...Started` 都不是「已交接」。

**会话指导（ADR-0057）**：`SessionGuidanceRecorded`、`SessionGuidanceDelivered`（`SessionGuidance`）。`DELIVERED` 只表示 provider 通道**接受入队**；**没有任何事件或列表达「模型已读」**。

**显式重试与散文提问解除**：`TaskRetryRequested`（`Task`）、`ProseQuestionAttentionResolved`（`Attention`，`deliveredToProvider: false`）。

**回收（ADR-0021）**：`ResourcesReclaimed`（`Operation`）、`WorkspaceReclaimed`（`Workspace`）。

**没有新增事件名的能力（如实登记）**：Project Knowledge（ADR-0041）只写 `knowledge_snapshots`/`execution_knowledge_snapshots` 两张表；定向测试计划（ADR-0038）只追加 `targeted_test_plans`；Agent 插件选择（ADR-0044）只写配置列并在 `executions.agent_config_json` 留痕。它们的可审计性来自表与命令回执，不是事件流。

> **已删除能力的历史事件**：v36（ADR-0066）删除了集成与提升，`Integration*` / `Promotion*` 事件**不再产生**；历史行仍在 `domain_events` 里可读，其字段只需查 `git log` 或当时的 ADR，本文不再维护。

### 2.3 命名规则（ADR-0035 裁决，长期有效）

> **旧章节号对照**：旧 §2.1「各领域的补充事实」→ 本篇 §2.2 与 [`event-model-payloads.md`](./event-model-payloads.md)；旧 §2.2「命名规则」→ 本篇 §2.3；旧 §2.3「设计名与实现名的差异」**已删除**（规则保留为下方第 4 条）；旧 §3/§3.1/§4/§4.1/§5 编号不变。

1. **已实现的事件名以实现为准，永不重命名。** 事件台账是 append-only 审计：重命名会让同一语义在历史里长期存在两个名字，并让订阅游标、消费者幂等键与外部脚本同时失效。
2. **新事件采用设计名。** 设计目录是先行契约；实现某条设计事件时不另起名字。
3. **名字变更只能通过「新增事件 + 旧事件不再产生」实现。** 不迁移历史行、不改写已有行、不把旧名行「升级」成新名。
4. 与旧设计目录的逐项差异表已删除；需要时查 [ADR-0035](../decisions/0035-event-name-and-handoff-faces.md) 与真实写入代码。设计名里**未实现**的（`TaskPriorityChanged`、`IntentClarificationRequested`、`ResultCommitAuthorizationRequested`、`CandidateBuilt` 等 Self Evolution 事件）在实现前不写进事件表。

## 3. 一致性、投递和恢复

1. command 收到后校验身份、payload 与幂等键；相同键不同 payload 拒绝。
2. 在同一 SQLite 事务中检查 version、更新状态、写事件、建立消费者投递记录与 command receipt。
3. commit 后才通知客户端/执行副作用；外部操作另有 Operation 记录。
4. 消费者至少一次投递，在自身状态更新事务中标记已消费。启动进程、Git ref 更新、回答问题不能只靠重试避免重复，必须先 reconcile 外部效果。
5. 单库 `sequence` 是排序游标，不是分布式时钟。客户端以 snapshot + cursor 开始，再订阅 cursor 之后的事件，避免漏消息。
6. 订阅断开不影响 Runtime；重连带 cursor。游标失效则明确要求重新取快照。
7. 迟到的旧 Session/Execution 事件被审计，但不能覆盖新尝试。重复外部事件以 provider event ID 或 adapter 本地持久序号去重；不支持可靠去重的输入需要 reconcile。
8. 不做无限立即重试：退避、次数与最近错误可见；单个失败投递不能让其他任务全局停机。
9. Adapter observation 以 `(session_id, provider_event_id)` 去重并要求同一 Session 的 cursor 唯一；同 ID 异文 fail-closed。opaque cursor 持久化在 Session 行，重启后从该 cursor 继续。
10. durable delivery worker 按 sequence 投递并持久化 attempt/退避；它是至少一次，消费者必须按 `eventId` 幂等。

## 3.1 订阅传输（Phase 1 已实现）

本地 socket 同时承载一次性命令与长连接订阅，两者在同一连接协议内，不在每个请求后强制关闭的路径上混用。

- **一次性命令**：一条连接一个 command，回一条 response 后关闭。`events.list` 属于此类，`sinceSequence` 默认 0、`limit` 上限 500，返回 `{ events, cursor, hasMore }`；`cursor` 是下一次读取的排他游标（无事件时等于请求游标）。
- **长连接**：`events.subscribe` 先回一帧 `subscribed`（含快照游标），随后按 sequence 递增推送 `event`，定期推 `heartbeat`，`error` 是终止帧。客户端 stdout 只承载 event envelope，便于脚本消费。
- 省略 `sinceSequence` 表示「从当前尾部开始」，因此客户端应先取快照再订阅，两者之间不漏消息；显式给出时从该游标之后重放并继续跟随，游标排他，重连既不跳过也不重复边界事件。
- 游标超前于日志时返回 `INVALID_CURSOR` 终止帧，不静默夹到尾部；读取失败发出 `EVENT_READ_FAILED` 并移除订阅，不假装仍在跟踪。订阅连接建立后继续发 command 属协议违约，Runtime 直接关闭连接。
- **订阅是只读的**：不写事件、不写 `event_deliveries`、不重放 command、不改变 Task/Execution 状态。因此订阅不构成「已交付」证据，投递语义仍由 outbox 与消费者幂等决定。
- 可选 `projectId` 过滤只影响交付不影响游标前进；ADR-0061/v34 起，Project 过滤交付「该 Project 的事件 + `project_id IS NULL` 的 Runtime 全局事件」，因为全局容量与全局暂停会影响每个 Project。Phase 1 没有按 project 的权限隔离——本地单用户 socket 权限（0600）就是这一层的边界。
- ADR-0067 起本地 Web UI / HTTP / SSE 入口暂停，Runtime 不实例化 `RuntimeHttpApi`；源码静态保留，不属于当前启用的传输面。

## 4. 终端接管传输与安全

原始 PTY 帧（`takeoverId`、`sessionId`、`streamSequence`、`timestamp`、`bytes`）走独立有界双工流，支持 input/output/resize、背压、writer lease 与截断指示；首版只在 Runtime 内存保留有界重连缓冲，不持久化原始 PTY 日志。过旧 cursor 明确返回 `TERMINAL_CURSOR_EXPIRED`。帧表、resize 合约与安全点规则见 [`terminal-and-handoff.md`](./terminal-and-handoff.md)。

输出与用户按键可能含 secrets、控制序列与 prompt injection；**不能作为受信 command、状态 guard、safe-point 证据或权限批准**。结构化状态只来自 Adapter / 受控 gate side channel。PTY bytes 不进 domain event、Intent、TaskRevision 或普通事件流；事件只记录 attachment/lease/handoff 元数据。CLI attach 使用 versioned terminal frame 协议而非一次性 JSON response，并以本地 escape prefix 发送 detach/release 控制动作；同一动作也必须有普通 Runtime command，不能只存在于按键。客户端断开等同 detach，不停止 `HUMAN_TUI` Session。

### 4.1 只读会话过程视图（ADR-0013）

第三条只读通道：`session.transcript` / `session.transcript.part` 直接读取 **Provider 自己的持久会话文件**（`agent_sessions.session_storage_ref`，位于 Runtime 的 `--session-dir` 下），展示工具调用与返回、助手文本、thinking 与 token/成本。

- 它不是 domain event、不是 outbox 投递、不是 attach：不写事件、不写 `event_deliveries`、不改变任何 Task/Execution/Session 状态，不从文件重建业务状态，因此不提供任何「已交付」证据。
- 它是查询而非事实：内容不写入 SQLite；进程重启后仍可读，因为它读的是 provider 的文件。
- 文件路径是 Runtime 内部信息：响应不携带路径，只允许读取 Runtime 自己 session 目录内、经 `realpath` 规范后的普通文件（符号链接逃逸被拒绝）。默认 4000 字符预览，完整块需显式取回，单块硬上限 200000 字符。
- 游标是 provider 自己的 entry ID，排他；不存在该 entry 时返回 `TRANSCRIPT_CURSOR_UNKNOWN`，不静默夹到尾部。

## 5. 测试要求

事务回滚无事实事件；重复命令返回相同结果；相同键异文拒绝；旧事件不复活终态；重连无漏消息；消费者重复投递不重复启动；进程启动后、DB 回写前崩溃可核对恢复。

ADR-0035 追加的三条：**同一 command 重放不产生第二个事件**（包括拒绝事实：`TakeoverFailed` 的 event id 由 command + stage + reason 推导）；**事件与它描述的状态变更同事务提交**；**旧设计名的历史行仍可读且未被改写**。
