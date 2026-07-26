import { describe, expect, it } from 'vitest';
import {
  collectionFileName,
  envFilePath,
  looksLikeEnvFile,
  parseEnvFileName,
  slug,
  workspaceCacheDbPath,
  workspaceCacheDir,
} from '@workspace-fs/paths';

describe('slug', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    expect(slug('Scholar API')).toBe('scholar-api');
    expect(slug('Hello, World!')).toBe('hello-world');
    expect(slug('  spaces   everywhere  ')).toBe('spaces-everywhere');
  });

  it('collapses consecutive separators into a single hyphen', () => {
    expect(slug('a---b___c   d')).toBe('a-b-c-d');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slug('---hello---')).toBe('hello');
  });

  it('falls back to "untitled" for empty / non-alphanumeric input', () => {
    expect(slug('')).toBe('untitled');
    expect(slug('!!!')).toBe('untitled');
    expect(slug('---')).toBe('untitled');
  });

  it('preserves digits', () => {
    expect(slug('Coax v1.0')).toBe('coax-v1-0');
  });
});

describe('collectionFileName', () => {
  it('appends .http to the slugged name', () => {
    expect(collectionFileName('ScholarGateway API')).toBe('scholargateway-api.http');
    expect(collectionFileName('Login')).toBe('login.http');
  });
});

describe('envFilePath', () => {
  it('builds the sibling .env.json path', () => {
    expect(envFilePath('/repo/scholargateway.http', 'dev')).toBe(
      '/repo/scholargateway.dev.env.json',
    );
  });

  it('preserves the .http path directory', () => {
    expect(envFilePath('/repo/tests/integration/login.http', 'staging')).toBe(
      '/repo/tests/integration/login.staging.env.json',
    );
  });

  it('slugs the env name', () => {
    expect(envFilePath('/repo/foo.http', 'My Production')).toBe(
      '/repo/foo.my-production.env.json',
    );
  });
});

describe('parseEnvFileName', () => {
  it('extracts the env name from a matching pair', () => {
    expect(parseEnvFileName('/r/scholargateway.dev.env.json', '/r/scholargateway.http')).toEqual({
      envName: 'dev',
    });
  });

  it('handles env names with hyphens after slugging', () => {
    expect(parseEnvFileName('/r/foo.my-staging.env.json', '/r/foo.http')).toEqual({
      envName: 'my-staging',
    });
  });

  it('returns null when the prefix does not match', () => {
    expect(parseEnvFileName('/r/other.dev.env.json', '/r/scholargateway.http')).toBeNull();
  });

  it('returns null when there is no env-name segment', () => {
    expect(parseEnvFileName('/r/scholargateway.env.json', '/r/scholargateway.http')).toBeNull();
  });

  it('returns null when the suffix is wrong', () => {
    expect(parseEnvFileName('/r/scholargateway.dev.json', '/r/scholargateway.http')).toBeNull();
  });
});

describe('looksLikeEnvFile', () => {
  it('matches *.env.json', () => {
    expect(looksLikeEnvFile('/r/foo.dev.env.json')).toBe(true);
    expect(looksLikeEnvFile('/r/scholargateway.staging.env.json')).toBe(true);
  });

  it('rejects other paths', () => {
    expect(looksLikeEnvFile('/r/foo.http')).toBe(false);
    expect(looksLikeEnvFile('/r/env.json')).toBe(false);
    expect(looksLikeEnvFile('/r/foo.json')).toBe(false);
    expect(looksLikeEnvFile('/r/foo.env.txt')).toBe(false);
  });
});

describe('workspaceCacheDir + workspaceCacheDbPath', () => {
  it('produces the same hash for the same path on subsequent calls', () => {
    const a = workspaceCacheDir('/userData', '/Users/rick/code/api');
    const b = workspaceCacheDir('/userData', '/Users/rick/code/api');
    expect(a).toBe(b);
  });

  it('produces different hashes for different paths', () => {
    const a = workspaceCacheDir('/userData', '/Users/rick/code/api');
    const b = workspaceCacheDir('/userData', '/Users/rick/code/other');
    expect(a).not.toBe(b);
  });

  it('places the cache under <userData>/workspaces/<16-char-hash>', () => {
    const dir = workspaceCacheDir('/userData', '/Users/rick/code/api');
    expect(dir).toMatch(/^\/userData\/workspaces\/[0-9a-f]{16}$/);
  });

  it('appends cache.sqlite for the DB path', () => {
    const db = workspaceCacheDbPath('/userData', '/Users/rick/code/api');
    expect(db).toMatch(/^\/userData\/workspaces\/[0-9a-f]{16}\/cache\.sqlite$/);
  });

  it('resolves relative workspace paths to absolute before hashing', () => {
    // Hashing the absolute form means `cd /Users/rick/code && coax open ./api`
    // and `coax open /Users/rick/code/api` land on the same cache dir.
    const a = workspaceCacheDir('/userData', '/Users/rick/code/api');
    // We can't easily construct a *relative* path the same as absolute
    // without cwd manipulation, but a path with redundant segments stands in
    // for the normalization invariant.
    const b = workspaceCacheDir('/userData', '/Users/rick/code/./api');
    expect(a).toBe(b);
  });
});
