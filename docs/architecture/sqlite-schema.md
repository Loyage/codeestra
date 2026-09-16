# SQLite Schema

状态：逻辑 SQL 设计基线 + 已实现 migration 记录。第 2–6 节是逻辑关系设计（其中若干节已被后续 ADR 修订，见第 8 节各版本的说明）；第 8 节逐版本记录 `packages/storage/src/migration.ts` 中**实际存在**的 migration，当前最新实现为 schema **v34**（ADR-0061 的两半：容量上半 FOUNDATION-096，暂停下半 FOUNDATION-097；v16 永久未使用、v22 未占用）。**schema version 16 永久未使用**，原因见第 8 节。本文不是对外发布 migration，未来字段与表不提前创建。后续 Drizzle schema 必须与第 2–6 节的约束等价，并以第 8 节的实现记录为准。

## 1. 约定

- TEXT UUID；INTEGER UTC milliseconds；布尔 INTEGER CHECK IN (0,1)。Git OID 按 repo object format 在应用边界校验。
- 每连接 `PRAGMA foreign_keys=ON`、`busy_timeout=5000`；本地文件采用 WAL。数据库不放网络文件系统。
- JSON TEXT 附加 `json_valid` 并由 Zod 检验结构；不将结构化关系全部塞进 JSON。
- aggregate version 通过 `UPDATE ... WHERE version = expectedVersion` CAS；更新行数非 1 为并发冲突。
- 默认不级联删除审计与成果记录。归档、日志期限、数据库压缩后续设计；未获授权不自动回收证据。
  **唯一的显式例外是 `task purge`（ADR-0058）**：用户在命令面显式要求永久删除一个任务时，该任务拥有的行——包括五张
  append-only 任务子表（`task_revisions`/`impact_snapshots`/`impact_assessments`/`targeted_test_plans`/`execution_knowledge_snapshots`）
  的 `_no_delete` 触发器会在**同一个事务内**被读出原文 → DROP → DELETE → 原文重建 → 复核数量（任一触发器缺失即拒绝，失败即整笔回滚）——
  连同它自己的 worktree/验证副本/分支一起销毁。代价是可见的：`domain_events`、`command_receipts`、`operations`、`intents` 与项目级
  `knowledge_snapshots` **不被删除**，所以「这个任务存在过、被谁在什么时候删除了什么」仍可读（最后一条 `TaskPurged`），而**逐表行数之外不可恢复**（无墓碑、无备份）。
- 下列 state 的合法值由对应 `state-machines.md` 的同名状态集合生成 CHECK；示例中对长枚举以应用校验说明，不把省略的 CHECK 当作已完整 migration。正式 migration 必须补齐并测试。

## 2. 身份、意图、任务与 DAG

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_root TEXT NOT NULL UNIQUE,
  git_common_dir TEXT NOT NULL UNIQUE,
  main_ref TEXT NOT NULL,
  dev_ref TEXT NOT NULL,               -- schema v1/v2，新 Task worktree 的固定基线（ADR-0009/0018）
  dev_repo_path TEXT,                  -- schema v29，可空；推送 push 用的第二个 clone（ADR-0047 D05）
  object_format TEXT NOT NULL CHECK (object_format IN ('sha1','sha256')),
  policy_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE project_trusts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  repo_root TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  object_format TEXT NOT NULL CHECK(object_format IN ('sha1','sha256')),
  policy_version INTEGER NOT NULL,
  actor TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','INVALIDATED')),
  accepted_at INTEGER NOT NULL,
  invalidated_at INTEGER
);
CREATE UNIQUE INDEX one_active_project_trust
  ON project_trusts(project_id) WHERE status='ACTIVE';
CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  idempotency_key TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  -- v1 的声明；v28（ADR-0046）把它收窄为前五个取值，见第 8 节。
  kind TEXT CHECK (kind IN ('CREATE_TASK','AMEND_TASK','ADD_CONSTRAINT',
    'CANCEL_TASK','CHANGE_PRIORITY','ANSWER_AGENT','SELF_MODIFICATION')),
  status TEXT NOT NULL CHECK (status IN ('RECORDED','NEEDS_CLARIFICATION','APPLIED','REJECTED')),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, idempotency_key)
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  display_number INTEGER NOT NULL CHECK(display_number > 0),
  kind TEXT NOT NULL CHECK(kind IN ('DEVELOPMENT','SELF')),
  current_revision_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('DRAFT','BLOCKED','READY','RUNNING','PAUSING',
    'PAUSED','WAITING_FOR_USER','RECOVERY_REQUIRED','EXECUTED','FAILED',
    'CANCELLING','CANCELLED','SUCCEEDED')),
  priority INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, display_number),
  UNIQUE(project_id, id),
  FOREIGN KEY(id,current_revision_id) REFERENCES task_revisions(task_id,id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE task_revisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  number INTEGER NOT NULL CHECK(number > 0),
  previous_revision_id TEXT,
  specification TEXT NOT NULL CHECK(length(trim(specification)) > 0),
  constraints_json TEXT NOT NULL CHECK(json_valid(constraints_json)),
  -- schema v32 (FOUNDATION-091 / ADR-0059)：声明的功能（modules[].id），纯 ADD COLUMN，
  -- 历史行一律 '[]'（在引入该列之前没有任何声明，而「没声明」的安全读法就是不参与功能冲突）。
  features_json TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(features_json) AND json_type(features_json) = 'array'),
  source_intent_id TEXT REFERENCES intents(id),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, number),
  UNIQUE(task_id, id),
  FOREIGN KEY(task_id,previous_revision_id) REFERENCES task_revisions(task_id,id)
);
CREATE TABLE intent_targets (
  intent_id TEXT NOT NULL REFERENCES intents(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY(intent_id, task_id)
);
CREATE TABLE task_dependencies (
  project_id TEXT NOT NULL,
  dependent_task_id TEXT NOT NULL,
  prerequisite_task_id TEXT NOT NULL,
  required_revision_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','NEEDS_REVIEW')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(dependent_task_id, prerequisite_task_id),
  CHECK(dependent_task_id <> prerequisite_task_id),
  FOREIGN KEY(project_id,dependent_task_id) REFERENCES tasks(project_id,id),
  FOREIGN KEY(project_id,prerequisite_task_id) REFERENCES tasks(project_id,id),
  FOREIGN KEY(prerequisite_task_id,required_revision_id) REFERENCES task_revisions(task_id,id)
);
CREATE INDEX tasks_schedule ON tasks(project_id,state,priority DESC,created_at,id);
CREATE INDEX dependencies_upstream ON task_dependencies(prerequisite_task_id);
```

`project_trusts` 保留用户接受时的仓库身份快照；ACTIVE/INVALIDATED 与时间戳一致性由 migration CHECK 强制。启动执行或 hooks 前重新检查 Project 当前 canonical identity，变化时使 ACTIVE trust 失效，而不是静默更新快照。

创建 Task 与首 Revision 必须在同一事务，延迟 FK 于 commit 检验。Phase 1 首入口同时保存原始 Intent、IntentTarget、IntentRecorded、TaskCreated 与 command receipt；新 Task 为 DRAFT，显式 submit 前不可调度。Revision append-only 由 storage API 和防 UPDATE/DELETE trigger 保护（migration 测试必须覆盖）。DAG 环检测在 `BEGIN IMMEDIATE` 下读取并插入，不仅依赖自环 CHECK。

## 3. Git、执行、会话与交互

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  branch_ref TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  ownership_token TEXT NOT NULL UNIQUE,
  base_commit TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('RESERVED','PREPARING','READY','IN_USE',
    'RECOVERY_REQUIRED','RETAINED','RELEASED')),
  created_at INTEGER NOT NULL,
  UNIQUE(task_id,id)
);
CREATE UNIQUE INDEX one_live_workspace ON workspaces(task_id) WHERE state <> 'RELEASED';
CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  initial_revision_id TEXT NOT NULL,
  applied_revision_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  state TEXT NOT NULL,
  resource_held INTEGER NOT NULL CHECK(resource_held IN (0,1)),
  base_commit TEXT NOT NULL,
  result_commit TEXT,
  stop_reason TEXT CHECK(stop_reason IN ('USER_CANCEL','REVISION_RESTART','SHUTDOWN')),
  version INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  ended_at INTEGER,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  -- ADR-0012：本次 Execution 预留时解析出的生效配置；NULL 表示全部走 Adapter 默认。
  agent_config_json TEXT CHECK(agent_config_json IS NULL OR json_valid(agent_config_json)),
  UNIQUE(task_id,attempt_number),
  UNIQUE(task_id,id),
  FOREIGN KEY(task_id,initial_revision_id) REFERENCES task_revisions(task_id,id),
  FOREIGN KEY(task_id,applied_revision_id) REFERENCES task_revisions(task_id,id),
  FOREIGN KEY(task_id,workspace_id) REFERENCES workspaces(task_id,id)
);
CREATE UNIQUE INDEX one_held_execution ON executions(task_id) WHERE resource_held=1;
-- ADR-0012：每个 Adapter 一份全局默认，每个项目每个 Adapter 至多一份覆盖。字段为 NULL 表示
-- “该作用域不覆盖此字段”，解析时继续向更低优先级回落；字段全部为空的记录会被删除。
CREATE TABLE agent_configurations (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('GLOBAL','PROJECT')),
  project_id TEXT REFERENCES projects(id),
  adapter_id TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  thinking_level TEXT CHECK(thinking_level IS NULL OR thinking_level IN
    ('off','minimal','low','medium','high','xhigh','max')),
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  CHECK((scope='GLOBAL' AND project_id IS NULL) OR (scope='PROJECT' AND project_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_global_agent_configuration
  ON agent_configurations(adapter_id) WHERE scope='GLOBAL';
CREATE UNIQUE INDEX one_project_agent_configuration
  ON agent_configurations(project_id,adapter_id) WHERE scope='PROJECT';
CREATE TABLE result_commit_authorizations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  expected_head TEXT NOT NULL,
  change_fingerprint TEXT NOT NULL,
  actor TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','CONSUMED','INVALIDATED')),
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  invalidated_at INTEGER,
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id),
  FOREIGN KEY(task_id,workspace_id) REFERENCES workspaces(task_id,id)
);
CREATE UNIQUE INDEX one_active_result_commit_authorization
  ON result_commit_authorizations(execution_id) WHERE status='ACTIVE';
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  predecessor_session_id TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('AUTOMATED_RPC','HUMAN_TUI')),
  provider_session_id TEXT,
  process_identity_json TEXT CHECK(process_identity_json IS NULL OR json_valid(process_identity_json)),
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
  transport_locator TEXT,
  session_storage_ref TEXT,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  last_observed_at INTEGER,
  exit_json TEXT CHECK(exit_json IS NULL OR json_valid(exit_json)),
  UNIQUE(execution_id,id),
  FOREIGN KEY(execution_id,predecessor_session_id)
    REFERENCES agent_sessions(execution_id,id)
);
CREATE UNIQUE INDEX one_active_agent_session_per_execution
  ON agent_sessions(execution_id)
  WHERE state IN ('CREATED','STARTING','ACTIVE','WAITING_FOR_USER','PAUSING','PAUSED','STOPPING');
CREATE TABLE session_guidance (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  command_id TEXT UNIQUE,
  source TEXT NOT NULL CHECK(source IN ('COMMAND','TUI')),
  actor TEXT NOT NULL,
  behavior TEXT NOT NULL CHECK(behavior IN ('SAFE_POINT_STEER','FOLLOW_UP','CONTINUATION')),
  content_text TEXT,
  content_hash TEXT NOT NULL,
  content_length INTEGER NOT NULL CHECK(content_length >= 0),
  provider_entry_ref TEXT,
  status TEXT NOT NULL CHECK(status IN ('PLANNED','IN_PROGRESS','DELIVERED','FAILED','RECOVERY_REQUIRED')),
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  CHECK((source='COMMAND' AND command_id IS NOT NULL AND content_text IS NOT NULL)
     OR (source='TUI' AND command_id IS NULL AND content_text IS NULL))
);
CREATE TABLE takeover_requests (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  source_session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  target_session_id TEXT REFERENCES agent_sessions(id),
  target_mode TEXT NOT NULL CHECK(target_mode IN ('HUMAN_TUI','AUTOMATED_RPC')),
  state TEXT NOT NULL CHECK(state IN ('REQUESTED','WAITING_FOR_ATTENTION','WAITING_FOR_SAFE_POINT',
    'STOPPING_SOURCE','STARTING_TARGET','ACTIVE','RETURN_REQUESTED','COMPLETED','FAILED','RECOVERY_REQUIRED')),
  requested_cursor TEXT,
  expected_provider_session_id TEXT,
  expected_session_storage_ref TEXT,
  expected_last_entry_id TEXT,
  actor TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json))
);
CREATE UNIQUE INDEX one_open_takeover_per_execution
  ON takeover_requests(execution_id)
  WHERE state NOT IN ('COMPLETED','FAILED');
CREATE TABLE terminal_attachments (
  id TEXT PRIMARY KEY,
  takeover_id TEXT NOT NULL REFERENCES takeover_requests(id),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  client_id TEXT NOT NULL,
  access TEXT NOT NULL CHECK(access IN ('READ_ONLY','WRITER')),
  status TEXT NOT NULL CHECK(status IN ('ATTACHED','DETACHED')),
  attached_at INTEGER NOT NULL,
  detached_at INTEGER
);
CREATE UNIQUE INDEX one_terminal_writer_per_session
  ON terminal_attachments(session_id) WHERE access='WRITER' AND status='ATTACHED';
CREATE TABLE revision_deliveries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  delivery_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('PENDING','SENT','ACKNOWLEDGED','REJECTED','SUPERSEDED')),
  evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
  created_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id),
  UNIQUE(execution_id,revision_id)
);
CREATE TABLE attention_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  provider_request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('PERMISSION','QUESTION','RECOVERY')),
  response_type TEXT NOT NULL CHECK(response_type IN ('CONFIRM','VALUE')),
  prompt_json TEXT NOT NULL CHECK(json_valid(prompt_json)),
  status TEXT NOT NULL CHECK(status IN ('OPEN','ANSWER_RECORDED','DELIVERED','CLOSED','STALE')),
  created_at INTEGER NOT NULL,
  UNIQUE(session_id,provider_request_id)
);
CREATE TABLE attention_answers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES attention_requests(id),
  command_id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  answer_json TEXT NOT NULL CHECK(json_valid(answer_json)),
  created_at INTEGER NOT NULL
);
```

活动资源唯一性以 resource_held 而非心跳超时决定。即使 Runtime 的 lease 过期，也不能在未知进程仍可能写入时抢占 workspace。终态与 resource_held=0 的一致性在正式 CHECK/事务服务中强制；确认停止前不得置 0。

Agent adapter_id 的权威来源为 Execution，不在多处维护可能不一致的主 Agent。provider session ID 是否跨项目唯一由 Adapter 决定，数据库不擅自全局唯一。

上面 §3 的 `agent_sessions` / `session_guidance` / `takeover_requests` / `terminal_attachments` / `revision_deliveries` DDL 是 Phase 0 逻辑设计。**实现与它不同，且以第 8 节为准**：

- 实际的 `agent_sessions`（v1 建立，v3 追加 `observation_cursor`，v14 追加 `current_incarnation_id`）仍有 `execution_id TEXT NOT NULL UNIQUE`；RPC↔TUI 的进程交接收敛为同一 Session 内的 **incarnation**（v14 `session_incarnations`），而不是每条进程一个 AgentSession。v14 是 ADR-0023 的实现选择，`predecessor` 概念落在 incarnation 上。
- 逻辑设计里的 `session_guidance` / `takeover_requests` / `terminal_attachments` / `revision_deliveries` **没有按上述形态进入 migration**：ADR-0023 用 `session_handoff_requests` + `session_writer_leases` + `session_permission_requests`，ADR-0026 用 `session_terminals` + `session_terminal_attachments`，ADR-0028 用 `task_revision_deliveries` + `task_revision_delivery_attempts`。

Session Guidance 不替代 TaskRevision：`task guide` 命令正文需在记录中耐久保存以支持可靠投递；TUI 已写入 provider conversation 的正文只保存 entry 引用/hash/长度，不重复复制；两者正文都不进入领域事件。TakeoverRequest 与 START/STOP successor Operation 共同保护非原子进程交接；旧进程未确认退出时状态进入 RECOVERY_REQUIRED，禁止创建第二 writer。Terminal attachment 记录连接/lease 元数据，PTY 原始字节只在 Runtime 有界内存缓冲，不入 SQLite。

Agent start 已按 `CREATED→PREPARING→STARTING→RUNNING` 分步持久化：调用 Adapter 前写 Session STARTING 与 START_AGENT Operation，成功后原子记录 Session ACTIVE、Execution RUNNING 与事件。可证明未创建 Session 的失败释放 Execution 持有并保留 workspace；任何未知/可能已启动的错误保持资源并进入 RECOVERY_REQUIRED。Runtime 重启遇到 IN_PROGRESS start 不重放，只标记恢复；PLANNED 尚可安全继续。

v3 的 `adapter_events` 以 Session/provider event ID 为主键并约束 Session/cursor 唯一；同一 provider identity 的内容变化被拒绝。Attention 投影在同一事务写 Adapter event、OPEN request、Session/Execution/Task WAITING_FOR_USER 与领域事件。成功 completion 只令 Session EXITED，Execution 保持 RUNNING等待固定成果 commit；失败 completion 只有在结构化 quiescence evidence 通过边界校验后才释放 Execution 并保留 workspace。

v4 为 Attention 保存 Adapter 声明的 `response_type`，并增加一请求一回答、Intent→Attention target。`attention.answer` 原子记录 ANSWER_AGENT Intent、typed answer、PLANNED Operation、receipt 与不含正文的 `UserAnswerRecorded`；只有 Operation 进入 IN_PROGRESS 后才调用 Adapter。明确未投递失败可回到 PLANNED 重试；任何可能已投递或 Runtime 中断都不得重放，而是保持 ownership 并进入 RECOVERY_REQUIRED。Adapter 确认接收后记录 `UserAnswerDelivered`；仅在没有其他阻塞 Attention 时恢复 Session/Execution/Task。

v5 允许 `adapter_events.event_type='disconnected'`（表 CHECK 变更需重建表，约束与唯一索引保持不变）。Agent start 现在同时持久化 provider session ID、`session_storage_ref` 与 `process_identity_json`（pid、executable、start token、argv hash、capturedAt）；缺少 start token 时拒绝启动，因为 PID 可被复用。断连投影在同一事务写 Session `DISCONNECTED`、Execution/Task/workspace `RECOVERY_REQUIRED`（resource_held 保持 1）与状态事件；不声称静止，也不释放占用。

`result_commit_authorizations` 是一次性授权，不是长期项目权限。消费时事务需重验 execution 当前 applied revision、workspace 归属、expected HEAD 与实时 ChangeSet fingerprint；任一变化先 INVALIDATED，再请求新确认。Commit 是外部副作用，成功后再崩溃时通过 Operation 与 HEAD/OID reconcile 补记，不能仅靠数据库事务假装原子。

## 4. 影响与冲突（Phase 2）

```sql
CREATE TABLE impact_assessments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  analyzer_version TEXT NOT NULL,
  complete INTEGER NOT NULL CHECK(complete IN (0,1)),
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id)
);
CREATE TABLE conflict_assessments (
  id TEXT PRIMARY KEY,
  left_impact_id TEXT NOT NULL REFERENCES impact_assessments(id),
  right_impact_id TEXT NOT NULL REFERENCES impact_assessments(id),
  verdict TEXT NOT NULL CHECK(verdict IN ('SAFE_TO_PARALLELIZE','UNKNOWN','CONFLICTING')),
  reason_json TEXT NOT NULL CHECK(json_valid(reason_json)),
  created_at INTEGER NOT NULL,
  CHECK(left_impact_id < right_impact_id),
  UNIQUE(left_impact_id,right_impact_id)
);
```

impact snapshot 不覆盖，缓存 key 包含 analyzer/policy/base 版本。应用保证左右属于同项目不同 Task；复杂跨表业务约束不依赖 JSON 检查。

## 5. 集成与验证（Phase 1 验证 / Phase 4 集成）

```sql
CREATE TABLE integration_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  expected_dev_commit TEXT NOT NULL,
  integration_ref TEXT NOT NULL,
  candidate_commit TEXT,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  integrated_dev_commit TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE integration_batch_items (
  batch_id TEXT NOT NULL REFERENCES integration_batches(id),
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  PRIMARY KEY(batch_id,task_id),
  UNIQUE(batch_id,ordinal),
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id)
);
CREATE TABLE verification_runs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('TASK','INTEGRATION')),
  task_id TEXT,
  execution_id TEXT,
  revision_id TEXT,
  batch_id TEXT REFERENCES integration_batches(id),
  tested_commit TEXT NOT NULL,
  tree_fingerprint TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  commands_json TEXT NOT NULL CHECK(json_valid(commands_json)),
  state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','PASSED','FAILED','ERROR','STALE')),
  evidence_ref TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id),
  CHECK((scope='TASK' AND task_id IS NOT NULL AND execution_id IS NOT NULL
    AND revision_id IS NOT NULL AND batch_id IS NULL)
    OR (scope='INTEGRATION' AND task_id IS NULL AND execution_id IS NULL
    AND revision_id IS NULL AND batch_id IS NOT NULL))
);
CREATE TABLE stable_branch_promotions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  verified_dev_commit TEXT NOT NULL,
  expected_main_commit TEXT NOT NULL,
  verification_id TEXT NOT NULL REFERENCES verification_runs(id),
  state TEXT NOT NULL,
  promoted_main_commit TEXT,
  restart_evidence_ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE stable_promotion_approvals (
  id TEXT PRIMARY KEY,
  promotion_id TEXT NOT NULL REFERENCES stable_branch_promotions(id),
  verification_id TEXT NOT NULL REFERENCES verification_runs(id),
  dev_commit TEXT NOT NULL,
  expected_main_commit TEXT NOT NULL,
  actor TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','CONSUMED','INVALIDATED')),
  created_at INTEGER NOT NULL,
  invalidated_at INTEGER
);
CREATE UNIQUE INDEX active_promotion_approval ON stable_promotion_approvals(promotion_id) WHERE status='ACTIVE';
CREATE INDEX verification_subject ON verification_runs(task_id,revision_id,tested_commit);
```

应用事务还需检查：成员同项目；execution 的实际产出与 applied revision 匹配；IntegrationBatch 的 PASSED 验证绑定固定 dev candidate；稳定提升审批引用固定 dev/main SHA 与有效验证；同一 Task 不被两个活动批次同时集成。后者 Phase 4 以 batch claims 表或等价事务锁实现，正式 migration 前补齐。main 更新后 promotion 必须记录 CLI stop/status 的重启结果，未恢复响应不能进入 SUCCEEDED。

Schema version 1 仅创建 TASK verification 所需列和复合外键，不创建 `integration_batches`、`integration_batch_items`、`stable_branch_promotions`、`stable_promotion_approvals` 或 INTEGRATION scope；Phase 4 migration 引入上述逻辑形态并补做 subject XOR 测试。version 6 已将 Phase 1 实际使用的 TASK scope 重建为带 evidence/policy/operation 列的形态，见第 8 节。

## 6. 操作日志、事件、幂等

```sql
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PLANNED','IN_PROGRESS','SUCCEEDED','FAILED','RECONCILE_REQUIRED')),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id,kind,idempotency_key)
);
```sql
CREATE TABLE domain_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT REFERENCES projects(id),      -- v34 起可空；NULL = Runtime 全局事实
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version >= 0),
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
);
CREATE TABLE event_deliveries (
  event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  consumer_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','DELIVERED','FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  PRIMARY KEY(event_id,consumer_id)
);
CREATE TABLE command_receipts (
  project_id TEXT NOT NULL REFERENCES projects(id),
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(project_id,command_id)
);
CREATE INDEX event_aggregate ON domain_events(aggregate_type,aggregate_id,aggregate_version);
CREATE INDEX delivery_retry ON event_deliveries(state,next_attempt_at);
```

domain_events 是持久事实，event_deliveries 是可变投递 outbox。相同 command ID、不同 payload 必须拒绝。事件 version 允许同一次聚合事务产生多个事实，不能错误地对 aggregateVersion 建唯一约束。

Phase 1 workspace prepare 已按此模型先事务写入 Workspace RESERVED 与 Operation PLANNED，再置 PREPARING/IN_PROGRESS 后调用 Git；成功记录 READY/SUCCEEDED 与 WorkspacePrepared。确定未进入副作用的失败可记 FAILED/RELEASED，副作用可能部分发生则保守记 RECONCILE_REQUIRED/RECOVERY_REQUIRED。Runtime 启动时自动扫描 workspace 与 Agent start Operation，不盲目重放外部副作用。

Execution 预留在单事务中固定 current revision/workspace/base/adapter/attempt，将 workspace READY→IN_USE 与 Task READY→RUNNING。Event delivery worker 为消费者补齐 outbox 行，按 sequence 处理 PENDING/到期 FAILED，并持久化 attempt、错误与下一重试时间；它是至少一次投递，消费者仍须按 eventId 去重。

## 7. Self Evolution（Phase 7 预留逻辑表）

- `candidate_versions(id, self_task_id FK, source_commit, artifact_ref, artifact_hash, build_manifest_json, compatibility_json, state, created_at)`。
- `self_test_runs(id, candidate_id FK, isolated_data_ref, tested_artifact_hash, state, evidence_ref, started_at, ended_at)`。
- `promotion_records(id, candidate_id FK, old_version, new_version, approved_artifact_hash, actor, state, backup_ref, health_evidence_ref, created_at, completed_at)`。

Stable pointer/版本清单由 bootstrap 独立管理；Runtime 数据库不可作为唯一恢复依据。migration/备份兼容策略未确认，因此不虚构这里的最终 DDL。

## 8. Migration 与验收

Phase 1 migration 只含实际使用表；Task 创建循环 FK、revision 不可变、活动 Execution 唯一、成果 commit 授权状态/一次性活动唯一性、CAS 失败、Task verification 复合主体外键、outbox 事务回滚、重复命令至少有真实 SQLite 测试。Integration verification subject XOR 随 Phase 4 表一起加入测试。Phase 2/4 分阶段新增表和索引。

### Phase 1 Agent 配置（schema version 8，ADR-0012）

- 新增 `agent_configurations`（作用域约束 + 两个部分唯一索引）与 `executions.agent_config_json`（可空、JSON 校验）。
- 迁移为纯新增：不重建已有表，不重写历史行；旧 Execution 的该列为 NULL，表示当时没有配置记录。
- 写路径先由 Runtime 用共享 schema 校验，数据库 CHECK 是第二层，防止越界写入让后续解析永久失败。

### Phase 1 verification（schema version 6）

```sql
CREATE TABLE project_verification_policy_confirmations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  policy_state TEXT NOT NULL CHECK(policy_state IN ('ABSENT','PRESENT')),
  policy_digest TEXT,
  main_ref TEXT NOT NULL,
  main_commit TEXT NOT NULL,
  actor TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUPERSEDED')),
  confirmed_at INTEGER NOT NULL,
  superseded_at INTEGER,
  CHECK((policy_state='ABSENT' AND policy_digest IS NULL)
    OR (policy_state='PRESENT' AND policy_digest IS NOT NULL)),
  CHECK((status='ACTIVE' AND superseded_at IS NULL)
    OR (status='SUPERSEDED' AND superseded_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_active_verification_policy
  ON project_verification_policy_confirmations(project_id) WHERE status='ACTIVE';
```

`verification_runs` 在 version 6 重建（旧表在 Phase 1 从未写入）：新增 `project_id`、`operation_id`（UNIQUE FK `operations`）、`command_id`、`tested_tree`、`policy_digest`、`main_commit`、`copy_path`、`outcome_code`、`evidence_json`、`queued_at`；`tree_fingerprint` 替换为 `tested_tree`；`UNIQUE(project_id,command_id)` 保证同 command 只排队一次；CHECK 约束终态必须有 `ended_at` 与 `outcome_code`，非终态两者必为 NULL。`project_trusts` 不变：确认单独成表，重新 trust 时旧 trust 与旧确认分别置 INVALIDATED/SUPERSEDED，`invalidateProjectTrust` 同时废止确认。

验证命令内容本身**不落库为可执行配置**：`commands_json` 只保存当次冻结的策略快照供审计，执行的策略每次从 main ref 重读并与确认摘要比对。

升级前检查 schema version，未知较新版本拒绝写入。没有通过备份恢复验证前不执行破坏性 migration；Self Evolution 的跨版本回滚策略为单独准入门禁。

### Phase 1 workspace 重试与 Execution 重建（schema version 7 / 9）

**v7 `workspaceRetryMigration`（ADR-0005/0018）**：重建 `workspaces`，把列级 `path UNIQUE` 换成部分唯一索引，使失败的 workspace 可以保留历史并重试同一条路径；列与 `one_live_workspace(task_id)` 不变。`executions` 与 `result_commit_authorizations` 按名字引用 `workspaces(task_id,id)`，重建在 `PRAGMA foreign_keys=OFF` 下执行，rename 回来后重新校验。

```sql
CREATE UNIQUE INDEX one_live_workspace_path ON workspaces(path) WHERE state <> 'RELEASED';
```

**v9 `taskControlMigration`（ADR-0016，暂停/终止/归档）**：`tasks` 追加 `archived_at`（软删除，不删任何审计）与 `tasks_project_archived` 索引；重建 `executions`（`executions_v9`）以扩充 `stop_reason` 的 CHECK 并新增 `resume_from_execution_id`：

```sql
ALTER TABLE tasks ADD COLUMN archived_at INTEGER CHECK(archived_at IS NULL OR archived_at >= 0);
-- executions 重建后的关键列/约束：
stop_reason TEXT CHECK(stop_reason IN ('USER_CANCEL','USER_PAUSE','REVISION_RESTART','SHUTDOWN')),
resume_from_execution_id TEXT REFERENCES executions(id),
CHECK((state IN ('SUCCEEDED','FAILED','CANCELLED','SUPERSEDED') AND resource_held=0)
  OR (state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SUPERSEDED') AND resource_held=1)),
CHECK((state='SUCCEEDED' AND result_commit IS NOT NULL) OR (state<>'SUCCEEDED' AND result_commit IS NULL)),
CHECK(ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at);
CREATE UNIQUE INDEX one_held_execution ON executions(task_id) WHERE resource_held=1;
```

`resume_from_execution_id` 记录「这次 Execution 续接了哪个 predecessor 的 provider conversation」；provider resume 总是新建 Execution，而不是复活旧行。

### Phase 4 集成管线（schema version 10，ADR-0018）

新增持久对象，取代 §5 的逻辑 `integration_batches` / `integration_batch_items`：`projects` 追加 `dev_ref`（默认 `refs/heads/dev`，新 Task worktree 的固定基线）。

- `integration_batches(id, project_id, dev_ref, dev_commit, state, integrated_commit, merge_strategy, merged_commit, worktree_path, worktree_ownership_token, verification_id, outcome_code, detail, created_at, completed_at)`。`state CHECK IN ('CREATED','PREPARING','VERIFYING','INTEGRATING_DEV','INTEGRATED','CONFLICTED','FAILED','RECOVERY_REQUIRED')`；`CHECK(integrated_commit IS NULL OR state='INTEGRATED')`。`merged_commit` 是 Git 产生但尚未推进任何 ref 的合并提交，也是崩溃恢复的证据。
- `integration_batch_items(batch_id, project_id, task_id, revision_id, execution_id, candidate_commit, dev_commit, state, integrated_commit, detail, created_at, completed_at)`，主键 `(batch_id,task_id)`，`state CHECK IN ('PREPARED','MERGED','INTEGRATED','FAILED','CONFLICTED')`。schema v30（ADR-0053）起每批可含**多个**成员，主键形态与所有列都不变：成员的顺序是派生事实（一律按 `task_id`），不落列；终态批次里仍为 `PREPARED` 的成员就是「未处理」。
- `integration_verification_runs(...)`：与 `verification_runs` 同形的独立实体（不是同一张表），额外绑定 `batch_id`（`UNIQUE`）、`candidate_commit` 所在的 `dev_commit` 基线；`state CHECK IN ('QUEUED','RUNNING','PASSED','FAILED','ERROR','STALE')`（**没有 `CANCELLED`**，见 v17）。

### Phase 1 长命令进度（schema version 11，ADR-0019）

```sql
CREATE TABLE operation_progress (
  operation_id TEXT NOT NULL REFERENCES operations(id),
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  step_key TEXT NOT NULL CHECK(length(trim(step_key)) > 0),
  step TEXT NOT NULL CHECK(length(trim(step)) > 0),
  state TEXT NOT NULL CHECK(state IN ('STARTED','SUCCEEDED','FAILED','CANCELLED','INFO')),
  detail_json TEXT CHECK(detail_json IS NULL OR json_valid(detail_json)),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  PRIMARY KEY(operation_id,sequence),
  UNIQUE(operation_id,step_key)
) STRICT, WITHOUT ROWID;
```

`step_key` 让重放同一 commandId 不能重复追加同一步。这是 ADR-0027 的 `operation_progress_events`（v17）的前驱：v11 只记录步骤，v17 把「已发布的事实事件」单独持久化。

### Phase 1 资源回收账本（schema version 12，ADR-0021）

```sql
CREATE TABLE reclamation_records (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  operation_id TEXT NOT NULL REFERENCES operations(id),
  command_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('TASK_WORKTREE','VERIFICATION_COPY','INTEGRATION_WORKTREE')),
  resource_id TEXT NOT NULL,
  path TEXT NOT NULL,
  ownership_token TEXT,
  external_ref TEXT,
  resource_state TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('RECLAIMED','ALREADY_ABSENT','RETAINED','REFUSED','FAILED')),
  reason_code TEXT NOT NULL CHECK(length(trim(reason_code)) > 0),
  detail TEXT,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE UNIQUE INDEX one_reclamation_record_per_resource
  ON reclamation_records(operation_id,kind,resource_id);
```

append-only：后来的一次尝试追加新行，从不改写或删除旧行。

### Phase 4 稳定提升（schema version 13，ADR-0022）

取代 §5 的逻辑 `stable_branch_promotions` / `stable_promotion_approvals`：

- `stable_promotions(id, project_id, dev_ref, main_ref, candidate_commit, expected_main_commit, integration_batch_id, verification_id, verification_tested_commit, permission_mode, state, approved_dev_commit, approved_main_commit, approved_verification_id, approved_at, promoted_commit, main_worktree_path, promoting_boot_id, restart_steps_json, restart_result_json, outcome_code, detail, created_at, completed_at)`。`permission_mode CHECK IN ('FULL','STRICT')`；`state CHECK IN ('CREATED','AWAITING_APPROVAL','PROMOTING','RESTARTING','SUCCEEDED','STALE','FAILED','RECOVERY_REQUIRED')`。`promoted_commit` 只从**观察到的 ref** 写入；`CHECK(state <> 'SUCCEEDED' OR promoted_commit IS NOT NULL)`。部分唯一索引 `one_open_promotion_per_project(project_id)` 限定仍开启的状态，避免两个提升争抢同一 refs。
  状态含义在 ADR-0047 后更精确：`PROMOTING` 是「已 push 到远端 `dev` 且读回核对通过、main 检出尚未拉取」，`RESTARTING` 是「已观察到 main 检出在候选上」。v29 追加的四列（见下）与由状态+重启结果推导的 `phase` 一起把「已推送」与「已拉取」两类事实在记录与 `--json` 里分开。
- `stable_promotion_members(promotion_id, batch_id, project_id, task_id, revision_id, execution_id, candidate_commit, created_at)`，主键 `(promotion_id,task_id)`。

### Phase 3 Session incarnation 与单 writer lease（schema version 14，ADR-0023）

新增 `session_incarnations`、`session_writer_leases`、`session_handoff_requests`、`session_permission_requests`，并给 `agent_sessions` 追加 `current_incarnation_id`：

```sql
CREATE TABLE session_incarnations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  execution_id TEXT NOT NULL REFERENCES executions(id),
  incarnation_number INTEGER NOT NULL CHECK(incarnation_number > 0),
  mode TEXT NOT NULL CHECK(mode IN ('AUTOMATED_RPC','HUMAN_TUI')),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','FENCED','RECOVERY_REQUIRED','EXITED')),
  provider_pid INTEGER CHECK(provider_pid IS NULL OR provider_pid > 0),
  process_identity_json TEXT CHECK(process_identity_json IS NULL OR json_valid(process_identity_json)),
  process_tree_json TEXT CHECK(process_tree_json IS NULL OR json_valid(process_tree_json)),
  provider_session_id TEXT,
  session_storage_ref TEXT,
  predecessor_incarnation_id TEXT REFERENCES session_incarnations(id),
  command_id TEXT NOT NULL CHECK(length(trim(command_id)) > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  ended_at INTEGER,
  exit_json TEXT CHECK(exit_json IS NULL OR json_valid(exit_json)),
  UNIQUE(session_id,incarnation_number),
  UNIQUE(session_id,command_id),
  CHECK((state='EXITED' AND ended_at IS NOT NULL) OR (state<>'EXITED' AND ended_at IS NULL))
) STRICT;
CREATE TABLE session_writer_leases (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  incarnation_id TEXT NOT NULL REFERENCES session_incarnations(id),
  holder_kind TEXT NOT NULL CHECK(holder_kind IN ('AUTOMATED_RPC','TERMINAL_ATTACHMENT')),
  holder_ref TEXT NOT NULL CHECK(length(trim(holder_ref)) > 0),
  command_id TEXT NOT NULL CHECK(length(trim(command_id)) > 0),
  acquired_at INTEGER NOT NULL CHECK(acquired_at >= 0),
  released_at INTEGER,
  release_reason TEXT,
  CHECK(released_at IS NULL OR release_reason IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX one_active_session_writer_lease
  ON session_writer_leases(session_id) WHERE released_at IS NULL;
CREATE TABLE session_handoff_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  execution_id TEXT NOT NULL REFERENCES executions(id),
  incarnation_id TEXT NOT NULL REFERENCES session_incarnations(id),
  kind TEXT NOT NULL CHECK(kind IN ('TAKEOVER','RETURN')),
  state TEXT NOT NULL CHECK(state IN ('REQUESTED','FENCED','AT_SAFE_POINT','ADMITTED',
    'CANCELLED','RECOVERY_REQUIRED')),
  command_id TEXT NOT NULL CHECK(length(trim(command_id)) > 0),
  fence_active INTEGER NOT NULL CHECK(fence_active IN (0,1)),
  fence_confirmed_at INTEGER, settled_after_fence_at INTEGER, safe_point_at INTEGER,
  admitted_at INTEGER, detail TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  UNIQUE(session_id,command_id)
) STRICT;
CREATE UNIQUE INDEX one_open_session_handoff_request
  ON session_handoff_requests(session_id)
  WHERE state IN ('REQUESTED','FENCED','AT_SAFE_POINT');
CREATE TABLE session_permission_requests (
  id TEXT PRIMARY KEY,
  attention_id TEXT NOT NULL UNIQUE REFERENCES attention_requests(id),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  incarnation_id TEXT NOT NULL REFERENCES session_incarnations(id),
  provider_request_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  input_fingerprint TEXT NOT NULL, pi_mode TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('OPEN','DECIDING','ALLOW','DENY','CANCEL','STALE')),
  requested_at INTEGER NOT NULL CHECK(requested_at >= 0),
  decided_at INTEGER, decided_by TEXT,
  UNIQUE(session_id,provider_request_id)
) STRICT;
ALTER TABLE agent_sessions ADD COLUMN current_incarnation_id TEXT REFERENCES session_incarnations(id);
```

`decision='DECIDING'` 是原子 claim 的中间态：`UPDATE ... WHERE decision='OPEN' AND incarnation_id = current_incarnation_id` 决定唯一赢家，过期 incarnation 的决议被拒为 `STALE_INCARNATION`。

### Phase 2 Task 依赖（schema version 15，ADR-0024）

```sql
CREATE TABLE task_dependencies (
  dependent_task_id TEXT NOT NULL,
  prerequisite_task_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  required_revision_id TEXT NOT NULL,
  created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(dependent_task_id,prerequisite_task_id),
  CHECK(dependent_task_id <> prerequisite_task_id),
  FOREIGN KEY(project_id,dependent_task_id) REFERENCES tasks(project_id,id),
  FOREIGN KEY(project_id,prerequisite_task_id) REFERENCES tasks(project_id,id),
  FOREIGN KEY(prerequisite_task_id,required_revision_id) REFERENCES task_revisions(task_id,id)
) STRICT;
CREATE TRIGGER task_dependencies_no_update
BEFORE UPDATE ON task_dependencies BEGIN
  SELECT RAISE(ABORT,'task dependency edges are immutable; remove and add again');
END;
```

依赖钉住上游 revision；环由纯领域图在 `BEGIN IMMEDIATE` 内检验，SQLite 无法表达这一点，因此 schema 只保证双端点同项目、pinned revision 属于上游、自环禁止与边不可变。

### schema version 16 永久未使用

**v16 没有任何 migration 步骤，也永远不会补一个。** 原因是版本号是按升序 `if (version < N)` 判定的：最早占用 v17 的 lane（ADR-0027 / FOUNDATION-047）合入 `dev` 时先于预留 v16 的 lane，既有数据库因此可能已被标为 17、18 或更高。对这类库执行 `if (version < 16)` 会被整段跳过，所以「补 v16」在真实升级路径上要么不生效、要么与已应用的 schema 冲突。后续 v19/v20/v21 的注释与 ADR-0028/0031/0032 都重复了这条规矩。

### Phase 3 verification `CANCELLED` 与进度事件（schema version 17，ADR-0027）

`verification_runs` 被**重建**（`verification_runs_v17` → rename），因为 `state` 是表 CHECK 的一部分，SQLite 不能原地加宽。列、行与两个索引逐字复制：

```sql
CREATE TABLE verification_runs_v17 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  command_id TEXT NOT NULL,
  tested_commit TEXT NOT NULL,
  tested_tree TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  main_commit TEXT NOT NULL,
  commands_json TEXT NOT NULL CHECK(json_valid(commands_json) AND json_type(commands_json)='array'),
  copy_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','PASSED','FAILED','ERROR','CANCELLED','STALE')),
  outcome_code TEXT,
  evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
  queued_at INTEGER NOT NULL CHECK(queued_at >= 0),
  started_at INTEGER,
  ended_at INTEGER,
  UNIQUE(project_id,command_id),
  CHECK(ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  CHECK((state IN ('QUEUED','RUNNING') AND ended_at IS NULL AND outcome_code IS NULL)
    OR (state IN ('PASSED','FAILED','ERROR','CANCELLED','STALE')
      AND ended_at IS NOT NULL AND outcome_code IS NOT NULL)),
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id)
) STRICT;
CREATE INDEX verification_subject ON verification_runs(task_id,revision_id,tested_commit);
CREATE INDEX verification_by_task ON verification_runs(project_id,task_id,queued_at);
```

关键语义：`CANCELLED` 与其它终态一样**必须**带 `ended_at` 与 `outcome_code`，所以「未确认静止」的取消仍写不成终态（实现里 `outcome_code='CANCELLED_BY_USER'`）。`integration_verification_runs` 刻意保留自己的 CHECK（没有 `CANCELLED`）：集成验证有独立 Operation kind，`task.operation.cancel` 到不了它。

```sql
CREATE TABLE operation_progress_events (
  operation_id TEXT NOT NULL REFERENCES operations(id),
  progress_sequence INTEGER NOT NULL CHECK(progress_sequence >= 0),
  event_id TEXT NOT NULL UNIQUE,
  dedup_key TEXT NOT NULL CHECK(length(trim(dedup_key)) > 0),
  phase TEXT NOT NULL CHECK(phase IN ('STEP','OUTPUT','CANCEL','SETTLED')),
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  PRIMARY KEY(operation_id,progress_sequence),
  UNIQUE(operation_id,dedup_key)
) STRICT, WITHOUT ROWID;
```

`domain_events` 行是已交付的事实；本表补充事件日志无法表达的东西：每 Operation 单调的 `progress_sequence`（消费者可排序并丢弃陈旧进度）、`dedup_key`（重复发布同一边界是 no-op）、以及每个已发布事件一行，使投影既能按全局游标也能按 `progress_sequence` 读取。

### Phase 3 原生终端 PTY（schema version 18，ADR-0026）

```sql
CREATE TABLE session_terminals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  incarnation_id TEXT NOT NULL REFERENCES session_incarnations(id),
  helper_pid INTEGER CHECK(helper_pid IS NULL OR helper_pid > 0),
  helper_start_token TEXT,
  provider_pid INTEGER CHECK(provider_pid IS NULL OR provider_pid > 0),
  pty_slave TEXT,
  window_size TEXT NOT NULL CHECK(window_size IN ('APPLIED','NOT_APPLIED')),
  state TEXT NOT NULL CHECK(state IN ('RUNNING','RELEASED','STOPPED','RECOVERY_REQUIRED')),
  release_command_id TEXT,
  release_requested_at INTEGER,
  release_byte TEXT,
  provider_shutdown_reported_at INTEGER,
  exit_code INTEGER,
  exit_signal TEXT,
  exit_reported_at INTEGER,
  session_file TEXT,
  entries_at_start INTEGER,
  last_entry_id_at_start TEXT,
  entries_at_release INTEGER,
  last_entry_id_at_release TEXT,
  release_detail TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  ended_at INTEGER,
  UNIQUE(session_id,incarnation_id),
  CHECK((state='RUNNING') = (ended_at IS NULL))
) STRICT;
CREATE UNIQUE INDEX one_running_session_terminal
  ON session_terminals(session_id) WHERE state='RUNNING';
```

`exit_code` 只是审计：FOUNDATION-040 实测 Ctrl+D 与 SIGTERM 都是 0，因此任何判定都不得以退出码分支。`session_file` 前后差值是 release 判定的证据之一，而不是唯一证据。

```sql
CREATE TABLE session_terminal_attachments (
  id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL REFERENCES session_terminals(id),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  kind TEXT NOT NULL CHECK(kind IN ('WRITER','OBSERVER')),
  holder_ref TEXT NOT NULL CHECK(length(trim(holder_ref)) > 0),
  state TEXT NOT NULL CHECK(state IN ('ATTACHED','DETACHED')),
  cursor_at_attach INTEGER NOT NULL CHECK(cursor_at_attach >= 0),
  cursor_at_detach INTEGER,
  command_id TEXT NOT NULL CHECK(length(trim(command_id)) > 0),
  attached_at INTEGER NOT NULL CHECK(attached_at >= 0),
  detached_at INTEGER,
  detached_reason TEXT,
  UNIQUE(terminal_id,command_id),
  CHECK((state='DETACHED') = (detached_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_writer_terminal_attachment
  ON session_terminal_attachments(terminal_id) WHERE state='ATTACHED' AND kind='WRITER';
CREATE INDEX session_terminal_attachments_by_session
  ON session_terminal_attachments(session_id,attached_at);
```

每终端最多一个 `ATTACHED WRITER`（部分唯一索引），detach 记录任意多行；第二个 writer 得到稳定的 `ATTACHMENT_BUSY` 而不是排队。**PTY 原始字节不落任何表**（ADR-0010 D06）：投影只在 Runtime 有界内存里。

### Phase 3 revision 投递与启动收敛（schema version 19，ADR-0028）

```sql
CREATE TABLE task_revision_deliveries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  execution_id TEXT,                 -- 创建 revision 时正在运行的 Execution；NULL 表示当时没有运行
  session_id TEXT REFERENCES agent_sessions(id),
  incarnation_id TEXT REFERENCES session_incarnations(id),
  state TEXT NOT NULL CHECK(state IN ('PENDING','IN_FLIGHT','ACKNOWLEDGED','UNACKNOWLEDGED',
    'CHANNEL_UNSUPPORTED','TIMED_OUT','FAILED','SUPERSEDED_BY_RESTART')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  channel TEXT CHECK(channel IS NULL OR channel IN ('PROVIDER_CONVERSATION','STOP_AND_RESTART')),
  deadline_at INTEGER,
  evidence_ref TEXT,
  detail TEXT,
  superseded_by_execution_id TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  acknowledged_at INTEGER,
  UNIQUE(task_id,revision_id),
  UNIQUE(task_id,id),
  CHECK((state='ACKNOWLEDGED') = (acknowledged_at IS NOT NULL)),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id),
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id),
  FOREIGN KEY(task_id,superseded_by_execution_id) REFERENCES executions(task_id,id)
) STRICT;
CREATE INDEX task_revision_deliveries_by_task ON task_revision_deliveries(task_id,created_at,id);
CREATE INDEX unsatisfied_revision_deliveries ON task_revision_deliveries(task_id)
  WHERE state <> 'ACKNOWLEDGED' AND state <> 'SUPERSEDED_BY_RESTART';

CREATE TABLE task_revision_delivery_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES task_revision_deliveries(id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  channel TEXT NOT NULL CHECK(channel IN ('PROVIDER_CONVERSATION','STOP_AND_RESTART')),
  execution_id TEXT,
  session_id TEXT REFERENCES agent_sessions(id),
  incarnation_id TEXT REFERENCES session_incarnations(id),
  state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','ACKNOWLEDGED','UNACKNOWLEDGED',
    'CHANNEL_UNSUPPORTED','TIMED_OUT','FAILED','SUPERSEDED_BY_RESTART')),
  evidence_ref TEXT,
  error_code TEXT,
  detail TEXT NOT NULL CHECK(length(trim(detail)) > 0),
  deadline_at INTEGER,
  started_at INTEGER NOT NULL CHECK(started_at >= 0),
  ended_at INTEGER,
  UNIQUE(delivery_id,attempt_number),
  CHECK((state='IN_FLIGHT') = (ended_at IS NULL))
) STRICT;
CREATE INDEX task_revision_delivery_attempts_by_delivery
  ON task_revision_delivery_attempts(delivery_id,attempt_number);
CREATE INDEX in_flight_revision_delivery_attempts ON task_revision_delivery_attempts(deadline_at)
  WHERE state='IN_FLIGHT';
```

只有两个事实能满足投递：attempt 以 `ACKNOWLEDGED` 结束（带 Adapter 的结构化证据），或 successor Execution 行的**记录值** `applied_revision_id` 就是该 revision（ADR-0001 的停止并新建回退）。「消息发出去了」永不当作确认。

```sql
CREATE TABLE agent_session_startup_reconciliations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  execution_id TEXT NOT NULL REFERENCES executions(id),
  incarnation_id TEXT REFERENCES session_incarnations(id),
  previous_session_state TEXT NOT NULL,
  previous_execution_state TEXT NOT NULL,
  projected_session_state TEXT NOT NULL,
  projected_execution_state TEXT NOT NULL,
  observation TEXT NOT NULL CHECK(observation IN ('PROVIDER_STOPPED','PROVIDER_STILL_RUNNING',
    'PROVIDER_DESCENDANTS_ALIVE','PROVIDER_OWNERSHIP_UNVERIFIABLE','PROCESS_IDENTITY_MISSING')),
  provider_pid INTEGER,
  detail TEXT NOT NULL CHECK(length(trim(detail)) > 0),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  command_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  UNIQUE(session_id,command_id)
) STRICT;
CREATE INDEX startup_reconciliations_by_session
  ON agent_session_startup_reconciliations(session_id,recorded_at,id);
```

启动收敛的 append-only 审计：对一条 stale 的 Session/Execution 投影，实际观察到什么进程归属、据此投影成什么状态。它**永不**是「静止」的声称：`evidence_json` 固定写 `quiescenceProven: false`、`signalsSent: 0`。

### Phase 2 影响快照与确定性冲突分析（schema version 20，ADR-0031）

本节取代 §4 的逻辑 `impact_assessments` / `conflict_assessments` DDL。

```sql
CREATE TABLE project_impact_policy_confirmations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  policy_state TEXT NOT NULL CHECK(policy_state IN ('ABSENT','PRESENT','INVALID')),
  policy_digest TEXT,
  content_digest TEXT,
  error_code TEXT,
  main_ref TEXT NOT NULL CHECK(length(trim(main_ref)) > 0),
  main_commit TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUPERSEDED')),
  confirmed_at INTEGER NOT NULL CHECK(confirmed_at >= 0),
  superseded_at INTEGER,
  CHECK((policy_state='PRESENT' AND policy_digest IS NOT NULL AND content_digest IS NULL)
    OR (policy_state='INVALID' AND policy_digest IS NULL AND content_digest IS NOT NULL)
    OR (policy_state='ABSENT' AND policy_digest IS NULL AND content_digest IS NULL)),
  CHECK((status='ACTIVE' AND superseded_at IS NULL)
    OR (status='SUPERSEDED' AND superseded_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_active_impact_policy
  ON project_impact_policy_confirmations(project_id) WHERE status='ACTIVE';
```

`INVALID` 保留原始字节摘要，使「映射坏了」是被记录的**事实**，而不是被静默报成「没有映射」。

```sql
CREATE TABLE impact_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  analyzer_version TEXT NOT NULL CHECK(length(trim(analyzer_version)) > 0),
  policy_version TEXT NOT NULL CHECK(length(trim(policy_version)) > 0),
  policy_digest TEXT NOT NULL CHECK(length(policy_digest) = 64),
  case_mode TEXT NOT NULL CHECK(case_mode IN ('SENSITIVE','INSENSITIVE')),
  change_fingerprint TEXT NOT NULL CHECK(length(trim(change_fingerprint)) > 0),
  complete INTEGER NOT NULL CHECK(complete IN (0,1)),
  incomplete_reasons_json TEXT NOT NULL
    CHECK(json_valid(incomplete_reasons_json) AND json_type(incomplete_reasons_json)='array'),
  files_json TEXT NOT NULL CHECK(json_valid(files_json) AND json_type(files_json)='array'),
  important_directories_json TEXT NOT NULL CHECK(json_valid(important_directories_json)
    AND json_type(important_directories_json)='array'),
  modules_json TEXT NOT NULL CHECK(json_valid(modules_json) AND json_type(modules_json)='array'),
  global_resources_json TEXT NOT NULL CHECK(json_valid(global_resources_json)
    AND json_type(global_resources_json)='array'),
  unclassified_files_json TEXT NOT NULL CHECK(json_valid(unclassified_files_json)
    AND json_type(unclassified_files_json)='array'),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='array'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(task_id,revision_id,base_commit,analyzer_version,policy_version,change_fingerprint),
  UNIQUE(task_id,id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id),
  CHECK((complete=1) = (json_array_length(incomplete_reasons_json)=0))
) STRICT;
CREATE TRIGGER impact_snapshots_no_update BEFORE UPDATE ON impact_snapshots BEGIN
  SELECT RAISE(ABORT,'impact snapshots are append-only; record a new snapshot instead');
END;
CREATE TRIGGER impact_snapshots_no_delete BEFORE DELETE ON impact_snapshots BEGIN
  SELECT RAISE(ABORT,'impact snapshots are append-only evidence');
END;

CREATE TABLE impact_assessments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  candidate_task_id TEXT NOT NULL,
  candidate_revision_id TEXT NOT NULL,
  candidate_snapshot_id TEXT NOT NULL REFERENCES impact_snapshots(id),
  other_task_id TEXT NOT NULL,
  other_revision_id TEXT NOT NULL,
  other_snapshot_id TEXT NOT NULL REFERENCES impact_snapshots(id),
  verdict TEXT NOT NULL CHECK(verdict IN ('SAFE_TO_PARALLELIZE','UNKNOWN','CONFLICTING')),
  reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json)
    AND json_type(reason_codes_json)='array'),
  hits_json TEXT NOT NULL CHECK(json_valid(hits_json) AND json_type(hits_json)='array'),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='array'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  CHECK(candidate_snapshot_id <> other_snapshot_id),
  UNIQUE(candidate_snapshot_id,other_snapshot_id)
) STRICT;
CREATE TRIGGER impact_assessments_no_update BEFORE UPDATE ON impact_assessments BEGIN
  SELECT RAISE(ABORT,'impact assessments are append-only; a changed fact needs a new snapshot');
END;
CREATE TRIGGER impact_assessments_no_delete BEFORE DELETE ON impact_assessments BEGIN
  SELECT RAISE(ABORT,'impact assessments are append-only evidence');
END;
```

快照的唯一键就是「能否复用」的判据：`(task, revision, base, analyzer, policy, change fingerprint)`。Task 修订、基线移动、映射编辑、分析器换代、观测到的 diff 变大，都产生**新行**，旧行保留做审计且永不被再次选中。配对判定按两个 snapshot 唯一，没有任何列能把已记录的 `SAFE` 改成别的值。

### Phase 2 容量与槽位预留（schema version 21，ADR-0032；**v34 起前两张配置表已退役**）

> 下表是 v21 的历史实现记录：`project_capacity_limits` 与 `project_adapter_slot_limits` 已由 schema v34（ADR-0061 D03）
> 迁移取最小值后退役，新的唯一上限在 `runtime_capacity_settings`（见下文「Runtime 唯一全局容量」）。
> `execution_slot_reservations` / `execution_slot_reservation_events` 仍属当前实现，只是容量判定改为全 Runtime 计数。

```sql
CREATE TABLE project_capacity_limits (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  global_limit INTEGER NOT NULL CHECK(global_limit > 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  updated_by TEXT NOT NULL CHECK(length(trim(updated_by)) > 0)
) STRICT;
CREATE TABLE project_adapter_slot_limits (
  project_id TEXT NOT NULL REFERENCES projects(id),
  adapter_id TEXT NOT NULL CHECK(length(trim(adapter_id)) > 0),
  slot_limit INTEGER NOT NULL CHECK(slot_limit > 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  updated_by TEXT NOT NULL CHECK(length(trim(updated_by)) > 0),
  PRIMARY KEY(project_id,adapter_id)
) STRICT;
```

没有行 = 未显式设置：读取返回文档默认值（项目全局 2，上限 16），adapter 缺省等于该项目的当前全局上限，因此「跟随全局」是**派生事实**而不是复制的数字。

```sql
CREATE TABLE execution_slot_reservations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  revision_id TEXT NOT NULL,
  task_version INTEGER NOT NULL CHECK(task_version >= 0),
  adapter_id TEXT NOT NULL CHECK(length(trim(adapter_id)) > 0),
  workspace_id TEXT,
  impact_snapshot_id TEXT,          -- 调用方声明的快照 id；跨表代重检尚未实现（Wave F）
  dependency_fingerprint TEXT NOT NULL CHECK(length(trim(dependency_fingerprint)) > 0),
  assessed_dev_commit TEXT,
  state TEXT NOT NULL CHECK(state IN ('RESERVED','RELEASED','RECOVERY_REQUIRED')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  command_id TEXT NOT NULL CHECK(length(trim(command_id)) > 0),
  holder_boot_id TEXT NOT NULL CHECK(length(trim(holder_boot_id)) > 0),
  holder_pid INTEGER NOT NULL CHECK(holder_pid > 0),
  holder_start_token TEXT,
  holder_actor TEXT NOT NULL CHECK(length(trim(holder_actor)) > 0),
  reserved_at INTEGER NOT NULL CHECK(reserved_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= reserved_at),
  released_at INTEGER,
  release_reason TEXT,
  release_kind TEXT CHECK(release_kind IS NULL OR release_kind IN
    ('EXPLICIT','RECONCILED_HOLDER_EXITED','RECONCILED_PROCESS_ID_REUSED')),
  release_observation TEXT CHECK(release_observation IS NULL OR release_observation IN
    ('HOLDER_STOPPED','HOLDER_PROCESS_ID_REUSED','HOLDER_STILL_RUNNING',
      'HOLDER_OWNERSHIP_UNVERIFIABLE','PROCESS_IDENTITY_MISSING')),
  detail TEXT,
  UNIQUE(project_id,command_id),
  UNIQUE(task_id,id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id),
  FOREIGN KEY(task_id,workspace_id) REFERENCES workspaces(task_id,id),
  CHECK((state='RESERVED' AND released_at IS NULL AND release_reason IS NULL AND release_kind IS NULL)
    OR (state='RELEASED' AND released_at IS NOT NULL AND release_reason IS NOT NULL
      AND release_kind IS NOT NULL)
    OR (state='RECOVERY_REQUIRED' AND released_at IS NULL AND release_reason IS NULL
      AND release_kind IS NULL))
) STRICT;
CREATE UNIQUE INDEX one_active_slot_reservation ON execution_slot_reservations(task_id)
  WHERE state IN ('RESERVED','RECOVERY_REQUIRED');
CREATE UNIQUE INDEX one_active_workspace_reservation
  ON execution_slot_reservations(project_id,workspace_id)
  WHERE state IN ('RESERVED','RECOVERY_REQUIRED') AND workspace_id IS NOT NULL;
```

两个部分唯一索引把不变量变成 schema 事实：每 Task 一个活跃预留、一个 worktree 不被两个活跃预留占用。归属证据是 Runtime `bootId` + `pid` + 该 pid 的 OS start token（**不是**「这行是我建的」）。

```sql
CREATE TABLE execution_slot_reservation_events (
  reservation_id TEXT NOT NULL REFERENCES execution_slot_reservations(id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  kind TEXT NOT NULL CHECK(kind IN ('RESERVED','RELEASED','RECONCILE_OBSERVED')),
  domain_event_id TEXT,
  command_id TEXT NOT NULL CHECK(length(trim(command_id)) > 0),
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  detail TEXT NOT NULL CHECK(length(trim(detail)) > 0),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
  PRIMARY KEY(reservation_id,sequence),
  UNIQUE(reservation_id,command_id)
) STRICT, WITHOUT ROWID;
```

append-only：预留行持有被比较与交换的当前状态，而每一次观测——包括「决定保持占用、什么都没变」的 reconcile——都追加在这里，从不改写。`UNIQUE(reservation_id,command_id)` 让同一代重复 reconcile 幂等。

### Phase 1 失败后的显式重试（schema version 23，ADR-0036）

只加两列，不重建任何表：

```sql
ALTER TABLE tasks ADD COLUMN pending_retry_from_execution_id TEXT REFERENCES executions(id);
ALTER TABLE executions ADD COLUMN retry_from_execution_id TEXT REFERENCES executions(id);
```

`pending_retry_from_execution_id` 是「这个 Task 正被显式重试、来源是哪次失败 Execution」的持久意图；`retry_from_execution_id`
把新 Execution 与它要接替的那次失败绑定。`FAILED → READY` **不是自动的**：只有 `task.retry` 才写这两列并产生
`TaskRetryRequested`（见 `event-model.md`），因此「重试排队」与「新 Execution」不可分开观察。

### 未注册目录的回收处置（schema version 24，ADR-0037）

`reclamation_records` 被**重建**（既有行逐行复制、两个索引重建），因为要表达 ADR-0021 明确拒绝过的一类事实：

```sql
-- 与 v12 的关键差异
source TEXT NOT NULL DEFAULT 'REGISTERED'
  CHECK(source IN ('REGISTERED','UNREGISTERED_DIRECTORY'));
kind TEXT NOT NULL CHECK(kind IN ('TASK_WORKTREE','VERIFICATION_COPY','INTEGRATION_WORKTREE',
  'UNREGISTERED_DIRECTORY'));
task_id TEXT REFERENCES tasks(id);   -- 从 NOT NULL 变为可空
outcome TEXT NOT NULL CHECK(outcome IN ('RECLAIMED','ALREADY_ABSENT','RETAINED','REFUSED','FAILED',
  'RECOVERY_REQUIRED'));
CREATE INDEX reclamation_records_by_source ON reclamation_records(source,created_at,id);
CREATE UNIQUE INDEX one_reclamation_record_per_resource
  ON reclamation_records(operation_id,kind,resource_id);
```

三点理由（与 `migration.ts` 的注释一致）：`source` 让「已登记资源」与「未登记目录」可按来源读回，不必从 reason code 猜；
`task_id` 变可空是因为残留的 `verifications/<project>/<id>` 目录只有项目、没有可诚实归属的 Task，编造一个正是这个能力绝不能做的
假归属；`outcome` 增加 `RECOVERY_REQUIRED`，是「无法核验归属」（目录内有活进程、Git 状态不可读、项目未知）的诚实结局。既有行按
原样复制并标 `REGISTERED`。没有任何外键引用 `reclamation_records`，所以开外键重建是安全的。

### 分层验证证据（schema version 25，ADR-0038 / ADR-0039）

`verification_runs` 只加四列（不重建），并新增两张表：

```sql
ALTER TABLE verification_runs ADD COLUMN policy_source TEXT NOT NULL DEFAULT 'PROJECT_POLICY'
  CHECK(policy_source IN ('PROJECT_POLICY','TARGETED_TEST_PLAN'));
ALTER TABLE verification_runs ADD COLUMN plan_id TEXT;
ALTER TABLE verification_runs ADD COLUMN plan_version TEXT;
ALTER TABLE verification_runs ADD COLUMN plan_digest TEXT;

CREATE TABLE targeted_test_plans ( ... ) STRICT;      -- append-only（UPDATE/DELETE trigger RAISE(ABORT)）
CREATE TABLE dev_full_suite_evidence ( ... ) STRICT;  -- 每次运行一行，终态必须带 ended_at/outcome_code
CREATE UNIQUE INDEX one_targeted_test_plan_per_subject
  ON targeted_test_plans(project_id,task_id,revision_id,tested_commit,plan_digest);
CREATE INDEX dev_full_suite_evidence_by_commit
  ON dev_full_suite_evidence(project_id,dev_commit,queued_at DESC);

ALTER TABLE stable_promotions ADD COLUMN full_suite_evidence_id TEXT REFERENCES dev_full_suite_evidence(id);
ALTER TABLE stable_promotions ADD COLUMN full_suite_dev_commit TEXT;
ALTER TABLE stable_promotions ADD COLUMN full_suite_policy_version TEXT;
ALTER TABLE stable_promotions ADD COLUMN full_suite_policy_digest TEXT;
ALTER TABLE stable_promotions ADD COLUMN full_suite_lockfile_digest TEXT;
ALTER TABLE stable_promotions ADD COLUMN approved_full_suite_evidence_id TEXT;
```

- `targeted_test_plans` 是某个分支的 `.codeestra/tests.json` 与它被选定时的精确 `(task, revision, commit, digest)` 的 append-only
  绑定。验证消费的是**已记录的计划**，绝不读当下的文件，所以扩大或缩小范围是一次显式、可审计的追加，而不是静默编辑；`UPDATE`/
  `DELETE` 被 trigger 拒绝，理由与 `task_dependencies`、`task_revisions` 相同——就地改掉的计划会让它曾经支撑的证据不可审计。
- `dev_full_suite_evidence` 是 `dev → main` 要求的独立证据：绑定候选 commit、项目 `main` ref 上的固定策略（`policy_digest`）与该
  commit 的 lockfile。`lockfile_present` 把「没有 lockfile」也显式绑定（记 0 + 空字节的 digest），因此以后新增 lockfile 是一个不同
  的绑定而不是静默变弱；终态 `CHECK` 保证未完成的运行不能被读成通过；重跑总是插新行，因此「哪一次运行支撑了这次提升」保持精确。
- `verification_runs.policy_source` 记录它实际跑的是固定项目策略还是分支定向计划——`policy_digest` 本身说不清这件事。

### 迁移执行顺序与共享槽位后果

`Phase1Database.migrate()` 按 `if (version < N)` 升序执行 v1…v30（跳过 v16、v22），最后写
`PRAGMA user_version=${phase1SchemaVersion}`。升级前 schema version 大于 `phase1SchemaVersion` 时以 `UNSUPPORTED_SCHEMA` 拒绝写入。

已知后果（ADR-0032 记录）：单个 lane 合并后，**已经被标成更高版本号的库不会补跑后来出现的更低版本步骤**。跨格合并必须按既定顺序
（E0 → E1 → E2；以及 Wave D 的 17 → 18 → 19）。这也是 v16 永久未使用的同一个根因。

版本占用现状（以 `packages/storage/src/migration.ts` 为准，不提前创建未来表）：v22 未占用；v16 永久未使用；v23–v30 已实现
（v23 `task retry`/ADR-0036，v24 未注册目录回收/ADR-0037，v25 分层验证证据/ADR-0038+ADR-0039，v26 项目知识/ADR-0041，
v27 Agent 插件选择/ADR-0044，v28 `intents.kind` 收窄/ADR-0046，v29 dev clone 与经 GitHub 中转的提升/ADR-0047，
v30 多成员 IntegrationBatch 的两个终态/ADR-0053）。当前 `phase1SchemaVersion = 30`。

### 经 GitHub 中转的提升与 dev clone（schema version 29，ADR-0047）

两步纯 `ALTER TABLE ... ADD COLUMN`，**不重建任何表**，因此既有行原样保留（`projects` 的 `CHECK` 只拒绝空字符串，
「没有 dev clone」与「有 dev clone」都是合法事实）：

```sql
ALTER TABLE projects ADD COLUMN dev_repo_path TEXT
  CHECK(dev_repo_path IS NULL OR length(trim(dev_repo_path)) > 0);

ALTER TABLE stable_promotions ADD COLUMN dev_repo_path TEXT;
ALTER TABLE stable_promotions ADD COLUMN remote_dev_commit TEXT;
ALTER TABLE stable_promotions ADD COLUMN remote_main_commit TEXT;
ALTER TABLE stable_promotions ADD COLUMN pushed_at INTEGER;
ALTER TABLE stable_promotions ADD COLUMN main_pushed_at INTEGER;
```

- `remote_dev_commit` / `remote_main_commit` 是 `git ls-remote` 的**读回值**，不是 push 的输入：只有 push 结束后读回并
  与固定候选逐字符相等，记录才会写这两个字段。这是「push 命令退出码为 0」不能当证据（ADR-0047 D02）在数据结构上的落点。
- 提升记录因此同时绑定**本地候选 SHA**（`candidate_commit`）与**读回的远端 `dev` SHA**（`remote_dev_commit`）；远端 `dev` 后来
  移到别的 SHA 时 `prepare/approve/promote` 全部拒绝并把记录标 `STALE`，不移动任何 ref。
- `phase`（`READY_TO_PUSH` / `AWAITING_PULL` / `RESTART_PENDING` / `MAIN_PUSH_PENDING` / `COMPLETE` / `REFUSED`）不是列，
  而是从 `state` 与 `restart_result_json` 推导的投影：同一事实只有一个来源，不会出现状态机与派生字段互相矛盾。

### 多成员 IntegrationBatch 的批级终态（schema version 30，ADR-0053）

只加宽 `integration_batches.state` 的 `CHECK`，**不加列、不加表、不改成员状态集合**。`STRICT` 表的 `CHECK`
不能就地加宽，因此这一步**重建**该表，并按 v28 `intents` 的先例在 `database.ts` 里做前置校验与**行数核对**
（Bun 的 `exec()` 会吞掉多语句脚本里的 step 错误并继续执行后面的 `DROP TABLE`，行数比对把「静默丢行」变成回滚）：

```sql
CREATE TABLE integration_batches_v30 ( ... 同列，state CHECK 追加 'STALE','CANCELLED' ... ) STRICT;
INSERT INTO integration_batches_v30(...) SELECT ... FROM integration_batches;
DROP TABLE integration_batches;
ALTER TABLE integration_batches_v30 RENAME TO integration_batches;
CREATE INDEX integration_batches_by_project ON integration_batches(project_id,created_at,id);
```

- 两个新取值都是**纯加宽**，因此所有既有行本来就满足新的 `CHECK`：既不做数据改写，也不需要「无法表达的行」前置拒绝。
- 旧表在**新表改名之前**被删除，且没有别的表被改名，所以按名字引用它的 `integration_batch_items`、
  `integration_verification_runs`、`stable_promotions` 继续解析到同一个名字；迁移在 `PRAGMA foreign_keys=OFF`
  下运行（`rebuildsTable = version < 30`），结束后跑 `PRAGMA foreign_key_check` 并要求为空。
- 语义：`STALE` = 固定证据已过期（成员证据移动或 `dev` 基线移动），**不推进 ref**；`CANCELLED` = 用户在记录可证明
  无副作用时结束批次（零确认）。两者都写 `completed_at` 与 `outcome_code`，`integrated_commit` 保持 `NULL`
  （既有 `CHECK(integrated_commit IS NULL OR state='INTEGRATED')` 不变）。
- `integration_batch_items`、`integration_verification_runs` **没有** schema 变化：批次的成员清单本来就以
  `(batch_id,task_id)` 落行，一次集成的验证证据在 `evidence_json.members` 里带 `taskVerificationId`/
  `taskVerificationTestedCommit`。

### Phase 6 项目知识分层与 Execution 绑定（schema version 26，ADR-0041）

新增两张 **append-only** 表，**不重建 `executions`、不新增列**：

```sql
CREATE TABLE knowledge_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  main_ref TEXT NOT NULL CHECK(length(trim(main_ref)) > 0),
  main_commit TEXT NOT NULL CHECK(length(trim(main_commit)) > 0),
  policy_version TEXT NOT NULL CHECK(length(trim(policy_version)) > 0),
  snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 64),
  human_digest TEXT NOT NULL CHECK(length(human_digest) = 64),
  generated_digest TEXT NOT NULL CHECK(length(generated_digest) = 64),
  entry_count INTEGER NOT NULL CHECK(entry_count >= 0),
  human_entry_count INTEGER NOT NULL CHECK(human_entry_count >= 0),
  generated_entry_count INTEGER NOT NULL CHECK(generated_entry_count >= 0),
  total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0),
  entries_json TEXT NOT NULL CHECK(json_valid(entries_json)),
  created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  CHECK(entry_count = human_entry_count + generated_entry_count)
) STRICT;
CREATE UNIQUE INDEX one_knowledge_snapshot_per_state
  ON knowledge_snapshots(project_id,main_commit,snapshot_digest);
CREATE INDEX knowledge_snapshots_by_project ON knowledge_snapshots(project_id,created_at,id);
-- knowledge_snapshots_no_update / knowledge_snapshots_no_delete：UPDATE 与 DELETE 一律 RAISE(ABORT)

CREATE TABLE execution_knowledge_snapshots (
  execution_id TEXT PRIMARY KEY REFERENCES executions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 64),
  context_path TEXT NOT NULL CHECK(length(trim(context_path)) > 0),
  context_digest TEXT NOT NULL CHECK(length(context_digest) = 64),
  context_bytes INTEGER NOT NULL CHECK(context_bytes >= 0),
  entry_count INTEGER NOT NULL CHECK(entry_count >= 0),
  refs_json TEXT NOT NULL CHECK(json_valid(refs_json)),
  command_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE INDEX execution_knowledge_snapshots_by_snapshot
  ON execution_knowledge_snapshots(snapshot_id,created_at,execution_id);
CREATE INDEX execution_knowledge_snapshots_by_task
  ON execution_knowledge_snapshots(project_id,task_id,created_at,execution_id);
-- execution_knowledge_snapshots_no_update / _no_delete：同上
```

设计要点：

- `knowledge_snapshots` 的键是它**派生自的事实**（`project` + `main_commit` + `snapshot_digest`），因此同一份声明重复记录是复用一行，而知识文件变化必然是另一行。`entries_json` 保存逐条 `{layer,path,id,scope,digest,bytes,origin}`（不含正文），使「这个 Execution 用了哪些条目、各自内容 digest 是多少」可在事后完整读回。
- `execution_knowledge_snapshots` 以 `execution_id` 为主键（一个 Execution 恰好用一个快照），`context_path`/`context_digest`/`context_bytes` 记录物化到 `<CODEESTRA_HOME>/knowledge/<project-id>/<task-id>/knowledge-context.md` 的确切字节。绑定不可改写：重复写同一绑定是重放，写**不同**的快照是 `COMMAND_CONFLICT` 而不是静默更新。
- 绑定的插入在 `reserveExecution` 的**同一事务**内完成，因此「Execution 存在」与「已绑定所用知识」不可分开观察；插入失败时整个保留事务回滚（实测：Execution 行、绑定行均为 0，Task 回到 `READY`）。
- 为什么是两张新表而不是给 `executions` 加列：新表 + 事务内插入给出同样的原子性，而没有表重写的风险，且既有历史行原样保留（ADR-0041 D07）。

### Phase 5 Agent 插件 / 资源选择（schema version 27，ADR-0044）

只加一列，不重建任何表：

```sql
ALTER TABLE agent_configurations ADD COLUMN plugin_selection_json TEXT
  CHECK(plugin_selection_json IS NULL OR json_valid(plugin_selection_json));
```

选择是一份列表（extensions / skills / prompt templates / themes 四类），因此不能塞进既有的三个标量覆盖列。`ALTER TABLE ... ADD COLUMN`
保留每一行（含两个部分唯一索引）原样，本能力之前的历史行只是没有选择。语义是**整体替换**：一个作用域的选择替换低优先级作用域的整份列表，
每个选中路径在写入前核验一次、在 Session 启动前再核验一次，无法加载的路径以稳定码拒绝且不创建 Execution（`agent.config.*` 的
profile 细节见 `agent-adapter-api.md`）。`executions.agent_config_json` 同时记录该次启动实际带上的 `plugins`，供事后读回。

### `intents.kind` 收窄（schema version 28，ADR-0046）

第 2 节里 `intents.kind` 仍写着 v1 的七个取值；实际实现的 CHECK 自 v28 起是五个（v1 的迁移文本一字未改，历史不重写）：

```sql
-- CREATE TABLE intents_v28 与 v1 的 intents 逐列相同，只有 kind 的 CHECK 不同：
kind TEXT CHECK(kind IN ('CREATE_TASK','AMEND_TASK','ADD_CONSTRAINT','CANCEL_TASK',
  'ANSWER_AGENT')),
-- 复制 → DROP TABLE intents → ALTER TABLE intents_v28 RENAME TO intents
```

SQLite 不能就地收窄 CHECK，所以重建表。`intents` 被三张表按名字引用（`task_revisions.source_intent_id`、`intent_targets.intent_id`
（`WITHOUT ROWID` 复合主键）、`intent_attention_targets.intent_id`），因此这一步与 v7/v9 同类：重建期间 `PRAGMA foreign_keys=OFF`，
迁移后 `PRAGMA foreign_key_check` 必须为空（`migrate()` 的 `rebuildsTable` 谓词因此从 `version < 9` 放宽到 `version < 28`）。
重建前的键照旧：主键索引 + `UNIQUE(project_id,idempotency_key)`；v27 的 `intents` 上没有任何触发器，v28 也不新增。

**不静默丢数据**（ADR-0046 D04）：升级前若 `intents` 里还有被移除取值（`CHANGE_PRIORITY` / `SELF_MODIFICATION`）的行，
以稳定码 `INVALID_STATE` 拒绝升级、原库一行不动；升级后再比对重建前后的行数（实测 Bun 的 `Database.exec()` 会吞掉多语句脚本里的
step-time 错误，不比对就可能让 `DROP TABLE` 在复制被拒后照跑）。`tasks.priority` 由 v1 保留、字段与 `tasks_schedule` 索引不变，
但移除 `CHANGE_PRIORITY` 后**没有任何命令能让它非 0**，因此 ADR-0030 的「priority desc」在现状下是惰性的（这是如实记录的代价）。
Phase 7 落地 `SELF_MODIFICATION` 时需要再做一次迁移把取值加回来。

### `workspaces.base_ref`：Task 基线的 ref 逐 Task 记录（schema version 33，ADR-0060）

```sql
ALTER TABLE workspaces ADD COLUMN base_ref TEXT
  CHECK(base_ref IS NULL OR length(trim(base_ref)) > 0);
```

ADR-0060 之前，一个 Task 的基线 ref 只有一个可能：项目行的 `projects.dev_ref`（`refs/heads/dev`），所以它不必逐行记录。
被管理项目（没有 dev clone）的基线改为**项目文件夹当前检出的分支**之后，ref 是**建 workspace 那一刻**决定的，可能逐 Task
不同（检出分支换了、或调用者显式给了 `--base-ref`），因此必须随 workspace 行一起记下来。`base_commit` 早已是 NOT NULL
的列，这里只补它的来源 ref。

- 纯 `ADD COLUMN`：不重建表、不动 `one_live_workspace` / `one_live_workspace_path` 两个部分唯一索引，v17–v32 的库直接升级。
- 读取处一律 `COALESCE(workspace.base_ref, projects.dev_ref)`：`NULL` 表示「这一行写于 v33 之前」，那时 dev ref 就是基线，
  于是历史记录仍然如实；升级不发明数据、不改写任何已有行。
- 有 dev clone 的项目行为不变（写入的仍是那个 clone 的 `refs/heads/dev`）；managed 项目写入项目文件夹当时检出的分支。

### Runtime 唯一全局容量与 Provider 冻结（**已实现**：schema version 34，FOUNDATION-096 + FOUNDATION-097 / ADR-0061）

> **两半合成一个版本号。** 两条并行分支各自在 v34 追加了自己的块，集成时合并为**一个** `if (version < 34)` 步骤：
> 容量半边（`runtime_capacity_settings`、退役两张旧配置表、`runtime_command_receipts`、`domain_events.project_id` 可空）
> 与暂停半边（`runtime_pause_control`、`runtime_pause_targets`）。`runtime_command_receipts` 与 `domain_events` 重建在
> `migration.ts` 里**各只有一份**（容量半边拥有），暂停半边不重复它们。
> `runtime_capacity_settings` 仍遵循「没有行 = 从未显式设置」→ 默认 2；`runtime_pause_control` 相反，迁移**总是**写入
> singleton 行（`RUNNING`, epoch 0），因为「没有行」不能被读成「继续」。


本版本号的持久事实（两半都已实现，见上面的说明）：

```sql
CREATE TABLE runtime_capacity_settings (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  global_limit INTEGER NOT NULL CHECK(global_limit BETWEEN 1 AND 16),
  version INTEGER NOT NULL CHECK(version >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  updated_by TEXT NOT NULL CHECK(length(trim(updated_by)) > 0)
) STRICT;

CREATE TABLE runtime_command_receipts (
  command_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
```

没有行 = 未显式设置：读取返回文档默认值 **2**，`limitSource = 'DEFAULT'`；`set` 写行，`reset` 删行（写行 2 会把用户
没做过的决定记成 `EXPLICIT`）。`runtime_command_receipts` 给**不属于任何 Project** 的全局命令提供与
`command_receipts` 相同的幂等语义（同 commandId 重放同结果、同键异文拒绝）；它不能复用 `command_receipts`，
因为那张表的 `project_id` 是 NOT NULL。

**旧容量迁移是确定性的，且整笔原子**（见 `runtimeGlobalCapacityMigration` 与 `Phase1Database.migrateRuntimeGlobalCapacity`）：
读取 `project_capacity_limits.global_limit` 与 `project_adapter_slot_limits.slot_limit` 的**全部显式值**；
有值则 `MIN(all values)` 写入 singleton（并写一条 `source='MIGRATED_MINIMUM'` 的全局事件），一个都没有则不写行、默认 2 生效；
随后**同一脚本**重建 `domain_events` 并 DROP 两张旧配置表。值不在 1–16 内、或任一步骤失败，都在同一个
事务里整笔回滚（先读值、后删表，所以旧值不会先被删掉）；迁移后核对新值、`domain_events` 与 `event_deliveries` 行数，
并执行 `PRAGMA foreign_key_check`。reservation / Execution / 历史事件一行不改，`SchedulerCapacityChanged` 保留。

**全局事件**：`domain_events.project_id` 由 `NOT NULL REFERENCES projects(id)` 重建为可空 FK（create → copy → drop → rename，
复制保留原 `sequence`/event_id/payload，`AUTOINCREMENT` 状态也随之保留）；`NULL` 只表示 Runtime 全局事实，
不是「未知 Project」。`event_deliveries.event_id` 引用在新表接管名字后继续有效。Project 过滤读取改为
`(project_id = ? OR project_id IS NULL)`。

全局暂停（下半）的持久事实与状态一致性约束（`PENDING`/`STOPPED`/`RECOVERY_REQUIRED` 跨表约束、无 FK 的身份快照、
purge 前收口等）**已实现**：

```sql
CREATE TABLE runtime_pause_control (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  state TEXT NOT NULL CHECK(state IN
    ('RUNNING','PAUSING','PAUSED','RESUMING','RECOVERY_REQUIRED')),
  pause_epoch INTEGER NOT NULL CHECK(pause_epoch >= 0),
  version INTEGER NOT NULL CHECK(version >= 0),
  requested_at INTEGER,
  requested_by TEXT,
  settled_at INTEGER,
  detail_json TEXT CHECK(detail_json IS NULL OR json_valid(detail_json))
) STRICT;

CREATE TABLE runtime_pause_targets (
  id TEXT PRIMARY KEY,
  pause_epoch INTEGER NOT NULL CHECK(pause_epoch > 0),
  -- 这些 ID 是冻结当时的身份快照，刻意不加 FK：task purge 可以删除业务聚合，
  -- 但 Runtime 仍需保留 pause epoch 的进程恢复/审计事实。
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  incarnation_id TEXT NOT NULL,
  provider_pid INTEGER NOT NULL CHECK(provider_pid > 0),
  provider_start_token TEXT NOT NULL CHECK(length(trim(provider_start_token)) > 0),
  state TEXT NOT NULL CHECK(state IN
    ('PENDING','STOPPED','RESUMED','EXITED','RECOVERY_REQUIRED')),
  observation_json TEXT NOT NULL CHECK(json_valid(observation_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  UNIQUE(pause_epoch,incarnation_id)
) STRICT;
```

实现与本节语义一致；列名与约束以 `runtimePauseControlMigration` 为准，必须保持：singleton、pause epoch、逐 incarnation process identity、目标状态、同命令幂等与同键异文拒绝。

**状态一致性（下半）**：

- `RUNNING` 时不得有 `PENDING`/`STOPPED` 目标；`PAUSED` 时本 epoch 不得有 `PENDING`/`RECOVERY_REQUIRED`；这些跨表约束由同一 immediate transaction 的 storage service 强制并以故障注入测试覆盖。
- 已实现的迁移在提交前除行数核对外，还断言**结束态**（`domain_events.project_id` 确实可空、singleton 控制行确实存在）：
  Bun 的 `exec()` 会吞掉多语句脚本里的 step 错误，只比行数会漏掉「复制之后才失败」的情形。
- `RECOVERY_REQUIRED` 仍保持全局启动屏障；target 行不因超时、心跳或 Runtime 重启自动删除/改成 `EXITED`。
- `runtime_pause_targets` 不是 Session 状态来源，不得据它把 Session 写回 ACTIVE/PAUSED；Session/Execution 的重启收敛仍走既有表与 ADR-0028。它的五个业务 ID 刻意是无 FK 的身份快照：`task purge` 删除 Task 聚合后，本 pause epoch 的进程控制/审计事实仍必须保留；purge 前仍须按 ADR-0058 证明 provider 已停止，并把对应 target 如实收口。
