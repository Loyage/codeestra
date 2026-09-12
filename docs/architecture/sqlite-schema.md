# SQLite Schema

状态：逻辑 SQL 设计基线，不是已发布 migration。Phase 0/1 只落地该阶段需要的子集；未来字段与表不提前创建。Drizzle schema 必须与下面的约束等价。

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

创建 Task 与首 Revision 必须在同一事务，延迟 FK 于 commit 检验。Revision append-only 由 storage API 和防 UPDATE/DELETE trigger 保护（migration 测试必须覆盖）。DAG 环检测在 `BEGIN IMMEDIATE` 下读取并插入，不仅依赖自环 CHECK。

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
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(id),
  provider_session_id TEXT,
  process_identity_json TEXT CHECK(process_identity_json IS NULL OR json_valid(process_identity_json)),
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
  transport_locator TEXT,
  session_storage_ref TEXT,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  last_observed_at INTEGER,
  exit_json TEXT CHECK(exit_json IS NULL OR json_valid(exit_json))
);
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
  prompt_json TEXT NOT NULL CHECK(json_valid(prompt_json)),
  status TEXT NOT NULL CHECK(status IN ('OPEN','ANSWER_RECORDED','DELIVERED','CLOSED','STALE')),
  created_at INTEGER NOT NULL,
  UNIQUE(session_id,provider_request_id)
);
CREATE TABLE attention_answers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES attention_requests(id),
  command_id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  answer_json TEXT NOT NULL CHECK(json_valid(answer_json)),
  created_at INTEGER NOT NULL
);
```

活动资源唯一性以 resource_held 而非心跳超时决定。即使 Runtime 的 lease 过期，也不能在未知进程仍可能写入时抢占 workspace。终态与 resource_held=0 的一致性在正式 CHECK/事务服务中强制；确认停止前不得置 0。

Agent adapter_id 的权威来源为 Execution，不在多处维护可能不一致的主 Agent。provider session ID 是否跨项目唯一由 Adapter 决定，数据库不擅自全局唯一。

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
  expected_main_commit TEXT NOT NULL,
  integration_ref TEXT NOT NULL,
  candidate_commit TEXT,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  promoted_commit TEXT,
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
CREATE TABLE integration_approvals (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES integration_batches(id),
  verification_id TEXT NOT NULL REFERENCES verification_runs(id),
  candidate_commit TEXT NOT NULL,
  expected_main_commit TEXT NOT NULL,
  actor TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','CONSUMED','INVALIDATED')),
  created_at INTEGER NOT NULL,
  invalidated_at INTEGER
);
CREATE UNIQUE INDEX active_batch_approval ON integration_approvals(batch_id) WHERE status='ACTIVE';
CREATE INDEX verification_subject ON verification_runs(task_id,revision_id,tested_commit);
```

应用事务还需检查：成员同项目；execution 的实际产出与 applied revision 匹配；审批引用本 batch 的 PASSED 集成验证；同一 Task 不被两个活动批次同时提升。后者 Phase 4 以 batch claims 表或等价事务锁实现，正式 migration 前补齐。

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

## 7. Self Evolution（Phase 7 预留逻辑表）

- `candidate_versions(id, self_task_id FK, source_commit, artifact_ref, artifact_hash, build_manifest_json, compatibility_json, state, created_at)`。
- `self_test_runs(id, candidate_id FK, isolated_data_ref, tested_artifact_hash, state, evidence_ref, started_at, ended_at)`。
- `promotion_records(id, candidate_id FK, old_version, new_version, approved_artifact_hash, actor, state, backup_ref, health_evidence_ref, created_at, completed_at)`。

Stable pointer/版本清单由 bootstrap 独立管理；Runtime 数据库不可作为唯一恢复依据。migration/备份兼容策略未确认，因此不虚构这里的最终 DDL。

## 8. Migration 与验收

Phase 1 migration 只含实际使用表；Task 创建循环 FK、revision 不可变、活动 Execution 唯一、CAS 失败、验证 subject XOR、outbox 事务回滚、重复命令至少有真实 SQLite 测试。Phase 2/4 分阶段新增表和索引。

升级前检查 schema version，未知较新版本拒绝写入。没有通过备份恢复验证前不执行破坏性 migration；Self Evolution 的跨版本回滚策略为单独准入门禁。
