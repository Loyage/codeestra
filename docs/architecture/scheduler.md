# Conservative Scheduler

状态：§1–§6 是 Phase 2 设计（ADR-0030）；§7 记录**当前已实现的原语**（ADR-0032，schema v21）。**调度引擎本体已由 ADR-0033 / FOUNDATION-055 实现**（`apps/runtime/src/schedule-service.ts` + `CODEESTRA_SCHEDULE_TICK_MS`，默认 5000ms），因此 §1.2 的触发模型与 §7.6 不再是「未实现」：它们已经是实现事实（保留原文的措辞只在下面显式标注更正，不重写历史）。**ADR-0059 把冲突判定从「证明不相交」改为「两侧声明同一功能且对方未完成」（FOUNDATION-091），§1 的活跃集合与 §2 的判定流程下面各有一节显式更正。ADR-0061 又接受了容量与全局控制的下一版目标：删除项目级/Adapter 级额度，只保留一个跨项目 Runtime 上限，并新增持久全局 Provider 冻结；该设计尚未实现，§7 仍是当前代码事实，§8 是待开发契约。**

## 1. 调度输入和顺序

候选为 READY、当前 revision 有效且无未完成修订确认的 Task。优先级整数降序，随后 createdAt 升序、ID 升序，实现确定性排序。提优先级不抢占。

第一版不自动 aging 或猜测任务成本；持续高优先级输入可能导致饥饿，UI 显示等待时长，后续以产品决策引入公平策略。

活跃集合包括准备/启动、RUNNING、WAITING_FOR_USER、PAUSING、PAUSED、STOPPING/CANCELLING、RECOVERY_REQUIRED 和已预留尚未启动的执行。不能因用户等待、心跳过期或 UI 消失就释放资源。

> **更正（ADR-0059，FOUNDATION-091）：这句话同时描述了两个不同的集合，现在必须分开读。**
>
> - **占用/容量集合**（不变）：仍按「持有资源」定义——准备/启动、RUNNING、WAITING_FOR_USER、PAUSING、
>   PAUSED、STOPPING/CANCELLING、RECOVERY_REQUIRED 与已预留未启动的执行。它决定槽位计数与
>   `scheduler reservations *` 的占用。
> - **冲突集合**（已变）：判定只比较**声明**——同项目里状态不是 `SUCCEEDED`/`CANCELLED`、**且未归档**、
>   **且至少声明一个功能**的 Task（排除候选自己）。一个从未启动的 `READY` Task 正是这条规则的对象；
>   而一个持有 worktree 但**没有声明功能**的任务不再参与冲突判定。
>
> 两个集合仍然都被调度器使用（前者定容量，后者定冲突），但它们**不是同一个集合**。

### 1.1 容量模型（当前实现：ADR-0030 D01/D02；目标修订：ADR-0061）

**当前实现**有两个带 Project 作用域的上限：项目级“全局”上限（默认 2）与每 Adapter 覆写；`GLOBAL_CAPACITY` / `ADAPTER_CAPACITY` 分别报告两者。因此它不能限制多个项目的总负载。

**ADR-0061 已接受、待实现的目标语义**只有一个上限：

- 一个 `CODEESTRA_HOME` / Runtime 只有一个跨全部 Project、全部 Adapter 的 `globalLimit`，默认 **2**，合法范围 1–16。
- 占用是所有项目的活跃 reservation 与 `resource_held=1` Execution 按 Task 去重后的并集。
- 项目级与 Adapter 级上限退役，不保留隐藏覆写；旧显式值在 v34 迁移时取最小值，没有显式值则为 2。
- 降低上限不抢占已运行 Task；`used > limit` 可以被如实观察，只阻止新获取。
- `CAPACITY_GLOBAL_LIMIT_REACHED` 保留稳定名字但变为真正的 Runtime 全局容量等待；`CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` 新实现不再产生，历史记录保留。

容量等待不是 `BLOCKED`（`PROJECT_SPEC.md` §2.10）：它不改写依赖理由，也不算故障。仍不按主机 CPU/内存自动推导容量（见 §6）。

### 1.2 触发模型（ADR-0030 D04）

> **本节曾标为「尚未实现」；已由 ADR-0033 / FOUNDATION-055 实现（FOUNDATION-074 更正）。** 触发模型就是现在的事实：一个相关事件（submit、集成进 dev、停止、修订投递、槽位释放、容量变化）触发一次 pass，另有一个周期恢复 pass 收敛崩溃遗留；`CODEESTRA_SCHEDULE_TICK_MS`（默认 5000ms）控制周期。`apps/runtime/src/scheduler.ts` 仍只是 ADR-0024 的依赖判定器——引擎在 `apps/runtime/src/schedule-service.ts`，候选排序与冲突/容量判定在那里接入。

调度由 Runtime **自动 tick** 驱动，用户不需要手动「推」任务：

- **事件驱动**：相关提交事件（submit、依赖变更、revision 投递/恢复、Execution 终态、取消/暂停结束、合入 `dev`、容量释放等）触发一次 tick。
- **周期恢复 tick**：无事件时按周期再跑一次，用于收敛崩溃/重启后遗留的预留与容量计数；周期 tick 只重跑同一套判定，不引入新状态。
- **submit 后自动进入调度**：`task.submit` 成功后候选自动进入下一次 tick；FULL 下新增确认步骤数为 **0**，STRICT 也不把调度当作需批准的操作。
- 既有 `task.run` 仍是同一命令面的一部分（可用它立即请求一次调度并得到结果，满足 CLI 完备与可脚本化），但它不再是启动任务的**必经**路径。

## 2. 调度算法

```text
on relevant committed event or periodic recovery tick:
  if runtime draining: return
  if global control state != RUNNING: wait(GLOBAL_PAUSE); return
  refresh main snapshot and active resource observations
  for candidate in stable priority order:
    load revision, DAG requirements, impacts and policy version
    if unmet dependency: BLOCKED; continue
    if required upstream commit not reachable from selected main: BLOCKED; continue
    if candidate impact unknown and active set not empty: wait(CONFLICT); continue
    assess candidate against every active/reserved task
    if any verdict != SAFE_TO_PARALLELIZE: wait(CONFLICT); continue
    if no compatible adapter slot: wait(CAPACITY); continue
    BEGIN IMMEDIATE
      recheck task version, revision, dependency and cached snapshot generations
      recheck database reservations and draining flag
      reserve unique execution/workspace ownership and agent slot
      write operation intent + events
    COMMIT
    prepare workspace outside transaction using fixed base and expected main
    recheck external baseline + revision + permission capability before start
    start exactly one primary adapter session; reconcile ambiguous outcomes
    include newly reserved task in active set before considering next candidate
```

单任务且影响未知可独占运行，但不得与任何占用资源的任务并行。READY 不意味着立刻启动。没有 Adapter 可用不是 BLOCKED。

> **更正（ADR-0059，FOUNDATION-091）：上面这段是 ADR-0031 时代的判定流程，已不是当前事实。**
> 当前 §2 的对应步骤是：
>
> ```text
> for candidate in stable priority order:
>   load revision and DAG requirements
>   if unmet dependency: BLOCKED; continue
>   conflict_peers = same project, not SUCCEEDED/CANCELLED, not archived, declares >= 1 feature,
>                     excluding the candidate
>   if candidate.features ∩ peer.features ≠ ∅ for some peer: wait(CONFLICT, SAME_UNFINISHED_FEATURE); continue
>   if no compatible adapter slot: wait(CAPACITY); continue
>   …（预留、workspace、启动前基线重检都不变）
> ```
>
> 取代掉的是三条旧规则：①「impact unknown 且活跃集合非空 → wait」——现在没有产生 `UNKNOWN` 的路径；
> ②「与每个活跃/已预留 Task 比较变更集」——判定不再读快照、映射、基线或文件集合（`ImpactSnapshot`
> 仍然派生，但只是证据）；③「任何 verdict != SAFE 就等待」——SAFE 现在是默认值而不是被证明的结论。
> **`CONFLICTING` 仍然永不放行**，`--allow-unknown` 也只对 `UNKNOWN` 有意义。

## 3. 两类锁

- Runtime 实例锁：同一数据库/资源域只允许一个写入执行协调实例。IPC token 与进程身份独立校验。
- 资源预留：SQLite 内表达 Task 执行权、workspace、Adapter slot；跨进程崩溃后必须 reconcile 后释放。

数据库 reservation 不能当 OS 强隔离。外部进程不受 SQLite 锁控制，因此启动前及恢复时还需核对真实写入者。

## 4. 修订、实际影响扩大与恢复

用户修订按照 ADR-0001 暂停对应任务、使旧影响评估失效。恢复前重新跑一次冲突判定，`CONFLICTING` 就保持暂停（ADR-0059：**只有两侧声明同一功能且对方未完成**才是 `CONFLICTING`；当前规则不再产生 `UNKNOWN`）。不能为解决冲突自动抢占其他任务。

实际 diff 超出预测时撤销旧 SAFE，不再启动相关新任务，向执行协调层报告并请求受影响执行进入安全暂停。无法可靠停止时标 RECOVERY_REQUIRED、保留隔离现场，禁止自动集成。第一版 analyzer 无法事先证明运行中的两个 Agent 永不越界，必须明确此残余风险。

取消超时：保留 slot 与 workspace，提醒人工处理；不通过超时自动认定死亡。排空升级需确认所有潜在写入资源已静止。

### 4.1 UNKNOWN 的显式单次放行（ADR-0030 D05）

> **ADR-0059 之后当前规则不再产生 `UNKNOWN`（FOUNDATION-091）**，所以本节描述的放行日常不可达；
> 取值、`--allow-unknown`、`scheduler.unknown.clear`/`TaskUnknownCleared` 与历史 assessment 行都保留，
> `clear-unknown` 对 `CONFLICTING` 一律拒绝。下面保留原文作为该能力的语义记录。

`UNKNOWN` 默认等待：评估未知时**不启动、不并行**（§2 的 `wait(CONFLICT)`）。用户可以对本条 Task 做**显式单次放行**（`--allow-unknown`；命令形态在实现波次落地，本波只固化语义）。

- **可与当前活跃任务并发**：放行后该 Task 正常走容量与冲突流程，允许与活跃任务同时运行；它**不**被降级成独占任务，也不要求其他任务先停。
- **绑定 revision 与评估版本**：放行记录绑定 `revisionId`、`baseCommit`、`analyzerVersion`、`policyVersion`（即产生该次 UNKNOWN 的那一份评估的版本）。
- **写审计**：放行是用户决定，必须可追溯（谁放行、放行了哪个 Task 的哪个 revision、对应哪次评估）。
- **默认路径 0 新增步骤**：放行是**放宽**而非新增门禁。不碰 `--allow-unknown` 时 FULL 下看不到任何新确认，UNKNOWN 任务就是等待。
- **放行不改变 assessment 本身**：该次 `conflict_assessments` 仍是 `UNKNOWN`；放行是独立事实，**不等于 SAFE**，不构成「已证明不冲突」的证据，也不改变后续判定的保守策略。
- **失效**：revision 被修订、基线/映射/analyzer/policy 版本变化、实际 diff 超出预测时，放行与 assessment 一并失效，需重新评估、必要时重新放行。

风险归属在放行方：analyzer 无法事先证明两个 Agent 永不越界（§4 残余风险）；放行后 Runtime **不做额外隔离**，若两者越界，责任在放行的人。

## 5. 验收矩阵

- A/B 明确不相交且容量为 2：可同时 reservation/start。
- 同文件/重要目录/模块：串行。
- UNKNOWN：有活跃任务时不启动。
- 等待用户占用冲突范围，但不阻止不相交且容量足够的任务。
- A 仅通过 Task Verification：依赖 A 的 B 仍 BLOCKED。
- A 已入 main 但外部 main 重写使结果不可达：B 阻塞。
- 调度检查后 Task 被修订：CAS 失败，不按旧 revision 启动。
- 两次 tick / 两个启动请求：活动 Execution 唯一。
- reservation 后 Runtime 崩溃：先核对，不能重复创建 Agent。
- 提优先级：改变下一次排序，不中断现有任务。

## 6. 明确不做（本波剩余范围，ADR-0030）

以下三项被用户明确否决进入本波，**不是遗漏、也不是「待补齐的实现细节」**：

- **非 Git 共享资源的 resource claim（端口、数据库、dev server）**：不引入。不同文件不能证明这些资源可共享，但 ADR-0059
  之后已经没有「`complete=false` → UNKNOWN」这个兜底（判定不再读映射与快照），所以这类冲突**根本不被启动前门禁覆盖**：
  它们只在真实运行时暴露（或两个 Agent 真的撞上），由使用方自己用功能声明表达互斥意愿。要用声明字段假装安全仍然不做。
  （全局共享资源清单仍由 `.codeestra/impact.json` 的 `globalResources` 表达，那只覆盖 Git 可见影响，且现在只是证据。）
- **多成员 IntegrationBatch 的自动组批**：**CLI 显式组批已实现**（FOUNDATION-081 / ADR-0053：`task integration create` 组成多成员批次，一次覆盖整批的独立验证，`PASSED` 才推进 `dev`；见 `state-machines.md` §4）。**调度器仍然不会自动组批**：一次调度 tick 的候选仍各自独立成一个批次，「哪些 Task 合成一批」继续由人显式决定，属后续。
- **饥饿公平策略（aging）**：不加 aging。持续高优先级输入可能饿死低优先级任务，UI 只显示等待时长；公平策略作为独立产品决策留后续。

同样明确不做：按主机 CPU/内存自动推导并发容量；LLM 辅助的 ImpactSnapshot 预测；在 `UNKNOWN` 上新增除 `--allow-unknown` 之外的任何门禁、审批或信任流程。ADR-0061 的全局上限仍是显式配置，不是资源探测器。

## 7. 实现现状（Wave E / E2，ADR-0032，schema v21）

本节记录**已经合入 `dev` 的实现**，与前面的设计意图分开。实现的是一组**原语 + 命令面**，不是会自己跑起来的调度器。

### 7.1 容量模型

- 项目级全局上限：没有 `project_capacity_limits` 行时为文档默认 **2**（`defaultConcurrencyLimit`），可配置，**上限 16**（`maxConcurrencyLimit`）。
- 每 adapter 上限：`project_adapter_slot_limits` 只存**显式设置过**的行；缺省等于该项目的当前全局上限（派生而非复制，改全局会一起移动没有覆写的 adapter）。
- 校验：整数、`≥1`、`≤16`；`0`/负数/小数 → `CAPACITY_LIMIT_INVALID`；超上限 → `CAPACITY_LIMIT_OUT_OF_RANGE`；未知 adapter id → `UNKNOWN_ADAPTER`。**拒绝，不夹取**，被拒绝的请求不写任何行。
- 降低上限不释放已持有槽位：只影响之后的获取判定（`available` 可为 0、`used` 可 > `limit`，事实如实）。
- 每次值真正改变写一条 append-only `SchedulerCapacityChanged`；重复设置同一值不 bump 版本、不发事件。

### 7.2 预留状态与归属证据

`execution_slot_reservations` 一行表达 Task 执行权 + adapter slot +（可绑定的）workspace。状态：`RESERVED → RELEASED`，或 `RESERVED → RECOVERY_REQUIRED`（保持占用）。两个部分唯一索引把不变量变成 schema 事实：每 Task 一个活跃预留（`RESERVED`/`RECOVERY_REQUIRED`）、一个 workspace 不被两个活跃预留占用。

归属证据 = 创建它的 Runtime `bootId` + 进程 `pid` + 该 pid 的 OS `startToken`（可为 null，如实记录）+ actor。**「这行是我建的」不作为证据。** 获取在 `BEGIN IMMEDIATE` 内重检：active trust → Task `version` CAS → `revision_id` CAS → `state=READY` → 依赖事实指纹 → 无活跃预留 → 容量（上限在同一事务内从表里重读）→ draining（事务内求值），然后写预留 + append-only 历史行 + `ExecutionSlotReserved` 事件。两次 tick / 两个启动请求只能有一个成功（第二个要么在写锁上等到已提交的行 → 容量等待，要么撞上部分唯一索引 `SLOT_ALREADY_RESERVED`）。

容量占用按 **Task** 计：活跃预留 ∪ `executions.resource_held=1` 的**并集**，使「先预留、再启动」的同一 Task 只吃一个槽，同时把今天的真实并发如实计入。释放必须带 `--reason`，写 `released_at`/`release_reason`/`release_kind='EXPLICIT'` + 历史行 + 事件；可证明仍存活的持有者被拒绝释放（`SLOT_HOLDER_STILL_RUNNING`），重复释放是诚实 no-op（`ALREADY_RELEASED`）。**绝不因心跳过期、用户等待或 UI 消失自动释放**（本格没有任何心跳）。

### 7.3 reconcile 判定

`inspectSlotHolder` 读真实进程表：pid 不存在/僵尸 → `HOLDER_STOPPED`；pid 存活且 start token 相同 → `HOLDER_STILL_RUNNING`；pid 存活但 token 不同 → `HOLDER_PROCESS_ID_REUSED`；任一 token 缺失或进程表读不到 → `HOLDER_OWNERSHIP_UNVERIFIABLE`；没有进程身份 → `PROCESS_IDENTITY_MISSING`。

决定：已死（前两者）→ 记为 `RELEASED`（`RECONCILED_HOLDER_EXITED` / `RECONCILED_PROCESS_ID_REUSED`）；仍存活 → **保持占用**（状态不变）；无法核验 → `RESERVED` → `RECOVERY_REQUIRED`，**保持占用、不自动放行**。本代自己创建的预留跳过（`SKIPPED_HELD_BY_RUNTIME`）。reconcile **不发信号、不杀进程、不删资源、不声称静止**；每次观测（包括「决定保持占用」这种没有状态变化的情形）都追加到 `execution_slot_reservation_events`，`UNIQUE(reservation_id,command_id)` + command 回执让同一代重复 reconcile 幂等。启动序列在既有 reconcile 之后追加这一步（槽位按其他 reconcile 收敛后的最终图景判定）。

### 7.4 等待原因与 draining

容量等待用独立稳定码：`CAPACITY_GLOBAL_LIMIT_REACHED` / `CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` / `SCHEDULER_DRAINING`，并带 `{ adapterId, limit, used, blocking[] }`。`BLOCKED` 仍只表示依赖未满足。Runtime 的 draining 是**内存事实**，只在开始 shutdown 时置位（不做持久化 draining，那会在崩溃后残留并永久拒绝新预留）；没有新增操作者 drain 开关。

### 7.5 命令面与退出码

```
scheduler capacity get <project-id> [--adapter <id>] [--json]
scheduler capacity set <project-id> --limit <n> [--adapter <id>] [--json]
scheduler capacity clear <project-id> --adapter <id> [--json]
scheduler reservations list <project-id> [--task <task-id>] [--include-released] [--limit <n>] [--json]
scheduler reservations get <project-id> <reservation-id> [--json]
scheduler reservations acquire <project-id> <task-id> <expected-task-version> --revision <revision-id> [--adapter <id>] [--json]
scheduler reservations release <project-id> <reservation-id> --reason <text> [--json]
scheduler reservations prepare-workspace <project-id> <reservation-id> <expected-task-version> [--json]
scheduler reservations reconcile <project-id> [--json]
```

`acquire` 退出码：**0** = 拿到槽位，**3** = 容量等待/正在排水（`--json` 的 `wait.code` 是原因），**1** = 拒绝（依赖未满足、revision/版本过期、已有预留、未知 adapter、非法上限）。`prepare-workspace` 只有**本代创建**的 `RESERVED` 预留可用（否则 `SLOT_HELD_BY_ANOTHER_RUNTIME`），同一 commandId 重放不产生第二个 worktree。全部命令零新增确认、`--json`、退出码稳定。

### 7.6 调度引擎（ADR-0033 / FOUNDATION-055，已实现）

> 本小节在 FOUNDATION-055 之前写的是「明确未实现：调度引擎」。**已由该格实现**（FOUNDATION-074 更正本节）：
> `apps/runtime/src/schedule-service.ts` 提供自动 tick（事件驱动 + 周期恢复，`CODEESTRA_SCHEDULE_TICK_MS` 默认 5000ms）、
> 确定性候选排序（优先级降序 → createdAt 升序 → ID 升序）、把 ADR-0024/0030/0031/0032 的依赖/冲突/容量判定接入启动门禁、等待原因
> （`CONFLICT`/`CAPACITY`/`DRAINING`/`REVISION_REVIEW`，从不误用 `BLOCKED`）、实际 diff 超出预测时的撤销（`TaskImpactPredictionRevoked`）
> 与 `--allow-unknown`（`task schedule clear-unknown` 的单次放行，绑定 assessed revision/baseline/analyzer/policy 版本，消费一次，不改写已记录的
> 判定）。命令面为 `task schedule status/plan/explain/run/clear-unknown`（零确认、`--json`、退出码 0/1/3），其 UI 投影由 FOUNDATION-059 完成。
>
> **仍然未验证**：验收矩阵里「两个 SAFE 任务真的同时跑」只在调度器/命令面与测试夹具下验证过，真实 provider 的并发运行**未完成受控验收**
> （`docs/guides/troubleshooting.md` §4 第 1 条），因此该验收项仍算未成立。

因此在本格及其基线里：**不得写「自动 tick 已实现」或「两个 SAFE 任务真的会同时开始」。** Wave E 交付的是原语：E1 的 ImpactSnapshot/Conflict Analyzer 与 E2 的容量/槽位预留已经就位，但没有引擎驱动它们；本格的端到端证据只到「第三个任务得到容量等待」，没有两个 Task 真的同时跑。

## 8. Runtime 全局负载控制（ADR-0061，已接受、待实现）

### 8.1 唯一全局容量

目标命令面去掉 Project 与 Adapter 参数：

```text
scheduler capacity get [--json]
scheduler capacity set --limit <1..16> [--json]
scheduler capacity reset [--json]
```

`get` 必须列出跨项目占用者（project/task/adapter/since/source）。`scheduler reservations *` 仍按 Project 操作，但 `acquire` 在同一个 immediate transaction 中统计**整个 Runtime**的占用，而不是只统计请求 Project。暂停状态不是容量的一部分；它在容量判断之前返回 `SCHEDULER_GLOBALLY_PAUSED`（exit 3）。

### 8.2 全局控制状态

```text
RUNNING → PAUSING → PAUSED → RESUMING → RUNNING
             └──────────────→ RECOVERY_REQUIRED
```

- `PAUSING` 一提交，新的 reservation、Execution/Session/successor start 与 Provider 投递全部被屏障阻止。
- 固定本 epoch 的活动 process incarnation；按 pid + start token + incarnation 重验后，只冻结 Adapter 已证明是模型请求发起者的 Provider 主进程。工具子进程/进程组不接收暂停或终止信号。
- 只有所有目标都被观察为 stopped（或已证明在屏障前退出）才写 `PAUSED`。部分冻结、身份不可读、平台不支持都进入 `RECOVERY_REQUIRED`，屏障保留。
- `resume` 只恢复同 epoch 中身份完全一致的 stopped 主进程；全部收口后才写 `RUNNING` 并触发一次事件型 pass。
- 状态持久化；Runtime 启动先读屏障，不自动继续旧 Provider。全局冻结不改 Task/Execution/Session 状态，也不释放槽位。

命令面：

```text
scheduler control status [--json]
scheduler control pause [--json]
scheduler control resume [--json]
scheduler control reconcile [--json]
```

`reconcile` 只观察，不发暂停、继续或终止信号。`pause`/`resume` 只有在完整收口或幂等命中目标状态时 exit 0；部分结果 exit 1 并逐目标报告。普通 Task 因屏障等待仍 exit 3，且永远不是 `BLOCKED`。

### 8.3 暂停期间

已经运行的工具/验证命令不因全局暂停收到停止信号；已经发出的模型请求不被取消，可能在服务端完成。只读查询、事件订阅、记录用户输入、显式 task cancel/pause/recover/purge、Runtime stop 与不调用模型的 Git/验证/集成操作继续可用。answer/guidance 可耐久记录，但实际 Provider 投递延后到恢复并重验有效性之后。

实现前必须完成各 Adapter 的进程归属 spike；Pi/Codex/Claude 在证据形成前都只能把“可核验 Provider 进程冻结”报告为 `REQUIRES_VALIDATION`。POSIX 以外的平台不能降级成只暂停调度后仍声称 `PAUSED`。
