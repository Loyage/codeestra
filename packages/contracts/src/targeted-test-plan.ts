import { createHash } from 'node:crypto';
import { z } from 'zod';
import { maxTotalVerificationSeconds, verificationCommandSchema } from './verification-policy.js';

/**
 * Branch-targeted test plan (ADR-0038, ADR-0039).
 *
 * ADR-0038 splits verification cost by branch responsibility: a `task/*`, `lane/*`, feature or
 * Self Task candidate branch fixes a *small* set of targeted tests when the branch is created, and
 * the full suite only runs on `dev` against an exact candidate SHA before `dev → main`.
 *
 * The declaration lives in the branch itself — `.codeestra/tests.json` — so the scope a branch
 * chose travels with the commit that chose it and is visible in Git review. The file is *read from
 * the tested commit*, never from `main`: unlike the project-wide verification policy (which is read
 * from `main` so a Task branch cannot rewrite the commands that judge it), this plan is exactly the
 * branch's own statement about what its change must be checked by.
 *
 * A file in a commit is not yet a recorded fact, though: the Runtime snapshots it into an
 * append-only plan record bound to `(task, revision, commit, digest)` before any verification can
 * consume it (see `apps/runtime/src/verification-service.ts`). That is what makes a scope change an
 * explicit, audited event instead of a silent widening or narrowing.
 */
export const targetedTestPlanPath = '.codeestra/tests.json';
/** Version of the plan *semantics*, independent of the recorded content digest. */
export const targetedTestPlanVersion = 'targeted-test-plan-v1';
/** A targeted plan is deliberately small: a branch that needs 16+ commands is not "targeted". */
export const maxTargetedTestPlanCommands = 16;

export class TargetedTestPlanError extends Error {
  constructor(
    readonly code: 'INVALID_TARGETED_TEST_PLAN' | 'TARGETED_TEST_PLAN_ABSENT',
    message: string,
  ) {
    super(message);
    this.name = 'TargetedTestPlanError';
  }
}

/**
 * One targeted command: the same argv/cwd/timeout contract as a verification policy command (so it
 * is spawned as an argv array in its own process group and never through a shell), plus a required
 * `covers` statement — the plan must say what each command is responsible for, because "run this
 * file" without a reason is exactly the sort of assertion ADR-0038 asks a branch to justify.
 */
export const targetedTestCommandSchema = verificationCommandSchema.extend({
  covers: z.string().min(1).max(200),
});
export type TargetedTestCommand = z.infer<typeof targetedTestCommandSchema>;

export const targetedTestPlanSchema = z.strictObject({
  version: z.literal(1),
  /** Human-readable statement of what this branch's change area is. */
  scope: z.string().min(1).max(400),
  commands: z.array(targetedTestCommandSchema).min(1).max(maxTargetedTestPlanCommands),
}).superRefine((plan, context) => {
  const ids = new Set<string>();
  for (const [index, command] of plan.commands.entries()) {
    if (ids.has(command.id)) {
      context.addIssue({ code: 'custom', path: ['commands', index, 'id'],
        message: 'Command IDs must be unique' });
    }
    ids.add(command.id);
  }
  const total = plan.commands.reduce((sum, command) => sum + command.timeoutSeconds, 0);
  if (total > maxTotalVerificationSeconds) {
    context.addIssue({ code: 'custom', path: ['commands'],
      message: `Total timeout ${total}s exceeds the ${maxTotalVerificationSeconds}s plan limit` });
  }
});
export type TargetedTestPlan = z.infer<typeof targetedTestPlanSchema>;

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? 'plan' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/** Parses plan text as delivered by Git. Unknown keys and bad values fail closed. */
export function parseTargetedTestPlan(text: string): TargetedTestPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new TargetedTestPlanError('INVALID_TARGETED_TEST_PLAN',
      `${targetedTestPlanPath} is not valid JSON`);
  }
  const parsed = targetedTestPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TargetedTestPlanError('INVALID_TARGETED_TEST_PLAN',
      `${targetedTestPlanPath} is not a valid targeted test plan: ${describe(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Content digest over the normalized plan. A recorded plan binds this digest, so an edit to any
 * command, argument, working directory, timeout or coverage statement is a *different* plan and
 * needs a new record — an existing verification can never silently claim the new scope.
 */
export function targetedTestPlanDigest(plan: TargetedTestPlan): string {
  const canonical = {
    commands: plan.commands.map((command) => ({
      argv: [...command.argv],
      covers: command.covers,
      cwd: command.cwd,
      id: command.id,
      timeoutSeconds: command.timeoutSeconds,
    })),
    scope: plan.scope,
    version: plan.version,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Short human-readable label for a recorded plan, used in reports and evidence. */
export function targetedTestPlanLabel(digest: string): string {
  return `${targetedTestPlanVersion}#${digest.slice(0, 12)}`;
}

/** The commands of a plan in the shape a verification run stores and spawns. */
export function targetedTestPlanCommands(plan: TargetedTestPlan): readonly {
  readonly id: string; readonly argv: readonly string[]; readonly cwd: string;
  readonly timeoutSeconds: number;
}[] {
  return plan.commands.map((command) => ({
    id: command.id, argv: command.argv, cwd: command.cwd, timeoutSeconds: command.timeoutSeconds,
  }));
}

/**
 * The lockfile whose digest is part of the `dev → main` full-suite evidence binding (ADR-0038 D03:
 * a change to the candidate, the test configuration or the lockfile invalidates the evidence).
 * This project's toolchain is Bun, so the lockfile is `bun.lock`; a project without one gets an
 * explicit refusal instead of a quietly weaker binding.
 */
export const devFullSuiteLockfilePath = 'bun.lock';
