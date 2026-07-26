import type { Assertion, AssertionLeft, AssertionOp, AssertionValue } from './types.js';

const OPS: AssertionOp[] = ['<=', '>=', '==', '!=', '<', '>', 'contains', 'exists'];

export interface ParseError {
  kind: 'parse-error';
  message: string;
}

export function parseAssertion(raw: string): Assertion | ParseError {
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'parse-error', message: 'empty assertion' };

  // Find the operator. Look for the first occurrence of any operator,
  // preferring longer matches first (so `<=` beats `<`).
  let opIdx = -1;
  let op: AssertionOp | null = null;
  for (const candidate of OPS) {
    const idx = findOpIndex(trimmed, candidate);
    if (idx === -1) continue;
    if (opIdx === -1 || idx < opIdx) {
      opIdx = idx;
      op = candidate;
    } else if (idx === opIdx && candidate.length > op!.length) {
      op = candidate;
    }
  }
  if (op === null || opIdx === -1) {
    return { kind: 'parse-error', message: `no operator found in "${trimmed}"` };
  }

  const leftRaw = trimmed.slice(0, opIdx).trim();
  const rightRaw = trimmed.slice(opIdx + op.length).trim();

  if (leftRaw === '') return { kind: 'parse-error', message: 'left side is empty' };

  const left = parseLeft(leftRaw);
  if (left === null) return { kind: 'parse-error', message: `unrecognized left side "${leftRaw}"` };

  if (op === 'exists') {
    if (rightRaw !== '') return { kind: 'parse-error', message: '`exists` takes no right side' };
    return { raw: trimmed, left, op };
  }

  if (rightRaw === '') return { kind: 'parse-error', message: `right side is empty for "${op}"` };

  const right = parseValue(rightRaw);
  return { raw: trimmed, left, op, right };
}

function findOpIndex(s: string, op: AssertionOp): number {
  // For word operators (`contains`, `exists`), require whitespace boundaries.
  if (op === 'contains' || op === 'exists') {
    const rx = new RegExp(`(?:^|\\s)${op}(?=\\s|$)`);
    const m = rx.exec(s);
    if (!m) return -1;
    // m.index points to the leading whitespace or position 0; advance to the op.
    const trailing = m[0].length - op.length;
    return m.index + trailing;
  }
  return s.indexOf(op);
}

function parseLeft(raw: string): AssertionLeft | null {
  if (raw === 'status') return { kind: 'status' };
  if (raw === 'responseTime') return { kind: 'responseTime' };
  if (raw.startsWith('headers.')) {
    const name = raw.slice('headers.'.length).trim();
    if (name === '') return null;
    return { kind: 'header', name: name.toLowerCase() };
  }
  if (raw.startsWith('$')) return { kind: 'jsonpath', path: raw };
  return null;
}

function parseValue(raw: string): AssertionValue {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}
