import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '@storage/db';
import { Repos } from '@storage/repos';
import { Secrets, type SafeStorage } from '@secrets/safe';
import { exportTree } from '@app/handlers';

const stubSafeStorage: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
};

describe('tree:export', () => {
  let db: Db;
  let secrets: Secrets;
  let tmpDir: string;

  beforeEach(() => {
    db = openDb(':memory:');
    secrets = new Secrets(stubSafeStorage);
    tmpDir = mkdtempSync(join(tmpdir(), 'tree-export-test-'));
  });

  it('embeds the chain envs at the export root with deepest-wins (directory ancestry)', () => {
    // Two ancestor scopes contribute vars; the closer one wins for shared
    // keys. Under the directories model the cascade walks: collection's
    // own folder -> own directory -> ancestor directories -> workspace
    // root, outer scopes cascade in.
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const root = Repos.Directories.getRoot(db, w.id) ??
      Repos.Directories.create(db, { workspaceId: w.id, name: '' });
    const outer = Repos.Directories.create(db, { workspaceId: w.id, name: 'outer', parentDirectoryId: root.id });
    const inner = Repos.Directories.create(db, { workspaceId: w.id, name: 'inner', parentDirectoryId: outer.id });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c', directoryId: inner.id });

    // Outer dir: baseUrl=A, sharedKey=root
    const outerEnv = Repos.Envs.create(db, { directoryId: outer.id, name: 'outer-env' });
    Repos.Vars.create(db, { envId: outerEnv.id, key: 'baseUrl', valuePlain: 'A' });
    Repos.Vars.create(db, { envId: outerEnv.id, key: 'sharedKey', valuePlain: 'root' });
    Repos.Envs.setActive(db, outerEnv.id);

    // Inner dir: baseUrl=B (overrides outer), childOnly=hello
    const innerEnv = Repos.Envs.create(db, { directoryId: inner.id, name: 'inner-env' });
    Repos.Vars.create(db, { envId: innerEnv.id, key: 'baseUrl', valuePlain: 'B' });
    Repos.Vars.create(db, { envId: innerEnv.id, key: 'childOnly', valuePlain: 'hello' });
    Repos.Envs.setActive(db, innerEnv.id);

    Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: c.rootFolderId,
      name: 'r',
      method: 'GET',
      url: '{{baseUrl}}/x',
    });

    const target = join(tmpDir, 'export.http');
    exportTree(db, secrets, 'collection', c.id, target);
    const text = readFileSync(target, 'utf8');

    // Inner overrides outer.
    expect(text).toMatch(/@baseUrl\s*=\s*B/);
    // Outer var only in outer is preserved.
    expect(text).toMatch(/@sharedKey\s*=\s*root/);
    // Inner-only var present.
    expect(text).toMatch(/@childOnly\s*=\s*hello/);
  });

  it('exports a directory subtree without sibling collections outside it', () => {
    // Two collections in different directories; export from one directory
    // pulls just that directory's collection, not the sibling.
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const root = Repos.Directories.getRoot(db, w.id) ??
      Repos.Directories.create(db, { workspaceId: w.id, name: '' });
    const dirA = Repos.Directories.create(db, { workspaceId: w.id, name: 'a', parentDirectoryId: root.id });
    const dirB = Repos.Directories.create(db, { workspaceId: w.id, name: 'b', parentDirectoryId: root.id });
    const colA = Repos.Collections.create(db, { workspaceId: w.id, name: 'colA', directoryId: dirA.id });
    const colB = Repos.Collections.create(db, { workspaceId: w.id, name: 'colB', directoryId: dirB.id });
    Repos.Requests.create(db, {
      collectionId: colA.id,
      folderId: colA.rootFolderId,
      name: 'in-a',
      method: 'GET',
      url: 'https://x/a',
    });
    Repos.Requests.create(db, {
      collectionId: colB.id,
      folderId: colB.rootFolderId,
      name: 'in-b',
      method: 'GET',
      url: 'https://x/b',
    });

    const target = join(tmpDir, 'dir-only.http');
    exportTree(db, secrets, 'directory', dirA.id, target);
    const text = readFileSync(target, 'utf8');
    expect(text).toContain('### in-a');
    expect(text).not.toContain('### in-b');
  });

  it('inherits ancestor active envs when exporting a deep directory', () => {
    // Ancestor directory has an active env; export from a nested
    // directory picks up its baseUrl.
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const root = Repos.Directories.getRoot(db, w.id) ??
      Repos.Directories.create(db, { workspaceId: w.id, name: '' });
    const outer = Repos.Directories.create(db, { workspaceId: w.id, name: 'outer', parentDirectoryId: root.id });
    const inner = Repos.Directories.create(db, { workspaceId: w.id, name: 'inner', parentDirectoryId: outer.id });
    const col = Repos.Collections.create(db, { workspaceId: w.id, name: 'c', directoryId: inner.id });

    const outerEnv = Repos.Envs.create(db, { directoryId: outer.id, name: 'outer-env' });
    Repos.Vars.create(db, { envId: outerEnv.id, key: 'baseUrl', valuePlain: 'ROOT-VALUE' });
    Repos.Envs.setActive(db, outerEnv.id);

    Repos.Requests.create(db, {
      collectionId: col.id,
      folderId: col.rootFolderId,
      name: 'r',
      method: 'GET',
      url: '{{baseUrl}}/x',
    });

    const target = join(tmpDir, 'deep.http');
    exportTree(db, secrets, 'directory', inner.id, target);
    const text = readFileSync(target, 'utf8');
    expect(text).toMatch(/@baseUrl\s*=\s*ROOT-VALUE/);
  });

  it('emits `# @name <chain>` for requests that have a chainName set', () => {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: c.rootFolderId,
      name: 'Token request',
      chainName: 'getToken',
      method: 'POST',
      url: '{{baseUrl}}/token',
    });
    Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: c.rootFolderId,
      name: 'List users',
      method: 'GET',
      url: '{{baseUrl}}/users',
      headers: [{ key: 'Authorization', value: 'Bearer {{getToken.response.body.$.access_token}}' }],
    });

    const target = join(tmpDir, 'chain-name.http');
    exportTree(db, secrets, 'collection', c.id, target);
    const text = readFileSync(target, 'utf8');

    // The token request's @name directive must be written so the chain
    // reference in the next request actually resolves on re-import.
    expect(text).toContain('# @name getToken');
    expect(text).toContain('{{getToken.response.body.$.access_token}}');
  });

  it('directory export flattens every collection in the subtree', () => {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    // Set up: a "parent" directory at the workspace root holding the
    // parent collection; a "child" subdirectory holding the child + a
    // "grandchild" sub-subdirectory holding the grandchild. Under the
    // directories model collections don't nest — directories do — so the
    // walker should pull every collection in the subtree.
    const rootDir = Repos.Directories.getRoot(db, w.id) ??
      Repos.Directories.create(db, { workspaceId: w.id, name: '' });
    const childDir = Repos.Directories.create(db, {
      workspaceId: w.id,
      name: 'child-dir',
      parentDirectoryId: rootDir.id,
    });
    const grandchildDir = Repos.Directories.create(db, {
      workspaceId: w.id,
      name: 'grandchild-dir',
      parentDirectoryId: childDir.id,
    });
    const parent = Repos.Collections.create(db, {
      workspaceId: w.id,
      name: 'parent',
      directoryId: rootDir.id,
    });
    const child = Repos.Collections.create(db, {
      workspaceId: w.id,
      name: 'child',
      directoryId: childDir.id,
    });
    const grandchild = Repos.Collections.create(db, {
      workspaceId: w.id,
      name: 'grandchild',
      directoryId: grandchildDir.id,
    });
    const childFolder = Repos.Folders.create(db, {
      collectionId: child.id,
      name: 'in-child',
      parentFolderId: child.rootFolderId,
    });

    // One request at each level, plus a loose request (no folder) in the child.
    Repos.Requests.create(db, {
      collectionId: parent.id,
      folderId: parent.rootFolderId,
      name: 'parent-req',
      method: 'GET',
      url: 'https://x/parent',
    });
    Repos.Requests.create(db, {
      collectionId: child.id,
      folderId: childFolder.id,
      name: 'child-req',
      method: 'GET',
      url: 'https://x/child',
    });
    Repos.Requests.create(db, {
      collectionId: child.id,
      // no folderId — exercises the "loose request" branch across collections.
      name: 'child-loose-req',
      method: 'GET',
      url: 'https://x/child-loose',
    });
    Repos.Requests.create(db, {
      collectionId: grandchild.id,
      folderId: grandchild.rootFolderId,
      name: 'grandchild-req',
      method: 'GET',
      url: 'https://x/grandchild',
    });

    // Active envs at each collection's root — descendant-wins should apply
    // across collection boundaries, same as at resolve time.
    const parentEnv = Repos.Envs.create(db, { folderId: parent.rootFolderId, name: 'p' });
    Repos.Vars.create(db, { envId: parentEnv.id, key: 'baseUrl', valuePlain: 'parent-val' });
    Repos.Envs.setActive(db, parentEnv.id);
    const childEnv = Repos.Envs.create(db, { folderId: child.rootFolderId, name: 'c' });
    Repos.Vars.create(db, { envId: childEnv.id, key: 'baseUrl', valuePlain: 'child-val' });
    Repos.Envs.setActive(db, childEnv.id);

    const target = join(tmpDir, 'nested.http');
    // Directory-level export from the workspace root pulls every
    // collection in every subdirectory, flattened.
    exportTree(db, secrets, 'directory', rootDir.id, target);
    const text = readFileSync(target, 'utf8');

    expect(text).toContain('### parent-req');
    expect(text).toContain('### child-req');
    expect(text).toContain('### child-loose-req');
    expect(text).toContain('### grandchild-req');
    // Folder-scoped envs (collection root) don't participate in
    // directory-export's scope chain — only directory-scoped envs do.
    // Neither parent-val nor child-val should appear (both are folder-
    // scoped on a collection root).
    expect(text).not.toMatch(/@baseUrl/);
  });
});
