import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '@storage/db';
import { Repos } from '@storage/repos';
import { Secrets, type SafeStorage } from '@secrets/safe';
import { exportCollection } from '@app/handlers';

const stub: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
};

let db: Db;
let secrets: Secrets;
let tmpDir: string;
beforeEach(() => {
  db = openDb(':memory:');
  secrets = new Secrets(stub);
  tmpDir = mkdtempSync(join(tmpdir(), 'export-test-'));
});

function setupCollection() {
  const w = Repos.Workspaces.create(db, { name: 'w' });
  const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
  const env = Repos.Envs.create(db, { folderId: c.rootFolderId, name: 'From file' });
  Repos.Vars.create(db, { envId: env.id, key: 'baseUrl', valuePlain: 'https://x.test' });
  Repos.Vars.create(db, {
    envId: env.id,
    key: 'token',
    valueSecretBlob: secrets.encrypt('SECRET-VALUE-NEVER-EMITTED'),
  });
  // Mark token secret
  const tokenVar = Repos.Vars.listByEnv(db, env.id).find((v) => v.key === 'token')!;
  Repos.Vars.update(db, tokenVar.id, { isSecret: true });
  // Activate so the export pipeline picks it up via the folder chain
  // (exportCollection / exportTree now ignore the legacy explicit envId).
  Repos.Envs.setActive(db, env.id);
  return { c, env };
}

describe('exportCollection — hygiene', () => {
  it('strips secret values to placeholders', () => {
    const { c, env } = setupCollection();
    Repos.Requests.create(db, {
      collectionId: c.id,
      name: 'r',
      method: 'GET',
      url: '{{baseUrl}}/x',
      headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
    });
    const target = join(tmpDir, 'out.http');
    const result = exportCollection(db, secrets, c.id, env.id, target);
    expect(result.written).toBe(true);
    const text = readFileSync(target, 'utf8');
    expect(text).toContain('PASTE_TOKEN_HERE');
    expect(text).not.toContain('SECRET-VALUE-NEVER-EMITTED');
    expect(text).toContain('{{token}}'); // request still references it via var
  });

  it('does not strip non-secret values', () => {
    const { c, env } = setupCollection();
    Repos.Requests.create(db, {
      collectionId: c.id,
      name: 'r',
      method: 'GET',
      url: '{{baseUrl}}/x',
      headers: [],
    });
    const target = join(tmpDir, 'out.http');
    exportCollection(db, secrets, c.id, env.id, target);
    const text = readFileSync(target, 'utf8');
    expect(text).toContain('@baseUrl = https://x.test');
  });

  it('warns on literal Authorization headers (no {{var}} reference)', () => {
    const { c, env } = setupCollection();
    Repos.Requests.create(db, {
      collectionId: c.id,
      name: 'r1',
      method: 'GET',
      url: '{{baseUrl}}/x',
      headers: [{ key: 'Authorization', value: 'Bearer literal-abc-123' }],
    });
    Repos.Requests.create(db, {
      collectionId: c.id,
      name: 'r2',
      method: 'GET',
      url: '{{baseUrl}}/y',
      headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
    });
    const target = join(tmpDir, 'out.http');
    const result = exportCollection(db, secrets, c.id, env.id, target);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.kind).toBe('literal-auth');
    expect(result.warnings[0]?.detail).toContain('literal-abc-123');
  });

  it('writes valid .http that re-parses to the same shape', async () => {
    const { c, env } = setupCollection();
    Repos.Requests.create(db, {
      collectionId: c.id,
      name: 'Hello',
      method: 'POST',
      url: '{{baseUrl}}/echo',
      headers: [{ key: 'Content-Type', value: 'application/json' }],
      body: { kind: 'json', raw: '{"a":1}' },
    });
    const target = join(tmpDir, 'out.http');
    exportCollection(db, secrets, c.id, env.id, target);

    const { parseHttpFile } = await import('@parser/parse');
    const reparsed = parseHttpFile(readFileSync(target, 'utf8'));
    expect(reparsed.requests).toHaveLength(1);
    expect(reparsed.requests[0]?.method).toBe('POST');
    expect(reparsed.requests[0]?.title).toBe('Hello');
    expect(reparsed.requests[0]?.body?.raw).toBe('{"a":1}');
  });

  it('export with no active env in the chain emits no variables, but still serializes requests', () => {
    // Set up a collection deliberately without an active env so the export
    // chain yields no vars to embed. Post-migration-003, "no envId" is no
    // longer the trigger — what matters is whether any folder in the chain
    // has an active env.
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    Repos.Requests.create(db, {
      collectionId: c.id,
      name: 'r',
      method: 'GET',
      url: 'https://x.test/users',
      headers: [],
    });
    const target = join(tmpDir, 'out.http');
    const result = exportCollection(db, secrets, c.id, undefined, target);
    const text = readFileSync(target, 'utf8');
    expect(text).not.toContain('@baseUrl');
    expect(text).toContain('GET https://x.test/users');
    expect(result.warnings).toEqual([]);
  });
});
