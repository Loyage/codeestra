# ADR-0068：Service / Process / Agent / Signal 内核与受管项目集成

Status：Accepted（本次用户设计与后续选择题确认）；**尚未实现**。本 ADR 定义目标架构，不把当前 schema v36 或当前 CLI 误报为已经具备这些能力。

**Amends** ADR-0008 的“软件本体是服务”：Runtime 不再只被笼统称作一个服务，而是 0 号根 Service 与 Service 内核的宿主。

**Supersedes（目标语义）** ADR-0066 的“产品不集成、Task 只从用户当前检出分支建基线、成果永远留给用户自己合并”。ADR-0066 仍准确描述当前 v36 实现；在本 ADR 的迁移波次完成前，现有命令面仍按 ADR-0066 工作。新实现不是恢复旧 IntegrationBatch / Promotion 的原样代码，而是由 Project Service 管理独立 integration ref/worktree 的新模型。

## Context

Codeestra 的长期定位从“Task-first、local-first 的 AI Development Runtime”提升为：

> **AI 的操作系统**——不是“AI 时代的通用操作系统”，而是为 Agent、模型调用、长期服务、短期目标进程、用户意图与计算资源提供统一管理的 AI 软件内核。

设计不以今天的模型价格、延迟与可靠性为长期约束。默认假设 API 会趋向免费、极速且足够聪明；因此优先优化用户思维流畅度、并发吞吐和系统持续响应，而不是为节省少量 token 牺牲交互体验。

现有架构已经有独立 Runtime、Task、Execution、AgentSession、Scheduler、Attention、Operation 与 outbox，但缺少一个能统一解释它们的内核模型：

- Runtime 是持续运行的根服务，却没有一等 Service 树；
- Execution、Operation、Session 的边界难以直接表达“短期、目标有界、监督 Agent 的进程”；
- 用户输入主要从 Task 命令进入，尚无从 root / project / 任意 Service 注入自然语言意图的统一入口；
- 当前 v36 删除了产品侧集成，无法实现“Project Service 串行处理子 Task 的合并请求”；
- 当前 outbox 是事件投递基础，但还不是 Service 间具有明确收件人、类型与消费状态的全局 Signal 信道。

## Confirmed choices

用户在本次设计后明确选择：

1. **内核 Service-first，调度 Task-first**：Service / Process / Signal 是内核一等概念；Task Service 仍是 Scheduler 的业务调度单元。
2. **Service 是 Runtime 内持久 Actor**：不是每个 Service 一个 OS 进程；由单个独立 Runtime 托管状态、inbox 与唤醒。
3. **Process 只监督 Agent**：普通确定性程序不伪装成 Process；它们由 Service API 调用并以现有/后继 Operation 记录副作用与恢复。
4. **Signal 使用持久 inbox/outbox**：发送与业务状态可在同一 SQLite 事务落地；消费至少一次，以幂等键收敛，Runtime 重启不丢未处理 Signal。
5. **恢复受管项目集成**：Project Service 管理独立 integration ref/worktree，串行合并 Task 成果，不直接修改用户工作树。
6. **CLI 增量兼容**：保留 `project` / `task` / `session` / `attention` 等类型化 facade，同时新增 `service` / `process` / `signal` / `intent` 内核命令面；全部走同一 Runtime contract。
7. **Service 状态 = 类型化核心 + namespaced 扩展区**：核心字段受 schema、版本与状态迁移保护；扩展 metadata 也必须经 API/CAS 与审计，不能绕过领域不变量。
8. **增量迁移**：不一次性重写；先契约和投影，再 additive schema、内核、兼容 facade、受管集成，旧数据可迁移、旧 CLI 可继续使用。

## Decision

### D01 定位与优先级

Codeestra 的目标是 AI 操作系统。类比操作系统的价值不是模拟 POSIX 名字，而是提供：

- 随手输入意图、持续看到结果，减少用户充当输入/输出搬运工；
- 多个独立执行并发推进，等待模型或网络时让出调度资源；
- 长期 Service 与不稳定 Agent 执行隔离，使根服务始终可响应；
- 对 Process、资源、优先级、Attention 与恢复事实进行统一管理；
- 允许用户从 root、project、task 或其它 Service 层级介入。

ADR-0008/0011 的效率优先、默认 FULL 零确认、CLI 完备、测试不取得电脑控制权继续有效。

### D02 0 号 Service 与 Service 树

- 一个 `CODEESTRA_HOME` 恰有一个 0 号 `CodeestraService`，由独立 Runtime 宿主；Runtime 的 OS 进程身份与 0 号 Service 的领域身份是两件事。
- Service 是持久 Actor：有稳定 ID、类型、父 Service、状态版本、类型化 state、namespaced metadata、inbox cursor 与生命周期。
- Service 之间组成有根树。Project Service 是 0 号 Service 的业务子节点；Task Service 是 Project Service 的直接子节点，Task Service 之间不嵌套。
- Scheduler Service 与 Attention Service 是 0 号 Service 的系统子节点；它们不变成 Task，也不占 Task 调度槽位。
- Service 可拥有子 Service 和 Process；Process 不可成为 Service 的父节点，也不可拥有子 Service。
- Service 不直接拥有 Agent。Agent 必须由一个 Process 监督。
- “持续运行”是领域可达性，不等于每个 Service 各自 busy-loop。Runtime 用持久 inbox + 事件唤醒 + 周期 reconcile 驱动 Actor；空闲 Service 不消耗一个专属 OS 线程。

### D03 Service API 与状态

每种 Service 发布版本化 contract：commands、queries、accepted signals、emitted signals、state schema 与可见子节点。CLI 的层级命令是这些 contract 的类型化 facade，而不是在运行时动态生成不稳定命令名。

Service state 分两层：

1. **core state**：由 Service kind 的 Zod/domain schema 管理，只能通过类型化 command 和合法迁移修改；
2. **metadata**：`<namespace>/<key>` 命名的 JSON 值，仍需 CAS、大小限制、actor 与审计；metadata 不得影响核心状态机，除非后续 ADR 把该键提升为 core state。

通用 `service state set` 只写 metadata；不能借它直接把 Task 从 RUNNING 改成 MERGED、修改 ref 或释放资源。

### D04 Signal

Signal 是 Service 间及外部客户端进入 Service 的统一信封。首版固定两种业务类别：

- `SIG_A`（API signal）：调用方已经知道要执行的类型化 API；payload 必须满足目标 Service contract。纯查询、状态迁移、Git/验证等确定性程序由 Service handler + Operation 执行。
- `SIG_P`（prompt signal）：携带自然语言意图；目标 Service 创建一个 Process，由该 Process 的 Agent 解释意图并通过目标 Service 暴露的 API 完成工作。

每条 Signal 至少包含：`id`、`kind`、`source`、`targetServiceId`、`contractVersion`、`payload/promptRef`、`idempotencyKey`、`correlationId`、`causationId`、`priority`、`createdAt` 与消费状态。

可靠性语义：

- enqueue 与发送方业务状态可同事务提交；claim/ack/nack 是原子状态迁移；
- 交付是**至少一次**，handler 必须以 `(targetServiceId, idempotencyKey)` 幂等；
- “原子发送/接收”不等于跨 SQLite、Git、Provider 的 exactly-once；外部副作用继续通过 Operation + 事实核对恢复；
- Signal 正文与 Agent/工具输出都按不可信内容处理，密钥不得进入 signal/event 日志。

### D05 Process 与 Agent

- Process 是短期、目标有界、允许阻塞的 Agent supervisor；创建时固定 parent Service、任务书、Agent adapter/config、输入上下文与资源预算。
- 一个活动 Process 恰有一个主 Agent；更换主 Agent 建 successor Process，而不是悄悄替换。
- Process 负责启动、观察、暂停、继续输入、终止、token/成本观测、Attention 转发及向 parent Service 发完成/失败 Signal。
- Process 完成目标或进入终态后可被回收，但历史与关键证据保留。
- 现有 Execution 是向 Process 迁移的主要事实源；AgentSession/incarnation 继续表达 provider conversation 与 OS 进程身份。迁移期允许 `ProcessProjection ↔ Execution` 一一映射，不复制两套执行事实。
- 普通程序不建 Process：Git、verification、reclaim、确定性分析等仍是 Service API 内的 Operation。需要 Agent 处理复杂合并时，Project Service 可创建 Integration Process；该 Agent 只能通过 Project Service 的受控 Git API 操作。

### D06 Task Service 与 Scheduler

Task Service 是用户理解进度和 Scheduler 分配资源的主要单元，保留 Task-first 的调度语义：

- Task Service 持有标题、详情、revision、Project 指针、worktree、依赖、priority、执行/验证/集成投影与父 Service；
- Task Service 之间不嵌套；依赖仍是 DAG 边，不用父子树冒充依赖；
- Scheduler 只对“已具备运行资格”的 Task Service 做排序、容量与准入，不在 Scheduler 内部解释需求或自行修改 DAG；依赖/冲突/基线资格由 Task/Project 领域服务计算成明确 eligibility；
- priority 默认 0，数字越大越先被考虑；改变优先级不抢占正在运行的 Process；
- `WAITING_FOR_USER` 只暂停对应 Task/Process，0 号 Service、Project Service 与其它 Task 继续响应。

Task 的执行状态与集成状态必须分开记录。用户界面可以投影“等待合并 / 合并中 / 合并完成”，但不能用单个状态掩盖“Agent 已完成、验证是否通过、merge 是否完成”三个事实。

### D07 Project Service 与受管集成

- 每个 Project Service 配置一个由 Codeestra 独占管理的 integration ref 与 integration worktree。它从项目接入时选定的基线创建，但不是用户当前工作树，也不直接更新用户已检出的 branch。
- 新 Task 默认从 Project Service 的当前 integration commit 建立 worktree；创建后固定 base ref/commit。
- Task 完成并通过任务级验证后，Task Service 向 Project Service 发送 merge-request `SIG_A`。
- Project Service 对每个项目只允许一个活动集成；其余请求进入持久队列。顺序先按显式依赖，再按 priority desc、请求时间 asc、ID asc。
- Project Service 创建 Integration Process 处理复杂集成；Git merge/ref CAS、归属检查与验证必须走 Project Service API。Agent 不能直接改未授权 ref。
- 合并在独立 integration workspace 中进行；成功前运行独立 Integration Verification。只有验证通过且 expected integration OID 未移动，才以 CAS 推进 integration ref。
- 冲突、验证失败、Runtime 崩溃或 ref 移动都保留现场并产生明确 Attention/Signal；不得静默丢请求、强推或部分宣称成功。
- 集成成功后 Task Service 的 integration 投影为 `MERGED`，再按归属规则回收资源。如何把项目 integration ref 发布到用户的 release/main 分支不在本 ADR 内，不恢复旧 `promotion *` 语义。

### D08 Intention 与 Attention

- 用户可向 0 号、Project、Task 或其它允许 prompt 的 Service 发送 intention；统一经 `SIG_P` 进入。
- 0 号 Service 的意图分析 Process 至少可以把意图路由到某个 Project Service，或调用全局设置 API；目标不明确时建立 Attention，不猜测。
- Process 获得 parent Service 的 contract、可见子 Service 摘要与最小必要上下文；不是把全库状态无界塞进 prompt。
- Attention Service 保存全局待办索引；来源 Service/Process 保留业务归属。现有 `attention` 命令继续作为类型化 facade，并增加跨项目的 root 视图。
- 结构化问题继续使用现有 questionnaire 约束；Attention 是“需要输入”，不是审批层，FULL 下不增加确认。

### D09 CLI 与兼容

目标命令组：

```text
codeestra service list|get|tree|state ...
codeestra process list|get|input|pause|resume|terminate ...
codeestra signal send|list|get|retry ...
codeestra intent send [--service <id>|--project <id>|--task <id>] <text>
```

具体参数与稳定码在实现前由 contract 波次冻结。现有 `project`、`task`、`session`、`attention`、`scheduler` 命令不立即删除；它们调用同一 Service kernel，不维护第二套业务语义。所有新能力仍须 `--json`、稳定退出码、Unix socket command/query/event 面，且不要求 UI。

### D10 增量迁移与事实边界

- 先加投影，不双写两个权威状态机。Project/Task/Execution 的现有表在迁移期仍是业务事实源，Service/Process 行先引用它们；切换权威来源必须另有明确 migration 与回滚验证。
- schema 采用 additive migration 起步；预留 v37 给 Service/Signal/Process 内核，受管 integration 使用后继 migration。最终版本号以实现分支实际占用为准，但多个 Agent 不得并行抢同一 migration 号。
- 当前 v36 CLI 不具备 `service/process/signal/intent` 通用命令，也不具备受管集成；文档必须把“目标设计”和“当前实现”分开。
- 不删除历史 ADR、事件或任务记录；被 supersede 的语义保留历史说明。

## Consequences

### Positive

- Runtime、Project、Task、Scheduler、Attention 与 Agent 执行获得统一而不过度拟物的内核模型。
- Agent 阻塞或失败不阻塞 Service；用户可以继续输入、查看其它 Task、处理 Attention。
- Signal 的持久化与幂等语义把重启恢复变成设计内路径。
- 受管 integration 让多个 Task 的成果自动汇合，同时避免直接操作用户工作树。
- 兼容 facade 允许分波改造，降低一次性重写风险。

### Costs and risks

- Service/Signal/Process 增加领域对象和 migration，必须避免与现有 Task/Execution/Operation 重复建模。
- 至少一次 Signal 会重复投递；所有 handler 必须有幂等键和副作用恢复测试。
- Agent-backed Integration Process 可能产生非确定操作；真正的 ref 更新仍须类型化 API、expected OID 与验证证据控制。
- 持久 Actor 不等于每个 Service 一条循环线程；若按字面 busy-loop 实现，会浪费资源并造成调度复杂度。
- 受管 integration 恢复了 ADR-0066 删除的产品复杂度，但不恢复旧 dev clone / promotion 全套概念。

## Verification requirements

1. 任意 Runtime home 只有一个 0 号 Service；重启后 ID 不变，boot ID 可变。
2. Service 树无环，Task Service 只能是 Project Service 的直接子节点，Process 不能成为父节点。
3. core state 不能通过 metadata API 改写；CAS 失败零部分写入。
4. Signal enqueue 与发送方状态同事务；重复交付只产生一次业务效果；崩溃于 claim/副作用/ack 各点都可恢复。
5. `SIG_P` 只通过 Process 启动 Agent；Service 行上不存在直接 Agent ownership。
6. Process pause/input/terminate 如实映射 Provider 能力，不能把无 ACK 写成成功。
7. 现有 `task` CLI 与新 `service` 投影读取同一 Task 事实，不出现状态分叉。
8. 两个项目可并行集成；同一项目一次只有一个活动集成。expected OID 移动时不推进 ref。
9. integration worktree 归属可核验，不修改用户工作树；冲突/验证失败保留现场。
10. root/project/task intention 可路由；目标不明确产生 Attention；其它 Task 不因一个 Process 等待用户而停止。
11. 所有验收只用 CLI/Runtime 命令面和临时 Git 仓库，不使用桌面控制。

## Related

- `PROJECT_SPEC.md`
- `docs/architecture/service-process-signal.md`
- `docs/architecture/domain-model.md`
- `docs/architecture/scheduler.md`
- `docs/roadmap/mvp.md`
- ADR-0008、0011、0014、0019、0024、0025、0033、0053、0061、0066、0067
