import { describe, it, expect } from 'vitest';
import { parseSpec } from '@importer/swagger';

const tiny = {
  swagger: '2.0',
  info: { title: 'V2', version: '1.0' },
  host: 'api.example.com',
  basePath: '/v1',
  schemes: ['https'],
  paths: {
    '/widgets': {
      get: {
        tags: ['Widgets'],
        operationId: 'listWidgets',
        parameters: [{ in: 'query', name: 'q', required: false, type: 'string' }],
      },
      post: {
        tags: ['Widgets'],
        operationId: 'createWidget',
        parameters: [
          { in: 'body', name: 'body', required: true, schema: {}, 'x-example': { name: 'Widget' } },
        ],
      },
    },
  },
  securityDefinitions: {
    apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
  },
  security: [{ apiKey: [] }],
};

describe('normalizeSwagger2', () => {
  it('derives the base url from schemes/host/basePath', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    expect(spec.baseUrlCandidates).toEqual(['https://api.example.com/v1']);
  });

  it('emits operations with correct tag/path/method/parameters', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    expect(spec.operations).toHaveLength(2);
    const list = spec.operations.find((o) => o.operationId === 'listWidgets')!;
    expect(list.method).toBe('GET');
    expect(list.path).toBe('/widgets');
    expect(list.tag).toBe('Widgets');
    expect(list.parameters).toEqual([{ in: 'query', name: 'q', required: false }]);
  });

  it('captures x-example as the body for body params', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    const create = spec.operations.find((o) => o.operationId === 'createWidget')!;
    expect(create.bodyExample).toEqual({
      contentType: 'application/json',
      raw: JSON.stringify({ name: 'Widget' }, null, 2),
    });
  });

  it('translates securityDefinitions into the normalized shape', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    expect(spec.securitySchemes.apiKey).toEqual({
      kind: 'apiKey',
      in: 'header',
      name: 'X-Api-Key',
    });
    expect(spec.globalSecurity).toEqual([{ schemeName: 'apiKey' }]);
  });

  it('defaults scheme to https when schemes[] missing', () => {
    const spec = parseSpec({
      kind: 'file',
      origin: 'x.json',
      text: JSON.stringify({
        swagger: '2.0',
        info: { title: 'x' },
        host: 'h.example',
        basePath: '/v2',
        paths: {},
      }),
    });
    expect(spec.baseUrlCandidates).toEqual(['https://h.example/v2']);
  });

  it('translates basic auth to httpBasic', () => {
    const spec = parseSpec({
      kind: 'file',
      origin: 'x.json',
      text: JSON.stringify({
        swagger: '2.0',
        info: { title: 'x' },
        host: 'h.example',
        paths: {},
        securityDefinitions: { b: { type: 'basic' } },
      }),
    });
    expect(spec.securitySchemes.b).toEqual({ kind: 'httpBasic' });
  });
});
