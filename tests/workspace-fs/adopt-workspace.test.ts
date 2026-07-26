import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '@storage/db';
import { Repos } from '@storage/repos';
import { adoptWorkspace } from '@workspace-fs/adopt';
import { serializeEnvFile } from '@workspace-fs/env-file';

let db: Db;
let dir: string;

beforeEach(() => {
  db = openDb(':memory:');
  dir = mkdtempSync(join(tmpdir(), 'adopt-ws-test-'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('adoptWorkspace', () => {
  it('mirrors a flat workspace folder: one directory (root) + one collection per .http', () => {
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    writeFileSync(join(dir, 'auth.http'), '### Token\nPOST https://x.test/token\n');
    writeFileSync(join(dir, 'users.http'), '### List\nGET https://x.test/users\n');

    const r = adoptWorkspace(db, w.id, dir);

    expect(r.collectionsAdopted).toBe(2);
    expect(r.warnings).toEqual([]);
    const cols = Repos.Collections.listByWorkspace(db, w.id);
    expect(cols.map((c) => c.name).sort()).toEqual(['Auth', 'Users']);
    const root = Repos.Directories.getRoot(db, w.id)!;
    for (const c of cols) {
      expect(c.directoryId).toBe(root.id);
    }
  });

  it('walks subdirectories and creates a directory row per folder on disk', () => {
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    mkdirSync(join(dir, 'one-roster'));
    writeFileSync(join(dir, 'one-roster', 'auth.http'), '### Token\nPOST https://x/token\n');
    writeFileSync(join(dir, 'one-roster', 'v1p1.http'), '### List\nGET https://x/v1p1\n');
    writeFileSync(join(dir, 'one-roster', 'v1p2.http'), '### List\nGET https://x/v1p2\n');

    const r = adoptWorkspace(db, w.id, dir);

    expect(r.collectionsAdopted).toBe(3);
    expect(r.directoriesCreated).toBe(2); // root + one-roster
    const oneRosterDir = Repos.Directories.findByPath(db, w.id, 'one-roster')!;
    expect(oneRosterDir).toBeDefined();
    const cols = Repos.Collections.listByDirectory(db, oneRosterDir.id);
    expect(cols.map((c) => c.name).sort()).toEqual(['Auth', 'V1p1', 'V1p2']);
  });

  it('adopts .env.json as a directory-scoped env at the directory it lives in', () => {
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    mkdirSync(join(dir, 'one-roster'));
    writeFileSync(join(dir, 'one-roster', 'v1p1.http'), '### x\nGET https://x/\n');
    writeFileSync(
      join(dir, 'one-roster', 'ci.env.json'),
      serializeEnvFile({
        name: 'ci',
        vars: [{ key: 'baseUrl', valuePlain: 'https://ci.test' }],
      }),
    );

    const r = adoptWorkspace(db, w.id, dir);

    expect(r.envsAdopted).toBe(1);
    const oneRosterDir = Repos.Directories.findByPath(db, w.id, 'one-roster')!;
    const envs = Repos.Envs.listByDirectory(db, oneRosterDir.id);
    expect(envs.map((e) => e.name)).toEqual(['ci']);
    const vars = Repos.Vars.listByEnv(db, envs[0]!.id);
    expect(vars).toHaveLength(1);
    expect(vars[0]?.key).toBe('baseUrl');
  });

  it('skips hidden directories and node_modules', () => {
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    mkdirSync(join(dir, '.hidden'));
    writeFileSync(join(dir, '.hidden', 'shh.http'), '### x\nGET https://x/\n');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'leak.http'), '### x\nGET https://x/\n');
    writeFileSync(join(dir, 'visible.http'), '### x\nGET https://x/\n');

    const r = adoptWorkspace(db, w.id, dir);

    expect(r.collectionsAdopted).toBe(1);
    const cols = Repos.Collections.listByWorkspace(db, w.id);
    expect(cols.map((c) => c.name)).toEqual(['Visible']);
  });

  it('directory env vars cascade into a collection request in a sub-directory', () => {
    // Reproduces the user-facing promise: an .env.json in /one-roster/
    // is visible from a request inside /one-roster/v1p1.http.
    const w = Repos.Workspaces.create(db, { name: 'ws' });
    mkdirSync(join(dir, 'one-roster'));
    writeFileSync(
      join(dir, 'one-roster', 'v1p1.http'),
      '### List\nGET {{baseUrl}}/users\n',
    );
    writeFileSync(
      join(dir, 'one-roster', 'ci.env.json'),
      serializeEnvFile({
        name: 'ci',
        vars: [{ key: 'baseUrl', valuePlain: 'https://ci.test' }],
      }),
    );

    adoptWorkspace(db, w.id, dir);

    const oneRosterDir = Repos.Directories.findByPath(db, w.id, 'one-roster')!;
    const envs = Repos.Envs.listByDirectory(db, oneRosterDir.id);
    Repos.Envs.setActive(db, envs[0]!.id);

    const col = Repos.Collections.listByDirectory(db, oneRosterDir.id)[0]!;
    const req = Repos.Requests.listByCollection(db, col.id)[0]!;
    const chain = Repos.Envs.listForRequest(db, req.id);
    // Directory env appears in the cascade with an active env attached.
    const dirStep = chain.find((s) => s.scopeKind === 'directory' && s.scopeId === oneRosterDir.id);
    expect(dirStep?.env?.name).toBe('ci');
  });
});
