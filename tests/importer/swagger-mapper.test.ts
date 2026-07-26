import { describe, it, expect } from 'vitest';
import { openDb, type Db } from '@storage/db';
import { Repos } from '@storage/repos';
import { importSpec } from '@importer/swagger';
import type { ImportSource } from '@importer/swagger-types';

const tiny = {
  openapi: '3.0.1',
  info: { title: 'Tiny' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/users': {
      get: {
        tags: ['Users'],
        operationId: 'listUsers',
        summary: 'List users',
        parameters: [{ in: 'query', name: 'Limit', required: true }],
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
        parameters: [{ in: 'path', name: 'id', required: true }],
      },
      delete: {
        tags: ['Users'],
        operationId: 'deleteUser',
        parameters: [{ in: 'path', name: 'id', required: true }],
      },
    },
    '/health': {
      get: { operationId: 'health' }, // no tag -> root
    },
  },
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
  },
  security: [{ bearer: [] }],
};

function seed(): { db: Db; workspaceId: string } {
  const db = openDb(':memory:');
  const ws = Repos.Workspaces.create(db, { name: 'w' });
  return { db, workspaceId: ws.id };
}

function source(): ImportSource {
  return { kind: 'file', origin: 'tiny.json', text: JSON.stringify(tiny) };
}

describe('importSpec', () => {
  it('creates a collection named info.title', () => {
    const { db, workspaceId } = seed();
    const r = importSpec(db, { workspaceId, source: source() });
    expect(Repos.Collections.get(db, r.collectionId)?.name).toBe('Tiny');
  });

  it('creates one folder per unique tag (untagged ops live at the root)', () => {
    const { db, workspaceId } = seed();
    const r = importSpec(db, { workspaceId, source: source() });
    const folders = Repos.Folders.listByCollection(db, r.collectionId)
      .filter((f) => f.parentFolderId !== null) // skip the collection root
      .map((f) => f.name);
    expect(folders).toEqual(['Users']);
  });

  it('creates one request per operation with templated URL and chainName', () => {
    const { db, workspaceId } = seed();
    const r = importSpec(db, { workspaceId, source: source() });
    expect(r.stats.operations).toBe(5);
    const reqs = Repos.Requests.listByCollection(db, r.collectionId);
    expect(reqs.length).toBe(5);
    const getUser = reqs.find((q) => q.chainName === 'getUser')!;
    expect(getUser.url).toBe('{{baseUrl}}/users/{{id}}');
    expect(getUser.method).toBe('GET');
    const list = reqs.find((q) => q.chainName === 'listUsers')!;
    expect(list.url).toBe('{{baseUrl}}/users?Limit={{Limit}}');
  });

  it('seeds the "From swagger" env with baseUrl', () => {
    const { db, workspaceId } = seed();
    const r = importSpec(db, { workspaceId, source: source() });
    const col = Repos.Collections.get(db, r.collectionId)!;
    const env = Repos.Envs.list(db, col.rootFolderId).find((e) => e.name === 'From swagger')!;
    expect(env).toBeDefined();
    const vars = Repos.Vars.listByEnv(db, env.id);
    const baseUrl = vars.find((v) => v.key === 'baseUrl')!;
    expect(baseUrl.valuePlain).toBe('https://api.example.com/v1');
  });

  it('seeds auth-related env keys (bearerToken) when security is declared', () => {
    const { db, workspaceId } = seed();
    const r = importSpec(db, { workspaceId, source: source() });
    const col = Repos.Collections.get(db, r.collectionId)!;
    const env = Repos.Envs.list(db, col.rootFolderId).find((e) => e.name === 'From swagger')!;
    const vars = Repos.Vars.listByEnv(db, env.id);
    expect(vars.find((v) => v.key === 'bearerToken')).toBeDefined();
  });

  it('attaches bearer auth to each request when global security applies', () => {
    const { db, workspaceId } = seed();
    const r = importSpec(db, { workspaceId, source: source() });
    const reqs = Repos.Requests.listByCollection(db, r.collectionId);
    for (const q of reqs) {
      expect(q.auth).toEqual({ kind: 'bearer', data: { token: '{{bearerToken}}' } });
    }
  });

  it('emits a body for POST when an example is present, none for GET', () => {
    const { db, workspaceId } = seed();
    const r = importSpec(db, { workspaceId, source: source() });
    const reqs = Repos.Requests.listByCollection(db, r.collectionId);
    const post = reqs.find((q) => q.chainName === 'createUser')!;
    expect(post.bodyKind).toBe('json');
    expect(post.bodyText).toContain('"name": "Ada"');
    const get = reqs.find((q) => q.chainName === 'listUsers')!;
    expect(get.bodyKind).toBe('none');
  });
});
