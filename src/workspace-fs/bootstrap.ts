// =============================================================================
// Workspace bootstrap
// =============================================================================
//
// Opens a workspace folder. Idempotent: safe to call repeatedly with the
// same folder. Returns the open Db (the per-machine cache for that folder).
//
//   1. Compute the cache path under <userData>/Coax/workspaces/<hash>/.
//   2. If the cache DB doesn't exist yet, create it; scan the folder for
//      directories, .http files, and .env.json files; adopt the whole
//      tree via `adoptWorkspace`.
//   3. If migration 006's scratch table is present, run the one-time
//      disk-layout migration (mkdir + mv to make the on-disk tree match
//      the new SQLite directory rows). Idempotent: clears the scratch
//      table when done.
//   4. Return the open Db + workspace metadata.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  type Dirent,
} from 'node:fs';
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path';
import { openDb, type Db } from '@storage/db';
import { Repos } from '@storage/repos';
import { adoptWorkspace } from './adopt.js';
import { parseEnvFile } from './env-file.js';
import {
  collectionFileName,
  parseEnvFileName,
  workspaceCacheDbPath,
  workspaceCacheDir,
} from './paths.js';

export interface BootstrapResult {
  workspacePath: string;
  workspaceId: string;
  workspaceName: string;
  cachePath: string;
  collectionsAdopted: number;
  envsAdopted: number;
  warnings: string[];
}

/**
 * Open a workspace folder. Creates the per-machine cache if missing,
 * scans the folder via `adoptWorkspace`, and runs the one-time disk
 * layout migration if migration 006 left work behind.
 */
export function openWorkspaceFolder(
  userDataRoot: string,
  workspacePath: string,
): { db: Db; result: BootstrapResult } {
  const absWorkspace = resolvePath(workspacePath);
  if (!existsSync(absWorkspace)) {
    throw new Error(`NOT_FOUND: workspace folder does not exist: ${absWorkspace}`);
  }

  const cacheDir = workspaceCacheDir(userDataRoot, absWorkspace);
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const cachePath = workspaceCacheDbPath(userDataRoot, absWorkspace);

  const isFirstOpen = !existsSync(cachePath);
  const db = openDb(cachePath);

  const warnings: string[] = [];
  let collectionsAdopted = 0;
  let envsAdopted = 0;
  let workspaceId: string;
  let workspaceName: string;

  if (isFirstOpen) {
    workspaceName = basename(absWorkspace);
    const workspace = Repos.Workspaces.create(db, { name: workspaceName });
    workspaceId = workspace.id;
    const r = adoptWorkspace(db, workspaceId, absWorkspace);
    collectionsAdopted = r.collectionsAdopted;
    envsAdopted = r.envsAdopted;
    warnings.push(...r.warnings);
  } else {
    const workspaces = Repos.Workspaces.list(db);
    if (workspaces.length === 0) {
      throw new Error('CORRUPT_CACHE: workspace row missing from cache.sqlite');
    }
    const w = workspaces[0]!;
    workspaceId = w.id;
    workspaceName = w.name;

    // Run the one-time disk migration if 006 left a scratch table behind.
    // Pure-SQL backfill set up the directory tree; this moves the .http
    // files on disk to match. Idempotent: drops the scratch table when
    // done so subsequent opens skip the work.
    const pending = hasPendingMigration006(db);
    if (pending) {
      const moves = runMigration006Disk(db, workspaceId, absWorkspace);
      if (moves.length > 0) {
        console.log(`Coax: rearranged ${moves.length} files to match the workspace tree.`);
        for (const m of moves) {
          console.log(`  ${m.from} → ${m.to}`);
        }
      }
    }

    // Reconcile env-file scopes against disk. The .env.json file's
    // location IS its scope (directory-level); if the cache still has the
    // env folder-scoped against some collection's root folder (a legacy
    // shape from before the directories model), move it to directory
    // scope so the resolver cascade actually picks it up.
    reconcileEnvScopesFromDisk(db, workspaceId, absWorkspace);
  }

  return {
    db,
    result: {
      workspacePath: absWorkspace,
      workspaceId,
      workspaceName,
      cachePath,
      collectionsAdopted,
      envsAdopted,
      warnings,
    },
  };
}

// -----------------------------------------------------------------------------
// Migration 006 — disk-layout backfill
// -----------------------------------------------------------------------------
//
// SQL migration 006 already built the `directories` tree from the legacy
// `parent_collection_id` chains and pointed each collection at its new
// directory. It stashed the OLD `.http` paths in `_migration_006_paths`
// so this code can move the actual files on disk to match. After every
// file is in place we drop the scratch table; subsequent opens see the
// table is gone and skip this work entirely.

function hasPendingMigration006(db: Db): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_migration_006_paths'",
    )
    .get();
  return row !== undefined;
}

interface MigrationMove {
  collectionId: string;
  from: string;
  to: string;
}

function runMigration006Disk(
  db: Db,
  workspaceId: string,
  workspaceRoot: string,
): MigrationMove[] {
  const moves: MigrationMove[] = [];
  const rows = db
    .prepare('SELECT collection_id, old_path FROM _migration_006_paths')
    .all() as { collection_id: string; old_path: string }[];

  for (const row of rows) {
    const col = Repos.Collections.get(db, row.collection_id);
    if (!col) continue; // collection deleted between migrations — fine
    const newPath = derivePath(db, workspaceRoot, col);
    if (newPath === null) continue;
    if (newPath === row.old_path) continue; // already in place
    if (!existsSync(row.old_path)) continue; // source file gone — nothing to move

    try {
      mkdirSync(dirname(newPath), { recursive: true });
      renameSync(row.old_path, newPath);
      // Move sibling env files too — they share the .http basename.
      moveSiblingEnvFiles(row.old_path, newPath);
      moves.push({ collectionId: col.id, from: row.old_path, to: newPath });
    } catch (e) {
      console.error(`Coax: failed to move ${row.old_path} → ${newPath}: ${(e as Error).message}`);
    }
  }

  db.prepare('DROP TABLE _migration_006_paths').run();
  void workspaceId; // reserved for future per-workspace logging
  return moves;
}

function derivePath(
  db: Db,
  workspaceRoot: string,
  col: { directoryId: string; name: string },
): string | null {
  const dirPath = Repos.Directories.pathOf(db, col.directoryId);
  const file = `${slugify(col.name)}.http`;
  return dirPath === '' ? join(workspaceRoot, file) : join(workspaceRoot, dirPath, file);
}

function moveSiblingEnvFiles(oldHttpPath: string, newHttpPath: string): void {
  // Old + new live in different directories most of the time. Sibling
  // .env.json files share the .http basename (`<base>.<env>.env.json`)
  // so we look them up by glob in the old directory.
  const oldDir = dirname(oldHttpPath);
  const oldBase = basename(oldHttpPath, '.http');
  const newDir = dirname(newHttpPath);
  const newBase = basename(newHttpPath, '.http');

  let entries: string[];
  try {
    entries = readdirSync(oldDir);
  } catch {
    return;
  }

  const suffix = '.env.json';
  for (const name of entries) {
    if (!name.startsWith(`${oldBase}.`) || !name.endsWith(suffix)) continue;
    const middle = name.slice(oldBase.length + 1, name.length - suffix.length);
    if (middle === '') continue;
    const oldEnv = join(oldDir, name);
    const newEnv = join(newDir, `${newBase}.${middle}${suffix}`);
    try {
      mkdirSync(dirname(newEnv), { recursive: true });
      renameSync(oldEnv, newEnv);
    } catch {
      /* sibling rename is best-effort */
    }
  }
}

function slugify(displayName: string): string {
  return (
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
}

// -----------------------------------------------------------------------------
// Env-scope reconciliation
// -----------------------------------------------------------------------------
//
// Walks every `.env.json` in the workspace and ensures the cache reflects
// it as a directory-scoped env. Two cases:
//
//   1. Cache already has a directory-scoped env with this name at this
//      directory → no-op.
//   2. Cache has a folder-scoped env on a collection's root folder, where
//      the collection lives in this directory and the name matches → move
//      the env to directory scope (keeps all its vars).
//   3. Neither → no-op here; the env file will be picked up by the next
//      fresh adoptWorkspace pass (or could be hot-adopted later).
//
// Idempotent: case 1 is a no-op, case 2 produces case 1 on the next run.

function reconcileEnvScopesFromDisk(
  db: Db,
  workspaceId: string,
  workspaceRoot: string,
): void {
  const envFiles = walkEnvFiles(workspaceRoot);
  for (const filePath of envFiles) {
    const relativeDir = dirname(relative(workspaceRoot, filePath));
    // Map the on-disk path back to a directory id in the cache.
    const dirPath = relativeDir === '.' ? '' : relativeDir;
    const directory = Repos.Directories.findByPath(db, workspaceId, dirPath);
    if (!directory) continue;

    const parsed = parseEnvFile(readFileSync(filePath, 'utf8'));
    if (!parsed.ok) continue;
    const envName = parsed.value.name;

    // Determine the correct scope from the filename. `<col>.<env>.env.json`
    // next to `<col>.http` means folder scope on that collection's root
    // folder; plain `<env>.env.json` means directory scope. Longest prefix
    // wins so `users-archive.dev.env.json` doesn't bind to `users.http`.
    const collectionsInDir = Repos.Collections.listByDirectory(db, directory.id);
    let targetFolderId: string | null = null;
    let bestMatchLen = -1;
    for (const col of collectionsInDir) {
      const httpFileName = collectionFileName(col.name);
      const httpFilePath = join(dirname(filePath), httpFileName);
      if (parseEnvFileName(filePath, httpFilePath) === null) continue;
      const base = basename(httpFileName, '.http');
      if (base.length > bestMatchLen) {
        targetFolderId = col.rootFolderId;
        bestMatchLen = base.length;
      }
    }

    if (targetFolderId !== null) {
      // Filename says this env belongs on a collection's root folder.
      const onTargetFolder = Repos.Envs.list(db, targetFolderId).find((e) => e.name === envName);
      if (onTargetFolder) continue; // already correct

      // Look for the env at the directory scope (the old reconcile target)
      // or on a *different* collection's folder, and move it.
      const dirScoped = Repos.Envs.listByDirectory(db, directory.id).find(
        (e) => e.name === envName,
      );
      if (dirScoped) {
        db.prepare(
          'UPDATE environments SET directory_id = NULL, folder_id = ? WHERE id = ?',
        ).run(targetFolderId, dirScoped.id);
        continue;
      }
      for (const col of collectionsInDir) {
        if (col.rootFolderId === targetFolderId) continue;
        const wrongFolder = Repos.Envs.list(db, col.rootFolderId).find((e) => e.name === envName);
        if (!wrongFolder) continue;
        db.prepare('UPDATE environments SET folder_id = ? WHERE id = ?').run(
          targetFolderId,
          wrongFolder.id,
        );
        break;
      }
      continue;
    }

    // No filename prefix matched → directory scope is correct.
    const dirScoped = Repos.Envs.listByDirectory(db, directory.id).find(
      (e) => e.name === envName,
    );
    if (dirScoped) continue;

    for (const col of collectionsInDir) {
      const folderScoped = Repos.Envs.list(db, col.rootFolderId).find(
        (e) => e.name === envName,
      );
      if (!folderScoped) continue;
      db.prepare(
        'UPDATE environments SET folder_id = NULL, directory_id = ? WHERE id = ?',
      ).run(directory.id, folderScoped.id);
      break;
    }
  }
}

/**
 * Recursively walk a directory tree collecting every `.env.json` path.
 * Hidden directories and `node_modules` are skipped, matching adopt.
 */
function walkEnvFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dirPath: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'node_modules') continue;
        walk(p);
      } else if (entry.isFile() && entry.name.endsWith('.env.json')) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}
