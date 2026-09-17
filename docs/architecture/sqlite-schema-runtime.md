# SQLite Schema：Operation、事件、幂等、容量与全局控制

> 层级：L2 按需参考 · 体量 ≈ 12k · **何时读**：改事件写入/订阅/outbox、长命令 Operation、幂等回执、槽位预留或全局暂停的持久事实 · **权威来源**：`packages/storage/src/migration.ts`（DDL 由当前 v37 库导出）。事件目录见 [`event-model.md`](./event-model.md)，控制状态机见 [`state-machines-runtime.md`](./state-machines-runtime.md) §6.1。

## 1. 表与它们各自持有的事实

| 表 | 持有的事实 | 关键不变量 |
|---|---|---|
| `operations` | 事务外副作用的长命令记录 | `(project_id, kind, idempotency_key)` 唯一；`RECONCILE_REQUIRED` 表示「可能已发生」，不得盲重放 |
| `operation_progress` / `operation_progress_events` | 步骤级进度与**已发布**的进度事实 | 每 Operation 的 `sequence`/`progress_sequence` 单调；`step_key`/`dedup_key` 让重复发布成为 no-op |
| `domain_events` | append-only 的领域事实日志 | `event_id` 唯一；`sequence` 是**本库**排序游标，不是分布式时钟；同一事务可产生多条事实，因此 `aggregate_version` 不唯一 |
| `event_deliveries` | 可变 outbox（消费者投递状态与退避） | 至少一次投递；消费者必须按 `eventId` 幂等 |
| `command_receipts` | 项目内命令的幂等回执 | 主键 `(project_id, command_id)`；同键异文拒绝 |
| `runtime_command_receipts` | **不属于任何 Project** 的全局命令回执 | 同 commandId 重放同结果；不能复用 `command_receipts`（那张表的 `project_id` 是 NOT NULL） |
| `execution_slot_reservations` | Task 执行权 + Adapter 槽位 +（可绑定的）workspace | 每 Task 一个活跃预留、一个 workspace 不被两个活跃预留占用（两条部分唯一索引）；归属证据是 bootId + pid + OS start token |
| `execution_slot_reservation_events` | 每次观测/决定的 append-only 台账 | `(reservation_id, command_id)` 唯一，使同代重复 reconcile 幂等；「决定保持占用」也追加一行 |
| `runtime_capacity_settings` | 唯一一个跨全部 Project/Adapter 的并行上限 | singleton；`global_limit BETWEEN 1 AND 16`；**没有行 = 从未显式设置**（默认 2），`reset` 删行而不是写 2 |
| `runtime_pause_control` | Runtime 全局控制状态与 pause epoch | singleton；迁移**总是**写入 `RUNNING, epoch 0`，因为「没有行」不能被读成「继续」 |
| `runtime_pause_targets` | 本 epoch 内每个被冻结的 provider 主进程 | `(pause_epoch, incarnation_id)` 唯一；业务 ID 是**身份快照**、刻意无 FK（purge 后可保留）；不是 Session 状态的来源 |

要点：

- **domain event 是已经发生的事实，Signal 是待处理的工作信封。** 两者都在本库，但语义、恢复与幂等口径不同（见 [`event-model.md`](./event-model.md) §1 与 [`service-process-signal.md`](./service-process-signal.md) §5）。
- `domain_events.project_id` 可空，`NULL` 表示 Runtime 全局事实（如全局容量/暂停），**不是**「未知 Project」；Project 过滤订阅读 `(project_id = ? OR project_id IS NULL)`，游标仍按同一 sequence 前进。
- 命令侧：收到命令 → 校验身份/payload/幂等键 → 同一事务内检查 version、更新状态、写事件、建立投递行与回执 → commit 后才通知 UI/执行副作用。相同键不同 payload 一律拒绝。
- 消费者重启后按 outbox 补齐；启动/commit/merge/回答问题这类副作用不能只靠重试，必须先 reconcile 外部效果。
- 迁移期只保留一个 Runtime 实例（`runtime.lock`）负责写入，因此本库不需要分布式协调；`sequence` 只在单库内有序。
- 全局容量的旧值迁移是确定性且整笔原子的：读取旧项目级/Adapter 级显式值的**最小值**写入 singleton（并写 `source='MIGRATED_MINIMUM'`），随后同脚本重建 `domain_events` 并 DROP 两张旧表；任一步失败整笔回滚。
- 全局暂停的状态一致性由 storage service 在同一 immediate transaction 内强制：`RUNNING` 时不得有 `PENDING`/`STOPPED` 目标，`PAUSED` 时本 epoch 不得有 `PENDING`/`RECOVERY_REQUIRED`；target 行不因超时、心跳或重启自动删除。

## 2. DDL（v37 实际形态）

### `operations`

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
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  UNIQUE(project_id,kind,idempotency_key)
) STRICT;
```

### `operation_progress`

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

### `operation_progress_events`

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

### `domain_events`

```sql
CREATE TABLE "domain_events" (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT REFERENCES projects(id),
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK(schema_version > 0),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version >= 0),
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX event_aggregate ON domain_events(aggregate_type,aggregate_id,aggregate_version);
```

### `event_deliveries`

```sql
CREATE TABLE event_deliveries (
  event_id TEXT NOT NULL REFERENCES domain_events(event_id),
  consumer_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','DELIVERED','FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at INTEGER,
  last_error TEXT,
  PRIMARY KEY(event_id,consumer_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX delivery_retry ON event_deliveries(state,next_attempt_at);
```

### `command_receipts`

```sql
CREATE TABLE command_receipts (
  project_id TEXT NOT NULL REFERENCES projects(id),
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(project_id,command_id)
) STRICT, WITHOUT ROWID;
```

### `runtime_command_receipts`

```sql
CREATE TABLE runtime_command_receipts (
  command_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
```

### `execution_slot_reservations`

```sql
CREATE TABLE execution_slot_reservations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  revision_id TEXT NOT NULL,
  task_version INTEGER NOT NULL CHECK(task_version >= 0),
  adapter_id TEXT NOT NULL CHECK(length(trim(adapter_id)) > 0),
  workspace_id TEXT,
  -- The impact snapshot the acquirer assessed against. No snapshot store exists in this baseline
  -- (the analyzer lane owns it), so the column records the caller's assertion for audit; the
  -- generation recheck becomes a comparison once that store lands.
  impact_snapshot_id TEXT,
  dependency_fingerprint TEXT NOT NULL CHECK(length(trim(dependency_fingerprint)) > 0),
  assessed_dev_commit TEXT,
  state TEXT NOT NULL CHECK(state IN ('RESERVED','RELEASED','RECOVERY_REQUIRED')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  -- The command that created this reservation; a replayed command is answered from its receipt.
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
CREATE INDEX active_slot_reservations_by_adapter
  ON execution_slot_reservations(project_id,adapter_id)
  WHERE state IN ('RESERVED','RECOVERY_REQUIRED');
CREATE UNIQUE INDEX one_active_slot_reservation ON execution_slot_reservations(task_id)
  WHERE state IN ('RESERVED','RECOVERY_REQUIRED');
CREATE UNIQUE INDEX one_active_workspace_reservation
  ON execution_slot_reservations(project_id,workspace_id)
  WHERE state IN ('RESERVED','RECOVERY_REQUIRED') AND workspace_id IS NOT NULL;
CREATE INDEX slot_reservations_by_project
  ON execution_slot_reservations(project_id,reserved_at DESC,id);
CREATE INDEX slot_reservations_by_task
  ON execution_slot_reservations(task_id,reserved_at DESC,id);
```

### `execution_slot_reservation_events`

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

### `runtime_capacity_settings`

```sql
CREATE TABLE runtime_capacity_settings (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  global_limit INTEGER NOT NULL CHECK(global_limit BETWEEN 1 AND 16),
  version INTEGER NOT NULL CHECK(version >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  updated_by TEXT NOT NULL CHECK(length(trim(updated_by)) > 0)
) STRICT;
```

### `runtime_pause_control`

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
```

### `runtime_pause_targets`

```sql
CREATE TABLE runtime_pause_targets (
  id TEXT PRIMARY KEY,
  pause_epoch INTEGER NOT NULL CHECK(pause_epoch > 0),
  -- Identity snapshots taken when the barrier was committed. Deliberately no FK: see the comment on
  -- this migration's header. A purged Task must not be able to delete the fact that this Runtime
  -- froze its provider process.
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
CREATE INDEX runtime_pause_targets_by_epoch
  ON runtime_pause_targets(pause_epoch,state);
```
