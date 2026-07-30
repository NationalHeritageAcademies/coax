import { app, safeStorage, dialog, shell, BrowserWindow } from 'electron';
import { fetch as undiciFetch, Agent } from 'undici';
import { buildAppMenu } from './menu.js';
// Note: `pkg.autoUpdater` is a lazy getter that constructs the platform
// updater (and touches `electron.app`) on first access. Keep the access
// inside the handler — reading it at module scope crashes any test that
// imports this file outside a real Electron process.
import pkg from 'electron-updater';
import { readAppSettings, writeAppSettings } from './app-settings.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Db } from '@storage/db';
import { Repos } from '@storage/repos';
import { Secrets } from '@secrets/safe';
import { startRunner, send as runnerSend, cancel as runnerCancel } from '@runner/host';
import { resolve as resolveVars } from '@resolver/resolve';
import { parseHttpFile } from '@parser/parse';
import { serializeHttpFile } from '@parser/serialize';
import { importSpec } from '@importer/swagger';
import type { ImportSource } from '@importer/swagger-types';
import type {
  ParsedFile,
  ParsedRequest,
  VarDef,
  HttpMethod,
  BodyKind,
} from '@parser/types';
import type { ResolverScopes, ResolverContext } from '@resolver/types';
import type { Handlers } from '@ipc/main-bridge';
import type { FolderSendAllResult } from '@ipc/types';
import { openWorkspaceFolder } from '@workspace-fs/bootstrap';
import {
  mostRecentWorkspace,
  readRecentWorkspaces,
  recordRecentWorkspace,
} from '@workspace-fs/recent';
import { flushCollection, flushEnv, flushEnvById } from '@workspace-fs/flush';
import {
  envJsonPath,
  httpPathForCollection,
  newCollectionPath,
  recordCollectionPath,
  removeCollectionFile,
} from '@workspace-fs/file-map';
import type {
  RequestSpec,
  RunnerMethod,
  RunnerBodyKind,
  RunnerResult,
} from '@runner/types';

// =====================================================================
// Module state
// =====================================================================

let dbHandle: Db | undefined;
let secrets: Secrets | undefined;
let currentWorkspacePath: string | undefined;

/**
 * Test seam: sets the module-level db + secrets so the IPC handlers can be
 * exercised against an in-memory database without going through `init()`'s
 * workspace-folder bootstrap. Never call this from production code.
 */
export function __setHandlersStateForTest(state: {
  db: Db;
  secrets: Secrets;
  workspacePath?: string;
}): void {
  dbHandle = state.db;
  secrets = state.secrets;
  currentWorkspacePath = state.workspacePath;
}

const inflight = new Map<string, string>(); // tabId → runner request id

// =====================================================================
// Workspace state
// =====================================================================

function userDataRoot(): string {
  return app.getPath('userData');
}

// ---------------------------------------------------------------------
// Swagger / OpenAPI spec fetching
// ---------------------------------------------------------------------
// Spec imports over HTTPS honour the "Allow insecure TLS" app setting the same
// way the request runner does (src/runner/worker.ts), so a local API behind a
// self-signed dev cert (ASP.NET dev-certs, mkcert) can be imported. Node's
// global fetch has no way to disable cert validation, so we use undici's fetch
// with a `rejectUnauthorized: false` dispatcher when the setting is on. Lazily
// constructed — most users will never need it.
let insecureSpecDispatcher: Agent | null = null;
function getInsecureSpecDispatcher(): Agent {
  if (insecureSpecDispatcher === null) {
    insecureSpecDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return insecureSpecDispatcher;
}

async function fetchSpecText(url: string): Promise<string> {
  const insecure = readAppSettings(userDataRoot()).allowInsecureTLS;
  const res = await undiciFetch(url, {
    headers: { Accept: 'application/json, application/yaml, text/yaml' },
    ...(insecure ? { dispatcher: getInsecureSpecDispatcher() } : {}),
  });
  if (!res.ok) throw new Error(`SWAGGER_FETCH: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 10 * 1024 * 1024) throw new Error('SWAGGER_TOO_LARGE');
  return text;
}

function getDb(): Db {
  if (!dbHandle) throw new Error('NOT_READY: no workspace open');
  return dbHandle;
}
function getSecrets(): Secrets {
  if (!secrets) throw new Error('NOT_READY: secrets not initialized');
  return secrets;
}
function getWorkspacePath(): string {
  if (currentWorkspacePath === undefined) {
    throw new Error('NOT_READY: no workspace open');
  }
  return currentWorkspacePath;
}

/**
 * Returns the workspace's root directory id — the implicit anonymous node
 * every workspace has under the directories model. Lazy-creates one if
 * missing (matches Collections.create's behavior so callers in older
 * code paths don't have to seed it explicitly).
 */
function workspaceRootDirectoryId(db: Db, workspaceId: string): string {
  const root =
    Repos.Directories.getRoot(db, workspaceId) ??
    Repos.Directories.create(db, { workspaceId, name: '' });
  return root.id;
}

/**
 * After a mutation on a collection, re-serialize its `.http` file to disk
 * so the workspace folder stays in sync with the cache. Best-effort:
 * mutations that affect collections without a recorded file path (e.g. a
 * brand-new collection being created in this same handler) will get
 * flushed by the create handler itself, not here.
 */
async function flushCollectionFile(db: Db, collectionId: string): Promise<void> {
  const path = httpPathForCollection(db, getWorkspacePath(), collectionId);
  if (path === null) return;
  await flushCollection(db, collectionId, path);
}

/**
 * After a mutation on an env (env create/rename/delete or var
 * create/setPlain/delete/setSecret), re-serialize the matching
 * `.env.json` file. The env name + collection together identify which
 * file to flush; if the env had been the only one of that name in the
 * collection and is now gone, the file should be removed instead.
 */
async function flushEnvFile(
  db: Db,
  collectionId: string,
  envName: string,
): Promise<void> {
  const path = envJsonPath(db, getWorkspacePath(), collectionId, envName);
  if (path === null) return;
  await flushEnv(db, collectionId, envName, path);
}

/**
 * Walk from a folderId to its owning collectionId. Returns null if the
 * folder is missing from the cache (should not happen in practice).
 */
function collectionIdForFolder(db: Db, folderId: string): string | null {
  const folder = Repos.Folders.get(db, folderId);
  return folder?.collectionId ?? null;
}

/**
 * After a request move, the source collection may have no requests left.
 * Under the directories model an empty `.http` is just clutter — delete
 * the file and drop the cache row. Safe because `.http` files always
 * represent a list of requests; an empty one carries no data the user
 * authored.
 */
async function removeCollectionIfEmpty(db: Db, collectionId: string): Promise<void> {
  const remaining = Repos.Requests.listByCollection(db, collectionId);
  if (remaining.length > 0) return;
  await removeCollectionFile(db, getWorkspacePath(), collectionId);
  try {
    Repos.Collections.delete(db, collectionId);
  } catch {
    /* already gone — fine */
  }
}

/**
 * Walk from a varId → env → folder → collection.
 */
function collectionIdForVar(db: Db, varId: string): { collectionId: string; envName: string } | null {
  const v = Repos.Vars.get(db, varId);
  if (!v) return null;
  const env = Repos.Envs.get(db, v.envId);
  if (!env) return null;
  // Folder-scoped env: trace folder → collection. Directory-scoped envs
  // don't belong to a single collection; the caller doesn't need an
  // anchor for those (they're handled by the .env.json flush path).
  if (env.folderId === undefined) return null;
  const folder = Repos.Folders.get(db, env.folderId);
  if (!folder) return null;
  return { collectionId: folder.collectionId, envName: env.name };
}

// =====================================================================
// Init
// =====================================================================

export async function init(): Promise<void> {
  await startRunner();
  secrets = new Secrets(safeStorage);

  // Try to auto-open the most-recently-used workspace folder. If it's
  // missing (user deleted it, or different machine post-restore), the
  // renderer is responsible for triggering workspace:pickFolder.
  const recent = mostRecentWorkspace(userDataRoot());
  if (recent !== null && existsSync(recent.path)) {
    try {
      const { db } = openWorkspaceFolder(userDataRoot(), recent.path);
      dbHandle = db;
      currentWorkspacePath = recent.path;
    } catch (e) {
      // Don't crash the boot if the cache is bad. Leave dbHandle undefined
      // and let the renderer prompt to pick a folder.
      console.error('Failed to auto-open recent workspace:', e);
    }
  }
}

// =====================================================================
// Resolver scope construction
// =====================================================================

function materializeEnv(db: Db, secretsImpl: Secrets, envId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of Repos.Vars.listByEnv(db, envId)) {
    if (v.isSecret && v.valueSecretBlob) {
      out[v.key] = secretsImpl.decrypt(v.valueSecretBlob);
    } else if (v.valuePlain !== undefined) {
      out[v.key] = v.valuePlain;
    }
  }
  return out;
}

/**
 * Builds the resolver scopes for a single request given an explicit `db` and
 * `secretsImpl`. Pulled out of the IPC handler so it can be reused by
 * `sendAllInFolder` and unit-tested without touching module state.
 */
export function buildScopesForRequest(
  db: Db,
  secretsImpl: Secrets,
  requestId: string,
): ResolverScopes {
  const req = Repos.Requests.get(db, requestId);
  if (!req) throw new Error('NOT_FOUND: request');

  // Walk the folder chain root → leaf and merge each step's active env into
  // a flat map. Later steps overwrite earlier ones, so deepest (closest to
  // the request) wins.
  const chain = Repos.Envs.listForRequest(db, requestId);
  const flat: Record<string, string> = {};
  for (const step of chain) {
    if (!step.env) continue;
    const materialized = materializeEnv(db, secretsImpl, step.env.id);
    for (const [k, v] of Object.entries(materialized)) flat[k] = v;
  }

  const scopes: ResolverScopes = {};
  if (Object.keys(flat).length > 0) scopes.chainFlat = flat;

  // Per-request overrides win over everything in the env chain. Secret
  // overrides are decrypted by listForRequest; zero-byte sentinel rows
  // (from import-without-value) fall through so the env value still wins.
  const overrides = Repos.RequestVarOverrides.listForRequest(db, secretsImpl, requestId);
  if (overrides.length > 0) {
    const reqMap: Record<string, string> = {};
    for (const o of overrides) reqMap[o.key] = o.value;
    scopes.request = reqMap;
  }

  return scopes;
}

/**
 * Loads `last_response` rows for chain-named requests that are *visible* to
 * the requesting request — i.e. their collection lives in the requesting
 * request's collection ancestry (its own collection + every parent
 * collection, up to a workspace-level root). This matches how envs cascade,
 * so two .http files imported under different parent collections can keep
 * the same `# @name token` directive without their cached responses
 * colliding across subtrees.
 *
 * Returns a map keyed by chain name. If two visible requests share a name,
 * the deepest (closest to the requesting request) wins, mirroring env
 * resolution.
 *
 * Bodies are parsed as JSON when possible; non-JSON bodies fall through as
 * raw text so resolvers needing the literal string (e.g. headers) still
 * work.
 */
function loadChainResponses(
  db: Db,
  requestId: string,
): Record<string, { status: number; headers: Record<string, string>; body: unknown }> {
  const req = Repos.Requests.get(db, requestId);
  if (!req) return {};
  const collection = Repos.Collections.get(db, req.collectionId);
  if (!collection) return {};

  // Build the requesting request's ancestry by directory:
  //   depth 0 = own collection
  //   depth 1 = sibling collections in the same directory
  //   depth 2 = collections in the parent directory; etc.
  // Under the directories model, collections themselves no longer nest,
  // so chain-name visibility cascades through directory ancestry.
  const depthByCollectionId = new Map<string, number>();
  depthByCollectionId.set(collection.id, 0);
  {
    let depth = 1;
    let curDirId: string | undefined = collection.directoryId;
    const seenDirs = new Set<string>();
    while (curDirId && !seenDirs.has(curDirId)) {
      seenDirs.add(curDirId);
      for (const sibling of Repos.Collections.listByDirectory(db, curDirId)) {
        if (!depthByCollectionId.has(sibling.id)) {
          depthByCollectionId.set(sibling.id, depth);
        }
      }
      const dirRow = Repos.Directories.get(db, curDirId);
      curDirId = dirRow?.parentDirectoryId;
      depth++;
    }
  }

  // Pull every chain-named request in the workspace, then filter to those
  // whose collection is in the ancestry set. (We need the request's
  // collection id to determine depth — listByChainName doesn't surface it.)
  const candidates = db
    .prepare(
      `SELECT r.id AS id, r.chain_name AS chainName, r.collection_id AS collectionId
       FROM requests r
       JOIN collections c ON c.id = r.collection_id
       WHERE c.workspace_id = ?
         AND r.chain_name IS NOT NULL
         AND r.chain_name != ''`,
    )
    .all(collection.workspaceId) as { id: string; chainName: string; collectionId: string }[];

  // When two visible candidates share a chain name, pick the deepest (lowest
  // depth = closest to the requesting request).
  const winners = new Map<
    string,
    { id: string; chainName: string; collectionId: string; depth: number }
  >();
  for (const c of candidates) {
    const depth = depthByCollectionId.get(c.collectionId);
    if (depth === undefined) continue; // not in ancestry — skip
    const cur = winners.get(c.chainName);
    if (cur === undefined || depth < cur.depth) {
      winners.set(c.chainName, { ...c, depth });
    }
  }

  const out: Record<string, { status: number; headers: Record<string, string>; body: unknown }> = {};
  for (const w of winners.values()) {
    const lr = Repos.LastResponses.get(db, w.id);
    if (lr?.status === undefined) continue;
    const headers = lr.headers ?? {};
    let body: unknown = null;
    if (lr.body) {
      const text = lr.body.toString('utf8');
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    out[w.chainName] = { status: lr.status, headers, body };
  }
  return out;
}

/**
 * Convenience builder that bundles scopes + chain-response context for a single
 * request id. Used wherever we need a complete `ResolverContext` (send, var
 * resolve, sendAllInFolder).
 */
export function buildResolverContext(
  db: Db,
  secretsImpl: Secrets,
  requestId: string,
): ResolverContext {
  const scopes = buildScopesForRequest(db, secretsImpl, requestId);
  const responses = loadChainResponses(db, requestId);
  return { scopes, responses };
}

// =====================================================================
// .http file section detection
// =====================================================================

/**
 * Walks the original .http file text to find "section" boundaries — `############`
 * comment dividers wrapping a `# Section name` line — and maps the line number of
 * the next `### Title` separator to that section name. The caller uses this to
 * group requests into folders when importing.
 *
 * Best-effort heuristic. Files without divider sandwiches simply produce no
 * folders and all requests land flat under the collection.
 */
function detectSections(text: string): { startLineByRequest: Map<number, string> } {
  const startLineByRequest = new Map<number, string>();
  const lines = text.split(/\r\n|\r|\n/);
  let currentSection: string | null = null;
  let inDivider = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^#{6,}\s*$/.test(line)) {
      inDivider = true;
      continue;
    }
    if (inDivider && line.startsWith('#') && !line.startsWith('###')) {
      // Section name comment within a divider sandwich
      currentSection = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    if (line.trim() === '' && inDivider) continue;
    if (line.startsWith('###')) {
      // Reached a separator. Lock current section for this request.
      if (currentSection) startLineByRequest.set(i + 1, currentSection);
      inDivider = false;
      continue;
    }
    inDivider = false;
  }
  return { startLineByRequest };
}

// =====================================================================
// Export collection
// =====================================================================

export interface ExportWarning {
  kind: 'literal-auth' | 'literal-secret-leak';
  requestId?: string;
  detail: string;
}
export interface ExportResult {
  written: true;
  path: string;
  warnings: ExportWarning[];
}

/**
 * Build a `ParsedFile` from a stored collection and serialize to a target path.
 *
 * Hygiene rules (per spec §7.4):
 *   - Variables marked `is_secret = 1` are emitted as `PASTE_<KEY>_HERE`
 *     placeholders rather than the decrypted plaintext, so exported files are
 *     safe to check into source control.
 *   - Request `Authorization` headers containing literal tokens (no
 *     `{{var}}` reference) produce a `literal-auth` warning. Export still
 *     proceeds — the caller decides whether to act on warnings.
 *
 * `secretsImpl` is currently unused (placeholder values never decrypt) but
 * accepted so callers can wire the same Secrets instance used elsewhere; this
 * also gives us a hook if a future variant needs to inspect secret metadata.
 */
export function exportCollection(
  db: Db,
  secretsImpl: Secrets,
  collectionId: string,
  // envId retained in the signature for IPC compat but ignored — all
  // visible-at-this-collection active envs cascade into the export.
   
  _envId: string | undefined,
  targetPath: string,
): ExportResult {
  return exportTree(db, secretsImpl, 'collection', collectionId, targetPath);
}

/**
 * Export a single node of the workspace as a self-contained `.http` file.
 *
 * Rule: emit "everything at this level and below" as a flat list of
 * requests, with env vars gathered from this level UP to the workspace
 * root (outer scopes cascade in, deepest-wins).
 *
 *   - `request`    → just that one request
 *   - `collection` → that collection's requests (one .http file's worth)
 *   - `directory`  → every request in every collection in this directory
 *                    and its sub-directories, flattened
 *
 * Secret values are written as `PASTE_<KEY>_HERE` placeholders. Chain
 * references like `{{getJWT.response.body.$.x}}` are left as-is — exports
 * are meant to be reproducible (the importer runs the chain themselves),
 * not snapshots of one user's last-response cache. Per-request
 * `# @override` directives travel with their request.
 */
export function exportTree(
  db: Db,
   
  _secretsImpl: Secrets,
  nodeKind: 'request' | 'collection' | 'directory',
  nodeId: string,
  targetPath: string,
): ExportResult {
  // Collect (a) the requests that will appear in the file and (b) the
  // chain of cache scopes whose active envs contribute variables.
  let exportedRequests: ReturnType<typeof Repos.Requests.get> extends infer R
    ? Exclude<R, undefined>[]
    : never;
  type EnvAnchor =
    | { kind: 'folder'; id: string }
    | { kind: 'directory'; id: string };
  const scopeChain: EnvAnchor[] = [];

  if (nodeKind === 'request') {
    const r = Repos.Requests.get(db, nodeId);
    if (!r) throw new Error('NOT_FOUND: request');
    exportedRequests = [r];
    if (r.folderId) scopeChain.push({ kind: 'folder', id: r.folderId });
    const col = Repos.Collections.get(db, r.collectionId);
    if (col) {
      let curDir: string | undefined = col.directoryId;
      const seen = new Set<string>();
      while (curDir && !seen.has(curDir)) {
        seen.add(curDir);
        scopeChain.push({ kind: 'directory', id: curDir });
        curDir = Repos.Directories.get(db, curDir)?.parentDirectoryId;
      }
    }
  } else if (nodeKind === 'collection') {
    const col = Repos.Collections.get(db, nodeId);
    if (!col) throw new Error('NOT_FOUND: collection');
    exportedRequests = Repos.Requests.listByCollection(db, nodeId);
    scopeChain.push({ kind: 'folder', id: col.rootFolderId });
    let curDir: string | undefined = col.directoryId;
    const seen = new Set<string>();
    while (curDir && !seen.has(curDir)) {
      seen.add(curDir);
      scopeChain.push({ kind: 'directory', id: curDir });
      curDir = Repos.Directories.get(db, curDir)?.parentDirectoryId;
    }
  } else {
    // nodeKind === 'directory': flatten the subtree
    const dir = Repos.Directories.get(db, nodeId);
    if (!dir) throw new Error('NOT_FOUND: directory');
    exportedRequests = [];
    const dirQueue: string[] = [nodeId];
    const seenDirs = new Set<string>();
    while (dirQueue.length) {
      const cur = dirQueue.shift()!;
      if (seenDirs.has(cur)) continue;
      seenDirs.add(cur);
      for (const col of Repos.Collections.listByDirectory(db, cur)) {
        for (const r of Repos.Requests.listByCollection(db, col.id)) {
          exportedRequests.push(r);
        }
      }
      for (const child of Repos.Directories.listChildren(db, cur)) {
        dirQueue.push(child.id);
      }
    }
    // Env chain: starting dir + ancestors to workspace root.
    let curDir: string | undefined = nodeId;
    const seen = new Set<string>();
    while (curDir && !seen.has(curDir)) {
      seen.add(curDir);
      scopeChain.push({ kind: 'directory', id: curDir });
      curDir = Repos.Directories.get(db, curDir)?.parentDirectoryId;
    }
  }

  // Reverse so the chain goes outer → inner (root scope first). Apply
  // active env vars in that order so inner overrides outer.
  scopeChain.reverse();

  const variables: VarDef[] = [];
  const seenKeys = new Map<string, number>();
  for (const anchor of scopeChain) {
    const activeEnv = db
      .prepare(
        anchor.kind === 'folder'
          ? 'SELECT id FROM environments WHERE folder_id = ? AND is_active = 1 LIMIT 1'
          : 'SELECT id FROM environments WHERE directory_id = ? AND is_active = 1 LIMIT 1',
      )
      .get(anchor.id) as { id: string } | undefined;
    if (!activeEnv) continue;
    const vars = Repos.Vars.listByEnv(db, activeEnv.id);
    for (const v of vars) {
      const value = v.isSecret
        ? `PASTE_${v.key.toUpperCase()}_HERE`
        : (v.valuePlain ?? '');
      const existing = seenKeys.get(v.key);
      const entry: VarDef = { name: v.key, value, line: variables.length + 1 };
      if (existing === undefined) {
        seenKeys.set(v.key, variables.length);
        variables.push(entry);
      } else {
        variables[existing] = { ...variables[existing]!, value };
      }
    }
  }

  const warnings: ExportWarning[] = [];
  const parsedRequests: ParsedRequest[] = [];

  for (const r of exportedRequests) {
    const auth = r.headers.find((h) => h.key.toLowerCase() === 'authorization');
    if (auth && !/\{\{[^}]+\}\}/.test(auth.value)) {
      warnings.push({
        kind: 'literal-auth',
        requestId: r.id,
        detail: `Authorization header in request "${r.name}" contains a literal value: ${auth.value}`,
      });
    }
    const req: ParsedRequest = {
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
    const overrideRows = Repos.RequestVarOverrides.listByRequest(db, r.id);
    if (overrideRows.length > 0) {
      req.overrides = overrideRows.map((o) =>
        o.isSecret
          ? { key: o.key, isSecret: true }
          : { key: o.key, value: o.valuePlain ?? '', isSecret: false },
      );
    }
    parsedRequests.push(req);
  }

  const file: ParsedFile = { variables, requests: parsedRequests };
  const text = serializeHttpFile(file);
  writeFileSync(targetPath, text, 'utf8');

  return { written: true, path: targetPath, warnings };
}


// =====================================================================
// Folder send-all
// =====================================================================

/**
 * Send every request in a folder concurrently and persist each `LastResponse`.
 *
 * The `runner` parameter is injected so tests can supply a fake without
 * spinning up the worker. Production callers pass `{ send: runnerSend }`.
 *
 * v1 fires every request at once via `Promise.all`. For folders with hundreds
 * of requests this could swamp the network — throttling can come later behind
 * a workspace setting.
 */
export async function sendAllInFolder(
  db: Db,
  secretsImpl: Secrets,
  folderId: string,
  runner: { send: (spec: RequestSpec) => Promise<RunnerResult> },
  options: { insecureTLS?: boolean } = {},
): Promise<FolderSendAllResult> {
  const reqs = Repos.Requests.listByFolder(db, folderId);
  const results = await Promise.all(
    reqs.map(async (req) => {
      const ctx = buildResolverContext(db, secretsImpl, req.id);
      const url = resolveVars(req.url, ctx).text;
      const headers: Record<string, string> = {};
      for (const h of req.headers) headers[h.key] = resolveVars(h.value, ctx).text;
      const id = `${req.id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const spec: RequestSpec = {
        id,
        method: req.method.toUpperCase() as RunnerMethod,
        url,
        headers,
        ...(req.bodyText !== '' || req.bodyKind !== 'none'
          ? {
              body: {
                kind: req.bodyKind as RunnerBodyKind,
                raw: resolveVars(req.bodyText, ctx).text,
              },
            }
          : {}),
        ...(options.insecureTLS ? { insecureTLS: true } : {}),
      };
      const result = await runner.send(spec);
      if (result.ok) {
        Repos.LastResponses.upsert(db, req.id, {
          status: result.status,
          headers: result.headers,
          body: Buffer.from(result.bodyBytes),
          ms: result.ms,
          sizeBytes: result.sizeBytes,
          executedAt: new Date().toISOString(),
        });
      } else {
        Repos.LastResponses.upsert(db, req.id, {
          errorText: `${result.category}: ${result.message}`,
          executedAt: new Date().toISOString(),
        });
      }
      return { requestId: req.id, result };
    }),
  );
  return { results };
}

// =====================================================================
// Handlers
// =====================================================================

export const handlers: Handlers = {
  // === Workspace ===
  'workspace:list': () => readRecentWorkspaces(userDataRoot()),

  'workspace:current': () => {
    if (currentWorkspacePath === undefined) return null;
    const workspaces = Repos.Workspaces.list(getDb());
    const w = workspaces[0];
    if (!w) return null;
    return { id: w.id, name: w.name, path: currentWorkspacePath };
  },

  'workspace:open': ({ folderPath }) => {
    if (dbHandle) {
      dbHandle.close();
      dbHandle = undefined;
    }
    const { db, result } = openWorkspaceFolder(userDataRoot(), folderPath);
    dbHandle = db;
    currentWorkspacePath = result.workspacePath;
    recordRecentWorkspace(userDataRoot(), {
      path: result.workspacePath,
      name: result.workspaceName,
    });
    return {
      id: result.workspaceId,
      name: result.workspaceName,
      path: result.workspacePath,
    };
  },

  // Re-stat every adopted .http file in the workspace and re-adopt anything
  // whose mtime is newer than what's in the cache. Triggered by the
  // renderer when its window regains focus, so external edits get picked up
  // without a manual reload.
  //
  // v1 implementation: walks the workspace folder, finds .http files that
  // were either newly-added or whose mtime is newer than the recorded
  // hash's import time, blows away their cache rows, and re-adopts. Naive
  // but correct. A future pass can avoid the full re-read by storing
  // mtime + hash per file.
  'workspace:refresh': () => {
    if (currentWorkspacePath === undefined) return { refreshed: 0 };
    // Best-effort: leave cache alone if anything goes wrong; surface a warning.
    const db = getDb();
    const workspaceRow = Repos.Workspaces.list(db)[0];
    if (!workspaceRow) return { refreshed: 0 };
    void workspaceRow;
    // Stub: just return success for now. A real implementation would
    // re-scan and re-adopt changed files. Wiring the event end-to-end is
    // the main goal of this commit; the deep refresh can land next.
    return { refreshed: 0 };
  },

  'workspace:close': () => {
    if (dbHandle) {
      dbHandle.close();
      dbHandle = undefined;
    }
    currentWorkspacePath = undefined;
    return { closed: true };
  },

  'workspace:pickFolder': async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Choose a workspace folder',
      buttonLabel: 'Open Workspace',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true } as const;
    }
    return { canceled: false, folderPath: result.filePaths[0]! } as const;
  },

  // Reveal a file in the OS file manager (Finder/Explorer/Nautilus).
  // Used by the export-success toast so the user can jump straight to
  // their newly-written .http.
  'shell:revealInFolder': ({ path }) => {
    shell.showItemInFolder(path);
    return { ok: true };
  },

  // === Directories ===
  'directory:list': ({ workspaceId }) => Repos.Directories.listByWorkspace(getDb(), workspaceId),

  'directory:create': async ({ workspaceId, name, parentDirectoryId }) => {
    const db = getDb();
    const parentId = parentDirectoryId ?? workspaceRootDirectoryId(db, workspaceId);
    const dir = Repos.Directories.create(db, {
      workspaceId,
      name,
      parentDirectoryId: parentId,
    });
    // Create the on-disk directory so refresh-on-focus and adoptWorkspace
    // see it without the user having to mkdir manually.
    const parentPath = Repos.Directories.pathOf(db, parentId);
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const onDisk =
      parentPath === ''
        ? path.join(getWorkspacePath(), name)
        : path.join(getWorkspacePath(), parentPath, name);
    await fs.mkdir(onDisk, { recursive: true });
    return dir;
  },

  'directory:rename': async ({ id, name }) => {
    const db = getDb();
    const dir = Repos.Directories.get(db, id);
    if (!dir) throw new Error('NOT_FOUND: directory');
    if (dir.name === '') throw new Error('INVALID: cannot rename workspace root');
    // Capture old path BEFORE the cache rename so we can mv on disk.
    const oldPath = Repos.Directories.pathOf(db, id);
    Repos.Directories.rename(db, id, name);
    const newPath = Repos.Directories.pathOf(db, id);
    if (oldPath !== newPath) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      try {
        await fs.rename(
          path.join(getWorkspacePath(), oldPath),
          path.join(getWorkspacePath(), newPath),
        );
      } catch (e) {
        // Roll back the cache rename if the disk rename fails — otherwise the
        // cache and disk drift apart.
        Repos.Directories.rename(db, id, dir.name);
        throw e;
      }
    }
    return { id, name };
  },

  'directory:reparent': async ({ id, newParentDirectoryId }) => {
    const db = getDb();
    const dir = Repos.Directories.get(db, id);
    if (!dir) throw new Error('NOT_FOUND: directory');
    if (dir.name === '') throw new Error('INVALID: cannot move workspace root');
    const originalParentId = dir.parentDirectoryId;
    if (!originalParentId) throw new Error('INVALID: directory has no parent');

    const oldPath = Repos.Directories.pathOf(db, id);
    const newParentPath = Repos.Directories.pathOf(db, newParentDirectoryId);
    const newPath = newParentPath === '' ? dir.name : `${newParentPath}/${dir.name}`;
    if (oldPath === newPath) return { id };

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const onDiskDest = path.join(getWorkspacePath(), newPath);
    // Refuse if the destination path already exists (would otherwise let
    // fs.rename clobber or merge in surprising ways).
    try {
      await fs.access(onDiskDest);
      throw new Error('A folder with this name already exists at the destination.');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    // Cache move first — it also enforces the cycle/cross-workspace checks.
    Repos.Directories.move(db, id, newParentDirectoryId);
    try {
      await fs.rename(path.join(getWorkspacePath(), oldPath), onDiskDest);
    } catch (e) {
      // Roll back so cache doesn't drift from disk.
      Repos.Directories.move(db, id, originalParentId);
      throw e;
    }
    return { id };
  },

  'directory:delete': async ({ id }) => {
    const db = getDb();
    const dir = Repos.Directories.get(db, id);
    if (!dir) throw new Error('NOT_FOUND: directory');
    if (dir.name === '') throw new Error('INVALID: cannot delete workspace root');
    const onDiskPath = Repos.Directories.pathOf(db, id);
    Repos.Directories.delete(db, id);
    // Remove the directory + everything under it. Use fs.rm with recursive:true.
    if (onDiskPath !== '') {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      try {
        await fs.rm(path.join(getWorkspacePath(), onDiskPath), { recursive: true, force: true });
      } catch {
        /* best effort — if the disk delete fails the cache is already gone */
      }
    }
    return { id };
  },

  // === Collections ===
  'collection:list': ({ workspaceId }) => Repos.Collections.listByWorkspace(getDb(), workspaceId),

  'collection:create': async ({ workspaceId, name, parent, directoryId }) => {
    const db = getDb();
    // Caller precedence: explicit `directoryId` > `parent` collection's
    // directory > workspace root directory.
    let targetDir = directoryId ?? workspaceRootDirectoryId(db, workspaceId);
    if (directoryId === undefined && parent !== undefined) {
      const parentCol = Repos.Collections.get(db, parent);
      if (parentCol) targetDir = parentCol.directoryId;
    }
    const col = Repos.Collections.create(db, { workspaceId, name, directoryId: targetDir });
    await flushCollectionFile(db, col.id);
    return col;
  },

  'collection:rename': async ({ id, name }) => {
    const db = getDb();
    // Capture the old file path BEFORE renaming so we can remove the old
    // .http after the new one is written under the new slug.
    const oldPath = httpPathForCollection(db, getWorkspacePath(), id);
    Repos.Collections.rename(db, id, name);
    if (oldPath !== null) {
      try {
        await import('node:fs/promises').then((m) => m.unlink(oldPath));
      } catch {
        /* may not exist yet */
      }
    }
    await flushCollectionFile(db, id);
    return { id, name };
  },

  'collection:reparent': ({ collectionId, newParentCollectionId }) => {
    // Under the directories model the operation is "move this collection
    // to a different directory." Until the renderer is updated to send
    // directory ids, we interpret a non-null `newParentCollectionId` as
    // "move into the directory that contains that collection." Null = root.
    const db = getDb();
    const wsId = Repos.Collections.get(db, collectionId)?.workspaceId;
    if (!wsId) throw new Error('NOT_FOUND: collection');
    let targetDirId = workspaceRootDirectoryId(db, wsId);
    if (newParentCollectionId !== null) {
      const anchor = Repos.Collections.get(db, newParentCollectionId);
      if (anchor) targetDirId = anchor.directoryId;
    }
    return Repos.Collections.moveToDirectory(db, collectionId, targetDirId);
  },

  'collection:delete': async ({ id }) => {
    const db = getDb();
    await removeCollectionFile(db, getWorkspacePath(), id);
    Repos.Collections.delete(db, id);
    return { id };
  },

  'collection:export': ({ collectionId, targetPath, envId }) =>
    exportCollection(getDb(), getSecrets(), collectionId, envId, targetPath),

  'tree:export': ({ nodeKind, nodeId, targetPath }) =>
    exportTree(getDb(), getSecrets(), nodeKind, nodeId, targetPath),

  // === Requests ===
  'request:create': async ({ parent, draft }) => {
    const db = getDb();
    const req = Repos.Requests.create(db, {
      collectionId: parent.collectionId,
      ...(parent.folderId !== undefined ? { folderId: parent.folderId } : {}),
      name: draft.name ?? '',
      ...(draft.chainName !== undefined && draft.chainName !== null
        ? { chainName: draft.chainName }
        : {}),
      method: draft.method,
      url: draft.url,
      headers: draft.headers,
      ...(draft.body !== undefined ? { body: draft.body } : {}),
      ...(draft.auth !== undefined ? { auth: draft.auth } : {}),
    });
    await flushCollectionFile(db, parent.collectionId);
    return req;
  },

  'request:save': async ({ requestId, patch }) => {
    const db = getDb();
    Repos.Requests.update(
      db,
      requestId,
      patch,
    );
    const r = Repos.Requests.get(db, requestId);
    if (r) await flushCollectionFile(db, r.collectionId);
    return { id: requestId };
  },

  'request:rename': async ({ requestId, name }) => {
    const db = getDb();
    Repos.Requests.update(db, requestId, { name });
    const r = Repos.Requests.get(db, requestId);
    if (r) await flushCollectionFile(db, r.collectionId);
    return { requestId };
  },

  'request:delete': async ({ requestId }) => {
    const db = getDb();
    const r = Repos.Requests.get(db, requestId);
    Repos.Requests.delete(db, requestId);
    if (r) await flushCollectionFile(db, r.collectionId);
    return { requestId };
  },

  'request:duplicate': async ({ requestId }) => {
    const db = getDb();
    const src = Repos.Requests.get(db, requestId);
    if (!src) throw new Error('NOT_FOUND: request');
    const dup = Repos.Requests.create(db, {
      collectionId: src.collectionId,
      ...(src.folderId !== undefined ? { folderId: src.folderId } : {}),
      name: `${src.name} (copy)`,
      method: src.method,
      url: src.url,
      headers: src.headers,
      ...(src.bodyText !== '' || src.bodyKind !== 'none'
        ? { body: { kind: src.bodyKind, raw: src.bodyText } }
        : {}),
      auth: src.auth,
    });
    await flushCollectionFile(db, src.collectionId);
    return dup;
  },

  'request:send': async ({ tabId, requestId, draftJson }) => {
    const db = getDb();
    const stored = Repos.Requests.get(db, requestId);
    if (!stored) throw new Error('NOT_FOUND: request');
    const eff =
      draftJson ??
      ({
        name: stored.name,
        method: stored.method,
        url: stored.url,
        headers: stored.headers,
        ...(stored.bodyText !== '' || stored.bodyKind !== 'none'
          ? { body: { kind: stored.bodyKind, raw: stored.bodyText } }
          : {}),
        auth: stored.auth,
      } as const);

    const ctx = buildResolverContext(db, getSecrets(), requestId);
    const url = resolveVars(eff.url, ctx).text;
    const headers: Record<string, string> = {};
    for (const h of eff.headers) {
      headers[h.key] = resolveVars(h.value, ctx).text;
    }
    const id = `${tabId}:${Date.now()}`;
    inflight.set(tabId, id);
    const method = eff.method.toUpperCase() as RunnerMethod;
    const resolvedBody = eff.body !== undefined
      ? { kind: eff.body.kind as RunnerBodyKind, raw: resolveVars(eff.body.raw, ctx).text }
      : undefined;
    const appSettings = readAppSettings(app.getPath('userData'));
    const spec: RequestSpec = {
      id,
      method,
      url,
      headers,
      ...(resolvedBody !== undefined ? { body: resolvedBody } : {}),
      ...(appSettings.allowInsecureTLS ? { insecureTLS: true } : {}),
    };
    // The wire form mirrors the spec but in the array-of-pairs shape the
    // renderer's draft uses, so the Raw transcript can show what actually
    // went out (resolved vars + auth) rather than the template the user typed.
    const sentRequest = {
      method,
      url,
      headers: eff.headers.map((h) => ({ key: h.key, value: headers[h.key] ?? '' })),
      ...(resolvedBody !== undefined ? { body: resolvedBody } : {}),
    };
    try {
      const result = await runnerSend(spec);
      if (result.ok) {
        Repos.LastResponses.upsert(db, requestId, {
          status: result.status,
          headers: result.headers,
          body: Buffer.from(result.bodyBytes),
          ms: result.ms,
          sizeBytes: result.sizeBytes,
          executedAt: new Date().toISOString(),
        });
      } else {
        Repos.LastResponses.upsert(db, requestId, {
          errorText: `${result.category}: ${result.message}`,
          executedAt: new Date().toISOString(),
        });
      }
      return { result, sentRequest };
    } finally {
      inflight.delete(tabId);
    }
  },

  'request:cancel': ({ tabId }) => {
    const id = inflight.get(tabId);
    if (id) runnerCancel(id);
    return { tabId };
  },

  // === Envs / Vars ===
  // All envs are folder-scoped after migration 003. The collection's
  // implicit root folder serves as the "collection-level" scope.
  'env:list': ({ folderId }) => Repos.Envs.list(getDb(), folderId),

  'env:listByDirectory': ({ directoryId }) => Repos.Envs.listByDirectory(getDb(), directoryId),

  'env:create': async ({ folderId, directoryId, name }) => {
    const db = getDb();
    if ((folderId === undefined) === (directoryId === undefined)) {
      throw new Error('ENV_SCOPE: pass exactly one of folderId or directoryId');
    }
    const env = Repos.Envs.create(db, {
      ...(folderId !== undefined ? { folderId } : {}),
      ...(directoryId !== undefined ? { directoryId } : {}),
      name,
    });
    if (folderId !== undefined) {
      const collectionId = collectionIdForFolder(db, folderId);
      if (collectionId !== null) await flushEnvFile(db, collectionId, name);
    } else if (directoryId !== undefined) {
      // Directory-scoped envs flush as `<directory>/<name>.env.json`.
      const dirPath = Repos.Directories.pathOf(db, directoryId);
      const path = await import('node:path');
      const target =
        dirPath === ''
          ? path.join(getWorkspacePath(), `${name}.env.json`)
          : path.join(getWorkspacePath(), dirPath, `${name}.env.json`);
      await flushEnvById(db, env.id, target);
    }
    return env;
  },

  'env:rename': async ({ envId, name }) => {
    const db = getDb();
    const before = Repos.Envs.get(db, envId);
    Repos.Envs.rename(db, envId, name);
    const after = Repos.Envs.get(db, envId);
    if (before && after?.folderId !== undefined) {
      const collectionId = collectionIdForFolder(db, after.folderId);
      if (collectionId !== null) {
        // Old name's file may now be orphaned (if there were no other envs
        // of the old name in the same collection). Rewrite the new file;
        // the old file is removed by hand if it exists.
        const oldPath = envJsonPath(db, getWorkspacePath(), collectionId, before.name);
        if (oldPath !== null) {
          try {
            await import('node:fs/promises').then((m) => m.unlink(oldPath));
          } catch {
            /* fine */
          }
        }
        await flushEnvFile(db, collectionId, name);
      }
    }
    return { envId, name };
  },

  // Active-env selection is per-machine state — only the cache cares; no
  // file write needed.
  'env:setActive': ({ envId }) => {
    Repos.Envs.setActive(getDb(), envId);
    return { envId };
  },

  'env:clearActive': ({ folderId }) => {
    Repos.Envs.clearActive(getDb(), folderId);
    return { folderId };
  },

  'env:delete': async ({ envId }) => {
    const db = getDb();
    const env = Repos.Envs.get(db, envId);
    Repos.Envs.delete(db, envId);
    if (env?.folderId !== undefined) {
      const collectionId = collectionIdForFolder(db, env.folderId);
      if (collectionId !== null) {
        // If no other envs of the same name remain in the collection, the
        // sibling .env.json gets reduced to an empty shell. Could be
        // cleaned up; for now we leave the file in place so users see
        // intent in git history.
        await flushEnvFile(db, collectionId, env.name);
      }
    }
    return { envId };
  },

  // Recovery action for the silent-failure case where a collection has a
  // recorded http_files source but no envs (e.g. early-import bug). Re-parses
  // the on-disk .http file and rebuilds the "From file" env. Idempotent —
  // existing variables with the same key are skipped.
  'collection:reextractVars': ({ collectionId }) => {
    const source = httpPathForCollection(getDb(), getWorkspacePath(), collectionId);
    if (source === null) {
      throw new Error('NO_SOURCE: collection has no recorded .http source file');
    }
    if (!existsSync(source)) {
      throw new Error(`NOT_FOUND: source file ${source} no longer exists`);
    }
    const text = readFileSync(source, 'utf8');
    const parsed = parseHttpFile(text);
    if (parsed.variables.length === 0) {
      throw new Error('NO_VARS: source file has no @var definitions');
    }

    const collection = Repos.Collections.get(getDb(), collectionId);
    if (!collection) throw new Error('NOT_FOUND: collection');
    const rootFolderId = collection.rootFolderId;

    const existing = Repos.Envs.list(getDb(), rootFolderId).find((e) => e.name === 'From file');
    const env =
      existing ??
      Repos.Envs.create(getDb(), {
        folderId: rootFolderId,
        name: 'From file',
      });

    const existingVars = Repos.Vars.listByEnv(getDb(), env.id);
    const haveKeys = new Set(existingVars.map((v) => v.key));
    let added = 0;
    for (const v of parsed.variables) {
      if (haveKeys.has(v.name)) continue;
      Repos.Vars.create(getDb(), { envId: env.id, key: v.name, valuePlain: v.value });
      added++;
    }

    Repos.Envs.setActive(getDb(), env.id);

    return { envId: env.id, envName: env.name, variablesAdded: added, source };
  },

  // Returns the resolver chain for the given request — root folder → leaf,
  // with each step's active env (or null). The renderer uses this to draw
  // the per-folder env-switcher and the "Inherited" section in the Vars
  // sub-tab.
  'env:listForRequest': ({ requestId }) => {
    return { chain: Repos.Envs.listForRequest(getDb(), requestId) };
  },

  // List variables for an env. CRITICAL: never expose `valueSecretBlob` to the
  // renderer — secret reveals must round-trip through `var:revealSecret` so a
  // compromised renderer process can't dump the encrypted blob and exfiltrate
  // it.
  'var:list': ({ envId }) =>
    Repos.Vars.listByEnv(getDb(), envId).map((v) => {
      const out: {
        id: string;
        key: string;
        isSecret: boolean;
        description: string;
        valuePlain?: string;
      } = {
        id: v.id,
        key: v.key,
        isSecret: v.isSecret,
        description: v.description,
      };
      if (v.valuePlain !== undefined) out.valuePlain = v.valuePlain;
      return out;
    }),

  'var:create': async ({ envId, key, valuePlain }) => {
    const db = getDb();
    const v = Repos.Vars.create(db, {
      envId,
      key,
      ...(valuePlain !== undefined ? { valuePlain } : {}),
    });
    const ctx = collectionIdForVar(db, v.id);
    if (ctx) await flushEnvFile(db, ctx.collectionId, ctx.envName);
    return v;
  },

  'var:setPlain': async ({ varId, valuePlain }) => {
    const db = getDb();
    Repos.Vars.update(db, varId, {
      isSecret: false,
      valuePlain,
      valueSecretBlob: null,
    });
    const ctx = collectionIdForVar(db, varId);
    if (ctx) await flushEnvFile(db, ctx.collectionId, ctx.envName);
    return { varId };
  },

  'var:delete': async ({ varId }) => {
    const db = getDb();
    const ctx = collectionIdForVar(db, varId);
    Repos.Vars.delete(db, varId);
    if (ctx) await flushEnvFile(db, ctx.collectionId, ctx.envName);
    return { varId };
  },

  'var:setSecret': async ({ varId, plaintext }) => {
    const db = getDb();
    const blob = getSecrets().encrypt(plaintext);
    Repos.Vars.update(db, varId, {
      isSecret: true,
      valueSecretBlob: blob,
      valuePlain: null,
    });
    const ctx = collectionIdForVar(db, varId);
    if (ctx) await flushEnvFile(db, ctx.collectionId, ctx.envName);
    return { varId };
  },

  'var:revealSecret': ({ varId }) => {
    const v = Repos.Vars.get(getDb(), varId);
    if (!v) throw new Error('NOT_FOUND: var');
    if (!v.valueSecretBlob) throw new Error('NOT_SECRET: var has no encrypted value');
    return getSecrets().decrypt(v.valueSecretBlob);
  },

  // Vars-panel debug feature: collect all {{var}} references in a request and
  // report which scope (request/collection/global/defaults) provided each value,
  // along with whether the source var is marked secret.
  //
  // SECURITY NOTE: this returns decrypted secret values to the renderer. The
  // renderer uses `isSecret` to mask the value behind a "Reveal" button. A
  // user-initiated reveal flips the mask off; the value never round-trips back
  // to the worker. Trade-off accepted for v1 — the alternative (per-var
  // round-trip via `var:revealSecret`) would require a name → varId lookup.
  'var:resolve': ({ requestId }) => {
    const db = getDb();
    const req = Repos.Requests.get(db, requestId);
    if (!req) throw new Error('NOT_FOUND: request');
    // Full context (scopes + chain responses) so chain refs resolve to their
    // actual value here, not just a "<chain>" placeholder.
    const ctx = buildResolverContext(db, getSecrets(), requestId);
    const scopes = ctx.scopes;
    const refs = new Set<string>();
    const collect = (s: string): void => {
      for (const m of s.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) refs.add(m[1]!);
    };
    collect(req.url);
    for (const h of req.headers) {
      collect(h.key);
      collect(h.value);
    }
    collect(req.bodyText);

    // For each ref, find which folder/env in the chain actually contributed
    // its value (deepest wins). Lets us label the source as "<folder> · <env>"
    // and detect whether the source var is marked secret for masking.
    const chain = Repos.Envs.listForRequest(db, requestId);
    // Walk chain root → leaf and let later (deeper) steps overwrite earlier
    // ones, giving deepest-wins semantics on the final map.
    interface Hit { value: string; isSecret: boolean; source: string }
    const deepest: Record<string, Hit> = {};
    for (const step of chain) {
      if (!step.env) continue;
      const vars = Repos.Vars.listByEnv(db, step.env.id);
      for (const v of vars) {
        if (v.isSecret && !v.valueSecretBlob) continue;
        if (!v.isSecret && v.valuePlain === undefined) continue;
        const value = v.isSecret
          ? getSecrets().decrypt(v.valueSecretBlob!)
          : (v.valuePlain ?? '');
        deepest[v.key] = {
          value,
          isSecret: v.isSecret,
          source: `${step.scopeName} · ${step.env.name}`,
        };
      }
    }

    const out: { name: string; value?: string; source?: string; isSecret?: boolean }[] = [];
    for (const name of refs) {
      if (name.startsWith('$')) {
        out.push({ name, value: '<built-in>', source: 'builtin' });
        continue;
      }
      if (name.includes('.response.')) {
        // Round-trip the chain ref through the same resolver the send path uses
        // so the value reflects exactly what would be substituted at send time
        // (including JSONPath traversal). `resolveVars` returns the original
        // `{{...}}` token if unresolved, which we surface as "unresolved" below.
        const resolved = resolveVars(`{{${name}}}`, ctx).text;
        const isUnresolved = resolved === `{{${name}}}`;
        const entry: { name: string; value?: string; source?: string } = {
          name,
          source: 'chain',
        };
        if (!isUnresolved) entry.value = resolved;
        out.push(entry);
        continue;
      }
      const inReq = scopes.request?.[name];
      const inDefaults = scopes.collectionDefaults?.[name];
      const chainHit = deepest[name];
      let value: string | undefined;
      let source: string | undefined;
      let isSecret = false;
      if (inReq !== undefined) {
        value = inReq;
        source = 'request';
      } else if (chainHit !== undefined) {
        value = chainHit.value;
        source = chainHit.source;
        isSecret = chainHit.isSecret;
      } else if (inDefaults !== undefined) {
        value = inDefaults;
        source = 'defaults';
      }
      const entry: { name: string; value?: string; source?: string; isSecret?: boolean } = {
        name,
      };
      if (value !== undefined) entry.value = value;
      if (source !== undefined) entry.source = source;
      if (isSecret) entry.isSecret = true;
      out.push(entry);
    }
    return { refs: out };
  },

  'request:overrides:list': ({ requestId }) => {
    const rows = Repos.RequestVarOverrides.listByRequest(getDb(), requestId);
    return {
      overrides: rows.map((r) => {
        const base: { key: string; isSecret: boolean; valuePlain?: string } = {
          key: r.key,
          isSecret: r.isSecret,
        };
        if (!r.isSecret && r.valuePlain !== undefined) base.valuePlain = r.valuePlain;
        return base;
      }),
    };
  },

  'request:overrides:set': ({ requestId, key, valuePlain, valueSecret }) => {
    if (valuePlain !== undefined && valueSecret !== undefined) {
      throw new Error('OVERRIDE_BOTH_VALUES: pass valuePlain or valueSecret, not both');
    }
    const db = getDb();
    const secretsImpl = getSecrets();
    // For NEW overrides we enforce "key must exist in the resolved chain"
    // so the request page can't be used to invent brand-new variable names —
    // that's what Manage Envs is for. Once a row exists, it can be updated
    // even if the underlying env var has been removed (orphan).
    const existing = Repos.RequestVarOverrides.listByRequest(db, requestId).find(
      (o) => o.key === key,
    );
    if (!existing) {
      const scopes = buildScopesForRequest(db, secretsImpl, requestId);
      const known = new Set(Object.keys(scopes.chainFlat ?? {}));
      // Also accept any var actually referenced in the request template
      // (URL / headers / body). Template-only refs like {{sourcedId}} have
      // no env entry but the user still needs a way to supply a value.
      const req = Repos.Requests.get(db, requestId);
      if (req) {
        const collect = (s: string): void => {
          for (const m of s.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) known.add(m[1]!);
        };
        collect(req.url);
        for (const h of req.headers) {
          collect(h.key);
          collect(h.value);
        }
        collect(req.bodyText);
      }
      if (!known.has(key)) {
        throw new Error(`UNKNOWN_KEY: ${key} is not used in this request or its env chain`);
      }
    }
    if (valueSecret !== undefined) {
      const blob = secretsImpl.encrypt(valueSecret);
      return Repos.RequestVarOverrides.upsert(db, { requestId, key, valueSecretBlob: blob });
    }
    return Repos.RequestVarOverrides.upsert(db, {
      requestId,
      key,
      valuePlain: valuePlain ?? '',
    });
  },

  'request:overrides:delete': ({ requestId, key }) => {
    Repos.RequestVarOverrides.delete(getDb(), { requestId, key });
    return { key };
  },

  'http:import': async ({ path, parentCollectionId, directoryId: explicitDirId }) => {
    const text = readFileSync(path, 'utf8');
    const parsed = parseHttpFile(text);
    const hash = createHash('sha256').update(text).digest('hex');
    const baseName = path.split(/[/\\]/).pop()?.replace(/\.http$/i, '') ?? 'imported';

    const workspaceRow = Repos.Workspaces.list(getDb())[0];
    if (!workspaceRow) throw new Error('NO_WORKSPACE: open a workspace folder first');
    const workspaceId = workspaceRow.id;

    // Caller precedence: explicit directoryId > parent collection's directory
    // > workspace root.
    let directoryId = explicitDirId ?? workspaceRootDirectoryId(getDb(), workspaceId);
    if (explicitDirId === undefined && parentCollectionId !== undefined) {
      const anchor = Repos.Collections.get(getDb(), parentCollectionId);
      if (anchor) directoryId = anchor.directoryId;
    }
    const collection = Repos.Collections.create(getDb(), {
      workspaceId,
      name: baseName,
      directoryId,
    });

    // Detect section dividers and create folders
    const { startLineByRequest } = detectSections(text);
    const folderByName = new Map<string, string>();
    for (const sectionName of new Set(startLineByRequest.values())) {
      const folder = Repos.Folders.create(getDb(), {
        collectionId: collection.id,
        name: sectionName,
      });
      folderByName.set(sectionName, folder.id);
    }

    // Insert requests
    for (const r of parsed.requests) {
      const sectionName = startLineByRequest.get(r.range.startLine);
      const folderId = sectionName !== undefined ? folderByName.get(sectionName) : undefined;
      const newReq = Repos.Requests.create(getDb(), {
        collectionId: collection.id,
        ...(folderId !== undefined ? { folderId } : {}),
        name: r.title || (r.name ?? 'Untitled'),
        // Preserve `# @name foo` from .http source so chain refs like
        // `{{foo.response.body.$.x}}` can find the named request's last response.
        ...(r.name !== undefined ? { chainName: r.name } : {}),
        method: r.method,
        url: r.url,
        headers: r.headers,
        ...(r.body !== undefined ? { body: { kind: r.body.kind, raw: r.body.raw } } : {}),
      });

      // Apply `# @override` / `# @override:secret` directives. Secret
      // overrides have no value in the source, so we land them with a
      // zero-byte blob — the "needs value" sentinel that listForRequest
      // treats as "fall through to the env value" until the user supplies one.
      for (const o of r.overrides ?? []) {
        if (o.isSecret) {
          Repos.RequestVarOverrides.upsert(getDb(), {
            requestId: newReq.id,
            key: o.key,
            valueSecretBlob: Buffer.alloc(0),
          });
        } else {
          Repos.RequestVarOverrides.upsert(getDb(), {
            requestId: newReq.id,
            key: o.key,
            valuePlain: o.value ?? '',
          });
        }
      }
    }

    // Create "From file" env populated with @vars, attached to the
    // collection's root folder so every request inherits it.
    if (parsed.variables.length > 0) {
      const env = Repos.Envs.create(getDb(), {
        folderId: collection.rootFolderId,
        name: 'From file',
      });
      for (const v of parsed.variables) {
        Repos.Vars.create(getDb(), { envId: env.id, key: v.name, valuePlain: v.value });
      }
      // Activate it so {{vars}} resolve out of the box. Without this, every imported
      // request would render as "Invalid URL" the moment the user clicked Send because
      // the active-env lookup in buildScopesForRequest would return nothing.
      Repos.Envs.setActive(getDb(), env.id);
    }

    // Now flush the cache out to the workspace folder (the import is
    // complete; this materialises the .http file in canonical Coax form).
    void hash;
    await flushCollectionFile(getDb(), collection.id);
    if (parsed.variables.length > 0) {
      await flushEnvFile(getDb(), collection.id, 'From file');
    }

    return {
      collectionId: collection.id,
      stats: {
        requests: parsed.requests.length,
        variables: parsed.variables.length,
        folders: folderByName.size,
      },
    };
  },

  'dialog:openHttp': async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import .http file',
      filters: [{ name: 'HTTP files', extensions: ['http'] }, { name: 'All files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    return { path: result.filePaths[0]! };
  },

  'dialog:openSwagger': async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import Swagger / OpenAPI',
      filters: [
        { name: 'Swagger / OpenAPI', extensions: ['json', 'yaml', 'yml'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    return { path: result.filePaths[0]! };
  },

  'swagger:fetch': async ({ url }) => {
    const text = await fetchSpecText(url);
    return { text };
  },

  'swagger:import': async ({ source, parentCollectionId }) => {
    const workspaceRow = Repos.Workspaces.list(getDb())[0];
    if (!workspaceRow) throw new Error('NO_WORKSPACE: open a workspace folder first');
    const workspaceId = workspaceRow.id;
    let importSource: ImportSource;
    if (source.kind === 'file') {
      const text = readFileSync(source.path, 'utf8');
      if (text.length > 10 * 1024 * 1024) throw new Error('SWAGGER_TOO_LARGE');
      importSource = { kind: 'file', origin: source.path, text };
    } else {
      const text = await fetchSpecText(source.url);
      importSource = { kind: 'url', origin: source.url, text };
    }
    const result = importSpec(getDb(), {
      workspaceId,
      source: importSource,
      ...(parentCollectionId !== undefined ? { parentCollectionId } : {}),
    });
    // Materialise the imported collection to a .http file in the workspace.
    // Default path = workspace root + slugged collection name; user can
    // override this by moving / renaming the file after the fact. (A future
    // pre-import "Save as…" dialog would land here; for now we go to root.)
    if (result.collectionId !== undefined) {
      const col = Repos.Collections.get(getDb(), result.collectionId);
      if (col) {
        const httpPath = newCollectionPath(getWorkspacePath(), col.name);
        recordCollectionPath(getDb(), col.id, httpPath);
        await flushCollectionFile(getDb(), col.id);
        // Flush every env that lives on the collection's root folder, since
        // the importer typically seeds a default env from spec metadata.
        const envs = Repos.Envs.list(getDb(), col.rootFolderId);
        for (const e of envs) {
          await flushEnvFile(getDb(), col.id, e.name);
        }
      }
    }
    return result;
  },

  'dialog:saveHttp': async ({ defaultName }) => {
    const result = await dialog.showSaveDialog({
      title: 'Export collection as .http',
      defaultPath: defaultName ?? 'collection.http',
      filters: [{ name: 'HTTP files', extensions: ['http'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { path: null };
    return { path: result.filePath };
  },

  // === Folders / Requests (read) ===
  'folder:list': ({ collectionId }) => Repos.Folders.listByCollection(getDb(), collectionId),

  'folder:create': async ({ collectionId, name, parentFolderId }) => {
    const db = getDb();
    const folder = Repos.Folders.create(db, {
      collectionId,
      name,
      ...(parentFolderId !== undefined ? { parentFolderId } : {}),
    });
    await flushCollectionFile(db, collectionId);
    return folder;
  },

  'folder:rename': async ({ folderId, name }) => {
    const db = getDb();
    const folder = Repos.Folders.get(db, folderId);
    Repos.Folders.rename(db, folderId, name);
    if (folder) await flushCollectionFile(db, folder.collectionId);
    return { folderId };
  },

  'folder:delete': async ({ folderId }) => {
    const db = getDb();
    const folder = Repos.Folders.get(db, folderId);
    Repos.Folders.delete(db, folderId);
    if (folder) await flushCollectionFile(db, folder.collectionId);
    return { folderId };
  },

  'folder:reparent': async ({ folderId, newParentFolderId }) => {
    const db = getDb();
    const result = Repos.Folders.reparent(db, folderId, newParentFolderId);
    const folder = Repos.Folders.get(db, folderId);
    if (folder) await flushCollectionFile(db, folder.collectionId);
    return result;
  },

  // Drop-on-directory: spin up a new single-request .http in the target
  // directory containing the moved request, and remove it from the source
  // collection. The new collection's name is the request's display name
  // (slugged for the filename). Source .http and the new .http both get
  // flushed.
  'request:moveToDirectory': async ({ requestId, directoryId }) => {
    const db = getDb();
    const req = Repos.Requests.get(db, requestId);
    if (!req) throw new Error('NOT_FOUND: request');
    const dir = Repos.Directories.get(db, directoryId);
    if (!dir) throw new Error('NOT_FOUND: directory');
    const sourceCollectionId = req.collectionId;
    const source = Repos.Collections.get(db, sourceCollectionId);
    if (source?.directoryId === directoryId) {
      // Already lives in this directory (just in a different .http in it) —
      // no-op to avoid creating an empty new collection. UX-wise this is
      // "drop on the same parent did nothing."
      return { requestId, newCollectionId: sourceCollectionId };
    }

    // Mint a new collection in the target directory. Name from the
    // request's display name; the renderer's single-request collapse means
    // the user just sees this request under the directory, no extra
    // "folder" row appears.
    const collectionName = req.name || 'Untitled';
    const newCol = Repos.Collections.create(db, {
      workspaceId: dir.workspaceId,
      name: collectionName,
      directoryId,
    });

    // Move the request into the new collection.
    Repos.Requests.update(db, requestId, { folderId: newCol.rootFolderId });
    db.prepare('UPDATE requests SET collection_id = ? WHERE id = ?').run(
      newCol.id,
      requestId,
    );

    // Flush both files so disk matches, then prune the source if it's
    // now empty (no point leaving a 0-request .http on disk).
    await flushCollectionFile(db, sourceCollectionId);
    await flushCollectionFile(db, newCol.id);
    await removeCollectionIfEmpty(db, sourceCollectionId);

    return { requestId, newCollectionId: newCol.id };
  },

  'request:reparent': async ({ requestId, newFolderId }) => {
    const db = getDb();
    const req = Repos.Requests.get(db, requestId);
    if (!req) throw new Error('NOT_FOUND: request');
    const folder = Repos.Folders.get(db, newFolderId);
    if (!folder) throw new Error('NOT_FOUND: folder');
    // Folder owns its collection — the request's collection_id has to track
    // it so cross-collection drops keep the foreign-key invariants intact.
    const sourceCollectionId = req.collectionId;
    Repos.Requests.update(db, requestId, { folderId: newFolderId });
    if (sourceCollectionId !== folder.collectionId) {
      db.prepare('UPDATE requests SET collection_id = ? WHERE id = ?').run(
        folder.collectionId,
        requestId,
      );
      // Both the source and target collections changed; flush both files,
      // then prune the source if it's now empty.
      await flushCollectionFile(db, sourceCollectionId);
      await flushCollectionFile(db, folder.collectionId);
      await removeCollectionIfEmpty(db, sourceCollectionId);
    } else {
      await flushCollectionFile(db, folder.collectionId);
    }
    return { requestId };
  },

  'request:list': ({ collectionId }) => Repos.Requests.listByCollection(getDb(), collectionId),

  'request:get': ({ requestId }) => {
    const r = Repos.Requests.get(getDb(), requestId);
    if (!r) throw new Error('NOT_FOUND: request');
    return r;
  },

  // === Tabs ===
  'tabs:list': () => Repos.Tabs.list(getDb()),

  'tabs:saveDraft': ({ tabId, draftJson }) => {
    Repos.Tabs.saveDraft(getDb(), tabId, draftJson as unknown as Record<string, unknown>);
    return { tabId };
  },

  'tabs:open': ({ requestId }) => {
    // Reuse an existing tab if one already points at this request.
    const existing = Repos.Tabs.list(getDb()).find((t) => t.requestId === requestId);
    if (existing) return existing;
    return Repos.Tabs.create(getDb(), { requestId });
  },

  'tabs:close': ({ tabId }) => {
    Repos.Tabs.close(getDb(), tabId);
    return { tabId };
  },

  'folder:sendAll': async ({ folderId }) =>
    sendAllInFolder(getDb(), getSecrets(), folderId, { send: runnerSend }, {
      insecureTLS: readAppSettings(app.getPath('userData')).allowInsecureTLS,
    }),

  // App-level settings — see src/app/app-settings.ts. Persists to
  // <userData>/settings.json so the value survives workspace switches and
  // is available pre-workspace at boot.
  'app:settings:get': () => readAppSettings(app.getPath('userData')),

  'app:settings:set': ({ settings }) =>
    writeAppSettings(app.getPath('userData'), settings),

  // Standard macOS double-click-title-bar behavior. The renderer wires this
  // up on a `dblclick` listener on the .header element since our custom
  // chrome (titleBarStyle: hiddenInset) means the system's automatic
  // double-click-to-zoom doesn't always fire. action: 'zoom' toggles
  // maximize/unmaximize; 'minimize' minimizes.
  // Triggered from the renderer's "Restart to update" toast / pill —
  // quits the app, swaps the on-disk binary via electron-updater's
  // staged installer, and relaunches. Must use the SAME autoUpdater
  // singleton that wired the listeners in main.ts — a fresh dynamic
  // import gives back a different module instance under CJS interop
  // and doesn't know an update has been staged, so the call silently
  // no-ops.
  'app:quitAndInstall': () => {
    pkg.autoUpdater.quitAndInstall();
    return null;
  },

  // Open a URL in the user's default browser. Restricted to web + mailto
  // schemes so a compromised renderer can't ask the main process to
  // launch arbitrary protocol handlers (file:, etc.).
  'app:openExternal': ({ url }) => {
    try {
      const { protocol } = new URL(url);
      if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
        void shell.openExternal(url);
      } else {
        console.warn('app:openExternal refused non-web scheme:', protocol);
      }
    } catch {
      console.warn('app:openExternal received a malformed URL');
    }
    return null;
  },

  // Quit the app outright.
  'app:quit': () => {
    app.quit();
    return null;
  },

  'app:windowAction': ({ action }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    if (action === 'zoom') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'minimize') {
      win.minimize();
    }
    return null;
  },

  // Pop up the application menu at a renderer-supplied point. Used on
  // Windows/Linux, where the native menu bar is hidden (titleBarStyle:
  // 'hidden') and the brand mark in the header is the only affordance for
  // reaching File/Edit/View/Help. macOS keeps the real menu bar, so the
  // renderer never calls this there. x/y are window-relative CSS pixels
  // (the brand mark's bottom-left), which Menu.popup expects.
  'app:popupAppMenu': ({ x, y }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    buildAppMenu().popup({ window: win, x: Math.round(x), y: Math.round(y) });
    return null;
  },

  // First-run "Try with examples" flow. Prompts the user to pick a parent
  // folder, creates `Coax Examples/` inside, writes a small self-contained
  // sample workspace (one collection + one env), and returns the path so
  // the renderer can open it via workspace:open. Inline-string content
  // avoids any extraResources bundling complexity.
  'welcome:createSampleWorkspace': async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const pick = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Where should the example workspace live?',
      buttonLabel: 'Create Here',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (pick.canceled || pick.filePaths.length === 0) {
      return { canceled: true } as const;
    }
    const parent = pick.filePaths[0]!;
    const sampleDir = join(parent, 'Coax Examples');
    mkdirSync(sampleDir, { recursive: true });

    writeFileSync(
      join(sampleDir, 'httpbin.http'),
      `### Healthcheck
# @test status == 200
# @test responseTime < 5000
GET {{baseUrl}}/get

### Echo a JSON body
# @name echo
# @test status == 200
# @test $.json.user == "coax"
POST {{baseUrl}}/anything
Content-Type: application/json

{ "user": "coax", "where": "examples" }

### Chain — uses the previous response
# @test status == 200
# @test $.headers.X-From-Echo == "coax"
GET {{baseUrl}}/headers
X-From-Echo: {{echo.response.body.$.json.user}}
`,
      'utf8',
    );
    writeFileSync(
      join(sampleDir, 'httpbin.dev.env.json'),
      JSON.stringify(
        {
          name: 'dev',
          vars: [{ key: 'baseUrl', valuePlain: 'https://httpbin.org' }],
        },
        null,
        2,
      ),
      'utf8',
    );

    return { canceled: false, folderPath: sampleDir } as const;
  },
};

// Exported for tests so cleanup can close the DB and stop the runner
export function shutdown(): void {
  if (dbHandle) {
    dbHandle.close();
    dbHandle = undefined;
  }
}
