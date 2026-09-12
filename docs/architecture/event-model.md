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
| WorkspacePrepared | workspaceId, branch, baseCommit |
| AgentSessionStarted | executionId, sessionId, adapterId |
| ExecutionPauseRequested / ExecutionPaused | executionId, reason, evidenceRef（已暂停事件必填） |
| RevisionDelivered / RevisionAcknowledged | executionId, revisionId, deliveryKey, evidenceRef |
| UserAttentionRequested | attentionId, sessionId, kind（敏感提示另存） |
| UserAnswerRecorded / UserAnswerDelivered | attentionId, answerId；不默认广播敏感回答正文 |
| ExecutionResultCaptured | executionId, appliedRevisionId, resultCommit |
| ExecutionFailed / ExecutionCancelled / ExecutionSuperseded | executionId, reason, stopEvidenceRef |
| RecoveryRequired | resourceType, resourceId, reason |
| VerificationCompleted / VerificationInvalidated | verificationId, scope, testedCommit, revisionId/batchId, result/reason |
| IntegrationCandidateCreated | batchId, expectedMainCommit, candidateCommit, itemIds |
| IntegrationApproved / IntegrationApprovalInvalidated | approvalId, batchId, candidateCommit, expectedMainCommit |
| IntegrationPromoted | batchId, previousMainCommit, promotedCommit, approvalId |
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

## 4. 终端与安全

原始 PTY 帧：sessionId、streamSequence、timestamp、bytes，走独立有界流/日志存储，支持背压和截断指示。输出可能含 secrets、控制序列和 prompt injection；不能作为受信命令、状态 guard 或权限批准。终端日志默认不进入业务事件 payload。

## 5. 测试要求

事务回滚无事实事件；重复命令相同返回；相同键异文拒绝；旧事件不复活终态；UI 重连无漏消息；消费者重复投递不重复启动；进程启动后 DB 回写前崩溃可核对恢复。
