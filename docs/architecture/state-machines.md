# 状态机与迁移规则

状态：§1–§8 记录当前 schema v37 及历史状态机；ADR-0068 的 Service/Signal/Process FSM 已由 S1–S4 实现，受管 integration 与 S5–S10 仍是目标。未列出的迁移拒绝；所有迁移需 expected version、actor、reason，并记录事实事件。恢复操作不绕过 guard。

## 0. ADR-0068 新状态机（S1–S4 内核已实现）

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
                                      ├→ CONFLICTED
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
| BLOCKED | dependencies satisfied | 上游指定修订的结果 commit 对项目**当前 Task 基线 ref**（项目文件夹当前检出的分支）可达→READY；由 scheduling pass 重新评估（ADR-0066，见 §4） |
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
| RECOVERY_REQUIRED | reconcile | 依据真实事实回到已证实状态；必须审计，不能直接释放资源。命令面是 `task recover <project> <task> <expected-version>`（ADR-0055）：只读事实（记录的 provider 身份按真实进程表 + start token + 后代核对、记录的后代快照、workspace 路径是否仍在磁盘），**只有能证明 provider 已消失**才收口为 `FAILED`（同时 `Execution → FAILED`、`resource_held=0`、Session `→ EXITED`、workspace `→ RETAINED`）；存活 / 后代存活 / 无法核验 / 无身份一律**拒绝并保持占用**（退出码 1、零行变化）。收口**不主张工作树静止**（`quiescenceProven:false`、`signalsSent:0`），不发信号、不删工作树 |

READY 的等待原因单独派生为 CONFLICT / CAPACITY / DRAINING / REVISION_REVIEW 等，不误用 BLOCKED。**ADR-0061 的容量上半（FOUNDATION-096，schema v34）已实现：CAPACITY 现在是唯一的跨 Project Runtime 上限，不再是项目级/Adapter 级两个上限。** 全局负载屏障另以 `SCHEDULER_GLOBALLY_PAUSED` 表达（仍是等待、退出码 3，不是 Task 状态），属 ADR-0061 下半、**尚未实现**。依赖未满足是 BLOCKED 唯一含义。SUCCEEDED/CANCELLED 不自动重开。

Task Verification：`NOT_RUN → QUEUED → RUNNING → PASSED | FAILED | ERROR | CANCELLED`；revision/commit/策略失效产生 `STALE`。重验创建新 VerificationRun，旧证据不改写。

`CANCELLED` 是一等终态（ADR-0027，schema v17 重建 `verification_runs` 的 CHECK，`integration_verification_runs` 未变）：与其它终态一样**必须**带 `ended_at` 与 `outcome_code`，因此「未确认进程组静止」仍写不成终态；确认静止后落 `CANCELLED/CANCELLED_BY_USER`。被取消的副本与失败现场同类，仍只经 ADR-0021 的 `reclaim` 显式回收。

Phase 1 判定（ADR-0006）：全部命令 exit 0 且副本 tracked 内容未变→`PASSED`；命令非零退出或无法 spawn→`FAILED/COMMAND_FAILED`（不继续后续命令）；超时→`ERROR/COMMAND_TIMEOUT`；tracked 修改或 HEAD 移动→`ERROR/TREE_MUTATED`（不覆盖已判定的 `FAILED`）；副本无法创建→`ERROR/WORKTREE_FAILED`；Runtime 重启→`ERROR/RUNTIME_RESTARTED` 并保留副本路径。终态一旦写入，重放 completion 不改变结论。Task 自身状态不因验证而变成 SUCCEEDED：`PASSED` 只是当前 revision/commit 的 Task scope 证据。

Task worktree 基线（ADR-0066）：新 Task 的 workspace 从**项目文件夹建 workspace 时当前检出的分支**的当前 OID 建立，ref 与 commit 一起固定进 `workspaces.base_ref`/`base_commit`；`HEAD` detached 时以 `TASK_BASE_REF_UNRESOLVED` 拒绝，不静默回退到其他分支。已有 workspace 不回改基线。

Task worktree 回收（ADR-0021）：只有显式 `reclaim plan/apply/records` 一条删除路径（`INTEGRATION_WORKTREE` 取值保留在 append-only 账本词汇表里，但 Runtime 不再产生该类候选）；
它不删 branch，失败现场默认保留。ADR-0062 的「集成成功后自动回收」随 ADR-0066 删除集成而移除，没有自动路径。

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

成果 commit 采两步门禁：prepare 只读快照并落一次性授权（绑定 execution/revision/workspace ownership/expected HEAD/ChangeSet fingerprint/身份），confirm 重验后才 `git add`/`commit`；确认是单次能力，HEAD 或差异变化使其失效。消费后 Execution→SUCCEEDED 且 workspace IN_USE→RETAINED（保留供验证），Task 只到 EXECUTED。commit 已生成但回写失败时按 HEAD/OID 补记，不重跑 hook、不重写历史。

## 3. AgentSession / Takeover

单个 process incarnation：`CREATED → STARTING → ACTIVE`；ACTIVE↔WAITING_FOR_USER；ACTIVE/WAITING_FOR_USER→PAUSING→PAUSED→ACTIVE；活动态→STOPPING→EXITED；控制连接丢失或 Runtime 自行释放其自有 provider 进程→DISCONNECTED；身份或恢复失败→RECOVERY_REQUIRED。

DISCONNECTED→ACTIVE/WAITING_FOR_USER/PAUSED 需 reconcile 证明真实状态。Runtime 自行发起的释放不伪造成 provider event，而以 Runtime 来源记录并保留 Execution/workspace 占用。EXITED 不代表 Task 成功，需 exit reason、执行结果与验证。客户端 detach 不改变 AgentSession 状态。provider resume 创建新 OS 进程时必须建立 successor AgentSession 并关联 predecessor；即使 provider conversation ID 相同，也不伪装旧 OS 进程仍存活。

TakeoverRequest：

```text
REQUESTED
  → WAITING_FOR_ATTENTION | WAITING_FOR_SAFE_POINT
  → STOPPING_SOURCE → STARTING_TARGET → ACTIVE
  → RETURN_REQUESTED → STOPPING_SOURCE → STARTING_TARGET → COMPLETED
```

- RPC→TUI 与 TUI→RPC 都使用同一交接骨架；target mode 分别为 `HUMAN_TUI` 与 `AUTOMATED_RPC`。
- 工具或模型轮次活动时停在 `WAITING_FOR_SAFE_POINT`，不为接管 abort；Attention 正阻塞工具时显示 `WAITING_FOR_ATTENTION`。Pi 建立 handoff fence：当前 assistant turn 已开始的工具继续到结束，此后新工具调用由 gate 以 terminating result 收束，直至 `agent_settled`。
- 请求已提交且随后收到可信 `agent_settled`（无 retry/compaction retry/queued continuation）且活动工具计数为 0 时，该 settled 被消费为 handoff safe point，不同时产生 Execution completion。若 completion 事务先提交，请求以 `EXECUTION_NOT_ACTIVE` 失败。
- STOPPING_SOURCE 只有在 process identity 匹配且确认退出后才能进入 STARTING_TARGET。退出不确定→RECOVERY_REQUIRED，并禁止启动 target。
- STARTING_TARGET 复核 workspace、provider conversation/session file 与受控启动参数；失败且可证实无 target 进程→FAILED，否则 RECOVERY_REQUIRED。
- HUMAN_TUI ACTIVE 时 detach 只移除 attachment；Session 继续 ACTIVE。显式 release 才进入 RETURN_REQUESTED。
- TUI→RPC 完成后 Runtime 投递固定 continuation guidance，随后 Execution 回到自动控制；交接本身不改变 TaskRevision。

TerminalAttachment：多个 `READ_ONLY` 可并存；最多一个 `WRITER` lease。断开→DETACHED 只释放 attachment/lease，不停止 Session；竞争 writer 返回 `ATTACHMENT_BUSY`。PTY 输出和按键不驱动领域状态迁移。

### 3.1 Session incarnation 与单 writer lease（ADR-0023，ADR-0026 实现）

**incarnation**（`session_incarnations`，schema v14）是一次 provider OS 进程代在数据库里的记录，而不是一条 `AgentSession`：同一 conversation（同一 session ID / session file）跨进程延续，但 OS 进程不伪装成同一个。

```text
ACTIVE ↔ FENCED
ACTIVE | FENCED → EXITED
ACTIVE | FENCED → RECOVERY_REQUIRED
```

- `ACTIVE`：当前 writer；`FENCED`：已装 handoff fence，只阻止**新**工具调用，不 abort 进行中的工具。
- 记录 successor 前 Runtime 要求：没有任何 incarnation 仍 `ACTIVE`/`FENCED`、没有未释放租约、predecessor 的 session file 必须与 successor 相同（否则 `SESSION_FILE_CHANGED`）。重复 commandId 幂等返回既有 incarnation。
- 进程身份是 pid + start token + argv hash；`process_tree_json` 是 provider 仍存活时抓取的进程树快照（自身 + 后代）。快照之后 fork 或已 reparent 的进程不在其中，因此**任何分支都不等于「静止」**。
- `agent_sessions.current_incarnation_id` 是「决议还能到达哪个进程」的唯一答案。schema v14 **没有**移除 `agent_sessions.execution_id UNIQUE`：RPC↔TUI 交接收敛为同一 Session 内的 incarnation，不是第二条 `AgentSession`。

**单 writer lease**（`session_writer_leases`）：每个 Session 最多一条未释放租约（partial unique index）。默认由 automation 的 incarnation 持有；第二个 attach/接管请求稳定失败为 `ATTACHMENT_BUSY` 并报出当前 holder，不排队、不静默等待。重启后 `reconcileSessionHandoffs` 以 `RUNTIME_RESTARTED` 释放所有未释放租约并将 live incarnation 置 `RECOVERY_REQUIRED`。

**HandoffRequest**（`session_handoff_requests`）：`REQUESTED → FENCED → AT_SAFE_POINT → ADMITTED`，或 `CANCELLED` / `RECOVERY_REQUIRED`。安全点 = fence 已被 provider 确认 + 活动工具计数 0 + fence 后出现 settled + 无未决 Attention，全部来自结构化上报，不从屏幕文本推断。`admit` 只有在核验 predecessor 归属后才能启动 successor（`PREDECESSOR_NOT_STOPPED`/`PREDECESSOR_DESCENDANTS_ALIVE`/`PREDECESSOR_UNVERIFIED` 一律拒绝）。

**STRICT 权限请求**（`session_permission_requests`）：`OPEN → DECIDING → {ALLOW | DENY | CANCEL}`，或 `STALE`。claim 是一条原子条件更新（`WHERE decision='OPEN' AND incarnation_id = current_incarnation_id`），只有仍是当前 writer 的 incarnation 能赢；两个客户端同时回答时另一个得 `ALREADY_DECIDING`，旧 incarnation 的决议被拒为 `STALE_INCARNATION` 且**不写入 provider、不驱动任何工具**。

**Terminal**（`session_terminals` / `session_terminal_attachments`，schema v18）：terminal 状态 `RUNNING / RELEASED / STOPPED / RECOVERY_REQUIRED`，每 Session 最多一个 RUNNING；attachment 状态 `ATTACHED / DETACHED`，每 terminal 最多一个 `ATTACHED WRITER`。release 判定由「显式 release 字节 + provider 退出事实 + 归属核验 + session file 前后事实」共同构成；`exit_code` 只作审计，任何判定都不得以它分支（FOUNDATION-040 实测 Ctrl+D 与 SIGTERM 都是 0）。PTY 原始字节不持久化。

原生审批回答中 reject/deny 也属于有效回答，不能把“用户已回答”等同“用户批准”。TUI gate 与 Runtime Attention 并发收到答案时只允许一份从 OPEN 变为已决，迟到答案不得再次驱动工具。

### 3.2 Session Guidance（ADR-0057，schema v31）

一条 guidance 的状态就是它的**投递事实**，与 TaskRevision 的严格 ACK 口径**不同**（ADR-0028）：

```text
RECORDED ──(存在活会话且通道为 SUPPORTED)──→ DELIVERED        # provider 自己的通道接受了消息（已入队）
    │                     │→ CHANNEL_UNSUPPORTED | TIMED_OUT | FAILED
    │
    └──(当时没有 Execution 持有 Task，或没有活会话)── 保持 RECORDED
```

- `RECORDED`：正文已耐久保存（ADR-0010 D02）；该 Task 的 guidance 会在**每一条新 Execution**（含 `task resume` 的 successor 与
  `task retry`）启动时随启动参数交给 provider，交付事实写进 `execution_guidance_contexts`，因此它不会随进程消失。
- `DELIVERED`：**只表示 provider 通道接收（入队）**，不表示模型读了它。“模型已读”在本实现里**不存在**：三个 provider 都没有
  可核验通道（ADR-0051），因此没有状态、没有列、没有事件能表达它。
- `CHANNEL_UNSUPPORTED` / `TIMED_OUT` / `FAILED`：拒绝或未完成，并带稳定 `state`/`errorCode`，**不降级、不静默**。
- guidance **不产生 TaskRevision**、不动 `tasks.current_revision_id`/`tasks.version`、不写 `VerificationInvalidated`、
  不使任何验证或未提升批次失效；`task amend` 仍是唯一的规格变更路径。
- 启动交付 fail-closed：Task 有 guidance 记录却拿不到 Runtime home 或 artifact 核验不过（绝对路径/普通文件/digest/字节数/UTF-8）
  时以 `GUIDANCE_CONTEXT_UNAVAILABLE` **拒绝启动**，不静默少注入；**零 guidance 时 argv/入参逐字节不变**。

## 4. IntegrationBatch / StableBranchPromotion（已删除，ADR-0066）

这一整段曾描述「Task 成果进入 `dev`」与「`dev` 提升 `main`」两层状态机。**ADR-0066 把它从产品中删除**：
命令（`task integrate`、`task integration create|integrate|list|get|cancel`、
`promotion prepare|approve|promote|restart.record|abandon|get|list`、
`promotion full-suite run|list`）、服务（`integration-service`、`promotion-service`、
`promotion-evidence-service`）、领域表（`integration_batches(_items)`、`integration_verification_runs`、
`stable_promotions(_members)`、`dev_full_suite_evidence`）与对应状态全部不再存在（schema **v35**）。

它留下的三个后果，写在别处而不是这里的状态机里：

1. **成果停在 `refs/heads/task/<task-id>`**（ADR-0005）。是否合并由用户决定，产品不合并、不推送、不记账。
2. **依赖释放**改由「上游修订自己的 result commit 是否对项目当前 Task 基线 ref 可达」判定；原因码是有界枚举
   `UPSTREAM_RESULT_MISSING` / `BASE_REF_MISSING` / `BASE_REF_UNREADABLE` / `NOT_REACHABLE_FROM_BASE`
   （见 §1 的 `BLOCKED → READY` 行）。
3. **`BLOCKED → READY` 的触发者**改为 scheduling pass：`schedule-service.#reconcileBlockedTasks` 在挑选候选前
   对每个 `BLOCKED` 任务调用 `reconcileTaskDependencyState`。旧的 `reconcileDependentTasks`（由集成命令触发）
   已删除；`task.depends.list` / `task schedule status` 只读，所以下游状态最多滞后一个 tick。

本仓库自身仍以 `main`/`dev` 两个 clone 开发并把 `dev` 提升到 `main`，但那是仓库约定
（`AGENTS.md` 的人工四步、`docs/agents/runbook.md`），产品不提供命令、不记账、不校验它。

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

## 7. Revision 投递 FSM（ADR-0028，schema v19）

投递是**一等需求**（`task_revision_deliveries`），每次尝试是 append-only 台账（`task_revision_delivery_attempts`）：

```text
PENDING → IN_FLIGHT → ACKNOWLEDGED
                    → UNACKNOWLEDGED
                    → CHANNEL_UNSUPPORTED
                    → TIMED_OUT
                    → FAILED
任意未满足态 ──────→ SUPERSEDED_BY_RESTART
```

- `satisfied` **只有** `ACKNOWLEDGED`（带 Adapter 的结构化 evidence）与 `SUPERSEDED_BY_RESTART`（读回 successor Execution 行并确认其**记录值** `applied_revision_id` 就是该 revision）。`PENDING`/`IN_FLIGHT`/`UNACKNOWLEDGED`/`CHANNEL_UNSUPPORTED`/`TIMED_OUT`/`FAILED` 一律 unsatisfied 且保留可见，不存在「静默丢弃」。
- 能力如实：投递前实时 `probe()` Adapter；`revisionAcknowledgement != SUPPORTED` → `CHANNEL_UNSUPPORTED`（evidence `capability:<值>`，Pi、Codex 与 Claude 都是 `capability:UNSUPPORTED`）。声明 `SUPPORTED` 但缺 `applyRevision` 端口 → 同样 `CHANNEL_UNSUPPORTED`；返回 ACK 但没有 evidence → `UNACKNOWLEDGED/MISSING_ACK_EVIDENCE`。
- 三个 provider 的「有没有 ACK 通道」已用真实 CLI 实测固定（ADR-0051 / FOUNDATION-079）：Pi RPC 有 `prompt`/`steer`/`follow_up` 但成功只回 `queue_update`（且无 revision 命令）、Codex app-server 有 `turn/steer`（需活跃 turn，响应只有 `{turnId}`）与 `thread/inject_items`、Claude 控制协议只有 `initialize`/`interrupt`/`can_use_tool`。**投递通道存在但「新修订已生效」无处可核验**，因此一律维持 `UNSUPPORTED`，不实现 `applyRevision`。
- 领域守卫：ACK 必须命名本投递的 revision 且 Task 的 `current_revision_id` 仍是它，否则 `STALE_REVISION_ACKNOWLEDGEMENT`；已满足的投递再 ACK/再开 attempt 抛 `REVISION_ALREADY_ACKNOWLEDGED`；`SUPERSEDED_BY_RESTART` 必须携带 successor 记录在案的 revision，否则 `SUCCESSOR_REVISION_MISMATCH`。每次状态推进经 `transitionRevisionDelivery` 做乐观版本 CAS，并发处置冲突为 `CONCURRENT_MODIFICATION`。
- 不支持的 Adapter 的唯一处置是既有「协作停止 + 新建 Execution」（`task revision delivery resolve --action stop-and-restart`）；停止无法确认静止 → 尝试 `FAILED/STOP_UNCONFIRMED`，命令返回 `RECOVERY_REQUIRED`、退出码 1、资源全部保留。
- 重启（`reconcileAtStartup`）把仍 `IN_FLIGHT` 的尝试按事实收口：期限已过 `TIMED_OUT`，无期限（被杀在途中）`FAILED/RUNTIME_RESTARTED`；**没有**自动重投。

启动收敛（`reconcileStaleAgentSessions`）处理重启后 `agent_sessions`/`executions` 仍写 ACTIVE/RUNNING 的投影：按记录的 pid + start token 判所有权，得到 `PROVIDER_STOPPED` / `PROVIDER_STILL_RUNNING` / `PROVIDER_DESCENDANTS_ALIVE` / `PROVIDER_OWNERSHIP_UNVERIFIABLE` / `PROCESS_IDENTITY_MISSING` 之一，然后一律写 `DISCONNECTED`（Session，清空 current incarnation）+ `RECOVERY_REQUIRED`（Execution，保持 `resource_held=1`；workspace 与 Task 同样）。**绝不写 RUNNING/ACTIVE、绝不声称静止（进程树只是快照）、绝不发信号/杀进程、绝不删资源**；每次收敛向 `agent_session_startup_reconciliations` 追加一行（evidence 固定 `quiescenceProven:false`、`signalsSent:0`），幂等且不动本代 Runtime 仍持有的 Session。

## 8. Wave I/J 新增的持久事实与命令面（FOUNDATION-074 补记）

本节的目的是把「状态机文档落后于实现」这件事本身关掉：Wave I/J 之后新增的持久事实与命令面无一处改变上面 §1–§7 的状态集合，
但它们确实进入了 Runtime 的对外事实面，因此需要登记。

**新增的持久事实（DDL 与理由见 `sqlite-schema.md` §8）**

| schema | 对象 | 与状态机的关系 |
|---|---|---|
| v23 | `tasks.pending_retry_from_execution_id`、`executions.retry_from_execution_id` | §1 的 `FAILED` → user retry 行：`FAILED → READY/BLOCKED` **不是自动的**，只有 `task retry` 写这两列，并产生 `TaskRetryRequested` |
| v24 | 重建 `reclamation_records`（`source`、`kind='UNREGISTERED_DIRECTORY'`、可空 `task_id`、`outcome='RECOVERY_REQUIRED'`） | 不属于状态迁移：这是 ADR-0021 回收账本能表达「未登记目录」与「归属不可核验」的事实 |
| v26 | `knowledge_snapshots`、`execution_knowledge_snapshots`（两张 append-only） | 不在状态机里：绑定在 `reserveExecution` 的同一事务内写入，因此「Execution 存在」与「已绑定所用知识」不可分开观察（ADR-0041） |
| v27 | `agent_configurations.plugin_selection_json` | 不在状态机里：见下节 |

**命令组（零确认、`--json`、稳定退出码；全部是同一命令面，UI 不新增语义）**

- `settings ui list|get|set|reset`（ADR-0045，**无 schema 变更、不占迁移号**）：`$CODEESTRA_HOME/ui-settings.json` 的五个界面效果键
  （`theme`/`density`/`fontSize`/`motion`/`timeDisplay`）。它们是**设置不是门禁**：每次写入一条命令、零确认；未知键或非封闭取值在
  边界拒绝（CLI 退出码 2，HTTP 为 `INVALID_REQUEST`）；读不懂的 settings 文件报 `INVALID_UI_SETTING` 而不是静默回退默认
  （`settings ui reset` 是显式的出口）。**它们不驱动任何领域状态迁移**，因此本节没有对应状态。
- `settings prose-question-attention [auto|record-only|off]`（ADR-0043）：决定 §1 的散文提问命中是否升级为一等等待；改它零确认，
  且**不会**改写已经记录的等待。
- `agent plugins list` / `agent plugins select`（ADR-0044，schema v27）：选择按作用域写入 `agent_configurations.plugin_selection_json`，
  在 Execution 预留时解析成生效值并写入 `executions.agent_config_json`，因此**同一 Execution 的启动参数可事后读回**。选择里任一
  无法加载的路径在写入前与 Session 启动前各核验一次，拒绝时**在任何副作用之前**（不创建 Execution）。`agent.config.get/list` 同时
  报告生效值与它来自哪一层。

**能力维度 `pluginSelection` 的如实声明（ADR-0044，`packages/contracts` 的 `AdapterCapabilities`）**

| Adapter | 值 | 依据 |
|---|---|---|
| Pi | `SUPPORTED` | 受控启动可以只加载所选 sources，关掉发现机制（`packages/agent-adapters/src/pi-plugins.ts`） |
| Codex | `UNSUPPORTED` | app-server 没有等价机制 |
| Claude Code | `UNSUPPORTED` | 同上 |
| deterministic fake / 测试 stub | `UNSUPPORTED` | 它们不启动任何 provider |

`UNSUPPORTED` **不是占位符**：`agent plugins select` 对不支持该能力的 Adapter 以稳定码拒绝，而不是假装写入了选择；Agent 设置页在
同一字段为 `UNSUPPORTED` 时**不显示候选列表**（`apps/ui/src/agent-settings.tsx`）。与 `nativeTerminalHandoff`/`safePointNotification` 一样，这里的「声明」不改变行为——本版本没有把脚本/交接路径改成
「先查能力再决定」（ADR-0044 与 `agent-adapter-api.md` §1 均已如实记录这一点）。
