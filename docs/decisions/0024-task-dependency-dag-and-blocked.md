# ADR-0024：任务依赖、DAG 环校验与 BLOCKED 语义（Phase 2 第一小步）

Status：Accepted（本轮范围与三条核心语义由用户派单直接指定：上游必须先进入 `dev` 才满足依赖、DAG 变更必须检验环、`BLOCKED` 只表示依赖未满足。其余为实现层的局部选择。）

## Context

Phase 1 已把单任务流水线做完（Task create/submit/run、owned worktree、Execution、成果 commit、Task verification、IntegrationBatch 合入 `dev`），但「依赖」在代码里并不存在：

1. `tasks.state` 的 CHECK 里早就有 `'BLOCKED'`，`docs/architecture/state-machines.md` 也写明 `DRAFT | submit | 依赖未满足→BLOCKED`，但**没有任何代码计算它**；`BLOCKED` 目前是一个永远不会出现的状态。
2. **没有依赖表**，`TaskDependency` 只存在于 `docs/architecture/domain-model.md` 的设计里。
3. `docs/architecture/domain-model.md` 已规定满足条件：「指定上游 revision 有成功进入 `dev` 的 IntegrationBatch 记录，且结果 commit 在下游选定 dev 基线的祖先链中。dev 被外部重写导致不可达时重新阻塞。」ADR-0009 规定「仅 Task verification 成功不释放依赖」。
4. `docs/architecture/scheduler.md` 属于 Phase 2 设计；本轮**不实现**并行 worktree 调度、资源预留改造、Conflict Analyzer 或 `task.run` 的排队/并发。
5. `docs/architecture/domain-model.md` §3 要求「Graph 检测在写锁保护下完成，避免两条并发边分别合法但合起来成环」。

因此本 ADR 只关闭 Phase 2 的第一个小步：让依赖成为一等公民，并让 `BLOCKED` 有唯一、可计算的含义。Phase 4 之前允许下游继续 `BLOCKED`，不提前偷做完整集成。

## Options

1. 满足条件：(a) 仅看「上游有 INTEGRATED 的 IntegrationBatch 事实」；(b) 事实 + 结果 commit 仍可从当前 `dev` ref 到达；(c) 只按 Task verification PASSED。
2. 环校验位置：(a) 纯领域图函数在 storage 的写事务内调用；(b) runtime 先读图再调 storage 插入（两步）；(c) 只用 SQL 递归 CTE。
3. `BLOCKED` 迁移触发点：(a) 由 scheduler 在 submit / 依赖变更 / 上游合入后重算；(b) 在 `task.run` 时才算；(c) 后台周期性 tick。
4. 上游 revision 的绑定：(a) 加边时绑定上游当前 revision，且边不可改（要改先删再加）；(b) 每次判定时读上游最新 revision；(c) 允许原地改写 revision。
5. 上游被修订、`dev` 被重写等「已满足又不再满足」：(a) 重新阻塞并要求重新满足；(b) 保持已满足；(c) 报错停止。
6. 命令面形态：(a) `task depends add|remove|list`（`--json`、稳定退出码）；(b) 只做 `list`；(c) 依赖写在 `task create` 参数里。

## Decision

1(a) 的取舍为：**1(b)**、**2(a)**、**3(a)**、**4(a)**、**5(a)**、**6(a)**。

### D01：依赖满足的定义（沿用 ADR-0009，不新增语义）

边为 `dependent → prerequisite`，并在边上固定 `required_revision_id`。边满足当且仅当**同时**成立：

1. 存在 `integration_batch_items` 行满足 `task_id = prerequisite`、`revision_id = required_revision_id`、`state = 'INTEGRATED'`、`integrated_commit IS NOT NULL`，且其 `integration_batches.state = 'INTEGRATED'`；
2. 该 `integrated_commit` 仍然**等于或可从项目当前 `dev` ref 到达**（`git merge-base --is-ancestor`）。

Task verification `PASSED`、`EXECUTED`、`SUCCEEDED`（Task 自身状态）都不释放依赖；只有「进入 `dev`」这一事实释放。`dev` 被外部重写、上游提交不可达时，边立即重新变为未满足，下游重新 `BLOCKED`（D05）。

无法判定一律按未满足处理（fail-closed）：`dev` ref 缺失 → `DEV_BASELINE_MISSING`；Git 读取失败 → `DEV_REF_UNREADABLE`。未满足原因使用有界枚举：`UPSTREAM_NOT_INTEGRATED | DEV_BASELINE_MISSING | DEV_REF_UNREADABLE | NOT_REACHABLE_FROM_DEV`，不转述上游文本。

### D02：纯领域 DAG 与环校验策略

- `packages/domain/src/dependency-graph.ts`（新，纯函数、无 Bun/SQLite/Git/Adapter 依赖）提供：`createDependencyGraph`（构造与非法图拒绝：自环、重复边、空标识、越界 Task）、`detectCycle`、`wouldCreateCycle`、`assertAcyclic`、`topologicalOrder`、`transitivePrerequisites` / `transitiveDependents` / `dependencyImpact`。非法图与环抛出带结构化 `issue` 的 `DependencyGraphError`（`code='GUARD_REJECTED'`）。
- **环校验在 storage 的写事务内完成**：`addTaskDependency` 在同一个 `executeCommand` 事务中读取该项目全部边、用领域图判断候选边是否成环，成环则抛 `TaskDependencyError('DEPENDENCY_CYCLE')` 并**不写入任何行**。这样两条各自合法的并发边不可能一起落库成环。
- 边一旦建立**不可原地改写**：schema 触发器拒绝 `UPDATE`，重新钉版本必须 `remove` + `add`，审计里不会出现「含义悄悄变了」的依赖。
- 加边时默认钉上游**当前** revision，也允许显式 `--revision` 指定上游任一 revision；已存在但钉的版本不同的边被拒绝，而不是被静默改写。

### D03：`BLOCKED` 的唯一含义与迁移

`BLOCKED` **只**表示依赖未满足（`PROJECT_SPEC.md` §2.10）。冲突等待、容量等待、故障、用户等待都不得归入 `BLOCKED`。本轮只允许 `READY ↔ BLOCKED` 之间的迁移：

- `task.submit`：先记录 `DRAFT → READY`（规格有效），随后在同一命令里立即执行依赖判定；依赖未满足则 `READY → BLOCKED`。对外可观察结果是 FSM 规定的 `submit → BLOCKED`，不产生 Execution、不占用 worktree；审计保留两条真实事实。
- `task depends add/remove`：改图后在同一命令里重算该 Task 的依赖状态（`DRAFT` 等非 READY/BLOCKED 状态不变）。
- `task.integrate` 成功（`INTEGRATED`）后：对上游的**传递下游闭包**逐个重算，`BLOCKED → READY` 的下游在同一个响应里以 `dependencyReconcile.readied` 报出；单个下游重算失败只记录在该字段，不把已成功的合入报成失败。
- `task.run`：启动前先重算并拒绝 `BLOCKED`（`DEPENDENCIES_UNMET`），**在任何 workspace/Execution 预留之前**；因此依赖未满足时不会创建 Execution，也不会占用 worktree。若本次调用把 `BLOCKED` 推进为 `READY`，同一命令直接用新版本继续，不要求用户重试。
- `task.resume`：恢复同样是一条启动路径，先做只读依赖断言，未满足则拒绝，Task 保持 `PAUSED` 且不写任何东西。
- `RECOVERY_REQUIRED / RUNNING / PAUSING / PAUSED / WAITING_FOR_USER / CANCELLING / CANCELLED / SUCCEEDED` 期间依赖判定**不写状态**（只报告），由各自既有流程处理。
- `BLOCKED` 必须带至少一条具名原因，`READY` 必须不带原因：无理由的「阻塞」正是 §2.10 禁止的垃圾桶。状态未变化时不写事件、不动版本（幂等）。

### D04：持久化（schema v15，本轮占用）

`task_dependencies(dependent_task_id, prerequisite_task_id, project_id, required_revision_id, created_by, created_at)`：

- 主键 `(dependent_task_id, prerequisite_task_id)` 即 `UNIQUE`；`CHECK(dependent_task_id <> prerequisite_task_id)` 禁止自依赖；
- 外键 `(project_id, dependent_task_id)`、`(project_id, prerequisite_task_id)` → `tasks(project_id, id)`，`(prerequisite_task_id, required_revision_id)` → `task_revisions(task_id, id)`：两个端点必须同项目、钉的 revision 必须属于上游；
- `task_dependencies_no_update` 触发器使边只可增删；
- 索引 `(project_id, dependent_task_id)` 与 `(project_id, prerequisite_task_id)`。

`phase1SchemaVersion` 12 → 15，`migrate()` **只追加** `if (version < 15)`。**v13 保留给 B1 格、v14 保留给 B2 格**，本轮只占 v15。

### D05：幂等、重放与拒绝非法迁移

- `addTaskDependency` / `removeTaskDependency` / `applyTaskDependencyState` 全部经 `executeCommand`：重复 `commandId` 返回已记录结果，不产生第二行、不二次推进版本。
- 同一 commandId 之外的「同一对端点再次 add」报告 `added: false` 且**不推进版本**（图没有变化就不该有版本变化）。
- `remove` 找不到边返回 `NOT_FOUND`（不静默成功）；`add` 命中自依赖返回 `SELF_DEPENDENCY`，命中环返回 `DEPENDENCY_CYCLE`。
- 处于 `RUNNING / PAUSING / PAUSED / WAITING_FOR_USER / CANCELLING / CANCELLED / RECOVERY_REQUIRED / EXECUTED / SUCCEEDED` 的 Task 拒绝改图（`INVALID_STATE`）。`EXECUTED` 被有意排除：成果 commit 已经捕获，此后再加的依赖不可能影响它，而本步不实现「依赖变化使已捕获证据失效」（那属于尚未实现的 `EXECUTED | revision added | →READY | BLOCKED` 路径）。可编辑集合为 `DRAFT / BLOCKED / READY / FAILED`（`FAILED` 保持可编辑，因为重试可以重新规划）。
- 版本 CAS 在所有写路径上生效；陈旧调用者得到 `CONCURRENT_MODIFICATION`，不会在它没看到的 revision 上启动工作。

### D06：命令面（CLI 完备、零确认）

- `task.depends.add` / `task.depends.remove` / `task.depends.list` 三个请求（Zod 严格对象，union 末尾追加）。
- CLI：`task depends add <project-id> <task-id> <expected-version> <prerequisite-task-id> [--revision <id>] [--json]`、`task depends remove …`、`task depends list <project-id> [task-id] [--json]`。`list` 默认给人读的视图，`--json` 输出与 Runtime 投影完全一致；`add`/`remove` 直接输出命令结果（含同一投影）。
- 退出码：环、自依赖、未知端点、未知项目等拒绝一律 1；`add` 成功但任务因此变为 `BLOCKED` **不是**错误，退出码 0。
- 不新增任何确认/门禁/审批：FULL 零确认预算保持 0，STRICT 也不把依赖当作需要批准的操作（依赖是正确性判定，不是权限判定）。

## Consequences

- 常态新增审批成本：**0 步、0 等待**。
- 收益：依赖有一等公民身份（表 + 领域图 + 命令面 + 投影）；`BLOCKED` 第一次可被计算且只有一个含义；环在写入前被拒绝且现场干净；上游进 `dev` 会自动解除下游阻塞（无需后台循环）；`dev` 被重写会让下游重新阻塞而不是假装满足。
- 代价/限制（显式跟踪，不得谎报）：
  1. **不实现并行调度**：`scheduler.ts` 只做「依赖满足 → 安全推进到 `READY`」和「环校验」，不选任务、不预留资源、不启动多个 Agent、不做 Conflict Analyzer。`docs/architecture/scheduler.md` 的其余部分仍属后续 Phase 2 工作。
  2. **`task.submit` 记录两条迁移**（`DRAFT→READY`、`READY→BLOCKED`）而不是一步 `DRAFT→BLOCKED`。storage 的 `submitTask` 属共享热点，本轮只允许追加，故选在 runtime 同一命令内立即补齐依赖判定；对外状态与 FSM 一致。
  3. 依赖判定需要读 Git（当前 `dev` ref + ancestor 检查）。为控制成本，只在 submit / 依赖变更 / 合入 / run / resume / list 这些命令路径上判定，不做周期性 tick。
  4. **`task.resume` 的守卫在命令层**（先只读断言再调用 ADR-0016 的恢复流程），因此「断言通过」与「provider 进程真正启动」之间仍存在理论上的 `dev` 变化窗口；本轮不引入额外锁。
  5. 上游被修订时 `required_revision_id` **不自动跟随**（`docs/architecture/domain-model.md` 列为待用户确认的后续语义）。本轮的安全默认是继续钉旧 revision：上游新 revision 未进 `dev` 时下游保持 `BLOCKED`，不会静默跟随。自动改钉、边 `NEEDS_REVIEW` 与「选择版本后激活」仍未实现。
  6. 多成员 IntegrationBatch、批级 `STALE`、`dev → main` 提升与重启仍未实现（Phase 4 剩余范围）。
  7. **lane 版本号顺序**：本轮把 `phase1SchemaVersion` 直接设为 15 并只加 `if (version < 15)`。当 B1(v13)/B2(v14) 合入时，集成方必须**同时保留三段升序分支**并把常量取三者最大；单独合入本分支后创建的本地库会被标成 15，之后合并 B1/B2 时不会被这两段迁移覆盖（需要重建或人工处理）。这是三个 lane 共享单一版本常量的已知代价。
  8. 跨项目依赖不允许（依赖表带 `project_id`，两端点必须同项目）；`EXECUTED` 与 `SUCCEEDED` 任务不能改图（重新规划应是新 Task 或后续的 revision 路径）。
  9. **Task 运行期间 `dev` 被重写**导致该边转为未满足时，该 Task 已经捕获的成果仍可按 ADR-0018 的既有 IntegrationBatch 规则合入 `dev`：本轮不在 `task.integrate` 前重新核验依赖（那属于 Phase 4 与 revision 失效语义）。`task.run` 与 `task.resume` 的守卫只能阻断**启动**，不追溯已在进行的执行。

## Verification

- `bun run check` 退出码 0：根/UI typecheck、Vitest **231** 项、Bun 测试 **320** 项（`test:unit` 199 + `test:e2e` 121，分层之和与总数一致）、Vite 构建。
- `packages/domain/test/dependency-graph.test.ts`（Vitest，新增 19 项中的一部分）：构造与双向索引、空图、自环拒绝、重复边拒绝、空标识拒绝、越界 Task 拒绝、链/菱形非环、直接环、间接环、带无环前缀的环、`assertAcyclic`、候选边成环路径、候选边合法、自环候选、传递闭包（含菱形去重、不包含自身、环上终止、未知 Task 空闭包）、`dependencyImpact`。
- `packages/storage/test/task-dependencies.test.ts`（Bun，新增 10 项）：v12→v15 additive 迁移保留既有行且 `foreign_key_check` 无违规、v14 已盖章库→v15、自依赖与未知 Task 拒绝（含直接 INSERT 被 schema 拒绝）、加边钉版本 + 同 commandId 重放幂等 + 不同 commandId 同边 `added:false` 不推进版本 + 改钉拒绝、INTEGRATED 事实读取（非 INTEGRATED 批次不算事实）、环拒绝且不写入、运行/终结态拒绝改图、删除与不存在删除的 `NOT_FOUND`、`READY↔BLOCKED` 迁移（含无理由 BLOCKED 与带理由 READY 被拒、无变化不推进版本与不写事件、运行态不受判定影响）、边不可 UPDATE。
- `apps/runtime/test/scheduler.test.ts`（Bun，新增 6 项，真实临时 Git 仓库）：未合入 `dev` 时下游保持 `BLOCKED` 且不创建 workspace/Execution、`task.run` 守卫抛 `DEPENDENCIES_UNMET`、上游合入 `dev` 后下游同一命令转 `READY`、陈旧版本抛 `CONCURRENT_MODIFICATION`、`dev` 被重写（不可达）后重新 `BLOCKED/NOT_REACHABLE_FROM_DEV`、`dev` 前进后的严格祖先仍算满足、传递下游闭包在合入后逐个重算（已 `BLOCKED` 的下游记为 `unchanged`）、图投影（闭包/影响/原因码）与运行中 Task 不被判定改动、环拒绝后图与版本不变、`dev` ref 缺失按 `DEV_BASELINE_MISSING` 阻塞。
- `apps/runtime/test/cli-task-depends.test.ts`（Bun，新增 2 项，真实 CLI + 真实 Runtime + 协议 stub provider + 临时仓库）：加边/查边/自依赖与未知端点拒绝/重复加边 `added:false`/环拒绝退出码 1/项目级列表/下游闭包/删除与不存在删除的 `NOT_FOUND`/未知项目退出码 1；以及 `task depends add → task submit`（`BLOCKED`）→ `task run` 退出码 1 且无 Execution 与无 worktree → 上游 `run → result capture → verify → integrate` → 响应 `dependencyReconcile.readied` 含下游、`task depends list` 变为 `satisfied`、Task `READY` → 再 `remove` 后无边仍 `READY`；合入后 `dev` 等于成果 commit。
- `packages/contracts/test/request.test.ts`（新增 1 项）：`task.depends.add` 必带 `expectedVersion`、可选 `requiredRevisionId`、负版本拒绝；`task.depends.remove` 不接受钉版本字段；`task.depends.list` 支持单 Task 与项目级且拒绝多余字段。
- `packages/git`、`packages/agent-adapters`、`apps/ui`、`workspace-service.ts` 未改动。为让 `packages/storage` 与 `apps/runtime` 依赖纯领域图，在两处 `package.json` 增加 `@codeestra/domain: workspace:*`（bun.lock 同步 +2 行）。
- 既有测试仅做一处与 schema 版本相关的机械修正：`apps/runtime/test/cli-reclaim.test.ts` 把硬编码的 `12` 改为 `phase1SchemaVersion`（该断言本意是「升级到当前 schema」）。
- 未执行：真实 provider（非 stub）驱动的依赖解阻塞；上游被修订后自动改钉；多成员批次；并行调度与冲突分析；`dev → main` 提升。未使用桌面/浏览器/键鼠自动化。

## Related

- `PROJECT_SPEC.md` §1.1、§2.4/§2.5/§2.10、§6
- `AGENTS.md`（Task-first；Conflict UNKNOWN 不得直接并发；DAG 变更必须检验环）
- ADR-0009（开发依赖以「进入 dev」为满足）、ADR-0011（FULL 零确认）、ADR-0018（IntegrationBatch 与 dev 基线）
- `docs/architecture/domain-model.md`（TaskDependency、满足条件）、`docs/architecture/state-machines.md` §1、`docs/architecture/scheduler.md`
- `docs/roadmap/mvp.md` Phase 2
- `docs/tasks/README.md` FOUNDATION-044
