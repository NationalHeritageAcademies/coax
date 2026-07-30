import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@storage/db';
import {
  Workspaces,
  Collections,
  Folders,
  Requests,
  Envs,
  Vars,
  Tabs,
  LastResponses,
  HttpFiles,
  Repos,
} from '@storage/repos';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('Workspaces', () => {
  it('creates and lists', () => {
    const w = Workspaces.create(db, { name: 'work' });
    expect(w).toMatchObject({ name: 'work', settings: {} });
    expect(typeof w.id).toBe('string');
    expect(typeof w.createdAt).toBe('string');
    expect(typeof w.updatedAt).toBe('string');
    expect(Workspaces.list(db)).toEqual([w]);
  });

  it('get returns undefined when missing', () => {
    expect(Workspaces.get(db, 'no-such')).toBeUndefined();
  });

  it('updateSettings merges into settings_json', () => {
    const w = Workspaces.create(db, { name: 'w' });
    Workspaces.updateSettings(db, w.id, { activeGlobalEnvId: 'env-1' });
    expect(Workspaces.get(db, w.id)?.settings).toEqual({ activeGlobalEnvId: 'env-1' });
    Workspaces.updateSettings(db, w.id, { foo: 'bar' });
    expect(Workspaces.get(db, w.id)?.settings).toEqual({
      activeGlobalEnvId: 'env-1',
      foo: 'bar',
    });
  });

  it('rename and delete', () => {
    const w = Workspaces.create(db, { name: 'w' });
    Workspaces.rename(db, w.id, 'renamed');
    expect(Workspaces.get(db, w.id)?.name).toBe('renamed');
    Workspaces.delete(db, w.id);
    expect(Workspaces.get(db, w.id)).toBeUndefined();
  });
});

describe('Collections', () => {
  it('create and listByWorkspace; default directory is workspace root', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const a = Collections.create(db, { workspaceId: w.id, name: 'a' });
    const b = Collections.create(db, { workspaceId: w.id, name: 'b' });
    // Both land in the workspace's root directory (lazily created).
    expect(a.directoryId).toBe(b.directoryId);
    expect(a.directoryId).not.toBe('');
    const list = Collections.listByWorkspace(db, w.id);
    expect(list).toHaveLength(2);
  });

  it('rename, reorder, delete', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    Collections.rename(db, c.id, 'c2');
    Collections.reorder(db, c.id, 7);
    const got = Collections.get(db, c.id);
    expect(got?.name).toBe('c2');
    expect(got?.sortOrder).toBe(7);
    Collections.delete(db, c.id);
    expect(Collections.get(db, c.id)).toBeUndefined();
  });
});

describe('Collections cascading delete', () => {
  it('removes child requests when parent collection is deleted', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    Requests.create(db, { collectionId: c.id, name: 'r', method: 'GET', url: 'https://x' });
    Collections.delete(db, c.id);
    expect(Requests.listByCollection(db, c.id)).toEqual([]);
  });
});

describe('Folders', () => {
  it('listByCollection and reorder', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const f1 = Folders.create(db, { collectionId: c.id, name: 'A' });
    const f2 = Folders.create(db, { collectionId: c.id, name: 'B' });
    Folders.reorder(db, f1.id, 5);
    Folders.reorder(db, f2.id, 1);
    const list = Folders.listByCollection(db, c.id);
    expect(list[0]?.name).toBe('B');
    expect(list[1]?.name).toBe('A');
  });

  it('omitting parentFolderId attaches under the collection root', () => {
    // Post migration-003: every collection has an implicit root folder, and
    // user-created folders auto-attach there when no parent is specified.
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const top = Folders.create(db, { collectionId: c.id, name: 'top' });
    const child = Folders.create(db, {
      collectionId: c.id,
      name: 'child',
      parentFolderId: top.id,
    });
    expect(child.parentFolderId).toBe(top.id);
    expect(top.parentFolderId).toBe(c.rootFolderId);
  });

  it('rename and delete', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const f = Folders.create(db, { collectionId: c.id, name: 'F' });
    Folders.rename(db, f.id, 'F2');
    expect(Folders.get(db, f.id)?.name).toBe('F2');
    Folders.delete(db, f.id);
    expect(Folders.get(db, f.id)).toBeUndefined();
  });

  it('delete cascades to requests inside the folder', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const f = Folders.create(db, { collectionId: c.id, name: 'F' });
    const r1 = Requests.create(db, { collectionId: c.id, folderId: f.id, name: 'r1', method: 'GET', url: 'x' });
    const r2 = Requests.create(db, { collectionId: c.id, folderId: f.id, name: 'r2', method: 'GET', url: 'y' });
    Folders.delete(db, f.id);
    expect(Folders.get(db, f.id)).toBeUndefined();
    expect(Requests.get(db, r1.id)).toBeUndefined();
    expect(Requests.get(db, r2.id)).toBeUndefined();
  });

  it('delete cascades through descendant folders and their requests', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const a = Folders.create(db, { collectionId: c.id, name: 'a' });
    const bDeep = Folders.create(db, { collectionId: c.id, name: 'b', parentFolderId: a.id });
    const cDeep = Folders.create(db, { collectionId: c.id, name: 'c', parentFolderId: bDeep.id });
    const rA = Requests.create(db, { collectionId: c.id, folderId: a.id, name: 'r-a', method: 'GET', url: 'x' });
    const rB = Requests.create(db, { collectionId: c.id, folderId: bDeep.id, name: 'r-b', method: 'GET', url: 'x' });
    const rC = Requests.create(db, { collectionId: c.id, folderId: cDeep.id, name: 'r-c', method: 'GET', url: 'x' });
    Folders.delete(db, a.id);
    expect(Folders.get(db, a.id)).toBeUndefined();
    expect(Folders.get(db, bDeep.id)).toBeUndefined();
    expect(Folders.get(db, cDeep.id)).toBeUndefined();
    expect(Requests.get(db, rA.id)).toBeUndefined();
    expect(Requests.get(db, rB.id)).toBeUndefined();
    expect(Requests.get(db, rC.id)).toBeUndefined();
  });

  it('does NOT touch requests in sibling folders', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const f1 = Folders.create(db, { collectionId: c.id, name: 'f1' });
    const f2 = Folders.create(db, { collectionId: c.id, name: 'f2' });
    const r1 = Requests.create(db, { collectionId: c.id, folderId: f1.id, name: 'r1', method: 'GET', url: 'x' });
    const r2 = Requests.create(db, { collectionId: c.id, folderId: f2.id, name: 'r2', method: 'GET', url: 'x' });
    Folders.delete(db, f1.id);
    expect(Requests.get(db, r1.id)).toBeUndefined();
    expect(Requests.get(db, r2.id)?.name).toBe('r2');
  });
});

describe('Requests', () => {
  it('round-trips headers + body + auth as JSON', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const r = Requests.create(db, {
      collectionId: c.id,
      name: 'r',
      method: 'POST',
      url: 'https://x',
      headers: [
        { key: 'A', value: '1' },
        { key: 'B', value: '2' },
      ],
      body: { kind: 'json', raw: '{"a":1}' },
      auth: { kind: 'bearer', data: { token: '{{token}}' } },
    });
    const got = Requests.get(db, r.id)!;
    expect(got.headers).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: '2' },
    ]);
    expect(got.bodyKind).toBe('json');
    expect(got.bodyText).toBe('{"a":1}');
    expect(got.auth).toEqual({ kind: 'bearer', data: { token: '{{token}}' } });
  });

  it('defaults are sane when minimal input is provided', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const r = Requests.create(db, {
      collectionId: c.id,
      name: 'r',
      method: 'GET',
      url: 'https://x',
    });
    expect(r.headers).toEqual([]);
    expect(r.bodyKind).toBe('none');
    expect(r.bodyText).toBe('');
    expect(r.auth).toEqual({ kind: 'none' });
    expect(r.folderId).toBeUndefined();
  });

  it('update folderId: null clears it', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const f = Folders.create(db, { collectionId: c.id, name: 'F' });
    const r = Requests.create(db, {
      collectionId: c.id,
      folderId: f.id,
      name: 'r',
      method: 'GET',
      url: 'https://x',
    });
    expect(Requests.get(db, r.id)?.folderId).toBe(f.id);
    Requests.update(db, r.id, { folderId: null });
    expect(Requests.get(db, r.id)?.folderId).toBeUndefined();
  });

  it('update partial fields', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const r = Requests.create(db, {
      collectionId: c.id,
      name: 'r',
      method: 'GET',
      url: 'https://x',
    });
    Requests.update(db, r.id, {
      name: 'r2',
      method: 'POST',
      url: 'https://y',
      headers: [{ key: 'X', value: 'Y' }],
      body: { kind: 'json', raw: '{}' },
      auth: { kind: 'bearer', data: { token: 't' } },
    });
    const got = Requests.get(db, r.id)!;
    expect(got.name).toBe('r2');
    expect(got.method).toBe('POST');
    expect(got.url).toBe('https://y');
    expect(got.headers).toEqual([{ key: 'X', value: 'Y' }]);
    expect(got.bodyKind).toBe('json');
    expect(got.bodyText).toBe('{}');
    expect(got.auth).toEqual({ kind: 'bearer', data: { token: 't' } });
  });

  it('listByFolder', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const f = Folders.create(db, { collectionId: c.id, name: 'F' });
    Requests.create(db, {
      collectionId: c.id,
      folderId: f.id,
      name: 'a',
      method: 'GET',
      url: 'https://x',
    });
    Requests.create(db, {
      collectionId: c.id,
      folderId: f.id,
      name: 'b',
      method: 'GET',
      url: 'https://y',
    });
    expect(Requests.listByFolder(db, f.id)).toHaveLength(2);
  });

  it('reorder and delete', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const r = Requests.create(db, {
      collectionId: c.id,
      name: 'r',
      method: 'GET',
      url: 'https://x',
    });
    Requests.reorder(db, r.id, 9);
    expect(Requests.get(db, r.id)?.sortOrder).toBe(9);
    Requests.delete(db, r.id);
    expect(Requests.get(db, r.id)).toBeUndefined();
  });

  it('round-trips chainName', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const r = Requests.create(db, {
      collectionId: c.id,
      name: 'Get token',
      method: 'POST',
      url: 'https://x.test/token',
      chainName: 'getToken',
    });
    expect(Requests.get(db, r.id)?.chainName).toBe('getToken');
    Requests.update(db, r.id, { chainName: 'renamed' });
    expect(Requests.get(db, r.id)?.chainName).toBe('renamed');
    Requests.update(db, r.id, { chainName: null });
    expect(Requests.get(db, r.id)?.chainName).toBeUndefined();
  });

  it('listByChainName returns requests with chain_name set, scoped to workspace', () => {
    const w1 = Workspaces.create(db, { name: 'w1' });
    const w2 = Workspaces.create(db, { name: 'w2' });
    const c1 = Collections.create(db, { workspaceId: w1.id, name: 'c1' });
    const c2 = Collections.create(db, { workspaceId: w2.id, name: 'c2' });
    const a = Requests.create(db, {
      collectionId: c1.id,
      name: 'a',
      method: 'GET',
      url: 'https://x',
      chainName: 'getToken',
    });
    Requests.create(db, {
      collectionId: c1.id,
      name: 'b',
      method: 'GET',
      url: 'https://x',
    });
    Requests.create(db, {
      collectionId: c2.id,
      name: 'other',
      method: 'GET',
      url: 'https://x',
      chainName: 'shouldNotLeak',
    });
    const list = Requests.listByChainName(db, w1.id);
    expect(list).toEqual([{ id: a.id, chainName: 'getToken' }]);
  });
});

describe('Envs folder-scoped', () => {
  it('list filters by folder', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c1 = Collections.create(db, { workspaceId: w.id, name: 'c1' });
    const c2 = Collections.create(db, { workspaceId: w.id, name: 'c2' });
    const e1 = Envs.create(db, { folderId: c1.rootFolderId, name: 'dev' });
    const e2 = Envs.create(db, { folderId: c1.rootFolderId, name: 'prod' });
    const e3 = Envs.create(db, { folderId: c2.rootFolderId, name: 'local' });
    expect(Envs.list(db, c1.rootFolderId)).toEqual([e1, e2]);
    expect(Envs.list(db, c2.rootFolderId)).toEqual([e3]);
  });

  it('setActive marks one and unmarks the rest in same folder (not other folders)', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c1 = Collections.create(db, { workspaceId: w.id, name: 'c1' });
    const c2 = Collections.create(db, { workspaceId: w.id, name: 'c2' });
    const a = Envs.create(db, { folderId: c1.rootFolderId, name: 'a' });
    const b = Envs.create(db, { folderId: c1.rootFolderId, name: 'b' });
    const x = Envs.create(db, { folderId: c2.rootFolderId, name: 'x' });
    Envs.setActive(db, b.id);
    expect(Envs.get(db, a.id)?.isActive).toBe(false);
    expect(Envs.get(db, b.id)?.isActive).toBe(true);
    Envs.setActive(db, x.id);
    expect(Envs.get(db, x.id)?.isActive).toBe(true);
    expect(Envs.get(db, b.id)?.isActive).toBe(true);
  });

  it('setActive with bad envId throws NOT_FOUND', () => {
    const w = Workspaces.create(db, { name: 'w' });
    Collections.create(db, { workspaceId: w.id, name: 'c' });
    expect(() => { Envs.setActive(db, 'no-such'); }).toThrow(/NOT_FOUND/);
  });

  it('rename and delete', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const e = Envs.create(db, { folderId: c.rootFolderId, name: 'a' });
    Envs.rename(db, e.id, 'b');
    expect(Envs.get(db, e.id)?.name).toBe('b');
    Envs.delete(db, e.id);
    expect(Envs.get(db, e.id)).toBeUndefined();
  });
});

describe('Folders.reparent', () => {
  it('moves a folder under a new parent within the same collection', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const a = Folders.create(db, { collectionId: c.id, name: 'a' });
    const b = Folders.create(db, { collectionId: c.id, name: 'b' });
    Folders.reparent(db, b.id, a.id);
    expect(Folders.get(db, b.id)?.parentFolderId).toBe(a.id);
  });

  it('rejects self-reparenting', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const a = Folders.create(db, { collectionId: c.id, name: 'a' });
    expect(() => Folders.reparent(db, a.id, a.id)).toThrow(/itself/);
  });

  it('rejects cycles', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const a = Folders.create(db, { collectionId: c.id, name: 'a' });
    const b = Folders.create(db, { collectionId: c.id, name: 'b', parentFolderId: a.id });
    expect(() => Folders.reparent(db, a.id, b.id)).toThrow(/descendants/);
  });

  it('moves a folder across collections, cascading collection_id to descendants', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c1 = Collections.create(db, { workspaceId: w.id, name: 'c1' });
    const c2 = Collections.create(db, { workspaceId: w.id, name: 'c2' });

    // c1: a (root) > b (child) > c (grandchild). Each has one request.
    const a = Folders.create(db, { collectionId: c1.id, name: 'a' });
    const bDeep = Folders.create(db, {
      collectionId: c1.id,
      name: 'b',
      parentFolderId: a.id,
    });
    const cDeep = Folders.create(db, {
      collectionId: c1.id,
      name: 'c',
      parentFolderId: bDeep.id,
    });
    const rA = Requests.create(db, {
      collectionId: c1.id,
      folderId: a.id,
      name: 'r-a',
      method: 'GET',
      url: 'x',
    });
    const rB = Requests.create(db, {
      collectionId: c1.id,
      folderId: bDeep.id,
      name: 'r-b',
      method: 'GET',
      url: 'x',
    });
    const rC = Requests.create(db, {
      collectionId: c1.id,
      folderId: cDeep.id,
      name: 'r-c',
      method: 'GET',
      url: 'x',
    });

    const moved = Folders.reparent(db, a.id, c2.rootFolderId);
    expect(moved.collectionId).toBe(c2.id);
    expect(moved.parentFolderId).toBe(c2.rootFolderId);

    // The folder, all descendants, and all requests inside any of them now
    // live under c2.
    expect(Folders.get(db, a.id)?.collectionId).toBe(c2.id);
    expect(Folders.get(db, bDeep.id)?.collectionId).toBe(c2.id);
    expect(Folders.get(db, cDeep.id)?.collectionId).toBe(c2.id);
    expect(Requests.get(db, rA.id)?.collectionId).toBe(c2.id);
    expect(Requests.get(db, rB.id)?.collectionId).toBe(c2.id);
    expect(Requests.get(db, rC.id)?.collectionId).toBe(c2.id);
    // Folder relationships inside the moved subtree stay intact.
    expect(Folders.get(db, bDeep.id)?.parentFolderId).toBe(a.id);
    expect(Folders.get(db, cDeep.id)?.parentFolderId).toBe(bDeep.id);
  });
});

describe('Vars secret round-trip', () => {
  it('stores plaintext when not secret, blob when secret', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const e = Envs.create(db, { folderId: c.rootFolderId, name: 'dev' });
    const v1 = Vars.create(db, { envId: e.id, key: 'baseUrl', valuePlain: 'https://x.test' });
    const v2 = Vars.create(db, {
      envId: e.id,
      key: 'token',
      valueSecretBlob: Buffer.from([1, 2, 3]),
    });
    expect(Vars.get(db, v1.id)?.valuePlain).toBe('https://x.test');
    expect(Vars.get(db, v1.id)?.isSecret).toBe(false);
    const got2 = Vars.get(db, v2.id)!;
    expect(got2.valueSecretBlob).toEqual(Buffer.from([1, 2, 3]));
    expect(got2.isSecret).toBe(true);
    expect(got2.valuePlain).toBeUndefined();
  });

  it('listByEnv returns vars for that env', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const e1 = Envs.create(db, { folderId: c.rootFolderId, name: 'a' });
    const e2 = Envs.create(db, { folderId: c.rootFolderId, name: 'b' });
    Vars.create(db, { envId: e1.id, key: 'k1', valuePlain: 'v1' });
    Vars.create(db, { envId: e1.id, key: 'k2', valuePlain: 'v2' });
    Vars.create(db, { envId: e2.id, key: 'kx', valuePlain: 'vx' });
    expect(Vars.listByEnv(db, e1.id)).toHaveLength(2);
    expect(Vars.listByEnv(db, e2.id)).toHaveLength(1);
  });

  it('update can switch secret <-> plain by nulling fields', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const e = Envs.create(db, { folderId: c.rootFolderId, name: 'a' });
    const v = Vars.create(db, { envId: e.id, key: 'k', valuePlain: 'plain' });
    Vars.update(db, v.id, {
      valuePlain: null,
      valueSecretBlob: Buffer.from([9]),
      isSecret: true,
    });
    const got = Vars.get(db, v.id)!;
    expect(got.valuePlain).toBeUndefined();
    expect(got.isSecret).toBe(true);
    expect(got.valueSecretBlob).toEqual(Buffer.from([9]));
  });

  it('delete', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const e = Envs.create(db, { folderId: c.rootFolderId, name: 'a' });
    const v = Vars.create(db, { envId: e.id, key: 'k', valuePlain: 'p' });
    Vars.delete(db, v.id);
    expect(Vars.get(db, v.id)).toBeUndefined();
  });
});

describe('Tabs draft survives', () => {
  it('persists draft_json', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const r = Requests.create(db, {
      collectionId: c.id,
      name: 'r',
      method: 'GET',
      url: 'https://x',
    });
    const t = Tabs.create(db, { requestId: r.id });
    Tabs.saveDraft(db, t.id, { url: 'https://y' });
    expect(Tabs.get(db, t.id)?.draft).toEqual({ url: 'https://y' });
  });

  it('list returns tabs in sortOrder', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const r = Requests.create(db, {
      collectionId: c.id,
      name: 'r',
      method: 'GET',
      url: 'https://x',
    });
    const t1 = Tabs.create(db, { requestId: r.id, sortOrder: 2 });
    const t2 = Tabs.create(db, { requestId: r.id, sortOrder: 1 });
    expect(Tabs.list(db).map((t) => t.id)).toEqual([t2.id, t1.id]);
  });

  it('setDirty, reorder, close', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const r = Requests.create(db, {
      collectionId: c.id,
      name: 'r',
      method: 'GET',
      url: 'https://x',
    });
    const t = Tabs.create(db, { requestId: r.id, isPinned: true });
    expect(t.isPinned).toBe(true);
    expect(t.isDirty).toBe(false);
    Tabs.setDirty(db, t.id, true);
    expect(Tabs.get(db, t.id)?.isDirty).toBe(true);
    Tabs.reorder(db, t.id, 5);
    expect(Tabs.get(db, t.id)?.sortOrder).toBe(5);
    Tabs.close(db, t.id);
    expect(Tabs.get(db, t.id)).toBeUndefined();
  });
});

describe('LastResponses upsert', () => {
  it('upsert writes then overwrites', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const r = Requests.create(db, {
      collectionId: c.id,
      name: 'r',
      method: 'GET',
      url: 'https://x',
    });
    LastResponses.upsert(db, r.id, { status: 200, ms: 42, body: Buffer.from('hi') });
    expect(LastResponses.get(db, r.id)).toMatchObject({ status: 200, ms: 42 });
    LastResponses.upsert(db, r.id, { status: 500, errorText: 'boom' });
    const got = LastResponses.get(db, r.id)!;
    expect(got.status).toBe(500);
    expect(got.errorText).toBe('boom');
  });

  it('round-trips headers as record', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const r = Requests.create(db, {
      collectionId: c.id,
      name: 'r',
      method: 'GET',
      url: 'https://x',
    });
    LastResponses.upsert(db, r.id, { status: 200, headers: { 'content-type': 'application/json' } });
    expect(LastResponses.get(db, r.id)?.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('clear removes the row', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const r = Requests.create(db, {
      collectionId: c.id,
      name: 'r',
      method: 'GET',
      url: 'https://x',
    });
    LastResponses.upsert(db, r.id, { status: 200 });
    LastResponses.clear(db, r.id);
    expect(LastResponses.get(db, r.id)).toBeUndefined();
  });
});

describe('HttpFiles', () => {
  it('record, getByCollection, updateHash', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const hf = HttpFiles.record(db, { collectionId: c.id, hash: 'abc' });
    expect(HttpFiles.getByCollection(db, c.id)).toEqual(hf);
    HttpFiles.updateHash(db, hf.id, 'def');
    expect(HttpFiles.get(db, hf.id)?.hash).toBe('def');
  });

  it('delete', () => {
    const w = Workspaces.create(db, { name: 'w' });
    const c = Collections.create(db, { workspaceId: w.id, name: 'c' });
    const hf = HttpFiles.record(db, { collectionId: c.id, hash: 'abc' });
    HttpFiles.delete(db, hf.id);
    expect(HttpFiles.get(db, hf.id)).toBeUndefined();
  });
});

describe('NOT_FOUND errors', () => {
  it('rename on missing workspace throws', () => {
    expect(() => { Workspaces.rename(db, 'no-such', 'x'); }).toThrow(/NOT_FOUND/);
  });
  it('delete on missing workspace throws', () => {
    expect(() => { Workspaces.delete(db, 'no-such'); }).toThrow(/NOT_FOUND/);
  });
  it('updateSettings on missing workspace throws', () => {
    expect(() => { Workspaces.updateSettings(db, 'no-such', { x: 1 }); }).toThrow(/NOT_FOUND/);
  });
  it('Collections rename/delete/reorder missing throws', () => {
    expect(() => { Collections.rename(db, 'no-such', 'x'); }).toThrow(/NOT_FOUND/);
    expect(() => { Collections.delete(db, 'no-such'); }).toThrow(/NOT_FOUND/);
    expect(() => { Collections.reorder(db, 'no-such', 1); }).toThrow(/NOT_FOUND/);
  });
  it('Folders rename/delete/reorder missing throws', () => {
    expect(() => { Folders.rename(db, 'no-such', 'x'); }).toThrow(/NOT_FOUND/);
    expect(() => { Folders.delete(db, 'no-such'); }).toThrow(/NOT_FOUND/);
    expect(() => { Folders.reorder(db, 'no-such', 1); }).toThrow(/NOT_FOUND/);
  });
  it('update on missing request throws', () => {
    expect(() => { Requests.update(db, 'no-such', { name: 'x' }); }).toThrow(/NOT_FOUND/);
  });
  it('Requests delete/reorder missing throws', () => {
    expect(() => { Requests.delete(db, 'no-such'); }).toThrow(/NOT_FOUND/);
    expect(() => { Requests.reorder(db, 'no-such', 1); }).toThrow(/NOT_FOUND/);
  });
  it('Envs rename/delete missing throws', () => {
    expect(() => { Envs.rename(db, 'no-such', 'x'); }).toThrow(/NOT_FOUND/);
    expect(() => { Envs.delete(db, 'no-such'); }).toThrow(/NOT_FOUND/);
  });
  it('Vars update/delete missing throws', () => {
    expect(() => { Vars.update(db, 'no-such', { key: 'x' }); }).toThrow(/NOT_FOUND/);
    expect(() => { Vars.delete(db, 'no-such'); }).toThrow(/NOT_FOUND/);
  });
  it('Tabs saveDraft/setDirty/close/reorder missing throws', () => {
    expect(() => { Tabs.saveDraft(db, 'no-such', {}); }).toThrow(/NOT_FOUND/);
    expect(() => { Tabs.setDirty(db, 'no-such', true); }).toThrow(/NOT_FOUND/);
    expect(() => { Tabs.close(db, 'no-such'); }).toThrow(/NOT_FOUND/);
    expect(() => { Tabs.reorder(db, 'no-such', 1); }).toThrow(/NOT_FOUND/);
  });
  it('HttpFiles updateHash/delete missing throws', () => {
    expect(() => { HttpFiles.updateHash(db, 'no-such', 'h'); }).toThrow(/NOT_FOUND/);
    expect(() => { HttpFiles.delete(db, 'no-such'); }).toThrow(/NOT_FOUND/);
  });
});

describe('AppSettings', () => {
  it('returns fallback when key is absent', () => {
    const db = openDb(':memory:');
    expect(Repos.AppSettings.get(db, 'ui.sidebarWidth', { fallback: true })).toEqual({
      fallback: true,
    });
  });

  it('round-trips JSON values', () => {
    const db = openDb(':memory:');
    Repos.AppSettings.set(db, 'ui.sidebarWidth', { width: 280, unit: 'px' });
    expect(Repos.AppSettings.get(db, 'ui.sidebarWidth', null)).toEqual({
      width: 280,
      unit: 'px',
    });
  });

  it('upserts existing keys', () => {
    const db = openDb(':memory:');
    Repos.AppSettings.set(db, 'k', 1);
    Repos.AppSettings.set(db, 'k', 2);
    expect(Repos.AppSettings.get<number>(db, 'k', 0)).toBe(2);
  });

  it('has() reflects presence regardless of value', () => {
    const db = openDb(':memory:');
    expect(Repos.AppSettings.has(db, 'k')).toBe(false);
    Repos.AppSettings.set(db, 'k', null);
    expect(Repos.AppSettings.has(db, 'k')).toBe(true);
  });

  it('delete() removes a key', () => {
    const db = openDb(':memory:');
    Repos.AppSettings.set(db, 'k', 'v');
    Repos.AppSettings.delete(db, 'k');
    expect(Repos.AppSettings.has(db, 'k')).toBe(false);
  });
});

describe('Repos star export', () => {
  it('exposes all repos', () => {
    expect(Object.keys(Repos).sort()).toEqual(
      [
        'AppSettings',
        'Collections',
        'Directories',
        'Envs',
        'Folders',
        'HttpFiles',
        'LastResponses',
        'RequestVarOverrides',
        'Requests',
        'Tabs',
        'Vars',
        'Workspaces',
      ].sort(),
    );
  });
});
