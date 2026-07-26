import { describe, it, expect } from 'vitest';
import { toCurl } from '../../src/ui/components/curl.js';

describe('toCurl', () => {
  it('emits a GET with no body', () => {
    expect(toCurl({ method: 'GET', url: 'https://x.test/users', headers: [] })).toBe(
      `curl -X GET 'https://x.test/users'`
    );
  });

  it('emits headers on subsequent lines', () => {
    const out = toCurl({
      method: 'GET',
      url: 'https://x.test',
      headers: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Tag', value: '1' }],
    });
    expect(out).toContain(`-H 'Accept: application/json'`);
    expect(out).toContain(`-H 'X-Tag: 1'`);
    expect(out.split('\n').length).toBe(3);
  });

  it('includes --data for POST with JSON body', () => {
    const out = toCurl({
      method: 'POST',
      url: 'https://x.test',
      headers: [{ key: 'Content-Type', value: 'application/json' }],
      body: { kind: 'json', raw: '{"a":1}' },
    });
    expect(out).toContain(`--data '{"a":1}'`);
  });

  it('masks values for header keys in maskHeaderKeys', () => {
    const out = toCurl(
      { method: 'GET', url: 'https://x.test', headers: [{ key: 'Authorization', value: 'Bearer abc' }] },
      new Set(['authorization']),
    );
    expect(out).toContain(`-H 'Authorization: ••••'`);
    expect(out).not.toContain('abc');
  });

  it('shell-escapes single quotes inside values', () => {
    const out = toCurl({
      method: 'POST', url: 'https://x.test',
      headers: [], body: { kind: 'text', raw: `it's a body` },
    });
    expect(out).toContain(`'it'\\''s a body'`);
  });

  it('uppercases the method', () => {
    expect(toCurl({ method: 'post', url: 'https://x', headers: [] })).toContain('curl -X POST');
  });

  it('omits --data when body is missing or empty', () => {
    expect(toCurl({ method: 'GET', url: 'https://x', headers: [] })).not.toContain('--data');
    expect(toCurl({ method: 'POST', url: 'https://x', headers: [], body: { kind: 'text', raw: '' } })).not.toContain('--data');
  });
});
