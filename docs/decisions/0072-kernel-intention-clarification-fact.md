# ADR-0072：kernel 级 Intention 的澄清是内核事实，而不是 Attention 行

Status：Accepted（协调者 2026-09-17 明确选择 A；本 ADR 记录本轮 S6 lane 的真实决策与其代价）。**本 ADR 不改变 schema**（仍为 v37），也不恢复任何被 ADR-0066 删除的能力。

**关联**：ADR-0070（Service/Process/Signal 内核与 §D08 Intention/Attention）、ADR-0014（结构化提问通道：一份问卷 = 一个 provider dialog = 一条 `QUESTION` Attention = 一次 answer Operation）、ADR-0057（Session Guidance 是会话级事实）、ADR-0043（散文提问升级为既有形状的 Attention）、ADR-0051（「模型已读」不可观测）。

## Context

S6 要让 `intent send` 建出的 `INTENTION` Process 能被**结构化 outcome** 收口。S6 lane 契约 §3 规定
`INTENTION_RESOLVED` 的三种 outcome，其中 `REQUEST_CLARIFICATION` 要求「建立 `QUESTION` Attention，Process 进
`WAITING_FOR_USER`，并把 `correlationId`/`causationId` 记录到可查询的事实里」。

实现时发现这条要求在 v37 schema 下**不可表达**：

1. `attention_requests.session_id` 是 `NOT NULL REFERENCES agent_sessions(id)`（`migration.ts`，v1 起）；
2. `agent_sessions.execution_id` 是 `NOT NULL UNIQUE REFERENCES executions(id)`；
3. `intent send` 建出的 `INTENTION` Process 是 `status_source='PROCESS'`、**没有 Execution、也没有 Session**；
4. 既有 `attention list <project-id>` 的读路径是
   `attention_requests → agent_sessions → executions → tasks → project_trusts` 的连接；
5. 既有 `attention resolve`（无 provider dialog 的那条路）还要求 `tasks.state='WAITING_FOR_USER'` 并把该 Task 改回
   `RUNNING`。

也就是说，v37 下**不可能**存在「没有 provider 会话的 Attention」。同时 lane 契约 §0.2 禁止本 lane 改
migration/schema，§0.1 禁止新增 CLI 命令或 Runtime 命令 variant，`attention list` 的跨项目 root 视图也不在本轮。

## Options

- **A（已选）本轮不接 Attention 索引**：澄清落成 kernel 权威事实（Process `WAITING_FOR_USER` + 一条 append-only
  `IntentionClarificationRequested` 审计事实 + Signal receipt effect），回答仍走既有 `signal send`。`attention list`
  对它不出现任何行，文档与交付说明如实写明。
- **B 复用目标 Task 的既有 Session**：仅当 Intention Process 的 parent 是 TASK 且该 Task 已投影出 Execution/Session
  时，把 `attention_requests` 行挂到那个会话上。被否：这会把一条**没有 provider dialog** 的 Attention 挂到另一个
  Task 的会话上，直接违反 ADR-0014 的等价关系（一份问卷 = 一个 dialog = 一条 Attention = 一次 answer Operation），
  且 `attention answer` 会尝试把回答投给一个并没在提问的 provider。
- **C 打开 v38 migration**：把 `attention_requests` 扩成可持有 kernel 级、无 provider 会话的 Attention（例如
  `session_id` 可空 + `source_process_id`/`source_service_id` 关联列），`attention list` 按 Service 树归集，
  `answer`/`resolve` 对无会话 Attention 用稳定码拒绝。被否（本轮）：这是不可逆 migration 与跨 lane 协调
  （AGENTS.md 要求先获明确决策），而 v38 号已预留给 S8 managed integration。

## Decision

### D01 采纳 A：澄清是内核事实

`REQUEST_CLARIFICATION` 的成功事实是：

- Process `CREATED → STARTING → RUNNING → WAITING_FOR_USER`（见 D03）；
- 一条 append-only 审计事实 `IntentionClarificationRequested`，`aggregate_type='Process'`、`aggregate_id=processId`，
  payload 至少含 `processId`、`requestId`（即澄清 id）、`targetServiceId`、`question`、`options?`、`correlationId`、
  `causationId`；
- Signal receipt 的 effect 含 `requestId`、`question`、`options?`，并显式带
  `attentionIndex: "NOT_CONNECTED"`，让客户端不会去等一条不可能存在的 `attention list` 行。

回答**不新增命令**：对同一个 Process 再发一条 `INTENTION_RESOLVED`（新 idempotency key）。冻结的 payload 是
`strictObject`，无法再挂字段，因此「回答的是哪个问题」放在 Signal 信封的 `causationId`：它必须等于该 Process 上一次
未收口澄清的 `requestId`，否则以 `INTENTION_CLARIFICATION_MISMATCH` 拒绝；`WAITING_FOR_USER` 但没有任何澄清事实时
是 `INTENTION_CLARIFICATION_NOT_FOUND`；已有未收口澄清时再提新问题是 `INTENTION_CLARIFICATION_OPEN`。回答成功时
额外落一条 `IntentionClarificationAnswered` 审计事实，并 `WAITING_FOR_USER → RUNNING → SUCCEEDED`。

**未决项（不给默认值）**：把一个 kernel 级澄清接进 Attention 全局索引需要一次新 schema 波次（`v38` 号已预留给 S8）。
在那之前，任何文档、UI 或交付说明都不得声称 kernel 级 Intention 的澄清会出现在 `attention list`，也不得声称
`attention answer` 能回答它。

### D02 kernel 派发器只能拿到 `ServiceKernelStore`，因此用「同一文件的第二个门面」复用既有 guidance 写路径

lane 契约把 `apps/runtime/src/main.ts` 划为**本 lane 不改**，而 `SignalDispatcher` 是在 `main.ts` 里用
`{ store, contracts, bootId }` 构造的。于是 `INTENTION_RESOLVED` 的 handler 拿不到 main.ts 里的
`SessionGuidanceService`（它需要 `Phase1Database`、`AdapterRegistry` 与全局屏障状态）。

为了让 `TYPED_COMMAND` 走**既有的** guidance 写路径而不是复制一遍它的 SQL/Hash/账本/事件，`IntentionService` 的
guidance 端口在首次用到时按 kernel store 的**同一个 `runtime.sqlite` 路径**再开一个 `Phase1Database` 门面（
`.sqlite.filename` 在 Bun 里可读；`:memory:` 或不可用时以 `INTENTION_GUIDANCE_UNAVAILABLE` 诚实拒绝）。这是
**同一份 schema、同一份写路径**的第二个连接，不是第二套权威，且它是惰性的：从不解析 intention 的 Runtime 不会开它。

代价与边界（如实记录）：

- 这条路径**不向 provider 投递**。它没有 Adapter registry 与全局屏障状态，所以当目标 Task 正被 Execution 持有时
  以 `INTENTION_GUIDANCE_CHANNEL_UNAVAILABLE` 拒绝并指向 `session guide`，而不是伪造一次投递或留下一个无法收口的
  `IN_FLIGHT` attempt（ADR-0057/0061 D08）。
- 一旦 `main.ts` 被允许把 `SessionGuidanceService` 交给内核派发器（或 S7 把写路径统一），这个门面应当被删除，
  改为注入既有实例。它是 lane 边界造成的临时接线，**不是**目标架构。

跨 store 的原子性不被假定：guidance 账本与 Process 状态在两个事务里。写入顺序是「先 guidance，后 kernel 一次
原子写（receipt + Process 迁移 + 审计事实）」，因为 guidance 写以 Signal id 作 commandId 幂等（`executeCommand`
的既有 receipt）：若第二次写失败并重试，guidance 收敛到同一行而不会重复，然后 Process 状态被应用；反之若先写
Process 再写 guidance，一个失败会留下「Process 已终态但没有 guidance」这种更不可恢复的状态。

### D03 FSM 里没有 `CREATED → RUNNING`，因此计划走 `STARTING`

lane 契约 §3.2 写「`CREATED|RUNNING → RUNNING → SUCCEEDED`」，但本 lane 只读的现成 Process FSM
（`packages/domain/src/service-kernel.ts`）里 `CREATED` 的合法后继只有 `STARTING`/`CANCELLED`/`FAILED`。因为
FSM 对本 lane 只读，计划走**合法**路径：`CREATED → STARTING → RUNNING → <SUCCEEDED|WAITING_FOR_USER>`；已经
`RUNNING` 的 Process 直接落 outcome；回答澄清时 `WAITING_FOR_USER → RUNNING → <终态>`。版本链按步递增，任一步
CAS 失败由 `transitionProcess` 以 `PROCESS_VERSION_CONFLICT` 拒绝。

### D04 `CREATE_TASK` 具名拒绝，而不是「schema 里没有 = 请求消失」

`intentionOutcomeSchema` 只有三个成员（创建 Task 是 S7 的 Project/Task Service 写路径）。但契约同时要求
「稳定码 + 不得静默丢弃」，而如果让 registry 用 `INVALID_SIGNAL_PAYLOAD` 拒绝，调用方会把它读成「JSON 坏了」。
因此 `packages/contracts/src/intention.ts` 另外导出一个**只用于具名拒绝**的
`intentionCreateTaskRefusalSchema`（只匹配 `outcome.kind === 'CREATE_TASK'`），与冻结的 payload schema 组成 union
作为该 subtype 注册的 payload 契约；handler 命中该分支时以 `INTENTION_CREATE_TASK_UNSUPPORTED` **立即**
`DEAD_LETTER`（`retryable=false`，不走 6 次退避），不动 Process、不落审计、不写 receipt。冻结的三成员
`intentionOutcomeSchema` 不变，该成员不携带任何语义。

### D05 `TYPED_COMMAND` 与 `ROUTE` 的可见性规则故意不同

`ROUTE` 只允许路由到 parent 可见的子树（root→直属 PROJECT，PROJECT→自己的 TASK），其余
`INTENTION_TARGET_NOT_VISIBLE`。`TYPED_COMMAND` **不**套用这条规则：白名单里唯一的命令写的是会话级事实
（ADR-0057），不改任何 Task 验收标准，因此判据只是「`targetTaskServiceId` 是一个存在且能解析出 project/task 的
TASK Service」。这个差异是**刻意的**，写进文档，避免读者以为漏了校验。

### D06 Signal 目标 Service 必须拥有该 Process

handler 在解析前先校验 `process.parentServiceId === signal.targetServiceId`，否则
`PROCESS_PARENT_MISMATCH`（与 S5 `completeProcess` 同一稳定码）。没有这条守卫，一个 Project 的 Signal 就能推进
另一个 Project 的 intention Process——契约的 §3 没有写这条，但它是「检查路径归属」类正确性守卫，不是新增门禁。

## Consequences

### Positive

- v37 下 S6 的核心纵向切片可交付并被验证：结构化 outcome 能推进 Process、留下审计与 receipt、按幂等键收敛，且
  **不需要**任何 schema 变更或新命令。
- 澄清、回答与路由的链路完全可由既有 CLI 驱动（`signal send` / `signal get` / `process get` / `events list` /
  `session guidance list`），没有「只有源码里有」的能力面。
- 「无会话的 Attention 在 v37 不可表达」被写成显式未决项，而不是被一个语义错误的行掩盖。

### Costs and risks

- kernel 级 Intention 的澄清**不在** `attention list` 里：用户必须从 `process get` / `events list` / `signal get`
  看到它；在 Attention 索引接通前，UI 若只读 `attention list` 会看不到这类等待。
- `history`：收到 `INTENTION_RESOLVED` 的 Service 写 Process、审计与 receipt 需要的是同一事务；这是本 lane 自己实现
  的存储端口（`IntentionStore`），其中 `transitionProcess` 会在 S5 方法存在时**委托**它，否则做等价的本地 CAS。
  这是一段明确的**过渡代码**，S5 合并后自动走委托分支。
- D02 的第二个 `Phase1Database` 门面是 lane 边界的产物，应在接线可改后删除。
- `attention answer` 仍然只对 provider dialog 有意义，绝不能被当成 kernel 澄清的回答路径。

## Verification

- `packages/domain/test/intention-routing.test.ts`：outcome 形状、`CREATE_TASK` 具名拒绝、可解析性、`ROUTE`
  可见性、澄清回答匹配、迁移计划与现成 FSM 的一致性。
- `apps/runtime/test/intention-service.test.ts`：以 fake kernel port 证明路由逻辑——成功/拒绝各自的稳定码、审计事实、
  receipt、幂等只应用一次、一次解析内任一步失败则零部分应用、`PROCESS_PARENT_MISMATCH`、
  `INTENTION_GUIDANCE_CHANNEL_UNAVAILABLE`。
- `apps/runtime/test/cli-intention.test.ts`：真实 CLI + 临时 Runtime——`intent send` → `signal send INTENTION_RESOLVED`
  → `process get` 终态与 `IntentionRouted` 审计；`REQUEST_CLARIFICATION` → `WAITING_FOR_USER` +
  `IntentionClarificationRequested` + `attention list` 为空（本轮边界）+ 回答匹配/不匹配；`TYPED_COMMAND` →
  `session guidance list` 出现该条且 `modelAcknowledgement: UNSUPPORTED`；`CREATE_TASK` 具名 `DEAD_LETTER` 且
  Process 不动。
- `bun run typecheck`、`bun test apps/runtime/test/cli-service-kernel.test.ts`（既有断言不变）。
- **未验证**：真实模型驱动的意图分析（`intent send` 的 `PENDING_S6` 仍成立）；Attention 索引接通；provider 会话中
  的 guidance 投递（D02 路径拒绝该情形）。

## 关联

- [`0070-service-process-signal-kernel.md`](0070-service-process-signal-kernel.md)：§D08 Intention 与 Attention 的目标语义。
- [`0014-agent-structured-question-channel.md`](0014-agent-structured-question-channel.md)：Attention 与 provider dialog 的等价关系（B 被否的依据）。
- [`0057-session-guidance-channel-and-fact-layering.md`](0057-session-guidance-channel-and-fact-layering.md)：guidance 是会话级事实，「已记录」≠「模型已读」。
- [`../roadmap/lane-contracts-s5-s7.md`](../roadmap/lane-contracts-s5-s7.md)：本轮冻结的三条 lane 契约（§3 是 S6 任务书）。
- [`../architecture/service-process-signal.md`](../architecture/service-process-signal.md) §8.1：本决策的架构说明。
- [`../guides/cli/kernel.md`](../guides/cli/kernel.md)：用户可见的命令面说明。
