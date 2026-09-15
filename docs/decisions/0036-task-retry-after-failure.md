# ADR-0036：`FAILED → READY`——显式 `task retry` 与失败后换 Agent

Status：Accepted（本轮实现：FOUNDATION-061 / Wave H / H3，schema **v23**，FULL 零新增确认）

## Context

`docs/architecture/state-machines.md` §1 早就写了 `FAILED | user retry | 旧执行静止、依赖重验→READY 或 BLOCKED`，`docs/roadmap/mvp.md` Phase 5 的验收也写着「失败后新 Execution 可更换 Agent」。但 ADR-0029 如实记录了这个缺口：

> Runtime 目前没有 `FAILED → READY` 路径，因此「Execution 失败后换 Agent」只在「Execution 建立前就失败」或 `pause → resume` 路径上成立。

实测确认（本格基线上逐条核对）：

- `packages/storage/src/database.ts` 里把 Task 写成 `FAILED` 的路径有四条（Agent start 失败、Agent 上报失败、`RECOVERY_REQUIRED` 之外的失败投影、等等），**没有任何一条**把 `FAILED` 移出去；
- `resumeTask` 只接受 `PAUSED`；`applyTaskDependencyState` 只在 `READY`/`BLOCKED` 之间移动；`pauseOrCancelTask` 的 `CANCEL` 分支接受 `FAILED` 但只能走到终态 `CANCELLED`；
- 调度引擎（ADR-0033）的候选集合是 `state === 'READY'`，所以一个 `FAILED` 的 Task 对引擎完全不可见。

也就是说：一次真正跑失败的 Task，**没有任何命令**能把它重新排进调度；用户只能新建一个 Task，丢掉原 Task 的 revision、worktree、依赖边与全部审计关系。本 ADR 记录补上这条路径时必须做出的决定。

## Options

用户在实现前逐题选择了以下方向（A/B/C 由本格提出，用户答复）：

1. **谁建立新的 Execution（这决定 `--adapter` 怎么生效）**：
   - A. `task retry` 只把 Task 置回 `READY`，随后触发一次**带 `--adapter` 的整项目 tick**：最贴「由既有自动 tick 接管」的字面，但 `ScheduleService.tick()` 的 adapter 是**整项目一个**（`resolveAdapterId(options?.adapterId)`），于是这个 tick 会把它对**每一个** READY 候选生效——可能把别的任务也用这个 Agent 启动，而本格被禁止修改引擎内部。
   - **B.（选择）** `task retry` 把 Task 置回 `READY`/`BLOCKED`，随后只对**这一个** Task 发一次显式启动请求（`ScheduleService.runNow`，与 `task run` 完全同一条门禁、同一个 `#evaluateCandidate`）。`--adapter` 因此精确作用于被重试的任务；不能立刻启动时（冲突/容量）Task 留在 `READY` 排队，由周期 tick 用 Runtime 默认 adapter 启动。
   - C. 只置回 `READY`，不接受 `--adapter`。（否决：直接违反「失败后换 Agent」的验收）
2. **审计与「新 Execution ← 旧 Execution」的可追溯关系怎么存**：
   - **A.（选择）** 迁移 v23 只加两列：`executions.retry_from_execution_id`（关系落在行上）与 `tasks.pending_retry_from_execution_id`（重试意图，被 `reserveExecution` 消费一次）；「谁/何时/针对哪个失败/是否换 Agent/workspace 复用或重建」由 append-only 的 `TaskRetryRequested` 领域事件承载，复用既有 outbox 与 `events list/tail` 面。
   - B. 新建 append-only `task_retry_requests` 表。（否决：审计已有事件台账这一处权威落点；多一张表就要多一处一致性维护）
   - C. 不动 schema，只用事件。（否决：新 Execution 行本身读不到来源 Execution，「attempt N 跟随 attempt N-1 的失败」要从 payload 反推）
3. **worktree 已被 `reclaim` 时怎么办**（实测：`packages/git/src/reclaim.ts` 明确「The branch is never deleted」，所以回收后 `refs/heads/task/<taskId>` 仍在，而 `prepareWorkspace` 会以 `REF_CONFLICT` 拒绝在既有分支上创建 worktree）：
   - **A.（选择）** 拒绝并给稳定码（`WORKSPACE_RECLAIMED` / `WORKSPACE_OWNERSHIP_UNVERIFIABLE`），不声称「已重建」，并把该缺口如实报告。
   - B. 照「走既有 preparation 路径」实现，让它如实失败（记录一个已知会失败的意图）。
   - C. 在本格实现「复用既有 task branch 重建 worktree」（引入超出领地清单的 Git 逻辑，并与 H4 的 reclaim 领地相邻）。C 未被选择，缺口保留为后续决策。

## Decision

### D01：只有显式 `task retry` 能让失败的 Task 回到调度，且不做任何自动重试

- 新命令 `task retry <project-id> <task-id> <expected-version> [--adapter <pi|codex>] [--json]`，零新增确认（FULL 语义；`retry` 不是审批动作）。
- **不加**次数、退避、自动 loop，**不加** `--auto-retry`。失败不自动改变任务状态；只有用户显式执行重试才 requeue。
- 来源状态由纯领域判定给出（`packages/domain/src/task-retry.ts`），每个拒绝都有稳定码，且**拒绝不写任何行**：

| 来源状态 | 结果 | 稳定码 |
|---|---|---|
| `FAILED` | 允许 | —（requeue） |
| `CANCELLED` | 拒绝 | `TASK_CANCELLED`（终态不自动重开，不变量 24） |
| `RECOVERY_REQUIRED` | 拒绝 | `RECONCILE_REQUIRED`（需人工/审计 reconcile，重试不能证明旧 writer 已停） |
| `PAUSED` | 拒绝 | `TASK_PAUSED`（暂停的语义是续接同一 conversation，用 `task resume`） |
| `RUNNING`/`PAUSING`/`WAITING_FOR_USER`/`CANCELLING` | 拒绝 | `TASK_STILL_RUNNING` |
| `DRAFT`/`BLOCKED`/`READY`/`EXECUTED`/`SUCCEEDED` | 拒绝 | `TASK_NOT_FAILED` |
| 任意状态 + 已归档 | 拒绝 | `TASK_ARCHIVED` |

### D02：目标状态由依赖判定重新导出：`READY` 或 `BLOCKED`

命令在同一个事务里重新读取 Task 状态与版本（CAS），并在事务外先重跑 `inspectTaskDependencies`：依赖未满足 ⇒ 目标 `BLOCKED` 并带上 `blockedReasons`，否则目标 `READY`。这就是 `state-machines.md` §1 的「依赖重验→READY 或 BLOCKED」；`BLOCKED` 仍然只有一个含义（依赖未满足），容量与冲突等待都不写进 Task 状态。

### D03：新 Execution 由**同一条调度门禁**建立，不插队

- `retry` 命令本身**不**创建 Execution：它只 requeue，然后对**该 Task** 调一次 `runNow`（与 `task run` 同一条依赖→冲突→容量→预留→workspace→启动前基线重检→启动路径）。
- 因此重试的任务与任何任务一样排队：容量满 ⇒ `wait(CAPACITY)`（退出码 3）、冲突/UNKNOWN ⇒ `wait(CONFLICT)`（退出码 3）、依赖未满足 ⇒ `REFUSED/DEPENDENCIES_UNMET`（退出码 1）；`retry` **不**提供 `--allow-unknown`，需要放行时先 `task run --allow-unknown`（沿用 ADR-0030 D05，不新增语义）。
- 退出码语义：**0** = 新 Execution 已启动；**3** = 重试已记录、Task 已 requeue 并等待；**1** = 重试被拒绝，或已 requeue 但没有启动（例如落到 `BLOCKED`）。`--json` 里 `state`/`start.outcome` 把「requeue 成功」与「是否启动」分开报告。

### D04：`--adapter` 缺省沿用「该 Task 上一次跑的那个 Adapter」

`selectRetryAdapter`：显式 `--adapter` > 失败 Execution 记录的 `adapter_id` > Runtime 默认（`pi`）。换了 Agent 就是**新 Execution 绑定另一个 Adapter**（不变量 1；与 ADR-0029 记录的既有语义一致），不是在一个 conversation 里换 Agent。未知 adapter id 在任何写入前以 `UNKNOWN_ADAPTER` 拒绝。

**已知边界（如实记录，不掩盖）**：`--adapter` 只作用于本次显式启动请求。若这次请求只得到 `wait`，Task 留在 `READY` 排队，后续由周期 tick 启动时用的是 Runtime 默认 adapter（引擎的 adapter 是整项目一个，本格未改引擎）。`--json` 把 `adapterId`/`adapterSource` 与 `start.outcome` 同时给出，所以这个事实对脚本是可见的。

### D05：worktree 优先复用该 Task 自己的，且**必须核验归属**

- 复用不是「行里写着 RETAINED」就算数：命令读回该 Task 最近一条 workspace 记录，用 `reconcileWorkspace`（真实 Git worktree registry + 真实文件系统 + 分支/HEAD 事实）得到 `OWNED`/`MISSING`/`FOREIGN`/`UNCERTAIN`，再由纯领域函数决定：
  - `OWNED` + 行状态 `RETAINED`/`READY` ⇒ `REUSE_VERIFIED`：同一事务把 worktree 置回 `READY`，新 Execution 复用它（失败尝试留下的未提交工作因此不被丢弃）；
  - `MISSING`（目录与分支都不在了）⇒ `PREPARE_FRESH`：交给既有 workspace preparation 路径从零建立；审计里记 `workspaceMode: PREPARE_FRESH`；
  - 其余（`FOREIGN`/`UNCERTAIN`，或 `OWNED` 但行状态不是可复用的那两个）⇒ **拒绝**，稳定码 `WORKSPACE_OWNERSHIP_UNVERIFIABLE`；若行状态是 `RELEASED` 则报 `WORKSPACE_RECLAIMED`。
- 缺口（本 ADR 明确保留，未静默绕过）：`reclaim` 不删 task branch，因此**已被回收**的 Task worktree 无法由既有 preparation 路径重建（`REF_CONFLICT`）。本格选择拒绝并报告，而不是引入第二套 Git 逻辑或悄悄复用别人的目录。

### D06：旧 Execution 的一切实事都不改写

`retryTask` 只写 Task 的状态/版本、被复用 worktree 的状态、两条 append-only 事件（`TaskStateChanged` + `TaskRetryRequested`）与命令回执。旧 Execution 的 `state=FAILED`、`error_json`、`ended_at`、占位释放结论原样保留；**没有**任何「把失败洗成成功」的路径，也没有伪造 `RUNNING`/`RESULT`。

### D07：schema v23，两列、无新表

```sql
ALTER TABLE tasks ADD COLUMN pending_retry_from_execution_id TEXT REFERENCES executions(id);
ALTER TABLE executions ADD COLUMN retry_from_execution_id TEXT REFERENCES executions(id);
```

- `pending_retry_from_execution_id` 是**意图**：`reserveExecution` 在同一事务里把它拷到新 Execution 的 `retry_from_execution_id` 并置回 NULL，所以这个关系是**单次**的——恰好一个新 Execution 成为那次失败的 successor，后续尝试不会继承没关系。
- 它与 `resume_from_execution_id` 是**两个**不同的语义（resume = 续接同一 conversation；retry = 新建 Execution），因此不复用同一列。
- v22 属于 H2 的预留快照代重检，v16 永久未使用，所以本步只追加 `if (version < 23)`，绝不插入更早的号。

## Consequences

- 「失败的 Task 无法重来」不再是产品的死路：`task retry` 是 CLI 完备路径（§1.1 第 2 条），UI 只是同一命令面的投影（H1 领地，本格不动 `apps/ui/**`）。
- 重试**不会**绕过任何门禁，也不会让失败的任务插队；同时它**不会**自动发生，所以「为什么又跑了一遍」永远有一个人可指认。
- 换 Agent 变成可审计的事实（`adapterChanged` / `previousAdapterId`）而不是一句口头说明。
- 残余的已知边界：已被 reclaim 的 worktree 无法重试；`--adapter` 在「requeue 后由周期 tick 启动」的分支里不生效；协议 stub 不能证明真实 Pi/Codex 失败后的行为。
- 迁移 v23 使若干既有测试里硬编码的 `phase1SchemaVersion === 21` 断言失效（它们断言的是「本 lane 是最后一格」）；本格按集成惯例改为断言常量本身或 `>= 21`，并在每条处注明原因。

## Verification

只用 CLI/命令面与 Runtime 命令面（ADR-0008），不使用浏览器/桌面/键鼠自动化：

1. `packages/domain/test/task-retry.test.ts`（7 项，vitest，纯函数）：来源状态表与 `retryableTaskStates` 一致（只有 `FAILED`）、每个拒绝码、归档优先于状态、Adapter 选择的三级优先、workspace 决策矩阵（复用/从零/两种拒绝，且拒绝时不给出 mode）。
2. `packages/storage/test/task-retry.test.ts`（11 项，bun test，真实 SQLite）：requeue + worktree 交还 + 两条事件；新 Execution 通过 `retry_from_execution_id` 命名它跟随的失败且意图被消费一次（`ExecutionReserved` payload 同样带该字段）；同 command 重放幂等（一次状态变更、一条审计、版本只 +1）；七种非 `FAILED` 来源全部拒绝且不留任何行；归档拒绝；不是最新 attempt 的失败被拒绝；换 Adapter 记为 `adapterChanged`；`BLOCKED` 必须有原因、`READY` 必须没有原因且 worktree 仍交还；不交还未被核验的 worktree；不可再复用的 worktree 被拒绝；v23 只加两列、没有新表。
3. `apps/runtime/test/cli-task-retry.test.ts`（6 项，真实 CLI + 真实 Runtime + 独立 `CODEESTRA_HOME` + 临时仓库 + 协议 stub provider）：首次失败（stub 用 `stopReason: 'error'` 模拟 Pi 的失败轮次）⇒ `task retry` 退出 0、attempt 2 建立、`REUSE_VERIFIED`、同一 worktree 里两次启动都留下痕迹、审计事件与 `ExecutionReserved` 关系可读；未失败的 Task（未提交 / RUNNING / CANCELLED / 已归档）各自以稳定码拒绝且不动版本；`--adapter codex` 让新 Execution 真的由 Codex stub 启动（读取 stub 自己的 report，而不是只看列）；容量 1 时重试得到 `CAPACITY_GLOBAL_LIMIT_REACHED` 与退出码 3、Task 留在 `READY`、释放槽位后才跑起 attempt 2；worktree 被 `reclaim` 后重试以 `WORKSPACE_RECLAIMED` 拒绝且版本不变；依赖未满足时 requeue 到 `BLOCKED` 且 `start.outcome=REFUSED/DEPENDENCIES_UNMET`。
4. `bun run check:fast` 与 `bun run check` 的实际结果（含已知的既有 flake 与 pre-existing 失败）见 `docs/tasks/README.md` FOUNDATION-061。

**未验证**（不得当成已成立）：真实 provider 失败后的重试行为（真实 Pi/Codex 的失败只能在 `## NEXT` 第 1 项的真实验收里看）；取消后重做（本格明确不做，`CANCELLED` 仍拒绝）；跨 adapter 复用历史 conversation（retry 是新建 conversation，刻意不续接）；被 reclaim 后重建 worktree（D05 的缺口）；`task retry` 的 UI 投影（H1 领地）；重试在真实并发/真实模型行为下的表现。

## 关联文档

- `PROJECT_SPEC.md` §1.1（效率至上 / CLI 完备 / 测试边界）、§2 不变量 1/5/9/24、§3（「取消、修订、重试及人工回答均需要审计」）。
- `docs/architecture/state-machines.md` §1（Task lifecycle 的 `FAILED | user retry` 行）、§2（Execution 终态语义：新尝试新 ID）。
- `docs/architecture/scheduler.md` §1–§2（候选、门禁顺序）、§4（修订/恢复前重新核验）、§4.1（UNKNOWN 放行）、§7（已实现的原语与命令面）。
- ADR-0001（运行修订先暂停、停止并新建 Execution）、ADR-0008（三条第一原则）、ADR-0011（FULL 零确认）、ADR-0016（暂停/恢复/终止/归档的既有语义）、ADR-0023/0026（incarnation 与单 writer）、ADR-0024（依赖与 `BLOCKED` 唯一含义）、ADR-0028（「停止并新建 Execution」的先例）、ADR-0029（记录本缺口的来源与 Adapter 能力矩阵）、ADR-0030（UNKNOWN 放行）、ADR-0031/0032/0033（判定、容量预留、调度引擎——本格不修改它们）。
- `docs/roadmap/mvp.md` Phase 5（「失败后新 Execution 可更换 Agent」）；`docs/tasks/README.md` FOUNDATION-061。

## 后续变更（FOUNDATION-068 / ADR-0042，不改写上文决策）

上文 Decision 的其余部分全部仍然有效（不自动重试、只从 `FAILED` requeue、依赖重新判定、`--adapter` 语义、
拒绝不写任何行、旧 Execution 证据不改写）。**只有「已 reclaim 的 worktree 无法重试」这一条被 ADR-0042 关闭**：

- `reconcileWorkspace` 在本 ADR 的 retry 路径上由 `inspectOwnedWorktreeRebuild` 取代（同一四分类
  `OWNED`/`MISSING`/`FOREIGN`/`UNCERTAIN`，另加分支事实），拒绝码集合不变；
- 已 reclaim 且分支仍可证明归属时，`decideRetryWorkspace` 返回 `mode: 'REBUILD_OWNED'`（“核验通过、待重建”）；
  真实重建在既有 workspace preparation 路径执行，`WORKSPACE_RECLAIMED` 只在无法证明归属时出现；
- 上文 Verification 中「worktree 被 `reclaim` 后重试以 `WORKSPACE_RECLAIMED` 拒绝」一项已被
  `apps/runtime/test/cli-task-retry.test.ts` 的新用例取代（改为断言重建成功、以及不可重建时的两种零写入拒绝）。

未验证一栏里「被 reclaim 后重建 worktree」一项相应地移入 ADR-0042 的已知边界（真实 provider 未验收、
`RELEASED` 且分支也不存在时的 `PREPARE_FRESH` 路径仍会撞 `workspaces.path` 唯一约束、UI 未投影）。
