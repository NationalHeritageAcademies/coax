import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@storage/db';
import {
  Workspaces,
  Collections,
  Requests,
  Envs,
  Vars,
  RequestVarOverrides,
} from '@storage/repos';
import { handlers, __setHandlersStateForTest } from '@app/handlers';
import { Secrets } from '@secrets/safe';

const fakeSecrets = {
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
  decrypt: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
} as unknown as Secrets;

let db: Db;
let requestId: string;
let folderId: string;

beforeEach(() => {
  db = openDb(':memory:');
  __setHandlersStateForTest({ db, secrets: fakeSecrets });
  const ws = Workspaces.create(db, { name: 'w' });
  const col = Collections.create(db, { workspaceId: ws.id, name: 'c' });
  folderId = col.rootFolderId;
  const env = Envs.create(db, { folderId, name: 'e' });
  Envs.setActive(db, env.id);
  Vars.create(db, { envId: env.id, key: 'host', valuePlain: 'env-host' });
  Vars.create(db, { envId: env.id, key: 'apiKey', valuePlain: 'env-key' });
  const req = Requests.create(db, {
    collectionId: col.id,
    name: 'r',
    method: 'GET',
    url: 'https://{{host}}/x',
  });
  requestId = req.id;
});

async function call<T = unknown>(
  msg: Parameters<NonNullable<(typeof handlers)[keyof typeof handlers]>>[0],
): Promise<T> {
  // Promise-wrap a synchronous throw so tests using `.rejects.toThrow(...)`
  // catch them, mirroring how the IPC dispatcher would have caught and
  // re-emitted the error.
  const fn = handlers[msg.kind] as
    | ((m: typeof msg) => unknown)
    | undefined;
  if (!fn) throw new Error(`no handler for ${msg.kind}`);
  return (await fn(msg)) as T;
}

describe('request:overrides IPC', () => {
  it('list returns [] for a new request', async () => {
    const r = await call<{ overrides: unknown[] }>({ kind: 'request:overrides:list', requestId });
    expect(r.overrides).toEqual([]);
  });

  it('set with valuePlain creates a row visible from list', async () => {
    await call({ kind: 'request:overrides:set', requestId, key: 'host', valuePlain: 'staging' });
    const r = await call<{ overrides: { key: string; valuePlain?: string; isSecret: boolean }[] }>(
      { kind: 'request:overrides:list', requestId },
    );
    expect(r.overrides).toEqual([{ key: 'host', valuePlain: 'staging', isSecret: false }]);
  });

  it('set with valueSecret encrypts before storing', async () => {
    await call({ kind: 'request:overrides:set', requestId, key: 'apiKey', valueSecret: 'hush' });
    const rows = RequestVarOverrides.listByRequest(db, requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isSecret).toBe(true);
    expect(rows[0]!.valueSecretBlob?.toString()).toBe('enc:hush');
  });

  it('set list excludes the encrypted blob from the response', async () => {
    await call({ kind: 'request:overrides:set', requestId, key: 'apiKey', valueSecret: 'hush' });
    const r = await call<{ overrides: { key: string; valuePlain?: string; isSecret: boolean }[] }>(
      { kind: 'request:overrides:list', requestId },
    );
    expect(r.overrides).toEqual([{ key: 'apiKey', isSecret: true }]);
  });

  it('set rejects a key not present in the request env chain (when no override exists)', async () => {
    await expect(
      call({ kind: 'request:overrides:set', requestId, key: 'unknown', valuePlain: 'x' }),
    ).rejects.toThrow(/UNKNOWN_KEY/);
  });

  it('set succeeds for already-orphaned override (idempotent on missing key)', async () => {
    // Create override against an existing key, then delete the env var so
    // the override becomes orphaned, then call set again — should not throw.
    RequestVarOverrides.upsert(db, { requestId, key: 'host', valuePlain: 'old' });
    Vars.listByEnv(db, Envs.list(db, folderId)[0]!.id)
      .filter((v) => v.key === 'host')
      .forEach((v) => { Vars.delete(db, v.id); });
    await expect(
      call({ kind: 'request:overrides:set', requestId, key: 'host', valuePlain: 'new' }),
    ).resolves.toBeDefined();
  });

  it('set rejects both valuePlain and valueSecret', async () => {
    await expect(
      call({
        kind: 'request:overrides:set',
        requestId,
        key: 'host',
        valuePlain: 'p',
        valueSecret: 's',
      }),
    ).rejects.toThrow(/OVERRIDE_BOTH_VALUES/);
  });

  it('delete removes one override', async () => {
    await call({ kind: 'request:overrides:set', requestId, key: 'host', valuePlain: 'x' });
    await call({ kind: 'request:overrides:delete', requestId, key: 'host' });
    expect(RequestVarOverrides.listByRequest(db, requestId)).toEqual([]);
  });
});
