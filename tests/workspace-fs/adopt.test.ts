import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '@storage/db';
import { Repos } from '@storage/repos';
import { adoptEnvFile, adoptHttpFile, adoptWorkspace } from '@workspace-fs/adopt';
import { flushCollection, flushEnv } from '@workspace-fs/flush';
import { serializeEnvFile } from '@workspace-fs/env-file';

let db: Db;
let dir: string;

beforeEach(() => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'adopt-test-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// =============================================================================
// adoptHttpFile
// =============================================================================

describe('adoptHttpFile', () => {
  it('creates a collection and a request from a minimal .http file', () => {
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    const path = join(dir, 'scholar.http');
    writeFileSync(
      path,
      `### List users
GET https://x.test/users
`,
    );
    const result = adoptHttpFile(db, Repos.Directories.getRoot(db, w.id)?.id ?? Repos.Directories.create(db, { workspaceId: w.id, name: "" }).id, path);
    expect(result.requestsAdopted).toBe(1);
    expect(result.collectionName).toBe('Scholar');
    const col = Repos.Collections.get(db, result.collectionId);
    expect(col).toBeDefined();
    const requests = Repos.Requests.listByCollection(db, result.collectionId);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.name).toBe('List users');
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url).toBe('https://x.test/users');
  });

  it('flattens @folder directives (legacy data adopts as a flat list)', () => {
    // Under the directories model the only folder concept is on-disk
    // subdirectories. Any `# @folder` line a parsed request carries is
    // silently dropped during adoption — the request lands at the
    // collection root and the directive disappears on the next flush.
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    const path = join(dir, 'scholar.http');
    writeFileSync(
      path,
      `### Root request
GET https://x.test/

### List users
# @folder /users
GET https://x.test/users

### Deep
# @folder /a/b/c
GET https://x.test/deep
`,
    );
    const result = adoptHttpFile(db, Repos.Directories.getRoot(db, w.id)?.id ?? Repos.Directories.create(db, { workspaceId: w.id, name: "" }).id, path);
    expect(result.requestsAdopted).toBe(3);
    // No nested folder rows created — every request sits at the collection root.
    const folders = Repos.Folders.listByCollection(db, result.collectionId);
    expect(folders.map((f) => f.name)).toEqual([]);
    const requests = Repos.Requests.listByCollection(db, result.collectionId);
    const col = Repos.Collections.get(db, result.collectionId)!;
    for (const r of requests) {
      expect(r.folderId).toBe(col.rootFolderId);
    }
  });

  it('preserves chain name (@name directive) on requests', () => {
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    const path = join(dir, 'auth.http');
    writeFileSync(
      path,
      `### Login
# @name login
POST https://x.test/auth
`,
    );
    const result = adoptHttpFile(db, Repos.Directories.getRoot(db, w.id)?.id ?? Repos.Directories.create(db, { workspaceId: w.id, name: "" }).id, path);
    const requests = Repos.Requests.listByCollection(db, result.collectionId);
    expect(requests[0]?.chainName).toBe('login');
  });

  it('round-trips a flat collection through flush → adopt', async () => {
    // Build a collection in DB1, flush to file, adopt into a fresh DB2,
    // confirm the second collection has the same requests. No internal
    // folders under the directories model — the file is just a list.
    const w1 = Repos.Workspaces.create(db, { name: 'ws' });
    const c1 = Repos.Collections.create(db, { workspaceId: w1.id, name: 'scholar' });
    Repos.Requests.create(db, {
      collectionId: c1.id,
      folderId: c1.rootFolderId,
      name: 'Health',
      method: 'GET',
      url: 'https://x.test/health',
      headers: [],
    });
    Repos.Requests.create(db, {
      collectionId: c1.id,
      folderId: c1.rootFolderId,
      name: 'List users',
      method: 'GET',
      url: 'https://x.test/users',
      headers: [{ key: 'Accept', value: 'application/json' }],
    });
    Repos.Requests.create(db, {
      collectionId: c1.id,
      folderId: c1.rootFolderId,
      name: 'Promote',
      method: 'POST',
      url: 'https://x.test/users/admin',
      headers: [],
    });

    const path = join(dir, 'scholar.http');
    await flushCollection(db, c1.id, path);

    // Fresh DB; adopt the file.
    const db2 = openDb(':memory:');
    try {
      const w2 = Repos.Workspaces.create(db2, { name: 'ws' });
      const adopted = adoptHttpFile(db2, Repos.Directories.getRoot(db2, w2.id)?.id ?? Repos.Directories.create(db2, { workspaceId: w2.id, name: '' }).id, path);
      expect(adopted.requestsAdopted).toBe(3);

      const requests2 = Repos.Requests.listByCollection(db2, adopted.collectionId);
      const names = requests2.map((r) => r.name).sort();
      expect(names).toEqual(['Health', 'List users', 'Promote']);

      // No internal folders re-created — confirms the @folder concept is gone.
      const folders2 = Repos.Folders.listByCollection(db2, adopted.collectionId);
      expect(folders2.map((f) => f.name)).toEqual([]);
    } finally {
      db2.close();
    }
  });

  it('lands `# @override` directives as request_var_overrides rows', () => {
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    const path = join(dir, 'auth.http');
    writeFileSync(
      path,
      `### Get Token
# @override baseUrl https://override.test/api
# @override:secret apiKey
POST {{baseUrl}}/token
`,
    );
    const result = adoptHttpFile(db, Repos.Directories.getRoot(db, w.id)?.id ?? Repos.Directories.create(db, { workspaceId: w.id, name: "" }).id, path);
    const requests = Repos.Requests.listByCollection(db, result.collectionId);
    expect(requests).toHaveLength(1);
    const rows = Repos.RequestVarOverrides.listByRequest(db, requests[0]!.id);
    const byKey = Object.fromEntries(rows.map((o) => [o.key, o]));
    expect(byKey.baseUrl?.isSecret).toBe(false);
    expect(byKey.baseUrl?.valuePlain).toBe('https://override.test/api');
    expect(byKey.apiKey?.isSecret).toBe(true);
    // Sentinel: secret override with no value in source → zero-byte blob.
    expect(byKey.apiKey?.valueSecretBlob?.length).toBe(0);
  });

  it('overrides survive a full flush → adopt round-trip', async () => {
    const w1 = Repos.Workspaces.create(db, { name: 'ws' });
    const c1 = Repos.Collections.create(db, { workspaceId: w1.id, name: 'auth' });
    const req = Repos.Requests.create(db, {
      collectionId: c1.id,
      folderId: c1.rootFolderId,
      name: 'Get Token',
      method: 'POST',
      url: '{{baseUrl}}/token',
      headers: [],
    });
    Repos.RequestVarOverrides.upsert(db, {
      requestId: req.id,
      key: 'baseUrl',
      valuePlain: 'https://override.test/api',
    });

    const path = join(dir, 'auth.http');
    await flushCollection(db, c1.id, path);

    const db2 = openDb(':memory:');
    try {
      const w2 = Repos.Workspaces.create(db2, { name: 'ws' });
      const adopted = adoptHttpFile(db2, Repos.Directories.getRoot(db2, w2.id)?.id ?? Repos.Directories.create(db2, { workspaceId: w2.id, name: '' }).id, path);
      const requests2 = Repos.Requests.listByCollection(db2, adopted.collectionId);
      expect(requests2).toHaveLength(1);
      const rows = Repos.RequestVarOverrides.listByRequest(db2, requests2[0]!.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.key).toBe('baseUrl');
      expect(rows[0]?.valuePlain).toBe('https://override.test/api');
    } finally {
      db2.close();
    }
  });

  it('display name comes from the filename with hyphens → spaces and Title Case', () => {
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    const path = join(dir, 'scholar-gateway-api.http');
    writeFileSync(path, '### x\nGET https://y.test\n');
    const result = adoptHttpFile(db, Repos.Directories.getRoot(db, w.id)?.id ?? Repos.Directories.create(db, { workspaceId: w.id, name: "" }).id, path);
    expect(result.collectionName).toBe('Scholar Gateway Api');
  });
});

// =============================================================================
// adoptEnvFile
// =============================================================================

describe('adoptEnvFile', () => {
  it('creates a directory-scoped env with all vars from the file', () => {
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    // Lazy-mint a root directory by creating a collection (handlers do
    // the same; the env adopter only needs the directoryId).
    Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    const rootDir = Repos.Directories.getRoot(db, w.id)!;

    const envPath = join(dir, 'c.dev.env.json');
    writeFileSync(
      envPath,
      serializeEnvFile({
        name: 'dev',
        vars: [
          { key: 'baseUrl', valuePlain: 'https://dev' },
          { key: 'userId', valuePlain: '42' },
        ],
      }),
    );

    const result = adoptEnvFile(db, { directoryId: rootDir.id }, envPath);
    if ('error' in result) throw new Error(`Expected success: ${result.error}`);
    expect(result.envName).toBe('dev');
    expect(result.varsAdopted).toBe(2);

    const dirEnvs = Repos.Envs.listByDirectory(db, rootDir.id);
    const dev = dirEnvs.find((e) => e.name === 'dev');
    expect(dev).toBeDefined();
    expect(dev?.directoryId).toBe(rootDir.id);
    expect(dev?.folderId).toBeUndefined();
  });

  it('accepts the legacy scopes[] format (vars merged into one flat env)', () => {
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    const rootDir = Repos.Directories.getRoot(db, w.id)!;

    const envPath = join(dir, 'c.dev.env.json');
    writeFileSync(
      envPath,
      JSON.stringify({
        name: 'dev',
        scopes: [
          { folder: '/', vars: [{ key: 'baseUrl', valuePlain: 'https://dev' }] },
          { folder: '/users', vars: [{ key: 'userId', valuePlain: '42' }] },
        ],
      }),
    );

    const result = adoptEnvFile(db, { directoryId: rootDir.id }, envPath);
    if ('error' in result) throw new Error(`Expected success: ${result.error}`);
    expect(result.varsAdopted).toBe(2);
  });

  it('round-trips secret vars (created with empty blob, reflagged isSecret on flush)', async () => {
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    const env = Repos.Envs.create(db, { folderId: c.rootFolderId, name: 'dev' });
    Repos.Vars.create(db, {
      envId: env.id,
      key: 'token',
      valueSecretBlob: Buffer.from('the-real-secret'),
    });

    const envPath = join(dir, 'c.dev.env.json');
    await flushEnv(db, c.id, 'dev', envPath);

    const db2 = openDb(':memory:');
    try {
      const w2 = Repos.Workspaces.create(db2, { name: 'ws' });
      Repos.Collections.create(db2, { workspaceId: w2.id, name: 'c' });
      const rootDir2 = Repos.Directories.getRoot(db2, w2.id)!;
      const result = adoptEnvFile(db2, { directoryId: rootDir2.id }, envPath);
      if ('error' in result) throw new Error('Expected success');
      const env2 = Repos.Envs.listByDirectory(db2, rootDir2.id).find((e) => e.name === 'dev')!;
      const vars2 = Repos.Vars.listByEnv(db2, env2.id);
      expect(vars2).toHaveLength(1);
      expect(vars2[0]?.isSecret).toBe(true);
      // The secret value did NOT travel through the file — DB2 has an empty
      // blob (the value would come from the keychain at request-send time).
      expect(vars2[0]?.valueSecretBlob).toBeDefined();
    } finally {
      db2.close();
    }
  });

  it('returns an error for an unparseable file', () => {
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    const rootDir = Repos.Directories.getRoot(db, w.id)!;
    const envPath = join(dir, 'c.dev.env.json');
    writeFileSync(envPath, '{not valid json');
    const result = adoptEnvFile(db, { directoryId: rootDir.id }, envPath);
    expect(result).toHaveProperty('error');
  });
});

// =============================================================================
// adoptWorkspace — collection-prefix env scoping
// =============================================================================

describe('adoptWorkspace env-file scoping', () => {
  it('binds <collection>.<env>.env.json to the matching collection, not the directory', () => {
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    writeFileSync(join(dir, 'scholar.http'), '### Stub\nGET https://x.test/\n');
    writeFileSync(
      join(dir, 'scholar.ci.env.json'),
      JSON.stringify({
        name: 'CI',
        vars: [{ key: 'baseUrl', valuePlain: 'https://staging.example.test' }],
      }),
    );

    const result = adoptWorkspace(db, w.id, dir);
    expect(result.warnings).toEqual([]);
    expect(result.collectionsAdopted).toBe(1);
    expect(result.envsAdopted).toBe(1);

    const rootDir = Repos.Directories.getRoot(db, w.id)!;
    // Env should NOT be at the workspace root directory…
    expect(Repos.Envs.listByDirectory(db, rootDir.id)).toEqual([]);
    // …it should be on the collection's root folder.
    const collections = Repos.Collections.listByDirectory(db, rootDir.id);
    expect(collections).toHaveLength(1);
    const folderEnvs = Repos.Envs.list(db, collections[0]!.rootFolderId);
    expect(folderEnvs).toHaveLength(1);
    expect(folderEnvs[0]!.name).toBe('CI');
  });

  it('falls back to directory scope when the env file has no matching .http prefix', () => {
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    writeFileSync(join(dir, 'scholar.http'), '### Stub\nGET https://x.test/\n');
    // ci.env.json — no collection prefix, applies to the whole directory.
    writeFileSync(
      join(dir, 'ci.env.json'),
      JSON.stringify({
        name: 'CI',
        vars: [{ key: 'token', valuePlain: 'abc' }],
      }),
    );

    const result = adoptWorkspace(db, w.id, dir);
    expect(result.envsAdopted).toBe(1);

    const rootDir = Repos.Directories.getRoot(db, w.id)!;
    const dirEnvs = Repos.Envs.listByDirectory(db, rootDir.id);
    expect(dirEnvs).toHaveLength(1);
    expect(dirEnvs[0]!.name).toBe('CI');

    // The collection's root folder should have no envs.
    const collections = Repos.Collections.listByDirectory(db, rootDir.id);
    const folderEnvs = Repos.Envs.list(db, collections[0]!.rootFolderId);
    expect(folderEnvs).toEqual([]);
  });
});
