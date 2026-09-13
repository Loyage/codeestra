# ADR-0016：Task 暂停 / 终止 / 归档

Status：Accepted（用户明确选择：暂停运行中的执行、CANCELLED 为终态、归档软删除并保留 worktree、CLI 与 Web UI 同批）

## Context

FOUNDATION-019 记录了一个已被真实场景证明的缺口：真实 Pi 运行失败后，Task 会永久停在 `RUNNING` + `resource_held=1`，`task result prepare` 返回 `NOTHING_TO_COMMIT`，用户只能停掉整个 Runtime 才能释放。NEXT 第 1 项就是 Task cancel。

用户本轮要求任务可以「暂停、终止、删除」。三项能力在现有规格中状态不同：

- `docs/architecture/state-machines.md` 已定义 Task 的 `PAUSING/PAUSED` 与 `CANCELLING/CANCELLED`，以及 Execution 的 `STOPPING → CANCELLED (USER_CANCEL)`，但没有任何 CLI/命令面实现。
- Pi 0.84.4 `pauseWithQuiescence = UNSUPPORTED`、`resumeAfterExit = SUPPORTED`（`docs/spikes/pi-0.84.4.md`）：没有原地 pause/resume 原语，只有 abort；但持久 conversation 可用 `--session <file>` 跨进程恢复。
- 「删除」在规格、ADR 与 schema 中完全不存在。`docs/architecture/sqlite-schema.md` 明确「默认不级联删除审计与成果记录」，`domain-model.md` 明确「删除/重建必须另有明确授权，不在取消流程中隐式清理」。因此删除是必须新决策的数据语义。

## Options

1. 暂停语义：暂停运行中的执行 / 仅暂停调度排队 / 两者都要 / 不做暂停。用户选择**暂停运行中的执行**。
2. CANCELLED 后能否重开：CANCELLED 为终态 / 允许 CANCELLED → READY 重试。用户选择**终态**。
3. 删除语义：归档软删除（保留 worktree）/ 归档 + 单独 purge / 仅硬删除 DRAFT / 硬删除任意非运行任务。用户选择**归档软删除并保留 worktree**。
4. 交付范围：CLI 先行 / CLI 与 Web UI 同批。用户选择**同批**。

## Decision

### D01：暂停 = 协作停止 + 可恢复的新 Execution

- `task pause <project-id> <task-id> <expected-version>`：仅 `RUNNING` / `WAITING_FOR_USER` 可暂停。
- 先持久化 `PAUSING`（Task）、`STOPPING`（Execution，`stop_reason='USER_PAUSE'`），再向 Adapter 请求协作停止。
- 只有 Adapter 确认自有 provider 进程已退出时才落 `PAUSED`（Execution `SUPERSEDED`、`resource_held=0`、workspace `RETAINED`）；无法确认静止时落 `RECOVERY_REQUIRED` 并保留占用，**不声称已暂停**。
- 不实现原地 pause（Pi 无该原语）。旧 Execution 终止，**不**复用为同一 Execution 的 `PAUSED→RUNNING`。

### D02：恢复 = PAUSED → READY → 新 Execution 复用 provider conversation

- `task resume <project-id> <task-id> <expected-version>`：仅 `PAUSED` 可恢复。
- Task `PAUSED → READY`，workspace `RETAINED → READY`（复用同一 owned worktree，不新建、不重新做 Git 副作用）。
- Runtime 立即以 `resume_from_execution_id` 关联暂停前的 Execution，并在新 Execution 启动时用 predecessor Session 的 `session_storage_ref` 以 `--session <file>` 复用 Pi conversation；启动消息是**有界的继续指令**，不重发完整 revision 规格（避免重复劳动）。
- 恢复的是持久 conversation，不是原 OS 进程：新 Session 有独立 identity，旧 Session 保持 `EXITED`，不得假装旧进程仍存活。
- 暂停不是修订：TaskRevision 不变，不写 revision，也不把暂停/恢复伪装成 revision 投递。

### D03：终止（cancel）是终态

- `task cancel <project-id> <task-id> <expected-version>`。
- 无活动 Execution 的状态（`DRAFT/BLOCKED/READY/EXECUTED/FAILED`）直接 `CANCELLED`。
- 有活动 Execution 的状态（`RUNNING/PAUSING/PAUSED/WAITING_FOR_USER`）先 `CANCELLING`，协作停止确认后 `CANCELLED`；无法确认静止时 `RECOVERY_REQUIRED` 并保留占用。
- `CANCELLED` 为终态，不自动重开；要重做必须新建 Task。旧 Task 的 revision、Execution、证据、事件全部保留可查。
- 取消流程**不**清理 workspace/branch，也**不**删除任何记录；回收是独立能力（见 D04）。

### D04：删除 = 归档软删除

- `task archive <project-id> <task-id> <expected-version>`：写入 `tasks.archived_at`，默认列表不再返回；`task unarchive` 恢复。
- 归档不删除任何行（Task / TaskRevision / Execution / AgentSession / Attention / VerificationRun / domain_event），不回收 worktree 或 branch，不改变 Task 生命周期状态。
- 有活动 Execution（`RUNNING/PAUSING/PAUSED/WAITING_FOR_USER/CANCELLING`）或 `RECOVERY_REQUIRED` 时拒绝归档，必须先 cancel；归档一个已归档的 Task 幂等返回。
- 本轮不提供物理删除或 purge。「归档 + 归属校验后回收 worktree/branch」作为独立高风险命令留待后续，届时另行决策，不在本轮隐式实现。
- `task status` 按 ID 仍可读取已归档任务；`task list` 默认排除，`--all` 包含。

### D05：CLI 命令面为权威，Web UI 只投影

- 五项能力全部有 CLI 子命令，支持 `--json` 输出与稳定退出码；Web UI 仅是同一 `versioned command` 面的按钮。
- FULL 下这些操作不新增任何确认；STRICT 也不新增确认（它们本来就是显式用户命令）。FULL 的零确认预算保持为 0。

## Consequences

- 用户可停止一个已经失败或不需要的 Task，并释放其 provider 进程；`resource_held=1` 的卡死形态有了正式出口。
- 暂停/恢复依赖 provider conversation resume，因此暂停前的工具执行现场不会继续；仅对话上下文延续。无法确认进程静止时系统进入 `RECOVERY_REQUIRED`，不会被报告成“已暂停/已取消”。
- 归档让列表默认只显示活跃任务，同时不销毁任何审计；代价是数据库长期保留全部历史（符合既有「不级联删除审计」原则）。
- 新增 `stop_reason='USER_PAUSE'`，需要重建 `executions` 表以放宽 CHECK；新增 `tasks.archived_at` 与 `executions.resume_from_execution_id`。

## Verification

只通过 CLI/命令面与临时仓库验证（ADR-0008），不使用桌面/键鼠自动化：

1. `task cancel` 对 `READY` 任务直接 `CANCELLED`；对 `RUNNING` 任务先 `CANCELLING`，确认 provider 退出后 `CANCELLED` 且 `resource_held=0`。
2. 无法确认 provider 退出时进入 `RECOVERY_REQUIRED` 且保留占用，不报告成功取消。
3. `task pause` 对 `RUNNING` 任务落 `PAUSED`，Execution `SUPERSEDED`、`stop_reason='USER_PAUSE'`；`task resume` 复用同一 workspace 并以 `--session` 启动新 Execution，`resume_from_execution_id` 指向旧 Execution。
4. `task archive` / `task unarchive` 只改 `archived_at`；默认 `task list` 不含已归档，`task list --all` 含；`task status` 仍可读；worktree 与 branch 保持不变。
5. 活动 Execution 或 `RECOVERY_REQUIRED` 的 Task 拒绝归档。
6. 迁移 v8→v9 后旧 `executions` 行保留，`foreign_key_check` 无违规；`stop_reason` 仍拒绝未列出的值。
7. Web UI 的三个按钮只发送同一命令，不新增业务语义。

## Related

- `docs/architecture/state-machines.md`
- `docs/architecture/agent-adapter-api.md`
- `docs/spikes/pi-0.84.4.md`
- `docs/architecture/sqlite-schema.md`
- `docs/architecture/domain-model.md`
- ADR-0001 / ADR-0002 / ADR-0008 / ADR-0011
- `docs/tasks/README.md` FOUNDATION-033
