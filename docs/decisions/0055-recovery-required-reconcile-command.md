# ADR-0055 — `task recover`：`RECOVERY_REQUIRED` 的对账命令面与「占用者不可观测」的可见性

状态：**Accepted**（协调者在 FOUNDATION-086 开工时裁决本 ADR 号；**无 schema 变更、不占迁移号、零新增权限门禁与确认**）。

关联文档：`docs/architecture/state-machines.md`（Task / Execution / AgentSession 三张状态机的 `RECOVERY_REQUIRED` 行）、
`docs/architecture/scheduler.md` §1（活跃集合）、§2（占用的移交）、`docs/architecture/conflict-analyzer.md` §6.4、
`docs/architecture/event-model.md` §2（事件目录，本格新增一个事件名）、
`docs/guides/cli-reference.md`（`task recover` 与稳定码）、`docs/guides/troubleshooting.md`（症状与对策）、
ADR-0030（调度门禁）、ADR-0031/0033（影响快照与调度引擎）、ADR-0042（工作树重建）、ADR-0050（文档同步）。

## 背景

本机稳定 Runtime 上出现了一个**永久阻塞**的真实故障，不是推断：

- Task **#7**（`PAUSED`）与 Task **#8**（`RECOVERY_REQUIRED`）的 worktree 目录在 2026-09-14 02:52 被**外部 worktree
  管理器（Orca）**移进 `~/.local/state/codeestra/worktrees/<project>/.orca-worktree-trash/` 并随后删除（同一工具在
  `~/Documents/codeestra-wt/.orca-worktree-trash` 留下同样痕迹）；Task 分支也一并消失。数据库里 `workspaces` 行仍是
  `RETAINED` / `RECOVERY_REQUIRED`，`executions.resource_held = 1`。
- 因此影响分析器**永远观测不到**这两侧的变更集（活跃侧 `MISSING_IMPACT_SNAPSHOT`），而候选侧因为 `main` ref 上
  没有 `.codeestra/impact.json` 是 `POLICY_ABSENT`（`INCOMPLETE_IMPACT`）。两者叠加 ⇒ 每次判定 `UNKNOWN` ⇒
  调度器按 §1 等待；项目里新任务只能靠 `--allow-unknown` 单次放行才能跑。
- `docs/architecture/state-machines.md:32` 对 `RECOVERY_REQUIRED` 写的是「**reconcile**：依据真实事实回到已证实状态；
  必须审计，不能直接释放资源」。**这一步在命令面上不存在**：`task cancel` / `task retry` / `task resume` 全部以
  `RECONCILE_REQUIRED` 拒绝（"a second blind stop is not proven safe"）、`task operation cancel` 拒绝、
  `reclaim` 以 `TASK_NOT_TERMINAL` / `ACTIVE_EXECUTION` 拒绝、`scheduler reservations reconcile` 只管预留行
  （该 Task 根本没有预留行），启动收敛查询 `listStaleAgentSessions` 明确排除 `DISCONNECTED` / `RECOVERY_REQUIRED`。
  于是「需要人工对账」这件事没有任何可执行的落点。
- 事实面已经很清楚：#8 的 provider（pid 71909）与托起它的旧 Runtime（pid 65545）**都已不存在**，
  `session_incarnations` 甚至没有一行；#8 的 Session 行只留下 `exit_json` 的
  `{"reason":"Pi RPC stdout was not a valid LF-delimited JSON stream"}` 与 Session 级 `process_identity_json`
  （pid + start token + argvHash）。也就是说「无法证明」是**永久**的，不是暂时的。
- 次要但同类：`ScheduleService.#activeTaskRefs` 只按数据库行把 `PAUSED` 任务算进活跃集，不核对磁盘；用户界面上只
  看到「需要人工检查」，看不到「谁占着、为什么不可观测、用哪条命令收口」。

## 选项

### A. 对账命令的形状

1. **`task recover <project> <task> <expected-version> [--reason <text>] [--json]`**（选择）：只做状态机承诺的那一步。
   只读事实，能证明 provider 已消失就收口为 `FAILED`；想作废再用既有 `task cancel`，想继续再用既有 `task retry`。
2. `task recover --to FAILED|CANCELLED`：一条命令到位，但把「对账」与「终止」两个语义压在同一命令上，
   ADR 要同时覆盖两套状态迁移与两组稳定码。
3. `task recover` + `task cancel --recovery --confirm`：把 `cancel` 的语义扩张成「有时需要先有观测记录」，
   未核验时容易被误用。

选择 1：单一语义、复用已有终态路径、**不给活跃进程发信号**、不新增终止语义。

### B. provider 仍存活或无法核验时的行为

1. **拒绝并保持占用**（选择）：稳定码 + 如实打印观测，退出码 `1`。
2. 允许收口（「用户说了算」）：会让「无法证明静止」变成一次命令就能抹掉的事实。
3. 自动视为已消失：与 `scheduler reservations reconcile` 的姿态相反（那里也是「仍存活 → 保持占用」「无法核验 →
   `RECOVERY_REQUIRED`，保持占用、不自动放行」）。

选择 1，与既有 reconcile 原语完全一致：**不发信号、不杀进程、不删资源、不声称静止**。

### C. 观测事实写在哪里

1. **只用既有 append-only 台账：同一事务写状态迁移事件 + 一个登记进事件目录的新事件 `TaskRecoveryReconciled`
   （观测证据的载体），幂等靠命令回执**（选择）。
2. 新增一张 `*_reconciliations` 表：需要占一个迁移号，并且要在一个「永久阻塞」的故障上动 schema。
3. 复用 `agent_session_startup_reconciliations`：它的 `observation` CHECK 是启动收敛专用取值，且语义是「启动时收敛
   一个仍在声称活着的投影」，与本命令不同。

选择 1。理由：`docs/architecture/event-model.md` §2 的规则是「已实现名永不重命名、新事件采用登记过的名字」，
`TaskRetryRequested` 已有「实现先行名随后登记为长期名」的先例；而拒绝路径**不写任何行**（它没有状态变化，
把它写成审计事实只会让轮询产生噪声）——这条与「观测即事实」并不矛盾：**能改变状态的那次对账**才是事实。

### D. 记录里没有后代进程表时是否允许收口

1. **允许，但把事实写明**：`descendantRecord: "MISSING"`、`quiescenceProven: false`（选择）。
2. 拒绝：`#8` 正是这种情形（Session 级身份存在、incarnation 行缺失），拒签等于把「永久阻塞」固化成设计。

选择 1。收口目标是 `FAILED`——它**不 resume 会话、不集成任何东西、不回收工作树**，所以不需要「工作树已静止」这个
更强的事实；需要它的地方（`task retry` 复用/重建工作树、`reclaim` 回收目录）各自还有独立的归属核验（ADR-0042 /
ADR-0037），不由本命令代劳。

## 决定

### D01 命令面

```
bun run codeestra task recover <project-id> <task-id> <expected-version> [--reason <text>] [--json]
```

- 只读取事实，顺序固定：
  1. Task 必须处于 `RECOVERY_REQUIRED`（否则 `TASK_NOT_IN_RECOVERY`，退出码 `1`）；
     Task 已不是该状态但 Execution/Session 已是终态 ⇒ `ALREADY_RECONCILED`（退出码 `0`，只读）。
  2. `expectedVersion` 与 Task 版本不符 ⇒ `CONCURRENT_MODIFICATION`（退出码 `1`，不写任何行）。
  3. **进程归属观测**（读真实进程表 + 记录里的 start token；`ps` 不可用 ⇒ `UNVERIFIABLE`）：
     - 记录里没有可用的 provider 身份（Session 级与 incarnation 级都没有）⇒ `RECOVERY_PROCESS_IDENTITY_MISSING`；
     - provider 仍以记录的 start token 存活 ⇒ `RECOVERY_PROVIDER_ALIVE`；
     - provider 已消失但**记录过的**后代仍存活 ⇒ `RECOVERY_DESCENDANTS_ALIVE`；
     - 观测无法完成 ⇒ `RECOVERY_OWNERSHIP_UNVERIFIABLE`。
     以上四种一律**拒绝并保持占用**（退出码 `1`、状态零变化），观测内容打在 stdout/`--json` 与 stderr 上。
  4. provider 已消失 ⇒ **收口**（见 D02）。
- `--reason <text>` 可选，写进审计（用户自己的陈述），不参与判定。
- 退出码：`0` 已收口 / 已是对账过的终态；`1` 拒绝（含上面四个码与用法以外的错误）；`2` 用法错误。

### D02 收口写入（一个 `executeCommand` 事务，幂等靠命令回执）

`executions`：`RECOVERY_REQUIRED → FAILED`、`resource_held = 0`、`ended_at = now`、
`error_json = {code:'RECOVERY_RECONCILED', message: detail, quiescenceProven:false}`。
`agent_sessions`：`→ EXITED`、`last_observed_at = now`（**不改写 `exit_json`**：那是当时的事实）。
`workspaces`：`RECOVERY_REQUIRED → RETAINED`（**不删除、不回收、不改路径**）。
`tasks`：`RECOVERY_REQUIRED → FAILED`、版本 +1。
事件：`TaskRecoveryReconciled`（观测证据）、`ExecutionStateChanged`、`AgentSessionStateChanged`、`TaskStateChanged`，
与被改写的行在**同一事务**内提交。`operations` 行不动。

### D03 观测证据的字段（`TaskRecoveryReconciled.payload` 与命令输出同源）

`{ taskId, executionId, sessionId, workspaceId, workspacePath, providerPid, processState
('STOPPED'|'ALIVE'|'DESCENDANTS_ALIVE'|'UNVERIFIABLE'|'IDENTITY_MISSING'), descendantRecord
('RECORDED'|'MISSING'), descendantCount, workspacePresent (boolean), quiescenceProven:false, signalsSent:0,
actor, reason|null, evidenceRef }`。

### D04 占用者可见性（RC4；JSON + stderr + 文档，不动 UI）

- `ScheduleAssessmentView` 增加 `occupiers: readonly { taskId, taskState, executionState, code, detail,
  workspacePath }[]`，`code ∈ { OBSERVABLE, WORKSPACE_MISSING, WORKSPACE_UNREADABLE, NO_WORKSPACE }`：
  「记录里有 workspace 路径但磁盘上不存在」= `WORKSPACE_MISSING`（`#8` 这一类），
  「路径存在但变更集读不出来」= `WORKSPACE_UNREADABLE`，「没有 workspace 行」= `NO_WORKSPACE`。
  `project impact explain` 的 `active[]` 同时带上同一个 `code`（同一份事实，一个实现）。
- CLI（`task schedule status/plan/explain`、`task run` 的等待路径）把不可观测的占用者打到 **stderr**
  （谁、状态、码、路径、收口命令）。**这不改任何判定**：`UNKNOWN` 仍然是 `UNKNOWN`。
- `docs/guides/troubleshooting.md` 增加症状一节，并明确写出「不要用外部 worktree 管理器清理
  `CODEESTRA_HOME/worktrees`：那些目录同时是本仓库的 git worktree，会被当成可回收对象移走」。

### D06 顺带修复的缺陷（同一格实测发现）

`packages/domain/src/impact-analysis.ts` 的 `subjectHits` 曾把 `subject.snapshot` 强转成 `ImpactSnapshot`
再交给 `subjectValidity`，于是**快照为 `null` 的主事者会让分析器抛 `TypeError`**（“无法解释”变成“崩掉”）。
真实触发面：`project impact explain` 对一个工作树已被移除（或从未存在）的 Task。修复是让 `subjectHits` 在
快照为 `null` 时返回空命中——判定仍然是调用方那一条 `MISSING_IMPACT_SNAPSHOT`（⇒ `UNKNOWN`），
不会因此变成 `SAFE`。定调用例：`packages/domain/test/impact-analysis.test.ts` 的
“is UNKNOWN, not a crash, when the candidate itself has no derivable snapshot”。

### D07 明确不做

- 不给任何进程发信号、不杀进程、不删/不移动工作树、不删 Task 分支。
- 不改 `impact_assessments`、不改分析器 reason code 集合（`occupiers[].code` 是调度侧诊断码，不是分析器码）。
- 不新增权限门禁、审批层或沙箱；FULL 下零确认，STRICT 下沿用既有命令确认规则（本命令没有额外确认）。
- 不改 `apps/ui/**`（UI 仍渲染既有投影；`occupiers` 对 UI 是新增可选字段，缺失即不显示）。
- 不解决「provider 仍存活」的那一格：那种情况下人去处理进程（本机无受控句柄），再重新 `task recover`。

## 后果

- **正**：`RECOVERY_REQUIRED` 第一次有了可执行、可审计、幂等的收口路径；「永久阻塞」不再是设计事实。
- **正**：不可观测的占用者变成结构化事实 + 可执行提示，用户不必再从 `MISSING_IMPACT_SNAPSHOT` 反推原因。
- **代价/残余风险**：`descendantRecord: MISSING` 时，被 reparent 的孤儿写者**无法被归属**；本命令如实记录
  `quiescenceProven:false` 并把它交给后续 `task retry` / `reclaim` 各自的归属核验，不声称静止。
- **代价**：本命令的**拒绝路径不写审计行**（无状态变化）；只有收口写台账。这是刻意的边界，写在 ADR 里而不是
  静默省略。

## 验证要求（FOUNDATION-086，定向测试）

1. `apps/runtime/test/cli-task-recover.test.ts`（新，`bun test`，真实临时 Git 仓库 + 真实数据库 + 注入的进程表观测）：
   - provider 已消失 ⇒ 退出码 `0`，Task/Execution `FAILED`、`resource_held=0`、workspace `RETAINED`、
     Session `EXITED`、`TaskRecoveryReconciled` 存在且 `quiescenceProven:false` / `signalsSent:0`；
   - provider 仍存活（注入存活进程表 + 匹配 start token）⇒ 退出码 `1`、码 `RECOVERY_PROVIDER_ALIVE`、**零行变化**；
   - 后代存活 ⇒ `RECOVERY_DESCENDANTS_ALIVE`；无身份 ⇒ `RECOVERY_PROCESS_IDENTITY_MISSING`；`ps` 失败 ⇒
     `RECOVERY_OWNERSHIP_UNVERIFIABLE`；
   - Task 不在 `RECOVERY_REQUIRED` ⇒ `TASK_NOT_IN_RECOVERY`；版本不符 ⇒ `CONCURRENT_MODIFICATION` 且零写入；
   - 同一 `commandId` 重放 ⇒ 不产生第二组事件（回执幂等）；
   - 收口后该项目的新候选不再命中 `MISSING_IMPACT_SNAPSHOT`（占用者已离开活跃集）；
   - `task schedule explain --json` 的 `occupiers` 在「记录有路径、磁盘无目录」时给出 `WORKSPACE_MISSING`。
2. `packages/contracts/test/request.test.ts`：`task.recover` 请求体的接受/拒绝边界（stub 用例）。
3. 开发分支只跑以上定向测试；`dev → main` 前的全量测试在精确 dev 候选 SHA 上另行执行（ADR-0038）。

## 状态
Accepted。实现与定向测试见 `docs/tasks/README.md` 的 FOUNDATION-086；本机现场的收口（`#7` 用既有 `task cancel`、
`#8` 用本命令）与稳定 Runtime 的重启按 ADR-0047/0048 的路径在提升后进行，交付记录如实写明走到了哪一步。
