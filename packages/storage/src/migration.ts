export const phase1SchemaVersion = 18;


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
export const taskControlMigration = `
ALTER TABLE tasks ADD COLUMN archived_at INTEGER CHECK(archived_at IS NULL OR archived_at >= 0);
CREATE INDEX tasks_project_archived ON tasks(project_id,archived_at);

-- SQLite cannot widen a CHECK constraint in place, so the executions table is rebuilt to admit
-- the new USER_PAUSE stop reason and to record which predecessor an Execution resumed from.
CREATE TABLE executions_v9 (
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
  resume_from_execution_id TEXT REFERENCES executions(id),
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
INSERT INTO executions_v9(id,task_id,attempt_number,initial_revision_id,applied_revision_id,
  workspace_id,adapter_id,adapter_version,state,resource_held,base_commit,result_commit,
  stop_reason,version,started_at,ended_at,error_json,agent_config_json,resume_from_execution_id)
  SELECT id,task_id,attempt_number,initial_revision_id,applied_revision_id,workspace_id,
    adapter_id,adapter_version,state,resource_held,base_commit,result_commit,stop_reason,version,
    started_at,ended_at,error_json,agent_config_json,NULL FROM executions;
DROP TABLE executions;
ALTER TABLE executions_v9 RENAME TO executions;
CREATE UNIQUE INDEX one_held_execution ON executions(task_id) WHERE resource_held=1;
`;

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

/**
 * Integration pipeline (ADR-0018): a Task's captured result commit enters the long-lived `dev`
 * branch through an IntegrationBatch. A batch records the fixed `dev` baseline it was prepared
 * against, the candidate commit, the merge it produced, and the independent integration
 * verification that had to PASS before the `dev` ref was advanced. A failure never moves `dev`.
 *
 * `integration_batch_items` is keyed by (batch, task) so the same batch shape can carry more than
 * one Task later; this round creates exactly one member per batch.
 *
 * `projects.dev_ref` is the branch a new Task worktree is based on. It is stored instead of being
 * derived so an integration record is self-describing: every base and target SHA can be checked
 * against the ref name it came from.
 */
export const integrationPipelineMigration = `
ALTER TABLE projects ADD COLUMN dev_ref TEXT NOT NULL DEFAULT 'refs/heads/dev';

CREATE TABLE integration_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  dev_ref TEXT NOT NULL CHECK(length(trim(dev_ref)) > 0),
  dev_commit TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('CREATED','PREPARING','VERIFYING','INTEGRATING_DEV',
    'INTEGRATED','CONFLICTED','FAILED','RECOVERY_REQUIRED')),
  integrated_commit TEXT,
  merge_strategy TEXT CHECK(merge_strategy IS NULL OR merge_strategy IN ('FAST_FORWARD','MERGE_COMMIT')),
  /** The merge Git produced before any ref moved; the recovery proof for an interrupted update. */
  merged_commit TEXT,
  worktree_path TEXT,
  worktree_ownership_token TEXT NOT NULL,
  verification_id TEXT,
  outcome_code TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  completed_at INTEGER,
  CHECK(integrated_commit IS NULL OR state='INTEGRATED'),
  CHECK(completed_at IS NULL OR completed_at >= created_at)
) STRICT;
CREATE INDEX integration_batches_by_project ON integration_batches(project_id,created_at,id);

CREATE TABLE integration_batch_items (
  batch_id TEXT NOT NULL REFERENCES integration_batches(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  candidate_commit TEXT NOT NULL,
  dev_commit TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','MERGED','INTEGRATED','FAILED','CONFLICTED')),
  integrated_commit TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  completed_at INTEGER,
  PRIMARY KEY(batch_id,task_id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id),
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id),
  CHECK(integrated_commit IS NULL OR state='INTEGRATED')
) STRICT;
CREATE INDEX integration_items_by_task ON integration_batch_items(project_id,task_id,created_at);

CREATE TABLE integration_verification_runs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES integration_batches(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  command_id TEXT NOT NULL,
  tested_commit TEXT NOT NULL,
  tested_tree TEXT NOT NULL,
  dev_commit TEXT NOT NULL,
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
  UNIQUE(batch_id),
  CHECK(ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  CHECK((state IN ('QUEUED','RUNNING') AND ended_at IS NULL AND outcome_code IS NULL)
    OR (state IN ('PASSED','FAILED','ERROR','STALE') AND ended_at IS NOT NULL AND outcome_code IS NOT NULL)),
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id)
) STRICT;
CREATE INDEX integration_verification_by_task
  ON integration_verification_runs(project_id,task_id,queued_at);
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

/**
 * Long-command Operations (ADR-0019). `task.run` and `task.verify` record what they are doing as
 * durable, ordered steps so a long command has observable progress, can be cancelled from another
 * client, and can be reconciled from facts after a Runtime restart.
 *
 * A step is written at a boundary the Runtime actually reached — never a predicted percentage and
 * never a step it did not finish — so the rows are evidence, not a progress bar estimate.
 *
 * `step_key` makes every step idempotent: replaying the same command ID cannot append the same
 * step twice, which is what keeps a replayed run or verification from looking like new work.
 */
export const operationProgressMigration = `
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
`;

/**
 * Resource reclamation (ADR-0021). One append-only ledger row per resource a `reclaim.apply`
 * examined: what was reclaimed, the ownership evidence that authorized it, and the outcome. Rows
 * are never updated or deleted, so a later attempt adds new rows instead of rewriting history.
 *
 * Schema version 12 is reserved for this migration. Version 11 is reserved by the concurrent A1
 * lane; when both land, both `version <` steps must be kept and run in ascending order.
 */
export const reclamationMigration = `
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
CREATE INDEX reclamation_records_by_project ON reclamation_records(project_id,created_at,id);
CREATE INDEX reclamation_records_by_task ON reclamation_records(project_id,task_id,created_at,id);
CREATE UNIQUE INDEX one_reclamation_record_per_resource
  ON reclamation_records(operation_id,kind,resource_id);
`;

/**
 * Stable branch promotion (ADR-0009 D02/D03, PROJECT_SPEC §2.12/§2.14). One row fixes the three
 * pieces of evidence a promotion is approved for — the verified `dev` commit, the expected old
 * `main` commit, and the independent integration verification that judged the promoted commit —
 * plus the permission mode, the observed `main` after the update, and the Runtime restart result.
 *
 * `promoted_commit` is written only from an observed ref, never from an assumption: a promotion
 * that did not move `main` has no promoted commit. `main` is only ever advanced inside the
 * worktree that has it checked out (ADR-0009 D03), so `main_worktree_path` is part of the plan.
 *
 * Schema version 13 is reserved for this migration. Version 14 is reserved by the concurrent B2
 * lane and 15 by B3; every `version <` step is kept and runs in ascending order, and the version
 * constant stays the maximum of the three (15).
 */
export const stablePromotionMigration = `
CREATE TABLE stable_promotions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  dev_ref TEXT NOT NULL CHECK(length(trim(dev_ref)) > 0),
  main_ref TEXT NOT NULL CHECK(length(trim(main_ref)) > 0),
  candidate_commit TEXT NOT NULL,
  expected_main_commit TEXT NOT NULL,
  integration_batch_id TEXT NOT NULL REFERENCES integration_batches(id),
  verification_id TEXT NOT NULL REFERENCES integration_verification_runs(id),
  verification_tested_commit TEXT NOT NULL,
  permission_mode TEXT NOT NULL CHECK(permission_mode IN ('FULL','STRICT')),
  state TEXT NOT NULL CHECK(state IN ('CREATED','AWAITING_APPROVAL','PROMOTING','RESTARTING',
    'SUCCEEDED','STALE','FAILED','RECOVERY_REQUIRED')),
  approved_dev_commit TEXT,
  approved_main_commit TEXT,
  approved_verification_id TEXT,
  approved_at INTEGER,
  -- Observed main after the fast-forward; NULL until a ref was actually read back.
  promoted_commit TEXT,
  main_worktree_path TEXT,
  -- Boot identity of the Runtime that moved main; a restart must not report the same one.
  promoting_boot_id TEXT,
  restart_steps_json TEXT CHECK(restart_steps_json IS NULL
    OR (json_valid(restart_steps_json) AND json_type(restart_steps_json) = 'array')),
  restart_result_json TEXT CHECK(restart_result_json IS NULL OR json_valid(restart_result_json)),
  outcome_code TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  completed_at INTEGER,
  CHECK((approved_at IS NULL) = (approved_dev_commit IS NULL)),
  CHECK(state <> 'SUCCEEDED' OR promoted_commit IS NOT NULL),
  CHECK(completed_at IS NULL OR completed_at >= created_at),
  CHECK((state IN ('SUCCEEDED','STALE','FAILED') AND completed_at IS NOT NULL)
    OR (state NOT IN ('SUCCEEDED','STALE','FAILED') AND completed_at IS NULL))
) STRICT;
CREATE INDEX stable_promotions_by_project ON stable_promotions(project_id,created_at,id);
-- One open promotion per project: a second attempt would race the first over the same refs.
CREATE UNIQUE INDEX one_open_promotion_per_project ON stable_promotions(project_id)
  WHERE state IN ('CREATED','AWAITING_APPROVAL','PROMOTING','RESTARTING','RECOVERY_REQUIRED');

CREATE TABLE stable_promotion_members (
  promotion_id TEXT NOT NULL REFERENCES stable_promotions(id),
  batch_id TEXT NOT NULL REFERENCES integration_batches(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  candidate_commit TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  PRIMARY KEY(promotion_id,task_id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id),
  FOREIGN KEY(task_id,execution_id) REFERENCES executions(task_id,id)
) STRICT;
`;

/**
 * Session handoff state (ADR-0010 Phase 3, ADR-0023). These tables record the facts the Runtime
 * needs to keep *one* provider writer per conversation and to route a STRICT permission decision
 * back to the exact provider incarnation that asked:
 *
 * - `session_incarnations` is the ordered process-generation history of one Agent Session. A
 *   successor may only be recorded once its predecessor is no longer ACTIVE/FENCED, so the
 *   database itself refuses two writers on one conversation/session file.
 * - `session_writer_leases` is the single-writer lease the Runtime enforces because Pi has no
 *   session-file exclusivity (measured in FOUNDATION-040): at most one un-released holder per
 *   Session, so a second attach/takeover fails as `ATTACHMENT_BUSY` instead of queueing silently.
 * - `session_handoff_requests` is the persisted takeover/return intent plus the handoff fence and
 *   safe-point facts (fence acknowledged, no active tool, settled after the fence).
 * - `session_permission_requests` binds one STRICT permission Attention to the incarnation that
 *   asked for it, so a decision recorded for a superseded incarnation is rejected instead of being
 *   applied to the wrong writer.
 *
 * `agent_sessions.current_incarnation_id` names the only incarnation a decision may still reach.
 *
 * Schema version 14 is reserved for this migration; version 13 is reserved by the concurrent lane.
 */
export const sessionHandoffMigration = `
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

ALTER TABLE agent_sessions ADD COLUMN current_incarnation_id TEXT
  REFERENCES session_incarnations(id);
`;


/**
 * Task dependencies (ADR-0024). An edge is directed dependent -> prerequisite and pins the exact
 * upstream revision, so the edge cannot drift when the upstream specification is amended.
 *
 * Integrity is enforced by the schema, not by the caller: both endpoints must be Tasks of the same
 * project, the pinned revision must belong to the prerequisite, a Task cannot depend on itself, and
 * the ordered pair can exist only once. Edge rows are immutable (a trigger refuses UPDATE):
 * retargeting an edge is a removal plus an addition, so the audit trail never shows a dependency
 * whose meaning silently changed. Cycles are detected in the write transaction by the pure domain
 * graph (see `dependency-graph.ts`), which is the only thing SQLite cannot express here.
 *
 * Schema version 15 is reserved for this migration. Versions 13 and 14 are reserved by the
 * concurrent B1/B2 lanes; when all three land, every `version <` step must be kept and run in
 * ascending order, and the version constant must be the maximum of the three.
 */
export const taskDependenciesMigration = `
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
CREATE INDEX task_dependencies_by_dependent
  ON task_dependencies(project_id,dependent_task_id);
CREATE INDEX task_dependencies_by_prerequisite
  ON task_dependencies(project_id,prerequisite_task_id);
CREATE TRIGGER task_dependencies_no_update
BEFORE UPDATE ON task_dependencies BEGIN
  SELECT RAISE(ABORT,'task dependency edges are immutable; remove and add again');
END;
`;

/**
 * Verification cancellation and long-command progress events (ADR-0027, FOUNDATION-047).
 *
 * `verification_runs` gains the first-class `CANCELLED` terminal state instead of borrowing
 * `ERROR` for a run the user stopped. A state is part of a table CHECK, so the table is rebuilt the
 * same way `executions_v9` was: columns, rows and both indexes are copied verbatim, so existing runs
 * keep their identity, evidence and timestamps. The consistency CHECK is kept and extended —
 * `CANCELLED`, like every other terminal state, must carry both `ended_at` and `outcome_code`, so an
 * unconfirmed stop still cannot be written as a finished run. Nothing references
 * `verification_runs` by foreign key, so the rebuild is safe with foreign keys enabled.
 *
 * `integration_verification_runs` deliberately keeps its own CHECK: an integration verification is
 * not reachable by `task.operation.cancel` (it has its own Operation kind), so there is no cancelled
 * path to express there yet.
 *
 * `operation_progress_events` is the durable, append-only trace of the progress events a long
 * command publishes. The `domain_events` row is the delivered fact; this table adds what the event
 * log alone cannot express: a per-Operation monotonic `progress_sequence` (so a consumer can order
 * and ignore stale progress), a `dedup_key` (so re-emitting the same boundary is a no-op instead of
 * a duplicated fact), and a row for every published event so a projection can be read by
 * `progress_sequence` as well as by the global event cursor.
 *
 * Schema version 17 is reserved for this migration. The C2 lane's native-terminal migration landed
 * after it, so that one is version 18 (below) and version 16 stays unused: a database may already be
 * stamped 17 and would skip a later `version < 16` step.
 */
export const verificationProgressMigration = `
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
INSERT INTO verification_runs_v17(id,project_id,task_id,execution_id,revision_id,operation_id,
  command_id,tested_commit,tested_tree,policy_version,policy_digest,main_commit,commands_json,
  copy_path,state,outcome_code,evidence_json,queued_at,started_at,ended_at)
  SELECT id,project_id,task_id,execution_id,revision_id,operation_id,command_id,tested_commit,
    tested_tree,policy_version,policy_digest,main_commit,commands_json,copy_path,state,outcome_code,
    evidence_json,queued_at,started_at,ended_at FROM verification_runs;
DROP TABLE verification_runs;
ALTER TABLE verification_runs_v17 RENAME TO verification_runs;
CREATE INDEX verification_subject ON verification_runs(task_id,revision_id,tested_commit);
CREATE INDEX verification_by_task ON verification_runs(project_id,task_id,queued_at);

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
`;

/**
 * Native terminal transport (ADR-0026). `session_terminals` records one PTY-hosted provider terminal:
 * the PTY host helper and the provider it owns, the bounded terminal projection facts, and the
 * evidence an explicit release is decided from — the release protocol that was written, the fact
 * that the provider process exited, and the provider's own session file before and after. The exit
 * code is stored as audit data only: FOUNDATION-040 measured that Ctrl+D and SIGTERM both exit 0, so
 * no decision may branch on it.
 *
 * `session_terminal_attachments` is the client-facing half: at most one ATTACHED WRITER per terminal
 * (enforced by a partial unique index) and any number of detached records, so a second writer gets a
 * stable `ATTACHMENT_BUSY` instead of queueing. Terminal bytes are deliberately not persisted
 * anywhere: the projection lives in Runtime memory only (ADR-0010 D06).
 *
 * Schema version 18 is reserved for this migration: the C3 lane's version 17 migration (above)
 * reached dev first, and 16 is intentionally unused for the same reason it stayed unused there.
 * Every `version <` step is kept and runs in ascending order.
 */
export const sessionTerminalMigration = `
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
`;
