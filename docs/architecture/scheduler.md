# Conservative Scheduler

> 层级：L1 · 体量 ≈ 10k 字符 · **何时读**：改调度顺序、容量、等待原因、依赖求值或槽位预留 · 权威来源：`apps/runtime/src/schedule-service.ts`（引擎）、`apps/runtime/src/scheduler.ts`（依赖判定）、`apps/runtime/src/capacity-service.ts`、`apps/runtime/src/slot-reservation-service.ts`。相关：[`conflict-analyzer.md`](./conflict-analyzer.md)、[`state-machines.md`](./state-machines.md) §1、[`state-machines-runtime.md`](./state-machines-runtime.md) §6.1。
>
> 章节号沿用拆分前的编号；§7 保留为「预留/reconcile 原语」的记录，§8 是当前的全局负载控制（**已实现**）。

状态：调度引擎与 Service Kernel S1–S4 已实现到 schema v37。ADR-0070 的「内核 Service-first、调度 Task-first」已落地基础对象，但 **S9 的 eligibility 解耦尚未落地**：当前 `schedule-service.ts` 仍是权威实现，它自己读依赖、冲突与容量。

## 0. ADR-0070 目标边界（S9，尚未实现）

Scheduler 仍只调度 Task Service，不调度任意 Service 或 Signal。目标形态里，依赖、revision、冲突与基线可达性由 Task/Project 领域服务计算为带版本证据的 `TaskEligibility`；Scheduler 只负责：

1. 过滤 eligible Task；
2. priority desc → createdAt asc → id asc；
3. 检查 Runtime 全局暂停与唯一容量；
4. 原子预留并在事务内重验 eligibility version；
5. 请求 Task Service 创建 Development Process。

「Scheduler 不分析依赖」表示依赖求值从调度循环解耦，**不**表示系统忽略 DAG。`BLOCKED` 仍专指依赖未满足；冲突、容量与控制等待保持独立原因。

## 1. 调度输入和顺序

候选为 `READY`、当前 revision 有效、且无未完成修订确认的 Task。排序是优先级整数降序 → `createdAt` 升序 → ID 升序（确定性）。**提优先级不抢占**；第一版不自动 aging、不猜测任务成本，持续高优先级输入可能导致饥饿（界面上只显示等待时长），公平策略留作独立产品决策。

> **两个集合必须分开读（ADR-0059）**：
>
> - **占用/容量集合**（按「持有资源」定义）：准备/启动、RUNNING、WAITING_FOR_USER、PAUSING、PAUSED、STOPPING/CANCELLING、RECOVERY_REQUIRED 与已预留未启动的执行。它决定槽位计数与 `scheduler reservations *` 的占用。不能因用户等待、心跳过期或 UI 消失就释放资源。
> - **冲突集合**：同项目里状态不是 `SUCCEEDED`/`CANCELLED`、**且未归档**、**且至少声明一个功能**的 Task（排除候选自己）。一个从未启动的 `READY` Task 正是这条规则的对象；持有 worktree 但**没有声明功能**的任务不参与冲突判定。
>
> 两者都被调度器使用（前者定容量，后者定冲突），但它们**不是同一个集合**。

### 1.1 容量模型（当前实现：ADR-0061，schema v34）

只有一个上限：

- 一个 `CODEESTRA_HOME` / Runtime 只有一个跨全部 Project、全部 Adapter 的 `globalLimit`，默认 **2**，合法范围 1–16。
- 占用是所有项目的活跃 reservation 与 `resource_held=1` Execution 按 Task 去重后的并集，且这个集合在同一个 immediate 事务内重读。
- 项目级与 Adapter 级上限**不存在**（不是隐藏覆写）。历史实现曾有两个带 Project 作用域的上限（ADR-0030 D01/D02），已在 v34 退役，旧显式值迁移时取最小值。
- 降低上限不抢占已运行 Task；`used > limit` 可以被如实观察，只阻止新获取。
- `CAPACITY_GLOBAL_LIMIT_REACHED` 保留稳定名字，含义是真正的 Runtime 全局容量等待；`CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` 不再产生，历史事件与历史命令结果保留可读。

命令面：`scheduler capacity get|set|reset`（无 project/adapter 参数；`get` 列出跨项目占用者）。容量等待不是 `BLOCKED`，不改写依赖理由，也不算故障。仍**不**按主机 CPU/内存自动推导容量（见 §6）。

### 1.2 触发模型（ADR-0030 D04，已由 ADR-0033 / FOUNDATION-055 实现）

调度由 Runtime **自动 tick** 驱动，用户不需要手动「推」任务：

- **事件驱动**：相关提交事件（submit、依赖变更、revision 投递/恢复、Execution 终态、取消/暂停结束、成果并入基线、容量释放等）触发一次 pass。
- **周期恢复 pass**：无事件时按 `CODEESTRA_SCHEDULE_TICK_MS`（默认 5000ms）再跑一次，用于收敛崩溃/重启后遗留的预留与容量计数；它只重跑同一套判定，不引入新状态。
- **submit 后自动进入调度**：FULL 下新增确认步数为 **0**，STRICT 也不把调度当作需批准的操作。
- `task.run`（`task schedule run`）仍是同一命令面的一部分，可立即请求一次 pass 并得到结果，但**不再是**启动任务的必经路径。

## 2. 调度算法（当前事实）

```text
on relevant committed event or periodic recovery tick:
  if runtime draining: return
  if global control state != RUNNING: wait(CONTROL, SCHEDULER_GLOBALLY_PAUSED); return
  for candidate in stable priority order:
    load revision and DAG requirements
    if unmet dependency: BLOCKED; continue
    conflict_peers = same project, state not SUCCEEDED/CANCELLED, not archived,
                      declares >= 1 feature, excluding the candidate
    if candidate.features ∩ peer.features ≠ ∅ for some peer:
        wait(CONFLICT, SAME_UNFINISHED_FEATURE); continue
    if no compatible slot: wait(CAPACITY, …); continue
    BEGIN IMMEDIATE
      recheck task version, revision, dependency fingerprint and draining flag
      recheck database reservations
      reserve unique execution/workspace ownership and the slot
      write operation intent + events
    COMMIT
    prepare workspace outside the transaction using the fixed base ref/commit
    recheck baseline + revision + permission capability before start
    start exactly one primary adapter session; reconcile ambiguous outcomes
    include the newly reserved task in the active set before considering the next candidate
```

`READY` 不意味着立刻启动；没有 Adapter 可用不是 `BLOCKED`。**冲突判定的默认值是 `SAFE_TO_PARALLELIZE`**：判定只比较声明（同一功能 + 对方未完成），不读快照、映射、基线或文件集合；`UNKNOWN` 保留为取值但没有产生它的路径（ADR-0059，详见 [`conflict-analyzer.md`](./conflict-analyzer.md) §8）。

## 3. 两类锁

- **Runtime 实例锁**（`runtime.lock`）：同一数据库/资源域只允许一个写入执行协调实例；IPC token 与进程身份独立校验（ADR-0025）。
- **资源预留**（SQLite 内的部分唯一索引）：表达 Task 执行权、workspace 与槽位；跨进程崩溃后必须 reconcile 后才能释放。

数据库 reservation **不是** OS 强隔离：外部进程不受 SQLite 锁控制，因此启动前与恢复时都还要核对真实写入者。

## 4. 修订、实际影响扩大与恢复

用户修订按 ADR-0001 暂停对应任务并使旧影响评估失效；恢复前重新跑一次冲突判定。**不能**为解决冲突自动抢占其他任务。

实际 diff 超出预测时撤销旧 `SAFE`，不再启动相关新任务，向执行协调层报告并请求受影响执行进入安全暂停；无法可靠停止时标 `RECOVERY_REQUIRED`、保留隔离现场，禁止自动集成。第一版 analyzer 无法事先证明运行中的两个 Agent 永不越界，**必须明确这条残余风险**。

取消超时：保留 slot 与 workspace，提醒人工处理；不通过超时自动认定死亡。排空升级需确认所有潜在写入资源已静止。

### 4.1 `UNKNOWN` 的显式单次放行（ADR-0030 D05）——当前日常不可达

ADR-0059 之后当前规则不再产生 `UNKNOWN`，所以这条路径平时走不到；但取值、`--allow-unknown`、`scheduler.unknown.clear`/`TaskUnknownCleared` 与历史 assessment 行都保留（客户端仍要能渲染历史）。语义要点，供将来重新引入不确定性时参考：

- `UNKNOWN` 默认**等待**（不启动、不并行）。放行是**单次、显式、绑定 revision** 的放宽，不改变 assessment 本身，**不等于 `SAFE`**，也不改变后续判定的保守策略。
- 放行记录绑定 `revisionId`、`baseCommit`、`analyzerVersion`、`policyVersion`；revision、基线、映射、analyzer/policy 版本变化或实际 diff 超出预测时一并失效。
- 它是放宽而不是新增门禁：不碰 `--allow-unknown` 时 FULL 下看不到任何新确认。
- **`clear-unknown` 对 `CONFLICTING` 一律拒绝**；风险归放行方，Runtime 不放宽额外隔离。

## 5. 验收矩阵

- 两个明确不相交的声明、容量为 2：可同时 reservation/start。
- **两侧声明同一功能且对方未完成：串行**（`SAME_UNFINISHED_FEATURE`）。文件/目录/模块/共享构建资源重叠**不再**构成冲突（ADR-0059）——是已接受的残余风险。
- 一个 Task 只写文件、不声明功能：不参与冲突判定，可与他人并行。
- 等待用户占用该 Task 的槽位，但不阻止不相交且容量足够的任务。
- A 仅通过 Task Verification：依赖 A 的 B 仍 `BLOCKED`。
- A 的成果 commit 对其 workspace 记录的基线 ref 不可达（含基线 ref 不可读）：B 阻塞，原因码为有界枚举。
- 调度检查后 Task 被修订：CAS 失败，不按旧 revision 启动。
- 两次 pass / 两个启动请求：活动 Execution 唯一。
- reservation 后 Runtime 崩溃：先核对，不能重复创建 Agent。
- 提优先级：改变下一次排序，不中断现有任务。

> 「两个 `SAFE` 任务真的同时跑」只在调度器/命令面与测试夹具下验证过；**真实 provider 的并发运行尚未完成受控验收**（见 `docs/guides/troubleshooting.md` §4）。

## 6. 明确不做（用户已否决，不是遗漏）

- **非 Git 共享资源的 resource claim（端口、数据库、dev server）**：不引入。不同文件不能证明这些资源可共享，而 ADR-0059 之后已没有「`complete=false` → UNKNOWN」这个兜底，所以这类冲突**根本不被启动前门禁覆盖**：它们只在真实运行时暴露，由使用方用功能声明表达互斥意愿。`impact.json` 的 `globalResources` 只覆盖 Git 可见影响，且现在只是证据。
- **集成组批**：旧多成员 IntegrationBatch 曾实现，已由 ADR-0066 / schema v36 删除。S8 已交付 Project Service 的持久 merge queue（同项目串行、跨项目并行，`project integration run` 一次推进队首一条）；Scheduler 不负责自动组批或执行 merge——`run` 成功后调度 pass 只是重新判定下游依赖。
- **饥饿公平策略（aging）**：不加。界面只显示等待时长，公平策略作为独立产品决策留后续。
- **按主机 CPU/内存自动推导并发容量**、**LLM 辅助的 ImpactSnapshot 预测**、**`UNKNOWN` 上除 `--allow-unknown` 之外的任何门禁/审批/信任流程**：都不做。ADR-0061 的全局上限是显式配置，不是资源探测器。

## 7. 预留与 reconcile 原语（ADR-0032，schema v21 起）

§7.5 的旧命令面已被 §8.1 取代；**reservation 原语本身仍是当前实现**：`scheduler reservations list|get|acquire|release|prepare-workspace|reconcile` 按 Project 操作，只有 `acquire` 的容量计数改为全 Runtime。

- **状态**：`RESERVED → RELEASED`，或 `RESERVED → RECOVERY_REQUIRED`（保持占用）。两条部分唯一索引把不变量变成 schema 事实：每 Task 一个活跃预留、一个 workspace 不被两个活跃预留占用。
- **归属证据** = 创建它的 Runtime `bootId` + `pid` + 该 pid 的 OS `startToken`（可为 null，如实记录）+ actor。**「这行是我建的」不作为证据。**
- **获取**在 `BEGIN IMMEDIATE` 内重检：active trust → Task `version` CAS → `revision_id` CAS → `state=READY` → 依赖事实指纹 → 无活跃预留 → 容量（上限在同一事务内从表里重读）→ draining。两个 pass/两个请求只能有一个成功。
- **释放**必须带 `--reason`；可证明仍存活的持有者被拒绝释放（`SLOT_HOLDER_STILL_RUNNING`），重复释放是诚实 no-op（`ALREADY_RELEASED`）。**绝不因心跳过期、用户等待或 UI 消失自动释放**（本实现没有任何心跳）。
- **reconcile 判定**（`inspectSlotHolder` 读真实进程表）：pid 不存在/僵尸 → `HOLDER_STOPPED`；pid 存活且 token 相同 → `HOLDER_STILL_RUNNING`；pid 存活但 token 不同 → `HOLDER_PROCESS_ID_REUSED`；token 缺失或进程表读不到 → `HOLDER_OWNERSHIP_UNVERIFIABLE`；没有进程身份 → `PROCESS_IDENTITY_MISSING`。已死则记 `RELEASED`（带 `RECONCILED_*` 原因），仍存活**保持占用**，无法核验转 `RECOVERY_REQUIRED` 且**不自动放行**。本代自己创建的预留跳过（`SKIPPED_HELD_BY_RUNTIME`）。
- reconcile **不发信号、不杀进程、不删资源、不声称静止**；每次观测（含「决定保持占用」这种没有状态变化的情形）都追加到 `execution_slot_reservation_events`，`UNIQUE(reservation_id, command_id)` 让同一代重复 reconcile 幂等。启动序列在既有 reconcile 之后追加这一步。
- **等待原因**：容量用独立稳定码（`CAPACITY_GLOBAL_LIMIT_REACHED` / `SCHEDULER_DRAINING`，带 `{ limit, used, blocking[] }`）；`BLOCKED` 仍只表示依赖未满足。Runtime 的 draining 是**内存事实**，只在开始 shutdown 时置位（不持久化，否则崩溃后会残留并永久拒绝新预留）。
- `acquire` 退出码：**0** 拿到槽位、**3** 容量等待/正在排水（`--json` 的 `wait.code` 给原因）、**1** 拒绝（依赖未满足、revision/版本过期、已有预留、未知 adapter、非法上限）。`prepare-workspace` 只有**本代创建**的 `RESERVED` 预留可用，同一 commandId 重放不产生第二个 worktree。全部命令零新增确认、`--json`、退出码稳定。

## 8. Runtime 全局负载控制（ADR-0061；§8.1–§8.3 都已实现，schema v34）

实现位置：容量 `apps/runtime/src/capacity-service.ts`；屏障与 Provider 冻结 `apps/runtime/src/runtime-control-service.ts`；状态机与逐条确定行为见 [`state-machines-runtime.md`](./state-machines-runtime.md) §6.1。

### 8.1 唯一全局容量（FOUNDATION-096）

```text
scheduler capacity get [--json]
scheduler capacity set --limit <1..16> [--json]
scheduler capacity reset [--json]
```

`get` 列出跨项目占用者（project/task/adapter/since/source）与当前 `pauseState`；`set`/`reset` 零确认、同值幂等，`reset` 回到默认 2，越界按稳定码拒绝。`scheduler reservations *` 仍按 Project 操作，但 `acquire` 在同一个 immediate transaction 中统计**整个 Runtime** 的占用。暂停状态不是容量的一部分：它在容量判断之前返回 `SCHEDULER_GLOBALLY_PAUSED`（exit 3）。

### 8.2 全局控制状态（FOUNDATION-097）

```text
RUNNING → PAUSING → PAUSED → RESUMING → RUNNING
             └──────────────→ RECOVERY_REQUIRED
```

- `PAUSING` 一提交，新的 reservation、Execution/Session/successor start 与 Provider 投递全部被屏障阻止。
- 固定本 epoch 的活动 process incarnation；按 pid + start token + incarnation 重验后，只冻结 Adapter 已证明是模型请求发起者的 Provider 主进程。工具子进程/进程组不接收暂停或终止信号。
- 只有所有目标都被观察为 stopped（或已证明在屏障前退出）才写 `PAUSED`；部分冻结、身份不可读、平台不支持都进 `RECOVERY_REQUIRED` 并保留屏障。
- `resume` 只恢复同 epoch 中身份完全一致的 stopped 主进程；全部收口后才写 `RUNNING` 并触发一次事件型 pass。
- 状态持久化；Runtime 启动先读屏障，**不自动继续**旧 Provider。全局冻结不改 Task/Execution/Session 状态，也不释放槽位。
- 命令面：`scheduler control status|pause|resume|reconcile [--json]`。`reconcile` 只观察，不发暂停/继续/终止信号。`pause`/`resume` 只有在完整收口或幂等命中目标状态时 exit 0；部分结果 exit 1 并逐目标报告。普通 Task 因屏障等待仍 exit 3，**永远不是 `BLOCKED`**。
- 事件：`SchedulerGlobalPauseRequested`、`SchedulerGlobalPaused`、`SchedulerGlobalResumeRequested`、`SchedulerGlobalResumed`、`SchedulerGlobalControlRecoveryRequired`（`project_id = NULL`、`aggregate_type = RuntimeSchedulerControl`）；回执在 `runtime_command_receipts`（同 commandId 重放返回同一结果，同键异文 `COMMAND_CONFLICT`）。payload 见 [`event-model-payloads.md`](./event-model-payloads.md) §6。

候选判定的**第 0 步**先读屏障：命中时 disposition 为 `WAITING`、`wait.kind='CONTROL'`、`wait.code='SCHEDULER_GLOBALLY_PAUSED'`，且**不写** `TaskWaitingForConflict`/`TaskWaitingForCapacity`（那会把全局事实误记成冲突或容量）。屏障在 start 已经发出后才提交的竞态会让 start 抛 `SCHEDULER_GLOBALLY_PAUSED`，调度层把该结果记为 **WAIT**（不是 `FAILED`）并释放预留。

### 8.3 暂停期间

已运行的工具/验证命令不因全局暂停收到停止信号；已发出的模型请求不被取消，可能在服务端完成。只读查询、事件订阅、记录用户输入、显式 `task cancel/pause/recover/purge`、Runtime stop 与不调用模型的 Git/验证操作继续可用。answer/guidance 可耐久记录，但实际 Provider 投递延后到恢复并重验有效性之后。

Provider 冻结能力按 Adapter 如实声明（实测证据见 [`agent-adapter-providers.md`](./agent-adapter-providers.md) §1）：Pi `SUPPORTED`，Codex 与 Claude Code `REQUIRES_VALIDATION`，因此它们的目标会让 epoch 进入 `RECOVERY_REQUIRED` 而不是 `PAUSED`。POSIX 以外的平台不能降级成「只暂停调度」后仍声称 `PAUSED`。
