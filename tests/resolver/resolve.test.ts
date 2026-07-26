import { describe, it, expect } from 'vitest';
import { resolve } from '@resolver/resolve';

describe('resolve', () => {
  it('uses request > chain > defaults precedence', () => {
    const r = resolve('{{x}}', {
      scopes: { request: { x: 'R' }, chainFlat: { x: 'C' }, collectionDefaults: { x: 'D' } },
    });
    expect(r.text).toBe('R');
    expect(r.unresolved).toEqual([]);
  });
  it('falls through layers in order', () => {
    expect(resolve('{{x}}', { scopes: { chainFlat: { x: 'C' }, collectionDefaults: { x: 'D' } } }).text).toBe('C');
    expect(resolve('{{x}}', { scopes: { chainFlat: { x: 'C' } } }).text).toBe('C');
    expect(resolve('{{x}}', { scopes: { collectionDefaults: { x: 'D' } } }).text).toBe('D');
  });
  it('records unresolved references, leaves text intact', () => {
    const r = resolve('hello {{name}} and {{name}} and {{other}}', { scopes: {} });
    expect(r.text).toBe('hello {{name}} and {{name}} and {{other}}');
    expect(r.unresolved.sort()).toEqual(['name', 'other']);
  });
  it('handles built-ins $timestamp $isoTimestamp $guid $randomInt', () => {
    const fixed = new Date('2026-05-14T12:00:00Z');
    const ctx = { scopes: {}, now: () => fixed, random: () => 0.5 };
    expect(resolve('{{$timestamp}}', ctx).text).toBe(String(Math.floor(fixed.getTime() / 1000)));
    expect(resolve('{{$isoTimestamp}}', ctx).text).toBe(fixed.toISOString());
    expect(resolve('{{$randomInt 1 11}}', ctx).text).toBe('6'); // floor(0.5 * (11-1)) + 1
    expect(resolve('{{$guid}}', ctx).text).toMatch(/^[0-9a-f-]{36}$/);
  });
});
