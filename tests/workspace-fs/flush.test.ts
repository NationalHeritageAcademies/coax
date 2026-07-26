import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '@storage/db';
import { Repos } from '@storage/repos';
import { flushCollection, flushEnv } from '@workspace-fs/flush';
import { parseHttpFile } from '@parser/parse';
import { parseEnvFile } from '@workspace-fs/env-file';

let db: Db;
let dir: string;

beforeEach(() => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'flush-test-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// =============================================================================
// flushCollection
// =============================================================================

describe('flushCollection', () => {
  it('writes a .http file at the target path', async () => {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'scholar' });
    Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: c.rootFolderId,
      name: 'List users',
      method: 'GET',
      url: 'https://api.example.com/users',
      headers: [],
    });
    const path = join(dir, 'scholar.http');
    await flushCollection(db, c.id, path);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('### List users');
    expect(text).toContain('GET https://api.example.com/users');
  });

  it('emits @id for every request', async () => {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    const r = Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: c.rootFolderId,
      name: 'Hello',
      method: 'GET',
      url: 'https://x.test',
      headers: [],
    });
    const path = join(dir, 'c.http');
    await flushCollection(db, c.id, path);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(`# @id ${r.id}`);
  });

  it('never emits @folder, even when legacy folder rows still exist in the cache', async () => {
    // The serializer dropped `@folder` under the directories model.
    // Pre-existing folder rows in the cache (a legacy import) don't
    // produce any `@folder` lines in the flushed file.
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    const legacy = Repos.Folders.create(db, {
      collectionId: c.id,
      name: 'users',
      parentFolderId: c.rootFolderId,
    });
    Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: c.rootFolderId,
      name: 'Root request',
      method: 'GET',
      url: 'https://x.test/',
      headers: [],
    });
    Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: legacy.id,
      name: 'Legacy in-folder request',
      method: 'GET',
      url: 'https://x.test/users',
      headers: [],
    });
    const path = join(dir, 'c.http');
    await flushCollection(db, c.id, path);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain('@folder');
    expect(text).toContain('### Root request');
    expect(text).toContain('### Legacy in-folder request');
  });

  it('preserves chain name (@name directive)', async () => {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: c.rootFolderId,
      name: 'Login',
      chainName: 'login',
      method: 'POST',
      url: 'https://x.test/auth',
      headers: [],
    });
    const path = join(dir, 'c.http');
    await flushCollection(db, c.id, path);
    expect(readFileSync(path, 'utf8')).toContain('# @name login');
  });

  it('round-trips a flat collection through parse → flush → parse', async () => {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: c.rootFolderId,
      name: 'Health',
      method: 'GET',
      url: 'https://x.test/health',
      headers: [],
    });
    Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: c.rootFolderId,
      name: 'List users',
      method: 'GET',
      url: 'https://x.test/users',
      headers: [{ key: 'Accept', value: 'application/json' }],
    });
    const path = join(dir, 'c.http');
    await flushCollection(db, c.id, path);
    const text = readFileSync(path, 'utf8');
    const parsed = parseHttpFile(text);
    expect(parsed.requests).toHaveLength(2);
    const titles = parsed.requests.map((r) => r.title);
    expect(titles).toContain('Health');
    expect(titles).toContain('List users');
    // No `@folder` in the round-tripped data — parsed requests have no
    // folderPath, the directories-model way.
    for (const r of parsed.requests) {
      expect(r.folderPath).toBeUndefined();
    }
  });

  it('throws NOT_FOUND for an unknown collection id', async () => {
    await expect(flushCollection(db, 'no-such-collection', join(dir, 'x.http')))
      .rejects.toThrow(/NOT_FOUND/);
  });

  it('emits an empty body when the request has none', async () => {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: c.rootFolderId,
      name: 'Get',
      method: 'GET',
      url: 'https://x.test',
      headers: [],
    });
    const path = join(dir, 'c.http');
    await flushCollection(db, c.id, path);
    const parsed = parseHttpFile(readFileSync(path, 'utf8'));
    expect(parsed.requests[0]!.body).toBeUndefined();
  });
});

// =============================================================================
// flushEnv
// =============================================================================

describe('flushEnv', () => {
  it('writes the env JSON as a flat vars array (collection root env)', async () => {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });

    const rootEnv = Repos.Envs.create(db, { folderId: c.rootFolderId, name: 'dev' });
    Repos.Vars.create(db, { envId: rootEnv.id, key: 'baseUrl', valuePlain: 'https://dev' });
    Repos.Vars.create(db, { envId: rootEnv.id, key: 'userId', valuePlain: '42' });

    const path = join(dir, 'c.dev.env.json');
    await flushEnv(db, c.id, 'dev', path);
    const text = readFileSync(path, 'utf8');
    const parsed = parseEnvFile(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.name).toBe('dev');
      // Under the directories model the file is flat — no scopes[] — and
      // every var the env declares appears in one list.
      expect(parsed.value.vars).toEqual(
        expect.arrayContaining([
          { key: 'baseUrl', valuePlain: 'https://dev' },
          { key: 'userId', valuePlain: '42' },
        ]),
      );
    }
  });

  it('omits other envs (only flushes the named one)', async () => {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    const dev = Repos.Envs.create(db, { folderId: c.rootFolderId, name: 'dev' });
    Repos.Vars.create(db, { envId: dev.id, key: 'baseUrl', valuePlain: 'https://dev' });
    const staging = Repos.Envs.create(db, { folderId: c.rootFolderId, name: 'staging' });
    Repos.Vars.create(db, { envId: staging.id, key: 'baseUrl', valuePlain: 'https://staging' });

    const path = join(dir, 'c.staging.env.json');
    await flushEnv(db, c.id, 'staging', path);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('https://staging');
    expect(text).not.toContain('https://dev');
  });

  it('emits secret vars as { isSecret, secretId } with no value', async () => {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    const env = Repos.Envs.create(db, { folderId: c.rootFolderId, name: 'dev' });
    Repos.Vars.create(db, {
      envId: env.id,
      key: 'token',
      valueSecretBlob: Buffer.from('the-actual-secret'),
    });

    const path = join(dir, 'c.dev.env.json');
    await flushEnv(db, c.id, 'dev', path);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain('the-actual-secret');
    expect(text).toContain('"isSecret": true');
    expect(text).toMatch(/"secretId": "coax:[^"]+:dev:token"/);
  });

  it('writes an empty shell when no env with that name exists in the collection', async () => {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    const path = join(dir, 'c.nonexistent.env.json');
    await flushEnv(db, c.id, 'nonexistent', path);
    const parsed = parseEnvFile(readFileSync(path, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({ name: 'nonexistent', vars: [] });
    }
  });

  it('throws NOT_FOUND for an unknown collection id', async () => {
    await expect(flushEnv(db, 'no-such-collection', 'dev', join(dir, 'x.json')))
      .rejects.toThrow(/NOT_FOUND/);
  });
});
