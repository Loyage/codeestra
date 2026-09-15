# 常见故障与稳定码表

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

### 界面打不开：`UI_ASSETS_MISSING`

```text
The UI assets were not found at <dir>. Build them with: bun run --cwd apps/ui build
```

`apps/ui/dist` 是 gitignore 的本地状态，每个工作树各自构建：

```sh
bun run build:ui
```

### 界面说令牌无效 / 旧链接突然失效：`UNAUTHORIZED`

Runtime **每次启动都会换内存 token**。重新执行：

```sh
bun run codeestra ui            # 或 bun run codeestra open . 
```

把旧标签页丢掉即可。token 只在 URL fragment 与浏览器 sessionStorage 里，不会进入服务端日志。

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

### `project trust` 报 `DEV_REF_MISSING`

Codeestra 要求项目长期保留 `main` 与 `dev`（ADR-0009），并且**所有功能 Task 从固定 `dev` commit 建基线**。
先在项目里创建 `dev` 分支，再 trust。

### `project trust` 报 `VERIFICATION_POLICY_CHANGED` / `IMPACT_POLICY_CHANGED` / `REPOSITORY_CHANGED`

在你**查看**与**确认**之间，`main` ref 上的策略文件 / 影响映射 / 仓库身份变了。
这是防漂移，不是 bug。重新执行一次 `project trust`（或 `open`），重新看一遍再确认。

### 所有冲突判定都是 `UNKNOWN`，任务绝不并行

看映射：

```sh
bun run codeestra project impact validate /path/to/repo
```

`POLICY_ABSENT` / `POLICY_INVALID` / `POLICY_NOT_CONFIRMED` 都会让每个判定变成 `UNKNOWN`——
**`UNKNOWN` 不是「无冲突」的软版本**，它默认等待。修好 `.codeestra/impact.json` 并重新 trust
（同一 trust 事件会一并确认映射）。

确认「无法证明」的具体原因用：

```sh
bun run codeestra project impact explain $PROJECT <task-id> --json
```

### 任务一直不跑（退出码 3）

`3` 表示**等待**，不是失败。三种互不相同的答案：

| 现象 | 含义 |
|---|---|
| `WAIT_CONFLICT` | 与某个活跃/已预留 Task 的影响重叠未证明安全 |
| `WAIT_CAPACITY` | 项目级上限或 Adapter 上限已满（`CAPACITY_GLOBAL_LIMIT_REACHED` / `CAPACITY_ADAPTER_SLOT_LIMIT_REACHED`） |
| `SCHEDULER_DRAINING` | Runtime 正在 draining，不接受新的 slot |

看谁占着：

```sh
bun run codeestra scheduler capacity get $PROJECT --json
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

### 稳定提升被拒

| 码 | 含义 / 怎么办 |
|---|---|
| `DEV_FULL_SUITE_EVIDENCE_MISSING` | 这个精确 dev SHA 没有全量测试证据 → `promotion full-suite run --dev-commit <full-sha>` |
| `DEV_FULL_SUITE_EVIDENCE_NOT_PASSED` | 有证据但不是 PASSED。修好再跑一次 |
| `DEV_FULL_SUITE_EVIDENCE_STALE` | **三处绑定之一变了**：main 上的策略被编辑、候选里的锁文件变了、或出现了更新的失败运行 |
| `PROMOTION_EVIDENCE_MISMATCH` | 用于 `prepare` 的事实与记录不一致 |
| `PROMOTION_NOT_APPROVED` | **仅 STRICT**：需要针对那一组精确三元组的 `promotion approve` |
| `APPROVAL_NOT_REQUIRED` | FULL 下调了 `approve` |
| `PROMOTION_NOT_FAST_FORWARD` | main 已经不是预期的那一个（不能快进） |
| `PROMOTION_NOTHING_TO_PROMOTE` | dev 与 main 已经相同 |
| `PROMOTION_STALE` | 提升记录已过期；重新 `prepare` |
| `PROMOTION_IN_PROGRESS` | 该项目已有一个未结束的 promotion（数据库有唯一索引保证） |
| `PROMOTION_FINISHED` / `PROMOTION_STATE_INVALID` | 该 promotion 已结束 / 状态不允许这一步 |
| `MAIN_WORKTREE_MISSING` / `MAIN_WORKTREE_DIRTY` | 没有检出 main 的工作树 / 它不干净。**提升必须能推进 ref、index 与工作文件**，所以要求工作树可用且干净 |
| `MAIN_REF_MOVED` / `DEV_REF_MOVED` / `MAIN_NOT_UPDATED` / `MAIN_UPDATE_FAILED` | ref 事实与预期不符 / 推进失败 |
| `RESTART_STEP_FAILED` / `RESTART_UNPROVEN` / `RUNTIME_NOT_OBSERVED` / `RUNTIME_NOT_RESTARTED` / `RUNTIME_NOT_READY` / `RESTART_PLAN_MISMATCH` | 后置步骤或重启无法核验。**重启只在每步退 0 且 Runtime 回答 READY 时被记录** |
| `BATCH_NOT_INTEGRATED` | 引用的集成批次还没到 `INTEGRATED` |
| `INVALID_COMMIT_ID` / `REPOSITORY_CHANGED` | commit 参数不合法 / 仓库身份变化 |

**失败不会自动回滚**：若 main 已被 fast-forward 而重启序列失败，CLI 会明确打印「main 已被推进且未回滚；
Runtime 恢复应答后重跑 `promotion promote` 会重跑已记录的后置步骤」。

### `RECOVERY_REQUIRED`（状态，不是错误码）

它是**多个实体都有的状态**，含义是「有事实无法被证明，需要一次带审计的对账」，**不是让你重试掩盖它**：

| 位置 | 含义 |
|---|---|
| Task / Execution 状态 | 执行的所有权或静止性无法证明 |
| Agent Session 状态 | provider 进程身份无法确认 |
| Workspace 状态 | worktree 归属无法核验 |
| IntegrationBatch 状态 | 集成被中断，现场保留 |
| Promotion 状态 | main 更新或重启无法核验 |
| Attention kind `RECOVERY` | 需要人处理的一条恢复请求 |
| `scheduler reservations reconcile` 的 `RECOVERY_REQUIRED` | 预留持有者活着或无法核验，**槽位保留**（不发信号、不删资源） |

相关码：`RECONCILE_REQUIRED`（操作被拒绝并要求对账，例如 `TASK_PAUSED` 的 retry、
`task operation cancel` 的某些路径）。

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
bun run codeestra permission set strict
bun run codeestra project trust /path/to/repo    # 重新确认当前策略 digest
```

### 事件订阅中止，收到 `INVALID_CURSOR`

你的游标**大于** Runtime 日志的最新序号。这是刻意的：**未知游标被告知，而不是被静默裁剪**。

重新取快照，再用新游标订阅：

```sh
bun run codeestra events list --limit 1        # 或者从你保存的最后一个游标开始
```

其他订阅结束原因：`EVENT_READ_FAILED`（读取事件出错）、`SUBSCRIPTION_FAILED`（HTTP 侧订阅失败）。

### 别的地方也出现 `CONCURRENT_MODIFICATION`

这是**乐观并发**拒绝：你手上的 version 已经过期。重新读一次当前值，用新的 expected version 再提交。
不要用「重试直到成功」掩盖它——它存在的原因正是防止覆盖别人的修改。

---

## 2. 稳定码速查表（按领域）

### 边界与用法

| 码 | 来源 | 含义 |
|---|---|---|
| `INVALID_REQUEST` | HTTP `/api/command` | 请求体不符合 Zod schema（400） |
| `INVALID_JSON` | HTTP `/api/command` | 请求体不是 JSON（400） |
| `UNAUTHORIZED` | HTTP | 缺少/错误的 Bearer token（401） |
| `FOREIGN_ORIGIN` | HTTP | `Origin` 主机或端口不匹配（403） |
| `UNSUPPORTED_MEDIA_TYPE` | HTTP | `Content-Type` 不是 `application/json`（415） |
| `METHOD_NOT_ALLOWED` | HTTP | 方法不对（405） |
| `NOT_AVAILABLE_OVER_HTTP` | HTTP | `events.subscribe` / `runtime.ui` 不走 HTTP（400） |
| `NOT_FOUND` | HTTP / 各服务 | 资源不存在 |
| `INTERNAL_ERROR` | HTTP | 服务端未归类异常（500） |
| `INVALID_CURSOR` | 事件订阅 / HTTP `/api/events` | 游标超前于日志；订阅结束 |
| `EVENT_READ_FAILED` | 事件订阅 | 读取事件失败 |
| `SUBSCRIPTION_FAILED` | 事件订阅 | 订阅建立失败 |
| `CONCURRENT_MODIFICATION` | 多处 | 乐观版本冲突 |
| `VERSION_CONFLICT` | Task 提交等 | 同上 |
| `INVALID_STATE` / `INVALID_TRANSITION` / `INVALID_VALUE` | 领域 / storage | 状态或取值不允许 |
| `UNSUPPORTED_INTENT_KIND` | storage（`assertIntentKind`） | Intent 取值不在 schema v28 收窄后的 `intents.kind` 集合内（ADR-0046）；边界直接拒绝，报文列出可接受取值 |

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
以及所有 `KNOWLEDGE_*`（在 [cli-reference.md](./cli-reference.md) 的 `project knowledge` 一节与
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

`CAPACITY_WAIT`、`CONFLICT_WAIT`、`CAPACITY_GLOBAL_LIMIT_REACHED`、`CAPACITY_ADAPTER_SLOT_LIMIT_REACHED`、
`CAPACITY_LIMIT_INVALID`、`CAPACITY_LIMIT_OUT_OF_RANGE`、`SCHEDULER_DRAINING`、`TASK_NOT_STARTABLE`、
`SLOT_ALREADY_RESERVED`、`SLOT_ALREADY_BOUND`、`SLOT_NOT_ACTIVE`、`SLOT_HELD_BY_ANOTHER_RUNTIME`、
`SLOT_HOLDER_STILL_RUNNING`、`HOLDER_STILL_RUNNING`、`HOLDER_STOPPED`、`HOLDER_PROCESS_ID_REUSED`、
`HOLDER_OWNERSHIP_UNVERIFIABLE`、`PROCESS_IDENTITY_MISSING`、`NOT_HELD`、`REVISION_CHANGED`、
`SNAPSHOT_STALE`、`SNAPSHOT_UNAVAILABLE`、`NOT_A_CANDIDATE`、`SCHEDULE_TICK_FAILED`、`NOT_UNKNOWN`。

### 验证 / 集成 / 提升

`VERIFICATION_FAILED`、`VERIFICATION_NOT_PASSED`、`VERIFICATION_JOB_FAILED`、`VERIFICATION_QUEUED`、
`COMMAND_FAILED`、`COMMAND_TIMEOUT`、`CANCEL_UNCONFIRMED`、`NOT_CANCELLABLE`、
所有 `TARGETED_TEST_PLAN_*`、
`INTEGRATION_BATCH_INVALID`、`INTEGRATION_IN_PROGRESS`、`INTEGRATION_VERIFICATION_FAILED`、
`MERGE_CONFLICT`、`MERGE_FAILED`、`MERGE_HEAD`、`REF_CONFLICT`、`UNRELATED`、`NOT_REACHABLE_FROM_DEV`、
`HEAD_MISMATCH`、`UNEXPECTED_HEAD`、`BRANCH_DIVERGED`、`BRANCH_ABSENT`、`BRANCH_MISMATCH`、
`BRANCH_CHECKED_OUT_ELSEWHERE`、`UNBORN_MAIN`、
以及所有 `PROMOTION_*` 与 `DEV_FULL_SUITE_EVIDENCE_*`（见上文与 [cli-reference.md](./cli-reference.md) 的 `promotion` 一节）。

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

## 3. 文档与实现不一致的处置（FOUNDATION-074 校准 + FOUNDATION-075 收口）

J1（FOUNDATION-070）曾在上一版这里如实列出 10 项「文档与实现不一致」，并明确「没有在文档里被悄悄改掉、只列出不裁决」。
FOUNDATION-074（Wave K / K1 文档校准）逐条处置了这份清单：**8 项已修**（含唯一一处代码改动：`apps/cli/src/main.ts` 的 `usage()` 文本），
**2 项保留为「待裁决」**——它们需要用户裁决，本格没有自行改。用户于 2026-09-15 就这两项作出裁决，
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

---

## 4. 明确的未验证 / 未实现（不要按「已有」使用）

1. 真实 provider 的**并发运行**未完成受控验收（调度本身有实现与门禁）。
2. 真实模型下的**暂停 / 恢复**未复验；ADR-0016 的编排由脚本 Adapter 覆盖。
3. **Provider 是否真的读取** Project Knowledge 物化文件未验证（Adapter 尚不消费 `knowledgeSnapshotRefs`）。
4. **token 级实时流**未实现；transcript 是按需读取 + 轮询。
5. **Codeestra 自升级 / Self Promotion 的完整切换**未实现（Phase 7）。
6. **Session Guidance 未实现**：`guide` 端口既未导出也未实现，`SessionGuidanceRecorded`/`SessionGuidanceDelivered` 仍未实现。
7. **多成员 IntegrationBatch 与批级 `STALE`/`CANCELLED` 未实现**：`task.integrate` 每次只集成一个 Task；因此产品 `promotion prepare` 至今没有在这些提升候选上成立（三次真实提升走的是 AGENTS.md 的人工路径）。
8. **Claude Code 的模型层全部未验证**（本机 `claude auth status` 为未登录）：该 Adapter 的 `structuredAttention`/`nativePermissionRouting`/`cooperativeStop`/`resumeAfterExit` 均报 `REQUIRES_VALIDATION`，不得当成 `SUPPORTED` 使用。
9. **插件选择的真实效果未验证**（ADR-0044）：真实模型下「确实使用了所选 skill/theme」只有 argv 与命令面证据；themes 的显式路径加载未单独实测（ADR-0044 D06 标注为同构代码路径推断）；第三方 extension 是否能绕过 gate 未做对抗验证。
10. **真实 provider 下的散文提问组合未验收**：`Task WAITING_FOR_USER` + `Execution RUNNING` + `Session EXITED` 只在存储/运行时单测与 stub e2e 下验证；Codex 侧的事实层未实现（只漏报、不谎报）。
11. **观感类只能人工确认**（ADR-0008）：设置页与五个界面设置键的视觉效果、紧凑密度/字号/`reduced` 动效的观感、固定 shell 在窄屏与矮窗口的表现、Agent 设置页在窄屏下的排布，都没有机器断言。
12. 本格（FOUNDATION-074，纯文档 + 一处 usage 文本）未运行任何全量/聚合检查（ADR-0038）；实际执行的定向检查（文档链接存在性、`bun run typecheck`、状态声明依据核对）见
   `docs/tasks/README.md` 的 FOUNDATION-074 一节。
13. FOUNDATION-075（规格状态段对齐 + `intents.kind` 缩小，schema v28）同样未运行任何全量/聚合检查（ADR-0038）；实际执行的定向检查见
   `docs/tasks/README.md` 的 FOUNDATION-075 一节。另外两件**未验证**的事：真实稳定 Runtime 上的 v27→v28 升级未执行（禁止触碰稳定工作树与稳定 Runtime），
   以及 v28 迁移「升级后比对行数」的第二道网没有直接测试（除了 kind 列之外重建不引入新约束，构造不出前置检查看不到的复制失败）。

---

## 相关阅读

- 每条命令的参数、退出码与码位：[cli-reference.md](./cli-reference.md)
- 领域概念（为什么 `UNKNOWN` 不是 `SAFE`、为什么 Task 验证 ≠ 集成验证）：[concepts.md](./concepts.md)
- 完整流程：[workflow.md](./workflow.md)
