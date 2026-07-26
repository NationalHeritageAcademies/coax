// =============================================================================
// Flush — write SQLite state back to disk files
// =============================================================================
//
// This module is the bridge from "we mutated the cache" to "the workspace
// folder is up to date." Two entry points:
//
//   flushCollection — re-serialize a collection's full state to its .http
//   flushEnv        — re-serialize one env's state to its sibling .env.json
//
// Both are atomic — the file either has the previous version or the new
// version, never a half-written state. Both functions are pure with respect
// to the IPC layer: they take a Db handle + ids + a target path, and do not
// know anything about workspace bootstrap, secrets resolution, or the UI.

import { Repos } from '@storage/repos';
import type { Db } from '@storage/db';
import { serializeHttpFile } from '@parser/serialize';
import type {
  BodyKind,
  HttpMethod,
  ParsedFile,
  ParsedRequest,
} from '@parser/types';
import { writeAtomic } from './atomic-write.js';
import { serializeEnvFile, type EnvVar } from './env-file.js';

// -----------------------------------------------------------------------------
// flushCollection
// -----------------------------------------------------------------------------

/**
 * Re-serialize a collection from SQLite to its `.http` file.
 *
 * Under the directories model a collection is a flat list of requests in
 * a single .http file — no internal folder hierarchy is emitted. (Any
 * legacy `@folder` directives in the cache are silently dropped here; the
 * serializer never writes them again.) Requests come out in sort_order,
 * then by name as a stable tiebreaker.
 */
export async function flushCollection(
  db: Db,
  collectionId: string,
  targetPath: string,
): Promise<void> {
  const col = Repos.Collections.get(db, collectionId);
  if (!col) throw new Error(`NOT_FOUND: collection ${collectionId}`);

  const requests = Repos.Requests.listByCollection(db, collectionId);
  const parsedRequests: ParsedRequest[] = requests.map((r) => buildParsedRequest(db, r));

  // No file-level @vars are emitted by the flush. Envs live in sibling
  // .env.json files; the .http stays request-only. If a customer wants
  // @var defaults in the file for VS Code REST Client compat, they can
  // add them by hand — Coax doesn't fight that.
  const file: ParsedFile = { variables: [], requests: parsedRequests };
  await writeAtomic(targetPath, serializeHttpFile(file));
}

function buildParsedRequest(
  db: Db,
  r: ReturnType<typeof Repos.Requests.get> & object,
): ParsedRequest {
  const req: ParsedRequest = {
    id: r.id,
    title: r.name,
    method: r.method as HttpMethod,
    url: r.url,
    headers: r.headers,
    hints: {},
    range: { startLine: 0, endLine: 0 },
  };
  if (r.chainName !== undefined) req.name = r.chainName;
  if (r.bodyText !== '' || r.bodyKind !== 'none') {
    req.body = { kind: r.bodyKind as BodyKind, raw: r.bodyText };
  }
  const overrides = Repos.RequestVarOverrides.listByRequest(db, r.id);
  if (overrides.length > 0) {
    req.overrides = overrides.map((o) =>
      o.isSecret
        ? { key: o.key, isSecret: true }
        : { key: o.key, value: o.valuePlain ?? '', isSecret: false },
    );
  }
  return req;
}

// -----------------------------------------------------------------------------
// flushEnv
// -----------------------------------------------------------------------------

/**
 * Re-serialize one env (a single `(collection, env-name)` pair) to its
 * `.env.json` file. The env JSON is flat — every var the env declares is
 * written out as one entry in `vars[]`. Collection-internal envs (e.g.
 * "From file") are flushed against the collection's root folder; the
 * .env.json file lives in the collection's directory.
 *
 * Secrets emit as `{ isSecret: true, secretId }` references — the value
 * lives in the OS keychain (or COAX_SECRET_* in CI) and is never written
 * to the file.
 */
export async function flushEnv(
  db: Db,
  collectionId: string,
  envName: string,
  targetPath: string,
): Promise<void> {
  const col = Repos.Collections.get(db, collectionId);
  if (!col) throw new Error(`NOT_FOUND: collection ${collectionId}`);

  // Source can be either a folder-scoped env at the collection root (the
  // common case — inline @vars) or a directory-scoped env at the
  // collection's directory (.env.json that's already on disk). Folder
  // scope takes priority since the file we're writing represents the
  // collection's own settings.
  const folderEnv = Repos.Envs.list(db, col.rootFolderId).find((e) => e.name === envName);
  const dirEnv = folderEnv
    ? null
    : Repos.Envs.listByDirectory(db, col.directoryId).find((e) => e.name === envName);
  const source = folderEnv ?? dirEnv;
  if (!source) {
    await writeAtomic(targetPath, serializeEnvFile({ name: envName, vars: [] }));
    return;
  }

  const vars = Repos.Vars.listByEnv(db, source.id);
  const exported: EnvVar[] = vars.map((v) =>
    v.isSecret
      ? { key: v.key, isSecret: true as const, secretId: secretIdFor(collectionId, envName, v.key) }
      : { key: v.key, valuePlain: v.valuePlain ?? '' },
  );
  await writeAtomic(targetPath, serializeEnvFile({ name: envName, vars: exported }));
}

/**
 * Re-serialize a single env (by envId) to a target path. Used for
 * directory-scoped envs where there's no anchoring collection — the env
 * row is the source of truth and we already know where to write.
 */
export async function flushEnvById(
  db: Db,
  envId: string,
  targetPath: string,
): Promise<void> {
  const env = Repos.Envs.get(db, envId);
  if (!env) throw new Error(`NOT_FOUND: env ${envId}`);
  const vars = Repos.Vars.listByEnv(db, envId);
  const anchor = env.directoryId ?? env.folderId ?? envId;
  const exported: EnvVar[] = vars.map((v) =>
    v.isSecret
      ? { key: v.key, isSecret: true as const, secretId: secretIdFor(anchor, env.name, v.key) }
      : { key: v.key, valuePlain: v.valuePlain ?? '' },
  );
  await writeAtomic(targetPath, serializeEnvFile({ name: env.name, vars: exported }));
}

/**
 * Stable per-secret identifier. The keychain entry that holds the actual
 * value uses this same id, so a teammate cloning the repo gets the env JSON
 * with a matching reference; they then add the value to their own keychain
 * the first time the request runs.
 *
 * Format keeps the collection + env + var-key in the id so the keychain
 * entry is also recognisable by humans browsing Keychain Access.app.
 */
function secretIdFor(collectionId: string, envName: string, varKey: string): string {
  return `coax:${collectionId}:${envName}:${varKey}`;
}
