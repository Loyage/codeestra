/**
 * Agent plugin selection in storage (FOUNDATION-071 / ADR-0044, schema v27).
 *
 * The upgrade is asserted against a real temporary file database, and the version assertion is
 * `>= 27` or the migration constant itself — never "the current version is exactly 27" (three earlier
 * waves broke on that exact assertion after a merge that added a later step).
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Phase1Database, StorageError, agentPluginSelectionMigration, phase1SchemaVersion }
  from '../src/index.js';

const selection = {
  extensions: ['/plugins/a.ts', '/plugins/b.ts'],
  skills: ['/plugins/skill-a'],
  promptTemplates: [],
  themes: ['/plugins/theme.json'],
};

describe('agent plugin selection storage', () => {
  test('the plugin selection migration belongs to this step and adds one column', () => {
    expect(phase1SchemaVersion).toBeGreaterThanOrEqual(27);
    expect(agentPluginSelectionMigration).toContain('ALTER TABLE agent_configurations');
    expect(agentPluginSelectionMigration).toContain('plugin_selection_json');
  });

  test('a version 26 database upgrades in place and keeps its existing rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeestra-plugin-v26-'));
    const filename = join(directory, 'runtime.sqlite');
    try {
      // Build the current schema, then remove exactly what version 27 added: the upgrade below is
      // then the same statement a real version 26 database runs. The row inserted is a GLOBAL scope,
      // so it references no project.
      new Phase1Database(filename).close();
    } catch {
      // A failure here must not silently skip the migration assertions below.
      throw new Error('could not build the current schema for the upgrade fixture');
    }
    try {
      const legacy = new Database(filename, { create: true, strict: true });
      legacy.exec('PRAGMA foreign_keys=OFF;');
      legacy.query(`INSERT INTO agent_configurations
        (id,scope,project_id,adapter_id,provider,model,thinking_level,plugin_selection_json,
         updated_at,updated_by)
        VALUES ('cfg-global','GLOBAL',NULL,'pi','deepseek','deepseek-flash','high',
          '{"extensions":[],"skills":[],"promptTemplates":[],"themes":[]}',5,'local-user')`).run();
      legacy.exec('ALTER TABLE agent_configurations DROP COLUMN plugin_selection_json');
      // A version 26 database also predates every later step, so the columns added by schema v29
      // (the dev clone and the promotion remote readbacks) are removed as well: the upgrade below
      // must then be exactly what a real v26 database runs.
      for (const column of ['dev_repo_path', 'remote_dev_commit', 'remote_main_commit', 'pushed_at',
        'main_pushed_at']) {
        legacy.exec(`ALTER TABLE stable_promotions DROP COLUMN ${column}`);
      }
      legacy.exec('ALTER TABLE projects DROP COLUMN dev_repo_path');
      // ...and the same for the tables added by schema v31 (Session Guidance, ADR-0057): a real v26
      // database does not have them either.
      for (const table of ['session_guidance_deliveries', 'execution_guidance_contexts',
        'session_guidance']) {
        legacy.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      // ...and the column added by schema v32 (declared features, ADR-0059).
      legacy.exec('ALTER TABLE task_revisions DROP COLUMN features_json');
      // ...and the column added by schema v33 (the per-Task base ref, ADR-0060).
      legacy.exec('ALTER TABLE workspaces DROP COLUMN base_ref');
      // ...and the same for the tables added by schema v34 (Runtime global load control, ADR-0061):
      // a real database at this version does not have them either.
      for (const table of ['runtime_pause_targets', 'runtime_command_receipts',
        'runtime_pause_control']) {
        legacy.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      legacy.exec('PRAGMA user_version=26');
      legacy.close();

      const upgraded = new Phase1Database(filename);
      expect(upgraded.sqlite.query<{ user_version: number }, []>('PRAGMA user_version')
        .get()?.user_version).toBe(phase1SchemaVersion);
      expect(upgraded.sqlite.query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('agent_configurations')",
      ).all().map((row) => row.name)).toContain('plugin_selection_json');
      // The existing row is preserved and simply has no selection: an upgrade never invents one.
      const record = upgraded.getAgentConfiguration('GLOBAL', null, 'pi');
      expect(record).toMatchObject({
        provider: 'deepseek', model: 'deepseek-flash', thinkingLevel: 'high',
        pluginSelection: null,
      });
      expect(upgraded.sqlite.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all())
        .toEqual([]);
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('writes, reads and replaces a plugin selection as one whole-list override', () => {
    const storage = new Phase1Database();
    expect(storage.setAgentConfiguration({
      id: 'cfg-1', scope: 'GLOBAL', projectId: null, adapterId: 'pi',
      pluginSelection: selection, updatedAt: 1, updatedBy: 'local-user',
    })).toMatchObject({ pluginSelection: selection });
    expect(storage.getAgentConfiguration('GLOBAL', null, 'pi')?.pluginSelection).toEqual(selection);
    // A second write replaces the list rather than merging into it.
    const replaced = storage.setAgentConfiguration({
      id: 'cfg-2', scope: 'GLOBAL', projectId: null, adapterId: 'pi',
      pluginSelection: { extensions: ['/plugins/c.ts'], skills: [], promptTemplates: [], themes: [] },
      updatedAt: 2, updatedBy: 'local-user',
    });
    expect(replaced?.pluginSelection).toEqual({
      extensions: ['/plugins/c.ts'], skills: [], promptTemplates: [], themes: [],
    });
    // Clearing the selection while the model fields stay keeps the row.
    expect(storage.setAgentConfiguration({
      id: 'cfg-3', scope: 'GLOBAL', projectId: null, adapterId: 'pi', model: 'm1',
      pluginSelection: null, updatedAt: 3, updatedBy: 'local-user',
    })).toMatchObject({ model: 'm1', pluginSelection: null });
    storage.close();
  });

  test('refuses a malformed selection and writes nothing', () => {
    const storage = new Phase1Database();
    expect(() => storage.setAgentConfiguration({
      id: 'cfg-bad', scope: 'GLOBAL', projectId: null, adapterId: 'pi',
      pluginSelection: { extensions: ['relative/path.ts'], skills: [], promptTemplates: [], themes: [] },
      updatedAt: 1, updatedBy: 'local-user',
    })).toThrow(StorageError);
    expect(storage.getAgentConfiguration('GLOBAL', null, 'pi')).toBeNull();
    expect(() => storage.setAgentConfiguration({
      id: 'cfg-bad-2', scope: 'GLOBAL', projectId: null, adapterId: 'pi',
      // An unknown field is rejected by the strict schema; the cast only exists to express the
      // invalid input TypeScript would otherwise refuse to compile.
      pluginSelection: { extensions: [], skills: [], promptTemplates: [], themes: ['/ok.json'],
        extra: ['/nope'] } as never,
      updatedAt: 1, updatedBy: 'local-user',
    })).toThrow(StorageError);
    expect(storage.getAgentConfiguration('GLOBAL', null, 'pi')).toBeNull();
    storage.close();
  });
});
