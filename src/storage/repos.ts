import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import type { Secrets } from '../secrets/safe.js';

// =====================================================================
// Helpers
// =====================================================================

function notFound(): never {
  throw new Error('NOT_FOUND');
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return randomUUID();
}

function toBool(n: unknown): boolean {
  return n === 1 || n === true;
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// =====================================================================
// Workspaces
// =====================================================================

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  settings: Record<string, unknown>;
}

interface WorkspaceRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  settings_json: string;
}

function mapWorkspaceRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settings: parseJson<Record<string, unknown>>(row.settings_json, {}),
  };
}

export const Workspaces = {
  create(db: Db, input: { name: string }): Workspace {
    const id = newId();
    const ts = nowIso();
    db.prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at, settings_json) VALUES (?, ?, ?, ?, ?)',
    ).run(id, input.name, ts, ts, '{}');
    return {
      id,
      name: input.name,
      createdAt: ts,
      updatedAt: ts,
      settings: {},
    };
  },

  get(db: Db, id: string): Workspace | undefined {
    const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      | WorkspaceRow
      | undefined;
    return row ? mapWorkspaceRow(row) : undefined;
  },

  list(db: Db): Workspace[] {
    const rows = db
      .prepare('SELECT * FROM workspaces ORDER BY created_at')
      .all() as WorkspaceRow[];
    return rows.map(mapWorkspaceRow);
  },

  rename(db: Db, id: string, name: string): void {
    const info = db
      .prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, nowIso(), id);
    if (info.changes === 0) notFound();
  },

  delete(db: Db, id: string): void {
    const info = db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    if (info.changes === 0) notFound();
  },

  updateSettings(db: Db, id: string, patch: Record<string, unknown>): void {
    const row = db.prepare('SELECT settings_json FROM workspaces WHERE id = ?').get(id) as
      | { settings_json: string }
      | undefined;
    if (!row) notFound();
    const current = parseJson<Record<string, unknown>>(row.settings_json, {});
    const merged = { ...current, ...patch };
    const info = db
      .prepare('UPDATE workspaces SET settings_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), nowIso(), id);
    if (info.changes === 0) notFound();
  },
};

// =====================================================================
// Directories
// =====================================================================
//
// A directory is a node in the workspace tree. Each workspace has one root
// directory (name = ''); every subdirectory under the workspace folder
// becomes another row, linked by parent_directory_id. Collections (one per
// `.http` file) live IN a directory via collections.directory_id.
//
// The on-disk path of a directory is its slugged ancestors joined with '/',
// rooted at the workspace folder. Path is derived, not stored — the cache
// mirrors the filesystem rather than competing with it.

export interface Directory {
  id: string;
  workspaceId: string;
  name: string;
  parentDirectoryId?: string;
  sortOrder: number;
}

interface DirectoryRow {
  id: string;
  workspace_id: string;
  name: string;
  parent_directory_id: string | null;
  sort_order: number;
}

function mapDirectoryRow(row: DirectoryRow): Directory {
  const base: Directory = {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    sortOrder: row.sort_order,
  };
  if (row.parent_directory_id !== null) base.parentDirectoryId = row.parent_directory_id;
  return base;
}

export const Directories = {
  /**
   * Create a directory. `parentDirectoryId` omitted = root directory of the
   * workspace (only one allowed per workspace; the migration creates it).
   */
  create(
    db: Db,
    input: { workspaceId: string; name: string; parentDirectoryId?: string },
  ): Directory {
    const id = newId();
    const parent = input.parentDirectoryId ?? null;
    db.prepare(
      'INSERT INTO directories (id, workspace_id, parent_directory_id, name, sort_order) VALUES (?, ?, ?, ?, 0)',
    ).run(id, input.workspaceId, parent, input.name);
    const out: Directory = {
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      sortOrder: 0,
    };
    if (parent !== null) out.parentDirectoryId = parent;
    return out;
  },

  get(db: Db, id: string): Directory | undefined {
    const row = db.prepare('SELECT * FROM directories WHERE id = ?').get(id) as
      | DirectoryRow
      | undefined;
    return row ? mapDirectoryRow(row) : undefined;
  },

  /**
   * Returns the workspace's root directory (the implicit anonymous node
   * created at workspace open). Always present once a workspace has been
   * opened under the directories schema.
   */
  getRoot(db: Db, workspaceId: string): Directory | undefined {
    const row = db
      .prepare(
        'SELECT * FROM directories WHERE workspace_id = ? AND parent_directory_id IS NULL LIMIT 1',
      )
      .get(workspaceId) as DirectoryRow | undefined;
    return row ? mapDirectoryRow(row) : undefined;
  },

  listByWorkspace(db: Db, workspaceId: string): Directory[] {
    const rows = db
      .prepare('SELECT * FROM directories WHERE workspace_id = ? ORDER BY sort_order, name')
      .all(workspaceId) as DirectoryRow[];
    return rows.map(mapDirectoryRow);
  },

  listChildren(db: Db, parentDirectoryId: string): Directory[] {
    const rows = db
      .prepare(
        'SELECT * FROM directories WHERE parent_directory_id = ? ORDER BY sort_order, name',
      )
      .all(parentDirectoryId) as DirectoryRow[];
    return rows.map(mapDirectoryRow);
  },

  /**
   * Find a directory by its slash-separated path within a workspace,
   * resolving relative to the workspace's root directory. '' or '/' returns
   * the root. Returns undefined if any segment is missing.
   */
  findByPath(db: Db, workspaceId: string, path: string): Directory | undefined {
    const segments = path.split('/').filter((s) => s.length > 0);
    let cur = Directories.getRoot(db, workspaceId);
    for (const seg of segments) {
      if (!cur) return undefined;
      const next = db
        .prepare(
          'SELECT * FROM directories WHERE parent_directory_id = ? AND name = ? LIMIT 1',
        )
        .get(cur.id, seg) as DirectoryRow | undefined;
      if (!next) return undefined;
      cur = mapDirectoryRow(next);
    }
    return cur;
  },

  rename(db: Db, id: string, name: string): void {
    const info = db.prepare('UPDATE directories SET name = ? WHERE id = ?').run(name, id);
    if (info.changes === 0) notFound();
  },

  reorder(db: Db, id: string, sortOrder: number): void {
    const info = db
      .prepare('UPDATE directories SET sort_order = ? WHERE id = ?')
      .run(sortOrder, id);
    if (info.changes === 0) notFound();
  },

  /**
   * Reparent a directory under a new parent within the same workspace.
   * Cycle check walks up from the new parent.
   */
  move(db: Db, directoryId: string, newParentDirectoryId: string): Directory {
    const dir = Directories.get(db, directoryId);
    if (!dir) throw new Error('NOT_FOUND: directory');
    if (newParentDirectoryId === directoryId) {
      throw new Error('INVALID: cannot move a directory into itself');
    }
    const newParent = Directories.get(db, newParentDirectoryId);
    if (!newParent) throw new Error('NOT_FOUND: new parent directory');
    if (newParent.workspaceId !== dir.workspaceId) {
      throw new Error('INVALID: cannot move directories across workspaces');
    }
    let cur: string | undefined = newParent.parentDirectoryId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === directoryId) {
        throw new Error('INVALID: cannot move a directory under one of its descendants');
      }
      seen.add(cur);
      const row = db
        .prepare('SELECT parent_directory_id FROM directories WHERE id = ?')
        .get(cur) as { parent_directory_id: string | null } | undefined;
      cur = row?.parent_directory_id ?? undefined;
    }
    db.prepare('UPDATE directories SET parent_directory_id = ? WHERE id = ?').run(
      newParentDirectoryId,
      directoryId,
    );
    return { ...dir, parentDirectoryId: newParentDirectoryId };
  },

  delete(db: Db, id: string): void {
    const info = db.prepare('DELETE FROM directories WHERE id = ?').run(id);
    if (info.changes === 0) notFound();
  },

  /**
   * Walk parents to build the directory's slash-separated path within the
   * workspace. Root directory returns ''.
   */
  pathOf(db: Db, id: string): string {
    const segments: string[] = [];
    let cur: string | undefined = id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const row = db
        .prepare('SELECT name, parent_directory_id FROM directories WHERE id = ?')
        .get(cur) as { name: string; parent_directory_id: string | null } | undefined;
      if (!row) break;
      if (row.parent_directory_id === null) break; // skip root (name='')
      segments.unshift(row.name);
      cur = row.parent_directory_id;
    }
    return segments.join('/');
  },
};

// =====================================================================
// Collections
// =====================================================================

export interface Collection {
  id: string;
  workspaceId: string;
  name: string;
  /**
   * The directory this collection's `.http` file lives in. Set by adopt and
   * by the user via move. Backfilled by migration 006 for legacy data.
   */
  directoryId: string;
  sortOrder: number;
  /**
   * Implicit folder representing the collection root. Envs scoped at the
   * "collection level" attach here. Created by migration 003 for every
   * existing collection; new collections must create one at insert time
   * (Collections.create handles that).
   */
  rootFolderId: string;
}

interface CollectionRow {
  id: string;
  workspace_id: string;
  name: string;
  directory_id: string | null;
  sort_order: number;
  root_folder_id: string | null;
}

function mapCollectionRow(row: CollectionRow): Collection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    directoryId: row.directory_id ?? '',
    sortOrder: row.sort_order,
    rootFolderId: row.root_folder_id ?? '',
  };
}

export const Collections = {
  /**
   * Create a collection inside a directory. `directoryId` defaults to the
   * workspace's root directory; if no root directory exists yet for that
   * workspace, one is minted lazily (saves callers — and especially test
   * fixtures — from having to seed it explicitly).
   */
  create(
    db: Db,
    input: { workspaceId: string; name: string; directoryId?: string },
  ): Collection {
    const id = newId();
    // Resolve / lazily create the target directory.
    let targetDirId = input.directoryId;
    if (targetDirId === undefined) {
      const root =
        Directories.getRoot(db, input.workspaceId) ??
        Directories.create(db, { workspaceId: input.workspaceId, name: '' });
      targetDirId = root.id;
    }
    // Every collection owns an implicit root folder. Envs scoped "at the
    // collection level" attach here. The schema enforces FK after migration
    // 003, so we always insert the folder + back-fill root_folder_id.
    const rootFolderId = newId();
    const tx = db.transaction((cid: string, dirId: string, rfid: string) => {
      db.prepare(
        'INSERT INTO collections (id, workspace_id, name, directory_id, sort_order, root_folder_id) VALUES (?, ?, ?, ?, 0, NULL)',
      ).run(cid, input.workspaceId, input.name, dirId);
      db.prepare(
        'INSERT INTO folders (id, collection_id, parent_folder_id, name, sort_order) VALUES (?, ?, NULL, ?, -1)',
      ).run(rfid, cid, '(root)');
      db.prepare('UPDATE collections SET root_folder_id = ? WHERE id = ?').run(rfid, cid);
    });
    tx(id, targetDirId, rootFolderId);
    return {
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      directoryId: targetDirId,
      sortOrder: 0,
      rootFolderId,
    };
  },

  get(db: Db, id: string): Collection | undefined {
    const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as
      | CollectionRow
      | undefined;
    return row ? mapCollectionRow(row) : undefined;
  },

  listByWorkspace(db: Db, workspaceId: string): Collection[] {
    const rows = db
      .prepare('SELECT * FROM collections WHERE workspace_id = ? ORDER BY sort_order, name')
      .all(workspaceId) as CollectionRow[];
    return rows.map(mapCollectionRow);
  },

  /** Collections that live directly inside a directory (not its children). */
  listByDirectory(db: Db, directoryId: string): Collection[] {
    const rows = db
      .prepare('SELECT * FROM collections WHERE directory_id = ? ORDER BY sort_order, name')
      .all(directoryId) as CollectionRow[];
    return rows.map(mapCollectionRow);
  },

  rename(db: Db, id: string, name: string): void {
    const info = db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(name, id);
    if (info.changes === 0) notFound();
  },

  delete(db: Db, id: string): void {
    const info = db.prepare('DELETE FROM collections WHERE id = ?').run(id);
    if (info.changes === 0) notFound();
  },

  reorder(db: Db, id: string, sortOrder: number): void {
    const info = db
      .prepare('UPDATE collections SET sort_order = ? WHERE id = ?')
      .run(sortOrder, id);
    if (info.changes === 0) notFound();
  },

  /**
   * Move a collection into a different directory within the same workspace.
   * The actual `.http` file move on disk is the caller's responsibility
   * (workspace-fs/flush wires this together).
   */
  moveToDirectory(db: Db, collectionId: string, newDirectoryId: string): Collection {
    const col = Collections.get(db, collectionId);
    if (!col) throw new Error('NOT_FOUND: collection');
    const dir = Directories.get(db, newDirectoryId);
    if (!dir) throw new Error('NOT_FOUND: target directory');
    if (dir.workspaceId !== col.workspaceId) {
      throw new Error('INVALID: cannot move collections across workspaces');
    }
    db.prepare('UPDATE collections SET directory_id = ? WHERE id = ?').run(
      newDirectoryId,
      collectionId,
    );
    return { ...col, directoryId: newDirectoryId };
  },
};

// =====================================================================
// Folders
// =====================================================================

export interface Folder {
  id: string;
  collectionId: string;
  name: string;
  parentFolderId?: string;
  sortOrder: number;
}

interface FolderRow {
  id: string;
  collection_id: string;
  parent_folder_id: string | null;
  name: string;
  sort_order: number;
}

function mapFolderRow(row: FolderRow): Folder {
  const base: Folder = {
    id: row.id,
    collectionId: row.collection_id,
    name: row.name,
    sortOrder: row.sort_order,
  };
  if (row.parent_folder_id !== null) base.parentFolderId = row.parent_folder_id;
  return base;
}

export const Folders = {
  create(
    db: Db,
    input: { collectionId: string; name: string; parentFolderId?: string },
  ): Folder {
    const id = newId();
    // If no parent supplied, attach under the collection's implicit root
    // folder. This preserves the "top-level folder" UX from before
    // migration 003 — callers don't need to know root exists.
    let parent = input.parentFolderId ?? null;
    if (parent === null) {
      const rootRow = db
        .prepare(
          'SELECT id FROM folders WHERE collection_id = ? AND parent_folder_id IS NULL LIMIT 1',
        )
        .get(input.collectionId) as { id: string } | undefined;
      // If there's no root folder yet (test setup that bypassed
      // Collections.create), leave parent as NULL — the row becomes a
      // root itself. Otherwise auto-attach.
      if (rootRow) parent = rootRow.id;
    }
    db.prepare(
      'INSERT INTO folders (id, collection_id, parent_folder_id, name, sort_order) VALUES (?, ?, ?, ?, 0)',
    ).run(id, input.collectionId, parent, input.name);
    const out: Folder = {
      id,
      collectionId: input.collectionId,
      name: input.name,
      sortOrder: 0,
    };
    if (parent !== null) out.parentFolderId = parent;
    return out;
  },

  get(db: Db, id: string): Folder | undefined {
    const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined;
    return row ? mapFolderRow(row) : undefined;
  },

  listByCollection(db: Db, collectionId: string): Folder[] {
    // Excludes the collection's implicit root folder (parent_folder_id IS
    // NULL after migration 003) — the root is structural plumbing, not a
    // user-visible folder. Use `getRoot` when the root folder id is needed
    // (e.g. for attaching collection-level envs).
    const rows = db
      .prepare(
        'SELECT * FROM folders WHERE collection_id = ? AND parent_folder_id IS NOT NULL ORDER BY sort_order, name',
      )
      .all(collectionId) as FolderRow[];
    return rows.map(mapFolderRow);
  },

  /**
   * Returns the implicit root folder for a collection. Created at collection
   * insert time and survived migration 003 for legacy collections.
   */
  getRoot(db: Db, collectionId: string): Folder | undefined {
    const row = db
      .prepare(
        'SELECT * FROM folders WHERE collection_id = ? AND parent_folder_id IS NULL LIMIT 1',
      )
      .get(collectionId) as FolderRow | undefined;
    return row ? mapFolderRow(row) : undefined;
  },

  rename(db: Db, id: string, name: string): void {
    const info = db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id);
    if (info.changes === 0) notFound();
  },

  delete(db: Db, id: string): void {
    // The schema has `requests.folder_id REFERENCES folders(id) ON DELETE
    // SET NULL`, which means a raw `DELETE FROM folders` would orphan the
    // requests at the collection root rather than removing them. Users
    // expect "delete folder" to mean "delete folder and everything in it",
    // matching how every other API client behaves. Cascade in app code:
    //   1. enumerate the moved subtree (folder + descendants)
    //   2. delete every request inside any of those folders
    //   3. delete the root folder; child folders cascade via their FK
    const exists = db.prepare('SELECT 1 FROM folders WHERE id = ?').get(id);
    if (!exists) notFound();
    const tx = db.transaction(() => {
      const subtreeIds = collectFolderSubtreeIds(db, id);
      const placeholders = subtreeIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM requests WHERE folder_id IN (${placeholders})`).run(
        ...subtreeIds,
      );
      db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    });
    tx();
  },

  reorder(db: Db, id: string, sortOrder: number): void {
    const info = db.prepare('UPDATE folders SET sort_order = ? WHERE id = ?').run(sortOrder, id);
    if (info.changes === 0) notFound();
  },

  /**
   * Reparents a folder under a new parent within the same collection.
   * Validates:
   *   - both folders exist
   *   - they belong to the same collection
   *   - the move doesn't create a cycle (newParent must not be a descendant
   *     of folderId).
   * Throws NOT_FOUND / INVALID with a useful message on any violation.
   */
  reparent(db: Db, folderId: string, newParentFolderId: string): Folder {
    const folder = Folders.get(db, folderId);
    if (!folder) throw new Error('NOT_FOUND: folder');
    if (folderId === newParentFolderId) {
      throw new Error('INVALID: cannot reparent a folder onto itself');
    }
    const newParent = Folders.get(db, newParentFolderId);
    if (!newParent) throw new Error('NOT_FOUND: new parent folder');

    // Cycle check: walk up from newParent until we hit a NULL parent or
    // encounter folderId (which would create a cycle).
    let cur: string | undefined = newParent.parentFolderId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === folderId) {
        throw new Error('INVALID: cannot reparent a folder under one of its descendants');
      }
      seen.add(cur);
      const row = db
        .prepare('SELECT parent_folder_id FROM folders WHERE id = ?')
        .get(cur) as { parent_folder_id: string | null } | undefined;
      cur = row?.parent_folder_id ?? undefined;
    }

    const crossCollection = folder.collectionId !== newParent.collectionId;
    const reparent = db.transaction(() => {
      db.prepare('UPDATE folders SET parent_folder_id = ? WHERE id = ?').run(
        newParentFolderId,
        folderId,
      );
      if (crossCollection) {
        // Cascade collection_id through the moved subtree: the folder itself
        // plus every descendant folder, and every request inside any of them.
        // Folders + requests both have a hard collection_id FK that has to
        // stay in sync with where the folder actually lives in the tree;
        // skipping this would leave orphan rows pointing at the old
        // collection and break env resolution (chain walks via the request's
        // collection ancestry).
        const subtreeIds = collectFolderSubtreeIds(db, folderId);
        const placeholders = subtreeIds.map(() => '?').join(',');
        db.prepare(
          `UPDATE folders SET collection_id = ? WHERE id IN (${placeholders})`,
        ).run(newParent.collectionId, ...subtreeIds);
        db.prepare(
          `UPDATE requests SET collection_id = ? WHERE folder_id IN (${placeholders})`,
        ).run(newParent.collectionId, ...subtreeIds);
      }
    });
    reparent();

    return {
      ...folder,
      parentFolderId: newParentFolderId,
      collectionId: newParent.collectionId,
    };
  },
};

/**
 * BFS through `folders.parent_folder_id` starting at `rootId`, returning the
 * id plus every descendant folder id. Used by Folders.reparent to cascade
 * collection_id when a folder moves across collection boundaries.
 */
function collectFolderSubtreeIds(db: Db, rootId: string): string[] {
  const out: string[] = [];
  const queue: string[] = [rootId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const children = db
      .prepare('SELECT id FROM folders WHERE parent_folder_id = ?')
      .all(id) as { id: string }[];
    for (const c of children) queue.push(c.id);
  }
  return out;
}

// =====================================================================
// Requests
// =====================================================================

export interface RequestRecord {
  id: string;
  collectionId: string;
  folderId?: string;
  name: string;
  /**
   * The optional chaining identifier (from `# @name foo` in .http files). When
   * present, this request's last response is keyed in the resolver context as
   * `foo`, so other requests can reference it via `{{foo.response.body.$.x}}`.
   */
  chainName?: string;
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  bodyText: string;
  bodyKind: string;
  auth: { kind: string; data?: Record<string, string> };
  sortOrder: number;
}

interface RequestRow {
  id: string;
  collection_id: string;
  folder_id: string | null;
  name: string;
  chain_name: string | null;
  method: string;
  url: string;
  headers_json: string;
  body_text: string;
  body_kind: string;
  auth_json: string;
  sort_order: number;
}

function mapRequestRow(row: RequestRow): RequestRecord {
  const base: RequestRecord = {
    id: row.id,
    collectionId: row.collection_id,
    name: row.name,
    method: row.method,
    url: row.url,
    headers: parseJson<{ key: string; value: string }[]>(row.headers_json, []),
    bodyText: row.body_text,
    bodyKind: row.body_kind,
    auth: parseJson<{ kind: string; data?: Record<string, string> }>(row.auth_json, {
      kind: 'none',
    }),
    sortOrder: row.sort_order,
  };
  if (row.folder_id !== null) base.folderId = row.folder_id;
  if (row.chain_name !== null && row.chain_name !== '') base.chainName = row.chain_name;
  return base;
}

export const Requests = {
  create(
    db: Db,
    input: {
      collectionId: string;
      folderId?: string;
      name: string;
      chainName?: string;
      method: string;
      url: string;
      headers?: { key: string; value: string }[];
      body?: { kind: string; raw: string };
      auth?: { kind: string; data?: Record<string, string> };
    },
  ): RequestRecord {
    const id = newId();
    const folder = input.folderId ?? null;
    const chainName = input.chainName ?? null;
    const headers = input.headers ?? [];
    const bodyKind = input.body?.kind ?? 'none';
    const bodyText = input.body?.raw ?? '';
    const auth = input.auth ?? { kind: 'none' };
    db.prepare(
      `INSERT INTO requests (id, collection_id, folder_id, name, chain_name, method, url, headers_json, body_text, body_kind, auth_json, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      id,
      input.collectionId,
      folder,
      input.name,
      chainName,
      input.method,
      input.url,
      JSON.stringify(headers),
      bodyText,
      bodyKind,
      JSON.stringify(auth),
    );
    const out: RequestRecord = {
      id,
      collectionId: input.collectionId,
      name: input.name,
      method: input.method,
      url: input.url,
      headers,
      bodyText,
      bodyKind,
      auth,
      sortOrder: 0,
    };
    if (input.folderId !== undefined) out.folderId = input.folderId;
    if (input.chainName !== undefined) out.chainName = input.chainName;
    return out;
  },

  get(db: Db, id: string): RequestRecord | undefined {
    const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as
      | RequestRow
      | undefined;
    return row ? mapRequestRow(row) : undefined;
  },

  listByCollection(db: Db, collectionId: string): RequestRecord[] {
    const rows = db
      .prepare('SELECT * FROM requests WHERE collection_id = ? ORDER BY sort_order, name')
      .all(collectionId) as RequestRow[];
    return rows.map(mapRequestRow);
  },

  listByFolder(db: Db, folderId: string): RequestRecord[] {
    const rows = db
      .prepare('SELECT * FROM requests WHERE folder_id = ? ORDER BY sort_order, name')
      .all(folderId) as RequestRow[];
    return rows.map(mapRequestRow);
  },

  update(
    db: Db,
    id: string,
    patch: Partial<{
      name: string;
      chainName: string | null;
      method: string;
      url: string;
      headers: { key: string; value: string }[];
      body: { kind: string; raw: string };
      auth: { kind: string; data?: Record<string, string> };
      folderId: string | null;
    }>,
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if ('chainName' in patch) {
      // Explicit `null` clears the chain name. `undefined`/key-absent is a
      // no-op. Empty string also stored as NULL so the mapping back through
      // mapRequestRow consistently returns chainName === undefined.
      sets.push('chain_name = ?');
      const val = patch.chainName;
      params.push(val === null || val === undefined || val === '' ? null : val);
    }
    if (patch.method !== undefined) {
      sets.push('method = ?');
      params.push(patch.method);
    }
    if (patch.url !== undefined) {
      sets.push('url = ?');
      params.push(patch.url);
    }
    if (patch.headers !== undefined) {
      sets.push('headers_json = ?');
      params.push(JSON.stringify(patch.headers));
    }
    if (patch.body !== undefined) {
      sets.push('body_kind = ?');
      params.push(patch.body.kind);
      sets.push('body_text = ?');
      params.push(patch.body.raw);
    }
    if (patch.auth !== undefined) {
      sets.push('auth_json = ?');
      params.push(JSON.stringify(patch.auth));
    }
    if ('folderId' in patch) {
      sets.push('folder_id = ?');
      params.push(patch.folderId ?? null);
    }

    if (sets.length === 0) {
      // Nothing to update — still verify the row exists for NOT_FOUND semantics.
      const exists = db.prepare('SELECT 1 FROM requests WHERE id = ?').get(id);
      if (!exists) notFound();
      return;
    }

    params.push(id);
    const info = db
      .prepare(`UPDATE requests SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    if (info.changes === 0) notFound();
  },

  delete(db: Db, id: string): void {
    const info = db.prepare('DELETE FROM requests WHERE id = ?').run(id);
    if (info.changes === 0) notFound();
  },

  reorder(db: Db, id: string, sortOrder: number): void {
    const info = db
      .prepare('UPDATE requests SET sort_order = ? WHERE id = ?')
      .run(sortOrder, id);
    if (info.changes === 0) notFound();
  },

  /**
   * Lists every request in `workspaceId` that has a non-null, non-empty
   * `chain_name`. Used by the IPC layer to build the resolver's `responses`
   * context — each entry pairs a chain identifier with the request id whose
   * last_response should be loaded.
   */
  listByChainName(
    db: Db,
    workspaceId: string,
  ): { id: string; chainName: string }[] {
    const rows = db
      .prepare(
        `SELECT r.id AS id, r.chain_name AS chainName
         FROM requests r
         JOIN collections c ON c.id = r.collection_id
         WHERE c.workspace_id = ?
           AND r.chain_name IS NOT NULL
           AND r.chain_name != ''`,
      )
      .all(workspaceId) as { id: string; chainName: string }[];
    return rows;
  },
};

// =====================================================================
// Environments
// =====================================================================

/**
 * An environment row attaches to exactly one of: a folder (inside a
 * collection — sourced from inline `@vars` at the top of a .http file) or
 * a directory (a sibling .env.json in the workspace tree). The resolver
 * cascade walks both kinds.
 */
export interface Environment {
  id: string;
  /** Set when this env attaches to a folder inside a collection. */
  folderId?: string;
  /** Set when this env attaches to a workspace directory. */
  directoryId?: string;
  name: string;
  isActive: boolean;
}

interface EnvRow {
  id: string;
  folder_id: string | null;
  directory_id: string | null;
  name: string;
  is_active: number;
}

function mapEnvRow(row: EnvRow): Environment {
  const base: Environment = {
    id: row.id,
    name: row.name,
    isActive: toBool(row.is_active),
  };
  if (row.folder_id !== null) base.folderId = row.folder_id;
  if (row.directory_id !== null) base.directoryId = row.directory_id;
  return base;
}

/**
 * A single rung in the resolver chain for a request: the scope (folder or
 * directory) it walked through and that scope's currently-active env (or
 * null if none active). Listed from root → leaf (closest to the request
 * last) so the caller can iterate it as "outer → inner" with inner
 * overriding outer.
 */
export interface ChainStep {
  scopeKind: 'folder' | 'directory';
  scopeId: string;
  scopeName: string;
  env: Environment | null;
}

export const Envs = {
  /**
   * Create a new environment attached to either a folder (within a
   * collection — typically the collection root, for inline @vars) or a
   * directory (workspace-level, for .env.json files). Exactly one of
   * folderId / directoryId must be set.
   */
  create(
    db: Db,
    input: { folderId?: string; directoryId?: string; name: string },
  ): Environment {
    if ((input.folderId === undefined) === (input.directoryId === undefined)) {
      throw new Error('ENV_SCOPE: exactly one of folderId / directoryId required');
    }
    const id = newId();
    db.prepare(
      'INSERT INTO environments (id, folder_id, directory_id, name, is_active) VALUES (?, ?, ?, ?, 0)',
    ).run(id, input.folderId ?? null, input.directoryId ?? null, input.name);
    const out: Environment = {
      id,
      name: input.name,
      isActive: false,
    };
    if (input.folderId !== undefined) out.folderId = input.folderId;
    if (input.directoryId !== undefined) out.directoryId = input.directoryId;
    return out;
  },

  get(db: Db, id: string): Environment | undefined {
    const row = db.prepare('SELECT * FROM environments WHERE id = ?').get(id) as
      | EnvRow
      | undefined;
    return row ? mapEnvRow(row) : undefined;
  },

  /** Envs attached to a folder (collection-internal). */
  list(db: Db, folderId: string): Environment[] {
    const rows = db
      .prepare('SELECT * FROM environments WHERE folder_id = ? ORDER BY name')
      .all(folderId) as EnvRow[];
    return rows.map(mapEnvRow);
  },

  /** Envs attached to a directory (workspace-level). */
  listByDirectory(db: Db, directoryId: string): Environment[] {
    const rows = db
      .prepare('SELECT * FROM environments WHERE directory_id = ? ORDER BY name')
      .all(directoryId) as EnvRow[];
    return rows.map(mapEnvRow);
  },

  /**
   * Returns the env-chain for the given request, ordered root → leaf:
   *
   *   workspace root dir → ... → collection's dir → collection root folder
   *     → ... → request's folder
   *
   * Each step includes the scope's currently-active env (or null). The leaf
   * step is the request's parent folder; the root is the workspace root
   * directory. If the request has no folder_id it starts at the collection
   * root folder.
   */
  listForRequest(db: Db, requestId: string): ChainStep[] {
    const req = db
      .prepare('SELECT folder_id, collection_id FROM requests WHERE id = ?')
      .get(requestId) as { folder_id: string | null; collection_id: string } | undefined;
    if (!req) return [];

    const folderStmt = db.prepare(
      'SELECT id, name, parent_folder_id, collection_id FROM folders WHERE id = ?',
    );
    const collectionStmt = db.prepare(
      'SELECT name, root_folder_id, directory_id FROM collections WHERE id = ?',
    );
    const directoryStmt = db.prepare(
      'SELECT id, name, parent_directory_id FROM directories WHERE id = ?',
    );

    const collected: ChainStep[] = [];

    // Folder leg: from the request's folder up to the collection's root folder.
    // Under the directories model the only folder that ever exists is the
    // collection's implicit root folder, so this loop normally runs once —
    // but we keep it general for legacy data that may still have nested
    // folders from `@folder` directives.
    const ownCol = collectionStmt.get(req.collection_id) as
      | { name: string; root_folder_id: string | null; directory_id: string | null }
      | undefined;
    const startFolderId = req.folder_id ?? ownCol?.root_folder_id ?? null;

    const seenFolders = new Set<string>();
    let curFolderId: string | null = startFolderId;
    while (curFolderId && !seenFolders.has(curFolderId)) {
      seenFolders.add(curFolderId);
      const row = folderStmt.get(curFolderId) as
        | { id: string; name: string; parent_folder_id: string | null; collection_id: string }
        | undefined;
      if (!row) break;
      // The implicit root folder is named "(root)" by migration 003 — show
      // the collection's display name in the chain instead so the Vars
      // panel doesn't surface that sentinel to the user.
      const displayName =
        ownCol?.root_folder_id === row.id ? ownCol.name : row.name;
      collected.push({
        scopeKind: 'folder',
        scopeId: row.id,
        scopeName: displayName,
        env: null,
      });
      curFolderId = row.parent_folder_id;
    }

    // Directory leg: from the collection's directory up to the workspace root.
    const seenDirs = new Set<string>();
    let curDirId: string | null = ownCol?.directory_id ?? null;
    while (curDirId && !seenDirs.has(curDirId)) {
      seenDirs.add(curDirId);
      const row = directoryStmt.get(curDirId) as
        | { id: string; name: string; parent_directory_id: string | null }
        | undefined;
      if (!row) break;
      collected.push({
        scopeKind: 'directory',
        scopeId: row.id,
        // Workspace root directory has name='' — surface a friendlier
        // label so the Vars panel doesn't render " · CI" for an env
        // attached at the workspace root.
        scopeName: row.name === '' ? 'workspace' : row.name,
        env: null,
      });
      curDirId = row.parent_directory_id;
    }

    // We collected leaf → root; reverse to root → leaf so callers iterate
    // outer-to-inner with inner overriding outer.
    collected.reverse();

    // Resolve the active env at each step.
    const folderActiveStmt = db.prepare(
      'SELECT * FROM environments WHERE folder_id = ? AND is_active = 1 LIMIT 1',
    );
    const dirActiveStmt = db.prepare(
      'SELECT * FROM environments WHERE directory_id = ? AND is_active = 1 LIMIT 1',
    );
    return collected.map((step) => {
      const row =
        step.scopeKind === 'folder'
          ? (folderActiveStmt.get(step.scopeId) as EnvRow | undefined)
          : (dirActiveStmt.get(step.scopeId) as EnvRow | undefined);
      return { ...step, env: row ? mapEnvRow(row) : null };
    });
  },

  rename(db: Db, id: string, name: string): void {
    const info = db.prepare('UPDATE environments SET name = ? WHERE id = ?').run(name, id);
    if (info.changes === 0) notFound();
  },

  delete(db: Db, id: string): void {
    const info = db.prepare('DELETE FROM environments WHERE id = ?').run(id);
    if (info.changes === 0) notFound();
  },

  /**
   * Activates one env within its scope (folder OR directory), deactivating
   * any sibling envs at the same scope.
   */
  setActive(db: Db, envId: string): void {
    const env = db.prepare('SELECT folder_id, directory_id FROM environments WHERE id = ?').get(envId) as
      | { folder_id: string | null; directory_id: string | null }
      | undefined;
    if (!env) notFound();
    const tx = db.transaction(() => {
      if (env.folder_id !== null) {
        db.prepare('UPDATE environments SET is_active = 0 WHERE folder_id = ?').run(env.folder_id);
      } else if (env.directory_id !== null) {
        db.prepare('UPDATE environments SET is_active = 0 WHERE directory_id = ?').run(
          env.directory_id,
        );
      }
      db.prepare('UPDATE environments SET is_active = 1 WHERE id = ?').run(envId);
    });
    tx();
  },

  /** Deactivate every env at the given folder scope. */
  clearActive(db: Db, folderId: string): void {
    db.prepare('UPDATE environments SET is_active = 0 WHERE folder_id = ?').run(folderId);
  },

  /** Deactivate every env at the given directory scope. */
  clearActiveDirectory(db: Db, directoryId: string): void {
    db.prepare('UPDATE environments SET is_active = 0 WHERE directory_id = ?').run(directoryId);
  },
};

// =====================================================================
// Variables
// =====================================================================

export interface Variable {
  id: string;
  envId: string;
  key: string;
  valuePlain?: string;
  valueSecretBlob?: Buffer;
  isSecret: boolean;
  description: string;
}

interface VarRow {
  id: string;
  env_id: string;
  key: string;
  value_plain: string | null;
  value_secret_blob: Buffer | Uint8Array | null;
  is_secret: number;
  description: string;
}

function mapVarRow(row: VarRow): Variable {
  const base: Variable = {
    id: row.id,
    envId: row.env_id,
    key: row.key,
    isSecret: toBool(row.is_secret),
    description: row.description,
  };
  if (row.value_plain !== null) base.valuePlain = row.value_plain;
  if (row.value_secret_blob !== null) {
    base.valueSecretBlob = Buffer.isBuffer(row.value_secret_blob)
      ? row.value_secret_blob
      : Buffer.from(row.value_secret_blob);
  }
  return base;
}

export const Vars = {
  create(
    db: Db,
    input: {
      envId: string;
      key: string;
      valuePlain?: string;
      valueSecretBlob?: Buffer;
      description?: string;
    },
  ): Variable {
    const id = newId();
    const isSecret = input.valueSecretBlob !== undefined;
    const description = input.description ?? '';
    db.prepare(
      `INSERT INTO variables (id, env_id, key, value_plain, value_secret_blob, is_secret, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.envId,
      input.key,
      input.valuePlain ?? null,
      input.valueSecretBlob ?? null,
      isSecret ? 1 : 0,
      description,
    );
    const out: Variable = {
      id,
      envId: input.envId,
      key: input.key,
      isSecret,
      description,
    };
    if (input.valuePlain !== undefined) out.valuePlain = input.valuePlain;
    if (input.valueSecretBlob !== undefined) out.valueSecretBlob = input.valueSecretBlob;
    return out;
  },

  get(db: Db, id: string): Variable | undefined {
    const row = db.prepare('SELECT * FROM variables WHERE id = ?').get(id) as VarRow | undefined;
    return row ? mapVarRow(row) : undefined;
  },

  listByEnv(db: Db, envId: string): Variable[] {
    const rows = db
      .prepare('SELECT * FROM variables WHERE env_id = ? ORDER BY key')
      .all(envId) as VarRow[];
    return rows.map(mapVarRow);
  },

  update(
    db: Db,
    id: string,
    patch: Partial<{
      key: string;
      valuePlain: string | null;
      valueSecretBlob: Buffer | null;
      isSecret: boolean;
      description: string;
    }>,
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.key !== undefined) {
      sets.push('key = ?');
      params.push(patch.key);
    }
    if ('valuePlain' in patch) {
      sets.push('value_plain = ?');
      params.push(patch.valuePlain ?? null);
    }
    if ('valueSecretBlob' in patch) {
      sets.push('value_secret_blob = ?');
      params.push(patch.valueSecretBlob ?? null);
    }
    if (patch.isSecret !== undefined) {
      sets.push('is_secret = ?');
      params.push(patch.isSecret ? 1 : 0);
    }
    if (patch.description !== undefined) {
      sets.push('description = ?');
      params.push(patch.description);
    }

    if (sets.length === 0) {
      const exists = db.prepare('SELECT 1 FROM variables WHERE id = ?').get(id);
      if (!exists) notFound();
      return;
    }

    params.push(id);
    const info = db
      .prepare(`UPDATE variables SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);
    if (info.changes === 0) notFound();
  },

  delete(db: Db, id: string): void {
    const info = db.prepare('DELETE FROM variables WHERE id = ?').run(id);
    if (info.changes === 0) notFound();
  },
};

// =====================================================================
// Per-request variable overrides
// =====================================================================

export interface RequestVarOverride {
  id: string;
  requestId: string;
  key: string;
  isSecret: boolean;
  valuePlain?: string;
  valueSecretBlob?: Buffer;
  sortOrder: number;
}

interface RequestVarOverrideRow {
  id: string;
  request_id: string;
  key: string;
  value_plain: string | null;
  value_secret_blob: Buffer | null;
  is_secret: number;
  sort_order: number;
}

function mapOverrideRow(row: RequestVarOverrideRow): RequestVarOverride {
  const out: RequestVarOverride = {
    id: row.id,
    requestId: row.request_id,
    key: row.key,
    isSecret: toBool(row.is_secret),
    sortOrder: row.sort_order,
  };
  if (row.value_plain !== null) out.valuePlain = row.value_plain;
  if (row.value_secret_blob !== null) {
    out.valueSecretBlob = Buffer.isBuffer(row.value_secret_blob)
      ? row.value_secret_blob
      : Buffer.from(row.value_secret_blob);
  }
  return out;
}

export const RequestVarOverrides = {
  listByRequest(db: Db, requestId: string): RequestVarOverride[] {
    const rows = db
      .prepare(
        'SELECT * FROM request_var_overrides WHERE request_id = ? ORDER BY key',
      )
      .all(requestId) as RequestVarOverrideRow[];
    return rows.map(mapOverrideRow);
  },

  upsert(
    db: Db,
    input: {
      requestId: string;
      key: string;
      valuePlain?: string;
      valueSecretBlob?: Buffer;
    },
  ): RequestVarOverride {
    if (input.valuePlain !== undefined && input.valueSecretBlob !== undefined) {
      throw new Error(
        'OVERRIDE_BOTH_VALUES: pass valuePlain or valueSecretBlob, not both',
      );
    }
    const isSecret = input.valueSecretBlob !== undefined;
    const existing = db
      .prepare(
        'SELECT id FROM request_var_overrides WHERE request_id = ? AND key = ?',
      )
      .get(input.requestId, input.key) as { id: string } | undefined;
    const id = existing?.id ?? newId();
    db.prepare(
      `INSERT INTO request_var_overrides
         (id, request_id, key, value_plain, value_secret_blob, is_secret, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(request_id, key) DO UPDATE SET
         value_plain = excluded.value_plain,
         value_secret_blob = excluded.value_secret_blob,
         is_secret = excluded.is_secret`,
    ).run(
      id,
      input.requestId,
      input.key,
      input.valuePlain ?? null,
      input.valueSecretBlob ?? null,
      isSecret ? 1 : 0,
    );
    const out: RequestVarOverride = {
      id,
      requestId: input.requestId,
      key: input.key,
      isSecret,
      sortOrder: 0,
    };
    if (input.valuePlain !== undefined) out.valuePlain = input.valuePlain;
    if (input.valueSecretBlob !== undefined) out.valueSecretBlob = input.valueSecretBlob;
    return out;
  },

  delete(db: Db, args: { requestId: string; key: string }): void {
    db.prepare(
      'DELETE FROM request_var_overrides WHERE request_id = ? AND key = ?',
    ).run(args.requestId, args.key);
  },

  listForRequest(
    db: Db,
    secrets: Secrets,
    requestId: string,
  ): { key: string; value: string; isSecret: boolean }[] {
    const rows = this.listByRequest(db, requestId);
    const out: { key: string; value: string; isSecret: boolean }[] = [];
    for (const r of rows) {
      if (r.isSecret) {
        // A zero-byte blob is the "secret override needs a value" sentinel
        // written by `http:import` when only `# @override:secret <key>` was
        // present in the source. Skip it so resolves still see the underlying
        // env secret instead of an empty string.
        if (!r.valueSecretBlob || r.valueSecretBlob.length === 0) continue;
        out.push({
          key: r.key,
          value: secrets.decrypt(r.valueSecretBlob),
          isSecret: true,
        });
      } else {
        out.push({ key: r.key, value: r.valuePlain ?? '', isSecret: false });
      }
    }
    return out;
  },
};

// =====================================================================
// Open tabs
// =====================================================================

export interface OpenTab {
  id: string;
  requestId: string;
  sortOrder: number;
  isPinned: boolean;
  isDirty: boolean;
  draft?: Record<string, unknown>;
}

interface TabRow {
  id: string;
  request_id: string;
  sort_order: number;
  is_pinned: number;
  is_dirty: number;
  draft_json: string | null;
}

function mapTabRow(row: TabRow): OpenTab {
  const base: OpenTab = {
    id: row.id,
    requestId: row.request_id,
    sortOrder: row.sort_order,
    isPinned: toBool(row.is_pinned),
    isDirty: toBool(row.is_dirty),
  };
  if (row.draft_json !== null && row.draft_json !== '') {
    base.draft = parseJson<Record<string, unknown>>(row.draft_json, {});
  }
  return base;
}

export const Tabs = {
  create(
    db: Db,
    input: { requestId: string; sortOrder?: number; isPinned?: boolean },
  ): OpenTab {
    const id = newId();
    const sortOrder = input.sortOrder ?? 0;
    const isPinned = input.isPinned ?? false;
    db.prepare(
      'INSERT INTO open_tabs (id, request_id, sort_order, is_pinned, is_dirty, draft_json) VALUES (?, ?, ?, ?, 0, NULL)',
    ).run(id, input.requestId, sortOrder, isPinned ? 1 : 0);
    return {
      id,
      requestId: input.requestId,
      sortOrder,
      isPinned,
      isDirty: false,
    };
  },

  get(db: Db, id: string): OpenTab | undefined {
    const row = db.prepare('SELECT * FROM open_tabs WHERE id = ?').get(id) as TabRow | undefined;
    return row ? mapTabRow(row) : undefined;
  },

  list(db: Db): OpenTab[] {
    const rows = db
      .prepare('SELECT * FROM open_tabs ORDER BY sort_order, id')
      .all() as TabRow[];
    return rows.map(mapTabRow);
  },

  saveDraft(db: Db, id: string, draft: Record<string, unknown>): void {
    const info = db
      .prepare('UPDATE open_tabs SET draft_json = ? WHERE id = ?')
      .run(JSON.stringify(draft), id);
    if (info.changes === 0) notFound();
  },

  setDirty(db: Db, id: string, isDirty: boolean): void {
    const info = db
      .prepare('UPDATE open_tabs SET is_dirty = ? WHERE id = ?')
      .run(isDirty ? 1 : 0, id);
    if (info.changes === 0) notFound();
  },

  close(db: Db, id: string): void {
    const info = db.prepare('DELETE FROM open_tabs WHERE id = ?').run(id);
    if (info.changes === 0) notFound();
  },

  reorder(db: Db, id: string, sortOrder: number): void {
    const info = db
      .prepare('UPDATE open_tabs SET sort_order = ? WHERE id = ?')
      .run(sortOrder, id);
    if (info.changes === 0) notFound();
  },
};

// =====================================================================
// Last responses
// =====================================================================

export interface LastResponse {
  requestId: string;
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer;
  ms?: number;
  sizeBytes?: number;
  executedAt?: string;
  errorText?: string;
}

interface LastResponseRow {
  request_id: string;
  status: number | null;
  headers_json: string | null;
  body_blob: Buffer | Uint8Array | null;
  ms: number | null;
  size_bytes: number | null;
  executed_at: string | null;
  error_text: string | null;
}

function mapLastResponseRow(row: LastResponseRow): LastResponse {
  const base: LastResponse = { requestId: row.request_id };
  if (row.status !== null) base.status = row.status;
  if (row.headers_json !== null && row.headers_json !== '') {
    base.headers = parseJson<Record<string, string>>(row.headers_json, {});
  }
  if (row.body_blob !== null) {
    base.body = Buffer.isBuffer(row.body_blob) ? row.body_blob : Buffer.from(row.body_blob);
  }
  if (row.ms !== null) base.ms = row.ms;
  if (row.size_bytes !== null) base.sizeBytes = row.size_bytes;
  if (row.executed_at !== null) base.executedAt = row.executed_at;
  if (row.error_text !== null) base.errorText = row.error_text;
  return base;
}

export const LastResponses = {
  upsert(
    db: Db,
    requestId: string,
    data: {
      status?: number;
      headers?: Record<string, string>;
      body?: Buffer;
      ms?: number;
      sizeBytes?: number;
      executedAt?: string;
      errorText?: string;
    },
  ): void {
    db.prepare(
      `INSERT INTO last_responses (request_id, status, headers_json, body_blob, ms, size_bytes, executed_at, error_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET
         status = excluded.status,
         headers_json = excluded.headers_json,
         body_blob = excluded.body_blob,
         ms = excluded.ms,
         size_bytes = excluded.size_bytes,
         executed_at = excluded.executed_at,
         error_text = excluded.error_text`,
    ).run(
      requestId,
      data.status ?? null,
      data.headers !== undefined ? JSON.stringify(data.headers) : null,
      data.body ?? null,
      data.ms ?? null,
      data.sizeBytes ?? null,
      data.executedAt ?? null,
      data.errorText ?? null,
    );
  },

  get(db: Db, requestId: string): LastResponse | undefined {
    const row = db.prepare('SELECT * FROM last_responses WHERE request_id = ?').get(requestId) as
      | LastResponseRow
      | undefined;
    return row ? mapLastResponseRow(row) : undefined;
  },

  clear(db: Db, requestId: string): void {
    db.prepare('DELETE FROM last_responses WHERE request_id = ?').run(requestId);
  },
};

// =====================================================================
// HTTP files
// =====================================================================

// `http_files` post-006 carries (collection_id, hash, last_imported_at)
// only — the file path is derived from the collection's directory tree
// and name. Hash + timestamp let adopt skip unchanged files on re-open.

export interface HttpFile {
  id: string;
  collectionId: string;
  lastImportedAt: string;
  hash: string;
}

interface HttpFileRow {
  id: string;
  collection_id: string;
  last_imported_at: string;
  hash: string;
}

function mapHttpFileRow(row: HttpFileRow): HttpFile {
  return {
    id: row.id,
    collectionId: row.collection_id,
    lastImportedAt: row.last_imported_at,
    hash: row.hash,
  };
}

export const HttpFiles = {
  record(db: Db, input: { collectionId: string; hash: string }): HttpFile {
    const id = newId();
    const ts = nowIso();
    // Upsert by collection_id so re-adoption replaces the existing row.
    db.prepare('DELETE FROM http_files WHERE collection_id = ?').run(input.collectionId);
    db.prepare(
      'INSERT INTO http_files (id, collection_id, last_imported_at, hash) VALUES (?, ?, ?, ?)',
    ).run(id, input.collectionId, ts, input.hash);
    return {
      id,
      collectionId: input.collectionId,
      lastImportedAt: ts,
      hash: input.hash,
    };
  },

  get(db: Db, id: string): HttpFile | undefined {
    const row = db.prepare('SELECT * FROM http_files WHERE id = ?').get(id) as
      | HttpFileRow
      | undefined;
    return row ? mapHttpFileRow(row) : undefined;
  },

  getByCollection(db: Db, collectionId: string): HttpFile | undefined {
    const row = db
      .prepare('SELECT * FROM http_files WHERE collection_id = ? LIMIT 1')
      .get(collectionId) as HttpFileRow | undefined;
    return row ? mapHttpFileRow(row) : undefined;
  },

  updateHash(db: Db, id: string, hash: string): void {
    const info = db
      .prepare('UPDATE http_files SET hash = ?, last_imported_at = ? WHERE id = ?')
      .run(hash, nowIso(), id);
    if (info.changes === 0) notFound();
  },

  delete(db: Db, id: string): void {
    const info = db.prepare('DELETE FROM http_files WHERE id = ?').run(id);
    if (info.changes === 0) notFound();
  },
};

// =====================================================================
// App settings (key/value)
// =====================================================================

interface AppSettingRow {
  value_json: string;
}

export const AppSettings = {
  /**
   * Read a setting. Returns the parsed value if present and JSON-parseable;
   * otherwise returns `fallback`. Corrupted entries are treated as missing
   * so the caller can re-seed without a manual recovery step.
   */
  get<T>(db: Db, key: string, fallback: T): T {
    const row = db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as
      | AppSettingRow
      | undefined;
    if (!row) return fallback;
    return parseJson<T>(row.value_json, fallback);
  },

  /**
   * Upsert a setting. Values are always stored as JSON so we don't have to
   * branch on type at the SQL layer.
   */
  set(db: Db, key: string, value: unknown): void {
    const json = JSON.stringify(value);
    const ts = nowIso();
    db.prepare(
      `INSERT INTO app_settings (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(key, json, ts);
  },

  /** True iff a value has ever been written for this key. */
  has(db: Db, key: string): boolean {
    const row = db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(key);
    return row !== undefined;
  },

  delete(db: Db, key: string): void {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  },
};

// =====================================================================
// Star export
// =====================================================================

export const Repos = {
  Workspaces,
  Directories,
  Collections,
  Folders,
  Requests,
  Envs,
  Vars,
  RequestVarOverrides,
  Tabs,
  LastResponses,
  HttpFiles,
  AppSettings,
};
