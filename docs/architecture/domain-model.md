# Domain Model

状态：Phase 0/1 设计基线。依据 ADR-0001、ADR-0002。Phase 4/7 的对象提前定义，但不提前实现运行流程。

## 1. 通用约定

内部 ID 为随机 UUID，显示编号（T102）在 Project 内唯一，不用于安全路径。时间为 UTC epoch milliseconds。aggregateVersion 为非负整数，用于 compare-and-swap（CAS）；revisionNumber 从 1 单调递增。Git OID 接受仓库对象格式，不硬编码为仅 SHA-1。

Specification 是人类可读文本，constraints 是带稳定 ID 的文本条目。机器解释必须保存来源，不能丢弃用户原文。TaskRevision 存完整快照，MVP 不使用难以独立解释的增量 patch。

## 2. 聚合与归属

### Project

保存 canonical repo root、Git common directory、mainRef、显示名、创建时间与策略版本。启动先核对 Git 仓库身份，目录搬迁不能悄悄关联到另一仓库。不自动把现有任意分支改名为 main；实际目标分支由项目配置指定。

### UserIntent / IntentTarget

保存 rawText、分类、clarificationStatus、来源、幂等键、目标 Task/AttentionRequest。Phase 1 从结构化命令/明确任务目标起步，不提前自动实现所有自然语言路由；长期分类集合保持规格中七类。

### Task（聚合根）

- identity：id、projectId、displayNumber、kind（DEVELOPMENT / SELF）。
- currentRevisionId、aggregateVersion、priority（整数越大越优先，默认 0）。
- lifecycleState；verification/integration 用独立状态和对象表达。
- 通过关系持有 revisions、dependencies、impact assessments、pair conflicts、executions、workspace、verifications、integration items。
- 每个 Task 最多一个未释放资源的 Execution；同一 Task 的多次尝试顺序进行。
- SUCCEEDED 表达当前 revision 已集成到 main，不代表发布；EXECUTED 仅表示 Agent 已产出候选。

### TaskRevision

id、taskId、number、previousRevisionId、specification、constraints、intentId、actor、reason、createdAt。append-only。所有代码成果和验证绑定精确 revision。

修订使用 expected aggregateVersion；并发修改失败返回冲突，不覆盖他人修订。输入改变立即使此前当前验证失效。已集成或已取消的 Task 不静默重开：新输入先请求确认其是否创建后续 Task，此路径在 MVP 尚不自动分类。

### TaskDependency

边为 dependentTaskId → prerequisiteTaskId。边内记录 requiredRevisionId；增加边时绑定用户所指上游当前 revision，避免依赖含义随文本变动而漂移。

**待用户确认的后续语义**：上游在依赖满足前又修订时，是否自动移动 requiredRevision。安全默认不是替用户选版本，而是使该边 NEEDS_REVIEW、阻止下游启动，并要求明确选择版本后再激活；Phase 1 不实现 DAG 编辑，因此不阻塞 Phase 0/1。

满足条件：指定上游 revision 有成功 main 提升记录，且结果 commit 在下游选定 main 基线的祖先链中。主分支被外部重写导致不可达时重新阻塞。无法自动判断外部 revert 的语义，必须暴露此限制。

### Execution / RevisionDelivery

Execution 记录 attemptNumber、primaryAdapterId、initialRevisionId、appliedRevisionId、workspaceId、baseCommit、resultCommit、state、stopReason、timestamps、error。

同一 Execution 可在已可靠暂停/确认后应用新 revision，因此保存 initial 与 applied revision，并通过 RevisionDelivery 保留全部变更。Delivery 保存 revisionId、deliveryKey、status（PENDING/SENT/ACKNOWLEDGED/REJECTED/SUPERSEDED）、证据和时间。终端输出看似赞同不能自动当结构化 ACK。

当 Adapter 不支持可靠确认：停止旧 Execution，确认进程不再写入后建立新 Execution，其完整启动输入包含新 revision。旧分支/现场保留且记录继承来源。协作停止超时阻止新尝试。

### AgentSession / AttentionRequest

Session 保存 adapterId、providerSessionId、processIdentity、capabilities snapshot、transport locator、session storage reference、state 和退出信息。PID 单独不足以证明身份；需要启动 token/时间及进程控制记录。Session 持久化不等于 OS 进程永不退出。

一个 Execution 一个主 Session，Session 内可有多轮交互。AttentionRequest 保存类型（PERMISSION/QUESTION/RECOVERY）、providerRequestId、提示、状态、回答者和实际回答投递状态。回答已写 DB 不代表 Agent 已恢复。

### Workspace

Task 独占逻辑 workspace，关联 branch/worktree、baseCommit、ownershipToken、state、dirty status。安全重试可复用已确认静止且归属正确的 workspace；同一 Task 不允许旧执行与新执行同时写入。删除/重建必须另有明确授权，不在取消流程中隐式清理。

### ImpactAssessment / ConflictAssessment

Impact 绑定 revision、baseCommit、analyzerVersion，保存 path/directory/module 集合、完整性与证据。Conflict 绑定有序任务对及两份 impact 的 ID/版本，保存结论和原因。Task summary 只是派生显示，不能替代 pairwise 判断。

### VerificationRun

scope=TASK/INTEGRATION；subject execution/batch 二选一；revision（Task scope）、testedCommit、treeFingerprint、policyVersion、commands、status、exit evidence。分支指针移动后旧测试不能代表新内容；先冻结 commit 再验证，并检测验证命令是否修改被测树。

### IntegrationBatch / Item / Approval

Batch 固定 project、expectedMainCommit、integrationRef、candidateCommit、state。Item 固定 executionId、revisionId、sourceCommit。Approval 固定 candidate SHA、expected main SHA、验证记录及用户身份；主分支变化、候选变化或验证失效即失效。

MVP 批次采用不部分提升的安全流程：任意步骤失败先停留并报告，不自行排除任务后合入剩余任务。自动拆批策略留 Phase 4 产品决策。

### CandidateVersion / PromotionRecord

Candidate 固定 self Task、build source、artifact location/hash、bootstrap compatibility、database compatibility declaration、自托管验证记录与状态。PromotionRecord 记录用户授权、旧/新版本、排空、切换、健康检查及回滚事实。版本切换与数据恢复分别记录，不将二者当成同一原子操作。

## 3. 一致性边界

Task/revision/状态变更/outbox 共享事务；Git 和 Agent 是事务外副作用，以 Operation 记录 intent、phase、外部资源标识与 recovery outcome。启动后核对未完成 Operation，不盲目重放 start、commit、merge、send answer 或 promote。

跨聚合由应用服务在单 SQLite 事务中验证所需约束；Graph 检测在写锁保护下完成，避免两条并发边分别合法但合起来成环。
