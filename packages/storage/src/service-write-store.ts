import type { Database } from 'bun:sqlite';
import { StorageError, type Phase1Database, type TrustedProject } from './database.js';
import { KernelStorageError, ServiceKernelStore, type ServiceView } from './service-kernel-store.js';

/**
 * S7 (ADR-0070): the single authoritative write path for the two legacy core rows that already have
 * a Service identity — `projects` and `tasks` — and for the Service rows that project them.
 *
 * Before this file those rows were inserted by `Phase1Database.trustProject` /
 * `Phase1Database.createTask`, while the matching `services` row was repaired later (and possibly
 * never) by `ServiceKernelStore.reconcileProjections`. Two writers for one fact is what let a crash
 * between them leave a `tasks` row with no Service, and what made "which handler created this Task"
 * unanswerable. Here the core row, its initial children and its Service row are written by one
 * statement sequence inside one transaction, so:
 *
 *  - a failure applies nothing (no half row, no orphan Service);
 *  - a repeat converges on the rows that already exist instead of writing a second Service;
 *  - the Service identity is the aggregate identity (`services.id` = `projects.id` / `tasks.id`,
 *    `project_id` / `task_id` point back at it), which is the convention schema v37's projection
 *    established and what makes `service get <task-id>` and `task status <project> <task-id>` two
 *    readings of one fact.
 *
 * What this class deliberately does *not* own: the command receipt and the `intents` row of a Task
 * creation (`Phase1Database`, whose `executeCommand`/`insertIntent` are the single writers for
 * those), the display-number allocation, and project trust's own trust/policy rows. The Service
 * rows are the part that had two writers; that part now has one.
 */
export class ServiceWriteStore {
  readonly sqlite: Database;
  readonly #storage: Phase1Database;
  #views: ServiceKernelStore | null = null;

  constructor(storage: Phase1Database) {
    this.#storage = storage;
    this.sqlite = storage.sqlite;
  }

  /**
   * The only writer of `projects` rows: a project exists exactly as the trust that registered it.
   * A repository that is already trusted keeps its recorded project identity, so re-trusting never
   * forks a project, and a repository whose recorded identity contradicts the inspection is refused
   * with the existing `INVALID_STATE` code.
   *
   * This method participates in the caller's transaction (`Phase1Database.trustProject` writes the
   * trust and the two policy confirmations in the same one) instead of opening its own; the caller
   * must already be inside one, which is what makes "project row + Service row + trust row" atomic.
   */
  ensureProjectRow(input: { readonly project: TrustedProject }): {
    readonly projectId: string; readonly created: boolean } {
    const project = input.project;
    const existing = this.sqlite.query<{
      id: string; repo_root: string; git_common_dir: string; object_format: 'sha1' | 'sha256';
    }, [string]>(`
      SELECT id,repo_root,git_common_dir,object_format FROM projects WHERE repo_root=?1
    `).get(project.repoRoot);
    if (existing === null) {
      this.sqlite.query(`
        INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,
          object_format,policy_version,created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
      `).run(project.id, project.name, project.repoRoot, project.gitCommonDir, project.mainRef,
        project.objectFormat, project.policyVersion, project.trustedAt);
      return { projectId: project.id, created: true };
    }
    if (existing.repo_root !== project.repoRoot
      || existing.git_common_dir !== project.gitCommonDir
      || existing.object_format !== project.objectFormat) {
      throw new StorageError('INVALID_STATE', 'Repository identity does not match the trusted project');
    }
    return { projectId: existing.id, created: false };
  }

  /**
   * Ensures the PROJECT Service of an already-recorded project row: `parent = root Service`,
   * `project_id = projectId`, `lifecycle = ACTIVE`, `state_version = 0`.
   *
   * Idempotent by project: a second call returns the Service the first one wrote, and never rewrites
   * it. The root Service must exist and must really be `ROOT` — otherwise the tree would be invalid
   * and the caller is refused with a stable code instead of a raw trigger `ABORT`
   * (`SERVICE_NOT_FOUND` / `INVALID_SERVICE_PARENT`).
   *
   * The registration fact (`kernel/registered`) is the one durable trace of *which* event registered
   * this Service. It is metadata, not a `domain_events` row: project trust deliberately writes no
   * domain event, because those rows are one global cursor-ordered log and renumbering it would
   * change what an already-connected subscriber sees (S7 keeps the compatibility event log intact).
   * The row is written once (`ON CONFLICT DO NOTHING`), so a re-trust keeps the original event id.
   */
  ensureProjectService(input: {
    readonly projectId: string; readonly rootServiceId: string; readonly now: number;
    readonly eventId: string;
  }): ServiceView {
    const projectId = requireText(input.projectId, 'projectId');
    const eventId = requireText(input.eventId, 'eventId');
    return this.sqlite.transaction(() => {
      const root = this.sqlite.query<{ id: string; kind: string }, [string]>(
        'SELECT id,kind FROM services WHERE id=?1').get(input.rootServiceId);
      if (root === null) {
        throw new KernelStorageError('SERVICE_NOT_FOUND',
          `Root Service ${input.rootServiceId} was not found, so no PROJECT Service can be created`);
      }
      if (root.kind !== 'ROOT') {
        throw new KernelStorageError('INVALID_SERVICE_PARENT',
          `Service ${root.id} is ${root.kind}; a PROJECT Service must be a direct child of the ROOT Service`);
      }
      const project = this.sqlite.query<{ id: string; created_at: number }, [string]>(
        'SELECT id,created_at FROM projects WHERE id=?1').get(projectId);
      if (project === null) {
        throw new KernelStorageError('PROJECT_NOT_FOUND',
          `Project ${projectId} was not found; the project row and its Service are written together`);
      }
      const existing = this.sqlite.query<{ id: string; kind: string }, [string]>(
        'SELECT id,kind FROM services WHERE project_id=?1').get(projectId);
      if (existing !== null) {
        if (existing.kind !== 'PROJECT') {
          throw new KernelStorageError('INVALID_SERVICE_PARENT',
            `Service ${existing.id} already projects project ${projectId} as ${existing.kind}`);
        }
        return this.viewStore().getService(existing.id);
      }
      const takenId = this.sqlite.query<{ kind: string }, [string]>(
        'SELECT kind FROM services WHERE id=?1').get(projectId);
      if (takenId !== null) {
        throw new KernelStorageError('SERVICE_ID_CONFLICT',
          `Service id ${projectId} already exists as ${takenId.kind}`);
      }
      // The Service row keeps the project's own creation clock — what schema v37's projection would
      // have written for this row — clamped to the caller's `now`.
      const createdAt = Math.min(project.created_at, input.now);
      const updatedAt = Math.max(input.now, createdAt);
      this.sqlite.query(`INSERT INTO services
        (id,kind,parent_service_id,lifecycle,state_version,contract_version,project_id,task_id,
          inbox_cursor,created_at,updated_at)
        VALUES (?1,'PROJECT',?2,'ACTIVE',0,1,?1,NULL,0,?3,?4)`)
        .run(projectId, input.rootServiceId, createdAt, updatedAt);
      this.sqlite.query(`INSERT INTO service_metadata
        (service_id,namespace,key,value_json,version,updated_at,updated_by)
        VALUES (?1,'kernel','registered',?2,1,?3,'project-trust')
        ON CONFLICT(service_id,namespace,key) DO NOTHING`)
        .run(projectId, json({ eventId, registeredAt: input.now }), input.now);
      return this.viewStore().getService(projectId);
    })();
  }

  /**
   * Creates a TASK Service: the `tasks` row, its initial `task_revisions` row, the TASK Service row
   * (`parent = the project's Service`, `task_id = taskId`), and the two domain events a Task creation
   * records — `IntentRecorded` (`eventIds[0]`) and `TaskCreated` (`eventIds[1]`) — in one transaction.
   *
   * The Service rows and the two events are what the frozen S7 contract asks for; `command` and
   * `features` are additive because the frozen input had no room for facts this path cannot invent
   * (the `intents` row the revision and the event reference, the command id both events correlate
   * with, the actor, and the full declared-feature list that `task create --feature` accepts more
   * than once). `feature` remains the frozen single-value spelling of the same declaration.
   *
   * Idempotent by `taskId`: a repeat returns the Service that already projects the Task (repairing a
   * missing Service row if one was lost) instead of writing a second row, and a `taskId` that
   * belongs to another project is refused with `TASK_ID_CONFLICT`.
   */
  createTaskService(input: {
    readonly projectId: string; readonly projectServiceId: string; readonly taskId: string;
    readonly displayNumber: number; readonly displayTitle: string; readonly namingTitle: string | null;
    readonly revisionId: string; readonly specification: string; readonly feature: string | null;
    readonly now: number; readonly eventIds: readonly [string, string];
    readonly command: { readonly intentId: string; readonly commandId: string; readonly actor: string };
    readonly features?: readonly string[];
  }): { readonly service: ServiceView; readonly taskId: string } {
    const taskId = requireText(input.taskId, 'taskId');
    const intentId = requireText(input.command.intentId, 'command.intentId');
    const commandId = requireText(input.command.commandId, 'command.commandId');
    const actor = requireText(input.command.actor, 'command.actor');
    const declared = input.features === undefined
      ? (input.feature === null ? [] : [input.feature])
      : [...input.features];
    if (input.features !== undefined && (input.features[0] ?? null) !== input.feature) {
      throw new KernelStorageError('INVALID_STATE',
        'The single `feature` and the declared `features` list contradict each other');
    }
    return this.sqlite.transaction(() => {
      const existingTask = this.sqlite.query<{ project_id: string; created_at: number }, [string]>(
        'SELECT project_id,created_at FROM tasks WHERE id=?1').get(taskId);
      if (existingTask !== null) {
        if (existingTask.project_id !== input.projectId) {
          throw new KernelStorageError('TASK_ID_CONFLICT',
            `Task ${taskId} already belongs to project ${existingTask.project_id}`);
        }
        this.ensureTaskServiceRow({ taskId, projectServiceId: input.projectServiceId,
          now: input.now, createdAt: existingTask.created_at });
        return { service: this.viewStore().getService(taskId), taskId };
      }
      const parent = this.sqlite.query<{ kind: string; project_id: string | null }, [string]>(
        'SELECT kind,project_id FROM services WHERE id=?1').get(input.projectServiceId);
      if (parent === null) {
        throw new KernelStorageError('SERVICE_NOT_FOUND',
          `Project Service ${input.projectServiceId} was not found`);
      }
      if (parent.kind !== 'PROJECT' || parent.project_id !== input.projectId) {
        throw new KernelStorageError('INVALID_SERVICE_PARENT',
          `Service ${input.projectServiceId} is ${parent.kind} of project ${parent.project_id ?? 'none'};`
          + ` a TASK Service must be a direct child of the Service of project ${input.projectId}`);
      }
      this.sqlite.query(`
        INSERT INTO tasks(id,project_id,display_number,display_title,naming_title,
          current_revision_id,state,priority,version,created_at,updated_at)
        VALUES (?1,?2,?3,?4,?5,?6,'DRAFT',0,0,?7,?7)
      `).run(taskId, input.projectId, input.displayNumber, input.displayTitle, input.namingTitle,
        input.revisionId, input.now);
      this.sqlite.query(`
        INSERT INTO task_revisions(id,task_id,number,previous_revision_id,specification,
          features_json,source_intent_id,actor,reason,created_at)
        VALUES (?1,?2,1,NULL,?3,?4,?5,?6,'initial task creation',?7)
      `).run(input.revisionId, taskId, input.specification, json(declared), intentId, actor, input.now);
      this.ensureTaskServiceRow({ taskId, projectServiceId: input.projectServiceId,
        now: input.now, createdAt: input.now });
      this.insertEvent({ eventId: input.eventIds[0], projectId: input.projectId,
        eventType: 'IntentRecorded', aggregateType: 'Intent', aggregateId: intentId,
        correlationId: commandId, causationId: commandId, occurredAt: input.now,
        payload: { intentId, kind: 'CREATE_TASK' } });
      this.insertEvent({ eventId: input.eventIds[1], projectId: input.projectId,
        eventType: 'TaskCreated', aggregateType: 'Task', aggregateId: taskId,
        correlationId: commandId, causationId: input.eventIds[0], occurredAt: input.now,
        payload: { taskId, revisionId: input.revisionId, displayTitle: input.displayTitle,
          namingTitle: input.namingTitle, features: declared } });
      return { service: this.viewStore().getService(taskId), taskId };
    })();
  }

  private ensureTaskServiceRow(input: {
    readonly taskId: string; readonly projectServiceId: string;
    readonly now: number; readonly createdAt: number;
  }): void {
    const existing = this.sqlite.query<{ id: string; parent_service_id: string | null }, [string]>(
      'SELECT id,parent_service_id FROM services WHERE task_id=?1').get(input.taskId);
    if (existing !== null) {
      if (existing.parent_service_id !== input.projectServiceId) {
        throw new KernelStorageError('INVALID_SERVICE_PARENT',
          `Task Service ${existing.id} is a child of ${existing.parent_service_id ?? 'nothing'},`
          + ` not of ${input.projectServiceId}`);
      }
      return;
    }
    const parent = this.sqlite.query<{ kind: string }, [string]>(
      'SELECT kind FROM services WHERE id=?1').get(input.projectServiceId);
    if (parent === null) {
      throw new KernelStorageError('SERVICE_NOT_FOUND',
        `Project Service ${input.projectServiceId} was not found`);
    }
    if (parent.kind !== 'PROJECT') {
      throw new KernelStorageError('INVALID_SERVICE_PARENT',
        `Service ${input.projectServiceId} is ${parent.kind}; a TASK Service must be a direct child of`
        + ' a PROJECT Service');
    }
    // The Task row is authoritative for the Service's own clock: a Service that is repaired for an
    // existing Task must not look newer than the Task it projects.
    const updatedAt = Math.max(input.now, input.createdAt);
    this.sqlite.query(`INSERT INTO services
      (id,kind,parent_service_id,lifecycle,state_version,contract_version,project_id,task_id,
        inbox_cursor,created_at,updated_at)
      VALUES (?1,'TASK',?2,'ACTIVE',0,1,NULL,?1,0,?3,?4)`)
      .run(input.taskId, input.projectServiceId, input.createdAt, updatedAt);
  }

  private insertEvent(input: {
    readonly eventId: string; readonly projectId: string; readonly eventType: string;
    readonly aggregateType: string; readonly aggregateId: string; readonly correlationId: string;
    readonly causationId: string | null; readonly occurredAt: number; readonly payload: unknown;
  }): void {
    this.sqlite.query(`INSERT INTO domain_events(event_id,project_id,event_type,schema_version,
      aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
      VALUES (?1,?2,?3,1,?4,?5,0,?6,?7,?8,?9)`)
      .run(input.eventId, input.projectId, input.eventType, input.aggregateType, input.aggregateId,
        input.correlationId, input.causationId, input.occurredAt, json(input.payload));
  }

  /** The read projection of a row this store just wrote: one ServiceView mapper, not two. */
  private viewStore(): ServiceKernelStore {
    this.#views ??= new ServiceKernelStore(this.#storage);
    return this.#views;
  }
}

function requireText(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new KernelStorageError('INVALID_STATE', `${field} must be a non-empty string`);
  }
  return value;
}

function json(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) {
    throw new KernelStorageError('INVALID_JSON_VALUE', 'Value is not JSON serializable');
  }
  return result;
}
