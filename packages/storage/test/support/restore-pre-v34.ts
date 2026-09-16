import type { Database } from 'bun:sqlite';

/**
 * Puts a fixture database back into the shape a pre-v34 database had (FOUNDATION-096/097 / ADR-0061).
 *
 * Several migration tests build their fixture by creating the *current* schema and then removing
 * exactly what the step under test added. Since schema v34 retires two tables and creates four new
 * ones — two for the Runtime-wide capacity half, two for the global pause half — a fixture that
 * claims to be v26/v28/v29 must also have the retired configuration tables back and must not already
 * hold any of the v34 tables, otherwise the upgrade it exercises is not the statement a real database
 * of that age runs.
 *
 * `domain_events` is deliberately left as-is: v34's rebuild (create → copy → drop → rename) is
 * idempotent on an empty-or-populated log, and the *genuine* v33 → v34 chain — including the
 * `NOT NULL` → nullable project_id change — is asserted against a real file database in
 * `runtime-capacity-migration.test.ts` and `runtime-pause-control-migration.test.ts`, which build
 * their history from the migration constants.
 */
export function restorePreV34Schema(database: Database): void {
  database.exec(`
DROP TABLE IF EXISTS runtime_capacity_settings;
DROP TABLE IF EXISTS runtime_command_receipts;
DROP TABLE IF EXISTS runtime_pause_targets;
DROP TABLE IF EXISTS runtime_pause_control;

CREATE TABLE project_capacity_limits (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  global_limit INTEGER NOT NULL CHECK(global_limit > 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  updated_by TEXT NOT NULL CHECK(length(trim(updated_by)) > 0)
) STRICT;

CREATE TABLE project_adapter_slot_limits (
  project_id TEXT NOT NULL REFERENCES projects(id),
  adapter_id TEXT NOT NULL CHECK(length(trim(adapter_id)) > 0),
  slot_limit INTEGER NOT NULL CHECK(slot_limit > 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  updated_by TEXT NOT NULL CHECK(length(trim(updated_by)) > 0),
  PRIMARY KEY(project_id,adapter_id)
) STRICT;
`);
}
