import { describe, it, expect } from 'vitest';
import { lex } from '@parser/lexer';

describe('lex', () => {
  it('classifies separator lines', () => {
    expect(lex('### Get all users')[0]).toEqual({ kind: 'separator', title: 'Get all users', lineNo: 1 });
  });
  it('classifies variable definitions', () => {
    expect(lex('@baseUrl = https://x.test')[0]).toMatchObject({ kind: 'variable', name: 'baseUrl', value: 'https://x.test' });
  });
  it('classifies # @name hint', () => {
    expect(lex('# @name getToken')[0]).toEqual({ kind: 'name', name: 'getToken', lineNo: 1 });
  });
  it('classifies # @graphql hint', () => {
    expect(lex('# @graphql')[0]).toEqual({ kind: 'graphql', lineNo: 1 });
  });
  it('classifies file body marker', () => {
    expect(lex('< ./body.json')[0]).toEqual({ kind: 'fileBody', path: './body.json', lineNo: 1 });
  });
  it('classifies request line with method and url', () => {
    expect(lex('GET https://x.test/users')[0]).toMatchObject({ kind: 'request', method: 'GET', url: 'https://x.test/users' });
  });
  it('classifies header lines', () => {
    expect(lex('Content-Type: application/json')[0]).toEqual({ kind: 'header', key: 'Content-Type', value: 'application/json', lineNo: 1 });
  });
  it('classifies comment, blank, and text lines', () => {
    const lines = lex('# a comment\n\nhello');
    expect(lines[0]!.kind).toBe('comment');
    expect(lines[1]!.kind).toBe('blank');
    expect(lines[2]!.kind).toBe('text');
  });

  it('classifies ### Title as separator (not comment)', () => {
    expect(lex('### Title')[0]!.kind).toBe('separator');
  });

  it('classifies # @name x as name (not comment)', () => {
    expect(lex('# @name foo')[0]!.kind).toBe('name');
  });

  it('handles bare ### with no title (empty title)', () => {
    expect(lex('###')[0]).toMatchObject({ kind: 'separator', title: '' });
  });

  it('classifies lowercase methods as text (uppercase only)', () => {
    expect(lex('get https://x.test/users')[0]!.kind).toBe('text');
  });

  it('handles CR-only line endings without leaking \\r', () => {
    const lines = lex('Content-Type: application/json\rfoo');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: 'header', key: 'Content-Type', value: 'application/json' });
  });
});
