# 功能清单：「这软件能做什么」

> **适用版本** ADR-0070 S1–S4 实现分支（2026-09-17） · **schema** v38 · **最后校对** 2026-09-17
> 版本会前进：`dev@6c7de03` 只是本目录最后一次校对的基线；当前适用版本以
> **本次修订（ADR-0066 / schema v36）**：删除 dev clone、长期 `dev` 集成分支、`task integrate` / `task integration *` / `promotion *` 与 dev 构建通道；Task 基线只有一种（项目文件夹建 workspace 时当前检出的分支），
> 成果停在 `refs/heads/task/<task-id>`，合并由你自己完成。
> **本次修订（ADR-0074 / schema v38）**：Task 基线改为项目受管的 integration ref（`refs/codeestra/integration`）；成果经 `project integration request|run` 的合并、独立 Integration Verification 与 CAS 进入该 ref，**没有任何命令把它发布到你的分支**。命令面见 [cli/managed-integration.md](cli/managed-integration.md)。
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。
> **本次修订（ADR-0076）**：`task` 组不再以 `<project-id>` 开头：Task id 全局唯一，它自己就是地址，**project 是 Task 的字段**（`task create` 用 `--project`，`task list` 默认为本 Runtime 全部项目、`--project` 过滤；`task schedule status|plan|run` 仍收 `<project-id>`）。旧写法不再接受。
> 「创建任务」与「规格修订」两行由本分支按 **ADR-0065** 改写（三个必填字段；约束与任务类型已删除）。
> 「调度、容量与冲突」一节新增「全局暂停」一行，并由 FOUNDATION-097 标明容量行的目标语义（ADR-0061 D01–D03）；
> 「任务」表的「永久删除」一行由 FOUNDATION-090 新增（ADR-0058）；「调度、容量与冲突」一节的声明功能与
> 冲突判定两行由 FOUNDATION-091 改写（ADR-0059）。
> 「任务」表的「列出任务」与「状态投影」两行，以及新增的「Agent 运行结局与最后输出」一行，
> 由用户任务 `Loyage/simplize_task_ui`（2026-09-16）同步（无新命令：只用已有的 `task list` / `task status` 字段）。
> 「接入与项目」表的 dev 事实来源一行由 FOUNDATION-093 第三轮同步（ADR-0060 修订）；
> 「设置」表新增「设置总览」一行，「权限模式」一行的 CLI 入口改为 `settings permission …`
> 并链接 0064（FOUNDATION-098 / ADR-0064：`settings list` 总览，权限模式移入 `settings`）。
> 「调度、容量与冲突」的容量与上限、槽位预留两行由 **FOUNDATION-096** 改写（ADR-0061：唯一 Runtime 全局上限），
> 同一表的「全局暂停」一行由 **FOUNDATION-097** 从「尚未实现」改为实现事实（ADR-0061 D04–D10：持久屏障与
> Provider 主进程冻结，Pi 为 `SUPPORTED`、Codex/Claude 为 `REQUIRES_VALIDATION`）；
> 「资源与知识」表新增「集成后自动回收 worktree」一行（ADR-0062 / 用户任务，无 schema 变更）。
> 「设置」表的并发上限设置一行同轮新增（同一个值也可从设置面实时调整）；
> 「永久删除」一行的 `RECOVERY_REQUIRED` 对账由用户任务 `task/930f5325` 同步（ADR-0058 D02 修订，2026-09-16）；
> 其余行沿用 FOUNDATION-091 的校对基线。
> **FOUNDATION-099 / ADR-0070 S1–S4**：新增「Service Kernel」表；S5–S10 仍列为未实现边界。

一行一个能力。列的含义：

- **能做什么**：这个能力对用户交付什么。
- **CLI 入口**：完整命令路径（命令参考见 [cli/README.md](./cli/README.md)）。
- **UI 位置**：保留暂停前的历史定位，**当前全部不可用**；ADR-0067 起 Web UI 没有入口。实际入口以 CLI 列为准。
- **ADR**：相关的已接受决策记录。

> 这份清单只写**当前实现真实具备**的能力。未实现 / 未验证的部分见文末「明确的未实现与未验证」。

---

## Service Kernel

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| Service 查询与 metadata | 查询稳定 root/system/Project/Task Service 树与 core 投影；通过 metadata CAS 写 namespaced JSON，不绕过 core state | `service list/get/tree/state get/state set` | —（CLI-only） | [0070](../decisions/0070-service-process-signal-kernel.md) |
| Process 兼容 facade | 把既有 Execution 投影为同 ID Development Process；input/pause/resume/terminate 复用 Task/Session handler | `process list/get/input/pause/resume/terminate` | —（CLI-only） | [0070](../decisions/0070-service-process-signal-kernel.md) |
| 持久 Signal | contract 校验、enqueue/claim/ACK/retry/dead-letter/reconcile；target + idempotency key 收敛 | `signal send/list/get/retry` | —（CLI-only） | [0070](../decisions/0070-service-process-signal-kernel.md) |
| Intention 受理 | 发 `SIG_P` 并创建 `CREATED` Intention Process；当前明确返回 `PENDING_S6`，不解释、不启动 Agent | `intent send` | —（CLI-only） | [0070](../decisions/0070-service-process-signal-kernel.md) |

## 接入与项目

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| 项目识别 | 读仓库身份：工作树根、`main` ref、对象格式、HEAD（ADR-0066 删除了 dev clone 与 `dev` 基线字段） | `project inspect [path]` | 项目 → 添加本地项目 | [0064](../decisions/0066-remove-dev-clone-and-dual-baseline.md) |
| 验证策略展示 | 打印 `main` ref 上 `.codeestra/policies/verification.json` 的状态、digest 与逐条命令 | `project policy [path]` | 项目 → 验证策略 | [0006](../decisions/0006-task-verification-policy.md) |
| 项目接入（trust） | 注册项目；把「你刚看到的身份 + 验证策略 digest + 影响映射 digest」一起确认；FULL 零确认 / STRICT 输 `TRUST` | `project trust [path] [--yes]` | 项目 → 添加/信任此项目（被拒绝时显示稳定码 + 本地解释） | [0011](../decisions/0011-default-full-permission-mode.md)、[0031](../decisions/0031-impact-snapshot-and-deterministic-conflict-analyzer.md)、[0064](../decisions/0066-remove-dev-clone-and-dual-baseline.md) |
| Task 基线 | **只有一种**（ADR-0074 取代 ADR-0066 的规则）：从**项目受管 integration ref**（`refs/codeestra/integration`，由 `project trust` 创建、缺失时首次需要补建）当时的 commit 建基线，把 ref 与 commit 一起固定（`workspaces.base_ref`/`base_commit`）；ref 与文件夹分支都不可得时以 `TASK_BASE_REF_UNRESOLVED` 拒绝。`task run --base-ref <refs/heads/…>` 可单次覆盖 | `task run`（准备 workspace 时） | —（同一命令面） | [0005](../decisions/0005-task-entry-and-worktree-location.md)、[0074](../decisions/0074-managed-integration-ref-and-merge-queue.md) |
| 受管 integration | `project integration status\|init\|queue\|request\|run\|retry\|cancel` 与 `task integration show`：持久 merge queue（同项目串行、跨项目并行）、独立 Integration Verification、`git update-ref` CAS 推进 ref；冲突/验证失败/ref 移动/重启保留现场且不 force。**不发布到用户分支**，也不创建 Integration Process/Agent | `project integration run` | —（同一命令面） | [0074](../decisions/0074-managed-integration-ref-and-merge-queue.md)、[0070](../decisions/0070-service-process-signal-kernel.md) |
| Web UI 接入快捷命令（已删除） | ADR-0067 起不再提供接入并打开界面的复合命令；使用 `project inspect|policy|trust|list` | — | —（UI 已暂停） | [0067](../decisions/0067-pause-web-ui-and-cli-focus.md) |
| 项目列表 | 列出已信任项目及其确认策略 | `project list` | 顶部项目选择器 | — |
| 影响映射校验 | 报告 `main` ref 上的 `.codeestra/impact.json` 是否存在且是已确认的那一份 | `project impact validate [path] [--json]` | **调度 → 影响映射 · impact.json** | [0031](../decisions/0031-impact-snapshot-and-deterministic-conflict-analyzer.md) |

## 任务

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| 创建任务 | 原子保存原始意图、首 revision、事实事件与幂等回执；三个必填字段：显示标题、命名标题、任务详情（ADR-0065） | `task create --project <project> <详情…> --title <显示标题> --name <命名标题>` | 新建任务停靠条 | [0065](../decisions/0065-task-input-fields.md) |
| 列出任务 | 列出任务（默认隐藏归档，`--all` 含归档）；每行附带最新一次尝试的 `latestExecution`（结局事实，见下行） | `task list [--project <project>] [--all]` | 任务工作台列表（含搜索/筛选/排序；行尾提示在 Agent 退出后改说那次尝试的结局） | [0034](../decisions/0034-compact-task-workbench.md) |
| 提交任务 | 用 expected version 把 `DRAFT` 转 `READY`，并在同一命令里核对依赖 + 跑一次调度 pass | `task submit <task> <expected-version>` | 任务详情 → 提交 | — |
| 运行任务 | 显式请求启动；同自动调度同一门禁（依赖/冲突/容量） | `task run <task> <expected-version> [--adapter <id>] [--allow-unknown] [--json]` | 任务详情 → 启动 Agent | [0030](../decisions/0030-phase2-parallel-scheduling.md) |
| 暂停 / 恢复 | 暂停是协作停止（确认 provider 退出后才 `PAUSED`）；恢复以 provider conversation resume 继续 | `task pause`、`task resume <…> [--adapter <id>] [--allow-unknown]` | 任务详情 → 暂停 / 继续 | [0016](../decisions/0016-task-pause-cancel-archive.md) |
| 重试失败任务 | 只对 `FAILED` 生效；重新入队（可能需要先重建 worktree）后，用同一个门禁请求一次启动 | `task retry <task> <expected-version> [--adapter <id>] [--json]` | 任务详情 →「更多操作」→ `重试`（显示 CAS 版本与将使用的 Adapter，可换成已注册的 Adapter；被拒绝时显示 Runtime 的稳定码，「等待」与「已启动」分开显示） | [0036](../decisions/0036-task-retry-after-failure.md)、[0042](../decisions/0042-rebuild-reclaimed-worktree.md) |
| 取消 / 归档 | 取消是终态（不自动重开）；归档是软删除（只写 `archived_at`，不删行、不回收） | `task cancel`、`task archive`、`task unarchive` | 任务详情 →「更多操作」 | [0016](../decisions/0016-task-pause-cancel-archive.md) |
| 永久删除 | **不可撤销**：删掉任务的全部记录（含 append-only 的修订/impact/定向测试计划/知识绑定）与它自己的 worktree、验证副本、`task/<id>` 分支，并写一条 `TaskPurged`；需 `--yes`；非终态先协作停止，`RECOVERY_REQUIRED` 先按观察对账（无法确认进程已退出则拒绝）；**成果已进 `dev`/`main` 的任务默认拒绝**（只能归档）。被拒绝时 `--force` 可删：先按记录的身份终止 provider，再删掉本来会拒绝的行（含 `dev`/`main` 的来源记录，必要时连同那条提升记录），归属不明的目录/分支留在磁盘上并逐项列出 | `task purge <task> <expected-version> --yes [--force] [--reason <text>]` | 任务详情 →「更多操作」→「永久删除」（输入任务编号才启用）；被拒绝后多一个「仍要强制删除」 | [0058](../decisions/0058-task-purge.md) |
| 状态投影 | 列出 Execution / Session / 验证 / 集成投影，附 Agent 完成注记与散文提问等待 | `task status <task> [--json]` | 任务详情（执行 / 验证 / `集成批次 · dev` 记录，后者含每个批次的成员表） | [0013](../decisions/0013-read-only-agent-transcript-view.md) |
| Agent 运行结局与最后输出 | 最新一次尝试的结局（provider 记的 `SUCCESS`/`FAILURE`，或**没有记录到结局**）、停止原因、工具调用数与**最后一段助手文本**（Runtime 最多保留 2000 字符，截断时如实标注只保留尾部）；`task list`/`task status` 的 `latestExecution` 让列表行不必逐行读详情 | `task status <task> [--json]`（`executions[].session.completion.facts`、`latestExecution`） | 任务详情顶部「Agent 运行结果」卡片（含 `查看完整会话记录 ↓` 跳转）+ 任务列表行提示 | FOUNDATION-056（无 ADR；仅前端投影与只读字段） |
| 规格修订 | 创建新 revision（改任务详情或功能声明，二者至少其一）并列出历史 | `task revision create`、`task revision list` | —（界面无入口） | [0028](../decisions/0028-revision-delivery-and-stale-session-startup-reconcile.md)、[0065](../decisions/0065-task-input-fields.md) |
| Revision 投递台账 | 单独读取与解决「修订是否真的到达运行中的 Execution」 | `task revision delivery list/get/resolve` | —（界面无投影） | [0028](../decisions/0028-revision-delivery-and-stale-session-startup-reconcile.md) |
| 优先级（**当前无命令面**） | 优先级是 Task 模型与调度排序的一部分（降序优先），但**没有任何 CLI 命令可以改它**：`task create` 不接受 priority 参数，新建 Task 的 priority 为 0 | —（无入口） | 任务工作台排序 | [0030](../decisions/0030-phase2-parallel-scheduling.md) |

## Agent 执行、会话与终端

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| Agent 会话可见 | 读 provider 自己的持久会话文件：工具调用/返回、助手文本、thinking、token 与成本；默认截断，可取回整块 | `task transcript`、`session transcript`、`session transcript part` | 任务详情 → Agent 会话与执行过程 | [0013](../decisions/0013-read-only-agent-transcript-view.md) |
| 原生终端接管 | 单一 writer lease + 安全点 + 准入决策：attach 读投影终端流、detach 保持运行、release 写释放字节并验证 provider 已退出且会话文件仍在 | `session handoff status/request/cancel`、`writer acquire/release`、`admit/attach/detach/release`、`terminal read/write` | 任务详情 → 原生终端与会话交接 | [0010](../decisions/0010-live-agent-terminal-takeover.md)、[0023](../decisions/0023-strict-permission-attention-and-session-writer-lease.md)、[0026](../decisions/0026-native-terminal-pty-transport.md) |
| 结构化提问 | Agent 用 `ask_user_question` 一次提 1–4 题（每题 2–4 个可选项、可多选、可用自己的话答）；一份问卷 = 一条 Attention = 一次 answer | `attention list`、`attention answer … --choose/--text/--cancel` | 待处理（单选/多选 + 自由文本） | [0014](../decisions/0014-agent-structured-question-channel.md) |
| 散文提问等待 | 识别「没用工具、正文提问并结束轮次」，记成一条独立 Attention 与 `WAITING_FOR_USER`，并给出明确退出方式 | `attention resolve … --answer/--dismiss`、`settings prose-question-attention` | —（CLI-only） | [0043](../decisions/0043-prose-question-attention-escalation.md) |
| 设置总览 | 一条只读命令列出全部三项启用的 Runtime 级设置（权限模式 / 散文开关 / 并发上限），每项给出生效值、产品默认、取值、是否显式设置与存储位置 | `settings list [--json]` | —（CLI-only） | [0064](../decisions/0064-settings-list-and-permission-as-a-setting.md)、[0067](../decisions/0067-pause-web-ui-and-cli-focus.md) |
| 权限模式 | 默认 FULL 零确认；可无确认切 STRICT 恢复旧门禁（工具逐次审批、两步成果 commit、提升批准） | `settings permission get`、`settings permission set <full\|strict>` | 界面显示当前模式；STRICT 下出现 TRUST 输入与二次确认 | [0011](../decisions/0011-default-full-permission-mode.md)、[0023](../decisions/0023-strict-permission-attention-and-session-writer-lease.md)、[0064](../decisions/0064-settings-list-and-permission-as-a-setting.md) |
| Agent 配置 | 持久化 provider/model/thinking，分全局默认与每项目覆盖；逐字段按 `环境变量 > 项目 > 全局 > Adapter 默认` 解析；只影响新 Session | `agent config get/set/clear [--project <id>] [--adapter <id>] [--provider/--model/--thinking/--unset]` | Agent 设置标签页（`当前生效值` 表与 `编辑并保存`） | [0012](../decisions/0012-agent-configuration-scopes.md) |
| CLI 自描述 | 命令树是 CLI 的唯一命令清单：每一层都能自报有哪些子命令及其大致功能范围，argv 由同一份树解析，测试再核对 `docs/guides/cli` 与 Runtime 命令面的覆盖 | `help`、`<命令路径> help`、`--help`/`-h`、`runtime commands [--json]` | —（命令面自身，不是 UI 能力） | [0068](../decisions/0068-self-describing-cli-command-tree.md) |
| Agent 插件选择 | 选 Pi 的四类资源（extensions / skills / prompt templates / themes）；选择是**一个整体字段**（项目整份替换全局，不逐项合并）；生效值连同来源层与第三方扩展风险写进 Execution | `agent plugins list`、`agent plugins select [--extension/--skill/--prompt-template/--theme <path>]… [--clear]` | Agent 设置标签页（`插件候选` 与 `清除选择`） | [0044](../decisions/0044-agent-plugin-selection-and-detection.md) |
| 多 Adapter | 注册 `pi`（默认）、`codex`、`claude`；每次运行绑定一个 Agent，换 Adapter 是新建 Execution | `task run/resume/retry --adapter <id>` | 任务详情 → 启动 Agent / 继续（`Agent` 下拉框，在 `READY` 与 `PAUSED` 时出现）；重试入口另有自己的 Adapter 下拉框，默认「沿用该任务上一次运行的 Adapter」，选项来自 `runtime.ping` 的已注册列表 | [0029](../decisions/0029-codex-adapter-transport-and-capabilities.md)、[0040](../decisions/0040-claude-code-adapter-transport-and-capabilities.md) |
| Session Guidance | 对**运行中的会话**给一条指导：不产生 TaskRevision、不动 revision、不使验证失效；记录后每个新 Execution 启动时随启动参数交给 provider（不随进程消失）；**“已投递” = provider 通道接收（入队），≠ 模型已读**（`modelAcknowledgement` 恒为 `UNSUPPORTED`）；无通道即 `CHANNEL_UNSUPPORTED` 且退出码 1 | `session guide <project> <task> --message <text>`、`session guidance list/get` | —（CLI-only；无 UI 投影） | [0010](../decisions/0010-live-agent-terminal-takeover.md)、[0057](../decisions/0057-session-guidance-channel-and-fact-layering.md) |

## 长命令与取消

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| 后台长命令 | 验证等长命令可后台化：返回持久 Operation 句柄；`0` 表示「已受理」，不代表通过 | `task verify … --background` | 任务详情 → 长命令进度 | [0019](../decisions/0019-long-command-operations.md) |
| Operation 观察与取消 | 列出/读取/取消 Operation；取消未确认时退出码 1（进程可能还在跑） | `task operation list/get/cancel` | 任务详情 → 长命令进度 | [0019](../decisions/0019-long-command-operations.md)、[0027](../decisions/0027-verification-cancelled-and-progress-events.md) |
| 进度事件 | 每个步骤与观察到的输出块、以及 Operation 的 settle 都作为 domain event 发布到同一事件流 | `events list/tail` | 运行事件 + 长命令进度 | [0027](../decisions/0027-verification-cancelled-and-progress-events.md) |

## 调度、容量与冲突

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| 调度引擎 | 事件触发 + 周期恢复的 pass；`status` 报事实、`plan` 是有序 dry run、`explain` 回答「为什么它现在不跑」 | `task schedule status/plan/explain/run` | 调度 → 调度引擎 / 调度判定 | [0030](../decisions/0030-phase2-parallel-scheduling.md)、[0033](../decisions/0033-scheduling-engine.md) |
| 声明功能 | 在 revision 上声明「这个 Task 在做哪个功能」（`modules[].id`）；写入时按项目 `main` ref 的映射校验；省略即继承上一条 revision 的声明 | `task create --feature <module-id>`（可重复）、`task revision create --feature <module-id>` | 新建任务 / 任务详情（声明的功能） | [0059](../decisions/0059-feature-declaration-conflict-rule.md) |
| UNKNOWN 显式放行 | 对 `CONFLICTING` **永不放行**；对 `UNKNOWN` 做单次、绑定 revision/基线/分析器版本的放行（当前规则不产生 `UNKNOWN`，所以日常不可达） | `task run --allow-unknown`、`task schedule clear-unknown` | 调度 → UNKNOWN 的显式单次放行 | [0030](../decisions/0030-phase2-parallel-scheduling.md) D05、[0059](../decisions/0059-feature-declaration-conflict-rule.md) D02 |
| 容量与上限 | **整个 Runtime 只有一个并发上限**（默认 2，上限 16），跨全部项目与 Adapter；占用按 Task 去重；改完**实时生效**（提高即启动等待中的候选，降低不抢占已运行 Task）；读回存储值，非法值有自己的稳定码 | `scheduler capacity get/set --limit/reset`（无 project/adapter 参数）与设置面拼写 `settings concurrency get/set --limit/reset`（同一行、同一事件） | 调度 → **Runtime 全局容量** | [0061](../decisions/0061-runtime-global-load-control.md) D01/D02（修订 [0032](../decisions/0032-capacity-and-slot-reservations.md)） |
| **全局暂停（暂停全部 / 继续全部）** | 持久屏障 + 可核验的 Provider 主进程冻结：先拦新启动与新投递，再按 `pid + OS start token + incarnation` 核验后只对**主进程**发 `SIGSTOP`/`SIGCONT`；**不改写** Task/Execution/Session 状态、不释放 slot/workspace/lease；跨 Runtime 重启保持，只有显式 `resume` 解除；部分失败一律 `RECOVERY_REQUIRED` 且屏障保持。当前只有 **Pi** 声明 `providerProcessSuspension: SUPPORTED`（真实进程实测），Codex / Claude Code 仍是 `REQUIRES_VALIDATION`，遇到它们的目标会 fail closed | `scheduler control status/pause/resume/reconcile` | 全局外壳的「全局负载控制」条（不依赖选中项目）+ 逐目标事实 | [0061](../decisions/0061-runtime-global-load-control.md) D04–D10 |
| 槽位预留 | 在**一个 immediate 事务**里复核 Task 版本、已评估 revision、依赖事实、ImpactSnapshot 代数与**整个 Runtime 的唯一容量上限**后记录预留 | `scheduler reservations list/acquire/release/prepare-workspace/reconcile` | 调度 → 槽位预留 | [0032](../decisions/0032-capacity-and-slot-reservations.md)、[0061](../decisions/0061-runtime-global-load-control.md) D01 |
| 预留对账 | 复核每个活跃预留的持有者进程是否真的还在：确认消失则释放并记录；活着的/无法核验的保留槽位 | `scheduler reservations reconcile` | 调度 → reconcile 观测 | [0032](../decisions/0032-capacity-and-slot-reservations.md) |
| 冲突判定 | **只比较声明**：两侧声明了同一功能 id、且对方未完成（非 `SUCCEEDED`/`CANCELLED`、未归档）才 `CONFLICTING`；否则默认 `SAFE_TO_PARALLELIZE`。**同文件/同目录/同模块/共享资源不再拦人**（只作为事实进入解释输出） | `project impact validate/show/explain` | **调度 → 影响映射 · impact.json**；任务详情 → 影响与冲突判定 | [0059](../decisions/0059-feature-declaration-conflict-rule.md)（取代 [0031](../decisions/0031-impact-snapshot-and-deterministic-conflict-analyzer.md) 的判定语义；快照/映射/失效键/audit 表仍自 0031） |
| 任务依赖 DAG | 增删查依赖；加环拒绝且不部分应用；上游必须进 `dev` 才满足 | `task depends add/remove/list` | 任务详情 → 依赖与 BLOCKED 原因 | [0024](../decisions/0024-task-dependency-dag-and-blocked.md) |

## 成果、验证与集成

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| 成果提交 | FULL 单步 capture；STRICT 两步 prepare + commit `--confirm`。固定 HEAD/ChangeSet/revision，沿用仓库 identity，正常跑 hooks，失败保留现场 | `task result capture`、`task result prepare`、`task result commit … --confirm` | 任务详情 → 提交成果 / 成果提交授权 | [0003](../decisions/0003-task-result-commit-policy.md)、[0011](../decisions/0011-default-full-permission-mode.md) |
| 任务验证 | 用 `main` ref 上人工维护的策略，在固定 commit 的 detached 副本里运行；证据不含原始输出 | `task verify [execution-id] [--policy auto\|targeted\|project] [--background]` | 任务详情 → 验证任务 | [0006](../decisions/0006-task-verification-policy.md)、[0008](../decisions/0008-efficiency-first-service-form.md) |
| 分层测试证据 | 分支把定向范围写进 `.codeestra/tests.json`；`record` 把它快照成绑定 `(task, revision, commit, digest)` 的 append-only 记录；`verify` 只消费已记录的计划 | `task tests record/show/history` | —（界面只显示验证结果与证据，无计划/来源面板） | [0038](../decisions/0038-branch-targeted-tests-and-dev-full-suite.md)、[0039](../decisions/0039-layered-verification-evidence.md) |

## 稳定提升（已删除）

**ADR-0066 把整条 `dev → main` 提升路径从产品中删除**（schema v36）：`promotion prepare/approve/promote/
abandon/get/list`、`promotion full-suite run|list`、IntegrationBatch 与独立集成验证都不存在，
`dev_full_suite_evidence` 表也已 DROP。成果停在 `refs/heads/task/<task-id>`，是否合并由你自己决定。
本仓库自身仍走 `AGENTS.md` / `docs/agents/runbook.md` 的人工四步（push 固定候选到远端 `dev` → main 检出
ff-only 拉取 → 重启核对 → 推回远端 `main`），但那是仓库约定，产品不提供命令、不记账。

## 资源与知识

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| 资源回收 | 试运行与执行共用同一决策形状；未注册目录不被删（除非指名）；失败现场默认保留 | `reclaim plan/apply/records` | —（CLI-only） | [0021](../decisions/0021-resource-reclamation.md)、[0037](../decisions/0037-reclaim-batch-and-unregistered-directories.md) |
| worktree 重建 | 回收后从保留的 Task 分支重建 worktree，供 `task retry` 使用 | `task retry`（重建路径）；`reclaim plan/apply` 决定保留 | —（CLI-only） | [0042](../decisions/0042-rebuild-reclaimed-worktree.md) |
| Project Knowledge | 分层知识（人工 `instructions`/`skills` 从 `main` ref 读 + Runtime 数据目录里的机器生成层）；无覆盖语义、重复 id/路径 fail-closed；逐条来源与 digest 进快照 | `project knowledge validate/list/show/resolve` | —（界面无投影） | [0041](../decisions/0041-project-knowledge-layers-and-execution-binding.md) |
| Session Guidance 台账 | 一条指导的耐久记录（正文）+ append-only 尝试台账 + 每个 Execution 启动时带上它的产物事实（`launchedWith[]`）；artifact 在 `<CODEESTRA_HOME>/guidance/<project>/<task>/guidance-context.md`，**绝不写进 Task worktree**，也不与 Project Knowledge 共用文件 | `session guidance list/get` | —（CLI-only） | [0057](../decisions/0057-session-guidance-channel-and-fact-layering.md) |

## 命令面、事件与界面

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| 事件订阅 | 只读订阅 append-only 事件日志，排他 sequence 游标、可重连、显式游标失效；含 heartbeat 帧 | `events list`、`events tail` | 运行事件（同一订阅） | [0035](../decisions/0035-event-name-and-handoff-faces.md)、[0027](../decisions/0027-verification-cancelled-and-progress-events.md) |
| 设置（散文提问等待） | 散文提问等待的全局开关（`auto` / `record-only` / `off`）；读写同一命令，无需确认 | `settings prose-question-attention [mode]` | —（CLI-only；「设置」标签页只有界面效果五项） | [0043](../decisions/0043-prose-question-attention-escalation.md) |
| 界面效果设置（已暂停） | 实现源码与已有 `ui-settings.json` 保留，但当前 Runtime 不读取、不暴露 | —（`settings ui *` 已删除） | —（UI 已暂停） | [0045](../decisions/0045-global-ui-settings.md)、[0067](../decisions/0067-pause-web-ui-and-cli-focus.md) |
| 并发上限设置 | 全局并发上限也可以从设置面读与改：`settings concurrency` 与 `scheduler capacity` 是**同一事实**（同一 `runtime_capacity_settings` 行、同一条事件），改完立刻生效且零确认 | `settings concurrency get/set --limit/reset` | —（CLI-only；界面容量卡仍显示调度面的同一数字） | [0061](../decisions/0061-runtime-global-load-control.md) D01/D02 |
| Web UI（已暂停） | 实现源码静态保留；没有 HTTP/SSE 服务、公开入口、默认构建或测试 | —（`ui` / `open` 已删除） | — | [0067](../decisions/0067-pause-web-ui-and-cli-focus.md) |
| Runtime 生命周期 | 单实例、自动拉起、两阶段 stop 与 ownership 报告 | `status`、`stop [--wait <s>]`、`settings permission get` | 侧栏底部的权限模式与事件流状态指示（**界面不提供停止/重启/切权限模式**） | [0025](../decisions/0025-runtime-lifecycle-stop-and-single-instance.md)、[0064](../decisions/0064-settings-list-and-permission-as-a-setting.md) |
| 界面主题（已暂停） | 保留源码，不属于当前启用能力 | — | — | [0067](../decisions/0067-pause-web-ui-and-cli-focus.md) |
| HTTP / SSE 面（已暂停） | `http-api.ts` 源码保留但 Runtime 不实例化；不属于当前产品面 | — | — | [0067](../decisions/0067-pause-web-ui-and-cli-focus.md) |

---

## 明确的未实现与未验证

以下内容**当前不成立**，不要按「已有」使用：

1. **Service Kernel S9–S10 与 S5–S8 的其余内容**未实现：Intention Process 尚不解释/运行 Agent；原生 Process 控制与 eligibility 解耦仍是后续阶段。S8 的受管 integration 已交付（见上表），但 **Integration Process/Agent 与把 ref 发布到用户分支都没有实现**。S4 的 `PENDING_S6` 只表示持久受理。
2. **真实 provider 的并发运行**未验收：多 Task 并行的调度语义有实现与容量/槽位门禁，但真实模型的并行执行没有完成受控验收。
3. **真实模型下的暂停 / 恢复复验**未完成：ADR-0016 的暂停/恢复编排由脚本 Adapter 覆盖；真实 provider 进程的暂停/恢复与取消超时仍未复验。
   **区分**：ADR-0061 的**全局** Provider 冻结已对 **Pi** 做过真实进程测量（`docs/spikes/pi-0.84.4.md`），
   而 **Codex 与 Claude Code 的 `providerProcessSuspension` 仍是 `REQUIRES_VALIDATION`**——
   全局 `pause` 遇到它们的目标会 fail closed 到 `RECOVERY_REQUIRED`（`GLOBAL_PAUSE_UNSUPPORTED`），**不会**假装已冻结。
4. **Provider 是否真的读取 Project Knowledge 物化文件**未验证：本轮 Agent Adapter 不消费 `knowledgeSnapshotRefs`。
5. **token 级实时流**（需要新事件与存储）未实现；transcript 是**按需读取 + 轮询**，不是逐 token 推送。
6. **Codeestra 自升级 / Self Promotion 的完整切换**未实现（Phase 7）。
7. **Session Guidance 的模型侧未验证**：命令面、台账与启动交付已实现（ADR-0057），但「真实模型是否真的读了 guidance」与「真实 Pi 在**忙碌轮次**里是否接受 `steer`」都没有验收（ADR-0051 的 `steer` 实测是在空闲 session 上做的）；Codex 的 `turn/steer` 记为 `REQUIRES_VALIDATION`，Claude Code 的活会话通道为 `UNSUPPORTED`。**不要把 `DELIVERED` 读成「模型已经照做」。**
8. 文档与实现不一致的地方在 [troubleshooting.md](./troubleshooting.md) §3 里**如实列出**（现为 FOUNDATION-074/075 的校准结果 + FOUNDATION-078 的逐屏走查校准），
   未做静默改写。
