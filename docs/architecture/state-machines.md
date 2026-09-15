# 状态机与迁移规则

状态：§1–§7 是已实现的状态机与迁移规则（第 8 节登记 Wave I/J 的持久事实与命令面）。未列出的迁移拒绝；所有迁移需 expected aggregateVersion、actor、reason，并在事务中记录事实事件。恢复操作不绕过 guard。Self Evolution（§5）仍是后续阶段合约。

## 1. Task lifecycle

状态：`DRAFT, BLOCKED, READY, RUNNING, PAUSING, PAUSED, WAITING_FOR_USER, RECOVERY_REQUIRED, EXECUTED, FAILED, CANCELLING, CANCELLED, SUCCEEDED`。

| 源 | 触发 | Guard / 目标 |
|---|---|---|
| DRAFT | submit | 规格有效；依赖未满足→BLOCKED，否则 READY |
| BLOCKED | dependencies satisfied | 上游指定结果已入 dev 且当前 dev 基线可达→READY |
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
| EXECUTED | revision added | 失效旧证据和未提升批次；旧执行静止→READY 或 BLOCKED |
| EXECUTED | integrated to dev | 当前 revision 的固定候选经独立集成验证成功进入 dev→SUCCEEDED |
| DRAFT / BLOCKED / READY / EXECUTED / FAILED | cancel | 没有活动写入或正在提升的竞争操作→CANCELLED |
| RUNNING / PAUSING / PAUSED / WAITING_FOR_USER | cancel | →CANCELLING，协作中断 |
| CANCELLING | confirmed stopped | →CANCELLED，保留 workspace |
| RECOVERY_REQUIRED | reconcile | 依据真实事实回到已证实状态；必须审计，不能直接释放资源 |

READY 的等待原因单独派生为 CONFLICT / CAPACITY / DRAINING / REVISION_REVIEW 等，不误用 BLOCKED。依赖未满足是 BLOCKED 唯一含义。SUCCEEDED/CANCELLED 不自动重开。

Task Verification：`NOT_RUN → QUEUED → RUNNING → PASSED | FAILED | ERROR | CANCELLED`；revision/commit/策略失效产生 `STALE`。重验创建新 VerificationRun，旧证据不改写。

`CANCELLED` 是一等终态（ADR-0027，schema v17 重建 `verification_runs` 的 CHECK，`integration_verification_runs` 未变）：与其它终态一样**必须**带 `ended_at` 与 `outcome_code`，因此「未确认进程组静止」仍写不成终态；确认静止后落 `CANCELLED/CANCELLED_BY_USER`。被取消的副本与失败现场同类，仍只经 ADR-0021 的 `reclaim` 显式回收。

Phase 1 判定（ADR-0006）：全部命令 exit 0 且副本 tracked 内容未变→`PASSED`；命令非零退出或无法 spawn→`FAILED/COMMAND_FAILED`（不继续后续命令）；超时→`ERROR/COMMAND_TIMEOUT`；tracked 修改或 HEAD 移动→`ERROR/TREE_MUTATED`（不覆盖已判定的 `FAILED`）；副本无法创建→`ERROR/WORKTREE_FAILED`；Runtime 重启→`ERROR/RUNTIME_RESTARTED` 并保留副本路径。终态一旦写入，重放 completion 不改变结论。Task 自身状态不因验证而变成 SUCCEEDED：`PASSED` 只是当前 revision/commit 的 Task scope 证据，仍须经 IntegrationBatch 进入 `dev`。

Task Integration summary：`NOT_READY → ELIGIBLE → BATCHED → INTEGRATED`；失败/修订产生 `NEEDS_ATTENTION / STALE`。这些是查询投影，不是替代 Batch 的权威状态。

Task worktree 基线（ADR-0009/ADR-0018）：新 Task 的 workspace 从 `projects.dev_ref`（默认 `refs/heads/dev`）的当前 OID 建立；仓库没有 `dev` 时 `project.trust` 以 `DEV_REF_MISSING` 拒绝，不静默回退到其他分支。已有 workspace 不回改基线。

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

## 4. IntegrationBatch / StableBranchPromotion

实现状态（ADR-0018 / ADR-0022）：**已实现单成员合入**（`task.integrate` / `task.integration.list`，CLI + 同一命令面 + UI），
**也已实现 `StableBranchPromotion` 段**（`promotion prepare/approve/promote/abandon/get/list`，ADR-0022/FOUNDATION-042，见本节末）。
IntegrationBatch 已实现的状态为 `CREATED → PREPARING → VERIFYING → INTEGRATING_DEV → INTEGRATED`，另有
`CONFLICTED / FAILED / RECOVERY_REQUIRED`；**多成员批次、批级 `STALE`、批级 `CANCELLED` 仍属后续阶段合约**（`task.integrate`
每次只集成一个 Task，虽然 `integration_batch_items` 表已在）。

- CREATED：固定 `dev` 基线 OID、候选 result commit、revision 与 execution，并确认该 revision+commit 的 Task 验证为 `PASSED`；DEV_REF_MISSING / DEV_REF_CHECKED_OUT / TASK_VERIFICATION_NOT_PASSED 在写入任何 Git 副作用前拒绝。
- PREPARING：在 Runtime 数据目录的 detached integration worktree 中合并固定候选；能 ff 就 `--ff-only`，否则 `--no-ff`（第一父为固定基线，候选必须是其后代）；冲突→CONFLICTED，其他错误→FAILED。合并产生的提交写入 `merged_commit`，此时 `dev` 仍未被触及。
- VERIFYING：在 `merged_commit` 的 detached 副本上运行独立集成验证（独立实体 `integration_verification_runs`，绑定 candidate/merged commit/固定 dev 基线/policy digest/main commit 与 Task 验证 ID）；失败→FAILED。
- INTEGRATING_DEV：已核验集成验证 PASSED 后记录，随后以 `merged_commit` 与记录基线作 CAS 更新 `dev`。该状态存在的原因是：崩溃可能发生在 ref 写入前后，只有拿记录的 `merged_commit` 与 ref 实际值对比才能判定。
- INTEGRATED：ref 已更新才写入 `integrated_commit`，此时才 `EXECUTED → SUCCEEDED`。成功后才尝试 `git worktree remove`（不加 force）。
- 恢复：未完成集成验证→`ERROR(RUNTIME_RESTARTED)` 并保留副本；`CREATED/PREPARING/VERIFYING`→`RECOVERY_REQUIRED`（明确 dev 未被推进）；`INTEGRATING_DEV`→ref 等于 `merged_commit` 则核验后补记 INTEGRATED（不二次写 ref），否则 `RECOVERY_REQUIRED/DEV_REF_OBSERVED` 并写明观察值。`RECOVERY_REQUIRED` 阻止新尝试直到人工处理；不自动部分集成。

未实现（不得声称）：IntegrationBatch 的批级 `STALE` 判定、批级 `CANCELLED`、多成员批次、任务集合级集成。

StableBranchPromotion：`CREATED → VERIFYING → AWAITING_APPROVAL → PROMOTING → RESTARTING → SUCCEEDED`。

- 固定 expected dev SHA、expected main SHA 与独立验证证据；验证失败→FAILED。
- **提升前的全量证据是一等对象**（ADR-0038/ADR-0039，schema v25 的 `dev_full_suite_evidence`）：`promotion full-suite run <project-id> --dev-commit <full-sha>` 在一个 detached 副本里对**精确候选 SHA** 跑项目 `main` ref 上的固定策略，由 Runtime 自己观测结果（客户端不能提交证据），并把证据三重绑定在候选 commit、该 ref 的策略 digest、该 commit 的 lockfile digest 上。`prepare`/`approve`/`promote` 都要求**正是这个 SHA** 的一次 `PASSED` 运行且三个绑定均未变；main 上的策略被改、候选内的 lockfile 变了、或出现更新的失败运行，都会使证据 `STALE` 并以 `DEV_FULL_SUITE_EVIDENCE_STALE` 拒绝（退出码 1）。
- AWAITING_APPROVAL（仅 STRICT）：用户批准精确 dev/main/verification 三元组后→PROMOTING；dev、main 或证据变化→STALE。FULL 下固定三元组后直接进入 PROMOTING，不停留此状态。
- PROMOTING：核对批准与 Git 工作区安全后执行 dev→main；main 更新成功→RESTARTING。
- RESTARTING：在 main 工作树执行 CLI stop，再执行 status 拉起并检查 Runtime；成功响应→SUCCEEDED。失败→RECOVERY_REQUIRED 并报告，不擅自回滚。
- FULL 下无显式门禁；STRICT 下批准是唯一显式门禁。重启都是提升后的自动后置步骤，不要求第二次确认。

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
| v25 | `targeted_test_plans`、`dev_full_suite_evidence`（append-only）、`verification_runs.policy_source/plan_*`、`stable_promotions.full_suite_*` | 见 §4：提升前的全量证据是绑定三元组的一等对象，未完成的运行写不成终态 |
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
