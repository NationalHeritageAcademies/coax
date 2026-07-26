import { describe, expect, it, beforeEach } from 'vitest';
import { configureScrubber, scrubEvent, scrubString } from '@telemetry/scrubber';
import type { Event } from '@sentry/electron';

describe('scrubString', () => {
  beforeEach(() => {
    configureScrubber({ workspaceRoot: '/Users/jdoe/Workspace/api', homeDir: '/Users/jdoe' });
  });

  it('strips http and https URLs', () => {
    expect(scrubString('Hit https://api.acme.com/users/42 and failed')).toBe(
      'Hit <url> and failed',
    );
    expect(scrubString('http://internal-gateway:8080/health')).toBe('<url>');
  });

  it('strips Bearer tokens', () => {
    expect(scrubString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def')).toBe(
      'Authorization: <redacted>',
    );
    expect(scrubString('Bearer SOMETOKEN1234 expired')).toBe('Bearer <token> expired');
  });

  it('strips Basic auth tokens', () => {
    expect(scrubString('use Basic dXNlcjpwYXNzd29yZA== for legacy')).toBe(
      'use Basic <token> for legacy',
    );
  });

  it('redacts whole Authorization headers regardless of payload', () => {
    expect(scrubString('Authorization: Token abc-xyz-123\nNext-Header: ok')).toMatch(
      /Authorization: <redacted>\s*\nNext-Header: ok/,
    );
  });

  it('strips workspace file paths', () => {
    expect(scrubString('Loaded /Users/jdoe/Workspace/api/oneroster.http')).toBe(
      'Loaded <workspace>/oneroster.http',
    );
  });

  it('strips configured home directory paths', () => {
    // The home dir is supplied via configureScrubber (see beforeEach), so
    // this is hermetic — no dependence on the running user's actual home.
    const out = scrubString('Stack at /Users/jdoe/.config/coax/db.sqlite');
    expect(out).not.toContain('/Users/jdoe');
    expect(out).toContain('<home>');
  });

  it('strips template variable references', () => {
    expect(scrubString('Missing {{accessToken}} in chain')).toBe('Missing {{var}} in chain');
    expect(scrubString('{{baseUrl}}/users/{{userId}}')).toBe('{{var}}/users/{{var}}');
  });

  it('strips http-verb-prefixed request lines', () => {
    expect(scrubString('GET /v1/users/42 HTTP/1.1')).toBe('<http-line>');
    expect(scrubString('POST https://api/foo and then GET /bar')).toBe('<http-line>');
  });

  it('passes through innocuous text', () => {
    expect(scrubString('Worker exited with code 137 (likely OOM)')).toBe(
      'Worker exited with code 137 (likely OOM)',
    );
  });

  it('returns the empty string unchanged', () => {
    expect(scrubString('')).toBe('');
  });
});

describe('scrubEvent', () => {
  beforeEach(() => {
    configureScrubber({ workspaceRoot: '/Users/jdoe/Workspace/api', homeDir: '/Users/jdoe' });
  });

  it('scrubs the event message', () => {
    const event: Event = { message: 'failed to POST https://api/foo' };
    // The verb appears mid-line, so http-line matching does NOT fire (anchored
    // to line-start); only the URL is scrubbed. This is the safer default —
    // we'd rather leave a noun-form "POST" intact than nuke legitimate prose.
    expect(scrubEvent(event)?.message).toBe('failed to POST <url>');
  });

  it('scrubs request lines when they sit at line start', () => {
    const event: Event = { message: 'attempted\nPOST /v1/users HTTP/1.1\n with body' };
    expect(scrubEvent(event)?.message).toBe('attempted\n<http-line>\n with body');
  });

  it('scrubs exception values and stack frames', () => {
    const event: Event = {
      exception: {
        values: [
          {
            type: 'NetworkError',
            value: 'request to https://billing/charge failed',
            stacktrace: {
              frames: [
                {
                  filename: '/Users/jdoe/Workspace/api/runner/host.ts',
                  abs_path: 'file:///Users/jdoe/Workspace/api/runner/host.ts',
                  context_line: 'await fetch("https://api/foo")',
                  pre_context: ['const token = "{{accessToken}}";'],
                  post_context: ['// no-op'],
                },
              ],
            },
          },
        ],
      },
    };
    const scrubbed = scrubEvent(event);
    const ex = scrubbed!.exception!.values![0]!;
    expect(ex.value).toBe('request to <url> failed');
    const frame = ex.stacktrace!.frames![0]!;
    expect(frame.filename).toBe('<workspace>/runner/host.ts');
    expect(frame.abs_path).toBe('file://<workspace>/runner/host.ts');
    expect(frame.context_line).toContain('<url>');
    expect(frame.pre_context![0]).toContain('{{var}}');
  });

  it('scrubs breadcrumb messages and data', () => {
    const event: Event = {
      breadcrumbs: [
        {
          message: 'POST https://api/auth',
          data: {
            url: 'https://api/auth',
            payload: 'Bearer abc',
            status: 401,
          },
        },
      ],
    };
    const scrubbed = scrubEvent(event);
    const crumb = scrubbed!.breadcrumbs![0]!;
    expect(crumb.message).toBe('<http-line>');
    expect((crumb.data as Record<string, unknown>).url).toBe('<url>');
    expect((crumb.data as Record<string, unknown>).payload).toBe('Bearer <token>');
    // Numbers pass through unchanged — not PII.
    expect((crumb.data as Record<string, unknown>).status).toBe(401);
  });

  it('drops request headers, cookies, and body entirely', () => {
    const event: Event = {
      request: {
        url: 'https://api/users',
        headers: { Authorization: 'Bearer xyz', 'X-Secret': 'sssh' },
        cookies: { session: 'abc' },
        data: { password: 'hunter2' },
      },
    };
    const scrubbed = scrubEvent(event);
    expect(scrubbed!.request!.url).toBe('<url>');
    expect(scrubbed!.request!.headers).toBeUndefined();
    expect(scrubbed!.request!.cookies).toBeUndefined();
    expect(scrubbed!.request!.data).toBe('<redacted>');
  });

  it('does not crash on empty events', () => {
    expect(scrubEvent({})).toEqual({});
  });
});
