# ADR-0028：修订投递确认（真实 ACK 或经核验的 successor Execution）与重启后 stale ACTIVE Session 的启动收敛

Status：Accepted（本轮实现：FOUNDATION-048；无新增确认门禁、无新增权限门禁）

## Context

`PROJECT_SPEC.md` §2.11 与领域 Execution FSM 从 Phase 0 起就要求：运行中的 Task 可以修订；修订必须记录暂停、投递与**应用确认**；确认新约束后才恢复；无法可靠暂停或确认时保留现场并重新执行。该 FSM（`packages/domain/src/execution.ts`）已经有 `REVISION_REQUESTED` / `REVISION_ACKNOWLEDGED`（拒绝 stale ACK）/`RESUME_CONFIRMED`（未确认最新 revision 不得恢复）。但工程上一直缺两件东西：

1. **投递本身没有事实记录。** 到本轮为止，`task revision` 没有任何命令面，也没有任何表记录「新 revision 投给了哪次 Execution、哪个 Session incarnation、什么时候、用哪种通道、结果是什么」。`docs/tasks/README.md` 的 `## NEXT` 第 4 项因此长期挂着「revision 投递确认」。
2. **重启后 `agent_sessions`/`executions` 仍写着 ACTIVE/RUNNING 的投影没有收敛。** 启动 reconcile 已覆盖 workspace prepare / agent start / answer / 结果 commit / verification / integration / promotion / reclaim / session handoff / session terminal，但 `reconcileSessionHandoffs` 在代码注释里明确写下它**故意不碰** `agent_sessions`/`executions`/`tasks`：「projecting a provider state the Runtime cannot observe is a different (still open) reconciliation question」。这就是那个 open question。

本轮的硬约束（既有决策，不是新选择）：

- **Pi 没有可靠的 revision ACK**。`docs/spikes/pi-0.84.4.md` 能力矩阵写死 `revisionAcknowledgement = UNSUPPORTED`（「不从自然语言推断 ACK；修订走停止并新建 Execution」）；`docs/spikes/pi-session-handoff.md` 进一步证明：没有 session file 排他锁、"杀掉 provider 进程 ≠ 工作区静止"（孤儿工具子进程会继续写）、退出码不能判定正常交接、不能从屏幕文本推断业务事实。因此「消息发出去了」在本项目里**不能**当作确认。
- **ADR-0001 时代的 fallback 语义已经确立**：无法可靠确认时，协作停止旧 Execution、保留现场、以完整新 revision 新建 Execution；旧 Execution 为 `SUPERSEDED`。
- **§1.1 第一原则**：效率至上（FULL 零确认，正确性核对不得包装成审批）、CLI 必须完备且可脚本化、测试只用 CLI/命令面。
- **ADR-0011 / ADR-0023**：正确性核对（ref/ownership/process identity/静止证据/幂等）继续有效，但不得伪装成权限审批；单 writer 必须由 Runtime 强制。
- **ADR-0021**：Runtime 自有资源（worktree / 验证副本 / integration worktree）只能经显式 `reclaim` 回收，失败现场默认保留。

## Options

1. 修订投递的「确认」定义：
   - A. 把「已把新 revision 写进 provider 会话/已发送」记为已投递（旧 ADR-0001 的「记录暂停、投递」，实现上最省事）；
   - B. 只承认 Adapter 返回的**结构化 ACK**为确认，其余一律未确认；不支持的 Adapter 走停止并新建 Execution；**（选择）**
   - C. 用自然语言/会话文件内容推断 Agent 是否理解新约束。
2. 不支持的 Adapter（当前包括 Pi）如何「投递」：
   - A. 实现一个 Runtime 侧的"热更新"提示写入，并把它记成已投递；
   - B. 如实记录 `CHANNEL_UNSUPPORTED`，并让既有「协作停止 + 新建 Execution」成为唯一处置；**（选择）**
   - C. 直接拒绝创建 revision，要求用户先停止 Task。
3. 投递记录的形态：
   - A. 只在 `domain_events` 里写一条事件（不可按投递查询、无法表达重试与超时）；
   - B. append-only 的投递需求 + 每次尝试一行（通道、Execution/Session/incarnation、起止时间、结果、证据）；**（选择）**
   - C. 与 Execution 行内联的若干列（重试会覆盖历史）。
4. 重启后发现 Session/Execution 仍 ACTIVE/RUNNING：
   - A. 按进程名/PID 存在与否猜测并**恢复 RUNNING**（或直接判 FAILED）；
   - B. 一律按所有权证据写 `RECOVERY_REQUIRED`，保留资源并写明观察到的事实；**（选择）**
   - C. 杀掉记录的进程后写 FAILED。
5. 所有权证据的含义：
   - A. 「记录的进程都不在了」即可判定工作区静止、可复用；
   - B. 只作为**观察事实**记录：进程树是 provider 存活时的快照，快照之后 fork 的、或已 reparent 出去的进程不在其中，所以任何分支都不等于静止证明；**（选择）**
   - C. 只要 provider 不在就删除 worktree 现场。

## Decision

### D01：修订投递是一等需求，确认只能来自「真实 ACK」或「经核验的 successor Execution」

- 新增领域模块 `packages/domain/src/revision-delivery.ts`（纯 FSM，`PENDING → IN_FLIGHT → {ACKNOWLEDGED | UNACKNOWLEDGED | CHANNEL_UNSUPPORTED | TIMED_OUT | FAILED}`，以及任意未满足态 `→ SUPERSEDED_BY_RESTART`）。satisfied 只有两种状态：`ACKNOWLEDGED`（带 Adapter 的结构化 evidence）与 `SUPERSEDED_BY_RESTART`。`PENDING`/`IN_FLIGHT`/`UNACKNOWLEDGED`/`CHANNEL_UNSUPPORTED`/`TIMED_OUT`/`FAILED` 一律 unsatisfied 且**保留可见**，不存在「静默丢弃」路径。
- 领域守卫直接落地 spec 的两条要求：ACK 必须命名本投递的 revision，且 `requiredRevisionId`（记录时刻 Task 的 current revision）必须仍是它，否则 `STALE_REVISION_ACKNOWLEDGEMENT`；已满足的投递再次 ACK/再开 attempt 抛 `REVISION_ALREADY_ACKNOWLEDGED`（重复/重放 ACK 是可见错误，不是无害忽略）；`SUPERSEDED_BY_RESTART` 必须携带 successor 记录在案的 revision，不一致抛 `SUCCESSOR_REVISION_MISMATCH`。
- 这些拒绝不是调用方自觉：storage 侧的每次状态推进都经 `transitionRevisionDelivery` 应用到行上（`state`/`attempt_count`/`evidence_ref`/`version` 同一 UPDATE），`version` 是乐观版本，并发处置互相冲突时 `CONCURRENT_MODIFICATION`。

### D02：能力如实——`UNSUPPORTED` 就是 `UNSUPPORTED`，且能力声明必须与端口一致

- 投递尝试前 Runtime **实时** `probe()` Adapter 并向 `capabilities.revisionAcknowledgement` 取值：
  - 不是 `SUPPORTED` → 尝试记 `CHANNEL_UNSUPPORTED`，evidence 为 `capability:<实际值>`。Pi 因此永远是 `capability:UNSUPPORTED`，**不会**被写成「已更新会话」。
  - 声明 `SUPPORTED` 但没有 runtime 侧的可选端口 `applyRevision`（结构判定 `supportsRevisionDelivery`）→ 同样记 `CHANNEL_UNSUPPORTED`，evidence 为 `capability:SUPPORTED:applyRevision-missing`。
  - 声明 `SUPPORTED` 且端口存在、返回 `acknowledged: true` 但**没有** evidence → 记 `UNACKNOWLEDGED`/`MISSING_ACK_EVIDENCE`。没有证据的 ACK 不是 ACK。
  - 只有 `applyRevision` 返回带 evidence 的确认才写 `ACKNOWLEDGED`。
- 端口刻意定义在 Runtime（`apps/runtime/src/revision-delivery-service.ts`），**不改 `packages/agent-adapters/**` 与 contracts 的能力区**（那是 D2 领地）。本轮不实现任何真实 Adapter 的 `applyRevision`，也不把 `revisionAcknowledgement` 从 `UNSUPPORTED` 改成别的值。
- Session 不是 live（`EXITED`/`DISCONNECTED`/未记录）时不做会话内投递，而是记 `CHANNEL_UNSUPPORTED`（`session:<state>`）：revision 只能进**活着的** conversation，已经结束的轮次需要 successor Execution。
- 用 `withDeadline`（ADR-0025 修好的、会清理 timer 的实现）给会话通道设投递期限；超时记 `TIMED_OUT`。

### D03：不支持的 Adapter 走既有停止并新建 Execution，确认来自 successor 行本身

- 命令面 `task revision delivery resolve --action stop-and-restart` 是「未确认」的显式处置：先 `pauseOrCancelTask(PAUSE)` 协作停止当前 Execution（释放进程，确认静止才落 `PAUSED`），再用既有的 `resumePausedTask` 在同一 workspace 新建 Execution——`reserveExecution` 总是用 Task 的 **current** revision，所以 successor 的 `applied_revision_id` 就是新 revision。
- 投递只有在**读回 successor Execution 行**并确认其 `applied_revision_id === 投递的 revision` 之后才被标记 `SUPERSEDED_BY_RESTART`（该比较在同一个写事务内完成）。这是事实，不是 Runtime 的声明；`evidence_ref` 写 `execution:<successor-id>`。
- 停止无法确认静止（`releaseExecutionProcess` 不能证明进程退出）→ 尝试记 `FAILED/STOP_UNCONFIRMED`，命令返回 `RECOVERY_REQUIRED`、退出码 1，资源全部保留（沿用 ADR-0016/0023 的诚实语义）。
- Task 期间又出现更新的 revision（successor 会带更新的 revision）→ `SUCCESSOR_REVISION_MISMATCH`：**不暂停、不新建、不标记满足**，旧投递保持 unsatisfied 记录（它是历史事实），命令退出码 1。
- 旧 revision 的成果不能当作新 revision 的交付证据，这一点由既有代码保证并被本轮测试覆盖：`prepareResultCommit` 在 `tasks.current_revision_id !== executions.applied_revision_id` 时抛 `STALE_REVISION`；`completeResultCommitCapture` 亦有同源守卫。

### D04：超时与重启中断的尝试都按事实收口，不重放

- 进程内超时 → 尝试 `TIMED_OUT`（记录期限与事实）。
- 启动时（`RevisionDeliveryService.reconcileAtStartup`）对所有仍 `IN_FLIGHT` 的尝试收口：期限已过记 `TIMED_OUT`；没有期限（正常路径不会出现，只可能是被杀在途中）记 `FAILED/RUNTIME_RESTARTED`。两者都让投递保持 unsatisfied 并要求显式处置，**没有**「重启后自动重投」。
- 被拒绝的 stale ACK 不会留下悬挂的 in-flight 尝试：守卫回滚投递状态后，尝试本身在独立事务里记 `FAILED/STALE_REVISION_ACKNOWLEDGEMENT`。否则该投递会卡在 `IN_FLIGHT` 且任何重试都打不进去。

### D05：重启后 stale ACTIVE Session 的启动收敛（`reconcileStaleAgentSessions`）

- 新增 `apps/runtime/src/recovery-service.ts` 尾部函数：对 `listStaleAgentSessions()` 返回的（Session 状态非终态 且 Execution 状态非终态的）投影，用**记录下来的**进程身份做所有权检查（默认走 FOUNDATION-043 的 `inspectProviderProcessOwnership`：pid + start token，不用 `pgrep -f`），得到 `PROVIDER_STOPPED / PROVIDER_STILL_RUNNING / PROVIDER_DESCENDANTS_ALIVE / PROVIDER_OWNERSHIP_UNVERIFIABLE / PROCESS_IDENTITY_MISSING` 之一，然后：
  - `agent_sessions` → `DISCONNECTED`（清空 current incarnation）；`executions` → `RECOVERY_REQUIRED`（**保持 `resource_held=1`**）；`workspaces` 保持持有并记 `RECOVERY_REQUIRED`；Task 若在 RUNNING/WAITING_FOR_USER/PAUSING/PAUSED 则 → `RECOVERY_REQUIRED`。
  - **绝不写 RUNNING/ACTIVE**，**绝不声称静止**，**绝不 resume/complete**。`STOPPED` 也只说明「记录的快照里没有活着的进程」，而快照抓取发生在 provider 存活期间：之后 fork 的或已 reparent 出去的工具子进程不在其中，所以仍按 `RECOVERY_REQUIRED` 处理（这与 spike 的孤儿子进程实测一致）。
  - **绝不发信号/杀进程**：`ALIVE` 与 `DESCENDANTS_ALIVE` 只记录并上报（PID 不足以证明身份；销毁一个可能仍在写工作区的 provider 是不可逆动作）。台账 evidence 固定写 `quiescenceProven: false`、`signalsSent: 0`。
  - **绝不删除任何资源**：现场保留，回收仍然只能走 ADR-0021 的 `reclaim plan/apply`。
  - 所有权无法核验/没有身份记录时按同样方式收敛，但把该事实（`PROVIDER_OWNERSHIP_UNVERIFIABLE` / `PROCESS_IDENTITY_MISSING`）写进 detail 与 evidence，而不是假设「进程没了」。
- 每次收敛向 append-only 表 `agent_session_startup_reconciliations` 追加一行（前状态、投影后状态、观察值、provider pid、incarnation、evidence JSON），并发领域事件 `RecoveryRequired`/`AgentSessionStateChanged`/`ExecutionStateChanged`/`TaskStateChanged`。
- 幂等：更新带非终态前置条件（取不到就记 `ALREADY_CONVERGED` 且不追加台账），所以第二次启动没有任何可收敛对象；台账 `UNIQUE(session_id,command_id)` 兜底。
- `isHeldByThisRuntime` 是诚实边界：本代 Runtime 正在观察的 Session 永不被收敛（启动时该集合为空；测试用它证明「不动自己持有的 Session」）。
- 与 `reconcileSessionHandoffs` 的分工被显式写清：handoff reconcile 修 Runtime 自己的 incarnation/lease/fence/permission 状态，本函数修 `agent_sessions`/`executions` 投影（就是它拒绝做的那件事）。它在本函数之后跑，因而拿到的是已收敛的 Session 行；incarnation 的进程树在本函数里按最新一条 incarnation 读取，不依赖 handoff reconcile 的顺序。

### D06：命令面（CLI 完备、可脚本化、零确认）

- `task revision create <project> <task> <expected-version> [--specification <text>] [--constraint <text>]… [--reason <text>]`：追加不可变 revision 并移动 `tasks.current_revision_id`；有运行中的 Execution 时同事务记一条投递需求并立即尝试一次。省略 specification 即「只追加约束」（intent kind `ADD_CONSTRAINT`，约束按 id 合并且拒绝重复 id）。
- `task revision list`（revisions + deliveries）、`task revision delivery list`、`task revision delivery get`：只读投影，含每次尝试的通道/主体/起止时间/结果/证据与 `satisfied`/`stale`。
- `task revision delivery resolve <project> <task> <delivery-id> <expected-version> --action <stop-and-restart|retry>`：唯一的显式处置。**退出码语义**：`SUPERSEDED_BY_RESTART`/`RESOLVED`/`ALREADY_SATISFIED` → 0；`UNSATISFIED`/`RECOVERY_REQUIRED` 与所有拒绝（`SUCCESSOR_REVISION_MISMATCH`、`CONCURRENT_MODIFICATION`、`STALE_REVISION_ACKNOWLEDGEMENT` 等）→ 1。JSON 输出为默认，`--json` 仅为显式声明。
- 没有为修订投递新增任何确认/审批/沙箱：FULL 与 STRICT 下 `task revision create` 与 `delivery resolve` 都是同一条零确认命令。`stop-and-restart` 复用 ADR-0016 的协作停止（该停止本身不是审批）。
- 补充一条真实漏洞的守卫（在 `agent-runtime-service.ts`，本格领地）：`startAutomationSuccessor`（把 conversation 从原生终端交还给自动化）现在在 Task 的 current revision 与该 Session 启动时钉住的 revision 不一致时抛 `REVISION_NOT_ACKNOWLEDGED`。否则把旧会话交还自动化就是把 Execution 恢复到未被确认的旧规格上。诚实处置就是 `delivery resolve --action stop-and-restart`（它以 current revision 新开 Execution 并复用同一 conversation）。

### D07：schema v19（唯一新增版本号；v16 永久不用）

- `task_revision_deliveries`（需求 + FSM 状态 + 通道/期限/证据 + `UNIQUE(task_id,revision_id)`，`CHECK((state='ACKNOWLEDGED') = (acknowledged_at IS NOT NULL))`、`CHECK` 状态枚举）、`task_revision_delivery_attempts`（append-only 尝试台账，`CHECK((state='IN_FLIGHT') = (ended_at IS NULL))`）、`agent_session_startup_reconciliations`（append-only 收敛台账）。
- `migrate()` 只在既有升序链尾追加 `if (version < 19)`，既有段一字未动；`phase1SchemaVersion` 18 → 19。**v16 继续永久未使用**（既有库可能已盖 17/18，任何 `version < 16` 分支都会被跳过），**不新增** `version < 16`。
- 外键全部指向既有表（`task_revisions(task_id,id)`、`executions(task_id,id)`、`agent_sessions(id)`、`session_incarnations(id)`），迁移后 `PRAGMA foreign_key_check` 为空（由 D0 的迁移测试验证）。

### D08：效率成本（门禁评估）与未做/未验证（不得声称）

- 新增确认/审批/沙箱：**0**。FULL 常态路径步数与等待不变；新增的都是「事实核验」，不是审批，也不新增 flag 依赖（`--json` 可选）。
- 成本：
  - 有运行中 Execution 时每次 `task revision create` 会做一次 `probe()` + 一次（或零次，取决于能力）通道尝试；对 Pi 是「探测 + 立刻记 `CHANNEL_UNSUPPORTED`」，无等待（不进 `withDeadline`）。
  - `delivery resolve --action stop-and-restart` 必然有一次协作停止（等待 provider 退出，最多即 ADR-0016 的宽限），这是「不谎称已静止」的必要代价，且只在用户显式处置时发生。
  - 启动收敛对每个 stale 投影做一次进程表读取（一次 `ps`），无 provider 时不会产生任何等待。
- **未做 / 未验证（不得当成已成立）**：
  - 没有任何真实 Adapter 实现 `applyRevision`，`capabilities.revisionAcknowledgement` 对 Pi 仍是 `UNSUPPORTED`；因此**真实 provider 的 ACK 行为无法验证**，本轮只用脚本 Adapter 证明「能力为 SUPPORTED 且端口返回 evidence 时才记 ACK」的编排与守卫。
  - 真实模型在 provider 会话中对「新 revision 提示」的理解程度、真实 provider 的停止/新建是否总能成功复用同一 conversation（只用 stub 证明编排与同一 session file 参数的传递，`sessionStorageRef` 复用逻辑沿用既有实现）。
  - 修订期间 Attention 未决时的顺序（`resume` 需要 Task 处于 PAUSED 且 workspace RETAINED，未决 Attention 由既有路径处理）。
  - UI 投影：本轮不做（D3 领地），`task revision *` 的能力只在 CLI/命令面完备。
  - 并行工具批次下的静止判定、跨交接权限模式矩阵、PTY resize：仍属其他格/其他 ADR 的剩余项。

## Consequences

- 已实现：领域 `revision-delivery` FSM；schema v19 三张表；storage 的 revision 创建（append-only + current_revision_id 移动 + 投递需求）与投递/尝试/收敛读写方法；`apps/runtime/src/revision-delivery-service.ts`（能力门控的会话投递、超时、停止并新建 Execution、启动收口）；`recovery-service.ts` 的 `reconcileStaleAgentSessions`；`agent-runtime-service.ts` 的 `REVISION_NOT_ACKNOWLEDGED` 守卫；contracts 的 `task.revision.*` 五个请求；CLI 的 `task revision create|list` 与 `task revision delivery list|get|resolve`；runtime `main.ts` 的接线与启动 reconcile。
- 语义边界（由测试固定）：投递只能被真实 ACK 或经核验的 successor Execution 满足；stale/重复 ACK 被拒且留下可见的 `FAILED` 尝试；能力与端口不一致时不会调用任何投递方法；unsupported 的 retry 永远保持 unsatisfied 且退出码 1；旧 revision 的成果 commit 被 `STALE_REVISION` 拒绝；重启收敛不产生 RUNNING、不发信号、不删资源、可重复执行且第二次为空。
- 失败的尝试、超时、被拒的 ACK、无法核验的所有权都保留为记录/事件，不会被静默丢弃。
- 不新增门禁；FULL 零确认预算仍为 0。

## Verification

只用 CLI/命令面与 Runtime 命令面（含临时 `CODEESTRA_HOME`）断言（ADR-0008），不使用浏览器/桌面/键鼠自动化：

1. `apps/runtime/test/revision-delivery.test.ts`（17 项）：
   - schema：v18 与「跳过 16」两种历史库 additive 升到 19，既有 `projects`/`domain_events` 行保留、三张新表存在、`foreign_key_check` 空；`ACKNOWLEDGED` 缺时间戳被 CHECK 拒绝。
   - 领域 FSM：satisfied 只含 `ACKNOWLEDGED`/`SUPERSEDED_BY_RESTART`；`STALE_REVISION_ACKNOWLEDGEMENT`（revision 不符 / Task 已前进）、`REVISION_ALREADY_ACKNOWLEDGED`（重复 ACK、重复开 attempt）、`SUCCESSOR_REVISION_MISMATCH`。
   - Runtime 边界：Pi 形状的 `UNSUPPORTED` Adapter → 投递 `CHANNEL_UNSUPPORTED`/`capability:UNSUPPORTED`、unsatisfied、台账含 Execution/Session/incarnation/通道/起止时间；`SUPPORTED` 且返回 evidence → `ACKNOWLEDGED`（且只调用一次）；无 evidence 的 ACK → `UNACKNOWLEDGED`/`MISSING_ACK_EVIDENCE`；期限 40ms 无响应 → `TIMED_OUT`；stale ACK 被拒且投递仍 unsatisfied、尝试被就地关闭；`retry` 在无 ACK 通道时两次尝试都 `CHANNEL_UNSUPPORTED` 且 outcome `UNSATISFIED`；`stop-and-restart` → successor 行为证据满足投递（predecessor `SUPERSEDED/USER_PAUSE`、successor revision = 新 revision）、重放为 `ALREADY_SATISFIED` 且不会出现第三个 Execution；Task 已前进时 `SUCCESSOR_REVISION_MISMATCH` 且不暂停/不新建；能力与端口不一致时不调用端口；启动收口把中断尝试记 `FAILED/RUNTIME_RESTARTED`、过期尝试记 `TIMED_OUT` 且第二次启动无对象。
   - 真实 CLI + 真实 Runtime + 独立 `CODEESTRA_HOME` + 协议 stub provider：`task revision create`（未确认投递）→ `delivery list`/`revision list` → `task result capture` 被 `STALE_REVISION` 拒绝（退出码 1）→ `delivery resolve --action retry`（退出码 1、`UNSATISFIED`）→ `delivery resolve --action stop-and-restart`（退出码 0、`SUPERSEDED_BY_RESTART`、successor revision = 新 revision、`delivery get` 回到 `satisfied: true`）。
2. `apps/runtime/test/stale-session-reconcile.test.ts`（7 项）：provider 可证不在 → 收敛为 `DISCONNECTED`/`RECOVERY_REQUIRED`（Task 与 workspace 同样 `RECOVERY_REQUIRED`、资源仍被持有）、台账写 `quiescenceProven: false`/`signalsSent: 0` 并含「静止未证明」的 detail、四类事件齐备；**真实进程**仍存活 → `PROVIDER_STILL_RUNNING`、进程在收敛后仍活着（没有被杀）；记录的后代没有 start token 且 pid 被占用 → `PROVIDER_OWNERSHIP_UNVERIFIABLE`；无身份记录 → `PROCESS_IDENTITY_MISSING`，且随后 `reconcileSessionHandoffs` 把 incarnation 收敛、lease 以 `RUNTIME_RESTARTED` 释放；重复启动第二次返回空且不追加台账；`isHeldByThisRuntime` 为真时 `SKIPPED_HELD_BY_RUNTIME` 且状态不变；已 EXITED/FAILED 的投影不被考虑也不会被写成 RUNNING。
3. 迁移：本格分支上的 `revision-delivery.test.ts` 用真实 SQLite 覆盖 18→19 与 16→19；FOUNDATION-047 的 `verification-cancel.test.ts` 两处版本断言已随之更新为 19（原断言写死 18）。
4. 实际运行记录见 `docs/tasks/README.md` FOUNDATION-048「实际验证」段（含 `bun run check` 与 `check:fast` 的退出码与计数）。

## 关联文档

- `PROJECT_SPEC.md` §1.1、§2.9/§2.11/§2.12、§3；`docs/architecture/state-machines.md`（Execution 修订暂停/ACK/恢复）
- ADR-0001（无法确认时停止并新建 Execution）、ADR-0008（效率/CLI/测试边界）、ADR-0010 与 `docs/spikes/pi-session-handoff.md`（安全点、单 writer、孤儿进程、退出码不可判定）、ADR-0011（FULL 零确认）、ADR-0016（协作停止与保留现场）、ADR-0021（失败现场与 `reclaim`）、ADR-0023（incarnation/lease/按事实 reconcile）、ADR-0025（`withDeadline` 清理 timer）
- `docs/spikes/pi-0.84.4.md`（`revisionAcknowledgement = UNSUPPORTED`）
- `docs/tasks/README.md` `## NEXT` 第 4 项、FOUNDATION-043「重启按事实 reconcile」、FOUNDATION-048
