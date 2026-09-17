export const phase1SchemaVersion = 37;

/** Stable system Service identities. Projection Services reuse their Project/Task UUIDs. */
export const rootServiceId = '00000000-0000-4000-8000-000000000000';
export const schedulerServiceId = '00000000-0000-4000-8000-000000000001';
export const attentionServiceId = '00000000-0000-4000-8000-000000000002';

/**
 * The kinds `intents.kind` accepts.
 *
 * Five values, four of which any command can still produce: Task creation (`CREATE_TASK`),
 * revision creation (`AMEND_TASK`), cancellation (`CANCEL_TASK`) and Attention answering
 * (`ANSWER_AGENT`). `ADD_CONSTRAINT` is **historical only** since ADR-0065 D05: the constraint
 * feature was deleted, but databases hold real rows that recorded "the user only added a
 * constraint", and rewriting a recorded classification to fit a narrower CHECK would be a history
 * rewrite. No writer emits it any more, and the schema keeps accepting it so those rows survive an
 * upgrade. The projection removal of the three never-producible kinds stays as ADR-0046 decided.
 */
export const intentKinds = ['CREATE_TASK', 'AMEND_TASK', 'ADD_CONSTRAINT', 'CANCEL_TASK',
  'ANSWER_AGENT'] as const;
export type IntentKind = (typeof intentKinds)[number];


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

/**
 * Revision delivery (PROJECT_SPEC §2.11, ADR-0028) and the startup convergence of stale Session
 * projections.
 *
 * `task_revision_deliveries` records one *requirement*: the Execution that must know a newly created
 * revision. `task_revision_delivery_attempts` is the append-only ledger of every attempt to carry it
 * there — the channel, the Execution/Session/incarnation it was aimed at, when it started and how it
 * ended. An acknowledgement is never inferred from "the message was sent": only an attempt that
 * ended `ACKNOWLEDGED` (with the adapter's structured evidence) or a delivery resolved by a successor
 * Execution row whose *recorded* applied revision is this revision satisfies the requirement (the
 * ADR-0001 stop-and-restart fallback). Everything else stays recorded and unsatisfied.
 *
 * `agent_session_startup_reconciliations` is the audit trail of the startup convergence: for one
 * stale Session/Execution projection, what process ownership was actually observed and which states
 * were projected from that observation. It is append-only evidence, never a claim of quiescence.
 *
 * Schema version 19 is reserved for this migration. Version 16 stays permanently unused (a database
 * may already be stamped 17 or 18 and would skip a later `version < 16` step), so this migration only
 * adds `if (version < 19)` after the existing ascending steps.
 */
export const revisionDeliveryMigration = `
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
CREATE INDEX task_revision_delivery_attempts_by_delivery
  ON task_revision_delivery_attempts(delivery_id,attempt_number);
CREATE INDEX in_flight_revision_delivery_attempts ON task_revision_delivery_attempts(deadline_at)
  WHERE state='IN_FLIGHT';

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
`;

/**
 * Deterministic conflict analysis (ADR-0031, `docs/architecture/conflict-analyzer.md`).
 *
 * `project_impact_policy_confirmations` is what makes "unconfirmed mapping is refused" a fact
 * instead of a claim, mirroring the verification policy confirmation: `project trust` records the
 * `INVALID` state too, so a broken mapping is never silently reported as "no mapping".
 *
 * `impact_snapshots` is append-only and keyed by the facts that decide whether an assessment may be
 * reused: (task, revision, base commit, analyzer version, mapping version, change fingerprint). A
 * Task amendment, a moved baseline, an edited mapping, a new analyzer, or an observed diff that grew
 * past the recorded one therefore produces a *new* row instead of overwriting the old one — the
 * previous verdicts stay readable for audit and are simply never selected again.
 *
 * `impact_assessments` stores one pair-wise verdict, keyed by the two snapshots it was computed
 * from. Because the key contains both snapshots, a new snapshot for either side yields a new row. A
 * pair is never updated: there is no column that could turn a recorded `SAFE` into something else,
 * which is the whole point — "actual diff exceeded the prediction" is expressed by writing a new
 * snapshot and a new assessment, not by editing history.
 *
 * Schema version 20 is reserved for this migration. Version 16 stays permanently unused (a database
 * may already be stamped 17–19 and would skip a later `version < 16` step), so this step is appended
 * after the existing ascending ones and only adds `if (version < 20)`.
 */
export const impactAnalysisMigration = `
CREATE TABLE project_impact_policy_confirmations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  policy_state TEXT NOT NULL CHECK(policy_state IN ('ABSENT','PRESENT','INVALID')),
  policy_digest TEXT,
  content_digest TEXT,
  error_code TEXT,
  main_ref TEXT NOT NULL CHECK(length(trim(main_ref)) > 0),
  main_commit TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','SUPERSEDED')),
  confirmed_at INTEGER NOT NULL CHECK(confirmed_at >= 0),
  superseded_at INTEGER,
  CHECK((policy_state='PRESENT' AND policy_digest IS NOT NULL AND content_digest IS NULL)
    OR (policy_state='INVALID' AND policy_digest IS NULL AND content_digest IS NOT NULL)
    OR (policy_state='ABSENT' AND policy_digest IS NULL AND content_digest IS NULL)),
  CHECK((status='ACTIVE' AND superseded_at IS NULL)
    OR (status='SUPERSEDED' AND superseded_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_active_impact_policy
  ON project_impact_policy_confirmations(project_id) WHERE status='ACTIVE';

CREATE TABLE impact_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  analyzer_version TEXT NOT NULL CHECK(length(trim(analyzer_version)) > 0),
  policy_version TEXT NOT NULL CHECK(length(trim(policy_version)) > 0),
  policy_digest TEXT NOT NULL CHECK(length(policy_digest) = 64),
  case_mode TEXT NOT NULL CHECK(case_mode IN ('SENSITIVE','INSENSITIVE')),
  change_fingerprint TEXT NOT NULL CHECK(length(trim(change_fingerprint)) > 0),
  complete INTEGER NOT NULL CHECK(complete IN (0,1)),
  incomplete_reasons_json TEXT NOT NULL
    CHECK(json_valid(incomplete_reasons_json) AND json_type(incomplete_reasons_json)='array'),
  files_json TEXT NOT NULL CHECK(json_valid(files_json) AND json_type(files_json)='array'),
  important_directories_json TEXT NOT NULL
    CHECK(json_valid(important_directories_json) AND json_type(important_directories_json)='array'),
  modules_json TEXT NOT NULL CHECK(json_valid(modules_json) AND json_type(modules_json)='array'),
  global_resources_json TEXT NOT NULL
    CHECK(json_valid(global_resources_json) AND json_type(global_resources_json)='array'),
  unclassified_files_json TEXT NOT NULL
    CHECK(json_valid(unclassified_files_json) AND json_type(unclassified_files_json)='array'),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='array'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(task_id,revision_id,base_commit,analyzer_version,policy_version,change_fingerprint),
  UNIQUE(task_id,id),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id),
  -- An incomplete snapshot must say why: "incomplete for no recorded reason" is not a state anyone
  -- should be able to write, because it would be indistinguishable from a bug in the analyzer.
  CHECK((complete=1) = (json_array_length(incomplete_reasons_json)=0))
) STRICT;
CREATE INDEX impact_snapshots_by_task ON impact_snapshots(project_id,task_id,created_at,id);

CREATE TRIGGER impact_snapshots_no_update
BEFORE UPDATE ON impact_snapshots BEGIN
  SELECT RAISE(ABORT,'impact snapshots are append-only; record a new snapshot instead');
END;
CREATE TRIGGER impact_snapshots_no_delete
BEFORE DELETE ON impact_snapshots BEGIN
  SELECT RAISE(ABORT,'impact snapshots are append-only evidence');
END;

CREATE TABLE impact_assessments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  candidate_task_id TEXT NOT NULL,
  candidate_revision_id TEXT NOT NULL,
  candidate_snapshot_id TEXT NOT NULL REFERENCES impact_snapshots(id),
  other_task_id TEXT NOT NULL,
  other_revision_id TEXT NOT NULL,
  other_snapshot_id TEXT NOT NULL REFERENCES impact_snapshots(id),
  verdict TEXT NOT NULL CHECK(verdict IN ('SAFE_TO_PARALLELIZE','UNKNOWN','CONFLICTING')),
  reason_codes_json TEXT NOT NULL
    CHECK(json_valid(reason_codes_json) AND json_type(reason_codes_json)='array'),
  hits_json TEXT NOT NULL CHECK(json_valid(hits_json) AND json_type(hits_json)='array'),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='array'),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  CHECK(candidate_snapshot_id <> other_snapshot_id),
  UNIQUE(candidate_snapshot_id,other_snapshot_id)
) STRICT;
CREATE INDEX impact_assessments_by_candidate
  ON impact_assessments(project_id,candidate_task_id,created_at,id);
CREATE INDEX impact_assessments_by_other
  ON impact_assessments(project_id,other_task_id,created_at,id);

CREATE TRIGGER impact_assessments_no_update
BEFORE UPDATE ON impact_assessments BEGIN
  SELECT RAISE(ABORT,'impact assessments are append-only; a changed fact needs a new snapshot');
END;
CREATE TRIGGER impact_assessments_no_delete
BEFORE DELETE ON impact_assessments BEGIN
  SELECT RAISE(ABORT,'impact assessments are append-only evidence');
END;
`;
/**
 * Capacity and resource reservations (Phase 2, FOUNDATION-054 / ADR-0032).
 *
 * `project_capacity_limits` and `project_adapter_slot_limits` are the capacity configuration: one
 * project-wide concurrency limit (absent row = the documented default) plus optional per-Adapter
 * overrides. An override row exists only when it was set explicitly, so "follow the project limit"
 * stays a *derived* fact rather than a copied number: changing the global limit moves every
 * Adapter that never had an override, and `capacity get` can report each limit's source.
 *
 * `execution_slot_reservations` is the reservation primitive (scheduler.md §3): one row that
 * expresses, for one Task, the execution right, the Adapter slot, and — once the workspace exists —
 * the workspace. It is not OS isolation: an external process is not stopped by this table, which is
 * why every row records the *evidence* of who created it (Runtime boot identity + process id + OS
 * start token) and why the startup reconcile checks the real writer before it decides anything.
 *
 * Two partial unique indexes make the invariants schema facts instead of conventions:
 *
 * - one active reservation per Task, so two ticks or two start requests can never hold two;
 * - one active reservation per workspace, so one worktree is never claimed by two Tasks.
 *
 * `execution_slot_reservation_events` is the append-only history: the reservation row holds the
 * current state that is compared and swapped, while every observation — including a reconcile that
 * decided to keep the slot occupied — is appended here and never rewritten. `command_id` makes each
 * decision idempotent per caller command, so re-running a reconcile inside one boot appends nothing.
 *
 * Schema version 21 is reserved for this migration. Version 20 belongs to the parallel impact
 * snapshot lane (E1) and version 16 stays permanently unused (a database may already be stamped
 * 17–20 and would skip a later `version < 16` step), so this migration only adds
 * `if (version < 21)` after the existing ascending steps and never inserts an earlier number.
 */
export const capacitySlotReservationMigration = `
CREATE TABLE project_capacity_limits (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  global_limit INTEGER NOT NULL CHECK(global_limit > 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  updated_by TEXT NOT NULL CHECK(length(trim(updated_by)) > 0)
) STRICT;

CREATE TABLE project_adapter_slot_limits (
  project_id TEXT NOT NULL REFERENCES projects(id),
  adapter_id TEXT NOT NULL CHECK(length(trim(adapter_id)) > 0),
  slot_limit INTEGER NOT NULL CHECK(slot_limit > 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  updated_by TEXT NOT NULL CHECK(length(trim(updated_by)) > 0),
  PRIMARY KEY(project_id,adapter_id)
) STRICT;

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
CREATE UNIQUE INDEX one_active_slot_reservation ON execution_slot_reservations(task_id)
  WHERE state IN ('RESERVED','RECOVERY_REQUIRED');
CREATE UNIQUE INDEX one_active_workspace_reservation
  ON execution_slot_reservations(project_id,workspace_id)
  WHERE state IN ('RESERVED','RECOVERY_REQUIRED') AND workspace_id IS NOT NULL;
CREATE INDEX slot_reservations_by_project
  ON execution_slot_reservations(project_id,reserved_at DESC,id);
CREATE INDEX slot_reservations_by_task
  ON execution_slot_reservations(task_id,reserved_at DESC,id);
CREATE INDEX active_slot_reservations_by_adapter
  ON execution_slot_reservations(project_id,adapter_id)
  WHERE state IN ('RESERVED','RECOVERY_REQUIRED');

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
`;

/**
 * Explicit retry of a failed Task (ADR-0036): `FAILED → READY | BLOCKED`, and a new Execution.
 *
 * The Task records the pending retry source before scheduling; the next reserved Execution copies
 * that source and clears the pending relation in the same transaction. Version 22 remains unused,
 * and version 23 is reserved for this additive migration.
 */
export const taskRetryMigration = `
ALTER TABLE tasks ADD COLUMN pending_retry_from_execution_id TEXT REFERENCES executions(id);
ALTER TABLE executions ADD COLUMN retry_from_execution_id TEXT REFERENCES executions(id);
`;

/**
 * Unregistered-directory disposition for reclamation (FOUNDATION-062, ADR-0037).
 *
 * ADR-0021 deliberately refused to touch anything the ledger did not claim: a directory in the
 * Runtime data directory without a `workspaces`/`verification_runs`/`integration_batches` row could
 * only be handled by a person with `rm -rf`, which bypasses both ownership verification and the
 * audit trail. Giving that case a real command face needs the ledger to be able to express it:
 *
 * - `source` records where the row came from, so `reclaim records` can be read back by source
 *   (registered resource vs. unregistered directory) instead of by guessing from a reason code;
 * - `kind` gains `UNREGISTERED_DIRECTORY`, because such a row is not one of the three recorded
 *   resource kinds;
 * - `task_id` becomes nullable: a leftover `verifications/<project>/<id>` directory has a project
 *   (the segmentation of the layout) but no Task it can be honestly attributed to, and inventing
 *   one would be exactly the false attribution this capability must not make;
 * - `outcome` gains `RECOVERY_REQUIRED`, the honest outcome for a directory whose ownership could
 *   not be verified (a live process inside it, an unreadable Git state, an unknown project).
 *
 * The table is rebuilt the same way `verification_runs_v17` was: every existing row is copied
 * verbatim (stamped `REGISTERED`), and both indexes are recreated. Nothing references
 * `reclamation_records` by foreign key, so the rebuild is safe with foreign keys enabled.
 *
 * Schema version 24 is reserved for this migration: 22 and 23 belong to the parallel H1/H3 lanes
 * (which may reach `dev` after this branch), and 16 stays permanently unused — a database may
 * already be stamped 17–23 and would skip a later `version < 16` step. The migration runner keeps
 * every `version <` step and only adds `if (version < 24)` after the existing ascending ones.
 */
export const unregisteredReclamationMigration = `
CREATE TABLE reclamation_records_v24 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT REFERENCES tasks(id),
  operation_id TEXT NOT NULL REFERENCES operations(id),
  command_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'REGISTERED'
    CHECK(source IN ('REGISTERED','UNREGISTERED_DIRECTORY')),
  kind TEXT NOT NULL CHECK(kind IN ('TASK_WORKTREE','VERIFICATION_COPY','INTEGRATION_WORKTREE',
    'UNREGISTERED_DIRECTORY')),
  resource_id TEXT NOT NULL,
  path TEXT NOT NULL,
  ownership_token TEXT,
  external_ref TEXT,
  resource_state TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('RECLAIMED','ALREADY_ABSENT','RETAINED','REFUSED','FAILED',
    'RECOVERY_REQUIRED')),
  reason_code TEXT NOT NULL CHECK(length(trim(reason_code)) > 0),
  detail TEXT,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
INSERT INTO reclamation_records_v24(id,project_id,task_id,operation_id,command_id,source,kind,
  resource_id,path,ownership_token,external_ref,resource_state,outcome,reason_code,detail,
  evidence_json,created_at)
  SELECT id,project_id,task_id,operation_id,command_id,'REGISTERED',kind,resource_id,path,
    ownership_token,external_ref,resource_state,outcome,reason_code,detail,evidence_json,created_at
  FROM reclamation_records;
DROP TABLE reclamation_records;
ALTER TABLE reclamation_records_v24 RENAME TO reclamation_records;
CREATE INDEX reclamation_records_by_project ON reclamation_records(project_id,created_at,id);
CREATE INDEX reclamation_records_by_task ON reclamation_records(project_id,task_id,created_at,id);
CREATE INDEX reclamation_records_by_source ON reclamation_records(source,created_at,id);
CREATE UNIQUE INDEX one_reclamation_record_per_resource
  ON reclamation_records(operation_id,kind,resource_id);
`;

/**
 * Layered verification evidence (ADR-0038 implemented by ADR-0039 / FOUNDATION-065).
 *
 * ADR-0038 splits verification cost by branch responsibility, and the two halves need two new
 * first-class records — both of which are facts a later spectator must be able to read back
 * without trusting a report:
 *
 * - `targeted_test_plans` is the append-only binding of a branch's `.codeestra/tests.json` to the
 *   exact `(task, revision, commit, digest)` it was chosen for. Verification consumes a *recorded*
 *   plan, never the file at read time, so widening or narrowing a branch's scope is an explicit,
 *   audited append instead of a silent edit. UPDATE and DELETE are refused by triggers: the same
 *   append-only discipline as `task_dependencies`, because a plan that changed in place would make
 *   the verification evidence it justified unauditable.
 * - `dev_full_suite_evidence` is the independent "the full suite passed on this exact dev SHA"
 *   evidence a `dev → main` promotion requires. One row per run, bound to the candidate commit, the
 *   fixed project policy (`main` ref) and the lockfile at that commit; the terminal states carry
 *   `ended_at`/`outcome_code` like `verification_runs`, so an unfinished run can never be read as a
 *   pass. A re-run always inserts a new row, so "which run justified this promotion" stays exact.
 *
 * `verification_runs` gains the policy *source* it actually ran (its `policy_digest` alone cannot
 * say whether it was the fixed project policy or a branch-targeted plan), and `stable_promotions`
 * records the exact full-suite evidence triple it was prepared and approved against.
 *
 * Schema version 25 is reserved for this migration; 16 stays permanently unused and no earlier
 * number is ever inserted (a database may already be stamped 17–24 and would skip it).
 */
export const verificationLayeringMigration = `
ALTER TABLE verification_runs ADD COLUMN policy_source TEXT NOT NULL DEFAULT 'PROJECT_POLICY'
  CHECK(policy_source IN ('PROJECT_POLICY','TARGETED_TEST_PLAN'));
ALTER TABLE verification_runs ADD COLUMN plan_id TEXT;
ALTER TABLE verification_runs ADD COLUMN plan_version TEXT;
ALTER TABLE verification_runs ADD COLUMN plan_digest TEXT;

CREATE TABLE targeted_test_plans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  tested_commit TEXT NOT NULL,
  plan_version TEXT NOT NULL CHECK(length(trim(plan_version)) > 0),
  plan_digest TEXT NOT NULL CHECK(length(plan_digest) = 64),
  source_path TEXT NOT NULL CHECK(length(trim(source_path)) > 0),
  commands_json TEXT NOT NULL CHECK(json_valid(commands_json) AND json_type(commands_json)='array'),
  scope TEXT NOT NULL CHECK(length(trim(scope)) > 0),
  recorded_by TEXT NOT NULL CHECK(length(trim(recorded_by)) > 0),
  recorded_at INTEGER NOT NULL CHECK(recorded_at >= 0),
  FOREIGN KEY(task_id,revision_id) REFERENCES task_revisions(task_id,id)
) STRICT;
CREATE UNIQUE INDEX one_targeted_test_plan_per_subject
  ON targeted_test_plans(project_id,task_id,revision_id,tested_commit,plan_digest);
CREATE INDEX targeted_test_plans_by_task
  ON targeted_test_plans(project_id,task_id,recorded_at DESC,id);
CREATE TRIGGER targeted_test_plans_no_update
BEFORE UPDATE ON targeted_test_plans BEGIN
  SELECT RAISE(ABORT,'targeted test plans are append-only; record a new plan instead');
END;
CREATE TRIGGER targeted_test_plans_no_delete
BEFORE DELETE ON targeted_test_plans BEGIN
  SELECT RAISE(ABORT,'targeted test plans are append-only; they are never deleted');
END;

CREATE TABLE dev_full_suite_evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  dev_ref TEXT NOT NULL CHECK(length(trim(dev_ref)) > 0),
  dev_commit TEXT NOT NULL,
  policy_version TEXT NOT NULL CHECK(length(trim(policy_version)) > 0),
  policy_digest TEXT NOT NULL CHECK(length(policy_digest) = 64),
  lockfile_path TEXT NOT NULL CHECK(length(trim(lockfile_path)) > 0),
  -- Absence is bound explicitly: a project with no lockfile records 0 and the digest of no bytes,
  -- so adding one later is a different binding instead of a silently weaker one.
  lockfile_present INTEGER NOT NULL CHECK(lockfile_present IN (0,1)),
  lockfile_digest TEXT NOT NULL CHECK(length(lockfile_digest) = 64),
  commands_json TEXT NOT NULL CHECK(json_valid(commands_json) AND json_type(commands_json)='array'),
  copy_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','PASSED','FAILED','ERROR')),
  outcome_code TEXT,
  evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
  command_id TEXT NOT NULL CHECK(length(trim(command_id)) > 0),
  observed_by TEXT NOT NULL CHECK(length(trim(observed_by)) > 0),
  queued_at INTEGER NOT NULL CHECK(queued_at >= 0),
  started_at INTEGER,
  ended_at INTEGER,
  UNIQUE(project_id,command_id),
  CHECK(ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  CHECK((state IN ('QUEUED','RUNNING') AND ended_at IS NULL AND outcome_code IS NULL)
    OR (state IN ('PASSED','FAILED','ERROR')
      AND ended_at IS NOT NULL AND outcome_code IS NOT NULL))
) STRICT;
CREATE INDEX dev_full_suite_evidence_by_project
  ON dev_full_suite_evidence(project_id,queued_at DESC,id);
CREATE INDEX dev_full_suite_evidence_by_commit
  ON dev_full_suite_evidence(project_id,dev_commit,queued_at DESC);

ALTER TABLE stable_promotions ADD COLUMN full_suite_evidence_id TEXT
  REFERENCES dev_full_suite_evidence(id);
ALTER TABLE stable_promotions ADD COLUMN full_suite_dev_commit TEXT;
ALTER TABLE stable_promotions ADD COLUMN full_suite_policy_version TEXT;
ALTER TABLE stable_promotions ADD COLUMN full_suite_policy_digest TEXT;
ALTER TABLE stable_promotions ADD COLUMN full_suite_lockfile_digest TEXT;
ALTER TABLE stable_promotions ADD COLUMN approved_full_suite_evidence_id TEXT;
`;

/**
 * Project Knowledge layering and per-Execution binding (FOUNDATION-067 / ADR-0041).
 *
 * Two append-only tables, and nothing else:
 *
 * - `knowledge_snapshots` records the knowledge a project declared at one `main` commit: the
 *   resolved entry list with per-entry content digests plus the whole-snapshot digest. It is the
 *   immutable thing an Execution can point at, so a later edit to a knowledge file can never change
 *   what an already-recorded Execution is said to have used. `knowledge_snapshots_no_update` and
 *   `knowledge_snapshots_no_delete` make that a schema fact rather than a convention, exactly like
 *   the revision-history triggers.
 * - `execution_knowledge_snapshots` is the binding itself: one row per Execution, carrying the
 *   snapshot it used and the digest of the exact context file materialized into that Execution's
 *   worktree. `executions` is **not** rebuilt and gains no column (ADR-0041 D07): a new table plus
 *   an optional insert inside `reserveExecution` gives the same atomicity with no table rewrite, and
 *   rows that predate this capability stay exactly as they were.
 *
 * Schema version 26 is reserved for this step: 25 is FOUNDATION-065/ADR-0039, 22 and 23 belong to
 * H1/H3, and 16 stays permanently unused. A database may already be stamped 17–24 and would skip a
 * later `version < 16` step, so the migration runner only appends `if (version < 26)` after the
 * existing ascending steps and never inserts an earlier number.
 */
export const knowledgeLayerMigration = `
CREATE TABLE knowledge_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  main_ref TEXT NOT NULL CHECK(length(trim(main_ref)) > 0),
  main_commit TEXT NOT NULL CHECK(length(trim(main_commit)) > 0),
  policy_version TEXT NOT NULL CHECK(length(trim(policy_version)) > 0),
  snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 64),
  human_digest TEXT NOT NULL CHECK(length(human_digest) = 64),
  generated_digest TEXT NOT NULL CHECK(length(generated_digest) = 64),
  entry_count INTEGER NOT NULL CHECK(entry_count >= 0),
  human_entry_count INTEGER NOT NULL CHECK(human_entry_count >= 0),
  generated_entry_count INTEGER NOT NULL CHECK(generated_entry_count >= 0),
  total_bytes INTEGER NOT NULL CHECK(total_bytes >= 0),
  entries_json TEXT NOT NULL CHECK(json_valid(entries_json)),
  created_by TEXT NOT NULL CHECK(length(trim(created_by)) > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  CHECK(entry_count = human_entry_count + generated_entry_count)
) STRICT;
CREATE UNIQUE INDEX one_knowledge_snapshot_per_state
  ON knowledge_snapshots(project_id,main_commit,snapshot_digest);
CREATE INDEX knowledge_snapshots_by_project ON knowledge_snapshots(project_id,created_at,id);
CREATE TRIGGER knowledge_snapshots_no_update BEFORE UPDATE ON knowledge_snapshots
BEGIN SELECT RAISE(ABORT,'knowledge snapshots are append-only'); END;
CREATE TRIGGER knowledge_snapshots_no_delete BEFORE DELETE ON knowledge_snapshots
BEGIN SELECT RAISE(ABORT,'knowledge snapshots are append-only'); END;

CREATE TABLE execution_knowledge_snapshots (
  execution_id TEXT PRIMARY KEY REFERENCES executions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  snapshot_id TEXT NOT NULL REFERENCES knowledge_snapshots(id),
  snapshot_digest TEXT NOT NULL CHECK(length(snapshot_digest) = 64),
  context_path TEXT NOT NULL CHECK(length(trim(context_path)) > 0),
  context_digest TEXT NOT NULL CHECK(length(context_digest) = 64),
  context_bytes INTEGER NOT NULL CHECK(context_bytes >= 0),
  entry_count INTEGER NOT NULL CHECK(entry_count >= 0),
  refs_json TEXT NOT NULL CHECK(json_valid(refs_json)),
  command_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE INDEX execution_knowledge_snapshots_by_snapshot
  ON execution_knowledge_snapshots(snapshot_id,created_at,execution_id);
CREATE INDEX execution_knowledge_snapshots_by_task
  ON execution_knowledge_snapshots(project_id,task_id,created_at,execution_id);
CREATE TRIGGER execution_knowledge_snapshots_no_update
  BEFORE UPDATE ON execution_knowledge_snapshots
BEGIN SELECT RAISE(ABORT,'execution knowledge bindings are append-only'); END;
CREATE TRIGGER execution_knowledge_snapshots_no_delete
  BEFORE DELETE ON execution_knowledge_snapshots
BEGIN SELECT RAISE(ABORT,'execution knowledge bindings are append-only'); END;
`;

/**
 * Agent plugin/resource selection (FOUNDATION-071 / ADR-0044).
 *
 * A selection is a list, so it cannot live in the three scalar override columns: it is appended as
 * one JSON column on the existing `agent_configurations` table. The table is not rebuilt — an
 * `ALTER TABLE ... ADD COLUMN` keeps every existing row (including both partial unique indexes)
 * exactly as it was, and a row that predates this capability simply has no selection.
 *
 * Schema version 27 is this step's own number: 25 is FOUNDATION-065/ADR-0039, 26 is
 * FOUNDATION-067/ADR-0041, and 16 stays permanently unused. A database may already be stamped
 * 17–26 and would skip a later `version < 16` step, so the migration runner only appends
 * `if (version < 27)` after the existing ascending steps and never inserts an earlier number.
 */
export const agentPluginSelectionMigration = `
ALTER TABLE agent_configurations ADD COLUMN plugin_selection_json TEXT
  CHECK(plugin_selection_json IS NULL OR json_valid(plugin_selection_json));
`;

/**
 * `intents.kind` narrows to the kinds the product can actually produce (FOUNDATION-075 / ADR-0046).
 *
 * The declared CHECK also admitted `CHANGE_PRIORITY` and `SELF_MODIFICATION`, and no command has
 * ever written either: the only writers of `intents` are Task creation (`CREATE_TASK`), revision
 * creation (`AMEND_TASK` / `ADD_CONSTRAINT`) and Attention answering (`ANSWER_AGENT`). A declared
 * but unreachable state is a promise the product does not keep, so the schema stops declaring it.
 *
 * `ANSWER_AGENT` **stays**: `Phase1Database.planAttentionAnswer` writes it in the same
 * transaction as the delivery Operation, and every answered Attention has such a row.
 *
 * SQLite cannot narrow a CHECK in place, so `intents` is rebuilt the same way `workspaces` (v7) and
 * `executions` (v9) were. Three tables reference it by name — `task_revisions.source_intent_id`,
 * `intent_targets.intent_id` and `intent_attention_targets.intent_id` — so the migration runs with
 * foreign keys off and `migrate()` verifies the whole schema afterwards. No row is dropped or
 * rewritten: the copy is a plain `INSERT ... SELECT`.
 *
 * **This script must not be executed on a database that can still hold a removed kind.** Bun's
 * `Database.exec()` swallows a step-time error inside a multi-statement script and keeps going, so a
 * copy rejected by the narrowed CHECK would be followed by `DROP TABLE intents` and the rows would
 * vanish without an error. `Phase1Database.migrate()` therefore refuses such a database up front
 * (named reason, nothing touched) and compares the row count around the rebuild, so the only way to
 * reach this script is with a copy that cannot fail on the kind column.
 */
export const intentKindShrinkMigration = `
CREATE TABLE intents_v28 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  idempotency_key TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  kind TEXT CHECK(kind IN ('CREATE_TASK','AMEND_TASK','ADD_CONSTRAINT','CANCEL_TASK',
    'ANSWER_AGENT')),
  status TEXT NOT NULL CHECK(status IN ('RECORDED','NEEDS_CLARIFICATION','APPLIED','REJECTED')),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  UNIQUE(project_id,idempotency_key)
) STRICT;
INSERT INTO intents_v28(id,project_id,idempotency_key,raw_text,kind,status,actor,created_at)
  SELECT id,project_id,idempotency_key,raw_text,kind,status,actor,created_at FROM intents;
DROP TABLE intents;
ALTER TABLE intents_v28 RENAME TO intents;
`;

/**
 * The dev clone and the GitHub-mediated promotion (FOUNDATION-077 / ADR-0047).
 *
 * Two pure `ALTER TABLE ... ADD COLUMN` steps and nothing else, so no table is rebuilt and no
 * existing row is rewritten:
 *
 * - `projects.dev_repo_path` is the second clone of the same origin a promotion pushes its fixed
 *   candidate from. It is nullable because a project may legitimately have no dev clone yet; a
 *   promotion that needs one refuses with a named reason instead of guessing a path. Its `CHECK`
 *   only refuses an empty string, so a recorded path states something or nothing.
 * - `stable_promotions` gains the facts that make "pushed to the remote" and "pulled into the main
 *   checkout" two distinguishable pieces of evidence: the dev clone this promotion used, the
 *   commit read back from `origin/dev` after the push, the commit read back from `origin/main`
 *   after the publish, and when each happened. `remote_dev_commit` and `remote_main_commit` are
 *   readbacks, never inputs, which is what makes "the push command exited 0" insufficient to be
 *   recorded as a promotion fact.
 *
 * Schema version 29 is this step's own number: 25 is FOUNDATION-065/ADR-0039, 26 is
 * FOUNDATION-067/ADR-0041, 27 is FOUNDATION-071/ADR-0044, 28 is FOUNDATION-075/ADR-0046, and 16
 * stays permanently unused. A database may already be stamped 17–28 and would skip a later
 * `version < 16` step, so the migration runner only appends `if (version < 29)` after the existing
 * ascending steps and never inserts an earlier number.
 */
export const devClonePromotionMigration = `
ALTER TABLE projects ADD COLUMN dev_repo_path TEXT
  CHECK(dev_repo_path IS NULL OR length(trim(dev_repo_path)) > 0);

ALTER TABLE stable_promotions ADD COLUMN dev_repo_path TEXT;
ALTER TABLE stable_promotions ADD COLUMN remote_dev_commit TEXT;
ALTER TABLE stable_promotions ADD COLUMN remote_main_commit TEXT;
ALTER TABLE stable_promotions ADD COLUMN pushed_at INTEGER;
ALTER TABLE stable_promotions ADD COLUMN main_pushed_at INTEGER;
`;

/**
 * Multi-member IntegrationBatch (FOUNDATION-081 / ADR-0053).
 *
 * `integration_batches.state` gains two terminal verdicts that the single-member pipeline could not
 * express:
 *
 * - `STALE` — the batch's fixed evidence (a member's revision/result commit, or the recorded `dev`
 *   baseline) is no longer the current fact, so this batch can never be integrated. `dev` was not
 *   touched and the merge/verification evidence of the batch stays readable; the remedy is to
 *   compose a new batch from the current facts.
 * - `CANCELLED` — the user ended a batch before any Git side effect existed.
 *
 * A `STRICT` table's `CHECK` cannot be widened in place, so this step rebuilds the table with the
 * documented procedure (create → copy → drop → rename) while foreign keys are off, exactly as the
 * v28 `intents` shrink does. The row count is compared before and after by the migration runner,
 * because Bun's `exec()` would otherwise swallow a step-time error inside this multi-statement
 * script and keep going — dropping rows without a word. `integration_batch_items`,
 * `integration_verification_runs` and `stable_promotions` reference this table by name and keep
 * resolving, because the old table is dropped *before* the new one takes the name over and no other
 * table is renamed. No column, index or row is otherwise changed: both new states are additive, so
 * every existing row already satisfies the widened `CHECK`.
 *
 * Schema version 30 is this step's own number: 25 is FOUNDATION-065/ADR-0039, 26 is
 * FOUNDATION-067/ADR-0041, 27 is FOUNDATION-071/ADR-0044, 28 is FOUNDATION-075/ADR-0046, 29 is
 * FOUNDATION-077/ADR-0052, and 16 stays permanently unused. A database may already be stamped
 * 17–29 and would skip a later `version < 16` step, so the migration runner only appends
 * `if (version < 30)` after the existing ascending steps and never inserts an earlier number.
 */
/**
 * Session Guidance (FOUNDATION-088 / ADR-0057).
 *
 * Three additive tables. No existing table is rebuilt and no existing row is rewritten, so the step
 * carries no foreign-key hazard of its own and the runner's `PRAGMA foreign_key_check` stays a
 * check on the whole schema rather than on this script.
 *
 * - `session_guidance` is the durable record of one user guidance message handed to a conversation.
 *   ADR-0010 D02 requires the body to be stored durably *before* delivery so a crash cannot lose it,
 *   and ADR-0010 D06 keeps the text out of domain events: the event carries the body hash and
 *   length, the row carries the text. Nothing here is a specification change — a guidance record
 *   never appears in `task_revisions` and never moves `tasks.current_revision_id` (ADR-0010 D02).
 * - `session_guidance_deliveries` is the append-only attempt ledger, shaped like the revision
 *   delivery ledger (ADR-0028) but with a deliberately weaker vocabulary. "Recorded", "delivered"
 *   and "acknowledged by the model" are three different facts, and only the first two exist here:
 *   `DELIVERED` means the provider's own channel *accepted* the message (it is enqueued), which is
 *   the strongest fact any of the three providers can produce (ADR-0051). There is intentionally no
 *   column in which a model having read the guidance could be written.
 * - `execution_guidance_contexts` records which guidance artifact an Execution was launched with, so
 *   "the guidance survived the process" is readable from the ledger instead of asserted.
 *
 * `source` lists only the value the implementation can produce today (`COMMAND`). ADR-0046 narrowed
 * `intents.kind` to producible values for exactly this reason; TUI-sourced guidance (ADR-0010 D02)
 * is not implemented, so it is not accepted here and will need its own step when it exists.
 *
 * Schema version 31 is this step's own number: 25 is FOUNDATION-065/ADR-0039, 26 is
 * FOUNDATION-067/ADR-0041, 27 is FOUNDATION-071/ADR-0044, 28 is FOUNDATION-075/ADR-0046, 29 is
 * FOUNDATION-077/ADR-0052, 30 is FOUNDATION-081/ADR-0053, and 16 stays permanently unused (22 is
 * skipped by the wave's numbering convention). A database may already be stamped 17–30 and would
 * skip a later `version < 16` step, so the migration runner only appends `if (version < 31)` after
 * the existing ascending steps and never inserts an earlier number.
 */
export const sessionGuidanceMigration = `
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
CREATE INDEX session_guidance_deliveries_by_guidance
  ON session_guidance_deliveries(guidance_id,attempt_number);
CREATE INDEX in_flight_session_guidance_deliveries ON session_guidance_deliveries(deadline_at)
  WHERE state='IN_FLIGHT';

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
`;

/**
 * Declared features on a Task revision (FOUNDATION-091 / ADR-0059).
 *
 * The conflict verdict is "two unfinished Tasks declare the same feature", so the declaration has to
 * be a durable fact of the revision it belongs to — not something derived at judgment time from a
 * change set, which a not-yet-started Task does not have at all.
 *
 * A pure `ADD COLUMN` step: `task_revisions` is not rebuilt, no existing row is rewritten, and every
 * historical revision keeps `'[]'` — which is exactly right, because nothing declared a feature
 * before this column existed, and "no feature declared" is the safe reading (a Task that declared
 * nothing is never in a feature conflict).
 *
 * The CHECK is the same shape the table's own `constraints_json` uses, so a row edited outside this
 * path cannot turn into an unreadable feature list. Feature ids are validated against the project's
 * declared mapping before they are written; this column only guarantees the JSON shape.
 *
 * Schema version 32 is this step's own number: 25 is FOUNDATION-065/ADR-0039, 26 is
 * FOUNDATION-067/ADR-0041, 27 is FOUNDATION-071/ADR-0044, 28 is FOUNDATION-075/ADR-0046, 29 is
 * FOUNDATION-077/ADR-0052, 30 is FOUNDATION-081/ADR-0053, 31 is FOUNDATION-088/ADR-0057, and 16
 * stays permanently unused (22 is skipped by the wave's numbering convention). A database may
 * already be stamped 17–31 and would skip a later `version < 16` step, so the migration runner only
 * appends `if (version < 32)` after the existing ascending steps and never inserts an earlier number.
 */
export const taskRevisionFeaturesMigration = `
ALTER TABLE task_revisions ADD COLUMN features_json TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(features_json) AND json_type(features_json)='array');
`;

/**
 * Version 33 (FOUNDATION-093 / ADR-0060): the base ref a Task worktree was prepared from.
 *
 * A project without a recorded dev clone takes its Task baseline from the project folder's
 * currently checked out branch, so the ref is decided per Task at preparation time and can no
 * longer be re-read from the project row. `NULL` means "no per-Task base was recorded" — the
 * readers fall back to `projects.dev_ref`, which is exactly what records written before this
 * migration meant.
 */
export const taskBaselineRefMigration = `
ALTER TABLE workspaces ADD COLUMN base_ref TEXT
  CHECK(base_ref IS NULL OR length(trim(base_ref)) > 0);
`;

/**
 * The minimum of every explicit legacy capacity value, or `null` when there was none (ADR-0061 D03).
 *
 * Pure and exported so the deterministic rule can be asserted directly instead of only through a
 * migration run: the new global limit is the smallest value the user had explicitly set anywhere
 * (project-wide or per Adapter), because that is the only choice that cannot *increase* the load an
 * upgrade puts on the machine. No explicit value at all means the documented default 2.
 */
export function resolveMigratedGlobalLimit(
  legacyLimits: readonly number[],
): number | null {
  if (legacyLimits.length === 0) return null;
  return Math.min(...legacyLimits);
}

/**
 * Schema v34, capacity half (FOUNDATION-096 / ADR-0061 D01–D03): one concurrency limit for the whole
 * Runtime, the retirement of the two project-scoped configuration tables, and a
 * `runtime_command_receipts` for commands that belong to no Project.
 *
 * **This is one half of one schema version.** The pause half
 * (`runtimePauseControlMigration`, FOUNDATION-097) appends its own tables in the same version number,
 * and the two appends were merged into a single `if (version < 34)` step when the branches were
 * integrated: the `domain_events` rebuild and `runtime_command_receipts` exist **once** in this file,
 * owned here, and the pause half neither repeats them nor depends on their order.
 *
 * - `runtime_capacity_settings` is a singleton. **No row means "never set explicitly"**, so the
 *   reader returns the documented default 2 and reports `limitSource = 'DEFAULT'`; a row exists only
 *   after an explicit `set` or after this migration adopted a legacy value. `BETWEEN 1 AND 16`
 *   makes the legal range a schema fact rather than an application convention.
 * - `runtime_command_receipts` gives a command that belongs to no Project the same idempotency a
 *   project command gets from `command_receipts`: the same command id replays the recorded result,
 *   and the same key with a different payload is refused. A global command cannot be stored in
 *   `command_receipts` because that table carries a `NOT NULL project_id`. Both halves' commands share
 *   this one table.
 * - `domain_events.project_id` becomes nullable, because a Runtime global fact (a global capacity
 *   change, and a global pause) must not be disguised as some Project's event. SQLite cannot relax
 *   `NOT NULL` in place, so the table is rebuilt with the documented create → copy → drop → rename
 *   procedure while foreign keys are off; `NULL` is the only change, every other column, index and
 *   row is copied as it was. `event_deliveries` keeps resolving because the old table is dropped
 *   *before* the new one takes the name over.
 * - The two retired configuration tables are dropped **after** the migration runner has read every
 *   explicit value out of them (the runner computes the minimum, refuses values outside 1–16, and
 *   writes the singleton inside the same transaction). Dropping them first — or losing a value to a
 *   swallowed `exec()` error — is exactly what the row-count guard in `migrate()` is there to catch.
 *
 * Bun's `Database.exec()` swallows a step-time error inside a multi-statement script and keeps
 * going, so the runner compares `domain_events` and `event_deliveries` row counts around this step,
 * asserts the end state the step promised (a nullable `domain_events.project_id`, the pause
 * singleton) and runs `PRAGMA foreign_key_check` after it. Schema version 34 is this step's own
 * number: 25 is FOUNDATION-065/ADR-0039, 26 is FOUNDATION-067/ADR-0041, 27 is FOUNDATION-071/ADR-0044,
 * 28 is FOUNDATION-075/ADR-0046, 29 is FOUNDATION-077/ADR-0052, 30 is FOUNDATION-081/ADR-0053, 31 is
 * FOUNDATION-088/ADR-0057, 32 is FOUNDATION-091/ADR-0059, 33 is FOUNDATION-093/ADR-0060, and 16 stays
 * permanently unused. A database may already be stamped 17–33 and would skip a later `version < 16`
 * step, so the runner only appends `if (version < 34)` after the existing ascending steps and never
 * inserts an earlier number.
 */
export const runtimeGlobalCapacityMigration = `
CREATE TABLE runtime_capacity_settings (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  global_limit INTEGER NOT NULL CHECK(global_limit BETWEEN 1 AND 16),
  version INTEGER NOT NULL CHECK(version >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  updated_by TEXT NOT NULL CHECK(length(trim(updated_by)) > 0)
) STRICT;

CREATE TABLE runtime_command_receipts (
  command_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;

CREATE TABLE domain_events_v34 (
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
INSERT INTO domain_events_v34(sequence,event_id,project_id,event_type,schema_version,aggregate_type,
  aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
  SELECT sequence,event_id,project_id,event_type,schema_version,aggregate_type,aggregate_id,
    aggregate_version,correlation_id,causation_id,occurred_at,payload_json FROM domain_events;
DROP TABLE domain_events;
ALTER TABLE domain_events_v34 RENAME TO domain_events;
CREATE INDEX event_aggregate ON domain_events(aggregate_type,aggregate_id,aggregate_version);

DROP TABLE project_adapter_slot_limits;
DROP TABLE project_capacity_limits;
`;

/**
 * Schema v34, pause half (FOUNDATION-097 / ADR-0061 D10): the persistent Runtime global control state
 * and its per-incarnation freeze targets.
 *
 * These are **control-plane** facts, not Task business state: nothing here changes `tasks.state`,
 * `executions.state` or `agent_sessions.state`, and the five business IDs on a target are a
 * deliberate identity *snapshot* with no foreign key. `task purge` deletes the business aggregates,
 * yet this Runtime must still be able to say which process it froze in this epoch and what happened
 * to it (ADR-0058 keeps the "prove the provider is stopped first" rule on the purge path itself).
 *
 * The singleton row is written here instead of being created lazily by the Runtime: a Runtime that
 * starts with no reader-visible control row would have to invent `RUNNING` on read, and an invented
 * default is exactly the kind of "no row means continue" that ADR-0061 D07 forbids. `pause_epoch = 0`
 * with `state = 'RUNNING'` is the only state a fresh database can be in.
 *
 * `runtime_command_receipts` is **not** created here: the capacity half owns it, both halves' global
 * commands share it, and this version is one step.
 */
export const runtimePauseControlMigration = `
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

INSERT INTO runtime_pause_control(singleton_id,state,pause_epoch,version,requested_at,
  requested_by,settled_at,detail_json)
  VALUES (1,'RUNNING',0,0,NULL,NULL,NULL,NULL);
`;

/**
 * Schema v36 (ADR-0066): the product no longer models a dev clone, a long-lived `dev` branch,
 * integration into it, or `dev → main` promotion.
 *
 * A Task worktree is based on **the project folder's currently checked out branch** for every
 * project — the one rule ADR-0060 introduced for projects without a dev clone, now the only rule.
 * `project_trusts.dev_repo_path`, `projects.dev_ref` and the integration/promotion aggregates are
 * removed rather than left unread: leaving a column that no command can write but a reader could
 * still select is exactly the "two models" this step deletes.
 *
 * **Irreversible by decision (user, 2026-09-16).** The integration batches, their independent
 * verification runs and every stable promotion record are dropped. They were records of a model
 * that no longer exists; the tasks, revisions, executions and task-level `verification_runs` they
 * pointed at are untouched, and worktrees/reclaim records keep their own audit.
 *
 * The column carry-over is load-bearing: `workspaces.base_ref` (v33) is only written by the
 * preparation path, so rows prepared before v33 recorded their baseline ref solely on the project
 * row (`projects.dev_ref`). They are backfilled **before** that column is dropped, and the `projects`
 * rebuild is guarded by a row-count comparison in `migrate()` because Bun's `exec()` would otherwise
 * swallow a copy failure and run the following `DROP TABLE` anyway.
 *
 * Schema version 36 is this step's own number (35 is the Task input fields step, ADR-0065): 16 stays
 * permanently unused and no earlier number is ever inserted. A database may already be stamped
 * 17–35 and would skip a later `version < 16` step.
 */
export const removeDevCloneMigration = `
UPDATE workspaces SET base_ref = (
  SELECT p.dev_ref FROM projects p JOIN tasks t ON t.project_id = p.id
  WHERE t.id = workspaces.task_id
) WHERE base_ref IS NULL;

CREATE TABLE projects_v35 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  repo_root TEXT NOT NULL UNIQUE,
  git_common_dir TEXT NOT NULL UNIQUE,
  main_ref TEXT NOT NULL CHECK(length(trim(main_ref)) > 0),
  object_format TEXT NOT NULL CHECK(object_format IN ('sha1','sha256')),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
INSERT INTO projects_v35(id,name,repo_root,git_common_dir,main_ref,object_format,policy_version,
  created_at)
  SELECT id,name,repo_root,git_common_dir,main_ref,object_format,policy_version,created_at
  FROM projects;
DROP TABLE projects;
ALTER TABLE projects_v35 RENAME TO projects;

DROP TABLE integration_batch_items;
DROP TABLE integration_verification_runs;
DROP TABLE integration_batches;
DROP TABLE stable_promotion_members;
DROP TABLE stable_promotions;
DROP TABLE dev_full_suite_evidence;
`;

export const integrationBatchTerminalStatesMigration = `
CREATE TABLE integration_batches_v30 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  dev_ref TEXT NOT NULL CHECK(length(trim(dev_ref)) > 0),
  dev_commit TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('CREATED','PREPARING','VERIFYING','INTEGRATING_DEV',
    'INTEGRATED','CONFLICTED','FAILED','RECOVERY_REQUIRED','STALE','CANCELLED')),
  integrated_commit TEXT,
  merge_strategy TEXT CHECK(merge_strategy IS NULL OR merge_strategy IN ('FAST_FORWARD','MERGE_COMMIT')),
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
INSERT INTO integration_batches_v30(id,project_id,dev_ref,dev_commit,state,integrated_commit,
  merge_strategy,merged_commit,worktree_path,worktree_ownership_token,verification_id,outcome_code,
  detail,created_at,completed_at)
  SELECT id,project_id,dev_ref,dev_commit,state,integrated_commit,merge_strategy,merged_commit,
    worktree_path,worktree_ownership_token,verification_id,outcome_code,detail,created_at,completed_at
  FROM integration_batches;
DROP TABLE integration_batches;
ALTER TABLE integration_batches_v30 RENAME TO integration_batches;
CREATE INDEX integration_batches_by_project ON integration_batches(project_id,created_at,id);
`;

/**
 * Version 35 (ADR-0065): the Task input fields.
 *
 * A Task gains two Task-level titles and loses two fields that no longer exist in the product:
 *
 * - `tasks.display_title` is what the task list and the task detail render. It is the *stored*
 *   summary rather than a client-side truncation of the body, so every reader shows the same thing.
 *   A historical row has no such field, so it is derived from the first line of the Task's current
 *   revision and truncated to the contract's bound. That is a derived display value from
 *   authoritative data, not an invented one.
 *
 *   Two details of that derivation are load-bearing. SQLite's one-argument `trim()` removes **spaces
 *   only**, not newlines or tabs, so every trim in the script names its whitespace set explicitly —
 *   otherwise a detail that starts with a line break would produce a multi-line "one-line summary".
 *   And a detail whose first line is blank has no first line to use, so the whole detail is folded
 *   onto one line. A detail with no non-whitespace character at all cannot become a title, so
 *   `migrateTaskInputFields()` refuses such a database up front with a named reason instead of
 *   writing a blank title.
 * - `tasks.naming_title` is the Task's name inside its branch and worktree directory. Historical
 *   rows stay NULL on purpose: the Runtime does not fabricate an English name for a Task the user
 *   created before the field existed. A NULL falls back to the internal identity in Git naming
 *   (`task/<task-id>`), which is exactly the name those tasks already have.
 * - `tasks.kind` and `task_revisions.constraints_json` are deleted outright (ADR-0065 D04).
 *
 * Both tables are rebuilt. `tasks` must be, because a `NOT NULL` column cannot be added to a table
 * that already has rows, and `task_revisions` must be, because its `constraints_json` CHECK
 * mentions the dropped column. `task_revisions` carries the append-only triggers, so they are
 * recreated verbatim: losing them would silently make revisions mutable. The old `tasks` indexes
 * are recreated for the same reason.
 *
 * `intents.kind` is **not** touched. Historical rows may hold `ADD_CONSTRAINT` and rewriting a
 * recorded classification to fit a narrower CHECK is exactly the history rewrite the audit rules
 * forbid (ADR-0065 D05); the product simply stops writing that value.
 *
 * No row is dropped or rewritten beyond the two derived/NULL title columns. Bun's `exec()` swallows
 * a step-time error inside a multi-statement script, so `migrate()` compares the row counts of both
 * tables around this script and turns a silently-swallowed copy failure into a loud rollback.
 */
export const taskInputFieldsMigration = `
CREATE TABLE task_revisions_v35 (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  number INTEGER NOT NULL CHECK(number > 0),
  previous_revision_id TEXT,
  specification TEXT NOT NULL CHECK(length(trim(specification)) > 0),
  features_json TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(features_json) AND json_type(features_json)='array'),
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
INSERT INTO task_revisions_v35(id,task_id,number,previous_revision_id,specification,features_json,
  source_intent_id,actor,reason,created_at)
  SELECT id,task_id,number,previous_revision_id,specification,features_json,source_intent_id,actor,
    reason,created_at FROM task_revisions;
DROP TABLE task_revisions;
ALTER TABLE task_revisions_v35 RENAME TO task_revisions;
CREATE TRIGGER task_revisions_no_update
BEFORE UPDATE ON task_revisions BEGIN
  SELECT RAISE(ABORT,'task revisions are append-only');
END;
CREATE TRIGGER task_revisions_no_delete
BEFORE DELETE ON task_revisions BEGIN
  SELECT RAISE(ABORT,'task revisions are append-only');
END;

CREATE TABLE tasks_v35 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  display_number INTEGER NOT NULL CHECK(display_number > 0),
  display_title TEXT NOT NULL
    CHECK(length(trim(display_title)) > 0 AND length(display_title) <= 200
      AND display_title NOT LIKE '%' || char(10) || '%'
      AND display_title NOT LIKE '%' || char(13) || '%'),
  naming_title TEXT CHECK(naming_title IS NULL OR (
    length(naming_title) BETWEEN 1 AND 50
    AND naming_title GLOB '[a-z]*'
    AND naming_title NOT GLOB '*[^a-z0-9-]*'
    AND naming_title NOT LIKE '-%'
    AND naming_title NOT LIKE '%-'
    AND naming_title NOT LIKE '%--%')),
  current_revision_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('DRAFT','BLOCKED','READY','RUNNING','PAUSING','PAUSED',
    'WAITING_FOR_USER','RECOVERY_REQUIRED','EXECUTED','FAILED','CANCELLING','CANCELLED','SUCCEEDED')),
  priority INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  archived_at INTEGER CHECK(archived_at IS NULL OR archived_at >= 0),
  pending_retry_from_execution_id TEXT REFERENCES executions(id),
  UNIQUE(project_id,display_number),
  UNIQUE(project_id,id),
  UNIQUE(id,current_revision_id),
  FOREIGN KEY(id,current_revision_id) REFERENCES task_revisions(task_id,id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
INSERT INTO tasks_v35(id,project_id,display_number,display_title,naming_title,current_revision_id,
  state,priority,version,created_at,updated_at,archived_at,pending_retry_from_execution_id)
  SELECT task.id,task.project_id,task.display_number,
    CASE
      -- The first line, when it has content ...
      WHEN trim(CASE WHEN instr(revision.specification,char(10)) = 0 THEN revision.specification
        ELSE substr(revision.specification,1,instr(revision.specification,char(10))-1) END,
        ' ' || char(9) || char(10) || char(13)) <> ''
      THEN substr(trim(CASE WHEN instr(revision.specification,char(10)) = 0
        THEN revision.specification
        ELSE substr(revision.specification,1,instr(revision.specification,char(10))-1) END,
        ' ' || char(9) || char(10) || char(13)),1,200)
      -- ... otherwise the whole detail folded onto one line (the pre-check guarantees content).
      ELSE substr(trim(replace(replace(revision.specification,char(13),' '),char(10),' '),
        ' ' || char(9)),1,200)
    END,
    NULL,task.current_revision_id,task.state,task.priority,task.version,task.created_at,
    task.updated_at,task.archived_at,task.pending_retry_from_execution_id
  FROM tasks task JOIN task_revisions revision ON revision.id=task.current_revision_id;
DROP TABLE tasks;
ALTER TABLE tasks_v35 RENAME TO tasks;
CREATE INDEX tasks_schedule ON tasks(project_id,state,priority DESC,created_at,id);
CREATE INDEX tasks_project_archived ON tasks(project_id,archived_at);
`;

/**
 * Schema v37 (ADR-0068 / S2): additive Service, Signal and Process kernel storage.
 *
 * Existing Project/Task/Execution rows remain the only writable authority for their core lifecycle.
 * Their Service/Process rows are identity projections: Project and Task Service IDs deliberately
 * equal the corresponding legacy aggregate IDs, and a Process projection equals its Execution ID.
 * This lets old and new command faces name the same fact without a translation-only public ID.
 */
export const serviceKernelMigration = `
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
CREATE UNIQUE INDEX one_root_service ON services((1)) WHERE kind='ROOT';
CREATE UNIQUE INDEX one_scheduler_service ON services((1)) WHERE kind='SCHEDULER';
CREATE UNIQUE INDEX one_attention_service ON services((1)) WHERE kind='ATTENTION';
CREATE INDEX services_by_parent ON services(parent_service_id,kind,id);
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
CREATE TRIGGER services_parent_and_kind_immutable
BEFORE UPDATE OF parent_service_id,kind ON services BEGIN
  SELECT RAISE(ABORT,'service parent and kind are immutable');
END;

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
CREATE TABLE process_execution_links (
  process_id TEXT PRIMARY KEY REFERENCES processes(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL UNIQUE REFERENCES executions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;

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
CREATE INDEX signals_dispatch ON signals(state,next_attempt_at,priority DESC,created_at,id);
CREATE INDEX signals_by_target ON signals(target_service_id,created_at,id);

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

CREATE TABLE signal_receipts (
  target_service_id TEXT NOT NULL REFERENCES services(id),
  idempotency_key TEXT NOT NULL,
  signal_id TEXT NOT NULL UNIQUE REFERENCES signals(id),
  effect_json TEXT NOT NULL CHECK(json_valid(effect_json)),
  acknowledged_at INTEGER NOT NULL CHECK(acknowledged_at >= 0),
  PRIMARY KEY(target_service_id,idempotency_key)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER signal_receipts_no_update BEFORE UPDATE ON signal_receipts BEGIN
  SELECT RAISE(ABORT,'signal receipts are append-only');
END;
CREATE TRIGGER signal_receipts_no_delete BEFORE DELETE ON signal_receipts BEGIN
  SELECT RAISE(ABORT,'signal receipts are append-only');
END;

INSERT INTO services(id,kind,parent_service_id,lifecycle,state_version,contract_version,
  project_id,task_id,inbox_cursor,created_at,updated_at)
VALUES
  ('${rootServiceId}','ROOT',NULL,'ACTIVE',0,1,NULL,NULL,0,0,0),
  ('${schedulerServiceId}','SCHEDULER','${rootServiceId}','ACTIVE',0,1,NULL,NULL,0,0,0),
  ('${attentionServiceId}','ATTENTION','${rootServiceId}','ACTIVE',0,1,NULL,NULL,0,0,0);
INSERT INTO services(id,kind,parent_service_id,lifecycle,state_version,contract_version,
  project_id,task_id,inbox_cursor,created_at,updated_at)
SELECT id,'PROJECT','${rootServiceId}','ACTIVE',0,1,id,NULL,0,created_at,created_at FROM projects;
INSERT INTO services(id,kind,parent_service_id,lifecycle,state_version,contract_version,
  project_id,task_id,inbox_cursor,created_at,updated_at)
SELECT id,'TASK',project_id,'ACTIVE',0,1,NULL,id,0,created_at,updated_at FROM tasks;
INSERT INTO processes(id,kind,parent_service_id,status_source,status,version,objective,adapter_id,
  agent_config_json,budget_json,context_ref,created_at,updated_at)
SELECT execution.id,'DEVELOPMENT',execution.task_id,'EXECUTION',NULL,0,revision.specification,
  execution.adapter_id,execution.agent_config_json,NULL,NULL,
  COALESCE(execution.started_at,task.created_at),
  COALESCE(execution.ended_at,execution.started_at,task.updated_at)
FROM executions execution
JOIN tasks task ON task.id=execution.task_id
JOIN task_revisions revision ON revision.id=execution.applied_revision_id;
INSERT INTO process_execution_links(process_id,execution_id,created_at)
SELECT id,id,COALESCE(started_at,0) FROM executions;
`;
