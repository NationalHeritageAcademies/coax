import { describe, expect, it } from 'vitest';
import { parseEnvFile, serializeEnvFile, type EnvFile } from '@workspace-fs/env-file';

const VALID: EnvFile = {
  name: 'dev',
  vars: [
    { key: 'baseUrl', valuePlain: 'https://dev.example.com' },
    { key: 'token', isSecret: true, secretId: 'scholargateway-dev-token' },
  ],
};

describe('serializeEnvFile', () => {
  it('produces JSON with $schema field and trailing newline', () => {
    const out = serializeEnvFile(VALID);
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.$schema).toBe('https://raw.githubusercontent.com/NationalHeritageAcademies/coax/main/docs/schema/env.json');
    expect(parsed.name).toBe('dev');
    expect(parsed.vars).toHaveLength(2);
  });

  it('uses 2-space indentation for readable git diffs', () => {
    const out = serializeEnvFile({
      name: 'dev',
      vars: [{ key: 'x', valuePlain: 'y' }],
    });
    expect(out).toContain('  "name": "dev"');
    expect(out).toContain('  "vars":');
  });

  it('omits valuePlain on secret vars (keeps the JSON clean)', () => {
    const out = serializeEnvFile({
      name: 'dev',
      vars: [{ key: 'token', isSecret: true, secretId: 'tok-1' }],
    });
    expect(out).not.toContain('valuePlain');
    expect(out).toContain('"secretId": "tok-1"');
  });

  it('omits isSecret on plain vars (keeps the JSON clean)', () => {
    const out = serializeEnvFile({
      name: 'dev',
      vars: [{ key: 'x', valuePlain: 'y' }],
    });
    expect(out).not.toContain('isSecret');
  });
});

describe('parseEnvFile', () => {
  it('parses a valid env file', () => {
    const text = serializeEnvFile(VALID);
    const result = parseEnvFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(VALID);
    }
  });

  it('round-trips byte-identical text', () => {
    const text = serializeEnvFile(VALID);
    const result = parseEnvFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(serializeEnvFile(result.value)).toBe(text);
    }
  });

  it('returns invalid-json on garbage', () => {
    const result = parseEnvFile('{not valid');
    expect(result).toMatchObject({ ok: false, reason: 'invalid-json' });
  });

  it('returns invalid-shape when top-level is not an object', () => {
    expect(parseEnvFile('[]')).toMatchObject({ ok: false, reason: 'invalid-shape' });
    expect(parseEnvFile('"hello"')).toMatchObject({ ok: false, reason: 'invalid-shape' });
  });

  it('returns invalid-shape when name is missing or empty', () => {
    expect(parseEnvFile('{ "vars": [] }')).toMatchObject({ ok: false, reason: 'invalid-shape' });
    expect(parseEnvFile('{ "name": "", "vars": [] }')).toMatchObject({
      ok: false,
      reason: 'invalid-shape',
    });
  });

  it('returns invalid-shape when neither vars nor scopes is provided', () => {
    expect(parseEnvFile('{ "name": "dev" }')).toMatchObject({
      ok: false,
      reason: 'invalid-shape',
    });
  });

  it('returns invalid-shape when a secret var is missing secretId', () => {
    const text = JSON.stringify({
      name: 'dev',
      vars: [{ key: 'token', isSecret: true }],
    });
    expect(parseEnvFile(text)).toMatchObject({ ok: false, reason: 'invalid-shape' });
  });

  it('returns invalid-shape when a plain var is missing valuePlain', () => {
    const text = JSON.stringify({
      name: 'dev',
      vars: [{ key: 'baseUrl' }],
    });
    expect(parseEnvFile(text)).toMatchObject({ ok: false, reason: 'invalid-shape' });
  });

  it('handles an empty vars array (env defined but no values yet)', () => {
    const result = parseEnvFile('{ "name": "blank", "vars": [] }');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ name: 'blank', vars: [] });
  });

  it('tolerates unknown top-level fields (forward compatibility)', () => {
    const text = JSON.stringify({
      $schema: 'https://raw.githubusercontent.com/NationalHeritageAcademies/coax/main/docs/schema/env.json',
      name: 'dev',
      vars: [],
      futureField: { ignored: true },
    });
    const result = parseEnvFile(text);
    expect(result.ok).toBe(true);
  });

  it('drops the explicit isSecret: false from output of plain vars (canonical form)', () => {
    const text = JSON.stringify({
      name: 'dev',
      vars: [{ key: 'x', isSecret: false, valuePlain: 'y' }],
    });
    const result = parseEnvFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.vars[0]).toEqual({ key: 'x', valuePlain: 'y' });
    }
  });

  it('accepts the legacy scopes[] shape and merges vars across scopes', () => {
    const text = JSON.stringify({
      name: 'dev',
      scopes: [
        { folder: '/', vars: [{ key: 'baseUrl', valuePlain: 'https://dev' }] },
        { folder: '/sub', vars: [{ key: 'sub', valuePlain: 'x' }] },
      ],
    });
    const result = parseEnvFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Flattened; scope folder paths discarded under the directories model.
      expect(result.value.vars.map((v) => v.key).sort()).toEqual(['baseUrl', 'sub']);
    }
  });

  it('dedupes keys across legacy scopes (first-seen wins)', () => {
    const text = JSON.stringify({
      name: 'dev',
      scopes: [
        { folder: '/', vars: [{ key: 'x', valuePlain: 'outer' }] },
        { folder: '/sub', vars: [{ key: 'x', valuePlain: 'inner' }] },
      ],
    });
    const result = parseEnvFile(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.vars).toEqual([{ key: 'x', valuePlain: 'outer' }]);
    }
  });
});
