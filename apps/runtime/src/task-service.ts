import { createHash } from 'node:crypto';
import type { Phase1Database, TaskSummary } from '@codeestra/storage';
import { resolveDeclaredFeatures } from './impact-analysis-service.js';

/**
 * The response of `task.create`, unchanged: the stored Task projection the CLI already prints. It is
 * named here so the one creation entry point can state its contract without importing the CLI.
 */
export type TaskCreateView = TaskSummary;

export interface TaskServiceOptions {
  readonly storage: Phase1Database;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly actor?: string;
}

/**
 * S7 (ADR-0070): the single entry point that creates a Task.
 *
 * `task.create` is one caller; a future intention `CREATE_TASK` and the scheduler's own Task
 * creation are the others, and they must not each re-derive the rules. What this class owns is
 * everything a caller of "create a Task" should not have to know:
 *
 *  - the declared-feature check (ADR-0059) against the project's mapping, before anything is
 *    written, so an undeclared id is a refusal (`UNKNOWN_FEATURE`) and not a stored string;
 *  - the command identity and its payload hash, so a retried command returns the same Task instead
 *    of creating a second one;
 *  - the IDs of the Task, its first revision and the two events, so no caller invents half of them.
 *
 * What it does *not* own is the write itself: `Phase1Database.createTask` holds the command receipt
 * and the `intents` row, and `ServiceWriteStore.createTaskService` writes the `tasks` row, its first
 * revision and the TASK Service in one transaction. The Task Service row and the `tasks` row are
 * therefore written exactly once, by one handler, on this path and on every other.
 *
 * `features`/`commandId` are additive to the frozen S7 input: `task create --feature` repeats, so
 * one Task can declare several features, and the Runtime's request already carries a command id that
 * a retry must reuse. Neither changes what is returned.
 */
export class TaskService {
  readonly #storage: Phase1Database;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #actor: string;

  constructor(options: TaskServiceOptions) {
    this.#storage = options.storage;
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#actor = options.actor ?? 'local-user';
  }

  async create(input: {
    readonly projectId: string;
    readonly displayTitle: string;
    readonly namingTitle: string;
    readonly detail: string;
    readonly feature?: string;
    readonly features?: readonly string[];
    /** The command this creation is; a retry that reuses it returns the Task it already created. */
    readonly commandId?: string;
  }): Promise<TaskCreateView> {
    // Declared features are validated before anything is written (ADR-0059 D03): an id that the
    // project's mapping does not declare is a refusal with its own code, not a stored string that a
    // later judgment would have to guess about.
    const features = await resolveDeclaredFeatures({
      storage: this.#storage,
      projectId: input.projectId,
      features: input.features
        ?? (input.feature === undefined ? undefined : [input.feature]),
    });
    const specification = input.detail;
    const payloadHash = createHash('sha256').update(JSON.stringify({
      projectId: input.projectId,
      displayTitle: input.displayTitle,
      namingTitle: input.namingTitle,
      specification,
      features,
    })).digest('hex');
    return this.#storage.createTask({
      projectId: input.projectId,
      commandId: input.commandId ?? this.#randomUUID(),
      payloadHash,
      intentId: this.#randomUUID(),
      taskId: this.#randomUUID(),
      revisionId: this.#randomUUID(),
      intentEventId: this.#randomUUID(),
      taskEventId: this.#randomUUID(),
      displayTitle: input.displayTitle,
      namingTitle: input.namingTitle,
      specification,
      features,
      actor: this.#actor,
      createdAt: this.#now(),
    });
  }
}
