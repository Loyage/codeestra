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
  domainEventsGlobalProjectMigration,
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
  runtimePauseControlMigration,
  sessionGuidanceMigration,
  sessionHandoffMigration,
  sessionTerminalMigration,
  stablePromotionMigration,
  taskBaselineRefMigration,
  taskControlMigration,
  taskDependenciesMigration,
  taskRetryMigration,
  taskRevisionFeaturesMigration,
  taskVerificationMigration,
  unregisteredReclamationMigration,
  verificationLayeringMigration,
  verificationProgressMigration,
  workspaceRetryMigration,
} from '@codeestra/storage';
/**
 * Schema v34, the pause half (FOUNDATION-097 / ADR-0061 D10).
 *
 * Everything below builds a **real version 33 database** by applying the migrations that existed at
 * v33 and stamping `user_version=33`, then lets the current code upgrade that file. That is the only
 * shape in which "the upgrade works on a database that predates it" is a fact: a test that starts
 * from the current schema and walks the version number backwards is a simulation, and this file
 * deliberately avoids it.
 *
 * The version assertion is `>= 34`, never `== 34`: the other half of schema v34 is being written on a
 * parallel branch, and a test that pinned the number would break the moment the two are integrated.
 */

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Every step that existed when the schema was stamped 33, in the order the runner applies them. */
const throughV33 = [
  phase1Migration, agentStartMigration, agentObservationMigration, agentAnswerMigration,
  agentDisconnectMigration, taskVerificationMigration, workspaceRetryMigration,
  agentConfigurationMigration, taskControlMigration, integrationPipelineMigration,
  operationProgressMigration, reclamationMigration, stablePromotionMigration,
  sessionHandoffMigration, taskDependenciesMigration, verificationProgressMigration,
  sessionTerminalMigration, revisionDeliveryMigration, impactAnalysisMigration,
  capacitySlotReservationMigration, taskRetryMigration, unregisteredReclamationMigration,
  verificationLayeringMigration, knowledgeLayerMigration, agentPluginSelectionMigration,
  intentKindShrinkMigration, devClonePromotionMigration, sessionGuidanceMigration,
  taskRevisionFeaturesMigration, taskBaselineRefMigration, integrationBatchTerminalStatesMigration,
];

function temporaryFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-glc2-v33-'));
  temporaryDirectories.push(directory);
  return join(directory, 'runtime.sqlite');
}

function version(database: Database): number {
  return database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
}

function columns(database: Database, table: string): readonly { name: string; notnull: number }[] {
  return database.query<{ name: string; notnull: number }, []>(`PRAGMA table_info('${table}')`).all();
}

/**
 * A real v33 file database with one Project and one delivered event in it. The event matters: the
 * v34 step rebuilds `domain_events` to make `project_id` nullable, and a rebuild is exactly the kind
 * of change that can lose history.
 */
function buildV33Database(filename: string): void {
  const legacy = new Database(filename, { create: true, strict: true });
  legacy.exec('PRAGMA foreign_keys=OFF;');
  for (const migration of throughV33) legacy.exec(migration);
  legacy.exec('PRAGMA foreign_keys=ON;');
  legacy.query(`INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,dev_ref,object_format,
    policy_version,created_at) VALUES ('p1','Legacy','/tmp/legacy','/tmp/legacy/.git',
    'refs/heads/main','refs/heads/dev','sha1',1,7)`).run();
  legacy.query(`INSERT INTO domain_events(event_id,project_id,event_type,schema_version,aggregate_type,
    aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,payload_json)
    VALUES ('e1','p1','TaskCreated',1,'Task','t1',1,'c1',NULL,8,'{"taskId":"t1"}')`).run();
  legacy.query(`INSERT INTO event_deliveries(event_id,consumer_id,state,attempt_count,next_attempt_at,
    last_error) VALUES ('e1','c1','PENDING',0,NULL,NULL)`).run();
  legacy.exec('PRAGMA user_version=33');
  expect(version(legacy)).toBe(33);
  legacy.close();
}

describe('schema v34 pause half', () => {
  test('the migration belongs to this step and creates the Runtime-global control tables', () => {
    expect(phase1SchemaVersion).toBeGreaterThanOrEqual(34);
    expect(runtimePauseControlMigration).toContain('runtime_pause_control');
    expect(runtimePauseControlMigration).toContain('runtime_pause_targets');
    expect(runtimePauseControlMigration).toContain('runtime_command_receipts');
    // The five business IDs on a target are an identity snapshot, so the rebuild-free table must not
    // grow a foreign key to the business aggregates: a purged Task must not delete this epoch's fact.
    expect(runtimePauseControlMigration).not.toContain('REFERENCES');
    expect(domainEventsGlobalProjectMigration).toContain('domain_events_v34');
    expect(domainEventsGlobalProjectMigration).toContain('project_id TEXT REFERENCES projects(id)');
  });

  test('a version 33 file database upgrades in place, keeps its events and makes project_id nullable', () => {
    const filename = temporaryFile();
    buildV33Database(filename);

    const upgraded = new Phase1Database(filename);
    expect(version(upgraded.sqlite)).toBeGreaterThanOrEqual(34);
    // A fresh v34 database always has the singleton control row, so "no row" can never be read as
    // "continue": the only state a new database can be in is RUNNING with epoch 0.
    expect(upgraded.getRuntimePauseControl()).toMatchObject({
      state: 'RUNNING', pauseEpoch: 0, version: 0, requestedAt: null, settledAt: null,
    });
    expect(upgraded.sqlite.query<{ name: string }, []>(`
      SELECT name FROM sqlite_master WHERE type='table'
      AND name IN ('runtime_pause_control','runtime_pause_targets','runtime_command_receipts')
      ORDER BY name`).all().map((row) => row.name)).toEqual([
      'runtime_command_receipts', 'runtime_pause_control', 'runtime_pause_targets',
    ]);

    // The history is intact, including the delivered marker row that references it.
    expect(upgraded.sqlite.query<{ event_id: string; project_id: string | null; payload_json: string },
      []>('SELECT event_id,project_id,payload_json FROM domain_events').all())
      .toEqual([{ event_id: 'e1', project_id: 'p1', payload_json: '{"taskId":"t1"}' }]);
    expect(upgraded.sqlite.query<{ rows: number }, []>(
      'SELECT COUNT(*) AS rows FROM event_deliveries').get()?.rows).toBe(1);
    expect(columns(upgraded.sqlite, 'domain_events')
      .find((column) => column.name === 'project_id')?.notnull).toBe(0);
    expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
      .toEqual([]);

    // The new meaning is usable, and a Project-filtered read receives the global fact too (ADR-0061
    // D10: global capacity and pause affect every Project, so a project subscriber gets them).
    upgraded.sqlite.query(`INSERT INTO domain_events(event_id,project_id,event_type,schema_version,
      aggregate_type,aggregate_id,aggregate_version,correlation_id,causation_id,occurred_at,
      payload_json) VALUES ('e2',NULL,'SchedulerGlobalPaused',1,'RuntimeSchedulerControl',
      'runtime-global-control',1,'c2',NULL,9,'{"pauseEpoch":1}')`).run();
    expect(upgraded.listEventsAfter({ sinceSequence: 0, limit: 10, projectId: 'p1' })
      .map((event) => event.eventId)).toEqual(['e1', 'e2']);
    // A Project that is not the global one also receives it; a read without a filter is unchanged.
    expect(upgraded.listEventsAfter({ sinceSequence: 0, limit: 10, projectId: 'other' })
      .map((event) => event.eventId)).toEqual(['e2']);
    expect(upgraded.listEventsAfter({ sinceSequence: 0, limit: 10 }).map((event) => event.eventId))
      .toEqual(['e1', 'e2']);
    // The sequence keeps advancing as one cursor, so a subscriber that reconnects repeats nothing.
    expect(upgraded.listEventsAfter({ sinceSequence: 1, limit: 10 }).map((event) => event.sequence))
      .toEqual([2]);
    upgraded.close();
  });

  test('a failure inside the step rolls the whole upgrade back and leaves the v33 file untouched', () => {
    const filename = temporaryFile();
    buildV33Database(filename);

    // Injection: a table already named `domain_events_v34`, with the wrong shape. This lands in the
    // window the row-count guard exists for, and it is worth spelling out why: Bun's `exec()` swallows
    // a *step-time* error inside a multi-statement script, so with this injected every statement fails
    // quietly in order — the `CREATE TABLE` and the `INSERT ... SELECT` do nothing, the
    // `DROP TABLE domain_events` **really deletes the event log**, the `RENAME` promotes the wrong
    // table, and the `CREATE INDEX` fails. Without the row-count guard and the end-state assertions in
    // `migrate()`, the upgrade would "succeed" with the history gone. With them it is a rollback.
    const injected = new Database(filename, { create: true, strict: true });
    injected.exec('CREATE TABLE domain_events_v34(x INTEGER) STRICT;');
    injected.close();

    expect(() => new Phase1Database(filename)).toThrow(/domain_events/);
    const after = new Database(filename, { create: true, strict: true });
    expect(version(after)).toBe(33);
    // Nothing this step created survives, and the event log is exactly as it was — including the
    // index the rebuild replaces, which proves the rollback really undid the `DROP TABLE`.
    expect(after.query<{ rows: number }, []>(`
      SELECT COUNT(*) AS rows FROM sqlite_master WHERE name IN
        ('runtime_pause_control','runtime_pause_targets','runtime_command_receipts')`).get()?.rows)
      .toBe(0);
    expect(after.query<{ rows: number }, []>(`
      SELECT COUNT(*) AS rows FROM sqlite_master WHERE name='event_aggregate' AND type='index'`)
      .get()?.rows).toBe(1);
    expect(after.query<{ event_id: string; project_id: string | null }, []>(
      'SELECT event_id,project_id FROM domain_events').all())
      .toEqual([{ event_id: 'e1', project_id: 'p1' }]);
    expect(after.query<{ rows: number }, []>(
      'SELECT COUNT(*) AS rows FROM event_deliveries').get()?.rows).toBe(1);
    expect(columns(after, 'domain_events').find((column) => column.name === 'project_id')?.notnull)
      .toBe(1);
    after.close();
  });
});
