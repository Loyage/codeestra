# SQLite Schema（索引与工程规则）

> 层级：L1 索引 · 体量 ≈ 8k 字符（含版本台账） · **何时读**：改 schema、判断某张表归属哪一层、实施 migration 之前 · **权威来源**：`packages/storage/src/migration.ts`（DDL 与版本号）与 `packages/storage/src/database.ts`（`migrate()` 顺序与防护）。本文各域 DDL 由当前 v37 库的 `sqlite_master` 直接导出，不是历史草案。

状态：`phase1SchemaVersion = 37`。v1–v37 的实际 migration 见 `packages/storage/src/migration.ts`；**v16 永久未使用、v22 未占用**。逐版本的 DDL 叙述与验收记录已从文档移除（本文档只保留当前形态与工程规则），需要历史时用 `git log docs/architecture/sqlite-schema.md` 与各版本对应的 ADR。

## 0. 按需读哪一篇

| 你要回答的问题 | 读 | 体量 |
|---|---|---|
| 项目、意图、Task、Revision、依赖、知识绑定 | [`sqlite-schema-task.md`](./sqlite-schema-task.md) | ≈11k |
| Workspace、Execution、Agent 配置、成果 commit 授权、Attention | [`sqlite-schema-execution.md`](./sqlite-schema-execution.md) | ≈8k |
| Session、incarnation/lease、接管与终端、指导、修订投递、启动收敛 | [`sqlite-schema-sessions.md`](./sqlite-schema-sessions.md) | ≈19k |
| 影响/冲突、验证与定向测试计划、资源回收账本 | [`sqlite-schema-pipeline.md`](./sqlite-schema-pipeline.md) | ≈13k |
| Operation、domain event、outbox、幂等回执、容量、槽位预留、全局暂停 | [`sqlite-schema-runtime.md`](./sqlite-schema-runtime.md) | ≈12k |
| Service / Process / Signal 内核表（ADR-0070 S2） | [`sqlite-schema-kernel.md`](./sqlite-schema-kernel.md) | ≈10k |
| 状态取值与合法迁移 | [`state-machines.md`](./state-machines.md)（+ sessions/runtime 两篇） | ≈9k + 8k + 5k |

当前共 **56 张表**。表名一律 snake_case 复数；没有 UI 专用表、没有第二套事件源。

## 1. 跨表约定

- TEXT UUID 主键；INTEGER UTC milliseconds；布尔 INTEGER `CHECK IN (0,1)`。Git OID 按仓库 object format 校验，不硬编码 sha1。
- 每连接 `PRAGMA foreign_keys=ON`、`busy_timeout=5000`；本地文件用 WAL，不放网络文件系统。
- 结构化数据用列与 FK 表达；JSON TEXT 只放真正开放的内容，且必须 `json_valid` 并由 Zod 在运行时边界校验。
- 聚合并发用 `UPDATE ... WHERE version = expectedVersion` 的 CAS；更新行数非 1 即并发冲突。
- **append-only** 的对象（revision、impact 快照/判定、targeted test plan、knowledge 快照、signal attempt/receipt）由 `BEFORE UPDATE/DELETE ... RAISE(ABORT)` 触发器保护。就地改写证据会使依赖它的结论不可审计。
- 默认不级联删除审计与成果记录；唯一的显式例外是 `task purge`（ADR-0058）：单任务事务内让五张 append-only 任务子表的触发器让路（读出原文 → DROP → DELETE → 重建 → 复核行数，任一触发器缺失即拒绝、失败整笔回滚），`domain_events` / `command_receipts` / `operations` / `intents` / 项目级 `knowledge_snapshots` **不删**，因此「这个任务存在过、被谁在何时删除」仍可读。
- 状态列的合法取值集与 [`state-machines.md`](./state-machines.md) 的同名集合一致；本文 DDL 里的 CHECK 是权威，示例省略不算已迁移。
- 跨聚合业务约束（左右必须同项目、成员属于同一批次等）由应用服务在单事务内校验；SQLite 只保证能表达的那部分。

## 2. 实施 schema 变更的工程规则

这些规则来自真实踩过的坑，改迁移前必读；每一条都对应 `database.ts` 里的现成防护，不要绕开。

1. **版本号由单一 owner 管理，升序判定。** `migrate()` 是 `if (version < N)` 链，最后写 `PRAGMA user_version`。两个并行分支不能同时占用一个版本号；跨分支合并必须按序号合并同一步骤。
2. **v16 永久未使用。** 最早占用 v17 的 lane 先合入，既有库可能已被标为 17+，`if (version < 16)` 会被整段跳过：补 v16 要么不生效、要么与已应用的 schema 冲突。同一根因也意味着**已被标成更高版本号的库不会补跑后来出现的更低版本步骤**。v22 同理未占用。
3. **`Bun.Database.exec()` 会吞掉多语句脚本里的 step 错误并继续执行后面的语句。** 因此每个重建/删除步骤都要：复制前记录行数 → 执行 → 复核行数，并在关键步骤后断言**结束态**（如新列确实可空、singleton 行确实存在）。只看退出码等于没看。
4. **SQLite 不能就地改 CHECK / NOT NULL / 删带 CHECK 的列。** 必须 create → copy → drop → rename 重建表；重建时 `PRAGMA foreign_keys=OFF`（`rebuildsTable = version < 36` 的谓词），结束前 `PRAGMA foreign_key_check` 必须为空。**重建等于手写整张表：索引与 append-only 触发器都要在脚本里显式重建**，漏掉触发器就是让证据变成可改写。
5. **历史行不重写。** 收窄 CHECK 前先检查库中是否还有被移除取值，有则以具名 `INVALID_STATE` 拒绝升级、原库一行不动；不把历史分类「升级」成新分类。
6. **迁移不是发布物。** 未来表不提前创建；`phase1SchemaVersion` 之外不承诺兼容窗口。升级前 schema 版本高于当前实现时以 `UNSUPPORTED_SCHEMA` 拒绝写入。
7. **迁移只做结构。** 业务语义、权限模式、状态合法性由 domain/application 层决定；迁移里不塞产品行为。

## 3. 版本台账

| v | 迁移常量 | 内容 | 现在的状态 |
|---|---|---|---|
| 1 | `phase1Migration` | 项目/信任、intents、tasks、revisions、workspaces、executions、agent_sessions、adapter_events、attention、operations、domain_events、outbox、回执 | 现行 |
| 2 | `agentStartMigration` | Agent start 分步持久化（Session STARTING + START_AGENT Operation） | 现行 |
| 3 | `agentObservationMigration` | `adapter_events` 以 Session/provider event ID 去重，Session cursor 唯一 | 现行 |
| 4 | `agentAnswerMigration` | Attention 的 `response_type`、一请求一回答、Intent→Attention target | 现行 |
| 5 | `agentDisconnectMigration` | `disconnected` 事件、session storage ref 与进程身份 | 现行 |
| 6 | `taskVerificationMigration` | 验证策略确认与 `verification_runs` 实现形态 | 现行 |
| 7 | `workspaceRetryMigration` | workspace path 由列 UNIQUE 改部分唯一索引（失败可保留并重试） | 现行 |
| 8 | `agentConfigurationMigration` | `agent_configurations` + `executions.agent_config_json`（ADR-0012） | 现行 |
| 9 | `taskControlMigration` | `tasks.archived_at`、暂停/终止/归档的 `stop_reason` 与 `resume_from_execution_id`（ADR-0016） | 现行 |
| 10 | `integrationPipelineMigration` | 集成管线（ADR-0018） | **v36 已删除** |
| 11 | `operationProgressMigration` | `operation_progress`（ADR-0019） | 现行 |
| 12 | `reclamationMigration` | 回收账本（ADR-0021） | 现行（v24 重建） |
| 13 | `stablePromotionMigration` | 稳定提升（ADR-0022） | **v36 已删除** |
| 14 | `sessionHandoffMigration` | incarnation、单 writer lease、handoff、STRICT 权限请求（ADR-0023） | 现行 |
| 15 | `taskDependenciesMigration` | `task_dependencies` + 边不可变触发器（ADR-0024） | 现行 |
| 16 | —— | 永久未使用（见 §2.2） | 未占用 |
| 17 | `verificationProgressMigration` | `verification_runs.CANCELLED` 与 `operation_progress_events`（ADR-0027） | 现行 |
| 18 | `sessionTerminalMigration` | PTY 终端与 attachment（ADR-0026） | 现行 |
| 19 | `revisionDeliveryMigration` | 修订投递需求/尝试台账 + 启动收敛审计（ADR-0028） | 现行 |
| 20 | `impactAnalysisMigration` | 影响快照、配对判定、影响策略确认（ADR-0031） | 现行（判定语义见 ADR-0059） |
| 21 | `capacitySlotReservationMigration` | 槽位预留与容量配置（ADR-0032） | 预留现行；项目级/Adapter 级配置表 v34 退役 |
| 22 | —— | 未占用 | 未占用 |
| 23 | `taskRetryMigration` | `tasks.pending_retry_from_execution_id`、`executions.retry_from_execution_id`（ADR-0036） | 现行 |
| 24 | `unregisteredReclamationMigration` | 回收账本支持未注册目录与 `RECOVERY_REQUIRED`（ADR-0037） | 现行 |
| 25 | `verificationLayeringMigration` | 定向测试计划；全量证据与 promotion 列 | 计划现行；**全量证据部分 v36 已删除** |
| 26 | `knowledgeLayerMigration` | `knowledge_snapshots`、`execution_knowledge_snapshots`（ADR-0041） | 现行 |
| 27 | `agentPluginSelectionMigration` | `agent_configurations.plugin_selection_json`（ADR-0044） | 现行 |
| 28 | `intentsKindShrinkMigration` | 重建 `intents`，`kind` 收窄为五个取值（ADR-0046） | 现行 |
| 29 | `devClonePromotionMigration` | dev clone 与经 GitHub 中转的提升（ADR-0047） | **v36 已删除** |
| 30 | 多成员批次批级终态 | `integration_batches.state` 加宽（ADR-0053） | **v36 已删除** |
| 31 | `sessionGuidanceMigration` | `session_guidance` 与投递记录（ADR-0057） | 现行 |
| 32 | `taskRevisionFeaturesMigration` | `task_revisions.features_json`（ADR-0059） | 现行 |
| 33 | `taskBaselineRefMigration` | `workspaces.base_ref`（ADR-0060） | 现行 |
| 34 | Runtime 全局容量 + Provider 冻结 | `runtime_capacity_settings`、退役两张旧容量表、`runtime_command_receipts`、`domain_events.project_id` 可空；`runtime_pause_control`/`runtime_pause_targets`（ADR-0061） | 现行 |
| 35 | 任务输入字段 | `tasks` 两个标题、删 `kind` 与 `constraints_json`（ADR-0065） | 现行 |
| 36 | 删除 dev clone / 双基线 / 集成 / 提升 | 回填 `workspaces.base_ref`、重建 `projects`、DROP 集成与提升各表（ADR-0066） | 现行（不可逆） |
| 37 | Service Kernel additive storage | `services`、`service_metadata`、`processes`、`process_execution_links`、`signals`、`signal_attempts`、`signal_receipts`（ADR-0070 S2） | 现行 |

后续版本号留给 ADR-0070 的受管 integration（S8）与 Self Evolution，且只有真正实现后才写进上表。**v36 的删除是不可逆的**：集成批次、集成验证与提升记录已不存在，Task/revision/execution/任务级验证/workspace/回收账本不受影响。

## 4. 旧章节号对照（历史引用仍可解析）

本文曾把「逻辑设计」与「逐版本 migration 记录」合在一篇里。当时的分节与新位置的对应：

| 旧位置 | 现在去哪 |
|---|---|
| §1 约定 | 本文 §1、§2 |
| §2 身份、意图、任务与 DAG | [`sqlite-schema-task.md`](./sqlite-schema-task.md) |
| §3 Git、执行、会话与交互 | [`sqlite-schema-execution.md`](./sqlite-schema-execution.md) + [`sqlite-schema-sessions.md`](./sqlite-schema-sessions.md) |
| §4 影响与冲突 | [`sqlite-schema-pipeline.md`](./sqlite-schema-pipeline.md) |
| §5 集成与验证 | 验证部分在 [`sqlite-schema-pipeline.md`](./sqlite-schema-pipeline.md)；集成表已由 v36 删除 |
| §6 操作日志、事件、幂等 | [`sqlite-schema-runtime.md`](./sqlite-schema-runtime.md) |
| §7 Self Evolution | 仍是预留逻辑表（见 [`sqlite-schema-pipeline.md`](./sqlite-schema-pipeline.md) 末节），无实现 |
| §8 各版本 migration 记录 | 删除；改为本文 §3 台账 + `packages/storage/src/migration.ts` + 对应 ADR |
