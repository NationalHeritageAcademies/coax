import { describe, it, expect } from 'vitest';
import { resolve } from '@resolver/resolve';

describe('resolve response chain', () => {
  const ctx = {
    scopes: {},
    responses: {
      getToken: { status: 200, headers: { 'content-type': 'application/json' }, body: { token: 'abc', user: { id: 7 } } },
    },
  };
  it('reads body fields via JSONPath', () => {
    expect(resolve('{{getToken.response.body.$.token}}', ctx).text).toBe('abc');
    expect(resolve('{{getToken.response.body.$.user.id}}', ctx).text).toBe('7');
  });
  it('reads headers', () => {
    expect(resolve('{{getToken.response.headers.content-type}}', ctx).text).toBe('application/json');
  });
  it('reports unresolved when name unknown', () => {
    expect(resolve('{{ghost.response.body.$.x}}', ctx).unresolved).toEqual(['ghost.response.body.$.x']);
  });
});
