# Service / Process / Agent / Signal 内核

> 层级：L1 · 体量 ≈ 9k 字符 · **何时读**：改内核对象语义、Service 树、Process 控制、Signal 可靠性或 CLI 内核命令面 · 权威来源：`packages/domain/src/**`（纯领域）、`packages/storage/src/service-kernel-store.ts`、`apps/runtime/src/service-kernel.ts`。DDL 见 [`sqlite-schema-kernel.md`](./sqlite-schema-kernel.md)，落地波次见 [`../roadmap/mvp.md`](../roadmap/mvp.md)。

状态：S1–S4 已实现（纯领域 contract、additive storage、持久 Signal dispatcher 与 registry、`service/process/signal/intent` CLI 与兼容 facade），S5–S7 各完成一个最小纵向切片（Process 完成写路径与只读进度、intention 结构化路由、Project/Task 创建写路径，ADR-0071/0072/0073）；**其余仍待完成**。本文区分「目标语义」与「当前实现边界」，不把后续能力写成已交付。

状态：**S1–S4 已实现；S5–S8 各已交付一个纵向切片（见 §4.1/§5.1/§6.2/§6.3/§8.1）；S9–S10 待完成**。决策依据为 [ADR-0070](../decisions/0070-service-process-signal-kernel.md) 与 [ADR-0074](../decisions/0074-managed-integration-ref-and-merge-queue.md)。当前产品为 **schema v38**：领域内核、持久 Service/Process/Signal、dispatcher/registry、CLI 与**受管 integration ref + 持久 merge queue + 独立 Integration Verification** 已可用；Project/Task/Execution 仍由既有表提供 core 权威（Task/Project 创建已收敛到 Service 写路径），**未完成**的是原生 Process Agent 控制、真实模型意图解释、Attention 全局索引对 kernel 级 Intention 的接通、Integration Process/Agent、integration ref 的发布出口与 eligibility 解耦。当前命令见 [`docs/guides/cli/kernel.md`](../guides/cli/kernel.md) 与 [`docs/guides/cli/managed-integration.md`](../guides/cli/managed-integration.md)。

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
- S5 **不**启动 Agent runner、不新增 CLI 命令、不改 schema（仍是 v37；S8 才引入 v38）。

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

**S8 当前实现边界（ADR-0074，schema v38）**：上面第 3–7 步中，**确定性的部分已实现，Agent 的部分没有**。

- ref 与 worktree：`refs/codeestra/integration`（私有命名空间，`git branch` 列不出、默认 push 带不走、checkout 不可能停在它上面）
  与 `<CODEESTRA_HOME>/integration/<project-id>/`（detached）。`project trust` 物化该 ref，缺失时首次需要补建。
- 第 1 步是 `handleMergeRequested` / `project.integration.request` 的前置检查：当前 revision、该 revision 捕获的 result commit、
  以及对该 `(revision, commit)` **PASSED** 的 Task verification run；缺一以具名稳定码拒绝，不入队。
- 第 2 步：`merge_queue_items` 持久入队，`(project, idempotencyKey)` 与 `(task, revision)` 双幂等，
  `MERGING`/`VERIFYING` 上的部分唯一索引让「同一项目一次只有一个活动集成」成为数据库事实。
- **第 3 步不创建 Integration Process**：本轮只做确定性合并（ADR-0074 D05 A）。`run` 直接把 expected OID 读出来并记在 item 上。
- **第 4 步没有 Agent、也没有 Project Git API**：`packages/git/src/managed-integration.ts` 的 `mergeCandidateIntoIntegration`
  在 owned detached worktree 里跑 `git merge --no-ff`；命名的「受控 Git API」按 `ServiceWriteStore` 的先例落在
  `apps/runtime/src/managed-integration-service.ts`。
- 第 5 步：`integration_runs` 记独立证据（候选 commit + policy digest + expected OID + 每命令的 exit/duration/字节数），
  命令在**候选 commit 的独立副本**上跑，与 Task 验证不是同一份证据。
- 第 6 步：`git update-ref refs/codeestra/integration <new> <expected>`——这就是 CAS；ref 被外部移动时不 force，item 落
  `FAILED/INTEGRATION_REF_MOVED`。
- 第 7 步：item `MERGED` + Task integration 投影 `MERGED` 在同一事务里写，然后给 Task Service 发 `TASK_MERGE_SETTLED`
  （handler 核对投影版本，不一致以 `SIGNAL_EFFECT_CONFLICT` 拒绝）。**「唤醒下一项」不是自动的**：下一条保持 `QUEUED`，
  由显式的 `project integration run` 或脚本继续。
- 冲突 → `CONFLICTED`（保留冲突中的 worktree、阻塞该项目队列、`retry` 复位后重排）；验证失败 → `FAILED`（保留候选 ref 与副本）；
  重启 → `RECOVERY_REQUIRED`（不自动重跑）。**不新建 Attention 行**：v38 的 `attention_requests.session_id` 是指向 Agent
  会话的非空外键，与 §8.1 记录的内核级 Intention 澄清是同一边界。
- **不发布**：没有任何命令把该 ref 推到用户 main/release；也不恢复旧 `promotion *`。

### 6.3 Task Service

持有用户可见任务事实。建议继续把状态拆为多个正交维度：

- lifecycle：DRAFT / BLOCKED / READY / RUNNING / WAITING_FOR_USER / EXECUTED / FAILED / CANCELLED / RECOVERY_REQUIRED；
- verification：NOT_RUN / RUNNING / PASSED / FAILED / STALE；
- integration：NOT_REQUESTED / QUEUED / MERGING / VERIFYING / MERGED / CONFLICTED / FAILED。

UI/CLI 可以把组合投影成“等待开始、执行中、等待指示、等待合并、合并中、合并完成”，但底层不压成一个易撒谎的枚举。

**S7 当前实现边界（ADR-0073）**：Task Service 行与 `tasks` 行由同一事务写入，Service 的 id 就是 Task id，
`parent_service_id` 是该项目的 Project Service；`task create` 是唯一创建入口
（`apps/runtime/src/task-service.ts` → `Phase1Database.createTask` → `packages/storage/src/service-write-store.ts`），
所以 `service get <task-id>` 与 `task status <task-id>`（ADR-0076 之后 Task 命令不再点名项目）是同一行的两次读取，lifecycle 与 version 不可能分叉。
上面三个正交维度仍是**目标**：`service get` 只投影 `tasks.state`（lifecycle）与 `tasks.version`，verification 没有进入 core state；
**integration 维度已由 S8 落下**（`task_integration` 投影 + `task integration show`，ADR-0074），但它是从队列 item 派生的独立表，
不是 `tasks` 上的字段，也不与 lifecycle 压成一个枚举。写路径方面只有**创建**（S7）与**集成**（S8）切到 Service；
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

### 8.1 S6 当前实现边界（2026-09-17）

`intent send` 仍只可靠受理 `INTENT_SUBMITTED` `SIG_P` 并幂等创建一个 `CREATED` 的 `INTENTION` Process（返回值
`interpretation: "PENDING_S6"`）；**没有 Agent 在解释自然语言**。已实现的是它的结构化另一半：`INTENTION_RESOLVED`
`SIG_A`（注册到 ROOT / PROJECT / TASK），payload 为 `{processId, expectedVersion, outcome}`，`outcome` 只有三种：

- `ROUTE`：目标必须是该 Process 的 parent Service **可见**的 Service（root 可到直属 PROJECT，PROJECT 可到自己
  的 TASK；其余一律 `INTENTION_TARGET_NOT_VISIBLE`）。成功只落一条 append-only 审计事实 `IntentionRouted`——
  本轮**不**创建新 Process、**不**改任何 Task 规格，真正的执行交给后续波次。
- `TYPED_COMMAND`：白名单只有一个成员 `SESSION_GUIDANCE_RECORD`。命令名是字面量，kernel 绝不运行调用方给的
  命令字符串。它写的是既有 Session Guidance 账本（ADR-0057），**不**产生 TaskRevision；能解析出 target Task 就
  落记录并如实回报 `RECORDED`（`RECORDED` ≠ 模型已读）。与 `ROUTE` **故意不同**：这里不套用子树可见性规则，
  因为 guidance 是会话级事实、不改验收标准（判据只是“目标是一个存在且能解析出 project/task 的 TASK Service”）。
  若该 Task 正被一个 Execution 持有，kernel 派发器没有 provider 会话通道，因此以
  `INTENTION_GUIDANCE_CHANNEL_UNAVAILABLE` 拒绝并指向 `session guide`，而不是伪造一次投递。
- `REQUEST_CLARIFICATION`：Process 进 `WAITING_FOR_USER` 并落一条 `IntentionClarificationRequested` 审计事实
  （含 `requestId`、`question`、`options?`、`correlationId`、`causationId`）。回答仍走**既有 `signal send`**：对同一
  Process 再发一条 `INTENTION_RESOLVED`（新 idempotency key），并把该 `requestId` 放进 Signal 信封的 `causationId`
  （payload 是 `strictObject`，不能再加字段）；对不上就以 `INTENTION_CLARIFICATION_MISMATCH` 拒绝。

**Attention 全局索引对 kernel 级 Intention 尚未接通**：本轮**没有**为澄清建立 `attention_requests` 行。原因是
schema v37/v38 的 `attention_requests.session_id` 是 `NOT NULL REFERENCES agent_sessions(id)`，而 `agent_sessions.execution_id`
又是 `NOT NULL REFERENCES executions(id)`——一个由 `intent send` 建出的 native `INTENTION` Process 根本没有 provider
会话，所以“无会话的 Attention”在 v37 下不可表达。接通它需要一次新的 migration（v38 号已预留给 S8 managed
integration），属未决项，本轮不做、也不得写成已实现。因此澄清是 kernel 事实：`process get` 读到 `WAITING_FOR_USER`、
`events list` 读到 `IntentionClarificationRequested`、`signal get` 的 receipt effect 读到 `requestId` 与
`attentionIndex: "NOT_CONNECTED"`，而 `attention list <project-id>` 对它**不会**出现任何行。

`CREATE_TASK` **明确不在本轮**：`intentionOutcomeSchema` 没有这个成员（创建 Task 是 S7 的 Project/Task Service
写路径）。它仍被**具名拒绝**——`INTENTION_CREATE_TASK_UNSUPPORTED` 立即进入 `DEAD_LETTER`，不动 Process、不落
审计、不写 receipt；绝不被静默丢弃。

Process 状态迁移走既有 FSM：`CREATED → STARTING → RUNNING → SUCCEEDED`（`REQUEST_CLARIFICATION` 收在
`WAITING_FOR_USER`，回答时 `WAITING_FOR_USER → RUNNING → SUCCEEDED`）。注意 lane 契约写的 `CREATED → RUNNING`
在现成 FSM 里没有这条边，因此走 `STARTING`（见 ADR-0072 D03）。

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
