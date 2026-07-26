import { JSONPath } from 'jsonpath-plus';
import type { ResolverContext, ResolveResult } from './types.js';

const TOKEN = /\{\{\s*([^}]+?)\s*\}\}/g;

export function resolve(input: string, ctx: ResolverContext): ResolveResult {
  const unresolved = new Set<string>();
  const text = input.replace(TOKEN, (whole: string, expr: string) => {
    const key = expr.trim();
    const value = lookup(key, ctx);
    if (value === undefined) {
      unresolved.add(key);
      return whole;
    }
    return value;
  });
  return { text, unresolved: [...unresolved] };
}

function lookup(expr: string, ctx: ResolverContext): string | undefined {
  if (expr.startsWith('$')) return builtin(expr, ctx);
  if (expr.includes('.response.')) return chain(expr, ctx);
  const s = ctx.scopes;
  return s.request?.[expr] ?? s.chainFlat?.[expr] ?? s.collectionDefaults?.[expr];
}

function builtin(expr: string, ctx: ResolverContext): string | undefined {
  const now = ctx.now?.() ?? new Date();
  const rand = ctx.random ?? Math.random;
  if (expr === '$timestamp') return String(Math.floor(now.getTime() / 1000));
  if (expr === '$isoTimestamp') return now.toISOString();
  if (expr === '$guid') return guid(rand);
  const m = /^\$randomInt\s+(-?\d+)\s+(-?\d+)$/.exec(expr);
  if (m) {
    const lo = Number(m[1]!);
    const hi = Number(m[2]!);
    return String(Math.floor(rand() * (hi - lo)) + lo);
  }
  return undefined;
}

function guid(rand: () => number): string {
  const hex = (n: number): string =>
    Math.floor(rand() * 16 ** n)
      .toString(16)
      .padStart(n, '0');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(rand() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}

function chain(expr: string, ctx: ResolverContext): string | undefined {
  const m = /^([A-Za-z_]\w*)\.response\.(body|headers)\.(.+)$/.exec(expr);
  if (!m) return undefined;
  const name = m[1]!;
  const kind = m[2]!;
  const rest = m[3]!;
  const r = ctx.responses?.[name];
  if (!r) return undefined;
  if (kind === 'headers') return r.headers[rest.toLowerCase()];
  const path = rest.startsWith('$') ? rest : `$.${rest}`;
  const json = r.body as string | number | boolean | object | unknown[] | null;
  const result: unknown = JSONPath({ path, json, wrap: false });
  if (result === undefined || result === null) return undefined;
  return typeof result === 'string' ? result : JSON.stringify(result);
}
