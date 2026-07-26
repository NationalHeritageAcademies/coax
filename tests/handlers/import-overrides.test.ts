import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type Db } from '@storage/db';
import { Repos } from '@storage/repos';
import { parseHttpFile } from '@parser/parse';

// Note: the http:import handler reads the workspace index from disk via
// Electron's `app.getPath('userData')`, which isn't available in vitest.
// We exercise the *override-application* part of import directly: parse a
// .http file, then run the same loop the handler runs. This catches any
// drift between the parsed shape and how it lands in the repo.

let db: Db;
let collectionId: string;

beforeEach(() => {
  db = openDb(':memory:');
  const ws = Repos.Workspaces.create(db, { name: 'w' });
  const col = Repos.Collections.create(db, { workspaceId: ws.id, name: 'c' });
  collectionId = col.id;
});

function applyImport(text: string): { requestId: string } {
  const parsed = parseHttpFile(text);
  expect(parsed.requests).toHaveLength(1);
  const r = parsed.requests[0]!;
  const req = Repos.Requests.create(db, {
    collectionId,
    name: r.title,
    method: r.method,
    url: r.url,
    headers: r.headers,
  });
  // Same logic as 'http:import' in src/app/handlers.ts:
  for (const o of r.overrides ?? []) {
    if (o.isSecret) {
      Repos.RequestVarOverrides.upsert(db, {
        requestId: req.id,
        key: o.key,
        valueSecretBlob: Buffer.alloc(0),
      });
    } else {
      Repos.RequestVarOverrides.upsert(db, {
        requestId: req.id,
        key: o.key,
        valuePlain: o.value ?? '',
      });
    }
  }
  return { requestId: req.id };
}

describe('http:import override application', () => {
  it('creates a plaintext override row from `# @override`', () => {
    const { requestId } = applyImport(
      `### Hello
# @override apiBase https://staging.example.com
GET {{apiBase}}/x
`,
    );
    const rows = Repos.RequestVarOverrides.listByRequest(db, requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe('apiBase');
    expect(rows[0]!.isSecret).toBe(false);
    expect(rows[0]!.valuePlain).toBe('https://staging.example.com');
  });

  it('creates a "needs value" sentinel row from `# @override:secret`', () => {
    const { requestId } = applyImport(
      `### Hello
# @override:secret apiKey
GET https://x.example
`,
    );
    const rows = Repos.RequestVarOverrides.listByRequest(db, requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe('apiKey');
    expect(rows[0]!.isSecret).toBe(true);
    expect(rows[0]!.valuePlain).toBeUndefined();
    expect(rows[0]!.valueSecretBlob).toBeDefined();
    expect(rows[0]!.valueSecretBlob!.length).toBe(0);
  });

  it('handles a request with both plain and secret overrides', () => {
    const { requestId } = applyImport(
      `### Hello
# @override apiBase https://staging.example.com
# @override:secret apiKey
GET {{apiBase}}/x
Authorization: Bearer {{apiKey}}
`,
    );
    const rows = Repos.RequestVarOverrides.listByRequest(db, requestId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.key === 'apiBase')?.valuePlain).toBe(
      'https://staging.example.com',
    );
    expect(rows.find((r) => r.key === 'apiKey')?.isSecret).toBe(true);
  });

  it('creates no override rows for a request without directives', () => {
    const { requestId } = applyImport(
      `### Hello
GET https://x.example
`,
    );
    expect(Repos.RequestVarOverrides.listByRequest(db, requestId)).toEqual([]);
  });
});
