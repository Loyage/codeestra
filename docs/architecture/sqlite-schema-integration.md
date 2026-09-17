# 受管 integration 存储（schema v38）

> 层级：L2 · 体量 ≈ 6k 字符 · **何时读**：改受管 integration 的存储、队列约束或集成验证证据之前 · **权威来源**：`packages/storage/src/migration.ts` 的 `managedIntegrationMigration` 与 `packages/storage/src/integration-store.ts`；本文件 DDL 由当前 v38 库的 `sqlite_master` 导出。索引见 [`sqlite-schema.md`](./sqlite-schema.md)，语义见 [ADR-0074](../decisions/0074-managed-integration-ref-and-merge-queue.md)。

状态：schema v38（ADR-0074 / FOUNDATION-100）。这四张表是**纯 additive** 的：v37 及更早的表一个字节都不重写，升级不会丢行。

## 为什么需要它们

- `project_integration`：Project Service 独占的 integration ref/worktree、确定性 ownership token 与本 Runtime 上一次推进到的 OID。**Git ref 才是「什么已经集成」的权威**，这一行是记账；两者不一致由 `project integration status` 并列报出，不静默覆盖。
- `merge_queue_items`：持久 merge queue。两条部分唯一索引是「同项目一次只有一个活动集成」与「每个 Task 修订只有一条活请求」的**数据库事实**，而不是调用者自律。
- `integration_runs`：Integration Verification 的独立证据，绑定候选 commit、policy digest 与 expected integration OID。它不复用 `verification_runs`，因为那张表绑定 Execution 与 Task 修订，而集成候选两者都没有——复用就得先造一个假的 Execution。
- `task_integration`：Task 的 integration 投影（与 lifecycle/verification 正交）。**没有行 = `NOT_REQUESTED`**；行总是由造成它的 queue item 写出，所以「Task 是 `MERGED`」永远能追到一条走到 `MERGED` 的 item。

## 约束与不变量

| 不变量 | 由什么保证 |
|---|---|
| 一个项目一行集成记录 | `project_integration.project_service_id` 主键 + `project_id UNIQUE` |
| 集成记录不可删除 | `project_integration_no_delete` 触发器（删除会抹掉 ref 的归属证据） |
| 同项目一次只有一个活动集成 | `one_active_integration_per_project`（`state IN ('MERGING','VERIFYING')` 上的部分唯一索引） |
| 每个 Task 修订只有一条活请求 | `one_live_merge_request_per_task_revision`（`state IN ('QUEUED','MERGING','VERIFYING')`） |
| 入队幂等 | `UNIQUE(project_id,idempotency_key)` |
| 终态必须有 `settled_at`，非终态必须没有 | `CHECK` 成对约束 |
| `MERGED` 必须记住推进到的 OID | `CHECK(state='MERGED' → candidate_commit IS NOT NULL AND released_integration_oid IS NOT NULL)` |
| 一次集成验证一个候选只有一条记录 | `UNIQUE(queue_item_id,candidate_commit)` |
| 集成验证必有其 Operation | `integration_runs.operation_id REFERENCES operations(id)`（store 在同一事务里建 `INTEGRATE_TASK` Operation） |
| 验证终态一次性 | `CHECK` 的终态形态 + `settleIntegrationRun` 在 `ended_at` 非空时不改写 |
| 请求必须指向真实 Task 修订与 PASSED 验证 | `FOREIGN KEY(task_id,revision_id)` 与 `task_verification_run_id REFERENCES verification_runs(id)`；「是否 PASSED」由服务检查 |
| 投影不跳状态 | 领域 `transitionMergeQueueItem` / `assertProjectionTransition`（DDL 只约束取值集合） |

## DDL（v38 实际导出）

```sql
CREATE TABLE integration_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  queue_item_id TEXT NOT NULL REFERENCES merge_queue_items(id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  candidate_commit TEXT NOT NULL CHECK(length(trim(candidate_commit)) > 0),
  expected_integration_oid TEXT NOT NULL CHECK(length(trim(expected_integration_oid)) > 0),
  policy_version TEXT NOT NULL CHECK(length(trim(policy_version)) > 0),
  policy_digest TEXT NOT NULL CHECK(length(trim(policy_digest)) > 0),
  main_commit TEXT NOT NULL CHECK(length(trim(main_commit)) > 0),
  commands_json TEXT NOT NULL CHECK(json_valid(commands_json) AND json_type(commands_json)='array'),
  copy_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','PASSED','FAILED','ERROR','CANCELLED')),
  outcome_code TEXT,
  evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
  queued_at INTEGER NOT NULL CHECK(queued_at >= 0),
  started_at INTEGER,
  ended_at INTEGER,
  UNIQUE(queue_item_id,candidate_commit),
  CHECK(started_at IS NULL OR started_at >= queued_at),
  CHECK(ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  CHECK((state IN ('QUEUED','RUNNING') AND ended_at IS NULL AND outcome_code IS NULL)
    OR (state IN ('PASSED','FAILED','ERROR','CANCELLED')
      AND ended_at IS NOT NULL AND outcome_code IS NOT NULL))
) STRICT;
CREATE TABLE merge_queue_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  project_service_id TEXT NOT NULL REFERENCES services(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  revision_id TEXT NOT NULL,
  result_commit TEXT NOT NULL CHECK(length(trim(result_commit)) > 0),
  task_verification_run_id TEXT NOT NULL REFERENCES verification_runs(id),
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('QUEUED','MERGING','VERIFYING','MERGED','CONFLICTED',
    'FAILED','CANCELLED','STALE','RECOVERY_REQUIRED')),
  candidate_commit TEXT,
  expected_integration_oid TEXT,
  released_integration_oid TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_error_code TEXT,
  last_error_message TEXT,
  conflict_detail_json TEXT CHECK(conflict_detail_json IS NULL OR json_valid(conflict_detail_json)),
  correlation_id TEXT NOT NULL CHECK(length(trim(correlation_id)) > 0),
  idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
  requested_at INTEGER NOT NULL CHECK(requested_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= requested_at),
  settled_at INTEGER,
  UNIQUE(project_id,idempotency_key),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id),
  CHECK((state IN ('QUEUED','MERGING','VERIFYING','RECOVERY_REQUIRED') AND settled_at IS NULL)
    OR (state IN ('MERGED','CONFLICTED','FAILED','CANCELLED','STALE') AND settled_at IS NOT NULL)),
  CHECK((state='MERGED' AND candidate_commit IS NOT NULL AND released_integration_oid IS NOT NULL)
    OR state<>'MERGED')
) STRICT;
CREATE TABLE project_integration (
  project_service_id TEXT PRIMARY KEY REFERENCES services(id),
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  integration_ref TEXT NOT NULL CHECK(length(trim(integration_ref)) > 0),
  worktree_path TEXT UNIQUE,
  ownership_token TEXT NOT NULL UNIQUE,
  integration_oid TEXT,
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','RECOVERY_REQUIRED')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
) STRICT;
CREATE TABLE task_integration (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  project_service_id TEXT NOT NULL REFERENCES services(id),
  state TEXT NOT NULL CHECK(state IN ('NOT_REQUESTED','QUEUED','MERGING','VERIFYING','MERGED',
    'CONFLICTED','FAILED','STALE','RECOVERY_REQUIRED')),
  queue_item_id TEXT REFERENCES merge_queue_items(id),
  integration_oid TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
) STRICT;
CREATE INDEX integration_runs_by_item ON integration_runs(queue_item_id,queued_at);
CREATE INDEX merge_queue_by_task ON merge_queue_items(task_id,requested_at DESC,id);
CREATE INDEX merge_queue_order ON merge_queue_items(project_id,state,priority DESC,requested_at,id);
CREATE UNIQUE INDEX one_active_integration_per_project
  ON merge_queue_items(project_id) WHERE state IN ('MERGING','VERIFYING');
CREATE UNIQUE INDEX one_live_merge_request_per_task_revision
  ON merge_queue_items(task_id,revision_id) WHERE state IN ('QUEUED','MERGING','VERIFYING');
CREATE INDEX task_integration_by_state ON task_integration(state,updated_at,task_id);
CREATE TRIGGER project_integration_no_delete BEFORE DELETE ON project_integration BEGIN
  SELECT RAISE(ABORT,'managed integration records are never deleted');
END;
```
