import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const permissionModeSchema = z.enum(['FULL', 'STRICT']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

const persistedPermissionModeSchema = z.strictObject({
  version: z.literal(1),
  mode: permissionModeSchema,
});

/** Full access is intentionally the product default; strict mode is an explicit opt-in. */
export const defaultPermissionMode: PermissionMode = 'FULL';

export function permissionModePath(runtimeHome: string): string {
  return join(runtimeHome, 'permission-mode.json');
}

export async function readPermissionMode(runtimeHome: string): Promise<PermissionMode> {
  const file = Bun.file(permissionModePath(runtimeHome));
  if (!await file.exists()) return defaultPermissionMode;
  const parsed = persistedPermissionModeSchema.safeParse(await file.json());
  if (!parsed.success) {
    throw new Error(`INVALID_PERMISSION_MODE: ${parsed.error.message}`);
  }
  return parsed.data.mode;
}

/** Atomic replacement keeps a crash from leaving a partially written mode file. */
export function writePermissionMode(runtimeHome: string, mode: PermissionMode): void {
  const validated = permissionModeSchema.parse(mode);
  mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  const target = permissionModePath(runtimeHome);
  const temporary = join(dirname(target), `.permission-mode-${process.pid}-${crypto.randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify({ version: 1, mode: validated })}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}
