import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '@storage/db';
import { Repos } from '@storage/repos';
import { exportTree } from '@app/handlers';
import { Secrets } from '@secrets/safe';

const fakeSecrets = {
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
  decrypt: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
} as unknown as Secrets;

let db: Db;
let collectionId: string;
let requestId: string;

beforeEach(() => {
  db = openDb(':memory:');
  const ws = Repos.Workspaces.create(db, { name: 'w' });
  const col = Repos.Collections.create(db, { workspaceId: ws.id, name: 'oneroster' });
  collectionId = col.id;
  const req = Repos.Requests.create(db, {
    collectionId: col.id,
    folderId: col.rootFolderId,
    name: 'Hello',
    method: 'GET',
    url: '{{apiBase}}/x',
    headers: [{ key: 'Authorization', value: 'Bearer {{apiKey}}' }],
  });
  requestId = req.id;
});

function exportToTmp(): string {
  const target = join(mkdtempSync(join(tmpdir(), 'exp-')), 'out.http');
  exportTree(db, fakeSecrets, 'collection', collectionId, target);
  return readFileSync(target, 'utf8');
}

describe('exportTree emits override directives', () => {
  it('emits `# @override` for plaintext overrides', () => {
    Repos.RequestVarOverrides.upsert(db, {
      requestId,
      key: 'apiBase',
      valuePlain: 'https://staging.example.com',
    });
    const text = exportToTmp();
    expect(text).toMatch(/# @override apiBase https:\/\/staging\.example\.com/);
  });

  it('emits `# @override:secret <key>` (no value) for secret overrides', () => {
    Repos.RequestVarOverrides.upsert(db, {
      requestId,
      key: 'apiKey',
      valueSecretBlob: fakeSecrets.encrypt('shh'),
    });
    const text = exportToTmp();
    expect(text).toMatch(/# @override:secret apiKey/);
    // The plaintext "shh" must NOT appear anywhere — secrets don't roundtrip.
    expect(text).not.toMatch(/shh/);
    // And no line with both ":secret apiKey" and a trailing value.
    expect(text).not.toMatch(/# @override:secret apiKey [^\s]/);
  });

  it('emits no override directive for requests without overrides', () => {
    const text = exportToTmp();
    expect(text).not.toMatch(/@override/);
  });
});
