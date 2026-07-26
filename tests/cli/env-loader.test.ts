import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnv } from '@cli/env-loader.js';

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'coax-envloader-'));
  await writeFile(
    join(workDir, 'dev.env.json'),
    JSON.stringify({
      name: 'dev',
      vars: [
        { key: 'baseUrl', valuePlain: 'https://dev.example.test' },
        { key: 'apiKey', isSecret: true, secretId: 'secret-1' },
      ],
    }),
  );
  await writeFile(
    join(workDir, 'prod.env.json'),
    JSON.stringify({
      name: 'prod',
      vars: [{ key: 'baseUrl', valuePlain: 'https://prod.example.test' }],
    }),
  );
  await writeFile(join(workDir, 'broken.env.json'), '{ this is not json }');
  await writeFile(join(workDir, 'api.http'), '### Stub\nGET {{baseUrl}}/\n');
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('CLI env loader', () => {
  it('loads plain vars from the matching env file by name', async () => {
    const result = await loadEnv(join(workDir, 'api.http'), 'prod', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.name).toBe('prod');
    expect(result.env.vars).toEqual({ baseUrl: 'https://prod.example.test' });
  });

  it('skips secrets without COAX_SECRET_<KEY> and warns', async () => {
    const result = await loadEnv(join(workDir, 'api.http'), 'dev', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.vars).toEqual({ baseUrl: 'https://dev.example.test' });
    expect(result.env.warnings.some((w) => w.includes('apiKey') && w.includes('COAX_SECRET_APIKEY'))).toBe(true);
  });

  it('resolves secrets from COAX_SECRET_<KEY> env vars', async () => {
    const result = await loadEnv(join(workDir, 'api.http'), 'dev', { COAX_SECRET_APIKEY: 'sk_test_123' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.vars).toEqual({
      baseUrl: 'https://dev.example.test',
      apiKey: 'sk_test_123',
    });
  });

  it('returns an error with available env names when the requested env is missing', async () => {
    const result = await loadEnv(join(workDir, 'api.http'), 'staging', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('staging');
    expect(result.error).toContain('available');
    expect(result.error).toContain('dev');
    expect(result.error).toContain('prod');
  });

  it('returns an error when no .env.json files exist in the directory', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'coax-envloader-empty-'));
    await writeFile(join(emptyDir, 'api.http'), '### Stub\nGET https://x/\n');
    const result = await loadEnv(join(emptyDir, 'api.http'), 'dev', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('no *.env.json files found');
    await rm(emptyDir, { recursive: true, force: true });
  });

  it('skips malformed .env.json files but still finds the valid one', async () => {
    const result = await loadEnv(join(workDir, 'api.http'), 'dev', { COAX_SECRET_APIKEY: 'x' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.warnings.some((w) => w.includes('broken.env.json'))).toBe(true);
  });
});
