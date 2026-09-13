# Codeestra — 产品与架构规格

状态：架构设计基线；关键决策持续以 ADR 确认。Phase 0 第一批与 Phase 1 storage/CLI-Runtime 骨架已开始，已有 Task create/list/submit、owned worktree/恢复、Execution 预留、Agent start、Adapter event 去重投影与 durable outbox、Pi RPC framing/gate 子集，以及 Runtime adapter registry、`task.run` 运行循环、事件 pump、typed answer 自动投递、Runtime shutdown 释放与 `task status`；ADR-0003 的成果 commit 已实现为两步确认（ChangeSet + 版本化敏感路径策略 + 一次性授权 + 崩溃 reconcile），ADR-0006 的 Task verification 已实现（main ref 人工维护策略 + trust 一次性确认 + 固定 commit 的 detached 副本 + 非敏感证据），Pi 0.84.4 首轮 spike 与最小可用形态策略已确认，真实 Agent 执行仍须通过其余技术准入。

## 1. 定位与目标

Codeestra 是 Task-first、local-first 的 AI Development Runtime。用户管理产品意图，Codeestra 管理软件工程。它不是以聊天、终端或 Agent 为中心的助手，也不是简单的多 Agent UI。

用户可持续输入开发意图，系统将输入归类为 `CREATE_TASK`、`AMEND_TASK`、`ADD_CONSTRAINT`、`CANCEL_TASK`、`CHANGE_PRIORITY`、`ANSWER_AGENT` 或 `SELF_MODIFICATION`，并保留原始输入、分类结果、关联任务和审计记录。目标任务不明确时不能静默修改任务，应请求澄清。

主流水线：

```text
User Intent → Task / Task DAG → Dependency Analysis → Conflict Analysis
→ Scheduler → Git Worktree → Coding Agent → Task Verification
→ Integration Branch → Integration Verification → Main
```

## 2. 核心不变量

1. Task 是业务主实体。Execution 是一次执行尝试，每次只绑定一个主 Agent。更换主 Agent 建立新的 Execution。
2. Task 持有当前 specification、不可覆盖的 revision history、constraints、priority、dependencies、predicted impact、conflict state、execution history、branch/worktree、validation/integration state。
3. Minimum Useful Decomposition：仅当拆分明显改善并行性、依赖管理、风险隔离、上下文规模、独立验证或合并边界时才拆分。2～8 个任务是常见范围，不是约束。
4. 依赖图必须是 DAG；新增或修改依赖时检测环，失败则不部分应用。
5. 开始执行必须同时满足依赖条件、并发安全和 Agent 资源可用。依赖上游必须通过集成验证并进入 main，下游基线必须包含所需上游结果。仅 Task verification 成功不释放依赖。
6. Conflict assessment 为 `SAFE_TO_PARALLELIZE | UNKNOWN | CONFLICTING`。只有 SAFE 允许直接并发；未知不等于无冲突。
7. 每个运行中 Task 独占 branch 和 worktree；不允许多个 Task 操作同一工作目录。branch 使用内部稳定 ID；owned worktree 位于 Runtime 数据目录 `worktrees/<project-id>/<task-id>/`，不得污染用户主工作区。
8. Core 只依赖 Agent Adapter 合约，不能依赖某个 Agent 的命令行参数、SDK 类型或输出格式。
9. AgentSession 是有身份、生命周期和恢复信息的运行实体，不是一次命令调用。后续允许进入真实 Agent session；不以伪造聊天记录替代交互。
10. `WAITING_FOR_USER` 仅暂停对应 Task，其他合格任务继续执行。`BLOCKED` 专指依赖条件未满足；冲突等待、容量等待和故障不能都归为 BLOCKED。
11. 运行中的 Task 可以修订；追加约束必须生成 TaskRevision，请求暂停 Agent，并记录暂停、投递和应用确认。确认新约束后才恢复；无法可靠暂停或确认时保留现场并重新执行。旧 revision 的验证不能作为新 revision 的交付证据。
12. Task 验证与 Integration 验证是不同实体/记录，不能互相替代。Task branch 不得绕过 integration pipeline 直接进入 main。每批提升须用户批准固定候选 SHA 与预期 main SHA；main 移动使批准失效。不隐式 push，不覆盖用户改动。
13. Runtime 每次替 Agent 创建成果 commit 前须由用户确认固定 HEAD/ChangeSet/revision；变化使确认失效。只在已核验归属的 task worktree 提交，沿用现有仓库 identity，项目 trust 后正常执行 hooks；敏感/运行数据路径命中时拒绝，不静默漏交。
14. IntegrationBatch 是正式领域对象，记录任务集合、对应 revision、commit、基线、集成结果和验证证据。
15. Human-authored knowledge 和 machine-generated knowledge 分离；Agent 不能静默覆盖人工维护的知识文件。
16. Self Task 原则上可修改全部 Codeestra 源码，但只能在隔离开发环境形成 Candidate。运行中的 Stable 不被直接覆盖；Promotion 必须由用户发起。
17. 独立且极小的 `codeestra-bootstrap` 提供 list versions、launch version、switch version、health check、rollback，作为恢复入口。

## 3. 任务修订与执行证据

TaskRevision 保留原始意图来源、作者、前一 revision、规格与约束快照以及修改原因。Execution、VerificationRun 和 IntegrationBatchItem 必须指向精确 revision 与 Git commit，而不是只读取 Task 的最新文本。

已完成执行不代表已验证，已验证不代表已集成，已集成不代表已发布。禁止用单个 SUCCESS 含糊表达整条流水线的完成。

Task verification 在固定 commit 的隔离副本上运行项目内人工维护的 `.codeestra/policies/verification.json`：该策略只从项目 main ref 读取（Task branch 上的同名文件不参与判定），并在项目 trust 时一次性确认，内容变化后必须重新确认。验证证据绑定 revision/commit/policy digest，且不保存原始命令输出。

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
Stable → Self Task → Self Worktree → Development → Candidate Build
→ Self Hosting Test → PROMOTABLE → User Promotion → New Stable
```

Self-hosting test 不应污染 Stable 的数据库、工作树、真实运行任务或版本指针。已确认切换前停止接纳新执行，等待活动任务结束或由用户取消；不迁移活动 Session。数据库兼容策略与 bootstrap 更新授权范围必须在 Phase 7 实现前决策。单纯切回二进制不一定能回滚已经迁移的数据。

## 6. 技术方向

优先 TypeScript、Bun、Bun workspaces、React、Vite、Tailwind、shadcn/ui、Tauri 2、SQLite、Drizzle ORM、Zod、Git CLI、Bun.spawn、Vitest。PTY 按真实交互需求单独选型；普通 stdout pipe 不能冒充 PTY。

目标是本机单用户开发编排。不引入 Kubernetes、Kafka、RabbitMQ、微服务拆分或分布式基础设施。采用独立本地 Runtime，首个可用入口为自动启动该后台 Runtime 的 CLI，后续桌面作为可重连客户端；关闭客户端不终止任务和 Session。项目首次接入显式一次信任。Phase 1 首个真实 Adapter 为 Pi；内置 read/grep/find/ls 直接允许，write/edit/bash/powershell 逐次审批，未知工具 fail-closed；实际协议能力必须验证。取消采用协作停止，超时请求人工处理并保留资源；优先级只影响后续调度、不抢占。

## 7. 阶段

- Phase 0：Architecture Foundation。
- Phase 1：Single Task Runtime。
- Phase 2：Task DAG + Scheduler + Parallel Worktrees。
- Phase 3：Interactive Agent Sessions。
- Phase 4：Integration Pipeline。
- Phase 5：Multiple Agent Adapters。
- Phase 6：Project Knowledge。
- Phase 7：Self Evolution。

Phase 1 可产生待集成且有验证证据的任务结果，不以直接合并 main 来补齐尚未实现的 Phase 4。

## 8. 本次交付范围

先完成规格、协作规则、领域对象、状态机、SQLite schema、事件模型、Adapter/Workspace API、Scheduler、Conflict Analyzer、模块结构、roadmap 与风险分析。通过架构准入条件后才做 Phase 0 / Phase 1 最小实现。

当前已完成 Phase 0 第一批领域模型，并进入 Phase 1：已有 storage、CLI/独立 Runtime、Task 入口、owned worktree、Execution/Session 启动协调、Adapter observation/outbox、typed Attention answer Operation、Pi framing/gate 与自有子进程的 `PiRpcAdapter`，以及 adapter registry、`task.run` 运行循环、事件 pump 与 answer 自动投递，以及 ADR-0003 的成果 commit 两步确认与 ADR-0006 的 Task verification。不实现：Integration 结果、并行调度、完整桌面交互、自动集成发布、机器知识生成、自我升级、远端 Agent、多用户、多机器调度及分布式运行。真实 Pi 工具执行、Integration 验证与 main 提升仍须通过对应技术和授权门禁。

## 9. 文档导航与决策纪律

- [架构草案](docs/architecture/README.md)
- [待决项与 ADR 规则](docs/decisions/README.md)
- [当前任务进度](docs/tasks/README.md)
- [MVP roadmap](docs/roadmap/mvp.md)

本文件是长期产品与架构依据；具体设计不得违背本文件。未确认提案不是已接受决策。若用户改变既有决策，应同步修改规格、ADR、技术设计及对应测试要求。
