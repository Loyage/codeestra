# 状态机：Runtime 生命周期、全局负载控制与 Self Evolution

> 层级：L2 按需参考 · 体量 ≈ 5k 字符 · **何时读**：改 Runtime 单实例/停止序列、全局容量与全局暂停屏障、或 Self Evolution 的候选/提升流程 · 权威来源：`apps/runtime/src/lifecycle.ts`、`runtime-control-service.ts`、`capacity-service.ts`。全局控制的调度侧语义见 [`scheduler.md`](./scheduler.md) §8。
>
> 章节号 §4、§5、§6、§6.1 沿用拆分前的编号（代码注释与 ADR 仍按旧号引用）。§4 记录的是 **v36 已从产品中删除**的能力，只用于解释历史行。

## 4. IntegrationBatch / StableBranchPromotion（已删除，ADR-0066）

这一整段曾描述「Task 成果进入 `dev`」与「`dev` 提升 `main`」两层状态机。**ADR-0066 把它从产品中删除**：命令（`task integrate`、`task integration *`、`promotion *`、`promotion full-suite run`）、服务（`integration-service`、`promotion-service`、`promotion-evidence-service`）、领域表（`integration_batches(_items)`、`integration_verification_runs`、`stable_promotions(_members)`、`dev_full_suite_evidence`）与对应状态全部不再存在（schema **v36**）。当时的分状态列表、`VERIFYING` 差异与提升的 `phase` 投影都是历史记录，需要时查 [ADR-0018](../decisions/0018-task-result-integration-into-dev.md)、[ADR-0022](../decisions/0022-stable-branch-promotion.md)、[ADR-0052](../decisions/0052-promotion-fact-layering.md)、[ADR-0053](../decisions/0053-multi-member-integration-batch.md) 与 `git log docs/architecture/state-machines.md`。

它留下的三个后果写在别处：

1. **成果停在 `refs/heads/task/<task-id>`**（ADR-0005）。是否合并由用户决定，产品不合并、不推送、不记账。
2. **依赖释放**改由「上游 revision 自己的 result commit 是否对项目当前 Task 基线 ref 可达」判定，原因码是有界枚举 `UPSTREAM_RESULT_MISSING` / `BASE_REF_MISSING` / `BASE_REF_UNREADABLE` / `NOT_REACHABLE_FROM_BASE`（见 [`state-machines.md`](./state-machines.md) §1 的 `BLOCKED → READY` 行）。
3. **`BLOCKED → READY` 的触发者**改为 scheduling pass：`schedule-service.#reconcileBlockedTasks` 在挑选候选前对每个 `BLOCKED` 任务调用 `reconcileTaskDependencyState`。`task.depends.list` / `task schedule status` 只读，因此下游状态最多滞后一个 tick。

本仓库自身仍以 `main`/`dev` 两个 clone 开发并人工提升，但那是仓库约定（`AGENTS.md` 的人工四步、[`../agents/runbook.md`](../agents/runbook.md)），产品不提供命令、不记账、不校验它。

## 5. Self Evolution

Candidate：`REQUESTED → DEVELOPING → BUILDING → SELF_TESTING → PROMOTABLE`，开发/构建/测试失败→FAILED，来源/兼容信息变化→STALE。用户取消且资源确认静止→CANCELLED。

Promotion（独立对象）：`REQUESTED → DRAINING → CHECKING → SWITCHING → HEALTH_CHECKING → SUCCEEDED`。

- REQUESTED：用户明确批准固定 artifact hash 与旧 Stable version。
- DRAINING：禁止新执行，等待全部活动任务结束；WAITING_FOR_USER 不豁免。
- CHECKING：再次核对候选、兼容性和备份要求；未定义迁移策略则不得继续。
- SWITCHING：bootstrap 执行可恢复版本指针切换，不覆盖旧版本产物。
- HEALTH_CHECKING：新版本健康通过才 SUCCEEDED；失败→ROLLING_BACK→ROLLED_BACK。
- 无法安全恢复数据或无法启动旧版→RECOVERY_REQUIRED，不声称回滚成功。

Bootstrap 自身更新和不可逆 migration 不属于普通 Promotion 的隐式权限。其策略为 Phase 7 阻塞决策。

## 6. Runtime 生命周期与所有权（ADR-0025）

Runtime 是每个 `CODEESTRA_HOME` 的单实例，归属是**持久事实**而不是内存约定：

- `<home>/runtime.lock` 记录 `{bootId, pid, startToken, startedAt, argv, cwd}`，用「先写临时文件、再 `linkSync`」原子创建。读者只会看到「没有锁」或「完整记录」，不存在「读到半条记录 → 误判 owner 已死 → 删掉活人的锁」的窗口。
- 身份不靠 pid：`startToken`（`/proc` 或 `ps -o lstart=`）区分「同一个进程」与「pid 被复用」；zombie 不算活着。取锁发生在打开 SQLite 之前，因此两个进程同时迁移一个数据库从根上不可能。
- 每次启动写一条 `<home>/runtime-boots/<bootId>.json`；只有干净退出才删自己的锁与记录。别人的锁/记录是证据，本进程永不删除；不可解析的锁文件被重命名为 `runtime.lock.corrupt` 保留。
- 启动取不到锁时：owner 存活 `exit 3`，争用 `exit 4`；旧版本 Runtime 无锁文件但 endpoint 仍应答时，释放自己的锁并 `exit 0`。
- `runtime.stop` 只报告「被要求停止的进程是谁」（`{stopping, pid, bootId, startedAt}`），**不隐含已停止**。CLI `codeestra stop [--wait <seconds>]`（默认 10s）先只读读取归属记录，再请求、有界轮询、按事实报告：`STOPPED` / `NOT_EXITED`（exit 0/1）、`NOT_RUNNING`（exit 0，且**不启动** Runtime）、`UNREACHABLE_PROCESS`（exit 1，**不杀**进程）。
- shutdown 顺序完成后：只有 `coordinator.activeSessionIds()` 与 `verificationRunner.unconfirmedStops` **都为空**时才 `process.exit(0)`——即没有未确认停止的 provider 或验证进程；任一非空则不退出并保持可观察，让 `stop` 如实报 `NOT_EXITED`。

### 6.1 Runtime 全局负载控制（ADR-0061，**已实现**：FOUNDATION-097，schema v34 暂停半边）

实现：`apps/runtime/src/runtime-control-service.ts`，命令面 `scheduler control status|pause|resume|reconcile`，
持久事实 `runtime_pause_control` / `runtime_pause_targets`。容量半边（D01–D03）属并行的另一格，本节的 FSM 部分不依赖它。

这是一层**控制状态机**，不加入 Task / Execution / AgentSession 的枚举：

```text
RUNNING → PAUSING → PAUSED → RESUMING → RUNNING
             └──────────────→ RECOVERY_REQUIRED
```

| 迁移 | 条件与事实 |
|---|---|
| `RUNNING → PAUSING` | 在与 Session start 共用的控制互斥区内提交新 pause epoch 与目标清单；提交后立即阻止新 reservation/start/successor 与 Provider 投递 |
| `PAUSING → PAUSED` | epoch 内每个目标都按 pid + start token + incarnation 被观察为 Provider 主进程 stopped，或已证明在屏障前退出；“信号已发送”不够 |
| `PAUSING → RECOVERY_REQUIRED` | 任一目标身份不可核验、平台/Adapter 不支持、或无法证明 stopped；屏障与已冻结目标保留 |
| `PAUSED → RESUMING` | 用户显式 `scheduler control resume`；重启本身永不触发 |
| `RESUMING → RUNNING` | 同 epoch 的全部目标都已核验恢复或证明退出；随后才触发调度 pass 与待投递 answer/guidance |
| `RESUMING → RECOVERY_REQUIRED` | PID 复用、身份不可读、目标不是已记录的 stopped 主进程或恢复结果不可核验；不向该目标发信号，不启动新 Task |
| 任一非 `RUNNING` → 同态 | `status` / `reconcile` 只观察；同 commandId 重放不产生第二次状态变化 |

全局控制状态跨 Runtime 重启保留；启动先恢复屏障。Task/Execution/Session 维持冻结前状态，slot/workspace/writer lease 不释放。单 Task `task pause` 仍按 §1/§2 与 ADR-0016 执行协作停止并结束旧 Execution；不能用全局 `PAUSED` 冒充它。

**已实现的确定行为**（与上表对应）：

- 屏障提交（`RUNNING → PAUSING`）写 `runtime_pause_control` 与逐目标身份快照，并且与 Provider 启动路径共用
  `RuntimeControlMutex`；调度候选、`task resume` 门禁、`scheduler reservations acquire`（在同一个写事务内）、
  三种 Provider 启动（主启动 / scheduler 启动 / successor）与 answer/guidance 投递都读这一个事实。
- `STOPPED` 只从「复读：身份仍匹配 **且** 进程状态为 stopped」写出；`SIGSTOP` 只发向该主进程。
- 任一目标不可核验（身份读不出、`providerProcessSuspension` 不是 `SUPPORTED`、非 POSIX 平台、复读未证实停止）
  → `RECOVERY_REQUIRED`，已冻结的目标保持冻结；`PAUSED` 只在全部目标 STOPPED/已证明退出时写出。
- `resume` 只从 `PAUSED` 或可处置的 `RECOVERY_REQUIRED` 进入，只恢复同 epoch 中 `pid + start token + incarnation`
  完全一致且处于 stopped 的主进程；已退出不复活，PID 复用不发信号；`PAUSING`/`RESUMING` 中再次变更状态得到
  `GLOBAL_CONTROL_IN_PROGRESS`。
- 启动读取屏障在任何 tick / Adapter start / 投递之前；不自动 `SIGCONT`、不自动 kill。
