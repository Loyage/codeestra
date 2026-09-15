/**
 * `intents.kind` shrinks to the five producible kinds (FOUNDATION-075 / ADR-0046, schema v28).
 *
 * Three things are asserted against a real temporary file database rather than a memory one, because
 * the whole point of v28 is what happens to an *existing* database:
 *
 * 1. a genuine v27 database (built by running the v1…v27 chain, not by rewriting the current schema)
 *    upgrades in place, keeps every row of `intents` and of the three tables that reference it, and
 *    still enforces all three foreign keys;
 * 2. a database that still holds a removed kind (`CHANGE_PRIORITY` / `SELF_MODIFICATION`) is refused
 *    with a named reason and is left exactly as it was — never silently emptied or rewritten;
 * 3. `ANSWER_AGENT` is still writable, through the product path that needs it
 *    (`Phase1Database.planAttentionAnswer`), because removing it would break Attention answering.
 *
 * The version assertion is `>= 28` or the migration constant itself — never "the current version is
 * exactly 28" (three earlier waves broke on that exact assertion after a merge added a later step).
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Phase1Database, StorageError, agentAnswerMigration, agentConfigurationMigration,
  agentDisconnectMigration, agentObservationMigration, agentPluginSelectionMigration,
  agentStartMigration, assertIntentKind, capacitySlotReservationMigration, impactAnalysisMigration,
  integrationPipelineMigration, intentKindShrinkMigration, intentKinds, knowledgeLayerMigration,
  operationProgressMigration, phase1Migration, phase1SchemaVersion, reclamationMigration,
  revisionDeliveryMigration, sessionHandoffMigration, sessionTerminalMigration,
  stablePromotionMigration, taskControlMigration, taskDependenciesMigration, taskRetryMigration,
  taskVerificationMigration, unregisteredReclamationMigration, verificationLayeringMigration,
  verificationProgressMigration, workspaceRetryMigration,
} from '../src/index.js';

/** The exact v1…v27 chain, in `migrate()` order (v16 permanently unused, v22 unoccupied). */
const throughV27 = [
  phase1Migration, agentStartMigration, agentObservationMigration, agentAnswerMigration,
  agentDisconnectMigration, taskVerificationMigration, workspaceRetryMigration,
  agentConfigurationMigration, taskControlMigration, integrationPipelineMigration,
  operationProgressMigration, reclamationMigration, stablePromotionMigration,
  sessionHandoffMigration, taskDependenciesMigration, verificationProgressMigration,
  sessionTerminalMigration, revisionDeliveryMigration, impactAnalysisMigration,
  capacitySlotReservationMigration, taskRetryMigration, unregisteredReclamationMigration,
  verificationLayeringMigration, knowledgeLayerMigration, agentPluginSelectionMigration,
];

/**
 * A valid v27 database with one row in `intents` and one row in each of the three tables that
 * reference it. It is built with foreign keys ON inside one transaction, so the fixture itself is a
 * database that could have come from the product: a vacuous fixture would make the post-upgrade
 * `PRAGMA foreign_key_check` meaningless.
 */
function createLegacyV27Database(filename: string): void {
  const legacy = new Database(filename, { create: true, strict: true });
  try {
    legacy.exec('PRAGMA foreign_keys=ON;');
    for (const migration of throughV27) legacy.exec(migration);
    legacy.exec('PRAGMA user_version=27');
    legacy.exec('BEGIN');
    legacy.query(`INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,object_format,
      policy_version,dev_ref,created_at)
      VALUES ('p1','demo','/tmp/demo','/tmp/demo/.git','refs/heads/main','sha1',1,
        'refs/heads/dev',1)`).run();
    legacy.query(`INSERT INTO project_trusts(id,project_id,repo_root,git_common_dir,object_format,
      policy_version,actor,status,accepted_at)
      VALUES ('trust1','p1','/tmp/demo','/tmp/demo/.git','sha1',1,'local-user','ACTIVE',1)`).run();
    legacy.query(`INSERT INTO intents(id,project_id,idempotency_key,raw_text,kind,status,actor,
      created_at)
      VALUES ('i-create','p1','cmd-create','build the thing','CREATE_TASK','APPLIED','local-user',1),
             ('i-answer','p1','cmd-answer','{"type":"CONFIRM"}','ANSWER_AGENT','APPLIED',
               'local-user',2)`).run();
    legacy.query(`INSERT INTO tasks(id,project_id,display_number,kind,current_revision_id,state,
      priority,version,created_at,updated_at)
      VALUES ('t1','p1',1,'DEVELOPMENT','r1','WAITING_FOR_USER',0,0,1,1)`).run();
    legacy.query(`INSERT INTO task_revisions(id,task_id,number,previous_revision_id,specification,
      constraints_json,source_intent_id,actor,reason,created_at)
      VALUES ('r1','t1',1,NULL,'build the thing','[]','i-create','local-user','initial',1)`).run();
    legacy.query(`INSERT INTO intent_targets(intent_id,task_id) VALUES ('i-create','t1')`).run();
    legacy.query(`INSERT INTO workspaces(id,task_id,branch_ref,path,ownership_token,base_commit,
      state,created_at)
      VALUES ('w1','t1','refs/heads/task/t1','/tmp/demo-worktree','tok1','c0','IN_USE',1)`).run();
    legacy.query(`INSERT INTO executions(id,task_id,attempt_number,initial_revision_id,
      applied_revision_id,workspace_id,adapter_id,adapter_version,state,resource_held,base_commit,
      version,started_at)
      VALUES ('e1','t1',1,'r1','r1','w1','fake','1','WAITING_FOR_USER',1,'c0',0,1)`).run();
    legacy.query(`INSERT INTO agent_sessions(id,execution_id,provider_session_id,capabilities_json,
      state,version)
      VALUES ('s1','e1','provider-session-1','{}','WAITING_FOR_USER',0)`).run();
    legacy.query(`INSERT INTO attention_requests(id,session_id,provider_request_id,kind,prompt_json,
      status,created_at,response_type)
      VALUES ('a1','s1','req-1','QUESTION','{"kind":"codeestra.questionnaire"}','OPEN',1,'VALUE')`)
      .run();
    legacy.query(`INSERT INTO intent_attention_targets(intent_id,attention_id)
      VALUES ('i-answer','a1')`).run();
    legacy.exec('COMMIT');
    const violations = legacy.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(`the v27 fixture is not a valid database: ${JSON.stringify(violations)}`);
    }
  } finally {
    legacy.close();
  }
}

function withTemporaryDatabase(
  name: string,
  run: (directory: string, filename: string) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), `codeestra-${name}-`));
  try {
    run(directory, join(directory, 'runtime.sqlite'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('intents.kind shrink (schema v28, ADR-0046)', () => {
  test('this step owns version 28 and narrows the CHECK to five kinds', () => {
    expect(phase1SchemaVersion).toBeGreaterThanOrEqual(28);
    expect(intentKinds).toEqual(['CREATE_TASK', 'AMEND_TASK', 'ADD_CONSTRAINT', 'CANCEL_TASK',
      'ANSWER_AGENT']);
    // `ANSWER_AGENT` is deliberately kept: Attention answering writes it.
    expect(intentKindShrinkMigration).toContain("'ANSWER_AGENT'");
    expect(intentKindShrinkMigration).not.toContain("'CHANGE_PRIORITY'");
    expect(intentKindShrinkMigration).not.toContain("'SELF_MODIFICATION'");
    expect(intentKindShrinkMigration).toContain('CREATE TABLE intents_v28');
  });

  test('a version 27 file database upgrades in place and keeps every referencing row', () => {
    withTemporaryDatabase('intent-kind-v27', (_directory, filename) => {
      createLegacyV27Database(filename);

      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBe(phase1SchemaVersion);
      // The rebuild happens with foreign keys off, so the whole schema is re-verified afterwards.
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);

      // The existing Intent rows are preserved byte for byte; nothing was rewritten.
      expect(upgraded.sqlite.query<{ id: string; kind: string; status: string; raw_text: string },
        []>('SELECT id,kind,status,raw_text FROM intents ORDER BY id').all()).toEqual([
        { id: 'i-answer', kind: 'ANSWER_AGENT', status: 'APPLIED', raw_text: '{"type":"CONFIRM"}' },
        { id: 'i-create', kind: 'CREATE_TASK', status: 'APPLIED', raw_text: 'build the thing' },
      ]);

      // Each of the three referencing tables kept its row and its key fields.
      expect(upgraded.sqlite.query<{ source_intent_id: string; specification: string }, []>(
        "SELECT source_intent_id,specification FROM task_revisions WHERE id='r1'").get())
        .toEqual({ source_intent_id: 'i-create', specification: 'build the thing' });
      expect(upgraded.sqlite.query<{ intent_id: string; task_id: string }, []>(
        "SELECT intent_id,task_id FROM intent_targets WHERE intent_id='i-create'").get())
        .toEqual({ intent_id: 'i-create', task_id: 't1' });
      expect(upgraded.sqlite.query<{ intent_id: string; attention_id: string }, []>(
        "SELECT intent_id,attention_id FROM intent_attention_targets WHERE intent_id='i-answer'")
        .get()).toEqual({ intent_id: 'i-answer', attention_id: 'a1' });
      // …and each of those references still points at `intents` (the rename must not have
      // redirected or dropped a foreign key clause).
      for (const table of ['task_revisions', 'intent_targets', 'intent_attention_targets']) {
        const references = upgraded.sqlite.query<{ table: string }, []>(
          `SELECT "table" FROM pragma_foreign_key_list('${table}') WHERE "table"='intents'`).all();
        expect(references.length).toBeGreaterThan(0);
      }

      // The rebuilt table carries the same keys it did before: the primary key and the per-project
      // uniqueness of an idempotency key are both still enforced.
      const indexes = upgraded.sqlite.query<{ origin: string }, []>("PRAGMA index_list('intents')")
        .all();
      expect(indexes.length).toBe(2);
      expect(() => upgraded.sqlite.query(`INSERT INTO intents(id,project_id,idempotency_key,
        raw_text,kind,status,actor,created_at)
        VALUES ('i-dup','p1','cmd-create','again','CREATE_TASK','RECORDED','local-user',3)`).run())
        .toThrow(/UNIQUE/);
      // No trigger was attached to `intents` in v27 and none is invented in v28; the append-only
      // triggers of the surrounding schema are untouched by the rebuild.
      expect(upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='intents'").all())
        .toEqual([]);
      expect(upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='task_revisions'").all()
        .map((row) => row.name).sort()).toEqual(['task_revisions_no_delete', 'task_revisions_no_update']);
      upgraded.close();
    });
  });

  test('a removed kind is refused up front and leaves the original database untouched', () => {
    for (const kind of ['CHANGE_PRIORITY', 'SELF_MODIFICATION']) {
      withTemporaryDatabase(`intent-kind-strand-${kind.toLowerCase()}`, (_directory, filename) => {
        createLegacyV27Database(filename);
        const legacy = new Database(filename, { create: true, strict: true });
        // A v27 database accepts this kind by design; that is exactly the state v28 refuses.
        legacy.query(`INSERT INTO intents(id,project_id,idempotency_key,raw_text,kind,status,actor,
          created_at)
          VALUES ('i-stranded','p1','cmd-stranded','raise it','${kind}','RECORDED','local-user',3)`)
          .run();
        legacy.close();

        let refusal: unknown;
        try {
          new Phase1Database(filename);
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toBeInstanceOf(StorageError);
        expect((refusal as StorageError).code).toBe('INVALID_STATE');
        expect((refusal as StorageError).message).toContain(kind);
        expect((refusal as StorageError).message).toContain('nothing was changed');

        // The original database is intact: still v27, the stranded row is still there, no partial
        // `intents_v28` table was left behind, and no row was silently deleted or rewritten.
        const after = new Database(filename, { create: true, strict: true });
        expect(after.query<{ user_version: number }, []>('PRAGMA user_version')
          .get()?.user_version).toBe(27);
        expect(after.query<{ kind: string }, []>(
          "SELECT kind FROM intents WHERE id='i-stranded'").get()?.kind).toBe(kind);
        expect(after.query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='intents_v28'").get())
          .toBeNull();
        expect(after.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM intents').get()
          ?.count).toBe(3);
        expect(after.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
          .toEqual([]);
        after.close();
      });
    }
  });

  test('the migration SQL is never reached by an upgrade that could lose a row', () => {
    // `intentKindShrinkMigration` is deliberately not executed directly on a stranded database.
    // Bun's `Database.exec()` swallows a step-time error inside a multi-statement script and keeps
    // running, so a copy rejected by the narrowed CHECK would be followed by `DROP TABLE intents`
    // with no error — executing it directly would demonstrate a data-loss path, not a refusal. The
    // guarantee that matters is the one the previous test asserts: `migrate()` refuses before any
    // statement of this migration runs. What is checked here is only that the migration's own
    // statements cannot silently *succeed* on a stranded row: the narrowed table's CHECK is what
    // the copy is measured against.
    const storage = new Phase1Database();
    expect(() => storage.sqlite.query(`INSERT INTO intents(id,project_id,idempotency_key,raw_text,
      kind,status,actor,created_at)
      VALUES ('i-x','p','k','x','CHANGE_PRIORITY','RECORDED','a',1)`).run())
      .toThrow(/CHECK/);
    storage.close();
  });

  test('the boundary refuses a removed kind with a stable code instead of a CHECK error', () => {
    const storage = new Phase1Database();
    expect(assertIntentKind('ANSWER_AGENT')).toBe('ANSWER_AGENT');
    for (const kind of ['CHANGE_PRIORITY', 'SELF_MODIFICATION', 'NOT_A_KIND']) {
      let refusal: unknown;
      try {
        assertIntentKind(kind);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(StorageError);
      expect((refusal as StorageError).code).toBe('UNSUPPORTED_INTENT_KIND');
      expect((refusal as StorageError).message).toContain(kind);
    }
    // The database itself refuses the same values, so a caller that bypasses the guard still cannot
    // land one silently.
    storage.sqlite.query(`INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,
      object_format,policy_version,created_at)
      VALUES ('p1','demo','/tmp/demo','/tmp/demo/.git','refs/heads/main','sha1',1,1)`).run();
    for (const kind of ['CHANGE_PRIORITY', 'SELF_MODIFICATION']) {
      expect(() => storage.sqlite.query(`INSERT INTO intents(id,project_id,idempotency_key,raw_text,
        kind,status,actor,created_at)
        VALUES ('i-bad','p1','cmd-bad','x','${kind}','RECORDED','local-user',1)`).run())
        .toThrow(/CHECK/);
    }
    expect(storage.sqlite.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM intents')
      .get()?.count).toBe(0);
    storage.close();
  });

  test('ANSWER_AGENT is still written by the Attention answer path', () => {
    withTemporaryDatabase('intent-kind-answer', (_directory, filename) => {
      createLegacyV27Database(filename);
      const storage = new Phase1Database(filename);
      // This is the product path that writes `ANSWER_AGENT`
      // (`Phase1Database.planAttentionAnswer`), run against the v28 schema. If the shrink had
      // removed `ANSWER_AGENT` — as the FOUNDATION-074 note wrongly implied was safe — this call
      // would fail and every Attention answer would break.
      const plan = storage.planAttentionAnswer({
        projectId: 'p1', attentionId: 'a1', commandId: 'cmd-answer-2', payloadHash: 'h1',
        intentId: 'i-answer-2', answerId: 'ans-2', operationId: 'op-2',
        answer: { type: 'CANCEL' }, intentEventId: 'ie-2', recordedEventId: 're-2',
        actor: 'local-user', recordedAt: 10,
      });
      expect(plan.operationId).toBe('op-2');
      expect(storage.sqlite.query<{ kind: string; status: string }, []>(
        "SELECT kind,status FROM intents WHERE id='i-answer-2'").get())
        .toEqual({ kind: 'ANSWER_AGENT', status: 'APPLIED' });
      expect(storage.sqlite.query<{ attention_id: string }, []>(
        "SELECT attention_id FROM intent_attention_targets WHERE intent_id='i-answer-2'").get())
        .toEqual({ attention_id: 'a1' });
      storage.close();
    });
  });
});
