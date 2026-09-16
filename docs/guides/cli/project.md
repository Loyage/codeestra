# CLI 参考 · project（接入、影响分析与知识）

> **适用版本** `dev@de03448`（2026-09-16） · **schema** v35 · **最后校对** 2026-09-16
> 版本会前进：`dev@de03448` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../../tasks/README.md) 的最新 FOUNDATION 记录为准。
> 拆分说明（ADR-0063）：本文件是 [`cli-reference.md`](../cli-reference.md) 按功能拆出的九篇之一，
> **内容自 `cli-reference.md @ dev@de03448` 搬移，一句未改写；本次未重新核对源码**，最后校对日期因此不变。
> 本文件覆盖 §3；章节号沿用拆分前的编号，因此可能不连续。正文里提到本文件没有的号（例如 §14、§17）时，到 [README.md](./README.md) 的索引表查它在哪一篇。
> §3 的 `project impact *` 与 §4 的 `task submit`/`task resume`/`--feature` 由 FOUNDATION-091 新增/改写（ADR-0059）；
> **本次修订（ADR-0064 / schema v35）**：`project inspect`/`project trust` 的 `--dev-repo` 参数、
> `devRepoPath` 字段与 `devRefRetirement` 报告全部删除；Task 基线只有一种（项目文件夹建 workspace 时检出的
> 分支）。`DEV_REPO_*` / `DEV_REF_MISSING` 稳定码不再产生。

## 3. `project`

### `project inspect [path]`

读仓库身份：`repoRoot`、`mainRef`、`objectFormat`、`headCommit`、`gitCommonDir`。`path` 默认当前目录。

**Task 基线只有一种**（ADR-0064）：项目文件夹**建 workspace 时当前检出的分支**，ref 与 commit 一起固定进
`workspaces.base_ref`/`base_commit`。因此 inspect **不再**返回 `devRef` / `devCommit` / `devRefPresent` /
`devRepoPath` / `devRefRetirement`，也**没有** `--dev-repo` 参数：dev clone、长期 `dev` 集成分支、
`dev → main` 提升与 dev 构建通道都已从产品中删除。

stderr 会打印一行 `Task 基线：该项目文件夹当前检出的分支（建 Task 时固定 ref 与 commit）。`。
失败码含 `INVALID_REPOSITORY`、`UNSAFE_CHECKOUT`、`GIT_INSPECTION_FAILED`。

### `project policy [path]`

打印 `main` ref 上 `.codeestra/policies/verification.json` 的检查结果：`state`（`PRESENT` / `ABSENT` / `INVALID`）、
`mainCommit`、`digest`、逐条 `commands`。缺失时提示「task verify 会拒绝直到该 ref 上存在此文件」。

### `project trust [path] [--yes]`

接入项目。**前提**：合法 Git 仓库。**影响**：Agent 工具、验证命令与 Git hooks 会以你的用户权限运行。
FULL 无确认；STRICT 需要输入 `TRUST` 或 `--yes`。

trust 记录的正是**你审阅过的那份身份**（仓库身份）与两份已提交策略的确认；没有 dev clone 路径要记，
因为产品不再有它（ADR-0064）。

| 稳定码 | 含义 |
|---|---|
| `TASK_BASE_REF_UNRESOLVED` | 项目文件夹处于 detached HEAD：没有分支可作 Task 基线（切到一条分支再试）。这是**建 Task/跑 Task 时**的拒绝，不是 trust 的 |
| `TASK_BASE_REF_MISSING` | 显式给出的基线 ref（`task run --base-ref`）在该仓库里不存在 |
| `TASK_BASE_REF_NOT_A_BRANCH` | 显式给出的基线 ref 不是本地分支（`refs/heads/…`） |

失败时退 `1`；CLI 同时打印身份与策略两份文档。防漂移：若在你查看与确认之间身份或策略发生变化，返回
`REPOSITORY_CHANGED`、`VERIFICATION_POLICY_CHANGED` 或 `IMPACT_POLICY_CHANGED`：重新检查再信任。
同一仓库的其他工作树（同一 Git common dir）重复 trust 是幂等的。

**一个文件夹拥有全部事实**（ADR-0064）：仓库身份、`main` ref、`.codeestra/policies/verification.json`、
`.codeestra/impact.json`、Task 分支与 worktree、验证副本与回收，都在 `projects.repo_root` 这一个根上；
没有第二个 clone 需要核对，也没有跨 clone 的候选对象要核验。

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
`complete` 与 `incompleteReasons`、baseline 与项目当前基线 ref 是否一致、变更路径、重要目录、模块、共享资源、证据。
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

