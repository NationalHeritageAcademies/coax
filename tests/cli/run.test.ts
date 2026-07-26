import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { runFile } from '@cli/run.js';
import { createJUnitReporter } from '@cli/reporters/junit.js';
import { createPrettyReporter } from '@cli/reporters/pretty.js';
import { ExitCode } from '@cli/exit-codes.js';

let server: Server;
let baseUrl: string;
let workDir: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/login' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'abc123', userId: 42 }));
      return;
    }
    if (req.url === '/users/42' && req.method === 'GET') {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ')) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 42, email: 'rick@example.test' }));
      return;
    }
    if (req.url === '/broken' && req.method === 'GET') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'oops' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  workDir = await mkdtemp(join(tmpdir(), 'coax-cli-test-'));
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => { done(); }));
  await rm(workDir, { recursive: true, force: true });
});

class SinkStream extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join('');
  }
}

async function fixture(contents: string): Promise<string> {
  const path = join(workDir, `fixture-${Math.random().toString(36).slice(2)}.http`);
  await writeFile(path, contents, 'utf8');
  return path;
}

describe('coax run', () => {
  it('returns Ok when all requests + assertions pass', async () => {
    const file = await fixture(
      [
        `@baseUrl = ${baseUrl}`,
        '',
        '### Login',
        '# @name login',
        '# @test status == 200',
        '# @test $.token exists',
        'POST {{baseUrl}}/login',
        'Content-Type: application/json',
        '',
        '{}',
        '',
        '### Get user',
        '# @test status == 200',
        '# @test $.email == "rick@example.test"',
        'GET {{baseUrl}}/users/{{login.response.body.$.userId}}',
        'Authorization: Bearer {{login.response.body.$.token}}',
        '',
      ].join('\n'),
    );

    const sink = new SinkStream();
    const code = await runFile(file, {
      reporter: createPrettyReporter({ color: false, out: sink }),
      timeoutMs: 5000,
    });
    expect(code).toBe(ExitCode.Ok);
    expect(sink.text()).toContain('2 passed');
    expect(sink.text()).toContain('0 failed');
  });

  it('returns AssertionFailed when an assertion fails', async () => {
    const file = await fixture(
      [
        `@baseUrl = ${baseUrl}`,
        '',
        '### Broken expectation',
        '# @test status == 200',
        'GET {{baseUrl}}/broken',
        '',
      ].join('\n'),
    );
    const sink = new SinkStream();
    const code = await runFile(file, {
      reporter: createPrettyReporter({ color: false, out: sink }),
    });
    expect(code).toBe(ExitCode.AssertionFailed);
  });

  it('returns RequestFailed on network error', async () => {
    const file = await fixture(
      [
        '### Connection refused',
        'GET http://127.0.0.1:1/never-listens',
        '',
      ].join('\n'),
    );
    const sink = new SinkStream();
    const code = await runFile(file, {
      reporter: createPrettyReporter({ color: false, out: sink }),
      timeoutMs: 2000,
    });
    expect(code).toBe(ExitCode.RequestFailed);
  });

  it('JUnit reporter emits a single well-formed suite', async () => {
    const file = await fixture(
      [
        `@baseUrl = ${baseUrl}`,
        '',
        '### Healthy',
        '# @test status == 200',
        'POST {{baseUrl}}/login',
        '',
        '### Sick',
        '# @test status == 200',
        'GET {{baseUrl}}/broken',
        '',
      ].join('\n'),
    );
    const sink = new SinkStream();
    const code = await runFile(file, { reporter: createJUnitReporter({ out: sink }) });
    expect(code).toBe(ExitCode.AssertionFailed);
    const xml = sink.text();
    expect(xml).toMatch(/<\?xml version="1.0"/);
    expect(xml).toMatch(/<testsuite [^>]*tests="2"/);
    expect(xml).toMatch(/<testcase name="Healthy"/);
    expect(xml).toMatch(/<testcase name="Sick"/);
    expect(xml).toMatch(/<failure /);
  });

  it('requestFilter only runs matching requests', async () => {
    const file = await fixture(
      [
        `@baseUrl = ${baseUrl}`,
        '',
        '### Login',
        '# @test status == 200',
        'POST {{baseUrl}}/login',
        '',
        '### Broken expectation',
        '# @test status == 200',
        'GET {{baseUrl}}/broken',
        '',
      ].join('\n'),
    );
    const sink = new SinkStream();
    const code = await runFile(file, {
      reporter: createPrettyReporter({ color: false, out: sink }),
      requestFilter: 'Login',
    });
    expect(code).toBe(ExitCode.Ok);
    expect(sink.text()).toContain('1 passed');
  });

  it('envVars get resolved into requests', async () => {
    const file = await fixture(
      [
        '### Login',
        '# @test status == 200',
        'POST {{baseUrl}}/login',
        '',
      ].join('\n'),
    );
    const sink = new SinkStream();
    const code = await runFile(file, {
      reporter: createPrettyReporter({ color: false, out: sink }),
      envVars: { baseUrl },
    });
    expect(code).toBe(ExitCode.Ok);
  });

  it('varOverrides win over envVars and collection defaults', async () => {
    const file = await fixture(
      [
        '@baseUrl = http://wrong-host:1',
        '',
        '### Login',
        '# @test status == 200',
        'POST {{baseUrl}}/login',
        '',
      ].join('\n'),
    );
    const sink = new SinkStream();
    const code = await runFile(file, {
      reporter: createPrettyReporter({ color: false, out: sink }),
      envVars: { baseUrl: 'http://also-wrong:1' },
      varOverrides: { baseUrl },
    });
    expect(code).toBe(ExitCode.Ok);
  });

  it('varOverrides win over collection defaults', async () => {
    const file = await fixture(
      [
        `@baseUrl = http://wrong-host:1`,
        '',
        '### Login',
        '# @test status == 200',
        'POST {{baseUrl}}/login',
        '',
      ].join('\n'),
    );
    const sink = new SinkStream();
    const code = await runFile(file, {
      reporter: createPrettyReporter({ color: false, out: sink }),
      varOverrides: { baseUrl },
    });
    expect(code).toBe(ExitCode.Ok);
  });
});
