import { z } from 'zod';

export const repositoryIdentitySchema = z.strictObject({
  repoRoot: z.string().min(1),
  gitCommonDir: z.string().min(1),
  mainRef: z.string().min(1),
  objectFormat: z.enum(['sha1', 'sha256']),
  headCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
});
export type RepositoryIdentity = z.infer<typeof repositoryIdentitySchema>;

const requestBase = {
  requestId: z.string().uuid(),
  schemaVersion: z.literal(1),
};

const taskKindSchema = z.enum(['DEVELOPMENT', 'SELF']);
const nonBlankString = z.string().min(1).refine((value) => value.trim().length > 0, 'Must not be blank');
const constraintSchema = z.strictObject({ id: z.string().min(1), text: nonBlankString });
const constraintsSchema = z.array(constraintSchema).superRefine((constraints, context) => {
  const ids = new Set<string>();
  for (const [index, constraint] of constraints.entries()) {
    if (ids.has(constraint.id)) {
      context.addIssue({ code: 'custom', message: 'Constraint IDs must be unique', path: [index, 'id'] });
    }
    ids.add(constraint.id);
  }
});

export const runtimeRequestSchema = z.discriminatedUnion('command', [
  z.strictObject({ ...requestBase, command: z.literal('runtime.ping') }),
  z.strictObject({ ...requestBase, command: z.literal('runtime.stop') }),
  z.strictObject({ ...requestBase, command: z.literal('project.inspect'), path: z.string().min(1) }),
  z.strictObject({
    ...requestBase,
    command: z.literal('project.trust'),
    path: z.string().min(1),
    expectedIdentity: repositoryIdentitySchema,
  }),
  z.strictObject({ ...requestBase, command: z.literal('project.list') }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.create'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    specification: nonBlankString,
    constraints: constraintsSchema.default([]),
    kind: taskKindSchema.default('DEVELOPMENT'),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.list'),
    projectId: z.string().uuid(),
  }),
  z.strictObject({
    ...requestBase,
    command: z.literal('task.submit'),
    commandId: z.string().uuid(),
    projectId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
  }),
]);
export type RuntimeRequest = z.infer<typeof runtimeRequestSchema>;

export const runtimeResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    requestId: z.string(),
    schemaVersion: z.literal(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    requestId: z.string(),
    schemaVersion: z.literal(1),
    ok: z.literal(false),
    error: z.strictObject({ code: z.string(), message: z.string() }),
  }),
]);
export type RuntimeResponse = z.infer<typeof runtimeResponseSchema>;
