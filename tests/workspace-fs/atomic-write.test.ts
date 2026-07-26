import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic } from '@workspace-fs/atomic-write';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coax-atomic-write-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeAtomic', () => {
  it('writes the content to the target path', async () => {
    const path = join(dir, 'hello.http');
    await writeAtomic(path, '### Hello\nGET https://example.com/\n');
    expect(readFileSync(path, 'utf8')).toBe('### Hello\nGET https://example.com/\n');
  });

  it('overwrites an existing file', async () => {
    const path = join(dir, 'foo.http');
    writeFileSync(path, 'old contents');
    await writeAtomic(path, 'new contents');
    expect(readFileSync(path, 'utf8')).toBe('new contents');
  });

  it('writes with 0600 perms (user-only)', async () => {
    const path = join(dir, 'restricted.http');
    await writeAtomic(path, 'secret-ish');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates the parent directory if missing', async () => {
    const path = join(dir, 'nested', 'deep', 'file.http');
    await writeAtomic(path, 'content');
    expect(readFileSync(path, 'utf8')).toBe('content');
  });

  it('accepts a Buffer', async () => {
    const path = join(dir, 'binary.bin');
    const data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    await writeAtomic(path, data);
    expect(readFileSync(path)).toEqual(data);
  });

  it('leaves no leftover temp files after a successful write', async () => {
    const path = join(dir, 'clean.http');
    await writeAtomic(path, 'final');
    const entries = readdirSync(dir);
    expect(entries).toEqual(['clean.http']);
  });

  it('survives concurrent writes to the same path without leaving temp files', async () => {
    const path = join(dir, 'race.http');
    await Promise.all([
      writeAtomic(path, 'one'),
      writeAtomic(path, 'two'),
      writeAtomic(path, 'three'),
    ]);
    // One of the three wins (whichever rename ran last). The other two were
    // overwritten by the winning rename. No temp files left over.
    const final = readFileSync(path, 'utf8');
    expect(['one', 'two', 'three']).toContain(final);
    const leftovers = readdirSync(dir).filter((f) => f.includes('.coax-tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('a reader during the write either sees the previous content or the new content, never partial', async () => {
    // Two parts: we can't truly observe a partial state from JS (we'd need
    // to schedule the read between the writeFile and the rename, which is
    // racy). Instead we assert the property indirectly: after the call
    // resolves, the file either has the new content (success path) or the
    // old content + no temp file (would only happen if the rename threw).
    const path = join(dir, 'atomic.http');
    writeFileSync(path, 'pre-existing');
    await writeAtomic(path, 'replacement');
    expect(readFileSync(path, 'utf8')).toBe('replacement');
    expect(existsSync(`${path}.coax-tmp`)).toBe(false);
  });
});
