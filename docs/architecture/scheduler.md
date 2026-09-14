# Conservative Scheduler

状态：Phase 2 设计；Phase 1 只实施单活动任务资源门禁，不提前实现 DAG 并行。

## 1. 调度输入和顺序

候选为 READY、当前 revision 有效且无未完成修订确认的 Task。优先级整数降序，随后 createdAt 升序、ID 升序，实现确定性排序。提优先级不抢占。

第一版不自动 aging 或猜测任务成本；持续高优先级输入可能导致饥饿，UI 显示等待时长，后续以产品决策引入公平策略。

活跃集合包括准备/启动、RUNNING、WAITING_FOR_USER、PAUSING、PAUSED、STOPPING/CANCELLING、RECOVERY_REQUIRED 和已预留尚未启动的执行。不能因用户等待、心跳过期或 UI 消失就释放资源。

### 1.1 容量模型（ADR-0030 D01/D02）

并发容量有两级上限，**同时生效**：

- **全局上限**：默认 **2**，可配置。显式改成 1 即退化为串行，但默认不是串行。
- **每 adapter 上限**：默认等于全局上限；只有显式配置才更低。全局仍有余位不会让某 adapter 突破自己的上限。

`wait(CAPACITY)` 因此有两个**可区分**的来源，调度器必须分别报告，不能合并成一个含糊的「容量等待」：

- `GLOBAL_CAPACITY`：全局占用已满（准备/启动、RUNNING、WAITING_FOR_USER、PAUSING、PAUSED、STOPPING/CANCELLING、RECOVERY_REQUIRED 以及已预留但尚未启动的执行都计入占用）。
- `ADAPTER_CAPACITY`：全局未满，但候选所需 adapter 的槽位已满。

容量等待不是 `BLOCKED`（`PROJECT_SPEC.md` §2.10）：它不改写依赖理由，也不算故障。本波不按主机 CPU/内存自动推导容量（见 §6）。

### 1.2 触发模型（ADR-0030 D04）

调度由 Runtime **自动 tick** 驱动，用户不需要手动「推」任务：

- **事件驱动**：相关提交事件（submit、依赖变更、revision 投递/恢复、Execution 终态、取消/暂停结束、合入 `dev`、容量释放等）触发一次 tick。
- **周期恢复 tick**：无事件时按周期再跑一次，用于收敛崩溃/重启后遗留的预留与容量计数；周期 tick 只重跑同一套判定，不引入新状态。
- **submit 后自动进入调度**：`task.submit` 成功后候选自动进入下一次 tick；FULL 下新增确认步骤数为 **0**，STRICT 也不把调度当作需批准的操作。
- 既有 `task.run` 仍是同一命令面的一部分（可用它立即请求一次调度并得到结果，满足 CLI 完备与可脚本化），但它不再是启动任务的**必经**路径。

## 2. 调度算法

```text
on relevant committed event or periodic recovery tick:
  if runtime draining: return
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

## 3. 两类锁

- Runtime 实例锁：同一数据库/资源域只允许一个写入执行协调实例。IPC token 与进程身份独立校验。
- 资源预留：SQLite 内表达 Task 执行权、workspace、Adapter slot；跨进程崩溃后必须 reconcile 后释放。

数据库 reservation 不能当 OS 强隔离。外部进程不受 SQLite 锁控制，因此启动前及恢复时还需核对真实写入者。

## 4. 修订、实际影响扩大与恢复

用户修订按照 ADR-0001 暂停对应任务、使旧影响评估失效。恢复前重新与活跃集合进行冲突分析，存在 UNKNOWN/CONFLICTING 就保持暂停。不能为解决冲突自动抢占其他任务。

实际 diff 超出预测时撤销旧 SAFE，不再启动相关新任务，向执行协调层报告并请求受影响执行进入安全暂停。无法可靠停止时标 RECOVERY_REQUIRED、保留隔离现场，禁止自动集成。第一版 analyzer 无法事先证明运行中的两个 Agent 永不越界，必须明确此残余风险。

取消超时：保留 slot 与 workspace，提醒人工处理；不通过超时自动认定死亡。排空升级需确认所有潜在写入资源已静止。

### 4.1 UNKNOWN 的显式单次放行（ADR-0030 D05）

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

- **非 Git 共享资源的 resource claim（端口、数据库、dev server）**：不引入。不同文件不能证明这些资源可共享，因此这类冲突继续由 `complete=false → UNKNOWN` 保守承载，而不是用一个没有归属校验的声明字段假装安全；留后续。（全局共享资源清单仍由 `.codeestra/impact.json` 的 `globalResources` 表达，那只覆盖 Git 可见影响。）
- **多成员 IntegrationBatch 批次**：成果入 `dev` 继续**各自独立批次**（现状）；CLI 显式组批与自动组批都留后续。
- **饥饿公平策略（aging）**：不加 aging。持续高优先级输入可能饿死低优先级任务，UI 只显示等待时长；公平策略作为独立产品决策留后续。

同样明确不做：按主机 CPU/内存自动推导并发容量；LLM 辅助的 ImpactSnapshot 预测；在 `UNKNOWN` 上新增除 `--allow-unknown` 之外的任何门禁、审批或信任流程。
