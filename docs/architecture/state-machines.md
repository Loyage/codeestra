# 状态机与迁移规则

> 层级：L1 · 体量 ≈ 9k 字符 · **何时读**：改 Task/Execution 的状态迁移、写迁移 guard、判断某状态能不能到另一个 · 权威来源：`packages/domain/src/**` 的状态集合与迁移函数、`packages/storage/src/database.ts` 的 CHECK 与 CAS、各状态相关 command 的实现。
>
> **只读与当前任务相关的部分**：本篇回答「Task / Execution / 内核对象」；Session 与接管、修订投递在 [`state-machines-sessions.md`](./state-machines-sessions.md)；Runtime 生命周期、全局负载控制与 Self Evolution 在 [`state-machines-runtime.md`](./state-machines-runtime.md)。

状态：记录当前 schema v38。ADR-0070 的 Service/Signal/Process FSM 已由 S1–S4 实现；**Task integration 的迁移已由 S8 实现**（`merge_queue_items` / `task_integration`，ADR-0074），Integration Process/Agent 与 S9–S10 仍是目标。**未列出的迁移一律拒绝**；所有迁移需 expected version、actor、reason，并记录事实事件；恢复操作不绕过 guard。

## 读取路由与章节号对照

拆分前的编号被原样保留（代码注释与 ADR 正文仍按旧号引用），对照如下：

| 你要找的 | 在哪 |
|---|---|
| §0 ADR-0070 内核 FSM、§1 Task lifecycle、§2 Execution、§8 不改变状态集合的持久事实 | 本篇 |
| §3 AgentSession / Takeover（含 §3.1 incarnation 与单 writer lease、§3.2 Session Guidance）、§7 Revision 投递 FSM | [`state-machines-sessions.md`](./state-machines-sessions.md) |
| §4 已删除的集成/提升状态机、§5 Self Evolution、§6 Runtime 生命周期（含 §6.1 全局负载控制） | [`state-machines-runtime.md`](./state-machines-runtime.md) |

## 0. ADR-0070 新状态机（S1–S4 内核已实现）

```text
Service: ACTIVE ↔ PAUSED → RETIRED
              └→ RECOVERY_REQUIRED

Signal: PENDING → CLAIMED → ACKED
                    ├→ RETRYABLE → CLAIMED
                    ├→ DEAD_LETTER
                    └→ RECOVERY_REQUIRED

Process: CREATED → STARTING → RUNNING ↔ WAITING_FOR_USER
                                  ├→ PAUSING → PAUSED → RUNNING
                                  └→ SUCCEEDED | FAILED | CANCELLED | RECOVERY_REQUIRED

Task integration: NOT_REQUESTED → QUEUED → MERGING → VERIFYING → MERGED
                                      ├→ CONFLICTED → QUEUED（显式 retry）
                                      └→ FAILED | STALE | RECOVERY_REQUIRED
```

Service lifecycle 不替代 Task lifecycle；Process 先投影现有 Execution；Signal 至少一次交付，ACK 只代表目标 handler 已持久收口，不代表跨 Git/Provider exactly-once。Task execution 与 integration 是正交状态，不能压成一个“完成”。完整 guard 见 `service-process-signal.md`，实现波次见 roadmap。

## 1. Task lifecycle

状态：`DRAFT, BLOCKED, READY, RUNNING, PAUSING, PAUSED, WAITING_FOR_USER, RECOVERY_REQUIRED, EXECUTED, FAILED, CANCELLING, CANCELLED, SUCCEEDED`。

**本表不包含「已删除」：`task purge`（ADR-0058）不产生新状态，它让聚合根行消失**。`TaskPurged` 的 payload 里
`to: 'PURGED'` 描述的是「这个任务在这里结束」，不是一个可迁移到的状态（没有 `task list`/`task status` 能再读到它）。
因此本表的迁移规则对它不适用：purge 先按既有规则把非终态任务停到 `CANCELLED`，`RECOVERY_REQUIRED` 任务则先按观察对账收口为
`FAILED`（与 `task recover` 同一判定；provider 无法证明已退出即 `RECONCILE_REQUIRED` 且什么都不删），
再在一次数据库事务里删掉它及其全部子行；`SUCCEEDED` 任务因成果已在 `dev` 中而被拒（ADR-0053）。

**`--force`（ADR-0058 D09）不新增状态，也不新增「伪状态」**：它跳过的是判据而不是事实——`RECOVERY_REQUIRED` 任务被删除时
最终状态仍然记作 `RECOVERY_REQUIRED`（结果里 `stop.stop: "FORCED"` 与 `forced.bypassed` 说明它没有被证明静止）。

| 源 | 触发 | Guard / 目标 |
|---|---|---|
| DRAFT | submit | 规格有效；依赖未满足→BLOCKED，否则 READY |
| BLOCKED | dependencies satisfied | 上游指定修订的结果 commit 对项目**当前 Task 基线 ref**（项目文件夹当前检出的分支）可达→READY；由 scheduling pass 重新评估（ADR-0066，见 [`state-machines-runtime.md`](./state-machines-runtime.md) §4） |
| READY | dependency invalidated | →BLOCKED |
| READY | schedule | 当前 revision、依赖、冲突、容量、workspace 预留均通过→RUNNING（含 Execution 准备过程） |
| RUNNING | agent needs input | 真实 AttentionRequest 已建立→WAITING_FOR_USER |
| WAITING_FOR_USER | answer accepted / agent active | 所有当前阻塞问题关闭，无待应用 revision→RUNNING |
| RUNNING | prose question detected | Runtime 判定命中稳定码 `PROSE_QUESTION_NO_TOOL_USE`（启发式：本轮无工具调用且最后一段助手文本以问号结束）→在同一完成事务内升为一条 `QUESTION` Attention + WAITING_FOR_USER（ADR-0043 默认 `auto`，可用 `settings prose-question-attention record-only\|off` 降级）。`Session` 保持 `EXITED`、`Execution` 保持 `RUNNING`：进程真的退出了，不把死会话伪装成活着的 provider 会话 |
| WAITING_FOR_USER | prose question resolved | `attention resolve --dismiss\|--answer` 关闭该 Attention 并回到 RUNNING（同事务）；**不向 provider 投递任何内容**（`deliveredToProvider: false`）、不新建 Execution、不 resume conversation。`attention answer` 对这类等待以 `PROSE_QUESTION_RESOLUTION_REQUIRED` 拒绝 |
| RUNNING / WAITING_FOR_USER | revision added | 保存 revision、验证失效、请求停止写入→PAUSING |
| PAUSING | quiescence confirmed | 无工具/子进程继续写入的可靠证据→PAUSED |
| PAUSED | revision acknowledged / resume | 当前 revision 已应用且冲突重新核验→RUNNING |
| PAUSING / PAUSED | cannot safely resume | 旧 Execution 已终止才可→READY（新尝试）；不能确认退出→RECOVERY_REQUIRED |
| RUNNING | execution result captured | 当前 applied revision 匹配且产出 commit 固定→EXECUTED |
| RUNNING / PAUSING / PAUSED / WAITING_FOR_USER | execution failed | 明确失败且进程已静止→FAILED |
| RUNNING / PAUSING / PAUSED / WAITING_FOR_USER / CANCELLING | ownership/liveness uncertain | 保持资源隔离→RECOVERY_REQUIRED |
| FAILED | user retry | 旧执行静止、依赖重验→READY 或 BLOCKED |
| EXECUTED | revision added | 失效旧证据；旧执行静止→READY 或 BLOCKED |
| DRAFT / BLOCKED / READY / EXECUTED / FAILED | cancel | 没有活动写入的竞争操作→CANCELLED |
| RUNNING / PAUSING / PAUSED / WAITING_FOR_USER | cancel | →CANCELLING，协作中断 |
| CANCELLING | confirmed stopped | →CANCELLED，保留 workspace |
| RECOVERY_REQUIRED | reconcile | 依据真实事实回到已证实状态；必须审计，不能直接释放资源。命令面是 `task recover <task> <expected-version>`（ADR-0055；ADR-0076 之后 Task 命令只收 task-id）：只读事实（记录的 provider 身份按真实进程表 + start token + 后代核对、记录的后代快照、workspace 路径是否仍在磁盘），**只有能证明 provider 已消失**才收口为 `FAILED`（同时 `Execution → FAILED`、`resource_held=0`、Session `→ EXITED`、workspace `→ RETAINED`）；存活 / 后代存活 / 无法核验 / 无身份一律**拒绝并保持占用**（退出码 1、零行变化）。收口**不主张工作树静止**（`quiescenceProven:false`、`signalsSent:0`），不发信号、不删工作树 |

READY 的等待原因单独派生为 CONFLICT / CAPACITY / DRAINING / REVISION_REVIEW / CONTROL 等，**不误用 BLOCKED**。ADR-0061 的两半都已实现（schema v34）：容量是唯一的跨 Project Runtime 上限（FOUNDATION-096），全局负载屏障以 `SCHEDULER_GLOBALLY_PAUSED` 表达（仍是等待、退出码 3，不是 Task 状态；FOUNDATION-097，见 [`state-machines-runtime.md`](./state-machines-runtime.md) §6.1）。依赖未满足是 BLOCKED 唯一含义；SUCCEEDED/CANCELLED 不自动重开。

Task Verification：`NOT_RUN → QUEUED → RUNNING → PASSED | FAILED | ERROR | CANCELLED`；revision/commit/策略失效产生 `STALE`。重验创建新 VerificationRun，旧证据不改写。

`CANCELLED` 是一等终态（ADR-0027，schema v17 重建 `verification_runs` 的 CHECK，`integration_verification_runs` 未变）：与其它终态一样**必须**带 `ended_at` 与 `outcome_code`，因此「未确认进程组静止」仍写不成终态；确认静止后落 `CANCELLED/CANCELLED_BY_USER`。被取消的副本与失败现场同类，仍只经 ADR-0021 的 `reclaim` 显式回收。

Phase 1 判定（ADR-0006）：全部命令 exit 0 且副本 tracked 内容未变→`PASSED`；命令非零退出或无法 spawn→`FAILED/COMMAND_FAILED`（不继续后续命令）；超时→`ERROR/COMMAND_TIMEOUT`；tracked 修改或 HEAD 移动→`ERROR/TREE_MUTATED`（不覆盖已判定的 `FAILED`）；副本无法创建→`ERROR/WORKTREE_FAILED`；Runtime 重启→`ERROR/RUNTIME_RESTARTED` 并保留副本路径。终态一旦写入，重放 completion 不改变结论。Task 自身状态不因验证而变成 SUCCEEDED：`PASSED` 只是当前 revision/commit 的 Task scope 证据。

Task worktree 基线与回收：基线取「项目文件夹建 workspace 时当前检出的分支」，与 commit 一起固定进 `workspaces.base_ref`/`base_commit`；回收只有显式 `reclaim plan/apply/records` 一条路径，不删 branch、失败现场默认保留。细节见 [`git-workspace-api.md`](./git-workspace-api.md) §2/§3。

## 2. Execution

状态：`CREATED, PREPARING, STARTING, RUNNING, WAITING_FOR_USER, PAUSING, PAUSED, STOPPING, RECOVERY_REQUIRED, SUCCEEDED, FAILED, CANCELLED, SUPERSEDED`。

| 迁移 | 条件 |
|---|---|
| CREATED→PREPARING→STARTING | 已预留执行权；Git 资源准备并核验后才启动 Agent |
| STARTING→RUNNING | 收到可信 session started 事件并保存身份 |
| RUNNING→WAITING_FOR_USER→RUNNING | 建立问题；真实回答被接受并确认继续 |
| RUNNING/WAITING_FOR_USER→PAUSING→PAUSED | 先请求暂停，再确认 quiescence；普通输出停止不算暂停 |
| PAUSED→RUNNING | 最新 revision ACK、冲突安全、实际恢复确认 |
| 非终态→STOPPING | 用户取消或修订需重启；保存 stopReason |
| STOPPING→CANCELLED | USER_CANCEL 且所有归属进程已静止 |
| STOPPING→SUPERSEDED | REVISION_RESTART 且所有归属进程已静止 |
| RUNNING→SUCCEEDED | Agent 正常完成、工具静止、产出 commit 捕获；不代表验证通过 |
| 准备/启动/运行等→FAILED | 可证明无残留写入，保存错误；否则 RECOVERY_REQUIRED |
| 非终态→RECOVERY_REQUIRED | 失联、控制超时或身份未知；占用不释放 |

终态不可被后来迟到的 Agent 事件改回 RUNNING。新尝试新 ID；重启恢复同一已存活 session 不创建重复 execution。

成果 commit 的授权按权限模式：FULL 下 `task.result.capture` 单步（零确认、不做敏感路径拒绝）；STRICT 下保留 prepare/confirm——prepare 只读快照并落一次性授权（绑定 execution/revision/workspace ownership/expected HEAD/ChangeSet fingerprint/身份），confirm 重验后才 `git add`/`commit`；确认是单次能力，HEAD 或差异变化使其失效。消费后 Execution→SUCCEEDED 且 workspace IN_USE→RETAINED（保留供验证），Task 只到 EXECUTED。commit 已生成但回写失败时按 HEAD/OID 补记，不重跑 hook、不重写历史。

## 8. 不改变上述状态集合的持久事实

以下能力进入 Runtime 的对外事实面，但**不新增、也不改变** §1–§7 的任何状态集合；逐表 DDL 见 [`sqlite-schema-runtime.md`](./sqlite-schema-runtime.md) 与 [`sqlite-schema-task.md`](./sqlite-schema-task.md)：

- `tasks.pending_retry_from_execution_id` / `executions.retry_from_execution_id`（v23）：§1 的 `FAILED → READY/BLOCKED` **不是自动的**，只有 `task retry` 写这两列并产生 `TaskRetryRequested`。
- `reclamation_records` 的 `source`/可空 `task_id`/`outcome='RECOVERY_REQUIRED'`（v24）：回收账本能表达「未登记目录」与「归属不可核验」，这不是状态迁移。
- `knowledge_snapshots` / `execution_knowledge_snapshots`（v26，append-only）：绑定写在 `reserveExecution` 的**同一事务**内，因此「Execution 存在」与「已绑定所用知识」不可分开观察（ADR-0041）。
- `agent_configurations.plugin_selection_json`（v27）与 `settings prose-question-attention`（ADR-0043）：设置，不是门禁；改它零确认，且**不会**改写已经记录的等待或已完成的选择。插件能力的如实声明见 [`agent-adapter-providers.md`](./agent-adapter-providers.md) §6。
