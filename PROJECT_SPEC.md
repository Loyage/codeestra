# Codeestra — 产品与架构规格

状态：架构设计基线；关键决策持续以 ADR 确认。**三条第一原则（默认 FULL 零确认、CLI 完备的服务形态、测试仅限 CLI/命令面且不获取电脑控制权）见 §1.1，优先级最高（ADR-0008/0011）。** Phase 0 第一批与 Phase 1 storage/CLI-Runtime 骨架已开始，已有 Task create/list/submit、owned worktree/恢复、Execution 预留、Agent start、Adapter event 去重投影与 durable outbox、Pi RPC framing/gate 子集，以及 Runtime adapter registry、`task.run` 运行循环、事件 pump、typed answer 自动投递、Runtime shutdown 释放与 `task status`；成果 commit 已支持 FULL 单步 capture / STRICT 两步确认（ChangeSet + hooks + 崩溃 reconcile），Task verification 已实现（main ref 人工维护策略 + FULL 零确认 / STRICT trust 确认 + 固定 commit 的 detached 副本 + 非敏感证据），事件日志的只读长连接订阅（`events.subscribe`/`events.list` 与排他 sequence 游标、显式游标失效）已实现但仍限于观察，本地 Web UI 入口（ADR-0007：`codeestra ui`、127.0.0.1 + 内存 token + SSE、React/Vite 资产由 Runtime 托管）已实现，`task.run`/`task.verify` 仍是同步命令、长命令进度不因此可见，Pi 0.84.4 首轮 spike 与最小可用形态策略已确认；真实模型与工具执行已完成首轮受控验收（deepseek-flash：真实 `write` 工具调用、fail-closed gate 审批、成果 commit 与 Task verification PASSED，证据见 FOUNDATION-019），但取消超时、gate 拒绝路径、Integration/main 提升与多任务并行仍未验收；`codeestra open` 与 UI 预选已在 CLI/命令面验证，但未用浏览器自动化验证（ADR-0008 测试边界）。

## 1. 定位与目标

Codeestra 是 Task-first、local-first 的 AI Development Runtime。用户管理产品意图，Codeestra 管理软件工程。它不是以聊天、终端或 Agent 为中心的助手，也不是简单的多 Agent UI。

用户可持续输入开发意图，系统将输入归类为 `CREATE_TASK`、`AMEND_TASK`、`ADD_CONSTRAINT`、`CANCEL_TASK`、`CHANGE_PRIORITY`、`ANSWER_AGENT` 或 `SELF_MODIFICATION`，并保留原始输入、分类结果、关联任务和审计记录。目标任务不明确时不能静默修改任务，应请求澄清。

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
6. Conflict assessment 为 `SAFE_TO_PARALLELIZE | UNKNOWN | CONFLICTING`。只有 SAFE 允许直接并发；未知不等于无冲突。
7. 每个运行中 Task 独占 branch 和 worktree；不允许多个 Task 操作同一工作目录。branch 使用内部稳定 ID；owned worktree 位于 Runtime 数据目录 `worktrees/<project-id>/<task-id>/`，不得污染用户主工作区。
8. Core 只依赖 Agent Adapter 合约，不能依赖某个 Agent 的命令行参数、SDK 类型或输出格式。
9. AgentSession 是有身份、生命周期和恢复信息的运行实体，不是一次命令调用。用户可从 Task 入口请求接管运行中的真实 Agent；Pi 采用安全点 RPC→原生 TUI/PTY 进程交接，而不是把日志浏览伪装成 attach。一个 Execution 可保留有序 Session process incarnation，但任意时刻最多一个 Provider writer；旧进程未确认退出不得启动 successor（ADR-0010）。
10. `WAITING_FOR_USER` 仅暂停对应 Task，其他合格任务继续执行。`BLOCKED` 专指依赖条件未满足；冲突等待、容量等待和故障不能都归为 BLOCKED。
11. 运行中的 Task 可以修订；追加约束必须生成 TaskRevision，请求暂停 Agent，并记录暂停、投递和应用确认。确认新约束后才恢复；无法可靠暂停或确认时保留现场并重新执行。旧 revision 的验证不能作为新 revision 的交付证据。
12. Task 验证与 Integration 验证是不同实体/记录，不能互相替代。项目必须长期保留 `main` 与 `dev`：`main` 是日常实际运行和开发辅助的稳定分支，`dev` 是新功能实验与集成分支。Task branch 不得绕过 integration pipeline，任何完成功能必须先进入 `dev`。`dev → main` 固定 dev SHA、预期 main SHA 与验证证据；FULL 下无需批准，STRICT 下保留旧批准语义。不隐式 push，不覆盖用户改动。`main` 更新后必须立即在 main 工作树执行 CLI `stop` 再执行 `status` 重新拉起并检查 Runtime；重启成功前不得报告提升完成。
13. Runtime 创建成果 commit 时固定 HEAD/ChangeSet/revision，并且只在已核验归属的 task worktree 提交，沿用现有仓库 identity 并正常执行 hooks。FULL 下 `task result capture` 单命令提交、不确认且不应用敏感路径拒绝；STRICT 下保留 prepare/confirm 与敏感路径 deny policy。
14. IntegrationBatch 是正式领域对象，记录任务集合、对应 revision、commit、固定 dev 基线、dev 集成结果和验证证据；`dev → main` 另由稳定提升记录绑定权限模式、dev/main SHA、验证证据与 Runtime 重启结果。
15. Human-authored knowledge 和 machine-generated knowledge 分离；Agent 不能静默覆盖人工维护的知识文件。
16. Self Task 原则上可修改全部 Codeestra 源码，但只能在隔离开发环境形成 Candidate。运行中的 Stable 不被直接覆盖；Promotion 必须由用户发起。
17. 独立且极小的 `codeestra-bootstrap` 提供 list versions、launch version、switch version、health check、rollback，作为恢复入口。
18. 能力完备性以 CLI 为准：任何领域能力都必须有对应的 CLI 命令路径；UI/桌面只是同一命令面的前端。不得存在仅 UI 可用的能力。
19. 自动化测试与验收只通过 CLI/命令面驱动；不引入桌面或键鼠控制自动化。FULL 模式不得新增任何确认步骤。
20. Runtime 保持本机单用户模型，不提供 RBAC、多用户/租户、路径沙箱、网络策略或密钥托管。权限模式只分为默认 `FULL` 与显式 opt-in 的 `STRICT`；FULL 使用当前用户可获得的全部主机权限。
21. 人工介入采用双通道：Session Guidance 进入真实 provider conversation、立即影响当前执行但不修改验收规格；改变规格/约束必须显式生成 TaskRevision。Pi 接管等待当前工具完成后的结构化安全点，不为接管强杀工具；接管、detach、交还与 writer lease 全部经 CLI/Runtime 命令面表达，不新增确认门禁。

## 3. 任务修订与执行证据

TaskRevision 保留原始意图来源、作者、前一 revision、规格与约束快照以及修改原因。Execution、VerificationRun 和 IntegrationBatchItem 必须指向精确 revision 与 Git commit，而不是只读取 Task 的最新文本。

已完成执行不代表已验证，已验证不代表已集成到 `dev`，已进入 `dev` 不代表已获批提升到 `main`，`main` 已更新也不代表 Runtime 已完成重启。禁止用单个 SUCCESS 含糊表达整条流水线的完成。

Task verification 在固定 commit 的隔离副本上运行项目内人工维护的 `.codeestra/policies/verification.json`：该策略只从项目 main ref 读取（Task branch 上的同名文件不参与判定）。FULL 下策略新增或变化直接执行，STRICT 下在项目 trust 时确认。验证证据绑定 revision/commit/policy digest，且不保存原始命令输出。

取消、修订、重试及人工回答均需要审计；数据库变更与外部进程/Git 操作之间不能假设存在原子事务。恢复时应核对真实资源状态。

## 4. 项目知识

预留布局：

```text
.codeestra/
├── instructions/   # 人工维护
├── skills/         # 人工维护
├── policies/       # 人工维护
├── generated/      # 机器生成，包含来源与版本信息
```

知识目录的 Git 跟踪策略另行明确，不能将整个 `.codeestra/` 一概当作知识或一概忽略。Worktree、密钥、终端日志和运行数据库属于 Runtime 数据，不放入项目 `.codeestra/`，不得意外进入提交。

## 5. 自我演化

```text
Main（Stable）→ Dev / Self Task → Self Worktree → Development → Candidate Build
→ Self Hosting Test → PROMOTABLE → 用户批准 dev/main → Main 更新
→ 立即重启与健康检查 → New Stable
```

Self-hosting test 不应污染 Stable 的数据库、工作树、真实运行任务或版本指针。已确认切换前停止接纳新执行，等待活动任务结束或由用户取消；不迁移活动 Session。数据库兼容策略与 bootstrap 更新授权范围必须在 Phase 7 实现前决策。单纯切回二进制不一定能回滚已经迁移的数据。

## 6. 技术方向

优先 TypeScript、Bun、Bun workspaces、React、Vite、Tailwind、shadcn/ui、Tauri 2、SQLite、Drizzle ORM、Zod、Git CLI、Bun.spawn、Vitest。PTY 按真实交互需求单独选型；普通 stdout pipe 不能冒充 PTY。

目标是本机单用户开发编排。不引入 Kubernetes、Kafka、RabbitMQ、微服务拆分或分布式基础设施。采用独立本地 Runtime，首个可用入口为自动启动该后台 Runtime 的 CLI，后续桌面作为可重连客户端；关闭客户端不终止任务和 Session。Phase 3 的原生终端接管由 Runtime 持有 PTY：Pi 在当前工具结束后的安全点从 RPC 自动进程交接到同一持久 conversation 的原生 TUI，detach 不终止 TUI，显式 release 后再交接回 RPC；两边不得同时写同一 session/worktree。**CLI 是完备、可脚本化的权威接口面（§1.1 第 2 条）；Web UI 与桌面是同一命令面的便利前端，功能是 CLI 能力的子集投影。** Runtime 默认 `FULL`：项目注册不确认，Pi 对所有已注册工具自动放行且不加工具 allowlist，验证策略变化自动执行，成果 commit 使用单步 capture；CLI 可无确认切换 `STRICT` 恢复旧门禁。项目开发固定使用 `main`/`dev` 双分支：功能从 `dev` 建基线并先集成回 `dev`；FULL 下固定证据后提升到 `main` 无需批准，更新后立即以 CLI `stop` + `status` 重启并检查 Runtime（ADR-0009/0011）。取消采用协作停止，超时请求人工处理并保留资源；优先级只影响后续调度、不抢占。

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

当前已完成 Phase 0 第一批领域模型，并进入 Phase 1：已有 storage、CLI/独立 Runtime、Task 入口、owned worktree/Execution/Session、Pi RPC Adapter、事件与 typed Attention、成果 commit、Task verification、事件订阅和本地 Web UI。ADR-0011 已实现默认 FULL 与 CLI STRICT 开关：新项目无需 TRUST 输入，Pi 已注册工具自动允许，验证策略变化不需确认，敏感路径不拒绝，成果可用 `task result capture` 单步提交；STRICT 保留旧门禁。现有 Phase 1 `task.run` 仍从项目 `mainRef` 建 worktree，尚未实现 ADR-0009 的 dev 基线。尚未实现 Integration/dev→main、并行调度、ADR-0010 的 TUI/PTY 接管、Tauri、自我升级、多用户或分布式能力。真实 Pi 的 FULL 模式端到端仍需在临时仓库复验；本阶段验收只用 CLI/命令面，不使用 computer-use。

## 9. 文档导航与决策纪律

- [架构草案](docs/architecture/README.md)
- [待决项与 ADR 规则](docs/decisions/README.md)
- [当前任务进度](docs/tasks/README.md)
- [MVP roadmap](docs/roadmap/mvp.md)

本文件是长期产品与架构依据；具体设计不得违背本文件。**§1.1 的三条第一原则（ADR-0008）优先级最高**：效率至上、CLI 完备的服务形态、测试仅限 CLI/命令面且不获取电脑控制权。未确认提案不是已接受决策。若用户改变既有决策，应同步修改规格、ADR、技术设计及对应测试要求。
