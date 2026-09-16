import { useState } from 'react';
import { RuntimeClient } from './api.js';
import type { TaskPurgeOutcomeView, TaskView } from './types.js';

/**
 * The `task purge` projection (ADR-0058).
 *
 * Scope of this module — what it is and is not:
 * - It sends exactly the request the CLI sends (`task.purge` with `expectedVersion`, `confirmed:
 *   true` and an optional `reason`). It **does not delete anything itself**, and it never touches
 *   Git or the filesystem: the Runtime removes the worktrees, verification copies and branches.
 * - It **does not decide eligibility.** Only the Runtime knows whether the Task already put a commit
 *   into `dev`, whether a provider process is still alive, or whether a recorded worktree is still
 *   this Task's. Every refusal is shown with the stable code the Runtime returned.
 * - The typed confirmation is the same fact as the CLI's `--yes`, not a second gate: the button
 *   stays disabled until the Task's own display number is typed, because permanent deletion cannot be
 *   undone and a mis-click in a list of Tasks is exactly what it would destroy.
 * - `--force` (ADR-0058 D09) is the same statement widened, not a second gate: after a refusal the user
 *   may say once more that the Task should go, which sends the same request with `force: true` — the
 *   button the CLI spells `--force`. The component judges nothing: it shows what the Runtime reported
 *   stepping over.
 */

/** The refusals `--force` may step over (ADR-0058 D09); anything else is not offerable as forced. */
const forceableRefusals: ReadonlySet<string> = new Set([
  'RECONCILE_REQUIRED', 'TASK_INTEGRATED_INTO_DEV', 'TASK_IN_STABLE_PROMOTION',
  'PURGE_RESOURCE_NOT_OWNED',
]);

/** `task purge`: `confirmed` is the UI's `--yes`, `force` its `--force`, and `reason` only when written. */
export function purgeCommand(input: {
  readonly projectId: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly reason: string | null;
  readonly commandId: string;
  readonly force?: boolean;
}): Record<string, unknown> {
  const reason = input.reason === null ? '' : input.reason.trim();
  return {
    command: 'task.purge',
    commandId: input.commandId,
    projectId: input.projectId,
    taskId: input.taskId,
    expectedVersion: input.expectedVersion,
    confirmed: true,
    ...(input.force === true ? { force: true } : {}),
    ...(reason.length === 0 ? {} : { reason }),
  };
}

/**
 * Whether the typed confirmation names this exact Task. The display number is what the user reads in
 * the list ("任务 #12"), so typing it back is a statement about *which* Task, not a magic word.
 */
export function purgeConfirmationMatches(input: {
  readonly typed: string;
  readonly displayNumber: number;
}): boolean {
  const typed = input.typed.trim();
  if (!/^\d+$/.test(typed)) return false;
  return Number(typed) === input.displayNumber;
}

/** What the deletion destroyed, in the one sentence a user needs to be able to repeat back. */
export function purgeOutcomeLine(result: TaskPurgeOutcomeView): string {
  const parts = [
    `任务 #${result.displayNumber}（${result.state}）已永久删除`,
    `删除行数 ${Object.values(result.rowsDeleted).reduce((sum, count) => sum + count, 0)}`,
    `工作树 ${result.plan.worktrees}`,
    `验证副本 ${result.plan.verificationCopies}`,
    `分支 ${result.plan.branches}`,
  ];
  if (result.stop !== null) {
    parts.push(result.stop.stop === 'RECOVERED'
      ? `删除前已按观察对账（${result.stop.state}）`
      : result.stop.stop === 'FORCED'
        ? `强制删除：进程未证明静止（${result.stop.state}）`
        : `删除前已终止（${result.stop.state}）`);
  }
  if (result.forced !== null) {
    parts.push(`--force 跳过 ${result.forced.bypassed.length} 项拒绝`);
  }
  if (result.dependencyEdgesRemoved > 0) {
    parts.push(`移除依赖边 ${result.dependencyEdgesRemoved}`);
  }
  return parts.join(' · ');
}

/**
 * What a forced deletion stepped over, one line per fact: the same list the CLI prints to stderr, so
 * "the Task is gone" never hides "this is what was not proven".
 */
export function purgeForcedLines(result: TaskPurgeOutcomeView): readonly string[] {
  if (result.forced === null) return [];
  const lines = result.forced.bypassed.map((entry) => `${entry.code} — ${entry.detail}`);
  const termination = result.forced.termination;
  if (termination !== null) {
    lines.push(termination.terminated
      ? `已尝试终止 provider 进程：${termination.detail}`
      : `provider 进程可能仍在运行：${termination.detail}`);
  }
  return lines;
}

/** Branch tips are the only part of a deleted branch that survives, so they are shown verbatim. */
export function purgeBranchLines(result: TaskPurgeOutcomeView): readonly string[] {
  return result.branchFacts.map((fact) => (fact.deleted
    ? `${fact.branchRef} → ${fact.tipCommit ?? '(无 tip)'}（已删除）`
    : `${fact.branchRef} · ${fact.detail}`));
}

export function TaskPurgeControls(props: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  readonly task: TaskView;
  readonly onChanged: () => Promise<void>;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<TaskPurgeOutcomeView | null>(null);
  const [rejection, setRejection] = useState<{ readonly code: string;
    readonly message: string } | null>(null);
  /** Local to this control so a double click cannot send two deletions. */
  const [pending, setPending] = useState(false);

  const confirmed = purgeConfirmationMatches({
    typed, displayNumber: props.task.displayNumber,
  });
  // `--force` is offered only for the refusals it can step over, and it is the *same* Request with one
  // more bit — the Runtime still decides everything (ADR-0058 D09).
  const forceable = rejection !== null && forceableRefusals.has(rejection.code);

  const purge = (force: boolean): void => {
    if (pending || !confirmed) return;
    setPending(true);
    void props.run(force ? '正在强制删除任务' : '正在永久删除任务', async () => {
      setOutcome(null);
      setRejection(null);
      try {
        const result = await props.client.command<TaskPurgeOutcomeView>(purgeCommand({
          projectId: props.projectId,
          taskId: props.task.id,
          expectedVersion: props.task.version,
          reason: reason.length === 0 ? null : reason,
          commandId: crypto.randomUUID(),
          ...(force ? { force: true } : {}),
        }));
        setOutcome(result);
        setTyped('');
      } catch (caught) {
        // A refusal deletes nothing and is not an exception to hide: the stable code is the answer,
        // and it decides whether asking again with `--force` is even a thing to offer.
        const code = caught instanceof Error && 'code' in caught ? String(caught.code) : 'UNKNOWN';
        const message = caught instanceof Error ? caught.message : String(caught);
        setRejection({ code, message });
      }
      await props.onChanged();
    }).finally(() => { setPending(false); });
  };

  return (
    <div className="purge-control">
      <details className="danger-zone">
        <summary>永久删除（不可撤销）</summary>
        <p className="muted">
          永久删除会连同该任务的全部修订、执行、会话、证据，以及它自己的 worktree、验证副本与分支
          一起销毁。非终态任务会先走一次协作停止；无法确认进程静止时不删除任何东西。
          成果已进入 dev/main 的任务会被拒绝，请改用「归档」。被拒绝时仍可在下面用「仍要强制删除」
          （等同 CLI 的 --force）：它会先尝试终止该任务记录的 provider 进程，再删除本来会拒绝的行，
          无法证明归属的目录与分支会留在磁盘上并如实列出。
        </p>
        <label>
          输入任务编号 #{props.task.displayNumber} 以确认
          <input
            type="text"
            inputMode="numeric"
            value={typed}
            placeholder={String(props.task.displayNumber)}
            onChange={(event) => { setTyped(event.target.value); }}
          />
        </label>
        <label>
          原因（可选，记入审计）
          <input type="text" value={reason}
            onChange={(event) => { setReason(event.target.value); }} />
        </label>
        <button type="button" className="danger" disabled={pending || !confirmed}
          title={confirmed ? '永久删除该任务' : '请输入该任务的编号以启用'}
          onClick={() => { purge(false); }}>永久删除</button>
      </details>
      {rejection === null ? null : (
        <p className="error" role="alert">删除被拒绝：{rejection.code} — {rejection.message}</p>
      )}
      {forceable ? (
        <div className="purge-force">
          <p className="muted">
            强制删除会跳过上面的拒绝：先尝试终止该任务记录的 provider 进程（只对身份可核验的 pid
            发信号），再删除本来会拒绝的行。归属性无法证明的目录与分支会留在磁盘上；成果已进入
            dev/main 的任务会连带丢掉「谁把这个提交带进来的」记录。
          </p>
          <button type="button" className="danger" disabled={pending || !confirmed}
            title={confirmed ? '强制删除该任务' : '请输入该任务的编号以启用'}
            onClick={() => { purge(true); }}>仍要强制删除</button>
        </div>
      ) : null}
      {outcome === null ? null : (
        <div className="purge-outcome">
          <p>{purgeOutcomeLine(outcome)}</p>
          {outcome.replayed ? <p className="muted">这是同一命令的重放，没有发生第二次删除。</p> : null}
          {purgeForcedLines(outcome).map((line) => (
            <p key={line} className="muted">{line}</p>
          ))}
          {purgeBranchLines(outcome).map((line) => (
            <p key={line} className="muted mono">{line}</p>
          ))}
        </div>
      )}
    </div>
  );
}
