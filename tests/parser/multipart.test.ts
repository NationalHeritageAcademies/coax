import { describe, it, expect } from 'vitest';
import { splitMultipart, boundaryFromContentType } from '@parser/multipart';

describe('splitMultipart', () => {
  it('splits a body on the boundary', () => {
    const body = [
      '--BOUNDARY',
      'Content-Disposition: form-data; name="field1"',
      '',
      'value1',
      '--BOUNDARY',
      'Content-Disposition: form-data; name="file"; filename="a.txt"',
      'Content-Type: text/plain',
      '',
      'hello',
      '--BOUNDARY--',
    ].join('\r\n');
    const parts = splitMultipart(body, 'BOUNDARY');
    expect(parts).toHaveLength(2);
    expect(parts[0]!.headers).toEqual([{ key: 'Content-Disposition', value: 'form-data; name="field1"' }]);
    expect(parts[0]!.body).toBe('value1');
    expect(parts[1]!.filename).toBe('a.txt');
    expect(parts[1]!.body).toBe('hello');
  });

  it('returns [] when boundary is missing', () => {
    expect(splitMultipart('no boundaries here', 'X')).toEqual([]);
  });
});

describe('boundaryFromContentType', () => {
  it('extracts an unquoted boundary', () => {
    expect(boundaryFromContentType('multipart/form-data; boundary=abc123')).toBe('abc123');
  });
  it('extracts a quoted boundary', () => {
    expect(boundaryFromContentType('multipart/form-data; boundary="my-boundary"')).toBe('my-boundary');
  });
  it('returns undefined when missing', () => {
    expect(boundaryFromContentType('multipart/form-data')).toBeUndefined();
    expect(boundaryFromContentType(undefined)).toBeUndefined();
  });
});
