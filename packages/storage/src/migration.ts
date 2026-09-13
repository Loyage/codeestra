export const phase1SchemaVersion = 8;

export const phase1Migration = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  repo_root TEXT NOT NULL UNIQUE,
  git_common_dir TEXT NOT NULL UNIQUE,
  main_ref TEXT NOT NULL CHECK(length(trim(main_ref)) > 0),
  object_format TEXT NOT NULL CHECK(object_format IN ('sha1','sha256')),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;

CREATE TABLE project_trusts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  repo_root TEXT NOT NULL,
  git_common_dir TEXT NOT NULL,
  object_format TEXT NOT NULL CHECK(object_format IN ('sha1','sha256')),
  policy_version INTEGER NOT NULL CHECK(policy_version > 0),
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','INVALIDATED')),
  accepted_at INTEGER NOT NULL CHECK(accepted_at >= 0),
  invalidated_at INTEGER,
  CHECK((status='ACTIVE' AND invalidated_at IS NULL)
    OR (status='INVALIDATED' AND invalidated_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_active_project_trust ON project_trusts(project_id) WHERE status='ACTIVE';

CREATE TABLE intents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  idempotency_key TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  kind TEXT CHECK(kind IN ('CREATE_TASK','AMEND_TASK','ADD_CONSTRAINT','CANCEL_TASK',
    'CHANGE_PRIORITY','ANSWER_AGENT','SELF_MODIFICATION')),
  status TEXT NOT NULL CHECK(status IN ('RECORDED','NEEDS_CLARIFICATION','APPLIED','REJECTED')),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(project_id,idempotency_key)
) STRICT;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  display_number INTEGER NOT NULL CHECK(display_number > 0),
  kind TEXT NOT NULL CHECK(kind IN ('DEVELOPMENT','SELF')),
  current_revision_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('DRAFT','BLOCKED','READY','RUNNING','PAUSING','PAUSED',
    'WAITING_FOR_USER','RECOVERY_REQUIRED','EXECUTED','FAILED','CANCELLING','CANCELLED','SUCCEEDED')),
  priority INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  UNIQUE(project_id,display_number),
  UNIQUE(project_id,id),
  UNIQUE(id,current_revision_id),
  FOREIGN KEY(id,current_revision_id) REFERENCES task_revisions(task_id,id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE task_revisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  number INTEGER NOT NULL CHECK(number > 0),
  previous_revision_id TEXT,
  specification TEXT NOT NULL CHECK(length(trim(specification)) > 0),
  constraints_json TEXT NOT NULL CHECK(json_valid(constraints_json) AND json_type(constraints_json)='array'),
  source_intent_id TEXT REFERENCES intents(id),
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(task_id,number),
  UNIQUE(task_id,id),
  FOREIGN KEY(task_id,previous_revision_id) REFERENCES task_revisions(task_id,id),
  CHECK((number=1 AND previous_revision_id IS NULL) OR (number>1 AND previous_revision_id IS NOT NULL)),
  CHECK(previous_revision_id IS NULL OR previous_revision_id <> id)
) STRICT;

CREATE TRIGGER task_revisions_no_update
BEFORE UPDATE ON task_revisions BEGIN
  SELECT RAISE(ABORT,'task revisions are append-only');
END;
CREATE TRIGGER task_revisions_no_delete
BEFORE DELETE ON task_revisions BEGIN
  SELECT RAISE(ABORT,'task revisions are append-only');
END;

CREATE TABLE intent_targets (
  intent_id TEXT NOT NULL REFERENCES intents(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY(intent_id,task_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX tasks_schedule ON tasks(project_id,state,priority DESC,created_at,id);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  branch_ref TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  ownership_token TEXT NOT NULL UNIQUE,
  base_commit TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('RESERVED','PREPARING','READY','IN_USE',
    'RECOVERY_REQUIRED','RETAINED','RELEASED')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(task_id,id)
) STRICT;
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
  state TEXT NOT NULL CHECK(state IN ('CREATED','PREPARING','STARTING','RUNNING','WAITING_FOR_USER',
    'PAUSING','PAUSED','STOPPING','RECOVERY_REQUIRED','SUCCEEDED','FAILED','CANCELLED','SUPERSEDED')),
  resource_held INTEGER NOT NULL CHECK(resource_held IN (0,1)),
  base_commit TEXT NOT NULL,
  result_commit TEXT,
  stop_reason TEXT CHECK(stop_reason IN ('USER_CANCEL','REVISION_RESTART','SHUTDOWN')),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  started_at INTEGER,
  ended_at INTEGER,
  error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
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

CREATE TABLE verification_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  tested_commit TEXT NOT NULL,
  tree_fingerprint TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  commands_json TEXT NOT NULL CHECK(json_valid(commands_json) AND json_type(commands_json)='array'),
  state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','PASSED','FAILED','ERROR','STALE')),
  evidence_ref TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id),
  CHECK(ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
) STRICT;

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

CREATE TABLE domain_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id),
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

CREATE TABLE command_receipts (
  project_id TEXT NOT NULL REFERENCES projects(id),
  command_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(project_id,command_id)
) STRICT, WITHOUT ROWID;
`;

export const agentStartMigration = `
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
) STRICT;
`;

export const agentObservationMigration = `
ALTER TABLE agent_sessions ADD COLUMN observation_cursor TEXT;

CREATE TABLE adapter_events (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  provider_event_id TEXT NOT NULL,
  cursor TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('attention','completed')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  PRIMARY KEY(session_id,provider_event_id),
  UNIQUE(session_id,cursor)
) STRICT, WITHOUT ROWID;

CREATE TABLE attention_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  provider_request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('PERMISSION','QUESTION','RECOVERY')),
  prompt_json TEXT NOT NULL CHECK(json_valid(prompt_json)),
  status TEXT NOT NULL CHECK(status IN ('OPEN','ANSWER_RECORDED','DELIVERED','CLOSED','STALE')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(session_id,provider_request_id)
) STRICT;
CREATE INDEX open_attention_requests ON attention_requests(session_id,status);
`;

export const agentAnswerMigration = `
ALTER TABLE attention_requests ADD COLUMN response_type TEXT NOT NULL DEFAULT 'VALUE'
  CHECK(response_type IN ('CONFIRM','VALUE'));
UPDATE attention_requests SET response_type='CONFIRM'
  WHERE kind='PERMISSION' OR json_extract(prompt_json,'$.method')='confirm';
UPDATE adapter_events SET payload_json=json_set(payload_json,'$.responseType',
  CASE WHEN json_extract(payload_json,'$.kind')='PERMISSION'
    OR json_extract(payload_json,'$.prompt.method')='confirm' THEN 'CONFIRM' ELSE 'VALUE' END)
  WHERE event_type='attention' AND json_type(payload_json,'$.responseType') IS NULL;

CREATE TABLE attention_answers (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES attention_requests(id),
  command_id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  answer_json TEXT NOT NULL CHECK(json_valid(answer_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;

CREATE TABLE intent_attention_targets (
  intent_id TEXT PRIMARY KEY REFERENCES intents(id),
  attention_id TEXT NOT NULL REFERENCES attention_requests(id)
) STRICT;
`;

// `event_type` is part of a table CHECK, so the Adapter event set is extended by rebuild.
export const agentDisconnectMigration = `
CREATE TABLE adapter_events_v5 (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  provider_event_id TEXT NOT NULL,
  cursor TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('attention','completed','disconnected')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  observed_at INTEGER NOT NULL CHECK(observed_at >= 0),
  PRIMARY KEY(session_id,provider_event_id),
  UNIQUE(session_id,cursor)
) STRICT, WITHOUT ROWID;
INSERT INTO adapter_events_v5(session_id,provider_event_id,cursor,event_type,payload_json,observed_at)
  SELECT session_id,provider_event_id,cursor,event_type,payload_json,observed_at FROM adapter_events;
DROP TABLE adapter_events;
ALTER TABLE adapter_events_v5 RENAME TO adapter_events;
`;

/**
 * Task verification: the confirmation a user gave for a project's verification policy, and
 * the verification runs themselves. `verification_runs` is rebuilt because every column a
 * run needs is mandatory evidence, and SQLite cannot add NOT NULL columns to a live table.
 */
export const taskVerificationMigration = `CREATE TABLE project_verification_policy_confirmations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  policy_state TEXT NOT NULL CHECK(policy_state IN ('ABSENT','PRESENT')),
  policy_digest TEXT,
  main_ref TEXT NOT NULL CHECK(length(trim(main_ref)) > 0),
  main_commit TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUPERSEDED')),
  confirmed_at INTEGER NOT NULL CHECK(confirmed_at >= 0),
  superseded_at INTEGER,
  CHECK((policy_state='ABSENT' AND policy_digest IS NULL)
    OR (policy_state='PRESENT' AND policy_digest IS NOT NULL)),
  CHECK((status='ACTIVE' AND superseded_at IS NULL)
    OR (status='SUPERSEDED' AND superseded_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_active_verification_policy
  ON project_verification_policy_confirmations(project_id) WHERE status='ACTIVE';

CREATE TABLE verification_runs_v6 (
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
  state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','PASSED','FAILED','ERROR','STALE')),
  outcome_code TEXT,
  evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
  queued_at INTEGER NOT NULL CHECK(queued_at >= 0),
  started_at INTEGER,
  ended_at INTEGER,
  UNIQUE(project_id,command_id),
  CHECK(ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  CHECK((state IN ('QUEUED','RUNNING') AND ended_at IS NULL AND outcome_code IS NULL)
    OR (state IN ('PASSED','FAILED','ERROR','STALE') AND ended_at IS NOT NULL AND outcome_code IS NOT NULL)),
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id)
) STRICT;
DROP TABLE verification_runs;
ALTER TABLE verification_runs_v6 RENAME TO verification_runs;
CREATE INDEX verification_subject ON verification_runs(task_id,revision_id,tested_commit);
CREATE INDEX verification_by_task ON verification_runs(project_id,task_id,queued_at);
`;

/**
 * A failed workspace preparation is recorded as a RELEASED workspace so its history is kept, but
 * the previous `path UNIQUE` column constraint also blocked every later attempt for the same
 * Task and path — the documented "fix the conflict and retry" flow could not work. The invariant
 * that matters is "one *live* workspace per path", which is expressed as a partial unique index.
 *
 * `executions` and the result-commit authorizations reference `workspaces(task_id,id)` by name, so
 * the rebuild runs with foreign keys disabled: the child REFERENCES clauses keep naming
 * `workspaces`, which resolves again once the rebuilt table is renamed back.
 */
/**
 * Agent configuration: one persisted override record per scope (global, or one project) per
 * Adapter, plus the effective configuration each Execution actually started with. The Execution
 * column is the provenance: the current configuration may change later, but an Execution keeps
 * the values that produced its result.
 */
export const agentConfigurationMigration = `
ALTER TABLE executions ADD COLUMN agent_config_json TEXT
  CHECK(agent_config_json IS NULL OR json_valid(agent_config_json));

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
  updated_by TEXT NOT NULL CHECK(length(trim(updated_by)) > 0),
  CHECK((scope='GLOBAL' AND project_id IS NULL) OR (scope='PROJECT' AND project_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_global_agent_configuration
  ON agent_configurations(adapter_id) WHERE scope='GLOBAL';
CREATE UNIQUE INDEX one_project_agent_configuration
  ON agent_configurations(project_id,adapter_id) WHERE scope='PROJECT';
`;

export const workspaceRetryMigration = `
CREATE TABLE workspaces_v7 (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  branch_ref TEXT NOT NULL,
  path TEXT NOT NULL,
  ownership_token TEXT NOT NULL UNIQUE,
  base_commit TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('RESERVED','PREPARING','READY','IN_USE',
    'RECOVERY_REQUIRED','RETAINED','RELEASED')),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(task_id,id)
) STRICT;
INSERT INTO workspaces_v7(id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
  SELECT id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at FROM workspaces;
DROP TABLE workspaces;
ALTER TABLE workspaces_v7 RENAME TO workspaces;
CREATE UNIQUE INDEX one_live_workspace ON workspaces(task_id) WHERE state <> 'RELEASED';
CREATE UNIQUE INDEX one_live_workspace_path ON workspaces(path) WHERE state <> 'RELEASED';
`;
