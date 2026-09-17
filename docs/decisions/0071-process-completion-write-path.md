# ADR-0071：Process 类型化写路径、完成事实与只读进度

Status：Accepted（S5 lane 在 `lane-contracts-s5-s7.md` §2 冻结的目标语义内做出的实现决策，2026-09-17）。本 ADR 不扩大 ADR-0070 的能力边界：Process 的 Agent runner、原生控制 API 与 intention 解释仍属后续波次。

**Relates to** ADR-0070（Service / Process / Agent / Signal 内核）。

## Context

ADR-0070 §4 与 D10 把 Process 定为「短期、目标有界、允许阻塞的 Agent supervisor」，并要求 Execution 在迁移期继续是权威执行事实。S5 要落地的是这条迁移关系里最小的纵向切片：Process 有真实、类型化的写路径与完成事实，`process get` 的只读投影包含可核验的进度，终态不复活、重复完成幂等，不支持的能力继续如实拒绝。

ADR-0070 冻结了目标语义，但没有回答 S5 必须回答的四个工程问题：

1. **完成事实怎么进入系统**：由调用方直接写 `processes.status`，还是把完成当作一条类型化 Signal 走既有 inbox/receipt 路径？
2. **永久拒绝怎么处理**：`expectedVersion` 过期这类「重试一万次也不会变合法」的失败，是走既有的五次自动重试后退避，还是立即 dead-letter？
3. **v37 没有的事实怎么报**：`processes` 没有 token/成本/工具调用计数列，只读进度视图应该推算、省略，还是如实标记不可得？
4. **谁来写 `processes.status`**：Execution 投影出的 Process 是否也允许类型化写路径修改它的状态？

## Options

- **完成事实**：（A）直接 SQL/API 改 `processes.status`；（B）`PROCESS_COMPLETED` `SIG_A` + `processes.version` CAS + 既有 `signal_receipts` 幂等；（C）新建一张 completion 表。
- **永久拒绝**：（A）一律当作可重试失败，走 1/5/30/120/300 秒重试后 dead-letter；（B）区分永久失败立即 dead-letter，保留稳定码；（C）永久失败直接抛弃信号。
- **进度字段**：（A）用 session/消息数/时钟推算 token 与成本；（B）省略没有事实的字段；（C）字段保留但显式 `null`（UNAVAILABLE），并在文档与 schema 注释中写明。
- **Execution 投影的 Process**：（A）允许类型化写路径改它的 `processes.status`（同时 Execution 仍会投影）；（B）返回稳定码拒绝，状态只由 Execution 权威提供。

## Decision

### D01 完成是一条类型化 `SIG_A` 事实

`PROCESS_COMPLETED`（payload `{processId, outcome, expectedVersion, summary}`）是 `SIG_A`，只注册到 **ROOT / PROJECT / TASK**——Process 的 parent Service 必为三者之一；Scheduler 与 Attention 监督不了 Process，以 `SIGNAL_NOT_ACCEPTED` 拒绝。存储侧的 `completeProcess` 在**同一事务**里做状态 CAS 更新、写 `signal_receipts` 回执并 ACK；`(targetServiceId, idempotencyKey)` 相同即返回同一 receipt，不二次改状态。

不选（A）：那会让「完成」绕过 receipt 与审计，且与 ADR-0070 D04 的 inbox 语义分叉。不选（C）：多一张表就多一个权威。

### D02 永久拒绝立即 dead-letter，并保留稳定码

`PROCESS_VERSION_CONFLICT`、`PROCESS_PARENT_MISMATCH`、`PROCESS_STATUS_SOURCE_READONLY`、`PROCESS_TERMINAL`、`PROCESS_COMPLETION_MISMATCH`、`INVALID_SIGNAL_PAYLOAD` 以及 domain 的 `INVALID_PROCESS_TRANSITION` 都是**永久失败**：`KernelStorageError` 以 `retryable=false` 抛出，dispatcher 首次尝试即写入 `DEAD_LETTER` 并记录 `lastErrorCode`。payload 不会因为等待而变合法，重试只会在几分钟里把同一条错误写六遍。调用方要重试必须显式 `signal retry`（并把 `expectedVersion` 改成当前版本）。

不选（A）：把永久失败伪装成暂时失败，会让 CLI 退出码 3（等待）与实际语义不符。不选（C）：ADR-0070 §5.3 明确 dead-letter 只表示自动消费停止，历史不能丢。

### D03 只读进度：`null` 表示 UNAVAILABLE，不推算

`process get|list` 的 `progress` 包含 `budgetKnown`、`lastProgressAt`、`tokenUsage`、`costUsd`、`toolCallCount`。

- `lastProgressAt` 是该 Process 最近被记录的**事实**时间（Execution 的起止时间或 Process 内核事件时间）。
- `budgetKnown` 表示 `processes.budget_json` 是否已记录；v37 没有写预算的路径，因此恒为 `false`。
- `tokenUsage`、`costUsd`、`toolCallCount` 在 v37 **没有对应列**，恒为 `null`（UNAVAILABLE）。schema 注释与文档都写明这一点。

不选（A）：从 session 时长、消息条数或 token 估算里造出数字，就是把「不知道」写成「知道」，正是第一原则禁止的撒谎式进度。

### D04 `status_source='EXECUTION'` 的 Process 只读

`transitionProcess` 与 `completeProcess` 对 `status_source='EXECUTION'` 的 Process 一律以 `PROCESS_STATUS_SOURCE_READONLY` 拒绝。今天所有 `DEVELOPMENT` Process 都由 Execution 投影而来，它的状态与 `version` 由 Execution 权威提供；允许第二条写路径就是同一个事实两个 writer。原生 Process（`status_source='PROCESS'`）的完成与迁移由本 ADR 的写路径负责。

### D05 同一 Task 至多一个非终态 Process，且每次投影都校验

`one_held_execution` 唯一索引保证一个 Task 只有一个持有资源的 Execution。S5 在此之上把 domain 规则 `assertProcessSuccession` 用在每次 `reconcileProjections`：若投影后同一 Task 出现两个非终态 slot holder，则以 `PROCESS_PREDECESSOR_ACTIVE` 失败，而不是报告一个两个 Process 都声称拥有的状态。`INTENTION` Process 不占 Task 执行 slot，因此不受这条规则限制。

## Consequences

### Positive

- 完成事实与其它内核事实共用同一条可靠路径：至少一次投递 + receipt 幂等收敛，Runtime 重启不丢。
- 永久失败与暂时失败在退出码上可区分（1 vs 3），运维不必读日志猜语义。
- 进度视图不撒谎：v37 拿不到的事实显式为 `null`，未来 schema 真的记录后再填值即可，不需要改契约形状。
- 单一 writer 规则让「谁改了这个 Process」不需要读两份表。

### Costs and risks

- 完成失败需要调用方显式重发或 `signal retry`；这比自动重试更啰嗦，但避免了把永久错误写六遍。
- `progress` 新增字段是 `processViewSchema` 的破坏性收紧（`strictObject`）；其它 lane 若自行构造 Process 视图会失败，必须由存储层提供。
- `lastProgressAt` 对没有内核事件的 Execution-backed Process 取 Execution 时间；它不是「模型进度百分比」，文档必须保持这个口径。
- 每次 reconcile 多一条校验查询；它换来的是投影不变量被真实检查，而不是被假定。

## Verification requirements

1. 非法迁移与过期 `expectedVersion` **零部分应用**：`processes.version`、`status` 与 `domain_events` 都不变。
2. 同一 `(targetServiceId, idempotencyKey)` 的重复完成只写一条 receipt、只加一次版本。
3. 终态 Process 不可复活；`PROCESS_TERMINAL` 之后版本不动。
4. Execution 投影的 Process 拒绝 `transitionProcess`/`completeProcess`，并保持 `executions` 行为唯一权威。
5. 原生 Process 的 `input/pause/resume/terminate` 仍以 `PROCESS_CONTROL_UNAVAILABLE` 拒绝。
6. 同一 Task 出现两个非终态 slot holder 时投影以 `PROCESS_PREDECESSOR_ACTIVE` 失败。
7. 验收只用 CLI 命令面与 Runtime 命令面；不使用桌面自动化。

## Related

- ADR-0070 Service / Process / Agent / Signal 内核
- `docs/architecture/service-process-signal.md` §4.1、§5.1
- `docs/guides/cli/kernel.md`
- `docs/roadmap/lane-contracts-s5-s7.md` §2
