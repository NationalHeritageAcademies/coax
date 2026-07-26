// Spike: prove the parser + resolver + runner can be wired together from a
// Node-only context to execute a .http file end-to-end, including chained
// response references. If this passes, the CLI MVP scope estimate holds.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { parseHttpFile } from '@parser/parse.js';
import { resolve as resolveTemplate } from '@resolver/resolve.js';
import { runOne } from '@runner/worker.js';
import type { ResolverContext } from '@resolver/types.js';
import type { RequestSpec, ResponseEnvelope } from '@runner/types.js';
import type { ParsedRequest } from '@parser/types.js';

let server: Server;
let baseUrl: string;
let receivedAuthHeader = '';

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ token: 'abc123', userId: 42, echo: JSON.parse(body) }));
      });
      return;
    }
    if (req.url === '/users/42' && req.method === 'GET') {
      receivedAuthHeader = req.headers.authorization ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 42, name: 'Rick' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => { done(); }));
});

describe('CLI engine-reuse spike', () => {
  it('parses, resolves, runs a chained .http file end-to-end', async () => {
    const httpFile = [
      `@baseUrl = ${baseUrl}`,
      '',
      '### Login',
      '# @name login',
      'POST {{baseUrl}}/login',
      'Content-Type: application/json',
      '',
      '{ "user": "rick" }',
      '',
      '### Get user',
      'GET {{baseUrl}}/users/{{login.response.body.$.userId}}',
      'Authorization: Bearer {{login.response.body.$.token}}',
      '',
    ].join('\n');

    const parsed = parseHttpFile(httpFile);
    expect(parsed.requests).toHaveLength(2);

    const collectionDefaults: Record<string, string> = {};
    for (const v of parsed.variables) collectionDefaults[v.name] = v.value;

    const responses: NonNullable<ResolverContext['responses']> = {};
    const results: { name: string; ok: boolean; status?: number }[] = [];

    for (const req of parsed.requests) {
      const spec = buildSpec(req, { scopes: { collectionDefaults }, responses });
      const result = await runOne(spec);
      results.push({
        name: req.name ?? req.title,
        ok: result.ok,
        ...(result.ok ? { status: result.status } : {}),
      });

      if (result.ok && req.name) {
        responses[req.name] = {
          status: result.status,
          headers: result.headers,
          body: parseJsonBody(result),
        };
      }
    }

    expect(results).toEqual([
      { name: 'login', ok: true, status: 200 },
      { name: 'Get user', ok: true, status: 200 },
    ]);
    expect(receivedAuthHeader).toBe('Bearer abc123');
    expect((responses.login!.body as { token: string }).token).toBe('abc123');
  });
});

function buildSpec(req: ParsedRequest, ctx: ResolverContext): RequestSpec {
  const url = resolveTemplate(req.url, ctx).text;
  const headers: Record<string, string> = {};
  for (const h of req.headers) headers[h.key] = resolveTemplate(h.value, ctx).text;

  const spec: RequestSpec = {
    id: req.id ?? `${req.method} ${req.url}`,
    method: req.method,
    url,
    headers,
  };
  if (req.body && req.body.kind !== 'none') {
    const raw = resolveTemplate(req.body.raw, ctx).text;
    spec.body = { kind: req.body.kind, raw };
  }
  return spec;
}

function parseJsonBody(r: ResponseEnvelope): unknown {
  const text = new TextDecoder().decode(r.bodyBytes);
  const ct = (r.headers['content-type'] ?? '').toLowerCase();
  if (ct.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
