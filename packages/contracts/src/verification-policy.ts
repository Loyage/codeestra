import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * Human-maintained Task verification policy. Phase 1 reads it from the project main ref
 * only: a Task branch can therefore never rewrite the commands that judge it.
 */
export const verificationPolicyPath = '.codeestra/policies/verification.json';
/** Version of the policy *semantics*, independent of the confirmed content digest. */
export const verificationPolicyVersion = 'verification-policy-v1';
/** Upper bound for one policy run, so no policy can occupy the Runtime indefinitely. */
export const maxTotalVerificationSeconds = 3_600;

export class VerificationPolicyError extends Error {
  constructor(
    readonly code: 'INVALID_VERIFICATION_POLICY' | 'VERIFICATION_POLICY_NOT_CONFIRMED'
      | 'VERIFICATION_POLICY_UNREADABLE',
    message: string,
  ) {
    super(message);
    this.name = 'VerificationPolicyError';
  }
}

function nonBlankString(message: string) {
  return z.string().min(1).refine((value) => value.trim().length > 0, message);
}

/** Commands are argv arrays: user text is never concatenated into a shell. */
export const verificationCommandSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    'Command IDs use letters, digits, dot, dash, or underscore'),
  argv: z.array(nonBlankString('Command arguments must not be blank')).min(1).max(64),
  cwd: z.string().default('.'),
  timeoutSeconds: z.number().int().min(1).max(1_800).default(900),
}).superRefine((command, context) => {
  const program = command.argv[0] ?? '';
  if (isAbsolute(program) || program.startsWith('~') || program.split('/').includes('..')) {
    context.addIssue({ code: 'custom', path: ['argv', 0],
      message: 'Command program must be resolved from PATH or stay inside the verification copy' });
  }
  if (command.cwd === '') {
    context.addIssue({ code: 'custom', path: ['cwd'], message: 'cwd must not be empty' });
    return;
  }
  if (isAbsolute(command.cwd) || command.cwd.startsWith('~')) {
    context.addIssue({ code: 'custom', path: ['cwd'],
      message: 'cwd must be relative to the verification copy' });
  }
  for (const segment of command.cwd.split('/')) {
    if (segment === '..') {
      context.addIssue({ code: 'custom', path: ['cwd'],
        message: 'cwd must not escape the verification copy' });
      break;
    }
  }
});
export type VerificationCommand = z.infer<typeof verificationCommandSchema>;

export const verificationPolicySchema = z.strictObject({
  version: z.literal(1),
  commands: z.array(verificationCommandSchema).min(1).max(32),
}).superRefine((policy, context) => {
  const ids = new Set<string>();
  for (const [index, command] of policy.commands.entries()) {
    if (ids.has(command.id)) {
      context.addIssue({ code: 'custom', path: ['commands', index, 'id'],
        message: 'Command IDs must be unique' });
    }
    ids.add(command.id);
  }
  const total = policy.commands.reduce((sum, command) => sum + command.timeoutSeconds, 0);
  if (total > maxTotalVerificationSeconds) {
    context.addIssue({ code: 'custom', path: ['commands'],
      message: `Total timeout ${total}s exceeds the ${maxTotalVerificationSeconds}s policy limit` });
  }
});
export type VerificationPolicy = z.infer<typeof verificationPolicySchema>;

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? 'policy' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/** Parses policy text as delivered by Git. Unknown keys and bad values fail closed. */
export function parseVerificationPolicy(text: string): VerificationPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new VerificationPolicyError('INVALID_VERIFICATION_POLICY',
      `${verificationPolicyPath} is not valid JSON`);
  }
  const parsed = verificationPolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw new VerificationPolicyError('INVALID_VERIFICATION_POLICY',
      `${verificationPolicyPath} is not a valid verification policy: ${describe(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Content digest over the normalized policy. Confirmation and every run bind this digest,
 * so an edit to any command, argument, working directory, or timeout requires a new
 * explicit confirmation.
 */
export function verificationPolicyDigest(policy: VerificationPolicy): string {
  const canonical = {
    commands: policy.commands.map((command) => ({
      argv: [...command.argv],
      cwd: command.cwd,
      id: command.id,
      timeoutSeconds: command.timeoutSeconds,
    })),
    version: policy.version,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Short human-readable label for a confirmed policy. */
export function verificationPolicyLabel(digest: string): string {
  return `${verificationPolicyVersion}#${digest.slice(0, 12)}`;
}

const objectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/**
 * What the user explicitly confirmed for verification. `ABSENT` is a confirmation that the
 * project has no policy at all; it never falls back to guessed commands.
 */
export const verificationPolicyConfirmationSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ABSENT'), mainCommit: objectIdSchema }),
  z.strictObject({
    state: z.literal('PRESENT'),
    mainCommit: objectIdSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);
export type VerificationPolicyConfirmation = z.infer<typeof verificationPolicyConfirmationSchema>;

/** Read-only inspection result shown to the user before trust or verification. */
export interface VerificationPolicyInspection {
  readonly state: 'ABSENT' | 'PRESENT';
  readonly mainRef: string;
  readonly mainCommit: string;
  readonly digest?: string;
  readonly label?: string;
  readonly policy?: VerificationPolicy;
}
