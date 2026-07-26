import { describe, it, expect } from 'vitest';
import { parseHttpFile } from '@parser/parse';
import { serializeHttpFile } from '@parser/serialize';

describe('# @override directive', () => {
  it('parses a plaintext override', () => {
    const file = parseHttpFile(
      `### Get users
# @override apiBase https://staging.example.com
GET {{apiBase}}/users
`,
    );
    expect(file.requests[0]!.overrides).toEqual([
      { key: 'apiBase', value: 'https://staging.example.com', isSecret: false },
    ]);
  });

  it('parses a value containing spaces', () => {
    const file = parseHttpFile(
      `### A
# @override label  hello world  with  spaces
GET https://x.example
`,
    );
    expect(file.requests[0]!.overrides).toEqual([
      { key: 'label', value: 'hello world  with  spaces', isSecret: false },
    ]);
  });

  it('parses a secret override (no value)', () => {
    const file = parseHttpFile(
      `### Get users
# @override:secret apiKey
GET https://x.example/users
`,
    );
    expect(file.requests[0]!.overrides).toEqual([{ key: 'apiKey', isSecret: true }]);
  });

  it('does not pull @override lines from earlier blocks', () => {
    const file = parseHttpFile(
      `### A
# @override foo bar
GET https://a.example

### B
GET https://b.example
`,
    );
    expect(file.requests[0]!.overrides).toEqual([
      { key: 'foo', value: 'bar', isSecret: false },
    ]);
    expect(file.requests[1]!.overrides ?? []).toEqual([]);
  });

  it('omits `overrides` when there are none', () => {
    const file = parseHttpFile(`### A
GET https://a.example
`);
    expect(file.requests[0]!.overrides).toBeUndefined();
  });

  it('round-trips overrides through parse -> serialize -> parse (canonical)', () => {
    const src = `### Demo
# @override apiBase https://staging.example.com
# @override:secret apiKey
GET {{apiBase}}/x
Authorization: Bearer {{apiKey}}
`;
    const a = parseHttpFile(src);
    const out = serializeHttpFile(a);
    expect(out).toMatch(/# @override apiBase https:\/\/staging\.example\.com/);
    expect(out).toMatch(/# @override:secret apiKey/);
    const b = parseHttpFile(out);
    expect(b.requests[0]!.overrides).toEqual([
      { key: 'apiBase', value: 'https://staging.example.com', isSecret: false },
      { key: 'apiKey', isSecret: true },
    ]);
  });
});
