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
  runtimeGlobalCapacityMigration,
  runtimePauseControlMigration,
  sessionGuidanceMigration,
  sessionHandoffMigration,
  sessionTerminalMigration,
  stablePromotionMigration,
  taskBaselineRefMigration,
  taskControlMigration,
  taskDependenciesMigration,
  taskInputFieldsMigration,
  taskRetryMigration,
  taskRevisionFeaturesMigration,
  taskVerificationMigration,
  unregisteredReclamationMigration,
  verificationLayeringMigration,
  verificationProgressMigration,
  workspaceRetryMigration,
} from '@codeestra/storage';

/**
 * Schema v35 (ADR-0065): the Task-level titles, and the deletion of `tasks.kind` /
 * `task_revisions.constraints_json`.
 *
 * Everything below builds a **real version 34 database** by applying the migrations that existed at
 * v34 and stamping `user_version=34`, then lets the current code upgrade that file. That is the only
 * shape in which "the upgrade works on a database that predates it" is a fact: a test that starts
 * from the current schema and walks the version number backwards is a simulation.
 *
 * The version assertion is `>= 35`, never `== 35`: later lanes keep appending to the same counter.
 */

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Every step that existed when the schema was stamped 34, in the order the runner applies them. */
const throughV34 = [
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
  runtimeGlobalCapacityMigration, runtimePauseControlMigration,
];

function temporaryFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codeestra-v35-'));
  temporaryDirectories.push(directory);
  return join(directory, 'runtime.sqlite');
}

function version(database: Database): number {
  return database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
}

function columns(database: Database, table: string): readonly string[] {
  return database.query<{ name: string }, []>(`PRAGMA table_info('${table}')`).all()
    .map((column) => column.name);
}

/**
 * A real v34 file database holding the shapes the rebuild must not lose: two Tasks with their
 * revisions, a constraint-bearing revision, a workspace and an execution that reference the Task (a
 * rebuild that dropped the parent rows would leave those children orphaned), and an
 * `ADD_CONSTRAINT` intent, which v35 must **keep** rather than rewrite (ADR-0065 D05).
 */
function buildV34Database(filename: string): void {
  const legacy = new Database(filename, { create: true, strict: true });
  legacy.exec('PRAGMA foreign_keys=OFF;');
  for (const migration of throughV34) legacy.exec(migration);
  legacy.exec('PRAGMA foreign_keys=ON;');
  legacy.query(`INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,dev_ref,object_format,
    policy_version,created_at) VALUES ('p1','Legacy','/tmp/legacy','/tmp/legacy/.git',
    'refs/heads/main','refs/heads/dev','sha1',1,7)`).run();
  legacy.query(`INSERT INTO project_trusts(id,project_id,repo_root,git_common_dir,object_format,
    policy_version,actor,status,accepted_at) VALUES ('trust1','p1','/tmp/legacy','/tmp/legacy/.git',
    'sha1',1,'user','ACTIVE',7)`).run();
  legacy.transaction(() => {
    // The first line is the derived display title.
    legacy.query(`INSERT INTO tasks(id,project_id,display_number,kind,current_revision_id,state,
      created_at,updated_at) VALUES ('t1','p1',1,'DEVELOPMENT','r1','READY',8,8)`).run();
    legacy.query(`INSERT INTO task_revisions(id,task_id,number,previous_revision_id,specification,
      constraints_json,actor,reason,created_at)
      VALUES ('r1','t1',1,NULL,'First line of the detail\nsecond line',
        '[{"id":"c1","text":"keep main clean"}]','user','initial',8)`).run();
    // A detail whose first line is blank: the whole detail is folded onto one line.
    legacy.query(`INSERT INTO tasks(id,project_id,display_number,kind,current_revision_id,state,
      created_at,updated_at) VALUES ('t2','p1',2,'DEVELOPMENT','r2','READY',9,9)`).run();
    legacy.query(`INSERT INTO task_revisions(id,task_id,number,previous_revision_id,specification,
      constraints_json,actor,reason,created_at)
      VALUES ('r2','t2',1,NULL,'\n   \nOnly real content\nand a second line','[]','user','initial',9)`).run();
    // A CRLF first line: one-argument `trim()` would leave the carriage return in the title.
    legacy.query(`INSERT INTO tasks(id,project_id,display_number,kind,current_revision_id,state,
      created_at,updated_at) VALUES ('t3','p1',3,'DEVELOPMENT','r3','READY',10,10)`).run();
    legacy.query(`INSERT INTO task_revisions(id,task_id,number,previous_revision_id,specification,
      constraints_json,actor,reason,created_at)
      VALUES ('r3','t3',1,NULL,'CRLF first line\r\nsecond line','[]','user','initial',10)`).run();
  })();
  legacy.query(`INSERT INTO workspaces(id,task_id,branch_ref,path,ownership_token,base_commit,state,
    created_at) VALUES ('w1','t1','refs/heads/task/t1','/work/t1','owner-1','aaa','RETAINED',10)`).run();
  legacy.query(`INSERT INTO executions(id,task_id,attempt_number,initial_revision_id,
    applied_revision_id,workspace_id,adapter_id,adapter_version,state,resource_held,base_commit,
    result_commit,started_at,ended_at)
    VALUES ('e1','t1',1,'r1','r1','w1','pi','1','SUCCEEDED',0,'aaa','bbb',11,12)`).run();
  // A real recorded classification the upgrade must not rewrite.
  legacy.query(`INSERT INTO intents(id,project_id,idempotency_key,raw_text,kind,status,actor,
    created_at) VALUES ('i1','p1','k1','add one more constraint','ADD_CONSTRAINT','APPLIED','user',13)`).run();
  legacy.query(`INSERT INTO intent_targets(intent_id,task_id) VALUES ('i1','t1')`).run();
  legacy.exec('PRAGMA user_version=34');
  expect(version(legacy)).toBe(34);
  legacy.close();
}

describe('schema v35 Task input fields (ADR-0065)', () => {
  test('the step rebuilds both tables and touches no intent classification', () => {
    expect(phase1SchemaVersion).toBeGreaterThanOrEqual(35);
    expect(taskInputFieldsMigration).toContain('display_title');
    expect(taskInputFieldsMigration).toContain('naming_title');
    expect(taskInputFieldsMigration).not.toContain('kind TEXT NOT NULL');
    expect(taskInputFieldsMigration).not.toContain('constraints_json');
    // Historical intent rows keep their kind: no `intents` rebuild, no rewritten classification.
    // (The script still references the table through `task_revisions.source_intent_id`.)
    expect(taskInputFieldsMigration).not.toContain('DROP TABLE intents');
    expect(taskInputFieldsMigration).not.toContain('CREATE TABLE intents');
    expect(taskInputFieldsMigration).not.toContain('ADD_CONSTRAINT');
    // The append-only triggers of a rebuilt table must be recreated with it.
    expect(taskInputFieldsMigration).toContain('task_revisions_no_update');
    expect(taskInputFieldsMigration).toContain('task_revisions_no_delete');
  });

  test('a version 34 file database upgrades in place, deriving titles and keeping every row', () => {
    const filename = temporaryFile();
    buildV34Database(filename);

    const upgraded = new Phase1Database(filename);
    expect(version(upgraded.sqlite)).toBeGreaterThanOrEqual(35);
    // The two new columns exist and the two removed ones are gone.
    expect(columns(upgraded.sqlite, 'tasks')).toContain('display_title');
    expect(columns(upgraded.sqlite, 'tasks')).toContain('naming_title');
    expect(columns(upgraded.sqlite, 'tasks')).not.toContain('kind');
    expect(columns(upgraded.sqlite, 'task_revisions')).not.toContain('constraints_json');

    // The display title is the first line of the current revision, whitespace-trimmed; a blank first
    // line falls back to the whole detail folded onto one line, and no name is invented for the
    // naming title.
    expect(upgraded.sqlite.query<{ id: string; display_title: string; naming_title: string | null }, []>(
      'SELECT id,display_title,naming_title FROM tasks ORDER BY display_number').all()).toEqual([
      { id: 't1', display_title: 'First line of the detail', naming_title: null },
      { id: 't2', display_title: 'Only real content and a second line', naming_title: null },
      { id: 't3', display_title: 'CRLF first line', naming_title: null },
    ]);
    // Every revision body survives byte-for-byte, including the constraints-bearing one.
    expect(upgraded.sqlite.query<{ id: string; specification: string }, []>(
      'SELECT id,specification FROM task_revisions ORDER BY id').all()).toEqual([
      { id: 'r1', specification: 'First line of the detail\nsecond line' },
      { id: 'r2', specification: '\n   \nOnly real content\nand a second line' },
      { id: 'r3', specification: 'CRLF first line\r\nsecond line' },
    ]);
    // The children of the rebuilt tables are still attached to the same Tasks.
    expect(upgraded.sqlite.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM workspaces').get()?.count).toBe(1);
    expect(upgraded.sqlite.query<{ count: number }, []>(
      'SELECT COUNT(*) AS count FROM executions').get()?.count).toBe(1);
    expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
      .toEqual([]);

    // History is not rewritten: the recorded classification is still the one the user produced.
    expect(upgraded.sqlite.query<{ kind: string }, []>('SELECT kind FROM intents').all())
      .toEqual([{ kind: 'ADD_CONSTRAINT' }]);

    // The append-only triggers survived the rebuild: a revision is still immutable.
    expect(upgraded.sqlite.query<{ name: string }, []>(`
      SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='task_revisions'
      ORDER BY name`).all().map((row) => row.name))
      .toEqual(['task_revisions_no_delete', 'task_revisions_no_update']);
    expect(() => upgraded.sqlite.query(
      "UPDATE task_revisions SET reason='rewritten' WHERE id='r1'").run())
      .toThrow(/append-only/u);
    expect(() => upgraded.sqlite.query("DELETE FROM task_revisions WHERE id='r1'").run())
      .toThrow(/append-only/u);

    // The upgraded database is usable by the current writers and readers.
    expect(upgraded.getTask('p1', 't1')).toMatchObject({
      displayTitle: 'First line of the detail', namingTitle: null,
    });
    expect(upgraded.listTaskRevisions('p1', 't1')[0]?.specification)
      .toBe('First line of the detail\nsecond line');
    const created = upgraded.createTask({
      projectId: 'p1', commandId: 'c1', payloadHash: 'h1', intentId: 'i2', taskId: 't-new',
      revisionId: 'r-new', intentEventId: 'ie1', taskEventId: 'te1',
      displayTitle: 'A Task created after the upgrade', namingTitle: 'after-the-upgrade',
      specification: 'Detail', actor: 'user', createdAt: 20,
    });
    expect(created).toMatchObject({
      displayNumber: 4, displayTitle: 'A Task created after the upgrade',
      namingTitle: 'after-the-upgrade',
    });
    upgraded.close();
  });

  test('refuses a database whose Task detail has no title-able content, and changes nothing', () => {
    const filename = temporaryFile();
    buildV34Database(filename);
    const legacy = new Database(filename, { create: true, strict: true });
    legacy.exec('PRAGMA foreign_keys=ON;');
    legacy.transaction(() => {
      legacy.query(`INSERT INTO tasks(id,project_id,display_number,kind,current_revision_id,state,
        created_at,updated_at) VALUES ('t4','p1',4,'DEVELOPMENT','r4','READY',11,11)`).run();
      // The old CHECK only required a non-space character, so a newline-only detail was storable.
      legacy.query(`INSERT INTO task_revisions(id,task_id,number,previous_revision_id,specification,
        constraints_json,actor,reason,created_at)
        VALUES ('r4','t4',1,NULL,'\n  \t ','[]','user','initial',11)`).run();
    })();
    legacy.exec('PRAGMA user_version=34');
    legacy.close();

    expect(() => new Phase1Database(filename)).toThrow(/no non-whitespace character/u);
    // The refusal is up front and leaves the file alone: still v34, still with its old columns.
    const untouched = new Database(filename, { create: true, strict: true });
    expect(version(untouched)).toBe(34);
    expect(columns(untouched, 'tasks')).toContain('kind');
    expect(columns(untouched, 'task_revisions')).toContain('constraints_json');
    expect(untouched.query<{ rows: number }, []>('SELECT COUNT(*) AS rows FROM tasks').get()?.rows)
      .toBe(4);
    untouched.close();
  });

  test('refuses a naming title the database CHECK does not accept', () => {
    const upgraded = new Phase1Database();
    try {
      upgraded.sqlite.query(`INSERT INTO projects(id,name,repo_root,git_common_dir,
        main_ref,object_format,policy_version,created_at)
        VALUES ('p1','P','/r','/r/.git','refs/heads/main','sha1',1,1)`).run();
      upgraded.sqlite.query(`INSERT INTO project_trusts(id,project_id,repo_root,git_common_dir,
        object_format,policy_version,actor,status,accepted_at)
        VALUES ('trust1','p1','/r','/r/.git','sha1',1,'user','ACTIVE',1)`).run();
      // The task and its revision are written in one transaction because the FK between them is
      // deferred; that way a refusal can only come from the naming-title CHECK, not from the FK.
      let next = 0;
      const insert = (namingTitle: string): void => {
        next += 1;
        const taskId = `t-${next}`;
        upgraded.sqlite.transaction(() => {
          upgraded.sqlite.query(`INSERT INTO tasks(id,project_id,display_number,display_title,
            naming_title,current_revision_id,state,created_at,updated_at)
            VALUES (?1,'p1',?2,'Display',?3,?4,'DRAFT',1,1)`)
            .run(taskId, next, namingTitle, `r-${next}`);
          upgraded.sqlite.query(`INSERT INTO task_revisions(id,task_id,number,previous_revision_id,
            specification,actor,reason,created_at)
            VALUES (?1,?2,1,NULL,'Detail','user','initial',1)`).run(`r-${next}`, taskId);
        })();
      };
      // The column keeps the same shape the contract enforces, so a row edited outside the Runtime
      // cannot become a branch name or a directory name the product would never produce.
      expect(() => insert('valid-name')).not.toThrow();
      for (const namingTitle of ['Upper', 'with space', '-leading', 'trailing-', 'double--dash',
        '1digit', 'a'.repeat(51)]) {
        expect(() => insert(namingTitle)).toThrow();
      }
    } finally {
      upgraded.close();
    }
  });
});
