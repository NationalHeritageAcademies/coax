import { describe, it, expect } from 'vitest';
import { applyAuthForOperation } from '@importer/swagger';
import type {
  NormalizedSpec,
  NormalizedOperation,
} from '@importer/swagger-types';

function spec(part: Partial<NormalizedSpec>): NormalizedSpec {
  return {
    title: 'x',
    baseUrlCandidates: [],
    operations: [],
    securitySchemes: {},
    globalSecurity: [],
    ...part,
  };
}

const op = (over: Partial<NormalizedOperation> = {}): NormalizedOperation => ({
  method: 'GET',
  path: '/x',
  tag: null,
  operationId: null,
  summary: null,
  parameters: [],
  bodyExample: null,
  security: null,
  ...over,
});

describe('applyAuthForOperation', () => {
  it('httpBearer becomes a bearer auth + seeds bearerToken', () => {
    const r = applyAuthForOperation(
      spec({
        securitySchemes: { b: { kind: 'httpBearer' } },
        globalSecurity: [{ schemeName: 'b' }],
      }),
      op(),
      { headers: [], queryParams: [] },
    );
    expect(r.auth).toEqual({ kind: 'bearer', data: { token: '{{bearerToken}}' } });
    expect(r.envSeedKeys).toContain('bearerToken');
  });

  it('httpBasic becomes a basic auth + seeds username/password', () => {
    const r = applyAuthForOperation(
      spec({
        securitySchemes: { b: { kind: 'httpBasic' } },
        globalSecurity: [{ schemeName: 'b' }],
      }),
      op(),
      { headers: [], queryParams: [] },
    );
    expect(r.auth).toEqual({
      kind: 'basic',
      data: { username: '{{username}}', password: '{{password}}' },
    });
    expect(r.envSeedKeys).toEqual(expect.arrayContaining(['username', 'password']));
  });

  it('apiKey in header appends a templated header', () => {
    const r = applyAuthForOperation(
      spec({
        securitySchemes: { k: { kind: 'apiKey', in: 'header', name: 'X-Api-Key' } },
        globalSecurity: [{ schemeName: 'k' }],
      }),
      op(),
      { headers: [], queryParams: [] },
    );
    expect(r.auth).toBeUndefined();
    expect(r.headers).toContainEqual({ key: 'X-Api-Key', value: '{{X-Api-Key}}' });
    expect(r.envSeedKeys).toContain('X-Api-Key');
  });

  it('apiKey in query appends a templated query param', () => {
    const r = applyAuthForOperation(
      spec({
        securitySchemes: { k: { kind: 'apiKey', in: 'query', name: 'apiKey' } },
        globalSecurity: [{ schemeName: 'k' }],
      }),
      op(),
      { headers: [], queryParams: [] },
    );
    expect(r.queryParams).toContainEqual({ key: 'apiKey', value: '{{apiKey}}' });
  });

  it('apiKey in cookie becomes a Cookie header', () => {
    const r = applyAuthForOperation(
      spec({
        securitySchemes: { k: { kind: 'apiKey', in: 'cookie', name: 'session' } },
        globalSecurity: [{ schemeName: 'k' }],
      }),
      op(),
      { headers: [], queryParams: [] },
    );
    expect(r.headers).toContainEqual({ key: 'Cookie', value: 'session={{session}}' });
  });

  it('oauth2 leaves auth unset (user fills in by hand)', () => {
    const r = applyAuthForOperation(
      spec({
        securitySchemes: { o: { kind: 'oauth2' } },
        globalSecurity: [{ schemeName: 'o' }],
      }),
      op(),
      { headers: [], queryParams: [] },
    );
    expect(r.auth).toBeUndefined();
    expect(r.headers).toEqual([]);
    expect(r.queryParams).toEqual([]);
  });

  it('no security on op + no globalSecurity leaves everything unset', () => {
    const r = applyAuthForOperation(
      spec({ securitySchemes: { b: { kind: 'httpBearer' } } }), // globalSecurity empty
      op(),
      { headers: [], queryParams: [] },
    );
    expect(r.auth).toBeUndefined();
    expect(r.headers).toEqual([]);
    expect(r.envSeedKeys).toEqual([]);
  });

  it('per-op security overrides globalSecurity', () => {
    const r = applyAuthForOperation(
      spec({
        securitySchemes: {
          b: { kind: 'httpBearer' },
          k: { kind: 'apiKey', in: 'header', name: 'X-Tok' },
        },
        globalSecurity: [{ schemeName: 'b' }],
      }),
      op({ security: [{ schemeName: 'k' }] }),
      { headers: [], queryParams: [] },
    );
    expect(r.auth).toBeUndefined(); // apiKey wins
    expect(r.headers).toContainEqual({ key: 'X-Tok', value: '{{X-Tok}}' });
  });
});
