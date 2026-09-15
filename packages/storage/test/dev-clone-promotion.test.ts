/**
 * The dev clone and the GitHub-mediated promotion (FOUNDATION-077 / ADR-0047, schema v29).
 *
 * The upgrade is asserted against a real temporary file database, and the version assertion is
 * `>= 29` or the migration constant itself — never "the current version is exactly 29" (three
 * earlier waves broke on that exact assertion after a merge that added a later step). v16 stays
 * permanently unused and v22 stays unoccupied: the migration only appends `if (version < 29)`.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Phase1Database, devClonePromotionMigration, phase1SchemaVersion } from '../src/index.js';

const projectId = '10000000-0000-4000-8000-000000000001';

function temporaryDatabase(): { readonly directory: string; readonly filename: string } {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-dev-clone-v29-'));
  return { directory, filename: join(directory, 'runtime.sqlite') };
}

function columns(database: Database, table: string): readonly string[] {
  return database.query<{ name: string }, []>(
    `SELECT name FROM pragma_table_info('${table}')`).all().map((row) => row.name);
}

describe('dev clone promotion storage', () => {
  test('the v29 migration belongs to this step and is a pure ADD COLUMN step', () => {
    expect(phase1SchemaVersion).toBeGreaterThanOrEqual(29);
    expect(devClonePromotionMigration).toContain('ALTER TABLE projects ADD COLUMN dev_repo_path');
    expect(devClonePromotionMigration).toContain('ALTER TABLE stable_promotions ADD COLUMN');
    // Nothing is rebuilt: a table rebuild would DROP and recreate, which this step must not do.
    expect(devClonePromotionMigration).not.toContain('DROP TABLE');
    expect(devClonePromotionMigration).not.toContain('RENAME TO');
    expect(devClonePromotionMigration).not.toContain('user_version');
  });

  test('a version 28 file database upgrades in place, adds the columns and keeps its rows', () => {
    const { directory, filename } = temporaryDatabase();
    try {
      // Build the current schema, insert one project, then remove exactly what v29 added: the
      // upgrade below is then the same statement a real v28 database runs.
      const built = new Phase1Database(filename);
      built.sqlite.query(`
        INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,dev_ref,dev_repo_path,
          object_format,policy_version,created_at)
        VALUES (?1,'Legacy','/tmp/legacy','/tmp/legacy/.git','refs/heads/main','refs/heads/dev',
          '/tmp/legacy-dev','sha1',1,7)
      `).run(projectId);
      built.close();

      const legacy = new Database(filename, { create: true, strict: true });
      legacy.exec('PRAGMA foreign_keys=OFF;');
      for (const column of ['dev_repo_path', 'remote_dev_commit', 'remote_main_commit', 'pushed_at',
        'main_pushed_at']) {
        legacy.exec(`ALTER TABLE stable_promotions DROP COLUMN ${column}`);
      }
      legacy.exec('ALTER TABLE projects DROP COLUMN dev_repo_path');
      // A version 28 database also predates every later step, so the tables added by schema v31
      // (Session Guidance, ADR-0057) are removed too: the upgrade below must be exactly what a real
      // v28 database runs.
      for (const table of ['session_guidance_deliveries', 'execution_guidance_contexts',
        'session_guidance']) {
        legacy.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      legacy.exec('PRAGMA user_version=28');
      legacy.close();

      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBeGreaterThanOrEqual(29);
      expect(columns(upgraded.sqlite, 'projects')).toContain('dev_repo_path');
      expect(columns(upgraded.sqlite, 'stable_promotions')).toEqual(expect.arrayContaining(
        ['dev_repo_path', 'remote_dev_commit', 'remote_main_commit', 'pushed_at', 'main_pushed_at']));
      // The row that existed before the upgrade is preserved, and it simply has no dev clone: an
      // upgrade never invents a path.
      const project = upgraded.sqlite.query<{
        id: string; name: string; dev_repo_path: string | null; dev_ref: string;
      }, []>('SELECT id,name,dev_repo_path,dev_ref FROM projects').get();
      expect(project).toEqual({ id: projectId, name: 'Legacy', dev_repo_path: null,
        dev_ref: 'refs/heads/dev' });
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('trust records a verified dev clone, keeps it when it is not mentioned, and clears it on request', () => {
    const database = new Phase1Database();
    const trust = (devRepoPath?: string | null): void => {
      database.trustProject({
        id: projectId,
        trustId: crypto.randomUUID(),
        name: 'Temporary',
        repoRoot: '/tmp/main-clone',
        gitCommonDir: '/tmp/main-clone/.git',
        mainRef: 'refs/heads/main',
        devRef: 'refs/heads/dev',
        objectFormat: 'sha1',
        policyVersion: 1,
        verificationPolicyConfirmationId: crypto.randomUUID(),
        verificationPolicy: { state: 'ABSENT', digest: null, mainRef: 'refs/heads/main',
          mainCommit: 'a'.repeat(40) },
        trustedAt: 1,
        actor: 'local-user',
        ...(devRepoPath === undefined ? {} : { devRepoPath, recordDevRepoPath: true }),
      });
    };
    trust('/tmp/dev-clone');
    expect(database.getTrustedProject(projectId).devRepoPath).toBe('/tmp/dev-clone');
    // A re-trust that says nothing about the dev clone must not clear it behind the user's back.
    trust();
    expect(database.getTrustedProject(projectId).devRepoPath).toBe('/tmp/dev-clone');
    // Clearing is explicit.
    trust(null);
    expect(database.getTrustedProject(projectId).devRepoPath).toBeNull();
    database.close();
  });
});
