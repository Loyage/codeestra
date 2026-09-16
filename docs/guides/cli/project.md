# CLI 参考 · project（接入、影响分析与知识）

> **适用版本** `dev@de03448`（2026-09-16） · **schema** v34 · **最后校对** 2026-09-16
> 版本会前进：`dev@de03448` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../../tasks/README.md) 的最新 FOUNDATION 记录为准。
> 拆分说明（ADR-0063）：本文件是 [`cli-reference.md`](../cli-reference.md) 按功能拆出的九篇之一，
> **内容自 `cli-reference.md @ dev@de03448` 搬移，一句未改写；本次未重新核对源码**，最后校对日期因此不变。
> 本文件覆盖 §3；章节号沿用拆分前的编号，因此可能不连续。正文里提到本文件没有的号（例如 §14、§17）时，到 [README.md](./README.md) 的索引表查它在哪一篇。
> §3 的 `project impact *` 与 §4 的 `task submit`/`task resume`/`--feature` 由 FOUNDATION-091 新增/改写（ADR-0059）；
> §3 的 `project inspect`/`project trust` 段、§1 `open` 的失败码、§4 的 `task run` 与 `task depends` 两节由 FOUNDATION-093 第三轮同步（ADR-0060 修订：managed 项目的常态路径不再出现 `DEV_REPO_REQUIRED`）；其余段落沿用 FOUNDATION-091 的校对基线。

## 3. `project`

### `project inspect [path] [--dev-repo <dev-clone>]`

读仓库身份：`repoRoot`、`mainRef`、`objectFormat`、`headCommit`、`gitCommonDir`，
以及 `devRepoPath` —— 项目记录的 dev clone 的**核验结果**（ADR-0047 D05）：`verified`、`code`、`detail`、`repoRoot`、
`gitCommonDir`、`headCommit`、`branchRef`、`devRefCommit`、`originUrl`、`originMatchesProject`、`clean`。
`path` 默认当前目录；`--dev-repo <path>` 改为核验**指定**的那个 clone（在 trust 之前先看它是否可用），省略时核验已记录的那个。

**开发基线有两种，按「有没有 dev clone」分派（ADR-0056 / ADR-0060）**：`devRef` / `devCommit` / `devRefPresent`
描述的是**dev clone 的**本地 `dev` 分支；没有可核验的 dev clone 时它们是 `dev` / `null` / `false`，
此时**Task 基线改取项目文件夹自己当前检出的分支**（managed）。**需要长期 `dev` 分支的操作**只有集成与提升
（`task integrate`、`promotion *`、`promotion full-suite run`）仍以 `DEV_REPO_REQUIRED` 拒绝并打印补救命令：
拒绝的是「没有那条长期分支」，不是新的审批。Task 基线解析、依赖判定、槽位预留、调度启动前重检、影响分析基线、
结果 commit 归属、任务级验证与回收对两类项目都成立（ADR-0060 第三轮修订，用户裁决「一般项目根本不需要 dev」）。

`devRefRetirement` 是**只读的退役证据**（ADR-0048 D04 / ADR-0056），描述的是**被检查的那个检出自己**的本地 `dev` ref：

| 字段 | 含义 |
|---|---|
| `localDevRefPresent` / `localDevRefCommit` | 该检出里是否仍有过渡的本地 `dev` ref，以及它指向哪个 commit |
| `remoteRefsContainingLocalDevCommit[]` | 哪些**远端跟踪 ref**（`refs/remotes/…`）的历史已包含那个 commit |
| `publishedOnRemote` | 上表非空时为 `true`：该 commit 已经在远端，删掉本地 ref 不丢历史（**ADR-0060 起这就是删不删的判据**；为 `false` 时说明它只存在于这个 clone） |
| `projectsWithoutDevRepo[]` | 仍**没有** dev clone 的已信任项目（`projectId`/`name`/`repoRoot`）；ADR-0060 起这只是只读报告，**不再是删除判据** |

Runtime **不再从那个 ref 读任何 dev 事实**。该列表为空表示没有任何项目依赖它 —— 这是「可以人工删除它」的只读依据
（见 `docs/guides/manual.md` §3.4）。失败码含 `INVALID_REPOSITORY`、`UNSAFE_CHECKOUT`、`GIT_INSPECTION_FAILED`；
dev clone 的拒绝是 `DEV_REPO_*`（见下）。

### `project policy [path]`

打印 `main` ref 上 `.codeestra/policies/verification.json` 的检查结果：`state`（`PRESENT` / `ABSENT` / `INVALID`）、
`mainCommit`、`digest`、逐条 `commands`。缺失时提示「task verify 会拒绝直到该 ref 上存在此文件」。

### `project trust [path] [--dev-repo <dev-clone|none>] [--yes]`

接入项目。**前提**：合法 Git 仓库；给出 dev clone 时，该 clone 上的 `dev` 分支存在。**影响**：Agent 工具、验证命令与 Git hooks
会以你的用户权限运行。FULL 无确认；STRICT 需要输入 `TRUST` 或 `--yes`。

`--dev-repo <path>` 是**可选**的（ADR-0060）：记了它，项目就拥有**长期 `dev` 基线**（集成目标、提升候选、
全量证据的副本根与锁文件都从它读）；`--dev-repo none` 表示这个项目**没有** dev clone；省略时沿用上次记录的值
（不会静默清除）。

| 稳定码 | 含义 |
|---|---|
| `DEV_REPO_NOT_A_REPOSITORY` | 路径不存在或不是 Git work tree |
| `DEV_REPO_NOT_SEPARATE` | 它是 main 检出自身或 main 检出的一个 worktree（同一个 Git common dir），不是另一个 clone |
| `DEV_REPO_ORIGIN_UNKNOWN` | main 检出或该 clone 没有 `origin`，无法比较 |
| `DEV_REPO_ORIGIN_MISMATCH` | 它的 `origin` 与 main 检出的 `origin` 不同 |
| `DEV_REPO_BRANCH_MISMATCH` | 它的 HEAD 不在项目的 `dev` 分支上 |
| `DEV_REPO_DEV_REF_MISSING` | 它没有本地 `dev` 分支 |
| `TASK_BASE_REF_UNRESOLVED` | 没有 dev clone 且项目文件夹处于 detached HEAD：没有分支可作 Task 基线（切到一条分支再试） |
| `TASK_BASE_REF_MISSING` | 显式给出的基线 ref 在该仓库里不存在 |

`DEV_REPO_REQUIRED` **不再**由 trust 返回，也只属于**需要长期 `dev` 分支的操作**（`task integrate`、
`promotion *`、`promotion full-suite run`，见下）：没有那条分支并不妨碍一个项目正常工作——那样的项目（managed）
的 Task 基线是它自己文件夹当前检出的分支，`task submit`/`task run`/`task depends list`/`task result *`/`task verify`
都照常工作（ADR-0060 第三轮修订）。
失败时退 `1`；CLI 同时打印核验结果（`verified` / `code` / `detail`），因为 `project trust` 会先打印身份、策略与结果三份文档。

防漂移：若在你查看与确认之间身份/策略/映射/dev clone 发生变化，返回 `REPOSITORY_CHANGED`、
`VERIFICATION_POLICY_CHANGED`、`IMPACT_POLICY_CHANGED`。dev clone 上没有 `dev` 分支返回 `DEV_REPO_DEV_REF_MISSING`。
同一仓库的其他工作树（同一 Git common dir）重复 trust 是幂等的。

**两个 clone 各自拥有什么（ADR-0056）**：

| 事实 | 仓库 | 谁读 |
|---|---|---|
| 仓库身份、`main` ref、`.codeestra/policies/verification.json`、`.codeestra/impact.json` | main 检出（`projects.repo_root`） | `project policy`、`project impact *`、Task 验证与集成的策略读取、提升的重启序列 |
| 长期 `dev` 分支、Task 分支与 worktree、集成 worktree 与 ref 推进、提升候选对象、全量证据的副本与锁文件 | dev clone（`projects.dev_repo_path`）**或项目文件夹**（ADR-0060：没有 dev clone 时 Task 基线/worktree/验证副本/回收都落在项目文件夹；集成与提升仍需要 dev clone） | 需要 dev 基线的命令（`task integrate`、`promotion *` 等；`task *` 与 `reclaim *` 对两类项目都工作） |

### `project list`

列出已信任项目。打开仓库的另一个工作树**不会**产生第二个 Project。

### `project impact validate [path] [--json]`

读取 `main` ref 上的 `.codeestra/impact.json`，报告 `code`（`OK` / `OK_UNTRUSTED` / `POLICY_ABSENT` /
`POLICY_INVALID` / `POLICY_NOT_CONFIRMED`）、映射摘要（重要目录 / 模块 / 全局资源数量）、`analyzerVersion` 与警告。
**退出码 `0` 仅当映射存在且是已确认的那一份**；否则 `1`。

含义提醒：映射只用于两件事：`--feature` 的**写入校验**与快照证据。**判定不再读映射**，所以映射缺失/未确认
不会让判定变成 `UNKNOWN`，也不会阻止任何东西并行（ADR-0059）。

### `project impact show <project-id> <task-id> [--json]`

打印这一个 Task 的 `ImpactSnapshot`：`disposition`（`RECORDED` / `REUSED` / `UNAVAILABLE`）、
`complete` 与 `incompleteReasons`、baseline 与项目 dev 基线是否一致、变更路径、重要目录、模块、共享资源、证据。
**退出码 `1` 当且仅当完全没有快照**（change set 无法观察）；不完整但存在的快照仍然正常打印（`complete: false`）。

### `project impact explain <project-id> <task-id> [--json]`

在 `show` 的基础上，与**每一个未完成且声明了功能的 Task** 比较，并给出 `assessment.verdict` 与理由码。
**退出码 `0` 仅当 `SAFE_TO_PARALLELIZE`**；`UNKNOWN`（历史值）与 `CONFLICTING` 都是 `1`（代码在 `--json` 里）。

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

