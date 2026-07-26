import { describe, it, expect } from 'vitest';
import { openDb } from '@storage/db';

describe('openDb', () => {
  it('creates schema and reports current schema version', () => {
    const db = openDb(':memory:');
    const v = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(v.version).toBe(6);
  });
  it('all spec tables exist after first open', () => {
    const db = openDb(':memory:');
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = rows.map((r) => r.name).sort();
    // Excludes the transient `_migration_006_paths` scratch table that's
    // created during migration 006 and dropped on first workspace open
    // (see bootstrap.runMigration006Disk).
    expect(names).toEqual([
      'app_settings',
      'collections',
      'directories',
      'environments',
      'folders',
      'http_files',
      'last_responses',
      'open_tabs',
      'request_var_overrides',
      'requests',
      'schema_version',
      'variables',
      'workspaces',
    ]);
  });
  it('foreign keys are enforced', () => {
    const db = openDb(':memory:');
    // Insert references a workspace that doesn't exist; FK on workspace_id
    // should reject. `directory_id` is left NULL (ON DELETE SET NULL FK).
    expect(() =>
      db
        .prepare(
          "INSERT INTO collections (id, workspace_id, name, directory_id) VALUES ('c1', 'no-such-workspace', 'x', NULL)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
  it('cascades delete from workspace through collections through requests', () => {
    const db = openDb(':memory:');
    db.prepare(
      "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('w', 'work', '2026-01-01', '2026-01-01')",
    ).run();
    db.prepare("INSERT INTO collections (id, workspace_id, name) VALUES ('c', 'w', 'col')").run();
    db.prepare(
      "INSERT INTO requests (id, collection_id, name, method, url) VALUES ('r', 'c', 'req', 'GET', 'https://x')",
    ).run();
    db.prepare("DELETE FROM workspaces WHERE id = 'w'").run();
    expect(db.prepare('SELECT COUNT(*) as n FROM requests').get()).toEqual({ n: 0 });
  });
  it('migrate is idempotent (re-opening same DB does not re-apply migrations)', () => {
    // Open the same temp file twice, ensure schema_version still has exactly one row
    const path = `${__dirname}/.tmp-${Date.now()}.sqlite`;
    const fs = require('node:fs') as typeof import('node:fs');
    try {
      const db1 = openDb(path);
      db1.close();
      const db2 = openDb(path);
      const rows = db2.prepare('SELECT version FROM schema_version').all() as {
        version: number;
      }[];
      expect(rows).toEqual([{ version: 6 }]);
      db2.close();
    } finally {
      try {
        fs.unlinkSync(path);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(`${path}-wal`);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(`${path}-shm`);
      } catch {
        /* ignore */
      }
    }
  });
});
