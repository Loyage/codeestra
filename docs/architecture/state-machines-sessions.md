# 状态机：AgentSession、接管与修订投递

> 层级：L2 按需参考 · 体量 ≈ 8k 字符 · **何时读**：改 provider 会话/incarnation/单 writer lease、RPC↔TUI 接管、STRICT 权限请求、Session Guidance 或修订投递 FSM · 权威来源：`apps/runtime/src/session-*.ts`、`revision-delivery-service.ts` 与 `packages/storage/src/database.ts` 的 CHECK/CAS。DDL 见 [`sqlite-schema-sessions.md`](./sqlite-schema-sessions.md)；Task/Execution 状态见 [`state-machines.md`](./state-machines.md)。
>
> 章节号 §3、§3.1、§3.2、§7 沿用拆分前的编号（代码注释与 ADR 仍按旧号引用）。

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
