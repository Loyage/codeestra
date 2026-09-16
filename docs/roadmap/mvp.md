# MVP Roadmap

状态：**各阶段完成度已由 FOUNDATION-074（Wave K / K1 文档校准）按已合入 `dev` 的实现逐条回填**；本文件不再是「阶段草案」。
每个 Phase 下面都有一节「当前状态（截至本格）」，写明已完成、仍在做与**未验证**的部分；未验证的能力继续标为未验证，不因为
功能已实现就当成已验收。

## 排序原则（ADR-0008）

- 效率至上是最高优化目标：阶段内任务优先选择能直接减少用户等待时间与操作步数的项（例如已完成的 Task cancel、长命令后台化与进度事件、revision 投递确认，以及仍剩余的调度/提升类能力）——这份清单不是承诺，只说明排序依据。
- 安全/隔离类工作不单独占阶段排期，也不再新增门禁；已实现门禁维持在既有条款。
- 权限管理（多用户、租户、密钥托管、路径沙箱、网络策略，以及相应的沙箱/联邦）不属于当前 roadmap，不预留专项阶段。
- 每个阶段的新能力以 CLI 完备为前提：CLI 能完成并脚本化驱动后，才由 UI/桌面做便利前端（检查方式：能力是否有 versioned command 与稳定退出码）。
- 验收与自动化测试只用 CLI/命令面断言，不获取电脑控制权（不引入桌面/键鼠自动化）。

## Phase 0 — Architecture Foundation

交付：规格、AGENTS、ADR、模块边界、领域/状态机/SQLite/事件/API 设计；随后建立最小 Bun workspace、TypeScript 严格配置与 Vitest 测试入口。

按小步准入：Phase 0 纯领域函数与测试骨架可先开始（关键语义已确认，不涉及外部副作用）；storage/真实 Runtime 编码前关闭影响 Phase 1 产品行为、schema 与 Git 安全的待决项，并验证 Pi 的实际支持范围。不得把纯领域验收等同整个 Phase 0/1 已完成。

验收：全新环境可运行已声明检查；领域非法迁移测试、数据库约束测试和 fake adapter 合约测试通过。Fake 不替代真实集成验收。

### 当前状态（截至 FOUNDATION-074）

**已完成**。规格、`AGENTS.md`、44 份 ADR（`docs/decisions/`）、`docs/` 下的架构/指南/路线图/任务目录、模块边界与领域/状态机/SQLite/事件/API 设计已建立
（FOUNDATION-001）；Bun workspace、TypeScript strict、Vitest 与 `Justfile` 已建立，纯领域工程（SpecificationHistory / TaskRevision /
Execution FSM）已实现并有大面积非法迁移测试（FOUNDATION-002）。

仍在进行的是**架构文档与实现的持续同步**：第 8 节式的逐版本 migration 记录、事件目录与状态机只有在相应实现落地后才权威。
本格（FOUNDATION-074）刚做过一次全面校准；这不代表未来不会再次漂移。

## Phase 1 — Single Task Runtime

交付：一个项目、一个活动任务、意图/规格持久化、修订历史、独立 branch/worktree、一个真实 Adapter、执行记录、任务验证、失败/取消与重启状态核对。

验收：临时真实 Git 仓库中，从固定 dev commit 创建 Task 到获得固定 revision/commit 的验证结果；不修改 dev/main；重复命令不产生重复执行；保留失败现场；无法恢复真实 Agent 时诚实记录而非伪造 RUNNING。

Phase 1 不提供 Phase 3 的完整 attach UI。若 Agent 需要交互，必须显式报告，不允许无期限静默挂起或假装成功。具体最小交互入口由 Adapter 决策确定。

### 当前状态（截至 FOUNDATION-074）

**交付项已实现**：intent/规格持久化与不可变修订历史（FOUNDATION-005/007）、owned branch/worktree 且基线是 `project.devRef`
（ADR-0009/ADR-0018）、Execution/Session 生命周期与失败分类（FOUNDATION-008/009/010/013/014）、成果 commit（ADR-0003）、
Task verification（ADR-0006）、Task 暂停/取消/归档（ADR-0016/FOUNDATION-033）、失败后 `FAILED → READY`（ADR-0036/FOUNDATION-061）、
重启状态核对（ADR-0025/FOUNDATION-045、ADR-0028/FOUNDATION-048）。验收里的「临时仓库里从固定 dev commit 建 Task 到拿到
验证结果」「不修改 dev/main」「重复命令不产生重复执行」「保留失败现场」「无法恢复时诚实记录而非伪造 RUNNING」都有测试覆盖。

**未验证**：真实模型下的暂停/恢复组合（ADR-0016 的编排由脚本 Adapter 覆盖，真实 provider 未复验）；真实 provider 的取消超时。

**交付边界**：Phase 1 的「一个真实 Adapter」已扩展为三个（见 Phase 5）。

## Phase 2 — Task DAG + Scheduler + Parallel Worktrees

交付：DAG 校验、依赖满足策略、影响分析、冲突分析、资源预留和多 worktree 调度；负载控制最终形态为每个 Runtime 一个跨项目并行上限，并支持持久的全局 Provider 冻结/继续（ADR-0061）。

验收：SAFE 的独立任务并行；UNKNOWN/CONFLICTING 不并行；循环依赖拒绝；下游 dev 基线含所需上游代码。ADR-0009 要求上游先进入 dev 才满足依赖；Phase 4 前允许下游继续 BLOCKED，不提前偷做完整集成。

### 当前状态（截至 FOUNDATION-074）

**交付项已实现**：DAG 校验与 `BLOCKED` 语义（ADR-0024/FOUNDATION-044，含环校验）、影响分析与确定性 Conflict Analyzer
（ADR-0031/FOUNDATION-053，`SAFE|UNKNOWN|CONFLICTING` + 稳定 reason code）、容量原语（ADR-0032/FOUNDATION-054，reservation/release/崩溃 reconcile；
**上限自 FOUNDATION-096 起是每个 `CODEESTRA_HOME` 唯一的跨项目值**，见下）、调度引擎本体（ADR-0033/FOUNDATION-055，自动 tick、候选顺序、等待语义、
`--allow-unknown`）与其 UI 投影（FOUNDATION-059）。

**未验证（因此本 Phase 的验收矩阵尚未成立）**：验收第一项「两个 SAFE 任务真的同时跑」只在调度器/命令面与测试夹具下验证过，
**真实 provider 的并发运行没有完成受控验收**（`docs/guides/troubleshooting.md` §4 第 1 条）。调度器本身有门禁这一事实不能替代该验收。

**ADR-0061 的进度（schema v34，两半都已交付）**：容量上半是 FOUNDATION-096——每个 `CODEESTRA_HOME` 只有一个跨项目上限（默认 2，旧显式值取最小值迁移），命令面为 `scheduler capacity get|set|reset`，占用跨项目按 Task 统计。暂停下半是 FOUNDATION-097——`scheduler control status|pause|resume|reconcile`、持久启动屏障与可核验的 Provider 主进程冻结，只有 Pi 经过真实进程实测（`SUPPORTED`），Codex 与 Claude Code 仍是 `REQUIRES_VALIDATION`，遇到它们的目标会 fail closed 到 `RECOVERY_REQUIRED`（`GLOBAL_PAUSE_UNSUPPORTED`）——**这不构成「全部 Adapter 都能全局冻结」的验收**。

## Phase 3 — Interactive Agent Sessions

交付：真实 session 接入、Attention Inbox、WAITING_FOR_USER、回答路由、断连与恢复、运行中修订的通知与确认；增加 Session Guidance 与原生终端接管。Pi 按 ADR-0010 在当前工具结束后的结构化安全点执行 RPC→原生 TUI/PTY 交接，detach 后保持 TUI 运行，显式 release 再交接回 RPC；CLI 提供 request/attach/status/release 与可脚本化 guidance，UI 只投影同一命令面。

实现顺序：先以真实 Pi spike 验证 session-file 双向恢复、权限模式 side channel（FULL 零确认 / STRICT gate）和 PTY 生命周期；再实现 handoff Operation / Session incarnation / 单 writer lease；最后接 CLI attach 与 UI 终端。任一步都不得让两个 Provider 进程同时写同一 conversation/worktree。

验收：一个 Task 等待用户时其他 Task 可继续；回答不会路由到错误会话；修订投递状态可审计；工具运行中请求接管不 abort 工具，安全点后能进入真实 Pi TUI；detach/reattach 不停止 Agent；交还后 RPC 从同一 conversation 继续；Session Guidance 不改变 TaskRevision，而 `task amend` 仍使旧验证失效；writer 竞争稳定失败；故障注入不双开进程。全部通过 CLI/Runtime/PTY framing 的 headless 命令面测试完成。

### 当前状态（截至 FOUNDATION-074）

**已实现**：结构化 Attention（typed answer、`WAITING_FOR_USER`、回答路由与投递台账）、运行中修订与投递确认
（ADR-0028/FOUNDATION-048）、Session incarnation 与单 writer lease（ADR-0023/FOUNDATION-043）、handoff fence/safe point 与 PTY
原生 TUI 接管（ADR-0026/FOUNDATION-046，含 attach/detach/release/admit 与 `terminal read|write`）、只读 transcript 视图
（ADR-0013）。

**已实现（FOUNDATION-088 / ADR-0057 / schema v31）**：**Session Guidance**——`session guide`（`session.guidance.record`）
把一条指导交给运行中的会话并记录它产生的事实，`session guidance list|get` 读台账；`guide` 端口在 Pi 上实现
（RPC `steer` + provider 自己的 `queue_update`），Codex 报 `REQUIRES_VALIDATION`、Claude Code 报 `UNSUPPORTED`；
记录后每个新 Execution 启动时随启动参数交给 provider（`--append-system-prompt` / `developerInstructions`），
artifact 在 Runtime 数据目录且**不写 Task worktree**。它**不产生 TaskRevision、不动 revision、不使验证失效**，
而 `task amend` 仍然使旧验证失效。**「已投递」= provider 通道接收（入队），≠ 模型已读**（`modelAcknowledgement` 恒为 `UNSUPPORTED`）。
`event-model.md` §2.3 已把 `SessionGuidanceRecorded`/`SessionGuidanceDelivered` 从「未实现」改为已实现。

**未验证**：跨交接权限模式完整矩阵、并行工具批次的安全点、PTY resize（如实声明 `UNSUPPORTED`）、真实模型在 TUI 中键入后
交还自动化的复验；Session Guidance 的**模型侧**（真实模型是否读了 guidance、真实 Pi 在忙碌轮次里是否接受 `steer`）
与 UI 投影仍未验证。

## Phase 4 — Integration Pipeline

交付：IntegrationBatch、Task 结果集成到长期 dev、独立验证、固定 dev/main SHA 后提升 main（FULL 无需批准，STRICT 需批准）、main 更新后的 CLI stop/status 重启与响应检查，以及冲突/失败/ref 移动处理。

验收：失败候选不改变 dev/main；所有完成功能先进入 dev；提升的 commit 与被验证 dev commit 一致；dev/main 任一移动使 STRICT 批准失效；main 更新后必须重启 Runtime，恢复响应前不报告成功；批次成员 revision 可追溯。

### 当前状态（截至 FOUNDATION-074）

**已实现**：单成员 `task.integrate` + 独立集成验证（ADR-0018/FOUNDATION-038，`integration_batches`/
`integration_batch_items`/`integration_verification_runs`）、`promotion prepare/approve/promote/abandon`（ADR-0022/FOUNDATION-042，
FULL 无批准、STRICT 保留批准且 ref/证据移动产生 `STALE`）、main 更新后的 CLI stop/status 重启序列、分层验证证据与
`promotion full-suite run`（ADR-0038/ADR-0039/FOUNDATION-065，schema v25 的 `dev_full_suite_evidence` 绑定候选 commit +
main ref 的 policy digest + 该 commit 的 lockfile digest）、启动 reconcile 与崩溃恢复。

**未实现**：多成员批次、批级 `STALE`、批级 `CANCELLED`、任务集合级集成（`state-machines.md` §4 的「未实现（不得声称）」）。
`task.integrate` 每次只集成一个 Task。

**未验证**：三次真实的 `dev → main` 提升走的都是 `AGENTS.md` 规定的人工路径（在已检出的 main 工作树里 `git merge --ff-only`），
**没有任何一次产生领域 `PromotionRecord` 行**——产品 `promotion prepare` 需要 IntegrationBatch 的集成验证证据，而那些候选是
协调者手工解冲突合入 `dev` 的，没有 IntegrationBatch。第三次提升确实跑通了 `promotion full-suite run` 的产品路径（这是
ADR-0039 落地后第一次），但产品提升路径本身仍未在这些候选上成立。

## Phase 5 — Multiple Agent Adapters

交付：Pi、Codex、Claude Code 接入；能力矩阵和一致性测试；失败后新 Execution 可更换 Agent。

验收：Core 无供应商类型依赖；不支持的交互/恢复能力明确反馈。

### 当前状态（截至 FOUNDATION-074）

**已完成**：Pi（FOUNDATION-013/ADR-0026）、Codex（ADR-0029/FOUNDATION-049）、Claude Code（ADR-0040/FOUNDATION-066）三个真实
Adapter 已接入；能力矩阵按实测逐维度如实声明，`UNSUPPORTED` 不被掩饰（例如 Codex 的 `pauseWithQuiescence`/
`revisionAcknowledgement`/`attach`/`reconnectToLiveSession`/`controlledConfiguration`）；`AdapterRegistry` 按 ID 保持唯一实例，未注册
Adapter 在任何副作用前拒绝；Agent 类型不出现在 domain/storage 里。

**部分实现**：插件/资源选择能力 `pluginSelection` 只有 Pi 支持（ADR-0044/schema v27）；Codex 与 Claude 如实为 `UNSUPPORTED`。

**未验证**：真实模型是否真的使用所选 skill/theme；真实 provider 的并发与取消超时。

## Phase 6 — Project Knowledge

交付：人工与机器知识分层、加载和来源、更新审计。

验收：机器生成不能覆盖人工知识；Execution 能追溯实际使用的知识版本。

### 当前状态（截至 FOUNDATION-074）

**第一小步已完成**（ADR-0041/FOUNDATION-067，schema v26）：分层加载（人工 `instructions`/`skills` 只从项目 `main` ref 读、机器层
在 Runtime 数据目录）、无覆盖语义（重复 id/path fail-closed，任一条被拒则整层不出快照）、`knowledge_snapshots` 与
`execution_knowledge_snapshots` 两张 append-only 表把快照绑定到 Execution、`project knowledge validate/list/show/resolve` 命令面。
「机器生成不能覆盖人工知识」与「Execution 能追溯所用知识版本」这两个验收项已有结构事实与测试支撑。

**未验证**：Provider 是否真的读取 Runtime 物化的 `knowledge-context.md`——Adapter 尚不消费 `knowledgeSnapshotRefs`。

## Phase 7 — Self Evolution

交付：Self Task、Candidate、自托管测试、PROMOTABLE、用户 Promotion、独立 bootstrap 和恢复演练。

验收：Stable 不被开发过程覆盖；失败 Candidate 不污染 Stable 数据；切换与回滚经过兼容性检查；bootstrap 在 Runtime 无法启动时仍可使用。

### 当前状态（截至 FOUNDATION-074）

**未开始**。`state-machines.md` §5 的 Candidate/Promotion 状态机仍是设计合约；`event-model.md` §2.3 把
`CandidateBuilt`/`SelfTestCompleted`/`StablePromoted`/`StableRollbackCompleted` 登记为「未实现」。`AGENTS.md` 已规定 Self Task
的操作边界（独立 worktree、不覆盖 Stable、不绕过 bootstrap 恢复边界），但没有任何 Self Task / Candidate / bootstrap 能力落地。
不可逆 migration 与 bootstrap 自身更新的策略仍是本 Phase 的阻塞决策。

## 非目标

本轮不做完整产品 UI、全部阶段实现、云端调度、多租户、远端控制、分布式基础设施、自动无审批自我升级、**权限管理（RBAC/密钥托管/沙箱）**，也不做桌面/键鼠自动化测试。产品发布版本、工期和发布承诺在首个真实 Adapter 技术验证前不预估；工程 package 的 0.0.0 仅为未发布占位。
