# CLI 参考 · task 生命周期

> **适用版本** `dev@06bcf97` + 本格分支 `Loyage/task_auto`（2026-09-17） · **schema** v35 · **最后校对** 2026-09-17
> 版本会前进：`dev@06bcf97` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../../tasks/README.md) 的最新 FOUNDATION 记录为准。
> 拆分说明（ADR-0063）：本文件是 [`cli-reference.md`](../cli-reference.md) 按功能拆出的九篇之一，
> **内容自 `cli-reference.md` 搬移，除下面列出的几节外一句未改写**。
> §4 的 `task create` 一节由本分支按 **ADR-0065** 重写：三个必填字段（`--title`/`--name`/任务详情），
> `--constraint` 与 `--kind` 已删除（传入即未知 flag，退出码 2）。
> 本文件覆盖 §4；章节号沿用拆分前的编号，因此可能不连续。正文里提到本文件没有的号（例如 §14、§17）时，到 [README.md](./README.md) 的索引表查它在哪一篇。
> §3 的 `project impact *` 与 §4 的 `task submit`/`task resume`/`--feature` 由 FOUNDATION-091 新增/改写（ADR-0059）；
> §4 的 `task purge` 一节由 FOUNDATION-090 新增（ADR-0058，其余 §4 内容沿用 FOUNDATION-070 的校对基线）；
> §4 的 `task list` / `task status` 由用户任务 `Loyage/simplize_task_ui`（2026-09-16）补上 `latestExecution` 投影字段的说明
> （只读字段，无新命令、无 flag、无退出码变化）。
> §3 的 `project inspect`/`project trust` 段、§1 `open` 的失败码、§4 的 `task run` 与 `task depends` 两节由 FOUNDATION-093 第三轮同步（ADR-0060 修订：managed 项目的常态路径不再出现 `DEV_REPO_REQUIRED`）；其余段落沿用 FOUNDATION-091 的校对基线。
> §4 `task purge` 的 `RECOVERY_REQUIRED` 行为由用户任务 `task/930f5325` 修订（ADR-0058 D02 修订，2026-09-16）：purge 先按观察对账，只有证明 provider 已退出才继续删除。
> §4 `task purge` 新增 `--force` 与其代价一节由 `lane/purge-force` 同步（ADR-0058 D09，2026-09-16）：`--force` 是同一条命令的放宽（不是第二道确认），先终止记录过的 provider 身份，再越过 D02/D06/D05 三类拒绝；跳过了什么写在 `forced` 与 stderr 里。

## 4. `task`：生命周期

### `task create <project-id> <任务详情…> --title <显示标题> --name <命名标题> [--feature <module-id>]…`

原子创建：原始意图 + 首 revision + 事实事件 + 幂等回执在同一事务。

三个字段**都必须给出**（ADR-0065 D01）；缺任何一个、或值不合法都是用法错误（退出码 2）：

| 字段 | 形状 | 用途 |
|---|---|---|
| `<任务详情…>`（位置参数） | 非空文本，多词原样拼接 | revision 正文，Agent 提示词的主体 |
| `--title <显示标题>` | 非空、单行、≤ 200 字符 | 任务列表与任务详情渲染的一句话摘要 |
| `--name <命名标题>` | `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`，≤ 50 字符 | 分支与 worktree 目录名：`task/<编号>-<name>` |

两个标题是 **Task 级**字段：它们不是 revision 事实，创建后没有命令可以修改（要改标题就新建任务）。
`--title` 里的换行与超长、`--name` 里的大写/空格/连续短横线/首字符非字母都会在客户端与契约两层被拒。
任务创建于命名标题落地之前时 `namingTitle` 为 `null`，它的分支与目录仍是内部 ID（迁移不改名）。

**已删除的 flag**：`--constraint` 与 `--kind`（ADR-0065 D04）。约束功能与任务类型都不再存在，所以它们是未知 flag（退出码 2），
不会静默忽略；旧脚本需要改写，过去写成约束的限制现在写进任务详情即可。

命令面**总是**带一个随机 `commandId`，因此重放同一命令不会产生第二个 Task（幂等回执）。

### `task list <project-id> [--all]`

默认隐藏归档；`--all` 含归档。其他参数是用法错误。

每行除 Task 本身外还带一个 **`latestExecution`**：这个 Task 的最新一次 Execution 尝试加上它的 Agent Session
记录到的结局；`null` 表示这个 Task **从未启动过**（不是「未知」）：
`{ executionId, attemptNumber, state, resourceHeld, sessionState, completionOutcome }`。

- `completionOutcome` 是 `SUCCESS` / `FAILURE` / `null`；**`null` 读作「没有记录到结局」**，不是失败也不是成功——
  会话断开时 `exit_json` 里只有断开原因，并没有 outcome。
- 这是一个**读取投影**：只重述已经存在的列（含 `exit_json` 里的 completion），不新增语义、不参与任何判定。
- 它存在的理由是不必为了知道「Agent 是否已经退出」而逐行再读一次 `task status`：工作台列表行用它区分
  「Agent 正在跑」与「Agent 已退出待提交成果」（见 [ui.md](../ui.md) §2.2）。`task status` 返回的 `task` 是同一个投影。

### `task submit <project-id> <task-id> <expected-version>`

用 expected version 把 `DRAFT` 转 `READY`，并**在同一命令里**核对依赖 + 跑一次调度 pass。
返回里除提交结果外还有 `state` / `version` / `dependencyState` 与 `schedule`。
ADR-0059 之后**未声明功能的 Task 会在容量允许时就在这个命令里被启动**（`schedule.started` 非空）；
想让它等，就声明一个已被别的未完成任务声明的功能（`--feature`），或用已满的容量。
版本不符 → 乐观冲突拒绝（`VERSION_CONFLICT` / `CONCURRENT_MODIFICATION`）。

### `task run <project-id> <task-id> <expected-version> [--adapter <pi|codex|claude>] [--base-ref <refs/heads/…>] [--allow-unknown] [--json]`

显式启动请求，走与自动调度**同一个门禁**。`--adapter` 默认 `pi`。

`--base-ref <refs/heads/…>` 显式指定**新 workspace** 的基线（ADR-0060）：本地的分支名，在有 dev clone 的项目里从那个 clone 读，在 managed 项目里从项目文件夹读。省略时用项目默认（dev clone 的 `dev`，或项目文件夹**当前检出的分支**）。**已有 workspace 的 Task 保持已记录的基线**，此时给这个 flag 会被拒为 `TASK_BASE_REF_ALREADY_FIXED`（不是静默忽略）；自动调度从不选基线。

**换 `--adapter` 是新建 Execution，不是在同一个 Execution 里换 Agent。**

`--allow-unknown` 是 UNKNOWN 判定的**显式单次放行**（ADR-0030 D05）：放宽门禁，**不新增确认**，写入审计台账。
ADR-0059 之后当前规则**不再产生 `UNKNOWN`**，所以这条路日常不可达；`CONFLICTING` 永远不放行。

| 退出码 | 条件 |
|---|---|
| `0` | `outcome: STARTED` |
| `3` | `outcome: WAIT`——冲突等待或容量等待；stderr 打印 `[scheduler] CONFLICT|CAPACITY wait: <code> — <detail>` |
| `1` | `outcome: REFUSED`——依赖未满足、状态不可启动、revision 过期等 |

managed 项目（没有 dev clone）同样可以 submit/run/depends 判定/result commit/verify：这些操作按它自己的
基线（项目文件夹当前检出的分支）与归属（项目文件夹）工作，**不会**因缺少长期 `dev` 分支被拒绝（ADR-0060 第三轮修订）。

相关稳定码：`TASK_NOT_STARTABLE`、`TASK_ARCHIVED`、`CONFLICT_WAIT`、`CAPACITY_WAIT`、
`CAPACITY_GLOBAL_LIMIT_REACHED`（唯一的 Runtime 全局上限已满）、`SCHEDULER_DRAINING`、
`DEPENDENCIES_UNMET`、`CONCURRENT_MODIFICATION`、`UNKNOWN_ADAPTER`、`TASK_NOT_FOUND`；基线相关：
`TASK_BASE_REF_ALREADY_FIXED`、`TASK_BASE_REF_NOT_A_BRANCH`（给的不是本地分支）、`TASK_BASE_REF_MISSING`
（该分支不存在）、`TASK_BASE_REF_UNRESOLVED`（managed 项目文件夹处于 detached HEAD）。
`CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` 是**历史码**（ADR-0061 删除了 Adapter 级上限）：历史事件与历史命令结果
仍按原名可读，但新实现不再产生它。

### `task recover <project-id> <task-id> <expected-version> [--reason <text>] [--json]`

`RECOVERY_REQUIRED` 的**对账**（ADR-0055）：`docs/architecture/state-machines.md` 承诺的那一步，在它之前**没有命令面实现**——
`task cancel`/`retry`/`resume` 与 `task operation cancel` 都以 `RECONCILE_REQUIRED` 拒绝，`reclaim` 因 Task 属活跃集合而拒绝，
`scheduler reservations reconcile` 只管预留行，启动收敛查询也排除 `DISCONNECTED`/`RECOVERY_REQUIRED`。

它**只读事实**：记录的 provider 身份（按真实进程表 + start token 核对）、记录的后代进程快照、记录的 workspace 路径是否还在磁盘。

| 观测 | 结果 | 退出码 |
|---|---|---|
| provider 仍以记录的 start token 存活 | 拒绝 `RECOVERY_PROVIDER_ALIVE`，**保持占用** | `1` |
| provider 已消失但**记录过的**后代仍存活 | 拒绝 `RECOVERY_DESCENDANTS_ALIVE`，保持占用 | `1` |
| 观测无法完成（进程表/start token 读不到） | 拒绝 `RECOVERY_OWNERSHIP_UNVERIFIABLE`，保持占用 | `1` |
| Session 与 incarnation 都没记录可用身份 | 拒绝 `RECOVERY_PROCESS_IDENTITY_MISSING`，保持占用 | `1` |
| provider 已消失 | **收口**：`Execution → FAILED`（`resource_held=0`）、`Session → EXITED`、workspace `→ RETAINED`、`Task → FAILED` | `0` |
| Task 已离开 `RECOVERY_REQUIRED` 且 Execution 是终态 | `ALREADY_RECONCILED`（**只读**，不写任何行） | `0` |
| Task 不是 `RECOVERY_REQUIRED` 而 Execution 仍非终态 | 拒绝 `TASK_NOT_IN_RECOVERY` | `1` |
| `expected-version` 不符 | `CONCURRENT_MODIFICATION` | `1` |

**它绝不做的事**：不发信号、不杀进程、不删或移动工作树、不删 Task 分支、不改写 `exit_json`、不动 operations 行，
也**不声称工作树静止**（`quiescenceProven: false`、`signalsSent: 0` 是记录里的常量）。后代快照当时没记录时，结论里写
`descendantRecord: "MISSING"`（孤儿写者无法被归属），收口目标 `FAILED` 不 resume、不集成，所以不需要更强的“静止”事实。

收口后：`task retry` 可以重新排这个 Task，`task cancel` 可以作废它（`FAILED → CANCELLED` 是既有迁移），
workspace 变成 `RETAINED` 后 `reclaim` 才能考虑它。`--reason <text>` 是你自己的陈述，**原文进审计，不参与判定**。
同一 `commandId` 重放走到自己的回执（与 `promotion prepare` 同一规则）；同一 command id 配不同 payload 是 `COMMAND_CONFLICT`。

### `task pause <project-id> <task-id> <expected-version>`

协作停止：先 `PAUSING`，确认 provider 进程退出后才 `PAUSED`；workspace 与会话证据保留。
如果停止**无法被证明**，结果里 `stop: "UNCERTAIN"`，**退出码 1**。

### `task resume <project-id> <task-id> <expected-version> [--adapter <…>] [--allow-unknown]`

恢复是「继续**同一条** provider conversation」，所以 adapter 是请求的一部分；`--adapter` 默认 `pi`。
它同时是**启动路径**，因此走与 `task run` 相同的冲突门禁：与某个**未完成且声明了同一功能**的 Task 冲突时保持 paused；
其他情形默认允许（ADR-0059 之后当前规则不再产生 `UNKNOWN`，`--allow-unknown` 这条路日常不可达）。等待时退出码 `3`。

> 恢复 ≠ 重试：重试是重新入队一个 `FAILED` Task 然后新建 Execution。

### `task retry <project-id> <task-id> <expected-version> [--adapter <…>] [--json]`

只对 `FAILED` 生效，且**没有任何自动行为**：只有这条命令会重新入队。
不带 `--adapter` 时复用**这个 Task 上一次运行的 Adapter**。

结果包含两部分：重试本身记录的审计事实（`retry`）和随后那**一次**启动请求的调度答案（`start`）。

| 退出码 | 条件 |
|---|---|
| `0` | 新 Execution 已启动 |
| `3` | 重试已记录、Task 已重新入队但**在等待**（`start.outcome = WAIT`；理由码在 `--json` 与 stderr） |
| `1` | 重试或启动被拒绝 |

拒绝码（领域层）：`TASK_NOT_FAILED`、`TASK_CANCELLED`、`TASK_STILL_RUNNING`、`TASK_PAUSED`、
`RECONCILE_REQUIRED`、`TASK_ARCHIVED`、`WORKSPACE_RECLAIMED`（后者会走「从 Task 分支重建 worktree」的路径）。

### `task cancel` / `task archive` / `task unarchive <project-id> <task-id> <expected-version>`

- `cancel` 是**终态**，不自动重开；结果 `stop: "UNCERTAIN"` 时退出码 `1`。
- `archive` 是**软删除**：只写 `archived_at`，不删行、不回收 worktree/branch。
- `unarchive` 取消归档。

三者都需要 expected version，多余参数是用法错误。

### `--feature <module-id>`（`task create` 与 `task revision create`，可重复）

冲突判定（ADR-0059）只比较**声明**：两个未完成任务声明同一功能才算冲突，所以「我想改进哪个功能」要写在 Task 上。

- id 必须是项目 **main ref** 的 `.codeestra/impact.json` 里 `modules[].id` 之一；Runtime 在写入前校验，未声明 → `UNKNOWN_FEATURE`，映射读不到 → `IMPACT_POLICY_ABSENT`，映射坏掉 → `INVALID_IMPACT_POLICY`（都退出码 1，且什么都没写）。**不要求**该映射已被 `project trust` 确认。
- `task create --feature a --feature b`：新任务声明这两个功能。
- `task revision create ... --feature <id>`：设置**新 revision** 的声明，整体替换；**完全省略 `--feature` 则继承**当前 revision 的声明（改规格不会静默把任务踢出功能规则）；只改声明本身也是合法 revision。
- 未声明任何功能的任务**永远不参与功能冲突**，因此提交后会在容量允许时立即开始——这是与 ADR-0031 时代相反的默认行为。
- `task status` / `task list` 的 JSON 里，`currentRevision.features` 就是声明的内容。

### `task purge <project-id> <task-id> <expected-version> --yes [--force] [--reason <text>] [--json]`

**本命令不可撤销。** 它删掉这个任务**拥有的一切**：全部 revision、Execution、AgentSession、终端/guidance/Attention 记录、验证运行、
impact 快照与它的配对判定、槽位预留、回收记录、依赖边、`intents` 的 target，以及**它自己的 worktree、验证副本与 `task/<id>` 分支**，
最后删除任务行本身，并在同一个事务里写一条 `TaskPurged` 事件。

| 情形 | 行为 / 退出码 |
|---|---|
| 成功 | `0`；stdout 是结果 JSON（`--json` 只用于声明意图），含逐表 `rowsDeleted`、`dependencyEdgesRemoved`、`plan`、`branchFacts`（每个被删分支的 `tipCommit`） |
| 缺 `--yes` | `2`，**不发送任何请求**，什么都不变 |
| 任务成果已进 `dev` | `1`，`TASK_INTEGRATED_INTO_DEV`（见下） |
| 任务参与过稳定提升 | `1`，`TASK_IN_STABLE_PROMOTION` |
| 非终态任务 | 先走一次协作停止：能确认 provider 退出才继续删除；无法确认则 `1` / `RECONCILE_REQUIRED`，**什么都不删** |
| `RECOVERY_REQUIRED` 任务 | 先按观察对账（与 `task recover` 同一判定）：provider 确已不在才继续删除，结果 `stop.stop: "RECOVERED"`、最终状态 `FAILED`；provider 仍存活 / 后代仍存活 / 身份缺失 / 无法核验则 `1` / `RECONCILE_REQUIRED`，**什么都不删** |
| 记录的 worktree/验证副本/分支无法证明属于它 | `1` / `PURGE_RESOURCE_NOT_OWNED`，**一行都不删** |
| 带 `--force` 时上述三类拒绝（`TASK_INTEGRATED_INTO_DEV` / `TASK_IN_STABLE_PROMOTION` / `RECONCILE_REQUIRED` / `PURGE_RESOURCE_NOT_OWNED`） | **不再拒绝**：先尝试终止记录过的 provider 进程树，然后照删；跳过了什么写在 `forced`（stdout）与 stderr 里 |

固定事实（不只是约定）：

- **`--yes` 是整个产品唯一一次显式确认，且不在任何常态路径上**：接入、工具、成果 commit、验证策略、调度、提升、`cancel`/`archive`
  都不需要它。它不是审批层：Runtime 不再叠第二次询问，`confirmed` 是调用者自己的声明。
- **`SUCCEEDED` 任务实际上不可 purge**：按定义它的成果已进 `dev`（ADR-0053），因此会被 `TASK_INTEGRATED_INTO_DEV` 拒绝，
  请改用 `task archive`（它隐藏任务但不销毁那个 commit 的来源记录）。
- **删除是幂等的**：同一 `commandId` 重放会读到收据（`replayed: true`），不会发生第二次删除；同一 ID 换 payload 报 `COMMAND_CONFLICT`。
- **`RECOVERY_REQUIRED` 不需要先手动 `task recover`**：`task purge` 自己完成那次观察对账（`TaskRecoveryReconciled` 事件先于 `TaskPurged`）。安全性没有放宽——只有可证明已经退出的 provider 才让删除继续，其余情况 `RECONCILE_REQUIRED` 且一行不删。
- **`--force` 是同一条命令的更宽声明，不是第二道确认**（ADR-0058 D09）：它不加确认、不加等待、不需要在场的人，`--yes` 依旧是唯一一次确认。它做的事，按顺序：
  1. **终止**：对**任务记录过的身份**（pid + start token）发信号——先 `SIGTERM`，有界等待，再对仍存活的发 `SIGKILL`，再有界等待；**记录里没有 start token 的 pid 一个信号都不发**（pid 会被复用，杀错进程比留下孤儿更糟），**不按进程组杀、不扫描「看起来像 provider」的进程**。两轮后仍存活就如实报为 `survivors`，**不声称静止**。
  2. **删掉它本来会拒绝的行**：`dev`/`main` 里 commit 的来源记录（`integration_batch_items` / `integration_verification_runs` / `stable_promotion_members`）会一起删；当该任务就是那条集成验证行记录的任务时，**引用了它的 `stable_promotions` 记录本身、连同这条 promotion 的全部成员行（可能含其他任务）**也必须一起删——这是外键决定的，逐表条数在 `rowsDeleted` 里。
  3. **只越过「活占」类门禁**：`ACTIVE_EXECUTION` / `ACTIVE_RESERVATION` / `ACTIVE_VERIFICATION` / `TASK_NOT_TERMINAL` 不再拦住删除（它们保护的那次运行正是本命令刚退役的）。**归属校验从不越过**：symlink 逃逸、路径不在 owned root 内、注册/HEAD/分支与记录不符、未注册目录 —— 这些资源**留在磁盘上**，逐项写在 `forced.bypassed` 里，绝不会 `rm -rf`。注意它们的 `workspaces`/`reclamation_records` 行已随任务删除，于是磁盘上留下的是「未注册目录」，需要时用 `reclaim --unregistered` 收拾。
  4. **如实记账**：结果里的 `forced`（`null` 表示没用 `--force`）含 `bypassed[]`（每条被跳过的拒绝码与原文理由）与 `termination`（是否尝试、发了几个信号、是否终止、幸存与不可归属的 pid、原文说明），同一份事实写进 `TaskPurged` 事件；CLI 另外把它打到 **stderr**（stdout 仍是那一个可解析的文档）。被强制删除的 `RECOVERY_REQUIRED` 任务，`stop.stop` 是 `"FORCED"`（不是 `RECOVERED`：它没有被证明静止）。
  5. **它管不到的东西**：集成工作树/集成验证副本（属于批次，不属于任务）不由 purge 回收；`NOT_FOUND` / `CONCURRENT_MODIFICATION` / 缺 `--yes` 仍然失败；**退出码 3 仍不使用**。
- **`domain_events`、`command_receipts`、`operations`、`intents` 与项目级知识快照不删**：所以任务被删后，事件流里仍能读到它的历史
  以及最后那条 `TaskPurged`。**除逐表行数与分支 tip 之外不可恢复**（无墓碑、无备份）。
- **会连带删掉指向它的依赖边**（条数在 `dependencyEdgesRemoved` 里），下游任务会因此重新判定；也会删掉**另一方**与它配对的那条 impact 判定。
- 本命令**不使用退出码 3**。

### `task status <project-id> <task-id> [--json]`

- 输出是 JSON（`--json` 是**默认**，可用脚本声明意图）；任何其他 flag 是用法错误。
- 每个 Execution 的 **Agent 完成注记**会以 `[note] <execution> (<session>) ended <outcome> with <code>: <message>`
  写到 **stderr**。例如 `PROSE_QUESTION_NO_TOOL_USE` 标注一次本来无法解释的 `SUCCESS`。
- Task 处于 `WAITING_FOR_USER` 时，会额外查一次 `attention.list`，把散文提问等待以 `[waiting] …` 写到 stderr，
  并附上 Agent 问的原文与退出方式。

---

