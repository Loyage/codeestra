import { Database } from 'bun:sqlite';
import {
  agentAnswerMigration,
  agentDisconnectMigration,
  agentObservationMigration,
  agentStartMigration,
  phase1Migration,
  phase1SchemaVersion,
  taskVerificationMigration,
} from './migration.js';

export class StorageError extends Error {
  constructor(
    readonly code: 'UNSUPPORTED_SCHEMA' | 'COMMAND_CONFLICT' | 'CONCURRENT_MODIFICATION'
      | 'NOT_FOUND' | 'INVALID_STATE',
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export type CommandResult = Readonly<Record<string, unknown>>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export interface TrustedProject {
  readonly id: string;
  readonly name: string;
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly policyVersion: number;
  readonly trustedAt: number;
}

export interface StoredConstraint {
  readonly id: string;
  readonly text: string;
}

export type TaskLifecycleState = 'DRAFT' | 'BLOCKED' | 'READY' | 'RUNNING' | 'PAUSING'
  | 'PAUSED' | 'WAITING_FOR_USER' | 'RECOVERY_REQUIRED' | 'EXECUTED' | 'FAILED'
  | 'CANCELLING' | 'CANCELLED' | 'SUCCEEDED';

export interface AgentStartPlan {
  readonly operationId: string;
  readonly operationState: 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
  readonly projectId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly executionId: string;
  readonly executionVersion: number;
  readonly sessionId: string;
  readonly sessionState: 'STARTING' | 'ACTIVE' | 'EXITED' | 'RECOVERY_REQUIRED';
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly ownershipToken: string;
  readonly revisionId: string;
  readonly specification: string;
  readonly constraints: readonly StoredConstraint[];
  readonly providerSessionId: string | null;
}

export interface ObservableAgentSession {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly executionId: string;
  readonly executionVersion: number;
  readonly executionState: 'RUNNING' | 'WAITING_FOR_USER';
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly sessionState: 'ACTIVE' | 'WAITING_FOR_USER';
  readonly adapterId: string;
  readonly providerSessionId: string;
  readonly cursor?: string;
}

export type StoredAgentAnswer = Readonly<
  | { type: 'CONFIRM'; confirmed: boolean }
  | { type: 'VALUE'; value: string }
  | { type: 'CANCEL' }
>;

export interface AttentionSummary {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly providerRequestId: string;
  readonly kind: 'QUESTION' | 'PERMISSION' | 'RECOVERY';
  readonly responseType: 'CONFIRM' | 'VALUE';
  readonly prompt: unknown;
  readonly status: 'OPEN' | 'ANSWER_RECORDED' | 'DELIVERED' | 'CLOSED' | 'STALE';
  readonly createdAt: number;
}

export interface AgentAnswerPlan extends AttentionSummary {
  readonly operationId: string;
  readonly operationState: 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
  readonly answerId: string;
  readonly answer: StoredAgentAnswer;
  readonly adapterId: string;
  readonly providerSessionId: string;
}

export interface AdapterEventResult {
  readonly duplicate: boolean;
  readonly eventId: string;
  readonly cursor: string;
  readonly sessionState: 'ACTIVE' | 'WAITING_FOR_USER' | 'EXITED' | 'DISCONNECTED';
  readonly executionState: 'RUNNING' | 'WAITING_FOR_USER' | 'FAILED' | 'RECOVERY_REQUIRED';
  readonly attentionId?: string;
}

export interface StoredEventEnvelope {
  readonly eventId: string;
  readonly sequence: number;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly projectId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly occurredAt: number;
  readonly payload: unknown;
}

export interface PendingEventDelivery extends StoredEventEnvelope {
  readonly consumerId: string;
  readonly attemptCount: number;
}

export interface ExecutionReservation {
  readonly executionId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly attemptNumber: number;
  readonly revisionId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly ownershipToken: string;
  readonly baseCommit: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly state: 'CREATED';
}

export type ExecutionLifecycleState = 'CREATED' | 'PREPARING' | 'STARTING' | 'RUNNING'
  | 'WAITING_FOR_USER' | 'PAUSING' | 'PAUSED' | 'STOPPING' | 'RECOVERY_REQUIRED' | 'SUCCEEDED'
  | 'FAILED' | 'CANCELLED' | 'SUPERSEDED';

export type AgentSessionLifecycleState = 'CREATED' | 'STARTING' | 'ACTIVE' | 'WAITING_FOR_USER'
  | 'PAUSING' | 'PAUSED' | 'STOPPING' | 'EXITED' | 'DISCONNECTED' | 'RECOVERY_REQUIRED';

export type WorkspaceLifecycleState = 'RESERVED' | 'PREPARING' | 'READY' | 'IN_USE'
  | 'RECOVERY_REQUIRED' | 'RETAINED' | 'RELEASED';

/** Read-only projection of one Execution attempt and the Agent Session it started, if any. */
export interface ExecutionSummary {
  readonly executionId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly state: ExecutionLifecycleState;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly resourceHeld: boolean;
  readonly baseCommit: string;
  readonly revisionId: string;
  readonly session: {
    readonly sessionId: string;
    readonly state: AgentSessionLifecycleState;
    readonly providerSessionId: string | null;
    readonly cursor: string | null;
  } | null;
}

export interface ResultCommitAuthorization {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly taskVersion: number;
  readonly taskState: TaskLifecycleState;
  readonly currentRevisionId: string;
  readonly executionId: string;
  readonly executionState: ExecutionLifecycleState;
  readonly appliedRevisionId: string;
  readonly resourceHeld: boolean;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly workspaceBranchRef: string;
  readonly workspaceState: WorkspaceLifecycleState;
  readonly baseCommit: string;
  readonly expectedHead: string;
  readonly changeFingerprint: string;
  readonly status: 'ACTIVE' | 'CONSUMED' | 'INVALIDATED';
  readonly createdAt: number;
  /** Recorded result commit once the authorization was consumed. */
  readonly resultCommit: string | null;
  /** True only when a SUCCESS completion proved tools and owned writers stopped. */
  readonly quiescent: boolean;
  readonly sessionState: AgentSessionLifecycleState | null;
}

export interface ResultCommitCapturePlan {
  readonly operationId: string;
  readonly operationState: 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
  readonly authorizationId: string;
  readonly executionId: string;
  readonly taskId: string;
  readonly expectedHead: string;
  readonly changeFingerprint: string;
  readonly authorization: ResultCommitAuthorization;
  /** Recorded commit and tree when the capture already succeeded. */
  readonly resultCommit: string | null;
  readonly resultTree: string | null;
}

export interface WorkspacePreparationPlan {
  readonly operationId: string;
  readonly operationState: 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
  readonly projectId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly workspaceState: 'RESERVED' | 'PREPARING' | 'READY' | 'RECOVERY_REQUIRED' | 'RELEASED';
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly baseCommit: string;
  readonly ownershipToken: string;
  readonly branchRef: string;
  readonly path: string;
}

/** Internal projection used while a result commit is being authorized or captured. */
export interface ResultCommitSubject {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly taskVersion: number;
  readonly taskState: TaskLifecycleState;
  readonly currentRevisionId: string;
  readonly executionId: string;
  readonly executionVersion: number;
  readonly executionState: ExecutionLifecycleState;
  readonly appliedRevisionId: string;
  readonly resourceHeld: boolean;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly workspaceBranchRef: string;
  readonly workspaceState: WorkspaceLifecycleState;
  readonly baseCommit: string;
  readonly quiescent: boolean;
  readonly sessionState: AgentSessionLifecycleState | null;
}

/** The verification policy confirmation that established project trust. */
export interface VerificationPolicyConfirmationInput {
  readonly state: 'ABSENT' | 'PRESENT';
  readonly digest: string | null;
  readonly mainRef: string;
  readonly mainCommit: string;
}

/** Read projection of an active confirmation, including who confirmed it and when. */
export interface ConfirmedVerificationPolicy extends VerificationPolicyConfirmationInput {
  readonly actor: string;
  readonly confirmedAt: number;
}

export type VerificationState = 'QUEUED' | 'RUNNING' | 'PASSED' | 'FAILED' | 'ERROR' | 'STALE';

/** One command of a confirmed policy, as it was frozen into a run. */
export interface StoredVerificationCommand {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds: number;
}

/** Non-secret evidence: exit facts, digests, and paths, never captured command output. */
export type VerificationEvidence = Readonly<Record<string, unknown>>;

export interface VerificationCandidateExecution {
  readonly executionId: string;
  readonly attemptNumber: number;
  readonly state: ExecutionLifecycleState;
  readonly appliedRevisionId: string;
  readonly resultCommit: string | null;
  readonly baseCommit: string;
}

/** Read-only facts the verification service needs before it may run anything. */
export interface VerificationCandidates {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskDisplayNumber: number;
  readonly taskState: TaskLifecycleState;
  readonly currentRevisionId: string;
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  readonly mainRef: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly executions: readonly VerificationCandidateExecution[];
}

export interface VerificationRunSummary {
  readonly verificationId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly revisionId: string;
  readonly testedCommit: string;
  readonly testedTree: string;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly mainCommit: string;
  readonly commands: readonly StoredVerificationCommand[];
  readonly copyPath: string;
  readonly state: VerificationState;
  readonly outcomeCode: string | null;
  readonly evidence: VerificationEvidence | null;
  readonly queuedAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

export interface VerificationRunPlan extends VerificationRunSummary {
  readonly operationId: string;
  readonly operationState: 'PLANNED' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'RECONCILE_REQUIRED';
}

export interface TaskSummary {
  readonly id: string;
  readonly projectId: string;
  readonly displayNumber: number;
  readonly kind: 'DEVELOPMENT' | 'SELF';
  readonly state: TaskLifecycleState;
  readonly priority: number;
  readonly version: number;
  readonly currentRevision: {
    readonly id: string;
    readonly number: number;
    readonly specification: string;
    readonly constraints: readonly StoredConstraint[];
    readonly createdAt: number;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class Phase1Database {
  readonly sqlite: Database;

  constructor(filename = ':memory:') {
    this.sqlite = new Database(filename, { create: true, strict: true });
    this.sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (filename !== ':memory:') this.sqlite.exec('PRAGMA journal_mode=WAL;');
    try {
      this.migrate();
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
  }

  close(): void {
    this.sqlite.close();
  }

  private migrate(): void {
    const row = this.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get();
    const version = row?.user_version ?? 0;
    if (version > phase1SchemaVersion) {
      throw new StorageError('UNSUPPORTED_SCHEMA', `Database schema ${version} is newer than ${phase1SchemaVersion}`);
    }
    if (version === phase1SchemaVersion) return;
    this.sqlite.transaction(() => {
      if (version < 1) this.sqlite.exec(phase1Migration);
      if (version < 2) this.sqlite.exec(agentStartMigration);
      if (version < 3) this.sqlite.exec(agentObservationMigration);
      if (version < 4) this.sqlite.exec(agentAnswerMigration);
      if (version < 5) this.sqlite.exec(agentDisconnectMigration);
      if (version < 6) this.sqlite.exec(taskVerificationMigration);
      this.sqlite.exec(`PRAGMA user_version=${phase1SchemaVersion}`);
    })();
  }

  /** Records the explicit confirmation that established project trust, including the
   * verification policy the user saw. Re-trusting an identical repository supersedes the
   * previous trust and policy confirmation instead of rewriting them. */
  trustProject(input: TrustedProject & {
    readonly trustId: string;
    readonly actor: string;
    readonly verificationPolicyConfirmationId: string;
    readonly verificationPolicy: VerificationPolicyConfirmationInput;
  }): void {
    this.sqlite.transaction(() => {
      const existing = this.sqlite.query<{
        id: string; repo_root: string; git_common_dir: string; main_ref: string;
        object_format: 'sha1' | 'sha256';
      }, [string]>(`
        SELECT id,repo_root,git_common_dir,main_ref,object_format FROM projects WHERE repo_root=?1
      `).get(input.repoRoot);
      let projectId = input.id;
      if (existing === null) {
        this.sqlite.query(`
          INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,object_format,policy_version,created_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
        `).run(input.id, input.name, input.repoRoot, input.gitCommonDir, input.mainRef,
          input.objectFormat, input.policyVersion, input.trustedAt);
      } else {
        if (existing.repo_root !== input.repoRoot || existing.git_common_dir !== input.gitCommonDir
          || existing.object_format !== input.objectFormat) {
          throw new StorageError('INVALID_STATE', 'Repository identity does not match the trusted project');
        }
        projectId = existing.id;
        this.sqlite.query(`
          UPDATE project_trusts SET status='INVALIDATED',invalidated_at=?1
          WHERE project_id=?2 AND status='ACTIVE'
        `).run(input.trustedAt, projectId);
        this.sqlite.query(`
          UPDATE project_verification_policy_confirmations SET status='SUPERSEDED',superseded_at=?1
          WHERE project_id=?2 AND status='ACTIVE'
        `).run(input.trustedAt, projectId);
      }
      this.sqlite.query(`
        INSERT INTO project_trusts
          (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,'ACTIVE',?8)
      `).run(input.trustId, projectId, input.repoRoot, input.gitCommonDir, input.objectFormat,
        input.policyVersion, input.actor, input.trustedAt);
      this.sqlite.query(`
        INSERT INTO project_verification_policy_confirmations
          (id,project_id,policy_state,policy_digest,main_ref,main_commit,actor,status,confirmed_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,'ACTIVE',?8)
      `).run(input.verificationPolicyConfirmationId, projectId, input.verificationPolicy.state,
        input.verificationPolicy.digest, input.verificationPolicy.mainRef,
        input.verificationPolicy.mainCommit, input.actor, input.trustedAt);
    })();
  }

  invalidateProjectTrust(projectId: string, invalidatedAt: number): void {
    this.sqlite.transaction(() => {
      const result = this.sqlite.query(`
        UPDATE project_trusts SET status='INVALIDATED',invalidated_at=?1
        WHERE project_id=?2 AND status='ACTIVE'
      `).run(invalidatedAt, projectId);
      if (result.changes !== 1) throw new StorageError('NOT_FOUND', 'Active project trust was not found');
      this.sqlite.query(`
        UPDATE project_verification_policy_confirmations SET status='SUPERSEDED',superseded_at=?1
        WHERE project_id=?2 AND status='ACTIVE'
      `).run(invalidatedAt, projectId);
    })();
  }

  /** Active confirmation for a trusted project, or null when trust never confirmed one. */
  getConfirmedVerificationPolicy(projectId: string): ConfirmedVerificationPolicy | null {
    const row = this.sqlite.query<{
      policy_state: 'ABSENT' | 'PRESENT'; policy_digest: string | null; main_ref: string;
      main_commit: string; actor: string; confirmed_at: number;
    }, [string]>(`
      SELECT c.policy_state,c.policy_digest,c.main_ref,c.main_commit,c.actor,c.confirmed_at
      FROM project_verification_policy_confirmations c
      JOIN project_trusts trust ON trust.project_id=c.project_id AND trust.status='ACTIVE'
      WHERE c.project_id=?1 AND c.status='ACTIVE'
    `).get(projectId);
    if (row === null) return null;
    return {
      state: row.policy_state,
      digest: row.policy_digest,
      mainRef: row.main_ref,
      mainCommit: row.main_commit,
      actor: row.actor,
      confirmedAt: row.confirmed_at,
    };
  }

  getTrustedProject(projectId: string): TrustedProject {
    const project = this.listTrustedProjects().find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new StorageError('NOT_FOUND', 'Trusted project was not found');
    return project;
  }

  listTrustedProjects(): readonly TrustedProject[] {
    return this.sqlite.query<{
      id: string; name: string; repo_root: string; git_common_dir: string; main_ref: string;
      object_format: 'sha1' | 'sha256'; policy_version: number; accepted_at: number;
    }, []>(`
      SELECT p.id,p.name,p.repo_root,p.git_common_dir,p.main_ref,p.object_format,
             p.policy_version,t.accepted_at
      FROM projects p JOIN project_trusts t ON t.project_id=p.id AND t.status='ACTIVE'
      ORDER BY t.accepted_at,p.id
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      repoRoot: row.repo_root,
      gitCommonDir: row.git_common_dir,
      mainRef: row.main_ref,
      objectFormat: row.object_format,
      policyVersion: row.policy_version,
      trustedAt: row.accepted_at,
    }));
  }

  createTask(input: {
    readonly projectId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly intentId: string;
    readonly taskId: string;
    readonly revisionId: string;
    readonly intentEventId: string;
    readonly taskEventId: string;
    readonly specification: string;
    readonly constraints: readonly StoredConstraint[];
    readonly kind: 'DEVELOPMENT' | 'SELF';
    readonly actor: string;
    readonly createdAt: number;
  }): TaskSummary {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.createdAt,
      apply: (database) => {
        const project = database.query<{ id: string }, [string]>(`
          SELECT p.id FROM projects p JOIN project_trusts t
            ON t.project_id=p.id AND t.status='ACTIVE' WHERE p.id=?1
        `).get(input.projectId);
        if (project === null) throw new StorageError('NOT_FOUND', 'Trusted project was not found');
        const next = database.query<{ display_number: number }, [string]>(`
          SELECT COALESCE(MAX(display_number),0)+1 AS display_number FROM tasks WHERE project_id=?1
        `).get(input.projectId);
        if (next === null) throw new Error('Could not allocate a Task display number');

        database.query(`
          INSERT INTO intents(id,project_id,idempotency_key,raw_text,kind,status,actor,created_at)
          VALUES (?1,?2,?3,?4,'CREATE_TASK','APPLIED',?5,?6)
        `).run(input.intentId, input.projectId, input.commandId, input.specification,
          input.actor, input.createdAt);
        database.query(`
          INSERT INTO tasks(id,project_id,display_number,kind,current_revision_id,state,
            priority,version,created_at,updated_at)
          VALUES (?1,?2,?3,?4,?5,'DRAFT',0,0,?6,?6)
        `).run(input.taskId, input.projectId, next.display_number, input.kind,
          input.revisionId, input.createdAt);
        database.query(`
          INSERT INTO task_revisions(id,task_id,number,previous_revision_id,specification,
            constraints_json,source_intent_id,actor,reason,created_at)
          VALUES (?1,?2,1,NULL,?3,?4,?5,?6,'initial task creation',?7)
        `).run(input.revisionId, input.taskId, input.specification,
          JSON.stringify(input.constraints), input.intentId, input.actor, input.createdAt);
        database.query('INSERT INTO intent_targets(intent_id,task_id) VALUES (?1,?2)')
          .run(input.intentId, input.taskId);
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'IntentRecorded',1,'Intent',?3,0,?4,?4,?5,?6)
        `).run(input.intentEventId, input.projectId, input.intentId, input.commandId, input.createdAt,
          JSON.stringify({ intentId: input.intentId, kind: 'CREATE_TASK' }));
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskCreated',1,'Task',?3,0,?4,?5,?6,?7)
        `).run(input.taskEventId, input.projectId, input.taskId, input.commandId,
          input.intentEventId, input.createdAt,
          JSON.stringify({ taskId: input.taskId, revisionId: input.revisionId, kind: input.kind }));
        return {
          id: input.taskId,
          projectId: input.projectId,
          displayNumber: next.display_number,
          kind: input.kind,
          state: 'DRAFT' as const,
          priority: 0,
          version: 0,
          currentRevision: {
            id: input.revisionId,
            number: 1,
            specification: input.specification,
            constraints: input.constraints,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        };
      },
    });
  }

  listTasks(projectId: string): readonly TaskSummary[] {
    const project = this.sqlite.query<{ id: string }, [string]>(`
      SELECT p.id FROM projects p JOIN project_trusts t
        ON t.project_id=p.id AND t.status='ACTIVE' WHERE p.id=?1
    `).get(projectId);
    if (project === null) throw new StorageError('NOT_FOUND', 'Trusted project was not found');
    return this.sqlite.query<{
      id: string; project_id: string; display_number: number; kind: 'DEVELOPMENT' | 'SELF';
      state: TaskLifecycleState; priority: number; version: number; revision_id: string; revision_number: number;
      specification: string; constraints_json: string; revision_created_at: number;
      created_at: number; updated_at: number;
    }, [string]>(`
      SELECT t.id,t.project_id,t.display_number,t.kind,t.state,t.priority,t.version,
        r.id AS revision_id,r.number AS revision_number,r.specification,r.constraints_json,
        r.created_at AS revision_created_at,t.created_at,t.updated_at
      FROM tasks t JOIN task_revisions r ON r.task_id=t.id AND r.id=t.current_revision_id
      WHERE t.project_id=?1 ORDER BY t.display_number
    `).all(projectId).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      displayNumber: row.display_number,
      kind: row.kind,
      state: row.state,
      priority: row.priority,
      version: row.version,
      currentRevision: {
        id: row.revision_id,
        number: row.revision_number,
        specification: row.specification,
        constraints: JSON.parse(row.constraints_json) as readonly StoredConstraint[],
        createdAt: row.revision_created_at,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** Execution attempts for one Task, newest first, with the current Agent Session if one exists. */
  listTaskExecutions(projectId: string, taskId: string): readonly ExecutionSummary[] {
    const project = this.sqlite.query<{ id: string }, [string]>(`
      SELECT p.id FROM projects p JOIN project_trusts t
        ON t.project_id=p.id AND t.status='ACTIVE' WHERE p.id=?1
    `).get(projectId);
    if (project === null) throw new StorageError('NOT_FOUND', 'Trusted project was not found');
    const task = this.sqlite.query<{ id: string }, [string, string]>(
      'SELECT id FROM tasks WHERE project_id=?1 AND id=?2',
    ).get(projectId, taskId);
    if (task === null) throw new StorageError('NOT_FOUND', 'Task was not found');
    return this.sqlite.query<{
      execution_id: string; task_id: string; attempt_number: number;
      state: ExecutionLifecycleState; adapter_id: string; adapter_version: string;
      resource_held: number; base_commit: string; revision_id: string;
      session_id: string | null; session_state: AgentSessionLifecycleState | null;
      provider_session_id: string | null; observation_cursor: string | null;
    }, [string]>(`
      SELECT execution.id AS execution_id,execution.task_id,execution.attempt_number,execution.state,
        execution.adapter_id,execution.adapter_version,execution.resource_held,execution.base_commit,
        execution.applied_revision_id AS revision_id,
        session.id AS session_id,session.state AS session_state,
        session.provider_session_id,session.observation_cursor
      FROM executions execution LEFT JOIN agent_sessions session ON session.execution_id=execution.id
      WHERE execution.task_id=?1 ORDER BY execution.attempt_number DESC
    `).all(taskId).map((row) => ({
      executionId: row.execution_id,
      taskId: row.task_id,
      attemptNumber: row.attempt_number,
      state: row.state,
      adapterId: row.adapter_id,
      adapterVersion: row.adapter_version,
      resourceHeld: row.resource_held === 1,
      baseCommit: row.base_commit,
      revisionId: row.revision_id,
      session: row.session_id === null || row.session_state === null ? null : {
        sessionId: row.session_id,
        state: row.session_state,
        providerSessionId: row.provider_session_id,
        cursor: row.observation_cursor,
      },
    }));
  }

  findWorkspacePreparation(
    projectId: string,
    idempotencyKey: string,
    payloadHash: string,
  ): WorkspacePreparationPlan | null {
    const existing = this.sqlite.query<{
      id: string; state: WorkspacePreparationPlan['operationState']; request_json: string;
    }, [string, string]>(`
      SELECT id,state,request_json FROM operations
      WHERE project_id=?1 AND kind='PREPARE_WORKSPACE' AND idempotency_key=?2
    `).get(projectId, idempotencyKey);
    if (existing === null) return null;
    const request = JSON.parse(existing.request_json) as { payloadHash: string; workspaceId: string };
    if (request.payloadHash !== payloadHash) {
      throw new StorageError('COMMAND_CONFLICT', 'Workspace command ID was reused with a different payload');
    }
    const workspace = this.workspacePreparationRow(request.workspaceId);
    if (workspace === null) throw new StorageError('INVALID_STATE', 'Workspace operation lost its reservation');
    return { ...workspace, operationId: existing.id, operationState: existing.state };
  }

  listIncompleteWorkspacePreparations(): readonly WorkspacePreparationPlan[] {
    return this.sqlite.query<{ workspace_id: string }, []>(`
      SELECT json_extract(request_json,'$.workspaceId') AS workspace_id
      FROM operations
      WHERE kind='PREPARE_WORKSPACE' AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED')
      ORDER BY created_at,id
    `).all().map((row) => {
      const plan = this.workspacePreparationRow(row.workspace_id);
      if (plan === null) throw new StorageError('INVALID_STATE', 'Workspace operation lost its reservation');
      return plan;
    });
  }

  reserveWorkspacePreparation(input: {
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedTaskVersion: number;
    readonly workspaceId: string;
    readonly ownershipToken: string;
    readonly branchRef: string;
    readonly path: string;
    readonly baseCommit: string;
    readonly createdAt: number;
  }): WorkspacePreparationPlan {
    return this.sqlite.transaction(() => {
      const existing = this.findWorkspacePreparation(
        input.projectId,
        input.idempotencyKey,
        input.payloadHash,
      );
      if (existing !== null) return existing;

      const subject = this.sqlite.query<{
        state: TaskLifecycleState; version: number; repo_root: string; git_common_dir: string;
        main_ref: string; object_format: 'sha1' | 'sha256';
      }, [string, string]>(`
        SELECT task.state,task.version,p.repo_root,p.git_common_dir,p.main_ref,p.object_format
        FROM tasks task JOIN projects p ON p.id=task.project_id
        JOIN project_trusts trust ON trust.project_id=p.id AND trust.status='ACTIVE'
        WHERE task.project_id=?1 AND task.id=?2
      `).get(input.projectId, input.taskId);
      if (subject === null) throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
      if (subject.version !== input.expectedTaskVersion) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
      }
      if (subject.state !== 'READY') {
        throw new StorageError('INVALID_STATE', `Workspace cannot be reserved while Task is ${subject.state}`);
      }
      const requestJson = JSON.stringify({
        payloadHash: input.payloadHash,
        taskId: input.taskId,
        expectedTaskVersion: input.expectedTaskVersion,
        workspaceId: input.workspaceId,
        ownershipToken: input.ownershipToken,
        branchRef: input.branchRef,
        path: input.path,
        baseCommit: input.baseCommit,
      });
      this.sqlite.query(`
        INSERT INTO workspaces(id,task_id,branch_ref,path,ownership_token,base_commit,state,created_at)
        VALUES (?1,?2,?3,?4,?5,?6,'RESERVED',?7)
      `).run(input.workspaceId, input.taskId, input.branchRef, input.path,
        input.ownershipToken, input.baseCommit, input.createdAt);
      this.sqlite.query(`
        INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,
          request_json,created_at,updated_at)
        VALUES (?1,?2,'PREPARE_WORKSPACE',?3,?4,'PLANNED',?5,?6,?6)
      `).run(input.operationId, input.projectId, input.taskId, input.idempotencyKey,
        requestJson, input.createdAt);
      return {
        operationId: input.operationId,
        operationState: 'PLANNED' as const,
        projectId: input.projectId,
        taskId: input.taskId,
        workspaceId: input.workspaceId,
        workspaceState: 'RESERVED' as const,
        repoRoot: subject.repo_root,
        gitCommonDir: subject.git_common_dir,
        mainRef: subject.main_ref,
        objectFormat: subject.object_format,
        baseCommit: input.baseCommit,
        ownershipToken: input.ownershipToken,
        branchRef: input.branchRef,
        path: input.path,
      };
    })();
  }

  startWorkspacePreparation(operationId: string, workspaceId: string, updatedAt: number): void {
    this.sqlite.transaction(() => {
      const operation = this.sqlite.query(`
        UPDATE operations SET state='IN_PROGRESS',updated_at=?1
        WHERE id=?2 AND state='PLANNED'
      `).run(updatedAt, operationId);
      const workspace = this.sqlite.query(`
        UPDATE workspaces SET state='PREPARING' WHERE id=?1 AND state='RESERVED'
      `).run(workspaceId);
      if (operation.changes !== 1 || workspace.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Workspace preparation could not start from its recorded state');
      }
    })();
  }

  completeWorkspacePreparation(input: {
    readonly operationId: string;
    readonly workspaceId: string;
    readonly eventId: string;
    readonly preparedPath: string;
    readonly preparedBranch: string;
    readonly completedAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const plan = this.workspacePreparationRow(input.workspaceId);
      if (plan === null) throw new StorageError('INVALID_STATE', 'Workspace reservation was not found');
      const completable = plan.operationId === input.operationId
        && ((plan.operationState === 'IN_PROGRESS' && plan.workspaceState === 'PREPARING')
          || (plan.operationState === 'RECONCILE_REQUIRED' && plan.workspaceState === 'RECOVERY_REQUIRED'));
      if (!completable || plan.path !== input.preparedPath || plan.branchRef !== input.preparedBranch) {
        throw new StorageError('INVALID_STATE', 'Prepared workspace did not match its reservation');
      }
      this.sqlite.query("UPDATE workspaces SET state='READY' WHERE id=?1").run(input.workspaceId);
      this.sqlite.query(`
        UPDATE operations SET state='SUCCEEDED',result_json=?1,updated_at=?2 WHERE id=?3
      `).run(JSON.stringify({ workspaceId: input.workspaceId, path: input.preparedPath,
        branchRef: input.preparedBranch }), input.completedAt, input.operationId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'WorkspacePrepared',1,'Workspace',?3,0,?4,?4,?5,?6)
      `).run(input.eventId, plan.projectId, input.workspaceId, input.operationId,
        input.completedAt, JSON.stringify({ workspaceId: input.workspaceId,
          taskId: plan.taskId, branch: input.preparedBranch, baseCommit: plan.baseCommit }));
    })();
  }

  recordMissingWorkspacePreparation(input: {
    readonly operationId: string;
    readonly workspaceId: string;
    readonly evidenceRef: string;
    readonly reconciledAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const operation = this.sqlite.query(`
        UPDATE operations SET state='FAILED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state IN ('IN_PROGRESS','RECONCILE_REQUIRED')
      `).run(JSON.stringify({ error: { code: 'MISSING', message: input.evidenceRef } }),
        input.reconciledAt, input.operationId);
      const workspace = this.sqlite.query(`
        UPDATE workspaces SET state='RELEASED'
        WHERE id=?1 AND state IN ('PREPARING','RECOVERY_REQUIRED')
      `).run(input.workspaceId);
      if (operation.changes !== 1 || workspace.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Missing workspace reconciliation did not match recorded state');
      }
    })();
  }

  markWorkspacePreparationUncertain(input: {
    readonly operationId: string;
    readonly workspaceId: string;
    readonly evidenceRef: string;
    readonly reconciledAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const operation = this.sqlite.query(`
        UPDATE operations SET state='RECONCILE_REQUIRED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state IN ('IN_PROGRESS','RECONCILE_REQUIRED')
      `).run(JSON.stringify({ error: { code: 'UNCERTAIN', message: input.evidenceRef } }),
        input.reconciledAt, input.operationId);
      const workspace = this.sqlite.query(`
        UPDATE workspaces SET state='RECOVERY_REQUIRED'
        WHERE id=?1 AND state IN ('PREPARING','RECOVERY_REQUIRED')
      `).run(input.workspaceId);
      if (operation.changes !== 1 || workspace.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Uncertain workspace reconciliation did not match recorded state');
      }
    })();
  }

  failWorkspacePreparation(input: {
    readonly operationId: string;
    readonly workspaceId: string;
    readonly reconcileRequired: boolean;
    readonly error: Readonly<{ code: string; message: string }>;
    readonly failedAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const operationState = input.reconcileRequired ? 'RECONCILE_REQUIRED' : 'FAILED';
      const workspaceState = input.reconcileRequired ? 'RECOVERY_REQUIRED' : 'RELEASED';
      const operation = this.sqlite.query(`
        UPDATE operations SET state=?1,result_json=?2,updated_at=?3
        WHERE id=?4 AND state='IN_PROGRESS'
      `).run(operationState, JSON.stringify({ error: input.error }), input.failedAt, input.operationId);
      const workspace = this.sqlite.query(`
        UPDATE workspaces SET state=?1 WHERE id=?2 AND state='PREPARING'
      `).run(workspaceState, input.workspaceId);
      if (operation.changes !== 1 || workspace.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Workspace preparation failure could not be recorded');
      }
    })();
  }

  private workspacePreparationRow(workspaceId: string): WorkspacePreparationPlan | null {
    const row = this.sqlite.query<{
      operation_id: string; operation_state: WorkspacePreparationPlan['operationState']; project_id: string;
      task_id: string; workspace_id: string; workspace_state: WorkspacePreparationPlan['workspaceState'];
      repo_root: string; git_common_dir: string; main_ref: string; object_format: 'sha1' | 'sha256';
      base_commit: string; ownership_token: string; branch_ref: string; path: string;
    }, [string]>(`
      SELECT operation.id AS operation_id,operation.state AS operation_state,
        operation.project_id,workspace.task_id,workspace.id AS workspace_id,
        workspace.state AS workspace_state,p.repo_root,p.git_common_dir,p.main_ref,p.object_format,
        workspace.base_commit,workspace.ownership_token,workspace.branch_ref,workspace.path
      FROM workspaces workspace JOIN tasks task ON task.id=workspace.task_id
      JOIN projects p ON p.id=task.project_id
      JOIN operations operation ON operation.aggregate_id=task.id AND operation.kind='PREPARE_WORKSPACE'
        AND json_extract(operation.request_json,'$.workspaceId')=workspace.id
      WHERE workspace.id=?1
    `).get(workspaceId);
    if (row === null) return null;
    return {
      operationId: row.operation_id,
      operationState: row.operation_state,
      projectId: row.project_id,
      taskId: row.task_id,
      workspaceId: row.workspace_id,
      workspaceState: row.workspace_state,
      repoRoot: row.repo_root,
      gitCommonDir: row.git_common_dir,
      mainRef: row.main_ref,
      objectFormat: row.object_format,
      baseCommit: row.base_commit,
      ownershipToken: row.ownership_token,
      branchRef: row.branch_ref,
      path: row.path,
    };
  }

  markExecutionPreparing(input: {
    readonly projectId: string;
    readonly executionId: string;
    readonly expectedExecutionVersion: number;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly eventId: string;
    readonly changedAt: number;
  }): Readonly<{ executionId: string; state: 'PREPARING'; version: number }> {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.changedAt,
      apply: (database) => {
        const execution = database.query<{ state: string; version: number }, [string, string]>(`
          SELECT execution.state,execution.version FROM executions execution
          JOIN tasks task ON task.id=execution.task_id
          WHERE task.project_id=?1 AND execution.id=?2
        `).get(input.projectId, input.executionId);
        if (execution === null) throw new StorageError('NOT_FOUND', 'Execution was not found');
        if (execution.version !== input.expectedExecutionVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Execution version did not match');
        }
        if (execution.state !== 'CREATED') {
          throw new StorageError('INVALID_STATE', `Execution cannot prepare from ${execution.state}`);
        }
        const version = input.expectedExecutionVersion + 1;
        database.query("UPDATE executions SET state='PREPARING',version=?1 WHERE id=?2")
          .run(version, input.executionId);
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?5,?6,?7)
        `).run(input.eventId, input.projectId, input.executionId, version, input.commandId,
          input.changedAt, JSON.stringify({ executionId: input.executionId,
            from: 'CREATED', to: 'PREPARING', reason: 'workspace ready' }));
        return { executionId: input.executionId, state: 'PREPARING' as const, version };
      },
    });
  }

  findAgentStart(projectId: string, idempotencyKey: string, payloadHash: string): AgentStartPlan | null {
    const operation = this.sqlite.query<{
      id: string; state: AgentStartPlan['operationState']; request_json: string;
    }, [string, string]>(`
      SELECT id,state,request_json FROM operations
      WHERE project_id=?1 AND kind='START_AGENT' AND idempotency_key=?2
    `).get(projectId, idempotencyKey);
    if (operation === null) return null;
    const request = JSON.parse(operation.request_json) as { payloadHash: string; sessionId: string };
    if (request.payloadHash !== payloadHash) {
      throw new StorageError('COMMAND_CONFLICT', 'Agent start command ID was reused with a different payload');
    }
    const plan = this.agentStartRow(request.sessionId);
    if (plan === null) throw new StorageError('INVALID_STATE', 'Agent start operation lost its Session');
    return { ...plan, operationId: operation.id, operationState: operation.state };
  }

  listIncompleteAgentStarts(): readonly AgentStartPlan[] {
    return this.sqlite.query<{ session_id: string }, []>(`
      SELECT json_extract(request_json,'$.sessionId') AS session_id
      FROM operations
      WHERE kind='START_AGENT' AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED')
      ORDER BY created_at,id
    `).all().map((row) => {
      const plan = this.agentStartRow(row.session_id);
      if (plan === null) throw new StorageError('INVALID_STATE', 'Agent start Operation lost its Session');
      return plan;
    });
  }

  planAgentStart(input: {
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly payloadHash: string;
    readonly projectId: string;
    readonly executionId: string;
    readonly expectedExecutionVersion: number;
    readonly sessionId: string;
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly capabilities: unknown;
    readonly eventId: string;
    readonly plannedAt: number;
  }): AgentStartPlan {
    return this.sqlite.transaction(() => {
      const existing = this.findAgentStart(input.projectId, input.idempotencyKey, input.payloadHash);
      if (existing !== null) return existing;
      const subject = this.sqlite.query<{
        task_id: string; execution_state: string; execution_version: number; adapter_id: string;
        adapter_version: string; workspace_id: string; workspace_path: string; ownership_token: string;
        revision_id: string; specification: string; constraints_json: string;
      }, [string, string]>(`
        SELECT task.id AS task_id,execution.state AS execution_state,
          execution.version AS execution_version,execution.adapter_id,execution.adapter_version,
          workspace.id AS workspace_id,workspace.path AS workspace_path,workspace.ownership_token,
          revision.id AS revision_id,revision.specification,revision.constraints_json
        FROM executions execution JOIN tasks task ON task.id=execution.task_id
        JOIN workspaces workspace ON workspace.id=execution.workspace_id AND workspace.task_id=task.id
        JOIN task_revisions revision ON revision.id=execution.applied_revision_id AND revision.task_id=task.id
        WHERE task.project_id=?1 AND execution.id=?2 AND task.state='RUNNING'
          AND workspace.state='IN_USE'
      `).get(input.projectId, input.executionId);
      if (subject === null) throw new StorageError('NOT_FOUND', 'Runnable Execution was not found');
      if (subject.execution_version !== input.expectedExecutionVersion) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Execution version did not match');
      }
      if (subject.execution_state !== 'PREPARING') {
        throw new StorageError('INVALID_STATE', `Agent cannot start from ${subject.execution_state}`);
      }
      if (subject.adapter_id !== input.adapterId || subject.adapter_version !== input.adapterVersion) {
        throw new StorageError(
          'INVALID_STATE',
          `Execution reserved ${subject.adapter_id}@${subject.adapter_version}, got ${input.adapterId}@${input.adapterVersion}`,
        );
      }
      const requestJson = JSON.stringify({
        payloadHash: input.payloadHash,
        executionId: input.executionId,
        expectedExecutionVersion: input.expectedExecutionVersion,
        sessionId: input.sessionId,
      });
      this.sqlite.query(`
        INSERT INTO agent_sessions(id,execution_id,capabilities_json,state,version,last_observed_at)
        VALUES (?1,?2,?3,'STARTING',0,?4)
      `).run(input.sessionId, input.executionId, JSON.stringify(input.capabilities), input.plannedAt);
      this.sqlite.query(`
        INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,
          request_json,created_at,updated_at)
        VALUES (?1,?2,'START_AGENT',?3,?4,'PLANNED',?5,?6,?6)
      `).run(input.operationId, input.projectId, input.executionId, input.idempotencyKey,
        requestJson, input.plannedAt);
      const executionVersion = input.expectedExecutionVersion + 1;
      this.sqlite.query("UPDATE executions SET state='STARTING',version=?1 WHERE id=?2")
        .run(executionVersion, input.executionId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?5,?6,?7)
      `).run(input.eventId, input.projectId, input.executionId, executionVersion,
        input.idempotencyKey, input.plannedAt, JSON.stringify({ executionId: input.executionId,
          from: 'PREPARING', to: 'STARTING', reason: 'agent start planned' }));
      const plan = this.agentStartRow(input.sessionId);
      if (plan === null) throw new Error('Agent start plan was not persisted');
      return plan;
    })();
  }

  startAgentOperation(operationId: string, startedAt: number): void {
    const result = this.sqlite.query(`
      UPDATE operations SET state='IN_PROGRESS',updated_at=?1 WHERE id=?2 AND state='PLANNED'
    `).run(startedAt, operationId);
    if (result.changes !== 1) throw new StorageError('INVALID_STATE', 'Agent start Operation was not PLANNED');
  }

  completeAgentStart(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly providerSessionId: string;
    readonly adapterId: string;
    readonly sessionEventId: string;
    readonly executionEventId: string;
    readonly processIdentity?: unknown;
    readonly sessionStorageRef?: string;
    readonly completedAt: number;
  }): AgentStartPlan {
    return this.sqlite.transaction(() => {
      const plan = this.agentStartRow(input.sessionId);
      if (plan === null || plan.operationId !== input.operationId
        || plan.operationState !== 'IN_PROGRESS' || plan.sessionState !== 'STARTING'
        || plan.adapterId !== input.adapterId) {
        throw new StorageError('INVALID_STATE', 'Started Agent Session did not match its plan');
      }
      this.sqlite.query(`
        UPDATE agent_sessions SET state='ACTIVE',provider_session_id=?1,version=version+1,
          last_observed_at=?2,process_identity_json=?3,session_storage_ref=?4 WHERE id=?5
      `).run(input.providerSessionId, input.completedAt,
        input.processIdentity === undefined ? null : JSON.stringify(input.processIdentity),
        input.sessionStorageRef ?? null, input.sessionId);
      this.sqlite.query(`
        UPDATE executions SET state='RUNNING',version=version+1,started_at=?1
        WHERE id=?2 AND state='STARTING'
      `).run(input.completedAt, plan.executionId);
      this.sqlite.query(`
        UPDATE operations SET state='SUCCEEDED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state='IN_PROGRESS'
      `).run(JSON.stringify({ sessionId: input.sessionId, providerSessionId: input.providerSessionId }),
        input.completedAt, input.operationId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?5,?6,?7)
      `).run(input.executionEventId, plan.projectId, plan.executionId, plan.executionVersion + 1,
        input.operationId, input.completedAt, JSON.stringify({ executionId: plan.executionId,
          from: 'STARTING', to: 'RUNNING', reason: 'agent session started' }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'AgentSessionStarted',1,'AgentSession',?3,1,?4,?5,?6,?7)
      `).run(input.sessionEventId, plan.projectId, input.sessionId, input.operationId,
        input.executionEventId, input.completedAt, JSON.stringify({ executionId: plan.executionId,
          sessionId: input.sessionId, adapterId: input.adapterId,
          providerSessionId: input.providerSessionId }));
      const completed = this.agentStartRow(input.sessionId);
      if (completed === null) throw new Error('Completed Agent Session was not found');
      return completed;
    })();
  }

  failAgentStartBeforeSideEffect(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly error: Readonly<{ code: string; message: string }>;
    readonly failedAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const plan = this.agentStartRow(input.sessionId);
      if (plan === null || plan.operationId !== input.operationId
        || plan.operationState !== 'IN_PROGRESS' || plan.sessionState !== 'STARTING') {
        throw new StorageError('INVALID_STATE', 'Failed Agent start did not match its plan');
      }
      this.sqlite.query(`
        UPDATE agent_sessions SET state='EXITED',version=version+1,last_observed_at=?1,exit_json=?2
        WHERE id=?3
      `).run(input.failedAt, JSON.stringify(input.error), input.sessionId);
      this.sqlite.query(`
        UPDATE executions SET state='FAILED',resource_held=0,version=version+1,ended_at=?1,error_json=?2
        WHERE id=?3 AND state='STARTING'
      `).run(input.failedAt, JSON.stringify(input.error), plan.executionId);
      this.sqlite.query("UPDATE workspaces SET state='RETAINED' WHERE id=?1 AND state='IN_USE'")
        .run(plan.workspaceId);
      this.sqlite.query(`
        UPDATE tasks SET state='FAILED',version=version+1,updated_at=?1
        WHERE id=?2 AND state='RUNNING'
      `).run(input.failedAt, plan.taskId);
      this.sqlite.query(`
        UPDATE operations SET state='FAILED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state='IN_PROGRESS'
      `).run(JSON.stringify({ error: input.error }), input.failedAt, input.operationId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionFailed',1,'Execution',?3,?4,?5,?5,?6,?7)
      `).run(input.executionEventId, plan.projectId, plan.executionId, plan.executionVersion + 1,
        input.operationId, input.failedAt, JSON.stringify({ executionId: plan.executionId,
          reason: input.error.code, stopEvidenceRef: 'no-session-created' }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
      `).run(input.taskEventId, plan.projectId, plan.taskId, plan.taskVersion + 1,
        input.operationId, input.executionEventId, input.failedAt,
        JSON.stringify({ taskId: plan.taskId, from: 'RUNNING', to: 'FAILED',
          reason: 'agent start failed before side effect' }));
    })();
  }

  markAgentStartUncertain(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly recoveryEventId: string;
    readonly taskEventId: string;
    readonly error: Readonly<{ code: string; message: string }>;
    readonly failedAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const plan = this.agentStartRow(input.sessionId);
      if (plan === null || plan.operationId !== input.operationId
        || plan.operationState !== 'IN_PROGRESS' || plan.sessionState !== 'STARTING') {
        throw new StorageError('INVALID_STATE', 'Uncertain Agent start did not match its plan');
      }
      this.sqlite.query("UPDATE agent_sessions SET state='RECOVERY_REQUIRED',version=version+1,last_observed_at=?1 WHERE id=?2")
        .run(input.failedAt, input.sessionId);
      this.sqlite.query("UPDATE executions SET state='RECOVERY_REQUIRED',version=version+1 WHERE id=?1")
        .run(plan.executionId);
      this.sqlite.query("UPDATE workspaces SET state='RECOVERY_REQUIRED' WHERE id=?1")
        .run(plan.workspaceId);
      this.sqlite.query("UPDATE tasks SET state='RECOVERY_REQUIRED',version=version+1,updated_at=?1 WHERE id=?2")
        .run(input.failedAt, plan.taskId);
      this.sqlite.query(`
        UPDATE operations SET state='RECONCILE_REQUIRED',result_json=?1,updated_at=?2 WHERE id=?3
      `).run(JSON.stringify({ error: input.error }), input.failedAt, input.operationId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'RecoveryRequired',1,'Execution',?3,?4,?5,?5,?6,?7)
      `).run(input.recoveryEventId, plan.projectId, plan.executionId, plan.executionVersion + 1,
        input.operationId, input.failedAt, JSON.stringify({ resourceType: 'AgentSession',
          resourceId: input.sessionId, reason: input.error.code }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
      `).run(input.taskEventId, plan.projectId, plan.taskId, plan.taskVersion + 1,
        input.operationId, input.recoveryEventId, input.failedAt,
        JSON.stringify({ taskId: plan.taskId, from: 'RUNNING', to: 'RECOVERY_REQUIRED',
          reason: 'agent start uncertain' }));
    })();
  }

  private agentStartRow(sessionId: string): AgentStartPlan | null {
    const row = this.sqlite.query<{
      operation_id: string; operation_state: AgentStartPlan['operationState']; project_id: string;
      task_id: string; task_version: number; execution_id: string; execution_version: number; session_id: string;
      session_state: AgentStartPlan['sessionState']; adapter_id: string; adapter_version: string;
      workspace_id: string; workspace_path: string; ownership_token: string; revision_id: string;
      specification: string; constraints_json: string; provider_session_id: string | null;
    }, [string]>(`
      SELECT operation.id AS operation_id,operation.state AS operation_state,operation.project_id,
        task.id AS task_id,task.version AS task_version,execution.id AS execution_id,
        execution.version AS execution_version,
        session.id AS session_id,session.state AS session_state,execution.adapter_id,execution.adapter_version,
        workspace.id AS workspace_id,workspace.path AS workspace_path,workspace.ownership_token,
        revision.id AS revision_id,revision.specification,revision.constraints_json,session.provider_session_id
      FROM agent_sessions session JOIN executions execution ON execution.id=session.execution_id
      JOIN tasks task ON task.id=execution.task_id JOIN workspaces workspace ON workspace.id=execution.workspace_id
      JOIN task_revisions revision ON revision.id=execution.applied_revision_id
      JOIN operations operation ON operation.aggregate_id=execution.id AND operation.kind='START_AGENT'
        AND json_extract(operation.request_json,'$.sessionId')=session.id
      WHERE session.id=?1
    `).get(sessionId);
    if (row === null) return null;
    return {
      operationId: row.operation_id,
      operationState: row.operation_state,
      projectId: row.project_id,
      taskId: row.task_id,
      taskVersion: row.task_version,
      executionId: row.execution_id,
      executionVersion: row.execution_version,
      sessionId: row.session_id,
      sessionState: row.session_state,
      adapterId: row.adapter_id,
      adapterVersion: row.adapter_version,
      workspaceId: row.workspace_id,
      workspacePath: row.workspace_path,
      ownershipToken: row.ownership_token,
      revisionId: row.revision_id,
      specification: row.specification,
      constraints: JSON.parse(row.constraints_json) as readonly StoredConstraint[],
      providerSessionId: row.provider_session_id,
    };
  }

  getObservableAgentSession(sessionId: string): ObservableAgentSession {
    const row = this.observableAgentSessionRow(sessionId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Observable Agent Session was not found');
    if (row.providerSessionId === null) {
      throw new StorageError('INVALID_STATE', 'Agent Session has no provider identity');
    }
    if (!['ACTIVE', 'WAITING_FOR_USER'].includes(row.sessionState)
      || !['RUNNING', 'WAITING_FOR_USER'].includes(row.executionState)) {
      throw new StorageError('INVALID_STATE', `Agent Session cannot be observed from ${row.sessionState}`);
    }
    return { ...row, providerSessionId: row.providerSessionId } as ObservableAgentSession;
  }

  recordAgentAttention(input: {
    readonly sessionId: string;
    readonly executionId: string;
    readonly providerEventId: string;
    readonly cursor: string;
    readonly providerRequestId: string;
    readonly kind: 'QUESTION' | 'PERMISSION';
    readonly responseType: 'CONFIRM' | 'VALUE';
    readonly prompt: unknown;
    readonly attentionId: string;
    readonly attentionEventId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly observedAt: number;
  }): AdapterEventResult {
    return this.sqlite.transaction(() => {
      const payload = { providerRequestId: input.providerRequestId, kind: input.kind,
        responseType: input.responseType, prompt: input.prompt };
      const payloadJson = JSON.stringify(payload);
      const duplicate = this.adapterEventDuplicate(input.sessionId, input.providerEventId,
        input.cursor, 'attention', payloadJson);
      if (duplicate) return this.adapterEventResult(input.sessionId, input.providerEventId);
      const subject = this.observableAgentSessionRow(input.sessionId);
      if (subject === null || subject.executionId !== input.executionId) {
        throw new StorageError('NOT_FOUND', 'Adapter event Session identity did not match');
      }
      if (subject.sessionState !== 'ACTIVE' || subject.executionState !== 'RUNNING') {
        throw new StorageError('INVALID_STATE',
          `Attention requires ACTIVE/RUNNING, got ${subject.sessionState}/${subject.executionState}`);
      }
      const promptJson = JSON.stringify(input.prompt);
      if (promptJson === undefined) throw new StorageError('INVALID_STATE', 'Attention prompt is not JSON serializable');
      this.insertAdapterEvent(input.sessionId, input.providerEventId, input.cursor,
        'attention', payloadJson, input.observedAt);
      this.sqlite.query(`
        INSERT INTO attention_requests(id,session_id,provider_request_id,kind,prompt_json,status,created_at,response_type)
        VALUES (?1,?2,?3,?4,?5,'OPEN',?6,?7)
      `).run(input.attentionId, input.sessionId, input.providerRequestId, input.kind,
        promptJson, input.observedAt, input.responseType);
      const sessionUpdate = this.sqlite.query(`
        UPDATE agent_sessions SET state='WAITING_FOR_USER',version=version+1,
          observation_cursor=?1,last_observed_at=?2 WHERE id=?3 AND state='ACTIVE'
      `).run(input.cursor, input.observedAt, input.sessionId);
      const executionUpdate = this.sqlite.query(`
        UPDATE executions SET state='WAITING_FOR_USER',version=version+1
        WHERE id=?1 AND state='RUNNING'
      `).run(input.executionId);
      const taskUpdate = this.sqlite.query(`
        UPDATE tasks SET state='WAITING_FOR_USER',version=version+1,updated_at=?1
        WHERE id=?2 AND state='RUNNING'
      `).run(input.observedAt, subject.taskId);
      if (sessionUpdate.changes !== 1 || executionUpdate.changes !== 1 || taskUpdate.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Attention subject changed during projection');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'UserAttentionRequested',1,'Attention',?3,0,?4,?5,?6,?7)
      `).run(input.attentionEventId, subject.projectId, input.attentionId, input.executionId,
        input.providerEventId, input.observedAt, JSON.stringify({ attentionId: input.attentionId,
          sessionId: input.sessionId, kind: input.kind, responseType: input.responseType,
          providerRequestId: input.providerRequestId }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?6,?7,?8)
      `).run(input.executionEventId, subject.projectId, input.executionId,
        subject.executionVersion + 1, input.executionId, input.attentionEventId, input.observedAt,
        JSON.stringify({ executionId: input.executionId, from: 'RUNNING',
          to: 'WAITING_FOR_USER', reason: 'agent requested attention' }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
      `).run(input.taskEventId, subject.projectId, subject.taskId, subject.taskVersion + 1,
        input.executionId, input.executionEventId, input.observedAt,
        JSON.stringify({ taskId: subject.taskId, from: 'RUNNING',
          to: 'WAITING_FOR_USER', reason: 'agent requested attention' }));
      return { duplicate: false as const, eventId: input.providerEventId, cursor: input.cursor,
        sessionState: 'WAITING_FOR_USER' as const, executionState: 'WAITING_FOR_USER' as const,
        attentionId: input.attentionId };
    })();
  }

  listAttentionRequests(projectId: string): readonly AttentionSummary[] {
    const trusted = this.sqlite.query<{ id: string }, [string]>(`
      SELECT project.id FROM projects project JOIN project_trusts trust
        ON trust.project_id=project.id AND trust.status='ACTIVE' WHERE project.id=?1
    `).get(projectId);
    if (trusted === null) throw new StorageError('NOT_FOUND', 'Trusted project was not found');
    return this.sqlite.query<{
      id: string; project_id: string; task_id: string; execution_id: string; session_id: string;
      provider_request_id: string; kind: AttentionSummary['kind']; response_type: AttentionSummary['responseType'];
      prompt_json: string; status: AttentionSummary['status']; created_at: number;
    }, [string]>(`
      SELECT attention.id,task.project_id,task.id AS task_id,execution.id AS execution_id,
        session.id AS session_id,attention.provider_request_id,attention.kind,attention.response_type,
        attention.prompt_json,attention.status,attention.created_at
      FROM attention_requests attention JOIN agent_sessions session ON session.id=attention.session_id
      JOIN executions execution ON execution.id=session.execution_id
      JOIN tasks task ON task.id=execution.task_id
      WHERE task.project_id=?1 ORDER BY attention.created_at,attention.id
    `).all(projectId).map((row) => ({
      id: row.id, projectId: row.project_id, taskId: row.task_id, executionId: row.execution_id,
      sessionId: row.session_id, providerRequestId: row.provider_request_id, kind: row.kind,
      responseType: row.response_type, prompt: JSON.parse(row.prompt_json) as unknown,
      status: row.status, createdAt: row.created_at,
    }));
  }

  planAttentionAnswer(input: {
    readonly projectId: string;
    readonly attentionId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly intentId: string;
    readonly answerId: string;
    readonly operationId: string;
    readonly answer: StoredAgentAnswer;
    readonly intentEventId: string;
    readonly recordedEventId: string;
    readonly actor: string;
    readonly recordedAt: number;
  }): AgentAnswerPlan {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.recordedAt,
      apply: (database) => {
        const subject = database.query<{
          response_type: 'CONFIRM' | 'VALUE'; attention_status: string; session_state: string;
          execution_state: string; task_state: string;
        }, [string, string]>(`
          SELECT attention.response_type,attention.status AS attention_status,
            session.state AS session_state,execution.state AS execution_state,task.state AS task_state
          FROM attention_requests attention JOIN agent_sessions session ON session.id=attention.session_id
          JOIN executions execution ON execution.id=session.execution_id
          JOIN tasks task ON task.id=execution.task_id JOIN project_trusts trust
            ON trust.project_id=task.project_id AND trust.status='ACTIVE'
          WHERE task.project_id=?1 AND attention.id=?2
        `).get(input.projectId, input.attentionId);
        if (subject === null) throw new StorageError('NOT_FOUND', 'Open Attention request was not found');
        if (subject.attention_status !== 'OPEN' || subject.session_state !== 'WAITING_FOR_USER'
          || subject.execution_state !== 'WAITING_FOR_USER' || subject.task_state !== 'WAITING_FOR_USER') {
          throw new StorageError('INVALID_STATE', 'Attention request is not open on a waiting Agent');
        }
        const compatible = input.answer.type === 'CANCEL'
          || input.answer.type === subject.response_type;
        if (!compatible) {
          throw new StorageError('INVALID_STATE',
            `${input.answer.type} answer does not match ${subject.response_type} Attention`);
        }
        const answerJson = JSON.stringify(input.answer);
        database.query(`
          INSERT INTO intents(id,project_id,idempotency_key,raw_text,kind,status,actor,created_at)
          VALUES (?1,?2,?3,?4,'ANSWER_AGENT','APPLIED',?5,?6)
        `).run(input.intentId, input.projectId, input.commandId, answerJson, input.actor, input.recordedAt);
        database.query('INSERT INTO intent_attention_targets(intent_id,attention_id) VALUES (?1,?2)')
          .run(input.intentId, input.attentionId);
        database.query(`
          INSERT INTO attention_answers(id,request_id,command_id,actor,answer_json,created_at)
          VALUES (?1,?2,?3,?4,?5,?6)
        `).run(input.answerId, input.attentionId, input.commandId, input.actor, answerJson, input.recordedAt);
        database.query("UPDATE attention_requests SET status='ANSWER_RECORDED' WHERE id=?1 AND status='OPEN'")
          .run(input.attentionId);
        database.query(`
          INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,
            request_json,created_at,updated_at)
          VALUES (?1,?2,'ANSWER_AGENT',?3,?4,'PLANNED',?5,?6,?6)
        `).run(input.operationId, input.projectId, input.attentionId, input.commandId,
          JSON.stringify({ payloadHash: input.payloadHash, attentionId: input.attentionId,
            answerId: input.answerId }), input.recordedAt);
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'IntentRecorded',1,'Intent',?3,0,?4,?4,?5,?6)
        `).run(input.intentEventId, input.projectId, input.intentId, input.commandId, input.recordedAt,
          JSON.stringify({ intentId: input.intentId, kind: 'ANSWER_AGENT' }));
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'UserAnswerRecorded',1,'Attention',?3,1,?4,?5,?6,?7)
        `).run(input.recordedEventId, input.projectId, input.attentionId, input.commandId,
          input.intentEventId, input.recordedAt,
          JSON.stringify({ attentionId: input.attentionId, answerId: input.answerId }));
        const plan = this.agentAnswerRow(input.operationId);
        if (plan === null) throw new Error('Agent answer plan was not persisted');
        return plan;
      },
    });
  }

  getAgentAnswerPlan(operationId: string): AgentAnswerPlan {
    const plan = this.agentAnswerRow(operationId);
    if (plan === null) throw new StorageError('NOT_FOUND', 'Agent answer Operation was not found');
    return plan;
  }

  listIncompleteAgentAnswers(): readonly AgentAnswerPlan[] {
    return this.sqlite.query<{ id: string }, []>(`
      SELECT id FROM operations WHERE kind='ANSWER_AGENT'
        AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED') ORDER BY created_at,id
    `).all().map((row) => this.getAgentAnswerPlan(row.id));
  }

  startAgentAnswerOperation(operationId: string, startedAt: number): AgentAnswerPlan {
    const result = this.sqlite.query(`
      UPDATE operations SET state='IN_PROGRESS',result_json=NULL,updated_at=?1
      WHERE id=?2 AND kind='ANSWER_AGENT' AND state='PLANNED'
    `).run(startedAt, operationId);
    if (result.changes !== 1) throw new StorageError('INVALID_STATE', 'Agent answer Operation was not PLANNED');
    return this.getAgentAnswerPlan(operationId);
  }

  retryAgentAnswerAfterProvenFailure(input: {
    readonly operationId: string;
    readonly error: Readonly<{ code: string; message: string }>;
    readonly failedAt: number;
  }): void {
    const result = this.sqlite.query(`
      UPDATE operations SET state='PLANNED',result_json=?1,updated_at=?2
      WHERE id=?3 AND kind='ANSWER_AGENT' AND state='IN_PROGRESS'
    `).run(JSON.stringify({ error: input.error, deliveryMayHaveOccurred: false }),
      input.failedAt, input.operationId);
    if (result.changes !== 1) throw new StorageError('INVALID_STATE', 'Failed Agent answer was not IN_PROGRESS');
  }

  completeAgentAnswer(input: {
    readonly operationId: string;
    readonly deliveredEventId: string;
    readonly sessionEventId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly deliveredAt: number;
  }): AgentAnswerPlan {
    return this.sqlite.transaction(() => {
      const plan = this.getAgentAnswerPlan(input.operationId);
      if (plan.operationState !== 'IN_PROGRESS' || plan.status !== 'ANSWER_RECORDED') {
        throw new StorageError('INVALID_STATE', 'Delivered Agent answer did not match its plan');
      }
      this.sqlite.query("UPDATE attention_requests SET status='DELIVERED' WHERE id=?1 AND status='ANSWER_RECORDED'")
        .run(plan.id);
      this.sqlite.query(`
        UPDATE operations SET state='SUCCEEDED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state='IN_PROGRESS'
      `).run(JSON.stringify({ attentionId: plan.id, answerId: plan.answerId,
        providerRequestId: plan.providerRequestId }), input.deliveredAt, input.operationId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'UserAnswerDelivered',1,'Attention',?3,2,?4,?4,?5,?6)
      `).run(input.deliveredEventId, plan.projectId, plan.id, input.operationId, input.deliveredAt,
        JSON.stringify({ attentionId: plan.id, answerId: plan.answerId }));
      const blockers = this.sqlite.query<{ count: number }, [string]>(`
        SELECT count(*) AS count FROM attention_requests
        WHERE session_id=?1 AND status IN ('OPEN','ANSWER_RECORDED')
      `).get(plan.sessionId)?.count ?? 0;
      if (blockers === 0) {
        const session = this.sqlite.query<{ version: number }, [string]>(
          "SELECT version FROM agent_sessions WHERE id=?1 AND state='WAITING_FOR_USER'",
        ).get(plan.sessionId);
        const execution = this.sqlite.query<{ version: number }, [string]>(
          "SELECT version FROM executions WHERE id=?1 AND state='WAITING_FOR_USER'",
        ).get(plan.executionId);
        const task = this.sqlite.query<{ version: number }, [string]>(
          "SELECT version FROM tasks WHERE id=?1 AND state='WAITING_FOR_USER'",
        ).get(plan.taskId);
        if (session === null || execution === null || task === null) {
          throw new StorageError('INVALID_STATE', 'Waiting Agent aggregates did not match delivered answer');
        }
        this.sqlite.query("UPDATE agent_sessions SET state='ACTIVE',version=version+1,last_observed_at=?1 WHERE id=?2")
          .run(input.deliveredAt, plan.sessionId);
        this.sqlite.query("UPDATE executions SET state='RUNNING',version=version+1 WHERE id=?1")
          .run(plan.executionId);
        this.sqlite.query("UPDATE tasks SET state='RUNNING',version=version+1,updated_at=?1 WHERE id=?2")
          .run(input.deliveredAt, plan.taskId);
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'AgentSessionStateChanged',1,'AgentSession',?3,?4,?5,?6,?7,?8)
        `).run(input.sessionEventId, plan.projectId, plan.sessionId, session.version + 1,
          input.operationId, input.deliveredEventId, input.deliveredAt,
          JSON.stringify({ sessionId: plan.sessionId, from: 'WAITING_FOR_USER', to: 'ACTIVE' }));
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?6,?7,?8)
        `).run(input.executionEventId, plan.projectId, plan.executionId, execution.version + 1,
          input.operationId, input.sessionEventId, input.deliveredAt,
          JSON.stringify({ executionId: plan.executionId, from: 'WAITING_FOR_USER', to: 'RUNNING',
            reason: 'all Attention answers delivered' }));
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
        `).run(input.taskEventId, plan.projectId, plan.taskId, task.version + 1,
          input.operationId, input.executionEventId, input.deliveredAt,
          JSON.stringify({ taskId: plan.taskId, from: 'WAITING_FOR_USER', to: 'RUNNING',
            reason: 'all Attention answers delivered' }));
      }
      return this.getAgentAnswerPlan(input.operationId);
    })();
  }

  markAgentAnswerUncertain(input: {
    readonly operationId: string;
    readonly recoveryEventId: string;
    readonly taskEventId: string;
    readonly error: Readonly<{ code: string; message: string }>;
    readonly failedAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const plan = this.getAgentAnswerPlan(input.operationId);
      if (plan.operationState !== 'IN_PROGRESS') {
        throw new StorageError('INVALID_STATE', 'Uncertain Agent answer was not IN_PROGRESS');
      }
      this.sqlite.query("UPDATE operations SET state='RECONCILE_REQUIRED',result_json=?1,updated_at=?2 WHERE id=?3")
        .run(JSON.stringify({ error: input.error, deliveryMayHaveOccurred: true }),
          input.failedAt, input.operationId);
      this.sqlite.query("UPDATE agent_sessions SET state='RECOVERY_REQUIRED',version=version+1,last_observed_at=?1 WHERE id=?2")
        .run(input.failedAt, plan.sessionId);
      this.sqlite.query("UPDATE executions SET state='RECOVERY_REQUIRED',version=version+1 WHERE id=?1")
        .run(plan.executionId);
      this.sqlite.query("UPDATE workspaces SET state='RECOVERY_REQUIRED' WHERE id=(SELECT workspace_id FROM executions WHERE id=?1)")
        .run(plan.executionId);
      const taskVersion = this.sqlite.query<{ version: number }, [string]>(
        "SELECT version FROM tasks WHERE id=?1 AND state='WAITING_FOR_USER'",
      ).get(plan.taskId)?.version;
      if (taskVersion === undefined) {
        throw new StorageError('INVALID_STATE', 'Uncertain Agent answer Task was not waiting');
      }
      this.sqlite.query("UPDATE tasks SET state='RECOVERY_REQUIRED',version=version+1,updated_at=?1 WHERE id=?2")
        .run(input.failedAt, plan.taskId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'RecoveryRequired',1,'Attention',?3,2,?4,?4,?5,?6)
      `).run(input.recoveryEventId, plan.projectId, plan.id, input.operationId, input.failedAt,
        JSON.stringify({ resourceType: 'AgentAnswer', resourceId: plan.answerId,
          reason: input.error.code }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
      `).run(input.taskEventId, plan.projectId, plan.taskId, taskVersion + 1,
        input.operationId, input.recoveryEventId, input.failedAt,
        JSON.stringify({ taskId: plan.taskId, from: 'WAITING_FOR_USER',
          to: 'RECOVERY_REQUIRED', reason: 'Agent answer delivery uncertain' }));
    })();
  }

  private agentAnswerRow(operationId: string): AgentAnswerPlan | null {
    const row = this.sqlite.query<{
      operation_id: string; operation_state: AgentAnswerPlan['operationState']; project_id: string;
      attention_id: string; provider_request_id: string; kind: AgentAnswerPlan['kind'];
      response_type: AgentAnswerPlan['responseType']; prompt_json: string; attention_status: AgentAnswerPlan['status'];
      attention_created_at: number; answer_id: string; answer_json: string; session_id: string;
      execution_id: string; task_id: string; adapter_id: string; provider_session_id: string | null;
    }, [string]>(`
      SELECT operation.id AS operation_id,operation.state AS operation_state,operation.project_id,
        attention.id AS attention_id,attention.provider_request_id,attention.kind,attention.response_type,
        attention.prompt_json,attention.status AS attention_status,attention.created_at AS attention_created_at,
        answer.id AS answer_id,answer.answer_json,session.id AS session_id,execution.id AS execution_id,
        task.id AS task_id,execution.adapter_id,session.provider_session_id
      FROM operations operation JOIN attention_requests attention ON attention.id=operation.aggregate_id
      JOIN attention_answers answer ON answer.request_id=attention.id
      JOIN agent_sessions session ON session.id=attention.session_id
      JOIN executions execution ON execution.id=session.execution_id JOIN tasks task ON task.id=execution.task_id
      WHERE operation.id=?1 AND operation.kind='ANSWER_AGENT'
    `).get(operationId);
    if (row === null) return null;
    if (row.provider_session_id === null) {
      throw new StorageError('INVALID_STATE', 'Answer target Session has no provider identity');
    }
    return {
      operationId: row.operation_id, operationState: row.operation_state,
      id: row.attention_id, projectId: row.project_id, taskId: row.task_id,
      executionId: row.execution_id, sessionId: row.session_id,
      providerRequestId: row.provider_request_id, kind: row.kind, responseType: row.response_type,
      prompt: JSON.parse(row.prompt_json) as unknown, status: row.attention_status,
      createdAt: row.attention_created_at, answerId: row.answer_id,
      answer: JSON.parse(row.answer_json) as StoredAgentAnswer,
      adapterId: row.adapter_id, providerSessionId: row.provider_session_id,
    };
  }

  recordAgentCompleted(input: {
    readonly sessionId: string;
    readonly executionId: string;
    readonly providerEventId: string;
    readonly cursor: string;
    readonly outcome: 'SUCCESS' | 'FAILURE';
    readonly evidence: Readonly<{ ref: string; toolsQuiescent: true; ownedWritersStopped: true }>;
    readonly sessionEventId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly observedAt: number;
  }): AdapterEventResult {
    return this.sqlite.transaction(() => {
      const payloadJson = JSON.stringify({ outcome: input.outcome, evidence: input.evidence });
      const duplicate = this.adapterEventDuplicate(input.sessionId, input.providerEventId,
        input.cursor, 'completed', payloadJson);
      if (duplicate) return this.adapterEventResult(input.sessionId, input.providerEventId);
      const subject = this.observableAgentSessionRow(input.sessionId);
      if (subject === null || subject.executionId !== input.executionId) {
        throw new StorageError('NOT_FOUND', 'Adapter completion Session identity did not match');
      }
      if (subject.sessionState !== 'ACTIVE' || subject.executionState !== 'RUNNING') {
        throw new StorageError('INVALID_STATE',
          `Completion requires ACTIVE/RUNNING, got ${subject.sessionState}/${subject.executionState}`);
      }
      this.insertAdapterEvent(input.sessionId, input.providerEventId, input.cursor,
        'completed', payloadJson, input.observedAt);
      const sessionUpdate = this.sqlite.query(`
        UPDATE agent_sessions SET state='EXITED',version=version+1,observation_cursor=?1,
          last_observed_at=?2,exit_json=?3 WHERE id=?4 AND state='ACTIVE'
      `).run(input.cursor, input.observedAt, payloadJson, input.sessionId);
      if (sessionUpdate.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Agent Session changed during completion projection');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'AgentSessionCompleted',1,'AgentSession',?3,?4,?5,?6,?7,?8)
      `).run(input.sessionEventId, subject.projectId, input.sessionId, subject.sessionVersion + 1,
        input.executionId, input.providerEventId, input.observedAt,
        JSON.stringify({ executionId: input.executionId, sessionId: input.sessionId,
          outcome: input.outcome, evidenceRef: input.evidence.ref }));
      if (input.outcome === 'FAILURE') {
        const executionUpdate = this.sqlite.query(`
          UPDATE executions SET state='FAILED',resource_held=0,version=version+1,
            ended_at=?1,error_json=?2 WHERE id=?3 AND state='RUNNING'
        `).run(input.observedAt, JSON.stringify({ code: 'AGENT_REPORTED_FAILURE' }), input.executionId);
        const workspaceUpdate = this.sqlite.query(
          "UPDATE workspaces SET state='RETAINED' WHERE id=?1 AND state='IN_USE'",
        ).run(subject.workspaceId);
        const taskUpdate = this.sqlite.query(`
          UPDATE tasks SET state='FAILED',version=version+1,updated_at=?1
          WHERE id=?2 AND state='RUNNING'
        `).run(input.observedAt, subject.taskId);
        if (executionUpdate.changes !== 1 || workspaceUpdate.changes !== 1 || taskUpdate.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Failure subject changed during projection');
        }
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ExecutionFailed',1,'Execution',?3,?4,?5,?6,?7,?8)
        `).run(input.executionEventId, subject.projectId, input.executionId,
          subject.executionVersion + 1, input.executionId, input.sessionEventId, input.observedAt,
          JSON.stringify({ executionId: input.executionId, reason: 'AGENT_REPORTED_FAILURE',
            stopEvidenceRef: input.evidence.ref }));
        this.sqlite.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
        `).run(input.taskEventId, subject.projectId, subject.taskId, subject.taskVersion + 1,
          input.executionId, input.executionEventId, input.observedAt,
          JSON.stringify({ taskId: subject.taskId, from: 'RUNNING', to: 'FAILED',
            reason: 'agent reported failure' }));
      }
      return { duplicate: false as const, eventId: input.providerEventId, cursor: input.cursor,
        sessionState: 'EXITED' as const,
        executionState: input.outcome === 'FAILURE' ? 'FAILED' as const : 'RUNNING' as const };
    })();
  }

  /** A lost provider transport keeps Execution/workspace ownership: quiescence was never proven. */
  recordAgentDisconnected(input: {
    readonly sessionId: string;
    readonly executionId: string;
    readonly providerEventId: string;
    readonly cursor: string;
    readonly reason: string;
    readonly sessionEventId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly observedAt: number;
  }): AdapterEventResult {
    return this.sqlite.transaction(() => {
      const payloadJson = JSON.stringify({ reason: input.reason });
      const duplicate = this.adapterEventDuplicate(input.sessionId, input.providerEventId,
        input.cursor, 'disconnected', payloadJson);
      if (duplicate) return this.adapterEventResult(input.sessionId, input.providerEventId);
      const subject = this.observableAgentSessionRow(input.sessionId);
      if (subject === null || subject.executionId !== input.executionId) {
        throw new StorageError('NOT_FOUND', 'Adapter disconnect Session identity did not match');
      }
      if (!['ACTIVE', 'WAITING_FOR_USER'].includes(subject.sessionState)
        || !['RUNNING', 'WAITING_FOR_USER'].includes(subject.executionState)) {
        throw new StorageError('INVALID_STATE',
          `Disconnect requires an active Session, got ${subject.sessionState}/${subject.executionState}`);
      }
      this.insertAdapterEvent(input.sessionId, input.providerEventId, input.cursor,
        'disconnected', payloadJson, input.observedAt);
      this.sqlite.query(`
        UPDATE agent_sessions SET state='DISCONNECTED',version=version+1,observation_cursor=?1,
          last_observed_at=?2,exit_json=?3 WHERE id=?4 AND state IN ('ACTIVE','WAITING_FOR_USER')
      `).run(input.cursor, input.observedAt, payloadJson, input.sessionId);
      const executionUpdate = this.sqlite.query(`
        UPDATE executions SET state='RECOVERY_REQUIRED',version=version+1 WHERE id=?1
          AND state IN ('RUNNING','WAITING_FOR_USER')
      `).run(input.executionId);
      const workspaceUpdate = this.sqlite.query(`
        UPDATE workspaces SET state='RECOVERY_REQUIRED' WHERE id=?1 AND state='IN_USE'
      `).run(subject.workspaceId);
      const taskUpdate = this.sqlite.query(`
        UPDATE tasks SET state='RECOVERY_REQUIRED',version=version+1,updated_at=?1
        WHERE id=?2 AND state IN ('RUNNING','WAITING_FOR_USER')
      `).run(input.observedAt, subject.taskId);
      if (executionUpdate.changes !== 1 || workspaceUpdate.changes !== 1 || taskUpdate.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Disconnect subject changed during projection');
      }
      const sessionFrom = subject.sessionState;
      const executionFrom = subject.executionState;
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'AgentSessionStateChanged',1,'AgentSession',?3,?4,?5,?5,?6,?7)
      `).run(input.sessionEventId, subject.projectId, input.sessionId, subject.sessionVersion + 1,
        input.providerEventId, input.observedAt, JSON.stringify({ sessionId: input.sessionId,
          from: sessionFrom, to: 'DISCONNECTED', reason: input.reason }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?6,?7,?8)
      `).run(input.executionEventId, subject.projectId, input.executionId,
        subject.executionVersion + 1, input.providerEventId, input.sessionEventId, input.observedAt,
        JSON.stringify({ executionId: input.executionId, from: executionFrom,
          to: 'RECOVERY_REQUIRED', reason: 'agent transport lost' }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
      `).run(input.taskEventId, subject.projectId, subject.taskId, subject.taskVersion + 1,
        input.providerEventId, input.executionEventId, input.observedAt,
        JSON.stringify({ taskId: subject.taskId, from: 'RUNNING',
          to: 'RECOVERY_REQUIRED', reason: 'agent transport lost' }));
      return { duplicate: false as const, eventId: input.providerEventId, cursor: input.cursor,
        sessionState: 'DISCONNECTED' as const, executionState: 'RECOVERY_REQUIRED' as const };
    })();
  }

  /**
   * Projects a disconnect the Runtime caused itself, for example by releasing its own provider
   * process during shutdown. It is not a provider event, so no Adapter event or cursor is written,
   * and it never claims the Execution succeeded.
   */
  recordRuntimeDisconnect(input: {
    readonly sessionId: string;
    readonly reason: string;
    readonly sessionEventId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly recoveryEventId: string;
    readonly recoveredAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const subject = this.observableAgentSessionRow(input.sessionId);
      if (subject === null) throw new StorageError('NOT_FOUND', 'Runtime disconnect Session was not found');
      if (!['ACTIVE', 'WAITING_FOR_USER'].includes(subject.sessionState)
        || !['RUNNING', 'WAITING_FOR_USER'].includes(subject.executionState)) {
        throw new StorageError('INVALID_STATE',
          `Runtime disconnect requires an active Session, got ${subject.sessionState}/${subject.executionState}`);
      }
      const sessionUpdate = this.sqlite.query(`
        UPDATE agent_sessions SET state='DISCONNECTED',version=version+1,last_observed_at=?1,exit_json=?2
        WHERE id=?3 AND state IN ('ACTIVE','WAITING_FOR_USER')
      `).run(input.recoveredAt, JSON.stringify({ reason: input.reason }), input.sessionId);
      const executionUpdate = this.sqlite.query(`
        UPDATE executions SET state='RECOVERY_REQUIRED',version=version+1
        WHERE id=?1 AND state IN ('RUNNING','WAITING_FOR_USER')
      `).run(subject.executionId);
      const workspaceUpdate = this.sqlite.query(
        "UPDATE workspaces SET state='RECOVERY_REQUIRED' WHERE id=?1 AND state='IN_USE'",
      ).run(subject.workspaceId);
      const taskUpdate = this.sqlite.query(`
        UPDATE tasks SET state='RECOVERY_REQUIRED',version=version+1,updated_at=?1
        WHERE id=?2 AND state IN ('RUNNING','WAITING_FOR_USER')
      `).run(input.recoveredAt, subject.taskId);
      if (sessionUpdate.changes !== 1 || executionUpdate.changes !== 1
        || workspaceUpdate.changes !== 1 || taskUpdate.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Runtime disconnect subject changed during projection');
      }
      // Session, Execution, and Task states move together in this FSM, so the Execution
      // state is the honest `from` value for the Task transition as well.
      const taskFrom = subject.executionState === 'WAITING_FOR_USER' ? 'WAITING_FOR_USER' : 'RUNNING';
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'RecoveryRequired',1,'AgentSession',?3,?4,?5,?5,?6,?7)
      `).run(input.recoveryEventId, subject.projectId, input.sessionId, subject.sessionVersion + 1,
        input.sessionId, input.recoveredAt, JSON.stringify({ resourceType: 'AgentSession',
          resourceId: input.sessionId, reason: input.reason }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'AgentSessionStateChanged',1,'AgentSession',?3,?4,?5,?6,?7,?8)
      `).run(input.sessionEventId, subject.projectId, input.sessionId, subject.sessionVersion + 1,
        input.recoveryEventId, input.recoveryEventId, input.recoveredAt,
        JSON.stringify({ sessionId: input.sessionId, from: subject.sessionState,
          to: 'DISCONNECTED', reason: input.reason }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?6,?7,?8)
      `).run(input.executionEventId, subject.projectId, subject.executionId,
        subject.executionVersion + 1, input.recoveryEventId, input.sessionEventId, input.recoveredAt,
        JSON.stringify({ executionId: subject.executionId, from: subject.executionState,
          to: 'RECOVERY_REQUIRED', reason: input.reason }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
      `).run(input.taskEventId, subject.projectId, subject.taskId, subject.taskVersion + 1,
        input.recoveryEventId, input.executionEventId, input.recoveredAt,
        JSON.stringify({ taskId: subject.taskId, from: taskFrom,
          to: 'RECOVERY_REQUIRED', reason: input.reason }));
    })();
  }

  /**
   * Records one-shot authorization to create a result commit for a quiescent Execution.
   * Any previous ACTIVE authorization for the same Execution is invalidated, because a new
   * preparation always describes a fresh HEAD/ChangeSet snapshot.
   */
  prepareResultCommitAuthorization(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly executionId: string;
    readonly authorizationId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly expectedHead: string;
    readonly changeFingerprint: string;
    readonly policyVersion: number;
    readonly eventId: string;
    readonly invalidatedEventId: string;
    readonly actor: string;
    readonly createdAt: number;
  }): ResultCommitAuthorization {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.createdAt,
      apply: (database) => {
        const subject = this.resultCommitSubject(input.projectId, input.taskId, input.executionId);
        if (subject.currentRevisionId !== subject.appliedRevisionId) {
          throw new StorageError('INVALID_STATE',
            'Task revision changed after the Execution started; a result commit needs a new Execution');
        }
        if (!subject.quiescent) {
          throw new StorageError('INVALID_STATE',
            'Agent tools and owned writers are not proven stopped; result commit is not allowed yet');
        }
        const previous = database.query<{ id: string }, [string]>(`
          SELECT id FROM result_commit_authorizations
          WHERE execution_id=?1 AND status='ACTIVE'
        `).get(input.executionId);
        if (previous !== null) {
          database.query(`
            UPDATE result_commit_authorizations SET status='INVALIDATED',invalidated_at=?1
            WHERE id=?2 AND status='ACTIVE'
          `).run(input.createdAt, previous.id);
          database.query(`
            INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
              aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
            VALUES (?1,?2,'ResultCommitAuthorizationInvalidated',1,'Execution',?3,0,?4,?4,?5,?6)
          `).run(input.invalidatedEventId, input.projectId, input.executionId, input.authorizationId,
            input.createdAt, JSON.stringify({ authorizationId: previous.id,
              executionId: input.executionId, reason: 'superseded by a new preparation' }));
        }
        database.query(`
          INSERT INTO result_commit_authorizations(id,task_id,execution_id,revision_id,workspace_id,
            expected_head,change_fingerprint,actor,status,created_at)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'ACTIVE',?9)
        `).run(input.authorizationId, input.taskId, input.executionId, subject.appliedRevisionId,
          subject.workspaceId, input.expectedHead, input.changeFingerprint, input.actor, input.createdAt);
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ResultCommitAuthorized',1,'Execution',?3,0,?4,?4,?5,?6)
        `).run(input.eventId, input.projectId, input.executionId, input.commandId, input.createdAt,
          JSON.stringify({ authorizationId: input.authorizationId, executionId: input.executionId,
            revisionId: subject.appliedRevisionId, workspaceId: subject.workspaceId,
            expectedHead: input.expectedHead, changeFingerprint: input.changeFingerprint,
            policyVersion: input.policyVersion }));
        const authorization = this.resultCommitAuthorizationRow(input.authorizationId);
        if (authorization === null) throw new Error('Result commit authorization was not persisted');
        return authorization;
      },
    });
  }

  getResultCommitAuthorization(authorizationId: string): ResultCommitAuthorization {
    const authorization = this.resultCommitAuthorizationRow(authorizationId);
    if (authorization === null) throw new StorageError('NOT_FOUND', 'Result commit authorization was not found');
    return authorization;
  }

  invalidateResultCommitAuthorization(input: {
    readonly authorizationId: string;
    readonly reason: string;
    readonly eventId: string;
    readonly invalidatedAt: number;
  }): void {
    this.sqlite.transaction(() => {
      const row = this.sqlite.query<{ project_id: string; execution_id: string }, [string]>(`
        SELECT task.project_id,authorization.execution_id FROM result_commit_authorizations authorization
        JOIN tasks task ON task.id=authorization.task_id WHERE authorization.id=?1
      `).get(input.authorizationId);
      if (row === null) throw new StorageError('NOT_FOUND', 'Result commit authorization was not found');
      const updated = this.sqlite.query(`
        UPDATE result_commit_authorizations SET status='INVALIDATED',invalidated_at=?1
        WHERE id=?2 AND status='ACTIVE'
      `).run(input.invalidatedAt, input.authorizationId);
      if (updated.changes !== 1) {
        throw new StorageError('INVALID_STATE', 'Result commit authorization was not ACTIVE');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ResultCommitAuthorizationInvalidated',1,'Execution',?3,0,?4,?4,?5,?6)
      `).run(input.eventId, row.project_id, row.execution_id, input.authorizationId, input.invalidatedAt,
        JSON.stringify({ authorizationId: input.authorizationId, executionId: row.execution_id,
          reason: input.reason }));
    })();
  }

  /**
   * Persists the capture Operation before the Runtime runs `git add`/`git commit`. The
   * Operation is never replayed: a replay returns a finished Operation, and an interrupted
   * one is reported for reconciliation instead of running the commit side effect twice.
   */
  startResultCommitCapture(input: {
    readonly operationId: string;
    readonly commandId: string;
    readonly authorizationId: string;
    readonly expectedHead: string;
    readonly changeFingerprint: string;
    readonly startedAt: number;
  }): ResultCommitCapturePlan {
    return this.sqlite.transaction(() => {
      const authorization = this.resultCommitAuthorizationRow(input.authorizationId);
      if (authorization === null) {
        throw new StorageError('NOT_FOUND', 'Result commit authorization was not found');
      }
      const existing = this.sqlite.query<{ id: string }, [string, string]>(`
        SELECT id FROM operations WHERE project_id=?1 AND kind='CAPTURE_RESULT' AND idempotency_key=?2
      `).get(authorization.projectId, input.commandId);
      if (existing !== null) {
        const plan = this.resultCommitCapturePlan(existing.id);
        if (plan.operationState === 'SUCCEEDED' || plan.operationState === 'FAILED') return plan;
        throw new StorageError('INVALID_STATE',
          `Result commit capture is ${plan.operationState}; reconcile it instead of replaying the commit`);
      }
      if (authorization.status !== 'ACTIVE') {
        throw new StorageError('INVALID_STATE',
          `Result commit authorization is ${authorization.status}; prepare a new one`);
      }
      if (authorization.expectedHead !== input.expectedHead
        || authorization.changeFingerprint !== input.changeFingerprint) {
        throw new StorageError('INVALID_STATE', 'Capture does not match its authorization snapshot');
      }
      const subject = this.resultCommitSubject(authorization.projectId, authorization.taskId,
        authorization.executionId);
      if (!subject.quiescent) {
        throw new StorageError('INVALID_STATE', 'Agent is no longer proven quiescent');
      }
      if (subject.currentRevisionId !== subject.appliedRevisionId) {
        throw new StorageError('INVALID_STATE', 'Task revision changed after the Execution started');
      }
      this.sqlite.query(`
        INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,
          request_json,created_at,updated_at)
        VALUES (?1,?2,'CAPTURE_RESULT',?3,?4,'IN_PROGRESS',?5,?6,?6)
      `).run(input.operationId, authorization.projectId, authorization.executionId, input.commandId,
        JSON.stringify({ authorizationId: input.authorizationId, executionId: authorization.executionId,
          taskId: authorization.taskId, expectedHead: input.expectedHead,
          changeFingerprint: input.changeFingerprint }), input.startedAt);
      return this.resultCommitCapturePlan(input.operationId);
    })();
  }

  listIncompleteResultCommitCaptures(): readonly ResultCommitCapturePlan[] {
    return this.sqlite.query<{ id: string }, []>(`
      SELECT id FROM operations WHERE kind='CAPTURE_RESULT'
        AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED') ORDER BY created_at,id
    `).all().map((row) => this.resultCommitCapturePlan(row.id));
  }

  /**
   * Consumes the authorization and fixes the created commit on the Execution. The Execution
   * becomes SUCCEEDED, the workspace is retained for verification, and the Task only reaches
   * EXECUTED: a result commit is not a verification and not an integration.
   */
  completeResultCommitCapture(input: {
    readonly operationId: string;
    readonly resultCommit: string;
    readonly resultTree: string;
    readonly identityName: string;
    readonly identityEmail: string;
    readonly hookOutcome: 'PASSED' | 'REPORTED_FAILURE_AFTER_COMMIT';
    /** Bounded Git diagnostics from a commit command that reported a failure after committing. */
    readonly hookDetail: string;
    readonly source: 'CONFIRMED' | 'RECONCILED';
    readonly eventId: string;
    readonly executionEventId: string;
    readonly taskEventId: string;
    readonly completedAt: number;
  }): ResultCommitCapturePlan {
    return this.sqlite.transaction(() => {
      const existing = this.resultCommitCapturePlan(input.operationId);
      if (existing.operationState === 'SUCCEEDED') return existing;
      if (existing.operationState !== 'IN_PROGRESS') {
        throw new StorageError('INVALID_STATE',
          `Result commit capture cannot complete from ${existing.operationState}`);
      }
      const authorization = this.resultCommitAuthorizationRow(existing.authorizationId);
      if (authorization === null) {
        throw new StorageError('NOT_FOUND', 'Result commit authorization was not found');
      }
      if (authorization.status !== 'ACTIVE') {
        throw new StorageError('INVALID_STATE',
          `Result commit authorization is ${authorization.status}`);
      }
      if (authorization.expectedHead !== existing.expectedHead
        || authorization.changeFingerprint !== existing.changeFingerprint) {
        throw new StorageError('INVALID_STATE', 'Capture snapshot no longer matches its authorization');
      }
      const subject = this.resultCommitSubject(authorization.projectId,
        authorization.taskId, authorization.executionId);
      if (subject.currentRevisionId !== subject.appliedRevisionId) {
        throw new StorageError('INVALID_STATE', 'Task revision changed before the result commit was recorded');
      }
      if (subject.executionState !== 'RUNNING' || !subject.resourceHeld
        || subject.workspaceState !== 'IN_USE' || subject.taskState !== 'RUNNING') {
        throw new StorageError('INVALID_STATE',
          `Execution is ${subject.executionState}/${subject.workspaceState}/${subject.taskState}; cannot record a result commit`);
      }
      this.sqlite.query(`
        UPDATE result_commit_authorizations SET status='CONSUMED',consumed_at=?1
        WHERE id=?2 AND status='ACTIVE'
      `).run(input.completedAt, authorization.id);
      const executionUpdate = this.sqlite.query(`
        UPDATE executions SET state='SUCCEEDED',resource_held=0,result_commit=?1,version=version+1,
          ended_at=?2 WHERE id=?3 AND state='RUNNING' AND resource_held=1
      `).run(input.resultCommit, input.completedAt, authorization.executionId);
      const workspaceUpdate = this.sqlite.query(
        "UPDATE workspaces SET state='RETAINED' WHERE id=?1 AND state='IN_USE'",
      ).run(authorization.workspaceId);
      const taskUpdate = this.sqlite.query(`
        UPDATE tasks SET state='EXECUTED',version=version+1,updated_at=?1
        WHERE id=?2 AND state='RUNNING'
      `).run(input.completedAt, authorization.taskId);
      if (executionUpdate.changes !== 1 || workspaceUpdate.changes !== 1 || taskUpdate.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Result commit subject changed during capture');
      }
      this.sqlite.query(`
        UPDATE operations SET state='SUCCEEDED',result_json=?1,updated_at=?2
        WHERE id=?3 AND state='IN_PROGRESS'
      `).run(JSON.stringify({ resultCommit: input.resultCommit, resultTree: input.resultTree,
        authorizationId: authorization.id }), input.completedAt, input.operationId);
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ResultCommitCreated',1,'Execution',?3,?4,?5,?6,?7,?8)
      `).run(input.eventId, authorization.projectId, authorization.executionId,
        subject.executionVersion + 1, input.operationId, null, input.completedAt,
        JSON.stringify({ authorizationId: authorization.id, executionId: authorization.executionId,
          revisionId: authorization.appliedRevisionId, baseCommit: authorization.baseCommit,
          resultCommit: input.resultCommit, resultTree: input.resultTree,
          identity: { name: input.identityName, email: input.identityEmail },
          hookOutcome: input.hookOutcome, hookDetail: input.hookDetail, source: input.source }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'ExecutionStateChanged',1,'Execution',?3,?4,?5,?6,?7,?8)
      `).run(input.executionEventId, authorization.projectId, authorization.executionId,
        subject.executionVersion + 1, input.operationId, input.eventId, input.completedAt,
        JSON.stringify({ executionId: authorization.executionId, from: 'RUNNING',
          to: 'SUCCEEDED', reason: 'result commit captured' }));
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
      `).run(input.taskEventId, authorization.projectId, authorization.taskId,
        subject.taskVersion + 1, input.operationId, input.executionEventId, input.completedAt,
        JSON.stringify({ taskId: authorization.taskId, from: 'RUNNING', to: 'EXECUTED',
          reason: 'result commit captured' }));
      return this.resultCommitCapturePlan(input.operationId);
    })();
  }

  failResultCommitCapture(input: {
    readonly operationId: string;
    readonly error: Readonly<{ code: string; message: string }>;
    readonly reconcileRequired: boolean;
    readonly failedAt: number;
  }): void {
    const state = input.reconcileRequired ? 'RECONCILE_REQUIRED' : 'FAILED';
    const result = this.sqlite.query(`
      UPDATE operations SET state=?1,result_json=?2,updated_at=?3
      WHERE id=?4 AND state IN ('PLANNED','IN_PROGRESS','RECONCILE_REQUIRED')
    `).run(state, JSON.stringify({ error: input.error }), input.failedAt, input.operationId);
    if (result.changes !== 1) {
      throw new StorageError('INVALID_STATE', 'Result commit capture failure did not match its state');
    }
  }

  /** Public projection of one Execution's result-commit subject, including quiescence proof. */
  getResultCommitSubject(projectId: string, taskId: string, executionId: string): ResultCommitSubject {
    return this.resultCommitSubject(projectId, taskId, executionId);
  }

  private resultCommitSubject(
    projectId: string,
    taskId: string,
    executionId: string,
  ): ResultCommitSubject {
    const row = this.sqlite.query<{
      project_id: string; task_id: string; display_number: number; task_version: number;
      task_state: TaskLifecycleState; current_revision_id: string; execution_id: string;
      execution_version: number; execution_state: ExecutionLifecycleState;
      applied_revision_id: string; resource_held: number;
      workspace_id: string; workspace_path: string; workspace_branch_ref: string;
      workspace_state: WorkspaceLifecycleState; base_commit: string;
      session_state: AgentSessionLifecycleState | null; quiescent: number;
    }, [string, string, string]>(`
      SELECT task.project_id,task.id AS task_id,task.display_number,task.version AS task_version,
        task.state AS task_state,task.current_revision_id,execution.id AS execution_id,
        execution.version AS execution_version,execution.state AS execution_state,
        execution.applied_revision_id,execution.resource_held,
        workspace.id AS workspace_id,workspace.path AS workspace_path,
        workspace.branch_ref AS workspace_branch_ref,workspace.state AS workspace_state,
        workspace.base_commit,session.state AS session_state,
        CASE WHEN session.state='EXITED' AND json_extract(session.exit_json,'$.outcome')='SUCCESS'
          AND json_extract(session.exit_json,'$.evidence.toolsQuiescent')=1
          AND json_extract(session.exit_json,'$.evidence.ownedWritersStopped')=1
          THEN 1 ELSE 0 END AS quiescent
      FROM tasks task
      JOIN project_trusts trust ON trust.project_id=task.project_id AND trust.status='ACTIVE'
      JOIN executions execution ON execution.task_id=task.id AND execution.id=?3
      JOIN workspaces workspace ON workspace.id=execution.workspace_id
      LEFT JOIN agent_sessions session ON session.execution_id=execution.id
      WHERE task.project_id=?1 AND task.id=?2
    `).get(projectId, taskId, executionId);
    if (row === null) {
      throw new StorageError('NOT_FOUND', 'Trusted Task, Execution, or workspace was not found');
    }
    return {
      projectId: row.project_id,
      taskId: row.task_id,
      taskDisplayNumber: row.display_number,
      taskVersion: row.task_version,
      taskState: row.task_state,
      currentRevisionId: row.current_revision_id,
      executionId: row.execution_id,
      executionVersion: row.execution_version,
      executionState: row.execution_state,
      appliedRevisionId: row.applied_revision_id,
      resourceHeld: row.resource_held === 1,
      workspaceId: row.workspace_id,
      workspacePath: row.workspace_path,
      workspaceBranchRef: row.workspace_branch_ref,
      workspaceState: row.workspace_state,
      baseCommit: row.base_commit,
      quiescent: row.quiescent === 1,
      sessionState: row.session_state,
    };
  }

  private resultCommitAuthorizationRow(
    authorizationId: string,
    database: Database = this.sqlite,
  ): ResultCommitAuthorization | null {
    const row = database.query<{
      id: string; project_id: string; task_id: string; display_number: number; task_version: number;
      task_state: TaskLifecycleState; current_revision_id: string; execution_id: string;
      execution_state: ExecutionLifecycleState; applied_revision_id: string; resource_held: number;
      workspace_id: string; workspace_path: string; workspace_branch_ref: string;
      workspace_state: WorkspaceLifecycleState; base_commit: string;
      expected_head: string; change_fingerprint: string; status: ResultCommitAuthorization['status'];
      created_at: number; result_commit: string | null;
      session_state: AgentSessionLifecycleState | null; quiescent: number;
    }, [string]>(`
      SELECT authorization.id,task.project_id,task.id AS task_id,task.display_number,
        task.version AS task_version,task.state AS task_state,task.current_revision_id,
        authorization.execution_id,execution.state AS execution_state,execution.applied_revision_id,
        execution.resource_held,authorization.workspace_id,workspace.path AS workspace_path,
        workspace.branch_ref AS workspace_branch_ref,workspace.state AS workspace_state,
        workspace.base_commit,authorization.expected_head,authorization.change_fingerprint,
        authorization.status,authorization.created_at,execution.result_commit,
        session.state AS session_state,
        CASE WHEN session.state='EXITED' AND json_extract(session.exit_json,'$.outcome')='SUCCESS'
          AND json_extract(session.exit_json,'$.evidence.toolsQuiescent')=1
          AND json_extract(session.exit_json,'$.evidence.ownedWritersStopped')=1
          THEN 1 ELSE 0 END AS quiescent
      FROM result_commit_authorizations authorization
      JOIN tasks task ON task.id=authorization.task_id
      JOIN executions execution ON execution.id=authorization.execution_id
      JOIN workspaces workspace ON workspace.id=authorization.workspace_id
      LEFT JOIN agent_sessions session ON session.execution_id=execution.id
      WHERE authorization.id=?1
    `).get(authorizationId);
    if (row === null) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      taskDisplayNumber: row.display_number,
      taskVersion: row.task_version,
      taskState: row.task_state,
      currentRevisionId: row.current_revision_id,
      executionId: row.execution_id,
      executionState: row.execution_state,
      appliedRevisionId: row.applied_revision_id,
      resourceHeld: row.resource_held === 1,
      workspaceId: row.workspace_id,
      workspacePath: row.workspace_path,
      workspaceBranchRef: row.workspace_branch_ref,
      workspaceState: row.workspace_state,
      baseCommit: row.base_commit,
      expectedHead: row.expected_head,
      changeFingerprint: row.change_fingerprint,
      status: row.status,
      createdAt: row.created_at,
      resultCommit: row.result_commit,
      quiescent: row.quiescent === 1,
      sessionState: row.session_state,
    };
  }

  private resultCommitCapturePlan(
    operationId: string,
    database: Database = this.sqlite,
  ): ResultCommitCapturePlan {
    const row = database.query<{
      id: string; state: ResultCommitCapturePlan['operationState']; request_json: string;
      result_json: string | null;
    }, [string]>(`
      SELECT id,state,request_json,result_json FROM operations WHERE id=?1 AND kind='CAPTURE_RESULT'
    `).get(operationId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Result commit capture Operation was not found');
    const request = JSON.parse(row.request_json) as {
      authorizationId: string; executionId: string; taskId: string;
      expectedHead: string; changeFingerprint: string;
    };
    const recorded = row.result_json === null
      ? null
      : JSON.parse(row.result_json) as { resultCommit?: string; resultTree?: string };
    const authorization = this.resultCommitAuthorizationRow(request.authorizationId, database);
    if (authorization === null) {
      throw new StorageError('INVALID_STATE', 'Result commit capture lost its authorization');
    }
    return {
      operationId: row.id,
      operationState: row.state,
      authorizationId: request.authorizationId,
      executionId: request.executionId,
      taskId: request.taskId,
      expectedHead: request.expectedHead,
      changeFingerprint: request.changeFingerprint,
      authorization,
      resultCommit: recorded?.resultCommit ?? null,
      resultTree: recorded?.resultTree ?? null,
    };
  }

  enqueueEventDeliveries(consumerId: string): number {
    if (consumerId.trim().length === 0) throw new StorageError('INVALID_STATE', 'Consumer ID must not be blank');
    return this.sqlite.query(`
      INSERT OR IGNORE INTO event_deliveries(event_id,consumer_id,state,attempt_count)
      SELECT event_id,?1,'PENDING',0 FROM domain_events
    `).run(consumerId).changes;
  }

  listDueEventDeliveries(consumerId: string, now: number, limit: number): readonly PendingEventDelivery[] {
    if (!Number.isInteger(limit) || limit <= 0) throw new StorageError('INVALID_STATE', 'Delivery limit must be positive');
    return this.sqlite.query<{
      event_id: string; sequence: number; event_type: string; schema_version: number; project_id: string;
      aggregate_type: string; aggregate_id: string; aggregate_version: number; correlation_id: string;
      causation_id: string | null; occurred_at: number; payload_json: string; attempt_count: number;
    }, [string, number, number]>(`
      SELECT event.event_id,event.sequence,event.event_type,event.schema_version,event.project_id,
        event.aggregate_type,event.aggregate_id,event.aggregate_version,event.correlation_id,
        event.causation_id,event.occurred_at,event.payload_json,delivery.attempt_count
      FROM event_deliveries delivery JOIN domain_events event ON event.event_id=delivery.event_id
      WHERE delivery.consumer_id=?1 AND delivery.state IN ('PENDING','FAILED')
        AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at<=?2)
      ORDER BY event.sequence LIMIT ?3
    `).all(consumerId, now, limit).map((row) => ({
      eventId: row.event_id, sequence: row.sequence, eventType: row.event_type,
      schemaVersion: row.schema_version, projectId: row.project_id,
      aggregateType: row.aggregate_type, aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version, correlationId: row.correlation_id,
      causationId: row.causation_id, occurredAt: row.occurred_at,
      payload: JSON.parse(row.payload_json) as unknown, consumerId,
      attemptCount: row.attempt_count,
    }));
  }

  markEventDelivered(eventId: string, consumerId: string): void {
    const result = this.sqlite.query(`
      UPDATE event_deliveries SET state='DELIVERED',attempt_count=attempt_count+1,
        next_attempt_at=NULL,last_error=NULL
      WHERE event_id=?1 AND consumer_id=?2 AND state IN ('PENDING','FAILED')
    `).run(eventId, consumerId);
    if (result.changes !== 1) throw new StorageError('INVALID_STATE', 'Event delivery was not pending');
  }

  markEventDeliveryFailed(input: {
    readonly eventId: string;
    readonly consumerId: string;
    readonly error: string;
    readonly nextAttemptAt: number;
  }): void {
    const result = this.sqlite.query(`
      UPDATE event_deliveries SET state='FAILED',attempt_count=attempt_count+1,
        next_attempt_at=?1,last_error=?2
      WHERE event_id=?3 AND consumer_id=?4 AND state IN ('PENDING','FAILED')
    `).run(input.nextAttemptAt, input.error, input.eventId, input.consumerId);
    if (result.changes !== 1) throw new StorageError('INVALID_STATE', 'Event delivery was not pending');
  }

  private adapterEventDuplicate(
    sessionId: string,
    providerEventId: string,
    cursor: string,
    eventType: 'attention' | 'completed' | 'disconnected',
    payloadJson: string,
  ): boolean {
    const byId = this.sqlite.query<{
      cursor: string; event_type: string; payload_json: string;
    }, [string, string]>(`
      SELECT cursor,event_type,payload_json FROM adapter_events
      WHERE session_id=?1 AND provider_event_id=?2
    `).get(sessionId, providerEventId);
    if (byId !== null) {
      if (byId.cursor !== cursor || byId.event_type !== eventType
        || canonicalJson(JSON.parse(byId.payload_json) as unknown)
          !== canonicalJson(JSON.parse(payloadJson) as unknown)) {
        throw new StorageError('COMMAND_CONFLICT', 'Provider event ID was reused with different content');
      }
      return true;
    }
    const byCursor = this.sqlite.query<{ provider_event_id: string }, [string, string]>(`
      SELECT provider_event_id FROM adapter_events WHERE session_id=?1 AND cursor=?2
    `).get(sessionId, cursor);
    if (byCursor !== null) {
      throw new StorageError('COMMAND_CONFLICT', 'Provider cursor was reused by a different event');
    }
    return false;
  }

  private insertAdapterEvent(
    sessionId: string,
    providerEventId: string,
    cursor: string,
    eventType: 'attention' | 'completed' | 'disconnected',
    payloadJson: string,
    observedAt: number,
  ): void {
    this.sqlite.query(`
      INSERT INTO adapter_events(session_id,provider_event_id,cursor,event_type,payload_json,observed_at)
      VALUES (?1,?2,?3,?4,?5,?6)
    `).run(sessionId, providerEventId, cursor, eventType, payloadJson, observedAt);
  }

  private adapterEventResult(sessionId: string, providerEventId: string): AdapterEventResult {
    const row = this.sqlite.query<{
      cursor: string; event_type: 'attention' | 'completed' | 'disconnected'; payload_json: string;
      attention_id: string | null;
    }, [string, string]>(`
      SELECT adapter.cursor,adapter.event_type,adapter.payload_json,attention.id AS attention_id
      FROM adapter_events adapter
      LEFT JOIN attention_requests attention ON attention.session_id=adapter.session_id
        AND attention.provider_request_id=json_extract(adapter.payload_json,'$.providerRequestId')
      WHERE adapter.session_id=?1 AND adapter.provider_event_id=?2
    `).get(sessionId, providerEventId);
    if (row === null) throw new StorageError('INVALID_STATE', 'Recorded Adapter event was not found');
    if (row.event_type === 'attention') {
      if (row.attention_id === null) {
        throw new StorageError('INVALID_STATE', 'Recorded Attention event lost its request');
      }
      return { duplicate: true, eventId: providerEventId, cursor: row.cursor,
        sessionState: 'WAITING_FOR_USER', executionState: 'WAITING_FOR_USER',
        attentionId: row.attention_id };
    }
    if (row.event_type === 'disconnected') {
      return { duplicate: true, eventId: providerEventId, cursor: row.cursor,
        sessionState: 'DISCONNECTED', executionState: 'RECOVERY_REQUIRED' };
    }
    const payload = JSON.parse(row.payload_json) as { outcome: 'SUCCESS' | 'FAILURE' };
    return { duplicate: true, eventId: providerEventId, cursor: row.cursor,
      sessionState: 'EXITED', executionState: payload.outcome === 'FAILURE' ? 'FAILED' : 'RUNNING' };
  }

  private observableAgentSessionRow(sessionId: string): (Omit<ObservableAgentSession,
    'providerSessionId'> & { readonly providerSessionId: string | null; readonly workspaceId: string }) | null {
    const row = this.sqlite.query<{
      project_id: string; task_id: string; task_version: number; execution_id: string;
      execution_version: number; execution_state: ObservableAgentSession['executionState'];
      session_id: string; session_version: number; session_state: ObservableAgentSession['sessionState'];
      adapter_id: string; provider_session_id: string | null; observation_cursor: string | null;
      workspace_id: string;
    }, [string]>(`
      SELECT task.project_id,task.id AS task_id,task.version AS task_version,
        execution.id AS execution_id,execution.version AS execution_version,
        execution.state AS execution_state,session.id AS session_id,session.version AS session_version,
        session.state AS session_state,execution.adapter_id,session.provider_session_id,
        session.observation_cursor,execution.workspace_id
      FROM agent_sessions session JOIN executions execution ON execution.id=session.execution_id
      JOIN tasks task ON task.id=execution.task_id WHERE session.id=?1
    `).get(sessionId);
    if (row === null) return null;
    return { projectId: row.project_id, taskId: row.task_id, taskVersion: row.task_version,
      executionId: row.execution_id, executionVersion: row.execution_version,
      executionState: row.execution_state, sessionId: row.session_id,
      sessionVersion: row.session_version, sessionState: row.session_state,
      adapterId: row.adapter_id, providerSessionId: row.provider_session_id,
      ...(row.observation_cursor === null ? {} : { cursor: row.observation_cursor }),
      workspaceId: row.workspace_id };
  }

  reserveExecution(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedTaskVersion: number;
    readonly workspaceId: string;
    readonly executionId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly reservationEventId: string;
    readonly taskEventId: string;
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly actor: string;
    readonly createdAt: number;
  }): ExecutionReservation {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.createdAt,
      apply: (database) => {
        const subject = database.query<{
          task_state: TaskLifecycleState; task_version: number; revision_id: string;
          workspace_state: string; workspace_path: string; ownership_token: string; base_commit: string;
        }, [string, string, string]>(`
          SELECT task.state AS task_state,task.version AS task_version,
            task.current_revision_id AS revision_id,workspace.state AS workspace_state,
            workspace.path AS workspace_path,workspace.ownership_token,workspace.base_commit
          FROM tasks task
          JOIN project_trusts trust ON trust.project_id=task.project_id AND trust.status='ACTIVE'
          JOIN workspaces workspace ON workspace.task_id=task.id AND workspace.id=?3
          WHERE task.project_id=?1 AND task.id=?2
        `).get(input.projectId, input.taskId, input.workspaceId);
        if (subject === null) {
          throw new StorageError('NOT_FOUND', 'Task, workspace, or active project trust was not found');
        }
        if (subject.task_version !== input.expectedTaskVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
        }
        if (subject.task_state !== 'READY' || subject.workspace_state !== 'READY') {
          throw new StorageError(
            'INVALID_STATE',
            `Execution requires READY Task and workspace; got ${subject.task_state}/${subject.workspace_state}`,
          );
        }
        const attempt = database.query<{ number: number }, [string]>(`
          SELECT COALESCE(MAX(attempt_number),0)+1 AS number FROM executions WHERE task_id=?1
        `).get(input.taskId);
        if (attempt === null) throw new Error('Could not allocate an Execution attempt number');
        database.query(`
          INSERT INTO executions(id,task_id,attempt_number,initial_revision_id,applied_revision_id,
            workspace_id,adapter_id,adapter_version,state,resource_held,base_commit,version)
          VALUES (?1,?2,?3,?4,?4,?5,?6,?7,'CREATED',1,?8,0)
        `).run(input.executionId, input.taskId, attempt.number, subject.revision_id,
          input.workspaceId, input.adapterId, input.adapterVersion, subject.base_commit);
        const workspaceUpdate = database.query(
          "UPDATE workspaces SET state='IN_USE' WHERE id=?1 AND state='READY'",
        ).run(input.workspaceId);
        if (workspaceUpdate.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Workspace changed during Execution reservation');
        }
        const taskVersion = input.expectedTaskVersion + 1;
        const taskUpdate = database.query(`
          UPDATE tasks SET state='RUNNING',version=?1,updated_at=?2
          WHERE id=?3 AND project_id=?4 AND version=?5 AND state='READY'
        `).run(taskVersion, input.createdAt, input.taskId, input.projectId, input.expectedTaskVersion);
        if (taskUpdate.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during Execution reservation');
        }
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'ExecutionReserved',1,'Execution',?3,0,?4,?4,?5,?6)
        `).run(input.reservationEventId, input.projectId, input.executionId, input.commandId,
          input.createdAt, JSON.stringify({ executionId: input.executionId, taskId: input.taskId,
            revisionId: subject.revision_id, workspaceId: input.workspaceId }));
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?6,?7,?8)
        `).run(input.taskEventId, input.projectId, input.taskId, taskVersion,
          input.commandId, input.reservationEventId, input.createdAt,
          JSON.stringify({ taskId: input.taskId, from: 'READY', to: 'RUNNING',
            reason: 'execution reserved', actor: input.actor }));
        return {
          executionId: input.executionId,
          taskId: input.taskId,
          taskVersion,
          attemptNumber: attempt.number,
          revisionId: subject.revision_id,
          workspaceId: input.workspaceId,
          workspacePath: subject.workspace_path,
          ownershipToken: subject.ownership_token,
          baseCommit: subject.base_commit,
          adapterId: input.adapterId,
          adapterVersion: input.adapterVersion,
          state: 'CREATED' as const,
        };
      },
    });
  }

  submitTask(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly eventId: string;
    readonly actor: string;
    readonly submittedAt: number;
  }): Readonly<{ taskId: string; state: 'READY'; version: number }> {
    return this.executeCommand({
      projectId: input.projectId,
      commandId: input.commandId,
      payloadHash: input.payloadHash,
      createdAt: input.submittedAt,
      apply: (database) => {
        const task = database.query<{
          id: string; state: TaskLifecycleState; version: number;
        }, [string, string]>(`
          SELECT t.id,t.state,t.version FROM tasks t
          JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
          WHERE t.project_id=?1 AND t.id=?2
        `).get(input.projectId, input.taskId);
        if (task === null) throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
        if (task.version !== input.expectedVersion) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
        }
        if (task.state !== 'DRAFT') {
          throw new StorageError('INVALID_STATE', `Task cannot be submitted from ${task.state}`);
        }
        const version = input.expectedVersion + 1;
        const update = database.query(`
          UPDATE tasks SET state='READY',version=?1,updated_at=?2
          WHERE project_id=?3 AND id=?4 AND version=?5 AND state='DRAFT'
        `).run(version, input.submittedAt, input.projectId, input.taskId, input.expectedVersion);
        if (update.changes !== 1) {
          throw new StorageError('CONCURRENT_MODIFICATION', 'Task changed during submit');
        }
        database.query(`
          INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
            aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
          VALUES (?1,?2,'TaskStateChanged',1,'Task',?3,?4,?5,?5,?6,?7)
        `).run(input.eventId, input.projectId, input.taskId, version, input.commandId,
          input.submittedAt,
          JSON.stringify({ taskId: input.taskId, from: 'DRAFT', to: 'READY', reason: 'submitted', actor: input.actor }));
        return { taskId: input.taskId, state: 'READY' as const, version };
      },
    });
  }

  /** Task, revision, repository facts and Execution attempts for verification decisions. */
  getVerificationCandidates(projectId: string, taskId: string): VerificationCandidates {
    const task = this.sqlite.query<{
      id: string; project_id: string; display_number: number; state: TaskLifecycleState;
      current_revision_id: string; repo_root: string; git_common_dir: string; main_ref: string;
      object_format: 'sha1' | 'sha256';
    }, [string, string]>(`
      SELECT task.id,task.project_id,task.display_number,task.state,task.current_revision_id,
             p.repo_root,p.git_common_dir,p.main_ref,p.object_format
      FROM tasks task
      JOIN projects p ON p.id=task.project_id
      JOIN project_trusts trust ON trust.project_id=p.id AND trust.status='ACTIVE'
      WHERE task.project_id=?1 AND task.id=?2
    `).get(projectId, taskId);
    if (task === null) {
      throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
    }
    const executions = this.sqlite.query<{
      id: string; attempt_number: number; state: ExecutionLifecycleState;
      applied_revision_id: string; result_commit: string | null; base_commit: string;
    }, [string]>(`
      SELECT id,attempt_number,state,applied_revision_id,result_commit,base_commit
      FROM executions WHERE task_id=?1 ORDER BY attempt_number DESC
    `).all(taskId).map((row) => ({
      executionId: row.id,
      attemptNumber: row.attempt_number,
      state: row.state,
      appliedRevisionId: row.applied_revision_id,
      resultCommit: row.result_commit,
      baseCommit: row.base_commit,
    }));
    return {
      projectId: task.project_id,
      taskId: task.id,
      taskDisplayNumber: task.display_number,
      taskState: task.state,
      currentRevisionId: task.current_revision_id,
      repositoryRoot: task.repo_root,
      gitCommonDir: task.git_common_dir,
      mainRef: task.main_ref,
      objectFormat: task.object_format,
      executions,
    };
  }

  /**
   * Records one verification run as QUEUED together with its Operation and command receipt.
   * Replaying the same command returns the recorded run instead of queuing a second one; a
   * different payload under the same command ID is rejected.
   */
  beginVerificationRun(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly executionId: string;
    readonly revisionId: string;
    readonly testedCommit: string;
    readonly testedTree: string;
    readonly policyVersion: string;
    readonly policyDigest: string;
    readonly mainCommit: string;
    readonly commands: readonly StoredVerificationCommand[];
    readonly copyPath: string;
    readonly verificationId: string;
    readonly operationId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly queuedAt: number;
  }): Readonly<{ plan: VerificationRunPlan; created: boolean }> {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<{ payload_hash: string; result_json: string }, [string, string]>(
        'SELECT payload_hash,result_json FROM command_receipts WHERE project_id=?1 AND command_id=?2',
      ).get(input.projectId, input.commandId);
      if (existing !== null) {
        if (existing.payload_hash !== input.payloadHash) {
          throw new StorageError('COMMAND_CONFLICT',
            'Command ID was already used with a different payload');
        }
        const recorded = JSON.parse(existing.result_json) as { verificationId: string };
        return { plan: this.verificationRunPlan(recorded.verificationId), created: false };
      }
      const task = this.sqlite.query<{ state: TaskLifecycleState; current_revision_id: string }, [string, string]>(
        `SELECT t.state,t.current_revision_id FROM tasks t
         JOIN project_trusts trust ON trust.project_id=t.project_id AND trust.status='ACTIVE'
         WHERE t.project_id=?1 AND t.id=?2`,
      ).get(input.projectId, input.taskId);
      if (task === null) {
        throw new StorageError('NOT_FOUND', 'Task or active project trust was not found');
      }
      if (task.state !== 'EXECUTED') {
        throw new StorageError('INVALID_STATE',
          `Task is ${task.state}; verification needs an EXECUTED Task with a captured result commit`);
      }
      if (task.current_revision_id !== input.revisionId) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Task revision changed before verification was queued');
      }
      const execution = this.sqlite.query<{
        state: ExecutionLifecycleState; applied_revision_id: string; result_commit: string | null;
      }, [string, string]>(`
        SELECT state,applied_revision_id,result_commit FROM executions WHERE task_id=?1 AND id=?2
      `).get(input.taskId, input.executionId);
      if (execution === null) {
        throw new StorageError('NOT_FOUND', 'Execution was not found for this Task');
      }
      if (execution.state !== 'SUCCEEDED' || execution.result_commit !== input.testedCommit
        || execution.applied_revision_id !== input.revisionId) {
        throw new StorageError('CONCURRENT_MODIFICATION',
          'Execution evidence changed before verification was queued');
      }
      this.sqlite.query(`
        INSERT INTO operations(id,project_id,kind,aggregate_id,idempotency_key,state,request_json,
          created_at,updated_at)
        VALUES (?1,?2,'RUN_TASK_VERIFICATION',?3,?4,'PLANNED',?5,?6,?6)
      `).run(input.operationId, input.projectId, input.verificationId, input.commandId,
        JSON.stringify({ verificationId: input.verificationId, taskId: input.taskId,
          executionId: input.executionId, testedCommit: input.testedCommit,
          policyDigest: input.policyDigest }), input.queuedAt);
      this.sqlite.query(`
        INSERT INTO verification_runs(id,project_id,task_id,execution_id,revision_id,operation_id,
          command_id,tested_commit,tested_tree,policy_version,policy_digest,main_commit,commands_json,
          copy_path,state,queued_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'QUEUED',?15)
      `).run(input.verificationId, input.projectId, input.taskId, input.executionId, input.revisionId,
        input.operationId, input.commandId, input.testedCommit, input.testedTree, input.policyVersion,
        input.policyDigest, input.mainCommit, JSON.stringify(input.commands), input.copyPath,
        input.queuedAt);
      this.sqlite.query(`
        INSERT INTO command_receipts(project_id,command_id,payload_hash,result_json,created_at)
        VALUES (?1,?2,?3,?4,?5)
      `).run(input.projectId, input.commandId, input.payloadHash,
        JSON.stringify({ verificationId: input.verificationId }), input.queuedAt);
      return { plan: this.verificationRunPlan(input.verificationId), created: true };
    })();
  }

  /** QUEUED → RUNNING with its Operation IN_PROGRESS, before any command is spawned. */
  startVerificationRun(input: {
    readonly verificationId: string;
    readonly startedAt: number;
  }): VerificationRunPlan {
    return this.sqlite.transaction(() => {
      const run = this.verificationRunPlan(input.verificationId);
      if (run.state !== 'QUEUED') return run;
      const updated = this.sqlite.query(`
        UPDATE verification_runs SET state='RUNNING',started_at=?1
        WHERE id=?2 AND state='QUEUED'
      `).run(input.startedAt, input.verificationId);
      const operation = this.sqlite.query(`
        UPDATE operations SET state='IN_PROGRESS',updated_at=?1 WHERE id=?2 AND state='PLANNED'
      `).run(input.startedAt, run.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Verification run changed while starting');
      }
      return this.verificationRunPlan(input.verificationId);
    })();
  }

  /** Records the terminal state, its non-secret evidence, and the VerificationCompleted event. */
  completeVerificationRun(input: {
    readonly verificationId: string;
    readonly state: 'PASSED' | 'FAILED' | 'ERROR';
    readonly outcomeCode: string;
    readonly evidence: VerificationEvidence;
    readonly eventId: string;
    readonly completedAt: number;
  }): VerificationRunPlan {
    return this.sqlite.transaction(() => {
      const run = this.verificationRunPlan(input.verificationId);
      if (run.state !== 'QUEUED' && run.state !== 'RUNNING') return run;
      const updated = this.sqlite.query(`
        UPDATE verification_runs SET state=?1,outcome_code=?2,evidence_json=?3,ended_at=?4
        WHERE id=?5 AND state IN ('QUEUED','RUNNING')
      `).run(input.state, input.outcomeCode, JSON.stringify(input.evidence),
        input.completedAt, input.verificationId);
      const operationState = input.state === 'PASSED' ? 'SUCCEEDED' : 'FAILED';
      const operation = this.sqlite.query(`
        UPDATE operations SET state=?1,result_json=?2,updated_at=?3
        WHERE id=?4 AND state IN ('PLANNED','IN_PROGRESS')
      `).run(operationState, JSON.stringify({ verificationId: input.verificationId,
        state: input.state, outcomeCode: input.outcomeCode }), input.completedAt, run.operationId);
      if (updated.changes !== 1 || operation.changes !== 1) {
        throw new StorageError('CONCURRENT_MODIFICATION', 'Verification run changed while completing');
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'VerificationCompleted',1,'VerificationRun',?3,0,?4,?5,?6,?7)
      `).run(input.eventId, run.projectId, input.verificationId, input.eventId, null, input.completedAt,
        JSON.stringify({ verificationId: input.verificationId, taskId: run.taskId,
          executionId: run.executionId, revisionId: run.revisionId, testedCommit: run.testedCommit,
          testedTree: run.testedTree, policyVersion: run.policyVersion,
          policyDigest: run.policyDigest, mainCommit: run.mainCommit,
          state: input.state, outcomeCode: input.outcomeCode, evidence: input.evidence }));
      return this.verificationRunPlan(input.verificationId);
    })();
  }

  /**
   * Marks successful runs whose tested commit or confirmed policy no longer applies as STALE.
   * Old evidence is never rewritten: a stale run keeps its outcome and gains a stale reason.
   */
  markVerificationsStale(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly testedCommit: string;
    readonly policyDigest: string;
    readonly reason: string;
    readonly eventId: string;
    readonly invalidatedAt: number;
  }): number {
    return this.sqlite.transaction(() => {
      const stale = this.sqlite.query<{ id: string }, [string, string, string, string]>(`
        SELECT id FROM verification_runs
        WHERE project_id=?1 AND task_id=?2 AND state='PASSED'
          AND (tested_commit<>?3 OR policy_digest<>?4)
      `).all(input.projectId, input.taskId, input.testedCommit, input.policyDigest);
      if (stale.length === 0) return 0;
      for (const row of stale) {
        this.sqlite.query(`
          UPDATE verification_runs
          SET state='STALE',
              evidence_json=json_set(COALESCE(evidence_json,'{}'),'$.staleReason',?1,
                '$.staleAt',?2)
          WHERE id=?3 AND state='PASSED'
        `).run(input.reason, input.invalidatedAt, row.id);
      }
      this.sqlite.query(`
        INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
          aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
        VALUES (?1,?2,'VerificationInvalidated',1,'Task',?3,0,?1,NULL,?4,?5)
      `).run(input.eventId, input.projectId, input.taskId, input.invalidatedAt,
        JSON.stringify({ taskId: input.taskId, reason: input.reason,
          verificationIds: stale.map((row) => row.id), testedCommit: input.testedCommit,
          policyDigest: input.policyDigest }));
      return stale.length;
    })();
  }

  listVerificationRuns(projectId: string, taskId: string): readonly VerificationRunSummary[] {
    return this.sqlite.query<{ id: string }, [string, string]>(`
      SELECT id FROM verification_runs WHERE project_id=?1 AND task_id=?2
      ORDER BY queued_at DESC,id
    `).all(projectId, taskId).map((row) => this.verificationRunPlan(row.id));
  }

  getVerificationRun(projectId: string, verificationId: string): VerificationRunSummary {
    const plan = this.verificationRunPlan(verificationId);
    if (plan.projectId !== projectId) {
      throw new StorageError('NOT_FOUND', 'Verification run was not found for this project');
    }
    return plan;
  }

  /** Runs a previous Runtime left QUEUED or RUNNING; a restart reconciles them explicitly. */
  listIncompleteVerificationRuns(): readonly VerificationRunPlan[] {
    return this.sqlite.query<{ id: string }, []>(`
      SELECT id FROM verification_runs WHERE state IN ('QUEUED','RUNNING') ORDER BY queued_at,id
    `).all().map((row) => this.verificationRunPlan(row.id));
  }

  private verificationRunPlan(verificationId: string): VerificationRunPlan {
    const row = this.sqlite.query<{
      id: string; project_id: string; task_id: string; execution_id: string; revision_id: string;
      operation_id: string; operation_state: VerificationRunPlan['operationState'];
      tested_commit: string; tested_tree: string; policy_version: string; policy_digest: string;
      main_commit: string; commands_json: string; copy_path: string; state: VerificationState;
      outcome_code: string | null; evidence_json: string | null; queued_at: number;
      started_at: number | null; ended_at: number | null;
    }, [string]>(`
      SELECT r.id,r.project_id,r.task_id,r.execution_id,r.revision_id,r.operation_id,
             o.state AS operation_state,r.tested_commit,r.tested_tree,r.policy_version,
             r.policy_digest,r.main_commit,r.commands_json,r.copy_path,r.state,r.outcome_code,
             r.evidence_json,r.queued_at,r.started_at,r.ended_at
      FROM verification_runs r JOIN operations o ON o.id=r.operation_id
      WHERE r.id=?1
    `).get(verificationId);
    if (row === null) throw new StorageError('NOT_FOUND', 'Verification run was not found');
    return {
      verificationId: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      executionId: row.execution_id,
      revisionId: row.revision_id,
      operationId: row.operation_id,
      operationState: row.operation_state,
      testedCommit: row.tested_commit,
      testedTree: row.tested_tree,
      policyVersion: row.policy_version,
      policyDigest: row.policy_digest,
      mainCommit: row.main_commit,
      commands: JSON.parse(row.commands_json) as readonly StoredVerificationCommand[],
      copyPath: row.copy_path,
      state: row.state,
      outcomeCode: row.outcome_code,
      evidence: row.evidence_json === null
        ? null
        : JSON.parse(row.evidence_json) as VerificationEvidence,
      queuedAt: row.queued_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }

  updateTaskPriority(input: {
    readonly taskId: string;
    readonly expectedVersion: number;
    readonly priority: number;
    readonly updatedAt: number;
  }): number {
    const result = this.sqlite.query(`
      UPDATE tasks SET priority=?1, updated_at=?2, version=version+1
      WHERE id=?3 AND version=?4
    `).run(input.priority, input.updatedAt, input.taskId, input.expectedVersion);
    if (result.changes !== 1) {
      throw new StorageError('CONCURRENT_MODIFICATION', 'Task version did not match');
    }
    return input.expectedVersion + 1;
  }

  executeCommand<T extends object>(input: {
    readonly projectId: string;
    readonly commandId: string;
    readonly payloadHash: string;
    readonly createdAt: number;
    readonly apply: (database: Database) => T;
  }): T {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.query<
        { payload_hash: string; result_json: string },
        [string, string]
      >('SELECT payload_hash,result_json FROM command_receipts WHERE project_id=?1 AND command_id=?2')
        .get(input.projectId, input.commandId);
      if (existing !== null) {
        if (existing.payload_hash !== input.payloadHash) {
          throw new StorageError('COMMAND_CONFLICT', 'Command ID was already used with a different payload');
        }
        return JSON.parse(existing.result_json) as T;
      }

      const result = input.apply(this.sqlite);
      this.sqlite.query(`
        INSERT INTO command_receipts(project_id,command_id,payload_hash,result_json,created_at)
        VALUES (?1,?2,?3,?4,?5)
      `).run(input.projectId, input.commandId, input.payloadHash, JSON.stringify(result), input.createdAt);
      return result;
    })();
  }
}
