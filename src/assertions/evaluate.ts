import { JSONPath } from 'jsonpath-plus';
import type {
  Assertion,
  AssertionEvalContext,
  AssertionLeft,
  AssertionResult,
  AssertionValue,
} from './types.js';

const NOT_FOUND = Symbol('NOT_FOUND');
type Found = AssertionValue | typeof NOT_FOUND;

export function evaluate(a: Assertion, ctx: AssertionEvalContext): AssertionResult {
  const actual = extract(a.left, ctx);

  if (a.op === 'exists') {
    if (actual === NOT_FOUND) {
      return { raw: a.raw, ok: false, error: 'value not found' };
    }
    if (actual === null || actual === undefined) {
      return { raw: a.raw, ok: false, error: 'value is null/undefined', actual: actual ?? null };
    }
    return { raw: a.raw, ok: true, actual };
  }

  if (actual === NOT_FOUND) {
    return { raw: a.raw, ok: false, error: 'value not found' };
  }

  const expected = a.right!;

  if (a.op === '==') return cmp(a.raw, actual, equal(actual, expected), actual);
  if (a.op === '!=') return cmp(a.raw, actual, !equal(actual, expected), actual);
  if (a.op === 'contains') {
    const ok = typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
    return cmp(a.raw, actual, ok, actual);
  }
  // numeric comparisons
  const an = toNumber(actual);
  const en = toNumber(expected);
  if (an === null || en === null) {
    return {
      raw: a.raw,
      ok: false,
      error: `cannot compare non-numeric values (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`,
      actual,
    };
  }
  let ok = false;
  if (a.op === '<') ok = an < en;
  else if (a.op === '<=') ok = an <= en;
  else if (a.op === '>') ok = an > en;
  else if (a.op === '>=') ok = an >= en;
  return cmp(a.raw, actual, ok, actual);
}

function cmp(raw: string, actual: AssertionValue, ok: boolean, snapshot: AssertionValue): AssertionResult {
  if (ok) return { raw, ok: true, actual: snapshot };
  return { raw, ok: false, actual, error: `assertion failed (actual=${JSON.stringify(actual)})` };
}

function extract(left: AssertionLeft, ctx: AssertionEvalContext): Found {
  if (left.kind === 'status') return ctx.status;
  if (left.kind === 'responseTime') return ctx.responseTime;
  if (left.kind === 'header') {
    const v = ctx.headers[left.name];
    return v === undefined ? NOT_FOUND : v;
  }
  // jsonpath — cast to the union jsonpath-plus accepts; the resolver does the same.
  const json = ctx.body as string | number | boolean | object | unknown[] | null;
  const result: unknown = JSONPath({ path: left.path, json, wrap: false });
  if (result === undefined) return NOT_FOUND;
  if (result === null) return null;
  if (typeof result === 'number' || typeof result === 'string' || typeof result === 'boolean') {
    return result;
  }
  return JSON.stringify(result);
}

function equal(a: AssertionValue, b: AssertionValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  // numeric coercion: "200" == 200
  if (typeof a !== typeof b) {
    const an = toNumber(a);
    const bn = toNumber(b);
    if (an !== null && bn !== null) return an === bn;
    return String(a) === String(b);
  }
  return false;
}

function toNumber(v: AssertionValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    if (!/^-?\d+(?:\.\d+)?$/.test(v)) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
