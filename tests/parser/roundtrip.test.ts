import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHttpFile } from '@parser/parse';
import { serializeHttpFile } from '@parser/serialize';
import type { ParsedFile } from '@parser/types';

const fix = (n: string) => readFileSync(resolve(__dirname, '../../examples', n), 'utf8');

describe('roundtrip', () => {
  it('serializes a parsed file back to identical text (oneroster v1p1)', () => {
    const text = fix('One Roster/v1p1.http');
    const out = serializeHttpFile(parseHttpFile(text), text);
    expect(out).toBe(text);
  });

  it('serializes a parsed file back to identical text (oneroster v1p2)', () => {
    const text = fix('One Roster/v1p2.http');
    const out = serializeHttpFile(parseHttpFile(text), text);
    expect(out).toBe(text);
  });

  it('canonical emit produces a round-trippable file from scratch', () => {
    const original: ParsedFile = {
      variables: [{ name: 'a', value: '1', line: 1 }],
      requests: [
        {
          title: 'hello',
          method: 'GET',
          url: 'https://x.test/',
          headers: [{ key: 'X-K', value: 'v' }],
          hints: {},
          range: { startLine: 1, endLine: 1 },
        },
      ],
    };
    const out = serializeHttpFile(original);
    const reparsed = parseHttpFile(out);
    expect(reparsed.variables[0]).toMatchObject({ name: 'a', value: '1' });
    expect(reparsed.requests).toHaveLength(1);
    expect(reparsed.requests[0]!.method).toBe('GET');
    expect(reparsed.requests[0]!.url).toBe('https://x.test/');
  });
});
