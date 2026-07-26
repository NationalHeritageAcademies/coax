import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@storage/db';
import {
  Workspaces,
  Collections,
  Requests,
  RequestVarOverrides,
} from '@storage/repos';
import { Secrets } from '@secrets/safe';

let db: Db;
let requestId: string;

beforeEach(() => {
  db = openDb(':memory:');
  const ws = Workspaces.create(db, { name: 'w' });
  const col = Collections.create(db, { workspaceId: ws.id, name: 'c' });
  const req = Requests.create(db, {
    collectionId: col.id,
    name: 'r',
    method: 'GET',
    url: 'https://x.example/{{p}}',
  });
  requestId = req.id;
});

const fakeSecrets = {
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
  decrypt: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
} as unknown as Secrets;

describe('RequestVarOverrides', () => {
  it('listByRequest returns [] when none exist', () => {
    expect(RequestVarOverrides.listByRequest(db, requestId)).toEqual([]);
  });

  it('upsert creates a plaintext override', () => {
    const o = RequestVarOverrides.upsert(db, {
      requestId,
      key: 'apiBase',
      valuePlain: 'https://staging.example',
    });
    expect(o).toMatchObject({
      requestId,
      key: 'apiBase',
      isSecret: false,
      valuePlain: 'https://staging.example',
    });
    expect(RequestVarOverrides.listByRequest(db, requestId)).toHaveLength(1);
  });

  it('upsert replaces an existing row for the same (request, key)', () => {
    RequestVarOverrides.upsert(db, { requestId, key: 'apiBase', valuePlain: 'v1' });
    RequestVarOverrides.upsert(db, { requestId, key: 'apiBase', valuePlain: 'v2' });
    const rows = RequestVarOverrides.listByRequest(db, requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.valuePlain).toBe('v2');
  });

  it('upsert switching plain -> secret clears the plaintext column', () => {
    RequestVarOverrides.upsert(db, { requestId, key: 'k', valuePlain: 'p' });
    RequestVarOverrides.upsert(db, { requestId, key: 'k', valueSecretBlob: Buffer.from('c') });
    const rows = RequestVarOverrides.listByRequest(db, requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isSecret).toBe(true);
    expect(rows[0]!.valuePlain).toBeUndefined();
    expect(rows[0]!.valueSecretBlob).toEqual(Buffer.from('c'));
  });

  it('upsert stores a secret override as a blob with value_plain NULL', () => {
    const blob = Buffer.from('cipher');
    const o = RequestVarOverrides.upsert(db, {
      requestId,
      key: 'apiKey',
      valueSecretBlob: blob,
    });
    expect(o.isSecret).toBe(true);
    expect(o.valuePlain).toBeUndefined();
    expect(o.valueSecretBlob).toEqual(blob);
  });

  it('upsert rejects both valuePlain and valueSecretBlob together', () => {
    expect(() =>
      RequestVarOverrides.upsert(db, {
        requestId,
        key: 'k',
        valuePlain: 'p',
        valueSecretBlob: Buffer.from('c'),
      }),
    ).toThrow(/OVERRIDE_BOTH_VALUES/);
  });

  it('delete removes the row by (request, key)', () => {
    RequestVarOverrides.upsert(db, { requestId, key: 'k', valuePlain: 'v' });
    RequestVarOverrides.delete(db, { requestId, key: 'k' });
    expect(RequestVarOverrides.listByRequest(db, requestId)).toEqual([]);
  });

  it('delete is a no-op when the row does not exist', () => {
    expect(() => { RequestVarOverrides.delete(db, { requestId, key: 'nope' }); }).not.toThrow();
  });

  it('listForRequest materializes plain and secret overrides', () => {
    RequestVarOverrides.upsert(db, { requestId, key: 'plain', valuePlain: 'p1' });
    RequestVarOverrides.upsert(db, {
      requestId,
      key: 'secret',
      valueSecretBlob: fakeSecrets.encrypt('s1'),
    });
    const out = RequestVarOverrides.listForRequest(db, fakeSecrets, requestId);
    expect(out).toEqual(
      expect.arrayContaining([
        { key: 'plain', value: 'p1', isSecret: false },
        { key: 'secret', value: 's1', isSecret: true },
      ]),
    );
    expect(out).toHaveLength(2);
  });

  it('listForRequest skips secret rows with zero-byte blobs (needs-value sentinel)', () => {
    RequestVarOverrides.upsert(db, {
      requestId,
      key: 'k',
      valueSecretBlob: Buffer.alloc(0),
    });
    expect(RequestVarOverrides.listForRequest(db, fakeSecrets, requestId)).toEqual([]);
  });
});
