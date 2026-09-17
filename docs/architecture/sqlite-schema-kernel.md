# SQLite Schema：Service / Process / Signal 内核（v37）

> 层级：L2 按需参考 · 体量 ≈ 10k · **何时读**：改 Service 树、Process 投影、Signal inbox/outbox 的持久事实 · **权威来源**：`packages/storage/src/migration.ts` 的 `serviceKernelMigration` 与 `packages/storage/src/service-kernel-store.ts`（DDL 由当前 v37 库导出）。目标语义见 [`service-process-signal.md`](./service-process-signal.md)。

v37 只做 **additive storage**，不重建 v36 业务表：Project/Task/Execution 旧表仍是 core lifecycle 权威，新表只承载内核对象与投影。

## 1. 表与它们各自持有的事实

| 表 | 持有的事实 | 关键不变量 |
|---|---|---|
| `services` | 持久 Actor 的稳定身份与树位置 | root / Scheduler / Attention 各一个 singleton（部分唯一索引）；Project/Task 各通过唯一 `project_id` / `task_id` 投影；parent-kind 触发器保证 Project 直属 root、Task 直属 Project；`state_version` 只属于 metadata |
| `service_metadata` | namespaced metadata 与逐键 version | 主键 `(service_id, namespace, key)`；CAS 成功时同步推进 `services.state_version`，不触碰旧 core lifecycle |
| `processes` | 目标有界的 Process（当前由 Execution 投影） | `status_source='EXECUTION'` 的状态查询继续从 Execution 读，不复制写权威 |
| `process_execution_links` | Process 与 Execution 的一一投影 | 每个既有 Execution 建同 ID Development Process 与一一 link |
| `signals` | 持久工作信封与投递状态 | `(target_service_id, idempotency_key)` 唯一；claim owner/deadline、attempt 计数与 next-attempt 持久化 |
| `signal_attempts` | 每次 claim 的 append-only 台账 | 不删除、不改写；lease 过期先把旧 attempt 记为 `RETRYABLE` 并发布 retry 事实 |
| `signal_receipts` | 已收敛的 Signal 效果（幂等键 → 结果） | append-only；ACK 与 receipt **在同一事务**写入 |

要点：

- **Service 不是 OS 进程**：一个 Service 就是本库里的一行 + 它的 metadata 与 inbox；Service 树无环、有根。
- **Process 不新建一套可写执行状态**：S5 之前 `status` 从 Execution 投影，S5 才把控制面映射过来（roadmap 见 [`../roadmap/mvp.md`](../roadmap/mvp.md)）。
- **Signal 至少一次**：跨 SQLite/Git/Provider 不宣称 exactly-once；handler 幂等命中已有 Signal/receipt 时不追加第二个副作用事实。
- v37 迁移先计算 `3 + projects + tasks` 与 `executions` 的预期投影行数，再执行 additive DDL，结束后核对 Service/Process/link 三个基数与 `PRAGMA foreign_key_check`，任一不符整步回滚且不推进 `user_version`。Runtime 启动时 reconcile 后续新增的 Project/Task/Execution。
- `task purge` 先删除 Execution 对应的 Process；Service 留作可寻址的 retired tombstone，历史 Signal 不级联删除。

## 2. DDL（v37 实际形态）

### `services`

```sql
CREATE TABLE services (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('ROOT','SCHEDULER','ATTENTION','PROJECT','TASK')),
  parent_service_id TEXT REFERENCES services(id),
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('ACTIVE','PAUSED','RECOVERY_REQUIRED','RETIRED')),
  state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK(contract_version > 0),
  project_id TEXT UNIQUE REFERENCES projects(id) ON DELETE SET NULL,
  task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
  inbox_cursor INTEGER NOT NULL DEFAULT 0 CHECK(inbox_cursor >= 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  CHECK((kind='ROOT' AND parent_service_id IS NULL AND project_id IS NULL AND task_id IS NULL)
    OR (kind IN ('SCHEDULER','ATTENTION') AND parent_service_id IS NOT NULL
      AND project_id IS NULL AND task_id IS NULL)
    OR (kind='PROJECT' AND parent_service_id IS NOT NULL AND task_id IS NULL)
    OR (kind='TASK' AND parent_service_id IS NOT NULL AND project_id IS NULL))
) STRICT;
CREATE UNIQUE INDEX one_attention_service ON services((1)) WHERE kind='ATTENTION';
CREATE UNIQUE INDEX one_root_service ON services((1)) WHERE kind='ROOT';
CREATE UNIQUE INDEX one_scheduler_service ON services((1)) WHERE kind='SCHEDULER';
CREATE INDEX services_by_parent ON services(parent_service_id,kind,id);
CREATE TRIGGER services_parent_and_kind_immutable
BEFORE UPDATE OF parent_service_id,kind ON services BEGIN
  SELECT RAISE(ABORT,'service parent and kind are immutable');
END;
CREATE TRIGGER services_validate_parent_insert
BEFORE INSERT ON services BEGIN
  SELECT CASE
    WHEN NEW.kind IN ('SCHEDULER','ATTENTION','PROJECT')
      AND COALESCE((SELECT kind FROM services WHERE id=NEW.parent_service_id),'') <> 'ROOT'
      THEN RAISE(ABORT,'system and project services must be direct children of root')
    WHEN NEW.kind='TASK'
      AND COALESCE((SELECT kind FROM services WHERE id=NEW.parent_service_id),'') <> 'PROJECT'
      THEN RAISE(ABORT,'task services must be direct children of project')
  END;
END;
```

### `service_metadata`

```sql
CREATE TABLE service_metadata (
  service_id TEXT NOT NULL REFERENCES services(id),
  namespace TEXT NOT NULL CHECK(length(namespace) BETWEEN 1 AND 63),
  key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 63),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  updated_by TEXT NOT NULL CHECK(length(trim(updated_by)) > 0),
  PRIMARY KEY(service_id,namespace,key)
) STRICT, WITHOUT ROWID;
```

### `processes`

```sql
CREATE TABLE processes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('DEVELOPMENT','INTENTION','INTEGRATION')),
  parent_service_id TEXT NOT NULL REFERENCES services(id),
  status_source TEXT NOT NULL CHECK(status_source IN ('PROCESS','EXECUTION')),
  status TEXT CHECK(status IS NULL OR status IN ('CREATED','STARTING','RUNNING','WAITING_FOR_USER',
    'PAUSING','PAUSED','SUCCEEDED','FAILED','CANCELLED','RECOVERY_REQUIRED')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  objective TEXT NOT NULL CHECK(length(trim(objective)) > 0),
  adapter_id TEXT,
  agent_config_json TEXT CHECK(agent_config_json IS NULL OR json_valid(agent_config_json)),
  budget_json TEXT CHECK(budget_json IS NULL OR json_valid(budget_json)),
  context_ref TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  CHECK((status_source='PROCESS' AND status IS NOT NULL)
    OR (status_source='EXECUTION' AND status IS NULL))
) STRICT;
CREATE INDEX processes_by_parent ON processes(parent_service_id,created_at,id);
```

### `process_execution_links`

```sql
CREATE TABLE process_execution_links (
  process_id TEXT PRIMARY KEY REFERENCES processes(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
```

### `signals`

```sql
CREATE TABLE signals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('SIG_A','SIG_P')),
  subtype TEXT NOT NULL CHECK(length(trim(subtype)) > 0),
  source_service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  source_process_id TEXT REFERENCES processes(id) ON DELETE SET NULL,
  target_service_id TEXT NOT NULL REFERENCES services(id),
  contract_version INTEGER NOT NULL CHECK(contract_version > 0),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  idempotency_key TEXT NOT NULL CHECK(length(trim(idempotency_key)) > 0),
  correlation_id TEXT NOT NULL CHECK(length(trim(correlation_id)) > 0),
  causation_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('PENDING','CLAIMED','RETRYABLE','ACKED','DEAD_LETTER',
    'RECOVERY_REQUIRED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  automatic_attempts INTEGER NOT NULL DEFAULT 0 CHECK(automatic_attempts >= 0),
  next_attempt_at INTEGER,
  claim_boot_id TEXT,
  claim_deadline_at INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  acknowledged_at INTEGER,
  dead_lettered_at INTEGER,
  UNIQUE(target_service_id,idempotency_key),
  CHECK((state='CLAIMED' AND claim_boot_id IS NOT NULL AND claim_deadline_at IS NOT NULL)
    OR (state<>'CLAIMED' AND claim_boot_id IS NULL AND claim_deadline_at IS NULL)),
  CHECK((state='ACKED' AND acknowledged_at IS NOT NULL) OR (state<>'ACKED' AND acknowledged_at IS NULL)),
  CHECK((state='DEAD_LETTER' AND dead_lettered_at IS NOT NULL)
    OR (state<>'DEAD_LETTER' AND dead_lettered_at IS NULL))
) STRICT;
CREATE INDEX signals_by_target ON signals(target_service_id,created_at,id);
CREATE INDEX signals_dispatch ON signals(state,next_attempt_at,priority DESC,created_at,id);
```

### `signal_attempts`

```sql
CREATE TABLE signal_attempts (
  signal_id TEXT NOT NULL REFERENCES signals(id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  boot_id TEXT NOT NULL CHECK(length(trim(boot_id)) > 0),
  state TEXT NOT NULL CHECK(state IN ('CLAIMED','ACKED','RETRYABLE','DEAD_LETTER','RECOVERY_REQUIRED')),
  claimed_at INTEGER NOT NULL CHECK(claimed_at >= 0),
  settled_at INTEGER,
  error_code TEXT,
  error_message TEXT,
  PRIMARY KEY(signal_id,attempt_number),
  CHECK((state='CLAIMED' AND settled_at IS NULL) OR (state<>'CLAIMED' AND settled_at IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER signal_attempts_no_delete BEFORE DELETE ON signal_attempts BEGIN
  SELECT RAISE(ABORT,'signal attempts are append-only');
END;
```

### `signal_receipts`

```sql
CREATE TABLE signal_receipts (
  target_service_id TEXT NOT NULL REFERENCES services(id),
  idempotency_key TEXT NOT NULL,
  signal_id TEXT NOT NULL UNIQUE REFERENCES signals(id),
  effect_json TEXT NOT NULL CHECK(json_valid(effect_json)),
  acknowledged_at INTEGER NOT NULL CHECK(acknowledged_at >= 0),
  PRIMARY KEY(target_service_id,idempotency_key)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER signal_receipts_no_delete BEFORE DELETE ON signal_receipts BEGIN
  SELECT RAISE(ABORT,'signal receipts are append-only');
END;
CREATE TRIGGER signal_receipts_no_update BEFORE UPDATE ON signal_receipts BEGIN
  SELECT RAISE(ABORT,'signal receipts are append-only');
END;
```
