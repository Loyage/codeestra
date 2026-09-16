# Codeestra — 产品与架构规格

状态：架构设计基线；关键决策持续以 ADR 确认。**三条第一原则（默认 FULL 零确认、CLI 完备的服务形态、测试仅限 CLI/命令面且不获取电脑控制权）见 §1.1，优先级最高（ADR-0008/0011）。**

**实现进度不写在本文件**：已完成、未验收与未实现的能力见 `docs/tasks/README.md`，当前有效决策与待决项见 `docs/decisions/README.md`。本文件只写长期产品与架构语义；规格与实现不一致时按 `AGENTS.md` 的决策流程先明确变更，不静默重新解释规格。

## 1. 定位与目标

Codeestra 是 Task-first、local-first 的 AI Development Runtime。用户管理产品意图，Codeestra 管理软件工程。它不是以聊天、终端或 Agent 为中心的助手，也不是简单的多 Agent UI。

用户可持续输入开发意图，系统把输入归类为 `CREATE_TASK`、`AMEND_TASK`、`CANCEL_TASK` 或 `ANSWER_AGENT`，并保留原始输入、分类结果、关联任务和审计记录。`ADD_CONSTRAINT` 自 ADR-0065 起**不再产生**（约束功能已删除），仅为已记录的历史行保留在 `intents.kind` 的 CHECK 里。`CHANGE_PRIORITY` 与 `SELF_MODIFICATION` 是已声明但**当前不可产生**的取值：没有任何命令写它们，`intents.kind` 的 CHECK 自 schema v28 起（ADR-0046）不再接受；`SELF_MODIFICATION` 计划在 Phase 7 重新加入，届时要再做一次迁移。目标任务不明确时不能静默修改任务，应请求澄清。

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
2. Task 持有当前 specification、不可覆盖的 revision history、priority、dependencies、predicted impact、conflict state、execution history、branch/worktree、validation/integration state，以及两个 Task 级标题（显示标题与命名标题，ADR-0065）。
3. Minimum Useful Decomposition：仅当拆分明显改善并行性、依赖管理、风险隔离、上下文规模、独立验证或合并边界时才拆分。2～8 个任务是常见范围，不是约束。
4. 依赖图必须是 DAG；新增或修改依赖时检测环，失败则不部分应用。
5. 开始执行必须同时满足依赖条件、并发安全和 Agent 资源可用。容量是**每个 Runtime 一个跨所有项目的唯一并行上限**（ADR-0061）：任意时刻运行中的 Task 总数不超过该值，其余等待，不按 Project 或 Adapter 另设额度。功能 Task/worktree 从固定基线 commit 建立（ADR-0066：**只有一种基线** —— 项目文件夹建 workspace 时当前检出的分支；`HEAD` detached 以 `TASK_BASE_REF_UNRESOLVED` 拒绝，`--base-ref` 可单次覆盖）；依赖上游结果 commit 必须对项目**当前 Task 基线 ref** 可达才释放下游，基线读不到时按未满足阻塞而**不**拒绝命令（ADR-0024 的 fail-closed 口径；原因码 `UPSTREAM_RESULT_MISSING` / `BASE_REF_MISSING` / `BASE_REF_UNREADABLE` / `NOT_REACHABLE_FROM_BASE`）。仅 Task verification 成功不释放依赖。
6. Conflict assessment 为 `SAFE_TO_PARALLELIZE | UNKNOWN | CONFLICTING`，但**默认是 `SAFE_TO_PARALLELIZE`**：判定只比较**声明**，即两个 Task 的 revision 是否声明了**同一功能**（feature，取自项目 `.codeestra/impact.json` 的 `modules[].id`，`task create --feature`）。**只有当双方声明同一功能、且对方仍未完成**（状态不是 `SUCCEEDED`/`CANCELLED`，且未归档）时才是 `CONFLICTING`。**文件路径重叠、同一目录、同一模块路径、共享构建/依赖/schema 资源都不再构成冲突**——它们仍是可观测事实并进入解释输出，但不再阻止并发。`UNKNOWN` 保留为取值（历史 assessment 与客户端仍能渲染），当前规则**没有产生它的路径**：映射缺失/未确认/不完整、基线移动、worktree 不可观测都不再使判定变成 `UNKNOWN`。`--allow-unknown` 与一次性放行命令面保留，但只对 `UNKNOWN` 有意义，**永不放宽 `CONFLICTING`**。功能 id 在写入时按项目 main ref 的映射校验（未声明即 `UNKNOWN_FEATURE`，映射不可读即拒绝），因此判定本身不需要读映射。默认路径确认步数为 0。（原保守语义见 ADR-0031，已被 ADR-0059 取代。）
7. 每个运行中 Task 独占 branch 和 worktree；不允许多个 Task 操作同一工作目录。branch 与 owned worktree 用 Task 的命名标题（ADR-0065 D03）：`task/<编号>-<命名标题>` 与 `worktrees/<project-id>/<编号>-<命名标题>/`；创建于命名标题落地之前的 Task 继续使用内部 ID（`task/<task-id>` 与 `<task-id>`），迁移不改名。owned worktree 位于 Runtime 数据目录，不得污染用户主工作区。
8. Core 只依赖 Agent Adapter 合约，不能依赖某个 Agent 的命令行参数、SDK 类型或输出格式。
9. AgentSession 是有身份、生命周期和恢复信息的运行实体，不是一次命令调用。用户可从 Task 入口请求接管运行中的真实 Agent；Pi 采用安全点 RPC→原生 TUI/PTY 进程交接，而不是把日志浏览伪装成 attach。一个 Execution 可保留有序 Session process incarnation，但任意时刻最多一个 Provider writer；旧进程未确认退出不得启动 successor（ADR-0010）。
10. `WAITING_FOR_USER` 仅暂停对应 Task，其他合格任务继续执行。`BLOCKED` 专指依赖条件未满足；冲突等待、容量等待、全局暂停等待和故障不能都归为 BLOCKED。全局暂停中的待启动 Task 以独立等待原因表达，不改写为 `BLOCKED`。
11. 运行中的 Task 可以修订；改变任务详情或功能声明必须生成 TaskRevision，请求暂停 Agent，并记录暂停、投递和应用确认。确认新修订后才恢复；无法可靠暂停或确认时保留现场并重新执行。旧 revision 的验证不能作为新 revision 的交付证据。
12. Task 验证与它的隔离副本是不同事实，不能互相替代。**产品不再建模 dev clone、长期 `dev` 集成分支或 `dev → main` 提升**（ADR-0066，schema v36）：Task 基线取项目文件夹当前检出的分支，成果停在 `refs/heads/task/<task-id>`，是否合并与何时合并由用户在自己的分支上决定；`task integrate`、`task integration *` 与 `promotion *` 已从命令面删除，`projects.dev_repo_path` / `projects.dev_ref` 与全部集成/提升表已 DROP。Codeestra **自身仓库**仍长期保留 `main` 与 `dev`（本机为两个独立 clone，ADR-0048）：`main` 是可运行稳定实例，`dev` 是新功能实验与集成分支；但这只是本仓库的人工约定，产品不提供命令、不记账、不校验它。本仓库自身的 `dev → main` 仍按 `AGENTS.md` 的人工四步执行（push 固定候选到远端 `dev` 并读回、main 检出 ff-only 拉取、重启核对、最后推回远端 `main`），重启成功前不得报告提升完成。

12. Task 验证与 Integration 验证是不同实体/记录，不能互相替代。项目必须长期保留 `main` 与 `dev`：`main` 是可运行稳定实例、不被开发中代码干扰的稳定分支，`dev` 是新功能实验与集成分支。**该 main/dev 双分支（双检出）模型只属于 Codeestra 自身**（ADR-0060）：被管理的其它项目**不要求**有 `dev` 分支或走 `dev → main` 提升——它们的 Task 基线取**项目文件夹当前检出的分支**，成果留在 task 分支由用户自己合并；`projects.dev_repo_path` 因此**可选**，只有需要长期 `dev` 分支的操作（`task integrate`、`promotion *`）仍以 `DEV_REPO_REQUIRED` 拒绝。Task branch 不得绕过 integration pipeline，任何完成功能必须先进入 `dev`。`dev → main` 固定 dev SHA、预期 main SHA 与验证证据；FULL 下无需批准，STRICT 下保留旧批准语义。提升必须经远端 `dev` 中转（ADR-0047，细则见 ADR-0052）：显式 push 固定候选到远端 `dev` 并读回核对，main 检出以 fast-forward-only 拉取该候选，重启核对成功后才推回远端 `main`；除该固定候选外不 push 任何 ref、不覆盖用户改动。本仓库自身的提升按 `AGENTS.md` 的人工四步执行，不使用产品 `promotion prepare/approve/promote`。`main` 更新后必须立即在 main 检出执行 CLI `stop` 再执行 `status` 重新拉起并检查 Runtime；重启成功前不得报告提升完成。
13. Runtime 创建成果 commit 时固定 HEAD/ChangeSet/revision，并且只在已核验归属的 task worktree 提交，沿用现有仓库 identity 并正常执行 hooks。FULL 下 `task result capture` 单命令提交、不确认且不应用敏感路径拒绝；STRICT 下保留 prepare/confirm 与敏感路径 deny policy。
14. IntegrationBatch 已随 ADR-0066 从产品中删除（schema v36）：不再有集成批次、独立集成验证或稳定提升记录。Task 的成果 commit 与它的任务级验证记录仍是正式领域事实，两者绑定 revision 与 commit。
15. Human-authored knowledge 和 machine-generated knowledge 分离；Agent 不能静默覆盖人工维护的知识文件。
16. Self Task 原则上可修改全部 Codeestra 源码，但只能在隔离开发环境形成 Candidate。运行中的 Stable 不被直接覆盖；Promotion 必须由用户发起。
17. 独立且极小的 `codeestra-bootstrap` 提供 list versions、launch version、switch version、health check、rollback，作为恢复入口。
18. 能力完备性以 CLI 为准：任何领域能力都必须有对应的 CLI 命令路径；UI/桌面只是同一命令面的前端。不得存在仅 UI 可用的能力。
19. 自动化测试与验收只通过 CLI/命令面驱动；不引入桌面或键鼠控制自动化。FULL 模式不得新增任何确认步骤。
20. Runtime 保持本机单用户模型，不提供 RBAC、多用户/租户、路径沙箱、网络策略或密钥托管。权限模式只分为默认 `FULL` 与显式 opt-in 的 `STRICT`；FULL 使用当前用户可获得的全部主机权限。
21. 人工介入采用双通道：Session Guidance 进入真实 provider conversation、立即影响当前执行但不修改验收规格；改变任务详情或功能声明必须显式生成 TaskRevision。Pi 接管等待当前工具完成后的结构化安全点，不为接管强杀工具；接管、detach、交还与 writer lease 全部经 CLI/Runtime 命令面表达，不新增确认门禁。
22. Agent 执行过程可以只读观察（ADR-0013）：`session.transcript` 直接读取 Provider 自己的持久会话文件并展示工具调用与返回、助手文本、thinking 与 token/成本。该视图不写数据库、不产生 domain event、不构成投递或业务事实、不是 attach 也不是终端接管；provider 文件路径不离开 Runtime，只允许读取 Runtime 自己 session 目录内经规范化的普通文件。
23. Agent 可以结构化提问（ADR-0014）：Codeestra 自有的受控扩展向 Agent 提供 `ask_user_question`（1–4 题，每题 2–4 个带描述的可选项，可多选，可用自己的话回答）。一份问卷整体对应**一个** Provider dialog、**一条** `QUESTION` Attention 与**一次** answer Operation；回答以结构化 `QUESTIONNAIRE` 表达，Runtime 必须按被问的那份问卷校验后才记录。选项越界、重复题号或单选多选个数不符都必须返回稳定错误码并保持请求 OPEN，**不得**降级为“用户拒绝回答”或静默作废已答内容；只有用户明确的 `CANCEL` 才是拒绝。提问不是审批：FULL 不新增确认，STRICT 也不把它当作需要审批的副作用工具。该通道不改变受控启动策略（仍以 `--no-extensions` 只加载 Codeestra 自己的扩展）。
24. 用户可以暂停、终止、归档任务（ADR-0016）。暂停为协作停止：先落 `PAUSING`、确认 provider 进程已退出后才落 `PAUSED`，workspace 与会话证据保留；恢复在同一工作树新建 Execution，并以 provider conversation resume（`--session <file>`）继续，旧 Execution 为 `SUPERSEDED`，不把进程间恢复伪装成原地 pause。终止是终态 `CANCELLED`，不自动重开，旧审计与证据保留。归档是软删除：只写 `tasks.archived_at`，默认列表隐藏，不删除任何行、不回收 worktree/branch；物理删除由 ADR-0058 的 `task purge` 单独承担，不在取消流程中隐式执行。三项能力都有完整 CLI 命令，且不新增确认。
25. 用户可以全局冻结 / 继续 Agent 模型驱动（ADR-0061）。全局冻结先持久化启动屏障，再按 `pid + OS start token + incarnation` 核验并冻结每个受控 Provider 主进程；不向已经运行的工具子进程发停止或终止信号，不取消已发出的模型请求。只有全部目标被证实停止才报告全局 `PAUSED`，否则保持屏障并报 `RECOVERY_REQUIRED`。该状态跨 Runtime 重启保持，只有显式继续才解除；它不改写 Task/Execution/Session 生命周期状态，也不替代 ADR-0016 的单 Task 暂停。

## 3. 任务修订与执行证据

TaskRevision 保留原始意图来源、作者、前一 revision、规格快照以及修改原因。Execution、VerificationRun 和 IntegrationBatchItem 必须指向精确 revision 与 Git commit，而不是只读取 Task 的最新文本。

已完成执行不代表已验证，已验证不代表已集成到 `dev`，已进入 `dev` 不代表已获批提升到 `main`，`main` 已更新也不代表 Runtime 已完成重启。禁止用单个 SUCCESS 含糊表达整条流水线的完成。

Task verification 在固定 commit 的隔离副本上运行项目内人工维护的 `.codeestra/policies/verification.json`：该策略只从项目 main ref 读取（Task branch 上的同名文件不参与判定）。FULL 下策略新增或变化直接执行，STRICT 下在项目 trust 时确认。验证证据绑定 revision/commit/policy digest，且不保存原始命令输出。

验证成本按分支职责分层（ADR-0038，命令面由 ADR-0039 实现）：创建 `task/*`、`lane/*`、feature 或 Self Task candidate 分支时，按开发方向固定少量定向测试，开发分支不得运行全量测试；所有改动集成到长期 `dev` 后，必须在准备 `dev → main` 前对精确 dev 候选 SHA 运行全量测试，候选、测试配置或锁文件变化使证据失效。Task/Integration 的定向验证不能替代这份提升前全量证据。命令面：分支把该范围写进 `.codeestra/tests.json`，`task tests record` 把它快照成绑定 `(task, revision, commit, digest)` 的 append-only 记录，`task verify` 只消费已记录的计划并如实记录 `policySource`（没有记录时仍用固定项目策略，固定策略未被移除）；`promotion.full-suite run --dev-commit <full-sha>` 由 Runtime 在精确 SHA 的 detached 副本上运行项目 `main` ref 的固定策略并观察结果（客户端不能自报），证据绑定该 SHA、该策略 digest 与候选锁文件 digest，`promotion prepare/approve/promote` 全部消费它，任一绑定变化或在精确候选上没有该证据即拒绝且不推进任何 ref。

取消、修订、重试及人工回答均需要审计；数据库变更与外部进程/Git 操作之间不能假设存在原子事务。恢复时应核对真实资源状态。

## 4. 项目知识

分层与来源（ADR-0041）：

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

**机器生成层的读与写都在 Runtime 数据目录，项目树里一个字节都不写**（FOUNDATION-067 / ADR-0041 的规格修订）。理由是硬事实：worktree 里未被 ignore 的未跟踪文件会进入该 Task 的 Git change set，于是（a）任意两个并发 Task 都会因同一个路径被判冲突，（b）它会被 `task result capture` 的 `git add --all` 提交进成果 commit 并随 IntegrationBatch 进入 `dev`。把机器生成知识放在 Runtime 数据目录让「机器生成不进提交」成为结构事实，而不依赖任何 ignore 规则。`.gitignore` 里的 `.codeestra/generated/` 只是守卫规则（防止用户仓库里残留同名目录被提交），**不是**存放位置。

加载顺序固定为 `instructions` → `skills` → `generated`，先人工后机器。**没有覆盖语义**：可解析的人工条目全部进入快照，一条都不丢弃；重复 id 或重复路径是 fail-closed 拒绝（稳定错误码），不是「后者胜」。人工层只从项目 `main` ref 读取（读法同 `.codeestra/policies/verification.json` 与 `.codeestra/impact.json`），所以 Task 分支上的同名文件不参与判定。人工层任何条目被拒（front-matter 非法、超出上限、非 UTF-8、重复 id/路径）则**拒绝建立 Execution**；`generated/` 缺失或为空是正常状态。

每个 Execution 在建立时绑定它**实际使用**的知识快照：内容 digest（逐条目 + 整体）、`main` commit、逐条来源路径；绑定写入 append-only 表 `execution_knowledge_snapshots`（schema v26），并与 Execution 行在同一写事务内，因此「Execution 存在」与「已绑定所用知识版本」不可分开观察。解析结果物化为 `<CODEESTRA_HOME>/knowledge/<project-id>/<task-id>/knowledge-context.md`，其 digest 与字节数一并写进绑定。命令面：`project knowledge validate|list|show|resolve`（`--json`、稳定退出码）。每个 provider 用自己的通道消费这份绑定（ADR-0051）；Provider 侧是否真的读取该内容仍属未验证能力，不得声称已验收。

知识的最小语义集里 `policies/` 仍由既有机制独占，不进知识层；向量检索、embedding 与 LLM 摘要不在本阶段。

知识目录的 Git 跟踪策略：人工层必须进 Git；机器生成层属 Runtime 数据、读写都不在项目树内，因而不得进提交；Worktree、密钥、终端日志和运行数据库同样属于 Runtime 数据，不放入项目 `.codeestra/`。

## 5. 自我演化

```text
Main（Stable）→ Dev / Self Task → Self Worktree → Development → Candidate Build
→ Self Hosting Test → PROMOTABLE → 用户批准 dev/main → Main 更新
→ 立即重启与健康检查 → New Stable
```

Self-hosting test 不应污染 Stable 的数据库、工作树、真实运行任务或版本指针。已确认切换前停止接纳新执行，等待活动任务结束或由用户取消；不迁移活动 Session。数据库兼容策略与 bootstrap 更新授权范围必须在 Phase 7 实现前决策。单纯切回二进制不一定能回滚已经迁移的数据。

## 6. 技术方向

优先 TypeScript、Bun、Bun workspaces、React、Vite、Tailwind、shadcn/ui、Tauri 2、SQLite、Drizzle ORM、Zod、Git CLI、Bun.spawn、Vitest。PTY 按真实交互需求单独选型；普通 stdout pipe 不能冒充 PTY。

目标是本机单用户开发编排。不引入 Kubernetes、Kafka、RabbitMQ、微服务拆分或分布式基础设施。采用独立本地 Runtime，首个可用入口为自动启动该后台 Runtime 的 CLI，后续桌面作为可重连客户端；关闭客户端不终止任务和 Session。Phase 3 的原生终端接管由 Runtime 持有 PTY：在当前工具结束后的安全点从 RPC 交接到同一持久 conversation 的原生 TUI，detach 不终止 TUI，显式 release 后再交接回 RPC；两边不得同时写同一 session/worktree。

**CLI 是完备、可脚本化的权威接口面（§1.1 第 2 条）；Web UI 与桌面是同一命令面的便利前端，功能是 CLI 能力的子集投影。** Runtime 默认 `FULL`：项目注册不确认，Pi 对所有已注册工具自动放行且不加工具 allowlist，验证策略变化自动执行，成果 commit 使用单步 capture；CLI 可无确认切换 `STRICT` 恢复旧门禁。

Agent 配置（provider/model/thinking level）按 ADR-0012 分全局默认与每项目覆盖持久化，逐字段按 环境变量 > 项目 > 全局 > 适配器默认 解析，仅影响新 Session，生效值随 Execution 记录。Agent 执行过程按 ADR-0013 只读展示，不入库、不是事件、不是 attach，文件路径不离开 Runtime。

Task 的分支与基线按 ADR-0066：**只有一种基线** —— 项目文件夹建 workspace 时当前检出的分支（ref 与 commit 一起固定；`HEAD` detached 拒绝，`--base-ref` 可单次覆盖）。产品不再有 dev clone、集成或提升：成果停在 task 分支，由用户自己合并。Codeestra 自身仓库仍长期使用 `main`/`dev` 双分支（本机为两个独立 clone，ADR-0048），并由 `AGENTS.md` 的人工四步把 `dev` 提升到 `main`，更新后立即以 CLI `stop` + `status` 重启并检查 Runtime（ADR-0009/0011）；这属于仓库约定，不占产品命令面。取消采用协作停止，超时请求人工处理并保留资源；优先级只影响后续调度、不抢占。用户可对任务执行暂停/恢复、终止与归档（ADR-0016）：均经 CLI 与同一命令面完成，暂停/恢复复用 provider conversation，终止为终态，归档只隐藏且不删除审计和 worktree，三者都不新增确认。ADR-0061 进一步确定：每个 Runtime 只保留一个跨项目全局并行上限；全局暂停采用持久启动屏障 + 可核验的 Provider 主进程冻结，UI 的“暂停全部/继续全部”必须只是 `scheduler control pause|resume` 命令面的投影。

## 7. 阶段

- Phase 0：Architecture Foundation。
- Phase 1：Single Task Runtime。
- Phase 2：Task DAG + Scheduler + Parallel Worktrees + Runtime 全局负载控制（ADR-0061：唯一跨项目并行上限与持久全局 Provider 冻结）。
- Phase 3：Interactive Agent Sessions（Session Guidance、原生终端接管、PTY 重连、RPC↔TUI 安全点交接）。
- Phase 4：Integration Pipeline（Task 结果集成到 `dev`；固定证据后由 `dev` 提升到 `main` 并立即重启 Runtime；仅 STRICT 要求批准）。
- Phase 5：Multiple Agent Adapters。
- Phase 6：Project Knowledge。
- Phase 7：Self Evolution。

Phase 1 可产生待集成且有验证证据的任务结果，不以直接合并 main 来补齐尚未实现的 Phase 4。

## 8. 本次交付范围

先完成规格、协作规则、领域对象、状态机、SQLite schema、事件模型、Adapter/Workspace API、Scheduler、Conflict Analyzer、模块结构、roadmap 与风险分析。通过架构准入条件后才做 Phase 0 / Phase 1 最小实现。

当前实现进度（已完成能力、未验收与未实现项）见 `docs/tasks/README.md`；本文件不逐条罗列现状。本阶段验收只用 CLI/命令面，不使用 computer-use。把尚未实现的阶段或能力描述成已交付，是本规格明确禁止的。

## 9. 文档导航与决策纪律

- [架构草案](docs/architecture/README.md)
- [待决项与 ADR 规则](docs/decisions/README.md)
- [当前任务进度](docs/tasks/README.md)
- [MVP roadmap](docs/roadmap/mvp.md)

本文件是长期产品与架构依据；具体设计不得违背本文件。**§1.1 的三条第一原则（ADR-0008）优先级最高**：效率至上、CLI 完备的服务形态、测试仅限 CLI/命令面且不获取电脑控制权。未确认提案不是已接受决策。若用户改变既有决策，应同步修改规格、ADR、技术设计及对应测试要求。
