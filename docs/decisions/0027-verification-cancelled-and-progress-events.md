# ADR-0027：verification run 的一等 `CANCELLED` 状态与长命令实时进度事件

Status：Accepted（本轮实现：FOUNDATION-047；无新增确认门禁）

## Context

ADR-0019 把 `task.run`/`task.verify` 变成持久 Operation，并在 Consequences 里明确留下两项「未实现（不得声称）」：

1. **verification run 的独立 `CANCELLED` 状态**。ADR-0019 D05 当时按用户选择复用现有枚举，取消记成 `ERROR` + `outcomeCode = CANCELLED_BY_USER`，并说明「不为 `verification_runs` 增加 `CANCELLED` 状态」属于状态机规格变更，保留给后续独立决策。后果是每个读取方（`task verification list`、`task.status.verifications`、UI 表格）都拿到一个 `ERROR`，只能靠 `outcomeCode` 才能区分「用户停掉的」与「命令失败的」。这不是存储缺陷，而是表达缺陷：一个用户主动停止的运行在状态位上和命令非零退出同类。
2. **token 级实时进度事件**。当时进度是「查询命令 + 轮询」：长命令的步骤写进 `operation_progress`，UI 每 1.5s 读一次 `task.status`。这在数据层没有事实错误，但把「进度可见」做成了轮询：既在常态路径上持续产生查询负载，也让进度事件无法被脚本按游标消费（`events list/tail` 看不到任何进展）。

本轮的实现约束与已确认决策：

- `PROJECT_SPEC.md` §1.1：效率至上，FULL 零确认预算保持 0；任何新增门禁都要先证明不增加常态步骤数。
- 事件模型（`docs/architecture/event-model.md` §2/§3）已经把 `domain_events` + `event_deliveries` + 订阅/SSE 定为唯一事件投递通道，§4 明确**原始终端/PTY 字节不得进入 domain event**，ADR-0013 的 `session.transcript` 是只读的、刻意不是事件的细粒度通道。
- `apps/runtime/src/verification-service.ts` 的取消语义已经诚实：只有确认进程组静止后才落终态，未确认时保留占用（`RECONCILE_REQUIRED`/`CANCEL_UNCONFIRMED`）。
- ADR-0021 已经把「Runtime 拥有资源的回收」收敛为显式 `reclaim plan/apply/records` 与 append-only 账本，并要求默认保留失败现场。

## Options

1. `CANCELLED` 的表达：
   - A. 重建 `verification_runs`，把 `CANCELLED` 加进 CHECK，作为一等终态；**（选择）**
   - B. 保持 `ERROR` + `outcomeCode`，只改读取方的显示；
   - C. 新增独立 `cancellations` 表，不改状态枚举。
2. 进度通道：
   - A. 复用现有步骤表，继续用查询命令 + 轮询；
   - B. 把进度作为 `domain_events` 事实发布，走既有 outbox/订阅/SSE；**（选择）**
   - C. 新增独立的进度订阅端点（第二条业务语义通道）。
3. 进度粒度：
   - A. 只发步骤边界事件（Agent 运行与验证都只有步骤级）；
   - B. 步骤边界 + 验证命令的每个输出块（chunk）一块一事件，不设上限；
   - C. 步骤边界 + 验证命令输出块事件，但按每命令最小间隔合并；**（选择）**
   - D. 把 provider/PTY 的 token 字节也作为事件发布。
4. 被取消的验证副本：
   - A. 取消时立即删除副本；
   - B. 与失败现场一样默认保留，仍由 ADR-0021 的 `reclaim` 显式回收；**（选择）**
   - C. 为取消的副本新增一条独立回收路径。
5. UI 的进度展示：
   - A. 改为事件驱动，完全去掉轮询；
   - B. 事件驱动为主，仅在事件流不是 `live` 时保留低频兜底轮询；**（选择）**
   - C. 保留原 1.5s 轮询，只额外显示事件数量。

## Decision

### D01：`CANCELLED` 成为 `verification_runs` 的一等终态（schema v17）

- 沿用既有 `executions_v9`/`verification_runs_v6` 的**重建**模式（SQLite 无法就地放宽 CHECK）：新建 `verification_runs_v17`、原样复制全部列与行、`DROP` 旧表、改名、重建两个索引。
- 一致性 CHECK 保持并扩展：`QUEUED`/`RUNNING` 必须没有 `ended_at`/`outcome_code`；`PASSED`/`FAILED`/`ERROR`/`CANCELLED`/`STALE` 必须两者都有。因此「取消但没确认」在数据库层面就写不成一个已完成的 run。
- 保留既有 `UNIQUE(project_id,command_id)`、`UNIQUE(operation_id)` 与两个复合外键，迁移后 `PRAGMA foreign_key_check` 必须为空（无表引用 `verification_runs`，所以无需关闭外键）。
- `integration_verification_runs` **不改**：它的 Operation kind 不由 `task.operation.cancel` 触达，没有需要表达的取消路径；不为将来可能存在的需求提前放宽 CHECK。
- 迁移只在既有升序链尾部追加 `if (version < 17)`；本格占用 **v17**。集成时 C3 先于原预留 v16 的 C2 schema 改动进入 dev，因此 v16 实际未使用。已有数据库可能已经标记为 17，后续 C2 不得再补一个会被跳过的 `if (version < 16)`；若需要 schema 变更，必须使用下一个高于 17 的版本并覆盖从 17 升级。

### D02：取消只在确认静止后才落 `CANCELLED`

- 确认静止（`stopOwned` 报告 `stopped: true`）→ `state = CANCELLED`、`outcomeCode = CANCELLED_BY_USER`，`evidence_json` 记录 `cancelledBy`/`cancelledAt`/`stoppedProcessGroup`/`previousState`。
- 无法确认静止 → 沿用 ADR-0019 的诚实语义：Operation `RECONCILE_REQUIRED` + `CANCEL_UNCONFIRMED`，**verification run 保持 `RUNNING`** 且副本保留，命令面退出码 1。数据库 CHECK 使「未确认却写 CANCELLED」不可能发生，而不是只靠调用者自觉。
- Runtime 重启时被中断的 run 仍记 `ERROR/RUNTIME_RESTARTED`（recovery 语义不变）：重启无法证明进程已静止，所以那不是取消。

### D03：被取消的副本与失败现场同类，回收仍只走 `reclaim`

- 取消路径不删除副本（可能仍有 writer），与 ADR-0019 一致；`executeVerificationPolicy` 在取消时明确返回 `removed: false`。
- ADR-0021 的判定集合扩充：`CANCELLED` 与 `FAILED`/`ERROR` 一样属于 failure scene，`reclaim.plan/apply` 默认 `RETAIN/FAILURE_SCENE`，只有 `--include-failure-scenes` 才 `RECLAIM/FAILURE_SCENE_INCLUDED`。
- **不新增回收路径、不新增开关**：回收的唯一入口仍是显式的 `reclaim plan/apply/records`，且只删注册过、归属校验通过的资源。
- 仍然 `QUEUED`/`RUNNING` 的 run 无论参数如何一律 `REFUSE/ACTIVE_VERIFICATION`（沿用 D01 第 4 条活跃判定）。

### D04：进度是领域事件，不是响应里的字段

- 新增持久表 `operation_progress_events(operation_id, progress_sequence, event_id, dedup_key, phase, detail_json, recorded_at)`：
  - `PRIMARY KEY(operation_id, progress_sequence)`：每个 Operation 一条**单调**序列，消费方可据此排序并丢弃迟到事件；
  - `UNIQUE(operation_id, dedup_key)`：同一边界重发是 no-op，返回已分配的序号，而不是追加第二条事实；
  - `event_id UNIQUE`：与 `domain_events.event_id` 一一对应，`domain_events.sequence` 仍是全局投递游标；
  - 行是 append-only，不更新不删除。
- 每个事件在同一事务里写 `domain_events`，`event_type` 为 `OperationProgressed`（`phase ∈ STEP|OUTPUT|CANCEL`）或 `OperationSettled`（`phase = SETTLED`），`aggregate_type = 'Operation'`、`aggregate_id = operationId`、`correlation_id = operationId`。因此投递完全复用既有 `event_deliveries` outbox 与 `events.subscribe`/HTTP SSE，不新增第二条通道。
- payload 规约：`{ operationId, projectId, taskId, kind, progressSequence, dedupKey, phase, verdict: false, ... }`。
  - **`verdict: false` 是显式字段**，不是约定：进度事件只说明 Runtime 到达了哪里。verification 的判定只由 `VerificationCompleted`（含 `state`）表达，`task.verify --background` 的退出码 0 仍然只表示「已受理」。UI 侧的结构化校验**拒绝**任何 `verdict !== false` 的进度 payload，因此「收到进度就把已受理显示成通过」在客户端也不可能发生。
  - `STEP`/`CANCEL` 事件附带 `stepKey`/`step`/`stepState`/`stepSequence`，与 `operation_progress` 里那行步骤同源同值（同一事务写入）。
  - `OUTPUT` 事件只带 `commandId`/`stream`/`chunkIndex`/`chunkBytes`/`streamBytes`/`stdoutBytes`/`stderrBytes`/`elapsedMs`——**只有大小与耗时，绝不包含命令输出文本**（event-model §4 的报告边界）。
- **不重放已判定步骤**：Operation 一旦终态，`recordOperationProgressEvent` 拒绝发布事件（返回 `refused: 'TERMINAL'`），但仍把步骤写成事实（那是「Runtime 到达过这里」的记录）。被杀死的命令的迟到回调因此不会让已完成的长命令看起来还在动。
- **settle 一定被发布**：`completeOperation` 在 Operation 曾发布过进度事件时，于同一事务内发布 `OperationSettled`；从未发布进度的 Operation（workspace 准备、Agent start、成果 commit、integration、promotion、reclaim）不进入进度流。这条规则让所有写入路径（含不由本格拥有的 run 失败收口路径）都无需改动即可获得终止事件。
- **reconcile 不伪造进度**：启动时的 `reconcileInterruptedRunOperations` / `reconcileInterruptedVerifications` 只按已记录事实收口，并发布 `OperationSettled`（`detail.reconciled: true`），不重放步骤、不补造中间进度。

### D05：进度粒度（诚实说明「token 级」到哪一步）

- **verification 命令**：步骤边界 + 每个输出块。为避免一条话多的命令在 60s 内产生上千条事实，按命令设最小间隔合并（`outputProgressIntervalMs`，默认 100ms）；**每个命令的第一块总是立即发布**（命令一旦产生输出就立刻可见；块计数按命令而非按 stream，因此 stderr 的首块可能被合并），终止步骤事件携带最终字节数，因此合并只会丢中间的低频观测，不会丢结论。
- **`task.run`**：Agent 运行的进度事件是**步骤边界**（`RUN_REQUESTED` → `WORKSPACE_PREPARED` → `EXECUTION_RESERVED` → `AGENT_SESSION_STARTED` → `AGENT_SETTLED`/`RUN_FAILED`）加 `OperationSettled`，全部实时投递。
  - 明确**不做**：把 provider/PTY 的 token 或原始流字节变成 domain event。event-model §4 与 ADR-0013 已经把它们划在事件之外：provider 会话文件是只读的 `session.transcript` 通道，刻意不是事件、不是 attach、不产生投递证据。把 PTY 字节塞进事件会同时违反「原始 PTY 数据不进 domain event」和「终端输出按不可信内容处理」两条已确认边界。
  - 因此 run 的更细粒度（provider 事件级）需要 `agent-runtime-service.ts`/`agent-observation-service.ts` 的 Observation 流回调，这两个文件属于并发的 C4 格，本格不改。记录为剩余项，不声称已实现。

### D06：UI 事件驱动 + 低频兜底（取舍写明）

- `App.tsx` 在既有 SSE 帧回调里处理 `OperationProgressed`/`OperationSettled`：`STEP`/`CANCEL` 按 `stepKey` 合并进该 Operation 的步骤列表（重复或乱序事件不重复追加），`OUTPUT` 只刷新「最新输出：stdout N B · stderr N B · 已运行 Ns」的一行活跃度，`SETTLED` 更新状态并触发**一次**同命令面的详情读取（终态还包含 result 与 verification 行，事件本身不是完整投影）。
- 轮询取舍：删除原 1.5s「有非终态 Operation 就轮询」。仅当存在非终态 Operation **且事件流不是 `live`** 时保留 5s 兜底轮询。理由：事件流是 best-effort 的订阅（断线只是不影响 Runtime，客户端要凭游标重连），若订阅已停止或被拒绝，没有兜底会让进度僵在旧值直到用户手工刷新；而 5s 且仅在 `!live` 时的代价远低于原先常态 1.5s 轮询。**没有**把进度塞进命令响应里让 UI 轮询。
- 取消按钮与 `CANCELLED` 展示：
  - Operation 行按 `result.cancelled === true` 显示「已取消（用户）」而不是 `FAILED`；`CANCELLED` 的 verification run 在验证表与「最近验证」摘要里用 `labelValue` 的「已取消」并新增 `.state-cancelled` 样式（warn 色，与 `FAILED`/`ERROR` 的 danger 色区分），不再被读成失败。
  - 取消按钮只在 Operation 非终态时出现，走的就是 `task.operation.cancel`；未确认静止时 CLI 退出码 1 并保留占用，UI 显示 `RECONCILE_REQUIRED`。

### D07：效率成本（门禁评估）

- 新增确认/审批/沙箱：**0**。FULL 常态路径步数与等待不变；没有新增 flag、没有二次确认。
- 代价：
  - 取消一个验证仍要先确认进程组静止（最多 2s+2s 宽限），这是「不谎称已静止」的必要等待，只在用户主动取消时发生。
  - 进度事件写入随命令输出量增长（默认每命令每 100ms 至多一条）；输出块事件是 `STRICT` 与 `FULL` 都有的观测成本，可用 `outputProgressIntervalMs` 调高。
  - UI 从常态 1.5s 轮询改为事件驱动，减少了常态查询负载。

## Consequences

- **已实现**：schema v17（重建 `verification_runs` 加 `CANCELLED` + 新表 `operation_progress_events`）；`VerificationState` 增加 `'CANCELLED'`；`completeVerificationRun` 接受 `CANCELLED` 并在同一事务发布 `OperationSettled`；`recordOperationProgressEvent`/`listOperationProgressEvents`；`completeOperation` 对发布过进度的 Operation 追加发布 `OperationSettled`；`recordRunStep` 同时发布事件；`LongOperationService` 的输出块事件与合并、取消落 `CANCELLED`；`VerificationExecutionCallbacks.onOutput`；`reclaim` 把 `CANCELLED` 视为 failure scene；CLI `task operation list/get` 显示「已取消（用户）」、usage 说明进度在事件流；UI 事件驱动合并 + 5s `!live` 兜底 + `CANCELLED` 展示。
- **验证过的语义边界**：未确认静止永远不落 `CANCELLED`（DB CHECK + 调用路径双重保证）；进度事件永不携带判定（`verdict: false` + UI 拒绝非 false）；终态后不再发布事件；重启 reconcile 只按事实收口且 `reconciled: true` 可辨；取消的副本仍只能经 `reclaim` 回收。
- **已知缺口 / 不得声称**：
  - `task.run` 的进度是步骤级 + settle，不是 provider 事件级；provider token/PTY 字节永不进入 domain event（见 D05）。
  - 部分输出块事件会被合并丢弃（默认 100ms 地板）；事件是活跃度事实，不是完整输出日志（原始输出从不入库，符合既有验证证据边界）。
  - `integration_verification_runs` 没有 `CANCELLED` 状态。
  - Runtime 重启时仍 `RUNNING`（含取消未确认）的 run 记 `ERROR/RUNTIME_RESTARTED`，不是 `CANCELLED`。
  - **文档同步未做（需后续一次 doc-sync）**：`docs/architecture/state-machines.md` 的 Task Verification 状态列表（`NOT_RUN → QUEUED → RUNNING → PASSED | FAILED | ERROR` + `STALE`）现在还应包含 `CANCELLED`；`docs/architecture/event-model.md` §2 事件目录现在还应包含 `OperationProgressed` 与 `OperationSettled`（payload 见 D04）。本格领地只含 `docs/tasks/README.md` 与 `docs/decisions/0027-*.md`，按 ADR-0019 的先例不在本格改架构文档，因此在此显式记录该不一致，不静默重解释规格。
- 不新增门禁；FULL 零确认预算仍为 0。

## Verification

只用 CLI/命令面与 HTTP/SSE 传输断言（ADR-0008），不使用浏览器/桌面/键鼠自动化：

1. `apps/runtime/test/verification-cancel.test.ts`（4 项）：已 `user_version=16` 的库升级到 17 后既有 run 行、索引、`foreign_key_check` 全部保留/干净；`CANCELLED` 缺少 `ended_at`/`outcome_code` 被 CHECK 拒绝、`QUEUED` 带终态事实也被拒绝；`17` 已是当前版本时不重跑重建；确认静止 → `CANCELLED` + `CANCELLED_BY_USER` + 副本保留 + `listVerificationRuns` 表达为 `CANCELLED` + `reclaim` 默认 `RETAIN/FAILURE_SCENE`、`--include-failure-scenes` 才 `RECLAIM/FAILURE_SCENE_INCLUDED`；未确认静止 → run 仍 `RUNNING`、Operation `RECONCILE_REQUIRED`、`reclaim` 以 `REFUSE/ACTIVE_VERIFICATION` 拒绝。
2. `apps/runtime/test/operation-progress-events.test.ts`（8 项）：`progressSequence` 单调、`eventSequence` 递增、同一 `dedupKey` 重发不追加、按序号的排他游标读取、终态后不再发布事件（步骤仍记录）、`events.list` 同型读取；订阅（`events.subscribe` 的同一 hub）按游标收到 `OperationProgressed`；`task.run` 的五个步骤 + 一次 settle 且不含 `PASSED`；验证的每个输出块事件（间隔 0）字节数递增且**不含命令输出文本**；默认间隔下输出事件被合并到 1 条而终止步骤仍带真实总字节数；后台 `task.verify` 受理后进度里没有 `PASSED`，判定只出现在 `VerificationCompleted`；**HTTP/SSE** 载波上确实收到 `OperationProgressed` 帧；从未发布进度的 Operation 不进入进度流。
3. `apps/runtime/test/cli-task-run-progress.test.ts`（2 项，真实 CLI 子进程 + 真实 Runtime + 独立 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider）：`task.run` 的进度事件经 `events list` 可读、`progressSequence` 单调、无 `state` 字段；settle 为 `verdict: false`；`task verify --background` → `task operation cancel` 后 `task status` 与 `task verification list` 都读到 `CANCELLED`（不是 `ERROR`），`events list` 读到验证的步骤与 `OperationSettled`，`dev` 未变、Task 仍 `EXECUTED`。
4. 实际运行：`bun run check` 退出码 0（根与 UI `tsc --noEmit`、231 项 Vitest、**389 项 Bun tests 0 fail**（46 个文件）、UI Vite 构建）；`bun run check:fast` 退出码 0（231 项 Vitest + 229 项 unit Bun tests 0 fail）。本格未改动 `packages/domain`/`packages/contracts`，Vitest 数量与本格无关。
5. 未验证：UI 的视觉、键盘焦点、窄屏与取消按钮观感（只能由用户人工确认，`bun run check` 通过不等于 UI 验收）；`task.run` 的 provider 事件级进度（见 D05）；真实 provider 下的取消超时复验；并发压力下的事件量。

## 关联文档

- `PROJECT_SPEC.md` §1.1（第一原则）、§2.12/§2.24、§3、§6
- ADR-0008（效率至上 / CLI 完备 / 测试边界）、ADR-0011（默认 FULL 零确认）、ADR-0013（只读执行过程视图与「不是事件」边界）
- **ADR-0019（本格补齐其 D05 与「未实现」列表中的两项）**、ADR-0021（副本回收语义与失败现场默认保留）
- `docs/architecture/event-model.md` §2/§3/§3.1/§4、`docs/architecture/state-machines.md` §1（Task Verification；待 doc-sync）
- `docs/tasks/README.md` FOUNDATION-039「明确未做」、`## NEXT` 第 2 项剩余、FOUNDATION-047
