# Domain Model

状态：既有 Task/Execution 模型的实现说明 + ADR-0068 目标映射。当前 schema v36 仍以 Project/Task/Execution 表为权威；Service/Process/Signal 是已接受但尚未实现的目标，详见 [`service-process-signal.md`](./service-process-signal.md)。

## 0. ADR-0068 目标聚合

- `CodeestraService`：每个 Runtime home 唯一的 0 号根 Service。
- `Service`：持久 Actor 聚合，core state + namespaced metadata + versioned contract + inbox；Service 树无环。
- `ProjectService`：Project 的类型化 Service；拥有 Task 子 Service、受管 integration ref/worktree 与 merge queue。
- `TaskService`：Task 的类型化 Service；仍是 Scheduler 的业务调度单元，Task 之间不嵌套。
- `Process`：只监督 Agent 的短期聚合；现有 Execution 是迁移期权威事实源，AgentSession/incarnation 继续表达 provider conversation 与 OS 进程身份。
- `Signal`：`SIG_A | SIG_P` 持久信封，至少一次交付，以 target Service + idempotency key 去重；外部副作用仍由 Operation 恢复。

增量迁移期间不得让 `services.core_state` 与 `tasks/executions` 同时成为可写权威。先建立一一 projection link，再由独立 migration 切换写路径。

## 1. 通用约定

内部 ID 为随机 UUID，显示编号（T102）在 Project 内唯一，不用于安全路径。时间为 UTC epoch milliseconds。aggregateVersion 为非负整数，用于 compare-and-swap（CAS）；revisionNumber 从 1 单调递增。Git OID 接受仓库对象格式，不硬编码为仅 SHA-1。

Specification 是人类可读文本。机器解释必须保存来源，不能丢弃用户原文。TaskRevision 存完整快照，MVP 不使用难以独立解释的增量 patch。

## 2. 聚合与归属

### RuntimeSchedulerControl（ADR-0061，已接受、待实现）

每个 `CODEESTRA_HOME` 只有一个 Runtime 负载控制聚合，不属于任何 Project：

- `globalLimit` 是跨全部 Project / Adapter 的唯一并行上限（默认 2，范围 1–16）；不存在项目级或 Adapter 级覆写。
- `pauseState ∈ RUNNING | PAUSING | PAUSED | RESUMING | RECOVERY_REQUIRED`、`pauseEpoch`、version、actor 与请求/结算时间构成持久控制事实。
- `PauseTarget` 固定一个 epoch 内每个活动 provider incarnation 的 project/task/execution/session/incarnation、pid + start token、状态与观测。这些业务 ID 是身份快照而非 FK（Task purge 后进程恢复/审计事实仍须保留）；它只证明进程冻结/恢复事实，不改变 Task、Execution 或 AgentSession 状态。
- 全局冻结中的 Task 仍持有原 slot/workspace/writer lease 并继续计入容量。`PAUSED` 只在所有目标主进程被真实观察为 stopped（或已证明先退出）后成立；部分成功是 `RECOVERY_REQUIRED`。
- 该聚合跨 Runtime 重启保持。新 boot 先恢复屏障，绝不自动继续旧 boot 的 Provider；失去 transport 的 Session 仍走既有 reconcile，不能从 PauseTarget 伪造 live reconnect。

这是 Runtime 控制聚合，不是调度业务主实体的替代品：Task 仍是业务主实体，reservation 仍归属 Task/Project。

### Project / ProjectService

当前 Project 保存 canonical repo root、Git common directory、mainRef、显示名、创建时间与策略版本。启动先核对 Git 仓库身份，目录搬迁不能悄悄关联到另一仓库。

ADR-0068 目标中，每个 Project 一一对应 ProjectService，并增加由 Runtime 独占管理的 integration ref/worktree 与 merge queue。该 ref 不等于用户已检出的 main/dev 分支；目标 migration 完成前，这些字段不存在，当前 v36 仍按项目文件夹当前分支建 Task。

### UserIntent / IntentTarget

保存 rawText、分类、clarificationStatus、来源、幂等键、目标 Task/AttentionRequest。Phase 1 从结构化命令/明确任务目标起步，不提前自动实现所有自然语言路由；长期分类集合保持规格中七类。

### Task / TaskService（聚合根）

- identity：id、projectId、displayNumber、**显示标题 displayTitle 与命名标题 namingTitle**（ADR-0065；Task 级、创建后不可修订，命名标题用于分支与 worktree 目录）。
- currentRevisionId、aggregateVersion、priority（整数越大越优先，默认 0）。
- lifecycleState；verification/integration 用独立状态和对象表达。
- 通过关系持有 revisions、dependencies、impact assessments、pair conflicts、executions、workspace、verifications、integration items。
- 每个 Task 最多一个未释放资源的 Execution；同一 Task 的多次尝试顺序进行。
- SUCCEEDED 表达当前 revision 已集成到 main，不代表发布；EXECUTED 仅表示 Agent 已产出候选。

### TaskRevision

id、taskId、number、previousRevisionId、specification、**features**、intentId、actor、reason、createdAt。append-only。所有代码成果和验证绑定精确 revision。`constraints` 自 ADR-0065 起不再是 revision 字段（约束功能已删除）。

**`features` 是功能声明（ADR-0059，schema v32）**：字符串数组，取值必须是项目 `main` ref 上
`.codeestra/impact.json` 的 `modules[].id`（**写入时**校验：`UNKNOWN_FEATURE` / `IMPACT_POLICY_ABSENT` /
`INVALID_IMPACT_POLICY` / `INVALID_FEATURE`，都不要求该映射已被 trust 确认）。它是**声明**而非推断：
两个 Task 的当前 revision 声明了同一个功能、且对方未完成（非 `SUCCEEDED`/`CANCELLED`、未归档）时才是
`CONFLICTING`；未声明的 Token 永远不参与功能冲突。省略 `--feature` 的新 revision **继承**上一条的声明。

修订使用 expected aggregateVersion；并发修改失败返回冲突，不覆盖他人修订。输入改变立即使此前当前验证失效。已集成或已取消的 Task 不静默重开：新输入先请求确认其是否创建后续 Task，此路径在 MVP 尚不自动分类。

### TaskDependency

边为 dependentTaskId → prerequisiteTaskId。边内记录 requiredRevisionId；增加边时绑定用户所指上游当前 revision，避免依赖含义随文本变动而漂移。

**待用户确认的后续语义**：上游在依赖满足前又修订时，是否自动移动 requiredRevision。安全默认不是替用户选版本，而是使该边 NEEDS_REVIEW、阻止下游启动，并要求明确选择版本后再激活；Phase 1 不实现 DAG 编辑，因此不阻塞 Phase 0/1。

当前 v36 的满足条件是：指定上游 revision 的 result commit 对项目当前 Task 基线 ref 可达。ADR-0068 目标改为：上游 merge queue item 已成功推进 ProjectService 的 integration ref，且结果 commit 对下游固定 integration 基线可达；integration ref 外部移动或证据失效时重新阻塞。Task Verification 单独通过仍不释放依赖。

### ExecutionSlotReservation / 全局容量

现有 reservation 仍绑定 project/task/revision/adapter/workspace 与 holder identity；ADR-0061 只改变**计数域**与配置来源：容量查询把整个 Runtime 的活跃 reservation 与 `resource_held=1` Execution 按 Task 去重，不再按 Project 筛选，也不再读取 Adapter 覆写。降低 `globalLimit` 不改任何已有 reservation/Execution。

### Process / Execution / RevisionDelivery

目标 Process 是 Agent supervisor；当前 Execution 记录它的权威执行事实：attemptNumber、primaryAdapterId、initialRevisionId、appliedRevisionId、workspaceId、baseCommit、resultCommit、state、stopReason、timestamps、error。S2/S5 先建立一一 projection link，再逐步把通用查询/控制映射为 Process；不能复制一套独立可写状态。

同一 Execution 可在已可靠暂停/确认后应用新 revision，因此保存 initial 与 applied revision，并通过 RevisionDelivery 保留全部变更。Delivery 保存 revisionId、deliveryKey、status（PENDING/SENT/ACKNOWLEDGED/REJECTED/SUPERSEDED）、证据和时间。终端输出看似赞同不能自动当结构化 ACK。

当 Adapter 不支持可靠确认：停止旧 Execution，确认进程不再写入后建立新 Execution，其完整启动输入包含新 revision。旧分支/现场保留且记录继承来源。协作停止超时阻止新尝试。

### AgentSession / SessionGuidance / TakeoverRequest / AttentionRequest

Session 保存 adapterId、mode（`AUTOMATED_RPC | HUMAN_TUI`）、providerSessionId、processIdentity、capabilities snapshot、transport locator、session storage reference、state、退出信息与可选 predecessorSessionId。PID 单独不足以证明身份；需要启动 token/时间及进程控制记录。Session 持久化不等于 OS 进程永不退出。

一个 Execution 在任意时刻只有一个主活动 Session，但 ADR-0010 的 RPC↔TUI 进程交接会形成有序 Session incarnation 历史：前一进程确认退出后才创建 successor；provider conversation ID/file 可以连续，Codeestra session ID 与 OS process identity 必须更新，不能把新进程伪装成旧进程。一个 Session 内可有多轮交互。

SessionGuidance 表达不改变验收规格的人工指导，绑定 source（COMMAND/TUI）、execution/session/provider conversation entry、actor、hash/长度与投递状态；`task guide` 的正文需耐久保存到投递完成，TUI 已落 provider conversation 的正文只保存 entry 引用而不重复复制，二者正文都不进入 domain event。它不改变 `appliedRevisionId`、不生成 TaskRevision、不使验证自动失效。改变规格/约束必须走明确的 TaskRevision 命令；Pi 仍按不支持 revision ACK 的 fallback 新建 Execution。

TakeoverRequest 是 Execution 的控制记录，不是新的调度主实体。保存 requested Session/process/cursor、状态（`REQUESTED | WAITING_FOR_ATTENTION | WAITING_FOR_SAFE_POINT | STOPPING_SOURCE | STARTING_TARGET | ACTIVE | RETURN_REQUESTED | COMPLETED | FAILED | RECOVERY_REQUIRED`）、目标 mode、writer lease 与交接 Operation。接管请求先于 settled 事实提交时，settled 作为交接安全点而非 completion；反之请求拒绝为 Execution 已非活动。attach/detach 只管理 TerminalAttachment，release 才触发 TUI→RPC 交接。

AttentionRequest 保存类型（PERMISSION/QUESTION/RECOVERY）、responseType（CONFIRM/VALUE）、providerRequestId、提示和状态；typed answer 另存回答者与投递 Operation。回答已写 DB 不代表 Agent 已恢复，confirmed=false 与 cancel 都是有效但语义不同的回答。TUI gate side channel 同样建立 Attention 与 answer 事实；原生 TUI 和其他客户端竞争回答时只接受第一份合法决议。

Session 身份分三层持久化：Codeestra sessionId、provider session ID/file、provider process identity（pid、executable、start token、argv hash、采集时间）。缺少 start token 时拒绝启动，因为 PID 可被复用。Runtime 丢失 RPC/PTY 控制连接后不重接 live process：记录 DISCONNECTED，并让 Execution/workspace 保持占用并进入 RECOVERY_REQUIRED，直到 reconcile 取得真实事实。

TerminalAttachment 是瞬时客户端连接与单 writer lease 的记录；多个只读 attachment 可并存。PTY bytes/resize/input 走独立有界 transport，不作为领域事实，不从 ANSI 文本推断完成、审批或静止。首版只保留 Runtime 内存中的有界重连缓冲；detach 不停止 HUMAN_TUI Session。

### Workspace

Task 独占逻辑 workspace，关联 branch/worktree、baseCommit、ownershipToken、state、dirty status。安全重试可复用已确认静止且归属正确的 workspace；同一 Task 不允许旧执行与新执行同时写入。删除/重建必须另有明确授权，不在取消流程中隐式清理。

**授权形态已明确（ADR-0058）**：「另有明确授权」就是 `task purge`——一条显式、不可逆、只删除一个任务的命令。它**不是**流程内的隐式清理：`task cancel` 仍然只释放资源、只保留记录；`task archive` 仍然只写 `archived_at`；回收（ADR-0021）仍然只回收资源、不删记录。而 `purge` 反过来——它删除任务与它拥有的全部行（含五张 append-only 任务子表，只在 purge 事务内让路）以及它自己的 worktree/验证副本/分支，并在同一个事务里写下 `TaskPurged`。**`--force`（ADR-0058 D09，2026-09-16 用户选定）**：同一个调用者对同一条命令的更宽声明——不是权限门禁，也不是第二道确认。它先对**任务记录过的身份**（pid + start token）发信号终止 provider，然后越过上面两个界限；**归属不明的目录/分支永远不删**（只越过「活占」类门禁，不越过归属校验），跳过了什么逐项记在 `forced.bypassed` 与 `TaskPurged` 事件里。删除 `dev`/`main` 的来源记录（必要时连同引用了该任务验证行的 `stable_promotions` 与其全部成员行）是它明确的代价。

### ImpactAssessment / ConflictAssessment

Impact 绑定 revision、baseCommit、analyzerVersion，保存 path/directory/module 集合、完整性与证据。Conflict 绑定有序任务对及两份 impact 的 ID/版本，保存结论和原因。Task summary 只是派生显示，不能替代 pairwise 判断。

**判定语义已由 ADR-0059 取代（FOUNDATION-091）**：`impactAnalyzerVersion` 前进到 `impact-analyzer-v2`，
判定只读两侧声明的 `features` 与「对方是否未完成」，命中 `SAME_UNFINISHED_FEATURE`。快照、映射、基线、
变更集仍然是**记录的证据**（`impact_assessments` 仍按「两侧都有可观测快照」写配对行），但**不再参与判定**；
所以「没有 assessment 行」不等于「没有冲突」——判定的审计是 `TaskScheduleDecided`/`TaskWaitingForConflict` 事件与 `explain` 输出。

### VerificationRun

scope=TASK/INTEGRATION；subject execution/batch 二选一；revision（Task scope）、testedCommit、testedTree、policyVersion/policyDigest/mainCommit、commands、state、outcomeCode、非敏感 evidence。分支指针移动后旧测试不能代表新内容；先冻结 commit 再验证，并检测验证命令是否修改被测树。

Phase 1 只实现 TASK scope：subject 固定 `executionId` + `revisionId`，且必须匹配 Task 当前 revision 与已捕获的 `result_commit`。命令来自 main ref 上的人工维护策略（ADR-0006）：FULL 下直接执行，STRICT 下在 trust 时一次性确认；Task branch 上的策略文件不参与判定。state 为 `QUEUED → RUNNING → PASSED | FAILED | ERROR`，新 commit 或新 policy digest 使旧 `PASSED` 变为 `STALE`（保留原结论与失效原因，不改写）。`outcomeCode` 区分 `PASSED`、`COMMAND_FAILED`、`COMMAND_TIMEOUT`、`TREE_MUTATED`、`WORKTREE_FAILED`、`RUNTIME_RESTARTED`。evidence 只含 exit code、时长、字节数、摘要、路径列表与副本处理结果，不含原始命令输出。验证证据不等于集成或发布事实。

### ManagedIntegration / MergeQueueItem / IntegrationProcess（ADR-0068 目标）

当前 v36 没有产品侧 integration 表或命令。目标模型不复活旧 IntegrationBatch/StablePromotion 原样结构，而由 ProjectService 持有：

- managed integration ref/worktree 与 ownership token；
- `MergeQueueItem`：task/revision/result commit/task verification/request priority/correlation；
- 单项目唯一活动 integration lease；
- `IntegrationProcess`：Agent supervisor，复杂合并只能经 Project Service Git API；
- `IntegrationVerification`：绑定 candidate commit、policy digest 与 expected integration OID；
- CAS advance / STALE / conflict / failure / recovery evidence。

发布 integration ref 到用户 main/release 分支不属于本对象，也不恢复旧 `promotion *`。Codeestra 自身仓库的人工 `dev → main` 发布仍由 `AGENTS.md` 约束。

### CandidateVersion / PromotionRecord

Candidate 固定 self Task、build source、artifact location/hash、bootstrap compatibility、database compatibility declaration、自托管验证记录与状态。PromotionRecord 记录用户授权、旧/新版本、排空、切换、健康检查及回滚事实。版本切换与数据恢复分别记录，不将二者当成同一原子操作。

## 3. 一致性边界

Task/revision/状态变更/outbox 共享事务；Git 和 Agent 是事务外副作用，以 Operation 记录 intent、phase、外部资源标识与 recovery outcome。启动后核对未完成 Operation，不盲目重放 start、commit、merge、send answer 或 promote。

跨聚合由应用服务在单 SQLite 事务中验证所需约束；Graph 检测在写锁保护下完成，避免两条并发边分别合法但合起来成环。
