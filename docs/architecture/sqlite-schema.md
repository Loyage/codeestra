# SQLite Schema

状态：逻辑 SQL 设计基线；`packages/storage/src/migration.ts` 已落地到 schema version 7 的 Phase 1 子集；ADR-0010 的多 process-incarnation Session、guidance/takeover/terminal 表仅是 Phase 3 逻辑设计，尚未进入 migration。本文不是对外发布 migration，未来字段与表不提前创建。后续 Drizzle schema 必须与下面的约束等价。

## 1. 约定

- TEXT UUID；INTEGER UTC milliseconds；布尔 INTEGER CHECK IN (0,1)。Git OID 按 repo object format 在应用边界校验。
- 每连接 `PRAGMA foreign_keys=ON`、`busy_timeout=5000`；本地文件采用 WAL。数据库不放网络文件系统。
- JSON TEXT 附加 `json_valid` 并由 Zod 检验结构；不将结构化关系全部塞进 JSON。
- aggregate version 通过 `UPDATE ... WHERE version = expectedVersion` CAS；更新行数非 1 为并发冲突。
- 默认不级联删除审计与成果记录。归档、日志期限、数据库压缩后续设计；未获授权不自动回收证据。
- 下列 state 的合法值由对应 `state-machines.md` 的同名状态集合生成 CHECK；示例中对长枚举以应用校验说明，不把省略的 CHECK 当作已完整 migration。正式 migration 必须补齐并测试。

## 2. 身份、意图、任务与 DAG

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_root TEXT NOT NULL UNIQUE,
  git_common_dir TEXT NOT NULL UNIQUE,
  main_ref TEXT NOT NULL,
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
  UNIQUE(task_id,attempt_number),
  UNIQUE(task_id,id),
  FOREIGN KEY(task_id,initial_revision_id) REFERENCES task_revisions(task_id,id),
  FOREIGN KEY(task_id,applied_revision_id) REFERENCES task_revisions(task_id,id),
  FOREIGN KEY(task_id,workspace_id) REFERENCES workspaces(task_id,id)
);
CREATE UNIQUE INDEX one_held_execution ON executions(task_id) WHERE resource_held=1;
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

Agent adapter_id 的权威来源为 Execution，不在多处维护可能不一致的主 Agent。provider session ID 是否跨项目唯一由 Adapter 决定，数据库不擅自全局唯一。ADR-0010 允许一个 Execution 因 RPC↔TUI 进程交接拥有多条 AgentSession，但活动 Session 部分唯一；predecessor 必须属于同一 Execution。旧 process identity/退出事实保留，新进程使用新 Codeestra session ID。Phase 3 migration 实现前，现有 version 7 的 `execution_id UNIQUE` 仍代表“每 Execution 单 Session”，不能声称已支持接管。

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
CREATE TABLE domain_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  occurred_at INTEGER NOT NULL,
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
