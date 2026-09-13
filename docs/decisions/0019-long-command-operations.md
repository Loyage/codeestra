# ADR-0019：长命令成为持久 Operation（进度、取消与重启 reconcile）

Status：Accepted（用户明确选择：1 保持同步默认 + 新增 `--background`；2 复用现有枚举表示取消终态，不改状态机；3 进度用查询命令 + 轮询暴露，不新增领域事件；4 UI 同时做进度列表与取消按钮）

## Context

`docs/tasks/README.md` 的 NEXT 第 2 项是「长命令后台化与进度事件：让 `task.run`/`task.verify` 成为持久 Operation，界面可展示进度并允许取消」。进入本轮前的实际状态：

- `task.verify` 是**同步命令**：Runtime 在同一个 socket 请求里完成建副本、逐条跑策略命令（本仓库约 30–46s）、写证据，期间没有可读进度；客户端断连（Ctrl-C）不会停止 Runtime 里已经在跑的命令组，用户既看不到进度也没有取消入口。
- `task.run` 在 Agent Session 启动后即返回，Agent 的执行是后台的，但除了 `session.transcript`（只读 provider 文件）与 `task.status` 之外，没有一条「这次运行走到哪一步」的持久记录；Runtime 重启后也没有与本次 run 绑定的恢复判定。
- 既有 Operation 表（`operations`）只记录 `PLANNED/IN_PROGRESS/SUCCEEDED/FAILED/RECONCILE_REQUIRED` 与 `request_json`/`result_json`，**没有步骤级进度**，因此「可观察进度」在数据层没有落点。
- 取消已经有正确性基线：`task cancel`/`task pause`（ADR-0016）是协作停止，Adapter 无法确认 provider 退出时 Task 进 `RECOVERY_REQUIRED` 并保留占用；`VerificationRunner.close()` 只按进程组停止自有验证命令。但这些能力在验证命令上**没有命令面入口**（只能在 Runtime 关闭时被动停止）。

约束（优先级最高，ADR-0008/0011）：

- FULL 默认零确认：本轮不得新增任何确认、审批或沙箱；常态路径步数与等待不得增加。
- CLI 完备：每个能力必须能只靠 CLI 完成并可脚本化（`--json`、稳定退出码）；UI 只是同一命令面的便利前端。
- 正确性核对（静止证据、幂等、崩溃恢复）继续有效，但不得包装成审批。

## Options

1. CLI 默认行为：(a) 保持同步默认 + 新增 `--background`／(b) 默认后台返回 handle + 新增 `--wait`／(c) 默认后台、不提供同步等待。
2. 取消终态：(a) 复用现有枚举（verification run `ERROR/CANCELLED_BY_USER`，Operation `FAILED` + `cancelled:true`）／(b) v11 扩展枚举新增 `CANCELLED`（需重建表并同步状态机文档）。
3. 进度通道：(a) 查询命令 + 轮询／(b) 新增 `OperationProgressed` 领域事件走既有 SSE。
4. UI 范围：(a) 进度列表 + 取消按钮／(b) 只读进度／(c) 只接 types 不改渲染。

用户选择：1(a)、2(a)、3(a)、4(a)。

## Decision

### D01：进度是事实，不是预估

- schema v11 `operation_progress(operation_id, sequence, step_key, step, state, detail_json, recorded_at)`，`PRIMARY KEY(operation_id,sequence)`、`UNIQUE(operation_id,step_key)`。**v11 已被本 ADR 占用，未释放**。并发 lane 的 ADR-0021（资源回收）保留了 v12，因此合并后 `phase1SchemaVersion = 12`，两条 `version < 11` / `version < 12` 步骤按升序同时保留（A3 的实现已在注释里预留了这一点）。
- 只在 Runtime **实际到达**的边界写步骤：`RUN_REQUESTED`、`WORKSPACE_PREPARED`、`EXECUTION_RESERVED`、`AGENT_SESSION_STARTED`、`AGENT_SETTLED`、`VERIFICATION_QUEUED`、`VERIFICATION_COPY_CREATED`、`COMMAND:<id>:STARTED`、`COMMAND:<id>:FINISHED`、`CANCEL_REQUESTED`、`CANCEL_UNCONFIRMED`。
- **不写百分比、不写预计剩余时间**：这些不是 Runtime 能知道的事实。`updated_at` 随最后一步推进，读侧可用它区分「还在动」与「卡住」。
- 第一个步骤写入时 Operation 从 `PLANNED` 进入 `IN_PROGRESS`；`step_key` 唯一使重放同一命令**不会重复追加同一步骤**（与既有 `command_receipts` 幂等同一思路）。

### D02：命令面（CLI 完备）

- `task.verify <project-id> <task-id> [execution-id] [--background]`。默认仍同步并返回既有验证报告（既有脚本与退出码语义不变：`state !== PASSED` 退出 1）；`--background` 立即返回持久 Operation handle，**退出码 0 表示「已受理」，不表示验证通过**，结论必须从进度查询读取。
- `task.operation.list <project-id> <task-id> [--json]`、`task.operation.get <project-id> <operation-id> [--json]`：人类可读默认逐条打印步骤，`--json` 原样输出 Runtime 投影。
- `task.operation.cancel <project-id> <task-id> <operation-id> [--json]`：确认静止后落终态；`stop === 'UNCERTAIN'` 退出码 1。
- `task.status` 增加 `operations` 投影，因此 UI 与 CLI 看到的是同一份数据（不存在「只有 UI 能看到进度」）。
- `task.run` 不新增 flag：它本来就返回于 Session 启动之后，本轮为它补上持久 Operation 与步骤记录；重启 reconcile 与取消复用既有 Task 控制命令（见 D04）。

### D03：`task.run` 的 Operation 生命周期与重启 reconcile

- `RUN_TASK` Operation 在**任何 Git/provider 副作用之前**创建（`aggregate_id = taskId`，`idempotency_key = run commandId`），因此一次 `task.run` 的整条链（provider 版本探测 → workspace → Execution → Agent start → observation）都有同一条可查记录；重放同一 commandId 命中同一条 Operation，不产生第二条。provider 版本探测在 Operation 创建之后，因此探测失败也是一个 `FAILED` 的 run 记录（`RUN_REQUESTED` + `RUN_FAILED`），而不是静默拒绝；它不产生 workspace/Execution。
- 结束条件由**已记录事实**决定，而不是「流结束了」：
  - Session `EXITED` 且 Execution `FAILED` → `FAILED/AGENT_FAILED`；Execution `CANCELLED/SUPERSEDED` → `FAILED/STOPPED_BY_USER`；
  - Session `EXITED` 且 Execution 仍活动（正常 settle，成果尚未捕获）→ `SUCCEEDED/AGENT_SETTLED`（**不**声称成果已捕获或已验证）；
  - Session `DISCONNECTED/RECOVERY_REQUIRED`，或观察流在没有终态投影的情况下结束 → `RECONCILE_REQUIRED`，占用全部保留。
- 启动 reconcile（`reconcileInterruptedRunOperations`）：Execution 仍活动或无法确认 → `RECONCILE_REQUIRED` 并保留占用；Execution 已终态 → 按该终态收口；**还没有记录 Execution** → `FAILED/RUNTIME_RESTARTED`，不复用这条记录重放任何 Git 副作用（workspace 副作用归既有的 workspace reconcile）。

### D04：取消的语义与静止确认

- **验证类 Operation**：先写 `CANCEL_REQUESTED`（durable marker）→ 停止该验证自己的进程组 → **只有确认退出后**才写 `completeVerificationRun(ERROR, CANCELLED_BY_USER)`；被取消的运行的副本**保留**（不删除可能仍有 writer 的现场），运行循环在步骤边界观察到 marker 后**不写任何判定**，避免把「被杀掉」伪装成「命令失败」。无法确认退出时：Operation 记 `RECONCILE_REQUIRED/CANCEL_UNCONFIRMED`，verification run 保持 `RUNNING` 且占用保留，命令面返回 `stop: 'UNCERTAIN'`（退出码 1）。
- **Agent 运行类 Operation**：委托既有协作暂停路径（`task pause` 同一条路径）：确认 provider 进程退出 → Task `PAUSED`（**可 `task resume` 继续**），Operation 记 `FAILED/STOPPED_BY_USER`。取消一个 Operation **不销毁 Task**；唯一终态停止仍是 `task cancel`。无法确认退出时沿用既有 `RECOVERY_REQUIRED` + 保留占用。
- 不新增确认：`task.operation.cancel` 与既有 `task cancel/pause` 一样，是用户显式动作，不引入二次确认。

### D05：取消的终态表达（不改状态机）

- 复用现有枚举：verification run 以 `ERROR` + `outcomeCode = CANCELLED_BY_USER` 表达取消，`evidence_json` 记录 `cancelledBy`/`cancelledAt`/`stoppedProcessGroup`/`previousState`；Operation 以 `FAILED` + `result.cancelled` 表达。
- 明确**不做**的事：不为 `verification_runs`/`operations` 增加 `CANCELLED` 状态。那属于状态机规格变更（需要重建表并同步 `docs/architecture/state-machines.md`），本轮按用户选择保留给后续独立决策；`ERROR/CANCELLED_BY_USER` 与「命令失败」在 `outcome_code` 上可区分，不静默混同。

### D06：UI（同一命令面）

- 任务详情新增「长命令进度」区块：每个 Operation 的类型、状态、最新步骤、更新时间与全部步骤（`stepKey`/时间/detail），非终态时提供「取消」按钮。
- 「验证任务」按钮改用 `background: true`（长命令不再阻塞页面），并轮询 `task.status`（1.5s，仅当存在非终态 Operation 时）显示进度，与既有 transcript 轮询同一模式。
- UI 不新增业务语义、不绕过门禁；取消按钮走的就是 `task.operation.cancel`。

### D07：效率成本（门禁评估）

- 新增确认/审批/沙箱：**0**。FULL 常态路径步数与等待不变。
- 后台验证把用户的等待从「必须等 30–46s 的同步请求」变为 0（拿 handle 即返回），是可感知的效率提升。
- 额外的正确性代价：验证类 Operation 多一次 `stopOwned`（进程组 SIGTERM→SIGKILL，最多 2s+2s 宽限）才落终态；这是「不谎称已静止」的必要等待，只发生在用户主动取消时。

## Consequences

- 已实现：v11 `operation_progress`；`beginRunOperation`/`recordOperationProgress`/`completeOperation`/`listTaskOperations`/`findActiveRunOperation`/`listIncompleteRunOperations`/`getVerificationRunPlan`（storage 追加方法）；`operation-service.ts`（run Operation 生命周期、后台验证作业、取消编排、`reconcileRunOperations`）；`verification-service.ts` 拆分为 `queueTaskVerification` + `executeQueuedVerification`（`runTaskVerification` 组合两者，行为不变）；`VerificationRunner.stopOwned`；`agent-runtime-service.ts` 记录 run 步骤并在观察流结束后按事实收口；`recovery-service.ts` 的 `reconcileInterruptedRunOperations`；CLI `task.verify --background` 与 `task operation list|get|cancel`；UI 进度区块 + 取消按钮；`task.status.operations`。
- 未实现（不得声称）：verification run 的独立 `CANCELLED` 状态；被取消验证副本的 `prune`/回收；token 级实时事件流（进度仍是步骤粒度）；`task.run` 的「后台排队后立刻返回」（现状已在 Session 启动后返回）；多任务批级的进度视图。
- 已知取舍：被取消的验证副本会留在 `<CODEESTRA_HOME>/verifications/...` 供人工检查（与既有失败现场保留策略一致，尚无 prune）；`task.operation.cancel` 对 Agent 运行是「暂停」而非终止，用户若想终止 Task 必须显式 `task cancel`。

## Verification

- `bun run check`（FOUNDATION-037 分层）退出码 0：根与 UI `tsc --noEmit`、**212 项 Vitest**、**Bun tests 278 项**（其中 `test:unit` 165 + `test:e2e` 113）、UI Vite 构建。
- `apps/runtime/test/operation-service.test.ts`（12 项，临时仓库 + 内存/临时 SQLite）：v10→v11 迁移与 `step_key` 唯一；run Operation 步骤序列与「按 Session/Execution 事实收口」；provider 版本探测失败也留下 `FAILED` 的 run 记录且不产生 workspace/Execution；同一 run commandId 重放只留一条 Operation 且无重复步骤；Execution 仍活动时重启 → `RECONCILE_REQUIRED` 且保留占用；未记录 Execution 的 run → `FAILED/RUNTIME_RESTARTED`；后台验证逐命令步骤 + `PASSED`；确认静止的取消 → `ERROR/CANCELLED_BY_USER` + Operation `FAILED` + 副本保留；无法确认的取消 → `RECONCILE_REQUIRED` + run 保持 `RUNNING`；取消 Agent 运行 → 协作暂停 Task 且不被观察流覆盖；同一 verify commandId 重放只跑一次。
- `apps/runtime/test/cli-task-run-progress.test.ts`（2 项，真实 CLI 子进程 + 真实 Runtime + 独立 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider）：`task.run` 的步骤经 CLI 可读、`--json` 可解析、`task.status.operations` 同一投影、终态取消返回 `ALREADY_TERMINAL`（不杀 Task）、未知 flag 退出码 2；`task verify --background` 返回 handle（退出码 0 = 已受理）、慢命令出现 `COMMAND:slow:STARTED`、`task operation cancel` 退出码 0 且 `dev` 未改、Task 仍 `EXECUTED`、验证记 `ERROR/CANCELLED_BY_USER`。
- 测试只使用临时 Git 仓库与独立 `CODEESTRA_HOME`；未触碰用户仓库、未 push、未提升 `main`、未重启稳定 Runtime；未使用桌面/浏览器自动化。UI 的视觉、焦点与窄屏仍需用户人工确认，`bun run check` 通过不等于 UI 验收。

## 关联文档

- `PROJECT_SPEC.md` §1.1（第一原则）、§2.24（暂停/终止/归档）、§6
- ADR-0008（效率至上 / CLI 完备 / 测试边界）、ADR-0011（默认 FULL）、ADR-0013（只读执行过程视图）、ADR-0016（Task 暂停/终止/归档）
- `docs/architecture/event-model.md` §3（外部操作用 Operation 记录）、`docs/architecture/state-machines.md` §2（Execution 静止确认）
- `docs/tasks/README.md` NEXT 第 2 项
