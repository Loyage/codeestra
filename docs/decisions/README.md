# 架构决策记录

本页是**索引**：每条一行结论 + 与其它 ADR 的关系（Amended / Amends / Superseded）。每条决策的**选项、理由、后果、验证要求与稳定码在各 `NNNN-*.md` 正文**；索引与正文冲突时以正文为准。修改既有决策一律新增 ADR，不重写历史。

## 已接受

- [ADR-0001](0001-runtime-safety-baseline.md)：运行修订先暂停、依赖上游进入稳定分支、独立本地 Runtime。（**Amended by ADR-0009/0011**：开发依赖进入 `dev`；FULL 下稳定提升不批准）
- [ADR-0002](0002-execution-and-promotion-policy.md)：首个 Adapter 为 Pi、协作取消与不抢占、Stable 切换等待排空。（**Amended by ADR-0011**：FULL 取消原生审批，STRICT 保留）
- [ADR-0003](0003-task-result-commit-policy.md)：成果 commit 固定差异、沿用仓库 identity、正常执行 hooks。（**Amended by ADR-0011**：FULL 单步 capture 且不拒绝敏感路径，STRICT 保留两步门禁）
- [ADR-0004](0004-minimum-usable-runtime.md)：CLI 首入口并自动启动独立 Runtime；0600/0700 socket IPC。**Amended by ADR-0011**（FULL 项目接入不确认）；生命周期与单实例语义见 ADR-0025。
- [ADR-0005](0005-task-entry-and-worktree-location.md)：Task CLI 用 Project ID、新建为 DRAFT；owned worktree 位于 Runtime 数据目录。**Amended by ADR-0009**（固定基线改为 `dev`；managed 项目的基线来源见 ADR-0060）。
- [ADR-0006](0006-task-verification-policy.md)：验证命令来自 main ref 的人工策略，在固定 commit 的隔离副本上运行。**Amended by ADR-0011/0038/0039**。
- [ADR-0007](0007-local-web-ui-entry.md)：本地 Web UI 与 CLI 复用同一 Runtime 命令面（127.0.0.1 + 内存 token + SSE）。**Amended by ADR-0008/0011**（UI 是便利层；FULL 隐藏旧确认）。
- [ADR-0008](0008-efficiency-first-service-form.md)：效率至上、CLI 是完备命令面、测试仅限命令面。**Amended by ADR-0011**（默认 FULL 零确认）。
- [ADR-0009](0009-main-dev-promotion-and-restart.md)：固定 `main`/`dev` 双分支与提升后立即重启。**Amended by ADR-0011**（FULL 不批准）、**ADR-0038/0039**（提升前必须有精确 dev SHA 的全量证据）、**ADR-0047**（提升改经 GitHub 中转；重启序列不变）。
- [ADR-0010](0010-live-agent-terminal-takeover.md)：运行中 Agent 支持原生终端完全接管；Pi 在结构化安全点做 RPC↔TUI/PTY 交接，单 writer lease，不新增确认。**Amended by ADR-0011**（FULL 下工具不确认）与 **ADR-0023**（接管与 lease 的实现契约；PTY 落地见 ADR-0026）。
- [ADR-0011](0011-default-full-permission-mode.md)：默认 `FULL` 主机级全权限，现有与未来常态确认归零；可无确认切到显式 opt-in 的 `STRICT`。
- [ADR-0012](0012-agent-configuration-scopes.md)：Agent 配置分全局默认与每项目覆盖，逐字段按 环境变量 > 项目 > 全局 > 适配器默认；仅新 Session 生效并写入 Execution。
- [ADR-0013](0013-read-only-agent-transcript-view.md)：Agent 执行过程只读视图（`session.transcript`）读 provider 自己的会话文件；不入库、不是事件、不是 attach。
- [ADR-0014](0014-agent-structured-question-channel.md)：结构化提问通道：一份问卷 = 一个 provider dialog = 一条 `QUESTION` Attention = 一次 answer Operation；非法答案报错而不降级为拒绝。
- [ADR-0015](0015-task-workbench-and-themes.md)：任务工作台重构（集中操作、待回答问题、执行过程）与跟随系统/浅色/深色主题；只调整便利前端。
- [ADR-0016](0016-task-pause-cancel-archive.md)：暂停为协作停止（`PAUSED` + 以 `--session` 复用 provider conversation 恢复）、终止为终态、归档为软删除（只写 `archived_at`）。**Amended by ADR-0058**（新增 `task purge`；`archive`/`cancel` 语义未改）。
- [ADR-0017](0017-new-task-dock.md)：新建任务改为底部常驻停靠条；每个字段都有对应 CLI 参数，`SELF` 在 CLI 以 `TASK_KIND_UNSUPPORTED` 拒绝。
- [ADR-0018](0018-task-result-integration-into-dev.md)：IntegrationBatch 第一小步：detached worktree 合并 → 独立集成验证 → `PASSED` 后才 CAS 推进 `dev`；失败保留现场。**Amended by ADR-0038**（集成验证不能替代提升前全量证据）与 **ADR-0056/0060**（`dev` 来源与基线，见各自条目）。
- [ADR-0019](0019-long-command-operations.md)：长命令成为持久 Operation（步骤级进度、`task.verify --background`、`operation.list/get/cancel`）；取消先确认进程静止，未确认则 `RECONCILE_REQUIRED`。**补齐于 ADR-0027**。
- [ADR-0021](0021-resource-reclamation.md)：`reclaim plan/apply/records` 只删注册过且归属校验通过的三类资源，默认保留失败现场，append-only 账本入 v12。**Amended by ADR-0037**（D03 退出码与跨项目批量、未注册目录）。
- [ADR-0022](0022-stable-branch-promotion.md)：`dev → main` 成为产品能力（固定 dev/main/证据三元组、只允许 ff、ref 或证据移动即 `STALE`）。**Amended by ADR-0038/0039**（全量证据）与 **ADR-0047**（改经远端中转）。
- [ADR-0023](0023-strict-permission-attention-and-session-writer-lease.md)：STRICT 工具审批转成既有 Attention（决议按 incarnation 原子拒绝过期/重放）；Session incarnation 历史 + 单 writer lease。**Amended by ADR-0026**：PTY 传输与 successor 启动已实现。
- [ADR-0024](0024-task-dependency-dag-and-blocked.md)：任务依赖一等公民（schema v15）、纯领域 DAG 环校验且不部分应用、`BLOCKED` 只表示依赖未满足。**Amended 2026-09-16 / ADR-0060**：判定所读的 ref 是该项目的 Task 基线 ref（有 dev clone=其 `dev`；managed=项目文件夹当前检出的分支），读不到按未满足阻塞。
- [ADR-0025](0025-runtime-lifecycle-stop-and-single-instance.md)：`stop` 为「请求 + 有界等待 + 事实报告」；`runtime.lock` 单实例归属 + 每次 boot 痕迹 + 只读诊断（不写不删不发信号）。
- [ADR-0026](0026-native-terminal-pty-transport.md)：原生终端 PTY 传输与 attach/detach/release；incarnation 进程树按 pid 并集刷新，无法核验一律拒绝接手。**Amended by ADR-0054**（能力表三行）。
- [ADR-0027](0027-verification-cancelled-and-progress-events.md)：verification run 的一等 `CANCELLED`（未确认静止仍写不成终态）与 `OperationProgressed`/`OperationSettled` 事件。
- [ADR-0028](0028-revision-delivery-and-stale-session-startup-reconcile.md)：修订投递只有「结构化 ACK」或「经核验的 successor Execution」才算确认；重启后 stale ACTIVE Session 一律 `RECOVERY_REQUIRED`，不写 RUNNING、不发信号。
- [ADR-0029](0029-codex-adapter-transport-and-capabilities.md)：Codex 走 `codex app-server --stdio`；STRICT 复用 provider 审批策略并映射到既有 Attention；能力矩阵按实测填写，Pi 的交接机制不套用。
- [ADR-0030](0030-phase2-parallel-scheduling.md)：Phase 2 并行调度的决策固化（全局 / 每 adapter 容量、自动 tick、`--allow-unknown` 单次放行、不加 aging）。**注意**：其中「映射缺失/不完整即 `UNKNOWN`、`UNKNOWN` 默认不并行」的判定部分已被 ADR-0059 取代；容量、自动 tick 与放行命令面语义不变。
- [ADR-0031](0031-impact-snapshot-and-deterministic-conflict-analyzer.md)：ImpactSnapshot 与确定性 Conflict Analyzer：映射来自 `.codeestra/impact.json`，「拿不到可靠信息」一律 `UNKNOWN`；快照 append-only 永不覆盖。（**Superseded by ADR-0059**：只有「判定读什么」被取代，快照构造、失效键与审计仍在用）
- [ADR-0032](0032-capacity-and-slot-reservations.md)：容量与槽位预留（schema v21）：容量是配置、预留是 schema 事实、归属证据是 bootId + pid + OS start token、无法核验则保持占用。
- [ADR-0033](0033-scheduling-engine.md)：调度引擎：事件驱动 + 周期恢复 pass、候选顺序 priority desc → createdAt asc → id asc、冲突/容量等待各有稳定码且都不是 `BLOCKED`。
- [ADR-0034](0034-compact-task-workbench.md)：紧凑任务信息行与主操作优先；列表/详情分离与主题不变。
- [ADR-0035](0035-event-name-and-handoff-faces.md)：已实现的事件名永不重命名；补七个交接/终端 domain event 与两个能力位（Pi `SUPPORTED`、Codex `UNSUPPORTED`）。
- [ADR-0036](0036-task-retry-after-failure.md)：`FAILED → READY` 的显式 `task retry`（不自动重试）；换 Agent 即新 Execution 绑另一个 Adapter；worktree 复用必须核验归属。**缺口由 ADR-0042 补齐**。
- [ADR-0037](0037-reclaim-batch-and-unregistered-directories.md)：`reclaim` 跨项目批量与未注册目录显式处置（有界扫描、默认 dry-run、点名才删、无法核验不删）；退出码 0/3/1/2。
- [ADR-0038](0038-branch-targeted-tests-and-dev-full-suite.md)：开发分支只跑建分支时选定的少量定向测试、禁止全量；全量测试只在精确 `dev` 候选上运行并作为提升必备证据。**由 ADR-0039 实现**。
- [ADR-0039](0039-layered-verification-evidence.md)：分层验证证据（schema v25）：`task tests record` 把定向计划快照成 (`task`,`revision`,`commit`,`digest`) 记录，`promotion.full-suite run` 由 Runtime 在精确 SHA 的副本上运行 main ref 策略，promotion 强制消费。
- [ADR-0040](0040-claude-code-adapter-transport-and-capabilities.md)：Claude Code 走 `--print` 双向 SDK control 协议；STRICT 复用 provider 权限模式并映射到既有 Attention（**不是逐工具审批**）。
- [ADR-0041](0041-project-knowledge-layers-and-execution-binding.md)：Project Knowledge 分层：人工层只从 main ref 读、机器生成层读写都在 Runtime 数据目录；每 Execution 绑定实际使用的快照（schema v26）。**注入方式见 ADR-0051**。
- [ADR-0042](0042-rebuild-reclaimed-worktree.md)：从 reclaim 保留的 task branch 重建 owned worktree：判据全部是事实，绝不 `--force`、绝不删/复用分支。
- [ADR-0043](0043-prose-question-attention-escalation.md)：散文提问升级为一条既有形状的 `QUESTION` Attention + `WAITING_FOR_USER`；回答不投递、不新建 Execution、不是 TaskRevision。
- [ADR-0044](0044-agent-plugin-selection-and-detection.md)：Pi 四类插件/资源可定制与只读检测（schema v27）；可核验路径 fail-closed，Codex/Claude 本轮如实 `UNSUPPORTED`。
- [ADR-0045](0045-global-ui-settings.md)：五个全局界面效果设置存入 `$CODEESTRA_HOME/ui-settings.json`（损坏即报错，不静默回退）；CLI 命令面完备，不占迁移号。
- [ADR-0046](0046-intent-kind-check-shrink.md)：`intents.kind` 缩到五个可产生取值（schema v28）；代价是 `tasks.priority` 现状恒为 0，Phase 7 需再迁移加回 `SELF_MODIFICATION`。
- [ADR-0047](0047-github-mediated-promotion.md)：`dev → main` 必须经 GitHub 中转，**拉取是用户显式的人工步骤**；只 push 固定候选、不 `--force`、不对已检出的 `main` 用 `update-ref`。**落地细则见 ADR-0052**。
- [ADR-0048](0048-dev-clone-and-separate-runtime-home.md)：`~/Documents/codeestra`（main）与 `codeestra-dev`（dev）是两个独立 clone（非 worktree）；dev 用独立 `CODEESTRA_HOME`。**范围口径见 ADR-0060**。
- [ADR-0049](0049-dev-ui-channel-marker.md)：dev 通道是构建期事实（`VITE_CODEESTRA_CHANNEL=dev`），产物带 `data-channel="dev"` + 横幅 + 橙色强调；未设置即无标记。
- [ADR-0050](0050-user-manual-and-doc-sync-discipline.md)：单份主线说明书（`docs/guides/manual.md`）+ 八篇参考；功能变更必须同步 `docs/guides/` 对应段落，人工规范、不加机器门禁。
- [ADR-0051](0051-knowledge-handoff-codex-facts-and-revision-channel-evaluation.md)：知识按 Execution 绑定交给 provider，每个 provider 用自己的通道；`applyRevision` 经实测不可行，三个 provider 一律 `UNSUPPORTED`。
- [ADR-0052](0052-promotion-fact-layering.md)：经 GitHub 中转提升的命令面事实分层：可重试拒绝 vs 记录 `STALE`、`AWAITING_PULL` 退 3 且不执行重启、推回失败可续、`DEV_REPO_*` 核验口径（schema v29）。
- [ADR-0053](0053-multi-member-integration-batch.md)：多成员 IntegrationBatch（schema v30）：组成与集成分离、成员按 `task_id` 排序、批级 `STALE`/`CANCELLED`、成员级部分失败如实。
- [ADR-0054](0054-pty-resize-parallel-safe-point-and-permission-matrix.md)：resize 属于 versioned TerminalTransport（`stty` 作用在 slave fd）；并行工具批次安全点规则不变并有真实 Pi 证据；跨交接权限矩阵仍 `PARTIAL`。**Amends ADR-0026** 能力表三行。
- [ADR-0055](0055-recovery-required-reconcile-command.md)：`task recover` 只读事实，**能证明 provider 已消失才收口**，其余一律拒绝并保持占用；`occupiers` 投影不可观测的占用者。
- [ADR-0056](0056-dev-repo-path-single-dev-fact-source.md)：`dev` 事实的唯一来源是 dev clone（读本地 `refs/heads/dev`，运行期不联网）。**Amends ADR-0018**（集成推进的唯一例外是 dev clone 自己的 `dev` 检出）。**必需性已被 ADR-0060 改为可选**。
- [ADR-0057](0057-session-guidance-channel-and-fact-layering.md)：Session Guidance 是会话级事实，不产生 TaskRevision、不使旧验证失效；「已投递」= provider 通道接收，「模型已读」不存在（schema v31）。
- [ADR-0058](0058-task-purge.md)：`task purge` 永久删除任务：全产品唯一一次显式 `--yes` 且不在任何常态路径上；append-only 只在 purge 事务内让路、触发器缺失即拒绝；成果已进 `dev`/`main` 即拒绝；`RECOVERY_REQUIRED` 任务先按观察对账（与 `task recover` 同一判定），只有证明 provider 已退出才继续删除。**2026-09-16 修订（D09）**：新增 `--force` —— 同一条命令的放宽（不是第二道确认）：先对**记录过的身份**发 `SIGTERM`/`SIGKILL` 终止 provider，再删掉它本来会拒绝的行（含 `dev`/`main` 的来源记录，必要时连同引用了该任务验证行的 `stable_promotions` 与其全部成员行）；只越过「活占」类门禁，**归属不明的资源一律留在磁盘上并逐项写进 `forced`**。
- [ADR-0059](0059-feature-declaration-conflict-rule.md)：冲突判定只看「两侧声明同一功能且对方未完成」；文件/目录/模块/共享资源重叠与映射完整性都不再影响判定（schema v32）。**Supersedes ADR-0031 的判定语义**。
- [ADR-0060](0060-managed-project-task-baseline.md)：被管理项目的 Task 基线取「项目文件夹当前检出的分支」，`dev clone` 变为可选（schema v33）。**Amends ADR-0056** 的必需性与 **ADR-0018** 的基线来源。**第三轮修订（2026-09-16，FOUNDATION-093）**：依赖判定从 dev-only 清单移出（它位于 `task submit`/`task run` 的常态路径），`DEV_REPO_REQUIRED` 只剩集成与提升。
- [ADR-0061](0061-runtime-global-load-control.md)：Runtime 全局负载控制 —— 只保留一个跨全部项目/Adapter 的并行上限（默认 2、范围 1–16，旧显式值取最小值迁移）；全局暂停 = 持久启动屏障 + 按 `pid + start token + incarnation` 可核验的 Provider 主进程冻结（不改 Task 状态、不向工具子进程发停止信号、跨重启保持，只有显式继续才解除）。**Amends ADR-0030/0032/0033 的容量层级**。**两半都已实现**（schema v34）：容量上半是 FOUNDATION-096（`runtime_capacity_settings`、全局事件 `project_id = NULL`、命令面 `scheduler capacity get|set|reset`），暂停下半是 FOUNDATION-097（`runtime_pause_control`/`runtime_pause_targets`、持久屏障、`scheduler control status|pause|resume|reconcile`、UI 全局 shell）。Provider 冻结能力按 Adapter 如实声明：Pi `SUPPORTED`，Codex / Claude Code `REQUIRES_VALIDATION`。

## 当前有效语义（与旧 ADR 冲突时按此执行）

- **权限**：ADR-0011 —— 默认 `FULL` 零确认；`STRICT` 是显式 opt-in，只恢复旧门禁；FULL 下不得新增任何确认步骤。
- **测试范围与时机**：ADR-0038/0039 —— task/lane/feature/Self candidate 分支只跑建分支时选定的定向测试；全量只在精确 `dev` 候选上、作为提升前必备证据。
- **稳定提升路径**：ADR-0047/0052 —— push 固定候选到远端 `dev` → 读回核对 → main clone `ff-only` 拉取 → 重启并核对 → 推回远端 `main`。产品命令面已实现（schema v29）；本仓库自身的提升仍走 `AGENTS.md` 的人工四步，不使用产品命令面。
- **分支职责与重启**：ADR-0009 —— `main`/`dev` 长期并存（只属 Codeestra 自身），Task 先集成进 `dev`；`main` 更新后立即 `stop` + `status`。
- **本机布局与 dev 通道**：ADR-0048/0049/0060 —— 两个独立 clone 的拆分只服务 Codeestra 自身的开发；dev 界面是否带标记由构建期变量决定。
- **用户文档纪律**：ADR-0050 —— 功能变更同步 `docs/guides/` 对应段落，交付说明写明改了哪一篇的哪一节。
- **Project Knowledge**：ADR-0041/0051 —— 每个 provider 用自己的通道注入；`applyRevision` 三者 `UNSUPPORTED`。
- **IntegrationBatch**：ADR-0053 —— 一次覆盖整批的集成验证、批级 `STALE`/`CANCELLED`、成员按 `task_id` 排序、部分失败如实。
- **终端与交接**：ADR-0054 —— PTY resize 合约（POSIX 范围）；并行工具批次安全点规则与 ADR-0010 相同；跨交接权限矩阵仍 `PARTIAL`。
- **`RECOVERY_REQUIRED` 对账**：ADR-0055 —— 只读事实、能证明 provider 已消失才收口、不声称静止、不发信号、不删资源。
- **`dev` 事实来源与 Task 基线**：ADR-0056/0060 —— 记了 dev clone 的项目取其本地 `refs/heads/dev`；没记（managed）的取项目文件夹当前检出的分支；`dev_repo_path` 可选。**只有集成与提升需要长期 `dev` 分支**；依赖判定、槽位预留、调度启动前重检、结果 commit 归属、任务级验证与回收对两类项目都成立（第三轮修订）。
- **Session Guidance**：ADR-0057 —— 会话级事实；命令面写明「已入队 ≠ 模型已读」，无通道即 `CHANNEL_UNSUPPORTED`。
- **任务永久删除**：ADR-0058 —— 唯一显式 `--yes`，不在常态路径；`cancel` 仍是终态、`archive` 仍是软删除；被拒绝时可用 `--force`（同一条命令的放宽，D09）删掉本来会被拒绝的任务，代价逐项写在 `forced` 与审计事件里。
- **冲突判定**：ADR-0059 —— 默认 `SAFE_TO_PARALLELIZE`；`--allow-unknown` 保留且永不放宽 `CONFLICTING`。
- **全局负载控制**：ADR-0061 —— 一个 Runtime 只有一个跨项目并行上限（**实现事实**：FOUNDATION-096，schema v34，命令面 `scheduler capacity get/set/reset`，项目级/Adapter 级覆写已退役）；全局暂停 = 持久启动屏障 + 可核验 Provider 主进程冻结（**实现事实**：FOUNDATION-097，同一 v34，命令面 `scheduler control status/pause/resume/reconcile`），不替 ADR-0016 的单 Task pause，也不自动跨重启恢复；`pauseState` 可能是五个控制状态之一。**能冻结哪些 Adapter** 按各自的 `providerProcessSuspension` 如实声明（当前只有 Pi 是 `SUPPORTED`）。

以上各条都**不放宽**既有不变量：失败不动 `dev`、保留失败现场、不 `--force`、CAS 推进、命令幂等、崩溃按事实收敛；也都不新增权限门禁或审批层。

## 待决项

| 阶段 | 尚需确认/验证 | 当前处理 |
|---|---|---|
| Phase 1 | Pi 真实暂停/终止与取消超时的静止性 | 暂停/终止的进程释放只被脚本 Adapter 与真实 `releaseSession` 覆盖；取消超时、禁止工具的静止性、gate 拒绝路径与孤儿进程 reconcile 仍需真实 provider 复验 |
| Phase 1 | Task verification 隔离副本的长时命令 | 副本内 argv 直接 spawn、按进程组超时与 tracked 改动失败已实现；真实命令集与长时任务未实测 |
| Phase 1 | 本地 IPC 订阅的游标与重连 | 订阅不持久化游标、无自动重连、无按 project 鉴权，客户端重连需自带 cursor |
| Phase 1 | Agent 配置的每任务/每 Revision 固定 | 全局默认 + 每项目覆盖已实现（ADR-0012）；更细粒度未确认前不自行推断 |
| Phase 2 | 真实 provider 的并发运行 | 两个 `SAFE` 任务真的同时跑、真实模型下的调度与 `--allow-unknown` 常态使用尚未验收 |
| Phase 2 | 上游被修订时依赖锁定的 revision 怎么更新 | 未明确前继续钉旧 revision 并保持 `BLOCKED`（ADR-0024），不自行跟随；自动改钉与「选择版本后激活」未实现 |
| Phase 2 | 影响分析未覆盖的语义 | 非 Git 共享资源（端口/数据库/dev server）、gitignore 产物、映射未声明路径的语义未定 |
| Phase 2 | Runtime 全局负载控制（唯一跨项目上限、全局暂停） | **两半都已实现**（schema v34）：上限是 FOUNDATION-096（`scheduler capacity get\|set\|reset`、跨项目按 Task 计数、全局事件），全局暂停是 FOUNDATION-097（`scheduler control status\|pause\|resume\|reconcile`、跨重启持久屏障、三 Adapter 进程归属 spike、UI 全局 shell）。**仍未成立的是**「所有 Adapter 都能被全局冻结」：Codex 与 Claude Code 是 `REQUIRES_VALIDATION`，真实模型下的冻结/恢复只对 Pi 测过；也未实测大输出工具的管道背压 |
| Phase 3 | revision 投递的真实 ACK | 无 Adapter 实现 `applyRevision`；真实 provider ACK 与真实模型对投递提示的理解未验收 |
| Phase 3 | 原生终端接管的真实验证 | 真实模型在 TUI 中键入后交还 RPC 的完整复验、跨交接权限模式完整矩阵（ADR-0054 仍 `PARTIAL`）、Windows 未验证 |
| Phase 4 | `main` 未检出时的提升路径、多批次合并提升 | 不自动推断，需另立决策 |
| Phase 5 | 真实模型驱动的完整 CLI 流程 | 真实模型端到端、`fileChange`/`permissions` 审批、多工具批次 interrupt、Windows 未验证 |
| Phase 7 | migration/备份兼容策略、bootstrap 自身更新授权 | 禁止自动实现不可逆升级；实现前确认 |
| 任意阶段 | Runtime 自有资源回收的并发与归因 | 并发压力测试未做；无法归因到任何已信任项目的目录只报告不入账（ADR-0037） |

Phase 0 不要求 Phase 7 所有发布细节已决定；Phase 1 不能以“未来会解决”绕过影响真实执行与 Git 安全的待决项。

## ADR 规则

命名 `NNNN-short-title.md`；包含 Status（Proposed/Accepted/Superseded）、Context、Options、Decision、Consequences、Verification 与关联文档。只有明确决定后才能标 Accepted。提案、技术假设和未验证能力必须分别标明。
