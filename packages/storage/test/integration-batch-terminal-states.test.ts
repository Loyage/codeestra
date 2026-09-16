/**
 * Multi-member IntegrationBatch storage (FOUNDATION-081 / ADR-0053, schema v30).
 *
 * Schema v30 widens `integration_batches.state` with the two terminal verdicts a multi-member batch
 * needs (`STALE`, `CANCELLED`). Widening a `STRICT` table's CHECK means rebuilding the table, so this
 * test drives the upgrade on a **real temporary file database** and checks the three things a rebuild
 * can get wrong: every existing row survives, the new constraint is actually in force, and the schema
 * still has no foreign-key violation.
 *
 * The version assertion is `>= 30` or the migration constant itself — never "the current version is
 * exactly 30", which a later step would break.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  integrationBatchTerminalStatesMigration,
  Phase1Database,
  phase1SchemaVersion,
} from '../src/index.js';
import { restorePreV34CapacitySchema } from './support/restore-pre-v34.js';

/** The exact DDL schema v29 had, so the fixture below can be downgraded to it. */
const stateCheckV29 = `CHECK(state IN ('CREATED','PREPARING','VERIFYING','INTEGRATING_DEV',
    'INTEGRATED','CONFLICTED','FAILED','RECOVERY_REQUIRED'))`;

function downgradeToV29(database: Database): void {
  database.exec('PRAGMA foreign_keys=OFF;');
  // A v29 database also predates the tables added by schema v31 (Session Guidance, ADR-0057), so
  // they are removed as well: the upgrade below must be exactly what a real v29 database runs.
  for (const table of ['session_guidance_deliveries', 'execution_guidance_contexts',
    'session_guidance']) {
    database.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  // ...and the column added by schema v32 (declared features, ADR-0059).
  database.exec('ALTER TABLE task_revisions DROP COLUMN features_json');
  // ...and the column added by schema v33 (the per-Task base ref, ADR-0060): a v29 database
  // recorded no base ref on a workspace, so the upgrade must replay that ADD COLUMN itself.
  database.exec('ALTER TABLE workspaces DROP COLUMN base_ref');
  // ...and everything schema v34 (ADR-0061) added, with the two tables it retires restored: a real
  // v29 database has the project-scoped capacity configuration and no Runtime singleton.
  restorePreV34CapacitySchema(database);
  database.exec(`
    CREATE TABLE integration_batches_v29 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      dev_ref TEXT NOT NULL CHECK(length(trim(dev_ref)) > 0),
      dev_commit TEXT NOT NULL,
      state TEXT NOT NULL ${stateCheckV29},
      integrated_commit TEXT,
      merge_strategy TEXT CHECK(merge_strategy IS NULL OR merge_strategy IN ('FAST_FORWARD','MERGE_COMMIT')),
      merged_commit TEXT,
      worktree_path TEXT,
      worktree_ownership_token TEXT NOT NULL,
      verification_id TEXT,
      outcome_code TEXT,
      detail TEXT,
      created_at INTEGER NOT NULL CHECK(created_at >= 0),
      completed_at INTEGER,
      CHECK(integrated_commit IS NULL OR state='INTEGRATED'),
      CHECK(completed_at IS NULL OR completed_at >= created_at)
    ) STRICT;
    INSERT INTO integration_batches_v29 SELECT * FROM integration_batches;
    DROP TABLE integration_batches;
    ALTER TABLE integration_batches_v29 RENAME TO integration_batches;
    CREATE INDEX integration_batches_by_project ON integration_batches(project_id,created_at,id);
    PRAGMA user_version=29;
  `);
}

describe('integration batch terminal states (schema v30)', () => {
  test('the migration belongs to this step and widens the batch state check', () => {
    expect(phase1SchemaVersion).toBeGreaterThanOrEqual(30);
    expect(integrationBatchTerminalStatesMigration).toContain("'STALE','CANCELLED'");
    expect(integrationBatchTerminalStatesMigration).toContain('integration_batches_v30');
  });

  test('a version 29 file database with rows upgrades in place and keeps every row', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-batch-v29-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      new Phase1Database(filename).close();
      const legacy = new Database(filename, { create: true, strict: true });
      downgradeToV29(legacy);
      legacy.query(`INSERT INTO projects
        (id,name,repo_root,git_common_dir,main_ref,dev_ref,object_format,created_at)
        VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','refs/heads/dev','sha1',1)`).run();
      const states = ['CREATED', 'PREPARING', 'VERIFYING', 'INTEGRATING_DEV', 'INTEGRATED',
        'CONFLICTED', 'FAILED', 'RECOVERY_REQUIRED'];
      for (const [index, state] of states.entries()) {
        legacy.query(`INSERT INTO integration_batches
          (id,project_id,dev_ref,dev_commit,state,integrated_commit,worktree_ownership_token,
           created_at,completed_at)
          VALUES (?1,'p1','refs/heads/dev','${'a'.repeat(40)}',?2,${state === 'INTEGRATED'
    ? `'${'b'.repeat(40)}'` : 'NULL'},'token',?3,?3)`).run(`batch-${index}`, state, index + 2);
      }
      legacy.close();

      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBeGreaterThanOrEqual(30);
      // Every existing row survived the rebuild, with its state and its columns intact.
      const rows = upgraded.sqlite.query<{ id: string; state: string; integrated_commit: string | null;
        worktree_ownership_token: string; completed_at: number | null }, []>(`
        SELECT id,state,integrated_commit,worktree_ownership_token,completed_at
        FROM integration_batches ORDER BY id
      `).all();
      expect(rows).toHaveLength(states.length);
      expect(rows.map((row) => row.state).sort()).toEqual([...states].sort());
      expect(rows.every((row) => row.worktree_ownership_token === 'token')).toBe(true);
      expect(rows.find((row) => row.state === 'INTEGRATED')?.integrated_commit).toBe('b'.repeat(40));
      // The widened CHECK is in force: both new verdicts are accepted, an invented state is not.
      upgraded.sqlite.query(`INSERT INTO integration_batches
        (id,project_id,dev_ref,dev_commit,state,worktree_ownership_token,created_at)
        VALUES ('batch-stale','p1','refs/heads/dev',?1,'STALE','token2',20)`).run('a'.repeat(40));
      upgraded.sqlite.query(`INSERT INTO integration_batches
        (id,project_id,dev_ref,dev_commit,state,worktree_ownership_token,created_at)
        VALUES ('batch-cancelled','p1','refs/heads/dev',?1,'CANCELLED','token3',21)`).run('a'.repeat(40));
      expect(() => upgraded.sqlite.query(`INSERT INTO integration_batches
        (id,project_id,dev_ref,dev_commit,state,worktree_ownership_token,created_at)
        VALUES ('batch-bogus','p1','refs/heads/dev',?1,'ABANDONED','token4',22)`).run('a'.repeat(40)))
        .toThrow();
      // The rebuilt table keeps its children's references valid.
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
      expect(upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='integration_batches_by_project'",
      ).get()?.name).toBe('integration_batches_by_project');
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
