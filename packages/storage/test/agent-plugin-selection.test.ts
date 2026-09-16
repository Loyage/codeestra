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
import {
  Phase1Database, StorageError, agentAnswerMigration, agentConfigurationMigration,
  agentDisconnectMigration, agentObservationMigration, agentPluginSelectionMigration,
  agentStartMigration, capacitySlotReservationMigration, impactAnalysisMigration,
  integrationPipelineMigration, knowledgeLayerMigration, operationProgressMigration,
  phase1Migration, phase1SchemaVersion, reclamationMigration, revisionDeliveryMigration,
  sessionHandoffMigration, sessionTerminalMigration, stablePromotionMigration,
  taskControlMigration, taskDependenciesMigration, taskRetryMigration, taskVerificationMigration,
  unregisteredReclamationMigration, verificationLayeringMigration, verificationProgressMigration,
  workspaceRetryMigration,
} from '../src/index.js';

/** The exact v1…v26 chain, in `migrate()` order (v16 permanently unused, v22 unoccupied). */
const throughV26 = [
  phase1Migration, agentStartMigration, agentObservationMigration, agentAnswerMigration,
  agentDisconnectMigration, taskVerificationMigration, workspaceRetryMigration,
  agentConfigurationMigration, taskControlMigration, integrationPipelineMigration,
  operationProgressMigration, reclamationMigration, stablePromotionMigration,
  sessionHandoffMigration, taskDependenciesMigration, verificationProgressMigration,
  sessionTerminalMigration, revisionDeliveryMigration, impactAnalysisMigration,
  capacitySlotReservationMigration, taskRetryMigration, unregisteredReclamationMigration,
  verificationLayeringMigration, knowledgeLayerMigration,
];

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
    const legacy = new Database(filename, { create: true, strict: true });
    try {
      // Build a genuine v26 database from the historical chain, then upgrade it. It cannot be done
      // by building the current schema and stripping what later steps added any more: ADR-0064's v35
      // step DROPs the `stable_promotions` aggregate and `projects.dev_repo_path`, so a current-schema
      // database no longer has what a v26 database had.
      legacy.exec('PRAGMA foreign_keys=OFF;');
      for (const migration of throughV26) legacy.exec(migration);
      legacy.exec('PRAGMA foreign_keys=ON;');
      legacy.query(`INSERT INTO projects(id,name,repo_root,git_common_dir,main_ref,dev_ref,
        object_format,policy_version,created_at)
        VALUES ('p1','demo','/tmp/demo','/tmp/demo/.git','refs/heads/main','refs/heads/dev','sha1',1,1)`)
        .run();
      legacy.query(`INSERT INTO agent_configurations
        (id,scope,project_id,adapter_id,provider,model,thinking_level,updated_at,updated_by)
        VALUES ('cfg-global','GLOBAL',NULL,'pi','deepseek','deepseek-flash','high',5,'local-user')`).run();
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
