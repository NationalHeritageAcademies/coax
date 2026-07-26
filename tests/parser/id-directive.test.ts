import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '@parser/parse';
import { serializeHttpFile } from '@parser/serialize';
import type { ParsedFile } from '@parser/types';

describe('# @id directive', () => {
  it('parses an @id directive on a request block', () => {
    const file = parseHttpFile(
      `### Get users
# @id 9a1c8e6f-1234-4f6a-b8c0-abcdef012345
GET https://x.test/users
`,
    );
    expect(file.requests[0]!.id).toBe('9a1c8e6f-1234-4f6a-b8c0-abcdef012345');
  });

  it('parses both @id and @name when present (order-independent)', () => {
    const file = parseHttpFile(
      `### Login
# @id req-login
# @name login
POST https://x.test/auth
`,
    );
    expect(file.requests[0]!.id).toBe('req-login');
    expect(file.requests[0]!.name).toBe('login');
  });

  it('tolerates files without @id (older exports stay valid)', () => {
    const file = parseHttpFile(
      `### Plain
GET https://x.test/
`,
    );
    expect(file.requests[0]!.id).toBeUndefined();
  });

  it('serializer emits @id when present on the request', () => {
    const parsed: ParsedFile = {
      variables: [],
      requests: [
        {
          id: 'abc-123',
          title: 'hello',
          method: 'GET',
          url: 'https://x.test/',
          headers: [],
          hints: {},
          range: { startLine: 1, endLine: 1 },
        },
      ],
    };
    const out = serializeHttpFile(parsed);
    expect(out).toContain('# @id abc-123');
  });

  it('serializer omits @id when absent (no empty directive)', () => {
    const parsed: ParsedFile = {
      variables: [],
      requests: [
        {
          title: 'hello',
          method: 'GET',
          url: 'https://x.test/',
          headers: [],
          hints: {},
          range: { startLine: 1, endLine: 1 },
        },
      ],
    };
    const out = serializeHttpFile(parsed);
    expect(out).not.toContain('@id');
  });

  it('round-trips @id through parse → serialize → parse', () => {
    const source = `### Get users
# @id 9a1c8e6f-1234-4f6a-b8c0-abcdef012345
# @name listUsers
GET https://x.test/users
`;
    const parsedOnce = parseHttpFile(source);
    const reEmitted = serializeHttpFile(parsedOnce);
    const parsedAgain = parseHttpFile(reEmitted);
    expect(parsedAgain.requests[0]!.id).toBe('9a1c8e6f-1234-4f6a-b8c0-abcdef012345');
    expect(parsedAgain.requests[0]!.name).toBe('listUsers');
  });

  it('@id is emitted before @name (predictable diff order)', () => {
    const parsed: ParsedFile = {
      variables: [],
      requests: [
        {
          id: 'req-1',
          name: 'getUsers',
          title: 'Get users',
          method: 'GET',
          url: 'https://x.test/',
          headers: [],
          hints: {},
          range: { startLine: 1, endLine: 1 },
        },
      ],
    };
    const out = serializeHttpFile(parsed);
    const idIdx = out.indexOf('# @id');
    const nameIdx = out.indexOf('# @name');
    expect(idIdx).toBeGreaterThan(-1);
    expect(nameIdx).toBeGreaterThan(-1);
    expect(idIdx).toBeLessThan(nameIdx);
  });
});
