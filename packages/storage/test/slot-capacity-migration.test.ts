import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentAnswerMigration,
  agentConfigurationMigration,
  agentDisconnectMigration,
  agentObservationMigration,
  agentStartMigration,
  integrationPipelineMigration,
  operationProgressMigration,
  Phase1Database,
  phase1Migration,
  phase1SchemaVersion,
  reclamationMigration,
  revisionDeliveryMigration,
  sessionHandoffMigration,
  sessionTerminalMigration,
  stablePromotionMigration,
  taskControlMigration,
  taskDependenciesMigration,
  taskVerificationMigration,
  verificationProgressMigration,
  workspaceRetryMigration,
} from '../src/index.js';

/**
 * The additive upgrade to schema v21 (FOUNDATION-054 / ADR-0032).
 *
 * Two histories are checked on a real SQLite file, because both exist in the wild and only one of
 * them is "the" previous version:
 *
 * - **v20 → v21**: a database whose previous migration ran. Version 20 belongs to the parallel impact
 *   snapshot lane (E1) and is not part of this lane, so the history is built from the migrations that
 *   do exist and stamped 20 — the property under test is that this lane's step is *added* after the
 *   existing ascending steps and only uses its own number, so a database stamped 20 gets the capacity
 *   and slot tables.
 * - **v16 → v21**: the permanently unused version 16. A database stamped 16 must run every later
 *   step (17, 18, 19, 21); nothing may insert an `if (version < 16)` step, because a database that was
 *   already stamped 17–20 would skip it.
 *
 * Both are checked to be **additive**: the pre-existing rows and tables are still there afterwards.
 */

const oid = 'a'.repeat(40);

/** The migrations that exist in this lane, in ascending order, up to (but excluding) v21. */
const migrationsBeforeCapacity = [
  { version: 2, sql: agentStartMigration },
  { version: 3, sql: agentObservationMigration },
  { version: 4, sql: agentAnswerMigration },
  { version: 5, sql: agentDisconnectMigration },
  { version: 6, sql: taskVerificationMigration },
  { version: 7, sql: workspaceRetryMigration },
  { version: 8, sql: agentConfigurationMigration },
  { version: 9, sql: taskControlMigration },
  { version: 10, sql: integrationPipelineMigration },
  { version: 11, sql: operationProgressMigration },
  { version: 12, sql: reclamationMigration },
  { version: 13, sql: stablePromotionMigration },
  { version: 14, sql: sessionHandoffMigration },
  { version: 15, sql: taskDependenciesMigration },
  // Version 16 is intentionally absent: it is permanently unused.
  { version: 17, sql: verificationProgressMigration },
  { version: 18, sql: sessionTerminalMigration },
  { version: 19, sql: revisionDeliveryMigration },
];

function buildLegacyFile(filename: string, stamp: number, upToVersion: number): void {
  const legacy = new Database(filename, { create: true, strict: true });
  legacy.exec('PRAGMA foreign_keys=OFF;');
  legacy.exec(phase1Migration);
  for (const migration of migrationsBeforeCapacity) {
    if (migration.version <= upToVersion) legacy.exec(migration.sql);
  }
  legacy.query(`INSERT INTO projects
    (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
    VALUES ('legacy','Legacy','/legacy','/legacy/.git','refs/heads/main','sha1',1)`).run();
  legacy.query(`INSERT INTO project_trusts
    (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
    VALUES ('legacy-trust','legacy','/legacy','/legacy/.git','sha1',1,'user','ACTIVE',1)`).run();
  legacy.exec(`PRAGMA user_version=${stamp}`);
  legacy.close();
}

function withTemporaryFile(run: (filename: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-slot-migration-'));
  try {
    run(join(directory, 'runtime.sqlite'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const capacityTables = [
  'project_capacity_limits',
  'project_adapter_slot_limits',
  'execution_slot_reservations',
  'execution_slot_reservation_events',
];

function expectUpgradedToCapacitySchema(upgraded: Phase1Database): void {
  expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version)
    .toBe(phase1SchemaVersion);
  // Integration fix (Wave H / H3): later lanes add steps *after* this one (v23 is the Task-retry
  // step), so the claim is "this lane's step ran and the database reached the current version",
  // not "this lane is last". Pinning the number here made a legitimate append fail the suite.
  expect(phase1SchemaVersion).toBeGreaterThanOrEqual(21);
  const tables = upgraded.sqlite.query<{ name: string }, []>(`
    SELECT name FROM sqlite_master WHERE type='table'
      AND name IN ('project_capacity_limits','project_adapter_slot_limits',
        'execution_slot_reservations','execution_slot_reservation_events')
    ORDER BY name
  `).all().map((row) => row.name);
  expect(tables).toEqual([...capacityTables].sort());
  // Additive: the pre-existing row is still readable and the pre-existing tables are untouched.
  expect(upgraded.sqlite.query<{ id: string }, []>(
    "SELECT id FROM projects WHERE id='legacy'").get()?.id).toBe('legacy');
  expect(upgraded.sqlite.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_sessions'").get()?.name)
    .toBe('agent_sessions');
  expect(upgraded.sqlite.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='task_revision_deliveries'")
    .get()?.name).toBe('task_revision_deliveries');
  // The new tables are usable right away and start from the documented default capacity.
  expect(upgraded.getProjectCapacity('legacy')).toMatchObject({
    globalLimit: 2, globalLimitSource: 'DEFAULT',
  });
}

describe('capacity and slot reservation migration', () => {
  test('upgrades a version 20 database additively', () => {
    withTemporaryFile((filename) => {
      buildLegacyFile(filename, 20, 19);
      const upgraded = new Phase1Database(filename);
      try {
        expectUpgradedToCapacitySchema(upgraded);
      } finally { upgraded.close(); }
    });
  });

  test('upgrades a version 16 database by running every later step', () => {
    withTemporaryFile((filename) => {
      buildLegacyFile(filename, 16, 15);
      const upgraded = new Phase1Database(filename);
      try {
        // Reaching the current version from 16 proves the 17/18/19 steps ran too: their tables exist
        // and the verification progress table is the v17 one.
        expectUpgradedToCapacitySchema(upgraded);
        expect(upgraded.sqlite.query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='operation_progress_events'")
          .get()?.name).toBe('operation_progress_events');
      } finally { upgraded.close(); }
    });
  });

  test('a database stamped 21 is reopened without running any migration again', () => {
    withTemporaryFile((filename) => {
      const first = new Phase1Database(filename);
      first.sqlite.query(`INSERT INTO projects
        (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
        VALUES ('kept','Kept','/kept','/kept/.git','refs/heads/main','sha1',1)`).run();
      first.sqlite.query(`INSERT INTO project_trusts
        (id,project_id,repo_root,git_common_dir,object_format,policy_version,actor,status,accepted_at)
        VALUES ('kept-trust','kept','/kept','/kept/.git','sha1',1,'user','ACTIVE',1)`).run();
      first.setProjectGlobalCapacity({
        projectId: 'kept', limit: 5, commandId: crypto.randomUUID(), payloadHash: 'p',
        eventId: crypto.randomUUID(), actor: 'user', updatedAt: 2,
      });
      first.close();
      const reopened = new Phase1Database(filename);
      try {
        expect(reopened.getProjectCapacity('kept')).toMatchObject({
          globalLimit: 5, globalLimitSource: 'EXPLICIT',
        });
      } finally { reopened.close(); }
    });
  });

  test('the schema refuses a reservation state that has no release record', () => {
    withTemporaryFile((filename) => {
      const database = new Phase1Database(filename);
      try {
        database.sqlite.query(`INSERT INTO projects
          (id,name,repo_root,git_common_dir,main_ref,object_format,created_at)
          VALUES ('p','P','/p','/p/.git','refs/heads/main','sha1',1)`).run();
        database.sqlite.transaction(() => {
          database.sqlite.query(`INSERT INTO tasks
            (id,project_id,display_number,kind,current_revision_id,state,created_at,updated_at)
            VALUES ('t','p',1,'DEVELOPMENT','r','READY',1,1)`).run();
          database.sqlite.query(`INSERT INTO task_revisions
            (id,task_id,number,previous_revision_id,specification,constraints_json,actor,reason,created_at)
            VALUES ('r','t',1,NULL,'x','[]','u','i',1)`).run();
        })();
        // RELEASED without released_at/release_reason/release_kind is not a state the schema allows.
        expect(() => database.sqlite.query(`
          INSERT INTO execution_slot_reservations(id,project_id,task_id,revision_id,task_version,
            adapter_id,dependency_fingerprint,state,version,command_id,holder_boot_id,holder_pid,
            holder_actor,reserved_at,updated_at)
          VALUES ('x','p','t','r',0,'pi',?1,'RELEASED',0,'c','boot',1,'u',1,1)
        `).run(oid)).toThrow();
      } finally { database.close(); }
    });
  });
});
