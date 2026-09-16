# ADR-0032：容量与槽位预留（全局上限 + 每 adapter 上限 + reservation/release/崩溃 reconcile）

Status：Accepted（本轮实现：FOUNDATION-054，schema **v21**；零新增确认门禁。**Amended by ADR-0061（已接受、待实现）**：`project_capacity_limits` / `project_adapter_slot_limits` 与项目内计数将退役，改为每 Runtime 唯一跨项目上限；reservation/归属/reconcile 原语继续保留。）

## Context

Phase 2（`docs/roadmap/mvp.md`）要求「资源预留和多 worktree 调度」。`docs/architecture/scheduler.md` 已经把这条边界写清楚：§1 的活跃集合必须包含「已预留尚未启动的执行」，§2 的算法规定在**容量判定之后**才 `BEGIN IMMEDIATE` 重检并写入执行权/workspace/adapter slot，§3 把「Runtime 实例锁」与「资源预留」分成两类锁，§4 要求「reservation 后 Runtime 崩溃：先核对，不能重复创建 Agent」。

Wave E 的用户决策（并发容量 = 全局上限、默认 2、可配置；adapter 槽位 = 每 adapter 单独上限、缺省等于全局上限；不加 aging；非 Git 共享资源本波不做）已经把产品语义固定。本格只做**容量与槽位这个原语**，不做冲突分析（E1）、不做候选排序 / 自动 tick / `--allow-unknown`（Wave F 的 E3）。

当时的事实与缺口：

- 存储层只有 `executions.resource_held` + `one_held_execution`（每 Task 一个持有中的 Execution）与 `workspaces.state`（`READY`/`IN_USE`）。它们表达「Task 执行权」与「workspace 占用」，但**没有容量概念**：没有全局上限、没有 adapter 维度、没有预留与释放的审计、没有跨进程崩溃后的归属核验。
- 没有任何「谁创建了这个预留」的证据。按 ADR-0023/ADR-0028 的既有做法，进程身份是 `pid + OS start token`；「pid 还在」从来不是归属证明。
- `PROJECT_SPEC.md` §2 不变量 10 明确：`BLOCKED` 专指依赖条件未满足，**冲突等待、容量等待与故障不能都归为 BLOCKED**。当时没有任何可表达「容量等待」的事实或稳定码。

## Options

1. 容量上限的来源：
   - A. 按主机资源自动推导（CPU/内存/负载）；
   - B. 显式配置：项目级全局上限（默认 2）+ 每 adapter 上限（缺省 = 该项目的全局上限）；**（选择，用户已拍板）**
   - C. 不做上限，只做排队与可见性。
2. 预留的落点：
   - A. 复用 `executions.resource_held` 一个字段，把容量算在 Execution 上；
   - B. 新增独立 `execution_slot_reservations` 表，表达「Task 执行权 + adapter slot + （可绑定的）workspace」，并由部分唯一索引保证唯一性；**（选择）**
   - C. 只在 Runtime 内存里排队（无持久化）。
3. 获取的原子性：
   - A. 读一遍判断再写（读写之间可被并发插入）；
   - B. 在 `BEGIN IMMEDIATE` 内重检 Task 版本、revision、依赖事实、容量与 draining，再写入；**（选择）**
   - C. 只依赖数据库唯一索引，重检放到调用方。
4. 释放：
   - A. 心跳超时 / 客户端消失 / 用户等待过久自动释放；
   - B. 显式释放（必须带原因）+ 崩溃后 reconcile 中的「已证明归属者已死」释放；其余一律保持占用；**（选择）**
   - C. 由下一次调度 tick 顺带清理过期预留。
5. 崩溃后无法核验归属者时：
   - A. 乐观释放（假定进程已死）；
   - B. 保持占用并标 `RECOVERY_REQUIRED`，不自动放行，保留失败现场；**（选择）**
   - C. 杀掉记录到的 pid 后再释放。
6. 容量等待的表达：
   - A. 与依赖未满足一样报 `BLOCKED`；
   - B. 独立的稳定 reason code（`CAPACITY_GLOBAL_LIMIT_REACHED` / `CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` / `SCHEDULER_DRAINING`）+ 可查询的容量事实；**（选择）**
   - C. 只写日志，命令面不表达。
7. CLI 退出码：
   - A. 容量等待也算失败（exit 1）；
   - B. 容量等待是「现在拿不到」，单独用 exit 3 与拒绝（exit 1）区分；**（选择）**
   - C. 全部 exit 0，靠 `--json` 里的 outcome 区分。

## Decision

### D01：容量是配置事实，两个维度都显式

> **后续修订（ADR-0061，尚待实现）**：容量仍是显式配置、默认 2、范围 1–16，但只剩一个 Runtime 维度；项目级与 Adapter 级两张配置表、`clear --adapter` 与 Adapter 容量等待将被删除。旧显式值迁移取最小值。以下是 v21 当前实现与历史依据。

- `project_capacity_limits(project_id, global_limit, version, updated_at, updated_by)`：项目级并发上限。**没有行就是「未显式设置」**，读取时返回文档默认值 `2`，并如实报告 `limitSource = 'DEFAULT'`。
- `project_adapter_slot_limits(project_id, adapter_id, slot_limit, ...)`：adapter 覆写。**只有显式设置过才存在行**，因此「缺省等于全局上限」是**派生事实**而不是复制值：改全局上限会移动所有没有覆写的 adapter，`capacity get` 也能报出每个上限的来源（`DEFAULT`/`EXPLICIT`）。
- 不做主机资源自动推导（用户决策 1）；不引入非 Git 共享资源（用户决策 8）。
- 校验：上限必须是 **≥1 且 ≤ 16**（`maxConcurrencyLimit`）的整数。`0`/负数/小数 → `CAPACITY_LIMIT_INVALID`；超过上限 → `CAPACITY_LIMIT_OUT_OF_RANGE`；未知 adapter id → `UNKNOWN_ADAPTER`（对照 registry 的 adapter 集合）。**拒绝，绝不静默夹取**，且被拒绝的请求不写任何行。
- 每次改变写一条 append-only 的 `SchedulerCapacityChanged` 事件（`aggregate_type = 'SchedulerCapacity'`，`aggregate_id = projectId`，payload 含 `scope`/`adapterId`/`from`/`to`/`actor`）。重复设置同一个值不 bump 版本、不发事件。
- 降低上限**不会**释放任何已持有的槽位：它只影响之后获取的判定（`available` 可以为 0，`used` 可以大于 `limit`；聚合事实如实反映这一点）。

### D02：预留是一个原语，获取在 `BEGIN IMMEDIATE` 内重检

`execution_slot_reservations(id, project_id, task_id, revision_id, task_version, adapter_id, workspace_id, impact_snapshot_id, dependency_fingerprint, assessed_dev_commit, state, version, command_id, holder_*, reserved_at, updated_at, released_at, release_reason, release_kind, release_observation, detail)`：

- 一行同时表达 scheduler.md §3 的三件事：**Task 执行权**（每 Task 只有一个活跃预留）、**adapter slot**（`adapter_id` + 容量计数）、**workspace**（绑定后 `workspace_id`，由 `one_active_workspace_reservation` 保证一个 worktree 不被两个活跃预留占用）。
- 两个**部分唯一索引**把不变量变成 schema 事实，而不是约定：
  - `one_active_slot_reservation ON (task_id) WHERE state IN ('RESERVED','RECOVERY_REQUIRED')`；
  - `one_active_workspace_reservation ON (project_id, workspace_id) WHERE state IN (...) AND workspace_id IS NOT NULL`。
- `state ∈ {RESERVED, RELEASED, RECOVERY_REQUIRED}`，一致性 CHECK：`RESERVED` 不能带释放字段，`RELEASED` 必须带 `released_at` + `release_reason` + `release_kind`，`RECOVERY_REQUIRED` 保持未释放。`RECOVERY_REQUIRED` **照样占用容量**——「保持占用」不是一句注释。
- 获取路径（storage 层，`BEGIN IMMEDIATE`，用 `sqlite.transaction(...).immediate(...)`）在同一事务内重检，顺序即 scheduler.md §2 的顺序：
  1. 项目有 ACTIVE trust；
  2. Task 的 `version` == 调用方的 `expectedTaskVersion`（CAS，失败 `CONCURRENT_MODIFICATION`）；
  3. `current_revision_id` == 调用方的 `expectedRevisionId`（失败 `REVISION_CHANGED`）；
  4. `state == 'READY'`（失败 `TASK_NOT_RESERVABLE`）；
  5. **依赖事实重读**：在同一连接（同一事务）内重读该 Task 的依赖边，与调用方评估时用的 `dependencyFingerprint` 比较，不同则 `DEPENDENCY_STATE_CHANGED`；
  6. 该 Task 没有活跃预留（否则 `SLOT_ALREADY_RESERVED`，错误文本带既有预留 id 与状态）；
  7. **容量**：`globalUsed >= globalLimit` → `CAPACITY_WAIT(CAPACITY_GLOBAL_LIMIT_REACHED)`；`adapterUsed >= adapterLimit` → `CAPACITY_WAIT(CAPACITY_ADAPTER_SLOT_LIMIT_REACHED)`；容量上限在同一事务内**从表里重读**，不用调用方传入的值；
  8. **draining**：draining 回调也在事务内求值 → `DRAINING`；
  9. 写入预留 + append-only 历史行 + `ExecutionSlotReserved` 事件。
- 依赖的 Git 部分（pinned 上游 revision 是否仍可从 `dev` 到达）留在 scheduler（`assertDependenciesSatisfied`）；本格不复制那套判定。存储层能证明的是「这次写入与调用方评估时的依赖事实一致」。
- 被拒绝或等待的获取**只留下 command 回执**，不写任何预留（回执是「这次命令观察到的事实」，同一个 `commandId` 重放返回同一次观测；CLI 每次调用都生成新的 `commandId`，所以重试是一次新的判定）。
- 「快照代」这一维度**如实标注**：本基线里没有 impact snapshot 存储（E1 领地），因此 `impact_snapshot_id` 只记录调用方声明的快照 id，真正的「快照代重检」要等 E1 落地并由 Wave F 传入。**不假装已经重检。**
- `assessed_dev_commit` 记录这次评估所依据的 `dev` OID。跨 Git/SQLite 不假定原子性：scheduler.md §2 本来就要求启动 Agent 前再核对一次外部基线，这里只把事实写下来。

### D03：容量占用按 Task 计，不按行计

一次占用 = 一个 Task 占着一个槽。占用集合是两个来源的**并集**（同一 Task 只计一次）：

1. 活跃预留（`RESERVED`/`RECOVERY_REQUIRED`）；
2. `executions.resource_held = 1`（既有的 `task.run` 路径，尚未经过预留原语）。

并集而不是求和，正是为了让「先预留、再启动 Execution」的同一个 Task 只吃一个槽；同时让今天的真实并发（没有预留行的执行）也如实计入容量事实。`excludeTaskId` 让一个 Task 不会因为自己的预留而阻塞自己。

### D04：归属证据与释放语义

- 每个预留记录**归属证据**：创建它的 Runtime `bootId`、创建进程 `pid`、该 pid 的 **OS start token**（可能为 null，OS 拒绝回答时如实记录为空），以及 actor。**「这行是我建的」不作为证据**。
- 显式释放（`scheduler reservations release`）必须带 `--reason`，写入 `released_at`/`release_reason`/`release_kind = EXPLICIT`，并追加 `RELEASED` 历史行与 `ExecutionSlotReleased` 事件。
  - 释放者是自己这一代 Runtime（`holder_boot_id == 本 boot`）时按 owner 的话释放；
  - 其他代持有者先做归属核验：**可证明仍存活**（pid 存活且 start token 相同）→ 拒绝，稳定码 `SLOT_HOLDER_STILL_RUNNING`（不杀进程、不释放）；可证明已死或无法核验 → 允许显式释放，并把观测值写进历史（人类显式决定可以释放 reconcile 不敢释放的槽位，区别只体现在审计里）。
- **绝不因为心跳过期、用户等待时长或 UI/客户端消失自动释放**（scheduler.md §1 明文要求）。本格也没有实现任何心跳。
- 重复释放是诚实 no-op（`ALREADY_RELEASED`，exit 0），不产生第二次状态变更；同一个 `commandId` 的重放走 `command_receipts`，返回同一条结果。

### D05：启动 reconcile 先核对真实写入者，再决定

`reconcileSlotReservations` 对每条活跃预留只问一个问题：**记录到的持有者进程还是不是当初那个进程？** 观测（`inspectSlotHolder`）的结论是封闭枚举，判定只依赖 pid + start token：

| 观测 | 含义 | 决定 |
|---|---|---|
| `HOLDER_STOPPED` | 记录的 pid 不存在（或已是僵尸） | **释放**，`release_kind = RECONCILED_HOLDER_EXITED` |
| `HOLDER_PROCESS_ID_REUSED` | pid 存活但 start token 不同 | **释放**，`release_kind = RECONCILED_PROCESS_ID_REUSED` |
| `HOLDER_STILL_RUNNING` | pid 存活且 token 相同 | **保持占用**（不动状态；本代没有句柄，也不发信号） |
| `HOLDER_OWNERSHIP_UNVERIFIABLE` | 无法比较（任一侧 token 缺失 / 进程表读不到） | `RESERVED` → **`RECOVERY_REQUIRED`**（保持占用，**不自动放行**） |
| `PROCESS_IDENTITY_MISSING` | 根本没记录进程身份 | 同上 → `RECOVERY_REQUIRED` |

- 本代 Runtime 自己创建的预留**跳过**（`SKIPPED_HELD_BY_RUNTIME`）：显式 `reconcile` 在运行期也会被调用，不能把自己正在用的槽位收敛掉。
- `execution_slot_reservation_events` 是 **append-only** 历史：获取、释放、以及**每一次 reconcile 观测**（包括「决定保持占用」这种没有状态变化的情形）都追加，从不改写。`UNIQUE(reservation_id, command_id)` + command 回执让「同一代里重复 reconcile」不产生第二条副作用（幂等）。
- reconcile **不发信号、不杀进程、不删资源、不声称静止**（ADR-0021/0028 的同一纪律）。释放只是「记录为已释放」+ 事件，失败现场原样保留。
- 启动序列：在 `apps/runtime/src/main.ts` 既有 reconcile 序列**之后追加**这一步，理由写在代码注释里——槽位必须按其他 reconcile 收敛后的最终图景判定（例如某个 Execution 刚被收敛成 `RECOVERY_REQUIRED`，它的槽位仍然被占），且既有顺序（D1 的 revision delivery reconcile 在前）一行未动。

### D06：容量等待有自己的稳定码，`BLOCKED` 不扩容

> ADR-0061 增加 `SCHEDULER_GLOBALLY_PAUSED`（仍是 exit 3 的等待，不是 `BLOCKED`）；`CAPACITY_GLOBAL_LIMIT_REACHED` 保留名字但改指整个 Runtime，`CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` 新实现不再产生。

- `BLOCKED` 继续只表示依赖未满足（不变量 10）。没有槽位是 `CAPACITY_WAIT` + `{ code, adapterId, limit, used, blocking[] }`。
- 容量事实可查询：`scheduler capacity get` 返回全局与每 adapter 的上限、来源、占用、可预留数、此时此刻新获取会拿到的 reason code、Runtime 的 draining 事实，以及当前占用者（含 `since`，供上层显示等待时长）。
- 本格**不做**：候选排序、自动 tick、抢占、aging、`--allow-unknown`、`task schedule *`（Wave F）。提优先级仍然只影响后续排序，不影响任何已持有的预留（有测试固定这一点）。
- Runtime 的 draining 是**内存事实**：只在开始 shutdown 时置位。持久化的 draining 会在崩溃后残留并永久拒绝新预留，因此不做。也没有新增操作者 drain 开关（那会是本格之外的新产品语义）。

### D07：命令面与退出码（CLI 完备、零确认）

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

- `acquire` 退出码：**0** = 拿到槽位；**3** = 容量等待或 Runtime 正在排水（读数在 `--json` 的 `wait.code`；stderr 也打印一行人类可读原因）；**1** = 拒绝（依赖未满足、revision/版本过期、已有预留、未知 adapter、非法上限……）。所有拒绝都带稳定 code。
- `capacity set/clear`、`release`、`reconcile`、`prepare-workspace` 失败 exit 1，成功 exit 0；`--json` 输出即为机器可读结果，stdout 只有 JSON（人类信息一律在 stderr）。
- 全部命令**零新增确认**（FULL 语义，ADR-0011）。
- `prepare-workspace` 把「预留 → worktree」这一步接上：只有**本代创建**的 `RESERVED` 预留才能准备（`SLOT_HELD_BY_ANOTHER_RUNTIME` 拒绝），准备出的 workspace 绑定到该预留；同一 `commandId` 重放不产生第二个 worktree。

## Consequences

- Wave F 的调度引擎可以直接调用：查事实（`inspectProjectCapacity` / `countActiveSlotOccupants`）、预留（`SlotReservationService.acquire`）、释放、以及在崩溃后读取 reconcile 结果。引擎不需要自己实现容量算术或唯一性。
- 容量是**配置**而不是测量：把上限设得比实际能跑的高不会报错，只会让主机承载更多并发——这是用户决策 1 的明确取舍。
- 预留是**数据库事实，不是 OS 强隔离**：外部进程不受 SQLite 事务控制。因此本格只保证 (a) 归属证据被记录、(b) 启动前/恢复时的核对路径存在、(c) 不核验就不放行。**不声明预留等于安全**。
- 「一次 Execution 一个主 Agent」的既有约束不变：预留不启动任何东西，启动仍是既有 `task.run`/`startAgentOperation` 的职责。
- 容量会计把 `resource_held` 执行也算作占用，因此今天（没有引擎时）两个手工 `task.run` 的任务也会占满默认容量事实——这是有意的诚实计数，而不是缺陷。
- 若以后要给 adapter slot 接入真正独立的 provider 级并发上限（例如每个 provider 进程有自己的内存预算），只需扩展 `project_adapter_slot_limits` 的语义，不影响预留原语。
- 现有 schema 20→21 的 additive 迁移：只追加 `if (version < 21)`，**v20 留给并行的 impact snapshot 格（E1）**，v16 永久未使用（绝不插入 `if (version < 16)`）。已知共享槽位后果：单独合并本格会让「已经被标成 21 的库」跳过后来出现的 v20 步骤；跨格合并时必须在 v20 之后合入本格（Wave E 的既定顺序 E0 → E1 → E2）。

## Verification

- `packages/storage/test/slot-capacity.test.ts`（17 项）：默认 2 / 显式设置读回 / adapter 覆写与清除；非法上限与未知 adapter 的稳定码且不写入；`SchedulerCapacityChanged` 事件；每 Task 唯一（含同 commandId 重放只有一份）；容量 2 时第三个 Task 得到 `CAPACITY_GLOBAL_LIMIT_REACHED` 且不写入；adapter 维度独立；版本/revision CAS；依赖指纹不匹配拒绝；draining 在事务内拒绝；`resource_held` 执行计入占用；释放可审计且可再预留；reconcile 观测（保持占用 / 标 `RECOVERY_REQUIRED`）与幂等；一个 workspace 不能被两个活跃预留绑定。
- `packages/storage/test/slot-capacity-migration.test.ts`（4 项）：真实 SQLite 文件上 **v20 → v21** 与 **v16 → v21** 的 additive 升级（旧行与旧表都还在、新表可用、`getProjectCapacity` 返回默认值）、已标 21 的库重开不再跑迁移、以及「`RELEASED` 不带释放记录」被 schema 拒绝。
- `apps/runtime/test/slot-reservation-service.test.ts`（18 项）：容量读回影响判定；adapter 覆写/清除；非法值与未知 adapter；容量等待以 reason code 表达（并断言不是 `BLOCKED`）；归属证据与 `assessedDevCommit` 被记录；过期版本 / revision 拒绝且不预留；依赖未满足 → `DEPENDENCIES_UNMET`；draining；提优先级不打断已持有预留；释放后重新预留；显式释放拒绝「可证明仍存活」的持有者；已死/无法核验的 reconcile 决定；本代自己的预留不被自己 reconcile；预留绑定 workspace 与重放幂等；另一代不能准备本代的 workspace；**真实进程**上的 `inspectSlotHolder`（存活 / token 不符 / token 缺失 / 不可读 / 已退出）。
- `apps/runtime/test/cli-capacity-slots.test.ts`（6 项，真实 CLI + 真实 Runtime + 临时 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider）：`capacity set` → `get` 读回、非法值/未知 adapter 的 exit 1 与稳定码；容量 2 时两个不相交 Task 同时预留成功、第三个 exit 3 + `CAPACITY_GLOBAL_LIMIT_REACHED` + 阻塞槽位与持有者观测、重复预留 exit 1；**两个并发 CLI 进程**（不同 Task 都成功；同一 Task 只有一个成功）；workspace 准备与绑定；**SIGKILL 崩溃后新 boot 的启动 reconcile 把已证明死亡的持有者记为 `RELEASED`（`RECONCILED_HOLDER_EXITED`，`signalsSent: 0`）**；以及**「无法核验 → 不放行」**：记录到活着的 pid 但没有 start token 的残余预留被标 `RECOVERY_REQUIRED`，继续占容量、外进程未被发信号、显式 reconcile 也不放行（详见 `docs/tasks/README.md` FOUNDATION-054 的真实证据段落）。
- 迁移结论：**v20 → v21** 与 **v16 → v21** 都只增加 4 张新表（`project_capacity_limits`、`project_adapter_slot_limits`、`execution_slot_reservations`、`execution_slot_reservation_events`），既有表/行/索引不变，`PRAGMA user_version` 到 21；本格的迁移语句只有 `if (version < 21)` 一步，没有插入任何更早的版本号。
- 本格**未验证**（不得当成已成立）：真实多任务并发执行（需要 Wave F 的调度引擎）、真实 adapter 进程并发与 provider 级槽位观测、非 Git 共享资源（端口/数据库/dev server）、impact snapshot 的快照代重检（需要 E1）、以及任何「预留即安全」的推断。

## 关联文档

- `PROJECT_SPEC.md` §1.1（效率至上 / CLI 完备 / 无电脑控制权）、§2 不变量 5/7/10。
- `docs/architecture/scheduler.md` §1（活跃集合）、§2（容量判定的位置）、§3（两类锁）、§4（恢复）、§5（验收矩阵）。
- ADR-0011（FULL 零确认）、ADR-0021（资源回收与失败现场）、ADR-0023（pid + start token 归属核验）、ADR-0025（Runtime 单实例与生命周期）、ADR-0028（重启后按事实收敛）。
- ADR-0030（Wave E 决策：全局上限 2 / 每 adapter 上限 / 不加 aging / 非 Git 资源不做）、ADR-0031（E1 的影响快照）。
