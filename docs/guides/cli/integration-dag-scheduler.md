# CLI 参考 · 依赖 DAG、调度与回收

> **适用版本** `dev@de03448`（2026-09-16） · **schema** v36 · **最后校对** 2026-09-16
> 版本会前进：`dev@de03448` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../../tasks/README.md) 的最新 FOUNDATION 记录为准。
> 拆分说明（ADR-0063）：本文件是 [`cli-reference.md`](../cli-reference.md) 按功能拆出的九篇之一（ADR-0066 之后为八篇），
> **内容自 `cli-reference.md @ dev@de03448` 搬移，一句未改写；本次未重新核对源码**，最后校对日期因此不变。
> 本文件覆盖 §11–§14 与 §16（§15 在 [promotion.md](./promotion.md)）；章节号沿用拆分前的编号，因此可能不连续。正文里提到本文件没有的号（例如 §14、§17）时，到 [README.md](./README.md) 的索引表查它在哪一篇。
> §14 新增 `scheduler control` 一节，并把 §0.2 的退出码与「等待码」表补上 `SCHEDULER_GLOBALLY_PAUSED`（FOUNDATION-097 / ADR-0061 D08/D09）；
> §14 的 `scheduler capacity` 一节由 **FOUNDATION-096** 重写（ADR-0061 D02：破坏性变更——命令去掉 project/adapter 参数，
> 旧 `get|set|clear <project-id>` 形态被移除）；§14 的 `scheduler control` 一节由 **FOUNDATION-097** 新增
> （同一个 schema v34 的暂停半边，两半已合并在同一次集成里）。
> **本次修订（ADR-0066 / schema v36）**：从产品中删除了 dev clone、长期 `dev` 集成分支与
> `dev → main` 提升，因此 §11 的 `task integrate` / `task integration` 整节、`promotion` 一篇（§15）
> 与 §19 的 `settings auto-reclaim` 全部作废；§12 的依赖原因码与 §16 的「已合并」判定按新语义改写。
> 其余段落沿用 FOUNDATION-091/093 的校对基线。

## 11. `task integrate` / `task integration`（ADR-0066 已删除）

这两个命令连同 IntegrationBatch、独立集成验证与 `dev` 集成分支一起从产品中删除（ADR-0066，schema v36）：

```sh
# 这些命令不再存在；执行会得到用法错误（退出码 2）。
bun run codeestra task integrate <project-id> <task-id> <expected-version>
bun run codeestra task integration create|integrate|list|get|cancel …
```

成果 commit 停在 `refs/heads/task/<task-id>`，是否合并由你自己决定（`git merge --ff-only <result-commit>`
在你的分支上），Codeestra 不自动合、不自动推、不记账。完整语义见
[git-workspace-api.md §3](../../architecture/git-workspace-api.md) 与
[ADR-0066](../../decisions/0066-remove-dev-clone-and-dual-baseline.md)。

## 12. `task depends`（DAG）

```sh
bun run codeestra task depends add    <project-id> <task-id> <expected-version> <prerequisite-task-id> [--revision <revision-id>] [--json]
bun run codeestra task depends remove <project-id> <task-id> <expected-version> <prerequisite-task-id> [--json]
bun run codeestra task depends list   <project-id> [task-id] [--json]
```

- flag 可以出现在**任意位置**（解析器按顺序走 token），但 `--revision` 只对 `add` 有意义。
- 依赖图必须是 **DAG**；加环以 `DEPENDENCY_CYCLE` 拒绝，且**不部分应用**。自依赖是 `SELF_DEPENDENCY`。
- **满足条件**：上游**指定修订自己的结果 commit** 必须对下游的 **Task 基线 ref** 可达
  （ADR-0066）。**仅 Task verification 成功不释放依赖**：验证通过不等于那个 commit 已经进了基线。
- 基线来源（ADR-0060 第三轮修订）：`devRef`/`devCommit` 是**该项目 Task 基线**的 ref 与 commit——
  就是项目文件夹**建 workspace 时检出的分支**（ADR-0066 之后只有这一种；不会产生
  INTEGRATED 批次，因此带依赖边的 Task 会以 `UPSTREAM_NOT_INTEGRATED` 保持未满足，而**不会**以
  任何「缺 dev clone」类拒绝）。基线 ref 读不到时所有边保持未满足（`BASE_REF_MISSING`），
  绝不当作已满足；原因码是有界枚举 `UPSTREAM_RESULT_MISSING` / `BASE_REF_MISSING` /
  `BASE_REF_UNREADABLE` / `NOT_REACHABLE_FROM_BASE`。
- `list` 无 `--json` 时打印人读视图：项目与基线 commit、该 Task 的状态与版本、逐条 `✓/✗ 依赖`、
  要求的 revision 编号、上游结果 commit 的前 12 位，以及上游闭包/下游影响数量。

其他码：`DUPLICATE_EDGE`、`DEPENDENCY_GRAPH_INVALID`、`UPSTREAM_NOT_INTEGRATED`、`DEPENDENCY_RECONCILE_FAILED`。

事件名：`TaskDependencyAdded`、`TaskDependencyRemoved`。

---

## 13. `task schedule`（调度引擎）

```sh
bun run codeestra task schedule status <project-id> [--adapter <id>] [--json]
bun run codeestra task schedule plan   <project-id> [--adapter <id>] [--json]
bun run codeestra task schedule explain<project-id> <task-id> [--adapter <id>] [--json]
bun run codeestra task schedule run    <project-id> [--adapter <id>] [--json]
bun run codeestra task schedule clear-unknown <project-id> <task-id> [--json]
```

- Runtime **自己会调度**：相关事件（submit、停止、revision 投递、槽位释放、容量变化）触发一次 pass，
  另有周期恢复 pass（`CODEESTRA_SCHEDULE_TICK_MS`，默认 5000ms）收敛崩溃遗留状态。
- **每一趟 pass 先重新评估 `BLOCKED` 任务**（ADR-0066）：旧实现里唯一的触发者是已删除的
  `task integrate`，所以现在由 pass 在挑选候选之前对每个 `BLOCKED` 任务重判依赖。上游结果 commit
  进入项目当前分支后，下游会在下一次 pass（或你显式跑一次 `task schedule run`）转为 `READY` 并可能立即启动。
  `task depends list` / `task schedule status` 是只读的，因此它们可能显示「边已满足、任务仍是 `BLOCKED`」，
  最多滞后一个 tick。
- 排序：**priority 降序 → 创建时间 → ID 升序**。提高优先级只改变**下一次**顺序，**不抢占**已持有资源的 Task。
- `plan` 是**有序 dry run**：不预留、不启动任何东西。
- `explain` 退出码：`0` = 正在跑或现在会启动；`3` = `WAIT_CONFLICT` / `WAIT_CAPACITY`；
  `1` = `BLOCKED` 或 `NOT_A_CANDIDATE`。
- `run` 退出码 `0` 表示**这一趟 pass 跑了**（不代表有东西启动）；每个候选的 `disposition` 与 `detail` 打到 stderr。
- `clear-unknown` 记录 UNKNOWN 判定的**显式单次放行**：绑定已评估 revision、基线与分析器/策略版本，
  写入审计台账，被恰好一次启动消费，**不改变已记录的判定**（仍是 UNKNOWN）。
  ADR-0059 之后当前规则不再产生 `UNKNOWN`，所以这里通常是 `recorded:false`。
  **`CONFLICTING` 永远不放行**（`state === "CONFLICTING"` → 退出码 `1`）。
- `--adapter` 可选；省略时不指定 Adapter。

事件名：`TaskScheduleDecided`、`TaskWaitingForConflict`、`TaskWaitingForCapacity`、`TaskUnknownCleared`、
`TaskImpactPredictionRevoked`。

---

## 14. `scheduler`（容量与槽位预留）

### `scheduler capacity`

```sh
bun run codeestra scheduler capacity get   [--json]
bun run codeestra scheduler capacity set   --limit <n> [--json]
bun run codeestra scheduler capacity reset [--json]
```

> **破坏性变更（FOUNDATION-096 / ADR-0061 D02）**：旧形态 `scheduler capacity get|set|clear <project-id>
> [--adapter <id>]` 与 `capacity clear` **已被移除，不是隐藏的兼容层**。旧脚本必须迁移；`<project-id>` 或
> `--adapter` 出现在命令行上就是用法错误（退出码 2）。

- **只有一个上限，且属于整个 Runtime**：一个 `CODEESTRA_HOME` 就是一个资源域。默认 **2**，合法范围 **1–16**；
  候选属于哪个项目、用哪个 Adapter 都不再产生第二个上限。占用按 **Task 去重**统计：所有项目的活跃预留
  ∪ 所有 `resource_held=1` 的 Execution。
- `get` 返回 `limit`、`limitSource`（`DEFAULT`/`EXPLICIT`）、`used`、`available`、每个占用者的
  `projectId`/`taskId`/`adapterId`/`since`/`source`（`RESERVATION` 或 `EXECUTION`）、`waitReason`（**现在**新获取会拿到的
  稳定理由码，或 `null`）、`pauseState` 与 Runtime 的 draining 事实。**`used` 可以大于 `limit`**：降低或重置上限
  **不会**抢占、暂停或终止已经运行的任务，只阻止后续获取，所以 `available` 是 `max(limit - used, 0)`。
- `set` 写那一个上限并**读回存储值**；重复设置同一个值是**幂等 no-op**（`changed: false`，不发事件、不 bump 版本）。
  `reset` 删掉显式值，让文档默认 2 生效（`limitSource` 回到 `DEFAULT`）；已经是默认时重放 `reset` 也是 no-op。
- `--limit` 必须是安全整数（否则用法错误，退出码 2）。越界值**被拒绝、不被裁剪**：`0`/负数/小数 → `CAPACITY_LIMIT_INVALID`，
  大于 16 → `CAPACITY_LIMIT_OUT_OF_RANGE`（退出码 1，什么都不写）。
- 退出码：`0` 读写成功；`1` 拒绝（`CAPACITY_LIMIT_INVALID` / `CAPACITY_LIMIT_OUT_OF_RANGE` / `COMMAND_CONFLICT`）；`2` 用法错误。
- FULL 与 STRICT 行为相同：设置上限**零确认**，不是审批。
- `CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` 是**历史码**：新实现不再产生它，但历史事件与历史命令结果仍按原名可读。
  `CAPACITY_GLOBAL_LIMIT_REACHED` 保留名字，含义是「整个 Runtime 的唯一上限已满」。
- 全局容量事实写为事件 `SchedulerGlobalCapacityChanged`，其 `project_id` 为 `NULL`（不属于任何 Project）；
  项目过滤的 `events subscribe` **同时**收到该项目事件与这类全局事件，游标仍按同一 sequence 前进。
- 同一个上限也可以从**设置面**调整：`settings concurrency get|set --limit <n>|reset`（见 §19），
  它发的是同一条命令——不存在第二个状态源。
- 全局暂停（`SCHEDULER_GLOBALLY_PAUSED`、`scheduler control *`）属于 ADR-0061 的另一半，**已实现**（FOUNDATION-097，
  见本节下方 `scheduler control`）：`get` 的 `pauseState` 因此可能是 `RUNNING`/`PAUSING`/`PAUSED`/`RESUMING`/
  `RECOVERY_REQUIRED`，容量判断之前会先返回 `SCHEDULER_GLOBALLY_PAUSED`（exit 3）。

### `scheduler reservations`

```sh
bun run codeestra scheduler reservations list   <project-id> [--task <task-id>] [--include-released] [--limit <n>] [--json]
bun run codeestra scheduler reservations acquire <project-id> <task-id> <expected-task-version>
  --revision <revision-id> [--snapshot <impact-snapshot-id>] [--adapter <id>] [--json]
bun run codeestra scheduler reservations release <project-id> <reservation-id> --reason <text> [--json]
bun run codeestra scheduler reservations prepare-workspace <project-id> <reservation-id> <expected-task-version> [--json]
bun run codeestra scheduler reservations reconcile <project-id> [--json]
```

- `acquire` 在**一个 immediate 事务**内复核：Task 版本、已评估 revision、依赖事实、缓存的 ImpactSnapshot 代数、
  **整个 Runtime 的唯一容量上限**，然后记录预留与创建者证据（Runtime boot、pid、OS start token）。
  `--snapshot` 指定调用方据以评估的 ImpactSnapshot：映射版本、分析器版本、观察到的 change set 会被**重新读取**，
  过期则以 `SNAPSHOT_STALE` 拒绝（无法确认时 `SNAPSHOT_UNAVAILABLE`），**不写入任何预留行**——
  这是一次**新鲜度复核**，不是第二次冲突分析。
- `acquire` 退出码：`0` = 已持有槽位；`3` = **容量等待**（理由码指出是哪个上限）；`1` = 拒绝
  （依赖未满足、revision 过期、快照代数过期、已持有槽位……）。**`3` 从不是 `BLOCKED`**。
  带事实的拒绝会先打印 JSON 再退 1。
- `list` 显示活跃预留及其持有者证据与 append-only 历史；`--include-released` 保留审计行。
  `--limit` 范围 1–200。
- `release` 是**显式**的且必须给 `--reason`：**没有任何东西**会因为心跳过期、客户端消失或用户等待而释放槽位。
  以 `SLOT_HOLDER_STILL_RUNNING` 被拒表示记录的持有者进程可证明仍活着，且**没有被发信号**。
  `released: false` 表示「本来就已经释放了」——诚实的 no-op，**不是失败**（退出码 0）。
- `prepare-workspace` 为一次预留准备 Task worktree 并绑定它。
- `get` 按 id 读回单条预留与它自己的 append-only 历史（FOUNDATION-074 起已列入 `usage()`；本指南之前把它列在「未列入 usage()」之下）。
- `reconcile` 复核每个活跃预留记录的持有者**与真实进程表**：证明消失的释放并记录；活着或无法核验的**保留槽位**
  （`RECOVERY_REQUIRED`）。**不发信号、不删资源。** 只有出现 `FAILED` 结果才是退出码 `1`。

> **已由 FOUNDATION-074 校准**：`scheduler reservations get` 现已在 `usage()` 里（本指南的「其他只在源码里出现的东西」行也已更新）。

### `scheduler control`（Runtime 全局负载控制，FOUNDATION-097 / ADR-0061 D09）

```sh
bun run codeestra scheduler control status    [--json]
bun run codeestra scheduler control pause     [--json]
bun run codeestra scheduler control resume    [--json]
bun run codeestra scheduler control reconcile [--json]
```

这四个命令**不属于任何 Project**（缺 `projectId`，事件以 `project_id = NULL` 写入）：它们控制的屏障是整台机器的。
FULL 与 STRICT **都是零确认**——暂停按钮/命令本身就是显式用户命令，不叠第二次确认。

- 状态机：`RUNNING → PAUSING → PAUSED → RESUMING → RUNNING`；任何身份/停止/恢复事实不可核验 → `RECOVERY_REQUIRED`，
  **启动屏障保持**，已冻结的目标保持冻结。**部分成功永远不会被报成 `PAUSED`。**
- `status` 返回状态、epoch、版本、请求/结算时间、actor、每个目标的 project/task/execution/session/incarnation
  与 pid + start token + 观测结论，以及平台是否具备 POSIX 语义。`capacity` 字段恒为 `null`（全局容量数字属于
  `scheduler capacity get` 的契约，不在这里发明）。
- `pause` 顺序固定：**先提交屏障**（`PAUSING` + 递增 epoch + 固定目标清单）→ 逐目标**重验** `pid + start token + incarnation`
  → 只向 Adapter 声明并经实测为「模型请求发起者」的 **Provider 主进程发 `SIGSTOP`**（工具子进程/进程组**不**收信号）
  → **复读**进程状态，只有确实 stopped 才记 `STOPPED`。
- `resume` 只从 `PAUSED` 或可处置的 `RECOVERY_REQUIRED` 进入 `RESUMING`；逐目标重验身份与 stopped 事实，
  **只对完全匹配的主进程发 `SIGCONT`**；已退出的目标**不复活**；PID 复用或身份不可读 → 不发信号并进入 `RECOVERY_REQUIRED`。
  全部收口后写 `RUNNING`，随后触发一次事件型调度 pass，并投递暂停期间已耐久记录、仍然有效的 answer/guidance。
- `reconcile` **只观察**：不发 `SIGSTOP`/`SIGCONT`/终止信号；可以把「已证明退出」的目标收口，但**不会**把无法核验的目标猜成已停止，
  也不会把 `RECOVERY_REQUIRED` 提升成 `PAUSED`。若 `PAUSING` 且所有目标已解决，它会据此结算。
  它**只记录事实**：一次什么也没改变的观察**不写事件**（事件只说发生过的事），观察结果看 `status`。
- **不改业务状态**：`Task.state`/`Execution.state`/`AgentSession.state`、slot、workspace、writer lease 都不变；
  被冻结的 Task 仍占用全局容量。单 Task 的 `task pause`/`task resume` 仍走 ADR-0016 的协作停止路径。
- 暂停期间**继续可用**：只读查询、事件订阅、容量/控制查询、记录用户输入、`task cancel/recover/purge`、`runtime stop`，
  以及不调用模型的 Git/验证操作。**延后**：新 Execution/Session/successor、answer/guidance 的实际投递、
  任何可能引发下一轮模型调用的写入（正文可先耐久记录）。
- 退出码：`0` = 达到完整稳定状态或已幂等处于目标状态；`1` = 任何目标不可核验/平台或 Adapter 不支持/上一次变更未收口
  （**不用 `3` 掩盖部分冻结**）；`3` 只用于「Task 因全局暂停而等待启动」（`task run`/`task resume`/`task retry`/
  `scheduler reservations acquire` 都会以 `SCHEDULER_GLOBALLY_PAUSED` 退 `3`）。
- 稳定码：

  | 码 | 含义 |
  |---|---|
  | `SCHEDULER_GLOBALLY_PAUSED` | 屏障生效，Task/获取槽位**等待**（exit 3，**不是** `BLOCKED`） |
  | `GLOBAL_PAUSE_UNSUPPORTED` | 平台没有 POSIX 停止/继续语义，或该 Adapter 的 `providerProcessSuspension` 不是 `SUPPORTED` |
  | `GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE` | 目标的进程身份读不出来（未发任何信号） |
  | `GLOBAL_PAUSE_TARGET_NOT_STOPPED` | 发了 `SIGSTOP`，但复读没有证实它停止 |
  | `GLOBAL_RESUME_TARGET_CHANGED` | 目标的 pid 已属于别的进程（PID 复用）或已不是记录的 stopped 主进程（未发 `SIGCONT`） |
  | `GLOBAL_PAUSE_RECOVERY_REQUIRED` | 至少一个目标无法收口，屏障保持 |
  | `GLOBAL_CONTROL_IN_PROGRESS` | 上一次状态变更尚未收口（`PAUSING`/`RESUMING` 中），没有开始第二次变更 |

- 事件：`SchedulerGlobalPauseRequested`、`SchedulerGlobalPaused`、`SchedulerGlobalResumeRequested`、
  `SchedulerGlobalResumed`、`SchedulerGlobalControlRecoveryRequired`。**`Requested` ≠ `Paused`**，只写已发生的事实；
  进程身份与逐目标结果在 payload 与 `runtime_pause_targets` 里，**正文不进事件**。
- 重启语义：控制记录与目标**持久化**；Runtime 启动在第一次 tick/Adapter start/投递**之前**读取它，
  状态不是 `RUNNING` 就先建立屏障，**不自动 `SIGCONT`、不自动 kill** 旧 boot 的冻结进程；
  `runtime stop` **不清除**暂停状态，下次启动仍是暂停态直到显式 `resume`。
- **诚实边界**：暂停**不取消**已发出的模型请求（可能已在服务端完成并计费）；工具子进程不会收到 Codeestra 的暂停/终止信号，
  但 Provider 主进程停止读管道时大输出工具可能因 OS 管道背压阻塞；第三方插件、MCP daemon 或无法证明归属的外部进程**不在保证内**。

---

## 16. `reclaim`（资源回收）

```sh
bun run codeestra reclaim plan [--project <project-id> | --all-projects] [--task <task-id>]
  [--kind <TASK_WORKTREE|VERIFICATION_COPY|INTEGRATION_WORKTREE>]… [--include-failure-scenes]
  [--unregistered] [--scan-root <path-inside-home>] [--remove-unregistered <path>]… [--json]
bun run codeestra reclaim apply  <同上>
bun run codeestra reclaim records [--project <project-id> | --all-projects] [--task <task-id>]
  [--source <ALL|REGISTERED|UNREGISTERED_DIRECTORY>] [--since <epoch-ms|ISO>] [--until <epoch-ms|ISO>]
  [--limit <n>] [--json]
```

- **这是唯一具有破坏性的命令面。** `plan` 是只读试运行，返回与 `apply` **完全相同**的决策形状，
  所以预览永远不会与真跑不一致。
- 每个被考虑资源都有 `action`（`RECLAIM` / `RETAIN` / `REFUSE` / `ALREADY_ABSENT` / `RECOVERY_REQUIRED`）、
  `reasonCode` / `detail` 与授权或拒绝它的**归属证据**。
- **失败现场默认保留**：没有 `--include-failure-scenes` 时，未提交改动、失败/取消的验证是 `RETAIN`
  （`FAILURE_SCENE`）。
- **未注册目录不会被删**：只有用 `--remove-unregistered <精确路径>` 指名才会（`UNREGISTERED_EXPLICIT_SELECTION`）；
  最多 200 个选择。`--scan-root` 必须是 home 内的绝对路径（`SCAN_ROOT_NOT_ABSOLUTE` / `SCAN_ROOT_OUTSIDE_HOME`），
  并且它隐含 `--unregistered`。
- **`--kind INTEGRATION_WORKTREE` 仍然可以写，但不再匹配任何东西**（ADR-0066）：Runtime 不再创建集成
  工作树，所以它只作为 append-only 账本里的历史取值保留；旧目录会落进「未注册目录」处置通道。
- **「已合并」按该 workspace 记录的 `base_ref` 判定**（ADR-0066）：`resultCommit` 对项目文件夹建这个
  workspace 时检出分支的 commit 做 ancestor 检查。读不到该 ref 时不按已合并处理，资源 `RETAIN`。
- `--project` 与 `--all-projects` 互斥；`--task` 需要 `--project`。
- `records` 专用 flag：`--source`、`--since`/`--until`（epoch 毫秒或任何 ISO-8601；`since >= until` 是用法错误）、
  `--limit`（1–500，默认 100）。`--unregistered`、`--include-failure-scenes`、`--scan-root`、`--remove-unregistered`
  在 `records` 上都是用法错误。

退出码：

| 情况 | 退出码 |
|---|---|
| `plan.outcome === "FAILED"` / `report.outcome === "FAILED"` | `1` |
| plan 里可回收数量为 0 | `3`（「没什么可回收」） |
| apply 实际回收数量为 0 | `3` |
| 其他 | `0` |

**注意：`plan`/`apply` 的 `--json` 输出不写 stderr**，所以 `--json` 是脚本唯一需要读的东西。

其他码：`PROJECT_SCOPE_CONFLICT`、`PROJECT_SCOPE_REQUIRED`、`RECLAMATION_IN_PROGRESS`、`COMMAND_CONFLICT`、
`REMOVAL_FAILED`、`REMOVAL_UNCONFIRMED`、`PRUNE_FAILED`、`CLAIMED_BY_LEDGER`、
`UNREGISTERED_REQUIRES_EXPLICIT_SELECTION`、`PATH_NOT_OWNED_LAYOUT`、`PATH_OUTSIDE_OWNED_ROOT`、
`UNRECOGNIZED_LAYOUT`。

事件名：`ResourcesReclaimed`、`WorkspaceReclaimed`。

---

