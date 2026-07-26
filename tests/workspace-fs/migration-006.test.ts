import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readdirSync, readFileSync as readFS } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { openWorkspaceFolder } from '@workspace-fs/bootstrap';

// =============================================================================
// Migration 006 — full end-to-end
// =============================================================================
//
// Build a pre-006 shaped DB by running migrations 001-005 only, populate it
// with the legacy nested-collections shape + matching .http files on disk,
// then trigger migration 006 (via openDb) and the disk-side move (via
// openWorkspaceFolder). Verify:
//
//   - directories rows mirror the parent_collection_id tree
//   - each .http file is now in the directory matching its place in the tree
//   - the scratch table is gone after openWorkspaceFolder
//   - sibling .env.json files travel with their .http

const MIGRATIONS_DIR = joinPath(__dirname, '../../src/storage/migrations');

let workspaceDir: string;
let userDataDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'mig006-ws-'));
  userDataDir = mkdtempSync(join(tmpdir(), 'mig006-userdata-'));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
});

describe('migration 006', () => {
  it('promotes parent collections to directories and moves files on disk', () => {
    // Lay out a pre-006 cache + the disk it represents.
    //
    // Workspace tree the user had under the legacy model:
    //   One Roster  (parent collection, contains auth.http content)
    //     V1P1       (child collection)
    //     V1P2       (child collection)
    //
    // Flat on disk:
    //   one-roster.http
    //   v1p1.http
    //   v1p2.http
    writeFileSync(join(workspaceDir, 'one-roster.http'), '### auth\nPOST https://x.test/token\n');
    writeFileSync(join(workspaceDir, 'v1p1.http'), '### v1p1\nGET https://x.test/v1p1\n');
    writeFileSync(join(workspaceDir, 'v1p2.http'), '### v1p2\nGET https://x.test/v1p2\n');

    // Build the cache at the location openWorkspaceFolder will look.
    const { cacheDbPath } = cachePathFor(userDataDir, workspaceDir);
    setupPre006Cache(cacheDbPath, {
      workspaceId: 'ws-1',
      workspaceName: 'examples',
      workspaceDir,
      collections: [
        { id: 'col-one-roster', name: 'One Roster', parentId: null, file: 'one-roster.http' },
        { id: 'col-v1p1', name: 'V1P1', parentId: 'col-one-roster', file: 'v1p1.http' },
        { id: 'col-v1p2', name: 'V1P2', parentId: 'col-one-roster', file: 'v1p2.http' },
      ],
    });

    // Open the workspace. This runs the new migrations through openDb, then
    // runs the disk-side move from the scratch table.
    const { db, result } = openWorkspaceFolder(userDataDir, workspaceDir);
    try {
      expect(result.workspacePath).toBe(workspaceDir);

      // On-disk tree should now be reshaped:
      //   workspace/
      //     one-roster/
      //       one-roster.http   (the parent's own requests, renamed to the dir's slug)
      //       v1p1.http
      //       v1p2.http
      expect(existsSync(join(workspaceDir, 'one-roster', 'one-roster.http'))).toBe(true);
      expect(existsSync(join(workspaceDir, 'one-roster', 'v1p1.http'))).toBe(true);
      expect(existsSync(join(workspaceDir, 'one-roster', 'v1p2.http'))).toBe(true);
      expect(existsSync(join(workspaceDir, 'one-roster.http'))).toBe(false);
      expect(existsSync(join(workspaceDir, 'v1p1.http'))).toBe(false);

      // Cache should have a directories row for "One Roster" with the three
      // collections pointing at it.
      const rows = db
        .prepare(
          "SELECT name, parent_directory_id FROM directories WHERE name != '' ORDER BY name",
        )
        .all() as { name: string; parent_directory_id: string | null }[];
      // Directory name is the on-disk slug (lower-case, hyphens), so it
      // matches the directory adoptWorkspace would have created had the
      // user laid out the same tree by hand.
      expect(rows.map((r) => r.name)).toEqual(['one-roster']);

      const collections = db
        .prepare('SELECT name, directory_id FROM collections ORDER BY name')
        .all() as { name: string; directory_id: string | null }[];
      const oneRosterDirId = db
        .prepare(
          "SELECT id FROM directories WHERE name = 'one-roster' LIMIT 1",
        )
        .get() as { id: string };
      for (const c of collections) {
        expect(c.directory_id).toBe(oneRosterDirId.id);
      }

      // Scratch table should be gone — disk migration ran to completion.
      const scratch = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='_migration_006_paths'",
        )
        .get();
      expect(scratch).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('moves sibling .env.json alongside its .http during migration', () => {
    writeFileSync(join(workspaceDir, 'one-roster.http'), '### x\nPOST https://x/token\n');
    writeFileSync(join(workspaceDir, 'v1p1.http'), '### x\nGET https://x/v1p1\n');
    writeFileSync(
      join(workspaceDir, 'v1p1.ci.env.json'),
      JSON.stringify({ name: 'ci', vars: [] }),
    );

    const { cacheDbPath } = cachePathFor(userDataDir, workspaceDir);
    setupPre006Cache(cacheDbPath, {
      workspaceId: 'ws-1',
      workspaceName: 'examples',
      workspaceDir,
      collections: [
        { id: 'col-one-roster', name: 'One Roster', parentId: null, file: 'one-roster.http' },
        { id: 'col-v1p1', name: 'V1P1', parentId: 'col-one-roster', file: 'v1p1.http' },
      ],
    });

    const { db } = openWorkspaceFolder(userDataDir, workspaceDir);
    try {
      // v1p1.http moved to one-roster/v1p1.http; its sibling env file
      // (v1p1.ci.env.json) moved with it.
      expect(existsSync(join(workspaceDir, 'one-roster', 'v1p1.ci.env.json'))).toBe(true);
      expect(existsSync(join(workspaceDir, 'v1p1.ci.env.json'))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('is idempotent — re-opening the workspace after migration does nothing destructive', () => {
    writeFileSync(join(workspaceDir, 'one-roster.http'), '### x\nGET https://x/\n');
    writeFileSync(join(workspaceDir, 'v1p1.http'), '### x\nGET https://x/\n');

    const { cacheDbPath } = cachePathFor(userDataDir, workspaceDir);
    setupPre006Cache(cacheDbPath, {
      workspaceId: 'ws-1',
      workspaceName: 'examples',
      workspaceDir,
      collections: [
        { id: 'col-one-roster', name: 'One Roster', parentId: null, file: 'one-roster.http' },
        { id: 'col-v1p1', name: 'V1P1', parentId: 'col-one-roster', file: 'v1p1.http' },
      ],
    });

    const a = openWorkspaceFolder(userDataDir, workspaceDir);
    a.db.close();

    // Snapshot disk after first open, then reopen and ensure nothing moved.
    const snapBefore = listFiles(workspaceDir);
    const b = openWorkspaceFolder(userDataDir, workspaceDir);
    b.db.close();
    const snapAfter = listFiles(workspaceDir);
    expect(snapAfter).toEqual(snapBefore);
  });
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function cachePathFor(userData: string, workspace: string): { cacheDbPath: string } {
  // Mirrors workspaceCacheDbPath without importing it (avoids coupling the
  // test to internal helper signatures).
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const hash = crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 16);
  return { cacheDbPath: joinPath(userData, 'workspaces', hash, 'cache.sqlite') };
}

interface PreCacheSpec {
  workspaceId: string;
  workspaceName: string;
  workspaceDir: string;
  collections: { id: string; name: string; parentId: string | null; file: string }[];
}

/**
 * Build a cache.sqlite file at the legacy schema (versions 1-5 applied)
 * with the given workspace + nested collections. Mirrors what an existing
 * Coax install would have just before migration 006 runs.
 */
function setupPre006Cache(dbPath: string, spec: PreCacheSpec): void {
  const fs = require('node:fs') as typeof import('node:fs');
  fs.mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Apply only migrations 001..005 — leaving the DB at the pre-006 shape.
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && Number(f.split('_')[0]) <= 5)
    .sort();
  for (const f of files) {
    db.exec(readFS(joinPath(MIGRATIONS_DIR, f), 'utf8'));
  }

  // Seed the workspace + collections + matching http_files rows.
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(
    'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(spec.workspaceId, spec.workspaceName, now, now);

  for (const c of spec.collections) {
    const rootFolderId = `rf-${c.id}`;
    db.prepare(
      'INSERT INTO collections (id, workspace_id, name, parent_collection_id, sort_order, root_folder_id) VALUES (?, ?, ?, ?, 0, ?)',
    ).run(c.id, spec.workspaceId, c.name, c.parentId, rootFolderId);
    db.prepare(
      "INSERT INTO folders (id, collection_id, parent_folder_id, name, sort_order) VALUES (?, ?, NULL, '(root)', -1)",
    ).run(rootFolderId, c.id);
    db.prepare(
      'INSERT INTO http_files (id, collection_id, path, last_imported_at, hash) VALUES (?, ?, ?, ?, ?)',
    ).run(`hf-${c.id}`, c.id, joinPath(spec.workspaceDir, c.file), now, '');
  }

  db.close();
}

function listFiles(root: string): string[] {
  const fs = require('node:fs') as typeof import('node:fs');
  const out: string[] = [];
  const walk = (p: string): void => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const sub = joinPath(p, entry.name);
      if (entry.isDirectory()) walk(sub);
      else out.push(sub.replace(`${root}/`, ''));
    }
  };
  walk(root);
  return out.sort();
}

// readFileSync re-export to silence unused-import lint (tests above use it).
void readFileSync;
