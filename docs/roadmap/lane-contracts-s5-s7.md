# S5 / S6 / S7 并行 lane 契约（协调者冻结，2026-09-17）

> 层级：L3 临时协作契约 · 基线：`Loyage/service_level` 合并 `dev` 后的提交 · **何时读**：本轮三个 lane 开工前必读；lane 不得修改本文件 · 权威来源：本文件 + `docs/roadmap/mvp.md` S5–S7 + ADR-0070。

三条 lane 各自在独立 worktree/branch 上工作，最终由协调者按 S5 → S7 → S6 顺序合并回 `Loyage/service_level`，再由人合入 `dev`。本文件冻结跨 lane 接口与文件所有权；**未在这份文件里冻结的东西，lane 不得自行扩大**。

## 0. 所有 lane 的硬约束

1. **基线**：worktree 由协调者从 `Loyage/service_level` 建立；lane 不 rebase、不 merge `dev`/`main`、不 force push。
2. **不占 migration**：`packages/storage/src/migration.ts` 与 `phase1SchemaVersion`（当前 v37）任何 lane 都**不许改**。S5/S6/S7 必须只用 v37 已有的表（`services`、`service_metadata`、`processes`、`process_execution_links`、`signals`、`signal_attempts`、`signal_receipts`、`tasks`、`task_revisions`、`projects`、`attention_requests`、`domain_events`、`session_guidance` 等）。
3. **不新增 CLI 命令**：不许改 `apps/cli/src/command-tree.ts`、不许加 Runtime 命令 variant、不许改 `packages/contracts/src/runtime-commands.ts`。新能力必须通过**既有命令面**可见（`signal send`、`process *`、`intent send`、`task *`、`project *`、`attention *`）。若某 lane 认为非加命令不可，停下来在 `worker_done` 里升级给协调者，不要自己做。
4. **共享文档只读**：`PROJECT_SPEC.md`、`AGENTS.md`、`docs/roadmap/mvp.md`、`docs/decisions/README.md`、`docs/tasks/README.md`、`README.md`、`.codeestra/tests.json` 一律不改。协调者统一收口。
5. **测试纪律（ADR-0038）**：只跑本 lane 任务书列出的定向测试。**禁止** `bun run check`、`just check`、`just verify`、`check:fast`、`bunx vitest run`（全仓）与任何等价全量聚合。首次进入 worktree 先 `bun install --frozen-lockfile`。
6. **不谎报**：没有真实 provider 的验收不得写成已验收；mock/临时 Runtime 只能证明协议与编排；`PENDING`、`已入队` 不得写成「已解释」「模型已读」。
7. **错误码与退出码**：新增稳定错误码用 `KernelStorageError`/`RuntimeCommandError` 的既有形状；CLI 退出码沿用 0/1/2/3 语义（3 = 等待/无候选）。
8. **交付**：`worker_done` 的 body 必须包含：改了哪些文件、实际运行的命令与结果（pass/fail 数字）、未做/未验证项、需要协调者决定的问题。不要写 `docs/tasks/README.md`，那一段由协调者根据你的 body 写入。

## 1. 文件所有权（同一文件只归一个 lane）

| 区域 | Lane E-Process (S5) | Lane F-Intent (S6) | Lane G-Project/Task (S7) |
|---|---|---|---|
| `packages/domain/src/service-kernel.ts` | 可改（Process 控制/完成/后继规则） | **只读**（用现成 FSM） | 只读 |
| `packages/domain/src/intention-routing.ts` | — | 新建/独占 | — |
| `packages/domain/src/task-service.ts` | — | — | 新建/独占 |
| `packages/storage/src/service-kernel-store.ts` | 独占 Process 写路径方法 | 只调用，不新增方法 | **不新增方法**（见下） |
| `packages/storage/src/service-write-store.ts` | — | — | 新建/独占（Service/Task 创建写路径） |
| `packages/storage/src/index.ts` | 只加导出（S5 段） | 只加导出（S6 段） | 只加导出（S7 段） |
| `packages/contracts/src/service-kernel-signals.ts` | 新建/独占（SIG_A payload schema） | — | — |
| `packages/contracts/src/intention.ts` | — | 新建/独占 | — |
| `packages/contracts/src/index.ts` | 只加一行 `export * from './service-kernel-signals.js'` | 只加一行 `export * from './intention.js'` | 只加一行 `export * from './service-write.js'`（如需要） |
| `apps/runtime/src/service-kernel.ts` | 独占（contract registry + SIG_A handler） | 只加 handler 注册（见 §4） | 只读 |
| `apps/runtime/src/intention-service.ts` | — | 新建/独占 | — |
| `apps/runtime/src/task-service.ts` | — | — | 新建/独占 |
| `apps/runtime/src/main.ts` | 只改内核命令区（`service.*`/`process.*`/`signal.*` 分支与 `runtime.commands` 之外不动） | **不改** | 只改 `task.create` / `project.trust` 的调用点 |
| `apps/runtime/test/service-kernel-*.test.ts` | 独占 S5 新文件 | — | — |
| `apps/runtime/test/cli-service-kernel*.test.ts` | 可加 S5 用例（追加，不改既有断言） | 可加 S6 用例 | — |
| `apps/runtime/test/cli-intention*.test.ts` | — | 新建/独占 | — |
| `apps/runtime/test/cli-task-service*.test.ts` | — | — | 新建/独占 |
| `docs/architecture/service-process-signal.md` | 改 §4/§5 实现边界 | 改 §8 | 改 §6.3/§7 |
| `docs/guides/cli/kernel.md` | 追加 S5 行为说明 | 追加 S6 行为说明 | — |
| `docs/guides/cli/task-lifecycle.md` | — | — | 追加 S7 行为说明（若有用户可见变化） |
| `docs/decisions/0071-*.md` | 新建（若 S5 有真实决策） | — | — |
| `docs/decisions/0072-*.md` | — | 新建（若 S6 有真实决策） | — |
| `docs/decisions/0073-*.md` | — | — | 新建（若 S7 有真实决策） |

`apps/runtime/src/main.ts` 被 S5 与 S7 同时触及但区域不同；协调者按顺序合并。**不要**为了让自己的测试通过而改动其它 lane 的既有断言。

## 2. Lane E-Process（S5）— Execution → Process 与原生控制面

**目标（最小纵向切片）**：Process 有真实、类型化的写路径与完成事实；`process get` 的只读投影包含可核验的进度；终态不复活、重复完成幂等；**不支持的能力继续如实拒绝**。

**冻结接口（S6 会调用 `transitionProcess`，签名不得改）**：

```ts
// packages/storage/src/service-kernel-store.ts, class ServiceKernelStore
transitionProcess(input: {
  readonly processId: string;
  readonly expectedVersion: number;   // processes.version CAS
  readonly next: ProcessState;        // 必须通过 domain transitionProcess(state, next)
  readonly actor: string;             // 非空
  readonly reason: string;            // 非空
  readonly now: number;
  readonly eventId: string;
}): ProcessView;

completeProcess(input: {
  readonly signalId: string;          // 已 CLAIMED 的 SIG_A
  readonly processId: string;         // 必须等于 signal.sourceProcessId ?? payload.processId
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  readonly expectedVersion: number;
  readonly summary: string;
  readonly now: number;
  readonly eventIds: readonly [string, string];
}): { readonly process: ProcessView; readonly applied: boolean };
```

**冻结 Signal 契约**（`packages/contracts/src/service-kernel-signals.ts`）：

```ts
export const processCompletedSubtype = 'PROCESS_COMPLETED';
export const processCompletedPayloadSchema = z.strictObject({
  processId: z.string().min(1),
  outcome: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED']),
  expectedVersion: z.number().int().nonnegative(),
  summary: z.string().min(1).max(4096),
});
```

- `PROCESS_COMPLETED` 是 `SIG_A`，注册到 ROOT / SCHEDULER? 不：注册到 **ROOT、PROJECT、TASK**（Process 的 parent Service 一定是这三类之一；SCHEDULER/ATTENTION 不接受）。
- 投递与回执走既有机制：同一 `(targetServiceId, idempotencyKey)` 只应用一次；重复投递返回同一 receipt 的 effect，不得二次改状态。
- 请求与 Process 不匹配（target != process.parentServiceId）、版本过期、终态拒绝、EXECUTION 源只读，分别用稳定码：`PROCESS_PARENT_MISMATCH`、`PROCESS_VERSION_CONFLICT`、`PROCESS_TERMINAL`（domain）、`PROCESS_STATUS_SOURCE_READONLY`（合法 SIG_A payload，但拒绝状态写）。

**必须做到**：
1. `transitionProcess` 只对 `status_source='PROCESS'` 生效；EXECUTION 源一律 `PROCESS_STATUS_SOURCE_READONLY`（状态由 Execution 投影决定，不得双 writer）。
2. 非法迁移以 domain 的 `INVALID_PROCESS_TRANSITION` 拒绝，且**零部分应用**（CAS 后校验再写，或写在同一事务里回滚）。
3. `process get`/`process list` 视图新增只读进度字段（`budgetKnown`、`lastProgressAt`、`tokenUsage`/`costUsd`/`toolCallCount` 若 Execution/Session 事实可得；**拿不到就明说 `null` 并写明不可得**，不许编造）。若现有表根本没有这些事实，就在文档与视图中如实记为 `UNAVAILABLE`，并写进交付说明。
4. 后继关系：恢复后新 Execution 会投影出**新 Process**（`id = execution.id`）；同一 Task 的 Process 序列里，前一个必须是终态或 `SUPERSEDED` 投影。加一条测试证明「任意时刻同一 Task 至多一个非终态 Process」，用既有 `process_execution_links`/`executions` 事实推导，不加新表。
5. `process input/pause/resume/terminate` 对**没有 Execution 的原生 Process** 继续以 `PROCESS_CONTROL_UNAVAILABLE` 拒绝（不得假装成功）。

**定向测试**（全部必须真实运行并在交付里给数字）：
- `bun run typecheck`
- `bun test packages/domain/test/service-kernel.test.ts`（追加 S5 用例，不删既有）
- `bun test packages/storage/test/service-kernel-migration.test.ts`
- `bun test apps/runtime/test/service-kernel.test.ts`
- `bun test apps/runtime/test/cli-service-kernel.test.ts`（追加：`signal send` 完成 → `process get` 终态；重复 idempotency key 幂等；过期 expectedVersion 报稳定码）

**非目标**：真正启动 Agent 的 Process runner（S6/S8）、新 CLI 命令、schema 变更、跨 provider exactly-once、token 级实时进度。

## 3. Lane F-Intent（S6）— Intention 与 Attention 路由

**目标（最小纵向切片）**：`intent send` 创建的 Intention Process 能被**结构化的 outcome** 推进：路由到既有 Service、执行白名单内的类型化命令、或在目标不明时建立 Attention；原始输入、分类、路由与审计保留；回答能按 correlation/causation 回到原 Process。

**冻结接口**（`packages/contracts/src/intention.ts`）：

```ts
export const intentionResolvedSubtype = 'INTENTION_RESOLVED';
export const intentionOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ROUTE'), targetServiceId: z.string().min(1), instruction: z.string().min(1) }),
  z.strictObject({ kind: z.literal('TYPED_COMMAND'), command: z.literal('SESSION_GUIDANCE_RECORD'),
    targetTaskServiceId: z.string().min(1), message: z.string().min(1) }),
  z.strictObject({ kind: z.literal('REQUEST_CLARIFICATION'), question: z.string().min(1),
    options: z.array(z.string().min(1)).min(2).max(4).optional() }),
]);
export const intentionResolvedPayloadSchema = z.strictObject({
  processId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  outcome: intentionOutcomeSchema,
});
```

- `INTENTION_RESOLVED` 是 `SIG_A`，注册到 ROOT / PROJECT / TASK。
- **`CREATE_TASK` 明确不在本轮**：schema 不接受它；文档与错误码写明这是 S7 的边界（不得静默丢弃用户意图）。

**语义（必须实现）**：
1. 只有 `status_source='PROCESS'` 且 `kind='INTENTION'` 的 Process 能被解析；否则 `INTENTION_PROCESS_NOT_RESOLVABLE`。
2. 解析成功：`CREATED|RUNNING → RUNNING → SUCCEEDED`（`transitionProcess`，S5 接口）；建立 Attention 时 `RUNNING → WAITING_FOR_USER`。
3. `ROUTE`：目标必须是该 Process 的 parent Service 可见的 Service（root 可路由到直属 PROJECT；PROJECT 可路由到自己的 TASK；否则 `INTENTION_TARGET_NOT_VISIBLE`）。路由事实写入 append-only 审计（domain event `IntentionRouted` vs 既有事件命名规则，事件名不得与既有重名），不修改任何 Task 规格。
4. `TYPED_COMMAND SESSION_GUIDANCE_RECORD`：调用既有 `SessionGuidanceService.record`（会话级事实，不产生 TaskRevision）；拿不到 Execution/Session 时如实拒绝。
5. `REQUEST_CLARIFICATION`：建立 `QUESTION` Attention，Process 进 `WAITING_FOR_USER`，并把 `correlationId`/`causationId` 记录到可查询的事实里；回答后（既有 `attention answer` 路径）不得静默改任务，路由只作为审计/可见事实。
6. 幂等：同一 `(targetServiceId, idempotencyKey)` 只应用一次；重复投递返回同一 receipt。

**定向测试**：
- `bun run typecheck`
- `bun test packages/domain/test/intention-routing.test.ts`（新）
- `bun test apps/runtime/test/cli-intention.test.ts`（新，真实 CLI + 临时 Runtime：`intent send` → `signal send ... INTENTION_RESOLVED` → `process get` 终态 / `attention list` 出现 QUESTION；非法 outcome 报稳定码；CREATE_TASK 形状被拒）
- `bun test apps/runtime/test/cli-service-kernel.test.ts`（仅当 `intent send` 的既有返回语义被你改动时；**不得**为了新用例破坏既有断言）

**非目标**：真实模型驱动的意图分析 Process（需要 S5 的 Agent runner，本轮不做）；`CREATE_TASK`；自由生成 SQL/CLI 字符串；新增 CLI 命令；改 `intent send` 的既有请求形状。

## 4. Lane G-Project/Task（S7）— Project/Task Service 成为单一写路径

**目标（最小纵向切片）**：至少 **Task 创建**与 **Project 注册**两条路径只有一个权威 handler；`tasks`/`projects` 行是该 Service 的类型化 core projection；旧 CLI 与 Service 查询读同一事实、无双写漂移；并有「一条 command 只有一个权威 handler」的可核验证据。

**冻结接口**：

```ts
// packages/storage/src/service-write-store.ts（新）
export class ServiceWriteStore {
  constructor(storage: Phase1Database);
  /** 在同一事务里建 PROJECT Service（parent=ROOT）与 projects 行；已存在则幂等返回现有 Service。 */
  ensureProjectService(input: { projectId: string; rootServiceId: string; now: number;
    eventId: string }): ServiceView;
  /** 在同一事务里建 TASK Service（parent=PROJECT Service）+ tasks 行 + 初始 revision。 */
  createTaskService(input: { projectId: string; projectServiceId: string; taskId: string;
    displayNumber: number; displayTitle: string; namingTitle: string | null; revisionId: string;
    specification: string; feature: string | null; now: number; eventIds: readonly [string, string] }): {
      readonly service: ServiceView; readonly taskId: string };
}

// apps/runtime/src/task-service.ts（新）
export class TaskService {
  /** 唯一 Task 创建入口；`task.create` Runtime 命令与未来的 intention `CREATE_TASK` 都走这里。 */
  create(input: { projectId: string; displayTitle: string; namingTitle: string; detail: string;
    feature?: string }): Promise<TaskCreateView>;   // 返回形状必须与现有 task.create 响应一致
}
```

**必须做到**：
1. `task.create` 的 Runtime 分支改为调用 `TaskService.create`；**响应形状、错误码、退出码与今天完全一致**（既有 `cli-task-create.test.ts` 不得改断言）。
2. `project.trust` 的注册路径改为先 `ensureProjectService`（parent 必须是 ROOT Service；不存在则以 `SERVICE_NOT_FOUND`/`INVALID_SERVICE_PARENT` 拒绝），再写项目事实；`projects` 行与 SERVICE 的 `project_id` 投影不得互相矛盾。
3. 「单一权威 handler」证据：加一个定向测试（源码扫描即可）断言 `INSERT INTO tasks`/`INSERT INTO projects` 只出现在 `service-write-store.ts`（或显式白名单），且 `task.create` 的 Runtime 分支里不再有直接写入。测试必须真实读到磁盘上的源码，不得是空断言。
4. 幂等与失败不部分应用：同一 project 重复 trust、同一 taskId 重复 create 都必须收敛（不产生第二行、不产生孤儿 Service）。
5. Service tree 查询与旧 CLI 读同一事实：`service tree` 里能看到新建的 PROJECT/TASK Service，`task status` 与 `service get <taskServiceId>.coreState` 的 lifecycle/version 一致。

**定向测试**：
- `bun run typecheck`
- `bun test apps/runtime/test/cli-task-service.test.ts`（新：真实 CLI `project trust` + `task create` + `service tree`/`service get` 一致性、幂等、失败不部分应用）
- `bun test apps/runtime/test/cli-task-create.test.ts`（既有行为不变）
- `bun test apps/runtime/test/cli-managed-project.test.ts`
- `bun test packages/storage/test/service-kernel-migration.test.ts`

**非目标**：`task submit`/revision/验证/取消/归档全部切换（本轮只切 create 与 project trust）；Scheduler 请求 Task Service 创建 Development Process；schema 变更；`CREATE_TASK` intention。

## 5. 合并顺序与冲突面

1. E-Process → 2. G-ProjectTask → 3. F-Intent（F 依赖 E 的 `transitionProcess`）。
预期冲突面：`packages/contracts/src/index.ts`、`packages/storage/src/index.ts`、`apps/runtime/src/main.ts`、`docs/guides/cli/kernel.md`、`docs/architecture/service-process-signal.md`。协调者解决，lane 不要试图互相 rebase。
