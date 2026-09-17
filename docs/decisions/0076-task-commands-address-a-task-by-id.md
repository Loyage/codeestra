# ADR-0076：`task` 命令以 Task id 为地址 —— project 是 Task 的字段

Status：**Accepted**（本轮用户选择题确认：范围只限 `task *` 组；Runtime 自行从 Task 解析项目；`task create` 改用 `--project <id>`；旧写法**硬切换**不再接受）。**无 schema 变更，无迁移号。**

**Amends** [ADR-0005](0005-task-entry-and-worktree-location.md) 的「Task CLI 用 Project ID + Task ID 两个位置参数」拼写：Task 的**入口拼写**改为只收 Task id；ADR-0005 其余部分（Task 新建为 `DRAFT`、owned worktree 位于 Runtime 数据目录）不变。
不改 [ADR-0070](0070-service-process-signal-kernel.md) 的本体：Project Service 仍是 Task Service 的父节点，`service tree` 仍是 `<root> → <project> → <task>`，Task 的**归属事实**没有变，改的只是**寻址拼写**。

## Context

- 现状（本格基线）：几乎每条 `task *` 命令都以 `<project-id> <task-id>` 两个位置参数寻址，例如
  `task status <project-id> <task-id>`、`task depends add <project-id> <task-id> <expected-version> <prerequisite-task-id>`、
  `task revision delivery resolve <project-id> <task-id> <delivery-id> <expected-version>`。`task list` 更是**必须**给项目。
- 但 `project` 从来不是寻址所需的信息：`tasks.id` 是全局主键（`schemas`/DDL：`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), …)`），
  Task id 唯一确定一行，`project_id` 只是这一行的**一个列**。用户在 CLI 上却必须先把已知的 project 再抄一遍，
  每次操作多一个参数、多一次记错的机会；脚本也必须先维护一个 `project → task` 的映射。
- 这与 §1.1 的第一原则直接冲突：**效率至上**（从意图到结果的步数与等待时间优先）要求寻址只付必要的信息；
  project id 只是 Task 的一个字段，不应该出现在操作面。
- 反方向的代价必须如实列出：Runtime 的命令面 `RuntimeRequest` 里 40+ 条 task 命令都带 `projectId`，
  CLI 测试里有 216 处调用带项目位置参数，`docs/guides/**` 与 `docs/notes/**` 里近百处示例带项目参数。
  这是一次**破坏性拼写变更**，不是新增别名可以糊过去的。
- 已有先例可循：`task.operation.get <project-id> <operation-id>`、`task.revision.delivery.get <project-id> <delivery-id>`
  这些命令**已经在**用一个 id 自己的行（`operations.project_id`、`task_revision_deliveries.project_id`）表示归属，
  只是仍要求调用者重复一次。

## Options

### D01 谁负责把 Task 解析成项目

- **A（选中）Runtime 解析**：`projectId` 在这些命令里变为**可选**；CLI 不发送它，Runtime 在 dispatch 之前用 Task 行
  （或 Operation/Delivery 行）解析出项目，再交给原有 handler。一次往返、单一事实来源；同时满足了
  「Runtime 命令面也可发现、也可直接用」的口径（ADR-0068）。
- B CLI 先查再调：新增一条查询命令，CLI 先解析项目再发原命令。Runtime 不动，但每次操作多一次往返，
  且「project 是字段」只体现在 CLI 层，直接使用 Runtime 命令面的客户端仍要抄项目。
- C 只改文档/别名：保留旧形态并加新别名。命令面从此有两种真相，`help`、用法错误与测试都要写两遍，
  与 ADR-0068「清单与实际命令同源」相悖。

### D02 `task create` 怎么点名项目

- **A（选中）`--project <project-id>`**：创建时 Task 还不存在，没有可以解析的对象，所以项目必须由调用者给出；
  用 flag 而不是位置参数，使 `task` 组**没有任何命令以项目位置参数开头**，也没有「第一条位置参数是项目还是任务」的歧义。
- B 保留 `task create <project-id> <详情…>`：位置参数最少，但同组内出现两种解析规则，`task create x y` 中 x 是项目，
  而 `task status x` 中 x 是任务。
- C 从「当前目录所属项目」推断：需要新增「当前项目」这一持久状态与它的解析规则（多个项目、未信任、cwd 不在任何项目内都要定义），
  是新的产品语义，不在本次范围内。

### D03 `task list` 的范围

- **A（选中）默认列出本 Runtime 全部已信任项目**：列表**不是**对一个 Task 的操作，项目在这里是**过滤条件**：
  不给 `--project` 就是全部，每行自带 `projectId`；给了就只列该项目。这正对应用户的原话
  「task 应该是直接由 `codeestra task` 搜寻到的」。
- B 必须显式给 `--project` 或 `--all-projects`：更保守，但把一个「我有哪些任务」的日常问题变成必须知道项目 id 的问题。
- C 只列「最近的一个项目」：需要定义「最近」，且在多项目下静默少列内容。

### D04 `task depends list` 这种「半项目」命令

- **A（选中）一个主体，二者择一**：`task depends list <task-id>` 读该 Task 的边与闭包，`task depends list --project <project-id>`
  读该项目全部边；两个都不给是用法错误（退出码 2，指向 `task depends help`）。
  理由是**事实形状**：该投影的 `baseRef`/`baseCommit` 是**单数**，绑定在**一个项目**的基线 ref 上，
  「全部项目」没有单一答案，编造一个会造假事实。
- B 扩展投影为多项目数组：把 `baseRef` 变成每项目一条。改变既有读模型与所有消费者，超出本次寻址改动的范围。
- C 只保留 Task 形态，删掉整项目读法：会删掉一个已在用的只读能力。

### D05 `task schedule` 三条项目级命令

- **A（选中）保留 `<project-id>`**：`task schedule status|plan|run` 是「跑一趟**项目**的调度 pass」，
  主体是项目不是 Task；只有 `task schedule explain` / `clear-unknown` 收 `<task-id>`。
- B 全部改成 Task 级：语义上不成立——一趟 pass 是每项目的，不是每任务的。
- C 把它们移出 `task` 组（例如 `scheduler pass …`）：命令改名，超出本次范围，且与 `docs/guides/cli` 的既有分组不符。

### D06 旧写法

- **A（选中）硬切换**：只按命令树定义解析；`task status <project-id> <task-id>` 里多出来的 token 会被当成
  Task id 或未知 flag，以用法错误（退出码 2）退出并指向对应层的 `help`。命令面唯一、无歧义。
- B 同时接受两种：迁移无痛，但解析规则变成「按位置参数个数猜」，`help`、错误路径与测试都要写两遍，
  且永远无法收紧。

### D07 同时给出 projectId 与 taskId 的 Runtime 请求

- **A（选中）不一致即拒绝**：两者不一致时报稳定码 `TASK_PROJECT_MISMATCH`（退出码 1），不做静默取舍。
  依据是 ADR-0011：正确性核对有效，但它不是审批、不新增确认；一次拒绝也不在 CLI 常态路径上
  （CLI 不再发送 `projectId`）。
- B 以 taskId 为准：调用者的另一句话被静默忽略。
- C 以 projectId 为准：与「Task 决定归属」冲突，且要额外证明 Task 真属于该项目。

## Decision

1. **寻址**：`task` 组命令以 **Task id** 为地址。`taskId` 全局唯一，`projectId` 是 Task 行的字段；
   `task status|pause|cancel|archive|unarchive|submit|run|resume|retry|recover|purge|verify|transcript|
   result *|tests *|verification list|operation list|cancel|depends add|remove|integration show|
   revision *|revision delivery *|schedule explain|clear-unknown` 全部改为只收 `<task-id>`。
2. **Runtime 解析**（D01 A）：这些 `RuntimeRequest` 的 `projectId` 变为可选。Runtime 在 dispatch 前统一解析：
   `task.*` 用 Task 行，`task.operation.get` 用 Operation 行，`task.revision.delivery.get` 用 Delivery 行；
   项目必须是本 Runtime 的**已信任**项目，否则与「没有这个 Task」一样报 `NOT_FOUND`。
   两者都给且不一致 → `TASK_PROJECT_MISMATCH`（D07 A）。
3. **`task create`**（D02 A）：`task create --project <project-id> <任务详情…> --title … --name … [--feature …]`；
   `projectId` 在契约里仍是**必填**（创建时 Task 不存在）。
4. **`task list`**（D03 A）：`task list [--project <project-id>] [--all]`。不给项目列出**本 Runtime 每个已信任项目**的 Task，
   每行自带 `projectId`；给了项目就只列该项目，未信任/不存在报 `NOT_FOUND`（不静默回退成全部）。
5. **`task depends list`**（D04 A）：`task depends list [<task-id> | --project <project-id>] [--json]`，二者必居其一，
   都不给是用法错误。Runtime 侧 `projectId` 可选，但**解析后必有值**：两个都没有时以 `TASK_SCOPE_REQUIRED` 拒绝。
6. **项目级命令**（D05 A）：`task schedule status|plan|run <project-id>` 保持原样。
7. **旧写法**（D06 A）：**不接受**。旧脚本必须改写，不提供兼容层，也不做「按参数个数猜」。
8. **不改的东西**：Schema（Task/Service/依赖/集成表一行不动）、`service tree` 的父子事实、
   project 组与 `session.guidance`、`project.integration.request`、`reclaim --task`、`scheduler reservations *`
   的拼写与语义（本轮范围只限 `task *` 组）；不新增权限门禁、审批层或确认步骤（FULL 与 STRICT 行为一致）。

## Consequences

### Positive

- 日常操作少一个参数：有 Task id 就能读、能改、能验证，不必先记住或查它属于哪个项目。
- 脚本不必维护 `project → task` 映射；`task list` 直接回答「我有哪些任务」，每行自带归属。
- 40+ 条 Runtime 命令的解析收敛到**一处**（dispatch 之前），handler 不再各自重复「项目 + 任务」两个参数；
  直接使用 Runtime 命令面的客户端也受益。
- 与既有内核事实一致：Service 树、`tasks.project_id`、`operations.project_id`、`task_revision_deliveries.project_id`
  都没有变，变的只是**寻址拼写**。

### Costs and risks

- **破坏性变更**：旧的 `<project-id> <task-id>` 写法立刻失效（退出码 2 的用法错误），
  所有脚本、`docs/guides/**`、`docs/notes/**` 示例与 216 处 CLI 测试调用都必须同步改写。
- `task list` 不带项目时会遍历**所有已信任项目**：项目多、任务多时输出更大；调用者用 `--project` 收窄。
- 「一个 id 属于哪个项目」现在需要一个索引查询：`tasks.id`/`operations.id`/`task_revision_deliveries.id` 都是主键，
  这条查询是主键查找，不新增索引、不新增表。
- 未做（明确不为）：不提供兼容别名、不提供「按参数个数猜」的过渡期、不改 `project`/`session` 组与
  `project.integration.request` 的拼写、不新增「当前项目」状态、不把 `task depends list` 扩展成多项目投影。

## Verification

- **定向测试**（开发分支按 ADR-0038；本变更选定的范围）：
  - `apps/runtime/test/cli-task-scope.test.ts`（新增）：`task list` 默认列全部项目且每行带 `projectId`、`--project` 过滤、
    未信任项目 `NOT_FOUND`；`task status <task-id>` 不带项目；**Runtime 命令面**同时给不一致的 projectId 与 taskId 报
    `TASK_PROJECT_MISMATCH`；`task depends list` 的两种主体与「都不给」的用法错误。
  - `apps/runtime/test/cli-command-surface.test.ts`、`cli-help.test.ts`：命令树、`help` 清单、Runtime 命令面覆盖
    与用法错误（`task list` 不再是用例错误）仍成立。
  - `cli-task-control` / `cli-task-create` / `cli-task-depends` / `cli-task-purge` / `cli-task-recover` /
    `cli-task-retry` / `cli-task-run-progress` / `cli-task-service` / `cli-schedule` / `cli-targeted-tests` /
    `cli-transcript` / `cli-impact` / `cli-managed-project` / `cli-managed-integration` / `revision-delivery` /
    `cli-session-*` / `cli-prose-question*` / `revision-delivery` / `packages/storage` 相关测试：全部按新拼写改写并通过。
- **不做**：全量套件（`bun run check`）不在本分支运行——它只在 `dev` 候选上运行（ADR-0038/0039）；
  本 ADR 的交付记录写明实际运行了哪些文件。
- **文档同步**（ADR-0050 / ADR-0063）：`docs/guides/cli/task-lifecycle.md`（§4 全节 + 新增寻址说明）、
  `task-result-verify.md`、`task-revision-session.md`、`integration-dag-scheduler.md`（§12 依赖），
  以及 `manual.md` §4、`workflow.md` §1、`recipes.md`、`features.md`、`troubleshooting.md` 的命令示例与版本头。
- **验收判据**：拿一个已存在 Task，只用它的 id 就能完成 `status → submit → run → result capture → verify`，
  全程不需要任何 project id；`task list` 不带参数能看到它，且行里有正确的 `projectId`。

## 关联

- [ADR-0005](0005-task-entry-and-worktree-location.md)（本 ADR 改其寻址拼写）、[ADR-0065](0065-task-input-fields.md)（三个必填字段与 `--name` 的拼写）、
  [ADR-0068](0068-self-describing-cli-command-tree.md)（命令树是唯一清单，用法错误指向 `help`）、
  [ADR-0011](0011-default-full-permission-mode.md)（拒绝是正确性核对，不是审批）、
  [ADR-0070](0070-service-process-signal-kernel.md)（Project 仍是 Task Service 的父节点）、
  [ADR-0074](0074-managed-integration-ref-and-merge-queue.md)（`project integration request` 保持项目拼写）。
- 代码：`apps/runtime/src/task-scope.ts`（解析的唯一入口）、`packages/contracts/src/index.ts`（`taskProjectIdSchema`）、
  `packages/storage/src/database.ts`（`resolveTaskProject` / `resolveOperationProject` / `resolveRevisionDeliveryProject` / `listAllTasks`）、
  `apps/cli/src/command-tree.ts` 与 `apps/cli/src/main.ts`（拼写与分发）。
