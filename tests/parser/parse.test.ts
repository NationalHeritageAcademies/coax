import { describe, it, expect } from 'vitest';
import { parseHttpFile } from '@parser/parse';

describe('parseHttpFile', () => {
  it('extracts top-level variables', () => {
    const r = parseHttpFile('@a = 1\n@b = two words\n');
    expect(r.variables).toEqual([
      { name: 'a', value: '1', line: 1 },
      { name: 'b', value: 'two words', line: 2 },
    ]);
    expect(r.requests).toHaveLength(0);
  });

  it('parses a single request with headers and body', () => {
    const src = [
      '### Hello',
      'POST https://x.test/echo',
      'Content-Type: application/json',
      '',
      '{"a": 1}',
      '',
    ].join('\n');
    const r = parseHttpFile(src);
    expect(r.requests).toHaveLength(1);
    const req = r.requests[0]!;
    expect(req.title).toBe('Hello');
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://x.test/echo');
    expect(req.headers).toEqual([{ key: 'Content-Type', value: 'application/json' }]);
    expect(req.body?.kind).toBe('json');
    expect(req.body?.raw).toBe('{"a": 1}');
  });

  it('captures # @name and # @graphql hints', () => {
    const r = parseHttpFile('### t\n# @name getThing\n# @graphql\nPOST https://g.test\nContent-Type: application/json\n\n{"query":"{x}"}\n');
    expect(r.requests[0]!.name).toBe('getThing');
    expect(r.requests[0]!.hints.graphql).toBe(true);
    expect(r.requests[0]!.body?.kind).toBe('graphql');
  });

  it('captures file body hint', () => {
    const r = parseHttpFile('### up\nPOST https://x.test\nContent-Type: application/octet-stream\n\n< ./payload.bin\n');
    expect(r.requests[0]!.hints.file).toBe('./payload.bin');
  });

  it('records range covering each request', () => {
    const r = parseHttpFile('### a\nGET https://x.test/a\n\n### b\nGET https://x.test/b\n');
    expect(r.requests[0]!.range.startLine).toBe(1);
    expect(r.requests[1]!.range.startLine).toBe(4);
  });

  it('handles a file with no separators (single implicit request)', () => {
    const r = parseHttpFile('GET https://x.test/users\n');
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]!.title).toBe('');
  });

  it('infers body kind from content-type', () => {
    const json = parseHttpFile('### t\nPOST https://x.test\nContent-Type: application/json\n\n{}\n');
    expect(json.requests[0]!.body?.kind).toBe('json');
    const form = parseHttpFile('### t\nPOST https://x.test\nContent-Type: application/x-www-form-urlencoded\n\na=1&b=2\n');
    expect(form.requests[0]!.body?.kind).toBe('form');
    const text = parseHttpFile('### t\nPOST https://x.test\nContent-Type: text/plain\n\nhello\n');
    expect(text.requests[0]!.body?.kind).toBe('text');
  });

  it('parses multipart body into parts', () => {
    const src = [
      '### upload',
      'POST https://x.test/u',
      'Content-Type: multipart/form-data; boundary=BOUNDARY',
      '',
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
    ].join('\n');
    const r = parseHttpFile(src);
    const body = r.requests[0]!.body;
    expect(body?.kind).toBe('multipart');
    expect(body?.parts).toHaveLength(2);
    expect(body?.parts?.[1]!.filename).toBe('a.txt');
  });
});
