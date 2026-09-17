# Service / Process / Agent / Signal 内核

> 层级：L1 · 体量 ≈ 9k 字符 · **何时读**：改内核对象语义、Service 树、Process 控制、Signal 可靠性或 CLI 内核命令面 · 权威来源：`packages/domain/src/**`（纯领域）、`packages/storage/src/service-kernel-store.ts`、`apps/runtime/src/service-kernel.ts`。DDL 见 [`sqlite-schema-kernel.md`](./sqlite-schema-kernel.md)，落地波次见 [`../roadmap/mvp.md`](../roadmap/mvp.md)。

状态：S1–S4 已实现（纯领域 contract、additive storage、持久 Signal dispatcher 与 registry、`service/process/signal/intent` CLI 与兼容 facade）。**S5–S10 仍是目标**；本文区分「目标语义」与「S4 当前的实现边界」，不把后续能力写成已交付。

状态：**S1–S4 已实现，S5–S10 待完成**。决策依据为 [ADR-0070](../decisions/0070-service-process-signal-kernel.md)。当前产品为 schema v37：领域内核、持久 Service/Process/Signal、dispatcher/registry 与 CLI 已可用；Project/Task/Execution 仍由既有表提供 core 权威，原生 Process 控制、intention 解释、写路径切换与 managed integration 不提前声称。当前命令见 [`docs/guides/cli/kernel.md`](../guides/cli/kernel.md)。

## 1. 为什么需要这层内核

Codeestra 的目标是 AI 的操作系统。它不替代宿主操作系统，而是在宿主之上管理 AI 软件里的四类事实：

- 谁长期提供服务、保存状态并随时响应；
- 谁为一个有限目标监督 Agent，何时开始、阻塞、恢复和结束；
- Agent 通过什么受控接口读取状态、执行程序并把结果交回；
- 用户、程序与 Agent 的输入如何可靠路由，不因 Runtime 重启丢失。

对应的最小内核抽象是 Service、Process、Agent、Signal。Task 仍然是 Scheduler 的工作单元；“Service-first 内核”不等于“调度所有 Service”。

## 2. 拓扑

```text
CodeestraService #0
├── SchedulerService                  # 系统 Service
├── AttentionService                  # 系统 Service
└── ProjectService P1                 # 业务 Service
    ├── TaskService T1                # Scheduler 调度单元
    │   ├── DevelopmentProcess D1     # Agent supervisor
    │   │   └── AgentSession / incarnation
    │   └── ...历史 Process
    ├── TaskService T2
    └── IntegrationProcess I1         # 复杂合并时的 Agent supervisor
```

约束：

1. Service 组成有根树；每个非 root Service 恰有一个 parent Service。
2. Task Service 只能是 Project Service 的直接子 Service，Task 之间不嵌套。
3. Process 挂在一个 Service 下，但不能有子 Service。
4. Service 不直接拥有 Agent；AgentSession 必须属于一个 Process。
5. Worktree、branch、verification copy 是资源，不是 Service。
6. DAG dependency 是 Task 间关系，不用 Service 树表达。

## 3. Service：持久 Actor，而非 OS 进程

Service 的“持续运行”表示：它在 Runtime 存活期间始终可被寻址，Runtime 重启后可从持久状态恢复。它不是一条永久 busy-loop，也不是一个专属线程。

最小记录：

```ts
type ServiceRecord = {
  id: string;
  kind: "ROOT" | "SCHEDULER" | "ATTENTION" | "PROJECT" | "TASK";
  parentServiceId: string | null;
  lifecycle: "ACTIVE" | "PAUSED" | "RECOVERY_REQUIRED" | "RETIRED";
  stateVersion: number;
  contractVersion: number;
  coreStateRef: string;
  inboxCursor: number;
  createdAt: number;
  updatedAt: number;
};
```

S1 已冻结对应纯领域类型；v37 持久记录另含 Project/Task 唯一投影列。S2 按要求把 Project/Task 的现有事实映射进来，没有复制第二套权威 core state。

### 3.1 状态

- core state：每个 kind 有自己的 schema 与 reducer；状态变化要求 expected version、actor、reason。
- metadata：`namespace/key` → JSON，适合标签、Agent 辅助信息与未来扩展；有大小和类型上限。
- metadata 不参与核心 guard。若某键开始决定调度、Git ref 或权限，它必须升级为 core 字段并立 ADR/migration。
- 所有写入产生审计事实；查询可以统一，修改必须受 contract 约束。

### 3.2 Contract

每个 Service kind 发布：

- commands：会改变状态或触发副作用；
- queries：只读；
- acceptedSignals：允许的 Signal kind 与 payload schema；
- emittedSignals：可能发出的事实；
- childKinds：允许创建的子 Service / Process 类型；
- agentContext：交给 Process 的 API 摘要与最小上下文。

CLI 是 contract 的稳定映射，不从数据库内容动态生成任意命令。

### 3.3 S4 当前实现边界

Runtime bootstrap 建立稳定 root/Scheduler/Attention Service，并按需 reconcile Project/Task/Execution 投影。每个 kind 的
静态 registry 只接受已注册 `(kind, subtype, version)`；当前可执行 contract 是 metadata `SIG_A` 与 intention `SIG_P`。
claim lease 为 30 秒，自动退避为 1/5/30/120/300 秒，五次自动重试后的第六次失败进入 dead-letter；周期 reconcile 是一个 Runtime timer，
不是每 Service busy-loop。

## 4. Process：只监督 Agent

Process 不是普通程序的同义词。它是一个短期、目标有界、允许阻塞的 Agent supervisor。

```text
CREATED → STARTING → RUNNING ↔ WAITING_FOR_USER
                       ↓
             PAUSING → PAUSED → RUNNING
                       ↓
        SUCCEEDED | FAILED | CANCELLED | RECOVERY_REQUIRED
```

职责：

- 固定任务书、parent Service、Agent 配置、上下文快照与预算；
- 启动并观察 AgentSession；
- 统计 token、成本、轮次、工具活动与最后进度；
- 暂停、终止、追加输入或建立 successor；
- 把结构化提问转给 Attention Service；
- 以 Signal 向 parent Service 报告完成、失败、等待或恢复要求。

现有对象的迁移关系：

| 现有对象 | 目标关系 |
|---|---|
| Execution | Process 的权威执行事实来源；迁移期一一投影 |
| AgentSession | Process 的 provider conversation / 当前会话 |
| Session incarnation | Agent 的 OS 进程代与 writer 身份 |
| Operation | Service API 的确定性副作用记录，不等于 Process |
| AttentionRequest | Process 或 Service 发出的用户输入请求 |

普通程序的执行路径：

```text
SIG_A → Service handler → Operation → Git / verification / filesystem program
```

Agent 的执行路径：

```text
SIG_P → Service creates Process → Process starts Agent
     → Agent calls Service APIs → SIG_A / Operation
```

因此程序与 Agent 统一在“都只能通过 Service contract 影响系统”，而不是强行统一成同一种运行实体。

### 4.1 S5 当前实现边界（Execution → Process 与控制面）

`processes` 的写路径现在是类型化的：`transitionProcess`（CAS `processes.version`、校验 domain FSM、写
`ProcessStateChanged` 审计事件）与 `completeProcess`（消费已 CLAIMED 的 `PROCESS_COMPLETED` `SIG_A`，
同事务写 receipt 与 ACK）。两者都**零部分应用**：先校验状态源、版本与迁移合法性，再做 CAS 更新；
被拒绝时数据库里没有新行、新事件或新版本（决策与原因见 [ADR-0071](../decisions/0071-process-completion-write-path.md)）。

- **单一 writer**：`status_source='EXECUTION'` 的 Process（今天所有 `DEVELOPMENT` Process 都由 Execution
  投影而来）拒绝类型化写与完成，以 `PROCESS_STATUS_SOURCE_READONLY` 拒绝；它的状态与 `version` 由
  Execution 权威提供（`version` 即 `executions.version`）。
- **终态不可复活**：`SUCCEEDED|FAILED|CANCELLED` 由 domain 的 `PROCESS_TERMINAL` 拒绝；后继只能由新
  Execution 投影成新 Process（`id = execution.id`，`SUPERSEDED` 投影为终态）。
- **同一 Task 至多一个非终态 Process**：由 `one_held_execution` 唯一索引提供，并在每次 reconcile 后用
  domain 的 `assertProcessSuccession` 校验投影没有破坏它，否则以 `PROCESS_PREDECESSOR_ACTIVE` 失败。
- **`process get|list` 只读进度**：`progress.lastProgressAt` 是该 Process 最近被记录的事实时间；
  `budgetKnown` 表示 `processes.budget_json` 是否已记录（v37 下恒为 `false`）；`tokenUsage`、`costUsd`、
  `toolCallCount` 在 v37 没有对应列，**恒为 `null`（UNAVAILABLE）**，不由 session、消息数或时钟推算。
- **原生 Process 仍需 Execution 才能被控制**：`process input|pause|resume|terminate` 对没有 Execution 的
  Process 继续以 `PROCESS_CONTROL_UNAVAILABLE` 拒绝；原生 Process 的控制 API 仍属后续波次。
- S5 **不**启动 Agent runner、不新增 CLI 命令、不改 schema（仍是 v37）。

## 5. Signal：可靠路由信封

### 5.1 类型

- `SIG_A`：调用明确 API。payload 是版本化结构数据；不需要 LLM 理解。
- `SIG_P`：表达意图。payload 引用用户原文；目标 Service 创建 Process 让 Agent 解释并调用 API。

业务 subtype 仍需命名，例如：

```text
TASK_CREATE_REQUESTED
TASK_EXECUTION_COMPLETED
TASK_MERGE_REQUESTED
PROCESS_WAITING_FOR_USER
PROCESS_COMPLETED
INTEGRATION_SLOT_AVAILABLE
ATTENTION_RESOLVED
```

`SIG_A` / `SIG_P` 是传递语义，不替代具体 subtype。`PROCESS_COMPLETED` 是第一个由 Process 完成事实定义的
`SIG_A` subtype（S5）：payload 为 `{processId, outcome, expectedVersion, summary}`，只被 ROOT / PROJECT /
TASK 接受（Process 的 parent Service 必为三者之一）。`(targetServiceId, idempotencyKey)` 幂等；重发返回同一
receipt 且不二次改状态。版本过期、parent 不匹配、状态源只读与终态都是**永久失败**：以
`retryable=false` 立即 dead-letter 并保留稳定码，而不是自动重试五次——payload 不会因为等待而变合法。

### 5.2 信封与链路

```ts
type SignalEnvelope = {
  id: string;
  kind: "SIG_A" | "SIG_P";
  subtype: string;
  sourceServiceId?: string;
  sourceProcessId?: string;
  targetServiceId: string;
  contractVersion: number;
  idempotencyKey: string;
  correlationId: string;
  causationId?: string;
  priority: number;
  payloadRef: string;
  createdAt: number;
};
```

`correlationId` 串起一次用户意图到多个子动作；`causationId` 指向直接诱因。Signal 正文可单独存储并受大小/保密规则约束，event 只保存必要摘要和 ref。

### 5.3 可靠性

```text
PENDING → CLAIMED → ACKED
              ├──→ RETRYABLE
              ├──→ DEAD_LETTER
              └──→ RECOVERY_REQUIRED
```

- enqueue 与发送方业务写入同事务；
- claim 用租约、Runtime boot identity 与 deadline；
- handler 先查幂等回执，再执行；
- 外部副作用前写 Operation，之后按真实事实收口；
- Runtime 崩溃后过期 claim 回到 reconcile，不直接重放不确定副作用；
- dead-letter 只表示自动消费停止，不能丢历史；必要时建立 Attention。

## 6. 三类关键 Service

### 6.1 Root / Codeestra Service

持有全局配置引用、Service registry、Scheduler、Attention、Process 索引与项目目录。接收全局 intention 后创建意图分析 Process。该 Process 可以：

- 路由到 Project / Task Service；
- 调用全局设置 API；
- 在目标不明确时建立 Attention；
- 拆分为多个 Task，但必须遵守 Minimum Useful Decomposition。

### 6.2 Project Service

持有项目身份、受管 integration ref/worktree、项目知识引用、Task 子节点与 merge queue。

收到 `TASK_MERGE_REQUESTED`：

1. 校验 Task result / revision / verification；
2. 持久入队；
3. 若项目没有活动集成，固定 expected integration OID 并创建 Integration Process；
4. Process 的 Agent 通过 Project Git API 在独立 integration workspace 工作；
5. 运行 Integration Verification；
6. expected OID 仍一致时 CAS 推进 ref；
7. 发 `TASK_MERGED`，再唤醒下一项。

同一项目串行，项目之间可并行。冲突或失败保留 integration workspace，不阻塞 Project Service 接收其它查询和 intention。

### 6.3 Task Service

持有用户可见任务事实。建议继续把状态拆为多个正交维度：

- lifecycle：DRAFT / BLOCKED / READY / RUNNING / WAITING_FOR_USER / EXECUTED / FAILED / CANCELLED / RECOVERY_REQUIRED；
- verification：NOT_RUN / RUNNING / PASSED / FAILED / STALE；
- integration：NOT_REQUESTED / QUEUED / MERGING / VERIFYING / MERGED / CONFLICTED / FAILED。

UI/CLI 可以把组合投影成“等待开始、执行中、等待指示、等待合并、合并中、合并完成”，但底层不压成一个易撒谎的枚举。

**S7 当前实现边界（ADR-0073）**：Task Service 行与 `tasks` 行由同一事务写入，Service 的 id 就是 Task id，
`parent_service_id` 是该项目的 Project Service；`task create` 是唯一创建入口
（`apps/runtime/src/task-service.ts` → `Phase1Database.createTask` → `packages/storage/src/service-write-store.ts`），
所以 `service get <task-id>` 与 `task status <project> <task-id>` 是同一行的两次读取，lifecycle 与 version 不可能分叉。
上面三个正交维度仍是**目标**：今天 `service get` 只投影 `tasks.state`（lifecycle）与 `tasks.version`，
verification 与 integration 两个维度还没有进入 core state。本轮只切了**创建**写路径：
`task submit` / revision / 验证 / 取消 / 归档仍走既有表与既有路径。

## 7. Scheduler 边界

Scheduler 管准入与计算资源，不负责理解意图，也不把 DAG 逻辑埋在排序循环里。

输入：

```ts
type TaskEligibility = {
  taskServiceId: string;
  revisionId: string;
  eligible: boolean;
  reasons: Array<"DEPENDENCY" | "CONFLICT" | "REVISION" | "CONTROL">;
  evidenceVersion: number;
};
```

Task/Project 领域服务计算 eligibility；Scheduler 只做：

1. 过滤 eligible；
2. priority desc → createdAt asc → id asc；
3. 检查 Runtime 全局容量与暂停屏障；
4. 原子预留；
5. 请求 Task Service 创建 Development Process。

提交前在同一事务重验 eligibility version，避免检查后条件变化。

**S7 当前实现边界（ADR-0073）**：Scheduler 仍按既有调度引擎读写 `tasks` 行，本轮只把 **Project/Task 的创建**写路径
收敛到 Project/Task Service handler。`TaskEligibility` 类型、领域服务计算 eligibility、以及第 5 步
“请求 Task Service 创建 Development Process”都还没实现，Scheduler 也不直接拼装 Agent start。
已经改变的是：Task Service 现在真实存在且是 Task 事实的同一个行（`services.task_id` = `tasks.id`），
所以 Scheduler 将来要请求的那个 handler 已经有地址。

## 8. Intention 与 Attention

用户也是系统中的智能体，但不需要理解底层 Signal：

```text
codeestra intent send "把支付模块的错误处理统一掉"
codeestra intent send --project P "把测试也补上"
codeestra intent send --task T "不要新增依赖，沿用现有 helper"
```

这是目标命令示意，不是当前已实现命令。

- root intention：创建路由 Process；
- project intention：在该项目上下文解释，可创建/修订 Task；
- task intention：默认作为 guidance 还是 revision 必须由类型化结果明确，不能仅靠自然语言静默改验收标准；
- 任意 Service 的结构化问题进入 Attention Service 的全局索引；回答后 Signal 路由回原 Service/Process；
- 一个 Task 等用户时，其它 Task 和 Service 继续运行。

## 9. CLI 目标面与当前兼容面

目标内核命令：

```text
service list|get|tree|state get|state set
process list|get|input|pause|resume|terminate
signal send|list|get|retry
intent send
```

现有命令继续保留并映射：

| 现有命令 | 目标内核 |
|---|---|
| `project *` | Project Service facade |
| `task *` | Task Service facade |
| `session *` | Process 下的 AgentSession facade |
| `attention *` | Attention Service facade |
| `scheduler *` | Scheduler Service facade |

通用命令不绕过类型化 facade：例如 `service state set` 不能直接推进 Task lifecycle，`signal send SIG_A` 也必须通过目标 contract 验证。

## 10. 增量落地顺序

1. 纯 domain contract 与 ADR 术语；
2. additive schema 与只读 projection；
3. Signal dispatcher / Service registry；
4. 内核 CLI；
5. Project/Task facade 接入同一事实；
6. Execution → Process projection 与控制；
7. intention / Attention 路由；
8. 受管 integration；
9. 切换权威写路径、删除临时兼容层。

详细任务、依赖和验收见 [MVP Roadmap](../roadmap/mvp.md)。

## 11. 明确不做

- 不把每个 Service 做成 OS 进程或线程；
- 不以消息中间件、微服务、Kubernetes 实现本机 Actor；
- 不承诺跨 SQLite/Git/Provider exactly-once；
- 不让 arbitrary metadata 绕过状态机；
- 不让 Agent 直接写 SQLite 或未经 Project Service API 修改受管 ref；
- 不恢复旧 `promotion *` 全套语义；integration ref 如何发布到 release/main 另议；
- 不新增 RBAC、沙箱或确认门禁；
- 不恢复 Web UI，也不使用桌面自动化验收。
