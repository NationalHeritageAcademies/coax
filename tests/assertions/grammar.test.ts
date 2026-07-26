import { describe, expect, it } from 'vitest';
import { parseAssertion } from '@assertions/grammar.js';

describe('assertion grammar', () => {
  it('parses status equality', () => {
    expect(parseAssertion('status == 200')).toEqual({
      raw: 'status == 200',
      left: { kind: 'status' },
      op: '==',
      right: 200,
    });
  });

  it('parses status inequality', () => {
    expect(parseAssertion('status != 404')).toMatchObject({
      left: { kind: 'status' },
      op: '!=',
      right: 404,
    });
  });

  it('parses numeric comparison with responseTime', () => {
    expect(parseAssertion('responseTime < 500')).toMatchObject({
      left: { kind: 'responseTime' },
      op: '<',
      right: 500,
    });
  });

  it('parses <= correctly without matching < first', () => {
    expect(parseAssertion('responseTime <= 1000')).toMatchObject({
      op: '<=',
      right: 1000,
    });
  });

  it('parses header equality with quoted string', () => {
    expect(parseAssertion('headers.content-type == "application/json"')).toMatchObject({
      left: { kind: 'header', name: 'content-type' },
      op: '==',
      right: 'application/json',
    });
  });

  it('lowercases header names', () => {
    const a = parseAssertion('headers.Content-Type == "json"');
    expect(a).toMatchObject({ left: { kind: 'header', name: 'content-type' } });
  });

  it('parses header contains', () => {
    expect(parseAssertion('headers.content-type contains "json"')).toMatchObject({
      op: 'contains',
      right: 'json',
    });
  });

  it('parses JSONPath equality', () => {
    expect(parseAssertion('$.user.id == 42')).toMatchObject({
      left: { kind: 'jsonpath', path: '$.user.id' },
      op: '==',
      right: 42,
    });
  });

  it('parses JSONPath exists with no right side', () => {
    expect(parseAssertion('$.user.email exists')).toEqual({
      raw: '$.user.email exists',
      left: { kind: 'jsonpath', path: '$.user.email' },
      op: 'exists',
    });
  });

  it('parses boolean literal', () => {
    expect(parseAssertion('$.active == true')).toMatchObject({ right: true });
    expect(parseAssertion('$.active == false')).toMatchObject({ right: false });
  });

  it('parses null literal', () => {
    expect(parseAssertion('$.deleted == null')).toMatchObject({ right: null });
  });

  it('returns ParseError on empty input', () => {
    expect(parseAssertion('')).toMatchObject({ kind: 'parse-error' });
  });

  it('returns ParseError when no operator is present', () => {
    expect(parseAssertion('status 200')).toMatchObject({ kind: 'parse-error' });
  });

  it('returns ParseError when exists has a right side', () => {
    expect(parseAssertion('$.x exists 5')).toMatchObject({ kind: 'parse-error' });
  });

  it('returns ParseError on unrecognized left side', () => {
    expect(parseAssertion('garbage == 1')).toMatchObject({ kind: 'parse-error' });
  });
});
