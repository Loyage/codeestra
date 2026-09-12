# Conservative Scheduler

状态：Phase 2 设计；Phase 1 只实施单活动任务资源门禁，不提前实现 DAG 并行。

## 1. 调度输入和顺序

候选为 READY、当前 revision 有效且无未完成修订确认的 Task。优先级整数降序，随后 createdAt 升序、ID 升序，实现确定性排序。提优先级不抢占。

第一版不自动 aging 或猜测任务成本；持续高优先级输入可能导致饥饿，UI 显示等待时长，后续以产品决策引入公平策略。

活跃集合包括准备/启动、RUNNING、WAITING_FOR_USER、PAUSING、PAUSED、STOPPING/CANCELLING、RECOVERY_REQUIRED 和已预留尚未启动的执行。不能因用户等待、心跳过期或 UI 消失就释放资源。

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
