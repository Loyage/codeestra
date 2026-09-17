# SQLite Schema：Workspace、Execution、配置与 Attention

> 层级：L2 按需参考 · 体量 ≈ 8k · **何时读**：改 Execution 生命周期、workspace、成果 commit 授权、Agent 配置或 Attention · **权威来源**：`packages/storage/src/migration.ts`（DDL 由当前 v37 库导出）。Session 家族见 [`sqlite-schema-sessions.md`](./sqlite-schema-sessions.md)。

## 1. 表与它们各自持有的事实

| 表 | 持有的事实 | 关键不变量 |
|---|---|---|
| `workspaces` | Task 独占的 branch/worktree 及其固定基线 | 每 Task 一个非 `RELEASED` 行；`path` 在非 `RELEASED` 时唯一；`ownership_token` 唯一；`base_ref`/`base_commit` 建时固定、此后不回写 |
| `executions` | 一次执行尝试的权威事实：initial/applied revision、workspace、adapter、base、result commit、状态、`resource_held` | 每 Task 最多一个 `resource_held=1`（部分唯一索引）；`(task_id, attempt_number)` 唯一；终态与 `resource_held=0` 一致 |
| `agent_configurations` | provider/model/thinking level 与插件选择，分全局默认与每项目覆盖 | 每 Adapter 至多一条 `GLOBAL`、每 (项目, Adapter) 至多一条 `PROJECT`；字段为 NULL 表示该层不覆盖 |
| `result_commit_authorizations` | 一次性的成果 commit 授权（STRICT 路径） | 每 Execution 最多一条 `ACTIVE`；消费时重验 applied revision / workspace 归属 / expected HEAD / ChangeSet fingerprint |
| `attention_requests` / `attention_answers` | provider 提出的问题与用户的答案 | `(session_id, provider_request_id)` 唯一；一请求一回答；答案与 `ANSWER_AGENT` intent、Operation、回执同事务 |
| `adapter_events` | Adapter 观察事件的去重投影 | `(session_id, provider_event_id)` 唯一；同一 Session 的 cursor 唯一；同 ID 异文 fail-closed |

要点：

- **活动资源唯一性以 `resource_held` 决定，不看心跳超时。** Runtime 的 lease 过期也不等于 provider 已停写，因此不得据此抢占 workspace。
- 成果 commit 是外部副作用：commit 成功但回写失败时按 HEAD/OID 核对补记，不重跑 hook、不盲重试。授权被消费后 Execution → `SUCCEEDED`、workspace `IN_USE → RETAINED`（保留供验证），Task 只到 `EXECUTED`。
- agent_config 在**预留时**解析成生效值并写进 `executions.agent_config_json`，因此同一 Execution 的启动参数可事后读回；Adapter 不得在 start 时重读全局配置（ADR-0012）。
- Attention 投影与 Session/Execution/Task 的状态变更同事务；只有 Operation 进入 `IN_PROGRESS` 后才调用 Adapter，明确未投递的失败可回到 `PLANNED` 重试，可能已投递的一律保持占用并进 `RECOVERY_REQUIRED`。
- `adapter_events` 只承载 provider 观察；它不驱动业务状态，业务事实写 `domain_events`。

## 2. DDL（v37 实际形态）

### `workspaces`

```sql
CREATE TABLE "workspaces" (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  branch_ref TEXT NOT NULL,
  path TEXT NOT NULL,
  ownership_token TEXT NOT NULL UNIQUE,
  base_commit TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('RESERVED','PREPARING','READY','IN_USE',
    'RECOVERY_REQUIRED','RETAINED','RELEASED')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0), base_ref TEXT
  CHECK(base_ref IS NULL OR length(trim(base_ref)) > 0),
  UNIQUE(task_id,id)
) STRICT;
CREATE UNIQUE INDEX one_live_workspace ON workspaces(task_id) WHERE state <> 'RELEASED';
CREATE UNIQUE INDEX one_live_workspace_path ON workspaces(path) WHERE state <> 'RELEASED';
```

### `executions`

```sql
CREATE TABLE "executions" (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  initial_revision_id TEXT NOT NULL,
  applied_revision_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('CREATED','PREPARING','STARTING','RUNNING','WAITING_FOR_USER',
    'PAUSING','PAUSED','STOPPING','RECOVERY_REQUIRED','SUCCEEDED','FAILED','CANCELLED','SUPERSEDED')),
  resource_held INTEGER NOT NULL CHECK(resource_held IN (0,1)),
  base_commit TEXT NOT NULL,
  result_commit TEXT,
  stop_reason TEXT CHECK(stop_reason IN ('USER_CANCEL','USER_PAUSE','REVISION_RESTART','SHUTDOWN')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  started_at INTEGER,
  ended_at INTEGER,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
  agent_config_json TEXT CHECK(agent_config_json IS NULL OR json_valid(agent_config_json)),
  -- Provider conversation resume uses a fresh Execution; this is the Execution it continued.
  resume_from_execution_id TEXT REFERENCES executions(id), retry_from_execution_id TEXT REFERENCES executions(id),
  UNIQUE(task_id,attempt_number),
  UNIQUE(task_id,id),
  CHECK((state IN ('SUCCEEDED','FAILED','CANCELLED','SUPERSEDED') AND resource_held=0)
    OR (state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SUPERSEDED') AND resource_held=1)),
  CHECK((state='SUCCEEDED' AND result_commit IS NOT NULL) OR (state<>'SUCCEEDED' AND result_commit IS NULL)),
  CHECK(ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  FOREIGN KEY(task_id,initial_revision_id) REFERENCES task_revisions(task_id,id),
  FOREIGN KEY(task_id,applied_revision_id) REFERENCES task_revisions(task_id,id),
  FOREIGN KEY(task_id,workspace_id) REFERENCES workspaces(task_id,id)
) STRICT;
CREATE UNIQUE INDEX one_held_execution ON executions(task_id) WHERE resource_held=1;
```

### `agent_configurations`

```sql
CREATE TABLE agent_configurations (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('GLOBAL','PROJECT')),
  project_id TEXT REFERENCES projects(id),
  adapter_id TEXT NOT NULL CHECK(length(trim(adapter_id)) > 0),
  provider TEXT CHECK(provider IS NULL OR length(trim(provider)) > 0),
  model TEXT CHECK(model IS NULL OR length(trim(model)) > 0),
  thinking_level TEXT CHECK(thinking_level IS NULL OR thinking_level IN
    ('off','minimal','low','medium','high','xhigh','max')),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  updated_by TEXT NOT NULL CHECK(length(trim(updated_by)) > 0), plugin_selection_json TEXT
  CHECK(plugin_selection_json IS NULL OR json_valid(plugin_selection_json)),
  CHECK((scope='GLOBAL' AND project_id IS NULL) OR (scope='PROJECT' AND project_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_global_agent_configuration
  ON agent_configurations(adapter_id) WHERE scope='GLOBAL';
CREATE UNIQUE INDEX one_project_agent_configuration
  ON agent_configurations(project_id,adapter_id) WHERE scope='PROJECT';
```

### `result_commit_authorizations`

```sql
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
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  consumed_at INTEGER,
  invalidated_at INTEGER,
  CHECK((status='ACTIVE' AND consumed_at IS NULL AND invalidated_at IS NULL)
    OR (status='CONSUMED' AND consumed_at IS NOT NULL AND invalidated_at IS NULL)
    OR (status='INVALIDATED' AND consumed_at IS NULL AND invalidated_at IS NOT NULL)),
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id),
  FOREIGN KEY(task_id,workspace_id) REFERENCES workspaces(task_id,id)
) STRICT;
CREATE UNIQUE INDEX one_active_result_commit_authorization
  ON result_commit_authorizations(execution_id) WHERE status='ACTIVE';
```

### `attention_requests`

```sql
CREATE TABLE attention_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  provider_request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('PERMISSION','QUESTION','RECOVERY')),
  prompt_json TEXT NOT NULL CHECK(json_valid(prompt_json)),
  status TEXT NOT NULL CHECK(status IN ('OPEN','ANSWER_RECORDED','DELIVERED','CLOSED','STALE')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0), response_type TEXT NOT NULL DEFAULT 'VALUE'
  CHECK(response_type IN ('CONFIRM','VALUE')),
  UNIQUE(session_id,provider_request_id)
) STRICT;
CREATE INDEX open_attention_requests ON attention_requests(session_id,status);
```

### `attention_answers`

```sql
CREATE TABLE attention_answers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES attention_requests(id),
  command_id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  answer_json TEXT NOT NULL CHECK(json_valid(answer_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
```

### `adapter_events`

```sql
CREATE TABLE "adapter_events" (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  provider_event_id TEXT NOT NULL,
  cursor TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('attention','completed','disconnected')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  PRIMARY KEY(session_id,provider_event_id),
  UNIQUE(session_id,cursor)
) STRICT, WITHOUT ROWID;
```
