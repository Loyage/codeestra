import { Database } from 'bun:sqlite';
import { phase1Migration, phase1SchemaVersion } from './migration.js';

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
      this.sqlite.exec(phase1Migration);
      this.sqlite.exec(`PRAGMA user_version=${phase1SchemaVersion}`);
    })();
  }

  trustProject(input: TrustedProject & { readonly trustId: string; readonly actor: string }): void {
    this.sqlite.transaction(() => {
      this.sqlite.query(`
        INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,object_format,policy_version,created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
      `).run(input.id, input.name, input.repoRoot, input.gitCommonDir, input.mainRef,
        input.objectFormat, input.policyVersion, input.trustedAt);
      this.sqlite.query(`
        INSERT INTO project_trusts
          (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,'ACTIVE',?8)
      `).run(input.trustId, input.id, input.repoRoot, input.gitCommonDir, input.objectFormat,
        input.policyVersion, input.actor, input.trustedAt);
    })();
  }

  invalidateProjectTrust(projectId: string, invalidatedAt: number): void {
    const result = this.sqlite.query(`
      UPDATE project_trusts SET status='INVALIDATED',invalidated_at=?1
      WHERE project_id=?2 AND status='ACTIVE'
    `).run(invalidatedAt, projectId);
    if (result.changes !== 1) throw new StorageError('NOT_FOUND', 'Active project trust was not found');
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

  executeCommand<T extends CommandResult>(input: {
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
