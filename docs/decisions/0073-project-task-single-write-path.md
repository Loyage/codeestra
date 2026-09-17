# ADR-0073：Project / Task Service 成为单一写路径（S7）

Status：**Accepted**（lane G-ProjectTask 的 S7 实现记录，2026-09-17）。其中 **D03** 与 **D04** 是对 lane 契约
`docs/roadmap/lane-contracts-s5-s7.md` §4 冻结接口的两处取舍：**协调者已于 2026-09-17 合并时确认接受**
（D04 的加法字段用于保住既有用户可见行为；D03 的 metadata 只是标记、权威事实仍是 `services` 行，且不参与任何 guard）。其余各条按 ADR-0070 既有方向实施。

**Amends** ADR-0070 D02/D06/D10：Service 树与 Task Service 已经不只是只读投影，Project/Task 的**创建**写路径
已经由 Service handler 拥有；其余（submit/revision/验证/取消/归档、eligibility、原生 Process）仍按 ADR-0070 的波次。

**Supersedes** 无。ADR-0035 的「已实现的事件名永不重命名」与「兼容期事件日志是既有兼容面」在本 ADR 中被当作硬约束（见 D03）。

## Context

schema v37（ADR-0070 S1–S4）把 `services`/`processes`/`signals` 建成 additive 投影，但写路径仍是旧的：

- `Phase1Database.trustProject` 写 `projects` 行，`Phase1Database.createTask` 写 `tasks`/`task_revisions` 行，
  两者的 `services` 行只由 `ServiceKernelStore.reconcileProjections` 在**下一次读**时补写；
- 因此「同一事实有两个 writer」，中间崩溃会留下有 `tasks` 行却没有 Service 的库（或反之），
  “这条 command 的权威 handler 是谁”没有静态答案，`service tree` 与 `task list` 也可能读到不同步的两个面。

S7 的最小纵向切片是：**至少把 Task 创建与 Project 注册收敛到一个权威 handler**，旧 CLI 与 Service 查询读同一事实，
并留下可核验的「一条 command 只有一个权威 handler」证据。lane 契约同时冻结了
`ServiceWriteStore.ensureProjectService` / `createTaskService` 与 `TaskService.create` 的签名。

## Options

### 写路径位置

1. **`ServiceWriteStore` 作为唯一 SQL writer，`Phase1Database` 保留命令回执与 `intents` 行。**
   旧命令面（`task create`、`project trust`）保持原有的事务语义与错误码，新逻辑放在新文件里。
2. 让 `TaskService`（Runtime 层）自己写 SQL 与事务。被否：Runtime 层会重新掌握数据库细节，
   且 `executeCommand` 的幂等回执是 `Phase1Database` 的私有能力，复制一份就是第二个 writer。
3. 保留旧 writer，只加「单一 handler」的断言。被否：断言会变成一句空话。

### 项目注册事实怎么留痕

1. **写一条 `domain_events`（`ProjectServiceCreated`）。** 被否，见 D03：`domain_events` 是一个全局
   `AUTOINCREMENT` 游标日志，插一行会改变已连接订阅者看到的游标编号，而
   `apps/runtime/test/event-subscription-ipc.test.ts` 断言 `project trust` 之后 Task 创建的事件正好是
   cursor 1/2 的 `IntentRecorded`/`TaskCreated`。S7 不得renumber 既有兼容事件流。
2. **不写任何痕迹。** 被否：冻结签名给了 `eventId`，而「这个 Service 是由哪次注册建的」是可核验的事实。
3. **写 `service_metadata` 的一条 namespaced 事实（`kernel/registered`）。** 采纳：它是 ADR-0070 D03 明确的
   metadata 扩展区，可见（`service get`）、幂等（`ON CONFLICT DO NOTHING`）、且不碰事件游标。

### 冻结签名的完备性

1. **只用冻结字段实现。** 不可行：`createTaskService` 的冻结字段里没有 `intents` 行 id、命令 id、actor 与
   完整的功能声明列表，而这些是首 revision、`IntentRecorded`/`TaskCreated` 两个事件与
   「`task create --feature` 可重复」已经存在的产品事实；`TaskService.create` 同理需要请求里的 `commandId`
   才能在重放时返回同一个 Task。
2. **加法字段（保留全部冻结字段与语义，新增可选/必需字段并写明理由）。** 采纳，见 D04。

## Decision

### D01 层次与所有权

- `packages/storage/src/service-write-store.ts`（`ServiceWriteStore`）是 `INSERT INTO projects` 与
  `INSERT INTO tasks` 的**唯一** writer，也是 `services` 里 PROJECT/TASK 行的唯一 writer。
  每个事实一次事务：项目行 + PROJECT Service；`tasks` 行 + 首 revision + TASK Service + 两个事件。
- `Phase1Database` 保留它本来就独占的东西：`executeCommand` 的命令回执、`insertIntent`（`intents` 行的唯一
  writer，含 `intents.kind` 的边界守卫）、`UNIQUE(project_id,display_number)` 的编号分配。
- `apps/runtime/src/task-service.ts`（`TaskService`）是 Runtime 层**唯一**的 Task 创建入口：它负责
  ADR-0059 的功能声明校验、命令身份与 payload hash、Task/revision/事件 ID 的生成，然后交给
  `Phase1Database.createTask`。`task.create` 的 Runtime 分支不再包含任何写入。
- `project.trust` 的调用点仍是 `Phase1Database.trustProject`（一处），但注册事实由 `ServiceWriteStore` 写；
  Runtime 分支**不**在 `trustProject` 之前单独调用 `ensureProjectService`：项目行与 Service 行必须与
  trust/policy 确认行同一个事务，否则失败会留下一个没有 trust 的项目/Service。

### D02 身份、幂等与失败语义

- Service 身份 = 聚合身份：`services.id` = `projects.id` / `tasks.id`，`project_id`/`task_id` 指回该行。
  这是 schema v37 投影已经采用的约定（`reconcileProjections` 逐行 `SELECT id,'PROJECT'|'TASK'`），
  沿用它可以保证两条路径写的是同一行，而不是让 projection 变成会失败的 `INSERT OR IGNORE`。
- `ensureProjectService` 按 project 幂等：已存在则原样返回，不重写 `lifecycle`/`state_version`/注册事实。
- `createTaskService` 按 taskId 幂等：已存在则收敛；`taskId` 属于别的项目是 `TASK_ID_CONFLICT`。
  非法 parent（不存在、不是 PROJECT、不是该项目）是 `SERVICE_NOT_FOUND`/`INVALID_SERVICE_PARENT`，
  在写入任何行之前拒绝。
- root Service 缺失或不是 `ROOT` 时，`project trust` **整体拒绝**（`SERVICE_NOT_FOUND`/`INVALID_SERVICE_PARENT`），
  项目行随之回滚：一个没有树位置的 Service 是坏事实，不如不写。
- 旧命令面不变：`task create` 与 `project trust` 的响应形状、稳定错误码、退出码（0/1/2/3）与今天一致；
  受信任的 Project 重复 trust 仍是「supersede 旧 trust，不 fork 项目」。

### D03 项目注册事实：metadata，不是 domain event

`project trust` 不写 `domain_events`（**这是刻意的兼容选择**，不是遗漏）。注册事实写一条
`service_metadata(service_id=projectId, namespace='kernel', key='registered', value={eventId, registeredAt})`，
只在创建时写一次。理由：`domain_events.sequence` 是全局游标，插一行会 renumber 既有兼容事件流
（`event-subscription-ipc.test.ts` 断言 cursor 1/2 就是 `IntentRecorded`/`TaskCreated`），而 ADR-0035 规定
已实现的事件流不重命名、不重新编号。`eventId` 因此有了真实归属：它就是「哪次注册建了这个 Service」的事实。

Task 创建路径不写这条 metadata：它本来就有两个事件，事实不缺。

### D04 冻结接口的加法字段

冻结字段全部保留且语义不变；下面这些是加法，理由是「不加就无法保持今天的产品事实」，并用代码里的
不变量检查兜住自相矛盾的调用（`feature` 与 `features[0]` 必须一致）：

- `createTaskService(input)` 新增
  `command: { intentId; commandId; actor }`（首 revision 的 `source_intent_id`/`actor`、`IntentRecorded` 的
  `aggregate_id` 与两个事件的 `correlation_id`/`causation_id`）与 `features?: readonly string[]`
  （`task create --feature` 可重复，`feature` 仍是冻结的单值拼写）。`eventIds` 的含义被固定为
  `[IntentRecorded.eventId, TaskCreated.eventId]`，与今天的事件顺序一致。
- `TaskService.create(input)` 新增 `features?: readonly string[]` 与 `commandId?: string`：前者同上，
  后者让 Runtime 把请求里的 `commandId` 交给创建路径，重放同一命令仍返回同一个 Task（今天的行为）。
  省略时自行生成一个新的 command id。
- `ServiceWriteStore` 另有一个内部方法 `ensureProjectRow`（`projects` 行的唯一 writer）。它参与
  `trustProject` 的事务而不自己开事务，因为 trust 行、verification/impact policy 确认行必须与它原子提交。

### D05 本轮不做什么

`task submit`/revision/验证/取消/归档的写路径不改；不新增 CLI 命令与 Runtime variant；不改 schema 与 migration；
Scheduler 不请求 Task Service 创建 Development Process（eligibility 仍由既有代码判定，`TaskEligibility` 未实现）；
`task create` 的 `CREATE_TASK` intention 不实现（S6 的边界，schema 也不接受）。

## Consequences

### Positive

- 「谁写这条事实」有唯一答案，并且有磁盘源码扫描作为证据：`INSERT INTO tasks|projects` 只出现在
  `service-write-store.ts`，`task.create` 的 Runtime 分支里没有任何写入。
- 崩溃语义从「可能留下孤儿 Service / 半行」变成「要么全写，要么全不写」。
- `service get <task-id>` 与 `task status` 读同一行，投影漂移在结构上不可能。

### Costs and risks

- 旧 writer 的代码路径被替换后，`Phase1Database.createTask` 变成「回执 + 编号 + intents + 委托」，
  读者要跨两个文件才能看全一次创建。这是分层的代价，用两处注释与 ADR 指明。
- metadata 里出现了一个不属于 core 的键（`kernel/registered`）。它不参与任何判定（ADR-0070 D03 要求
  metadata 不影响 core）；若将来它开始决定行为，必须升级为 core 字段并另立 ADR。
- 加法字段是对冻结签名的偏离。已冻结字段的含义与位置未变，但协调者若不接受 D04，需要回头改调用点
  （`database.ts` 与 `main.ts` 各一处），代价有界。
- 本轮只切创建路径，「Task Service 是唯一写路径」在 submit/revision/验证/取消/归档上**仍不成立**，
  文档与交付说明不得把它写成已完成。

## Verification requirements

1. `bun run typecheck`；`bun test apps/runtime/test/cli-task-service.test.ts`（新，真实 CLI + 临时 Runtime）；
   `bun test apps/runtime/test/cli-task-create.test.ts`；`bun test apps/runtime/test/cli-managed-project.test.ts`；
   `bun test packages/storage/test/service-kernel-migration.test.ts`。
2. `project trust` 之后 `service tree` 里有 parent = root Service 的 PROJECT Service；
   `task create` 之后有 parent = 该项目 Service 的 TASK Service（id = Task id）。
3. `task status` 的 `task.state`/`task.version` 与 `service get <taskServiceId>` 的
   `coreState.lifecycleState`/`coreVersion` 一致。
4. 同一 project 重复 trust 只有一个 PROJECT Service，且 `kernel/registered` 保持首次注册的事件 id。
5. 非法 parent、重复 taskId 与 root Service 缺失都不留下部分行（tasks/revisions/services/events 计数不变）。
6. 兼容性：`project trust` 之后 Task 创建的事件游标仍是 1/2 的 `IntentRecorded`/`TaskCreated`
   （用 `event-subscription-ipc.test.ts` 核对）。

## Related

- `PROJECT_SPEC.md` §2 核心不变量 1/5
- `docs/architecture/service-process-signal.md` §6.3、§7
- `docs/guides/cli/task-lifecycle.md` §4 `task create`
- `docs/roadmap/mvp.md` S7
- `packages/storage/src/service-write-store.ts`、`packages/storage/src/database.ts`、
  `apps/runtime/src/task-service.ts`、`apps/runtime/src/main.ts`
- ADR-0070（内核与波次）、ADR-0065（Task 三个必填字段）、ADR-0059（功能声明）、ADR-0035（事件名与兼容面）
