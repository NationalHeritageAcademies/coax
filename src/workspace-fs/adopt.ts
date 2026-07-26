// =============================================================================
// Workspace adoption — load files from disk into the cache
// =============================================================================
//
// One direction: disk → SQLite. The reverse direction (mutate → flush)
// lives in `flush.ts`.
//
// Under the directories model, the workspace folder IS the source of
// truth for collection grouping. `adoptWorkspace` walks the folder
// recursively, creating one `directories` row per subdirectory, one
// `collections` row per `.http`, and one (directory-scoped) env per
// `.env.json`. The flat-list adopter `adoptHttpFile` is exported for
// reuse by the existing single-file import flow.

import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Repos } from '@storage/repos';
import type { Db } from '@storage/db';
import { parseHttpFile } from '@parser/parse';
import { parseEnvFile, type EnvFile, type EnvVar } from './env-file.js';
import { parseEnvFileName } from './paths.js';

export interface AdoptCollectionResult {
  collectionId: string;
  collectionName: string;
  requestsAdopted: number;
}

/**
 * Read a `.http` file from disk, parse it, and create a collection in the
 * cache attached to the given directory. Folders inside the collection are
 * materialised from `@folder` directives; `@override` directives mirror
 * into `request_var_overrides`; `@var` defaults at the top become a
 * collection-internal "From file" env attached to the collection's root
 * folder so the inline cascade keeps working.
 */
export function adoptHttpFile(
  db: Db,
  directoryId: string,
  filePath: string,
): AdoptCollectionResult {
  const text = readFileSync(filePath, 'utf8');
  const parsed = parseHttpFile(text);

  const dir = Repos.Directories.get(db, directoryId);
  if (!dir) throw new Error(`NO_DIR: directory ${directoryId} not in cache`);

  const displayName = displayNameFromFilePath(filePath);
  const collection = Repos.Collections.create(db, {
    workspaceId: dir.workspaceId,
    name: displayName,
    directoryId,
  });

  // Materialize requests at the collection root. Any `# @folder` directive
  // on a parsed request is silently dropped — under the directories model
  // grouping comes from on-disk subdirectories, not from in-file metadata.
  // Legacy data flattens cleanly on the next flush (the serializer no
  // longer emits @folder either).
  for (const r of parsed.requests) {
    const newReq = Repos.Requests.create(db, {
      collectionId: collection.id,
      folderId: collection.rootFolderId,
      name: r.title || 'Untitled',
      method: r.method,
      url: r.url,
      headers: r.headers,
      ...(r.name !== undefined ? { chainName: r.name } : {}),
      ...(r.body !== undefined ? { body: { kind: r.body.kind, raw: r.body.raw } } : {}),
    });
    for (const o of r.overrides ?? []) {
      if (o.isSecret) {
        Repos.RequestVarOverrides.upsert(db, {
          requestId: newReq.id,
          key: o.key,
          valueSecretBlob: Buffer.alloc(0),
        });
      } else {
        Repos.RequestVarOverrides.upsert(db, {
          requestId: newReq.id,
          key: o.key,
          valuePlain: o.value ?? '',
        });
      }
    }
  }

  // Inline `@vars` become a folder-scoped "From file" env attached to the
  // collection's root folder, matching what `http:import` produces.
  if (parsed.variables.length > 0) {
    const env = Repos.Envs.create(db, {
      folderId: collection.rootFolderId,
      name: 'From file',
    });
    for (const v of parsed.variables) {
      Repos.Vars.create(db, { envId: env.id, key: v.name, valuePlain: v.value });
    }
    Repos.Envs.setActive(db, env.id);
  }

  // Record hash + timestamp for fast change-detection on re-adopt. Path is
  // derived from the directory tree + name; no longer stored.
  const hash = createHash('sha256').update(text).digest('hex');
  Repos.HttpFiles.record(db, { collectionId: collection.id, hash });

  return {
    collectionId: collection.id,
    collectionName: displayName,
    requestsAdopted: parsed.requests.length,
  };
}

export interface AdoptEnvResult {
  envName: string;
  varsAdopted: number;
}

/**
 * Scope an `.env.json` adopts into. Either a directory (default — env applies
 * to everything under that directory) or a collection's root folder (the
 * filename followed the `<collection>.<env>.env.json` convention so the env
 * is scoped to that collection only). See `parseEnvFileName` in paths.ts
 * for the convention.
 */
export type AdoptEnvScope = { directoryId: string } | { folderId: string };

/**
 * Read a `.env.json` file from disk and attach it to the given scope. The
 * JSON's declared `name` is used as the env name; missing/invalid JSON
 * returns an error result rather than throwing.
 *
 * Legacy `scopes[]` format is merged into a single flat var list — the
 * directories model has no equivalent of per-scope folder paths.
 */
export function adoptEnvFile(
  db: Db,
  scope: AdoptEnvScope,
  filePath: string,
): AdoptEnvResult | { error: string } {
  const text = readFileSync(filePath, 'utf8');
  const result = parseEnvFile(text);
  if (!result.ok) {
    return { error: `${filePath}: ${result.message}` };
  }
  const env: EnvFile = result.value;

  const envRow = Repos.Envs.create(db, { ...scope, name: env.name });
  let varsAdopted = 0;
  for (const v of env.vars) {
    adoptVar(db, envRow.id, v);
    varsAdopted++;
  }
  return { envName: env.name, varsAdopted };
}

function adoptVar(db: Db, envId: string, v: EnvVar): void {
  if (v.isSecret === true) {
    Repos.Vars.create(db, { envId, key: v.key, valueSecretBlob: Buffer.alloc(0) });
    return;
  }
  Repos.Vars.create(db, { envId, key: v.key, valuePlain: v.valuePlain });
}

// -----------------------------------------------------------------------------
// Workspace walker
// -----------------------------------------------------------------------------

export interface AdoptWorkspaceResult {
  directoriesCreated: number;
  collectionsAdopted: number;
  envsAdopted: number;
  warnings: string[];
}

/**
 * Walk the workspace folder recursively, mirroring its `.http` and
 * `.env.json` files into the cache as collections + envs. The directory
 * tree is rebuilt from scratch — caller is responsible for clearing any
 * pre-existing directory rows for this workspace if they want a clean
 * adoption (the first-open path does; refresh-on-focus skips by hash).
 *
 * Hidden directories (starting with `.`), `node_modules`, and any path
 * Coax can't read are skipped silently.
 */
export function adoptWorkspace(
  db: Db,
  workspaceId: string,
  workspaceRoot: string,
): AdoptWorkspaceResult {
  const warnings: string[] = [];
  let collectionsAdopted = 0;
  let envsAdopted = 0;
  let directoriesCreated = 0;

  // Ensure a workspace root directory exists. The migration creates one
  // ('ws-root-' + workspaceId) but freshly-created workspaces (e.g. a
  // unit test that bypasses migration 006's seed) need it minted here.
  let rootDir = Repos.Directories.getRoot(db, workspaceId);
  if (!rootDir) {
    rootDir = Repos.Directories.create(db, { workspaceId, name: '' });
    directoriesCreated++;
  }

  walk(rootDir.id, workspaceRoot);
  return { directoriesCreated, collectionsAdopted, envsAdopted, warnings };

  function walk(directoryId: string, dirPath: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch (e) {
      warnings.push(`${dirPath}: ${(e as Error).message}`);
      return;
    }

    // Subdirectories first so envs in them can attach properly. Then .http
    // files (collections). Then .env.json files (directory-scoped envs at
    // THIS level). Ordering matters only insofar as it makes the warnings
    // ergonomic; data correctness is the same in any order.
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      const subPath = join(dirPath, entry.name);
      const subDir = Repos.Directories.create(db, {
        workspaceId,
        name: entry.name,
        parentDirectoryId: directoryId,
      });
      directoriesCreated++;
      walk(subDir.id, subPath);
    }

    // Adopt .http files first and remember the collection-id keyed by the
    // file's basename (without .http). The next pass uses these to bind
    // env files that follow the `<collection>.<env>.env.json` convention
    // to the right collection's root folder, instead of defaulting them to
    // the directory scope.
    const collectionsByBase = new Map<string, { collectionId: string; httpFilePath: string }>();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.http')) continue;
      const filePath = join(dirPath, entry.name);
      try {
        const result = adoptHttpFile(db, directoryId, filePath);
        collectionsByBase.set(basename(entry.name, '.http'), {
          collectionId: result.collectionId,
          httpFilePath: filePath,
        });
        collectionsAdopted++;
      } catch (e) {
        warnings.push(`${filePath}: ${(e as Error).message}`);
      }
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.env.json')) continue;
      const filePath = join(dirPath, entry.name);

      // Detect `<collection>.<env>.env.json` by walking the sibling .http
      // basenames. If matched, scope to the collection's root folder; else
      // fall back to the directory scope. Matching the longest prefix wins,
      // which avoids ambiguity if one collection's filename is a prefix of
      // another's (e.g. `users.http` vs `users-archive.http`).
      let scope: AdoptEnvScope = { directoryId };
      let bestMatchLen = -1;
      for (const [base, info] of collectionsByBase) {
        const parsed = parseEnvFileName(filePath, info.httpFilePath);
        if (parsed === null) continue;
        if (base.length > bestMatchLen) {
          const col = Repos.Collections.get(db, info.collectionId);
          if (col) {
            scope = { folderId: col.rootFolderId };
            bestMatchLen = base.length;
          }
        }
      }

      const result = adoptEnvFile(db, scope, filePath);
      if ('error' in result) {
        warnings.push(result.error);
      } else {
        envsAdopted++;
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Path helpers
// -----------------------------------------------------------------------------

function displayNameFromFilePath(filePath: string): string {
  const base = basename(filePath, '.http');
  return base
    .split(/[-_]+/)
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

