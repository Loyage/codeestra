import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Phase1Database,
  agentAnswerMigration,
  agentConfigurationMigration,
  agentDisconnectMigration,
  agentObservationMigration,
  agentPluginSelectionMigration,
  agentStartMigration,
  capacitySlotReservationMigration,
  devClonePromotionMigration,
  impactAnalysisMigration,
  integrationBatchTerminalStatesMigration,
  integrationPipelineMigration,
  intentKindShrinkMigration,
  knowledgeLayerMigration,
  operationProgressMigration,
  phase1Migration,
  phase1SchemaVersion,
  reclamationMigration,
  revisionDeliveryMigration,
  sessionHandoffMigration,
  sessionTerminalMigration,
  stablePromotionMigration,
  taskControlMigration,
  taskDependenciesMigration,
  taskRetryMigration,
  taskVerificationMigration,
  unregisteredReclamationMigration,
  verificationLayeringMigration,
  verificationProgressMigration,
  workspaceRetryMigration,
} from '@codeestra/storage';

/**
 * What this file proves: schema v31 (Session Guidance, ADR-0057) upgrades a **real file database**
 * already stamped v30 additively — every pre-existing row survives, the three new tables land, the
 * recorded version is the current one, and `PRAGMA foreign_key_check` is empty afterwards, so the new
 * foreign keys (`session_guidance → tasks/executions/agent_sessions/session_incarnations`,
 * `session_guidance_deliveries → session_guidance`, `execution_guidance_contexts → executions`) do not
 * leave the schema inconsistent.
 *
 * What it does NOT prove: that a database written by an older *build* of this lane upgrades — the
 * version numbers are the only compatibility claim made here, exactly as with the other migration
 * tests. Nothing here starts a Runtime or a provider.
 */

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-guidance-migration-'));
  created.push(directory);
  return join(directory, 'runtime.sqlite');
}

/** Every migration up to the one this lane owns, in the order the runner applies them. */
const migrationsBeforeV31: readonly string[] = [
  phase1Migration,
  agentStartMigration,
  agentObservationMigration,
  agentAnswerMigration,
  agentDisconnectMigration,
  taskVerificationMigration,
  workspaceRetryMigration,
  agentConfigurationMigration,
  taskControlMigration,
  integrationPipelineMigration,
  operationProgressMigration,
  reclamationMigration,
  stablePromotionMigration,
  sessionHandoffMigration,
  taskDependenciesMigration,
  verificationProgressMigration,
  sessionTerminalMigration,
  revisionDeliveryMigration,
  impactAnalysisMigration,
  capacitySlotReservationMigration,
  taskRetryMigration,
  unregisteredReclamationMigration,
  verificationLayeringMigration,
  knowledgeLayerMigration,
  agentPluginSelectionMigration,
  intentKindShrinkMigration,
  devClonePromotionMigration,
  integrationBatchTerminalStatesMigration,
];

function createRawDatabase(filename: string): Database {
  const database = new Database(filename, { create: true, strict: true });
  database.exec('PRAGMA foreign_keys=ON;');
  return database;
}

function seedProject(database: Database): void {
  database.query(`INSERT INTO projects
    (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
    VALUES ('p1','Project','/repo','/repo/.git','refs/heads/main','sha1',1)`).run();
  database.query(`INSERT INTO project_trusts
    (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
    VALUES ('trust1','p1','/repo','/repo/.git','sha1',1,'user','ACTIVE',1)`).run();
  database.transaction(() => {
    database.query(`INSERT INTO tasks
      (id,project_id,display_number,kind,current_revision_id,state,created_at,updated_at)
      VALUES ('t1','p1',1,'DEVELOPMENT','r1','READY',2,2)`).run();
    database.query(`INSERT INTO task_revisions
      (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
      VALUES ('r1','t1',1,NULL,'Do work','[]','user','initial',2)`).run();
  })();
}

describe('schema v31 session guidance migration', () => {
  test('appends additively to a v30 database and leaves the schema consistent', () => {
    const filename = temporaryDatabase();
    const legacy = createRawDatabase(filename);
    for (const migration of migrationsBeforeV31) legacy.exec(migration);
    legacy.exec('PRAGMA user_version=30');
    seedProject(legacy);
    legacy.close();

    const upgraded = new Phase1Database(filename);
    try {
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBe(31);
      expect(phase1SchemaVersion).toBeGreaterThanOrEqual(31);
      // Every pre-existing row is still there: this step only adds tables.
      expect(upgraded.sqlite.query<{ rows: number }, []>(
        'SELECT COUNT(*) AS rows FROM tasks').get()?.rows).toBe(1);
      expect(upgraded.sqlite.query<{ rows: number }, []>(
        'SELECT COUNT(*) AS rows FROM task_revisions').get()?.rows).toBe(1);
      for (const table of ['session_guidance', 'session_guidance_deliveries',
        'execution_guidance_contexts']) {
        expect(upgraded.sqlite.query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?1").get(table)?.name)
          .toBe(table);
      }
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toHaveLength(0);
      // The new tables are usable through the versioned face of the same database.
      expect(upgraded.listSessionGuidance('p1', 't1')).toHaveLength(0);
      expect(upgraded.listExecutionGuidanceContexts('p1', 't1')).toHaveLength(0);
      expect(upgraded.listInFlightSessionGuidanceDeliveries()).toHaveLength(0);
    } finally {
      upgraded.close();
    }
  });

  test('a database already stamped 31 opens without re-running the step', () => {
    const filename = temporaryDatabase();
    const first = new Phase1Database(filename);
    first.close();
    const reopened = new Phase1Database(filename);
    try {
      expect(reopened.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBe(31);
      expect(reopened.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toHaveLength(0);
    } finally {
      reopened.close();
    }
  });
});
