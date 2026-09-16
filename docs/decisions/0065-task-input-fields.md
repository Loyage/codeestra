# ADR-0065：任务输入字段重构 —— 显示标题 / 命名标题 / 任务详情，删除约束与任务类型

Status：Accepted（用户 2026-09-16 明确选择：三个字段必填、命名标题同时用于分支与 worktree 目录、两个标题是 Task 级且创建后不可修订、约束与任务类型彻底删除、旧任务由首行派生显示标题而命名标题留空、历史 `ADD_CONSTRAINT` intent 行保留为只读历史值）。**「任务模板」用户明确本轮不实现**，本 ADR 不引入该字段。

## Context

- 新建任务的输入面（`apps/ui/src/new-task-dock.tsx`、`codeestra task create`）只有 `specification`（正文）、`constraints[]` 与 `kind` 三个字段（ADR-0017）。
- `specification` 在任务列表里被整段当标题渲染（`apps/ui/src/task-list.tsx` 的 `task-title`），长正文把列表挤成段落；任务除了编号 `#12` 之外没有任何人类可读的名字。
- Task branch 与 worktree 目录都用内部 UUID（`refs/heads/task/<task-id>`、`worktrees/<project-id>/<task-id>/`，ADR-0005），在 Git 与文件系统里无法辨认哪个目录对应哪件事。
- 用户判断「任务约束」与「任务类型」已经没有用途：没有任何命令或界面依赖 `kind` 的区别行为（ADR-0017 已记录 `SELF` 无区别实现），约束则与正文重复表达同一件事。
- 约束与类型同时渗透在契约、SQLite 列、领域对象、三个 Adapter 的提示词拼装、CLI flag 与 UI 表单里，删除必须一次完成，不能只在 UI 隐藏。

## Options

- 标题拆分：显示标题 + 命名标题两个字段／只加一个标题／把正文首行当标题自动截断。
- 命名标题的作用面：分支 + worktree 目录／只用 worktree 目录／只做展示（不改 Git 命名）。
- 命名格式：`task/<编号>-<slug>` + 目录 `<编号>-<slug>`／只用 `task/<slug>`（需要项目内唯一门禁）。
- 标题的修订面：Task 级、创建后不可改／进入 revision、可随修订变化。
- 删除深度：契约 + DB 列 + 领域 + Adapter + CLI + UI 全删／只删输入面（DB 列保留）。
- 历史 `intents.kind = 'ADD_CONSTRAINT'` 行：保留为只读历史值／改写为 `AMEND_TASK`／拒绝升级。
- 旧任务（无标题）迁移：显示标题由正文首行派生、命名标题留空／两者都回填／都不回填、读时回退。

## Decision

**D01 字段。** `task create` 的输入是三个必填字段，缺任何一个都是边界拒绝（契约层 Zod，命令面错误码 `INVALID_REQUEST`），不再有默认值：

| 字段 | 契约属性 | 约束 | 用途 |
|---|---|---|---|
| 显示标题 | `displayTitle` | 非空、单行、≤ 200 字符 | 一句话说明这个任务在做什么；任务列表与任务详情按它渲染 |
| 命名标题 | `namingTitle` | 小写短横线 slug：`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`，≤ 50 字符 | 给分支与 worktree 目录一个可读名字 |
| 任务详情 | `specification` | 非空（沿用既有 `nonBlankString`） | revision 正文；Agent 提示词的主体 |

`displayTitle` 与 `namingTitle` 是 **Task 级**字段：它们不是 revision 事实，创建后没有命令可以修改（改标题不是规格变更；确需改动时新建任务）。`specification` 仍属于 revision（本 ADR 不改列名）。

**D02 提示词。** Adapter 收到的 revision 载荷去掉 `constraints`、增加 `displayTitle`，拼装为「标题 + 正文」：`Codeestra revision <id>` / `Task: <displayTitle>` / 正文。命名标题**不进入**提示词——它只服务命名，进入提示词会把「目录叫什么」混进「要做什么」。

**D03 Git 命名。** 新建 workspace 时分支为 `refs/heads/task/<displayNumber>-<namingTitle>`，目录为 `<worktreesRoot>/<projectId>/<displayNumber>-<namingTitle>`。编号保证同一项目内唯一，因此**不新增命名标题唯一性门禁**（同项目出现两次同名 slug 是合法的）。`naming_title` 为空的历史任务继续使用其**已记录**的 `workspaces.branch_ref` / `path`；仍未建 workspace 的历史任务退回 `task/<taskId>` 与 `<taskId>`，不使用 `NULL` 拼路径。已存在的 `task/<uuid>` 分支与目录**一律不改名**：迁移只做数据，不动用户仓库里的 ref 与目录（ADR-0005 的「分支用内部稳定 ID」对**新**任务由本条取代）。

**D04 删除约束与任务类型。** 一次性从全链路删除，而不是只在输入面隐藏：

- 契约：`constraintSchema` / `constraintsSchema` / `taskKindSchema`，以及 `task.create`、`task.revision.create`、`AgentStartRequest.revision` 上的对应字段；
- 领域：`packages/domain/src/task-revision.ts` 的 `Constraint` 与 `RevisionInput.constraints`；
- SQLite（schema **v35**）：`tasks.kind`、`task_revisions.constraints_json` 两列删除（两表重建，`task_revisions` 的 append-only 触发器按原样重建），`tasks` 增列 `display_title TEXT NOT NULL`、`naming_title TEXT`（可空）；
- Adapter：三个 `composeRevisionPrompt` 的 Constraints 段；
- CLI/UI：`task create --constraint` / `--kind`、`task revision create --constraint`、停靠条的约束列表与类型下拉框；`TASK_KIND_UNSUPPORTED` 稳定码随之消失（它只服务于 `--kind SELF`）；
- 事件载荷：`TaskCreated` 不再带 `kind`，`TaskRevisionCreated` 不再带 `constraintCount`（事件名不改，历史行不改，ADR-0035 仍成立）。

`task revision create` 的「必须改点什么」规则变为：改正文或改功能声明，二者至少其一。

**D05 历史 intent 与知识 scope 不重写。** `intents.kind` 的 CHECK **保留** `ADD_CONSTRAINT`：库里有真实用户操作记录（历史上「只追加约束」的修订），把它们的分类改写成 `AMEND_TASK` 就是改写历史，拒绝升级则会把可升级的库挡在门外。产品代码从此**不再写入**该值（`createTaskRevision` 固定 `AMEND_TASK`），常量注释如实说明它是历史值。同理，Project Knowledge 的 front-matter `scope: ALL|DEVELOPMENT|SELF` 解析**不变**（不让人工维护的现有文件变成非法），但 Task 已无 kind，解析时一律按 `DEVELOPMENT` 判定适用性：`ALL` 与 `DEVELOPMENT` 条目适用，`SELF` 条目当前无任何执行会适用。这是「SELF 尚不存在」的事实陈述，不是重新引入任务类型字段；Phase 7 落地 Self Task 时按 PROJECT_SPEC §5 重新迁移。

**D06 迁移不伪造命名。** v35 重建 `tasks` 时，历史行的 `display_title` 取当前 revision 正文的**首行**（首行为空则取整段）并截断到 200 字符——这是从既有权威数据派生的展示摘要；`naming_title` 留空，不由 Runtime 编造英文名字（D03 的退回规则承担后续命名）。

**D07 UI。** 底部停靠条去掉「收起/展开」两态：三个字段都是必填，单行收起形态无法产出合法命令。停靠条常驻展开，含三个字段与创建按钮；`⌘/Ctrl + Enter` 创建、`Esc` 不再收起（无收起态）。任务列表行以显示标题为主行，命名标题与编号作为次信息；任务详情页展示三个字段。

**D08 CLI 对等。** `codeestra task create <project-id> <任务详情…> --title <显示标题> --name <命名标题> [--feature <module-id>]…`：详情保持位置参数（沿用「多词原样拼接」的既有用法），两个标题是必需 flag，缺任意一个都是用法错误（退出码 2）。所有 UI 字段都有对应参数，不新增只存在于 UI 的能力。

**D09 任务模板不在本轮。** 用户明确本轮不实现，代码与契约里不出现该字段，也不预留空列。

## Consequences

- 常态新增审批成本：**0 步、0 等待**。创建仍是一条命令/一次表单提交，字段变多但不引入任何确认。
- 不新增权限门禁、审批层、信任流程或沙箱。
- 破坏性面：`task.create` 与 `task.revision.create` 的请求形状**不向后兼容**（旧客户端缺新字段会被拒）。这是产品尚在自用阶段的有意选择，不是静默降级。
- 历史任务的显示标题是派生值，可能与用户当时心里的摘要不同；`naming_title` 为空的旧任务分支名仍是 UUID。
- `tasks.kind` 删除后，Phase 7 的 Self Task 需要新的迁移重新引入判别字段（与 ADR-0046 对 `intents.kind` 的处理同构）。
- 知识 `scope: SELF` 条目在 Phase 7 之前永不适用，`project knowledge resolve` 会如实显示 `appliesToTask: false`。
- 本 ADR 不改 `tasks.id` / `task_revisions.specification` 的列名，因此 `TaskCreated` / `TaskRevisionCreated` 之外的审计链、证据绑定（revision/commit/digest）与幂等回执语义完全不变。

## Verification

定向验证（ADR-0038，只在 `Loyage/task_auto` 分支跑，不跑全量）：

- 契约：三个字段的必填与非法值（缺字段、空显示标题、多行显示标题、超长、大写/空格/连续短横线的命名标题）都被 `runtimeRequestSchema` 拒绝。
- 存储：v34 → v35 迁移在含历史数据的库上成功，`display_title` 由首行派生、`naming_title` 为 NULL、行数不变、`PRAGMA foreign_key_check` 无违规；`task_revisions` 的 append-only 触发器在重建后仍然生效（UPDATE/DELETE 被拒）。
- 命令面：`task create --title/--name` 创建后 `task list --json` 能读回三个字段；缺 `--title`/`--name`、空 `--name`、非法 slug 退出码 2 且不创建任务；`--constraint` / `--kind` 现在是未知 flag（退出码 2）。
- 命名：新建 workspace 的分支为 `task/<编号>-<slug>`、目录为 `<编号>-<slug>`；历史任务（`naming_title` 为空）仍走 `task/<taskId>`。
- 提示词：Adapter 拼装含 `Task: <displayTitle>` 且不含 Constraints 段。
- 修订：`task revision create` 不再接受 `--constraint`；只改功能声明或只改正文都能成立，两者都不改仍被拒为 `INVALID_REVISION`。
- 人工确认（自动化禁止）：停靠条三个字段的排版、焦点顺序与窄屏换行由用户目视确认，本 ADR 不声称已验证。

## Related

- [ADR-0005](0005-task-entry-and-worktree-location.md)（分支/目录位置；本条只改**新**任务的命名）
- [ADR-0017](0017-new-task-dock.md)（新建任务停靠条；本条的 D07 取代其收起形态与 `--kind`/`--constraint` 字段，并关闭其记录的 `kind: SELF` 缺口）
- [ADR-0035](0035-event-name-and-handoff-faces.md)（事件名不改、载荷可随版本演进）
- [ADR-0038](0038-branch-targeted-tests-and-dev-full-suite.md) / [ADR-0039](0039-layered-verification-evidence.md)（定向测试与提升前证据）
- [ADR-0041](0041-project-knowledge-layers-and-execution-binding.md)（知识分层与 scope）
- [ADR-0046](0046-intent-kind-check-shrink.md)（`intents.kind` 的可产生取值纪律）
- [ADR-0050](0050-user-manual-and-doc-sync-discipline.md)（文档同步）
- [ADR-0059](0059-feature-declaration-conflict-rule.md)（功能声明仍属于 revision）
- [任务进度](../tasks/README.md)
