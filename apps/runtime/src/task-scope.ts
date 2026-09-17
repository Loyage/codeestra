import { StorageError, type Phase1Database } from '@codeestra/storage';
import type { RuntimeRequest } from '@codeestra/contracts';

/**
 * Task-scoped Runtime commands (ADR-0076).
 *
 * These are the commands the CLI spells as `codeestra task …`. They name a **Task** (or an id that
 * belongs to exactly one Task, such as an `operationId` or a revision `deliveryId`), and the project
 * is derived from that row instead of being repeated by the caller: `tasks.id` is globally unique, so
 * the project is a column of the Task, not part of its address.
 *
 * Deliberately **not** here:
 * - `task.create` — the Task does not exist yet, so there is nothing to derive the project from.
 * - `task.list` — a listing is not an operation on one Task; `projectId` is an optional filter.
 * - `task.depends.list` — bound to one project's baseline ref; it takes a Task *or* a project.
 * - `task.schedule.status|plan|run` — a scheduling pass is per project, not per Task.
 * - `project.integration.request`, `project.impact.*`, `session.guidance.*` and the slot-reservation
 *   commands — they keep naming their project (the user's decision for this round was `task *` only).
 */
type TaskScopedCommand =
  | 'task.archive' | 'task.cancel' | 'task.depends.add' | 'task.depends.remove'
  | 'task.integration.show' | 'task.operation.cancel' | 'task.operation.get' | 'task.operation.list'
  | 'task.pause' | 'task.purge' | 'task.recover' | 'task.result.capture' | 'task.result.commit'
  | 'task.result.prepare' | 'task.resume' | 'task.retry' | 'task.revision.create'
  | 'task.revision.delivery.get' | 'task.revision.delivery.list' | 'task.revision.delivery.resolve'
  | 'task.revision.list' | 'task.run' | 'task.schedule.clearUnknown' | 'task.schedule.explain'
  | 'task.status' | 'task.submit' | 'task.tests.history' | 'task.tests.record' | 'task.tests.show'
  | 'task.unarchive' | 'task.verification.list' | 'task.verify';

type TaskScopedRequest = Extract<RuntimeRequest, { command: TaskScopedCommand }>;

/**
 * A Runtime request in which every Task-scoped command already carries the project the Runtime
 * resolved. `task.list` keeps `projectId` optional (omitted = every trusted project) and
 * `task.depends.list` is narrowed to a resolved project, because a read with neither subject is
 * refused before it reaches the handler.
 */
export type ScopedRuntimeRequest =
  | Exclude<RuntimeRequest,
      TaskScopedRequest | { command: 'task.list' } | { command: 'task.depends.list' }>
  | (TaskScopedRequest & { readonly projectId: string })
  | Extract<RuntimeRequest, { command: 'task.list' }>
  | (Extract<RuntimeRequest, { command: 'task.depends.list' }> & { readonly projectId: string });

const taskScopedCommands: ReadonlySet<string> = new Set<string>([
  'task.archive', 'task.cancel', 'task.depends.add', 'task.depends.remove',
  'task.integration.show', 'task.operation.cancel', 'task.operation.get', 'task.operation.list',
  'task.pause', 'task.purge', 'task.recover', 'task.result.capture', 'task.result.commit',
  'task.result.prepare', 'task.resume', 'task.retry', 'task.revision.create',
  'task.revision.delivery.get', 'task.revision.delivery.list', 'task.revision.delivery.resolve',
  'task.revision.list', 'task.run', 'task.schedule.clearUnknown', 'task.schedule.explain',
  'task.status', 'task.submit', 'task.tests.history', 'task.tests.record', 'task.tests.show',
  'task.unarchive', 'task.verification.list', 'task.verify',
]);

function isTaskScoped(request: RuntimeRequest): request is TaskScopedRequest {
  return taskScopedCommands.has(request.command);
}

/** `{ ...request, projectId }` with the narrowed type the handlers rely on. */
function withProject<T extends { readonly projectId?: string | undefined }>(
  request: T,
  projectId: string,
): T & { readonly projectId: string } {
  return { ...request, projectId } as T & { readonly projectId: string };
}

/**
 * Fills in the project of every Task-scoped command from the Task itself (ADR-0076 D01).
 *
 * It is one place, before the dispatch switch, so a handler never has to know whether its caller
 * named a project: by the time it runs, `projectId` is there. A caller that named a project as well
 * is checked against the resolved one (`TASK_PROJECT_MISMATCH`) rather than having one of the two
 * silently win, and an untrusted project reads exactly like a missing Task (`NOT_FOUND`).
 */
export function resolveTaskScope(
  request: RuntimeRequest,
  storage: Phase1Database,
): ScopedRuntimeRequest {
  if (request.command === 'task.list') {
    // Omitting the project is the "every trusted project" listing; when one is given, `listTasks`
    // keeps its own trust check.
    return request;
  }
  if (request.command === 'task.depends.list') {
    // One subject is enough: the Task names the project, or the caller names the project to read the
    // project-wide graph. Neither is a refusal, because this projection is bound to one baseline ref
    // and has no project-independent answer (ADR-0076 D04).
    if (request.taskId !== undefined) {
      return withProject(request, storage.resolveTaskProject(request.taskId, request.projectId));
    }
    if (request.projectId === undefined) {
      throw new StorageError('TASK_SCOPE_REQUIRED',
        'task.depends.list needs a Task or a project: pass <task-id> or --project <project-id>');
    }
    return withProject(request, request.projectId);
  }
  if (!isTaskScoped(request)) return request;
  // Two commands address a Task-owned row by its own id, so the project comes from that row.
  if (request.command === 'task.operation.get') {
    return withProject(request,
      storage.resolveOperationProject(request.operationId, request.projectId));
  }
  if (request.command === 'task.revision.delivery.get') {
    return withProject(request,
      storage.resolveRevisionDeliveryProject(request.deliveryId, request.projectId));
  }
  return withProject(request, storage.resolveTaskProject(request.taskId, request.projectId));
}
