import { describe, expect, it } from 'vitest';
import { parseAssertion } from '@assertions/grammar.js';
import { evaluate } from '@assertions/evaluate.js';
import type { Assertion, AssertionEvalContext } from '@assertions/types.js';

function compile(raw: string): Assertion {
  const a = parseAssertion(raw);
  if ('kind' in a && a.kind === 'parse-error') throw new Error(`parse failed: ${a.message}`);
  return a as Assertion;
}

const baseCtx: AssertionEvalContext = {
  status: 200,
  responseTime: 187,
  headers: { 'content-type': 'application/json', 'x-trace-id': 'abc' },
  body: { user: { id: 42, email: 'rick@example.test', active: true, nickname: null } },
};

describe('assertion evaluator', () => {
  it('status equality passes and fails', () => {
    expect(evaluate(compile('status == 200'), baseCtx).ok).toBe(true);
    expect(evaluate(compile('status == 404'), baseCtx).ok).toBe(false);
  });

  it('status numeric comparison', () => {
    expect(evaluate(compile('status < 300'), baseCtx).ok).toBe(true);
    expect(evaluate(compile('status >= 400'), baseCtx).ok).toBe(false);
  });

  it('responseTime comparison', () => {
    expect(evaluate(compile('responseTime < 500'), baseCtx).ok).toBe(true);
    expect(evaluate(compile('responseTime <= 187'), baseCtx).ok).toBe(true);
    expect(evaluate(compile('responseTime < 100'), baseCtx).ok).toBe(false);
  });

  it('header equality (case-insensitive name lookup)', () => {
    expect(evaluate(compile('headers.content-type == "application/json"'), baseCtx).ok).toBe(true);
    expect(evaluate(compile('headers.x-missing == "anything"'), baseCtx).ok).toBe(false);
  });

  it('header contains', () => {
    expect(evaluate(compile('headers.content-type contains "json"'), baseCtx).ok).toBe(true);
    expect(evaluate(compile('headers.content-type contains "xml"'), baseCtx).ok).toBe(false);
  });

  it('JSONPath equality with type coercion', () => {
    expect(evaluate(compile('$.user.id == 42'), baseCtx).ok).toBe(true);
    expect(evaluate(compile('$.user.id == "42"'), baseCtx).ok).toBe(true);
    expect(evaluate(compile('$.user.email == "rick@example.test"'), baseCtx).ok).toBe(true);
    expect(evaluate(compile('$.user.active == true'), baseCtx).ok).toBe(true);
  });

  it('exists: missing path fails, present non-null passes', () => {
    expect(evaluate(compile('$.user.email exists'), baseCtx).ok).toBe(true);
    expect(evaluate(compile('$.user.missing exists'), baseCtx).ok).toBe(false);
  });

  it('exists: null value fails (treats null as not-existing)', () => {
    expect(evaluate(compile('$.user.nickname exists'), baseCtx).ok).toBe(false);
  });

  it('!= passes when values differ', () => {
    expect(evaluate(compile('$.user.id != 99'), baseCtx).ok).toBe(true);
    expect(evaluate(compile('$.user.id != 42'), baseCtx).ok).toBe(false);
  });

  it('numeric op on non-numeric value fails cleanly', () => {
    const result = evaluate(compile('$.user.email < 500'), baseCtx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('cannot compare');
  });

  it('actual value is surfaced in failed results for diagnostics', () => {
    const result = evaluate(compile('status == 500'), baseCtx);
    expect(result.actual).toBe(200);
  });
});
