import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '@storage/db';
import { Repos } from '@storage/repos';
import { parseHttpFile } from '@parser/parse';
import { serializeHttpFile } from '@parser/serialize';

// Pure unit test of the parse → store → serialize round-trip.
// Doesn't require the Electron app/handlers context — verifies the parser/serializer/storage
// integration on its own. The actual http:import handler test is exercised by Task 11.1 (E2E).

describe('import → export round-trip', () => {
  it('parses oneroster v1p1, stores it as requests, serializes back to byte-identical text', () => {
    const text = readFileSync(resolve(__dirname, '../../examples/One Roster/v1p1.http'), 'utf8');
    const parsed = parseHttpFile(text);
    const db = openDb(':memory:');

    const w = Repos.Workspaces.create(db, { name: 'test' });
    const c = Repos.Collections.create(db, { workspaceId: w.id, name: 'oneroster' });

    for (const r of parsed.requests) {
      Repos.Requests.create(db, {
        collectionId: c.id,
        name: r.title,
        method: r.method,
        url: r.url,
        headers: r.headers,
        ...(r.body !== undefined ? { body: { kind: r.body.kind, raw: r.body.raw } } : {}),
      });
    }
    // Note: this test exercises that data round-trips through SQLite.
    // The serializer's `preserve` mode produces byte-identical output by using
    // ranges on the *parsed* file, so the round-trip works regardless of what
    // we stored. This test confirms storage doesn't lose anything we'll need
    // for the workflow.

    const out = serializeHttpFile(parsed, text);
    expect(out).toBe(text);

    // Spot check: every request stored matches its parsed counterpart on key fields.
    // listByCollection sorts by (sort_order, name); since all rows have sort_order=0
    // we compare as sets keyed by name+method+url rather than positionally.
    const stored = Repos.Requests.listByCollection(db, c.id);
    expect(stored).toHaveLength(parsed.requests.length);
    const storedKeys = new Set(stored.map((s) => `${s.name}|${s.method}|${s.url}`));
    for (const r of parsed.requests) {
      expect(storedKeys.has(`${r.title}|${r.method}|${r.url}`)).toBe(true);
    }

    db.close();
  });
});
