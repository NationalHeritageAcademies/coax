import { describe, it, expect } from 'vitest';
import { createDispatcher, type Handlers } from '@ipc/main-bridge';

describe('createDispatcher', () => {
  it('routes by kind and wraps result in success envelope', async () => {
    const handlers: Handlers = {
      'workspace:list': async () => [{ id: 'w1', name: 'one' }],
    };
    const d = createDispatcher(handlers);
    const r = await d({ kind: 'workspace:list' });
    expect(r).toEqual({ ok: true, data: [{ id: 'w1', name: 'one' }] });
  });

  it('passes the message itself to the handler', async () => {
    const handlers: Handlers = {
      'collection:rename': ({ id, name }) => ({ renamedId: id, to: name }),
    };
    const d = createDispatcher(handlers);
    const r = await d({ kind: 'collection:rename', id: 'c1', name: 'NewName' });
    expect(r).toEqual({ ok: true, data: { renamedId: 'c1', to: 'NewName' } });
  });

  it('returns typed error envelope when handler throws an Error', async () => {
    const handlers: Handlers = {
      'workspace:list': () => { throw new Error('NOT_FOUND'); },
    };
    const d = createDispatcher(handlers);
    expect(await d({ kind: 'workspace:list' })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'NOT_FOUND' },
    });
  });

  it('returns typed error envelope when handler throws non-Error', async () => {
    const handlers: Handlers = {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately throws a non-Error to exercise the dispatcher's fallback.
      'workspace:list': () => { throw 'string thrown'; },
    };
    const d = createDispatcher(handlers);
    const r = await d({ kind: 'workspace:list' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('UNKNOWN');
      expect(r.error.message).toContain('string thrown');
    }
  });

  it('returns UNKNOWN_KIND when no handler is registered for the kind', async () => {
    const d = createDispatcher({});
    const r = await d({ kind: 'workspace:list' });
    expect(r).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_KIND', message: 'No handler for workspace:list' },
    });
  });

  it('handles a synchronous handler return value', async () => {
    const handlers: Handlers = {
      'tabs:list': () => [{ id: 't1', requestId: 'r1' }],
    };
    const d = createDispatcher(handlers);
    const r = await d({ kind: 'tabs:list' });
    expect(r).toEqual({ ok: true, data: [{ id: 't1', requestId: 'r1' }] });
  });

  it('handles a promise rejection from an async handler', async () => {
    const handlers: Handlers = {
      'workspace:list': async () => { throw new Error('OOPS'); },
    };
    const d = createDispatcher(handlers);
    const r = await d({ kind: 'workspace:list' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OOPS');
  });

  it('preserves an error code distinct from message when error.message starts with CODE: ', async () => {
    // Convention: handlers can encode "CODE_FROM_ERROR_MESSAGE" by throwing
    // new Error('CODE: human-readable detail'). The dispatcher splits on ': ' to extract code.
    const handlers: Handlers = {
      'workspace:list': () => { throw new Error('NOT_FOUND: workspace 7 does not exist'); },
    };
    const d = createDispatcher(handlers);
    const r = await d({ kind: 'workspace:list' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('NOT_FOUND');
      expect(r.error.message).toBe('workspace 7 does not exist');
    }
  });
});
