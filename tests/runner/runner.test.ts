import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { startRunner, stopRunner, send, cancel } from '@runner/host';

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/echo') {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
    } else if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 200);
    } else if (req.url === '/empty') {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>(r => server.listen(0, () => { r(); }));
  port = (server.address() as { port: number }).port;
  await startRunner();
});

afterAll(async () => {
  await stopRunner();
  await new Promise<void>(r => server.close(() => { r(); }));
});

describe('runner — happy path', () => {
  it('returns 200 for GET', async () => {
    const r = await send({ id: '1', method: 'GET', url: `http://127.0.0.1:${port}/echo`, headers: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toContain('application/json');
      expect(r.ms).toBeGreaterThanOrEqual(0);
      expect(r.sizeBytes).toBe(r.bodyBytes.byteLength);
    }
  });

  it('sends body and headers on POST', async () => {
    const r = await send({
      id: '2', method: 'POST', url: `http://127.0.0.1:${port}/echo`,
      headers: { 'x-test': '1', 'content-type': 'application/json' },
      body: { kind: 'json', raw: '{"a":1}' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const body = JSON.parse(new TextDecoder().decode(r.bodyBytes)) as { method: string; body: string; headers: Record<string, string> };
      expect(body.method).toBe('POST');
      expect(body.body).toBe('{"a":1}');
      expect(body.headers['x-test']).toBe('1');
    }
  });

  it('returns 204 for empty body', async () => {
    const r = await send({ id: '3', method: 'GET', url: `http://127.0.0.1:${port}/empty`, headers: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe(204);
      expect(r.bodyBytes.byteLength).toBe(0);
    }
  });

  it('reports timeout', async () => {
    const r = await send({ id: '4', method: 'GET', url: `http://127.0.0.1:${port}/slow`, headers: {}, timeoutMs: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe('timeout');
  });

  it('reports network error for unreachable host', async () => {
    const r = await send({ id: '5', method: 'GET', url: 'http://127.0.0.1:1/nope', headers: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe('network');
  });

  it('reports invalid for malformed URL', async () => {
    const r = await send({ id: '6', method: 'GET', url: 'not a url', headers: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe('invalid');
  });
});

describe('runner — concurrency', () => {
  it('serves concurrent sends with no cross-contamination', async () => {
    const a = send({
      id: 'A', method: 'POST', url: `http://127.0.0.1:${port}/echo`,
      headers: { 'content-type': 'text/plain' },
      body: { kind: 'text', raw: 'A' },
    });
    const b = send({
      id: 'B', method: 'POST', url: `http://127.0.0.1:${port}/echo`,
      headers: { 'content-type': 'text/plain' },
      body: { kind: 'text', raw: 'B' },
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    if (ra.ok && rb.ok) {
      const aBody = JSON.parse(new TextDecoder().decode(ra.bodyBytes)) as { body: string };
      const bBody = JSON.parse(new TextDecoder().decode(rb.bodyBytes)) as { body: string };
      expect(aBody.body).toBe('A');
      expect(bBody.body).toBe('B');
    }
  });

  it('cancels an in-flight request', async () => {
    const p = send({
      id: 'C', method: 'GET', url: `http://127.0.0.1:${port}/slow`, headers: {},
    });
    // Cancel after a short delay so the request is genuinely in flight
    setTimeout(() => { cancel('C'); }, 20);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.category).toBe('aborted');
  });

  it('cancelling an unknown id is a no-op (does not throw)', () => {
    expect(() => { cancel('does-not-exist'); }).not.toThrow();
  });
});
