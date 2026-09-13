/**
 * Versioned, fail-closed deny policy for the paths a result commit would stage.
 * The policy never silently skips a path: a hit stops the commit and asks the user
 * to move or remove the file, so a result commit is never an incomplete secret leak.
 */
export const sensitivePathPolicyVersion = 1;

export interface SensitivePathHit {
  readonly path: string;
  readonly reason: string;
}

const secretBasenames = new Map<string, string>([
  ['.netrc', 'credential file'],
  ['.npmrc', 'package registry credentials'],
  ['.pgpass', 'database credentials'],
  ['.git-credentials', 'stored Git credentials'],
  ['credentials', 'credential file'],
  ['credentials.json', 'credential file'],
  ['service-account.json', 'service account key'],
  ['id_rsa', 'SSH private key'],
  ['id_dsa', 'SSH private key'],
  ['id_ecdsa', 'SSH private key'],
  ['id_ed25519', 'SSH private key'],
]);

const secretExtensions = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.ppk']);

const runtimeBasenames = /^runtime\.sqlite(?:-wal|-shm|-journal)?$/;
const runtimeSegments = new Set(['pi-sessions', '.codeestra-runtime', '.ssh']);

export function classifySensitivePath(path: string): SensitivePathHit | null {
  if (path.length === 0) return { path, reason: 'empty change path' };
  if (path.startsWith('/') || path.startsWith('~')) {
    return { path, reason: 'change path is not workspace-relative' };
  }
  const segments = path.split('/');
  if (segments.includes('..')) return { path, reason: 'change path escapes the workspace' };
  const basename = segments[segments.length - 1] ?? '';
  const lower = basename.toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.')) return { path, reason: 'environment file' };
  const secretReason = secretBasenames.get(lower);
  if (secretReason !== undefined) return { path, reason: secretReason };
  const dot = lower.lastIndexOf('.');
  if (dot > 0 && secretExtensions.has(lower.slice(dot))) {
    return { path, reason: `secret-bearing file (${lower.slice(dot)})` };
  }
  if (runtimeBasenames.test(lower)) return { path, reason: 'Codeestra runtime database' };
  for (const segment of segments) {
    if (runtimeSegments.has(segment)) {
      return { path, reason: segment === '.ssh' ? 'SSH directory' : 'Codeestra runtime data directory' };
    }
  }
  return null;
}

export function classifySensitivePaths(paths: readonly string[]): readonly SensitivePathHit[] {
  const hits: SensitivePathHit[] = [];
  for (const path of paths) {
    const hit = classifySensitivePath(path);
    if (hit !== null) hits.push(hit);
  }
  return hits;
}
