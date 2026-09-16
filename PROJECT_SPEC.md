# Codeestra — 产品与架构规格

状态：架构设计基线；关键决策持续以 ADR 确认。**三条第一原则（默认 FULL 零确认、CLI 完备的服务形态、测试仅限 CLI/命令面且不获取电脑控制权）见 §1.1，优先级最高（ADR-0008/0011）。** Phase 0 第一批与 Phase 1 骨架已实现，并已纵向贯通到 §3 描述的完整流水线（Task → 成果 commit → Task verification → IntegrationBatch → `dev` → `dev → main` 提升与提升后重启）。以下能力**已实现**：Task create/list/submit、owned worktree/恢复、Execution 预留、Agent start、Adapter event 去重投影与 durable outbox、Pi RPC framing/gate 子集、Runtime adapter registry、`task.run` 运行循环、事件 pump、typed answer 自动投递、Runtime shutdown 释放与 `task status`；成果 commit 的 FULL 单步 capture / STRICT 两步确认（ChangeSet + hooks + 崩溃 reconcile）；Task verification（main ref 人工维护策略 + FULL 零确认 / STRICT trust 确认 + 固定 commit 的 detached 副本 + 非敏感证据）；事件日志的只读长连接订阅（`events.subscribe`/`events.list` 与排他 sequence 游标、显式游标失效），仍限于观察；本地 Web UI 入口（ADR-0007：`codeestra ui`、127.0.0.1 + 内存 token + SSE、React/Vite 资产由 Runtime 托管）；ADR-0016 的 Task 暂停/恢复、终止与归档（CLI + 同一命令面 + UI 投影：暂停为协作停止并以 `--session` 复用 provider conversation 恢复，终止为终态，归档为不删除审计的软删除）；**ADR-0058 的 `task purge`（任务永久删除：全产品唯一一次显式 `--yes` 且不在任何常态路径上，非终态先走协作停止、无法确认 provider 已停止则拒绝，append-only 任务子表只在 purge 事务内让路且触发器缺失即拒绝，外键仍被检查，worktree/验证副本/分支经归属校验后回收（分支删除为 `update-ref -d` 比较交换并记录 tip），成果已进 `dev`/`main` 的任务一律拒绝，幂等由 command receipt 承担，同事务写入 `TaskPurged` 事件）**；ADR-0018 的 IntegrationBatch 第一小步（`task.integrate`/`task.integration.list`：成果 commit 在 Runtime 数据目录的 detached integration worktree 中合并，能 ff 就 ff，否则 `--no-ff`，先跑独立集成验证，PASSED 后才以 CAS 推进 `dev` 并使 Task 到 `SUCCEEDED`；任何失败保留现场且不推进 `dev`，`dev` 被检出时拒绝；同时把 Task worktree 基线固定为 `dev`，即 `projects.dev_ref`，仓库无 `dev` 时 trust 拒绝）；ADR-0022 的 `dev → main` 提升与提升后立即重启（固定「被验证的 dev commit + 预期 main old OID + 集成/全量证据」三元组，只允许 fast-forward；提升后由 CLI 在 main 检出执行 `stop` 再 `status` 重启并记账 Runtime 是否恢复）——该路径**在该实现下已真实执行三次**；ADR-0047 已把稳定提升改为经 GitHub 中转（显式 push 固定候选到远端 `dev` 并读回核对 → main 检出 fast-forward-only 拉取 → 重启并核对 Runtime → 才推回远端 `main`），**产品命令面已实现（FOUNDATION-077，schema v29：`projects.dev_repo_path`、`project trust --dev-repo` 的显式核验、`promotion promote` 的 push + 读回核对 + 「已推送、等待拉取」（退出码 3）+ 收口 + 推回 `origin/main`）；旧的本机 ff 实现（`fastForwardCheckedOutWorktree`）已删除，不存在双路径**；ADR-0019/0027 的长命令 Operation（`operation_progress` 步骤级进度、`task.verify --background`、`task.operation.list/get/cancel`、`OperationProgressed`/`OperationSettled` 事件，取消确认进程静止后才落终态，未确认则 `RECONCILE_REQUIRED`）；ADR-0030/0031/0032/0033 的 Phase 2 调度引擎与并行调度（容量是全局上限 + 每 adapter 上限的配置、槽位预留与归属核验、以 `.codeestra/impact.json` 为声明来源的确定性 Conflict Analyzer 与 append-only ImpactSnapshot、事件驱动自动 tick 与周期恢复 pass、候选顺序 priority desc → createdAt asc → id asc、`--allow-unknown` 单次放行、冲突/容量等待各有稳定码且都不是 `BLOCKED`）；ADR-0041 的 Project Knowledge 第一小步（人工层 `instructions`/`skills` 与机器生成层分置，人工层只从 main ref 读，每 Execution 绑定其实际使用的知识快照，schema v26）；ADR-0029/0040 接入 Codex 与 Claude Code 两个真实 Adapter，能力按实测如实声明（Claude Code 的模型层全部 `REQUIRES_VALIDATION`）。`task.run`/`task.verify` 仍是同步命令，但仍可用 `--background` 与 `task operation *` 脱离连接，长命令进度不再只能靠等待。Pi 0.84.4 首轮 spike 与最小可用形态策略已确认；真实模型与工具执行已完成首轮受控验收（deepseek-flash：真实 `write` 工具调用、fail-closed gate 审批、成果 commit 与 Task verification PASSED，证据见 FOUNDATION-019）。以下仍**未验收或未实现**，不得按「已有」使用：真实 provider 的并发运行（两个 `SAFE` 任务真的同时跑）、真实 provider 的 revision 投递 ACK（无 Adapter 实现 `applyRevision`）、真实模型下的暂停/恢复复验、取消超时与 gate 拒绝路径的真实复验（首轮验收只走了 Allow、单任务）、多成员 IntegrationBatch 与批级 `STALE`/`CANCELLED`（因此三次真实提升走的是 AGENTS.md 的人工路径，未产生 `PromotionRecord`）、Provider 是否真的读取 Project Knowledge 物化文件、Session Guidance、Phase 7 Self Evolution、Tauri 与多用户/分布式能力。`codeestra open` 与 UI 预选已在 CLI/命令面验证，但未用浏览器自动化验证（ADR-0008 测试边界）。

## 1. 定位与目标

Codeestra 是 Task-first、local-first 的 AI Development Runtime。用户管理产品意图，Codeestra 管理软件工程。它不是以聊天、终端或 Agent 为中心的助手，也不是简单的多 Agent UI。

用户可持续输入开发意图，系统把输入归类为 `CREATE_TASK`、`AMEND_TASK`、`ADD_CONSTRAINT`、`CANCEL_TASK` 或 `ANSWER_AGENT`，并保留原始输入、分类结果、关联任务和审计记录。`CHANGE_PRIORITY` 与 `SELF_MODIFICATION` 是已声明但**当前不可产生**的取值：没有任何命令写它们，`intents.kind` 的 CHECK 自 schema v28 起（ADR-0046）不再接受；`SELF_MODIFICATION` 计划在 Phase 7 重新加入，届时要再做一次迁移。目标任务不明确时不能静默修改任务，应请求澄清。

主流水线：

```text
User Intent → Task / Task DAG → Dependency Analysis → Conflict Analysis
→ Scheduler → Git Worktree（基于 dev）→ Coding Agent → Task Verification
→ Dev Integration → Integration Verification → Dev
→ 用户批准固定 dev/main SHA → Main → 立即重启 Runtime
```

### 1.1 第一原则（其他条款从属于此）

以下三条是用户确认的最高原则（ADR-0008），本文件其余条款、ADR 与实现选择都在其下解释：

1. **效率至上。** 用户从意图到可用结果的等待时间与操作步数优先于其他考虑。Runtime 默认使用 `FULL` 全权限模式：Agent、验证命令与 Git hooks 以当前系统用户的主机级权限运行，已注册工具（包括未知名称）不确认、不做路径或网络限制；项目接入、成果 commit、验证策略变化以及未来 dev→main / Self Promotion 的常态确认成本均为 **0 步、0 等待**。用户可通过 CLI 无确认切换到 `STRICT` 兼容模式以恢复旧门禁。revision/ref/ownership/process identity、静止证据、幂等与崩溃恢复等正确性核对继续有效，但不得伪装成权限审批（ADR-0011）。
2. **软件本体是服务，CLI 是完备命令面。** 独立本地 Runtime 是软件本体，拥有完备的 CLI 交互能力：每个能力都必须能只靠 CLI 完成，并可脚本化驱动（机器可读输出、稳定退出码）。Web UI 与未来桌面只是方便交互的前端，走同一 versioned command/query/event 面与同一确认门禁，不新增业务语义、不绕过门禁、不直接访问 SQLite。出现“只有 UI 能做、CLI 不能做”的能力视为缺陷而非设计选择。
3. **自动化测试仅限 CLI/命令面，不获取电脑控制权。** 项目内测试与验收的驱动方式仅限 CLI 命令与 Runtime 命令面（含承载它的 HTTP/SSE 传输）；禁止 computer-use、OS 级键鼠/窗口自动化、桌面应用操作与真实桌面会话，开发 Agent 不得为验证而取得用户电脑控制权。产品内 Agent 同样不新增屏幕读取、桌面操作或键鼠控制类工具。

## 2. 核心不变量

1. Task 是业务主实体。Execution 是一次执行尝试，每次只绑定一个主 Agent。更换主 Agent 建立新的 Execution。
2. Task 持有当前 specification、不可覆盖的 revision history、constraints、priority、dependencies、predicted impact、conflict state、execution history、branch/worktree、validation/integration state。
3. Minimum Useful Decomposition：仅当拆分明显改善并行性、依赖管理、风险隔离、上下文规模、独立验证或合并边界时才拆分。2～8 个任务是常见范围，不是约束。
4. 依赖图必须是 DAG；新增或修改依赖时检测环，失败则不部分应用。
5. 开始执行必须同时满足依赖条件、并发安全和 Agent 资源可用。功能 Task/worktree 从固定 `dev` commit 建立基线；依赖上游必须通过集成验证并进入 `dev`，下游 `dev` 基线必须包含所需上游结果。仅 Task verification 成功不释放依赖；进入 `dev` 也不等于已提升到稳定 `main`。
6. Conflict assessment 为 `SAFE_TO_PARALLELIZE | UNKNOWN | CONFLICTING`。只有 SAFE 允许直接并发；未知不等于无冲突。UNKNOWN 默认等待（不启动、不并行）；用户可用显式单次放行命令（`--allow-unknown`）在承担风险的前提下启动该 Task，**允许其与当前活跃任务并发**；放行必须绑定 revision 与评估版本、写入审计，且默认路径不增加任何确认步骤。
7. 每个运行中 Task 独占 branch 和 worktree；不允许多个 Task 操作同一工作目录。branch 使用内部稳定 ID；owned worktree 位于 Runtime 数据目录 `worktrees/<project-id>/<task-id>/`，不得污染用户主工作区。
8. Core 只依赖 Agent Adapter 合约，不能依赖某个 Agent 的命令行参数、SDK 类型或输出格式。
9. AgentSession 是有身份、生命周期和恢复信息的运行实体，不是一次命令调用。用户可从 Task 入口请求接管运行中的真实 Agent；Pi 采用安全点 RPC→原生 TUI/PTY 进程交接，而不是把日志浏览伪装成 attach。一个 Execution 可保留有序 Session process incarnation，但任意时刻最多一个 Provider writer；旧进程未确认退出不得启动 successor（ADR-0010）。
10. `WAITING_FOR_USER` 仅暂停对应 Task，其他合格任务继续执行。`BLOCKED` 专指依赖条件未满足；冲突等待、容量等待和故障不能都归为 BLOCKED。
11. 运行中的 Task 可以修订；追加约束必须生成 TaskRevision，请求暂停 Agent，并记录暂停、投递和应用确认。确认新约束后才恢复；无法可靠暂停或确认时保留现场并重新执行。旧 revision 的验证不能作为新 revision 的交付证据。
12. Task 验证与 Integration 验证是不同实体/记录，不能互相替代。项目必须长期保留 `main` 与 `dev`：`main` 是日常实际运行和开发辅助的稳定分支，`dev` 是新功能实验与集成分支。Task branch 不得绕过 integration pipeline，任何完成功能必须先进入 `dev`。`dev → main` 固定 dev SHA、预期 main SHA 与验证证据；FULL 下无需批准，STRICT 下保留旧批准语义。提升必须经远端 `dev` 中转（ADR-0047）：显式 push 固定候选到远端 `dev` 并读回核对，main 检出以 fast-forward-only 拉取该候选，重启核对成功后才推回远端 `main`；除该固定候选外不 push 任何 ref、不覆盖用户改动。（远端中转的产品命令面实现待落；落地前本仓库自身的提升按 `AGENTS.md` 的人工四步执行，不得使用旧的本地 `git merge --ff-only` 路径。）`main` 更新后必须立即在 main 检出执行 CLI `stop` 再执行 `status` 重新拉起并检查 Runtime；重启成功前不得报告提升完成。
13. Runtime 创建成果 commit 时固定 HEAD/ChangeSet/revision，并且只在已核验归属的 task worktree 提交，沿用现有仓库 identity 并正常执行 hooks。FULL 下 `task result capture` 单命令提交、不确认且不应用敏感路径拒绝；STRICT 下保留 prepare/confirm 与敏感路径 deny policy。
14. IntegrationBatch 是正式领域对象，记录任务集合、对应 revision、commit、固定 dev 基线、dev 集成结果和验证证据；`dev → main` 另由稳定提升记录绑定权限模式、dev/main SHA、验证证据与 Runtime 重启结果。
15. Human-authored knowledge 和 machine-generated knowledge 分离；Agent 不能静默覆盖人工维护的知识文件。
16. Self Task 原则上可修改全部 Codeestra 源码，但只能在隔离开发环境形成 Candidate。运行中的 Stable 不被直接覆盖；Promotion 必须由用户发起。
17. 独立且极小的 `codeestra-bootstrap` 提供 list versions、launch version、switch version、health check、rollback，作为恢复入口。
18. 能力完备性以 CLI 为准：任何领域能力都必须有对应的 CLI 命令路径；UI/桌面只是同一命令面的前端。不得存在仅 UI 可用的能力。
19. 自动化测试与验收只通过 CLI/命令面驱动；不引入桌面或键鼠控制自动化。FULL 模式不得新增任何确认步骤。
20. Runtime 保持本机单用户模型，不提供 RBAC、多用户/租户、路径沙箱、网络策略或密钥托管。权限模式只分为默认 `FULL` 与显式 opt-in 的 `STRICT`；FULL 使用当前用户可获得的全部主机权限。
21. 人工介入采用双通道：Session Guidance 进入真实 provider conversation、立即影响当前执行但不修改验收规格；改变规格/约束必须显式生成 TaskRevision。Pi 接管等待当前工具完成后的结构化安全点，不为接管强杀工具；接管、detach、交还与 writer lease 全部经 CLI/Runtime 命令面表达，不新增确认门禁。
22. Agent 执行过程可以只读观察（ADR-0013）：`session.transcript` 直接读取 Provider 自己的持久会话文件并展示工具调用与返回、助手文本、thinking 与 token/成本。该视图不写数据库、不产生 domain event、不构成投递或业务事实、不是 attach 也不是终端接管；provider 文件路径不离开 Runtime，只允许读取 Runtime 自己 session 目录内经规范化的普通文件。
23. Agent 可以结构化提问（ADR-0014）：Codeestra 自有的受控扩展向 Agent 提供 `ask_user_question`（1–4 题，每题 2–4 个带描述的可选项，可多选，可用自己的话回答）。一份问卷整体对应**一个** Provider dialog、**一条** `QUESTION` Attention 与**一次** answer Operation；回答以结构化 `QUESTIONNAIRE` 表达，Runtime 必须按被问的那份问卷校验后才记录。选项越界、重复题号或单选多选个数不符都必须返回稳定错误码并保持请求 OPEN，**不得**降级为“用户拒绝回答”或静默作废已答内容；只有用户明确的 `CANCEL` 才是拒绝。提问不是审批：FULL 不新增确认，STRICT 也不把它当作需要审批的副作用工具。该通道不改变受控启动策略（仍以 `--no-extensions` 只加载 Codeestra 自己的扩展）。
24. 用户可以暂停、终止、归档任务（ADR-0016）。暂停为协作停止：先落 `PAUSING`、确认 provider 进程已退出后才落 `PAUSED`，workspace 与会话证据保留；恢复在同一工作树新建 Execution，并以 provider conversation resume（`--session <file>`）继续，旧 Execution 为 `SUPERSEDED`，不把进程间恢复伪装成原地 pause。终止是终态 `CANCELLED`，不自动重开，旧审计与证据保留。归档是软删除：只写 `tasks.archived_at`，默认列表隐藏，不删除任何行、不回收 worktree/branch；物理删除与资源回收是待决策的独立高风险能力，不在取消流程中隐式执行。三项能力都有完整 CLI 命令，且不新增确认。

## 3. 任务修订与执行证据

TaskRevision 保留原始意图来源、作者、前一 revision、规格与约束快照以及修改原因。Execution、VerificationRun 和 IntegrationBatchItem 必须指向精确 revision 与 Git commit，而不是只读取 Task 的最新文本。

已完成执行不代表已验证，已验证不代表已集成到 `dev`，已进入 `dev` 不代表已获批提升到 `main`，`main` 已更新也不代表 Runtime 已完成重启。禁止用单个 SUCCESS 含糊表达整条流水线的完成。

Task verification 在固定 commit 的隔离副本上运行项目内人工维护的 `.codeestra/policies/verification.json`：该策略只从项目 main ref 读取（Task branch 上的同名文件不参与判定）。FULL 下策略新增或变化直接执行，STRICT 下在项目 trust 时确认。验证证据绑定 revision/commit/policy digest，且不保存原始命令输出。

验证成本按分支职责分层（ADR-0038，已由 ADR-0039 实现）：创建 `task/*`、`lane/*`、feature 或 Self Task candidate 分支时，按开发方向固定少量定向测试，开发分支不得运行全量测试；所有改动集成到长期 `dev` 后，必须在准备 `dev → main` 前对精确 dev 候选 SHA 运行全量测试，候选、测试配置或锁文件变化使证据失效。Task/Integration 的定向验证不能替代这份提升前全量证据。命令面：分支把该范围写进 `.codeestra/tests.json`，`task tests record` 把它快照成绑定 `(task, revision, commit, digest)` 的 append-only 记录，`task verify` 只消费已记录的计划并如实记录 `policySource`（没有记录时仍用固定项目策略，固定策略未被移除）；`promotion.full-suite run --dev-commit <full-sha>` 由 Runtime 在精确 SHA 的 detached 副本上运行项目 `main` ref 的固定策略并观察结果（客户端不能自报），证据绑定该 SHA、该策略 digest 与候选锁文件 digest，`promotion prepare/approve/promote` 全部消费它，任一绑定变化或在精确候选上没有该证据即拒绝且不推进任何 ref。本 ADR-0039 之前注明的「当前模型尚不能自动表达该分层」已不再成立。

取消、修订、重试及人工回答均需要审计；数据库变更与外部进程/Git 操作之间不能假设存在原子事务。恢复时应核对真实资源状态。

## 4. 项目知识

分层与来源（ADR-0041 已实现第一小步）：

```text
项目仓库（进 Git，人工维护，只从 main ref 读取）
.codeestra/
├── instructions/   # 人工维护，Markdown（.md）+ 可选 YAML front-matter（id/scope）
├── skills/         # 人工维护，同上
└── policies/       # 人工维护，既有 JSON 机制独占（verification.json / impact.json）

Runtime 数据目录（不进 Git，机器生成，只有 Runtime 可写）
<CODEESTRA_HOME>/knowledge/<project-id>/
├── generated/             # 机器生成层的读位置
│   ├── <entry>.md         # 机器生成内容
│   └── <entry>.meta.json  # 来源与版本（source/kind/revision/commit/generatedAt）
└── <task-id>/             # 某个 Execution 物化出的知识上下文（写位置）
    └── knowledge-context.md
```

**规格修订（FOUNDATION-067 / ADR-0041）**：本节原先只写「`.codeestra/generated/` 机器生成」，把 `generated/` 画在项目 `.codeestra/` 内，并把「知识目录的 Git 跟踪策略」留作待明确。本轮据实测把它确定为：**机器生成层的读与写都在 Runtime 数据目录，项目树里一个字节都不写**。理由不是偏好而是硬事实：worktree 里未被 ignore 的未跟踪文件会进入该 Task 的 Git change set，于是（a）任意两个并发 Task 都会因同一个路径被判 `SAME_FILE`/`CONFLICTING`（已实测：容量等待退化为冲突拒绝），且（b）它会被 `task result capture` 的 `git add --all` 提交进成果 commit 并随 IntegrationBatch 进入 `dev`。把机器生成知识放在 Runtime 数据目录让「机器生成不进提交」成为结构事实，而不依赖任何 ignore 规则。`.gitignore` 里的 `.codeestra/generated/` 只是守卫规则（防止用户仓库里残留同名目录被提交），**不是**存放位置。

加载顺序固定为 `instructions` → `skills` → `generated`，先人工后机器。**没有覆盖语义**：可解析的人工条目全部进入快照，一条都不丢弃；重复 id 或重复路径是 fail-closed 拒绝（稳定错误码），不是「后者胜」。人工层只从项目 `main` ref 读取（读法同 `.codeestra/policies/verification.json` 与 `.codeestra/impact.json`），所以 Task 分支上的同名文件不参与判定。人工层任何条目被拒（front-matter 非法、超出上限、非 UTF-8、重复 id/路径）则**拒绝建立 Execution**；`generated/` 缺失或为空是正常状态。

每个 Execution 在建立时绑定它**实际使用**的知识快照：内容 digest（逐条目 + 整体）、`main` commit、逐条来源路径；绑定写入 append-only 表 `execution_knowledge_snapshots`（schema v26），并与 Execution 行在同一写事务内，因此「Execution 存在」与「已绑定所用知识版本」不可分开观察。解析结果物化为 `<CODEESTRA_HOME>/knowledge/<project-id>/<task-id>/knowledge-context.md`，其 digest 与字节数一并写进绑定。命令面：`project knowledge validate|list|show|resolve`（`--json`、稳定退出码）。

已知边界：Provider 侧**是否读取**该物化文件尚未验证（本轮 Agent Adapter 不消费 `knowledgeSnapshotRefs`，adapter 侧注入属后续格）。

知识的最小语义集里 `policies/` 仍由既有机制独占，不进知识层；向量检索、embedding 与 LLM 摘要不在本阶段。

知识目录的 Git 跟踪策略由此明确：人工层必须进 Git；机器生成层属 Runtime 数据、读写都不在项目树内，因而不得进提交；Worktree、密钥、终端日志和运行数据库同样属于 Runtime 数据，不放入项目 `.codeestra/`。

## 5. 自我演化

```text
Main（Stable）→ Dev / Self Task → Self Worktree → Development → Candidate Build
→ Self Hosting Test → PROMOTABLE → 用户批准 dev/main → Main 更新
→ 立即重启与健康检查 → New Stable
```

Self-hosting test 不应污染 Stable 的数据库、工作树、真实运行任务或版本指针。已确认切换前停止接纳新执行，等待活动任务结束或由用户取消；不迁移活动 Session。数据库兼容策略与 bootstrap 更新授权范围必须在 Phase 7 实现前决策。单纯切回二进制不一定能回滚已经迁移的数据。

## 6. 技术方向

优先 TypeScript、Bun、Bun workspaces、React、Vite、Tailwind、shadcn/ui、Tauri 2、SQLite、Drizzle ORM、Zod、Git CLI、Bun.spawn、Vitest。PTY 按真实交互需求单独选型；普通 stdout pipe 不能冒充 PTY。

目标是本机单用户开发编排。不引入 Kubernetes、Kafka、RabbitMQ、微服务拆分或分布式基础设施。采用独立本地 Runtime，首个可用入口为自动启动该后台 Runtime 的 CLI，后续桌面作为可重连客户端；关闭客户端不终止任务和 Session。Phase 3 的原生终端接管由 Runtime 持有 PTY：Pi 在当前工具结束后的安全点从 RPC 自动进程交接到同一持久 conversation 的原生 TUI，detach 不终止 TUI，显式 release 后再交接回 RPC；两边不得同时写同一 session/worktree。**CLI 是完备、可脚本化的权威接口面（§1.1 第 2 条）；Web UI 与桌面是同一命令面的便利前端，功能是 CLI 能力的子集投影。** Runtime 默认 `FULL`：项目注册不确认，Pi 对所有已注册工具自动放行且不加工具 allowlist，验证策略变化自动执行，成果 commit 使用单步 capture；CLI 可无确认切换 `STRICT` 恢复旧门禁。Agent 配置（provider/model/thinking level）按 ADR-0012 分全局默认与每项目覆盖持久化，逐字段按 环境变量 > 项目 > 全局 > 适配器默认 解析，仅影响新 Session，生效值随 Execution 记录。Agent 执行过程按 ADR-0013 只读展示：`session.transcript` 读 Provider 自己的持久会话文件（工具调用/返回、助手文本、thinking、token/成本），不入库、不是事件、不是 attach，文件路径不离开 Runtime。项目开发固定使用 `main`/`dev` 双分支（本机为两个独立 clone，ADR-0048）：功能从 `dev` 建基线并先集成回 `dev`；FULL 下固定证据后经远端 `dev` 中转提升到 `main` 无需批准（ADR-0047），更新后立即以 CLI `stop` + `status` 重启并检查 Runtime（ADR-0009/0011）。取消采用协作停止，超时请求人工处理并保留资源；优先级只影响后续调度、不抢占。用户可对任务执行暂停/恢复、终止与归档（ADR-0016）：均经 CLI 与同一命令面完成，暂停/恢复复用 provider conversation，终止为终态，归档只隐藏且不删除审计和 worktree，三者都不新增确认。

## 7. 阶段

- Phase 0：Architecture Foundation。
- Phase 1：Single Task Runtime。
- Phase 2：Task DAG + Scheduler + Parallel Worktrees。
- Phase 3：Interactive Agent Sessions（Session Guidance、原生终端接管、PTY 重连、RPC↔TUI 安全点交接）。
- Phase 4：Integration Pipeline（Task 结果集成到 `dev`；固定证据后由 `dev` 提升到 `main` 并立即重启 Runtime；仅 STRICT 要求批准）。
- Phase 5：Multiple Agent Adapters。
- Phase 6：Project Knowledge。
- Phase 7：Self Evolution。

Phase 1 可产生待集成且有验证证据的任务结果，不以直接合并 main 来补齐尚未实现的 Phase 4。

## 8. 本次交付范围

先完成规格、协作规则、领域对象、状态机、SQLite schema、事件模型、Adapter/Workspace API、Scheduler、Conflict Analyzer、模块结构、roadmap 与风险分析。通过架构准入条件后才做 Phase 0 / Phase 1 最小实现。

当前已完成 Phase 0 第一批领域模型，并进入 Phase 1：已有 storage、CLI/独立 Runtime、Task 入口、owned worktree/Execution/Session、Pi RPC Adapter、事件与 typed Attention、成果 commit、Task verification、事件订阅和本地 Web UI。ADR-0011 已实现默认 FULL 与 CLI STRICT 开关：新项目无需 TRUST 输入，Pi 已注册工具自动允许，验证策略变化不需确认，敏感路径不拒绝，成果可用 `task result capture` 单步提交；STRICT 保留旧门禁。ADR-0012 已实现 Agent 配置：`agent.config.get/set/clear` 与 CLI `agent config …` 提供全局默认与每项目覆盖，字段为 provider/model/thinking level，解析与记录由 Runtime 单点完成，UI 只投影同一命令面。ADR-0013 已实现只读执行过程视图：`task transcript`/`session transcript`/`session transcript part` 与 Web UI 的任务详情「Agent 执行过程」面板读取 Provider 会话文件，默认截断可展开、运行中增量轮询；它不是事件、不入库、不宣称 attach。现有 Phase 1 `task.run` 的 Task worktree 基线已是 ADR-0009/ADR-0018 的固定 `dev`（`projects.dev_ref`；仓库无 `dev` 时 trust 以 `DEV_REF_MISSING` 拒绝），不再从 `mainRef` 建立。Integration 与 `dev → main` 提升（ADR-0047 的产品实现已落，见开头状态段）、并行调度、ADR-0010 的 TUI/PTY 接管均已实现（见本文件开头状态段与 §3）；仍未实现的是 Tauri、自我升级、多用户或分布式能力，以及 Session Guidance 与多成员 IntegrationBatch（因此三次真实提升走 AGENTS.md 的人工路径，那三次产品 `promotion prepare/approve/promote` 没有成立；ADR-0047 之后的产品命令面按上面的 push + 读回 + 等待拉取 + 收口路径实现）。真实 Pi 的 FULL 模式端到端已在临时仓库完成首轮受控验收（FOUNDATION-019），但真实 provider 的并发运行、revision 投递 ACK、真实模型下的暂停/恢复与取消超时仍未复验；本阶段验收只用 CLI/命令面，不使用 computer-use。

## 9. 文档导航与决策纪律

- [架构草案](docs/architecture/README.md)
- [待决项与 ADR 规则](docs/decisions/README.md)
- [当前任务进度](docs/tasks/README.md)
- [MVP roadmap](docs/roadmap/mvp.md)

本文件是长期产品与架构依据；具体设计不得违背本文件。**§1.1 的三条第一原则（ADR-0008）优先级最高**：效率至上、CLI 完备的服务形态、测试仅限 CLI/命令面且不获取电脑控制权。未确认提案不是已接受决策。若用户改变既有决策，应同步修改规格、ADR、技术设计及对应测试要求。
