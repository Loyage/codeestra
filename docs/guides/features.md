# 功能清单：「这软件能做什么」

> **适用版本** `dev@036cf68`（2026-09-15） · **schema** v28 · **最后校对** 2026-09-15
> 版本会前进：`dev@036cf68` 只是本目录最后一次校对的基线；当前适用版本以
> [docs/tasks/README.md](../tasks/README.md) 的最新 FOUNDATION 记录为准。

一行一个能力。列的含义：

- **能做什么**：这个能力对用户交付什么。
- **CLI 入口**：完整命令路径（命令参考见 [cli-reference.md](./cli-reference.md)）。
- **UI 位置**：在 Web UI 的哪里（面板名见 [ui.md](./ui.md)）。标「—」表示当前**只有 CLI** 入口。
- **ADR**：相关的已接受决策记录。

> 这份清单只写**当前实现真实具备**的能力。未实现 / 未验证的部分见文末「明确的未实现与未验证」。

---

## 接入与项目

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| 项目识别 | 读仓库身份：工作树根、`main` ref、对象格式、HEAD、`dev` ref/commit | `project inspect [path]` | 项目 → 添加本地项目（路径输入后） | — |
| 验证策略展示 | 打印 `main` ref 上 `.codeestra/policies/verification.json` 的状态、digest 与逐条命令 | `project policy [path]` | 项目 → 验证策略 | [0006](../decisions/0006-task-verification-policy.md) |
| 项目接入（trust） | 注册项目；把「你刚看到的身份 + 验证策略 digest + 影响映射 digest」一起确认；FULL 零确认 / STRICT 输 `TRUST` | `project trust [path] [--yes]` | 项目 → 添加/信任此项目 | [0011](../decisions/0011-default-full-permission-mode.md)、[0031](../decisions/0031-impact-snapshot-and-deterministic-conflict-analyzer.md) |
| 一条命令接入并打开 | inspect → 策略展示 → 必要时确认 → 打开界面并预选该项目 | `open [path] [--yes] [--no-open]` | —（它就是打开 UI 的那条路） | [0007](../decisions/0007-local-web-ui-entry.md)、[0008](../decisions/0008-efficiency-first-service-form.md) |
| 项目列表 | 列出已信任项目及其确认策略 | `project list` | 顶部项目选择器 | — |
| 影响映射校验 | 报告 `main` ref 上的 `.codeestra/impact.json` 是否存在且是已确认的那一份 | `project impact validate [path] [--json]` | **调度 → 影响映射 · impact.json** | [0031](../decisions/0031-impact-snapshot-and-deterministic-conflict-analyzer.md) |

## 任务

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| 创建任务 | 原子保存原始意图、首 revision、事实事件与幂等回执 | `task create <project> <spec> [--constraint <t>]… [--kind DEVELOPMENT]` | 新建任务停靠条 | — |
| 列出任务 | 列出任务（默认隐藏归档，`--all` 含归档） | `task list <project> [--all]` | 任务工作台列表（含搜索/筛选/排序） | [0034](../decisions/0034-compact-task-workbench.md) |
| 提交任务 | 用 expected version 把 `DRAFT` 转 `READY`，并在同一命令里核对依赖 + 跑一次调度 pass | `task submit <project> <task> <expected-version>` | 任务详情 → 提交 | — |
| 运行任务 | 显式请求启动；同自动调度同一门禁（依赖/冲突/容量） | `task run <project> <task> <expected-version> [--adapter <id>] [--allow-unknown] [--json]` | 任务详情 → 启动 Agent | [0030](../decisions/0030-phase2-parallel-scheduling.md) |
| 暂停 / 恢复 | 暂停是协作停止（确认 provider 退出后才 `PAUSED`）；恢复以 provider conversation resume 继续 | `task pause`、`task resume <…> [--adapter <id>] [--allow-unknown]` | 任务详情 → 暂停 / 继续 | [0016](../decisions/0016-task-pause-cancel-archive.md) |
| 重试失败任务 | 只对 `FAILED` 生效；重新入队（可能需要先重建 worktree）后，用同一个门禁请求一次启动 | `task retry <project> <task> <expected-version> [--adapter <id>] [--json]` | 任务详情 →「更多操作」→ `重试`（显示 CAS 版本与将使用的 Adapter，可换成已注册的 Adapter；被拒绝时显示 Runtime 的稳定码，「等待」与「已启动」分开显示） | [0036](../decisions/0036-task-retry-after-failure.md)、[0042](../decisions/0042-rebuild-reclaimed-worktree.md) |
| 取消 / 归档 | 取消是终态（不自动重开）；归档是软删除（只写 `archived_at`，不删行、不回收） | `task cancel`、`task archive`、`task unarchive` | 任务详情 →「更多操作」 | [0016](../decisions/0016-task-pause-cancel-archive.md) |
| 状态投影 | 列出 Execution / Session / 验证 / 集成投影，附 Agent 完成注记与散文提问等待 | `task status <project> <task> [--json]` | 任务详情（执行/验证/集成记录） | [0013](../decisions/0013-read-only-agent-transcript-view.md) |
| 规格修订 | 创建新 revision（可只改理由、只加约束）并列出历史 | `task revision create`、`task revision list` | —（界面无入口） | [0028](../decisions/0028-revision-delivery-and-stale-session-startup-reconcile.md) |
| Revision 投递台账 | 单独读取与解决「修订是否真的到达运行中的 Execution」 | `task revision delivery list/get/resolve` | —（界面无投影） | [0028](../decisions/0028-revision-delivery-and-stale-session-startup-reconcile.md) |
| 优先级（**当前无命令面**） | 优先级是 Task 模型与调度排序的一部分（降序优先），但**没有任何 CLI 命令可以改它**：`task create` 不接受 priority 参数，新建 Task 的 priority 为 0 | —（无入口） | 任务工作台排序 | [0030](../decisions/0030-phase2-parallel-scheduling.md) |

## Agent 执行、会话与终端

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| Agent 会话可见 | 读 provider 自己的持久会话文件：工具调用/返回、助手文本、thinking、token 与成本；默认截断，可取回整块 | `task transcript`、`session transcript`、`session transcript part` | 任务详情 → Agent 会话与执行过程 | [0013](../decisions/0013-read-only-agent-transcript-view.md) |
| 原生终端接管 | 单一 writer lease + 安全点 + 准入决策：attach 读投影终端流、detach 保持运行、release 写释放字节并验证 provider 已退出且会话文件仍在 | `session handoff status/request/cancel`、`writer acquire/release`、`admit/attach/detach/release`、`terminal read/write` | 任务详情 → 原生终端与会话交接 | [0010](../decisions/0010-live-agent-terminal-takeover.md)、[0023](../decisions/0023-strict-permission-attention-and-session-writer-lease.md)、[0026](../decisions/0026-native-terminal-pty-transport.md) |
| 结构化提问 | Agent 用 `ask_user_question` 一次提 1–4 题（每题 2–4 个可选项、可多选、可用自己的话答）；一份问卷 = 一条 Attention = 一次 answer | `attention list`、`attention answer … --choose/--text/--cancel` | 待处理（单选/多选 + 自由文本） | [0014](../decisions/0014-agent-structured-question-channel.md) |
| 散文提问等待 | 识别「没用工具、正文提问并结束轮次」，记成一条独立 Attention 与 `WAITING_FOR_USER`，并给出明确退出方式 | `attention resolve … --answer/--dismiss`、`settings prose-question-attention` | —（CLI-only） | [0043](../decisions/0043-prose-question-attention-escalation.md) |
| 权限模式 | 默认 FULL 零确认；可无确认切 STRICT 恢复旧门禁（工具逐次审批、两步成果 commit、提升批准） | `permission get`、`permission set <full\|strict>` | 界面显示当前模式；STRICT 下出现 TRUST 输入与二次确认 | [0011](../decisions/0011-default-full-permission-mode.md)、[0023](../decisions/0023-strict-permission-attention-and-session-writer-lease.md) |
| Agent 配置 | 持久化 provider/model/thinking，分全局默认与每项目覆盖；逐字段按 `环境变量 > 项目 > 全局 > Adapter 默认` 解析；只影响新 Session | `agent config get/set/clear [--project <id>] [--adapter <id>] [--provider/--model/--thinking/--unset]` | Agent 设置标签页（`当前生效值` 表与 `编辑并保存`） | [0012](../decisions/0012-agent-configuration-scopes.md) |
| Agent 插件选择 | 选 Pi 的四类资源（extensions / skills / prompt templates / themes）；选择是**一个整体字段**（项目整份替换全局，不逐项合并）；生效值连同来源层与第三方扩展风险写进 Execution | `agent plugins list`、`agent plugins select [--extension/--skill/--prompt-template/--theme <path>]… [--clear]` | Agent 设置标签页（`插件候选` 与 `清除选择`） | [0044](../decisions/0044-agent-plugin-selection-and-detection.md) |
| 多 Adapter | 注册 `pi`（默认）、`codex`、`claude`；每次运行绑定一个 Agent，换 Adapter 是新建 Execution | `task run/resume/retry --adapter <id>` | 任务详情 → 启动 Agent / 继续（`Agent` 下拉框，在 `READY` 与 `PAUSED` 时出现）；重试入口另有自己的 Adapter 下拉框，默认「沿用该任务上一次运行的 Adapter」，选项来自 `runtime.ping` 的已注册列表 | [0029](../decisions/0029-codex-adapter-transport-and-capabilities.md)、[0040](../decisions/0040-claude-code-adapter-transport-and-capabilities.md) |

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
| UNKNOWN 显式放行 | 对**未证明**的重叠做单次、绑定 revision/基线/分析器版本的放行；写入审计，不改变已记录判定 | `task run --allow-unknown`、`task schedule clear-unknown` | 调度 → UNKNOWN 的显式单次放行 | [0030](../decisions/0030-phase2-parallel-scheduling.md) D05 |
| 容量与上限 | 项目级并发上限（默认 2，上限 16）+ 每 Adapter 覆盖；读回存储值，非法值有自己的稳定码 | `scheduler capacity get/set/clear` | 调度 → 容量与槽位预留 | [0032](../decisions/0032-capacity-and-slot-reservations.md) |
| 槽位预留 | 在**一个 immediate 事务**里复核 Task 版本、已评估 revision、依赖事实、ImpactSnapshot 代数与两个容量维度后记录预留 | `scheduler reservations list/acquire/release/prepare-workspace/reconcile` | 调度 → 槽位预留 | [0032](../decisions/0032-capacity-and-slot-reservations.md) |
| 预留对账 | 复核每个活跃预留的持有者进程是否真的还在：确认消失则释放并记录；活着的/无法核验的保留槽位 | `scheduler reservations reconcile` | 调度 → reconcile 观测 | [0032](../decisions/0032-capacity-and-slot-reservations.md) |
| 影响分析与冲突判定 | 确定性地把 change set 映射到 `.codeestra/impact.json`，与所有持有资源的 Task 比较，得出 `SAFE_TO_PARALLELIZE / UNKNOWN / CONFLICTING` 及交叉路径 | `project impact validate/show/explain` | **调度 → 影响映射 · impact.json**；任务详情 → 影响与冲突判定 | [0031](../decisions/0031-impact-snapshot-and-deterministic-conflict-analyzer.md) |
| 任务依赖 DAG | 增删查依赖；加环拒绝且不部分应用；上游必须进 `dev` 才满足 | `task depends add/remove/list` | 任务详情 → 依赖与 BLOCKED 原因 | [0024](../decisions/0024-task-dependency-dag-and-blocked.md) |

## 成果、验证与集成

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| 成果提交 | FULL 单步 capture；STRICT 两步 prepare + commit `--confirm`。固定 HEAD/ChangeSet/revision，沿用仓库 identity，正常跑 hooks，失败保留现场 | `task result capture`、`task result prepare`、`task result commit … --confirm` | 任务详情 → 提交成果 / 成果提交授权 | [0003](../decisions/0003-task-result-commit-policy.md)、[0011](../decisions/0011-default-full-permission-mode.md) |
| 任务验证 | 用 `main` ref 上人工维护的策略，在固定 commit 的 detached 副本里运行；证据不含原始输出 | `task verify [execution-id] [--policy auto\|targeted\|project] [--background]` | 任务详情 → 验证任务 | [0006](../decisions/0006-task-verification-policy.md)、[0008](../decisions/0008-efficiency-first-service-form.md) |
| 分层测试证据 | 分支把定向范围写进 `.codeestra/tests.json`；`record` 把它快照成绑定 `(task, revision, commit, digest)` 的 append-only 记录；`verify` 只消费已记录的计划 | `task tests record/show/history` | —（界面只显示验证结果与证据，无计划/来源面板） | [0038](../decisions/0038-branch-targeted-tests-and-dev-full-suite.md)、[0039](../decisions/0039-layered-verification-evidence.md) |
| 集成批次 | 在 detached integration worktree 合并（能 ff 就 ff，否则 `--no-ff`）→ 独立集成验证 → PASSED 后 CAS 推进 `dev` | `task integrate`、`task integration list` | 任务详情 → 集成记录 · dev | [0018](../decisions/0018-task-result-integration-into-dev.md) |

## 稳定提升

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| dev 全量测试证据 | 在精确 dev SHA 的 detached 副本上运行项目固定策略，**Runtime 观察结果**，客户端不能自报；证据绑定 SHA/策略 digest/锁文件 digest | `promotion full-suite run --dev-commit <full-sha>`、`promotion full-suite list` | —（界面无入口） | [0038](../decisions/0038-branch-targeted-tests-and-dev-full-suite.md)、[0039](../decisions/0039-layered-verification-evidence.md) |
| 提升 prepare/approve/promote | `prepare` 固定三元组与 dev clone（不写 Git）；`promote` 一次只推进一步：push 固定候选到远端 `dev` → 读回核对 → **已推送、等待拉取**（`phase: AWAITING_PULL`，退出码 3，不记录任何重启）→ 你在 main 检出 ff-only 拉取后再次调用 → 记录并执行 install/build/stop/status → 重启核对成功后推回远端 `main` | `promotion prepare/approve/promote/abandon/get/list` | 任务详情 → 稳定提升记录（**只读投影**，界面不推送、不拉取、不重启） | [0009](../decisions/0009-main-dev-promotion-and-restart.md)、[0022](../decisions/0022-stable-branch-promotion.md)、[0047](../decisions/0047-github-mediated-stable-promotion.md)、[0052](../decisions/0052-promotion-fact-layering.md) |
| 「已推送 ≠ 已提升」投影 | 展示派生 `phase`、读回的 `origin/dev`/`origin/main` SHA 与「下一步」：`AWAITING_PULL` 时给出你必须在 main 检出执行的两条命令，且不把任何东西显示成已提升 | `promotion get/list --json` 的 `phase`/`remoteDevCommit`/`remoteMainCommit` | 任务详情与「项目」标签页 → `稳定提升记录 · dev → main`（**只读**） | [0047](../decisions/0047-github-mediated-stable-promotion.md)、[0052](../decisions/0052-promotion-fact-layering.md) |

## 资源与知识

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| 资源回收 | 试运行与执行共用同一决策形状；未注册目录不被删（除非指名）；失败现场默认保留 | `reclaim plan/apply/records` | —（CLI-only） | [0021](../decisions/0021-resource-reclamation.md)、[0037](../decisions/0037-reclaim-batch-and-unregistered-directories.md) |
| worktree 重建 | 回收后从保留的 Task 分支重建 worktree，供 `task retry` 使用 | `task retry`（重建路径）；`reclaim plan/apply` 决定保留 | —（CLI-only） | [0042](../decisions/0042-rebuild-reclaimed-worktree.md) |
| Project Knowledge | 分层知识（人工 `instructions`/`skills` 从 `main` ref 读 + Runtime 数据目录里的机器生成层）；无覆盖语义、重复 id/路径 fail-closed；逐条来源与 digest 进快照 | `project knowledge validate/list/show/resolve` | —（界面无投影） | [0041](../decisions/0041-project-knowledge-layers-and-execution-binding.md) |

## 命令面、事件与界面

| 能力 | 能做什么 | CLI 入口 | UI 位置 | ADR |
|---|---|---|---|---|
| 事件订阅 | 只读订阅 append-only 事件日志，排他 sequence 游标、可重连、显式游标失效；含 heartbeat 帧 | `events list`、`events tail` | 运行事件（同一订阅） | [0035](../decisions/0035-event-name-and-handoff-faces.md)、[0027](../decisions/0027-verification-cancelled-and-progress-events.md) |
| 设置（散文提问等待） | 散文提问等待的全局开关（`auto` / `record-only` / `off`）；读写同一命令，无需确认 | `settings prose-question-attention [mode]` | —（CLI-only；「设置」标签页只有界面效果五项） | [0043](../decisions/0043-prose-question-attention-escalation.md) |
| 界面效果设置 | 五个键（`theme`/`density`/`fontSize`/`motion`/`timeDisplay`）存在 Runtime home 的 `ui-settings.json`，CLI 与界面读写同一份值；换浏览器、清缓存、重启 Runtime 后仍生效 | `settings ui list/get/set/reset` | 设置标签页（`界面效果`）+ 侧栏底部「外观」下拉框 | [0045](../decisions/0045-global-ui-settings.md) |
| Web UI | 本地 `127.0.0.1` HTTP + SSE，一次性内存 token，只走 `/api/command` 与 `/api/events` | `ui [--no-open]` | 全部界面 | [0007](../decisions/0007-local-web-ui-entry.md)、[0015](../decisions/0015-task-workbench-and-themes.md)、[0017](../decisions/0017-new-task-dock.md)、[0034](../decisions/0034-compact-task-workbench.md) |
| Runtime 生命周期 | 单实例、自动拉起、两阶段 stop 与 ownership 报告 | `status`、`stop [--wait <s>]`、`permission get` | 侧栏底部的权限模式与事件流状态指示（**界面不提供停止/重启/切权限模式**） | [0025](../decisions/0025-runtime-lifecycle-stop-and-single-instance.md) |
| 界面主题 | 亮/暗主题切换（不改任何业务语义；ADR-0045 后由 Runtime 持久化） | `settings ui set theme system\|light\|dark` | 侧栏底部「外观」下拉框（登录前的令牌表单里还有一个只预览、不写入的） | [0015](../decisions/0015-task-workbench-and-themes.md)、[0045](../decisions/0045-global-ui-settings.md) |
| HTTP / SSE 面 | 与 socket 传输**同一 Zod 请求 schema**；`events.subscribe` 与 `runtime.ui` 在 HTTP 上被拒（`NOT_AVAILABLE_OVER_HTTP`） | `POST /api/command`、`GET /api/events` | 界面内部使用 | [0007](../decisions/0007-local-web-ui-entry.md)、[0008](../decisions/0008-efficiency-first-service-form.md) |

---

## 明确的未实现与未验证

以下内容**当前不成立**，不要按「已有」使用：

1. **真实 provider 的并发运行**未验收：多 Task 并行的调度语义有实现与容量/槽位门禁，但真实模型的并行执行没有完成受控验收。
2. **真实模型下的暂停 / 恢复复验**未完成：ADR-0016 的暂停/恢复编排由脚本 Adapter 覆盖；真实 provider 进程的暂停/恢复与取消超时仍未复验。
3. **Provider 是否真的读取 Project Knowledge 物化文件**未验证：本轮 Agent Adapter 不消费 `knowledgeSnapshotRefs`。
4. **token 级实时流**（需要新事件与存储）未实现；transcript 是**按需读取 + 轮询**，不是逐 token 推送。
5. **Codeestra 自升级 / Self Promotion 的完整切换**未实现（Phase 7）。
6. 文档与实现不一致的地方在 [troubleshooting.md](./troubleshooting.md) §3 里**如实列出**（现为 FOUNDATION-074/075 的校准结果 + FOUNDATION-078 的逐屏走查校准），
   未做静默改写。
