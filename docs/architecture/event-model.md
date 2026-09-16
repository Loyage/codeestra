# 内部 Event Model

## 1. 边界与信封

UI 发 command（期望行为），Runtime 写 domain event（已发生事实）；Adapter event（外部观察）先经身份、顺序、状态校验，再转换为领域事实。数据库是权威状态，事件支持审计和订阅，不以终端日志重建业务状态。

```ts
type EventEnvelope<T extends string, P> = {
  eventId: string;
  sequence: number;                 // SQLite 分配，本 Runtime 数据库内有序
  eventType: T;
  schemaVersion: number;
  projectId: string | null;          // 当前实现非空；ADR-0061/v34 计划允许 null 表示 Runtime 全局事实
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
  projectId: string | null;          // ADR-0061 的 scheduler global commands 为 null；当前实现仍要求项目命令非空
  expectedVersion?: number;         // 修改聚合时必填，创建时例外
  actor: string;                    // 从受信入口赋值，不相信任意外部声明
  payload: P;
};
```

跨进程输入使用 Zod discriminated union；未知 schemaVersion 返回明确错误，不宽松吞掉新字段语义。

## 2. 事件目录（以实现实际写入的名字为准）

本节是 `packages/storage/src/database.ts` 与 `apps/runtime/src/**` **真正写入 `domain_events` 的事件名与 payload**（ADR-0035 裁决后，目录以实现名为准）。设计名与实现名不一致的历史差异在第 2.3 节单列并标注废弃原因，不静默改写。

**核心生命周期（实际写入名）**

| Event | aggregate | payload 要点 |
|---|---|---|
| `IntentRecorded` | `Intent` | intentId, kind |
| `TaskCreated` | `Task` | taskId, revisionId, displayTitle, namingTitle, **features** |
| `TaskStateChanged` | `Task` | taskId, from, to, reason |
| `TaskArchived` / `TaskUnarchived` | `Task` | taskId, from, to（同态，只改 `archived_at`）, reason, actor |
| `TaskPurged` | `Task` | taskId, displayNumber, from, to=`PURGED`（**不是一个状态**：行已删除，见下）, archived, currentRevisionId, rowsDeleted（逐表行数）, dependencyEdgesRemoved, branchFacts（每个被删分支的 `branchRef`/`tipCommit`/`deleted`）, reclamation（每个被回收资源）, **forced（`--force` 时非 null：`bypassed[]` 被跳过的拒绝码与理由、`termination` 终止记录；ADR-0058 D09）**, appendOnlyTriggersSuspended, reason, actor |
| `TaskRevisionCreated` | `Task` | taskId, revisionId, revisionNumber, previousRevisionId（首个修订为 null）, **features**（声明的功能，ADR-0059）, reason, actor（**设计名 `TaskRevisionAppended` 已废弃**；`constraintCount` 已随 ADR-0065 删除） |
| `TaskDependencyAdded` / `TaskDependencyRemoved` | `Task` | dependentId, prerequisiteId, requiredRevisionId（**设计名 `DependencyAdded`/`DependencyNeedsReview` 已废弃**） |
| `ExecutionReserved` | `Execution` | executionId, taskId, revisionId, workspaceId |
| `ExecutionStateChanged` | `Execution` | executionId, from, to, reason |
| `ExecutionFailed` | `Execution` | executionId, reason, stopEvidenceRef |
| `WorkspacePrepared` | `Workspace` | workspaceId, taskId, branch, baseCommit（ADR-0042 重建时同事件另带 `reattachedBranch: true`、`previousState: 'RELEASED'`、`rebuild: {outcome, reasonCode, detail, headCommit}`；事件名不变） |
| `AgentSessionStarted` | `AgentSession` | executionId, sessionId, adapterId, providerSessionId（provider 进程身份留在 session 行/incarnation 行，不在事件 payload 里） |
| `AgentSessionStateChanged` | `AgentSession` | sessionId, from, to |
| `AgentSessionCompleted` | `AgentSession` | executionId, sessionId, outcome, evidenceRef, 可选 `note`（FOUNDATION-056 的散文提问判据，随 append-only 完成事实一起落库） |
| `UserAttentionRequested` | `Attention` | attentionId, sessionId, kind, responseType（敏感提示另存） |
| `UserAnswerRecorded` / `UserAnswerDelivered` | `Attention` | attentionId, answerId；不广播敏感回答正文 |
| `ResultCommitAuthorized` / `ResultCommitAuthorizationInvalidated` | `Execution` | authorizationId, executionId, revisionId, expectedHead, changeFingerprint, actor / reason |
| `ResultCommitCreated` | `Execution` | authorizationId, executionId, revisionId, baseCommit, resultCommit, resultTree, identity, hookOutcome（**设计名 `ExecutionResultCaptured` 已废弃**） |
| `RecoveryRequired` | `Execution` \| `Attention` \| `AgentSession` \| `Task` | `resourceType` + `resourceId` + `reason`（`Execution`/`Attention`/`AgentSession` 变体）；`Task` 变体是 taskId + from/to + reason + 可选 evidenceRef（投影到 `RECOVERY_REQUIRED`） |
| `TaskRecoveryReconciled` | `Task` | `taskId`、`executionId`、`sessionId`、`workspaceId`、`workspacePath`、`providerPid`、`processState`（`STOPPED`/`ALIVE`/`DESCENDANTS_ALIVE`/`UNVERIFIABLE`/`IDENTITY_MISSING`）、`descendantRecord`（`RECORDED`/`MISSING`）、`descendantCount`、`workspacePresent`、`quiescenceProven`（恒为 `false`）、`signalsSent`（恒为 `0`）、`evidenceRef`、`reason`（可为 `null`）、`actor`（ADR-0055）。它只在**收口**时发布（`Execution`/`Task` 置 `FAILED`、Session `EXITED`、workspace `RETAINED` 的同一事务里），是三个状态投影的 causation 起点；**拒绝路径不写事件**（无状态变化） |
| `VerificationCompleted` | `VerificationRun` | verificationId, taskId, executionId, revisionId, testedCommit, testedTree, policyVersion, policyDigest, mainCommit, `state`, `outcomeCode`, 非敏感 evidence |
| `VerificationInvalidated` | `Task` | taskId, reason, verificationIds, testedCommit, policyDigest |

Phase 1（ADR-0006）的 `VerificationCompleted` 不写入命令原始输出；`VerificationInvalidated` 只追加 stale 原因，不重写历史 run。命名 SUCCEEDED 的 Agent 回调只产生执行事实，不能直接产生 Task integrated 事实。

### 2.1 各领域的补充事实（实际写入名）

**长命令进度（ADR-0019 / ADR-0027）**

| Event | aggregate | 关键 payload |
|---|---|---|
| `OperationProgressed` | `Operation` | operationId, projectId, taskId, kind, `progressSequence`（每 Operation 单调）, `dedupKey`, `phase`（`STEP`/`OUTPUT`/`CANCEL`/`SETTLED`）, 可选 stepKey/step/stepState/stepSequence, detail, `verdict: false` |
| `OperationSettled` | `Operation` | operationId, projectId, taskId, kind, progressSequence, `dedupKey='SETTLED'`, phase=`SETTLED`, `operationState`, detail, `verdict: false` |

`OperationSettled` 只声明「这条长命令结束了」，**不是判定**：`verdict:false` 永远如此。只对已发布过进度的 Operation 发布（workspace prepare、Agent start、result commit 等从不进进度流的操作不会凭空开一条流）。`OperationSettled` 的 `eventId` 由 Operation 推导（`sha256('OperationSettled:'+operationId)`），重试的终态写入只能发布同一个事实。

**验证（ADR-0006 / ADR-0027）**

| Event | aggregate | 关键 payload |
|---|---|---|
| `VerificationCompleted` | `VerificationRun` | 见 §2 主表；`CANCELLED` 是它的一个 `state`，此时 `outcomeCode='CANCELLED_BY_USER'` |
| `VerificationInvalidated` | `Task` | 见 §2 主表 |
| `IntegrationVerificationCompleted` | `IntegrationBatch` | 集成验证自身的终态与证据（独立实体 `integration_verification_runs`） |

`CANCELLED` 不新增事件类型，且同事务发布对应的 `OperationSettled`（Operation 置 `FAILED`）。schema v17 重建 `verification_runs` 把 `CANCELLED` 加进终态 CHECK，因此「未确认进程组静止」仍写不成终态；`integration_verification_runs` 保留自己的 CHECK（无 `CANCELLED`）。

**修订投递（ADR-0028，schema v19）**

| Event | aggregate | 关键 payload |
|---|---|---|
| `TaskRevisionDeliveryRecorded` | `TaskRevisionDelivery` | deliveryId, taskId, revisionId, executionId, sessionId, incarnationId, `state='PENDING'` |
| `TaskRevisionDeliveryAttempted` | `TaskRevisionDelivery` | deliveryId, taskId, revisionId, attemptNumber, `channel`, executionId, sessionId, incarnationId, `state='IN_FLIGHT'`, `deadlineAt` |
| `TaskRevisionDeliveryResolved` | `TaskRevisionDelivery` | deliveryId, taskId, revisionId, attemptId, `state`, `channel`, evidenceRef, errorCode, detail, `satisfied`；`SUPERSEDED_BY_RESTART` 分支另带 predecessorExecutionId 与 successorExecutionId |

**容量与调度（当前实现：ADR-0032 / ADR-0033，schema v21；目标修订：ADR-0061）**

| Event | aggregate | 关键 payload |
|---|---|---|
| `ExecutionSlotReserved` | `ExecutionSlot` | reservationId, taskId, revisionId, adapterId, workspaceId, holder{bootId,pid,startToken}, capacity |
| `ExecutionSlotWorkspaceBound` | `ExecutionSlot` | reservationId, taskId, workspaceId |
| `ExecutionSlotReleased` | `ExecutionSlot` | reservationId, taskId, `releaseKind`（`EXPLICIT`/`RECONCILED_HOLDER_EXITED`/`RECONCILED_PROCESS_ID_REUSED`）, `observation`, reason |
| `ExecutionSlotReconciled` | `ExecutionSlot` | reservationId, taskId, `decision`, `observation`, previousState, projectedState, detail |
| `SchedulerCapacityChanged` | `SchedulerCapacity` | projectId, `scope`（`GLOBAL`/`ADAPTER`）, adapterId, `from`, `to`, actor |
| `TaskScheduleDecided` | `TaskSchedule` | taskId, revisionId, `verdict`, activeTaskIds, candidateSnapshotId… |
| `TaskWaitingForConflict` / `TaskWaitingForCapacity` | `TaskSchedule` | taskId, 稳定等待码（`IMPORTANT_DIRECTORY_OVERLAP` 等 / `CAPACITY_GLOBAL_LIMIT_REACHED` 等）, blocking |
| `TaskUnknownCleared` | `TaskSchedule` | taskId, revisionId, analyzerVersion/policyVersion/baseCommit 绑定 |
| `TaskImpactPredictionRevoked` | `TaskSchedule` | taskId, added/removed 改动集, conflicts, reasons, pauseRequested |

`SchedulerCapacityChanged` 只在值真正变化时发布（重复设置同一值不 bump 版本、不发事件）。`ExecutionSlotReconciled` 也会为「决定保持占用、状态未变」的观测发布——那是审计事实，不是状态迁移。`TaskSchedule*` 的重放保护是 `(event_type, correlation_id, aggregate_id)`，不是 event id。

`SchedulerCapacityChanged` 与 `CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` **不再产生新事实**（历史行原样保留）：ADR-0061 之后只有一个 Runtime 全局上限，写它的事实是 `SchedulerGlobalCapacityChanged`（FOUNDATION-096，schema v34）。同一版本里实现的暂停半边写另外五个事件（FOUNDATION-097）。它们均以 `project_id = NULL`、`aggregate_type='RuntimeSchedulerControl'` 写入；`domain_events.project_id` 已可空，Project 过滤订阅同时收到全局事件。

全局事实以 `project_id = NULL`、`aggregate_type='RuntimeSchedulerControl'` 写入；这是为“不属于任何 Project”保留的表达，而不是“未知 Project”。Project 过滤读取改为 `(project_id = ? OR project_id IS NULL)`，游标仍按同一 sequence 前进。

| Event | 状态 | 关键 payload |
|---|---|---|
| `SchedulerGlobalCapacityChanged` | **已实现（FOUNDATION-096，schema v34）** | from, to, source（DEFAULT/EXPLICIT/MIGRATED_MINIMUM）, actor |
| `SchedulerGlobalPauseRequested` | ADR-0061 设计名，**尚未实现** | pauseEpoch, actor, targets[]（只含 identity/归属元数据，不含输出） |
| `SchedulerGlobalPaused` | 尚未实现 | pauseEpoch, settledAt, targets[] 的 stopped/exited 事实 |
| `SchedulerGlobalResumeRequested` | 尚未实现 | pauseEpoch, actor, targetCount |
| `SchedulerGlobalResumed` | 尚未实现 | pauseEpoch, settledAt, resumed/exited 事实 |
| `SchedulerGlobalControlRecoveryRequired` | 尚未实现 | pauseEpoch, stage（PAUSE/RESUME/STARTUP_RECONCILE）, reasonCode, target observations |

`PauseRequested` 不等于 `Paused`，`ResumeRequested` 不等于 `Resumed`；部分结果只能写 `...RecoveryRequired`，不能用完成事件粉饰。全局控制的 command receipt 进入独立 `runtime_command_receipts`，因为命令不属于任何 Project。

**集成与提升（ADR-0018 / ADR-0053 / ADR-0022）**

| Event | aggregate | 说明 |
|---|---|---|
| `IntegrationBatchCreated` | `IntegrationBatch` | 批次组成：`members[]`（每个成员的 taskId/revisionId/executionId/candidateCommit）、`devRef`/`devCommit`、actor。多成员批次的成员清单即来自这条载荷与 `integration_batch_items` |
| `IntegrationMemberMerged` | `IntegrationBatch` | **每个成员**的合并事实：taskId、revisionId、candidateCommit、`mergeStrategy`、该步产生的 `mergedCommit`。部分失败时「哪一步真的发生了」由这一串事件与成员状态共同表达 |
| `IntegrationCompleted` | `IntegrationBatch` | 全部成员进入 `dev`：`integratedCommit`、批次级 `mergeStrategy`、`verificationId`、`members[]`（每个成员的 taskId/executionId/revisionId/candidateCommit） |
| `IntegrationFailed` | `IntegrationBatch` | 合并/验证失败：`state`（`CONFLICTED`/`FAILED`）、`outcomeCode`、`detail`、`failedTaskId`（批次级失败时为 null）、`members[]`（含各自 state，成员级部分成功在此如实可读） |
| `IntegrationBatchStale` | `IntegrationBatch` | 批级 `STALE`：`outcomeCode`（`MEMBER_EVIDENCE_MOVED`/`DEV_REF_MOVED`）、reason、previousState、成员 state。**不合并、不推进 `dev`** |
| `IntegrationBatchCancelled` | `IntegrationBatch` | 批级 `CANCELLED`（`outcomeCode='CANCELLED_BY_USER'`）：记录可证明无副作用时才发布 |
| `IntegrationReconcileRequired` | `IntegrationBatch` | 重启中断或取消无法确认无副作用 → `RECOVERY_REQUIRED`（`RECONCILE_REQUIRED`/`DEV_REF_OBSERVED`），`members[]` 带各自 state，占用保留 |
| `PromotionCreated` / `PromotionApproved` / `PromotionDevPushed` / `PromotionPushRefused` / `PromotionMainUpdated` / `PromotionRestartRecorded` / `PromotionMainPushRefused` / `PromotionCompleted` / `PromotionStale` / `PromotionFailed` / `PromotionReconcileRequired` | `Promotion` | `dev → main` 提升的实际事实（固定三元组、push 到远端 `dev` 与**读回值**、观察到的 `main`、重启记账、推回远端 `main` 的尝试与结果、ref/证据移动后的 `STALE` 与崩溃 reconcile）。ADR-0047/0052 后本机 ff 路径已删除，因此 `PromotionStarted` 不再产生 |

**回收（ADR-0021）**

`ResourcesReclaimed`（`Operation`）、`WorkspaceReclaimed`（`Workspace`）用于 ADR-0021 的回收账本事实。

ADR-0042（从 reclaim 保留的 task branch 重建 owned worktree）**不新增事件名**：重建复用同一 workspace 行
（`RELEASED → READY`）并在同一事务里写 `WorkspacePrepared`，`payload.rebuild.outcome` 区分 `REBUILT` 与
`ADOPTED`。`TaskRetryRequested.workspaceMode` 增加 `REBUILD_OWNED`（既有字段的新取值，不是新事件）。

**交接与原生终端（ADR-0023 / ADR-0026 / ADR-0035，本格新增）**

| Event | aggregate | 关键 payload |
|---|---|---|
| `TakeoverRequested` | `SessionHandoff` | takeoverId, sessionId, executionId, incarnationId, `kind`（`TAKEOVER`/`RETURN`）, `targetMode` |
| `TakeoverSafePointReached` | `SessionHandoff` | takeoverId, sessionId, executionId, incarnationId, `reachedFrom`（`RPC_FENCE`/`TERMINAL_RELEASE`）, `fenceAcknowledged`, `settledAfterFenceAt`, `activeTools`, `evidenceRef`, `lastEntryRef`, **`missing`** |
| `SessionHandoffStarted` | `SessionHandoff` | takeoverId, sourceSessionId, targetSessionId, sourceIncarnationId, fromMode, toMode, predecessorObservation, processEvidenceRef |
| `SessionHandoffCompleted` | `SessionHandoff` | takeoverId, source/targetSessionId, sourceIncarnationId, successorIncarnationId, successorIncarnationNumber, fromMode, toMode, terminalTransport, terminalId, providerPid, processEvidenceRef |
| `TakeoverReleased` | `SessionHandoff` | takeoverId, sessionId, executionId, incarnationId, terminalId, reason, predecessorObservation, evidenceRef, `sessionFile{…,predecessorEntrySurvived,truncated}` |
| `TakeoverFailed` | `SessionHandoff`（无 takeover 时以 `sessionId` 为 aggregate id） | takeoverId（可空）, sessionId, executionId, incarnationId（可空）, `stage`（`REQUEST`/`SAFE_POINT`/`ADMIT`/`RELEASE`）, **`reason`（稳定码）**, detail, evidenceRef |
| `TerminalWriterLeaseChanged` | `SessionWriterLease` | takeoverId（可空）, sessionId, leaseId, `action`（`ACQUIRED`/`RELEASED`）, `before`/`after`（`{incarnationId,holderKind,holderRef}` 或 null）, reason |

这七个事件的事实边界：

- `TakeoverRequested`、`SessionHandoffStarted` 都**不是**「已交接」。前者只说明意图与 fence 被记录，后者只说明 predecessor 不再是 writer、successor 尚未启动。只有 `SessionHandoffCompleted` 表示 successor 进程真的启动、记录并持有单 writer lease。
- `TakeoverReleased` 只在发布（provider 退出、记录的进程树无存活者、provider session file 仍保有 predecessor 的 entry）**被证明**时写入；证明不了的发布是 `TakeoverFailed`。
- `TakeoverSafePointReached` 的 `missing` 是事实的一部分：安全点经 RPC fence 达成时为空，经终端发布达成时由 `reachedFrom` 与 `sessionFile` 事实表达，绝不假装 fence 被 ack。
- 这七个事件与它们描述的状态变更在**同一 SQLite 事务**内提交（`TakeoverFailed` 除外——拒绝本身没有状态变更，它自己就是那条事实，事件 id 由 command + stage + reason 推导，故同一命令重放不产生第二条）。
- 单一 writer lease 的每一次更换都写 `TerminalWriterLeaseChanged`（acquire 与 release 各一条），因此「谁在写这个 conversation」可从日志复原，而不是只能从当前行推断。

**会话指导（ADR-0057，schema v31）**

| Event | aggregate | 关键 payload |
|---|---|---|
| `SessionGuidanceRecorded` | `SessionGuidance` | guidanceId, taskId, `source='COMMAND'`, executionId, sessionId, incarnationId, `bodyHash`, `bodyBytes`, actor, `attemptId`（当时有 Execution 持有 Task 时为那个 attempt，否则 null） |
| `SessionGuidanceDelivered` | `SessionGuidance` | guidanceId, attemptId, `channel='PROVIDER_CONVERSATION'`, **`state`**（`DELIVERED`/`CHANNEL_UNSUPPORTED`/`TIMED_OUT`/`FAILED`）, capability, evidenceRef, errorCode, detail, executionId, sessionId, incarnationId, **`delivered`**（仅 `state='DELIVERED'` 时为 true） |

这两个事件的事实边界与 revision 投递**不同**，必须分清：

- `SessionGuidanceRecorded` 只说「这条指导已经耐久记录、并会在下一次 Execution 启动时交给 provider」，**不是**「已经投递」。
- `SessionGuidanceDelivered` 是「一次尝试的结论」，**不是**「已经交付」的同义词：`DELIVERED` 只意味 provider 自己的通道**接受了这条消息（入队）**，
  `CHANNEL_UNSUPPORTED`/`TIMED_OUT`/`FAILED` 是拒绝或未完成，必须带稳定 `state`/`errorCode` 读成拒绝。
- **没有任何事件或列表达「模型已读/已生效」**：ADR-0051 实测三个 provider 都没有可核验通道，因此该事实在实现里不存在（命令面以
  `modelAcknowledgement: 'UNSUPPORTED'` 显式说出口）。正文只在 `session_guidance.body` 里（ADR-0010 D02），**不进事件**（ADR-0010 D06），
  事件只带 hash 与长度。
- 两者都与它们描述的状态变更在同一 SQLite 事务内提交；guidance 不写 `task_revisions`、不动 `tasks.current_revision_id`、
  不写 `VerificationInvalidated`（那是 `task amend` 的路径）。

**显式重试与散文提问解除（Wave H / Wave I，本格补齐登记）**

这两个事件本体分别由 FOUNDATION-061（ADR-0036）与 FOUNDATION-069（ADR-0043）实现，但一直只在正文里被引用、未进事件目录；
FOUNDATION-074 的 doc-sync 把它们补齐（名字都是实现先行的，按 §2.2 规则永不重命名）。

| Event | aggregate | 关键 payload |
|---|---|---|
| `TaskRetryRequested` | `Task` | taskId, `from='FAILED'`, `to`（`READY`/`BLOCKED`）, failedExecutionId, failedAttemptNumber, adapterId, previousAdapterId, `adapterChanged`, `workspaceMode`（`REUSE_OWNED`/`REBUILD_OWNED`/`NEW_WORKSPACE` 等）, workspaceId, workspaceEvidence, `dependencies`, actor |
| `ProseQuestionAttentionResolved` | `Attention` | attentionId, `resolution`（`DISMISSED`/`ANSWERED`）, answerText, note, actor, `attentionStatus='CLOSED'`, `deliveredToProvider: false`, reason |

- `TaskRetryRequested` 是重试**自己的**审计记录，与它引起的 `TaskStateChanged` 分开追加：它回答「谁在哪个 Agent 上、用哪种
  workspace 处置重试了哪次失败」。同一命令重放不产生第二条。
- `ProseQuestionAttentionResolved` 与它引起的 `TaskStateChanged`（`WAITING_FOR_USER → RUNNING`）在同一次 `attention resolve`
  里提交；`deliveredToProvider: false` 是事实的一部分——散文提问没有 provider dialog 可写，解除**什么都不投递**、不新建
  Execution、不 resume conversation。`attention answer` 对散文等待以 `PROSE_QUESTION_RESOLUTION_REQUIRED` 拒绝，因此这条事件
  永远不会出现在 provider 投递路径上。

**Wave I/J 的其余能力没有新增事件名（FOUNDATION-074 核对）**：Project Knowledge（ADR-0041，schema v26）把快照与 Execution 绑定
写进 `knowledge_snapshots` / `execution_knowledge_snapshots` 两张表，**不写事件**；提升前全量证据（ADR-0039，schema v25 的
`dev_full_suite_evidence`）同样只有行，不算领域事件；`settings ui *`（ADR-0045）与 `agent plugins *`（ADR-0044）也都是**设置/配置**，
后者只追加 `agent_configurations` 的一列并在 `executions.agent_config_json` 留痕。它们的可审计性来自表与命令回执，不是事件流；
把「没有新事件」如实写出来，比默默省略更有用。

### 2.2 命名规则（ADR-0035 裁决，长期有效）

1. **已实现的事件名以实现为准，永不重命名。** 事件台账是 append-only 审计：重命名会让同一语义在历史里长期存在两个名字，并让已发出的订阅游标、消费者幂等键和外部脚本同时失效。设计目录里与之不同的名字标为**已废弃**。
2. **新事件采用设计目录里的名字。** 设计目录是先行契约；实现某条设计事件时不另起名字（本格新增的七个交接/终端事件即为此例）。
3. **名字变更只能通过「新增事件 + 旧事件不再产生」实现。** 不迁移历史行，不改写已有行，不把旧名行「升级」成新名；读者需要同时理解两个名字，第 2.3 节就是为此存在。

### 2.3 设计名与实现名的差异（已裁决，ADR-0035）

原「交用户裁决」清单已由用户裁决，结论记录在 [`../decisions/0035-event-name-and-handoff-faces.md`](../decisions/0035-event-name-and-handoff-faces.md)：**文档对齐实现名 + 新事件用设计名 + 已实现名永不重命名**。「已废弃」表示该设计名不会出现在任何新写入的行里；历史行（如果有）保持原样可读。

| 设计目录（原 §2） | 实现实际写入 | 裁决 |
|---|---|---|
| `IntentRecorded`、`TaskCreated`、`TaskStateChanged`、`ExecutionReserved`、`ExecutionStateChanged`、`ExecutionFailed`、`WorkspacePrepared`、`AgentSessionStarted`、`AgentSessionStateChanged`、`AgentSessionCompleted`、`UserAttentionRequested`、`UserAnswerRecorded`、`UserAnswerDelivered`、`ResultCommitAuthorized`、`ResultCommitAuthorizationInvalidated`、`RecoveryRequired`、`VerificationCompleted`、`VerificationInvalidated` | 同名 | 一致 |
| `TaskRevisionAppended` | `TaskRevisionCreated` | 设计名**已废弃**（语义相同：追加不可变修订） |
| `DependencyAdded` / `DependencyNeedsReview` | `TaskDependencyAdded` / `TaskDependencyRemoved` | 两个设计名**已废弃**；实现没有 `NEEDS_REVIEW` 边状态 |
| `RevisionDelivered` / `RevisionAcknowledged` | `TaskRevisionDeliveryRecorded` / `TaskRevisionDeliveryAttempted` / `TaskRevisionDeliveryResolved` | 设计名**已废弃**（投递是一等需求 + append-only 尝试台账，见 ADR-0028） |
| `ExecutionResultCaptured` | `ResultCommitCreated` | 设计名**已废弃** |
| `DevIntegrationCandidateCreated` / `DevIntegrationCompleted` | `IntegrationBatchCreated` / `IntegrationCompleted`（另有 `IntegrationFailed` / `IntegrationReconcileRequired` / `IntegrationVerificationCompleted`） | 设计名**已废弃** |
| `StablePromotionApproved` / `StablePromotionApprovalInvalidated` / `MainPromoted` / `RuntimeRestartedAfterMainUpdate` / `RuntimeRestartFailed` / `StablePromotionRequested` | `PromotionCreated` / `PromotionApproved` / `PromotionDevPushed` / `PromotionPushRefused` / `PromotionMainUpdated` / `PromotionRestartRecorded` / `PromotionMainPushRefused` / `PromotionCompleted` / `PromotionStale` / `PromotionFailed` / `PromotionReconcileRequired` | 设计名**已废弃**；批准失效由 `PromotionStale` 表达，没有与 `StablePromotionApprovalInvalidated` 同名的事件。`PromotionStarted`（ADR-0022 的本机 ff 实现）在 ADR-0047/0052 后不再产生 |
| `TakeoverRequested` / `TakeoverSafePointReached` / `SessionHandoffStarted` / `SessionHandoffCompleted` / `TerminalWriterLeaseChanged` / `TakeoverReleased` / `TakeoverFailed` | **同名（本格实现，FOUNDATION-063）** | 设计名**采用**；`TerminalWriterLeaseChanged` 的 payload 以 lease 事实（`leaseId` + before/after holder）表达设计里的 `attachmentId`，因为实现的 writer lease 是以 `holder_ref` 计的 lease term，不引用 attachment 行 |
| `ImpactAssessed` / `ConflictAssessed` | **未实现为 domain event**：ADR-0031 只把判定写进 `impact_assessments` 行 | 裁决：本格**不做**（判定类事件未列入实现范围） |
| `TaskPriorityChanged` | 未实现（实现里没有 task priority 这一维度） | 设计名保留，未实现 |
| `IntentClarificationRequested` | 未实现 | 设计名保留，未实现 |
| `SessionGuidanceRecorded` / `SessionGuidanceDelivered` | **同名（本格实现，FOUNDATION-088 / ADR-0057）** | 设计名**采用**；两个事件都是实现写入的真实名字，`SessionGuidanceDelivered` 的 payload 带 `state` 与 `delivered`，因此「拒绝」不会被读成「已交付」（见 §2.1 会话指导一节） |
| `ExecutionPauseRequested` / `ExecutionPaused` / `ExecutionCancelled` / `ExecutionSuperseded` | 未找到同名事件；暂停/取消的投影通过 `TaskStateChanged` / `ExecutionStateChanged` 与 Operation 状态表达 | **未验证**是否存在等价专名，本格不改动 |
| `ResultCommitAuthorizationRequested` | 未实现同名事件（授权由 prepare/confirm 两步与 `ResultCommitAuthorized` 表达） | 设计名保留，未实现 |
| `CandidateBuilt` / `SelfTestCompleted` / `StablePromoted` / `StableRollbackCompleted` | 未实现 | 设计名保留（Self Evolution 阶段） |
| `SchedulerGlobalCapacityChanged` / `SchedulerGlobalPauseRequested` / `SchedulerGlobalPaused` / `SchedulerGlobalResumeRequested` / `SchedulerGlobalResumed` / `SchedulerGlobalControlRecoveryRequired` | **已实现**（schema v34：容量半边 FOUNDATION-096，暂停半边 FOUNDATION-097） | 六个名字都随 Accepted ADR 固定并已采用，不另起一套。`Requested` 与完成事实必须分开，部分结果只能写 RecoveryRequired。`project_id = NULL`、`aggregate_type = 'RuntimeSchedulerControl'`；`pause`/`resume`/`reconcile` 的回执在 `runtime_command_receipts` |
| `ProseQuestionAttentionResolved` | **实现先行名**（FOUNDATION-069 新增，本格补登记） | 本格**登记为长期名**；`UserAnswerDelivered` 不适用于散文提问（它没有 provider 请求），因此不合并 |
| `TaskRetryRequested` | **实现先行名**（FOUNDATION-061 新增，本格补登记） | 本格**登记为长期名**；与 `TaskStateChanged` 同事务、不取代它 |
| （设计目录没有的实现新增名） | `TaskArchived` / `TaskUnarchived` / **`TaskPurged`（FOUNDATION-090 / ADR-0058）** / `WorkspaceReclaimed` / `ResourcesReclaimed` / `OperationProgressed` / `OperationSettled` / `ExecutionSlot*` / `SchedulerCapacityChanged` / `TaskSchedule*` / `TaskImpactPredictionRevoked` / `Promotion*` / `Integration*`（含 ADR-0053 的 `IntegrationMemberMerged` / `IntegrationBatchStale` / `IntegrationBatchCancelled`） | 反向登记：这些是实现先行的名字，同样永不重命名。`TaskPurged` 是**唯一一条在它自己的聚合根行被删除的同一个事务里写入的事件**：它没有外键，因此任务行消失后它仍在 `events.list`/SSE 里可读，并且是「这个任务存在过、什么时候被谁删除、删掉了什么」的最后一条记录（ADR-0058 D08） |

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
- 可选 `projectId` 过滤只影响交付；游标仍会前进，因此过滤订阅的 resume 语义与全量订阅一致。**ADR-0061/v34（FOUNDATION-096）起，Project 过滤交付“该 Project 的事件 + `project_id IS NULL` 的 Runtime 全局事件”**，因为全局容量会影响每个 Project；cursor 仍按同一 sequence 前进，重连在边界上不漏不重。全局暂停事件（FOUNDATION-097）使用同一规则，且已落地。Phase 1 未实现按 project 的权限隔离——本地单用户 socket 权限（0600）是这一层的边界。
- 投影由 Runtime 的事件写入路径负责；订阅不引入第二个事件源，也不允许客户端写入事件。
- ADR-0067 起本地 Web UI / HTTP/SSE 入口暂停，Runtime 不实例化 `RuntimeHttpApi`；该实现源码静态保留，但不属于当前启用或测试的传输面。当前客户端通过 Unix socket 消费同一组 versioned frame。

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

ADR-0035 追加的三条：**同一 command 重放不产生第二个事件**（包括拒绝事实：`TakeoverFailed` 的 event id 由 command + stage + reason 推导）；**事件与它描述的状态变更同事务提交**（用一个无法描述的 successor 让 ADMITTED 回滚，验证状态与事件一起消失）；**旧设计名的历史行仍可读且未被改写**（构造一条旧名行，读回时名字与 payload 原样）。
