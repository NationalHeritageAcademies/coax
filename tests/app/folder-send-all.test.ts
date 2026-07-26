import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@storage/db';
import { Repos } from '@storage/repos';
import { Secrets, type SafeStorage } from '@secrets/safe';
import { sendAllInFolder } from '@app/handlers';
import type { RunnerResult, RequestSpec } from '@runner/types';

const stub: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
};

let db: Db;
let secrets: Secrets;
beforeEach(() => {
  db = openDb(':memory:');
  secrets = new Secrets(stub);
});

function fakeRunner(scriptByUrl: Record<string, RunnerResult>) {
  const calls: RequestSpec[] = [];
  return {
    calls,
    send: async (spec: RequestSpec): Promise<RunnerResult> => {
      calls.push(spec);
      return (
        scriptByUrl[spec.url] ?? {
          id: spec.id,
          ok: false,
          category: 'unknown',
          message: 'no script',
        }
      );
    },
  };
}

describe('sendAllInFolder', () => {
  it('runs every request in the folder and returns results in order', async () => {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    const f = Repos.Folders.create(db, { collectionId: c.id, name: 'F' });
    const r1 = Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: f.id,
      name: 'a',
      method: 'GET',
      url: 'https://a.test',
    });
    const r2 = Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: f.id,
      name: 'b',
      method: 'GET',
      url: 'https://b.test',
    });

    const runner = fakeRunner({
      'https://a.test': {
        id: 'x',
        ok: true,
        status: 200,
        headers: {},
        bodyBytes: new Uint8Array([65]),
        ms: 1,
        sizeBytes: 1,
      },
      'https://b.test': {
        id: 'y',
        ok: true,
        status: 201,
        headers: {},
        bodyBytes: new Uint8Array([66]),
        ms: 2,
        sizeBytes: 1,
      },
    });

    const out = await sendAllInFolder(db, secrets, f.id, runner);
    expect(out.results).toHaveLength(2);
    expect(out.results.map((r) => r.requestId).sort()).toEqual([r1.id, r2.id].sort());
    expect(out.results.every((r) => r.result.ok)).toBe(true);
    expect(runner.calls).toHaveLength(2);
    // LastResponses persisted
    expect(Repos.LastResponses.get(db, r1.id)?.status).toBe(200);
    expect(Repos.LastResponses.get(db, r2.id)?.status).toBe(201);
  });

  it('persists error envelope when a single request fails', async () => {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    const f = Repos.Folders.create(db, { collectionId: c.id, name: 'F' });
    const r1 = Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: f.id,
      name: 'ok',
      method: 'GET',
      url: 'https://ok.test',
    });
    const r2 = Repos.Requests.create(db, {
      collectionId: c.id,
      folderId: f.id,
      name: 'fail',
      method: 'GET',
      url: 'https://fail.test',
    });

    const runner = fakeRunner({
      'https://ok.test': {
        id: 'x',
        ok: true,
        status: 200,
        headers: {},
        bodyBytes: new Uint8Array(),
        ms: 1,
        sizeBytes: 0,
      },
      'https://fail.test': {
        id: 'y',
        ok: false,
        category: 'network',
        message: 'ECONNREFUSED',
      },
    });

    const out = await sendAllInFolder(db, secrets, f.id, runner);
    expect(out.results).toHaveLength(2);
    const okRow = Repos.LastResponses.get(db, r1.id);
    expect(okRow?.status).toBe(200);
    const failRow = Repos.LastResponses.get(db, r2.id);
    expect(failRow?.errorText).toBe('network: ECONNREFUSED');
  });

  it('returns empty results for an empty folder', async () => {
    const w = Repos.Workspaces.create(db, { name: 'w' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'c' });
    const f = Repos.Folders.create(db, { collectionId: c.id, name: 'F' });
    const runner = fakeRunner({});
    const out = await sendAllInFolder(db, secrets, f.id, runner);
    expect(out.results).toEqual([]);
  });
});
