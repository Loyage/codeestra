# 内部 Event Model

## 1. 边界与信封

UI 发 command（期望行为），Runtime 写 domain event（已发生事实）；Adapter event（外部观察）先经身份、顺序、状态校验，再转换为领域事实。数据库是权威状态，事件支持审计和订阅，不以终端日志重建业务状态。

```ts
type EventEnvelope<T extends string, P> = {
  eventId: string;
  sequence: number;                 // SQLite 分配，本 Runtime 数据库内有序
  eventType: T;
  schemaVersion: number;
  projectId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: number;
  correlationId: string;            // 一次用户意图/工作链
  causationId: string | null;       // 导致此事实的 command/event
  payload: P;
};
type CommandEnvelope<T extends string, P> = {
  commandId: string;
  type: T;
  projectId: string;
  expectedVersion?: number;         // 修改聚合时必填，创建时例外
  actor: string;                    // 从受信入口赋值，不相信任意外部声明
  payload: P;
};
```

跨进程输入使用 Zod discriminated union；未知 schemaVersion 返回明确错误，不宽松吞掉新字段语义。

## 2. 事件目录（核心字段）

| Event | payload |
|---|---|
| IntentRecorded / IntentClarificationRequested | intentId, kind / ambiguity |
| TaskCreated | taskId, revisionId, kind |
| TaskRevisionAppended | taskId, previousRevisionId, revisionId, affectedExecutionId |
| TaskStateChanged | taskId, from, to, reason |
| TaskPriorityChanged | taskId, oldPriority, newPriority |
| DependencyAdded / DependencyNeedsReview | dependentId, prerequisiteId, requiredRevisionId |
| ImpactAssessed / ConflictAssessed | assessmentId, revision/base references, verdict/reasons |
| ExecutionReserved | executionId, taskId, revisionId, workspaceId |
| ExecutionStateChanged | executionId, from, to, reason |
| WorkspacePrepared | workspaceId, branch, baseCommit |
| AgentSessionStarted | executionId, sessionId, adapterId, providerSessionId, processIdentity |
| AgentSessionStateChanged | sessionId, from, to, reason |
| AgentSessionCompleted | executionId, sessionId, outcome, evidenceRef |
| SessionGuidanceRecorded / SessionGuidanceDelivered | executionId, sessionId, guidanceId, contentHash, length, behavior / providerEntryRef；正文不进事件 |
| TakeoverRequested / TakeoverSafePointReached | takeoverId, executionId, sourceSessionId, targetMode / evidenceRef, lastEntryRef |
| SessionHandoffStarted / SessionHandoffCompleted | takeoverId, sourceSessionId, targetSessionId, fromMode, toMode, processEvidenceRef |
| TerminalWriterLeaseChanged | takeoverId, sessionId, attachmentId, action；不含 PTY bytes |
| TakeoverReleased / TakeoverFailed | takeoverId, executionId, activeSessionId, reason/evidenceRef |
| ExecutionPauseRequested / ExecutionPaused | executionId, reason, evidenceRef（已暂停事件必填） |
| RevisionDelivered / RevisionAcknowledged | executionId, revisionId, deliveryKey, evidenceRef |
| UserAttentionRequested | attentionId, sessionId, kind, responseType（敏感提示另存） |
| UserAnswerRecorded / UserAnswerDelivered | attentionId, answerId；不默认广播敏感回答正文 |
| ResultCommitAuthorizationRequested | executionId, revisionId, expectedHead, changeFingerprint；差异内容另按安全策略查询 |
| ResultCommitAuthorized / ResultCommitAuthorizationInvalidated | authorizationId, executionId, revisionId, expectedHead, changeFingerprint, actor / reason |
| ExecutionResultCaptured | executionId, appliedRevisionId, resultCommit, authorizationId |
| ExecutionFailed / ExecutionCancelled / ExecutionSuperseded | executionId, reason, stopEvidenceRef |
| RecoveryRequired | resourceType, resourceId, reason |
| VerificationCompleted / VerificationInvalidated | verificationId, scope, testedCommit, revisionId/batchId, result/reason |

Phase 1（ADR-0006）实际写入：`VerificationCompleted` 的 aggregate 为 `VerificationRun`，payload 携带 verificationId、taskId、executionId、revisionId、testedCommit、testedTree、policyVersion、policyDigest、mainCommit、state、outcomeCode 与非敏感 evidence；不写入命令原始输出。`VerificationInvalidated` 的 aggregate 为 `Task`，payload 携带 taskId、reason、verificationIds、testedCommit 与 policyDigest，旧 run 记录只追加 stale 原因，不重写历史。
| DevIntegrationCandidateCreated | batchId, expectedDevCommit, candidateCommit, itemIds |
| DevIntegrationCompleted | batchId, previousDevCommit, integratedCommit, verificationRunId |
| StablePromotionApproved / StablePromotionApprovalInvalidated | approvalId, promotionId, devCommit, expectedMainCommit, verificationRunId |
| MainPromoted | promotionId, previousMainCommit, promotedCommit, approvalId |
| RuntimeRestartedAfterMainUpdate / RuntimeRestartFailed | promotionId, mainCommit, evidenceRef |
| CandidateBuilt / SelfTestCompleted | candidateId, artifactHash, evidenceRef |
| StablePromotionRequested / StablePromoted / StableRollbackCompleted | promotionId, oldVersion, newVersion, evidenceRef |

命名 SUCCEEDED 的 Agent 回调只产生执行事实，不能直接产生 Task integrated 事实。

### 2.1 实现中实际写入的事件（以代码为准）

上一节是设计目录；本节是 `packages/storage/src/database.ts` 与 `apps/runtime/src/**` **当前真正写入 `domain_events` 的事件名**。两者不是一一对应：有的设计名在实现里换了名字，有的设计事件尚未实现。差异在第 2.2 节单列，本文不把实现名静默回写成设计名。

**长命令进度（ADR-0019 / ADR-0027）**

| Event | aggregate | 关键 payload |
|---|---|---|
| `OperationProgressed` | `Operation` | operationId, projectId, taskId, kind, `progressSequence`（每 Operation 单调）, `dedupKey`, `phase`（`STEP`/`OUTPUT`/`CANCEL`/`SETTLED`）, 可选 stepKey/step/stepState/stepSequence, detail, `verdict: false` |
| `OperationSettled` | `Operation` | operationId, projectId, taskId, kind, progressSequence, `dedupKey='SETTLED'`, phase=`SETTLED`, `operationState`, detail, `verdict: false` |

`OperationSettled` 只声明「这条长命令结束了」，**不是判定**：`verdict:false` 永远如此。只对已发布过进度的 Operation 发布（workspace prepare、Agent start、result commit 等从不进进度流的操作不会凭空开一条流）。`OperationSettled` 的 `eventId` 由 Operation 推导（`sha256('OperationSettled:'+operationId)`），重试的终态写入只能发布同一个事实。

**Verification（ADR-0006 / ADR-0027）**

| Event | aggregate | 关键 payload |
|---|---|---|
| `VerificationCompleted` | `VerificationRun` | verificationId, taskId, executionId, revisionId, testedCommit, testedTree, policyVersion, policyDigest, mainCommit, `state`, `outcomeCode`, 非敏感 evidence |
| `VerificationInvalidated` | `Task` | taskId, reason, verificationIds, testedCommit, policyDigest |
| `IntegrationVerificationCompleted` | `IntegrationBatch` | 集成验证自身的终态与证据（独立实体 `integration_verification_runs`） |

`CANCELLED` 不新增事件类型：`VerificationCompleted` 的 `state` 可以是 `CANCELLED`，此时 `outcomeCode='CANCELLED_BY_USER'`，且同事务发布对应的 `OperationSettled`（Operation 置 `FAILED`）。schema v17 重建 `verification_runs` 把 `CANCELLED` 加进终态 CHECK，因此「未确认进程组静止」仍写不成终态；`integration_verification_runs` 保留自己的 CHECK（无 `CANCELLED`）。

**修订投递（ADR-0028，schema v19）**

| Event | aggregate | 关键 payload |
|---|---|---|
| `TaskRevisionDeliveryRecorded` | `TaskRevisionDelivery` | deliveryId, taskId, revisionId, executionId, sessionId, incarnationId, `state='PENDING'` |
| `TaskRevisionDeliveryAttempted` | `TaskRevisionDelivery` | deliveryId, taskId, revisionId, attemptNumber, `channel`, executionId, sessionId, incarnationId, `state='IN_FLIGHT'`, `deadlineAt` |
| `TaskRevisionDeliveryResolved` | `TaskRevisionDelivery` | deliveryId, taskId, revisionId, attemptId, `state`, `channel`, evidenceRef, errorCode, detail, `satisfied`；`SUPERSEDED_BY_RESTART` 分支另带 predecessorExecutionId 与 successorExecutionId |

**容量与槽位（ADR-0032，schema v21）**

| Event | aggregate | 关键 payload |
|---|---|---|
| `ExecutionSlotReserved` | `ExecutionSlot` | reservationId, taskId, revisionId, adapterId, workspaceId, holder{bootId,pid,startToken}, capacity |
| `ExecutionSlotWorkspaceBound` | `ExecutionSlot` | reservationId, taskId, workspaceId |
| `ExecutionSlotReleased` | `ExecutionSlot` | reservationId, taskId, `releaseKind`（`EXPLICIT`/`RECONCILED_HOLDER_EXITED`/`RECONCILED_PROCESS_ID_REUSED`）, `observation`, reason |
| `ExecutionSlotReconciled` | `ExecutionSlot` | reservationId, taskId, `decision`, `observation`, previousState, projectedState, detail |
| `SchedulerCapacityChanged` | `SchedulerCapacity` | projectId, `scope`（`GLOBAL`/`ADAPTER`）, adapterId, `from`, `to`, actor |

`SchedulerCapacityChanged` 只在值真正变化时发布（重复设置同一值不 bump 版本、不发事件）。`ExecutionSlotReconciled` 也会为「决定保持占用、状态未变」的观测发布——那是审计事实，不是状态迁移。

**集成与提升（ADR-0018 / ADR-0022）**

| Event | aggregate | 说明 |
|---|---|---|
| `IntegrationBatchCreated` / `IntegrationCompleted` / `IntegrationFailed` / `IntegrationReconcileRequired` | `IntegrationBatch` | 单成员批次从 `CREATED` 到 `INTEGRATED`/`FAILED`/`RECOVERY_REQUIRED` 的实际事实 |
| `PromotionCreated` / `PromotionApproved` / `PromotionStarted` / `PromotionMainUpdated` / `PromotionRestartRecorded` / `PromotionStale` / `PromotionFailed` / `PromotionReconcileRequired` | `Promotion` | `dev → main` 提升的实际事实（固定三元组、观察到的 `main`、重启记账、ref/证据移动后的 `STALE` 与崩溃 reconcile） |

**回收与既有核心事件（实际写入名）**

`ResourcesReclaimed`（`Operation`）、`WorkspaceReclaimed`（`Workspace`）用于 ADR-0021 的回收账本事实。此外实际写入的核心名包括 `IntentRecorded`、`TaskCreated`、`TaskStateChanged`、`TaskRevisionCreated`、`TaskDependencyAdded`、`TaskDependencyRemoved`、`ExecutionReserved`、`ExecutionStateChanged`、`ExecutionFailed`、`WorkspacePrepared`、`AgentSessionStarted`、`AgentSessionStateChanged`、`AgentSessionCompleted`、`UserAttentionRequested`、`UserAnswerRecorded`、`UserAnswerDelivered`、`ResultCommitAuthorized`、`ResultCommitAuthorizationInvalidated`、`ResultCommitCreated`、`RecoveryRequired`（aggregate 可以是 `AgentSession`/`Attention`/`Execution`/`Task`）。

### 2.2 设计名与实现名的差异（交用户裁决，不在本文静默改写）

设计目录里的名字与实现名不一致时，本文**不**把设计目录改成实现名；下列差异已记录在报告中，等待裁决：

| 设计目录（§2） | 实现实际写入 |
|---|---|
| `TaskRevisionAppended` | `TaskRevisionCreated` |
| `DependencyAdded` / `DependencyNeedsReview` | `TaskDependencyAdded` / `TaskDependencyRemoved`（无 `NEEDS_REVIEW`） |
| `RevisionDelivered` / `RevisionAcknowledged` | `TaskRevisionDeliveryRecorded` / `TaskRevisionDeliveryAttempted` / `TaskRevisionDeliveryResolved` |
| `ExecutionResultCaptured` | `ResultCommitCreated` |
| `DevIntegrationCandidateCreated` / `DevIntegrationCompleted` | `IntegrationBatchCreated` / `IntegrationCompleted`（另有 `IntegrationFailed`/`IntegrationReconcileRequired`/`IntegrationVerificationCompleted`） |
| `StablePromotionApproved` / `StablePromotionApprovalInvalidated` / `MainPromoted` / `RuntimeRestartedAfterMainUpdate` / `RuntimeRestartFailed` / `StablePromotionRequested` | `PromotionApproved` / `PromotionCreated` / `PromotionStarted` / `PromotionMainUpdated` / `PromotionRestartRecorded` / `PromotionStale` / `PromotionFailed` / `PromotionReconcileRequired`（没有与 `StablePromotionApprovalInvalidated` 同名的事件） |
| `ImpactAssessed` / `ConflictAssessed` | **未实现为 domain event**：ADR-0031 只把判定写进 `impact_assessments` 行 |
| `TakeoverRequested` / `TakeoverSafePointReached` / `SessionHandoffStarted` / `SessionHandoffCompleted` / `TerminalWriterLeaseChanged` / `TakeoverReleased` / `TakeoverFailed` | **未实现为 domain event**：ADR-0023/0026 的交接与终端状态只写 `session_incarnations` / `session_writer_leases` / `session_handoff_requests` / `session_terminals` / `session_terminal_attachments` 行（唯一例外是 STRICT 权限经既有 `UserAttentionRequested` 进入事件流）。代码中不存在这些事件名 |
| `ExecutionPauseRequested` / `ExecutionPaused` / `ExecutionCancelled` / `ExecutionSuperseded` | 未找到同名事件；暂停/取消的投影通过 `TaskStateChanged`/`ExecutionStateChanged` 与 Operation 状态表达，**未验证**是否存在等价专名 |

`SessionGuidanceRecorded`/`SessionGuidanceDelivered` 与 `TaskRevisionAppended` 中带 `affectedExecutionId` 的语义同样**未在实现中验证**；本轮只按代码里能指认的名字记录。

## 3. 一致性、投递和恢复

1. command 收到后校验身份、payload 与幂等键。相同键不同 payload 拒绝。
2. 在同一 SQLite 事务中检查 version、更新状态、写事件、建立消费者投递记录以及 command receipt。
3. commit 后才通知 UI/执行副作用。外部操作有单独 Operation 记录。
4. 消费者至少一次投递；在自身状态更新事务中标记已消费。对于启动进程、Git ref 更新或回答问题，不能仅靠重试避免重复，需先 reconcile 外部效果。
5. 单数据库 sequence 是排序游标，不是全局分布式时钟。UI 以 snapshot + cursor 开始，再订阅 cursor 之后事件，避免快照与订阅间漏消息。
6. 订阅断开不影响 Runtime；重连带 cursor。游标失效则明确要求重新取快照。
7. 迟到的旧 Session/Execution 事件被审计但不能覆盖新尝试。重复外部事件以 provider event ID 或 adapter 本地持久序号去重；不支持可靠去重的输入需要 reconcile。
8. 不做无限立即重试。退避、次数、最近错误可见；失败投递不能让其他任务全局停机。
9. Phase 1 observation 子集以 `(session_id, provider_event_id)` 去重，并要求同一 Session 的 cursor 唯一；相同 ID/同内容返回既有投影，相同 ID 或 cursor 携带不同内容时 fail-closed。opaque cursor 持久化在 Session，重启后从该 cursor 继续。
10. 当前 durable delivery worker 为消费者补齐 `event_deliveries`，按 sequence 投递并持久化 attempt/退避。它提供至少一次而非恰好一次；消费者必须按 eventId 幂等。

## 3.1 订阅传输（Phase 1 已实现）

Runtime 的本地 socket 同时承载一次性命令与长连接订阅；两者都在同一条连接协议内，不在每次请求后强制关闭的路径上混用。

- 一次性命令：一条连接一个 command，Runtime 回一条 response 后关闭。`events.list` 属于此类，`sinceSequence` 默认 0、`limit` 上限 500，返回 `{ events, cursor, hasMore }`，`cursor` 为下一次读取的排他游标（无事件时等于请求游标）。
- 长连接：`events.subscribe` 建立订阅连接，Runtime 先回一帧 `subscribed`，其中 `cursor` 是快照游标；后续 `event` 帧按 sequence 递增推送，`heartbeat` 帧定期报告当前 cursor，`error` 帧是终止帧（发出后 Runtime 关闭该连接）。客户端 stdout 只承载 `event` 帧的 event envelope，便于脚本消费。
- 省略 `sinceSequence` 表示"从当前尾部开始"，因此客户端应先取快照再订阅，两者之间不漏消息；显式给出 `sinceSequence` 时从该游标之后重放并继续跟随，游标排他，所以重连既不跳过也不重复边界事件。
- 游标超前于日志（例如数据库被替换或客户端记错状态）时返回 `INVALID_CURSOR` 终止帧，不静默夹到尾部：客户端必须重新取快照。
- 订阅只读：不写事件、不写 `event_deliveries`、不重放任何 command，也不改变 Task/Execution 状态；崩溃或断开只影响该订阅，重连凭 cursor 继续。因此订阅不构成"已交付"证据，投递语义仍由 outbox 与消费者幂等决定。
- 读取失败（如日志不可读）是终止性错误：Runtime 发出 `EVENT_READ_FAILED` 终止帧并移除该订阅，不假装仍在跟踪。
- 订阅连接是一条命令一条连接：客户端在订阅建立后继续发送 command 属于协议违约，Runtime 直接关闭该连接。
- 可选 `projectId` 过滤只影响交付；游标仍会前进，因此过滤订阅的 resume 语义与全量订阅一致。Phase 1 未实现按 project 的权限隔离——本地单用户 socket 权限（0600）是这一层的边界。
- 投影由 Runtime 的事件写入路径负责；订阅不引入第二个事件源，也不允许客户端写入事件。
- 本地 Web UI 经 `RuntimeHttpApi` 的 `/api/events` 消费同一组帧（SSE 编码，`fetch` 流式读取而非 `EventSource`，因此 bearer token 不出现在 URL 中）；命令经 `/api/command` 走同一 Zod 请求 schema 与同一 dispatch，HTTP 不是第二条业务语义路径。

## 4. 终端接管传输与安全

原始 PTY 帧：takeoverId、sessionId、streamSequence、timestamp、bytes，走独立有界双工流，支持 input/output/resize、背压、writer lease 与截断指示。首版只在 Runtime 内存保留有界重连缓冲，不持久化原始 PTY 日志；detach 后 Runtime 继续持有 PTY，reattach 从可用缓冲恢复，过旧 cursor 明确返回 `TERMINAL_CURSOR_EXPIRED`。

输出与用户按键可能含 secrets、控制序列和 prompt injection；不能作为受信 command、状态 guard、safe-point 证据或权限批准。结构化状态来自 Adapter/受控 gate side channel。PTY bytes 不进入 domain event、Intent、TaskRevision 或普通事件 SSE；事件只记录 attachment/lease/handoff 元数据。

### 4.1 只读会话过程视图（ADR-0013）

除事件与 PTY transport 之外，还存在第三条只读通道：`session.transcript` / `session.transcript.part` 直接读取 **Provider 自己的持久会话文件**（`agent_sessions.session_storage_ref`，位于 Runtime 的 `--session-dir` 下），用于展示工具调用与返回、助手文本、thinking 与 token/成本。

- 它不是 domain event、不是 outbox 投递、不是 attach：不写事件、不写 `event_deliveries`、不改变任何 Task/Execution/Session 状态，也不从文件重建业务状态；因此它不提供任何“已交付”证据。
- 它是查询而非事实：内容不写入 SQLite，进程重启后仍然可读（因为它读的是 provider 的文件而不是 Codeestra 的投影）。
- 它与 §4 的边界不冲突：原始终端数据仍只存在于 provider 文件中，Codeestra 只做有界的只读展示（默认 4000 字符预览，完整块需显式取回，单块硬上限 200000 字符），不把 PTY 字节、工具参数或输出写进事件。
- 文件路径是 Runtime 内部信息：命令响应不携带路径，只允许读取 Runtime 自己 session 目录内、经 `realpath` 规范后的普通文件（符号链接逃逸被拒绝）。
- 游标是 provider 自己的 entry ID，排他；文件中不存在该 entry 时返回 `TRANSCRIPT_CURSOR_UNKNOWN`，不静默夹到尾部。

CLI attach 使用 versioned terminal frame 协议而非一次性 JSON response，并以本地 escape prefix 发送 detach/release 控制动作；同一动作也必须有普通 Runtime command，不能只存在于按键。Web UI/桌面如提供终端，只能复用该 transport，不直接连接 Provider PTY。客户端断开等同 detach，不停止 HUMAN_TUI Session。

## 5. 测试要求

事务回滚无事实事件；重复命令相同返回；相同键异文拒绝；旧事件不复活终态；UI 重连无漏消息；消费者重复投递不重复启动；进程启动后 DB 回写前崩溃可核对恢复。
