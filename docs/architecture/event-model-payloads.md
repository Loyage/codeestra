# Event Model：逐事件 payload 与事实边界

> 层级：L2 按需参考 · 体量 ≈ 12k 字符 · **何时读**：你要新增某个事件的字段、消费它的 payload，或判断「这条事实到底证明了什么」 · 权威来源仍是真实写入代码；[`event-model.md`](./event-model.md) 给目录与命名规则。

这一篇只写**容易读错的事实边界**与不常改的完整 payload。目录与一行说明在 [`event-model.md`](./event-model.md) §2。

## 1. `TaskPurged`（ADR-0058）

它**不是状态**：`to: 'PURGED'` 描述「这个任务在这里结束」，行已经删除，没有 `task list`/`task status` 能再读到它。它是唯一一条在它自己的聚合根行被删除的**同一事务**里写入的事件，没有外键，因此任务行消失后仍在 `events.list`/订阅里可读，是「这个任务存在过、什么时候被谁删除、删掉了什么」的最后一条记录。

payload 要点：`taskId`、`displayNumber`、`from`、`to='PURGED'`、`archived`、`currentRevisionId`、`rowsDeleted`（逐表行数）、`dependencyEdgesRemoved`、`branchFacts`（每个被删分支的 `branchRef`/`tipCommit`/`deleted`）、`reclamation`（每个被回收资源）、`appendOnlyTriggersSuspended`、`reason`、`actor`；`--force`（ADR-0058 D09）时另带 `forced`：`bypassed[]`（被跳过的拒绝码与理由）与 `termination`（终止记录）。

## 2. `TaskRecoveryReconciled`（ADR-0055）

只在**收口**时发布（`Execution`/`Task` 置 `FAILED`、Session `EXITED`、workspace `RETAINED` 的同一事务里），是三个状态投影的 causation 起点；**拒绝路径不写事件**（没有状态变化）。

payload：`taskId`、`executionId`、`sessionId`、`workspaceId`、`workspacePath`、`providerPid`、`processState`（`STOPPED`/`ALIVE`/`DESCENDANTS_ALIVE`/`UNVERIFIABLE`/`IDENTITY_MISSING`）、`descendantRecord`（`RECORDED`/`MISSING`）、`descendantCount`、`workspacePresent`、`quiescenceProven`（**恒为 `false`**）、`signalsSent`（**恒为 `0`**）、`evidenceRef`、`reason`（可 null）、`actor`。

## 3. 长命令进度（ADR-0019 / ADR-0027）

| Event | aggregate | 关键 payload |
|---|---|---|
| `OperationProgressed` | `Operation` | operationId, projectId, taskId, kind, `progressSequence`（每 Operation 单调）, `dedupKey`, `phase`（`STEP`/`OUTPUT`/`CANCEL`/`SETTLED`）, 可选 stepKey/step/stepState/stepSequence, detail, `verdict: false` |
| `OperationSettled` | `Operation` | operationId, projectId, taskId, kind, progressSequence, `dedupKey='SETTLED'`, phase=`SETTLED`, `operationState`, detail, `verdict: false` |

只对**已发布过进度**的 Operation 发布（workspace prepare、Agent start、result commit 等从不进进度流的操作不会凭空开一条流）。`OperationSettled` 的 `eventId` 由 operationId 推导（`sha256('OperationSettled:'+operationId)`），重试的终态写入只能发布同一个事实。

## 4. 验证（ADR-0006 / ADR-0027）

`CANCELLED` **不是新事件类型**，它是 `VerificationCompleted.state` 的一个取值，此时 `outcomeCode='CANCELLED_BY_USER'`，且同事务发布对应的 `OperationSettled`（Operation 置 `FAILED`）。`verification_runs` 的 CHECK 让 `CANCELLED` 与其它终态一样必须带 `ended_at` 与 `outcome_code`，因此「未确认进程组静止」仍写不成终态。

`integration_verification_runs`（v36 已随集成一起删除）当时刻意没有 `CANCELLED`：集成验证有独立 Operation kind。ADR-0070 S8 重新引入集成验证时该口径要重新决定。

## 5. 修订投递（ADR-0028）

| Event | aggregate | 关键 payload |
|---|---|---|
| `TaskRevisionDeliveryRecorded` | `TaskRevisionDelivery` | deliveryId, taskId, revisionId, executionId, sessionId, incarnationId, `state='PENDING'` |
| `TaskRevisionDeliveryAttempted` | `TaskRevisionDelivery` | deliveryId, attemptNumber, `channel`, executionId, sessionId, incarnationId, `state='IN_FLIGHT'`, `deadlineAt` |
| `TaskRevisionDeliveryResolved` | `TaskRevisionDelivery` | deliveryId, attemptId, `state`, `channel`, evidenceRef, errorCode, detail, `satisfied`；`SUPERSEDED_BY_RESTART` 分支另带 predecessor/successor executionId |

## 6. 容量、槽位与调度（ADR-0032/0033/0061）

| Event | aggregate | 关键 payload |
|---|---|---|
| `ExecutionSlotReserved` | `ExecutionSlot` | reservationId, taskId, revisionId, adapterId, workspaceId, holder{bootId,pid,startToken}, capacity |
| `ExecutionSlotWorkspaceBound` | `ExecutionSlot` | reservationId, taskId, workspaceId |
| `ExecutionSlotReleased` | `ExecutionSlot` | reservationId, taskId, `releaseKind`（`EXPLICIT`/`RECONCILED_HOLDER_EXITED`/`RECONCILED_PROCESS_ID_REUSED`）, `observation`, reason |
| `ExecutionSlotReconciled` | `ExecutionSlot` | reservationId, taskId, `decision`, `observation`, previousState, projectedState, detail |
| `TaskScheduleDecided` | `TaskSchedule` | taskId, revisionId, `verdict`, activeTaskIds, candidateSnapshotId… |
| `TaskWaitingForConflict` / `TaskWaitingForCapacity` | `TaskSchedule` | taskId + 稳定等待码 + blocking |
| `TaskUnknownCleared` | `TaskSchedule` | taskId, revisionId, analyzerVersion/policyVersion/baseCommit 绑定 |
| `TaskImpactPredictionRevoked` | `TaskSchedule` | taskId, added/removed 改动集, conflicts, reasons, pauseRequested |
| `SchedulerGlobalCapacityChanged` | `RuntimeSchedulerControl` | from, to, source（`DEFAULT`/`EXPLICIT`/`MIGRATED_MINIMUM`）, actor |

- `SchedulerCapacityChanged`（项目级/Adapter 级）与 `CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` **不再产生新事实**：ADR-0061 之后只有一个 Runtime 全局上限；历史行与历史命令结果原样保留可读。
- `ExecutionSlotReconciled` 也会为「决定保持占用、状态未变」的观测发布——那是审计事实，不是状态迁移。
- `TaskSchedule*` 的重放保护是 `(event_type, correlation_id, aggregate_id)`，不是 event id。
- 全局事实以 `project_id = NULL`、`aggregate_type='RuntimeSchedulerControl'` 写入；这是为「不属于任何 Project」保留的表达，而不是「未知 Project」。Project 过滤读取为 `(project_id = ? OR project_id IS NULL)`，游标仍按同一 sequence 前进。

**全局暂停的五个事件**（`SchedulerGlobalPauseRequested`、`SchedulerGlobalPaused`、`SchedulerGlobalResumeRequested`、`SchedulerGlobalResumed`、`SchedulerGlobalControlRecoveryRequired`）已实现（FOUNDATION-097，schema v34）：`...Requested` 不等于 `...Paused`，部分结果只能写 `...RecoveryRequired`，不能用完成事件粉饰。全局控制的 command receipt 进 `runtime_command_receipts`（命令不属于任何 Project）。

## 7. 交接与原生终端（ADR-0023 / ADR-0026 / ADR-0035）

| Event | aggregate | 关键 payload |
|---|---|---|
| `TakeoverRequested` | `SessionHandoff` | takeoverId, sessionId, executionId, incarnationId, `kind`（`TAKEOVER`/`RETURN`）, `targetMode` |
| `TakeoverSafePointReached` | `SessionHandoff` | takeoverId, incarnationId, `reachedFrom`（`RPC_FENCE`/`TERMINAL_RELEASE`）, `fenceAcknowledged`, `settledAfterFenceAt`, `activeTools`, `evidenceRef`, `lastEntryRef`, **`missing`** |
| `SessionHandoffStarted` | `SessionHandoff` | takeoverId, source/targetSessionId, sourceIncarnationId, fromMode, toMode, predecessorObservation, processEvidenceRef |
| `SessionHandoffCompleted` | `SessionHandoff` | takeoverId, source/targetSessionId, sourceIncarnationId, successorIncarnationId/Number, fromMode, toMode, terminalTransport, terminalId, providerPid, processEvidenceRef |
| `TakeoverReleased` | `SessionHandoff` | takeoverId, sessionId, incarnationId, terminalId, reason, predecessorObservation, evidenceRef, `sessionFile{…,predecessorEntrySurvived,truncated}` |
| `TakeoverFailed` | `SessionHandoff`（无 takeover 时以 `sessionId` 为 aggregate id） | takeoverId（可空）, sessionId, executionId, incarnationId（可空）, `stage`（`REQUEST`/`SAFE_POINT`/`ADMIT`/`RELEASE`）, **`reason`（稳定码）**, detail, evidenceRef |
| `TerminalWriterLeaseChanged` | `SessionWriterLease` | takeoverId（可空）, sessionId, leaseId, `action`（`ACQUIRED`/`RELEASED`）, `before`/`after`（`{incarnationId,holderKind,holderRef}` 或 null）, reason |

事实边界：

- `TakeoverRequested` 与 `SessionHandoffStarted` **都不是**「已交接」：前者只说明意图与 fence 被记录，后者只说明 predecessor 不再是 writer、successor 尚未启动。只有 `SessionHandoffCompleted` 表示 successor 进程真的启动、记录并持有单 writer lease。
- `TakeoverReleased` 只在发布（provider 退出、记录的进程树无存活者、provider session file 仍保有 predecessor 的 entry）**被证明**时写入；证明不了的发布是 `TakeoverFailed`。
- `TakeoverSafePointReached.missing` 是事实的一部分：安全点经 RPC fence 达成时为空，经终端发布达成时由 `reachedFrom` 与 `sessionFile` 表达，绝不假装 fence 被 ack。
- 这七个事件与它们描述的状态变更在**同一 SQLite 事务**内提交（`TakeoverFailed` 除外——拒绝本身没有状态变更，它自己就是那条事实，事件 id 由 command + stage + reason 推导，故同一命令重放不产生第二条）。
- 单一 writer lease 的每次更换都写 `TerminalWriterLeaseChanged`（acquire 与 release 各一条），所以「谁在写这个 conversation」可从日志复原，而不是只能从当前行推断。

## 8. 会话指导（ADR-0057）

| Event | aggregate | 关键 payload |
|---|---|---|
| `SessionGuidanceRecorded` | `SessionGuidance` | guidanceId, taskId, `source='COMMAND'`, executionId, sessionId, incarnationId, `bodyHash`, `bodyBytes`, actor, `attemptId`（当时有 Execution 持有 Task 时为那个 attempt，否则 null） |
| `SessionGuidanceDelivered` | `SessionGuidance` | guidanceId, attemptId, `channel='PROVIDER_CONVERSATION'`, `state`（`DELIVERED`/`CHANNEL_UNSUPPORTED`/`TIMED_OUT`/`FAILED`）, capability, evidenceRef, errorCode, detail, `delivered`（仅 `DELIVERED` 时 true） |

- `SessionGuidanceRecorded` 只说「已耐久记录、并会在下一次 Execution 启动时交给 provider」，**不是**「已经投递」。
- `SessionGuidanceDelivered` 是**一次尝试的结论**：`DELIVERED` 只意味 provider 通道接受入队，其余取值是拒绝或未完成，必须带稳定 `state`/`errorCode` 读成拒绝。
- **没有任何事件或列表达「模型已读/已生效」**（ADR-0051 实测三个 provider 都没有可核验通道；命令面以 `modelAcknowledgement: 'UNSUPPORTED'` 明说）。
- 正文只在 `session_guidance.body` 里，**不进事件**（事件只带 hash 与长度）；两者都与状态变更同事务提交。guidance 不写 `task_revisions`、不动 `tasks.current_revision_id`、不写 `VerificationInvalidated`。

## 9. 显式重试与散文提问解除

| Event | aggregate | 关键 payload |
|---|---|---|
| `TaskRetryRequested` | `Task` | taskId, `from='FAILED'`, `to`（`READY`/`BLOCKED`）, failedExecutionId, failedAttemptNumber, adapterId, previousAdapterId, `adapterChanged`, `workspaceMode`（`REUSE_OWNED`/`REBUILD_OWNED`/`NEW_WORKSPACE`）, workspaceId, workspaceEvidence, `dependencies`, actor |
| `ProseQuestionAttentionResolved` | `Attention` | attentionId, `resolution`（`DISMISSED`/`ANSWERED`）, answerText, note, actor, `attentionStatus='CLOSED'`, `deliveredToProvider: false`, reason |

- `TaskRetryRequested` 是重试**自己的**审计记录，与它引起的 `TaskStateChanged` 分开追加；同一命令重放不产生第二条。`FAILED → READY` 不是自动的，只有 `task retry` 走这条路径。
- `ProseQuestionAttentionResolved` 与它引起的 `TaskStateChanged`（`WAITING_FOR_USER → RUNNING`）在同一次 `attention resolve` 里提交；`deliveredToProvider: false` 是事实——散文提问没有 provider dialog 可写，解除**什么都不投递**、不新建 Execution、不 resume conversation。`attention answer` 对散文等待以 `PROSE_QUESTION_RESOLUTION_REQUIRED` 拒绝，因此这条事件永远不会出现在 provider 投递路径上。

## 10. 回收（ADR-0021 / ADR-0042）

`ResourcesReclaimed`（`Operation`）、`WorkspaceReclaimed`（`Workspace`）是回收账本事实。ADR-0042 的 worktree 重建**不新增事件名**：复用同一 workspace 行（`RELEASED → READY`）并在同一事务写 `WorkspacePrepared`，用 `payload.rebuild.outcome` 区分 `REBUILT` 与 `ADOPTED`；`TaskRetryRequested.workspaceMode` 增加 `REBUILD_OWNED`（既有字段的新取值，不是新事件）。
