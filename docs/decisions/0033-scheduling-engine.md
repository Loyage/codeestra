# ADR-0033：调度引擎（自动 tick、候选顺序、等待语义、UNKNOWN 放行接线与 §4 越界处置）

Status：Accepted（本轮实现：FOUNDATION-055，schema **未占用**——仍是 v21；零新增确认门禁）

## Context

Wave E 已把三样东西落地：依赖与 `BLOCKED` 的唯一含义（E0/ADR-0024 与 `scheduler.md` §1–§2、ADR-0030 的十项决策）、确定性 ImpactSnapshot 与保守判定（E1/ADR-0031）、容量与槽位预留原语（E2/ADR-0032）。但把它们**接成真的会跑的调度循环**的那一格（Wave F / F1）一直不存在：

- `task.submit` 之后没有任何东西会启动候选；「两个 SAFE 且不相交的任务在容量 2 下真的同时进入 RUNNING」在验收矩阵里不成立；
- `scheduler.md` §2 的顺序、§1 的活跃集合、`wait(CONFLICT)` / `wait(CAPACITY)` 的区分只存在于文档；
- ADR-0030 D05 的 `--allow-unknown` 只有语义、没有命令面与审计落点；
- `scheduler.md` §4「实际 diff 超出预测」没有任何实现路径。

本 ADR 记录 F1 把这条链接通时**必须做出的决定**，以及两处「规格与既有实现不一致」的处理方式（见 D05/D06）。它不是对 ADR-0030/0031/0032 的重新解释：那三份 ADR 的语义照旧，本 ADR 只补实现层的接线决策。

## Options

1. **候选的影响从哪来**：一个从未启动过的 READY 候选没有 worktree，也就没有可观测的改动集。
   - A. 没有 worktree ⇒ `MISSING_IMPACT_SNAPSHOT` ⇒ UNKNOWN ⇒ 只要活跃集非空就永远等待；**（否决）**
   - B. 没有 worktree ⇒ 记为「观测到的改动集为空」，经分析器自己的 `createImpactSnapshot` 判断完整性（映射完整即 SAFE）；**（选择）**
   - C. 用 LLM 预测 revision 会改哪些文件。（ADR-0030 D03 已否决）
2. **自动 pass 在「UNKNOWN 且活跃集为空」时的行为**：
   - A. 与显式请求完全同一判定：独占启动；**（否决，见 D03 理由）**
   - B. 自动 pass 只启动它能证明 `SAFE` 的候选；`UNKNOWN` 一律等待，由用户显式请求（`task run`，独占）或 `--allow-unknown` 启动。**（选择）**
3. **`task.run` 是否也走冲突门禁**：
   - A. 是，与自动 pass 同一判定（用户本轮拍板）；**（选择）**
   - B. `task run` 保持旧行为（只查依赖），门禁只作用于自动 pass。（否决：那会让 `--allow-unknown` 变成可绕过的摆设）
4. **`--allow-unknown` 的生效范围**：只放行 `UNKNOWN`（选择），或也放行 `CONFLICTING`（否决：已证明的重叠不是「未知」）。
5. **放行记录的落点**：新建一张表（需占 v22），或写进既有的 append-only `domain_events` 台账。**（选择台账）**
6. **PAUSED 是否留在活跃集合**：见 D06。
7. **§4「请求安全暂停」的力度**：
   - A. 自动调用既有协作暂停，把无法确认停止的处置交给既有机制（`RECOVERY_REQUIRED`）；**（选择）**
   - B. 只记录一个「建议暂停」的事实，不真的暂停。**（否决：那样 §4 就只是日志）**
   - C. 为解决冲突抢占任意其他任务。（ADR-0030 D06 已否决抢占）

## Decision

### D01：调度由 Runtime 自动 tick 驱动，且 pass 分两类

- **事件驱动 pass（会启动）**：`task.submit`、`task.integrate`（`dev` 变动，下游可能刚可运行）、`task.pause`/`task.cancel`（活跃集变化）、`task.resume`、`task.schedule.run`（显式请求）、槽位释放、容量变更、修订投递 resolve、以及**执行结束**（由 coordinator 在 run Operation 结算后回调）。
- **周期恢复 pass（只收敛、不启动新执行）**：默认每 `CODEESTRA_SCHEDULE_TICK_MS`（默认 5000ms）跑一次，刷新活跃任务的观测、检测 §4 越界、记录等待与撤销；它**不**新开 Execution。理由是 ADR-0030 D04 给周期 tick 的定位就是「收敛崩溃/重启后遗留的预留与容量计数」；让周期 tick 也去启动会让「谁在什么时刻启动了工作」不可预测，并让既有 e2e 断言（提交后任务仍 READY）随机失败。启动的触发面因此是**确定的**：一个事件或一条命令。
- **启动序列（Runtime 侧）**：既有 reconcile 全部跑完之后追加一次 `STARTUP` pass 与周期 tick 的启动；不移动 D1 的 revision reconcile 与 E2 的槽位 reconcile 的顺序。
- pass 在 Runtime 内**互斥**（一个执行中的 pass 让并发的周期 tick 变成 no-op）；跨进程仍由 E2 的 `BEGIN IMMEDIATE` 与唯一索引保证。
- FULL 下新增确认步骤：**0**。

### D02：候选顺序与循环照 `scheduler.md` §1–§2，不重新发明

顺序是 priority 降序 → `createdAt` 升序 → ID 升序（E2 已有的「提优先级不抢占」语义因此自然成立：优先级只被读来排序，循环从不写任何运行中任务的资源）。逐候选：依赖未满足或上游 commit 不可达 ⇒ `BLOCKED` → 冲突判定（含外部基线重检）⇒ `wait(CONFLICT)` → 容量 ⇒ `wait(CAPACITY)` → 预留（`BEGIN IMMEDIATE` 内重检）→ 事务外准备 workspace → 启动前重检基线/revision ⇒ 启动**一个**主 Agent → 新预留进入活跃集合后再看下一个候选。**没有 Adapter 可用不是 `BLOCKED`**（是一类 `SKIPPED`，带稳定 detail）。

### D03：候选的预测经分析器自己的构造器产生（`scheduler.md` §2 + ADR-0031 复用）

一个从未启动过的候选没有 worktree，因此没有可观测的改动集。把它记成 `MISSING_IMPACT_SNAPSHOT` 会让**任何**新任务都无法与活跃任务并行（等于把默认容量 2 变成串行，直接违反 ADR-0030 D01）。因此：**没有 workspace 的候选，其观测改动集是空集**，并照常经 `createImpactSnapshot` 得到「空 + 完整」的预测（映射完整且已确认时 `complete=true`）。这条预测显式记录为一个 append-only 的 ImpactSnapshot（指纹是稳定的 `codeestra:pre-start-impact:no-observed-change`，evidence 里写明「尚未有 worktree，观测为空」），因此「这次启动依据的是哪份预测」可审计；一旦 worktree 存在且仍无改动，分析器会**复用它**而不是再记一份。

**残余风险被明确保留，不掩盖**：空预测与任何活跃任务都不重叠，所以两个「尚未写出任何东西」的任务会被判为 SAFE 并并行——`scheduler.md` §4 的越界处置（D07）就是这条风险的补偿，而不是把它藏起来。

### D04：自动 pass 只启动 `SAFE`；`task.run` 与自动 pass 共用同一门禁

- 自动 pass：`SAFE` ⇒ 启动；`UNKNOWN` ⇒ 等待（活跃集为空也一样等待）；`CONFLICTING` ⇒ 等待。
- 显式请求（`task run`、`task resume`、`task schedule run`）：同一门禁，但**允许** `UNKNOWN` 在活跃集为空时独占启动（`scheduler.md` §2「单任务且影响未知可以独占运行」）；活跃集非空时仍然等待，需要 `--allow-unknown`。
- 这样 D05「UNKNOWN 默认等待（不启动、不并行）」与 §2「可以独占运行」不再互相打架：**等待是默认，独占是用户显式请求的结果**，而自动 pass 从不替用户承担「无法证明」的风险。

### D05：`--allow-unknown` 是显式单次放行，落点是既有事件台账（不占 schema）

- 命令面：`task run <project> <task> <version> --allow-unknown`、`task resume … --allow-unknown`、`task schedule clear-unknown <project> <task>`。后者只记录放行、不启动（供自动 pass 之后使用）。
- 落点：一条 append-only 的 `TaskUnknownCleared` 事件（`aggregate_type='TaskSchedule'`，`correlation_id` 是调用命令，因此重放不产生第二条），payload 绑定 `revisionId`、`baseCommit`、`analyzerVersion`、`policyVersion`、当时的 `reasonCodes`/`hits`、`releasedBy`、`releasedAt`、`scope: 'SINGLE_START'`。**不占 schema 版本**（仍是 v21，`migration.ts` 一行未动）：这只是一条关于过去的审计事实，正是台账的用途。
- **失效**：revision 变化、基线变化、映射或分析器版本变化都让放行不再匹配当前评估（比较四个绑定字段），必须重新评估、必要时重新放行。
- **单次**：一次放行只授权一次启动；被授权的启动在 `TaskScheduleDecided` 里记录 `clearedUnknownBy = <放行事件 id>`，之后该放行不再可用。
- **不改写判定**：`conflict_assessments` 里那次结论仍是 `UNKNOWN`（测试断言放行后 `project impact explain` 仍然 UNKNOWN、且配对的 assessment 行仍是 UNKNOWN）。
- **只放行 UNKNOWN**：`CONFLICTING` 是已证明的重叠，`--allow-unknown` 与 `clear-unknown` 都会拒绝（退出码 1，稳定状态 `CONFLICTING`）。

### D06：调度器的活跃集合 = §1 的活跃集合（PAUSED 也在内），但不改 E2 的容量语义

`scheduler.md` §1 明说活跃集合包含 `PAUSING`/`PAUSED`/`STOPPING`/`CANCELLING`/`RECOVERY_REQUIRED` 与已预留未启动者，并且「不得因用户等待释放资源」。**基线里有一处不一致**：暂停确认（ADR-0016 的实现）把 Execution 置为 `SUPERSEDED`、`resource_held=0` 并把 workspace 置为 `RETAINED`——于是 PAUSED 任务**不在** E1/E2 的资源持有投影里（`listImpactActiveTasks`、`countActiveSlotOccupants` 都按 `resource_held` 选）。

本格的处理：

- **冲突侧**（本格职责）：调度器自己维护活跃集合 = E1 的资源持有投影 **∪** 仍持有 worktree 的 `PAUSED` 任务（`#activeTaskRefs`）。因此「两个 PAUSED 且范围重叠的任务不能被同时恢复」成立，`project impact explain` 的投影不变。
- **容量侧**：**不动**。E2 的占用口径（`resource_held` + 活跃预留）保持原样，PAUSED 不占槽位。这是 E2 的语义，改它需要动 `scheduler.reservations` 的判定，属于「要改语义先向用户报告」的范围。
- **如实报告**：这意味着「PAUSED 占用容量」在**实现里并不成立**（尽管 ADR-0031 D06 / ADR-0032 D03 的文字假定它成立）。这条不一致留给用户决定：要么改暂停实现（PAUSED 保留 `resource_held`），要么改 ADR 文字。本格不改任何一方，只在文档与任务记录里写明。

### D07：`scheduler.md` §4 的越界处置

每个活跃任务都被比对「**启动它时所依据的那份预测**」（`TaskScheduleDecided.candidateSnapshotId`）与「其 worktree 现在显示的改动集」：

- 观测刷新由分析器自己完成（`inspectTaskImpact`），所以「diff 长大了」这件事是分析器的记录，不是调度器的猜测；
- 只有在同一个 revision/baseline/映射/分析器版本下**改动集合真的变了**才算越界（换 revision、移动基线、改映射、换分析器版本各自是另一种 stale）；
- 若长大后的范围与另一个活跃任务**可证明重叠**（CONFLICTING 命中）：写 `TaskImpactPredictionRevoked` 事件（带前后快照 id、新增/移除路径、命中的任务、reason code），然后**通过既有协作暂停**请求该任务安全暂停（`task pause` 语义：PAUSING → 确认 provider 退出 → PAUSED；确认不了就落 `RECOVERY_REQUIRED` 并保留现场）；同一份观测只撤销一次（事件去重），所以无法确认停止的任务不会被周期 pass 反复打扰；
- 若长大后的范围不与其他活跃任务可证明重叠：只记录（报告里可见），不撤销也不暂停——否则任何正常写文件的 Agent 都会被立刻暂停；
- 「不再启动相关新任务」由候选循环自动完成：后续候选读到的是新快照；
- **绝不抢占**：暂停的请求只指向「自己的预测被证伪」的那个任务，不会为解决冲突去停别的任务。

### D08：命令面与退出码（CLI 完备、零确认）

```
task schedule status <project-id> [--adapter <id>] [--json]
task schedule plan   <project-id> [--adapter <id>] [--json]
task schedule explain <project-id> <task-id> [--adapter <id>] [--json]
task schedule run    <project-id> [--adapter <id>] [--json]
task schedule clear-unknown <project-id> <task-id> [--json]
task run    <project-id> <task-id> <expected-version> [--adapter <id>] [--allow-unknown] [--json]
task resume <project-id> <task-id> <expected-version> [--adapter <id>] [--allow-unknown]
```

- `status`/`plan` **只读**：两者都不预留、不 prepare、不启动，`plan` 只是显式标注的同一份有序 dry run（候选走的是同一套判定，但以「将会怎样」回答；查询类命令绝不启动工作——这一点在实现里由 `#overview` 恒用 `dryRun: true` 保证，并有断言：一个「会被 pass 启动」的候选在 `status`/`plan` 之后仍是 READY、零 Execution）。`status` 的 §4 pass 只观测不请求暂停。它们仍会记录观测快照，那是分析器读取事实的副作用，不是调度副作用。`run` 请求一次 pass，报告里给出 started/waiting/blocked/skipped/failed。
- `explain` 回答「为什么这个任务现在没在跑」：依赖 verdict、与每个活跃任务的 verdict 与命中范围（路径/目录/模块/共享资源）、容量数字、等待原因码；`PAUSED` 的任务还会给出「恢复是否被允许」的判定。
- 退出码：`explain` **0** = 在跑或现在会启动，**3** = 等待（冲突或容量——等待从来不是 `BLOCKED`），**1** = `BLOCKED` 或不可调度。`task.run` 同构：**0** 启动、**3** 等待（reason code 在 `--json` 与 stderr）、**1** 拒绝（`BLOCKED`、`CONFLICTING`、不可启动状态）。`task schedule run` **0** = pass 跑完了（不代表启动了任何东西）。`clear-unknown` 对 `CONFLICTING` 退出 1。
- **`task.run` 的响应是既有结果的超集**：`executionId`/`sessionId`/`workspacePath`/… 仍按原样返回（启动成功时非 null），调度事实（`outcome`/`wait`/`assessment`/`clearedUnknownBy`）并列返回。既有客户端不必改。
- 自动选择 Adapter：`pi` 已注册则用它，否则用第一个已注册的；`--adapter` 可覆盖；判定与事件里记录实际使用的 Adapter。**没有**新增「项目级默认 adapter」配置。

### D09：事件名与台账（不复用 E2 的名字）

新增事件：`TaskScheduleDecided`、`TaskWaitingForConflict`、`TaskWaitingForCapacity`、`TaskUnknownCleared`、`TaskImpactPredictionRevoked`（`aggregate_type='TaskSchedule'`，aggregate 是 Task）。E2 的 `ExecutionSlot*` 与 `SchedulerCapacityChanged` **不重命名、不复用**。等待事件只在等待**发生变化**时写一条（按 code + reasonCodes + blocking 去重），因此台账能读出「从什么时候开始为什么在等」，而不是每 tick 一行。

## Consequences

- 已实现：`apps/runtime/src/schedule-service.ts`（新，调度循环与台账）、`agent-runtime-service.ts` 的 `runScheduledExecution`（在预留下准备 workspace、预留 Execution、启动一个主 Agent；与 `task.run` 共用同一段启动代码）、`main.ts` 的接线与新命令、CLI 的 `task schedule` 命令组与退出码、contracts 的 `task.schedule.*` 与 `task.run`/`task.resume` 的 `allowUnknown`、storage 的两个台账读写方法（`recordTaskScheduleEvent`/`listTaskScheduleEvents`）。
- **没有 schema 变更**：`migration.ts` 一行未动，v22 未被占用，v16 的禁区也没有被动。
- 语义边界（由测试固定）：自动 pass 只启动 SAFE；`task.run` 在 UNKNOWN + 空活跃集时可独占；`--allow-unknown` 放行后可**与活跃任务并发**且单次、绑定、不改判定、基线变化即失效；容量等待与冲突等待都不是 `BLOCKED`；两次 tick / 两个并发请求只产生一个 Execution；PAUSED 仍在冲突活跃集合里；越界撤销 + 暂停走既有协作暂停；提优先级只改下一次排序。
- 已知残余风险（本 ADR 明确不掩盖）：
  - **空预测**：一个尚未写出任何东西的任务与活跃任务「不重叠」是**预测**，不是证明。§4 的撤销 + 暂停是补偿，但它发生在**观测到**越界之后。
  - **PAUSED 不占容量**：见 D06，是既有实现与 ADR 文字之间的不一致。
  - **周期 pass 只收敛不启动**：崩溃后遗留的 READY 任务要等到一次事件型 pass 才会被启动（`task schedule run` 可以随时请求一次）。
  - **`task revision delivery resolve --action stop-and-restart`** 是另一条启动路径，本格没有给它加冲突门禁（它在 E1 的 revision delivery 服务里，属于另一格）。

## Verification

只用 CLI/命令面与 Runtime 命令面（ADR-0008），不使用浏览器/桌面/键鼠自动化：

1. `apps/runtime/test/schedule-service.test.ts`（10 项，bun test，进程内）：真实临时 Git 仓库 + 真实数据库 + 真实预留原语，**注入**唯一的「启动 Agent」这一步（它准备真实 worktree、预留真实 Execution，但不起 provider 进程）。断言：候选顺序（priority/createdAt/id）与「提优先级只改顺序、不动已持有资源的任务」；两个 SAFE 候选都启动、第三个是 `CAPACITY_GLOBAL_LIMIT_REACHED`（不是 BLOCKED）且未创建 Execution；无映射时自动 pass 等待（`INCOMPLETE_IMPACT`）、显式请求可独占启动、有活跃任务时等待、`--allow-unknown` 可与活跃任务并发启动且审计里有绑定 / 判定仍是 UNKNOWN；放行被一次启动消费；基线移动使放行失效；越界成长 ⇒ 撤销 + 请求暂停（注入的 pause 被调用）；同文件重叠时恢复被拒绝，且 `--allow-unknown` 也拒绝；未满足依赖是 `BLOCKED` 且不启动；两次 pass 与两个并发请求只产生一个 Execution；PAUSED 仍在活跃集合（即便它不占槽位）；残留预留让启动被拒绝而不是重复创建。
2. `apps/runtime/test/cli-schedule.test.ts`（6 项，真实 CLI + 真实 Runtime + 独立 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider）：两个 SAFE 不相交任务的 submit 就自动启动、都 RUNNING、容量事实为 2、第三个 `task run` 退出 3 且 reason code 是 `CAPACITY_GLOBAL_LIMIT_REACHED`（stderr 里不出现 BLOCKED），审计里有两条 `TaskScheduleDecided`（verdict SAFE，第二条 `activeTaskIds=[第一个]`）与 `TaskWaitingForCapacity`；同文件重叠的 PAUSED 任务 `explain` 给出 `WAIT_CONFLICT`/`SAME_FILE` 与命中路径，`resume` 退出 1 且保持 PAUSED，`--allow-unknown` 与 `clear-unknown` 都拒绝；无映射项目自动 pass 等待、`task run` 独占启动、第二个任务等待、`--allow-unknown` 与活跃任务并发启动且 `TaskUnknownCleared` 绑定可读、`project impact explain` 仍是 UNKNOWN、`clear-unknown` 再次调用回到 `RECORDED`；两次 `task schedule run` 与两个并发 `task run` 只产生一个 Execution 且 stub 日志里每个任务只有一行；越界撤销（`TaskImpactPredictionRevoked`）+ 两个任务都被协作暂停 + 恢复被拒 + 现场保留；SIGKILL 崩溃后新 generation 不重复创建 Agent（Execution 唯一、stub 日志一行、启动 pass 不再启动它）。
3. 既有 e2e 回归：`apps/runtime/test/cli-impact.test.ts` 的 fixture 调整为「submit 后等调度器启动」（ADR-0030 D04 的必然结果），其余 195 项既有 e2e 未改动并保持通过。
4. `bun run check:fast` 与 `bun run check` 的实际退出码与计数见 `docs/tasks/README.md` FOUNDATION-055；手动端到端证据（`/tmp/ce-f1`）同样记录在那里。

**未验证**（不得当成已成立）：真实 provider 的并发（两个真实模型同时跑）；真实模型行为与 §4 越界在真实 diff 上的表现；UI 投影（UI 未接入 `task schedule *`，属于后续格）；多成员 IntegrationBatch；非 Git 共享资源；`task revision delivery resolve` 启动路径的冲突门禁。

## 关联文档

- `PROJECT_SPEC.md` §1.1（效率至上 / CLI 完备 / 测试边界）、§2 不变量 5/6/7/10/11/12。
- `docs/architecture/scheduler.md`（§1 活跃集合与容量模型、§2 算法与顺序、§3 两类锁、§4 修订与越界、§4.1 UNKNOWN 放行、§5 验收矩阵、§6 明确不做）。
- `docs/architecture/conflict-analyzer.md`（输入、纯判断规则、失效与解释）。
- ADR-0008（三条第一原则）、ADR-0011（FULL 零确认）、ADR-0016（暂停/取消/归档）、ADR-0018（成果入 `dev`）、ADR-0024（依赖与 `BLOCKED`）、ADR-0030（Phase 2 十项决策，本格的语义来源）、ADR-0031（ImpactSnapshot 与判定）、ADR-0032（容量与槽位预留）。
- `docs/roadmap/mvp.md` Phase 2；`docs/tasks/README.md` FOUNDATION-055。
