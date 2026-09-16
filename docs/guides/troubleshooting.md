# 常见故障与稳定码表

> **适用版本** ADR-0067（2026-09-17） · **schema** v36 · **最后校对** 2026-09-17
> **本次修订**：删除已暂停 HTTP/UI 的现行排障步骤与稳定码，只保留 CLI/Unix socket 路径。
> 版本会前进：`dev@7425556` 只是本目录最后一次校对的基线；当前适用版本以
> **本次修订（ADR-0066 / schema v36）**：删除 dev clone、长期 `dev` 集成分支、`task integrate` / `task integration *` / `promotion *` 与 dev 构建通道；Task 基线只有一种（项目文件夹建 workspace 时当前检出的分支），
> 成果停在 `refs/heads/task/<task-id>`，合并由你自己完成。
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。
> 第 15 条（ADR-0065 的未验证项）由**本分支**新增；`task create` 的 `--constraint`/`--kind` 已删除，不再是稳定码来源。
> 权限模式的命令拼写由 FOUNDATION-098 同步为 `settings permission get|set`（ADR-0064：顶层 `permission` 已移除；§19 另新增 `settings list` 总览）。
> 「全局暂停」一节的稳定码由 FOUNDATION-097 新增（ADR-0061 D08/D09）；`task purge` 的拒绝码一节由 FOUNDATION-090 新增（ADR-0058）；冲突判定与 `--feature` 的拒绝码由
> FOUNDATION-091 新增/改写（ADR-0059）。
> **本次修订（ADR-0066 / schema v36）**：删除「报 `DEV_REPO_REQUIRED`」与「集成报 `DEV_CHECKOUT_*`」
> 两节、删除「稳定提升被拒」一节，并把删除过时的集成/提升码集中列在错误码一节。
> 「任务集成后 worktree 还在？」一节由 ADR-0062 新增（集成成功后的自动回收与失败现场）。
> 「任务一直不跑」与「调度 / 容量 / 槽位」两处的容量码由 **FOUNDATION-096** 同步（ADR-0061：只剩一个
> Runtime 全局上限，容量命令不带 project 参数；`CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` 成为历史码）。
> `RECONCILE_REQUIRED` 与 `task purge` 拒绝码一节里 `RECOVERY_REQUIRED` 的对账说明由用户任务 `task/930f5325` 同步（ADR-0058 D02 修订，2026-09-16）。
> `task purge` 的 `--force` 与它跳过的四类拒绝由 `lane/purge-force` 同步（ADR-0058 D09，2026-09-16）：被拒绝又确实要删时加 `--force`，跳过了什么看 `forced` 与 stderr。
> 其余内容沿用 FOUNDATION-091 的校对基线。

本文只列**源码里实际存在**的错误码与状态。每条给出「什么时候出现 / 怎么办」。

---

## 0. 先做的三件事

```sh
bun run codeestra status        # Runtime 是否可用、权限模式、ownership 结论
bun run codeestra events tail   # 事实流：事件比文案更接近真相
bun run codeestra task status $PROJECT <task-id>     # executions / verifications / session 注记
```

记住退出码的三分法：`1` = 拒绝或失败，`2` = 用法错误，`3` = 等待 / 没什么可做。
**看到一个 `1` 时先读码，不要读文案**（文案可能会变，码不会）。

---

## 1. 常见症状

### `status: "UNAVAILABLE"`（退出码 1）

Runtime 连不上也起不来。CLI 仍然会读本 home 的 ownership 记录并打印出来，看 `ownership`：

- `verdict: "UNREACHABLE_PROCESS"`：**进程在，但 socket 不应答**。这时 CLI **不会**替你杀掉它。
  用 `bun run codeestra stop` 看同一结论，再人工确认那个 PID 是否真是你启动的 Runtime。
- `lock` 里没有记录 / `socketPresent: false`：Runtime 没起来（例如启动即崩）。看 `traces`。
- `unreadableRecords` 非空：生命周期记录损坏，属于需要保留现场的事故。

### `ui` / `open` 报用法错误（退出码 2）

这是当前预期行为。ADR-0067 已暂停 Web UI，删除 `codeestra ui` / `codeestra open` 与 Runtime HTTP/SSE 入口；请改用 CLI。保留的前端与 HTTP 源码不代表可运行功能，也不进入默认构建与测试。

### 命令打到了「另一个」Runtime

CLI 只按 `CODEESTRA_HOME` 找 socket，一个 home 只跑一个 Runtime。若某个稳定 Runtime 已在运行，
你在别的工作树执行 CLI 会打到**它**（即那份代码），不会启动你当前的构建。要验证另一份代码：

```sh
CODEESTRA_HOME=/tmp/codeestra-dev bun run codeestra status
```

### `stop` 报 `NOT_EXITED` / `UNREACHABLE_PROCESS`（退出码 1）

- `NOT_EXITED`：等待期限内进程仍在。加大 `--wait`（≤600）再试；仍不退出时**先确认那个 PID 的归属**，
  不要手工 `kill -9` 一个无法识别归属的进程。
- `UNREACHABLE_PROCESS`：进程在但 socket 不应答。CLI 刻意**不**猜着杀。看 `ownership.lock` 与 `traces` 决定。

### `stop` 的 `pidMismatch: true`

同一个 home 上有两个 Runtime 应答过。这是事实，不是文案问题：先确认哪个是你想要的，再决定停谁。

### 报 `DEV_REPO_REQUIRED` / `DEV_CHECKOUT_*`（已删除）

这三个码都不再存在（ADR-0066）：产品不再有 dev clone、长期 `dev` 集成分支，也没有集成命令需要
「另一个 clone 上的那条分支」。`task integrate` / `promotion *` 本身也已删除，执行它们只会得到用法错误。

如果你在历史记录里读到这些码，它们描述的是 ADR-0066 之前的行为，现在没有对应的补救动作。
当前 Task 基线的相关拒绝只有：`TASK_BASE_REF_UNRESOLVED`（项目文件夹处于 detached HEAD）、
`TASK_BASE_REF_MISSING`（`--base-ref` 给的分支不存在）、`TASK_BASE_REF_NOT_A_BRANCH`、
`TASK_BASE_REF_ALREADY_FIXED`（该 Task 的基线已固定）。

### `project trust` 报 `VERIFICATION_POLICY_CHANGED` / `IMPACT_POLICY_CHANGED` / `REPOSITORY_CHANGED`

在你**查看**与**确认**之间，`main` ref 上的策略文件 / 影响映射 / 仓库身份变了。
这是防漂移，不是 bug。重新执行一次 `project trust`（或 `open`），重新看一遍再确认。

### 为什么这两个任务不冲突了（ADR-0059）

症状：以前它们会因为改同一个文件/同一个目录而互相等待，现在它们同时跑。

含义：这是**故意的行为反转**。判定只比较**声明**——两个 revision 是否声明了**同一个功能**
（`task create --feature <module-id>` / `task revision create --feature <module-id>`，取自 `main` ref 上
`.codeestra/impact.json` 的 `modules[].id`）。同文件、同目录、同模块、共享构建/依赖/schema/全局资源
**都不再阻止并发**；它们仍然作为事实出现在 `project impact explain` / `task schedule explain` 的输出里。

想让两个 Task 互斥：给它们**声明同一个功能**。这是唯一的互斥手段，也没有「严格模式」开关。

代价要自己担：两个都没声明功能的 Task 可以并发改同一个文件，冲突要到成果 commit / 合入 `dev` 时以
`CONFLICTED` 暴露——启动前门禁不再兜底。

`UNKNOWN` 取值、`--allow-unknown` 与 `task schedule clear-unknown` 都保留，但**当前规则不再产生
`UNKNOWN`**（只能从历史 assessment 行读到），所以这条路日常不可达；`CONFLICTING` 永远不放行。

### 声明功能被拒绝：`UNKNOWN_FEATURE` / `IMPACT_POLICY_ABSENT` / `INVALID_IMPACT_POLICY` / `INVALID_FEATURE`

`--feature <module-id>` 是**写入时**校验的（不在判定时），所以写错不可能悄悄生效：

| 码 | 含义 | 怎么办 |
|---|---|---|
| `INVALID_FEATURE` | id 是空串（或只有空白） | 给一个真实的功能 id |
| `IMPACT_POLICY_ABSENT` | 项目 `main` ref 上没有 `.codeestra/impact.json` | 先提交映射再声明；不声明也能用（就是默认不冲突） |
| `INVALID_IMPACT_POLICY` | 映射存在但不合法（JSON/结构/路径规则不通过） | `project impact validate /path/to/repo` 看具体原因 |
| `UNKNOWN_FEATURE` | id 不在该映射的 `modules[].id` 里 | `project impact show` 或直接读映射，换成已声明的 id |

**不要求映射已被 `project trust` 确认**：`--feature` 只看映射存不存在/合不合法/id 认不认识（ADR-0059 D03）。
未确认的映射仍由 `project impact validate` 报告，且不影响判定（判定本来就不读映射）。

### 占用者无法被观测：工作树已经不在磁盘上（ADR-0055）

症状：`project impact show/explain` 里某个 Task 的 `code` 是 `WORKSPACE_MISSING`（账本里写着 workspace
路径，但目录已不在磁盘上），或者 `task schedule explain` 的 `occupiers[].code` 是同一个事实。

含义：那一侧的变更集**永远观测不到**。ADR-0059 之后这不再是一个「任务跑不了」的理由：判定只看声明，
未声明同一功能的 Task 仍会 `SAFE` 并开始。但工作树丢失仍是**需要处理的故障**：它的成果不可观测、
集成与验证都拿不到证据，所以下面的对账仍然要做。

怎么办（按占用者的状态）：

```sh
bun run codeestra task schedule explain $PROJECT $TASK --json   # 看 occupiers[] 里到底是谁、什么码
bun run codeestra task status    $PROJECT $OCCUPIER            # 看它的 state 与 version

# RECOVERY_REQUIRED 的占用者：对账（只读事实；只有能证明 provider 已消失才收口）
bun run codeestra task recover $PROJECT $OCCUPIER <expected-version>

# PAUSED 的占用者：继续它或作废它
bun run codeestra task resume   $PROJECT $OCCUPIER <expected-version>
bun run codeestra task cancel   $PROJECT $OCCUPIER <expected-version>
```

只有把占用者自己的故障处理完（对账、或修好它的工作树），它才可能重新产出可观察的成果。
在这一刻之前，后续任务**不再**因为它而等待（ADR-0059）。

> **不要用外部 worktree 管理器（例如 Orca）清理 `CODEESTRA_HOME/worktrees`。**
> 那些目录同时是本仓库的 **git worktree**，外部工具会把它们当成“可回收的 worktree”移进自己的 trash 目录，
> 而 Codeestra 的账本不会因此改变：`workspaces` 行仍写 `RETAINED`/`RECOVERY_REQUIRED`，Task 分支可能被一并删除。
> 本机 2026-09-14 就发生过一次（全部任务 worktree 被移走，`#7`/`#8` 因此变成不可观测的占用者）。
> 要回收请用 `reclaim plan` / `reclaim apply`——那是唯一带归属校验与审计的路径。

### 任务跑完/合并后 worktree 还在？

**这是预期行为**（ADR-0066）：产品没有任何自动回收路径——ADR-0062 的「集成成功后自动回收」随集成一起删除。
要回收就显式跑：

```sh
bun run codeestra reclaim plan --project <project-id> --json   # 先看决策
bun run codeestra reclaim apply --project <project-id>
```

worktree 脏（有未提交/未跟踪改动）、成果未进入该 workspace 记录的 `base_ref`、Task 是 `FAILED`/`CANCELLED`：
属于**失败现场**，默认 `RETAIN`。要么合并/清理后重跑，要么显式 `--include-failure-scenes` 承担丢弃未提交改动的风险。
`reclamation.failed > 0` 说明上一次回收中断需要 reconcile（`RECOVERY_REQUIRED`），按 `detail` 处理后再重跑。

### 全局暂停：`scheduler control` 的稳定码（ADR-0061）

`scheduler control pause|resume` 退 `1` 时**不是**含糊的 `INVALID_STATE`，每个码有自己的处置：

| 码 | 事实 | 怎么做 |
|---|---|---|
| `GLOBAL_PAUSE_IDENTITY_UNVERIFIABLE` | 某个目标的 pid/start token 读不出来或对不上，**没有向它发任何信号** | `scheduler control status` 看该目标；确认那个进程是否还在，再决定 `resume`（已退出的目标会被如实记为 `EXITED`，不会复活）或按既有 `task recover` 收口 |
| `GLOBAL_PAUSE_TARGET_NOT_STOPPED` | 发出 `SIGSTOP` 后复读仍不是 stopped | 该目标保持 `RECOVERY_REQUIRED`；屏障保持，不要把它当成已暂停 |
| `GLOBAL_PAUSE_UNSUPPORTED` | 平台没有 POSIX 停止/继续语义，或该 Adapter 的 `providerProcessSuspension` **不是** `SUPPORTED`（当前 Codex 与 Claude Code 是 `REQUIRES_VALIDATION`） | 该目标无法被全局冻结；用单 Task 的 `task pause`（ADR-0016 协作停止）处置，或继续跑完 |
| `GLOBAL_RESUME_TARGET_CHANGED` | 目标的 pid 已属于别的进程（PID 复用），或不再是记录的 stopped 主进程 → **没有发 `SIGCONT`** | 按 `task recover` 收口该 Session；绝不重试 `resume` 去「把它弄醒」 |
| `GLOBAL_PAUSE_RECOVERY_REQUIRED` | 至少一个目标无法收口 | 屏障保持；先 `scheduler control reconcile` 观察，再逐目标处置 |
| `GLOBAL_CONTROL_IN_PROGRESS` | 上一次 `pause`/`resume` 还没收口（`PAUSING`/`RESUMING`） | 先 `scheduler control status` 看进度，不要连点 |

其它容易误读的事实：

- 任务因全局暂停而等待时 **`task run` / `task resume` / `task retry` / `scheduler reservations acquire` 都退 3**，
  码是 `SCHEDULER_GLOBALLY_PAUSED`；这是**等待**，任务既不是 `BLOCKED` 也不是失败。
- 暂停**不会**取消已经发出的模型请求（可能已在服务端完成并计费），也**不会**给工具子进程发停止信号；
  但 Provider 主进程停止读管道时，大输出工具可能因 OS 管道背压阻塞。
- `runtime stop` **不清除**暂停状态：重启后仍然是暂停态，必须显式 `scheduler control resume`。
  启动时 Runtime **不会**自动 `SIGCONT`、也**不会**自动 kill 上一代 boot 冻结的进程。

### 任务一直不跑（退出码 3）
`3` 表示**等待**，不是失败。三种互不相同的答案：

| 现象 | 含义 |
|---|---|
| `WAIT_CONFLICT` | 与某个**未完成且声明了同一功能**的 Task 冲突（唯一冲突） |
| `WAIT_CAPACITY` | **整个 Runtime 的唯一并发上限**已满（`CAPACITY_GLOBAL_LIMIT_REACHED`，默认 2，跨全部项目与 Adapter） |
| `SCHEDULER_DRAINING` | Runtime 正在 draining，不接受新的 slot |

看谁占着（容量是整个 Runtime 的，所以 `capacity get` 不带项目）：

```sh
bun run codeestra scheduler capacity get --json
bun run codeestra scheduler reservations list $PROJECT
```

释放必须是**显式**的，而且必须有理由：

```sh
bun run codeestra scheduler reservations release $PROJECT <reservation-id> --reason "…"
```

**没有任何东西会因为心跳过期、客户端消失或用户等待而自动释放。**

`BLOCKED` 是另一种情况（**依赖未满足**，退出码 1）：用 `task depends list` 看是哪一条。

### 任务卡在 `WAITING_FOR_USER` 但没有任何 Agent 在跑

很可能是**散文提问等待**：Agent 没用工具、正文里提问然后结束轮次（标注码
`PROSE_QUESTION_NO_TOOL_USE`）。provider 进程**已经退出**，所以没有 dialog 可以写。

```sh
bun run codeestra task status $PROJECT <task-id>        # stderr 会打印 [waiting] … 与问题原文
bun run codeestra attention list $PROJECT
bun run codeestra attention resolve $PROJECT <attention-id> --answer "…"    # 或 --dismiss
```

用 `attention answer` 去投递它会被以 `PROSE_QUESTION_RESOLUTION_REQUIRED` 拒绝——这是**故意的**，
因为那会声称投递了一个不存在的请求。

不想每次都被这样打断，可以降级：

```sh
bun run codeestra settings prose-question-attention record-only   # 只标注，不记等待
```

### 问卷回答被拒，请求还停留在 `OPEN`

形如 `INVALID_QUESTIONNAIRE_ANSWER:<PROBLEM>`，其中 `<PROBLEM>` ∈
`QUESTION_INDEX_OUT_OF_RANGE`、`DUPLICATE_QUESTION_ANSWER`、`DUPLICATE_CHOICE`、
`CHOICE_INDEX_OUT_OF_RANGE`、`MULTIPLE_CHOICES_FOR_SINGLE_SELECT`。

**已答内容不会被作废，请求保持 OPEN**——改对选项号再提交即可。题号与选项号都是 **1-based**，
与界面显示一致。

### 成果提交被拒

| 码 | 含义 / 怎么办 |
|---|---|
| `NOTHING_TO_COMMIT` | worktree 里没有改动；先确认 Agent 真的写了东西 |
| `AGENT_NOT_QUIESCENT` | 工具还没静止。等它结束，或先暂停/取消 |
| `STALE_AUTHORIZATION` | STRICT 两步流程里，prepare 之后 HEAD/ChangeSet/revision 变了 —— 重新 `prepare` |
| `COMMIT_MISMATCH` / `STALE_REVISION` | 同上，固定的事实已变化 |
| `NO_CAPTURED_RESULT` / `NO_ACTIVE_EXECUTION` / `INVALID_EXECUTION_STATE` | 没有可提交的成果来源；`task status` 看 Execution 状态 |
| `SENSITIVE_PATH_BLOCKED` | **仅 STRICT**：改动落在敏感路径。FULL 下不做这个拒绝 |
| `FULL_PERMISSION_REQUIRED` | 在 STRICT 下用了 `task result capture`；改用 `prepare` + `commit --confirm` |
| `IDENTITY_NOT_CONFIGURED` | 仓库没有 Git identity。Codeestra **不代写** `git config`，请自己设 |
| `COMMIT_FAILED` / `WORKSPACE_NOT_OWNED` | hooks 失败（现场已保留）或提交目标不是本 Task 的 worktree |
| `AMBIGUOUS_EXECUTION` | 有多个候选执行来源；显式传 `execution-id` |

### 任务验证被拒

| 码 | 含义 / 怎么办 |
|---|---|
| `VERIFICATION_POLICY_ABSENT` | `main` ref 上没有 `.codeestra/policies/verification.json`。加上它（人工维护） |
| `VERIFICATION_POLICY_NOT_CONFIRMED` | 策略在 `main` 上变了，但还没被 trust 确认。重新 `project trust` |
| `VERIFICATION_POLICY_UNREADABLE` / `INVALID_VERIFICATION_POLICY` | 文件存在但读不了 / 不合法 |
| `TASK_NOT_EXECUTED` | 这个 Task 还没有可验证的执行 |
| `TARGETED_TEST_PLAN_NOT_RECORDED` | 用了 `--policy targeted`，但该 Task 没有**已记录**的计划 → `task tests record` |
| `TARGETED_TEST_PLAN_ABSENT` | 分支上根本没有 `.codeestra/tests.json` |
| `TARGETED_TEST_PLAN_REVISION_MISMATCH` / `_COMMIT_MISMATCH` / `_DIGEST_MISMATCH` | 已记录的计划属于**另一个** revision/commit/digest。它**不会**被静默换成项目策略 |
| `TARGETED_TEST_PLAN_UNREADABLE` / `INVALID_TARGETED_TEST_PLAN` | 计划文件读不了 / 不合法（命令数 1–16，每条要有 `covers` 等字段） |

### 后台验证「成功了」但结果不是 PASSED

`task verify --background` 的退出码 `0` 只表示**已受理并开始**：

```sh
bun run codeestra task operation list $PROJECT <task-id>
```

进度事件（`OperationProgressed` / `OperationSettled`）只是进度，**永不携带判定**；
通过只由 `VerificationCompleted` 与该运行自身的状态报告。

取消时若 `stop === "UNCERTAIN"` 会退 `1`：进程可能还在跑，Operation 被留给人处理，**不要当成已取消**。

### 集成失败（`task integrate` 退出码 1）

`dev` **没有被触碰**（除 `INTEGRATED` 之外的一切状态都不推进 ref）。按码处理：

| 码 | 含义 |
|---|---|
| `TASK_VERIFICATION_NOT_PASSED` | 先让 Task 验证 PASSED |
| `NO_CAPTURED_RESULT` / `TASK_NOT_EXECUTED` | 没有成果 commit |
| `DEV_REF_CHECKED_OUT` | `dev` 正被某个工作树检出。先把它切走 |
| `DEV_REF_MISSING` | 项目没有 `dev` 分支 |
| `INTEGRATION_IN_PROGRESS` | 已有集成在进行；等它结束或看它的状态 |
| `INTEGRATION_BATCH_INVALID` | 批次本身不合法（例如成员 revision/commit 对不上） |
| `STALE_REVISION` / `REPOSITORY_CHANGED` | 期间 revision 或仓库身份变了；重新申请 |
| `CONFLICTED`（状态） | 合并冲突。**现场已保留**，由你处理 |

### 稳定提升被拒（已删除）

`promotion *` 与「提升被拒」的整套码（`PROMOTION_*`、`DEV_FULL_SUITE_EVIDENCE_*`、`MAIN_WORKTREE_*`、
`DEV_REF_MOVED`、`REMOTE_DEV_*`、`RESTART_*` 等）随 ADR-0066 一起从产品中删除。本仓库自身的
`dev → main` 人工四步失败时，按 `docs/agents/runbook.md` 的「停在哪一步就停在那一步并如实报告」处理。

### `RECOVERY_REQUIRED`（状态，不是错误码）

它是**多个实体都有的状态**，含义是「有事实无法被证明，需要一次带审计的对账」，**不是让你重试掩盖它**：

| 位置 | 含义 |
|---|---|
| Task / Execution 状态 | 执行的所有权或静止性无法证明 |
| Agent Session 状态 | provider 进程身份无法确认 |
| Workspace 状态 | worktree 归属无法核验 |
| Attention kind `RECOVERY` | 需要人处理的一条恢复请求 |
| `scheduler reservations reconcile` 的 `RECOVERY_REQUIRED` | 预留持有者活着或无法核验，**槽位保留**（不发信号、不删资源） |

相关码：`RECONCILE_REQUIRED`（操作被拒绝并要求对账，例如 `TASK_PAUSED` 的 retry、
`task operation cancel` 的某些路径、**以及 `task purge` 无法证明 provider 已停止时**）。purge 遇到它时**什么都不删**：
`RECOVERY_REQUIRED` 任务会先按观察对账（与 `task recover` 同一判定）——provider 确已退出就继续删除，否则保持原状；
想单独先把状态收口也可以手动 `task recover`。

### `task purge` 被拒绝

| 码 | 含义 | 怎么办 |
|---|---|---|
| `PURGE_CONFIRMATION_REQUIRED` | 请求没带 `confirmed: true`（CLI 缺 `--yes` 时本地就会以退出码 2 拦住，根本不会发出请求） | 确认确实要永久删除，再加 `--yes` |
| `RECONCILE_REQUIRED` | 非终态任务无法被证明已停止，或 `RECOVERY_REQUIRED` 任务的 provider 仍存活/身份缺失/无法核验 | 确认该进程真的已退出（必要时先 `task recover` 按观察对账），再重试；确实要删就加 `--force`（见下） |
| `PURGE_RESOURCE_NOT_OWNED` | 记录的 worktree / 验证副本 / 分支无法证明属于这个任务（例如分支被别的 worktree 检出、路径是 symlink 或注册不符） | **一行都没删**；看 `reclaim.records` 里的 `reasonCode`，先处理那个资源（如先释放它所在的 worktree） |
| `CONCURRENT_MODIFICATION` | 版本已变（例如你看到后它又停了/改了） | 重新 `task status` 读当前版本再发一次 |
| `NOT_FOUND` | 任务不存在（已被别人删掉，或 ID 写错） | 核对 `task list --all`；如果只是想确认自己那条命令是否生效，**用同一个 commandId 重放**会读到收据而不是这个错 |

### `task purge --yes --force`：我确实要删，别再拦我

`--force` 是**同一条命令的更宽的声明**，不是第二道确认（`--yes` 仍是唯一一次确认，不加等待、不需要在场的人）。它按顺序做四件事：

1. **先终止**：对任务**记录过的身份**（pid + start token）发 `SIGTERM`，有界等待，再对仍存活的发 `SIGKILL`，再有界等待。**记录里没有 start token 的 pid 一个信号都不发**（pid 会被复用，杀错进程比留下孤儿更糟；它们会列在 `termination.unattributable` 里），不按进程组杀、不扫描「看起来像 provider」的进程。两轮后仍存活就报 `termination.survivors`，**不声称静止**。
2. **删掉本来会拒绝的行**：`TASK_INTEGRATED_INTO_DEV` / `TASK_IN_STABLE_PROMOTION` 不再拦——`dev`/`main` 里的来源记录（`integration_batch_items` / `integration_verification_runs` / `stable_promotion_members`）会一起删；**当该任务就是那条集成验证行记录的任务时，引用了它的 `stable_promotions` 记录本身、连同这条 promotion 的全部成员行（可能含其他任务）也必须一起删**（外键决定的），逐表条数在 `rowsDeleted` 里。
3. **只越过「活占」**：`ACTIVE_EXECUTION` / `ACTIVE_RESERVATION` / `ACTIVE_VERIFICATION` / `TASK_NOT_TERMINAL` 不再拦。**归属校验从不越过**：证明不了归属的目录/分支**留在磁盘上**，逐项写在 `forced.bypassed` 里（它们随任务删除后变成「未注册目录」，需要时用 `reclaim --unregistered` 收拾）。
4. **如实记账**：`forced`（`null` 表示没用 `--force`）= `bypassed[]`（每条被跳过的拒绝码与原文理由）+ `termination`（是否尝试、发了几个信号、是否终止、幸存与不可归属的 pid）；同一份事实写进 `TaskPurged`，CLI 另外打到 **stderr**。被强制删除的 `RECOVERY_REQUIRED` 任务，`stop.stop` 是 `"FORCED"`。

**它管不到的**：集成工作树/集成验证副本（属于批次而不是任务）不由 purge 回收；`NOT_FOUND` / `CONCURRENT_MODIFICATION` / 缺 `--yes` 仍然失败。不传 `--force` 时所有旧行为一字未变。

**不会做但很容易误传的两件事**：purge **不会**删 `domain_events`/`command_receipts`/`operations`/`intents`（事件流里仍能读到它的历史与最后那条 `TaskPurged`），
且**不代表可恢复**——没有墓碑、没有备份，除了逐表行数与每个被删分支的 `tipCommit` 之外不可找回。

### Agent 起不来：`PROVIDER_VERSION_UNAVAILABLE`

Adapter 在**启动 provider 之前**先跑 `<provider> --version` 并解析版本号。三种失败都映射到这个码：

- 可执行文件启动不起来（不在 `PATH`、没有执行权限）；
- `--version` 运行失败；
- `--version` 输出里没有可用的 `x.y.z`。

处理：

```sh
pi --version          # 或 codex --version / claude --version
echo $PATH
```

可用环境变量指定可执行文件：`CODEESTRA_PI_EXECUTABLE`、`CODEESTRA_CODEX_EXECUTABLE`、`CODEESTRA_CLAUDE_EXECUTABLE`。

### 终端接管被拒：`ATTACHMENT_BUSY`

**同一时刻只允许一个 writer attachment**，竞争是**拒绝而不是排队**（这是刻意的：Pi 没有会话文件锁）。

```sh
bun run codeestra session handoff status $PROJECT <session-id>
```

看是谁持有。另一个 holder 的 `detach` / `writer release` 也是 `1`（只有持有者能释放自己的）。

相关码：`TERMINAL_NOT_RUNNING`、`TERMINAL_NOT_HELD`、`TERMINAL_TRANSPORT_UNAVAILABLE`、
`HANDOFF_KIND_MISMATCH`、`HANDOFF_NOT_REQUESTED`、`INCARNATION_NOT_CURRENT`、
`SESSION_INCARNATION_UNAVAILABLE`。

### `task retry` 报 `WORKSPACE_RECLAIMED`

任务的工作树被回收了，而**保留下来的 Task 分支无法重建到记录的路径**：

```
the Task worktree was reclaimed and cannot be rebuilt: the surviving branch is absent,
unrelated to the recorded baseline, already checked out in another worktree, or the
recorded path is occupied by something Git does not register
```

具体四种情况（源码核对）：

1. 分支不存在（回收时没保留）；
2. 分支与记录的基线**无关**（既不是同一个 commit，也不是它的后代）；
3. 分支已经在别的工作树里被检出；
4. 记录的路径上有一个 Git **没有登记**的目录。

第 4 种**不会**为了腾地方而被删除——删除是显式的回收决定，不是 retry 的副作用。
`WORKSPACE_OWNERSHIP_UNVERIFIABLE` 同理：存在但证明不了是**这个 Task 的**工作树，绝不交给新的 Execution。

### 改动了策略文件，然后 `task verify` 直接执行了

这是 FULL 的**预期行为**（ADR-0011）：验证策略变化在 FULL 下无需确认。
切到 STRICT 就恢复确认：

```sh
bun run codeestra settings permission set strict
bun run codeestra project trust /path/to/repo    # 重新确认当前策略 digest
```

### 事件订阅中止，收到 `INVALID_CURSOR`

你的游标**大于** Runtime 日志的最新序号。这是刻意的：**未知游标被告知，而不是被静默裁剪**。

重新取快照，再用新游标订阅：

```sh
bun run codeestra events list --limit 1        # 或者从你保存的最后一个游标开始
```

其他订阅结束原因：`EVENT_READ_FAILED`（读取事件出错）。

### 别的地方也出现 `CONCURRENT_MODIFICATION`

这是**乐观并发**拒绝：你手上的 version 已经过期。重新读一次当前值，用新的 expected version 再提交。
不要用「重试直到成功」掩盖它——它存在的原因正是防止覆盖别人的修改。

---

## 2. 稳定码速查表（按领域）

### 边界与用法

| 码 | 来源 | 含义 |
|---|---|---|
| `NOT_FOUND` | 各服务 | 资源不存在 |
| `INTERNAL_ERROR` | Runtime | 未归类异常 |
| `INVALID_CURSOR` | 事件订阅 | 游标超前于日志；订阅结束 |
| `EVENT_READ_FAILED` | 事件订阅 | 读取事件失败 |
| `CONCURRENT_MODIFICATION` | 多处 | 乐观版本冲突 |
| `VERSION_CONFLICT` | Task 提交等 | 同上 |
| `INVALID_STATE` / `INVALID_TRANSITION` / `INVALID_VALUE` | 领域 / storage | 状态或取值不允许 |
| `UNSUPPORTED_INTENT_KIND` | storage（`assertIntentKind`） | Intent 取值不在 schema v28 收窄后的 `intents.kind` 集合内（ADR-0046）；边界直接拒绝，报文列出可接受取值 |
| `UNKNOWN_COMMAND` | CLI（`apps/cli/src/main.ts`） | 未知命令：退出码 `2`，stderr 一行，并指向上一层 `help`（ADR-0068） |
| `USAGE` | CLI | 参数个数/取值/flag 不合法：退出码 `2`，一行，带该命令自己的用法行与 `<命令> help` 提示 |
| `UNHANDLED_COMMAND` | CLI | 退出码 `70`：命令树里有这个命令、分发却没有分支——**Codeestra 的缺陷**，不是你的用法错误；请把它当 bug 报告 |

> **ADR-0068 起**：用法错误不再打印整份命令清单（那是旧 `usage()` 的行为），长文本已完整搬进命令树，
> 通过 `codeestra help` / `codeestra <路径> help` 读取（§22）。

### Runtime / 生命周期

`UNREACHABLE_PROCESS`、`NOT_RUNNING`、`NOT_EXITED`、`STOP_FAILED`、`RUNTIME_NOT_READY`、
`RUNTIME_NOT_RESTARTED`、`RUNTIME_NOT_OBSERVED`、`LOCK_CONTENDED`、`CORRUPT_LOCK`、`STALE_LOCK`、
`EXITED_WITHOUT_CLEAN_SHUTDOWN`、`PROCESS_IDENTITY_MISMATCH`、`PROCESS_IDENTITY_MISSING`、
`PROCESS_ID_REUSED`、`PROCESS_CHECK_UNAVAILABLE`、`NO_LIVE_SESSION`、`SESSION_UNKNOWN`。

### 项目 / 知识 / 映射

`INVALID_REPOSITORY`、`NOT_A_CODEESTRA_WORKTREE`、`UNSAFE_CHECKOUT`、`GIT_INSPECTION_FAILED`、
`GIT_STATE_UNAVAILABLE`、`REPOSITORY_CHANGED`、`DEV_REF_MISSING`、`DEV_BASELINE_MISSING`、
`PROJECT_NOT_FOUND`、`PROJECT_NOT_TRUSTED`、`UNKNOWN_ADAPTER`、`INVALID_AGENT_CONFIGURATION`、
`VERIFICATION_POLICY_ABSENT`、`VERIFICATION_POLICY_NOT_CONFIRMED`、`VERIFICATION_POLICY_UNREADABLE`、
`VERIFICATION_POLICY_CHANGED`、`INVALID_VERIFICATION_POLICY`、
`IMPACT_POLICY_CHANGED`、`IMPACT_POLICY_NOT_CONFIRMED`、`IMPACT_POLICY_UNREADABLE`、`INVALID_IMPACT_POLICY`、
`INVALID_IMPACT_MAPPING`、`INVALID_IMPACT_SCOPE`、`EMPTY_MAPPING`、`MISSING_IMPACT_SNAPSHOT`、
`IMPACT_SNAPSHOT_UNAVAILABLE`、`IMPACT_WORKSPACE_ABSENT`、`SNAPSHOT_STALE`、`SNAPSHOT_UNAVAILABLE`、
`SNAPSHOT_SCOPE_MISMATCH`、`STALE_ANALYZER`、
`RECOVERY_PROVIDER_ALIVE`、`RECOVERY_DESCENDANTS_ALIVE`、`RECOVERY_OWNERSHIP_UNVERIFIABLE`、
`RECOVERY_PROCESS_IDENTITY_MISSING`、`TASK_NOT_IN_RECOVERY`（`task recover` 的拒绝码，ADR-0055）、
以及所有 `KNOWLEDGE_*`（在 [cli/project.md](./cli/project.md) 的 `project knowledge` 一节与
[features.md](./features.md) 列全）。

### 任务 / 执行 / 会话

`TASK_NOT_FOUND`、`TASK_NOT_STARTABLE`、`TASK_NOT_RESERVABLE`、`TASK_NOT_FAILED`、`TASK_CANCELLED`、
`TASK_PAUSED`、`TASK_ARCHIVED`、`TASK_STILL_RUNNING`、`TASK_NOT_TERMINAL`、`TASK_NOT_EXECUTED`、
`TASK_VERIFICATION_NOT_PASSED`、`EXECUTION_NOT_FOUND`、`EXECUTION_NOT_ACTIVE`、`NO_ACTIVE_EXECUTION`、
`INVALID_EXECUTION_STATE`、`AMBIGUOUS_EXECUTION`、`UNEXPECTED_TASK_STATE`、`REVISION_CHANGED`、
`STALE_REVISION`、`INVALID_REVISION`、`NO_SUBJECT_EXECUTION`、`SUCCESSOR_NOT_RECORDED`、
`SUCCESSOR_REVISION_MISMATCH`、`DEPENDENCIES_UNMET`、`DEPENDENCY_CYCLE`、`DEPENDENCY_GRAPH_INVALID`、
`DUPLICATE_EDGE`、`SELF_DEPENDENCY`、`UPSTREAM_NOT_INTEGRATED`、`WORKSPACE_RECLAIMED`、
`WORKSPACE_OWNERSHIP_UNVERIFIABLE`、`RECONCILE_REQUIRED`、`WORKSPACE_PREPARE_FAILED`、
`WORKSPACE_RELEASE_FAILED`、`ACTIVE_EXECUTION`、`ACTIVE_RESERVATION`、`NOTHING_TO_COMMIT`、
`AGENT_NOT_QUIESCENT`、`NO_CAPTURED_RESULT`、`SENSITIVE_PATH_BLOCKED`、`FULL_PERMISSION_REQUIRED`、
`AUTHORIZATION_MISMATCH`、`AUTHORIZATION_NOT_ACTIVE`、`STALE_AUTHORIZATION`、`COMMIT_MISMATCH`、
`COMMIT_FAILED`、`IDENTITY_NOT_CONFIGURED`、`WORKSPACE_NOT_OWNED`。

### 调度 / 容量 / 槽位

`CAPACITY_WAIT`、`CONFLICT_WAIT`、`CAPACITY_GLOBAL_LIMIT_REACHED`、
`CAPACITY_LIMIT_INVALID`、`CAPACITY_LIMIT_OUT_OF_RANGE`、`SCHEDULER_DRAINING`、`TASK_NOT_STARTABLE`、
`SLOT_ALREADY_RESERVED`、`SLOT_ALREADY_BOUND`、`SLOT_NOT_ACTIVE`、`SLOT_HELD_BY_ANOTHER_RUNTIME`、
`SLOT_HOLDER_STILL_RUNNING`、`HOLDER_STILL_RUNNING`、`HOLDER_STOPPED`、`HOLDER_PROCESS_ID_REUSED`、
`HOLDER_OWNERSHIP_UNVERIFIABLE`、`PROCESS_IDENTITY_MISSING`、`NOT_HELD`、`REVISION_CHANGED`、
`SNAPSHOT_STALE`、`SNAPSHOT_UNAVAILABLE`、`NOT_A_CANDIDATE`、`SCHEDULE_TICK_FAILED`、`NOT_UNKNOWN`。

`CAPACITY_ADAPTER_SLOT_LIMIT_REACHED` 与 `UNKNOWN_ADAPTER`（当容量命令用它时）只出现在**历史**事件与历史命令结果里：
ADR-0061 删除了 Adapter 级容量上限，当前命令面不再产生它。（`UNKNOWN_ADAPTER` 仍由其他命令如 `task run --adapter` 产生。）

### 验证 / 集成 / 提升

`VERIFICATION_FAILED`、`VERIFICATION_NOT_PASSED`、`VERIFICATION_JOB_FAILED`、`VERIFICATION_QUEUED`、
`COMMAND_FAILED`、`COMMAND_TIMEOUT`、`CANCEL_UNCONFIRMED`、`NOT_CANCELLABLE`、
所有 `TARGETED_TEST_PLAN_*`、
`REF_CONFLICT`、`UNRELATED`、`NOT_REACHABLE_FROM_BASE`、`UPSTREAM_RESULT_MISSING`、`BASE_REF_MISSING`、
`BASE_REF_UNREADABLE`、`TASK_BASE_REF_UNRESOLVED`、`TASK_BASE_REF_MISSING`、`TASK_BASE_REF_NOT_A_BRANCH`、
`TASK_BASE_REF_ALREADY_FIXED`、`HEAD_MISMATCH`、`UNEXPECTED_HEAD`、`BRANCH_DIVERGED`、`BRANCH_ABSENT`、
`BRANCH_MISMATCH`、`BRANCH_CHECKED_OUT_ELSEWHERE`、`UNBORN_MAIN`。

**已删除、不会再出现的码**（ADR-0066，历史记录里读到时按此理解）：所有 `DEV_REPO_*`、`DEV_REF_*`、
`DEV_CHECKOUT_*`、`INTEGRATION_BATCH_*`、`INTEGRATION_IN_PROGRESS`、`INTEGRATION_VERIFICATION_FAILED`、
`MERGE_CONFLICT`、`MERGE_FAILED`、`MERGE_HEAD`、`NOT_REACHABLE_FROM_DEV`、`PROMOTION_*`、
`DEV_FULL_SUITE_EVIDENCE_*`、`TASK_INTEGRATED_INTO_DEV`、`TASK_IN_STABLE_PROMOTION`。

### 回收

`RECLAMATION_IN_PROGRESS`、`COMMAND_CONFLICT`、`PROJECT_SCOPE_CONFLICT`、`PROJECT_SCOPE_REQUIRED`、
`REMOVAL_FAILED`、`REMOVAL_UNCONFIRMED`、`PRUNE_FAILED`、`CLAIMED_BY_LEDGER`、
`UNREGISTERED_REQUIRES_EXPLICIT_SELECTION`、`PATH_NOT_OWNED_LAYOUT`、`PATH_OUTSIDE_OWNED_ROOT`、
`WORKSPACE_OWNERSHIP_UNVERIFIABLE`、`UNRECOGNIZED_LAYOUT`、`SCAN_ROOT_NOT_ABSOLUTE`、
`SCAN_ROOT_OUTSIDE_HOME`。

### 交接 / 终端

`ATTACHMENT_BUSY`、`HANDOFF_KIND_MISMATCH`、`HANDOFF_NOT_REQUESTED`、`HANDOFF_REQUEST_REFUSED`、
`INCARNATION_NOT_CURRENT`、`INCARNATION_UNKNOWN`、`SESSION_INCARNATION_UNAVAILABLE`、
`TERMINAL_NOT_RUNNING`、`TERMINAL_ALREADY_RUNNING`、`TERMINAL_EXITED`、`TERMINAL_NOT_HELD`、
`TERMINAL_NOT_FOUND`、`TERMINAL_STILL_RUNNING`、`TERMINAL_TRANSPORT_UNAVAILABLE`、
`TERMINAL_LAUNCH_FAILED`、`PROVIDER_STILL_RUNNING`、`PROVIDER_STOPPED`、`PROVIDER_DESCENDANTS_ALIVE`、
`PROVIDER_OWNERSHIP_UNVERIFIABLE`、`SAFE_POINT_NOT_REACHED`、`AUTOMATION_SUCCESSOR_FAILED`、
`AUTOMATION_SUCCESSOR_UNAVAILABLE`、`RELEASE_NOT_CONFIRMED`、`RELEASE_WRITE_FAILED`、
`NOT_A_PERMISSION_ATTENTION`、`PERMISSION_CHANNEL_UNAVAILABLE`、`PERMISSION_ANSWER_FAILED`、
`PERMISSION_DECISION_NOT_DELIVERED`、`INVALID_PERMISSION_REQUEST`。

### 提问 / 回答

`NOT_A_QUESTIONNAIRE`、`INVALID_QUESTIONNAIRE_ANSWER:<PROBLEM>`（`<PROBLEM>` ∈
`QUESTION_INDEX_OUT_OF_RANGE` / `DUPLICATE_QUESTION_ANSWER` / `DUPLICATE_CHOICE` /
`CHOICE_INDEX_OUT_OF_RANGE` / `MULTIPLE_CHOICES_FOR_SINGLE_SELECT`）、
`ANSWER_NOT_DELIVERABLE`、`ADAPTER_MISMATCH`、`INVALID_ADAPTER_RECEIPT`、`INVALID_ADAPTER_EVENT`、
`INVALID_ADAPTER_RESPONSE`、以及所有 `PROSE_QUESTION_*`。

---

## 3. 文档与实现不一致的处置（FOUNDATION-074 校准 + FOUNDATION-075 收口 + FOUNDATION-078 逐屏走查校准）

J1（FOUNDATION-070）曾在上一版这里如实列出 10 项「文档与实现不一致」，并明确「没有在文档里被悄悄改掉、只列出不裁决」。
> **后记（ADR-0068）**：本节多处提到的 `usage()` 文本已被**命令树**取代（`apps/cli/src/command-tree.ts`）：
> 那些行说的「已列入 `usage()`」现在是「已在命令树里」，并且由 `cli-command-surface.test.ts` 核对
> `docs/guides/cli` 的覆盖。本节保留原文，不改写历史。

FOUNDATION-074（Wave K / K1 文档校准）逐条处置了这份清单：**8 项已修**（含唯一一处代码改动：`apps/cli/src/main.ts` 的 `usage()` 文本），**2 项保留为「待裁决」**——它们需要用户裁决，本格没有自行改。用户于 2026-09-15 就这两项作出裁决，
FOUNDATION-075（Wave K / K2）把第 7、10 条**一并收口**（处置见下表末列与本节末段）。

| # | 位置 | 原不一致 | 本格处置 | 依据 |
|---|---|---|---|---|
| 1 | `README.md`「当前状态」段 | 「尚无自动 Scheduler、长命令后台化、Task cancel/pause、revision 投递确认」 | **已修**：README 的「当前状态」与「下一步」两段已按实现重写 | 契约 `task.schedule.run`（`packages/contracts/src/index.ts:1935`）、`task.cancel`（`:1126`）、`task.revision.delivery.*`；`CODEESTRA_SCHEDULE_TICK_MS`（`apps/runtime/src/main.ts:465`） |
| 2 | `README.md` 同段 | 「现有 Phase 1 `task.run` 代码仍按项目 `mainRef` 创建 worktree」 | **已修**：改为如实描述 dev 基线 | `grep -n "devRef" apps/runtime/src/workspace-service.ts` → `93,120,172,312`（ADR-0018 已完成） |
| 3 | `README.md` 同段 | 「自动 Integration 阶段尚未实现」「Integration/main 提升仍未实现」 | **已修**：README 与 `roadmap/mvp.md` 都改为如实描述 | 契约 `task.integrate`（`:1266`）、`promotion.prepare`（`:1471`）、`promotion.fullSuite.run`（`:1559`） |
| 4 | `README.md` 同段 | 「`task run`/`task verify` 仍同步占用连接，长命令进度事件尚未实现」 | **已修**：改为「仍同步占用连接，但可用 `--background` 与 `task operation *` 脱离；进度事件已实现」 | `usage()` 的 `task verify … [--background]`、`task operation list/get/cancel`；事件 `OperationProgressed`/`OperationSettled`（`packages/storage/src/database.ts` 的 `domain_events` 写入名单） |
| 5 | `README.md`「下一步」 | 「下一纵向小步是 **Task cancel**」 | **已修**：改为指向 `docs/tasks/README.md` 的 `## NEXT` 真实剩余项 | `task.cancel` 契约与 CLI 均在（`:1126`） |
| 6 | `README.md` 同段 | 「ADR-0010 设计的原生 Pi TUI/PTY 接管……尚未实现，当前只支持结构化 Attention 交互」 | **已修**：改为「PTY 接管已实现（ADR-0026/FOUNDATION-046），Session Guidance 未实现」 | `usage()` 的 `session handoff attach/detach/release/admit`、`terminal read\|write`；`apps/runtime/src/session-handoff-service.ts` 的 `ptyTransport` 与 `ptyResize` |
| 7 | `PROJECT_SPEC.md` §1 前状态段 | 该段仍写「取消超时、gate 拒绝路径、Integration/main 提升与多任务并行仍未验收」与「`dev → main` 提升、Runtime 重启、多任务批次与批级 `STALE`/取消仍未实现」，与同文件 §3 自相矛盾 | **已修（FOUNDATION-075）**：用户裁决「§1 状态段与 §3 自相矛盾 → 开一格修规格」并明确授权改规格文件。第 3 行状态段重写为与 §3 及实现一致；随后又追加授权一并修 §8「本次交付范围」里的现状陈述（同一类矛盾）。§1.1/§2/§3–§9 的规范语义一字未改，`git diff` 只有三行 | 契约与实现证据见 `docs/tasks/README.md` 的 FOUNDATION-075「本次规格修订」一节；迁移与 schema 事实见 ADR-0046 |
| 8 | `apps/cli/src/main.ts` 的 `usage()` | 未列出 `scheduler reservations get` | **已修**（K1 唯一代码改动）：用法文本补上 `scheduler reservations get <project-id> <reservation-id> [--json]`，并给 `list` 的说明段补一句 `get` 的语义。同时同步了 `docs/guides/cli-reference.md` §14/§21 里「该命令不在 `usage()` 里」的两处描述（否则本格会自己造出新的假话） | 契约 `scheduler.reservations.get`（`:1859`）、分派 `reservationAction === 'get'`（`apps/cli/src/main.ts`） |
| 9 | `usage()` 的 `session handoff attach` 用法行 | 未列出 `--observer` | **已修**：用法行改为 `[--writer\|--observer] [--since <cursor>]` | 解析器接受 `--observer`，且默认 attachment kind 就是 `OBSERVER`（`let attachmentKind: 'WRITER' \| 'OBSERVER' = 'OBSERVER'`） |
| 10 | `packages/storage/src/migration.ts` 的 `intents.kind` | 允许 `CHANGE_PRIORITY`、`ANSWER_AGENT`、`SELF_MODIFICATION`，但**没有任何 CLI 命令产生这三种 intent** | **已修（FOUNDATION-075）**：用户裁决「缩小 CHECK（要迁移）」。CHECK 自 schema v28（ADR-0046）起只接受 `('CREATE_TASK','AMEND_TASK','ADD_CONSTRAINT','CANCEL_TASK','ANSWER_AGENT')`；真实文件库 v27→v28 迁移、含被移除取值的库必须拒绝并保留原库、`ANSWER_AGENT` 仍可写都有定向测试。**上一版这一条本身有事实错误**：`ANSWER_AGENT` **有**产生路径（`Phase1Database.planAttentionAnswer` 在同一事务里写 `ANSWER_AGENT` intent 与同名 Operation；稳定库 33 行 `intents` 里有 24 行是它、9 行 `CREATE_TASK`），因此它必须保留，删它会直接弄坏 attention answer。真正无产生路径的只有 `CHANGE_PRIORITY` 与 `SELF_MODIFICATION` | 上一版漏掉的两处写入在 FOUNDATION-075 改动前的 `packages/storage/src/database.ts:2833`/`:2846`（ANSWER_AGENT intent 与同名 operation），现在是同一方法的 `insertIntent` 调用与 `operations` 插入；证据还包括 `packages/storage/test/intent-kind-shrink.test.ts`（新增 6 项，含 `planAttentionAnswer` 在 v28 上写出 `ANSWER_AGENT` 的断言）与 ADR-0046 |

**K1 的两份待裁决项最后由谁改、为什么 K1 不能自行改**

- 第 7 条（`PROJECT_SPEC.md` 状态段与自身 §3 矛盾）：K1 按用户当时的裁决把规格文件视为**只读**，因此只如实保留；
  用户随后明确「开一格修规格」，FOUNDATION-075 据此重写状态段（并追加授权修 §8 的现状陈述）。
- 第 10 条（`intents.kind` 声明与产生路径不一致）：无论选哪条路都超出 K1 的范围——缩小 CHECK 是 schema 变更（需要迁移与 ADR），
  补命令是新能力（需要命令面、状态迁移与测试）。K1 因此只如实保留；用户裁决「缩小 CHECK（要迁移）」后由 FOUNDATION-075
  落地（ADR-0046，schema v28）。**K1 在这一条里的事实描述有误**（把 `ANSWER_AGENT` 也当成没有产生路径），
  已在上面第 10 行逐字改正。
- 历史记录章节（本文档 §3 的表格与 K1 的任务记录）保持只读：纠正写在这一节与 FOUNDATION-075 的记录里，不改写已归档的文字。

**本格另外核对并修正的两处陈旧陈述（不在原 10 项内）**

- `docs/architecture/scheduler.md` 的「本基线里没有调度引擎」与 `docs/architecture/README.md` 的 `phase1SchemaVersion = 21`：都已与实现不符（引擎由 ADR-0033/FOUNDATION-055 实现，schema 已是 v27），已在本次 doc-sync 中更正并标注更正来源。
- `docs/architecture/agent-adapter-api.md` 的 Codex 段曾写「Runtime 目前没有 `FAILED → READY` 路径」：已由 ADR-0036/FOUNDATION-061 的 `task retry` 关闭，已在文中标注更正。

**仍然保留的写法**：指南里描述的是**源码事实**（例如 §14 写出 `reservations get` 可用）；已修的不一致不再留在清单里。
K1 留下的两条待裁决已由 FOUNDATION-075 收口，因此这份清单**没有剩余的「待裁决」项**；新的不一致应重新开一条（写明位置、原不一致、处置与依据），
不要回头改已归档的历史记录。

### 3.1 FOUNDATION-078 的逐屏走查校准（Wave L / L2）

本格按用户裁决写了一份可以「从头读到尾」的说明书 `manual.md`，并按 ADR-0050 D04 把 `ui.md` 重写为**逐屏走查**。
重写要求「逐个对照 `apps/ui/src/**` 的组件与文案」，于是又把 `docs/guides/**` 里只写在文字上的 UI 位置逐条核了一遍。
下面每一项都**只动指南文字**（`docs/guides/**`），**未改任何代码**（`apps/**`、`packages/**` 一行未动），也未改既有 ADR 正文。

| # | 位置 | 原写法 | 实际渲染（依据） | 本格处置 |
|---|---|---|---|---|
| 1 | `features.md` 影响映射校验 / 影响分析与冲突判定（两行） | UI 位置写「项目 → 影响映射」 | `ImpactPolicyPanel` 渲染在 **`ScheduleTab`** 里（`apps/ui/src/App.tsx:1480` 的 `ScheduleTab`，面板在 `:1499`）；`ProjectTab`（`:1852`）只渲染 `DependencyPanel`（`:1971`）与 `PromotionPanel`（`:1973`） | **已修**：两行都改为「**调度** → 影响映射 · impact.json」；`ui.md` 的逐屏走查按实际渲染写，并加一句「这个面板在『调度』标签页里，不在『项目』标签页里」 |
| 2 | `features.md` Project Knowledge 行 | UI 位置写「项目 → 影响映射旁（只读展示）、任务详情」 | UI 里**没有任何** knowledge 组件：`grep -rn "knowledge" apps/ui/src/` 只命中 `fenceAcknowledged`（终端安全点的一个布尔字段，与 Project Knowledge 无关） | **已修**：改为「—（界面无投影）」；`ui.md` §10 把 `project knowledge *` 列入「只有 CLI」表 |
| 3 | `features.md` Agent 配置行 | UI 位置写「Agent 配置标签页」；CLI 只列 `agent config get/set/clear` | 标签名实际是 **`Agent 设置`**（`App.tsx:42` 的 `tabLabels.plugins`）；FOUNDATION-071 / ADR-0044 已新增 `agent plugins list/select`，且界面有「插件候选」与「清除选择」 | **已修**：改名，并新增一行「Agent 插件选择」能力 |
| 4 | `features.md` 界面主题行 | 写「—（无 CLI 语义；主题不进入命令面）」，UI 位置写「顶部主题选择器」 | ADR-0045 / FOUNDATION-073 后 `theme` **是命令面的一部分**（`settings ui set theme`，见 `apps/cli/src/main.ts` 的 `usage()`）；`ThemeSelector` 挂在**侧栏底部**（`App.tsx:636`），`theme-corner`（`:244`）只在登录前的令牌表单里 | **已修**：CLI 列改为 `settings ui set theme …`；UI 位置改为侧栏底部（并标注登录前的预览副本） |
| 5 | `features.md` 设置行 | 只有 `settings prose-question-attention`，没有 `settings ui` | FOUNDATION-073 / ADR-0045 新增了 `settings ui list/get/set/reset` 与「设置」标签页 | **已修**：新增一行「界面效果设置」；原行改名「设置（散文提问等待）」并注明「设置」标签页只有界面效果五项 |
| 6 | `features.md` 规格修订 / Revision 投递台账（两行） | UI 位置写「任务详情 →「更多操作」」/「任务详情 → 修订投递」 | 任务详情的「更多操作」（`App.tsx:1119`）里只有 `终止`（`:1122`）与 `归档/取消归档`；UI 里**没有** revision 或 delivery 视图（这与 `docs/tasks/README.md` `## NEXT` 第 3 条自己的声明一致） | **已修**：两行都改为「—（界面无入口 / 无投影）」 |
| 7 | `features.md` 重试失败任务行 | UI 位置写「任务详情 → 重试」 | UI 里**没有**重试按钮（同一处 `secondary-actions`；`grep -n "task retry" apps/ui/src/*.tsx` 无命中） | **已修**：改为「—（界面无按钮；『更多操作』只有 `终止` 与 `归档`）」 |
| 8 | `features.md` 分层测试证据行 | UI 位置写「任务详情 → 验证策略来源」 | 任务详情只渲染「最近验证」摘要与证据 JSON（`App.tsx` 的 `verifyReport` 区块），没有「策略来源」面板 | **已修**：改为「—（界面只显示验证结果与证据，无计划/来源面板）」 |
| 9 | `features.md` dev 全量测试证据行 | UI 位置写「任务详情 → 稳定提升记录」 | `promotion full-suite` **没有任何 UI 入口**；「稳定提升记录」是 `promotion list/get` 的只读投影 | **已修**：改为「—（界面无入口）」；下面提升行的 UI 位置加注「**只读投影**，界面不执行提升」 |
| 10 | `features.md` 运行任务 / 暂停恢复 / 多 Adapter / Runtime 生命周期（四行） | UI 位置分别写「运行任务」「暂停 / 恢复」「运行任务（选择 Agent）」「顶部运行状态」 | 实际按钮文案是 `启动 Agent`、`暂停`、`继续`；`Agent` 下拉框只在 `READY` 与 `PAUSED` 时出现（`App.tsx` 的 `task-actions`）；权限模式与事件流状态在**侧栏底部**，顶部只有一句 `本地运行 · 关闭页面不影响任务` | **已修**：四行都按实际文案/位置改写 |
| 11 | `features.md` 文末「明确的未实现与未验证」第 6 条 | 把不一致清单指向「`docs/tasks/README.md` 的 FOUNDATION-070 一节」 | FOUNDATION-070 的 10 项清单已由 FOUNDATION-074/075 处置完毕（本文 §3 的表格就是它的结果），那个指针已过期 | **已修**：改为指向本节与 FOUNDATION-078 |
| 12 | `ui.md`（旧版） | 侧栏导航只列了 6 项（缺 `设置`）且写「Agent 配置」；「项目」标签页一节写有「影响映射 · impact.json」 | 实际有 **7 个**标签（含 `设置`，`App.tsx:42`），标签名是 `Agent 设置`（见第 3 项）；影响映射在调度页（见第 1 项） | **已重写**：`ui.md` 已按 ADR-0050 D04 重写为逐屏走查（外壳 + 7 个标签页 + 只读/可写汇总表） |

**近似但不改的两处**（如实标注，不改，因为不误导找人）：

- `features.md` 后台长命令行的 UI 位置「任务详情 → 长命令进度」：按钮文案是 `验证任务`，`长命令进度` 是结果面板。
  两者在同一屏、彼此相邻，不会把人指到错的地方。
- `features.md` 任务验证行的 UI 位置「任务详情 → 验证任务」：与按钮文案逐字一致，**正确**，列在此处只为说明我核对过。

**本格未能核实的一项**：`docs/guides/**` 之外的文档（例如 `docs/architecture/**`）是否也有同类「UI 位置」陈旧描述**没有核对**——
本格范围是 `docs/guides/**`，没有扩到架构文档（ADR-0050 D07）。

**已归档记录保持只读**：上面这张表与 FOUNDATION-074/075 的历史表格都不回改；新的不一致应重新开一条。

---

## 4. 明确的未验证 / 未实现（不要按「已有」使用）

1. 真实 provider 的**并发运行**未完成受控验收（调度本身有实现与门禁）。
2. 真实模型下的**暂停 / 恢复**未复验；ADR-0016 的编排由脚本 Adapter 覆盖。
3. **Provider 是否真的读取** Project Knowledge 物化文件未验证（Adapter 尚不消费 `knowledgeSnapshotRefs`）。
4. **token 级实时流**未实现；transcript 是按需读取 + 轮询。
5. **Codeestra 自升级 / Self Promotion 的完整切换**未实现（Phase 7）。
6. ~~**Session Guidance 未实现**：`guide` 端口既未导出也未实现，`SessionGuidanceRecorded`/`SessionGuidanceDelivered` 仍未实现。~~
   **已实现（FOUNDATION-088 / ADR-0057 / schema v31）**：`session guide`（命令名 `session.guidance.record`）把一条指导交给
   运行中的会话并记录它产生的事实，`session guidance list|get` 读账本；`guide` 端口在 Pi 上实现（RPC `steer` + provider 自己的
   `queue_update`），Codex 报 `REQUIRES_VALIDATION`、Claude Code 报 `UNSUPPORTED`。
   **仍未验证**：真实模型是否真的读了 guidance、真实 Pi 在忙碌轮次里是否接受 `steer`；**不要**把 `DELIVERED` 读成「模型已读」
   （命令面里的 `modelAcknowledgement` 恒为 `UNSUPPORTED`），UI 也没有投影（N3 领地）。
7. ~~多成员 IntegrationBatch 与批级 `STALE`/`CANCELLED`~~ **已由 ADR-0066 从产品中删除**（连同 `task integrate`、
   `task integration *`、`promotion *` 与全部集成/提升表）。成果停在 `refs/heads/task/<task-id>`，合并由用户自己完成；
   本仓库自身的 `dev → main` 继续走 `AGENTS.md` 的人工四步。
8. **Claude Code 的模型层全部未验证**（本机 `claude auth status` 为未登录）：该 Adapter 的 `structuredAttention`/`nativePermissionRouting`/`cooperativeStop`/`resumeAfterExit` 均报 `REQUIRES_VALIDATION`，不得当成 `SUPPORTED` 使用。
9. **插件选择的真实效果未验证**（ADR-0044）：真实模型下「确实使用了所选 skill/theme」只有 argv 与命令面证据；themes 的显式路径加载未单独实测（ADR-0044 D06 标注为同构代码路径推断）；第三方 extension 是否能绕过 gate 未做对抗验证。
10. **真实 provider 下的散文提问组合未验收**：`Task WAITING_FOR_USER` + `Execution RUNNING` + `Session EXITED` 只在存储/运行时单测与 stub e2e 下验证；Codex 侧的事实层未实现（只漏报、不谎报）。
11. **观感类只能人工确认**（ADR-0008）：设置页与五个界面设置键的视觉效果、紧凑密度/字号/`reduced` 动效的观感、固定 shell 在窄屏与矮窗口的表现、Agent 设置页在窄屏下的排布，都没有机器断言。
12. 本格（FOUNDATION-074，纯文档 + 一处 usage 文本）未运行任何全量/聚合检查（ADR-0038）；实际执行的定向检查（文档链接存在性、`bun run typecheck`、状态声明依据核对）见
   `docs/tasks/README.md` 的 FOUNDATION-074 一节。
13. FOUNDATION-075（规格状态段对齐 + `intents.kind` 缩小，schema v28）同样未运行任何全量/聚合检查（ADR-0038）；实际执行的定向检查见
   `docs/tasks/README.md` 的 FOUNDATION-075 一节。另外两件**未验证**的事：真实稳定 Runtime 上的 v27→v28 升级未执行（禁止触碰稳定工作树与稳定 Runtime），
   以及 v28 迁移「升级后比对行数」的第二道网没有直接测试（除了 kind 列之外重建不引入新约束，构造不出前置检查看不到的复制失败）。
14. FOUNDATION-078（用户说明书 + 逐屏 UI 走查 + recipes + 人工核对清单 + 插图位，**纯文档**）未运行任何代码检查：
   本格无代码改动，因此 `bun run typecheck` 与 `bun run typecheck:ui` **都没有跑**（两者都会在无改动时给出无信息的绿灯）；
   同样**没有跑** `bun run check` / `just check` / `just verify` / `check:fast`（ADR-0038 禁止在 `lane/*` 分支跑聚合检查）。
   实际跑的只有两类可复现断言：文档内链接存在性，以及命令/标签页/按钮文案对源码的核对；命令与结果见
   `docs/tasks/README.md` 的 FOUNDATION-078 一节。**未验证**：全部观感类结论（见 [acceptance-checklist.md](./acceptance-checklist.md)）、
   插图的真实效果（图尚未提供）、以及浏览器里的真实点击路径。
15. **ADR-0065（任务输入字段：两个必填标题 + 删除约束与任务类型，schema v35）**：**未验证**的是真实稳定 Runtime 上的 v34→v35 升级
   （禁止触碰稳定工作树与稳定 Runtime）与停靠条三字段的排版/焦点/窄屏换行（观感类，只能人工确认，见 [acceptance-checklist.md](./acceptance-checklist.md) J1–J5）。
   **已补的不是缺口**：v35 重建两张表，其复制失败防护（行数比对 + 结束态断言）与「正文没有任何非空白字符、无法派生标题」的拒绝路径都有直接测试
   `packages/storage/test/task-input-fields-migration.test.ts`——这正是上面第 13 条记的 v28「第二道网没有直接测试」在本步被补上的部分。

---

## 相关阅读

- 每条命令的参数、退出码与码位：[cli/README.md](./cli/README.md)（八篇索引）
- 领域概念（为什么 `UNKNOWN` 不代表“无冲突”、为什么 Task 验证 ≠ 集成验证）：[concepts.md](./concepts.md)
- 完整流程：[workflow.md](./workflow.md)
