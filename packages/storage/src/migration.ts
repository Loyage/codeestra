export const phase1SchemaVersion = 1;

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
