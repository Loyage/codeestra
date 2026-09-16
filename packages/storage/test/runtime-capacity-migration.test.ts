import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Phase1Database,
  StorageError,
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
  resolveMigratedGlobalLimit,
  revisionDeliveryMigration,
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
} from '../src/index.js';

/**
 * The upgrade to schema v34 (FOUNDATION-096 / ADR-0061, first half).
 *
 * Everything here runs against a **real temporary file** database whose history was built by running
 * the v1…v33 chain, not by rewriting the current schema: the subject is what happens to a database
 * that already holds capacity configuration, reservations, Executions and event history when the
 * project-scoped limits are retired and `domain_events` is rebuilt.
 *
 * The version assertions are `phase1SchemaVersion`/`>= 34`, never "the current version is exactly
 * 34": later waves add steps after this one, and three earlier waves broke on that exact assertion.
 */

const oid = 'a'.repeat(40);

/** The exact v1…v33 chain, in `migrate()` order (v16 permanently unused, v22 unoccupied). */
const throughV33 = [
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
  sessionGuidanceMigration,
  taskRevisionFeaturesMigration,
  taskBaselineRefMigration,
];

interface LegacyOptions {
  /** `project_capacity_limits.global_limit`, when the fixture records one. */
  readonly projectLimit?: number;
  /** Per-Adapter overrides written into `project_adapter_slot_limits`. */
  readonly adapterLimits?: readonly (readonly [string, number])[];
}

/**
 * A genuine v33 database with one Project, one READY Task, one live reservation, one Execution that
 * still holds its resource, two historical events (one of them the retired
 * `SchedulerCapacityChanged`), one delivery row, and the legacy capacity configuration.
 */
function createLegacyV33Database(filename: string, options: LegacyOptions = {}): void {
  const legacy = new Database(filename, { create: true, strict: true });
  try {
    legacy.exec('PRAGMA foreign_keys=OFF;');
    for (const migration of throughV33) legacy.exec(migration);
    legacy.exec('PRAGMA user_version=33');
    legacy.exec('BEGIN');
    legacy.query(`INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,object_format,
      dev_ref,created_at)
      VALUES ('p1','demo','/tmp/demo','/tmp/demo/.git','refs/heads/main','sha1','refs/heads/dev',1)`)
      .run();
    legacy.query(`INSERT INTO project_trusts(id,project_id,repo_root,git_common_dir,object_format,
      policy_version,actor,status,accepted_at)
      VALUES ('trust1','p1','/tmp/demo','/tmp/demo/.git','sha1',1,'local-user','ACTIVE',1)`).run();
    legacy.query(`INSERT INTO tasks(id,project_id,display_number,kind,current_revision_id,state,
      version,created_at,updated_at)
      VALUES ('t1','p1',1,'DEVELOPMENT','r1','READY',0,1,1)`).run();
    legacy.query(`INSERT INTO task_revisions(id,task_id,number,previous_revision_id,specification,
      constraints_json,actor,reason,created_at)
      VALUES ('r1','t1',1,NULL,'do the work','[]','local-user','initial',1)`).run();
    legacy.query(`INSERT INTO workspaces(id,task_id,branch_ref,path,ownership_token,base_commit,
      state,created_at)
      VALUES ('w1','t1','refs/heads/task/t1','/tmp/demo/task-t1','owner-1',?1,'IN_USE',2)`)
      .run(oid);
    legacy.query(`INSERT INTO executions(id,task_id,attempt_number,initial_revision_id,
      applied_revision_id,workspace_id,adapter_id,adapter_version,state,resource_held,base_commit,
      started_at)
      VALUES ('e1','t1',1,'r1','r1','w1','pi','1','RUNNING',1,?1,3)`).run(oid);
    legacy.query(`INSERT INTO execution_slot_reservations(id,project_id,task_id,revision_id,
      task_version,adapter_id,dependency_fingerprint,state,version,command_id,holder_boot_id,
      holder_pid,holder_actor,reserved_at,updated_at)
      VALUES ('s1','p1','t1','r1',0,'pi','fingerprint','RESERVED',0,'slot-command','boot-1',7,
        'local-user',4,4)`).run();
    legacy.query(`INSERT INTO domain_events(event_id,project_id,event_type,schema_version,
      aggregate_type,aggregate_id,aggregate_version,correlation_id,occurred_at,payload_json)
      VALUES ('evt-capacity','p1','SchedulerCapacityChanged',1,'SchedulerCapacity','p1',1,
        'cap-command',5,'{"projectId":"p1","scope":"GLOBAL","adapterId":null,"from":2,"to":4}'),
             ('evt-reserved','p1','ExecutionSlotReserved',1,'ExecutionSlot','s1',1,
        'slot-command',6,'{"reservationId":"s1","taskId":"t1"}')`).run();
    legacy.query(`INSERT INTO event_deliveries(event_id,consumer_id,state,attempt_count)
      VALUES ('evt-capacity','probe','PENDING',0)`).run();
    if (options.projectLimit !== undefined) {
      legacy.query(`INSERT INTO project_capacity_limits(project_id,global_limit,version,updated_at,
        updated_by) VALUES ('p1',?1,0,7,'local-user')`).run(options.projectLimit);
    }
    for (const [adapterId, limit] of options.adapterLimits ?? []) {
      legacy.query(`INSERT INTO project_adapter_slot_limits(project_id,adapter_id,slot_limit,version,
        updated_at,updated_by) VALUES ('p1',?1,?2,0,8,'local-user')`).run(adapterId, limit);
    }
    legacy.exec('COMMIT');
  } finally {
    legacy.close();
  }
}

function withTemporaryFile(run: (filename: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-runtime-capacity-'));
  try {
    run(join(directory, 'runtime.sqlite'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function tableNames(database: Database): readonly string[] {
  return database.query<{ name: string }, []>(
    'SELECT name FROM sqlite_master WHERE type=\'table\' ORDER BY name').all()
    .map((row) => row.name);
}

describe('resolveMigratedGlobalLimit', () => {
  test('takes the minimum of every explicit legacy value and reports "no value" as null', () => {
    expect(resolveMigratedGlobalLimit([])).toBeNull();
    expect(resolveMigratedGlobalLimit([4])).toBe(4);
    expect(resolveMigratedGlobalLimit([4, 1, 3])).toBe(1);
    expect(resolveMigratedGlobalLimit([16, 2])).toBe(2);
  });
});

describe('schema v34: Runtime-wide capacity', () => {
  test('adopts the smallest explicit legacy value and retires the project-scoped tables', () => {
    withTemporaryFile((filename) => {
      createLegacyV33Database(filename, {
        projectLimit: 4, adapterLimits: [['pi', 1], ['codex', 3]],
      });
      const upgraded = new Phase1Database(filename);
      try {
        expect(phase1SchemaVersion).toBeGreaterThanOrEqual(34);
        expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version').get()
          ?.user_version).toBe(phase1SchemaVersion);
        // MIN(4, 1, 3) = 1: upgrading can only lower the ceiling, never raise the machine's load.
        expect(upgraded.getRuntimeCapacity()).toMatchObject({
          limit: 1, limitSource: 'EXPLICIT', updatedBy: 'schema-migration',
        });
        const tables = tableNames(upgraded.sqlite);
        expect(tables).toContain('runtime_capacity_settings');
        expect(tables).toContain('runtime_command_receipts');
        expect(tables).not.toContain('project_capacity_limits');
        expect(tables).not.toContain('project_adapter_slot_limits');
        // The reservation primitive and its ledger are untouched by this half.
        expect(tables).toContain('execution_slot_reservations');
        expect(tables).toContain('execution_slot_reservation_events');
        // The migration records the adopted value as a global fact that belongs to no Project.
        const adopted = upgraded.sqlite.query<{
          project_id: string | null; aggregate_type: string; payload_json: string;
        }, []>(`SELECT project_id,aggregate_type,payload_json FROM domain_events
          WHERE event_type='SchedulerGlobalCapacityChanged'`).get();
        expect(adopted?.project_id).toBeNull();
        expect(adopted?.aggregate_type).toBe('RuntimeSchedulerControl');
        expect(JSON.parse(adopted?.payload_json ?? '{}')).toMatchObject({
          from: null, to: 1, source: 'MIGRATED_MINIMUM', actor: 'schema-migration',
        });
        expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
          .toEqual([]);
      } finally { upgraded.close(); }
    });
  });

  test('with no explicit legacy value the documented default applies and no row is written', () => {
    withTemporaryFile((filename) => {
      createLegacyV33Database(filename);
      const upgraded = new Phase1Database(filename);
      try {
        expect(upgraded.getRuntimeCapacity()).toEqual({
          limit: 2, limitSource: 'DEFAULT', version: 0, updatedAt: null, updatedBy: null,
        });
        expect(upgraded.sqlite.query<{ rows: number }, []>(
          'SELECT COUNT(*) AS rows FROM runtime_capacity_settings').get()?.rows).toBe(0);
        // "The default applies" is not a change, so the migration adds no event for it.
        expect(upgraded.sqlite.query<{ rows: number }, []>(
          "SELECT COUNT(*) AS rows FROM domain_events WHERE event_type='SchedulerGlobalCapacityChanged'",
        ).get()?.rows).toBe(0);
      } finally { upgraded.close(); }
    });
  });

  test('keeps reservations, Executions, historical events and deliveries exactly as they were', () => {
    withTemporaryFile((filename) => {
      createLegacyV33Database(filename, { projectLimit: 2 });
      const upgraded = new Phase1Database(filename);
      try {
        expect(upgraded.sqlite.query<{ state: string; holder_pid: number }, []>(
          "SELECT state,holder_pid FROM execution_slot_reservations WHERE id='s1'").get())
          .toEqual({ state: 'RESERVED', holder_pid: 7 });
        expect(upgraded.sqlite.query<{ resource_held: number; state: string }, []>(
          "SELECT resource_held,state FROM executions WHERE id='e1'").get())
          .toEqual({ resource_held: 1, state: 'RUNNING' });
        // The historical project-scoped event is preserved byte for byte, including its project.
        const historical = upgraded.sqlite.query<{
          sequence: number; project_id: string | null; payload_json: string;
        }, []>("SELECT sequence,project_id,payload_json FROM domain_events WHERE event_id='evt-capacity'")
          .get();
        expect(historical?.project_id).toBe('p1');
        expect(historical?.sequence).toBe(1);
        expect(JSON.parse(historical?.payload_json ?? '{}')).toMatchObject({
          scope: 'GLOBAL', from: 2, to: 4,
        });
        expect(upgraded.sqlite.query<{ event_id: string; state: string }, []>(
          "SELECT event_id,state FROM event_deliveries WHERE consumer_id='probe'").get())
          .toEqual({ event_id: 'evt-capacity', state: 'PENDING' });
        // The per-Project report still reads the same numbers, now Runtime-wide.
        expect(upgraded.countActiveSlotOccupants().globalUsed).toBe(1);
      } finally { upgraded.close(); }
    });
  });

  test('the rebuilt event log keeps ordering and allocates the next sequence after the copy', () => {
    withTemporaryFile((filename) => {
      createLegacyV33Database(filename, { projectLimit: 2 });
      const upgraded = new Phase1Database(filename);
      try {
        const sequences = upgraded.sqlite.query<{ sequence: number; event_id: string }, []>(
          'SELECT sequence,event_id FROM domain_events ORDER BY sequence').all();
        expect(sequences.map((row) => row.sequence)).toEqual([1, 2, 3]);
        expect(sequences.map((row) => row.event_id))
          .toEqual(['evt-capacity', 'evt-reserved', expect.any(String)]);
        // A new fact must not reuse a sequence the copy already occupies: the AUTOINCREMENT state
        // has to survive the create → copy → drop → rename, not just the rows.
        upgraded.sqlite.query(`INSERT INTO domain_events(event_id,project_id,event_type,
          schema_version,aggregate_type,aggregate_id,aggregate_version,correlation_id,occurred_at,
          payload_json)
          VALUES ('evt-later','p1','TaskStateChanged',1,'Task','t1',2,'later',9,'{}')`).run();
        expect(upgraded.sqlite.query<{ sequence: number }, []>(
          "SELECT sequence FROM domain_events WHERE event_id='evt-later'").get()?.sequence)
          .toBeGreaterThan(3);
      } finally { upgraded.close(); }
    });
  });

  test('a global fact reaches a Project-filtered read and an unfiltered read, with no gap', () => {
    withTemporaryFile((filename) => {
      // No legacy limit: this fixture starts with exactly the two historical events, so the global
      // event under test is the only one added.
      createLegacyV33Database(filename);
      const upgraded = new Phase1Database(filename);
      try {
        // A Project-filtered subscription receives its own events *and* the global one (ADR-0061 D10),
        // in one sequence order, so a cursor taken anywhere resumes without a gap or a repeat.
        const filtered = upgraded.listEventsAfter({ sinceSequence: 0, limit: 50, projectId: 'p1' });
        expect(filtered.map((event) => event.eventId)).toEqual(['evt-capacity', 'evt-reserved']);
        upgraded.setRuntimeCapacityLimit({
          limit: 3, commandId: 'cmd', payloadHash: 'p', eventId: 'evt-global',
          actor: 'user', updatedAt: 12,
        });
        const after = upgraded.listEventsAfter({ sinceSequence: 1, limit: 50, projectId: 'p1' });
        expect(after.map((event) => event.eventId)).toEqual(['evt-reserved', 'evt-global']);
        expect(after[1]?.projectId).toBeNull();
        const unfiltered = upgraded.listEventsAfter({ sinceSequence: 0, limit: 50 });
        expect(unfiltered.map((event) => event.eventId))
          .toEqual(['evt-capacity', 'evt-reserved', 'evt-global']);
      } finally { upgraded.close(); }
    });
  });

  test('a legacy value outside 1-16 refuses the upgrade and leaves the old database untouched', () => {
    withTemporaryFile((filename) => {
      // 99 can only exist in a hand-edited database (the command face refused it), which is exactly
      // why the migration must not silently clamp it or lose it: it stops with a named reason.
      createLegacyV33Database(filename, { projectLimit: 99, adapterLimits: [['pi', 3]] });
      let failure: unknown = null;
      try {
        new Phase1Database(filename);
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(StorageError);
      expect((failure as StorageError).code).toBe('INVALID_STATE');
      expect((failure as Error).message).toContain('99');

      const untouched = new Database(filename, { create: true, strict: true });
      try {
        expect(untouched.query<{ user_version: number }, []>('PRAGMA user_version').get()
          ?.user_version).toBe(33);
        // Nothing was dropped and no value was lost: the whole step rolled back as one transaction.
        expect(tableNames(untouched)).toContain('project_capacity_limits');
        expect(tableNames(untouched)).toContain('project_adapter_slot_limits');
        expect(tableNames(untouched)).not.toContain('runtime_capacity_settings');
        expect(untouched.query<{ global_limit: number }, []>(
          "SELECT global_limit FROM project_capacity_limits WHERE project_id='p1'").get())
          .toEqual({ global_limit: 99 });
        expect(untouched.query<{ slot_limit: number }, []>(
          "SELECT slot_limit FROM project_adapter_slot_limits WHERE adapter_id='pi'").get())
          .toEqual({ slot_limit: 3 });
        expect(untouched.query<{ rows: number }, []>(
          'SELECT COUNT(*) AS rows FROM domain_events').get()?.rows).toBe(2);
      } finally { untouched.close(); }
    });
  });

  test('a step failure after the retired tables were dropped rolls the whole step back', () => {
    withTemporaryFile((filename) => {
      createLegacyV33Database(filename, { projectLimit: 4, adapterLimits: [['pi', 1]] });
      // Occupy the index name the rebuild creates *after* the two legacy DROPs. The `CREATE INDEX`
      // then fails with the old tables already dropped and the value already read out of them — the
      // one ordering that would lose the configuration if the step were not a single transaction.
      const probe = new Database(filename, { create: true, strict: true });
      probe.exec(`
        DROP INDEX event_aggregate;
        CREATE TABLE index_name_probe(x INTEGER);
        CREATE INDEX event_aggregate ON index_name_probe(x);
      `);
      probe.close();

      let failure: unknown = null;
      try {
        new Phase1Database(filename);
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('event_aggregate');

      const untouched = new Database(filename, { create: true, strict: true });
      try {
        expect(untouched.query<{ user_version: number }, []>('PRAGMA user_version').get()
          ?.user_version).toBe(33);
        const tables = tableNames(untouched);
        // Every DDL statement of the step was rolled back, including the DROPs.
        expect(tables).toContain('project_capacity_limits');
        expect(tables).toContain('project_adapter_slot_limits');
        expect(tables).not.toContain('runtime_capacity_settings');
        expect(tables).not.toContain('runtime_command_receipts');
        expect(tables).not.toContain('domain_events_v34');
        // The values that were about to be adopted are still there, and no history was lost.
        expect(untouched.query<{ global_limit: number }, []>(
          "SELECT global_limit FROM project_capacity_limits WHERE project_id='p1'").get())
          .toEqual({ global_limit: 4 });
        expect(untouched.query<{ slot_limit: number }, []>(
          "SELECT slot_limit FROM project_adapter_slot_limits WHERE adapter_id='pi'").get())
          .toEqual({ slot_limit: 1 });
        expect(untouched.query<{ rows: number }, []>(
          'SELECT COUNT(*) AS rows FROM domain_events').get()?.rows).toBe(2);
        expect(untouched.query<{ rows: number }, []>(
          'SELECT COUNT(*) AS rows FROM execution_slot_reservations').get()?.rows).toBe(1);
      } finally { untouched.close(); }
    });
  });
});
