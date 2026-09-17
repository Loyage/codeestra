# SQLite Schema：Session、接管、指导与修订投递

> 层级：L2 按需参考 · 体量 ≈ 19k · **何时读**：改 provider 进程身份、单 writer lease、终端接管、Session Guidance、修订投递或启动收敛 · **权威来源**：`packages/storage/src/migration.ts`（DDL 由当前 v37 库导出）。状态机见 [`state-machines-sessions.md`](./state-machines-sessions.md) §3、§7。

## 1. 表与它们各自持有的事实

| 表 | 持有的事实 | 关键不变量 |
|---|---|---|
| `agent_sessions` | 一个 provider conversation 的 Codeestra 身份 | `execution_id` 内联 UNIQUE：一条 Execution 只有一个当前 Session；交接收敛为**同一 Session 内的 incarnation**，不是第二条 Session |
| `session_incarnations` | 一次 provider OS 进程代 | `(session_id, incarnation_number)` 与 `(session_id, command_id)` 唯一；`EXITED` 必须带 `ended_at`；进程身份是 pid + start token + argv hash |
| `session_writer_leases` | 当前谁在写这个 conversation | 每 Session 最多一条未释放租约（部分唯一索引）；第二个 writer 得到 `ATTACHMENT_BUSY`，不排队 |
| `session_handoff_requests` | RPC↔TUI 交接的请求与安全点事实 | 每 Session 最多一条未决请求；`fence_active`、`fence_confirmed_at`、`settled_after_fence_at`、`safe_point_at` 是四件不同的事实，不互相替代 |
| `session_permission_requests` | STRICT 下的工具审批请求 | `attention_id` 唯一（一条 Attention 一条请求）；`DECIDING` 是原子 claim 的中间态 |
| `session_terminals` | 一个受控 PTY 终端 | 每 Session 最多一个 `RUNNING`；`exit_code` 只作审计（Ctrl+D 与 SIGTERM 实测都是 0），任何判定不得以它分支 |
| `session_terminal_attachments` | 客户端对终端的连接与 writer 座位 | 每终端最多一个 `ATTACHED WRITER`；detach 只释放 attachment/lease，不停 Session |
| `session_guidance` | 不改变验收规格的会话级指导 | 命令来源的正文耐久保存（`body`），TUI 来源只存 entry 引用/hash/长度；状态即投递事实 |
| `session_guidance_deliveries` | 每次投递尝试的结论 | `IN_FLIGHT` 必须有 `deadline_at` 语义；`state` 与 `capability` 分开记录，`CHANNEL_UNSUPPORTED` 不等于投递成功 |
| `execution_guidance_contexts` | 某个 Execution 启动时随参数交出的 guidance 集合 | 与 Execution 一一对应；启动交付 fail-closed（核验路径/普通文件/digest/字节数/UTF-8） |
| `task_revision_deliveries` | 「这条修订要交给正在运行的会话」这一一等需求 | `(task_id, revision_id)` 唯一；`ACKNOWLEDGED` 必须带 `acknowledged_at` |
| `task_revision_delivery_attempts` | 每次投递尝试的 append-only 台账 | `(delivery_id, attempt_number)` 唯一；`IN_FLIGHT` 结束才有 `ended_at`；只有结构化 ACK 或经核验的 successor Execution 才算满足 |
| `agent_session_startup_reconciliations` | 重启后对 stale Session/Execution 投影的观测与结论 | append-only；`evidence_json` 固定 `quiescenceProven:false`、`signalsSent:0`；绝不声称静止 |

要点：

- **三层身份分开持久化**：Codeestra `session_id`、provider session ID/file（`session_storage_ref`）、provider 进程身份（pid + start token + argv hash）。缺少 start token 时拒绝启动，因为 PID 可复用。
- `agent_sessions.current_incarnation_id` 是「决议还能到达哪个进程」的唯一答案；重启后 `reconcileSessionHandoffs` 以 `RUNTIME_RESTARTED` 释放所有未释放租约并把 live incarnation 置 `RECOVERY_REQUIRED`。
- 启动收敛（`reconcileStaleAgentSessions`）一律写 `DISCONNECTED`（Session）+ `RECOVERY_REQUIRED`（Execution，保持 `resource_held=1`）：**绝不写 RUNNING/ACTIVE、绝不声称静止、绝不发信号、绝不删资源**，每次观测追加一行审计。
- 修订投递的 `satisfied` 只有两种：attempt 以 `ACKNOWLEDGED` 结束（带 Adapter 结构化证据），或 successor Execution 行的**记录值** `applied_revision_id` 就是该 revision。「消息发出去了」永不算确认。
- guidance 与 revision 是两条通道：guidance 不改 `applied_revision_id`、不产生 TaskRevision、不使验证失效；规格变化必须走 `task amend`。
- **没有任何列表达「模型已读」**：ADR-0051 实测三个 provider 都没有可核验通道，命令面以 `modelAcknowledgement: 'UNSUPPORTED'` 明说。

## 2. DDL（v37 实际形态）

### `agent_sessions`

```sql
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(id),
  provider_session_id TEXT,
  process_identity_json TEXT CHECK(process_identity_json IS NULL OR json_valid(process_identity_json)),
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
  transport_locator TEXT,
  session_storage_ref TEXT,
  state TEXT NOT NULL CHECK(state IN ('CREATED','STARTING','ACTIVE','WAITING_FOR_USER','PAUSING',
    'PAUSED','STOPPING','EXITED','DISCONNECTED','RECOVERY_REQUIRED')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  last_observed_at INTEGER,
  exit_json TEXT CHECK(exit_json IS NULL OR json_valid(exit_json))
, observation_cursor TEXT, current_incarnation_id TEXT
  REFERENCES session_incarnations(id)) STRICT;
```

### `session_incarnations`

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
CREATE INDEX session_incarnations_by_session
  ON session_incarnations(session_id,incarnation_number);
```

### `session_writer_leases`

```sql
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
```

### `session_handoff_requests`

```sql
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
  fence_confirmed_at INTEGER,
  settled_after_fence_at INTEGER,
  safe_point_at INTEGER,
  admitted_at INTEGER,
  detail TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  UNIQUE(session_id,command_id)
) STRICT;
CREATE UNIQUE INDEX one_open_session_handoff_request
  ON session_handoff_requests(session_id)
  WHERE state IN ('REQUESTED','FENCED','AT_SAFE_POINT');
```

### `session_permission_requests`

```sql
CREATE TABLE session_permission_requests (
  id TEXT PRIMARY KEY,
  attention_id TEXT NOT NULL UNIQUE REFERENCES attention_requests(id),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  incarnation_id TEXT NOT NULL REFERENCES session_incarnations(id),
  provider_request_id TEXT NOT NULL CHECK(length(trim(provider_request_id)) > 0),
  tool_call_id TEXT NOT NULL CHECK(length(trim(tool_call_id)) > 0),
  tool_name TEXT NOT NULL CHECK(length(trim(tool_name)) > 0),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  input_fingerprint TEXT NOT NULL CHECK(length(trim(input_fingerprint)) > 0),
  pi_mode TEXT NOT NULL CHECK(length(trim(pi_mode)) > 0),
  decision TEXT NOT NULL CHECK(decision IN ('OPEN','DECIDING','ALLOW','DENY','CANCEL','STALE')),
  requested_at INTEGER NOT NULL CHECK(requested_at >= 0),
  decided_at INTEGER,
  decided_by TEXT,
  UNIQUE(session_id,provider_request_id)
) STRICT;
CREATE INDEX open_session_permission_requests
  ON session_permission_requests(session_id,decision);
```

### `session_terminals`

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

### `session_terminal_attachments`

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

### `session_guidance`

```sql
CREATE TABLE session_guidance (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  -- The Execution that was holding the Task when the guidance was recorded; NULL means nothing was
  -- running, so the guidance can only be handed over at the next launch.
  execution_id TEXT,
  session_id TEXT REFERENCES agent_sessions(id),
  incarnation_id TEXT REFERENCES session_incarnations(id),
  -- Today the command face is the only producer; TUI-typed guidance is not implemented (ADR-0010).
  source TEXT NOT NULL CHECK(source IN ('COMMAND')),
  -- The durable body (ADR-0010 D02). It never enters a domain event (ADR-0010 D06).
  body TEXT NOT NULL CHECK(length(trim(body)) > 0),
  body_hash TEXT NOT NULL CHECK(length(body_hash) = 64),
  body_bytes INTEGER NOT NULL CHECK(body_bytes > 0),
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  -- The delivery fact, not a specification fact: 'RECORDED' is the only state a record is created
  -- in, and it is also where a record stays when no live conversation existed to hand it to.
  state TEXT NOT NULL CHECK(state IN ('RECORDED','DELIVERED','CHANNEL_UNSUPPORTED','TIMED_OUT',
    'FAILED')),
  channel TEXT CHECK(channel IS NULL OR channel IN ('PROVIDER_CONVERSATION')),
  evidence_ref TEXT,
  delivery_detail TEXT,
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  delivered_at INTEGER,
  -- Only a delivered record has a delivery time: the timestamp cannot be read as "we sent it".
  CHECK((state='DELIVERED') = (delivered_at IS NOT NULL)),
  UNIQUE(task_id,id),
  FOREIGN KEY(task_id) REFERENCES tasks(id),
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id)
) STRICT;
CREATE INDEX session_guidance_by_task ON session_guidance(task_id,created_at,id);
```

### `session_guidance_deliveries`

```sql
CREATE TABLE session_guidance_deliveries (
  id TEXT PRIMARY KEY,
  guidance_id TEXT NOT NULL REFERENCES session_guidance(id),
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  channel TEXT NOT NULL CHECK(channel IN ('PROVIDER_CONVERSATION')),
  execution_id TEXT,
  session_id TEXT REFERENCES agent_sessions(id),
  incarnation_id TEXT REFERENCES session_incarnations(id),
  -- 'DELIVERED' = the provider channel accepted the message (enqueued). It says nothing about
  -- whether the model read it, and no other state here does either.
  state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','DELIVERED','CHANNEL_UNSUPPORTED','TIMED_OUT',
    'FAILED')),
  -- The Adapter's own reported capability at the moment of the attempt, recorded even when the
  -- attempt never reached the provider: "why nothing was sent" must be a readable fact.
  capability TEXT,
  evidence_ref TEXT,
  error_code TEXT,
  detail TEXT NOT NULL CHECK(length(trim(detail)) > 0),
  deadline_at INTEGER,
  started_at INTEGER NOT NULL CHECK(started_at >= 0),
  ended_at INTEGER,
  UNIQUE(guidance_id,attempt_number),
  CHECK((state='IN_FLIGHT') = (ended_at IS NULL))
) STRICT;
CREATE INDEX in_flight_session_guidance_deliveries ON session_guidance_deliveries(deadline_at)
  WHERE state='IN_FLIGHT';
CREATE INDEX session_guidance_deliveries_by_guidance
  ON session_guidance_deliveries(guidance_id,attempt_number);
```

### `execution_guidance_contexts`

```sql
CREATE TABLE execution_guidance_contexts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  -- The records the artifact was derived from. The artifact is a rendering of these rows, never the
  -- authority: a re-launch re-derives it from the ledger.
  guidance_ids_json TEXT NOT NULL CHECK(json_valid(guidance_ids_json)),
  guidance_count INTEGER NOT NULL CHECK(guidance_count > 0),
  context_path TEXT NOT NULL CHECK(length(trim(context_path)) > 0),
  context_digest TEXT NOT NULL CHECK(length(context_digest) = 64),
  context_bytes INTEGER NOT NULL CHECK(context_bytes > 0),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  -- One Execution can be launched more than once (a resume after a crash) and the guidance set can
  -- grow in between, so the pair is the key: re-recording the same content is idempotent, and a
  -- different content is a new row instead of an overwritten one.
  UNIQUE(execution_id,context_digest),
  FOREIGN KEY(task_id) REFERENCES tasks(id),
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id)
) STRICT;
CREATE INDEX execution_guidance_contexts_by_task
  ON execution_guidance_contexts(task_id,recorded_at,id);
```

### `task_revision_deliveries`

```sql
CREATE TABLE task_revision_deliveries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  -- The Execution that was running when the revision was created; NULL when nothing was running, so
  -- no delivery requirement exists.
  execution_id TEXT,
  session_id TEXT REFERENCES agent_sessions(id),
  -- The Session incarnation that was the recorded writer at creation time, when one was recorded.
  incarnation_id TEXT REFERENCES session_incarnations(id),
  state TEXT NOT NULL CHECK(state IN ('PENDING','IN_FLIGHT','ACKNOWLEDGED','UNACKNOWLEDGED',
    'CHANNEL_UNSUPPORTED','TIMED_OUT','FAILED','SUPERSEDED_BY_RESTART')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  -- Optimistic version of the delivery FSM; a concurrent resolution is rejected, not overwritten.
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  -- The channel of the newest attempt; NULL while no attempt was made.
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
```

### `task_revision_delivery_attempts`

```sql
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
CREATE INDEX in_flight_revision_delivery_attempts ON task_revision_delivery_attempts(deadline_at)
  WHERE state='IN_FLIGHT';
CREATE INDEX task_revision_delivery_attempts_by_delivery
  ON task_revision_delivery_attempts(delivery_id,attempt_number);
```

### `agent_session_startup_reconciliations`

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
