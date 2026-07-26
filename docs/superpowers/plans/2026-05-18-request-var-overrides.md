# Per-Request Variable Overrides — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a single request override the value of an inherited env variable, with full plaintext/secret support, persistence in SQLite, and `# @override` round-trip through `.http` import/export.

**Architecture:** Add a `request_var_overrides` SQLite table that mirrors the `variables` table (plain or encrypted blob). Wire it into the resolver's existing-but-unused `scopes.request` slot. Replace the request page's Vars panel with a unified click-to-override table. Extend the `.http` parser/serializer with a per-request `# @override[:secret]` directive.

**Tech Stack:** TypeScript, better-sqlite3, Electron `safeStorage` via `Secrets`, `@melodicdev/core` web components, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-05-18-request-var-overrides-design.md`

---

## File Structure

**Create:**
- `src/storage/migrations/004_request_var_overrides.sql` — new table + index.
- `tests/storage/request-var-overrides.test.ts` — repo unit tests.
- `tests/resolver/request-overrides.test.ts` — resolver wiring.
- `tests/parser/override-directive.test.ts` — parse/serialize round-trip.
- `tests/handlers/request-overrides-ipc.test.ts` — IPC contract.
- `tests/handlers/import-overrides.test.ts` — import wiring.
- `tests/handlers/export-overrides.test.ts` — export wiring.

**Modify:**
- `src/storage/repos.ts` — add `RequestVarOverrides` repo (~150 LOC), export from the `Repos` aggregate.
- `src/app/handlers.ts` — populate `scopes.request` in `buildScopesForRequest`; add three IPC handlers; emit overrides from `exportTree`; consume overrides in `'http:import'`.
- `src/parser/lexer.ts` — add `override` line kind.
- `src/parser/parse.ts` — surface `overrides` on `ParsedRequest`.
- `src/parser/types.ts` — add `overrides` to `ParsedRequest`.
- `src/parser/serialize.ts` — emit `# @override[:secret]` lines between title and method.
- `src/ui/components/request-tab.ts` — rewrite `renderVarsPanel` / `renderActiveEnvVarsSection`.

---

## Task 1: Migration + Repo Skeleton

**Files:**
- Create: `src/storage/migrations/004_request_var_overrides.sql`
- Modify: `src/storage/repos.ts` (add `RequestVarOverrides` block before `// Open tabs` section, around line 989; export in the aggregate `Repos` object near the bottom of the file)
- Test: `tests/storage/request-var-overrides.test.ts`

- [ ] **Step 1: Write the migration**

`src/storage/migrations/004_request_var_overrides.sql`:

```sql
-- Per-request variable overrides. Mirrors the `variables` table's secret
-- handling: plaintext rows have value_plain set; secret rows have an
-- encrypted blob in value_secret_blob. Override is identified by
-- (request_id, key) — uniqueness enforced at the SQL level.

BEGIN;

CREATE TABLE request_var_overrides (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_plain TEXT,
  value_secret_blob BLOB,
  is_secret INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(request_id, key)
);

CREATE INDEX idx_request_var_overrides_request_id
  ON request_var_overrides(request_id);

UPDATE schema_version SET version = 4;

COMMIT;
```

- [ ] **Step 2: Write failing repo test (schema + listByRequest empty)**

`tests/storage/request-var-overrides.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Repos } from '../../src/storage/repos.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const dir = join(process.cwd(), 'src/storage/migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

describe('Repos.RequestVarOverrides', () => {
  let db: ReturnType<typeof freshDb>;
  let requestId: string;

  beforeEach(() => {
    db = freshDb();
    const ws = Repos.Workspaces.create(db, { name: 'w' });
    const col = Repos.Collections.create(db, { workspaceId: ws.id, name: 'c' });
    const req = Repos.Requests.create(db, {
      collectionId: col.id,
      name: 'r',
      method: 'GET',
      url: 'https://x.example/{{p}}',
      headers: [],
    });
    requestId = req.id;
  });

  it('listByRequest returns [] when none exist', () => {
    expect(Repos.RequestVarOverrides.listByRequest(db, requestId)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test — should fail because `RequestVarOverrides` doesn't exist**

```bash
npx vitest run tests/storage/request-var-overrides.test.ts
```

Expected: TypeError / undefined `Repos.RequestVarOverrides`.

- [ ] **Step 4: Add the repo skeleton**

In `src/storage/repos.ts`, immediately before the `// Open tabs` section (around line 989), add:

```ts
// =====================================================================
// Per-request variable overrides
// =====================================================================

export interface RequestVarOverride {
  id: string;
  requestId: string;
  key: string;
  isSecret: boolean;
  valuePlain?: string;
  valueSecretBlob?: Buffer;
  sortOrder: number;
}

interface RequestVarOverrideRow {
  id: string;
  request_id: string;
  key: string;
  value_plain: string | null;
  value_secret_blob: Buffer | null;
  is_secret: number;
  sort_order: number;
}

function mapOverrideRow(row: RequestVarOverrideRow): RequestVarOverride {
  const out: RequestVarOverride = {
    id: row.id,
    requestId: row.request_id,
    key: row.key,
    isSecret: toBool(row.is_secret),
    sortOrder: row.sort_order,
  };
  if (row.value_plain !== null) out.valuePlain = row.value_plain;
  if (row.value_secret_blob !== null) {
    out.valueSecretBlob = Buffer.isBuffer(row.value_secret_blob)
      ? row.value_secret_blob
      : Buffer.from(row.value_secret_blob);
  }
  return out;
}

export const RequestVarOverrides = {
  listByRequest(db: Db, requestId: string): RequestVarOverride[] {
    const rows = db
      .prepare(
        'SELECT * FROM request_var_overrides WHERE request_id = ? ORDER BY key',
      )
      .all(requestId) as RequestVarOverrideRow[];
    return rows.map(mapOverrideRow);
  },
};
```

Then in the aggregate export at the bottom of the file (`export const Repos = { ... }`), add `RequestVarOverrides,` alongside `Vars,`.

- [ ] **Step 5: Run test — should pass**

```bash
npx vitest run tests/storage/request-var-overrides.test.ts
```

Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
git add src/storage/migrations/004_request_var_overrides.sql src/storage/repos.ts tests/storage/request-var-overrides.test.ts
git commit -m "feat(overrides): add request_var_overrides table + Repos skeleton"
```

---

## Task 2: Repo — `upsert` and `delete`

**Files:**
- Modify: `src/storage/repos.ts` (extend `RequestVarOverrides`)
- Test: `tests/storage/request-var-overrides.test.ts`

- [ ] **Step 1: Write failing tests for upsert + delete + uniqueness**

Append to `tests/storage/request-var-overrides.test.ts`:

```ts
it('upsert creates a plaintext override', () => {
  const o = Repos.RequestVarOverrides.upsert(db, {
    requestId,
    key: 'apiBase',
    valuePlain: 'https://staging.example',
  });
  expect(o).toMatchObject({ requestId, key: 'apiBase', isSecret: false, valuePlain: 'https://staging.example' });
  expect(Repos.RequestVarOverrides.listByRequest(db, requestId)).toHaveLength(1);
});

it('upsert replaces an existing row for the same (request, key)', () => {
  Repos.RequestVarOverrides.upsert(db, { requestId, key: 'apiBase', valuePlain: 'v1' });
  Repos.RequestVarOverrides.upsert(db, { requestId, key: 'apiBase', valuePlain: 'v2' });
  const rows = Repos.RequestVarOverrides.listByRequest(db, requestId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.valuePlain).toBe('v2');
});

it('upsert stores a secret override as a blob with value_plain NULL', () => {
  const blob = Buffer.from('cipher');
  const o = Repos.RequestVarOverrides.upsert(db, {
    requestId,
    key: 'apiKey',
    valueSecretBlob: blob,
  });
  expect(o.isSecret).toBe(true);
  expect(o.valuePlain).toBeUndefined();
  expect(o.valueSecretBlob).toEqual(blob);
});

it('upsert rejects both valuePlain and valueSecretBlob', () => {
  expect(() =>
    Repos.RequestVarOverrides.upsert(db, {
      requestId,
      key: 'k',
      valuePlain: 'p',
      valueSecretBlob: Buffer.from('c'),
    }),
  ).toThrow();
});

it('delete removes the row by (request, key)', () => {
  Repos.RequestVarOverrides.upsert(db, { requestId, key: 'k', valuePlain: 'v' });
  Repos.RequestVarOverrides.delete(db, { requestId, key: 'k' });
  expect(Repos.RequestVarOverrides.listByRequest(db, requestId)).toEqual([]);
});
```

- [ ] **Step 2: Run tests — should fail**

```bash
npx vitest run tests/storage/request-var-overrides.test.ts
```

Expected: 5 failures (upsert/delete undefined).

- [ ] **Step 3: Implement upsert + delete**

Inside `export const RequestVarOverrides = { ... }`:

```ts
  upsert(
    db: Db,
    input: {
      requestId: string;
      key: string;
      valuePlain?: string;
      valueSecretBlob?: Buffer;
    },
  ): RequestVarOverride {
    if (input.valuePlain !== undefined && input.valueSecretBlob !== undefined) {
      throw new Error('OVERRIDE_BOTH_VALUES: pass valuePlain or valueSecretBlob, not both');
    }
    const isSecret = input.valueSecretBlob !== undefined;
    const existing = db
      .prepare('SELECT id FROM request_var_overrides WHERE request_id = ? AND key = ?')
      .get(input.requestId, input.key) as { id: string } | undefined;
    const id = existing?.id ?? newId();
    db.prepare(
      `INSERT INTO request_var_overrides (id, request_id, key, value_plain, value_secret_blob, is_secret, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(request_id, key) DO UPDATE SET
         value_plain = excluded.value_plain,
         value_secret_blob = excluded.value_secret_blob,
         is_secret = excluded.is_secret`,
    ).run(
      id,
      input.requestId,
      input.key,
      input.valuePlain ?? null,
      input.valueSecretBlob ?? null,
      isSecret ? 1 : 0,
    );
    const out: RequestVarOverride = {
      id,
      requestId: input.requestId,
      key: input.key,
      isSecret,
      sortOrder: 0,
    };
    if (input.valuePlain !== undefined) out.valuePlain = input.valuePlain;
    if (input.valueSecretBlob !== undefined) out.valueSecretBlob = input.valueSecretBlob;
    return out;
  },

  delete(db: Db, args: { requestId: string; key: string }): void {
    db.prepare('DELETE FROM request_var_overrides WHERE request_id = ? AND key = ?')
      .run(args.requestId, args.key);
  },
```

- [ ] **Step 4: Run tests — should pass**

```bash
npx vitest run tests/storage/request-var-overrides.test.ts
```

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/storage/repos.ts tests/storage/request-var-overrides.test.ts
git commit -m "feat(overrides): upsert + delete on RequestVarOverrides repo"
```

---

## Task 3: Repo — `listForRequest` (materialized for resolver)

**Files:**
- Modify: `src/storage/repos.ts`
- Test: `tests/storage/request-var-overrides.test.ts`

- [ ] **Step 1: Write failing test**

Append:

```ts
import type { Secrets } from '../../src/secrets/secrets.js';

const fakeSecrets = {
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
  decrypt: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
} as unknown as Secrets;

it('listForRequest materializes plain and secret overrides', () => {
  Repos.RequestVarOverrides.upsert(db, { requestId, key: 'plain', valuePlain: 'p1' });
  Repos.RequestVarOverrides.upsert(db, { requestId, key: 'secret', valueSecretBlob: fakeSecrets.encrypt('s1') });
  const out = Repos.RequestVarOverrides.listForRequest(db, fakeSecrets, requestId);
  expect(out).toEqual(
    expect.arrayContaining([
      { key: 'plain', value: 'p1', isSecret: false },
      { key: 'secret', value: 's1', isSecret: true },
    ]),
  );
});
```

- [ ] **Step 2: Run — should fail (listForRequest undefined)**

```bash
npx vitest run tests/storage/request-var-overrides.test.ts -t 'listForRequest'
```

- [ ] **Step 3: Implement**

Inside `RequestVarOverrides`:

```ts
  listForRequest(
    db: Db,
    secrets: Secrets,
    requestId: string,
  ): { key: string; value: string; isSecret: boolean }[] {
    const rows = this.listByRequest(db, requestId);
    const out: { key: string; value: string; isSecret: boolean }[] = [];
    for (const r of rows) {
      if (r.isSecret) {
        if (!r.valueSecretBlob) continue;
        out.push({ key: r.key, value: secrets.decrypt(r.valueSecretBlob), isSecret: true });
      } else {
        out.push({ key: r.key, value: r.valuePlain ?? '', isSecret: false });
      }
    }
    return out;
  },
```

Note: `Secrets` is already imported elsewhere in `repos.ts`. If not, add `import type { Secrets } from '../secrets/secrets.js';` at the top.

- [ ] **Step 4: Run — should pass**

```bash
npx vitest run tests/storage/request-var-overrides.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/storage/repos.ts tests/storage/request-var-overrides.test.ts
git commit -m "feat(overrides): listForRequest with secret materialization"
```

---

## Task 4: Wire overrides into the resolver

**Files:**
- Modify: `src/app/handlers.ts` (`buildScopesForRequest` around line 135)
- Test: `tests/resolver/request-overrides.test.ts`

- [ ] **Step 1: Write failing resolver test**

`tests/resolver/request-overrides.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolve } from '../../src/resolver/resolve.js';

describe('request scope overrides chain', () => {
  it('request var wins over chainFlat', () => {
    const r = resolve('hello {{name}}', {
      scopes: {
        request: { name: 'override' },
        chainFlat: { name: 'env' },
      },
    });
    expect(r.text).toBe('hello override');
  });

  it('chainFlat wins over collectionDefaults', () => {
    const r = resolve('hello {{name}}', {
      scopes: {
        chainFlat: { name: 'env' },
        collectionDefaults: { name: 'def' },
      },
    });
    expect(r.text).toBe('hello env');
  });
});
```

- [ ] **Step 2: Run — these should already pass (resolver already respects request scope)**

```bash
npx vitest run tests/resolver/request-overrides.test.ts
```

If they fail, fix `src/resolver/resolve.ts` first; the spec says the resolver already encodes this precedence.

- [ ] **Step 3: Write failing integration test (buildScopesForRequest pulls overrides)**

Append (or create a sibling test file `tests/handlers/build-scopes-overrides.test.ts`):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Repos } from '../../src/storage/repos.js';
import { buildScopesForRequest } from '../../src/app/handlers.js';
import type { Secrets } from '../../src/secrets/secrets.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const dir = join(process.cwd(), 'src/storage/migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

const fakeSecrets = {
  encrypt: (s: string) => Buffer.from(`enc:${s}`),
  decrypt: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
} as unknown as Secrets;

describe('buildScopesForRequest with overrides', () => {
  it('populates scopes.request from request_var_overrides', () => {
    const db = freshDb();
    const ws = Repos.Workspaces.create(db, { name: 'w' });
    const col = Repos.Collections.create(db, { workspaceId: ws.id, name: 'c' });
    const env = Repos.Envs.create(db, { folderId: col.rootFolderId, name: 'e' });
    Repos.Envs.setActive(db, col.rootFolderId, env.id);
    Repos.Vars.create(db, { envId: env.id, key: 'host', valuePlain: 'env-host' });
    const req = Repos.Requests.create(db, {
      collectionId: col.id, name: 'r', method: 'GET',
      url: 'https://{{host}}/x', headers: [],
    });
    Repos.RequestVarOverrides.upsert(db, {
      requestId: req.id, key: 'host', valuePlain: 'override-host',
    });
    const scopes = buildScopesForRequest(db, fakeSecrets, req.id);
    expect(scopes.request).toEqual({ host: 'override-host' });
    expect(scopes.chainFlat).toEqual({ host: 'env-host' });
  });
});
```

- [ ] **Step 4: Run — should fail**

```bash
npx vitest run tests/handlers/build-scopes-overrides.test.ts
```

Expected: `scopes.request` is undefined.

- [ ] **Step 5: Patch `buildScopesForRequest`**

In `src/app/handlers.ts:135` `buildScopesForRequest`, after the `for (const step of chain)` loop and before the `return scopes`, add:

```ts
  const overrides = Repos.RequestVarOverrides.listForRequest(db, secretsImpl, requestId);
  if (overrides.length > 0) {
    const reqMap: Record<string, string> = {};
    for (const o of overrides) reqMap[o.key] = o.value;
    scopes.request = reqMap;
  }
```

- [ ] **Step 6: Run — should pass**

```bash
npx vitest run tests/handlers/build-scopes-overrides.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/app/handlers.ts tests/resolver/request-overrides.test.ts tests/handlers/build-scopes-overrides.test.ts
git commit -m "feat(overrides): populate scopes.request in buildScopesForRequest"
```

---

## Task 5: IPC — list / set / delete

**Files:**
- Modify: `src/app/handlers.ts` (add three handlers next to the existing `'var:resolve'` handler near line 914)
- Modify: `src/ipc/types.ts` if it carries IPC channel typings (grep for `var:resolve` to see)
- Test: `tests/handlers/request-overrides-ipc.test.ts`

- [ ] **Step 1: Write failing test**

`tests/handlers/request-overrides-ipc.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Repos } from '../../src/storage/repos.js';
import { __handlersForTest } from '../../src/app/handlers.js'; // export added below
import type { Secrets } from '../../src/secrets/secrets.js';

function freshDb() { /* same helper as Task 4 */ }
const fakeSecrets = { /* same helper as Task 4 */ } as unknown as Secrets;

describe('request:overrides IPC', () => {
  it('list returns [] for a new request', async () => {
    const db = freshDb();
    /* …seed request like Task 4… */
    const h = __handlersForTest({ db, secrets: fakeSecrets });
    const r = await h['request:overrides:list']({ requestId });
    expect(r.overrides).toEqual([]);
  });

  it('set creates a plaintext override and list returns it', async () => {
    /* …seed… */
    const h = __handlersForTest({ db, secrets: fakeSecrets });
    await h['request:overrides:set']({ requestId, key: 'host', valuePlain: 'x' });
    const r = await h['request:overrides:list']({ requestId });
    expect(r.overrides).toEqual([{ key: 'host', valuePlain: 'x', isSecret: false }]);
  });

  it('set with valueSecret encrypts before storing', async () => {
    /* …seed env with key `apiKey` so the key exists in the chain… */
    const h = __handlersForTest({ db, secrets: fakeSecrets });
    await h['request:overrides:set']({ requestId, key: 'apiKey', valueSecret: 'hush' });
    const rows = Repos.RequestVarOverrides.listByRequest(db, requestId);
    expect(rows[0]!.isSecret).toBe(true);
    expect(rows[0]!.valueSecretBlob?.toString()).toBe('enc:hush');
  });

  it('set rejects a key not in the chain when no override exists yet', async () => {
    /* …seed env without the key… */
    const h = __handlersForTest({ db, secrets: fakeSecrets });
    await expect(
      h['request:overrides:set']({ requestId, key: 'nope', valuePlain: 'x' }),
    ).rejects.toThrow(/UNKNOWN_KEY/);
  });

  it('set succeeds for already-orphaned override (idempotent)', async () => {
    /* …seed env with key, create override, then remove env var, then set again — should NOT throw… */
  });

  it('delete removes one override', async () => {
    /* …seed and create override… */
    const h = __handlersForTest({ db, secrets: fakeSecrets });
    await h['request:overrides:delete']({ requestId, key: 'host' });
    expect(Repos.RequestVarOverrides.listByRequest(db, requestId)).toEqual([]);
  });
});
```

(Fill in the `/* … */` blocks following the seeding pattern from Task 4.)

- [ ] **Step 2: Run — should fail (handlers missing)**

```bash
npx vitest run tests/handlers/request-overrides-ipc.test.ts
```

- [ ] **Step 3: Add the IPC handlers**

In `src/app/handlers.ts` add a helper that resolves all keys visible to a request through the env chain (used for validation):

```ts
function allKnownVarKeysForRequest(db: Db, secretsImpl: Secrets, requestId: string): Set<string> {
  const scopes = buildScopesForRequest(db, secretsImpl, requestId);
  const keys = new Set<string>();
  for (const k of Object.keys(scopes.chainFlat ?? {})) keys.add(k);
  return keys;
}
```

Then add three IPC handlers inside the `export const handlers = { ... }` map (next to `'var:resolve'`):

```ts
  'request:overrides:list': ({ requestId }) => {
    const rows = Repos.RequestVarOverrides.listByRequest(getDb(), requestId);
    return {
      overrides: rows.map((r) => ({
        key: r.key,
        ...(r.valuePlain !== undefined ? { valuePlain: r.valuePlain } : {}),
        isSecret: r.isSecret,
      })),
    };
  },

  'request:overrides:set': ({ requestId, key, valuePlain, valueSecret }) => {
    if (valuePlain !== undefined && valueSecret !== undefined) {
      throw new Error('OVERRIDE_BOTH_VALUES');
    }
    const db = getDb();
    const secrets = getSecrets();
    const existing = Repos.RequestVarOverrides.listByRequest(db, requestId)
      .find((o) => o.key === key);
    if (!existing) {
      // Only enforce the "must exist in chain" rule for *new* overrides.
      const known = allKnownVarKeysForRequest(db, secrets, requestId);
      if (!known.has(key)) {
        throw new Error(`UNKNOWN_KEY: ${key} is not in this request's env chain`);
      }
    }
    if (valueSecret !== undefined) {
      const blob = secrets.encrypt(valueSecret);
      return Repos.RequestVarOverrides.upsert(db, { requestId, key, valueSecretBlob: blob });
    }
    return Repos.RequestVarOverrides.upsert(db, {
      requestId, key, valuePlain: valuePlain ?? '',
    });
  },

  'request:overrides:delete': ({ requestId, key }) => {
    Repos.RequestVarOverrides.delete(getDb(), { requestId, key });
    return { key };
  },
```

Then expose a test seam at the bottom of the file (next to the existing `export const handlers = ...`):

```ts
export function __handlersForTest(deps: { db: Db; secrets: Secrets }): typeof handlers {
  // Existing pattern: rebind the module-level db/secrets accessors. Match how
  // other tests in this repo invoke handlers — if there isn't an existing
  // pattern, expose `handlers` directly and have tests stub `getDb`/`getSecrets`
  // (whichever the repo already does — search `tests/handlers/*.ts` for prior art).
  // ...
}
```

- [ ] **Step 4: Wire the channel types**

Search for where existing IPC channel payload types are declared (`grep -rn "var:resolve" src/ipc src/app | head`). Add the three new channels with the same pattern.

- [ ] **Step 5: Run — should pass**

```bash
npx vitest run tests/handlers/request-overrides-ipc.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/app/handlers.ts src/ipc/types.ts tests/handlers/request-overrides-ipc.test.ts
git commit -m "feat(overrides): request:overrides:{list,set,delete} IPC"
```

---

## Task 6: Parser — `# @override` directive (lexer + parse)

**Files:**
- Modify: `src/parser/lexer.ts`
- Modify: `src/parser/parse.ts`
- Modify: `src/parser/types.ts`
- Test: `tests/parser/override-directive.test.ts`

- [ ] **Step 1: Write failing test**

`tests/parser/override-directive.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHttpFile } from '../../src/parser/parse.js';

describe('# @override directive', () => {
  it('parses a plaintext override', () => {
    const file = parseHttpFile(
`### Get users
# @override apiBase https://staging.example.com
GET {{apiBase}}/users
`);
    expect(file.requests[0]!.overrides).toEqual([
      { key: 'apiBase', value: 'https://staging.example.com', isSecret: false },
    ]);
  });

  it('parses a secret override (no value)', () => {
    const file = parseHttpFile(
`### Get users
# @override:secret apiKey
GET {{apiBase}}/users
`);
    expect(file.requests[0]!.overrides).toEqual([
      { key: 'apiKey', isSecret: true },
    ]);
  });

  it('does not pull stray @override lines from earlier blocks', () => {
    const file = parseHttpFile(
`### A
# @override foo bar
GET https://a.example

### B
GET https://b.example
`);
    expect(file.requests[0]!.overrides).toEqual([{ key: 'foo', value: 'bar', isSecret: false }]);
    expect(file.requests[1]!.overrides ?? []).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — should fail (no `overrides` on parsed request)**

```bash
npx vitest run tests/parser/override-directive.test.ts
```

- [ ] **Step 3: Lexer — add the line kind**

In `src/parser/lexer.ts`, add to the `RX` map (alongside `name`):

```ts
override: /^#\s*@override(:secret)?\s+(\S+)(?:\s+(.*))?\s*$/,
```

And in the `if ((m = RX...))` chain (just below `if ((m = RX.name.exec(raw)))`):

```ts
if ((m = RX.override.exec(raw))) {
  const isSecret = m[1] === ':secret';
  const value = (m[3] ?? '').trim();
  return { kind: 'override', key: m[2]!, value, isSecret, lineNo };
}
```

Also extend the `Line` discriminated union to include:

```ts
| { kind: 'override'; key: string; value: string; isSecret: boolean; lineNo: number }
```

- [ ] **Step 4: parse.ts — surface overrides**

In `src/parser/parse.ts` `blockToRequest`, declare `let overrides: { key: string; value?: string; isSecret: boolean }[] = []` alongside the existing `let name: string | undefined;`. In the pre-method scan loop:

```ts
else if (l.kind === 'override') {
  overrides.push({
    key: l.key,
    isSecret: l.isSecret,
    ...(l.isSecret ? {} : { value: l.value }),
  });
}
```

Then in the returned `ParsedRequest` literal, append:

```ts
...(overrides.length > 0 ? { overrides } : {}),
```

- [ ] **Step 5: types.ts — declare the field**

In `src/parser/types.ts`, add to `ParsedRequest`:

```ts
overrides?: { key: string; value?: string; isSecret: boolean }[];
```

- [ ] **Step 6: Run — should pass**

```bash
npx vitest run tests/parser/override-directive.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/parser/lexer.ts src/parser/parse.ts src/parser/types.ts tests/parser/override-directive.test.ts
git commit -m "feat(overrides): parse # @override and # @override:secret directives"
```

---

## Task 7: Parser — serialize overrides

**Files:**
- Modify: `src/parser/serialize.ts`
- Test: `tests/parser/override-directive.test.ts` (append)

- [ ] **Step 1: Write failing round-trip test**

Append to `tests/parser/override-directive.test.ts`:

```ts
import { serializeHttpFile } from '../../src/parser/serialize.js';

it('round-trips overrides through parse → serialize → parse', () => {
  const src =
`### Demo
# @override apiBase https://staging.example.com
# @override:secret apiKey
GET {{apiBase}}/x
Authorization: Bearer {{apiKey}}
`;
  const a = parseHttpFile(src);
  const out = serializeHttpFile(a);
  const b = parseHttpFile(out);
  expect(b.requests[0]!.overrides).toEqual([
    { key: 'apiBase', value: 'https://staging.example.com', isSecret: false },
    { key: 'apiKey', isSecret: true },
  ]);
});
```

- [ ] **Step 2: Run — should fail (serializer drops overrides)**

```bash
npx vitest run tests/parser/override-directive.test.ts -t 'round-trips'
```

- [ ] **Step 3: Emit overrides in the serializer**

In `src/parser/serialize.ts`, in the per-request emission (immediately after the `### <title>` line and before the method line):

```ts
for (const o of req.overrides ?? []) {
  if (o.isSecret) lines.push(`# @override:secret ${o.key}`);
  else lines.push(`# @override ${o.key} ${o.value ?? ''}`);
}
```

(Adjust `lines.push` to match the actual accumulator variable in `serialize.ts`.)

- [ ] **Step 4: Run — should pass**

```bash
npx vitest run tests/parser/override-directive.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/parser/serialize.ts tests/parser/override-directive.test.ts
git commit -m "feat(overrides): emit # @override directives on export"
```

---

## Task 8: `http:import` consumes overrides

**Files:**
- Modify: `src/app/handlers.ts` (`'http:import'` handler around line 1037)
- Test: `tests/handlers/import-overrides.test.ts`

- [ ] **Step 1: Write failing test**

`tests/handlers/import-overrides.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repos } from '../../src/storage/repos.js';
import { __handlersForTest } from '../../src/app/handlers.js';
import type { Secrets } from '../../src/secrets/secrets.js';

it('http:import creates override rows from parsed overrides', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-'));
  const file = join(dir, 'demo.http');
  writeFileSync(
    file,
    `@apiBase = https://prod.example.com\n\n### Hello\n# @override apiBase https://staging.example.com\n# @override:secret apiKey\nGET {{apiBase}}/x\n`,
  );
  /* … set up workspace + invoke http:import via __handlersForTest … */
  const reqs = Repos.Requests.listByCollection(db, result.collectionId);
  const overrides = Repos.RequestVarOverrides.listByRequest(db, reqs[0]!.id);
  expect(overrides).toHaveLength(2);
  expect(overrides.find((o) => o.key === 'apiBase')?.valuePlain).toBe('https://staging.example.com');
  expect(overrides.find((o) => o.key === 'apiKey')?.isSecret).toBe(true);
  expect(overrides.find((o) => o.key === 'apiKey')?.valuePlain).toBeUndefined();
});
```

- [ ] **Step 2: Run — should fail**

```bash
npx vitest run tests/handlers/import-overrides.test.ts
```

- [ ] **Step 3: Wire overrides into `'http:import'`**

After the `Repos.Requests.create(...)` call inside the per-request loop (around line 1040 in `src/app/handlers.ts`), add:

```ts
const newReq = Repos.Requests.create(getDb(), { /* existing args */ });
for (const o of r.overrides ?? []) {
  if (o.isSecret) {
    // No value to encrypt on import — leave the row in "needs value" state.
    // We write a sentinel empty blob so is_secret stays consistent with the
    // (request_id, key, blob/null) invariant used by Repos.
    Repos.RequestVarOverrides.upsert(getDb(), {
      requestId: newReq.id,
      key: o.key,
      valueSecretBlob: Buffer.alloc(0),
    });
  } else {
    Repos.RequestVarOverrides.upsert(getDb(), {
      requestId: newReq.id,
      key: o.key,
      valuePlain: o.value ?? '',
    });
  }
}
```

Note: a zero-length `value_secret_blob` is the "needs value" sentinel. `listForRequest` should skip these (already does — `if (!r.valueSecretBlob) continue;` requires non-empty buffer; update the guard to `if (!r.valueSecretBlob || r.valueSecretBlob.length === 0) continue;`).

- [ ] **Step 4: Update the listForRequest guard**

In `src/storage/repos.ts` `RequestVarOverrides.listForRequest`:

```ts
if (!r.valueSecretBlob || r.valueSecretBlob.length === 0) continue;
```

Add a corresponding test in `tests/storage/request-var-overrides.test.ts`:

```ts
it('listForRequest skips secret rows with zero-byte blobs (needs value)', () => {
  Repos.RequestVarOverrides.upsert(db, { requestId, key: 'k', valueSecretBlob: Buffer.alloc(0) });
  expect(Repos.RequestVarOverrides.listForRequest(db, fakeSecrets, requestId)).toEqual([]);
});
```

- [ ] **Step 5: Run all tests touched so far**

```bash
npx vitest run tests/handlers/import-overrides.test.ts tests/storage/request-var-overrides.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/app/handlers.ts src/storage/repos.ts tests/handlers/import-overrides.test.ts tests/storage/request-var-overrides.test.ts
git commit -m "feat(overrides): import @override directives into request_var_overrides"
```

---

## Task 9: `exportTree` emits overrides

**Files:**
- Modify: `src/app/handlers.ts` (`exportTree` around line 472)
- Test: `tests/handlers/export-overrides.test.ts`

- [ ] **Step 1: Write failing test**

`tests/handlers/export-overrides.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportTree } from '../../src/app/handlers.js';
/* …seed helpers… */

it('export emits @override directives for plain and secret overrides', () => {
  /* …seed workspace + collection + request + 1 plain override + 1 secret override… */
  const target = join(mkdtempSync(join(tmpdir(), 'exp-')), 'out.http');
  exportTree(db, fakeSecrets, 'collection', collectionId, target);
  const text = readFileSync(target, 'utf8');
  expect(text).toMatch(/# @override apiBase https:\/\/staging\.example\.com/);
  expect(text).toMatch(/# @override:secret apiKey/);
  // Secret value MUST NOT appear in the file.
  expect(text).not.toMatch(/hush/);
});
```

- [ ] **Step 2: Run — should fail (exporter doesn't read overrides)**

```bash
npx vitest run tests/handlers/export-overrides.test.ts
```

- [ ] **Step 3: Patch `exportTree`**

In `src/app/handlers.ts` `exportTree`, in the per-request loop (around line 472, where `parsedRequests.push(req)` happens), build overrides:

```ts
const overrideRows = Repos.RequestVarOverrides.listByRequest(db, r.id);
if (overrideRows.length > 0) {
  req.overrides = overrideRows.map((o) =>
    o.isSecret
      ? { key: o.key, isSecret: true }
      : { key: o.key, value: o.valuePlain ?? '', isSecret: false },
  );
}
```

(`req` is the `ParsedRequest` being built; the serializer added in Task 7 reads `req.overrides`.)

- [ ] **Step 4: Run — should pass**

```bash
npx vitest run tests/handlers/export-overrides.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/app/handlers.ts tests/handlers/export-overrides.test.ts
git commit -m "feat(overrides): emit @override directives in export"
```

---

## Task 10: UI — unified Vars table + click-to-override (plain)

**Files:**
- Modify: `src/ui/components/request-tab.ts` (replace `renderActiveEnvVarsSection`, `renderInheritedVars`, `renderEnvVarsTable`, and the related state signals/methods)
- Add a Playwright spec: `tests-e2e/request-overrides.spec.ts`

- [ ] **Step 1: Add an `overrides` signal + fetcher**

In the `RequestTabComponent` class:

```ts
overrides = signal<{ key: string; valuePlain?: string; isSecret: boolean }[]>([]);
editingOverrideKey = signal<string | null>(null);

async fetchOverrides(): Promise<void> {
  const id = this.requestId;
  if (!id) { this.overrides.set([]); return; }
  try {
    const r = await rpc<{ overrides: { key: string; valuePlain?: string; isSecret: boolean }[] }>(
      { kind: 'request:overrides:list', requestId: id },
    );
    this.overrides.set(r.overrides);
  } catch (err) {
    console.error('request:overrides:list failed:', err);
    this.overrides.set([]);
  }
}
```

Call `void this.fetchOverrides();` in the same place `fetchEnvVars` is called (in the Vars-tab activation logic, ~line 1035).

- [ ] **Step 2: Replace `renderActiveEnvVarsSection` with a unified table**

Delete the existing `renderInheritedVars` and `renderEnvVarsTable` helpers and the `renderActiveEnvVarsSection`. Write a single new helper:

```ts
function renderActiveEnvVarsSection(c: RequestTabComponent) {
  const list = c.envVars();
  const overrides = c.overrides();
  if (list === null) return html`<section class="var-section"><h4>Variables</h4><div>Loading…</div></section>`;
  if (list.length === 0) {
    return html`<section class="var-section"><h4>Variables</h4>
      <div class="empty-envs">No active environment in this request's chain. Open Manage envs to create one.</div>
    </section>`;
  }
  // Build a deepest-wins map across the chain.
  type Row = { key: string; value: string; isSecret: boolean; source: string };
  const map = new Map<string, Row>();
  for (const env of list) {
    for (const v of env.vars) {
      map.set(v.key, {
        key: v.key,
        value: v.valuePlain ?? '',
        isSecret: v.isSecret,
        source: `${env.folderName} · ${env.envName}`,
      });
    }
  }
  // Apply overrides (deepest of all).
  const overrideByKey = new Map(overrides.map((o) => [o.key, o]));
  for (const o of overrides) {
    const base = map.get(o.key);
    if (!base) continue; // orphan; rendered in its own section below
    map.set(o.key, {
      key: o.key,
      value: o.isSecret ? '[secret]' : (o.valuePlain ?? ''),
      isSecret: o.isSecret,
      source: 'This request',
    });
  }
  const rows = [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  const orphans = overrides.filter((o) => !map.has(o.key));
  // (orphan handling lands in Task 12 — for now, ignore orphans here.)
  return html`<section class="var-section">
    <h4>Variables</h4>
    <table class="env-vars-table">
      <thead><tr><th style="width:30%">Key</th><th style="width:50%">Value</th><th>From</th></tr></thead>
      <tbody>
        ${rows.map((r) => renderUnifiedRow(c, r, overrideByKey.get(r.key)))}
      </tbody>
    </table>
  </section>`;
}

function renderUnifiedRow(c, r, override) {
  const isEditing = c.editingOverrideKey() === r.key && !r.isSecret;
  return html`
    <tr data-var-key=${r.key}>
      <td style="font-family:monospace">${r.key}</td>
      <td>
        ${r.isSecret
          ? html`<span style="font-family:monospace;color:var(--hu-text-muted)">[secret]</span>`
          : isEditing
          ? html`<ml-input class="override-value" size="sm" type="text" .value=${r.value}
              @ml:change=${(e: Event) => c.commitOverride(r.key, e)}
              @blur=${(e: Event) => c.commitOverride(r.key, e)}></ml-input>`
          : html`<span class="value-cell" @click=${() => c.startOverride(r.key)}
              style="cursor:text;display:block;width:100%">${r.value}</span>`}
      </td>
      <td>
        ${override
          ? html`<span class="badge-override">overridden</span>
              <ml-button variant="ghost" size="xs" @ml:click=${() => c.clearOverride(r.key)}>×</ml-button>`
          : html`<span style="font-size:11px;color:var(--hu-text-secondary)">${r.source}</span>`}
      </td>
    </tr>`;
}
```

Add methods to the component:

```ts
startOverride = (key: string): void => {
  this.editingOverrideKey.set(key);
};

commitOverride = async (key: string, e: Event): Promise<void> => {
  const id = this.requestId; if (!id) return;
  const input = e.target as HTMLElement & { value: string };
  const v = (input.value ?? '').trim();
  this.editingOverrideKey.set(null);
  try {
    if (v === '') {
      await rpc({ kind: 'request:overrides:delete', requestId: id, key });
    } else {
      await rpc({ kind: 'request:overrides:set', requestId: id, key, valuePlain: v });
    }
    await this.fetchOverrides();
  } catch (err) {
    showToast(`Override failed: ${(err as Error).message}`, 'error');
  }
};

clearOverride = async (key: string): Promise<void> => {
  const id = this.requestId; if (!id) return;
  await rpc({ kind: 'request:overrides:delete', requestId: id, key });
  await this.fetchOverrides();
};
```

- [ ] **Step 3: Run dev build + manual smoke**

```bash
npm run dev
```

In the running app: open a request whose folder has an active env. On the Vars tab, click an inherited value cell, edit, blur → row gets "overridden" badge. Click `×` → reverts.

- [ ] **Step 4: Add Playwright spec**

`tests-e2e/request-overrides.spec.ts` — exercise click → edit → blur → row shows badge; click × → badge gone. Use the same harness as existing Playwright specs (check `tests-e2e/` for prior art).

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/request-tab.ts tests-e2e/request-overrides.spec.ts
git commit -m "feat(overrides): unified Vars table with click-to-override for plain values"
```

---

## Task 11: UI — secret override picker

**Files:**
- Modify: `src/ui/components/request-tab.ts`
- Test: extend `tests-e2e/request-overrides.spec.ts`

- [ ] **Step 1: Replace the secret cell with a picker**

In `renderUnifiedRow`, replace the `r.isSecret` branch with a picker:

```ts
${r.isSecret
  ? c.secretPickerKey() === r.key
    ? html`<div class="secret-picker">
        <ml-button size="xs" @ml:click=${() => c.startOverride(r.key, 'plain')}>plaintext</ml-button>
        <ml-button size="xs" @ml:click=${() => c.startOverride(r.key, 'secret')}>secret</ml-button>
        <ml-button size="xs" variant="ghost" @ml:click=${() => c.secretPickerKey.set(null)}>cancel</ml-button>
      </div>`
    : html`<span class="value-cell" @click=${() => c.secretPickerKey.set(r.key)}
        style="font-family:monospace;color:var(--hu-text-muted);cursor:pointer">
        ${override ? '[secret · overridden]' : '[secret]'}
      </span>`
  : /* …existing plain branch… */}
```

Add a `secretPickerKey = signal<string | null>(null)` and an `editingOverrideKind = signal<'plain' | 'secret' | null>(null)` to the component. Extend `startOverride` to accept a kind:

```ts
startOverride = (key: string, kind: 'plain' | 'secret' = 'plain'): void => {
  this.editingOverrideKey.set(key);
  this.editingOverrideKind.set(kind);
  this.secretPickerKey.set(null);
};
```

Extend `commitOverride` to route to `valueSecret` when `kind === 'secret'`:

```ts
const isSecret = this.editingOverrideKind() === 'secret';
this.editingOverrideKind.set(null);
if (v === '') {
  await rpc({ kind: 'request:overrides:delete', requestId: id, key });
} else if (isSecret) {
  await rpc({ kind: 'request:overrides:set', requestId: id, key, valueSecret: v });
} else {
  await rpc({ kind: 'request:overrides:set', requestId: id, key, valuePlain: v });
}
```

When `editingOverrideKey === key` and the row was originally secret, render the input with `type="password"`:

```ts
<ml-input class="override-value" size="sm" type=${isSecret ? 'password' : 'text'} ...></ml-input>
```

- [ ] **Step 2: Manual smoke**

`npm run dev`, override a secret with both branches, confirm `request_var_overrides` row in the DB reflects the right shape (use `sqlite3` to peek if needed).

- [ ] **Step 3: Extend Playwright spec**

Add a case where the secret picker is clicked and the "plaintext" branch is exercised.

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/request-tab.ts tests-e2e/request-overrides.spec.ts
git commit -m "feat(overrides): secret-row picker for plaintext vs secret override"
```

---

## Task 12: UI — orphan overrides section + remove "+ Add variable"

**Files:**
- Modify: `src/ui/components/request-tab.ts`
- Test: extend the Playwright spec

- [ ] **Step 1: Render orphan overrides under the main table**

In `renderActiveEnvVarsSection`, after the main `<table>`, emit:

```ts
${orphans.length > 0
  ? html`<div style="margin-top:16px">
      <div style="font-size:0.85em;color:var(--hu-text-secondary);margin-bottom:4px">
        Overrides without a matching env var
      </div>
      <table class="env-vars-table">
        <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
        <tbody>
          ${orphans.map((o) => html`
            <tr data-orphan=${o.key}>
              <td style="font-family:monospace">${o.key}</td>
              <td>${o.isSecret ? html`<span style="color:var(--hu-text-muted)">[secret]</span>`
                              : o.valuePlain ?? ''}</td>
              <td>
                <ml-button variant="ghost" size="xs" @ml:click=${() => c.clearOverride(o.key)}>×</ml-button>
              </td>
            </tr>`)}
        </tbody>
      </table>
    </div>`
  : ''}
```

- [ ] **Step 2: Remove the "+ Add variable" affordance**

Delete the `renderEnvVarsTable` helper entirely if it still exists (the unified table replaced it). Delete the `addingVarForEnvId` signal and its `startAddVar` / `confirmAddVar` / `cancelAddVar` methods. Grep for references and remove dead code:

```bash
grep -n "addingVarForEnvId\|startAddVar\|confirmAddVar\|cancelAddVar\|renderEnvVarsTable" src/ui/components/request-tab.ts
```

- [ ] **Step 3: Extend Playwright spec**

Create an override against a key, then delete that key from the env via Manage Envs UI flow, then refocus the request — assert the "Overrides without a matching env var" section appears and clicking `×` removes the row.

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
npx playwright test tests-e2e/request-overrides.spec.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/request-tab.ts tests-e2e/request-overrides.spec.ts
git commit -m "feat(overrides): orphan section + remove inline add-variable affordance"
```

---

## Final pass

- [ ] **Step 1: Type check + full test run**

```bash
npm run typecheck
npx vitest run
npx playwright test
```

Expected: zero TS errors, all suites green.

- [ ] **Step 2: Manual smoke per the spec's §10 testing**

1. Import `examples/oneroster-v1p1.http`.
2. Open a request whose chain has `baseUrl`. Override it on this request with a different value. Send → confirm the override is used.
3. Export the collection to a new file. Re-import. Confirm the override survives as `# @override baseUrl …`.
4. Repeat with a secret-marked env var: confirm the exported file has `# @override:secret <key>` (no value) and re-imported rows show "[secret · needs value]" until set.

- [ ] **Step 3: Commit any stray fixes from the smoke**

```bash
git add -A
git commit -m "polish(overrides): smoke-test fixes"
```

---

**Plan complete. Saved to `docs/superpowers/plans/2026-05-18-request-var-overrides.md`.**
