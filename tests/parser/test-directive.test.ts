import { describe, expect, it } from 'vitest';
import { parseHttpFile } from '@parser/parse.js';
import { serializeHttpFile } from '@parser/serialize.js';

describe('@test directive', () => {
  it('collects inline @test lines into ParsedRequest.tests', () => {
    const src = [
      '### Get user',
      '# @name getUser',
      '# @test status == 200',
      '# @test $.user.email exists',
      '# @test $.user.id == 42',
      'GET https://example.test/users/42',
      '',
    ].join('\n');

    const parsed = parseHttpFile(src);
    expect(parsed.requests).toHaveLength(1);
    expect(parsed.requests[0]!.tests).toEqual([
      'status == 200',
      '$.user.email exists',
      '$.user.id == 42',
    ]);
  });

  it('omits the tests field when no @test directives are present', () => {
    const src = ['### Plain', 'GET https://example.test/', ''].join('\n');
    const parsed = parseHttpFile(src);
    expect(parsed.requests[0]!.tests).toBeUndefined();
  });

  it('round-trips @test directives through canonical serialize', () => {
    const src = [
      '### Get user',
      '# @name getUser',
      '# @test status == 200',
      '# @test $.user.id == 42',
      'GET https://example.test/users/42',
      '',
    ].join('\n');
    const parsed = parseHttpFile(src);
    const out = serializeHttpFile(parsed);
    expect(out).toContain('# @test status == 200');
    expect(out).toContain('# @test $.user.id == 42');
  });
});
