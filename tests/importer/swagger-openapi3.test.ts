import { describe, it, expect } from 'vitest';
import { parseSpec } from '@importer/swagger';

const tiny = {
  openapi: '3.0.1',
  info: { title: 'Tiny', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/users': {
      get: {
        tags: ['Users'],
        operationId: 'listUsers',
        summary: 'List users',
        parameters: [
          { in: 'query', name: 'limit', required: false, schema: { type: 'integer' } },
        ],
      },
      post: {
        tags: ['Users'],
        operationId: 'createUser',
        requestBody: {
          content: {
            'application/json': { example: { name: 'Ada' } },
          },
        },
      },
    },
    '/users/{id}': {
      get: {
        tags: ['Users'],
        operationId: 'getUser',
        parameters: [
          { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
        ],
      },
    },
  },
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer' },
    },
  },
  security: [{ bearer: [] }],
};

describe('normalizeOpenApi3', () => {
  it('produces operations with method, path, tag, and parameters', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    expect(spec.operations).toHaveLength(3);
    const list = spec.operations.find((o) => o.operationId === 'listUsers')!;
    expect(list.method).toBe('GET');
    expect(list.path).toBe('/users');
    expect(list.tag).toBe('Users');
    expect(list.summary).toBe('List users');
    expect(list.parameters).toEqual([
      { in: 'query', name: 'limit', required: false },
    ]);
    expect(list.bodyExample).toBeNull();
  });

  it('captures requestBody example as the body', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    const create = spec.operations.find((o) => o.operationId === 'createUser')!;
    expect(create.bodyExample).toEqual({
      contentType: 'application/json',
      raw: JSON.stringify({ name: 'Ada' }, null, 2),
    });
  });

  it('normalizes security schemes and globalSecurity', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    expect(spec.securitySchemes.bearer).toEqual({ kind: 'httpBearer' });
    expect(spec.globalSecurity).toEqual([{ schemeName: 'bearer' }]);
  });

  it('emits servers[0].url as a baseUrl candidate', () => {
    const spec = parseSpec({ kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) });
    expect(spec.baseUrlCandidates).toEqual(['https://api.example.com/v1']);
  });

  it('falls back to filename when info.title is missing (file import)', () => {
    const spec = parseSpec({
      kind: 'file',
      origin: '/x/my-api.json',
      text: JSON.stringify({ openapi: '3.0.0', paths: {} }),
    });
    expect(spec.title).toBe('my-api');
  });

  it('parses a YAML document', () => {
    const yaml = `openapi: 3.0.0
info:
  title: YamlSpec
servers:
  - url: https://y.example
paths:
  /ping:
    get:
      tags: [Health]
      operationId: ping
`;
    const spec = parseSpec({ kind: 'file', origin: 'spec.yaml', text: yaml });
    expect(spec.title).toBe('YamlSpec');
    expect(spec.operations).toHaveLength(1);
    expect(spec.operations[0]!.path).toBe('/ping');
    expect(spec.operations[0]!.tag).toBe('Health');
  });

  it('rejects a document without an openapi or swagger discriminator', () => {
    expect(() =>
      parseSpec({ kind: 'file', origin: 'x.json', text: JSON.stringify({ foo: 'bar' }) }),
    ).toThrow(/SWAGGER_PARSE/);
  });
});
