// =============================================================================
// Collection ↔ file path mapping
// =============================================================================
//
// Under the directories model, a collection's `.http` path on disk is
// fully derivable from its position in the directory tree plus its name —
// no separate mapping table needed. This module exposes the derivation as
// a couple of small helpers so callers don't have to redo the join in
// every handler.
//
// Legacy entry points (recordCollectionPath, updateCollectionPath) are
// preserved as no-ops so handlers can still call them safely until the
// renderer-side cleanup happens.

import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '@storage/db';
import { Repos } from '@storage/repos';
import { collectionFileName, envFilePath, slug } from './paths.js';

/**
 * Derive the on-disk `.http` path for a collection from its position in
 * the workspace directory tree. `workspaceRoot` is the absolute path of
 * the workspace folder the user opened (handlers.ts tracks it as
 * `currentWorkspacePath`). Returns null if the collection is missing.
 */
export function httpPathForCollection(
  db: Db,
  workspaceRoot: string,
  collectionId: string,
): string | null {
  const col = Repos.Collections.get(db, collectionId);
  if (!col) return null;
  const dirPath = Repos.Directories.pathOf(db, col.directoryId);
  const fileName = collectionFileName(col.name);
  return dirPath === '' ? join(workspaceRoot, fileName) : join(workspaceRoot, dirPath, fileName);
}

/**
 * Compute the canonical `.http` path for a new collection: at the
 * workspace root (or its subdirectory if one is given), slugged from the
 * display name. If the slug collides with an existing file, append `-2`,
 * `-3`, etc. until a free name is found.
 */
export function newCollectionPath(
  workspaceRoot: string,
  displayName: string,
  subdir?: string,
): string {
  const base = slug(displayName);
  const dir = subdir === undefined || subdir === '' ? workspaceRoot : join(workspaceRoot, subdir);
  let candidate = join(dir, `${base}.http`);
  let i = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${base}-${i}.http`);
    i++;
  }
  return candidate;
}

/**
 * No-op. The on-disk path is derived from the directory tree + collection
 * name, so there's nothing to record. Kept as a callable so older
 * handlers compile without churn while the renderer-side cleanup lands.
 */
export function recordCollectionPath(_db: Db, _collectionId: string, _filePath: string): void {
  /* derived path: nothing to persist */
}

/** No-op. See `recordCollectionPath`. */
export function updateCollectionPath(_db: Db, _collectionId: string, _newPath: string): void {
  /* derived path: nothing to persist */
}

/**
 * Delete the collection's on-disk `.http` file. Best-effort: missing files
 * are not an error (the collection may have been created in-session and
 * never flushed).
 */
export async function removeCollectionFile(
  db: Db,
  workspaceRoot: string,
  collectionId: string,
): Promise<void> {
  const path = httpPathForCollection(db, workspaceRoot, collectionId);
  if (path === null) return;
  try {
    await unlink(path);
  } catch {
    /* fine */
  }
}

/**
 * Path to a specific env JSON for a collection. Returns null if the
 * collection has no derivable .http path (collection missing).
 */
export function envJsonPath(
  db: Db,
  workspaceRoot: string,
  collectionId: string,
  envName: string,
): string | null {
  const httpPath = httpPathForCollection(db, workspaceRoot, collectionId);
  if (httpPath === null) return null;
  return envFilePath(httpPath, envName);
}

// Re-export collectionFileName for convenience at call sites that already
// import from this module.
export { collectionFileName };
