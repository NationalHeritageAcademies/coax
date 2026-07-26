import { describe, it, expect } from 'vitest';
import { resolveBaseUrl } from '@importer/swagger';

describe('resolveBaseUrl', () => {
  it('returns an absolute candidate verbatim (strip trailing slash)', () => {
    expect(
      resolveBaseUrl({
        candidates: ['https://api.example.com/v1/'],
        source: { kind: 'file', origin: 'x.json', text: '' },
      }),
    ).toBe('https://api.example.com/v1');
  });

  it('joins a relative candidate to a URL source origin', () => {
    expect(
      resolveBaseUrl({
        candidates: ['/dyn-feature-68474/'],
        source: {
          kind: 'url',
          origin:
            'https://oneroster.example.com/dyn-feature-68474/swagger/v1/swagger.json',
          text: '',
        },
      }),
    ).toBe('https://oneroster.example.com/dyn-feature-68474');
  });

  it('returns a relative candidate verbatim for file sources', () => {
    expect(
      resolveBaseUrl({
        candidates: ['/dyn-feature-68474/'],
        source: { kind: 'file', origin: 'x.json', text: '' },
      }),
    ).toBe('/dyn-feature-68474');
  });

  it('falls back to "/" when no candidates are present', () => {
    expect(
      resolveBaseUrl({
        candidates: [],
        source: { kind: 'file', origin: 'x.json', text: '' },
      }),
    ).toBe('/');
  });

  it('uses the URL source origin verbatim when the candidate is "/"', () => {
    expect(
      resolveBaseUrl({
        candidates: ['/'],
        source: { kind: 'url', origin: 'https://h.example/swagger.json', text: '' },
      }),
    ).toBe('https://h.example');
  });

  it('handles candidates with no scheme but with a slash-relative path on file imports', () => {
    expect(
      resolveBaseUrl({
        candidates: ['/api'],
        source: { kind: 'file', origin: 'x.json', text: '' },
      }),
    ).toBe('/api');
  });
});
