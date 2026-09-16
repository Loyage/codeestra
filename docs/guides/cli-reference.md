# CLI 命令参考

> **适用版本** `dev@75fa7b8`（2026-09-15） · **schema** v30 · **最后校对** 2026-09-15
> 版本会前进：`dev@75fa7b8` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。
> §7 的 `session handoff terminal resize` 一节由 FOUNDATION-083 校对（ADR-0054）。

本文覆盖 `apps/cli/src/main.ts` 中 `usage()` 列出的**每一个命令组**，以及 Runtime 的 HTTP/SSE 面。
所有事实来自源码核对；核对方法见 `docs/tasks/README.md` 的 FOUNDATION-070 一节。

调用形式统一是：

```sh
bun run codeestra <group> [<action>] [<argument>…] [--flag …]
```

（`bun run codeestra` 对应 `package.json` 的 `"codeestra": "bun run apps/cli/src/main.ts"`。）

---

## 0. 通用约定

### 0.1 连接与自动启动

- CLI 通过 `CODEESTRA_HOME`（默认 `$XDG_STATE_HOME/codeestra` 或 `~/.local/state/codeestra`）下的
  Unix socket `runtime.sock` 与 Runtime 通信。
- 除 `stop` 外，**任何命令都会在需要时自动拉起 Runtime**（先 `runtime.ping`，超时后 spawn 并以 50ms 间隔最多探测 50 次）。
  `stop` 刻意**不**启动它要停的东西。
- 输出是 JSON（`JSON.stringify(value, null, 2)`）。人读视图只存在于少数命令的**默认**（非 `--json`）分支：
  `project impact validate/show/explain`、`project knowledge *`、`task depends list`、`task transcript`、
  `session transcript`、`task operation list/get`、`promotion promote`。
- 其余命令默认就是 JSON，`--json` 的作用是**让脚本声明意图**而不是改变输出。
- 错误写到 stderr，形如 `CODE: message`；带事实的拒绝（例如 `SNAPSHOT_STALE`）会先打印一段 JSON 再退 1。

### 0.2 退出码

| 码 | 含义 |
|---|---|
| `0` | 成功。注意：某些命令的成功是「已受理」而不是「已完成」（见各命令说明） |
| `1` | 拒绝或失败（含 `RECOVERY_REQUIRED` 这类需要人处理的状态） |
| `2` | **用法错误**：参数个数/取值不合法、未知 flag、缺少必填 flag（`usage()` 与个别显式 `process.exit(2)`） |
| `3` | **等待**（调度冲突/容量等待、draining、`promotion promote` 的「已推送、等待拉取」）或**没什么可做**（reclaim 计划/执行没有可回收项） |

`3` 从不表示 `BLOCKED`：`BLOCKED` 只表示**依赖未满足**，它属于「需要处理」而不是「等一等」。
`3` 也从不表示「已完成」：提升在「已推送、等待拉取」时退 `3`，该状态下没有任何重启记账。

### 0.3 环境变量

| 变量 | 作用 |
|---|---|
| `CODEESTRA_HOME` | Runtime 数据目录（决定单实例身份与 socket 位置） |
| `CODEESTRA_UI_DIST` | 覆盖 Web UI 资产目录（默认 `apps/ui/dist`） |
| `CODEESTRA_SCHEDULE_TICK_MS` | 周期调度 pass 间隔，默认 `5000` |
| `CODEESTRA_PI_EXECUTABLE` / `CODEESTRA_PI_GATE_EXTENSION` / `CODEESTRA_PI_QUESTION_EXTENSION` / `CODEESTRA_PI_SESSION_DIR` / `CODEESTRA_PI_PLATFORM` | Pi Adapter 的可执行文件、gate/question 扩展、会话目录、平台 |
| `CODEESTRA_CODEX_EXECUTABLE` / `CODEESTRA_CODEX_HOME` / `CODEESTRA_CODEX_REQUEST_USER_INPUT` | Codex Adapter |
| `CODEESTRA_CLAUDE_EXECUTABLE` | Claude Adapter |
| `CODEESTRA_PI_PROVIDER` / `CODEESTRA_PI_MODEL` / `CODEESTRA_PI_THINKING`（以及 Codex/Claude 对应变量） | Agent 配置的**逐字段最高优先级**临时覆盖（只对该 Runtime 进程生效） |

`CODEESTRA_PERMISSION_MODE` 不是用户输入：它由 Runtime 在**启动 provider / 终端时自己写入**，用来把当前权限模式传给受控 gate；用户切换模式请用 `permission set`。

`runtime.ping` 返回的 `adapters` 会列出已注册的 Adapter ID：当前是 `pi`、`codex`、`claude`。

---

## 1. Runtime 生命周期与权限

### `status`

```sh
bun run codeestra status
```

自动启动 Runtime（若不在跑），打印 `runtime.ping` 结果 + 从本 home 生命周期记录读出的 ownership 报告
（`lock` / `traces` / `endpointAnswers` / `verdict` / `unreadableRecords`）。

- **只读**：一个「进程在但不应答」的 Runtime 会被如实报告（`status: "UNAVAILABLE"`），不会被新建的实例掩盖。
- 退出码：`0` Runtime 可用；`1` 连不上且起不来。

### `stop`

```sh
bun run codeestra stop [--wait <seconds>]
```

`--wait` 接受 `0`–`600`（默认 `10`）。两阶段、只报事实：

| 输出 `status` | 含义 | 退出码 |
|---|---|---|
| `STOPPED` | 被点名的进程确实消失了（含僵尸：socket 与文件已释放） | `0` |
| `NOT_EXITED` | 等待期限内进程还在 | `1` |
| `NOT_RUNNING` | 没有 Runtime 拥有这个 home | `0` |
| `UNREACHABLE_PROCESS` | 进程还在但 socket 不应答（**不猜着杀**） | `1` |
| `STOP_FAILED` | 请求被接受但没有可核验的身份，或 Runtime 没接受请求 | `1` |

`pidMismatch` 字段表示「stop 应答点名的进程」与「ping 应答的进程」不同——那是两个 Runtime 争同一个 home 的事实，必须被看到。
`--wait` 之外的参数是用法错误（退出码 2）。

### `permission get` / `permission set`

```sh
bun run codeestra permission get
bun run codeestra permission set <full|strict>
```

`get` 返回 `{ mode, default: "FULL" }`。`set` 接受大小写不敏感的 `full` / `strict`，**无需确认**，写入
`<CODEESTRA_HOME>/permission-mode.json`（0600，原子替换）。其他取值是用法错误。

### `ui`

```sh
bun run codeestra ui [--no-open]
```

在 `127.0.0.1` 上按需启动 HTTP + SSE 并打印地址（token 在 fragment）。`--no-open` 只打印不打开浏览器。
除 `--no-open` 外不接受任何参数。

常见失败：`UI_ASSETS_MISSING`（界面资产目录下没有 `index.html`；提示信息给出 `bun run --cwd apps/ui build`）。

### `open`

```sh
bun run codeestra open [path] --dev-repo <dev-clone> [--yes] [--no-open]
```

一条命令完成：`project.inspect` → 展示验证策略与影响映射 →（必要时）确认 → `project.trust` → `runtime.ui` 并预选该项目。
`path` 默认当前目录；`--yes` 是 STRICT 下的非交互确认；`--no-open` 不打开浏览器。

`--dev-repo <dev-clone>` 是**必需**的：这条命令会组合一次 `project trust`，而 trust 必须显式给出 dev clone
（ADR-0056，见下面 `project trust`）。省略时 trust 以 `DEV_REPO_REQUIRED` 拒绝。
（打开一个**已信任**仓库的另一个工作树时 trust 会被跳过，因此那条路径不需要该 flag。）

已经确认过且策略 digest 未变时会跳过确认（正常路径**一次项目一次确认**；FULL 下没有这一步）。
失败：确认被拒（`Project trust was not confirmed`）、trust 后项目未出现在列表中、`DEV_REPO_REQUIRED`、
`DEV_REPO_*`。

---

## 2. `agent config`

```sh
bun run codeestra agent config get   [--project <project-id>] [--adapter <id>]
bun run codeestra agent config set   [--project <project-id>] [--adapter <id>]
  [--provider <name>] [--model <id>] [--thinking <off|minimal|low|medium|high|xhigh|max>]
  [--unset provider|model|thinking]
bun run codeestra agent config clear [--project <project-id>] [--adapter <id>]
```

- `--adapter` 默认 `pi`。不带 `--project` 表示**全局默认**，带 `--project` 表示**该项目覆盖**。
- 每个字段都可选，所以 `set` 是合并式写入；`--unset <field>` 清空一个字段而不动其他字段。
- 同一个字段**不能**既给值又 `--unset`（用法错误）。
- `--thinking` 的合法值就是上面那 7 个。
- `get` / `clear` 不接受 `--provider` / `--model` / `--thinking` / `--unset`（用法错误）。

解析优先级**逐字段**：`环境变量 > 项目覆盖 > 全局默认 > Adapter 默认`。
**只影响此后新建的 Session**，并把当时生效的值记录在 Execution 上（`task status` 与 UI 都能看到）。
Adapter 不支持的字段会被拒绝而不是静默忽略。稳定码：`INVALID_AGENT_CONFIGURATION`、`UNKNOWN_ADAPTER`。

---

## 3. `project`

### `project inspect [path] [--dev-repo <dev-clone>]`

读仓库身份：`repoRoot`、`mainRef`、`objectFormat`、`headCommit`、`gitCommonDir`，
以及 `devRepoPath` —— 项目记录的 dev clone 的**核验结果**（ADR-0047 D05）：`verified`、`code`、`detail`、`repoRoot`、
`gitCommonDir`、`headCommit`、`branchRef`、`devRefCommit`、`originUrl`、`originMatchesProject`、`clean`。
`path` 默认当前目录；`--dev-repo <path>` 改为核验**指定**的那个 clone（在 trust 之前先看它是否可用），省略时核验已记录的那个。

**开发基线来自 dev clone（ADR-0056）**：`devRef` / `devCommit` / `devRefPresent` 描述的是**dev clone 的**本地 `dev`
分支 —— 也就是 Task 基线、集成目标与提升候选的来源。没有可核验的 dev clone 时 `devCommit` 是 `null`、`devRefPresent`
是 `false`：这不是「没有 dev 分支」，而是「没有可读 dev 事实的仓库」，此时**任何需要 dev 基线的操作**都以
`DEV_REPO_REQUIRED` 拒绝并打印补救命令。

`devRefRetirement` 是**只读的退役证据**（ADR-0048 D04 / ADR-0056），描述的是**被检查的那个检出自己**的本地 `dev` ref：

| 字段 | 含义 |
|---|---|
| `localDevRefPresent` / `localDevRefCommit` | 该检出里是否仍有过渡的本地 `dev` ref，以及它指向哪个 commit |
| `projectsWithoutDevRepo[]` | 仍**没有** dev clone 的已信任项目（`projectId`/`name`/`repoRoot`） |

Runtime **不再从那个 ref 读任何 dev 事实**。该列表为空表示没有任何项目依赖它 —— 这是「可以人工删除它」的只读依据
（见 `docs/guides/manual.md` §3.4）。失败码含 `INVALID_REPOSITORY`、`UNSAFE_CHECKOUT`、`GIT_INSPECTION_FAILED`；
dev clone 的拒绝是 `DEV_REPO_*`（见下）。

### `project policy [path]`

打印 `main` ref 上 `.codeestra/policies/verification.json` 的检查结果：`state`（`PRESENT` / `ABSENT` / `INVALID`）、
`mainCommit`、`digest`、逐条 `commands`。缺失时提示「task verify 会拒绝直到该 ref 上存在此文件」。

### `project trust [path] --dev-repo <dev-clone> [--yes]`

接入项目。**前提**：合法 Git 仓库；dev clone 上的 `dev` 分支存在。**影响**：Agent 工具、验证命令与 Git hooks
会以你的用户权限运行。FULL 无确认；STRICT 需要输入 `TRUST` 或 `--yes`。

`--dev-repo <path>` 是**必需**的（ADR-0056）：dev clone 是**全部 dev 事实的唯一来源**（Task 基线、集成目标、提升候选、
全量证据的副本根与锁文件），因此 trust 必须显式声明它。

| 稳定码 | 含义 |
|---|---|
| `DEV_REPO_REQUIRED` | 省略 `--dev-repo`，或写了 `--dev-repo none`：dev clone 是必需的，拒绝发生在**任何写入之前**，项目不会被登记；补救命令就打印在消息里 |

Runtime 对给出的路径逐条核验，任一条不成立即用稳定码拒绝，**不会**写入一个空路径而继续：

| 稳定码 | 含义 |
|---|---|
| `DEV_REPO_NOT_A_REPOSITORY` | 路径不存在或不是 Git work tree |
| `DEV_REPO_NOT_SEPARATE` | 它是 main 检出自身或 main 检出的一个 worktree（同一个 Git common dir），不是另一个 clone |
| `DEV_REPO_ORIGIN_UNKNOWN` | main 检出或该 clone 没有 `origin`，无法比较 |
| `DEV_REPO_ORIGIN_MISMATCH` | 它的 `origin` 与 main 检出的 `origin` 不同 |
| `DEV_REPO_BRANCH_MISMATCH` | 它的 HEAD 不在项目的 `dev` 分支上 |
| `DEV_REPO_DEV_REF_MISSING` | 它没有本地 `dev` 分支 |

重 trust 也必须给出 `--dev-repo`（`--dev-repo none` 不再有意义：清除它只会让项目读不到任何 dev 事实）。
失败时退 `1`；CLI 同时打印核验结果（`verified` / `code` / `detail`），因为 `project trust` 会先打印身份、策略与结果三份文档。

防漂移：若在你查看与确认之间身份/策略/映射/dev clone 发生变化，返回 `REPOSITORY_CHANGED`、
`VERIFICATION_POLICY_CHANGED`、`IMPACT_POLICY_CHANGED`。dev clone 上没有 `dev` 分支返回 `DEV_REPO_DEV_REF_MISSING`。
同一仓库的其他工作树（同一 Git common dir）重复 trust 是幂等的。

**两个 clone 各自拥有什么（ADR-0056）**：

| 事实 | 仓库 | 谁读 |
|---|---|---|
| 仓库身份、`main` ref、`.codeestra/policies/verification.json`、`.codeestra/impact.json` | main 检出（`projects.repo_root`） | `project policy`、`project impact *`、Task 验证与集成的策略读取、提升的重启序列 |
| 长期 `dev` 分支、Task 分支与 worktree、集成 worktree 与 ref 推进、提升候选对象、全量证据的副本与锁文件 | dev clone（`projects.dev_repo_path`） | Task 基线、依赖判定、验证副本、结果 commit、回收、`promotion full-suite run`、`promotion promote` 的 push |

### `project list`

列出已信任项目。打开仓库的另一个工作树**不会**产生第二个 Project。

### `project impact validate [path] [--json]`

读取 `main` ref 上的 `.codeestra/impact.json`，报告 `code`（`OK` / `OK_UNTRUSTED` / `POLICY_ABSENT` /
`POLICY_INVALID` / `POLICY_NOT_CONFIRMED`）、映射摘要（重要目录 / 模块 / 全局资源数量）、`analyzerVersion` 与警告。
**退出码 `0` 仅当映射存在且是已确认的那一份**；否则 `1`。

含义提醒：没有映射就不可能证明「可并行」，所以每个冲突判定都是 `UNKNOWN`，任何东西都不会并行。

### `project impact show <project-id> <task-id> [--json]`

打印这一个 Task 的 `ImpactSnapshot`：`disposition`（`RECORDED` / `REUSED` / `UNAVAILABLE`）、
`complete` 与 `incompleteReasons`、baseline 与项目 dev 基线是否一致、变更路径、重要目录、模块、共享资源、证据。
**退出码 `1` 当且仅当完全没有快照**（change set 无法观察）；不完整但存在的快照仍然正常打印（`complete: false`）。

### `project impact explain <project-id> <task-id> [--json]`

在 `show` 的基础上，与**每一个活跃/已预留 Task** 比较，并给出 `assessment.verdict` 与理由码。
**退出码 `0` 仅当 `SAFE_TO_PARALLELIZE`**；`UNKNOWN` 与 `CONFLICTING` 都是 `1`（代码在 `--json` 里）。

### `project knowledge validate <project-id> [--json]`

报告分层知识（`instructions` / `skills` 从项目 `main` ref 读，机器生成层来自 Runtime 数据目录）、
每条被拒条目的 `code` 与消息、`snapshotDigest` / `humanDigest` / `generatedDigest`、条目与字节统计。
**退出码 `0` 仅当层完整**；有任何条目被拒 → `1`（此时根本不存在快照）。

### `project knowledge list <project-id> [--json]`

在 `validate` 的输出之上，追加当前条目清单与**已记录快照**列表。退出码同 `validate`。

### `project knowledge show <project-id> [snapshot-id] [--json]`

读回一个已记录快照及其绑定到该快照的 Execution 列表。缺 `snapshot-id` 时读最新快照。
均无快照时以 `KNOWLEDGE_SNAPSHOT_NOT_FOUND` 拒绝。

### `project knowledge resolve <project-id> <task-id> [--json]`

报告「这个 Task 的**下一次** Execution 会用哪些知识」，不启动任何东西：`state`、
逐条 `appliesToTask` 条目、物化上下文路径与 digest/字节数。
**退出码 `1` 仅当没有诚实答案可用**（层非法）；`entryCount: 0`（没有知识适用于该 Task 类型）是**成功**，退出码 `0`。

常见拒绝码：`KNOWLEDGE_LAYER_INVALID`、`KNOWLEDGE_DUPLICATE_ID`、`KNOWLEDGE_DUPLICATE_PATH`、
`KNOWLEDGE_INVALID_FRONT_MATTER`、`KNOWLEDGE_PATH_INVALID`、`KNOWLEDGE_PATH_OUTSIDE_LAYER`、
`KNOWLEDGE_NOT_MARKDOWN`、`KNOWLEDGE_INVALID_ENCODING`、`KNOWLEDGE_ENTRY_TOO_LARGE`、
`KNOWLEDGE_TOO_MANY_ENTRIES`、`KNOWLEDGE_SNAPSHOT_TOO_LARGE`、`KNOWLEDGE_GENERATED_PROVENANCE_MISSING`、
`KNOWLEDGE_GENERATED_PROVENANCE_INVALID`、`KNOWLEDGE_UNKNOWN_LAYER`、`KNOWLEDGE_HUMAN_FILE_PROTECTED`、
`KNOWLEDGE_UNREADABLE`、`KNOWLEDGE_CONTEXT_WRITE_REFUSED`。

---

## 4. `task`：生命周期

### `task create <project-id> <specification> [--constraint <text>]… [--kind DEVELOPMENT]`

原子创建：原始意图 + 首 revision + 事实事件 + 幂等回执在同一事务。`--kind` 只接受 `DEVELOPMENT`。
至少需要一个非空规格；`--constraint` 不可为空字符串（用法错误）。

命令面**总是**带一个随机 `commandId`，因此重放同一命令不会产生第二个 Task（幂等回执）。

### `task list <project-id> [--all]`

默认隐藏归档；`--all` 含归档。其他参数是用法错误。

### `task submit <project-id> <task-id> <expected-version>`

用 expected version 把 `DRAFT` 转 `READY`，并**在同一命令里**核对依赖 + 跑一次调度 pass。
返回里除提交结果外还有 `state` / `version` / `dependencyState` 与 `schedule`。
版本不符 → 乐观冲突拒绝（`VERSION_CONFLICT` / `CONCURRENT_MODIFICATION`）。

### `task run <project-id> <task-id> <expected-version> [--adapter <pi|codex|claude>] [--allow-unknown] [--json]`

显式启动请求，走与自动调度**同一个门禁**。`--adapter` 默认 `pi`。

**换 `--adapter` 是新建 Execution，不是在同一个 Execution 里换 Agent。**

`--allow-unknown` 是 UNKNOWN 判定的**显式单次放行**（ADR-0030 D05）：放宽门禁，**不新增确认**，写入审计台账。

| 退出码 | 条件 |
|---|---|
| `0` | `outcome: STARTED` |
| `3` | `outcome: WAIT`——冲突等待或容量等待；stderr 打印 `[scheduler] CONFLICT|CAPACITY wait: <code> — <detail>` |
| `1` | `outcome: REFUSED`——依赖未满足、状态不可启动、revision 过期等 |

相关稳定码：`TASK_NOT_STARTABLE`、`TASK_ARCHIVED`、`CONFLICT_WAIT`、`CAPACITY_WAIT`、
`CAPACITY_GLOBAL_LIMIT_REACHED`、`CAPACITY_ADAPTER_SLOT_LIMIT_REACHED`、`SCHEDULER_DRAINING`、
`DEPENDENCIES_UNMET`、`CONCURRENT_MODIFICATION`、`UNKNOWN_ADAPTER`、`TASK_NOT_FOUND`。

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
它同时是**启动路径**，因此走与 `task run` 相同的冲突门禁：无法证明与活跃集合不相交时保持 paused，
除非显式 `--allow-unknown`（单次、有审计）。等待时退出码 `3`。

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

### `task purge <project-id> <task-id> <expected-version> --yes [--reason <text>] [--json]`
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
| `RECOVERY_REQUIRED` 任务 | `1` / `RECONCILE_REQUIRED`，先用 `task recover` 对账 |
| 记录的 worktree/验证副本/分支无法证明属于它 | `1` / `PURGE_RESOURCE_NOT_OWNED`，**一行都不删** |
固定事实（不只是约定）：
- **`--yes` 是整个产品唯一一次显式确认，且不在任何常态路径上**：接入、工具、成果 commit、验证策略、调度、提升、`cancel`/`archive`
  都不需要它。它不是审批层：Runtime 不再叠第二次询问，`confirmed` 是调用者自己的声明。
- **`SUCCEEDED` 任务实际上不可 purge**：按定义它的成果已进 `dev`（ADR-0053），因此会被 `TASK_INTEGRATED_INTO_DEV` 拒绝，
  请改用 `task archive`（它隐藏任务但不销毁那个 commit 的来源记录）。
- **删除是幂等的**：同一 `commandId` 重放会读到收据（`replayed: true`），不会发生第二次删除；同一 ID 换 payload 报 `COMMAND_CONFLICT`。
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

## 5. `task revision` 与投递

```sh
bun run codeestra task revision create <project-id> <task-id> <expected-version>
  [--specification <text>] [--constraint <text>]… [--reason <text>] [--json]
bun run codeestra task revision list <project-id> <task-id> [--json]

bun run codeestra task revision delivery list <project-id> <task-id> [--json]
bun run codeestra task revision delivery get  <project-id> <delivery-id> [--json]
bun run codeestra task revision delivery resolve <project-id> <task-id> <delivery-id> <expected-version>
  --action <stop-and-restart|retry> [--adapter <id>] [--json]
```

- `create` 至少需要 `--specification` 或 `--constraint` 之一（及其非空文本）。
- `--reason` 用于说明修订原因；缺省是 `initial task creation` 之外的自定义原因。
- `--action` 必填，且只接受那两个值。
- delivery 状态：`PENDING / IN_FLIGHT / ACKNOWLEDGED / UNACKNOWLEDGED / CHANNEL_UNSUPPORTED / TIMED_OUT / FAILED / SUPERSEDED_BY_RESTART`。
- `resolve` **退出码 `0` 仅当投递最终被满足**（`SUPERSEDED_BY_RESTART` / `RESOLVED` / `ALREADY_SATISFIED`）；
  否则 `1`——例如在**没有确认通道**的 Adapter 上 `retry`，它会诚实地留在未确认状态。
- **与 Session Guidance 的分界**（ADR-0010 D02 / ADR-0057）：本组命令改变的是**验收规格/约束**，因此产生不可变 revision
  并使旧验证失效；只是想对**运行中的会话**说一句「怎么做」而不改验收标准，走 `session guide`（见 §6.1，它不产生 revision、
  不动 `appliedRevisionId`、不使验证失效）。两者不能互相代替。

稳定码：`TARGETED_TEST_PLAN_*` 不在此；投递相关有 `SUCCESSOR_NOT_RECORDED`、`SUCCESSOR_REVISION_MISMATCH`、
`INVALID_REVISION`、`NO_SUBJECT_EXECUTION`、`UNEXPECTED_TASK_STATE`、`CONCURRENT_MODIFICATION`。

---

## 6. `task transcript` / `session transcript`

```sh
bun run codeestra task transcript <project-id> <task-id>
  [--execution <id>] [--after <entry-id>] [--limit <n>] [--reverse] [--json]
bun run codeestra session transcript <session-id>
  [--after <entry-id>] [--limit <n>] [--reverse] [--json]
bun run codeestra session transcript part <session-id> <entry-id> <part-index>
```

- `--limit` 范围 `1`–`200`，默认 `100`。
- `--after <entry-id>` 是**排他游标**（上一次读返回的 entry ID）。
- `--reverse` 打印最新条目在前。它是**纯渲染选择**，因此与 `--json` **互斥**（用法错误）。
  由于命令面是**向前**从游标读的，`--reverse` 最多可能读 50 页才能到最新条目。
- `session transcript` **不接受** `--execution`（用法错误），因为它不解析 Task。
- `--json` 打印 Runtime 视图原文；默认打印人读文本，截断的块会说明如何取回整块。
- `part` 不接受任何 flag，`part-index` 必须是非负整数。

它是**只读**的：不写数据库、不产生 domain event、不是 attach、不是终端接管、不改任何业务状态。
只允许读取 Runtime 自己的 session 目录（符号链接逃逸被拒绝）；file 路径只在 Runtime 内部使用，客户端拿不到。

稳定码：`TRANSCRIPT_CURSOR_UNKNOWN`、`TRANSCRIPT_ENTRY_UNKNOWN`、`TRANSCRIPT_PART_UNKNOWN`、
`SESSION_FILE_NOT_OWNED`、`SESSION_FILE_UNREADABLE`、`SESSION_FILE_MISSING`、`SESSION_FILE_TRUNCATED_READ`。

---

## 6.1 `session guide` / `session guidance`（Session Guidance）

```sh
bun run codeestra session guide <project-id> <task-id> --message <text> [--json]
bun run codeestra session guidance list <project-id> <task-id> [--json]
bun run codeestra session guidance get  <project-id> <guidance-id> [--json]
```

Session Guidance 是**另一条输入通道**（ADR-0010 D02 / ADR-0057）：它改变 Agent 「怎么做」，**不改变验收标准**。
它**不产生 TaskRevision**、不动 Task 的 revision 与 version、**不使任何验证失效**；改规格仍然只能 `task amend`
（`task revision create`），且旧验证仍然因此失效。

- `--message` 必填、去空白后非空，上限 16000 字符；缺 message 或给空白文本是**用法错误**（退出码 `2`）。
- `session guidance list|get` 只接受 `--json`（也是默认输出），其它 flag 是用法错误。

**退出码**（这是本组命令最重要的约定）：

| 码 | 含义 |
|---|---|
| `0` | 已交给运行中的 provider 通道（`DELIVERED`），**或**当时没有会话可交付而消息已记录（`RECORDED`——这是等待下一次 Execution 启动交付，不是拒绝） |
| `1` | 有 provider/会话被问过却没有交付：`CHANNEL_UNSUPPORTED` / `TIMED_OUT` / `FAILED`（stderr 打印稳定码与 detail） |
| `2` | 用法错误 |

本命令**不使用退出码 `3`**：投递有界（deadline 到点就写 `TIMED_OUT`），每次调用都落下一个明确结论，不存在「稍后再看可能变好」的等待语义。

**「已投递」到底指什么。** `DELIVERED` 只表示**provider 自己的通道接受了这条消息（入队）**，**不表示模型读了它**。
三个 provider 都没有可核验「已生效」的通道（ADR-0051 实测），所以命令面把这件事说出口：`--json` 里的
`modelAcknowledgement` 恒为 `UNSUPPORTED`。`state` 取值：`RECORDED` / `DELIVERED` / `CHANNEL_UNSUPPORTED` / `TIMED_OUT` / `FAILED`。

**通道与能力**（如实声明，ADR-0057）：Pi `sessionGuidance: SUPPORTED`（RPC `steer`，evidence 里写明是否观察到 provider
自己的 `queue_update`）；Codex `REQUIRES_VALIDATION`（`turn/steer` 需要活跃 turn，本 Adapter 不持有，且未验证）；
Claude Code `UNSUPPORTED`（print 模式控制协议没有承载运行中消息的子类型）。**能力不是 `SUPPORTED` 的 provider 会记
`CHANNEL_UNSUPPORTED`（退出码 1）**，不会降级、不会静默。

**记录之后发生什么。** 该 Task 的每一条 guidance 会在**新建 Execution**（含 `task resume` 的 successor 与 `task retry` 的
新 Execution）启动时随启动参数交给 provider，因此指导不随进程消失：Pi 用 `--append-system-prompt <绝对路径>`，
Claude Code 用 `--append-system-prompt <已验证文本>`（knowledge 继续用 `-file` flag），Codex 把两件已核验产物合成
`developerInstructions` 字符串。artifact 位于 `<CODEESTRA_HOME>/guidance/<project-id>/<task-id>/guidance-context.md`
（**绝不写进 Task worktree**），交付事实可从 `session guidance list` 的 `launchedWith[]` 读到。
**零 guidance 时启动参数逐字节不变**；Task 有 guidance 却拿不到 Runtime home 或 artifact 核验不过时**拒绝启动**
（`GUIDANCE_CONTEXT_UNAVAILABLE`），不静默少注入。

稳定码：`CHANNEL_UNSUPPORTED`、`NO_SESSION`、`NO_SUBJECT_EXECUTION`、`TIMED_OUT`、`MISSING_CHANNEL_EVIDENCE`、
`GUIDANCE_DELIVERY_FAILED`、`RUNTIME_RESTARTED`、`NOT_FOUND`、`INVALID_STATE`、`CONCURRENT_MODIFICATION`、
`GUIDANCE_CONTEXT_UNAVAILABLE`。

**零新增确认**：FULL 与 STRICT 下都是同一条命令、同样 0 步 0 等待；guidance 不是审批通道，STRICT 的工具审批仍走既有 Attention。

---

## 7. `session handoff`（原生终端接管）

```sh
bun run codeestra session handoff status <project-id> <session-id> [--json]
bun run codeestra session handoff request <project-id> <session-id> <takeover|return>
bun run codeestra session handoff cancel <project-id> <session-id>

bun run codeestra session handoff writer acquire <project-id> <session-id> --holder <ref>
  [--kind AUTOMATED_RPC|TERMINAL_ATTACHMENT]
bun run codeestra session handoff writer release <project-id> <session-id> --holder <ref>

bun run codeestra session handoff admit  <project-id> <session-id>
bun run codeestra session handoff attach <project-id> <session-id> --holder <ref> [--writer] [--observer] [--since <cursor>]
bun run codeestra session handoff detach <project-id> <session-id> --holder <ref> [--since <cursor>]
bun run codeestra session handoff release <project-id> <session-id> [--no-resume]

bun run codeestra session handoff terminal read  <project-id> <session-id> [--since <cursor>]
bun run codeestra session handoff terminal write <project-id> <session-id> --text <text>
bun run codeestra session handoff terminal resize <project-id> <session-id> --cols <n> --rows <n>
  [--holder <ref>] [--json]
```

要点与退出码：

- 每个子命令都打印 Runtime 返回的同一份 JSON 投影；`--json` 被接受且也是默认。
- `writer acquire` 的 `--kind` 默认 `AUTOMATED_RPC`；`--holder` 必填。**竞争是拒绝而不是排队**：
  第二个 writer 申请 → 退出码 `1`，码 `ATTACHMENT_BUSY`。
- `writer release` 只有在真的释放了才是 `0`；否则 `1`。
- `admit` **真的会启动后继**（takeover 是 PTY 原生终端，return 是 RPC provider），所以它才是**移动 lease** 的那一步。
  它拒绝时在记录任何东西之前就拒绝；已准入的请求会**重放**已记录的后继而不是启动第二个。被拒准入 → `1`。
- `attach` 返回 attachment id 与游标；`detach` 离开时**保持终端与 provider 继续运行**；不属于该 holder 的 detach 是拒绝（`1`）。
- `release` 写终端自己的释放字节，**验证 provider 进程已退出且会话文件仍然保有对话**，然后把它交还给同一会话文件上的自动化。
  `--no-resume` 表示不自动交还。退出码 `1` 表示释放或后继启动无法被确认——**绝不是「大概没问题」**。
- `terminal read` 从 `--since` 游标读投影终端流；`terminal write` 把 `--text` 以 base64 编码发送（是**输入**，不是审批）。
- `terminal resize` 改变 Runtime 持有的 PTY 的几何（ADR-0054）。退出码 `0` **只有真的改了尺寸**（Transport 自己的应答，
  `applied: "APPLIED"`）；`1` 拒绝或未生效；`2` 越界或缺参（stderr 打 `TERMINAL_RESIZE_INVALID_SIZE`）。
  `--cols`/`--rows` 必须是 `1..1000` 的整数（合约的取值域在 CLI、Runtime 与 PTY host 三处都拒绝越界）。
  `--holder <ref>` 是终端的写入者座位：已有客户端持有该终端的 `WRITER` attachment 时，**只有它能 resize**，
  其他 holder（或不带 `--holder`）→ 退出码 `1`、码 `TERMINAL_RESIZE_WRITER_BUSY`（报出当前 holder）。这不是审批，常态路径 0 新增步骤。
  结果同时反映在 `session handoff status` 的 `terminal.currentSize`（仅当本 Runtime 仍持有该终端时非 null）里；
  启动时的 `terminal.windowSize` 只说明**启动时**那次设置是否成功。

相关稳定码：`ATTACHMENT_BUSY`、`HANDOFF_KIND_MISMATCH`、`HANDOFF_NOT_REQUESTED`、`INCARNATION_NOT_CURRENT`、
`SESSION_INCARNATION_UNAVAILABLE`、`SESSION_UNKNOWN`、`NOT_FOUND`、`INVALID_STATE`、
`TERMINAL_NOT_RUNNING`、`TERMINAL_NOT_HELD`、`TERMINAL_NOT_FOUND`、`TERMINAL_EXITED`、
`TERMINAL_RESIZE_INVALID_SIZE`、`TERMINAL_RESIZE_WRITER_BUSY`、`TERMINAL_RESIZE_FAILED`、`PTY_RESIZE_TIMEOUT`、
`TERMINAL_TRANSPORT_UNAVAILABLE`、`PERMISSION_CHANNEL_UNAVAILABLE`、`NOT_A_PERMISSION_ATTENTION`。
相关事件名见 §17。

---

## 8. `task result`（成果 commit）

```sh
bun run codeestra task result capture <project-id> <task-id> [execution-id]
bun run codeestra task result prepare <project-id> <task-id> [execution-id]   # STRICT
bun run codeestra task result commit  <project-id> <task-id> <authorization-id> --confirm
```

- **`capture` 只在 FULL 模式可用**。STRICT 下会被以 `FULL_PERMISSION_REQUIRED` 拒绝。
  它在 Runtime 内部合成一次 prepare + 一次 commit（派生 commandId），所以是一条命令。
- `commit` **必须**带 `--confirm`，且除它之外不接受别的 flag（用法错误）。
- 省略 `execution-id` 时 Runtime 解析该 Task 的成果来源；有歧义时以 `AMBIGUOUS_EXECUTION` 拒绝。

前提与影响（两条路径都一样）：只在**已核验归属**的 task worktree 提交；创建 commit 前固定
**HEAD / ChangeSet / revision**，之后发生变化即拒绝；沿用仓库**已有** Git identity，缺失时停止（不代写 `git config`）；
正常执行 hooks，失败保留现场（不 `--no-verify`）；成果落在 `refs/heads/task/<task-id>`。
STRICT 下额外拒绝敏感路径；**FULL 下不做敏感路径拒绝**。

稳定码：`NOTHING_TO_COMMIT`、`AGENT_NOT_QUIESCENT`、`NO_CAPTURED_RESULT`、`NO_ACTIVE_EXECUTION`、
`INVALID_EXECUTION_STATE`、`STALE_AUTHORIZATION`、`AUTHORIZATION_NOT_ACTIVE`、`AUTHORIZATION_MISMATCH`、
`COMMIT_MISMATCH`、`COMMIT_FAILED`、`STALE_REVISION`、`WORKSPACE_NOT_OWNED`、
`SENSITIVE_PATH_BLOCKED`（STRICT）、`FULL_PERMISSION_REQUIRED`（`capture` 在 STRICT 下）。

---

## 9. `task verify` / `task verification` / `task tests`

### `task verify <project-id> <task-id> [execution-id] [--background] [--policy <auto|targeted|project>]`

- `--policy` 取值：
  - `auto`（默认）：该 Task 有**已记录**且与本次 revision/commit 匹配的定向计划就用它，否则用固定项目策略；
  - `targeted`：**必须**有这样一个计划；
  - `project`：用固定项目策略。
  非法取值 → **退出码 2**，并在 stderr 解释三个取值。
- 命令来自项目 `main` ref 上人工维护的 `.codeestra/policies/verification.json`；
  在**固定 commit 的 detached 副本**中运行；**证据不含原始命令输出**。
- 不加 `--background`：只有 `state === "PASSED"` 是 `0`，否则 `1`。
- 加 `--background`：**`0` 表示「已受理并开始」，不代表验证通过**；进度用 `task operation list` 看，
  用 `task operation cancel` 停止。

稳定码：`VERIFICATION_POLICY_ABSENT`、`VERIFICATION_POLICY_NOT_CONFIRMED`、
`VERIFICATION_POLICY_UNREADABLE`、`INVALID_VERIFICATION_POLICY`、`TASK_NOT_EXECUTED`、`NO_CAPTURED_RESULT`、
`STALE_REVISION`、`EXECUTION_NOT_FOUND`、`INVALID_COMMIT_ID`、`VERIFICATION_FAILED`，
以及定向计划相关：`TARGETED_TEST_PLAN_ABSENT`、`TARGETED_TEST_PLAN_NOT_RECORDED`、
`TARGETED_TEST_PLAN_UNREADABLE`、`TARGETED_TEST_PLAN_REVISION_MISMATCH`、`TARGETED_TEST_PLAN_COMMIT_MISMATCH`、
`TARGETED_TEST_PLAN_DIGEST_MISMATCH`、`INVALID_TARGETED_TEST_PLAN`。

### `task verification list <project-id> <task-id>`

列出该 Task 的验证记录（`state`、`outcomeCode` 等）。

### `task tests record|show|history`

```sh
bun run codeestra task tests record <project-id> <task-id> [--commit <full-sha>] [--expected-plan-digest <sha256>] [--json]
bun run codeestra task tests show   <project-id> <task-id> [--json]
bun run codeestra task tests history<project-id> <task-id> [--limit <n>] [--json]
```

- `record` 读取该分支的 `.codeestra/tests.json`（含 `scope` 与 1–16 条命令，每条带 `covers`），
  把它快照成绑定 `(task, revision, commit, digest)` 的**append-only** 记录。
- `--commit` 可指定要绑定的 commit；`--expected-plan-digest` 是防漂移（文件变了就拒绝）。
- 若替换了此前的范围，返回 `replacedExistingScope: true`，CLI 会在 stderr 明确说明「旧记录保留为审计，
  本次范围变化不是静默生效」。
- `show` 打印当前已记录的计划；**没有记录时返回 `null`**，CLI 在 stderr 说明 `task verify` 会用固定项目策略。
- `history` 的 `--limit` 默认 50（上限 500）。`--json` 对三个子命令都是机器格式，且被显式接受。

### JSON 输出与 `--json`

`task tests` 的每个子命令都用 `--json` 声明机器格式；`show` 还接受 `--json` 之外的**无** flag。

---

## 10. `task operation`（长命令）

```sh
bun run codeestra task operation list   <project-id> <task-id> [--json]
bun run codeestra task operation get    <project-id> <operation-id> [--json]
bun run codeestra task operation cancel <project-id> <task-id> <operation-id> [--json]
```

- `list` / `get` 的默认输出是**人读**视图（`--json` 打印 Runtime 原文）：每个 Operation 一行摘要，
  加上逐步进度（`STEP` / `OUTPUT` / `SETTLED`）。
- `cancel` 打印 `stop` / `state` / `kind` / `detail`。**`stop === "UNCERTAIN"` → 退出码 1**
  （进程可能还在跑，Operation 被留给人处理）。
- 稳定码：`NOT_CANCELLABLE`、`NOT_FOUND`、`RECONCILE_REQUIRED`、`CANCEL_UNCONFIRMED`。
- 进度事件与 Operation settle 会作为 domain event 出现在 `events` 流上（`OperationProgressed`、`OperationSettled`）。
  **进度事件永不携带判定**：验证通过只由 `VerificationCompleted` 与该运行自身的状态报告。

---

## 11. `task integrate` / `task integration`（IntegrationBatch）

```sh
# 单成员：组成一个成员的批次并立刻集成（ADR-0018 的既有形态）
bun run codeestra task integrate <project-id> <task-id> <expected-version>

# 多成员：先组成（不碰 Git），再集成（ADR-0053）
bun run codeestra task integration create <project-id> --member <task-id>:<expected-version> \
  [--member <task-id>:<expected-version> ...] [--json]
bun run codeestra task integration integrate <project-id> <batch-id> [--json]
bun run codeestra task integration list <project-id> [task-id] [--json]
bun run codeestra task integration get <project-id> <batch-id> [--json]
bun run codeestra task integration cancel <project-id> <batch-id> [--reason <text>] [--json]
```

`create` **不写任何 Git 副作用**：它固定每个成员当前 revision 的 `(revision, 结果提交, Execution)`、
整批的 `dev` 基线与项目验证策略摘要（`CREATED`）。成员全部通过校验才落一条批次——每个成员都必须是
`EXECUTED`、版本匹配、当前 revision 有一个已捕获结果提交的 `SUCCEEDED` Execution，并且该 revision+commit
有 `PASSED` 的 Task 验证；一个不合法即整体拒绝（不写半批）。成员按 `task_id` 排序（请求顺序不是批次的一部分，
**同一成员集合因此总是产生同一次集成**）。

`integrate` 的过程：在 Runtime 数据目录的 detached integration worktree 中**按 `task_id` 顺序**逐个成员合并
（**能 ff 就 ff，否则 `--no-ff`**）→ 对最终合并提交跑**一次覆盖整批的独立验证** → `PASSED` 后才用 CAS 推进
`dev`，并把**每个**成员 Task 推到 `SUCCEEDED`。

**退出码**（`task integrate` / `task integration integrate` / `task integration cancel` 一致）：

| 码 | 含义 |
|---|---|
| `0` | `dev` 已按本批次证据推进（`INTEGRATED`）；或读取/取消得到已记录的终态 |
| `1` | 拒绝（前置条件、策略未确认、参数不合法之外的情形）或已记录的**非集成终态**：`FAILED`/`CONFLICTED`/`STALE`/`CANCELLED` |
| `2` | 用法错误 |
| `3` | 批次未收口、**需要人工先处理**（`RECOVERY_REQUIRED`）；重跑同一条命令不会有别的结果 |

`STALE` 表示批次固定的证据已过期：某成员 revision/结果提交/验证移动（`MEMBER_EVIDENCE_MOVED`），
或 `dev` 基线在集成前/推进时移动（`DEV_REF_MOVED`）。**不合并、不推进、成员状态保持原样**；终态，
不阻塞用当前事实重新组成批次。`CANCELLED` 只在记录能证明没有副作用时成立（仍 `CREATED` 且无
worktree/merge/验证）；否则得到 `RECOVERY_REQUIRED` + `RECONCILE_REQUIRED` 并**保留占用**。
**取消在 FULL 与 STRICT 下都是零确认**（`permission mode` 见 §0/§1，本命令没有新增门禁）。

部分失败如实可读：只有失败的成员被标 `CONFLICTED`/`FAILED`，已合并的成员保持 `MERGED`，未尝试的
保持 `PREPARED`；验证失败这类批次级失败不改写成员状态。**任何情况下都不会把部分成功写成整批成功**。

`list` / `get` / `create` / `cancel` / `integrate` 的标准输出都是记录的 JSON（`--json` 是显式同义写法），
`members[]` 里逐成员给出 `taskId`/`revisionId`/`candidateCommit`/`state`/`integratedCommit`。

稳定码：`TASK_VERIFICATION_NOT_PASSED`、`NO_CAPTURED_RESULT`、`TASK_NOT_EXECUTED`、`STALE_REVISION`、
`DEV_REF_MISSING`、`DEV_REF_CHECKED_OUT`、`INTEGRATION_IN_PROGRESS`（已有未结算批次持有成员，或该批次仍在
中途）、`INTEGRATION_BATCH_INVALID`、`INVALID_REQUEST`、`INVALID_COMMIT_ID`、`REPOSITORY_CHANGED`、
`EXECUTION_NOT_FOUND`、`VERIFICATION_POLICY_ABSENT`、`VERIFICATION_POLICY_NOT_CONFIRMED`、`NOT_FOUND`、
`CONCURRENT_MODIFICATION`。批级 `outcome_code`：`MEMBER_EVIDENCE_MOVED`、`DEV_REF_MOVED`、`DEV_REF_CHANGED`、
`MERGE_CONFLICT`、`MERGE_FAILED`、`WORKTREE_FAILED`、`INSPECTION_FAILED`、`INTEGRATION_VERIFICATION_FAILED`、
`CANCELLED_BY_USER`、`RECONCILE_REQUIRED`、`DEV_REF_OBSERVED`。

集成成功后会以 `INTEGRATION` 触发一次调度 pass，结果里附带每个成员的 `dependencyReconcile`。

事件名：`IntegrationBatchCreated`、`IntegrationMemberMerged`、`IntegrationVerificationCompleted`、
`IntegrationCompleted`、`IntegrationFailed`、`IntegrationBatchStale`、`IntegrationBatchCancelled`、
`IntegrationReconcileRequired`。

---

## 12. `task depends`（DAG）

```sh
bun run codeestra task depends add    <project-id> <task-id> <expected-version> <prerequisite-task-id> [--revision <revision-id>] [--json]
bun run codeestra task depends remove <project-id> <task-id> <expected-version> <prerequisite-task-id> [--json]
bun run codeestra task depends list   <project-id> [task-id] [--json]
```

- flag 可以出现在**任意位置**（解析器按顺序走 token），但 `--revision` 只对 `add` 有意义。
- 依赖图必须是 **DAG**；加环以 `DEPENDENCY_CYCLE` 拒绝，且**不部分应用**。自依赖是 `SELF_DEPENDENCY`。
- **满足条件**：上游必须**通过集成验证并进入 `dev`**；下游的 dev 基线必须包含上游结果。
  **仅 Task verification 成功不释放依赖**，进入 `dev` 也不等于已提升到 `main`。
- `list` 无 `--json` 时打印人读视图：项目与 dev commit、该 Task 的状态与版本、逐条 `✓/✗ 依赖`、
  要求的 revision 编号、上游合入的 dev commit 前 12 位，以及上游闭包/下游影响数量。

其他码：`DUPLICATE_EDGE`、`DEPENDENCY_GRAPH_INVALID`、`UPSTREAM_NOT_INTEGRATED`、`DEPENDENCY_RECONCILE_FAILED`。

事件名：`TaskDependencyAdded`、`TaskDependencyRemoved`。

---

## 13. `task schedule`（调度引擎）

```sh
bun run codeestra task schedule status <project-id> [--adapter <id>] [--json]
bun run codeestra task schedule plan   <project-id> [--adapter <id>] [--json]
bun run codeestra task schedule explain<project-id> <task-id> [--adapter <id>] [--json]
bun run codeestra task schedule run    <project-id> [--adapter <id>] [--json]
bun run codeestra task schedule clear-unknown <project-id> <task-id> [--json]
```

- Runtime **自己会调度**：相关事件（submit、合入 dev、停止、revision 投递、槽位释放、容量变化）触发一次 pass，
  另有周期恢复 pass（`CODEESTRA_SCHEDULE_TICK_MS`，默认 5000ms）收敛崩溃遗留状态。
- 排序：**priority 降序 → 创建时间 → ID 升序**。提高优先级只改变**下一次**顺序，**不抢占**已持有资源的 Task。
- `plan` 是**有序 dry run**：不预留、不启动任何东西。
- `explain` 退出码：`0` = 正在跑或现在会启动；`3` = `WAIT_CONFLICT` / `WAIT_CAPACITY`；
  `1` = `BLOCKED` 或 `NOT_A_CANDIDATE`。
- `run` 退出码 `0` 表示**这一趟 pass 跑了**（不代表有东西启动）；每个候选的 `disposition` 与 `detail` 打到 stderr。
- `clear-unknown` 记录 UNKNOWN 判定的**显式单次放行**：绑定已评估 revision、基线与分析器/策略版本，
  写入审计台账，被恰好一次启动消费，**不改变已记录的判定**（仍是 UNKNOWN）。
  **`CONFLICTING` 永远不放行**（`state === "CONFLICTING"` → 退出码 `1`）。
- `--adapter` 可选；省略时不指定 Adapter。

事件名：`TaskScheduleDecided`、`TaskWaitingForConflict`、`TaskWaitingForCapacity`、`TaskUnknownCleared`、
`TaskImpactPredictionRevoked`。

---

## 14. `scheduler`（容量与槽位预留）

### `scheduler capacity`

```sh
bun run codeestra scheduler capacity get   <project-id> [--adapter <id>] [--json]
bun run codeestra scheduler capacity set   <project-id> --limit <n> [--adapter <id>] [--json]
bun run codeestra scheduler capacity clear <project-id> --adapter <id> [--json]
```

- 两个维度：项目级并发上限（**默认 2，上限 16**）与每 Adapter 上限（无覆写时跟随项目上限）。
- `get` 返回每个上限的**来源**（`DEFAULT` / `EXPLICIT`）、各 Adapter 的占用、**现在**新获取会拿到的稳定理由码，
  以及 Runtime 是否在 draining。
- `set` 会**读回存储值**；非法值（0、负数、超上限）或未知 Adapter 被以**自己的稳定码**拒绝，**不会被裁剪**。
  `--limit` 必须是安全整数（用法错误否则）。`get` 不接受 `--limit`；`clear` 必须给 `--adapter`。
- 稳定码：`CAPACITY_LIMIT_INVALID`、`CAPACITY_LIMIT_OUT_OF_RANGE`、`UNKNOWN_ADAPTER`。

### `scheduler reservations`

```sh
bun run codeestra scheduler reservations list   <project-id> [--task <task-id>] [--include-released] [--limit <n>] [--json]
bun run codeestra scheduler reservations acquire <project-id> <task-id> <expected-task-version>
  --revision <revision-id> [--snapshot <impact-snapshot-id>] [--adapter <id>] [--json]
bun run codeestra scheduler reservations release <project-id> <reservation-id> --reason <text> [--json]
bun run codeestra scheduler reservations prepare-workspace <project-id> <reservation-id> <expected-task-version> [--json]
bun run codeestra scheduler reservations reconcile <project-id> [--json]
```

- `acquire` 在**一个 immediate 事务**内复核：Task 版本、已评估 revision、依赖事实、缓存的 ImpactSnapshot 代数、
  两个容量维度，然后记录预留与创建者证据（Runtime boot、pid、OS start token）。
  `--snapshot` 指定调用方据以评估的 ImpactSnapshot：映射版本、分析器版本、观察到的 change set 会被**重新读取**，
  过期则以 `SNAPSHOT_STALE` 拒绝（无法确认时 `SNAPSHOT_UNAVAILABLE`），**不写入任何预留行**——
  这是一次**新鲜度复核**，不是第二次冲突分析。
- `acquire` 退出码：`0` = 已持有槽位；`3` = **容量等待**（理由码指出是哪个上限）；`1` = 拒绝
  （依赖未满足、revision 过期、快照代数过期、已持有槽位……）。**`3` 从不是 `BLOCKED`**。
  带事实的拒绝会先打印 JSON 再退 1。
- `list` 显示活跃预留及其持有者证据与 append-only 历史；`--include-released` 保留审计行。
  `--limit` 范围 1–200。
- `release` 是**显式**的且必须给 `--reason`：**没有任何东西**会因为心跳过期、客户端消失或用户等待而释放槽位。
  以 `SLOT_HOLDER_STILL_RUNNING` 被拒表示记录的持有者进程可证明仍活着，且**没有被发信号**。
  `released: false` 表示「本来就已经释放了」——诚实的 no-op，**不是失败**（退出码 0）。
- `prepare-workspace` 为一次预留准备 Task worktree 并绑定它。
- `get` 按 id 读回单条预留与它自己的 append-only 历史（FOUNDATION-074 起已列入 `usage()`；本指南之前把它列在「未列入 usage()」之下）。
- `reconcile` 复核每个活跃预留记录的持有者**与真实进程表**：证明消失的释放并记录；活着或无法核验的**保留槽位**
  （`RECOVERY_REQUIRED`）。**不发信号、不删资源。** 只有出现 `FAILED` 结果才是退出码 `1`。

> **已由 FOUNDATION-074 校准**：`scheduler reservations get` 现已在 `usage()` 里（本指南的「其他只在源码里出现的东西」行也已更新）。

---

## 15. `promotion`（稳定提升）

```sh
bun run codeestra promotion full-suite run  <project-id> --dev-commit <full-sha> [--json]
bun run codeestra promotion full-suite list <project-id> [--limit <n>] [--json]

bun run codeestra promotion prepare <project-id> <batch-id> <expected-dev-commit> <expected-main-commit>
bun run codeestra promotion approve <project-id> <promotion-id>
bun run codeestra promotion promote <project-id> <promotion-id> [--json]
bun run codeestra promotion abandon <project-id> <promotion-id> --reason <text>
bun run codeestra promotion get  <project-id> <promotion-id>
bun run codeestra promotion list <project-id> [--limit <n>]
```

### `full-suite`（dev 全量证据，ADR-0038 D03 / ADR-0039）

- `run` 对**精确那个 dev SHA** 在 detached 副本中运行项目 `main` ref 的固定策略。
  **Runtime 运行并观察**结果：客户端**不能提交**一个自报的结果。
- 证据绑定：**候选 commit**、该策略的 **digest**、**候选 commit 上的锁文件 digest**。
- 缺 `--dev-commit` → 退出码 **2**（stderr 说明它必须指名一个精确 dev SHA）。
- `run` 退出码 `0` 仅当 `state === "PASSED"`。
- `list` 的 `--limit` 默认 20（上限 200）。

### `prepare / approve / promote / abandon`（ADR-0047：唯一提升路径经 GitHub 中转）

- `prepare` 固定「已验证的 dev commit / 预期旧 main commit / 该 commit 的集成验证与 dev 全量证据」，并固定**推送用的 dev
  clone**（`projects.dev_repo_path`；未记录或无法核验时以 `DEV_REPO_PATH_MISSING` / `DEV_REPO_*` 拒绝）。
  该路径的这条拒绝沿用它原有的 `DEV_REPO_PATH_MISSING`（FOUNDATION-077），与「开发基线操作」用的 `DEV_REPO_REQUIRED`
  （ADR-0056）是**两条不同的命令面**，都指向同一条补救命令 `project trust <repo> --dev-repo <dev-clone>`。
  全量证据的**副本与锁文件从 dev clone 读**，**策略仍从 main ref 读**（ADR-0039 + ADR-0056）。
  **不写任何 Git，也不写远端**。远端 `dev` 已经移到非候选 SHA 时拒绝（`REMOTE_DEV_MOVED`，`STALE`）。
- 集成证据是**批次级**的（ADR-0053）：`<batch-id>` 可以是一个多成员批次，`prepare` 会把该批次的
  **全部成员**（`taskId`/`revisionId`/`candidateCommit`）固定进提升记录（输出里的 `members[]`），
  并要求该批次的独立集成验证 `PASSED` 且绑定到它的 merge commit 与固定 `dev` 基线。
  批次未 `INTEGRATED`、`integratedCommit` 不等于传入的 dev SHA、或成员清单与批次记录不符时以
  `BATCH_NOT_INTEGRATED` / `PROMOTION_EVIDENCE_MISMATCH` 拒绝；**多成员不改变任何提升门禁**。
- `approve` **仅 STRICT 需要**；它针对**那一组精确三元组**，dev/main/证据/远端 `dev` 任一移动即失效。
- `promote` 一次只推进**一步**，且每一步都要读回事实：

  1. **push 固定候选到远端 `dev`**（源是候选 OID，不是分支名；从不 `--force`），然后 `git ls-remote` **读回核对**。
     push 退 0 但读回不等 → `REMOTE_DEV_READBACK_MISMATCH`，**不记**已推送；push 被拒或远端不可达 → `DEV_PUSH_REFUSED`
     / `REMOTE_DEV_UNREACHABLE`，记录保持可重试（**不**标 `STALE`），因为记录本身仍然正确。
  2. main 检出尚未拉取 → 报**「已推送、等待拉取」**（`state: PROMOTING`，`phase: AWAITING_PULL`），**退出码 3**，
     **不执行也不记录任何重启步骤**。CLI 在 stderr 打印用户在 main 检出要执行的两条命令：
     `git fetch origin && git merge --ff-only origin/dev`。
     **Web UI 投影同一组只读事实**（`promotion.list` / `promotion.get`，不发任何命令）：`phase`、读回的
     `origin/dev` / `origin/main` SHA，并在这一阶段直接列出上面那两条命令；它**不把该状态显示成已提升或已完成**。
  3. 用户拉取后再次调用同一命令：核对 main 检出确实在候选上、且该候选是 expected main 的后代（fast-forward 而非
     merge/reset），记录重启计划，然后在 main 检出依次执行：

     ```text
     bun install --frozen-lockfile
     bun run build:ui
     bun run codeestra stop
     bun run codeestra status
     ```

     每个后置步骤的输出会打到 stderr（stdout 保持为机器可读记录），证据只记录**摘要与字节数**，不记录文本。
     **重启只在每一步退 0、重启后的 Runtime 回答 `READY`、且应答的 boot 与发出计划的 boot 不同时才被记录。**
  4. 重启记录成功**之后**才把候选 push 回远端 `main` 并读回核对，然后 `SUCCEEDED`。推回失败 → `MAIN_PUSH_REFUSED`
     /`REMOTE_MAIN_READBACK_MISMATCH`，记录保持 `RESTARTING`（`phase: MAIN_PUSH_PENDING`），再次调用**只重试推回**，
     不会重复停 Runtime。
- `promote` 的退出码：`0` 仅当 `SUCCEEDED`；`1` 拒绝或失败；`2` 用法错误；**`3` 已推送、等待拉取**（与 `SUCCEEDED` 不同，
  且该状态下没有任何重启记账）。后置步骤失败时退 `1`，CLI 明确打印「main 检出已在候选上且未回滚；远端 `main` 未发布」，
  重跑 `promotion promote` 会重跑已记录的后置步骤（推回仍只在重启记录成功后才尝试）。
- `--json` 给出可区分的事实：`phase`（`READY_TO_PUSH` / `AWAITING_PULL` / `RESTART_PENDING` /
  `MAIN_PUSH_PENDING` / `COMPLETE` / `REFUSED`）、`devRepoPath`、`remoteDevCommit`、`remoteMainCommit`、
  `pushedAt`、`mainPushedAt`（读回值，不是输入）。
- `abandon` **必须**给 `--reason`（否则报错）：放弃的 promotion 保留记录与观察到的 ref 状态以便审计（包括已读回的远端
  `dev` SHA）。
- `--limit` 范围 1–200；`promotion list` 默认 20。
- 任何一次调用都**不**用 `update-ref`、**不** ff 已检出的 `main`、**不**推除固定候选之外的 ref、**不**覆盖远端已有提交；
  断网/认证失败/远端不可达一律不推进任何 ref。

稳定码：`DEV_REPO_PATH_MISSING`、`DEV_REPO_PATH_CHANGED`、`DEV_REPO_NOT_A_REPOSITORY`、`DEV_REPO_NOT_SEPARATE`、
`DEV_REPO_ORIGIN_UNKNOWN`、`DEV_REPO_ORIGIN_MISMATCH`、`DEV_REPO_BRANCH_MISMATCH`、`DEV_REPO_DEV_REF_MISSING`、
`DEV_REPO_CANDIDATE_MISSING`、`DEV_REPO_BASE_MISSING`、`DEV_PUSH_REFUSED`、`REMOTE_DEV_UNREACHABLE`、
`REMOTE_DEV_MOVED`、`REMOTE_DEV_READBACK_MISMATCH`、`MAIN_PUSH_REFUSED`、`REMOTE_MAIN_READBACK_MISMATCH`、
`DEV_FULL_SUITE_EVIDENCE_MISSING`、`DEV_FULL_SUITE_EVIDENCE_NOT_PASSED`、
`DEV_FULL_SUITE_EVIDENCE_STALE`、`PROMOTION_EVIDENCE_MISMATCH`、`PROMOTION_NOT_APPROVED`、
`PROMOTION_NOT_FAST_FORWARD`、`PROMOTION_NOTHING_TO_PROMOTE`、`PROMOTION_STALE`、`PROMOTION_STATE_INVALID`、
`PROMOTION_IN_PROGRESS`、`PROMOTION_FINISHED`、`APPROVAL_NOT_REQUIRED`、`BATCH_NOT_INTEGRATED`、
`MAIN_REF_MOVED`、`MAIN_WORKTREE_MISSING`、`MAIN_WORKTREE_DIRTY`、`DEV_REF_MISSING`、
`DEV_REF_MOVED`、`VERIFICATION_NOT_PASSED`、`RESTART_PLAN_MISMATCH`、`RUNTIME_NOT_OBSERVED`、
`RUNTIME_NOT_RESTARTED`、`RUNTIME_NOT_READY`、`RESTART_STEP_FAILED`、`RESTART_UNPROVEN`、
`INVALID_COMMIT_ID`、`REPOSITORY_CHANGED`、`(UNBORN_MAIN)`。

事件名：`PromotionCreated`、`PromotionApproved`、`PromotionDevPushed`、`PromotionPushRefused`、
`PromotionMainUpdated`、`PromotionRestartRecorded`、`PromotionMainPushRefused`、`PromotionCompleted`、
`PromotionFailed`、`PromotionStale`、`PromotionReconcileRequired`（旧的 `PromotionStarted` 随本机 ff 路径一起删除）。

> `promotion.restart.record` 是 CLI 在重启后调用的命令面成员：它把「刚刚应答 `runtime.ping` 的那个 boot」
  连同各步骤结果一起记录，Runtime 会核对**正在应答这次记录调用的 boot 与它相同**——所以一个**从未被停止过**
  的 Runtime 不可能被报告成「已重启」。

---

## 16. `reclaim`（资源回收）

```sh
bun run codeestra reclaim plan [--project <project-id> | --all-projects] [--task <task-id>]
  [--kind <TASK_WORKTREE|VERIFICATION_COPY|INTEGRATION_WORKTREE>]… [--include-failure-scenes]
  [--unregistered] [--scan-root <path-inside-home>] [--remove-unregistered <path>]… [--json]
bun run codeestra reclaim apply  <同上>
bun run codeestra reclaim records [--project <project-id> | --all-projects] [--task <task-id>]
  [--source <ALL|REGISTERED|UNREGISTERED_DIRECTORY>] [--since <epoch-ms|ISO>] [--until <epoch-ms|ISO>]
  [--limit <n>] [--json]
```

- **这是唯一具有破坏性的命令面。** `plan` 是只读试运行，返回与 `apply` **完全相同**的决策形状，
  所以预览永远不会与真跑不一致。
- 每个被考虑资源都有 `action`（`RECLAIM` / `RETAIN` / `REFUSE` / `ALREADY_ABSENT` / `RECOVERY_REQUIRED`）、
  `reasonCode` / `detail` 与授权或拒绝它的**归属证据**。
- **失败现场默认保留**：没有 `--include-failure-scenes` 时，未提交改动、失败/取消的验证或集成是 `RETAIN`
  （`FAILURE_SCENE`）。
- **未注册目录不会被删**：只有用 `--remove-unregistered <精确路径>` 指名才会（`UNREGISTERED_EXPLICIT_SELECTION`）；
  最多 200 个选择。`--scan-root` 必须是 home 内的绝对路径（`SCAN_ROOT_NOT_ABSOLUTE` / `SCAN_ROOT_OUTSIDE_HOME`），
  并且它隐含 `--unregistered`。
- `--project` 与 `--all-projects` 互斥；`--task` 需要 `--project`。
- `records` 专用 flag：`--source`、`--since`/`--until`（epoch 毫秒或任何 ISO-8601；`since >= until` 是用法错误）、
  `--limit`（1–500，默认 100）。`--unregistered`、`--include-failure-scenes`、`--scan-root`、`--remove-unregistered`
  在 `records` 上都是用法错误。

退出码：

| 情况 | 退出码 |
|---|---|
| `plan.outcome === "FAILED"` / `report.outcome === "FAILED"` | `1` |
| plan 里可回收数量为 0 | `3`（「没什么可回收」） |
| apply 实际回收数量为 0 | `3` |
| 其他 | `0` |

**注意：`plan`/`apply` 的 `--json` 输出不写 stderr**，所以 `--json` 是脚本唯一需要读的东西。

其他码：`PROJECT_SCOPE_CONFLICT`、`PROJECT_SCOPE_REQUIRED`、`RECLAMATION_IN_PROGRESS`、`COMMAND_CONFLICT`、
`REMOVAL_FAILED`、`REMOVAL_UNCONFIRMED`、`PRUNE_FAILED`、`CLAIMED_BY_LEDGER`、
`UNREGISTERED_REQUIRES_EXPLICIT_SELECTION`、`PATH_NOT_OWNED_LAYOUT`、`PATH_OUTSIDE_OWNED_ROOT`、
`UNRECOGNIZED_LAYOUT`。

事件名：`ResourcesReclaimed`、`WorkspaceReclaimed`。

---

## 17. `events`（订阅）

```sh
bun run codeestra events list [--project <project-id>] [--since <sequence>] [--limit <n>] [--json]
bun run codeestra events tail [--project <project-id>] [--since <sequence>]
```

- `list` 的 `--limit` 范围 `1`–`500`，默认 `100`；`--since` 必须是非负安全整数（默认 0）。
  对 `list`，`--json` 被接受（它本来就打印 Runtime 投影原文）。
- `tail` **不接受** `--limit`；`--json` 也不是 `tail` 的参数。
- 游标语义（**排他**）：
  - `list` 的 `sinceSequence` 是「从这个序号**之后**开始」。
  - `tail` 不带 `--since` 表示「**从当前尾部开始**」——所以正确用法是**先取一次快照，再用快照游标订阅**，
    两次之间不丢事件。
  - `tail` 带一个**大于** Runtime 日志最新序号的游标时，会收到
    `{"type":"error","code":"INVALID_CURSOR"}` 并**结束订阅**。这是刻意的：客户端必须重新取快照，
    而不是以为自己已追上。运行时返回 `cursor: latest, active: false`。
- SSE 帧类型：`subscribed`（首个帧，带 `cursor` / `projectId`）、`event`（带 `cursor` 与 `event`）、
  `heartbeat`（每 15s）、`error`（`INVALID_CURSOR` / `EVENT_READ_FAILED` / `SUBSCRIPTION_FAILED`）。
- 订阅是**只读**的：不写事件、不碰 `event_deliveries` outbox、不重放任何命令。投递是 best-effort——
  错过帧的客户端用**最后一个游标**重连，这就是游标**排他且从不隐式重置**的原因。

### 主要事件名（源码核对）

| 领域 | 事件名 |
|---|---|
| Intent / Task | `IntentRecorded`、`TaskCreated`、`TaskStateChanged`、`TaskRevisionCreated`、`TaskRetryRequested`、`TaskDependencyAdded`、`TaskDependencyRemoved`、`VerificationInvalidated`、`RecoveryRequired` |
| Execution | `ExecutionReserved`、`ExecutionStateChanged`、`ExecutionFailed`、`ResultCommitAuthorized`、`ResultCommitCreated`、`ResultCommitAuthorizationInvalidated` |
| Attention | `UserAttentionRequested`、`UserAnswerRecorded`、`UserAnswerDelivered`、`ProseQuestionAttentionResolved` |
| Agent Session | `AgentSessionStarted`、`AgentSessionStateChanged`、`AgentSessionCompleted` |
| Workspace | `WorkspacePrepared`、`WorkspaceReclaimed` |
| 验证 | `VerificationCompleted` |
| 集成 | `IntegrationBatchCreated`、`IntegrationVerificationCompleted`、`IntegrationCompleted`、`IntegrationFailed`、`IntegrationReconcileRequired` |
| 调度 | `TaskScheduleDecided`、`TaskWaitingForConflict`、`TaskWaitingForCapacity`、`TaskUnknownCleared`、`TaskImpactPredictionRevoked` |
| 容量 / 槽位 | `SchedulerCapacityChanged`、`ExecutionSlotReserved`、`ExecutionSlotReleased`、`ExecutionSlotReconciled`、`ExecutionSlotWorkspaceBound` |
| Operation | `OperationProgressed`、`OperationSettled`、`ResourcesReclaimed` |
| 提升 | `PromotionCreated`、`PromotionApproved`、`PromotionDevPushed`、`PromotionPushRefused`、`PromotionMainUpdated`、`PromotionRestartRecorded`、`PromotionMainPushRefused`、`PromotionCompleted`、`PromotionFailed`、`PromotionStale`、`PromotionReconcileRequired` |
| 交接 / 终端 | `TakeoverRequested`、`TakeoverSafePointReached`、`SessionHandoffStarted`、`SessionHandoffCompleted`、`TerminalWriterLeaseChanged`、`TakeoverReleased`、`TakeoverFailed` |
| 修订投递 | `TaskRevisionDeliveryRecorded` |

**已实现的事件名永不重命名**（ADR-0035）：改名会让同一语义长期存在两个名字。

---

## 18. `attention`

```sh
bun run codeestra attention list <project-id>

bun run codeestra attention answer <project-id> <attention-id> confirm <yes|no>
bun run codeestra attention answer <project-id> <attention-id> value <text>
bun run codeestra attention answer <project-id> <attention-id> cancel
bun run codeestra attention answer <project-id> <attention-id> [--choose <question>:<options>]…
  [--text <question>=<text>]… [--cancel]

bun run codeestra attention resolve <project-id> <attention-id> --dismiss [--note <text>] [--json]
bun run codeestra attention resolve <project-id> <attention-id> --answer <text> [--note <text>] [--json]
```

### `list`

返回数组，每条含 `id`、`kind`（`PERMISSION` / `QUESTION` / `RECOVERY`）、`status`
（`OPEN` / `ANSWER_RECORDED` / `DELIVERED` / `CLOSED` / `STALE`）、`responseType`（`CONFIRM` / `VALUE`）、
`prompt`、`taskId`、`executionId`、`createdAt`。**这是唯一不接受任何额外参数的 attention 子命令**：
多给一个 token（包括 `--json`）都是用法错误。

### `answer`（投递给 Agent）

三种形态：

- 位置式：`confirm yes|no`（`responseType = CONFIRM`）、`value <text>`（把剩余 token 用空格拼起来）、`cancel`。
- flag 式（结构化问卷）：`--choose <题>:<选项>[,<选项>]` 可重复、`--text <题>=<文本>` 可重复、`--cancel`。
  - 题号与选项号是 **1-based**，与界面显示一致。
  - 一道题只能答一次（重复报错）；`--cancel` 不能与任何答案同时给出。
  - 形式错误的示例：`--choose expects <question>:<options>`、`--text expects <question>=<text>`。
  - 超出契约上限的题号/选项号在 **CLI 侧**就会报错（可读错误，而不是不透明边界拒绝）；
    **是否存在于这份问卷**由 Runtime 判定。
- 越界/重复/单选多选不符由 Runtime 以 `INVALID_QUESTIONNAIRE_ANSWER:<PROBLEM>` 拒绝，
  其中 `<PROBLEM>` ∈ `QUESTION_INDEX_OUT_OF_RANGE`、`DUPLICATE_QUESTION_ANSWER`、`DUPLICATE_CHOICE`、
  `CHOICE_INDEX_OUT_OF_RANGE`、`MULTIPLE_CHOICES_FOR_SINGLE_SELECT`；请求**保持 OPEN**。
  给非问卷请求投递问卷答案是 `NOT_A_QUESTIONNAIRE`。

其他稳定码：`ANSWER_NOT_DELIVERABLE`、`ADAPTER_MISMATCH`、`PERMISSION_CHANNEL_UNAVAILABLE`、
`INVALID_STATE`、`INVALID_ADAPTER_RECEIPT`、`NOT_FOUND`。

### `resolve`（散文提问等待）

- **必须恰好给一个** `--dismiss`（误报）或 `--answer <text>`；两者都给或都不给是用法错误。
- `--note <text>` 可选。
- 记录 `DISMISSED_FALSE_POSITIVE` 或 `ANSWERED`。
- **不会恢复 provider 对话，也不是 TaskRevision**：回答是关于**这一次等待**的陈述，不是对规格的修改。
- 稳定码：`PROSE_QUESTION_RESOLUTION_REQUIRED`（试图用 `attention answer` 投递散文提问等待时）、
  `PROSE_QUESTION_ATTENTION_NOT_PROSE_QUESTION`、`PROSE_QUESTION_ATTENTION_ALREADY_RESOLVED`、
  `PROSE_QUESTION_SESSION_NOT_EXITED`、`PROSE_QUESTION_EXECUTION_NOT_RUNNING`、
  `PROSE_QUESTION_TASK_NOT_WAITING`、`PROSE_QUESTION_INVALID_RESOLUTION_PAYLOAD`。

---

## 19. `settings`

```sh
bun run codeestra settings prose-question-attention            # 读取
bun run codeestra settings prose-question-attention auto       # 写入
bun run codeestra settings prose-question-attention record-only
bun run codeestra settings prose-question-attention off
```

- 读与写是**同一条命令**：不给值就是读，给值就是写。多给一个位置参数是用法错误。
- 取值只有三个：`auto`（默认）/ `record-only` / `off`。其他取值是用法错误。
- **不需要确认**，且**不会改写已经记录下来的等待**。
- `--json` 被接受（输出本来就是 JSON）。

---

## 20. HTTP / SSE 面（Web UI 用）

Runtime 的本地 HTTP 面只绑定 `127.0.0.1`，端口在 `codeestra ui` 时选定，**每进程一次性内存 token**。

### `POST /api/command`

- `Authorization: Bearer <token>` 必填，否则 `401 {"error":"UNAUTHORIZED"}`。
- `Content-Type` 必须是 `application/json`，否则 `415 UNSUPPORTED_MEDIA_TYPE`。
- `Origin` 存在但主机/端口不匹配 → `403 FOREIGN_ORIGIN`（缺 `Origin` 的非浏览器客户端仍然受 token 保护）。
- 请求体必须是 `runtimeRequestSchema` 能接受的请求（与 socket 传输**同一 schema**），否则
  `400 {"error":"INVALID_REQUEST"}`；JSON 解析失败 → `400 INVALID_JSON`。
- **`events.subscribe` 与 `runtime.ui` 在 HTTP 上被明确拒绝**：`400 {"error":"NOT_AVAILABLE_OVER_HTTP"}`。
- 命令仍在运行时，服务器会每 `keepAliveMs`（默认 10s）写一个空白字符保活——空白对 JSON 解析器无意义，
  所以快命令仍然只返回紧凑的 JSON 体。空白只在第一个间隔过去之后才开始写。
- 其他 `/api/*` 路径 → `404 {"error":"NOT_FOUND"}`；非 API 路径按静态资源处理，未知路径回退到
  `index.html`（单页应用）。路径穿越（`..`、绝对路径、`\0`）直接被拒。

成功应答是 `runtimeResponseSchema`：`{ requestId, schemaVersion, ok: true, result }`；
失败是 `{ requestId, schemaVersion, ok: false, error: { code, message, detail? } }`。
**命令的稳定错误码与退出码语义都在这个 envelope 里**——UI 用 `code` 而不是解析文案。

### `GET /api/events`

- 同样需要 Bearer token（401），只接受 `GET`（否则 405）。
- 查询参数：`projectId`（可选）、`sinceSequence`（可选，非负安全整数；不合法 → `400 {"error":"INVALID_CURSOR"}`）。
- 成功时返回 `text/event-stream`，先发一行注释 `: connected` 让客户端知道流是活的，然后按 SSE 帧发送
  `subscribed` / `event` / `heartbeat` / `error`。
- 订阅失败时先发一帧 `{"type":"error","code":"SUBSCRIPTION_FAILED",…}` 再关闭。

**游标语义与 CLI 完全一致**（排他、未知游标报错而不静默裁剪），所以用 UI 显示的游标重连，
既不会重复也不会漏事件。

---

## 21. 其他只在源码里出现的东西

| 项 | 说明 |
|---|---|
| `session handoff writer acquire --kind` | `AUTOMATED_RPC`（默认）/ `TERMINAL_ATTACHMENT` |
| `session handoff attach --observer` | 显式声明观察者 attachment（默认就是 `OBSERVER`） |
| `session handoff detach --since` | detach 也接受 `--since` |
| `session handoff terminal write` 的 `--text` | 服务端收到的是 base64（CLI 负责编码） |
| `session handoff terminal resize --cols/--rows` | 必须是 `1..1000` 的整数；越界在 CLI 就以退出码 2 + `TERMINAL_RESIZE_INVALID_SIZE` 拒绝（不打给 Runtime） |
| `session handoff terminal resize --holder` | 终端已有 `WRITER` attachment 时必填且必须是该 holder；否则 `TERMINAL_RESIZE_WRITER_BUSY` |
| `promotion.restart.record` | CLI 在 `promote` 的重启序列之后调用；不是可直接执行的用户命令 |

---

## 相关阅读

- 端到端流程与预期输出形状：[workflow.md](./workflow.md)
- 界面：[ui.md](./ui.md)
- 稳定错误码与排障：[troubleshooting.md](./troubleshooting.md)
