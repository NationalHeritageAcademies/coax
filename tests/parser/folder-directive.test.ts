import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '@parser/parse';
import { serializeHttpFile } from '@parser/serialize';
import type { ParsedFile } from '@parser/types';

// Under the directories model the renderer treats on-disk folders as the
// only folder concept. `# @folder` directives are still PARSED for
// backward compatibility with files written by earlier Coax versions and
// hand-edited files — they surface as `folderPath` on the parsed request
// — but the serializer no longer EMITS them. On the next flush they
// silently disappear from the file.

describe('# @folder directive', () => {
  it('parses an @folder directive on a request block', () => {
    const file = parseHttpFile(
      `### Get users
# @folder /users
GET https://x.test/users
`,
    );
    expect(file.requests[0]!.folderPath).toBe('/users');
  });

  it('parses nested paths', () => {
    const file = parseHttpFile(
      `### Get assessment
# @folder /assessment/grades
GET https://x.test/assessment/grades
`,
    );
    expect(file.requests[0]!.folderPath).toBe('/assessment/grades');
  });

  it('parses @id, @folder, and @name together (any order, all preserved on parse)', () => {
    const file = parseHttpFile(
      `### Login
# @id req-login
# @folder /auth
# @name login
POST https://x.test/auth
`,
    );
    expect(file.requests[0]!.id).toBe('req-login');
    expect(file.requests[0]!.folderPath).toBe('/auth');
    expect(file.requests[0]!.name).toBe('login');
  });

  it('tolerates files without @folder (treated as root)', () => {
    const file = parseHttpFile(
      `### Plain
GET https://x.test/
`,
    );
    expect(file.requests[0]!.folderPath).toBeUndefined();
  });

  it('serializer drops @folder even when folderPath is set on the parsed request', () => {
    const parsed: ParsedFile = {
      variables: [],
      requests: [
        {
          folderPath: '/users',
          title: 'List users',
          method: 'GET',
          url: 'https://x.test/users',
          headers: [],
          hints: {},
          range: { startLine: 1, endLine: 1 },
        },
      ],
    };
    const out = serializeHttpFile(parsed);
    expect(out).not.toContain('@folder');
  });

  it('serializer omits @folder when undefined', () => {
    const parsed: ParsedFile = {
      variables: [],
      requests: [
        {
          title: 'No folder set',
          method: 'GET',
          url: 'https://x.test/',
          headers: [],
          hints: {},
          range: { startLine: 1, endLine: 1 },
        },
      ],
    };
    const out = serializeHttpFile(parsed);
    expect(out).not.toContain('@folder');
  });

  it('parse → serialize → parse drops the directive (no longer round-trips)', () => {
    const source = `### Get assessment
# @id abc-123
# @folder /assessment/grades
GET https://x.test/grades
`;
    const parsedOnce = parseHttpFile(source);
    const reEmitted = serializeHttpFile(parsedOnce);
    const parsedAgain = parseHttpFile(reEmitted);
    expect(parsedAgain.requests[0]!.folderPath).toBeUndefined();
    expect(parsedAgain.requests[0]!.id).toBe('abc-123');
  });

  it('@id emits before @name (predictable diff order)', () => {
    const parsed: ParsedFile = {
      variables: [],
      requests: [
        {
          id: 'req-1',
          name: 'login',
          title: 'Login',
          method: 'POST',
          url: 'https://x.test/auth',
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
