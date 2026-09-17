# Codeestra — 产品与架构规格

状态：长期产品与目标架构基线；关键决策持续以 ADR 确认。**四条第一原则（默认 FULL 零确认、CLI 完备的服务形态、测试仅限 CLI/命令面且不获取电脑控制权、CLI 每一层自描述且与实际命令同源）见 §1.1，优先级最高（ADR-0008/0011/0068）。**ADR-0070 已把目标架构升级为 Service / Process / Agent / Signal 内核；S1–S4 已实现；S5–S8 各已交付一个纵向切片（ADR-0071/0072/0073/0074：Process 完成写路径与只读进度、intention 结构化路由、Project/Task 创建写路径、受管 integration ref 与持久 merge queue，schema v38），S9–S10 与其余 S5–S8 内容尚未完成，差异见 `docs/roadmap/mvp.md`。

**实现进度不写在本文件**：已完成、未验收与未实现的能力见 `docs/tasks/README.md`，当前有效决策与待决项见 `docs/decisions/README.md`。本文件只写长期产品与架构语义；规格与实现不一致时按 `AGENTS.md` 的决策流程先明确变更，不静默重新解释规格，也不把目标命令写成当前已可用。

## 1. 定位与目标

Codeestra 的目标是成为 **AI 的操作系统**：不是“AI 时代的通用操作系统”，而是在 AI 软件领域取得类似操作系统之于程序的基础地位。它在宿主操作系统之上统一管理长期 Service、短期 Process、Agent、Signal、用户意图、Attention、调度与工程资源。

长期设计不以今天的 API 价格、速度和模型水平刻舟求剑。默认假设模型调用会趋向免费、极速且足够聪明，因此优先保障用户操作随手度、思维流畅度、系统持续响应与并发吞吐；不能为了几个 token 牺牲用户等待时间。Codeestra 不是聊天壳、终端壳或多 Agent UI。

内核是 **Service-first**，调度仍是 **Task-first**：0 号 Codeestra Service 是根服务；Project、Task、Scheduler 与 Attention 是不同 kind 的持久 Service；Task Service 仍是 Scheduler 分配执行资源的业务单元。Agent、Terminal、Conversation、Worktree 都不是调度主实体。

用户可向 0 号、Project、Task 或其它允许 prompt 的 Service 持续输入 intention。系统保留原始输入、路由/分类结果、关联 Service/Task/Process 与审计；目标不明确时建立 Attention，请求澄清，不能静默修改任务。

目标主流水线：

```text
User Intention → SIG_P → target Service → Agent-supervising Process
→ typed Service APIs / SIG_A → Task Service / Task DAG → eligibility
→ Scheduler → owned Worktree → Development Process → Agent
→ Result Commit → Task Verification → merge-request Signal
→ Project Service merge queue → Integration Process → Integration Verification
→ CAS advance managed integration ref → Task integration = MERGED
```

当前 v38 已有通用 `service/process/signal/intent` CLI、兼容投影与受管 integration（`project integration *` / `task integration show`，ADR-0074），但尚无原生 Process Agent 控制、自然语言解释、Integration Process 或发布出口；后续按 ADR-0070 的增量波次推进。

### 1.1 第一原则（其他条款从属于此）

以下四条是用户确认的最高原则（ADR-0008/0068），本文件其余条款、ADR 与实现选择都在其下解释：

1. **效率至上。** 用户从意图到可用结果的等待时间与操作步数优先于其他考虑。Runtime 默认使用 `FULL` 全权限模式：Agent、验证命令与 Git hooks 以当前系统用户的主机级权限运行，已注册工具（包括未知名称）不确认、不做路径或网络限制；项目接入、成果 commit、验证策略变化、managed integration 与未来 Self Promotion 的常态确认成本均为 **0 步、0 等待**。用户可通过 CLI 无确认切换到 `STRICT` 兼容模式以恢复旧门禁。revision/ref/ownership/process identity、静止证据、幂等与崩溃恢复等正确性核对继续有效，但不得伪装成权限审批（ADR-0011）。
2. **软件本体是服务，CLI 是完备命令面。** 独立本地 Runtime 是软件本体，拥有完备的 CLI 交互能力：每个能力都必须能只靠 CLI 完成，并可脚本化驱动（机器可读输出、稳定退出码）。**当前按 ADR-0067 只启用 CLI/Unix socket 命令面，Web UI 开发已暂停**：实现源码可静态保留，但不提供入口、不进入默认构建/测试/发布。未来若恢复 Web UI 或桌面，它们只能走同一 versioned command/query/event 面与同一确认门禁，不新增业务语义、不绕过门禁、不直接访问 SQLite。出现“只有 UI 能做、CLI 不能做”的能力视为缺陷而非设计选择。
3. **自动化测试仅限 CLI/命令面，不获取电脑控制权。** 项目内测试与验收的驱动方式仅限 CLI 命令与 Runtime 命令面；ADR-0067 起当前传输仅为 Unix socket，暂停的 HTTP/SSE 不在测试范围。禁止 computer-use、OS 级键鼠/窗口自动化、桌面应用操作与真实桌面会话，开发 Agent 不得为验证而取得用户电脑控制权。产品内 Agent 同样不新增屏幕读取、桌面操作或键鼠控制类工具。
4. **CLI 的每一层都自描述，且清单与实际命令同源。** 顶层、组、子组与命令都必须能自报「这一层有哪些命令、各自大致做什么」（`help`，ADR-0068），而且这份清单必须由**分发 argv 的同一份命令树**生成：不得列出不存在的命令，也不得漏掉存在的命令；「只有源码里有、CLI 进不去」的命令面（含 Runtime 命令）是缺陷而非设计选择。用法错误只打印一行并指向对应层的 `help`；清单本身不占错误路径，但仍必须完整可读。Runtime 的 versioned 命令面同样必须可发现（`runtime commands`），其清单从请求 union 派生。

### 1.2 操作系统类比的边界

Codeestra 借鉴操作系统的价值：长期服务、短期进程、调度、信号、隔离故障与持续响应；不机械复制 POSIX 名字或实现。Service 是 Runtime 内的持久 Actor，不是一个 OS 进程；Process 是目标有界的 Agent supervisor，不是普通程序的统称；普通确定性程序由 Service API 调用并用 Operation 记录副作用。

程序与 Agent 的统一点是：二者都只能通过版本化 Service contract 观察或改变系统。明确 API 走 `SIG_A`；自然语言意图走 `SIG_P` 并创建 Process。Service 不直接拥有 Agent，Agent 必须由 Process 监督。

## 2. 核心不变量

1. 内核 Service-first，Scheduler Task-first。一个 Runtime home 恰有一个稳定身份的 0 号 Service；Service 组成有根树。Task Service 是 Project Service 的直接子节点与业务调度单元；Task Service 不嵌套。
2. Service 是 Runtime 内持久 Actor，持有类型化 core state、版本化 contract、state version、持久 inbox 与 namespaced metadata。metadata API 不能绕过 core state machine。Service 可拥有子 Service/Process，但不能直接拥有 Agent。
3. Process 是短期、目标有界、允许阻塞的 Agent supervisor。一个活动 Process 恰有一个主 Agent；更换主 Agent 建 successor Process。现有 Execution/AgentSession/incarnation 向 Process 投影迁移，不能形成两套权威执行事实。
4. Signal 分 `SIG_A`（类型化 API）与 `SIG_P`（prompt/intention）。Signal 持久化、至少一次投递，靠目标 Service + idempotency key 收敛；外部副作用继续用 Operation 与事实核对恢复，不宣称 exactly-once。
5. Task Service 持有当前 specification、不可覆盖的 revision history、priority、dependencies、predicted impact、conflict state、Process/execution history、branch/worktree、verification/integration state，以及两个 Task 级标题（显示标题与命名标题，ADR-0065）。Minimum Useful Decomposition 继续适用：仅当拆分明显改善并行性、依赖管理、风险隔离、上下文规模、独立验证或合并边界时才拆分，2～8 个任务是常见范围而非约束。依赖图必须是 DAG，失败不部分应用。Task/Project 服务产出版本化 eligibility；Scheduler 只对 eligible Task 做 priority 排序、全局控制、容量与原子预留，事务内重验 eligibility version。每个 Runtime 仍只有一个跨项目并行上限。
6. Conflict assessment 为 `SAFE_TO_PARALLELIZE | UNKNOWN | CONFLICTING`，但**默认是 `SAFE_TO_PARALLELIZE`**：判定只比较**声明**，即两个 Task 的 revision 是否声明了**同一功能**（feature，取自项目 `.codeestra/impact.json` 的 `modules[].id`，`task create --feature`）。**只有当双方声明同一功能、且对方仍未完成**（状态不是 `SUCCEEDED`/`CANCELLED`，且未归档）时才是 `CONFLICTING`。**文件路径重叠、同一目录、同一模块路径、共享构建/依赖/schema 资源都不再构成冲突**——它们仍是可观测事实并进入解释输出，但不再阻止并发。`UNKNOWN` 保留为取值（历史 assessment 与客户端仍能渲染），当前规则**没有产生它的路径**：映射缺失/未确认/不完整、基线移动、worktree 不可观测都不再使判定变成 `UNKNOWN`。`--allow-unknown` 与一次性放行命令面保留，但只对 `UNKNOWN` 有意义，**永不放宽 `CONFLICTING`**。功能 id 在写入时按项目 main ref 的映射校验（未声明即 `UNKNOWN_FEATURE`，映射不可读即拒绝），因此判定本身不需要读映射。默认路径确认步数为 0。（原保守语义见 ADR-0031，已被 ADR-0059 取代。）
7. 每个运行中 Task 独占 branch 和 worktree；不允许多个 Task 操作同一工作目录。branch 与 owned worktree 用 Task 的命名标题（ADR-0065 D03）：`task/<编号>-<命名标题>` 与 `worktrees/<project-id>/<编号>-<命名标题>/`；创建于命名标题落地之前的 Task 继续使用内部 ID（`task/<task-id>` 与 `<task-id>`），迁移不改名。owned worktree 位于 Runtime 数据目录，不得污染用户主工作区。
8. Core 只依赖 Agent Adapter 合约，不能依赖某个 Agent 的命令行参数、SDK 类型或输出格式。
9. AgentSession 是有身份、生命周期和恢复信息的运行实体，不是一次命令调用。用户可从 Task 入口请求接管运行中的真实 Agent；Pi 采用安全点 RPC→原生 TUI/PTY 进程交接，而不是把日志浏览伪装成 attach。一个 Execution 可保留有序 Session process incarnation，但任意时刻最多一个 Provider writer；旧进程未确认退出不得启动 successor（ADR-0010）。
10. `WAITING_FOR_USER` 仅暂停对应 Task，其他合格任务继续执行。`BLOCKED` 专指依赖条件未满足；冲突等待、容量等待、全局暂停等待和故障不能都归为 BLOCKED。全局暂停中的待启动 Task 以独立等待原因表达，不改写为 `BLOCKED`。
11. 运行中的 Task 可以修订；改变任务详情或功能声明必须生成 TaskRevision，请求暂停 Agent，并记录暂停、投递和应用确认。确认新修订后才恢复；无法可靠暂停或确认时保留现场并重新执行。旧 revision 的验证不能作为新 revision 的交付证据。
12. Task Verification、Integration Verification、Task result commit 与 integration ref 前进是不同事实，不能互相替代。Task 成果通过任务级验证后向 Project Service 发送 merge-request Signal；Project Service 以持久队列保证同一项目一次只有一个活动集成，项目之间可并行。
13. 每个 Project Service 管理一个独立 integration ref/worktree。新 Task 默认从当时的 integration commit 建固定基线；集成只在 Runtime owned workspace 操作，不直接修改用户工作树。只有独立 Integration Verification 通过且 expected integration OID 未移动，才能 CAS 推进 ref；冲突、验证失败、崩溃或 ref 移动保留现场。如何把 integration ref 发布到用户 release/main 不在当前规格内。
14. Runtime 创建成果 commit 时固定 HEAD/ChangeSet/revision，并且只在已核验归属的 task worktree 提交，沿用现有仓库 identity 并正常执行 hooks。FULL 下 `task result capture` 单命令提交、不确认且不应用敏感路径拒绝；STRICT 下保留 prepare/confirm 与敏感路径 deny policy。schema v38 起该流程的落点由 ADR-0074 给出：成果仍先停在 task branch，经 `project integration run` 的合并、独立 Integration Verification 与 CAS 才进入受管 integration ref；**没有任何命令把它发布到用户 main/release**，这一点不得写成已实现。
15. Human-authored knowledge 和 machine-generated knowledge 分离；Agent 不能静默覆盖人工维护的知识文件。
16. Self Task 原则上可修改全部 Codeestra 源码，但只能在隔离开发环境形成 Candidate。运行中的 Stable 不被直接覆盖；Promotion 必须由用户发起。
17. 独立且极小的 `codeestra-bootstrap` 提供 list versions、launch version、switch version、health check、rollback，作为恢复入口。
18. 能力完备性以 CLI 为准：任何领域能力都必须有对应的 CLI 命令路径。ADR-0067 起 Web UI 暂停且无可用入口；未来恢复的 UI/桌面也只能是同一命令面的前端。不得存在仅 UI 可用的能力。
19. 自动化测试与验收只通过 CLI/命令面驱动；不引入桌面或键鼠控制自动化。FULL 模式不得新增任何确认步骤。
20. Runtime 保持本机单用户模型，不提供 RBAC、多用户/租户、路径沙箱、网络策略或密钥托管。权限模式只分为默认 `FULL` 与显式 opt-in 的 `STRICT`；FULL 使用当前用户可获得的全部主机权限。
21. 人工介入采用双通道：Session Guidance 进入真实 provider conversation、立即影响当前执行但不修改验收规格；改变任务详情或功能声明必须显式生成 TaskRevision。Pi 接管等待当前工具完成后的结构化安全点，不为接管强杀工具；接管、detach、交还与 writer lease 全部经 CLI/Runtime 命令面表达，不新增确认门禁。
22. Agent 执行过程可以只读观察（ADR-0013）：`session.transcript` 直接读取 Provider 自己的持久会话文件并展示工具调用与返回、助手文本、thinking 与 token/成本。该视图不写数据库、不产生 domain event、不构成投递或业务事实、不是 attach 也不是终端接管；provider 文件路径不离开 Runtime，只允许读取 Runtime 自己 session 目录内经规范化的普通文件。
23. Agent 可以结构化提问（ADR-0014）：Codeestra 自有的受控扩展向 Agent 提供 `ask_user_question`（1–4 题，每题 2–4 个带描述的可选项，可多选，可用自己的话回答）。一份问卷整体对应**一个** Provider dialog、**一条** `QUESTION` Attention 与**一次** answer Operation；回答以结构化 `QUESTIONNAIRE` 表达，Runtime 必须按被问的那份问卷校验后才记录。选项越界、重复题号或单选多选个数不符都必须返回稳定错误码并保持请求 OPEN，**不得**降级为“用户拒绝回答”或静默作废已答内容；只有用户明确的 `CANCEL` 才是拒绝。提问不是审批：FULL 不新增确认，STRICT 也不把它当作需要审批的副作用工具。该通道不改变受控启动策略（仍以 `--no-extensions` 只加载 Codeestra 自己的扩展）。
24. 用户可以暂停、终止、归档任务（ADR-0016）。暂停为协作停止：先落 `PAUSING`、确认 provider 进程已退出后才落 `PAUSED`，workspace 与会话证据保留；恢复在同一工作树新建 Execution，并以 provider conversation resume（`--session <file>`）继续，旧 Execution 为 `SUPERSEDED`，不把进程间恢复伪装成原地 pause。终止是终态 `CANCELLED`，不自动重开，旧审计与证据保留。归档是软删除：只写 `tasks.archived_at`，默认列表隐藏，不删除任何行、不回收 worktree/branch；物理删除由 ADR-0058 的 `task purge` 单独承担，不在取消流程中隐式执行。三项能力都有完整 CLI 命令，且不新增确认。
25. 用户可以全局冻结 / 继续 Agent 模型驱动（ADR-0061）。全局冻结先持久化启动屏障，再按 `pid + OS start token + incarnation` 核验并冻结每个受控 Provider 主进程；不向已经运行的工具子进程发停止或终止信号，不取消已发出的模型请求。只有全部目标被证实停止才报告全局 `PAUSED`，否则保持屏障并报 `RECOVERY_REQUIRED`。该状态跨 Runtime 重启保持，只有显式继续才解除；它不改写 Task/Execution/Session 生命周期状态，也不替代 ADR-0016 的单 Task 暂停。

## 3. 任务修订与执行证据

TaskRevision 保留原始意图来源、作者、前一 revision、规格快照以及修改原因。Process/Execution、Task Verification、Integration Process/Verification 与 merge queue item 必须指向精确 revision 与 Git commit，而不是只读取 Task 的最新文本。

Agent 完成不代表已捕获成果，成果 commit 不代表已验证，Task Verification 通过不代表已进入 Project integration ref，merge 生成候选不代表 Integration Verification 通过。禁止用单个 SUCCESS 含糊表达整条流水线。

Task Verification 在固定 commit 的隔离副本上运行项目内人工维护的验证策略；Task branch 上的同名文件不参与判定。FULL 下策略新增或变化直接执行，STRICT 下按既有门禁处理。验证证据绑定 revision/commit/policy digest，且不保存原始命令输出。Integration Verification 是 Project Service 对合并候选的独立证据，不能复用 Task Verification 冒充。

开发 Task/Process 只运行与本次改动相称的定向测试；Codeestra 自身仓库的提升前全量测试仍只在长期 `dev` 的精确候选 SHA 上执行，这是本仓库人工发布纪律，不是被管理项目的产品 `promotion` 能力。受管 integration 的验证策略、候选绑定与 expected OID 由 ADR-0074 冻结：策略仍取自项目 main ref 的人工文件，在**候选 commit 的独立副本**上重跑，证据记入 `integration_runs`；不恢复已删除的旧 `promotion.full-suite` 命令。

取消、修订、重试、Signal 消费、Process 控制、合并与人工回答均需要审计；Signal enqueue 可以与数据库状态同事务，但数据库与 Agent/Git/进程副作用之间不能假设原子性。恢复时必须核对真实资源状态与幂等回执。

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

**机器生成层的读与写都在 Runtime 数据目录，项目树里一个字节都不写**（FOUNDATION-067 / ADR-0041 的规格修订）。理由是硬事实：worktree 里未被 ignore 的未跟踪文件会进入该 Task 的 Git change set，并被 `task result capture` 的 `git add --all` 提交进成果 commit；目标架构下还会随 Project Service integration 进入受管 ref。把机器生成知识放在 Runtime 数据目录让「机器生成不进提交」成为结构事实，而不依赖任何 ignore 规则。`.gitignore` 里的 `.codeestra/generated/` 只是守卫规则，不是存放位置。

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

优先 TypeScript、Bun、Bun workspaces、SQLite、Drizzle ORM、Zod、Git CLI、Bun.spawn、Vitest。React/Vite 等 Web UI 技术实现按 ADR-0067 暂停，源码保留但不进入当前默认工具链；未来恢复时再重新确认前端技术方向。PTY 按真实交互需求单独选型；普通 stdout pipe 不能冒充 PTY。

目标是本机单用户 AI 编排内核。不引入 Kubernetes、Kafka、RabbitMQ、微服务拆分或分布式基础设施。Service 由一个独立 Runtime 内的 registry、SQLite inbox 与事件唤醒托管，不为每个 Service 建 OS 进程或 busy-loop。CLI 自动连接/启动该 Runtime；关闭客户端不终止 Service、Task、Process 或 AgentSession。原生终端接管仍由 Runtime 持有 PTY：在当前工具结束后的安全点从 RPC 交接到同一持久 conversation 的原生 TUI，detach 不终止 TUI，显式 release 后再交接回 RPC；两边不得同时写同一 session/worktree。

**CLI 是完备、可脚本化的权威接口面（§1.1 第 2 条）；ADR-0067 起 Web UI 暂停，当前没有 UI/HTTP 入口。** 保留的前端源码不是启用能力；未来恢复的 Web UI 或桌面只能是 CLI 命令面的子集投影。Runtime 默认 `FULL`：项目注册不确认，Pi 对所有已注册工具自动放行且不加工具 allowlist，验证策略变化自动执行，成果 commit 使用单步 capture；CLI 可无确认切换 `STRICT` 恢复旧门禁。

Agent 配置（provider/model/thinking level）按 ADR-0012 分全局默认与每项目覆盖持久化，逐字段按 环境变量 > 项目 > 全局 > 适配器默认 解析，仅影响新 Session，生效值随 Execution 记录。Agent 执行过程按 ADR-0013 只读展示，不入库、不是事件、不是 attach，文件路径不离开 Runtime。

目标分支模型按 ADR-0070 D07，并由 **ADR-0074 落地**：每个 Project Service 管理独立 integration ref（`refs/codeestra/integration`，私有命名空间）与 owned worktree，**新 Task 默认从当时的 integration commit 建固定基线**（既有 workspace 不回写），成果经持久 merge queue 与独立 Integration Verification 后 CAS 进入该 ref；不直接修改用户工作树，也没有把它发布到用户分支的命令。Codeestra 自身仓库仍长期使用 `main`/`dev` 双分支，并由 `AGENTS.md` 的人工四步发布；这属于仓库约定，不与产品 integration ref 混为一谈。取消采用协作停止，超时请求人工处理并保留资源；优先级只影响后续调度、不抢占。ADR-0061 的 Runtime 全局并行上限与全局 Provider 冻结继续有效。

## 7. 阶段

既有 Phase 0–6 能力是当前实现基础，不回滚。ADR-0070 的改造采用新的增量波次：

- S0：规格、ADR 与术语冻结。
- S1：纯领域 Service / Signal / Process contract。**已完成。**
- S2：additive storage 与 Project/Task/Execution 只读投影。**已完成（schema v37）。**
- S3：Service registry、持久 Signal dispatcher 与恢复。**已完成。**
- S4：`service/process/signal/intent` CLI + 现有命令兼容 facade。**已完成。**
- S5：Execution/AgentSession 向 Process 控制面映射。
- S6：root/project/task intention 与全局 Attention 路由。
- S7：Project/Task Service 成为单一写路径。
- S8：受管 integration ref、merge queue 与独立 Integration Verification。**已交付（schema v38 / ADR-0074）**；Integration Process/Agent 与发布出口未交付。
- S9：Scheduler eligibility 解耦。
- S10：迁移演练、真实验收、文档与兼容层收口。
- Self Evolution / bootstrap 仍是其后的独立阶段，不借本轮内核改造偷带实现。

完整依赖图、Agent ownership 与逐波验收见 `docs/roadmap/mvp.md`。

## 8. 本次交付范围

ADR-0070 S1–S4（纯领域内核、additive storage、Runtime registry/dispatcher、内核 CLI 与兼容 facade）已交付；S5–S8 各自的纵向切片见 `docs/roadmap/mvp.md` 与 `docs/tasks/README.md`。S9–S10 不在已交付范围；后续只能按 roadmap 的已解锁波次推进，migration 文件与版本号必须由单一 owner 管理（v37 = FOUNDATION-099，v38 = FOUNDATION-100 / ADR-0074）。

**后续切片**：S5 交付 Process 完成写路径与只读进度投影（ADR-0071）；S6 交付 intention 结构化 outcome 路由与澄清内核事实（ADR-0072，Attention 全局索引未接通）；S7 把 Project/Task **创建**收敛到 Service 写路径（ADR-0073，同一 schema v37、无 migration）；S8 交付受管 integration ref、持久 merge queue、独立 Integration Verification 与 Task 基线切换（ADR-0074，**schema v38**）。这些格子各自仍是纵向切片：原生 Process Agent 控制、真实模型意图解释、submit/revision/验证/取消/归档的写路径切换、Scheduler 建 Process、eligibility 解耦、Integration Process/Agent 与发布出口仍未实现，见 `docs/roadmap/mvp.md` 的进度表。

当前实现进度（已完成能力、未验收与未实现项）见 `docs/tasks/README.md`；本阶段验收只用 CLI/命令面，不使用 computer-use。`service/process/signal/intent` 与 `project integration *`/`task integration show` 已交付；把原生 Process Agent 控制、真实模型意图解释、Attention 全局索引、submit/revision/验证/取消/归档的写路径切换、Integration Process/Agent、integration ref 的发布出口或 eligibility 解耦描述成当前已交付，仍是本规格明确禁止的。

## 9. 文档导航与决策纪律

- [AI 操作系统愿景](docs/vision/ai-operating-system.md)
- [Service / Process / Signal 目标内核](docs/architecture/service-process-signal.md)
- [架构索引](docs/architecture/README.md)
- [待决项与 ADR 规则](docs/decisions/README.md)
- [当前任务进度](docs/tasks/README.md)
- [MVP roadmap](docs/roadmap/mvp.md)

本文件是长期产品与架构依据；具体设计不得违背本文件。**§1.1 的四条第一原则（ADR-0008/0068）优先级最高**：效率至上、CLI 完备的服务形态、测试仅限 CLI/命令面且不获取电脑控制权、CLI 每一层自描述且与实际命令同源。未确认提案不是已接受决策。若用户改变既有决策，应同步修改规格、ADR、技术设计及对应测试要求。
