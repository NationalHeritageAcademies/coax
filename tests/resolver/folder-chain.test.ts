import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@storage/db';
import { Repos } from '@storage/repos';
import { Secrets, type SafeStorage } from '@secrets/safe';
import { buildScopesForRequest } from '@app/handlers';

// Bypass Electron safeStorage in unit tests — just round-trip plaintext as a
// Buffer the way the real impl does.
const stubSafeStorage: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
};

describe('resolver folder chain', () => {
  let db: Db;
  let secrets: Secrets;

  beforeEach(() => {
    db = openDb(':memory:');
    secrets = new Secrets(stubSafeStorage);
  });

  function setup(): { rootFolderId: string; childFolderId: string; requestId: string } {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    // Child folder under the collection root.
    const child = Repos.Folders.create(db, {
      collectionId: c.id,
      name: 'child',
      parentFolderId: c.rootFolderId,
    });
    const req = Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: child.id,
      name: 'r',
      method: 'GET',
      url: '{{baseUrl}}/x',
    });
    return { rootFolderId: c.rootFolderId, childFolderId: child.id, requestId: req.id };
  }

  it('resolves vars from a single-folder active env', () => {
    const { childFolderId, requestId } = setup();
    const env = Repos.Envs.create(db, { folderId: childFolderId, name: 'dev' });
    Repos.Vars.create(db, { envId: env.id, key: 'baseUrl', valuePlain: 'https://child.test' });
    Repos.Envs.setActive(db, env.id);

    const scopes = buildScopesForRequest(db, secrets, requestId);
    expect(scopes.chainFlat?.baseUrl).toBe('https://child.test');
  });

  it('inherits parent envs through the chain', () => {
    const { rootFolderId, childFolderId, requestId } = setup();
    const parentEnv = Repos.Envs.create(db, { folderId: rootFolderId, name: 'parent' });
    Repos.Vars.create(db, { envId: parentEnv.id, key: 'baseUrl', valuePlain: 'https://parent' });
    Repos.Envs.setActive(db, parentEnv.id);

    const childEnv = Repos.Envs.create(db, { folderId: childFolderId, name: 'child' });
    Repos.Vars.create(db, { envId: childEnv.id, key: 'clientCode', valuePlain: 'ABC' });
    Repos.Envs.setActive(db, childEnv.id);

    const scopes = buildScopesForRequest(db, secrets, requestId);
    expect(scopes.chainFlat?.baseUrl).toBe('https://parent');
    expect(scopes.chainFlat?.clientCode).toBe('ABC');
  });

  it('deeper folders override shallower ones', () => {
    const { rootFolderId, childFolderId, requestId } = setup();
    const parentEnv = Repos.Envs.create(db, { folderId: rootFolderId, name: 'parent' });
    Repos.Vars.create(db, { envId: parentEnv.id, key: 'baseUrl', valuePlain: 'parent-value' });
    Repos.Envs.setActive(db, parentEnv.id);

    const childEnv = Repos.Envs.create(db, { folderId: childFolderId, name: 'child' });
    Repos.Vars.create(db, { envId: childEnv.id, key: 'baseUrl', valuePlain: 'child-value' });
    Repos.Envs.setActive(db, childEnv.id);

    const scopes = buildScopesForRequest(db, secrets, requestId);
    expect(scopes.chainFlat?.baseUrl).toBe('child-value');
  });

  it('decrypts secret values along the chain', () => {
    const { rootFolderId, requestId } = setup();
    const env = Repos.Envs.create(db, { folderId: rootFolderId, name: 'parent' });
    Repos.Vars.create(db, {
      envId: env.id,
      key: 'token',
      valueSecretBlob: secrets.encrypt('SECRET-TOKEN'),
    });
    const tokenVar = Repos.Vars.listByEnv(db, env.id).find((v) => v.key === 'token')!;
    Repos.Vars.update(db, tokenVar.id, { isSecret: true });
    Repos.Envs.setActive(db, env.id);

    const scopes = buildScopesForRequest(db, secrets, requestId);
    expect(scopes.chainFlat?.token).toBe('SECRET-TOKEN');
  });

  it('skips folders with no active env', () => {
    const { rootFolderId, childFolderId, requestId } = setup();
    // Parent env exists but is not activated → chain still resolves child's vars.
    Repos.Envs.create(db, { folderId: rootFolderId, name: 'inactive' });
    const childEnv = Repos.Envs.create(db, { folderId: childFolderId, name: 'child' });
    Repos.Vars.create(db, { envId: childEnv.id, key: 'k', valuePlain: 'v' });
    Repos.Envs.setActive(db, childEnv.id);

    const scopes = buildScopesForRequest(db, secrets, requestId);
    expect(scopes.chainFlat?.k).toBe('v');
  });

  it('listForRequest returns chain root→leaf (folder + directory legs)', () => {
    const { rootFolderId, childFolderId, requestId } = setup();
    const chain = Repos.Envs.listForRequest(db, requestId);
    // Folder leg appears in order (root folder before child folder). The
    // directory leg (workspace root) is appended after — under the
    // directories model the chain spans both kinds of scope.
    const folderScopes = chain.filter((s) => s.scopeKind === 'folder').map((s) => s.scopeId);
    expect(folderScopes).toEqual([rootFolderId, childFolderId]);
  });

  it('surfaces collection name (not "(root)") and "workspace" for the workspace root', () => {
    // Walker should label the chain steps with user-friendly names: the
    // collection's display name for the implicit root folder, and the
    // string "workspace" for the anonymous workspace root directory.
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const col = Repos.Collections.create(db, { workspaceId: w.id, name: 'My Collection' });
    const req = Repos.Requests.create(db, {
      collectionId: col.id,
      name: 'r',
      method: 'GET',
      url: 'https://x.test/',
    });
    const chain = Repos.Envs.listForRequest(db, req.id);
    const names = chain.map((s) => s.scopeName);
    expect(names).toContain('My Collection');
    expect(names).toContain('workspace');
    expect(names).not.toContain('(root)');
    expect(names).not.toContain('');
  });

  it('cascades env vars across directory ancestry (directory env → child collection)', () => {
    // A directory-scoped env at the workspace root cascades to every
    // collection living in that directory, mirroring how legacy nested
    // collections inherited from their parent's root folder.
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const col = Repos.Collections.create(db, { workspaceId: w.id, name: 'child' });
    const rootDir = Repos.Directories.getRoot(db, w.id)!;
    const dirEnv = Repos.Envs.create(db, { directoryId: rootDir.id, name: 'workspace-env' });
    Repos.Vars.create(db, { envId: dirEnv.id, key: 'sharedKey', valuePlain: 'parentValue' });
    Repos.Envs.setActive(db, dirEnv.id);

    const req = Repos.Requests.create(db, {
      collectionId: col.id,
      name: 'r',
      method: 'GET',
      url: '{{sharedKey}}',
    });

    const scopes = buildScopesForRequest(db, secrets, req.id);
    expect(scopes.chainFlat?.sharedKey).toBe('parentValue');
  });
});
