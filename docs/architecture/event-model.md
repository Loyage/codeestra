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

## 4. 终端与安全

原始 PTY 帧：sessionId、streamSequence、timestamp、bytes，走独立有界流/日志存储，支持背压和截断指示。输出可能含 secrets、控制序列和 prompt injection；不能作为受信命令、状态 guard 或权限批准。终端日志默认不进入业务事件 payload。

## 5. 测试要求

事务回滚无事实事件；重复命令相同返回；相同键异文拒绝；旧事件不复活终态；UI 重连无漏消息；消费者重复投递不重复启动；进程启动后 DB 回写前崩溃可核对恢复。
