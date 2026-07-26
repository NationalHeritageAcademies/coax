import { describe, it, expect } from 'vitest';
import { openDb, type Db } from '@storage/db';
import {
  Workspaces,
  Collections,
  Requests,
  Envs,
  Vars,
  RequestVarOverrides,
} from '@storage/repos';
import { buildScopesForRequest } from '@app/handlers';
import { Secrets } from '@secrets/safe';

const fakeSecrets = {
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
  decrypt: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
} as unknown as Secrets;

function seedRequest(db: Db): { collectionId: string; folderId: string; requestId: string } {
  const ws = Workspaces.create(db, { name: 'w' });
  const col = Collections.create(db, { workspaceId: ws.id, name: 'c' });
  const req = Requests.create(db, {
    collectionId: col.id,
    name: 'r',
    method: 'GET',
    url: 'https://{{host}}/x',
  });
  return { collectionId: col.id, folderId: col.rootFolderId, requestId: req.id };
}

describe('buildScopesForRequest', () => {
  it('populates scopes.request from request_var_overrides (plain)', () => {
    const db = openDb(':memory:');
    const { folderId, requestId } = seedRequest(db);
    const env = Envs.create(db, { folderId, name: 'e' });
    Envs.setActive(db, env.id);
    Vars.create(db, { envId: env.id, key: 'host', valuePlain: 'env-host' });
    RequestVarOverrides.upsert(db, {
      requestId,
      key: 'host',
      valuePlain: 'override-host',
    });
    const scopes = buildScopesForRequest(db, fakeSecrets, requestId);
    expect(scopes.request).toEqual({ host: 'override-host' });
    expect(scopes.chainFlat).toEqual({ host: 'env-host' });
  });

  it('materializes secret overrides into scopes.request', () => {
    const db = openDb(':memory:');
    const { folderId, requestId } = seedRequest(db);
    const env = Envs.create(db, { folderId, name: 'e' });
    Envs.setActive(db, env.id);
    Vars.create(db, { envId: env.id, key: 'token', valuePlain: 'env-token' });
    RequestVarOverrides.upsert(db, {
      requestId,
      key: 'token',
      valueSecretBlob: fakeSecrets.encrypt('override-secret'),
    });
    const scopes = buildScopesForRequest(db, fakeSecrets, requestId);
    expect(scopes.request).toEqual({ token: 'override-secret' });
  });

  it('omits scopes.request when there are no overrides', () => {
    const db = openDb(':memory:');
    const { requestId } = seedRequest(db);
    const scopes = buildScopesForRequest(db, fakeSecrets, requestId);
    expect(scopes.request).toBeUndefined();
  });
});
